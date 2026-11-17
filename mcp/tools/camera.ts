// The view: where the camera is and moving it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cmd } from "../client.ts";
import * as S from "../schemas.ts";
import { tool } from "../tool.ts";

const target = { client: S.client, file: S.file };

export function register(server: McpServer) {
  tool(server, "get_viewport", "Where the camera is: zoom, the part of the canvas in view (world coordinates, minus the area covered by panels), and which boards are in view with how much of each shows.", target, async (a) => ((await cmd({ op: "measure", args: {}, ...a })).result as any).viewport, { readOnlyHint: true });

  tool(server, "fit_view", "Zoom and pan so nodes fill the view. No ids = every board. Boards that are not drawn yet are loaded.", {
    ids: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
    padding: z.number().min(0).max(500).optional().describe("Space around, in screen pixels (default 70)"),
    maxZoomPercent: z.number().min(2).max(25600).optional().describe("Never zoom in past this (default 400)"),
    ...target,
  }, async (a) => (await cmd({ op: "fit", args: { ids: a.ids, padding: a.padding, maxZoomPercent: a.maxZoomPercent }, client: a.client, file: a.file })).result);

  tool(server, "set_zoom", "Set the zoom (2 to 25600 percent) around the middle of the view, the selection, or a point.", {
    percent: z.number().min(2).max(25600),
    anchor: z.union([z.enum(["center", "selection"]), z.object({ x: z.number(), y: z.number(), space: z.enum(["screen", "world"]).optional() })]).optional(),
    ...target,
  }, async (a) => (await cmd({ op: "zoom", args: { percent: a.percent, anchor: a.anchor }, client: a.client, file: a.file })).result);

  tool(server, "pan_view", "Move the camera. to centers a point, by shifts the view, nodeId centers a node. space is world (canvas units, default) or screen (pixels).", {
    to: z.object({ x: z.number(), y: z.number() }).optional(),
    by: z.object({ dx: z.number(), dy: z.number() }).optional(),
    nodeId: z.string().min(1).max(200).optional(),
    space: z.enum(["world", "screen"]).optional(),
    ...target,
  }, async (a) => (await cmd({ op: "pan", args: { to: a.to, by: a.by, nodeId: a.nodeId, space: a.space }, client: a.client, file: a.file })).result);
}
