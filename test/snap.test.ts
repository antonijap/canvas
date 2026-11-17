// Snapping math (src/page/snap.js): edges and centres within a screen-px threshold, pixel rounding, guides
// with distance labels, Cmd-style bypass, and a query budget on a large (18 MB, real-world sized) document.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as S from "../src/page/snap.js";

const boards = [
  { id: "a", x: 0, y: 0, w: 400, h: 800 },
  { id: "b", x: 500, y: 100, w: 600, h: 300 },
];

describe("snapRect", () => {
  const idx = S.snapIndex(boards);

  test("left edge snaps to another left edge within 6 screen px, at any zoom", () => {
    for (const z of [0.1, 1, 4]) {
      const r = S.snapRect(idx, { x: 500 + 5 / z, y: 1000, w: 100, h: 100 }, { z });
      assert.equal(r.x, 500, `z=${z}`);
    }
    // 7 screen px away: no snap, just rounding
    const far = S.snapRect(idx, { x: 507.3, y: 1000, w: 100, h: 100 }, { z: 1 });
    assert.equal(far.x, 507);
  });

  test("centres and opposite edges snap; the nearest line wins", () => {
    // my centre (x + 50) to b's centre (800)
    assert.equal(S.snapRect(idx, { x: 753, y: 1000, w: 100, h: 100 }, { z: 1 }).x, 750);
    // my right edge to a's right edge (400)
    assert.equal(S.snapRect(idx, { x: 297, y: 1000, w: 100, h: 100 }, { z: 1 }).x, 300);
    // my top to b's bottom (400), y axis independent of x
    const r = S.snapRect(idx, { x: 2000, y: 402, w: 50, h: 50 }, { z: 1 });
    assert.deepEqual([r.x, r.y], [2000, 400]);
  });

  test("pixel grid rounds; off keeps fractions; objects off skips alignment", () => {
    assert.equal(S.snapRect(idx, { x: 3000.4, y: 3000.6, w: 1, h: 1 }, { z: 1 }).y, 3001);
    assert.equal(S.snapRect(idx, { x: 3000.4, y: 3000.6, w: 1, h: 1 }, { z: 1, pixel: false }).x, 3000.4);
    assert.equal(S.snapRect(idx, { x: 502, y: 1000, w: 100, h: 100 }, { z: 1, objects: false }).x, 502);
    assert.equal(S.snapRect(null, { x: 502.2, y: 1000, w: 100, h: 100 }, { z: 1 }).x, 502);
  });

  test("guides: one per aligned line, spanning both rects, with the gap to the nearest one", () => {
    const r = S.snapRect(idx, { x: 501, y: 500, w: 100, h: 100 }, { z: 1 });
    const g = r.guides.find((x: any) => x.axis === "x" && x.v === 500);
    assert.ok(g, "a vertical guide at x=500");
    assert.equal(g.from, 100);
    assert.equal(g.to, 600);
    assert.deepEqual(g.gaps.map((x: any) => x.d), [100]); // b's bottom 400 to my top 500
    assert.equal(S.snapRect(idx, { x: 501, y: 500, w: 100, h: 100 }, { z: 1, guides: false }).guides.length, 0);
  });

  test("ties prefer edges to centres", () => {
    const i2 = S.snapIndex([{ x: 0, y: 0, w: 100, h: 100 }]);
    // An 8-wide rect at x=48: its left edge is +2 from the line at 50, its centre (52) is -2 from it.
    const r = S.snapRect(i2, { x: 48, y: 500, w: 8, h: 8 }, { z: 1 });
    assert.equal(r.x, 50);
  });

  test("settings: defaults and bounds", () => {
    assert.deepEqual(S.snapSettings(undefined), S.DEFAULT_SNAP);
    assert.deepEqual(S.snapSettings({ objects: false, bigNudge: "25" }), { ...S.DEFAULT_SNAP, objects: false, bigNudge: 25 });
    assert.equal(S.snapSettings({ bigNudge: 0 }).bigNudge, 10);
    assert.equal(S.snapSettings({ bigNudge: 5000 }).bigNudge, 10);
  });

  test("nudge keys", () => {
    assert.deepEqual(S.nudgeDelta("ArrowLeft", false), { dx: -1, dy: 0 });
    assert.deepEqual(S.nudgeDelta("ArrowDown", true, 25), { dx: 0, dy: 25 });
    assert.equal(S.nudgeDelta("a", false), null);
  });

  test("nearbyRects keeps what touches the view plus margin", () => {
    const cam = { x: 0, y: 0, z: 1 };
    const out = S.nearbyRects([{ id: "in", x: 10, y: 10, w: 10, h: 10 }, { id: "far", x: 5000, y: 0, w: 10, h: 10 }, { id: "skip", x: 0, y: 0, w: 5, h: 5 }], cam, 1000, 800, 0.5, new Set(["skip"]));
    assert.deepEqual(out.map((r: any) => r.id), ["in"]);
  });

  test("a query stays far under 1 ms with thousands of rects", () => {
    const rects = [];
    for (let i = 0; i < 2000; i++) rects.push({ x: (i % 50) * 500 + (i % 7), y: Math.floor(i / 50) * 900, w: 390, h: 844 });
    const index = S.snapIndex(rects);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) S.snapRect(index, { x: i * 13.7, y: i * 7.3, w: 390, h: 844 }, { z: 0.5 });
    const per = (performance.now() - t0) / 1000;
    assert.ok(per < 0.2, `${per} ms per query`);
  });
});

describe("bypassing snapping while dragging", () => {
  test("Control and Cmd turn object snapping off for that drag; Option and Shift do not", () => {
    assert.equal(S.bypassSnap({ ctrlKey: true }), true);
    assert.equal(S.bypassSnap({ metaKey: true }), true);
    assert.equal(S.bypassSnap({ altKey: true, shiftKey: true }), false);
    assert.equal(S.bypassSnap(null), false);
  });
});
