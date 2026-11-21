// Keeps live widgets fresh, but only the ones somebody can see. A page holds a lease on the widgets
// in its viewport (90 s, renewed every 45 s while visible); no lease, no fetch. One timer sleeps
// until the next widget is due. A failing source backs off; a slow one is served stale while it refetches.

import { makeCtx } from "./ctx.ts";
import { clearSecret, redact } from "./keychain.ts";
import { kindOf } from "./registry.ts";
import { isSourceApproved } from "./trust.ts";
import { SourceApproval, WidgetError, type FetchCtx, type Reading, type SecretRef, type Source, type Widget, type WidgetKind } from "./types.ts";

export const LEASE_MS = 90_000;
const FLUSH_MS = 250;
const BACKOFF_CAP_MS = 15 * 60_000;
const REFRESH_MIN_MS = 5000;

type Entry = {
  file: string;
  id: string;
  /** Earliest time the next fetch may start while somebody is looking. */
  nextAt: number;
  failures: number;
  inflight: boolean;
  configKey: string;
  version?: string;
  /** Bumped whenever the widget's config changes: a fetch started under an older generation is thrown away. */
  gen: number;
  lastRefresh: number;
  reading?: Reading;
  /** Last reading pushed to pages, excluding its timestamp. */
  sent?: string;
  samples?: number[];
};

type Lease = { ids: Set<string>; expires: number };

export type PollerOptions = {
  widgetsOf(file: string): Widget[];
  emit(file: string, batch: Record<string, Reading>): void;
  /** Called when a file gets its first lease; returns what to call when its last one ends. */
  hold?(file: string): () => void;
  makeCtx?(file: string, widget: Widget, force: boolean): FetchCtx;
  leaseMs?: number;
};

export class Poller {
  private opts: PollerOptions;
  private entries = new Map<string, Entry>();
  private leases = new Map<string, Map<string, Lease>>(); // file -> client -> lease
  private holds = new Map<string, () => void>();
  private timer: NodeJS.Timeout | undefined;
  private pending = new Map<string, Record<string, Reading>>();
  private flushTimer: NodeJS.Timeout | undefined;
  private shared = new Map<string, Promise<{ ok: true; data: Awaited<ReturnType<NonNullable<WidgetKind["source"]>["fetch"]>> } | { ok: false; err: WidgetError }>>();
  private stopped = false;

  constructor(opts: PollerOptions) {
    this.opts = opts;
  }

  private now = () => Date.now();
  private entry(file: string, id: string): Entry {
    const k = `${file}\0${id}`;
    let e = this.entries.get(k);
    if (!e) this.entries.set(k, (e = { file, id, nextAt: 0, failures: 0, inflight: false, configKey: "", gen: 0, lastRefresh: 0 }));
    return e;
  }

  private sourceOf(w: Widget | undefined): WidgetKind["source"] | undefined {
    return w && kindOf(w.kind)?.source;
  }

  private syncVersion(e: Entry, src: NonNullable<WidgetKind["source"]>): void {
    if (e.version === src.version) return;
    e.version = src.version;
    e.gen++;
    e.nextAt = 0;
    e.failures = 0;
    e.lastRefresh = 0;
    if (e.reading) this.push(e, { state: "loading" });
  }

  private syncConfig(e: Entry, w: Widget, src: Source): void {
    const key = JSON.stringify([w.kind, w.config]);
    if (e.configKey === key) return;
    e.configKey = key;
    e.gen++;
    e.nextAt = 0;
    e.failures = 0;
    e.lastRefresh = 0;
    e.samples = undefined;
    if (e.reading && src.approval) this.push(e, { state: "loading" });
    else if (e.reading?.state === "ok") this.push(e, { ...e.reading, state: "stale" });
  }

  private needsApproval(w: Widget, e: Entry, src: Source): boolean {
    const rule = src.approval;
    if (!rule) return false;
    const target = rule.target(w.config);
    if (!target || isSourceApproved(w.kind, target)) return false;
    this.push(e, this.approvalReading(new SourceApproval(target, rule.verb)));
    return true;
  }

  private approvalReading(err: SourceApproval): Reading {
    return { state: "needs-approval", approvalTarget: err.target, error: { code: err.code, message: err.message } };
  }

  private interestIds(file: string): Set<string> {
    const out = new Set<string>();
    const now = this.now();
    for (const l of this.leases.get(file)?.values() ?? []) if (l.expires > now) for (const id of l.ids) out.add(id);
    return out;
  }

  /** The live widgets somebody is looking at right now. */
  private wanted(): { w: Widget; e: Entry; src: NonNullable<WidgetKind["source"]> }[] {
    const out: { w: Widget; e: Entry; src: NonNullable<WidgetKind["source"]> }[] = [];
    for (const file of this.leases.keys()) {
      const ids = this.interestIds(file);
      if (!ids.size) continue;
      for (const w of this.opts.widgetsOf(file)) {
        if (!ids.has(w.id)) continue;
        const src = this.sourceOf(w);
        if (src) {
          const e = this.entry(file, w.id);
          this.syncVersion(e, src);
          this.syncConfig(e, w, src);
          if (this.needsApproval(w, e, src)) continue;
          // CI can also wait for approval of the remote resolved from a repository folder.
          if (e.reading?.approvalTarget && !isSourceApproved(w.kind, e.reading.approvalTarget)) continue;
          out.push({ w, e, src });
        }
      }
    }
    return out;
  }

  private intervalMs(w: Widget, src: NonNullable<WidgetKind["source"]>): number {
    return Math.max(src.minIntervalSec, src.intervalSec(w.config)) * 1000;
  }

  /** Renew a client's lease on these widgets. An empty list (a hidden tab) ends it. */
  setInterest(file: string, clientId: string, ids: string[]): void {
    if (this.stopped) return;
    const before = this.interestIds(file);
    let byClient = this.leases.get(file);
    if (!ids.length) byClient?.delete(clientId);
    else {
      if (!byClient) this.leases.set(file, (byClient = new Map()));
      byClient.set(clientId, { ids: new Set(ids), expires: this.now() + (this.opts.leaseMs ?? LEASE_MS) });
      if (!this.holds.has(file) && this.opts.hold) this.holds.set(file, this.opts.hold(file));
    }
    this.cleanFile(file);
    const now = this.now();
    for (const w of this.opts.widgetsOf(file)) {
      const src = this.sourceOf(w);
      if (!src || before.has(w.id) || !this.interestIds(file).has(w.id)) continue;
      // Newly in view: show what we have right away (stale if old), and refetch if it is due.
      const e = this.entry(file, w.id);
      this.syncVersion(e, src);
      this.syncConfig(e, w, src);
      if (this.needsApproval(w, e, src)) continue;
      const age = e.reading?.updatedAt ? now - e.reading.updatedAt : Infinity;
      if (e.reading?.state === "ok" && age > this.intervalMs(w, src)) this.push(e, { ...e.reading, state: "stale" });
      if (!e.reading) this.push(e, { state: "loading" });
      // A source that is failing keeps its backoff; everything else that is due or unknown goes now.
      const st = e.reading?.state;
      if (!e.reading?.updatedAt && !e.failures) e.nextAt = Math.min(e.nextAt, now);
      else if ((st === "ok" && age >= this.intervalMs(w, src)) || st === "needs-secret" || st === "needs-approval") e.nextAt = Math.min(e.nextAt, now);
    }
    this.schedule();
  }

  dropClient(clientId: string): void {
    for (const [file, byClient] of this.leases) {
      if (byClient.delete(clientId)) this.cleanFile(file);
    }
    this.schedule();
  }

  private cleanFile(file: string): void {
    const byClient = this.leases.get(file);
    const now = this.now();
    if (byClient) for (const [c, l] of byClient) if (l.expires <= now) byClient.delete(c);
    if (!byClient?.size) {
      this.leases.delete(file);
      this.holds.get(file)?.();
      this.holds.delete(file);
    }
  }

  /** The file's widgets changed: forget removed ones, refetch ones whose source changed. */
  reconcile(file: string): void {
    const widgets = this.opts.widgetsOf(file);
    const live = new Map(widgets.map((w) => [w.id, w]));
    for (const [k, e] of this.entries) {
      if (e.file !== file) continue;
      const w = live.get(e.id);
      const src = w && this.sourceOf(w);
      if (!w || !src) {
        this.entries.delete(k);
        continue;
      }
      this.syncConfig(e, w, src);
    }
    this.schedule();
  }

  /** After the user allows an origin or saves a secret: try the blocked widgets again now. */
  retryBlocked(file?: string): void {
    for (const e of this.entries.values()) if ((!file || e.file === file) && (e.reading?.state === "needs-secret" || e.reading?.state === "needs-approval")) e.nextAt = 0;
    this.schedule();
  }

  readings(file: string): Record<string, Reading> {
    const out: Record<string, Reading> = {};
    let widgets: Map<string, Widget> | undefined;
    for (const e of this.entries.values()) {
      if (e.file !== file || !e.reading) continue;
      if (e.version) {
        widgets ??= new Map(this.opts.widgetsOf(file).map((w) => [w.id, w]));
        if (this.sourceOf(widgets.get(e.id))?.version !== e.version) continue;
      }
      out[e.id] = e.reading;
    }
    return out;
  }

  /** Fetch now, whether or not anybody is looking. At most once every 5 s per widget. */
  async refresh(file: string, id: string): Promise<{ reading?: Reading; retryAfterSec?: number }> {
    const w = this.opts.widgetsOf(file).find((x) => x.id === id);
    const src = w && this.sourceOf(w);
    if (!w || !src) throw new WidgetError(422, "no-source", "This widget has no live data to refresh");
    const e = this.entry(file, id);
    this.syncVersion(e, src);
    this.syncConfig(e, w, src);
    if (this.needsApproval(w, e, src)) return { reading: e.reading };
    const now = this.now();
    if (now - e.lastRefresh < REFRESH_MIN_MS) return { retryAfterSec: Math.ceil((REFRESH_MIN_MS - (now - e.lastRefresh)) / 1000) };
    e.lastRefresh = now;
    await this.run(w, e, src, true);
    this.schedule();
    return { reading: e.reading };
  }

  private push(e: Entry, r: Reading, manualRefresh = false): void {
    e.reading = r;
    const { updatedAt: _updatedAt, ...data } = r;
    const sig = JSON.stringify(data);
    // The native inspector uses the new timestamp to finish a manual refresh.
    if (!manualRefresh && sig === e.sent) return;
    e.sent = sig;
    let batch = this.pending.get(e.file);
    if (!batch) this.pending.set(e.file, (batch = {}));
    batch[e.id] = r;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        const all = [...this.pending];
        this.pending.clear();
        for (const [file, b] of all) {
          try {
            this.opts.emit(file, b);
          } catch (err) {
            console.error(`[canvas] widget data: ${err}`);
          }
        }
      }, FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }

  private async run(w: Widget, e: Entry, src: NonNullable<WidgetKind["source"]>, force: boolean): Promise<void> {
    e.inflight = true;
    const gen = e.gen;
    const key = `${w.kind}\0${src.key(w.config)}` + (force ? `\0force${e.id}` : "");
    let p = this.shared.get(key);
    if (!p) {
      p = (async () => {
        try {
          const ctx = (this.opts.makeCtx ?? makeCtx)(e.file, w, force);
          return { ok: true as const, data: await src.fetch(ctx) };
        } catch (err) {
          const we = err instanceof WidgetError ? err : new WidgetError(0, "error", (err as Error).message || "Fetch failed");
          return { ok: false as const, err: we };
        }
      })();
      this.shared.set(key, p);
      p.finally(() => this.shared.delete(key));
    }
    const r = await p;
    e.inflight = false;
    // The widget's source changed (or it was removed) while this fetch ran: its answer is about the old config.
    // reconcile() already marked the entry due, so the caller's schedule() fetches the new one.
    if (e.gen !== gen || this.entries.get(`${e.file}\0${e.id}`) !== e) return;
    if (src.version && this.sourceOf(w)?.version !== src.version) return;
    const now = this.now();
    const ms = this.intervalMs(w, src);
    if (r.ok) {
      e.failures = 0;
      e.nextAt = now + ms;
      const data = r.data;
      if (w.kind === "metric" && typeof data.value === "number" && !data.spark?.length) {
        e.samples = [...(e.samples ?? []), data.value].slice(-30);
        this.push(e, { ...data, spark: e.samples, state: "ok", updatedAt: now }, force);
      } else {
        this.push(e, { ...data, state: data.empty ? "empty" : "ok", updatedAt: now }, force);
      }
      return;
    }
    const err = r.err;
    if (err.code === "auth") {
      const ref = (src.secretUse?.(w.config)?.ref ?? undefined) as SecretRef | undefined;
      if (ref) clearSecret(ref);
    }
    const message = redact(err.message);
    if (err.code === "needs-secret" || err.code === "needs-approval") {
      // Nothing to retry until the user acts; the page's Refresh (or a new lease) tries again.
      e.nextAt = now + ms;
      this.push(e, err instanceof SourceApproval ? this.approvalReading(err) : { state: err.code, error: { code: err.code, message } });
      return;
    }
    e.failures++;
    let delay = Math.min(ms * 2 ** e.failures, BACKOFF_CAP_MS);
    delay *= 0.9 + Math.random() * 0.2;
    if (err.retryAfterSec) delay = Math.max(delay, err.retryAfterSec * 1000);
    e.nextAt = now + delay;
    const prev = e.reading;
    const keep = prev && (prev.state === "ok" || prev.state === "stale") ? prev : undefined;
    this.push(e, keep ? { ...keep, state: "stale", error: { code: err.code, message } } : { state: "error", error: { code: err.code, message } });
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    let next = Infinity;
    for (const { e } of this.wanted()) if (!e.inflight) next = Math.min(next, e.nextAt);
    if (next === Infinity) return;
    this.timer = setTimeout(() => this.tick(), Math.max(0, next - this.now()));
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = undefined;
    for (const file of [...this.leases.keys()]) this.cleanFile(file);
    const now = this.now();
    const due = this.wanted().filter(({ e }) => !e.inflight && e.nextAt <= now);
    // Started together, so widgets with the same source key share one fetch.
    for (const { w, e, src } of due) void this.run(w, e, src, false).then(() => this.schedule());
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.flushTimer);
    for (const rel of this.holds.values()) rel();
    this.holds.clear();
    this.leases.clear();
  }
}
