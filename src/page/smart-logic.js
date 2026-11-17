// Smart selection and Tidy up: the pure part (node-tested in test/smart-logic.test.ts; the page glue is
// /page/smart.js).
//
// A smart selection is layers an equal distance apart that overlap on one axis (1D: a row or a column) or both (2D:
// rows of layers, "lists within lists"). Rects are world rects {id, x, y, w, h}. A model is
// {kind: "1d" | "2d", axis: "x" | "y", lines: [[id, ...], ...], gap, crossGap}: the lines run along `axis` (a row
// runs along x, a column along y; a 2D selection is rows), `gap` is the space between layers in a line, `crossGap`
// the space between lines (2D only).

/**
 * The fewest layers a smart selection takes. The rule (equal distance apart) holds for any two layers side by
 * side, so rings on every pair would crowd the canvas: three or more.
 */
export const MIN_LAYERS = 3;
/** How far apart two gaps may be and still count as equal (world px). */
export const GAP_TOL = 1;

const S = { x: "w", y: "h" };
const other = (a) => (a === "x" ? "y" : "x");
const end = (r, a) => r[a] + r[S[a]];
const mid = (r, a) => r[a] + r[S[a]] / 2;
/** Two rects overlap on axis a (their extents share more than a hair). */
const overlaps = (p, q, a) => Math.min(end(p, a), end(q, a)) - Math.max(p[a], q[a]) > 0.01;
const r2 = (v) => Math.round(v * 100) / 100;

/** Rects as one line along axis a: sorted, no two overlapping on a, each next to the last overlapping on the other axis. */
function lineOf(rects, a) {
  const s = rects.slice().sort((p, q) => p[a] - q[a] || mid(p, other(a)) - mid(q, other(a)));
  const gaps = [];
  for (let i = 1; i < s.length; i++) {
    if (!overlaps(s[i - 1], s[i], other(a))) return null;
    const g = s[i][a] - end(s[i - 1], a);
    if (g < -0.01) return null;
    gaps.push(g);
  }
  return { rects: s, gaps };
}
const equal = (gaps, tol) => gaps.every((g) => Math.abs(g - gaps[0]) <= tol);
const mean = (xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);

/**
 * Rows by their extent on axis a (each row the rects overlapping the row so far on a), in order along a. A rect
 * overlapping none of the row breaks it.
 */
function bands(rects, a) {
  const s = rects.slice().sort((p, q) => p[a] - q[a]);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[a] < last.end - 0.01) { last.items.push(r); last.end = Math.max(last.end, end(r, a)); last.start = Math.min(last.start, r[a]); }
    else out.push({ items: [r], start: r[a], end: end(r, a) });
  }
  return out;
}

/** The smart selection these rects make, or null (not evenly spaced, or fewer than MIN_LAYERS). */
export function detect(rects, tol = GAP_TOL) {
  if (!Array.isArray(rects) || rects.length < MIN_LAYERS || rects.some((r) => !r || !(r.w >= 0) || !(r.h >= 0))) return null;
  for (const a of ["x", "y"]) {
    const l = lineOf(rects, a);
    if (l && equal(l.gaps, tol)) return { kind: "1d", axis: a, lines: [l.rects.map((r) => r.id)], gap: r2(mean(l.gaps)), crossGap: null };
  }
  // 2D: rows (bands along y), each an evenly spaced line along x with the same gap, the rows evenly spaced.
  const rows = bands(rects, "y");
  if (rows.length < 2 || rows.every((b) => b.items.length < 2)) return null;
  const lines = [], gaps = [];
  for (const b of rows) {
    const l = lineOf(b.items, "x");
    if (!l) return null;
    gaps.push(...l.gaps);
    lines.push(l.rects.map((r) => r.id));
  }
  if (!equal(gaps, tol)) return null;
  const cross = [];
  for (let i = 1; i < rows.length; i++) cross.push(rows[i].start - rows[i - 1].end);
  if (cross.some((g) => g < -0.01) || !equal(cross, tol)) return null;
  return { kind: "2d", axis: "x", lines, gap: r2(mean(gaps)), crossGap: r2(mean(cross)) };
}

const byId = (rects) => (rects instanceof Map ? rects : new Map(rects.map((r) => [r.id, r])));

/**
 * Where every layer goes with the lines in `lines` (an order, maybe changed), `gap` between layers and `crossGap`
 * between lines. Each line starts where the selection starts on its axis; the first line stays where it is across,
 * later ones follow it; a layer keeps its offset inside its line across the axis. Returns Map id -> {x, y}.
 */
export function arrange(model, rects, lines = model.lines, gap = model.gap, crossGap = model.crossGap) {
  const R = byId(rects), a = model.axis, c = other(a), out = new Map();
  const all = lines.flat().map((id) => R.get(id)).filter(Boolean);
  if (!all.length) return out;
  const start = Math.min(...all.map((r) => r[a]));
  // Each line's extent across, as the layers sit now (by the lines they sit in now: model.lines).
  const at = new Map();
  for (const l of model.lines) {
    const rs = l.map((id) => R.get(id)).filter(Boolean);
    if (!rs.length) continue;
    const top = Math.min(...rs.map((r) => r[c]));
    for (const id of l) at.set(id, top);
  }
  let cross = null;
  for (const l of lines) {
    const rs = l.map((id) => R.get(id)).filter(Boolean);
    if (!rs.length) continue;
    const top = Math.min(...rs.map((r) => at.get(r.id) ?? r[c]));
    const height = Math.max(...rs.map((r) => r[c] - (at.get(r.id) ?? r[c]) + r[S[c]]));
    if (cross === null) cross = top;
    let p = start;
    for (const r of rs) {
      const off = r[c] - (at.get(r.id) ?? r[c]);
      out.set(r.id, { [a]: r2(p), [c]: r2(cross + off) });
      p += r[S[a]] + gap;
    }
    cross += height + (crossGap ?? 0);
  }
  return out;
}

/** Per-layer moves from rects to positions (only the ones that change): [{id, dx, dy}]. */
export function deltas(rects, pos) {
  const R = byId(rects), out = [];
  for (const [id, p] of pos) {
    const r = R.get(id);
    if (!r) continue;
    const dx = r2(p.x - r.x), dy = r2(p.y - r.y);
    if (dx || dy) out.push({ id, dx, dy });
  }
  return out;
}

/** The line a world point is over: for 2D the row whose band holds it (or the nearest), for 1D the only one. */
export function lineAt(model, rects, p) {
  if (model.lines.length === 1) return 0;
  const R = byId(rects), c = other(model.axis);
  let best = 0, bd = Infinity;
  model.lines.forEach((l, i) => {
    const rs = l.map((id) => R.get(id)).filter(Boolean);
    const t = Math.min(...rs.map((r) => r[c])), b = Math.max(...rs.map((r) => end(r, c)));
    const d = p[c] < t ? t - p[c] : p[c] > b ? p[c] - b : 0;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/**
 * Moving layers `ids` to the slot under world point p: the new lines (they leave their own line and go, in their
 * order, before the first other layer of the target line whose middle is past p) and the slot {line, index}.
 */
export function moveTo(model, rects, ids, p) {
  const R = byId(rects), a = model.axis, set = new Set(ids);
  const li = lineAt(model, rects, p);
  const lines = model.lines.map((l) => l.filter((id) => !set.has(id)));
  const target = lines[li];
  let k = 0;
  while (k < target.length && mid(R.get(target[k]), a) < p[a]) k++;
  const moving = model.lines.flat().filter((id) => set.has(id));
  lines[li] = [...target.slice(0, k), ...moving, ...target.slice(k)];
  return { lines: lines.filter((l) => l.length), slot: { line: li, index: k } };
}

/** Cmd while dragging: layer `id` swaps places with `other`. The new lines, or null when nothing swaps. */
export function swap(model, id, with_) {
  if (!with_ || with_ === id) return null;
  const lines = model.lines.map((l) => l.map((x) => (x === id ? with_ : x === with_ ? id : x)));
  return lines;
}

/** The layer of the model whose rect holds world point p (not one of `skip`), or null. */
export function layerAt(model, rects, p, skip = []) {
  const R = byId(rects);
  for (const id of model.lines.flat()) {
    if (skip.includes(id)) continue;
    const r = R.get(id);
    if (r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return id;
  }
  return null;
}

/**
 * The blue insertion line for slot {line, index} among the line's other layers (world): halfway between the two
 * layers it falls between, as long as the line is deep across.
 */
export function slotLine(model, rects, lines, slot, moving) {
  const R = byId(rects), a = model.axis, c = other(a), set = new Set(moving);
  const l = (lines[slot.line] || []).filter((id) => !set.has(id)).map((id) => R.get(id)).filter(Boolean);
  const all = (model.lines[slot.line] || []).map((id) => R.get(id)).filter(Boolean);
  if (!all.length && !l.length) return null;
  const span = (l.length ? l : all);
  const c0 = Math.min(...span.map((r) => r[c])), c1 = Math.max(...span.map((r) => end(r, c)));
  const g = model.gap;
  let at;
  if (!l.length) at = Math.min(...all.map((r) => r[a]));
  else if (slot.index <= 0) at = l[0][a] - g / 2;
  else if (slot.index >= l.length) at = end(l[l.length - 1], a) + g / 2;
  else at = (end(l[slot.index - 1], a) + l[slot.index][a]) / 2;
  return a === "x" ? { x0: at, y0: c0, x1: at, y1: c1 } : { x0: c0, y0: at, x1: c1, y1: at };
}

/**
 * The spacing handles (world): each gap between neighbours in a line ({kind: "gap", axis, rect}) and, for 2D, each
 * space between lines ({kind: "cross", axis, rect}). `axis` is the one the handle's drag changes.
 */
export function gapAreas(model, rects) {
  const R = byId(rects), a = model.axis, c = other(a), out = [];
  const lines = model.lines.map((l) => l.map((id) => R.get(id)).filter(Boolean));
  for (const rs of lines) {
    for (let i = 1; i < rs.length; i++) {
      const p = rs[i - 1], q = rs[i];
      const c0 = Math.max(p[c], q[c]), c1 = Math.min(end(p, c), end(q, c));
      const g0 = end(p, a), g1 = q[a];
      out.push({ kind: "gap", axis: a, rect: a === "x" ? { x: g0, y: c0, w: g1 - g0, h: c1 - c0 } : { x: c0, y: g0, w: c1 - c0, h: g1 - g0 } });
    }
  }
  if (model.kind === "2d") {
    const all = lines.flat();
    const a0 = Math.min(...all.map((r) => r[a])), a1 = Math.max(...all.map((r) => end(r, a)));
    for (let i = 1; i < lines.length; i++) {
      const b0 = Math.max(...lines[i - 1].map((r) => end(r, c))), b1 = Math.min(...lines[i].map((r) => r[c]));
      out.push({ kind: "cross", axis: c, rect: c === "y" ? { x: a0, y: b0, w: a1 - a0, h: b1 - b0 } : { x: b0, y: a0, w: b1 - b0, h: a1 - a0 } });
    }
  }
  return out;
}

/** A spacing drag's new value: from `start`, the pointer's travel along `axis` (screen px at zoom z) shared by `n` gaps. */
export function dragGap(start, d, z, steps = false, big = 10, pixel = true) {
  let v = start + d / (z > 0 ? z : 1);
  v = steps ? Math.round(v / big) * big : pixel ? Math.round(v) : r2(v);
  return Object.is(v, -0) ? 0 : v;
}

/** The space between fields in the inspector: {x, y} (null where the selection has none). */
export function spacingOf(model) {
  if (!model) return null;
  if (model.kind === "1d") return model.axis === "x" ? { x: model.gap, y: null } : { x: null, y: model.gap };
  return { x: model.gap, y: model.crossGap };
}
/** A value typed in the inspector: the gap and cross gap it sets ({x, y}: null keeps). */
export function gapsFrom(model, v) {
  const s = spacingOf(model);
  const main = model.axis === "x" ? v.x : v.y, cross = model.axis === "x" ? v.y : v.x;
  return { gap: Number.isFinite(main) && s ? main : model.gap, crossGap: model.kind === "2d" && Number.isFinite(cross) ? cross : model.crossGap };
}

/**
 * Cmd+D on marked layers: each copy goes right after its original in its line (a row: to the right, a
 * column or 2D: after it in the list). `copies`: Map original id -> copy id. The new lines.
 */
export function withCopies(model, copies) {
  return model.lines.map((l) => l.flatMap((id) => (copies.has(id) ? [id, copies.get(id)] : [id])));
}
/** Delete on marked layers: the rest close up. The new lines. */
export function without(model, ids) {
  const set = new Set(ids);
  return model.lines.map((l) => l.filter((id) => !set.has(id))).filter((l) => l.length);
}


/**
 * Tidy up: a selection becomes an evenly spaced row, column or grid aligned to its top-left. The spacing is
 * the mean of the gaps it has, rounded (0 when they overlap). Returns {model, pos: Map id -> {x, y}} or null (fewer than two).
 */
export function tidy(rects) {
  if (!Array.isArray(rects) || rects.length < 2) return null;
  const ox = Math.min(...rects.map((r) => r.x)), oy = Math.min(...rects.map((r) => r.y));
  const gapsAlong = (rs, a) => { const s = rs.slice().sort((p, q) => p[a] - q[a]); const g = []; for (let i = 1; i < s.length; i++) g.push(s[i][a] - end(s[i - 1], a)); return g; };
  // One row when every layer shares a band across y, one column when they share one across x.
  const rowBands = bands(rects, "y"), colBands = bands(rects, "x");
  let lines, axis = "x";
  if (rowBands.length === 1) lines = [rowBands[0].items.slice().sort((p, q) => p.x - q.x)];
  else if (colBands.length === 1) { axis = "y"; lines = [colBands[0].items.slice().sort((p, q) => p.y - q.y)]; }
  else lines = rowBands.map((b) => b.items.slice().sort((p, q) => p.x - q.x));
  const gap = Math.max(0, Math.round(mean(lines.flatMap((l) => gapsAlong(l, axis)))));
  const crossGap = lines.length > 1 ? Math.max(0, Math.round(mean(lines.slice(1).map((l, i) => Math.min(...l.map((r) => r.y)) - Math.max(...lines[i].map((r) => end(r, "y"))))))) : null;
  const c = other(axis), out = new Map();
  let cross = axis === "x" ? oy : ox;
  for (const l of lines) {
    let p = axis === "x" ? ox : oy;
    for (const r of l) { out.set(r.id, { [axis]: p, [c]: cross }); p += r[S[axis]] + gap; }
    cross += Math.max(...l.map((r) => r[S[c]])) + (crossGap ?? 0);
  }
  return { model: { kind: lines.length > 1 ? "2d" : "1d", axis, lines: lines.map((l) => l.map((r) => r.id)), gap, crossGap }, pos: out };
}
