// The Conversations section of the Comments sidebar lists the runs started from a layer or board:
// the layer, the prompt, the state (running, done, stopped, failed), when, and the page. A click flies to the layer,
// selects it and reopens its thread (the spark's askOpen). A running row has Stop. Runs going come first.
// The server half is GET /api/agent/conversations; the rows' words are in /page/conversations-logic.js (node-tested).

import * as L from "/page/conversations-logic.js";

export function installConversations(host, section, toggle) {
  const { file } = host;
  const api = (p, body) => fetch(p, body === undefined ? {} : { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }));
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  const css = document.createElement("style");
  css.textContent = `
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
.cv-btn[aria-expanded=true]{top:2px;right:calc(var(--c-sidebar-inset) + var(--c-sidebar-row) + 4px);z-index:15;background:var(--c-sidebar-selected);box-shadow:none}
.cv-btn:hover{background:var(--c-hover)}
.cv-btn .cm-unread-dot{position:absolute;top:3px;right:3px}
body.cm-sidebar-open:not(.native) .cm-sidebar-head .right-sidebar-close{margin-inline-start:32px}
@keyframes cv-pulse{50%{opacity:.35}}
`;
  document.head.appendChild(css);

  const btn = host.native ? null : h("button", "cv-btn");
  const dot = h("span", "cm-unread-dot");
  dot.hidden = true;
  if (btn) {
    btn.type = "button";
    btn.title = "Comments";
    btn.setAttribute("aria-controls", "comments-sidebar");
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M9 18H6l-3 3V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z"/></svg>`;
    btn.append(dot);
    btn.onclick = () => toggle();
    document.body.append(btn);
  }

  let list = [];
  let request = 0;
  let current = null;
  let timer = 0;
  let es = null;

  async function load() {
    const id = ++request;
    try {
      const result = await api(`/api/agent/conversations?${new URLSearchParams({ file })}`);
      if (id !== request) return;
      list = result.conversations || [];
    } catch { return; }
    section.hidden = !list.length;
    section.replaceChildren(h("h3", "", "Conversations"), ...L.runningFirst(list).map(c => rowEl(L.rowOf(c))));
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
      for (const el of section.querySelectorAll(".cv-row")) el.setAttribute("aria-current", String(el.dataset.run === r.run));
      if (window.canvasCmd) window.canvasCmd({ cmd: "askOpen", key: r.key, ids: r.ids, board: r.board, page: r.page });
    };
    row.onclick = open;
    row.onkeydown = (e) => { if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } };
    return row;
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
  return {
    button: btn,
    load,
    setOpen(open) {
      btn?.setAttribute("aria-expanded", String(open));
      if (open) { load(); connect(); }
      else {
        es?.close();
        es = null;
        clearTimeout(timer);
        timer = 0;
      }
    },
    setUnread(unread) {
      dot.hidden = !unread;
      btn?.setAttribute("aria-label", unread ? `Comments, ${unread} unread` : "Comments");
    },
  };
}
