// Optical alignment from pixels: where a control's visible ink (glyph, icon, dot) sits inside it, not where its
// layout box says. Used by the alignment scenarios of pnpm qa (page, 2x capture) and pnpm qa:native (window
// capture), and by the before and after crops in qa/out/alignment.
//
// The ink is every pixel inside the control's shape (a rounded rect, inset a little so its own antialiased edge
// never counts) that differs from the control's fill. Edges are fractional: a column covered by 30% of the ink's
// full contrast moves that edge by 0.7 px, so a 2x capture measures to a quarter point.
import fs from "node:fs";
import path from "node:path";
import { encodePng, type Img } from "../fidelity/png.ts";

export type Rect = { x: number; y: number; w: number; h: number };
/** The ink's bounds in the image's pixels (fractional), the fill it was measured against, and the margins to the region. */
export type Ink = { x0: number; y0: number; x1: number; y1: number; bg: [number, number, number]; left: number; right: number; top: number; bottom: number };

export type InkOpts = {
  /** The control's corner radius, in image px (a circle: half its side). Pixels outside the rounded shape do not count. */
  radius?: number;
  /** How far inside the region's edge to start looking, in image px (default 2: the control's own antialiased edge). */
  inset?: number;
  /** The fill to measure against; default the most common colour inside the shape. */
  bg?: [number, number, number];
  /** Smallest difference (0-255, per channel) that is ink at all. */
  tol?: number;
  /** Only ink this colour (within tol): the icon of a control that also holds text, say. */
  only?: [number, number, number];
};

const px = (img: Img, x: number, y: number): [number, number, number] => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const diff = (a: [number, number, number], b: [number, number, number]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** Whether (x, y) (pixel centre) is inside the rect r inset by `inset`, with corners of radius `radius - inset`. */
function inside(x: number, y: number, r: Rect, radius: number, inset: number): boolean {
  const l = r.x + inset, t = r.y + inset, rr = r.x + r.w - inset, b = r.y + r.h - inset;
  if (x < l || x > rr || y < t || y > b) return false;
  const k = Math.max(0, Math.min(radius - inset, (rr - l) / 2, (b - t) / 2));
  if (k <= 0) return true;
  const cx = x < l + k ? l + k : x > rr - k ? rr - k : x;
  const cy = y < t + k ? t + k : y > b - k ? b - k : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= k * k;
}

/** The ink inside r (image px). Null when nothing differs from the fill. */
export function inkBox(img: Img, r: Rect, o: InkOpts = {}): Ink | null {
  const inset = o.inset ?? 2, radius = o.radius ?? 0, tol = o.tol ?? 18;
  const X0 = Math.max(0, Math.floor(r.x)), Y0 = Math.max(0, Math.floor(r.y));
  const X1 = Math.min(img.width, Math.ceil(r.x + r.w)), Y1 = Math.min(img.height, Math.ceil(r.y + r.h));
  let bg = o.bg;
  if (!bg) {
    const count = new Map<number, number>();
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      if (!inside(x + 0.5, y + 0.5, r, radius, inset)) continue;
      const [a, b, c] = px(img, x, y);
      const k = (a << 16) | (b << 8) | c;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    let best = 0, bk = 0;
    for (const [k, n] of count) if (n > best) { best = n; bk = k; }
    bg = [(bk >> 16) & 255, (bk >> 8) & 255, bk & 255];
  }
  const W = X1 - X0, H = Y1 - Y0;
  const d = new Float32Array(W * H);
  let D = 0;
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    if (!inside(x + 0.5, y + 0.5, r, radius, inset)) continue;
    const c = px(img, x, y);
    let v = diff(c, bg);
    if (o.only) {
      // Only pixels on the way from the fill to the wanted colour: their distance to that line, small.
      const want = o.only, span = diff(want, bg) || 1;
      const t = Math.max(0, Math.min(1, v / span));
      const mix: [number, number, number] = [bg[0] + (want[0] - bg[0]) * t, bg[1] + (want[1] - bg[1]) * t, bg[2] + (want[2] - bg[2]) * t];
      if (diff(c, mix) > tol * 1.5) v = 0;
    }
    if (v < tol) continue;
    d[(y - Y0) * W + (x - X0)] = v;
    if (v > D) D = v;
  }
  if (D === 0) return null;
  const col = new Float32Array(W), row = new Float32Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = d[y * W + x] / D;
    if (v > col[x]) col[x] = v;
    if (v > row[y]) row[y] = v;
  }
  const first = (a: Float32Array) => a.findIndex((v) => v > 0);
  const last = (a: Float32Array) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] > 0) return i; return -1; };
  const fx = first(col), lx = last(col), fy = first(row), ly = last(row);
  const x0 = X0 + fx + (1 - col[fx]), x1 = X0 + lx + col[lx];
  const y0 = Y0 + fy + (1 - row[fy]), y1 = Y0 + ly + row[ly];
  return { x0, y0, x1, y1, bg, left: x0 - r.x, right: r.x + r.w - x1, top: y0 - r.y, bottom: r.y + r.h - y1 };
}

/**
 * The baseline of a line of text inside r (image px): the bottom edge most of its letters' columns end on (a
 * descender ends lower, in fewer columns). The edge is where a column's ink falls below half its contrast.
 */
export function baselineOf(img: Img, r: Rect, o: { bg?: [number, number, number]; tol?: number } = {}): number | null {
  const X0 = Math.max(0, Math.floor(r.x)), Y0 = Math.max(0, Math.floor(r.y));
  const X1 = Math.min(img.width, Math.ceil(r.x + r.w)), Y1 = Math.min(img.height, Math.ceil(r.y + r.h));
  const bg = o.bg ?? inkBox(img, r, { inset: 0, tol: o.tol })?.bg;
  if (!bg) return null;
  let D = 0;
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) D = Math.max(D, diff(px(img, x, y), bg));
  if (D < (o.tol ?? 18)) return null;
  const votes = new Map<number, number>();
  for (let x = X0; x < X1; x++) {
    for (let y = Y1 - 1; y >= Y0; y--) {
      const v = diff(px(img, x, y), bg) / D;
      if (v >= 0.5) {
        // The edge: the last row at least half covered, plus what the row under it carries.
        const below = y + 1 < Y1 ? diff(px(img, x, y + 1), bg) / D : 0;
        const edge = y + Math.min(1, v) + below;
        const key = Math.round(edge * 2) / 2;
        votes.set(key, (votes.get(key) ?? 0) + 1);
        break;
      }
    }
  }
  let best = -1, n = 0;
  for (const [k, c] of votes) if (c > n || (c === n && k < best)) { n = c; best = k; }
  return n ? best : null;
}

/** The ink's margins divided by `scale` (image px per point): in points, like the rect the caller had. */
export function inPoints(i: Ink, scale: number): Ink {
  return { ...i, x0: i.x0 / scale, y0: i.y0 / scale, x1: i.x1 / scale, y1: i.y1 / scale, left: i.left / scale, right: i.right / scale, top: i.top / scale, bottom: i.bottom / scale };
}

/** A crop of the image, blown up `zoom` times with hard pixels: what qa/out/alignment shows. */
export function crop(img: Img, r: Rect, zoom = 4): Img {
  const X0 = Math.max(0, Math.floor(r.x)), Y0 = Math.max(0, Math.floor(r.y));
  const w = Math.max(1, Math.min(img.width, Math.ceil(r.x + r.w)) - X0), h = Math.max(1, Math.min(img.height, Math.ceil(r.y + r.h)) - Y0);
  const out = new Uint8Array(w * zoom * h * zoom * 4);
  for (let y = 0; y < h * zoom; y++) for (let x = 0; x < w * zoom; x++) {
    const s = ((Y0 + Math.floor(y / zoom)) * img.width + X0 + Math.floor(x / zoom)) * 4, t = (y * w * zoom + x) * 4;
    out[t] = img.data[s]; out[t + 1] = img.data[s + 1]; out[t + 2] = img.data[s + 2]; out[t + 3] = 255;
  }
  return { width: w * zoom, height: h * zoom, data: out };
}

export const ALIGN_OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "out", "alignment");
/** Saves a crop to qa/out/alignment/<name>.png (git-ignored). */
export function saveCrop(img: Img, r: Rect, name: string, zoom = 4) {
  fs.mkdirSync(ALIGN_OUT, { recursive: true });
  fs.writeFileSync(path.join(ALIGN_OUT, `${name}.png`), encodePng(crop(img, r, zoom)));
}

/** One measurement line of the alignment log (qa/out/alignment/<run>.jsonl): what, where, the numbers. */
export function logAlign(run: string, entry: Record<string, unknown>) {
  fs.mkdirSync(ALIGN_OUT, { recursive: true });
  fs.appendFileSync(path.join(ALIGN_OUT, `${run}.jsonl`), JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------- checks, shared by the page and the app

/** A control's box in points (r: its corner radius) and a line of text measured on a capture. */
export type Box = { x: number; y: number; w: number; h: number; r: number };
export type Txt = { base: number; cap: number; ex: number };

/** Tolerance in points: one device pixel at 2x. */
export const TOL = 0.5;
/** For where text sits: a renderer draws a line's baseline on a whole pixel, so laid-out text can land up to half a point off. */
export const TOL_TEXT = 0.75;

export const midY = (p: { y0: number; y1: number } | null) => (p ? (p.y0 + p.y1) / 2 : null);
export const midX = (p: { x0: number; x1: number } | null) => (p ? (p.x0 + p.x1) / 2 : null);
export const cy = (b: Box | null | undefined) => (b ? b.y + b.h / 2 : null);
export const cx = (b: Box | null | undefined) => (b ? b.x + b.w / 2 : null);
export const bare = (b: Box | null | undefined): Box | null => (b ? { ...b, r: 0 } : null);

/**
 * A line of text inside `r` (points) on a capture at `k` px per point: its baseline from the pixels (the ink's bottom
 * when no letter reaches below the line, else the edge most columns end on), then the middles of a capital and of an
 * x above it, from the font's cap height and x-height (points).
 */
export function textLine(img: Img, k: number, r: Rect, text: string, capH: number, xH: number): Txt | null {
  const px = { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
  const b = /[gjpqyQJ,;()[\]{}|@_]/.test(text) ? baselineOf(img, px) : inkBox(img, px, { inset: 0 })?.y1 ?? null;
  if (b == null) return null;
  const base = b / k;
  return { base, cap: base - capH / 2, ex: base - xH / 2 };
}
/** SF Pro's cap height and x-height, per point of size (the native shell's text has no DOM to ask). */
export const SF = { cap: 0.7046, ex: 0.5249 };

/** Collects measurements of one capture: each logged to qa/out/alignment/<run>.jsonl, its crop beside it, misses in `bad`. */
export class AlignChecker {
  bad: string[] = [];
  readonly run: string;
  readonly theme: string;
  readonly img: Img;
  readonly k: number;
  constructor(run: string, theme: string, img: Img, k: number) { this.run = run; this.theme = theme; this.img = img; this.k = k; }
  /** The visible ink inside a box, in points, and its crop. */
  ink(name: string, b: Box | null | undefined, o: InkOpts = {}): Ink | null {
    const k = this.k;
    if (!b) { this.bad.push(`${name} (${this.theme}): not on screen`); return null; }
    const i = inkBox(this.img, { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k }, { radius: b.r * k, ...o });
    saveCrop(this.img, { x: b.x * k - 8, y: b.y * k - 8, w: b.w * k + 16, h: b.h * k + 16 }, `${this.run}-${name}-${this.theme}`);
    if (!i) { this.bad.push(`${name} (${this.theme}): no ink`); return null; }
    const p = inPoints(i, k);
    logAlign(this.run, { name, theme: this.theme, box: b, left: +p.left.toFixed(2), right: +p.right.toFixed(2), top: +p.top.toFixed(2), bottom: +p.bottom.toFixed(2) });
    return p;
  }
  /** Two measurements that must agree; text placements get TOL_TEXT ("cap", "baseline" or "label ink" in `what`). */
  near(what: string, a: number | null | undefined, b: number | null | undefined, tol = /cap|ex middle|baseline|label ink/.test(what) ? TOL_TEXT : TOL) {
    if (a == null || b == null) { this.bad.push(`${what} (${this.theme}): not measured`); return; }
    logAlign(this.run, { check: what, theme: this.theme, a: +a.toFixed(2), b: +b.toFixed(2), off: +(a - b).toFixed(2) });
    if (!(Math.abs(a - b) <= tol)) this.bad.push(`${what} (${this.theme}): ${a.toFixed(2)} vs ${b.toFixed(2)}, off by ${(a - b).toFixed(2)}`);
  }
  /** An icon (or a mark) centred in its control, both ways, by its visible shape. */
  icon(name: string, b: Box | null | undefined, o: InkOpts = {}) {
    const p = this.ink(name, b, o);
    if (!p) return null;
    this.near(`${name}: left and right margins`, p.left, p.right);
    this.near(`${name}: top and bottom margins`, p.top, p.bottom);
    return p;
  }
  /** A labelled control: its ink centred across, the label's cap (or x) middle on its centre line. */
  label(name: string, b: Box | null | undefined, txt: Txt | null | undefined, o: InkOpts & { mid?: "cap" | "ex"; tolX?: number } = {}) {
    const p = this.ink(name, b, o);
    if (!p || !b) return null;
    this.near(`${name}: the label ink's left and right margins`, p.left, p.right, o.tolX);
    this.near(`${name}: the label's ${o.mid ?? "cap"} middle on the control's centre line`, txt?.[o.mid ?? "cap"], b.y + b.h / 2);
    return p;
  }
}
