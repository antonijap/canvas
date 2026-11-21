// A design file's whole state in one plain shape, and the one way both sides turn a tree into bytes. The room's SQL
// rows (tree-sql.ts) and a Mac's copy (tree-memory.ts) both read through TreeAccess, so `materialize` gives byte equal
// JSON exactly when the two states are equal: the fuzz run compares these strings.

import { META_KEYS, type BlobRow, type DocNode, type Json, type PageRow, type TreeAccess } from "./seam.ts";

export const DOC_VALUE_KEYS = ["variables", "themes", "fonts"] as const;
export type DocValueKey = (typeof DOC_VALUE_KEYS)[number];

/** What both trees add to TreeAccess: the document's own top level keys, and every version target. */
export interface RoomTree extends TreeAccess {
  /** The document's top level keys in order. `children`, `variables`, `themes` and `fonts` appear as null
   *  placeholders that mark where they sit; their content comes from the tree. */
  topKeys(): Record<string, Json>;
  allVers(): Record<string, string>;
  blobPaths(): string[];
}

export interface FileState {
  top: Record<string, Json>;
  children: DocNode[];
  doc: Partial<Record<DocValueKey, Json>>;
  widgets: Json[];
  pages: PageRow[] | null;
  meta: Record<string, Json>;
  blobs: Record<string, BlobRow>;
  vers: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const PLACEHOLDERS = new Set<string>(["children", ...DOC_VALUE_KEYS]);

/** Page backgrounds and patterns belong to the local package. Keep every other page field in its original order. */
export function stripPageAppearance(pages: unknown): unknown {
  if (!Array.isArray(pages)) return pages;
  const hasAppearance = (page: unknown): page is Record<string, Json> => isObj(page) && (Object.hasOwn(page, "background") || Object.hasOwn(page, "pattern"));
  if (!pages.some(hasAppearance)) return pages;
  return pages.map((page) => {
    if (!hasAppearance(page)) return page;
    const { background, pattern, ...rest } = page;
    return rest;
  });
}

/** A Canvas document and its sidecar envelope (widgets.json) as a FileState. Pages that are not in the shape page ops
 *  describe ride along as the `pages` meta key. */
export function stateFromFiles(document: Record<string, Json>, envelope: Record<string, Json> = {}): FileState {
  const top: Record<string, Json> = {};
  const doc: FileState["doc"] = {};
  for (const [k, v] of Object.entries(document)) {
    if (PLACEHOLDERS.has(k)) top[k] = null;
    else top[k] = v;
    if ((DOC_VALUE_KEYS as readonly string[]).includes(k)) doc[k as DocValueKey] = v;
  }
  if (!Object.hasOwn(top, "children")) top.children = null;
  const children = Array.isArray(document.children) ? (document.children as DocNode[]) : [];
  const meta: Record<string, Json> = {};
  let pages: PageRow[] | null = null;
  const rawPages = stripPageAppearance(envelope.pages) as Json | undefined;
  if (Array.isArray(rawPages) && rawPages.every((p) => isObj(p) && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.boards) && Object.keys(p).length === 3)) {
    pages = rawPages.map((p) => ({ id: (p as Record<string, Json>).id as string, name: (p as Record<string, Json>).name as string, boards: [...((p as Record<string, Json>).boards as string[])] }));
  } else if (rawPages !== undefined) meta.pages = rawPages;
  for (const k of META_KEYS) if (k !== "pages" && envelope[k] !== undefined) meta[k] = envelope[k];
  return { top, children, doc, widgets: Array.isArray(envelope.widgets) ? envelope.widgets : [], pages, meta, blobs: {}, vers: {} };
}

/** The document a tree holds, as Canvas writes it: the top level keys in their order, new document keys last. */
export function documentOf(tree: RoomTree): Record<string, Json> {
  const top = tree.topKeys();
  const out: Record<string, Json> = {};
  const fill = (k: string) => {
    if (k === "children") out.children = tree.children(null).map((id) => tree.subtree(id) as Json);
    else if ((DOC_VALUE_KEYS as readonly string[]).includes(k)) {
      const v = tree.docValue(k as DocValueKey);
      if (v !== undefined) out[k] = v;
    } else out[k] = top[k];
  };
  for (const k of Object.keys(top)) fill(k);
  for (const k of [...DOC_VALUE_KEYS, "children"]) if (!Object.hasOwn(top, k)) fill(k);
  return out;
}

/** The sidecar envelope a tree holds: the cards in order, the page list, then the meta keys. */
export function envelopeOf(tree: RoomTree): Record<string, Json> {
  const out: Record<string, Json> = { widgets: tree.widgetIds().map((id) => tree.widget(id) ?? null) };
  const pages = tree.pages();
  if (pages) out.pages = pages.map((p) => ({ id: p.id, name: p.name, boards: [...p.boards] }));
  for (const k of META_KEYS) {
    const v = tree.meta(k);
    if (v === undefined) continue;
    if (k === "pages" && pages) continue;
    out[k] = v;
  }
  return out;
}

/** Everything a tree holds, as one canonical string per file: what the fuzz run compares. Blobs and versions count. */
export function materialize(tree: RoomTree): { document: string; widgets: string; blobs: string; vers: string } {
  const blobs: Record<string, BlobRow> = {};
  const vers = tree.allVers();
  return {
    document: JSON.stringify(documentOf(tree)),
    widgets: JSON.stringify(envelopeOf(tree)),
    blobs: JSON.stringify(blobsOf(tree, blobs)),
    vers: JSON.stringify(Object.fromEntries(Object.keys(vers).sort().map((k) => [k, vers[k]]))),
  };
}

function blobsOf(tree: RoomTree, out: Record<string, BlobRow>): Record<string, BlobRow> {
  for (const p of tree.blobPaths().sort()) {
    const b = tree.blob(p);
    if (b) out[p] = { sha256: b.sha256, bytes: b.bytes, type: b.type };
  }
  return out;
}

/** A tree's whole state, for a snapshot. */
export function stateOf(tree: RoomTree, withBoards = true): FileState {
  const doc: FileState["doc"] = {};
  for (const k of DOC_VALUE_KEYS) {
    const v = tree.docValue(k);
    if (v !== undefined) doc[k] = v;
  }
  const meta: Record<string, Json> = {};
  for (const k of META_KEYS) {
    const v = tree.meta(k);
    if (v !== undefined) meta[k] = v;
  }
  const blobs: Record<string, BlobRow> = {};
  for (const p of tree.blobPaths().sort()) blobs[p] = tree.blob(p)!;
  const pages = tree.pages();
  return {
    top: tree.topKeys(),
    children: withBoards ? tree.children(null).map((id) => tree.subtree(id)!) : [],
    doc,
    widgets: tree.widgetIds().map((id) => tree.widget(id) ?? null),
    pages: pages ? pages.map((p) => ({ id: p.id, name: p.name, boards: [...p.boards] })) : null,
    meta,
    blobs,
    vers: tree.allVers(),
  };
}
