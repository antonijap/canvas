// Version history (Section 3, decision 7): every snapshot of the last 24 hours, the last of each hour for 7 days, the
// last of each day for 30 days, and pinned ones ("Save version"). The newest done snapshot and any snapshot still
// building are always kept. Everything kept counts toward storage.

import type { SqlStore } from "../sql.ts";

export const VERSION_DAYS = 30;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type VersionRow = { seq: number; at: number; pinned: boolean; state: "done" | "building" };

/** The seqs to keep at `now`. */
export function keptVersions(rows: readonly VersionRow[], now: number): Set<number> {
  const keep = new Set<number>();
  const done = rows.filter((r) => r.state === "done").sort((a, b) => b.seq - a.seq);
  if (done[0]) keep.add(done[0].seq);
  const hours = new Set<number>(), days = new Set<number>();
  for (const r of done) {
    const age = now - r.at;
    if (r.pinned) keep.add(r.seq);
    else if (age < DAY) keep.add(r.seq);
    else if (age < 7 * DAY) {
      const h = Math.floor(r.at / HOUR);
      if (!hours.has(h)) keep.add(r.seq);
      hours.add(h);
    } else if (age < VERSION_DAYS * DAY) {
      const d = Math.floor(r.at / DAY);
      if (!days.has(d)) keep.add(r.seq);
      days.add(d);
    }
  }
  for (const r of rows) if (r.state === "building") keep.add(r.seq);
  return keep;
}

export type Version = { seq: number; at: string; by: string | null; label: string | null; pinned: boolean; bytes: number };

/** The versions a file shows, newest first (GET /v1/files/:id/versions). */
export function listVersions(store: SqlStore, now: number): Version[] {
  type R = { seq: number; at_ms: number; by_id: string | null; label: string | null; pinned: number; bytes: number; state: string };
  const rows = store.sql.exec<R>("SELECT seq, at_ms, by_id, label, pinned, bytes, state FROM snapshots ORDER BY seq DESC").toArray();
  const keep = keptVersions(rows.map((r) => ({ seq: r.seq, at: r.at_ms, pinned: !!r.pinned, state: r.state as VersionRow["state"] })), now);
  return rows.filter((r) => r.state === "done" && keep.has(r.seq)).map((r) => ({ seq: r.seq, at: new Date(r.at_ms).toISOString(), by: r.by_id, label: r.label, pinned: !!r.pinned, bytes: r.bytes }));
}
