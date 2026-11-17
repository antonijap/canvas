// Rotation on the canvas (QA P3-9): just outside a selected layer's corners the cursor turns into a
// rotate cursor, and a drag there turns the layer about its centre; Shift snaps to 15 degrees, Esc cancels. One layer
// at a time (a layer or a group; not a board or a layer inside an instance). The drag draws through the page's live edits and
// writes once, on release: POST /api/update {rotation, x, y}, one undo step (its own gesture key, so two quick turns
// are two steps, not one merged by the update route's 500 ms window). The inspector's angle field is the
// typed way. The math (a rotation turns about the top-left corner) is in /page/move-logic.js.
//
// Option+R shows the rotation origin: a target at the layer's centre. Drag it anywhere (it snaps to the
// layer's centre, corners and edge middles); turns then go round it, the layer moving as it turns. Option+R again
// hides it and the centre is the origin again; so does another selection. Absolutely placed layers only (auto layout
// places the others, so they turn about their centre).

import { handleAt } from "/page/live-edit.js";
import { rotateZoneAt, rotatedPosition, pivotedPosition, turnAbout, dragRotation, rotateVec, turnedGroupSize } from "/page/move-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

// A rotate cursor (a curved arrow), white with a dark outline, hot spot in the middle.
const CURSOR = "url(\"data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M6 14a7 7 0 1 1 4 5" fill="none" stroke="black" stroke-width="4" stroke-linecap="round"/><path d="M6 14a7 7 0 1 1 4 5" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/><path d="M2.5 11.5 6 15.5l3.5-4z" fill="white" stroke="black" stroke-width="1"/></svg>') + "\") 12 12, crosshair";

function start(host) {
  const { view, file } = host;
  const ev = () => (host.renderer === "engine" ? host.engineView : null);
  const live = () => host.live || null;
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };
  let VR = view.getBoundingClientRect();
  addEventListener("resize", () => { VR = view.getBoundingClientRect(); });
  host.on("cmd", (c) => { if (c && c.cmd === "insets") VR = view.getBoundingClientRect(); });

  function findNode(root, id) {
    let hit = null;
    const visit = (n) => { if (hit || !n || typeof n !== "object") return; if (String(n.id) === id) { hit = n; return; } for (const c of n.children || []) visit(c); };
    visit(root);
    return hit;
  }
  /** What a rotation of the selection works with, or null when it cannot rotate. */
  function target() {
    const ids = host.selection ? host.selection() : [];
    if (ids.length !== 1 || !ev() || !live() || host.hand || !host.cam || (host.isLocked && host.isLocked(ids[0]))) return null;
    if ((host.textEdit && host.textEdit.active) || live().scaleMode || live().busy || (host.moving && host.moving()) || (host.groupResize && host.groupResize.active)) return null;
    const id = ids[0];
    if (id.startsWith("widget:") || id.includes("/") || host.boards.has(id)) return null;
    const board = live().boardOf(id);
    const scene = board ? live().sceneOf(board) : null;
    const n = scene ? findNode(scene.root, id) : null;
    if (!n) return null;
    const wr = host.worldRectOf(id);
    if (!wr) return null;
    const r0 = Number(n.rotation) || 0;
    // A group turns about its centre too; its size is its layers' extent, sizes left to layout (auto-sized
    // text, hug frames) read from the engine's drawn boxes. Measured unturned too, to know it again at 45 degrees.
    const gs = n.type === "group" ? turnedGroupSize(scene.root, id, (x) => host.worldRectOf(x)) : null;
    const ge = r0 ? gs : null;
    const w = ge ? ge.w : typeof n.width === "number" && n.type !== "group" ? n.width : r0 ? null : wr.w;
    const h = ge ? ge.h : typeof n.height === "number" && n.type !== "group" ? n.height : r0 ? null : wr.h;
    if (w === null || h === null) return null;
    const m = host.moveInfo ? host.moveInfo(id) : null;
    return { id, board, r0, w, h, wr, own: { x: Number(n.x) || 0, y: Number(n.y) || 0 }, flipX: n.flipX === true, flipY: n.flipY === true, positioned: !!m && m.mode === "absolute" };
  }
  const screenOf = (r) => { const c = host.cam; return { x: r.x * c.z + c.x, y: r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z }; };
  function zoneFor(e) {
    if (rot) return null;
    const t = target();
    if (!t) return null;
    const s = screenOf(t.wr), px = e.clientX - VR.left, py = e.clientY - VR.top;
    if (t.r0) {
      // A turned layer's box turns with it (its handles too): the zones sit off its own corners.
      const z = host.cam.z, p = rotateVec(px - (s.x + s.w / 2), py - (s.y + s.h / 2), t.r0);
      const ls = { x: -t.w * z / 2, y: -t.h * z / 2, w: t.w * z, h: t.h * z };
      return rotateZoneAt(ls, p.x, p.y, !!handleAt(ls, p.x, p.y)) ? { t, s } : null;
    }
    const zone = rotateZoneAt(s, px, py, !!handleAt(s, px, py));
    return zone ? { t, s } : null;
  }

  let over = false;
  view.addEventListener("pointermove", (e) => {
    if (rot || e.buttons) return;
    const z = zoneFor(e);
    if (z) { over = true; view.style.cursor = CURSOR; }
    else if (over) { over = false; view.style.cursor = ""; }
  }, { passive: true });

  let rot = null;
  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.ctrlKey || !view.contains(e.target) || rot) return;
    const z = zoneFor(e);
    if (!z) return;
    e.stopPropagation(); // not a pan, a move or a click on empty canvas
    e.preventDefault();
    // About the rotation origin when Option+R moved it, else the centre.
    const piv = originFor(z.t);
    const ps = piv ? toScreen(piv) : null;
    const c = ps ? { x: ps.x + VR.left, y: ps.y + VR.top } : { x: z.s.x + z.s.w / 2 + VR.left, y: z.s.y + z.s.h / 2 + VR.top };
    rot = { t: z.t, c, a0: Math.atan2(e.clientY - c.y, e.clientX - c.x), r: z.t.r0, moved: false, pivot: piv, centre: { x: z.t.wr.x + z.t.wr.w / 2, y: z.t.wr.y + z.t.wr.h / 2 } };
    try { view.setPointerCapture(e.pointerId); } catch {}
    view.style.cursor = CURSOR;
  }, true);
  addEventListener("pointermove", (e) => {
    if (!rot) return;
    e.stopPropagation();
    rot.moved = true;
    rot.r = dragRotation(rot.t.r0, rot.a0, Math.atan2(e.clientY - rot.c.y, e.clientX - rot.c.x), e.shiftKey);
    show(0);
    paintOrigin();
  }, true);
  addEventListener("pointerup", (e) => { if (rot) { e.stopPropagation(); end(false); } }, true);
  addEventListener("pointercancel", (e) => { if (rot) { e.stopPropagation(); end(true); } }, true);
  addEventListener("keydown", (e) => { if (rot && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(true); } }, true);

  function propsOf(z) {
    const t = z.t, props = { rotation: z.r };
    if (t.positioned) Object.assign(props, z.pivot ? pivotedPosition(t.own, t.w, t.h, t.r0, z.r, z.centre, z.pivot, t.flipX, t.flipY) : rotatedPosition(t.own, t.w, t.h, t.r0, z.r, t.flipX, t.flipY));
    return props;
  }
  function show(op) {
    live().raw(rot.t.board, rot.t.id, propsOf(rot), [], op);
    live().flush();
    if (host.syncSel) host.syncSel();
  }
  function end(cancel) {
    const z = rot;
    rot = null;
    over = false;
    view.style.cursor = "";
    if (!z || !z.moved) return;
    const L = live();
    if (cancel || z.r === z.t.r0) { L.forget(z.t.board, [z.t.id]); host.reloadBoard(z.t.board); if (host.syncSel) host.syncSel(); return; }
    const op = L.nextOp();
    rot = z; show(op); rot = null;
    // The origin stays where it is on the canvas: from the layer's new centre, it is that much off now.
    if (z.pivot && origin && origin.id === z.t.id) { const c1 = turnAbout(z.centre, z.pivot, z.r - z.t.r0); origin = { id: origin.id, ox: z.pivot.x - c1.x, oy: z.pivot.y - c1.y }; }
    paintOrigin();
    const req = fetch("/api/update", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id: z.t.id, props: propsOf(z), gesture: "rotate:" + op + ":" + Date.now() }) })
      .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
      .then(() => L.ack(z.t.id, op, true), (err) => { L.ack(z.t.id, op, false); tell("Could not rotate: " + err.message); });
    if (host.trackWrite) host.trackWrite(req);
  }
  // ---------- the rotation origin (Option+R) ----------
  // {id, ox, oy}: where turns of layer id go round, as an offset from its centre (it moves with the layer).
  let origin = null;
  let od = null; // the origin being dragged: {was}
  const toScreen = (p) => { const c = host.cam; return { x: p.x * c.z + c.x, y: p.y * c.z + c.y }; };
  /** The origin on the canvas (world), or null. While a turn about it runs, it is the turn's pivot. */
  function originWorld() {
    if (!origin) return null;
    if (rot && rot.pivot && rot.t.id === origin.id) return rot.pivot;
    const r = host.worldRectOf(origin.id);
    return r ? { x: r.x + r.w / 2 + origin.ox, y: r.y + r.h / 2 + origin.oy } : null;
  }
  const originFor = (t) => (origin && t && origin.id === t.id && t.positioned ? originWorld() : null);
  const ocv = document.createElement("canvas");
  ocv.id = "rotOrigin";
  ocv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:5";
  view.appendChild(ocv);
  const octx = ocv.getContext("2d");
  let oPainted = false;
  function paintOrigin() {
    const dpr = window.devicePixelRatio || 1, w = view.clientWidth, h = view.clientHeight;
    if (ocv.width !== Math.round(w * dpr) || ocv.height !== Math.round(h * dpr)) { ocv.width = Math.max(1, Math.round(w * dpr)); ocv.height = Math.max(1, Math.round(h * dpr)); ocv.style.width = w + "px"; ocv.style.height = h + "px"; }
    octx.setTransform(1, 0, 0, 1, 0, 0);
    if (oPainted) octx.clearRect(0, 0, ocv.width, ocv.height);
    oPainted = false;
    const sel = host.selection ? host.selection() : [];
    const ow = originWorld();
    if (!ow || !host.cam || sel.length !== 1 || sel[0] !== origin.id || (host.moving && host.moving())) return;
    const p = toScreen(ow);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A target: a ring with a cross through it, in the selection's blue, white behind for any background.
    octx.lineCap = "round";
    for (const [col, lw] of [["#FFFFFF", 3.5], ["#0D99FF", 1.5]]) {
      octx.strokeStyle = col; octx.lineWidth = lw;
      octx.beginPath(); octx.arc(p.x, p.y, 5, 0, Math.PI * 2); octx.stroke();
      octx.beginPath(); octx.moveTo(p.x - 10, p.y); octx.lineTo(p.x - 6, p.y); octx.moveTo(p.x + 6, p.y); octx.lineTo(p.x + 10, p.y);
      octx.moveTo(p.x, p.y - 10); octx.lineTo(p.x, p.y - 6); octx.moveTo(p.x, p.y + 6); octx.lineTo(p.x, p.y + 10); octx.stroke();
    }
    oPainted = true;
  }
  host.on("cam", () => { if (origin) paintOrigin(); });
  host.on("render", () => { if (origin) paintOrigin(); });
  host.on("select", (id) => { if (origin && origin.id !== id) { origin = null; paintOrigin(); } });
  host.on("deselect", () => { if (origin) { origin = null; paintOrigin(); } });
  addEventListener("keydown", (e) => {
    if (e.code !== "KeyR" || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.repeat) return;
    const tg = e.target;
    if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.isContentEditable)) return;
    const t = target();
    if (!t) return;
    e.preventDefault();
    if (origin && origin.id === t.id) { origin = null; paintOrigin(); return; }
    if (!t.positioned) { tell("Auto layout places this layer: it turns about its centre"); return; }
    origin = { id: t.id, ox: 0, oy: 0 };
    paintOrigin();
  });
  /** The origin snaps to the layer's centre, corners and edge middles within 6 screen px. */
  function snapOrigin(p, t) {
    const r = host.worldRectOf(t.id);
    if (!r) return p;
    const tol = 6 / host.cam.z;
    let best = null, bd = tol;
    for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) {
      const q = { x: r.x + r.w * fx, y: r.y + r.h * fy }, d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= bd) { bd = d; best = q; }
    }
    return best || p;
  }
  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !origin || rot || !view.contains(e.target)) return;
    const sel = host.selection ? host.selection() : [];
    if (sel.length !== 1 || sel[0] !== origin.id) return;
    const ow = originWorld();
    if (!ow) return;
    const p = toScreen(ow);
    if (Math.hypot(e.clientX - VR.left - p.x, e.clientY - VR.top - p.y) > 9) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    od = { was: { ...origin } };
    try { view.setPointerCapture(e.pointerId); } catch {}
  }, true);
  addEventListener("pointermove", (e) => {
    if (!od) return;
    e.stopPropagation();
    const c = host.cam, w = { x: (e.clientX - VR.left - c.x) / c.z, y: (e.clientY - VR.top - c.y) / c.z };
    const t = target();
    const s = t ? snapOrigin(w, t) : w;
    const r = host.worldRectOf(origin.id);
    if (!r) return;
    origin = { id: origin.id, ox: Math.round((s.x - r.x - r.w / 2) * 100) / 100, oy: Math.round((s.y - r.y - r.h / 2) * 100) / 100 };
    paintOrigin();
  }, true);
  addEventListener("pointerup", (e) => { if (od) { e.stopPropagation(); od = null; } }, true);
  addEventListener("keydown", (e) => { if (od && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); origin = od.was; od = null; paintOrigin(); } }, true);

  host.rotate = {
    get active() { return !!rot; },
    /** The rotation origin shown (Option+R): {id, x, y} world, or null. */
    get origin() { const w = originWorld(); return w ? { id: origin.id, x: w.x, y: w.y } : null; },
    /** The layer's box while it turns, for the selection box: {id, r, w, h}, or null. */
    shape: () => (rot && rot.moved ? { id: rot.t.id, r: rot.r, w: rot.t.w, h: rot.t.h } : null),
  };
}
