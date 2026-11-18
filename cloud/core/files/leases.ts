// Person limits across rooms (Section 5): the Team grants each room a lease (a part of a person's per minute budget)
// and never grants a person more than the limit in a minute in total. A room spends its lease locally and asks again
// when it runs out: one Team call per lease, not per message.

import type { SqlStore } from "../sql.ts";

export type LeaseKind = "ops" | "messages" | "presence";
export const LEASE_LIMITS: Record<LeaseKind, number> = { ops: 120, messages: 120, presence: 600 };
export const LEASE_CHUNK: Record<LeaseKind, number> = { ops: 30, messages: 30, presence: 60 };

const minuteOf = (ms: number) => Math.floor(ms / 60_000);

/** The Team's side: what each person was granted this minute, in SQL so a restart does not hand out a minute twice. */
export class LeaseBank {
  private readonly store: SqlStore;
  private readonly limits: Record<LeaseKind, number>;
  constructor(store: SqlStore, limits: Record<LeaseKind, number> = LEASE_LIMITS) {
    this.store = store;
    this.limits = limits;
    store.sql.exec("CREATE TABLE IF NOT EXISTS leases (person TEXT NOT NULL, kind TEXT NOT NULL, minute INTEGER NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (person, kind, minute))");
  }
  /** Grant up to `want` of the person's budget for the minute of `now`; 0 when it is spent. */
  grant(person: string, kind: LeaseKind, want: number, now: number): number {
    const minute = minuteOf(now);
    return this.store.transactionSync(() => {
      this.store.sql.exec("DELETE FROM leases WHERE minute < ?", minute - 1);
      const used = this.store.sql.exec<{ used: number }>("SELECT used FROM leases WHERE person = ? AND kind = ? AND minute = ?", person, kind, minute).toArray()[0]?.used ?? 0;
      const n = Math.max(0, Math.min(want, this.limits[kind] - used));
      if (n > 0) this.store.sql.exec("INSERT INTO leases (person, kind, minute, used) VALUES (?, ?, ?, ?) ON CONFLICT(person, kind, minute) DO UPDATE SET used = used + excluded.used", person, kind, minute, n);
      return n;
    });
  }
  granted(person: string, kind: LeaseKind, now: number): number {
    return this.store.sql.exec<{ used: number }>("SELECT used FROM leases WHERE person = ? AND kind = ? AND minute = ?", person, kind, minuteOf(now)).toArray()[0]?.used ?? 0;
  }
}

/** A room's side: the leases it holds, spent one action at a time. */
export class RoomLeases {
  private readonly held = new Map<string, { minute: number; left: number; spent: boolean }>();
  private readonly bank: Pick<LeaseBank, "grant">;
  private readonly now: () => number;
  /** Team calls made, to show that a lease covers many messages. */
  calls = 0;
  constructor(bank: Pick<LeaseBank, "grant">, now: () => number = Date.now) {
    this.bank = bank;
    this.now = now;
  }
  /** Spend `n` of the person's budget; false (nothing spent) when the Team has no more for this minute. */
  take(person: string, kind: LeaseKind, n: number): boolean {
    const t = this.now();
    const key = `${kind}:${person}`;
    let h = this.held.get(key);
    if (!h || h.minute !== minuteOf(t)) h = { minute: minuteOf(t), left: 0, spent: false };
    // A minute the Team said is spent stays spent: no further calls until the next one.
    if (h.left < n && !h.spent) {
      this.calls++;
      const got = this.bank.grant(person, kind, Math.max(n - h.left, LEASE_CHUNK[kind]), t);
      h.left += got;
      if (h.left < n) h.spent = true;
    }
    this.held.set(key, h);
    if (h.left < n) return false;
    h.left -= n;
    return true;
  }
}
