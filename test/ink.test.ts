// qa/ink.ts: the visible ink of a control, measured from pixels, which the alignment scenarios of pnpm qa and
// pnpm qa:native rely on to say an icon is optically centred.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Img } from "../fidelity/png.ts";
import { inkBox } from "../qa/ink.ts";

function canvas(w: number, h: number, c: [number, number, number]): Img {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255; }
  return { width: w, height: h, data };
}
/** Paints a rect with coverage: a fractional edge blends like an antialiased one. */
function rect(img: Img, x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
    const cov = Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0)) * Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0));
    const i = (y * img.width + x) * 4;
    for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(img.data[i + k] * (1 - cov) + c[k] * cov);
  }
}
/** A filled circle (the control), hard edged. */
function disc(img: Img, cx: number, cy: number, r: number, c: [number, number, number]) {
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
    const i = (y * img.width + x) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2];
  }
}

test("a centred glyph has equal margins; fractional edges are measured to a fraction of a pixel", () => {
  const img = canvas(56, 56, [240, 240, 240]);
  rect(img, 19, 20.5, 37, 35.5, [24, 24, 27]);
  const k = inkBox(img, { x: 0, y: 0, w: 56, h: 56 })!;
  assert.ok(Math.abs(k.left - 19) < 0.05 && Math.abs(k.right - 19) < 0.05, JSON.stringify(k));
  assert.ok(Math.abs(k.top - 20.5) < 0.05 && Math.abs(k.bottom - 20.5) < 0.05, JSON.stringify(k));
});

test("a glyph off by one pixel reads as off by one pixel", () => {
  const img = canvas(56, 56, [255, 255, 255]);
  rect(img, 20, 18, 38, 36, [0, 0, 0]);
  const k = inkBox(img, { x: 0, y: 0, w: 56, h: 56 })!;
  assert.equal(k.left - k.right, 2);
  assert.equal(k.bottom - k.top, 2);
});

test("a round control on another colour: its corners are not ink", () => {
  const img = canvas(64, 64, [255, 255, 255]);
  disc(img, 32, 32, 28, [228, 228, 231]);
  rect(img, 26, 26, 38, 38, [24, 24, 27]);
  const k = inkBox(img, { x: 4, y: 4, w: 56, h: 56 }, { radius: 28 })!;
  assert.deepEqual(k.bg, [228, 228, 231]);
  assert.ok(Math.abs(k.left - 22) < 0.05 && Math.abs(k.right - 22) < 0.05, JSON.stringify(k));
});

test("only: the icon of a control that also holds text", () => {
  const img = canvas(100, 40, [255, 255, 255]);
  rect(img, 10, 12, 22, 28, [255, 0, 0]);
  rect(img, 30, 14, 90, 26, [0, 0, 0]);
  const k = inkBox(img, { x: 0, y: 0, w: 100, h: 40 }, { only: [255, 0, 0] })!;
  assert.equal(k.x0, 10);
  assert.equal(k.x1, 22);
});

test("nothing but the fill: no ink", () => {
  assert.equal(inkBox(canvas(20, 20, [9, 9, 9]), { x: 0, y: 0, w: 20, h: 20 }), null);
});

test("the baseline of a line of text: where most columns end, not the descenders", async () => {
  const { baselineOf } = await import("../qa/ink.ts");
  const img = canvas(80, 40, [255, 255, 255]);
  // Four letters sitting on y = 30.5, one with a descender to 35.
  for (const x of [10, 20, 30, 50]) rect(img, x, 14, x + 6, 30.5, [0, 0, 0]);
  rect(img, 40, 18, 46, 35, [0, 0, 0]);
  assert.equal(baselineOf(img, { x: 0, y: 0, w: 80, h: 40 }), 30.5);
});
