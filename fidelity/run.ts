// Pixel-fidelity harness. For each board: DOM reference ("truth") at 1x and 2x, the same board through the
// engine when it exists, then a diff (YIQ delta with anti-aliasing tolerance + SSIM on luma).
//
//   node fidelity/run.ts [file.canvas.json ...] [--scales 1,2] [--limit N] [--boards id,id] [--truth-only] [--simulate-engine]
//                        [--max-mismatch 1.5] [--max-side 60000] [--min-ssim 0.97] [--no-selftest] [--out dir]
// Default: a temp copy of demos/learn.canvas. Pass your own files (a large real-world one is the useful test);
// they are copied to a temp folder too, so the originals are never opened.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIT_SCRIPT } from "../src/engine.ts";
import { launchChrome, type Page } from "./cdp.ts";
import { diffImages, recolored, shifted, sideBySide } from "./diff.ts";
import { decodePng, encodePng, type Img } from "./png.ts";
import { writeReport, type BoardResult, type ScaleResult, type Summary } from "./report.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.CANVAS_PORT ?? 5183);
const STATIC_PORT = PORT + 1;
if (PORT === 5189 || STATIC_PORT === 5189) throw new Error("port 5189 is the user's Canvas; pick another CANVAS_PORT");
const BASE = `http://127.0.0.1:${PORT}`;

// ---- args
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const valueFlags = new Set(["max-side", "scales", "limit", "boards", "max-mismatch", "min-ssim", "out"]);
const files: string[] = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith("--")) { if (valueFlags.has(argv[i].slice(2))) i++; } else files.push(argv[i]); }
const scales = (opt("scales", "1,2") as string).split(",").map(Number).filter((n) => n > 0);
const limit = Number(opt("limit", "0")) || Infinity;
const maxSide = Number(opt("max-side", "60000"));
const only = opt("boards")?.split(",");
const thresholds = { maxMismatchPct: Number(opt("max-mismatch", process.env.FIDELITY_MAX_MISMATCH ?? "1.5")), minSsim: Number(opt("min-ssim", process.env.FIDELITY_MIN_SSIM ?? "0.97")) };
const OUT = path.resolve(opt("out", path.join(ROOT, "fidelity", "out")) as string);

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "_";
const fmt = (n: number, d = 3) => n.toFixed(d);
const t0 = Date.now();
const log = (s: string) => console.log(s);

// ---- inputs: temp copies only
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-fidelity-"));
const defaults = [path.join(ROOT, "demos", "learn.canvas", "document.json")];
const inputs = (files.length ? files.map((f) => path.resolve(f)) : defaults.filter((f) => fs.existsSync(f)));
const copies = inputs.map((f) => {
  // A package's design file is copied out as a loose file named after the package.
  const inPackage = path.basename(f) === "document.json";
  const label = inPackage ? path.basename(path.dirname(f), path.extname(path.dirname(f))) : path.basename(f, path.extname(f));
  const dst = path.join(tmp, inPackage ? `${label}.canvas.json` : path.basename(f));
  fs.writeFileSync(dst, anchored(fs.readFileSync(f, "utf8"), path.dirname(f)));
  return { label, original: f, copy: dst };
});

/** The document with relative image and font URLs made absolute, so the copy finds the original's files. */
function anchored(text: string, dir: string): string {
  const doc = JSON.parse(text);
  const fix = (u: unknown) => (typeof u === "string" && u && !/^(https?:|data:|file:|\/)/.test(u) ? path.resolve(dir, u) : u);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.type === "image" && "url" in o) o.url = fix(o.url);
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(doc.children);
  walk(doc.variables);
  if (Array.isArray(doc.fonts)) for (const f of doc.fonts) if (f && typeof f === "object") f.url = fix(f.url);
  return JSON.stringify(doc);
}
if (!copies.length) throw new Error("no .canvas.json files to render");

// ---- engine detection
function engineStatus(): { files: boolean; reason: string } {
  const pkg = path.join(ROOT, "engine", "pkg");
  let wasm = false, cls = false;
  try {
    wasm = fs.readdirSync(pkg).some((f) => f.endsWith(".wasm"));
    cls = fs.readdirSync(pkg).filter((f) => f.endsWith(".d.ts")).some((f) => /class\s+Engine\b/.test(fs.readFileSync(path.join(pkg, f), "utf8")));
  } catch {}
  if (!wasm) return { files: false, reason: "no engine/pkg/*.wasm yet" };
  if (!cls) return { files: false, reason: "engine/pkg has a wasm build but no Engine class yet (phase 0 spike API only)" };
  return { files: true, reason: "engine/pkg ok" };
}

// ---- static + proxy server for the engine page (same origin as /api/scene, /api/fonts/file, /asset)
function startStatic(): Promise<http.Server> {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let local: string | null = null;
    if (url.pathname === "/engine.html") local = path.join(ROOT, "fidelity", "engine-page.html");
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

// One retry: the server closes idle keep-alive sockets and undici reports that as "fetch failed".
const getJson = async (p: string): Promise<any> => {
  for (let i = 0; ; i++) {
    try { return await (await fetch(BASE + p)).json(); } catch (e) { if (i >= 2) throw e; await new Promise((r) => setTimeout(r, 100)); }
  }
};

// ---- truth: the board HTML the Canvas page lays out, drawn at the origin on white
async function drawTruth(page: Page, file: string, id: string): Promise<{ w: number; h: number; name: string } | { error: string }> {
  const q = `file=${encodeURIComponent(file)}&id=${encodeURIComponent(id)}`;
  const d = await getJson(`/api/board?${q}`);
  // Background tabs get no animation frames: the page in front is the one being drawn.
  await page.send("Page.bringToFront");
  if (d.error) return { error: d.error };
  const doc = `<!doctype html><meta charset="utf-8">${(d.links ?? []).map((l: string) => `<link rel="stylesheet" href="${l.replace(/"/g, "&quot;")}">`).join("")}<style>html,body{margin:0;padding:0;background:#fff;font:13px/1.45 ui-sans-serif,-apple-system,system-ui,sans-serif}#b{position:absolute;left:0;top:0}${d.faces ?? ""}</style><div id="b">${d.html}</div>`;
  await page.eval(`document.open();document.write(${JSON.stringify(doc)});document.close();0`);
  const box = await page.eval<{ w: number; h: number }>(`(async()=>{
    ${FIT_SCRIPT}
    const wait=(p,ms)=>Promise.race([p,new Promise(r=>setTimeout(r,ms))]);
    for(let i=0;i<200&&!document.getElementById('b');i++)await new Promise(r=>setTimeout(r,50));
    await wait(document.fonts.ready,5000);
    await wait(Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))),8000);
    const b=document.getElementById('b');window.__fit(b,1);
    const r=(b.firstElementChild||b).getBoundingClientRect();
    return {w:Math.ceil(r.right),h:Math.ceil(r.bottom)};})()`);
  return { ...box, name: "" };
}

/** The engine's render of a W x H CSS px board at `scale`, shot in regions a WebGPU canvas can hold. */
const engineErrors = new Set<string>();
/** Above this many device px a board's images are kept for its worst region only. */
const KEEP_FULL_PX = 48e6;

type Shot = { truth?: Img; engine?: Img; diff?: Img; mismatched: number; antialiased: number; pixels: number; ssimSum: number; worstAt?: string };

/**
 * Truth and engine renders of a W x H CSS px board at `scale`, region by region (a WebGPU canvas
 * tops out at 8192 px and a Chrome screenshot at about 16k): the DOM board is shifted under a
 * region-sized viewport, the engine's camera moves the same way. Diffed per region and summed.
 */
async function shootRegions(truthPage: Page, enginePage: Page | null, W: number, H: number, scale: number, simulate: boolean): Promise<Shot> {
  const step = Math.floor(Number(process.env.FIDELITY_REGION ?? 4096) / scale);
  const full = W * H * scale * scale <= KEEP_FULL_PX;
  const blank = () => ({ width: W * scale, height: H * scale, data: new Uint8Array(W * scale * H * scale * 4) });
  const out: Shot = { mismatched: 0, antialiased: 0, pixels: 0, ssimSum: 0, ...(full ? { truth: blank(), engine: enginePage || simulate ? blank() : undefined, diff: enginePage || simulate ? blank() : undefined } : {}) };
  let worst = -1;
  for (let y0 = 0; y0 < H; y0 += step)
    for (let x0 = 0; x0 < W; x0 += step) {
      const w = Math.min(step, W - x0);
      const h = Math.min(step, H - y0);
      await truthPage.send("Page.bringToFront");
      await truthPage.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile: false });
      await truthPage.eval(`(()=>{const b=document.getElementById('b');b.style.transform='translate(${-x0}px,${-y0}px)';return 0})()`);
      const T = decodePng(await truthPage.shot(w, h, scale));
      let E: Img | undefined;
      if (simulate) E = shifted(T, 1, 0);
      else if (enginePage) {
        await enginePage.send("Page.bringToFront");
        await enginePage.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile: false });
        const st = await enginePage.eval<{ errors: string[] }>(`window.showRegion(${x0},${y0},${w},${h},${scale})`, 120_000);
        for (const e of st?.errors ?? []) engineErrors.add(e);
        E = decodePng(await enginePage.shot(w, h, scale));
      }
      const put = (dst: Img | undefined, src: Img) => {
        if (!dst || !full) return;
        for (let y = 0; y < src.height && y0 * scale + y < dst.height; y++) dst.data.set(src.data.subarray(y * src.width * 4, (y * src.width + Math.min(src.width, dst.width - x0 * scale)) * 4), ((y0 * scale + y) * dst.width + x0 * scale) * 4);
      };
      put(out.truth, T);
      if (!E) continue;
      const d = diffImages(T, E);
      const px = T.width * T.height;
      out.mismatched += d.mismatched;
      out.antialiased += d.antialiased;
      out.pixels += px;
      out.ssimSum += d.ssim * px;
      put(out.engine, E);
      put(out.diff, d.diff);
      if (!full && d.mismatched > worst) {
        worst = d.mismatched;
        Object.assign(out, { truth: T, engine: E, diff: d.diff, worstAt: `css ${x0},${y0} ${w}x${h}` });
      }
    }
  await truthPage.eval(`(()=>{document.getElementById('b').style.transform='';return 0})()`);
  if (!enginePage && !simulate) out.pixels = 0;
  return out;
}

const writePng = (p: string, buf: Buffer | Uint8Array) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); };

async function main() {
  const simulate = flag("simulate-engine"); // test the diff + report path: the "engine" is truth shifted by 1px
  const eng = simulate ? { files: true, reason: "SIMULATED: engine output is truth shifted 1px" } : engineStatus();
  process.env.CANVAS_ROOTS = "";
  const { startServer } = await import("../src/server.ts");
  const canvas = await startServer(PORT);
  let stat: http.Server | null = null;
  const chrome = await launchChrome();
  const results: BoardResult[] = [];
  let selfTest: Summary["selfTest"];
  let engineAvailable = false, engineReason = eng.reason;
  try {
    // scene route probe (needs a board id, so after the first doc is read)
    const truthPage = await chrome.newPage();
    await truthPage.goto(`${BASE}/health`);
    let enginePage: Page | null = null;

    fs.rmSync(OUT, { recursive: true, force: true });
    for (const f of copies) {
      const doc = await getJson(`/api/doc?file=${encodeURIComponent(f.copy)}`);
      if (doc.error) { log(`! ${f.label}: ${doc.error}`); continue; }
      let boards: { id: string; name: string }[] = doc.boards;
      if (only) boards = boards.filter((b) => only.includes(b.id) || only.includes(b.name));
      boards = boards.slice(0, limit);
      log(`${f.label}: ${boards.length} boards`);

      if (simulate) { engineAvailable = true; engineReason = eng.reason; }
      else if (eng.files && !enginePage) {
        const probe = await fetch(`${BASE}/api/scene?file=${encodeURIComponent(f.copy)}&id=${encodeURIComponent(boards[0]?.id ?? "")}`).catch(() => null);
        if (probe?.ok) {
          stat = await startStatic();
          enginePage = await chrome.newPage();
          await enginePage.goto(`http://127.0.0.1:${STATIC_PORT}/engine.html`);
          const gpu = await enginePage.eval<boolean>(`(async()=>!!navigator.gpu && !!(await navigator.gpu.requestAdapter()))()`).catch(() => false);
          const ok = gpu && (await enginePage.eval<boolean>(`window.engineReady().catch(e=>{console.error(String(e));return false})`).catch(() => false));
          engineAvailable = !!ok;
          engineReason = ok ? "engine rendered in headless WebGPU Chrome" : `engine page could not start (${gpu ? "wasm init failed" : "no WebGPU adapter"}): ${enginePage.console.slice(-2).join(" | ")}`;
        } else engineReason = `engine/pkg present but GET /api/scene returned ${probe ? probe.status : "no answer"}`;
      }

      for (const b of boards) {
        const started = Date.now();
        const res: BoardResult = { file: f.label, board: b.id, name: b.name, truthMs: 0, engine: engineAvailable ? "ok" : "pending", scales: [] };
        const dir = path.join(OUT, slug(f.label), slug(b.id));
        try {
          const t = await drawTruth(truthPage, f.copy, b.id);
          if ("error" in t) throw new Error(t.error);
          if (t.w < 1 || t.h < 1) throw new Error(`board has no size (${t.w}x${t.h})`);
          if (t.w > maxSide || t.h > maxSide) {
            res.skipped = `${t.w}x${t.h} is over --max-side ${maxSide}`;
            results.push(res);
            log(`  skip ${f.label}/${b.id.padEnd(14)} ${res.skipped}`);
            continue;
          }
          res.truthMs = Date.now() - started;
          const pre = `${slug(f.label)}/${slug(b.id)}`;
          if (!selfTest && !flag("no-selftest")) {
            const s0 = scales[0];
            if (t.w * t.h * s0 * s0 <= KEEP_FULL_PX) selfTest = runSelfTest(await shootRegions(truthPage, null, t.w, t.h, s0, simulate).then((r) => r.truth!), `${f.label}/${b.id}`);
          }
          const es = Date.now();
          let loaded = false;
          for (const sc of scales) {
            const sr: ScaleResult = { scale: sc, width: t.w * sc, height: t.h * sc, truth: `${pre}/truth@${sc}x.png` };
            res.scales.push(sr);
            if (!(engineAvailable && (enginePage || simulate))) {
              const r = await shootRegions(truthPage, null, t.w, t.h, sc, simulate);
              if (r.truth) writePng(path.join(dir, `truth@${sc}x.png`), encodePng(r.truth));
              continue;
            }
            try {
              if (!simulate && !loaded) {
                await enginePage!.send("Page.bringToFront");
                await enginePage!.eval(`window.loadBoard(${JSON.stringify({ file: f.copy, id: b.id })})`, 120_000);
                loaded = true;
              }
              const r = await shootRegions(truthPage, enginePage, t.w, t.h, sc, simulate);
              writePng(path.join(dir, `truth@${sc}x.png`), encodePng(r.truth!));
              writePng(path.join(dir, `engine@${sc}x.png`), encodePng(r.engine!));
              writePng(path.join(dir, `diff@${sc}x.png`), encodePng(r.diff!));
              writePng(path.join(dir, `side@${sc}x.png`), encodePng(sideBySide(r.truth!, r.engine!, r.diff!)));
              const mismatchPct = (r.mismatched / r.pixels) * 100;
              const ssim = r.ssimSum / r.pixels;
              Object.assign(sr, { mismatchPct, mismatched: r.mismatched, antialiased: r.antialiased, ssim, pass: mismatchPct <= thresholds.maxMismatchPct && ssim >= thresholds.minSsim, engine: `${pre}/engine@${sc}x.png`, diff: `${pre}/diff@${sc}x.png`, side: `${pre}/side@${sc}x.png` });
              if (r.worstAt) sr.note = `images show the region with the most mismatches, at ${r.worstAt} (board too big to store whole)`;
            } catch (e) {
              res.engine = "error";
              res.error = `engine: ${(e as Error).message}`;
            }
          }
          if (engineAvailable) {
            res.engineMs = Date.now() - es;
            if (engineErrors.size) res.error = `engine reported: ${[...engineErrors].slice(0, 3).join(" | ")}`;
            engineErrors.clear();
          }
        } catch (e) {
          res.engine = engineAvailable ? "error" : "pending";
          res.error = (e as Error).message;
          if (!engineAvailable) res.error = `truth: ${res.error}`;
          res.engine = "error";
        }
        results.push(res);
        const w = res.scales.map((s) => (s.mismatchPct === undefined ? "" : ` ${s.scale}x ${fmt(s.mismatchPct)}% ssim ${fmt(s.ssim ?? 0, 4)}`)).join("");
        log(`  ${res.error ? "ERR " : "ok  "}${f.label}/${b.id.padEnd(14)} ${res.scales[0]?.width ?? "?"}x${res.scales[0]?.height ?? "?"} truth ${res.truthMs}ms${res.engineMs ? ` engine ${res.engineMs}ms` : ""}${w}${res.error ? ` ${res.error}` : ""}`);
      }
    }
  } finally {
    await chrome.stop();
    stat?.close();
    canvas.close();
  }

  const compared = results.filter((r) => r.scales.some((s) => s.pass !== undefined)).length;
  const failing = results.filter((r) => r.scales.some((s) => s.pass === false)).length;
  const skipped = results.filter((r) => r.skipped).length;
  const errors = results.filter((r) => !r.skipped && (r.error || r.engine === "error")).length;
  const summary: Summary = {
    generatedAt: new Date().toISOString(), engine: { available: engineAvailable, reason: engineReason }, thresholds, chrome: chrome.version, totalMs: Date.now() - t0,
    selfTest, counts: { boards: results.length, compared, failing, errors, skipped }, boards: results,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  writeReport(summary, OUT);
  fs.rmSync(tmp, { recursive: true, force: true });

  log("");
  log(`engine: ${engineAvailable ? "rendered" : "pending"} (${engineReason})`);
  if (selfTest) log(`self-test: ${selfTest.ok ? "pass" : "FAIL"}\n${selfTest.lines.map((l) => "  " + l).join("\n")}`);
  log(`boards ${results.length}, compared ${compared}, failing ${failing}, errors ${errors}, skipped ${skipped}, total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`report: ${path.join(OUT, "report.html")}`);
  const bad = failing > 0 || errors > 0 || (selfTest && !selfTest.ok);
  process.exit(bad ? 1 : 0);
}

/** Diffs a real truth render against a 1px-shifted copy and a recoloured copy. Both must be caught, an identical copy must not. */
function runSelfTest(truth: ReturnType<typeof decodePng>, label: string): NonNullable<Summary["selfTest"]> {
  const same = diffImages(truth, { ...truth, data: new Uint8Array(truth.data) });
  const shift = diffImages(truth, shifted(truth, 1, 0));
  const colour = diffImages(truth, recolored(truth, 90));
  const lines = [
    `board ${label} ${truth.width}x${truth.height}`,
    `identical:   mismatch ${fmt(same.mismatchPct)}%  ssim ${fmt(same.ssim, 4)}`,
    `1px shift:   mismatch ${fmt(shift.mismatchPct)}%  ssim ${fmt(shift.ssim, 4)}  (aa-forgiven ${shift.antialiased})`,
    `colour +90R: mismatch ${fmt(colour.mismatchPct)}%  ssim ${fmt(colour.ssim, 4)}`,
  ];
  // A flat board has nothing to shift; only demand a shift catch when the image has edges (SSIM drops or pixels differ).
  const flat = diffImages(truth, shifted(truth, 1, 0), { threshold: 0 }).mismatched === 0;
  const ok = same.mismatched === 0 && same.ssim > 0.9999 && (flat || (shift.mismatched > 0 && shift.ssim < 1)) && colour.mismatchPct > 1 && colour.ssim < 1;
  if (flat) lines.push("note: board has no edges, shift check skipped");
  return { ok, lines };
}

main().catch((e) => { console.error(e); process.exit(2); });
