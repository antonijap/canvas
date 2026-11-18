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
//   call that changes it (open leases, the id counter and applied settlement ids are in it). Exposes `lease(request)` and `settle(settlement)` to rooms as one call
//   each, `countRequest` for every authenticated HTTP request and socket open (before routing),
//   and `report()` behind `answerUsage` on GET /v1/usage.
// - Room: one `RoomLeases` per room, with `ask` and `settle` calling the Team. `message()` for every
//   incoming socket message, `take` before its work (person messages and ops, rows written,
//   presence), `charge` for what already happened (awake time, rows read), `flush` before
//   hibernating or closing.

import {
  capsFor, dayOf, defaultCapConfig, durationUnits, freeFor, isDaily, isMonthly, isStored, levelFor, lineFor,
  loadState, periodEnd, periodOf, requestUnits, rollState, toWhole, worst, DAILY, HISTORY_DAYS, RESOURCES, UNITS,
  type CapConfig, type CloudflareUsage, type DayRecord, type Level, type MetricReport, type Priority, type Resource,
  type UsageState,
} from "./usage.ts";

/** Per person, per minute, across all rooms and sockets (plan 5; presence per decision 13.5). */
export const PERSON_LIMITS = { ops: 120, messages: 120, presence: 600 } as const;
/** What one person lease holds (plan 5: 30 ops, 30 messages or 60 presence messages). */
export const PERSON_LEASE = { ops: 30, messages: 30, presence: 60 } as const;
export type PersonWhat = keyof typeof PERSON_LIMITS;

/** A lease can be spent from for this long; unsettled after that, it stays charged in full until it settles. */
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

/** Work counted in one UTC day without a lease. */
export type DayCounts = { day: string; extra?: Partial<Record<Resource, number>>; messages?: number };
export type Settlement = {
  /** Unique per settlement: a retried settlement with the same id is applied once. */
  id?: string;
  /** Open leases being closed, with what was used of each (may exceed the lease: work counted after the fact). */
  leases?: { id: string; used: number }[];
  /** Work that happened without a lease, dated by the UTC day it happened on. */
  days?: DayCounts[];
  /** Work without a lease that happened now, for callers on the Team itself. */
  extra?: Partial<Record<Resource, number>>;
  /** Incoming socket messages counted in `requests` with `extra`, for the owner's raw counts. */
  messages?: number;
};

type CloudHeld = { kind: "cloud"; resource: Resource; units: number; period: string; expiresAt: number };
type PersonHeld = { kind: "person"; key: string; units: number; minute: number; expiresAt: number };
type Held = CloudHeld | PersonHeld;
/** An expired lease, already charged in full; settling it refunds what was not used. */
type Expired = CloudHeld & { charged: number };

/** What `save()` returns and the constructor takes back. */
export type UsageSaved = {
  v: 1;
  state: UsageState;
  seq: number;
  held: [string, Held][];
  expired: [string, Expired][];
  settled: [string, number][];
  people: [string, { minute: number; granted: number }][];
};

const minuteOf = (now: number) => Math.floor(now / 60_000) * 60_000;
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const KEEP_SETTLED_MS = 2 * 24 * 60 * 60_000;
const MAX_KEPT = 20_000;

function validHeld(v: unknown): v is Held {
  if (!v || typeof v !== "object") return false;
  const h = v as Record<string, unknown>;
  if (!isCount(h.units) || typeof h.expiresAt !== "number") return false;
  if (h.kind === "cloud") return (RESOURCES as readonly string[]).includes(h.resource as string) && typeof h.period === "string";
  return h.kind === "person" && typeof h.key === "string" && typeof h.minute === "number";
}
function entries<T>(value: unknown, ok: (v: unknown) => v is T): [string, T][] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is [string, T] => Array.isArray(e) && typeof e[0] === "string" && ok(e[1])).slice(-MAX_KEPT);
}

export class UsageTeam {
  readonly config: CapConfig;
  readonly caps: Record<Resource, number>;
  readonly free: Record<Resource, number>;
  private state: UsageState;
  private readonly held: Map<string, Held>;
  private readonly expired: Map<string, Expired>;
  /** Settlement id -> when it was applied. */
  private readonly settled: Map<string, number>;
  /** person:what -> granted this minute. */
  private readonly people: Map<string, { minute: number; granted: number }>;
  private seq: number;
  /** Random per instance, so a Team restored from an older save never hands out an id twice. */
  private readonly prefix = crypto.randomUUID().slice(0, 8);

  constructor(config: CapConfig = defaultCapConfig(), saved?: unknown, now = Date.now()) {
    this.config = config;
    this.caps = capsFor(config);
    this.free = freeFor(config);
    const s = saved && typeof saved === "object" && (saved as { v?: unknown }).v === 1 ? saved as Partial<UsageSaved> : undefined;
    this.state = loadState(s ? s.state : saved, now);
    this.held = new Map(entries(s?.held, validHeld));
    this.expired = new Map(entries(s?.expired, (v): v is Expired => validHeld(v) && v.kind === "cloud" && isCount((v as Expired).charged)));
    this.settled = new Map(entries(s?.settled, isCount));
    this.people = new Map(entries(s?.people, (v): v is { minute: number; granted: number } =>
      !!v && typeof v === "object" && typeof (v as { minute?: unknown }).minute === "number" && isCount((v as { granted?: unknown }).granted)));
    this.seq = isCount(s?.seq) ? Math.floor(s.seq) : 0;
    this.tick(now);
  }

  /** Everything to store after each call that changes it: counts, open leases, ids, applied settlements. */
  save(): UsageSaved {
    return structuredClone({
      v: 1 as const, state: this.state, seq: this.seq, held: [...this.held], expired: [...this.expired],
      settled: [...this.settled], people: [...this.people],
    });
  }

  lease(request: LeaseRequest, now = Date.now()): LeaseAnswer {
    this.tick(now);
    const units = Math.floor(request.units);
    if (!Number.isFinite(units) || units <= 0) return { ok: false, code: "quota", message: "Nothing to reserve", retryAt: now };
    return request.kind === "cloud" ? this.leaseCloud(request.resource, units, request.priority, now) : this.leasePerson(request.person, request.what, units, now);
  }

  settle(settlement: Settlement, now = Date.now()): void {
    this.tick(now);
    if (settlement.id !== undefined) {
      if (this.settled.has(settlement.id)) return;
      this.settled.set(settlement.id, now);
    }
    for (const { id, used } of settlement.leases ?? []) {
      const n = isCount(used) ? Math.floor(used) : 0;
      const held = this.held.get(id);
      const expired = this.expired.get(id);
      this.held.delete(id);
      this.expired.delete(id);
      if (held?.kind === "person") {
        const window = this.people.get(held.key);
        if (window && window.minute === held.minute) window.granted -= Math.max(0, held.units - n);
      } else if (held) this.count(held.resource, n, now, held.period);
      else if (expired) this.count(expired.resource, n - expired.charged, now, expired.period);
      // Unknown: already settled, or dropped after expiring and being charged in full.
    }
    for (const day of settlement.days ?? []) {
      const when = isDay(day.day) ? day.day : dayOf(now);
      for (const [resource, units] of Object.entries(day.extra ?? {})) {
        if ((RESOURCES as readonly string[]).includes(resource) && isCount(units)) {
          const r = resource as Resource;
          this.count(r, Math.floor(units), now, isDaily(r) ? when : isMonthly(r) ? when.slice(0, 7) : undefined);
        }
      }
      if (isCount(day.messages) && when === this.state.day) this.state.raw.messages += Math.floor(day.messages);
    }
    if (isCount(settlement.messages)) this.state.raw.messages += Math.floor(settlement.messages);
    for (const [resource, units] of Object.entries(settlement.extra ?? {})) {
      if ((RESOURCES as readonly string[]).includes(resource) && isCount(units)) this.count(resource as Resource, Math.floor(units), now);
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
    this.count(resource, -Math.max(0, Math.floor(bytes)), now);
  }

  /** Units held by open leases for a resource. */
  outstanding(resource: Resource): number {
    let sum = 0;
    for (const lease of this.held.values()) if (lease.kind === "cloud" && lease.resource === resource) sum += lease.units;
    return sum;
  }
  used(resource: Resource, now = Date.now()): number { this.tick(now); return this.state.used[resource]; }

  /** Worst brake over every resource, counting reserved work: `stop` at a cap, `red` from 80%, `amber` from 60%. */
  brake(now = Date.now()): Level {
    this.tick(now);
    return worst(RESOURCES.map(r => levelFor(this.state.used[r] + this.outstanding(r), this.caps[r])));
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
      const reserved = this.outstanding(r);
      metrics[r] = {
        used: toWhole(r, used), reserved: toWhole(r, reserved), cap: Math.floor(this.caps[r] / UNITS[r]),
        free: Math.floor(this.free[r] / UNITS[r]), level: levelFor(used + reserved, this.caps[r]),
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
    const lease: Lease = { id: `c-${this.prefix}-${++this.seq}`, units, expiresAt: Math.min(now + ttl, periodEnd(resource, now)) };
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
    const lease: Lease = { id: `p-${this.prefix}-${++this.seq}`, units: granted, expiresAt: minute + 60_000 };
    this.held.set(lease.id, { kind: "person", key, units: granted, minute, expiresAt: lease.expiresAt });
    return { ok: true, lease };
  }

  /** Adds (or with a negative count, refunds) units in the period they belong to. */
  private count(resource: Resource, units: number, now: number, period?: string): void {
    if (!units) return;
    const current = periodOf(resource, now);
    const add = (n: number) => Math.max(0, n + units);
    if (isStored(resource) || !period || period >= current) this.state.used[resource] = add(this.state.used[resource]);
    else if (isDaily(resource)) {
      // Work from a finished day lands in that day's history, not today's.
      let record = this.state.history.find(h => h.day === period);
      if (!record) {
        record = { day: period } as DayRecord;
        for (const r of DAILY) record[r] = 0;
        this.state.history = [...this.state.history, record].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, HISTORY_DAYS);
      }
      record[resource] = add(record[resource]);
    }
    // A finished month is not counted any more.
    this.state.updatedAt = now;
  }

  private tick(now: number): void {
    rollState(this.state, now);
    for (const [id, lease] of this.held) {
      if (lease.expiresAt > now) continue;
      this.held.delete(id);
      // An expired lease stays charged in full: the room may have spent it. Settling refunds the rest.
      if (lease.kind === "cloud") {
        this.count(lease.resource, lease.units, now, lease.period);
        this.expired.set(id, { ...lease, charged: lease.units });
      }
    }
    for (const id of this.expired.keys()) { if (this.expired.size <= MAX_KEPT) break; this.expired.delete(id); }
    for (const [id, at] of this.settled) { if (now - at <= KEEP_SETTLED_MS && this.settled.size <= MAX_KEPT) break; this.settled.delete(id); }
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
  /** Unleased work by the UTC day it happened on. */
  private days = new Map<string, { extra: Partial<Record<Resource, number>>; messages: number }>();
  /** A settlement sent but not yet confirmed: sent again, same id, until the Team takes it. */
  private pending: Settlement | undefined;
  private flushing: Promise<void> | undefined;
  private readonly id = crypto.randomUUID();
  private sent = 0;
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

  /** Counts work that already happened: from the open lease when it covers it, otherwise dated as extra. */
  charge(resource: Resource, units: number): void {
    if (units <= 0) return;
    const open = this.live(resource);
    if (open && open.lease.units - open.used >= units) { open.used += units; return; }
    const day = this.today();
    day.extra[resource] = (day.extra[resource] ?? 0) + units;
  }

  /** Every incoming socket message, accepted or refused: 1/20 of a request each. */
  message(count = 1): void {
    this.charge("requests", requestUnits({ messages: count }));
    this.today().messages += count;
  }

  /**
   * Settles every lease and extra count with the Team: before hibernating, on close, from an alarm.
   * If the Team cannot be reached the counts are kept and the next flush sends them again, under the
   * same settlement id, so the Team applies them once. Rejects when delivery failed.
   */
  flush(): Promise<void> {
    const run = (this.flushing ?? Promise.resolve()).catch(() => {}).then(() => this.deliver());
    this.flushing = run;
    return run.finally(() => { if (this.flushing === run) this.flushing = undefined; });
  }

  private async deliver(): Promise<void> {
    if (this.pending) {
      await this.send(this.pending);
      this.pending = undefined;
    }
    const leases = [...this.closed.splice(0)];
    for (const [key, open] of this.open) { leases.push({ id: open.lease.id, used: open.used }); this.open.delete(key); }
    const days: DayCounts[] = [...this.days].map(([day, counts]) => ({ day, extra: counts.extra, messages: counts.messages }));
    this.days = new Map();
    if (!leases.length && !days.length) return;
    this.pending = { id: `${this.id}-${++this.sent}`, leases, days };
    await this.send(this.pending);
    this.pending = undefined;
  }

  private today() {
    const day = dayOf(this.now());
    let counts = this.days.get(day);
    if (!counts) this.days.set(day, counts = { extra: {}, messages: 0 });
    return counts;
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
