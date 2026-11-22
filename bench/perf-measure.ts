import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchChrome, type Chrome } from "../fidelity/cdp.ts";
import { recordFrameGaps } from "../qa/frames.ts";
import { freePort, openTab, sleep } from "../qa/lib.ts";
import { QaApp } from "../qa/native/app.ts";
import { NT } from "../qa/native/harness.ts";
import { measureNativeDrag } from "../qa/native/scenarios-perf.ts";
import { fixture, scratchCopy } from "./fixtures/gen.ts";
import { openFixture } from "./fixtures/open.ts";
import { Tab, wheelFrames } from "./latency.ts";
import { stats } from "./lib.ts";
import { gpuWarm, measureOpen, NATIVE_APP, openSeven } from "./native-open.ts";
import { INSTRUMENT } from "./page.ts";
import { startHost } from "./server.ts";
import { NATIVE_METRICS, type Metric } from "./perf-budgets.ts";

export const hasNativeBuild = () => process.platform === "darwin" && fs.existsSync(path.join(NATIVE_APP, "Contents/MacOS/Canvas"));

// QaApp uses the shard in its bundle identifier. Keep it unique across gate passes.
let nativeShard = 0;

export function measurements(imageSeedDir?: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-perf-gate-")));
  let chrome: Chrome | undefined;
  const browser = async () => chrome ??= await launchChrome([
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", "--disable-component-update", "--disable-sync",
  ]);

  async function web(id: Metric) {
    const large = id === "open-2000" || id === "server-memory";
    const dir = fs.mkdtempSync(path.join(root, "web-"));
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    let tab: Tab | undefined;
    try {
      const f = scratchCopy(fixture(large ? 2000 : 200), dir);
      const port = await freePort();
      // Browser startup is outside the file-open measurement.
      if (id !== "server-memory") tab = new Tab(await openTab((await browser()).port));
      if (id === "open-2000") {
        await tab!.page.send("Network.setCacheDisabled", { cacheDisabled: true });
        await tab!.page.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT(null) });
      }
      const t0 = performance.now();
      host = await startHost({ port, env: {
        CANVAS_ROOTS: dir, CANVAS_WEB_FONTS: "0", CANVAS_STATE_DIR: path.join(dir, "state"),
        CANVAS_WIDGETS_DIR: path.join(dir, "widgets"), CANVAS_TRUST_FILE: path.join(dir, "trust.json"),
        CANVAS_VIDEO_PROXIES: path.join(dir, "video"), CANVAS_LOG_DIR: path.join(dir, "logs"),
        CANVAS_MCP_NO_SPAWN: "1", BENCH_SERVER_PROF: "",
      } });
      const readyMs = performance.now() - t0;
      const base = `http://127.0.0.1:${port}`;
      const file = f.dir;
      if (id === "server-memory") {
        const response = await fetch(`${base}/api/doc?file=${encodeURIComponent(file)}`, { signal: AbortSignal.timeout(30_000) });
        const doc = await response.json();
        if (!response.ok || !doc) throw new Error(`document request returned ${response.status}`);
        return (await host.stats(true)).heapUsed / 2 ** 20;
      }
      await tab!.open(base, file, "page-1", id === "open-2000" ? 0 : 60_000);
      if (id === "open-2000") {
        const paint = await tab!.waitFor("window.__bench?.firstBoardPainted > 0 && window.__bench.firstBoardPainted", "the first board paint", 30_000);
        return readyMs + Number(paint);
      }

      const t = tab!;
      const hero = f.heroBoards[0];
      const move = `${hero}-card`;
      if (id === "edit-latency") {
        const layer = JSON.stringify(`${hero}-dot1`);
        const rect = await t.rect(`${hero}-dot1`);
        if (!rect) throw new Error("edit layer missing from fixture");
        await t.show(rect);
        await t.ev(`window.canvasHost.setSelection([${layer}])`);
        await t.frames(3);
        // Use the latency bench's input-to-paint probe. Alternating one-pixel nudges keeps the layer in view.
        const probe = `() => window.canvasHost.worldRectOf(${layer})?.x`;
        const samples: number[] = [];
        for (let i = 0; i < 60; i++) {
          const key = i % 2 ? "ArrowLeft" : "ArrowRight";
          const sample = await t.measure(probe, () => t.key(key, key, i % 2 ? 37 : 39), ["keydown"]);
          if (sample.ms === null) throw new Error(`edit did not paint: ${sample.why}`);
          samples.push(sample.ms);
        }
        return stats(samples).p95;
      }
      if (id === "pan-zoom-frames") {
        const gaps: number[] = [];
        for (const kind of ["pan", "zoom"] as const) {
          await t.fitPage();
          gaps.push(...await recordFrameGaps((js) => t.ev(js), async () => {
            if ((await wheelFrames(t, kind)).length < 10) throw new Error(`${kind} did not move the camera`);
          }));
          await t.settle();
        }
        return stats(gaps).p95;
      }
      const rect = await t.rect(move);
      if (!rect) throw new Error("drag layer missing from fixture");
      await t.show({ x: rect.x - 200, y: rect.y - 200, w: rect.w + 400, h: rect.h + 400 });
      await t.ev(`window.canvasHost.setSelection(${JSON.stringify([move])})`);
      await t.frames(3);
      const r = (await t.screenRect(move))!;
      const from = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      await t.move(from);
      const gaps = await recordFrameGaps((js) => t.ev(js), async () => {
        await t.down(from);
        try {
          await sleep(30);
          await t.move({ x: from.x + 10, y: from.y + 5 }, true);
          await t.frames(2);
          await t.modKey("meta", true);
          for (let i = 6; i <= 60; i++) {
            await t.move({ x: from.x + i * 2, y: from.y + i }, true);
            await sleep(16);
          }
        } finally {
          await t.up({ x: from.x + 120, y: from.y + 60 });
          await t.modKey("meta", false);
        }
      });
      await t.settle();
      if (Math.abs((await t.rect(move))!.x - rect.x) < 10) throw new Error("drag did not move the layer");
      return stats(gaps).p95;
    } finally {
      try {
        await tab?.close();
      } finally {
        if (host) {
          const exited = new Promise<void>((resolve) => host!.proc.once("exit", () => resolve()));
          if (host.proc.exitCode === null && host.proc.signalCode === null) {
            host.stop();
            const timer = setTimeout(() => host!.proc.kill("SIGKILL"), 3000);
            await exited;
            clearTimeout(timer);
          }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  async function native(id: Metric) {
    const app = new QaApp(root, ++nativeShard);
    try {
      const kind = id === "open-images-10k" ? "images-10k" : id === "open-images-2000" ? "images" : null;
      const images = kind && path.join(app.docs, kind + ".canvas");
      const staged = kind === "images-10k" ? path.join(app.dir, "staged.canvas") : images;
      if (kind && staged) {
        const seedDir = imageSeedDir ?? root;
        const seed = path.join(seedDir, kind + ".canvas");
        const fixture = fs.existsSync(path.join(seed, "document.json")) ? seed : openFixture(seedDir, kind);
        fs.cpSync(fixture, staged, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
      }
      let started = 0;
      await app.start(NATIVE_APP, () => { started = performance.now(); });
      if (id === "native-launch") {
        const paint = await app.cmd<{ method: string }>({ op: "qa.shot", args: { maxSide: 16 } });
        if (paint.method !== "windowServer") throw new Error("the window server returned no painted window");
        return performance.now() - started;
      }
      if (images) {
        if (staged && staged !== images) {
          await gpuWarm(app, true);
          fs.renameSync(staged, images);
        }
        const first = await measureOpen(app, images);
        if (first.look == null) throw new Error("the image overview never reached look");
        return first.look;
      }
      if (id === "open-first-7" || id === "open-warm-7") {
        const first = await openSeven(app);
        if (first.picture == null) throw new Error("the first file did not reach an exact picture");
        if (id === "open-first-7") return first.picture;
        const second = await openSeven(app, true);
        if (second.picture == null) throw new Error("the second file did not reach an exact picture");
        return second.picture;
      }
      const f = scratchCopy(fixture(200), app.docs);
      const t = new NT(app, f.dir);
      await app.openShown(f.dir);
      await t.waitState((state) => state.file === f.dir && state.pages.length > 0, "the stress fixture to open", 15_000);
      await t.settle();
      const layer = `${f.heroBoards[0]}-dot1`;
      const r = await t.js<{ x: number; y: number }>(`return window.canvasHost.worldRectOf(${JSON.stringify(layer)});`);
      await t.look(r.x, r.y);
      return await measureNativeDrag(t, layer);
    } finally {
      await app.stop();
    }
  }

  return {
    measure: (id: Metric) => NATIVE_METRICS.includes(id) ? native(id) : web(id),
    close: async () => {
      try { await chrome?.stop(); }
      finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  };
}
