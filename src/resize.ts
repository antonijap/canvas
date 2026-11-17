// Resizing boards and layers from the canvas: the selection's edge and corner handles and "Resize to fit
// content" (src/page/live.js). The page draws the resize live and writes once, on release.
//
// POST /api/resize {file, id, props, remove?, children?, label?, gesture?} writes the node's size (and position,
// for a node that places itself) and, when the left or top edge moved with Cmd held or for a fit, the x/y of
// its absolutely placed children, in one write and one undo step. Only geometry: width, height, x, y,
// textGrowth (a text box that is resized becomes fixed) and flipX / flipY (an edge dragged past the opposite one). Each child must be a direct child that places itself.
//
// POST /api/resize {file, items: [{id, props}], label?} resizes several nodes at once (a group or a multi-selection
// dragged by its handles): the page sends each node's new geometry, one write and one undo step.

import type http from "node:http";
import { findNode, StaleFileError, updateNode, type Json, type DocNode } from "./engine.ts";
import { editDoc } from "./docwriter.ts";
import { nodeDiff, propsOf, record, type NodeOp } from "./history.ts";
import { groupsOf, mergeOps, moveModeOf, refit } from "./move.ts";
import { readBodyText } from "./body.ts";

const NODE_KEYS = new Set(["width", "height", "x", "y", "textGrowth", "flipX", "flipY", "rotation"]);
const SIZE = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e6) || (typeof v === "string" && /^(fit_content|fill_container)(\(\s*[\d.]+\s*\))?$/.test(v));
const POS = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e7;
const GROWTH = new Set(["auto", "fixed-width", "fixed-width-height"]);

export type ResizeBody = {
  file?: string;
  id?: string;
  props?: Record<string, Json>;
  remove?: string[];
  children?: { id: string; x?: number; y?: number }[];
  label?: string;
  gesture?: string;
  expectedRevision?: string;
};

export class ResizeError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Check a body before anything is read: only geometry, sane numbers, children as {id, x, y}. */
export function validateResize(b: ResizeBody): void {
  if (!b.id || typeof b.id !== "string") throw new ResizeError(400, "invalid", "id is required");
  if (b.id.includes("/")) throw new ResizeError(400, "instance", "that layer lives inside a component instance; resize the instance, or edit the component");
  const props = b.props ?? {};
  if (typeof props !== "object" || Array.isArray(props)) throw new ResizeError(400, "invalid", "props must be an object");
  for (const [k, v] of Object.entries(props)) {
    if (!NODE_KEYS.has(k)) throw new ResizeError(400, "invalid", `a resize cannot set ${k}`);
    if ((k === "width" || k === "height") && !SIZE(v)) throw new ResizeError(400, "invalid", `${k} must be a size`);
    if ((k === "x" || k === "y") && !POS(v)) throw new ResizeError(400, "invalid", `${k} must be a number`);
    if (k === "textGrowth" && !GROWTH.has(String(v))) throw new ResizeError(400, "invalid", "textGrowth must be auto, fixed-width or fixed-width-height");
    if (k === "rotation" && !(typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 360)) throw new ResizeError(400, "invalid", "rotation must be a number of degrees");
    if ((k === "flipX" || k === "flipY") && typeof v !== "boolean") throw new ResizeError(400, "invalid", `${k} must be true or false`);
  }
  for (const k of b.remove ?? []) if (k !== "width" && k !== "height") throw new ResizeError(400, "invalid", `a resize cannot remove ${k}`);
  const kids = b.children ?? [];
  if (!Array.isArray(kids) || kids.length > 2000) throw new ResizeError(400, "invalid", "children must be a list");
  for (const c of kids) {
    if (!c || typeof c.id !== "string" || c.id.includes("/")) throw new ResizeError(400, "invalid", "each child needs an id");
    if ((c.x !== undefined && !POS(c.x)) || (c.y !== undefined && !POS(c.y))) throw new ResizeError(400, "invalid", "child x and y must be numbers");
  }
  if (!Object.keys(props).length && !(b.remove ?? []).length && !kids.length) throw new ResizeError(400, "invalid", "nothing to change");
}

/** Resize one node (and shift its children) in a document on disk, and record one undo step. */
export function resizeNode(docFile: string, b: ResizeBody, who: { source: "user" | "mcp"; session?: string }) {
  validateResize(b);
  const id = b.id!;
  const ops: NodeOp[] = [];
  // The groups around it fit their layers again after (groupfit.ts).
  const fit = groupsOf(docFile, [id]);
  // The node and each child it shifts are changed (cowDoc copies exactly those).
  const { write } = editDoc(docFile, { expectedRevision: b.expectedRevision, touches: [id, ...(b.children ?? []).map((c) => c.id), ...fit.touches] }, (doc) => {
    ops.length = 0; // the change may run twice (a replay after an outside save)
    const mode = moveModeOf(doc as { children: DocNode[] }, id);
    const props = { ...(b.props ?? {}) };
    // Only a node that places itself takes x/y: an auto-layout child's position is its parent's.
    if (mode.mode === "auto") { delete props.x; delete props.y; }
    const node = findNode(doc, id).node;
    const before = propsOf(node);
    const n = updateNode(doc, id, props, b.remove ?? []);
    const op = nodeDiff(id, before, propsOf(n));
    if (Object.keys(op.props).length) ops.push(op);
    for (const c of b.children ?? []) {
      const m = moveModeOf(doc as { children: DocNode[] }, c.id);
      if (m.parentId !== id) throw new ResizeError(409, "not_child", `${c.id} is not a child of ${id}`);
      if (m.mode !== "absolute") continue; // auto layout places it
      const kid = findNode(doc, c.id).node;
      const kb = propsOf(kid);
      const set: Record<string, Json> = {};
      if (c.x !== undefined) set.x = c.x;
      if (c.y !== undefined) set.y = c.y;
      const k2 = updateNode(doc, c.id, set, []);
      const kop = nodeDiff(c.id, kb, propsOf(k2));
      if (Object.keys(kop.props).length) ops.push(kop);
    }
    const merged = mergeOps([...ops, ...refit(doc as { children: DocNode[] }, fit.groups)]);
    ops.length = 0;
    ops.push(...merged);
  });
  if (ops.length) {
    const label = resizeLabel(b.label);
    record(docFile, ops, { label, source: who.source, session: who.session, mergeKey: b.gesture ? `resize:${id}#${String(b.gesture).slice(0, 64)}` : undefined, edit: write.edit }, write.revision);
  }
  return { ok: true as const, id, revision: write.revision, changed: ops.map((o) => o.id) };
}

export type ResizeItem = { id: string; props: Record<string, Json> };

/** The undo step's name: Flip (Shift+H / Shift+V) and Resize to Fit name themselves, anything else is a Resize. */
export function resizeLabel(label: unknown): string {
  return label === "Resize to Fit" || label === "Flip Horizontal" || label === "Flip Vertical" ? label : "Resize";
}

/**
 * Resize several nodes in one write and one undo step: a group or a multi-selection resized by its handles (the
 * page scales each layer's box and sends each node's new geometry). Same rules per node as one resize:
 * geometry only, and x/y only for a node that places itself.
 */
export function resizeNodes(docFile: string, items: ResizeItem[], label: string | undefined, who: { source: "user" | "mcp"; session?: string }, select?: unknown) {
  if (!Array.isArray(items) || !items.length || items.length > 2000) throw new ResizeError(400, "invalid", "items must list 1 to 2000 nodes");
  for (const it of items) validateResize({ id: it && it.id, props: it && it.props });
  const ops: NodeOp[] = [];
  const fit = groupsOf(docFile, items.map((it) => it.id));
  const { write } = editDoc(docFile, { touches: [...items.map((it) => it.id), ...fit.touches] }, (doc) => {
    ops.length = 0; // the change may run twice (a replay after an outside save)
    for (const it of items) {
      const mode = moveModeOf(doc as { children: DocNode[] }, it.id);
      const props = { ...it.props };
      if (mode.mode === "auto") { delete props.x; delete props.y; }
      const node = findNode(doc, it.id).node;
      const before = propsOf(node);
      const n = updateNode(doc, it.id, props, []);
      const op = nodeDiff(it.id, before, propsOf(n));
      if (Object.keys(op.props).length) ops.push(op);
    }
    const merged = mergeOps([...ops, ...refit(doc as { children: DocNode[] }, fit.groups)]);
    ops.length = 0;
    ops.push(...merged);
  });
  // The selection the resize was made with (a group, not the layers it scaled) comes back on undo and redo.
  const sel = Array.isArray(select) ? select.filter((x): x is string => typeof x === "string").slice(0, 2000) : [];
  if (ops.length) record(docFile, ops, { label: resizeLabel(label), source: who.source, session: who.session, edit: write.edit, ...(sel.length ? { sel } : {}) }, write.revision);
  return { ok: true as const, revision: write.revision, changed: ops.map((o) => o.id) };
}

export type ResizeDeps = {
  prime: (file: string) => Promise<void>;
  docFileOf: (file: string) => string;
  revisionOf?: (docFile: string) => string | undefined;
  /** After a write: tell pages and the bridge. */
  written: (docFile: string, revision: string | undefined, by: "mcp" | "inspector", ids: string[]) => void;
};

export async function handleResizeRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ResizeDeps): Promise<boolean> {
  if (url.pathname !== "/api/resize") return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const raw = await readBodyText(req, 200_000);
  if (raw === null) return reply(413, { error: "too large", code: "invalid" }), true;
    const b = JSON.parse(raw || "{}") as ResizeBody & { items?: ResizeItem[]; select?: unknown };
    if (!b.file) return reply(400, { error: "file is required", code: "invalid" }), true;
    if (Array.isArray(b.items)) {
      await deps.prime(b.file);
      const docFile = deps.docFileOf(b.file);
      const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
      const session = String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined;
      const r = resizeNodes(docFile, b.items, b.label, { source: by === "mcp" ? "mcp" : "user", session }, b.select);
      deps.written(docFile, r.revision, by, r.changed.length ? r.changed : [b.items[0].id]);
      return reply(200, r), true;
    }
    validateResize(b);
    await deps.prime(b.file);
    const docFile = deps.docFileOf(b.file);
    const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
    const session = String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined;
    const r = resizeNode(docFile, b, { source: by === "mcp" ? "mcp" : "user", session });
    deps.written(docFile, r.revision, by, r.changed.length ? r.changed : [b.id!]);
    return reply(200, r), true;
  } catch (e) {
    if (e instanceof ResizeError) return reply(e.status, { error: e.message, code: e.code }), true;
    if (e instanceof StaleFileError) return reply(409, { error: (e as Error).message, code: "stale_revision" }), true;
    if (/no node with id/.test((e as Error).message)) return reply(404, { error: (e as Error).message, code: "not_found" }), true;
    return reply(422, { error: (e as Error).message, code: "failed" }), true;
  }
}
