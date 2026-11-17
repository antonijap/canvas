// Zoom and view (src/page/navigate-logic.js): the zoom keys, pan by arrows, the pixel grid from 400%, ruler
// ticks, guides dropped on boards and saved in their metadata; the board metas carry the guides (src/boards.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boardsOf } from "../src/boards.ts";
import * as N from "../src/page/navigate-logic.js";

const key = (o: Record<string, unknown>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", code: "", ...o });

describe("keys", () => {
  test("Shift+= and Shift+- zoom; Command's own zoom keys are not taken", () => {
    assert.deepEqual(N.navKey(key({ shiftKey: true, key: "+", code: "Equal" })), { op: "in" });
    assert.deepEqual(N.navKey(key({ shiftKey: true, key: "_", code: "Minus" })), { op: "out" });
    assert.equal(N.navKey(key({ metaKey: true, key: "=", code: "Equal" })), null);
    assert.equal(N.navKey(key({ key: "-", code: "Minus" })), null, "a bare minus does nothing");
  });
  test("arrows pan only with nothing selected; Shift pans further; the view moves the arrow's way", () => {
    assert.deepEqual(N.navKey(key({ key: "ArrowRight" })), { op: "pan", dx: -N.PAN_STEP, dy: 0 });
    assert.deepEqual(N.navKey(key({ key: "ArrowUp", shiftKey: true })), { op: "pan", dx: 0, dy: N.PAN_STEP_BIG });
    assert.equal(N.navKey(key({ key: "ArrowRight" }), { selected: true }), null, "with a selection arrows nudge");
    assert.equal(N.navKey(key({ key: "ArrowRight", metaKey: true })), null);
  });
  test("Cmd+' pixel grid, Shift+R rulers", () => {
    assert.deepEqual(N.navKey(key({ metaKey: true, key: "'", code: "Quote" })), { op: "grid" });
    assert.deepEqual(N.navKey(key({ shiftKey: true, key: "R", code: "KeyR" })), { op: "rulers" });
    assert.equal(N.navKey(key({ shiftKey: true, metaKey: true, altKey: true, code: "KeyR" })), null, "Opt+Cmd+Shift+R stays resize to fit");
  });
});

describe("numbers", () => {
  test("zoom about a point keeps that point still, clamped to 2% and 25600%", () => {
    const c = N.zoomAbout({ x: 100, y: 50, z: 1 }, 2, 300, 200);
    assert.deepEqual(c, { z: 2, x: -100, y: -100 });
    // The world point under (300, 200) before and after.
    assert.equal((300 - 100) / 1, (300 - c.x) / c.z);
    assert.equal(N.zoomAbout({ x: 0, y: 0, z: 1 }, 1000, 0, 0).z, 256);
    assert.equal(N.zoomAbout({ x: 0, y: 0, z: 1 }, 0.0001, 0, 0).z, 0.02);
  });
  test("the pixel grid: none below 400%, a line per whole pixel from 400%", () => {
    assert.deepEqual(N.gridLines(0, 3.9, 100), []);
    assert.deepEqual(N.gridLines(0, 4, 17), [0.5, 4.5, 8.5, 12.5, 16.5]);
    assert.deepEqual(N.gridLines(-2, 8, 20), [6.5, 14.5], "offset camera");
  });
  test("ruler steps stay readable at every zoom", () => {
    assert.equal(N.rulerStep(1), 100);
    assert.equal(N.rulerStep(0.1), 1000);
    assert.equal(N.rulerStep(8), 10);
    assert.equal(N.rulerStep(64), 1);
    const { ticks } = N.rulerTicks(-50, 1, 300);
    assert.deepEqual(ticks.map((t: { value: number }) => t.value), [100, 200, 300]);
  });
  test("a guide lands on the topmost board under the drop, at a whole px offset; nothing off the boards", () => {
    const boards = [{ id: "A", x: 0, y: 0, w: 100, h: 100 }, { id: "B", x: 50, y: 50, w: 100, h: 100 }];
    assert.deepEqual(N.dropGuide("x", { x: 70.4, y: 70 }, boards), { board: "B", at: 20 });
    assert.deepEqual(N.dropGuide("y", { x: 10, y: 33.6 }, boards), { board: "A", at: 34 });
    assert.equal(N.dropGuide("x", { x: 500, y: 500 }, boards), null);
  });
  test("a guide under the pointer, within its span", () => {
    const g = [{ board: "A", index: 0, axis: "x", at: 100, from: 0, to: 200 }, { board: "A", index: 1, axis: "y", at: 50, from: 0, to: 300 }];
    assert.equal(N.guideAt(g, 102, 150)?.index, 0);
    assert.equal(N.guideAt(g, 150, 49)?.index, 1);
    assert.equal(N.guideAt(g, 100, 260), null, "past the board's edge");
  });
  test("guides go into metadata beside what is there; the last one removed takes the key away", () => {
    assert.deepEqual(N.withGuides({ type: "canvas", canvasLayout: { wrap: true } }, [{ axis: "x", at: 8 }]), { type: "canvas", canvasLayout: { wrap: true }, canvasGuides: [{ axis: "x", at: 8 }] });
    assert.deepEqual(N.withGuides(null, [{ axis: "y", at: 1 }]), { type: "canvas", canvasGuides: [{ axis: "y", at: 1 }] });
    assert.equal(N.withGuides({ type: "canvas", canvasGuides: [{ axis: "x", at: 8 }] }, []), null);
    assert.deepEqual(N.withGuides({ note: 1, canvasGuides: [] }, []), { note: 1 });
  });
  test("board metas carry their well-formed guides, and none when there are none", () => {
    const metas = boardsOf({ version: "2.21", children: [
      { type: "frame", id: "A", x: 0, y: 0, width: 10, height: 10, metadata: { type: "canvas", canvasGuides: [{ axis: "x", at: 4 }, { axis: "z", at: 1 }, { axis: "y", at: "2" }] } },
      { type: "frame", id: "B", x: 0, y: 0, width: 10, height: 10 },
    ] } as any);
    assert.deepEqual(metas[0].guides, [{ axis: "x", at: 4 }]);
    assert.equal("guides" in metas[1], false);
  });
});
