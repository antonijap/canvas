// Dropping moved layers reparents them (QA P1-2): the frame under the pointer adopts the layer, keeping
// where it shows on the canvas. Another board, a nested frame, empty canvas (the layer becomes a board on this page).
// A layer in a group stays in its group while it is dropped inside the frame around that group. Auto layout frames
// take layers into their flow in /page/autolayout.js (dropInto) before this runs; Ctrl drops into one as an absolute
// layer here.
//
// One write per drop, POST /api/layout op "place" (src/autolayout.ts, placeNodes / placeCopies): one undo step, a
// multi-selection dropped across several frames included (its parts go in the same request), and with a
// "group:<key>" merge it folds into the same step as the rest of a multi-selection's move. The page draws the
// result at once (live edits: the old parent loses the layer, the new one gains it) until the server's scene lands.
// The pure decisions are in /page/move-logic.js.

import * as A from "/page/autolayout-logic.js";
import { homeFrame, dropParent, originOfBox, multiDrops, placeBody } from "/page/move-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, file } = host;
  const ev = () => (host.renderer === "engine" ? host.engineView : null);
  const live = () => host.live || null;
  const deepClone = (v) => JSON.parse(JSON.stringify(v));
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };
  const worldAt = (cx, cy) => { const c = host.cam, r = view.getBoundingClientRect(); return { x: (cx - r.left - c.x) / c.z, y: (cy - r.top - c.y) / c.z }; };
  const round = (v) => (host.snap && host.snap().pixel ? Math.round(v) : Math.round(v * 100) / 100);

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
  /** The board under a world point (the last drawn wins), or null. */
  function boardAt(p, skip) {
    let hit = null;
    for (const id of host.boards.keys()) { if (skip && skip.has(id)) continue; const r = host.boxOf(id); if (r && A.contains(r, p)) hit = id; }
    return hit;
  }

  /**
   * What is under the pointer for a drop of `ids`: {kind: "canvas"}, {kind: "frame", id, board, node, layout}, or
   * null when the page cannot tell (the board's scene is not loaded): then nothing reparents.
   */
  function targetAt(cx, cy, ids, mods = {}, size = null) {
    if (!host.cam || !live()) return null;
    return targetAtWorld(worldAt(cx, cy), ids, mods, size);
  }
  /** targetAt for a world point. */
  function targetAtWorld(p, ids, mods = {}, size = null) {
    if (!live()) return null;
    const exclude = new Set(ids);
    const board = boardAt(p, exclude);
    if (!board) return { kind: "canvas" };
    const scene = live().sceneOf(board);
    if (!scene) return null;
    const uses = new Set();
    for (const id of ids) {
      const b = live().boardOf(id), s = b ? live().sceneOf(b) : null, own = s ? locate(s.root, id) : null;
      if (own) for (const c of A.componentsIn([own.node])) uses.add(c);
    }
    const t = A.dropTarget(scene.root, p, (id) => host.worldRectOf(id), exclude, size, !!mods.meta, uses);
    return t ? { kind: "frame", id: t.id, board, node: t.node, layout: t.layout } : { kind: "canvas" };
  }

  /** Where `id` sits now: its board, parent and home frame (move-logic.js homeFrame), or null when unknown. */
  function placeOf(id) {
    const L = live(), board = L && L.boardOf(id);
    if (!board) return null;
    const scene = L.sceneOf(board);
    if (!scene) return null;
    const anc = A.ancestorsOf(scene.root, id);
    if (!anc) return null;
    const own = locate(scene.root, id);
    return { board, parent: anc.length ? String(anc[anc.length - 1].id) : null, home: homeFrame(anc), node: own ? own.node : null };
  }

  /**
   * Which of the dropped layers change parent. items: [{id, rect}] (rect: the world rect where it lands). Returns
   * {target, moves: [{id, rect, from}]} (moves empty when all stay) or null when the target is unknown.
   */
  function plan(items, cx, cy, mods = {}, size = null) {
    const ids = items.map((i) => i.id);
    const target = targetAt(cx, cy, ids, mods, size);
    if (!target) return null;
    if (items.length > 1) {
      // Several layers: one changes parent only when it leaves its own frame, into the frame under its own
      // centre. A short drag of a selection that spans boards keeps each layer in its board. An auto layout frame
      // there takes it only through the pointer's flow drop (/page/autolayout.js dropManyInto); here it stays.
      const drops = multiDrops(items.map((it) => ({ ...it, from: placeOf(it.id) })), (id) => host.worldRectOf(id), (pt) => {
        const t = targetAtWorld(pt, ids, mods, null);
        return t && t.kind === "frame" && t.layout !== "none" && !mods.ctrl ? null : t;
      });
      const parts = new Map();
      for (const d of drops) {
        const k = d.target.kind === "frame" ? d.target.id : "";
        if (!parts.has(k)) parts.set(k, { target: d.target, moves: [] });
        parts.get(k).moves.push({ id: d.id, rect: d.rect, from: d.from });
      }
      return { target, moves: drops.map((d) => ({ id: d.id, rect: d.rect, from: d.from })), parts: [...parts.values()] };
    }
    const moves = [];
    // An auto layout frame takes layers into its flow (/page/autolayout.js); only Ctrl drops them in as absolute layers.
    if (target.kind === "frame" && target.layout !== "none" && !mods.ctrl) return { target, moves };
    for (const it of items) {
      const from = placeOf(it.id);
      if (!from) continue;
      // An auto layout frame that is the layer's own parent (an absolute layer in it): it stays.
      if (target.kind === "frame" && target.id === from.parent) continue;
      if (dropParent(from.home, target.kind === "frame" ? { id: target.id } : null, from.parent)) moves.push({ id: it.id, rect: it.rect, from });
    }
    return { target, moves };
  }

  /**
   * Write a plan's moves: one place op (copy: copies land there, the layers stay). Draws the result now. Resolves
   * with the server's answer; the selection goes to the moved layers (or the copies) unless it changed meanwhile.
   * A multi-selection's per-layer drops (pl.parts, several targets) go in the same request: one write, one undo step.
   */
  function apply(pl, opts = {}) {
    const L = live();
    const all = (pl.parts || [pl]).filter((p) => p.moves.length);
    if (!all.length) return Promise.resolve(null);
    const op = L ? L.nextOp() : 0;
    const ack = new Set(), rects = {}, parts = [];
    const leaving = new Set(all.flatMap((p) => p.moves.map((m) => m.id)));
    for (const part of all) {
      const d = draw(part, opts, L, op, rects, ack, leaving);
      if (!d) return Promise.resolve(null);
      parts.push(d);
    }
    const body = placeBody(file, host.page, parts, { rects, copy: !!opts.copy, merge: opts.merge }); // on top of everything there, the canvas included
    const selAt = (host.selection ? host.selection() : []).join("\n");
    const req = fetch("/api/layout", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { code: j.code }); return j; }));
    const out = req.then((j) => {
      if (L) for (const id of ack) L.ack(id, op, true);
      const sel = j && Array.isArray(j.select) && j.select.length ? j.select : null;
      // A multi-selection's drop keeps its selection (opts.keepSelection); a single layer's selects what landed.
      if (sel && !opts.keepSelection && host.setSelection && (host.selection ? host.selection() : []).join("\n") === selAt) host.setSelection(sel);
      return j;
    }, (err) => {
      if (L) { for (const id of ack) L.ack(id, op, false); for (const b of host.boards.keys()) L.redraw(b); }
      tell("Could not move: " + err.message);
      throw err;
    });
    return out;
  }
  /**
   * One target's share of a drop: draws it now through the live edits (op), adds the rects the server needs and the
   * ids to acknowledge, and returns its part of the request {parent, ids, absolute} (null when the target is gone).
   */
  function draw(pl, opts, L, op, rects, ack, leaving) {
    const { target, moves } = pl;
    const ids = moves.map((m) => m.id);
    const tr = target.kind === "frame" ? host.worldRectOf(target.id) : { x: 0, y: 0 };
    if (!tr) return null;
    // x/y is the layer's own top-left corner, which a rotation or flip moves away from the corner of its box on screen.
    const originOf = (m) => {
      const n = m.from.node || {};
      return originOfBox(m.rect, typeof n.width === "number" ? n.width : null, typeof n.height === "number" ? n.height : null, Number(n.rotation) || 0, n.flipX === true, n.flipY === true);
    };
    const absolute = moves.map((m) => { const o = originOf(m); return { x: round(o.x - tr.x), y: round(o.y - tr.y) }; });
    for (const m of moves) { rects[m.id] = { x: m.rect.x, y: m.rect.y, w: m.rect.w, h: m.rect.h }; if (m.from.parent) { const r = host.worldRectOf(m.from.parent); if (r) rects[m.from.parent] = r; } }
    if (target.kind === "frame") rects[target.id] = tr;
    for (const id of ids) ack.add(id);
    if (L && !opts.copy) {
      // The old parents lose the layers, the target gains them on top, where they were dropped.
      const byParent = new Map();
      for (const m of moves) {
        L.unplace(m.id);
        if (!m.from.parent) continue;
        const k = m.from.board + "\n" + m.from.parent;
        if (!byParent.has(k)) byParent.set(k, { board: m.from.board, parent: m.from.parent, out: new Set() });
        byParent.get(k).out.add(m.id);
        ack.add(m.from.parent);
      }
      for (const g of byParent.values()) {
        const s = L.sceneOf(g.board), p = s ? locate(s.root, g.parent) : null;
        if (p) L.order(g.board, g.parent, (p.node.children || []).map((c) => c.id).filter((id) => !g.out.has(id)), op);
      }
      if (target.kind === "frame") {
        ack.add(target.id);
        // Layers that leave this frame for another target of the same drop are not its children any more.
        const kids = (target.node.children || []).map((c) => c.id).filter((id) => !ids.includes(id) && !leaving.has(id));
        const entries = kids.concat(moves.map((m) => (m.from.board === target.board ? m.id : { id: m.id, node: m.from.node ? deepClone(m.from.node) : { id: m.id } })));
        L.order(target.board, target.id, entries, op);
        const absIn = A.layoutOf(target.node) !== "none";
        moves.forEach((m, i) => L.raw(target.board, m.id, { x: absolute[i].x, y: absolute[i].y, ...(absIn ? { layoutPosition: "absolute" } : {}) }, [], op));
      }
    }
    return { parent: target.kind === "frame" ? target.id : null, ids, absolute };
  }

  host.reparent = { targetAt, plan, apply };
}
