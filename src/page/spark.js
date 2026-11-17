// Talk to the selection, on the canvas (design/chat-to-selection). Runs on window.canvasHost next to live.js.
//
// The spark: a 28 px button with sparkles.2 that sits 8 px right of the selection box's top-right corner. It follows
// pan, zoom and resize in the same frame (it is placed from the camera loop's "cam" event, no bridge hop), hides while
// anything holds the pointer (move, resize, rotate, spacing handles) or text is being edited, and is not there for an
// empty selection, a card, or a selection that is off screen. Hover: "Ask about this ⌘↩". Click or Cmd+Return opens
// the composer (Cmd+Return in a text field stays the field's).
// The composer: chip (what the agent will see), a multi-line field, the harness (Claude Code or Codex, only what is
// installed), ⌘↩ sends (Return is a new line). While a run goes: its steps, a soft tint over the layers, Stop. Done:
// the summary, what changed, Undo (the whole run, one step) and Keep, and a follow-up that continues the same session.
// Closing it (Esc, a click elsewhere, Keep) never stops a run: the spark becomes a progress ring with the step under
// way as its tooltip, then a dot when the run is over. A layer with a thread keeps the dot; reopening shows the last
// exchange and the follow-up field. The server half is src/agent-run.ts; the layout math is /page/spark-logic.js.
// The page draws all of it (not the SwiftUI shell): it is locked to the camera for free, works in the browser too,
// and a <textarea> gives the system's text input (IME, dictation, spelling).

import * as L from "/page/spark-logic.js";
import { boardInView } from "/page/link-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, file } = host;
  const api = (p, body) => fetch(p, body === undefined ? {} : { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { code: j.code }); return j; }));
  const q = (o) => new URLSearchParams(o).toString();
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || !!(t.closest && t.closest("[contenteditable]")));
  const sym = (name, size, cls = "", logo = false) => `<i class="sk-ic ${cls}" style="--m:url(/api/agent/${logo ? "logo" : "symbols"}/${name}.png);width:${size}px;height:${size}px"></i>`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const GLYPH = { "⌘": "command", "↩": "return", "↑": "arrow.up", "↓": "arrow.down" };
  /** A shortcut as tight keycaps, one cap per key; symbols are SF Symbols centred in the cap. variant: "", "dark", "white". */
  const keycaps = (keys, variant = "") => `<span class="sk-keys ${variant}">${keys.map((k) => `<span class="sk-cap${k.length === 1 ? " one" : ""}">${GLYPH[k] ? sym(GLYPH[k], 10) : `<b>${esc(k)}</b>`}</span>`).join("")}</span>`;

  // ---------- styles ----------
  const css = document.createElement("style");
  css.textContent = `
.sk-ic{display:inline-block;flex:none;background:currentColor;-webkit-mask:var(--m) center/contain no-repeat;mask:var(--m) center/contain no-repeat}
.sk-layer{position:absolute;left:0;top:0;width:0;height:0;z-index:12;font-family:var(--c-font-sans);-webkit-font-smoothing:antialiased}
.sk-layer *{box-sizing:border-box}
.sk-layer{--sk-lift:0 0 0 .5px #0000000f,0 1px 3px #00000014,0 12px 32px -6px #0000002e;--sk-cap:0 0 0 .5px #0000000f,0 1px 1px #00000014}
@media (prefers-color-scheme: dark){.sk-layer{--sk-lift:0 0 0 .5px #00000099,0 1px 3px #00000066,0 12px 32px -6px #000000a6;--sk-cap:0 0 0 .5px #00000080,0 1px 1px #00000059}}
.sk-spark{position:absolute;width:28px;height:28px;border-radius:8px;border:0;background:var(--c-popover);color:var(--c-fg);display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;box-shadow:var(--sk-lift);transition:background var(--c-fast),transform var(--c-fast)}
.sk-spark:hover{transform:scale(1.06)}
.sk-spark.on{background:var(--c-accent);color:var(--c-fg)}
.sk-spark .sk-dot{position:absolute;left:20px;top:-2px;width:8px;height:8px;border-radius:50%;background:var(--c-fg);box-shadow:0 0 0 1.5px var(--c-canvas-bg)}
.sk-ring{position:absolute;width:28px;height:28px;border-radius:8px;background:var(--c-popover);color:var(--c-fg);cursor:pointer;box-shadow:var(--sk-lift)}
.sk-ring svg{position:absolute;left:0;top:0;width:28px;height:28px;transform:rotate(-90deg)}
.sk-ring .face{position:absolute;left:4px;top:4px;width:20px;height:20px;border-radius:10px;display:flex;align-items:center;justify-content:center}
.sk-ring.spin svg{animation:sk-spin 1s linear infinite}
.sk-tint{position:absolute;pointer-events:none;background:color-mix(in srgb,var(--c-sel) 6%,transparent);transition:opacity .2s}
.sk-tip{position:absolute;display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:6px;background:var(--c-tooltip);color:#fff;font-size:12px;line-height:1;font-weight:500;white-space:nowrap;pointer-events:none}
.sk-tip .count{font-weight:400;color:#ffffffa6}
.sk-keys{display:inline-flex;gap:2px;align-items:center;flex:none}
.sk-cap{display:inline-flex;align-items:center;justify-content:center;height:18px;min-width:18px;padding:0 4px;border-radius:4px;background:var(--c-accent);color:var(--c-muted-fg)}
.sk-cap.one{width:18px;padding:0}
.sk-cap b{font-size:11px;line-height:1;font-weight:500}
.sk-keys.dark .sk-cap{background:#ffffff26;color:#ffffffd9}
.sk-keys.white .sk-cap{background:var(--c-popover);box-shadow:var(--sk-cap)}
/* The composer (design/chat-to-selection, "Composer variations" F): one pill on the app's normal panel surface (opaque,
   layered shadows, no border, no glass: only the spark is glass). The thread of the conversation sits above the pill.
   At the pill's right end the harness mark and send are one capsule. Magic is grey: no blue in here.
   Motion: transform and opacity only, 160-220 ms, ease-out; reduced motion gets plain crossfades. */
.sk-comp{outline:none;position:absolute;width:300px;padding:4px;border-radius:18px;color:var(--c-fg);cursor:default;-webkit-user-select:none;user-select:none;display:flex;flex-direction:column;
  background:var(--c-sidebar);box-shadow:0 0 0 .5px #0000000f,0 1px 3px #00000014,0 12px 32px -6px #0000002e;
  opacity:0;scale:.9;transition:opacity .16s ease-out,scale .2s cubic-bezier(.2,.9,.3,1.06)}
.sk-comp.in{opacity:1;scale:1}
@media (prefers-color-scheme: dark){.sk-comp{box-shadow:0 0 0 .5px #00000099,0 1px 3px #00000066,0 12px 32px -6px #000000a6}}
@media (prefers-reduced-motion: reduce){.sk-comp{scale:1;transition:opacity .12s linear}}
.sk-thread{display:flex;flex-direction:column;gap:12px;padding:8px 8px 10px;max-height:320px;overflow-y:auto;cursor:grab;flex:none}
.sk-thread:empty{display:none}
.sk-thread.faded{-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 18px);mask-image:linear-gradient(to bottom,transparent 0,#000 18px)}
.sk-x{display:flex;flex-direction:column;gap:6px}
.sk-x.enter{animation:sk-up .2s ease-out both}
@keyframes sk-up{from{opacity:0;translate:0 8px}to{opacity:1;translate:0 0}}
.sk-x.settle .sk-reply{animation:sk-in .2s ease-out both}
.sk-x.settle .sk-meta,.sk-x.enter .sk-meta{animation:sk-in .2s ease-out .1s both}
.sk-x.enter .sk-now{animation:sk-in .2s ease-out .08s both}
@keyframes sk-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion: reduce){.sk-x.enter{animation:sk-in .12s linear both}.sk-x.settle .sk-reply,.sk-x .sk-meta,.sk-x .sk-now{animation-duration:.12s;animation-delay:0s}}
.sk-you{font-size:13px;line-height:18px;color:var(--c-muted-fg);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;padding-bottom:1px}
.sk-reply{font-size:13px;line-height:18px;color:var(--c-fg);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;padding-bottom:1px;-webkit-user-select:text;user-select:text}
.sk-reply.err{color:var(--c-danger)}
.sk-meta{display:flex;align-items:center;gap:8px;min-height:20px;font-size:12px;line-height:1;color:var(--c-muted-fg)}
.sk-now{display:flex;align-items:center;gap:5px;min-height:18px;font-size:13px;line-height:1}
.sk-now .sk-spin{width:11px;height:11px;color:var(--c-muted-fg)}
.sk-now .t{flex:1;min-width:0}
.sk-now .n{font-size:12px;color:var(--c-muted-fg)}
.sk-shim{color:var(--c-muted-fg);background:linear-gradient(90deg,var(--c-muted-fg) 0%,var(--c-muted-fg) 35%,var(--c-fg) 50%,var(--c-muted-fg) 65%,var(--c-muted-fg) 100%) 0 0/250% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:sk-shimmer 2s linear infinite}
@keyframes sk-shimmer{from{background-position:100% 0}to{background-position:0 0}}
@media (prefers-reduced-motion: reduce){.sk-shim{animation:none;-webkit-text-fill-color:currentColor;background:none}}
/* The pill: the field and, pinned bottom-right (aligned to the last line when the text wraps), the controls capsule. */
.sk-row{display:flex;align-items:flex-end;gap:4px;min-height:28px;cursor:grab}
.sk-mchip{flex:none;display:inline-flex;align-items:center;height:28px;padding:0 9px;border-radius:14px;background:#0000000f;font-size:12px;line-height:1;color:var(--c-fg);white-space:nowrap}
@media (prefers-color-scheme: dark){.sk-mchip{background:#ffffff1a}}
.sk-slot{position:relative;flex:1;min-width:0;display:flex;align-items:center;min-height:28px;padding:5px 4px 5px 8px;cursor:text}
.sk-field{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--c-fg);font:13px/18px var(--c-font-sans);padding:0;margin:0;height:18px;min-height:18px;max-height:90px;overflow-y:hidden;cursor:text;-webkit-user-select:text;user-select:text;transition:height .16s ease-out}
.sk-field.scroll{overflow-y:auto}
.sk-field::placeholder{color:var(--c-muted-fg)}
@media (prefers-reduced-motion: reduce){.sk-field{transition:none}}
.sk-mirror{position:absolute;left:8px;right:4px;top:0;visibility:hidden;pointer-events:none;font:13px/18px var(--c-font-sans);white-space:pre-wrap;overflow-wrap:break-word}
/* Truncation never clips glyphs: the box keeps 100% line height, the clip has 3 px of room above and below. */
.sk-trunc{display:block;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:3px 0;margin:-3px 0}
.sk-group{flex:none;display:flex;align-items:center;gap:2px;height:28px;padding:2px;border-radius:14px;background:#0000000f}
@media (prefers-color-scheme: dark){.sk-group{background:#ffffff1a}}
.sk-logo{position:relative;flex:none;width:24px;height:24px;border:0;padding:0;border-radius:12px;background:transparent;color:var(--c-fg);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .16s ease-out}
.sk-logo:hover{background:#0000000f}
@media (prefers-color-scheme: dark){.sk-logo:hover{background:#ffffff14}}
.sk-logo .sk-ic{width:15px;height:15px}
.sk-send{position:relative;flex:none;width:24px;height:24px;border-radius:12px;border:0;padding:0;cursor:pointer;color:var(--c-muted-fg);background:transparent;transition:background-color .18s ease-out,color .18s ease-out}
.sk-send.ready,.sk-send.stop{background:var(--c-fg);color:var(--c-sidebar)}
.sk-send:disabled{cursor:default}
.sk-send>.g{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transition:opacity .18s ease-out,scale .18s ease-out}
.sk-send>.sq{opacity:0;scale:.6}
.sk-send>.sq i{width:8px;height:8px;border-radius:2px;background:currentColor}
.sk-send.stop>.ar{opacity:0;scale:.6}
.sk-send.stop>.sq{opacity:1;scale:1}
@media (prefers-reduced-motion: reduce){.sk-send>.g{transition:opacity .12s linear;scale:1!important}}
.sk-btn{flex:none;display:inline-flex;align-items:center;border:0;border-radius:10px;height:20px;padding:0 8px;background:#0000000f;color:var(--c-fg);font:500 12px/1 var(--c-font-sans);cursor:pointer;white-space:nowrap}
@media (prefers-color-scheme: dark){.sk-btn{background:#ffffff1a}}
/* The harness menu: the palette's rows (neutral grey selection), on the same panel surface, popping from the mark. */
.sk-menu{position:absolute;right:30px;bottom:38px;min-width:150px;padding:4px;border-radius:10px;display:flex;flex-direction:column;gap:2px;
  background:var(--c-sidebar);box-shadow:0 0 0 .5px #0000000f,0 1px 3px #00000014,0 12px 32px -6px #0000002e;
  transform-origin:bottom right;opacity:0;scale:.96;pointer-events:none;visibility:hidden;transition:opacity .16s ease-out,scale .18s ease-out,visibility 0s .18s}
.sk-menu.open{opacity:1;scale:1;pointer-events:auto;visibility:visible;transition:opacity .16s ease-out,scale .18s ease-out,visibility 0s}
@media (prefers-color-scheme: dark){.sk-menu{box-shadow:0 0 0 .5px #00000099,0 1px 3px #00000066,0 12px 32px -6px #000000a6}}
@media (prefers-reduced-motion: reduce){.sk-menu{scale:1}}
.sk-menu button{display:flex;align-items:center;gap:8px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--c-fg);font:13px/1 var(--c-font-sans);cursor:pointer;text-align:left}
.sk-menu button:hover{background:#0000000a}
.sk-menu button.on{background:var(--c-row-selected)}
@media (prefers-color-scheme: dark){.sk-menu button:hover{background:#ffffff0d}}
.sk-menu .sk-ic{width:14px;height:14px;color:var(--c-fg)}
.sk-spin{width:14px;height:14px;flex:none;color:var(--c-fg);animation:sk-spin 1s steps(8) infinite}
.sk-none{font-size:12px;line-height:1;color:var(--c-muted-fg)}
@keyframes sk-spin{to{transform:rotate(360deg)}}
@keyframes sk-spinr{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}
.sk-ring.spin svg{animation:sk-spinr 1.2s linear infinite}
`;
  document.head.appendChild(css);
  const spinner = `<svg class="sk-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => `<line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(${a} 12 12)" opacity="${0.25 + (i / 7) * 0.75}"/>`).join("")}</svg>`;

  const layer = document.createElement("div");
  layer.className = "sk-layer";
  view.appendChild(layer);
  // Nothing in here reaches the canvas: a press, a wheel or a hover over the composer is the composer's.
  for (const t of ["pointerdown", "pointermove", "pointerup", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
    layer.addEventListener(t, (e) => { e.stopPropagation(); if (t === "contextmenu") e.stopPropagation(); }, { passive: true });
  }

  // ---------- state from the server ----------
  let harnesses = [];
  let runs = new Map(); // id -> run view (running ones)
  let ended = new Map(); // key -> the last run that ended in this page's life (the done view)
  let threads = [];
  const threadOf = (key) => threads.find((t) => t.key === key) || null;
  const runFor = (key) => [...runs.values()].find((r) => r.key === key) || null;
  let es = null;
  function connect() {
    if (es || document.hidden) return;
    es = new EventSource(`/api/agent/events?${q({ file })}`);
    es.onmessage = (m) => {
      let j;
      try { j = JSON.parse(m.data); } catch { return; }
      if (j.type === "hello") {
        runs = new Map((j.runs || []).map((r) => [r.id, r]));
        threads = j.threads || [];
      } else if (j.type === "run") {
        const r = j.run;
        if (r.status === "running") runs.set(r.id, r);
        else { runs.delete(r.id); ended.set(r.key, r); }
        if (comp.open && r.key === comp.key) renderComp();
      } else if (j.type === "threads") {
        threads = j.threads || [];
        if (comp.open) { comp.thread = threadOf(comp.key); renderComp(); }
      }
      place();
    };
  }
  const disconnect = () => { if (es) { es.close(); es = null; } };
  document.addEventListener("visibilitychange", () => (document.hidden ? disconnect() : connect()));
  connect();
  const loadHarnesses = () => api(`/api/agent/harnesses`).then((j) => { harnesses = j.harnesses || []; if (comp.open) renderComp(); }).catch(() => {});
  loadHarnesses();
  // Settings > Agents may have changed the default harness: the shell tells the server (its state post) and the page
  // at the same time, so the page asks a moment later.
  let harnessT = 0;
  host.on("prefs", () => { clearTimeout(harnessT); harnessT = setTimeout(loadHarnesses, 400); });

  // ---------- the selection on screen ----------
  const ids = () => (host.selection ? host.selection() : host.sel ? [host.sel] : []).filter((id) => id && !id.startsWith("widget:"));
  const rectOf = (list) => L.unionRects(list.map((id) => host.worldRectOf(id)));
  /** The visible canvas: the shell's islands in the app; in the browser, the page's own side panels. */
  const area = () => {
    let ins = host.insets || { l: 0, t: 0, r: 0, b: 0 };
    if (!host.native) {
      const vr = view.getBoundingClientRect(), side = (id) => { const el = document.getElementById(id); const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null; return r && r.width ? r : null; };
      const lp = side("left"), rp = side("props");
      ins = { ...ins, l: Math.max(ins.l, lp ? lp.right - vr.left : 0), r: Math.max(ins.r, rp ? vr.right - rp.left : 0) };
    }
    return L.visibleArea({ w: view.clientWidth, h: view.clientHeight }, ins);
  };
  let pressing = null; // a press on the canvas: the spark hides once it moves (a drag) and comes back on release
  view.addEventListener("pointerdown", (e) => { if (!layer.contains(e.target)) pressing = { x: e.clientX, y: e.clientY, moved: false }; }, true);
  addEventListener("pointermove", (e) => { if (pressing && !pressing.moved && Math.hypot(e.clientX - pressing.x, e.clientY - pressing.y) > 3) { pressing.moved = true; place(); } }, true);
  addEventListener("pointerup", () => { if (pressing) { pressing = null; setTimeout(place, 0); } }, true);
  const busy = () => {
    const lv = host.live, al = host.autolayout;
    return !!(pressing && pressing.moved) || !!(host.moving && host.moving()) || !!(lv && (lv.busy || lv.scaleMode)) || !!host.hand
      || !!(al && (al.dragging || al.handleActive)) || !!(host.rotate && host.rotate.active) || !!(host.textEdit && host.textEdit.active);
  };

  // ---------- spark, rings, tints ----------
  const spark = document.createElement("button");
  spark.className = "sk-spark";
  spark.setAttribute("aria-label", "Ask about this");
  spark.innerHTML = sym("sparkles.2", 16);
  spark.style.display = "none";
  layer.appendChild(spark);
  const tip = document.createElement("div");
  tip.className = "sk-tip";
  tip.style.display = "none";
  layer.appendChild(tip);
  let tipFor = null;
  const showTip = (el, html) => {
    tip.innerHTML = html;
    tip.style.display = "flex";
    tipFor = el;
    const x = parseFloat(el.style.left) + L.SPARK + L.GAP, y = parseFloat(el.style.top) + 2;
    tip.style.transform = `translate(${x}px,${y}px)`;
  };
  const hideTip = () => { tip.style.display = "none"; tipFor = null; };
  spark.addEventListener("pointerenter", () => { if (!comp.open) showTip(spark, `<span>Ask about this</span>${keycaps(["⌘", "↩"], "dark")}`); });
  spark.addEventListener("pointerleave", hideTip);
  spark.addEventListener("click", (e) => { e.preventDefault(); hideTip(); comp.open ? closeComp() : openComp(); });

  const rings = new Map(); // run id -> {el, tint}
  function ringEl(run) {
    let r = rings.get(run.id);
    if (r) return r;
    const el = document.createElement("div");
    el.className = "sk-ring";
    el.innerHTML = `<svg viewBox="0 0 28 28"><circle cx="14" cy="14" r="12.74" fill="none" stroke="var(--c-line)" stroke-width="2.52"/><circle class="arc" cx="14" cy="14" r="12.74" fill="none" stroke="var(--c-fg)" stroke-opacity=".6" stroke-width="2.52" stroke-linecap="round" stroke-dasharray="0 80"/></svg><div class="face">${sym("sparkles.2", 14)}</div>`;
    el.addEventListener("pointerenter", () => { const rr = runs.get(run.id) || run; const t = L.ringTip(rr.now); showTip(el, `<span>${esc(t.label)}</span>${t.count ? `<span class="count">${esc(t.count)}</span>` : ""}`); });
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("click", () => { hideTip(); openFor(runs.get(run.id) || run); });
    const tint = document.createElement("div");
    tint.className = "sk-tint";
    layer.insertBefore(tint, layer.firstChild);
    layer.appendChild(el);
    r = { el, tint };
    rings.set(run.id, r);
    return r;
  }
  const CIRC = 2 * Math.PI * 12.74;
  /** A layer's corner radius on screen, for the tint (a plain number only). */
  function radiusOf(id) {
    const lv = host.live;
    try {
      const b = lv && lv.boardOf(id), sc = b && lv.sceneOf(b);
      const find = (n) => { if (!n || typeof n !== "object") return null; if (String(n.id) === id) return n; for (const c of n.children || []) { const h = find(c); if (h) return h; } return null; };
      const n = sc && find(sc.root);
      return n && typeof n.cornerRadius === "number" ? n.cornerRadius : 0;
    } catch { return 0; }
  }

  let lastSel = "";
  function place() {
    const cam = host.cam;
    if (!cam) return;
    const a = area();
    const hide = busy();
    const sel = ids();
    const key = sel[0] || null;
    const selKey = sel.join(",");
    if (selKey !== lastSel) {
      lastSel = selKey;
      // A new selection closes a composer that was about another one (the run, if any, goes on).
      if (comp.open && comp.ids.join(",") !== selKey && !comp.pinned) closeComp();
    }
    // Runs going on this page: a tint over their layers, and a ring at their corner unless the spark is there.
    const seen = new Set();
    const glass = []; // in the app: what the shell draws as Liquid Glass (Spark.swift), in window points
    for (const run of runs.values()) {
      if (run.file && host.file && run.file !== host.file && !host.file.endsWith(run.file) && !run.file.endsWith(host.file)) continue;
      seen.add(run.id);
      const r = ringEl(run);
      const w = rectOf(run.ids);
      const s = w ? L.toScreen(w, cam) : null;
      const at = s && L.sparkAt(s, a);
      const onSpark = key === run.key && sel.length;
      if (s && !hide) {
        const rad = radiusOf(run.key) * cam.z;
        Object.assign(r.tint.style, { display: "block", transform: `translate(${s.x}px,${s.y}px)`, width: `${s.w}px`, height: `${s.h}px`, borderRadius: `${rad}px` });
      } else r.tint.style.display = "none";
      const showRing = at && !hide && !(onSpark && comp.open);
      r.el.style.display = showRing && !NATIVE ? "block" : "none";
      if (showRing && NATIVE) {
        const spin = !run.now || !run.now.total || run.now.total < 2;
        const t = L.ringTip(run.now);
        glass.push({ id: run.id, kind: "ring", x: at.x + VB.x, y: at.y + VB.y, sweep: spin ? null : L.ringSweep(run.now), tip: t.label, count: t.count });
      } else if (showRing) {
        r.el.style.left = `${at.x}px`;
        r.el.style.top = `${at.y}px`;
        r.el.style.transform = "";
        const arc = r.el.querySelector(".arc");
        const spin = !run.now || !run.now.total || run.now.total < 2;
        r.el.classList.toggle("spin", spin);
        const sweep = spin ? 90 : L.ringSweep(run.now);
        arc.setAttribute("stroke-dasharray", `${(sweep / 360) * CIRC} ${CIRC}`);
        if (tipFor === r.el) { const t = L.ringTip(run.now); tip.innerHTML = `<span>${esc(t.label)}</span>${t.count ? `<span class="count">${esc(t.count)}</span>` : ""}`; }
      }
    }
    for (const [id, r] of rings) if (!seen.has(id)) { r.el.remove(); r.tint.remove(); rings.delete(id); if (tipFor === r.el) hideTip(); }

    // The spark, on the selection (a ring replaces it while that layer's run goes and the composer is closed).
    const w = sel.length ? rectOf(sel) : null;
    const s = w ? L.toScreen(w, cam) : null;
    const at = s && L.sparkAt(s, a);
    const running = key ? runFor(key) : null;
    const showSpark = at && !hide && (!running || comp.open);
    spark.style.display = showSpark && !NATIVE ? "flex" : "none";
    if (showSpark && NATIVE) glass.push({ id: "spark", kind: "spark", x: at.x + VB.x, y: at.y + VB.y, active: comp.open, dot: !comp.open && !!threadOf(key), tip: "Ask about this" });
    else if (showSpark) {
      spark.style.left = `${at.x}px`;
      spark.style.top = `${at.y}px`;
      spark.classList.toggle("on", comp.open);
      const dot = !comp.open && !!threadOf(key);
      const have = spark.querySelector(".sk-dot");
      if (dot && !have) spark.insertAdjacentHTML("beforeend", `<span class="sk-dot"></span>`);
      else if (!dot && have) have.remove();
    }
    if (!showSpark && tipFor === spark) hideTip();
    if (tipFor && tipFor.style.display === "none") hideTip();
    else if (tipFor) tip.style.transform = `translate(${parseFloat(tipFor.style.left) + L.SPARK + L.GAP}px,${parseFloat(tipFor.style.top) + 2}px)`;

    if (NATIVE) postGlass(glass);

    // The composer follows its selection; it hides with the spark (a drag, a resize) and comes back after. Once
    // dragged somewhere, it stays there (in the window) and no longer follows.
    if (comp.open && comp.at) {
      const p = clampAt({ x: comp.at.x, y: comp.at.b - (comp.h || PH) }, a);
      comp.el.style.visibility = "visible";
      comp.el.style.transform = `translate(${Math.round(p.x)}px,${Math.round(p.y)}px)`;
    } else if (comp.open) {
      const cw = rectOf(comp.ids);
      const cs = cw ? L.toScreen(cw, cam) : null;
      if (!cs || hide || !L.sparkAt(cs, a)) { comp.el.style.visibility = "hidden"; return; }
      comp.el.style.visibility = "visible";
      const sp = L.sparkAt(cs, a);
      // Room is the visible canvas between the shell's chrome (the insets fit and zoom use): right of the spark if it
      // fits there, else left of the selection, else below.
      // The input row sits level with the spark and the thread grows upward, never past the canvas's safe top: older
      // exchanges scroll inside it. Near the top of the window there is more room below, so it opens downward.
      const f = fitThread(sp, a);
      const p = L.composerAt(cs, sp ? { x: sp.x, y: f.y } : sp, { w: PW, h: f.h }, a);
      const y = p.side === "right" || p.side === "left" ? f.y : p.y;
      comp.el.style.transform = `translate(${Math.round(p.x)}px,${Math.round(y)}px)`;
      // Open and close scale from (and back into) the spark.
      if (sp) comp.el.style.transformOrigin = `${Math.round(sp.x + L.SPARK / 2 - p.x)}px ${Math.round(sp.y + L.SPARK / 2 - y)}px`;
    }
  }
  // ---------- the app: the spark is Liquid Glass drawn by the shell ----------
  const NATIVE = !!host.native;
  let VB = { x: 0, y: 0 }; // the view's offset in the window
  const readVB = () => { const r = view.getBoundingClientRect(); VB = { x: r.left, y: r.top }; };
  readVB();
  let posted = "";
  function postGlass(list) {
    const j = JSON.stringify(list.map((g) => ({ ...g, x: Math.round(g.x * 2) / 2, y: Math.round(g.y * 2) / 2 })));
    if (j === posted) return;
    posted = j;
    try { window.webkit.messageHandlers.canvasSpark.postMessage(j); } catch {}
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden && NATIVE) postGlass([]); else place(); });
  host.on("cmd", (c) => {
    if (!c || c.cmd !== "sparkClick") return;
    if (c.id === "spark") { comp.open ? closeComp() : openComp(); return; }
    const run = runs.get(c.id);
    if (run) openFor(run);
  });

  /** The composer's height and top for the room around the spark; caps the thread so the panel stays whole on screen. */
  function fitThread(sp, a) {
    const thread = comp.el.querySelector(".sk-thread");
    const rowBlock = comp.el.offsetHeight - (thread ? thread.offsetHeight : 0); // the panel's padding and the input row
    const natural = rowBlock + (thread ? Math.min(320, thread.scrollHeight) : 0);
    if (!sp) return { h: natural, y: 0 };
    const top = a.y + L.MARGIN, bottom = a.y + a.h - L.MARGIN;
    const anchor = sp.y + L.SPARK + 4; // the panel's bottom when the pill (36) sits on the spark's (28) centre line
    const up = anchor - top, down = bottom - (sp.y - 4);
    const upward = natural <= up || up >= down;
    const h = Math.max(rowBlock, Math.min(natural, upward ? up : down));
    if (thread) {
      const cap = `${Math.max(0, Math.min(320, h - rowBlock))}px`;
      if (thread.style.maxHeight !== cap) { thread.style.maxHeight = cap; thread.scrollTop = thread.scrollHeight; fade(thread); }
    }
    return { h, y: upward ? anchor - h : sp.y - 4 };
  }
  /** A soft fade at the thread's top while older exchanges are scrolled out of view (never a hard cut). */
  const fade = (t) => t.classList.toggle("faded", t.scrollTop > 2);
  host.on("cmd", (c) => { if (c && c.cmd === "insets") setTimeout(place, 0); });
  host.on("cam", place);
  host.on("select", () => setTimeout(place, 0));
  host.on("deselect", () => setTimeout(place, 0));
  // A board laid out ("render"): once per frame at most. An overview of 2,000 boards landing one by one placed the
  // spark 2,000 times, each reading the view's size (a forced layout): a second of the open.
  let renderRaf = 0;
  host.on("render", () => { if (!renderRaf) renderRaf = requestAnimationFrame(() => { renderRaf = 0; place(); }); });
  host.on("page", () => setTimeout(place, 0));
  // A new window size: a dragged composer goes back beside its selection (it could be off screen now).
  addEventListener("resize", () => { readVB(); if (comp.at) { comp.at = null; } try { localStorage.removeItem(AT_KEY); } catch {} place(); });

  // ---------- the composer: the F pill, with the conversation above it ----------
  // The pill: the field and one capsule with the harness mark (a click opens the switch) and send, which becomes Stop
  // while a run goes. Above it, the exchange so far: her message, what the agent did, "2 changes" with Undo for that
  // run; while a run goes, one line of what is happening now. A follow-up continues the same session. Keeping is the
  // default: the next message or closing keeps. The controls are built once, so their state changes can animate.
  const PW = 300, PH = 36;
  const comp = { open: false, el: null, ids: [], key: null, thread: null, h: PH, pinned: false, error: "", at: null, pick: null, menu: false, seen: new Map(), closeT: 0 };
  // Where she last dragged the composer to (its left and bottom, view px), for this window size; the next one opens there.
  const AT_KEY = "canvas:askComposerAt";
  const savedAt = () => {
    try {
      const j = JSON.parse(localStorage.getItem(AT_KEY) || "null");
      return j && j.vw === view.clientWidth && j.vh === view.clientHeight && typeof j.b === "number" ? { x: j.x, b: j.b } : null;
    } catch { return null; }
  };
  const saveAt = (p) => { try { if (p) localStorage.setItem(AT_KEY, JSON.stringify({ x: p.x, b: p.b, vw: view.clientWidth, vh: view.clientHeight })); else localStorage.removeItem(AT_KEY); } catch {} };
  /** Inside the visible canvas (between the panels, the top pill and the zoom island), whole when it fits. */
  const clampAt = (p, a) => ({
    x: Math.max(a.x + L.MARGIN, Math.min(p.x, a.x + a.w - PW - L.MARGIN)),
    y: Math.max(a.y + L.MARGIN, Math.min(p.y, a.y + a.h - (comp.h || PH) - L.MARGIN)),
  });
  const field = document.createElement("textarea");
  field.className = "sk-field";
  field.rows = 1;
  field.setAttribute("aria-label", "Ask about this selection");
  // No system text affordances drawn over the field (inline predictions, autocorrect and Writing Tools badges).
  for (const [k, v] of [["autocomplete", "off"], ["autocorrect", "off"], ["autocapitalize", "off"], ["spellcheck", "false"], ["writingsuggestions", "false"], ["data-writing-tools", "false"]]) field.setAttribute(k, v);
  field.writingSuggestions = "false";
  // The field's height comes from a hidden copy of its text, so it can animate (no height:auto jump).
  const mirror = document.createElement("div");
  mirror.className = "sk-mirror";
  mirror.setAttribute("aria-hidden", "true");
  const grow = () => {
    mirror.textContent = (field.value || field.placeholder || " ") + (field.value.endsWith("\n") ? " " : "");
    const want = Math.max(18, Math.min(90, mirror.offsetHeight || 18));
    if (field.style.height !== `${want}px`) field.style.height = `${want}px`;
    field.classList.toggle("scroll", mirror.offsetHeight > 90);
    // Measure once the height has settled.
    clearTimeout(grow.t);
    grow.t = setTimeout(measure, 180);
    measure();
  };
  field.addEventListener("input", () => { grow(); syncSend(); });
  field.addEventListener("keydown", (e) => {
    // Return sends, Shift+Return is a new line (an IME composition keeps its own Return).
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); send(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (comp.menu) setMenu(false); else closeComp(); }
    e.stopPropagation(); // the canvas's keys (Delete, digits, Space) are not for this field
  });
  const running = () => (comp.key ? runFor(comp.key) : null);
  // The default (Settings > Agents: Claude Code unless she picked Codex), or what she picked on the mark for this ask. A
  // thread that once fell back to Codex still shows the default: the server falls back again at run time when it must.
  const harnessId = () => {
    const r = running();
    if (r) return r.harness;
    if (comp.pick && harnesses.some((h) => h.id === comp.pick)) return comp.pick;
    return harnesses[0] ? harnesses[0].id : null; // the server lists the default one first
  };
  const followUp = () => !!(comp.thread && comp.thread.session);
  const parts = {};
  /** The send button: disabled (a muted arrow on nothing), ready (text-colour fill), or Stop while a run goes. */
  function syncSend() {
    const b = parts.send;
    if (!b) return;
    const live = !!running();
    const ready = !live && !!field.value.trim() && !!harnessId();
    b.classList.toggle("stop", live);
    b.classList.toggle("ready", ready);
    b.disabled = !live && !ready;
    b.setAttribute("aria-label", live ? "Stop" : "Send");
    b.title = live ? "Stop (the changes so far stay)" : "Send (Return)";
  }
  function syncLogo() {
    const hid = harnessId();
    const hl = hid === "codex" ? "Codex" : "Claude Code";
    parts.logo.style.display = hid ? "" : "none";
    parts.logoIc.style.setProperty("--m", `url(/api/agent/logo/${hid === "codex" ? "codex" : "claude"}.png)`);
    parts.logo.title = hl + (harnesses.length > 1 ? ": click to switch" : "");
    parts.logo.setAttribute("aria-label", hl);
    parts.menu.innerHTML = harnesses.map((h) => `<button role="menuitemradio" aria-checked="${h.id === hid}" class="${h.id === hid ? "on" : ""}" data-h="${h.id}">${sym(h.id, 14, "", true)}<span>${esc(h.label)}</span></button>`).join("");
  }
  function setMenu(on) {
    comp.menu = on && harnesses.length > 1;
    parts.menu.classList.toggle("open", comp.menu);
  }

  function measure() {
    if (!comp.open) return;
    comp.h = comp.el.offsetHeight || PH;
    place();
  }

  /** The composer's elements, made once. */
  function build() {
    const el = document.createElement("div");
    el.className = "sk-comp";
    el.tabIndex = -1;
    el.innerHTML = `<div class="sk-thread"></div><div class="sk-row"><span class="sk-mchip" style="display:none"></span><div class="sk-slot"></div>`
      + `<div class="sk-group"><button class="sk-logo"><i class="sk-ic"></i></button>`
      + `<button class="sk-send" disabled><span class="g ar">${sym("arrow.up", 11)}</span><span class="g sq"><i></i></span></button></div></div>`
      + `<div class="sk-menu" role="menu"></div>`;
    el.querySelector(".sk-slot").append(field, mirror);
    Object.assign(parts, {
      thread: el.querySelector(".sk-thread"), row: el.querySelector(".sk-row"), chip: el.querySelector(".sk-mchip"),
      logo: el.querySelector(".sk-logo"), logoIc: el.querySelector(".sk-logo .sk-ic"), send: el.querySelector(".sk-send"), menu: el.querySelector(".sk-menu"),
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (comp.menu) setMenu(false); else closeComp(); } });
    parts.send.addEventListener("click", (e) => {
      e.preventDefault();
      const r = running();
      if (r) api(`/api/agent/stop`, { run: r.id }).catch((err) => tell(err.message));
      else send();
    });
    parts.logo.addEventListener("click", (e) => { e.preventDefault(); setMenu(!comp.menu); });
    parts.menu.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-h]");
      if (!b) return;
      comp.pick = b.dataset.h;
      setMenu(false);
      syncLogo();
      syncSend();
      field.focus({ preventScroll: true });
    });
    el.querySelector(".sk-slot").addEventListener("click", () => field.focus({ preventScroll: true }));
    parts.thread.addEventListener("scroll", () => fade(parts.thread), { passive: true });
    parts.thread.addEventListener("click", (e) => {
      const b = e.target.closest(".sk-undo");
      if (!b) return;
      api(`/api/agent/undo`, { file, key: comp.key, run: b.dataset.run }).then(() => field.focus({ preventScroll: true })).catch((err) => { comp.error = err.message; renderComp(); });
    });
    // Drag the composer anywhere by its surface (not the field, a button or the text); double-click there puts it back.
    for (const handle of [parts.thread, parts.row]) {
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("textarea,button,.sk-slot,.sk-reply")) return;
        e.preventDefault();
        const m0 = el.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
        const start = { x: m0 ? +m0[1] : 0, y: m0 ? +m0[2] : 0, px: e.clientX, py: e.clientY };
        let moved = false;
        handle.setPointerCapture(e.pointerId);
        const move = (m) => {
          const dx = m.clientX - start.px, dy = m.clientY - start.py;
          if (!moved && Math.hypot(dx, dy) < 3) return;
          moved = true;
          comp.at = { x: start.x + dx, b: start.y + dy + (comp.h || PH) };
          place();
        };
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
          if (moved && comp.at) { const p = clampAt({ x: comp.at.x, y: comp.at.b - (comp.h || PH) }, area()); comp.at = { x: p.x, b: p.y + (comp.h || PH) }; saveAt(comp.at); place(); }
          focusField();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      });
      handle.addEventListener("dblclick", (e) => { if (e.target.closest("textarea,button,.sk-slot,.sk-reply")) return; comp.at = null; saveAt(null); place(); });
    }
    layer.appendChild(el);
    return el;
  }

  async function openComp(opts = {}) {
    const sel = opts.ids || ids();
    if (!sel.length) return;
    if (!comp.el) comp.el = build();
    const wasOpen = comp.open;
    clearTimeout(comp.closeT);
    comp.open = true;
    if (comp.key !== sel[0]) { comp.at = savedAt(); comp.pick = null; comp.seen = new Map(); field.value = ""; }
    comp.ids = sel.slice();
    comp.key = sel[0];
    comp.error = "";
    setMenu(false);
    comp.thread = threadOf(comp.key);
    comp.el.dataset.view = "";
    if (!wasOpen) comp.seen = new Map(exchanges().map((r) => [r.id, r.status])); // what is there on open does not animate in
    comp.el.style.display = "flex";
    renderComp();
    place();
    // Grow out of the spark: start at .9 and transparent (the CSS default), then settle to full size.
    if (!wasOpen) requestAnimationFrame(() => requestAnimationFrame(() => comp.el.classList.add("in")));
    focusField();
    try {
      const j = await api(`/api/agent/context?${q({ file, ids: sel.join(",") })}`);
      if (!comp.open || comp.key !== sel[0]) return;
      if (j.harnesses) harnesses = j.harnesses;
      if (j.thread) { comp.thread = j.thread; threads = threads.filter((t) => t.key !== j.thread.key).concat([j.thread]); }
      renderComp();
    } catch (e) { console.warn("[canvas] ask context", e); }
  }
  function focusField() { if (comp.open) requestAnimationFrame(() => field.focus({ preventScroll: true })); }
  /** Closing keeps: the last finished run that changed something and has no outcome yet is marked kept. */
  function keepLast() {
    const t = comp.thread, last = t && t.runs[t.runs.length - 1];
    if (last && !last.outcome && last.status !== "running" && (last.seqs || []).length) api(`/api/agent/keep`, { file, key: t.key, run: last.id }).catch(() => {});
  }
  function closeComp() {
    if (!comp.open) return;
    comp.open = false;
    setMenu(false);
    keepLast();
    field.blur();
    hideTip();
    // Back into the spark, then out of the layout.
    comp.el.classList.remove("in");
    clearTimeout(comp.closeT);
    comp.closeT = setTimeout(() => { if (!comp.open) comp.el.style.display = "none"; }, 220);
    place();
  }
  /** Open on a run's layer (a ring clicked, or a run from the palette). */
  function openFor(run) {
    if (!run) return;
    const sel = ids();
    if (sel[0] !== run.key && host.setSelection) host.setSelection(run.ids);
    setTimeout(() => openComp({ ids: run.ids }), 0);
  }

  // One send at a time: a second Return before the server answers must not start a second run.
  let sending = false;
  async function send() {
    const prompt = field.value.trim();
    const h = harnessId();
    if (!prompt || !h || !comp.open || running() || sending) return;
    const fu = followUp();
    comp.error = "";
    keepLast();
    sending = true;
    try {
      const j = await api(`/api/agent/run`, { file, ids: comp.ids, prompt, followUp: fu, harness: h });
      runs.set(j.run.id, j.run);
      ended.delete(comp.key);
      field.value = "";
      grow();
      renderComp();
      place();
    } catch (e) {
      comp.error = e.message;
      renderComp();
    } finally {
      sending = false;
    }
  }

  const nowOf = (run) => run.now || (() => { const st = run.steps || []; const i = st.findIndex((x) => x.state === "now"); return i < 0 ? null : { label: st[i].label, index: i + 1, total: st.length }; })();
  const changesWord = (r) => { const n = typeof r.changes === "number" ? r.changes : (r.seqs || []).length; return `${n} ${n === 1 ? "change" : "changes"}`; };
  /** The exchanges to show: the thread's runs, the run going (live) last, the newest five. */
  function exchanges() {
    const list = comp.thread ? comp.thread.runs.slice() : [];
    const live = running();
    const out = list.filter((r) => !live || r.id !== live.id).map((r) => (ended.get(comp.key) && ended.get(comp.key).id === r.id ? { ...r, ...ended.get(comp.key), outcome: r.outcome } : r));
    const last = ended.get(comp.key);
    if (last && !out.some((r) => r.id === last.id) && (!live || live.id !== last.id)) out.push(last);
    if (live) out.push(live);
    return out.slice(-5);
  }
  function exchangeHtml(r, motion) {
    const you = `<div class="sk-you">${esc(r.prompt.split("\n")[0])}</div>`;
    if (r.status === "running") {
      const n = nowOf(r);
      return `<div class="sk-x ${motion}" data-run="${r.id}">${you}<div class="sk-now">${spinner}<span class="t"><span class="sk-trunc sk-shim sk-step">${esc(n ? n.label : "Working")}</span></span><span class="n sk-count">${n && n.total > 1 ? `${n.index}/${n.total}` : ""}</span></div></div>`;
    }
    const changed = (r.seqs || []).length > 0;
    const failed = r.status === "failed";
    const said = failed ? r.error || "The run did not finish" : r.detail || r.summary || (r.status === "stopped" ? "Stopped before any change" : "Nothing changed");
    const meta = changed
      ? `<div class="sk-meta"><span>${esc(changesWord(r))}</span>${r.outcome === "undone" ? `<span>Undone</span>` : `<button class="sk-btn sk-undo" data-run="${r.id}">Undo</button>`}</div>`
      : r.status === "stopped" ? `<div class="sk-meta"><span>Stopped</span></div>` : "";
    return `<div class="sk-x ${motion}" data-run="${r.id}">${you}<div class="sk-reply${failed && !changed ? " err" : ""}">${esc(said)}</div>${meta}</div>`;
  }

  function renderComp() {
    if (!comp.el) return;
    const xs = exchanges();
    const live = running();
    syncSend();
    syncLogo();
    const many = comp.ids.length > 1;
    parts.chip.style.display = many ? "" : "none";
    if (many) parts.chip.textContent = `${comp.ids.length} layers`;
    const ph = xs.length ? "Ask a follow-up" : "Ask about this";
    if (field.placeholder !== ph) { field.placeholder = ph; grow(); }
    // The thread changes only when an exchange is added or finishes; a running step updates its line in place.
    const viewKey = xs.map((r) => `${r.id}:${r.status}:${r.outcome || ""}:${(r.seqs || []).length}`).join("|") + `#${comp.error}`;
    if (comp.el.dataset.view === viewKey) {
      if (live) {
        const n = nowOf(live), x = parts.thread.querySelector(`.sk-x[data-run="${live.id}"]`);
        const t = x && x.querySelector(".sk-step"), c = x && x.querySelector(".sk-count");
        if (t && t.textContent !== (n ? n.label : "Working")) t.textContent = n ? n.label : "Working";
        if (c) c.textContent = n && n.total > 1 ? `${n.index}/${n.total}` : "";
      }
      return;
    }
    comp.el.dataset.view = viewKey;
    // New exchanges slide up from the pill; a finished one crossfades its status line into the reply.
    const motion = (r) => (!comp.seen.has(r.id) ? "enter" : comp.seen.get(r.id) === "running" && r.status !== "running" ? "settle" : "");
    const err = comp.error ? `<div class="sk-x enter"><div class="sk-reply err">${esc(comp.error)}</div></div>` : "";
    parts.thread.innerHTML = xs.map((r) => exchangeHtml(r, motion(r))).join("") + err;
    comp.seen = new Map(xs.map((r) => [r.id, r.status]));
    parts.thread.style.maxHeight = "";
    parts.thread.scrollTop = parts.thread.scrollHeight;
    fade(parts.thread);
    grow();
  }

  // A press anywhere else closes the composer (the run goes on).
  addEventListener("pointerdown", (e) => {
    if (!comp.open || layer.contains(e.target)) return;
    // The shell's own chrome is outside this page; a press on the canvas or the page's chrome closes it.
    closeComp();
  }, true);

  // Cmd+Return: open the composer on the selection. Never in a text field (the field's own key) or while text is edited.
  addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented) return;
    if (typing(e.target) || (host.textEdit && host.textEdit.active)) return;
    if (!ids().length || busy()) return;
    e.preventDefault();
    comp.open ? focusField() : openComp();
  });

  // From the shell: the palette's Recent asks ({cmd: "askOpen", key, ids, board, page}) fly to the layer and reopen its thread.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The Return that chose the ask in the palette must not reach the canvas too (Enter there selects the children).
  let swallowEnterUntil = 0;
  addEventListener("keydown", (e) => {
    if (e.key === "Enter" && performance.now() < swallowEnterUntil && !typing(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  host.on("cmd", async (c) => {
    if (!c || c.cmd !== "askOpen" || !Array.isArray(c.ids) || !c.ids.length) return;
    swallowEnterUntil = performance.now() + 800;
    try {
      const page = c.page || (c.board && host.pageOfBoard ? host.pageOfBoard(c.board) : null);
      if (page && page !== host.page) await host.setPage(page);
      let w = rectOf(c.ids);
      if (!w && c.board && host.boxOf(c.board)) {
        await host.fitRect(host.boxOf(c.board), 90, 1);
        const end = Date.now() + 1500;
        while (Date.now() < end && !(w = rectOf(c.ids))) await sleep(60);
      }
      if (w) await host.fitRect(w, 160, 2);
      host.setSelection(c.ids);
      await sleep(30);
      openComp({ ids: c.ids });
    } catch (e) { console.warn("[canvas] askOpen", e); }
  });

  // Ask agent on an error toast (the app's Toast, Model.askAgent): the composer opens on the selection, else on the
  // board in view, with the toast quoted in its field. Nothing is sent until the person presses Return.
  host.on("cmd", (c) => {
    if (!c || c.cmd !== "askPrefill" || typeof c.text !== "string") return;
    let sel = ids();
    if (!sel.length) {
      const cam = host.cam, v = host.view, ins = host.insets || { l: 0, t: 0, r: 0, b: 0 };
      const view = cam && v ? { x: (ins.l - cam.x) / cam.z, y: (ins.t - cam.y) / cam.z, w: (v.clientWidth - ins.l - ins.r) / cam.z, h: (v.clientHeight - ins.t - ins.b) / cam.z } : null;
      const rects = [...host.boards.keys()].map((id) => { const r = host.boxOf(id); return r ? { id, ...r } : null; }).filter(Boolean);
      const b = boardInView(rects, view);
      if (!b) { tell("Select a layer, then ask the agent about it"); return; }
      sel = [b];
      host.setSelection(sel);
    }
    setTimeout(() => {
      openComp({ ids: sel });
      field.value = c.text.slice(0, 4000);
      grow();
      syncSend();
      focusField();
    }, 0);
  });

  host.spark = { open: openComp, close: closeComp, get state() { return { open: comp.open, ids: comp.ids, running: running(), exchanges: comp.open ? exchanges() : [], runs: [...runs.values()], threads }; } };
  place();
}
