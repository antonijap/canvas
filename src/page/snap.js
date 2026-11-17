// Snapping and smart guides for moving boards, layers and widgets. Pure: no DOM, no globals, so the page
// imports it as a module and node tests import the same file.
//
// A drag builds one SnapIndex from the rects it may snap to (the ones near the view), then asks snapRect for
// every pointer move. The index keeps each axis's lines (left, centre, right / top, middle, bottom) sorted, so
// a query is six binary searches plus a walk over the lines that coincide: well under a millisecond for
// thousands of rects. The threshold is in screen pixels, so snapping feels the same at every zoom.

export const SNAP_PX = 6;
export const DEFAULT_SNAP = { objects: true, pixel: true, guides: true, bigNudge: 10 };

/** Settings from storage or the shell, with defaults for anything missing or malformed. */
export function snapSettings(v) {
  const o = v && typeof v === "object" ? v : {};
  const big = Number(o.bigNudge);
  return {
    objects: typeof o.objects === "boolean" ? o.objects : DEFAULT_SNAP.objects,
    pixel: typeof o.pixel === "boolean" ? o.pixel : DEFAULT_SNAP.pixel,
    guides: typeof o.guides === "boolean" ? o.guides : DEFAULT_SNAP.guides,
    bigNudge: Number.isFinite(big) && big >= 1 && big <= 1000 ? Math.round(big) : DEFAULT_SNAP.bigNudge,
  };
}

/**
 * Object snapping is off for this drag: Control (hold it to turn off snapping to geometry
 * and objects for now) or Cmd (Canvas's key before; it means nothing else on a move). Pixel rounding stays.
 */
export const bypassSnap = (e) => !!(e && (e.ctrlKey || e.metaKey));

/** The sorted lines of one axis. kind: 0 start edge, 1 centre, 2 end edge. */
function axisLines(rects, pos, size) {
  const n = rects.length * 3;
  const order = new Array(n);
  const val = new Float64Array(n);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i], a = r[pos], s = r[size];
    val[i * 3] = a; val[i * 3 + 1] = a + s / 2; val[i * 3 + 2] = a + s;
  }
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((p, q) => val[p] - val[q]);
  const v = new Float64Array(n), ri = new Int32Array(n), kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const k = order[i]; v[i] = val[k]; ri[i] = (k / 3) | 0; kind[i] = k % 3; }
  return { v, ri, kind };
}

/**
 * Index the rects a moving thing may snap to. `rects`: [{x, y, w, h, id?}] in world units. Rects with no area
 * or non-finite numbers are left out.
 */
export function snapIndex(rects) {
  const ok = rects.filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w >= 0 && r.h >= 0);
  return { rects: ok, x: axisLines(ok, "x", "w"), y: axisLines(ok, "y", "h") };
}

/** The index of the first line >= v (binary search). */
function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/** The line closest to v within tol, or -1. */
export function nearestLine(arr, v, tol) {
  const i = lowerBound(arr, v);
  let best = -1, bd = tol;
  for (const j of [i - 1, i]) if (j >= 0 && j < arr.length) { const d = Math.abs(arr[j] - v); if (d <= bd) { bd = d; best = j; } }
  return best;
}

/** The smallest move along one axis that lands one of the rect's three lines on an indexed line, or null. */
function bestOffset(ax, a, s, tol) {
  let best = null;
  const mine = [a, a + s / 2, a + s];
  for (let k = 0; k < 3; k++) {
    const j = nearestLine(ax.v, mine[k], tol);
    if (j < 0) continue;
    const d = ax.v[j] - mine[k];
    // Ties go to edges over centres: aligning edges is what people mean far more often.
    if (!best || Math.abs(d) < Math.abs(best.d) - 1e-9 || (Math.abs(d - best.d) < 1e-9 && k !== 1 && best.k === 1)) best = { d, k };
  }
  return best;
}

const EPS = 0.5; // world px: lines this close after rounding count as aligned

/**
 * Where a rect moved to `r` should land. Returns {x, y, guides}: x/y the snapped top-left; guides what to draw
 * (empty when nothing aligns or guides are off).
 * o: { z (zoom), objects (snap to the index), pixel (round to whole world px), guides, threshold (screen px) }.
 */
export function snapRect(index, r, o = {}) {
  const z = o.z > 0 ? o.z : 1;
  const tol = (o.threshold ?? SNAP_PX) / z;
  let x = r.x, y = r.y;
  if (o.objects !== false && index && index.rects.length) {
    const bx = bestOffset(index.x, r.x, r.w, tol), by = bestOffset(index.y, r.y, r.h, tol);
    if (bx) x += bx.d;
    if (by) y += by.d;
  }
  if (o.pixel !== false) { x = Math.round(x); y = Math.round(y); }
  const out = { x, y, guides: [] };
  if (o.objects !== false && o.guides !== false && index && index.rects.length) out.guides = guidesFor(index, { x, y, w: r.w, h: r.h });
  return out;
}

/**
 * The smart guides for a rect at rest: one per line of it that coincides with indexed lines. Each guide is
 * {axis: "x" | "y", v, from, to, marks: [along], gaps: [{from, to, d}]}: axis "x" is a vertical line at x = v
 * running from y = from to y = to; gaps are the distances to the nearest aligned rect on each side.
 */
export function guidesFor(index, r) {
  const guides = [];
  for (const axis of ["x", "y"]) {
    const ax = index[axis];
    const pos = axis === "x" ? "x" : "y", size = axis === "x" ? "w" : "h";
    const cross = axis === "x" ? "y" : "x", csize = axis === "x" ? "h" : "w";
    const a = r[pos], s = r[size];
    const seen = new Set();
    for (const v of [a, a + s / 2, a + s]) {
      let i = lowerBound(ax.v, v - EPS);
      const hits = [];
      for (; i < ax.v.length && ax.v[i] <= v + EPS; i++) hits.push(ax.ri[i]);
      if (!hits.length) continue;
      const key = Math.round(v * 2);
      if (seen.has(key)) continue;
      seen.add(key);
      const c0 = r[cross], c1 = r[cross] + r[csize];
      let from = c0, to = c1, above = null, below = null;
      const marks = [c0, c1];
      for (const h of new Set(hits)) {
        const o = index.rects[h], o0 = o[cross], o1 = o[cross] + o[csize];
        from = Math.min(from, o0); to = Math.max(to, o1);
        marks.push(o0, o1);
        if (o1 <= c0) { const d = c0 - o1; if (!above || d < above.d) above = { from: o1, to: c0, d }; }
        else if (o0 >= c1) { const d = o0 - c1; if (!below || d < below.d) below = { from: c1, to: o0, d }; }
      }
      guides.push({ axis, v, from, to, marks, gaps: [above, below].filter((g) => g && g.d > 0) });
    }
  }
  return guides;
}

/** Rects worth snapping to: the ones that touch the view grown by `margin` of its size, minus `skip` ids. */
export function nearbyRects(rects, cam, viewW, viewH, margin = 0.5, skip) {
  const mx = viewW * margin, my = viewH * margin;
  const L = (-mx - cam.x) / cam.z, T = (-my - cam.y) / cam.z, R = (viewW + mx - cam.x) / cam.z, B = (viewH + my - cam.y) / cam.z;
  return rects.filter((r) => r && !(skip && skip.has(r.id)) && r.x < R && r.x + r.w > L && r.y < B && r.y + r.h > T);
}

/** Number shown on a distance label: whole px, else one decimal. */
export const fmtGap = (d) => (Math.abs(d - Math.round(d)) < 0.05 ? String(Math.round(d)) : d.toFixed(1));

/**
 * Draw guides on a 2D context sized to the view in device pixels. Lines are one device pixel wide (two on
 * 2x screens) and land on whole device pixels, so they are crisp at any zoom; labels are screen-sized pills.
 */
export function drawGuides(ctx, guides, cam, dpr, color, font, avoid) {
  const lw = Math.max(1, Math.round(dpr)), off = lw % 2 ? 0.5 : 0;
  const px = (v) => Math.round(v * dpr) + off;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  const m = 2.5 * dpr; // half the size of the little × at each snapped point
  for (const g of guides) {
    if (g.axis === "x") {
      const sx = px(g.v * cam.z + cam.x);
      ctx.moveTo(sx, px(g.from * cam.z + cam.y)); ctx.lineTo(sx, px(g.to * cam.z + cam.y));
      for (const t of g.marks) { const sy = px(t * cam.z + cam.y); ctx.moveTo(sx - m, sy - m); ctx.lineTo(sx + m, sy + m); ctx.moveTo(sx + m, sy - m); ctx.lineTo(sx - m, sy + m); }
    } else {
      const sy = px(g.v * cam.z + cam.y);
      ctx.moveTo(px(g.from * cam.z + cam.x), sy); ctx.lineTo(px(g.to * cam.z + cam.x), sy);
      for (const t of g.marks) { const sx = px(t * cam.z + cam.x); ctx.moveTo(sx - m, sy - m); ctx.lineTo(sx + m, sy + m); ctx.moveTo(sx + m, sy - m); ctx.lineTo(sx - m, sy + m); }
    }
  }
  ctx.stroke();
  ctx.font = font || 11 * dpr + "px -apple-system, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const ph = 16 * dpr, pad = 4 * dpr, r = 3 * dpr;
  for (const g of guides) {
    for (const gap of g.gaps) {
      const mid = (gap.from + gap.to) / 2, text = fmtGap(gap.d), w = ctx.measureText(text).width + pad * 2;
      const cx = g.axis === "x" ? Math.round((g.v * cam.z + cam.x) * dpr) : Math.round((mid * cam.z + cam.x) * dpr);
      const cy = g.axis === "x" ? Math.round((mid * cam.z + cam.y) * dpr) : Math.round((g.v * cam.z + cam.y) * dpr);
      // The pill sits beside a vertical guide and under a horizontal one, so it never hides the line; it moves to
      // the other side, or past them, when that spot would cover a label of the page's (the size badge).
      const { x: bx, y: by } = pillSpot(g.axis, cx, cy, w, ph, dpr, avoid);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(Math.round(bx), Math.round(by), Math.round(w), ph, r);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(text, Math.round(bx + w / 2), Math.round(by + ph / 2) + 0.5);
    }
  }
  ctx.restore();
}

/**
 * Where a distance pill goes (device px): beside a vertical guide, under a horizontal one; when that covers one of
 * `avoid` (view CSS px rects, like the selection's size badge) the other side, then clear of them. Exported for tests.
 */
export function pillSpot(axis, cx, cy, w, ph, dpr, avoid) {
  const g = 4 * dpr;
  const first = axis === "x" ? { x: cx + g, y: cy - ph / 2 } : { x: cx - w / 2, y: cy + g };
  const rects = (avoid || []).filter(Boolean).map((a) => ({ x: a.x * dpr, y: a.y * dpr, w: a.w * dpr, h: a.h * dpr }));
  if (!rects.length) return first;
  const hits = (p) => rects.some((a) => p.x < a.x + a.w && a.x < p.x + w && p.y < a.y + a.h && a.y < p.y + ph);
  const tries = [first, axis === "x" ? { x: cx - g - w, y: cy - ph / 2 } : { x: cx - w / 2, y: cy - g - ph }];
  for (const a of rects) tries.push({ x: first.x, y: a.y + a.h + g }, { x: first.x, y: a.y - g - ph });
  return tries.find((p) => !hits(p)) || first;
}

/**
 * Arrow-key nudges: the move for a key, or null for any other key. Shift moves `big` px.
 */
export function nudgeDelta(key, shift, big = DEFAULT_SNAP.bigNudge) {
  const s = shift ? big : 1;
  if (key === "ArrowLeft") return { dx: -s, dy: 0 };
  if (key === "ArrowRight") return { dx: s, dy: 0 };
  if (key === "ArrowUp") return { dx: 0, dy: -s };
  if (key === "ArrowDown") return { dx: 0, dy: s };
  return null;
}
