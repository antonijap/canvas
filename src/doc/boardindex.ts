// Facts about one top-level board, worked out once per board object: the ids of its layers (and the nodes they
// are), the ids its instances' overrides add, the components it uses, whether it holds a component, and the
// numbers its "Name N" layer names reach. Whole-document walks (findNode, buildIndex, allIds, the structure ops'
// searches) ask these instead of walking every board: a 2,000-board file walked 100k nodes per lookup.
//
// Only boards of a document version Canvas adopted are indexed ("frozen": snapshotOfDoc marks them). An edit copies
// the boards it touches before it changes them (docwriter.ts cowDoc), so a frozen board object never changes and its
// facts stay right; the copies an edit is changing are not frozen and are walked as before. A board changed in place
// anyway is forgotten (boardcache.ts forgetBoard) and indexed again.
import type { CanvasDoc } from "./docfile.ts";
import type { DocNode } from "./schema.ts";

type Facts = {
  /** Every layer in the board (the board included), by id: the last one wins, as buildIndex has it. */
  index: Map<string, DocNode>;
  /** Ids allIds counts that are not layers: replacement nodes inside instances' `descendants`. */
  extra: Set<string>;
  /** Component ids the board's instances name (overrides included), in walk order, repeats kept. */
  refs: string[];
  /** The board holds a main component (reusable: true). */
  reusable: boolean;
  /** For "Base N" names: the highest N per base. */
  names: Map<string, number>;
};

const frozen = new WeakSet<object>();
const facts = new WeakMap<object, Facts>();

/** Mark a document's boards as an adopted version: they are never changed in place from here on. */
export function freezeBoards(doc: { children?: unknown }): void {
  if (!Array.isArray(doc.children)) return;
  for (const b of doc.children) if (b && typeof b === "object") frozen.add(b);
}
/** Drop what was worked out for a board (it was changed in place). */
export function forgetBoardFacts(board: object): void {
  facts.delete(board);
}
export const isFrozen = (b: unknown): b is DocNode => !!b && typeof b === "object" && frozen.has(b);

const NAME_N = /^(.*) (\d+)$/;

function make(board: DocNode): Facts {
  const index = new Map<string, DocNode>(), extra = new Set<string>(), refs: string[] = [], names = new Map<string, number>();
  let reusable = false;
  const name = (n: DocNode) => {
    const m = typeof n.name === "string" ? NAME_N.exec(n.name) : null;
    if (m) { const v = Number(m[2]); if (v > (names.get(m[1]) ?? 0)) names.set(m[1], v); }
  };
  // Overrides: replacement nodes count for allIds (with an id and a type) and for refsOf, and walk their children.
  // One explicit stack instead of recursion, in the same order (a node, its children, then its overrides): a board
  // nested tens of thousands deep (a hostile file) overflowed the call stack and took the server down.
  const stack: [kind: "visit" | "desc", v: unknown][] = [["visit", board]];
  const later = (kind: "visit" | "desc", list: unknown[]) => { for (let i = list.length - 1; i >= 0; i--) stack.push([kind, list[i]]); };
  const overrides = (o: DocNode) => (o.descendants && typeof o.descendants === "object" && !Array.isArray(o.descendants) ? Object.values(o.descendants) : []);
  while (stack.length) {
    const [kind, v] = stack.pop()!;
    if (kind === "desc") {
      if (Array.isArray(v)) { later("desc", v); continue; }
      if (!v || typeof v !== "object") continue;
      const o = v as DocNode;
      if (typeof o.id === "string" && typeof o.type === "string") extra.add(o.id);
      if ((o.type === "ref" || !o.type) && typeof o.ref === "string") refs.push(o.ref);
      later("desc", overrides(o));
      if (Array.isArray(o.children)) later("desc", o.children);
      continue;
    }
    const n = v as DocNode;
    if (!n || typeof n !== "object") continue;
    if (typeof n.id === "string") index.set(n.id, n);
    if (n.reusable === true) reusable = true;
    if (n.type === "ref" && typeof n.ref === "string") refs.push(n.ref);
    name(n);
    later("desc", overrides(n));
    if (Array.isArray(n.children)) later("visit", n.children);
  }
  return { index, extra, refs, reusable, names };
}

/** The board's facts, or undefined when the board is not frozen (it may be changing: walk it). */
export function factsOf(board: unknown): Facts | undefined {
  if (!isFrozen(board)) return undefined;
  let f = facts.get(board);
  if (!f) facts.set(board, (f = make(board)));
  return f;
}

/**
 * Work out the facts of a document's boards in the background, a few ms at a time between other work: a file just
 * read, so the first lookup on it does not pay for every board at once. Boards already done are skipped; boards
 * that are not frozen (yet) are left for later.
 */
export function warmBoardFacts(doc: { children?: unknown }): void {
  const list = Array.isArray(doc.children) ? doc.children.slice() : [];
  let i = 0;
  const step = () => {
    const t0 = performance.now();
    while (i < list.length && performance.now() - t0 < 4) factsOf(list[i++]);
    if (i < list.length) setTimeout(step, 1).unref?.();
  };
  setTimeout(step, 50).unref?.();
}

/** True when the board is frozen and holds none of `ids` (a search for them can skip it). */
export function boardLacks(board: unknown, ids: Iterable<string>): boolean {
  const f = factsOf(board);
  if (!f) return false;
  for (const id of ids) if (f.index.has(id)) return false;
  return true;
}

/**
 * buildIndex's Map for a document, without walking its frozen boards: get and has ask each board's facts (the last
 * board holding an id wins, as a full walk's Map.set has it); a board that is not frozen is walked once, now, so the
 * map is the document as it was when it was made, like a walked one. Iterating it, or asking its size, builds the
 * whole map first.
 */
export class BoardIndex extends Map<string, DocNode> {
  private parts: (Map<string, DocNode>)[] = [];
  private whole = false;
  constructor(doc: CanvasDoc) {
    super();
    for (const b of doc.children) {
      if (!b || typeof b !== "object") continue;
      const f = factsOf(b);
      if (f) { this.parts.push(f.index); continue; }
      const m = new Map<string, DocNode>();
      const visit = (n: DocNode) => {
        if (typeof n.id === "string") m.set(n.id, n);
        if (Array.isArray(n.children)) n.children.forEach(visit);
      };
      visit(b);
      this.parts.push(m);
    }
  }
  private own(id: string): DocNode | undefined {
    return super.get(id);
  }
  override get(id: string): DocNode | undefined {
    if (this.whole || super.has(id)) return this.own(id);
    for (let i = this.parts.length - 1; i >= 0; i--) { const n = this.parts[i].get(id); if (n !== undefined || this.parts[i].has(id)) return n; }
    return undefined;
  }
  override has(id: string): boolean {
    if (this.whole || super.has(id)) return super.has(id);
    for (const p of this.parts) if (p.has(id)) return true;
    return false;
  }
  override set(id: string, n: DocNode): this {
    this.fill();
    return super.set(id, n);
  }
  override delete(id: string): boolean {
    this.fill();
    return super.delete(id);
  }
  private fill() {
    if (this.whole) return;
    this.whole = true;
    // Insertion order of a walked map: the first time an id is met (later boards only overwrite the value).
    const seen = new Map<string, DocNode>();
    for (const p of this.parts) for (const [k, v] of p) seen.set(k, v);
    for (const [k, v] of seen) if (!super.has(k)) super.set(k, v);
    this.parts = [];
  }
  override get size(): number { this.fill(); return super.size; }
  override keys() { this.fill(); return super.keys(); }
  override values() { this.fill(); return super.values(); }
  override entries() { this.fill(); return super.entries(); }
  override forEach(cb: (v: DocNode, k: string, m: Map<string, DocNode>) => void, thisArg?: unknown) { this.fill(); super.forEach(cb, thisArg); }
  override [Symbol.iterator]() { this.fill(); return super[Symbol.iterator](); }
  override clear() { this.whole = true; this.parts = []; super.clear(); }
}

/**
 * allIds's Set without walking frozen boards: has() asks each board's facts, add() keeps new ids (fresh ids an op
 * hands out). Iterating it, or asking its size, builds the whole set first.
 */
export class IdSet extends Set<string> {
  private parts: { index: Map<string, unknown>; extra: Set<string> }[] = [];
  private whole = false;
  constructor(doc: CanvasDoc, walkOne: (b: DocNode, into: Set<string>) => void) {
    super();
    for (const b of doc.children) {
      if (!b || typeof b !== "object") continue;
      const f = factsOf(b);
      if (f) { this.parts.push(f); continue; }
      const s = new Set<string>();
      walkOne(b, s);
      this.parts.push({ index: new Map(), extra: s });
    }
  }
  override has(id: string): boolean {
    if (super.has(id)) return true;
    if (this.whole) return false;
    for (const p of this.parts) if (p.index.has(id) || p.extra.has(id)) return true;
    return false;
  }
  private fill() {
    if (this.whole) return;
    this.whole = true;
    for (const p of this.parts) { for (const k of p.index.keys()) super.add(k); for (const k of p.extra) super.add(k); }
    this.parts = [];
  }
  override delete(id: string): boolean { this.fill(); return super.delete(id); }
  override get size(): number { this.fill(); return super.size; }
  override keys() { this.fill(); return super.keys(); }
  override values() { this.fill(); return super.values(); }
  override entries() { this.fill(); return super.entries(); }
  override forEach(cb: (v: string, k: string, s: Set<string>) => void, thisArg?: unknown) { this.fill(); super.forEach(cb, thisArg); }
  override [Symbol.iterator]() { this.fill(); return super[Symbol.iterator](); }
  override clear() { this.whole = true; this.parts = []; super.clear(); }
}
