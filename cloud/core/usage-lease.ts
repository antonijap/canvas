// Budget leases: work is reserved before it runs (plan 5, 5b, review findings 24 and 25).
//
// The Team holds one `UsageTeam`: the Cloud's caps (already this Cloud's share of the account's free
// limits) and every person's per minute limits across all rooms. A room never asks per message: it
// holds a lease (a number of units valid until the period ends or the lease times out), spends from
// it, asks for the next one when it runs out and settles what it used. The Team grants a lease only
// while used + outstanding + request stays under the line for the work's priority, so the most a
// Cloud can pass its cap by is work it counted after the fact (arrived requests, awake time).
//
// Integration (not wired here):
// - Team (Cloudflare Team Durable Object, Mac CloudHost team): one `UsageTeam`, built from
//   `parseCapConfig(env.USAGE_CAPS)` (Mac: no caps, see `macUsage`), saved with `save()` after each
//   call that changes it. Exposes `lease(request)` and `settle(settlement)` to rooms as one call
//   each, `countRequest` for every authenticated HTTP request and socket open (before routing),
//   and `report()` behind `answerUsage` on GET /v1/usage.
// - Room: one `RoomLeases` per room, with `ask` and `settle` calling the Team. `message()` for every
//   incoming socket message, `take` before its work (person messages and ops, rows written,
//   presence), `charge` for what already happened (awake time, rows read), `flush` before
//   hibernating or closing.

import {
  capsFor, defaultCapConfig, durationUnits, freeFor, freshState, isDaily, isMonthly, isStored, levelFor,
  lineFor, loadState, periodEnd, periodOf, requestUnits, rollState, toWhole, worst, RESOURCES, UNITS,
  type CapConfig, type CloudflareUsage, type Level, type MetricReport, type Priority, type Resource, type UsageState,
} from "./usage.ts";

/** Per person, per minute, across all rooms and sockets (plan 5; presence per decision 13.5). */
export const PERSON_LIMITS = { ops: 120, messages: 120, presence: 600 } as const;
/** What one person lease holds (plan 5: 30 ops, 30 messages or 60 presence messages). */
export const PERSON_LEASE = { ops: 30, messages: 30, presence: 60 } as const;
export type PersonWhat = keyof typeof PERSON_LIMITS;

/** A lease nobody settled stops holding budget after this long. */
export const LEASE_TTL_MS = 10 * 60_000;
/** Upload reservations live longer: a 500 MB multipart upload can take a while. */
export const STORED_LEASE_TTL_MS = 6 * 60 * 60_000;

/** What a room asks for in one go, in internal units, unless it needs more. */
export const CHUNK: Record<Resource, number> = {
  requests: 50 * UNITS.requests,          // 1,000 incoming messages
  durationGbS: durationUnits(5 * 60_000), // five awake minutes
  rowsWritten: 2_000,
  rowsRead: 20_000,
  blobClassA: 100,
  blobClassB: 1_000,
  storageBytes: 1_000_000,
  blobBytes: 0,                           // uploads reserve exactly their size
};

export type LeaseRequest =
  | { kind: "cloud"; resource: Resource; units: number; priority: Priority }
  | { kind: "person"; person: string; what: PersonWhat; units: number };
export type Lease = { id: string; units: number; expiresAt: number };
export type LeaseAnswer =
  | { ok: true; lease: Lease }
  | { ok: false; code: "quota"; message: string; retryAt: number };
export type Settlement = {
  /** Open leases being closed, with what was used of each (may exceed the lease: work counted after the fact). */
  leases?: { id: string; used: number }[];
  /** Work that happened without a lease, by resource, in internal units. */
  extra?: Partial<Record<Resource, number>>;
  /** Incoming socket messages counted in `requests` above, for the owner's raw counts. */
  messages?: number;
};

type Held =
  | { kind: "cloud"; resource: Resource; units: number; period: string; expiresAt: number }
  | { kind: "person"; key: string; units: number; minute: number; expiresAt: number };

const minuteOf = (now: number) => Math.floor(now / 60_000) * 60_000;

export class UsageTeam {
  readonly config: CapConfig;
  readonly caps: Record<Resource, number>;
  readonly free: Record<Resource, number>;
  private state: UsageState;
  private readonly held = new Map<string, Held>();
  private readonly expired = new Map<string, Held>();
  /** person:what -> granted this minute. */
  private readonly people = new Map<string, { minute: number; granted: number }>();
  private seq = 0;

  constructor(config: CapConfig = defaultCapConfig(), saved?: unknown, now = Date.now()) {
    this.config = config;
    this.caps = capsFor(config);
    this.free = freeFor(config);
    this.state = loadState(saved, now);
  }

  /** The state to store; open leases are not kept across a restart (they expire anyway). */
  save(): UsageState { return structuredClone(this.state); }

  lease(request: LeaseRequest, now = Date.now()): LeaseAnswer {
    this.tick(now);
    const units = Math.floor(request.units);
    if (!Number.isFinite(units) || units <= 0) return { ok: false, code: "quota", message: "Nothing to reserve", retryAt: now };
    return request.kind === "cloud" ? this.leaseCloud(request.resource, units, request.priority, now) : this.leasePerson(request.person, request.what, units, now);
  }

  settle(settlement: Settlement, now = Date.now()): void {
    this.tick(now);
    for (const { id, used } of settlement.leases ?? []) {
      const lease = this.held.get(id) ?? this.expired.get(id);
      this.held.delete(id);
      this.expired.delete(id);
      const n = Math.max(0, Math.floor(used));
      if (!lease) continue; // unknown, or expired before this Team restarted
      if (lease.kind === "person") {
        const window = this.people.get(lease.key);
        if (window && window.minute === lease.minute) window.granted -= Math.max(0, lease.units - n);
        continue;
      }
      this.count(lease.resource, n, now, lease.period);
    }
    if (typeof settlement.messages === "number" && settlement.messages > 0) this.state.raw.messages += Math.floor(settlement.messages);
    for (const [resource, units] of Object.entries(settlement.extra ?? {})) {
      if ((RESOURCES as readonly string[]).includes(resource) && typeof units === "number" && units > 0) this.count(resource as Resource, Math.floor(units), now);
    }
  }

  /** Every authenticated HTTP request or socket open, and every incoming message a room counted, refused ones too. */
  countRequest(count: { http?: number; messages?: number }, now = Date.now()): void {
    this.tick(now);
    this.count("requests", requestUnits(count), now);
    this.state.raw.http += count.http ?? 0;
    this.state.raw.messages += count.messages ?? 0;
  }

  /** Stored bytes going away (a file, version or blob deleted). */
  release(resource: "storageBytes" | "blobBytes", bytes: number, now = Date.now()): void {
    this.tick(now);
    this.state.used[resource] = Math.max(0, this.state.used[resource] - Math.max(0, Math.floor(bytes)));
  }

  /** Units held by open leases for a resource. */
  outstanding(resource: Resource): number {
    let sum = 0;
    for (const lease of this.held.values()) if (lease.kind === "cloud" && lease.resource === resource) sum += lease.units;
    return sum;
  }
  used(resource: Resource, now = Date.now()): number { this.tick(now); return this.state.used[resource]; }

  /** Worst brake over every resource: `stop` once any cap is reached, `red` from 80%, `amber` from 60%. */
  brake(now = Date.now()): Level {
    this.tick(now);
    return worst(RESOURCES.map(r => levelFor(this.state.used[r], this.caps[r])));
  }

  /** Whether work of this priority may start now on a resource, without reserving (presence, snapshots). */
  allows(resource: Resource, priority: Priority, now = Date.now()): boolean {
    this.tick(now);
    return this.state.used[resource] + this.outstanding(resource) < lineFor(priority, this.caps[resource]);
  }

  report(now = Date.now()): CloudflareUsage {
    this.tick(now);
    const metrics = {} as Record<Resource, MetricReport>;
    for (const r of RESOURCES) {
      const used = this.state.used[r];
      metrics[r] = {
        used: toWhole(r, used), reserved: toWhole(r, this.outstanding(r)), cap: Math.floor(this.caps[r] / UNITS[r]),
        free: Math.floor(this.free[r] / UNITS[r]), level: levelFor(used, this.caps[r]),
        ...(r === "durationGbS" ? { estimated: true as const } : {}),
      };
    }
    return {
      adapter: "cloudflare", day: this.state.day, month: this.state.month,
      percent: this.config.percent, share: this.config.share, metrics,
      counts: { ...this.state.raw }, brake: worst(Object.values(metrics).map(m => m.level)),
      days: structuredClone(this.state.history), updatedAt: new Date(this.state.updatedAt).toISOString(),
    };
  }

  private leaseCloud(resource: Resource, units: number, priority: Priority, now: number): LeaseAnswer {
    const line = lineFor(priority, this.caps[resource]);
    if (this.state.used[resource] + this.outstanding(resource) + units > line) {
      const retryAt = isStored(resource) ? now + 60_000 : periodEnd(resource, now);
      return { ok: false, code: "quota", message: `Usage limit reached for ${resource}`, retryAt };
    }
    const ttl = isStored(resource) ? STORED_LEASE_TTL_MS : LEASE_TTL_MS;
    const lease: Lease = { id: `c${++this.seq}`, units, expiresAt: Math.min(now + ttl, periodEnd(resource, now)) };
    this.held.set(lease.id, { kind: "cloud", resource, units, period: periodOf(resource, now), expiresAt: lease.expiresAt });
    return { ok: true, lease };
  }

  private leasePerson(person: string, what: PersonWhat, units: number, now: number): LeaseAnswer {
    const minute = minuteOf(now);
    const key = `${person}\n${what}`;
    let window = this.people.get(key);
    if (!window || window.minute !== minute) this.people.set(key, window = { minute, granted: 0 });
    const granted = Math.min(units, PERSON_LIMITS[what] - window.granted);
    if (granted <= 0) return { ok: false, code: "quota", message: "Too many in one minute", retryAt: minute + 60_000 };
    window.granted += granted;
    const lease: Lease = { id: `p${++this.seq}`, units: granted, expiresAt: minute + 60_000 };
    this.held.set(lease.id, { kind: "person", key, units: granted, minute, expiresAt: lease.expiresAt });
    return { ok: true, lease };
  }

  private count(resource: Resource, units: number, now: number, period?: string): void {
    if (units <= 0) return;
    const current = periodOf(resource, now);
    if (!period || period === current) this.state.used[resource] += units;
    else if (isDaily(resource)) {
      // A lease from a finished day settles into that day's history, not today's.
      const record = this.state.history.find(h => h.day === period);
      if (record) record[resource] += units;
    } else if (!isMonthly(resource)) this.state.used[resource] += units;
    this.state.updatedAt = now;
  }

  private tick(now: number): void {
    rollState(this.state, now);
    for (const [id, lease] of this.held) {
      if (lease.expiresAt > now) continue;
      // An expired lease holds no budget, but what was used of it still counts when it settles.
      this.held.delete(id);
      if (lease.kind === "cloud") this.expired.set(id, lease);
    }
    for (const id of this.expired.keys()) {
      if (this.expired.size <= 10_000) break;
      this.expired.delete(id);
    }
    if (this.people.size > 10_000) {
      const minute = minuteOf(now);
      for (const [key, window] of this.people) if (window.minute !== minute) this.people.delete(key);
    }
  }
}

export type LeaseKey = Resource | `person:${PersonWhat}:${string}`;
export const personKey = (person: string, what: PersonWhat): LeaseKey => `person:${what}:${person}`;

type Open = { lease: Lease; used: number };

/**
 * A room's side. `ask` and `settle` reach the Team (a Durable Object call on Cloudflare, a direct
 * call on the Mac). One ask per key is in flight at a time; concurrent takers wait for it.
 */
export class RoomLeases {
  private readonly open = new Map<LeaseKey, Open>();
  private readonly asking = new Map<LeaseKey, Promise<void>>();
  private readonly closed: { id: string; used: number }[] = [];
  private extra: Partial<Record<Resource, number>> = {};
  private messages = 0;
  private readonly ask: (request: LeaseRequest) => Promise<LeaseAnswer>;
  private readonly send: (settlement: Settlement) => Promise<void> | void;
  private readonly now: () => number;
  private readonly priority: (resource: Resource) => Priority;

  constructor(options: {
    ask: (request: LeaseRequest) => Promise<LeaseAnswer>;
    settle: (settlement: Settlement) => Promise<void> | void;
    now?: () => number;
    priority?: (resource: Resource) => Priority;
  }) {
    this.ask = options.ask;
    this.send = options.settle;
    this.now = options.now ?? Date.now;
    this.priority = options.priority ?? (() => "work");
  }

  /** Reserves before work: true when `units` are held for this work, false when the Team refused. */
  async take(key: LeaseKey, units: number): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const open = this.live(key);
      if (open && open.lease.units - open.used >= units) {
        open.used += units;
        return true;
      }
      const pending = this.asking.get(key);
      if (pending) { await pending; continue; }
      let ok = false;
      const request = this.requestFor(key, Math.max(units, this.chunk(key)));
      const asked = this.ask(request).then(answer => {
        if (!answer.ok) return;
        const previous = this.open.get(key);
        if (previous) this.closed.push({ id: previous.lease.id, used: previous.used });
        this.open.set(key, { lease: answer.lease, used: 0 });
        ok = true;
      }).finally(() => this.asking.delete(key));
      this.asking.set(key, asked);
      await asked;
      if (!ok) {
        // A person lease can come back smaller than asked for; a whole refusal ends it.
        const held = this.live(key);
        if (!held || held.lease.units - held.used < units) return false;
      }
    }
    return false;
  }

  /** Counts work that already happened: from the open lease when it covers it, otherwise as extra. */
  charge(resource: Resource, units: number): void {
    if (units <= 0) return;
    const open = this.live(resource);
    if (open && open.lease.units - open.used >= units) { open.used += units; return; }
    this.extra[resource] = (this.extra[resource] ?? 0) + units;
  }

  /** Every incoming socket message, accepted or refused: 1/20 of a request each. */
  message(count = 1): void {
    this.charge("requests", requestUnits({ messages: count }));
    this.messages += count;
  }

  /** Settles every lease and extra count with the Team: before hibernating, on close, from an alarm. */
  async flush(): Promise<void> {
    const leases = [...this.closed.splice(0)];
    for (const [key, open] of this.open) { leases.push({ id: open.lease.id, used: open.used }); this.open.delete(key); }
    const extra = this.extra;
    const messages = this.messages;
    this.extra = {};
    this.messages = 0;
    if (!leases.length && !Object.keys(extra).length && !messages) return;
    await this.send({ leases, extra, messages });
  }

  private live(key: LeaseKey): Open | undefined {
    const open = this.open.get(key);
    if (open && open.lease.expiresAt <= this.now()) {
      this.closed.push({ id: open.lease.id, used: open.used });
      this.open.delete(key);
      return undefined;
    }
    return open;
  }

  private chunk(key: LeaseKey): number {
    if (key.startsWith("person:")) return PERSON_LEASE[key.split(":")[1] as PersonWhat];
    return CHUNK[key as Resource];
  }

  private requestFor(key: LeaseKey, units: number): LeaseRequest {
    if (key.startsWith("person:")) {
      const [, what, ...rest] = key.split(":");
      return { kind: "person", person: rest.join(":"), what: what as PersonWhat, units };
    }
    return { kind: "cloud", resource: key as Resource, units, priority: this.priority(key as Resource) };
  }
}

