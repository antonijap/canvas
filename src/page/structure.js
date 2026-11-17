// Structure editing on the page: Delete/Backspace, Cmd+D, Cmd+C/X/V (Shift+Cmd+V pastes in place),
// Cmd+G, Opt+Cmd+G, Shift+Cmd+G, Cmd+[ ] (Opt: to the back / front), Enter / Shift+Enter / Esc to walk the tree,
// Cmd+A, and the marquee: a drag on empty canvas selects boards, a drag from a board's background (or any Cmd-drag
// inside a board) selects that board's layers. Shift adds to the selection.
//
// The server does the work (POST /api/structure, src/structure.ts): one write and one undo step per action. This
// module only works out what is selected and where things go, and applies what it can at once: deleted boards
// leave the canvas before the request returns (host.hideBoards) and come back if it fails. Everything else
// redraws from the document event that follows the write, like any other edit. The engine is only touched
// through the page's host (host.engineView's own API); property edits have their own optimistic layer.
//
// In Canvas.app the Edit menu owns the command keys (Duplicate, Group, Arrange, Cut/Copy/Paste) and sends
// {cmd: "structure" | "copy" | "cut" | "paste" | "selectAll"} through window.canvasCmd; plain keys (Delete, Enter,
// Esc) work here in both. Copy, cut, paste and Cmd+D take cards too (alone or with layers; src/clipcards.ts); group
// and reorder leave them out. The clipboard payload is JSON (see src/structure.ts); the server keeps the last one.
// The app writes it to the pasteboard under Canvas's own type with the names as plain text; a browser tab writes the
// names and a marker in its HTML part. Another app pasting a Canvas copy gets the names, never the JSON.
//
// The pure helpers at the top are node-tested.

import { inverseOf, repeatOffset } from "./shortcuts-logic.js";

export const MARKER = "canvas-clipboard:v1:";
export const BOARD_GAP = 40;
/** How far a layer pasted back into its own frame lands from where it was copied: 0, in place on top. */
export const NUDGE = 0;

/** The physical key: e.code, or one made from e.key when an event leaves code empty (some automation does). */
export function codeOf(e) {
  if (e.code) return e.code;
  const k = String(e.key || "");
  if (/^[a-z]$/i.test(k)) return "Key" + k.toUpperCase();
  return k === "[" || k === "{" ? "BracketLeft" : k === "]" || k === "}" ? "BracketRight" : "";
}

/** What a key press asks for, or null. `menu`: the app's Edit menu owns this key, so the page leaves it there. */
export function keyAction(e) {
  const cmd = e.metaKey || e.ctrlKey;
  const k = codeOf(e);
  if (!cmd && !e.altKey && (e.key === "Backspace" || e.key === "Delete")) return { op: "delete" };
  if (!cmd && !e.altKey && e.key === "Enter") return e.shiftKey ? { op: "parent" } : { op: "children" };
  // A second key for Select parent.
  if (!cmd && !e.altKey && !e.shiftKey && e.key === "\\") return { op: "parent" };
  if (!cmd) return null;
  // Control+G alone is View > Layout Guides (src/page/navigate.js), not Group.
  if (k === "KeyG" && e.ctrlKey && !e.metaKey) return null;
  if (k === "KeyD" && !e.shiftKey && !e.altKey) return { op: "duplicate", menu: true };
  if (k === "KeyG" && !e.shiftKey && !e.altKey) return { op: "group", menu: true };
  if (k === "KeyG" && e.altKey && !e.shiftKey) return { op: "frame", menu: true };
  if (k === "KeyG" && e.shiftKey && !e.altKey) return { op: "ungroup", menu: true };
  if (k === "BracketRight") return { op: "reorder", dir: e.altKey ? "front" : "forward", menu: true };
  if (k === "BracketLeft") return { op: "reorder", dir: e.altKey ? "back" : "backward", menu: true };
  if (k === "KeyA" && !e.shiftKey && !e.altKey) return { op: "selectAll", menu: true };
  // Paste to replace.
  if (k === "KeyR" && e.shiftKey && !e.altKey) return { op: "pasteReplace", menu: true };
  return null;
}

/** Inter Dynamic Metrics at `size` px, in px (src/tracking.ts interTrackingEm), to two decimals. */
const interTracking = (size) => Math.round((-0.0223 + 0.185 * Math.exp(-0.1745 * size)) * size * 100) / 100;
/**
 * Plain text from another app as a new text layer: Inter 14 with its tracking and line height, centred on
 * world point `at` (as far as its size can be told before it draws). Auto width; a line longer than 60 characters
 * wraps at 400 px. Null for text with nothing to show.
 */
export function textLayer(text, at) {
  const content = String(text || "").replace(/\r\n?/g, "\n").slice(0, 20000);
  if (!content.trim()) return null;
  const size = 14, lh = 1.45;
  const lines = content.split("\n");
  const longest = Math.max(...lines.map((l) => l.length));
  const wraps = longest > 60;
  const w = wraps ? 400 : Math.max(8, Math.round(longest * size * 0.5));
  const rows = wraps ? lines.reduce((n, l) => n + Math.max(1, Math.ceil((l.length * size * 0.5) / 400)), 0) : lines.length;
  const h = Math.round(rows * size * lh);
  const first = lines.find((l) => l.trim()) || "Text";
  const name = first.trim().replace(/\s+/g, " ").slice(0, 40);
  return {
    type: "text", name, content, x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2),
    fontFamily: "Inter", fontSize: size, fontWeight: "400", letterSpacing: interTracking(size), lineHeight: lh, fill: "#000000",
    textGrowth: wraps ? "fixed-width" : "auto", ...(wraps ? { width: 400 } : {}),
    metadata: { type: "canvas", canvasLetterSpacing: "auto" },
  };
}

/**
 * Paste into several frames: the selected layers (as pasteNow describes them, with `type`) when there are two
 * or more and every one is a frame the copy is not one of. Null: the usual paste.
 */
export function frameTargets(targets, payload) {
  if (!Array.isArray(targets) || targets.length < 2) return null;
  const copied = new Set(((payload && payload.nodes) || []).map((n) => String(n.id)));
  return targets.every((t) => t && t.isContainer && t.type === "frame" && !copied.has(t.id)) ? targets : null;
}

/** The properties every node shares (same value), for the "N selected" inspector. */
export function sharedProps(nodes) {
  if (!nodes.length) return {};
  const out = {};
  for (const [k, v] of Object.entries(nodes[0])) {
    if (k === "id" || k === "children" || k === "descendants") continue;
    const s = JSON.stringify(v);
    if (nodes.every((n) => JSON.stringify(n[k]) === s)) out[k] = v;
  }
  return out;
}

/** What a clipboard text holds: a payload, the marker of the server's copy, or nothing for Canvas. */
export function readClip(text) {
  if (typeof text !== "string" || !text) return null;
  if (text.startsWith(MARKER)) return { fromServer: true };
  if (text[0] !== "{") return null;
  try {
    const p = JSON.parse(text);
    return p && p.kind === "canvas/nodes" && Array.isArray(p.nodes) ? { payload: p } : null;
  } catch { return null; }
}

/** The plain text a Canvas copy leaves for other apps: the names, one per line (at most 50 lines, 2000 characters). */
export function clipText(names) {
  const lines = (names || []).map((n) => String(n || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const more = lines.length > 50 ? `\n${lines.length - 50} more` : "";
  return (lines.slice(0, 50).join("\n") + more).slice(0, 2000);
}
/** The browser's copy: an HTML part carries Canvas's marker (the server holds the payload), the text part the names. */
export const HTML_MARK = "data-canvas-clipboard";
export function clipHtml(text) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<meta charset="utf-8"><span ${HTML_MARK}="v1"></span>${String(text || "").split("\n").map(esc).join("<br>")}`;
}
/** A paste event's clipboard as readClip takes it: the marker when its HTML is a Canvas copy, else its text. */
export const clipFromEvent = (html, text) => (typeof html === "string" && html.includes(HTML_MARK) ? MARKER : text);

export const intersects =(a, b) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export function unionOf(rs) {
  const list = rs.filter(Boolean);
  if (!list.length) return null;
  const x = Math.min(...list.map((r) => r.x)), y = Math.min(...list.map((r) => r.y));
  return { x, y, w: Math.max(...list.map((r) => r.x + r.w)) - x, h: Math.max(...list.map((r) => r.y + r.h)) - y };
}
/** The world rectangle between two screen points. */
export function marqueeRect(a, b, cam) {
  const x0 = (Math.min(a.x, b.x) - cam.x) / cam.z, y0 = (Math.min(a.y, b.y) - cam.y) / cam.z;
  return { x: x0, y: y0, w: Math.abs(a.x - b.x) / cam.z, h: Math.abs(a.y - b.y) / cam.z };
}

/**
 * Where a paste goes.
 * target: null (nothing selected) or the selected layer: { id, isContainer, placesChildren, parentId (null: a board),
 *   parentPlaces, index, rect, parentRect } (rects in world coordinates).
 * payload: the clipboard payload; inPlace: Shift+Cmd+V; exists(id): the copied layer is still in this document;
 * boards: world rects of the page's boards (to keep pasted boards off them).
 * at: "Paste here", a world point (the right-click): the copied layers' top-left lands on it, inside
 *   `target` when that is the frame or group under the pointer (null: on the canvas).
 * keep: Space held, "keep the parent when adding": a selected frame is not pasted into (the paste goes after it).
 * Returns { parent, index?, positions } for POST /api/structure {op: "paste", place}.
 */
export function pastePlace(args) {
  // keep: Space held ("keep the parent when adding"): a selected frame does not take the paste, it goes beside it.
  if (args.keep && args.target && args.target.isContainer) args = { ...args, target: { ...args.target, isContainer: false } };
  const { payload, inPlace = false, exists = () => false, boards = [], cards = [], at = null } = args;
  const list = Array.isArray(payload.cards) ? payload.cards : [];
  const crs = list.map((c) => ({ x: +c.x || 0, y: +c.y || 0, w: +c.w || 0, h: +c.h || 0 }));
  const { shift: canvasShift, ...nodes } = payload.nodes.length ? layerPlace({ ...args, cardRects: crs }) : { parent: null, index: undefined, positions: [] };
  if (!list.length) return nodes;
  // Cards always go on the canvas (top-level objects). Paste here: at the pointer, kept with the layers.
  if (at) {
    const u = unionOf([...crs, ...(payload.rects || []).filter(Boolean)]);
    return { ...nodes, cards: crs.map((r) => ({ x: Math.round(at.x + r.x - u.x), y: Math.round(at.y + r.y - u.y) })) };
  }
  if (inPlace) return { ...nodes, cards: crs.map((r) => ({ x: r.x, y: r.y })) };
  // Where they were copied when that spot is free, else to the right, clear of boards and cards (with boards pasted
  // onto the canvas: the same shift for both, so they keep their arrangement).
  if (canvasShift !== undefined) return { ...nodes, cards: crs.map((r) => ({ x: r.x + canvasShift, y: r.y })) };
  const shift = clearShift(crs, [...boards, ...cards], list.some((c) => exists("widget:" + c.id)));
  return { ...nodes, cards: crs.map((r) => ({ x: r.x + shift, y: r.y })) };
}

/** How far right a group of rects moves to land on free canvas: 0 when its spot is free and nothing copied is still there. */
function clearShift(rects, obstacles, still) {
  const u = unionOf(rects);
  if (!u) return 0;
  const hit = (dx) => obstacles.some((b) => intersects({ ...u, x: u.x + dx }, b));
  if (!still && !hit(0)) return 0;
  let shift = u.w + BOARD_GAP;
  for (let i = 0; i < 50 && hit(shift); i++) shift += u.w + BOARD_GAP;
  return shift;
}

function layerPlace({ target, payload, inPlace = false, exists = () => false, boards = [], cards = [], at = null, rectOf = () => null, cardRects = [] }) {
  const copied = payload.nodes.map((n) => String(n.id));
  if (inPlace && target && target.isContainer && target.rect && !copied.includes(target.id)) {
    // Paste in place keeps where the layers were on the canvas: a selected frame somewhere else does not take them
    // (they would land outside it, invisible when it clips). They go back into their old parent, else onto the canvas.
    const src = payload.nodes.map((n, i) => (payload.rects || [])[i] || null);
    const u = unionOf(src);
    if (u && !intersects(u, target.rect)) {
      const ps = payload.parents || [], p0 = ps[0];
      const pr = p0 && payload.nodes.every((n, i) => ps[i] === p0) && exists(p0) ? rectOf(p0) : null;
      const ox = pr ? pr.x : 0, oy = pr ? pr.y : 0;
      return { parent: pr ? p0 : null, index: undefined, positions: src.map((r) => (r ? { x: r.x - ox, y: r.y - oy } : null)) };
    }
  }
  if (at) {
    const into = target && target.isContainer && !copied.includes(target.id) ? target : null;
    const parent = into ? into.id : null;
    const rects = payload.rects || [];
    const src = payload.nodes.map((n, i) => rects[i] || null);
    // Auto layout places the children itself (appended at the end).
    if (into && into.placesChildren) return { parent, index: undefined, positions: src.map(() => null) };
    const u = unionOf([...src, ...cardRects]);
    const ox = into && into.rect ? into.rect.x : 0, oy = into && into.rect ? into.rect.y : 0;
    const positions = src.map((r) => (r && u ? { x: Math.round(at.x + (r.x - u.x) - ox), y: Math.round(at.y + (r.y - u.y) - oy) } : null));
    return { parent, index: undefined, positions };
  }
  let parent = null, index, parentRect = null, places = false;
  if (target && target.isContainer && !copied.includes(target.id)) {
    parent = target.id; parentRect = target.rect; places = !!target.placesChildren;
  } else if (target) {
    parent = target.parentId ?? null; index = target.index + 1; parentRect = target.parentRect || null; places = !!target.parentPlaces;
  }
  const rects = payload.rects || [];
  const src = payload.nodes.map((n, i) => rects[i] || null);
  if (places) return { parent, index, positions: src.map(() => null) };
  const still = payload.nodes.some((n) => exists(String(n.id)));
  const ox = parentRect ? parentRect.x : 0, oy = parentRect ? parentRect.y : 0;
  let shift = 0;
  const onCanvas = parent === null && !inPlace;
  // Boards (or anything pasted on the canvas, cards with them) land where they were copied when that spot is free,
  // else to the right of it, clear of other boards and cards.
  if (onCanvas) shift = clearShift([...src.filter(Boolean), ...cardRects], [...boards, ...cards], still || (payload.cards || []).some((c) => exists("widget:" + c.id)));
  // Boards copied off the canvas, pasted into a selected frame: inside it, centred as a group (at its
  // top-left when larger), not at their canvas coordinates, which put them far outside the frame.
  const parents = payload.parents || [];
  const boardsIn = !inPlace && parent !== null && parentRect && payload.nodes.length > 0 && payload.nodes.every((n, i) => parents[i] === null);
  const bu = boardsIn ? unionOf(src) : null;
  const positions = payload.nodes.map((n, i) => {
    const r = src[i];
    if (bu && r) return { x: Math.round(r.x - bu.x + Math.max(0, (parentRect.w - bu.w) / 2)), y: Math.round(r.y - bu.y + Math.max(0, (parentRect.h - bu.h) / 2)) };
    if (inPlace || parent === null) return r ? { x: r.x - ox + shift, y: r.y - oy } : null;
    // Into a frame: back into the same parent shifts like a duplicate; elsewhere it keeps its own x/y.
    const sameParent = (payload.parents || [])[i] === parent;
    if (sameParent && still && typeof n.x === "number" && typeof n.y === "number") return { x: n.x + NUDGE, y: n.y + NUDGE };
    return null;
  });
  // In another frame the layers keep their x/y, centred (as a group) on an axis where they do not fit.
  if (!inPlace && parent !== null && parentRect && !bu) {
    const moved = payload.nodes.map((n, i) => (positions[i] === null && src[i] && typeof n.x === "number" && typeof n.y === "number" ? { x: n.x, y: n.y, w: src[i].w, h: src[i].h } : null));
    const u = unionOf(moved);
    if (u) {
      const fits = (a, len, room) => a >= 0 && a + len <= room;
      const dx = fits(u.x, u.w, parentRect.w) ? 0 : Math.round((parentRect.w - u.w) / 2 - u.x);
      const dy = fits(u.y, u.h, parentRect.h) ? 0 : Math.round((parentRect.h - u.h) / 2 - u.y);
      if (dx || dy) moved.forEach((m, i) => { if (m) positions[i] = { x: m.x + dx, y: m.y + dy }; });
    }
  }
  return onCanvas ? { parent, index, positions, shift } : { parent, index, positions };
}

// ---------------------------------------------------------------- the page

const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || !!(t.closest && t.closest("[contenteditable]")));
const isW = (id) => typeof id === "string" && id.startsWith("widget:");

export function attach(host) {
  const { view } = host;
  const file = host.file;
  if (!file || host.structure) return;
  host.sharedProps = sharedProps;

  const msgEl = document.getElementById("msg");
  let msgT = 0;
  const tell = (t) => {
    if (host.native) { host.post({ toast: t }); return; }
    if (!msgEl) return;
    msgEl.textContent = t; msgEl.style.display = "block";
    clearTimeout(msgT); msgT = setTimeout(() => { msgEl.style.display = "none"; }, 4000);
  };
  const call = (body) => fetch("/api/structure", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, page: host.page || undefined, ...body }) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { code: j.code }); return j; }));
  const nodeInfo = (id, depth = 1) => fetch(host.api("/api/node") + "&id=" + encodeURIComponent(id) + "&depth=" + depth).then((r) => r.json()).then((j) => (j && !j.error ? j : null)).catch(() => null);
  const ids = () => (host.selection ? host.selection() : []);
  const primary = () => host.sel;
  // One card selected on its own: widgets.js owns its keys. Cards inside a multi-selection go along with it.
  const lone = () => isW(primary()) && ids().length < 2;
  const plain = (list) => list.filter((id) => !isW(id));
  const placesChildren = (n) => !!n && n.type === "frame" && (typeof n.layout === "string" ? n.layout : "horizontal") !== "none";

  // What is known about the selected layer (parent, children), fetched when it is selected: Esc must answer at once.
  let known = null;
  host.on("select", (id) => {
    if (!id || isW(id)) { known = null; return; }
    known = { id, info: null };
    const k = known;
    nodeInfo(id, 1).then((info) => { if (known === k) k.info = info; });
  });
  host.on("deselect", () => { known = null; });

  /** World rects for the ids, their parents and (for ungroup) their children: where layers in auto layout sit. */
  async function rectsFor(all, withKids) {
    const out = {};
    // Cards: where each shows (a video pinned over a node shows there).
    for (const id of all.filter(isW)) { const r = host.widgetRect ? host.widgetRect(id) : null; if (r) out[id] = { x: r.x, y: r.y, w: r.w, h: r.h }; }
    const list = plain(all);
    const add = (id) => { if (id && id !== "document" && !out[id]) { const r = host.worldRectOf(id); if (r) out[id] = r; } };
    const infos = await Promise.all(list.map((id) => nodeInfo(id, withKids ? 1 : 0)));
    list.forEach((id, i) => {
      add(id);
      const inf = infos[i];
      if (inf) { add(inf.parentId); if (withKids && Array.isArray(inf.node.children)) for (const c of inf.node.children) add(c.id); }
    });
    return out;
  }
  const boardIds = (list) => list.filter((id) => host.boards.has(id));
  const afterSelect = (sel) => { if (sel && sel.length) host.setSelection(sel); else host.clearSel(); };
  // An answer that comes back after the selection changed (a click, another page) must not select anything: the
  // layers it names may be on a page no longer shown, where Delete would then reach hidden layers.
  const stamp = () => { const g = host.selGen, p = host.page; return { same: () => host.selGen === g && host.page === p, page: () => host.page === p }; };

  // Cards (widgets, videos, shaders) do not group or reorder: say so instead of leaving them out silently.
  const leftOut = (list, what) => {
    const n = list.filter(isW).length;
    if (n && plain(list).length) tell(n === 1 ? `The card was left out: ${what} works on layers and boards` : `${n} cards were left out: ${what} works on layers and boards`);
  };
  // Ops a card takes part in, alone or with layers: copy, cut, paste and duplicate travel with it (src/clipcards.ts).
  const CARD_OPS = new Set(["cut", "duplicate", "paste", "selectAll"]);
  const groupKey = (what) => "group:" + what + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rectAny = (id) => (isW(id) ? (host.widgetRect ? host.widgetRect(id) : null) : host.worldRectOf(id));
  /** World rects of everything top-level on the page: boards and cards (what a pasted or duplicated card keeps clear of). */
  const pageRects = () => ({
    boards: [...host.boards.keys()].map((id) => host.boxOf(id)).filter(Boolean),
    cards: (host.widgetsShown ? host.widgetsShown() : []).map((w) => (host.widgetRect ? host.widgetRect("widget:" + w.id) : null)).filter(Boolean),
  });
  async function run(op, arg = {}) {
    if (host.textEdit && host.textEdit.active) return; // text being edited in place (/page/text-edit.js) owns the keys
    if ((op === "duplicate" || op === "delete") && host.smart && host.smart.intercept(op)) return; // marked layers of a smart selection (/page/smart.js)
    const list = ids();
    if (!list.length && op !== "paste" && op !== "selectAll") return;
    if (lone() && !CARD_OPS.has(op)) return; // widgets have their own keys (/page/widgets.js)
    // Cards in a multi-selection: Delete removes them too; the structure ops act on the layers and boards.
    const cards = list.filter(isW);
    if (cards.length && op !== "delete" && op !== "parent" && !CARD_OPS.has(op) && !plain(list).length) return;
    const st = stamp();
    if (op === "group" || op === "frame" || op === "ungroup") leftOut(list, { group: "Group", frame: "Frame", ungroup: "Ungroup" }[op]);
    try {
      if (op === "delete" || op === "cut") {
        if (op === "cut") await copy(list, true);
        else {
          // After a delete nothing is selected (not the parent, not a neighbour).
          const gone = boardIds(list);
          host.hideBoards(gone);
          host.clearSel();
          const after = stamp();
          // Cards and layers deleted together are one undo step: their writes share a merge key (src/history.ts).
          const merge = cards.length && plain(list).length ? "group:delete-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : undefined;
          if (cards.length && host.widgetGroup) host.widgetGroup.remove(cards, merge);
          if (!plain(list).length) return;
          const names = gone.map((id) => { const b = host.boards.get(id); return (b && b.meta && b.meta.name) || id; });
          try {
            await call({ op: "delete", ids: plain(list), ...(merge ? { merge } : {}) });
          } catch (err) { host.restoreBoards(gone); if (after.same()) host.setSelection(list); throw err; }
          // A whole board gone says so, with Undo (a layer inside a board disappears in plain sight: no toast).
          if (gone.length && host.toast) host.toast(gone.length === 1 ? `Deleted ${names[0]}` : `Deleted ${gone.length} boards`, { actions: [{ label: "Undo", run: () => host.undoIf("Delete") }] });
        }
      } else if (op === "duplicate") {
        // Smart duplicate: Cmd+D on copies that were moved since (or Option-dragged) repeats that step.
        const src = plain(list);
        let offset = repeatOffset(host.lastDuplicate, list, rectAny);
        // Cards go to the right of the selection on free canvas, like boards; boards selected with them move by the
        // same step, so the copies keep their arrangement.
        const onlyBoards = src.every((id) => host.boards.has(id));
        if (!offset && cards.length) {
          const mine = [...cards, ...(onlyBoards ? src : [])].map(rectAny).filter(Boolean);
          const { boards, cards: others } = pageRects();
          offset = { dx: clearShift(mine, [...boards, ...others], true), dy: 0 };
        }
        const merge = cards.length && (src.length || cards.length > 1) ? groupKey("dup") : undefined;
        const round = !host.snap || host.snap().pixel;
        const [r, made] = await Promise.all([
          src.length ? call({ op, ids: src, rects: await rectsFor(src, false), ...(offset && (onlyBoards || !cards.length) ? { offset, round } : {}), ...(merge ? { merge } : {}) }) : Promise.resolve({ select: [] }),
          cards.length && host.widgetGroup ? host.widgetGroup.duplicate(cards, offset.dx, offset.dy, merge) : Promise.resolve([]),
        ]);
        const copies = [...(Array.isArray(r.select) ? r.select : []), ...made];
        // The copies in the order of the originals (repeatOffset pairs them up).
        host.lastDuplicate = { src: [...src, ...cards], copies };
        if (st.same()) afterSelect(copies);
      } else if (op === "group" || op === "frame" || op === "ungroup") {
        const r = await call({ op, ids: plain(list), rects: await rectsFor(plain(list), op === "ungroup") });
        if (st.same()) afterSelect(r.select);
      } else if (op === "reorder") {
        await call({ op, ids: plain(list), dir: arg.dir });
      } else if (op === "pasteReplace") {
        // A browser tab cannot read the system clipboard on a key: the server's slot holds Canvas's last copy.
        await paste(MARKER, false, null, { replace: true });
      } else if (op === "selectAll") {
        selectAll();
      } else if (op === "children") {
        const inf = known && known.id === primary() && known.info ? known.info : await nodeInfo(primary(), 1);
        // Locked children (their own lock or the parent's) stay out, as in every other selection path (the
        // canvas never selects them).
        const kids = inf && Array.isArray(inf.node.children) ? inf.node.children.filter((c) => c && c.locked !== true).map((c) => c.id).filter((id) => id && !(host.isLocked && host.isLocked(String(id)))) : [];
        if (kids.length && st.same()) host.setSelection(kids);
      } else if (op === "parent") {
        selectParent(true);
      }
    } catch (err) {
      if (err.code !== "no_change") tell(err.message);
    }
  }

  // ---------- clipboard ----------
  let lastPayload = null;
  // Copy, cut and paste run one after another: a paste pressed while a cut is still asking the server would
  // otherwise paste the clipboard from before the cut (and the cut's payload land after it).
  let clipQ = Promise.resolve();
  const inClip = (f) => { const p = clipQ.then(f, f); clipQ = p.catch(() => {}); return p; };
  function copy(list, cut) {
    const gone = cut ? boardIds(list) : [];
    if (cut) { host.hideBoards(gone); host.clearSel(); }
    const st = stamp();
    const names = clipNames(list); // now: a cut takes the cards and boards off the page
    return inClip(() => copyNow(list, cut, gone, st, names));
  }
  async function copyNow(list, cut, gone, st, names) {
    let r;
    try {
      r = await call({ op: cut ? "cut" : "copy", ids: list, rects: await rectsFor(list, false) });
    } catch (err) { if (cut) { host.restoreBoards(gone); if (st.same()) host.setSelection(list); } throw err; }
    lastPayload = r.payload;
    // The app writes the pasteboard: the payload under Canvas's own type, the names as plain text (what another app
    // pastes). A browser tab's clipboard holds the names and a marker (the copy event); the server keeps the payload.
    if (host.native) host.post({ clipboard: JSON.stringify(r.payload), clipText: names });
    return r.payload; // a cut, like a delete, leaves nothing selected
  }
  /** What another app gets from a Canvas copy: the names of what was copied, one per line. */
  function clipNames(list) {
    const shown = host.widgetsShown ? host.widgetsShown() : [];
    const seek = (n, id) => { if (!n || typeof n !== "object") return null; if (String(n.id) === id) return n; for (const c of Array.isArray(n.children) ? n.children : []) { const h = seek(c, id); if (h) return h; } return null; };
    return clipText(list.slice(0, 200).map((id) => {
      if (isW(id)) { const w = shown.find((x) => "widget:" + x.id === id); return w ? w.name || w.kind : ""; }
      const b = boardOfId(id), n = b ? seek(rootOf(b), id) : null;
      return n ? n.name || (n.type === "text" && typeof n.content === "string" ? n.content : n.type) : "";
    }));
  }
  /** The "Paste here" target: the frame or group under a view point (the node itself, else its parent), or null. */
  async function containerAt(x, y) {
    const hit = host.pick ? host.pick(x, y) : null;
    if (!hit || isW(hit) || hit.includes("/")) return null;
    let inf = await nodeInfo(hit, 0);
    const isBox = (n) => !!n && (n.type === "frame" || n.type === "group");
    if (inf && !isBox(inf.node)) inf = inf.parentId && inf.parentId !== "document" ? await nodeInfo(inf.parentId, 0) : null;
    if (!inf || !isBox(inf.node)) return null;
    return { id: inf.node.id, isContainer: true, placesChildren: placesChildren(inf.node), rect: host.worldRectOf(inf.node.id) };
  }
  /** paste(text, inPlace, at, how): how.replace is Paste to replace (Shift+Cmd+R). Space held when it was asked:
   *  "keep the parent when adding", the paste does not go into a frame. */
  function paste(text, inPlace, at, how = {}) {
    const p = primary(), st = stamp(), list = ids(), keep = !!host.hand;
    return inClip(() => pasteNow(text, inPlace, at, p, st, { ...how, list, keep }));
  }
  /** What pastePlace needs to know about a selected layer, or null. */
  async function targetOf(id) {
    if (!id || isW(id) || id.includes("/")) return null;
    const inf = await nodeInfo(id, 0);
    if (!inf) return null;
    const parentId = inf.parentId && inf.parentId !== "document" ? inf.parentId : null;
    const parent = parentId ? await nodeInfo(parentId, 0) : null;
    return {
      id, type: inf.node.type, instance: inf.node.type === "ref",
      isContainer: inf.node.type === "frame" || inf.node.type === "group", placesChildren: placesChildren(inf.node),
      parentId, parentPlaces: placesChildren(parent && parent.node), index: inf.index,
      rect: host.worldRectOf(id), parentRect: parentId ? host.worldRectOf(parentId) : null,
    };
  }
  /** Plain text from another app: a text layer in the selected frame (Space: not in it), else in the middle of the view. */
  async function pasteText(text, p, st, keep, at) {
    const c = host.cam;
    if (!c) return;
    // Paste here (right-click): at the pointer, on the canvas. Otherwise into the selected frame.
    const t = p && !keep && !at ? await targetOf(p) : null;
    const frame = t && t.type === "frame" && t.rect ? t : null;
    const vb = host.viewBox || { l: 0, t: 0 };
    const mid = frame ? { x: frame.rect.x + frame.rect.w / 2, y: frame.rect.y + frame.rect.h / 2 }
      : at ? { x: (at.x - vb.l - c.x) / c.z, y: (at.y - vb.t - c.y) / c.z } : { x: (view.clientWidth / 2 - c.x) / c.z, y: (view.clientHeight / 2 - c.y) / c.z };
    const node = textLayer(text, mid);
    if (!node) { tell("Nothing to paste: the clipboard holds no text"); return; }
    if (frame && frame.placesChildren) { delete node.x; delete node.y; }
    else if (frame) { node.x = Math.max(0, node.x - Math.round(frame.rect.x)); node.y = Math.max(0, node.y - Math.round(frame.rect.y)); }
    try {
      const r = await call({ op: "add", nodes: [node], place: { parent: frame ? frame.id : null } });
      if (st.page()) afterSelect(r.select);
    } catch (err) { tell(err.message); }
  }
  async function pasteNow(text, inPlace, at, p, st, how) {
    const clip = readClip(text) || (text === undefined && lastPayload ? { payload: lastPayload } : null);
    // Text from another app (Canvas's own copy wins: its JSON or marker reads as a payload above).
    if (!clip && !how.replace && typeof text === "string" && text.trim()) return pasteText(text, p, st, how.keep, at);
    if (!clip) { tell(how.replace ? "Nothing to paste: copy some layers first" : "Nothing to paste: copy some layers or cards first"); return; }
    let payload = clip.payload;
    if (clip.fromServer) payload = (await fetch("/api/structure/clipboard").then((r) => r.json()).catch(() => ({}))).payload;
    if (!payload) { tell("Nothing to paste: copy some layers or cards first"); return; }
    const from = clip.fromServer ? { fromServer: true } : { payload };
    if (how.replace) {
      // Paste to replace: the selected layers give way to the clipboard's, at their spots (cards are left as they are).
      const replace = plain(how.list);
      if (!replace.length) { tell("Select the layers to replace, then paste"); return; }
      if (!(payload.nodes || []).length) { tell("Paste to replace takes layers: the clipboard holds only cards"); return; }
      if (replace.length < how.list.length) tell("Cards were left as they are: Paste to replace swaps layers");
      try {
        const r = await call({ op: "paste", ...from, replace, selBefore: how.list });
        if (st.page()) afterSelect(r.select);
        if (r.notice) tell(r.notice);
      } catch (err) { tell(err.message); }
      return;
    }
    let target = null;
    let places = null;
    // "Paste here" (the right-click menu): at the pointer, into the frame under it (Space held: onto the canvas).
    let world = null;
    if (at && host.cam) {
      const vb = host.viewBox || { l: 0, t: 0 };
      world = { x: (at.x - vb.l - host.cam.x) / host.cam.z, y: (at.y - vb.t - host.cam.y) / host.cam.z };
      target = how.keep ? null : await containerAt(at.x, at.y);
    } else if (!inPlace && !how.keep && plain(how.list).length > 1) {
      // Several frames selected: one copy into each.
      const ts = await Promise.all(plain(how.list).map(targetOf));
      places = ts.every((x) => x && !x.instance) ? frameTargets(ts, payload) : null;
      if (!places) target = await targetOf(p);
    } else target = await targetOf(p);
    const { boards, cards } = pageRects();
    const shownCard = (id) => (host.widgetsShown ? host.widgetsShown() : []).some((w) => "widget:" + w.id === id);
    const placeFor = (t) => pastePlace({ target: t, payload, inPlace, keep: how.keep, exists: (id) => (isW(id) ? shownCard(id) : host.boards.has(id) || !!host.worldRectOf(id)), boards, cards, at: world, rectOf: (id) => host.worldRectOf(id) });
    const many = places ? places.map(placeFor) : null;
    const place = many ? many[0] : placeFor(target);
    try {
      const r = await call({ op: "paste", ...from, place, ...(many ? { places: many } : {}), selBefore: how.list });
      // The new cards show at once (their widgets event may come after the answer), then everything is selected.
      if (Array.isArray(r.widgets) && r.widgets.length && host.widgetGroup && host.widgetGroup.adopt) host.widgetGroup.adopt(r.widgets);
      if (st.page()) afterSelect(r.select);
      // A payload from another app: its layers came without the files it named (src/structure.ts screenPayload).
      if (r.notice) tell(r.notice);
    } catch (err) { tell(err.message); }
  }
  // Browser: the system clipboard events (Cmd+C/X/V and the browser's Edit menu). Text fields keep their own.
  // A key press whose clipboard event never comes (automation, a browser that skips it) runs the same action
  // after a moment, pasting from the server's slot.
  let inPlaceAt = 0, pendingClip = null;
  const clipKey = (e) => {
    if (host.native || typing(e.target) || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    const c = codeOf(e);
    const op = c === "KeyC" ? "copy" : c === "KeyX" ? "cut" : c === "KeyV" ? "paste" : null;
    // With Shift only V is a clipboard key (paste in place): Shift+Cmd+X strikes text through (shortcuts.js) and
    // Shift+Cmd+C copies as PNG (copy-as.js).
    if (!op || (op !== "paste" && (e.shiftKey || !ids().length))) return;
    const p = (pendingClip = { op, inPlace: e.shiftKey });
    setTimeout(() => {
      if (pendingClip !== p) return;
      pendingClip = null;
      if (op === "paste") paste(MARKER, p.inPlace);
      else if (op === "copy") copy(ids(), false).catch((err) => tell(err.message));
      else run("cut");
    }, 120);
  };
  addEventListener("keydown", clipKey);
  for (const n of ["copy", "cut", "paste"]) document.addEventListener(n, () => { pendingClip = null; }, true);
  // Another app pastes the names (text/plain); Canvas reads its marker from the HTML part and the payload from the server.
  const mark = (e) => { const t = clipNames(ids()); e.clipboardData.setData("text/plain", t); e.clipboardData.setData("text/html", clipHtml(t)); };
  document.addEventListener("copy", (e) => {
    if (typing(document.activeElement) || !ids().length) return;
    e.preventDefault();
    mark(e);
    copy(ids(), false).catch((err) => tell(err.message));
  });
  document.addEventListener("cut", (e) => {
    if (typing(document.activeElement) || !ids().length) return;
    e.preventDefault();
    mark(e);
    run("cut");
  });
  document.addEventListener("paste", (e) => {
    if (typing(document.activeElement)) return;
    e.preventDefault();
    const inPlace = performance.now() - inPlaceAt < 500;
    inPlaceAt = 0;
    paste(e.clipboardData ? clipFromEvent(e.clipboardData.getData("text/html"), e.clipboardData.getData("text/plain")) : undefined, inPlace);
  });

  // ---------- selection walking ----------
  function selectParent(always) {
    const p = primary();
    if (!p || isW(p)) return false;
    const inf = known && known.id === p ? known.info : null;
    if (!inf) {
      const st = stamp();
      if (always) nodeInfo(p, 0).then((i) => { if (i && i.parentId && i.parentId !== "document" && st.same()) host.selectId(i.parentId); });
      return !!always;
    }
    if (!inf.parentId || inf.parentId === "document") return false; // a board: Esc deselects
    host.selectId(inf.parentId);
    return true;
  }
  host.selectParent = () => selectParent(false);
  async function selectAll() {
    const p = primary();
    if (p && !isW(p) && !host.boards.has(p)) {
      const st = stamp();
      const inf = await nodeInfo(p, 0);
      if (inf && inf.parentId && inf.parentId !== "document") {
        const par = await nodeInfo(inf.parentId, 1);
        if (!st.same()) return;
        if (par && Array.isArray(par.node.children)) { host.setSelection(par.node.children.filter((c) => c && c.locked !== true).map((c) => c.id)); return; }
      }
      if (!st.same()) return;
    }
    host.setSelection(topLevel().map((it) => it.id));
  }
  /** Select inverse (Shift+Cmd+A): what Select All takes in the selection's scope, minus the selection. */
  async function selectInverse() {
    const cur = ids(), p = primary();
    const st = stamp();
    let scope = null;
    if (p && !isW(p) && !host.boards.has(p)) {
      const inf = await nodeInfo(p, 0);
      if (inf && inf.parentId && inf.parentId !== "document") {
        const par = await nodeInfo(inf.parentId, 1);
        if (par && Array.isArray(par.node.children)) scope = par.node.children.filter((c) => c && c.locked !== true && c.enabled !== false).map((c) => String(c.id));
      }
    }
    if (!st.same()) return;
    if (!scope) scope = topLevel().map((it) => it.id);
    afterSelect(inverseOf(scope, cur));
  }
  host.selectInverse = selectInverse;
  // The page's top-level objects: its boards and its cards (widgets, videos, shaders).
  const topLevel = () => [...host.boards.keys()].filter(unlocked).map((id) => ({ id, r: host.boxOf(id) }))
    .concat((host.widgetsShown ? host.widgetsShown() : []).map((w) => ({ id: "widget:" + w.id, r: host.widgetRect ? host.widgetRect("widget:" + w.id) : w })));

  // ---------- keys ----------
  addEventListener("keydown", (e) => {
    if (typing(e.target)) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && codeOf(e) === "KeyV") inPlaceAt = performance.now();
    const a = keyAction(e);
    if (!a) return;
    if (a.menu && host.native) return; // the Edit menu sends these (one dispatcher, one step per press)
    if (lone() && !CARD_OPS.has(a.op)) return; // a card alone: Cmd+D and Cmd+A here, the rest is widgets.js's
    if (a.op !== "selectAll" && !ids().length) return;
    e.preventDefault();
    run(a.op, a);
  });
  // The app's Edit menu.
  host.on("cmd", (c) => {
    if (host.textEdit && host.textEdit.active && (c.cmd === "structure" || c.cmd === "selectAll" || c.cmd === "copy" || c.cmd === "cut" || c.cmd === "paste")) return;
    if (c.cmd === "structure") run(c.op, c);
    else if (c.cmd === "selectAll") { if (c.web && typing(document.activeElement)) document.execCommand("selectAll"); else run("selectAll"); }
    else if (c.cmd === "copy" || c.cmd === "cut" || c.cmd === "paste") {
      if (c.web && typing(document.activeElement)) { document.execCommand(c.cmd); return; }
      if (c.cmd === "paste") paste(c.text, !!c.inPlace, c.at && typeof c.at.x === "number" ? c.at : null, { replace: !!c.replace });
      else if (ids().length) (c.cmd === "copy" ? copy(ids(), false) : run("cut")).catch((err) => tell(err.message));
    }
  });

  // ---------- marquee ----------
  const box = document.getElementById("marquee");
  let mq = null;
  host.marqueeActive = () => !!mq;
  const boardOfId = (id) => (host.boards.has(id) ? id : host.engineView ? host.engineView.boardOf(id) : null);
  /** A board's scene root as the canvas draws it (live edits on top), or null. */
  const rootOf = (b) => { const s = host.live && host.live.sceneOf ? host.live.sceneOf(b) : null; return s ? s.root : null; };
  const shown = (n) => n && typeof n === "object" && n.visible !== false && n.enabled !== false;
  // Locked layers (and everything inside them) stay out of the marquee and Select All.
  const free = (n) => shown(n) && n.locked !== true;
  const unlocked = (id) => !(host.isLocked && host.isLocked(id));
  const frameBoard = (b) => { const r = rootOf(b); return !!r && r.type === "frame" && typeof r.component !== "string"; };
  /** A board's direct children with their world rects. */
  const kidsOf = (b) => { const r = rootOf(b); return (r && Array.isArray(r.children) ? r.children : []).filter(free).map((c) => ({ id: String(c.id), r: host.worldRectOf(String(c.id)) })).filter((k) => k.r); };
  /** The deepest layers of a board (a component instance counts as one: its insides are the component's). */
  const leavesOf = (b) => {
    const out = [];
    const visit = (n) => {
      if (!free(n)) return;
      const kids = Array.isArray(n.children) ? n.children.filter(free) : [];
      const inst = typeof n.component === "string" || String(n.id).includes("/");
      if (inst || !kids.length) { const r = host.worldRectOf(String(n.id)); if (r) out.push({ id: String(n.id), r }); return; }
      for (const c of kids) visit(c);
    };
    const r = rootOf(b);
    if (r) visit(r);
    return out;
  };
  const encloses = (o, i) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
  // Command for a press: its own flag, or the state the page and the shell track (src/server.ts cmdHeld).
  const meta = (e) => !!(e.metaKey || (host.cmdHeld && host.cmdHeld()));
  host.beginMarquee = (e) => {
    if (e.button !== 0 || host.hand || !host.cam) return false;
    const hit = host.pick(e.clientX, e.clientY);
    let scope = null;
    if (!hit) scope = "boards";
    else if (isW(hit)) return false;
    else {
      const b = boardOfId(hit);
      if ((meta(e) || e.ctrlKey) && b) scope = b;
      else if (host.boards.has(hit) && !ids().includes(hit)) scope = hit; // a board's background, not selected yet
      else return false;
    }
    const vb = host.viewBox || { l: 0, t: 0 };
    mq = { a: { x: e.clientX - vb.l, y: e.clientY - vb.t }, scope, base: e.shiftKey ? ids() : [], items: null, moved: false, key: "" };
    // On empty canvas the marquee takes boards and widget cards, the top-level objects: a board only when the
    // box encloses it whole; one it only touches gives the layers inside it that the box touches. Cmd: the
    // deepest layers the box touches (a deep marquee), from empty canvas or inside a board.
    const deep = meta(e) || e.ctrlKey;
    if (scope === "boards") { mq.items = deep ? () => [...host.boards.keys()].flatMap((b) => leavesOf(b)) : topLevel; mq.frames = !deep; }
    else if (deep) mq.items = () => leavesOf(scope);
    else {
      const m = mq;
      nodeInfo(scope, 1).then((inf) => {
        const kids = inf && Array.isArray(inf.node.children) ? inf.node.children.filter((c) => c && c.locked !== true).map((c) => c.id).filter(Boolean) : [];
        m.items = () => kids.map((id) => ({ id, r: host.worldRectOf(id) }));
      });
    }
    try { view.setPointerCapture(e.pointerId); } catch {}
    return true;
  };
  view.addEventListener("pointermove", (e) => {
    if (!mq) return;
    const vb = host.viewBox || { l: 0, t: 0 };
    const b = { x: e.clientX - vb.l, y: e.clientY - vb.t };
    if (!mq.moved && Math.hypot(b.x - mq.a.x, b.y - mq.a.y) < 4) return;
    mq.moved = true;
    box.style.display = "block";
    box.style.left = Math.min(mq.a.x, b.x) + "px"; box.style.top = Math.min(mq.a.y, b.y) + "px";
    box.style.width = Math.abs(b.x - mq.a.x) + "px"; box.style.height = Math.abs(b.y - mq.a.y) + "px";
    if (!mq.items) return;
    const next = boxHits(marqueeRect(mq.a, b, host.cam), mq.items(), mq.frames, mq.base);
    const key = next.join(",");
    if (key !== mq.key) { mq.key = key; if (next.length) host.setSelection(next); else host.clearSel(); }
  });
  /** What a box (world rect) selects among items ({id, r}), after `base`: a board it only touches gives the layers it touches (frames). */
  function boxHits(r, items, frames, base) {
    const hits = [];
    for (const it of items) {
      if (!intersects(it.r, r)) continue;
      if (frames && host.boards.has(it.id) && frameBoard(it.id) && !encloses(r, it.r)) hits.push(...kidsOf(it.id).filter((k) => intersects(k.r, r)).map((k) => k.id));
      else hits.push(it.id);
    }
    return [...base, ...hits.filter((id) => !base.includes(id))];
  }
  /** A selection box drawn another way (the keyboard's, /page/keybox.js): what a marquee from empty canvas would take. */
  host.boxSelect = (r, base = []) => {
    const next = boxHits(r, topLevel(), true, base);
    if (next.length) host.setSelection(next); else host.clearSel();
    return next;
  };
  const end = () => { if (!mq) return; mq = null; box.style.display = "none"; };
  view.addEventListener("pointerup", end);
  view.addEventListener("pointercancel", end);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && mq) { const base = mq.base; end(); afterSelect(base); } });

  host.structure = { run, copy, paste, selectInverse };
}

if (typeof window !== "undefined" && window.canvasHost) attach(window.canvasHost);
