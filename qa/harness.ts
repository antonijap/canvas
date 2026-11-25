// The scenario harness for qa/run.ts: a scenario's document, tab, input, disk and page, and the scenario list.
import fs from "node:fs";
import path from "node:path";
import type { Page } from "../fidelity/cdp.ts";
import type { LatencyKind, OptOut } from "./checks.ts";
import { Input, api, sleep, type Scratch } from "./lib.ts";

export const W = 1600, H = 1000;

export type Rect = { x: number; y: number; w: number; h: number };
export type AnyNode = Record<string, any> & { id?: string; type?: string; children?: AnyNode[] };

export class Skip extends Error {}
export class Fail extends Error {}

/** Everything a scenario needs: its document, its tab, input, the disk, the page. */
export class T {
  notes: string[] = [];
  /** What the end-state picture is cropped to: board ids or widget:<id> (null: everything on the active page). */
  subject: string[] | null = null;
  /** Or a world rect to crop to (wins over subject). */
  subjectRect: Rect | null = null;
  /** Latency samples the scenario measured, checked against docs/perf/latency.md's budgets. */
  lat: { kind: LatencyKind; ms: number; what: string }[] = [];
  /** The DevTools port of the worker's Chrome, for a scenario that opens a second tab (another file). */
  chromePort = 0;
  private counting = false;
  readonly page: Page;
  readonly io: Input;
  readonly file: string;
  readonly srv: Scratch;
  readonly a: ReturnType<typeof api>;
  constructor(page: Page, file: string, srv: Scratch) {
    this.page = page;
    this.io = new Input(page);
    this.file = file;
    this.srv = srv;
    this.a = api(srv.base, file);
  }
  // ------------------------------------------------ page
  ev<R = any>(js: string): Promise<R> { return this.page.eval<R>(js); }
  async waitFor<R>(js: string, what: string, ms = 8000): Promise<R> {
    const t0 = Date.now();
    let last: any;
    while (Date.now() - t0 < ms) {
      try { last = await this.ev(js); if (last) return last; } catch (e) { last = (e as Error).message; }
      await sleep(40);
    }
    throw new Fail(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
  }
  async settle(ms = 15000) {
    await this.waitFor("window.__canvas && window.__canvas.renderer === 'engine' && window.__canvas.settled() && !window.__canvas.flying", "the engine to settle", ms);
    await this.frames(2);
  }
  frames(n = 2) { return this.ev(`new Promise((r) => { let k = ${n}; const f = () => (--k <= 0 ? r(1) : requestAnimationFrame(f)); requestAnimationFrame(f); })`); }
  async open(opts: { native?: boolean } = {}) {
    await this.page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    // Reduce Motion: shader cards hold still (their poster), so a picture of the canvas is the same every run. Dark:
    // the baselines are dark, whatever appearance this Mac is in (a Mac switched to light failed 122 of them).
    await this.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" }] });
    if (!this.counting) { this.counting = true; await this.page.send("Page.addScriptToEvaluateOnNewDocument", { source: FETCH_COUNTER }); }
    await this.page.goto(`${this.srv.base}/?file=${encodeURIComponent(this.file)}${opts.native ? "&shell=native" : ""}`);
    await this.waitFor("window.canvasHost && window.canvasHost.doc && window.__canvas && window.__canvas.renderer !== 'pending'", "the page to load", 30000);
    const r = await this.ev<string>("window.__canvas.renderer");
    if (r !== "engine") throw new Fail(`renderer is ${r} (${await this.ev("window.__canvas.note")}), not the engine`);
    await this.settle(30000);
  }
  /** Show a page (by clicking its row in the left rail) and wait for its boards. */
  async showPage(id: string) {
    if ((await this.ev("window.canvasHost.page")) === id) return;
    await this.ev(`(() => {
      document.querySelector('#sidebar-toggle[aria-expanded="false"]')?.click();
      document.querySelector('#sidebar-layers[aria-checked="false"]')?.click();
    })()`);
    const name = await this.ev<string>(`window.canvasHost.pages.find((p) => p.id === ${JSON.stringify(id)}).name`);
    const at = await this.ev<{ x: number; y: number } | null>(`(() => { const r = [...document.querySelectorAll("#pages .row")].find((e) => e.textContent === ${JSON.stringify(name)}); if (!r) return null; r.scrollIntoView({ block: "nearest" }); const b = r.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; })()`);
    if (!at) throw new Fail(`no row for page ${name} in the left rail`);
    await this.io.click(at.x, at.y);
    await this.waitFor(`window.canvasHost.page === ${JSON.stringify(id)}`, `page ${id}`);
    await this.settle();
  }
  /** Camera: world point (wx, wy) at the view's left/top + pad, at zoom z. */
  async look(wx: number, wy: number, z = 1, pad = 60) {
    await this.ev(`window.canvasHost.setCam({ z: ${z}, x: ${pad} - ${wx} * ${z}, y: ${pad + 20} - ${wy} * ${z} })`);
    await this.settle();
  }
  /** Show a board at 100% near the top left of the view. */
  async focus(boardId: string, z = 1) {
    const page = await this.ev<string | null>(`window.canvasHost.pageOfBoard(${JSON.stringify(boardId)})`);
    if (page) await this.showPage(page);
    const b = await this.ev<Rect>(`window.__canvas.boardPos(${JSON.stringify(boardId)})`);
    if (!b) throw new Fail(`no board ${boardId} on the page`);
    this.subject = [boardId];
    await this.look(b.x, b.y, z);
  }
  /** A drawn layer's rect in window CSS px (from the engine). */
  async rect(id: string): Promise<Rect> {
    const r = await this.ev<Rect | null>(`(() => { const h = window.canvasHost, c = h.cam, r = h.worldRectOf(${JSON.stringify(id)}); if (!r) return null; return { x: h.viewBox.l + r.x * c.z + c.x, y: h.viewBox.t + r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z }; })()`);
    if (!r) throw new Fail(`${id} is not drawn`);
    return r;
  }
  async center(id: string) { const r = await this.rect(id); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
  sel(): Promise<string[]> { return this.ev("window.canvasHost.selection()"); }
  async select(ids: string[]) { await this.ev(`window.canvasHost.setSelection(${JSON.stringify(ids)})`); await this.frames(2); }
  async clearSel() { await this.ev("window.canvasHost.clearSel()"); await this.frames(1); }
  /** The #sel box in window px, or null when hidden. */
  selBox(): Promise<Rect | null> {
    return this.ev(`(() => { const e = document.getElementById("sel"); if (!e) return null; const s = getComputedStyle(e); if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return null; const r = e.getBoundingClientRect(); return r.width || r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; })()`);
  }
  async shot(clip?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
    await this.frames(2);
    const r = await this.page.send("Page.captureScreenshot", { format: "png", fromSurface: true, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    return Buffer.from(r.data, "base64");
  }
  // ------------------------------------------------ server and disk
  async flush() {
    // Edits the page still holds (a drag's write in flight, a nudge it is batching) land first.
    await sleep(150);
    // Quiet twice in a row: no request of the page in flight (a key's lookup then its write) and none it is holding.
    await this.waitFor(`(() => { const quiet = !(window.__qaFetches && window.__qaFetches()) && !(window.canvasHost && window.canvasHost.writesPending && window.canvasHost.writesPending()); const was = window.__qaQuiet; window.__qaQuiet = quiet; return quiet && was; })()`, "the page's requests to finish", 10000).catch(() => {});
    const r = await this.a.flush();
    if (!r.ok) throw new Fail(`flush: ${JSON.stringify(r)}`);
  }
  disk(): { children: AnyNode[]; [k: string]: any } { return JSON.parse(fs.readFileSync(path.join(this.file, "document.json"), "utf8")); }
  widgets(): { widgets: any[]; pages: any[] } { return JSON.parse(fs.readFileSync(path.join(this.file, "widgets.json"), "utf8")); }
  node(id: string, doc = this.disk()): AnyNode | null { return find(doc.children, id)?.node ?? null; }
  parentOf(id: string, doc = this.disk()): string | null { const f = find(doc.children, id); return f ? f.parent?.id ?? null : null; }
  widget(kind: string) { const w = this.widgets().widgets.find((x) => x.kind === kind); if (!w) throw new Fail(`no ${kind} card`); return w; }
  async undo() { await this.io.key("z", { meta: true }); await this.waitHistory(); }
  async redo() { await this.io.key("z", { meta: true, shift: true }); await this.waitHistory(); }
  async waitHistory() { await sleep(250); await this.flush(); }
  // ------------------------------------------------ asserts
  ok(cond: unknown, msg: string): asserts cond { if (!cond) throw new Fail(msg); }
  eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Fail(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
  near(a: number, b: number, tol: number, msg: string) { if (!(Math.abs(a - b) <= tol)) throw new Fail(`${msg}: got ${a}, want ${b} (±${tol})`); }
  skip(why: string): never { throw new Skip(why); }
  note(s: string) { this.notes.push(s); }
  /** Run `fn` and record how long each write the page sent meanwhile took (fetch start to response end). */
  async measureWrites<R>(what: string, fn: () => Promise<R>): Promise<R> {
    const t0 = await this.ev<number>("performance.now()");
    const r = await fn();
    await this.flush();
    const xs = await this.ev<{ name: string; ms: number }[]>(`performance.getEntriesByType("resource").filter((e) => e.startTime >= ${t0} && ${WRITE_RE}.test(e.name) && !/[?&]id=/.test(e.name)).map((e) => ({ name: e.name.replace(/^.*\\/api\\//, "").split("?")[0], ms: e.responseEnd - e.startTime }))`);
    for (const x of xs) this.lat.push({ kind: "write", ms: x.ms, what: `${what} (${x.name})` });
    if (!xs.length) this.note(`${what}: no write measured`);
    return r;
  }
}

export function find(list: AnyNode[], id: string, parent: AnyNode | null = null): { node: AnyNode; parent: AnyNode | null } | null {
  for (const n of list) {
    if (n.id === id) return { node: n, parent };
    if (n.children) { const f = find(n.children, id, n); if (f) return f; }
  }
  return null;
}
export const allIds = (doc: { children: AnyNode[] }) => { const out: string[] = []; const w = (n: AnyNode) => { if (n.id) out.push(n.id); (n.children ?? []).forEach(w); }; doc.children.forEach(w); return out; };

// ---------------------------------------------------------------- scenarios

/** covers: catalog pairs "feature:case" (qa/features.yaml). skip: shared checks this scenario opts out of, and why. */
export type Scenario = { name: string; area: string; covers: string[]; skip?: OptOut; run: (t: T) => Promise<void>; kind: "scripted" | "matrix" };
export const scenarios: Scenario[] = [];
export const sc = (area: string, name: string, opts: { covers: string[]; skip?: OptOut }, run: (t: T) => Promise<void>) => { scenarios.push({ area, name, run, ...opts, kind: "scripted" }); };
export const slug = (s: { area: string; name: string }) => `${s.area}-${s.name}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
/** In every QA page: how many of its /api requests are in flight (long polls and the flush itself left out). */
const FETCH_COUNTER = `(() => { let n = 0; const f = window.fetch; window.fetch = function (input, init) { const u = String((input && input.url) || input); const c = /\\/api\\//.test(u) && !/\\/api\\/(flush|bridge\\/wait|bridge\\/events|agent\\/events|variations\\/events)/.test(u); if (c) n++; const p = f.apply(this, arguments); if (c) p.then(() => n--, () => n--); return p; }; window.__qaFetches = () => n; })();`;
/** The page's write requests (resource timing names). */
const WRITE_RE = String.raw`/\/api\/(update|move|resize|structure|text|layout|scale|repeat|widgets|history|pages|overrides)/`;


