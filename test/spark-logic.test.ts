// Talk to the selection on the canvas (src/page/spark-logic.js): the spark 8 px right of the selection box's corner,
// the composer 8 px right of the spark and never over the selection (flipping left, below, above), progress words.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a browser module without types
import * as L from "../src/page/spark-logic.js";

const area = { x: 0, y: 0, w: 1400, h: 900 };
const size = { w: 360, h: 220 };

describe("the spark", () => {
  test("8 px right of the selection box (1 px outside the layer), top-aligned with the box", () => {
    const sel = { x: 160, y: 180, w: 360, h: 345 };
    assert.deepEqual(L.sparkAt(sel, area), { x: 160 + 360 + 1 + 8, y: 179 });
  });
  test("follows the camera: world to screen", () => {
    assert.deepEqual(L.toScreen({ x: 664, y: 60, w: 236, h: 92 }, { x: -1128, y: 218, z: 2 }), { x: 200, y: 338, w: 472, h: 184 });
  });
  test("hidden off screen; slides back in along the edge when only its corner is off", () => {
    assert.equal(L.sparkAt({ x: 2000, y: 100, w: 100, h: 100 }, area), null);
    assert.equal(L.sparkAt(null, area), null);
    const tall = L.sparkAt({ x: 100, y: -500, w: 200, h: 2000 }, area);
    assert.equal(tall.y, 4, "stays in view at the top");
    const wide = L.sparkAt({ x: 1200, y: 100, w: 400, h: 100 }, area);
    assert.equal(wide.x, 1400 - 28 - 4);
  });
  test("union of a multi-selection", () => {
    assert.deepEqual(L.unionRects([{ x: 0, y: 0, w: 10, h: 10 }, null, { x: 20, y: -5, w: 5, h: 5 }]), { x: 0, y: -5, w: 25, h: 15 });
    assert.equal(L.unionRects([]), null);
  });
});

describe("the composer", () => {
  test("right of the spark with an 8 px gap, top-aligned (the design)", () => {
    const sel = { x: 160, y: 180, w: 360, h: 345 };
    const sp = L.sparkAt(sel, area);
    assert.deepEqual(L.composerAt(sel, sp, size, area), { x: sp.x + 28 + 8, y: sp.y, side: "right" });
  });
  test("no room on the right: to the left of the selection, never over it", () => {
    const sel = { x: 800, y: 200, w: 400, h: 200 };
    const p = L.composerAt(sel, L.sparkAt(sel, area), size, area);
    assert.equal(p.side, "left");
    assert.equal(p.x + size.w, sel.x - 1 - 8);
  });
  test("no room either side: below, clear of the size badge; then above", () => {
    const sel = { x: 200, y: 100, w: 1000, h: 300 };
    const p = L.composerAt(sel, L.sparkAt(sel, area), size, area);
    assert.equal(p.side, "below");
    assert.ok(p.y >= sel.y + sel.h + 1 + 26 + 8);
    const low = { x: 200, y: 500, w: 1000, h: 300 };
    const q = L.composerAt(low, L.sparkAt(low, area), size, area);
    assert.equal(q.side, "above");
    assert.equal(q.y + size.h, low.y - 1 - 8);
  });
  test("a selection that fills the view: the composer hugs the right edge", () => {
    const sel = { x: 0, y: 0, w: 1400, h: 900 };
    const p = L.composerAt(sel, L.sparkAt(sel, area), size, area);
    assert.equal(p.side, "over");
    assert.equal(p.x, 1400 - 8 - 360);
  });
  test("the shell's islands (insets) are not room", () => {
    const a = L.visibleArea({ w: 1400, h: 900 }, { l: 250, t: 50, r: 300, b: 0 });
    assert.deepEqual(a, { x: 250, y: 50, w: 850, h: 850 });
    const sel = { x: 700, y: 200, w: 200, h: 200 };
    assert.equal(L.composerAt(sel, L.sparkAt(sel, a), size, a).side, "left", "the right island leaves no room");
    const narrow = { x: 500, y: 200, w: 300, h: 200 };
    assert.equal(L.composerAt(narrow, L.sparkAt(narrow, a), size, a).side, "below", "nor the left one");
  });
});

describe("words", () => {
  test("the ring: sweep half way through the step under way, its tooltip", () => {
    assert.equal(L.ringSweep({ label: "Softening the shadow", index: 3, total: 4 }), 225);
    assert.equal(L.ringSweep(null), 90);
    assert.deepEqual(L.ringTip({ label: "Softening the shadow", index: 3, total: 4 }), { label: "Softening the shadow", count: "3 of 4" });
    assert.deepEqual(L.ringTip({ label: "Reading the layers", index: 1, total: 1 }), { label: "Reading the layers", count: "" });
  });
  test("times", () => {
    const now = new Date(2026, 10, 16, 12, 0).getTime();
    assert.equal(L.relDay(new Date(2026, 10, 16, 8, 5).getTime(), now), "08:05");
    assert.equal(L.relDay(new Date(2026, 10, 15, 18, 40).getTime(), now), "Yesterday");
    assert.equal(L.relDay(new Date(2026, 10, 10, 9, 0).getTime(), now), "Tue");
    assert.equal(L.relDay(new Date(2026, 10, 9, 9, 0).getTime(), now), "9 Nov");
    assert.equal(L.whenLong(new Date(2026, 10, 15, 18, 40).getTime(), now), "Yesterday, 18:40");
    assert.equal(L.whenLong(new Date(2026, 10, 16, 8, 5).getTime(), now), "Today, 08:05");
  });
  test("outcomes and counts", () => {
    assert.equal(L.outcomeWord({ status: "done" }), "Kept");
    assert.equal(L.outcomeWord({ status: "done", outcome: "undone" }), "Undone");
    assert.equal(L.outcomeWord({ status: "stopped" }), "Stopped");
    assert.equal(L.layersWord(1), "1 layer");
    assert.equal(L.layersWord(9), "9 layers");
  });
});
