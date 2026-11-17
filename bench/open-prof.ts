// Where an open's time goes: opens a generated stress file in headless Chrome (CPU profile of the page while it
// loads), and reports the page's own timings, the engine's totals and the hottest functions.
//
//   node bench/open-prof.ts [boards=200]        OPEN_PROF_ZOOM=0.5 opens at that zoom instead of the overview
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchChrome } from "../fidelity/cdp.ts";
import { openTab, startServer } from "../qa/lib.ts";
import { fixture, scratchCopy } from "./fixtures/gen.ts";
import { INSTRUMENT } from "./latency.ts";

const boards = Number(process.argv[2] ?? 200);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-oprof-"));
const f = scratchCopy(fixture(boards), tmp, `s${boards}.canvas`);
process.env.CANVAS_SECURITY_BIN = "/usr/bin/false";
const srv = await startServer(tmp);
const chrome = await launchChrome(["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"]);
try {
  const { page, close } = await openTab(chrome.port);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  // OPEN_PROF_FRAMES=0: no per-frame engine stats (each walks every board: 4 ms a frame at 5,000 boards).
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT + (process.env.OPEN_PROF_FRAMES === "0" ? "" : ";window.__lat.startFrames();") });
  await page.send("Profiler.enable");
  await page.send("Profiler.setSamplingInterval", { interval: 200 });
  await page.send("Profiler.start");
  const t0 = Date.now();
  await page.goto(`${srv.base}/?file=${encodeURIComponent(f.dir)}&shell=native`);
  let perf: any = null;
  while (Date.now() - t0 < Number(process.env.OPEN_PROF_MS ?? 90_000)) {
    perf = await page.eval("window.canvasHost && window.canvasHost.perf && JSON.parse(JSON.stringify(window.canvasHost.perf))").catch(() => null);
    if (perf && (process.env.OPEN_PROF_UNTIL === "load" ? perf.load : perf.picture) !== null) break; // the first complete picture (OPEN_PROF_UNTIL=load: the engine idle)
    await new Promise((r) => setTimeout(r, 100));
  }
  const { profile } = await page.send("Profiler.stop");
  const fr = await page.eval<{ b: number; e: number; cpu: number | null; gpu: number | null; tiles: number | null; stop?: number | null }[]>("window.__lat.stopFrames()");
  const withTiles = fr.filter((x) => (x.tiles ?? 0) > 0);
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0));
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN) * 10) / 10; };
  console.log(`frames ${fr.length}, with tiles ${withTiles.length}, tiles ${sum(withTiles.map((x) => x.tiles ?? 0))}, engine cpu ${sum(fr.map((x) => x.cpu ?? 0))} ms, gpu p50 ${q(withTiles.map((x) => x.gpu ?? 0), 0.5)} p95 ${q(withTiles.map((x) => x.gpu ?? 0), 0.95)}, tiles/frame p50 ${q(withTiles.map((x) => x.tiles ?? 0), 0.5)}, last tile at ${Math.round(withTiles.at(-1)?.e ?? 0)} ms`);
  const stops = new Map<number, number>();
  for (const x of withTiles as { stop?: number | null }[]) stops.set(x.stop ?? -1, (stops.get(x.stop ?? -1) ?? 0) + 1);
  console.log("why a frame's batch stopped (frames): " + [...stops.entries()].map(([k, v]) => `${["none", "cells", "too big", "image atlas", "vello buffers", "atlas full", "CPU budget", "no estimate", "GPU model"][k] ?? k} ${v}`).join(", "));
  const buckets = new Map<number, number>();
  for (const x of withTiles) { const k = Math.floor(x.e / 500) * 500; buckets.set(k, (buckets.get(k) ?? 0) + (x.tiles ?? 0)); }
  console.log("tiles per 500 ms:", [...buckets.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
  const stats = await page.eval("JSON.parse(JSON.stringify(window.__canvas.stats()))").catch(() => null);
  const cam = await page.eval("JSON.parse(JSON.stringify(window.canvasHost.cam))").catch(() => null);
  console.log("perf", JSON.stringify(perf));
  console.log("cam", JSON.stringify(cam));
  if (stats) console.log("engine", JSON.stringify({ boards: stats.boards, visibleBoards: stats.visibleBoards, nodes: stats.nodes, layoutMs: stats.layoutMs, paintMs: stats.paintMs, tileCount: stats.tileCount, tileBytes: stats.tileBytes, images: stats.images, imageBytes: stats.imageBytes, wasmBytes: stats.wasmBytes, tileWork: stats.tileWork, gpuModel: stats.gpuModel, tilesWhole: stats.tilesWhole, tilesBatched: stats.tilesBatched, rendererInitMs: stats.rendererInitMs }));
  const self = new Map<string, number>();
  const byId = new Map(profile.nodes.map((n: any) => [n.id, n]));
  (profile.samples ?? []).forEach((id: number, i: number) => {
    const n: any = byId.get(id);
    const key = `${n.callFrame.functionName || "(anon)"} ${path.basename(n.callFrame.url || "")}:${n.callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log(`page CPU profile: ${Math.round(total)} ms sampled`);
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP ?? 30))) console.log(`  ${v.toFixed(1).padStart(8)} ms  ${k}`);
  fs.writeFileSync(path.join(os.tmpdir(), `canvas-open-${boards}.cpuprofile`), JSON.stringify(profile));
  await close();
} finally {
  await chrome.stop();
  await srv.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
