// Corner radius handles on the canvas. Runs on window.canvasHost next to live.js and autolayout.js, with the engine
// renderer.
//
// Hover inside a selected frame or rectangle that is big enough on screen: a small knob shows just inside each
// corner (where the radius ends, at least INSET_PX in, clear of the resize corner). Drag one toward the centre to
// round all four corners (Option: that corner alone); a value label follows the pointer, whole px while pixel
// snapping is on. The drag draws through the page's live edits (no flicker, no layout pass of its own) and writes
// once on release (POST /api/update cornerRadius, one undo step). Esc cancels. The knobs hide while anything else
// holds the pointer (a move, resize, rotate, a spacing handle), while text is edited, in scale mode, with several
// layers selected, and on rotated layers or a radius bound to a token.
// The pure math is in src/page/radius-logic.js (node-tested).

import * as R from "/page/radius-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, file } = host;
  const BLUE = "#0D99FF";
  const live = () => host.live || null;
  const ev = () => (host.renderer === "engine" ? host.engineView : null);
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };
  const editingText = () => !!(host.textEdit && host.textEdit.active);
  let VR = view.getBoundingClientRect();
  addEventListener("resize", () => { VR = view.getBoundingClientRect(); paint(); });
  host.on("cmd", (c) => { if (c.cmd === "insets") VR = view.getBoundingClientRect(); });

  // ---------- the selected layer ----------
  let sel = null; // {id, board, raw (cornerRadius as stored), flipX, flipY}
  function findIn(root, id) {
    if (!root || typeof root !== "object") return null;
    if (String(root.id) === id) return root;
    for (const c of Array.isArray(root.children) ? root.children : []) { const hit = findIn(c, id); if (hit) return hit; }
    return null;
  }
  function load() {
    sel = null;
    const id = host.sel, L = live();
    if (!id || !L || !ev() || id.startsWith("widget:") || id.includes("/") || (host.selection && host.selection().length > 1)) return;
    const board = L.boardOf(id);
    const scene = board ? L.sceneOf(board) : null;
    const n = scene ? findIn(scene.root, id) : null;
    if (!R.radiusTarget(n)) return;
    sel = { id, board, raw: n.cornerRadius, flipX: !!n.flipX, flipY: !!n.flipY };
  }
  host.on("select", () => { setTimeout(() => { load(); paint(); }, 0); });
  host.on("deselect", () => { sel = null; hover = false; setCursor(""); paint(); });
  host.on("render", (bid) => {
    if (dr || !host.sel) return;
    const b = sel ? sel.board : live() ? live().boardOf(host.sel) : null;
    if (bid && bid !== b) return;
    load();
    if (hover) paint();
  });
  host.on("cam", () => { if (hover || dr) paint(); });

  /** The selected layer on screen (view px), or null. */
  function screenRect() {
    const w = sel && host.worldRectOf(sel.id), c = host.cam;
    return w && c ? { s: { x: w.x * c.z + c.x, y: w.y * c.z + c.y, w: w.w * c.z, h: w.h * c.z }, w } : null;
  }
  const allowed = () => {
    const L = live(), al = host.autolayout;
    return !!sel && sel.id === host.sel && !editingText() && !host.hand && !(host.isLocked && host.isLocked(sel.id)) && !!L && !L.busy && !L.scaleMode
      && !(al && (al.dragging || al.handleActive)) && !(host.rotate && host.rotate.active) && !(host.crop && host.crop.active);
  };
  /** The knobs now, from the radii drawn (a drag in progress shows its value). */
  function knobList() {
    const r = screenRect();
    if (!r) return [];
    const radii = dr ? R.radii(dr.props.cornerRadius) : R.radii(sel.raw);
    return R.knobs(r.s, radii, host.cam.z, sel.flipX, sel.flipY);
  }

  // ---------- overlay ----------
  const cv = document.createElement("canvas");
  cv.id = "radiusOverlay";
  cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:3";
  view.appendChild(cv);
  const ctx = cv.getContext("2d");
  let painted = false;
  function paint() {
    const dpr = window.devicePixelRatio || 1, w = view.clientWidth, h = view.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr)); cv.style.width = w + "px"; cv.style.height = h + "px"; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (painted) ctx.clearRect(0, 0, cv.width, cv.height);
    painted = false;
    if (!sel || !host.cam || (!dr && (!hover || !allowed()))) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const list = knobList();
    for (const k of list) {
      // While dragging: only the corners that change.
      if (dr && dr.corner >= 0 && k.corner !== dr.corner) continue;
      const on = dr ? true : over && over.corner === k.corner;
      ctx.beginPath();
      ctx.arc(k.x, k.y, R.KNOB_PX + (on ? 0.5 : 0), 0, Math.PI * 2);
      ctx.fillStyle = on ? BLUE : "#fff";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = on ? "#fff" : BLUE;
      ctx.stroke();
      painted = true;
    }
    if (dr && dr.moved) { pill(dr.px + 12, dr.py + 12, "Radius " + dr.value); painted = true; }
  }
  function pill(x, y, text) {
    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    const w = Math.ceil(ctx.measureText(text).width) + 12;
    ctx.fillStyle = BLUE;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, 18, 4) : ctx.rect(x, y, w, 18); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(text, x + 6, y + 9.5);
  }

  // ---------- hover ----------
  let hover = false; // the pointer is inside the selected layer: its knobs show
  let over = null; // the knob under the pointer
  let myCursor = "";
  function setCursor(c) {
    if (c) { if (view.style.cursor !== c) view.style.cursor = c; myCursor = c; }
    else if (myCursor) { if (view.style.cursor === myCursor) view.style.cursor = ""; myCursor = ""; }
  }
  view.addEventListener("pointermove", (e) => {
    if (dr) return;
    if (e.buttons || !allowed()) { if (hover || over) { hover = false; over = null; setCursor(""); paint(); } return; }
    const r = screenRect();
    const px = e.clientX - VR.left, py = e.clientY - VR.top;
    const inside = !!r && px >= r.s.x && py >= r.s.y && px <= r.s.x + r.s.w && py <= r.s.y + r.s.h;
    const k = inside ? R.knobAt(knobList(), px, py) : null;
    const changed = inside !== hover || (k ? k.corner : -1) !== (over ? over.corner : -1);
    hover = inside; over = k;
    setCursor(k ? "pointer" : "");
    if (changed) paint();
  }, { passive: true });
  view.addEventListener("pointerleave", () => { if (!dr && (hover || over)) { hover = false; over = null; setCursor(""); paint(); } });

  // ---------- the drag ----------
  let dr = null; // {id, board, corner (-1: all), start, raw0, max, k, cx, cy, px, py, value, props, moved}
  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || !view.contains(e.target) || dr || !allowed()) return;
    const r = screenRect();
    const px = e.clientX - VR.left, py = e.clientY - VR.top;
    const k = r ? R.knobAt(knobList(), px, py) : null;
    if (!k) return;
    e.stopImmediatePropagation(); // not a move, a marquee or a click on a child
    e.preventDefault();
    const radii = R.radii(sel.raw);
    const corner = e.altKey ? k.corner : -1;
    const start = corner >= 0 ? radii[corner] : radii[k.corner];
    dr = { id: sel.id, board: sel.board, corner, start, raw0: sel.raw, max: R.maxRadius(r.w.w, r.w.h), k, cx: e.clientX, cy: e.clientY, px, py, value: start, props: { cornerRadius: sel.raw === undefined ? 0 : sel.raw }, moved: false };
    const L = live();
    if (L && L.hold) L.hold(dr.id);
    if (host.autolayout && host.autolayout.clearHover) host.autolayout.clearHover();
    try { view.setPointerCapture(e.pointerId); } catch {}
    setCursor("pointer");
    paint();
  }, true);
  addEventListener("pointermove", (e) => {
    const d = dr;
    if (!d) return;
    e.stopPropagation();
    if (!d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 2) return;
    d.moved = true;
    const snap = host.snap ? host.snap() : {};
    d.value = R.dragRadius(d.k, d.start, e.clientX - d.cx, e.clientY - d.cy, host.cam.z, d.max, snap.pixel !== false);
    // Option pressed or let go mid-drag: one corner or all four from here.
    d.corner = e.altKey ? d.k.corner : -1;
    d.props = { cornerRadius: R.radiusForm(d.raw0, d.corner, d.value) };
    d.px = e.clientX - VR.left; d.py = e.clientY - VR.top;
    const L = live();
    if (L) L.edit(d.id, d.props, [], 0);
    paint();
  }, true);
  addEventListener("pointerup", (e) => {
    const d = dr;
    if (!d) return;
    e.stopPropagation();
    end(d, !d.moved || sameRadius(d.raw0, d.props.cornerRadius));
  }, true);
  addEventListener("pointercancel", (e) => { if (dr) { e.stopPropagation(); end(dr, true); } }, true);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dr) { e.preventDefault(); e.stopPropagation(); end(dr, true); }
  }, true);
  const sameRadius = (a, b) => JSON.stringify(R.radii(a)) === JSON.stringify(R.radii(b));

  let writes = 0;
  function end(d, cancel) {
    dr = null;
    const L = live();
    if (L && L.unhold) L.unhold(d.id);
    setCursor("");
    if (cancel) {
      // Back to what the file has: the preview goes (a removed radius on an instance falls back to forgetting it).
      if (L && d.moved) {
        const ok = d.raw0 === undefined ? L.edit(d.id, {}, ["cornerRadius"], 0) : L.edit(d.id, { cornerRadius: d.raw0 }, [], 0);
        if (!ok) L.forget(d.board, [d.id]);
        if (L.noteForget) L.noteForget(d.id);
        if (host.reloadBoard) host.reloadBoard(d.board);
      }
      paint();
      return;
    }
    const op = L ? L.nextOp() : 0;
    if (L) L.edit(d.id, d.props, [], op);
    sel = sel && sel.id === d.id ? { ...sel, raw: d.props.cornerRadius } : sel;
    writes++;
    // Its own gesture id: two drags in quick succession stay two undo steps.
    const gesture = "radius-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    fetch("/api/update", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id: d.id, props: d.props, gesture }) })
      .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); }))
      .then(() => { if (L) L.ack(d.id, op, true); }, (err) => { if (L) L.ack(d.id, op, false); tell("Could not change the corner radius: " + err.message); })
      .finally(() => { writes--; if (!writes && host.writesSettled) host.writesSettled(); setTimeout(() => { if (!dr) { load(); paint(); } }, 50); });
    paint();
  }

  host.radius = {
    get active() { return !!dr; },
    pending: () => writes > 0,
    /** What the handles show now (tests and QA): the selected layer's knobs, the drag in progress. */
    get state() {
      return { id: sel ? sel.id : null, hover, knobs: sel && allowed() ? knobList().map((k) => ({ corner: k.corner, x: Math.round(k.x), y: Math.round(k.y) })) : [], drag: dr ? { corner: dr.corner, value: dr.value, moved: dr.moved } : null };
    },
  };
}
