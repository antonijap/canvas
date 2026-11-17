// The scale tool (K), the inspector's Scale field and the MCP's scale_nodes: scale layers with everything inside
// them. The page draws the drag at display rate (src/page/live.js) and writes once, on release.
//
// POST /api/scale {file, ids, factor | width | height, anchor?, items?, expectedRevision?} scales each layer and
// every descendant by one factor in one write and one undo step ("Scale"). What a node's properties do is in
// src/page/scale.js (shared with the page's preview). Here: where each scaled value is stored.
// - A node in the tree: its own properties.
// - A layer inside a component instance: an override in the instance's `descendants` (the component itself is
//   left alone), keyed by its path below the instance. An override that replaces the node is scaled
//   in place.
// - Token-bound values stay bound and are counted (`kept`), so the page can say "3 token values kept".
// - Text with auto letter spacing (src/tracking.ts) gets the tracking of its new size, not a scaled one.
// - The layer's own position: `items` (from the page, which knows where layout put things) give each layer's new
//   x/y; without them a layer that places itself keeps the anchor point ("top-left" by default) where it was,
//   from its stored x/y and size. Layers in auto layout are placed by their parent: only their size scales.
//
// POST /api/scale {file, ids, plan: true} answers what the page needs to draw the drag exactly as the write will
// land: per scene id, the paths that stay (token-bound values, an instance's borrowed x/y) and whether its text
// recomputes its tracking.

import type http from "node:http";
import { buildIndex, expand, findNode, StaleFileError, type Json, type CanvasDoc, type DocNode } from "./engine.ts";
import { currentDoc, editDoc } from "./docwriter.ts";
import { nodeDiff, propsOf, record, type NodeOp } from "./history.ts";
import { moveModeOf } from "./move.ts";
import { autoTracking, fontOf, isAutoTracking, lookupMetrics, trackingMethod, type FontMetrics, type MetricsLookup } from "./tracking.ts";
// @ts-ignore: a plain ES module the page imports too
import * as ScaleLib from "./page/scale.js";
import { readBodyText } from "./body.ts";

type Props = Record<string, Json>;
const S = ScaleLib as {
  scaleProps: (node: unknown, f: number, o?: { root?: boolean; bound?: Set<string> }) => { props: Props; kept: string[] };
  boundPaths: (node: unknown) => string[];
  ANCHORS: Record<string, [number, number]>;
  r2: (v: number) => number;
};

export const MIN_FACTOR = 0.01;
export const MAX_FACTOR = 100;

export type ScaleItem = { id: string; x?: number; y?: number };
export type ScaleBody = {
  file?: string;
  id?: string;
  ids?: string[];
  factor?: number;
  width?: number;
  height?: number;
  anchor?: string;
  items?: ScaleItem[];
  plan?: boolean;
  expectedRevision?: string;
};

export class ScaleError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const POS = (v: unknown) => isNum(v) && Math.abs(v) <= 1e7;

function idsOf(b: ScaleBody): string[] {
  const ids = Array.isArray(b.ids) ? b.ids : b.id ? [b.id] : [];
  if (!ids.length) throw new ScaleError(400, "invalid", "ids is required");
  if (ids.length > 500) throw new ScaleError(400, "invalid", "too many ids");
  for (const id of ids) {
    if (typeof id !== "string" || !id) throw new ScaleError(400, "invalid", "each id must be a string");
    if (id.includes("/")) throw new ScaleError(400, "instance", "that layer lives inside a component instance; scale the instance, or edit the component");
  }
  return [...new Set(ids)];
}

/** Check a body before anything is read. */
export function validateScale(b: ScaleBody): void {
  idsOf(b);
  if (b.plan) return;
  const given = [b.factor, b.width, b.height].filter((v) => v !== undefined).length;
  if (given !== 1) throw new ScaleError(400, "invalid", "give exactly one of factor, width or height");
  if (b.factor !== undefined && !(isNum(b.factor) && b.factor >= MIN_FACTOR && b.factor <= MAX_FACTOR)) throw new ScaleError(400, "invalid", `factor must be between ${MIN_FACTOR} and ${MAX_FACTOR}`);
  for (const k of ["width", "height"] as const) if (b[k] !== undefined && !(isNum(b[k]) && b[k]! > 0 && b[k]! <= 1e6)) throw new ScaleError(400, "invalid", `${k} must be a positive number`);
  if (b.anchor !== undefined && !(b.anchor in S.ANCHORS)) throw new ScaleError(400, "invalid", `anchor must be one of ${Object.keys(S.ANCHORS).join(", ")}`);
  const items = b.items ?? [];
  if (!Array.isArray(items) || items.length > 500) throw new ScaleError(400, "invalid", "items must be a list");
  for (const it of items) {
    if (!it || typeof it.id !== "string" || it.id.includes("/")) throw new ScaleError(400, "invalid", "each item needs an id");
    if ((it.x !== undefined && !POS(it.x)) || (it.y !== undefined && !POS(it.y))) throw new ScaleError(400, "invalid", "item x and y must be numbers");
  }
}

// ---------------------------------------------------------------- the tree

/** Every stored node in the main tree by id, with its subtree ids. */
export function storedIndex(doc: CanvasDoc): Map<string, DocNode> {
  const out = new Map<string, DocNode>();
  const visit = (n: DocNode) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.id === "string") out.set(n.id, n);
    if (Array.isArray(n.children)) n.children.forEach(visit);
  };
  doc.children.forEach(visit);
  return out;
}

/** The roots to scale: the ids given, minus any that sit inside another one (they scale with it). */
function rootsOf(doc: CanvasDoc, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => !findNode(doc, id).ancestors.some((a) => set.has(String(a.id))));
}

/** Ids of a node and every node stored below it (what the write copies before it changes them). */
function subtreeIds(n: DocNode, out: string[] = []): string[] {
  if (typeof n.id === "string") out.push(n.id);
  for (const c of Array.isArray(n.children) ? n.children : []) if (c && typeof c === "object") subtreeIds(c, out);
  return out;
}

/** Replacement nodes stored in an instance's overrides (they and their children), by id. */
export function replacementsIn(desc: Record<string, DocNode>): Map<string, DocNode> {
  const out = new Map<string, DocNode>();
  const visit = (n: DocNode) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.id === "string") out.set(n.id, n);
    for (const c of Array.isArray(n.children) ? n.children : []) visit(c);
  };
  for (const v of Object.values(desc)) if (v && typeof v === "object" && (v as DocNode).type) visit(v as DocNode);
  return out;
}

const walkExpanded = (n: DocNode, fn: (n: DocNode, root: boolean) => void, root = true) => {
  if (!n || typeof n !== "object") return;
  fn(n, root);
  for (const c of Array.isArray(n.children) ? n.children : []) walkExpanded(c, fn, false);
};

// ---------------------------------------------------------------- auto letter spacing

/** The metrics auto-tracked text below these roots needs (fetched ahead: the write runs synchronously). */
export async function prepareScaleMetrics(doc: CanvasDoc, ids: string[], lookup: MetricsLookup = lookupMetrics): Promise<Map<string, FontMetrics | undefined>> {
  const out = new Map<string, FontMetrics | undefined>();
  const index = buildIndex(doc);
  for (const id of ids) {
    let node: DocNode;
    try {
      node = findNode(doc, id).node;
    } catch {
      continue;
    }
    walkExpanded(expand(index, node), (n) => {
      if (n.type !== "text" || !isAutoTracking(n)) return;
      const { family, weight } = fontOf(doc, n);
      const key = `${family}\n${weight}`;
      if (trackingMethod(family) === "generic" && !out.has(key)) out.set(key, undefined);
    });
  }
  for (const key of out.keys()) {
    const [family, weight] = key.split("\n");
    out.set(key, await lookup(family, Number(weight)).catch(() => undefined));
  }
  return out;
}

/** The letterSpacing an auto-tracked text node gets at its scaled size, or undefined (not auto, size a token). */
function autoSpacing(doc: CanvasDoc, n: DocNode, props: Props, metrics: Map<string, FontMetrics | undefined>): number | undefined {
  if (n.type !== "text" || !isAutoTracking(n)) return undefined;
  const { family, weight, size } = fontOf(doc, { ...n, ...props });
  if (size === undefined) return undefined;
  return autoTracking(family, size, metrics.get(`${family}\n${weight}`)).px;
}

// ---------------------------------------------------------------- planning

/**
 * An instance shows its component's x/y when it has none of its own (in an auto-layout parent, say): that is not
 * where it sits, so a scale leaves those alone. Returns the keys to leave.
 */
function fixedPos(n: DocNode, stored: Map<string, DocNode>): string[] {
  if (!n.__ref) return [];
  const fid = String(n.id);
  if (!fid.includes("/")) {
    const own = stored.get(fid);
    return own?.type === "ref" ? ["x", "y"].filter((k) => !(k in own)) : [];
  }
  const segs = fid.split("/");
  const src = stored.get(segs[segs.length - 1]);
  const ov = (stored.get(segs[0])?.descendants as Record<string, DocNode> | undefined)?.[segs.slice(1).join("/")];
  return ["x", "y"].filter((k) => !(src && k in src) && !(ov && typeof ov === "object" && k in ov));
}

/** Per scene id below these roots: the token paths a scale keeps, and whether its tracking recomputes. */
export function planScale(doc: CanvasDoc, ids: string[]): { nodes: Record<string, { bound?: string[]; auto?: true }> } {
  const index = buildIndex(doc);
  const stored = storedIndex(doc);
  const nodes: Record<string, { bound?: string[]; auto?: true }> = {};
  for (const id of rootsOf(doc, ids)) {
    walkExpanded(expand(index, findNode(doc, id).node), (n) => {
      // Token paths, and positions a scale leaves alone: the page's preview skips both.
      const bound = [...S.boundPaths(n), ...fixedPos(n, stored)];
      const auto = n.type === "text" && isAutoTracking(n);
      if (bound.length || auto) nodes[String(n.id)] = { ...(bound.length ? { bound } : {}), ...(auto ? { auto: true as const } : {}) };
    });
  }
  return { nodes };
}

// ---------------------------------------------------------------- the write

type Write = { kind: "node"; id: string; props: Props } | { kind: "override"; inst: string; key: string; props: Props } | { kind: "replacement"; inst: string; id: string; props: Props }
  // A layer inside an instance that is itself a replacement (stored in `inst`'s descendants): its override goes on that replacement.
  | { kind: "repOverride"; inst: string; rep: string; key: string; props: Props };

/** The factor a body asks for: as given, or the width/height it names over the layers' current size on that axis. */
function factorOf(doc: CanvasDoc, roots: string[], b: ScaleBody, index: ReturnType<typeof buildIndex>): number {
  if (b.factor !== undefined) return b.factor;
  const box = unionBox(doc, roots, index);
  // Only the axis asked about needs a fixed size: a text box 100 wide with auto height scales to width 200.
  const cur = b.width !== undefined ? box?.w : box?.h;
  if (!cur || !(cur > 0)) throw new ScaleError(409, "no_size", "the layer has no fixed size to scale to; give a factor");
  const f = (b.width ?? b.height)! / cur;
  if (!(f >= MIN_FACTOR && f <= MAX_FACTOR)) throw new ScaleError(400, "invalid", `that is a factor of ${f}; it must be between ${MIN_FACTOR} and ${MAX_FACTOR}`);
  return f;
}

type Box = { x: number; y: number; w?: number; h?: number; parent: string | null };

/** A layer's stored box: x, y and each numeric side (the component's when an instance has none; undefined when it sizes itself). */
function boxOf(doc: CanvasDoc, id: string, index: ReturnType<typeof buildIndex>): Box {
  const m = moveModeOf(doc as { children: DocNode[] }, id);
  const e = expand(index, findNode(doc, id).node);
  return { x: m.x, y: m.y, w: isNum(e.width) ? e.width : undefined, h: isNum(e.height) ? e.height : undefined, parent: m.parentId };
}

/** The layers' union box when they share a parent (one anchor for all), else undefined. A side is known when every layer's is. */
function unionBox(doc: CanvasDoc, roots: string[], index: ReturnType<typeof buildIndex>): Box | undefined {
  const boxes = roots.map((id) => boxOf(doc, id, index));
  if (roots.length === 1) return boxes[0];
  if (new Set(boxes.map((x) => x.parent)).size !== 1) return undefined;
  const side = (pos: "x" | "y", len: "w" | "h") => {
    if (boxes.some((r) => r[len] === undefined)) return undefined;
    const a = Math.min(...boxes.map((r) => r[pos])), z = Math.max(...boxes.map((r) => r[pos] + r[len]!));
    return { at: a, len: z - a };
  };
  const sx = side("x", "w"), sy = side("y", "h");
  return { x: sx?.at ?? Math.min(...boxes.map((r) => r.x)), y: sy?.at ?? Math.min(...boxes.map((r) => r.y)), w: sx?.len, h: sy?.len, parent: boxes[0].parent };
}

/**
 * Everything one scale changes, worked out on `doc` before anything is written (an instance and its component
 * scaled together must both read the old values).
 */
function scaleWrites(doc: CanvasDoc, roots: string[], f: number, b: ScaleBody, metrics: Map<string, FontMetrics | undefined>) {
  const index = buildIndex(doc);
  const stored = storedIndex(doc);
  const writes: Write[] = [];
  let kept = 0;
  const items = new Map((b.items ?? []).map((it) => [it.id, it]));
  const [ax, ay] = S.ANCHORS[b.anchor ?? "top-left"];
  const union = items.size ? undefined : unionBox(doc, roots, index);
  for (const id of roots) {
    const storedRoot = stored.get(id)!;
    const e = expand(index, storedRoot);
    // Replacement nodes stored in the overrides of instances below this root.
    const reps = new Map<string, { inst: string; node: DocNode }>();
    for (const sid of subtreeIds(storedRoot)) {
      const s = stored.get(sid);
      if (s?.type === "ref" && s.descendants && typeof s.descendants === "object") for (const [rid, rn] of replacementsIn(s.descendants as Record<string, DocNode>)) reps.set(rid, { inst: sid, node: rn });
    }
    walkExpanded(e, (n, isRoot) => {
      const fid = String(n.id);
      const { props, kept: k } = S.scaleProps(n, f, { root: isRoot });
      kept += k.length;
      const ls = autoSpacing(doc, n, props, metrics);
      if (ls !== undefined) {
        if (ls !== n.letterSpacing) props.letterSpacing = ls;
        else delete props.letterSpacing;
      }
      for (const k of fixedPos(n, stored)) delete props[k];
      const own = stored.get(fid);
      if (!Object.keys(props).length) return;
      if (!fid.includes("/") && own) writes.push({ kind: "node", id: fid, props });
      else if (fid.includes("/")) {
        const inst = fid.slice(0, fid.indexOf("/"));
        if (stored.get(inst)?.type === "ref") writes.push({ kind: "override", inst, key: fid.slice(inst.length + 1), props });
        else if (reps.get(inst)?.node.type === "ref") writes.push({ kind: "repOverride", inst: reps.get(inst)!.inst, rep: inst, key: fid.slice(inst.length + 1), props });
      } else if (reps.has(fid)) writes.push({ kind: "replacement", inst: reps.get(fid)!.inst, id: fid, props });
    });
    // The layer's own position: where the page says, or about the anchor of the stored box.
    const mode = moveModeOf(doc as { children: DocNode[] }, id);
    if (mode.mode !== "board" && mode.mode !== "absolute") continue;
    const pos: Props = {};
    const it = items.get(id);
    if (it) {
      if (it.x !== undefined) pos.x = S.r2(it.x);
      if (it.y !== undefined) pos.y = S.r2(it.y);
    } else {
      // About the anchor, axis by axis: an axis whose size is automatic scales about the layer's own x (or y).
      const box = union ?? boxOf(doc, id, index);
      if (box) {
        const px = box.x + ax * (box.w ?? 0), py = box.y + ay * (box.h ?? 0);
        pos.x = S.r2(px + (mode.x - px) * f);
        pos.y = S.r2(py + (mode.y - py) * f);
      }
    }
    if (pos.x === mode.x) delete pos.x;
    if (pos.y === mode.y) delete pos.y;
    // A position bound to a token keeps its token (moveModeOf reads it as 0): kept, like any token a scale meets.
    for (const k of ["x", "y"] as const) if (k in pos && typeof storedRoot[k] === "string") { delete pos[k]; kept++; }
    if (Object.keys(pos).length) writes.push({ kind: "node", id, props: pos });
  }
  return { writes, kept };
}

/** The stored node ids a scale changes (copied before the change: docwriter's copy on write). */
function touchesOf(doc: CanvasDoc, roots: string[]): string[] {
  const out: string[] = [];
  for (const id of roots) subtreeIds(findNode(doc, id).node, out);
  return out;
}

/** Scale layers in a document on disk, and record one undo step. */
export function scaleNodes(docFile: string, b: ScaleBody, who: { source: "user" | "mcp"; session?: string }, metrics: Map<string, FontMetrics | undefined> = new Map()) {
  validateScale(b);
  const ids = idsOf(b);
  const before = currentDoc(docFile).doc;
  for (const id of ids) {
    try {
      findNode(before, id);
    } catch {
      throw new ScaleError(404, "not_found", `no node with id "${id}"`);
    }
  }
  const touches = touchesOf(before, rootsOf(before, ids));
  const ops: NodeOp[] = [];
  let kept = 0, factor = 1;
  const { write } = editDoc(docFile, { expectedRevision: b.expectedRevision, touches }, (doc) => {
    ops.length = 0; // the change may run twice (a replay after an outside save)
    const roots = rootsOf(doc, ids);
    const index = buildIndex(doc);
    factor = factorOf(doc, roots, b, index);
    const w = scaleWrites(doc, roots, factor, b, metrics);
    kept = w.kept;
    const stored = storedIndex(doc);
    const snap = new Map<string, Record<string, unknown>>();
    const take = (id: string) => {
      if (!snap.has(id)) snap.set(id, propsOf(stored.get(id)!));
      return stored.get(id)!;
    };
    const desc = new Map<string, Record<string, DocNode>>();
    const descOf = (inst: string) => {
      let d = desc.get(inst);
      if (!d) {
        const n = take(inst);
        d = structuredClone((n.descendants ?? {}) as Record<string, DocNode>);
        desc.set(inst, d);
      }
      return d;
    };
    for (const wr of w.writes) {
      if (wr.kind === "node") Object.assign(take(wr.id), wr.props);
      else if (wr.kind === "override") {
        const d = descOf(wr.inst);
        const have = d[wr.key];
        if (have && typeof have === "object" && have.type) Object.assign(have, wr.props);
        else d[wr.key] = { ...(have && typeof have === "object" ? have : {}), ...wr.props } as DocNode;
      } else if (wr.kind === "repOverride") {
        const hit = replacementsIn(descOf(wr.inst)).get(wr.rep);
        if (!hit) continue;
        const d = (hit.descendants ??= {}) as Record<string, DocNode>;
        const have = d[wr.key];
        if (have && typeof have === "object" && have.type) Object.assign(have, wr.props);
        else d[wr.key] = { ...(have && typeof have === "object" ? have : {}), ...wr.props } as DocNode;
      } else {
        const hit = replacementsIn(descOf(wr.inst)).get(wr.id);
        if (hit) Object.assign(hit, wr.props);
      }
    }
    for (const [inst, d] of desc) stored.get(inst)!.descendants = d as unknown as Json;
    for (const [id, b0] of snap) {
      const op = nodeDiff(id, b0, propsOf(stored.get(id)!));
      if (Object.keys(op.props).length) ops.push(op);
    }
  });
  if (ops.length) record(docFile, ops, { label: "Scale", source: who.source, session: who.session, edit: write.edit }, write.revision);
  return { ok: true as const, ids, factor, kept, revision: write.revision, changed: ops.map((o) => o.id) };
}

export type ScaleDeps = {
  prime: (file: string) => Promise<void>;
  docFileOf: (file: string) => string;
  /** After a write: tell pages and the bridge. */
  written: (docFile: string, revision: string | undefined, by: "mcp" | "inspector", ids: string[]) => void;
};

export async function handleScaleRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ScaleDeps): Promise<boolean> {
  if (url.pathname !== "/api/scale") return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const raw = await readBodyText(req, 200_000);
  if (raw === null) return reply(413, { error: "too large", code: "invalid" }), true;
    const b = JSON.parse(raw || "{}") as ScaleBody;
    if (!b.file) return reply(400, { error: "file is required", code: "invalid" }), true;
    validateScale(b);
    await deps.prime(b.file);
    const docFile = deps.docFileOf(b.file);
    const doc = currentDoc(docFile).doc;
    if (b.plan) {
      try {
        return reply(200, planScale(doc, idsOf(b))), true;
      } catch (e) {
        if (/no node with id/.test((e as Error).message)) return reply(404, { error: (e as Error).message, code: "not_found" }), true;
        throw e;
      }
    }
    const metrics = await prepareScaleMetrics(doc, idsOf(b));
    const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
    const session = String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined;
    const r = scaleNodes(docFile, b, { source: by === "mcp" ? "mcp" : "user", session }, metrics);
    deps.written(docFile, r.revision, by, r.changed.length ? r.changed : r.ids);
    return reply(200, r), true;
  } catch (e) {
    if (e instanceof ScaleError) return reply(e.status, { error: e.message, code: e.code }), true;
    if (e instanceof StaleFileError) return reply(409, { error: (e as Error).message, code: "stale_revision" }), true;
    if (/no node with id/.test((e as Error).message)) return reply(404, { error: (e as Error).message, code: "not_found" }), true;
    return reply(422, { error: (e as Error).message, code: "failed" }), true;
  }
}
