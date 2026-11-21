// Right-click menu data and the commands behind it, plus "show me where this token is used".
// Runs next to widgets.js on window.canvasHost. A right-click on a node selects it, asks the server what it is
// (/api/context), and hands the answer to the native shell, which shows an NSMenu at the cursor (on empty canvas:
// {canvas: true}, the short menu). Its Cut/Copy/Paste/Group/Arrange items are the Edit menu's own. The shell sends
// back commands: reveal (go to a node, switching page and loading its board), usage (highlight everything that
// uses a token, text style or component and report the list), zoomSel, clearUsage, selectLayer, and the instance
// commands resetOverrides (all, or `keys`), swapInstance and pushOverrides (src/overrides.ts).
// Select layer: the menu on a layer carries `under`, every layer under the pointer, topmost (deepest) first,
// with its name and type; picking one sends {cmd: "selectLayer", id}.

import { usageFocus } from "./geometry.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view } = host;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bridge = () => window.canvasBridge;
  const cssVar = (n, fallback) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fallback;
  const getJson = async (path, extra) => {
    const r = await fetch(host.api(path) + (extra || ""), { headers: { "x-canvas": "1" } });
    if (!r.ok) throw new Error(path + " " + r.status);
    return r.json();
  };
  /** POST /api/overrides/<what> for the open file (reset, swap, push); rejects with the server's message. */
  const overrideCall = (what, body) =>
    fetch("/api/overrides/" + what, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file: host.file, ...body }) })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }));

  // ---------- right-click ----------
  view.addEventListener("contextmenu", async (e) => {
    if (!host.native) return; // a plain browser keeps its own menu
    e.preventDefault();
    const x = e.clientX, y = e.clientY;
    const card = e.target && e.target.closest ? e.target.closest(".wd[data-id]") : null;
    const leaf = card ? card.dataset.id : host.pick ? host.pick(x, y) : null;
    // Empty canvas: a short menu (Paste here, Select all, Zoom to fit). The selection stays as it is.
    if (!leaf) { host.post({ context: { x, y, target: null, canvas: true } }); return; }
    if (leaf.startsWith("widget:")) {
      const selected = host.selection ? host.selection() : [];
      if (!selected.includes(leaf)) host.selectId(leaf);
      host.post({ context: { x, y, target: { id: leaf, kind: "card" } } });
      return;
    }
    // A right-click on a selected layer (or inside one) keeps the selection: the menu acts on all of it.
    // Elsewhere it selects what a click there would (the click rule).
    const selected = host.selection ? host.selection() : host.sel ? [host.sel] : [];
    const chain = host.chainOf ? host.chainOf(leaf) : [leaf];
    const inSel = chain.slice().reverse().find((c) => selected.includes(c));
    const id = inSel || (host.pickSelectable ? host.pickSelectable(x, y, false) : leaf) || leaf;
    if (!selected.includes(id)) host.selectId(id);
    const under = layersAt(x, y);
    let target = null;
    try { target = await getJson("/api/context", "&id=" + encodeURIComponent(id)); } catch {}
    if (!target) return;
    const ids = host.selection ? host.selection() : [id];
    const nodes = await Promise.all(ids.filter(i => !i.startsWith("widget:") && !i.includes("/")).map(i =>
      getJson("/api/node", "&id=" + encodeURIComponent(i) + "&depth=0").then(j => j.node).catch(() => null)));
    target.canCreateComponent = nodes.some(n => n && n.type !== "ref" && n.reusable !== true);
    target.locked = nodes.length > 0 && nodes.every(n => n && n.locked);
    target.hidden = nodes.length > 0 && nodes.every(n => n && n.enabled === false);
    host.post({ context: { x, y, target, under } });
  });

  /** Every layer under a window point, topmost first, as the Select layer submenu lists them. */
  function layersAt(x, y) {
    const ids = host.pickAll ? host.pickAll(x, y) : [];
    return ids.filter((id) => !id.startsWith("widget:")).slice(0, 40).map((id) => {
      const info = (host.layerInfo && host.layerInfo(id)) || {};
      const board = host.doc && host.doc.boards ? host.doc.boards.find((b) => b.id === id) : null;
      return { id, name: (board && board.name) || info.name || id, type: info.type || (board ? "frame" : "") };
    });
  }
  host.layersAt = layersAt;

  // ---------- go to a node ----------
  /** Show the page and board a node lives on, fly to it and select it. */
  async function reveal(id, board, o) {
    const b = bridge();
    if (!b) return false;
    const ok = await b.ensureLoaded(id, board ? { [id]: board } : null);
    if (!ok) { host.post({ toast: "That is not drawn on the canvas." }); return false; }
    host.selectId(id);
    const r = host.worldRectOf(id);
    if (r && !(o && o.fit === false)) await host.fitRect(r, 140, 1);
    return true;
  }

  // ---------- usages ----------
  const marks = { ids: [] };
  async function clearUsage() {
    marks.ids = [];
    const b = bridge();
    if (b) await b.op("clear_highlights", {}).catch(() => {});
  }
  async function waitDrawn(ids, ms) {
    const end = Date.now() + ms;
    let last = -1, same = 0;
    for (;;) {
      const n = ids.filter((id) => host.worldRectOf(id)).length;
      same = n === last ? same + 1 : 0;
      last = n;
      if (n === ids.length || Date.now() > end || (n > 0 && same >= 5)) return n;
      await sleep(60);
    }
  }
  /** Highlight what uses a token, style or component, and tell the shell the list. */
  async function showUsage(c) {
    const b = bridge();
    const list = await getJson("/api/usage", "&kind=" + encodeURIComponent(c.kind) + "&key=" + encodeURIComponent(c.key));
    await clearUsage();
    let here = list.items.filter((i) => host.boards.has(i.board));
    // Every usage is on other pages: go to the page of the first one (its board loads there).
    if (b && !here.length && list.items.length) {
      const first = list.items[0];
      await b.ensureLoaded(first.id, { [first.id]: first.board }).catch(() => false);
      here = list.items.filter((i) => host.boards.has(i.board));
    }
    let drawn = 0;
    if (b && here.length) {
      // None of the boards that hold them is on screen (or the menu asked to fly): bring them into view so they
      // load and the highlight is seen. All of them when they fit readably, else the nearest one.
      const boxes = [...new Set(here.map((i) => i.board))].map((bd) => host.boxOf(bd)).filter(Boolean);
      const vw = view.clientWidth, vh = view.clientHeight, ins = host.insets || { l: 0, t: 0, r: 0, b: 0 };
      const to = c.fly ? usageFocus(boxes, { x: 1e9, y: 1e9, z: 1 }, vw, vh, ins) : host.cam ? usageFocus(boxes, host.cam, vw, vh, ins) : null;
      if (to) await host.fitRect(to, 90, 1);
      await waitDrawn(here.map((i) => i.id), 2500);
      const color = c.kind === "component" ? cssVar("--c-component", "#9747FF") : cssVar("--c-sel", "#0766EB");
      if (c.select) {
        // "Select all instances": the instances on this page become the selection.
        host.setSelection(here.map((i) => i.id));
        drawn = here.length;
      } else {
        const res = await b.op("highlight", { ids: here.map((i) => i.id), boards: list.boards, style: "outline", color, durationMs: 60000, reveal: false });
        drawn = res.highlighted.filter((h) => h.found).length;
        marks.ids = here.map((i) => i.id);
      }
    }
    host.post({ usage: { kind: c.kind, key: c.key, total: list.total, items: list.items, onPage: here.length, drawn } });
  }

  host.on("deselect", () => { if (marks.ids.length) clearUsage(); });
  host.on("cmd", (c) => {
    if (c.cmd === "reveal") reveal(c.id, c.board, c);
    else if (c.cmd === "usage") showUsage(c).catch(() => host.post({ usage: null }));
    else if (c.cmd === "clearUsage") clearUsage();
    else if (c.cmd === "selectLayer" && typeof c.id === "string") host.selectId(c.id);
    else if (c.cmd === "resetOverrides") {
      // "Reset all changes" on an instance, or on a layer inside one; `keys`: only those properties (src/overrides.ts).
      const id = c.id || host.sel;
      if (!id || id.startsWith("widget:")) return;
      const keys = Array.isArray(c.keys) && c.keys.length ? c.keys : undefined;
      overrideCall("reset", { id, keys })
        .then((j) => { if (!j.changed) host.post({ toast: "No overrides to reset" }); else if (host.sel === id) host.selectId(id); })
        .catch((err) => host.post({ toast: "Could not reset overrides: " + err.message }));
    }
    else if (c.cmd === "swapInstance") {
      // Instance swap: the selected instances point at another component (src/overrides.ts).
      const ids = (Array.isArray(c.ids) && c.ids.length ? c.ids : host.selection ? host.selection() : [host.sel]).filter((i) => i && !i.startsWith("widget:"));
      if (!ids.length || typeof c.component !== "string") return;
      overrideCall("swap", { ids, component: c.component })
        .then((j) => {
          if (!j.changed) return;
          if (j.dropped && j.dropped.length) host.post({ toast: `Swapped. Not carried over: ${j.dropped.slice(0, 3).join(", ")}${j.dropped.length > 3 ? ` and ${j.dropped.length - 3} more` : ""}` });
          if (ids.length > 1) host.setSelection(ids); else if (host.sel === ids[0]) host.selectId(ids[0]);
        })
        .catch((err) => host.post({ toast: "Could not swap: " + err.message }));
    }
    else if (c.cmd === "pushOverrides") {
      // "Push changes to main component" (src/overrides.ts).
      const id = c.id || host.sel;
      if (!id || id.startsWith("widget:")) return;
      overrideCall("push", { id })
        .then((j) => { if (!j.changed) host.post({ toast: "No changes to push" }); else { host.post({ toast: "Pushed changes to the main component" }); if (host.sel === id) host.selectId(id); } })
        .catch((err) => host.post({ toast: "Could not push changes: " + err.message }));
    }
    else if (c.cmd === "zoomSel") {
      // The whole selection (Zoom to selection, Shift+2), not only the layer right-clicked.
      const rs = (host.selection ? host.selection() : host.sel ? [host.sel] : []).map((id) => host.worldRectOf(id)).filter(Boolean);
      if (!rs.length) return;
      const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
      const r = { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
      host.fitRect(r, 90, 4);
    }
  });
}
