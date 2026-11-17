// Zoom and view (numbers in /page/navigate-logic.js):
// - Shift+= / Shift+- zoom in and out about the middle of the free area (Cmd+= / Cmd+- stay server.ts's and the
//   View menu's).
// - Arrow keys with nothing selected pan the canvas; Shift pans further.
// - Z held: the zoom tool. A click zooms in 2x about the pointer, Option+click zooms out; nothing is selected or
//   moved while Z is down.
// - The pixel grid: lines between the whole pixels from 400% up, on by default; Cmd+' (View > Pixel Grid) toggles.
// - Rulers (Shift+R, View > Rulers): canvas coordinates along the top and left of the free area, the selection's
//   extent marked. Drag out of a ruler onto a board to add a guide there (saved on the board, metadata.canvasGuides,
//   one undo step); drag a guide to move it, back onto the ruler or off the board to remove it.
// - Layout guides (Control+G or Shift+G;
//   View > Layout Guides): a frame's grid, columns and rows (metadata.canvasLayoutGuides, src/page/layout-guides-logic.js)
//   drawn over the canvas; a layer moved or resized inside such a frame snaps to its column and row edges and grid
//   lines while they show.
// The app's View menu sends {cmd: "nav", op: "grid" | "rulers" | "layoutGuides"}; the page answers
// {view: {pixelGrid, rulers, layoutGuides}}.
// host.nav: the state and the drawn guides, for QA.

import * as N from "/page/navigate-logic.js";
import * as LG from "/page/layout-guides-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const view = host.view;
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || (t.closest && t.closest("[contenteditable]")));
  const editingText = () => !!(host.textEdit && host.textEdit.active);
  const selected = () => (host.selection ? host.selection().length > 0 : !!host.sel);
  const ins = () => host.insets || { l: 0, t: 0, r: 0, b: 0 };
  const store = (k, d) => { try { const v = localStorage.getItem("canvas." + k); return v === null ? d : v === "1"; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem("canvas." + k, v ? "1" : "0"); } catch {} };
  const state = { pixelGrid: store("pixelGrid", true), rulers: store("rulers", false), layoutGuides: store("layoutGuides", true), zoomTool: false };
  const tellShell = () => { if (host.native) host.post({ view: { pixelGrid: state.pixelGrid, rulers: state.rulers, layoutGuides: state.layoutGuides } }); };

  // ---------- zoom and pan ----------
  function zoomBy(k, px, py) {
    const c = host.cam;
    if (!c) return;
    const i = ins();
    const x = px ?? i.l + (view.clientWidth - i.l - i.r) / 2, y = py ?? i.t + (view.clientHeight - i.t - i.b) / 2;
    host.setCam(N.zoomAbout(c, c.z * k, x, y));
  }
  function pan(dx, dy) { const c = host.cam; if (c) host.setCam({ ...c, x: c.x + dx, y: c.y + dy }); }

  // ---------- pixel grid ----------
  const grid = document.createElement("canvas");
  grid.id = "pixelGrid";
  grid.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;display:none";
  const world = document.getElementById("world");
  view.insertBefore(grid, world ? world.nextSibling : null);
  function drawGrid() {
    const c = host.cam;
    const on = state.pixelGrid && c && c.z >= N.PIXEL_GRID_ZOOM;
    grid.style.display = on ? "block" : "none";
    if (!on) return;
    const w = view.clientWidth, h = view.clientHeight, dpr = devicePixelRatio || 1;
    if (grid.width !== Math.round(w * dpr) || grid.height !== Math.round(h * dpr)) {
      grid.width = Math.round(w * dpr); grid.height = Math.round(h * dpr);
      grid.style.width = w + "px"; grid.style.height = h + "px";
    }
    const g = grid.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.beginPath();
    for (const x of N.gridLines(c.x, c.z, w)) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (const y of N.gridLines(c.y, c.z, h)) { g.moveTo(0, y); g.lineTo(w, y); }
    // Neutral grey at low alpha: visible on light and dark canvases and on any fill.
    g.strokeStyle = "rgba(128,128,128,0.28)";
    g.lineWidth = 1 / dpr;
    g.stroke();
  }

  // ---------- layout guides ----------
  const lgLayer = document.createElement("canvas");
  lgLayer.id = "layoutGuides";
  lgLayer.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;display:none";
  view.insertBefore(lgLayer, grid.nextSibling);
  let lgDrawn = []; // frames drawn: {id, x, y, w, h (world), guides}
  /** Frames with layout guides on the boards drawn now, with their world boxes. */
  function lgFrames() {
    const out = [];
    for (const b of host.doc && host.doc.boards ? host.doc.boards : []) {
      if (!b.layoutGuides || !host.boards.has(b.id)) continue;
      for (const f of b.layoutGuides) {
        const r = f.id === b.id ? host.boxOf(b.id) : host.worldRectOf(f.id);
        if (r && r.w > 0 && r.h > 0) out.push({ id: f.id, x: r.x, y: r.y, w: r.w, h: r.h, guides: f.guides.map(LG.cleanGuide).filter(Boolean) });
      }
    }
    return out;
  }
  function drawLayoutGuides() {
    const c = host.cam;
    const frames = state.layoutGuides && c ? lgFrames() : [];
    lgDrawn = frames;
    const any = frames.some((f) => f.guides.some((g) => g.visible !== false));
    lgLayer.style.display = any ? "block" : "none";
    if (!any) return;
    const w = view.clientWidth, h = view.clientHeight, dpr = devicePixelRatio || 1;
    const g = sizeCanvas(lgLayer, w, h);
    for (const f of frames) {
      const fx = c.x + f.x * c.z, fy = c.y + f.y * c.z, fw = f.w * c.z, fh = f.h * c.z;
      if (fx > w || fy > h || fx + fw < 0 || fy + fh < 0) continue;
      g.save();
      g.beginPath(); g.rect(fx, fy, fw, fh); g.clip();
      for (const gd of f.guides) {
        if (gd.visible === false) continue;
        const sh = LG.shapes(gd, f.w, f.h);
        g.fillStyle = g.strokeStyle = LG.cssColor(gd.color);
        for (const r of sh.rects) g.fillRect(fx + r.x * c.z, fy + r.y * c.z, r.w * c.z, r.h * c.z);
        // Grid lines a device pixel wide; too dense to read (under 3 screen px apart) they are left out.
        if (sh.lines.length && gd.size * c.z >= 3) {
          g.lineWidth = 1 / dpr;
          g.beginPath();
          for (const l of sh.lines) {
            const p = Math.round((l.axis === "x" ? fx + l.at * c.z : fy + l.at * c.z) * dpr) / dpr + 0.5 / dpr;
            if (l.axis === "x") { g.moveTo(p, fy); g.lineTo(p, fy + fh); } else { g.moveTo(fx, p); g.lineTo(fx + fw, p); }
          }
          g.stroke();
        }
      }
      g.restore();
    }
  }
  /** What a layer moving inside `parentId` snaps to (src/server.ts candsFor): its frame's guide lines, while shown. */
  host.layoutGuideRects = (parentId) => {
    if (!state.layoutGuides || !parentId) return [];
    const f = lgFrames().find((x) => x.id === parentId);
    return f ? LG.snapRects(f, f.guides) : [];
  };

  // ---------- rulers and guides ----------
  const mk = (id, css) => { const e = document.createElement("canvas"); e.id = id; e.style.cssText = css; view.append(e); return e; };
  const top = mk("rulerTop", "position:absolute;display:none;cursor:row-resize;z-index:2;box-shadow:0 1px 2px #0000001f,0 0 0 0.5px var(--c-island-rim)");
  const left = mk("rulerLeft", "position:absolute;display:none;cursor:col-resize;z-index:2;box-shadow:1px 0 2px #0000001f,0 0 0 0.5px var(--c-island-rim)");
  const corner = document.createElement("div");
  corner.id = "rulerCorner";
  corner.style.cssText = "position:absolute;display:none;z-index:2;background:var(--c-island);box-shadow:0 0 0 0.5px var(--c-island-rim)";
  view.append(corner);
  const guideLayer = mk("rulerGuides", "position:absolute;left:0;top:0;pointer-events:none;display:none;z-index:1");
  let drawn = []; // guides on screen: {board, index, axis, at, from, to}
  let drag = null; // {axis, board?, index?, at (view px)}
  const cssVar = (n, d) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;
  const GUIDE = "#F24822"; // Guide red; selection blue stays the canvas selection's

  function sizeCanvas(cv, w, h) {
    const dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    cv.style.width = w + "px"; cv.style.height = h + "px";
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return g;
  }

  function selExtent() {
    const ids = host.selection ? host.selection() : [];
    const rs = ids.map((id) => host.worldRectOf(id)).filter(Boolean);
    if (!rs.length) return null;
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    return { x0, y0, x1: Math.max(...rs.map((r) => r.x + r.w)), y1: Math.max(...rs.map((r) => r.y + r.h)) };
  }

  function drawRuler(cv, axis, len) {
    const c = host.cam, i = ins(), R = N.RULER;
    const along = axis === "x" ? len - i.l - i.r - R : len - i.t - i.b - R;
    const g = axis === "x" ? sizeCanvas(cv, Math.max(0, along), R) : sizeCanvas(cv, R, Math.max(0, along));
    const fg = cssVar("--c-muted-fg", "#71717A"), bg = cssVar("--c-island", "#FFFFFF");
    g.fillStyle = bg;
    g.fillRect(0, 0, axis === "x" ? along : R, axis === "x" ? R : along);
    const start = axis === "x" ? i.l + R : i.t + R; // where this ruler begins, in view px
    const off = (axis === "x" ? c.x : c.y) - start;
    // The selection's extent, tinted.
    const e = selExtent();
    if (e) {
      const a = off + (axis === "x" ? e.x0 : e.y0) * c.z, b = off + (axis === "x" ? e.x1 : e.y1) * c.z;
      g.fillStyle = cssVar("--c-sel", "#0766EB") + "26";
      if (axis === "x") g.fillRect(a, 0, b - a, R); else g.fillRect(0, a, R, b - a);
    }
    const { step, ticks } = N.rulerTicks(off, c.z, along);
    g.strokeStyle = fg; g.fillStyle = fg; g.lineWidth = 1;
    g.font = "9px -apple-system, system-ui, sans-serif";
    g.beginPath();
    for (const t of ticks) {
      const p = Math.round(t.at) + 0.5;
      if (axis === "x") { g.moveTo(p, R); g.lineTo(p, R - 6); } else { g.moveTo(R, p); g.lineTo(R - 6, p); }
      // Minor ticks at a fifth (or half) of the step.
      const sub = String(step).startsWith("5") ? 5 : 2;
      for (let k = 1; k < (sub === 5 ? 5 : 2); k++) {
        const q = Math.round(t.at + (k * step * c.z) / (sub === 5 ? 5 : 2)) + 0.5;
        if (axis === "x") { g.moveTo(q, R); g.lineTo(q, R - 3); } else { g.moveTo(R, q); g.lineTo(R - 3, q); }
      }
      const label = String(t.value);
      if (axis === "x") g.fillText(label, p + 3, 9);
      else { g.save(); g.translate(9, p - 3); g.rotate(-Math.PI / 2); g.fillText(label, 0, 0); g.restore(); }
    }
    g.globalAlpha = 0.5;
    g.stroke();
    g.globalAlpha = 1;
  }

  function boardBoxes() {
    const out = [];
    for (const b of host.doc && host.doc.boards ? host.doc.boards : []) {
      if (!host.boards.has(b.id)) continue;
      const r = host.boxOf(b.id);
      if (r) out.push({ id: b.id, x: r.x, y: r.y, w: r.w, h: r.h, guides: b.guides || [] });
    }
    return out;
  }

  function drawGuides() {
    const c = host.cam;
    drawn = [];
    const w = view.clientWidth, h = view.clientHeight;
    const boards = boardBoxes();
    const any = boards.some((b) => b.guides.length) || drag;
    guideLayer.style.display = any ? "block" : "none";
    if (!any || !c) return;
    const g = sizeCanvas(guideLayer, w, h);
    g.strokeStyle = GUIDE; g.lineWidth = 1;
    g.beginPath();
    for (const b of boards) {
      b.guides.forEach((gd, index) => {
        if (drag && drag.board === b.id && drag.index === index) return; // drawn where it is being dragged
        const at = gd.axis === "x" ? c.x + (b.x + gd.at) * c.z : c.y + (b.y + gd.at) * c.z;
        const from = gd.axis === "x" ? c.y + b.y * c.z : c.x + b.x * c.z;
        const to = gd.axis === "x" ? c.y + (b.y + b.h) * c.z : c.x + (b.x + b.w) * c.z;
        drawn.push({ board: b.id, index, axis: gd.axis, at, from, to, value: gd.at });
        const p = Math.round(at) + 0.5;
        if (gd.axis === "x") { g.moveTo(p, from); g.lineTo(p, to); } else { g.moveTo(from, p); g.lineTo(to, p); }
      });
    }
    if (drag) {
      const p = Math.round(drag.at) + 0.5;
      if (drag.axis === "x") { g.moveTo(p, 0); g.lineTo(p, h); } else { g.moveTo(0, p); g.lineTo(w, p); }
    }
    g.stroke();
    if (drag && drag.label) {
      g.font = "11px -apple-system, system-ui, sans-serif";
      const t = drag.label, tw = g.measureText(t).width + 10;
      const x = drag.axis === "x" ? drag.at + 6 : drag.px + 10, y = drag.axis === "x" ? drag.py + 10 : drag.at + 6;
      g.fillStyle = GUIDE; g.fillRect(x, y, tw, 18);
      g.fillStyle = "#FFFFFF"; g.fillText(t, x + 5, y + 13);
    }
  }

  function drawRulers() {
    const show = state.rulers;
    for (const e of [top, left, corner]) e.style.display = show ? "block" : "none";
    if (!show || !host.cam) return;
    const i = ins(), R = N.RULER;
    Object.assign(top.style, { left: i.l + R + "px", top: i.t + "px" });
    Object.assign(left.style, { left: i.l + "px", top: i.t + R + "px" });
    Object.assign(corner.style, { left: i.l + "px", top: i.t + "px", width: R + "px", height: R + "px" });
    drawRuler(top, "x", view.clientWidth);
    drawRuler(left, "y", view.clientHeight);
  }

  let raf = 0;
  const redraw = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; drawGrid(); drawLayoutGuides(); drawRulers(); drawGuides(); }); };
  const redrawNow = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } drawGrid(); drawLayoutGuides(); drawRulers(); drawGuides(); };
  for (const ev of ["cam", "select", "deselect", "page", "render", "visible", "prefs"]) host.on(ev, redraw);
  addEventListener("resize", redraw);

  // ---------- guide drags ----------
  const toWorld = (px, py) => { const c = host.cam; return { x: (px - c.x) / c.z, y: (py - c.y) / c.z }; };
  const viewPt = (e) => { const r = view.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const snapOn = () => true; // guides sit on whole pixels

  async function saveGuides(board, guides, gesture) {
    const id = board;
    let meta = null;
    try {
      const j = await (await fetch(host.api("/api/node") + "&id=" + encodeURIComponent(id) + "&depth=0")).json();
      meta = j && j.node ? j.node.metadata : null;
    } catch {}
    const m = N.withGuides(meta, guides);
    // Each drag is its own undo step: a quick second drag on the same board must not merge into the first.
    const body = { file: host.file, id, gesture, ...(m ? { props: { metadata: m } } : { props: {}, remove: ["metadata"] }) };
    const r = await fetch("/api/update", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { let msg = r.statusText; try { msg = (await r.json()).error || msg; } catch {} throw new Error(msg); }
    // Drawn at once from the doc meta; the document event confirms it.
    const b = host.doc && host.doc.boards.find((x) => x.id === id);
    if (b) { if (guides.length) b.guides = guides.map((g) => ({ axis: g.axis, at: g.at })); else delete b.guides; }
  }
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };

  function beginDrag(e, d) {
    e.preventDefault();
    e.stopPropagation();
    const p = viewPt(e);
    drag = { ...d, at: d.axis === "x" ? p.x : p.y, px: p.x, py: p.y };
    const move = (ev) => {
      const q = viewPt(ev);
      drag.px = q.x; drag.py = q.y;
      drag.at = drag.axis === "x" ? q.x : q.y;
      const w = toWorld(q.x, q.y);
      const hit = N.dropGuide(drag.axis, w, boardBoxes(), snapOn());
      drag.label = hit ? String(hit.at) : "";
      drawGuides();
    };
    const up = (ev) => {
      removeEventListener("pointermove", move, true);
      removeEventListener("pointerup", up, true);
      const q = viewPt(ev), d0 = drag;
      drag = null;
      const i = ins(), R = N.RULER;
      const onRuler = state.rulers && (d0.axis === "x" ? q.x < i.l + R : q.y < i.t + R);
      const hit = onRuler ? null : N.dropGuide(d0.axis, toWorld(q.x, q.y), boardBoxes(), snapOn());
      const boards = boardBoxes();
      const lists = new Map(boards.map((b) => [b.id, b.guides.map((g) => ({ ...g }))]));
      const changed = new Set();
      if (d0.board !== undefined) { lists.get(d0.board)?.splice(d0.index, 1); changed.add(d0.board); }
      if (hit) { lists.get(hit.board).push({ axis: d0.axis, at: hit.at }); changed.add(hit.board); }
      drawGuides();
      if (!changed.size) return;
      const gesture = "guide-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      (async () => { for (const b of changed) await saveGuides(b, lists.get(b), gesture); })().then(redraw).catch((err) => { tell("Could not save the guide: " + err.message); redraw(); });
    };
    addEventListener("pointermove", move, true);
    addEventListener("pointerup", up, true);
    drawGuides();
  }
  // Out of a ruler: the top ruler makes a horizontal guide (it sets y), the left one a vertical guide (x).
  top.addEventListener("pointerdown", (e) => { if (e.button === 0) beginDrag(e, { axis: "y" }); });
  left.addEventListener("pointerdown", (e) => { if (e.button === 0) beginDrag(e, { axis: "x" }); });
  // An existing guide under the pointer: dragging it moves it (the canvas's own press is stopped first).
  view.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || state.zoomTool || !drawn.length || host.hand) return;
    const p = viewPt(e), g = N.guideAt(drawn, p.x, p.y);
    if (g) beginDrag(e, { axis: g.axis, board: g.board, index: g.index });
  }, true);
  view.addEventListener("pointermove", (e) => {
    if (drag || !drawn.length) return;
    const p = viewPt(e), g = N.guideAt(drawn, p.x, p.y);
    view.style.cursor = g ? (g.axis === "x" ? "col-resize" : "row-resize") : state.zoomTool ? (e.altKey ? "zoom-out" : "zoom-in") : "";
  });

  // ---------- zoom tool ----------
  function zoomTool(on) {
    if (state.zoomTool === on) return;
    state.zoomTool = on;
    view.style.cursor = on ? "zoom-in" : "";
  }
  // Capture: with Z down a click zooms and nothing else (no pick, no move, no marquee) runs.
  for (const type of ["pointerdown", "pointerup", "click", "dblclick"]) {
    view.addEventListener(type, (e) => {
      if (!state.zoomTool || e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (type === "pointerdown") { const p = viewPt(e); zoomBy(e.altKey ? 0.5 : 2, p.x, p.y); }
    }, true);
  }

  // ---------- keys ----------
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || typing(e.target) || editingText()) return;
    if (e.code === "KeyZ" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      zoomTool(true);
      view.style.cursor = e.altKey ? "zoom-out" : "zoom-in";
      return;
    }
    if (state.zoomTool && e.key === "Alt") { view.style.cursor = "zoom-out"; return; }
    const k = N.navKey(e, { selected: selected() });
    if (!k) return;
    if (k.op === "grid" && host.native) return; // the View menu owns Cmd+' in the app
    if (k.op === "layoutGuides" && e.ctrlKey && host.native) return; // and Control+G
    e.preventDefault();
    run(k);
  });
  addEventListener("keyup", (e) => {
    if (e.code === "KeyZ") zoomTool(false);
    else if (e.key === "Alt" && state.zoomTool) view.style.cursor = "zoom-in";
  });
  addEventListener("blur", () => zoomTool(false));

  function run(k) {
    if (k.op === "in") zoomBy(2);
    else if (k.op === "out") zoomBy(0.5);
    else if (k.op === "pan") pan(k.dx, k.dy);
    else if (k.op === "grid") { state.pixelGrid = !state.pixelGrid; save("pixelGrid", state.pixelGrid); redrawNow(); tellShell(); }
    else if (k.op === "rulers") { state.rulers = !state.rulers; save("rulers", state.rulers); redrawNow(); tellShell(); }
    else if (k.op === "layoutGuides") { state.layoutGuides = !state.layoutGuides; save("layoutGuides", state.layoutGuides); redrawNow(); tellShell(); }
  }
  host.on("cmd", (c) => { if (c && c.cmd === "nav" && typeof c.op === "string") run({ op: c.op, dx: c.dx, dy: c.dy }); });

  host.nav = { state, get guides() { return drawn.map((g) => ({ ...g })); }, get layoutGuides() { return lgDrawn.map((f) => ({ ...f })); }, redraw: redrawNow, run };
  tellShell();
  redraw();
}
