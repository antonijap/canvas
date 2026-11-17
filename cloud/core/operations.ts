import { applyOp, checkEnvelope, LIMITS, mayApply } from "../protocol.ts";
import type { Applied, OpEnvelope, Rejected, Role, Thread } from "../protocol.ts";
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
const size = (text: string) => new TextEncoder().encode(text).byteLength;
export class Operations {
  private readonly storage: SqlStore;
  constructor(storage: SqlStore) { this.storage = storage; initializeRoom(storage); }
  sequence(): number {
    return this.storage.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM ops").one().seq;
  }
  snapshot(): { threads: Thread[]; seq: number } {
    return {
      threads: this.storage.sql.exec<{ json: string }>("SELECT json FROM threads ORDER BY id").toArray().map(row => JSON.parse(row.json) as Thread),
      seq: this.sequence(),
    };
  }
  read(since: number) {
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
  submit(doc: string, values: unknown[], me: Identity, role: Role | null, allowance: number = LIMITS.opsPerMinutePerUser): OpResult {
    const result: OpResult = { acks: [], rejected: [], entries: [] };
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
        const op = envelope.op;
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
        const at = new Date().toISOString();
        const conflict = applyOp(threads, doc, op, me, at);
        if (conflict) { reject("conflict", conflict); return; }
        const changed = threads[0];
        if (!changed) throw new Error("Applied op did not identify a thread");
        const json = JSON.stringify(changed), opJson = JSON.stringify(op);
        const usage = sql.exec<{ bytes: number }>("SELECT bytes FROM room_usage WHERE id = 1").one().bytes;
        if (usage + size(json) - (row ? size(row.json) : 0) + size(opJson) + size(opId) + 8 > DOCUMENT_BYTES) { reject("quota", "Document storage quota exceeded"); return; }
        sql.exec("INSERT INTO threads (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json", changed.id, json);
        if (op.kind === "thread.create" || op.kind === "comment.add") sql.exec("INSERT INTO comment_threads (comment_id, thread_id) VALUES (?, ?)", op.comment, changed.id);
        // by_id exists only in a hosted Cloud's rooms (cloud/node/host.ts adds it); a Worker never sets an id.
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
