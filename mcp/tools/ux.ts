// Telling the person something.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, cmd, ensureServer, status } from "../client.ts";
import * as S from "../schemas.ts";
import { tool } from "../tool.ts";

export function register(server: McpServer) {
  tool(server, "notify_user", "Show a short message in Canvas (a toast in the app, a banner in the browser page). For a question that needs a click, use wait_for_selection with a prompt instead.", {
    message: z.string().min(1).max(200),
    level: S.toastLevel.optional(),
    durationMs: z.number().int().min(500).max(30_000).optional().describe("Default 4000"),
  }, async (a) => {
    const s = await status();
    const args = { message: a.message, level: a.level ?? "info", durationMs: a.durationMs ?? 4000 };
    const out = await cmd({ op: s.shell ? "toast" : "toast_fallback", args, timeoutMs: 5000 });
    return { shown: true, via: s.shell ? "app" : "page", client: out.client };
  });

  tool(server, "finish_work", "Call this once when you finish a set of changes the person is watching in Canvas. It scrolls the view to what you changed if it is off screen, plays a soft gloss sweep over each changed node (or whole board when many nodes changed), shows a \"Done\" toast with your summary and plays a short sound, so they know you are done. It covers what you changed through set_node_props and the widget tools since your last finish_work; pass ids to point at other nodes. Do not call it after every small edit.", {
    summary: z.string().min(1).max(140).optional().describe("One short line of what changed, shown as \"Done: <summary>\""),
    ids: z.array(z.string().min(1).max(200)).min(1).max(40).optional().describe("Nodes to gloss instead of the tracked ones"),
    sound: z.boolean().optional().describe("Play the sound (default true)"),
    client: S.client,
    file: S.file,
  }, async (a) => {
    await ensureServer();
    const { ok: _ok, boot: _boot, ...rest } = await api<any>("POST", "/api/bridge/finish", { summary: a.summary, ids: a.ids, sound: a.sound, client: a.client, file: a.file });
    return rest;
  });
}
