import { stats } from "../../bench/lib.ts";
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
