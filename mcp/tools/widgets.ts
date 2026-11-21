// Widgets on the canvas: todo lists, notes and live numbers. Calls the server's widget routes.
// Trust, visibility and secret status are the app's business and are not exposed here.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, cmd, ensureServer, resolveFile, ToolError } from "../client.ts";
import * as S from "../schemas.ts";
import { renderedFor } from "./document.ts";
import { pageOfNode } from "./pageof.ts";
import { tool } from "../tool.ts";

// What a note's text can hold (src/page/note-doc.js reads and writes it).
export const NOTE_MARKDOWN_HELP = "Markdown, one line per block: # Heading (large), ## Heading (medium), ### Heading (small; #### and deeper show as bold text), - bullet, 1. numbered, - [ ] checkbox, > quote, --- divider, 4 spaces to nest a list item; **bold**, *italic*, ~~strike~~, `code`, [link](https://...). Write blocks on consecutive lines: an empty line shows as an empty line.";

const enc = encodeURIComponent;
const geometry = {
  x: z.number().optional(), y: z.number().optional(),
  w: z.number().min(40).max(4000).optional(), h: z.number().min(40).max(4000).optional(),
};
const wpath = async (file: string | undefined, id?: string, tail = "") => `/api/widgets${id ? `/${enc(id)}` : ""}${tail}?file=${enc(await resolveFile(file))}`;

export function register(server: McpServer) {
  tool(server, "list_widgets", "Widgets in a file with their latest readings (value, state, last update). Works with Canvas closed.", { file: S.file }, async (a) => {
    await ensureServer();
    return api("GET", await wpath(a.file));
  }, { readOnlyHint: true });

  tool(server, "list_widget_kinds", "Widget kinds with their config fields, defaults, default size and actions. Personal kinds are marked local.", {}, async () => {
    await ensureServer();
    return api("GET", "/api/widgets/kinds");
  }, { readOnlyHint: true });

  tool(server, "add_widget", `Add a widget. Omit x/y to place it to the right of the boards or pass nearNodeId to place it by a node. Config overrides the defaults from list_widget_kinds. For a Page widget (kind note), write config.text as ${NOTE_MARKDOWN_HELP}`, {
    file: S.file,
    kind: z.string().describe("Widget kind ID from list_widget_kinds, such as note or metric"),
    name: z.string().max(100).optional(),
    ...geometry,
    config: z.record(z.string(), z.any()).optional(),
    nearNodeId: z.string().optional().describe("Place it 40 units right of this node (on that node's page)"),
    page: z.string().optional().describe("Page id (list_pages). Default: nearNodeId's page, else the first page"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    let { x, y } = a;
    if (a.nearNodeId && x === undefined && y === undefined) {
      const sum = await api<any>("GET", `/api/summary?file=${enc(file)}`);
      const board = sum.boards.find((b: any) => b.id === a.nearNodeId);
      if (board) ({ x, y } = { x: board.x + (board.width ?? 400) + 40, y: board.y });
      else {
        const box = (await renderedFor([a.nearNodeId], file)).boxes[a.nearNodeId] as any;
        if (!box?.world) throw new ToolError("not_found", `Cannot place next to "${a.nearNodeId}": it is not a board and no open page shows it`, "Pass x and y, or open the file in Canvas.");
        ({ x, y } = { x: box.world.x + box.world.w + 40, y: box.world.y });
      }
    }
    const page = a.page ?? (a.nearNodeId ? await pageOfNode(file, a.nearNodeId) : undefined);
    return api("POST", `/api/widgets?file=${enc(file)}`, { kind: a.kind, name: a.name, x, y, w: a.w, h: a.h, config: a.config, page });
  });

  tool(server, "update_widget", `Change a widget. patch may hold name, x, y, w, h, locked, page and config. config merges deeply: objects merge, arrays and scalars replace, null deletes a key. A locked widget refuses moves and resizes. A note's config.text is ${NOTE_MARKDOWN_HELP}`, {
    file: S.file,
    id: z.string(),
    patch: z.object({ name: z.string().max(100).optional(), ...geometry, locked: z.boolean().optional(), config: z.record(z.string(), z.any()).optional(), page: z.string().nullable().optional().describe("Move it to this page id; null: the first page") }),
  }, async (a) => {
    await ensureServer();
    return api("PATCH", await wpath(a.file, a.id), a.patch);
  });

  tool(server, "remove_widget", "Delete a widget from the canvas. Locked widgets can be deleted too.", { file: S.file, id: z.string() }, async (a) => {
    await ensureServer();
    return api("DELETE", await wpath(a.file, a.id));
  });

  tool(server, "widget_action", "Run a widget's action. Todo lists: addItem {text, index?}, toggleItem {id, done?}, updateItem {id, text}, removeItem {id}, moveItem {id, index}. list_widget_kinds shows each kind's actions.", {
    file: S.file,
    id: z.string(),
    action: z.string(),
    args: z.record(z.string(), z.any()).optional(),
  }, async (a) => {
    await ensureServer();
    return api("POST", await wpath(a.file, a.id, `/actions/${enc(a.action)}`), a.args ?? {});
  });

  tool(server, "refresh_widget", "Fetch a live widget's value now (at most once per 5 seconds per widget).", { file: S.file, id: z.string() }, async (a) => {
    await ensureServer();
    return api("POST", await wpath(a.file, a.id, "/refresh"), {}, { timeoutMs: 30_000 });
  });

  tool(server, "reveal_widget", "Bring a widget into view and select it in Canvas.", {
    file: S.file,
    id: z.string(),
    select: z.boolean().optional().describe("Also select it (default true)"),
    client: S.client,
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    await api("GET", `/api/widgets/${enc(a.id)}?file=${enc(file)}`);
    const wid = `widget:${a.id}`;
    const view = (await cmd({ op: "fit", args: { ids: [wid], padding: 160, maxZoomPercent: 100 }, client: a.client, file })).result;
    if (a.select !== false) await cmd({ op: "select", args: { ids: [wid], reveal: false }, client: a.client, file });
    return { revealed: a.id, view };
  });
}
