import { openFixture } from "../../bench/fixtures/open.ts";
import { stats } from "../../bench/lib.ts";
import { gpuWarm, measureOpen } from "../../bench/native-open.ts";
import { recordFrameGaps } from "../frames.ts";
import { center, Fail, sc, type NT } from "./harness.ts";

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
