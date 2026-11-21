import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import { drawRect } from "../src/page/draw-logic.js";

test("Shift keeps the larger dimension in every drag direction", () => {
  assert.deepEqual(drawRect({ x: 20, y: 30 }, { x: 5, y: 35 }, { square: true }),
    { x: 5, y: 30, w: 15, h: 15 });
});

test("Option draws from the center, with or without Shift", () => {
  const start = { x: 20, y: 30 }, end = { x: 14, y: 40 };
  assert.deepEqual(drawRect(start, end, { centered: true }), { x: 14, y: 20, w: 12, h: 20 });
  assert.deepEqual(drawRect(start, end, { centered: true, square: true }), { x: 10, y: 20, w: 20, h: 20 });
});

test("Snap resolves each axis and keeps modifier constraints", () => {
  const start = { x: 9, y: 15 }, end = { x: 20, y: 12 };
  const snap = (value: number) => Math.round(value / 8) * 8;
  assert.deepEqual(drawRect(start, end, { snap }), { x: 8, y: 16, w: 16, h: 0 });
  assert.deepEqual(drawRect(start, end, { snap, centered: true, square: true }), { x: -8, y: 0, w: 32, h: 32 });
});

test("Pixel snapping is optional and click sizes remain exact", () => {
  const p = { x: 2.25, y: 4.75 }, end = { x: 12.75, y: 21.25 };
  assert.deepEqual(drawRect(p, end), { x: 2.25, y: 4.75, w: 10.5, h: 16.5 });
  assert.deepEqual(drawRect(p, p, { snap: Math.round, click: true }), { x: 2, y: 5, w: 100, h: 100 });
});
