import { applyStandaloneTimer, timerExpired, applyOp, canonicalMentions, checkEnvelope, isVoteOp, isUuid, LIMITS, mayApply } from "../protocol.ts";
import type { Applied, Author, OpEnvelope, Rejected, Role, StandaloneTimer, Thread, TimerOp, Vote, VoteDesign, VoteOp } from "../protocol.ts";
import { forgetAnonymousBallots, projectVotes, voteTotals, readVoteTopology, updateRoomVote, voteDesignForTopology, type StoredVote, type VoteTopology } from "./votes.ts";
import { initializeRoom } from "./room-schema.ts";
import type { SqlStore } from "./sql.ts";

/** Who sends ops. `id` only on a Cloud hosted on a Mac (its person id; the email there is a label). */
export interface Identity { email: string; name: string; id?: string }

interface OpRow {
  seq: number; op_id: string; by_email: string; by_name: string; by_id?: string | null; at: string; op_json: string;
}
export interface OpResult {
  acks: { opId: string; seq: number }[];
  rejected: Rejected[];
  entries: Applied[];
}
const DOCUMENT_BYTES = 20 * 1024 * 1024;
const HISTORY_OPS = 10_000;
const SOCIAL_MARKER = { kind: "vote.changed" } as const;
const SOCIAL_MARKER_JSON = JSON.stringify(SOCIAL_MARKER);
const size = (text: string) => new TextEncoder().encode(text).byteLength;
export class Operations {
  private readonly storage: SqlStore;
  constructor(storage: SqlStore, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
    initializeRoom(storage);
    if (this.legacyKey()) storage.transactionSync(() => {
      for (const row of this.voteRows()) {
        const vote = JSON.parse(row.json) as StoredVote;
        if (!vote.anonymous || vote.state === "active" || vote.anonymousKey) continue;
        forgetAnonymousBallots(vote);
        if (vote.conclusion) vote.conclusion.by = "";
        storage.sql.exec("UPDATE room_votes SET json = ? WHERE id = ?", JSON.stringify(vote), vote.id);
      }
      this.dropLegacyKey();
    });
  }
  private readonly now: () => number;
  onVotesExpired?: (entries: Applied[]) => void;
  sequence(): number {
    return this.storage.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM ops").one().seq;
  }
  snapshot(): { threads: Thread[]; seq: number } {
    this.expireDueVotes();
    return {
      threads: this.storage.sql.exec<{ json: string }>("SELECT json FROM threads ORDER BY id").toArray().map(row => JSON.parse(row.json) as Thread),
      seq: this.sequence(),
    };
  }
  read(since: number) {
    this.expireDueVotes();
    const seq = this.sequence();
    const entries = since > 0 && since <= seq ? this.replay(since) : null;
    return entries === null ? this.snapshot() : { seq, entries };
  }
  replay(since: number): Applied[] | null {
    const first = this.storage.sql.exec<{ seq: number }>("SELECT COALESCE(MIN(seq), 0) AS seq FROM ops").one().seq;
    if (since < first - 1) return null;
    return this.storage.sql.exec<OpRow & Record<string, string | number>>("SELECT * FROM ops WHERE seq > ? ORDER BY seq", since).toArray().map(row => ({
      seq: row.seq, opId: row.op_id, by: { email: row.by_email, name: row.by_name, ...(row.by_id ? { id: String(row.by_id) } : {}) }, at: row.at, op: JSON.parse(row.op_json),
    }));
  }
  setVoteDesign(input: unknown): boolean {
    const design = readVoteTopology(input);
    if (!design) return false;
    const json = JSON.stringify(design);
    if (size(json) > 1024 * 1024) return false;
    const id = (input as { vote?: unknown }).vote;
    const sql = this.storage.sql;
    if (id === undefined) sql.exec("INSERT OR REPLACE INTO room_vote_design VALUES (1, ?)", json);
    else {
      if (!isUuid(id)) return false;
      sql.exec("INSERT OR REPLACE INTO vote_designs VALUES (?, ?)", id, json);
      // An editor can publish before starting a vote. Bound these unpublished-to-a-vote designs too.
      sql.exec(`DELETE FROM vote_designs WHERE id IN (
        SELECT id FROM vote_designs WHERE id NOT IN (SELECT id FROM room_votes WHERE json_extract(json,'$.state') = 'active')
        ORDER BY rowid DESC LIMIT -1 OFFSET ?)`, LIMITS.openVotesPerDoc);
    }
    return true;
  }
  private voteDesign(id: string): VoteDesign | undefined {
    const sql = this.storage.sql;
    const row = sql.exec<{ json: string }>("SELECT json FROM vote_designs WHERE id = ?", id).toArray()[0] ??
      sql.exec<{ json: string }>("SELECT json FROM room_vote_design WHERE id = 1").toArray()[0];
    return row && voteDesignForTopology(JSON.parse(row.json) as VoteTopology);
  }
  private legacyKey(): string | undefined {
    return this.storage.sql.exec<{ key: string }>("SELECT key FROM room_vote_key WHERE id = 1").toArray()[0]?.key;
  }
  private dropLegacyKey() {
    this.storage.sql.exec(`DELETE FROM room_vote_key WHERE NOT EXISTS (SELECT 1 FROM room_votes WHERE
      json_extract(json,'$.state') = 'active' AND json_extract(json,'$.anonymous') = 1 AND json_extract(json,'$.anonymousKey') IS NULL)`);
  }
  private voteRows() {
    return this.storage.sql.exec<{ id: string; json: string }>("SELECT id, json FROM room_votes ORDER BY rowid").toArray();
  }
  voteView(me: Author, expire = true) {
    if (expire) this.expireDueVotes();
    return projectVotes(this.voteRows().map(row => JSON.parse(row.json) as StoredVote), this.legacyKey(), me);
  }
  private standaloneTimer(): StandaloneTimer | null {
    const row = this.storage.sql.exec<{ json: string }>("SELECT json FROM room_timer WHERE id = 1").toArray()[0];
    return row ? JSON.parse(row.json) : null;
  }
  socialView(me: Author) {
    return { votes: this.voteView(me, false), timer: this.standaloneTimer() };
  }
  endedVoteTotals() {
    return this.voteRows().map(row => JSON.parse(row.json) as Vote)
      .filter(vote => vote.state === "ended" || vote.clearedTotals)
      .map(vote => ({ id: vote.id, scope: vote.scope, anonymous: vote.anonymous,
        totals: (vote.clearedTotals ?? voteTotals(vote)).map(({ layer, count }) => ({ layer, count })) }));
  }
  privateVoting(): boolean {
    return !!this.storage.sql.exec(`SELECT 1 FROM room_votes WHERE json_extract(json, '$.state') = 'active'
      AND (json_extract(json, '$.hidden') = 1 OR json_extract(json, '$.anonymous') = 1) LIMIT 1`).toArray().length;
  }
  nextVoteExpiry(): number | undefined {
    const { at } = this.storage.sql.exec<{ at: string | null }>(`SELECT MIN(json_extract(json, '$.timer.endsAt')) AS at
      FROM room_votes WHERE json_extract(json, '$.state') = 'active' AND json_extract(json, '$.timer.pausedAt') IS NULL`).one();
    const timer = this.standaloneTimer();
    const next = Math.min(at ? Date.parse(at) : Infinity,
      timer?.endsAt && !timer.endedAt && !timer.pausedAt ? Date.parse(timer.endsAt) : Infinity);
    return Number.isFinite(next) ? next : undefined;
  }
  expireDueVotes() {
    const entries: Applied[] = [];
    this.storage.transactionSync(() => this.expireVotes(new Date(this.now()).toISOString(), entries));
    if (entries.length) this.onVotesExpired?.(entries);
  }
  private applyRoomVote(op: VoteOp, opId: string, me: Identity, at: string, design: VoteDesign, result: OpResult) {
    const rows = this.voteRows();
    const votes = rows.map(row => JSON.parse(row.json) as StoredVote);
    const previous = votes.find(v => v.id === op.vote);
    const newKey = !previous && op.kind === "vote.start" && op.anonymous
      ? Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("") : undefined;
    const conflict = updateRoomVote(votes, previous?.anonymousKey ?? newKey ?? this.legacyKey(), op, opId, me, at, design);
    if (conflict) { result.rejected.push({ opId, code: "conflict", message: conflict }); return; }
    const next = votes.find(v => v.id === op.vote)!;
    if (newKey) next.anonymousKey = newKey;
    const prior = rows.find(row => row.id === op.vote);
    const evicted = rows.length >= LIMITS.votesPerDoc && !prior ? rows.find(row => !votes.some(v => v.id === row.id)) : undefined;
    const entry = this.writeVoteChange(next, opId, at, prior?.json, evicted?.id);
    if (!entry) {
      result.rejected.push({ opId, code: "conflict", message: "Document storage quota exceeded" });
      return;
    }
    if (op.kind === "vote.start") this.storage.sql.exec(
      "INSERT OR IGNORE INTO vote_designs SELECT ?, json FROM room_vote_design WHERE id = 1", next.id);
    if (next.state !== "active") this.finishVote(next.id);
    result.acks.push({ opId, seq: entry.seq });
    result.entries.push(entry);
  }
  private writeVoteChange(vote: Vote, opId: string, at: string, previous?: string, evicted?: string, expire = false): Applied | undefined {
    const sql = this.storage.sql, persisted = JSON.stringify(vote);
    const usage = sql.exec<{ bytes: number }>("SELECT bytes FROM room_usage WHERE id = 1").one().bytes;
    if (!expire && usage + size(persisted) - (previous ? size(previous) : 0) + size(SOCIAL_MARKER_JSON) + size(opId) + 8 > DOCUMENT_BYTES) return;
    if (evicted) sql.exec("DELETE FROM room_votes WHERE id = ?", evicted);
    sql.exec("INSERT INTO room_votes (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json", vote.id, persisted);
    return this.writeSocialMarker(opId, at);
  }
  private writeSocialMarker(opId: string, at: string): Applied {
    const sql = this.storage.sql;
    const seq = sql.exec<{ seq: number }>("INSERT INTO ops (op_id, by_email, by_name, at, op_json) VALUES (?, '', '', ?, ?) RETURNING seq", opId, at, SOCIAL_MARKER_JSON).one().seq;
    sql.exec("DELETE FROM ops WHERE seq < ?", seq - HISTORY_OPS + 1);
    return { seq, opId, by: { name: "", email: "" }, at, op: SOCIAL_MARKER };
  }
  private writeTimer(timer: StandaloneTimer | null, opId: string, at: string) {
    const sql = this.storage.sql;
    if (timer) sql.exec("INSERT INTO room_timer VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json", JSON.stringify(timer));
    else sql.exec("DELETE FROM room_timer WHERE id = 1");
    return this.writeSocialMarker(opId, at);
  }
  private applyRoomTimer(op: TimerOp, opId: string, at: string, result: OpResult) {
    const previous = this.standaloneTimer();
    const next = applyStandaloneTimer(previous, op, at);
    if (typeof next === "string") { result.rejected.push({ opId, code: "conflict", message: next }); return; }
    const usage = this.storage.sql.exec<{ bytes: number }>("SELECT bytes FROM room_usage WHERE id = 1").one().bytes;
    const added = (next ? size(JSON.stringify(next)) : 0) - (previous ? size(JSON.stringify(previous)) : 0);
    if (next && usage + added + size(SOCIAL_MARKER_JSON) + size(opId) + 8 > DOCUMENT_BYTES) {
      result.rejected.push({ opId, code: "quota", message: "Document storage quota exceeded" });
      return;
    }
    const entry = this.writeTimer(next, opId, at);
    result.acks.push({ opId, seq: entry.seq });
    result.entries.push(entry);
  }
  private finishVote(id: string) {
    this.storage.sql.exec("DELETE FROM vote_designs WHERE id = ?", id);
    this.dropLegacyKey();
  }
  private expireVotes(at: string, entries: Applied[]) {
    const timer = this.standaloneTimer();
    if (timer && !timer.endedAt && timerExpired(timer, at))
      entries.push(this.writeTimer({ ...timer, endedAt: at }, crypto.randomUUID(), at));
    const rows = this.storage.sql.exec<{ json: string }>("SELECT json FROM room_votes WHERE json_extract(json, '$.state') = 'active' AND json_extract(json, '$.timer.pausedAt') IS NULL AND json_extract(json, '$.timer.endsAt') <= ?", at).toArray();
    for (const row of rows) {
      const vote = JSON.parse(row.json) as StoredVote;
      vote.state = "ended";
      vote.timedOut = true;
      forgetAnonymousBallots(vote);
      const entry = this.writeVoteChange(vote, crypto.randomUUID(), at, row.json, undefined, true);
      this.finishVote(vote.id);
      if (entry) entries.push(entry);
    }
  }
  submit(doc: string, values: unknown[], me: Identity, role: Role | null, allowance: number = LIMITS.opsPerMinutePerUser, members: readonly Author[] = [], voteDesign?: VoteDesign | true): OpResult {
    const result: OpResult = { acks: [], rejected: [], entries: [] };
    const at = new Date(this.now()).toISOString();
    if (role) this.storage.transactionSync(() => this.expireVotes(at, result.entries));
    for (const [index, value] of values.entries()) {
      const rawId = value && typeof value === "object" && "opId" in value ? value.opId : "";
      const opId = typeof rawId === "string" ? rawId : "";
      const reject = (code: Rejected["code"], message: string) => result.rejected.push({ opId, code, message });
      if (index >= allowance) { reject("quota", "Too many ops in one minute"); continue; }
      if (!role) { reject("forbidden", "Permission removed"); continue; }
      const invalid = checkEnvelope(value);
      if (invalid) { reject("invalid", invalid); continue; }
      const envelope = value as OpEnvelope;
      if (envelope.doc !== doc) { reject("invalid", "Document does not match the room"); continue; }
      this.storage.transactionSync(() => {
        const sql = this.storage.sql;
        const op = canonicalMentions(envelope.op, members);
        if (isVoteOp(op)) {
          if (!mayApply(op, role, me, [])) { reject("forbidden", "This role cannot apply the op"); return; }
          if (!voteDesign) { reject("version", "Voting is unavailable on this connection. Update Canvas."); return; }
          const receipt = sql.exec<{ seq: number }>("SELECT seq FROM op_receipts WHERE op_id = ?", opId).toArray()[0];
          if (receipt) { result.acks.push({ opId, seq: receipt.seq }); return; }
          if (op.kind === "timer.set" && op.standalone) { this.applyRoomTimer(op, opId, at, result); return; }
          const design = voteDesign === true ? this.voteDesign(op.vote) : voteDesign;
          if (!design && (op.kind === "vote.start" || op.kind === "vote.cast")) { reject("conflict", "An editor must publish the vote design first"); return; }
          this.applyRoomVote(op, opId, me, at, design ?? { page: () => false, node: () => undefined }, result);
          return;
        }
        const commentThread = "comment" in op ? sql.exec<{ thread_id: string }>("SELECT thread_id FROM comment_threads WHERE comment_id = ?", op.comment).toArray()[0]?.thread_id : undefined;
        const threadId = "thread" in op ? op.thread : commentThread;
        const row = threadId ? sql.exec<{ json: string }>("SELECT json FROM threads WHERE id = ?", threadId).toArray()[0] : undefined;
        const threads: Thread[] = row ? [JSON.parse(row.json) as Thread] : [];
        if (!mayApply(op, role, me, threads)) { reject("forbidden", "This role cannot apply the op"); return; }
        const prior = sql.exec<{ seq: number }>("SELECT seq FROM op_receipts WHERE op_id = ?", opId).toArray()[0];
        if (prior) { result.acks.push({ opId, seq: prior.seq }); return; }
        if (op.kind === "thread.create" && sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM threads").one().count >= LIMITS.threadsPerDoc) {
          reject("quota", "Document has too many threads"); return;
        }
        if ((op.kind === "thread.create" || op.kind === "comment.add") && commentThread) { reject("conflict", "comment exists"); return; }
        const conflict = applyOp(threads, doc, op, me, at);
        if (conflict) { reject("conflict", conflict); return; }
        const changed = threads[0];
        if (!changed) throw new Error("Applied op did not identify a thread");
        const json = JSON.stringify(changed), opJson = JSON.stringify(op);
        const usage = sql.exec<{ bytes: number }>("SELECT bytes FROM room_usage WHERE id = 1").one().bytes;
        if (usage + size(json) - (row ? size(row.json) : 0) + size(opJson) + size(opId) + 8 > DOCUMENT_BYTES) { reject("quota", "Document storage quota exceeded"); return; }
        sql.exec("INSERT INTO threads (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json", changed.id, json);
        if (op.kind === "thread.create" || op.kind === "comment.add") sql.exec("INSERT INTO comment_threads (comment_id, thread_id) VALUES (?, ?)", op.comment, changed.id);
        // by_id exists only in a hosted Cloud's rooms (cloud/adapters/mac/host.ts adds it); a Worker never sets an id.
        const seq = (me.id
          ? sql.exec<{ seq: number }>("INSERT INTO ops (op_id, by_email, by_name, by_id, at, op_json) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq", opId, me.email, me.name, me.id, at, opJson)
          : sql.exec<{ seq: number }>("INSERT INTO ops (op_id, by_email, by_name, at, op_json) VALUES (?, ?, ?, ?, ?) RETURNING seq", opId, me.email, me.name, at, opJson)
        ).one().seq;
        sql.exec("DELETE FROM ops WHERE seq < ?", seq - HISTORY_OPS + 1);
        result.acks.push({ opId, seq });
        result.entries.push({ seq, opId, by: me, at, op });
      });
    }
    return result;
  }
}
