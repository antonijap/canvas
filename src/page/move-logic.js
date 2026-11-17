// Moving layers, the pure part (node-tested in test/move-logic.test.ts; the page glue is
// /page/reparent.js and the move in server.ts).
//
// Where a dropped layer belongs: the frame under the pointer adopts it (a drop reparents: onto another board,
// into a nested frame, out onto empty canvas). Groups never adopt by pointer: a layer inside a group stays in it while
// it is dropped inside the frame around that group. Shift locks a drag to its dominant axis.

/** True for a component instance (or a node inside one) in a page scene: its insides are the component's. */
export const isInstanceNode = (n) => !!n && (String(n.id).includes("/") || typeof n.component === "string");

/**
 * The frame a layer belongs to for drops: its nearest frame ancestor (groups skipped), or null when no frame holds
 * it (a board itself, or a layer in a top-level group). `ancestors`: the nodes from the board root down to the
 * layer's parent (autolayout-logic.js ancestorsOf), or [] for a top-level node.
 */
export function homeFrame(ancestors) {
  for (let i = (ancestors || []).length - 1; i >= 0; i--) {
    const n = ancestors[i];
    if (n && n.type === "frame" && !isInstanceNode(n)) return String(n.id);
  }
  return null;
}

/**
 * Where a drop puts a layer: {parent} (a frame id, or null for the canvas, where it becomes a board) when it changes
 * parent, null when it stays. `home`: homeFrame of the layer; `target`: the frame under the pointer ({id}) or null
 * for empty canvas; `parentId`: the layer's parent now (null for a top-level layer: a board, which nests only in a frame).
 */
export function dropParent(home, target, parentId) {
  const to = target ? String(target.id) : null;
  // A board (top-level layer) dropped inside another frame nests there; on empty canvas it stays a board.
  if (parentId === null || parentId === undefined) return to === null ? null : { parent: to };
  if (to === home) return null;
  return { parent: to };
}

/**
 * A multi-selection's drop: a layer changes parent only when it leaves its own frame, and then goes to the
 * frame under its own centre, not the pointer's. items: [{id, rect (world, where it lands), from: {home, parent}}];
 * homeRect(id): a frame's world rect (null: unknown, the layer stays); targetFor(point): {kind: "canvas"} or
 * {kind: "frame", id, ...} at a world point, or null when unknown or not a place to drop into (it stays).
 * Returns [{id, rect, from, target}] for the layers that change parent.
 */
export function multiDrops(items, homeRect, targetFor) {
  const out = [];
  for (const it of items) {
    if (!it.from) continue;
    const c = { x: it.rect.x + it.rect.w / 2, y: it.rect.y + it.rect.h / 2 };
    if (it.from.home) {
      const h = homeRect(it.from.home);
      if (!h || (c.x >= h.x && c.x <= h.x + h.w && c.y >= h.y && c.y <= h.y + h.h)) continue; // still in its frame
    }
    const t = targetFor(c);
    if (!t) continue;
    if (t.kind === "frame" && t.id === it.from.parent) continue;
    if (dropParent(it.from.home, t.kind === "frame" ? { id: t.id } : null, it.from.parent)) out.push({ id: it.id, rect: it.rect, from: it.from, target: t });
  }
  return out;
}

/**
 * A group's own size: its layers' extent from its origin (the engine sizes a group that way), each layer's turn and
 * flips included; groups inside count by their own layers. A size the file does not hold (a text or a frame that
 * sizes itself) comes from `measure(id)`, the layer's drawn box on the canvas (sizeFromBox), with `turn` and
 * `mirrored` the group's own turn on the canvas and whether it is mirrored. Null when a size is not known.
 */
export function groupExtent(children, measure = null, turn = 0, mirrored = false) {
  let w = 0, h = 0;
  for (const n of children || []) {
    if (!n || typeof n !== "object" || n.enabled === false) continue;
    const r = Number(n.rotation) || 0;
    // A mirror turns what is inside it the other way (rotate then flip: R(g) F R(c) = R(g - c) F).
    const nTurn = turn + (mirrored ? -r : r), nMir = mirrored !== ((n.flipX === true) !== (n.flipY === true));
    let nw = n.width, nh = n.height;
    if (n.type === "group") { const e = groupExtent(n.children, measure, nTurn, nMir); if (!e) return null; nw = e.w; nh = e.h; }
    else if (measure) {
      // Text that sizes itself: the file's number on that axis is not what shows.
      const g = n.type === "text" ? n.textGrowth : null;
      if (n.type === "text" && g !== "fixed-width-height") { nh = undefined; if (g !== "fixed-width") nw = undefined; }
      if (typeof nw !== "number" || typeof nh !== "number") {
        const s = sizeFromBox(nw, nh, measure(String(n.id)), nTurn);
        if (!s) return null;
        nw = s.w; nh = s.h;
      }
    }
    if (typeof nw !== "number" || typeof nh !== "number") return null;
    const t = (-r * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const sw = n.flipX === true ? -nw : nw, sh = n.flipY === true ? -nh : nh;
    const x = Number(n.x) || 0, y = Number(n.y) || 0;
    for (const [u, v] of [[0, 0], [sw, 0], [0, sh], [sw, sh]]) { w = Math.max(w, x + c * u - s * v); h = Math.max(h, y + s * u + c * v); }
  }
  return { w: r2(w), h: r2(h) };
}

/**
 * A layer's own size from its drawn box on the canvas (the engine's layout, `box` {w, h}) and its turn there
 * (degrees): the sides the file holds (w, h numbers) stay, the others are solved from the box. Null when the box
 * cannot tell (no box, or both sides unknown at 45 degrees, where every split of w + h draws the same box).
 */
export function sizeFromBox(w, h, box, turn) {
  const kw = typeof w === "number", kh = typeof h === "number";
  if (kw && kh) return { w, h };
  if (!box) return null;
  const t = ((Number(turn) || 0) * Math.PI) / 180, a = Math.abs(Math.cos(t)), b = Math.abs(Math.sin(t));
  // box.w = a w + b h, box.h = b w + a h; solve on the better conditioned axis.
  if (kw) h = a >= b ? (box.h - b * w) / a : (box.w - a * w) / b;
  else if (kh) w = a >= b ? (box.w - b * h) / a : (box.h - a * h) / b;
  else {
    const det = a * a - b * b;
    if (Math.abs(det) < 0.02) return null;
    w = (a * box.w - b * box.h) / det; h = (a * box.h - b * box.w) / det;
  }
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < -0.5 || h < -0.5) return null;
  return { w: r2(Math.max(0, w)), h: r2(Math.max(0, h)) };
}

const lastGroupSize = new Map();
/**
 * A group's own (untransformed) size, for rotating it and drawing its turned box: its layers' extent with sizes the
 * file leaves to layout read from the drawn boxes (`rectOf(id)`: world rect or null), else its own drawn box solved
 * for its turn, else the size last worked out for it while that still draws the box it has now (at 45 degrees a
 * box does not tell w from h). root: the board's scene root. Null when none of these knows.
 */
export function turnedGroupSize(root, id, rectOf) {
  let chain = null;
  const visit = (n, path) => {
    if (chain || !n || typeof n !== "object") return;
    const p = path.concat([n]);
    if (String(n.id) === id) { chain = p; return; }
    for (const c of Array.isArray(n.children) ? n.children : []) visit(c, p);
  };
  visit(root, []);
  if (!chain) return null;
  let turn = 0, mir = false;
  for (const n of chain) {
    const r = Number(n.rotation) || 0;
    turn += mir ? -r : r;
    mir = mir !== ((n.flipX === true) !== (n.flipY === true));
  }
  const g = chain[chain.length - 1];
  const box = rectOf(id);
  let e = groupExtent(g.children, rectOf, turn, mir) || sizeFromBox(undefined, undefined, box, turn);
  if (!e) {
    const last = lastGroupSize.get(id);
    const t = (turn * Math.PI) / 180, a = Math.abs(Math.cos(t)), b = Math.abs(Math.sin(t));
    if (last && box && Math.abs(a * last.w + b * last.h - box.w) < 0.5 && Math.abs(b * last.w + a * last.h - box.h) < 0.5) e = last;
  }
  if (e) lastGroupSize.set(id, e);
  return e;
}

/**
 * Whether a group or multi-selection resize must keep its ratio: a layer turned at an angle that is not a quarter
 * turn cannot stretch along the canvas's axes and stay a rectangle (a layer has no skew), so the
 * whole selection scales uniformly and every layer still fills exactly the box the drag draws.
 */
export function needsUniformScale(items) {
  return (items || []).some((it) => { const q = (((Number(it.rot) || 0) % 90) + 90) % 90; return q > 1e-6 && q < 90 - 1e-6; });
}

/**
 * The one POST /api/layout body for a drop of layers into one or more parents (a multi-selection's per-layer drops):
 * parts [{parent, ids, absolute}], all applied in one server write and one undo step. The top-level ids, parent and
 * absolute are the first part's (and every id), for older servers and the logs.
 */
export function placeBody(file, page, parts, opts = {}) {
  const ps = parts.map((p) => ({ parent: p.parent, ids: p.ids, before: null, absolute: p.absolute }));
  const body = { file, page: page || undefined, op: "place", ids: ps.flatMap((p) => p.ids), parent: ps[0].parent, before: null, absolute: ps[0].absolute, rects: opts.rects || {} };
  if (ps.length > 1) body.parts = ps;
  if (opts.copy) body.copy = true;
  if (opts.merge) body.merge = opts.merge;
  return body;
}

/** Shift held while dragging: the move keeps only its dominant axis. dx, dy: the drag so far. */
export function axisLock(dx, dy) {
  return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy };
}

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * groupResizeItems for a turned layer (it.rot degrees, own size it.w0 x it.h0, drawn box it.wr): its centre moves
 * with the box; each of its own axes scales by how much the box stretches along it (exact for a uniform scale and
 * for quarter turns). A box crossed on one axis mirrors it: the flip toggles and the turn goes the other way.
 */
function turnedScale(it, r0, r, sx, sy) {
  const w = it.wr, rot = it.rot;
  const t = (rot * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  const nw = Math.max(0.01, it.w0 * Math.hypot(c * sx, s * sy)), nh = Math.max(0.01, it.h0 * Math.hypot(s * sx, c * sy));
  const cx0 = w.x + w.w / 2, cy0 = w.y + w.h / 2;
  const cx1 = r.flipX ? r.x + (r0.x + r0.w - cx0) * sx : r.x + (cx0 - r0.x) * sx;
  const cy1 = r.flipY ? r.y + (r0.y + r0.h - cy0) * sy : r.y + (cy0 - r0.y) * sy;
  const fx0 = !!it.flipX, fy0 = !!it.flipY, fx1 = r.flipX ? !fx0 : fx0, fy1 = r.flipY ? !fy0 : fy0;
  const rot1 = !!r.flipX !== !!r.flipY ? -rot : rot;
  // The stored corner sits off the centre by the turned half-diagonal (a flipped side counts negative).
  const off0 = centreOffset(fx0 ? -it.w0 : it.w0, fy0 ? -it.h0 : it.h0, rot), off1 = centreOffset(fx1 ? -nw : nw, fy1 ? -nh : nh, rot1);
  const own0 = { x: cx0 - off0.x, y: cy0 - off0.y }; // where the corner is drawn now (world)
  const props = { x: r2(it.own.x + (cx1 - off1.x) - own0.x), y: r2(it.own.y + (cy1 - off1.y) - own0.y), width: r2(nw), height: r2(nh) };
  if (rot1 !== rot) props.rotation = r2(rot1);
  if (it.type === "text") props.textGrowth = "fixed-width-height";
  if (fx1 !== fx0) props.flipX = fx1;
  if (fy1 !== fy0) props.flipY = fy1;
  return props;
}

/**
 * A group or multi-selection resized from box r0 to box r (world rects; r.flipX / r.flipY when an edge was dragged
 * past the opposite one): each item's box scales with it, each axis on its own. items: [{id, wr (world
 * rect), own ({x, y}, its stored position), type, flipX, flipY}]. Returns [{it, props}] with the new x, y, width and
 * height (text boxes become fixed size; a crossed box mirrors the layers and toggles their flip).
 */
export function groupResizeItems(items, r0, r) {
  const sx = r0.w > 0 ? r.w / r0.w : 1, sy = r0.h > 0 ? r.h / r0.h : 1;
  return items.map((it) => {
    const w = it.wr;
    if (it.rot) return { it, props: turnedScale(it, r0, r, sx, sy) };
    const fromL = r.flipX ? r0.x + r0.w - (w.x + w.w) : w.x - r0.x;
    const fromT = r.flipY ? r0.y + r0.h - (w.y + w.h) : w.y - r0.y;
    const nx = r.x + fromL * sx, ny = r.y + fromT * sy, nw = Math.max(0.01, w.w * sx), nh = Math.max(0.01, w.h * sy);
    // A flip mirrors about the layer's top-left corner: a flipped layer's stored x is its right edge (y: bottom).
    const fx0 = !!it.flipX, fy0 = !!it.flipY, fx1 = r.flipX ? !fx0 : fx0, fy1 = r.flipY ? !fy0 : fy0;
    const props = { x: r2(it.own.x + nx - w.x + (fx1 ? nw : 0) - (fx0 ? w.w : 0)), y: r2(it.own.y + ny - w.y + (fy1 ? nh : 0) - (fy0 ? w.h : 0)), width: r2(nw), height: r2(nh) };
    if (it.type === "text") props.textGrowth = "fixed-width-height";
    if (fx1 !== fx0) props.flipX = fx1;
    if (fy1 !== fy0) props.flipY = fy1;
    return { it, props };
  });
}

// ---------- rotation (QA P3-9) ----------
// A rotation is degrees counterclockwise about the layer's top-left corner (engine/src/layout.rs:
// rotate(-r) with transform-origin 0 0). A layer rotates about the centre, so a rotation also moves x/y.

/** How far outside a selection's corner the rotate zone reaches (view px). */
export const ROTATE_ZONE_PX = 18;
/** The corner whose rotate zone holds a screen point ("nw", "ne", "sw", "se"), or null. s: the box on screen. Points
 * inside the box or on a resize handle (`onHandle`) are not in it. */
export function rotateZoneAt(s, px, py, onHandle) {
  if (!s || onHandle) return null;
  if (px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h) return null;
  const corners = { nw: [s.x, s.y], ne: [s.x + s.w, s.y], sw: [s.x, s.y + s.h], se: [s.x + s.w, s.y + s.h] };
  for (const [k, [cx, cy]] of Object.entries(corners)) if (Math.abs(px - cx) <= ROTATE_ZONE_PX && Math.abs(py - cy) <= ROTATE_ZONE_PX) return k;
  return null;
}
/** A layer's centre offset from its stored x/y, for size w x h at rotation r (degrees, counterclockwise). */
export function centreOffset(w, h, r) {
  const t = (-r * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return { x: c * (w / 2) - s * (h / 2), y: s * (w / 2) + c * (h / 2) };
}
/**
 * The stored x/y that keeps the layer's centre where it is when its rotation goes from r0 to r1. A flip mirrors the
 * layer about its stored corner (engine/src/layout.rs: rotate, then scale -1), so a flipped side counts negative.
 */
export function rotatedPosition(own, w, h, r0, r1, flipX = false, flipY = false) {
  const sw = flipX ? -w : w, sh = flipY ? -h : h;
  const a = centreOffset(sw, sh, r0), b = centreOffset(sw, sh, r1);
  return { x: r2(own.x + a.x - b.x), y: r2(own.y + a.y - b.y) };
}
/**
 * The rotation origin (Option+R): a point turned about `pivot` by dr degrees (counterclockwise on screen, y down,
 * the way a rotation grows).
 */
export function turnAbout(p, pivot, dr) {
  const t = (dr * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), x = p.x - pivot.x, y = p.y - pivot.y;
  return { x: pivot.x + c * x + s * y, y: pivot.y - s * x + c * y };
}
/**
 * The stored x/y of a layer turned from r0 to r1 about `pivot` instead of its centre: it turns in place
 * (rotatedPosition), then its centre (world `centre`, with the parent unturned) goes round the pivot.
 */
export function pivotedPosition(own, w, h, r0, r1, centre, pivot, flipX = false, flipY = false) {
  const p = rotatedPosition(own, w, h, r0, r1, flipX, flipY);
  if (!pivot || !centre) return p;
  const c1 = turnAbout(centre, pivot, r1 - r0);
  return { x: r2(p.x + c1.x - centre.x), y: r2(p.y + c1.y - centre.y) };
}
/**
 * Where a layer's stored x/y (its transformed top-left corner) is, given the world box it shows in (the bounds of
 * the rotated, flipped layer), its size w x h, rotation r (degrees, counterclockwise) and flips. A size the file does
 * not hold (null: fit content) is worked out from the box. With no rotation or flip it is the box's corner.
 */
export function originOfBox(box, w, h, r, flipX = false, flipY = false) {
  r = Number(r) || 0;
  if (!r && !flipX && !flipY) return { x: box.x, y: box.y };
  const t = (-r * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  if (typeof w !== "number" || typeof h !== "number") {
    // box.w = |c| w + |s| h, box.h = |s| w + |c| h; at 45 degrees it has no single answer: keep the box's ratio.
    const ac = Math.abs(c), as = Math.abs(s), det = ac * ac - as * as;
    if (Math.abs(det) > 1e-6) { w = (ac * box.w - as * box.h) / det; h = (ac * box.h - as * box.w) / det; }
    else { const k = (ac + as) || 1; w = box.w / k; h = box.h / k; }
    w = Math.max(0, w); h = Math.max(0, h);
  }
  const sw = flipX ? -w : w, sh = flipY ? -h : h;
  let mx = 0, my = 0;
  for (const [u, v] of [[sw, 0], [0, sh], [sw, sh]]) { mx = Math.min(mx, c * u - s * v); my = Math.min(my, s * u + c * v); }
  return { x: box.x - mx, y: box.y - my };
}
/**
 * The rotation a drag gives: from r0 (degrees) by the pointer's turn about the centre (screen angles a0 -> a1 in
 * radians, y down, so clockwise is positive). Shift snaps to 15 degrees. Result in (-180, 180].
 */
export function dragRotation(r0, a0, a1, shift) {
  let r = r0 - ((a1 - a0) * 180) / Math.PI;
  if (shift) r = Math.round(r / 15) * 15;
  r = ((((r + 180) % 360) + 360) % 360) - 180;
  if (r === -180) r = 180;
  return Math.round(r * 100) / 100;
}

// ---------- resizing a rotated layer (QA round 2 #7) ----------
// A rotated layer's box and handles turn with it, and a handle resizes along the layer's own axes. The page
// works in the layer's frame: a box centred on 0,0 of the layer's own size, the pointer turned into it.

/** Turn vector (x, y) by `deg` degrees the way a rotation of -deg would (y down; rotate(v, -r) is the layer's turn). */
export function rotateVec(x, y, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return { x: c * x - s * y, y: s * x + c * y };
}
/**
 * A rotated layer resized in its own frame: `rect` is the new box (resizeRect of {x: -w0/2, y: -h0/2, w: w0, h: h0},
 * the layer's box about its centre). Returns the stored {x, y, width, height}: the new size, and x/y moved so the
 * sides the drag did not touch stay where they were on the canvas. own: the stored x/y; r: rotation (degrees);
 * flips as stored.
 */
export function rotatedResize(own, w0, h0, r, rect, flipX = false, flipY = false) {
  const c = rotateVec(rect.x + rect.w / 2, rect.y + rect.h / 2, -r); // the centre's move on the canvas
  const off0 = centreOffset(flipX ? -w0 : w0, flipY ? -h0 : h0, r), off1 = centreOffset(flipX ? -rect.w : rect.w, flipY ? -rect.h : rect.h, r);
  return { x: r2(own.x + c.x + off0.x - off1.x), y: r2(own.y + c.y + off0.y - off1.y), width: r2(rect.w), height: r2(rect.h) };
}
/** The resize cursor for handle `h` of a layer turned by r degrees: the one closest to the handle's direction on screen. */
export function rotatedCursor(h, r) {
  const dir = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] }[h];
  if (!dir) return null;
  const v = rotateVec(dir[0], dir[1], -r);
  let a = (Math.atan2(v.y, v.x) * 180) / Math.PI; // screen angle, y down
  a = ((a % 180) + 180) % 180; // a line: 0 and 180 are the same cursor
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}
