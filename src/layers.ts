// The layers panel's outline (apps/macos/Layers.swift): each board's tree of layers, compact, without any
// property the panel does not draw. GET /api/layers answers for the boards the panel shows expanded, skipping
// the ones whose change key the panel already has, and finds where selected layers sit so the panel can open
// their parents. Outlines are worked out once per board object (boardcache.ts): an edit copies the boards it
// touches, so an unchanged board costs nothing.
//
// GET /api/layers?file=&boards=a,b&keys=ka,kb&reveal=x,y
//   -> {revision, boards: [{id, key, tree?}], reveal: {x: {board, path: [board id, ..., parent id]}}}
//   `keys` lines up with `boards`: a board whose key matches comes back without `tree`. A revealed layer's
//   board comes back too (with its tree unless its key was sent).

import type { Snapshot } from "./boards.ts";
import { boardCache } from "./boardcache.ts";
import { buildIndex, expand, findNode, type DocNode } from "./engine.ts";

type Index = ReturnType<typeof buildIndex>;

/** What the row's icon shows. */
export type LayerKind =
  | "frame" | "frameH" | "frameV" | "group" | "text" | "rect" | "ellipse" | "image" | "component" | "instance"
  | "vector" | "line" | "polygon" | "icon" | "note" | "other";

/** One row's worth of a layer: id, name, kind, hidden (enabled false), locked, container (frame or group), first on top, children. */
export type LayerOutline = { i: string; n: string; k: LayerKind; h?: 1; l?: 1; ct?: 1; ft?: 1; c?: LayerOutline[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function hasImageFill(n: DocNode): boolean {
  const f = n.fill as unknown;
  const list = Array.isArray(f) ? f : [f];
  return list.some((x) => isObj(x) && x.type === "image" && x.enabled !== false);
}

/** The icon a layer gets. A frame without `layout` is horizontal (the format's default). */
export function layerKind(n: DocNode): LayerKind {
  if (n.reusable === true) return "component";
  // An instance nested in an instance, expanded: it draws as its component's type but is still an instance.
  if (typeof (n as Record<string, unknown>).__ref === "string") return "instance";
  switch (n.type) {
    case "ref": return "instance";
    case "frame": return n.layout === "none" ? "frame" : n.layout === "vertical" ? "frameV" : "frameH";
    case "group": return "group";
    case "text": return "text";
    case "rectangle": return hasImageFill(n) ? "image" : "rect";
    case "ellipse": return "ellipse";
    case "path": return "vector";
    case "line": return "line";
    case "polygon": return "polygon";
    case "icon_font": case "icon": return "icon";
    case "note": return "note";
    default: return "other";
  }
}

/** The name the panel shows: the layer's own, else a text's first words, else its type. */
export function layerName(n: DocNode): string {
  if (typeof n.name === "string" && n.name.trim()) return n.name;
  if (n.type === "text" && typeof n.content === "string" && n.content.trim()) return n.content.replace(/\s+/g, " ").trim().slice(0, 60);
  const t = String(n.type ?? "layer");
  return t === "ref" ? "Instance" : t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, " ");
}

const outlines = boardCache<{ key: string; o: LayerOutline }>();

/**
 * A node and everything under it. With the document's index, an instance lists what its component draws, under
 * path ids ("instance/child"); inside an instance nothing is a drop target.
 * Without it instances show no children.
 */
export function outlineOf(n: DocNode, index?: Index, inside = false): LayerOutline {
  const o: LayerOutline = { i: String(n.id), n: layerName(n), k: layerKind(n) };
  if (n.enabled === false) o.h = 1;
  if (n.locked === true) o.l = 1;
  if (!inside && (n.type === "frame" || n.type === "group")) o.ct = 1;
  const meta = n.metadata as unknown;
  if (isObj(meta) && isObj(meta.canvasLayout) && meta.canvasLayout.stacking === "first") o.ft = 1;
  let kids: DocNode[] | undefined = n.type !== "ref" && Array.isArray(n.children) ? (n.children as DocNode[]) : undefined;
  if (n.type === "ref" && index && !inside) {
    try { kids = expand(index, n, []).children as DocNode[] | undefined; } catch { kids = undefined; /* a missing or looping component */ }
    inside = true;
  }
  if (kids && kids.length) o.c = kids.filter((k) => isObj(k) && k.id !== undefined).map((k) => outlineOf(k, index, inside));
  return o;
}

/** A board's outline, cached per board object and change key (an instance follows its component's edits). */
export function boardOutline(board: DocNode, key = "", index?: () => Index): LayerOutline {
  const hit = outlines.get(board);
  if (hit && hit.key === key) return hit.o;
  const o = outlineOf(board, index?.());
  outlines.set(board, { key, o });
  return o;
}

/** Where a layer inside an instance sits: the instance's own parents, the instance, then the path ids above it. */
function instancePath(snap: Snapshot, id: string, index: () => Index): string[] | null {
  const inst = id.split("/")[0];
  const f = findNode(snap.doc, inst);
  const chain = [...(f.ancestors as DocNode[]).map((a) => String(a.id)), inst];
  const walk = (n: DocNode, above: string[]): string[] | null => {
    for (const k of (n.children as DocNode[] | undefined) ?? []) {
      if (!isObj(k)) continue;
      if (String(k.id) === id) return above;
      const r = walk(k, [...above, String(k.id)]);
      if (r) return r;
    }
    return null;
  };
  const inner = walk(expand(index(), f.node, []), []);
  return inner ? [...chain, ...inner] : null;
}

const list = (v: string | null, max: number) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean).slice(0, max) : []);

export function layersAnswer(snap: Snapshot, q: URLSearchParams) {
  const ids = list(q.get("boards"), 400);
  const keys = (q.get("keys") ?? "").split(",");
  const known = new Map<string, string>();
  ids.forEach((id, i) => known.set(id, keys[i] ?? ""));
  const reveal: Record<string, { board: string; path: string[] }> = {};
  let idx: Index | undefined;
  const index = () => (idx ??= buildIndex(snap.doc));
  for (const id of list(q.get("reveal"), 200)) {
    try {
      // Inside an instance: the instance's rows open down to the layer.
      const chain = id.includes("/") ? instancePath(snap, id, index) : (findNode(snap.doc, id).ancestors as DocNode[]).map((a) => String(a.id));
      if (!chain) continue;
      const board = chain[0] ?? id;
      reveal[id] = { board, path: chain };
      if (!known.has(board)) { ids.push(board); known.set(board, ""); }
    } catch {
      // gone since: nothing to open
    }
  }
  const byId = new Map(snap.doc.children.filter(isObj).map((n) => [String((n as DocNode).id), n as DocNode]));
  const keyOf = new Map(snap.boards.map((b) => [b.id, b.key]));
  const boards = ids.flatMap((id) => {
    const n = byId.get(id);
    if (!n) return [];
    const key = keyOf.get(id) ?? "";
    return key && known.get(id) === key ? [{ id, key }] : [{ id, key, tree: boardOutline(n, key, index) }];
  });
  return { revision: snap.revision, boards, reveal };
}

/** GET /api/layers (see the top of this file). */
export function handleLayersRoute(url: URL, snap: Snapshot, reply: (v: unknown, status?: number) => void): boolean {
  if (url.pathname !== "/api/layers") return false;
  reply(layersAnswer(snap, url.searchParams));
  return true;
}
