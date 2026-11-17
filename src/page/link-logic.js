// Canvas links (Cmd+L, Edit > Copy Link): one line that names a file, a page and nodes, for pasting into an agent's
// chat. The agent passes it to Canvas MCP as `link` (mcp/link.ts); macOS opens it in Canvas.app (main.swift,
// CanvasLink in ShellLogic.swift parses it the same way). Pure, node-tested (test/link.test.ts).
//
//   canvas://open?file=/Users/me/Desktop/My%20App.canvas&page=page-2&node=Home,Btn01
//
// - file: the document's absolute path. "/" and ":" stay as they are so it reads; everything else outside
//   [A-Za-z0-9-_.~/:] is percent-encoded as UTF-8 (spaces %20, "+" %2B, "," %2C, non-ASCII bytes).
// - page: the page id, when the file has pages of its own. Optional.
// - node: the node ids (the file's own ids, instance paths like Ins01/Lbl01, cards as widget:<id>), comma-separated,
//   each encoded like the file. Optional: a link with no node names the page.
// Parsing ignores keys it does not know, so later links with more keys still open here.

export const PREFIX = "canvas://open?";
export const MAX_NODES = 200;

/** Percent-encodes everything but unreserved characters and "/". */
export function encodePart(s) {
  return encodeURIComponent(String(s)).replace(/%2F/g, "/").replace(/%3A/g, ":").replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** The link for {file, page?, nodes?}. Null without an absolute file path. */
export function buildLink(o) {
  if (!o || typeof o.file !== "string" || !o.file.startsWith("/")) return null;
  let s = PREFIX + "file=" + encodePart(o.file);
  if (typeof o.page === "string" && o.page) s += "&page=" + encodePart(o.page);
  const nodes = Array.isArray(o.nodes) ? [...new Set(o.nodes.filter((n) => typeof n === "string" && n))].slice(0, MAX_NODES) : [];
  if (nodes.length) s += "&node=" + nodes.map(encodePart).join(",");
  return s;
}

const decode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

/**
 * {file, page, nodes} from a link, or null when it is not one. Whitespace and angle brackets or quotes around it
 * (as chat apps wrap links) are ignored.
 */
export function parseLink(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/^[<"'`(]+|[>"'`)]+$/g, "");
  if (!t.toLowerCase().startsWith(PREFIX)) return null;
  const q = t.slice(PREFIX.length).split("#")[0];
  let file = null, page = null, nodes = [];
  for (const part of q.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i), v = part.slice(i + 1);
    if (k === "file") file = decode(v);
    else if (k === "page") page = decode(v) || null;
    else if (k === "node") {
      const ids = v.split(",").filter(Boolean).map(decode);
      if (ids.some((x) => x === null)) return null;
      nodes = [...new Set(ids)].slice(0, MAX_NODES);
    }
  }
  if (!file || !file.startsWith("/") || file.includes("\0")) return null;
  return { file, page, nodes };
}

/** Every Canvas link in a text (an agent may get a whole message). */
export function findLinks(text) {
  if (typeof text !== "string") return [];
  const out = [];
  // Sentence punctuation right after a link is not part of it (a real trailing "." would be in a file name only).
  for (const m of text.matchAll(/canvas:\/\/open\?[^\s<>"'`]+/gi)) { const l = parseLink(m[0].replace(/[.,;:!?)\]]+$/, "")); if (l) out.push(l); }
  return out;
}

/**
 * What Cmd+L links to with nothing selected: the board that fills most of the view (visible area), the one nearest
 * the view's centre on a tie. boards: [{id, x, y, w, h}] world rects; view: {x, y, w, h} world rect. Null when none
 * shows.
 */
export function boardInView(boards, view) {
  if (!view || !(view.w > 0) || !(view.h > 0)) return null;
  const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
  let best = null, bestArea = 0, bestDist = Infinity;
  for (const b of boards || []) {
    if (!b || typeof b.id !== "string") continue;
    const w = Math.min(b.x + b.w, view.x + view.w) - Math.max(b.x, view.x);
    const h = Math.min(b.y + b.h, view.y + view.h) - Math.max(b.y, view.y);
    if (!(w > 0 && h > 0)) continue;
    const area = w * h;
    const d = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
    if (area > bestArea + 1e-6 || (Math.abs(area - bestArea) <= 1e-6 && d < bestDist)) { best = b.id; bestArea = area; bestDist = d; }
  }
  return best;
}
