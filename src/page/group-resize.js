// Resize handles for a group and for a multi-selection (QA P2-4): the selection box's corners and
// edges resize the box, and every layer in it scales with the box (its position and size, each axis on its own;
// Shift keeps the ratio, Option resizes from the centre). A group has no size of its own: its layers scale. A frame
// in the selection resizes as a box; its own children stay where they are, as default constraints keep them.
// Text boxes become fixed size. A rotated layer scales along its own axes; one turned at an angle that is not a
// quarter turn makes the whole resize keep its ratio, as if Shift were held (filling a
// stretched box would need a skew; a layer cannot skew, and stretched along its own axes it would leave the box). A rotated group
// or a rotated layer that sizes itself, widget cards and layers inside instances turn the handles off.
//
// The drag draws at display rate through the page's live edits (/page/live.js) and writes once, on release:
// POST /api/resize {items} (src/resize.ts), one undo step. One layer that is not a group keeps /page/live.js's own
// handles. The pure math is groupResizeItems in /page/move-logic.js.

import { handleAt, resizeRect, CURSOR, edgeSnapper, resizeGuides } from "/page/live-edit.js";
import { groupResizeItems, needsUniformScale } from "/page/move-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, file } = host;
  const ev = () => (host.renderer === "engine" ? host.engineView : null);
  const live = () => host.live || null;
  const isW = (id) => typeof id === "string" && id.startsWith("widget:");
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };
  let VR = view.getBoundingClientRect();
  addEventListener("resize", () => { VR = view.getBoundingClientRect(); });
  host.on("cmd", (c) => { if (c && c.cmd === "insets") VR = view.getBoundingClientRect(); });

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
  const ids = () => (host.selection ? host.selection() : host.sel ? [host.sel] : []);

  // What the handles act on, per selection (null: no handles). Rebuilt when the selection or a board's drawing changes.
  let planKey = "", plan = null, planGen = 0, renders = 0;
  host.on("render", () => { renders++; });
  host.on("select", () => { planKey = ""; });
  host.on("deselect", () => { planKey = ""; plan = null; });
  function currentPlan() {
    const list = ids();
    const key = list.join("\n");
    if (key === planKey && planGen === renders) return plan;
    planKey = key; planGen = renders; plan = null;
    if (!list.length || !ev() || !live() || host.hand || (host.textEdit && host.textEdit.active) || (host.isLocked && list.some((id) => host.isLocked(id)))) return null;
    if (list.some((id) => isW(id) || id.includes("/"))) return null;
    const L = live();
    const roots = [];
    const scenes = new Map();
    for (const id of list) {
      const board = L.boardOf(id);
      if (!board || !host.boards.has(board)) return null;
      if (!scenes.has(board)) scenes.set(board, L.sceneOf(board));
      const scene = scenes.get(board);
      if (!scene) return null;
      const hit = locate(scene.root, id);
      if (!hit) return null;
      roots.push({ id, board, isBoard: board === id, node: hit.node, scene });
    }
    // One layer that is not a group: /page/live.js has its handles.
    if (roots.length === 1 && roots[0].node.type !== "group") return null;
    // A layer inside another selected one goes along with it.
    const chosen = new Set(list);
    const inside = (r) => { let hit = false; const visit = (n, under) => { if (!n || hit) return; if (String(n.id) === r.id) { hit = under; return; } for (const c of n.children || []) visit(c, under || chosen.has(String(n.id))); }; visit(r.scene.root, false); return hit; };
    const items = [];
    const add = (n, board, isBoard, under) => {
      if (!n || typeof n !== "object" || String(n.id).includes("/")) return true;
      const rot = Number(n.rotation) || 0;
      // A turned layer scales along its own axes (groupResizeItems); it needs its own size (not a text that sizes itself).
      if (rot && (n.type === "group" || typeof n.width !== "number" || typeof n.height !== "number" || (n.type === "text" && n.textGrowth !== "fixed-width-height"))) return false;
      if (n.type === "group" && !isBoard) {
        for (const c of n.children || []) if (!add(c, board, false, true)) return false;
        return true;
      }
      if (n.visible === false && under) return true;
      const wr = host.worldRectOf(String(n.id));
      if (!wr) return true;
      const meta = isBoard ? host.boards.get(board).meta : null;
      items.push({ id: String(n.id), board, isBoard, wr, own: isBoard ? { x: meta.x, y: meta.y } : { x: Number(n.x) || 0, y: Number(n.y) || 0 }, type: n.type, flipX: !!n.flipX, flipY: !!n.flipY, ...(rot ? { rot, w0: n.width, h0: n.height } : {}) });
      return true;
    };
    for (const r of roots) {
      if (inside(r)) continue;
      if (!add(r.node, r.board, r.isBoard, false)) return null;
    }
    if (!items.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) { x0 = Math.min(x0, it.wr.x); y0 = Math.min(y0, it.wr.y); x1 = Math.max(x1, it.wr.x + it.wr.w); y1 = Math.max(y1, it.wr.y + it.wr.h); }
    if (!(x1 > x0) || !(y1 > y0)) return null;
    plan = { items, r0: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, uniform: needsUniformScale(items) };
    return plan;
  }
  function screenOf(r) { const c = host.cam; return { x: r.x * c.z + c.x, y: r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z }; }
  function handleFor(e) {
    if (rz || !host.cam || (host.live && (host.live.scaleMode || host.live.busy)) || (host.moving && host.moving())) return null;
    const p = currentPlan();
    if (!p) return null;
    return handleAt(screenOf(p.r0), e.clientX - VR.left, e.clientY - VR.top);
  }

  let cursor = "";
  const setCursor = (c) => { if (c === cursor) return; cursor = c; view.style.cursor = c; };
  view.addEventListener("pointermove", (e) => {
    if (rz) return;
    if (e.buttons) { if (cursor) setCursor(""); return; }
    const h = handleFor(e);
    setCursor(h ? CURSOR[h] : "");
  }, { passive: true });
  view.addEventListener("pointerleave", () => { if (!rz) setCursor(""); });

  let rz = null;
  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.ctrlKey || !view.contains(e.target) || rz) return;
    const h = handleFor(e);
    if (!h) return;
    e.stopPropagation(); // the page's own pan, move and select handlers never see this press
    e.preventDefault();
    const p = plan;
    rz = { h, p, r0: p.r0, r: p.r0, cx: e.clientX, cy: e.clientY, moved: false, index: host.snapIndex ? host.snapIndex("group", "group") : null, out: [] };
    try { view.setPointerCapture(e.pointerId); } catch {}
    setCursor(CURSOR[h]);
  }, true);
  addEventListener("pointermove", (e) => {
    if (!rz) return;
    e.stopPropagation();
    const c = host.cam;
    if (!rz.moved && Math.hypot(e.clientX - rz.cx, e.clientY - rz.cy) < 2) return;
    rz.moved = true;
    const snap = host.snap ? host.snap() : { pixel: true, objects: false };
    rz.r = resizeRect(rz.r0, rz.h, (e.clientX - rz.cx) / c.z, (e.clientY - rz.cy) / c.z, { shift: e.shiftKey || rz.p.uniform, alt: e.altKey, round: false, min: 0.01, snap: snap.objects && !e.ctrlKey && rz.index ? edgeSnapper(rz.index, c.z) : null }); // Control: no snapping
    show(0);
    if (host.paintGuides) host.paintGuides(snap.objects && !e.ctrlKey && rz.index ? resizeGuides(rz.index, rz.r) : []);
  }, true);
  addEventListener("pointerup", (e) => { if (rz) { e.stopPropagation(); end(false); } }, true);
  addEventListener("pointercancel", (e) => { if (rz) { e.stopPropagation(); end(true); } }, true);
  addEventListener("keydown", (e) => { if (rz && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(true); } }, true);

  /** Draw the resize as it stands (op 0 while dragging). */
  function show(op) {
    const L = live();
    rz.out = groupResizeItems(rz.p.items, rz.r0, rz.r);
    const boards = new Set();
    for (const o of rz.out) {
      const props = Object.assign({}, o.props);
      if (o.it.isBoard) { host.placeBoard(o.it.board, props.x, props.y); delete props.x; delete props.y; }
      L.raw(o.it.board, o.it.id, props, [], op);
      boards.add(o.it.board);
    }
    L.flush();
    if (host.syncSel) host.syncSel();
  }
  function end(cancel) {
    const z = rz;
    rz = null;
    if (host.clearGuides) host.clearGuides();
    setCursor("");
    planKey = "";
    if (!z || !z.moved) return;
    const L = live();
    const same = z.r.x === z.r0.x && z.r.y === z.r0.y && z.r.w === z.r0.w && z.r.h === z.r0.h && !z.r.flipX && !z.r.flipY;
    if (cancel || same) {
      const byBoard = new Map();
      for (const it of z.p.items) { if (!byBoard.has(it.board)) byBoard.set(it.board, []); byBoard.get(it.board).push(it.id); if (it.isBoard) host.placeBoard(it.board, it.own.x, it.own.y); }
      for (const [b, list] of byBoard) { L.forget(b, list); host.reloadBoard(b); }
      if (host.syncSel) host.syncSel();
      return;
    }
    const op = L.nextOp();
    rz = z; show(op); rz = null;
    const items = z.out.map((o) => ({ id: o.it.id, props: o.props }));
    const all = items.map((i) => i.id);
    const req = fetch("/api/resize", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, items, label: "Resize", select: ids() }) })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(() => { for (const id of all) L.ack(id, op, true); }, (err) => {
        for (const id of all) L.ack(id, op, false);
        for (const it of z.p.items) if (it.isBoard) host.placeBoard(it.board, it.own.x, it.own.y);
        tell("Could not resize: " + err.message);
      });
    if (host.trackWrite) host.trackWrite(req);
  }
  host.groupResize = { get active() { return !!rz; }, handleFor: (cx, cy) => handleFor({ clientX: cx, clientY: cy }) };
}
