// Shader cards: WGSL fragment shaders the GPU engine plays on free-standing cards. The source is a file in
// the package (shaders/<id>.wgsl); create and update return the compiler's errors and a rendered frame
// from the open page, so an agent can fix a shader in the same turn.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, cmd, ensureServer, resolveFile, ToolError } from "../client.ts";
import * as S from "../schemas.ts";
import { Raw, tool } from "../tool.ts";

const enc = encodeURIComponent;

const CONTRACT = [
  "Write WGSL that defines fn shade(p: vec2<f32>) -> vec4<f32>. p is the pixel in card px, (0,0) top-left, u.resolution bottom-right.",
  "Uniforms: u.resolution (vec2, card px), u.time (s), u.delta (s), u.frame, u.mouse (x, y in card px; z = 1 while hovered; w = 1 while pressed), u.params (array<vec4<f32>, 4>).",
  "Return premultiplied RGBA (rgb already multiplied by alpha). Not allowed: entry points (@vertex/@fragment/@compute), @group/@binding, storage or workgroup memory, atomics, textures, samplers, enable. Loops need a fixed bound. 64 KB max.",
  "Example: fn shade(p: vec2<f32>) -> vec4<f32> { let uv = p / u.resolution; return vec4<f32>(uv, 0.5 + 0.5 * sin(u.time), 1.0); }",
  "Cards play at 30 fps (60 hovered), at most 4 at once, within a 4 ms GPU budget per frame; a heavier shader shows a still frame (t = 2 s) until hovered.",
].join(" ");

const geometry = {
  x: z.number().optional(), y: z.number().optional(),
  w: z.number().min(40).max(4000).optional(), h: z.number().min(40).max(4000).optional(),
};

/** Ask the open page for one frame of the revision just written: compile errors, or a PNG and its measured cost. */
async function frame(file: string, id: string, rev: string, t: number | undefined, problems: unknown[] | undefined, extra: Record<string, unknown>) {
  let r: any;
  try {
    r = (await cmd({ op: "shader_frame", args: { id, rev, t: t ?? 2 }, file, timeoutMs: 15_000 })).result;
  } catch (e) {
    if ((e as ToolError).code === "no_page") return { ...extra, compiled: false, note: "No open Canvas page shows this file, so the shader was not compiled; only the static checks ran (problems).", problems };
    throw e;
  }
  if (!r.ok || !r.image) return { ...extra, compiled: (r.errors?.length ?? 0) > 0, ok: false, errors: r.errors ?? [], ...(r.quarantined ? { quarantined: true } : {}), ...(r.note ? { note: r.note } : {}) };
  const { image, ...meta } = r;
  return new Raw([{ type: "image", data: image, mimeType: "image/png" }, { type: "text", text: JSON.stringify({ ...extra, compiled: true, ...meta }) }]);
}

const PAPER = "Or start from the Paper Shaders library (web effects: mesh gradient, grain gradient, metaballs, warp, god rays, dithering, ...): pass preset (a shader id from list_shader_presets, optionally with a variant: \"mesh-gradient/Ink\") and params (Paper's own names and ranges: colors as #hex strings, speed, frame, scale, rotation, ...); no source needed.";

const paperParams = z.record(z.string(), z.unknown()).optional().describe("Paper preset params by name (list_shader_presets shows each shader's params, ranges and defaults); merged over the preset");

export function register(server: McpServer) {
  tool(server, "list_shader_presets", "The Paper Shaders library (github.com/paper-design/shaders, Apache-2.0) as shader card presets: each shader's id, name, description, params (type, range, options, default) and its presets (variants). Pass id for one shader with every preset's full params. Works with Canvas closed.", {
    id: z.string().max(60).optional().describe("A shader id for its presets' full params"),
  }, async (a) => {
    await ensureServer();
    return api("GET", a.id ? `/api/shaders/presets/${enc(a.id)}` : "/api/shaders/presets");
  }, { readOnlyHint: true });

  tool(server, "export_shader", "A Paper preset card as code for a web page: format react (a @paper-design/shaders-react component with the card's params) or html (vanilla ShaderMount). Same effect, same params.", {
    file: S.file,
    id: z.string().min(1).max(40),
    format: z.enum(["react", "html"]).optional().describe("react (default) or html"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    return api("GET", `/api/shaders/${enc(a.id)}/export?file=${enc(file)}&format=${a.format ?? "react"}`);
  }, { readOnlyHint: true });

  tool(server, "list_shaders", "Shader cards in a file: id, name, rect, revision, whether it autoplays or is quarantined (stopped after a GPU reset), source size, whether a poster exists and static problems. Works with Canvas closed.", { file: S.file }, async (a) => {
    await ensureServer();
    return api("GET", `/api/shaders?file=${enc(await resolveFile(a.file))}`);
  }, { readOnlyHint: true });

  tool(server, "create_shader", `Add a shader card. ${CONTRACT} ${PAPER} Returns the compile errors (line, col, message) or a rendered PNG frame at t (default 2 s) with its measured GPU cost. Without x/y it goes to the right of the boards.`, {
    file: S.file,
    source: z.string().min(1).max(64 * 1024).optional().describe("WGSL defining fn shade(p: vec2<f32>) -> vec4<f32> (or use preset)"),
    preset: z.string().max(80).optional().describe("A Paper shader id, or id/variant (\"grain-gradient/Wave\"), instead of source"),
    variant: z.string().max(60).optional().describe("One of the shader's presets (default: Default)"),
    params: paperParams,
    name: z.string().max(100).optional(),
    ...geometry,
    autoplay: z.boolean().optional().describe("Play on its own (default true); off: a still frame that plays on hover"),
    t: z.number().min(0).max(3600).optional().describe("Time of the returned frame in seconds (default 2)"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    if (!a.source && !a.preset) throw new ToolError("bad_args", "Pass source (WGSL) or preset (a Paper shader id from list_shader_presets)");
    const r = await api<any>("POST", `/api/shaders?file=${enc(file)}`, { source: a.source, preset: a.preset, variant: a.variant, params: a.params, name: a.name, x: a.x, y: a.y, w: a.w, h: a.h, autoplay: a.autoplay });
    return frame(file, r.widget.id, r.rev, a.t, r.problems, { id: r.widget.id, rev: r.rev, widget: r.widget });
  });

  tool(server, "update_shader", `Change a shader card: its source, name, rect, autoplay, or clear its quarantine (quarantined: false runs it again). A Paper preset card takes params (merged over its current ones, no recompile), variant (another preset of the same shader) or preset (another shader); a new source turns it into plain WGSL. ${CONTRACT} Returns the compile errors or a rendered PNG frame with its measured GPU cost.`, {
    file: S.file,
    id: z.string().min(1).max(40),
    source: z.string().min(1).max(64 * 1024).optional(),
    preset: z.string().max(80).optional().describe("Switch to this Paper shader (id or id/variant)"),
    variant: z.string().max(60).optional().describe("Switch to this preset of the card's Paper shader"),
    params: paperParams,
    name: z.string().max(100).optional(),
    ...geometry,
    autoplay: z.boolean().optional(),
    quarantined: z.literal(false).optional().describe("false: run a quarantined shader again"),
    t: z.number().min(0).max(3600).optional().describe("Time of the returned frame in seconds (default 2)"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    const { file: _f, id, t, ...patch } = a;
    const r = await api<any>("PUT", `/api/shaders/${enc(id)}?file=${enc(file)}`, patch);
    return frame(file, id, r.rev, t, r.problems, { id, rev: r.rev, widget: r.widget });
  });
}
