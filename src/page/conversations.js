// All conversations, in one place (the sparkle button at the top right, or the app's toolbar). A right sidebar lists the
// runs a person started from a selected layer or board (src/agent-run.ts, kept in the file's sidecar by src/threads.ts):
// the layer, the prompt, the state (running, done, stopped, failed), when, and the page. A click flies to the layer,
// selects it and reopens its thread (the spark's askOpen). A running row has Stop. Runs going come first.
// The server half is GET /api/agent/conversations; the rows' words are in /page/conversations-logic.js (node-tested).
// It takes the comments sidebar's place on the right (one of the two at a time) and, in the app, tells the shell so the
// canvas keeps clear of it (conversationsSidebar).

import * as L from "/page/conversations-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { file } = host;
  const api = (p, body) => fetch(p, body === undefined ? {} : { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }));
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  const css = document.createElement("style");
  css.textContent = `
.cv-empty{margin:0;padding-inline:calc(var(--c-sidebar-label-inset) - var(--c-sidebar-inset));color:var(--c-muted-fg)}
.cv-row[aria-disabled=true]{cursor:default;opacity:.7}
.cv-l1{display:flex;align-items:center;gap:8px;min-width:0}
.cv-l1 b{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-when{margin-left:auto;flex:none;color:var(--c-muted-fg)}
.cv-prompt{line-height:16px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;color:var(--c-muted-fg)}
.cv-l3{display:flex;align-items:center;gap:8px;min-width:0;color:var(--c-muted-fg)}
.cv-row[aria-current=true] :is(.cv-when,.cv-prompt,.cv-l3){color:var(--c-sidebar-fg)}
.cv-state{display:inline-flex;align-items:center;gap:6px;flex:none}
.cv-state i{width:6px;height:6px;border-radius:50%;background:currentColor}
.cv-state.running i{animation:cv-pulse 1.2s ease-in-out infinite}
.cv-state.failed{color:var(--c-fg)}
.cv-where{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-stop{margin-left:auto;flex:none;border:0;border-radius:6px;padding:4px 8px;background:var(--c-accent);color:var(--c-fg);font:inherit;cursor:pointer}
.cv-stop:hover{background:var(--c-hover)}
.cv-btn{position:fixed;top:8px;right:8px;z-index:13;width:28px;height:28px;border:0;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:0;background:var(--c-popover);color:var(--c-fg);cursor:pointer;box-shadow:0 0 0 .5px #0000000f,0 1px 3px #00000014}
body.cm-sidebar-open .cv-btn{top:2px;z-index:15;background:transparent;box-shadow:none}
body.cm-sidebar-open .cv-btn:hover{background:var(--c-hover)}
body.cm-sidebar-open:not(.native) .cm-sidebar-head{position:sticky;top:0;z-index:1;padding-inline-end:32px;background:var(--c-sidebar-surface)}
.native .cv-btn{display:none}
@keyframes cv-pulse{50%{opacity:.35}}
`;
  document.head.appendChild(css);

  const side = h("aside", "cv-sidebar right-sidebar");
  side.hidden = true;
  side.setAttribute("aria-label", "Conversations");
  const spark = `<svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 2l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1zM10.8 8.6l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z"/></svg>`;
  const btn = h("button", "cv-btn");
  btn.type = "button";
  btn.title = "Conversations";
  btn.setAttribute("aria-label", "Conversations");
  btn.innerHTML = spark;
  btn.onclick = () => toggle();
  document.body.append(side, btn);

  let list = [];
  let current = null;
  let timer = 0;
  let es = null;

  async function load() {
    try { list = (await api(`/api/agent/conversations?${new URLSearchParams({ file })}`)).conversations || []; } catch { return; }
    draw();
  }
  function draw() {
    if (side.hidden) return;
    side.replaceChildren();
    const head = h("div", "cv-head right-sidebar-header");
    const close = h("button", "right-sidebar-close");
    close.title = "Close conversations";
    close.type = "button";
    close.setAttribute("aria-label", "Close conversations");
    close.onclick = () => toggle(false);
    head.append(h("strong", "", "Conversations"), close);
    side.append(head);
    if (!list.length) { side.append(h("p", "cv-empty", "No conversations yet. Select a layer and ask the agent about it.")); return; }
    for (const c of L.runningFirst(list)) side.append(rowEl(L.rowOf(c)));
  }
  function rowEl(r) {
    const row = h("div", "cv-row right-sidebar-row");
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.dataset.run = r.run;
    row.dataset.status = r.status;
    row.setAttribute("aria-current", String(current === r.run));
    if (!r.canOpen) row.setAttribute("aria-disabled", "true");
    const l1 = h("div", "cv-l1");
    l1.append(h("b", "", r.title), h("span", "cv-when", r.when));
    const l3 = h("div", "cv-l3");
    const st = h("span", "cv-state " + r.status);
    st.append(h("i"), document.createTextNode(r.state));
    l3.append(st);
    if (r.where) l3.append(h("span", "cv-where", r.where));
    if (r.running) {
      const stop = h("button", "cv-stop", "Stop");
      stop.type = "button";
      stop.onclick = (e) => { e.stopPropagation(); api(`/api/agent/stop`, { run: r.run }).then(load).catch(() => {}); };
      l3.append(stop);
    }
    row.append(l1, h("div", "cv-prompt", r.prompt), l3);
    const open = () => {
      if (!r.canOpen) return;
      current = r.run;
      for (const el of side.querySelectorAll(".cv-row")) el.setAttribute("aria-current", String(el.dataset.run === r.run));
      if (window.canvasCmd) window.canvasCmd({ cmd: "askOpen", key: r.key, ids: r.ids, board: r.board, page: r.page });
    };
    row.onclick = open;
    row.onkeydown = (e) => { if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } };
    return row;
  }

  function toggle(open = side.hidden) {
    if (open === !side.hidden) return;
    if (open) document.querySelector('.cm-sidebar:not([hidden]) [aria-label="Close"]')?.click();
    side.hidden = !open;
    document.body.classList.toggle("cv-open", open);
    if (host.native) host.post({ conversationsSidebar: open });
    if (open) { load(); connect(); } else disconnect();
    window.dispatchEvent(new Event("resize"));
  }
  // Live: a run's progress and end arrive on the file's stream; reload the list a moment after, at most once a second.
  const soon = () => { if (!timer) timer = setTimeout(() => { timer = 0; load(); }, 600); };
  function connect() {
    if (es) return;
    es = new EventSource(`/api/agent/events?${new URLSearchParams({ file })}`);
    es.onmessage = (m) => {
      let j;
      try { j = JSON.parse(m.data); } catch { return; }
      if (j.type === "run" && j.run && j.run.status === "running" && list.some((c) => c.run === j.run.id)) return;
      soon();
    };
  }
  function disconnect() { if (es) { es.close(); es = null; } }
  // The comments sidebar took the place: step aside.
  new MutationObserver(() => { if (document.body.classList.contains("cm-sidebar-open") && !side.hidden) toggle(false); }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !side.hidden && !e.defaultPrevented && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) toggle(false); });
  host.on("cmd", (c) => { if (c && c.cmd === "conversations") toggle(c.open === undefined ? undefined : !!c.open); });
  host.on("resync", () => { if (host.native) host.post({ conversationsSidebar: !side.hidden }); if (!side.hidden) load(); });
}
