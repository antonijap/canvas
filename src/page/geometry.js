// Pure helpers for the widget layer. No DOM, no globals: the page imports this as a module and
// node tests import the same file. Camera `cam` is {x, y, z}: world point p shows at p * z + (x, y)
// in the view's own coordinate space.

export const LOD_ZOOM = 0.25;
export const MOUNT_MARGIN = 0.6;
export const LEASE_MARGIN = 0.3;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const worldToView = (cam, p) => ({ x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y });
export const viewToWorld = (cam, p) => ({ x: (p.x - cam.x) / cam.z, y: (p.y - cam.y) / cam.z });

/** A world rect as view pixels. */
export function rectToView(cam, r) {
  return { x: r.x * cam.z + cam.x, y: r.y * cam.z + cam.y, w: r.w * cam.z, h: r.h * cam.z };
}

export function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** The part of the world on screen, grown by `margin` of the view size on every side. */
export function visibleWorldRect(cam, viewW, viewH, margin = 0) {
  const mx = viewW * margin, my = viewH * margin;
  return { x: (-mx - cam.x) / cam.z + 0, y: (-my - cam.y) / cam.z + 0, w: (viewW + mx * 2) / cam.z, h: (viewH + my * 2) / cam.z };
}

/** Ids of the widgets that touch the visible area. Order follows the list. */
export function idsInView(widgets, cam, viewW, viewH, margin = 0) {
  const area = visibleWorldRect(cam, viewW, viewH, margin);
  return widgets.filter((w) => rectsIntersect(area, w)).map((w) => w.id);
}

/** Level of detail flips below one zoom. Returns the new value only on a crossing, else null. */
export const lodCrossing = (prevLow, z) => {
  const low = z < LOD_ZOOM;
  return low === prevLow ? null : low;
};

export const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** Top-left for a new widget so its middle sits at the middle of the free part of the view. */
export function placeCentered(cam, viewW, viewH, insets, size) {
  const cx = insets.l + (viewW - insets.l - insets.r) / 2, cy = insets.t + (viewH - insets.t - insets.b) / 2;
  const c = viewToWorld(cam, { x: cx, y: cy });
  return { x: Math.round(c.x - size.w / 2), y: Math.round(c.y - size.h / 2) };
}

/** A camera that shows `r` centred in the free part of the view, never zoomed past `maxZ`. */
export function camToReveal(r, viewW, viewH, insets, { pad = 70, minZ = 0.02, maxZ = 1 } = {}) {
  const vw = viewW - insets.l - insets.r, vh = viewH - insets.t - insets.b;
  const z = clamp(Math.min((vw - pad * 2) / r.w, (vh - pad * 2) / r.h), minZ, maxZ);
  return { z, x: insets.l + (vw - r.w * z) / 2 - r.x * z, y: insets.t + (vh - r.h * z) / 2 - r.y * z };
}

/**
 * Drag one corner or edge of a rect by (dx, dy) world pixels. `handle` is a corner "tl" | "tr" | "bl" | "br"
 * or an edge "t" | "r" | "b" | "l" (an edge changes one dimension). The opposite corner or edge stays put.
 * Size never goes under `min`; Shift keeps the starting aspect ratio.
 */
export function resizeRect(r, handle, dx, dy, min = { w: 40, h: 40 }, lockAspect = false, fromCentre = false) {
  const left = handle.includes("l"), top = handle.includes("t");
  const sideways = handle !== "t" && handle !== "b", upways = handle !== "l" && handle !== "r";
  // Option resizes about the centre: the pointer's travel counts on both sides of the axis.
  const k = fromCentre ? 2 : 1;
  let w = sideways ? r.w + (left ? -dx : dx) * k : r.w, h = upways ? r.h + (top ? -dy : dy) * k : r.h;
  if (lockAspect && r.w > 0 && r.h > 0) {
    const ratio = r.w / r.h;
    // Follow whichever axis moved further, in proportion to its own size.
    if (Math.abs(w / r.w - 1) >= Math.abs(h / r.h - 1)) h = w / ratio;
    else w = h * ratio;
    if (w < min.w) { w = min.w; h = w / ratio; }
    if (h < min.h) { h = min.h; w = h * ratio; }
  } else {
    w = Math.max(min.w, w);
    h = Math.max(min.h, h);
  }
  w = Math.round(w);
  h = Math.round(h);
  // Anchor: the opposite side stays; the centre with Option; an edge drag with Shift grows the other axis about the middle.
  const midX = fromCentre || (lockAspect && !sideways), midY = fromCentre || (lockAspect && !upways);
  const x = midX ? Math.round(r.x + (r.w - w) / 2) : left ? r.x + r.w - w : r.x;
  const y = midY ? Math.round(r.y + (r.h - h) / 2) : top ? r.y + r.h - h : r.y;
  return { x, y, w, h };
}

/** A card's corner radius in world px (widgets.css .wd). */
export const CARD_RADIUS = 12;

/**
 * Which resize zone of a card a point is in: (x, y) from the card's top-left and its size (w, h), all in screen
 * px, so the zones keep their size at any zoom. Edges are `band` px deep inside the card; corners reach twice
 * that along each edge. Cards too small on screen have none: a press there moves the card.
 * `radius` is the card's corner radius in screen px: a point outside the rounded corner is not on the card.
 */
export function resizeZone(x, y, w, h, band = 6, radius = 0) {
  if (w < band * 4 || h < band * 4 || x < 0 || y < 0 || x > w || y > h) return null;
  if (radius > 0) {
    const r = Math.min(radius, w / 2, h / 2);
    const cx = x < r ? r : x > w - r ? w - r : x, cy = y < r ? r : y > h - r ? h - r : y;
    if (Math.hypot(x - cx, y - cy) > r) return null;
  }
  const reach = band * 2;
  const t = y < band, b = y > h - band, l = x < band, r = x > w - band;
  if (!(t || b || l || r)) return null;
  const nt = y < reach, nb = y > h - reach, nl = x < reach, nr = x > w - reach;
  if (nt && nl) return "tl";
  if (nt && nr) return "tr";
  if (nb && nl) return "bl";
  if (nb && nr) return "br";
  return t ? "t" : b ? "b" : l ? "l" : "r";
}
export const ZONE_CURSOR = { tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize", t: "ns-resize", b: "ns-resize", l: "ew-resize", r: "ew-resize" };

/** Moves a rect by (dx, dy), rounded to whole pixels. */
export const moveRect = (r, dx, dy) => ({ x: Math.round(r.x + dx), y: Math.round(r.y + dy), w: r.w, h: r.h });

export const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** Points for a polyline in a w×h box: oldest left, newest right. Flat series draw a middle line. */
export function sparkPoints(values, w = 100, h = 30, pad = 2) {
  const v = (values || []).filter((n) => typeof n === "number" && Number.isFinite(n));
  if (v.length < 2) return "";
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo;
  return v
    .map((n, i) => {
      const x = (i / (v.length - 1)) * w;
      const y = span === 0 ? h / 2 : h - pad - ((n - lo) / span) * (h - pad * 2);
      return round1(x) + "," + round1(y);
    })
    .join(" ");
}
const round1 = (n) => Math.round(n * 10) / 10;

/** How many to-do rows fit under the header, and what to say about the rest. */
export function fitRows(height, rowH, chrome, total) {
  const cap = Math.max(1, Math.floor((height - chrome) / rowH));
  if (total <= cap) return { shown: total, more: 0 };
  // The "+N more" line takes a row of its own.
  const shown = Math.max(0, cap - 1);
  return { shown, more: total - shown };
}

/** Which way a delta points, for the chip colour. */
export const deltaSign = (d) => (!d || !Number.isFinite(d.value) || d.value === 0 ? 0 : d.value > 0 ? 1 : -1);

/** Seconds since `t` (epoch ms), or null when unknown. */
export const ageSec = (t, now = Date.now()) => (typeof t === "number" ? Math.max(0, Math.round((now - t) / 1000)) : null);

/** Short "12s", "5m", "2h" label. */
export function ageLabel(sec) {
  if (sec === null || sec === undefined) return "";
  if (sec < 60) return sec + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  return Math.floor(sec / 3600) + "h";
}

/** The origin a key would be sent to, for the approval prompt. Empty when the config has none. */
export function originOf(kind, config) {
  try {
    if (kind === "posthog") {
      const h = config && config.host;
      if (h === "eu") return "https://eu.posthog.com";
      if (h === "us" || !h) return "https://us.posthog.com";
      return new URL(h).origin;
    }
    return config && config.url ? new URL(config.url).origin : "";
  } catch {
    return "";
  }
}

/** The smallest rect holding all of `rects` (null for none). */
export function unionRect(rects) {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/**
 * Where the camera should go to show a token's usages ("click a token in the library"). `boxes` are the world boxes
 * of the boards on this page that hold a usage. Null when one is already on screen. Otherwise the union of them all,
 * or, when that is too far out to read (zoom below minZ), the box nearest the current view centre.
 */
export function usageFocus(boxes, cam, viewW, viewH, insets = { l: 0, t: 0, r: 0, b: 0 }, minZ = 0.12) {
  if (!boxes.length) return null;
  const free = { x: insets.l, y: insets.t, w: viewW - insets.l - insets.r, h: viewH - insets.t - insets.b };
  if (boxes.some((b) => rectsIntersect(rectToView(cam, b), free))) return null;
  const all = unionRect(boxes);
  const z = camToReveal(all, viewW, viewH, insets, { pad: 90, minZ: 0, maxZ: 1 }).z;
  if (z >= minZ) return all;
  const c = viewToWorld(cam, { x: free.x + free.w / 2, y: free.y + free.h / 2 });
  const d = (b) => Math.hypot(b.x + b.w / 2 - c.x, b.y + b.h / 2 - c.y);
  return boxes.reduce((best, b) => (d(b) < d(best) ? b : best));
}

/**
 * Arrow-key writes of widget cards: one write in flight per card, and presses that arrive meanwhile send the latest
 * spot next, for that card only (a burst on one card never takes another card's place in line).
 * send(id, at) -> Promise; done(id, answer) after the card's last write; fail(id, err) when one fails.
 */
export class NudgeQueue {
  constructor(send, done = () => {}, fail = () => {}) {
    this.send = send; this.done = done; this.fail = fail;
    this.q = new Map(); // id -> { next, at }
  }
  push(id, at) {
    const s = this.q.get(id);
    // A press queued behind a write replaces the queued spot, keeping what an earlier queued press also changes
    // (a linked video card's first press lets go of its node).
    if (s) { s.next = s.next ? { ...s.next, ...at } : at; s.at = at; return; }
    const t = { next: null, at };
    this.q.set(id, t);
    this.run(id, t, at);
  }
  run(id, s, at) {
    this.send(id, at).then((j) => {
      if (this.q.get(id) !== s) return;
      if (s.next) { const n = s.next; s.next = null; this.run(id, s, n); return; }
      this.q.delete(id);
      this.done(id, j);
    }, (err) => {
      if (this.q.get(id) === s) this.q.delete(id);
      this.fail(id, err);
    });
  }
  /** Where a card stays while its writes are out (the latest spot pressed), or null. */
  held(id) { const s = this.q.get(id); return s ? s.at : null; }
}

/**
 * The click rule: which layer a click selects. `chain` is the ancestry of the deepest layer under the pointer,
 * from its board down ([board, ..., leaf]); `selChains` the same for each selected layer. A click selects the
 * board's direct child (a top-level layer, an instance as a whole); with a selection on the same board it goes one
 * level below the deepest layer the click shares with it: a sibling of the selected layer, or the child of a
 * selected container (so a second click, or a double-click, goes one level in). `deep` (Cmd): the leaf itself.
 */
export function pickTarget(chain, selChains = [], deep = false) {
  if (!Array.isArray(chain) || !chain.length) return null;
  if (deep) return chain[chain.length - 1];
  let common = 0;
  for (const s of selChains) {
    if (!Array.isArray(s)) continue;
    let k = 0;
    while (k < s.length && k < chain.length && s[k] === chain[k]) k++;
    if (k > common) common = k;
  }
  return chain[Math.min(Math.max(1, common), chain.length - 1)];
}

/**
 * What a double-click selects: one level below what the first click leaves selected. `preChains` is the
 * selection before the double-click's first press. The first click keeps a selected container the pointer is
 * in (it does not dive like Canvas's second single click does), else picks by the click rule; the double-click
 * then enters it one level. So a double-click never goes two levels, whatever the first click did.
 */
export function dblClickTarget(chain, preChains = []) {
  if (!Array.isArray(chain) || !chain.length) return null;
  let held = -1;
  for (const s of preChains) {
    if (!Array.isArray(s) || !s.length) continue;
    const at = chain.indexOf(s[s.length - 1]);
    // A selected layer the pointer is inside (not the leaf itself, and not the board): the first click keeps it.
    if (at > 0 && at < chain.length - 1 && s.length === at + 1 && s.every((x, i) => chain[i] === x) && at > held) held = at;
  }
  const first = held > 0 ? chain[held] : pickTarget(chain, preChains, false);
  const k = chain.indexOf(first);
  return chain[Math.min(Math.max(1, k + 1), chain.length - 1)];
}

/**
 * Does a double-click edit the text layer `id` it lands on? Only when that layer was already selected as its second
 * press went down: selected before the double-click, or by its first click (a board's direct child). A
 * double-click whose drill-down is what reached the text (`dblClickTarget` went one level in to it) only selects
 * it; the next double-click on it edits. `selAtSecond`: the selection as the second press went down; null when the
 * page saw no second press (the old behaviour: edit).
 */
export function dblClickEdits(id, selAtSecond) {
  if (!Array.isArray(selAtSecond)) return true;
  return selAtSecond.includes(id);
}

/**
 * A layer's own width and height from its drawn (axis-aligned) box W x H and its rotation in degrees: the size the
 * inspector shows for a turned layer whose size the layout decides (a group, a Hug frame). `knownW` / `knownH`: a
 * side the file fixes. With c = |cos|, s = |sin|: W = w c + h s, H = w s + h c. Near 45 degrees with neither side
 * known the two equations are the same one: null.
 */
export function unrotatedSize(W, H, deg, knownW, knownH) {
  const a = ((Number(deg) || 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  if (s < 1e-9) return { w: knownW ?? W, h: knownH ?? H };
  if (typeof knownW === "number") return { w: knownW, h: c > s ? (H - knownW * s) / c : (W - knownW * c) / s };
  if (typeof knownH === "number") return { w: c > s ? (W - knownH * s) / c : (H - knownH * c) / s, h: knownH };
  const det = c * c - s * s;
  if (Math.abs(det) < 0.05) return null;
  return { w: (W * c - H * s) / det, h: (H * c - W * s) / det };
}
