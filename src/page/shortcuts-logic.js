// Pure math for the canvas shortcuts (src/page/shortcuts.js): Option+hover distances, Option+W/A/S/D/H/V
// alignment, Tab sibling walking and Cmd+D repeating the last duplicate's offset. Node-tested
// (test/shortcuts.test.ts). Rects are world rects {x, y, w, h}.
import { unrotatedSize } from "./geometry.js";
import { toggleList } from "./text-paras.js";

/** The box around rects (nulls skipped), or null. */
export function unionOf(rs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) {
    if (!r) continue;
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const contains = (o, i) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
const r2 = (v) => Math.round(v * 100) / 100;
const line = (x1, y1, x2, y2) => ({ x1, y1, x2, y2, d: r2(Math.abs(x2 - x1) + Math.abs(y2 - y1)) });

/**
 * Option+hover measurement from the selection `a` to the hovered layer `b`: red distance lines (each with
 * its length d) and dashed extensions where a line ends beside `b` instead of on it.
 * - One inside the other: a line from each side of the inner box to the outer box's side, on the inner box's centre lines.
 * - Apart: the gap between facing edges; on the shared band when they overlap on the other axis, else from a's
 *   centre line, with a dashed line from b's corner to where the gap line ends.
 * - Overlapping: the distance between each pair of matching edges that differ.
 * Same box, or nothing to measure: no lines.
 */
export function measureLines(a, b) {
  const out = { lines: [], dashes: [] };
  if (!a || !b) return out;
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
  const ar = a.x + a.w, ab = a.y + a.h, br = b.x + b.w, bb = b.y + b.h;
  const push = (l) => { if (l.d > 0) out.lines.push(l); };
  if (contains(b, a) || contains(a, b)) {
    const i = contains(b, a) ? a : b, o = i === a ? b : a;
    const icx = i.x + i.w / 2, icy = i.y + i.h / 2;
    push(line(o.x, icy, i.x, icy));
    push(line(i.x + i.w, icy, o.x + o.w, icy));
    push(line(icx, o.y, icx, i.y));
    push(line(icx, i.y + i.h, icx, o.y + o.h));
    return out;
  }
  const apartX = ar <= b.x || br <= a.x, apartY = ab <= b.y || bb <= a.y;
  if (!apartX && !apartY) {
    // Overlapping: matching edges.
    push(line(Math.min(a.x, b.x), acy, Math.max(a.x, b.x), acy));
    push(line(Math.min(ar, br), acy, Math.max(ar, br), acy));
    push(line(acx, Math.min(a.y, b.y), acx, Math.max(a.y, b.y)));
    push(line(acx, Math.min(ab, bb), acx, Math.max(ab, bb)));
    return out;
  }
  if (apartX) {
    const x1 = ar <= b.x ? ar : br, x2 = ar <= b.x ? b.x : a.x;
    if (!apartY) {
      const y = (Math.max(a.y, b.y) + Math.min(ab, bb)) / 2;
      push(line(x1, y, x2, y));
    } else {
      push(line(x1, acy, x2, acy));
      const bx = ar <= b.x ? b.x : br, by = acy < b.y ? b.y : bb;
      out.dashes.push({ x1: bx, y1: by, x2: bx, y2: acy });
    }
  }
  if (apartY) {
    const y1 = ab <= b.y ? ab : bb, y2 = ab <= b.y ? b.y : a.y;
    if (!apartX) {
      const x = (Math.max(a.x, b.x) + Math.min(ar, br)) / 2;
      push(line(x, y1, x, y2));
    } else {
      push(line(acx, y1, acx, y2));
      const by = ab <= b.y ? b.y : bb, bx = acx < b.x ? b.x : br;
      out.dashes.push({ x1: bx, y1: by, x2: acx, y2: by });
    }
  }
  return out;
}

/** Option+key -> alignment: W top, A left, S bottom, D right, H horizontal centres, V vertical centres. */
export const ALIGN_KEYS = { KeyW: "top", KeyA: "left", KeyS: "bottom", KeyD: "right", KeyH: "hcenter", KeyV: "vcenter" };

/** How far each rect moves to align it in `target` (the selection's box, or a lone layer's parent). */
export function alignDeltas(rects, target, how) {
  return rects.map((r) => {
    if (!r || !target) return { dx: 0, dy: 0 };
    let dx = 0, dy = 0;
    if (how === "left") dx = target.x - r.x;
    else if (how === "right") dx = target.x + target.w - (r.x + r.w);
    else if (how === "hcenter") dx = target.x + target.w / 2 - (r.x + r.w / 2);
    else if (how === "top") dy = target.y - r.y;
    else if (how === "bottom") dy = target.y + target.h - (r.y + r.h);
    else if (how === "vcenter") dy = target.y + target.h / 2 - (r.y + r.h / 2);
    return { dx: r2(dx), dy: r2(dy) };
  });
}

/**
 * Tab / Shift+Tab: the next or previous sibling in the layers panel's order (top of the stack first, so
 * Tab walks down the stack), wrapping at the ends. `children` is the parent's list as the file has it (bottom
 * first). Null when there is no other sibling.
 */
export function siblingStep(children, id, back) {
  const panel = children.slice().reverse();
  const i = panel.indexOf(id);
  if (i < 0 || panel.length < 2) return null;
  const n = panel.length;
  return panel[(i + (back ? n - 1 : 1)) % n];
}

/**
 * Cmd+D after a duplicate was moved (smart duplicate): when the selection is exactly the last copies,
 * the next copies keep the step the last copies made from their originals. `last`: {src: ids, copies: ids};
 * rectOf(id) -> world rect. Returns {dx, dy}, or null for a plain Cmd+D.
 */
export function repeatOffset(last, selection, rectOf) {
  if (!last || !Array.isArray(last.copies) || !last.copies.length || !Array.isArray(selection)) return null;
  if (selection.length !== last.copies.length || selection.some((id) => !last.copies.includes(id))) return null;
  const a = rectOf(last.src[0]), b = rectOf(last.copies[0]);
  if (!a || !b) return null;
  const dx = r2(b.x - a.x), dy = r2(b.y - a.y);
  return dx || dy ? { dx, dy } : null;
}

/** Shift+H / Shift+V: what each layer's flipX (or flipY) becomes, grouped so equal values go in one write. */
export function flipGroups(nodes, prop) {
  const on = [], off = [];
  for (const n of nodes) (n[prop] === true ? off : on).push(n.id);
  return { on, off };
}

/**
 * Shift+H / Shift+V as writes that keep each layer where it shows: [{id, props: {flipX | flipY, x | y}}]. A
 * flip mirrors about the layer's top-left corner, so turning it on moves the stored x by the width (off: back).
 * rectOf(id): the layer's world rect (its width and height as drawn).
 */
export function flipItems(nodes, prop, rectOf) {
  const axis = prop === "flipX" ? "x" : "y", size = prop === "flipX" ? "w" : "h";
  const out = [];
  for (const n of nodes) {
    if (!n || typeof n.id !== "string") continue;
    const on = n[prop] !== true, r = rectOf(n.id);
    const props = { [prop]: on };
    if (r) props[axis] = Math.round(((Number(n[axis]) || 0) + (on ? r[size] : -r[size])) * 100) / 100;
    out.push({ id: n.id, props });
  }
  return out;
}

/** Cmd+Shift+H: any shown layer in the selection hides them all; all hidden shows them. */
export const hideAll = (nodes) => nodes.some((n) => n.enabled !== false);

/** Shift+Cmd+L: any unlocked layer in the selection locks them all; all locked unlocks them. */
export const lockAll = (nodes) => nodes.some((n) => n.locked !== true);

/** Select inverse (Shift+Cmd+A): what Select All would take in the selection's scope, minus the selection. */
export const inverseOf = (scope, selected) => scope.filter((id) => !selected.includes(id));

/**
 * The Layers panel's keys the page hears: Shift+Cmd+L lock or unlock, Shift+Cmd+A select inverse,
 * Option+Cmd+A select matching layers, Option+L collapse every open row. Null for anything else.
 */
export function layerKey(e) {
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.shiftKey && !e.altKey && e.code === "KeyL") return "lock";
  if (cmd && e.shiftKey && !e.altKey && e.code === "KeyA") return "selectInverse";
  if (cmd && e.altKey && !e.shiftKey && e.code === "KeyA") return "selectMatching";
  if (!cmd && e.altKey && !e.shiftKey && e.code === "KeyL") return "collapseLayers";
  return null;
}

/**
 * Digit keys set the selection's opacity: 1 is 10%, 9 is 90%, 0 is 100%; two digits typed quickly are a
 * percentage (4 then 5 is 45%, 0 then 0 is 0%). `prev`: the digit typed just before, inside the window, or null.
 */
export function opacityFromDigits(prev, digit) {
  if (prev !== null && prev !== undefined) return Number(String(prev) + String(digit)) / 100;
  return digit === 0 ? 1 : digit / 10;
}

/**
 * Zoom keys: Shift+1 fits the page, Shift+2 the selection, Shift+0 is 100%. Bare digits never zoom (they are
 * opacity), and F does nothing: it stays free for a frame tool rather
 * than doing something a designer's hand does not expect. Matches on `code` so Shift+1 is "Digit1" on every layout.
 */
export function zoomKey(e) {
  if (!e || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return null;
  return { Digit1: "fitAll", Digit2: "fitSelection", Digit0: "zoom100" }[e.code] ?? null;
}

/** Option+Shift+H / V: equal gaps between 3 or more rects along x ("h") or y ("v"); the outer two stay. */
export function distributeDeltas(rects, axis) {
  const out = rects.map(() => ({ dx: 0, dy: 0 }));
  const live = rects.map((r, i) => ({ r, i })).filter((o) => o.r);
  if (live.length < 3) return out;
  const p = axis === "h" ? "x" : "y", s = axis === "h" ? "w" : "h";
  live.sort((a, b) => a.r[p] - b.r[p] || a.i - b.i);
  const first = live[0].r, last = live.reduce((m, o) => (o.r[p] + o.r[s] > m[p] + m[s] ? o.r : m), live[0].r);
  const sizes = live.reduce((t, o) => t + o.r[s], 0);
  const gap = (last[p] + last[s] - first[p] - sizes) / (live.length - 1);
  let at = first[p];
  for (const o of live) {
    const d = r2(at - o.r[p]);
    out[o.i] = axis === "h" ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    at += o.r[s] + gap;
  }
  return out;
}

/**
 * A layer's own size for Cmd+arrows: the file's width and height where they are numbers, else the drawn box, turned
 * back by the layer's rotation (a turned layer's drawn box is wider than the layer). `drawn` is the world rect.
 */
export function ownSize(node, drawn) {
  if (!drawn || !node) return drawn;
  const fw = typeof node.width === "number" ? node.width : undefined, fh = typeof node.height === "number" ? node.height : undefined;
  const turned = typeof node.rotation === "number" && node.rotation % 180 !== 0;
  if (fw !== undefined && fh !== undefined) return { x: drawn.x, y: drawn.y, w: fw, h: fh };
  const own = turned ? unrotatedSize(drawn.w, drawn.h, node.rotation, fw, fh) : null;
  return { x: drawn.x, y: drawn.y, w: fw ?? (own ? own.w : drawn.w), h: fh ?? (own ? own.h : drawn.h) };
}

/**
 * Cmd+arrows: Right/Down grow width/height, Left/Up shrink them, by `step`; never below 1. `lock`: the layer's
 * Lock aspect ratio is on, so the other side follows.
 */
export function resizeBy(rect, key, step, lock = false) {
  if (!rect) return null;
  const ratio = lock && rect.w > 0 && rect.h > 0;
  if (key === "ArrowRight" || key === "ArrowLeft") {
    const width = r2(key === "ArrowRight" ? rect.w + step : Math.max(1, rect.w - step));
    return ratio ? { width, height: r2(Math.max(0.01, width * rect.h / rect.w)) } : { width };
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    const height = r2(key === "ArrowDown" ? rect.h + step : Math.max(1, rect.h - step));
    return ratio ? { height, width: r2(Math.max(0.01, height * rect.w / rect.h)) } : { height };
  }
  return null;
}

/** Whether a stored node has Lock aspect ratio on (metadata.canvasLockAspect, set beside W and H). */
export const aspectLocked = (node) => !!(node && node.metadata && typeof node.metadata === "object" && node.metadata.canvasLockAspect === true);

/**
 * Cmd+Option+Up/Down (keyboard rotate): the layer turns 1 degree, Up adding, Down taking away, kept in
 * -180...180 like the inspector shows it. A rotation bound to a variable is left alone (null).
 */
export function rotateBy(node, key) {
  if (key !== "ArrowUp" && key !== "ArrowDown") return null;
  const cur = node ? node.rotation : undefined;
  if (cur !== undefined && typeof cur !== "number") return null;
  let a = ((cur || 0) + (key === "ArrowUp" ? 1 : -1)) % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return { rotation: r2(a) || 0 };
}

/** Text style keys on selected text layers: what each node's write is. `what`: bold, italic, underline, strike, bigger, smaller. */
export function textToggle(nodes, what) {
  const text = nodes.filter((n) => n && n.type === "text");
  const weight = (n) => Number(n.fontWeight) || 400;
  const out = [];
  if (what === "bold") {
    const all = text.length && text.every((n) => weight(n) >= 600);
    for (const n of text) out.push({ id: n.id, props: { fontWeight: all ? "400" : "700" }, remove: [] });
  } else if (what === "italic") {
    const all = text.length && text.every((n) => n.fontStyle === "italic");
    for (const n of text) out.push(all ? { id: n.id, props: {}, remove: ["fontStyle"] } : { id: n.id, props: { fontStyle: "italic" }, remove: [] });
  } else if (what === "underline" || what === "strike") {
    const k = what === "underline" ? "underline" : "strikethrough";
    const all = text.length && text.every((n) => n[k] === true);
    for (const n of text) out.push(all ? { id: n.id, props: {}, remove: [k] } : { id: n.id, props: { [k]: true }, remove: [] });
  } else if (what === "bigger" || what === "smaller") {
    for (const n of text) {
      const fs = typeof n.fontSize === "number" ? n.fontSize : 14;
      out.push({ id: n.id, props: { fontSize: Math.max(1, fs + (what === "bigger" ? 1 : -1)) }, remove: [] });
    }
  } else if (what === "list-bullet" || what === "list-number") {
    // Every paragraph of every layer a list item, or none when they all already are of this kind (src/page/text-paras.js).
    const type = what.slice(5);
    const all = text.length && text.every((n) => { const c = String(n.content ?? ""); return toggleList(n.lists, c, 0, c.length, type).length === 0; });
    for (const n of text) {
      const c = String(n.content ?? "");
      out.push(all ? { id: n.id, props: {}, remove: ["lists"] } : { id: n.id, props: { lists: toggleList(Array.isArray(n.lists) ? n.lists : [], c, 0, c.length, type) }, remove: [] });
    }
  } else if (what.startsWith("align-")) {
    for (const n of text) out.push({ id: n.id, props: { textAlign: what.slice(6) }, remove: [] });
  } else {
    for (const n of text) { const p = typeStep(n, what); if (p) out.push({ id: n.id, props: p, remove: [] }); }
  }
  return out;
}

const r4 = (v) => Math.round(v * 10000) / 10000;
/** The engine's line height for text without one (engine/src/text.rs default_line_height). */
const AUTO_LINE_HEIGHT = 1.45;
/**
 * Type keys, one press on one text layer, from its own value: Option+&gt; / &lt; letter spacing by 0.1 px,
 * Option+Shift+&gt; / &lt; line height by 1 px (an Auto line height becomes the px it draws at, rounded, then steps),
 * Option+Cmd+&gt; / &lt; font weight to the next hundred (100 to 900). `what`: tracking+, tracking-,
 * leading+, leading-, weight+, weight-. The props to write, or null (a variable-bound value, nothing to step).
 */
export function typeStep(n, what) {
  const up = what.endsWith("+");
  if (what.startsWith("tracking")) {
    const ls = n.letterSpacing === undefined ? 0 : n.letterSpacing;
    if (typeof ls !== "number") return null;
    return { letterSpacing: r4(ls + (up ? 0.1 : -0.1)) };
  }
  if (what.startsWith("leading")) {
    const size = n.fontSize === undefined ? 13 : n.fontSize;
    if (typeof size !== "number" || !(size > 0)) return null;
    const lh = n.lineHeight === undefined ? AUTO_LINE_HEIGHT : n.lineHeight;
    if (typeof lh !== "number") return null;
    const px = Math.round(lh * size), next = Math.max(1, px + (up ? 1 : -1));
    const v = r4(next / size);
    return v === n.lineHeight ? null : { lineHeight: v };
  }
  if (what.startsWith("weight")) {
    if (typeof n.fontWeight === "string" && n.fontWeight.startsWith("$")) return null;
    const s = typeof n.fontWeight === "string" ? n.fontWeight.trim().toLowerCase() : n.fontWeight;
    const w = s === undefined || s === "" || s === "normal" || s === "regular" ? 400 : s === "bold" ? 700 : Number(s) || 400;
    const next = up ? Math.floor(w / 100) * 100 + 100 : Math.ceil(w / 100) * 100 - 100;
    if (next < 100 || next > 900) return null;
    return { fontWeight: String(next) };
  }
  return null;
}

/** Writes with the same change in one request (several ids share one undo step). */
export function batchWrites(writes) {
  const by = new Map();
  for (const w of writes) {
    const k = JSON.stringify([w.props, w.remove]);
    if (!by.has(k)) by.set(k, { ids: [], props: w.props, remove: w.remove });
    by.get(k).ids.push(w.id);
  }
  return [...by.values()];
}

// Copy / paste properties (Opt+Cmd+C / Opt+Cmd+V): the look of a layer, as the Canvas schema allows it per type.
const LOOK = ["fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeAlignment", "effect", "opacity"];
const TEXT_LOOK = ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "fontStyle", "underline", "lineHeight", "textAlign", "textAlignVertical", "strikethrough"];
const TAKES = {
  frame: [...LOOK, "cornerRadius"], rectangle: [...LOOK, "cornerRadius"], polygon: [...LOOK, "cornerRadius"],
  ellipse: LOOK, path: LOOK, text: [...LOOK, ...TEXT_LOOK], group: ["effect", "opacity"], icon: ["fill", "effect", "opacity"],
};
/** The properties copied from a layer: every look key it has. */
export function copyLook(n) {
  const out = { type: n.type, props: {} };
  for (const k of [...LOOK, "cornerRadius", ...TEXT_LOOK]) if (n[k] !== undefined) out.props[k] = n[k];
  return out;
}
/** Types that hold fill and stroke (Option+/, Shift+/, Shift+X skip the rest). */
const PAINTED = new Set(["frame", "rectangle", "ellipse", "polygon", "path", "text", "ref", "icon"]);
const hasPaint = (v) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);

/**
 * Option+/ (fill) and Shift+/ (stroke): remove every paint of that kind. An instance writes an empty list so its
 * component's paints do not come back; a stroke takes its width and position with it. Null: nothing to remove.
 */
export function removePaintWrite(n, key) {
  if (!n || !PAINTED.has(n.type) || (key === "stroke" && n.type === "icon")) return null;
  if (n.type === "ref") return { props: { [key]: [] }, remove: [] };
  if (!hasPaint(n[key])) return null;
  return { props: {}, remove: key === "stroke" ? ["stroke", "strokeWidth", "strokeAlignment"].filter((k) => n[k] !== undefined) : [key] };
}

/**
 * Shift+X: the fill becomes the stroke and the stroke the fill. A stroke that appears gets 1 px (the first
 * stroke's width) when the layer had no width. Null when neither is set or the type has no stroke.
 */
export function swapPaintWrite(n) {
  if (!n || !PAINTED.has(n.type) || n.type === "icon") return null;
  const fill = hasPaint(n.fill) ? n.fill : undefined, stroke = hasPaint(n.stroke) ? n.stroke : undefined;
  if (fill === undefined && stroke === undefined) return null;
  const props = {}, remove = [];
  if (stroke !== undefined) props.fill = stroke; else if (n.type === "ref") props.fill = []; else remove.push("fill");
  if (fill !== undefined) {
    props.stroke = fill;
    if (n.strokeWidth === undefined) props.strokeWidth = 1;
  } else if (n.type === "ref") props.stroke = [];
  else remove.push("stroke");
  return { props, remove };
}

/**
 * Control+Cmd+M (Use as mask): every selected layer becomes a mask, or, when all already are, stops being
 * one. Boards (top-level frames) are never masks. Null: nothing to change.
 */
export function maskWrites(nodes, isBoard = () => false) {
  const list = nodes.filter((n) => n && n.id && !isBoard(n.id));
  if (!list.length) return null;
  const on = !list.every((n) => n.mask === true);
  return list.map((n) => (on ? { id: n.id, props: { mask: true }, remove: [] } : { id: n.id, props: {}, remove: ["mask"] }));
}

/** What pasting copied properties does to a layer of `type`: the keys it takes are set; fill, stroke and effect it lacks in the copy go. */
export function pasteLook(look, type) {
  const takes = TAKES[type];
  if (!look || !takes) return null;
  const props = {}, remove = [];
  for (const k of takes) {
    if (k in look.props) props[k] = look.props[k];
    else if (k === "fill" || k === "stroke" || k === "effect") remove.push(k);
  }
  return Object.keys(props).length || remove.length ? { props, remove } : null;
}

/** N / Shift+N: the board after (or before) `id` in `order`, wrapping; the first (or last) when id is not a board. */
export function nextBoard(order, id, back) {
  if (!order.length) return null;
  const i = order.indexOf(id);
  if (i < 0) return back ? order[order.length - 1] : order[0];
  return order[(i + (back ? order.length - 1 : 1)) % order.length];
}
