// Crop an image fill on the canvas (src/page/image-crop.js), the pure half: where the image sits as fractions of the
// layer, how a pan or a corner drag moves it, and the fill that is written. Node-tested.

/** The top visible image fill of a node's fill value: its index in the list and the fill, or null. */
export function topImage(fill) {
  const list = Array.isArray(fill) ? fill : fill === undefined || fill === null ? [] : [fill];
  for (let i = list.length - 1; i >= 0; i--) {
    const f = list[i];
    if (f && typeof f === "object" && f.type === "image" && f.url && f.enabled !== false) return { index: i, fill: f, list };
  }
  return null;
}

/** Quarter turns of an image fill. */
export const turns = (f) => ((Math.round((Number(f && f.rotation) || 0) / 90) % 4) + 4) % 4;

/**
 * The image's rectangle in the layer as fractions {x, y, width, height}: a crop as it is, or where Fill (cover), Fit
 * (contain) or Stretch put it, so Crop starts from what was shown. iw, ih: the image's own px.
 */
export function cropOf(f, w, h, iw, ih) {
  const mode = String(f.mode || "fill");
  if (mode === "crop" && f.crop && f.crop.width > 0 && f.crop.height > 0) return { x: +f.crop.x || 0, y: +f.crop.y || 0, width: +f.crop.width, height: +f.crop.height };
  if (mode === "stretch" || !(w > 0 && h > 0 && iw > 0 && ih > 0)) return { x: 0, y: 0, width: 1, height: 1 };
  const odd = turns(f) % 2 === 1;
  const rw = odd ? ih : iw, rh = odd ? iw : ih;
  const s = mode === "fit" || mode === "contain" ? Math.min(w / rw, h / rh) : Math.max(w / rw, h / rh);
  const dw = rw * s, dh = rh * s;
  return { x: (w - dw) / 2 / w, y: (h - dh) / 2 / h, width: dw / w, height: dh / h };
}

/** Moved by (dx, dy) layer units. */
export function panned(c, dx, dy, w, h) {
  return { ...c, x: c.x + dx / w, y: c.y + dy / h };
}

/**
 * A corner (0 top left, 1 top right, 2 bottom right, 3 bottom left) dragged by (dx, dy) layer units: the image keeps
 * its aspect, the opposite corner stays, and it never gets smaller than `min` layer units across.
 */
export function scaled(c, corner, dx, dy, w, h, min = 8) {
  const x0 = c.x * w, y0 = c.y * h, x1 = (c.x + c.width) * w, y1 = (c.y + c.height) * h;
  const aw = x1 - x0, ah = y1 - y0;
  const sx = corner === 1 || corner === 2 ? 1 : -1, sy = corner >= 2 ? 1 : -1;
  // The larger of the two moves along the diagonal decides the scale (aspect kept).
  const k = Math.max((aw + sx * dx) / aw, (ah + sy * dy) / ah, min / Math.min(aw, ah));
  const nw = aw * k, nh = ah * k;
  const ax = sx > 0 ? x0 : x1, ay = sy > 0 ? y0 : y1;
  const nx = sx > 0 ? ax : ax - nw, ny = sy > 0 ? ay : ay - nh;
  return { x: nx / w, y: ny / h, width: nw / w, height: nh / h };
}

const r4 = (v) => Math.round(v * 10000) / 10000;

/** The node's fill value with the image at `index` set to Crop at `c` (the form the file had: one object or a list). */
export function withCrop(fill, index, c) {
  const list = Array.isArray(fill) ? fill.slice() : [fill];
  list[index] = { ...list[index], mode: "crop", crop: { x: r4(c.x), y: r4(c.y), width: r4(c.width), height: r4(c.height) } };
  return Array.isArray(fill) ? list : list[0];
}

/** Which corner handle (0..3) is within `r` px of (px, py) on a screen rect, or -1. */
export function cornerAt(s, px, py, r = 8) {
  const pts = [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]];
  for (let i = 0; i < 4; i++) if (Math.hypot(px - pts[i][0], py - pts[i][1]) <= r) return i;
  return -1;
}
