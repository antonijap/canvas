// Adversarial stress harness (docs/perf/stress.md). Runs the real server (own process, own port) and the real
// page in headless Chrome with WebGPU, on temp copies and synthetic files only, and reports frame times,
// blank frames, memory, listeners/timers, errors and file integrity per scenario.
//
//   BENCH_PORT=5287 node bench/stress.ts <scenario...> [--out file.json]
//   scenarios: gen cold pinch pan-load page-fly edit-gesture drag50 resize5k media resize-storm theme-zoom
//              hitch synthetic (STRESS_FILES) soak (STRESS_SOAK_MIN, default 30)
//   diagnostics: probe-load (CPU profile of opening STRESS_FILE), probe-leak (detached DOM after page switches),
//              probe-growth (Chrome memory per process type per activity; STRESS_VARIANTS, STRESS_GROWTH_MIN)
//              probe-gpu (page switches only: footprint per Chrome process, engine boards; with STRESS_GPU_PROBE=1
//              every WebGPU buffer/texture made, destroyed and collected, by label; STRESS_GPU_STACKS=1 logs big
//              unlabeled textures; STRESS_LOOP=pages|gest|edits|media|camjs|wheel|idle picks the activity,
//              STRESS_COUNT_REQUESTS=1 counts the page's requests by path)
//
// Never opens a file of yours: the big file is the generated 2,000-board stress file (bench/fixtures/gen.ts), or a
// copy of the .canvas package BENCH_FILE names, made in STRESS_DIR first (default: bench/out/stress); everything
// under that folder is generated and disposable.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

process.env.BENCH_PORT ??= "5287";
const { launchChrome, OUT, PORT, round, sleep, stats, writeSynthetic } = await import("./lib.ts");
const { startHost } = await import("./server.ts");
type Chrome = Awaited<ReturnType<typeof launchChrome>>;

const DIR = process.env.STRESS_DIR ?? path.join(OUT, "stress");
const { fixture } = await import("./fixtures/gen.ts");
/** The big real-world-sized file: BENCH_FILE (a .canvas package of your own, copied) or the 2,000-board fixture. */
const BIG_SRC = () => process.env.BENCH_FILE || fixture(2000).dir;
const VIEW = { w: 1440, h: 900 }, DSF = 2;
const base = `http://127.0.0.1:${PORT}`;
const log = (s: string) => console.error(`[stress] ${s}`);
const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv.splice(outIdx, 2)[1] : path.join(DIR, "stress-results.json");
const wanted = argv.length ? argv : ["cold", "pinch"];
fs.mkdirSync(DIR, { recursive: true });

// ------------------------------------------------------------------ files
export function bigCopy(name = "big.canvas"): string {
  const dest = path.join(DIR, name);
  if (!fs.existsSync(dest)) execFileSync("cp", ["-R", BIG_SRC(), dest]);
  if (!fs.realpathSync(dest).startsWith(fs.realpathSync(DIR))) throw new Error("copy escaped the stress dir");
  return path.join(dest, "document.json");
}
const P = (n: string) => path.join(DIR, n);
const text = (id: string, content: string, fontFamily = "Helvetica", size = 16, weight = "400", extra: object = {}) => ({ type: "text", id, content, fontFamily, fontSize: size, fontWeight: weight, fill: "#18181B", ...extra });
const docOf = (children: unknown[]) => ({ version: "2.21", children });

function genDeep(file: string) {
  // 30 boards, each a 60-level chain of auto-layout frames (alternating axis) with a sibling rect per level.
  const boards = [];
  for (let b = 0; b < 30; b++) {
    let inner: any = text(`d${b}t`, `Depth 60 on board ${b}`, "Helvetica", 12);
    for (let d = 59; d >= 0; d--) {
      inner = { type: "frame", id: `d${b}f${d}`, layout: d % 2 ? "horizontal" : "vertical", gap: 1, padding: 2, fill: d % 3 ? "#F2F2F7" : "#E5E5EA", cornerRadius: 2, children: [inner, { type: "rectangle", id: `d${b}r${d}`, width: 3, height: 3, fill: "#0766EB" }] };
    }
    boards.push({ type: "frame", id: `deep${b}`, name: `Deep ${b}`, x: (b % 6) * 900, y: Math.floor(b / 6) * 900, width: 800, height: 800, fill: "#FFFFFF", layout: "vertical", padding: 10, children: [inner] });
  }
  fs.writeFileSync(file, JSON.stringify(docOf(boards)));
}

const SCRIPTS = [
  ["Helvetica", "The quick brown fox jumps over the lazy dog 0123456789"],
  ["Hiragino Sans", "日本語のテキスト、ひらがなとカタカナ。漢字も混ざる長い文章です。"],
  ["PingFang SC", "简体中文排版测试，标点符号与数字 2026 混排。"],
  ["Apple SD Gothic Neo", "한국어 텍스트 렌더링 시험 문장입니다."],
  ["Geeza Pro", "النص العربي من اليمين إلى اليسار مع أرقام ١٢٣ وكلمات English مختلطة"],
  ["Arial Hebrew", "טקסט בעברית מימין לשמאל עם English באמצע"],
  ["Apple Color Emoji", "👩‍👩‍👧‍👦 🏳️‍🌈 🧑🏽‍🚀 👍🏿 🇭🇷 🫠 ❤️‍🔥"],
  ["Helvetica", "Mixed: café naïve Ελληνικά Русский हिन्दी ไทย 😀 עברית العربية 中文"],
  ["Georgia", "Zalgo z̶͙̓a̸̰͝l̵̢̛g̷̱̕o̴̗͝ combining marks and ligatures ffi fl"],
  ["Menlo", "monospace 0O1lI {}[]() => !== ~~~ ```"],
  ["Inter", "Inter Google font (blocked offline: fallback chain)"],
  ["NoSuchFont", "A family nobody has: fallback"],
];
function genText(file: string) {
  const boards = [];
  for (let b = 0; b < 20; b++) {
    const kids = [];
    for (let i = 0; i < 60; i++) {
      const [fam, s] = SCRIPTS[(i + b) % SCRIPTS.length];
      const long = i % 10 === 0 ? s.repeat(12) : s;
      kids.push(text(`x${b}_${i}`, long, fam, 10 + (i % 7) * 4, ["300", "400", "600", "800"][i % 4], { width: "fill_container", textGrowth: "fixed-width" }));
    }
    boards.push({ type: "frame", id: `txt${b}`, name: `Text ${b}`, x: (b % 5) * 1300, y: Math.floor(b / 5) * 2600, width: 1200, height: 2500, fill: "#FFFFFF", layout: "vertical", gap: 6, padding: 24, children: kids });
  }
  fs.writeFileSync(file, JSON.stringify(docOf(boards)));
}

function genComponents(file: string) {
  const comps = [];
  for (let c = 0; c < 50; c++) {
    comps.push({ type: "frame", id: `cmp${c}`, reusable: true, name: `Comp ${c}`, x: -2000, y: c * 120, layout: "horizontal", gap: 8, padding: 10, cornerRadius: 10, fill: "#E5E5EA", children: [
      { type: "ellipse", id: `cmp${c}e`, width: 24, height: 24, fill: "#0766EB" },
      { type: "frame", id: `cmp${c}c`, layout: "vertical", gap: 2, children: [text(`cmp${c}t`, `Component ${c}`, "Helvetica", 14, "600"), text(`cmp${c}s`, "subtitle", "Helvetica", 11)] },
      ...(c > 0 ? [{ type: "ref", id: `cmp${c}n`, ref: `cmp${c - 1}`, descendants: { [`cmp${c - 1}t`]: { content: `nested in ${c}` } } }] : []),
    ] });
  }
  const boards = [];
  for (let b = 0; b < 20; b++) {
    const kids = [];
    for (let i = 0; i < 100; i++) {
      const c = (b * 7 + i) % 50;
      kids.push({ type: "ref", id: `i${b}_${i}`, ref: `cmp${c % 8}`, descendants: { [`cmp${c % 8}t`]: { content: `Instance ${b}.${i}` }, [`cmp${c % 8}e`]: { fill: i % 2 ? "#FF3B30" : "#34C759" } } });
    }
    boards.push({ type: "frame", id: `cb${b}`, name: `Instances ${b}`, x: (b % 5) * 1700, y: Math.floor(b / 5) * 2400, width: 1600, height: 2300, fill: "#FFFFFF", layout: "horizontal", gap: 8, padding: 16, children: kids, ...{ flexWrap: "wrap" } });
  }
  fs.writeFileSync(file, JSON.stringify(docOf([...comps, ...boards])));
}

function genImages(file: string) {
  // 200 distinct 8192x8192 JPEGs (4 encodes, hard-linked under 200 names: 200 URLs, 200 decodes) on one board,
  // plus 4 boards that each show one of them full size.
  const dir = path.join(path.dirname(file), "img8k");
  fs.mkdirSync(dir, { recursive: true });
  const srcs = [0, 1, 2, 3].map((k) => {
    const f = path.join(dir, `src${k}.jpg`);
    if (!fs.existsSync(f)) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${["testsrc2", "testsrc", "smptehdbars", "rgbtestsrc"][k]}=size=1024x1024:rate=1`, "-vf", "scale=8192:8192:flags=bicubic", "-frames:v", "1", "-q:v", "6", f]);
    return f;
  });
  const kids = [];
  for (let i = 0; i < 200; i++) {
    const f = path.join(dir, `img${i}.jpg`);
    if (!fs.existsSync(f)) fs.linkSync(srcs[i % 4], f);
    kids.push({ type: "rectangle", id: `im${i}`, x: (i % 20) * 410, y: Math.floor(i / 20) * 410, width: 400, height: 400, fill: { type: "image", enabled: true, url: `img8k/img${i}.jpg`, mode: "fill" } });
  }
  const boards: any[] = [{ type: "frame", id: "imgs200", name: "200 images", x: 0, y: 0, width: 8200, height: 4100, fill: "#FFFFFF", layout: "none", children: kids }];
  for (let k = 0; k < 4; k++) boards.push({ type: "frame", id: `full${k}`, name: `Full ${k}`, x: k * 8400, y: 5000, width: 8192, height: 8192, fill: "#FFFFFF", layout: "none", children: [{ type: "rectangle", id: `fi${k}`, x: 0, y: 0, width: 8192, height: 8192, fill: { type: "image", enabled: true, url: `img8k/src${k}.jpg`, mode: "fill" } }] });
  fs.writeFileSync(file, JSON.stringify(docOf(boards)));
}

function genEditable(file: string) {
  // One board with 5,000 absolutely placed children (resize live), and 60 small boards (drag 50 of them).
  const kids = [];
  for (let i = 0; i < 5000; i++) kids.push({ type: "rectangle", id: `k${i}`, x: (i % 100) * 20, y: Math.floor(i / 100) * 20, width: 16, height: 16, fill: i % 3 ? "#0766EB" : "#FF9500", cornerRadius: 3 });
  const boards: any[] = [{ type: "frame", id: "big5k", name: "5k children", x: 0, y: 0, width: 2000, height: 1000, fill: "#FFFFFF", layout: "none", clip: true, children: kids }];
  for (let b = 0; b < 60; b++) boards.push({ type: "frame", id: `s${b}`, name: `Small ${b}`, x: (b % 10) * 220, y: 1200 + Math.floor(b / 10) * 220, width: 200, height: 200, fill: "#FFFFFF", layout: "vertical", padding: 12, children: [text(`s${b}t`, `Small ${b}`, "Helvetica", 18, "600"), { type: "rectangle", id: `s${b}r`, width: 80, height: 40, fill: "#34C759", cornerRadius: 8 }] });
  fs.writeFileSync(file, JSON.stringify(docOf(boards)));
}

function gen() {
  const t = (n: string, f: () => void) => { const t0 = performance.now(); f(); log(`gen ${n} ${round(performance.now() - t0, 0)} ms, ${round(fs.statSync(P(n)).size / 1048576, 1)} MB`); };
  if (!fs.existsSync(P("big500.canvas.json"))) t("big500.canvas.json", () => writeSynthetic(P("big500.canvas.json"), 500, 200));
  if (!fs.existsSync(P("huge60.canvas.json"))) t("huge60.canvas.json", () => writeSynthetic(P("huge60.canvas.json"), 1150, 200));
  if (!fs.existsSync(P("deep60.canvas.json"))) t("deep60.canvas.json", () => genDeep(P("deep60.canvas.json")));
  if (!fs.existsSync(P("text.canvas.json"))) t("text.canvas.json", () => genText(P("text.canvas.json")));
  if (!fs.existsSync(P("components.canvas.json"))) t("components.canvas.json", () => genComponents(P("components.canvas.json")));
  if (!fs.existsSync(P("images.canvas.json"))) t("images.canvas.json", () => genImages(P("images.canvas.json")));
  if (!fs.existsSync(P("edit.canvas.json"))) t("edit.canvas.json", () => genEditable(P("edit.canvas.json")));
}

// ------------------------------------------------------------------ chrome process memory
/** Chrome's processes (the one we launched and every descendant): RSS and CPU seconds. */
function chromeTree(pid: number) {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,time="], { encoding: "utf8" });
  const rows = out.trim().split("\n").map((l) => l.trim().split(/\s+/)).map(([p, pp, rss, t]) => ({ pid: +p, ppid: +pp, rss: +rss * 1024, cpu: cpuSec(t) }));
  const kids = new Map<number, typeof rows>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  const all: typeof rows = [];
  const walk = (p: number) => { for (const k of kids.get(p) ?? []) { all.push(k); walk(k.pid); } };
  const me = rows.find((r) => r.pid === pid);
  if (me) all.push(me);
  walk(pid);
  return { pids: all.map((r) => r.pid), rssMb: round(all.reduce((a, r) => a + r.rss, 0) / 1048576, 0), cpuSec: round(all.reduce((a, r) => a + r.cpu, 0), 2) };
}
function cpuSec(t: string) { const [a, b] = t.split("."); const parts = a.split(":").map(Number); let s = 0; for (const x of parts) s = s * 60 + x; return s + Number(`0.${b ?? 0}`); }
/** phys_footprint over the same processes (what Activity Monitor calls Memory). */
function footprintMb(pids: number[]): number {
  try {
    const out = execFileSync("footprint", ["--noCategories", ...pids.flatMap((p) => ["-p", String(p)])], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    // one process: "Footprint: N MB"; several: "Summary Footprint: N MB" at the end
    const m = /Summary Footprint:\s*([\d.]+)\s*([KMG]B)/i.exec(out) ?? /Footprint:\s*([\d.]+)\s*([KMG]B)/i.exec(out);
    if (!m) return NaN;
    return round(Number(m[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 } as any)[m[2].toUpperCase()], 0);
  } catch { return NaN; }
}

/** phys_footprint per Chrome process type (browser, renderer, gpu-process, utility:<sub>). */
function perProcess(chrome: Chrome): Record<string, number> {
  const tree = chromeTree(chrome.proc.pid!);
  const ps = execFileSync("ps", ["-o", "pid=,command=", "-p", tree.pids.join(",")], { encoding: "utf8" }).trim().split("\n");
  const by: Record<string, number[]> = {};
  for (const l of ps) { const m = /^\s*(\d+)\s+(.*)$/.exec(l); if (!m) continue; const t = /--type=([\w-]+)/.exec(m[2])?.[1] ?? "browser"; const sub = /--utility-sub-type=([\w.]+)/.exec(m[2])?.[1]; (by[sub ? `${t}:${sub.split(".").pop()}` : t] ??= []).push(+m[1]); }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, footprintMb(v)]));
}

// ------------------------------------------------------------------ page driver
// Before the page's own scripts: errors, live timers and intervals, and a frame recorder.
const INSTRUMENT = `(() => {
  const S = window.__st = { errors: [], intervals: new Set(), timeouts: new Set(), rec: null };
  addEventListener("error", (e) => S.errors.push(String(e.message || e)));
  addEventListener("unhandledrejection", (e) => S.errors.push("rejection: " + String(e.reason && (e.reason.message || e.reason))));
  const si = setInterval, ci = clearInterval, st = setTimeout, ct = clearTimeout;
  window.setInterval = function (f, ...a) { const id = si.call(this, f, ...a); S.intervals.add(id); return id; };
  window.clearInterval = function (id) { S.intervals.delete(id); return ci.call(this, id); };
  window.setTimeout = function (f, ...a) { let id; const g = typeof f === "function" ? function (...b) { S.timeouts.delete(id); return f.apply(this, b); } : f; id = st.call(this, g, ...a); S.timeouts.add(id); return id; };
  window.clearTimeout = function (id) { S.timeouts.delete(id); return ct.call(this, id); };
  // Frame recorder: rAF timestamps, and per frame whether any board in the view is blank
  // (not loaded in the engine, or a slot with nothing to show: engine stats tilesBlank).
  S.start = (blank) => {
    const r = S.rec = { t: [], blank: 0, blankFrames: [], unloaded: 0, run: true, t0: performance.now(), maxCpu: 0, cpu: [] };
    const loop = (t) => {
      if (!r.run) return;
      r.t.push(t);
      if (blank && window.__canvas && window.canvasHost && window.canvasHost.cam) {
        const s = window.__canvas.stats();
        if (s) { r.cpu.push(s.frameCpuMs); r.maxUsed = Math.max(r.maxUsed || 0, s.tileBytesUsed >> 20); if (s.tilesBlank > 0) { r.blank++; if (r.blankFrames.length < 40) { if (!r.dbg && s.blankDebug && s.blankDebug.length) r.dbg = s.blankDebug; } if (r.blankFrames.length < 40) r.blankFrames.push([Math.round(t - r.t0), s.tilesBlank, Math.round(window.canvasHost.cam.z * 1000) / 1000, s.tileBytes >> 20, s.tileBytesUsed >> 20, s.tilesMissing]); } }
        const h = window.canvasHost, c = h.cam, ev = h.engineView, vw = innerWidth, vh = innerHeight;
        if (ev) { let un = 0; for (const b of h.boards.values()) { if (b.gone) continue; const m = b.meta, w = (b.w || m.width || 0) * c.z, hh = (b.h || m.height || 0) * c.z, x = m.x * c.z + c.x, y = m.y * c.z + c.y; if (x < vw && y < vh && x + w > 0 && y + hh > 0 && !ev.isLoaded(m.id)) un++; } if (un) r.unloaded++; }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  };
  S.stop = () => { const r = S.rec; r.run = false; return { t: r.t, blank: r.blank, blankFrames: r.blankFrames, unloaded: r.unloaded, cpu: r.cpu, maxUsedMb: r.maxUsed || 0, dbg: r.dbg }; };
})();`;
// probe-gpu: WebGPU objects by kind, created / destroy()ed / garbage-collected without destroy, and the bytes of
// buffers and textures still alive and not destroyed (what the GPU process holds until the JS GC runs).
const GPU_PROBE = `(() => { const process_env_stacks = ${process.env.STRESS_GPU_STACKS ? "true" : "false"};
  if (!window.GPUDevice) return;
  const G = window.__gpu = { kinds: {}, bytes: { buffer: 0, texture: 0 }, gcBytes: { buffer: 0, texture: 0 } };
  const k = (n) => (G.kinds[n] ??= { made: 0, destroyed: 0, gced: 0 });
  const live = new WeakMap();
  const reg = new FinalizationRegistry(({ kind, bytes, id }) => { const e = k(kind); e.gced++; if (bytes && !G.done.has(id)) { G.bytes[kind] -= bytes; G.gcBytes[kind] += bytes; } G.done.delete(id); });
  G.done = new Set(); let next = 0;
  const texBytes = (d) => { const s = d.size; const w = s.width ?? s[0] ?? 1, h = s.height ?? s[1] ?? 1, l = s.depthOrArrayLayers ?? s[2] ?? 1; const bpp = /32float|rgba16/.test(d.format) ? (/rgba32/.test(d.format) ? 16 : 8) : /r8u|r8s|r8unorm$/.test(d.format) ? 1 : 4; return w * h * l * bpp * ((d.mipLevelCount || 1) > 1 ? 1.34 : 1); };
  const wrap = (proto, name, kind, bytesOf) => { const o = proto[name]; proto[name] = function (d, ...a) { const r = o.call(this, d, ...a); const e = k(kind); e.made++; if (kind === "buffer" || kind === "texture") { const lb = kind + ":" + ((d && d.label) || (kind === "texture" ? "?" + (d.size.width ?? d.size[0]) + "x" + (d.size.height ?? d.size[1]) : "?")); const L = (G.labels ??= {}); const x = (L[lb] ??= { n: 0, mb: 0 }); x.n++; x.mb += (bytesOf ? bytesOf(d) : 0) / 1048576; if (process_env_stacks && kind === "texture" && !d.label && (d.size.width ?? d.size[0]) >= 1024) { (G.seq ??= []).push(Math.round(performance.now()) + ":" + (d.size.width ?? d.size[0]) + "x" + (d.size.height ?? d.size[1])); r.__big = true; } } const bytes = bytesOf ? bytesOf(d) : 0; const id = ++next; live.set(r, { id, bytes, kind }); if (bytes) G.bytes[kind] += bytes; reg.register(r, { kind, bytes, id }); return r; }; };
  const D = GPUDevice.prototype;
  wrap(D, "createBuffer", "buffer", (d) => d.size);
  wrap(D, "createTexture", "texture", texBytes);
  for (const [n, kd] of [["createBindGroup", "bindGroup"], ["createCommandEncoder", "encoder"], ["createSampler", "sampler"], ["createShaderModule", "shader"], ["createComputePipeline", "cpipeline"], ["createRenderPipeline", "rpipeline"], ["createBindGroupLayout", "bgl"], ["createPipelineLayout", "pl"], ["createQuerySet", "query"]]) if (D[n]) wrap(D, n, kd);
  const T = GPUTexture.prototype, vo = T.createView; T.createView = function (...a) { const r = vo.apply(this, a); const e = k("view"); e.made++; reg.register(r, { kind: "view", bytes: 0, id: ++next }); return r; };
  for (const [P, kind] of [[GPUBuffer.prototype, "buffer"], [GPUTexture.prototype, "texture"]]) { const d0 = P.destroy; P.destroy = function () { if (this.__big) { (G.seq ??= []).push(Math.round(performance.now()) + ":destroy" + this.width + "x" + this.height); if ((G.dst ??= []).length < 3 && G.seq.length > 4) G.dst.push(new Error().stack); } const m = live.get(this); if (m && !G.done.has(m.id)) { G.done.add(m.id); k(kind).destroyed++; G.bytes[kind] -= m.bytes; } return d0.call(this); }; }
})();`;

type Tab = Awaited<ReturnType<typeof openTab>>;
async function openTab(chrome: Chrome) {
  const { browserContextId } = await chrome.cdp.send("Target.createBrowserContext", {});
  const { targetId } = await chrome.cdp.send("Target.createTarget", { url: "about:blank", browserContextId, width: VIEW.w, height: VIEW.h });
  const { sessionId } = await chrome.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = <T = any>(method: string, params: object = {}) => chrome.cdp.send<T>(method, params, sessionId);
  await s("Page.enable"); await s("Runtime.enable"); await s("Performance.enable", { timeDomain: "timeTicks" });
  await s("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: DSF, mobile: false });
  await s("Network.enable");
  await s("Network.setBlockedURLs", { urls: ["*://fonts.googleapis.com/*", "*://fonts.gstatic.com/*", ...(process.env.STRESS_BLOCK_IMAGES ? ["*/asset?p=*"] : [])] });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  if (process.env.STRESS_GPU_PROBE) await s("Page.addScriptToEvaluateOnNewDocument", { source: GPU_PROBE });
  const exceptions: string[] = [], warnings: string[] = [];
  const off = chrome.cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) warnings.push(`${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
  });
  const ev = async <T = any>(expression: string): Promise<T> => {
    const r = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
    return r.result.value;
  };
  const close = async () => { off(); try { await chrome.cdp.send("Target.closeTarget", { targetId }); await chrome.cdp.send("Target.disposeBrowserContext", { browserContextId }); } catch {} };
  const wheel = (x: number, y: number, dx: number, dy: number, ctrl = false) => s("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx * DSF, deltaY: dy * DSF, modifiers: ctrl ? 2 : 0 });
  const mouse = (type: string, x: number, y: number, extra: object = {}) => s("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: type === "mouseMoved" ? 0 : 1, ...extra });
  return { s, ev, close, wheel, mouse, exceptions, warnings, sessionId };
}

async function open(chrome: Chrome, file: string, query = "") {
  const tab = await openTab(chrome);
  const t0 = performance.now();
  await tab.s("Page.navigate", { url: `${base}/?file=${encodeURIComponent(file)}&shell=native${query}` });
  // engine up, boards in the view drawn, no frames wanted
  let settled = false;
  while (performance.now() - t0 < 120_000) {
    const ok = await tab.ev("!!(window.__canvas && window.__canvas.renderer === 'engine' && window.__canvas.settled())").catch(() => false);
    if (ok) { settled = true; break; }
    await sleep(50);
  }
  const renderer = await tab.ev("window.__canvas && window.__canvas.renderer");
  if (renderer !== "engine") throw new Error(`renderer is ${renderer}, not the engine`);
  return { tab, settleWallMs: round(performance.now() - t0, 0), settled };
}

async function waitSettled(tab: Tab, ms = 60_000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (await tab.ev("window.__canvas.settled()").catch(() => false)) return round(performance.now() - t0, 0); await sleep(50); }
  return null;
}

function frameReport(rec: { t: number[]; blank: number; blankFrames: number[][]; unloaded: number; cpu: number[]; maxUsedMb?: number }) {
  const d: number[] = [];
  for (let i = 1; i < rec.t.length; i++) d.push(rec.t[i] - rec.t[i - 1]);
  const s = stats(d);
  return { frames: rec.t.length, p50: s.p50, p95: s.p95, p99: s.p99, max: s.max, over33: d.filter((x) => x > 34).length, over50: d.filter((x) => x > 50).length, blankFrames: rec.blank, blankAt: rec.blankFrames.slice(0, 8), unloadedFrames: rec.unloaded, tileUsedMaxMb: rec.maxUsedMb, blankDebug: (rec as any).dbg, engineCpu: rec.cpu.length ? stats(rec.cpu) : null };
}
async function measure(tab: Tab, fn: () => Promise<unknown>, blank = true) {
  await tab.ev(`window.__st.start(${blank})`);
  await fn();
  await sleep(100);
  return frameReport(await tab.ev("window.__st.stop()"));
}

async function memory(tab: Tab, chrome: Chrome, gc = false) {
  if (gc) await tab.s("HeapProfiler.collectGarbage");
  const m = Object.fromEntries((await tab.s("Performance.getMetrics")).metrics.map((x: any) => [x.name, x.value]));
  const dom = await tab.s("Memory.getDOMCounters").catch(() => ({}));
  const e = await tab.ev(`(() => { const s = window.__canvas && window.__canvas.stats(); const v = window.canvasVideos && window.canvasVideos.stats ? window.canvasVideos.stats() : null; return { s: s && { tileMB: s.tileBytes / 1048576, imageMB: s.imageBytes / 1048576, effectMB: s.effectBytes / 1048576, wasmMB: s.wasmBytes / 1048576, tiles: s.tileCount, boards: s.boards, nodes: s.nodes, errors: s.errors.length }, cards: v && { cardMB: (v.textureBytes || 0) / 1048576, stagingMB: (v.stagingBytes || 0) / 1048576, playing: v.playing, cards: (v.cards || []).length }, timers: window.__st.timeouts.size, intervals: window.__st.intervals.size, videos: document.querySelectorAll("video").length }; })()`);
  const tree = chromeTree(chrome.proc.pid!);
  return {
    jsHeapMb: round(m.JSHeapUsedSize / 1048576, 1), domNodes: dom.nodes, listeners: dom.jsEventListeners, timers: e.timers, intervals: e.intervals, videos: e.videos,
    engine: e.s && Object.fromEntries(Object.entries(e.s).map(([k, v]) => [k, round(v as number, 1)])), cards: e.cards && Object.fromEntries(Object.entries(e.cards).map(([k, v]) => [k, round(v as number, 1)])),
    chromeRssMb: tree.rssMb, chromeFootprintMb: footprintMb(tree.pids), chromeCpuSec: tree.cpuSec,
  };
}

/** Idle cost: Chrome CPU seconds and page task time over `ms` with nothing happening. */
async function idle(tab: Tab, chrome: Chrome, ms = 10_000) {
  await sleep(1500);
  const m0 = Object.fromEntries((await tab.s("Performance.getMetrics")).metrics.map((x: any) => [x.name, x.value]));
  const c0 = chromeTree(chrome.proc.pid!).cpuSec;
  const raf = await tab.ev(`(() => { const r = window.__idleRaf = { n: 0, run: true }; const l = () => { if (!r.run) return; r.n++; requestAnimationFrame(l); }; return 0; })()`);
  void raf;
  await sleep(ms);
  const m1 = Object.fromEntries((await tab.s("Performance.getMetrics")).metrics.map((x: any) => [x.name, x.value]));
  const c1 = chromeTree(chrome.proc.pid!).cpuSec;
  const frames = await tab.ev("window.__canvas.stats().frames");
  return { pageTaskMsPerSec: round(((m1.TaskDuration - m0.TaskDuration) * 1000) / (ms / 1000), 2), chromeCpuPct: round(((c1 - c0) / (ms / 1000)) * 100, 1), engineFramesTotal: frames };
}

// ------------------------------------------------------------------ gestures
const C = { x: VIEW.w / 2, y: VIEW.h / 2 };
/** ctrl+wheel pinch at 120 Hz from the current zoom by a factor, over ms. */
async function pinch(tab: Tab, factor: number, ms: number, at = C) {
  const n = Math.max(1, Math.round(ms / (1000 / 120)));
  const per = -Math.log(factor) * 100 / n; // the page zooms by exp(-deltaY * 0.01)
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const w = t0 + i * (1000 / 120) - performance.now();
    if (w > 0) await sleep(w);
    void tab.wheel(at.x, at.y, 0, per, true);
  }
}
async function pan(tab: Tab, dx: number, dy: number, ms: number) {
  const n = Math.max(1, Math.round(ms / (1000 / 120)));
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const w = t0 + i * (1000 / 120) - performance.now();
    if (w > 0) await sleep(w);
    void tab.wheel(C.x, C.y, dx / n, dy / n);
  }
}
const zoomOf = (tab: Tab) => tab.ev<number>("window.canvasHost.cam.z");
async function zoomTo(tab: Tab, z: number, ms = 300) { const z0 = await zoomOf(tab); await pinch(tab, z / z0, ms); }

// ------------------------------------------------------------------ server-side helpers
const post = async (p: string, body: object, mcp = false) => {
  const r = await fetch(base + p, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", ...(mcp ? { "x-canvas-source": "mcp", "x-canvas-session": "stress" } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
/** The file on disk parses, ids are unique, and every expectation holds (id -> props subset). */
async function integrity(file: string, expect: Record<string, Record<string, unknown>> = {}, gone: string[] = []) {
  // writes are in the background (src/docwriter.ts): give them a moment, then read the disk
  await sleep(1500);
  const raw = fs.readFileSync(file, "utf8");
  let doc: any;
  try { doc = JSON.parse(raw); } catch (e) { return { ok: false, why: `parse: ${(e as Error).message}` }; }
  const ids = new Map<string, any>(); const dupes: string[] = [];
  const walk = (n: any) => { if (n && typeof n === "object") { if (typeof n.id === "string") { if (ids.has(n.id)) dupes.push(n.id); ids.set(n.id, n); } (n.children ?? []).forEach(walk); } };
  doc.children.forEach(walk);
  const wrong: string[] = [];
  for (const [id, props] of Object.entries(expect)) { const n = ids.get(id); if (!n) { wrong.push(`${id} missing`); continue; } for (const [k, v] of Object.entries(props)) if (JSON.stringify(n[k]) !== JSON.stringify(v)) wrong.push(`${id}.${k}=${JSON.stringify(n[k])} want ${JSON.stringify(v)}`); }
  for (const id of gone) if (ids.has(id)) wrong.push(`${id} still there`);
  return { ok: !dupes.length && !wrong.length, nodes: ids.size, dupes: dupes.slice(0, 5), wrong: wrong.slice(0, 10), bytes: raw.length };
}

// ------------------------------------------------------------------ scenarios
type Ctx = { chrome: Chrome; host: Awaited<ReturnType<typeof startHost>> };
const results: Record<string, unknown> = {};
const errorsOf = async (tab: Tab) => ({ exceptions: tab.exceptions.slice(0, 10), pageErrors: (await tab.ev<string[]>("window.__st.errors")).slice(0, 10), warnings: tab.warnings.filter((w) => !/fonts\.g|ERR_BLOCKED|net::/.test(w)).slice(0, 10), engineErrors: await tab.ev("window.__canvas.stats().errors") });

const SC: Record<string, (c: Ctx) => Promise<unknown>> = {
  async cold({ chrome }) {
    // Time to first board drawn and to the whole viewport, three fresh tabs (first run: cold server cache too),
    // on a copy no other scenario adds cards to.
    const file = bigCopy("big-cold.canvas");
    const runs = [];
    for (let r = 0; r < 3; r++) {
      const tab = await openTab(chrome);
      await tab.ev("0");
      const t0 = performance.now();
      await tab.s("Page.navigate", { url: `${base}/?file=${encodeURIComponent(file)}&shell=native` });
      let first = 0, full = 0;
      while (performance.now() - t0 < 60_000) {
        const st = await tab.ev<any>("(() => { const s = window.__canvas && window.__canvas.renderer === 'engine' && window.__canvas.stats(); return s ? { tiles: s.tileCount, settled: window.__canvas.settled() } : null; })()").catch(() => null);
        if (st && st.tiles > 0 && !first) first = performance.now() - t0;
        if (st && st.settled) { full = performance.now() - t0; break; }
        await sleep(10);
      }
      runs.push({ firstBoardMs: round(first, 0), fullViewportMs: round(full, 0), nav: await tab.ev("(() => { const n = performance.getEntriesByType('navigation')[0]; return { ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd) }; })()") });
      if (r === 2) runs.push({ errors: await errorsOf(tab), mem: await memory(tab, chrome, true) });
      await tab.close();
    }
    return runs;
  },

  async pinch({ chrome }) {
    // Fast pinch 2% <-> 800% repeatedly on the big file, at a board and at the overview.
    const { tab } = await open(chrome, bigCopy());
    const before = await memory(tab, chrome);
    const f = await measure(tab, async () => {
      for (let k = 0; k < 6; k++) { await zoomTo(tab, 0.02, 350); await zoomTo(tab, 8, 450); }
      await zoomTo(tab, 0.5, 300);
    });
    await waitSettled(tab);
    const r = { frames: f, before, after: await memory(tab, chrome), errors: await errorsOf(tab), idle: await idle(tab, chrome, 5000) };
    await tab.close();
    return r;
  },

  async "pan-load"({ chrome }) {
    // Pan the overview of 500 boards / 100k nodes while boards are still loading.
    gen();
    const tab = await openTab(chrome);
    const file = P("big500.canvas.json");
    await tab.s("Page.navigate", { url: `${base}/?file=${encodeURIComponent(file)}&shell=native` });
    while (!(await tab.ev("!!(window.canvasHost && window.canvasHost.cam && window.__canvas.renderer === 'engine')").catch(() => false))) await sleep(20);
    const t0 = performance.now();
    const f = await measure(tab, async () => {
      await zoomTo(tab, 0.03, 200);
      for (let k = 0; k < 4; k++) { await pan(tab, -3000, 0, 1000); await pan(tab, 0, -1500, 500); await pan(tab, 3000, 1500, 1000); }
    });
    const settle = await waitSettled(tab, 120_000);
    const mem = await memory(tab, chrome, true);
    const r = { frames: f, settleAfterMs: settle, wallMs: round(performance.now() - t0, 0), mem, errors: await errorsOf(tab), idle: await idle(tab, chrome, 5000) };
    await tab.close();
    return r;
  },

  async "page-fly"({ chrome }) {
    // Page switches in the middle of fly-to tweens, 30 times; the camera must end valid and the page drawn.
    const { tab } = await open(chrome, bigCopy());
    const pages = await tab.ev<string[]>("window.canvasHost.pages.map((p) => p.id)");
    const f = await measure(tab, async () => {
      for (let k = 0; k < 30; k++) {
        await tab.ev(`(() => { const ids = [...window.canvasHost.boards.keys()]; window.canvasHost.fit(ids[${k} % ids.length]); })()`);
        await sleep(60 + (k % 5) * 30);
        await tab.ev(`window.canvasHost.setPage(${JSON.stringify(pages[k % pages.length])})`).catch(() => null);
        await sleep(40);
      }
    });
    const settle = await waitSettled(tab, 30_000);
    const end = await tab.ev("({ cam: window.canvasHost.cam, page: window.canvasHost.page, flying: window.__canvas.flying, shown: [...window.canvasHost.boards.keys()].filter((id) => window.canvasHost.engineView.isLoaded(id)).length })");
    const r = { frames: f, settle, end, pages, errors: await errorsOf(tab) };
    await tab.close();
    return r;
  },

  async "edit-gesture"({ chrome }) {
    // MCP bursts of 100 set_node_props and structure ops while panning and zooming; the file stays whole.
    const file = bigCopy();
    const { tab } = await open(chrome, file);
    // text nodes on the boards near the view
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const texts: string[] = [], rects: string[] = [];
    const walk = (n: any, top: boolean) => { if (!top && n.type === "text" && typeof n.id === "string") texts.push(n.id); if (!top && n.type === "rectangle") rects.push(n.id); if (n.type !== "ref") (n.children ?? []).forEach((c: any) => walk(c, false)); };
    doc.children.forEach((c: any) => walk(c, true));
    const pick = texts.slice(0, 100);
    const expect: Record<string, Record<string, unknown>> = {};
    const statuses: Record<string, number> = {};
    const tally = (r: { status: number }) => { statuses[r.status] = (statuses[r.status] ?? 0) + 1; };
    let dup: string[] = [];
    const lat: number[] = [];
    const perRound: unknown[] = [];
    const f = await measure(tab, async () => {
      const gesture = (async () => { for (let k = 0; k < 4; k++) { await pan(tab, -1500, -400, 600); await pinch(tab, 0.4, 300); await pinch(tab, 2.5, 300); await pan(tab, 1500, 400, 600); } })();
      for (let round_ = 0; round_ < 3; round_++) {
        await Promise.all(pick.map(async (id, i) => {
          const content = `stress ${round_}.${i}`;
          const t0 = performance.now();
          const r = await post("/api/update", { file, id, props: { content } }, true);
          lat.push(performance.now() - t0);
          tally(r);
          if (r.status === 200) expect[id] = { content };
        }));
        perRound.push(stats(lat.slice(-pick.length)));
        // inspector-style live edits (drawn in the next frame, then written): 20 fill changes on visible nodes
        const vis = process.env.STRESS_NO_INSPECTOR ? [] : await tab.ev<string[]>(`(() => { const h = window.canvasHost, out = []; for (const id of ${JSON.stringify(rects.slice(0, 400))}) { if (h.engineView && h.engineView.boardOf(id) && h.engineView.isLoaded(h.engineView.boardOf(id))) out.push(id); if (out.length >= 20) break; } return out; })()`);
        await Promise.all(vis.map(async (id, i) => {
          const op = 900000 + round_ * 100 + i, fill = ["#FF3B30", "#34C759", "#0766EB"][round_ % 3];
          await tab.ev(`window.canvasHost.emit("cmd", { cmd: "edit", id: ${JSON.stringify(id)}, props: { fill: ${JSON.stringify(fill)} }, op: ${op} })`);
          const r = await post("/api/update", { file, id, props: { fill } });
          tally(r);
          if (r.status === 200) expect[id] = { fill };
          await tab.ev(`window.canvasHost.emit("cmd", { cmd: "editDone", id: ${JSON.stringify(id)}, op: ${op}, ok: ${r.status === 200} })`);
        }));
        // structure: duplicate 5 rects, then delete the copies
        const d = await post("/api/structure", { file, op: "duplicate", ids: rects.slice(round_ * 5, round_ * 5 + 5) });
        tally(d);
        if (d.status === 200) { dup = d.body.select; const del = await post("/api/structure", { file, op: "delete", ids: dup }); tally(del); }
      }
      await gesture;
    });
    await waitSettled(tab, 30_000);
    const disk = await integrity(file, expect, dup);
    // and the page shows the last content: read the scene of the first edited node's board
    const r = { frames: f, writes: statuses, writeLatency: stats(lat), writeLatencyPerRound: perRound, integrity: disk, mem: await memory(tab, chrome), errors: await errorsOf(tab), idle: await idle(tab, chrome, 5000) };
    await tab.close();
    return r;
  },

  async drag50({ chrome }) {
    gen();
    const file = P("edit.canvas.json");
    fs.copyFileSync(P("edit.canvas.json"), P("edit-drag.canvas.json"));
    const f2 = P("edit-drag.canvas.json");
    const { tab } = await open(chrome, f2);
    const ids = Array.from({ length: 50 }, (_, b) => `s${b}`);
    await tab.ev(`(async () => { const r = window.canvasHost.worldRectOf("s0"); window.canvasHost.setCam({ z: 0.45, x: 60 - 0 * 0.45, y: 40 - 1200 * 0.45 }); })()`);
    await waitSettled(tab);
    await tab.ev(`window.canvasHost.setSelection(${JSON.stringify(ids)})`);
    await sleep(400);
    const p0 = await tab.ev<any>(`(() => { const h = window.canvasHost, c = h.cam, r = h.worldRectOf("s5"); return { x: r.x * c.z + c.x + h.viewBox.l + r.w * c.z / 2, y: r.y * c.z + c.y + h.viewBox.t + 10 }; })()`);
    const before = await tab.ev<any>(`window.__canvas.boardPos("s5")`);
    const f = await measure(tab, async () => {
      await tab.mouse("mousePressed", p0.x, p0.y);
      for (let i = 1; i <= 120; i++) { await tab.mouse("mouseMoved", p0.x + i * 3, p0.y + i * 1.5); await sleep(8); }
      await tab.mouse("mouseReleased", p0.x + 360, p0.y + 180);
    });
    await sleep(1500);
    const after = await tab.ev<any>(`window.__canvas.boardPos("s5")`);
    const dx = round(after.x - before.x, 1), dy = round(after.y - before.y, 1);
    const expect: Record<string, Record<string, unknown>> = {};
    for (const id of ids) { const n = JSON.parse(fs.readFileSync(file, "utf8")).children.find((c: any) => c.id === id); expect[id] = { x: n.x + dx, y: n.y + dy }; }
    const r = { frames: f, moved: { dx, dy }, integrity: await integrity(f2, expect), errors: await errorsOf(tab) };
    await tab.close();
    return r;
  },

  async resize5k({ chrome }) {
    gen();
    fs.copyFileSync(P("edit.canvas.json"), P("edit-resize.canvas.json"));
    const file = P("edit-resize.canvas.json");
    const { tab } = await open(chrome, file);
    await tab.ev(`window.canvasHost.setCam({ z: 0.5, x: 80, y: 80 })`);
    await waitSettled(tab);
    await tab.ev(`window.canvasHost.selectId("big5k")`);
    await sleep(600);
    // the bottom-right corner handle of the selection box
    const h = await tab.ev<any>(`(() => { const r = document.getElementById("sel").getBoundingClientRect(); return { x: r.right - 1, y: r.bottom - 1 }; })()`);
    const f = await measure(tab, async () => {
      await tab.mouse("mousePressed", h.x, h.y);
      for (let i = 1; i <= 150; i++) { await tab.mouse("mouseMoved", h.x - i * 2, h.y - i); await sleep(8); }
      await tab.mouse("mouseReleased", h.x - 300, h.y - 150);
    });
    await sleep(1500);
    const disk = JSON.parse(fs.readFileSync(file, "utf8")).children.find((c: any) => c.id === "big5k");
    const r = { frames: f, board: { width: disk.width, height: disk.height, children: disk.children.length }, integrity: await integrity(file, { big5k: { width: disk.width } }), errors: await errorsOf(tab) };
    await tab.close();
    return r;
  },

  async media({ chrome }) {
    // 20 shader cards and 8 video cards in view on a copy of the big file: frames, memory, decoders.
    const file = bigCopy();
    const vid = path.join(DIR, "clip.mp4");
    if (!fs.existsSync(vid)) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "8", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", vid]);
    const existing = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "widgets.json"), "utf8")).widgets.filter((w: any) => w.kind === "shader" || w.kind === "video");
    if (existing.length < 28) {
      for (let i = 0; i < 20; i++) await post(`/api/shaders?file=${encodeURIComponent(file)}`, { x: 30000 + (i % 5) * 420, y: 30000 + Math.floor(i / 5) * 320, w: 400, h: 300, page: "final" });
      for (let i = 0; i < 8; i++) await post(`/api/videos?file=${encodeURIComponent(file)}`, { path: vid, copy: true, x: 30000 + (i % 4) * 520, y: 31400 + Math.floor(i / 4) * 320, w: 500, h: 290, page: "final" });
    }
    // Fresh tab per state, the same zoom: cards in view, then an empty part of the canvas. Chrome's memory is
    // the sum over its processes (renderer, GPU, browser), so the difference is what the cards cost.
    const state = async (cam: object, label: string) => {
      const { tab } = await open(chrome, file);
      await tab.ev(`window.canvasHost.setPage("final")`).catch(() => null);
      await sleep(500);
      await tab.ev(`window.canvasHost.setCam(${JSON.stringify(cam)})`);
      await sleep(12_000);
      const elsBefore = await tab.ev("document.querySelectorAll('video').length");
      const f = await measure(tab, async () => { await sleep(3000); await pan(tab, -200, -100, 800); await pinch(tab, 0.8, 300); await pinch(tab, 1.25, 300); await sleep(1500); }, false);
      await sleep(2000);
      const m = await memory(tab, chrome, true);
      const cs = await tab.ev("(() => { const v = window.canvasVideos && window.canvasVideos.stats(); return v && { playing: v.playing, visible: v.visible, textureMB: Math.round((v.textureBytes||0)/1048576), stagingMB: Math.round((v.stagingBytes||0)/1048576) }; })()");
      const els = await tab.ev("document.querySelectorAll('video').length");
      const e = await errorsOf(tab);
      await tab.close();
      log(`media ${label}: footprint ${m.chromeFootprintMb} MB rss ${m.chromeRssMb} MB, video elements ${elsBefore} -> ${els}`);
      await sleep(3000);
      return { frames: f, mem: m, cards: cs, videoElements: els, videoElementsBeforeGesture: elsBefore, errors: e };
    };
    const z = 0.35; // all 20 shader and 8 video cards on screen at once
    const withMedia = await state({ z, x: 40 - 30000 * z, y: 40 - 30000 * z }, "cards in view");
    const empty = await state({ z, x: 40 - 60000 * z, y: 40 - 60000 * z }, "empty canvas");
    const again = await state({ z, x: 40 - 30000 * z, y: 40 - 30000 * z }, "cards in view (again)");
    return { withMedia, empty, again, deltaFootprintMb: round(Math.min(withMedia.mem.chromeFootprintMb, again.mem.chromeFootprintMb) - empty.mem.chromeFootprintMb, 0), deltaRssMb: round(Math.min(withMedia.mem.chromeRssMb, again.mem.chromeRssMb) - empty.mem.chromeRssMb, 0) };
  },

  async hitch({ chrome }) {
    // Engine hitches (hunt 5): frame CPU while page switches give image levels back over a tight image budget,
    // a devicePixelRatio change, restacking five boards, and a zoom settling on a 5K drawing buffer.
    const { tab } = await open(chrome, bigCopy());
    const pages = await tab.ev<string[]>("window.canvasHost.pages.map((p) => p.id)");
    await tab.ev("window.__canvas.engine.setImageBudget(8 * 1048576)");
    const release = await measure(tab, async () => {
      for (let k = 0; k < 2 * pages.length; k++) {
        await tab.ev(`window.canvasHost.setPage(${JSON.stringify(pages[k % pages.length])})`).catch(() => null);
        await sleep(400);
        await pan(tab, -300, -150, 250);
      }
    });
    await waitSettled(tab);
    await tab.ev("window.__canvas.engine.setImageBudget(192 * 1048576)");
    const ms = (a: number[]) => a.map((x) => round(x, 1));
    const dpr = await tab.ev<any>(`(() => { const e = window.__canvas.engine, c = document.getElementById("engine"), r = [], f = [];
      for (const d of [1, 2, 1, 2]) { let t = performance.now(); e.resize(c.clientWidth, c.clientHeight, d); r.push(performance.now() - t); t = performance.now(); e.frame(); f.push(performance.now() - t); }
      return { resizeMs: r, frameMs: f, boards: e.stats().boards, hidden: e.stats().hiddenBoards }; })()`);
    await waitSettled(tab);
    const restack = await tab.ev<any>(`(() => { const h = window.canvasHost, v = h.engineView, e = v.engine;
      const ids = e.boardsInView().filter((id) => v.isLoaded(id) && v.sceneText(id)).slice(0, 5);
      e.frame();
      const t0 = performance.now();
      if (e.raiseBoards) e.raiseBoards(ids);
      else for (const id of ids) { const p = window.__canvas.boardPos(id); e.removeBoard(id); e.setBoard(id, p.x, p.y, v.sceneText(id)); }
      const t1 = performance.now();
      e.setCamera(h.cam.x, h.cam.y, h.cam.z); e.frame();
      const s = e.stats();
      return { boards: ids.length, api: e.raiseBoards ? "raiseBoards" : "removeBoard+setBoard", restackMs: t1 - t0, frameMs: performance.now() - t1, slotsMissing: s.tilesMissing, slotsBlank: s.tilesBlank }; })()`);
    await waitSettled(tab);
    await tab.s("Emulation.setDeviceMetricsOverride", { width: 2560, height: 1440, deviceScaleFactor: 2, mobile: false });
    await sleep(500);
    await waitSettled(tab);
    await tab.ev(`(() => { const e = window.__canvas.engine, S = window.__h5k = { n: 0, cpu: 0, f0: e.stats().frames, t0: performance.now(), settledAt: null, run: true };
      const loop = () => { if (!S.run) return; const s = e.stats(); S.n += s.tilesRendered; S.cpu = Math.max(S.cpu, s.frameCpuMs); requestAnimationFrame(loop); }; requestAnimationFrame(loop); })()`);
    await zoomTo(tab, 1.2, 300);
    await zoomTo(tab, 0.4, 300);
    await tab.ev(`window.__h5k.t1 = performance.now()`);
    const settledAfterMs = await waitSettled(tab, 8000);
    await sleep(2000);
    const settle5k = await tab.ev<any>(`(() => { const S = window.__h5k, e = window.__canvas.engine, s = e.stats(); S.run = false; const c = document.getElementById("engine");
      return { buffer: [c.width, c.height], engineFrames: s.frames - S.f0, tilesRenderedSum: S.n, frameCpuMaxMs: S.cpu, tileMB: s.tileBytes >> 20, tileBudgetMB: s.tileBudget >> 20, settledNow: window.__canvas.settled() }; })()`);
    settle5k.settledAfterGestureMs = settledAfterMs;
    await tab.s("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: DSF, mobile: false });
    // The GPU device goes away once: the page should be back on the engine, every board in view drawn.
    await waitSettled(tab);
    const errors = await errorsOf(tab);
    await tab.ev("window.__canvas.loseDevice()");
    const tl = performance.now();
    let renderer = "";
    // The loss lands asynchronously (device.lost): wait for the page to see it before waiting for the new engine.
    while (performance.now() - tl < 3000 && (await tab.ev<string>("window.__canvas.renderer")) === "engine") await sleep(10);
    while (performance.now() - tl < 15_000) { renderer = await tab.ev<string>("window.__canvas.renderer"); if (renderer === "dom" || (renderer === "engine" && (await tab.ev("window.__canvas.settled()")))) break; await sleep(50); }
    const loss = { renderer, note: await tab.ev("window.canvasHost.rendererNote"), backMs: round(performance.now() - tl, 0) };
    const r = { release: { ...release, cpu: release.engineCpu }, dpr: { ...dpr, resizeMs: ms(dpr.resizeMs), frameMs: ms(dpr.frameMs) }, restack, settle5k, loss, errors, warningsAfterLoss: tab.warnings.slice(-5), exceptionsAfterLoss: tab.exceptions.slice(-5) };
    await tab.close();
    return r;
  },

  async "resize-storm"({ chrome }) {
    // The window resized 200 times in 4 s (ResizeObserver -> engine.resize), then a pinch.
    const { tab } = await open(chrome, bigCopy());
    const f = await measure(tab, async () => {
      for (let i = 0; i < 200; i++) {
        const w = 800 + Math.round(640 * Math.abs(Math.sin(i / 7))), h = 500 + Math.round(400 * Math.abs(Math.cos(i / 9)));
        await tab.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: i % 40 < 20 ? 2 : 1, mobile: false });
        await sleep(20);
      }
      await tab.s("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: DSF, mobile: false });
      await pinch(tab, 0.3, 400); await pinch(tab, 3, 400);
    });
    await waitSettled(tab);
    const r = { frames: f, mem: await memory(tab, chrome, true), errors: await errorsOf(tab), size: await tab.ev("(() => { const c = document.getElementById('engine'); return [c.width, c.height]; })()") };
    await tab.close();
    return r;
  },

  async "theme-zoom"({ chrome }) {
    const { tab } = await open(chrome, bigCopy());
    const f = await measure(tab, async () => {
      for (let i = 0; i < 20; i++) {
        void tab.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: i % 2 ? "dark" : "light" }] });
        await pinch(tab, i % 2 ? 2 : 0.5, 150);
      }
    });
    await waitSettled(tab);
    const bg = await tab.ev("getComputedStyle(document.getElementById('view')).backgroundColor");
    const r = { frames: f, bg, errors: await errorsOf(tab) };
    await tab.close();
    return r;
  },

  async synthetic({ chrome }) {
    // Each worst-case file: load to settled, zoom out to everything, pinch and pan, memory.
    gen();
    const out: Record<string, unknown> = {};
    for (const name of (process.env.STRESS_FILES ?? "big500,huge60,deep60,text,components,images").split(",")) {
      const file = P(`${name}.canvas.json`);
      log(`synthetic ${name}`);
      const t0 = performance.now();
      let tab: Tab;
      try { ({ tab } = await open(chrome, file)); } catch (e) { out[name] = { error: (e as Error).message }; continue; }
      const loadMs = round(performance.now() - t0, 0);
      const loaded = await memory(tab, chrome);
      const f = await measure(tab, async () => {
        await zoomTo(tab, 0.02, 400);
        await pan(tab, -800, -400, 800);
        await zoomTo(tab, 1, 600);
        await pan(tab, 1200, 600, 1200);
        await zoomTo(tab, 4, 400);
        await zoomTo(tab, 0.05, 500);
      });
      const settle = await waitSettled(tab, 120_000);
      out[name] = { bytes: fs.statSync(file).size, loadMs, frames: f, settleAfterMs: settle, loaded, after: await memory(tab, chrome, true), errors: await errorsOf(tab), idle: await idle(tab, chrome, 4000) };
      await tab.close();
      await sleep(1000);
    }
    return out;
  },

  async "probe-load"({ chrome }) {
    // CPU profile of the first STRESS_PROBE_MS of loading STRESS_FILE (synthetic name or path).
    gen();
    const f0 = process.env.STRESS_FILE ?? "huge60";
    const file = f0.includes("/") ? f0 : P(`${f0}.canvas.json`);
    const tab = await openTab(chrome);
    await tab.s("Profiler.enable"); await tab.s("Profiler.setSamplingInterval", { interval: 500 }); await tab.s("Profiler.start");
    await tab.s("Page.navigate", { url: `${base}/?file=${encodeURIComponent(file)}&shell=native` });
    await sleep(Number(process.env.STRESS_PROBE_MS ?? 20000));
    const prof = (await tab.s("Profiler.stop")).profile;
    const byId = new Map<number, any>(); const parent = new Map<number, number>();
    for (const n of prof.nodes) { byId.set(n.id, n); for (const c of n.children ?? []) parent.set(c, n.id); }
    const key = (n: any) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
    const self = new Map<string, number>(), incl = new Map<string, number>();
    for (let i = 0; i < prof.samples.length; i++) {
      const dt = (prof.timeDeltas[i] ?? 0) / 1000; const n = byId.get(prof.samples[i]);
      self.set(key(n), (self.get(key(n)) ?? 0) + dt);
      const seen = new Set<string>(); let c: number | undefined = n.id;
      while (c !== undefined) { const k = key(byId.get(c)); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + dt); } c = parent.get(c); }
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${round(v, 0)} ${k}`);
    const st = await tab.ev("window.__canvas.stats()").catch(() => null);
    const mr = await tab.ev("window.__canvas.engine && window.__canvas.engine.memoryReport()").catch(() => null);
    await tab.close();
    return { self: top(self), incl: top(incl), boards: st && st.boards, memoryReport: mr };
  },

  async "probe-leak"({ chrome }) {
    // Which action grows listeners / DOM nodes: page switches, media visits, gestures, edits (GC before each read).
    const file = bigCopy();
    const { tab } = await open(chrome, file);
    const pages = await tab.ev<string[]>("window.canvasHost.pages.map((p) => p.id)");
    const read = async () => { await tab.s("HeapProfiler.collectGarbage"); await sleep(300); await tab.s("HeapProfiler.collectGarbage"); const d = await tab.s("Memory.getDOMCounters"); return { nodes: d.nodes, listeners: d.jsEventListeners, docs: d.documents, heapMb: round((await tab.s("Runtime.getHeapUsage")).usedSize / 1048576, 1) }; };
    const out: Record<string, unknown> = { start: await read() };
    for (let i = 0; i < 12; i++) { await tab.ev(`window.canvasHost.setPage(${JSON.stringify(pages[i % pages.length])})`); await sleep(700); }
    out.pageSwitches12 = await read();
    for (let i = 0; i < 12; i++) { await tab.ev(`window.canvasHost.setPage(${JSON.stringify(pages[i % pages.length])})`); await sleep(700); }
    out.pageSwitches24 = await read();
    await tab.ev(`window.canvasHost.setPage("final")`); await sleep(700);
    for (let i = 0; i < 6; i++) { await tab.ev(`window.canvasHost.setCam({ z: 0.35, x: 40 - 30000 * 0.35, y: 40 - 30000 * 0.35 })`); await sleep(2500); await tab.ev(`window.canvasHost.setCam({ z: 0.3, x: 0, y: 0 })`); await sleep(1000); }
    out.mediaVisits6 = await read();
    for (let i = 0; i < 6; i++) { await tab.ev(`window.canvasHost.setCam({ z: 0.35, x: 40 - 30000 * 0.35, y: 40 - 30000 * 0.35 })`); await sleep(2500); await tab.ev(`window.canvasHost.setCam({ z: 0.3, x: 0, y: 0 })`); await sleep(1000); }
    out.mediaVisits12 = await read();
    for (let i = 0; i < 6; i++) { await pinch(tab, 0.3, 300); await pan(tab, -900, -300, 500); await pinch(tab, 4, 400); await pan(tab, 900, 300, 500); }
    out.gestures = await read();
    // Detached elements still alive, by tag and class, and the root they hang from.
    const proto = await tab.s("Runtime.evaluate", { expression: "Element.prototype" });
    const q = await tab.s("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId });
    const sum = await tab.s("Runtime.callFunctionOn", { objectId: q.objects.objectId, functionDeclaration: `function () { const m = {}; for (const el of this) { try { if (el.isConnected) continue; } catch { continue; } let r = el; while (r.parentNode) r = r.parentNode; const k = el.tagName + "." + (el.className && el.className.baseVal === undefined ? el.className : "") + " <- " + (r.tagName || r.nodeName) + "." + (r.className && r.className.baseVal === undefined ? r.className : ""); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 25); }`, returnByValue: true });
    out.detached = sum.result.value ?? sum.exceptionDetails ?? sum;
    out.listenerTypes = await tab.ev(`(() => { const m = {}; for (const el of [document, window, ...document.querySelectorAll("*")]) { const ls = typeof getEventListeners === "function" ? getEventListeners(el) : null; if (!ls) continue; for (const k in ls) m[k] = (m[k] || 0) + ls[k].length; } return m; })()`).catch(() => null);
    await tab.close();
    return out;
  },

  async "probe-gpu"({ chrome }) {
    // Page switches only (STRESS_GROWTH_MIN, default 3), sampled every 30 s: footprint per Chrome process type, WebGPU
    // objects made / destroyed / collected (run with STRESS_GPU_PROBE=1), engine boards and memory, JS heap.
    const file = bigCopy(process.env.STRESS_COPY ?? "big.canvas");
    const { tab } = await open(chrome, file);
    const pages = await tab.ev<string[]>("window.canvasHost.pages.map((p) => p.id)");
    const mins = Number(process.env.STRESS_GROWTH_MIN ?? 3);
    const sample = async (t: number, gc = false) => {
      if (gc) { await tab.s("HeapProfiler.collectGarbage"); await sleep(500); await tab.s("HeapProfiler.collectGarbage"); await sleep(2000); }
      const g = await tab.ev("(() => { const g = window.__gpu; const s = window.__canvas.stats(); return { gpu: g && { kinds: g.kinds, liveMb: { buffer: Math.round(g.bytes.buffer / 1048576), texture: Math.round(g.bytes.texture / 1048576) }, gcMb: { buffer: Math.round(g.gcBytes.buffer / 1048576), texture: Math.round(g.gcBytes.texture / 1048576) } }, boards: s.boards, wasmMb: s.wasmBytes >> 20, tileMb: s.tileBytes >> 20, imageMb: s.imageBytes >> 20 }; })()");
      const heap = round((await tab.s("Runtime.getHeapUsage")).usedSize / 1048576, 1);
      const pm = Object.fromEntries((await tab.s("Performance.getMetrics")).metrics.filter((x: any) => /Nodes|LayoutObjects|Documents|Frames|JSEventListeners|Resources|ContextLifecycle|ArrayBuffer|V8PerContextDatas|WorkerGlobalScopes|UACSSResources|RTCPeerConnections|MediaKeys|AudioHandlers|AudioWorklet/.test(x.name)).map((x: any) => [x.name, x.value]));
      const row = { min: round(t / 60_000, 2), gc, proc: perProcess(chrome), heapMb: heap, pm, ...g, labels: await tab.ev("window.__gpu && window.__gpu.labels"), seq: await tab.ev("window.__gpu && window.__gpu.seq"), dst: await tab.ev("window.__gpu && window.__gpu.dst") };
      log(`gpu ${row.min} min${gc ? " (gc)" : ""}: ${JSON.stringify({ proc: row.proc, heap, boards: g.boards, gpuLive: g.gpu?.liveMb, gpuGc: g.gpu?.gcMb, buf: g.gpu?.kinds.buffer, tex: g.gpu?.kinds.texture, bg: g.gpu?.kinds.bindGroup })}`);
      return row;
    };
    const reqs = new Map<string, number>();
    if (process.env.STRESS_COUNT_REQUESTS) chrome.cdp.on((m) => { if (m.sessionId === tab.sessionId && m.method === "Network.requestWillBeSent") { const u = new URL(m.params.request.url); const k = `${m.params.type} ${u.pathname}${u.pathname === "/asset" ? "" : ""}`; reqs.set(k, (reqs.get(k) ?? 0) + 1); } });
    const rows = [await sample(0, true)];
    const t0 = performance.now();
    let k = 0, next = 30_000;
    const loop = process.env.STRESS_LOOP ?? "pages";
    const texts: string[] = [];
    const walk = (n: any, top: boolean) => { if (!top && n.type === "text" && typeof n.id === "string") texts.push(n.id); if (n.type !== "ref") (n.children ?? []).forEach((c: any) => walk(c, false)); };
    JSON.parse(fs.readFileSync(file, "utf8")).children.forEach((c: any) => walk(c, true));
    while (performance.now() - t0 < mins * 60_000) {
      if (loop === "pages") {
        await tab.ev(`window.canvasHost.setPage(${JSON.stringify(pages[k % pages.length])})`);
        await sleep(Number(process.env.STRESS_SWITCH_MS ?? 1500));
      } else if (loop === "gest" || loop === "edits") {
        await pinch(tab, 0.3, 300); await pan(tab, -900, -300, 500); await pinch(tab, 4, 400); await pan(tab, 900, 300, 500); await pinch(tab, 0.8, 200);
        if (loop === "edits") { const at = (k * 20) % Math.max(1, texts.length - 20); await Promise.all(texts.slice(at, at + 20).map((id, i) => post("/api/update", { file, id, props: { content: `probe ${k}.${i}` } }, true))); }
      } else if (loop === "camjs") {
        // The same camera motion without input events: setCam every frame from the page for 2 s.
        await tab.ev(`new Promise((done) => { const h = window.canvasHost, c0 = { ...h.cam }; const t0 = performance.now(); const step = (t) => { const k = (t - t0) / 2000; if (k >= 1) { h.setCam(c0); return done(1); } const z = c0.z * (1 + 0.6 * Math.sin(k * Math.PI)); h.setCam({ z, x: c0.x - 300 * Math.sin(k * 6.28), y: c0.y }); requestAnimationFrame(step); }; requestAnimationFrame(step); })`);
      } else if (loop === "idle") {
        await sleep(2000);
      } else if (loop === "wheel") {
        // Input events only, on a part of the page that does not move the camera (the left panel).
        for (let i = 0; i < 240; i++) { void tab.wheel(30, 400, 0, 2); await sleep(8); }
      } else if (loop === "media") {
        await tab.ev(`(async () => { if (window.canvasHost.page !== "final") await window.canvasHost.setPage("final"); window.canvasHost.setCam({ z: 0.35, x: 40 - 30000 * 0.35, y: 40 - 30000 * 0.35 }); })()`); await sleep(2500);
        await tab.ev(`window.canvasHost.setCam({ z: 0.3, x: 0, y: 0 })`); await sleep(1000);
      }
      k++;
      if (performance.now() - t0 >= next) { rows.push(await sample(performance.now() - t0)); next += 30_000; }
    }
    rows.push(await sample(performance.now() - t0, true));
    await sleep(30_000);
    rows.push(await sample(performance.now() - t0, true));
    const r = { switches: k, rows, requests: Object.fromEntries([...reqs].sort((a, b) => b[1] - a[1]).slice(0, 30)), errors: await errorsOf(tab) };
    await tab.close();
    return r;
  },

  async "probe-growth"({ chrome }) {
    // Which loop part grows Chrome's memory, per process type: gestures+edits, page switches, media visits.
    const file = bigCopy(process.env.STRESS_COPY ?? "big.canvas");
    const per = () => perProcess(chrome);
    const mins = Number(process.env.STRESS_GROWTH_MIN ?? 4);
    const out: Record<string, unknown> = {};
    for (const variant of (process.env.STRESS_VARIANTS ?? "gest,pages,media").split(",")) {
      const { tab } = await open(chrome, file);
      const pages = await tab.ev<string[]>("window.canvasHost.pages.map((p) => p.id)");
      await sleep(3000);
      await tab.s("HeapProfiler.collectGarbage");
      const a = per();
      const t0 = performance.now();
      let k = 0;
      while (performance.now() - t0 < mins * 60_000) {
        if (variant === "gest") { await pinch(tab, 0.3, 300); await pan(tab, -900, -300, 500); await pinch(tab, 4, 400); await pan(tab, 900, 300, 500); await pinch(tab, 0.8, 200); }
        if (variant === "pages") { await tab.ev(`window.canvasHost.setPage(${JSON.stringify(pages[k % pages.length])})`); await sleep(1500); }
        if (variant === "media") { await tab.ev(`(async () => { if (window.canvasHost.page !== "final") await window.canvasHost.setPage("final"); window.canvasHost.setCam({ z: 0.35, x: 40 - 30000 * 0.35, y: 40 - 30000 * 0.35 }); })()`); await sleep(2500); await tab.ev(`window.canvasHost.setCam({ z: 0.3, x: 0, y: 0 })`); await sleep(1000); }
        k++;
      }
      await tab.s("HeapProfiler.collectGarbage");
      await sleep(3000);
      const b = per();
      const v = await tab.ev("(() => { const s = window.__canvas.stats(); const c = window.canvasVideos && window.canvasVideos.stats(); return { wasmMB: s.wasmBytes >> 20, tileMB: s.tileBytes >> 20, imageMB: s.imageBytes >> 20, cardMB: c ? c.textureBytes >> 20 : 0, stagingMB: c ? c.stagingBytes >> 20 : 0, videos: document.querySelectorAll('video').length }; })()");
      await sleep(30_000);
      await tab.s("HeapProfiler.collectGarbage"); await sleep(1000); await tab.s("HeapProfiler.collectGarbage"); await sleep(5000);
      const c2 = per();
      log(`growth ${variant} 35 s later: ${JSON.stringify(c2)}`);
      out[variant] = { loops: k, before: a, after: b, later: c2, engine: v };
      log(`growth ${variant}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      await tab.close();
      await sleep(3000);
    }
    return out;
  },

  async soak({ chrome, host }) {
    // Scripted zoom/pan/edit loop for STRESS_SOAK_MIN minutes on the big file (+ media cards when the media scenario
    // added them). Samples memory every 30 s; then idle CPU.
    const file = bigCopy();
    const { tab } = await open(chrome, file);
    const mins = Number(process.env.STRESS_SOAK_MIN ?? 30);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const texts: string[] = [];
    const walk = (n: any, top: boolean) => { if (!top && n.type === "text" && typeof n.id === "string") texts.push(n.id); if (n.type !== "ref") (n.children ?? []).forEach((c: any) => walk(c, false)); };
    doc.children.forEach((c: any) => walk(c, true));
    const pages = await tab.ev<string[]>("window.canvasHost.pages.map((p) => p.id)");
    const samples: unknown[] = [];
    const frames: number[] = [];
    let over33 = 0, blank = 0, edits = 0, editFail = 0;
    const expect: Record<string, Record<string, unknown>> = {};
    const t0 = performance.now();
    let next = 0, k = 0;
    while (performance.now() - t0 < mins * 60_000) {
      if (performance.now() - t0 >= next) {
        const m = await memory(tab, chrome, k % 10 === 0);
        const sv = await host.stats(false);
        samples.push({ min: round((performance.now() - t0) / 60_000, 2), ...m, serverHeapMb: round(sv.heapUsed / 1048576, 0), serverRssMb: round(sv.rss / 1048576, 0) });
        log(`soak ${round((performance.now() - t0) / 60000, 1)} min: heap ${m.jsHeapMb} MB, wasm ${m.engine?.wasmMB}, tiles ${m.engine?.tileMB}, chrome ${m.chromeRssMb} MB, listeners ${m.listeners}, timers ${m.timers}`);
        next += 30_000;
      }
      const f = await measure(tab, async () => {
        await pinch(tab, 0.3, 300); await pan(tab, -900, -300, 500); await pinch(tab, 4, 400); await pan(tab, 900, 300, 500); await pinch(tab, 0.8, 200);
        const burst = texts.slice((k * 20) % Math.max(1, texts.length - 20), (k * 20) % Math.max(1, texts.length - 20) + 20);
        await Promise.all(burst.map(async (id, i) => { const content = `soak ${k}.${i}`; const r = await post("/api/update", { file, id, props: { content } }, true); edits++; if (r.status === 200) expect[id] = { content }; else editFail++; }));
        if (k % 8 === 7) { await tab.ev(`window.canvasHost.setPage(${JSON.stringify(pages[(k >> 3) % pages.length])})`).catch(() => null); await sleep(300); }
        // every 4th loop: the media cards (20 shaders, 8 videos on page "final", when the media scenario added them)
        if (k % 4 === 3) { await tab.ev(`(async () => { if (window.canvasHost.page !== "final") await window.canvasHost.setPage("final"); window.canvasHost.setCam({ z: 0.35, x: 40 - 30000 * 0.35, y: 40 - 30000 * 0.35 }); })()`).catch(() => null); await sleep(2500); }
      });
      frames.push(f.p95); over33 += f.over33; blank += f.blankFrames;
      k++;
    }
    const end = await memory(tab, chrome, true);
    const disk = await integrity(file, expect);
    const r = { minutes: mins, loops: k, edits, editFail, frameP95PerLoop: stats(frames), over33, blankFrames: blank, samples, end, integrity: disk, idle: await idle(tab, chrome, 15000), errors: await errorsOf(tab) };
    await tab.close();
    return r;
  },
};

// ------------------------------------------------------------------ main
if (wanted.includes("gen")) { gen(); wanted.splice(wanted.indexOf("gen"), 1); }
if (wanted.length) {
  const host = await startHost();
  const chrome = await launchChrome();
  log(`server pid ${host.proc.pid} port ${PORT}, chrome pid ${chrome.proc.pid} (${chrome.version})`);
  try {
    for (const name of wanted) {
      if (!SC[name]) { log(`unknown scenario ${name}`); continue; }
      log(`run ${name}`);
      const t0 = performance.now();
      try { results[name] = await SC[name]({ chrome, host }); } catch (e) { results[name] = { error: (e as Error).stack }; }
      log(`done ${name} in ${round((performance.now() - t0) / 1000, 1)} s`);
      fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
    }
    results.server = { ...(await host.stats(true)) };
  } finally {
    await chrome.stop();
    host.stop();
  }
  fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
  console.log(JSON.stringify(results, (k, v) => (k === "samples" ? `[${(v as unknown[]).length} samples]` : v), 1));
}
process.exit(0);
