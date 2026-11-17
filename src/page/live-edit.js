// Live edits, the pure half: patch a board's resolved scene (GET /api/scene) so an edit is drawn in the next
// frame, keep those patches until the server has the edit, and the resize math behind the selection handles.
// No DOM, no globals: the page (src/page/live.js) imports it, and node tests import the same file.
//
// How an edit stays on screen until the file has it: every edit becomes an override per node property, tagged
// with the write that carries it (op; 0 = a preview no write carries yet). The page draws the server's last
// scene with the overrides on top. A scene that comes from the server later is "rebased": overrides go on top of
// it again, except the ones whose write was acknowledged before that scene was requested (the server finished
// the write before it answered, so a scene asked for after the answer has it). Equal values never count as an
// acknowledgement: an old scene can match by chance. Overrides whose write never answers give up after HOLD_MS.

import { nearestLine, guidesFor } from "./snap.js";

/** A preview no write followed (a drag abandoned without a commit) is dropped after this. */
export const PREVIEW_MS = 2000;
/** A write that never answered: its override gives up and the server's scene shows. */
export const HOLD_MS = 10000;
/** An acknowledged override is dropped by the next scene; this is the backstop. */
export const ACK_MS = 3000;

// Properties a scene cannot take from the page: they need the server (fonts, icons, component expansion,
// images, themes, nodes the scene leaves out). An edit that touches one goes the usual way: write, then redraw.
const SERVER_ONLY = new Set(["id", "type", "ref", "descendants", "children", "content", "fontFamily", "fontWeight", "fontStyle", "icon", "library", "iconFontName", "iconFontFamily", "weight", "theme", "enabled", "reusable", "slot", "url", "href", "geometry", "metadata", "context", "placeholder"]);
// Keys the scene drops (src/scene.ts DROP) and that change nothing drawn.
const INERT = new Set(["metadata", "context", "reusable", "slot", "href", "placeholder", "name"]);

/** The default theme: the first value of every axis (engine resolve.ts defaultTheme). */
export function defaultTheme(themes) {
  const t = {};
  for (const [axis, values] of Object.entries(themes || {})) if (Array.isArray(values) && values[0]) t[axis] = values[0];
  return t;
}

/** A $variable's value for a theme (engine resolve.ts resolveVariable), or undefined. */
export function resolveVariable(vars, name, theme, seen = new Set()) {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const def = vars && vars[name];
  if (!def || typeof def !== "object") return undefined;
  let value = def.value;
  if (Array.isArray(value)) {
    let picked;
    for (const e of value) if (e && (!e.theme || Object.entries(e.theme).every(([a, v]) => theme[a] === v))) picked = e.value;
    value = picked !== undefined ? picked : value[0] && value[0].value;
  }
  if (typeof value === "string" && value.startsWith("$")) return resolveVariable(vars, value.slice(1), theme, seen);
  return value;
}

/** A value with its $variables resolved; ok false when one is unknown or the value holds an image (the server rewrites its URL). */
export function resolveValue(v, vars, theme) {
  let ok = true;
  const walk = (x) => {
    if (typeof x === "string" && x.startsWith("$") && x.length > 1) {
      const r = resolveVariable(vars, x.slice(1), theme);
      if (r === undefined) ok = false;
      return r;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      if (x.type === "image") ok = false;
      const o = {};
      for (const [k, y] of Object.entries(x)) o[k] = walk(y);
      return o;
    }
    return x;
  };
  const out = walk(v);
  return { ok, v: out };
}

/**
 * Turn an inspector edit into what the scene can take. ctx: { vars, themes, board (the edit is the board's root) }.
 * Returns { ok, props, remove, pos } with values resolved; ok false when any part needs the server. `pos` is a
 * board's new {x, y} (drawn by moving the board, not by a new scene).
 */
/** Every theme the document can show (each combination of its axes' values), or null when there are too many. */
export function allThemes(themes) {
  let out = [{}];
  for (const [axis, values] of Object.entries(themes || {})) {
    if (!Array.isArray(values) || !values.length) continue;
    out = out.flatMap((t) => values.map((v) => ({ ...t, [axis]: v })));
    if (out.length > 32) return null;
  }
  return out;
}
const hasToken = (v) => (typeof v === "string" ? v.startsWith("$") && v.length > 1 : Array.isArray(v) ? v.some(hasToken) : !!v && typeof v === "object" && Object.values(v).some(hasToken));

export function prepareEdit(props, remove, ctx = {}) {
  const theme = defaultTheme(ctx.themes);
  // The page does not know which theme a node shows (a board or frame can set its own): a token is drawn now only
  // when it has the same value in every theme; otherwise the server, which knows, draws it.
  let every;
  const out = { ok: true, props: {}, remove: [], pos: null };
  for (const [k, v] of Object.entries(props || {})) {
    if (INERT.has(k)) continue;
    if (SERVER_ONLY.has(k)) return { ok: false };
    if (ctx.board && (k === "x" || k === "y")) {
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false };
      out.pos = Object.assign(out.pos || {}, { [k]: v });
      continue;
    }
    const r = resolveValue(v, ctx.vars, theme);
    if (!r.ok || r.v === undefined || r.v === null) return { ok: false };
    if (hasToken(v)) {
      every ??= allThemes(ctx.themes);
      if (!every) return { ok: false };
      const want = JSON.stringify(r.v);
      if (every.some((t) => JSON.stringify(resolveValue(v, ctx.vars, t).v) !== want)) return { ok: false };
    }
    out.props[k] = r.v;
  }
  for (const k of remove || []) {
    if (INERT.has(k)) continue;
    // A removed property can bring back what a component gives the node, which the page cannot see.
    if (SERVER_ONLY.has(k) || ctx.instance) return { ok: false };
    if (ctx.board && (k === "x" || k === "y")) return { ok: false };
    out.remove.push(k);
  }
  return out;
}

/** The node with this id in a scene tree, or null. */
export function findNode(root, id) {
  if (!root || typeof root !== "object") return null;
  if (String(root.id) === id) return root;
  for (const c of Array.isArray(root.children) ? root.children : []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

/** True when a node is a component instance as the scene shows it: its children carry path ids under it. */
export const isInstance = (n) => !!n && Array.isArray(n.children) && n.children.some((c) => c && typeof c.id === "string" && c.id.startsWith(n.id + "/"));

/** Deep equality for JSON values. */
export function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

/** The page numbers its own writes from here; the shell numbers its writes from 1. */
export const PAGE_OPS = 1e9;
/**
 * Does the answer to write `op` settle an override carried by write `e`? Every earlier write of the same numbering
 * (writes of one source answer in order), never one of the other: a page resize answering must not settle an
 * inspector write still in flight on the same node (or the next scene drops its override and shows the old value).
 */
export const covers = (op, e) => !!e && e <= op && (e >= PAGE_OPS) === (op >= PAGE_OPS);

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** The override key that holds a parent's child order (auto layout reorder and moves, src/page/autolayout.js). */
export const ORDER = "\u0000order";

/**
 * Give parents a new child order in a scene tree. orders: [[parentId, entries]], entries the parent's complete
 * new list: a child id (taken from wherever it is in the tree, so a layer can move between parents) or
 * {id, node} (a node from elsewhere, another board's scene: used when its id is not in this tree). Children not
 * listed leave that parent. Ids that are nowhere are skipped. True when that changed the tree.
 */
export function applyOrder(root, orders) {
  if (!root || !orders || !orders.length) return false;
  const where = new Map(); // id -> {node, parent}
  const visit = (n, parent) => {
    if (!n || typeof n !== "object") return;
    const k = String(n.id);
    if (!where.has(k)) where.set(k, { node: n, parent });
    for (const c of Array.isArray(n.children) ? n.children : []) visit(c, n);
  };
  visit(root, null);
  let changed = false;
  for (const [pid, entries] of orders) {
    const p = where.get(String(pid));
    if (!p || !Array.isArray(entries)) continue;
    const parent = p.node;
    const before = (Array.isArray(parent.children) ? parent.children : []).map((c) => c && c.id);
    const next = [];
    for (const e of entries) {
      const id = typeof e === "string" ? e : e && e.id;
      if (typeof id !== "string") continue;
      const w = where.get(id);
      let node;
      if (w) {
        node = w.node;
        if (w.parent && w.parent !== parent && Array.isArray(w.parent.children)) {
          const i = w.parent.children.indexOf(node);
          if (i >= 0) { w.parent.children.splice(i, 1); changed = true; }
        }
        w.parent = parent;
      } else if (e && typeof e === "object" && e.node) {
        node = clone(e.node);
        where.set(id, { node, parent });
      } else continue;
      if (!next.includes(node)) next.push(node);
    }
    parent.children = next;
    if (before.length !== next.length || before.some((id, i) => id !== next[i].id)) changed = true;
  }
  return changed;
}

/** The overrides of the boards being edited, and when each may let go. */
export class LiveEdits {
  constructor(o = {}) {
    this.now = o.now || (() => Date.now());
    this.boards = new Map(); // board id -> Map(node id -> Map(key -> {v, del, op, ack, t}))
  }
  /** An edit of node `id` on `board`: props resolved (prepareEdit), keys removed, the write that carries it (0: none yet). */
  set(board, id, props, remove, op = 0) {
    let b = this.boards.get(board);
    if (!b) this.boards.set(board, (b = new Map()));
    let n = b.get(id);
    if (!n) b.set(id, (n = new Map()));
    const t = this.now();
    for (const [k, v] of Object.entries(props || {})) n.set(k, { v: clone(v), del: false, op, ack: 0, t });
    for (const k of remove || []) n.set(k, { v: undefined, del: true, op, ack: 0, t });
  }
  /**
   * A parent's new child order on `board` (applyOrder's entries), carried by write `op` (0: a preview). Acknowledged,
   * expired and forgotten with the parent's other overrides (ack(parentId, op, ok)).
   */
  setOrder(board, parent, entries, op = 0) {
    let b = this.boards.get(board);
    if (!b) this.boards.set(board, (b = new Map()));
    let n = b.get(parent);
    if (!n) b.set(parent, (n = new Map()));
    n.set(ORDER, { v: clone(entries), del: false, op, ack: 0, t: this.now() });
  }
  has(board) { return this.boards.has(board); }
  /** Overrides not yet acknowledged on this board. */
  pending(board) {
    for (const n of (this.boards.get(board) || new Map()).values()) for (const e of n.values()) if (!e.ack) return true;
    return false;
  }
  /** Put the overrides on a scene. True when that changed it. */
  apply(board, scene) {
    const b = this.boards.get(board);
    if (!b || !scene || !scene.root) return false;
    let changed = false;
    // Child orders first (a layer that moved to another parent takes its other overrides along), oldest first.
    const orders = [];
    for (const [id, n] of b) { const e = n.get(ORDER); if (e && !e.del) orders.push([e.t, id, e.v]); }
    if (orders.length) {
      orders.sort((x, y) => x[0] - y[0]);
      if (applyOrder(scene.root, orders.map((o) => [o[1], o[2]]))) changed = true;
    }
    // Many nodes at once (a scale touches a whole subtree): one walk instead of a search per node.
    let index = null;
    if (b.size > 8) {
      index = new Map();
      const visit = (n) => {
        if (!n || typeof n !== "object") return;
        const k = String(n.id);
        if (!index.has(k)) index.set(k, n); // the first one, as findNode answers
        for (const c of Array.isArray(n.children) ? n.children : []) visit(c);
      };
      visit(scene.root);
    }
    for (const [id, n] of b) {
      const node = index ? index.get(id) || null : findNode(scene.root, id);
      if (!node) continue;
      for (const [k, e] of n) {
        if (k === ORDER) continue;
        if (e.del) { if (Object.hasOwn(node, k)) { delete node[k]; changed = true; } }
        else if (!same(node[k], e.v)) { node[k] = clone(e.v); changed = true; }
      }
    }
    return changed;
  }
  /** A scene the server sent, requested at `fetchedAt`: drop what it already has, put the rest on it. */
  rebase(board, scene, fetchedAt) {
    const b = this.boards.get(board);
    if (!b) return false;
    for (const [id, n] of b) {
      for (const [k, e] of n) if (e.ack && e.ack <= fetchedAt) n.delete(k);
      if (!n.size) b.delete(id);
    }
    if (!b.size) { this.boards.delete(board); return false; }
    return this.apply(board, scene);
  }
  /** The write `op` (and every earlier one) for node `id` answered. Returns the boards it touched. */
  ack(id, op, ok) {
    const out = [];
    const t = this.now();
    for (const [board, b] of this.boards) {
      const n = b.get(id);
      if (!n) continue;
      let hit = false;
      for (const [k, e] of n) {
        if (e.ack || !covers(op, e.op)) continue;
        hit = true;
        if (ok) e.ack = t; else n.delete(k);
      }
      if (!n.size) b.delete(id);
      if (!b.size) this.boards.delete(board);
      if (hit) out.push(board);
    }
    return out;
  }
  /** Give up on overrides that waited too long. Returns the boards that changed. */
  expire() {
    const t = this.now(), out = [];
    for (const [board, b] of this.boards) {
      let hit = false;
      for (const [id, n] of b) {
        for (const [k, e] of n) {
          const old = e.ack ? t - e.ack > ACK_MS : e.op ? t - e.t > HOLD_MS : t - e.t > PREVIEW_MS;
          if (old) { n.delete(k); hit = true; }
        }
        if (!n.size) b.delete(id);
      }
      if (!b.size) this.boards.delete(board);
      if (hit) out.push(board);
    }
    return out;
  }
  /** Forget a board (it left the page or the document). */
  drop(board) { this.boards.delete(board); }
  /** Forget some nodes' overrides on a board (a cancelled drag). */
  forget(board, ids) {
    const b = this.boards.get(board);
    if (!b) return;
    for (const id of ids) b.delete(id);
    if (!b.size) this.boards.delete(board);
  }
  /** A gesture still held (a resize or scale handle down, the pointer still): its previews (op 0) on this board stay. */
  touch(board) {
    const t = this.now();
    for (const n of (this.boards.get(board) || new Map()).values()) for (const e of n.values()) if (!e.op && !e.ack) e.t = t;
  }
  /** Drop a gesture's own overrides of some keys of a node (op 0: a preview, or the write `op`): the scene shows the file's value again. */
  unset(board, id, keys, op = 0) {
    const b = this.boards.get(board);
    const n = b && b.get(id);
    if (!n) return;
    for (const k of keys) { const e = n.get(k); if (e && !e.ack && (e.op === 0 || e.op === op)) n.delete(k); }
    if (!n.size) b.delete(id);
    if (!b.size) this.boards.delete(board);
  }
  /** Tag every override of these nodes on a board with the write that now carries it. */
  commit(board, ids, op) {
    const b = this.boards.get(board);
    if (!b) return;
    const t = this.now();
    for (const id of ids) for (const e of (b.get(id) || new Map()).values()) if (!e.ack) { e.op = op; e.t = t; }
  }
  get size() { return this.boards.size; }
}

// ---------------------------------------------------------------- resize

/** The resize handles: edges n e s w, corners ne nw se sw. */
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const CURSOR = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };

/** A selection smaller than this on screen (both sides, view px) has no handles: it only moves. */
export const HANDLE_MIN_PX = 10;
/**
 * The handle under a screen point for a selection drawn at screen rect `s` ({x, y, w, h}), or null. Corners
 * win within `corner` px of a corner (the handle square, not deep inside the box); edges answer within `tol`
 * px of the edge line, inside or outside. A rect too small to grab from inside keeps its middle for moving, and
 * one under HANDLE_MIN_PX on both sides has no handles at all.
 */
export function handleAt(s, px, py, tol = 5, corner = 5) {
  if (!s || !(s.w >= 0) || !(s.h >= 0)) return null;
  // Too small on screen to have handles (they hide): a press on it moves it.
  if (s.w < HANDLE_MIN_PX && s.h < HANDLE_MIN_PX) return null;
  const L = s.x, T = s.y, R = s.x + s.w, B = s.y + s.h;
  if (px < L - tol || px > R + tol || py < T - tol || py > B + tol) return null;
  corner = Math.min(corner, Math.max(3, s.w / 3), Math.max(3, s.h / 3));
  const nearL = Math.abs(px - L) <= corner, nearR = Math.abs(px - R) <= corner, nearT = Math.abs(py - T) <= corner, nearB = Math.abs(py - B) <= corner;
  if (nearT && nearL) return "nw";
  if (nearT && nearR) return "ne";
  if (nearB && nearL) return "sw";
  if (nearB && nearR) return "se";
  // Edges: inside by at most tol (less when the rect is small, so its middle stays a move), outside by tol.
  const inX = Math.min(tol, s.w / 4), inY = Math.min(tol, s.h / 4);
  const within = (v, line, inside, dir) => (dir > 0 ? v >= line - tol && v <= line + inside : v <= line + tol && v >= line - inside);
  if (py >= T && py <= B) {
    if (within(px, L, inX, 1)) return "w";
    if (within(px, R, inX, -1)) return "e";
  }
  if (px >= L && px <= R) {
    if (within(py, T, inY, 1)) return "n";
    if (within(py, B, inY, -1)) return "s";
  }
  return null;
}

/**
 * Whether a resize drag keeps the aspect ratio: with Lock aspect ratio on (the layer's lockAspect),
 * always, unless Control is held; with it off, while Shift is held.
 */
export function keepsRatio(locked, mods) {
  return locked ? !(mods && mods.ctrlKey) : !!(mods && mods.shiftKey);
}

/**
 * The rect a resize gives. r0: the rect at the press (world); handle: which edges move; dx, dy: pointer travel in
 * world units. o: { shift (keep the aspect ratio), alt (from the centre), min (smallest side), round (whole px),
 * snap(edge axis, value) -> value (pull a moving edge onto a guide) }.
 */
export function resizeRect(r0, handle, dx, dy, o = {}) {
  const min = o.min ?? 1;
  const L = handle.includes("w"), R = handle.includes("e"), T = handle.includes("n"), B = handle.includes("s");
  const cx = r0.x + r0.w / 2, cy = r0.y + r0.h / 2;
  let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h;
  if (L) x0 += dx;
  if (R) x1 += dx;
  if (T) y0 += dy;
  if (B) y1 += dy;
  // Snapping moves the edge the pointer drags; Option mirrors it on the other side.
  if (o.snap) {
    if (L) x0 = o.snap("x", x0);
    if (R) x1 = o.snap("x", x1);
    if (T) y0 = o.snap("y", y0);
    if (B) y1 = o.snap("y", y1);
  }
  if (o.alt) {
    if (L) x1 = 2 * cx - x0;
    if (R) x0 = 2 * cx - x1;
    if (T) y1 = 2 * cy - y0;
    if (B) y0 = 2 * cy - y1;
  }
  // An edge dragged past the opposite one flips the box: it keeps resizing on the other side.
  const fx = (L || R) && x1 < x0, fy = (T || B) && y1 < y0;
  if (fx) [x0, x1] = [x1, x0];
  if (fy) [y0, y1] = [y1, y0];
  let w = Math.max(min, x1 - x0), h = Math.max(min, y1 - y0);
  if (o.shift && r0.w > 0 && r0.h > 0) {
    const k = r0.w / r0.h;
    const horiz = L || R, vert = T || B;
    if (horiz && !vert) h = Math.max(min, w / k);
    else if (vert && !horiz) w = Math.max(min, h * k);
    else if (Math.abs(w / r0.w - 1) >= Math.abs(h / r0.h - 1)) h = Math.max(min, w / k);
    else w = Math.max(min, h * k);
  }
  // Anchor: the opposite edge stays (the centre with Option; an edge drag with Shift grows the other side about the middle).
  let x, y;
  if (o.alt || (o.shift && !L && !R)) x = cx - w / 2;
  else x = L !== fx ? x1 - w : x0;
  if (o.alt || (o.shift && !T && !B)) y = cy - h / 2;
  else y = T !== fy ? y1 - h : y0;
  if (o.round !== false) {
    const rx0 = Math.round(x), ry0 = Math.round(y), rx1 = Math.round(x + w), ry1 = Math.round(y + h);
    x = rx0; y = ry0; w = Math.max(min, rx1 - rx0); h = Math.max(min, ry1 - ry0);
  }
  const out = { x, y, w, h };
  if (fx) out.flipX = true;
  if (fy) out.flipY = true;
  return out;
}

/**
 * Snapping for a resize: a function for resizeRect's `snap` that pulls a moving edge onto the nearest line of a
 * snap index (snap.js) within `px` screen pixels at zoom z.
 */
export function edgeSnapper(index, z, px = 6) {
  if (!index || !index.rects.length) return null;
  const tol = px / (z > 0 ? z : 1);
  return (axis, v) => {
    const ax = index[axis];
    const j = nearestLine(ax.v, v, tol);
    return j < 0 ? v : ax.v[j];
  };
}

/** The guides to draw for a rect after a resize (the lines its edges and centre share with indexed rects). */
export const resizeGuides = (index, r) => (index && index.rects.length ? guidesFor(index, r) : []);

/** The bounding box of world rects, or null when there are none. */
export function boundsOf(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue;
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Fit a frame around its content: the frame rect after moving `sides` ("all" or one of n e s w) onto the content
 * bounds `c` (world). Whole px.
 */
export function fitRect(r, c, sides = "all") {
  if (!c) return null;
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  const all = sides === "all";
  if (all || sides.includes("w")) x0 = c.x;
  if (all || sides.includes("e")) x1 = c.x + c.w;
  if (all || sides.includes("n")) y0 = c.y;
  if (all || sides.includes("s")) y1 = c.y + c.h;
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * The writes for a frame that goes from world rect r0 to r: its own props (x/y relative to its parent from
 * `own` = its stored {x, y}; only for nodes that place themselves) and, when `keepChildren`, each absolutely
 * placed child shifted back so it stays where it is on the canvas. kids: [{id, x, y}] (stored values).
 */
export function resizeWrites(r0, r, o) {
  const props = {};
  if (r.w !== r0.w || o.forceSize) props.width = r.w;
  if (r.h !== r0.h || o.forceSize) props.height = r.h;
  const dx = r.x - r0.x, dy = r.y - r0.y;
  if (o.positioned && dx) props.x = Math.round(((o.own && o.own.x) || 0) + dx);
  if (o.positioned && dy) props.y = Math.round(((o.own && o.own.y) || 0) + dy);
  const children = [];
  if (o.keepChildren && (dx || dy)) for (const k of o.kids || []) children.push({ id: k.id, x: Math.round((k.x || 0) - dx), y: Math.round((k.y || 0) - dy) });
  return { props, children };
}

/**
 * Flips in a resize. A flip mirrors a layer about its own top-left corner (engine/src/layout.rs), so a flipped
 * layer's stored x is its right edge on the canvas (y: its bottom). This keeps the stored x/y right for a box that
 * is flipped before and after, and toggles flipX / flipY when the drag crossed the opposite edge (r.flipX, r.flipY,
 * from resizeRect): the layer mirrors and keeps resizing on the other side. `w`: resizeWrites' result
 * (changed in place); o: {flipX, flipY (the layer's now), positioned, own ({x, y} stored)}.
 */
export function flipWrites(w, r0, r, o) {
  const p = w.props;
  const fx0 = !!o.flipX, fy0 = !!o.flipY, fx1 = r.flipX ? !fx0 : fx0, fy1 = r.flipY ? !fy0 : fy0;
  if (fx1 !== fx0) p.flipX = fx1;
  if (fy1 !== fy0) p.flipY = fy1;
  if (!o.positioned) return w;
  const own = o.own || { x: 0, y: 0 };
  const x = Math.round((own.x || 0) + (r.x - r0.x) + (fx1 ? r.w : 0) - (fx0 ? r0.w : 0));
  const y = Math.round((own.y || 0) + (r.y - r0.y) + (fy1 ? r.h : 0) - (fy0 ? r0.h : 0));
  if (x !== (own.x || 0) || p.x !== undefined) p.x = x;
  if (y !== (own.y || 0) || p.y !== undefined) p.y = y;
  return w;
}

/**
 * A turned layer's resize in its own frame (live.js): resizeRect of its box about its centre, `d` the pointer's move
 * turned into that frame, no snapping. Null when the drag would flip it (a turned layer does not flip). o.min: an
 * auto layout frame's padding minimum {w, h} (it stops there, keeping the side opposite the handle, or with
 * Option the centre); o.pixel: whole sizes, rounding taken from the dragged side.
 */
export function rotatedResizeRect(r0, handle, dx, dy, o = {}) {
  const r = resizeRect(r0, handle, dx, dy, { shift: o.shift, alt: o.alt, round: false, min: 1 });
  if (r.flipX || r.flipY) return null;
  let out = { x: r.x, y: r.y, w: r.w, h: r.h };
  const fit = (w, h) => {
    const n = { x: out.x, y: out.y, w, h };
    if (o.alt) { n.x = -w / 2; n.y = -h / 2; return n; } // the box is centred on 0,0
    if (handle.includes("w")) n.x = out.x + out.w - w;
    if (handle.includes("n")) n.y = out.y + out.h - h;
    return n;
  };
  if (o.min && (out.w < o.min.w || out.h < o.min.h)) out = fit(Math.max(out.w, o.min.w), Math.max(out.h, o.min.h));
  if (o.pixel) out = fit(Math.max(1, Math.round(out.w)), Math.max(1, Math.round(out.h)));
  return out;
}

/**
 * textResizeWrites for a turned text box (live.js writesOf): a left or right edge keeps Auto height text Auto
 * height (its height its own) and makes auto-width text Fixed size; the top, bottom or a corner makes it Fixed size. Its x/y
 * stay (rotatedResize moved them). `props` changes in place.
 */
export function rotatedTextWrites(props, handle, growth) {
  if (!/[ns]/.test(handle)) {
    // Auto width dragged by a side: Fixed size at the height it had (rotatedResize keeps it on a side drag).
    if (!growth || growth === "auto") { props.textGrowth = "fixed-width-height"; return props; }
    delete props.height;
    return props;
  }
  if (growth !== "fixed-width-height") props.textGrowth = "fixed-width-height";
  return props;
}

/**
 * A text box resized by a handle changes how it grows, the common convention: a resize by hand makes it Fixed
 * size ("fixed-width-height"). The one exception is a left or right edge on Auto height text ("fixed-width"):
 * it stays Auto height and never touches its height, so a paragraph made wider keeps fitting its lines.
 * `w`: resizeWrites' result (changed in place), `handle`: "e", "nw", ...; `growth`: the text's textGrowth;
 * `r`: the world rect it goes to; `r0`: the rect it had (auto width keeps that height, not a rounded one).
 */
export function textResizeWrites(w, handle, growth, r, r0) {
  const p = w.props;
  if (p.width === undefined && p.height === undefined) return w;
  const vert = /[ns]/.test(handle);
  if (!vert) {
    // A side drag: the height is the text's own (the lines it had or the fixed size), never a rounding artefact.
    delete p.height;
    delete p.y;
    if (p.width === undefined) return w;
    if (!growth || growth === "auto") {
      p.textGrowth = "fixed-width-height";
      p.height = r0 ? r0.h : r.h;
    }
    return w;
  }
  if (growth !== "fixed-width-height") p.textGrowth = "fixed-width-height";
  if (p.width === undefined) p.width = r.w;
  if (p.height === undefined) p.height = r.h;
  return w;
}
