// Image comparison: pixelmatch-style YIQ delta with anti-aliasing detection, plus SSIM on luma.
import type { Img } from "./png.ts";

export type DiffResult = {
  width: number;
  height: number;
  mismatched: number; // pixels over the threshold that are not anti-aliasing
  antialiased: number; // pixels over the threshold forgiven as 1px anti-aliased edges
  mismatchPct: number;
  ssim: number;
  sizeMismatch: boolean;
  diff: Img; // truth as a faded grey, mismatches red, forgiven AA pixels yellow
};

export type DiffOptions = { threshold?: number; ignoreAA?: boolean };

// Blend over white so transparent pixels compare as they would look on the page.
const blend = (c: number, a: number) => 255 + (c - 255) * a;
function yiq(r: number, g: number, b: number) {
  return [r * 0.29889531 + g * 0.58662247 + b * 0.11448223, r * 0.59597799 - g * 0.2741761 - b * 0.32180189, r * 0.21147017 - g * 0.52261711 + b * 0.31114694];
}

/** Squared perceptual distance between pixel pairs (pixelmatch's weighting). Signed: positive when `a` is lighter. */
function colorDelta(a: Uint8Array, b: Uint8Array, ia: number, ib: number, onlyBrightness = false): number {
  const a1 = a[ia + 3] / 255, a2 = b[ib + 3] / 255;
  const r1 = blend(a[ia], a1), g1 = blend(a[ia + 1], a1), b1 = blend(a[ia + 2], a1);
  const r2 = blend(b[ib], a2), g2 = blend(b[ib + 1], a2), b2 = blend(b[ib + 2], a2);
  const y = yiq(r1, g1, b1)[0] - yiq(r2, g2, b2)[0];
  if (onlyBrightness) return y;
  const [y1, i1, q1] = yiq(r1, g1, b1), [y2, i2, q2] = yiq(r2, g2, b2);
  const dy = y1 - y2, di = i1 - i2, dq = q1 - q2;
  const d = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
  return y1 > y2 ? -d : d;
}

/** True when the pixel at (x, y) in `a` looks like an anti-aliased edge (pixelmatch's heuristic, Vysniauskas 2009). */
function antialiased(a: Uint8Array, x1: number, y1: number, w: number, h: number, b: Uint8Array): boolean {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, w - 1), y2 = Math.min(y1 + 1, h - 1);
  const pos = (y1 * w + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  let min = 0, max = 0, minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      const delta = colorDelta(a, a, pos, (y * w + x) * 4, true);
      if (delta === 0) { zeroes++; if (zeroes > 2) return false; }
      else if (delta < min) { min = delta; minX = x; minY = y; }
      else if (delta > max) { max = delta; maxX = x; maxY = y; }
    }
  }
  if (min === 0 || max === 0) return false;
  return (hasManySiblings(a, minX, minY, w, h) && hasManySiblings(b, minX, minY, w, h)) || (hasManySiblings(a, maxX, maxY, w, h) && hasManySiblings(b, maxX, maxY, w, h));
}
function hasManySiblings(img: Uint8Array, x1: number, y1: number, w: number, h: number): boolean {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, w - 1), y2 = Math.min(y1 + 1, h - 1);
  const pos = (y1 * w + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      const p = (y * w + x) * 4;
      if (img[pos] === img[p] && img[pos + 1] === img[p + 1] && img[pos + 2] === img[p + 2] && img[pos + 3] === img[p + 3]) zeroes++;
      if (zeroes > 2) return true;
    }
  }
  return false;
}

/** Pad to w x h with opaque magenta, so a size difference shows up as mismatch instead of throwing. */
export function pad(img: Img, w: number, h: number): Img {
  if (img.width === w && img.height === h) return img;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255; }
  for (let y = 0; y < Math.min(h, img.height); y++) data.set(img.data.subarray(y * img.width * 4, (y * img.width + Math.min(w, img.width)) * 4), y * w * 4);
  return { width: w, height: h, data };
}

function luma(img: Img): Float64Array {
  const out = new Float64Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    const a = img.data[i * 4 + 3] / 255;
    out[i] = 0.299 * blend(img.data[i * 4], a) + 0.587 * blend(img.data[i * 4 + 1], a) + 0.114 * blend(img.data[i * 4 + 2], a);
  }
  return out;
}

/** Mean SSIM over sliding 8x8 windows (stride 1, integral images built per band of rows to bound memory). 1 = identical. */
export function ssim(a: Img, b: Img, win = 8): number {
  const w = a.width, h = a.height;
  if (w < win || h < win) return a.data.every((v, i) => v === b.data[i]) ? 1 : 0;
  const la = luma(a), lb = luma(b);
  const W = w + 1, BAND = 256;
  const n = win * win, C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let total = 0, count = 0;
  for (let y0 = 0; y0 + win <= h; y0 += BAND) {
    const rows = Math.min(BAND + win - 1, h - y0); // rows in this band, so windows start at y0..y0+rows-win
    const mk = (f: (i: number) => number) => {
      const s = new Float64Array(W * (rows + 1));
      for (let y = 0; y < rows; y++) { let row = 0; for (let x = 0; x < w; x++) { row += f((y0 + y) * w + x); s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row; } }
      return s;
    };
    const sa = mk((i) => la[i]), sb = mk((i) => lb[i]), saa = mk((i) => la[i] * la[i]), sbb = mk((i) => lb[i] * lb[i]), sab = mk((i) => la[i] * lb[i]);
    const box = (s: Float64Array, x: number, y: number) => s[(y + win) * W + x + win] - s[y * W + x + win] - s[(y + win) * W + x] + s[y * W + x];
    for (let y = 0; y + win <= rows && y0 + y + win <= h; y++) {
      if (y >= BAND) break;
      for (let x = 0; x + win <= w; x++) {
        const ma = box(sa, x, y) / n, mb = box(sb, x, y) / n;
        const va = box(saa, x, y) / n - ma * ma, vb = box(sbb, x, y) / n - mb * mb, cov = box(sab, x, y) / n - ma * mb;
        total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
        count++;
      }
    }
  }
  return total / count;
}

export function diffImages(truth: Img, other: Img, opts: DiffOptions = {}): DiffResult {
  const threshold = opts.threshold ?? 0.1, ignoreAA = opts.ignoreAA ?? true;
  const sizeMismatch = truth.width !== other.width || truth.height !== other.height;
  const w = Math.max(truth.width, other.width), h = Math.max(truth.height, other.height);
  const A = pad(truth, w, h), B = pad(other, w, h);
  const out = new Uint8Array(w * h * 4);
  const maxDelta = 35215 * threshold * threshold;
  let mismatched = 0, aa = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const delta = colorDelta(A.data, B.data, i, i);
      if (Math.abs(delta) > maxDelta) {
        if (ignoreAA && (antialiased(A.data, x, y, w, h, B.data) || antialiased(B.data, x, y, w, h, A.data))) {
          aa++; out[i] = 255; out[i + 1] = 210; out[i + 2] = 0; out[i + 3] = 255;
        } else {
          mismatched++; out[i] = 255; out[i + 1] = 0; out[i + 2] = 60; out[i + 3] = 255;
        }
      } else {
        const g = blend(0.299 * A.data[i] + 0.587 * A.data[i + 1] + 0.114 * A.data[i + 2], A.data[i + 3] / 255);
        const v = 255 + (g - 255) * 0.25;
        out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
      }
    }
  }
  return { width: w, height: h, mismatched, antialiased: aa, mismatchPct: (mismatched / (w * h)) * 100, ssim: ssim(A, B), sizeMismatch, diff: { width: w, height: h, data: out } };
}

/** truth | other | diff in one image, with a 8px grey gutter. */
export function sideBySide(truth: Img, other: Img | null, diff: Img | null): Img {
  const parts = [truth, other, diff].filter((p): p is Img => !!p);
  const gap = 8, h = Math.max(...parts.map((p) => p.height)), w = parts.reduce((s, p) => s + p.width, 0) + gap * (parts.length - 1);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 200; data[i * 4 + 3] = 255; }
  let ox = 0;
  for (const p of parts) {
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
      const s = (y * p.width + x) * 4, d = (y * w + ox + x) * 4, a = p.data[s + 3] / 255;
      data[d] = blend(p.data[s], a); data[d + 1] = blend(p.data[s + 1], a); data[d + 2] = blend(p.data[s + 2], a);
    }
    ox += p.width + gap;
  }
  return { width: w, height: h, data };
}

// ---- self-test helpers

/** Copy of `img` moved by (dx, dy) pixels, edge filled with white. */
export function shifted(img: Img, dx: number, dy: number): Img {
  const data = new Uint8Array(img.data.length).fill(255);
  for (let y = 0; y < img.height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < img.width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= img.width) continue;
      data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * img.width + x) * 4);
    }
  }
  return { width: img.width, height: img.height, data };
}

/** Copy with the red channel moved by `by` inside a rectangle (default: the middle third). */
export function recolored(img: Img, by = 90, rect = { x: img.width / 3, y: img.height / 3, w: img.width / 3, h: img.height / 3 }): Img {
  const data = new Uint8Array(img.data);
  for (let y = Math.floor(rect.y); y < Math.min(img.height, rect.y + rect.h); y++) {
    for (let x = Math.floor(rect.x); x < Math.min(img.width, rect.x + rect.w); x++) {
      const i = (y * img.width + x) * 4;
      data[i] = data[i] + by > 255 ? data[i] - by : data[i] + by;
    }
  }
  return { width: img.width, height: img.height, data };
}
