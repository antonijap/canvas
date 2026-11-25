// Live edits and resize handles on the canvas page. Runs next to widgets.js on window.canvasHost, with the
// engine renderer only (the DOM fallback redraws from the server as before).
//
// Every edit is drawn in the next frame, before the file has it: the inspector (the shell sends
// {cmd: "edit", id, props, remove, op} before its write, and {preview: true} at display rate while a field is
// scrubbed), undo and redo (the history event says what the next step will write), board and layer resizes,
// and "Resize to fit content". The model, and when an override lets go, is in src/page/live-edit.js.
//
// Resize: a selected board, frame or shape shows resize cursors on its edges and corners. Drag to
// resize at display rate (the engine lays out that one board per frame); Shift keeps the aspect ratio (a layer with
// Lock aspect ratio on keeps it unless Control is held), Option
// resizes about the centre, edges snap to the same guides a move uses, sizes land on whole px, Cmd keeps an
// absolutely placed child where it is on the canvas when the left or top edge moves. One write on release, one
// undo step. Double-click an edge to fit that side to the content; Opt+Cmd+Shift+R fits all four.
//
// Scale, K: in scale mode (a "Scale" badge, filled handles) a handle drag scales the selection and
// everything inside it from the opposite side (Option: the centre; the aspect ratio always holds): sizes,
// positions, type, strokes, radii, effects, padding and gap (src/page/scale.js). The drag scales the board's
// cached scene at display rate, the same math the server writes with; one write on release (/api/scale), one
// undo step. Esc cancels a drag; K or V (or Esc) leaves the mode. The inspector's Scale field sends {cmd:"scale"}.

import { LiveEdits, PAGE_OPS, covers, prepareEdit, findNode, CURSOR, handleAt, resizeRect, edgeSnapper, snapTurnedHandle, resizeGuides, boundsOf, fitRect, resizeWrites, textResizeWrites, flipWrites, rotatedResizeRect, rotatedTextWrites, keepsRatio as ratioKept } from "/page/live-edit.js";
import { scaleDrag, scaleRectAbout, scaleScene, ANCHORS, r2 } from "/page/scale.js";
import { clampResize, minSize, sides } from "/page/autolayout-logic.js";
import { rotateVec, rotatedResize, rotatedCursor, turnedGroupSize } from "/page/move-logic.js";
import { applyPeerPreviews } from './presence-client.js';

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, file } = host;
  const edits = new LiveEdits({ now: () => performance.now() });
  let peerPreviews = [], peerKey = '';
  const dirty = new Set();
  let localOp = PAGE_OPS; // the page's own writes; the shell numbers its writes from 1
  const nextOp = () => ++localOp;
  const stats = { installs: 0, lastMs: 0, maxMs: 0, skipped: 0 };
  let lastCost = 0, lastAt = 0;

  const ev = () => (host.renderer === "engine" ? host.engineView : null);
  const boardOf = (id) => (host.boards.has(id) ? id : ev() ? ev().boardOf(id) : null);
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };

  // ---------- drawing the overrides ----------
  const fetching = new Set();
  // Boards whose scene the engine view fetched but would not keep (too large for its cache): asking again every
  // frame of a live edit fetched the whole scene again each time. They wait a while; the server's redraw shows the edit.
  const uncached = new Map(); // board id -> until (ms)
  const UNCACHED_MS = 10000;
  /** Bring a board's scene into the engine view's cache; draw its overrides when it lands. */
  function fetchScene(board) {
    const v = ev();
    if (!v || fetching.has(board) || (uncached.get(board) || 0) > performance.now()) return;
    fetching.add(board);
    v.fetchScene(board).then((ok) => {
      fetching.delete(board);
      if (ok && v.sceneText(board) === null) { uncached.set(board, performance.now() + UNCACHED_MS); return; }
      if (ok && (edits.has(board) || pins.has(board))) { markDirty(board); host.requestFrame(); }
    });
  }
  // Which layers changed on each dirty board since the engine drew it last (null: anything may have, so the whole
  // board is laid out again). A few layers whose parent places them freely are laid out alone (engine updateNode).
  const touched = new Map(); // board id -> Set(node id) | null
  function markDirty(board, id) {
    const had = dirty.has(board);
    dirty.add(board);
    if (id === undefined || id === null) { touched.set(board, null); return; }
    const t = touched.get(board);
    if (!had && t === undefined) touched.set(board, new Set([id]));
    else if (t) t.add(id);
    else if (t === undefined) touched.set(board, null);
  }
  /** Runs in the page's frame, before the engine draws: each edited board gets its server scene plus overrides. */
  function flush() {
    if (!dirty.size) return;
    const v = ev();
    if (!v) { dirty.clear(); touched.clear(); return; }
    // A board that takes longer than a frame to lay out is drawn every other frame or so, not every frame.
    if (lastCost > 12 && performance.now() - lastAt < lastCost * 1.5) { stats.skipped++; host.requestFrame(); return; }
    let sized = false;
    for (const board of [...dirty]) {
      dirty.delete(board);
      const only = touched.get(board);
      touched.delete(board);
      if (!host.boards.has(board)) { edits.drop(board); continue; }
      const text = v.sceneText(board);
      if (text === null) { fetchScene(board); continue; }
      const t0 = performance.now();
      let scene;
      try { scene = JSON.parse(text); } catch { continue; }
      applyPeerPreviews(scene.root, peerPreviews);
      edits.apply(board, scene);
      applyPins(board, scene);
      // A hook that returns true changed the scene beyond the touched layers (autolayout's drag overlay).
      let hooked = false;
      for (const f of sceneHooks) { try { if (f(board, scene) === true) hooked = true; } catch (err) { console.error(err); } }
      // A resize, a padding drag, typed text: the touched layers alone, when the engine can (else the whole board).
      let alone = !!(only && only.size && only.size <= 8 && !hooked && v.updateNode);
      if (alone) for (const id of only) { const n = id === board ? null : findNode(scene.root, id); if (!n || !v.updateNode(board, id, n)) { alone = false; break; } }
      const root = alone ? null : v.install(board, scene);
      lastAt = performance.now();
      lastCost = lastAt - t0;
      stats.installs++; stats.lastMs = Math.round(lastCost * 10) / 10; stats.maxMs = Math.max(stats.maxMs, stats.lastMs);
      if (root) { host.boardSized(board, root.w, root.h); sized = true; }
      else if (alone) {
        // The board keeps its size; as after a whole layout, the overlays follow the layers that moved.
        const r = host.worldRectOf(board);
        if (r) host.boardSized(board, r.w, r.h);
        sized = true;
      }
    }
    if (sized) host.syncSel();
  }

  // ---------- pinned overrides ----------
  // Held by a gesture that has no write yet and no time limit: the text being typed (src/page/text-edit.js) draws
  // its content on the canvas while the edit is open. They sit on top of every scene, the server's and the page's,
  // until the gesture lets go (unpin); a commit turns them into an ordinary override with a write (override).
  const pins = new Map(); // board id -> Map(node id -> props)
  const sceneHooks = []; // f(board, scene): a scene about to be drawn, live edits and pins on it
  const under = new Map(); // node id -> the pinned props as the scene under the pin had them, last drawn
  function applyPins(board, scene) {
    const b = pins.get(board);
    if (!b || !scene || !scene.root) return false;
    let changed = false;
    for (const [id, props] of b) {
      const node = findNode(scene.root, id);
      if (!node) continue;
      const was = {};
      for (const k of Object.keys(props)) was[k] = node[k];
      under.set(id, was);
      for (const [k, v] of Object.entries(props)) if (node[k] !== v) { node[k] = v; changed = true; }
    }
    return changed;
  }
  /** What the scene holds under a pin (an agent's write to the text being typed shows up here), or null. */
  const underPin = (id) => under.get(id) || null;
  function pin(id, props) {
    const board = boardOf(id);
    if (!board) return false;
    let b = pins.get(board);
    if (!b) pins.set(board, (b = new Map()));
    b.set(id, Object.assign({}, props));
    markDirty(board, id);
    host.requestFrame();
    return true;
  }
  function unpin(id) {
    under.delete(id);
    for (const [board, b] of pins) {
      if (!b.delete(id)) continue;
      if (!b.size) pins.delete(board);
      markDirty(board, id);
      host.requestFrame();
    }
  }
  /** An override the page writes itself (a committed text edit): drawn now, settled by ack(id, op, ok) like any write. */
  function override(id, props, op, remove = []) {
    note(id, props, remove, op);
    const board = boardOf(id);
    if (!board || !ev()) return false;
    edits.set(board, id, props, remove, op);
    markDirty(board, id);
    host.requestFrame();
    armExpiry();
    return true;
  }

  // ---------- what the inspector shows ----------
  // The raw values (tokens unresolved) of edits the file does not have yet, per node, oldest first: the page puts
  // them on the file's answer before the app's inspector shows it (src/server.ts postSel), so after an undo, during
  // a resize or while an inspector write is in flight it never shows older numbers. A preview (op 0) replaces the
  // node's last preview and lets go after PREVIEW_MS; a write's values stay until a node read made after its answer
  // has them, or ACK_MS after it (HOLD_MS when it never answers).
  const notes = new Map(); // node id -> [{props, remove, op, ack, t}]
  const NOTE_PREVIEW_MS = 2000, NOTE_ACK_MS = 3000, NOTE_HOLD_MS = 10000;
  function note(id, props, remove, op = 0, show = true) {
    if (typeof id !== "string") return;
    if (notes.size > 100) for (const k of [...notes.keys()]) overlay(k, 0); // let go of old notes of nodes nobody looked at
    let list = notes.get(id);
    if (!list) notes.set(id, (list = []));
    if (!op) { const i = list.findIndex((e) => !e.op); if (i >= 0) list.splice(i, 1); }
    list.push({ props: Object.assign({}, props || {}), remove: (remove || []).slice(), op, ack: 0, t: performance.now() });
    if (show && host.selectionEdited) host.selectionEdited(id);
  }
  function noteAck(id, op, ok) {
    const list = notes.get(id);
    if (!list) return;
    const t = performance.now();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!covers(op, e.op) || e.ack) continue;
      if (ok) e.ack = t; else list.splice(i, 1);
    }
    if (!list.length) notes.delete(id);
    if (!ok && host.selectionEdited) host.selectionEdited(id);
  }
  /** Keep a node's preview (op 0) alive while its gesture is held. */
  function touchNote(id) {
    const list = notes.get(id);
    if (list) for (const e of list) if (!e.op) e.t = performance.now();
  }
  /** Drop a node's preview (a cancelled drag). */
  function noteForget(id) {
    const list = notes.get(id);
    if (!list) return;
    const i = list.findIndex((e) => !e.op);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) notes.delete(id);
    if (host.selectionEdited) host.selectionEdited(id);
  }
  /** The edits to show on a node read that was asked for at `fetchedAt`. */
  function overlay(id, fetchedAt) {
    const list = notes.get(id);
    if (!list) return [];
    const t = performance.now();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.ack ? t - e.ack > NOTE_ACK_MS : e.op ? t - e.t > NOTE_HOLD_MS : t - e.t > NOTE_PREVIEW_MS) list.splice(i, 1);
    }
    if (!list.length) { notes.delete(id); return []; }
    return list.filter((e) => !e.ack || e.ack > fetchedAt);
  }

  /**
   * Draw an edit of one node now. op: the write that carries it (0: a preview). False when the page cannot draw
   * it (no engine, a token it cannot resolve, a font or image change, a layer inside an instance): the
   * server's redraw shows it then.
   */
  function edit(id, props, remove, op = 0, show = true) {
    note(id, props, remove, op, show);
    const v = ev();
    if (!v || typeof id !== "string" || id.includes("/") || id.startsWith("widget:")) return false;
    const board = boardOf(id);
    if (!board || !host.boards.has(board) || !v.isLoaded(board)) return false;
    const isBoard = board === id;
    const doc = host.doc || {};
    const p = prepareEdit(props, remove, { vars: doc.variables, themes: doc.themes, board: isBoard, instance: host.isCmp(id) });
    if (!p.ok) return false;
    if (p.pos) {
      const b = host.boards.get(board);
      // Where it was, so a write that fails puts it back (a move is not a scene override).
      const was = moved.get(board);
      moved.set(board, { x: was ? was.x : b.meta.x, y: was ? was.y : b.meta.y, op });
      host.placeBoard(board, p.pos.x ?? b.meta.x, p.pos.y ?? b.meta.y);
    }
    if (Object.keys(p.props).length || p.remove.length) {
      edits.set(board, id, p.props, p.remove, op);
      // A layer moved inside a frame that places it freely: the engine moves it without laying the board out again
      // (engine moveNode). Only when the drawing is the scene with every edit on it (no full layout due, no pin).
      // A drag on a 1,300-node board laid the whole board out every frame (8 to 12 ms of a 16.7 ms frame).
      if (!isBoard && !dirty.has(board) && !pins.has(board) && !p.remove.length && movesOnly(p.props) && v.moveNode && moveInEngine(v, board, id, p.props)) {
        // As after a whole layout: the board keeps its size, the overlays follow.
        const r = host.worldRectOf(board);
        if (r) host.boardSized(board, r.w, r.h);
        host.syncSel();
        host.requestFrame();
        armExpiry();
        return true;
      }
      markDirty(board, id);
      host.requestFrame();
      armExpiry();
    }
    return true;
  }
  const movesOnly = (props) => { const k = Object.keys(props); return k.length > 0 && k.every((x) => (x === "x" || x === "y") && typeof props[x] === "number" && Number.isFinite(props[x])); };
  /** x and y the engine holds for the layer are the scene's with its edits; both are needed for moveNode. */
  function moveInEngine(v, board, id, props) {
    if (props.x !== undefined && props.y !== undefined) return v.moveNode(board, id, props.x, props.y);
    const text = v.sceneText(board);
    if (text === null) return false;
    let scene;
    try { scene = JSON.parse(text); } catch { return false; }
    edits.apply(board, scene);
    const n = findNode(scene.root, id);
    if (!n) return false;
    const x = props.x ?? n.x ?? 0, y = props.y ?? n.y ?? 0;
    return typeof x === "number" && typeof y === "number" && v.moveNode(board, id, x, y);
  }

  /** A write answered. ok false: its overrides go and the server's scene shows again. */
  const confirmT = new Map();
  const moved = new Map(); // board id -> {x, y, op}: where an edit moved it from, until its write answers
  function ack(id, op, ok) {
    noteAck(id, op, ok);
    const m = moved.get(id);
    if (m && covers(op, m.op)) { moved.delete(id); if (!ok) host.placeBoard(id, m.x, m.y); }
    const touched = edits.ack(id, op, ok);
    for (const b of touched) { if (!ok) markDirty(b); confirm(b); }
    // An edit the page could not draw: fetch the board now instead of waiting for the file watcher.
    if (!touched.length && ok) { const b = boardOf(id); if (b) confirm(b); }
    if (!ok) host.requestFrame();
  }
  /** Ask for a board's scene once nothing on it waits for a write: it drops the acknowledged overrides (or shows what the server made of them). */
  function confirm(board) {
    if (edits.pending(board) || confirmT.has(board)) return;
    confirmT.set(board, setTimeout(() => { confirmT.delete(board); host.reloadBoard(board); }, 0));
  }

  // Layers a move drag is carrying (src/server.ts): their position previews stay while the pointer is down.
  const held = new Set();
  let expT = 0;
  function armExpiry() {
    if (expT) return;
    expT = setInterval(() => {
      // A resize or scale held still (pointer down, not moving) keeps its preview: only an abandoned one lets go.
      if (rz && rz.moved) { edits.touch(rz.board); touchNote(rz.id); }
      if (sc && sc.drag) for (const it of sc.items) { edits.touch(it.board); if (sc.items.length === 1) touchNote(it.id); }
      for (const id of held) { const b = boardOf(id); if (b) edits.touch(b); touchNote(id); }
      for (const b of edits.expire()) { markDirty(b); host.reloadBoard(b); }
      if (dirty.size) host.requestFrame();
      if (!edits.size) { clearInterval(expT); expT = 0; }
    }, 250);
  }

  // ---------- undo / redo ----------
  /**
   * Before an undo or redo goes to the server: draw what it will write, from the history event's peek at the
   * step. All or nothing (a step the page cannot fully draw waits for the server). Returns what the request
   * needs: the step it expects on top (the server refuses with code "moved" when another one got there first).
   */
  function historyStart(dir, h) {
    const pk = h && h.peek && h.peek[dir];
    if (!pk) return null;
    h.peek[dir] = null; // used once: a second press before the next history event goes the plain way
    const doc = host.doc || {};
    const v = ev();
    const ok = !!v && pk.nodes.every((n) => {
      const board = boardOf(n.id);
      if (!board || !host.boards.has(board) || !v.isLoaded(board)) return false;
      return prepareEdit(n.set, n.remove, { vars: doc.variables, themes: doc.themes, board: board === n.id, instance: host.isCmp(n.id) }).ok;
    });
    const op = nextOp();
    // The inspector shows the step now even when the canvas waits for the server to draw it.
    if (!ok) {
      for (const n of pk.nodes) note(n.id, n.set, n.remove, op);
      return { expect: pk.seq, done: (good) => { for (const n of pk.nodes) noteAck(n.id, op, good); } };
    }
    for (const n of pk.nodes) edit(n.id, n.set, n.remove, op);
    return { expect: pk.seq, done: (good) => { for (const n of pk.nodes) ack(n.id, op, good); } };
  }

  // ---------- resize ----------
  let VR = view.getBoundingClientRect();
  addEventListener("resize", () => { VR = view.getBoundingClientRect(); });
  host.on("cmd", (c) => { if (c.cmd === "insets") VR = view.getBoundingClientRect(); });

  // What the selection is, from its board's scene: type, rotation, layout, absolutely placed children.
  let info = null;
  async function loadInfo(id) {
    const turnedBefore = !!(info && info.id === id && info.rotation);
    info = null;
    const v = ev();
    if (!v || !id || id.startsWith("widget:") || id.includes("/")) return;
    const board = boardOf(id);
    if (!board) return;
    let text = v.sceneText(board);
    if (text === null) {
      if ((uncached.get(board) || 0) > performance.now()) return;
      await v.fetchScene(board);
      text = v.sceneText(board);
      if (text === null) uncached.set(board, performance.now() + UNCACHED_MS);
    }
    if (text === null || host.sel !== id) return;
    info = readResizeInfo(id, board, text);
    // A rotated layer's selection box turns with it: draw it again now that its turn and size are known.
    if ((info?.rotation || turnedBefore) && host.syncSel) host.syncSel();
  }
  function readResizeInfo(id, board, text) {
    if (text === null) return null;
    let scene;
    try { scene = JSON.parse(text); } catch { return null; }
    edits.apply(board, scene); // what the canvas draws: a rotation or resize not yet in the file included
    const placement = placeIn(scene.root, id);
    if (!placement) return null;
    const n = placement.node;
    const layout = n.type === "group" ? "none" : typeof n.layout === "string" ? n.layout : n.type === "frame" ? "horizontal" : "none";
    const kids = (Array.isArray(n.children) ? n.children : [])
      .filter((k) => k && typeof k.id === "string" && !k.id.includes("/") && (layout === "none" || k.layoutPosition === "absolute"))
      .map((k) => ({ id: k.id, x: typeof k.x === "number" ? k.x : 0, y: typeof k.y === "number" ? k.y : 0 }));
    const all = (Array.isArray(n.children) ? n.children : []).map((k) => k && k.id).filter(Boolean);
    return { id, board, isBoard: board === id, type: n.type, rotation: Number(n.rotation) || 0, layout, kids, all, textGrowth: n.textGrowth, autoHeight: n.autoHeight, w: n.width, h: n.height, lockAspect: n.lockAspect === true, min: layout !== "none" ? minSize(sides(n.padding)) : null, flipX: !!n.flipX, flipY: !!n.flipY, ext: n.type === "group" ? turnedGroupSize(scene.root, id, (x) => host.worldRectOf(x)) : null,
      positioned: placement.positioned, own: { x: Number(n.x) || 0, y: Number(n.y) || 0 } };
  }
  host.on("select", (id) => { loadInfo(id); });
  host.on("deselect", () => { info = null; setCursor(""); });
  host.on("render", (bid) => {
    if (info) { if ((!bid || bid === info.board) && host.sel === info.id) loadInfo(info.id); return; }
    // A hidden layer is not in its board's scene, so selecting it loads nothing. Shown again (Shift+Cmd+H, an undo)
    // while still selected, its board draws it: load it now, or its handles would not grab and a press would move it.
    const id = host.sel, b = id && !id.startsWith("widget:") ? boardOf(id) : null;
    if (b && (!bid || bid === b)) loadInfo(id);
  });

  const resizable = () => {
    const id = host.sel;
    // Several selected: the box is their union, which a drag moves (the page); one layer's edges must not grab.
    const many = host.selection && host.selection().length > 1;
    return !!(ev() && info && info.id === id && info.type !== "group" && info.type !== "sticker" && (!info.rotation || turned()) && !host.hand && !many && !(host.textEdit && host.textEdit.active) && !(host.isLocked && host.isLocked(id)));
  };
  /**
   * A rotated layer's own box, {r, w, h} (degrees, world px), or null: the selection box and handles turn with it.
   * Its sizes must be numbers (a rotated text that sizes itself has no box to grab); boards never turn.
   */
  function turned() {
    if (!info || info.id !== host.sel || !info.rotation || info.isBoard) return null;
    // A turned group's box is its layers' extent, turned with it (it has no handles: resizable).
    if (info.type === "group") return info.ext ? { r: info.rotation, w: info.ext.w, h: info.ext.h } : null;
    if (typeof info.w !== "number") return null;
    // Auto height text: its height as drawn, from the turned box on the canvas (its width is its own; a stored
    // height is not what shows).
    if ((info.type === "text" && info.textGrowth === "fixed-width") || (info.type === "sticky" && info.autoHeight !== false)) {
      const h = ownHeight(info.rotation, info.w, host.worldRectOf(info.id));
      return h ? { r: info.rotation, w: info.w, h } : null;
    }
    if (typeof info.h !== "number") return null;
    return { r: info.rotation, w: info.w, h: info.h };
  }
  /** The own height of a box `w` wide turned by r degrees whose bounding box on the canvas is `b`. */
  function ownHeight(r, w, b) {
    if (!b) return null;
    const t = (r * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
    const h = c >= s ? (b.h - w * s) / c : (b.w - w * c) / s; // the better conditioned axis
    return Number.isFinite(h) && h > 0 ? h : null;
  }
  /** The selected layer's turned box as it shows now (a resize or rotate drag in progress included), for the page's selection box. */
  function shapeOf(id) {
    if (rz && rz.rot !== undefined && rz.id === id) return { r: rz.rot, w: rz.r.w, h: rz.r.h };
    const rs = host.rotate && host.rotate.shape ? host.rotate.shape() : null;
    if (rs && rs.id === id) return rs.r ? { r: rs.r, w: rs.w, h: rs.h } : null;
    if (rz && rz.id === id) return null;
    return info && info.id === id ? turned() : null;
  }
  /** The selection's rect on screen (view px) and in the world. */
  function selRects() {
    const w = host.worldRectOf(host.sel), c = host.cam;
    if (!w || !c) return null;
    return { w, s: { x: w.x * c.z + c.x, y: w.y * c.z + c.y, w: w.w * c.z, h: w.h * c.z } };
  }
  /** A view point in a turned layer's frame: the box centred on 0,0, at screen scale. */
  function turnedPoint(sh, r, px, py) {
    const cx = r.s.x + r.s.w / 2, cy = r.s.y + r.s.h / 2;
    return rotateVec(px - cx, py - cy, sh.r);
  }
  const handleFor = (e) => {
    if (host.readOnly) return null;
    if (!resizable()) return null;
    const r = selRects();
    if (!r) return null;
    const sh = turned();
    if (sh) {
      const z = host.cam.z, p = turnedPoint(sh, r, e.clientX - VR.left, e.clientY - VR.top);
      return handleAt({ x: -sh.w * z / 2, y: -sh.h * z / 2, w: sh.w * z, h: sh.h * z }, p.x, p.y);
    }
    return handleAt(r.s, e.clientX - VR.left, e.clientY - VR.top);
  };
  const cursorOf = (h) => { const sh = turned(); return (sh && rotatedCursor(h, sh.r)) || CURSOR[h]; };

  let cursor = "";
  function setCursor(c) { if (c === cursor) return; cursor = c; view.style.cursor = c; }
  view.addEventListener("pointermove", (e) => {
    if (rz || scaleMode) return;
    if (e.buttons) { if (cursor) setCursor(""); return; }
    const h = handleFor(e);
    setCursor(h ? cursorOf(h) : "");
  }, { passive: true });
  view.addEventListener("pointerleave", () => { if (!rz) setCursor(""); });

  let rz = null; // the resize in progress
  const positioned = (id) => {
    if (host.boards.has(id)) return { ok: true, own: { x: host.boards.get(id).meta.x, y: host.boards.get(id).meta.y } };
    const m = host.moveInfo(id);
    return { ok: !!m && m.mode === "absolute", own: m ? { x: m.x || 0, y: m.y || 0 } : { x: 0, y: 0 } };
  };
  addEventListener("pointerdown", (e) => {
    if (scaleMode || e.button !== 0 || e.ctrlKey || !view.contains(e.target)) return;
    const h = handleFor(e);
    if (!h) return;
    e.stopPropagation(); // the page's own pan, move and select handlers never see this press
    e.preventDefault();
    const r = selRects();
    const pos = positioned(info.id);
    const sh = turned();
    // A turned layer resizes in its own frame: its box about its centre, along its own axes (rotatedResize).
    const r0 = sh ? { x: -sh.w / 2, y: -sh.h / 2, w: sh.w, h: sh.h } : r.w;
    rz = {
      id: info.id, board: info.board, isBoard: info.isBoard, h, r0, r: r0, cx: e.clientX, cy: e.clientY, moved: false,
      index: host.snapIndex(info.isBoard ? "board" : "node", info.id), info, own: pos.own, positioned: pos.ok, keep: false, touched: new Set(),
      ...(sh ? { rot: sh.r, center: { x: r.w.x + r.w.w / 2, y: r.w.y + r.w.h / 2 } } : {}),
    };
    try { view.setPointerCapture(e.pointerId); } catch {}
    setCursor(cursorOf(h));
  }, true);
  // Lock aspect ratio: a locked layer keeps its ratio unless Control is held; an unlocked one while Shift is.
  const keepsRatio = (e) => ratioKept(!!(rz && rz.info.lockAspect), e);
  addEventListener("pointermove", (e) => {
    if (!rz) return;
    e.stopPropagation();
    const c = host.cam;
    const dx = (e.clientX - rz.cx) / c.z, dy = (e.clientY - rz.cy) / c.z;
    if (!rz.moved && Math.hypot(e.clientX - rz.cx, e.clientY - rz.cy) < 2) return;
    rz.moved = true;
    const snap = host.snap();
    if (rz.rot !== undefined) {
      // For a turned layer, align the moving handle to the blueprint in world space before converting its delta.
      const spacing = host.blueprintSpacing(e), delta = rotateVec(dx, dy, rz.rot);
      const d = spacing ? snapTurnedHandle(rz.r0, rz.center, rz.h, rz.rot, delta, spacing, 6 / c.z) : delta;
      // An auto layout frame stops at its padding here too; rounding takes from the dragged side.
      const r = rotatedResizeRect(rz.r0, rz.h, d.x, d.y, { shift: keepsRatio(e), alt: e.altKey, pixel: snap.pixel && !spacing && !host.blueprintBypass(e), min: rz.info.min });
      if (!r) return;
      rz.r = r;
      showResize(0);
      flush();
      if (host.syncSel) host.syncSel();
      return;
    }
    // Control held: no snapping to objects for this drag.
    const objects = snap.objects && !e.ctrlKey && !host.blueprintBypass(e);
    let r = resizeRect(rz.r0, rz.h, dx, dy, { shift: keepsRatio(e), alt: e.altKey, round: snap.pixel && !host.blueprintBypass(e), snap: edgeSnapper(objects ? rz.index : null, c.z, undefined, host.blueprintSpacing(e)) });
    if (rz.info.min) r = clampResize(r, rz.r0, rz.h, rz.info.min); // an auto layout frame stops at its padding
    rz.r = r;
    rz.keep = e.metaKey;
    showResize(0);
    flush(); // pointer moves arrive once per frame: lay the board out now, the frame that follows draws it
    host.paintGuides(objects ? resizeGuides(rz.index, r) : []);
  }, true);
  addEventListener("pointerup", (e) => { if (rz) { e.stopPropagation(); endResize(false); } }, true);
  addEventListener("pointercancel", (e) => { if (rz) { e.stopPropagation(); endResize(true); } }, true);
  addEventListener("keydown", (e) => {
    if (rz && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endResize(true); return; }
    // Resize to fit: Opt+Cmd+Shift+R.
    if (e.code === "KeyR" && e.altKey && e.metaKey && e.shiftKey && !e.ctrlKey) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      if (host.sel && host.isLocked && host.isLocked(host.sel)) return; // locked: no resize from a canvas key
      fitContent("all");
    }
  }, true);
  // Double-click on an edge: fit that side to the content.
  addEventListener("dblclick", (e) => {
    if (!view.contains(e.target)) return;
    const h = handleFor(e);
    if (!h) return;
    e.stopPropagation();
    e.preventDefault();
    fitContent(h);
  }, true);

  /** The writes for the resize as it stands: the node's props, and its children's when Cmd keeps them in place. */
  function writesOf(z) {
    if (z.rot !== undefined) {
      // A turned layer: its new size, and x/y so the sides it was not dragged by stay put (move-logic.js rotatedResize).
      const p = rotatedResize(z.own, z.r0.w, z.r0.h, z.rot, z.r, z.info.flipX, z.info.flipY);
      const props = { width: p.width, height: p.height };
      if (z.positioned) { props.x = p.x; props.y = p.y; }
      // A side drag keeps Auto height; auto width becomes Fixed size, like the upright resize (textResizeWrites).
      if (z.info.type === "text") rotatedTextWrites(props, z.h, z.info.textGrowth);
      return { props, children: [] };
    }
    // info.kids holds the children with a place of their own: all of a free frame's, an auto-layout frame's absolute ones.
    const w = resizeWrites(z.r0, z.r, { positioned: z.positioned, own: z.own, keepChildren: z.keep, kids: z.info.kids });
    // A text box resized by hand becomes Fixed size; a side drag on Auto height text keeps Auto height.
    if (z.info.type === "text") textResizeWrites(w, z.h, z.info.textGrowth, z.r, z.r0);
    // An edge dragged past the opposite one mirrors the layer; a flipped layer's x/y is its far corner.
    if (z.r.flipX || z.r.flipY || z.info.flipX || z.info.flipY) flipWrites(w, z.r0, z.r, { flipX: z.info.flipX, flipY: z.info.flipY, positioned: z.positioned, own: z.own });
    return w;
  }
  /** Draw the resize as it stands (op 0 while dragging). */
  function showResize(op, z = rz) {
    if(!op) host.emit('presence', { preview:{kind:'resize',ids:[z.id],dx:z.r.x-z.r0.x,dy:z.r.y-z.r0.y,dw:z.r.w-z.r0.w,dh:z.r.h-z.r0.h} });
    const w = writesOf(z);
    const scene = Object.assign({}, w.props);
    if (z.isBoard) { delete scene.x; delete scene.y; host.placeBoard(z.board, z.r.x, z.r.y); }
    // Children Cmd moved and then let go of go back to where the file has them.
    const kidsNow = new Map(w.children.map((k) => [k.id, k]));
    for (const id of z.touched) if (!kidsNow.has(id)) { const k = z.info.kids.find((x) => x.id === id); if (k) edits.set(z.board, id, { x: k.x, y: k.y }, [], op); }
    for (const k of w.children) { edits.set(z.board, k.id, { x: k.x, y: k.y }, [], op); z.touched.add(k.id); }
    // A side dragged back to where it started leaves the writes: its earlier preview goes, or the old size stays drawn.
    const shown = z.shown || (z.shown = new Set());
    edits.unset(z.board, z.id, [...shown].filter((k) => !(k in scene)), op);
    for (const k of Object.keys(scene)) shown.add(k);
    if (Object.keys(scene).length) edits.set(z.board, z.id, scene, [], op);
    note(z.id, w.props, w.remove || [], op);
    markDirty(z.board, z.id);
    host.requestFrame();
    armExpiry();
    return w;
  }
  function endResize(cancel) {
    host.presence?.end();
    const z = rz;
    rz = null;
    host.clearGuides();
    setCursor("");
    if (!z || !z.moved) return;
    if (cancel || (z.r.x === z.r0.x && z.r.y === z.r0.y && z.r.w === z.r0.w && z.r.h === z.r0.h && !z.r.flipX && !z.r.flipY)) {
      edits.forget(z.board, [z.id, ...z.touched]);
      noteForget(z.id);
      if (z.isBoard) host.placeBoard(z.board, z.r0.x, z.r0.y);
      markDirty(z.board);
      host.reloadBoard(z.board);
      host.requestFrame();
      return;
    }
    const op = nextOp();
    rz = z; // showResize reads it
    const w = showResize(op);
    rz = null;
    send(z, w, op, "Resize");
  }

  /** One write for a resize or a fit: the node and its children together, one undo step. */
  function send(z, w, op, label) {
    const ids = [z.id, ...w.children.map((k) => k.id), ...z.touched];
    fetch("/api/resize", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id: z.id, props: w.props, remove: w.remove || [], children: w.children, label }) })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(() => { for (const id of new Set(ids)) ack(id, op, true); })
      .catch((err) => {
        for (const id of new Set(ids)) ack(id, op, false);
        if (z.isBoard) host.placeBoard(z.board, z.r0.x, z.r0.y);
        tell("Could not resize: " + err.message);
      });
  }

  /** Resize to fit content: all four sides, or one ("n" "e" "s" "w"; a corner fits its two). */
  function fitContent(side = "all", id = host.sel) {
    const v = ev(), board = id && boardOf(id);
    if (!v || !board || rz) return;
    const fit = info?.id === id ? info : readResizeInfo(id, board, v.sceneText(board));
    if (!fit) { tell("Select a frame to fit"); return; }
    if (fit.rotation) { tell("Fitting a rotated layer is not supported yet"); return; }
    const r0 = host.worldRectOf(id);
    if (!r0) return;
    const pos = fit.isBoard ? positioned(id) : { own: fit.own, ok: fit.positioned };
    const z = { id, board: fit.board, isBoard: fit.isBoard, r0, r: r0, info: fit, own: pos.own, positioned: pos.ok, keep: true, touched: new Set() };
    const op = nextOp();
    if (fit.type === "text") {
      edit(id, { textGrowth: "auto" }, ["width", "height"], op);
      postUpdate(id, { textGrowth: "auto" }, ["width", "height"], op);
      return;
    }
    if (fit.layout !== "none") {
      // Auto layout sizes itself: hug the content on the axes asked for.
      const props = {};
      if (side === "all" || /[ew]/.test(side)) props.width = "fit_content";
      if (side === "all" || /[ns]/.test(side)) props.height = "fit_content";
      edit(id, props, [], op);
      postUpdate(id, props, [], op);
      return;
    }
    const c = boundsOf(fit.all.map((k) => host.worldRectOf(k)));
    if (!c) { tell("Nothing inside to fit"); return; }
    z.r = fitRect(r0, c, side);
    if (z.r.x === r0.x && z.r.y === r0.y && z.r.w === r0.w && z.r.h === r0.h) return;
    const w = showResize(op, z);
    send(z, w, op, "Resize to Fit");
  }
  function postUpdate(id, props, remove, op) {
    fetch("/api/update", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id, props, remove }) })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); }))
      .then(() => ack(id, op, true), (err) => { ack(id, op, false); tell("Could not fit: " + err.message); });
  }

  // ---------- scale (K) ----------
  let scaleMode = false;
  let sc = null; // the scale in progress (a drag, or an inspector Scale between its preview and its answer's send)
  const selBox = document.getElementById("sel");
  let badge = null;
  (() => {
    const st = document.createElement("style");
    st.textContent = "#sel.scale i{background:var(--ov)}#scaleBadge{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:4;pointer-events:none;padding:3px 10px;border-radius:999px;background:var(--c-sel);color:#fff;font-size:var(--c-size-xs,11px);font-weight:600;line-height:100%;letter-spacing:.01em;display:none}";
    document.head.appendChild(st);
  })();
  function setScaleMode(on) {
    if (on === scaleMode) return;
    if (!on && sc && sc.drag) endScale(true);
    scaleMode = on;
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "scaleBadge";
      badge.textContent = "Scale";
      view.appendChild(badge);
    }
    badge.style.display = on ? "block" : "none";
    if (selBox) selBox.classList.toggle("scale", on);
    setCursor("");
    if (on) prefetchPlan(scaleIds());
    if (host.native) host.post({ scaleMode: on });
  }

  /** The selected layers a scale acts on (widgets and layers inside instances cannot scale on their own). */
  const scaleIds = () => (host.selection ? host.selection() : host.sel ? [host.sel] : []).filter((id) => typeof id === "string" && !id.startsWith("widget:") && !id.includes("/"));

  // What the server says about the selection (POST /api/scale {plan}): per scene id, the token-bound paths a scale
  // keeps. The preview leaves those alone too, so it lands exactly where the write does.
  let plan = { key: "", bound: new Map(), pending: null };
  function prefetchPlan(ids) {
    const key = ids.join("\n");
    if (!ids.length) return Promise.resolve(plan.bound);
    if (plan.key === key && plan.pending) return plan.pending;
    plan = { key, bound: plan.key === key ? plan.bound : new Map(), pending: null };
    const mine = plan;
    mine.pending = fetch("/api/scale", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, ids, plan: true }) })
      .then((r) => (r.ok ? r.json() : { nodes: {} }))
      .then((j) => {
        const m = new Map();
        for (const [id, v] of Object.entries((j && j.nodes) || {})) if (v && Array.isArray(v.bound)) m.set(id, new Set(v.bound));
        mine.bound = m;
        mine.pending = null;
        if (sc && sc.planKey === key) { sc.bound = m; if (sc.f !== 1) showScale(0); }
        return m;
      }, () => { mine.pending = null; return mine.bound; });
    return mine.pending;
  }
  host.on("render", () => { if (plan.key && !plan.pending) plan.key = ""; }); // the document changed: ask again next time
  host.on("select", () => { if (scaleMode) prefetchPlan(scaleIds()); });

  /** Where a layer sits in its board's scene: its node, and whether it places itself (x/y) or its parent does. */
  function placeIn(root, id) {
    let hit = null;
    const visit = (n, parent) => {
      if (hit || !n || typeof n !== "object") return;
      if (String(n.id) === id) { hit = { node: n, parent }; return; }
      for (const c of Array.isArray(n.children) ? n.children : []) visit(c, n);
    };
    visit(root, null);
    if (!hit) return null;
    const p = hit.parent;
    const layout = !p ? "none" : p.type === "group" ? "none" : typeof p.layout === "string" ? p.layout : p.type === "frame" ? "horizontal" : "none";
    return { node: hit.node, positioned: !p || layout === "none" || hit.node.layoutPosition === "absolute" };
  }

  /** A scale of the selection about rect r0 (world): its items, each with the scene subtree the preview scales. */
  function beginScale(ids) {
    const v = ev();
    const items = [];
    for (const id of ids) {
      const board = boardOf(id);
      const wr = host.worldRectOf(id);
      if (!v || !board || !host.boards.has(board) || !v.isLoaded(board) || !wr) return null;
      const text = v.sceneText(board);
      if (text === null) { fetchScene(board); return null; }
      let scene;
      try { scene = JSON.parse(text); } catch { return null; }
      const isBoard = board === id;
      const p = placeIn(scene.root, id);
      if (!p) return null;
      if (Number(p.node.rotation)) { tell("Scaling a rotated layer is not supported yet"); return false; }
      const meta = isBoard ? host.boards.get(board).meta : null;
      items.push({ id, board, isBoard, wr, base: p.node, positioned: isBoard || p.positioned, own: isBoard ? { x: meta.x, y: meta.y } : { x: Number(p.node.x) || 0, y: Number(p.node.y) || 0 }, touched: [] });
    }
    if (!items.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) { x0 = Math.min(x0, it.wr.x); y0 = Math.min(y0, it.wr.y); x1 = Math.max(x1, it.wr.x + it.wr.w); y1 = Math.max(y1, it.wr.y + it.wr.h); }
    const key = ids.join("\n");
    return { ids, items, r0: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, f: 1, anchor: [0, 0], planKey: key, bound: plan.key === key ? plan.bound : new Map(), drag: null };
  }

  /** The writes and the preview for the scale as it stands: per item, every node's scaled props and the layer's new place. */
  function scaleItems(s) {
    const A = { x: s.r0.x + s.anchor[0] * s.r0.w, y: s.r0.y + s.anchor[1] * s.r0.h };
    return s.items.map((it) => {
      const nw = scaleRectAbout(it.wr, A.x, A.y, s.f);
      const nodes = scaleScene(it.base, s.f, s.bound);
      let pos = null;
      if (it.positioned) pos = { x: r2(it.own.x + (nw.x - it.wr.x)), y: r2(it.own.y + (nw.y - it.wr.y)) };
      return { it, nodes, pos };
    });
  }
  /** Draw the scale as it stands (op 0 while dragging). */
  function showScale(op) {
    const s = sc;
    if (!s) return [];
    const out = scaleItems(s);
    for (const { it, nodes, pos } of out) {
      // A frame that scaled back towards 1 must lose what an earlier frame set: start from the scene each time.
      if (it.touched.length) edits.forget(it.board, it.touched);
      it.touched = [];
      for (const n of nodes) {
        const props = Object.assign({}, n.props);
        if (n.id === it.id && pos && !it.isBoard) { props.x = pos.x; props.y = pos.y; }
        if (!Object.keys(props).length) continue;
        edits.set(it.board, n.id, props, [], op);
        it.touched.push(n.id);
      }
      if (it.isBoard && pos) host.placeBoard(it.board, pos.x, pos.y);
      const root = nodes[0];
      if (root && s.items.length === 1) note(it.id, Object.assign({}, root.props, pos && !it.isBoard ? pos : {}), [], op);
      markDirty(it.board, it.id);
    }
    host.requestFrame();
    armExpiry();
    return out;
  }
  function cancelScale(s) {
    for (const it of s.items) {
      edits.forget(it.board, it.touched);
      if (s.items.length === 1) noteForget(it.id);
      if (it.isBoard) host.placeBoard(it.board, it.own.x, it.own.y);
      markDirty(it.board);
      host.reloadBoard(it.board);
    }
    host.requestFrame();
  }
  /** One write for the whole scale, one undo step. */
  function sendScale(s, out, op) {
    const ids = new Set();
    for (const { it } of out) for (const id of [it.id, ...it.touched]) ids.add(id);
    const items = out.filter((o) => o.pos).map((o) => ({ id: o.it.id, x: o.pos.x, y: o.pos.y }));
    fetch("/api/scale", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, ids: s.ids, factor: s.f, items }) })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then((j) => {
        for (const id of ids) ack(id, op, true);
        if (j.kept) tell(j.kept === 1 ? "1 token value kept" : `${j.kept} token values kept`);
      })
      .catch((err) => {
        for (const id of ids) ack(id, op, false);
        for (const { it } of out) if (it.isBoard) host.placeBoard(it.board, it.own.x, it.own.y);
        tell("Could not scale: " + err.message);
      });
  }

  const scaleHandleFor = (e) => {
    if (host.readOnly) return null;
    if (!scaleMode || !ev() || host.hand) return null;
    const ids = scaleIds();
    // A locked layer (selected in the Layers panel) does not scale on the canvas; the inspector's scale field still does.
    if (!ids.length || (host.isLocked && ids.some((id) => host.isLocked(id)))) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const r = host.worldRectOf(id);
      if (!r) return null;
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    const c = host.cam;
    if (!c) return null;
    return handleAt({ x: x0 * c.z + c.x, y: y0 * c.z + c.y, w: (x1 - x0) * c.z, h: (y1 - y0) * c.z }, e.clientX - VR.left, e.clientY - VR.top);
  };
  view.addEventListener("pointermove", (e) => {
    if (!scaleMode || sc) return;
    if (e.buttons) { if (cursor) setCursor(""); return; }
    const h = scaleHandleFor(e);
    setCursor(h ? CURSOR[h] : "");
  }, { passive: true });
  addEventListener("pointerdown", (e) => {
    if (!scaleMode || sc || e.button !== 0 || e.ctrlKey || !view.contains(e.target)) return;
    const h = scaleHandleFor(e);
    if (!h) return;
    e.stopPropagation();
    e.preventDefault();
    const ids = scaleIds();
    const s = beginScale(ids);
    if (!s) { if (s === null) tell("That selection is not drawn yet; try again in a moment"); return; }
    s.drag = { h, cx: e.clientX, cy: e.clientY, moved: false, index: s.items.length === 1 ? host.snapIndex(s.items[0].isBoard ? "board" : "node", s.items[0].id) : null };
    sc = s;
    prefetchPlan(ids);
    try { view.setPointerCapture(e.pointerId); } catch {}
    setCursor(CURSOR[h]);
  }, true);
  addEventListener("pointermove", (e) => {
    if (!sc || !sc.drag) return;
    e.stopPropagation();
    const d = sc.drag, c = host.cam;
    if (!d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 2) return;
    d.moved = true;
    const snap = host.snap();
    const objects = snap.objects && !e.ctrlKey && !host.blueprintBypass(e); // Control: no snapping to objects
    const g = scaleDrag(sc.r0, d.h, (e.clientX - d.cx) / c.z, (e.clientY - d.cy) / c.z, { alt: e.altKey, round: snap.pixel && !host.blueprintBypass(e), snap: edgeSnapper(objects ? d.index : null, c.z, undefined, host.blueprintSpacing(e)) });
    sc.f = g.f;
    sc.anchor = g.anchor;
    showScale(0);
    flush();
    host.paintGuides(objects ? resizeGuides(d.index, g.rect) : []);
  }, true);
  addEventListener("pointerup", (e) => { if (sc && sc.drag) { e.stopPropagation(); endScale(false); } }, true);
  addEventListener("pointercancel", (e) => { if (sc && sc.drag) { e.stopPropagation(); endScale(true); } }, true);
  function endScale(cancel) {
    const s = sc;
    sc = null;
    host.clearGuides();
    setCursor("");
    if (!s || !s.drag || !s.drag.moved) return;
    if (cancel || s.f === 1) { cancelScale(s); return; }
    const op = nextOp();
    sc = s; // showScale reads it
    const out = showScale(op);
    sc = null;
    sendScale(s, out, op);
  }
  /** The inspector's Scale field: scale the selection by `f` about `anchor` (default its top-left), one write. */
  async function scaleBy(f, anchor) {
    if (!(f > 0) || f === 1 || sc) return;
    if (f < 0.01 || f > 100) { tell("Scale must be between 1% and 10000%"); return; }
    const ids = scaleIds();
    if (!ids.length) { tell("Select a layer to scale"); return; }
    await prefetchPlan(ids);
    const s = ev() ? beginScale(ids) : null;
    if (s === false) return;
    if (!s) {
      // Not drawn here (DOM renderer, a board still loading): the server anchors on the stored box.
      fetch("/api/scale", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, ids, factor: f, anchor: anchor || "top-left" }) })
        .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
        .then((j) => { if (j.kept) tell(j.kept === 1 ? "1 token value kept" : `${j.kept} token values kept`); for (const id of ids) { const b = boardOf(id); if (b) confirm(b); } })
        .catch((err) => tell("Could not scale: " + err.message));
      return;
    }
    s.f = f;
    s.anchor = (typeof anchor === "string" && ANCHORS[anchor]) || [0, 0];
    const op = nextOp();
    sc = s;
    const out = showScale(op);
    sc = null;
    sendScale(s, out, op);
  }

  addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (e.key === "Escape" && (sc || scaleMode)) {
      e.preventDefault(); e.stopPropagation();
      if (sc && sc.drag) endScale(true); else setScaleMode(false);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || rz) return;
    if (e.code === "KeyK" && !e.shiftKey) { e.preventDefault(); setScaleMode(!scaleMode); }
    else if (e.code === "KeyV" && scaleMode && !e.shiftKey) { e.preventDefault(); setScaleMode(false); }
  }, true);
  host.on("deselect", () => { if (sc && sc.drag) endScale(true); });

  // ---------- the shell and the page ----------
  host.on("cmd", (c) => {
    // The inspector's own edits: it shows them already, so they only keep a later node read from going back.
    if (c.cmd === "edit") edit(c.id, c.props || {}, c.remove || [], c.preview ? 0 : Number(c.op) || 0, false);
    else if (c.cmd === "editDone") ack(c.id, Number(c.op) || 0, !!c.ok);
    else if (c.cmd === "fitContent") fitContent(c.side || "all", c.id);
    else if (c.cmd === "scale") scaleBy(Number(c.factor), c.anchor);
    else if (c.cmd === "scaleMode") setScaleMode(c.on === undefined ? !scaleMode : !!c.on);
  });
  // Warm the selected board's scene, so its first edit draws without a fetch.
  host.on("select", (id) => { const b = boardOf(id); if (b && ev() && ev().sceneText(b) === null) fetchScene(b); });

  host.live = {
    setPeerPreviews: peers => {
      const key=JSON.stringify(peers.map(p=>[p.session,p.preview,p.editing]));
      if(key===peerKey)return;
      for(const p of [...peerPreviews,...peers]) for(const id of [...(p.preview?.ids || []),...(p.editing ? [p.editing.id] : [])]) {
        const b=boardOf(id);if(b)markDirty(b);
      }
      peerPreviews=peers;peerKey=key;host.requestFrame();
    },
    flush, edit, ack, historyStart, fitContent, note, noteAck, noteForget, overlay, nextOp,
    rebase: (board, scene, fetchedAt) => {
      const remote = applyPeerPreviews(scene.root, peerPreviews);
      const a = edits.rebase(board, scene, fetchedAt), b = applyPins(board, scene);
      if (a || b || pins.has(board)) for (const f of sceneHooks) { try { f(board, scene); } catch (err) { console.error(err); } }
      return a || b || remote;
    },
    pin, unpin, underPin, override, onScene: (f) => { sceneHooks.push(f); }, boardOf,
    // Auto layout (/page/autolayout.js): a parent's child order and a moved layer's props on a given board (the
    // layer may come from another board), carried by write `op` (0: a preview) and settled by ack like any edit.
    order: (board, parent, entries, op = 0) => { edits.setOrder(board, parent, entries, op); markDirty(board); host.requestFrame(); armExpiry(); },
    raw: (board, id, props, remove, op = 0) => { edits.set(board, id, props, remove, op); markDirty(board, id); host.requestFrame(); armExpiry(); },
    forget: (board, ids) => { edits.forget(board, ids); markDirty(board); host.requestFrame(); },
    /**
     * A move gesture: draw a layer at its own x/y now (op 0 while dragging, held until release), or with the
     * write `op` that drops it (settled by ack). False when the page cannot draw it (the server's redraw shows it).
     */
    place: (id, x, y, op = 0) => { if (!op) held.add(id); else held.delete(id); return edit(id, { x, y }, [], op); },
    /** A handle drag holds a layer's previews (op 0) while the pointer is down, however long it stays still (radius.js, autolayout.js). */
    hold: (id) => { held.add(id); armExpiry(); },
    unhold: (id) => { held.delete(id); },
    /** A layer's own x/y as the canvas draws it now (live edits on top), or null when its board's scene is not here. */
    ownPos: (id) => {
      const board = boardOf(id), v = ev(), text = board && v ? v.sceneText(board) : null;
      if (text === null || text === undefined) return null;
      let scene;
      try { scene = JSON.parse(text); } catch { return null; }
      applyPeerPreviews(scene.root, peerPreviews);
      edits.apply(board, scene);
      const n = findNode(scene.root, id);
      return n ? { x: typeof n.x === "number" ? n.x : 0, y: typeof n.y === "number" ? n.y : 0 } : null;
    },
    /** A move gesture ended without a write (cancelled, no change, or joined an auto layout flow): its preview goes. */
    unplace: (id) => {
      held.delete(id);
      const board = boardOf(id);
      if (board) { edits.unset(board, id, ["x", "y"], 0); markDirty(board, id); host.requestFrame(); }
    },
    /** A layer lifted out of its board for a drag (server.ts: a clipping board would hide it): not drawn there, or drawn again. */
    hide: (id) => { const board = boardOf(id); if (board) { held.add(id); edits.set(board, id, { opacity: 0 }, [], 0); markDirty(board, id); host.requestFrame(); } },
    unhide: (id) => { held.delete(id); const board = boardOf(id); if (board) { edits.unset(board, id, ["opacity"], 0); markDirty(board, id); host.requestFrame(); } },
    /** Lay a board out again in the next frame (its scene hooks run on it). */
    redraw: (board) => { markDirty(board); host.requestFrame(); },
    /** A board's scene as the canvas draws it now (the server's, live edits and pins on top), or null when the page has none. */
    sceneOf: (board) => {
      const v = ev(), text = v ? v.sceneText(board) : null;
      if (text === null) { if (v) fetchScene(board); return null; }
      let scene;
      try { scene = JSON.parse(text); } catch { return null; }
      applyPeerPreviews(scene.root, peerPreviews);
      edits.apply(board, scene);
      applyPins(board, scene);
      return scene;
    },
    get busy() { return !!rz || !!sc; },
    /** The canvas draws this board with edits or pins on top of the server's scene (its snapshot would not match its key). */
    touched: (board) => edits.has(board) || pins.has(board) || dirty.has(board),
    /** The selected layer's turned box ({r, w, h}) when it is rotated, for the selection box (server.ts putBox). */
    shape: (id) => shapeOf(id),
    get scaleMode() { return scaleMode; }, setScaleMode, scaleBy,
    stats: () => Object.assign({ boards: edits.size, dirty: dirty.size }, stats),
  };
}
