// Small property edits through Canvas's own write path (the inspector's), and undo/redo of the shared
// history (the same steps the person's Cmd+Z walks). Structure edits are in tools/structure.ts; new nodes come from add_nodes there.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ensureServer, resolveFile, ToolError } from "../client.ts";
import * as S from "../schemas.ts";
import { checkMotion } from "../../cloud/core/motion.ts";
import { tool } from "../tool.ts";

export function register(server: McpServer) {
  tool(server, "set_node_props", "Set properties on one node, including a whole motion array (shallow merge; remove deletes properties), the same write the inspector does. Omit id to edit the selected node. Pass the revision from get_selection as expectedRevision: if the file changed since, nothing is written and you get stale_revision. Delete, duplicate, group or reorder with delete_nodes, duplicate_nodes, group_nodes, reorder_nodes; add new nodes with add_nodes.", {
    file: S.file,
    id: z.string().optional().describe("Node id; default: the selected node"),
    props: z.record(z.string(), z.any()).describe("e.g. {content:'New text', fill:'#0766EB', width:'fill_container'}. A shader fill (frames, rectangles, ellipses; animates in the layer, clipped to its shape): fill:['#FFFFFF', {type:'shader', shader:'mesh-gradient', preset:'Ink', params:{speed:0.5}}] (ids, presets and params from list_shader_presets; the last fill paints on top), or {type:'shader', source:'fn shade(p: vec2<f32>) -> vec4<f32> {...}', uniforms:[...]} for your own WGSL. An image fill: {type:'image', url:'media/x.png', mode:'fill'}. Style part of a text: spans:[{start:6, end:11, fontWeight:'700', fill:'#E5484D'}] (start and end count UTF-16 units of content, end exclusive, sorted, no overlaps; keys fontFamily, fontSize, fontWeight, fontStyle, fill, underline, strikethrough, letterSpacing; each says only what differs from the layer). A key set on the whole layer (fontWeight, fill...) takes it off the spans; new content carries them along. Truncate text: textTruncation:'ending', maxLines:2. enabled:false hides a layer; locked:true locks it (canvas clicks and the marquee pass through it and its children; the Layers panel still selects it); remove ['locked'] unlocks"),
    remove: z.array(z.string()).optional(),
    expectedRevision: z.string().optional().describe("Revision from your last read"),
  }, async (a) => {
    await ensureServer();
    let id: string | undefined = a.id;
    let file: string | undefined = a.file;
    if (!id) {
      const st = await api<any>("GET", `/api/bridge/state?includeNode=0${file ? `&file=${encodeURIComponent(file)}` : ""}`);
      // The selected node is the one Canvas's inspector shows: the last one clicked (primary), not the first id.
      const sel = st.page.selection;
      id = typeof sel?.primary === "string" ? sel.primary : sel?.ids?.at(-1);
      file = file ?? st.page.state.file;
      if (!id) throw new ToolError("invalid", "id is required: nothing is selected in Canvas");
      if (id.startsWith("widget:")) throw new ToolError("invalid", `the selected item is a card (${id}), not a layer`, "Pass a node id, or use update_widget for the card.");
    }
    file = await resolveFile(file);
    try {
      const r = await api<any>("POST", "/api/update", { file, id, props: a.props, remove: a.remove, expectedRevision: a.expectedRevision });
      const warnings: string[] = [];
      if (a.props.motion !== undefined) checkMotion(a.props.motion, `node ${id}`, [], warnings);
      return { id, revision: r.revision, node: r.node, ...(warnings.length ? { warnings } : {}) };
    } catch (e) {
      if (e instanceof ToolError && e.code === "stale_revision") throw new ToolError("stale_revision", e.message, "Read again (get_selection or inspect_node), then redo the change with the new revision.");
      throw e;
    }
  });

  tool(server, "move_board", "Move a board (a top-level frame) or an absolutely placed layer: x/y set its position, dx/dy shift it. One undo step, the same write a drag in Canvas makes. A board whose new spot would overlap another board or card on its page moves right along its row until clear, and the answer says so (note, movedFrom); allowOverlap: true keeps the spot. The answer has the board's final x, y, width and height. Children of an auto-layout frame refuse with auto_layout (their parent places them): reorder them, or move them out, with place_nodes.", {
    file: S.file,
    id: z.string().describe("Board or layer id"),
    x: z.number().optional(),
    y: z.number().optional(),
    dx: z.number().optional().describe("Shift right by this many px (negative: left)"),
    dy: z.number().optional().describe("Shift down by this many px (negative: up)"),
    round: z.boolean().optional().describe("Round the result to whole px (default true)"),
    allowOverlap: z.boolean().optional().describe("Boards: keep the spot even where it overlaps another board (default false: moved right until clear)"),
    expectedRevision: z.string().optional().describe("Revision from your last read"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    if (a.x === undefined && a.y === undefined && a.dx === undefined && a.dy === undefined) throw new ToolError("invalid", "give x and/or y, or dx and/or dy");
    const r = await api<any>("POST", "/api/move", { file, id: a.id, x: a.x, y: a.y, dx: a.dx, dy: a.dy, round: a.round ?? true, ...(a.allowOverlap ? { allowOverlap: true } : {}), expectedRevision: a.expectedRevision });
    return { id: r.id, mode: r.mode, x: r.x, y: r.y, ...(typeof r.width === "number" ? { width: r.width, height: r.height } : {}), revision: r.revision, ...(r.movedFrom ? { movedFrom: r.movedFrom, clearOf: r.clearOf } : {}), ...(r.note ? { note: r.note } : {}) };
  });

  tool(server, "scale_nodes", "Scale layers with everything inside them, like a scale tool (K): positions, sizes, font sizes, letter spacing, strokes, corner radii, effects, padding and gap of every descendant, and instance overrides. fit_content/fill_container stay modes; token-bound values stay bound (counted in kept); line height stays (a multiple of the font size). Give factor (1.5 = 150%), or the width or height the layers should end at. One undo step. Omit ids to scale the selection.", {
    file: S.file,
    ids: z.array(z.string().min(1).max(200)).min(1).max(200).optional().describe("Node ids; default: what is selected in Canvas"),
    factor: z.number().min(0.01).max(100).optional().describe("Scale factor: 2 doubles, 0.5 halves"),
    width: z.number().positive().optional().describe("Instead of factor: the width to end at (the layers' stored width must be a number)"),
    height: z.number().positive().optional().describe("Instead of factor: the height to end at"),
    anchor: z.enum(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]).optional().describe("The point that stays put (default top-left). Only for layers that place themselves; auto-layout children are placed by their parent"),
    expectedRevision: z.string().optional().describe("Revision from your last read"),
  }, async (a) => {
    await ensureServer();
    let ids = a.ids;
    let file = a.file;
    if (!ids?.length) {
      const st = await api<any>("GET", `/api/bridge/state?includeNode=0${file ? `&file=${encodeURIComponent(file)}` : ""}`);
      ids = st.page.selection?.ids ?? [];
      file = file ?? st.page.state.file;
      if (!ids?.length) throw new ToolError("invalid", "ids is required: nothing is selected in Canvas");
    }
    if ([a.factor, a.width, a.height].filter((v) => v !== undefined).length !== 1) throw new ToolError("invalid", "give exactly one of factor, width or height");
    // Cards are not layers: they stay out, and the answer says so (they were skipped without a word).
    const cards = ids.filter((id: string) => id.startsWith("widget:"));
    ids = ids.filter((id: string) => !id.startsWith("widget:"));
    if (!ids.length) throw new ToolError("invalid", "these are cards (widgets, videos, shaders), not layers", "Resize a card with update_widget (w, h).");
    file = await resolveFile(file);
    try {
      const r = await api<any>("POST", "/api/scale", { file, ids, factor: a.factor, width: a.width, height: a.height, anchor: a.anchor, expectedRevision: a.expectedRevision });
      return { ids: r.ids, factor: r.factor, changed: r.changed.length, kept: r.kept, revision: r.revision, ...(cards.length ? { leftOut: cards, note: `${cards.length} card(s) left out: scale works on layers (resize cards with update_widget)` } : {}) };
    } catch (e) {
      if (e instanceof ToolError && e.code === "stale_revision") throw new ToolError("stale_revision", e.message, "Read again (get_selection or inspect_node), then redo the change with the new revision.");
      throw e;
    }
  });

  /** The ids given, or what is selected in Canvas; the file the selection is in when none is given. */
  async function idsOrSelection(file: string | undefined, ids: string[] | undefined): Promise<{ file: string; ids: string[] }> {
    if (!ids?.length) {
      const st = await api<any>("GET", `/api/bridge/state?includeNode=0${file ? `&file=${encodeURIComponent(file)}` : ""}`);
      ids = (st.page.selection?.ids ?? []).filter((id: string) => !id.startsWith("widget:"));
      file = file ?? st.page.state.file;
      if (!ids?.length) throw new ToolError("invalid", "ids is required: no instance is selected in Canvas");
    }
    return { file: await resolveFile(file), ids: ids! };
  }
  const stale = (e: unknown) => {
    if (e instanceof ToolError && e.code === "stale_revision") return new ToolError("stale_revision", e.message, "Read again (get_selection or inspect_node), then redo the change with the new revision.");
    return e;
  };

  tool(server, "swap_instance", "Swap component instances for another component: each instance points at the new component and keeps its place, size and own overrides; an override on a layer inside it (text, fill, font...) carries over when the new component has a layer of the same type at the same path of layer names, and is dropped otherwise (listed in dropped). An instance named after its old main follows the new main's name. A nested instance (an instance inside another instance, an id like Outer/Nested) swaps through an override in the outer instance: the main components stay as they are, its id stays, and reset_overrides with props ['ref'] puts the original back. One undo step. Omit ids to swap the selected instances. Components: get_document_summary.", {
    file: S.file,
    ids: z.array(z.string().min(1).max(400)).min(1).max(200).optional().describe("Instance ids, or nested instance paths (Outer/Nested); default: the selected instances"),
    component: z.string().min(1).max(200).describe("The id of the component to swap to (a node with reusable: true)"),
    expectedRevision: z.string().optional().describe("Revision from your last read"),
  }, async (a) => {
    await ensureServer();
    const { file, ids } = await idsOrSelection(a.file, a.ids);
    try {
      const r = await api<any>("POST", "/api/overrides/swap", { file, ids, component: a.component, expectedRevision: a.expectedRevision });
      return { ids, changed: r.changed, kept: r.kept, dropped: r.dropped, revision: r.revision };
    } catch (e) { throw stale(e); }
  });

  tool(server, "reset_overrides", "Reset an instance's overrides: on an instance, its own overrides (not where it sits or its size) and those on every layer inside it; on a layer inside an instance (an id like Inst/Label), that layer's. Give props to reset only those properties (e.g. ['fill'], ['content']; on an instance, 'descendants' resets every layer inside it). One undo step.", {
    file: S.file,
    id: z.string().min(1).max(400).optional().describe("Instance id, or a layer inside one (Inst/Child); default: the selected node"),
    props: z.array(z.string().min(1).max(60)).max(60).optional().describe("Only these properties; default: all"),
    expectedRevision: z.string().optional().describe("Revision from your last read"),
  }, async (a) => {
    await ensureServer();
    const { file, ids } = await idsOrSelection(a.file, a.id ? [a.id] : undefined);
    try {
      const r = await api<any>("POST", "/api/overrides/reset", { file, id: ids[0], keys: a.props, expectedRevision: a.expectedRevision });
      return { id: ids[0], changed: r.changed, revision: r.revision };
    } catch (e) { throw stale(e); }
  });

  tool(server, "push_overrides", "Push an instance's overrides to its main component: the instance's own overrides and those on layers inside it become the main component's values (every instance without its own override of a property takes them), and leave the instance. A replacement layer stays on the instance (in kept). One undo step.", {
    file: S.file,
    id: z.string().min(1).max(200).optional().describe("Instance id; default: the selected node"),
    expectedRevision: z.string().optional().describe("Revision from your last read"),
  }, async (a) => {
    await ensureServer();
    const { file, ids } = await idsOrSelection(a.file, a.id ? [a.id] : undefined);
    try {
      const r = await api<any>("POST", "/api/overrides/push", { file, id: ids[0], expectedRevision: a.expectedRevision });
      return { id: ids[0], changed: r.changed, main: r.main, pushed: r.pushed, kept: r.kept, revision: r.revision };
    } catch (e) { throw stale(e); }
  }, { destructiveHint: true });

  for (const dir of ["undo", "redo"] as const) {
    tool(server, dir, dir === "undo"
      ? "Undo the newest step in the file's history, the same one Cmd+Z in Canvas undoes: an inspector edit, a set_node_props, a widget or page change, or a whole agent step (everything an MCP session changed up to finish_work). Returns the step's label. If the document changed since in the same place, nothing is written and you get conflict; calling undo again within 10 s skips that step."
      : "Redo the step undo last reversed. Any new edit clears redo. Same conflict rule as undo.", {
      file: S.file,
    }, async (a) => {
      await ensureServer();
      const file = await resolveFile(a.file);
      try {
        const r = await api<any>("POST", `/api/history/${dir}?file=${encodeURIComponent(file)}`, {});
        return { [dir === "undo" ? "undid" : "redid"]: r.label, ...(r.skipped ? { skipped: true } : {}), revision: r.revision, next: { undo: r.state.undo, redo: r.state.redo } };
      } catch (e) {
        if (e instanceof ToolError && e.code === "conflict") throw new ToolError("conflict", e.message, `Call ${dir} again within 10 s to skip this step, or leave it.`);
        throw e;
      }
    }, { destructiveHint: true });
  }
}
