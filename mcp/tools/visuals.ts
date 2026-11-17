// Pictures: the live window, a headless render of any node, and exports to PNG or SVG files.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, cmd, ensureServer, resolveFile, ToolError } from "../client.ts";
import { renderNode } from "../render.ts";
import * as S from "../schemas.ts";
import { Raw, tool } from "../tool.ts";

export function register(server: McpServer) {
  tool(server, "screenshot_view", "A picture of what Canvas.app shows right now, selection outline included. Needs the app (use render_node for a headless picture of one node). windowVisible:false means the window is hidden and the picture may be stale.", {
    maxSide: z.number().int().min(100).max(4000).optional().describe("Longest edge in pixels (default 1600)"),
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().min(0).max(1).optional().describe("jpeg quality 0..1"),
  }, async (a) => {
    let r: any;
    try {
      r = (await cmd({ op: "snapshot", args: a, timeoutMs: 15_000 })).result;
    } catch (e) {
      if ((e as ToolError).code === "no_shell") throw new ToolError("unsupported", "screenshot_view needs Canvas.app", "Start it with launch_canvas {mode:'app'}, or use render_node for a headless render of one node.");
      throw e;
    }
    const { data, mime, ...meta } = r;
    return new Raw([{ type: "image", data, mimeType: mime ?? "image/png" }, { type: "text", text: JSON.stringify(meta) }]);
  }, { readOnlyHint: true });

  tool(server, "render_node", "Render one node (or a board) to an image with the engine's headless renderer. Works with Canvas closed; needs Google Chrome or another Chromium. Fonts and layout follow the Canvas file, so check important visuals in Canvas too.", {
    file: S.file,
    id: z.string().optional().describe("Node id or instance path; default: the first board"),
    scale: z.number().min(0.1).max(4).optional(),
    maxSide: z.number().int().min(100).max(4000).optional().describe("Longest edge in pixels (default 1600)"),
    format: z.enum(["png", "jpeg", "webp"]).optional(),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    // Edits Canvas made are written in the background: render what Canvas shows, once it is on disk.
    const settle = async () => (await api<{ fileRevision?: string | null }>("POST", "/api/flush", { file }, { timeoutMs: 30_000 })).fileRevision;
    const r = await renderNode({ file, id: a.id, scale: a.scale, maxSide: a.maxSide, format: a.format, settle });
    return new Raw([{ type: "image", data: r.image.toString("base64"), mimeType: r.mime }, { type: "text", text: JSON.stringify({ file, id: r.id, bytes: r.image.length, warnings: r.warnings.slice(0, 10) }) }]);
  }, { readOnlyHint: true });

  tool(server, "export_nodes", "Export boards or layers to files, as the right-click Export menu does. format png, jpg (over white) or webp (scale 1-4, default 1), svg (vector: text stays text, image fills embedded) or pdf (vector, one page the layer's size). preset makes a store screenshot PNG at that exact size with no alpha channel: app-store-6.5 (1242x2688), app-store-6.9 (1290x2796), play (1080x1920); a board of another shape is fitted on white. path: the file to write (one id), or a folder (files named after the layers, e.g. \"Home@2x.png\"). Works with Canvas closed; needs Google Chrome or another Chromium. Answers the files written with their sizes.", {
    file: S.file,
    ids: z.array(z.string().min(1)).min(1).max(500).describe("Board or layer ids (lookup_nodes, get_selection)"),
    format: z.enum(["png", "jpg", "webp", "svg", "pdf"]).optional().describe("Default png. jpg is drawn over white; svg and pdf are vector at 1x"),
    scale: z.number().min(0.1).max(4).optional().describe("Raster scale (png, jpg, webp), e.g. 1, 2, 3"),
    preset: z.enum(["app-store-6.5", "app-store-6.9", "play"]).optional(),
    path: z.string().min(1).describe("Absolute path: a file for one id (.png, .jpg, .webp, .svg, .pdf), or a folder"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    const want = path.resolve(a.path.replace(/^~(?=$|\/)/, os.homedir()));
    const isDir = a.ids.length > 1 || a.path.endsWith("/") || (fs.existsSync(want) && fs.statSync(want).isDirectory());
    if (isDir) fs.mkdirSync(want, { recursive: true });
    return api("POST", "/api/export", { file, ids: a.ids, format: a.format ?? "png", scale: a.scale, preset: a.preset, ...(isDir ? { dir: want } : { path: want }) }, { timeoutMs: 180_000 });
  });
}
