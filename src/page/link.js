// Cmd+L (Edit > Copy Link in Canvas.app): a canvas:// link to the selection, or with nothing selected to the board
// that fills the view (else the page), on the clipboard. Pasted into Claude Code or Codex, it tells the agent the
// file, page and nodes; Canvas MCP takes it as `link`. The format is in /page/link-logic.js.
//
// - Browser: the page owns Cmd+L. Canvas.app: the Edit menu owns the key and sends {cmd: "copyLink"}; the page
//   answers with {clipboard, toast} for the shell to put on the pasteboard and show.
// - {cmd: "openLink", page, ids}: the shell opened a canvas:// URL for this file. Shows the page, selects the nodes
//   and zooms to them (window.canvasBridge's select and fit, the ones agents use).
// - host.lastLink: the last link copied, {text, written}: the QA runner reads it instead of the system clipboard.

import { boardInView, buildLink } from "/page/link-logic.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  const editingText = () => !!(host.textEdit && host.textEdit.active);
  const ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

  /** Browser toast in the page's #msg, with the link icon in the text colour. */
  function say(text, icon) {
    const m = document.getElementById("msg");
    if (!m) { console.warn("[canvas] " + text); return; }
    m.textContent = "";
    if (icon) { const i = document.createElement("span"); i.innerHTML = ICON; i.style.cssText = "display:flex;flex:none"; m.append(i); }
    m.append(document.createTextNode(text));
    Object.assign(m.style, { display: icon ? "flex" : "block", alignItems: "center", gap: "6px" });
    clearTimeout(say.t);
    say.t = setTimeout(() => { m.style.display = "none"; }, 2500);
  }
  const tell = (text, icon) => { if (host.native) host.post({ toast: text, ...(icon ? { toastIcon: icon } : {}) }); else say(text, icon); };

  /** The part of the canvas in view, in world coordinates (minus the panels). */
  function viewWorld() {
    const c = host.cam, v = host.view, ins = host.insets || { l: 0, t: 0, r: 0, b: 0 };
    if (!c || !v) return null;
    const x0 = (ins.l - c.x) / c.z, y0 = (ins.t - c.y) / c.z;
    return { x: x0, y: y0, w: (v.clientWidth - ins.l - ins.r) / c.z, h: (v.clientHeight - ins.t - ins.b) / c.z };
  }

  /** The link for what Cmd+L means now. */
  function currentLink(target) {
    let nodes = target?.node ? [target.node] : host.selection ? host.selection() : host.sel ? [host.sel] : [];
    if (!nodes.length) {
      const rects = [...host.boards.keys()].map((id) => { const r = host.boxOf(id); return r ? { id, x: r.x, y: r.y, w: r.w, h: r.h } : null; }).filter(Boolean);
      const b = boardInView(rects, viewWorld());
      nodes = b ? [b] : [];
    }
    return buildLink({ ...(window.canvasCloudFile ? {cloud:window.canvasCloudFile.key,cloudFile:window.canvasCloudFile.file} : {}), file: host.file, page: target?.page || (host.pageImplicit ? null : host.page), nodes });
  }

  async function write(text) {
    if (host.native) { host.post({ clipboard: text }); return true; }
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch {}
    // An older browser, or one that refuses the async clipboard: the copy command on a hidden field.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }

  async function copyLink(target) {
    const text = currentLink(target);
    if (!text) { tell("This file has no path to link to"); return; }
    host.lastLink = { text, written: false };
    const ok = await write(text);
    host.lastLink = { text, written: ok };
    tell(ok ? "Link copied" : "Could not copy the link", ok ? "link" : null);
    // Usage counts (src/usage-counts.ts): the name only, never the link.
    if (ok && typeof fetch === "function") fetch("/api/usage/count", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ name: "link.copy" }) }).catch(() => {});
  }
  host.copyLink = copyLink;

  /** A canvas:// link opened for this file: its page, then its nodes selected and in view. */
  async function openLink(c) {
    const B = window.canvasBridge;
    const ids = Array.isArray(c.ids) ? c.ids.filter((x) => typeof x === "string" && x) : [];
    if (typeof c.page === "string" && c.page !== host.page && host.pages.some((p) => p.id === c.page)) await host.setPage(c.page);
    if (!ids.length || !B) return;
    // Each layer's board, from the file: it says which page to show and which board to draw.
    const boards = {};
    await Promise.all(ids.filter((id) => !id.startsWith("widget:")).map(async (id) => {
      try {
        const j = await (await fetch(host.api("/api/find") + "&id=" + encodeURIComponent(id))).json();
        const hit = j && Array.isArray(j.results) ? j.results.find((r) => r.id === id) : null;
        if (hit) boards[id] = hit.board || id;
      } catch {}
    }));
    const found = [];
    for (const id of ids) {
      if (!id.startsWith("widget:") && !boards[id]) continue;
      try { if (await B.ensureLoaded(id, boards, true)) found.push(id); } catch {}
    }
    if (!found.length) { tell(ids.length > 1 ? "The linked layers are not in this file anymore" : "The linked layer is not in this file anymore"); return; }
    host.setSelection(found);
    try { await B.op("fit", { ids: found, padding: 90, maxZoomPercent: 200 }); } catch {}
    if (found.length < ids.length) tell(`${ids.length - found.length} of the linked layers are not in this file anymore`);
  }

  host.on("cmd", (c) => {
    if (!c) return;
    if (c.cmd === "copyLink") copyLink(c).catch((e) => console.error(e));
    else if (c.cmd === "openLink") openLink(c).catch((e) => console.error(e));
  });

  // The browser's Cmd+L. In the app the Edit menu has the key (Copy Link) and sends copyLink.
  addEventListener("keydown", (e) => {
    if (host.native || e.defaultPrevented || typing(e.target) || editingText()) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.code !== "KeyL" || e.repeat) return;
    e.preventDefault();
    copyLink().catch((err) => console.error(err));
  });
}
