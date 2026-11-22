import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, sleep } from "../qa/lib.ts";
import { QaApp } from "../qa/native/app.ts";
import { NT } from "../qa/native/harness.ts";
import { openFixture, type OpenFixture } from "./fixtures/open.ts";

export const NATIVE_APP = path.join(ROOT, "build/perf-native/Canvas QA.app");

type Mark = "paint" | "look" | "picture" | "imgs" | "load" | "engine" | "landed" | "epoch" | "snapshots";
type OpenMarks = Partial<Record<Mark, number | null>>;
type WarmMarks = { started?: number; finished?: number; error?: string };

export async function gpuWarm(app: QaApp, wait = false) {
  const deadline = performance.now() + 15_000;
  do {
    const result = await app.cmd<WarmMarks>({ op: "qa.gpuwarm" });
    if (!wait || result.finished || result.error) return result;
    await sleep(50);
  } while (performance.now() < deadline);
  throw new Error("GPU warm-up did not report");
}

export async function measureOpen(app: QaApp, file: string, timeout = 12_000, memory = false) {
  const tab = new NT(app, file);
  const start = performance.now();
  await app.openShown(file);
  const deadline = start + timeout;
  let result: OpenMarks | null;
  let nextTrace = 0, peakBytes = 0;
  let peakRoles: Record<string, number> | undefined, peakPageBytes = 0, webPages: number | undefined;
  do {
    result = await tab.js<OpenMarks | null>(`return new URL(location.href).searchParams.get("file") === ${JSON.stringify(file)}
      && window.canvasHost?.perf ? { ...window.canvasHost.perf, epoch: performance.timeOrigin, now: performance.now() } : null;`).catch(() => null);
    if (memory && (performance.now() >= nextTrace || result?.load != null)) {
      const sample = await app.cmd<{ bytes: number; pageBytes?: number; pages?: number; roles?: Record<string, number> }>({ op: "qa.memory", args: { file } }).catch(() => null);
      peakPageBytes = Math.max(peakPageBytes, sample?.pageBytes ?? 0);
      if (sample && sample.bytes > peakBytes) { peakBytes = sample.bytes; peakRoles = sample.roles; webPages = sample.pages; }
    }
    if (result?.picture != null && result.load != null) break;
    if (performance.now() >= nextTrace) {
      nextTrace = performance.now() + 500;
      if (!process.argv.includes("--trace") || !result) continue;
      const trace = await tab.js(`const s = window.__canvas?.stats(), ev = window.canvasHost?.engineView;
        return { now: Math.round(performance.now()), boards: s?.boards, images: ev?.imageStats(), pending: ev?.imagesPending(),
          gpuImages: s?.imageLevels, gpuBytes: s?.imageBytes, missing: s?.tilesMissing, unattached: s?.imagesUnattached,
          tiles: s?.tileCount, renderedMpx: s?.renderedMpx, tileBytes: s?.tileBytes, wasmBytes: s?.wasmBytes, memory: ${peakBytes} };`).catch(() => null);
      if (trace) console.log("open trace", JSON.stringify(trace));
    }
    await sleep(60);
  } while (performance.now() < deadline);
  const status = await tab.js(`const s = window.__canvas?.stats(), view = window.canvasHost?.engineView;
    return s ? { rendererInitMs: s.rendererInitMs, boards: s.boards, visibleBoards: s.visibleBoards,
      missing: s.tilesMissing, tileWork: s.tileWork, errors: s.errors, settled: window.__canvas.settled(),
      zoom: window.canvasHost.cam?.z, images: view?.imageStats(), pending: view?.imagesPending() } : null;`).catch(() => null);
  return { ...result, ...(memory ? { peakBytes, peakPageBytes, peakRoles, webPages } : {}), status };
}

export async function openImages(app: QaApp, file: string, timeout?: number, memory = false) {
  const first = await measureOpen(app, file, timeout, memory);
  if (process.argv.includes("--trace")) console.log("first", JSON.stringify(first));
  const tab = new NT(app, file);
  await sleep(1000); // Let the preview and snapshot writes finish before closing.
  await tab.cmd("close", { file });
  return { first, second: await measureOpen(app, file, timeout, memory) };
}

export function openSeven(app: QaApp, second = false) {
  return measureOpen(app, openFixture(app.docs, "seven", second ? "warm.canvas" : "first.canvas"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-native-open-")));
  try {
    const count = Number(process.argv[2] ?? 3);
    const kind = (process.argv[3] ?? "seven") as OpenFixture;
    const wait = process.argv.includes("--ready");
    const imageKind = kind === "images" || kind === "images-10k";
    const fixtureArg = process.argv.find((arg) => arg.startsWith("--fixture="))?.slice("--fixture=".length);
    const seed = imageKind ? fixtureArg ?? openFixture(root, kind) : null;
    for (let i = 0; i < count; i++) {
      const app = new QaApp(root, i + 1);
      try {
        const images = seed ? path.join(app.docs, kind + ".canvas") : null;
        const staged = images && (wait || kind === "images-10k") ? path.join(app.dir, "staged.canvas") : images;
        if (seed && staged) fs.cpSync(seed, staged, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
        await app.start(NATIVE_APP);
        if (wait) console.log("startup", JSON.stringify(await gpuWarm(app, true)));
        if (staged && images && staged !== images) fs.renameSync(staged, images);
        if (kind === "seven") {
          console.log("first", JSON.stringify(await openSeven(app)));
          console.log("warm", JSON.stringify(await openSeven(app, true)));
        } else if (images) {
          console.log("images", JSON.stringify(await openImages(app, images, kind === "images-10k" ?
            (Number(process.env.CANVAS_OPEN_TIMEOUT_MS) || 15_000) : undefined, kind === "images-10k")));
        } else {
          console.log(kind, JSON.stringify(await measureOpen(app, openFixture(app.docs, kind))));
        }
        if (process.argv.includes("--trace")) console.log("startup", JSON.stringify(await gpuWarm(app)));
      } catch (error) {
        if (process.argv.includes("--trace")) console.error(app.serverLog.slice(-4).join(""), app.log().split("\n").slice(-8).join("\n"));
        throw error;
      } finally {
        await app.stop();
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
