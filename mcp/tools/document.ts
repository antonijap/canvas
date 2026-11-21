// Facts about a document that need no open page: summary, fonts, lookup, inspect.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, cmd, ensureServer, resolveFile, ToolError } from "../client.ts";
import * as S from "../schemas.ts";
import { tool } from "../tool.ts";
import { variableEdit } from "../../src/doc/variables.ts";

const enc = encodeURIComponent;

/** Rendered boxes for ids from the active page, or a note on why there are none. */
export async function renderedFor(ids: string[], file: string, client?: string): Promise<{ boxes: Record<string, unknown>; note?: string }> {
  if (!ids.length) return { boxes: {} };
  try {
    const r = (await cmd({ op: "measure", args: { ids: ids.slice(0, 50) }, client, file, timeoutMs: 8000 })).result as { nodes: { id: string }[] };
    return { boxes: Object.fromEntries(r.nodes.map((n) => [n.id, n])) };
  } catch (e) {
    const t = e as ToolError & { hint?: string };
    return { boxes: {}, note: `No rendered sizes (${t.code ?? "failed"}): ${t.message}${t.hint ? `. ${t.hint}` : ""}` };
  }
}

export function register(server: McpServer) {
  tool(server, "get_document_summary", "One screenful about a Canvas file: boards (position, size, node counts), components, variables, themes, fonts in use, revision. Works with Canvas closed. Start here.", { file: S.file }, async (a) => {
    await ensureServer();
    return api("GET", `/api/summary?file=${enc(await resolveFile(a.file))}`);
  }, { readOnlyHint: true });

  tool(server, "set_variables", "Create or update file variables. Keys are names without $. Values are numbers, strings, hex colours, or a {light, dark} pair of the same type. Optional remove names are deleted before setting new values. One batch in Canvas undo history. Pass file to work with Canvas closed.", {
    file: S.file, ...variableEdit,
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    return api("POST", "/api/variables", { file, variables: a.variables, remove: a.remove });
  }, { destructiveHint: true });

  tool(server, "get_fonts", "Fonts a file uses and whether each is installed on this Mac, embedded in the file, drawn from the web (Google Fonts) or missing. onlyMissing keeps the ones that are not installed or embedded.", {
    file: S.file,
    onlyMissing: z.boolean().optional().describe("Only fonts that are not installed on this Mac and not embedded (status web or missing)"),
  }, async (a) => {
    await ensureServer();
    const r = await api<any>("GET", `/api/fonts?file=${enc(await resolveFile(a.file))}`, undefined, { timeoutMs: 30_000 });
    if (a.onlyMissing) r.fonts = r.fonts.filter((f: any) => f.status === "web" || f.status === "missing");
    return r;
  }, { readOnlyHint: true });

  tool(server, "list_installed_fonts", "Font families installed on this Mac (from the app when it runs, else the system font list). Filter with query.", {
    query: z.string().optional().describe("Case-insensitive substring"),
    limit: z.number().int().min(1).max(1000).optional(),
  }, async (a) => {
    await ensureServer();
    const r = await api<{ source: string; families: string[] }>("GET", "/api/bridge/installed-fonts", undefined, { timeoutMs: 30_000 });
    const q = a.query?.toLowerCase();
    const all = q ? r.families.filter((f) => f.toLowerCase().includes(q)) : r.families;
    return { source: r.source, total: all.length, families: all.slice(0, a.limit ?? 100) };
  }, { readOnlyHint: true });

  tool(server, "lookup_nodes", "Find nodes by id, name, text content, type or component flag (case-insensitive substrings). Each hit carries its top-level board. rendered:true adds on-screen sizes from the open page.", {
    file: S.file,
    id: z.string().optional().describe("An exact id or instance path alone answers that node; otherwise ids containing it"),
    name: z.string().optional(),
    text: z.string().optional().describe("Matches text content"),
    type: z.string().optional().describe("frame, text, ref, rectangle, icon, ..."),
    reusable: z.boolean().optional().describe("true = components only"),
    within: z.string().optional().describe("Only search inside this node id"),
    limit: z.number().int().min(1).max(500).optional(),
    rendered: z.boolean().optional().describe("Add rendered world/screen boxes from the active page"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    const q = new URLSearchParams({ file });
    for (const k of ["id", "name", "text", "type", "within", "limit"] as const) if (a[k] !== undefined) q.set(k, String(a[k]));
    if (a.reusable !== undefined) q.set("reusable", String(a.reusable));
    const r = await api<any>("GET", `/api/find?${q}`);
    if (a.rendered) {
      const { boxes, note } = await renderedFor(r.results.map((x: any) => x.id), file);
      for (const x of r.results) x.rendered = boxes[x.id] ?? null;
      if (note) r.note = note;
    }
    return r;
  }, { readOnlyHint: true });

  tool(server, "inspect_node", "Full JSON of one node (children cut off below depth), its parent, and its revision. Omit id to inspect the node selected in Canvas. includeRendered adds its on-screen box.", {
    file: S.file,
    id: z.string().optional().describe("Node id or instance path; default: the current selection"),
    depth: S.depth,
    includeRendered: z.boolean().optional(),
  }, async (a) => {
    await ensureServer();
    let id: string | undefined = a.id;
    let file: string | undefined = a.file;
    if (!id) {
      const st = await api<any>("GET", `/api/bridge/state?includeNode=0${file ? `&file=${enc(file)}` : ""}`);
      id = st.page.selection?.ids?.[0];
      file = file ?? st.page.state.file;
      if (!id) throw new ToolError("invalid", "id is required: nothing is selected in Canvas");
    }
    file = await resolveFile(file);
    const n = await api<any>("GET", `/api/node?file=${enc(file)}&id=${enc(id)}&depth=${a.depth ?? 4}`);
    const out: any = { id, ...n };
    if (a.includeRendered) {
      const { boxes, note } = await renderedFor([id], file);
      out.rendered = boxes[id] ?? null;
      if (note) out.note = note;
    }
    return out;
  }, { readOnlyHint: true });
}
