// Golden-image rendering suite: every fixture in fixtures/*.canvas.json is drawn by the engine (engine/pkg, headless
// WebGPU Chrome) and by Chrome's own HTML/CSS rendering of the same nodes (the DOM path, /api/board), at the
// zooms and device scales fixtures/views.json lists. Two checks per view:
//   fidelity:   engine vs Chrome   (YIQ delta with anti-aliasing tolerance, SSIM on luma, largest mismatch blob)
//   regression: engine vs baseline/<fixture>@<view>.png (the engine's own last accepted picture)
//
//   pnpm test:golden [--update] [--only name,name] [--views 1x,2x] [--out dir] [--strict]
// --update writes the baselines. known-gaps.json lists views whose fidelity failure is a known engine gap: they
// are reported but do not fail the run. Exit 1 on a regression, a fidelity failure that is not listed, or an error.
// Built on fidelity/ (cdp.ts, diff.ts, png.ts); no dependencies.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIT_SCRIPT } from "../../src/engine.ts";
import { launchChrome, type Page } from "../../fidelity/cdp.ts";
import { diffImages, sideBySide } from "../../fidelity/diff.ts";
import { decodePng, type Img } from "../../fidelity/png.ts";
import { blobs, crop, encodeCompactPng, seamCheck } from "./metrics.ts";
import { writeReport, type ViewResult } from "./report.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PORT = Number(process.env.GOLDEN_PORT ?? 5263);
const STATIC_PORT = PORT + 1;
if (PORT === 5189 || STATIC_PORT === 5189) throw new Error("port 5189 is the user's Canvas; pick another GOLDEN_PORT");
const BASE = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const only = opt("only")?.split(",");
const onlyViews = opt("views")?.split(",");
const OUT = path.resolve(opt("out") ?? path.join(HERE, "out"));
const BASELINE = path.join(HERE, "baseline");
const FIXTURES = path.join(HERE, "fixtures");

type View = { name: string; zoom: number; dpr: number; x?: number; y?: number; w?: number; h?: number; tiles?: boolean };
type Limits = { mismatchPct: number; ssim: number; blob: number };
/** Fidelity: what counts as "differs meaningfully from Chrome". Blob is in CSS px² (scaled by dpr²). */
const FIDELITY: Limits = { mismatchPct: Number(process.env.GOLDEN_MAX_MISMATCH ?? 0.5), ssim: Number(process.env.GOLDEN_MIN_SSIM ?? 0.985), blob: Number(process.env.GOLDEN_MAX_BLOB ?? 24) };
/** Regression: the same engine on the same GPU draws the same picture; this only absorbs last-bit noise. */
const REGRESSION: Limits = { mismatchPct: 0.02, ssim: 0.999, blob: 6 };

/** Fixtures judged on the seam check alone (their content differs from Chrome for reasons that are not seams). */
const SEAM_ONLY = new Set(["tile-seams"]);

const { views: VIEWS, notes: NOTES } = JSON.parse(fs.readFileSync(path.join(FIXTURES, "views.json"), "utf8")) as { views: Record<string, View[]>; notes: Record<string, string> };
const KNOWN: Record<string, string> = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, "known-gaps.json"), "utf8")); } catch { return {}; } })();
const log = (s: string) => console.log(s);
const t0 = Date.now();

function startStatic(): Promise<http.Server> {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm" };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let local: string | null = null;
    if (url.pathname === "/golden.html") local = path.join(HERE, "engine-page.html");
    else if (url.pathname.startsWith("/engine/pkg/")) local = path.join(ROOT, "engine", "pkg", path.basename(url.pathname));
    if (local) {
      try { res.writeHead(200, { "content-type": types[path.extname(local)] ?? "application/octet-stream", "cache-control": "no-store" }); res.end(fs.readFileSync(local)); }
      catch { res.writeHead(404); res.end("not found"); }
      return;
    }
    try {
      const r = await fetch(BASE + url.pathname + url.search);
      const keep = ["x-font-weight", "x-font-style", "x-font-source"].filter((h) => r.headers.has(h)).map((h) => [h, r.headers.get(h)!] as const);
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/octet-stream", ...Object.fromEntries(keep) });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502); res.end(String(e)); }
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(STATIC_PORT, "127.0.0.1", () => resolve(server)); });
}

const getJson = async (p: string): Promise<any> => {
  for (let i = 0; ; i++) {
    try { return await (await fetch(BASE + p)).json(); } catch (e) { if (i >= 2) throw e; await new Promise((r) => setTimeout(r, 100)); }
  }
};

/** The board as the Canvas page's DOM renderer draws it, at the origin on white. Returns its size in CSS px. */
/**
 * One Chrome tab per device scale, with the scale set before anything loads. Chrome lays text out for the
 * scale that is active at load (line boxes land on whole device pixels) and keeps that layout when the
 * emulated scale changes later, so a tab loaded at 2x and shot at 1x shows half-pixel line positions no
 * 1x screen would. With a shared tab the reference depended on which view ran before.
 */
async function loadTruth(page: Page, file: string, id: string): Promise<{ w: number; h: number; fontsFailed: string[] }> {
  const d = await getJson(`/api/board?file=${encodeURIComponent(file)}&id=${encodeURIComponent(id)}`);
  if (d.error) throw new Error(d.error);
  await page.send("Page.bringToFront");
  const doc = `<!doctype html><meta charset="utf-8">${(d.links ?? []).map((l: string) => `<link rel="stylesheet" href="${l.replace(/"/g, "&quot;")}">`).join("")}<style>html,body{margin:0;padding:0;background:#fff;overflow:hidden;font:13px/1.45 ui-sans-serif,-apple-system,system-ui,sans-serif}#b{position:absolute;left:0;top:0;transform-origin:0 0}${d.faces ?? ""}</style><div id="b">${d.html}</div>`;
  await page.eval(`document.open();document.write(${JSON.stringify(doc)});document.close();0`);
  return page.eval(`(async()=>{
    ${FIT_SCRIPT}
    const wait=(p,ms)=>Promise.race([p,new Promise(r=>setTimeout(r,ms))]);
    for(let i=0;i<200&&!document.getElementById('b');i++)await new Promise(r=>setTimeout(r,50));
    for(let i=0;i<100&&[...document.styleSheets].length<document.querySelectorAll('link').length;i++)await new Promise(r=>setTimeout(r,50));
    await wait(document.fonts.ready,8000);
    await wait(Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))),8000);
    await wait(document.fonts.ready,8000);
    const b=document.getElementById('b');window.__fit(b,1);
    const r=(b.firstElementChild||b).getBoundingClientRect();
    const fontsFailed=[...document.fonts].filter(f=>f.status==='error').map(f=>f.family+' '+f.weight);
    return {w:Math.ceil(r.right),h:Math.ceil(r.bottom),fontsFailed};})()`);
}

const writePng = (p: string, img: Img) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, encodeCompactPng(img)); };
const within = (m: { mismatchPct: number; ssim: number; blob: number }, l: Limits, dpr: number) => m.mismatchPct <= l.mismatchPct && m.ssim >= l.ssim && m.blob <= l.blob * dpr * dpr;

/** The metrics must catch what they are for, or a green run means nothing: a 1 px seam line, a solid blob, and a clean image. */
function selfTest() {
  const mk = (w: number, h: number, bad: (x: number, y: number) => boolean): Img => {
    const data = new Uint8Array(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bad(x, y)) data.set([255, 0, 60, 255], (y * w + x) * 4);
    return { width: w, height: h, data };
  };
  const seam = seamCheck(mk(400, 300, (x) => x === 124), -900, -50, 1024); // edge at 1024 - 900 = 124
  const noise = seamCheck(mk(400, 300, (x, y) => (x * 7 + y * 13) % 97 === 0), -900, -50, 1024);
  const blob = blobs(mk(100, 100, (x, y) => x >= 10 && x < 20 && y >= 30 && y < 35)).largest;
  const a: Img = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(255) };
  const b: Img = { width: 64, height: 64, data: new Uint8Array(a.data) };
  for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) b.data.set([0, 0, 0, 255], (y * 64 + x) * 4);
  const same = diffImages(a, a), diff = diffImages(a, b);
  const rt = decodePng(encodeCompactPng(b));
  if (rt.width !== 64 || !rt.data.every((v, i) => v === b.data[i])) throw new Error("metric self-test failed: compact PNG does not round-trip");
  const ok = seam.visible && !noise.visible && blob?.area === 50 && blob.x === 10 && blob.y === 30 && same.mismatched === 0 && diff.mismatched >= 300 && blobs(diff.diff).largest!.area >= 300;
  if (!ok) throw new Error(`metric self-test failed: ${JSON.stringify({ seam, noise, blob, same: same.mismatched, diff: diff.mismatched })}`);
}

async function main() {
  selfTest();
  const pkg = path.join(ROOT, "engine", "pkg", "canvas_engine_bg.wasm");
  if (!fs.existsSync(pkg)) throw new Error("engine/pkg is not built: run engine/build.sh");
  const newestSrc = Math.max(...fs.readdirSync(path.join(ROOT, "engine", "src")).map((f) => fs.statSync(path.join(ROOT, "engine", "src", f)).mtimeMs));
  const stale = newestSrc > fs.statSync(pkg).mtimeMs + 1000;
  if (stale) log("! engine/pkg is older than engine/src: run engine/build.sh to test the current source");

  // Temp copies: the server never opens the checked-in fixtures.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-golden-"));
  fs.cpSync(FIXTURES, tmp, { recursive: true });
  const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".canvas.json")).map((f) => f.slice(0, -".canvas.json".length)).filter((n) => !only || only.includes(n)).sort();
  if (!names.length) throw new Error("no fixtures match");

  process.env.CANVAS_ROOTS = tmp; // nothing outside the temp copy is scanned
  const { startServer } = await import("../../src/server.ts");
  const canvas = await startServer(PORT);
  const stat = await startStatic();
  const chrome = await launchChrome();
  const results: ViewResult[] = [];
  let adapter = "";
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  try {
    const truthPages = new Map<number, { page: Page; loaded: string }>();
    const truthFor = async (dpr: number) => {
      let t = truthPages.get(dpr);
      if (!t) {
        const page = await chrome.newPage();
        await page.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: dpr, mobile: false });
        await page.goto(`${BASE}/health`);
        truthPages.set(dpr, (t = { page, loaded: "" }));
      }
      return t;
    };
    const enginePage = await chrome.newPage();
    await enginePage.goto(`http://127.0.0.1:${STATIC_PORT}/golden.html`);
    const gpu = await enginePage.eval<boolean>(`(async()=>!!navigator.gpu && !!(await navigator.gpu.requestAdapter()))()`).catch(() => false);
    if (!gpu) throw new Error("headless Chrome has no WebGPU adapter");
    if (!(await enginePage.eval<boolean>(`window.engineReady()`))) throw new Error(`engine page could not start: ${enginePage.console.slice(-3).join(" | ")}`);

    for (const name of names) {
      const file = path.join(tmp, `${name}.canvas.json`);
      const views = (VIEWS[name] ?? [{ name: "1x", zoom: 1, dpr: 1 }]).filter((v) => !onlyViews || onlyViews.includes(v.name));
      let size: { w: number; h: number; fontsFailed: string[] };
      let info: any;
      try {
        if (!views.length) continue;
        const t = await truthFor(views[0].dpr);
        size = await loadTruth(t.page, file, "B");
        t.loaded = name;
        await enginePage.send("Page.bringToFront");
        info = await enginePage.eval(`window.loadBoard(${JSON.stringify({ file, id: "B" })})`, 120_000);
      } catch (e) {
        for (const v of views) results.push({ fixture: name, view: v.name, zoom: v.zoom, dpr: v.dpr, width: 0, height: 0, error: (e as Error).message, note: NOTES[name] });
        log(`ERR  ${name}: ${(e as Error).message}`);
        continue;
      }
      const warnings = [...(info.warnings ?? []), ...(info.loadErrors ?? []), ...(info.missingFonts ?? []).map((f: string) => `engine is missing font ${f}`), ...size.fontsFailed.map((f) => `Chrome could not load font ${f}`)];
      for (const v of views) {
        const res: ViewResult = { fixture: name, view: v.name, zoom: v.zoom, dpr: v.dpr, width: 0, height: 0, note: NOTES[name], warnings };
        results.push(res);
        try {
          const w = Math.min(4096, v.w ?? Math.ceil(size.w * v.zoom)), h = Math.min(4096, v.h ?? Math.ceil(size.h * v.zoom));
          // The camera sits on a whole device pixel, so neither renderer has to round a half pixel its own way.
          const camX = -Math.round((v.x ?? 0) * v.zoom * v.dpr) / v.dpr, camY = -Math.round((v.y ?? 0) * v.zoom * v.dpr) / v.dpr;
          const t = await truthFor(v.dpr);
          const truthPage = t.page;
          if (t.loaded !== name) { await loadTruth(truthPage, file, "B"); t.loaded = name; }
          await truthPage.send("Page.bringToFront");
          await truthPage.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: v.dpr, mobile: false });
          await truthPage.eval(`(()=>{document.getElementById('b').style.transform='translate(${camX}px,${camY}px) scale(${v.zoom})';return 0})()`);
          const T = decodePng(await truthPage.shot(w, h, v.dpr));
          await enginePage.send("Page.bringToFront");
          await enginePage.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: v.dpr, mobile: false });
          const st = await enginePage.eval<any>(`window.showView(${camX},${camY},${v.zoom},${w},${h},${v.dpr})`, 180_000);
          adapter ||= typeof st.adapter === "string" ? st.adapter : JSON.stringify(st.adapter ?? "");
          const E = decodePng(await enginePage.shot(w, h, v.dpr));
          res.width = E.width; res.height = E.height;
          if (st.errors?.length) res.warnings = [...warnings, ...st.errors.map((e: string) => `engine: ${e}`)];
          if (st.tilesMissing) res.warnings = [...(res.warnings ?? []), `engine still had ${st.tilesMissing} tiles missing`];

          const key = `${name}@${v.name}`;
          const d = diffImages(T, E);
          const bl = blobs(d.diff);
          res.fidelity = { mismatchPct: d.mismatchPct, ssim: d.ssim, blob: bl.largest?.area ?? 0, blobAt: bl.largest, blobs: bl.count, antialiased: d.antialiased, pass: false };
          res.fidelity.pass = within(res.fidelity, FIDELITY, v.dpr) && !d.sizeMismatch;
          if (v.tiles) {
            // Tile edges sit every 1024 device px from the board's origin (engine/src/cache.rs TILE).
            res.seam = seamCheck(d.diff, Math.round(camX * v.dpr), Math.round(camY * v.dpr), 1024);
            if (SEAM_ONLY.has(name)) res.fidelity.pass = !d.sizeMismatch;
            if (res.seam.visible) res.fidelity.pass = false;
          }
          res.known = KNOWN[key] ?? KNOWN[name];
          writePng(path.join(OUT, `${key}.chrome.png`), T);
          writePng(path.join(OUT, `${key}.engine.png`), E);
          writePng(path.join(OUT, `${key}.diff.png`), d.diff);
          if (!res.fidelity.pass && bl.largest) {
            // The worst spot, enlarged context: chrome | engine | diff.
            const b = bl.largest, pad = 24;
            const r = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), w: Math.min(d.diff.width, b.x + b.w + pad) - Math.max(0, b.x - pad), h: Math.min(d.diff.height, b.y + b.h + pad) - Math.max(0, b.y - pad) };
            const cap = { ...r, w: Math.min(r.w, 360), h: Math.min(r.h, 240) };
            writePng(path.join(OUT, `${key}.worst.png`), sideBySide(crop(T, cap), crop(E, cap), crop(d.diff, cap)));
            res.worst = `${key}.worst.png`;
          }
          res.images = { chrome: `${key}.chrome.png`, engine: `${key}.engine.png`, diff: `${key}.diff.png` };

          const basePath = path.join(BASELINE, `${key}.png`);
          if (flag("update")) {
            fs.mkdirSync(BASELINE, { recursive: true });
            fs.writeFileSync(basePath, encodeCompactPng(E));
            res.regression = { status: "updated" };
          } else if (!fs.existsSync(basePath)) res.regression = { status: "missing" };
          else {
            const B = decodePng(fs.readFileSync(basePath));
            const rd = diffImages(B, E, { threshold: 0.05 });
            const rb = blobs(rd.diff);
            const m = { mismatchPct: rd.mismatchPct, ssim: rd.ssim, blob: rb.largest?.area ?? 0 };
            const ok = within(m, REGRESSION, v.dpr) && !rd.sizeMismatch;
            res.regression = { status: ok ? "same" : "changed", ...m };
            if (!ok) { writePng(path.join(OUT, `${key}.baseline-diff.png`), sideBySide(B, E, rd.diff)); res.images.baselineDiff = `${key}.baseline-diff.png`; }
          }
        } catch (e) {
          res.error = (e as Error).message;
        }
        const f = res.fidelity;
        log(`${res.error ? "ERR " : f?.pass ? "ok  " : res.known ? "gap " : "FAIL"} ${`${name}@${v.name}`.padEnd(34)} ${res.error ?? `${String(res.width).padStart(4)}x${String(res.height).padEnd(4)} mismatch ${f!.mismatchPct.toFixed(3).padStart(7)}%  ssim ${f!.ssim.toFixed(4)}  blob ${String(f!.blob).padStart(6)}${res.seam ? `  seam ${res.seam.seamPx}px x${res.seam.ratio.toFixed(1)}` : ""}  baseline ${res.regression?.status}`}`);
      }
    }
  } finally {
    await chrome.stop();
    stat.close();
    canvas.close();
    (canvas as any).closeAllConnections?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const fidelityFails = results.filter((r) => r.fidelity && !r.fidelity.pass);
  const unknownFails = fidelityFails.filter((r) => !r.known);
  const fixedGaps = results.filter((r) => r.known && r.fidelity?.pass);
  const regressions = results.filter((r) => r.regression?.status === "changed");
  const missing = results.filter((r) => r.regression?.status === "missing");
  const errors = results.filter((r) => r.error);
  const summary = { generatedAt: new Date().toISOString(), chrome: chrome.version, adapter, stalePkg: stale, limits: { fidelity: FIDELITY, regression: REGRESSION }, totalMs: Date.now() - t0, counts: { fixtures: names.length, views: results.length, fidelityFail: fidelityFails.length, knownGaps: fidelityFails.length - unknownFails.length, regressions: regressions.length, missingBaselines: missing.length, errors: errors.length }, results };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
  writeReport(summary, OUT);

  log("");
  log(`${names.length} fixtures, ${results.length} views in ${((Date.now() - t0) / 1000).toFixed(1)}s (${chrome.version}, ${adapter})`);
  log(`fidelity vs Chrome: ${results.length - fidelityFails.length - errors.length} pass, ${fidelityFails.length} differ (${fidelityFails.length - unknownFails.length} known gaps, ${unknownFails.length} new)`);
  log(`regression vs baseline: ${regressions.length} changed, ${missing.length} without a baseline${flag("update") ? ", baselines written" : ""}`);
  if (fixedGaps.length) log(`now passing but still listed in known-gaps.json: ${fixedGaps.map((r) => `${r.fixture}@${r.view}`).join(", ")}`);
  if (errors.length) log(`errors: ${errors.map((r) => `${r.fixture}@${r.view}`).join(", ")}`);
  log(`report: ${path.join(OUT, "report.html")}`);
  const bad = errors.length > 0 || regressions.length > 0 || unknownFails.length > 0 || (flag("strict") && (fidelityFails.length > 0 || missing.length > 0));
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
