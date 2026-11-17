// Auto layout on the page, the pure half: which layers an auto layout frame places, where a dragged layer would
// land (slot finding), the order a reorder or a move gives a parent, arrow-key reorder, the insertion line, the
// frame a drag would drop into, the pink spacing handles' geometry, padding forms, and the slide animation's
// easing. No DOM, no globals: src/page/autolayout.js imports it, and node tests import the same file.
//
// Rects are world rects {x, y, w, h}. "Main" is the flow's axis (x for horizontal, y for vertical), "cross" the
// other one. A slot is an index among the frame's flow children that are not being dragged: slot k puts the
// dragged layers before the k-th of them (k = their count: after the last).

/** Blue: the insertion line and the drop target's outline. */
export const BLUE = "#0D99FF";
/** The spacing-handle pink. */
export const PINK = "#F24AB5";
/** A drag leaves its frame once the pointer is this far outside the frame's box (screen px). */
export const OUT_PX = 8;
/** The sibling slide, a short ease. */
export const SLIDE_MS = 160;
/** A spacing area narrower than this on screen shows no handle. */
export const HANDLE_MIN_PX = 6;
/** A gap of 0 or less shows its handle on an area this wide (screen px), centred on the seam. */
export const GAP_SEAM_PX = 8;
/** The handle bar, screen px (long side, short side). */
export const BAR = [12, 2];

/** How a node places its children: "horizontal" | "vertical" | "none" (a frame without `layout` is horizontal; groups never lay out). */
export function layoutOf(n) {
  if (!n || typeof n !== "object") return "none";
  if (n.type !== "frame") return "none";
  return n.layout === "vertical" || n.layout === "none" ? n.layout : "horizontal";
}
/** True when `child` is placed by its parent's auto layout (not absolute, the parent flows). */
export const inFlow = (parent, child) => layoutOf(parent) !== "none" && !!child && child.layoutPosition !== "absolute";
/** The canvas-only extras (scene `canvasLayout`, or the file's `metadata.canvasLayout`). */
export const extrasOf = (n) => (n && n.canvasLayout && typeof n.canvasLayout === "object" ? n.canvasLayout : n && n.metadata && n.metadata.canvasLayout && typeof n.metadata.canvasLayout === "object" ? n.metadata.canvasLayout : {});

/** Padding as [top, right, bottom, left] from any file form (number, [v, h], [t, r, b, l]). */
export function sides(p) {
  if (typeof p === "number" && Number.isFinite(p)) return [p, p, p, p];
  if (Array.isArray(p)) {
    const n = p.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
    if (n.length === 2) return [n[0], n[1], n[0], n[1]];
    if (n.length === 3) return [n[0], n[1], n[2], n[1]];
    if (n.length >= 4) return [n[0], n[1], n[2], n[3]];
    if (n.length === 1) return [n[0], n[0], n[0], n[0]];
  }
  return [0, 0, 0, 0];
}
/**
 * Padding written back in the file's form when the new sides fit it, widened only as far as needed: a number
 * stays a number while all four sides are equal, [v, h] while top = bottom and left = right.
 */
export function paddingForm(old, s) {
  const [t, r, b, l] = s;
  const all = t === r && r === b && b === l, pair = t === b && l === r;
  const form = typeof old === "number" ? 1 : Array.isArray(old) && old.length === 2 ? 2 : Array.isArray(old) && old.length >= 3 ? 4 : 1;
  if (form === 1 && all) return t;
  if (form <= 2 && pair) return [t, r];
  return [t, r, b, l];
}
/** Which padding sides a handle drag changes: the side, Option its opposite too, Option+Shift all four. 0 top, 1 right, 2 bottom, 3 left. */
export function sidesFor(side, alt, shift) {
  if (alt && shift) return [0, 1, 2, 3];
  if (alt) return side % 2 === 0 ? [0, 2] : [1, 3];
  return [side];
}
/**
 * Whether a handle drag steps by the big nudge (Shift sets padding or spacing with the big nudge). On a
 * padding Option+Shift means all four sides, so it moves by 1 px; a gap has no Option meaning.
 */
export const handleSteps = (kind, alt, shift) => !!shift && (kind === "gap" || !alt);

const mainOf = (dir) => (dir === "vertical" ? "y" : "x");
const crossOf = (dir) => (dir === "vertical" ? "x" : "y");
const sizeOf = (a) => (a === "x" ? "w" : "h");
const mid = (r, a) => r[a] + r[sizeOf(a)] / 2;

/**
 * Lines of a wrapped flow: items grouped by where they sit on the cross axis (a new line starts when an item
 * begins past the current line's cross extent). Each line: {start, end (cross), items: [indices]}.
 */
export function linesOf(rects, dir) {
  const c = crossOf(dir), cs = sizeOf(c);
  const lines = [];
  rects.forEach((r, i) => {
    const line = lines[lines.length - 1];
    if (line && r[c] < line.end - 0.5) { line.items.push(i); line.end = Math.max(line.end, r[c] + r[cs]); line.start = Math.min(line.start, r[c]); }
    else lines.push({ start: r[c], end: r[c] + r[cs], items: [i] });
  });
  return lines;
}

/**
 * The slot for a pointer among a frame's flow items (world rects, in flow order, the dragged layers left out):
 * the number of items whose main-axis middle lies before the pointer. Wrapped flows pick the line first (the one
 * the pointer is in, else the nearest), then the slot inside it.
 */
export function slotAt(rects, p, dir, wrap = false) {
  if (!rects.length) return 0;
  const m = mainOf(dir);
  let pool = rects.map((r, i) => i), base = 0;
  if (wrap) {
    const best = linesOf(rects, dir)[lineAt(rects, p, dir)];
    pool = best.items;
    base = best.items[0];
  }
  let k = 0;
  for (const i of pool) if (mid(rects[i], m) < p[m]) k++;
  return base + k;
}

/** The index (into linesOf) of the wrapped line a pointer is in, else the nearest one. */
export function lineAt(rects, p, dir) {
  const c = crossOf(dir);
  const lines = linesOf(rects, dir);
  let best = 0, bd = Infinity;
  lines.forEach((L, i) => {
    const d = p[c] < L.start ? L.start - p[c] : p[c] > L.end ? p[c] - L.end : 0;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/**
 * A parent's new child order (every child id) once `moving` (ids, in their order) lands at flow slot `slot`.
 * children: the parent's child ids now (moving ones may or may not be among them); flow: the ids of those that
 * flow, in order, the moving ones left out. Absolute children keep their place in the list.
 */
export function orderWith(children, flow, moving, slot) {
  const mv = new Set(moving);
  const rest = children.filter((id) => !mv.has(id));
  const f = flow.filter((id) => !mv.has(id));
  let at;
  if (slot <= 0) at = f.length ? rest.indexOf(f[0]) : rest.length;
  else if (slot >= f.length) at = f.length ? rest.indexOf(f[f.length - 1]) + 1 : rest.length;
  else at = rest.indexOf(f[slot]);
  if (at < 0) at = rest.length;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}
/** Where `orderWith` puts the first moving layer in the parent's children (the drawn list, hidden layers left out). */
export const indexIn = (order, first) => order.indexOf(first);
/**
 * The sibling the moving layers land right before in `order` (null: they end the list): /api/layout place's
 * `before`. The page's lists leave hidden layers out, the file's do not, so a sibling is sent instead of an index.
 */
export function beforeIn(order, moving) {
  const mv = new Set(moving);
  let last = -1;
  order.forEach((id, i) => { if (mv.has(id)) last = i; });
  for (let i = last + 1; i < order.length; i++) if (!mv.has(order[i])) return order[i];
  return null;
}

/** The flow slot the moving layers sit at now (the number of other flow items before the first of them), or -1. */
export function slotOf(flow, moving) {
  const mv = new Set(moving);
  const i = flow.findIndex((id) => mv.has(id));
  if (i < 0) return -1;
  return flow.slice(0, i).filter((id) => !mv.has(id)).length;
}

/**
 * Arrow-key reorder: in a horizontal flow Left/Right move the selection one slot earlier/later, in a
 * vertical flow Up/Down; the cross-axis arrows do nothing; the first and last stop at the end. Returns the new
 * slot, or null for no move. flow: flow ids in order; moving: the selected ones (siblings, kept as a block).
 */
export function arrowSlot(dir, dx, dy, flow, moving) {
  const step = dir === "vertical" ? Math.sign(dy) : Math.sign(dx);
  if (!step || (dir === "vertical" ? dx : dy)) return null;
  const now = slotOf(flow, moving);
  if (now < 0) return null;
  const others = flow.length - flow.filter((id) => moving.includes(id)).length;
  const next = Math.max(0, Math.min(others, now + step));
  return next === now ? null : next;
}

/**
 * The 2 px insertion line for slot `slot` of a frame (rect `f`, padding [t, r, b, l]) whose flow items (the
 * dragged layers left out) sit at `rects`: across the content box on the cross axis, centred in the gap, at the
 * padding edge before the first and after the last item. Wrapped flows span the slot's line: `line` (lineAt, the
 * line slotAt chose) when given, since the slot starting line 2 is also the one after line 1's last item.
 * Returns {x0, y0, x1, y1} (world).
 */
export function insertionLine(f, pad, rects, dir, slot, wrap = false, line = -1) {
  const m = mainOf(dir), c = crossOf(dir), ms = sizeOf(m), cs = sizeOf(c);
  const [t, r, b, l] = pad;
  const padStart = m === "x" ? l : t, padEnd = m === "x" ? r : b, crossStart = c === "x" ? l : t, crossEnd = c === "x" ? r : b;
  let c0 = f[c] + crossStart, c1 = f[c] + f[cs] - crossEnd;
  let pos;
  if (!rects.length) pos = f[m] + padStart;
  else {
    let lineItems = rects.map((_, i) => i);
    if (wrap) {
      const all = linesOf(rects, dir);
      const L = all[line] || all.find((x) => slot >= x.items[0] && slot <= x.items[x.items.length - 1] + 1) || all.slice(-1)[0];
      lineItems = L.items;
      c0 = L.start; c1 = L.end;
    }
    const first = lineItems[0], last = lineItems[lineItems.length - 1];
    const g = lineItems.length > 1 ? Math.max(0, (rects[last][m] - (rects[first][m] + rects[first][ms]) - lineItems.slice(1, -1).reduce((s, i) => s + rects[i][ms], 0)) / (lineItems.length - 1)) : 0;
    if (slot <= first) pos = Math.max(f[m] + padStart, rects[first][m] - g / 2);
    else if (slot > last) pos = Math.min(f[m] + f[ms] - padEnd, rects[last][m] + rects[last][ms] + g / 2);
    else {
      const a = rects[slot - 1], z = rects[slot];
      pos = (a[m] + a[ms] + z[m]) / 2;
    }
  }
  if (c1 < c0) [c0, c1] = [c1, c0];
  return m === "x" ? { x0: pos, y0: c0, x1: pos, y1: c1 } : { x0: c0, y0: pos, x1: c1, y1: pos };
}

/** True when point p (world) is more than `margin` (world units) outside rect r. */
export const outside = (r, p, margin) => p.x < r.x - margin || p.y < r.y - margin || p.x > r.x + r.w + margin || p.y > r.y + r.h + margin;
export const contains = (r, p) => !!r && p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h;

/**
 * The frame a drag would drop into: the deepest frame of a scene tree under point p that is not one of the
 * dragged layers (or inside one), and not inside a component instance. Auto layout frames must be at least as
 * big as the dragged box (`size` {w, h}) unless `any` (Cmd); a frame too small passes the drop to its parent.
 * `refuse`: components the dragged layers use (componentsIn); neither they nor anything inside them is a target,
 * since an instance inside its own component draws forever. rectOf(id) -> world rect | null. Returns {id, node,
 * layout} or null.
 */
export function dropTarget(root, p, rectOf, exclude, size, any = false, refuse = null) {
  let hit = null;
  const visit = (n, inInstance) => {
    if (!n || typeof n !== "object" || exclude.has(String(n.id)) || (refuse && refuse.has(String(n.id)))) return;
    const id = String(n.id);
    // A group is never a target, but the frames in it are.
    if (n.type === "group" && !inInstance) { for (const k of Array.isArray(n.children) ? n.children : []) visit(k, inInstance); return; }
    if (n.type !== "frame") return;
    const r = rectOf(id);
    if (!r || !contains(r, p)) return;
    const kids = Array.isArray(n.children) ? n.children : [];
    const instance = inInstance || id.includes("/") || typeof n.component === "string" || kids.some((k) => k && typeof k.id === "string" && k.id.startsWith(id + "/"));
    // A component instance never takes layers (its insides are the component's): the frame around it does.
    if (!instance) {
      const lay = layoutOf(n);
      const fits = any || lay === "none" || !size || (r.w >= size.w - 0.5 && r.h >= size.h - 0.5);
      if (fits) hit = { id, node: n, layout: lay };
    }
    if (instance) return; // a component instance's insides are the component's
    for (const k of kids) visit(k, instance);
  };
  visit(root, false);
  return hit;
}

/** The components a scene subtree uses: its instances' `component` (scene.ts), nested instances included. */
export function componentsIn(nodes) {
  const out = new Set();
  const visit = (n) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.component === "string") out.add(n.component);
    for (const c of Array.isArray(n.children) ? n.children : []) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** The nodes from a scene's root down to `id`'s parent (root first), or null when `id` is not in it. */
export function ancestorsOf(root, id) {
  const path = [];
  const visit = (n) => {
    if (!n || typeof n !== "object") return false;
    if (String(n.id) === id) return true;
    path.push(n);
    for (const c of Array.isArray(n.children) ? n.children : []) if (visit(c)) return true;
    path.pop();
    return false;
  };
  return visit(root) ? path : null;
}
/** True when a layer or any frame above it up to its board is rotated (a reorder drag works in world axes). */
export const rotatedPath = (root, id) => { const a = ancestorsOf(root, id); return !a || a.some((n) => Number(n.rotation)); };

/**
 * The pink spacing handles of an auto layout frame on screen. f: the frame's world rect; pad: [t, r, b, l];
 * kids: world rects of its flow children in order; cam {x, y, z}. Returns areas, each {kind: "pad" | "gap",
 * side (0..3, pads), index (gaps), rect (screen), bar (screen rect), cursor, value}; only areas at least
 * HANDLE_MIN_PX wide on screen get one. A gap of 0 or less (items touching or overlapping) still gets its handle,
 * GAP_SEAM_PX wide on the seam, so the gap can be dragged back out.
 */
export function spacingAreas(f, pad, kids, dir, cam, gap = 0, wrap = false) {
  const S = (r) => ({ x: r.x * cam.z + cam.x, y: r.y * cam.z + cam.y, w: r.w * cam.z, h: r.h * cam.z });
  const out = [];
  const [t, r, b, l] = pad;
  const bar = (s, vertical) => (vertical
    ? { x: s.x + s.w / 2 - BAR[1] / 2, y: s.y + s.h / 2 - BAR[0] / 2, w: BAR[1], h: BAR[0] }
    : { x: s.x + s.w / 2 - BAR[0] / 2, y: s.y + s.h / 2 - BAR[1] / 2, w: BAR[0], h: BAR[1] });
  const pads = [
    { side: 0, rect: { x: f.x + l, y: f.y, w: f.w - l - r, h: t }, vertical: false },
    { side: 1, rect: { x: f.x + f.w - r, y: f.y + t, w: r, h: f.h - t - b }, vertical: true },
    { side: 2, rect: { x: f.x + l, y: f.y + f.h - b, w: f.w - l - r, h: b }, vertical: false },
    { side: 3, rect: { x: f.x, y: f.y + t, w: l, h: f.h - t - b }, vertical: true },
  ];
  for (const p of pads) {
    const s = S(p.rect);
    const thick = p.vertical ? s.w : s.h;
    if (thick < HANDLE_MIN_PX || (p.vertical ? s.h : s.w) < BAR[0]) continue;
    out.push({ kind: "pad", side: p.side, rect: s, bar: bar(s, p.vertical), cursor: p.vertical ? "ew-resize" : "ns-resize", value: pad[p.side] });
  }
  if (kids.length > 1) {
    const m = mainOf(dir), c = crossOf(dir), ms = sizeOf(m), cs = sizeOf(c);
    const cStart = f[c] + (c === "x" ? l : t), cEnd = f[c] + f[cs] - (c === "x" ? r : b);
    const lines = wrap ? linesOf(kids, dir) : [{ start: cStart, end: cEnd, items: kids.map((_, i) => i) }];
    for (const L of lines) {
      for (let j = 1; j < L.items.length; j++) {
        const a = kids[L.items[j - 1]], z = kids[L.items[j]];
        let g0 = a[m] + a[ms], g1 = z[m];
        if (g1 - g0 <= 0) {
          const seam = (g0 + g1) / 2, half = GAP_SEAM_PX / 2 / (cam.z > 0 ? cam.z : 1);
          g0 = seam - half; g1 = seam + half;
        }
        const span = wrap ? { s: L.start, e: L.end } : { s: cStart, e: cEnd };
        const wr = m === "x" ? { x: g0, y: span.s, w: g1 - g0, h: span.e - span.s } : { x: span.s, y: g0, w: span.e - span.s, h: g1 - g0 };
        const s = S(wr);
        const vertical = m === "x";
        if ((vertical ? s.w : s.h) < HANDLE_MIN_PX) continue;
        out.push({ kind: "gap", index: L.items[j - 1], rect: s, bar: bar(s, vertical), cursor: vertical ? "ew-resize" : "ns-resize", value: gap });
      }
    }
  }
  return out;
}
/** The handle under a screen point: its bar (with `tol` px around it). */
export function handleUnder(areas, px, py, tol = 5, frame = null) {
  // The frame's own edge (screen rect `frame`): its outer pixels resize it (live-edit.js handleAt).
  if (frame) {
    const inX = Math.min(tol, frame.w / 4), inY = Math.min(tol, frame.h / 4);
    if (px <= frame.x + inX || px >= frame.x + frame.w - inX || py <= frame.y + inY || py >= frame.y + frame.h - inY) return null;
  }
  for (const a of areas) {
    const b = a.bar;
    if (px >= b.x - tol && px <= b.x + b.w + tol && py >= b.y - tol && py <= b.y + b.h + tol) return a;
  }
  return null;
}
/** A screen point inside frame rect f, clear of its outer `tol` px (those resize the frame). */
export function inside(f, px, py, tol = 5) {
  const inX = Math.min(tol, f.w / 4), inY = Math.min(tol, f.h / 4);
  return px > f.x + inX && px < f.x + f.w - inX && py > f.y + inY && py < f.y + f.h - inY;
}
/** The area under a screen point (to show its stripes on hover). */
export const areaUnder = (areas, px, py) => areas.find((a) => px >= a.rect.x && px <= a.rect.x + a.rect.w && py >= a.rect.y && py <= a.rect.y + a.rect.h) || null;

/**
 * A handle drag's new value: from `start`, the pointer's travel (screen px dx, dy) at zoom z, in the direction
 * that grows that spacing. Whole px while pixel snapping is on (`pixel`; else hundredths); `steps` snaps to steps
 * of `big` (Shift, see handleSteps). Padding stays at 0 or more; a gap may go
 * negative (the items overlap).
 */
export function dragValue(a, start, dx, dy, z, steps = false, big = 10, pixel = true) {
  let d;
  if (a.kind === "pad") d = a.side === 0 ? dy : a.side === 1 ? -dx : a.side === 2 ? -dy : dx;
  else d = a.cursor === "ew-resize" ? dx : dy;
  let v = start + d / (z > 0 ? z : 1);
  v = steps ? Math.round(v / big) * big : pixel ? Math.round(v) : Math.round(v * 100) / 100;
  if (a.kind === "pad") v = Math.max(0, v);
  return Object.is(v, -0) ? 0 : v;
}

/** easeOutCubic. */
export const ease = (t) => (t >= 1 ? 1 : t <= 0 ? 0 : 1 - Math.pow(1 - t, 3));
export const lerp = (a, b, t) => a + (b - a) * t;
export const lerpRect = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });
/** A rect relative to another's origin. */
export const rel = (r, o) => ({ x: r.x - o.x, y: r.y - o.y, w: r.w, h: r.h });

/** Smallest box an auto layout frame can be resized to: its padding. */
export function minSize(pad) {
  const [t, r, b, l] = pad;
  return { w: Math.max(1, l + r), h: Math.max(1, t + b) };
}
/** A resize rect clamped to a minimum size, keeping the edge opposite the handle where it was. */
export function clampResize(r, r0, handle, min) {
  const out = { ...r };
  if (out.w < min.w) { if (handle.includes("w")) out.x = r.x + r.w - min.w; out.w = min.w; }
  if (out.h < min.h) { if (handle.includes("n")) out.y = r.y + r.h - min.h; out.h = min.h; }
  return out;
}

/** Scene surgery shared with live-edit.js: see applyOrder there. */
export { applyOrder } from "./live-edit.js";

/**
 * Whether a padding or gap handle drag changed anything: a drag that ends on the values it started from writes
 * nothing (it would pin the values on an instance as an override, and add an undo step that does nothing).
 * `start` is {pad: [t, r, b, l], gap, auto}; `props` the write the handle would make.
 */
export function handleChanged(start, props) {
  if (!props) return false;
  if (props.padding !== undefined) {
    const now = sides(props.padding);
    return now.some((v, i) => v !== start.pad[i]);
  }
  if (props.gap !== undefined) return !!start.auto || props.gap !== start.gap;
  return true;
}
