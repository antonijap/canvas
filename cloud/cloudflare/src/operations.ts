import { applyOp, checkEnvelope, LIMITS, mayApply } from "../../protocol";
import type { Applied, OpEnvelope, Rejected, Role, Thread } from "../../protocol";
import type { Identity } from "./auth";

interface OpRow {
  seq: number; op_id: string; by_email: string; by_name: string; at: string; op_json: string;
}
export interface OpResult {
  acks: { opId: string; seq: number }[];
  rejected: Rejected[];
  entries: Applied[];
}
export class Operations {
  private readonly rates = new Map<string, { start: number; count: number }>();
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS ops (
      seq INTEGER PRIMARY KEY, op_id TEXT UNIQUE NOT NULL, by_email TEXT NOT NULL,
      by_name TEXT NOT NULL, at TEXT NOT NULL, op_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  }
  snapshot(): { threads: Thread[]; seq: number } {
    return {
      threads: this.storage.sql.exec<{ json: string }>("SELECT json FROM threads ORDER BY id").toArray().map(row => JSON.parse(row.json) as Thread),
      seq: this.storage.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM ops").one().seq,
    };
  }
  replay(since: number): Applied[] | null {
    const first = this.storage.sql.exec<{ seq: number }>("SELECT COALESCE(MIN(seq), 0) AS seq FROM ops").one().seq;
    if (since < first - 1) return null;
    return this.storage.sql.exec<OpRow & Record<string, string | number>>("SELECT * FROM ops WHERE seq > ? ORDER BY seq", since).toArray().map(row => ({
      seq: row.seq, opId: row.op_id, by: { email: row.by_email, name: row.by_name }, at: row.at, op: JSON.parse(row.op_json),
    }));
  }
  private available(email: string): boolean {
    const now = Date.now();
    // Expire inactive people as well as the current person's window.
    for (const [key, value] of this.rates) if (now - value.start >= 60_000) this.rates.delete(key);
    const rate = this.rates.get(email) ?? { start: now, count: 0 };
    this.rates.set(email, rate);
    if (rate.count >= LIMITS.opsPerMinutePerUser) return false;
    rate.count++;
    return true;
  }
  submit(doc: string, values: unknown[], me: Identity, role: Role): OpResult {
    const result: OpResult = { acks: [], rejected: [], entries: [] };
    for (const value of values) {
      const rawId = value && typeof value === "object" && "opId" in value ? value.opId : "";
      const opId = typeof rawId === "string" ? rawId : "";
      const reject = (code: Rejected["code"], message: string) => result.rejected.push({ opId, code, message });
      const invalid = checkEnvelope(value);
      if (invalid) { reject("invalid", invalid); continue; }
      const envelope = value as OpEnvelope;
      if (envelope.doc !== doc) { reject("invalid", "Document does not match the room"); continue; }
      this.storage.transactionSync(() => {
        const { threads } = this.snapshot();
        if (!mayApply(envelope.op, role, me, threads)) { reject("forbidden", "This role cannot apply the op"); return; }
        const prior = this.storage.sql.exec<{ seq: number }>("SELECT seq FROM ops WHERE op_id = ?", opId).toArray()[0];
        if (prior) { result.acks.push({ opId, seq: prior.seq }); return; }
        if (!this.available(me.email)) { reject("quota", "Too many ops in one minute"); return; }
        if (envelope.op.kind === "thread.create" && threads.length >= LIMITS.threadsPerDoc) { reject("quota", "Document has too many threads"); return; }
        // Initial comments need the same global id check as replies to prevent false ownership.
        const op = envelope.op;
        if (op.kind === "thread.create" && threads.some(t => t.comments.some(c => c.id === op.comment))) {
          reject("conflict", "comment exists"); return;
        }
        const at = new Date().toISOString();
        const conflict = applyOp(threads, doc, envelope.op, me, at);
        if (conflict) { reject("conflict", conflict); return; }
        const changed = "thread" in op ? threads.find(t => t.id === op.thread) : threads.find(t => t.comments.some(c => c.id === op.comment));
        if (!changed) throw new Error("Applied op did not identify a thread");
        this.storage.sql.exec("INSERT INTO threads (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json", changed.id, JSON.stringify(changed));
        const seq = this.storage.sql.exec<{ seq: number }>(
          "INSERT INTO ops (op_id, by_email, by_name, at, op_json) VALUES (?, ?, ?, ?, ?) RETURNING seq",
          opId, me.email, me.name, at, JSON.stringify(op),
        ).one().seq;
        result.acks.push({ opId, seq });
        result.entries.push({ seq, opId, by: me, at, op });
      });
    }
    return result;
  }
}
