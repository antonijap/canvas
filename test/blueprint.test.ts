import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore: browser modules
import { gridLines } from "../src/page/blueprint.js";
// @ts-ignore: browser modules
import { snapIndex, snapRect } from "../src/page/snap.js";
// @ts-ignore: browser modules
import { edgeSnapper, snapTurnedHandle } from "../src/page/live-edit.js";

test("blueprint hides minor lines below six screen pixels and keeps major lines", () => {
  assert.deepEqual(gridLines(0, 0.25, 40, 1, 8, 8), { minor: [], major: [0, 16, 32] });
  assert.deepEqual(gridLines(0, 0.75, 20, 1, 8, 8), { minor: [6, 12, 18], major: [0] });
  assert.deepEqual(gridLines(-3.3, 1, 40, 2, 8, 1), { minor: [], major: [13, 29] });
});

test("blueprint snaps either edge, or the origin for boards, on both axes", () => {
  const rect = { x: -10, y: 22, w: 17, h: 17 };
  assert.deepEqual(snapRect(null, rect, { grid: 8 }), { x: -9, y: 23, guides: [] });
  assert.deepEqual(snapRect(null, rect, { grid: 8, gridOrigin: true }), { x: -8, y: 24, guides: [] });
});

test("resize chooses the closest object or grid line within the screen threshold", () => {
  const index = snapIndex([{ x: 25, y: 100, w: 12, h: 12 }]);
  const snap = edgeSnapper(index, 4, 6, 8);
  assert.equal(snap("x", 24.8), 25);
  assert.equal(snap("x", -7), -8);
  assert.equal(snap("x", -5), -5);
});


test("a turned side handle can land on a grid line along its own axis", () => {
  const delta = snapTurnedHandle({ w: 20, h: 20 }, { x: 0, y: 1 }, "e", 45, { x: 0, y: 0 }, 8, 6);
  assert.ok(Math.abs((10 + delta.x) * Math.SQRT1_2 - 8) < 1e-9);
  assert.equal(delta.y, 0);
});
