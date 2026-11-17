// Export: boards and layers to PNG, JPG, WebP, SVG or PDF files, from the right-click menu (Export as PNG / SVG / ...),
// Shift+Cmd+E (each layer's saved export settings, src/page/exports.js) and the MCP's export_nodes. Pixels come from the headless renderer render_node uses (src/doc/render: Chrome lays out the
// renderer's HTML), so an export looks like a render_node picture of the same node. PNG at 1x, 2x, 3x (any scale from
// the MCP), or at a store preset: App Store 6.5" (1242x2688), App Store 6.9" (1290x2796), Google Play (1080x1920),
// those exact sizes and with no alpha channel (App Store Connect refuses screenshots with one). SVG is vector
// (src/doc/render/svg.ts); its image fills are embedded as data: URLs.
// The renderer blocks its thread while Chrome works, so the server runs exports in a child process
// (src/export-run.ts), like the agent's selection picture (src/agent-render.ts).
//
// JPG is drawn over white (no alpha), WebP keeps alpha; PDF is the SVG drawing printed by Chrome (vector, one page the
// layer's size). Export settings: a scale, a format and a suffix per setting; the suffix goes on the name
// as typed ("Home" + "-dark" -> "Home-dark.png"), and with no suffix a scale other than 1x is named "@2x".
//
// POST /api/export {file, ids, format, scale?, preset?, path?, dir?} or {file, items: [{id, format, scale?, preset?,
// suffix?}], dir} -> {files: [{id, name, path, width, height, bytes}], warnings}. `path`: the file to write (one
// layer). `dir`: a folder, files named after the layers ("Home@2x.png"). Writes need x-canvas: 1.
// POST /api/copy-as {file, ids, format: "png"|"svg"|"css"|"swiftui"|"text", scale?} -> what Copy as puts on the
// clipboard (src/copy-as.ts): {mime, data (base64) | text, width?, height?}. Nothing is written to disk.

import { spawn } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { countUsage } from "./usage-counts.ts";

export type ExportFormat = "png" | "svg" | "jpg" | "webp" | "pdf";
export const FORMATS: ExportFormat[] = ["png", "jpg", "webp", "svg", "pdf"];
const isFormat = (v: unknown): v is ExportFormat => typeof v === "string" && (FORMATS as string[]).includes(v);
/** Vector formats: one size, so a scale does not apply (SVG and PDF export at 1x only). */
export const isVector = (f: ExportFormat) => f === "svg" || f === "pdf";
/** What Chrome is asked to draw for a format. */
export const shotFormat = (f: ExportFormat): "png" | "svg" | "jpeg" | "webp" => (f === "jpg" ? "jpeg" : isVector(f) ? "svg" : f);
export type PresetId = "app-store-6.5" | "app-store-6.9" | "play";
export const EXPORT_PRESETS: Record<PresetId, { label: string; width: number; height: number }> = {
  "app-store-6.5": { label: "App Store 6.5\"", width: 1242, height: 2688 },
  "app-store-6.9": { label: "App Store 6.9\"", width: 1290, height: 2796 },
  play: { label: "Google Play", width: 1080, height: 1920 },
};
export const isPreset = (v: unknown): v is PresetId => typeof v === "string" && Object.hasOwn(EXPORT_PRESETS, v);
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;
/** Chrome refuses to capture past this many pixels on a side. */
export const MAX_SIDE = 16384;

export class ExportError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * How a node of `box` (CSS px) becomes the PNG asked for. A scale: round(w*s) x round(h*s), alpha kept. A preset: that
 * exact size, opaque on white. A node of the preset's shape (within 0.5%) fills it, a sliver cropped at most;
 * any other shape is fitted inside and centred on white (dx, dy: where the drawing's top-left lands).
 */
export function exportPlan(box: { width: number; height: number }, o: { scale?: number; preset?: PresetId }): { scale: number; drawn: { width: number; height: number }; width: number; height: number; dx: number; dy: number; opaque: boolean } {
  const w = Math.max(box.width, 1e-6), h = Math.max(box.height, 1e-6);
  if (o.preset) {
    const p = EXPORT_PRESETS[o.preset];
    const sx = p.width / w, sy = p.height / h;
    const near = Math.abs(sx / sy - 1) <= 0.005;
    const scale = near ? Math.max(sx, sy) : Math.min(sx, sy);
    const drawn = { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
    return { scale, drawn, width: p.width, height: p.height, dx: Math.floor((p.width - drawn.width) / 2), dy: Math.floor((p.height - drawn.height) / 2), opaque: true };
  }
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, o.scale ?? 1));
  const drawn = { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  return { scale, drawn, width: drawn.width, height: drawn.height, dx: 0, dy: 0, opaque: false };
}

/** A layer name made safe for a file name: no slashes, colons or control characters, not empty, not too long. */
export function safeName(name: unknown): string {
  const s = String(name ?? "").replace(/[\/\\:\u0000-\u001f\u007f]/g, "-").replace(/^\.+/, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return s || "Layer";
}

/** A suffix made safe for a file name, as typed otherwise (it goes on the name as it is). */
export function safeSuffix(s: unknown): string {
  return String(s ?? "").replace(/[\/\\:\u0000-\u001f\u007f]/g, "-").slice(0, 60);
}

/**
 * The file name an export suggests: "Home.png", "Home@2x.png", "Home 1290x2796.png", "Home.svg", and with a suffix
 * "Home-dark.png" (the suffix replaces the scale's "@2x").
 */
export function exportFileName(name: unknown, format: ExportFormat, o: { scale?: number; preset?: PresetId; suffix?: string } = {}): string {
  const base = safeName(name);
  if (o.suffix) return `${base}${safeSuffix(o.suffix)}.${format}`;
  if (isVector(format)) return `${base}.${format}`;
  if (o.preset) return `${base} ${EXPORT_PRESETS[o.preset].width}x${EXPORT_PRESETS[o.preset].height}.${format}`;
  const s = o.scale ?? 1;
  return s === 1 ? `${base}.${format}` : `${base}@${Math.round(s * 100) / 100}x.${format}`;
}

/** Names that do not repeat within one export: "Card.png", "Card 2.png", ... */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    const ext = path.extname(n), stem = n.slice(0, n.length - ext.length);
    let out = n;
    for (let k = 2; used.has(out.toLowerCase()); k++) out = `${stem} ${k}${ext}`;
    used.add(out.toLowerCase());
    return out;
  });
}

// ---------- PNG: just enough to flatten, pad or crop Chrome's screenshots ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type Pixels = { width: number; height: number; channels: 3 | 4; data: Uint8Array };

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG (what Chrome writes). */
export function decodePng(buf: Buffer): Pixels {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let at = 8, width = 0, height = 0, type = 0;
  const idat: Buffer[] = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), kind = buf.toString("latin1", at + 4, at + 8), body = buf.subarray(at + 8, at + 8 + len);
    if (kind === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); type = body[9];
      if (body[8] !== 8 || (type !== 2 && type !== 6) || body[12] !== 0) throw new Error("unsupported PNG (want 8-bit RGB or RGBA, not interlaced)");
    } else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    at += 12 + len;
  }
  const ch = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch, out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[dst + x - ch] : 0, b = y ? out[dst - stride + x] : 0, c = x >= ch && y ? out[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  return { width, height, channels: ch, data: out };
}

function chunk(kind: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(kind, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encode RGB or RGBA pixels as an sRGB PNG (each row filtered the way that packs best). */
export function encodePng(p: Pixels): Buffer {
  const { width, height, channels: ch, data } = p;
  const stride = width * ch;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = data[row + x], a = x >= ch ? data[row + x - ch] : 0, b = y ? data[row - stride + x] : 0, d = x >= ch && y ? data[row - stride + x - ch] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) { const q = a + b - d, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - d); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : d; }
        const out = (v - pred) & 255;
        c[x] = out;
        sum += out < 128 ? out : 256 - out;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("sRGB", Buffer.from([0])), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Put a drawing on a canvas of the plan's size: at (dx, dy), cropped where it reaches past the edges. Opaque: on
 * white, RGB (no alpha channel); else RGBA with transparent padding.
 */
export function place(src: Pixels, width: number, height: number, dx: number, dy: number, opaque: boolean): Pixels {
  const ch = opaque ? 3 : 4;
  const out = new Uint8Array(width * height * ch);
  if (opaque) out.fill(255);
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= width) continue;
      const s = (y * src.width + x) * src.channels, t = (ty * width + tx) * ch;
      const a = src.channels === 4 ? src.data[s + 3] : 255;
      if (opaque) {
        // Over white: c*a + 255*(1-a).
        for (let k = 0; k < 3; k++) out[t + k] = Math.round((src.data[s + k] * a + 255 * (255 - a)) / 255);
      } else {
        out[t] = src.data[s]; out[t + 1] = src.data[s + 1]; out[t + 2] = src.data[s + 2]; out[t + 3] = a;
      }
    }
  }
  return { width, height, channels: ch, data: out };
}

/** Chrome's screenshot made into the file the plan asks for. Returns the bytes as they are when they already are. */
export function finishPng(shot: Buffer, plan: ReturnType<typeof exportPlan>): Buffer {
  const px = decodePng(shot);
  if (!plan.opaque && px.width === plan.width && px.height === plan.height) return shot;
  // The drawing Chrome made may be a pixel off the rounded size: centre it on where the plan put it.
  const dx = plan.dx + Math.floor((plan.drawn.width - px.width) / 2), dy = plan.dy + Math.floor((plan.drawn.height - px.height) / 2);
  return encodePng(place(px, plan.width, plan.height, dx, dy, plan.opaque));
}

// ---------- SVG: images embedded ----------

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml" };

/** Replace the SVG's file: (and http:) image references with data: URLs, so the file stands alone. Unreadable ones stay and are named. */
export async function embedImages(svg: string, warnings: string[]): Promise<string> {
  const urls = [...new Set([...svg.matchAll(/href="((?:file|https?):[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")))];
  const map = new Map<string, string>();
  for (const u of urls) {
    try {
      let bytes: Buffer, mime: string;
      if (u.startsWith("file:")) {
        const f = fileURLToPath(u);
        bytes = await fs.promises.readFile(f);
        mime = MIME[path.extname(f).toLowerCase()] ?? "application/octet-stream";
      } else {
        const r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(String(r.status));
        bytes = Buffer.from(await r.arrayBuffer());
        mime = r.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
      }
      map.set(u, `data:${mime};base64,${bytes.toString("base64")}`);
    } catch (e) {
      warnings.push(`an image could not be embedded (${(e as Error).message}); the SVG links to it`);
    }
  }
  return svg.replace(/href="((?:file|https?):[^"]+)"/g, (m, u: string) => {
    const d = map.get(u.replace(/&amp;/g, "&"));
    return d ? `href="${d}"` : m;
  });
}

// ---------- the request ----------

/** One file to make: a layer in a format, at a scale or a preset, with an optional suffix. */
export type ExportItem = { id: string; format: ExportFormat; scale?: number; preset?: PresetId; suffix?: string };
/**
 * `items` is what export-run makes (validateExport fills it from ids, format, scale and preset when not given).
 * `inline`: nothing is written; each file comes back as base64 `data` with its world position (Copy as).
 */
export type ExportRequest = { file: string; ids: string[]; format: ExportFormat; scale?: number; preset?: PresetId; path?: string; dir?: string; items: ExportItem[]; inline?: boolean };
export type ExportedFile = { id: string; name: string; path: string; width: number; height: number; bytes: number; data?: string; x?: number; y?: number };

/** Check one export setting (an item of `items`, or a layer's saved setting). Throws with what is wrong. */
export function checkItem(it: Record<string, unknown>, bad: (m: string) => Error): ExportItem {
  if (typeof it.id !== "string" || !it.id) throw bad("each item needs an id");
  const format = it.format ?? "png";
  if (!isFormat(format)) throw bad(`format must be one of ${FORMATS.join(", ")}`);
  if (it.scale !== undefined && (typeof it.scale !== "number" || !Number.isFinite(it.scale) || it.scale < MIN_SCALE || it.scale > MAX_SCALE)) throw bad(`scale must be a number from ${MIN_SCALE} to ${MAX_SCALE}`);
  if (it.preset !== undefined && !isPreset(it.preset)) throw bad(`preset must be one of ${Object.keys(EXPORT_PRESETS).join(", ")}`);
  if (it.preset !== undefined && format !== "png") throw bad("presets are PNG sizes");
  if (it.preset !== undefined && it.scale !== undefined) throw bad("give scale or preset, not both");
  if (it.suffix !== undefined && typeof it.suffix !== "string") throw bad("suffix must be text");
  const out: ExportItem = { id: it.id, format };
  if (it.scale !== undefined && !isVector(format)) out.scale = it.scale as number;
  if (it.preset !== undefined) out.preset = it.preset as PresetId;
  if (typeof it.suffix === "string" && it.suffix) out.suffix = it.suffix;
  return out;
}

/** Check an export request's shape; throws ExportError 400/422 with what is wrong. */
export function validateExport(b: Record<string, unknown>): ExportRequest {
  const bad = (m: string) => new ExportError(422, "invalid", m);
  if (typeof b.file !== "string" || !b.file) throw bad("file is required");
  let items: ExportItem[];
  if (b.items !== undefined) {
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 500) throw bad("items must be 1 to 500 export settings");
    items = (b.items as Record<string, unknown>[]).filter((it) => !(it && typeof it.id === "string" && it.id.startsWith("widget:"))).map((it) => checkItem(it && typeof it === "object" ? it : {}, bad));
    if (!items.length) throw bad("only layers and boards export; cards do not");
  } else {
    if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 500 || b.ids.some((x) => typeof x !== "string" || !x)) throw bad("ids must be 1 to 500 node ids");
    const ids = (b.ids as string[]).filter((x) => !x.startsWith("widget:"));
    if (!ids.length) throw bad("only layers and boards export; cards do not");
    items = ids.map((id) => checkItem({ id, format: b.format, scale: b.scale, preset: b.preset }, bad));
  }
  const ids = items.map((it) => it.id);
  const format = items[0].format;
  const out = (v: unknown, what: string) => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !path.isAbsolute(v)) throw bad(`${what} must be an absolute path`);
    return path.normalize(v);
  };
  const inline = b.inline === true;
  const p = out(b.path, "path"), dir = out(b.dir, "dir");
  if (!inline && !p && !dir) throw bad("give path (one file) or dir (a folder)");
  if (p && dir) throw bad("give path or dir, not both");
  if (p && items.length > 1) throw bad("several layers export into a folder: give dir");
  return { file: b.file, ids, format, scale: items[0].scale, preset: items[0].preset, path: p, dir, items, inline: inline || undefined };
}

/** Where each file goes: `path` as given (its extension fixed), or named after its layer in `dir`. */
export function exportPaths(req: Partial<ExportRequest> & Pick<ExportRequest, "format">, names: string[]): string[] {
  const items = req.items ?? names.map((_, i) => ({ id: req.ids?.[i] ?? "", format: req.format, scale: req.scale, preset: req.preset }));
  if (req.path) {
    const ext = "." + items[0].format;
    return [req.path.toLowerCase().endsWith(ext) || (ext === ".jpg" && /\.jpeg$/i.test(req.path)) ? req.path : req.path + ext];
  }
  return uniqueNames(names.map((n, i) => exportFileName(n, items[i].format, items[i]))).map((n) => path.join(req.dir ?? "", n));
}

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "export-run.ts");

let queue: Promise<unknown> = Promise.resolve();

/** Run an export in a child process (src/export-run.ts); its answer, or an ExportError. One at a time: each starts a Chrome. */
export function runExport(port: number, docFile: string, req: ExportRequest, timeoutMs = 120_000): Promise<{ files: ExportedFile[]; warnings: string[] }> {
  const run = queue.then(() => runOne(port, docFile, req, timeoutMs));
  queue = run.catch(() => {});
  return run;
}

function runOne(port: number, docFile: string, req: ExportRequest, timeoutMs: number): Promise<{ files: ExportedFile[]; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, String(port), docFile], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let out = "", err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { if (out.length < 400_000_000) out += d; }); // Copy as answers with the image itself
    child.stderr.on("data", (d) => { if (err.length < 100_000) err += d; });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(new ExportError(500, "failed", e.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let j: any = null;
      try { j = JSON.parse(out.trim().split("\n").pop() || "null"); } catch {}
      if (code === 0 && j?.files) return resolve(j);
      reject(new ExportError(j?.status ?? 500, j?.code ?? "failed", j?.error ?? (err.trim().split("\n").pop() || `the export stopped (${code ?? "killed"})`)));
    });
    child.stdin.end(JSON.stringify(req));
  });
}

export type ExportDeps = { prime: (file: string) => Promise<void>; docFileOf: (file: string) => string; port: () => number };

export async function handleExportRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ExportDeps): Promise<boolean> {
  if (url.pathname !== "/api/export") return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      chunks.push(Buffer.from(c));
      size += c.length;
      if (size > 1_000_000) return reply(413, { error: "too large", code: "invalid" }), true;
    }
    const raw = Buffer.concat(chunks).toString("utf8"); // decoded once: a character split across chunks stays whole
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(raw || "{}");
    } catch {
      return reply(400, { error: "The request body must be JSON", code: "invalid" }), true;
    }
    const r = validateExport(b);
    await deps.prime(r.file);
    const docFile = deps.docFileOf(r.file);
    const target = r.path ? path.dirname(r.path) : r.dir!;
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new ExportError(404, "not_found", `No folder ${target}`);
    const out = await runExport(deps.port(), docFile, r);
    for (const f of new Set(r.items.map((i) => i.format))) countUsage(`export.${f}`);
    return reply(200, out), true;
  } catch (e) {
    if (e instanceof ExportError) return reply(e.status, { error: e.message, code: e.code }), true;
    return reply(422, { error: (e as Error).message, code: "failed" }), true;
  }
}
