import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decodePng } from "../../fidelity/png.ts";
import { openFixture } from "../../bench/fixtures/open.ts";
import { IMAGE_BOARDS, IMAGE_FILES, OVERVIEW_BOARDS, OVERVIEW_FILES } from "../../bench/fixtures/images.ts";
import { stats } from "../../bench/lib.ts";
import { gpuWarm, measureOpen, openImages } from "../../bench/native-open.ts";
import { measureOpeningPicture, openingState, recentCard } from "../../bench/native-opening-picture.ts";
import { recordFrameGaps } from "../frames.ts";
import { sleep } from "../lib.ts";
import { center, Fail, NT, sc } from "./harness.ts";

export async function measureNativeDrag(t: NT, id: string) {
  await t.selectIds([id]);
  await t.settle();
  const from = center(await t.rect(id));
  const to = { x: from.x + 80, y: from.y + 40 };
  const gaps = await recordFrameGaps((js) => t.js(`return ${js};`),
    () => t.drag(from, to, { steps: 60, mods: ["cmd"] }));
  const after = center(await t.rect(id));
  if (Math.hypot(after.x - from.x, after.y - from.y) < 10) throw new Fail("drag did not move the layer");
  return stats(gaps).p95;
}

sc("performance", "records native drag frame timing", { covers: [] }, async (t) => {
  await t.showPage("layout");
  t.note(`drag p95 ${await measureNativeDrag(t, "r_free")} ms`);
});

for (const kind of ["empty", "many"] as const) {
  sc("open", `the ${kind} fixture reaches an exact picture and full load`, { covers: [] }, async (t: NT) => {
    const file = openFixture(t.app.docs, kind);
    try {
      const perf = await measureOpen(t.app, file);
      t.ok(perf.picture != null && perf.picture < 12_000, `exact picture: ${JSON.stringify(perf)}`);
      t.ok(perf.load != null && perf.load < 12_000, `full load: ${JSON.stringify(perf)}`);
    } finally {
      await t.cmd("close", { file });
    }
  });
}

sc("open", "startup GPU warm-up finishes before a later file opens", { startEmpty: true, covers: [] }, async (t: NT) => {
  for (const file of (await t.state()).openFiles) await t.cmd("close", { file });
  await t.app.relaunch();
  const warm = await gpuWarm(t.app, true);
  t.ok(warm.started != null && warm.finished != null && warm.finished >= warm.started && !warm.error,
    `startup GPU warm-up: ${JSON.stringify(warm)}`);
  const file = openFixture(t.app.docs, "seven");
  try {
    const perf = await measureOpen(t.app, file);
    t.ok(perf.epoch != null && perf.epoch >= warm.finished && perf.picture != null,
      `the file has an exact picture after startup warm-up: ${JSON.stringify(perf)}`);
  } finally {
    await t.cmd("close", { file });
  }
});

sc("open-images-2000", "draws two thousand screenshots at fit and sharpens on zoom", { covers: ["render:image", "render:open-cache"] }, async (t: NT) => {
  const file = openFixture(t.app.docs, "images");
  await sleep(20); // Let closed bridge sockets drain after synchronous fixture generation.
  try {
    const { first: perf, second } = await openImages(t.app, file);
    t.note(JSON.stringify({ first: perf, second }));
    t.ok(perf.look != null && perf.look < 3000, "the whole overview appears within three seconds");
    t.ok(perf.imgs != null && perf.load != null && perf.picture != null &&
      Math.max(perf.imgs, perf.load, perf.picture) < 6000, "all pictures draw within six seconds");
    t.ok(second.look != null && second.load != null && second.load < 1500, "the same file redraws within 1.5 seconds");
    const view = new NT(t.app, file);
    const fit = await view.js<{ visible: number; bytes: number; count: number; hits: number; uploaded: number }>(`const stats = window.__canvas.stats();
      const imgs = window.canvasHost.engineView.imageStats();
      return { visible: stats.visibleBoards, bytes: imgs.decodedBytes, count: imgs.images, hits: imgs.previewHits, uploaded: stats.imageLevels };`);
    t.eq(fit.visible, IMAGE_BOARDS, "every board is in view");
    t.eq(fit.count, IMAGE_FILES, "all distinct images are registered");
    t.eq(fit.hits, IMAGE_FILES, "reopen reuses every preview");
    t.eq(fit.uploaded, IMAGE_FILES, "all distinct images reach the GPU");
    t.ok(fit.bytes > 0 && fit.bytes < 20 * 1024 * 1024, "the overview holds small decodes");
    await view.look(39 * 430 + 195, 12 * 884 + 422, 3);
    await view.waitJs("window.canvasHost.engineView.imagesPending() === 0", "the sharper images to finish decoding");
    await view.settle();
    const full = await view.js<number>("return window.canvasHost.engineView.imageStats().full;");
    t.ok(full > 0, "zoom loads original-resolution pixels");
  } finally {
    await t.cmd("close", { file });
  }
});

sc("open-images-10k", "draws ten thousand distinct JPEGs at fit and sharpens on zoom", { covers: ["render:image", "render:open-cache"], startEmpty: true }, async (t: NT) => {
  await gpuWarm(t.app, true);
  const file = openFixture(t.app.docs, "images-10k");
  await sleep(20);
  try {
    const { first, second } = await openImages(t.app, file, 12_000, true);
    t.note(JSON.stringify({ first, second }));
    t.ok(first.look != null && first.look < 3000, "the overview appears within three seconds");
    t.ok(first.imgs != null && first.load != null && first.load < 10_000, "all images draw within ten seconds");
    t.ok(second.imgs != null && second.load != null && second.load < 2000, "the same file redraws within two seconds");
    t.ok([first.peakPageBytes, second.peakPageBytes].every((bytes) => bytes && bytes < 1e9), "the document renderer peaks below one GB");
    t.ok((second.status?.images?.decodedBytes ?? Infinity) < 24 * 1024 * 1024, "the overview holds less than 24 MiB of JPEG pixels");
    const view = new NT(t.app, file);
    t.eq(second.status?.visibleBoards, OVERVIEW_BOARDS, "every board is in view");
    t.eq(second.status?.images?.images, OVERVIEW_FILES, "every distinct JPEG is registered");
    t.eq(second.status?.images?.previewHits, OVERVIEW_FILES, "reopen reuses every validated JPEG preview");
    const colors = await view.js<number[][]>(`const { cam, engineView } = window.canvasHost, dpr = devicePixelRatio;
      const crops = [2, 974, 1997].map((i) => ({
        sx: Math.round((cam.x + (i % 50 * 1480 + 155) * cam.z) * dpr),
        sy: Math.round((cam.y + (Math.floor(i / 50) * 700 + 325) * cam.z) * dpr),
        sw: 1, sh: 1, w: 1, h: 1,
      }));
      return engineView.capture(crops).map((c) => [...c.getContext("2d").getImageData(0, 0, 1, 1).data]);`);
    t.ok(colors.every((rgba) => rgba[3] === 255 && rgba.slice(0, 3).every((v) => v > 80 && v < 245)),
      "JPEG pixels are visible across the overview");
    await view.look(24 * 1480 + 715, 19 * 700 + 325, 3);
    await view.waitJs("window.canvasHost.engineView.imageStats().full > 0", "the original-resolution images to draw");
    await view.settle();
  } finally {
    await t.cmd("close", { file });
  }
});

for (const kind of ["launch-last-file", "open-recent"] as const) {
  sc("open-picture", `${kind} presents the saved view and replaces it with the exact frame`,
    { startEmpty: true, covers: ["render:open-cache"] }, async (t: NT) => {
      const samples = [];
      for (const count of [7, 36, 72, 120, 150]) samples.push(await measureOpeningPicture(t.app, kind, count));
      t.note(JSON.stringify(samples));
      t.ok(samples.every(s => s.saved), "each opening used a validated saved picture");
      t.ok(stats(samples.map(s => s.picture)).p50 <= (kind === "launch-last-file" ? 300 : 150), "median picture latency");
      t.ok(stats(samples.map(s => s.live)).p50 <= (kind === "launch-last-file" ? 1200 : 600), "median exact latency");
    });
}

sc("open-picture", "Home captures actual canvas pixels and rejects an old theme or replaced image",
  { startEmpty: true, covers: ["home:thumbnail", "render:open-cache"] }, async (t: NT) => {
    const file = openFixture(t.app.docs, "seven", "Saved view.canvas");
    const key = createHash("sha256").update(file).digest("hex").slice(0, 32);
    const picture = path.join(t.app.dir, "state", "opening-pictures", key + ".plist");
    const view = new NT(t.app, file);
    try {
      await t.cmd("qa.theme", { theme: "light" });
      t.ok((await measureOpen(t.app, file)).picture != null, "the sample draws");
      let card = await recentCard(view, file);
      await t.waitFor(async () => fs.existsSync(picture), "Home to save the view").catch(async error => {
        t.note(JSON.stringify(await openingState(t.app)));
        throw error;
      });
      const png = execFileSync("plutil", ["-extract", "png", "raw", "-o", "-", picture], { maxBuffer: 20 << 20 });
      const decoded = decodePng(Buffer.from(png.toString(), "base64"));
      let coloured = 0;
      for (let i = 0; i < decoded.data.length; i += 16) {
        const [r, g, b, a] = decoded.data.subarray(i, i + 4);
        if (a > 240 && Math.max(r, g, b) - Math.min(r, g, b) > 36) coloured++;
      }
      t.ok(coloured > 1000, "the saved pixels include the coloured artwork");

      await t.cmd("close", { file });
      await t.waitState(s => s.homeShown && !s.openFiles.includes(file), "the sample tab to close");
      await t.cmd("qa.theme", { theme: "dark" });
      await t.click(card);
      await t.waitFor(async () => (await openingState(t.app)).live != null, "the dark view to draw");
      t.eq((await openingState(t.app)).saved, undefined, "a light picture is rejected in the dark theme");

      await t.cmd("close", { file });
      await t.waitState(s => !s.openFiles.includes(file), "the dark sample tab to close");
      await t.cmd("qa.theme", { theme: "light" });
      card = await recentCard(view, file);
      fs.copyFileSync(path.join(file, "media", "img-1.png"), path.join(file, "media", "img-0.png"));
      await t.click(card);
      await t.waitFor(async () => (await openingState(t.app)).live != null, "the edited design to draw");
      t.eq((await openingState(t.app)).saved, undefined, "a changed image invalidates the saved view");
    } finally {
      await t.cmd("close", { file }).catch(() => {});
      await t.cmd("qa.theme", { theme: "system" });
      fs.rmSync(file, { recursive: true, force: true });
    }
  });
