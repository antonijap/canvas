// Pages: named groups of boards (Canvas metadata beside the design; other apps still show every board).
// Which page a viewer shows is theirs; set_active_page switches the open canvas page.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, cmd, ensureServer, resolveFile, status } from "../client.ts";
import * as S from "../schemas.ts";
import { tool } from "../tool.ts";

const enc = encodeURIComponent;
const pageId = z.string().min(1).max(40).describe("Page id (from list_pages)");
const boardIds = z.array(z.string().min(1).max(200)).min(1).max(5000).describe("Top-level board ids");

/** The active page of the canvas page showing this file, if one is open. */
export async function activeFor(file: string): Promise<string | null> {
  try {
    const s = await status();
    const hit = (s.active?.file === file ? s.pages.find((p: any) => p.client === s.active?.client) : undefined) ?? s.pages.find((p: any) => p.file === file);
    return (hit as any)?.page ?? null;
  } catch {
    return null;
  }
}

export function register(server: McpServer) {
  tool(server, "list_pages", "The document's pages in order, each with its board ids (document order). The first page is the default page: boards no page lists show there. active is the page the open canvas shows, when one is open. Works with Canvas closed.", { file: S.file }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    const r = await api<any>("GET", `/api/pages?file=${enc(file)}`);
    return { ...r, active: await activeFor(file) };
  }, { readOnlyHint: true });

  tool(server, "create_page", "Add a page. name defaults to \"Page N\"; index places it (default last); boards moves those boards onto it.", {
    file: S.file,
    name: z.string().min(1).max(120).optional(),
    index: z.number().int().min(0).optional(),
    boards: boardIds.optional(),
  }, async (a) => {
    await ensureServer();
    return api("POST", `/api/pages?file=${enc(await resolveFile(a.file))}`, { name: a.name, index: a.index, boards: a.boards });
  });

  tool(server, "rename_page", "Rename a page, and optionally move it to another position (index).", {
    file: S.file,
    id: pageId,
    name: z.string().min(1).max(120).optional(),
    index: z.number().int().min(0).optional(),
  }, async (a) => {
    await ensureServer();
    return api("PATCH", `/api/pages/${enc(a.id)}?file=${enc(await resolveFile(a.file))}`, { name: a.name, index: a.index });
  });

  tool(server, "delete_page", "Delete a page and everything on it: its boards (with their layers) go from the design file and its cards from the canvas, as one undo step. To keep boards, move_boards_to_page first. The last page cannot be deleted. Answers { result: { boards, widgets } } with how many went.", {
    file: S.file,
    id: pageId,
  }, async (a) => {
    await ensureServer();
    return api("DELETE", `/api/pages/${enc(a.id)}?file=${enc(await resolveFile(a.file))}`);
  }, { destructiveHint: true });

  tool(server, "move_boards_to_page", "Move boards onto a page (a board is on one page at a time).", {
    file: S.file,
    boards: boardIds,
    page: pageId,
  }, async (a) => {
    await ensureServer();
    return api("POST", `/api/pages/move?file=${enc(await resolveFile(a.file))}`, { boards: a.boards, to: a.page });
  });

  tool(server, "set_active_page", "Show a page in the open canvas (its boards replace the others; each page keeps its own camera). select_nodes and fit_view switch pages on their own when a node lives on another page.", {
    page: pageId,
    client: S.client,
    file: S.file,
  }, async (a) => (await cmd({ op: "page", args: { page: a.page }, client: a.client, file: a.file })).result);
}
