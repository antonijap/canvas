// Copy as (the Copy/Paste as menu): Shift+Cmd+C puts a 2x PNG of the selection on the clipboard, and the
// right-click menu's Copy as adds SVG, CSS, SwiftUI and text. The pixels and the SVG come from the export path
// (src/export.ts runs src/export-run.ts with `inline`), the code from src/codegen.ts in the same child process.
// Several layers make one picture: each is drawn on its own and placed where it sits on the canvas, so whatever lies
// between them and is not selected stays out; CSS and SwiftUI list one block per layer.
//
// POST /api/copy-as {file, ids, format: "png"|"svg"|"css"|"swiftui"|"text", scale?} (x-canvas: 1) ->
// {format, mime, data? (base64, PNG), text? (the rest), width?, height?, count}. The shell puts it on the pasteboard
// (apps/macos Library.swift copyAs), the page on the browser's clipboard (src/page/copy-as.js).

import type http from "node:http";
import type { CodeAnswer } from "./codegen.ts";
import { decodePng, encodePng, ExportError, MAX_SIDE, runExport, type ExportDeps, type ExportedFile, type ExportRequest, type Pixels } from "./export.ts";

export type CopyFormat = "png" | "svg" | "css" | "swiftui" | "text";
export const COPY_FORMATS: CopyFormat[] = ["png", "svg", "css", "swiftui", "text"];
export type CopyAnswer = { format: CopyFormat; mime: string; data?: string; text?: string; width?: number; height?: number; count: number };

/** Lay `src` over `dst` at (dx, dy), source-over, both RGBA (straight alpha). */
export function over(dst: Pixels, src: Pixels, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * src.channels, t = (ty * dst.width + tx) * 4;
      const sa = (src.channels === 4 ? src.data[s + 3] : 255) / 255;
      if (sa <= 0) continue;
      const da = dst.data[t + 3] / 255, oa = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) dst.data[t + k] = Math.round((src.data[s + k] * sa + dst.data[t + k] * da * (1 - sa)) / oa);
      dst.data[t + 3] = Math.round(oa * 255);
    }
  }
}

type Placed = { width: number; height: number; x: number; y: number };

/** Where each drawing lands on one picture: the union of their canvas boxes at `scale`. */
export function layoutPicture(files: Placed[], scale: number): { width: number; height: number; at: { dx: number; dy: number }[] } {
  const x0 = Math.min(...files.map((f) => f.x)), y0 = Math.min(...files.map((f) => f.y));
  const x1 = Math.max(...files.map((f) => f.x + f.width / scale)), y1 = Math.max(...files.map((f) => f.y + f.height / scale));
  return {
    width: Math.max(1, Math.ceil((x1 - x0) * scale - 1e-6)),
    height: Math.max(1, Math.ceil((y1 - y0) * scale - 1e-6)),
    at: files.map((f) => ({ dx: Math.round((f.x - x0) * scale), dy: Math.round((f.y - y0) * scale) })),
  };
}

/** One PNG of several drawings placed as on the canvas. */
export function composePng(files: (Placed & { data: string })[], scale: number): { png: Buffer; width: number; height: number } {
  if (files.length === 1) return { png: Buffer.from(files[0].data, "base64"), width: files[0].width, height: files[0].height };
  const plan = layoutPicture(files, scale);
  if (Math.max(plan.width, plan.height) > MAX_SIDE) throw new ExportError(422, "too_large", `The selection would be ${plan.width}x${plan.height} px; the most is ${MAX_SIDE} px a side. Copy fewer layers, or layers closer together.`);
  const dst: Pixels = { width: plan.width, height: plan.height, channels: 4, data: new Uint8Array(plan.width * plan.height * 4) };
  files.forEach((f, i) => over(dst, decodePng(Buffer.from(f.data, "base64")), plan.at[i].dx, plan.at[i].dy));
  return { png: encodePng(dst), width: plan.width, height: plan.height };
}

/** One SVG of several: each drawing nested at its canvas offset. */
export function composeSvg(files: (Placed & { data: string })[]): { svg: string; width: number; height: number } {
  const svgs = files.map((f) => Buffer.from(f.data, "base64").toString("utf8").replace(/^<\?xml[^>]*>\s*/, ""));
  if (files.length === 1) return { svg: svgs[0], width: files[0].width, height: files[0].height };
  const plan = layoutPicture(files, 1);
  const inner = svgs.map((s, i) => s.replace(/^<svg\b/, `<svg x="${plan.at[i].dx}" y="${plan.at[i].dy}"`)).join("");
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${plan.width}" height="${plan.height}" viewBox="0 0 ${plan.width} ${plan.height}" fill="none">${inner}</svg>`, width: plan.width, height: plan.height };
}

export function validateCopy(b: Record<string, unknown>): { file: string; ids: string[]; format: CopyFormat; scale: number } {
  const bad = (m: string) => new ExportError(422, "invalid", m);
  if (typeof b.file !== "string" || !b.file) throw bad("file is required");
  if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 200 || b.ids.some((x) => typeof x !== "string" || !x)) throw bad("ids must be 1 to 200 node ids");
  const ids = (b.ids as string[]).filter((x) => !x.startsWith("widget:"));
  if (!ids.length) throw bad("Cards cannot be copied as an image or code; select layers or boards");
  const format = (b.format ?? "png") as CopyFormat;
  if (!COPY_FORMATS.includes(format)) throw bad(`format must be one of ${COPY_FORMATS.join(", ")}`);
  const scale = b.scale === undefined ? 2 : Number(b.scale);
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 4) throw bad("scale must be a number from 0.1 to 4");
  return { file: b.file, ids, format, scale };
}

export async function copyAs(port: number, docFile: string, c: ReturnType<typeof validateCopy>): Promise<CopyAnswer> {
  const count = c.ids.length;
  if (c.format === "png" || c.format === "svg") {
    const req: ExportRequest = { file: c.file, ids: c.ids, format: c.format, inline: true, items: c.ids.map((id) => ({ id, format: c.format as "png" | "svg", ...(c.format === "png" ? { scale: c.scale } : {}) })) };
    const r = await runExport(port, docFile, req);
    const files = r.files as (ExportedFile & { data: string; x: number; y: number })[];
    if (c.format === "png") {
      const p = composePng(files, c.scale);
      return { format: "png", mime: "image/png", data: p.png.toString("base64"), width: p.width, height: p.height, count };
    }
    const s = composeSvg(files);
    return { format: "svg", mime: "image/svg+xml", text: s.svg, width: s.width, height: s.height, count };
  }
  const r = (await runExport(port, docFile, { file: c.file, ids: c.ids, format: "png", items: c.ids.map((id) => ({ id, format: "png" })), code: c.format } as ExportRequest)) as unknown as { code: CodeAnswer[] };
  const text = r.code.map((x) => x.text).filter((t) => t !== "").join(c.format === "text" ? "\n" : "\n\n");
  return { format: c.format, mime: "text/plain", text, count };
}

export async function handleCopyAsRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ExportDeps): Promise<boolean> {
  if (url.pathname !== "/api/copy-as") return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const ch of req) {
      chunks.push(Buffer.from(ch));
      size += ch.length;
      if (size > 200_000) return reply(413, { error: "too large", code: "invalid" }), true;
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(raw || "{}");
    } catch {
      return reply(400, { error: "The request body must be JSON", code: "invalid" }), true;
    }
    const c = validateCopy(b);
    await deps.prime(c.file);
    return reply(200, await copyAs(deps.port(), deps.docFileOf(c.file), c)), true;
  } catch (e) {
    if (e instanceof ExportError) return reply(e.status, { error: e.message, code: e.code }), true;
    return reply(422, { error: (e as Error).message, code: "failed" }), true;
  }
}
