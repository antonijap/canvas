// Comments on the canvas, the pure half: what a click pins, where a pin shows, which threads show, and how a time
// reads. No DOM and no globals: the page (src/page/comments.js) draws with it and node tests import the same file.
// The shapes are cloud/protocol.ts (Anchor, Thread); the rules are docs/cloud/protocol.md.

/** A new thread's anchor from a click: a layer and the point on it as fractions of its box, else a point on the page. */
export function anchorFor({ nodeId, rect, point, page, board, info }) {
  if (nodeId && rect && rect.w > 0 && rect.h > 0) {
    const preview = {};
    if (info && info.name) preview.name = String(info.name).slice(0, 120);
    if (info && info.type) preview.type = String(info.type).slice(0, 40);
    preview.width = Math.round(rect.w * 100) / 100;
    preview.height = Math.round(rect.h * 100) / 100;
    return { ...(page ? { page } : {}), nodeId, x: round((point.x - rect.x) / rect.w), y: round((point.y - rect.y) / rect.h), ...(board ? { board } : {}), preview };
  }
  return { ...(page ? { page } : {}), x: round(point.x), y: round(point.y) };
}
const round = (n) => Math.round(n * 1e4) / 1e4;

// ---------- moving a pin by dragging it ----------
// A press on a pin opens its thread; once the pointer travels past DRAG_SLOP it drags the pin instead. The pin's tip
// keeps the offset it was grabbed at, and on the drop the thread is anchored again at the tip by anchorFor, the rule a
// new comment there would get (the layer under it, else the page). The change is one thread.move op.

/** How far (pt) a press on a pin travels before it is a drag, not a click. */
export const DRAG_SLOP = 4;
export const isDrag = (from, to) => Math.hypot(to.x - from.x, to.y - from.y) > DRAG_SLOP;
/** Where the pointer was pressed, relative to the pin's tip. */
export const grabOffset = (pointer, tip) => ({ x: pointer.x - tip.x, y: pointer.y - tip.y });
/** The tip of a pin being dragged, for the pointer now. */
export const tipAt = (pointer, grab) => ({ x: pointer.x - grab.x, y: pointer.y - grab.y });

/** Two anchors that put a pin in the same place (same page, layer and point): a drop there sends nothing. */
export const sameAnchor = (a, b) => !!a && !!b && (a.page || null) === (b.page || null) && (a.nodeId || null) === (b.nodeId || null) && a.x === b.x && a.y === b.y;

/**
 * Whether this Canvas may drag a thread's pin. A file that is not shared is the person's own: any pin. A shared file
 * follows the server's rule (cloud/protocol.ts mayApply, thread.move): the thread's author, matched by email, or the
 * Cloud owner. sync: the page's sync info ({ role, me }) or null.
 */
export function mayMove(t, sync) {
  if (!sync) return true;
  if (sync.canComment === false) return false;
  if (sync.role === "owner") return true;
  const mine = sync.me?.id || sync.me?.email, by = t?.createdBy?.id || t?.createdBy?.email;
  return !!mine && !!by && mine === by;
}

/** A thread that shows: not deleted, and resolved ones only while "Show resolved" is on. */
export const visibleThreads = (threads, showResolved) => threads.filter((t) => !t.deletedAt && (showResolved || !t.resolvedAt));

/** The comments of a thread that were not deleted. */
export const liveComments = (t) => t.comments.filter((c) => !c.deletedAt);

/** A server refusal in words the person commenting can act on. Raw server details stay out of the page. */
export function refusalReason(refusal, sync) {
  const { code, message, kind } = refusal;
  if (code === "forbidden") {
    if (sync?.role === "viewer" && sync.canComment === false) return "Update Canvas on the host to let viewers comment";
    if (["comment.edit", "comment.delete", "thread.delete"].includes(kind)) return "Only the person who wrote it can change it";
    if (kind === "thread.move") return "Only the person who wrote it or the Cloud owner can move it";
  }
  if (code === "conflict" && /\b(thread|comment)\b.*\bdeleted\b/i.test(message || "")) return "This thread was deleted";
  if (code === "quota") return "Too many comments at once. Canvas will try again";
  if (code === "invalid") return "Canvas could not send this comment";
  return "The server did not accept this comment";
}

/** The page a thread shows on: its board's page, else the page it was made on, else the first page. */
export function pageOf(t, pageOfBoard, firstPage) {
  const a = t.anchor || {};
  return (a.board && pageOfBoard(a.board)) || a.page || firstPage;
}

/**
 * Where a thread's pin goes, in world coordinates, and what it is:
 *   { x, y, kind: "layer" }   on its layer, following it
 *   { x, y, kind: "page" }    a point on the page (no layer)
 *   { x, y, kind: "board" }   its layer was deleted: the board's corner, in line with the others there (slot)
 *   null                      not known yet (its board is not drawn), or nowhere it may show
 * layerRect: the layer's world rect now, or null. gone: the layer is known to be deleted. boardRect: the board's world rect.
 */
export function pinSpot(t, { layerRect, gone, boardRect, slot = 0 }) {
  const a = t.anchor || {};
  if (!a.nodeId) return Number.isFinite(a.x) && Number.isFinite(a.y) ? { x: a.x, y: a.y, kind: "page" } : null;
  if (layerRect && !gone) return { x: layerRect.x + a.x * layerRect.w, y: layerRect.y + a.y * layerRect.h, kind: "layer" };
  if (!gone || !boardRect) return null;
  return { x: boardRect.x + boardRect.w + CORNER_GAP, y: boardRect.y + CORNER_GAP + slot * CORNER_STEP, kind: "board" };
}
export const CORNER_GAP = 20, CORNER_STEP = 34;

/** "Now", "5 m", "2 h", "3 d", else the date: short, as the thread shows it beside a name. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "Now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} m`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(s > 86400 * 300 ? { year: "numeric" } : {}) });
}

/** The avatar colours, one per person: the same name always gets the same one. */
export const AVATARS = ["#E9590C", "#2563EB", "#0F9D58", "#9333EA", "#DB2777", "#0891B2", "#CA8A04", "#4F46E5"];
export function colorOf(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

/**
 * Comments by an agent show a grey sparkles mark, not an initial. Author.agent says it; files written before that field
 * are told by the name canvas-mcp gave its client (src/comments.ts agentName).
 */
export const isAgent = (author) => !!author && (author.agent === true || (!author.email && /^(claude code|codex|cursor|agent|gemini|windsurf|copilot|zed)\b/i.test(String(author.name || ""))));

/** What the thread card says a deleted layer was: "Start free trial, a frame 288 x 44". */
export function previewLine(preview) {
  const p = preview || {};
  const a = /^[aeiou]/i.test(p.type || "") ? "an" : "a";
  const size = Number.isFinite(p.width) && Number.isFinite(p.height) ? ` ${Math.round(p.width)} \u00d7 ${Math.round(p.height)}` : "";
  return `${p.name || "Layer"}${p.type ? `, ${a} ${p.type}${size}` : size ? `,${size}` : ""}`;
}

/** Open and resolved counts of the threads that are not deleted. */
export function counts(threads) {
  let open = 0, resolved = 0;
  for (const t of threads) if (!t.deletedAt) (t.resolvedAt ? resolved++ : open++);
  return { open, resolved };
}

/** The letter on a pin: the first letter of the author's name, upper case. */
export const initialOf = (name) => {
  const m = /\p{L}|\p{N}/u.exec(String(name || ""));
  return m ? m[0].toUpperCase() : "?";
};

/** The thread open in the popover, or null when it is no longer there (deleted, or resolved and hidden). */
export function stillOpen(openId, threads, showResolved) {
  return openId && visibleThreads(threads, showResolved).some((t) => t.id === openId) ? openId : null;
}

/** Where the popover goes beside a pin inside a view of vw x vh: right of it, else left, kept inside. */
export function popoverAt(pin, size, vw, vh, gap = 18) {
  let x = pin.x + gap;
  if (x + size.w > vw - 8) x = pin.x - gap - size.w;
  x = Math.max(8, Math.min(x, vw - size.w - 8));
  const y = Math.max(8, Math.min(pin.y - 16, vh - size.h - 8));
  return { x, y };
}
