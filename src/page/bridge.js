// The page's side of the bridge (see .planning/bridge-contract.md). Runs as a classic inline script right
// after the canvas script, in the browser and in the app's web view. It reports what the page shows
// (selection, camera, focus) and runs the commands an agent sends (select, fit, zoom, pan, highlight, ...).
// It reuses window.canvasHost; the canvas script stays the only owner of camera and selection.
(() => {
const host = window.canvasHost;
if (!host || !host.file) return;
const view = host.view;
const clientId = "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
let seq = 0, pick = 0, selSource = "user", lastInputAt = 0, hover = null, opSource = "user", stateTimer = 0, open = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (code, message) => Object.assign(new Error(message), { code });
/** The highest zoom, 25600% (server.ts and the engine clamp there too). */
const MAX_ZOOM = 256;
const post = (path, body) => fetch(path, {
  method: "POST", signal: AbortSignal.timeout(4000),
  headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body),
});

// ---------- state ----------
/** The rectangle around every given one (missing ones skipped), or null. */
function unionOf(rs) {
  const l = rs.filter(Boolean);
  if (!l.length) return null;
  const x = Math.min(...l.map((r) => r.x)), y = Math.min(...l.map((r) => r.y));
  return { x, y, w: Math.max(...l.map((r) => r.x + r.w)) - x, h: Math.max(...l.map((r) => r.y + r.h)) - y };
}
const screenOf = (w) => { const c = host.cam; return { x: w.x * c.z + c.x, y: w.y * c.z + c.y, w: w.w * c.z, h: w.h * c.z }; };
function selectionState() {
  const id = host.sel;
  if (!id) return null;
  const many = host.selection ? host.selection() : [];
  // Several layers: the box around all of them (the selection box on the canvas), not the last one's.
  const w = unionOf((many.length > 1 ? many : [id]).map((i) => host.worldRectOf(i)));
  return { ids: many.length > 1 ? many : [id], primary: id, pick, source: selSource, rendered: w && host.cam ? { width: w.w, height: w.h, world: w, screen: screenOf(w) } : null };
}
function stateBody() {
  const ins = host.insets || { l: 0, t: 0, r: 0, b: 0 };
  return {
    client: clientId, role: "page", host: host.native ? "native" : "browser", file: host.file,
    docRevision: host.doc ? host.doc.revision : null,
    // Who made the last selection change, also when it was a deselect (selection is null then).
    selection: selectionState(), selectionSource: selSource, hover: hover ? { id: hover } : null,
    cam: host.cam ? { x: host.cam.x, y: host.cam.y, z: host.cam.z } : null,
    view: { w: view.clientWidth, h: view.clientHeight, insets: { l: ins.l, t: ins.t, r: ins.r, b: ins.b } },
    visible: document.visibilityState === "visible", focused: document.hasFocus(), lastInputAt, seq: ++seq,
    renderer: host.renderer || "dom", rendererNote: host.rendererNote || "", page: host.page || null,
    perf: host.perf || null,
  };
}
function flush() {
  clearTimeout(stateTimer); stateTimer = 0;
  if (!open) return;
  // The body is read (and dropped): an unread response keeps its network resource alive, and this runs on every
  // camera move (stress: 6 a second, the renderer grew 25 MB a minute).
  post("/api/state", stateBody()).then((r) => r.arrayBuffer()).catch(() => {});
}
const schedule = (ms) => { if (!stateTimer) stateTimer = setTimeout(flush, ms); };

host.on("select", () => { pick++; selSource = opSource; flush(); });
host.on("deselect", () => { pick++; selSource = opSource; flush(); });
host.on("cam", () => schedule(100));
host.on("visible", () => schedule(100));
host.on("renderer", () => schedule(50));
host.on("page", () => schedule(30));
host.on("perf", () => schedule(30));
document.addEventListener("visibilitychange", () => schedule(50));
addEventListener("focus", () => schedule(50));
addEventListener("blur", () => schedule(50));
for (const t of ["pointerdown", "keydown", "wheel"]) addEventListener(t, () => { lastInputAt = Date.now(); }, { capture: true, passive: true });
let hovFrame = 0;
view.addEventListener("pointermove", (e) => {
  if (hovFrame) return;
  hovFrame = requestAnimationFrame(() => {
    hovFrame = 0;
    const id = host.pick ? host.pick(e.clientX, e.clientY) : null;
    if (id !== hover) { hover = id; schedule(150); }
  });
});
view.addEventListener("pointerleave", () => { if (hover) { hover = null; schedule(150); } });
setInterval(flush, 5000);
if (host.es) host.es.addEventListener("doc", () => schedule(100));

// ---------- geometry helpers ----------
const rectOf = (id) => host.worldRectOf(id) || host.boxOf(id);
const union = (rs) => { const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y)); return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y }; };
const area = () => { const i = host.insets || { l: 0, t: 0, r: 0, b: 0 }; return { x: i.l, y: i.t, w: view.clientWidth - i.l - i.r, h: view.clientHeight - i.t - i.b }; };
const viewWorld = () => { const a = area(), c = host.cam; return { x: (a.x - c.x) / c.z, y: (a.y - c.y) / c.z, w: a.w / c.z, h: a.h / c.z }; };
const overlap = (a, b) => { const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return w > 0 && h > 0 ? (w * h) / Math.max(1, b.w * b.h) : 0; };
function camState() {
  const vw = viewWorld(), boardsInView = [];
  for (const [id, b] of host.boards) { const f = overlap(vw, host.boxOf(id)); if (f > 0) boardsInView.push({ id, name: b.meta.name, visibleFraction: Math.round(f * 100) / 100 }); }
  return { cam: { x: host.cam.x, y: host.cam.y, z: host.cam.z }, zoomPercent: Math.round(host.cam.z * 100), view: { w: view.clientWidth, h: view.clientHeight, insets: host.insets }, viewWorld: vw, boardsInView };
}
async function waitFor(fn, ms = 5000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(40); } }
// A node on another page: show that page first (its boards replace this page's).
async function showPageOf(id, boards) {
  let p = null;
  if (id.startsWith("widget:")) p = host.widgetPageOf ? host.widgetPageOf(id.slice(7)) : null;
  else { const b = boards && boards[id]; if (b && !host.boards.has(b) && host.pageOfBoard) p = host.pageOfBoard(b); }
  if (p && p !== host.page) await host.setPage(p);
}
// Draw the board a node lives in, if it is not drawn yet. Returns whether the node can be measured now. move
// false (select_nodes reveal:false): the camera stays where it is, so a board not drawn yet stays undrawn.
async function ensureLoaded(id, boards, move = true) {
  await showPageOf(id, boards);
  if (host.worldRectOf(id)) return true;
  if (!move) return false;
  const b = boards && boards[id];
  if (!b || !host.boxOf(b)) return false;
  await host.fit(b);
  return !!(await waitFor(() => host.worldRectOf(id)));
}
async function rectsFor(ids, boards, reveal) {
  const out = [];
  for (const id of ids) {
    if (reveal) await ensureLoaded(id, boards);
    const r = rectOf(id);
    if (r) out.push({ id, r });
  }
  return out;
}

// ---------- highlights ----------
const hl = document.createElement("div");
hl.id = "hl";
hl.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:4";
view.appendChild(hl);
const css = document.createElement("style");
css.textContent = ".hlb{position:absolute;box-sizing:border-box;border:2px solid var(--hlc);border-radius:4px;pointer-events:none}.hlb.pulse{animation:hlp 1.1s ease-out infinite}.hlb.flash{animation:hlf .5s steps(2,start) 4}.hlb span{position:absolute;left:-2px;bottom:100%;margin-bottom:4px;background:var(--hlc);color:#fff;font:600 11px/16px system-ui,sans-serif;padding:0 6px;border-radius:4px;white-space:nowrap}@keyframes hlp{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--hlc) 55%,transparent)}100%{box-shadow:0 0 0 14px transparent}}@keyframes hlf{50%{opacity:0}}";
document.head.appendChild(css);
const marks = new Map();
function placeMark(m) {
  const w = rectOf(m.id), c = host.cam;
  if (!w || !c) { m.el.style.display = "none"; return; }
  const s = screenOf(w);
  Object.assign(m.el.style, { display: "block", left: s.x + "px", top: s.y + "px", width: s.w + "px", height: s.h + "px" });
}
let markFrame = 0;
const replaceMarks = () => { if (marks.size && !markFrame) markFrame = requestAnimationFrame(() => { markFrame = 0; marks.forEach(placeMark); }); };
host.on("cam", replaceMarks);
host.on("render", replaceMarks); // a board redrawn under a highlight may have moved it
function clearMarks() { for (const m of marks.values()) { clearTimeout(m.timer); m.el.remove(); } marks.clear(); }

// ---------- gloss ----------
// A finished-work cue: per rect, one element placed in view space (transform only) and clipped to the node's
// rounded rect, with a soft diagonal band that sweeps across once and a faint selection-colour ring that fades.
// Animations touch transform and opacity only. Camera changes re-place the elements from cached world rects.
const glossLayer = document.createElement("div");
glossLayer.id = "gloss";
glossLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:5";
view.appendChild(glossLayer);
const glossCss = document.createElement("style");
glossCss.textContent = ".gl{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;will-change:transform,opacity}"
  + ".gl-ring{position:absolute;inset:0;border-radius:var(--r);opacity:0;box-shadow:0 0 0 calc(1.5px/var(--z)) color-mix(in srgb,var(--glc) 55%,transparent),0 0 calc(16px/var(--z)) calc(2px/var(--z)) color-mix(in srgb,var(--glc) 38%,transparent);animation:glring var(--gld) cubic-bezier(.3,.6,.3,1) both}"
  + ".gl-clip{position:absolute;inset:0;border-radius:var(--r);overflow:hidden}"
  + ".gl-band{position:absolute;top:-20%;bottom:-20%;left:0;width:calc(var(--w)*.45);min-width:48px;opacity:0;background:linear-gradient(90deg,transparent 0,color-mix(in srgb,var(--glc) 16%,transparent) 28%,rgba(255,255,255,.62) 50%,color-mix(in srgb,var(--glc) 16%,transparent) 72%,transparent 100%);animation:glsweep var(--gld) cubic-bezier(.16,.7,.25,1) both}"
  + "@keyframes glsweep{0%{opacity:0;transform:translateX(calc(var(--w)*-.55 - var(--h)*.4)) skewX(-18deg)}12%{opacity:1}78%{opacity:1}100%{opacity:0;transform:translateX(calc(var(--w)*1.05 + var(--h)*.4)) skewX(-18deg)}}"
  + "@keyframes glring{0%{opacity:0}16%{opacity:1}100%{opacity:0}}"
  + "@media (prefers-reduced-motion:reduce){.gl-band{display:none}.gl-ring{animation-duration:.6s}}";
document.head.appendChild(glossCss);
const glossy = new Map();
function placeGloss(g) {
  const c = host.cam;
  if (!c) return;
  g.el.style.transform = "translate(" + (g.r.x * c.z + c.x) + "px," + (g.r.y * c.z + c.y) + "px) scale(" + c.z + ")";
  g.el.style.setProperty("--z", c.z);
}
function dropGloss(id) { const g = glossy.get(id); if (g) { clearTimeout(g.timer); g.el.remove(); glossy.delete(id); } }
host.on("cam", () => glossy.forEach(placeGloss));
host.on("render", () => glossy.forEach((g, id) => { const r = rectOf(id); if (r) { g.r = r; placeGloss(g); } }));
function radiusOf(id, r) {
  if (id.startsWith("widget:")) return 10;
  const er = host.radiusOf && host.radiusOf(id, r);
  if (er !== null && er !== undefined) return er;
  const el = view.querySelector(".board>.cur [data-id=" + JSON.stringify(id) + "]");
  const v = el ? getComputedStyle(el).borderTopLeftRadius : "";
  const n = parseFloat(v) || 0;
  return Math.min(/%/.test(v) ? Math.min(r.w, r.h) * n / 100 : n, Math.min(r.w, r.h) / 2);
}
let audio = null;
function chime() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
    const t0 = audio.currentTime + 0.02;
    [[659.25, 0], [880, 0.1]].forEach(([f, dt]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + dt + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.18);
      o.connect(g).connect(audio.destination);
      o.start(t0 + dt); o.stop(t0 + dt + 0.2);
    });
  } catch {}
}

host.chime = chime;

// ---------- toast fallback ----------
let toastEl = null, toastTimer = 0;
function toast(a) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.dataset.bottomToast = "";
    toastEl.style.cssText = "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);display:none;background:var(--c-island,#fff);color:var(--c-fg,#111);border:0;border-radius:12px;padding:7px 14px;font:13px/100% system-ui,sans-serif;z-index:40;box-shadow:0 3px 3px #0000001f;max-width:70vw";
    document.body.appendChild(toastEl);
  }
  clearTimeout(toastTimer);
  if (a.clear) { toastEl.style.display = "none"; return { shown: false }; }
  toastEl.textContent = a.message;
  toastEl.style.display = "block";
  if (a.durationMs > 0) toastTimer = setTimeout(() => { toastEl.style.display = "none"; }, a.durationMs);
  return { shown: true };
}

// ---------- ops ----------
// Text being typed on the canvas (/page/text-edit.js): an agent's selection change would end the edit and take
// the caret away mid-word. The agent hears it and tries again once get_selection shows the edit ended.
const typingGuard = () => { if (host.textEdit && host.textEdit.active) throw fail("busy", "The person is typing in a text layer right now; select again once they finish"); };
const ops = {
  async select(a) {
    typingGuard();
    if (a.ids.length > 1) {
      if (!host.setSelection) throw fail("unsupported", "Selecting several nodes needs a newer page; reload Canvas");
      for (const x of a.ids) await ensureLoaded(x, a.boards, a.reveal !== false);
      host.setSelection(a.ids);
      await sleep(30);
      const sel = selectionState();
      return { selected: host.selection(), rendered: sel ? sel.rendered : null };
    }
    const id = a.ids[0];
    const loaded = await ensureLoaded(id, a.boards, a.reveal !== false);
    if (!loaded && !id.startsWith("widget:")) {
      if (a.reveal !== false) throw fail("not_found", 'Node "' + id + '" is not drawn on the canvas (hidden, or its board did not load in 5 s)');
    }
    if (a.reveal !== false && loaded) {
      const r = host.worldRectOf(id);
      if (r && overlap(viewWorld(), r) < 0.999) await host.fitRect(r, 120, host.cam.z);
    }
    host.selectId(id);
    await sleep(30);
    const sel = selectionState();
    return { selected: [id], rendered: sel ? sel.rendered : null };
  },
  async deselect() { typingGuard(); host.clearSel(); return { selected: [] }; },
  async fit(a) {
    const items = a.ids && a.ids.length ? await rectsFor(a.ids, a.boards, true) : [...host.boards.keys()].map((id) => ({ id, r: host.boxOf(id) }));
    if (!items.length) throw fail("not_found", a.ids ? "None of those nodes are drawn on the canvas" : "This page has no boards");
    // The same fly as the boards list; the answer waits until the camera arrives (or the person interrupts it).
    const f = await host.fitRect(union(items.map((i) => i.r)), a.padding, a.maxZoomPercent / 100);
    return { ...camState(), fitted: items.map((i) => i.id), flight: (f && f.flight) || "instant", page: host.page || null };
  },
  async zoom(a) {
    const c = host.cam, z = Math.min(MAX_ZOOM, Math.max(0.02, a.percent / 100)), ar = area();
    let ax = ar.x + ar.w / 2, ay = ar.y + ar.h / 2;
    if (a.anchor === "selection") { const r = host.sel && host.worldRectOf(host.sel); if (r) { const s = screenOf(r); ax = s.x + s.w / 2; ay = s.y + s.h / 2; } }
    else if (a.anchor && typeof a.anchor === "object") { if (a.anchor.space === "world") { ax = a.anchor.x * c.z + c.x; ay = a.anchor.y * c.z + c.y; } else { ax = a.anchor.x; ay = a.anchor.y; } }
    host.setCam({ z, x: ax - (ax - c.x) * (z / c.z), y: ay - (ay - c.y) * (z / c.z) });
    return camState();
  },
  async pan(a) {
    const c = host.cam, ar = area();
    if (a.nodeId) {
      await ensureLoaded(a.nodeId, a.boards);
      const r = rectOf(a.nodeId);
      if (!r) throw fail("not_found", 'Node "' + a.nodeId + '" is not drawn on the canvas');
      host.setCam({ z: c.z, x: ar.x + ar.w / 2 - (r.x + r.w / 2) * c.z, y: ar.y + ar.h / 2 - (r.y + r.h / 2) * c.z });
    } else if (a.to) {
      const sx = a.space === "screen" ? (a.to.x - c.x) / c.z : a.to.x, sy = a.space === "screen" ? (a.to.y - c.y) / c.z : a.to.y;
      host.setCam({ z: c.z, x: ar.x + ar.w / 2 - sx * c.z, y: ar.y + ar.h / 2 - sy * c.z });
    } else {
      const k = a.space === "screen" ? 1 : c.z;
      host.setCam({ z: c.z, x: c.x - a.by.dx * k, y: c.y - a.by.dy * k });
    }
    return camState();
  },
  async highlight(a) {
    const items = await rectsFor(a.ids, a.boards, a.reveal);
    const found = new Set(items.map((i) => i.id));
    for (const { id } of items) {
      const old = marks.get(id);
      if (old) { clearTimeout(old.timer); old.el.remove(); }
      const el = document.createElement("div");
      el.className = "hlb " + a.style;
      el.style.setProperty("--hlc", a.color || "#ff5a1f");
      if (a.label) { const s = document.createElement("span"); s.textContent = a.label; el.appendChild(s); }
      hl.appendChild(el);
      const m = { id, el, timer: 0 };
      if (a.durationMs > 0) m.timer = setTimeout(() => { el.remove(); marks.delete(id); }, a.durationMs);
      marks.set(id, m);
      placeMark(m);
    }
    return { highlighted: a.ids.map((id) => ({ id, found: found.has(id) })) };
  },
  async clear_highlights() { const n = marks.size; clearMarks(); return { cleared: n }; },
  async measure(a) {
    const nodes = (a.ids || []).map((id) => { const w = host.worldRectOf(id); return w ? { id, drawn: true, world: w, screen: screenOf(w), visibleFraction: Math.round(overlap(viewWorld(), w) * 100) / 100 } : { id, drawn: false }; });
    return { nodes, viewport: camState() };
  },
  async navigate(a) {
    const p = host.pageOfBoard ? host.pageOfBoard(a.board) : null;
    if (p && p !== host.page) await host.setPage(p);
    if (!(await waitFor(() => host.boards.has(a.board), 4000))) throw fail("not_found", 'No board "' + a.board + '" in this document');
    await host.fit(a.board);
    await ensureLoaded(a.board, { [a.board]: a.board });
    return camState();
  },
  async gloss(a) {
    const items = await rectsFor(a.ids, a.boards, true);
    if (!items.length) throw fail("not_found", "None of those nodes are drawn on the canvas");
    let revealed = false;
    if (a.reveal !== false) {
      const u = union(items.map((i) => i.r));
      if (overlap(viewWorld(), u) < 0.999) { await host.fitRect(u, 90, 1); revealed = true; await sleep(60); }
    }
    const ms = a.durationMs || 900, reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const { id, r } of items) {
      dropGloss(id);
      const el = document.createElement("div");
      el.className = "gl";
      el.style.cssText = "width:" + r.w + "px;height:" + r.h + "px;--w:" + r.w + "px;--h:" + r.h + "px;--r:" + radiusOf(id, r) + "px;--glc:var(--c-sel,#0d99ff);--gld:" + (reduce ? 600 : ms + 400) + "ms";
      el.innerHTML = '<div class="gl-ring"></div><div class="gl-clip"><div class="gl-band" style="animation-duration:' + ms + 'ms"></div></div>';
      glossLayer.appendChild(el);
      const g = { el, r, timer: setTimeout(() => dropGloss(id), ms + 600) };
      glossy.set(id, g);
      placeGloss(g);
    }
    if (a.chime) chime();
    return { glossed: items.map((i) => i.id), missing: a.ids.filter((id) => !items.some((i) => i.id === id)), revealed };
  },
  async toast_fallback(a) { return toast(a); },
  async page(a) {
    if (!host.pages || !host.pages.some((p) => p.id === a.page)) throw fail("not_found", 'No page "' + a.page + '" in this document');
    await host.setPage(a.page);
    return { page: host.page, ...camState() };
  },
  // Around the app's snapshot: a WebGPU canvas may come out blank in WKWebView.takeSnapshot, so the engine
  // page shows a 2D copy of its current frame for the moment the shell takes the picture.
  async freeze() { return host.freeze ? host.freeze() : { frozen: false }; },
  async thaw() { return host.thaw ? host.thaw() : { thawed: false }; },
  // A shader card's frame at time t, compiled from the revision the agent just wrote (src/page/shaders.js).
  // A video card's frame at time t (src/page/videos.js), decoded from its file by a separate element.
  async video_frame(a) {
    if (!host.videoFrame) throw fail("unsupported", "This page does not draw video cards");
    return host.videoFrame(a);
  },
  async shader_frame(a) {
    if (!host.shaderFrame) throw fail("unsupported", "This page does not draw shader cards");
    return host.shaderFrame(a);
  },
};

let chain = Promise.resolve();
function run(msg) {
  chain = chain.then(async () => {
    const ack = { client: clientId, id: msg.id };
    try {
      const fn = ops[msg.op];
      if (!fn) throw fail("unsupported", 'The page does not run "' + msg.op + '"');
      opSource = "mcp";
      try { ack.result = await fn(msg.args || {}); ack.ok = true; } finally { opSource = "user"; }
    } catch (e) {
      ack.ok = false;
      ack.error = { code: e.code || "failed", message: String(e.message || e).slice(0, 400) };
    }
    // An acknowledgement that stalled must give the next command its turn.
    try { await (await post("/api/ack", ack)).arrayBuffer(); } catch {}
  });
}

// ---------- stream ----------
const qs = new URLSearchParams({ client: clientId, role: "page", host: host.native ? "native" : "browser", file: host.file });
const es = host.reconnectingStream(() => "/api/bridge/events?" + qs, () => { open = false; });
es.addEventListener("message", (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === "hello") { open = true; flush(); }
  else if (m.type === "cmd") run(m);
});
es.connect();
// A hidden tab leaves the bridge so agents talk to the tab that is shown.
host.on("tab", (on) => { if (on) es.connect(); else es.close(); });
// op and ensureLoaded: the page's own scripts (context.js) reuse the agent ops and the board loading.
window.canvasBridge = { clientId, flush, op: (name, args) => ops[name](args || {}), ensureLoaded };
})();
