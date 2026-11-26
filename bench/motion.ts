import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome } from "../fidelity/cdp.ts";
import { decodePng, encodePng } from "../fidelity/png.ts";
import { RECORDER_JS, saveFrames } from "../qa/frames.ts";
import { freePort, openTab, sleep } from "../qa/lib.ts";
import { MOTION_HERO, motionFixture } from "./fixtures/motion.ts";
import { Tab } from "./latency.ts";
import { stats } from "./lib.ts";
import { INSTRUMENT } from "./page.ts";
import { startHost } from "./server.ts";

const outside = { x: 12, y: 100 };
type Opened = { fullPaintMs: number; heapMiB: number };
type Idle = { engineFrames: number; wakes: number; evaluations: number; rendererCpuMs: number };
type Hover = { p95: number; p99: number; poses: number; firstMs: number; sprites: number; skipped: number };
type Counts = { frames: number; wakes: number; evaluations: number };
const countJs = `(() => { const m = window.__motion; return { frames: window.canvasHost.engineView.engine.stats().frames, wakes: m.wakes, evaluations: m.evaluations }; })()`;

export async function openMotion(tab: Tab, base: string, file: string, collect = false): Promise<Opened> {
  if (collect) {
    await tab.page.send("Performance.enable");
    await tab.page.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT(null) + `
      window.__motionPeak = 0;
      const peakTimer = setInterval(() => {
        window.__motionPeak = Math.max(window.__motionPeak, performance.memory?.usedJSHeapSize ?? 0);
        if (window.canvasHost?.perf.picture !== null && window.canvasHost?.perf.picture !== undefined) clearInterval(peakTimer);
      }, 16);
    ` });
  }
  await tab.open(base, file, undefined, 0);
  await tab.move(outside);
  await tab.waitFor(`window.__motion && window.canvasHost.perf.picture !== null`, "full engine paint");
  const results = await tab.ev<Opened>(`({ fullPaintMs: window.canvasHost.perf.picture, heapMiB: (window.__motionPeak ?? 0) / 1048576 })`);
  const r = await tab.rect(MOTION_HERO);
  if (!r) throw new Error("Motion fixture hero was not laid out");
  // 100% even when Tab.show's safety margin would fit to a smaller zoom.
  await tab.setCam({ z: 1, x: 200 - r.x, y: 100 - r.y });
  return results;
}

export async function idleMotion(tab: Tab, cpu = false): Promise<Idle> {
  const counter = () => tab.ev<Counts>(countJs);
  const task = async () => {
    if (!cpu) return 0;
    const { metrics } = await tab.page.send("Performance.getMetrics");
    return (metrics.find((m: {name: string; value: number}) => m.name === "TaskDuration")?.value ?? 0) * 1000;
  };
  const before = await counter(), t = await task();
  await sleep(2000);
  const after = await counter();
  const idle = { engineFrames: after.frames - before.frames, wakes: after.wakes - before.wakes, evaluations: after.evaluations - before.evaluations, rendererCpuMs: await task() - t };
  if (idle.wakes || idle.evaluations) throw new Error(`Idle motion woke ${idle.wakes} times and evaluated ${idle.evaluations} tracks`);
  return idle;
}

export async function hoverMotion(tab: Tab): Promise<Hover> {
  const r = await tab.screenRect(MOTION_HERO);
  if (!r) throw new Error("Motion fixture hero was not laid out");
  await tab.ev("window.__motion.record()");
  await tab.move({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  await sleep(2000);
  const { frames, firstMs, sprites, skipped, errors } = await tab.ev(`(() => {
    const m = window.__motion, e = window.canvasHost.engineView.engine;
    return { frames: m.recorded(), firstMs: m.hoverToFirstPoseMs, sprites: m.sprites, skipped: m.skipped.length, errors: e.stats().errors };
  })()`);
  if (frames.length < 10 || sprites !== 256 || skipped !== 44) {
    throw new Error(`Hover presented ${frames.length} poses with ${sprites} sprites and ${skipped} skipped. Engine errors ${JSON.stringify(errors)}`);
  }
  const gaps = frames.slice(1).map((t: number, i: number) => t - frames[i]);
  const { p95 } = stats(gaps);
  gaps.sort((a: number, b: number) => a - b);
  return { p95, p99: gaps[Math.ceil(gaps.length * 0.99) - 1], poses: frames.length, firstMs, sprites, skipped };
}

async function captureStrip(tab: Tab, tmp: string, evidence: string) {
  await tab.move(outside);
  await tab.waitFor("window.__motion.sprites === 0", "hover leave");
  await tab.settle();
  if (!await tab.ev(RECORDER_JS)) throw new Error("Frame recorder could not find the engine");
  const region = await tab.ev(`(() => {
    const h = window.canvasHost, r = h.worldRectOf(${JSON.stringify(MOTION_HERO)}), d = window.__frames.dpr();
    return { x: Math.round((r.x + h.cam.x) * d), y: Math.round((r.y + h.cam.y) * d), w: Math.round(r.w * d), h: Math.round(r.h * d) };
  })()`);
  await tab.ev(`window.__frames.start(${JSON.stringify(region)}, 8, 8)`);
  const r = (await tab.screenRect(MOTION_HERO))!;
  await tab.move({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  await sleep(2000);
  await tab.ev("window.__frames.last = window.__frames.stop(); null");
  const paths = await saveFrames((js) => tab.ev(js), [0, 1, 2, 3, 4, 5, 6, 7], tmp, "hover");
  if (paths.length < 6) throw new Error(`Only ${paths.length} evidence frames`);
  const images = paths.map(p => decodePng(fs.readFileSync(p)));
  const w = 500, h = 340, gap = 8;
  const width = (w + gap) * 4 + gap, height = (h + gap) * 2 + gap;
  const data = new Uint8Array(width * height * 4).fill(255);
  const signatures = new Set<string>();
  for (const [i, img] of images.entries()) {
    const dx = (i % 4) * (w + gap) + gap, dy = Math.floor(i / 4) * (h + gap) + gap;
    signatures.add(fs.readFileSync(paths[i]).toString("base64"));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const at = (Math.floor(y * img.height / h) * img.width + Math.floor(x * img.width / w)) * 4;
      data.set(img.data.subarray(at, at + 4), ((dy + y) * width + dx + x) * 4);
    }
  }
  if (signatures.size < 6) throw new Error("Evidence has fewer than six distinct poses");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "hover-strip.png"), encodePng({ width, height, data }));
}

async function evidence() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-motion-")));
  const port = await freePort();
  const host = await startHost({ port, env: { CANVAS_ROOTS: root, CANVAS_WEB_FONTS: "0", CANVAS_STATE_DIR: path.join(root, "state"),
    CANVAS_WIDGETS_DIR: path.join(root, "widgets"), CANVAS_TRUST_FILE: path.join(root, "trust.json"), CANVAS_LOG_DIR: path.join(root, "logs") } });
  const base = `http://127.0.0.1:${port}`;
  try {
    const lines: string[] = [];
    let hover: Hover | undefined;
    for (const animated of [false, true]) {
      const chrome = await launchChrome(["--enable-precise-memory-info", "--disable-component-update", "--disable-sync"]);
      try {
        const tab = new Tab(await openTab(chrome.port));
        try {
          const opened = await openMotion(tab, base, motionFixture(root, animated), true);
          const idle = await idleMotion(tab, true);
          if (animated) hover = await hoverMotion(tab);
          lines.push(`| ${animated ? "Motion" : "Static"} | ${idle.engineFrames} | ${idle.wakes} | ${idle.evaluations} | ${idle.rendererCpuMs.toFixed(2)} | ${opened.fullPaintMs} | ${opened.heapMiB.toFixed(2)} |`);
          if (animated) await captureStrip(tab, root, "motion-evidence");
        } finally { await tab.close(); }
      } finally { await chrome.stop(); }
    }
    if (!hover) throw new Error("Hover was not measured");
    const report = [
      "# Hover motion performance", "",
      "Headless Chromium, engine renderer, 100% zoom, 2× device scale, 50 boards and 2,064 animated layers. Fresh Chromium process per file. Peak JS heap sampled every 16 ms through full paint.", "",
      "| File | Idle engine frames | Idle wakes | Idle evaluations | 2 s renderer CPU (ms) | Full paint (ms) | Peak JS heap (MiB) |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |", ...lines, "",
      "| Hover gap p95 (ms) | Hover gap p99 (ms) | Presented poses in 2 s | First pose (ms) | Sprites | Skipped |",
      "| ---: | ---: | ---: | ---: | ---: | ---: |",
      `| ${hover.p95.toFixed(2)} | ${hover.p99.toFixed(2)} | ${hover.poses} | ${hover.firstMs.toFixed(2)} | ${hover.sprites} | ${hover.skipped} |`, "",
    ].join("\n");
    fs.writeFileSync("motion-perf.md", report);
    console.log(report);
  } finally {
    host.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await evidence();
}
