// Canvas shortcuts that had no handler elsewhere. Runs on window.canvasHost (src/server.ts) next to
// structure.js, live.js and autolayout.js. Pure math in /page/shortcuts-logic.js (node-tested).
//
// - Option-drag ghost: while a selection is Option-dragged (server.ts move, autolayout.js), host.ghost draws the
//   copies under the pointer on an overlay board of their own (built once, moved per frame) and the originals stay.
// - Option+hover: red distance lines from the selection to the hovered layer (to the parent when the pointer is
//   over the selection itself), with their lengths.
// - Tab / Shift+Tab: next / previous sibling (layers panel order, wrapping).
// - Shift+H / Shift+V: flip horizontally / vertically (flipX / flipY on each layer).
// - Cmd+Shift+H: show or hide the selection (the `enabled` property).
// - Cmd+Shift+L: lock or unlock the selection (the `locked` property). Locked layers ignore canvas
//   clicks and the marquee (server.ts pick, structure.js) and keep their handles off; the Layers panel selects them.
// - Option+Cmd+A: Select matching layers (same name and kind in the other boards); Edit > Select All with Same:
//   fill, stroke, effect, font, text style, instances (src/search.ts matchActions). Shift+Cmd+A: Select inverse
//   (structure.js). Option+L: the Layers panel closes every open row (the shell's).
// - Option+W/A/S/D: align top/left/bottom/right; Option+H / Option+V: align horizontal / vertical centres. Several
//   selected align in their box; one layer aligns in its parent. One write (POST /api/move items), one undo step.
// - "." (Edit > Repeat): the last property edit again on the layers selected now (src/repeat.ts decides what and
//   how: the same value, or the same change from each layer's own value). One write, one undo step; a toast says which.
// In Canvas.app the Arrange menu sends {cmd: "shortcut", op} for the same actions; Cmd+Shift+H is the menu's key.
// Cmd+L (copy a canvas:// link) is /page/link.js; Opt+Cmd+L here stays text align left.

import * as S from "/page/shortcuts-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, file } = host;
  const isW = (id) => typeof id === "string" && id.startsWith("widget:");
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  const editingText = () => !!(host.textEdit && host.textEdit.active);
  const ids = () => (host.selection ? host.selection() : host.sel ? [host.sel] : []);
  // Locked layers (selected in the Layers panel) do not move, resize, turn or flip from canvas keys (they
  // cannot be moved on the canvas); their properties still change (opacity, paints, text styles, the inspector).
  const locked = (id) => !!(host.isLocked && host.isLocked(id));
  const tell = (t) => { if (host.native) host.post({ toast: t }); else { const m = document.getElementById("msg"); if (m) { m.textContent = t; m.style.display = "block"; clearTimeout(tell.t); tell.t = setTimeout(() => { m.style.display = "none"; }, 4000); } else console.warn("[canvas] " + t); } };
  const nodeInfo = (id, depth = 1) => fetch(host.api("/api/node") + "&id=" + encodeURIComponent(id) + "&depth=" + depth).then((r) => r.json()).then((j) => (j && !j.error ? j : null)).catch(() => null);
  const post = (path, body) => fetch(path, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, ...body }) })
    .then((r) => r.json().catch(() => ({})).then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }));

  // ---------- Option-drag ghost ----------
  const GH = "\u0000dup-ghost";
  const eng = () => { const v = host.engineView; return v && v.engine ? v.engine : null; };
  let ghost = null; // {origin: {x, y}}
  function locate(root, id) {
    let hit = null;
    const visit = (n) => {
      if (hit || !n || typeof n !== "object") return;
      if (String(n.id) === id) { hit = n; return; }
      for (const c of Array.isArray(n.children) ? n.children : []) visit(c);
    };
    visit(root);
    return hit;
  }
  /** Numbers for a node's size where the scene has none (a free frame does not fill or hug like a flow does). */
  function fixSize(n, r) {
    const text = n.type === "text", g = n.textGrowth;
    if (typeof n.width !== "number" && !(text && (!g || g === "auto"))) n.width = r.w;
    if (typeof n.height !== "number" && !(text && g !== "fixed-width-height")) n.height = r.h;
  }
  /** Lay out copies of the items ({id, rect} world rects where they are now) on the ghost board. False when the engine cannot. */
  function ghostBuild(items) {
    ghostHide();
    const e = eng(), L = host.live;
    if (!e || !L || !items.length) return false;
    const u = S.unionOf(items.map((i) => i.rect));
    if (!u) return false;
    const kids = [];
    // The copies draw with their boards' images and fonts: a scene without them draws image fills as nothing (a
    // phone frame's screen went black for the whole drag) and texts in a fallback font.
    const images = new Set(), fonts = new Map();
    for (const it of items) {
      const board = L.boardOf(it.id);
      const scene = board ? L.sceneOf(board) : null;
      if (scene) {
        for (const u of Array.isArray(scene.images) ? scene.images : []) images.add(u);
        for (const f of Array.isArray(scene.fonts) ? scene.fonts : []) if (f && !fonts.has(f.url)) fonts.set(f.url, f);
      }
      const n0 = scene ? (board === it.id ? scene.root : locate(scene.root, it.id)) : null;
      if (!n0) continue;
      const n = JSON.parse(JSON.stringify(n0));
      n.x = it.rect.x - u.x; n.y = it.rect.y - u.y;
      n.layoutPosition = "absolute";
      delete n.rotation;
      fixSize(n, it.rect);
      kids.push(n);
    }
    if (!kids.length) return false;
    const root = { id: GH, type: "frame", layout: "none", width: Math.max(1, u.w), height: Math.max(1, u.h), children: kids };
    try {
      e.setBoard(GH, u.x, u.y, JSON.stringify({ version: 2, id: GH, x: 0, y: 0, root, fonts: [...fonts.values()], images: [...images], warnings: [] }));
      e.raiseBoards([GH]);
      if (e.drawNow) e.drawNow(GH);
    } catch (err) { console.error(err); return false; }
    ghost = { origin: { x: u.x, y: u.y } };
    host.requestFrame();
    return true;
  }
  function ghostMove(dx, dy) {
    const e = eng();
    if (!ghost || !e) return;
    try { e.moveBoard(GH, ghost.origin.x + dx, ghost.origin.y + dy); } catch {}
    host.requestFrame();
  }
  function ghostHide() {
    const e = eng();
    if (ghost && e) { try { e.removeBoard(GH); } catch {} host.requestFrame(); }
    ghost = null;
  }
  host.ghost = { build: ghostBuild, move: ghostMove, hide: ghostHide, get shown() { return !!ghost; } };

  // ---------- Option+hover: distances ----------
  const cv = document.createElement("canvas");
  cv.id = "measure";
  cv.style.cssText = "position:fixed;pointer-events:none;z-index:30;display:none";
  document.body.append(cv);
  const ctx = cv.getContext("2d");
  let alt = false, ptr = null, mRaf = 0, shown = false;
  const parentOf = new Map(); // layer id -> parent id (null for a board)
  host.on("select", () => {
    for (const x of ids()) if (x && !isW(x) && !parentOf.has(x) && !host.boards.has(x)) nodeInfo(x, 0).then((j) => { if (j) parentOf.set(x, j.parentId || null); });
  });
  const RED = "#f24822";
  function clearMeasure() { if (shown) { ctx.clearRect(0, 0, cv.width, cv.height); cv.style.display = "none"; shown = false; } }
  function paintMeasure() {
    mRaf = 0;
    const sel = ids();
    if (!alt || !ptr || !sel.length || host.hand || editingText() || (host.autolayout && (host.autolayout.dragging || host.autolayout.handleActive)) || moving()) { clearMeasure(); return; }
    const a = S.unionOf(sel.map((id) => host.worldRectOf(id)));
    let hid = host.pick(ptr.x, ptr.y);
    if (hid && sel.includes(hid)) hid = sel.length === 1 ? parentOf.get(sel[0]) || null : null;
    const b = hid ? host.worldRectOf(hid) : null;
    if (!a || !b) { clearMeasure(); return; }
    const m = S.measureLines(a, b);
    const vb = view.getBoundingClientRect(), dpr = devicePixelRatio || 1, c = host.cam;
    if (cv.width !== Math.round(vb.width * dpr) || cv.height !== Math.round(vb.height * dpr)) { cv.width = Math.round(vb.width * dpr); cv.height = Math.round(vb.height * dpr); }
    cv.style.left = vb.left + "px"; cv.style.top = vb.top + "px"; cv.style.width = vb.width + "px"; cv.style.height = vb.height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vb.width, vb.height);
    const sx = (x) => Math.round(x * c.z + c.x) + 0.5, sy = (y) => Math.round(y * c.z + c.y) + 0.5;
    // The hovered layer's outline.
    ctx.strokeStyle = RED; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.strokeRect(sx(b.x), sy(b.y), Math.round(b.w * c.z), Math.round(b.h * c.z));
    ctx.setLineDash([3, 3]);
    for (const d of m.dashes) { ctx.beginPath(); ctx.moveTo(sx(d.x1), sy(d.y1)); ctx.lineTo(sx(d.x2), sy(d.y2)); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    for (const l of m.lines) {
      ctx.strokeStyle = RED;
      ctx.beginPath(); ctx.moveTo(sx(l.x1), sy(l.y1)); ctx.lineTo(sx(l.x2), sy(l.y2)); ctx.stroke();
      const text = String(Math.round(l.d * 100) / 100);
      const w = Math.ceil(ctx.measureText(text).width) + 8;
      const mx = (sx(l.x1) + sx(l.x2)) / 2, my = (sy(l.y1) + sy(l.y2)) / 2;
      const horiz = l.y1 === l.y2;
      const px = horiz ? mx - w / 2 : mx + 4, py = horiz ? my + 4 : my - 8;
      ctx.fillStyle = RED;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(px, py, w, 16, 3); else ctx.rect(px, py, w, 16); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(text, px + 4, py + 8.5);
    }
    cv.style.display = "block";
    shown = true;
  }
  const moving = () => !!(host.moving && host.moving());
  const queueMeasure = () => { if (!mRaf) mRaf = requestAnimationFrame(paintMeasure); };
  addEventListener("pointermove", (e) => { ptr = { x: e.clientX, y: e.clientY }; const a = e.altKey; if (a !== alt) alt = a; if (alt || shown) queueMeasure(); }, true);
  addEventListener("keydown", (e) => { if (e.key === "Alt") { alt = true; queueMeasure(); } }, true);
  addEventListener("keyup", (e) => { if (e.key === "Alt") { alt = false; clearMeasure(); } }, true);
  addEventListener("blur", () => { alt = false; clearMeasure(); });
  host.on("cam", () => { if (shown) queueMeasure(); });
  host.on("deselect", () => clearMeasure());

  // ---------- actions ----------
  /** Tab / Shift+Tab: the next or previous sibling of the (first) selected layer. */
  async function stepSibling(back) {
    const sel = ids().filter((id) => !isW(id));
    if (!sel.length) return;
    const id = sel[sel.length - 1];
    let kids;
    if (host.boards.has(id)) kids = [...host.boards.keys()];
    else {
      const info = await nodeInfo(id, 0);
      if (!info || !info.parentId) return;
      const p = await nodeInfo(info.parentId, 1);
      kids = p && Array.isArray(p.node.children) ? p.node.children.filter((c) => c && c.enabled !== false).map((c) => c.id) : null;
    }
    const next = kids ? S.siblingStep(kids, id, back) : null;
    if (next) host.setSelection([next]);
  }
  /** Shift+H / Shift+V: flip each selected layer (one write per resulting value). */
  async function flip(prop) {
    const sel = ids().filter((id) => !isW(id) && !id.includes("/") && !locked(id));
    if (!sel.length) return;
    const nodes = (await Promise.all(sel.map((id) => nodeInfo(id, 0)))).filter(Boolean).map((j) => j.node);
    // A flip mirrors about the layer's top-left corner: the layer keeps its place on the canvas by
    // moving its stored x (y) by its width (height). One write, one undo step (/api/resize items).
    const items = S.flipItems(nodes, prop, (id) => host.worldRectOf(id));
    if (!items.length) return;
    // Undo names the step after it ("Undo Flip Horizontal"), not "Resize" (src/resize.ts resizeLabel).
    try { await post("/api/resize", { items, label: prop === "flipX" ? "Flip Horizontal" : "Flip Vertical" }); } catch (err) { tell("Could not flip: " + err.message); }
  }
  /** Cmd+Shift+H: hide the selection, or show it when every selected layer is hidden. */
  async function toggleHidden() {
    const sel = ids().filter((id) => !isW(id) && !id.includes("/"));
    if (!sel.length) return;
    const nodes = (await Promise.all(sel.map((id) => nodeInfo(id, 0)))).filter(Boolean).map((j) => j.node);
    const hide = S.hideAll(nodes);
    try {
      await post("/api/update", hide ? { ids: sel, props: { enabled: false } } : { ids: sel, props: {}, remove: ["enabled"] });
    } catch (err) { tell("Could not " + (hide ? "hide" : "show") + ": " + err.message); }
  }
  /** Cmd+Shift+L: lock the selection, or unlock it when every selected layer is locked. One write, one undo step. */
  async function toggleLock() {
    const sel = ids().filter((id) => !isW(id) && !id.includes("/"));
    if (!sel.length) return;
    const nodes = (await Promise.all(sel.map((id) => nodeInfo(id, 0)))).filter(Boolean).map((j) => j.node);
    const lock = S.lockAll(nodes);
    try {
      await post("/api/update", lock ? { ids: sel, props: { locked: true } } : { ids: sel, props: {}, remove: ["locked"] });
      tell(lock ? (sel.length === 1 ? "Locked" : `Locked ${sel.length} layers`) : (sel.length === 1 ? "Unlocked" : `Unlocked ${sel.length} layers`));
    } catch (err) { tell("Could not " + (lock ? "lock" : "unlock") + ": " + err.message); }
  }
  /** Select matching layers and Select All with the same property: the server finds them (src/search.ts). */
  const SAME = { matching: "matching layers", fill: "fill", stroke: "stroke", effect: "effect", font: "font", textStyle: "text style", instances: "component" };
  async function selectSame(key) {
    const sel = ids().filter((id) => !isW(id));
    if (!sel.length) return;
    const g = host.selGen;
    let j = null;
    try {
      const q = host.api("/api/search/match") + "&ids=" + encodeURIComponent(sel.slice(0, 500).join(",")) + (host.page ? "&page=" + encodeURIComponent(host.page) : "");
      j = await fetch(q).then((r) => r.json());
    } catch { j = null; }
    if (host.selGen !== g) return; // the selection moved on while the server looked
    const a = j && Array.isArray(j.actions) ? j.actions.find((x) => x.key === key) : null;
    if (!a || !a.ids.length) { tell(key === "matching" ? "No matching layers to select on this page" : `No other layers with the same ${SAME[key] || key} on this page`); return; }
    host.setSelection(a.ids);
  }
  /**
   * Option+W/A/S/D/H/V: align the selection in its box, or a lone layer in its parent. `toParent` (Shift held on the
   * Arrange menu's align items, or Shift+click on the align buttons): several layers align to their parent frame
   * as a group, when they share one.
   */
  async function align(how, toParent = false) {
    const sel = ids();
    if (!sel.length) return;
    const parentRect = async (id) => {
      if (isW(id) || host.boards.has(id)) return undefined;
      let pid = parentOf.get(id);
      if (pid === undefined) { const j = await nodeInfo(id, 0); pid = j ? j.parentId || null : null; parentOf.set(id, pid); }
      return pid;
    };
    if (sel.length > 1 && toParent) {
      const pids = await Promise.all(sel.map(parentRect));
      if (pids.some((p) => !p) || new Set(pids).size !== 1) { tell("These layers have no parent frame in common"); return; }
      // As a group: the union box moves into place in the parent, each layer by the same step.
      const parent = host.worldRectOf(pids[0]), box = S.unionOf(sel.map((id) => host.worldRectOf(id)));
      if (!parent || !box) return;
      const [d] = S.alignDeltas([box], parent, how);
      moveBy(sel, sel.map(() => d), "align");
      return;
    }
    if (sel.length > 1) {
      // Layers auto layout places (or locked ones) stay, and stay out of the box the rest align in.
      const plan = await planFor(sel, "align");
      if (plan.note) tell(plan.note);
      if (!plan.ok) return;
      const rs = plan.ids.map((id) => host.worldRectOf(id));
      const box = S.unionOf(rs);
      if (box) moveBy(plan.ids, S.alignDeltas(rs, box, how), "align");
      return;
    }
    const pid = await parentRect(sel[0]);
    if (pid === undefined) return;
    const target = pid ? host.worldRectOf(pid) : null;
    if (!target) return;
    moveBy(sel, S.alignDeltas(sel.map((id) => host.worldRectOf(id)), target, how), "align");
  }

  /** Layers in the selection (no cards, nothing inside an instance) with their props. */
  const layers = () => ids().filter((id) => !isW(id) && !id.includes("/"));
  const nodesOf = async (list) => (await Promise.all(list.map((id) => nodeInfo(id, 0)))).filter(Boolean).map((j) => j.node);
  /** Several writes, each to the ids that share it, all one undo step (a "group:" merge key, src/server.ts updateMerge). */
  async function writeAll(writes, what) {
    const batches = S.batchWrites(writes);
    const merge = batches.length > 1 ? { merge: "group:keys-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) } : {};
    try { for (const w of batches) await post("/api/update", w.ids.length > 1 ? { ids: w.ids, props: w.props, remove: w.remove, ...merge } : { id: w.ids[0], props: w.props, remove: w.remove, ...merge }); }
    catch (err) { tell("Could not " + what + ": " + err.message); }
  }
  /** Digits: opacity (two quick digits are a percentage). */
  let lastDigit = null, lastDigitAt = 0;
  function opacityKey(d) {
    const now = performance.now();
    const prev = lastDigit !== null && now - lastDigitAt < 600 ? lastDigit : null;
    lastDigit = prev === null ? d : null;
    lastDigitAt = now;
    const v = S.opacityFromDigits(prev, d);
    const list = layers();
    if (list.length) writeAll(list.map((id) => ({ id, props: { opacity: v }, remove: [] })), "change opacity");
  }
  // Text keys one after another: a press steps from the value the last press wrote (three quick Option+&gt; are +0.3).
  let textQueue = Promise.resolve();
  function textKey(what) {
    const sel = layers();
    textQueue = textQueue.then(async () => {
      const nodes = await nodesOf(sel);
      const w = S.textToggle(nodes, what);
      if (!w.length) { if (!nodes.some((n) => n && n.type === "text")) tell("Select a text layer"); return; }
      await writeAll(w, "change the text");
    }).catch(() => {});
    if (host.trackWrite) host.trackWrite(textQueue);
  }
  async function resizeKey(key, big) {
    const step = big ? (host.snap ? host.snap().bigNudge || 10 : 10) : 1;
    const w = [];
    const sel = layers().filter((id) => !locked(id));
    // The file's own size: a turned layer's drawn box is wider than it is (S.ownSize).
    const nodes = await Promise.all(sel.map((id) => nodeInfo(id, 0).then((j) => (j ? j.node : null))));
    sel.forEach((id, i) => { const p = S.resizeBy(S.ownSize(nodes[i], host.worldRectOf(id)), key, step, S.aspectLocked(nodes[i])); if (p) w.push({ id, props: p, remove: [] }); });
    if (w.length) writeAll(w, "resize");
  }
  /**
   * Cmd+Option+Up/Down: every selected layer turns 1 degree (keyboard rotate), one undo step per press.
   * Presses queue: each reads the rotation the last one wrote, so quick presses all count.
   */
  let rotating = Promise.resolve();
  function rotateKey(key) {
    const sel = layers().filter((id) => !id.includes("/") && !locked(id));
    if (!sel.length) return;
    rotating = rotating.then(async () => {
      const w = [];
      for (const n of await nodesOf(sel)) { const p = S.rotateBy(n, key); if (p && n.id) w.push({ id: n.id, props: p, remove: [] }); }
      if (w.length) await writeAll(w, "rotate");
    }).catch(() => {});
  }
  async function distribute(axis) {
    const sel = ids();
    if (sel.length < 3) { tell("Select three or more layers to distribute"); return; }
    const plan = await planFor(sel, "distribute");
    if (plan.note) tell(plan.note);
    if (!plan.ok) return;
    moveBy(plan.ids, S.distributeDeltas(plan.ids.map((id) => host.worldRectOf(id)), axis), "distribute");
  }
  /** Which of `sel` align and distribute may move (S.arrangePlan): /api/node says which ones auto layout places. */
  async function planFor(sel, what) {
    const info = new Map();
    await Promise.all(sel.map(async (id) => {
      if (isW(id)) return;
      if (id.includes("/")) { info.set(id, { placed: true }); return; } // inside an instance: its component places it
      const j = host.boards.has(id) ? null : await nodeInfo(id, 0);
      info.set(id, { placed: !!(j && j.placed) });
    }));
    return S.arrangePlan(sel, info, what);
  }
  let look = null;
  async function copyProps() {
    const sel = layers();
    if (!sel.length) return;
    const [n] = await nodesOf([sel[0]]);
    if (n) { look = S.copyLook(n); tell("Properties copied"); }
  }
  async function pasteProps() {
    if (!look) { tell("Copy properties first (Option+Cmd+C)"); return; }
    const w = [];
    for (const n of await nodesOf(layers())) { const p = S.pasteLook(look, n.type); if (p) w.push({ id: n.id, ...p }); }
    if (w.length) writeAll(w, "paste properties");
  }
  /** Option+/, Shift+/ (remove fills or strokes) and Shift+X (swap them): one write per kind of change, one undo step. */
  async function paintKey(op) {
    const w = [];
    for (const n of await nodesOf(layers())) {
      const p = op === "swap-paint" ? S.swapPaintWrite(n) : S.removePaintWrite(n, op === "remove-fill" ? "fill" : "stroke");
      if (p) w.push({ id: n.id, ...p });
    }
    if (w.length) writeAll(w, op === "swap-paint" ? "swap fill and stroke" : op.replace("-", " "));
  }
  /** I (or Control+C in the app): a colour from the screen becomes the selection's fill. The app samples it natively. */
  /** Control+Cmd+M: Use as mask on the selection (or stop), one undo step. */
  async function maskKey() {
    const w = S.maskWrites(await nodesOf(layers()), (id) => host.boards.has(id));
    if (w) writeAll(w, "use as mask");
  }
  async function eyedropper() {
    if (!layers().length) return;
    if (host.native) { host.post({ eyedropper: true }); return; }
    if (typeof window.EyeDropper !== "function") { tell("This browser has no eyedropper"); return; }
    try {
      const sel = layers();
      const r = await new window.EyeDropper().open();
      const hex = String(r.sRGBHex || "").toUpperCase();
      if (/^#[0-9A-F]{6}$/.test(hex)) writeAll(sel.map((id) => ({ id, props: { fill: hex }, remove: [] })), "pick a colour");
    } catch { /* cancelled */ }
  }
  async function makeComponent() {
    const w = (await nodesOf(layers())).filter((n) => n.type !== "ref" && n.reusable !== true).map((n) => ({ id: n.id, props: { reusable: true }, remove: [] }));
    if (w.length) writeAll(w, "create a component");
  }
  async function detach() {
    const sel = layers();
    if (!sel.length) return;
    try {
      const r = await post("/api/structure", { page: host.page || undefined, op: "detach", ids: sel });
      if (Array.isArray(r.select) && r.select.length) host.setSelection(r.select);
    } catch (err) { tell("Could not detach: " + err.message); }
  }
  function stepBoard(back) {
    const order = [...host.boards.keys()];
    const cur = ids()[0];
    const b = cur ? (host.boards.has(cur) ? cur : host.live ? host.live.boardOf(cur) : null) : null;
    const next = S.nextBoard(order, b, back);
    if (!next) return;
    host.setSelection([next]);
    host.fit(next);
  }
  /** Move ids by per-id deltas in one undo step (layers and boards through /api/move, cards by nudge). */
  async function moveBy(sel, deltas, what) {
    const key = "group:" + what + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const items = [];
    sel.forEach((id, i) => {
      const d = deltas[i];
      if (!d || (!d.dx && !d.dy)) return;
      if (isW(id)) host.emit("nudge", { id, dx: d.dx, dy: d.dy, merge: key });
      else if (!id.includes("/") && !locked(id)) items.push({ id, dx: d.dx, dy: d.dy });
    });
    if (!items.length) return;
    try {
      const j = await post("/api/move", { items, round: !host.snap || host.snap().pixel, merge: key });
      if (j && Array.isArray(j.skipped) && j.skipped.some((s) => s.code === "auto_layout")) tell("Auto layout places some of these layers; they stayed");
    } catch (err) { tell("Could not " + what + ": " + err.message); }
  }

  /** Edit > Repeat: the server applies its note of the last edit to the selection; the canvas draws the result now. */
  let repeating = false;
  async function repeatLast() {
    const sel = ids().filter((id) => !isW(id));
    if (!sel.length) { tell("Select layers to repeat the last edit on"); return; }
    if (repeating) return; // one at a time: a held key must not stack writes
    repeating = true;
    try {
      const j = await post("/api/repeat", { ids: sel, round: !host.snap || host.snap().pixel });
      const L = host.live;
      if (L && j && j.each) {
        const op = L.nextOp();
        for (const [id, props] of Object.entries(j.each)) { L.edit(id, props, j.remove || [], op); L.ack(id, op, true); }
      }
      if (j && j.toast) tell(j.toast);
    } catch (err) { tell(err.message || "Could not repeat"); }
    finally { repeating = false; }
  }

  const run = (op) => {
    if (editingText()) return;
    if (op === "repeat") { repeatLast(); return; }
    if (op.startsWith("text-")) { textKey(op.slice(5)); return; }
    if (op === "distribute-h" || op === "distribute-v") { distribute(op.slice(-1)); return; }
    if (op === "copyProps") { copyProps(); return; }
    if (op === "pasteProps") { pasteProps(); return; }
    if (op === "component") { makeComponent(); return; }
    if (op === "remove-fill" || op === "remove-stroke" || op === "swap-paint") { paintKey(op); return; }
    if (op === "eyedropper") { eyedropper(); return; }
    if (op === "mask") { maskKey(); return; }
    if (op === "detach") { detach(); return; }
    if (op === "nextBoard" || op === "prevBoard") { stepBoard(op === "prevBoard"); return; }
    if (op === "lock") { toggleLock(); return; }
    if (op === "selectMatching") { selectSame("matching"); return; }
    if (op.startsWith("selectSame:")) { selectSame(op.slice(11)); return; }
    if (op === "selectInverse") { if (host.structure && host.structure.selectInverse) host.structure.selectInverse(); return; }
    if (op === "collapseLayers") { if (host.native) host.post({ layers: "collapseAll" }); return; }
    if (op === "flipH") flip("flipX");
    else if (op === "flipV") flip("flipY");
    else if (op === "hide") toggleHidden();
    else if (op === "next" || op === "prev") stepSibling(op === "prev");
    else if (op.startsWith("align-")) { const [how, to] = op.slice(6).split(":"); align(how, to === "parent"); }
    else if (op.startsWith("opacity:")) opacityKey(Number(op.slice(8)));
    else if (op.startsWith("resize:")) { const [, key, big] = op.split(":"); resizeKey(key, big === "big"); }
    else if (op.startsWith("rotate:")) rotateKey(op.slice(7));
  };
  host.shortcuts = { run };
  host.on("cmd", (c) => { if (c && c.cmd === "shortcut" && typeof c.op === "string") run(c.op); });

  /** What a key press asks for here, or null. */
  function keyOp(e) {
    const cmd = e.metaKey || e.ctrlKey;
    const c = e.code;
    const lk = S.layerKey(e);
    // In the app the menu owns Shift+Cmd+L, Shift+Cmd+A and Option+Cmd+A (it sends the op); Option+L is the page's.
    if (lk) return host.native && lk !== "collapseLayers" ? null : lk;
    // Text styles on selected text layers. The app has no menu items for these: the page owns the keys.
    if (cmd && !e.altKey && !e.shiftKey && c === "KeyB") return "text-bold";
    if (cmd && !e.altKey && !e.shiftKey && c === "KeyI") return "text-italic";
    if (cmd && !e.altKey && !e.shiftKey && c === "KeyU") return "text-underline";
    if (cmd && !e.altKey && e.shiftKey && c === "KeyX") return "text-strike";
    if (cmd && !e.altKey && e.shiftKey && c === "Period") return "text-bigger";
    if (cmd && !e.altKey && e.shiftKey && c === "Comma") return "text-smaller";
    // Lists on whole text layers: Shift+Cmd+8 bulleted, Shift+Cmd+7 numbered.
    if (cmd && !e.altKey && e.shiftKey && c === "Digit8") return "text-list-bullet";
    if (cmd && !e.altKey && e.shiftKey && c === "Digit7") return "text-list-number";
    // Type keys: Option+&gt; / &lt; letter spacing, Option+Shift line height, Option+Cmd font weight.
    if (e.altKey && (c === "Period" || c === "Comma")) {
      const dir = c === "Period" ? "+" : "-";
      if (!cmd && !e.shiftKey) return "text-tracking" + dir;
      if (!cmd && e.shiftKey) return "text-leading" + dir;
      if (cmd && !e.shiftKey) return "text-weight" + dir;
    }
    if (cmd && e.altKey && !e.shiftKey) {
      const a = { KeyL: "left", KeyT: "center", KeyR: "right", KeyJ: "justify" }[c];
      if (a) return "text-align-" + a;
      if (c === "KeyC") return "copyProps";
      if (c === "KeyV") return "pasteProps";
      if (c === "KeyK") return "component";
      if (c === "KeyB") return "detach";
    }
    if (cmd && !e.altKey && e.key.startsWith("Arrow")) return "resize:" + e.key + (e.shiftKey ? ":big" : "");
    // Keyboard rotate: Cmd+Option+Up/Down turn the selection 1 degree.
    if (cmd && e.altKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) return "rotate:" + e.key;
    // Paints: Option+/ removes fills, Shift+/ strokes, Shift+X swaps them; I (Control+C in the app) picks a colour.
    if (!cmd && c === "Slash" && e.altKey !== e.shiftKey) return e.altKey ? "remove-fill" : "remove-stroke";
    if (!cmd && !e.altKey && e.shiftKey && c === "KeyX") return "swap-paint";
    if (!cmd && !e.altKey && !e.shiftKey && c === "KeyI") return "eyedropper";
    if (e.ctrlKey && e.metaKey && !e.altKey && !e.shiftKey && c === "KeyM") return "mask";
    if (host.native && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && c === "KeyC") return "eyedropper";
    if (!cmd && e.altKey && e.shiftKey && c === "KeyH") return "distribute-h";
    if (!cmd && e.altKey && e.shiftKey && c === "KeyV") return "distribute-v";
    if (!cmd && !e.altKey && c === "KeyN") return e.shiftKey ? "prevBoard" : "nextBoard";
    // Repeat the last edit (vim's "."): a bare key, so it is one press per layer when going through a selection.
    if (!cmd && !e.altKey && !e.shiftKey && e.key === "." && !e.repeat) return "repeat";
    // Digits set opacity while layers are selected (Shift+1 / 2 / 0 zoom: zoomKey, server.ts).
    if (!cmd && !e.altKey && !e.shiftKey && /^Digit\d$/.test(c) && layers().length) return "opacity:" + c.slice(5);
    if (e.key === "Tab" && !cmd && !e.altKey) return e.shiftKey ? "prev" : "next";
    if (!cmd && e.shiftKey && !e.altKey && e.code === "KeyH") return "flipH";
    if (!cmd && e.shiftKey && !e.altKey && e.code === "KeyV") return "flipV";
    if (cmd && e.shiftKey && !e.altKey && e.code === "KeyH") return host.native ? null : "hide"; // the app's menu owns it
    if (!cmd && e.altKey && !e.shiftKey && S.ALIGN_KEYS[e.code]) return "align-" + S.ALIGN_KEYS[e.code];
    return null;
  }
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || typing(e.target) || editingText()) return;
    const op = keyOp(e);
    if (!op) return;
    if (!ids().length && op !== "nextBoard" && op !== "prevBoard" && op !== "repeat" && op !== "selectInverse" && op !== "collapseLayers") return;
    e.preventDefault();
    run(op);
  });
}
