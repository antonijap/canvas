// Moving boards and layers: dragging a board, nudging with the arrow keys, the MCP's move_board.
//
// POST /api/move {file, id, x?, y?, dx?, dy?, round?, merge?} sets a node's x/y (absolute) or shifts it (dx/dy).
// Only nodes whose position is their own can move: boards (top-level nodes) and children placed absolutely
// (inside a group, a layout:none frame, or with layoutPosition absolute). A child of an auto-layout frame gets
// 409 auto_layout: its parent decides where it sits. Reordering such a child (arrow keys and drag) is a
// tree change: POST /api/layout op "place" (src/autolayout.ts), with its own undo step.
//
// Each drop is its own undo step. Nudges (merge: "nudge") of the same node fold into one step while they keep
// coming less than NUDGE_MERGE_MS apart, so a burst of arrow presses undoes in one go.
//
// GET /api/move?file=&id= says what a move of that node would do: {mode, parentId, siblings, layout}.
//
// POST /api/move {file, items: [{id, x?, y?, dx?, dy?}], round?, merge?} moves several at once (a multi-selection
// dragged or nudged): one write, one undo step. Items that cannot move (auto layout, instance layers, missing) are
// skipped and listed; a node inside another moving node is skipped too (it moves with it). merge "group:<key>"
// lets the page's widget writes of the same gesture (x-canvas-merge, src/widgets.ts) fold into this step.

import type http from "node:http";
import { findNode, StaleFileError, updateNode, type Json, type DocNode } from "./engine.ts";
import { currentDoc, editDoc } from "./docwriter.ts";
import { fitTouches, groupsAround, refitGroups } from "./groupfit.ts";
import { nodeDiff, propsOf, record, type NodeOp } from "./history.ts";
import { readBodyText } from "./body.ts";

export const NUDGE_MERGE_MS = 1000;

export type MoveMode = "board" | "absolute" | "auto" | "instance";
type Doc = { children: DocNode[] };

/** How a node's position is decided: by itself (board, absolute) or by its auto-layout parent. */
export function moveModeOf(doc: Doc, id: string): { mode: MoveMode; parentId: string | null; siblings: string[]; layout: string | null; x: number; y: number } {
  if (id.includes("/")) return { mode: "instance", parentId: null, siblings: [], layout: null, x: 0, y: 0 };
  const f = findNode(doc as any, id);
  const parent = f.parent;
  const siblings = (f.siblings as DocNode[]).map((n) => String(n.id)).filter((s) => s !== id);
  const x = typeof f.node.x === "number" ? f.node.x : 0, y = typeof f.node.y === "number" ? f.node.y : 0;
  if (!parent) return { mode: "board", parentId: null, siblings, layout: null, x, y };
  const layout = parent.type === "group" ? "none" : typeof parent.layout === "string" ? parent.layout : "horizontal";
  const absolute = layout === "none" || f.node.layoutPosition === "absolute";
  return { mode: absolute ? "absolute" : "auto", parentId: String(parent.id), siblings, layout, x, y };
}

let drops = 0;
/**
 * Is the node locked, by itself or by a layer around it? The canvas does not move locked layers: a
 * user's /api/move (the page's drags, arrow keys, align, distribute, tidy and smart spacing) leaves them where they
 * are. An agent's move (move_board, x-canvas-source mcp) still moves them.
 */
const lockedAt = (f: { node: DocNode; ancestors: DocNode[] }) => f.node.locked === true || f.ancestors.some((a) => a.locked === true);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export type MoveItem = { id?: string; x?: number; y?: number; dx?: number; dy?: number };
export type MoveBody = { file?: string; id?: string; x?: number; y?: number; dx?: number; dy?: number; round?: boolean; merge?: string; expectedRevision?: string; items?: MoveItem[] };
/** How long writes of one gesture with the same merge key keep folding into one undo step. */
export const GROUP_MERGE_MS = 3000;
export const isGroupMerge = (m: unknown): m is string => typeof m === "string" && /^group:[\w:.-]{1,80}$/.test(m);

export class MoveError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Move one node in a document (in memory, written in the background: docwriter.ts) and record the undo step. Returns where it landed. */
export function moveNode(docFile: string, b: MoveBody, who: { source: "user" | "mcp"; session?: string }) {
  const id = b.id!;
  const x = num(b.x), y = num(b.y), dx = num(b.dx), dy = num(b.dy);
  if (x === undefined && y === undefined && dx === undefined && dy === undefined) throw new MoveError(400, "invalid", "give x and/or y, or dx and/or dy");
  if (id.includes("/")) throw new MoveError(400, "instance", "that layer lives inside a component instance; move the instance, or edit the component");
  let op: NodeOp | undefined;
  let mode: MoveMode = "board";
  let at = { x: 0, y: 0 };
  let fitOps: NodeOp[] = [];
  const fit = groupsOf(docFile, [id]);
  const { write } = editDoc(docFile, { expectedRevision: b.expectedRevision, touches: [id, ...fit.touches] }, (doc) => {
    fitOps = [];
    mode = moveModeOf(doc as Doc, id).mode;
    if (mode === "auto") throw new MoveError(409, "auto_layout", "its auto-layout parent places this layer; reorder it (POST /api/layout op place, MCP place_nodes), change the parent's gap or padding, or make the layer absolute");
    const found = findNode(doc, id);
    if (who.source === "user" && lockedAt(found)) throw new MoveError(409, "locked", "this layer is locked; unlock it (Shift+Cmd+L) to move it on the canvas, or change X and Y in the inspector");
    const node = found.node;
    const before = propsOf(node);
    const cx = typeof node.x === "number" ? node.x : 0, cy = typeof node.y === "number" ? node.y : 0;
    let nx = x ?? cx + (dx ?? 0), ny = y ?? cy + (dy ?? 0);
    if (b.round) { nx = Math.round(nx); ny = Math.round(ny); }
    at = { x: nx, y: ny };
    const props: Record<string, Json> = {};
    if (nx !== cx || node.x !== undefined) props.x = nx;
    if (ny !== cy || node.y !== undefined) props.y = ny;
    const n = updateNode(doc, id, props, []);
    op = nodeDiff(id, before, propsOf(n));
    fitOps = refit(doc as Doc, fit.groups);
    if (fitOps.length) at = { x: num(n.x) ?? at.x, y: num(n.y) ?? at.y };
  });
  if (op && Object.keys(op.props).length) {
    const nudge = b.merge === "nudge";
    record(docFile, mergeOps([op, ...fitOps]), {
      label: nudge ? "Nudge" : mode === "board" ? "Move Board" : "Move Layer",
      source: who.source,
      session: who.session,
      mergeKey: nudge ? `nudge:${id}` : `move:${id}:${++drops}`,
      ...(nudge ? { mergeMs: NUDGE_MERGE_MS } : {}),
      edit: write.edit,
    }, write.revision);
  }
  return { ok: true as const, id, mode, x: at.x, y: at.y, revision: write.revision };
}

/** Move several nodes in one write and one undo step (see the top of this file). */
export function moveNodes(docFile: string, b: MoveBody, who: { source: "user" | "mcp"; session?: string }) {
  const items = (b.items ?? []).filter((it) => it && typeof it.id === "string" && it.id);
  if (!items.length || items.length > 2000) throw new MoveError(400, "invalid", "items must list 1 to 2000 nodes");
  const ops: NodeOp[] = [];
  const moved: { id: string; x: number; y: number }[] = [];
  const skipped: { id: string; code: string }[] = [];
  const fit = groupsOf(docFile, items.map((it) => it.id!));
  const { write } = editDoc(docFile, { expectedRevision: b.expectedRevision, touches: [...items.map((it) => it.id), ...fit.touches] }, (doc) => {
    ops.length = 0; moved.length = 0; skipped.length = 0; // the change may run twice (a replay after an outside save)
    const ids = new Set(items.map((it) => it.id!));
    for (const it of items) {
      const id = it.id!;
      if (id.includes("/")) { skipped.push({ id, code: "instance" }); continue; }
      let f;
      try { f = findNode(doc, id); } catch { skipped.push({ id, code: "not_found" }); continue; }
      // Inside another moving node: it goes along with that one.
      if (f.ancestors.some((a: DocNode) => ids.has(String(a.id)))) { skipped.push({ id, code: "inside" }); continue; }
      if (who.source === "user" && lockedAt(f)) { skipped.push({ id, code: "locked" }); continue; }
      if (moveModeOf(doc as Doc, id).mode === "auto") { skipped.push({ id, code: "auto_layout" }); continue; }
      const x = num(it.x), y = num(it.y), dx = num(it.dx), dy = num(it.dy);
      if (x === undefined && y === undefined && dx === undefined && dy === undefined) { skipped.push({ id, code: "invalid" }); continue; }
      const node = f.node;
      const before = propsOf(node);
      const cx = typeof node.x === "number" ? node.x : 0, cy = typeof node.y === "number" ? node.y : 0;
      let nx = x ?? cx + (dx ?? 0), ny = y ?? cy + (dy ?? 0);
      if (b.round) { nx = Math.round(nx); ny = Math.round(ny); }
      const props: Record<string, Json> = {};
      if (nx !== cx || node.x !== undefined) props.x = nx;
      if (ny !== cy || node.y !== undefined) props.y = ny;
      const n = updateNode(doc, id, props, []);
      ops.push(nodeDiff(id, before, propsOf(n)));
      moved.push({ id, x: nx, y: ny });
    }
    ops.push(...refit(doc as Doc, fit.groups));
    const merged = mergeOps(ops);
    ops.length = 0;
    ops.push(...merged);
  });
  const group = isGroupMerge(b.merge);
  if (ops.some((o) => Object.keys(o.props).length)) {
    record(docFile, ops, {
      label: b.merge === "nudge" || (group && b.merge!.startsWith("group:nudge")) ? "Nudge" : "Move",
      source: who.source,
      session: who.session,
      mergeKey: group ? b.merge : b.merge === "nudge" ? `nudge:${moved.map((m) => m.id).sort().join(",")}` : `move:${++drops}`,
      ...(group ? { mergeMs: GROUP_MERGE_MS } : b.merge === "nudge" ? { mergeMs: NUDGE_MERGE_MS } : {}),
      edit: write.edit,
    }, write.revision);
  }
  return { ok: true as const, moved, skipped, revision: write.revision };
}

/** The groups around `ids` whose bounds a change to them may move, and every id a refit of them touches. */
export function groupsOf(docFile: string, ids: string[]): { groups: string[]; touches: string[] } {
  const doc = currentDoc(docFile).doc as unknown as Doc;
  const groups = groupsAround(doc, ids);
  return { groups, touches: fitTouches(doc, groups) };
}

/** Refit `groups` in `doc` (groupfit.ts) and return the ops it made. */
export function refit(doc: Doc, groups: string[]): NodeOp[] {
  const ops: NodeOp[] = [];
  refitGroups(doc, groups, (gid, props) => {
    const n = findNode(doc as never, gid).node;
    const before = propsOf(n);
    updateNode(doc as never, gid, props, []);
    const op = nodeDiff(gid, before, propsOf(n));
    if (Object.keys(op.props).length) ops.push(op);
  });
  return ops;
}

/** Several ops on one node become one (its first before, its last after), so a step names each node once. */
export function mergeOps(ops: NodeOp[]): NodeOp[] {
  const by = new Map<string, NodeOp>();
  const out: NodeOp[] = [];
  for (const o of ops) {
    const prev = by.get(o.id);
    if (!prev) { const c = { ...o, props: { ...o.props } } as NodeOp; by.set(o.id, c); out.push(c); continue; }
    for (const [k, v] of Object.entries(o.props)) {
      const p = (prev.props as Record<string, { b?: unknown; a?: unknown }>)[k];
      (prev.props as Record<string, unknown>)[k] = p ? { ...p, a: (v as { a?: unknown }).a } : v;
    }
  }
  return out;
}

export type MoveDeps = {
  prime: (file: string) => Promise<void>;
  docFileOf: (file: string) => string;
  docOf: (docFile: string) => Doc;
  /** The revision Canvas last loaded for this document (the one the page shows). */
  revisionOf?: (docFile: string) => string | undefined;
  /** After a write: tell pages and the bridge. */
  written: (docFile: string, revision: string | undefined, by: "mcp" | "inspector", id: string) => void;
  /** After a write: the request that made it (an arrow-key nudge is an edit Repeat can do again, src/repeat.ts). */
  moved?: (docFile: string, body: MoveBody) => void;
};

export async function handleMoveRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: MoveDeps): Promise<boolean> {
  if (url.pathname !== "/api/move") return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method === "GET") {
      const file = url.searchParams.get("file"), id = url.searchParams.get("id");
      if (!file || !id) return reply(400, { error: "file and id are required", code: "invalid" }), true;
      await deps.prime(file);
      try {
        return reply(200, moveModeOf(deps.docOf(deps.docFileOf(file)), id)), true;
      } catch (e) {
        return reply(404, { error: (e as Error).message, code: "not_found" }), true;
      }
    }
    if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const raw = await readBodyText(req, 100_000);
  if (raw === null) return reply(413, { error: "too large", code: "invalid" }), true;
    const b = JSON.parse(raw || "{}") as MoveBody;
    if (b.file && Array.isArray(b.items)) {
      await deps.prime(b.file);
      const docFile = deps.docFileOf(b.file);
      const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
      const session = String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined;
      const r = moveNodes(docFile, b, { source: by === "mcp" ? "mcp" : "user", session });
      if (r.moved.length) { deps.written(docFile, r.revision, by, r.moved[0].id); deps.moved?.(docFile, b); }
      return reply(200, r), true;
    }
    if (!b.file || !b.id) return reply(400, { error: "file and id are required", code: "invalid" }), true;
    await deps.prime(b.file);
    const docFile = deps.docFileOf(b.file);
    const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
    const session = String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined;
    const r = moveNode(docFile, b, { source: by === "mcp" ? "mcp" : "user", session });
    deps.written(docFile, r.revision, by, b.id);
    deps.moved?.(docFile, b);
    return reply(200, r), true;
  } catch (e) {
    if (e instanceof MoveError) return reply(e.status, { error: e.message, code: e.code }), true;
    if (e instanceof StaleFileError) return reply(409, { error: (e as Error).message, code: "stale_revision" }), true;
    if (/no node with id/.test((e as Error).message)) return reply(404, { error: (e as Error).message, code: "not_found" }), true;
    return reply(422, { error: (e as Error).message, code: "failed" }), true;
  }
}
