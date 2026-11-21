// Where an agent's new or moved board goes on the canvas: never on top of another board or card on its page.
//
// The rule (add_nodes, move_board, place_nodes out to the canvas, duplicate_nodes):
// - A new top-level layer without x and y goes right of everything on its page, BOARD_GAP away, level with the
//   page's top board. Several in one go, or one after another, line up in that row.
// - A position the agent gives, or that rule's spot, that would overlap a board or card on the page moves right
//   along its row, past what it hits plus BOARD_GAP, until it is clear. The answer says it moved and from where.
// - allowOverlap: true keeps the position as given (a note laid over a board on purpose).
// Moving right only keeps rows of screens in their row, and is what Cmd+D does with a board.
//
// Boards that hug their content have no size in the file: the page's measurements (rects) give it; without a page
// the size is estimated from the layers (text by character count, auto layout by its children, gaps and padding),
// erring large, so the spot found is clear of the drawn board.

import { buildIndex, type DocNode } from "./engine.ts";
import { listPages } from "./pages.ts";
import { storeFor } from "./widgets/store.ts";

export type Rect = { x: number; y: number; w: number; h: number };
type Doc = { children: DocNode[] };

export const BOARD_GAP = 40;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const r2 = (v: number) => Math.round(v * 100) / 100;
export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function pad4(v: unknown): [number, number, number, number] {
  const n = (x: unknown) => num(x) ?? 0;
  if (Array.isArray(v) && v.length === 2) return [n(v[0]), n(v[1]), n(v[0]), n(v[1])];
  if (Array.isArray(v) && v.length === 4) return [n(v[0]), n(v[1]), n(v[2]), n(v[3])];
  const x = n(v);
  return [x, x, x, x];
}

/**
 * The size a layer draws at, from its numbers, else estimated from what it holds. Errs large: it decides where a
 * board may go, and a spot a little further away is fine where one on top of a board is not.
 */
export function estimateSize(n: DocNode, index?: Map<string, DocNode>, depth = 0): { w: number; h: number } {
  const w = num(n.width), h = num(n.height);
  if (w !== undefined && h !== undefined) return { w, h };
  if (depth > 40) return { w: w ?? 100, h: h ?? 100 };
  let est: { w: number; h: number };
  if (n.type === "text") {
    const size = num(n.fontSize) ?? 14;
    const lh = num(n.lineHeight);
    const line = size * (lh === undefined ? 1.3 : lh > 4 ? lh / size : lh);
    const text = typeof n.content === "string" ? n.content : Array.isArray(n.content) ? n.content.map((s: any) => (typeof s?.content === "string" ? s.content : "")).join("") : "";
    const lines = text.split("\n");
    const longest = Math.max(1, ...lines.map((l) => l.length));
    if (w !== undefined) {
      const perLine = Math.max(1, Math.floor(w / (size * 0.6)));
      const count = lines.reduce((s, l) => s + Math.max(1, Math.ceil(l.length / perLine)), 0);
      est = { w, h: count * line };
    } else est = { w: longest * size * 0.6, h: lines.length * line };
  } else if (n.type === "ref" && typeof n.ref === "string" && index?.has(n.ref)) {
    est = estimateSize(index.get(n.ref)!, index, depth + 1);
  } else if (n.type === "frame" || n.type === "group") {
    const kids = ((n.children as DocNode[] | undefined) ?? []).filter((c) => c && typeof c === "object" && c.enabled !== false);
    const layout = n.type === "group" ? "none" : typeof n.layout === "string" ? n.layout : "horizontal";
    const [t, r, b, l] = n.type === "group" ? [0, 0, 0, 0] : pad4(n.padding);
    const gap = n.type === "group" ? 0 : num(n.gap) ?? 0;
    const sizes = kids.map((c) => ({ c, s: estimateSize(c, index, depth + 1) }));
    const flow = sizes.filter(({ c }) => layout === "none" || c.layoutPosition !== "absolute");
    if (layout === "horizontal") {
      est = { w: l + r + flow.reduce((s, x) => s + x.s.w, 0) + gap * Math.max(0, flow.length - 1), h: t + b + Math.max(0, ...flow.map((x) => x.s.h)) };
    } else if (layout === "vertical") {
      est = { w: l + r + Math.max(0, ...flow.map((x) => x.s.w)), h: t + b + flow.reduce((s, x) => s + x.s.h, 0) + gap * Math.max(0, flow.length - 1) };
    } else {
      est = { w: Math.max(0, ...sizes.map(({ c, s }) => (num(c.x) ?? 0) + s.w)), h: Math.max(0, ...sizes.map(({ c, s }) => (num(c.y) ?? 0) + s.h)) };
    }
  } else if (n.type === "icon" || n.type === "icon_font") {
    const s = num(n.size) ?? num(n.fontSize) ?? 24;
    est = { w: s, h: s };
  } else {
    est = { w: 100, h: 100 };
  }
  return { w: w ?? Math.ceil(est.w), h: h ?? Math.ceil(est.h) };
}

/** A top-level layer's box: x/y from the file (else the page's rect), size from the file, the page, or an estimate. */
export function topBox(n: DocNode, rect?: Rect, index?: Map<string, DocNode>): Rect {
  const x = num(n.x) ?? rect?.x ?? 0, y = num(n.y) ?? rect?.y ?? 0;
  const fw = num(n.width), fh = num(n.height);
  if (fw !== undefined && fh !== undefined) return { x, y, w: fw, h: fh };
  const est = rect ? { w: rect.w, h: rect.h } : estimateSize(n, index);
  return { x, y, w: fw ?? est.w, h: fh ?? est.h };
}

/** The first spot at or right of `want` along its row that overlaps none of `others`; `hit` lists what it moved past. */
export function clearSpot(want: Rect, others: (Rect & { name?: string })[], gap = BOARD_GAP): { x: number; y: number; hit: string[] } {
  let x = want.x;
  const hit: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const on = others.filter((o) => overlaps({ ...want, x }, o));
    if (!on.length) break;
    for (const o of on) if (o.name && !hit.includes(o.name)) hit.push(o.name);
    x = Math.max(...on.map((o) => o.x + o.w)) + gap;
  }
  return { x: r2(x), y: r2(want.y), hit };
}

/** First clear position along each axis. Take the shorter move, going right on ties. */
export function clearCardSpot(want: Rect, others: Rect[]): { x: number; y: number } {
  const firstClear = (start: number, size: number, spans: [number, number][]) => {
    let at = start;
    for (const [from, to] of spans.sort((a, b) => a[0] - b[0])) {
      if (from >= at + size) break;
      if (to > at) at = to + BOARD_GAP;
    }
    return at;
  };
  const right: [number, number][] = [], below: [number, number][] = [];
  for (const r of others) {
    if (r.y < want.y + want.h && r.y + r.h > want.y) right.push([r.x, r.x + r.w]);
    if (r.x < want.x + want.w && r.x + r.w > want.x) below.push([r.y, r.y + r.h]);
  }
  const x = firstClear(want.x, want.w, right);
  const y = firstClear(want.y, want.h, below);
  return x - want.x <= y - want.y ? { x, y: want.y } : { x: want.x, y };
}

/**
 * The top-level ids that share a page with `page` (a page id) or with the board `board`; null: the file has one
 * implicit page, every board is on it. A page id the file lacks means the first page (where an unlisted board shows).
 */
export function pageMates(docFile: string, doc: Doc, opts: { page?: string; board?: string }): { boards: Set<string> | null; page: string | null; first: boolean } {
  try {
    const ids = doc.children.map((n) => String(n.id));
    const view = listPages(docFile, () => ids);
    if (view.implicit) return { boards: null, page: null, first: true };
    const p = (opts.board && view.pages.find((x) => x.boards.includes(opts.board!))) || view.pages.find((x) => x.id === opts.page) || view.pages[0];
    return { boards: new Set(p.boards), page: p.id, first: p.id === view.pages[0].id };
  } catch {
    return { boards: null, page: null, first: true };
  }
}

/** The cards (widgets, videos, shaders) on a page, as boxes; [] when the file has none or they cannot be read. */
export function cardBoxes(docFile: string, page: string | null, first: boolean): (Rect & { name: string })[] {
  try {
    const list = storeFor(docFile).snapshot().widgets;
    return list
      .filter((w) => (typeof w.page === "string" && w.page ? w.page === page || (page === null && first) : first))
      .filter((w) => [w.x, w.y, w.w, w.h].every((v) => typeof v === "number" && Number.isFinite(v)))
      .map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h, name: `card "${w.name}"` }));
  } catch {
    return [];
  }
}

/** Visible top-level layers of the document that are not `skip`, limited to `mates` when given, as named boxes. */
export function obstacles(doc: Doc, skip: Set<string>, mates: Set<string> | null, rects: Record<string, Rect>, index?: Map<string, DocNode>): (Rect & { name: string; id: string })[] {
  const ix = index ?? buildIndex(doc as any);
  return doc.children
    .filter((n) => n && typeof n === "object" && n.enabled !== false && !skip.has(String(n.id)) && (!mates || mates.has(String(n.id))))
    .map((n) => ({ ...topBox(n, rects[String(n.id)], ix), name: `"${String(n.name ?? n.id)}"`, id: String(n.id) }));
}

/** What placement did with one top-level layer: where it ended up, and where it would have gone if it moved. */
export type Placed = { id: string; x: number; y: number; width: number; height: number; sizeEstimated?: true; movedFrom?: { x: number; y: number }; clearOf?: string[] };

/** Top-level ids without a size in the file, on the same page as `opts` names (the page measures these). */
export function unsizedOnPage(docFile: string, doc: Doc, opts: { page?: string; board?: string }): string[] {
  const { boards } = pageMates(docFile, doc, opts);
  return doc.children
    .filter((n) => n && typeof n === "object" && n.enabled !== false && (!boards || boards.has(String(n.id))) && (num(n.width) === undefined || num(n.height) === undefined))
    .map((n) => String(n.id))
    .slice(0, 300);
}

/**
 * Put new top-level layers where they overlap nothing on their page (see the top of this file). `given`: per id,
 * the x and y the agent wrote (undefined: none). Changes x/y through `set`. Layers placed earlier in the list count
 * as obstacles for the later ones, so several new boards line up in a row.
 */
export function placeNew(doc: Doc, ids: string[], given: Map<string, { x?: number; y?: number }>, opts: { mates: Set<string> | null; rects: Record<string, Rect>; cards: Rect[]; allowOverlap?: boolean; gap?: number }, set: (id: string, xy: { x: number; y: number }) => void): Placed[] {
  const gap = opts.gap ?? BOARD_GAP;
  const index = buildIndex(doc as any);
  const fresh = new Set(ids);
  const boards = obstacles(doc, fresh, opts.mates, opts.rects, index);
  const others: (Rect & { name?: string })[] = [...boards, ...opts.cards];
  // Where a layer without x/y goes: right of everything on the page, level with its top board.
  let nextX = boards.length ? Math.max(...boards.map((o) => o.x + o.w)) + gap : 0;
  const rowY = boards.length ? Math.min(...boards.map((o) => o.y)) : 0;
  const out: Placed[] = [];
  for (const id of ids) {
    const n = doc.children.find((c) => String(c.id) === id);
    if (!n) continue;
    const g = given.get(id) ?? {};
    const size = topBox(n, opts.rects[id], index);
    const estimated = num(n.width) === undefined || num(n.height) === undefined;
    const want: Rect = {
      x: g.x ?? nextX,
      y: g.y ?? rowY,
      w: size.w,
      h: size.h,
    };
    const spot = opts.allowOverlap ? { x: want.x, y: want.y, hit: [] } : clearSpot(want, others, gap);
    if (spot.x !== num(n.x) || spot.y !== num(n.y)) set(id, { x: spot.x, y: spot.y });
    const moved = (g.x !== undefined && spot.x !== g.x) || (g.y !== undefined && spot.y !== g.y);
    out.push({ id, x: spot.x, y: spot.y, width: size.w, height: size.h, ...(estimated ? { sizeEstimated: true as const } : {}), ...(moved ? { movedFrom: { x: want.x, y: want.y }, clearOf: spot.hit } : {}) });
    const box = { x: spot.x, y: spot.y, w: size.w, h: size.h, name: `"${String(n.name ?? id)}"` };
    others.push(box);
    nextX = Math.max(nextX, spot.x + size.w + gap);
  }
  return out;
}

/** One line for the agent about the layers placement moved, or undefined when none moved. */
export function placementNote(placed: Placed[]): string | undefined {
  const moved = placed.filter((p) => p.movedFrom);
  if (!moved.length) return undefined;
  return moved.map((p) => `${p.id} would have overlapped ${p.clearOf?.join(", ") || "another board"} at ${p.movedFrom!.x},${p.movedFrom!.y}: moved right to ${p.x},${p.y}`).join("; ") + ". Pass allowOverlap: true to keep a position that overlaps on purpose.";
}
