// Auto layout ops: add (Shift+A), remove (Option+Shift+A), place (drag reorder, drag in/out, arrow
// keys), sizing (Fixed / Hug / Fill) and the Canvas-only settings kept in metadata.canvasLayout. The page, the
// inspector and the MCP all land here through POST /api/layout; every op is one write and one undo step, made on
// the document through structure.ts's Recorder. Research and spec: .planning/research/auto-layout.md.
//
// ---------------------------------------------------------------- published signatures (workstreams A, B, C)
//
// Route: POST /api/layout, header x-canvas: 1 (x-canvas-source: mcp for agents). Answer {ok, op, label, select, revision, changed}.
//   {file, op: "add", ids, rects?}                                  -> select [frameId]   "Add Auto Layout"
//   {file, op: "remove", ids, rects?, deep?}                        -> select ids         "Remove Auto Layout"
//   {file, op: "place", ids, parent, index | before, absolute?, rects?, merge?, copy?} -> select ids "Reorder" | "Move Into Frame" | "Move Out of Frame"
//     copy: true places copies instead (Option-drag; the layers stay): select the copies, "Duplicate"
//     parts: [{ids, parent, before | index, absolute?}] instead: several destinations (a multi-selection dropped
//       across frames) in one write and one undo step; select every id
//   {file, op: "sizing", id, axis: "width"|"height", mode: "fixed"|"hug"|"fill", rects?} -> select [id]  "Size Change"
//   {file, op: "settings", ids, layout: {<CanvasLayout key>: value | null}}             -> select ids    "Auto Layout Settings"
//   Errors {error, code}: 400 invalid, 404 not_found, 409 instance (inside an instance, or removing on an instance),
//   409 stale_revision. A place that changes nothing answers 200 with changed: false and makes no undo step.
//
// place semantics:
//   parent: a frame or group id, or null for the document (boards).
//   index: where the FIRST moved layer ends up in parent's children once the moved layers are out of the list
//     (final index). Several ids keep their document order and land together. Arrow keys: current index +/- 1.
//     A drag slot counted in the list as drawn (moved layers included) converts with slotToIndex(kids, ids, slot).
//     The index counts the file's children, hidden ones included.
//   before: instead of index, the sibling the moved layers land right before (null: the end). The page sends this:
//     it draws no hidden layers, so its own indexes would be off by one per hidden layer before the slot.
//   An instance cannot go inside its own component or one it uses (409 cycle). Layers dropped on the document
//   become boards on the page of the board they came from.
//   absolute: per id, {x, y} in the NEW PARENT's coordinates (as written to the file), or null. Into an auto layout
//     parent it makes the layer layoutPosition "absolute" there (Ctrl+drag in). Without it, a flow parent takes the
//     layer into the flow (x/y and layoutPosition dropped), and a free parent (board, group, layout none frame,
//     the document) gets x/y that keep the layer where it was on screen, from rects.
//   merge: "nudge" (arrow keys: a burst of the same ids folds into one undo step, 1 s apart at most) or the
//     page's "group:<key>".
// rects: world rects {x, y, w, h} by id, as the page measures them (structure.ts takes the same). Send the moved
//   layers, their parents and the target parent; for remove, the frame and its children.
//
// Pure functions (change `doc`, return {label, select, ops}; tests and other modules may call them):
//   inferLayout(rects: Rect[]): Inference                 direction, gap, cross alignment, visual order
//   inferPadding(frame: {w, h}, content: Rect[]): Padding4 content rects relative to the frame; [top, right, bottom, left]
//   paddingValue(p: Padding4): Json | undefined           the compact .canvas.json form (number, [v, h] or four), undefined for 0
//   readPadding(v: unknown): Padding4
//   sizeMode(node, axis): SizingMode                       what W/H's resizing menu shows
//   readCanvasLayout(node): CanvasLayout                   metadata.canvasLayout, {} when absent
//   mergeCanvasLayout(metadata, patch): Json | null        new metadata value; null = remove metadata
//   settingsProps(node, patch): {set, remove}              metadata + native fallbacks for a settings patch
//   slotToIndex(kids: string[], ids: string[], slot: number): number
//   addAutoLayout(doc, ids, rects?), removeAutoLayout(doc, ids, rects?, deep?),
//   placeNodes(doc, ids, parent, index, {absolute?, rects?}), setSizing(doc, id, axis, mode, rects?),
//   layoutSettings(doc, ids, patch)
//   runLayout(docFile, body, who), handleLayoutRoute(req, res, url, deps)
//
// metadata.canvasLayout (section 2 of the research): frame keys wrap, crossGap, crossAuto, gapMode, baseline,
// stacking; child or frame keys minWidth, maxWidth, minHeight, maxHeight. Absent = the default. Native
// fallbacks are written beside them: gapMode "evenly" writes justifyContent "space_around", baseline writes
// alignItems "end". Canvas keeps metadata's `type` and anyone else's keys, and removes metadata when nothing is left.

import { fitAround, groupsAround } from "./groupfit.ts";
import type http from "node:http";
import { allIds, findNode, newId, StaleFileError, ValidationError, type Json, type DocNode } from "./engine.ts";
import { currentDoc, editDoc } from "./docwriter.ts";
import { placeOf, record, replayOps } from "./history.ts";
import { GROUP_MERGE_MS, isGroupMerge, NUDGE_MERGE_MS } from "./move.ts";
import { boxOf, duplicateNodes, keepOnPage, nextName, normalize, placesChildren, Recorder, StructureError, union, type OpResult, type Rect, type Who } from "./structure.ts";
import { readBodyText } from "./body.ts";
import { cardBoxes, pageMates, placeNew, placementNote, type Placed } from "./placement.ts";

type Doc = { children: DocNode[]; variables?: unknown };
export type { Rect };
export type Flow = "horizontal" | "vertical";
export type Align = "start" | "center" | "end";
/** top, right, bottom, left */
export type Padding4 = [number, number, number, number];
/** `order`: indexes into the rects given, in flow order. */
export type Inference = { layout: Flow; gap: number; alignItems: Align; order: number[] };
export type SizingAxis = "width" | "height";
export type SizingMode = "fixed" | "hug" | "fill";
export type CanvasLayout = {
  wrap?: boolean; crossGap?: number | string; crossAuto?: boolean;
  gapMode?: "between" | "around" | "evenly"; baseline?: boolean; stacking?: "first" | "last";
  minWidth?: number | string; maxWidth?: number | string; minHeight?: number | string; maxHeight?: number | string;
};
export type LayoutOp = "add" | "remove" | "place" | "sizing" | "settings";
export type LayoutBody = {
  file?: string; op?: LayoutOp; ids?: string[]; id?: string; rects?: Record<string, Rect>;
  deep?: boolean; parent?: string | null; index?: number; absolute?: ({ x: number; y: number } | null)[];
  axis?: SizingAxis; mode?: SizingMode; layout?: Record<string, Json | null>;
  merge?: string; expectedRevision?: string; page?: string;
  /** place: the sibling the moved layers land right before (null: the end), instead of index. */
  before?: string | null;
  /** place: copies land there and the layers stay (Option-drag). */
  copy?: boolean;
  /** place on the canvas by an agent: keep the spot even where it overlaps another board (default: moved right until clear). */
  allowOverlap?: boolean;
  /** place: several destinations in one write and one undo step (a multi-selection dropped across frames); each
   * part is {ids, parent, before?, absolute?} and the top-level ids, parent, before and absolute are ignored. */
  parts?: PlacePart[];
};
export type PlacePart = { ids?: string[]; parent?: string | null; index?: number; before?: string | null; absolute?: ({ x: number; y: number } | null)[] };
export type LayoutResult = { ok: true; op: LayoutOp; label: string; select: string[]; revision?: string; changed: boolean; placed?: Placed[]; note?: string };

/** The gap and padding for a new auto layout frame with nothing to infer from. */
export const DEFAULT_GAP = 10;
export const DEFAULT_PADDING = 10;
export const LAYOUT_KEY = "canvasLayout";
const FRAME_KEYS = ["wrap", "crossGap", "crossAuto", "gapMode", "baseline", "stacking"] as const;
const SIZE_KEYS = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
const ALL_KEYS = new Set<string>([...FRAME_KEYS, ...SIZE_KEYS]);
const EPS = 0.5;

const invalid = (m: string) => new StructureError(400, "invalid", m);
const instance = (m: string) => new StructureError(409, "instance", m);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const r2 = (v: number) => {
  const x = Math.round(v * 100) / 100;
  return Object.is(x, -0) ? 0 : x;
};
const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const node = (doc: Doc, id: string) => findNode(doc as any, id).node;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const isFill = (v: unknown) => str(v).startsWith("fill_container");
const isHugValue = (v: unknown) => str(v).startsWith("fit_content");

// ---------------------------------------------------------------- inference (pure)

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** The flow order of boxes along a direction: by main-axis start, then cross start, then the order given. */
export function orderAlong(rs: Rect[], layout: Flow): number[] {
  const h = layout === "horizontal";
  return rs.map((_, i) => i).sort((i, j) => {
    const a = rs[i], b = rs[j];
    const d = h ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x;
    return d || i - j;
  });
}

/**
 * What a selection of loose layers looks like as auto layout (section 1.1): horizontal when their centres spread
 * more in x than in y (a tie: when their vertical extents overlap at least as much as their horizontal ones),
 * flow order by position, gap = the average space between neighbours (overlaps count 0) rounded to whole px, and
 * the cross alignment their shared edge or centre line says (start when nothing is shared).
 */
export function inferLayout(rs: Rect[]): Inference {
  if (rs.length < 2) return { layout: "vertical", gap: DEFAULT_GAP, alignItems: "start", order: rs.map((_, i) => i) };
  const cx = rs.map((r) => r.x + r.w / 2), cy = rs.map((r) => r.y + r.h / 2);
  const spreadX = Math.max(...cx) - Math.min(...cx), spreadY = Math.max(...cy) - Math.min(...cy);
  let layout: Flow;
  if (Math.abs(spreadX - spreadY) > EPS) layout = spreadX > spreadY ? "horizontal" : "vertical";
  else {
    let vy = 0, hx = 0;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      vy += overlap(rs[i].y, rs[i].y + rs[i].h, rs[j].y, rs[j].y + rs[j].h);
      hx += overlap(rs[i].x, rs[i].x + rs[i].w, rs[j].x, rs[j].x + rs[j].w);
    }
    layout = vy >= hx ? "horizontal" : "vertical";
  }
  const order = orderAlong(rs, layout);
  const h = layout === "horizontal";
  const start = (r: Rect) => (h ? r.x : r.y), size = (r: Rect) => (h ? r.w : r.h);
  const cs = (r: Rect) => (h ? r.y : r.x), csize = (r: Rect) => (h ? r.h : r.w);
  let sum = 0;
  for (let k = 1; k < order.length; k++) {
    const a = rs[order[k - 1]], b = rs[order[k]];
    sum += Math.max(0, start(b) - (start(a) + size(a)));
  }
  const gap = Math.round(sum / (order.length - 1));
  const same = (f: (r: Rect) => number) => rs.every((r) => Math.abs(f(r) - f(rs[0])) <= EPS);
  const alignItems: Align = same(cs) ? "start" : same((r) => cs(r) + csize(r) / 2) ? "center" : same((r) => cs(r) + csize(r)) ? "end" : "start";
  return { layout, gap, alignItems, order };
}

/** Padding that keeps content where it is in a frame: each side's distance from the frame edge to the content's union. */
export function inferPadding(frame: { w: number; h: number }, content: Rect[]): Padding4 {
  if (!content.length) return [DEFAULT_PADDING, DEFAULT_PADDING, DEFAULT_PADDING, DEFAULT_PADDING];
  const u = union(content);
  const c = (v: number) => Math.max(0, r2(v));
  return [c(u.y), c(frame.w - (u.x + u.w)), c(frame.h - (u.y + u.h)), c(u.x)];
}

/** The compact stored form of a padding: one number, [vertical, horizontal] or four; undefined when it is all 0. */
export function paddingValue(p: Padding4): Json | undefined {
  const [t, r, b, l] = p;
  if (t === 0 && r === 0 && b === 0 && l === 0) return undefined;
  if (t === r && r === b && b === l) return t;
  if (t === b && l === r) return [t, r];
  return [t, r, b, l];
}

/** A stored padding as four numbers (a $variable counts 0: the engine resolves it, this is for inference only). */
export function readPadding(v: unknown): Padding4 {
  const n = (x: unknown) => num(x) ?? 0;
  if (Array.isArray(v) && v.length === 2) return [n(v[0]), n(v[1]), n(v[0]), n(v[1])];
  if (Array.isArray(v) && v.length === 4) return [n(v[0]), n(v[1]), n(v[2]), n(v[3])];
  const x = n(v);
  return [x, x, x, x];
}

/** The resizing mode W or H shows for a node (absent sizes are the format's defaults: frames and groups hug, text follows textGrowth). */
export function sizeMode(n: DocNode, axis: SizingAxis): SizingMode {
  const v = n[axis];
  if (isFill(v)) return "fill";
  if (isHugValue(v)) return "hug";
  if (v !== undefined) return "fixed";
  if (n.type === "frame" || n.type === "group") return "hug";
  if (n.type === "text") {
    const g = str(n.textGrowth) || "auto";
    return axis === "width" ? (g === "auto" ? "hug" : "fixed") : g === "fixed-width-height" ? "fixed" : "hug";
  }
  return "fixed";
}

/** A drag slot counted in the list as drawn (the moved layers still in it) as place's final index. */
export function slotToIndex(kids: string[], ids: string[], slot: number): number {
  const moving = new Set(ids);
  let at = 0;
  for (let i = 0; i < Math.min(slot, kids.length); i++) if (!moving.has(kids[i])) at++;
  return at;
}

// ---------------------------------------------------------------- metadata.canvasLayout (pure)

/** A node's Canvas-only layout settings ({} when it has none). */
export function readCanvasLayout(n: DocNode | Record<string, unknown> | undefined): CanvasLayout {
  const m = n?.metadata;
  const c = isObj(m) ? m[LAYOUT_KEY] : undefined;
  return isObj(c) ? ({ ...c } as CanvasLayout) : {};
}

const isDefault = (k: string, v: Json | null | undefined) =>
  v === null || v === undefined || v === false || v === 0 || (k === "stacking" && v === "last") || (k === "gapMode" && v === "between");

function checkKey(k: string, v: Json | null): void {
  if (!ALL_KEYS.has(k)) throw invalid(`unknown auto layout setting "${k}"; use ${[...ALL_KEYS].join(", ")}`);
  if (v === null) return;
  const numeric = (x: unknown) => num(x) !== undefined || (typeof x === "string" && /^\$[\w./-]+$/.test(x));
  const ok = k === "wrap" || k === "crossAuto" || k === "baseline" ? typeof v === "boolean"
    : k === "gapMode" ? v === "between" || v === "around" || v === "evenly"
    : k === "stacking" ? v === "first" || v === "last"
    : numeric(v) && (typeof v !== "number" || v >= 0);
  if (!ok) throw invalid(`auto layout setting ${k}: ${JSON.stringify(v)} is not a valid value`);
}

/**
 * The metadata a node gets when `patch` lands in its canvasLayout: null (or the default) removes a key, others
 * set it. Keeps metadata's `type` and every key someone else put there; null when nothing is left to keep.
 */
export function mergeCanvasLayout(current: unknown, patch: Record<string, Json | null | undefined>): Json | null {
  const m: Record<string, Json> = isObj(current) ? { ...current } : {};
  const c: Record<string, Json> = isObj(m[LAYOUT_KEY]) ? { ...(m[LAYOUT_KEY] as Record<string, Json>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (isDefault(k, v)) delete c[k];
    else c[k] = v as Json;
  }
  if (Object.keys(c).length) m[LAYOUT_KEY] = c;
  else delete m[LAYOUT_KEY];
  const keys = Object.keys(m);
  if (!keys.length || (keys.length === 1 && m.type === "canvas")) return null;
  return { type: typeof m.type === "string" ? m.type : "canvas", ...m };
}

/** The props a settings patch writes on a node: metadata plus the closest native value a reader without the metadata draws (section 2). */
export function settingsProps(n: DocNode, patch: Record<string, Json | null>): { set: Record<string, Json>; remove: string[] } {
  const set: Record<string, Json> = {};
  const remove: string[] = [];
  const meta: Record<string, Json | null> = {};
  const had = readCanvasLayout(n);
  for (const [k, v] of Object.entries(patch)) {
    checkKey(k, v);
    if ((FRAME_KEYS as readonly string[]).includes(k) && n.type !== "frame") throw invalid(`${k} is a frame setting; ${String(n.name ?? n.id)} is a ${n.type}`);
    if (k === "gapMode") {
      // Auto gap: Between and Around are native; Evenly is Canvas's, with Around as the native fallback. null turns Auto off.
      if (v === null) { if (str(n.justifyContent).startsWith("space_")) remove.push("justifyContent"); meta.gapMode = null; }
      else { set.justifyContent = v === "between" ? "space_between" : "space_around"; meta.gapMode = v === "evenly" ? v : null; }
    } else if (k === "baseline") {
      if (v === true) set.alignItems = "end";
      else if (had.baseline && n.alignItems === "end") remove.push("alignItems");
      meta.baseline = v;
    } else meta[k] = v;
  }
  const next = mergeCanvasLayout(n.metadata, meta);
  if (next === null) { if (n.metadata !== undefined) remove.push("metadata"); }
  else set.metadata = next;
  return { set, remove };
}

// ---------------------------------------------------------------- helpers on the document

const PATH = (what: string) => `lives inside a component instance; ${what} the instance, or edit the component`;
function checkIds(ids: unknown, what: string): string[] {
  if (!Array.isArray(ids) || !ids.length) throw invalid("ids is required");
  for (const id of ids) if (typeof id === "string" && id.includes("/")) throw instance(`"${id}" ${PATH(what)}`);
  return ids as string[];
}
const parentOf = (doc: Doc, id: string): DocNode | null => {
  const p = placeOf(doc, id)?.parent;
  return p ? node(doc, p) : null;
};
const inFlow = (parent: DocNode | null, n: DocNode) => placesChildren(parent) && n.layoutPosition !== "absolute";

/**
 * An inspector edit's props for one layer: x and y of a layer auto layout places mean nothing (the panel greys them out),
 * so they are left out, unless the same edit takes the layer out of the flow (layoutPosition). A Mixed X typed for
 * a free layer and an auto layout child moves only the free one.
 */
export function withoutPlacedXY(parent: DocNode | null, n: DocNode, props: Record<string, Json>): Record<string, Json> {
  if (!("x" in props || "y" in props) || "layoutPosition" in props || !inFlow(parent, n)) return props;
  const out = { ...props };
  delete out.x;
  delete out.y;
  return out;
}

/** A node's world rect: the page's, else worked out from the file where positions are numbers (undefined in a flow without rects). */
export function worldOf(doc: Doc, id: string, rects: Record<string, Rect> = {}): Rect | undefined {
  if (rects[id]) return rects[id];
  const p = placeOf(doc, id);
  if (!p) return undefined;
  const n = p.node;
  const w = num(n.width) ?? 0, h = num(n.height) ?? 0;
  if (!p.parent) return { x: num(n.x) ?? 0, y: num(n.y) ?? 0, w, h };
  const parent = node(doc, p.parent);
  if (inFlow(parent, n)) return undefined;
  const pw = worldOf(doc, p.parent, rects);
  return pw ? { x: pw.x + (num(n.x) ?? 0), y: pw.y + (num(n.y) ?? 0), w, h } : undefined;
}

/**
 * Where a frame's flow children sit without the page's measurements, worked out from the file's numbers the way
 * the engine lays them out: padding, gap, fixed sizes, Fill sharing the free space, justifyContent (start,
 * center, end, space_between, space_around) and alignItems. Only for removing auto layout with Canvas closed.
 * A size the file does not hold (a hugging frame, auto-width text, a $variable) or a wrapped flow is refused
 * instead of guessed: the page measures those.
 */
function approxFlow(f: DocNode): { boxes: Map<string, Rect>; w: number; h: number } {
  const hz = (str(f.layout) || "horizontal") === "horizontal";
  const [pt, pr, pb, pl] = readPadding(f.padding);
  const fname = String(f.name ?? f.id);
  const refuse = (why: string) => invalid(`${why}, so where its layers sit is not in the file; open the file in Canvas to remove auto layout from ${fname}`);
  if (readCanvasLayout(f).wrap) throw refuse(`${fname} wraps`);
  const gap0 = num(f.gap) ?? 0;
  const kids = ((f.children as DocNode[] | undefined) ?? []).filter((k) => k.layoutPosition !== "absolute" && k.enabled !== false);
  const main: SizingAxis = hz ? "width" : "height", cross: SizingAxis = hz ? "height" : "width";
  const sizeOf = (k: DocNode, axis: SizingAxis): number | "fill" => {
    const v = k[axis];
    if (num(v) !== undefined) return num(v)!;
    if (isFill(v)) return "fill";
    if (v === undefined && sizeMode(k, axis) === "fixed") return 0;
    // A hugging auto layout frame: the size its own flow gives it.
    if (sizeMode(k, axis) === "hug" && placesChildren(k)) { const a = approxFlow(k); return axis === "width" ? a.w : a.h; }
    throw refuse(`the ${axis} of ${String(k.name ?? k.id)} is not a number`);
  };
  const ms = kids.map((k) => sizeOf(k, main)), cs = kids.map((k) => sizeOf(k, cross));
  const [padS, padE, padCS, padCE] = hz ? [pl, pr, pt, pb] : [pt, pb, pl, pr];
  const fixedMain = ms.reduce<number>((a, v) => a + (v === "fill" ? 0 : v), 0);
  const fills = ms.filter((v) => v === "fill").length;
  const gaps = gap0 * Math.max(0, kids.length - 1);
  const frameSize = (axis: SizingAxis, hug: () => number) => {
    const v = num(f[axis]);
    if (v !== undefined) return v;
    if (sizeMode(f, axis) === "hug") return hug();
    throw refuse(`the ${axis} of ${fname} is not a number`);
  };
  const fm = frameSize(main, () => padS + padE + fixedMain + gaps);
  const fc = frameSize(cross, () => padCS + padCE + Math.max(0, ...cs.map((v) => (v === "fill" ? 0 : v))));
  const innerM = fm - padS - padE, innerC = fc - padCS - padCE;
  const fillSize = fills ? Math.max(0, (innerM - fixedMain - gaps) / fills) : 0;
  const mains = ms.map((v) => (v === "fill" ? fillSize : v));
  const free = innerM - mains.reduce((a, v) => a + v, 0) - gaps;
  const n = kids.length;
  let off = 0, gap = gap0;
  switch (str(f.justifyContent)) {
    case "center": off = free / 2; break;
    case "end": off = free; break;
    case "space_between": if (n > 1 && free > 0) gap += free / (n - 1); break;
    case "space_around": if (free > 0) { gap += free / n; off = free / (2 * n); } else off = free / 2; break;
  }
  const align = str(f.alignItems) || "start";
  const boxes = new Map<string, Rect>();
  let at = padS + off;
  kids.forEach((k, i) => {
    const m = mains[i], c = cs[i] === "fill" ? innerC : (cs[i] as number);
    const coff = cs[i] === "fill" ? 0 : align === "center" ? (innerC - c) / 2 : align === "end" ? innerC - c : 0;
    boxes.set(String(k.id), hz ? { x: at, y: padCS + coff, w: m, h: c } : { x: padCS + coff, y: at, w: c, h: m });
    at += m + gap;
  });
  return { boxes, w: hz ? fm : fc, h: hz ? fc : fm };
}

/**
 * Move `ids` (in this order) into `parent` so the first sits at `index` of the list without them, the rest right
 * after it. Each lands right after the layer that comes before it in the final list, so siblings keep their order.
 */
function moveBlock(rec: Recorder, ids: string[], parent: string | null, index: number): void {
  const moving = new Set(ids);
  const others = rec.kids(parent).filter((n) => !moving.has(String(n.id))).map((n) => String(n.id));
  const at = Math.max(0, Math.min(index, others.length));
  const final = [...others.slice(0, at), ...ids, ...others.slice(at)];
  for (const [k, id] of ids.entries()) {
    const pos = at + k;
    const before = pos > 0 ? final[pos - 1] : null;
    const p = placeOf(rec.doc, id)!;
    // The index after the predecessor once this layer is out of the list.
    const list = rec.kids(parent).filter((n) => String(n.id) !== id);
    const to = before === null ? 0 : list.findIndex((n) => String(n.id) === before) + 1;
    if (p.parent === parent && p.index === to) continue;
    rec.move(id, parent, to);
  }
}

// ---------------------------------------------------------------- add (Shift+A)

/**
 * Add auto layout. One frame without auto layout becomes an auto layout frame (inferred from its content);
 * anything else (loose layers, several layers, a frame that already has auto layout) is wrapped in a new auto
 * layout frame where the selection was. Instance layers are refused.
 */
export function addAutoLayout(doc: Doc, ids: string[], rects: Record<string, Rect> = {}): OpResult {
  const list = normalize(doc, checkIds(ids, "add auto layout to"), "add auto layout to");
  if (list.length === 1) {
    const n = node(doc, list[0]);
    if (n.type === "frame" && !placesChildren(n)) return layoutFrame(doc, n, rects);
  }
  return wrapInFrame(doc, list, rects);
}

function layoutFrame(doc: Doc, f: DocNode, rects: Record<string, Rect>): OpResult {
  const fid = String(f.id);
  const kids = [...((f.children as DocNode[] | undefined) ?? [])];
  const flow = kids.filter((k) => k.layoutPosition !== "absolute");
  const boxes = new Map(flow.map((k) => [String(k.id), boxOf(doc, String(k.id), rects)]));
  const shown = flow.filter((k) => k.enabled !== false);
  const inf = inferLayout(shown.map((k) => boxes.get(String(k.id))!));
  const fr = rects[fid];
  const fw = num(f.width) ?? fr?.w ?? 0, fh = num(f.height) ?? fr?.h ?? 0;
  const rec = new Recorder(doc);
  const set: Record<string, Json> = { layout: inf.layout };
  const remove: string[] = [];
  const gap = shown.length >= 2 ? inf.gap : DEFAULT_GAP;
  const pad = paddingValue(inferPadding({ w: fw, h: fh }, shown.map((k) => boxes.get(String(k.id))!)));
  if (gap) set.gap = gap; else if ("gap" in f) remove.push("gap");
  if (pad !== undefined) set.padding = pad; else if ("padding" in f) remove.push("padding");
  if (inf.alignItems !== "start") set.alignItems = inf.alignItems; else if ("alignItems" in f) remove.push("alignItems");
  // Hug both axes, except where the frame fills its own auto layout parent (it keeps Fill), where a
  // shown child fills that axis (Hug + Fill cannot be) or there is nothing to hug.
  const fillsParent = (axis: SizingAxis) => isFill(f[axis]) && inFlow(parentOf(doc, fid), f);
  for (const axis of ["width", "height"] as const) {
    const size = axis === "width" ? fw : fh;
    if (fillsParent(axis)) continue;
    if (!shown.length || shown.some((k) => isFill(k[axis]))) { if (num(f[axis]) === undefined && size) set[axis] = r2(size); }
    else set[axis] = "fit_content";
  }
  rec.props(fid, set, remove);
  // Flow order is visual order: the flow children take the slots flow children had, absolute ones stay put.
  const sorted = orderAlong(flow.map((k) => boxes.get(String(k.id))!), inf.layout).map((i) => flow[i]);
  const slots = kids.map((k, i) => (k.layoutPosition !== "absolute" ? i : -1)).filter((i) => i >= 0);
  const want = [...kids];
  slots.forEach((s, k) => (want[s] = sorted[k]));
  want.forEach((k, i) => rec.move(String(k.id), fid, i));
  for (const k of flow) {
    const drop = ["x", "y"].filter((key) => key in k);
    if (drop.length) rec.props(String(k.id), {}, drop);
  }
  return { label: "Add Auto Layout", select: [fid], ops: rec.ops };
}

function wrapInFrame(doc: Doc, list: string[], rects: Record<string, Rect>): OpResult {
  const places = list.map((id) => ({ id, p: placeOf(doc, id)! }));
  const parent = places[0].p.parent;
  if (places.some((x) => x.p.parent !== parent)) throw invalid("Select layers that share one parent to add auto layout around them");
  const parentNode = parent ? node(doc, parent) : null;
  if (parentNode?.type === "ref") throw instance("layers inside an instance cannot be wrapped");
  places.sort((a, b) => a.p.index - b.p.index);
  const flowParent = placesChildren(parentNode);
  const boxes = places.map(({ id }) => boxOf(doc, id, rects));
  // Layers placed by auto layout without the page's measurements: keep the parent's direction, gap and order.
  const unmeasured = flowParent && places.some(({ id, p }) => p.node.layoutPosition !== "absolute" && !(rects[id] && rects[parent!]));
  let inf = inferLayout(boxes);
  if (unmeasured) inf = { layout: (str(parentNode!.layout) || "horizontal") as Flow, gap: num(parentNode!.gap) ?? 0, alignItems: "start", order: places.map((_, i) => i) };
  const u = union(boxes);
  const taken = allIds(doc as any);
  const shell: DocNode = { type: "frame", id: newId(taken), name: nextName(doc as never, "Frame"), layout: inf.layout, width: "fit_content", height: "fit_content", children: [] };
  if (inf.gap) shell.gap = inf.gap;
  if (inf.alignItems !== "start") shell.alignItems = inf.alignItems;
  const allAbsolute = flowParent && places.every(({ p }) => p.node.layoutPosition === "absolute");
  if (!flowParent) Object.assign(shell, { x: r2(u.x), y: r2(u.y) });
  else if (allAbsolute) Object.assign(shell, { x: r2(u.x), y: r2(u.y), layoutPosition: "absolute" });
  const rec = new Recorder(doc);
  // In a flow it takes the first layer's place; elsewhere it sits where the top-most layer was in the stack.
  rec.insert(parent, flowParent && !allAbsolute ? places[0].p.index : places[places.length - 1].p.index + 1, shell);
  const fid = String(shell.id);
  inf.order.forEach((i, k) => {
    const { id } = places[i];
    rec.move(id, fid, k);
    const n = node(doc, id), b = boxes[i];
    const set: Record<string, Json> = {};
    // The new frame hugs: a layer that filled its old parent keeps the size it was drawn at.
    if (isFill(n.width) && b.w) set.width = r2(b.w);
    if (isFill(n.height) && b.h) set.height = r2(b.h);
    rec.props(id, set, ["x", "y", "layoutPosition"].filter((key) => key in n));
  });
  return { label: "Add Auto Layout", select: [fid], ops: rec.ops };
}

// ---------------------------------------------------------------- remove (Option+Shift+A)

const LAYOUT_ONLY = ["gap", "padding", "justifyContent", "alignItems", "layoutIncludeStroke"];

/**
 * Remove auto layout: the frame becomes layout "none" at its current size (Fixed), each flow child gets the
 * x/y it is drawn at (from rects; without them, from a plain pass over the file's numbers) and Fill children
 * become Fixed at their size. `deep` does the same to every nested auto layout frame. Instances are refused.
 */
export function removeAutoLayout(doc: Doc, ids: string[], rects: Record<string, Rect> = {}, deep = false): OpResult {
  const list = normalize(doc, checkIds(ids, "remove auto layout from"), "remove auto layout from");
  const frames: string[] = [];
  const visit = (n: DocNode, top: boolean) => {
    if (n.type === "ref") { if (top) throw instance(`${String(n.name ?? n.id)} is a component instance; detach it to remove its auto layout`); return; }
    if (placesChildren(n)) frames.push(String(n.id));
    if (deep) for (const c of (n.children as DocNode[] | undefined) ?? []) visit(c, false);
  };
  for (const id of list) visit(node(doc, id), true);
  if (!frames.length) throw invalid("nothing to remove: the selection has no auto layout");
  // Measure everything first: removing one frame's layout must not change what the next one reads.
  const plans = frames.map((fid) => {
    const f = node(doc, fid);
    const fr = rects[fid];
    const all = (f.children as DocNode[] | undefined) ?? [];
    // The file's numbers only when the page did not measure the frame or a shown flow child.
    const approx = !fr || all.some((k) => k.layoutPosition !== "absolute" && k.enabled !== false && !rects[String(k.id)]) ? approxFlow(f) : undefined;
    const hz = (str(f.layout) || "horizontal") === "horizontal";
    const [pt, , , pl] = readPadding(f.padding);
    const gap = num(f.gap) ?? 0;
    let prev: Rect | undefined;
    const kids = all.map((k) => {
      const cid = String(k.id), r = rects[cid];
      const flowing = k.layoutPosition !== "absolute";
      const unplaced = flowing && k.enabled === false && !(r && fr);
      let box: Rect | undefined;
      if (flowing && !unplaced) {
        box = r && fr ? { x: r.x - fr.x, y: r.y - fr.y, w: r.w, h: r.h } : approx!.boxes.get(cid);
        if (box) prev = box;
      }
      return { k, cid, flowing, box, unplaced };
    });
    // A hidden layer has no place drawn. Where it would sit is taken by the next shown layer, so it would land on
    // top of that one when shown again: it goes after the last layer of the flow instead (one after another).
    for (const kid of kids) {
      if (!kid.unplaced) continue;
      const w = num(kid.k.width) ?? 0, h = num(kid.k.height) ?? 0;
      kid.box = !prev ? { x: pl, y: pt, w, h } : hz ? { x: prev.x + prev.w + gap, y: prev.y, w, h } : { x: prev.x, y: prev.y + prev.h + gap, w, h };
      prev = kid.box;
    }
    return { f, fid, w: fr?.w ?? num(f.width) ?? approx!.w, h: fr?.h ?? num(f.height) ?? approx!.h, kids };
  });
  const rec = new Recorder(doc);
  for (const { f, fid, w, h, kids } of plans) {
    const set: Record<string, Json> = { layout: "none" };
    const remove = LAYOUT_ONLY.filter((k) => k in f);
    // Hug (absent or fit_content) and Fill become Fixed at the size drawn; a number or a $variable stays.
    for (const [axis, size] of [["width", w], ["height", h]] as const) {
      const v = f[axis];
      if (v === undefined || isFill(v) || isHugValue(v)) set[axis] = r2(size);
    }
    const frameKeys = Object.fromEntries(FRAME_KEYS.map((k) => [k, null]));
    if (Object.keys(readCanvasLayout(f)).some((k) => (FRAME_KEYS as readonly string[]).includes(k))) {
      const m = mergeCanvasLayout(f.metadata, frameKeys);
      if (m === null) remove.push("metadata"); else set.metadata = m;
    }
    rec.props(fid, set, remove);
    for (const { k, cid, flowing, box } of kids) {
      const cs: Record<string, Json> = {};
      const cr: string[] = [];
      if (!flowing) { if ("layoutPosition" in k) cr.push("layoutPosition"); }
      else {
        cs.x = r2(box?.x ?? 0);
        cs.y = r2(box?.y ?? 0);
        // Fill needs an auto layout parent: it becomes Fixed at the size it is drawn at.
        if (isFill(k.width) && box) cs.width = r2(box.w);
        if (isFill(k.height) && box) cs.height = r2(box.h);
      }
      rec.props(cid, cs, cr);
    }
  }
  return { label: "Remove Auto Layout", select: list, ops: rec.ops };
}

// ---------------------------------------------------------------- place (reorder, drag in, drag out)

/** Move layers to a parent and index (see the top of this file). Same place: no ops. */
export function placeNodes(doc: Doc, ids: string[], parent: string | null, index: number | undefined, opts: { absolute?: ({ x: number; y: number } | null)[]; rects?: Record<string, Rect>; before?: string | null } = {}): OpResult {
  checkIds(ids, "move");
  if (typeof parent === "string" && parent.includes("/")) throw instance(`"${parent}" ${PATH("move layers into")}`);
  if (parent !== null && typeof parent !== "string") throw invalid("parent is a frame or group id, or null for the document");
  const anchored = opts.before !== undefined;
  if (anchored && opts.before !== null && typeof opts.before !== "string") throw invalid("before is a sibling id, or null for the end");
  if (!anchored && (typeof index !== "number" || !Number.isInteger(index) || index < 0)) throw invalid("index is a whole number from 0");
  const rects = opts.rects ?? {};
  // Keep the caller's absolute list lined up with its ids after normalize puts them in document order.
  const absBy = new Map<string, { x: number; y: number }>();
  ids.forEach((id, i) => {
    const a = opts.absolute?.[i];
    if (a && num(a.x) !== undefined && num(a.y) !== undefined) absBy.set(id, a);
  });
  const list = normalize(doc, ids, "move");
  let target: DocNode | null = null;
  if (parent !== null) {
    const p = placeOf(doc, parent);
    if (!p) throw new StructureError(404, "not_found", `no node "${parent}"`);
    target = p.node;
    if (target.type === "ref") throw instance(`${String(target.name ?? parent)} is a component instance; layers cannot go inside it`);
    if (target.type !== "frame" && target.type !== "group") throw invalid(`"${parent}" is a ${target.type}; only frames and groups hold layers`);
    const inside = new Set(list);
    const chain = [parent, ...findNode(doc as any, parent).ancestors.map((x: DocNode) => String(x.id))];
    for (const a of chain) {
      if (inside.has(a)) throw invalid("a layer cannot move into itself or a layer inside it");
    }
    // An instance inside its own component (or inside a component it uses) would draw itself forever.
    const uses = componentsUsed(doc, list);
    const loop = chain.find((a) => uses.has(a));
    if (loop) throw new StructureError(409, "cycle", `${String(node(doc, loop).name ?? loop)} is a component the moved layers use; an instance cannot go inside its own component`);
  }
  if (anchored) {
    // The sibling to land before, in the file's full list (hidden layers included): the page counts only what it draws.
    const moving = new Set(list);
    const others = (parent === null ? doc.children : ((target!.children as DocNode[] | undefined) ?? [])).map((n) => String(n.id)).filter((id) => !moving.has(id));
    if (opts.before === null) index = others.length;
    else {
      index = others.indexOf(opts.before!);
      if (index < 0) throw invalid(`before: "${opts.before}" is not one of ${parent ?? "the document"}'s other children`);
    }
  }
  const flowTarget = placesChildren(target);
  const pw = parent === null ? { x: 0, y: 0, w: 0, h: 0 } : worldOf(doc, parent, rects);
  const before = list.map((id) => {
    const p = placeOf(doc, id)!;
    return { id, from: p.parent, world: worldOf(doc, id, rects), n: p.node };
  });
  const rec = new Recorder(doc);
  moveBlock(rec, list, parent, index!);
  let parentFix: Record<string, Json> | undefined;
  for (const { id, from, world, n } of before) {
    const abs = absBy.get(id);
    const set: Record<string, Json> = {};
    const remove: string[] = [];
    if (flowTarget && !abs) remove.push(...["x", "y", "layoutPosition"].filter((k) => k in n));
    else {
      let at = abs;
      if (!at && world && pw) at = { x: world.x - pw.x, y: world.y - pw.y };
      if (!at && from === parent && num(n.x) !== undefined && num(n.y) !== undefined) at = { x: n.x as number, y: n.y as number };
      at ??= { x: 0, y: 0 };
      set.x = r2(at.x);
      set.y = r2(at.y);
      if (flowTarget) set.layoutPosition = "absolute";
      else if ("layoutPosition" in n) remove.push("layoutPosition");
      // Out of a flow (or absolute in one): Fill has nothing to fill, it keeps the size it was drawn at.
      if (isFill(n.width) && world?.w) set.width = r2(world.w);
      if (isFill(n.height) && world?.h) set.height = r2(world.h);
    }
    // Into a hugging flow parent: a Fill layer makes that axis Fixed (Hug + Fill cannot be).
    if (flowTarget && !abs && target) for (const axis of ["width", "height"] as const) {
      if (isFill(n[axis]) && sizeMode(target, axis) === "hug" && pw && (axis === "width" ? pw.w : pw.h)) (parentFix ??= {})[axis] = r2(axis === "width" ? pw.w : pw.h);
    }
    rec.props(id, set, remove);
  }
  if (parentFix && parent) rec.props(parent, parentFix);
  const moved = before.filter((b) => b.from !== parent);
  const label = !moved.length ? "Reorder" : flowTarget && !absBy.size ? "Move Into Frame" : before.some((b) => b.from !== null && placesChildren(node(doc, b.from)) && b.n.layoutPosition !== "absolute") ? "Move Out of Frame" : "Move Into Frame";
  // Groups fit their layers again: the ones that lost a layer (an empty one goes) and the one that gained them.
  fitAround(doc, [...before.map((b) => b.from), parent], (id, p) => rec.props(id, p), (id) => rec.remove(id));
  return { label, select: list, ops: rec.ops };
}

/**
 * Option-drag into a frame, onto a board or the canvas: copies of the layers land where placeNodes would put the
 * layers themselves; the originals stay. One op list (the copies made on top of their originals, then placed), so
 * one undo step. Selects the copies.
 */
export function placeCopies(doc: Doc, ids: string[], parent: string | null, index: number | undefined, opts: { absolute?: ({ x: number; y: number } | null)[]; rects?: Record<string, Rect>; before?: string | null } = {}): OpResult {
  checkIds(ids, "duplicate");
  const dup = duplicateNodes(doc, ids, opts.rects ?? {}, { exact: true });
  const keep = ids.filter((id) => dup.copies.has(id));
  const copyIds = keep.map((id) => dup.copies.get(id)!);
  const rects: Record<string, Rect> = { ...(opts.rects ?? {}) };
  for (const id of keep) if (rects[id]) rects[dup.copies.get(id)!] = rects[id];
  const absolute = opts.absolute ? keep.map((id) => opts.absolute![ids.indexOf(id)] ?? null) : undefined;
  const placed = placeNodes(doc, copyIds, parent, index, { ...opts, rects, ...(absolute ? { absolute } : {}) });
  return { label: "Duplicate", select: placed.select, ops: [...dup.ops, ...placed.ops] };
}

/** Every component the subtrees of `ids` use, through instances and the components those use in turn. */
function componentsUsed(doc: Doc, ids: string[]): Set<string> {
  const out = new Set<string>();
  const todo: DocNode[] = [];
  const scan = (n: DocNode) => {
    if ((n.type === "ref" || !n.type) && typeof n.ref === "string" && !out.has(n.ref)) {
      out.add(n.ref);
      try { todo.push(node(doc, n.ref)); } catch { /* a missing component: nothing more to follow */ }
    }
    for (const c of (n.children as DocNode[] | undefined) ?? []) scan(c);
    for (const d of Object.values((n.descendants as Record<string, DocNode> | undefined) ?? {})) if (d && typeof d === "object") scan(d);
  };
  for (const id of ids) scan(node(doc, id));
  while (todo.length) scan(todo.pop()!);
  return out;
}

// ---------------------------------------------------------------- sizing (Fixed / Hug / Fill)

/**
 * Set W or H's resizing mode. Fill needs an auto layout parent (the layer in its flow); Hug works on auto layout
 * frames (not while a child fills that axis) and text (textGrowth); Fixed writes the size it is drawn at. A Fill
 * child under a parent that hugs that axis makes the parent Fixed at its size, in the same step.
 */
export function setSizing(doc: Doc, id: string, axis: SizingAxis, mode: SizingMode, rects: Record<string, Rect> = {}): OpResult {
  if (typeof id !== "string" || !id) throw invalid("id is required");
  if (id.includes("/")) throw instance(`"${id}" ${PATH("resize")}`);
  if (axis !== "width" && axis !== "height") throw invalid('axis is "width" or "height"');
  if (mode !== "fixed" && mode !== "hug" && mode !== "fill") throw invalid('mode is "fixed", "hug" or "fill"');
  const p = placeOf(doc, id);
  if (!p) throw new StructureError(404, "not_found", `no node "${id}"`);
  const n = p.node;
  const parent = p.parent ? node(doc, p.parent) : null;
  const w = worldOf(doc, id, rects);
  const size = (axis === "width" ? w?.w : w?.h) ?? num(n[axis]);
  const rec = new Recorder(doc);
  const set: Record<string, Json> = {};
  const remove: string[] = [];
  const text = n.type === "text";
  const growth = str(n.textGrowth) || "auto";
  const name = String(n.name ?? id);
  if (mode === "fill") {
    if (!inFlow(parent, n)) throw invalid(`Fill container works on layers in an auto layout frame; ${name} is not in one`);
    set[axis] = "fill_container";
    if (text) {
      if (axis === "width" && growth === "auto") set.textGrowth = "fixed-width";
      if (axis === "height") { set.textGrowth = "fixed-width-height"; if (num(n.width) === undefined && !isFill(n.width) && w?.w) set.width = r2(w.w); }
    }
  } else if (mode === "hug") {
    if (text) {
      if (axis === "width") { set.textGrowth = "auto"; remove.push(...["width", "height"].filter((k) => k in n)); }
      else { if (growth === "fixed-width-height") set.textGrowth = "fixed-width"; if ("height" in n) remove.push("height"); }
    } else if (n.type === "ref" && typeof n.ref === "string") {
      // An instance hugs the way its component lays out: an auto layout component that hugs this axis just drops
      // the instance's own size (it follows the component again); one with a set size gets fit_content.
      let comp: DocNode | null = null;
      try { comp = node(doc, n.ref) as DocNode; } catch { comp = null; }
      const flows = comp && (placesChildren({ ...comp, ...n, type: comp.type } as DocNode) || placesChildren(comp));
      if (!comp || !flows) throw invalid(`Hug contents works on auto layout frames and text; the component of ${name} has no auto layout`);
      if (sizeMode(comp, axis) === "hug" && axis in n) remove.push(axis);
      else set[axis] = "fit_content";
    } else if (placesChildren(n)) {
      const filler = ((n.children as DocNode[] | undefined) ?? []).find((k) => k.layoutPosition !== "absolute" && k.enabled !== false && isFill(k[axis]));
      if (filler) throw invalid(`Hug contents is off while a layer inside fills the ${axis} (${String(filler.name ?? filler.id)})`);
      set[axis] = "fit_content";
    } else throw invalid(`Hug contents works on auto layout frames and text; ${name} is a ${n.type === "frame" ? "frame without auto layout" : n.type}`);
  } else {
    if (size === undefined) throw invalid(`the size of ${name} is not known; send rects from the page`);
    set[axis] = r2(size);
    if (text) {
      if (axis === "width" && growth === "auto") set.textGrowth = "fixed-width";
      if (axis === "height") { set.textGrowth = "fixed-width-height"; if (num(n.width) === undefined && w?.w) set.width = r2(w.w); }
    }
  }
  rec.props(id, set, remove);
  if (mode === "fill" && parent && sizeMode(parent, axis) === "hug") {
    const pr = worldOf(doc, String(parent.id), rects);
    const ps = axis === "width" ? pr?.w : pr?.h;
    if (ps) rec.props(String(parent.id), { [axis]: r2(ps) });
  }
  return { label: "Size Change", select: [id], ops: rec.ops };
}

// ---------------------------------------------------------------- settings (metadata.canvasLayout)

/**
 * Write Canvas-only layout settings (wrap, min/max, evenly, baseline, first on top...) with their native fallbacks.
 * Turning Wrap on where the main axis hugs makes that axis Fixed at the size drawn (a hugging row never
 * runs out of room, so it would never break a line).
 */
export function layoutSettings(doc: Doc, ids: string[], patch: Record<string, Json | null>, rects: Record<string, Rect> = {}): OpResult {
  if (!isObj(patch) || !Object.keys(patch).length) throw invalid("layout is required: the settings to change");
  const list = normalize(doc, checkIds(ids, "change"), "change");
  const rec = new Recorder(doc);
  for (const id of list) {
    const n = node(doc, id);
    if (n.type === "ref" && Object.keys(patch).some((k) => (FRAME_KEYS as readonly string[]).includes(k))) throw instance(`${String(n.name ?? id)} is a component instance; change its component`);
    const { set, remove } = settingsProps(n, patch);
    if (patch.wrap === true && placesChildren(n)) {
      const axis: SizingAxis = (str(n.layout) || "horizontal") === "vertical" ? "height" : "width";
      if (sizeMode(n, axis) === "hug") {
        const r = rects[id] ?? approxFlow(n);
        set[axis] = r2(axis === "width" ? r.w : r.h);
      }
    }
    rec.props(id, set, remove);
  }
  return { label: "Auto Layout Settings", select: list, ops: rec.ops };
}

// ---------------------------------------------------------------- writing

class NoChange extends Error {}

function apply(doc: Doc, b: LayoutBody, rects: Record<string, Rect>): OpResult {
  switch (b.op) {
    case "add": return addAutoLayout(doc, b.ids ?? [], rects);
    case "remove": return removeAutoLayout(doc, b.ids ?? [], rects, b.deep === true);
    case "place": {
      const one = (p: PlacePart): OpResult => {
        if (!("parent" in p)) throw invalid("parent is required (null for the document)");
        if (p.absolute !== undefined && !Array.isArray(p.absolute)) throw invalid("absolute is a list of {x, y} (or null), one per id");
        const opts = { absolute: p.absolute, rects, ...("before" in p ? { before: p.before } : {}) };
        return b.copy === true ? placeCopies(doc, p.ids ?? [], p.parent ?? null, p.index, opts) : placeNodes(doc, p.ids ?? [], p.parent ?? null, p.index, opts);
      };
      if (b.parts === undefined) return one(b);
      if (!Array.isArray(b.parts) || !b.parts.length || b.parts.some((p) => !isObj(p))) throw invalid("parts is a list of {ids, parent, before | index, absolute?}");
      // One after another on the same document: one op list, so one write and one undo step.
      const outs = b.parts.map(one);
      const moved = outs.find((o) => o.label !== "Reorder");
      return { label: (moved ?? outs[0]).label, select: outs.flatMap((o) => o.select), ops: outs.flatMap((o) => o.ops) };
    }
    case "sizing": return setSizing(doc, b.id ?? "", b.axis as SizingAxis, b.mode as SizingMode, rects);
    case "settings": return layoutSettings(doc, b.ids ?? (b.id ? [b.id] : []), b.layout as Record<string, Json | null>, rects);
    default: throw invalid(`unknown op "${b.op}"; use add, remove, place, sizing or settings`);
  }
}

/** Run one auto layout op on a document: one write, one undo step (none when nothing changes). */
export function runLayout(docFile: string, b: LayoutBody, who: Who): LayoutResult {
  const op = b.op as LayoutOp;
  const rects = isObj(b.rects) ? (b.rects as unknown as Record<string, Rect>) : {};
  const parts: PlacePart[] | null = op === "place" && Array.isArray(b.parts) ? b.parts.filter((p) => isObj(p)) : null;
  const ids = (parts ? parts.flatMap((p) => (Array.isArray(p.ids) ? p.ids : [])) : [...(Array.isArray(b.ids) ? b.ids : []), ...(typeof b.id === "string" ? [b.id] : [])]).filter((x) => typeof x === "string");
  // Every list the op may edit: the layers, their parents, the target parent.
  const cur = currentDoc(docFile).doc as unknown as Doc;
  const touches: (string | null)[] = [...ids, null];
  for (const id of ids) {
    const p = placeOf(cur, id);
    if (p?.parent) touches.push(p.parent);
  }
  for (const p of parts ?? [b]) if (typeof p.parent === "string") touches.push(p.parent);
  // The groups around the old and new parents fit their layers again (groupfit.ts), and an empty one goes.
  touches.push(...groupsAround(cur, touches));
  let out: OpResult | undefined;
  // An agent's layers moved out onto the canvas land clear of the boards and cards on their page (src/placement.ts),
  // not on top of the board they came out of.
  const toCanvas = who.source === "mcp" && op === "place" && !parts && b.parent === null && b.allowOverlap !== true;
  let mates: ReturnType<typeof pageMates> | null = null;
  if (toCanvas) {
    let board: string | undefined;
    try { const f = findNode(cur as any, ids[0]); board = String((f.ancestors[0] ?? f.node).id); } catch { /* the op says so */ }
    mates = pageMates(docFile, cur, { page: b.page, board });
  }
  const cards = mates ? cardBoxes(docFile, mates.page, mates.first) : [];
  let placed: Placed[] | undefined;
  // Replayed on someone else's bytes, the edit applies the ops it made (a wrapping frame keeps its id).
  const replay = (doc: any) => replayOps(doc as Doc, out!.ops);
  let write;
  try {
    ({ write } = editDoc(docFile, { expectedRevision: b.expectedRevision, touches, deep: true, urgent: true, replay, recorded: () => out?.ops ?? [] }, (doc) => {
      out = apply(doc as unknown as Doc, b, rects);
      if (mates) {
        const d = doc as unknown as Doc;
        const top = out.select.filter((id) => d.children.some((n) => String(n.id) === id));
        const given = new Map(top.map((id) => {
          const n = d.children.find((c) => String(c.id) === id)!;
          return [id, { x: typeof n.x === "number" ? n.x : 0, y: typeof n.y === "number" ? n.y : 0 }] as const;
        }));
        const rec = new Recorder(d);
        placed = placeNew(d, top, given, { mates: mates.boards, rects, cards }, (id, xy) => rec.props(id, xy));
        out = { ...out, ops: [...out.ops, ...rec.ops] };
      }
      if (!out.ops.length) throw new NoChange();
    }));
  } catch (e) {
    if (e instanceof NoChange) return { ok: true, op, label: out!.label, select: out!.select, revision: currentDoc(docFile).revision, changed: false };
    throw e;
  }
  const ops = out!.ops;
  const select = out!.select;
  const nudge = b.merge === "nudge", group = isGroupMerge(b.merge);
  const mergeKey = nudge ? `layout-nudge:${[...select].sort().join(",")}`
    : group ? b.merge
    : op === "settings" ? `layout-settings:${[...select].sort().join(",")}:${Object.keys(b.layout ?? {}).sort().join(",")}`
    : `layout:${Date.now()}:${Math.random()}`;
  // Undo of an Option-drag copy selects the originals again, as Undo of a Duplicate does.
  const selBefore = op === "place" && b.copy === true ? ids : [];
  record(docFile, ops, { label: out!.label, source: who.source, session: who.session, mergeKey, ...(nudge ? { mergeMs: NUDGE_MERGE_MS } : group ? { mergeMs: GROUP_MERGE_MS } : {}), edit: write.edit, ...(selBefore.length ? { selBefore } : {}),
    // Undo of a move out of (or into) a group selects the layers that moved, not the group that refit around them.
    ...(op === "place" && b.copy !== true && ids.length ? { sel: ids } : {}) }, write.revision);
  const note = placed ? placementNote(placed) : undefined;
  return { ok: true, op, label: out!.label, select, revision: write.revision, changed: true, ...(placed ? { placed } : {}), ...(note ? { note } : {}) };
}

export type LayoutDeps = {
  prime: (file: string) => Promise<void>;
  docFileOf: (file: string) => string;
  written: (docFile: string, revision: string | undefined, by: "mcp" | "inspector", ids: string[], label: string) => void;
};

/** POST /api/layout (see the top of this file). */
export async function handleLayoutRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: LayoutDeps): Promise<boolean> {
  if (url.pathname !== "/api/layout") return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const raw = await readBodyText(req, 4_000_000);
  if (raw === null) return reply(413, { error: "too large", code: "invalid" }), true;
    let b: LayoutBody;
    try { b = JSON.parse(raw || "{}"); } catch { return reply(400, { error: "the body is not JSON", code: "invalid" }), true; }
    if (!isObj(b) || !b.file || !b.op) return reply(400, { error: "file and op are required", code: "invalid" }), true;
    await deps.prime(b.file);
    const docFile = deps.docFileOf(b.file);
    const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
    const session = String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined;
    const cur = currentDoc(docFile).doc as unknown as Doc;
    const before = (cur.children ?? []).map((n) => String(n.id));
    // Layers dropped on empty canvas become boards on the page of the board they came from (else b.page).
    const parts: PlacePart[] | null = b.op === "place" && Array.isArray(b.parts) ? b.parts.filter((p) => isObj(p)) : null;
    const canvasIds: string[] = (b.op !== "place" ? [] : parts ? parts.filter((p) => p.parent === null).flatMap((p) => (Array.isArray(p.ids) ? p.ids : [])) : b.parent === null ? (b.ids ?? []) : []).filter((x) => typeof x === "string");
    const toCanvas = canvasIds.length > 0;
    const from = toCanvas ? canvasIds.map((id) => { try { const f = findNode(cur as any, id); return String((f.ancestors[0] ?? f.node).id); } catch { return null; } }).filter((x): x is string => !!x) : [];
    const r = runLayout(docFile, b, { source: by === "mcp" ? "mcp" : "user", session });
    if (r.changed) {
      if (b.op === "add" || toCanvas) await keepOnPage(docFile, { op: "group", ids: [...from, ...(toCanvas ? canvasIds : (b.ids ?? []))], page: b.page }, before);
      deps.written(docFile, r.revision, by, r.select, r.label);
    }
    return reply(200, r), true;
  } catch (e) {
    if (e instanceof StructureError) return reply(e.status, { error: e.message, code: e.code }), true;
    if (e instanceof StaleFileError) return reply(409, { error: (e as Error).message, code: "stale_revision" }), true;
    if (e instanceof ValidationError) return reply(422, { error: (e as Error).message, code: "invalid" }), true;
    if (/no node with id/.test((e as Error).message)) return reply(404, { error: (e as Error).message, code: "not_found" }), true;
    return reply(422, { error: (e as Error).message, code: "failed" }), true;
  }
}
