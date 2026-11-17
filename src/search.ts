// The command palette's server half (apps/macos/Palette.swift): find boards, layers, text, components, pages and
// cards across every page of a document, and "select matching" (Select matching layers and more) for the
// current selection. Pure over a snapshot plus the pages and widgets sidecar; the per-board index is worked out
// once per board object (boardcache.ts), so an edit pays only for the boards it touched.
//
// GET /api/search?file=&q=&page=            grouped results, best first, matched character ranges for highlighting
// GET /api/search?file=&q=&page=&all=layer  every id of that group on the given page (Cmd+Return: select them all)
// GET /api/search/match?file=&ids=a,b&page= the select-matching actions that apply, each with its ids on the page
// GET /api/search/text?file=&q=&case=1&word=1&page= find and replace: every literal occurrence in text layers

import { boardCache } from "./boardcache.ts";
import type { CanvasDoc, DocNode } from "./engine.ts";
import { layerKind, type LayerKind } from "./layers.ts";
import { listPages } from "./pages.ts";
import type { Snapshot } from "./boards.ts";
import { usageIndex } from "./usage.ts";
import { kinds as widgetKinds, docFileFor } from "./widgets.ts";
import { storeFor } from "./widgets/store.ts";

// ---------- fuzzy matching ----------

export type Range = [start: number, length: number];
export type Match = { score: number; ranges: Range[] };

const isWordChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;
/** A match starting here reads as a word start: the string's start, after a separator, or a camelCase hump. */
function boundary(t: string, i: number): boolean {
  if (i === 0) return true;
  const p = t.charCodeAt(i - 1), c = t.charCodeAt(i);
  if (!isWordChar(p)) return true;
  return p >= 97 && p <= 122 && c >= 65 && c <= 90;
}

/** One word against a string: a contiguous run first (best at a word start), else the letters in order, tight. */
function matchWord(w: string, t: string, tl: string, fuzzy: boolean): Match | null {
  let best: Match | null = null;
  for (let i = tl.indexOf(w), n = 0; i >= 0 && n < 6; i = tl.indexOf(w, i + 1), n++) {
    const s = 100 + w.length * 12 + (i === 0 ? 40 : boundary(t, i) ? 25 : 0) - Math.min(i, 30) * 0.5;
    if (!best || s > best.score) best = { score: s, ranges: [[i, w.length]] };
    if (i === 0) break;
  }
  if (best || !fuzzy || w.length < 2) return best;
  // Letters in order, greedy from each place the first letter appears; word starts and runs score, gaps cost.
  const maxSpan = Math.max(w.length * 3, w.length + 10);
  for (let start = tl.indexOf(w[0]), tries = 0; start >= 0 && tries < 8; start = tl.indexOf(w[0], start + 1), tries++) {
    const ranges: Range[] = [[start, 1]];
    let s = 10 + (boundary(t, start) ? 14 : 0) + (start === 0 ? 10 : 0), at = start, ok = true;
    for (let k = 1; k < w.length; k++) {
      const j = tl.indexOf(w[k], at + 1);
      if (j < 0 || j - start >= maxSpan) { ok = false; break; }
      if (j === at + 1) { s += 18; ranges[ranges.length - 1][1]++; }
      else { s += 8 + (boundary(t, j) ? 12 : 0) - Math.min(j - at - 1, 8); ranges.push([j, 1]); }
      at = j;
    }
    if (ok && (!best || s > best.score)) best = { score: s, ranges };
  }
  return best;
}

/** Lower case with the same length, so match offsets in it index the original ("İ".toLowerCase() is two characters). */
export function lowerSame(t: string): string {
  const l = t.toLowerCase();
  if (l.length === t.length) return l;
  let o = "";
  for (const ch of t) { const c = ch.toLowerCase(); o += c.length === ch.length ? c : ch; }
  return o;
}

/**
 * How well `q` (already lower case, trimmed) matches `t`; null when it does not. Several words must each match,
 * in any order. `fuzzy` false: only contiguous runs count (text content, where letters in order match anything).
 */
export function fuzzyMatch(q: string, t: string, tl = lowerSame(t), fuzzy = true): Match | null {
  if (!q) return null;
  const whole = matchWord(q, t, tl, false);
  if (whole) {
    if (whole.ranges[0][0] === 0 && q.length === tl.length) whole.score += 60; // exact
    whole.score -= Math.min(tl.length - q.length, 60) * 0.3;
    return whole;
  }
  const words = q.split(/\s+/).filter(Boolean);
  let score = 0;
  const ranges: Range[] = [];
  for (const w of words) {
    const m = matchWord(w, t, tl, fuzzy);
    if (!m) return null;
    score += m.score * 0.8;
    ranges.push(...m.ranges);
  }
  if (words.length === 1 && !fuzzy) return null;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[0] + last[1]) last[1] = Math.max(last[1], r[0] + r[1] - last[0]);
    else merged.push([r[0], r[1]]);
  }
  return { score: score - Math.min(tl.length, 60) * 0.3, ranges: merged };
}

// ---------- the index ----------

type Entry = {
  id: string;
  board: string;
  kind: LayerKind;
  name: string;
  nameL: string;
  depth: number;
  /** Text layers: their content on one line. */
  text?: string;
  textL?: string;
  /** The name was set by hand (not the default for the type, not the text's own words). */
  named: boolean;
  hidden: boolean;
  /** Locked, by itself or a parent: select matching leaves it out, as the canvas does. */
  locked: boolean;
  node: DocNode;
};
type Part = { board: string; boardName: string; entries: Entry[] };
const parts = boardCache<Part>();

const DEFAULT_NAMES = new Set(["frame", "group", "rectangle", "ellipse", "text", "path", "line", "polygon", "icon", "instance", "vector", "image", "note"]);

export function textOf(n: DocNode): string {
  const c = (n as Record<string, unknown>).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((r) => (r && typeof r === "object" ? String((r as Record<string, unknown>).text ?? (r as Record<string, unknown>).content ?? "") : String(r ?? ""))).join("");
  return "";
}

function partOf(top: DocNode): Part {
  const hit = parts.get(top);
  if (hit) return hit;
  const board = String(top.id);
  const boardName = typeof top.name === "string" && top.name.trim() ? top.name : board;
  const entries: Entry[] = [];
  const visit = (n: DocNode, depth: number, hiddenAbove: boolean, lockedAbove: boolean) => {
    const raw = typeof n.name === "string" ? n.name.trim() : "";
    const hidden = (n as Record<string, unknown>).enabled === false;
    const locked = lockedAbove || (n as Record<string, unknown>).locked === true;
    const text = n.type === "text" ? textOf(n).replace(/\s+/g, " ").trim() : undefined;
    const name = raw || (text ? text.slice(0, 60) : String(n.type ?? "layer"));
    entries.push({
      id: String(n.id), board, kind: layerKind(n), name, nameL: lowerSame(name), depth,
      ...(text ? { text, textL: lowerSame(text) } : {}),
      named: !!raw && !DEFAULT_NAMES.has(raw.toLowerCase()) && raw !== text,
      hidden: hidden || hiddenAbove, locked, node: n,
    });
    for (const c of n.children ?? []) if (c && typeof c === "object") visit(c, depth + 1, hidden || hiddenAbove, locked);
  };
  visit(top, 0, false, false);
  const p = { board, boardName, entries };
  parts.set(top, p);
  return p;
}

// The hidden board holding deleted main components (structure.ts DELETED_KEY) is no place the person sees: skipped, as usage.ts does.
const partsOf = (doc: CanvasDoc): Part[] => (doc.children as DocNode[]).filter((t) => t && typeof t === "object" && t.id !== undefined && (t.metadata as Record<string, unknown> | undefined)?.canvasDeletedComponents !== true).map(partOf);

/** Pages, and which page each board is on, from the sidecar. A document without one has a single implicit page. */
function pagesOf(snap: Snapshot) {
  let pages: { id: string; name: string; boards: string[] }[] = [];
  try {
    pages = listPages(snap.path, () => snap.boards.map((b) => b.id)).pages;
  } catch {
    pages = [{ id: "page-1", name: "Page 1", boards: snap.boards.map((b) => b.id) }];
  }
  const ofBoard = new Map<string, string>();
  for (const p of pages) for (const b of p.boards) ofBoard.set(b, p.id);
  return { pages, ofBoard, name: new Map(pages.map((p) => [p.id, p.name])) };
}

type CardRow = { id: string; kind: string; name: string; page?: string; config?: Record<string, unknown> };
function widgetsOf(snap: Snapshot): CardRow[] {
  try {
    return storeFor(docFileFor(snap.path)).snapshot().widgets as CardRow[];
  } catch {
    return [];
  }
}

/** What a card shows as its title: a to-do's own title (config.title) wins over the card's name, as on the canvas. */
export function cardTitle(w: CardRow, kindTitle: string): string {
  const own = w.config && typeof w.config.title === "string" ? w.config.title.trim() : "";
  if (own) return own;
  return w.name && w.name.trim() ? w.name : kindTitle;
}

// ---------- find ----------

export type GroupKind = "board" | "layer" | "text" | "component" | "page" | "card";
export type Hit = {
  id: string;
  title: string;
  ranges: Range[];
  /** Where it is: its board and (with more than one page) its page. */
  detail: string;
  kind: string;
  board?: string;
  page?: string;
  score: number;
};
export type Group = { kind: GroupKind; total: number; items: Hit[] };

const LIMITS: Record<GroupKind, number> = { board: 6, page: 4, component: 6, card: 6, layer: 10, text: 10 };
const ORDER: GroupKind[] = ["board", "page", "component", "card", "layer", "text"];

/** A line of long text around its first match, with the ranges moved to match. */
function snippet(text: string, ranges: Range[], max = 90): { title: string; ranges: Range[] } {
  if (text.length <= max) return { title: text, ranges };
  const first = ranges[0]?.[0] ?? 0;
  const start = first < 30 ? 0 : first - 24;
  const pre = start > 0 ? "…" : "";
  const body = text.slice(start, start + max - pre.length);
  const post = start + body.length < text.length ? "…" : "";
  const moved = ranges.map(([s, l]) => [s - start + pre.length, l] as Range).filter(([s, l]) => s >= pre.length && s + l <= pre.length + body.length);
  return { title: pre + body + post, ranges: moved };
}

/** Keeps the best `n` of a stream without sorting all of it (a one-letter query matches thousands). */
class Top {
  items: Hit[] = [];
  total = 0;
  n: number;
  constructor(n: number) { this.n = n; }
  push(h: Hit) {
    this.total++;
    const a = this.items;
    if (a.length === this.n && h.score <= a[a.length - 1].score) return;
    let i = a.length;
    while (i > 0 && a[i - 1].score < h.score) i--;
    a.splice(i, 0, h);
    if (a.length > this.n) a.pop();
  }
}

export function search(snap: Snapshot, query: string, activePage: string | null): { groups: Group[]; ms: number } {
  const t0 = performance.now();
  const q = query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  if (!q) {
    // The palette asks with an empty query as it opens: build the index now, so the first keystroke is quick.
    partsOf(snap.doc);
    usageIndex(snap.doc);
    return { groups: [], ms: Math.round((performance.now() - t0) * 10) / 10 };
  }
  const pg = pagesOf(snap);
  const many = pg.pages.length > 1;
  const where = (boardName: string, page: string | undefined) => (many && page ? `${boardName}, ${pg.name.get(page) ?? page}` : boardName);
  const top: Record<GroupKind, Top> = { board: new Top(LIMITS.board), page: new Top(LIMITS.page), component: new Top(LIMITS.component), card: new Top(LIMITS.card), layer: new Top(LIMITS.layer), text: new Top(LIMITS.text) };
  const instances = usageIndex(snap.doc).instances;

  for (const part of partsOf(snap.doc)) {
    const page = pg.ofBoard.get(part.board);
    const here = page === activePage ? 6 : 0;
    for (const e of part.entries) {
      if (e.depth === 0 && e.node.reusable !== true) {
        const m = fuzzyMatch(q, e.name, e.nameL);
        if (m) top.board.push({ id: e.id, title: e.name, ranges: m.ranges, detail: many && page ? pg.name.get(page) ?? page : "", kind: "board", board: e.id, page, score: m.score + here });
        continue;
      }
      if (e.node.reusable === true) {
        const m = fuzzyMatch(q, e.name, e.nameL);
        if (m) {
          const n = instances.get(e.id)?.length ?? 0;
          top.component.push({ id: e.id, title: e.name, ranges: m.ranges, detail: where(part.boardName, page) + (n ? `, ${n} ${n === 1 ? "instance" : "instances"}` : ""), kind: "component", board: part.board, page, score: m.score + here });
        }
        continue;
      }
      // Text layers by what they say (whole words or runs only: letters in order match anything in a paragraph).
      let textHit = false;
      if (e.textL) {
        const m = fuzzyMatch(q, e.text!, e.textL, false);
        if (m) {
          textHit = true;
          const s = snippet(e.text!, m.ranges);
          top.text.push({ id: e.id, title: s.title, ranges: s.ranges, detail: where(part.boardName, page), kind: "text", board: part.board, page, score: m.score + here - e.depth * 0.5 - (e.hidden ? 20 : 0) });
        }
      }
      // Layers by a name someone gave them (a text found by its words is not listed twice).
      if (e.named && !textHit) {
        const m = fuzzyMatch(q, e.name, e.nameL);
        if (m) top.layer.push({ id: e.id, title: e.name, ranges: m.ranges, detail: where(part.boardName, page), kind: e.kind, board: part.board, page, score: m.score + here - e.depth * 0.5 - (e.hidden ? 20 : 0) });
      }
    }
  }
  for (const p of pg.pages) {
    const m = fuzzyMatch(q, p.name);
    if (m) top.page.push({ id: p.id, title: p.name, ranges: m.ranges, detail: `${p.boards.length} ${p.boards.length === 1 ? "board" : "boards"}`, kind: "page", page: p.id, score: m.score + 10 });
  }
  const kindTitle = new Map(widgetKinds().map((k) => [k.id, k.title]));
  for (const w of widgetsOf(snap)) {
    const kt = kindTitle.get(w.kind) ?? w.kind;
    const title = cardTitle(w, kt);
    const m = fuzzyMatch(q, title) ?? (title !== kt ? fuzzyMatch(q, kt) : null);
    const page = typeof w.page === "string" && pg.name.has(w.page) ? w.page : pg.pages[0]?.id;
    if (m) top.card.push({ id: "widget:" + w.id, title, ranges: title === kt || fuzzyMatch(q, title) ? m.ranges : [], detail: many && page ? `${kt}, ${pg.name.get(page)}` : kt, kind: "card:" + w.kind, page, score: m.score + (page === activePage ? 6 : 0) });
  }
  const groups = ORDER.map((k) => ({ kind: k, total: top[k].total, items: top[k].items })).filter((g) => g.items.length);
  groups.sort((a, b) => b.items[0].score - a.items[0].score || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  return { groups, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

/** Every layer of a group (layer or text) that matches, on one page: Cmd+Return selects them all. */
export function searchAll(snap: Snapshot, query: string, kind: "layer" | "text", page: string | null): { ids: string[]; boards: Record<string, string> } {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  const pg = pagesOf(snap);
  const ids: string[] = [], boards: Record<string, string> = {};
  if (!q) return { ids, boards };
  for (const part of partsOf(snap.doc)) {
    if (page && pg.ofBoard.get(part.board) !== page) continue;
    for (const e of part.entries) {
      if (e.depth === 0 || e.node.reusable === true) continue;
      const textHit = !!e.textL && !!fuzzyMatch(q, e.text!, e.textL, false);
      const hit = kind === "text" ? textHit : e.named && !textHit && !!fuzzyMatch(q, e.name, e.nameL);
      if (hit) { ids.push(e.id); boards[e.id] = part.board; }
    }
  }
  return { ids, boards };
}

// ---------- find and replace (literal text, match case, whole words) ----------

export type FindOpts = { matchCase?: boolean; wholeWord?: boolean };
const WORD = /[\p{L}\p{N}_]/u;

/** The whole character (code point) that ends at offset `i` of `s`: a surrogate pair is one letter. */
const charBefore = (s: string, i: number) => {
  const lo = s.charCodeAt(i - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && i >= 2 && s.charCodeAt(i - 2) >= 0xd800 && s.charCodeAt(i - 2) <= 0xdbff ? s.slice(i - 2, i) : s[i - 1];
};
const charAt = (s: string, i: number) => String.fromCodePoint(s.codePointAt(i)!);

/**
 * Where `query` occurs in `text`, literally (no fuzzy letters), left to right without overlaps: start offsets.
 * `max`: stop after that many (the find bar's list); Replace All passes Infinity, so it never leaves any behind.
 */
export function findAll(text: string, query: string, o: FindOpts = {}, max = 10_000): number[] {
  if (!query) return [];
  const t = o.matchCase ? text : lowerSame(text), q = o.matchCase ? query : lowerSame(query);
  const out: number[] = [];
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i)) {
    const ok = !o.wholeWord || ((i === 0 || !WORD.test(charBefore(text, i))) && (i + q.length >= text.length || !WORD.test(charAt(text, i + q.length))));
    if (ok) { out.push(i); i += q.length; } else i += 1;
    if (out.length >= max) break;
  }
  return out;
}

/** A text layer whose content can be found and replaced: plain text of the file, not a variable's. */
export function replaceableText(n: DocNode, vars: Record<string, unknown> | undefined): string | null {
  if (n.type !== "text" || typeof n.content !== "string") return null;
  const c = n.content;
  if (c.startsWith("$") && vars && Object.prototype.hasOwnProperty.call(vars, c.slice(1))) return null;
  return c;
}

export type TextMatch = { id: string; board: string; page?: string; start: number; length: number; title: string; ranges: Range[] };

/**
 * Every occurrence of `query` in the text layers of the file, every page, in board order then reading order (the
 * active page first). Text inside instances follows its component and is found there.
 */
export function findText(snap: Snapshot, query: string, o: FindOpts & { page?: string | null; limit?: number } = {}): { matches: TextMatch[]; total: number; layers: number } {
  const pg = pagesOf(snap);
  const vars = snap.doc.variables as Record<string, unknown> | undefined;
  const order = (p: string | undefined) => (p === o.page ? -1 : pg.pages.findIndex((x) => x.id === p));
  const limit = o.limit ?? 2000;
  const matches: TextMatch[] = [];
  let total = 0, layers = 0;
  const all = partsOf(snap.doc).map((part) => ({ part, page: pg.ofBoard.get(part.board) }));
  all.sort((a, b) => order(a.page) - order(b.page));
  for (const { part, page } of all) {
    for (const e of part.entries) {
      const text = replaceableText(e.node, vars);
      if (text === null) continue;
      const at = findAll(text, query, o);
      if (!at.length) continue;
      layers++;
      total += at.length;
      for (const s of at) {
        if (matches.length >= limit) break;
        const line = text.replace(/\s/g, " ");
        const sn = snippet(line, [[s, query.length]]);
        matches.push({ id: e.id, board: part.board, page, start: s, length: query.length, title: sn.title, ranges: sn.ranges });
      }
    }
  }
  return { matches, total, layers };
}

// ---------- select matching ----------

export type MatchAction = { key: string; title: string; detail: string; count: number; ids: string[]; boards: Record<string, string> };

/** A fill as one comparable string: a colour (case folded), a variable, or the JSON of anything richer. */
export function fillKey(f: unknown): string | null {
  if (f === undefined || f === null || f === "") return null;
  if (typeof f === "string") return f.startsWith("$") ? f : f.toLowerCase();
  if (Array.isArray(f)) {
    const on = f.filter((x) => !(x && typeof x === "object" && (x as Record<string, unknown>).enabled === false));
    if (!on.length) return null;
    if (on.length === 1) return fillKey(on[0]);
    return JSON.stringify(on.map(fillKey));
  }
  if (typeof f === "object") {
    const o = f as Record<string, unknown>;
    if (o.type === "color" && typeof o.color === "string") return fillKey(o.color);
    if (typeof o.color === "string" && Object.keys(o).every((k) => k === "color" || k === "type" || k === "enabled")) return fillKey(o.color);
    return JSON.stringify(o);
  }
  return String(f);
}

/** A layer's effects as one comparable string (only the ones on), or null without any. */
export function effectKey(v: unknown): string | null {
  const list = (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []).filter((x) => !(x && typeof x === "object" && (x as Record<string, unknown>).enabled === false));
  return list.length ? JSON.stringify(list).toLowerCase() : null;
}

const WEIGHTS: Record<string, string> = { "100": "Thin", "200": "Extra Light", "300": "Light", "400": "Regular", normal: "Regular", "500": "Medium", "600": "Semibold", "700": "Bold", bold: "Bold", "800": "Extra Bold", "900": "Black" };
const family = (n: DocNode) => String((n as Record<string, unknown>).fontFamily ?? "Inter");
const weight = (n: DocNode) => String((n as Record<string, unknown>).fontWeight ?? "400");
const size = (n: DocNode) => String((n as Record<string, unknown>).fontSize ?? "");
const styleName = (n: DocNode) => `${family(n).replace(/^\$/, "")} ${size(n)} ${WEIGHTS[weight(n)] ?? weight(n)}`.replace(/\s+/g, " ").trim();
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** The variables a node's own properties name ($name), not its children's. */
function varsOf(n: DocNode): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") { if (v.length > 1 && v.charCodeAt(0) === 36) out.add(v.slice(1)); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const [k, v] of Object.entries(n)) if (k !== "children" && k !== "descendants" && k !== "id") walk(v);
  return [...out];
}

/**
 * The select-matching actions for a selection, each with the layers it selects on `page` (Select
 * matching layers stays on the page). Only actions that apply, and only those that find something, are returned.
 */
export function matchActions(snap: Snapshot, selIds: string[], page: string | null): { actions: MatchAction[]; ms: number } {
  const t0 = performance.now();
  const pg = pagesOf(snap);
  const all = partsOf(snap.doc);
  const onPage = page ? all.filter((p) => pg.ofBoard.get(p.board) === page) : all;
  const byId = new Map<string, { e: Entry; part: Part }>();
  for (const part of all) for (const e of part.entries) byId.set(e.id, { e, part });
  const sel = selIds.map((id) => byId.get(id)).filter((x): x is { e: Entry; part: Part } => !!x);
  const actions: MatchAction[] = [];
  const collect = (key: string, title: string, noun: string, test: (e: Entry) => boolean, parts = onPage) => {
    const ids: string[] = [], boards: Record<string, string> = {};
    for (const part of parts) for (const e of part.entries) if (!e.locked && test(e)) { ids.push(e.id); boards[e.id] = part.board; }
    if (ids.length) actions.push({ key, title, detail: plural(ids.length, noun), count: ids.length, ids, boards });
  };
  const text = sel.find((s) => s.e.node.type === "text")?.e.node;
  if (text) {
    const f = family(text), z = size(text), w = weight(text);
    collect("textStyle", `Same text style: ${styleName(text)}`, "text layer", (e) => e.node.type === "text" && family(e.node) === f && size(e.node) === z && weight(e.node) === w);
    collect("font", `Same font: ${f.replace(/^\$/, "")}`, "text layer", (e) => e.node.type === "text" && family(e.node) === f);
  }
  const filled = sel.map((s) => s.e).find((e) => fillKey(e.node.fill) !== null);
  if (filled) {
    const k = fillKey(filled.node.fill)!;
    const shown = k.startsWith("{") || k.startsWith("[") ? "this fill" : k;
    collect("fill", `Same fill: ${shown}`, "layer", (e) => fillKey(e.node.fill) === k);
  }
  // Edit > Select All with the same Stroke and Effect.
  const stroked = sel.map((s) => s.e).find((e) => fillKey(e.node.stroke) !== null);
  if (stroked) {
    const k = fillKey(stroked.node.stroke)!;
    const shown = k.startsWith("{") || k.startsWith("[") ? "this stroke" : k;
    collect("stroke", `Same stroke: ${shown}`, "layer", (e) => fillKey(e.node.stroke) === k);
  }
  const fx = sel.map((s) => s.e).find((e) => effectKey(e.node.effect) !== null);
  if (fx) {
    const k = effectKey(fx.node.effect)!;
    collect("effect", "Same effect", "layer", (e) => effectKey(e.node.effect) === k);
  }
  // Select matching layers (Option+Cmd+A): layers with the same name and kind in the other boards, with the
  // selected ones. A layer never matches in its own board, and a board has nothing to match.
  const layersSel = sel.filter((s) => s.e.depth > 0 && !s.e.locked);
  if (layersSel.length) {
    const want = new Map<string, Set<string>>(); // name + kind -> the boards the selected ones are on
    for (const s of layersSel) { const k = s.e.kind + "\u0000" + s.e.name; if (!want.has(k)) want.set(k, new Set()); want.get(k)!.add(s.e.board); }
    const selected = new Set(layersSel.map((s) => s.e.id));
    const ids: string[] = [], boards: Record<string, string> = {};
    for (const part of onPage) for (const e of part.entries) {
      if (e.depth === 0 || e.locked) continue;
      const on = want.get(e.kind + "\u0000" + e.name);
      if (selected.has(e.id) || (on && !on.has(e.board))) { ids.push(e.id); boards[e.id] = part.board; }
    }
    if (ids.some((id) => !selected.has(id))) actions.push({ key: "matching", title: "Select matching layers", detail: plural(ids.length, "layer"), count: ids.length, ids, boards });
  }
  // Instances of the selected instance's component, or of the selected component.
  const comp = sel.map((s) => s.e.node).find((n) => n.type === "ref" && typeof n.ref === "string" || n.reusable === true);
  if (comp) {
    const id = comp.type === "ref" ? String(comp.ref) : String(comp.id);
    const name = byId.get(id)?.e.name ?? id;
    collect("instances", `All instances of ${name}`, "instance", (e) => e.node.type === "ref" && e.node.ref === id);
  }
  // Everything using a variable (or colour token) the selection uses.
  const vars = [...new Set(sel.flatMap((s) => varsOf(s.e.node)))].slice(0, 4);
  if (vars.length) {
    const uses = usageIndex(snap.doc).variables;
    const pageBoards = new Set(onPage.map((p) => p.board));
    for (const v of vars) {
      const list = (uses.get(v) ?? []).filter((u) => pageBoards.has(u.board) && !u.id.includes("/") && !byId.get(u.id)?.e.locked);
      if (!list.length) continue;
      const boards: Record<string, string> = {};
      for (const u of list) boards[u.id] = u.board;
      const ids = [...new Set(list.map((u) => u.id))];
      actions.push({ key: "var:" + v, title: `Everything using $${v}`, detail: plural(ids.length, "layer"), count: ids.length, ids, boards });
    }
  }
  // Every text layer on the selection's board.
  const first = sel[0];
  if (first) collect("boardText", `All text on ${first.part.boardName}`, "text layer", (e) => e.node.type === "text", [first.part]);
  // Needs no selection: the hidden layers on this page (the topmost hidden one, not each layer inside it).
  collect("hidden", "All hidden layers on this page", "hidden layer", (e) => (e.node as Record<string, unknown>).enabled === false);
  return { actions, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

// ---------- route ----------

export function handleSearchRoute(url: URL, snap: Snapshot, reply: (v: unknown, status?: number) => void): boolean {
  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    const page = url.searchParams.get("page") || null;
    const all = url.searchParams.get("all");
    if (all) {
      if (all !== "layer" && all !== "text") reply({ error: "all must be layer or text" }, 400);
      else reply(searchAll(snap, q, all, page));
      return true;
    }
    reply({ q, ...search(snap, q, page) });
    return true;
  }
  if (url.pathname === "/api/search/text") {
    const q = (url.searchParams.get("q") ?? "").slice(0, 500);
    const flag = (k: string) => url.searchParams.get(k) === "1";
    reply({ q, ...findText(snap, q, { matchCase: flag("case"), wholeWord: flag("word"), page: url.searchParams.get("page") || null }) });
    return true;
  }
  if (url.pathname === "/api/search/match") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
    reply(matchActions(snap, ids, url.searchParams.get("page") || null));
    return true;
  }
  return false;
}
