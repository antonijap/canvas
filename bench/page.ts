// Page benchmark: headless Chrome over CDP against the real page served by the real server.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Cdp, launchChrome, OUT, PORT, round, sleep, stats, type BenchFile, type Chrome } from "./lib.ts";

const VIEW = { w: 1440, h: 900 };
// CDP wheel deltas are device pixels; the page sees them divided by the device scale factor, so scale them up to keep the intended CSS-px speed.
const DSF = 2;
const HZ = Number(process.env.BENCH_HZ ?? 120);
const DUR_MS = Number(process.env.BENCH_DUR_MS ?? 5000);

type Meta = { id: string; x: number; y: number; width?: number; height?: number };
type Cam = { x: number; y: number; z: number };

// Runs before the page's own scripts. Collects paint, long tasks, board swaps and a settle detector.
export const INSTRUMENT = (seed: { key: string; cam: Cam } | null) => `(() => {
  const T = window.__bench = { swaps: [], long: [], paint: {}, firstBoardEl: 0, firstBoardPainted: 0, settled: 0, polls: 0, errors: 0 };
  ${seed ? `try { localStorage.setItem(${JSON.stringify(seed.key)}, ${JSON.stringify(JSON.stringify(seed.cam))}); } catch {}` : ""}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) T.long.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) T.paint[e.name] = e.startTime; }).observe({ type: "paint", buffered: true }); } catch {}
  addEventListener("error", () => T.errors++);
  document.addEventListener("DOMContentLoaded", () => {
    T.dcl = performance.now();
    const w = document.getElementById("world");
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "childList") { if (!T.firstBoardEl && m.addedNodes.length) T.firstBoardEl = performance.now(); }
        else if (m.target.className === "cur") {
          const t = performance.now(); T.swaps.push(t);
          if (!T.firstBoardPainted) { T.firstBoardPainted = -1; requestAnimationFrame(() => requestAnimationFrame(() => { T.firstBoardPainted = performance.now(); })); }
        }
      }
    }).observe(w, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    const view = document.getElementById("view");
    // Engine renderer: a board "swap" is the engine taking its new scene (no board DOM exists).
    if (window.canvasHost) window.canvasHost.on("render", () => {
      if (!window.__canvas || window.__canvas.renderer !== "engine") return;
      const t = performance.now(); T.swaps.push(t);
      if (!T.firstBoardPainted) { T.firstBoardPainted = -1; requestAnimationFrame(() => requestAnimationFrame(() => { T.firstBoardPainted = performance.now(); })); }
    });
    let since = 0;
    setInterval(() => {
      T.polls++;
      if (T.resettle) { T.resettle = 0; T.settled = 0; since = 0; }
      if (T.settled) return;
      if (window.__canvas && window.__canvas.renderer !== "dom") {
        const ok = window.__canvas.renderer === "engine" && window.__canvas.settled();
        if (!ok) since = 0; else if (!since) since = performance.now(); else if (performance.now() - since > 300) T.settled = since;
        return;
      }
      const vr = view.getBoundingClientRect(), m = 0.6;
      const L = vr.left - vr.width * m, R = vr.right + vr.width * m, Tp = vr.top - vr.height * m, B = vr.bottom + vr.height * m;
      let need = 0, have = 0;
      for (const b of w.children) {
        const r = b.getBoundingClientRect();
        if (r.left < R && r.right > L && r.top < B && r.bottom > Tp) { need++; if (b.querySelector(":scope>.cur")) have++; }
      }
      const lastSwap = T.swaps.length ? T.swaps[T.swaps.length - 1] : 0;
      const ok = (need > 0 && have === need && !w.querySelector(".next")) || (have > 0 && !w.querySelector(".next") && performance.now() - lastSwap > 600);
      if (!ok) since = 0; else if (!since) since = performance.now(); else if (performance.now() - since > 300) T.settled = since;
    }, 50);
  });
})();`;

const FRAMES_START = `(() => { const f = window.__frames = { t: [], run: true, t0: performance.now() }; const loop = (t) => { f.t.push(t); if (f.run) requestAnimationFrame(loop); }; requestAnimationFrame(loop); })()`;
const FRAMES_STOP = `(() => { window.__frames.run = false; const T = window.__bench; const t0 = window.__frames.t0; return { t: window.__frames.t, t0, long: T.long.filter((l) => l[0] >= t0), swaps: T.swaps.filter((s) => s >= t0).length }; })()`;

function metricsMap(m: { metrics: { name: string; value: number }[] }): Record<string, number> {
  return Object.fromEntries(m.metrics.map((x) => [x.name, x.value]));
}
const diff = (a: Record<string, number>, b: Record<string, number>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, round((b[k] ?? 0) - (a[k] ?? 0), 4)]));

function frameStats(t: number[], long: number[][]) {
  const d: number[] = [];
  for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  const s = stats(d);
  const total = t.length > 1 ? t[t.length - 1] - t[0] : 0;
  const lsum = long.reduce((a, l) => a + l[1], 0);
  return {
    frames: t.length, durationMs: round(total), fps: round(d.length / (total / 1000), 1), delta: s,
    over16_7: d.filter((x) => x > 16.7 * 1.02).length, over25: d.filter((x) => x > 25).length, over50: d.filter((x) => x > 50).length, over100: d.filter((x) => x > 100).length,
    longTasks: long.length, longTaskTotalMs: round(lsum), longTaskMaxMs: round(Math.max(0, ...long.map((l) => l[1]))),
  };
}

// ------------------------------------------------------------- trace + cpu profile summaries
function summarizeTrace(events: any[]) {
  const mainTids = new Set<string>();
  for (const e of events) if (e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain") mainTids.add(`${e.pid}:${e.tid}`);
  const names = ["RunTask", "FunctionCall", "EvaluateScript", "EventDispatch", "TimerFire", "FireAnimationFrame", "UpdateLayoutTree", "Layout", "HitTest", "PrePaint", "Paint", "Layerize", "Commit", "ParseHTML", "UpdateLayerTree", "ScheduleStyleRecalculation"];
  const acc: Record<string, { n: number; ms: number; max: number }> = {};
  for (const e of events) {
    if (e.ph !== "X" || !mainTids.has(`${e.pid}:${e.tid}`) || !names.includes(e.name)) continue;
    const a = (acc[e.name] ??= { n: 0, ms: 0, max: 0 });
    const ms = (e.dur ?? 0) / 1000; a.n++; a.ms += ms; a.max = Math.max(a.max, ms);
  }
  for (const a of Object.values(acc)) { a.ms = round(a.ms); a.max = round(a.max); }
  return { events: events.length, byName: acc };
}

function summarizeProfile(p: any) {
  if (!p?.nodes) return null;
  const byId = new Map<number, any>(); const parent = new Map<number, number>();
  for (const n of p.nodes) { byId.set(n.id, n); for (const c of n.children ?? []) parent.set(c, n.id); }
  const key = (n: any) => `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url ? n.callFrame.url.replace(/^https?:\/\/[^/]+/, "") : ""}:${n.callFrame.lineNumber + 1}`;
  const self = new Map<string, number>(), incl = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000;
    total += dt;
    const n = byId.get(p.samples[i]); if (!n) continue;
    self.set(key(n), (self.get(key(n)) ?? 0) + dt);
    const seen = new Set<string>(); let cur: number | undefined = n.id;
    while (cur !== undefined) { const k = key(byId.get(cur)); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + dt); } cur = parent.get(cur); }
  }
  const top = (m: Map<string, number>, k = 14) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, ms]) => ({ name, ms: round(ms, 1), pct: round((ms / total) * 100, 1) }));
  const idle = (self.get("(idle) :1") ?? 0);
  return { totalMs: round(total), idleMs: round(idle), busyMs: round(total - idle), topSelf: top(self), topInclusive: top(incl) };
}

// ------------------------------------------------------------- scenario driver
async function openTab(chrome: Chrome) {
  const { browserContextId } = await chrome.cdp.send("Target.createBrowserContext", {});
  const { targetId } = await chrome.cdp.send("Target.createTarget", { url: "about:blank", browserContextId, width: VIEW.w, height: VIEW.h });
  const { sessionId } = await chrome.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = <T = any>(method: string, params: object = {}) => chrome.cdp.send<T>(method, params, sessionId);
  await s("Page.enable"); await s("Runtime.enable"); await s("Performance.enable", { timeDomain: "timeTicks" });
  await s("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: DSF, mobile: false });
  await s("Network.enable");
  if (!process.env.BENCH_NET) await s("Network.setBlockedURLs", { urls: ["*://fonts.googleapis.com/*", "*://fonts.gstatic.com/*"] });
  const ev = async (expression: string) => {
    const r = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
    return r.result.value;
  };
  const close = async () => { try { await chrome.cdp.send("Target.closeTarget", { targetId }); await chrome.cdp.send("Target.disposeBrowserContext", { browserContextId }); } catch {} };
  return { s, ev, close, sessionId };
}

async function setCamera(s: (m: string, p?: object) => Promise<any>, ev: (e: string) => Promise<any>, target: Cam) {
  const read = () => ev(`(() => { const m = /translate\\((-?[\\d.e+-]+)px,\\s*(-?[\\d.e+-]+)px\\) scale\\((-?[\\d.e+-]+)\\)/.exec(document.getElementById("world").style.transform); return m ? { x: +m[1], y: +m[2], z: +m[3] } : null; })()`) as Promise<Cam | null>;
  const wheel = (deltaX: number, deltaY: number, modifiers: number) => s("Input.dispatchMouseEvent", { type: "mouseWheel", x: 0, y: 0, deltaX: deltaX * DSF, deltaY: deltaY * DSF, modifiers });
  const c0 = await read(); if (!c0) return null;
  await wheel(0, -Math.log(target.z / c0.z) * 100, 2); // ctrl+wheel: the page zooms by exp(-deltaY * 0.01) about the pointer
  await sleep(50);
  const c1 = (await read())!;
  await wheel(c1.x - target.x, c1.y - target.y, 0); // plain wheel pans by -delta
  await sleep(50);
  return { target, before: c0, after: await read() };
}

async function waitSettled(ev: (e: string) => Promise<any>, timeoutMs = 30_000): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const v = await ev("window.__bench && window.__bench.settled");
    if (v) return v;
    await sleep(100);
  }
  return null;
}

export type ScenarioName = "load-fit" | "enter-overview" | "pan-working" | "zoom-working" | "pan-overview" | "zoom-overview" | "pan-selected";
export const SCENARIOS: ScenarioName[] = ["load-fit", "enter-overview", "pan-working", "zoom-working", "pan-overview", "zoom-overview", "pan-selected"];

function cameras(boards: Meta[]) {
  const xs = boards.map((b) => b.x), ys = boards.map((b) => b.y);
  const x1 = Math.max(...boards.map((b) => b.x + (b.width ?? 1200))), y1 = Math.max(...boards.map((b) => b.y + (b.height ?? 1200)));
  const bx = Math.min(...xs), by = Math.min(...ys), bw = x1 - bx, bh = y1 - by;
  const zo = Math.min(4, Math.max(0.02, Math.min((VIEW.w - 80) / bw, (VIEW.h - 80) / bh)));
  const overview: Cam = { z: zo, x: (VIEW.w - bw * zo) / 2 - bx * zo, y: (VIEW.h - bh * zo) / 2 - by * zo };
  const working: Cam = { z: 0.25, x: 40 - bx * 0.25, y: 40 - by * 0.25 };
  return { overview, working, bbox: { x: bx, y: by, w: bw, h: bh }, axis: bh >= bw * 0.8 ? "y" : "x" };
}

async function dispatchWheels(s: Chrome["cdp"]["send"], sessionId: string, kind: "pan" | "zoom", axis: "x" | "y", bboxLenScreen: number) {
  const rtts: number[] = [];
  const pending: Promise<void>[] = [];
  const step = 1000 / HZ, n = Math.round((DUR_MS / 1000) * HZ);
  const t0 = performance.now();
  let travelled = 0, dir = 1;
  const speed = 1200 / HZ; // 1200 screen px/s, like a brisk trackpad flick
  for (let i = 0; i < n; i++) {
    const target = t0 + i * step;
    const wait = target - performance.now();
    if (wait > 0) await sleep(wait);
    let dx = 0, dy = 0, modifiers = 0;
    if (kind === "pan") {
      travelled += speed; if (travelled > bboxLenScreen) { travelled = 0; dir = -dir; }
      if (axis === "y") dy = speed * dir; else dx = speed * dir;
    } else { modifiers = 2; dy = (i < n / 2 ? -0.6 : 0.6); }
    const sent = performance.now();
    pending.push(s("Input.dispatchMouseEvent", { type: "mouseWheel", x: VIEW.w / 2, y: VIEW.h / 2, deltaX: dx * DSF, deltaY: dy * DSF, modifiers }, sessionId).then(() => { rtts.push(performance.now() - sent); }).catch(() => {}));
  }
  await Promise.all(pending);
  return { rtts, sentMs: performance.now() - t0, events: n };
}

export type HostStats = (gc?: boolean) => Promise<{ heapUsed: number; rss: number; cpuUserMs: number; cpuSystemMs: number }>;
export async function runScenario(chrome: Chrome, file: BenchFile, boards: Meta[], scenario: ScenarioName, opts: { trace: boolean; tag: string; host: HostStats }) {
  const cams = cameras(boards);
  const key = `canvas:${file.path}`;
  const seed = null; // the page always fits the first board on open (see baseline.md), so cameras are set after load
  const tab = await openTab(chrome);
  const { s, ev } = tab;
  const exceptions: string[] = [];
  const off = chrome.cdp.on((m) => { if (m.method === "Runtime.exceptionThrown" && m.sessionId === tab.sessionId) exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT(seed) });
  // count /api/board traffic (the page refetches boards; see docs/perf/baseline.md)
  const reqUrls = new Map<string, number>(); const boardReqs: { t: number; bytes: number }[] = [];
  const offNet = chrome.cdp.on((m) => {
    if (m.sessionId !== tab.sessionId) return;
    if (m.method === "Network.requestWillBeSent" && m.params.request.url.includes("/api/board")) reqUrls.set(m.params.requestId, performance.now());
    if (m.method === "Network.loadingFinished" && reqUrls.has(m.params.requestId)) { boardReqs.push({ t: reqUrls.get(m.params.requestId)!, bytes: m.params.encodedDataLength }); }
  });
  const h0 = await opts.host();
  const url = `http://127.0.0.1:${PORT}/?file=${encodeURIComponent(file.path)}&shell=native${process.env.BENCH_QUERY ?? ""}`;

  const tracing: any[] = [];
  const offTrace = chrome.cdp.on((m) => { if (m.method === "Tracing.dataCollected") tracing.push(...m.params.value); });
  const startTrace = async () => {
    await chrome.cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { recordMode: "recordUntilFull", includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "toplevel", "blink.user_timing", "latencyInfo", "loading"] } });
  };
  const endTrace = async () => {
    const done = new Promise<void>((res) => { const o = chrome.cdp.on((m) => { if (m.method === "Tracing.tracingComplete") { o(); res(); } }); });
    await chrome.cdp.send("Tracing.end");
    await done;
  };
  const startProfile = async () => { await s("Profiler.enable"); await s("Profiler.setSamplingInterval", { interval: 500 }); await s("Profiler.start"); };

  const result: any = { scenario, file: file.label, traced: opts.trace };
  const isLoad = scenario === "load-fit";
  const tracedLoad = opts.trace && (isLoad || scenario === "enter-overview");
  const mBefore = metricsMap(await s("Performance.getMetrics"));

  if (tracedLoad) { await startTrace(); await startProfile(); }
  const navT0 = performance.now();
  await s("Page.navigate", { url });
  const settledAt = await waitSettled(ev);
  result.navigateToSettledWallMs = round(performance.now() - navT0);

  const T = await ev("JSON.parse(JSON.stringify(window.__bench))");
  result.load = {
    settledMs: settledAt ? round(settledAt) : null,
    dclMs: round(T.dcl), firstContentfulPaintMs: round(T.paint["first-contentful-paint"] ?? NaN),
    firstBoardInDomMs: round(T.firstBoardEl), firstBoardSwappedMs: T.swaps.length ? round(T.swaps[0]) : null, firstBoardPaintedMs: T.firstBoardPainted > 0 ? round(T.firstBoardPainted) : null,
    lastSwapMs: T.swaps.length ? round(T.swaps[T.swaps.length - 1]) : null, swaps: T.swaps.length,
    longTasks: T.long.length, longTaskTotalMs: round(T.long.reduce((a: number, l: number[]) => a + l[1], 0)), longTaskMaxMs: round(Math.max(0, ...T.long.map((l: number[]) => l[1]))),
    pageErrors: T.errors + exceptions.length,
  };
  await sleep(300);
  result.renderer = await ev(`window.__canvas ? window.__canvas.renderer + (window.__canvas.note ? " (" + window.__canvas.note + ")" : "") : "dom"`);
  const dom = await ev(`({ nodes: document.getElementsByTagName("*").length, boards: document.querySelectorAll("#world>.board").length, loadedBoards: document.querySelectorAll("#world>.board>.cur").length, svg: document.getElementsByTagName("svg").length, img: document.images.length, cam: document.getElementById("z100") && document.getElementById("z100").textContent, dataIds: document.querySelectorAll("[data-id]").length })`);
  await s("HeapProfiler.collectGarbage");
  const mAfter = metricsMap(await s("Performance.getMetrics"));
  result.dom = dom;
  result.metrics = {
    jsHeapUsedMb: round(mAfter.JSHeapUsedSize / 1048576, 1), jsHeapTotalMb: round(mAfter.JSHeapTotalSize / 1048576, 1), domNodesMetric: mAfter.Nodes, documents: mAfter.Documents, layoutObjectsApprox: mAfter.LayoutObjects,
    ...diff(mBefore, mAfter, ["LayoutCount", "RecalcStyleCount", "LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration"]),
  };

  const finishLoadTrace = async () => {
    const prof = await s("Profiler.stop"); await s("Profiler.disable");
    await endTrace();
    result.profile = summarizeProfile(prof.profile);
    fs.writeFileSync(path.join(OUT, `${opts.tag}.cpuprofile`), JSON.stringify(prof.profile));
    writeTrace(path.join(OUT, `${opts.tag}.json`), tracing);
    result.trace = summarizeTrace(tracing);
  };
  if (opts.trace && isLoad) await finishLoadTrace();

  if (!isLoad) {
    // move the camera (the page restores nothing on load), then wait for the boards in the new view
    const target = scenario === "enter-overview" || scenario.endsWith("-overview") ? cams.overview : cams.working;
    const tCam = await ev("performance.now()");
    const reqB = boardReqs.length, kbB = boardReqs.reduce((a, r) => a + r.bytes, 0);
    const nodesB = (await ev(`document.getElementsByTagName("*").length`)) as number, loadedB = (await ev(`document.querySelectorAll("#world>.board>.cur").length`)) as number;
    const mB = metricsMap(await s("Performance.getMetrics"));
    result.cameraSet = await setCamera(s, ev, target);
    if (process.env.BENCH_DEBUG) console.error("cameraSet", JSON.stringify(result.cameraSet));
    await ev("(() => { window.__bench.resettle = 1; window.__bench.settled = 0; })()");
    const settled2 = await waitSettled(ev);
    if (process.env.BENCH_DEBUG) console.error("settled2", settled2, await ev("JSON.stringify([...document.querySelectorAll('#world>.board')].filter(b=>{const r=b.getBoundingClientRect();return r.right>-864&&r.left<2304&&r.bottom>-540&&r.top<1440}).map(b=>[b.querySelector('.label').textContent,b.getBoundingClientRect().left|0,b.getBoundingClientRect().top|0,b.getBoundingClientRect().width|0,!!b.querySelector(':scope>.cur'),!!b.querySelector('.next')]))"));
    const loadedA = (await ev(`document.querySelectorAll("#world>.board>.cur").length`)) as number;
    const mA = metricsMap(await s("Performance.getMetrics"));
    result.enter = {
      settleMs: settled2 ? round(settled2 - tCam) : null, boardRequests: boardReqs.length - reqB, boardKB: round((boardReqs.reduce((a, r) => a + r.bytes, 0) - kbB) / 1024, 0),
      boardsLoadedBefore: loadedB, boardsLoadedAfter: loadedA, domNodesGrowth: ((await ev(`document.getElementsByTagName("*").length`)) as number) - nodesB,
      ...diff(mB, mA, ["LayoutCount", "RecalcStyleCount", "ScriptDuration", "TaskDuration"]),
    };
    await sleep(300);
    if (tracedLoad) await finishLoadTrace();
  }
  if (scenario.startsWith("pan") || scenario.startsWith("zoom")) {
    if (scenario === "pan-selected") {
      // click a deep node so the selection overlay is live while panning
      const pt = await ev(`(() => { const els = [...document.querySelectorAll("#world [data-id]")]; const vr = document.getElementById("view").getBoundingClientRect();
        for (const e of els) { const r = e.getBoundingClientRect(); if (r.width > 20 && r.height > 6 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && e.parentElement.closest("[data-id]")) return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: e.dataset.id }; }
        // engine renderer: no board DOM; scan with the page's own hit test for a node that is not a board
        const h = window.canvasHost, c = h.cam, boards = h.boards;
        for (let y = vr.top + 80; y < vr.bottom - 40; y += 19) for (let x = vr.left + 80; x < vr.right - 80; x += 19) {
          const id = h.pick(x, y); if (!id || boards.has(id)) continue;
          const w = h.worldRectOf(id); if (w && w.w * c.z > 20 && w.h * c.z > 6) return { x, y, id };
        }
        return null; })()`);
      if (pt) {
        await s("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
        await s("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
        await sleep(600);
      }
      result.selected = pt?.id ?? null;
    }
    // idle baseline: what rAF does when nothing is happening
    const idleT0 = performance.now();
    await ev(FRAMES_START); await sleep(1000);
    const idle = await ev(FRAMES_STOP);
    result.idle = frameStats(idle.t, idle.long);
    result.idle.boardRequestsPerSec = boardReqs.filter((r) => r.t >= idleT0).length;
    const pre = { loaded: dom.loadedBoards, nodes: dom.nodes };
    const reqBefore = boardReqs.length, bytesBefore = boardReqs.reduce((a, r) => a + r.bytes, 0);
    const m0 = metricsMap(await s("Performance.getMetrics"));
    if (opts.trace) { await startTrace(); await startProfile(); }
    await ev(FRAMES_START);
    const kind = scenario.startsWith("zoom") ? "zoom" : "pan";
    const lenScreen = (cams.axis === "y" ? cams.bbox.h : cams.bbox.w) * (scenario.endsWith("-overview") ? cams.overview.z : cams.working.z);
    const w = await dispatchWheels(chrome.cdp.send.bind(chrome.cdp), tab.sessionId, kind, cams.axis as "x" | "y", Math.max(400, lenScreen));
    await sleep(400); // drain pending frames and board loads
    const fr = await ev(FRAMES_STOP);
    const m1 = metricsMap(await s("Performance.getMetrics"));
    // keep only frames inside the input window (drop the drain tail)
    const tEnd = fr.t0 + w.sentMs + 50;
    const win = fr.t.filter((t: number) => t <= tEnd);
    result.interaction = {
      kind, hz: HZ, events: w.events, sentMs: round(w.sentMs), inputRtt: stats(w.rtts), frames: frameStats(win, fr.long.filter((l: number[]) => l[0] <= tEnd)),
      swapsDuring: fr.swaps, perFrame: { layouts: round((m1.LayoutCount - m0.LayoutCount) / win.length, 2), recalcs: round((m1.RecalcStyleCount - m0.RecalcStyleCount) / win.length, 2) },
      ...diff(m0, m1, ["LayoutCount", "RecalcStyleCount", "LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration"]),
    };
    result.engine = await ev(`(() => { const s = window.__canvas && window.__canvas.stats(); if (!s) return null; return { frameCpuMs: s.frameCpuMs, gpuDoneMs: s.gpuDoneMs, tileCount: s.tileCount, tileMB: Math.round(s.tileBytes / 1048576), imageMB: Math.round(s.imageBytes / 1048576), effectMB: Math.round(s.effectBytes / 1048576), wasmMB: Math.round(s.wasmBytes / 1048576), boards: s.boards, nodes: s.nodes }; })()`);
    const post = await ev(`({ nodes: document.getElementsByTagName("*").length, loadedBoards: document.querySelectorAll("#world>.board>.cur").length, cam: document.getElementById("z100").textContent })`);
    result.interaction.boardRequests = boardReqs.length - reqBefore;
    result.interaction.boardKB = round((boardReqs.reduce((a, r) => a + r.bytes, 0) - bytesBefore) / 1024, 0);
    result.domAfter = post; result.domGrowth = { loadedBoards: post.loadedBoards - pre.loaded, nodes: post.nodes - pre.nodes };
    await s("HeapProfiler.collectGarbage");
    result.jsHeapAfterMb = round(metricsMap(await s("Performance.getMetrics")).JSHeapUsedSize / 1048576, 1);
    if (opts.trace) {
      const prof = await s("Profiler.stop"); await s("Profiler.disable");
      await endTrace();
      result.profile = summarizeProfile(prof.profile);
      fs.writeFileSync(path.join(OUT, `${opts.tag}.cpuprofile`), JSON.stringify(prof.profile));
      writeTrace(path.join(OUT, `${opts.tag}.json`), tracing);
      result.trace = summarizeTrace(tracing);
    }
  }
  const h1 = await opts.host();
  result.server = { cpuMs: round(h1.cpuUserMs + h1.cpuSystemMs - h0.cpuUserMs - h0.cpuSystemMs), rssMb: round(h1.rss / 1048576, 0), boardRequestsTotal: boardReqs.length, boardKBTotal: round(boardReqs.reduce((a, r) => a + r.bytes, 0) / 1024, 0) };
  off(); offTrace(); offNet();
  await tab.close();
  return result;
}

function writeTrace(file: string, events: any[]) {
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, '{"traceEvents":[');
  for (let i = 0; i < events.length; i += 2000) fs.writeSync(fd, (i ? "," : "") + events.slice(i, i + 2000).map((e) => JSON.stringify(e)).join(","));
  fs.writeSync(fd, "]}");
  fs.closeSync(fd);
}

export async function pageBench(files: BenchFile[], log: (s: string) => void, host: HostStats, only?: { scenarios?: ScenarioName[] }) {
  const chrome = await launchChrome();
  const out: any = { chrome: { version: chrome.version, exe: chrome.exe, userAgent: chrome.userAgent }, viewport: VIEW, deviceScaleFactor: DSF, wheelHz: HZ, durationMs: DUR_MS, runs: [] as any[] };
  const reps = Number(process.env.BENCH_REPS ?? 1);
  try {
    for (const f of files) {
      const doc = await (await fetch(`http://127.0.0.1:${PORT}/api/doc?file=${encodeURIComponent(f.path)}`)).json() as { boards: Meta[] };
      for (const sc of only?.scenarios ?? SCENARIOS) {
        const loadReps = (sc.startsWith("load") || sc.startsWith("enter")) ? Math.max(3, reps) : reps;
        for (let r = 0; r < loadReps; r++) {
          log(`page ${f.label} ${sc} #${r + 1}`);
          out.runs.push({ ...(await runScenario(chrome, f, doc.boards, sc, { trace: false, tag: "", host })), rep: r + 1 });
        }
        if (!process.env.BENCH_NO_TRACE) {
          log(`page ${f.label} ${sc} trace`);
          const tag = `trace-${f.label}-${sc}`;
          out.runs.push({ ...(await runScenario(chrome, f, doc.boards, sc, { trace: true, tag, host })), rep: 0, tag });
        }
      }
    }
  } finally { await chrome.stop(); }
  return out;
}
