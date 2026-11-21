// Video cards: a local video file played on the canvas by the GPU engine, with the shader cards' live-media
// budget. add_video copies the file into the package (or links it) and can place the card exactly over a
// node (an image placeholder), linked so it moves with the board. video_frame returns a PNG at time t.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, background, cmd, ensureServer, resolveFile, ToolError } from "../client.ts";
import { mediaFrame } from "../media.ts";
import * as S from "../schemas.ts";
import { Raw, tool } from "../tool.ts";
import { pageOfNode } from "./pageof.ts";

const enc = encodeURIComponent;

/** A node's world rect from the open page (loading its board first). */
async function nodeRect(file: string, id: string): Promise<{ x: number; y: number; w: number; h: number }> {
  // A board: its rect is on disk, no page needed.
  const sum = await api<any>("GET", `/api/summary?file=${enc(file)}`);
  const board = sum.boards?.find((b: any) => b.id === id);
  if (board && board.width && board.height) return { x: board.x, y: board.y, w: board.width, h: board.height };
  try {
    await cmd({ op: "highlight", args: { ids: [id], style: "outline", durationMs: 1500, reveal: true }, file, timeoutMs: 8000 });
    const r: any = (await cmd({ op: "measure", args: { ids: [id] }, file })).result;
    const n = r?.nodes?.[0];
    if (n?.drawn && n.world) return { x: n.world.x, y: n.world.y, w: n.world.w, h: n.world.h };
  } catch (e) {
    if ((e as ToolError).code === "no_page") throw new ToolError("no_page", "Placing a card over a node needs an open Canvas page to measure it.", "Open the file (open_file), or pass x, y, w, h.");
    throw e;
  }
  throw new ToolError("not_found", `Node "${id}" is not drawn on the canvas.`, "Check the id (lookup_nodes), or pass x, y, w, h.");
}

export function register(server: McpServer) {
  tool(server, "list_videos", "Video cards in a file: id, name, rect, src (relative to the package, or an absolute linked file), whether the file exists, content hash, autoplay, loop, muted, poster time and the node it is linked to. Works with Canvas closed.", { file: S.file }, async (a) => {
    await ensureServer();
    return api("GET", `/api/videos?file=${enc(await resolveFile(a.file))}`);
  }, { readOnlyHint: true });

  tool(server, "add_video", "Add a video card from a local .mp4/.m4v/.mov/.webm file. The file is copied into the package (media/) unless copy is false. Place it with x, y, w, h, or with nearNodeId: over that node, exactly its rect and linked so it moves with the board (cover: true, default), or beside it (cover: false). Cards autoplay muted and looped while on screen, within the shared budget (at most 4 shader and video cards play at once); hover plays from the start; selected cards show controls. Returns the widget and a frame at the poster time when a page is open.", {
    file: S.file,
    path: z.string().min(1).max(4096).describe("Absolute path of the video file (~/ allowed)"),
    nearNodeId: z.string().min(1).max(200).optional().describe("Place over (or beside) this node, e.g. an image placeholder"),
    cover: z.boolean().optional().describe("With nearNodeId: true (default) covers the node and links to it; false puts the card to its right"),
    x: z.number().optional(), y: z.number().optional(),
    w: z.number().min(16).max(8000).optional(), h: z.number().min(16).max(8000).optional(),
    name: z.string().max(100).optional(),
    copy: z.boolean().optional().describe("Copy into the package (default true); false links the file where it is"),
    autoplay: z.boolean().optional(), loop: z.boolean().optional(), muted: z.boolean().optional(),
    posterTime: z.number().min(0).max(86_400).optional().describe("Seconds: the still frame shown before it plays (default 1)"),
    page: z.string().optional().describe("Page id (list_pages). Default: nearNodeId's page, else the first page"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    let place: Record<string, unknown> = { x: a.x, y: a.y, w: a.w, h: a.h };
    if (a.nearNodeId) {
      const r = await nodeRect(file, a.nearNodeId);
      place = a.cover === false ? { x: r.x + r.w + 40, y: r.y, w: a.w ?? r.w, h: a.h ?? r.h } : { ...r, link: a.nearNodeId };
    }
    const page = a.page ?? (a.nearNodeId ? await pageOfNode(file, a.nearNodeId) : undefined);
    const made = await api<any>("POST", `/api/videos?file=${enc(file)}`, { path: a.path, copy: a.copy, name: a.name, autoplay: a.autoplay, loop: a.loop, muted: a.muted, posterTime: a.posterTime, page, ...place });
    const id = made.widget.id;
    try {
      const r: any = background() ? await mediaFrame(file, "videoFrame", { id, t: a.posterTime ?? 1 })
        : (await cmd({ op: "video_frame", args: { id, t: a.posterTime ?? 1 }, file, timeoutMs: 20_000 })).result;
      if (r?.ok && r.image) {
        const { image, ...meta } = r;
        return new Raw([{ type: "image", data: image, mimeType: "image/png" }, { type: "text", text: JSON.stringify({ id, widget: made.widget, frame: meta }) }]);
      }
    } catch (e) {
      if ((e as ToolError).code !== "no_page") return { id, widget: made.widget, frameError: (e as Error).message };
    }
    return { id, widget: made.widget };
  });

  tool(server, "video_frame", "A PNG of a video card's file at time t seconds (default 1), decoded by the open page, with the video's duration and size.", {
    file: S.file,
    id: z.string().min(1).max(40),
    t: z.number().min(0).max(86_400).optional(),
    maxSide: z.number().int().min(32).max(2048).optional().describe("Longest side of the PNG in px (default 768)"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    const r: any = background() ? await mediaFrame(file, "videoFrame", { id: a.id, t: a.t ?? 1, maxSide: a.maxSide ?? 768 })
      : (await cmd({ op: "video_frame", args: { id: a.id, t: a.t ?? 1, maxSide: a.maxSide ?? 768 }, file, timeoutMs: 20_000 })).result;
    if (!r?.ok || !r.image) return { ok: false, ...(r ?? {}) };
    const { image, ...meta } = r;
    return new Raw([{ type: "image", data: image, mimeType: "image/png" }, { type: "text", text: JSON.stringify(meta) }]);
  }, { readOnlyHint: true });
}
