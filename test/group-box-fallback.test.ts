// The HTML fallback renderer (src/doc/render/html.ts, used without WebGPU) sizes a group like the engine does
// (engine/src/layout.rs, a_group_box_covers_a_turned_layer_above_its_corner): the union of its layers' boxes,
// a turned layer's corners included, even where they lie left of or above the group's own corner.

import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { layout, shutdownRenderer } from "../src/doc/render/index.ts";
import { tmpDir } from "./helpers.ts";

after(() => shutdownRenderer());

test("a group containing a turned layer is as big as the union of its layers", () => {
  const dir = tmpDir("group-box");
  const frame: any = { type: "frame", id: "r", x: 0, y: 0, width: 600, height: 600, layout: "none", children: [
    { type: "group", id: "g", x: 100, y: 150, children: [
      { type: "rectangle", id: "t", x: 0, y: 0, width: 100, height: 60, rotation: 45, fill: "#f00" },
      { type: "rectangle", id: "p", x: 140, y: 0, width: 80, height: 80, fill: "#00f" } ] } ] };
  const rects = layout([frame], { doc: { version: "2.8", children: [frame] } as any, file: path.join(dir, "doc.canvas.json") });
  const g = rects.g, t = rects.t, p = rects.p;
  const abs = (r: any) => [r.pageX, r.pageY, r.pageX + r.width, r.pageY + r.height];
  const [gx0, gy0, gx1, gy1] = abs(g);
  const [tx0, ty0] = abs(t), [, , px1, py1] = abs(p);
  assert.ok(Math.abs(gy0 - ty0) < 0.01, `the box starts at the turned layer's top (${gy0} vs ${ty0})`);
  assert.ok(gy0 < 150 - 70, `it reaches above the group's own y (${gy0})`);
  assert.ok(Math.abs(gx0 - Math.min(tx0, abs(p)[0])) < 0.01);
  assert.ok(gx1 >= px1 - 0.01 && gy1 >= py1 - 0.01);
  assert.ok(Math.abs(gy1 - Math.max(abs(t)[3], py1)) < 0.01);
});
