// Blob metric on a diff image from fidelity/diff.ts: connected groups of mismatched pixels (8-neighbour).
// A percentage hides a small, solid error (a missing hairline, a shifted corner); the largest blob does not.
import zlib from "node:zlib";
import type { Img } from "../../fidelity/png.ts";

export type Blob = { x: number; y: number; w: number; h: number; area: number };

/** diff.ts paints mismatches (255, 0, 60); forgiven anti-aliasing is yellow and does not count. */
const isMismatch = (d: Uint8Array, i: number) => d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 60;

export function blobs(diff: Img): { count: number; largest?: Blob; top: Blob[] } {
  const { width: w, height: h, data } = diff;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const all: Blob[] = [];
  for (let p = 0; p < w * h; p++) {
    if (seen[p] || !isMismatch(data, p * 4)) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
    seen[p] = 1;
    stack.push(p);
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % w, y = (q - x) / w;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
          const n = ny * w + nx;
          if (!seen[n] && isMismatch(data, n * 4)) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    all.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  all.sort((a, b) => b.area - a.area);
  return { count: all.length, largest: all[0], top: all.slice(0, 5) };
}

export function crop(img: Img, r: { x: number; y: number; w: number; h: number }): Img {
  const x = Math.max(0, Math.min(img.width - 1, r.x)), y = Math.max(0, Math.min(img.height - 1, r.y));
  const w = Math.max(1, Math.min(img.width - x, r.w)), h = Math.max(1, Math.min(img.height - y, r.h));
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) data.set(img.data.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4), j * w * 4);
  return { width: w, height: h, data };
}

export type Seam = { seamPx: number; stripPx: number; ratio: number; visible: boolean };

/**
 * A tile seam shows as mismatches lined up on a tile edge. Counts mismatched pixels within 2 px of every
 * edge (`originX/Y` is the board origin in the view's device px, edges every `tile` px from it) and compares
 * that density with the rest of the view. Visible: at least 40 px on the edges and 3 times the rest's density.
 */
export function seamCheck(diff: Img, originX: number, originY: number, tile: number): Seam {
  const { width: w, height: h, data } = diff;
  const near = (p: number, o: number) => { const m = (((p - o) % tile) + tile) % tile; return m < 2 || m >= tile - 2; };
  let strip = 0, stripBad = 0, rest = 0, restBad = 0;
  for (let y = 0; y < h; y++) {
    const ny = near(y, originY);
    for (let x = 0; x < w; x++) {
      const bad = isMismatch(data, (y * w + x) * 4) ? 1 : 0;
      if (ny || near(x, originX)) { strip++; stripBad += bad; } else { rest++; restBad += bad; }
    }
  }
  const dStrip = strip ? stripBad / strip : 0, dRest = rest ? Math.max(restBad, 1) / rest : 1;
  const ratio = dStrip / dRest;
  return { seamPx: stripBad, stripPx: strip, ratio, visible: stripBad >= 40 && ratio >= 3 };
}

// ---------------------------------------------------------------- compact PNG for baselines


const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function pngChunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0); out.write(type, 4, "latin1"); body.copy(out, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + body.length; i++) c = crcTable[(c ^ out[i]) & 255] ^ (c >>> 8);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + body.length);
  return out;
}

/**
 * Opaque RGB, the best of the five PNG filters per row (least sum of absolute residuals), deflate level 9.
 * About half the size of fidelity/png.ts's encoder on these pictures; baselines are checked in, so size matters.
 * Lossless for opaque screenshots (alpha is dropped: both renderers shoot an opaque page).
 */
export function encodeCompactPng(img: Img): Buffer {
  const { width: w, height: h, data } = img;
  const stride = w * 3;
  const rgb = new Uint8Array(stride * h);
  for (let i = 0, o = 0; i < w * h; i++) { rgb[o++] = data[i * 4]; rgb[o++] = data[i * 4 + 1]; rgb[o++] = data[i * 4 + 2]; }
  const raw = Buffer.alloc((stride + 1) * h);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const sums = [0, 0, 0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const x = rgb[row + i], a = i >= 3 ? rgb[row + i - 3] : 0, up = y ? rgb[row - stride + i] : 0, c = i >= 3 && y ? rgb[row - stride + i - 3] : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      const r1 = (x - a) & 255, r2 = (x - up) & 255, r3 = (x - ((a + up) >> 1)) & 255, r4 = (x - (pa <= pb && pa <= pc ? a : pb <= pc ? up : c)) & 255;
      cand[0][i] = x; cand[1][i] = r1; cand[2][i] = r2; cand[3][i] = r3; cand[4][i] = r4;
      sums[0] += x < 128 ? x : 256 - x; sums[1] += r1 < 128 ? r1 : 256 - r1; sums[2] += r2 < 128 ? r2 : 256 - r2; sums[3] += r3 < 128 ? r3 : 256 - r3; sums[4] += r4 < 128 ? r4 : 256 - r4;
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;
    raw[y * (stride + 1)] = best;
    raw.set(cand[best], y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}
