// Usage metering for a Cloud: what it counts, the caps it keeps, the brakes it applies and the
// owner's GET /v1/usage answer. Pure and adapter neutral: adapters store `UsageBudget.save()` and
// call in at the points listed in usage-lease.ts. Leases (work reserved before it runs) live in
// usage-lease.ts, the Home widget's reading in usage-widget.ts.

/** Daily resources reset at 00:00 UTC, monthly ones on the 1st, stored ones are gauges. */
export const DAILY = ["requests", "durationGbS", "rowsWritten", "rowsRead"] as const;
export const MONTHLY = ["blobClassA", "blobClassB"] as const;
export const STORED = ["storageBytes", "blobBytes"] as const;
export type Daily = typeof DAILY[number];
export type Monthly = typeof MONTHLY[number];
export type Stored = typeof STORED[number];
export type Resource = Daily | Monthly | Stored;
export const RESOURCES: readonly Resource[] = [...DAILY, ...MONTHLY, ...STORED];

/**
 * Internal integer units. A request is 20 units so an incoming WebSocket message (1/20 of a request
 * on Cloudflare) is one unit; duration is kept in thousandths of a GB-s. Everything else is 1.
 */
export const UNITS: Record<Resource, number> = {
  requests: 20, durationGbS: 1000, rowsWritten: 1, rowsRead: 1,
  blobClassA: 1, blobClassB: 1, storageBytes: 1, blobBytes: 1,
};
export const MESSAGES_PER_REQUEST = 20;
const GB = 1_000_000_000;

/** Cloudflare's free plan, per account, in whole requests, GB-s, rows, operations and bytes. */
export const FREE: Record<Resource, number> = {
  requests: 100_000,        // Durable Object requests a day; incoming WebSocket messages count 20:1
  durationGbS: 13_000,      // Durable Object duration a day
  rowsWritten: 100_000,     // SQLite rows written a day
  rowsRead: 5_000_000,      // SQLite rows read a day
  blobClassA: 1_000_000,    // R2 class A operations a month
  blobClassB: 10_000_000,   // R2 class B operations a month
  storageBytes: 5 * GB,     // SQLite storage
  blobBytes: 10 * GB,       // R2 storage
};

/** Decision 13.6: a Cloudflare Cloud stops at 80% of the free limits unless its owner raises it. */
export const DEFAULT_PERCENT = 80;
/** Share of each cap held back for owners' /v1/usage, people rules and revocations (plan 5b). */
export const RESERVE = 0.05;

export type CapConfig = {
  /** Percent of this Cloud's share of the free limits, 1 to 100. */
  percent: number;
  /** This Cloud's share of the account's free limits, above 0 and at most 1. */
  share: number;
  /** Owner set caps in whole units (requests, GB-s, rows, bytes); they win over percent and share. */
  custom?: Partial<Record<Resource, number>>;
};
export const defaultCapConfig = (): CapConfig => ({ percent: DEFAULT_PERCENT, share: 1 });

/**
 * Splits the account's free limits between the Clouds deployed on it. Equal by default
 * (decision 13.11); `weights` is the owner's changed split, by Cloud name. A Cloud missing from
 * `weights` keeps weight 1; weights at or below 0 are refused.
 */
export function splitShares(clouds: readonly string[], weights: Record<string, number> = {}): Record<string, number> {
  const names = [...new Set(clouds)];
  if (!names.length) return {};
  const weight = (name: string) => {
    const w = weights[name] ?? 1;
    if (!Number.isFinite(w) || w <= 0) throw new Error(`share for ${name} must be above 0`);
    return w;
  };
  const total = names.reduce((sum, name) => sum + weight(name), 0);
  return Object.fromEntries(names.map(name => [name, weight(name) / total]));
}

/** Parses USAGE_CAPS: "free", "share=N", or JSON `{percent?, share?, custom?}`. Throws on nonsense. */
export function parseCapConfig(text: string | undefined): CapConfig {
  const value = (text ?? "").trim();
  if (!value || value === "free") return defaultCapConfig();
  const shareMatch = /^share=(\d{1,3})$/.exec(value);
  if (shareMatch) {
    const n = Number(shareMatch[1]);
    if (n < 1) throw new Error("share=N needs N of at least 1");
    return { percent: DEFAULT_PERCENT, share: 1 / n };
  }
  const raw = JSON.parse(value) as Partial<CapConfig>;
  const config: CapConfig = { percent: raw.percent ?? DEFAULT_PERCENT, share: raw.share ?? 1 };
  if (!Number.isFinite(config.percent) || config.percent < 1 || config.percent > 100) throw new Error("percent must be 1 to 100");
  if (!Number.isFinite(config.share) || config.share <= 0 || config.share > 1) throw new Error("share must be above 0 and at most 1");
  if (raw.custom) {
    config.custom = {};
    for (const [key, cap] of Object.entries(raw.custom)) {
      if (!(RESOURCES as readonly string[]).includes(key)) throw new Error(`unknown cap ${key}`);
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) throw new Error(`cap ${key} must be 0 or more`);
      if (cap * UNITS[key as Resource] > Number.MAX_SAFE_INTEGER) throw new Error(`cap ${key} is too large`);
      config.custom[key as Resource] = cap;
    }
  }
  return config;
}

/** This Cloud's share of the free limits, in internal units: what "of free" means for it. */
export function freeFor(config: CapConfig): Record<Resource, number> {
  const out = {} as Record<Resource, number>;
  for (const r of RESOURCES) out[r] = Math.floor(FREE[r] * config.share * UNITS[r]);
  return out;
}

/** Caps in internal units, always safe integers. A cap that is not a finite number is 0: refused, never unlimited. */
export function capsFor(config: CapConfig): Record<Resource, number> {
  const free = freeFor(config);
  const out = {} as Record<Resource, number>;
  for (const r of RESOURCES) {
    const custom = config.custom?.[r];
    const cap = custom !== undefined ? custom * UNITS[r] : free[r] * config.percent / 100;
    out[r] = Number.isFinite(cap) && cap > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(cap)) : 0;
  }
  return out;
}

// ---- What each kind of work costs, in internal units ----

/** HTTP requests and socket opens are whole requests; incoming socket messages are 1/20 each. */
export function requestUnits(count: { http?: number; messages?: number }): number {
  return (count.http ?? 0) * UNITS.requests + (count.messages ?? 0) * (UNITS.requests / MESSAGES_PER_REQUEST);
}
/**
 * Estimated Durable Object duration: billed at 128 MB for every second awake, and the provider's
 * pricing example counts 128 MB as 0.128 GB, so one awake second is 128 thousandths of a GB-s.
 * Labelled "estimated" wherever it is shown.
 */
export function durationUnits(awakeMs: number): number {
  return Math.ceil(Math.max(0, awakeMs) * 128 / 1000);
}

// ---- Days ----

export const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
export const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);
/** Milliseconds since epoch of the next 00:00 UTC, when daily leases end and refused work may retry. */
export function nextDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
export function nextMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
export const isDaily = (r: Resource): r is Daily => (DAILY as readonly string[]).includes(r);
export const isMonthly = (r: Resource): r is Monthly => (MONTHLY as readonly string[]).includes(r);
export const isStored = (r: Resource): r is Stored => (STORED as readonly string[]).includes(r);
/** The period a resource is counted in at `now`: a UTC day, a UTC month, or "stored". */
export function periodOf(r: Resource, now: number): string {
  return isDaily(r) ? dayOf(now) : isMonthly(r) ? monthOf(now) : "stored";
}
export function periodEnd(r: Resource, now: number): number {
  return isDaily(r) ? nextDay(now) : isMonthly(r) ? nextMonth(now) : Infinity;
}

// ---- Brakes ----

export type Level = "ok" | "amber" | "red" | "stop";
export const AMBER_AT = 0.6;
export const RED_AT = 0.8;
const rank: Record<Level, number> = { ok: 0, amber: 1, red: 2, stop: 3 };
export const worst = (levels: Iterable<Level>): Level => {
  let out: Level = "ok";
  for (const level of levels) if (rank[level] > rank[out]) out = level;
  return out;
};

/** Amber from 60% of a cap, red from 80%, stop at the cap. A cap of 0 is always stopped. */
export function levelFor(used: number, cap: number): Level {
  if (cap <= 0 || used >= cap) return "stop";
  const f = used / cap;
  return f >= RED_AT ? "red" : f >= AMBER_AT ? "amber" : "ok";
}

/**
 * What the brakes let through, by priority.
 * - `bulk` (presence, snapshots, thumbnails, imports) stops at red, 80% of a cap.
 * - `work` (actions, uploads, new files, ordinary REST) stops at the reserve line, 95% of a cap.
 * - `essential` (comments, reads, owners' /v1/usage, people rules, revocations) stops at the cap.
 */
export type Priority = "bulk" | "work" | "essential";
export function lineFor(priority: Priority, cap: number): number {
  if (priority === "essential") return cap;
  if (priority === "work") return Math.floor(cap * (1 - RESERVE));
  return Math.floor(cap * RED_AT);
}

// ---- The meter and the budget ----

export type DayRecord = { day: string } & Record<Daily, number>;
export type UsageState = {
  day: string;
  month: string;
  used: Record<Resource, number>;
  /** Raw counts behind `requests`, shown to owners. */
  raw: { http: number; messages: number };
  /** Up to 14 finished days, newest first. */
  history: DayRecord[];
  updatedAt: number;
};
export const HISTORY_DAYS = 14;

const zeroes = (): Record<Resource, number> => Object.fromEntries(RESOURCES.map(r => [r, 0])) as Record<Resource, number>;

export function freshState(now: number): UsageState {
  return { day: dayOf(now), month: monthOf(now), used: zeroes(), raw: { http: 0, messages: 0 }, history: [], updatedAt: now };
}

/** Moves a state to `now`'s day and month: finished days go to history, daily counts restart at 0. */
export function rollState(state: UsageState, now: number): boolean {
  let changed = false;
  const day = dayOf(now);
  if (day !== state.day) {
    if (day > state.day) {
      const record = { day: state.day } as DayRecord;
      for (const r of DAILY) record[r] = state.used[r];
      state.history = [record, ...state.history.filter(h => h.day !== state.day)].slice(0, HISTORY_DAYS);
      for (const r of DAILY) state.used[r] = 0;
      state.raw = { http: 0, messages: 0 };
      state.day = day;
      changed = true;
    }
  }
  const month = monthOf(now);
  if (month > state.month) {
    for (const r of MONTHLY) state.used[r] = 0;
    state.month = month;
    changed = true;
  }
  return changed;
}

/** Reads a stored state back, dropping anything malformed instead of trusting it. */
export function loadState(value: unknown, now: number): UsageState {
  const fresh = freshState(now);
  if (!value || typeof value !== "object") return fresh;
  const v = value as Partial<UsageState>;
  if (typeof v.day !== "string" || typeof v.month !== "string" || !v.used || typeof v.used !== "object") return fresh;
  const used = zeroes();
  for (const r of RESOURCES) {
    const n = (v.used as Record<string, unknown>)[r];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) used[r] = n;
  }
  const raw = v.raw && typeof v.raw.http === "number" && typeof v.raw.messages === "number" ? { http: v.raw.http, messages: v.raw.messages } : { http: 0, messages: 0 };
  const history = Array.isArray(v.history) ? v.history.filter(h => h && typeof h.day === "string").slice(0, HISTORY_DAYS) : [];
  const state: UsageState = { day: v.day, month: v.month, used, raw, history, updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : now };
  rollState(state, now);
  return state;
}

// ---- GET /v1/usage ----

export type MetricReport = {
  /** Whole requests, GB-s, rows, operations or bytes, rounded up. */
  used: number;
  /** Held by open leases, not yet used. */
  reserved: number;
  cap: number;
  /** This Cloud's share of the free limit, for "of free". */
  free: number;
  level: Level;
  estimated?: true;
};
export type CloudflareUsage = {
  adapter: "cloudflare";
  day: string;
  month: string;
  percent: number;
  share: number;
  metrics: Record<Resource, MetricReport>;
  /** Raw counts behind `requests`. */
  counts: { http: number; messages: number };
  brake: Level;
  days: DayRecord[];
  updatedAt: string;
};
export type MacUsage = {
  adapter: "mac";
  storageBytes: number;
  peopleConnected: number;
  uptimeSeconds: number;
  freeDiskBytes?: number;
  messages24h?: number;
  restartsLastHour?: number;
  updatedAt: string;
};
export type UsageReport = CloudflareUsage | MacUsage;

export const toWhole = (r: Resource, units: number) => Math.ceil(units / UNITS[r]);

/** The Mac adapter's answer: what it measured, no limits. */
export function macUsage(input: Omit<MacUsage, "adapter" | "updatedAt">, now: number): MacUsage {
  return { adapter: "mac", ...input, updatedAt: new Date(now).toISOString() };
}

/** Owners only. Everyone else gets 403 before anything is read. */
export function answerUsage(role: string | null | undefined, build: () => UsageReport): { status: 200; body: UsageReport } | { status: 403; body: { code: "forbidden"; message: string } } {
  if (role !== "owner") return { status: 403, body: { code: "forbidden", message: "Only owners see usage" } };
  return { status: 200, body: build() };
}
