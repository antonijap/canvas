// Variations in one keystroke (src/variations.ts): start three variations of a board or layer, keep one or discard
// them; the product brief; and the tools a variations run uses (the context pack, the quality gate, marking a copy done).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ensureServer, resolveFile, ToolError } from "../client.ts";
import * as S from "../schemas.ts";
import { renderedFor } from "./document.ts";
import { tool } from "../tool.ts";

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
const fileOf = async (f?: string) => {
  await ensureServer();
  return resolveFile(f);
};

export function register(server: McpServer) {
  tool(server, "make_variations", "Make 3 variations of a board or a layer side by side (Shift+Cmd+Return in Canvas): Canvas copies the board three times beside the original and runs the person's own agent (Claude Code, Codex as the backup) with the file's design system, its product brief, real references and her design skills. Returns the set; follow it with list_variations. One undo step for the copies and the agent's edits.", {
    file: S.file,
    ids: z.array(z.string().min(1).max(200)).min(1).max(50).optional().describe("The board or layers to vary; default: the selection in Canvas"),
    harness: z.enum(["claude", "codex"]).optional().describe("Default: Settings > Agents"),
  }, async (a) => {
    const t = await target(a);
    // The boards' drawn boxes, as the page sends them: a Hug board has no width in the file, and without its real
    // size the copies were placed 480 px apart, on top of each other.
    const rects: Record<string, { x: number; y: number; w: number; h: number }> = {};
    try {
      const sum = await api<{ boards: { id: string }[] }>("GET", `/api/summary?file=${enc(t.file)}`);
      const ids = sum.boards.map((b) => b.id);
      for (let i = 0; i < ids.length && i < 300; i += 50) {
        const { boxes } = await renderedFor(ids.slice(i, i + 50), t.file);
        for (const [id, n] of Object.entries(boxes) as [string, any][]) if (n && n.world) rects[id] = { x: n.world.x, y: n.world.y, w: n.world.w, h: n.world.h };
      }
    } catch { /* no page: the file's own sizes */ }
    return (await api<any>("POST", "/api/variations/make", { file: t.file, ids: t.ids, harness: a.harness, rects })).set;
  });

  tool(server, "list_variations", "The file's variation sets: status (making, review, kept, discarded, failed, gone), the copies with their directions, references and how many are done.", { file: S.file }, async (a) => {
    return api("GET", `/api/variations/sets?file=${enc(await fileOf(a.file))}`);
  }, { readOnlyHint: true });

  tool(server, "keep_variation", "Keep one variation: the other copies are deleted in one undo step (Keep Variation).", {
    file: S.file, set: z.string().min(1).max(40), id: z.string().min(1).max(200).describe("The copy board to keep"),
  }, async (a) => (await api<any>("POST", "/api/variations/keep", { file: await fileOf(a.file), set: a.set, id: a.id })).set, { destructiveHint: true });

  tool(server, "discard_variations", "Discard every copy of a set in one undo step (Esc in Canvas); a set still being made stops first.", {
    file: S.file, set: z.string().min(1).max(40),
  }, async (a) => (await api<any>("POST", "/api/variations/discard", { file: await fileOf(a.file), set: a.set })).set, { destructiveHint: true });

  tool(server, "get_product_brief", "The file's product brief (what the product is, who for, platform, tone), or null.", { file: S.file }, async (a) => {
    return api("GET", `/api/variations/brief?file=${enc(await fileOf(a.file))}`);
  }, { readOnlyHint: true });

  tool(server, "set_product_brief", "Save the file's product brief: a few short lines (Product:, For:, Platform:, Tone:). Empty text removes it. Kept with the file, not in the design; not an undo step.", {
    file: S.file, text: z.string().max(2000), drafted: z.boolean().optional().describe("true when an agent drafted it from the file"),
  }, async (a) => api("POST", "/api/variations/brief", { file: await fileOf(a.file), text: a.text, drafted: a.drafted ?? true }));

  tool(server, "get_design_context", "The context pack for designing on a selection: the file's variables, text styles as used, components, literal colours and spacing scale, the nearest boards on the page, the product brief and which of the person's design skills apply.", {
    file: S.file, ids: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
  }, async (a) => {
    const t = await target(a);
    return api("GET", `/api/variations/context?file=${enc(t.file)}&ids=${enc(t.ids.join(","))}`);
  }, { readOnlyHint: true });

  tool(server, "check_variation", "The quality gate for a board or layer: colours not from the file's variables or palette, spacing off its scale, near-miss alignment, dividers that do not span edge to edge, grey text on a coloured background, one-line labels not at line height 100%, clipped glyphs, middots or dashes in copy. Each issue names the layer and the fix. Fix them all.", {
    file: S.file, id: S.nodeId,
  }, async (a) => api("GET", `/api/variations/check?file=${enc(await fileOf(a.file))}&id=${enc(a.id)}`), { readOnlyHint: true });

  tool(server, "mark_variation", "A variations run says a copy is done, after check_variation passes: the gate runs again and refuses (ok:false with the issues) while any remain, twice; the third call takes it as it is. direction: its name (one or two words); why: one line; refs: the apps it follows.", {
    file: S.file, id: z.string().min(1).max(200).describe("The copy board"), direction: z.string().min(1).max(40), why: z.string().max(200).optional(), refs: z.array(z.string().max(80)).max(10).optional(),
  }, async (a) => {
    const r = await api<any>("POST", "/api/variations/mark", { file: await fileOf(a.file), id: a.id, direction: a.direction, why: a.why, refs: a.refs });
    if (!r.ok) throw new ToolError("gate_failed", `${r.issues.length} issue(s): ${r.issues.map((i: any) => `${i.name} (${i.id}): ${i.message}`).join("; ")}`, r.hint);
    return r;
  });
}
