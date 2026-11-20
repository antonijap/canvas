import { cloudFileHooks } from "./cloud-files-runtime.ts";
// The document the page lists (boards with change keys, components, text styles, variables) and the
// compact diff between two of them. The page gets the full payload once, on connect, and a diff for
// every change after that. applyDocDiff is plain JS under its type annotations: the page script embeds
// its source text, so the server and the page cannot disagree about how a diff applies.

import type { BoardMeta, ComponentInfo, Snapshot, TextStyle } from "./boards.ts";
import { marksOf, tokenLibrary, type Marks, type TokenLibrary } from "./usage.ts";

export type DocPayload = {
  name: string;
  revision: string;
  boards: BoardMeta[];
  components: ComponentInfo[];
  styles: TextStyle[];
  variables: Record<string, unknown>;
  themes: Record<string, unknown>;
  /** Variables and text styles grouped for the shell's library, with usage counts. */
  tokens: TokenLibrary;
  /** Which ids are components or instances (the page paints them purple). */
  marks: Marks;
};

/** One payload per snapshot: every edit diffs against the previous one, which was built for the edit before. */
const payloads = new WeakMap<Snapshot, DocPayload>();
export const docPayload = (s: Snapshot): DocPayload => {
  let p = payloads.get(s);
  if (!p) payloads.set(s, (p = { name: cloudFileHooks.info?.(s.path)?.name ?? s.name, revision: s.revision, boards: s.boards, components: s.components, styles: s.styles, variables: s.variables, themes: s.themes, tokens: tokenLibrary(s.doc, s.styles), marks: marksOf(s.doc) }));
  return p;
};

/**
 * What changed between two payloads. `base` is the revision the diff applies to: a page on any other
 * revision must refetch. `changed` and `added` carry the full board meta (with its key). `order` is the
 * complete board id order and is present only when the result of applying the diff would not already
 * have that order (boards moved in the file). Components, styles, variables and themes appear only when they changed.
 */
export type DocDiff = {
  base: string;
  revision: string;
  name?: string;
  changed: BoardMeta[];
  added: BoardMeta[];
  removed: string[];
  order?: string[];
  components?: ComponentInfo[];
  styles?: TextStyle[];
  variables?: Record<string, unknown>;
  themes?: Record<string, unknown>;
  tokens?: TokenLibrary;
  marks?: Marks;
};

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function docDiff(prev: DocPayload, next: DocPayload): DocDiff {
  const before = new Map(prev.boards.map((b) => [b.id, b]));
  const after = new Set(next.boards.map((b) => b.id));
  const out: DocDiff = { base: prev.revision, revision: next.revision, changed: [], added: [], removed: prev.boards.filter((b) => !after.has(b.id)).map((b) => b.id) };
  for (const b of next.boards) {
    const old = before.get(b.id);
    if (!old) out.added.push(b);
    else if (old.key !== b.key || old.name !== b.name || old.x !== b.x || old.y !== b.y || old.width !== b.width || old.height !== b.height) out.changed.push(b);
  }
  const kept = prev.boards.filter((b) => after.has(b.id)).map((b) => b.id).concat(out.added.map((b) => b.id));
  if (kept.length !== next.boards.length || kept.some((id, i) => id !== next.boards[i].id)) out.order = next.boards.map((b) => b.id);
  if (prev.name !== next.name) out.name = next.name;
  if (!same(prev.components, next.components)) out.components = next.components;
  if (!same(prev.styles, next.styles)) out.styles = next.styles;
  if (!same(prev.variables, next.variables)) out.variables = next.variables;
  if (!same(prev.themes, next.themes)) out.themes = next.themes;
  if (!same(prev.tokens, next.tokens)) out.tokens = next.tokens;
  if (!same(prev.marks, next.marks)) out.marks = next.marks;
  return out;
}

/** Apply a diff to the payload it was made against. Returns null when `d.base` is not `doc`'s revision. */
export function applyDocDiff(doc: any, d: any): any {
  if (!doc || doc.revision !== d.base) return null;
  const gone = new Set(d.removed);
  const byId = new Map();
  for (const b of d.changed) byId.set(b.id, b);
  let boards = [];
  for (const b of doc.boards) if (!gone.has(b.id)) boards.push(byId.get(b.id) || b);
  boards = boards.concat(d.added);
  if (d.order) {
    const at = new Map(boards.map((b: any) => [b.id, b]));
    boards = d.order.map((id: string) => at.get(id)).filter(Boolean);
  }
  const out = Object.assign({}, doc, { revision: d.revision, boards });
  for (const k of ["name", "components", "styles", "variables", "themes", "tokens", "marks"]) if (d[k] !== undefined) out[k] = d[k];
  return out;
}
