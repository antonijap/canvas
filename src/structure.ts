// Structure edits: delete, duplicate, copy/cut/paste, group, frame selection, ungroup and reorder.
// The person's keys (Backspace, Cmd+D, Cmd+C/X/V, Cmd+G, Opt+Cmd+G, Shift+Cmd+G, Cmd+[ ]) and the MCP's structure
// tools land here through POST /api/structure. Each request is one write and one undo step: every change is made
// on the document through Recorder, which keeps the tree ops (src/history.ts) in the order they happened.
//
// Positions: boards and absolutely placed layers keep numbers in the file. Layers in an auto-layout parent have
// none; for those the page sends `rects` (world rectangles from the renderer) and the server works out where
// they sit. Without rects such a layer counts as being at 0,0 of its parent.
//
// Clipboard: copy returns a payload with the raw subtrees and a detached copy (instances expanded) of each, the
// definitions of the components they use (`mains`) and of the variables they name, and the cards copied with them
// (src/clipcards.ts). Pasting into another file:
//   components  an instance stays an instance. The target's own component is used when it is the same one (same
//               id, draws the same); otherwise the main component comes along, hidden, into the target's holder of
//               components kept off the canvas (the one deleted mains go to), keeping its ids where they are free
//               so a second paste links to it. Like components from another file, it is not on the canvas;
//               it goes once no instance uses it. A payload without the definition (older) pastes detached layers.
//   variables   a variable the target defines the same way stays a token; one it lacks or defines differently
//               becomes the value the source drew (in the layer's theme). The target's tokens never change.
//   images      a relative image file is copied into the target package (same relative path when free or the same
//               bytes, else assets/<name>-<hash>); a loose .canvas.json target gets the file's absolute path.
//   fonts       references only.
// Pasted and duplicated layers get fresh ids from one map, so an instance of a component copied with it uses the
// copy. The server also keeps the last payload (one slot, in memory), so a tab or file in the same server can
// paste even when the system clipboard only holds the marker (see src/page/structure.js).

import { asOneAction } from "./cloud-files-ops.ts";
import { fitAround, groupsAround, turnedBox } from "./groupfit.ts";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { copyableMedia, DESIGN_FILE, inPackage, PACKAGE_EXT, visitRefs } from "./docpath.ts";
import { bareCard, CARD_PREFIX, copyCards, cutCards, isCard, pasteCards } from "./clipcards.ts";
import { WidgetError, type Widget } from "./widgets/types.ts";
import { allIds, buildIndex, defaultTheme, expand, findNode, insertNode, newId, resolveVariable, StaleFileError, unknownKeys, updateNode, ValidationError, type Json, type CanvasDoc, type DocNode } from "./engine.ts";
import { currentDoc, editDoc } from "./docwriter.ts";
import { listPages, settleBoards } from "./pages.ts";
import { joinTop, nodeDiff, placeOf, propsOf, record, replayOps, type Op, type RecordMeta } from "./history.ts";
import { GROUP_MERGE_MS, isGroupMerge } from "./move.ts";
import { readBodyText } from "./body.ts";
import { boardLacks, factsOf } from "./doc/boardindex.ts";
import { addStepFiles, topSeq } from "./history.ts";
import { cardBoxes, pageMates, placeNew, placementNote, topBox, unsizedOnPage, type Placed } from "./placement.ts";
import "./pastefiles.ts"; // undo of a paste takes back the files it copied

type Doc = { children: DocNode[]; variables?: unknown };
export type Rect = { x: number; y: number; w: number; h: number };
export type ReorderDir = "forward" | "backward" | "front" | "back";
export type StructureOp = "delete" | "duplicate" | "group" | "frame" | "ungroup" | "reorder" | "paste" | "copy" | "cut" | "detach" | "add";
export type ClipPayload = {
  kind: "canvas/nodes"; v: 1; source?: string; nodes: DocNode[]; detached: DocNode[]; rects?: (Rect | null)[]; parents?: (string | null)[]; at: number;
  /** Each component the copied layers use (from outside the copy), by id: a fingerprint of what it draws. */
  components?: Record<string, string>;
  /** The definitions of every variable the copied layers name (aliases followed), from the source file. */
  variables?: Record<string, Json>;
  /** The theme each copied layer sat in (the source's default, then its ancestors'). */
  themes?: Theme[];
  /** A cut: pasted in the same file, the layers keep their ids where they are free (a move, not a copy). */
  cut?: boolean;
  /** Every main component the copied layers use (followed through components), by id, when it is not in the copy. */
  mains?: Record<string, DocNode>;
  /** The theme each of `mains` sat in. */
  mainThemes?: Record<string, Theme>;
  /** Cards (widgets, shaders, videos) copied with the layers (src/clipcards.ts). */
  cards?: ClipCard[];
  /** The server's seal (sealPayload): this payload is the one Canvas wrote, so the files it names may come along. */
  sig?: string;
};
/** A card on the clipboard: the widget as it showed, plus what lives beside it (a shader's source, a video's file). */
export type ClipCard = {
  id: string; kind: string; name: string; x: number; y: number; w: number; h: number; locked?: boolean;
  config: Record<string, unknown>;
  /** A shader card's WGSL. */
  source?: string;
  /** A video card's file, absolute. */
  file?: string;
};
type Theme = Record<string, string>;
/** Where pasted layers go: a parent (null: the document), an index (default: the end) and per-node positions.
 *  cards: where each pasted card goes on the canvas (null: where it was copied). */
export type PastePlace = { parent: string | null; index?: number; positions?: ({ x: number; y: number } | null)[]; cards?: ({ x: number; y: number } | null)[] };

export const BOARD_GAP = 40;
/** How far a duplicated or pasted layer lands from its original in the same frame: 0, in place on top. */
export const NUDGE = 0;

export class StructureError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const invalid = (m: string) => new StructureError(400, "invalid", m);

const clone = <T>(v: T): T => structuredClone(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Every change made on the document, as ops in the order they happened. */
export class Recorder {
  ops: Op[] = [];
  doc: Doc;
  constructor(doc: Doc) {
    this.doc = doc;
  }
  kids(parent: string | null): DocNode[] {
    if (parent === null) return this.doc.children;
    const p = findNode(this.doc as any, parent).node;
    if (p.type !== "frame" && p.type !== "group") throw invalid(`"${parent}" is a ${p.type}; only frames and groups hold layers`);
    if (!Array.isArray(p.children)) p.children = [];
    return p.children as DocNode[];
  }
  insert(parent: string | null, index: number, node: DocNode) {
    const list = this.kids(parent);
    const at = Math.max(0, Math.min(index, list.length));
    list.splice(at, 0, node);
    this.ops.push({ t: "tree", kind: "insert", parent, index: at, node: clone(node) });
  }
  remove(id: string) {
    const p = placeOf(this.doc, id)!;
    p.list.splice(p.index, 1);
    this.ops.push({ t: "tree", kind: "remove", parent: p.parent, index: p.index, node: clone(p.node) });
  }
  move(id: string, parent: string | null, index: number) {
    const p = placeOf(this.doc, id)!;
    p.list.splice(p.index, 1);
    const list = this.kids(parent);
    const at = Math.max(0, Math.min(index, list.length));
    list.splice(at, 0, p.node);
    if (p.parent !== parent || p.index !== at) this.ops.push({ t: "move", id, b: { parent: p.parent, index: p.index }, a: { parent, index: at } });
  }
  props(id: string, set: Record<string, Json>, remove: string[] = []) {
    const n = findNode(this.doc as any, id).node;
    const before = propsOf(n);
    updateNode(this.doc as any, id, set, remove);
    const op = nodeDiff(id, before, propsOf(n));
    if (Object.keys(op.props).length) this.ops.push(op);
  }
}

// ---------- helpers ----------

const isContainer = (n: DocNode | undefined) => !!n && (n.type === "frame" || n.type === "group");
/** True when the parent lays its children out itself (auto layout), so they carry no position of their own. */
export function placesChildren(parent: DocNode | null): boolean {
  // A frame without a layout lays out horizontally (as in src/move.ts); groups and the document never do.
  return !!parent && parent.type === "frame" && (typeof parent.layout === "string" ? parent.layout : "horizontal") !== "none";
}
const absoluteIn = (parent: DocNode | null, n: DocNode) => !parent || !placesChildren(parent) || n.layoutPosition === "absolute";

/** A layer's name for messages: an instance layer ("Inst/Child") by its own name, else its id in quotes. */
export function layerName(doc: Doc, id: string): string {
  const last = id.split("/").pop() ?? id;
  const seek = (list: DocNode[]): DocNode | undefined => {
    for (const n of list) {
      if (String(n.id) === last) return n;
      const h = seek((n.children as DocNode[] | undefined) ?? []);
      if (h) return h;
    }
    return undefined;
  };
  const n = seek(doc.children);
  return typeof n?.name === "string" && n.name ? n.name : `"${last}"`;
}

/** The selected ids that exist, without any whose ancestor is selected too, in document order. */
export function normalize(doc: Doc, ids: string[], what: string): string[] {
  if (!Array.isArray(ids) || !ids.length) throw invalid("ids is required");
  const want = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id) throw invalid("ids must be node ids");
    if (id.startsWith("widget:")) continue;
    if (id.includes("/")) throw new StructureError(400, "instance", `${layerName(doc, id)} lives inside a component instance; ${what} the instance, or edit the component`);
    if (!placeOf(doc, id)) throw new StructureError(404, "not_found", `no node "${id}"`);
    want.add(id);
  }
  const out: string[] = [];
  const visit = (list: DocNode[], inside: boolean) => {
    for (const n of list) {
      const hit = !inside && want.has(String(n.id));
      if (hit) out.push(String(n.id));
      if (Array.isArray(n.children)) visit(n.children as DocNode[], inside || hit);
    }
  };
  // Boards of an adopted version that hold none of the ids are not walked (boardindex.ts).
  for (const b of doc.children) if (!boardLacks(b, want)) visit([b], false);
  if (!out.length) throw invalid("nothing to change: the selection holds no layers");
  return out;
}

/**
 * Fresh ids for subtrees copied together (instance paths and clashes included), without render-only keys. One id
 * map covers them all: an instance whose component was copied with it uses the copy, and its override paths
 * ("child", "nested/child") name the copy's layers. `index` finds the original layers a path walks through.
 */
function freshCopies(nodes: DocNode[], taken: Set<string>, index: Map<string, DocNode>, keep: Set<string> = new Set()): DocNode[] {
  const map = new Map<string, string>();
  for (const k of keep) taken.add(k);
  const copies = nodes.map((node) => {
    const c = clone(node);
    const visit = (n: DocNode) => {
      delete (n as Record<string, unknown>).__ref;
      const id = typeof n.id === "string" && keep.has(n.id) ? n.id : newId(taken);
      if (typeof n.id === "string" && n.id) map.set(n.id, id);
      n.id = id;
      for (const k of (n.children as DocNode[] | undefined) ?? []) visit(k);
    };
    visit(c);
    return c;
  });
  if (!map.size) return copies;
  // An override path: each segment but the last is an instance; a segment is renamed while the component it lives in is a copy.
  // `swaps`: nested instances the overrides swap (src/overrides.ts), by path; below one, its new component counts.
  const remapPath = (component: string, path: string, swaps: Map<string, string>): string => {
    let copied = map.has(component);
    const segs = path.split("/");
    return segs.map((seg, i) => {
      const out = copied ? (map.get(seg) ?? seg) : seg;
      const n = index.get(seg), swapped = swaps.get(segs.slice(0, i + 1).join("/"));
      if (swapped) copied = map.has(swapped);
      else if (n?.type === "ref" && typeof n.ref === "string") copied = map.has(n.ref);
      return out;
    }).join("/");
  };
  const fix = (n: DocNode) => {
    // An instance, or an override that swaps a nested one (a ref without a type).
    if ((n.type === "ref" || !n.type) && typeof n.ref === "string") {
      const target = n.ref;
      if (map.has(target)) n.ref = map.get(target)!;
      const d = n.descendants as Record<string, DocNode> | undefined;
      if (d && typeof d === "object" && !Array.isArray(d)) {
        const out: Record<string, DocNode> = {};
        const swaps = new Map<string, string>();
        for (const [k, v] of Object.entries(d)) if (v && typeof v === "object" && !v.type && typeof v.ref === "string") swaps.set(k, v.ref);
        for (const [k, v] of Object.entries(d)) {
          if (v && typeof v === "object" && !Array.isArray(v)) fix(v);
          out[remapPath(target, k, swaps)] = v;
        }
        n.descendants = out as unknown as Json;
      }
    }
    for (const k of (n.children as DocNode[] | undefined) ?? []) fix(k);
  };
  copies.forEach(fix);
  return copies;
}

/** A node's box in its parent's coordinates: numbers from the file, else from the page's world rects. */
export function boxOf(doc: Doc, id: string, rects: Record<string, Rect> = {}): Rect {
  const p = placeOf(doc, id)!;
  const n = p.node;
  const r = rects[id];
  const parentRect = p.parent ? rects[p.parent] : undefined;
  let x = num(n.x), y = num(n.y);
  const parentNode = p.parent ? findNode(doc as any, p.parent).node : null;
  if (!absoluteIn(parentNode, n) || x === undefined || y === undefined) {
    if (r && (parentRect || !p.parent)) {
      x = r.x - (parentRect?.x ?? 0);
      y = r.y - (parentRect?.y ?? 0);
    }
  }
  const w = num(n.width) ?? r?.w ?? 0, h = num(n.height) ?? r?.h ?? 0;
  return { x: x ?? 0, y: y ?? 0, w, h };
}
export const union = (rs: Rect[]): Rect => {
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Ids of components (reusable nodes) a subtree uses through instances, including overrides. */
function refsIn(n: DocNode, out = new Set<string>()): Set<string> {
  if ((n.type === "ref" || !n.type) && typeof n.ref === "string") out.add(n.ref);
  for (const c of (n.children as DocNode[] | undefined) ?? []) refsIn(c, out);
  for (const d of Object.values((n.descendants as Record<string, DocNode> | undefined) ?? {})) if (d && typeof d === "object") refsIn(d, out);
  return out;
}

/** Instances outside the removed ids that use a component inside them (the engine's delete rule, for a set). */
function usersOf(doc: Doc, removed: Set<string>): string[] {
  const users: string[] = [];
  const look = (n: DocNode, label: string, gone: boolean) => {
    const out = gone || removed.has(String(n.id));
    if (typeof n.ref === "string" && removed.has(n.ref) && !out) users.push(label);
    for (const c of (n.children as DocNode[] | undefined) ?? []) look(c, String(c.id), out);
    for (const [key, d] of Object.entries((n.descendants as Record<string, DocNode>) ?? {})) if (d && typeof d === "object") look(d, `${label}/${key}`, out);
  };
  for (const c of doc.children) look(c, String(c.id), false);
  return users;
}
const subtreeIds = (n: DocNode, out = new Set<string>()) => {
  if (typeof n.id === "string") out.add(n.id);
  for (const c of (n.children as DocNode[] | undefined) ?? []) subtreeIds(c, out);
  return out;
};

// ---------- components: instances for copies, cycles, deleted main components ----------

/**
 * The copy rule inside one file: a copied, pasted, duplicated or Option-dragged main component becomes an
 * instance of it (copy/paste and Cmd+D of a component in
 * the same file create an instance). Main components nested in the copied layers do too. A copy keeps only where it
 * sits (x, y, absolute placement, rotation); the rest comes from the main. Ids of a cut that nothing holds now are
 * kept (`keep`), so a cut and paste moves the layers and a cut main component stays the main its instances use;
 * one the cut parked in the deleted components holder comes back from there (`unpark`).
 */
function sameFileCopy(n: DocNode, index: Map<string, DocNode>, cut?: { held: Set<string>; keep: Set<string>; unpark: Set<string> }): DocNode {
  const id = typeof n.id === "string" ? n.id : "";
  if (cut && id) {
    if (!index.has(id)) cut.keep.add(id);
    else if (cut.held.has(id)) { cut.keep.add(id); cut.unpark.add(id); }
  }
  if (n.reusable === true && id && !cut?.keep.has(id) && index.get(id)?.reusable === true) {
    const inst: DocNode = { type: "ref", ref: id } as DocNode;
    for (const k of ["x", "y", "layoutPosition", "rotation"]) if (n[k] !== undefined) (inst as Record<string, Json>)[k] = clone(n[k]) as Json;
    return inst;
  }
  if (!Array.isArray(n.children)) return n;
  return { ...n, children: (n.children as DocNode[]).map((c) => sameFileCopy(c, index, cut)) } as DocNode;
}

/** Components a set of layers uses through instances, followed through each component's own layers. */
function componentsUsed(doc: Doc, nodes: DocNode[]): Set<string> {
  const index = buildIndex(doc as any);
  const out = new Set<string>();
  const todo: DocNode[] = [...nodes];
  const scan = (n: DocNode) => {
    if ((n.type === "ref" || !n.type) && typeof n.ref === "string" && !out.has(n.ref)) {
      out.add(n.ref);
      const c = index.get(n.ref);
      if (c) todo.push(c);
    }
    for (const c of (n.children as DocNode[] | undefined) ?? []) scan(c);
    for (const d of Object.values((n.descendants as Record<string, DocNode> | undefined) ?? {})) if (d && typeof d === "object") scan(d);
  };
  while (todo.length) scan(todo.pop()!);
  return out;
}

/** An instance inside its own component (or a component it uses) would draw itself forever: refuse (409 cycle). */
export function assertNoCycle(doc: Doc, ids: string[], what: string): void {
  for (const id of ids) {
    let f;
    try { f = findNode(doc as any, id); } catch { continue; }
    const chain = [f.node, ...f.ancestors] as DocNode[];
    const owners = chain.filter((n) => n.reusable === true);
    if (!owners.length) continue;
    const uses = componentsUsed(doc, [f.node]);
    const loop = owners.find((n) => uses.has(String(n.id)));
    if (loop) throw new StructureError(409, "cycle", `${String(loop.name ?? loop.id)} is a component the ${what} layers use; an instance cannot go inside its own component`);
  }
}

/** Canvas's marker on the hidden top-level frame that keeps deleted main components their instances still use. */
export const DELETED_KEY = "canvasDeletedComponents";
export const isDeletedHolder = (n: DocNode | undefined): boolean => !!n && typeof n.metadata === "object" && n.metadata !== null && (n.metadata as Record<string, unknown>)[DELETED_KEY] === true;
export const deletedHolder = (doc: Doc): DocNode | undefined => doc.children.find((n) => isDeletedHolder(n));

/** Every component id an instance in these layers (overrides included) names. */
function refsOf(n: DocNode, out: string[]): void {
  if ((n.type === "ref" || !n.type) && typeof n.ref === "string") out.push(n.ref);
  for (const c of (n.children as DocNode[] | undefined) ?? []) refsOf(c, out);
  for (const d of Object.values((n.descendants as Record<string, DocNode> | undefined) ?? {})) if (d && typeof d === "object") refsOf(d, out);
}

/**
 * The main components inside the layers being deleted that instances outside them still use, outermost only.
 * A parked component keeps its own layers, so what they use is not lost either.
 */
function mainsToPark(doc: Doc, list: string[]): string[] {
  const index = buildIndex(doc as any);
  const park = new Set<string>();
  for (let round = 0; round < 50; round++) {
    const gone = new Set<string>();
    const mark = (n: DocNode) => {
      if (park.has(String(n.id))) return;
      gone.add(String(n.id));
      for (const c of (n.children as DocNode[] | undefined) ?? []) mark(c);
    };
    for (const id of list) mark(placeOf(doc, id)!.node);
    // Nothing deleted is a main component: no instance can need one parked (the common case: no walk at all).
    if (round === 0 && ![...gone].some((id) => index.get(id)?.reusable === true)) break;
    const need: string[] = [];
    const look = (n: DocNode) => {
      if (!gone.has(String(n.id))) {
        const refs: string[] = [];
        if (n.type === "ref" && typeof n.ref === "string") refs.push(n.ref);
        for (const d of Object.values((n.descendants as Record<string, DocNode> | undefined) ?? {})) if (d && typeof d === "object") refsOf(d, refs);
        for (const r of refs) if (gone.has(r) && index.get(r)?.reusable === true) need.push(r);
      }
      for (const c of (n.children as DocNode[] | undefined) ?? []) look(c);
    };
    for (const top of doc.children) {
      // A board of an adopted version whose instances name none of the deleted components is not walked.
      const f = factsOf(top);
      if (f && !gone.has(String(top.id)) && !f.refs.some((r) => gone.has(r))) continue;
      look(top);
    }
    if (!need.length) break;
    need.forEach((r) => park.add(r));
  }
  // Outermost only: one inside another parked component goes along with it.
  return [...park].filter((id) => !findNode(doc as any, id).ancestors.some((a: DocNode) => park.has(String(a.id))));
}

/** Deleted main components that nothing outside the holder uses any more go for good; an empty holder goes too. */
function purgeHolder(doc: Doc, rec: Recorder, alsoUsedBy: DocNode[] = []): void {
  const h = deletedHolder(doc);
  if (!h) return;
  const hid = String(h.id);
  const held = new Map(((h.children as DocNode[] | undefined) ?? []).map((n) => [String(n.id), n]));
  const needed = new Set<string>();
  const outside: string[] = [];
  for (const n of alsoUsedBy) refsOf(n, outside);
  for (const top of doc.children) {
    if (String(top.id) === hid) continue;
    const f = factsOf(top);
    if (f) outside.push(...f.refs);
    else refsOf(top, outside);
  }
  // A component used from outside is needed; so is every component inside it that it uses in turn.
  const todo = [...outside];
  const inHeld = new Map<string, string>();
  for (const [id, n] of held) for (const x of subtreeIds(n)) inHeld.set(x, id);
  while (todo.length) {
    const r = todo.pop()!;
    const owner = inHeld.get(r);
    if (!owner || needed.has(owner)) continue;
    needed.add(owner);
    refsOf(held.get(owner)!, todo);
  }
  for (const id of held.keys()) if (!needed.has(id)) rec.remove(id);
  if (!((h.children as DocNode[] | undefined) ?? []).length) rec.remove(hid);
}

// ---------- the operations (pure: they change `doc` and say what to select) ----------

export type OpResult = { label: string; select: string[]; ops: Op[]; payload?: ClipPayload };

/**
 * Delete: the next sibling is selected after, or the parent when none follows; boards leave nothing selected.
 * `cut`: the layers go to the clipboard, so a parked component they use stays parked for their paste.
 */
export function deleteNodes(doc: Doc, ids: string[], cut = false): OpResult {
  const list = normalize(doc, ids, "delete");
  const holder = deletedHolder(doc);
  if (holder && list.includes(String(holder.id))) {
    const removed = new Set<string>();
    for (const id of list) subtreeIds(placeOf(doc, id)!.node, removed);
    const users = usersOf(doc, removed);
    if (users.length) throw new StructureError(409, "component_in_use", `the deleted components are still used by ${users.length} instance(s); delete or detach those first`);
  }
  // A main component with instances elsewhere can be deleted, and its instances keep drawing. Canvas keeps
  // its definition, hidden, in a "Deleted components" frame at the end of the file (a hidden top-level frame,
  // so any reader of the file still draws the instances); it goes for good once nothing uses it.
  const park = mainsToPark(doc, list);
  const first = placeOf(doc, list[0])!;
  const rec = new Recorder(doc);
  if (park.length) {
    let h = deletedHolder(doc);
    if (!h) {
      const taken = allIds(doc as any);
      h = { type: "frame", id: newId(taken), name: "Deleted components", enabled: false, layout: "none", x: 0, y: 0, width: 100, height: 100, clip: true, metadata: { type: "canvas", [DELETED_KEY]: true }, children: [] } as unknown as DocNode;
      rec.insert(null, doc.children.length, h);
    }
    for (const id of park) rec.move(id, String(h.id), ((h.children as DocNode[] | undefined) ?? []).length);
  }
  const parked = new Set(park);
  // Higher indexes first, so each removal's index is still right when undo puts them back in reverse.
  const order = list.filter((id) => !parked.has(id)).map((id) => ({ id, p: placeOf(doc, id)! })).sort((a, b) => (a.p.parent === b.p.parent ? b.p.index - a.p.index : 0));
  const gone = cut ? order.map(({ p }) => p.node) : [];
  for (const { id } of order) rec.remove(id);
  purgeHolder(doc, rec, gone);
  // The groups that lost layers fit the rest (groupfit.ts); one left empty goes.
  const emptied = new Set(fitAround(doc, order.map(({ p }) => p.parent), (id, p) => rec.props(id, p), (id) => rec.remove(id)));
  let select: string[] = [];
  if (first.parent !== null && !emptied.has(first.parent)) {
    const kids = rec.kids(first.parent);
    const next = kids[Math.min(first.index, kids.length - 1)];
    select = [next ? String(next.id) : first.parent];
  }
  return { label: "Delete", select, ops: rec.ops };
}

/** Where duplicates go. offset: each copy sits at its original moved by (dx, dy) (Option-drag, the repeated Cmd+D);
 *  exact: on top of its original (a copy that a place moves next). Neither: Cmd+D's spots. */
export type DuplicateOpts = { offset?: { dx: number; dy: number }; exact?: boolean; round?: boolean };

/**
 * Duplicate. Default (Cmd+D): boards go to the right of the selection with a gap, layers in auto layout right after
 * themselves, others in place on top of their original (a repeated Cmd+D uses the last offset). With opts.offset every board and absolutely placed layer lands at its
 * original plus the offset (flow layers still right after themselves). `copies` maps each original to its copy.
 */
export function duplicateNodes(doc: Doc, ids: string[], rects: Record<string, Rect> = {}, opts: DuplicateOpts = {}): OpResult & { copies: Map<string, string> } {
  const list = normalize(doc, ids, "duplicate");
  const taken = allIds(doc as any);
  const rec = new Recorder(doc);
  const off = opts.offset && Number.isFinite(opts.offset.dx) && Number.isFinite(opts.offset.dy) ? opts.offset : null;
  const fix = (v: number) => (opts.round ? Math.round(v) : Math.round(v * 100) / 100);
  const boards = list.filter((id) => placeOf(doc, id)!.parent === null);
  let shift = 0;
  if (boards.length && !off && !opts.exact) {
    // A board that hugs its content has no size in the file: the page's rect, else an estimate (a 0 wide board
    // put its copy 40 px right, on top of itself).
    const index = buildIndex(doc as any);
    const sized = (id: string) => {
      const b = boxOf(doc, id, rects);
      if (b.w > 0 && b.h > 0) return b;
      const e = topBox(placeOf(doc, id)!.node, rects[id], index);
      return { ...b, w: b.w || e.w, h: b.h || e.h };
    };
    const u = union(boards.map(sized));
    const others = doc.children.filter((n) => !boards.includes(String(n.id)) && n.enabled !== false).map((n) => sized(String(n.id)));
    shift = u.w + BOARD_GAP;
    // Move further right until the copies land on empty canvas (at most 50 tries).
    for (let i = 0; i < 50 && others.some((o) => overlaps({ ...u, x: u.x + shift }, o)); i++) shift += u.w + BOARD_GAP;
  }
  const made: string[] = [];
  const copiesOf = new Map<string, string>();
  // Last first within a parent, so every copy lands right after its original.
  const order = list.map((id) => ({ id, p: placeOf(doc, id)! })).sort((a, b) => (a.p.parent === b.p.parent ? b.p.index - a.p.index : 0));
  // One id map for the whole selection: a copied instance of a copied component uses the copy.
  const index = buildIndex(doc as any);
  const copies = freshCopies(order.map(({ p }) => sameFileCopy(p.node, index)), taken, index);
  for (const [k, { id, p }] of order.entries()) {
    const copy = copies[k];
    const parent = p.parent ? findNode(doc as any, p.parent).node : null;
    if (!p.parent) {
      const b = boxOf(doc, id, rects);
      if (off) { copy.x = fix(b.x + off.dx); copy.y = fix(b.y + off.dy); }
      else if (opts.exact) { copy.x = b.x; copy.y = b.y; }
      else { copy.x = Math.round((b.x + shift) * 100) / 100; copy.y = b.y; }
    } else if (absoluteIn(parent, p.node)) {
      if (off) { copy.x = fix((num(p.node.x) ?? 0) + off.dx); copy.y = fix((num(p.node.y) ?? 0) + off.dy); }
      else if (!opts.exact) { copy.x = (num(p.node.x) ?? 0) + NUDGE; copy.y = (num(p.node.y) ?? 0) + NUDGE; }
    }
    rec.insert(p.parent, p.index + 1, copy);
    made.unshift(String(copy.id));
    copiesOf.set(id, String(copy.id));
  }
  // The copies in the order the ids came in (what a caller lines up with its own list).
  const select = list.map((id) => copiesOf.get(id)!).filter(Boolean);
  assertNoCycle(doc, made, "duplicated");
  return { label: "Duplicate", select: select.length === made.length ? select : made, ops: rec.ops, copies: copiesOf };
}

/**
 * Detach instance (Opt+Cmd+B): each selected instance becomes the plain layers it draws, overrides
 * applied, under its own id (the selection stays). Its children get fresh ids. Layers that are not instances are
 * left as they are; none at all is an error.
 */
export function detachNodes(doc: Doc, ids: string[]): OpResult {
  const list = normalize(doc, ids, "detach");
  const refs = list.filter((id) => placeOf(doc, id)!.node.type === "ref");
  if (!refs.length) throw invalid("select an instance to detach");
  const index = buildIndex(doc as any);
  const taken = allIds(doc as any);
  const rec = new Recorder(doc);
  for (const id of refs) {
    const p = placeOf(doc, id)!;
    const flat = stripRender(expand(index as any, p.node));
    const [c] = freshCopies([flat], taken, index);
    c.id = id;
    delete (c as Record<string, unknown>).reusable;
    rec.remove(id);
    rec.insert(p.parent, p.index, c);
  }
  return { label: "Detach Instance", select: refs, ops: rec.ops };
}

/** Group (Cmd+G) or frame the selection (Opt+Cmd+G). Layers must share a parent. */
export function groupNodes(doc: Doc, ids: string[], rects: Record<string, Rect> = {}, asFrame = false): OpResult {
  const list = normalize(doc, ids, "group");
  const places = list.map((id) => ({ id, p: placeOf(doc, id)! }));
  const parent = places[0].p.parent;
  if (places.some((x) => x.p.parent !== parent)) throw invalid("select layers that share one parent to group them");
  const parentNode = parent ? findNode(doc as any, parent).node : null;
  if (parentNode?.type === "ref") throw new StructureError(400, "instance", "layers inside an instance cannot be grouped");
  places.sort((a, b) => a.p.index - b.p.index);
  const boxes = new Map(places.map(({ id }) => [id, boxOf(doc, id, rects)]));
  // The box each layer covers as drawn: a turned or flipped layer reaches away from its stored corner (the box wraps that).
  const u = union(places.map(({ id, p }) => {
    const b = boxes.get(id)!, t = turnedBox(p.node, b.x, b.y, b.w, b.h);
    return { x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0 };
  }));
  const r2 = (v: number) => Math.round(v * 100) / 100;
  for (const k of ["x", "y", "w", "h"] as const) u[k] = r2(u[k]);
  const taken = allIds(doc as any);
  const shell: DocNode = asFrame
    ? { type: "frame", id: newId(taken), name: nextName(doc, "Frame"), layout: "none", width: u.w, height: u.h, children: [] }
    : { type: "group", id: newId(taken), name: nextName(doc, "Group"), children: [] };
  // Where the group sits: its own x/y in a parent that does not place children; auto layout places it, unless
  // every grouped layer was absolutely placed there: then the group is too, where they were (not pulled into the flow).
  if (!placesChildren(parentNode)) Object.assign(shell, { x: u.x, y: u.y });
  else if (places.every(({ p }) => p.node.layoutPosition === "absolute")) Object.assign(shell, { x: u.x, y: u.y, layoutPosition: "absolute" });
  const rec = new Recorder(doc);
  const top = places[places.length - 1].p.index;
  rec.insert(parent, top + 1, shell);
  const gid = String(shell.id);
  places.forEach(({ id }, k) => {
    rec.move(id, gid, k);
    const b = boxes.get(id)!;
    const n = findNode(doc as any, id).node;
    const set: Record<string, Json> = { x: r2(b.x - u.x), y: r2(b.y - u.y) };
    // A group has no size to fill: a filling layer keeps the size it was drawn at.
    if (typeof n.width === "string" && n.width === "fill_container" && b.w) set.width = b.w;
    if (typeof n.height === "string" && n.height === "fill_container" && b.h) set.height = b.h;
    rec.props(id, set, n.layoutPosition === "absolute" ? ["layoutPosition"] : []);
  });
  return { label: asFrame ? "Frame Selection" : "Group Selection", select: [gid], ops: rec.ops };
}

/** Ungroup (Shift+Cmd+G): groups and frames give their layers to their parent, in place on the canvas. */
export function ungroupNodes(doc: Doc, ids: string[], rects: Record<string, Rect> = {}): OpResult {
  const list = normalize(doc, ids, "ungroup").filter((id) => isContainer(placeOf(doc, id)!.node));
  if (!list.length) throw invalid("select a group or a frame to ungroup");
  const rec = new Recorder(doc);
  const select: string[] = [];
  for (const gid of list) {
    const g = placeOf(doc, gid)!;
    if (g.node.reusable === true) throw new StructureError(400, "component", `${String(g.node.name ?? gid)} is a component; ungrouping it would break its instances`);
    const parentNode = g.parent ? findNode(doc as any, g.parent).node : null;
    const gb = boxOf(doc, gid, rects);
    const kids = [...((g.node.children as DocNode[] | undefined) ?? [])];
    // The wrapper's own transform (rotate(-r) and flips about its top-left, engine/src/layout.rs local_transform)
    // goes onto each layer: position, rotation and flips composed, so nothing turns or jumps.
    const gr = num(g.node.rotation) ?? 0, gfx = g.node.flipX === true, gfy = g.node.flipY === true;
    const turned = gr !== 0 || gfx || gfy;
    const a = (-gr * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    // The group was absolutely placed in an auto-layout parent (groupNodes moved that onto it): its layers are too.
    const absWrapper = placesChildren(parentNode) && g.node.layoutPosition === "absolute";
    kids.forEach((c, k) => {
      const cid = String(c.id);
      // The layer's place inside the group, then on the group's parent.
      let cx = num(c.x), cy = num(c.y);
      const inFlow = placesChildren(g.node) && c.layoutPosition !== "absolute";
      if (inFlow) {
        const r = rects[cid], grc = rects[gid];
        cx = r && grc ? r.x - grc.x : 0;
        cy = r && grc ? r.y - grc.y : 0;
      }
      rec.move(cid, g.parent, g.index + 1 + k);
      const set: Record<string, Json> = {};
      const drop: string[] = [];
      // A size that filled the old parent keeps the size it was drawn at: under another parent it would fill that one.
      const r = rects[cid];
      for (const [dim, rd] of [["width", r?.w], ["height", r?.h]] as const) {
        if (typeof c[dim] !== "string" || !String(c[dim]).startsWith("fill_container")) continue;
        const fixed = rd ?? (g.node.type === "frame" && !placesChildren(g.node) ? num(g.node[dim]) : undefined);
        if (fixed !== undefined && fixed > 0) set[dim] = r2(fixed);
      }
      if (turned) {
        const lx = gfx ? -(cx ?? 0) : cx ?? 0, ly = gfy ? -(cy ?? 0) : cy ?? 0;
        cx = cos * lx - sin * ly;
        cy = sin * lx + cos * ly;
        // Exactly one flip mirrors the layer's own turn.
        const sign = gfx !== gfy ? -1 : 1;
        const rot = (((gr + sign * (num(c.rotation) ?? 0)) % 360) + 360) % 360;
        if (rot) set.rotation = r2(rot);
        else if ("rotation" in c) drop.push("rotation");
        const fx = gfx !== (c.flipX === true), fy = gfy !== (c.flipY === true);
        if (fx) set.flipX = true; else if ("flipX" in c) drop.push("flipX");
        if (fy) set.flipY = true; else if ("flipY" in c) drop.push("flipY");
      }
      // Auto layout places them: the x/y they had inside the group would only be noise there.
      // An absolutely placed layer stays absolute in an auto-layout parent: it moves by the group's offset too.
      if (!placesChildren(parentNode) || c.layoutPosition === "absolute" || absWrapper) {
        set.x = turned ? r2(gb.x + (cx ?? 0)) : gb.x + (cx ?? 0);
        set.y = turned ? r2(gb.y + (cy ?? 0)) : gb.y + (cy ?? 0);
        if (absWrapper) set.layoutPosition = "absolute";
      } else drop.push(...["x", "y"].filter((k) => k in c));
      rec.props(cid, set, drop);
      select.push(cid);
    });
    rec.remove(gid);
  }
  return { label: "Ungroup", select, ops: rec.ops };
}

/** Cmd+] / Cmd+[ move one step up or down the stack; Opt adds: to the very front or back. Selected layers never pass each other. */
export function reorderNodes(doc: Doc, ids: string[], dir: ReorderDir): OpResult {
  if (!["forward", "backward", "front", "back"].includes(dir)) throw invalid("dir is forward, backward, front or back");
  const list = normalize(doc, ids, "reorder");
  const rec = new Recorder(doc);
  const byParent = new Map<string | null, string[]>();
  for (const id of list) {
    const p = placeOf(doc, id)!.parent;
    byParent.set(p, [...(byParent.get(p) ?? []), id]);
  }
  for (const [parent, group] of byParent) {
    const kids = () => rec.kids(parent);
    const idx = (id: string) => kids().findIndex((n) => String(n.id) === id);
    const sel = new Set(group);
    const sorted = [...group].sort((a, b) => idx(a) - idx(b));
    if (dir === "front") sorted.forEach((id) => rec.move(id, parent, kids().length - 1));
    else if (dir === "back") [...sorted].reverse().forEach((id) => rec.move(id, parent, 0));
    else if (dir === "forward") {
      for (const id of [...sorted].reverse()) {
        const i = idx(id), next = kids()[i + 1];
        if (next && !sel.has(String(next.id))) rec.move(id, parent, i + 1);
      }
    } else {
      for (const id of sorted) {
        const i = idx(id), prev = kids()[i - 1];
        if (prev && !sel.has(String(prev.id))) rec.move(id, parent, i - 1);
      }
    }
  }
  const label = { forward: "Bring Forward", backward: "Send Backward", front: "Bring to Front", back: "Send to Back" }[dir];
  return { label, select: list, ops: rec.ops };
}

/** The clipboard payload for the selection. Instance layers ("Ins/Child") copy as detached layers. */
export function copyNodes(doc: Doc, ids: string[], rects: Record<string, Rect> = {}, source?: string): ClipPayload {
  if (!Array.isArray(ids) || !ids.length) throw invalid("ids is required");
  const index = buildIndex(doc as any);
  const nodes: DocNode[] = [], detached: DocNode[] = [], rs: (Rect | null)[] = [], parents: (string | null)[] = [];
  const plain = ids.filter((id) => typeof id === "string" && !id.startsWith("widget:"));
  const top = plain.filter((id) => !id.includes("/"));
  const ordered = top.length ? normalize(doc, top, "copy") : [];
  for (const id of ordered) {
    const p = placeOf(doc, id)!;
    nodes.push(clone(p.node));
    detached.push(stripRender(expand(index, p.node)));
    rs.push(rects[id] ?? null);
    parents.push(p.parent);
  }
  for (const path of plain.filter((id) => id.includes("/"))) {
    const hit = seekExpanded(doc, index, path);
    if (!hit) throw new StructureError(404, "not_found", `no node "${path}"`);
    const d = stripRender(hit);
    nodes.push(d);
    detached.push(d);
    rs.push(rects[path] ?? null);
    parents.push(path.split("/")[0]);
  }
  if (!nodes.length) throw invalid("nothing to copy: the selection holds no layers");
  // What another file needs to tell whether its components and variables are the ones these layers used.
  const inside = new Set<string>();
  for (const n of nodes) subtreeIds(n, inside);
  const components: Record<string, string> = {};
  const mains: Record<string, DocNode> = {};
  const mainThemes: Record<string, Theme> = {};
  // Every component the layers use, followed through the components themselves (another file needs them all).
  for (const r of componentsUsed(doc, nodes)) {
    if (inside.has(r)) continue;
    const c = index.get(r);
    if (!c || c.reusable !== true) continue;
    components[r] = componentPrint(index, c);
    mains[r] = stripRender(c);
    mainThemes[r] = themeAt(doc as CanvasDoc, r);
  }
  const variables = usedVariables(doc as CanvasDoc, [...nodes, ...detached, ...Object.values(mains)]);
  const themes = [...ordered, ...plain.filter((id) => id.includes("/"))].map((id) => themeAt(doc as CanvasDoc, id));
  return { kind: "canvas/nodes", v: 1, source, nodes, detached, rects: rs, parents, at: Date.now(), components, variables, themes, mains, mainThemes };
}

/** A payload with no layers, for cards copied on their own (their list is added by the caller). */
export function emptyPayload(source: string, cut = false): ClipPayload {
  return { kind: "canvas/nodes", v: 1, source, nodes: [], detached: [], rects: [], parents: [], at: Date.now(), ...(cut ? { cut: true } : {}) };
}

/** JSON with sorted keys: equal values give equal text. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
/** What a component draws, nested components included; where it sits on the canvas does not count. */
function componentPrint(index: Map<string, DocNode>, c: DocNode): string {
  const e = stripRender(expand(index as any, c));
  delete e.x;
  delete e.y;
  return stable(e);
}

/** The theme a layer sits in: the document's default, then every ancestor's `theme` (an instance path: inside its instance). */
function themeAt(doc: CanvasDoc, id: string): Theme {
  const target = id.split("/")[0];
  let out: Theme | undefined;
  const seek = (ns: DocNode[] | undefined, t: Theme): boolean => {
    for (const n of ns ?? []) {
      const here = n.theme && typeof n.theme === "object" && !Array.isArray(n.theme) ? { ...t, ...(n.theme as Theme) } : t;
      if (String(n.id) === target) { out = id.includes("/") ? here : t; return true; }
      if (seek(n.children as DocNode[] | undefined, here)) return true;
    }
    return false;
  };
  const base = defaultTheme(doc) as Theme;
  seek(doc.children, base);
  return out ?? base;
}

const varNames = (v: unknown, out: Set<string>) => {
  if (typeof v === "string") { if (v.startsWith("$") && v.length > 1) out.add(v.slice(1)); return; }
  if (Array.isArray(v)) return v.forEach((x) => varNames(x, out));
  if (v && typeof v === "object") for (const x of Object.values(v)) varNames(x, out);
};
/** The definitions of the variables these layers name, and of those they alias. Names the file does not define are text. */
function usedVariables(doc: CanvasDoc, nodes: DocNode[]): Record<string, Json> {
  const defs = (doc.variables ?? {}) as Record<string, Json>;
  const names = new Set<string>();
  for (const n of nodes) varNames(n, names);
  const out: Record<string, Json> = {};
  const todo = [...names];
  while (todo.length) {
    const name = todo.pop()!;
    if (name in out || !Object.prototype.hasOwnProperty.call(defs, name)) continue;
    out[name] = clone(defs[name]);
    const more = new Set<string>();
    varNames(defs[name], more);
    todo.push(...more);
  }
  return out;
}

const KEEP_AS_IS = new Set(["id", "type", "ref", "name", "children", "descendants", "metadata", "context", "geometry", "url", "href", "theme", "reusable"]);
/**
 * Layers pasted into another file: a variable that file lacks, or defines differently, becomes the value the
 * source drew (in the theme each layer sits in), so the layer looks as it did. Shared, equal variables stay tokens.
 */
function materialize(node: DocNode, theme: Theme, names: Set<string>, source: CanvasDoc): void {
  const sub = (v: Json, t: Theme): Json => {
    if (typeof v === "string" && v.startsWith("$") && names.has(v.slice(1))) {
      const r = resolveVariable(source, v.slice(1), t);
      return r === undefined ? v : clone(r);
    }
    if (Array.isArray(v)) return v.map((x) => sub(x, t));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x as Json, t)]));
    return v;
  };
  const visit = (n: DocNode, t: Theme) => {
    const here = n.theme && typeof n.theme === "object" && !Array.isArray(n.theme) ? { ...t, ...(n.theme as Theme) } : t;
    for (const [k, v] of Object.entries(n)) if (!KEEP_AS_IS.has(k) && v !== undefined) (n as Record<string, Json>)[k] = sub(v as Json, here);
    const d = n.descendants as Record<string, DocNode> | undefined;
    if (d && typeof d === "object" && !Array.isArray(d)) for (const o of Object.values(d)) if (o && typeof o === "object" && !Array.isArray(o)) visit(o, here);
    for (const c of (n.children as DocNode[] | undefined) ?? []) visit(c, here);
  };
  visit(node, theme);
}
function stripRender(n: DocNode): DocNode {
  const c = clone(n);
  const visit = (x: DocNode) => {
    delete (x as Record<string, unknown>).__ref;
    for (const k of (x.children as DocNode[] | undefined) ?? []) visit(k);
  };
  visit(c);
  return c;
}
function seekExpanded(doc: Doc, index: Map<string, DocNode>, path: string): DocNode | undefined {
  const root = path.split("/")[0];
  const seek = (n: DocNode): DocNode | undefined => {
    if (String(n.id) === path) return n;
    for (const c of (n.children as DocNode[] | undefined) ?? []) {
      const h = seek(c);
      if (h) return h;
    }
    return undefined;
  };
  for (const top of doc.children) {
    if (String(top.id) !== root && !JSON.stringify(top).includes(`"${root}"`)) continue;
    const hit = seek(expand(index as any, top));
    if (hit) return hit;
  }
  return undefined;
}

/** Is it a payload copyNodes made? */
/**
 * New layers an agent describes (add_nodes), as a paste in the same file: insertNode validates them, ids free in the
 * file are kept (so the agent can name and reach the layers it made), instances of the file's components stay
 * instances, and a new component in the same request can be used by the layers after it.
 */
export function addPayload(nodes: unknown, docFile: string): ClipPayload {
  if (!Array.isArray(nodes) || !nodes.length) throw invalid("nodes is required: one or more layers to add");
  if (nodes.length > 500) throw invalid("at most 500 layers per add");
  const seen = new Set<string>();
  const visit = (n: unknown) => {
    if (!n || typeof n !== "object" || Array.isArray(n) || typeof (n as DocNode).type !== "string") throw invalid("each layer is an object with a type (frame, group, rectangle, ellipse, text, ...)");
    const id = (n as DocNode).id;
    if (typeof id === "string" && id) {
      if (seen.has(id)) throw invalid(`id "${id}" is used twice in nodes`);
      seen.add(id);
    }
    const kids = (n as DocNode).children;
    if (kids !== undefined && !Array.isArray(kids)) throw invalid("children must be a list of layers");
    for (const c of (kids as unknown[] | undefined) ?? []) visit(c);
  };
  nodes.forEach(visit);
  const list = clone(nodes) as DocNode[];
  return { kind: "canvas/nodes", v: 1, source: docFile, nodes: list, detached: list, at: Date.now(), cut: true };
}

export function isPayload(v: unknown): v is ClipPayload {
  const p = v as ClipPayload;
  if (!p || typeof p !== "object" || p.kind !== "canvas/nodes" || !Array.isArray(p.nodes) || !Array.isArray(p.detached) || p.nodes.length !== p.detached.length || p.nodes.length > 500) return false;
  if (p.cards !== undefined && (!Array.isArray(p.cards) || p.cards.length > 200)) return false;
  return p.nodes.length > 0 || (p.cards?.length ?? 0) > 0;
}

// ---------- files a payload names ----------
// A payload can reach a paste from the system clipboard, where any app can write Canvas's pasteboard type. The files
// it names (image fills, a video card's file) are copied into this document only when Canvas wrote the payload
// (sealed with this server's key, so a copy made in this session in any tab or file), or when they sit inside the
// source document's folder and that is a .canvas package or a document this server opened. Anything else pastes
// without them: the image paint and the video's file are left out, and the answer says how many files that was.

const CLIP_KEY = randomBytes(32);
const sealOf = (p: ClipPayload) => createHmac("sha256", CLIP_KEY).update(stable({ ...p, sig: undefined })).digest();
/** The payload with this server's seal: the one Canvas wrote. */
export function sealPayload(p: ClipPayload): ClipPayload {
  return { ...p, sig: sealOf(p).toString("hex") };
}
/** Did this server write the payload, as it is now? */
export function isSealed(p: ClipPayload): boolean {
  if (typeof p.sig !== "string" || !/^[0-9a-f]{64}$/.test(p.sig)) return false;
  return timingSafeEqual(Buffer.from(p.sig, "hex"), sealOf(p));
}

const opened = new Set<string>();
/** A document this server opened (its folder's files may travel in an unsealed payload that names it). */
export const noteOpened = (docFile: string) => void opened.add(docFile);
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isLocalRef = (ref: string) => !!ref && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref);

/**
 * Which files an unsealed payload may bring: those inside its source document's folder, when that folder is a .canvas
 * package or the document is one this server opened. Null: none.
 */
function allowedRoot(payload: ClipPayload): string | null {
  const src = typeof payload.source === "string" && path.isAbsolute(payload.source) ? path.normalize(payload.source) : null;
  if (!src) return null;
  const dir = path.dirname(src);
  const pkg = dir.endsWith(PACKAGE_EXT) && path.basename(src) === DESIGN_FILE && fs.existsSync(src);
  return pkg || opened.has(src) ? real(dir) : null;
}

/**
 * A payload ready to paste into `docFile`: sealed ones as they are; any other without the files it may not bring (image
 * paints that name them are left out, a video card forgets its file). `dropped`: how many files that was.
 */
export function screenPayload(payload: ClipPayload, docFile: string): { payload: ClipPayload; dropped: number } {
  if (isSealed(payload)) return { payload, dropped: 0 };
  const root = allowedRoot(payload);
  const base = typeof payload.source === "string" && path.isAbsolute(payload.source) ? path.dirname(payload.source) : path.dirname(docFile);
  const bad = new Set<string>();
  const blocked = (ref: string): boolean => {
    if (!isLocalRef(ref)) return false;
    const abs = path.resolve(base, ref.split(/[?#]/)[0]);
    const ok = root !== null && real(abs).startsWith(root + path.sep);
    if (!ok) bad.add(abs);
    return !ok;
  };
  // Every file reference the copy into the package reads (visitRefs: image fills, `image`, fonts' urls), the same
  // walk planAssets makes: one not allowed is marked, then the object holding it (a paint, a font) or the field goes.
  const GONE = "\u0000canvas:blocked";
  const layers = structuredClone({ nodes: payload.nodes, detached: payload.detached, mains: payload.mains && typeof payload.mains === "object" ? payload.mains : undefined });
  visitRefs(layers, (ref) => (blocked(ref) ? GONE : undefined));
  const marked = (v: unknown) => v === GONE || (!!v && typeof v === "object" && !Array.isArray(v) && (v as { url?: unknown }).url === GONE);
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.filter((x) => !marked(x)).map(clean);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!marked(x)) out[k] = clean(x);
    return out;
  };
  const p = { ...payload, sig: undefined } as ClipPayload;
  p.nodes = clean(layers.nodes) as DocNode[];
  p.detached = clean(layers.detached) as DocNode[];
  if (layers.mains) p.mains = clean(layers.mains) as Record<string, DocNode>;
  if (Array.isArray(payload.cards)) {
    p.cards = payload.cards.map((c) => {
      if (!c || typeof c !== "object" || c.kind !== "video") return c;
      const card = { ...c, config: { ...(c.config ?? {}) } };
      const file = typeof card.file === "string" && path.isAbsolute(card.file) ? card.file : null;
      const src = typeof card.config.src === "string" ? card.config.src : "";
      // One file each: the card's src names the same file as `file` in a payload Canvas wrote.
      const fileBad = file !== null && blocked(file);
      if (fileBad) delete card.file;
      if (fileBad || (!!src && blocked(src))) { card.config.src = ""; card.config.hash = ""; }
      return card;
    });
  }
  return { payload: p, dropped: bad.size };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|heic|heif|bmp|tiff?)$/i;
const ASSET_MAX = 200 * 1024 * 1024;
const fileBytesHash = (p: string) => createHash("sha1").update(fs.readFileSync(p)).digest("hex").slice(0, 8);
const sameBytes = (a: string, b: string) => {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
};

/**
 * Images the payload's layers name by a relative path, copied into the target package before a paste from another
 * document: ref (as written in the source) -> ref in the target. The same relative path when it is free there or
 * holds the same bytes, else assets/<name>-<hash>; a file outside the source's folder (../) goes to
 * linked/<hash>-<name>, as Save As does. Only image files are copied. A loose .canvas.json target, a file that is missing
 * or not an image, or a path that would leave the package: nothing here, the paste writes the absolute path.
 */
export function planAssets(payload: ClipPayload, dest: string | undefined, created: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const from = payload.source;
  if (!from || !dest || typeof from !== "string" || path.dirname(from) === path.dirname(dest)) return out;
  const dstDir = path.dirname(dest);
  if (path.basename(dest) !== DESIGN_FILE || !dstDir.endsWith(PACKAGE_EXT)) return out;
  const srcDir = path.dirname(from);
  const refs = new Set<string>();
  visitRefs([...payload.nodes, ...payload.detached, ...Object.values(payload.mains ?? {})], (r) => (refs.add(r), undefined));
  for (const ref of refs) {
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref) || path.isAbsolute(ref)) continue;
    const rel = path.normalize(ref.split(/[?#]/)[0]);
    if (!rel || rel === "." || path.isAbsolute(rel) || !IMAGE_EXT.test(rel)) continue;
    const abs = path.resolve(srcDir, rel);
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile() || st.size > ASSET_MAX || !copyableMedia(abs, srcDir)) continue;
    try {
      const ext = path.extname(rel), stem = path.basename(rel, ext);
      const first = rel.startsWith("..") ? `linked/${createHash("sha1").update(abs).digest("hex").slice(0, 8)}-${path.basename(rel)}` : rel.split(path.sep).join("/");
      let name: string | null = null;
      for (const cand of [first, `assets/${stem}-${fileBytesHash(abs)}${ext}`]) {
        const to = inPackage(dstDir, ...cand.split("/"));
        if (!to.startsWith(dstDir + path.sep)) continue;
        if (fs.existsSync(to)) { if (sameBytes(to, abs)) { name = cand; break; } continue; }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(abs, to, fs.constants.COPYFILE_FICLONE);
        created.push(to);
        name = cand;
        break;
      }
      if (name) out.set(ref, name);
    } catch (e) {
      console.error(`[canvas] paste: could not copy ${ref} into ${dstDir}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Layers copied from another document keep their images: a relative image url (resolved against the source
 * document's folder) becomes that file's absolute path, or it would name a missing or unrelated file here.
 */
export function rebaseAssets(n: DocNode, from: string | undefined, to: string | undefined, copied: Map<string, string> = new Map()): DocNode {
  if (!from || !to || path.dirname(from) === path.dirname(to)) return n;
  const base = path.dirname(from);
  // Copied into the target package (planAssets): the new relative path. Else the source file's absolute path.
  visitRefs(n, (ref) => copied.get(ref) ?? (ref && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref) && !path.isAbsolute(ref) ? path.resolve(base, ref) : undefined));
  return n;
}

/**
 * Paste a payload at a place. Raw layers when every component they use is copied with them, is in this file (from
 * another file: the same component, by what it draws) or comes along from the payload's `mains` (into the hidden
 * holder); detached ones otherwise. From another file, a variable this file lacks or defines differently becomes
 * the value the source drew. `assets`: image refs planAssets copied into this package.
 */
export function pasteNodes(doc: Doc, payload: ClipPayload, place: PastePlace, dest?: string, assets?: Map<string, string>): OpResult {
  if (!isPayload(payload)) throw invalid("nothing to paste: the clipboard holds no Canvas layers");
  const parent = place.parent ?? null;
  if (parent !== null) {
    const p = placeOf(doc, parent);
    if (!p) throw new StructureError(404, "not_found", `no node "${parent}"`);
    if (!isContainer(p.node)) throw invalid(`"${parent}" is a ${p.node.type}; paste into a frame or a group`);
  }
  const index = buildIndex(doc as any);
  const sameFile = payload.source === dest;
  const rec = new Recorder(doc);
  // Components the payload carries itself: an instance of one uses the pasted copy.
  const prints = payload.components && typeof payload.components === "object" ? payload.components : {};
  const known = new Map<string, boolean>();
  const inFile = (r: string) => {
    if (!known.has(r)) {
      const c = index.get(r);
      // Another file with a component of the same id: only the same component, or the paste would draw something else.
      known.set(r, c?.reusable === true && (sameFile || (typeof prints[r] === "string" && prints[r] === componentPrint(index, c))));
    }
    return known.get(r)!;
  };
  // A layer pasted detached carries its components expanded: one that was itself an instance is no component any
  // more, so the layers using it detach too, until nothing changes (a layer only ever goes raw -> detached).
  // In the same file a main component pastes as an instance of itself; a cut comes back as it was.
  const holder = deletedHolder(doc);
  const cut = sameFile && payload.cut === true ? { held: new Set(((holder?.children as DocNode[] | undefined) ?? []).map((n) => String(n.id))), keep: new Set<string>(), unpark: new Set<string>() } : undefined;
  const srcs = sameFile ? payload.nodes.map((n) => sameFileCopy(n, index, cut)) : [...payload.nodes];
  // A parked main component the cut took leaves the holder: the pasted one takes its place (and its id).
  // The holder is purged only once the pasted layers are in: a parked component they use (B, used by the pasted A)
  // is needed again.
  for (const id of cut?.unpark ?? []) rec.remove(id);
  // From another file, a component the target lacks comes along (`mains`), with the components it uses in turn.
  const mains = !sameFile && payload.mains && typeof payload.mains === "object" ? payload.mains : {};
  const reusablesIn = (n: DocNode, out: Set<string>) => {
    if (n.reusable === true && typeof n.id === "string") out.add(n.id);
    for (const c of (n.children as DocNode[] | undefined) ?? []) reusablesIn(c, out);
    return out;
  };
  /** Can `r` be used: carried in the paste, the target's own, or brought along (and so on for what it uses). */
  const usable = (r: string, carried: Set<string>, memo: Map<string, boolean>, stack = new Set<string>()): boolean => {
    if (carried.has(r) || inFile(r)) return true;
    if (memo.has(r)) return memo.get(r)!;
    const m = Object.hasOwn(mains, r) ? mains[r] : undefined;
    if (!m || typeof m !== "object" || m.reusable !== true || stack.has(r)) return false;
    stack.add(r);
    const inner = reusablesIn(m, new Set());
    const ok = [...refsIn(m)].every((x) => inner.has(x) || usable(x, carried, memo, stack));
    stack.delete(r);
    memo.set(r, ok);
    return ok;
  };
  let carried = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    carried = new Set<string>();
    srcs.forEach((n) => reusablesIn(n, carried));
    const memo = new Map<string, boolean>();
    srcs.forEach((src, i) => {
      if (src === payload.detached[i] || [...refsIn(src)].every((r) => usable(r, carried, memo))) return;
      srcs[i] = payload.detached[i];
      changed = true;
    });
  }
  // The components to bring along: those the final layers use that neither the paste nor the target has, and theirs.
  const imports: string[] = [];
  const todo = srcs.flatMap((n) => [...refsIn(n)]);
  while (todo.length) {
    const r = todo.pop()!;
    if (carried.has(r) || inFile(r) || imports.includes(r) || !Object.hasOwn(mains, r)) continue;
    imports.push(r);
    todo.push(...refsIn(mains[r]));
  }
  // Outermost only: a component inside another one that comes along comes with it.
  const within = new Map(imports.map((r) => [r, reusablesIn(mains[r], new Set())]));
  const bring = imports.filter((r) => !imports.some((o) => o !== r && within.get(o)!.has(r)));
  // An imported main keeps its ids when none of them is taken here, so a second paste finds it the same (by id).
  const docIds = allIds(doc as any);
  const keep = new Set(cut?.keep ?? []);
  for (const r of bring) {
    const ids = subtreeIds(mains[r]);
    if ([...ids].every((x) => !docIds.has(x) && !keep.has(x))) for (const x of ids) keep.add(x);
  }
  const lookup = new Map(index);
  for (const n of [...payload.nodes, ...payload.detached, ...bring.map((r) => mains[r])]) for (const [id, x] of buildIndex({ children: [n] } as any)) lookup.set(id, x);
  const copied = sameFile ? new Map<string, string>() : (assets ?? new Map<string, string>());
  const all = freshCopies([...srcs, ...bring.map((r) => stripRender(mains[r]))], docIds, lookup, keep).map((n) => rebaseAssets(n, payload.source, dest, copied));
  const nodes = all.slice(0, srcs.length), brought = all.slice(srcs.length);
  if (!sameFile && payload.variables && typeof payload.variables === "object") {
    const mine = ((doc as CanvasDoc).variables ?? {}) as Record<string, Json>;
    const names = new Set(Object.keys(payload.variables).filter((k) => !Object.prototype.hasOwnProperty.call(mine, k) || stable(mine[k]) !== stable(payload.variables![k])));
    const source = { children: [], variables: payload.variables } as unknown as CanvasDoc;
    if (names.size) {
      nodes.forEach((n, i) => materialize(n, payload.themes?.[i] ?? {}, names, source));
      brought.forEach((n, i) => materialize(n, payload.mainThemes?.[bring[i]] ?? {}, names, source));
    }
  }
  nodes.forEach((node, i) => {
    const pos = place.positions?.[i];
    if (pos) Object.assign(node, { x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100 });
  });
  // insertNode validates the layers and their instances, all at once (an instance may use a component pasted after
  // it): inside a scratch group that is then taken apart. The Recorder keeps one insert per layer.
  const taken = allIds(doc as any);
  for (const n of all) subtreeIds(n, taken);
  const shell = { type: "group", id: newId(taken), children: all } as DocNode;
  insertNode(doc as any, parent, shell, 0);
  const sp = placeOf(doc, String(shell.id))!;
  sp.list.splice(sp.index, 1);
  const made = (sp.node.children as DocNode[]) ?? [];
  const select: string[] = [];
  let at = Math.max(0, Math.min(place.index ?? rec.kids(parent).length, rec.kids(parent).length));
  for (const node of made.slice(0, nodes.length)) {
    rec.insert(parent, at, node);
    select.push(String(node.id));
    at += 1;
  }
  if (made.length > nodes.length) {
    // The brought components go into the hidden holder at the end of the file (made when there is none).
    let h = deletedHolder(doc);
    if (!h) {
      h = { type: "frame", id: newId(taken), name: "Components from other files", enabled: false, layout: "none", x: 0, y: 0, width: 100, height: 100, clip: true, metadata: { type: "canvas", [DELETED_KEY]: true }, children: [] } as unknown as DocNode;
      rec.insert(null, doc.children.length, h);
    }
    for (const node of made.slice(nodes.length)) rec.insert(String(h.id), ((h.children as DocNode[] | undefined) ?? []).length, node);
  }
  if (cut?.unpark.size) purgeHolder(doc, rec);
  assertNoCycle(doc, select, "pasted");
  return { label: "Paste", select, ops: rec.ops };
}

/** Paste into several selected frames: one copy of the payload into each place, one step. */
export function pasteMany(doc: Doc, payload: ClipPayload, places: PastePlace[], dest?: string, assets?: Map<string, string>): OpResult {
  if (!places.length || places.length > 200) throw invalid("places: 1 to 200 places to paste into");
  const ops: Op[] = [], select: string[] = [];
  for (const place of places) {
    const r = pasteNodes(doc, payload, place, dest, assets);
    ops.push(...r.ops);
    select.push(...r.select);
  }
  return { label: "Paste", select, ops };
}

/**
 * Paste to replace (Shift+Cmd+R): each layer in `ids` gives way to a copy of the payload's layers, at its
 * index in its parent. Placed freely, the copies' top-left lands on the replaced layer's x/y and keeps their own
 * arrangement; in auto layout the parent places them. One step: undo brings the replaced layers back.
 */
export function replaceNodes(doc: Doc, payload: ClipPayload, ids: string[], dest?: string, assets?: Map<string, string>): OpResult {
  if (!isPayload(payload) || !payload.nodes.length) throw invalid("Paste to replace takes layers: the clipboard holds none");
  const list = normalize(doc, ids, "replace");
  // Where the copied layers sat relative to each other: their rects when the copy had them, else their own x/y.
  const rs = payload.rects ?? [];
  const src: (Rect | null)[] = payload.nodes.every((_, i) => rs[i]) ? rs.map((r) => r!) : payload.nodes.map((n) => (num(n.x) !== undefined || num(n.y) !== undefined ? { x: num(n.x) ?? 0, y: num(n.y) ?? 0, w: 0, h: 0 } : null));
  const real = src.filter((r): r is Rect => !!r);
  const u = real.length ? union(real) : null;
  const ops: Op[] = [], select: string[] = [];
  for (const id of list) {
    const p = placeOf(doc, id);
    if (!p) continue;
    const parent = p.parent ? findNode(doc as any, p.parent).node : null;
    const free = absoluteIn(parent, p.node);
    const ax = num(p.node.x) ?? 0, ay = num(p.node.y) ?? 0;
    const positions = src.map((r) => (free && r && u ? { x: ax + r.x - u.x, y: ay + r.y - u.y } : null));
    const pasted = pasteNodes(doc, payload, { parent: p.parent, index: p.index + 1, positions }, dest, assets);
    const gone = deleteNodes(doc, [id]);
    ops.push(...pasted.ops, ...gone.ops);
    select.push(...pasted.select);
  }
  return { label: "Paste to Replace", select, ops };
}

// ---------- writing ----------

export type StructureBody = {
  /** paste: the page's selection before it, which an Undo of the paste selects again. */
  selBefore?: unknown[];
  file?: string;
  op?: StructureOp;
  ids?: string[];
  rects?: Record<string, Rect>;
  dir?: ReorderDir;
  payload?: ClipPayload;
  /** paste: use the server's last copy (the system clipboard held the marker). */
  fromServer?: boolean;
  place?: PastePlace;
  /** paste: one copy into each of these places (a paste into several selected frames). */
  places?: PastePlace[];
  /** paste: Paste to replace (Shift+Cmd+R), these layers give way to the clipboard's. */
  replace?: string[];
  /** add: new layers (node JSON, children included). An id that is free in the file is kept; a taken or missing one gets a fresh id. */
  nodes?: unknown[];
  expectedRevision?: string;
  /** The page the request came from: new top-level boards (a paste onto the canvas) land on it. */
  page?: string;
  /** "group:...": a delete or duplicate of a mixed selection; its cards' writes (x-canvas-merge) join this step, one Undo for all. */
  merge?: string;
  /** duplicate: each copy at its original moved by this (Option-drag, Cmd+D repeating the last offset). */
  offset?: { dx: number; dy: number };
  /** duplicate with offset: round the copies' x/y to whole pixels (pixel snapping). */
  round?: boolean;
  /** add on the canvas: keep the x/y given even where it overlaps another board (default: moved right until clear). */
  allowOverlap?: boolean;
};
export type Who = { source: "user" | "mcp"; session?: string };

let lastCopy: ClipPayload | null = null;
/** The server's clipboard slot: the last copy or cut, from any page or file. */
export const serverClipboard = () => lastCopy;
export const setServerClipboard = (p: ClipPayload | null) => void (lastCopy = p);

/** Run one structure op on a document on disk: one write, one undo step. */
export function runStructure(docFile: string, b: StructureBody, who: Who): { ok: true; op: StructureOp; label?: string; select: string[]; revision?: string; payload?: ClipPayload; warnings?: string[]; placed?: Placed[]; note?: string } {
  const op = b.op;
  const rects = b.rects && typeof b.rects === "object" ? b.rects : {};
  if (op === "copy") {
    const payload = copyNodes(currentDoc(docFile).doc as unknown as Doc, b.ids ?? [], rects, docFile);
    lastCopy = payload;
    return { ok: true, op, select: b.ids ?? [], payload };
  }
  let payload: ClipPayload | undefined;
  if (op === "paste") {
    payload = b.fromServer ? (lastCopy ?? undefined) : b.payload;
    if (!payload) throw invalid("nothing to paste: copy some layers first");
    if (!isPayload(payload) || !payload.nodes.length) throw invalid("nothing to paste: the clipboard holds no Canvas layers");
  }
  // Images from another document are copied into this package first (the edit itself never touches other files).
  const created: string[] = [];
  const assets = op === "paste" && payload && payload.source !== docFile ? planAssets(payload, docFile, created) : undefined;
  if (op === "add") payload = addPayload(b.nodes, docFile);
  let out: OpResult | undefined;
  // New boards an agent adds land clear of the boards and cards on their page (src/placement.ts). The page's own adds
  // (an image dropped over a board with Space held) go where the person put them.
  const onCanvas = op === "add" && who.source === "mcp" && (b.place?.parent ?? null) === null;
  const mates = onCanvas ? pageMates(docFile, currentDoc(docFile).doc as unknown as Doc, { page: b.page }) : null;
  const cards = mates ? cardBoxes(docFile, mates.page, mates.first) : [];
  let placed: Placed[] | undefined;
  // The boards a structure op can change: those of its layers, and of the parent a paste lands in (null: the document's list).
  const touches = [...(b.ids ?? []), op === "paste" || op === "add" ? (b.place?.parent ?? null) : null];
  if (op === "paste") {
    for (const p of Array.isArray(b.places) ? b.places : []) touches.push(p && typeof p.parent === "string" ? p.parent : null);
    if (Array.isArray(b.replace)) touches.push(...b.replace.filter((x): x is string => typeof x === "string"), ...groupsAround(currentDoc(docFile).doc as unknown as Doc, b.replace.filter((x): x is string => typeof x === "string" && !!placeOf(currentDoc(docFile).doc as unknown as Doc, x))));
  }
  // A delete or cut out of a group refits it (groupfit.ts): the groups around the layers change too.
  if (op === "delete" || op === "cut") touches.push(...groupsAround(currentDoc(docFile).doc as unknown as Doc, b.ids ?? []));
  // The hidden holder of deleted main components: a delete parks components in it, a paste takes them back out, and
  // any op may purge it. It is copied like every board the op changes, never changed in place.
  const holder = deletedHolder(currentDoc(docFile).doc as unknown as Doc);
  if (holder) touches.push(String(holder.id));
  // Replayed on someone else's bytes (before it reached the disk), the edit makes no new ids: it applies the ops it
  // made the first time, so the duplicate, the pasted layers or the new group keep the ids everyone already holds.
  const replay = (doc: CanvasDoc) => replayOps(doc as unknown as Doc, out!.ops);
  const edit = () => editDoc(docFile, { expectedRevision: b.expectedRevision, touches, deep: true, urgent: true, replay, recorded: () => out?.ops ?? [], media: created }, (doc) => {
    // The change may run twice (a replay after an outside save); the last run is the one written.
    const d = doc as unknown as Doc;
    switch (op) {
      case "delete": out = deleteNodes(d, b.ids ?? []); break;
      case "cut": {
        const p = copyNodes(d, b.ids ?? [], rects, docFile);
        out = { ...deleteNodes(d, b.ids ?? [], true), label: "Cut", payload: { ...p, cut: true } };
        break;
      }
      case "duplicate": out = duplicateNodes(d, b.ids ?? [], rects, { offset: b.offset, round: b.round === true }); break;
      case "group": out = groupNodes(d, b.ids ?? [], rects, false); break;
      case "frame": out = groupNodes(d, b.ids ?? [], rects, true); break;
      case "ungroup": out = ungroupNodes(d, b.ids ?? [], rects); break;
      case "reorder": out = reorderNodes(d, b.ids ?? [], b.dir as ReorderDir); break;
      case "detach": out = detachNodes(d, b.ids ?? []); break;
      case "paste":
        if (Array.isArray(b.replace)) out = replaceNodes(d, payload!, b.replace, docFile, assets);
        else if (Array.isArray(b.places)) out = pasteMany(d, payload!, b.places, docFile, assets);
        else out = pasteNodes(d, payload!, b.place ?? { parent: null }, docFile, assets);
        break;
      case "add": {
        const res = pasteNodes(d, payload!, b.place ?? { parent: null }, docFile);
        // Groups written by hand rarely sit at their layers' top-left (a turned layer at 0,0 reaches above it): fit
        // the new groups and the groups they went into, as every Canvas edit does, so the selection box is the drawn one.
        const seeds: string[] = [];
        const walkIds = (n: DocNode) => { seeds.push(String(n.id)); for (const c of (n.children as DocNode[] | undefined) ?? []) walkIds(c); };
        for (const id of res.select) { const f = placeOf(d, id); if (f) walkIds(f.node); }
        const fit = new Recorder(d);
        fitAround(d, seeds, (id, p) => fit.props(id, p));
        if (mates) {
          // The x and y the agent wrote for each new top-level layer (select lists them in the order they came).
          const given = new Map(res.select.map((id, i) => {
            const src = payload!.nodes[i] as DocNode | undefined;
            return [id, { x: num(src?.x), y: num(src?.y) }] as const;
          }));
          placed = placeNew(d, res.select, given, { mates: mates.boards, rects, cards, allowOverlap: b.allowOverlap === true }, (id, xy) => fit.props(id, xy));
        }
        out = { ...res, ops: [...res.ops, ...fit.ops], label: payload!.nodes.length === 1 ? "Add layer" : "Add layers" };
        break;
      }
      default: throw invalid(`unknown op "${op}"; use delete, duplicate, copy, cut, paste, add, group, frame, ungroup, reorder or detach`);
    }
    if (!out.ops.length) throw new StructureError(409, "no_change", `${out.label}: nothing moved`);
  });
  let write: ReturnType<typeof edit>["write"];
  try {
    write = edit().write;
  } catch (e) {
    // Nothing was pasted: the files copied in for it go again.
    for (const f of created) fs.rmSync(f, { force: true });
    throw e;
  }
  const r = out!;
  // A mixed selection deleted, or Option-dragged (its cards' writes join this step): one Undo for all.
  const group = (op === "delete" || op === "duplicate") && isGroupMerge(b.merge);
  record(docFile, r.ops, { label: r.label, source: who.source, session: who.session, mergeKey: group ? b.merge : `structure:${Date.now()}:${Math.random()}`, ...(group ? { mergeMs: GROUP_MERGE_MS } : {}), edit: write.edit, ...(op === "delete" || op === "cut" ? { sel: (b.ids ?? []).filter((x): x is string => typeof x === "string").slice(0, 2000) } : {}), ...(op === "duplicate" ? { selBefore: b.ids ?? [] } : op === "paste" && Array.isArray(b.selBefore) ? { selBefore: b.selBefore.filter((x): x is string => typeof x === "string").slice(0, 2000) } : {}) }, write.revision);
  // Files copied in for a paste from another file: its undo takes them back when nothing else uses them.
  addStepFiles(docFile, topSeq(docFile), created);
  if (r.payload) lastCopy = r.payload;
  // Keys this version does not know (a copy from a newer Canvas, an agent's guess) went in as they were: say which.
  const warnings = (op === "add" || op === "paste") && payload ? payload.nodes.flatMap((n) => unknownKeys(n)).slice(0, 20) : [];
  const note = placed ? placementNote(placed) : undefined;
  return { ok: true, op: op!, label: r.label, select: r.select, revision: write.revision, ...(r.payload ? { payload: r.payload } : {}), ...(warnings.length ? { warnings } : {}), ...(placed ? { placed } : {}), ...(note ? { note } : {}) };
}

const topIds = (docFile: string): string[] => ((currentDoc(docFile).doc.children ?? []) as DocNode[]).map((n) => String(n.id));

/**
 * Boards a structure op put at the top level (a duplicated, grouped, ungrouped or pasted board) belong to the page
 * the op happened on: the page of the boards it started from, else the page the request names. Unlisted boards
 * show on the first page, so without this a board duplicated on page 2 appeared on page 1; a board made on the first
 * page is listed there as well, so it never depends on which page is first. Boards the op took away (delete, cut,
 * moved into a layer) leave their page's list. A file whose pages are implicit has one
 * page showing every board and stays without a stored list. The page list change
 * joins the op's undo step (called right after it is recorded): Undo takes the board off its page with it, so no
 * page lists an id the document lacks, and Redo lists it again.
 */
export async function keepOnPage(docFile: string, b: StructureBody, before: string[], join: RecordMeta | null = joinTop(docFile)): Promise<void> {
  const step = join;
  const had = new Set(before);
  const now = topIds(docFile);
  const have = new Set(now);
  const fresh = now.filter((id) => !had.has(id));
  const left = before.filter((id) => !have.has(id));
  if (!fresh.length && !left.length) return;
  try {
    const view = listPages(docFile, () => before);
    if (view.implicit) return;
    // Boards the op deleted, cut or moved inside another layer leave the page that listed them.
    const stored = new Set(listPages(docFile, () => []).unknownBoards ?? []);
    const gone = left.filter((id) => stored.has(id));
    const from = b.op === "paste" ? undefined : (b.ids ?? []).find((id) => had.has(id));
    const page = (from && view.pages.find((p) => p.boards.includes(from))) || view.pages.find((p) => p.id === b.page);
    // The first page too: a file whose pages are written out lists every board on one (an unlisted board would
    // follow whichever page is moved to the top).
    const to = page && fresh.length ? page.id : null;
    if (!to && !gone.length) return;
    await settleBoards(docFile, fresh, to, gone, () => topIds(docFile), step ? { record: step } : {});
  } catch (e) {
    console.error(`[canvas] structure: could not keep new boards on their page: ${(e as Error).message}`);
  }
}

const ON_PAGE_OPS = new Set<unknown>(["delete", "cut", "duplicate", "group", "frame", "ungroup", "reorder", "detach"]);

/** The ids on `page` (by the board each one is in); a file without pages, or a page not in the list, keeps them all. */
function onPage(docFile: string, ids: unknown[], page: string): string[] {
  const list = ids.filter((x): x is string => typeof x === "string");
  const view = listPages(docFile, () => topIds(docFile));
  if (view.implicit || !view.pages.some((p) => p.id === page)) return list;
  const doc = currentDoc(docFile).doc;
  return list.filter((id) => {
    let top: string;
    try { const f = findNode(doc as any, id); top = String((f.ancestors[0] ?? f.node).id); } catch { return true; } // not found: the op says so
    return (view.pages.find((p) => p.boards.includes(top)) ?? view.pages[0]).id === page;
  });
}

/** The page a pasted card lands on: the request's page, unless it is the first one (a card without a page shows there). */
function cardPage(docFile: string, page: string | undefined): string | undefined {
  if (typeof page !== "string" || !page) return undefined;
  try {
    const view = listPages(docFile, () => topIds(docFile));
    if (view.implicit || !view.pages.some((p) => p.id === page) || view.pages[0].id === page) return undefined;
    return page;
  } catch {
    return undefined;
  }
}

/**
 * Copy, cut and paste of a selection that may hold cards as well as layers and boards: the layers go through
 * runStructure, the cards through src/clipcards.ts, and a cut or paste of both is one undo step (the cards' write
 * joins the layers' step). The answer of a paste lists the new cards (`widgets`) so the page can show them at once.
 */
async function clipboardOp(docFile: string, b: StructureBody, who: Who, deps: StructureDeps, by: "mcp" | "inspector") {
  return asOneAction(docFile, () => clipboardOpNow(docFile, b, who, deps, by));
}

async function clipboardOpNow(docFile: string, b: StructureBody, who: Who, deps: StructureDeps, by: "mcp" | "inspector") {
  const rects = b.rects && typeof b.rects === "object" ? b.rects : {};
  const ids = (b.ids ?? []).filter((x): x is string => typeof x === "string");
  const step = () => ({ label: b.op === "cut" ? "Cut" : "Paste", source: who.source, session: who.session, mergeKey: `structure:${Date.now()}:${Math.random()}` });
  const before = topIds(docFile);
  if (b.op === "copy" || b.op === "cut") {
    const cardIds = ids.filter(isCard).map(bareCard);
    const layers = ids.filter((x) => !isCard(x));
    // Read before a cut removes them.
    const cards = await copyCards(docFile, cardIds, rects);
    if (!layers.length && !cards.length) throw invalid("nothing to copy: the selection holds no layers or cards");
    let r: ReturnType<typeof runStructure> | null = null;
    let join: RecordMeta | null = null;
    if (layers.length) {
      r = runStructure(docFile, { ...b, ids: layers }, who);
      join = joinTop(docFile);
      await keepOnPage(docFile, b, before, join);
    }
    let payload: ClipPayload = r?.payload ?? emptyPayload(docFile, b.op === "cut");
    if (cards.length) payload = { ...payload, cards };
    if (b.op === "cut" && cards.length) await cutCards(docFile, cards.map((c) => c.id), { record: join ?? step() });
    // Sealed: when it comes back through the system clipboard, the files it names may come along (screenPayload).
    payload = sealPayload(payload);
    lastCopy = payload;
    if (b.op === "cut" && r) deps.written(docFile, r.revision, by, r.select, r.label ?? "Cut");
    return { ok: true, op: b.op, label: b.op === "cut" ? "Cut" : undefined, select: [], revision: r?.revision, payload };
  }
  const given = b.fromServer ? (lastCopy ?? undefined) : b.payload;
  if (!given) throw invalid("nothing to paste: copy some layers first");
  if (!isPayload(given)) throw invalid("nothing to paste: the clipboard holds no Canvas layers");
  // The server's own slot is Canvas's copy; one from the system clipboard brings only the files it may (screenPayload).
  const { payload, dropped } = b.fromServer ? { payload: given, dropped: 0 } : screenPayload(given, docFile);
  const replace = Array.isArray(b.replace);
  if (replace && !payload.nodes.length) throw invalid("Paste to replace takes layers: the clipboard holds only cards");
  let r: ReturnType<typeof runStructure> | null = null;
  let join: RecordMeta | null = null;
  if (payload.nodes.length) {
    r = runStructure(docFile, { ...b, fromServer: false, payload }, who);
    join = joinTop(docFile);
    await keepOnPage(docFile, b, before, join);
  }
  let widgets: Widget[] = [];
  // Cards always go on the canvas, once (a paste into several frames too); Paste to replace swaps layers only.
  if (payload.cards?.length && !replace) {
    const created: string[] = [];
    try {
      widgets = await pasteCards(docFile, payload.cards, { sameFile: payload.source === docFile, cut: payload.cut === true, positions: b.place?.cards, page: cardPage(docFile, b.page), record: join ?? step(), created });
      addStepFiles(docFile, join?.into ?? topSeq(docFile), created);
    } catch (e) {
      // The layers are in already: say what happened to the cards instead of losing the answer.
      if (!r) throw e;
      console.error(`[canvas] paste: the cards did not paste: ${(e as Error).message}`);
    }
  }
  if (r) deps.written(docFile, r.revision, by, r.select, r.label ?? "Paste");
  const notice = dropped ? `Pasted without ${dropped === 1 ? "1 file" : `${dropped} files`}: the clipboard did not come from Canvas` : undefined;
  return { ok: true, op: "paste" as const, label: r?.label ?? "Paste", select: [...(r?.select ?? []), ...widgets.map((w) => CARD_PREFIX + w.id)], revision: r?.revision, widgets, ...(notice ? { notice } : {}), ...(r?.warnings ? { warnings: r.warnings } : {}) };
}

export type StructureDeps = {
  prime: (file: string) => Promise<void>;
  /** World boxes of these nodes as the page showing the file draws them ({} without a page). */
  measure?: (file: string, ids: string[]) => Promise<Record<string, Rect>>;
  docFileOf: (file: string) => string;
  written: (docFile: string, revision: string | undefined, by: "mcp" | "inspector", ids: string[], label: string) => void;
};

/**
 * POST /api/structure {file, op, ids, rects?, dir?, payload?, fromServer?, place?, expectedRevision?} →
 * {ok, op, label, select, revision, payload?}. GET /api/structure/clipboard → the server's last copy (or null).
 */
export async function handleStructureRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: StructureDeps): Promise<boolean> {
  if (url.pathname !== "/api/structure" && url.pathname !== "/api/structure/clipboard") return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (url.pathname === "/api/structure/clipboard") {
      if (req.method !== "GET") return reply(405, { error: "GET only", code: "invalid" }), true;
      return reply(200, { payload: lastCopy }), true;
    }
    if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const raw = await readBodyText(req, 20_000_000);
  if (raw === null) return reply(413, { error: "too large", code: "invalid" }), true;
    const b = JSON.parse(raw || "{}") as StructureBody;
    if (!b.file || !b.op) return reply(400, { error: "file and op are required", code: "invalid" }), true;
    await deps.prime(b.file);
    const docFile = deps.docFileOf(b.file);
    noteOpened(docFile);
    const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
    const session = String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined;
    // The page acts on what it shows: layers on another page (a selection left over from elsewhere) are left out.
    if (by !== "mcp" && typeof b.page === "string" && Array.isArray(b.ids) && b.ids.length && ON_PAGE_OPS.has(b.op)) {
      b.ids = onPage(docFile, b.ids, b.page);
      if (!b.ids.length) return reply(409, { error: "The selection is on another page. Nothing was changed.", code: "other_page" }), true;
    }
    const who: Who = { source: by === "mcp" ? "mcp" : "user", session };
    if (b.op === "copy" || b.op === "cut" || b.op === "paste") return reply(200, await clipboardOp(docFile, b, who, deps, by)), true;
    const before = topIds(docFile);
    // An agent's new or duplicated board is placed clear of the others: boards that hug their content are measured
    // on the page first (the file has no size for them).
    if (by === "mcp" && deps.measure && ((b.op === "add" && (b.place?.parent ?? null) === null) || b.op === "duplicate")) {
      const doc = currentDoc(docFile).doc as unknown as Doc;
      const first = (b.ids ?? []).find((id) => typeof id === "string" && before.includes(id));
      const ids = unsizedOnPage(docFile, doc, { page: b.page, board: first }).filter((id) => !(b.rects && b.rects[id]));
      if (ids.length) b.rects = { ...(await deps.measure(docFile, ids).catch(() => ({}))), ...(b.rects ?? {}) };
    }
    const r = await asOneAction(docFile, async () => {
      const result = runStructure(docFile, b, who);
      await keepOnPage(docFile, b, before);
      return result;
    });
    deps.written(docFile, r.revision, by, r.select, r.label ?? r.op);
    return reply(200, r), true;
  } catch (e) {
    if (e instanceof StructureError) return reply(e.status, { error: e.message, code: e.code }), true;
    if (e instanceof WidgetError) return reply(e.status || 422, { error: e.message, code: e.code }), true;
    if (e instanceof StaleFileError) return reply(409, { error: (e as Error).message, code: "stale_revision" }), true;
    if (e instanceof ValidationError) return reply(422, { error: (e as Error).message, code: "invalid" }), true;
    if (/no node with id/.test((e as Error).message)) return reply(404, { error: (e as Error).message, code: "not_found" }), true;
    return reply(422, { error: (e as Error).message, code: "failed" }), true;
  }
}

/** The name for a new frame or group: "Frame 1", then one more than the highest "Frame N" in the document. */
export function nextName(doc: { children?: unknown }, base: string): string {
  const re = new RegExp(`^${base} (\\d+)$`);
  let max = 0;
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const n of list as DocNode[]) {
      const m = typeof n?.name === "string" ? re.exec(n.name) : null;
      if (m) max = Math.max(max, Number(m[1]));
      walk(n?.children);
    }
  };
  for (const b of Array.isArray(doc.children) ? (doc.children as DocNode[]) : []) {
    const f = factsOf(b);
    if (f) max = Math.max(max, f.names.get(base) ?? 0);
    else walk([b]);
  }
  return `${base} ${max + 1}`;
}
