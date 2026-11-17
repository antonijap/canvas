// Layout guides (also called layout grids): a uniform grid, columns or rows on a frame.
// Pure: the page (src/page/layout-guides.js) draws and snaps with these, the server lists them per board
// (src/boards.ts), node tests import the same file.
//
// Saved on the frame as `metadata.canvasLayoutGuides`, a list (several per frame), each one of:
//   { type: "grid", size, color, visible? }
//   { type: "columns" | "rows", count, align: "stretch" | "start" | "center" | "end", gutter, margin (stretch),
//     width (the column width or row height when not stretch), offset (from the start or end edge), color, visible? }
// `color` is #RRGGBBAA; the default is red at 10% (#FF00001A). `visible: false` hides that one guide.

export const KEY = "canvasLayoutGuides";
export const TYPES = ["grid", "columns", "rows"];
export const ALIGNS = ["stretch", "start", "center", "end"];
export const DEFAULT_COLOR = "#FF00001A";
const HEX = /^#[0-9a-f]{8}$/i;
const MAX_COUNT = 1000;

const fin = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** A new guide of `type` with the defaults (a 10 px grid; five stretched columns or rows, gutter 20). */
export function defaultGuide(type = "grid") {
  if (type === "grid") return { type: "grid", size: 10, color: DEFAULT_COLOR };
  return { type, count: 5, align: "stretch", gutter: 20, margin: 0, color: DEFAULT_COLOR };
}

/** One guide cleaned up (numbers in range, unknown keys dropped), or null when it is not a guide. */
export function cleanGuide(g) {
  if (!g || typeof g !== "object" || !TYPES.includes(g.type)) return null;
  const color = typeof g.color === "string" && HEX.test(g.color) ? g.color.toUpperCase() : DEFAULT_COLOR;
  const vis = g.visible === false ? { visible: false } : {};
  if (g.type === "grid") return { type: "grid", size: Math.max(1, fin(g.size, 10)), color, ...vis };
  const align = ALIGNS.includes(g.align) ? g.align : "stretch";
  const out = { type: g.type, count: Math.max(1, Math.min(MAX_COUNT, Math.round(fin(g.count, 5)))), align, gutter: Math.max(0, fin(g.gutter, 20)) };
  if (align === "stretch") out.margin = Math.max(0, fin(g.margin, 0));
  else { out.width = Math.max(1, fin(g.width, 60)); if (align !== "center") out.offset = Math.max(0, fin(g.offset, 0)); }
  return { ...out, color, ...vis };
}

/** The guides saved in a node's metadata (cleaned; empty when none). */
export function guidesOf(metadata) {
  const list = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata[KEY] : null;
  return Array.isArray(list) ? list.map(cleanGuide).filter(Boolean) : [];
}

/** A node's metadata with these guides (every other key kept); null when nothing would be left. */
export function withLayoutGuides(metadata, guides) {
  const m = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...metadata } : {};
  const list = (guides || []).map(cleanGuide).filter(Boolean);
  if (list.length) {
    if (typeof m.type !== "string") m.type = "canvas";
    m[KEY] = list;
  } else delete m[KEY];
  const keys = Object.keys(m);
  if (!keys.length || (keys.length === 1 && m.type === "canvas")) return null;
  return m;
}

/** Where the bands of a columns (or rows) guide fall along a side `len` long: [{a, b}] from the frame's start edge. */
export function bands(g, len) {
  const n = g.count;
  if (!(len > 0) || !(n >= 1)) return [];
  let w, start;
  if (g.align === "stretch") {
    const m = g.margin || 0;
    w = (len - 2 * m - (n - 1) * g.gutter) / n;
    start = m;
  } else {
    w = g.width;
    const total = n * w + (n - 1) * g.gutter;
    start = g.align === "start" ? g.offset || 0 : g.align === "end" ? len - (g.offset || 0) - total : (len - total) / 2;
  }
  if (!(w > 0)) return [];
  const out = [];
  for (let i = 0; i < n; i++) { const a = start + i * (w + g.gutter); out.push({ a, b: a + w }); }
  return out;
}

/**
 * What one guide draws in a frame w x h (frame-local px): `rects` (column and row bands, filled) and `lines`
 * (grid lines: {axis: "x" | "y", at}, axis "x" a vertical line at x = at).
 */
export function shapes(g, w, h) {
  if (g.type === "grid") {
    const lines = [];
    const s = g.size;
    if (s > 0 && w / s < 4000 && h / s < 4000) {
      for (let x = s; x < w; x += s) lines.push({ axis: "x", at: x });
      for (let y = s; y < h; y += s) lines.push({ axis: "y", at: y });
    }
    return { rects: [], lines };
  }
  if (g.type === "columns") return { rects: bands(g, w).map((b) => ({ x: b.a, y: 0, w: b.b - b.a, h })), lines: [] };
  return { rects: bands(g, h).map((b) => ({ x: 0, y: b.a, w, h: b.b - b.a })), lines: [] };
}

/**
 * The lines a moving layer snaps to, from a frame's guides (world px): every column and row edge, every grid
 * line. Returned as zero-thickness rects for the snap index (src/page/snap.js): a vertical line at x is
 * {x, y: frame top, w: 0, h: frame height}.
 */
export function snapRects(frame, guides) {
  const out = [];
  for (const g of guides) {
    if (g.visible === false) continue;
    const s = shapes(g, frame.w, frame.h);
    const v = (x) => out.push({ x: frame.x + x, y: frame.y, w: 0, h: frame.h });
    const hz = (y) => out.push({ x: frame.x, y: frame.y + y, w: frame.w, h: 0 });
    for (const r of s.rects) { if (g.type === "columns") { v(r.x); v(r.x + r.w); } else { hz(r.y); hz(r.y + r.h); } }
    for (const l of s.lines) (l.axis === "x" ? v : hz)(l.at);
  }
  return out;
}

/** A guide's colour as CSS rgba(), from #RRGGBBAA. */
export function cssColor(hex) {
  const h = HEX.test(hex) ? hex : DEFAULT_COLOR;
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return `rgba(${n(1)},${n(3)},${n(5)},${Math.round((n(7) / 255) * 1000) / 1000})`;
}
