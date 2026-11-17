import assert from "node:assert/strict";
import { test } from "node:test";
import { diffImages, recolored, shifted } from "../fidelity/diff.ts";
import { decodePng, encodePng, type Img } from "../fidelity/png.ts";

// A card with a dark bar, a few vertical strokes and a blue square on white.
function scene(w = 96, h = 64): Img {
  const data = new Uint8Array(w * h * 4).fill(255);
  const rect = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; }
  };
  rect(4, 4, w - 4, 14, [30, 30, 40]);
  for (let k = 0; k < 8; k++) rect(8 + k * 10, 20, 10 + k * 10, 40, [60, 60, 60]);
  rect(60, 44, 90, 60, [7, 102, 235]);
  return { width: w, height: h, data };
}

test("identical images: zero mismatch, SSIM 1", () => {
  const r = diffImages(scene(), scene());
  assert.equal(r.mismatched, 0);
  assert.equal(r.mismatchPct, 0);
  assert.ok(r.ssim > 0.9999);
});

test("a 1px shift is caught", () => {
  const a = scene(), r = diffImages(a, shifted(a, 1, 0));
  assert.ok(r.mismatchPct > 1, `mismatch ${r.mismatchPct}`);
  assert.ok(r.ssim < 0.97, `ssim ${r.ssim}`);
});

test("a colour change is caught", () => {
  const a = scene(), r = diffImages(a, recolored(a, 90, { x: 0, y: 0, w: 96, h: 64 }));
  assert.ok(r.mismatchPct > 20, `mismatch ${r.mismatchPct}`);
});

test("a change under the threshold is ignored", () => {
  const a = scene(), r = diffImages(a, recolored(a, 2, { x: 0, y: 0, w: 96, h: 64 }));
  assert.equal(r.mismatched, 0);
});

test("anti-aliased edge pixels are forgiven, solid changes are not", () => {
  const w = 40, h = 40, a = new Uint8Array(w * h * 4).fill(255), b = new Uint8Array(w * h * 4).fill(255);
  // diagonal edge: a has a hard staircase, b has an intermediate grey on the edge pixels
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, edge = x - y;
    const va = edge < 0 ? 0 : 255, vb = edge < 0 ? 0 : edge === 0 ? 128 : 255;
    a[i] = a[i + 1] = a[i + 2] = va; b[i] = b[i + 1] = b[i + 2] = vb;
  }
  const A = { width: w, height: h, data: a }, B = { width: w, height: h, data: b };
  assert.equal(diffImages(A, B).mismatched, 0);
  assert.ok(diffImages(A, B, { ignoreAA: false }).mismatched > 0);
});

test("different sizes count as mismatch", () => {
  const r = diffImages(scene(96, 64), scene(96, 70));
  assert.equal(r.sizeMismatch, true);
  assert.ok(r.mismatchPct > 5);
});

test("PNG round trip", () => {
  const a = scene(), b = decodePng(encodePng(a));
  assert.equal(b.width, a.width);
  assert.deepEqual(Array.from(b.data), Array.from(a.data));
});
