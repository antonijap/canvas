// The scale tool (K), the pure half: what scaling a layer by a factor does to each node's own properties, and the
// drag math behind the handles in scale mode. No DOM, no globals: the page (src/page/live.js) draws the preview
// with it, the server (src/scale.ts) writes with it, and node tests import the same file, so the preview and the
// write cannot drift apart.
//
// What scales (K): positions of descendants, sizes (a fit_content/fill_container mode stays, its fallback
// number scales; an icon without a size gets its 24 px default scaled), font size (text without one gets the
// 13 px it inherits, scaled), letter spacing (px in the file), stroke widths (uniform or per side),
// corner radii (uniform or per corner), padding (1, 2 or 4 values), gap, and effects (shadow offset, blur and
// spread; layer and background blur radius). Line height stays: a file stores it as a multiple of the font size,
// so it follows the font. Rotation, opacity, angles, ratios (innerRadius) and a path's geometry and viewBox (drawn
// into its box) stay.
//
// Token-bound values ($name) are kept as they are and reported, never detached: a token is a decision made
// elsewhere, and scaling one layer must not rewrite or orphan it.

import { resizeRect } from "./live-edit.js";

/** Plain numbers, rounded to 1/100 px so a scale does not leave float noise in the file. */
export const r2 = (v) => Math.round(v * 100) / 100;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isTok = (v) => typeof v === "string" && v.startsWith("$") && v.length > 1;
const SIZING = /^(fit_content|fill_container)\(\s*(-?[\d.]+)\s*\)$/;

/** The properties a scale touches (for docs, tests and the inspector). */
export const SCALED_KEYS = ["x", "y", "width", "height", "fontSize", "letterSpacing", "strokeWidth", "cornerRadius", "padding", "gap", "effect"];
const PLAIN = ["fontSize", "letterSpacing", "gap"];
/** What a node draws with when it has no value of its own (engine/src/text.rs, engine html.ts): scaled, it becomes one. */
export const DEFAULT_FONT_SIZE = 13, DEFAULT_ICON_SIZE = 24;
const TEXTY = new Set(["text", "note", "prompt", "context"]);

/**
 * One node's own properties scaled by `f`. Returns { props, kept }: props holds only values that change (new
 * objects, never the node's own arrays), kept the paths of token-bound values left alone ("cornerRadius.2",
 * "effect.0.blur"). o.root: the node is the scaled layer itself (its x/y are the anchor's business). o.bound: a
 * Set of paths that were tokens before resolution (the page scales resolved scenes; the server says which).
 */
export function scaleProps(node, f, o = {}) {
  const props = {}, kept = [];
  if (!node || typeof node !== "object" || !(f > 0) || f === 1) return { props, kept };
  const bound = o.bound;
  const tok = (v, path) => isTok(v) || (!!bound && bound.has(path));
  // A number at `path`: scaled, or kept (token), or left (not a number). `changed` notes a difference.
  let changed = false;
  const one = (v, path) => {
    if (tok(v, path)) { kept.push(path); return v; }
    if (!isNum(v)) return v;
    const s = r2(v * f);
    if (s !== v) changed = true;
    return s;
  };
  const put = (k, fn) => {
    if (!(k in node) || node[k] === undefined || node[k] === null) return;
    changed = false;
    const v = fn(node[k], k);
    if (changed) props[k] = v;
  };
  if (!o.root) { put("x", one); put("y", one); }
  if (TEXTY.has(node.type) && node.fontSize === undefined) props.fontSize = r2(DEFAULT_FONT_SIZE * f);
  if (node.type === "icon") for (const k of ["width", "height"]) if (node[k] === undefined) props[k] = r2(DEFAULT_ICON_SIZE * f);
  for (const k of ["width", "height"]) put(k, (v, p) => {
    if (typeof v === "string" && !isTok(v)) {
      const m = SIZING.exec(v.trim());
      if (!m || tok(v, p)) return v;
      const s = r2(Number(m[2]) * f);
      if (s !== Number(m[2])) changed = true;
      return `${m[1]}(${s})`;
    }
    return one(v, p);
  });
  for (const k of PLAIN) put(k, one);
  // Styled ranges of a text (src/page/text-spans.js): their own sizes and tracking scale with the layer's.
  put("spans", (v, p) => (Array.isArray(v) ? v.map((s, i) => {
    if (!s || typeof s !== "object") return s;
    const o2 = { ...s };
    for (const k of ["fontSize", "letterSpacing"]) if (k in s) o2[k] = one(s[k], `${p}.${i}.${k}`);
    return o2;
  }) : v));
  // Lists and per-side objects: a new array/object, each entry on its own (an entry can hold a token).
  const list = (v, p) => (Array.isArray(v) ? v.map((x, i) => one(x, `${p}.${i}`)) : one(v, p));
  put("cornerRadius", list);
  put("padding", list);
  put("strokeWidth", (v, p) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out = {};
      for (const [s, x] of Object.entries(v)) out[s] = one(x, `${p}.${s}`);
      return out;
    }
    return list(v, p);
  });
  put("effect", (v, p) => {
    const fx = (e, q) => {
      if (!e || typeof e !== "object" || Array.isArray(e)) return e;
      const out = { ...e };
      if (e.type === "shadow") {
        if (e.offset && typeof e.offset === "object") out.offset = { ...e.offset, x: one(e.offset.x, `${q}.offset.x`), y: one(e.offset.y, `${q}.offset.y`) };
        if ("blur" in e) out.blur = one(e.blur, `${q}.blur`);
        if ("spread" in e) out.spread = one(e.spread, `${q}.spread`);
      } else if (e.type === "blur" || e.type === "background_blur") {
        if ("radius" in e) out.radius = one(e.radius, `${q}.radius`);
      }
      for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
      return out;
    };
    return Array.isArray(v) ? v.map((e, i) => fx(e, `${p}.${i}`)) : fx(v, p);
  });
  return { props, kept };
}

/** The token-bound paths of one node (what scaleProps keeps): the server hands these to the page for its preview. */
export function boundPaths(node) {
  return scaleProps(node, 2, { root: false }).kept;
}

// ---------------------------------------------------------------- anchors and the drag

/** Named anchors (MCP, inspector) as fractions of the box. */
export const ANCHORS = {
  "top-left": [0, 0], top: [0.5, 0], "top-right": [1, 0],
  left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  "bottom-left": [0, 1], bottom: [0.5, 1], "bottom-right": [1, 1],
};

/** The fixed point of a scale drag from `handle` (n e s w and corners), as fractions: the opposite side, the centre with Option. */
export function anchorOf(handle, alt) {
  if (alt) return [0.5, 0.5];
  const ax = handle.includes("w") ? 1 : handle.includes("e") ? 0 : 0.5;
  const ay = handle.includes("n") ? 1 : handle.includes("s") ? 0 : 0.5;
  return [ax, ay];
}

/** `r` scaled by f about the point (px, py). */
export function scaleRectAbout(r, px, py, f) {
  return { x: px + (r.x - px) * f, y: py + (r.y - py) * f, w: r.w * f, h: r.h * f };
}

/**
 * A scale drag: the factor and the selection's new rect. r0: the rect at the press (world); dx, dy: pointer travel
 * in world units. o: { alt (about the centre), snap (live-edit edgeSnapper), round (the dragged side lands on whole
 * px), min (smallest factor) }. The aspect ratio always holds (Shift is implied).
 */
export function scaleDrag(r0, handle, dx, dy, o = {}) {
  const r = resizeRect(r0, handle, dx, dy, { shift: true, alt: o.alt, snap: o.snap, round: false, min: 0.01 });
  const horiz = handle.includes("e") || handle.includes("w");
  const base = horiz ? r0.w : r0.h;
  let f = base > 0 ? (horiz ? r.w : r.h) / base : 1;
  if (o.round !== false && base > 0) f = Math.max(1, Math.round(base * f)) / base;
  f = Math.max(o.min ?? 0.01, f);
  const [ax, ay] = anchorOf(handle, o.alt);
  const rect = scaleRectAbout(r0, r0.x + ax * r0.w, r0.y + ay * r0.h, f);
  return { f, rect, anchor: [ax, ay] };
}

/**
 * The preview of a scale on a resolved scene subtree (GET /api/scene): every node under and including `root`, with
 * the props scaleProps gives it. bound: Map(scene id -> Set of token paths) from the server's plan. Returns
 * [{id, props}] (root first; its x/y are left to the caller, which knows where the anchor puts it).
 */
export function scaleScene(root, f, bound) {
  const out = [];
  const walk = (n, isRoot) => {
    if (!n || typeof n !== "object") return;
    const id = String(n.id);
    const { props } = scaleProps(n, f, { root: isRoot, bound: bound && bound.get(id) });
    out.push({ id, props });
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c, false);
  };
  walk(root, true);
  return out;
}
