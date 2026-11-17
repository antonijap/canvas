// Smart selection and Tidy up. Runs on window.canvasHost
// (src/server.ts) next to autolayout.js; the math is /page/smart-logic.js (node-tested).
//
// Several layers of one parent (absolutely placed), or several boards, an equal distance apart in a row, a column or
// rows (2D) are a smart selection:
// - a pink ring in the middle of each layer; click one to mark it (solid), Shift+click marks more (1D), a double-click
//   marks all (Shift+double-click: its row, in 2D);
// - drag a ring: the layer (or the marked ones, 1D) follows the pointer and a blue line shows where it goes; Cmd held
//   swaps it with the layer under the pointer (a blue outline). The rest close up, the order changes on the canvas
//   only (the layers panel keeps its order);
// - hovering the selection shows a pink handle in each gap (and between rows in 2D): drag it to change every gap at
//   once (Shift: big-nudge steps), a value label at the pointer;
// - the inspector's Spacing fields (horizontal and vertical space between) set the gaps ({smart} to the shell,
//   {cmd: "smartGap", x, y} back);
// - Cmd+D duplicates the marked layers into the list (each copy after its original), Delete removes them and the
//   rest close up.
// Control+Option+T (Arrange > Tidy Up) makes any selection of such layers an evenly spaced row, column or grid
// aligned to its top-left. Every change is one write (POST /api/move items, with the duplicate or delete in the same
// undo step), drawn at once on the canvas (live.js place, host.placeBoard). Esc cancels a drag.

import * as M from "/page/smart-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, file } = host;
  const PINK = "#F24AB5", BLUE = "#0D99FF";
  const isW = (id) => typeof id === "string" && id.startsWith("widget:");
  const editingText = () => !!(host.textEdit && host.textEdit.active);
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  const tell = (t) => { if (host.native) host.post({ toast: t }); else { const m = document.getElementById("msg"); if (m) { m.textContent = t; m.style.display = "block"; clearTimeout(tell.t); tell.t = setTimeout(() => { m.style.display = "none"; }, 4000); } else console.warn("[canvas] " + t); } };
  const post = (path, body) => fetch(path, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, ...body }) })
    .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }));
  const mergeKey = (what) => "group:" + what + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let VR = view.getBoundingClientRect();
  addEventListener("resize", () => { VR = view.getBoundingClientRect(); paint(); });
  host.on("cmd", (c) => { if (c.cmd === "insets") VR = view.getBoundingClientRect(); });
  const worldAt = (cx, cy) => { const c = host.cam; return { x: (cx - VR.left - c.x) / c.z, y: (cy - VR.top - c.y) / c.z }; };
  const toScreen = (x, y) => { const c = host.cam; return { x: x * c.z + c.x, y: y * c.z + c.y }; };
  const rectOf = (id) => (host.boards.has(id) && host.boxOf ? host.boxOf(id) : host.worldRectOf(id));

  // ---------- which selection is smart ----------
  const info = new Map(); // layer id -> {mode, parentId} (GET /api/move)
  let cur = null; // {ids, boards, model, rects: Map}
  let marked = new Set();
  let shownSpacing = "";
  const asked = new Map(); // layer id -> the GET /api/move on its way
  function infoOf(id) {
    if (info.has(id)) return info.get(id);
    ask(id);
    return null;
  }
  /** What GET /api/move says about a layer (once per selection). */
  function ask(id) {
    if (info.has(id)) return Promise.resolve(info.get(id));
    if (!asked.has(id)) asked.set(id, fetch(host.api("/api/move") + "&id=" + encodeURIComponent(id)).then((r) => r.json()).then((j) => { const v = j && j.mode ? j : null; info.set(id, v); asked.delete(id); update(); return v; }).catch(() => { asked.delete(id); return null; }));
    return asked.get(id);
  }
  /** The selection as a smart selection now, or null. */
  function compute() {
    const ids = host.selection ? host.selection() : [];
    if (ids.length < M.MIN_LAYERS || ids.some((id) => isW(id) || id.includes("/"))) return null;
    const boards = ids.every((id) => host.boards.has(id));
    if (!boards) {
      if (ids.some((id) => host.boards.has(id))) return null;
      let parent;
      for (const id of ids) {
        const j = infoOf(id);
        if (!j || j.mode !== "absolute") return null;
        if (parent === undefined) parent = j.parentId;
        else if (j.parentId !== parent) return null;
      }
    }
    const rs = ids.map((id) => { const r = rectOf(id); return r ? { id, x: r.x, y: r.y, w: r.w, h: r.h } : null; });
    if (rs.some((r) => !r)) return null;
    const model = M.detect(rs);
    return model ? { ids, boards, model, rects: new Map(rs.map((r) => [r.id, r])) } : null;
  }
  function update() {
    if (drag) return;
    cur = compute();
    for (const id of [...marked]) if (!cur || !cur.rects.has(id)) marked.delete(id);
    tellShell();
    paint();
  }
  function tellShell() {
    const s = cur ? M.spacingOf(cur.model) : null;
    const key = JSON.stringify(s);
    if (key === shownSpacing) return;
    shownSpacing = key;
    if (host.native) host.post({ smart: s });
  }
  host.on("select", () => { info.clear(); marked = new Set(); setTimeout(update, 0); });
  host.on("deselect", () => { cur = null; marked = new Set(); hover = false; tellShell(); paint(); });
  host.on("render", () => { if (!drag) update(); });
  host.on("cam", () => paint());

  // ---------- drawing ----------
  const cv = document.createElement("canvas");
  cv.id = "smartOverlay";
  cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:4";
  view.appendChild(cv);
  const ctx = cv.getContext("2d");
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1, w = view.clientWidth, h = view.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr)); cv.style.width = w + "px"; cv.style.height = h + "px"; }
  }
  const KNOB = 5; // ring radius, screen px
  const shown = () => !!cur && !host.hand && !editingText() && !(host.moving && host.moving()) && !(host.autolayout && host.autolayout.dragging) && !(host.live && (host.live.busy || host.live.scaleMode));
  /** Each layer's ring (screen), where the layer is drawn now (a dragged one follows the pointer). */
  function knobs() {
    if (!cur) return [];
    const out = [];
    for (const id of cur.ids) {
      const r = drag && drag.at && drag.at.has(id) ? drag.at.get(id) : cur.rects.get(id);
      if (!r) continue;
      const s = toScreen(r.x + r.w / 2, r.y + r.h / 2), z = host.cam.z;
      if (r.w * z < 16 || r.h * z < 16) continue; // too small on screen for a ring
      out.push({ id, x: s.x, y: s.y });
    }
    return out;
  }
  /** The spacing handles (screen): the gap's rect and its bar. */
  function handles() {
    if (!cur) return [];
    const z = host.cam.z, rects = drag && drag.type === "gap" ? drag.now : cur.rects;
    return M.gapAreas(cur.model, rects).map((a) => {
      const p = toScreen(a.rect.x, a.rect.y), s = { x: p.x, y: p.y, w: a.rect.w * z, h: a.rect.h * z };
      const along = a.axis === "x" ? s.w : s.h, across = a.axis === "x" ? s.h : s.w;
      if (across < 10) return null;
      const len = Math.min(16, across * 0.6);
      const bar = a.axis === "x" ? { x: s.x + s.w / 2 - 1, y: s.y + s.h / 2 - len / 2, w: 2, h: len } : { x: s.x + s.w / 2 - len / 2, y: s.y + s.h / 2 - 1, w: len, h: 2 };
      return { ...a, s, bar, along };
    }).filter(Boolean);
  }
  let painted = false;
  function paint() {
    sizeCanvas();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (painted) ctx.clearRect(0, 0, cv.width, cv.height);
    painted = false;
    if (!host.cam || !shown()) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The target of a ring drag: the blue line where the layer goes, or the layer it swaps with.
    if (drag && drag.type === "knob" && drag.started) {
      if (drag.swapWith) {
        const r = cur.rects.get(drag.swapWith), a = toScreen(r.x, r.y), z = host.cam.z;
        ctx.strokeStyle = BLUE; ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(r.w * z) - 1, Math.round(r.h * z) - 1);
      } else if (drag.line) {
        const p0 = toScreen(drag.line.x0, drag.line.y0), p1 = toScreen(drag.line.x1, drag.line.y1);
        ctx.strokeStyle = BLUE; ctx.lineWidth = 2; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      }
      painted = true;
    }
    // Gap handles while the pointer is over the selection (or one is being dragged).
    if ((hover && !drag) || (drag && drag.type === "gap")) {
      for (const h of handles()) {
        const on = drag && drag.type === "gap" && drag.kind === h.kind;
        ctx.fillStyle = on ? "rgba(242,74,181,0.16)" : "rgba(242,74,181,0.08)";
        ctx.fillRect(h.s.x, h.s.y, h.s.w, h.s.h);
        ctx.fillStyle = PINK;
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(h.bar.x, h.bar.y, h.bar.w, h.bar.h, 1) : ctx.rect(h.bar.x, h.bar.y, h.bar.w, h.bar.h); ctx.fill();
      }
      painted = true;
    }
    if (!(drag && drag.type === "gap")) {
      for (const k of knobs()) {
        const on = marked.has(k.id);
        ctx.beginPath(); ctx.arc(k.x, k.y, KNOB, 0, Math.PI * 2);
        ctx.fillStyle = on ? PINK : "#FFFFFF"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = PINK; ctx.stroke();
      }
      painted = true;
    }
    if (drag && drag.type === "gap" && drag.moved) { pill(drag.px + 12, drag.py + 12, String(drag.value)); painted = true; }
  }
  function pill(x, y, text) {
    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    const w = Math.ceil(ctx.measureText(text).width) + 12;
    ctx.fillStyle = PINK;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, 18, 4) : ctx.rect(x, y, w, 18); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(text, x + 6, y + 9.5);
  }

  // ---------- pointer ----------
  let hover = false, drag = null, myCursor = "";
  function setCursor(c) {
    if (c) { if (view.style.cursor !== c) view.style.cursor = c; myCursor = c; }
    else if (myCursor) { if (view.style.cursor === myCursor) view.style.cursor = ""; myCursor = ""; }
  }
  const knobAt = (px, py) => knobs().find((k) => Math.hypot(k.x - px, k.y - py) <= KNOB + 3) || null;
  const handleAt = (px, py) => handles().find((h) => px >= h.bar.x - 4 && px <= h.bar.x + h.bar.w + 4 && py >= h.bar.y - 4 && py <= h.bar.y + h.bar.h + 4) || null;
  function unionScreen() {
    if (!cur) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of cur.rects.values()) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    const a = toScreen(x0, y0), b = toScreen(x1, y1);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }
  view.addEventListener("pointermove", (e) => {
    if (drag || e.buttons || !shown()) { if (!drag && hover) { hover = false; paint(); setCursor(""); } return; }
    const px = e.clientX - VR.left, py = e.clientY - VR.top, u = unionScreen();
    const inside = !!u && px >= u.x && py >= u.y && px <= u.x + u.w && py <= u.y + u.h;
    const h = inside ? handleAt(px, py) : null;
    setCursor(h ? (h.axis === "x" ? "ew-resize" : "ns-resize") : knobAt(px, py) ? "pointer" : "");
    if (inside !== hover) { hover = inside; paint(); }
  }, { passive: true });
  view.addEventListener("pointerleave", () => { if (hover && !drag) { hover = false; paint(); setCursor(""); } });

  /** Where a layer's own x/y starts (nodes) for previews and writes. */
  function startOf(id) {
    if (cur.boards) { const r = cur.rects.get(id); return { x: r.x, y: r.y }; }
    return host.live ? host.live.ownPos(id) : null;
  }
  /** Draw layers at world positions now (a preview, held until the drop's write). */
  function preview(d, pos) {
    const L = host.live;
    for (const [id, p] of pos) {
      const r = cur.rects.get(id), o = d.own.get(id);
      if (!r || !o) continue;
      if (cur.boards) host.placeBoard(id, p.x, p.y);
      else if (L) L.place(id, o.x + p.x - r.x, o.y + p.y - r.y);
      d.placed.add(id);
    }
    host.requestFrame();
    requestAnimationFrame(() => { if (host.syncSel) host.syncSel(); });
  }
  /**
   * The dragged layers on the ghost board (shortcuts.js host.ghost: an overlay above every board, unclipped), the
   * layers themselves hidden until the drop; the selection boxes step aside meanwhile. False: they move in place.
   */
  function lift(d) {
    selBoxes(false);
    // Boards move in place (a board taken off the canvas would have to load again when it comes back).
    if (cur.boards || !host.ghost || !host.ghost.build(d.moving.map((id) => ({ id, rect: cur.rects.get(id) })))) return;
    d.lifted = true;
    if (host.live) for (const id of d.moving) host.live.hide(id);
  }
  function unlift(d) {
    selBoxes(true);
    if (!d.lifted) return;
    d.lifted = false;
    host.ghost.hide();
    if (host.live) for (const id of d.moving) host.live.unhide(id);
  }
  function selBoxes(on) {
    // The hover outline too: the page's hover does not hear this drag's pointer moves, so it would stay behind.
    for (const e of view.querySelectorAll("#sel, .mbox, #hov")) e.style.visibility = on ? "" : "hidden";
  }
  /** Back where they were (a cancelled drag, or layers a drop leaves alone). */
  function restore(d, ids) {
    for (const id of ids) {
      const r = cur && cur.rects.get(id);
      if (cur && cur.boards) { if (r) host.placeBoard(id, r.x, r.y); }
      else if (host.live) host.live.unplace(id);
      d.placed.delete(id);
    }
    host.requestFrame();
    requestAnimationFrame(() => { if (host.syncSel) host.syncSel(); });
  }

  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !view.contains(e.target) || !shown() || drag || e.ctrlKey || e.metaKey) return;
    const px = e.clientX - VR.left, py = e.clientY - VR.top;
    const k = knobAt(px, py);
    const h = k ? null : handleAt(px, py);
    if (!k && !h) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const own = new Map();
    for (const id of cur.ids) { const o = startOf(id); if (o) own.set(id, o); }
    drag = { type: k ? "knob" : "gap", id: k ? k.id : null, kind: h ? h.kind : null, axis: h ? h.axis : null, cx: e.clientX, cy: e.clientY, p0: worldAt(e.clientX, e.clientY), moved: false, started: false, shift: e.shiftKey, own, placed: new Set(), at: null, now: cur.rects, px, py, value: h ? (h.kind === "cross" ? cur.model.crossGap : cur.model.gap) : null };
    try { view.setPointerCapture(e.pointerId); } catch {}
    if (host.live && host.live.hold && !cur.boards) for (const id of cur.ids) host.live.hold(id);
  }, true);

  addEventListener("pointermove", (e) => {
    const d = drag;
    if (!d) return;
    e.stopPropagation();
    if (!d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 3) return;
    d.moved = true;
    d.px = e.clientX - VR.left; d.py = e.clientY - VR.top;
    const p = worldAt(e.clientX, e.clientY);
    if (d.type === "gap") {
      const snap = host.snap ? host.snap() : {};
      const start = d.kind === "cross" ? cur.model.crossGap : cur.model.gap;
      const travel = d.axis === "x" ? e.clientX - d.cx : e.clientY - d.cy;
      d.value = M.dragGap(start, travel, host.cam.z, e.shiftKey, snap.bigNudge || 10, snap.pixel !== false);
      const pos = d.kind === "cross" ? M.arrange(cur.model, cur.rects, cur.model.lines, cur.model.gap, d.value) : M.arrange(cur.model, cur.rects, cur.model.lines, d.value, cur.model.crossGap);
      d.pos = pos;
      d.now = new Map([...cur.rects].map(([id, r]) => [id, { ...r, ...(pos.get(id) || {}) }]));
      preview(d, pos);
      paint();
      return;
    }
    // A ring: the layer (the marked ones in 1D) follows the pointer, lifted above the rest (drawn on top).
    if (!d.started) {
      d.started = true;
      if (!marked.has(d.id)) marked = new Set([d.id]);
      d.moving = cur.model.kind === "1d" ? cur.ids.filter((id) => marked.has(id)) : [d.id];
      lift(d);
    }
    const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    d.at = new Map(d.moving.map((id) => { const r = cur.rects.get(id); return [id, { ...r, x: r.x + dx, y: r.y + dy }]; }));
    if (d.lifted) host.ghost.move(dx, dy);
    else preview(d, new Map([...d.at].map(([id, r]) => [id, { x: r.x, y: r.y }])));
    // Cmd: swap with the layer under the pointer (one layer at a time); else the slot under it.
    const over = e.metaKey && d.moving.length === 1 ? M.layerAt(cur.model, cur.rects, p, d.moving) : null;
    if (over) { d.swapWith = over; d.lines = M.swap(cur.model, d.moving[0], over); d.line = null; }
    else {
      d.swapWith = null;
      const mv = M.moveTo(cur.model, cur.rects, d.moving, p);
      d.lines = mv.lines;
      d.line = M.slotLine(cur.model, cur.rects, mv.lines, mv.slot, d.moving);
    }
    paint();
  }, true);

  addEventListener("pointerup", (e) => {
    const d = drag;
    if (!d) return;
    e.stopPropagation();
    drag = null;
    if (host.live && host.live.unhold && !cur.boards) for (const id of cur.ids) host.live.unhold(id);
    if (!d.moved) {
      if (d.type === "knob") {
        // A click on a ring marks that layer; Shift+click marks more (1D).
        if (d.shift && cur.model.kind === "1d") { if (marked.has(d.id)) marked.delete(d.id); else marked.add(d.id); }
        else marked = new Set([d.id]);
      }
      paint();
      return;
    }
    if (d.type === "gap") { commit(d, d.pos, "spacing"); return; }
    unlift(d);
    const pos = M.arrange(cur.model, cur.rects, d.lines || cur.model.lines);
    commit(d, pos, d.swapWith ? "swap" : "reorder");
  }, true);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drag) { e.preventDefault(); e.stopImmediatePropagation(); const d = drag; drag = null; unlift(d); restore(d, [...d.placed]); if (host.live && host.live.unhold && cur && !cur.boards) for (const id of cur.ids) host.live.unhold(id); paint(); }
  }, true);
  addEventListener("dblclick", (e) => {
    if (!view.contains(e.target) || !shown()) return;
    const k = knobAt(e.clientX - VR.left, e.clientY - VR.top);
    if (!k) return;
    e.stopImmediatePropagation(); e.preventDefault();
    // Double-click: every layer (1D, or the whole 2D selection); Shift+double-click in 2D: the layer's row.
    const line = cur.model.lines.find((l) => l.includes(k.id));
    marked = new Set(cur.model.kind === "2d" && e.shiftKey ? line : cur.ids);
    paint();
  }, true);

  // ---------- writes ----------
  /**
   * Put every layer at `pos` (world) in one write: drawn there now (live.js place with the write's op, boards held),
   * POST /api/move items with one merge key. `pre`: a write that goes first in the same undo step (duplicate, delete).
   */
  function commit(d, pos, what, opts = {}) {
    const rects = opts.rects || cur.rects;
    const moves = M.deltas(rects, pos);
    const extra = opts.extra || []; // moves written but not drawn first (layers the page has not drawn yet)
    const L = host.live;
    const op = L && !cur.boards ? L.nextOp() : 0;
    const moved = new Set(moves.map((m) => m.id));
    if (d) restore(d, [...d.placed].filter((id) => !moved.has(id)));
    for (const m of moves) {
      const r = rects.get(m.id), o = (d && d.own.get(m.id)) || startOf(m.id);
      if (!r) continue;
      if (cur.boards) host.placeBoard(m.id, r.x + m.dx, r.y + m.dy);
      else if (L && o) L.place(m.id, o.x + m.dx, o.y + m.dy, op);
    }
    const merge = opts.merge || mergeKey(what);
    const snap = host.snap ? host.snap() : {};
    const all = moves.concat(extra);
    const w = (all.length ? post("/api/move", { items: all, round: snap.pixel !== false, merge }) : Promise.resolve(null)).then((j) => {
      if (L && op) for (const m of moves) L.ack(m.id, op, !(j && Array.isArray(j.skipped) && j.skipped.some((s) => s.id === m.id)));
      setTimeout(update, 50);
      return j;
    }, (err) => {
      if (L && op) for (const m of moves) L.ack(m.id, op, false);
      tell("Could not " + (what === "spacing" ? "change the spacing" : what === "tidy" ? "tidy up" : "move") + ": " + err.message);
      setTimeout(update, 50);
    });
    if (host.trackWrite) host.trackWrite(w);
    paint();
    return w;
  }

  /** Tidy up: the selection as an evenly spaced row, column or grid from its top-left. */
  async function tidyUp() {
    const ids = host.selection ? host.selection() : [];
    if (ids.length < 2) { tell("Select two or more layers to tidy up"); return false; }
    if (ids.some((id) => isW(id) || id.includes("/"))) return false;
    const boards = ids.every((id) => host.boards.has(id));
    if (!boards) {
      if (ids.some((id) => host.boards.has(id))) return false;
      const js = await Promise.all(ids.map((id) => ask(id)));
      if (js.some((j) => !j || j.mode !== "absolute")) { tell("Auto layout places some of these layers; they stay"); return false; }
    }
    const rs = ids.map((id) => { const r = rectOf(id); return r ? { id, x: r.x, y: r.y, w: r.w, h: r.h } : null; });
    if (rs.some((r) => !r)) return false;
    const t = M.tidy(rs);
    if (!t) return false;
    const was = cur;
    cur = { ids, boards, model: t.model, rects: new Map(rs.map((r) => [r.id, r])) };
    commit(null, t.pos, "tidy");
    if (!was) cur = null;
    return true;
  }
  /** Spacing fields: new gaps for the smart selection. */
  function setGaps(v) {
    if (!cur) return;
    const g = M.gapsFrom(cur.model, v);
    if (g.gap === cur.model.gap && g.crossGap === cur.model.crossGap) return;
    commit(null, M.arrange(cur.model, cur.rects, cur.model.lines, g.gap, g.crossGap), "spacing");
  }
  /** Layers in the file's order: their parent's children (one parent), or the boards'. */
  function docOrder(c, ids) {
    let all = null;
    if (c.boards) all = [...host.boards.keys()];
    else if (host.live) {
      const board = host.live.boardOf(ids[0]), scene = board ? host.live.sceneOf(board) : null;
      const find = (n) => { if (!n || typeof n !== "object") return null; for (const k of n.children || []) { if (k && k.id === ids[0]) return n; const f = find(k); if (f) return f; } return null; };
      const parent = scene ? find(scene.root) : null;
      if (parent) all = parent.children.map((k) => k.id);
    }
    return all ? ids.slice().sort((a, b) => all.indexOf(a) - all.indexOf(b)) : ids;
  }
  /** Cmd+D on marked layers: copies after their originals, the list re-spaced; one undo step. */
  async function duplicateMarked() {
    const c = cur, ids = c.ids.filter((id) => marked.has(id));
    const merge = mergeKey("smart-dup");
    const copies = new Map();
    // One duplicate (a second structure write would be a second undo step). Its copies come back in the file's
    // order of their originals (src/structure.ts normalize): the parent's children, or the boards.
    const order = docOrder(c, ids);
    try {
      const j = await post("/api/structure", { page: host.page || undefined, op: "duplicate", ids: order, offset: { dx: 0, dy: 0 }, merge });
      if (Array.isArray(j.select) && j.select.length === order.length) order.forEach((id, i) => copies.set(id, j.select[i]));
    } catch (err) { tell("Could not duplicate: " + err.message); return; }
    if (copies.size !== order.length) { setTimeout(update, 50); return; }
    // The copies sit on their originals (offset 0); the list is laid out again with each copy after its original.
    const rects = new Map(c.rects);
    for (const [id, cp] of copies) rects.set(cp, { ...c.rects.get(id), id: cp });
    const lines = M.withCopies(c.model, copies);
    const pos = M.arrange({ ...c.model, lines }, rects, lines);
    const made = new Set(copies.values());
    cur = { ...c, rects };
    // The originals draw where they go now; the copies (not on the page's boards yet) when the write lands.
    return commit(null, new Map([...pos].filter(([id]) => !made.has(id))), "duplicate", { merge, rects, extra: M.deltas(rects, new Map([...pos].filter(([id]) => made.has(id)))) }).then(() => {
      host.setSelection([...c.ids, ...made]);
      setTimeout(() => { marked = new Set(made); update(); }, 60);
    });
  }
  /** Delete on marked layers: they go and the rest close up; one undo step. */
  async function deleteMarked() {
    const c = cur, ids = c.ids.filter((id) => marked.has(id));
    const rest = c.ids.filter((id) => !marked.has(id));
    const merge = mergeKey("smart-delete");
    const pos = M.arrange(c.model, c.rects, M.without(c.model, ids));
    marked = new Set();
    if (c.boards && host.hideBoards) host.hideBoards(ids);
    host.setSelection(rest);
    try { await post("/api/structure", { page: host.page || undefined, op: "delete", ids, merge }); }
    catch (err) { if (c.boards && host.restoreBoards) host.restoreBoards(ids); tell("Could not delete: " + err.message); return; }
    cur = c;
    return commit(null, pos, "delete", { merge });
  }
  /**
   * The whole of a Cmd+D or Delete on marked layers (the structure write, then the move that re-spaces the row) is
   * one pending write from its start: Undo and Redo wait for both, or an Undo pressed while the first is on its way
   * runs between them and the move lands after it.
   */
  function tracked(p) {
    if (host.trackWrite) host.trackWrite(p.catch(() => {}));
    return p;
  }
  host.smart = {
    tidy: tidyUp, setGaps,
    /** structure.js asks before Cmd+D and Delete: true when marked layers of a smart selection take them. */
    intercept(op) {
      if (!cur || !marked.size || drag) return false;
      if (op === "duplicate") { tracked(duplicateMarked()); return true; }
      if (op === "delete") { tracked(deleteMarked()); return true; }
      return false;
    },
    get state() { return cur ? { kind: cur.model.kind, axis: cur.model.axis, lines: cur.model.lines.map((l) => l.slice()), gap: cur.model.gap, crossGap: cur.model.crossGap, marked: [...marked] } : null; },
    /** Rings and handles on screen (view px), for QA. */
    knobs: () => knobs(),
    handles: () => handles().map((h) => ({ kind: h.kind, axis: h.axis, bar: h.bar })),
    get dragging() { return !!drag; },
  };
  host.on("cmd", (c) => {
    if (c.cmd === "smartGap") setGaps({ x: typeof c.x === "number" ? c.x : null, y: typeof c.y === "number" ? c.y : null });
    else if (c.cmd === "shortcut" && c.op === "tidy") tidyUp();
  });
  // Control+Option+T: Tidy up (the app's Arrange menu sends {cmd: "shortcut", op: "tidy"}).
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || typing(e.target) || editingText() || e.repeat) return;
    if (e.code === "KeyT" && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); tidyUp(); }
  });
}
