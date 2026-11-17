// Comments on the canvas (design: design/comments/comments.canvas). Press C (or the Comment button in the browser's
// bar) and click to pin a thread to the layer under the pointer; the layer under it lights up first. A pin is a small
// teardrop with the author's initial; it follows its layer when it moves or resizes and when the camera moves. A click
// on a pin opens the thread: replies, a Resolve check on the first comment, Delete thread in its right-click menu. A
// thread whose layer was deleted sits at its board's corner and says so; Pin to a layer puts it on another layer by
// hand. Esc leaves comment mode.
//
// The threads live in comments.json inside the .canvas package (src/comments.ts, docs/cloud/protocol.md). This page
// reads them with GET /api/comments and changes them by sending ops to POST /api/comments/ops; the answer is the
// whole list, which is drawn. Other pages and agents that comment reach it as the "comments" event on the document's
// stream. Pure rules (anchors, where a pin goes, which threads show) are in /page/comments-logic.js (node-tested).
//
// Pins are plain DOM over the canvas. Their places are worked out in host.beforeFrame, so they cost nothing while the
// camera and the layers stand still.

import * as L from "/page/comments-logic.js";

const host = window.canvasHost;

const SHOW_KEY = "canvas:comments:showResolved";
const PIN = 28;
const svg = (body, w = 14) => `<svg width="${w}" height="${w}" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  check: svg('<path d="M2.5 7.4l3 3 6-6.4"/>'),
  trash: svg('<path d="M2.5 3.8h9M5.5 3.8V2.6h3v1.2M3.8 3.8l.5 7.6h5.4l.5-7.6M5.8 6v3.6M8.2 6v3.6"/>'),
  send: svg('<path d="M7 11.5v-9M3.2 6.2L7 2.4l3.8 3.8"/>'),
  ret: svg('<path d="M11.5 3v4.2H3M5.8 4.6L3 7.2l2.8 2.6"/>', 11),
  bubble: svg('<path d="M7 1.8c3 0 5.2 2.1 5.2 4.7S10 11.2 7 11.2c-.7 0-1.3-.1-1.9-.3l-2.9 1.3.7-2.5C1.9 8.9 1.8 7.7 1.8 6.5 1.8 3.9 4 1.8 7 1.8z"/>'),
  layer: svg('<path d="M2 4.2V2.6A.6.6 0 012.6 2h1.6M9.8 2h1.6a.6.6 0 01.6.6v1.6M12 9.8v1.6a.6.6 0 01-.6.6H9.8M4.2 12H2.6a.6.6 0 01-.6-.6V9.8M5.4 5.4l3.9 1.6-1.6.7-.7 1.6z"/>', 12),
  ghost: svg('<path d="M2 4.2V2.6A.6.6 0 012.6 2h1.6M9.8 2h1.6a.6.6 0 01.6.6v1.6M12 9.8v1.6a.6.6 0 01-.6.6H9.8M4.2 12H2.6a.6.6 0 01-.6-.6V9.8"/>', 16),
  clock: svg('<circle cx="7" cy="7" r="5.4"/><path d="M7 4v3.2l2 1.2"/>', 11),
  alert: svg('<circle cx="7" cy="7" r="5.4"/><path d="M7 4.2v3.4M7 9.7v.1"/>', 11),
  sparkles: svg('<path d="M5.5 2l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1zM10.8 8.6l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z"/>', 12),
};
const CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30"><path d="M15 2A13 13 0 0 1 28 15A13 13 0 0 1 15 28H5A3 3 0 0 1 2 25V15A13 13 0 0 1 15 2Z" fill="#18181B" stroke="#fff" stroke-width="1.5"/><path d="M15 9v12M9 15h12" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>')}") 3 27, crosshair`;

function start(host) {
  const { view, file } = host;
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  /** A one-line label: its box trimmed to the capitals (an x for lowercase-only, cls "cm-t ex"), so a flex row centres the letters themselves. */
  const lbl = (text, cls = "cm-t") => h("span", cls, text);
  const txtBtn = (cls, text) => { const b = h("button", cls); b.type = "button"; b.append(lbl(text)); return b; };
  const btnEl = (cls, html, label) => { const b = h("button", cls); b.type = "button"; b.innerHTML = html; if (label) { b.setAttribute("aria-label", label); b.title = label; } return b; };
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  let showResolved = false;
  try { showResolved = localStorage.getItem(SHOW_KEY) === "1"; } catch {}

  const css = document.createElement("style");
  css.textContent = `
.cm-layer{position:absolute;left:0;top:0;width:100%;height:100%;z-index:14;pointer-events:none;overflow:hidden;font-family:var(--c-font-sans);-webkit-font-smoothing:antialiased;
  --cm-card:0 0 0 .5px #0000000f,0 1px 3px #00000014,0 12px 32px -6px #0000002e;--cm-pin:0 0 0 .5px #00000014,0 1px 2px #0000001f,0 4px 10px -2px #00000033;
  --cm-chip:var(--c-hover);--cm-line:var(--c-stroke);--cm-body:color-mix(in srgb,var(--c-fg) 80%,transparent);--cm-time:color-mix(in srgb,var(--c-muted-fg) 80%,transparent)}
.cm-layer *{box-sizing:border-box}
@media (prefers-color-scheme: dark){.cm-layer{--cm-card:0 0 0 .5px #00000099,0 1px 3px #00000066,0 12px 32px -6px #000000a6;--cm-pin:0 0 0 .5px #00000099,0 1px 2px #00000066,0 4px 10px -2px #00000080}}
.cm-pin{position:absolute;left:0;top:0;width:${PIN}px;height:${PIN}px;border:0;padding:0;border-radius:14px 14px 14px 3px;background:var(--c-popover);color:var(--c-fg);font:600 12px/100% var(--c-font-sans);display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;box-shadow:var(--cm-pin);will-change:transform}
.cm-pin:hover .cm-av,.cm-pin:hover .cm-agent{scale:1.06}
.cm-pin.open{color:var(--c-fg)}
.cm-pin.resolved:not(.open){opacity:.6}
.cm-av{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:11px;color:#fff;font:600 11px/100% var(--c-font-sans);flex:none;transition:scale .12s ease-out}
.cm-agent{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:var(--cm-chip);color:var(--c-fg);flex:none;transition:scale .12s ease-out}
.cm-ui{pointer-events:auto}
.cm-pop,.cm-comp{position:absolute;left:0;top:0;border-radius:16px;background:var(--c-popover);color:var(--c-fg);box-shadow:var(--cm-card);font-size:13px;line-height:18px;-webkit-user-select:text;user-select:text;cursor:default}
.cm-pop{width:340px}.cm-comp{width:320px}
.cm-pop[hidden],.cm-comp[hidden]{display:none}
.cm-chip{display:inline-flex;align-items:center;gap:5px;height:22px;min-width:0;padding:0 7px 0 6px;border-radius:7px;background:var(--cm-chip);color:color-mix(in srgb,var(--c-fg) 75%,transparent);font:500 12px/100% var(--c-font-sans)}
.cm-chip svg{flex:none;color:var(--c-muted-fg)}
.cm-chip span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:3px 0;margin:-3px 0}
.cm-sp{flex:1;min-width:0;height:1px}
.cm-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:26px;min-width:26px;padding:0;border:0;border-radius:8px;background:var(--cm-chip);color:var(--c-fg);font:500 12px/100% var(--c-font-sans);cursor:pointer;white-space:nowrap}
.cm-btn.txt{padding:0 9px}
.cm-btn.txt:has(svg){padding-left:7.5px}
.cm-btn:hover{background:var(--c-active)}
.cm-btn.on{background:var(--c-fg);color:var(--c-popover)}
.cm-btn.dim{color:var(--c-muted-fg)}
.cm-sep{height:1px;background:var(--cm-line);width:100%}
.cm-list{display:flex;flex-direction:column;gap:14px;padding:14px;max-height:340px;overflow-y:auto}
.cm-item{display:flex;gap:10px;align-items:flex-start}
.cm-item .cm-av,.cm-item .cm-agent{margin-top:1px}
.cm-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-top:3px}
.cm-who{position:relative;display:flex;align-items:baseline;gap:6px;min-height:18px;line-height:100%;padding-top:4.5px}
.cm-who:has(.cm-btn){padding-right:26px}
.cm-who b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;padding:3px 0;margin:-3px 0}
.cm-who time{flex:none;color:var(--cm-time);font-size:12px}
.cm-who .cm-btn{position:absolute;right:0;top:-1px;opacity:0;height:20px;min-width:20px;background:transparent;color:var(--c-muted-fg)}
.cm-item:hover .cm-who .cm-btn,.cm-item:focus-within .cm-who .cm-btn{opacity:1}
.cm-who .cm-btn.cm-res{top:-2px;height:22px;min-width:22px;width:22px;border-radius:11px;opacity:1}
.cm-who .cm-btn.cm-res:hover{background:var(--cm-chip);color:var(--c-fg)}
.cm-who .cm-btn.cm-res.on{background:var(--c-fg);color:var(--c-popover)}
.cm-who.first:has(.cm-res){padding-right:28px}
.cm-text{color:var(--cm-body);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.385}
.cm-note{padding:10px 14px;color:var(--c-muted-fg);font-size:12px;line-height:100%}
.cm-row{display:flex;align-items:flex-end;gap:8px;padding:10px 10px 10px 14px}
.cm-row .cm-fieldwrap{flex:1;min-width:0;padding:5px 0}
.cm-field{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--c-fg);font:13px/18px var(--c-font-sans);padding:0;margin:0;height:18px;min-height:18px;max-height:120px;overflow-y:hidden}
.cm-field::placeholder{color:var(--cm-time)}
.cm-field.scroll{overflow-y:auto}
.cm-send{flex:none;width:28px;height:28px;border-radius:14px;border:0;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;background:var(--cm-chip);color:var(--cm-time);transition:background-color .15s ease-out,color .15s ease-out}
.cm-send.ready{background:#18181b;color:#fff}
.cm-send:disabled{cursor:default}
.cm-compfield{display:flex;gap:10px;padding:14px 14px 10px}
.cm-compfield .cm-av{margin-top:1px}
.cm-compfield .cm-fieldwrap{flex:1;min-width:0;padding-top:3px}
.cm-foot{display:flex;align-items:center;gap:8px;padding:4px 12px 12px 14px}
.cm-key{display:inline-flex;align-items:center;justify-content:center;height:18px;min-width:18px;padding:0 5px;border-radius:4px;background:var(--cm-chip);color:var(--c-muted-fg);font:500 11px/100% var(--c-font-sans)}
.cm-menu{position:absolute;left:0;top:0;min-width:150px;padding:4px;border-radius:10px;background:var(--c-popover);box-shadow:var(--cm-card);z-index:2}
.cm-menu button{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--c-danger);font:500 12px/100% var(--c-font-sans);cursor:pointer;text-align:left}
.cm-menu button:hover{background:var(--c-hover)}
.cm-gone{display:flex;flex-direction:column;gap:10px;padding:12px 10px 10px 14px;border-radius:16px 16px 0 0;background:#fff7ed;color:#c2410c}
.cm-gone .cm-top{display:flex;align-items:center;gap:10px;min-height:22px}
.cm-gone .cm-acts{display:flex;align-items:center;gap:6px}
.cm-gone .cm-ghost{flex:none;display:flex;margin-left:-1.5px;color:#ea580c}
.cm-gone .cm-gt{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;line-height:100%}
.cm-gone b{font-weight:600;color:#9a3412;font-size:13px;line-height:100%}
.cm-gone .cm-gl{font-size:12px;line-height:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:3px 0;margin:-3px 0}
.cm-gone .cm-btn{background:#ffedd5;color:#9a3412}
.cm-gone .cm-acts .cm-btn.txt:first-child{padding-left:8.5px}
.cm-gone .cm-btn:hover{background:#fed7aa}
@media (prefers-color-scheme: dark){.cm-gone{background:#fb923c24;color:#fdba74}.cm-gone .cm-ghost{color:#fb923c}.cm-gone b{color:#fed7aa}.cm-gone .cm-btn{background:#fb923c2e;color:#fed7aa}.cm-gone .cm-btn:hover{background:#fb923c47}}
.cm-bar,.cm-hint{position:absolute;left:50%;translate:-50% 0;display:none;align-items:center;gap:10px;white-space:nowrap;font-size:13px;line-height:100%;pointer-events:none}
.cm-bar{height:36px;padding:0 5px 0 11px;border-radius:12px;background:var(--c-popover);color:var(--c-fg);box-shadow:var(--cm-card);font-size:12px;font-weight:500;pointer-events:auto}
.cm-bar.on,.cm-hint.on{display:flex}
.cm-bar svg{color:var(--c-muted-fg)}
.cm-bar>span:first-child,.cm-hint>span:first-child{display:flex}
.cm-hint{height:36px;padding:0 12px 0 11px;border-radius:12px;background:#18181be6;color:#fff;-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);box-shadow:0 0 0 .5px #ffffff1f,0 8px 24px -6px #00000059}
.cm-hint b{font-weight:600}
.cm-hint .cm-soft{color:#ffffffa6}
.cm-hint .cm-key{background:#ffffff26;color:#ffffffcc}
.cm-shared{position:absolute;right:12px;top:12px;display:none;align-items:center;gap:10px;height:36px;padding:0 12px 0 8px;border-radius:12px;background:color-mix(in srgb,var(--c-popover) 85%,transparent);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);color:color-mix(in srgb,var(--c-fg) 75%,transparent);box-shadow:0 0 0 .5px #0000000f,0 8px 24px -6px #00000026;font:500 12px/100% var(--c-font-sans);white-space:nowrap}
.cm-shared.on{display:flex}
.cm-people{display:flex;align-items:center}
.cm-people .cm-av{width:24px;height:24px;border-radius:12px;box-shadow:0 0 0 2px var(--c-popover)}
.cm-people .cm-av+.cm-av{margin-left:-6px}
.cm-people .cm-more{background:var(--cm-chip);color:var(--c-muted-fg);font-size:10px}
.cm-server{display:flex;align-items:center;gap:6px}
.cm-dot{flex:none;width:7px;height:7px;border-radius:50%;background:color-mix(in srgb,var(--c-muted-fg) 60%,transparent)}
.cm-dot.ok{background:#16a34a}.cm-dot.warn{background:#d97706}
.cm-state{display:inline-flex;align-items:center;gap:4px;min-width:0;color:var(--c-muted-fg);font-size:12px;line-height:100%}
.cm-state svg{flex:none}
.cm-state.wait{display:inline;white-space:nowrap}.cm-state.wait svg{vertical-align:calc(.5cap - 5.5px);margin-right:4px}
.cm-fail{display:flex;align-items:flex-start;gap:8px;color:var(--c-danger);font-size:12px;line-height:16px}
.cm-fail .cm-state{flex:1;align-items:flex-start;color:inherit;line-height:16px;white-space:normal;overflow-wrap:anywhere}
.cm-fail .cm-state svg{margin-top:2px}
.cm-fail .cm-btn{height:20px;min-width:20px;margin-top:-2px;padding:0 7px;font-size:12px}
.cm-failrow{padding:10px 14px 0}
.cm-hov{position:absolute;left:0;top:0;display:none;border:1.5px solid var(--c-sel);pointer-events:none;border-radius:3px}
#view.cm-mode,#view.cm-mode *{cursor:${CURSOR}!important}
#view.cm-mode .cm-ui,#view.cm-mode .cm-ui *{cursor:default!important}
#view.cm-mode .cm-ui textarea{cursor:text!important}
#view.cm-mode .cm-ui button,#view.cm-mode .cm-pin,#view.cm-mode .cm-pin *{cursor:pointer!important}
.cm-t,.cm-bar>span,.cm-hint>b,.cm-hint>.cm-soft,.cm-chip span,.cm-server span,.cm-who b,.cm-who time,.cm-gone b,.cm-gone .cm-gl{text-box:trim-both cap alphabetic}
.cm-t.ex{text-box-edge:ex alphabetic}
@media (prefers-reduced-motion: reduce){.cm-av,.cm-agent,.cm-send{transition:none}.cm-pin:hover .cm-av,.cm-pin:hover .cm-agent{scale:1}}`;
  document.head.appendChild(css);

  const layer = h("div", "cm-layer");
  layer.setAttribute("data-comments", "");
  view.appendChild(layer);
  const hov = h("div", "cm-hov");
  const pop = h("div", "cm-pop cm-ui"); pop.hidden = true; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Comment thread");
  const comp = h("div", "cm-comp cm-ui"); comp.hidden = true; comp.setAttribute("role", "dialog"); comp.setAttribute("aria-label", "New comment");
  const hint = h("div", "cm-hint");
  const shared = h("div", "cm-shared cm-ui");
  const bar = h("div", "cm-bar cm-ui");
  layer.append(hov, pop, comp, hint, bar, shared);

  /** doc: the file's comment identity (null until the first comment); threads: every thread, tombstones too. repin: a thread waiting for a new layer. */
  const st = { doc: null, threads: [], sync: null, me: "", mode: false, open: null, draft: null, repin: null, menu: false };
  const pins = new Map(); // thread id (or "draft") -> {el, x, y, vis}
  const gone = new Map(); // node id -> {rev, at, gone} what the file said about a layer with no drawing now
  const asked = new Set();

  // ---------- the file ----------
  const sendOps = (ops) => fetch("/api/comments/ops?file=" + encodeURIComponent(file), { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ ops }) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
    .then((j) => {
      apply(j);
      for (const x of j.rejected || []) tell(`Comment not saved: ${x.message}`);
      return j;
    });
  function apply(j) {
    if (j.doc !== undefined) st.doc = j.doc;
    if (Array.isArray(j.threads)) { st.threads = j.threads; st.sync = j.sync || null; }
    if (typeof j.me === "string") st.me = j.me;
    render();
  }
  let loading = 0;
  function load() {
    const n = ++loading;
    return fetch("/api/comments?file=" + encodeURIComponent(file)).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && n === loading) apply(j); }).catch(() => {});
  }
  const env = (op) => ({ opId: crypto.randomUUID(), doc: st.doc || "00000000-0000-4000-8000-000000000000", at: new Date().toISOString(), op });
  const thread = (id) => st.threads.find((t) => t.id === id);

  // ---------- which threads show, and where ----------
  const pageNow = () => host.page || (host.pages && host.pages[0] && host.pages[0].id) || null;
  const firstPage = () => (host.pages && host.pages[0] && host.pages[0].id) || null;
  let list = [], listSig = "";
  const sigOf = () => `${pageNow()}|${(host.pages || []).map((p) => p.id + ":" + p.boards.length).join(",")}|${showResolved}|${st.threads.length}`;
  function refreshList() {
    listSig = sigOf();
    list = L.visibleThreads(st.threads, showResolved).filter((t) => L.pageOf(t, (b) => host.pageOfBoard(b), firstPage()) === pageNow());
  }

  /** Ask the file whether a layer with no drawing is deleted (a 404) or only not drawn yet (its board is off screen). */
  function askGone(id) {
    const rev = host.doc && host.doc.revision, now = Date.now();
    const c = gone.get(id);
    if (asked.has(id) || String(id).startsWith("widget:") || (c && (c.rev === rev || now - c.at < 2000))) return;
    asked.add(id);
    fetch(host.api("/api/node") + "&id=" + encodeURIComponent(id) + "&depth=0")
      .then((r) => { gone.set(id, { rev, at: Date.now(), gone: r.status === 404 }); asked.delete(id); render(); })
      .catch(() => asked.delete(id));
  }
  const isGoneNow = (t) => !!(t.anchor && t.anchor.nodeId && gone.get(t.anchor.nodeId) && gone.get(t.anchor.nodeId).gone && !host.worldRectOf(t.anchor.nodeId));

  /** The world point of a thread's pin, or null while it is not known (its layer's board is not drawn). */
  function spotOf(t, slots) {
    const a = t.anchor || {};
    if (!a.nodeId) return L.pinSpot(t, {});
    const r = host.worldRectOf(a.nodeId);
    if (r) { gone.delete(a.nodeId); return L.pinSpot(t, { layerRect: r }); }
    askGone(a.nodeId);
    const c = gone.get(a.nodeId);
    if (!(c && c.gone)) return null;
    const bb = a.board && host.boxOf(a.board);
    const slot = slots.get(a.board) || 0;
    slots.set(a.board, slot + 1);
    return L.pinSpot(t, { gone: true, boardRect: bb, slot });
  }

  // ---------- pins ----------
  function avatar(author, cls = "") {
    if (L.isAgent(author)) { const a = h("span", "cm-agent " + cls); a.innerHTML = ICON.sparkles; return a; }
    const a = h("span", "cm-av " + cls);
    a.append(lbl(L.initialOf(author && author.name)));
    a.style.background = L.colorOf(author && author.name);
    return a;
  }
  function pinEl(id) {
    let p = pins.get(id);
    if (p) return p;
    const el = h("button", "cm-pin");
    el.type = "button";
    el.dataset.thread = id;
    el.title = "Open comment";
    el.style.display = "none";
    el.addEventListener("click", (e) => { e.stopPropagation(); if (id === "draft") return; openThread(st.open === id ? null : id); });
    layer.appendChild(el);
    p = { el, x: NaN, y: NaN, vis: false, key: "" };
    pins.set(id, p);
    return p;
  }
  function drawPin(p, t, author, open) {
    const live = t ? L.liveComments(t).length : 0;
    const key = `${open}|${live}|${author && author.name}`;
    if (p.key === key) return;
    p.key = key;
    p.el.textContent = "";
    if (open && t) p.el.append(lbl(String(live)));
    else p.el.append(avatar(author));
  }

  /** The list changed (a load, an op, Show resolved, a page): the pins and the open thread are rebuilt from it. */
  function render() {
    refreshList();
    const want = new Set(list.map((t) => t.id));
    if (st.draft) want.add("draft");
    for (const [id, p] of pins) if (!want.has(id)) { p.el.remove(); pins.delete(id); }
    for (const t of list) {
      const p = pinEl(t.id);
      const first = L.liveComments(t)[0];
      drawPin(p, t, first && first.author, st.open === t.id);
      p.el.classList.toggle("resolved", !!t.resolvedAt);
      p.el.classList.toggle("open", st.open === t.id);
      p.el.setAttribute("aria-label", `Comment from ${first && first.author ? first.author.name : "someone"}${first ? ": " + first.body.slice(0, 80) : ""}`);
    }
    if (st.draft) drawPin(pinEl("draft"), null, { name: st.me }, false);
    if (st.open && !L.stillOpen(st.open, list, true)) st.open = null;
    drawThread();
    drawBars();
    schedule();
  }

  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); };
  const bottomOf = () => (host.native ? (host.insets && host.insets.b || 0) + 16 : 56) + "px";

  /** Where each pin and popover goes: run in every frame the canvas draws, and nowhere else. */
  function place() {
    const cam = host.cam;
    if (!cam) return;
    if (sigOf() !== listSig) { render(); return; }
    const vw = view.clientWidth, vh = view.clientHeight;
    const slots = new Map();
    const at = new Map(); // id -> screen {x, y}
    const put = (id, spot) => {
      const p = pins.get(id);
      if (!p) return;
      if (!spot) { if (p.vis) { p.el.style.display = "none"; p.vis = false; } return; }
      const sx = cam.x + spot.x * cam.z, sy = cam.y + spot.y * cam.z;
      at.set(id, { x: sx, y: sy });
      const inside = sx > -PIN && sy > -PIN && sx < vw + PIN && sy < vh + PIN * 2;
      if (!inside) { if (p.vis) { p.el.style.display = "none"; p.vis = false; } return; }
      if (!p.vis) { p.el.style.display = ""; p.vis = true; }
      if (p.x !== sx || p.y !== sy) { p.x = sx; p.y = sy; p.el.style.transform = `translate(${Math.round(sx * 4) / 4}px,${Math.round((sy - PIN) * 4) / 4}px)`; }
      const gn = spot.kind === "board";
      if (p.el.classList.contains("gone") !== gn) p.el.classList.toggle("gone", gn);
    };
    for (const t of list) put(t.id, spotOf(t, slots));
    if (st.draft) put("draft", st.draft.spot());
    const size = (el, w, hh) => ({ w: el.offsetWidth || w, h: el.offsetHeight || hh });
    if (st.open && !pop.hidden) {
      if (at.has(st.open)) { const o = L.popoverAt(at.get(st.open), size(pop, 340, 200), vw, vh); pop.style.transform = `translate(${o.x}px,${o.y}px)`; }
      else pop.style.transform = "translate(-9999px,0)";
    }
    if (st.draft && at.has("draft") && !comp.hidden) { const o = L.popoverAt(at.get("draft"), size(comp, 320, 110), vw, vh); comp.style.transform = `translate(${o.x}px,${o.y}px)`; }
    bar.style.bottom = hint.style.bottom = bottomOf();
    const ins = host.insets || {};
    // In the app the shell's insets say what its islands cover; in the browser the bar sits under the page's own islands.
    let below = ins.t || 0;
    if (!host.native) { const vt = view.getBoundingClientRect().top; for (const e of document.querySelectorAll(".island")) below = Math.max(below, e.getBoundingClientRect().bottom - vt - 4); }
    shared.style.top = below + 12 + "px";
    shared.style.right = (ins.r || 0) + 12 + "px";
    if (st.mode && hovId) paintHover();
  }
  host.beforeFrame(() => { if (pins.size || st.draft || hovId) place(); });
  host.on("render", schedule);
  host.on("visible", schedule);
  host.on("page", () => { st.open = null; closeDraft(); render(); });
  host.on("cmd", (c) => { if (c && c.cmd === "insets") schedule(); if (c && c.cmd === "comment") setMode(!st.mode); });
  host.on("resync", () => load());
  if (host.es) host.es.addEventListener("comments", () => load());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

  // ---------- fields ----------
  function autoGrow(ta) {
    ta.style.height = "18px";
    ta.style.height = Math.min(120, ta.scrollHeight) + "px";
    ta.classList.toggle("scroll", ta.scrollHeight > 120);
  }
  /** A field: Return posts, Shift+Return is a new line, Esc cancels. Keys never reach the canvas. */
  function field(placeholder, onPost, onCancel, onChange) {
    const ta = h("textarea", "cm-field");
    ta.rows = 1;
    ta.placeholder = placeholder;
    ta.setAttribute("aria-label", placeholder);
    ta.spellcheck = true;
    ta.addEventListener("input", () => { autoGrow(ta); if (onChange) onChange(ta.value.trim() !== ""); });
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); const v = ta.value.trim(); if (v) onPost(v, ta); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    });
    ta.addEventListener("keyup", (e) => e.stopPropagation());
    return ta;
  }
  const sendBtn = (label, onClick) => { const b = btnEl("cm-send", ICON.send, label); b.onclick = onClick; return b; };

  /** Focus a field now, and once more after the press that opened it has finished. */
  function focusSoon(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    setTimeout(() => { if (document.activeElement !== el && el.isConnected && !el.closest("[hidden]")) el.focus({ preventScroll: true }); }, 0);
  }

  // ---------- a shared file: what waits, what the server refused ----------
  const opsFor = (list, id) => (list || []).filter((o) => o.comment === id);
  const syncCall = (what, opId) => fetch(`/api/comments/${what}?file=` + encodeURIComponent(file), { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ opId }) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); apply(j); })).catch((e) => tell(e.message));
  /** The clock and "Sends when you're back online" (or "Sending" while connected) that stands where the time would be. */
  function pendingState() {
    // Inline, not a row: the meta row lines its baseline up with the name's, and the clock sits on the capitals' middle (cap units).
    const s = h("span", "cm-state wait");
    s.innerHTML = ICON.clock;
    s.append(lbl(st.sync && st.sync.connected ? "Sending" : "Sends when you're back online"));
    return s;
  }
  /** "Not sent: reason" with Retry and Discard. */
  function failRow(r) {
    const row = h("div", "cm-fail");
    const s = h("span", "cm-state");
    s.innerHTML = ICON.alert;
    s.append(document.createTextNode(`Not sent: ${L.refusalReason(r, st.sync && st.sync.role)}`));
    const retry = txtBtn("cm-btn txt", "Retry"), drop = txtBtn("cm-btn txt dim", "Discard");
    retry.onclick = () => syncCall("retry", r.opId);
    drop.onclick = () => syncCall("discard", r.opId);
    row.append(s, retry, drop);
    return row;
  }
  const syncKey = () => (st.sync ? JSON.stringify([st.sync.connected, st.sync.role, st.sync.pending.map((o) => o.opId), st.sync.rejected.map((o) => [o.opId, o.kind, o.code, o.message])]) : "");

  // ---------- the thread card ----------
  const chip = (name, page) => { const c = h("span", "cm-chip"); c.innerHTML = ICON.layer; c.append(h("span", "", name)); c.title = page ? "On the canvas" : name; return c; };
  function layerLabel(t) {
    const a = t.anchor || {};
    if (!a.nodeId) return { name: "Canvas", gone: false };
    const info = host.layerInfo && !isGoneNow(t) ? host.layerInfo(a.nodeId) : null;
    return { name: (info && info.name) || (a.preview && a.preview.name) || a.nodeId, gone: isGoneNow(t) };
  }
  let popFor = null, popKey = "";
  function drawThread() {
    const t = st.open && thread(st.open);
    if (!t || !L.stillOpen(st.open, st.threads, showResolved)) {
      // A hidden field keeps the focus until the next frame: keys would go to it, not the canvas.
      if (!pop.hidden && pop.contains(document.activeElement)) document.activeElement.blur();
      pop.hidden = true; popFor = null; popKey = ""; return;
    }
    const where = layerLabel(t);
    const live = L.liveComments(t);
    const key = JSON.stringify([t.id, t.resolvedAt || "", where, live.map((c) => [c.id, c.body, c.editedAt || ""]), syncKey()]);
    pop.hidden = false;
    if (popFor === t.id && popKey === key) return;
    const keep = popFor === t.id ? pop.querySelector(".cm-field") : null;
    const draftText = keep ? keep.value : "";
    const hadFocus = keep && document.activeElement === keep;
    popFor = t.id; popKey = key;
    pop.textContent = "";
    // Resolve is a check at the end of the first comment's name row; Delete thread is in the thread's right-click menu.
    const resolveBtn = () => {
      const b = btnEl("cm-btn cm-res" + (t.resolvedAt ? " on" : ""), ICON.check, t.resolvedAt ? "Reopen thread" : "Resolve thread");
      b.title = t.resolvedAt ? "Reopen" : "Resolve";
      b.onclick = () => sendOps([env({ kind: "thread.resolve", thread: t.id, resolved: !t.resolvedAt })]).then(() => { if (!showResolved && !t.resolvedAt) { st.open = null; render(); } }).catch((e) => tell(e.message));
      return b;
    };
    if (where.gone) {
      const band = h("div", "cm-gone");
      const g = h("span", "cm-ghost"); g.innerHTML = ICON.ghost;
      const gt = h("div", "cm-gt");
      gt.append(h("b", "", "Layer deleted"), h("span", "cm-gl", L.previewLine(t.anchor && t.anchor.preview)));
      const re = txtBtn("cm-btn txt", "Pin to a layer");
      re.onclick = () => { st.repin = t.id; st.open = null; setMode(true); render(); };
      const top = h("div", "cm-top"), acts = h("div", "cm-acts");
      top.append(g, gt);
      acts.append(re);
      band.append(top, acts);
      pop.append(band, h("div", "cm-sep"));
    }
    const lst = h("div", "cm-list");
    live.forEach((c, i) => {
      const it = h("div", "cm-item");
      const body = h("div", "cm-body");
      const who = h("div", "cm-who");
      const waiting = opsFor(st.sync && st.sync.pending, c.id).length > 0;
      const tm = h("time", "", L.ago(c.createdAt));
      tm.title = c.createdAt;
      who.append(h("b", "", c.author && c.author.name ? c.author.name : "Someone"), waiting ? pendingState() : tm);
      if (i === 0) { who.classList.add("first"); who.append(resolveBtn()); }
      if (i > 0) {
        const x = btnEl("cm-btn", ICON.trash, "Delete comment");
        x.title = "Delete comment";
        x.onclick = () => sendOps([env({ kind: "comment.delete", comment: c.id })]).catch((e) => tell(e.message));
        who.append(x);
      }
      body.append(who, h("div", "cm-text", c.body));
      for (const r of opsFor(st.sync && st.sync.rejected, c.id)) body.append(failRow(r));
      it.append(avatar(c.author), body);
      lst.append(it);
    });
    pop.append(lst);
    const own = (st.sync ? st.sync.rejected : []).filter((r) => r.thread === t.id && !r.comment);
    if (own.length) { const box = h("div", "cm-failrow"); for (const r of own) box.append(failRow(r)); pop.append(box); }
    if (t.resolvedAt) pop.append(h("div", "cm-note", `Resolved by ${t.resolvedBy && t.resolvedBy.name ? t.resolvedBy.name : "someone"}`));
    pop.append(h("div", "cm-sep"));
    const row = h("div", "cm-row");
    const wrap = h("div", "cm-fieldwrap");
    const send = sendBtn("Send reply", () => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: false })));
    const ta = field("Reply", (v, el) => {
      el.disabled = true;
      sendOps([env({ kind: "comment.add", thread: t.id, comment: crypto.randomUUID(), body: v })])
        .then((j) => { el.disabled = false; if (!(j.rejected && j.rejected.length)) { el.value = ""; autoGrow(el); send.classList.remove("ready"); el.focus(); } })
        .catch((e) => { el.disabled = false; tell(e.message); });
    }, () => openThread(null), (ready) => send.classList.toggle("ready", ready));
    ta.value = draftText;
    send.classList.toggle("ready", draftText.trim() !== "");
    wrap.append(ta);
    row.append(wrap, send);
    pop.append(row);
    drawMenu();
    autoGrow(ta);
    lst.scrollTop = lst.scrollHeight;
    if (hadFocus) ta.focus();
    schedule();
  }
  /** The open thread's right-click menu (Delete thread) at st.menu, a point in the card; removed when st.menu is false. */
  function drawMenu() {
    const old = pop.querySelector(".cm-menu");
    if (old) old.remove();
    const t = st.menu && st.open && thread(st.open);
    if (!t || pop.hidden) return;
    const m = h("div", "cm-menu");
    m.setAttribute("role", "menu");
    const del = h("button");
    del.type = "button";
    del.setAttribute("role", "menuitem");
    del.innerHTML = ICON.trash;
    del.append(lbl("Delete thread"));
    del.setAttribute("aria-label", "Delete thread");
    del.onclick = () => { st.menu = false; st.open = null; sendOps([env({ kind: "thread.delete", thread: t.id })]).catch((e) => tell(e.message)); render(); };
    m.append(del);
    pop.append(m);
    // At the pointer, kept inside the card.
    m.style.left = Math.max(4, Math.min(st.menu.x, pop.clientWidth - m.offsetWidth - 4)) + "px";
    m.style.top = Math.max(4, Math.min(st.menu.y, pop.clientHeight - m.offsetHeight - 4)) + "px";
  }
  function openThread(id) {
    st.open = id;
    st.menu = false;
    closeDraft();
    render();
    if (id) focusSoon(pop.querySelector(".cm-field"));
  }

  // ---------- a new thread ----------
  function closeDraft() {
    if (!st.draft) return;
    st.draft = null;
    if (comp.contains(document.activeElement)) document.activeElement.blur();
    comp.hidden = true;
    comp.textContent = "";
    const p = pins.get("draft");
    if (p) { p.el.remove(); pins.delete("draft"); }
  }
  /** The anchor a click at (cx, cy) makes: the layer under it and the point on it, else a point on the page. */
  function anchorAt(e) {
    const cx = e.clientX, cy = e.clientY, cam = host.cam, vb = host.viewBox;
    const world = { x: (cx - vb.l - cam.x) / cam.z, y: (cy - vb.t - cam.y) / cam.z };
    const id = host.pickSelectable ? host.pickSelectable(cx, cy, !!e.metaKey) : host.pick(cx, cy);
    const rect = id ? host.worldRectOf(id) : null;
    const chain = id && host.chainOf ? host.chainOf(id) : [];
    const board = chain.length ? chain[0] : null;
    const isCard = !!id && String(id).startsWith("widget:");
    const info = isCard ? { name: "Card", type: "widget" } : id && host.layerInfo ? host.layerInfo(id) : null;
    const nodeId = id && rect ? id : null;
    return L.anchorFor({ nodeId, rect, point: world, page: pageNow() || undefined, board: nodeId && board && !isCard ? board : undefined, info });
  }
  /** A click in comment mode: pin where it landed. Opens the composer there. */
  function startDraft(e) {
    const anchor = anchorAt(e);
    st.open = null;
    closeDraft();
    st.draft = { anchor, spot: () => { if (!anchor.nodeId) return { x: anchor.x, y: anchor.y, kind: "page" }; const r = host.worldRectOf(anchor.nodeId); return r ? L.pinSpot({ anchor }, { layerRect: r }) : null; } };
    comp.textContent = "";
    const fieldRow = h("div", "cm-compfield");
    const wrap = h("div", "cm-fieldwrap");
    const send = sendBtn("Post comment", () => post());
    const ta = field("Add a comment", () => post(), () => { closeDraft(); render(); }, (ready) => send.classList.toggle("ready", ready));
    function post() {
      const v = ta.value.trim();
      if (!v) return;
      ta.disabled = true;
      const a = st.draft && st.draft.anchor;
      sendOps([env({ kind: "thread.create", thread: crypto.randomUUID(), anchor: a, comment: crypto.randomUUID(), body: v })])
        .then((j) => { if (!(j.rejected && j.rejected.length)) closeDraft(); else ta.disabled = false; render(); })
        .catch((err) => { ta.disabled = false; tell(err.message); });
    }
    wrap.append(ta);
    fieldRow.append(avatar({ name: st.me }), wrap);
    const foot = h("div", "cm-foot");
    const key = h("span", "cm-key"); key.innerHTML = ICON.ret; key.title = "Return posts";
    foot.append(chip(anchor.preview ? anchor.preview.name || "Layer" : "Canvas", !anchor.nodeId), h("span", "cm-sp"), key, send);
    comp.append(fieldRow, foot);
    comp.hidden = false;
    render();
    place();
    focusSoon(ta);
  }

  // ---------- the layer under the pointer lights up ----------
  let hovId = null, hovRaf = 0, ptr = null;
  function paintHover() {
    const r = hovId && host.worldRectOf(hovId);
    const cam = host.cam;
    if (!r || !cam) { hov.style.display = "none"; return; }
    hov.style.display = "block";
    hov.style.transform = `translate(${cam.x + r.x * cam.z}px,${cam.y + r.y * cam.z}px)`;
    hov.style.width = r.w * cam.z + "px";
    hov.style.height = r.h * cam.z + "px";
  }
  function trackHover() {
    hovRaf = 0;
    if (!st.mode || !ptr) { hovId = null; hov.style.display = "none"; return; }
    const over = document.elementFromPoint(ptr.x, ptr.y);
    const id = over && over.closest && over.closest(".cm-ui, .cm-pin") ? null : host.pickSelectable ? host.pickSelectable(ptr.x, ptr.y, !!ptr.meta) : host.pick(ptr.x, ptr.y);
    hovId = id || null;
    paintHover();
  }
  view.addEventListener("pointermove", (e) => { if (!st.mode) return; ptr = { x: e.clientX, y: e.clientY, meta: e.metaKey }; if (!hovRaf) hovRaf = requestAnimationFrame(trackHover); });
  view.addEventListener("pointerleave", () => { ptr = null; hovId = null; hov.style.display = "none"; });

  // ---------- the bars ----------
  function drawBars() {
    drawShared();
    hint.classList.toggle("on", st.mode);
    hint.innerHTML = "";
    if (st.mode) {
      const m = h("span"); m.innerHTML = ICON.bubble;
      const key = h("span", "cm-key");
      key.append(lbl("esc", "cm-t ex"));
      hint.append(m, h("b", "", st.repin ? "Pin to a layer" : "Comment mode"), h("span", "cm-soft", st.repin ? "Click the layer this comment is about" : "Click a layer to pin a comment"), key);
    }
    const n = L.counts(st.threads);
    const show = !st.mode && n.open + n.resolved > 0;
    bar.classList.toggle("on", show);
    bar.innerHTML = "";
    bar.style.paddingRight = "";
    if (show) {
      const m = h("span"); m.innerHTML = ICON.bubble; m.style.display = "flex";
      bar.append(m, h("span", "", `${n.open} open`));
      if (n.resolved) {
        const b = txtBtn("cm-btn txt dim", showResolved ? `Hide ${n.resolved} resolved` : `Show ${n.resolved} resolved`);
        b.setAttribute("aria-pressed", String(showResolved));
        b.onclick = () => { showResolved = !showResolved; try { localStorage.setItem(SHOW_KEY, showResolved ? "1" : "0"); } catch {} render(); };
        bar.append(b);
      } else bar.style.paddingRight = "12px";
    }
  }

  /** The shared bar (design board 5): who commented, the server and whether it is reachable. Only for a shared file. */
  const STATUS = { connected: ["ok", "Connected"], offline: ["", "Offline. Comments are kept and sent when the server is back"], signedOut: ["warn", "Signed out. Sign in in Settings > Cloud"], signInAgain: ["warn", "Sign in again in Settings > Cloud"], forbidden: ["warn", "No access to this team"], tooOld: ["warn", "The server is too old for this Canvas"], tooNew: ["warn", "The server is newer than this Canvas. Update Canvas"] };
  function drawShared() {
    const s = st.sync;
    shared.classList.toggle("on", !!s);
    shared.textContent = "";
    if (!s) return;
    const seen = new Map();
    for (const t of st.threads) for (const c of t.comments) {
      if (c.deletedAt || !c.author || L.isAgent(c.author)) continue;
      const key = c.author.email || c.author.name;
      if (key && !seen.has(key)) seen.set(key, c.author);
    }
    const people = [...seen.values()];
    if (people.length) {
      const g = h("div", "cm-people");
      for (const a of people.slice(0, 4)) { const e = avatar(a); e.title = a.email || a.name; g.append(e); }
      if (people.length > 4) { const m = h("span", "cm-av cm-more"); m.append(lbl("+" + (people.length - 4))); m.title = people.slice(4).map((a) => a.name).join(", "); g.append(m); }
      shared.append(g);
    }
    const [tone, say] = STATUS[s.status] || STATUS.offline;
    const srv = h("div", "cm-server");
    const dot = h("span", "cm-dot" + (tone ? " " + tone : ""));
    srv.append(dot, h("span", "", s.host));
    srv.title = say;
    shared.setAttribute("aria-label", `${s.host}: ${say}`);
    shared.dataset.status = s.status;
    shared.append(srv);
  }

  // ---------- comment mode ----------
  function setMode(on) {
    on = !!on;
    if (st.mode === on) return;
    st.mode = on;
    view.classList.toggle("cm-mode", on);
    if (btn) { btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", String(on)); }
    if (!on) { closeDraft(); st.repin = null; hovId = null; hov.style.display = "none"; }
    render();
    host.emit("commentmode", on);
  }

  // The browser's bar has a button; the app's shell takes the key and {cmd: "comment"}.
  let btn = null;
  if (!host.native) {
    const snap = document.querySelector(".island #snapBtn");
    if (snap) {
      btn = h("button", "", "Comment");
      btn.id = "commentBtn";
      btn.title = "Comment on the canvas  C";
      btn.setAttribute("aria-pressed", "false");
      btn.onclick = () => setMode(!st.mode);
      snap.parentNode.insertBefore(btn, snap);
    }
  }

  addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && !typing(e.target)) {
      if (st.menu && st.open) { st.menu = false; drawMenu(); e.preventDefault(); e.stopPropagation(); return; }
      if (st.draft) { closeDraft(); render(); e.preventDefault(); e.stopPropagation(); return; }
      if (st.open) { openThread(null); e.preventDefault(); e.stopPropagation(); return; }
      if (st.mode) { setMode(false); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.key !== "c" && e.key !== "C") return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || typing(e.target) || (e.target && e.target.closest && e.target.closest("[contenteditable]"))) return;
    if (host.textEdit && host.textEdit.active) return;
    e.preventDefault();
    setMode(!st.mode);
  }, true);

  // In comment mode a press on the canvas pins a comment instead of selecting, moving or panning. Space (hand) and the
  // other buttons keep working. Everything inside a comment card is the card's own.
  const inUi = (t) => !!(t && t.closest && t.closest(".cm-ui, .cm-pin"));
  let pressed = null;
  const mine = (e) => st.mode && !host.hand && e.button === 0 && view.contains(e.target) && !inUi(e.target);
  addEventListener("pointerdown", (e) => {
    if (!inUi(e.target) && (st.open || st.draft) && view.contains(e.target) && !st.mode) { st.menu = false; openThread(null); closeDraft(); render(); }
    if (!mine(e)) { pressed = null; return; }
    e.preventDefault(); e.stopImmediatePropagation();
    pressed = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }, true);
  addEventListener("pointerup", (e) => {
    if (!pressed || e.pointerId !== pressed.id) return;
    const p = pressed; pressed = null;
    e.preventDefault(); e.stopImmediatePropagation();
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) return;
    if (st.repin) {
      const id = st.repin, a = anchorAt(e);
      if (!a.nodeId) { tell("Click a layer to pin this comment to"); return; }
      st.repin = null;
      sendOps([env({ kind: "thread.move", thread: id, anchor: a })]).then(() => { setMode(false); openThread(id); }).catch((err) => tell(err.message));
      return;
    }
    startDraft(e);
  }, true);
  for (const n of ["mousedown", "mouseup", "click", "dblclick"]) {
    addEventListener(n, (e) => { if (st.mode && !host.hand && e.button === 0 && view.contains(e.target) && !inUi(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  }
  // Presses inside a card or on a pin must not start a canvas gesture either.
  for (const n of ["pointerdown", "pointerup", "mousedown", "dblclick"]) layer.addEventListener(n, (e) => { if (inUi(e.target)) e.stopPropagation(); }, false);
  // A right-click on the open thread shows its menu (Delete thread) at the pointer; the reply field keeps the system's
  // own (paste, spelling). Never the canvas's layer menu. A press anywhere else in the card closes it.
  pop.addEventListener("contextmenu", (e) => {
    e.stopPropagation();
    if (typing(e.target)) return;
    e.preventDefault();
    const r = pop.getBoundingClientRect(), z = pop.offsetWidth ? r.width / pop.offsetWidth : 1;
    st.menu = { x: Math.round((e.clientX - r.left) / z), y: Math.round((e.clientY - r.top) / z) };
    drawMenu();
  });
  pop.addEventListener("pointerdown", (e) => {
    if (!st.menu || e.button === 2 || (e.target.closest && e.target.closest(".cm-menu"))) return;
    st.menu = false; drawMenu();
  });

  host.comments = {
    get mode() { return st.mode; },
    get threads() { return st.threads; },
    get open() { return st.open; },
    get doc() { return st.doc; },
    get sync() { return st.sync; },
    setMode,
    reload: load,
  };
  load();
}

if (host && host.file && host.view) start(host);
