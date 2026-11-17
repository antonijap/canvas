// Corner radius handles on the canvas, the pure half: where the four knobs sit on a selected frame or rectangle,
// which one a press hits, the radius a drag gives, and the cornerRadius it writes. No DOM, no globals:
// src/page/radius.js imports it, and node tests import the same file.
//
// Screen rects are view px {x, y, w, h}. Corners are numbered as the file stores them: 0 top left, 1 top right,
// 2 bottom right, 3 bottom left (cornerRadius is one number or those four).

/** A layer smaller than this on screen (either side, view px) shows no radius knobs: there is no room to grab one. */
export const RADIUS_MIN_PX = 40;
/** The knob sits at least this far in from its corner along both axes (screen px), clear of the resize corner. */
export const INSET_PX = 12;
/** A press within this many px of a knob's centre grabs it. Small, so presses meant for moving the layer or picking a child still do. */
export const HIT_PX = 5;
/** The drawn knob's radius (px). */
export const KNOB_PX = 3.5;

/** The four radii [tl, tr, br, bl] from a stored cornerRadius, or null when it is a token or not a number. */
export function radii(cr) {
  if (cr === undefined || cr === null) return [0, 0, 0, 0];
  if (typeof cr === "number" && Number.isFinite(cr)) return [cr, cr, cr, cr];
  if (Array.isArray(cr) && cr.length === 4 && cr.every((v) => typeof v === "number" && Number.isFinite(v))) return cr.slice();
  return null;
}

/** The biggest radius a w x h box can show. */
export const maxRadius = (w, h) => Math.max(0, Math.min(w, h) / 2);

/**
 * The cornerRadius to write: `corner` -1 sets all four (one number, a plain drag), 0..3 that corner alone (Option),
 * keeping the others; four equal values collapse back to one number.
 */
export function radiusForm(old, corner, v) {
  if (corner < 0) return v;
  const r = radii(old) || [0, 0, 0, 0];
  r[corner] = v;
  return r.every((x) => x === r[0]) ? r[0] : r;
}

/** The stored corner (0..3) drawn at a screen corner (h: 0 left, 1 right; v: 0 top, 1 bottom) of a layer flipped as given. */
export function storedCorner(h, v, flipX = false, flipY = false) {
  const hh = flipX ? 1 - h : h, vv = flipY ? 1 - v : v;
  return vv === 0 ? (hh === 0 ? 0 : 1) : hh === 0 ? 3 : 2;
}

/**
 * The knobs for a layer drawn at screen rect `s` with stored radii `r` at zoom z: each {corner (stored), x, y (its
 * centre), sx, sy (the inward direction, +1 or -1 on each axis)}. A knob sits where its radius ends along both
 * edges (r * z in from the corner), at least INSET_PX in and never past the middle. None when the layer is too
 * small on screen.
 */
export function knobs(s, r, z, flipX = false, flipY = false) {
  if (!s || !r || !(s.w >= RADIUS_MIN_PX) || !(s.h >= RADIUS_MIN_PX)) return [];
  const most = Math.min(s.w, s.h) / 2;
  const out = [];
  for (const [h, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const corner = storedCorner(h, v, flipX, flipY);
    const d = Math.min(most, Math.max(INSET_PX, (r[corner] || 0) * z));
    const sx = h === 0 ? 1 : -1, sy = v === 0 ? 1 : -1;
    const cx = h === 0 ? s.x : s.x + s.w, cy = v === 0 ? s.y : s.y + s.h;
    out.push({ corner, x: cx + sx * d, y: cy + sy * d, sx, sy });
  }
  return out;
}

/** The knob under a screen point (the nearest within `tol`), or null. */
export function knobAt(list, px, py, tol = HIT_PX) {
  let best = null, bd = Infinity;
  for (const k of list) {
    const d = Math.hypot(px - k.x, py - k.y);
    if (d <= tol && d < bd) { best = k; bd = d; }
  }
  return best;
}

/**
 * The radius a knob drag gives: from `start` (world px), the pointer's travel (screen dx, dy) along the knob's
 * inward diagonal at zoom z (toward the centre rounds more, outward less). Between 0 and `max`; whole px while
 * pixel snapping is on, else hundredths.
 */
export function dragRadius(k, start, dx, dy, z, max, pixel = true) {
  const t = (dx * k.sx + dy * k.sy) / 2;
  let v = start + t / (z > 0 ? z : 1);
  v = Math.min(Math.max(0, v), Math.max(0, max));
  v = pixel ? Math.round(v) : Math.round(v * 100) / 100;
  if (v > max) v = pixel ? Math.floor(max) : max;
  return Object.is(v, -0) ? 0 : v;
}

/** Whether the radius handles apply to a scene node: a frame or rectangle, upright, its radius plain numbers. */
export function radiusTarget(n) {
  if (!n || typeof n !== "object") return false;
  if (n.type !== "frame" && n.type !== "rectangle") return false;
  if (Number(n.rotation)) return false;
  return radii(n.cornerRadius) !== null;
}
