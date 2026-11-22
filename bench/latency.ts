// pnpm bench:latency: the latency budget, measured in headless Chrome (WebGPU engine) against a scratch server.
//
// Budget (agreed with the maintainer): every interaction under one frame, every write under 100 ms.
//   frame      main-thread frame time while panning and zooming (trackpad-like 120 Hz wheel) <= 16.7 ms p95
//              (one 60 Hz frame; the 8.3 ms column counts frames a 120 Hz display would miss)
//   input      input-to-paint: from the input event to the end of the first frame that shows its effect <= 16.7 ms p95
//   write      from the release (or key) to the server's 200 <= 100 ms p95; flush: from an edit's 200 to its bytes on disk
//   info       tab switch and page switch (canvasHost.perf.show / .page: until every board in view is drawn), no budget
//
// Files: the generated 200-board stress file (bench/fixtures/gen.ts), demos/playground.canvas and, only when
// BENCH_FILE names one, a real .canvas package of your own (cloned; the original is never opened by the server),
// all in a temp folder that is deleted at the end. Network is off: Chrome resolves no host but
// 127.0.0.1, the server gets no Keychain secret and no PostHog origin, so cards show cached data or their empty state.
// One headless Chrome, closed at the end. Prints a table, writes bench/out/latency-<time>.json and
// bench/out/latency-latest.json, exits 1 when a line fails its budget.
//
//   pnpm bench:latency                      everything (about 2.5 minutes)
//   pnpm bench:latency frame input          only these groups (frame, input, write, info)
//   LATENCY_FILES=playground pnpm bench:latency   only this file (fixture, playground, real)
//   BENCH_FILE=/path/to/Some.canvas pnpm bench:latency   also a real file; BENCH_FILE_PAGE / BENCH_FILE_CARDS_PAGE name
//                                           its pages (default: the page with the most nodes, the one with the most cards)
//
// How input-to-paint is measured (in the page, injected before the page's own scripts): a capture listener on window
// takes the first input event after the harness arms a probe (its timeStamp; for a coalesced pointermove the oldest
// coalesced event's). From that event on, every frame is followed by a MessageChannel task (it runs once the frame's
// rAF callbacks, style, layout and paint are done) that reads the probe: what the person would see change (the
// engine's rectangle of the dragged layer, the selection, a checkbox). The latency is the end of the first frame
// whose probe differs from before the input. Inputs are sent one at a time, each after the last one showed.
// Frame time: the same after-frame task, from the frame's vsync time (rAF timestamp) to the end of its work.
// GPU: the engine's own gpuDoneMs (frame start to onSubmittedWorkDone, an upper bound).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchChrome, type Chrome, type Page } from "../fidelity/cdp.ts";
import { ROOT, api, copyDir, openTab, sleep, startServer, type Scratch } from "../qa/lib.ts";
import { fixture, scratchCopy } from "./fixtures/gen.ts";

const OUT = path.join(ROOT, "bench", "out");
const W = 1440, H = 900, DSF = 2;
const FRAME_MS = 1000 / 60, FRAME_120 = 1000 / 120;
const BUDGET = { frame: FRAME_MS, input: FRAME_MS, write: 100 };
const REAL = process.env.BENCH_FILE || "";
const PLAYGROUND = path.join(ROOT, "demos", "playground.canvas");
const GROUPS = new Set(process.argv.slice(2).filter((a) => !a.startsWith("-")));
const want = (g: string) => !GROUPS.size || GROUPS.has(g);
const ONLY = new Set((process.env.LATENCY_ONLY || "").split(",").filter(Boolean));
const withTimeout = <R,>(p: Promise<R>, ms: number, what: string) => Promise.race([p, new Promise<R>((_, rej) => setTimeout(() => rej(new Error(`${what} took over ${ms / 1000} s`)), ms))]);
const FILES = new Set((process.env.LATENCY_FILES || `fixture,playground${REAL ? ",real" : ""}`).split(","));

// ---------------------------------------------------------------- stats

const pct = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : NaN);
const r1 = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : n);
function summary(xs: number[]) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return { n: s.length, p50: r1(pct(s, 50)), p95: r1(pct(s, 95)), max: r1(s[s.length - 1] ?? NaN) };
}

export type Line = { group: "frame" | "input" | "write" | "info" | "open" | "memory" | "export" | "mcp"; id?: string; name: string; file: string; n: number; p50: number; p95: number; max: number; budget: number | null; status: "PASS" | "FAIL" | "INFO" | "SKIP"; note: string; extra?: Record<string, unknown>; samples?: number[] };
export const lines: Line[] = [];
// Inputs whose change showed only in the second frame or later, since the last line was added.
let late = 0;
type Sample = { ms: number | null; frames?: number; why?: string; work?: number; wall?: number; snapped?: boolean };
let snapHeld = 0;
function take(xs: number[], s: Sample): boolean { if (s.ms === null && s.snapped) { snapHeld++; return true; } if (s.ms === null) return false; xs.push(s.ms); if ((s.frames ?? 1) > 1) late++; return true; }
export function addLine(group: Line["group"], file: string, name: string, xs: number[], note = "", extra?: Record<string, unknown>, opts: { id?: string; budget?: number | null; missed?: number } = {}) {
  const s = summary(xs);
  const budget = opts.budget !== undefined ? opts.budget : group === "info" ? null : (BUDGET as Record<string, number>)[group] ?? null;
  let status: Line["status"] = budget === null ? "INFO" : !s.n ? "SKIP" : s.p95 <= budget + 0.05 ? "PASS" : "FAIL";
  if (opts.missed && budget !== null) { status = "FAIL"; note = `${opts.missed} input(s) never showed on screen; ${note}`; }
  if (group === "input" && late) { note = `${late} shown a frame late${note ? "; " + note : ""}`; }
  if (group === "input" && snapHeld) { note = `${snapHeld} held by snapping${note ? "; " + note : ""}`; }
  late = 0; snapHeld = 0;
  const l: Line = { group, id: opts.id, name, file, ...s, budget, status, note, extra, samples: xs.map(r1) };
  lines.push(l);
  console.log(`  ${l.status.padEnd(4)} ${group.padEnd(5)} ${file.padEnd(10)} ${name.padEnd(34)} n=${String(s.n).padStart(3)}  p50 ${fmt(s.p50)}  p95 ${fmt(s.p95)}  max ${fmt(s.max)}${note ? "  " + note : ""}`);
}
const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1).padStart(6) : "     -");

// ---------------------------------------------------------------- the page side

/** Injected before the page's scripts: after-frame hook, frame recorder, input probes, write log. */
export const INSTRUMENT = `(() => {
  const L = (window.__lat = {});
  const mc = new MessageChannel(), q = [];
  mc.port1.onmessage = () => { const t = performance.now(); const f = q.shift(); if (f) f(t); };
  // cb(vsync, end): end is when the frame's rendering work is done (a task posted from inside the frame).
  const afterPaint = (cb) => requestAnimationFrame((b) => { q.push((e) => cb(b, e)); mc.port2.postMessage(0); });
  L.afterPaint = afterPaint;
  // ---- frames
  let rec = null;
  const engineStats = () => { try { const e = window.__canvas && window.__canvas.engine; if (!e) return null; const s = e.stats(); return { cpu: s.frameCpuMs, gpu: s.gpuDoneMs, tiles: s.tilesRendered, stop: s.batchStop }; } catch { return null; } };
  L.startFrames = () => {
    rec = [];
    let lastGpu = null;
    const loop = () => afterPaint((b, e) => {
      if (!rec) return;
      const s = engineStats();
      const c = window.canvasHost && window.canvasHost.cam;
      rec.push({ b, e, cpu: s ? s.cpu : null, gpu: s ? s.gpu : null, tiles: s ? s.tiles : null, stop: s ? s.stop : null, cam: c ? c.x + "," + c.y + "," + c.z : "" });
      loop();
    });
    loop();
  };
  L.stopFrames = () => { const r = rec; rec = null; return r || []; };
  // ---- input probes
  let arm = null;
  let armed = null; // the last armed probe, kept after it resolves
  L.arm = (probe, types) => { arm = armed = { probe, types, base: JSON.stringify(probe()), t0: null, done: null, res: null }; arm.done = new Promise((r) => (arm.res = r)); return arm.base; };
  L.wait = () => {
    const a = armed;
    if (!a) return Promise.resolve({ ms: null, why: "not armed" });
    if (a.t0 === null) { a.res({ ms: null, why: "no input event" }); }
    return a.done;
  };
  const poll = (a) => {
    let n = 0, b1 = null;
    const step = () => afterPaint((b, e) => {
      n++;
      if (b1 === null) b1 = b;
      let v;
      try { v = JSON.stringify(a.probe()); } catch (err) { v = "error:" + err.message; }
      if (v !== a.base) {
        arm = arm === a ? null : arm;
        // The wait for the first vsync after the input is ready (handled, for an event dispatched in its own task;
        // arrived, for one Chrome dispatches inside the frame) is no work of the page: it is left out.
        const ready = a.hEnd !== null && a.hEnd <= b1 ? a.hEnd : a.t0;
        const idle = Math.max(0, b1 - ready);
        a.res({ ms: e - a.t0 - idle, wall: e - a.t0, idle, frames: n, work: e - b, value: v });
        return;
      }
      if (n >= 60) {
        // Held by snapping (the smart guides show): the pointer moved, the layer rightly did not.
        const g = document.getElementById("guides");
        a.res({ ms: null, frames: n, why: "no change", value: v, snapped: !!g && getComputedStyle(g).display !== "none" });
        return;
      }
      step();
    });
    step();
  };
  const hc = new MessageChannel();
  hc.port1.onmessage = () => { const a = hc.a; hc.a = null; if (a && a.hEnd === null) a.hEnd = performance.now(); };
  const onInput = (e) => {
    L.last[e.type] = e.timeStamp;
    const a = arm;
    if (!a || a.t0 !== null || (a.types && !a.types.includes(e.type))) return;
    let t = e.timeStamp;
    if (e.getCoalescedEvents) for (const c of e.getCoalescedEvents()) t = Math.min(t, c.timeStamp);
    a.t0 = t;
    a.hEnd = null;
    // A task posted now runs once this event's handlers are done (unless a frame comes first).
    hc.a = a; hc.port2.postMessage(0);
    poll(a);
  };
  L.last = {};
  for (const t of ["pointerdown", "pointermove", "pointerup", "keydown", "keyup", "wheel", "input"]) addEventListener(t, onInput, { capture: true, passive: true });
  // ---- writes: every non-GET fetch, from the call to its response headers (the server's answer)
  L.writes = [];
  const of = window.fetch;
  window.fetch = function (input, init) {
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const p = of.apply(this, arguments);
    if (method !== "GET") {
      const url = String((input && input.url) || input);
      const w = { path: new URL(url, location.href).pathname, method, t0: performance.now(), t1: null, status: 0 };
      L.writes.push(w);
      p.then((r) => { w.t1 = performance.now(); w.status = r.status; }, () => { w.t1 = performance.now(); w.status = -1; });
    }
    return p;
  };
})();`;

// ---------------------------------------------------------------- driving a tab

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

export class Tab {
  page: Page;
  close: () => Promise<void>;
  mods = 0;
  file = "";
  constructor(t: { page: Page; close: () => Promise<void> }) { this.page = t.page; this.close = t.close; }
  ev<R = any>(js: string, timeout = 60_000): Promise<R> { return this.page.eval<R>(js, timeout); }
  async waitFor(js: string, what: string, ms = 30_000) {
    const t0 = Date.now();
    let last: unknown;
    while (Date.now() - t0 < ms) {
      try { last = await this.ev(js); if (last) return last; } catch (e) { last = (e as Error).message; }
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what} (${JSON.stringify(last)?.slice(0, 160)})`);
  }
  frames(n = 2) { return this.ev(`new Promise((r) => { let k = ${n}; const f = () => (--k <= 0 ? r(1) : requestAnimationFrame(f)); requestAnimationFrame(f); })`); }
  async settle(ms = 60_000) {
    await this.waitFor("window.__canvas && window.__canvas.renderer === 'engine' && window.__canvas.settled() && !window.__canvas.flying", "the engine to settle", ms);
    await this.frames(3);
  }
  async open(base: string, file: string, pageId?: string, settleMs = 120_000) {
    this.file = file;
    await this.page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DSF, mobile: false });
    const seed = pageId ? `try { localStorage.setItem(${JSON.stringify("canvas:page:" + file)}, ${JSON.stringify(JSON.stringify(pageId))}); } catch {}` : "";
    await this.page.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT + seed });
    await this.page.goto(`${base}/?file=${encodeURIComponent(file)}&shell=native`);
    await this.waitFor("window.canvasHost && window.canvasHost.doc && window.__canvas && window.__canvas.renderer !== 'pending'", "the page to load", 60_000);
    const r = await this.ev<string>("window.__canvas.renderer");
    if (r !== "engine") throw new Error(`renderer is ${r} (${await this.ev("window.__canvas.note")}), not the engine`);
    if (settleMs > 0) await this.settle(settleMs);
  }
  async setPage(id: string) {
    if ((await this.ev("window.canvasHost.page")) !== id) await this.ev(`window.canvasHost.setPage(${JSON.stringify(id)})`);
    await this.waitFor(`window.canvasHost.page === ${JSON.stringify(id)}`, `page ${id}`);
    await this.settle();
  }
  async setCam(c: { x: number; y: number; z: number }) { await this.ev(`window.canvasHost.setCam(${JSON.stringify(c)})`); await this.settle(); }
  /** Camera so world rect r sits in the middle of the view at zoom z (at most what fits). */
  async show(r: Rect, z = 1) {
    const zz = Math.min(z, (0.8 * W) / r.w, (0.8 * H) / r.h);
    await this.setCam({ z: zz, x: W / 2 - (r.x + r.w / 2) * zz, y: H / 2 - (r.y + r.h / 2) * zz });
  }
  async fitPage() {
    const r = await this.ev<Rect | null>(`(() => { const h = window.canvasHost; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const id of h.boards.keys()) { const r = h.worldRectOf(id) || (window.__canvas.boardPos(id)); if (!r || !r.w) continue; x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); } for (const el of document.querySelectorAll(".wd[data-id]")) { const r = h.worldRectOf(el.dataset.id); if (!r) continue; x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); } return x0 < Infinity ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null; })()`);
    if (r) await this.show(r, 1);
    return r;
  }
  /** World rect of a layer or card (engine / widget layer). */
  rect(id: string): Promise<Rect | null> { return this.ev(`window.canvasHost.worldRectOf(${JSON.stringify(id)})`); }
  /** Window px of a world point. */
  async toScreen(p: Pt): Promise<Pt> { return this.ev(`(() => { const h = window.canvasHost, c = h.cam; return { x: h.viewBox.l + ${p.x} * c.z + c.x, y: h.viewBox.t + ${p.y} * c.z + c.y }; })()`); }
  async screenRect(id: string): Promise<Rect | null> {
    return this.ev(`(() => { const h = window.canvasHost, c = h.cam, r = h.worldRectOf(${JSON.stringify(id)}); if (!r) return null; return { x: h.viewBox.l + r.x * c.z + c.x, y: h.viewBox.t + r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z }; })()`);
  }
  // ---- input
  mouse(type: string, p: Pt, extra: object = {}) { return this.page.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, modifiers: this.mods, ...extra }); }
  move(p: Pt, held = false) { return this.mouse("mouseMoved", p, held ? { button: "left", buttons: 1 } : { button: "none", buttons: 0 }); }
  down(p: Pt, clickCount = 1) { return this.mouse("mousePressed", p, { button: "left", buttons: 1, clickCount }); }
  up(p: Pt, clickCount = 1) { return this.mouse("mouseReleased", p, { button: "left", buttons: 0, clickCount }); }
  async modKey(name: "meta" | "shift" | "alt", on: boolean) {
    const info = { meta: ["Meta", "MetaLeft", 91], shift: ["Shift", "ShiftLeft", 16], alt: ["Alt", "AltLeft", 18] }[name] as [string, string, number];
    this.mods = on ? this.mods | MOD[name] : this.mods & ~MOD[name];
    await this.page.send("Input.dispatchKeyEvent", { type: on ? "rawKeyDown" : "keyUp", key: info[0], code: info[1], windowsVirtualKeyCode: info[2], modifiers: this.mods });
  }
  async key(key: string, code: string, keyCode: number, text?: string, mods = 0) {
    const m = this.mods | mods;
    await this.page.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: m, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: m });
  }
  char(ch: string) {
    const up = ch.toUpperCase();
    return this.key(ch, /[a-z]/i.test(ch) ? `Key${up}` : ch === "." ? "Period" : ch === " " ? "Space" : "", /[a-z]/i.test(ch) ? up.charCodeAt(0) : ch === "." ? 190 : 32, ch);
  }
  // ---- probes
  /** Arm a probe (a page expression for a function returning what the input should change). */
  arm(probe: string, types?: string[]) { return this.ev(`window.__lat.arm(${probe}, ${JSON.stringify(types ?? null)})`); }
  waitShown(): Promise<Sample> { return this.ev("window.__lat.wait()", 30_000); }
  /** Send `input`, return its input-to-paint sample (null when nothing changed on screen). */
  async measure(probe: string, input: () => Promise<unknown>, types?: string[]) {
    await this.arm(probe, types);
    await input();
    return this.waitShown();
  }
  // ---- writes
  writesMark(): Promise<number> { return this.ev("window.__lat.writes.length"); }
  /** The first write to a path matching `re` after mark `m`, once answered: ms from the last `from` event to the 200. */
  async writeAfter(m: number, re: RegExp, from: "pointerup" | "keydown" | "cmd", ms = 10_000): Promise<{ ms: number | null; path?: string; status?: number }> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const w = await this.ev<{ path: string; t0: number; t1: number | null; status: number; at: number } | null>(`(() => { const ws = window.__lat.writes.slice(${m}).filter((w) => ${re}.test(w.path)); const w = ws[0]; return w ? Object.assign({ at: window.__lat.last[${JSON.stringify(from)}] }, w) : null; })()`);
      if (w && w.t1 !== null) return { ms: w.status >= 200 && w.status < 300 ? w.t1 - w.at : null, path: w.path, status: w.status };
      await sleep(20);
    }
    return { ms: null };
  }
}

// ---------------------------------------------------------------- targets

export type Targets = {
  page: string;           // the page the interactions run on
  move: string;           // an absolutely placed layer (drag-move, resize, select, structure ops, repeat)
  other: string;          // another layer to click (select alternates between the two)
  spacing: string | null; // an auto layout frame with padding
  text: string | null;    // an auto-width text layer
  todo: string | null;    // a to-do card (widget id)
  card: string | null;    // a card to drag
  cardsPage: string | null;
  todoPage?: string | null; // the to-do card's page (default cardsPage)
};

type N = Record<string, any> & { id: string; type: string; children?: N[] };
function walk(n: N, f: (n: N, parent: N | null, depth: number) => void, parent: N | null = null, depth = 0) { f(n, parent, depth); for (const c of n.children ?? []) walk(c, f, n, depth + 1); }
const count = (n: N): number => 1 + (n.children ?? []).reduce((a, c) => a + count(c), 0);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const padOf = (p: unknown): number[] => (num(p) ? [p as number, p as number, p as number, p as number] : Array.isArray(p) ? (p.length === 2 ? [p[0], p[1], p[0], p[1]] : p.length === 4 ? p : [0, 0, 0, 0]) : [0, 0, 0, 0]);

/** Targets on the heaviest page of a real document: the board with the most nodes that places its layers freely. */
function pickTargets(dir: string, pageName?: string, cardsPageName?: string): Targets {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, "document.json"), "utf8")) as { children: N[] };
  const side = JSON.parse(fs.readFileSync(path.join(dir, "widgets.json"), "utf8")) as { pages: { id: string; name: string; boards: string[] }[]; widgets: any[] };
  side.pages ??= [];
  const size = (p: { boards: string[] }) => { const on = new Set(p.boards); return doc.children.filter((b) => on.has(b.id)).reduce((a, b) => a + count(b), 0); };
  const page = side.pages.find((p) => p.name === pageName) ?? [...side.pages].sort((a, b) => size(b) - size(a))[0];
  if (!page) throw new Error("the file has no pages");
  const onPage = new Set(page.boards);
  const boards = doc.children.filter((b) => onPage.has(b.id) && b.type === "frame");
  const free = boards.filter((b) => b.layout === "none").sort((a, b) => count(b) - count(a));
  const host = free[0];
  if (!host) throw new Error(`no freely placed board on page ${page.id}`);
  const okLayer = (c: N) => ["frame", "rectangle", "group"].includes(c.type) && num(c.x) && num(c.y) && num(c.width) && num(c.height) && c.width >= 60 && c.height >= 60 && c.width <= 900 && c.height <= 900 && !c.rotation;
  const layers = (host.children ?? []).filter(okLayer).sort((a, b) => count(b) - count(a));
  if (layers.length < 2) throw new Error(`no layers to drag on ${host.name}`);
  let spacing: string | null = null, text: string | null = null;
  // An auto layout frame with padding of 16 or more on every side, laid out by a freely placed parent.
  for (const b of [host, ...boards]) {
    walk(b, (n, parent, depth) => {
      if (spacing || n.type !== "frame" || depth === 0 || !parent || (parent.layout !== "none")) return;
      if (n.layout !== "vertical" && n.layout !== "horizontal") return;
      const p = padOf(n.padding);
      if (Math.min(...p) >= 16 && (n.children ?? []).length >= 2 && num(n.width) && n.width >= 200 && n.width <= 1400) spacing = n.id;
    });
    if (spacing) break;
  }
  walk(host, (n, parent) => {
    if (text || n.type !== "text" || !parent || parent.layout !== "none" || n.textGrowth || typeof n.content !== "string" || n.content.length > 40 || n.content.length < 3) return;
    if (num(n.fontSize) && n.fontSize >= 14) text = n.id;
  });
  const cardsOf = (p: { id: string }) => side.widgets.filter((w) => w.page === p.id).length;
  const cardsPage = side.pages.find((p) => p.name === cardsPageName) ?? ([...side.pages].sort((a, b) => cardsOf(b) - cardsOf(a)).find((p) => cardsOf(p) > 0) ?? null);
  const cardsOn = side.widgets.filter((w) => cardsPage && w.page === cardsPage.id);
  // A to-do card with items: on the cards page, else on any page.
  const hasItems = (w: any) => w.kind === "todo" && (w.config?.items ?? []).length > 0 && side.pages.some((p) => p.id === w.page);
  const todo = cardsOn.find(hasItems) ?? side.widgets.find(hasItems);
  const card = cardsOn.find((w) => w.kind === "note") ?? cardsOn.find((w) => w.kind !== "todo");
  return { page: page.id, move: layers[0].id, other: layers[1].id, spacing, text, todo: todo ? `widget:${todo.id}` : null, todoPage: todo ? todo.page : null, card: card ? `widget:${card.id}` : null, cardsPage: cardsPage?.id ?? null };
}

// ---------------------------------------------------------------- scenarios

/** 120 Hz wheel input for `ms`: pan (deltaX/deltaY) or ctrl+wheel zoom; returns the frames recorded during it. */
export async function wheelFrames(t: Tab, kind: "pan" | "zoom", ms = 3000) {
  const n = Math.round(ms / (1000 / 120));
  const C = { x: W / 2, y: H / 2 };
  await t.ev("window.__lat.startFrames()");
  const t0 = performance.now();
  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const wait = t0 + i * (1000 / 120) - performance.now();
    if (wait > 0) await sleep(wait);
    let dx = 0, dy = 0, modifiers = 0;
    if (kind === "pan") { const dir = Math.floor(i / (n / 4)) % 2 ? -1 : 1; dx = 10 * dir; dy = 4 * dir; } // 1200 px/s, there and back twice
    else { modifiers = MOD.ctrl; dy = i < n / 2 ? -1.2 : 1.2; } // in, then out again (exp(-dy * 0.01) per event)
    pending.push(t.page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: C.x, y: C.y, deltaX: dx * DSF, deltaY: dy * DSF, modifiers }).catch(() => {}));
  }
  await Promise.all(pending);
  await sleep(200);
  const all = await t.ev<{ b: number; e: number; cpu: number | null; gpu: number | null; tiles: number | null; cam: string }[]>("window.__lat.stopFrames()");
  // The frames that moved the camera (the gesture), not the idle ones around it.
  return all.filter((f, i) => i > 0 && f.cam !== all[i - 1].cam);
}

export async function frameScenario(t: Tab, file: string, label: string) {
  for (const kind of ["pan", "zoom"] as const) {
    await t.fitPage();
    // A warm-up gesture first: the first one after a fit renders the tiles of new scales.
    await wheelFrames(t, kind, 600);
    await t.settle();
    const fr = await wheelFrames(t, kind, 3000);
    await t.settle();
    const work = fr.map((f) => f.e - f.b);
    const deltas = fr.slice(1).map((f, i) => f.b - fr[i].b);
    const dropped = deltas.filter((d) => d > FRAME_MS * 1.5).length;
    const gpu = fr.map((f) => f.gpu).filter((g): g is number => typeof g === "number" && g > 0);
    const gs = summary(gpu);
    const over120 = work.filter((w) => w > FRAME_120).length;
    addLine("frame", file, `${kind} ${label}`, work, `${over120}/${work.length} over 8.3; ${dropped} dropped; gpu p95 ${gs.p95}`, { over120, dropped, gpu: gs, frames: work.length });
  }
}

export async function selectScenario(t: Tab, file: string, tg: Targets) {
  const a = await t.rect(tg.move), b = await t.rect(tg.other);
  if (!a || !b) { addLine("input", file, "select by click", [], "targets not drawn"); return; }
  const u = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) };
  await t.show(u, 1);
  const probe = `() => { const s = window.canvasHost.selection().join(","); const e = document.getElementById("sel"); return s + "|" + (e ? e.style.cssText.length + ":" + e.getBoundingClientRect().left : ""); }`;
  const xs: number[] = []; let missed = 0;
  for (let i = 0; i < 20; i++) {
    const r = await t.screenRect(i % 2 ? tg.other : tg.move);
    const p = { x: r!.x + r!.w / 2, y: r!.y + r!.h / 2 };
    await t.move(p);
    const s = await t.measure(probe, async () => { await t.down(p); await t.up(p); }, ["pointerdown"]);
    if (!take(xs, s)) missed++;
    await sleep(60);
  }
  addLine("input", file, "select by click", xs, "", undefined, { missed });
}

/** Press at `from`, then `steps` moves of (dx, dy) each, measured one by one; release. Returns samples + write. */
async function dragMeasured(t: Tab, from: Pt, dx: number, dy: number, steps: number, probe: string, write: RegExp | null, opts: { meta?: boolean } = {}) {
  const xs: number[] = []; let missed = 0;
  await t.move(from);
  await t.down(from);
  await sleep(30);
  // Past the drag threshold first (not measured: the first move starts the gesture).
  let p = { x: from.x + dx * 2, y: from.y + dy * 2 };
  await t.move(p, true);
  await t.frames(2);
  if (opts.meta) await t.modKey("meta", true);
  for (let i = 0; i < steps; i++) {
    p = { x: p.x + dx, y: p.y + dy };
    const q = p;
    const s = await t.measure(probe, () => t.move(q, true), ["pointermove"]);
    if (!take(xs, s)) { missed++; if (process.env.LATENCY_VERBOSE) console.log(`    step ${i} did not show: ${JSON.stringify(s)}`); }
  }
  const m = await t.writesMark();
  await t.up(p);
  if (opts.meta) await t.modKey("meta", false);
  const w = write ? await t.writeAfter(m, write, "pointerup", 3000) : { ms: null };
  if (write && w.ms === null && process.env.LATENCY_VERBOSE) console.log(`    no write ${write}: ${JSON.stringify(await t.ev(`window.__lat.writes.slice(${m}).map((w) => w.method + " " + w.path + " " + w.status)`))}`);
  await t.frames(2);
  return { xs, missed, write: w };
}

export async function moveScenario(t: Tab, file: string, tg: Targets) {
  const r = await t.rect(tg.move);
  if (!r) return;
  await t.show({ x: r.x - 200, y: r.y - 200, w: r.w + 400, h: r.h + 400 }, 1);
  await t.ev(`window.canvasHost.setSelection(${JSON.stringify([tg.move])})`);
  await t.frames(3);
  // The layer, or the copy of it the drag carries when it is lifted out of a clipping frame (shortcuts.js ghost).
  const probe = `() => { const r = window.canvasHost.worldRectOf(${JSON.stringify(tg.move)}), e = window.__canvas.engine, g = e && e.nodeRect("\\u0000dup-ghost"); return [r && Math.round(r.x * 4), r && Math.round(r.y * 4), g && Math.round(g.x * 4), g && Math.round(g.y * 4)]; }`;
  const all: number[] = [], writes: number[] = []; let missed = 0;
  for (let k = 0; k < 8; k++) {
    const s = await t.screenRect(tg.move);
    const c = { x: s!.x + s!.w / 2, y: s!.y + s!.h / 2 };
    const dir = k % 2 ? -1 : 1;
    const d = await dragMeasured(t, c, 5 * dir, 2 * dir, 12, probe, /^\/api\/(move|structure|place|reparent)/, { meta: true });
    all.push(...d.xs); missed += d.missed;
    if (d.write.ms !== null) writes.push(d.write.ms);
    await t.settle();
  }
  addLine("input", file, "drag-move a layer (per move)", all, "", undefined, { missed });
  addLine("write", file, "move (release to 200)", writes);
}

export async function resizeScenario(t: Tab, file: string, tg: Targets) {
  const r = await t.rect(tg.move);
  if (!r) return;
  await t.show({ x: r.x - 200, y: r.y - 200, w: r.w + 400, h: r.h + 400 }, 1);
  await t.ev(`window.canvasHost.setSelection(${JSON.stringify([tg.move])})`);
  await t.frames(3);
  const probe = `() => { const r = window.canvasHost.worldRectOf(${JSON.stringify(tg.move)}); return r ? [Math.round(r.w * 4), Math.round(r.h * 4)] : null; }`;
  const all: number[] = [], writes: number[] = []; let missed = 0, path = "";
  for (let k = 0; k < 8; k++) {
    const s = await t.screenRect(tg.move);
    const corner = { x: s!.x + s!.w - 1, y: s!.y + s!.h - 1 };
    const dir = k % 2 ? -1 : 1;
    const m0 = await t.writesMark();
    const d = await dragMeasured(t, corner, 4 * dir, 3 * dir, 10, probe, /^\/api\//);
    all.push(...d.xs); missed += d.missed;
    if (d.write.ms !== null) { writes.push(d.write.ms); path = d.write.path ?? path; }
    void m0;
    await t.settle();
  }
  addLine("input", file, "resize from a handle (per move)", all, "", undefined, { missed });
  addLine("write", file, `resize (${path || "?"})`, writes);
}

async function spacingScenario(t: Tab, file: string, tg: Targets) {
  if (!tg.spacing) { addLine("input", file, "drag a spacing handle", [], "no auto layout frame with padding"); return; }
  const r = await t.rect(tg.spacing);
  if (!r) { addLine("input", file, "drag a spacing handle", [], "frame not drawn"); return; }
  const node = await t.ev<any>(`fetch(window.canvasHost.api("/api/node") + "&id=" + encodeURIComponent(${JSON.stringify(tg.spacing)}) + "&depth=1").then((r) => r.json()).then((j) => j.node)`);
  const kid = (node?.children ?? []).map((c: any) => c.id).find(Boolean) ?? tg.spacing;
  const padLeft = padOf(node && node.padding)[3] || 8;
  // Zoomed so the left padding zone is 32 px wide on screen, its middle in the middle of the view.
  const zz = Math.min(4, Math.max(1, 32 / padLeft));
  await t.setCam({ z: zz, x: W / 2 - (r.x + padLeft / 2) * zz, y: H / 2 - (r.y + r.h / 2) * zz });
  await t.ev(`window.canvasHost.setSelection(${JSON.stringify([tg.spacing])})`);
  await t.frames(4);
  await sleep(100);
  // Padding moves the frame's children (and a hug frame's size): the first child's rect and the frame's.
  const probe = `() => { const h = window.canvasHost, r = h.worldRectOf(${JSON.stringify(tg.spacing)}), c = h.worldRectOf(${JSON.stringify(kid)}); return [r && Math.round(r.w * 4), r && Math.round(r.h * 4), c && Math.round(c.x * 4), c && Math.round(c.w * 4)]; }`;
  const all: number[] = [], writes: number[] = []; let missed = 0, found = 0;
  for (let k = 0; k < 8; k++) {
    const s = await t.screenRect(tg.spacing);
    const z = await t.ev<number>("window.canvasHost.cam.z");
    // The middle of the left padding zone, halfway down (the frame's outer pixels resize it instead): hover first
    // so the handle is armed, then press on its bar.
    let at: Pt | null = null;
    const midY = Math.max(s!.y + 40, Math.min(s!.y + s!.h - 40, H / 2));
    // The padding as it is now (each drag changes it).
    const now = await t.ev<any>(`fetch(window.canvasHost.api("/api/node") + "&id=" + encodeURIComponent(${JSON.stringify(tg.spacing)}) + "&depth=0").then((r) => r.json()).then((j) => j.node)`);
    const pl = padOf(now && now.padding)[3] || padLeft;
    for (const dy of [0, -60, 60]) {
      const q = { x: s!.x + (pl * z) / 2, y: midY + dy };
      await t.move(q);
      await t.frames(1);
      if ((await t.ev<string>("document.getElementById('view').style.cursor")) === "ew-resize") { at = q; break; }
    }
    if (!at) continue;
    found++;
    const dir = k % 2 ? -1 : 1;
    const d = await dragMeasured(t, at, 2 * dir, 0, 10, probe, /^\/api\/update/);
    all.push(...d.xs); missed += d.missed;
    if (d.write.ms !== null) writes.push(d.write.ms);
    await t.settle();
  }
  addLine("input", file, "drag a spacing handle (per move)", all, found ? "" : "no handle found", undefined, { missed });
  addLine("write", file, "set props (/api/update, spacing)", writes);
}

export async function textScenario(t: Tab, file: string, tg: Targets) {
  if (!tg.text) { addLine("input", file, "type into a text layer", [], "no auto-width text"); return; }
  const r = await t.rect(tg.text);
  if (!r) { addLine("input", file, "type into a text layer", [], "text not drawn"); return; }
  await t.show({ x: r.x - 150, y: r.y - 150, w: r.w + 300, h: r.h + 300 }, 1);
  const xs: number[] = [], writes: number[] = []; let missed = 0;
  const probe = `() => { const r = window.canvasHost.worldRectOf(${JSON.stringify(tg.text)}); return r ? Math.round(r.w * 8) : null; }`;
  for (let k = 0; k < 3; k++) {
    const s = await t.screenRect(tg.text);
    const p = { x: s!.x + Math.min(s!.w - 4, 10), y: s!.y + s!.h / 2 };
    await t.move(p);
    await t.down(p, 1); await t.up(p, 1); await t.down(p, 2); await t.up(p, 2);
    await t.waitFor("window.canvasHost.textEdit && window.canvasHost.textEdit.active", "text editing", 5000).catch(() => null);
    await t.key("End", "End", 35);
    await t.frames(3);
    for (const ch of "latency ok ") {
      const s2 = await t.measure(probe, () => t.char(ch), ["keydown"]);
      if (!take(xs, s2)) missed++;
    }
    const m = await t.writesMark();
    await t.key("Escape", "Escape", 27);
    const w = await t.writeAfter(m, /^\/api\/text/, "keydown");
    if (w.ms !== null) writes.push(w.ms);
    await t.settle();
    // Undo the typing so the layer stays the size it was.
    await t.key("z", "KeyZ", 90, undefined, MOD.meta);
    await sleep(300);
    await t.settle();
  }
  addLine("input", file, "type into a text layer (per key)", xs, "", undefined, { missed });
  addLine("write", file, "text commit (/api/text)", writes);
}

async function todoScenario(t: Tab, file: string, tg: Targets) {
  const todoPage = tg.todoPage ?? tg.cardsPage;
  if (!tg.todo || !todoPage) { addLine("input", file, "toggle a to-do", [], "no to-do card"); return; }
  await t.setPage(todoPage);
  const r = await t.rect(tg.todo);
  if (!r) { addLine("input", file, "toggle a to-do", [], "card not drawn"); return; }
  await t.show({ x: r.x - 100, y: r.y - 100, w: r.w + 200, h: r.h + 200 }, 1);
  await t.waitFor(`!!document.querySelector('.wd[data-id=${JSON.stringify(tg.todo)}] .td-row .cb')`, "the to-do rows", 10_000);
  const xs: number[] = [], writes: number[] = []; let missed = 0;
  const sel = `document.querySelector('.wd[data-id=${JSON.stringify(tg.todo)}] .td-rows .td-row .cb')`;
  for (let k = 0; k < 10; k++) {
    const b = await t.ev<Rect>(`(() => { const e = ${sel}; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const p = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    await t.move(p);
    // The first row's box: whatever it shows changes (the row may move once it settles; the probe is that box's state).
    const probe = `(() => { const e = ${sel}; return () => e.getAttribute("aria-checked"); })()`;
    const m = await t.writesMark();
    const s = await t.measure(probe, async () => { await t.down(p); await t.up(p); }, ["pointerdown"]);
    if (!take(xs, s)) missed++;
    const w = await t.writeAfter(m, /^\/api\/widgets/, "pointerup");
    if (w.ms !== null) writes.push(w.ms);
    await sleep(1100); // the row settles into its section (SETTLE_MS 900)
  }
  addLine("input", file, "toggle a to-do", xs, "", undefined, { missed });
  addLine("write", file, "to-do toggle (/api/widgets)", writes);
}

async function cardScenario(t: Tab, file: string, tg: Targets) {
  if (!tg.card || !tg.cardsPage) { addLine("input", file, "move a card", [], "no card"); return; }
  await t.setPage(tg.cardsPage);
  const r = await t.rect(tg.card);
  if (!r) { addLine("input", file, "move a card", [], "card not drawn"); return; }
  await t.show({ x: r.x - 150, y: r.y - 150, w: r.w + 300, h: r.h + 300 }, 1);
  await t.frames(3);
  const probe = `() => { const e = document.querySelector('.wd[data-id=${JSON.stringify(tg.card)}]'); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left * 4), Math.round(r.top * 4)]; }`;
  const all: number[] = [], writes: number[] = []; let missed = 0;
  for (let k = 0; k < 8; k++) {
    const s = await t.screenRect(tg.card);
    // The card's title row: a press there drags the card (the body may be a text field).
    const at = { x: s!.x + s!.w / 2, y: s!.y + 10 };
    const dir = k % 2 ? -1 : 1;
    const d = await dragMeasured(t, at, 5 * dir, 3 * dir, 10, probe, /^\/api\/widgets/, { meta: true });
    all.push(...d.xs); missed += d.missed;
    if (d.write.ms !== null) writes.push(d.write.ms);
    await t.settle();
  }
  addLine("input", file, "move a card (per move)", all, "", undefined, { missed });
  addLine("write", file, "card move (/api/widgets)", writes);
}

/** Structure ops (Cmd+D, Delete) and Repeat ('.' after an arrow nudge) through the keyboard, release-to-200. */
export async function keyWrites(t: Tab, file: string, tg: Targets) {
  const r = await t.rect(tg.move);
  if (!r) return;
  await t.show({ x: r.x - 300, y: r.y - 300, w: r.w + 600, h: r.h + 600 }, 1);
  const st: number[] = [], rep: number[] = [], nudge: number[] = [];
  for (let k = 0; k < 10; k++) {
    await t.ev(`window.canvasHost.setSelection(${JSON.stringify([tg.move])})`);
    await t.frames(3);
    // Cmd+D is the app's Edit menu: it sends this command (apps/macos/main.swift op("duplicate")).
    let m = await t.writesMark();
    await t.ev("window.__lat.last.cmd = performance.now(); window.canvasCmd({ cmd: 'structure', op: 'duplicate' })");
    let w = await t.writeAfter(m, /^\/api\/structure/, "cmd");
    if (w.ms !== null) st.push(w.ms);
    await t.settle();
    // The copy is selected: delete it (Delete is the page's own key). Never the original.
    const now = await t.ev<string[]>("window.canvasHost.selection()");
    if (now.length !== 1 || now[0] === tg.move) break;
    m = await t.writesMark();
    await t.key("Backspace", "Backspace", 8);
    w = await t.writeAfter(m, /^\/api\/structure/, "keydown");
    if (w.ms !== null) st.push(w.ms);
    await t.settle();
  }
  await t.ev(`window.canvasHost.setSelection(${JSON.stringify([tg.move])})`);
  await t.frames(3);
  for (let k = 0; k < 8; k++) {
    let m = await t.writesMark();
    await t.key("ArrowRight", "ArrowRight", 39);
    let w = await t.writeAfter(m, /^\/api\/move/, "keydown");
    if (w.ms !== null) nudge.push(w.ms);
    await sleep(80);
    m = await t.writesMark();
    await t.key(".", "Period", 190, ".");
    w = await t.writeAfter(m, /^\/api\/repeat/, "keydown");
    if (w.ms !== null) rep.push(w.ms);
    await sleep(80);
  }
  await t.settle();
  addLine("write", file, "structure (/api/structure, Cmd+D, Delete)", st);
  addLine("write", file, "nudge (/api/move, arrow key)", nudge);
  addLine("write", file, "repeat (/api/repeat, '.')", rep);
}

/** From an edit's 200 to the same state on disk (POST /api/flush), edits made over HTTP like the native inspector's. */
export async function flushWrites(srv: Scratch, file: string, label: string, id: string) {
  const a = api(srv.base, file);
  const up: number[] = [], fl: number[] = [];
  const node = await a.get(`/api/node?id=${encodeURIComponent(id)}&depth=0`).catch(() => null);
  const o0 = typeof node?.node?.opacity === "number" ? node.node.opacity : 1;
  for (let k = 0; k < 12; k++) {
    const t0 = performance.now();
    await a.post("/api/update", { file, id, props: { opacity: k % 2 ? o0 : Math.max(0.1, o0 - 0.05) } });
    const t1 = performance.now();
    await a.flush();
    const t2 = performance.now();
    up.push(t1 - t0); fl.push(t2 - t1);
    await sleep(100);
  }
  addLine("write", label, "set props over HTTP (inspector)", up);
  addLine("write", label, "flush to disk (edit 200 to bytes)", fl);
}

/** Page switches (perf.page) and tab switches (perf.show: hidden, then shown again), until fully drawn. */
async function switches(t: Tab, chrome: Chrome, file: string, pages: string[]) {
  const pg: number[] = [];
  for (let k = 0; k < 2; k++) {
    for (const p of pages) {
      const n0 = await t.ev<number>("window.canvasHost.perf.pages");
      await t.ev(`window.canvasHost.setPage(${JSON.stringify(p)})`);
      await t.waitFor(`window.canvasHost.perf.pages > ${n0}`, "the page switch to settle", 60_000);
      pg.push(await t.ev<number>("window.canvasHost.perf.page"));
      await sleep(300);
    }
  }
  addLine("info", file, "page switch (until drawn)", pg);
  // A tab switch: another tab in front (this page goes hidden and stops drawing), then back.
  const sh: number[] = [];
  const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json() as { id: string; url: string; type: string }[];
  const me = targets.find((x) => x.type === "page" && x.url.includes(encodeURIComponent(t.file)));
  for (let k = 0; k < 4; k++) {
    const other = await openTab(chrome.port);
    await fetch(`http://127.0.0.1:${chrome.port}/json/activate/${(await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json()).find((x: any) => x.url === "about:blank")?.id}`);
    const hidden = await t.waitFor("document.hidden", "the page to go hidden", 3000).then(() => true, () => false);
    if (!hidden) { await other.close(); break; }
    await sleep(500);
    const n0 = await t.ev<number>("window.canvasHost.perf.shows");
    await other.close();
    if (me) await fetch(`http://127.0.0.1:${chrome.port}/json/activate/${me.id}`);
    await t.waitFor(`window.canvasHost.perf.shows > ${n0}`, "the tab to show again", 30_000);
    sh.push(await t.ev<number>("window.canvasHost.perf.show"));
  }
  addLine("info", file, "tab switch (until drawn)", sh, sh.length ? "" : "headless Chrome kept the page visible");
}

// ---------------------------------------------------------------- main

async function runFile(chrome: Chrome, srv: Scratch, file: string, label: string, tg: Targets, framePages: { id: string; label: string }[]) {
  const tab = new Tab(await openTab(chrome.port));
  const errors: string[] = [];
  try {
    await tab.open(srv.base, file, tg.page);
    if (want("frame")) for (const p of framePages) { await tab.setPage(p.id); await frameScenario(tab, label, p.label); }
    if (want("input") || want("write")) {
      const steps: [string, (t: Tab, f: string, tg: Targets) => Promise<void>][] = [["select", selectScenario], ["move", moveScenario], ["resize", resizeScenario], ["spacing", spacingScenario], ["text", textScenario], ["keys", keyWrites], ["todo", todoScenario], ["card", cardScenario]];
      for (const [name, fn] of steps) {
        if (ONLY.size && !ONLY.has(name)) continue;
        await tab.setPage(tg.page);
        const s0 = Date.now();
        try { await withTimeout(fn(tab, label, tg), 240_000, name); } catch (e) { console.log(`  ${name} failed: ${(e as Error).message}`); addLine("input", label, `${name} (did not finish)`, [], (e as Error).message.slice(0, 80)); }
        if (process.env.LATENCY_VERBOSE) console.log(`  (${name} ${Math.round((Date.now() - s0) / 1000)} s)`);
      }
    }
    if (want("write")) await flushWrites(srv, file, label, tg.move);
    if (want("info")) await switches(tab, chrome, label, [...new Set([tg.page, ...framePages.map((p) => p.id)])]);
    errors.push(...tab.page.console.filter((l) => l.startsWith("exception")).slice(0, 5));
  } finally {
    await tab.close();
  }
  if (errors.length) console.log(`  page exceptions on ${label}:\n    ${errors.join("\n    ")}`);
  return errors;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-latency-"));
  // Network off for the server: no Keychain secret, no PostHog origin.
  process.env.CANVAS_SECURITY_BIN = "/usr/bin/false";
  process.env.CANVAS_POSTHOG_BASE = "http://127.0.0.1:9";
  let srv: Scratch | undefined, chrome: Chrome | undefined;
  const t0 = Date.now();
  const stop = async () => { await chrome?.stop().catch(() => {}); chrome = undefined; await srv?.stop().catch(() => {}); srv = undefined; fs.rmSync(tmp, { recursive: true, force: true }); };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, async () => { await stop(); process.exit(130); });
  const errors: string[] = [];
  try {
    const jobs: { file: string; label: string; tg: Targets; frames: { id: string; label: string }[] }[] = [];
    if (FILES.has("real") && REAL) {
      if (fs.existsSync(path.join(REAL, "document.json"))) {
        const copy = path.join(tmp, "real.canvas");
        // APFS clone: instant, no space, and the original is never opened for writing.
        fs.cpSync(REAL, copy, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, filter: (s) => !path.basename(s).startsWith(".canvas-") && !path.basename(s).endsWith(".canvas-journal") });
        const tg = pickTargets(copy, process.env.BENCH_FILE_PAGE, process.env.BENCH_FILE_CARDS_PAGE);
        const side = JSON.parse(fs.readFileSync(path.join(copy, "widgets.json"), "utf8"));
        const named = (process.env.BENCH_FILE_FRAME_PAGES || "").split(",").filter(Boolean).map((n) => side.pages.find((p: any) => p.name === n)).filter(Boolean);
        const frames = (named.length ? named : side.pages.filter((p: any) => p.id === tg.page || p.id === tg.cardsPage)).map((p: any, i: number) => ({ id: p.id, label: `page ${i + 1}` }));
        jobs.push({ file: copy, label: "real", tg, frames });
      } else console.log("skip real: BENCH_FILE has no document.json");
    }
    if (FILES.has("fixture")) {
      const f = scratchCopy(fixture(200), tmp, "stress-200.canvas");
      const h = f.heroBoards[0];
      jobs.push({ file: f.dir, label: "fixture", tg: { page: "page-1", move: `${h}-card`, other: `${h}-sq1`, spacing: null, text: `${h}-cap`, todo: null, card: null, cardsPage: null }, frames: [{ id: "page-1", label: "200 boards" }] });
    }
    if (FILES.has("playground")) {
      const copy = path.join(tmp, "playground", "Playground.canvas");
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      copyDir(PLAYGROUND, copy);
      const side = JSON.parse(fs.readFileSync(path.join(copy, "widgets.json"), "utf8"));
      const todo = side.widgets.find((w: any) => w.kind === "todo" && w.page === "cards");
      const card = side.widgets.find((w: any) => w.kind === "posthog" && w.page === "cards");
      jobs.push({ file: copy, label: "playground", tg: { page: "layout", move: "r_free", other: "fr_outer", spacing: "al_col", text: "lay_nest_cap", todo: todo ? `widget:${todo.id}` : null, card: card ? `widget:${card.id}` : null, cardsPage: "cards" }, frames: [{ id: "layout", label: "Layout" }, { id: "cards", label: "Cards" }] });
    }
    srv = await startServer(tmp);
    // Chrome resolves no host name: only 127.0.0.1 (the scratch server) answers.
    chrome = await launchChrome(["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", "--disable-component-update", "--disable-sync"]);
    console.log(`server ${srv.base}, ${chrome.version}, viewport ${W}x${H} @${DSF}x`);
    for (const j of jobs) {
      console.log(`\n${j.label}: ${JSON.stringify(j.tg)}`);
      errors.push(...(await runFile(chrome, srv, j.file, j.label, j.tg, j.frames)));
    }
  } finally {
    await stop();
  }
  // ---- report
  console.log(`\n${"GROUP".padEnd(6)}${"FILE".padEnd(11)}${"WHAT".padEnd(42)}${"N".padStart(4)}${"P50".padStart(8)}${"P95".padStart(8)}${"MAX".padStart(8)}${"BUDGET".padStart(8)}  RESULT`);
  for (const l of lines) console.log(`${l.group.padEnd(6)}${l.file.padEnd(11)}${l.name.slice(0, 41).padEnd(42)}${String(l.n).padStart(4)}${fmt(l.p50).padStart(8)}${fmt(l.p95).padStart(8)}${fmt(l.max).padStart(8)}${(l.budget === null ? "-" : l.budget.toFixed(1)).padStart(8)}  ${l.status}${l.note ? "  " + l.note : ""}`);
  const fails = lines.filter((l) => l.status === "FAIL");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = { at: new Date().toISOString(), budget: BUDGET, viewport: { w: W, h: H, dsf: DSF }, seconds: Math.round((Date.now() - t0) / 1000), pageErrors: errors, lines };
  fs.writeFileSync(path.join(OUT, `latency-${stamp}.json`), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(OUT, "latency-latest.json"), JSON.stringify(out, null, 1));
  console.log(`\n${lines.length - fails.length} of ${lines.length} lines within budget or info, ${fails.length} fail; ${Math.round((Date.now() - t0) / 1000)} s; bench/out/latency-${stamp}.json`);
  process.exitCode = fails.length || errors.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
