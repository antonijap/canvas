// The page's half of the command palette (apps/macos/Palette.swift, src/search.ts).
// 1. Cmd+K inside a to-do item completes it (src/page/widget-kinds.js), so the shell must not open the palette
//    then: the page tells it, on the "canvasPalette" handler, whenever a to-do item's field gains or loses focus.
// 2. {cmd: "paletteSelect", ids, boards}: a select-matching result or "select all matches" becomes the selection.
//    The page goes to the page those layers are on; the camera moves only when none of them is in view.

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const tell = (m) => { try { window.webkit.messageHandlers.canvasPalette.postMessage(JSON.stringify(m)); } catch {} };
  const todoItem = (el) => !!(el && el.tagName === "INPUT" && el.closest && el.closest(".td-row") && !el.closest(".td-add"));
  let todo = false;
  const sync = () => {
    const now = todoItem(document.activeElement);
    if (now !== todo) { todo = now; tell({ todoFocus: now }); }
  };
  document.addEventListener("focusin", sync, true);
  document.addEventListener("focusout", () => setTimeout(sync, 0), true);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const union = (rs) => {
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
  };
  const inView = (r) => {
    const c = host.cam, ins = host.insets || { l: 0, t: 0, r: 0, b: 0 }, v = host.view;
    if (!c || !r) return false;
    const x0 = (ins.l - c.x) / c.z, y0 = (ins.t - c.y) / c.z, x1 = (v.clientWidth - ins.r - c.x) / c.z, y1 = (v.clientHeight - ins.b - c.y) / c.z;
    return r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0;
  };

  // The newest palette selection wins: an older one still waiting for a page switch or the boards to load stops.
  let gen = 0;
  async function selectMany(ids, boards) {
    if (!Array.isArray(ids) || !ids.length) return;
    if (host.textEdit && host.textEdit.active) return;
    const mine = ++gen;
    boards = boards || {};
    // Their page first: a page switch replaces the boards drawn.
    const first = boards[ids[0]];
    const page = first && !host.boards.has(first) && host.pageOfBoard ? host.pageOfBoard(first) : null;
    if (page && page !== host.page) { await host.setPage(page); if (mine !== gen) return; }
    const visible = ids.some((id) => inView(host.worldRectOf(id)));
    if (!visible) {
      const boxes = [...new Set(ids.map((id) => boards[id]).filter(Boolean))].map((b) => host.boxOf(b)).filter(Boolean);
      if (boxes.length) {
        await host.fitRect(union(boxes), 90, 1);
        if (mine !== gen) return;
        // Boards in view load in a moment: wait for the layers to be measurable so their boxes draw.
        const end = Date.now() + 1500;
        while (Date.now() < end && !ids.every((id) => host.worldRectOf(id))) await sleep(60);
        if (mine !== gen) return;
      }
    }
    host.setSelection(ids);
  }

  host.on("cmd", (c) => {
    if (c && c.cmd === "paletteSelect") selectMany(c.ids, c.boards).catch((e) => console.error(e));
  });
}
