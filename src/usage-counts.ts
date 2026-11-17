// Anonymous usage counts: how many times a day each feature was used, nothing else. The website's contract
// (POST https://getcanvas.cc/api/usage, see docs/developer-guide.md "Usage counts"):
//   {v, build?, os?, arch?, day, events: {name: count}, install?}
// one request per completed UTC day, at the next launch or the next day; on any failure the day's counts stay and
// the next try is tomorrow. Never file names, paths, contents, prompts, layer names or anything about the person.
//
// The shell owns the switches (Canvas > Settings > Privacy, apps/macos/SettingsLogic.swift) and sends them with its
// state (POST /api/state, src/bridge.ts) together with the facts only it knows (app version, commit, macOS). Until
// it has, counts wait in memory; "Share usage counts" off drops them and nothing is counted or sent. Without a shell
// (a browser, tests, `pnpm qa`) nothing is ever written or sent.
//
// Only a release build sends: the server runs from inside an app bundle (scripts/release-app.sh puts it in
// Canvas.app/Contents/Resources/server), the shell said share, and it is not a QA build. A development build counts
// into usage-dev.json so Settings > Privacy > Show what's sent works, and never sends.
//
//   POST /api/usage/count {name}   a count from the shell or the page (x-canvas: 1; names outside the list are ignored)
//   GET  /api/usage/preview        {body, sends, share, improve}: what would go out for today

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every name Canvas counts. Anything else is ignored (count, POST /api/usage/count, a stored file). */
export const USAGE_EVENTS = [
  "app.open",
  "crash",
  "file.new",
  "file.open",
  "file.save",
  "course.opened",
  "link.copy",
  "agent.connected.claude",
  "agent.connected.codex",
  "agent.connected.other",
  "agent.prompt",
  "agent.run_done",
  "agent.run_undone",
  "variations.make",
  "variations.keep",
  "variations.discard",
  "widget.add.note",
  "widget.add.todo",
  "widget.add.shader",
  "widget.add.video",
  "widget.add.posthog",
  "export.png",
  "export.svg",
  "export.pdf",
  "export.jpg",
  "export.webp",
  "copy_as.png",
  "copy_as.svg",
  "copy_as.css",
  "copy_as.swiftui",
  "copy_as.text",
  "update.toast_shown",
  "update.download_clicked",
  "update.ready",
  "update.installed",
  "update.failed",
  "bug.report_opened",
] as const;
export type UsageEvent = (typeof USAGE_EVENTS)[number];
const ALLOWED = new Set<string>(USAGE_EVENTS);

export const USAGE_URL = "https://getcanvas.cc/api/usage";
/** The contract's shapes. */
export const RE = {
  v: /^[0-9A-Za-z.+-]{1,32}$/,
  build: /^[0-9a-f]{7,40}$/,
  os: /^[0-9]{2}(\.[0-9]{1,2}){0,2}$/,
  day: /^\d{4}-\d{2}-\d{2}$/,
  name: /^[a-z][a-z0-9_.]{1,47}$/,
  install: /^[0-9a-f]{32}$/,
};
export const MAX_NAMES = 60;
export const MAX_COUNT = 100_000;
export const MAX_BYTES = 8 * 1024;
/** Unsent days kept; older ones go. */
export const KEEP_DAYS = 30;
const SEND_TIMEOUT_MS = 5000;
const SAVE_DEBOUNCE_MS = 2000;
const HOUR = 3600_000;

export const isEvent = (name: unknown): name is UsageEvent => typeof name === "string" && ALLOWED.has(name);

/** The UTC day of a time: 2026-11-17. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const utcMonth = (d: Date): string => d.toISOString().slice(0, 7);

export type Counts = Record<string, number>;
export type UsageBody = { v: string; build?: string; os?: string; arch?: "arm64" | "x86_64"; day: string; events: Counts; install?: string };
type Stored = { days: Record<string, Counts>; lastTry?: string; install?: { month: string; id: string } };

/** What the shell says (src/bridge.ts receiveState): the two switches and the facts only it knows. */
export type UsageFacts = { share: boolean; improve: boolean; version: string | null; commit: string | null; os: string | null; qa: boolean };

export function cleanFacts(raw: unknown): UsageFacts {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
  const share = o.share === true;
  return { share, improve: share && o.improve === true, version: str(o.version, RE.v), commit: str(o.commit, RE.build), os: str(o.os, RE.os), qa: o.qa === true };
}

/** The events of one day as the contract takes them: known names only, positive whole counts at most MAX_COUNT, at most MAX_NAMES. */
export function cleanEvents(counts: Counts, known: (name: string) => boolean = isEvent): Counts {
  const out: Counts = {};
  for (const name of Object.keys(counts).sort()) {
    const n = counts[name];
    if (!known(name) || !RE.name.test(name) || typeof n !== "number" || !Number.isFinite(n) || n < 1) continue;
    if (Object.keys(out).length >= MAX_NAMES) break;
    out[name] = Math.min(MAX_COUNT, Math.floor(n));
  }
  return out;
}

export const nodeArch = (a = process.arch): "arm64" | "x86_64" | undefined => (a === "arm64" ? "arm64" : a === "x64" ? "x86_64" : undefined);

/** The server runs from inside an app bundle (a release; scripts/release-app.sh), not from a checkout. */
export function runsFromBundle(file = fileURLToPath(import.meta.url)): boolean {
  return /\.app\/Contents\/Resources\/server\//.test(file);
}

export const stateDir = () => process.env.CANVAS_STATE_DIR || path.join(os.homedir(), "Library", "Application Support", "Canvas");

export type UsageOpts = {
  /** The folder usage.json (release) or usage-dev.json lives in. */
  dir?: () => string;
  now?: () => Date;
  /** Whether this is a release build (see runsFromBundle). */
  release?: () => boolean;
  url?: () => string;
  fetch?: typeof fetch;
  arch?: string;
  debounceMs?: number;
};

export class UsageCounts {
  private facts: UsageFacts | null = null;
  /** Counts made before the shell said anything: kept in memory only. */
  private pending: Record<string, Counts> = {};
  private stored: Stored | null = null;
  private saveTimer: NodeJS.Timeout | undefined;
  private sending: Promise<string[]> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private readonly o: Required<Omit<UsageOpts, "arch">> & { arch: string };

  constructor(o: UsageOpts = {}) {
    this.o = {
      dir: o.dir ?? stateDir,
      now: o.now ?? (() => new Date()),
      release: o.release ?? (() => runsFromBundle()),
      url: o.url ?? (() => process.env.CANVAS_USAGE_URL || USAGE_URL),
      fetch: o.fetch ?? ((...a) => fetch(...a)),
      arch: o.arch ?? process.arch,
      debounceMs: o.debounceMs ?? SAVE_DEBOUNCE_MS,
    };
  }

  /** usage.json for a release, usage-dev.json otherwise: a development build's counts never reach a release's sender. */
  get file(): string {
    return path.join(this.o.dir(), this.o.release() ? "usage.json" : "usage-dev.json");
  }

  /** One more of `name` today (UTC). Unknown names, and anything while sharing is off, are ignored. */
  count(name: string): void {
    if (!isEvent(name)) return;
    if (this.facts && !this.facts.share) return;
    const day = utcDay(this.o.now());
    const days = this.facts ? this.load().days : this.pending;
    const c = (days[day] ??= {});
    c[name] = Math.min(MAX_COUNT, (c[name] ?? 0) + 1);
    if (this.facts) this.saveSoon();
  }

  /** The shell's switches and facts, with every state post. The first one with share on sends what is due. */
  setFacts(raw: unknown): void {
    const was = this.facts;
    const f = cleanFacts(raw);
    this.facts = f;
    if (!f.share) {
      this.pending = {};
      // Off means nothing kept to send later either.
      if (!was || was.share) this.clearStored();
      return;
    }
    const s = this.load();
    if (!f.improve && s.install) { delete s.install; this.saveSoon(); }
    if (Object.keys(this.pending).length) {
      for (const [day, counts] of Object.entries(this.pending)) {
        const into = (s.days[day] ??= {});
        for (const [k, n] of Object.entries(counts)) into[k] = Math.min(MAX_COUNT, (into[k] ?? 0) + n);
      }
      this.pending = {};
      this.saveSoon();
    }
    if (!was?.share) void this.sendDue();
  }

  get settings(): UsageFacts | null {
    return this.facts;
  }

  /** Whether this server would send: a release, sharing on, not a QA build, and a version to send. */
  sends(): boolean {
    const f = this.facts;
    return !!f && f.share && !f.qa && process.env.CANVAS_QA !== "1" && !!f.version && this.o.release();
  }

  /** The body for `day`, exactly as the sender posts it; null when there is nothing to send. */
  bodyFor(day: string, opts: { empty?: boolean } = {}): UsageBody | null {
    const f = this.facts;
    if (!f || !f.share || !RE.day.test(day)) return null;
    const events = cleanEvents(this.load().days[day] ?? {});
    if (!Object.keys(events).length && !opts.empty) return null;
    const arch = nodeArch(this.o.arch as NodeJS.Architecture);
    const body: UsageBody = {
      v: f.version ?? "0",
      ...(f.commit ? { build: f.commit } : {}),
      ...(f.os ? { os: f.os } : {}),
      ...(arch ? { arch } : {}),
      day,
      events,
      ...(f.improve ? { install: this.installId() } : {}),
    };
    // Never more than the contract's 8 KB (60 short names come nowhere near it): drop the smallest counts until it fits.
    while (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES && Object.keys(body.events).length) {
      const smallest = Object.entries(body.events).sort((a, b) => a[1] - b[1])[0][0];
      delete body.events[smallest];
    }
    return body;
  }

  /**
   * Today's body for Settings > Privacy > Show what's sent (built like the sender's, empty events included), and the
   * same as indented JSON in the order it is sent.
   */
  preview(): { body: UsageBody | null; json: string | null; sends: boolean; share: boolean; improve: boolean } {
    const f = this.facts;
    const body = this.bodyFor(utcDay(this.o.now()), { empty: true });
    return { body, json: body ? JSON.stringify(body, null, 2) : null, sends: this.sends(), share: f?.share ?? false, improve: f?.improve ?? false };
  }

  /**
   * Posts each completed day with counts, oldest first: on ok the day goes, on any failure nothing more today
   * (lastTry) and that day's counts stay for tomorrow. Answers the days sent.
   */
  sendDue(): Promise<string[]> {
    if (this.sending) return this.sending;
    this.sending = this.sendNow().finally(() => { this.sending = null; });
    return this.sending;
  }

  private async sendNow(): Promise<string[]> {
    const sent: string[] = [];
    if (!this.sends()) return sent;
    const s = this.load();
    const today = utcDay(this.o.now());
    if (s.lastTry === today) return sent;
    for (const day of Object.keys(s.days).filter((d) => d < today).sort()) {
      const body = this.bodyFor(day);
      if (!body) { delete s.days[day]; this.saveSoon(); continue; }
      let ok = false;
      try {
        const r = await this.o.fetch(this.o.url(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        const j = r.status === 200 ? ((await r.json().catch(() => null)) as { ok?: unknown } | null) : null;
        ok = j?.ok === true;
      } catch {
        ok = false;
      }
      if (!this.facts?.share) return sent; // switched off while the request was out
      if (!ok) {
        s.lastTry = today;
        this.saveSoon();
        break;
      }
      delete s.days[day];
      sent.push(day);
      this.saveSoon();
    }
    return sent;
  }

  /** At start and every hour: the completed days go out once a day. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sendDue(), HOUR);
    this.timer.unref();
    void this.sendDue();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  /** The random install id for this calendar month (UTC), made here and replaced when the month changes. */
  private installId(): string {
    const s = this.load();
    const month = utcMonth(this.o.now());
    if (!s.install || s.install.month !== month || !RE.install.test(s.install.id)) {
      s.install = { month, id: randomBytes(16).toString("hex") };
      this.saveSoon();
    }
    return s.install.id;
  }

  private load(): Stored {
    if (this.stored) return this.stored;
    let s: Stored = { days: {} };
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Stored>;
      const days: Record<string, Counts> = {};
      if (j.days && typeof j.days === "object") {
        for (const [day, c] of Object.entries(j.days)) if (RE.day.test(day) && c && typeof c === "object") days[day] = cleanEvents(c as Counts);
      }
      s = { days };
      if (typeof j.lastTry === "string" && RE.day.test(j.lastTry)) s.lastTry = j.lastTry;
      if (j.install && typeof j.install.month === "string" && typeof j.install.id === "string" && RE.install.test(j.install.id)) s.install = { month: j.install.month, id: j.install.id };
    } catch {}
    this.stored = s;
    return s;
  }

  private clearStored(): void {
    this.stored = { days: {} };
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      if (fs.existsSync(this.file)) fs.rmSync(this.file, { force: true });
    } catch {}
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), this.o.debounceMs);
    this.saveTimer.unref();
  }

  /** Writes the stored counts now (atomically: a temp file renamed over the old one). */
  flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.stored || !this.facts?.share) return;
    const s = this.stored;
    const days = Object.keys(s.days).sort();
    for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete s.days[d];
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error(`[canvas] usage counts: ${(e as Error).message}`);
    }
  }
}

/** The server's counter. */
export const usage = new UsageCounts();
export const countUsage = (name: string): void => usage.count(name);

/** POST /api/usage/count and GET /api/usage/preview. Returns true when it answered. */
export async function handleUsageCountsRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, u: UsageCounts = usage): Promise<boolean> {
  if (url.pathname !== "/api/usage/count" && url.pathname !== "/api/usage/preview") return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  if (url.pathname === "/api/usage/preview") {
    if (req.method !== "GET") return reply(405, { error: "GET only" }), true;
    return reply(200, u.preview()), true;
  }
  if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden" }), true;
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 1024) return reply(413, { error: "too large" }), true;
  }
  let name: unknown;
  try {
    name = (JSON.parse(raw || "{}") as { name?: unknown }).name;
  } catch {
    return reply(400, { error: "The request body must be JSON" }), true;
  }
  const counted = isEvent(name) && !(u.settings && !u.settings.share);
  if (counted) u.count(name as string);
  return reply(200, { ok: true, counted }), true;
}
