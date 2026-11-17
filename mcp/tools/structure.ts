// Structure edits through Canvas's own write path (src/structure.ts), the same ones Backspace, Cmd+D, Cmd+G,
// Shift+Cmd+G and Cmd+[ ] make in Canvas: each lands in the shared undo history (an agent's edits stay one step
// until finish_work). add_nodes makes new layers the same way a paste does.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ensureServer, resolveFile, ToolError } from "../client.ts";
import * as S from "../schemas.ts";
import { tool } from "../tool.ts";
import { activeFor } from "./pages.ts";

const ids = z.array(z.string().min(1).max(200)).min(1).max(200).optional().describe("Node ids; default: what is selected in Canvas");

/** The ids to act on: given, or the selection in Canvas. */
async function target(a: { file?: string; ids?: string[] }): Promise<{ file: string; ids: string[] }> {
  await ensureServer();
  let list = a.ids;
  let file = a.file;
  if (!list?.length) {
    const st = await api<any>("GET", `/api/bridge/state?includeNode=0${file ? `&file=${encodeURIComponent(file)}` : ""}`);
    list = st.page.selection?.ids ?? [];
    file = file ?? st.page.state.file;
    if (!list?.length) throw new ToolError("invalid", "ids is required: nothing is selected in Canvas");
  }
  return { file: await resolveFile(file), ids: list! };
}
async function run(body: Record<string, unknown>) {
  // Cards (widgets, videos, shaders) in the ids are not layers: the op leaves them, and the answer says so.
  const cards = ((body.ids as string[] | undefined) ?? []).filter((id) => id.startsWith("widget:"));
  if (cards.length && cards.length === (body.ids as string[]).length) throw new ToolError("invalid", "these are cards (widgets, videos, shaders), not layers", "Use remove_widget, update_widget or the video and shader tools for cards.");
  const leftOut = cards.length ? { leftOut: cards, note: `${cards.length === 1 ? "1 card was" : `${cards.length} cards were`} left out: ${String(body.op)} works on layers and boards (cards have their own tools: remove_widget, update_widget)` } : {};
  try {
    const r = await api<any>("POST", "/api/structure", body);
    return { done: r.label, select: r.select, revision: r.revision, ...leftOut, ...(Array.isArray(r.warnings) && r.warnings.length ? { warnings: r.warnings } : {}) };
  } catch (e) {
    if (e instanceof ToolError && e.code === "stale_revision") throw new ToolError("stale_revision", e.message, "Read again (get_selection or inspect_node), then redo the change with the new revision.");
    throw e;
  }
}

export function register(server: McpServer) {
  tool(server, "add_nodes", "Add new layers or boards, written as Canvas node JSON with children (types: frame, group, rectangle, ellipse, polygon, path, text, note, icon, ref for a component instance). One undo step in Canvas's history, like a paste. parent: a frame or group id, or null/omitted for the canvas (new boards; they land on the page the open canvas shows unless page is given). index: where the first one goes among the parent's children (default: last, on top). In an auto layout parent they join the flow. An id you give is kept when it is free in the file, so you can reach the layers later; otherwise a fresh id is made. Returns the top-level ids in select. Frames lay out children with layout: vertical|horizontal|none, gap, padding, justifyContent, alignItems; sizes are numbers, 'fit_content' or 'fill_container'. Colors are #RRGGBB(AA) or $variable. Text needs content, fontFamily, fontSize, fontWeight (a string like \"600\") and fill. Read the file's variables and components first (get_document_summary) and reuse them. Look after: screenshot_view or render_node.", {
    file: S.file,
    nodes: z.array(z.record(z.string(), z.any())).min(1).max(500).describe("The layers to add, in order, each with its children"),
    parent: z.string().min(1).max(200).nullable().optional().describe("Frame or group to add into; null or omitted: the canvas (top level)"),
    index: z.number().int().min(0).optional().describe("Index of the first new layer among the parent's children (default: last)"),
    page: z.string().min(1).max(200).optional().describe("New boards only: the page id they go on (default: the page the open canvas shows)"),
    expectedRevision: z.string().optional(),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    const page = a.page ?? (a.parent ? undefined : (await activeFor(file).catch(() => null)) ?? undefined);
    return run({ file, op: "add", nodes: a.nodes, place: { parent: a.parent ?? null, ...(a.index !== undefined ? { index: a.index } : {}) }, ...(page ? { page } : {}), expectedRevision: a.expectedRevision });
  });

  tool(server, "delete_nodes", "Delete nodes or boards (Backspace in Canvas): one undo step. Layers inside a selected board go with it. Refuses (component_in_use) when a component in the selection still has instances elsewhere. Returns what Canvas selects next.", {
    file: S.file, ids, expectedRevision: z.string().optional(),
  }, async (a) => {
    const t = await target(a);
    return run({ file: t.file, op: "delete", ids: t.ids, expectedRevision: a.expectedRevision });
  }, { destructiveHint: true });

  tool(server, "duplicate_nodes", "Duplicate nodes (Cmd+D): boards land to the right with a 40 px gap clear of other boards, layers in auto layout right after themselves, other layers 10 px down and right. Fresh ids; returns them in select.", {
    file: S.file, ids, expectedRevision: z.string().optional(),
  }, async (a) => {
    const t = await target(a);
    return run({ file: t.file, op: "duplicate", ids: t.ids, expectedRevision: a.expectedRevision });
  });

  tool(server, "group_nodes", "Group layers that share a parent (Cmd+G), or wrap them in a new frame the size of the selection (frame:true, Opt+Cmd+G). Layers keep their place on the canvas. Layers placed by auto layout need the page's measurements: select them in Canvas, or expect them at 0,0 of their parent.", {
    file: S.file, ids, frame: z.boolean().optional().describe("Make a frame (layout none) instead of a group"), expectedRevision: z.string().optional(),
  }, async (a) => {
    const t = await target(a);
    return run({ file: t.file, op: a.frame ? "frame" : "group", ids: t.ids, expectedRevision: a.expectedRevision });
  });

  tool(server, "ungroup_nodes", "Ungroup (Shift+Cmd+G): groups and frames hand their layers to their parent in place and go away. Components refuse.", {
    file: S.file, ids, expectedRevision: z.string().optional(),
  }, async (a) => {
    const t = await target(a);
    return run({ file: t.file, op: "ungroup", ids: t.ids, expectedRevision: a.expectedRevision });
  });

  tool(server, "reorder_nodes", "Change stacking order among siblings: forward (Cmd+]), backward (Cmd+[), front (Opt+Cmd+]), back (Opt+Cmd+[). In an auto-layout frame this changes the layout order; to put a layer at a given slot (or into another frame), use place_nodes.", {
    file: S.file, ids, dir: z.enum(["forward", "backward", "front", "back"]), expectedRevision: z.string().optional(),
  }, async (a) => {
    const t = await target(a);
    return run({ file: t.file, op: "reorder", ids: t.ids, dir: a.dir, expectedRevision: a.expectedRevision });
  });
}
