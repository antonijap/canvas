import { openFixture } from "../../bench/fixtures/open.ts";
import { IMAGE_BOARDS, IMAGE_FILES } from "../../bench/fixtures/images.ts";
import { stats } from "../../bench/lib.ts";
import { gpuWarm, measureOpen, openImages } from "../../bench/native-open.ts";
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

sc("open", "startup GPU warm-up finishes before a later file opens", { covers: [] }, async (t: NT) => {
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
