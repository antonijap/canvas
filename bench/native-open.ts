import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, sleep } from "../qa/lib.ts";
import { QaApp } from "../qa/native/app.ts";
import { NT } from "../qa/native/harness.ts";
import { openFixture, type OpenFixture } from "./fixtures/open.ts";

export const NATIVE_APP = path.join(ROOT, "build/perf-native/Canvas QA.app");

type Mark = "paint" | "look" | "picture" | "load" | "engine" | "landed" | "epoch";
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

export async function measureOpen(app: QaApp, file: string, timeout = 12_000) {
  const tab = new NT(app, file);
  const start = performance.now();
  await app.openShown(file);
  const deadline = start + timeout;
  let result: OpenMarks | null;
  do {
    result = await tab.js<OpenMarks | null>(`return new URL(location.href).searchParams.get("file") === ${JSON.stringify(file)}
      && window.canvasHost?.perf ? { ...window.canvasHost.perf, epoch: performance.timeOrigin, now: performance.now() } : null;`).catch(() => null);
    if (result?.picture != null && result.load != null) break;
    await sleep(60);
  } while (performance.now() < deadline);
  const status = await tab.js(`const s = window.__canvas?.stats();
    return s ? { rendererInitMs: s.rendererInitMs, boards: s.boards, visibleBoards: s.visibleBoards,
      missing: s.tilesMissing, tileWork: s.tileWork, errors: s.errors, settled: window.__canvas.settled() } : null;`).catch(() => null);
  return { ...result, status };
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
    for (let i = 0; i < count; i++) {
      const app = new QaApp(root, i + 1);
      try {
        await app.start(NATIVE_APP);
        if (wait) console.log("startup", JSON.stringify(await gpuWarm(app, true)));
        if (kind === "seven") {
          console.log("first", JSON.stringify(await openSeven(app)));
          console.log("warm", JSON.stringify(await openSeven(app, true)));
        } else {
          console.log(kind, JSON.stringify(await measureOpen(app, openFixture(app.docs, kind))));
        }
        if (process.argv.includes("--trace")) console.log("startup", JSON.stringify(await gpuWarm(app)));
      } finally {
        await app.stop();
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
