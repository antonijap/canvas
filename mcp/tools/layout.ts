// Auto layout through Canvas's own write path (src/autolayout.ts, POST /api/layout): the same ops Shift+A,
// Option+Shift+A, a drag reorder and the arrow keys make in Canvas. Each lands in the shared undo history (an
// agent's edits stay one step until finish_work). When a Canvas page shows the file, the tools ask it where the
// layers are drawn (rects), so nothing jumps on screen; with Canvas closed they work from the file's numbers.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, cmd, ensureServer, resolveFile, ToolError } from "../client.ts";
import * as S from "../schemas.ts";
import { tool } from "../tool.ts";

type Rect = { x: number; y: number; w: number; h: number };
const ids = z.array(z.string().min(1).max(200)).min(1).max(200);
const enc = encodeURIComponent;

/** The ids to act on: given, or the selection in Canvas. */
async function target(a: { file?: string; ids?: string[] }): Promise<{ file: string; ids: string[] }> {
  await ensureServer();
  let list = a.ids;
  let file = a.file;
  if (!list?.length) {
    const st = await api<any>("GET", `/api/bridge/state?includeNode=0${file ? `&file=${enc(file)}` : ""}`);
    list = st.page.selection?.ids ?? [];
    file = file ?? st.page.state.file;
    if (!list?.length) throw new ToolError("invalid", "ids is required: nothing is selected in Canvas");
  }
  return { file: await resolveFile(file), ids: list! };
}

/** These ids and their parents (for the page to measure). */
async function withParents(file: string, list: string[]): Promise<string[]> {
  const out = new Set(list);
  for (const id of list.slice(0, 20)) {
    try {
      const r = await api<any>("GET", `/api/move?file=${enc(file)}&id=${enc(id)}`);
      if (r.parentId) out.add(r.parentId);
    } catch {
      // A missing id: the op itself says so.
    }
  }
  return [...out];
}

/** World rects of these nodes from the open page; {} when no page shows the file (the server falls back to the file). */
async function measure(file: string, list: string[]): Promise<Record<string, Rect>> {
  const out: Record<string, Rect> = {};
  // The page measures 50 at a time.
  for (let i = 0; i < Math.min(list.length, 400); i += 50) {
    try {
      const r: any = (await cmd({ op: "measure", args: { ids: list.slice(i, i + 50) }, file, timeoutMs: 4000 })).result;
      for (const n of r?.nodes ?? []) if (n?.drawn && n.world) out[n.id] = { x: n.world.x, y: n.world.y, w: n.world.w, h: n.world.h };
    } catch {
      // No page, or it did not answer: the file's numbers will do.
      break;
    }
  }
  return out;
}

async function run(body: Record<string, unknown>) {
  try {
    const r = await api<any>("POST", "/api/layout", body);
    return { done: r.label, changed: r.changed, select: r.select, revision: r.revision };
  } catch (e) {
    if (e instanceof ToolError && e.code === "stale_revision") throw new ToolError("stale_revision", e.message, "Read again (get_selection or inspect_node), then redo the change with the new revision.");
    if (e instanceof ToolError && e.code === "instance") throw new ToolError("instance", e.message, "Edit the component (or detach the instance) instead.");
    throw e;
  }
}

/** Children ids of frames, read from inspect_node's disk view. */
async function childrenOf(file: string, list: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of list.slice(0, 10)) {
    try {
      const r = await api<any>("GET", `/api/node?file=${enc(file)}&id=${enc(id)}&depth=1`);
      for (const c of r?.node?.children ?? []) if (typeof c?.id === "string") out.push(c.id);
    } catch {
      // Not readable: measured without its children.
    }
  }
  return out;
}

/** Every descendant id of these frames (for a deep remove: nested frames' children are measured too), at most `cap`. */
async function descendantsOf(file: string, list: string[], cap = 400): Promise<string[]> {
  const out: string[] = [];
  const todo = list.slice(0, 50);
  const seen = new Set<string>();
  while (todo.length && out.length < cap) {
    const id = todo.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    let r: any;
    try { r = await api<any>("GET", `/api/node?file=${enc(file)}&id=${enc(id)}&depth=8`); } catch { continue; }
    // /api/node answers 8 levels at a time: a node at the bottom with children unlisted is read again.
    const walk = (n: any, depth: number) => {
      for (const c of Array.isArray(n?.children) ? n.children : []) {
        if (typeof c?.id !== "string" || out.length >= cap) return;
        out.push(c.id);
        if (depth >= 7) todo.push(c.id);
        else walk(c, depth + 1);
      }
    };
    walk(r?.node, 0);
  }
  return out;
}

export function register(server: McpServer) {
  tool(server, "add_auto_layout", "Add auto layout (Shift+A in Canvas). One frame without auto layout becomes an auto layout frame: direction, gap, alignment and padding are inferred from where its layers sit, children are ordered by position and it hugs its content. Anything else (loose layers, several layers, a frame that already has auto layout) is wrapped in a new auto layout frame where the selection was. One undo step; returns the frame id in select.", {
    file: S.file, ids: ids.optional().describe("Node ids; default: what is selected in Canvas"), expectedRevision: z.string().optional(),
  }, async (a) => {
    const t = await target(a);
    const rects = await measure(t.file, [...(await withParents(t.file, t.ids)), ...(await childrenOf(t.file, t.ids))]);
    return run({ file: t.file, op: "add", ids: t.ids, rects, expectedRevision: a.expectedRevision });
  });

  tool(server, "remove_auto_layout", "Remove auto layout (Option+Shift+A): the frame keeps its size (Fixed), every layer stays where it is drawn (its x/y is written) and Fill layers become Fixed. deep: also every nested auto layout frame. Instances refuse (detach first). One undo step.", {
    file: S.file, ids: ids.optional().describe("Auto layout frame ids; default: what is selected in Canvas"), deep: z.boolean().optional().describe("Also remove it from every nested auto layout frame"), expectedRevision: z.string().optional(),
  }, async (a) => {
    const t = await target(a);
    const kids = a.deep === true ? await descendantsOf(t.file, t.ids) : await childrenOf(t.file, t.ids);
    const rects = await measure(t.file, [...t.ids, ...kids]);
    return run({ file: t.file, op: "remove", ids: t.ids, deep: a.deep === true, rects, expectedRevision: a.expectedRevision });
  }, { destructiveHint: true });

  tool(server, "place_nodes", "Move layers to a parent at an index: reorder inside an auto layout frame (drag reorder and arrow keys), move into a frame's flow, or out to a free spot. index is where the first layer ends up among the parent's other children (0 = first); several layers stay together in their order. In an auto layout parent the layers join the flow, unless absolute gives each one x/y in the parent's coordinates (Ignore auto layout, Ctrl+drag in). In a free parent (a board, group or layout none frame; null = the canvas) they keep their place on screen. Ids stay the same. One undo step.", {
    file: S.file, ids: ids.describe("Node ids to move"),
    parent: z.string().min(1).max(200).nullable().describe("Frame or group id, or null for the canvas (top level)"),
    index: z.number().int().min(0).optional().describe("Final index of the first layer among the parent's other children in the file, hidden layers included (required unless before is given)"),
    before: z.string().min(1).max(200).nullable().optional().describe("Instead of index: the sibling the layers land right before (null: last). Counts the same with hidden layers"),
    absolute: z.array(z.object({ x: z.number(), y: z.number() }).nullable()).optional().describe("Per id: x/y in the parent's coordinates; places it absolutely (Ignore auto layout)"),
    expectedRevision: z.string().optional(),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    const rects = await measure(file, [...(await withParents(file, a.ids)), ...(a.parent ? [a.parent] : [])]);
    if (a.index === undefined && a.before === undefined) throw new ToolError("invalid", "index or before is required");
    return run({ file, op: "place", ids: a.ids, parent: a.parent, ...(a.before !== undefined ? { before: a.before } : { index: a.index }), absolute: a.absolute, rects, expectedRevision: a.expectedRevision });
  });
}
