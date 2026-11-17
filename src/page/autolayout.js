// Auto layout on the canvas. Runs on window.canvasHost next to live.js, with the engine renderer.
//
// Drag a layer inside its auto layout frame: it follows the pointer at half opacity and its siblings slide into
// place live (a short ease, instant under Reduce Motion). Release: it lands in the slot, one write (/api/layout
// place), one undo step, the selection stays on it. Drag it more than 8 screen px out of the frame and it is a
// free drag: the siblings close up; over another auto layout frame a 2 px blue line shows the slot (Cmd lets a
// layer bigger than the frame in, Ctrl drops it absolute at the pointer); over a board or a free frame it lands
// where it is dropped; over empty canvas it becomes a board. Several selected siblings move as one block.
// Absolutely placed layers dragged by the page's own move (server.ts) drop into auto layout frames the same way.
// Esc cancels.
//
// Arrow keys reorder a flow child (Left/Right in a horizontal flow, Up/Down in a vertical one; the burst is one
// undo step). Shift+A adds auto layout to the selection, Option+Shift+A removes it (also {cmd: "layout", op}
// from the app). Hovering inside the selected auto layout frame tints its padding and gaps and shows pink
// spacing handles (the zone under the pointer striped): drag one to change that padding (Option: the opposite side
// too, Option+Shift: all four, Shift: big-nudge steps) or the gap (it may go negative; Shift: big-nudge
// steps); whole px while pixel snapping is
// on, a value label at the pointer, Esc cancels, one write and one undo step on release; click one to type a value. Option+double-click an edge of a flow child makes it Fill on that
// axis, a double-click on an auto layout frame's edge makes it Hug.
//
// How the drag draws: the frame being reordered moves to an overlay board of its own for the drag (its place on
// its board stays, empty), laid out as a free frame with its children where the slide has got and the dragged
// block at the pointer, so each frame lays out a few nodes instead of the whole board. Where the siblings slide
// to is measured, not guessed: on a slot change the overlay lays the frame out once in the target order (the
// real layout engine) and reads the rects. The overlay lies exactly over its board (same origin and size, so the
// same device pixels), lists the board's images and fonts, draws in the camera loop before the engine
// (host.beforeFrame, so the block is at this frame's pointer), and the engine draws it and the board it lifts the
// frame from whole in the frame they change (drawNow): no frame shows the layers twice, nowhere, or greyed out.
// qa/frames.ts checks every frame of such drags.
// The pure math is in src/page/autolayout-logic.js (node-tested).

import * as A from "/page/autolayout-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, file } = host;
  const ev = () => (host.renderer === "engine" ? host.engineView : null);
  const live = () => host.live || null;
  const tell = (t) => { if (host.native) host.post({ toast: t }); else { const m = document.getElementById("msg"); if (m) { m.textContent = t; m.style.display = "block"; clearTimeout(tell.t); tell.t = setTimeout(() => { m.style.display = "none"; }, 4000); } else console.warn("[canvas] " + t); } };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  const editingText = () => !!(host.textEdit && host.textEdit.active);
  const isW = (id) => typeof id === "string" && id.startsWith("widget:");
  let VR = view.getBoundingClientRect();
  addEventListener("resize", () => { VR = view.getBoundingClientRect(); sizeCanvas(); paint(); });
  host.on("cmd", (c) => { if (c.cmd === "insets") VR = view.getBoundingClientRect(); });
  const worldAt = (cx, cy) => { const c = host.cam; return { x: (cx - VR.left - c.x) / c.z, y: (cy - VR.top - c.y) / c.z }; };
  const toScreen = (x, y) => { const c = host.cam; return { x: x * c.z + c.x, y: y * c.z + c.y }; };
  const rectOf = (id) => host.worldRectOf(id);
  const stats = { drags: 0, measures: 0, measureMs: 0, hookMs: 0, frames: 0 };

  // ---------- the scene as drawn ----------
  /** Find a node and its parent in a scene tree. */
  function locate(root, id) {
    let hit = null;
    const visit = (n, parent) => {
      if (hit || !n || typeof n !== "object") return;
      if (String(n.id) === id) { hit = { node: n, parent }; return; }
      for (const c of Array.isArray(n.children) ? n.children : []) visit(c, n);
    };
    visit(root, null);
    return hit;
  }
  /** Where selected layers sit: one parent that lays them out, all of them in its flow. Null otherwise. */
  function flowPlace(ids) {
    const L = live(), v = ev();
    if (!L || !v || !ids.length || ids.some((id) => typeof id !== "string" || isW(id) || id.includes("/"))) return null;
    const board = L.boardOf(ids[0]);
    if (!board || board === ids[0] || !host.boards.has(board) || !v.isLoaded(board)) return null;
    if (ids.some((id) => L.boardOf(id) !== board)) return null;
    const scene = L.sceneOf(board);
    if (!scene) return null;
    const first = locate(scene.root, ids[0]);
    if (!first || !first.parent) return null;
    const parent = first.parent;
    if (A.layoutOf(parent) === "none" || String(parent.id).includes("/")) return null;
    const kids = parent.children || [];
    for (const id of ids) {
      const k = kids.find((c) => c && c.id === id);
      if (!k || !A.inFlow(parent, k)) return null;
    }
    const children = kids.map((c) => c.id);
    const flow = kids.filter((c) => A.inFlow(parent, c)).map((c) => c.id);
    const order = flow.filter((id) => ids.includes(id)); // the dragged block in flow order
    return { board, scene, parent, pid: String(parent.id), dir: A.layoutOf(parent), wrap: !!A.extrasOf(parent).wrap, children, flow, ids: order };
  }
  const deepClone = (v) => JSON.parse(JSON.stringify(v));

  // ---------- the drag ----------
  let dg = null; // the drag in progress (or settling after the drop)
  const unionOf = (rs) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const r of rs) { if (!r) continue; x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); } return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };

  // The drag draws on an overlay board of its own (OV): the frame being reordered, cloned out of its board, with
  // the dragged block on top. The source board lays out once when the drag starts (the frame there keeps its
  // size, empty and invisible) and once when it ends; every frame in between lays out only the overlay, a few
  // nodes, so the drag runs at display rate on the largest boards.
  const OV = "\u0000autolayout-drag";
  const eng = () => { const v = ev(); return v && v.engine ? v.engine : null; };
  let ovShown = false, ovBoard = null; // the overlay is in the engine; the board it stands in for
  const ovRect = (id) => { const e = eng(); if (!e || !ovShown) return null; const r = e.nodeRectIn(OV, id); return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null; };
  function removeOverlay() {
    const e = eng();
    if (ovShown && e) { try { e.removeBoard(OV); } catch {} }
    ovShown = false; ovBoard = null;
  }
  /**
   * The engine draws this board whole in the next frame, whatever its tile budget, and never under a placeholder
   * (engine drawNow). The drag hands the frame's layers between the source board and the overlay: a board left to
   * a later frame showed them twice, nowhere, or under a grey veil for a frame or more (a busy GPU, a 120 Hz
   * display, a board of several tiles).
   */
  function urgent(id) {
    const e = eng();
    if (e && e.drawNow && id) { try { e.drawNow(id); } catch {} }
  }
  /** The source board lays out again (live.js) and is drawn in that same frame. */
  function redrawBoard(board) {
    const L = live();
    if (!L || !board) return false;
    urgent(board);
    L.redraw(board);
    return true;
  }
  /**
   * Put layers on the overlay board, on top of every board. The overlay sits exactly on the source board (its
   * origin, its size, no clip), so the engine fits it to the device pixel grid the way it fits that board and the
   * frame's layers land on the same pixels they had there. (An overlay at the frame's own origin and size was fitted
   * on its own: every edge and glyph of the frame moved by up to half a device pixel when the drag began and back
   * when it ended, and its origin and size changed whenever the dragged block reached past the frame.) `kids` are
   * in the board's space.
   */
  function setOverlay(d, kids) {
    const e = eng(), b = d.bRect;
    if (!e || !b) return false;
    const scene = ovScene(d, { id: OV, type: "frame", layout: "none", clip: false, width: Math.max(1, b.w), height: Math.max(1, b.h), children: kids });
    try {
      e.setBoard(OV, b.x, b.y, JSON.stringify(scene));
      e.raiseBoards([OV]);
      urgent(OV);
    } catch (err) { console.error(err); return false; }
    ovShown = true;
    host.requestFrame();
    return true;
  }

  /** A press on a selected flow child (server.ts beginMove): start a reorder drag. False when it is not one. */
  function beginDrag(e, ids) {
    if (dg && dg.slide) finish();
    if (dg || e.button !== 0 || editingText() || host.hand || !eng() || (host.isLocked && ids.some((id) => host.isLocked(id)))) return false;
    const f = flowPlace(ids);
    if (!f) return false;
    // The overlay and the slot math work in world axes: a rotated frame, or one inside a rotated board or frame, cannot.
    if (A.rotatedPath(f.scene.root, f.ids[0])) return false;
    const rects0 = new Map();
    for (const id of [f.pid, ...f.children]) { const r = rectOf(id); if (r) rects0.set(id, r); }
    if (!rects0.has(f.pid) || f.ids.some((id) => !rects0.has(id))) return false;
    const bRect = rectOf(f.board);
    if (!bRect) return false;
    const box0 = unionOf(f.ids.map((id) => rects0.get(id)));
    const p0 = worldAt(e.clientX, e.clientY);
    const pNode = deepClone(f.parent);
    const nodes = new Map();
    for (const id of f.ids) nodes.set(id, pNode.children.find((c) => c.id === id));
    const pr = rects0.get(f.pid);
    const shown = new Map();
    for (const id of f.children) if (!f.ids.includes(id) && rects0.has(id)) shown.set(id, A.rel(rects0.get(id), pr));
    dg = {
      ...f, scene: null, res: resOf(f.scene), bRect, pNode, nodes, rects0, box0, p0, cx: e.clientX, cy: e.clientY, moved: false, mode: "in",
      slot: A.slotOf(f.flow, f.ids), others: f.flow.filter((id) => !f.ids.includes(id)),
      pRect: pr, pOrigin: { x: pr.x, y: pr.y }, pSize: { w: pr.w, h: pr.h }, srcSize: { w: pr.w, h: pr.h },
      from: shown, to: new Map(shown), shown, t0: 0, settle: null,
      p: p0, mods: { ctrl: false, meta: false }, target: null, trees: new Map(), started: false, copy: !!e.altKey,
    };
    try { view.setPointerCapture(e.pointerId); } catch {}
    return true;
  }

  // Option-drag (d.copy): copies of the block go to the slot and the layers stay where they are. The copies are
  // laid out in the frame under ids of their own (cid) while the drag measures; the drop writes them (place copy).
  const cid = (id) => id + "\u0000copy";
  /** The ids that leave the frame's list while dragging: the block, or none when its copies are dragged. */
  const leaving = (d) => (d.copy ? [] : d.ids);
  /** The order the frame's children have for the drag's state (the dragged block, or its copies, at the slot, or gone). */
  const stateOrder = (d) => (d.mode === "in" ? (d.copy ? A.orderWith(d.children, d.flow, d.ids.map(cid), d.slot) : A.orderWith(d.children, d.flow, d.ids, d.slot)) : d.children.filter((id) => !leaving(d).includes(id)));
  const hugs = (n, axis) => n[axis] === "fit_content" || (typeof n[axis] === "string" && n[axis].startsWith("fit_content")) || (n[axis] === undefined && n.type === "frame");
  /** The frame's clone as the overlay draws it, its children in `order`. */
  function frameClone(d, order) {
    const P = Object.assign({}, d.pNode);
    const byId = new Map(d.pNode.children.map((c) => [c.id, c]));
    if (d.copy) for (const id of d.ids) { const n = byId.get(id); if (n) byId.set(cid(id), Object.assign({}, n, { id: cid(id) })); }
    P.children = order.map((id) => byId.get(id)).filter(Boolean).map((c) => Object.assign({}, c));
    delete P.rotation;
    return P;
  }
  // The overlay draws the source board's layers, so it lists the board's fonts and images: the engine draws only the
  // images a scene lists (an empty list drew every image fill of the frame blank for the whole drag).
  const ovScene = (d, root) => ({ version: 2, id: OV, x: 0, y: 0, root, fonts: d.res ? d.res.fonts : [], images: d.res ? d.res.images : [], warnings: [] });
  const resOf = (scene) => ({ fonts: Array.isArray(scene && scene.fonts) ? scene.fonts : [], images: Array.isArray(scene && scene.images) ? scene.images : [] });

  /**
   * Lay the frame out in the drag's target order (the real layout engine, on the overlay), read where its
   * children and its box land, and start the slide there from where they are drawn now.
   */
  function measure(d) {
    const t0 = performance.now();
    const P = frameClone(d, stateOrder(d));
    P.x = d.pOrigin.x - d.bRect.x; P.y = d.pOrigin.y - d.bRect.y;
    // A frame that hugs its content shrinks when the block leaves; a fixed or filling one keeps its size.
    if (!(d.mode === "out" && !d.copy && hugs(d.pNode, "width"))) P.width = d.rects0.get(d.pid).w;
    if (!(d.mode === "out" && !d.copy && hugs(d.pNode, "height"))) P.height = d.rects0.get(d.pid).h;
    if (!setOverlay(d, [P])) return;
    const pr = ovRect(d.pid);
    if (!pr) return;
    const to = new Map();
    for (const id of d.children) {
      if (leaving(d).includes(id)) continue;
      const r = ovRect(id);
      if (r) to.set(id, A.rel(r, pr));
    }
    d.slotRects = new Map(d.ids.map((id) => { const r = ovRect(d.copy ? cid(id) : id); return [id, r ? A.rel(r, pr) : null]; }));
    d.from = new Map(d.shown);
    d.to = to;
    const size = { w: pr.w, h: pr.h };
    if (size.w !== d.pSize.w || size.h !== d.pSize.h) { d.pSize = size; d.srcSize = size; redrawBoard(d.board); }
    d.t0 = performance.now();
    stats.measures++;
    stats.measureMs = Math.round((performance.now() - t0) * 100) / 100;
    drawOverlay(d);
  }

  /** How far the slide has got (0..1). */
  const progress = (d) => (reduce.matches ? 1 : A.ease((performance.now() - d.t0) / A.SLIDE_MS));

  /** Numbers for a node's size where the scene has none (a free frame does not fill or hug like a flow does). */
  function fixSize(n, r) {
    if (!r) return;
    const text = n.type === "text";
    const g = n.textGrowth;
    if (typeof n.width !== "number" && !(text && (!g || g === "auto"))) n.width = r.w;
    if (typeof n.height !== "number" && !(text && g !== "fixed-width-height")) n.height = r.h;
  }

  /** One overlay frame: the frame's children where the slide has got, the block at the pointer (or settling). */
  function drawOverlay(d) {
    const t0 = performance.now();
    const k = progress(d);
    const P = frameClone(d, d.children.filter((id) => !leaving(d).includes(id)));
    P.layout = "none";
    P.width = d.pSize.w; P.height = d.pSize.h;
    for (const c of P.children) {
      if (c.layoutPosition === "absolute") continue;
      const a = d.from.get(c.id) || d.to.get(c.id), b = d.to.get(c.id) || a;
      if (!a) continue;
      const r = A.lerpRect(a, b, k);
      c.x = r.x; c.y = r.y;
      fixSize(c, r);
      d.shown.set(c.id, r);
    }
    // The block, relative to the frame's origin.
    const dx = d.p.x - d.p0.x, dy = d.p.y - d.p0.y;
    d.drawn = { x: d.p.x, y: d.p.y };
    const s = d.settle;
    const ks = s ? (reduce.matches ? 1 : A.ease((performance.now() - s.t0) / A.SLIDE_MS)) : 0;
    const ghost = [];
    for (const id of d.ids) {
      const n = Object.assign({}, d.nodes.get(id));
      const r0 = d.rects0.get(id);
      let r = { x: r0.x + dx - d.pOrigin.x, y: r0.y + dy - d.pOrigin.y, w: r0.w, h: r0.h };
      if (s && d.slotRects && d.slotRects.get(id)) r = A.lerpRect(r, d.slotRects.get(id), ks);
      n.x = r.x; n.y = r.y;
      n.layoutPosition = "absolute";
      fixSize(n, r);
      n.opacity = (typeof n.opacity === "number" ? n.opacity : 1) * (s ? 0.5 + 0.5 * ks : 0.5);
      ghost.push({ n, r });
    }
    // In the frame the block draws inside it (its clip applies); out of it, above everything.
    const fx = d.pOrigin.x - d.bRect.x, fy = d.pOrigin.y - d.bRect.y;
    P.x = fx; P.y = fy;
    const kids = [P];
    if (d.mode === "in") P.children.push(...ghost.map((g) => g.n));
    else for (const g of ghost) { g.n.x += fx; g.n.y += fy; kids.push(g.n); }
    setOverlay(d, kids);
    ovBoard = d.board;
    stats.hookMs = Math.round((performance.now() - t0) * 100) / 100;
    stats.frames++;
    if (k < 1 || (s && ks < 1)) tick();
  }
  let due = false;
  /**
   * Draw the overlay in the next frame (pointer moves and the slide), inside the camera loop before the engine
   * draws (host.beforeFrame). A requestAnimationFrame of its own ran after the loop's: the layer showed where the
   * pointer was one move before, except on the moves that changed the slot (drawn at once), so it fell behind and
   * caught up again at every slot.
   */
  function tick() {
    if (due) return;
    due = true;
    host.requestFrame();
  }
  if (host.beforeFrame) host.beforeFrame(() => { if (!due) return; due = false; if (dg && dg.started) drawOverlay(dg); });

  /** The source board as drawn during the drag: the frame keeps its box, empty and invisible (live.js scene hook). */
  function hook(board, scene) {
    const d = dg;
    if (!d || !d.started) {
      // The drag ended: the overlay goes in the same frame the board gets its frame back.
      if (ovShown && board === ovBoard) removeOverlay();
      return;
    }
    if (board !== d.board || !scene || !scene.root) return;
    const at = locate(scene.root, d.pid);
    if (!at) return;
    const P = at.node;
    P.children = [];
    P.opacity = 0;
    P.width = d.srcSize.w; P.height = d.srcSize.h;
    // Where the frame lands after this layout (a hugging frame that shrank may move): the overlay follows.
    queueMicrotask(() => {
      if (dg !== d) return;
      const r = rectOf(d.pid), b = rectOf(d.board);
      let moved = false;
      if (b && (b.x !== d.bRect.x || b.y !== d.bRect.y || b.w !== d.bRect.w || b.h !== d.bRect.h)) { d.bRect = b; moved = true; }
      if (r && (r.x !== d.pOrigin.x || r.y !== d.pOrigin.y)) { d.pOrigin = { x: r.x, y: r.y }; d.pRect = r; moved = true; }
      if (moved) tick();
    });
    if (!ovShown) drawOverlay(d);
    return true; // the scene changed beyond the layers live.js knows were edited (live.js flush)
  }

  /** The board under a world point (the last drawn wins), or null. */
  function boardAt(p, skip = null) {
    let hit = null;
    for (const id of host.boards.keys()) { if (id === skip) continue; const r = host.boxOf(id); if (r && A.contains(r, p)) hit = id; }
    return hit;
  }
  /** A board's scene tree for target finding, parsed once per drag. */
  function treeOf(d, board) {
    if (!d.trees.has(board)) { const L = live(); d.trees.set(board, L ? L.sceneOf(board) : null); }
    return d.trees.get(board);
  }
  /** Rects during a drag: the frame's children are on the overlay. */
  const dragRect = (id) => rectOf(id) || ovRect(id);
  /** Where a free drag would land: {kind: "flow" | "free" | "canvas", id, board, node, dir, slot, rects}. */
  function findTarget(d, p, mods, exclude, size) {
    const board = boardAt(p);
    if (!board) return { kind: "canvas", id: null, board: null };
    const scene = treeOf(d, board);
    if (!scene) return null;
    d.uses ??= A.componentsIn([...d.nodes.values()]);
    const t = A.dropTarget(scene.root, p, dragRect, exclude, size, mods.meta, d.uses);
    if (!t) return null;
    const node = t.node;
    if (t.layout === "none" || mods.ctrl) return { kind: "free", id: t.id, board, node };
    const kids = (node.children || []).filter((c) => c && !exclude.has(c.id) && A.inFlow(node, c));
    const rects = [], flow = [];
    for (const c of kids) { const r = dragRect(c.id); if (r) { rects.push(r); flow.push(c.id); } }
    const wrap = !!A.extrasOf(node).wrap;
    return { kind: "flow", id: t.id, board, node, dir: t.layout, wrap, flow, rects, slot: A.slotAt(rects, p, t.layout, wrap), line: wrap && rects.length ? A.lineAt(rects, p, t.layout) : -1 };
  }

  addEventListener("pointermove", (e) => {
    const d = dg;
    if (!d || d.settle || d.slide) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 3) return;
      d.moved = true;
      d.started = true;
      stats.drags++;
      selBoxShown(false); // its box would stay where the layer was; the half-transparent layer shows where it is
      hover = null;
      measure(d);
      redrawBoard(d.board); // the frame leaves its board for the overlay
    }
    const p = worldAt(e.clientX, e.clientY);
    d.p = p;
    d.mods = { ctrl: e.ctrlKey, meta: e.metaKey };
    const flipped = !!e.altKey !== d.copy;
    d.copy = !!e.altKey;
    const z = host.cam.z;
    const wasMode = d.mode, wasSlot = d.slot;
    const pr = { x: d.pOrigin.x, y: d.pOrigin.y, w: d.pSize.w, h: d.pSize.h };
    // Space held (host.keepParent, server.ts): the block keeps its parent, so it never leaves the frame.
    const keep = !!(host.keepParent && host.keepParent());
    if (d.mode === "in" && !keep && (A.outside(pr, p, A.OUT_PX / z) || e.ctrlKey)) d.mode = "out";
    else if (d.mode === "out" && (keep || (A.contains(pr, p) && !e.ctrlKey))) d.mode = "in";
    place(d, p);
    if (flipped || d.mode !== wasMode || (d.mode === "in" && d.slot !== wasSlot)) measure(d);
    else tick();
    paint();
  }, true);
  /** The slot (in the frame) or the target (out of it) for the pointer at world p. */
  function place(d, p) {
    if (d.mode === "in") {
      const sibs = (d.copy ? d.flow : d.others).map((id) => d.rects0.get(id)).filter(Boolean);
      d.slot = A.slotAt(sibs, p, d.dir, d.wrap);
      d.target = null;
    } else {
      d.target = findTarget(d, p, d.mods, new Set(d.ids), { w: d.box0.w, h: d.box0.h });
    }
  }
  // Option pressed or let go mid-drag: copies or the layers themselves, now.
  const altFlip = (e) => {
    const d = dg;
    if (e.key !== "Alt" || !d || !d.started || d.settle || d.slide || d.copy === e.altKey) return;
    d.copy = e.altKey;
    place(d, d.p);
    measure(d);
    paint();
  };
  addEventListener("keydown", altFlip, true);
  addEventListener("keyup", altFlip, true);
  /** Space pressed or let go mid-drag (server.ts): out of the frame the block comes back to its slot there, or leaves again. */
  function keepParent(on) {
    const d = dg;
    if (!d || !d.started || d.settle || d.slide) return;
    const pr = { x: d.pOrigin.x, y: d.pOrigin.y, w: d.pSize.w, h: d.pSize.h };
    const mode = on ? "in" : d.mods.ctrl || A.outside(pr, d.p, A.OUT_PX / host.cam.z) ? "out" : d.mode;
    if (mode === d.mode) return;
    d.mode = mode;
    place(d, d.p);
    measure(d);
    paint();
  }
  addEventListener("pointerup", (e) => { if (dg && !dg.settle && !dg.slide) { drop(e); } }, true);
  addEventListener("pointercancel", () => { if (dg && !dg.settle && !dg.slide) cancel(); }, true);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dg && !dg.settle && !dg.slide) { e.preventDefault(); e.stopPropagation(); cancel(); }
  }, true);
  host.on("deselect", () => { if (dg && !dg.settle) cancel(); });
  /** Undo or Redo while a drag is held: the drag lets go first (its drop would be built on the board before the step). */
  function cancelDrag() { if (dg && !dg.settle && !dg.slide) { cancel(); return true; } return false; }

  const selEl = document.getElementById("sel");
  function selBoxShown(on) { if (selEl) selEl.style.visibility = on ? "" : "hidden"; }
  /** Forget the drag: the source board lays out from its scene again and the overlay goes in that same frame. */
  function finish() {
    const d = dg;
    dg = null;
    selBoxShown(true);
    due = false;
    paint();
    if (!d) return;
    if (!d.started) return;
    // Where the layers land: drawn in the frame the overlay goes (a board a drop changed, as well as the source).
    if (d.target && d.target.board && d.target.board !== d.board) urgent(d.target.board);
    if (!redrawBoard(d.board)) removeOverlay();
    // A board that does not lay out again (it left the page meanwhile) must not keep the overlay.
    setTimeout(() => { if (!dg && ovShown) { removeOverlay(); host.requestFrame(); } }, 400);
    host.syncSel();
  }
  function cancel() {
    const d = dg;
    if (!d) return;
    finish();
  }

  let writes = 0;
  /** One /api/layout call. */
  function callLayout(body) {
    writes++;
    return fetch("/api/layout", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, page: host.page || undefined, ...body }) })
      .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { code: j.code }); return j; }))
      .finally(() => { writes--; if (!writes && host.writesSettled) host.writesSettled(); });
  }
  /** Rects the server needs for a place: the moved layers, their parent, the target. */
  function rectsFor(ids) {
    const out = {};
    for (const id of ids) { if (!id || out[id]) continue; const r = dragRect(id); if (r) out[id] = r; }
    return out;
  }

  function drop(e) {
    const d = dg;
    if (!d.moved) { dg = null; return; }
    const L = live();
    const op = L ? L.nextOp() : 0;
    const ids = d.ids.slice();
    const selAt = selKey();
    if (d.copy) { dropCopies(d, ids, op, selAt); return; }
    if (d.mode === "in") {
      const order = A.orderWith(d.children, d.flow, ids, d.slot);
      if (order.join("\n") === d.children.join("\n")) { settleThenFinish(d); return; }
      L.order(d.board, d.pid, order, op);
      settleThenFinish(d);
      send({ op: "place", ids, parent: d.pid, before: A.beforeIn(order, ids), rects: rectsFor([...ids, d.pid]) }, op, [d.pid, ...ids], ids, selAt);
      return;
    }
    const t = d.target;
    const dx = d.p.x - d.p0.x, dy = d.p.y - d.p0.y;
    const at = ids.map((id) => { const r = d.rects0.get(id); return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }; });
    const round = (v) => (host.snap && host.snap().pixel ? Math.round(v) : Math.round(v * 100) / 100);
    if (!t) { cancel(); tell("Drop it on a board or a frame"); return; }
    const rest = d.children.filter((id) => !ids.includes(id));
    if (t.kind === "flow") {
      const children = (t.node.children || []).map((c) => c.id).filter((id) => !ids.includes(id));
      const order = A.orderWith(children, t.flow, ids, t.slot);
      L.order(d.board, d.pid, rest, op);
      L.order(t.board, t.id, t.board === d.board ? order : order.map((id) => (ids.includes(id) ? { id, node: d.nodes.get(id) } : id)), op);
      for (const id of ids) L.raw(t.board, id, {}, ["x", "y", "layoutPosition"], op);
      finish();
      send({ op: "place", ids, parent: t.id, before: A.beforeIn(order, ids), rects: rectsFor([...ids, d.pid, t.id]) }, op, [d.pid, t.id, ...ids], ids, selAt);
      return;
    }
    if (t.kind === "canvas") {
      // Empty canvas: each layer becomes a board where it was dropped.
      finish();
      send({ op: "place", ids, parent: null, index: 0, absolute: at.map((r) => ({ x: round(r.x), y: round(r.y) })), rects: rectsFor([...ids, d.pid]) }, op, [d.pid, ...ids], ids, selAt);
      L.order(d.board, d.pid, rest, op);
      return;
    }
    // A free frame or board (or Ctrl into an auto layout frame): where it was dropped, on top.
    const tr = rectOf(t.id);
    if (!tr) { cancel(); return; }
    const children = (t.node.children || []).map((c) => c.id).filter((id) => !ids.includes(id));
    const absolute = at.map((r) => ({ x: round(r.x - tr.x), y: round(r.y - tr.y) }));
    const order = children.concat(ids);
    if (t.id !== d.pid) L.order(d.board, d.pid, rest, op);
    L.order(t.board, t.id, t.board === d.board ? order : order.map((id) => (ids.includes(id) ? { id, node: d.nodes.get(id) } : id)), op);
    ids.forEach((id, i) => L.raw(t.board, id, { x: absolute[i].x, y: absolute[i].y, ...(A.layoutOf(t.node) !== "none" ? { layoutPosition: "absolute" } : {}) }, [], op));
    finish();
    send({ op: "place", ids, parent: t.id, before: null, absolute, rects: rectsFor([...ids, d.pid, t.id]) }, op, [d.pid, t.id, ...ids], ids, selAt);
  }
  /** An Option-drag's drop: copies land at the slot or target (one place write with copy), the layers stay. */
  function dropCopies(d, ids, op, selAt) {
    const dx = d.p.x - d.p0.x, dy = d.p.y - d.p0.y;
    const round = (v) => (host.snap && host.snap().pixel ? Math.round(v) : Math.round(v * 100) / 100);
    const at = ids.map((id) => { const r = d.rects0.get(id); return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }; });
    if (d.mode === "in") {
      const order = A.orderWith(d.children, d.flow, ids.map(cid), d.slot);
      settleThenFinish(d);
      send({ op: "place", copy: true, ids, parent: d.pid, before: A.beforeIn(order, ids.map(cid)), rects: rectsFor([...ids, d.pid]) }, op, [d.pid], ids, selAt);
      return;
    }
    const t = d.target;
    if (!t) { cancel(); tell("Drop it on a board or a frame"); return; }
    finish();
    if (t.kind === "flow") {
      const children = (t.node.children || []).map((c) => c.id);
      const order = A.orderWith(children, t.flow, ids.map(cid), t.slot);
      send({ op: "place", copy: true, ids, parent: t.id, before: A.beforeIn(order, ids.map(cid)), rects: rectsFor([...ids, d.pid, t.id]) }, op, [t.id], ids, selAt);
    } else if (t.kind === "canvas") {
      send({ op: "place", copy: true, ids, parent: null, index: 0, absolute: at.map((r) => ({ x: round(r.x), y: round(r.y) })), rects: rectsFor([...ids, d.pid]) }, op, [d.pid], ids, selAt);
    } else {
      const tr = rectOf(t.id);
      if (!tr) return;
      send({ op: "place", copy: true, ids, parent: t.id, before: null, absolute: at.map((r) => ({ x: round(r.x - tr.x), y: round(r.y - tr.y) })), rects: rectsFor([...ids, d.pid, t.id]) }, op, [t.id], ids, selAt);
    }
  }
  /** After a drop in the frame: the layer eases from the pointer into its slot, then the drag lets go. */
  function settleThenFinish(d) {
    if (reduce.matches || !d.slotRects) { finish(); return; }
    d.settle = { t0: performance.now() };
    tick();
    setTimeout(() => { if (dg === d) finish(); }, A.SLIDE_MS + 20);
  }
  /** The selection now, as one string (to tell whether the person picked something else meanwhile). */
  const selKey = () => (host.selection ? host.selection() : host.sel ? [host.sel] : []).join("\n");
  /** One place write. Its answer selects the moved layers only while the selection is still the one at `selAt`. */
  function send(body, op, ackIds, select, selAt) {
    const L = live();
    return callLayout(body).then((j) => {
      for (const id of new Set(ackIds)) if (L) L.ack(id, op, true);
      const sel = (j && Array.isArray(j.select) && j.select.length ? j.select : select);
      if (sel && sel.length && host.setSelection && (selAt === undefined || selKey() === selAt)) host.setSelection(sel);
      return j;
    }, (err) => {
      for (const id of new Set(ackIds)) if (L) L.ack(id, op, false);
      for (const b of host.boards.keys()) if (L) L.redraw(b);
      tell("Could not move: " + err.message);
    });
  }

  // ---------- absolutely placed layers dragged into an auto layout frame (server.ts move) ----------
  let into = null; // {target, id}
  // Scenes the drag's drop test reads, parsed once per board while the server's scene stays the same: two parses of
  // a whole board scene on every pointer move were 1.5 ms of each frame on a 1,300-node board. The dragged layer is
  // left out of the test, so its own position in them does not matter.
  let ovScenes = { id: null, map: new Map() };
  function moveScene(id, board) {
    const L = live(), v = ev();
    if (!L || !board) return null;
    if (ovScenes.id !== id) ovScenes = { id, map: new Map() };
    const text = v ? v.sceneText(board) : null;
    const hit = ovScenes.map.get(board);
    if (hit && text !== null && hit.text === text) return hit.scene;
    const scene = L.sceneOf(board);
    if (scene && text !== null) ovScenes.map.set(board, { text, scene });
    return scene;
  }
  const forgetMoveScenes = () => { ovScenes = { id: null, map: new Map() }; };
  /** During a page move of an absolute layer or a board: the auto layout frame (not its own parent) it would drop into. */
  function overInto(id, cx, cy, mods = {}) {
    if (!id || !ev() || isW(id) || id.includes("/")) { if (into) { into = null; paint(); } return; }
    const L = live();
    const board = L && L.boardOf(id);
    const p = worldAt(cx, cy);
    const tb = boardAt(p, id); // a dragged board is under the pointer itself
    const scene = tb && L ? moveScene(id, tb) : null;
    if (!scene || !board) { if (into) { into = null; paint(); } return; }
    const own = locate((moveScene(id, board) || {}).root, id);
    const r = rectOf(id);
    const t = A.dropTarget(scene.root, p, rectOf, new Set([id]), r ? { w: r.w, h: r.h } : null, !!mods.meta, own ? A.componentsIn([own.node]) : null);
    if (!t || t.layout === "none" || mods.ctrl || (own && own.parent && String(own.parent.id) === t.id)) { if (into) { into = null; paint(); } return; }
    const kids = (t.node.children || []).filter((c) => c && c.id !== id && A.inFlow(t.node, c));
    const rects = [], flow = [];
    for (const c of kids) { const rr = rectOf(c.id); if (rr) { rects.push(rr); flow.push(c.id); } }
    const wrap = !!A.extrasOf(t.node).wrap;
    into = { id, target: { kind: "flow", id: t.id, board: tb, node: t.node, dir: t.layout, wrap, flow, rects, slot: A.slotAt(rects, p, t.layout, wrap), line: wrap && rects.length ? A.lineAt(rects, p, t.layout) : -1 } };
    paint();
  }
  /**
   * The move's drop: truthy when it went into an auto layout frame (one place write) instead of a plain move: the
   * write's promise (it resolves with the server's answer, or undefined when the write failed). A board joins the
   * flow too: it leaves the canvas now (host.hideBoards) and comes back if the write fails.
   */
  function dropInto(id, cx, cy, mods = {}, opts = {}) {
    overInto(id, cx, cy, mods);
    forgetMoveScenes();
    const it = into;
    into = null;
    paint();
    if (!it || it.id !== id) return false;
    const t = it.target;
    const children = (t.node.children || []).map((c) => c.id).filter((x) => x !== id);
    const order = A.orderWith(children, t.flow, [id], t.slot);
    const L = live();
    const op = L ? L.nextOp() : 0;
    // Option-drag (server.ts): a copy joins the flow there, the layer stays where it is.
    if (opts.copy) { send({ op: "place", copy: true, ids: [id], parent: t.id, before: A.beforeIn(order, [id]), rects: rectsFor([id, t.id]) }, op, [t.id], [id], selKey()); return true; }
    const board = L.boardOf(id);
    const scene = board ? L.sceneOf(board) : null;
    const own = scene ? locate(scene.root, id) : null;
    const isBoard = host.boards.has(id);
    const body = { op: "place", ids: [id], parent: t.id, before: A.beforeIn(order, [id]), rects: rectsFor([id, t.id, own && own.parent ? String(own.parent.id) : null]) };
    if (own && own.parent) L.order(board, String(own.parent.id), (own.parent.children || []).map((c) => c.id).filter((x) => x !== id), op);
    L.order(t.board, t.id, t.board === board ? order : order.map((x) => (x === id && own ? { id, node: deepClone(own.node) } : x)), op);
    L.raw(t.board, id, {}, ["x", "y", "layoutPosition"], op);
    if (isBoard && host.hideBoards) host.hideBoards([id]);
    const w = send(body, op, [id, t.id, own && own.parent ? String(own.parent.id) : id], [id], selKey());
    return isBoard ? w.then((j) => { if (!j && host.restoreBoards) host.restoreBoards([id]); return j; }) : w;
  }

  /**
   * A multi-selection's drop (server.ts groupDrop): over an auto layout frame that is not their parent, the layers
   * join its flow at the slot under the pointer (or, opts.copy, copies of them do), in one place write that keeps
   * `opts.merge`. False when it did not go there; else true or the write's promise.
   */
  function dropManyInto(ids, cx, cy, mods = {}, opts = {}) {
    if (!ids.length) return false;
    if (ids.length === 1) return dropInto(ids[0], cx, cy, mods, opts);
    const L = live();
    if (!L || !ev() || mods.ctrl || ids.some((id) => isW(id) || id.includes("/"))) return false;
    const p = worldAt(cx, cy);
    const tb = boardAt(p);
    const scene = tb ? L.sceneOf(tb) : null;
    if (!scene) return false;
    const moving = new Set(ids), uses = new Set(), parents = new Set();
    for (const id of ids) {
      const b = L.boardOf(id), own = b ? locate((L.sceneOf(b) || {}).root, id) : null;
      if (!own) return false;
      for (const c of A.componentsIn([own.node])) uses.add(c);
      if (own.parent) parents.add(String(own.parent.id));
    }
    const t = A.dropTarget(scene.root, p, rectOf, moving, null, !!mods.meta, uses);
    if (!t || t.layout === "none" || (parents.size === 1 && parents.has(t.id))) return false;
    const kids = (t.node.children || []).filter((c) => c && !moving.has(c.id) && A.inFlow(t.node, c));
    const rects = [], flow = [];
    for (const c of kids) { const rr = rectOf(c.id); if (rr) { rects.push(rr); flow.push(c.id); } }
    const slot = A.slotAt(rects, p, t.layout, !!A.extrasOf(t.node).wrap);
    const children = (t.node.children || []).map((c) => c.id).filter((x) => !moving.has(x));
    const order = A.orderWith(children, flow, ids, slot);
    const op = L.nextOp();
    const body = { op: "place", ids, parent: t.id, before: A.beforeIn(order, ids), rects: rectsFor([...ids, t.id, ...parents]), ...(opts.copy ? { copy: true } : {}), ...(opts.merge ? { merge: opts.merge } : {}) };
    return send(body, op, [t.id, ...ids], opts.copy ? null : ids, selKey()); // a promise: true enough for the caller
  }

  // ---------- arrow keys ----------
  let arrowChain = Promise.resolve();
  let arrowsOut = 0;
  /** Arrow keys on flow children: one slot along the flow. True when the selection is placed by auto layout (handled). */
  function arrow(dx, dy) {
    if ((dg && !dg.slide) || editingText()) return false;
    const ids = host.selection ? host.selection() : host.sel ? [host.sel] : [];
    const f = flowPlace(ids);
    if (!f) return false;
    const slot = A.arrowSlot(f.dir, dx, dy, f.flow, f.ids);
    if (slot === null) return true;
    const order = A.orderWith(f.children, f.flow, f.ids, slot);
    const L = live();
    const op = L.nextOp();
    const selAt = selKey();
    animateTo(f, order, op);
    const body = { op: "place", ids: f.ids, parent: f.pid, before: A.beforeIn(order, f.ids), rects: rectsFor([...f.ids, f.pid]), merge: "nudge" };
    arrowsOut++;
    arrowChain = arrowChain.then(() => send(body, op, [f.pid, ...f.ids], null, selAt)).finally(() => { arrowsOut--; if (!arrowsOut && host.writesSettled) host.writesSettled(); });
    return true;
  }
  /** Reorder a frame's children now (an override carried by write `op`) and slide every child there. */
  function animateTo(f, order, op) {
    const L = live();
    // A slide still running (a burst of presses): the next one starts from where it has got.
    const prev = dg && dg.slide && dg.pid === f.pid ? dg : null;
    if (dg && dg.slide && !prev) finish();
    const pr = prev ? { x: prev.pOrigin.x, y: prev.pOrigin.y, w: prev.pSize.w, h: prev.pSize.h } : rectOf(f.pid);
    const bRect = prev ? prev.bRect : rectOf(f.board);
    const from = new Map();
    if (prev) for (const [id, r] of prev.shown) from.set(id, r);
    else if (pr) for (const id of f.children) { const r = rectOf(id); if (r) from.set(id, A.rel(r, pr)); }
    L.order(f.board, f.pid, order, op);
    if (prev) { dg = null; due = false; }
    if (reduce.matches || !pr || !bRect || (dg && !dg.slide)) { if (prev) { dg = prev; finish(); } return; }
    // The frame slides on the overlay board: measure the new order there, then ease every child to it.
    const pNode = deepClone(f.parent);
    const d = {
      slide: true, board: f.board, pid: f.pid, pNode, res: resOf(f.scene), bRect, children: order, flow: order.filter((id) => f.flow.includes(id)), ids: [], slot: 0, others: [],
      rects0: new Map([[f.pid, pr]]), pRect: pr, pOrigin: { x: pr.x, y: pr.y }, pSize: { w: pr.w, h: pr.h }, srcSize: { w: pr.w, h: pr.h },
      from, to: new Map(from), shown: new Map(from), t0: 0, settle: null, p: { x: 0, y: 0 }, p0: { x: 0, y: 0 }, mode: "in", started: true, moved: true,
      nodes: new Map(), trees: new Map(), target: null, mods: {},
    };
    dg = d;
    measure(d);
    redrawBoard(f.board);
    clearTimeout(slideT);
    slideT = setTimeout(() => { if (dg === d) finish(); }, A.SLIDE_MS + 40);
  }
  let slideT = 0;

  // ---------- Shift+A / Option+Shift+A ----------
  let lastLayoutKey = { op: "", at: 0 };
  /** Rects for add/remove: the layers, their parents, their children (all descendants that lay out, for a deep remove). */
  function layoutRects(ids, deep) {
    const L = live();
    const out = {};
    const add = (id) => { if (id && !out[id]) { const r = rectOf(id); if (r) out[id] = r; } };
    for (const id of ids) {
      add(id);
      const board = L && L.boardOf(id);
      const scene = board ? L.sceneOf(board) : null;
      const at = scene ? locate(scene.root, id) : null;
      if (!at) continue;
      if (at.parent) add(String(at.parent.id));
      let budget = 4000;
      const walk = (n, depth) => {
        for (const c of n.children || []) {
          if (--budget < 0) return;
          add(String(c.id));
          if (deep || depth < 1) walk(c, depth + 1);
        }
      };
      walk(at.node, 0);
    }
    return out;
  }
  /** One layout op from a key, the app or a double-click. done(ok), when given, hears how it went. */
  function runLayoutOp(op, extra = {}, done) {
    const fin = (ok) => { if (done) done(ok); };
    if (editingText()) return fin(false);
    const now = performance.now();
    // Shift+A pressed while the app's menu also answers: one add. Only add/remove; two quick inspector changes both count.
    if ((op === "add" || op === "remove") && lastLayoutKey.op === op && now - lastLayoutKey.at < 300) return fin(false);
    lastLayoutKey = { op, at: now };
    const ids = (Array.isArray(extra.ids) ? extra.ids : host.selection ? host.selection() : []).filter((id) => !isW(id));
    if (!ids.length && !(op === "sizing" && extra.id)) { tell(op === "add" ? "Select layers to add auto layout" : "Select an auto layout frame"); return fin(false); }
    const reload = () => { const L = live(); for (const id of ids) { const b = L && L.boardOf(id); if (b && host.reloadBoard) host.reloadBoard(b); } };
    if (op === "sizing" && ids.length > 1) {
      // The server sizes one layer per call: one call each, folded into one undo step.
      const merge = "group:sizing-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      // The whole chain counts as one write still out: Undo must not slip in between two of its calls.
      writes++;
      let chain = Promise.resolve();
      for (const id of ids) chain = chain.then(() => callLayout({ ...extra, op, id, ids: [id], rects: layoutRects([id], false), merge }));
      chain.then(() => { if (host.setSelection) host.setSelection(ids); reload(); fin(true); }, (err) => { tell(err.message); fin(false); })
        .finally(() => { writes--; if (!writes && host.writesSettled) host.writesSettled(); });
      return;
    }
    const body = { op, ids, rects: layoutRects(op === "sizing" && extra.id ? [extra.id] : ids, !!extra.deep), ...extra };
    if (op === "sizing" && !body.id) body.id = ids[0];
    callLayout(body).then((j) => {
      if (j && Array.isArray(j.select) && j.select.length && host.setSelection) host.setSelection(j.select);
      reload();
      fin(true);
    }, (err) => { tell(err.message); fin(false); });
  }
  /**
   * Control+Shift+A, Suggest auto layout: every selected frame without auto layout becomes one, each inferred
   * from its own children (direction, the gap they have, padding; src/autolayout.ts inferLayout), in one undo step.
   * Shift+A on several layers wraps them in one new frame instead.
   */
  function suggest() {
    if (editingText()) return;
    const L = live();
    const ids = (host.selection ? host.selection() : []).filter((id) => !isW(id) && !id.includes("/"));
    const frames = ids.filter((id) => {
      const board = L && L.boardOf(id), scene = board ? L.sceneOf(board) : null, at = scene ? locate(scene.root, id) : null;
      return at && at.node.type === "frame" && A.layoutOf(at.node) === "none" && (at.node.children || []).length > 0;
    });
    if (!frames.length) { tell("Select frames with layers in them to suggest auto layout"); return; }
    const merge = "group:suggest-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    writes++;
    let chain = Promise.resolve();
    for (const id of frames) chain = chain.then(() => callLayout({ op: "add", ids: [id], rects: layoutRects([id], false), merge }));
    chain.then(() => { if (host.setSelection) host.setSelection(ids); for (const id of frames) { const b = L.boardOf(id); if (b && host.reloadBoard) host.reloadBoard(b); } }, (err) => tell(err.message))
      .finally(() => { writes--; if (!writes && host.writesSettled) host.writesSettled(); });
  }
  addEventListener("keydown", (e) => {
    if (typing(e.target) || editingText() || e.metaKey || e.repeat) return;
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyA") { e.preventDefault(); e.stopPropagation(); suggest(); return; }
    if (e.ctrlKey) return;
    if (e.code !== "KeyA" || !e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    runLayoutOp(e.altKey ? "remove" : "add");
  }, true);
  host.on("cmd", (c) => {
    if (c.cmd !== "layout" || typeof c.op !== "string") return;
    if (c.op === "suggest") { suggest(); return; }
    const { cmd, op, ...rest } = c;
    delete rest.insets;
    runLayoutOp(op, rest);
  });

  // ---------- spacing handles ----------
  const cv = document.createElement("canvas");
  cv.id = "alOverlay";
  cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:3";
  view.appendChild(cv);
  const ctx = cv.getContext("2d");
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1, w = view.clientWidth, h = view.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr)); cv.style.width = w + "px"; cv.style.height = h + "px"; }
  }
  sizeCanvas();

  let frameInfo = null; // the selected auto layout frame: {id, board, node}
  function loadFrame() {
    frameInfo = null;
    const id = host.sel;
    const L = live();
    if (!id || isW(id) || id.includes("/") || !L || !ev() || (host.selection && host.selection().length > 1)) return;
    const board = L.boardOf(id);
    if (!board) return;
    const scene = L.sceneOf(board);
    if (!scene) return;
    const at = locate(scene.root, id);
    if (!at || A.layoutOf(at.node) === "none") return;
    frameInfo = { id, board, node: at.node };
  }
  host.on("select", () => { setTimeout(loadFrame, 0); });
  host.on("deselect", () => { frameInfo = null; hover = null; paint(); });
  // A board drawn: the selected frame's scene may have just arrived (a selection made before its board loaded).
  host.on("render", (bid) => {
    if (hd || !host.sel) return;
    const b = frameInfo ? frameInfo.board : live() ? live().boardOf(host.sel) : null;
    if (!bid || bid === b) loadFrame();
  });
  host.on("cam", () => { if (hover || into || (dg && dg.target)) paint(); else if (hover === null && painted) paint(); });

  /** The selected frame's spacing areas on screen. */
  function areas() {
    const f = frameInfo;
    if (!f || f.id !== host.sel) return [];
    const r = rectOf(f.id);
    if (!r) return [];
    const n = hd ? hd.node : f.node;
    const kids = [];
    for (const c of f.node.children || []) if (A.inFlow(f.node, c)) { const kr = rectOf(c.id); if (kr) kids.push(kr); }
    return A.spacingAreas(r, A.sides(n.padding), kids, A.layoutOf(f.node), host.cam, typeof n.gap === "number" ? n.gap : 0, !!A.extrasOf(f.node).wrap);
  }
  /** The selected frame's rect on screen (view px), or null. */
  function frameScreen() {
    const fr = frameInfo && rectOf(frameInfo.id), c = host.cam;
    return fr && c ? { x: fr.x * c.z + c.x, y: fr.y * c.z + c.y, w: fr.w * c.z, h: fr.h * c.z } : null;
  }
  const handlesAllowed = () => !!frameInfo && !dg && !(host.isLocked && host.isLocked(frameInfo.id)) && !editingText() && !host.hand && !(host.live && (host.live.busy || host.live.scaleMode)) && !(host.radius && host.radius.active) && !(host.rotate && host.rotate.active);

  let hover = null; // {area, all areas}
  let hd = null; // a handle drag
  let myCursor = "";
  function setCursor(c) {
    if (c) { if (view.style.cursor !== c) view.style.cursor = c; myCursor = c; }
    else if (myCursor) { if (view.style.cursor === myCursor) view.style.cursor = ""; myCursor = ""; }
  }
  view.addEventListener("pointermove", (e) => {
    if (hd) return;
    if (e.buttons || !handlesAllowed()) { if (hover) { hover = null; paint(); } setCursor(""); return; }
    const px = e.clientX - VR.left, py = e.clientY - VR.top;
    const as = areas();
    const fr = rectOf(frameInfo.id), c = host.cam;
    const inside = fr && px >= fr.x * c.z + c.x && py >= fr.y * c.z + c.y && px <= (fr.x + fr.w) * c.z + c.x && py <= (fr.y + fr.h) * c.z + c.y;
    const area = inside ? A.areaUnder(as, px, py) : null;
    const bar = inside ? A.handleUnder(as, px, py, 5, frameScreen()) : null;
    const was = hover;
    // Anywhere inside: every padding zone and gap shows faintly; the one under the pointer is striped.
    hover = inside && as.length ? { area: bar || area, bar: !!bar, areas: as } : null;
    setCursor(bar ? bar.cursor : "");
    const key = (h) => (h ? (h.area ? h.area.kind + ":" + (h.area.side ?? h.area.index) : "-") + (h.bar ? "!" : "") : "");
    if (key(was) !== key(hover)) paint();
  }, { passive: true });
  view.addEventListener("pointerleave", () => { if (hover && !hd) { hover = null; paint(); setCursor(""); } });

  /** A handle's drag (or its click) as it starts: the frame's spacing now, and the area pressed. */
  function handleStart(a, e, px, py) {
    const n = frameInfo.node;
    // Auto gap (space_between / space_around): the handle starts at the gap drawn, and a new value ends Auto.
    const auto = a.kind === "gap" && typeof n.justifyContent === "string" && n.justifyContent.startsWith("space_");
    const gap0 = auto ? Math.round((a.cursor === "ew-resize" ? a.rect.w : a.rect.h) / host.cam.z) : typeof n.gap === "number" ? n.gap : 0;
    return { a, id: frameInfo.id, board: frameInfo.board, cx: e.clientX, cy: e.clientY, moved: false, pad0: A.sides(n.padding), padForm: n.padding, gap0, auto, justify: n.justifyContent, gapFile: n.gap, node: { padding: n.padding, gap: n.gap }, value: a.kind === "pad" ? A.sides(n.padding)[a.side] : gap0, px, py, props: null, sides: a.kind === "pad" ? [a.side] : [] };
  }
  let field = null; // the value field open on the canvas: {id, sides (pads) or null (a gap), a}
  // Option held, a padding area is a handle too (Option+click a padding area types a value for that side and
  // its opposite, Option+Shift+click for all four; a drag from it sets them the same way).
  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.ctrlKey || !view.contains(e.target) || !handlesAllowed()) return;
    const px = e.clientX - VR.left, py = e.clientY - VR.top;
    const as = areas(), fs = frameScreen();
    let a = A.handleUnder(as, px, py, 5, fs);
    if (!a && e.altKey && !e.metaKey && fs && A.inside(fs, px, py, 5)) { const z = A.areaUnder(as, px, py); if (z && z.kind === "pad") a = z; }
    if (!a) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    hd = handleStart(a, e, px, py);
    hover = { area: a, bar: true, areas: areas() };
    if (host.live && host.live.hold) host.live.hold(hd.id); // the preview stays while the pointer rests
    try { view.setPointerCapture(e.pointerId); } catch {}
    paint();
  }, true);
  /** The write a handle at value v makes (padding in the file's form, or the gap). */
  function handleProps(h, v, alt, shift) {
    if (h.a.kind === "gap") return { gap: v };
    const s = h.pad0.slice();
    for (const i of A.sidesFor(h.a.side, alt, shift)) s[i] = v;
    return { padding: A.paddingForm(h.padForm, s) };
  }
  addEventListener("pointermove", (e) => {
    const h = hd;
    if (!h) return;
    e.stopPropagation();
    if (!h.moved && Math.hypot(e.clientX - h.cx, e.clientY - h.cy) < 2) return;
    h.moved = true;
    const snap = host.snap ? host.snap() : {};
    const big = snap.bigNudge || 10;
    // Keys: Shift steps by the big nudge; on a padding Option takes the opposite side too, Option+Shift all four.
    const steps = A.handleSteps(h.a.kind, e.altKey, e.shiftKey);
    const start = h.a.kind === "pad" ? h.pad0[h.a.side] : h.gap0;
    h.value = A.dragValue(h.a, start, e.clientX - h.cx, e.clientY - h.cy, host.cam.z, steps, big, snap.pixel !== false);
    h.props = handleProps(h, h.value, e.altKey, e.shiftKey);
    if (h.a.kind === "pad") h.sides = A.sidesFor(h.a.side, e.altKey, e.shiftKey);
    h.px = e.clientX - VR.left; h.py = e.clientY - VR.top;
    Object.assign(h.node, h.props);
    const L = live();
    if (L) L.edit(h.id, h.props, h.auto ? ["justifyContent"] : [], 0);
    paint();
  }, true);
  addEventListener("pointerup", (e) => {
    const h = hd;
    if (!h) return;
    e.stopPropagation();
    hd = null;
    if (host.live && host.live.unhold) host.live.unhold(h.id);
    if (!h.moved) { openField(h, e.altKey, e.shiftKey); return; }
    if (!A.handleChanged({ pad: h.pad0, gap: h.gap0, auto: h.auto }, h.props)) {
      // Back where it started: nothing to write. The preview goes, as for Esc.
      const L = live();
      if (L && h.props) L.edit(h.id, h.a.kind === "gap" ? (h.auto ? { gap: typeof h.gapFile === "number" ? h.gapFile : 0, justifyContent: h.justify } : { gap: h.gap0 }) : { padding: h.padForm === undefined ? 0 : h.padForm }, [], 0);
      if (host.reloadBoard) host.reloadBoard(h.board);
      paint();
      return;
    }
    commitHandle(h, h.props);
    paint();
  }, true);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && hd) {
      e.preventDefault(); e.stopPropagation();
      const h = hd;
      hd = null;
      const L = live();
      if (L && L.unhold) L.unhold(h.id);
      if (L && h.props) L.edit(h.id, h.a.kind === "gap" ? (h.auto ? { gap: typeof h.gapFile === "number" ? h.gapFile : 0, justifyContent: h.justify } : { gap: h.gap0 }) : { padding: h.padForm === undefined ? 0 : h.padForm }, [], 0);
      if (host.reloadBoard) host.reloadBoard(h.board);
      paint();
    }
  }, true);
  function commitHandle(h, props) {
    if (!props || !A.handleChanged({ pad: h.pad0, gap: h.gap0, auto: h.auto }, props)) return;
    const L = live();
    const op = L ? L.nextOp() : 0;
    const remove = h.auto && props.gap !== undefined ? ["justifyContent"] : [];
    if (L) L.edit(h.id, props, remove, op);
    writes++;
    // Its own gesture id: two drags in quick succession stay two undo steps.
    const gesture = "spacing-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    fetch("/api/update", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id: h.id, props, gesture, ...(remove.length ? { remove } : {}) }) })
      .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); }))
      .then(() => { if (L) L.ack(h.id, op, true); }, (err) => { if (L) L.ack(h.id, op, false); tell("Could not change the spacing: " + err.message); })
      .finally(() => { writes--; if (!writes && host.writesSettled) host.writesSettled(); setTimeout(loadFrame, 50); });
  }
  /** Click on a handle: type the value on the canvas. Enter commits, Esc cancels. */
  function openField(h, alt, shift) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.inputMode = "numeric";
    inp.value = String(h.value);
    inp.setAttribute("aria-label", h.a.kind === "gap" ? "Gap" : "Padding");
    const b = h.a.bar;
    inp.style.cssText = `position:absolute;left:${Math.round(b.x + b.w / 2 - 22)}px;top:${Math.round(b.y + b.h / 2 - 11)}px;width:44px;height:22px;z-index:6;box-sizing:border-box;border:1px solid ${A.PINK};border-radius:4px;background:${A.PINK};color:#fff;font:600 11px/20px system-ui,-apple-system,sans-serif;text-align:center;outline:none;padding:0 2px`;
    let done = false;
    // The sides the value goes to stay striped while the field is open.
    field = { id: h.id, sides: h.a.kind === "pad" ? A.sidesFor(h.a.side, alt, shift) : null, a: h.a };
    paint();
    const end = (ok) => {
      if (done) return;
      done = true;
      field = null;
      paint();
      const v = Number(inp.value.trim());
      inp.remove();
      if (!ok || !Number.isFinite(v)) return;
      const val = h.a.kind === "pad" ? Math.max(0, Math.round(v * 100) / 100) : Math.round(v * 100) / 100;
      if (val === h.value && !(alt)) return;
      commitHandle(h, handleProps(h, val, alt, shift));
    };
    inp.addEventListener("keydown", (k) => { k.stopPropagation(); if (k.key === "Enter") { k.preventDefault(); end(true); } else if (k.key === "Escape") { k.preventDefault(); end(false); } });
    inp.addEventListener("blur", () => end(true));
    for (const n of ["pointerdown", "pointerup", "dblclick"]) inp.addEventListener(n, (k) => k.stopPropagation());
    view.appendChild(inp);
    inp.focus();
    inp.select();
  }

  // Option+double-click a flow child's edge: Fill on that axis. Double-click an auto layout frame's edge: Hug.
  addEventListener("dblclick", (e) => {
    if (!view.contains(e.target) || editingText() || !ev() || !host.live) return;
    const id = host.sel;
    if (!id || isW(id) || id.includes("/") || (host.selection && host.selection().length > 1)) return;
    const r = rectOf(id), c = host.cam;
    if (!r || !c) return;
    const s = { x: r.x * c.z + c.x, y: r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z };
    const hnd = handleAt(s, e.clientX - VR.left, e.clientY - VR.top);
    if (!hnd || hnd.length !== 1) return;
    const axis = hnd === "e" || hnd === "w" ? "width" : "height";
    if (e.altKey) {
      if (!flowPlace([id])) return;
      e.stopImmediatePropagation(); e.preventDefault();
      preview(id, { [axis]: "fill_container" }, { id, axis, mode: "fill", ids: [id] });
      return;
    }
    const L = live(), board = L.boardOf(id), scene = board ? L.sceneOf(board) : null, at = scene ? locate(scene.root, id) : null;
    if (!at || at.node.type !== "frame" || A.layoutOf(at.node) === "none") return;
    e.stopImmediatePropagation(); e.preventDefault();
    preview(id, { [axis]: "fit_content" }, { id, axis, mode: "hug", ids: [id] });
  }, true);
  /** Draw a sizing change now, carried by its write: a refusal takes the drawing back at once. */
  function preview(id, props, body) {
    const L = live();
    const op = L.nextOp();
    L.edit(id, props, [], op);
    runLayoutOp("sizing", body, (ok) => L.ack(id, op, ok));
  }
  // The edge under a point (live-edit.js handleAt), loaded with the logic module's sibling.
  let handleAt = () => null;
  import("/page/live-edit.js").then((m) => { handleAt = m.handleAt; }).catch(() => {});

  // ---------- drawing the overlays ----------
  let painted = false;
  function paint() {
    sizeCanvas();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (painted) ctx.clearRect(0, 0, cv.width, cv.height);
    painted = false;
    if (!host.cam) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = (dg && dg.mode === "out" && dg.target) || (into && into.target);
    if (target && target.id && target.kind !== "canvas") {
      const tr = rectOf(target.id);
      if (tr) {
        const a = toScreen(tr.x, tr.y);
        ctx.strokeStyle = A.BLUE; ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(tr.w * host.cam.z) - 1, Math.round(tr.h * host.cam.z) - 1);
        if (target.kind === "flow") {
          const ln = A.insertionLine(tr, A.sides(target.node.padding), target.rects, target.dir, target.slot, target.wrap, target.line);
          const p0 = toScreen(ln.x0, ln.y0), p1 = toScreen(ln.x1, ln.y1);
          ctx.strokeStyle = A.BLUE; ctx.lineWidth = 2; ctx.lineCap = "round";
          ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        }
        painted = true;
      }
    }
    const fd = field && frameInfo && field.id === frameInfo.id ? field : null;
    const h = hd ? { area: hd.a, areas: areas(), bar: true } : fd ? { area: fd.a, areas: areas(), bar: true } : hover ? { ...hover, areas: areas() } : null;
    if (h && frameInfo && !dg) {
      const pick = (a) => h.area && a.kind === h.area.kind && (a.kind === "gap" ? true : a.side === h.area.side);
      let show = h.area ? h.areas.filter(pick) : [];
      if (hd && hd.a.kind === "pad") show = h.areas.filter((a) => a.kind === "pad" && hd.sides.includes(a.side));
      else if (!hd && fd && fd.sides) show = h.areas.filter((a) => a.kind === "pad" && fd.sides.includes(a.side));
      if (!hd && !fd) {
        // Hovering: every zone faintly, so the frame's spacing reads at a glance, its bar quieter.
        for (const a of h.areas) if (!show.includes(a)) {
          ctx.fillStyle = "rgba(242,74,181,0.07)"; ctx.fillRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
          ctx.fillStyle = "rgba(242,74,181,0.45)"; roundRect(a.bar, 1);
        }
      }
      for (const a of show) stripes(a.rect);
      ctx.fillStyle = A.PINK;
      for (const a of show) roundRect(a.bar, 1);
      if (hd && hd.moved) pill(hd.px + 12, hd.py + 12, String(hd.value));
      painted = true;
    }
  }
  function stripes(r) {
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = "rgba(242,74,181,0.10)"; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = "rgba(242,74,181,0.55)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let s = -r.h; s < r.w + r.h; s += 6) { ctx.moveTo(r.x + s, r.y + r.h); ctx.lineTo(r.x + s + r.h, r.y); }
    ctx.stroke();
    ctx.restore();
  }
  function roundRect(r, rad) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(r.x, r.y, r.w, r.h, rad) : ctx.rect(r.x, r.y, r.w, r.h); ctx.fill(); }
  function pill(x, y, text) {
    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    const w = Math.ceil(ctx.measureText(text).width) + 12;
    ctx.fillStyle = A.PINK;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, 18, 4) : ctx.rect(x, y, w, 18); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(text, x + 6, y + 9.5);
  }

  // ---------- wiring ----------
  const hookUp = () => {
    if (!host.live) { setTimeout(hookUp, 50); return; }
    host.live.onScene((board, scene) => hook(board, scene));
  };
  hookUp();

  host.autolayout = {
    beginDrag, arrow, overInto, dropInto, dropManyInto, runLayoutOp, cancelDrag, keepParent,
    clearInto: () => { forgetMoveScenes(); if (into) { into = null; paint(); } },
    /** Another handle took the pointer (radius.js): the spacing tints go until the next hover. */
    get hovering() { return !!hover; },
    clearHover: () => { if (hover && !hd) { hover = null; setCursor(""); paint(); } },
    pending: () => writes > 0 || arrowsOut > 0,
    get dragging() { return !!dg; },
    get state() { return dg ? { mode: dg.mode, slot: dg.slot, target: dg.target ? { kind: dg.target.kind, id: dg.target.id, slot: dg.target.slot } : null, ids: dg.ids.slice(), moved: dg.moved, drawn: dg.drawn || null } : null; },
    get hover() { return hover && hover.area ? { kind: hover.area.kind, side: hover.area.side, bar: hover.bar } : null; },
    /** A spacing handle is being dragged (radius.js keeps its corner handles away meanwhile). */
    get handleActive() { return !!hd; },
    /** The selected auto layout frame's spacing areas and their bars, in view px (QA finds the handles with it). */
    spacingAreas: () => areas().map((x) => ({ kind: x.kind, side: x.side, index: x.index, rect: x.rect, bar: x.bar })),
    stats: () => Object.assign({}, stats),
  };
}
