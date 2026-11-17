// Crop an image on the canvas: double-click a selected layer whose top fill is an image (or pick Crop
// in its paint popover) and the whole image shows, dimmed outside the layer, with a handle on each corner. Drag
// the image to move it inside the layer, drag a corner to scale it (its aspect kept, the opposite corner fixed).
// Return, Esc or a click outside the image ends it; the fill becomes Crop at the image's fractions of the layer
// (`mode: "crop", crop: {x, y, width, height}`), one write and one undo step. The engine draws the crop live
// (live.js raw edits); the overlay draws the image around it. Pure math in /page/image-crop-logic.js.

import * as C from "/page/image-crop-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, file } = host;
  const BLUE = "#0D99FF";
  const live = () => host.live || null;
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };
  let VR = view.getBoundingClientRect();
  addEventListener("resize", () => { VR = view.getBoundingClientRect(); paint(); });
  host.on("cmd", (c) => {
    if (c.cmd === "insets") VR = view.getBoundingClientRect();
    if (c.cmd === "cropImage" && typeof c.id === "string") begin(c.id);
  });

  const cv = document.createElement("canvas");
  cv.id = "cropOverlay";
  cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:4";
  view.appendChild(cv);
  const ctx = cv.getContext("2d");
  // While cropping, the layer's selection box and size give way to the crop's own handles.
  const css = document.createElement("style");
  css.textContent = "body.canvas-cropping #sel{visibility:hidden}";
  document.head.appendChild(css);
  const cropping = (on) => document.body.classList.toggle("canvas-cropping", on);

  /** {id, board, raw (the file's fill), index, f, crop, img, iw, ih, w, h, sceneFill} while cropping. */
  let cr = null;
  let drag = null; // {corner (-1: pan), x, y, crop0}

  function findIn(root, id) {
    if (!root || typeof root !== "object") return null;
    if (String(root.id) === id) return root;
    for (const c of Array.isArray(root.children) ? root.children : []) { const hit = findIn(c, id); if (hit) return hit; }
    return null;
  }

  /** The layer under a double-click: the selected one, when its top fill is an image and it is not turned. */
  async function begin(id) {
    const L = live();
    if (!L || cr || !id || id.includes("/") || id.startsWith("widget:")) return false;
    const board = L.boardOf(id), scene = board && L.sceneOf(board), sn = scene && findIn(scene.root, id);
    if (!sn || Number(sn.rotation || 0) % 360 !== 0 || (Array.isArray(sn.children) && sn.children.length)) return false;
    const st = C.topImage(sn.fill);
    if (!st) return false;
    const j = await fetch(host.api("/api/node") + "&id=" + encodeURIComponent(id) + "&depth=0").then((r) => r.json()).catch(() => null);
    const raw = j && j.node ? j.node.fill : undefined;
    const top = C.topImage(raw);
    if (!top) return false;
    const r = host.worldRectOf(id);
    if (!r) return false;
    const img = new Image();
    img.src = String(st.fill.url).replace(/#.*$/, "");
    try { await img.decode(); } catch { tell("Could not load the image to crop"); return false; }
    const crop = C.cropOf(top.fill, r.w, r.h, img.naturalWidth, img.naturalHeight);
    cr = { id, board, raw, index: top.index, sceneList: st.list, sceneIndex: st.index, f: top.fill, crop, crop0: crop, img, w: r.w, h: r.h, changed: top.fill.mode !== "crop" };
    if (L.hold) L.hold(id);
    cropping(true);
    preview();
    paint();
    return true;
  }

  /** The engine draws the crop now (a raw scene edit, the scene's own URLs). */
  function preview(op = 0) {
    const L = live();
    if (!L || !cr) return;
    const list = cr.sceneList.slice();
    list[cr.sceneIndex] = { ...list[cr.sceneIndex], mode: "crop", crop: cr.crop };
    L.raw(cr.board, cr.id, { fill: list }, [], op);
  }

  function end(cancel) {
    const d = cr;
    cr = null; drag = null;
    cropping(false);
    paint();
    if (!d) return;
    const L = live();
    if (L && L.unhold) L.unhold(d.id);
    if (cancel || (!d.changed && JSON.stringify(d.crop) === JSON.stringify(d.crop0))) {
      if (L) { L.forget(d.board, [d.id]); if (host.reloadBoard) host.reloadBoard(d.board); }
      return;
    }
    const op = L ? L.nextOp() : 0;
    if (L) { cr = d; preview(op); cr = null; }
    const props = { fill: C.withCrop(d.raw, d.index, d.crop) };
    fetch("/api/update", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id: d.id, props, gesture: "crop-" + Date.now().toString(36) }) })
      .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); }))
      .then(() => { if (L) L.ack(d.id, op, true); }, (err) => { if (L) L.ack(d.id, op, false); tell("Could not crop the image: " + err.message); });
  }

  /** The layer and the image on screen (view px). */
  function rects() {
    const r = cr && host.worldRectOf(cr.id), c = host.cam;
    if (!r || !c) return null;
    const box = { x: r.x * c.z + c.x, y: r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z };
    const im = { x: box.x + cr.crop.x * box.w, y: box.y + cr.crop.y * box.h, w: cr.crop.width * box.w, h: cr.crop.height * box.h };
    return { box, im };
  }

  function paint() {
    const dpr = window.devicePixelRatio || 1, w = view.clientWidth, h = view.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr)); cv.style.width = w + "px"; cv.style.height = h + "px"; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const q = cr && rects();
    if (!q) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { box, im } = q;
    // The image outside the layer, dimmed (the engine draws the part inside).
    ctx.save();
    ctx.beginPath();
    ctx.rect(im.x - 1, im.y - 1, im.w + 2, im.h + 2);
    ctx.rect(box.x, box.y, box.w, box.h); // even-odd: a hole where the layer is
    ctx.clip("evenodd");
    ctx.globalAlpha = 0.45;
    const t = C.turns(cr.f);
    ctx.translate(im.x + im.w / 2, im.y + im.h / 2);
    ctx.rotate((t * Math.PI) / 2);
    const [dw, dh] = t % 2 ? [im.h, im.w] : [im.w, im.h];
    ctx.drawImage(cr.img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = BLUE;
    ctx.strokeRect(Math.round(im.x) + 0.5, Math.round(im.y) + 0.5, Math.round(im.w), Math.round(im.h));
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(box.x) + 0.5, Math.round(box.y) + 0.5, Math.round(box.w), Math.round(box.h));
    ctx.setLineDash([]);
    for (const [x, y] of [[im.x, im.y], [im.x + im.w, im.y], [im.x + im.w, im.y + im.h], [im.x, im.y + im.h]]) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8);
      ctx.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7);
    }
  }
  host.on("cam", () => { if (cr) paint(); });

  // Double-click a selected image layer (capture: before text editing and the drill-down select).
  view.addEventListener("dblclick", (e) => {
    if (cr || e.metaKey || e.shiftKey || e.altKey) return;
    const id = host.sel;
    if (!id || (host.selection && host.selection().length > 1)) return;
    const r = host.worldRectOf(id), c = host.cam;
    if (!r || !c) return;
    const px = e.clientX - VR.left, py = e.clientY - VR.top;
    const s = { x: r.x * c.z + c.x, y: r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z };
    if (px < s.x || py < s.y || px > s.x + s.w || py > s.y + s.h) return;
    const L = live(), board = L && L.boardOf(id), scene = board && L.sceneOf(board), sn = scene && findIn(scene.root, id);
    if (!sn || !C.topImage(sn.fill) || (Array.isArray(sn.children) && sn.children.length)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    begin(id);
  }, true);

  addEventListener("pointerdown", (e) => {
    if (!cr || e.button !== 0) return;
    const q = rects();
    if (!q) return;
    const px = e.clientX - VR.left, py = e.clientY - VR.top;
    const corner = C.cornerAt(q.im, px, py, 8);
    const inside = px >= q.im.x && py >= q.im.y && px <= q.im.x + q.im.w && py <= q.im.y + q.im.h;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (corner < 0 && !inside) { end(false); return; }
    drag = { corner, x: e.clientX, y: e.clientY, crop0: cr.crop };
    try { view.setPointerCapture(e.pointerId); } catch {}
  }, true);
  addEventListener("pointermove", (e) => {
    if (!cr) return;
    if (!drag) {
      const q = rects();
      if (q) {
        const px = e.clientX - VR.left, py = e.clientY - VR.top;
        const k = C.cornerAt(q.im, px, py, 8);
        view.style.cursor = k === 0 || k === 2 ? "nwse-resize" : k === 1 || k === 3 ? "nesw-resize" : px >= q.im.x && py >= q.im.y && px <= q.im.x + q.im.w && py <= q.im.y + q.im.h ? "move" : "";
      }
      return;
    }
    e.stopImmediatePropagation();
    const z = host.cam.z, dx = (e.clientX - drag.x) / z, dy = (e.clientY - drag.y) / z;
    cr.crop = drag.corner < 0 ? C.panned(drag.crop0, dx, dy, cr.w, cr.h) : C.scaled(drag.crop0, drag.corner, dx, dy, cr.w, cr.h);
    preview();
    paint();
  }, true);
  addEventListener("pointerup", (e) => { if (cr && drag) { e.stopImmediatePropagation(); drag = null; view.style.cursor = ""; } }, true);
  addEventListener("click", (e) => { if (cr) e.stopImmediatePropagation(); }, true);
  addEventListener("keydown", (e) => {
    if (!cr) return;
    if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); end(false); }
  }, true);
  host.on("deselect", () => { if (cr) end(false); });

  host.crop = {
    begin,
    get active() { return !!cr; },
    end: () => end(false),
    /** For tests and QA: the crop now and, in window px, the layer (box) and the image (im). */
    get state() {
      const q = cr && rects();
      const w = (r) => ({ x: r.x + VR.left, y: r.y + VR.top, w: r.w, h: r.h });
      return cr ? { id: cr.id, crop: { ...cr.crop }, screen: q ? { box: w(q.box), im: w(q.im) } : null } : null;
    },
  };
}
