// resolve_link: what a canvas:// link (Cmd+L in Canvas) names, by name and type. Works with Canvas closed.

import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ensureServer, status, ToolError } from "../client.ts";
import { parseLink } from "../link.ts";
import { tool } from "../tool.ts";

const enc = encodeURIComponent;

export function register(server: McpServer) {
  tool(server, "resolve_link", "What a canvas:// link (Cmd+L in Canvas) names: the file, its page, and each node's name, type, board and page. Any node tool also takes the link itself as link.", {
    link: z.string().min(1).max(20_000).describe("The canvas:// link"),
  }, async (a) => {
    const l = parseLink(a.link);
    if (!l) throw new ToolError("invalid", "That is not a Canvas link", "A link looks like canvas://open?file=/path/App.canvas&node=Id1,Id2 (Cmd+L in Canvas).");
    if (!fs.existsSync(l.file)) throw new ToolError("not_found", `No file at ${l.file}`, "It was moved or renamed; ask for a new link.");
    await ensureServer();
    const f = enc(l.file);
    const pages = await api<any>("GET", `/api/pages?file=${f}`).catch(() => null);
    const list: { id: string; name: string; boards: string[]; default?: boolean }[] = Array.isArray(pages?.pages) ? pages.pages : [];
    const pageOfBoard = (b: string | null) => {
      const p = (b && list.find((x) => Array.isArray(x.boards) && x.boards.includes(b))) || list.find((x) => x.default) || list[0];
      return p ? { id: p.id, name: p.name } : null;
    };
    const widgets = l.nodes.some((n) => n.startsWith("widget:")) ? ((await api<any>("GET", `/api/widgets?file=${f}`).catch(() => null))?.widgets ?? []) : [];
    const nodes: any[] = [], missing: string[] = [];
    for (const id of l.nodes) {
      if (id.startsWith("widget:")) {
        const w = widgets.find((x: any) => x.id === id.slice(7));
        if (!w) { missing.push(id); continue; }
        const p = list.find((x) => x.id === w.page) ?? list.find((x) => x.default) ?? list[0];
        nodes.push({ id, card: w.id, kind: w.kind, name: w.name ?? w.kind, page: p ? { id: p.id, name: p.name } : null });
        continue;
      }
      const r = await api<any>("GET", `/api/find?file=${f}&id=${enc(id)}`).catch(() => null);
      const hit = r?.results?.find((x: any) => x.id === id);
      if (!hit) { missing.push(id); continue; }
      nodes.push({ id, name: hit.name ?? null, type: hit.type, board: hit.board, path: hit.path || undefined, page: pageOfBoard(hit.board) });
    }
    const page = l.page ? list.find((x) => x.id === l.page) : null;
    const s = await status().catch(() => null);
    const open = !!s?.pages.some((p) => p.file === l.file);
    return {
      file: l.file,
      page: page ? { id: page.id, name: page.name } : l.page ? { id: l.page, missing: true } : null,
      nodes,
      ...(missing.length ? { missing } : {}),
      open,
      ...(l.nodes.length ? {} : { note: "The link names the page, not nodes." }),
    };
  }, { readOnlyHint: true });
}
