// Video cards on disk and on the wire. A video card is a widget of kind "video" (src/widgets/kinds/video.ts)
// whose config.src names the file:
//   media/<name>.mp4              inside a package (copied in when the card is added), relative to the package
//   foo.media/<name>.mp4          beside a plain foo.canvas.json, relative to the design file's folder
//   /Users/.../clip.mp4           a file the person chose to link instead of copy (absolute)
// config.hash is the file's content hash (sha1, 12 hex): posters are cached per hash and poster time as
// <media>/posters/<hash>-<ms>.png, so the same clip on two cards, or after a move, is decoded once.
// The stream route serves only the file a video card of that document names, with HTTP Range support
// (seeking, and WKWebView's media loader, need 206 answers).
//
// Proxies. A card plays a copy of its file at about the size it shows, never more: WKWebView holds a 4K H.264
// stream's decoder surfaces, and the frames the engine reads from it, at the stream's own size (8 cards of a 4K
// clip on screen: +1.8 GB; through proxies of the cards' size: +0.35 GB). The page asks /variant with the card's
// long side on screen (device px); the answer names a proxy tier (640, 960, 1280 or 1920 px long side, shown at
// most 25% larger) or "orig" when the file is no larger. Proxies are made with macOS's own avconvert
// (AVFoundation), one at a time, cached per file hash in ~/Library/Caches/Canvas/video-proxies; the file in the
// package stays as it is (export, Reveal, copy).
// A proxy URL (&v=<tier>) always serves that proxy's bytes, so one element never mixes two files.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asOneAction, mediaAdded } from "./cloud-files-ops.ts";
import { inPackage, resolveDoc } from "./docpath.ts";
import { addWidget, getWidget, listWidgets, docFileFor, updateWidget, WidgetError } from "./widgets.ts";
import { VIDEO_TYPES } from "./widgets/kinds/video.ts";
import type { Widget } from "./widgets/types.ts";

export { VIDEO_TYPES };

/** Largest file a card takes (copied or linked). */
export const MAX_VIDEO = 4 * 1024 * 1024 * 1024;
const MAX_POSTER = 8 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** The folder relative srcs resolve against: the package, or the plain .canvas.json's folder. */
export function docBase(docFile: string): string {
  const doc = resolveDoc(docFile);
  return doc.kind === "canvas" ? doc.displayPath : path.dirname(doc.docFilePath);
}

/** Where copied videos go: <package>/media, or foo.media beside a plain foo.canvas.json. */
export function mediaDir(docFile: string): string {
  const doc = resolveDoc(docFile);
  return doc.kind === "canvas" ? inPackage(doc.displayPath, "media") : doc.docFilePath.replace(/\.canvas\.json$/, "") + ".media";
}

/** The absolute file a src names, or null when a relative src leaves the document's folder. */
export function resolveSrc(docFile: string, src: string): string | null {
  if (!src) return null;
  if (path.isAbsolute(src)) return path.normalize(src);
  const base = docBase(docFile);
  const abs = path.resolve(base, src);
  return abs.startsWith(base + path.sep) ? abs : null;
}

const typeOf = (p: string): string | undefined => {
  const ext = path.extname(p).toLowerCase();
  return Object.hasOwn(VIDEO_TYPES, ext) ? VIDEO_TYPES[ext] : undefined;
};

/** Content hash of a file (sha1, 12 hex), cached by path, size and mtime. */
const hashes = new Map<string, { key: string; hash: string }>();
export async function fileHash(file: string): Promise<string> {
  const st = await fs.promises.stat(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = hashes.get(file);
  if (hit && hit.key === key) return hit.hash;
  const h = createHash("sha1");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  const hash = h.digest("hex").slice(0, 12);
  hashes.set(file, { key, hash });
  return hash;
}

/** A video file a person or agent named: absolute, a known type, a regular file within the size limit. */
async function checkFile(p: unknown): Promise<{ file: string; size: number }> {
  if (typeof p !== "string" || !p) throw new WidgetError(422, "invalid-widget", "path must be the video file's absolute path");
  const file = path.normalize(p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p);
  if (!path.isAbsolute(file)) throw new WidgetError(422, "invalid-widget", "path must be absolute");
  if (!typeOf(file)) throw new WidgetError(422, "invalid-widget", `Canvas plays ${Object.keys(VIDEO_TYPES).join(", ")} files`);
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new WidgetError(404, "no-file", `No such file: ${file}`);
  if (st.size > MAX_VIDEO) throw new WidgetError(413, "too-large", "The video is larger than 4 GB");
  return { file, size: st.size };
}

/**
 * Copy a video into the document's media folder. A file with the same name and the same content is reused;
 * another one with that name gets a numbered name. Returns the src (relative) and the hash.
 */
export async function copyIn(docFile: string, file: string): Promise<{ src: string; hash: string; dest: string }> {
  const out = await copyInOnce(docFile, file);
  // A media add: its blob op goes with the step that adds the card (or as an action of its own).
  mediaAdded(docFile, out.dest);
  return out;
}

async function copyInOnce(docFile: string, file: string): Promise<{ src: string; hash: string; dest: string }> {
  const hash = await fileHash(file);
  const dir = mediaDir(docFile);
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(file);
  const stem = path.basename(file, ext).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 80) || "video";
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) {
      if (path.resolve(dest) === path.resolve(file) || (await fileHash(dest)) === hash) return { src: path.relative(docBase(docFile), dest), hash, dest };
      continue;
    }
    // Installed without replacing: two imports of different clips with the same name (at once) must not both
    // rename onto one dest, or the first card plays the second clip. The loser of the race looks at what won.
    const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.promises.copyFile(file, tmp);
      if (await installExclusive(tmp, dest)) return { src: path.relative(docBase(docFile), dest), hash, dest };
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
    if ((await fileHash(dest)) === hash) return { src: path.relative(docBase(docFile), dest), hash, dest };
  }
  throw new WidgetError(409, "name-taken", "Too many videos with that name in the media folder");
}

/** Put `tmp` at `dest` unless something is there already (false then). A hard link where the volume has them. */
async function installExclusive(tmp: string, dest: string): Promise<boolean> {
  try {
    await fs.promises.link(tmp, dest);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw e;
  }
  try {
    await fs.promises.copyFile(tmp, dest, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

export type VideoInput = {
  path?: string; copy?: boolean; name?: string; x?: number; y?: number; w?: number; h?: number; page?: string;
  link?: string | null; autoplay?: boolean; loop?: boolean; muted?: boolean; posterTime?: number;
};
type Who = { source?: "user" | "mcp"; session?: string };

const fileConfig = async (docFile: string, input: VideoInput) => {
  const { file } = await checkFile(input.path);
  if (input.copy === false) return { src: file, hash: await fileHash(file) };
  const { src, hash } = await copyIn(docFile, file);
  return { src, hash };
};

/** A new video card: the file copied in first (or linked), then the widget that names it. */
export async function createVideo(file: string, input: VideoInput, who: Who = {}) {
  return asOneAction(docFileFor(file), () => createVideoNow(file, input, who));
}

async function createVideoNow(file: string, input: VideoInput, who: Who = {}) {
  const docFile = docFileFor(file);
  const f = await fileConfig(docFile, input);
  const abs = resolveSrc(docFile, f.src);
  if (abs) warmProxy(abs, f.hash);
  const config: Record<string, unknown> = { ...f };
  for (const k of ["autoplay", "loop", "muted", "posterTime", "link"] as const) if (input[k] !== undefined) config[k] = input[k];
  const { widget } = await addWidget(file, {
    kind: "video", name: input.name ?? path.basename(f.src, path.extname(f.src)), x: input.x, y: input.y, w: input.w, h: input.h, page: input.page, config,
  }, { record: { label: "Add Video", ...who } });
  return { widget };
}

/** Change a video card's file (copied in like a new one) and anything else a widget patch carries. */
export async function updateVideo(file: string, id: string, input: VideoInput, who: Who = {}) {
  return asOneAction(docFileFor(file), () => updateVideoNow(file, id, input, who));
}

async function updateVideoNow(file: string, id: string, input: VideoInput, who: Who = {}) {
  const docFile = docFileFor(file);
  if (!ID_RE.test(id)) throw new WidgetError(404, "no-widget", `No widget "${id}"`);
  const current = getWidget(file, id).widget;
  if (current.kind !== "video") throw new WidgetError(422, "invalid-widget", `Widget "${id}" is a ${current.kind}, not a video`);
  const config: Record<string, unknown> = input.path !== undefined ? await fileConfig(docFile, input) : {};
  if (typeof config.src === "string") {
    const abs = resolveSrc(docFile, config.src);
    if (abs) warmProxy(abs, String(config.hash ?? ""));
  }
  for (const k of ["autoplay", "loop", "muted", "posterTime", "link"] as const) if (input[k] !== undefined) config[k] = input[k];
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "x", "y", "w", "h"] as const) if (input[k] !== undefined) patch[k] = input[k];
  if (Object.keys(config).length) patch.config = config;
  const { widget } = await updateWidget(file, id, patch, { record: { label: input.path !== undefined ? "Replace Video" : "Video Change", mergeKey: `video:${id}:${Object.keys(patch).sort().join(",")}`, ...who } });
  return { widget };
}

export async function listVideos(file: string) {
  const docFile = docFileFor(file);
  const all = listWidgets(file).widgets as Widget[];
  return {
    videos: all.filter((w) => w.kind === "video").map((w) => {
      const c = w.config as { src?: string; hash?: string; loop?: boolean; autoplay?: boolean; muted?: boolean; posterTime?: number; link?: string | null };
      const abs = resolveSrc(docFile, c.src ?? "");
      return {
        id: w.id, name: w.name, x: w.x, y: w.y, w: w.w, h: w.h, ...(w.page ? { page: w.page } : {}),
        src: c.src ?? "", path: abs, exists: !!abs && fs.existsSync(abs), hash: c.hash ?? "",
        autoplay: c.autoplay !== false, loop: c.loop !== false, muted: c.muted !== false, posterTime: c.posterTime ?? 1, link: c.link ?? null,
      };
    }),
    dir: mediaDir(docFile),
  };
}

/** The file a document's video card plays: only what a video widget of that document names. */
function cardFile(file: string, id: string): { abs: string; type: string; widget: Widget } {
  const docFile = docFileFor(file);
  if (!ID_RE.test(id)) throw new WidgetError(404, "no-widget", `No widget "${id}"`);
  const { widget } = getWidget(file, id);
  if (widget.kind !== "video") throw new WidgetError(404, "no-widget", `Widget "${id}" is not a video`);
  const src = String((widget.config as { src?: string }).src ?? "");
  const abs = resolveSrc(docFile, src);
  const type = abs ? typeOf(abs) : undefined;
  if (!abs || !type) throw new WidgetError(404, "no-file", "This video card has no playable file");
  return { abs, type, widget };
}

/** Parse one HTTP byte range against a file of `size` bytes. null: serve it all; "bad": 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad"; // several ranges or junk: answered with a 416
  let start: number, end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "bad";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "bad";
  return { start, end };
}

/** Serve a file with Range support: 200 for the whole, 206 for a range, 416 for an unsatisfiable one. */
export async function sendRanged(req: http.IncomingMessage, res: http.ServerResponse, abs: string, type: string): Promise<void> {
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st || !st.isFile()) {
    res.writeHead(404, { "content-type": "text/plain", "x-content-type-options": "nosniff" });
    res.end("not found");
    return;
  }
  const size = st.size;
  const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache", "last-modified": st.mtime.toUTCString(), "x-content-type-options": "nosniff" };
  const r = parseRange(req.headers.range, size);
  if (r === "bad") {
    res.writeHead(416, { ...base, "content-range": `bytes */${size}` });
    res.end();
    return;
  }
  const { start, end } = r ?? { start: 0, end: size - 1 };
  res.writeHead(r ? 206 : 200, { ...base, "content-length": String(size ? end - start + 1 : 0), ...(r ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  const s = fs.createReadStream(abs, { start, end });
  s.on("error", () => res.destroy());
  res.on("close", () => s.destroy());
  s.pipe(res);
}

// ---------- proxies ----------

/** Proxy tiers: the long side in px, and the avconvert preset that fits a frame in it (orientation aware). */
export const PROXY_TIERS: { px: number; preset: string }[] = [
  { px: 640, preset: "Preset640x480" },
  { px: 960, preset: "Preset960x540" },
  { px: 1280, preset: "Preset1280x720" },
  { px: 1920, preset: "Preset1920x1080" },
];
const AVCONVERT = "/usr/bin/avconvert";
export const proxyConfig = {
  /** Where proxies go: "" is CANVAS_VIDEO_PROXIES, else ~/Library/Caches/Canvas/video-proxies (read when used). */
  dir: "",
  /** null: find out (macOS with avconvert); tests set it. */
  enabled: null as boolean | null,
  convert: (src: string, out: string, preset: string) => new Promise<void>((res, rej) => execFile(AVCONVERT, ["--source", src, "--output", out, "--preset", preset, "--replace"], { timeout: 10 * 60_000 }, (e) => (e ? rej(e) : res()))),
};
const proxiesOn = () => (proxyConfig.enabled ??= process.platform === "darwin" && fs.existsSync(AVCONVERT));

/** How much larger than its proxy a card may show (a video stretched by a quarter still looks sharp). */
export const PROXY_STRETCH = 1.25;
/** The smallest tier that covers `px` within PROXY_STRETCH (the largest when none does). */
export function tierFor(px: number): number {
  return (PROXY_TIERS.find((t) => t.px * PROXY_STRETCH >= px) ?? PROXY_TIERS[PROXY_TIERS.length - 1]).px;
}

/**
 * A video file's frame size from its MP4/QuickTime track headers (the largest video track), or null when it is
 * not one or has none. Reads box headers and the moov box only.
 */
export async function videoSize(file: string): Promise<{ w: number; h: number } | null> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, "r");
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(16);
    let at = 0;
    for (let n = 0; n < 4096 && at + 8 <= size; n++) {
      await fh.read(head, 0, 16, at);
      let len = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      let hdr = 8;
      if (len === 1) {
        len = Number(head.readBigUInt64BE(8));
        hdr = 16;
      } else if (len === 0) len = size - at;
      if (len < hdr) return null;
      if (type === "moov") {
        if (len > 64 << 20) return null;
        const moov = Buffer.alloc(len - hdr);
        await fh.read(moov, 0, moov.length, at + hdr);
        return trackSize(moov);
      }
      at += len;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function trackSize(buf: Buffer): { w: number; h: number } | null {
  let best: { w: number; h: number } | null = null;
  const walk = (b: Buffer) => {
    for (let at = 0; at + 8 <= b.length; ) {
      const len = b.readUInt32BE(at);
      const type = b.toString("latin1", at + 4, at + 8);
      if (len < 8 || at + len > b.length) return;
      const body = b.subarray(at + 8, at + len);
      if (type === "trak" || type === "mdia") walk(body);
      else if (type === "tkhd" && body.length >= 84) {
        const off = body[0] === 1 ? 88 : 76;
        if (body.length >= off + 8) {
          const w = body.readUInt32BE(off) / 65536, h = body.readUInt32BE(off + 4) / 65536;
          if (w > 0 && h > 0 && (!best || w * h > best.w * best.h)) best = { w: Math.round(w), h: Math.round(h) };
        }
      }
      at += len;
    }
  };
  walk(buf);
  return best;
}

const proxyDir = () => proxyConfig.dir || process.env.CANVAS_VIDEO_PROXIES || path.join(os.homedir(), "Library", "Caches", "Canvas", "video-proxies");
const proxyPath = (hash: string, px: number) => path.join(proxyDir(), `${hash}-${px}.mp4`);
/**
 * A proxy made from the file the card names now. Proxies are keyed by the hash stored when the card was made; a
 * linked file replaced at the same path (its ctime moves, whatever mtime it brings along) must not keep playing
 * the old clip's proxies, or one card would show two clips at two zooms. Such a proxy counts as missing and is
 * made again. Costs two stats.
 */
function proxyFresh(src: string, hash: string, px: number): boolean {
  try {
    const p = fs.statSync(proxyPath(hash, px));
    return p.mtimeMs >= fs.statSync(src).ctimeMs;
  } catch {
    return false;
  }
}
const making = new Map<string, Promise<boolean>>();
const failed = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

/** Start making the proxy (one conversion at a time); resolves to whether it exists. */
function makeProxy(src: string, hash: string, px: number): Promise<boolean> {
  const out = proxyPath(hash, px);
  const key = `${hash}-${px}`;
  const busy = making.get(key);
  if (busy) return busy;
  const tier = PROXY_TIERS.find((t) => t.px === px)!;
  const run = async () => {
    if (proxyFresh(src, hash, px)) return true;
    await fs.promises.mkdir(proxyDir(), { recursive: true });
    const tmp = path.join(proxyDir(), `.${key}.${process.pid}.${randomBytes(4).toString("hex")}.mp4`);
    try {
      await proxyConfig.convert(src, tmp, tier.preset);
      if (!(await videoSize(tmp))) throw new Error("the proxy is not a playable movie");
      await fs.promises.rename(tmp, out);
      return true;
    } catch (e) {
      failed.add(key);
      console.error(`[canvas] video proxy ${key}: ${(e as Error).message}`);
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      return false;
    }
  };
  const p = queue.then(run, run).finally(() => making.delete(key));
  queue = p.catch(() => {});
  making.set(key, p);
  return p;
}

/**
 * What a card `px` device px long on screen should stream: "orig" (the file is no larger than that, or no proxy
 * can be made), a ready proxy tier, or null while the one it needs is being made (the poster shows meanwhile; a
 * smaller or larger ready one is offered instead when there is one).
 */
export async function variantFor(abs: string, hash: string, px: number): Promise<{ v: string | null; tier: number | "orig" }> {
  if (!proxiesOn() || !/^[0-9a-f]{12}$/.test(hash)) return { v: "orig", tier: "orig" };
  const size = await videoSize(abs);
  const long = size ? Math.max(size.w, size.h) : 0;
  const tier = tierFor(Math.max(1, px));
  if (!long || long <= tier) return { v: "orig", tier: "orig" };
  const ready = (t: number) => proxyFresh(abs, hash, t);
  if (ready(tier)) return { v: String(tier), tier };
  if (failed.has(`${hash}-${tier}`)) return { v: "orig", tier };
  void makeProxy(abs, hash, tier);
  const others = PROXY_TIERS.map((t) => t.px).filter((t) => t !== tier && t < long && ready(t));
  const near = others.filter((t) => t < tier).pop() ?? others.find((t) => t > tier);
  return { v: near ? String(near) : null, tier };
}

/** Make the proxy a card will most likely ask for first (a card of default size at 2x), right after an import. */
function warmProxy(abs: string, hash: string): void {
  if (!proxiesOn() || !/^[0-9a-f]{12}$/.test(hash)) return;
  void videoSize(abs).then((s) => {
    if (s && Math.max(s.w, s.h) > PROXY_TIERS[0].px) void makeProxy(abs, hash, PROXY_TIERS[0].px);
  });
}

const posterPath = (docFile: string, hash: string, ms: number) => {
  const doc = resolveDoc(docFile);
  return doc.kind === "canvas" ? path.join(inPackage(doc.displayPath, "media", "posters"), `${hash}-${ms}.png`) : path.join(mediaDir(docFile), "posters", `${hash}-${ms}.png`);
};

// ---------- HTTP ----------

const PAGE_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "page", "videos.js");

function reply(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readBytes(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new WidgetError(413, "too-large", `The request body is larger than ${Math.round(max / 1024)} KB`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBytes(req, 64 * 1024);
  if (!raw.length) return {};
  let j: unknown;
  try {
    j = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new WidgetError(400, "bad-json", "The request body is not valid JSON");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new WidgetError(400, "bad-body", "The request body must be a JSON object");
  return j as Record<string, unknown>;
}

/** /api/videos* and /page/videos.js. Returns false for anything else. `onAgentEdit` feeds finish_work. */
export async function handleVideoRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, onAgentEdit?: (file: string, id: string) => void): Promise<boolean> {
  if (url.pathname === "/page/videos.js") {
    try {
      const body = await fs.promises.readFile(PAGE_JS);
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    } catch {
      reply(res, 404, { error: "not found" });
    }
    return true;
  }
  if (url.pathname !== "/api/videos" && !url.pathname.startsWith("/api/videos/")) return false;
  try {
    const m = req.method ?? "GET";
    const read = m === "GET" || m === "HEAD";
    if (!read && req.headers["x-canvas"] !== "1") return reply(res, 403, { error: "forbidden", code: "forbidden" }), true;
    const file = url.searchParams.get("file") ?? "";
    const [id, what] = url.pathname.split("/").slice(3).map(decodeURIComponent);
    const mcp = req.headers["x-canvas-source"] === "mcp";
    const who: Who = { source: mcp ? "mcp" : "user", session: String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined };
    const edited = (wid: string) => { if (mcp && file && onAgentEdit) onAgentEdit(file, wid); };
    if (!id) {
      if (m === "GET") return reply(res, 200, await listVideos(file)), true;
      if (m === "POST") {
        const made = await createVideo(file, (await readJson(req)) as VideoInput, who);
        edited(made.widget.id);
        return reply(res, 201, made), true;
      }
    } else if (!what) {
      if (m === "PUT" || m === "PATCH") {
        const done = await updateVideo(file, id, (await readJson(req)) as VideoInput, who);
        edited(id);
        return reply(res, 200, done), true;
      }
    } else if (what === "stream" && read) {
      const { abs, type, widget } = cardFile(file, id);
      // A proxy tier (from /variant) streams that proxy; anything else the card's own file.
      const v = Number(url.searchParams.get("v"));
      const hash = String((widget.config as { hash?: string }).hash ?? "");
      if (PROXY_TIERS.some((t) => t.px === v) && /^[0-9a-f]{12}$/.test(hash) && proxyFresh(abs, hash, v)) {
        await sendRanged(req, res, proxyPath(hash, v), "video/mp4");
        return true;
      }
      await sendRanged(req, res, abs, type);
      return true;
    } else if (what === "variant" && m === "GET") {
      const { abs, widget } = cardFile(file, id);
      const px = Number(url.searchParams.get("px"));
      if (!Number.isFinite(px) || px < 0) return reply(res, 400, { error: "px (the card's long side on screen, device px) is required", code: "bad-body" }), true;
      return reply(res, 200, await variantFor(abs, String((widget.config as { hash?: string }).hash ?? ""), px)), true;
    } else if (what === "poster") {
      const docFile = docFileFor(file);
      const hash = url.searchParams.get("hash") ?? "";
      const ms = Number(url.searchParams.get("ms") ?? "");
      if (!/^[0-9a-f]{12}$/.test(hash) || !Number.isInteger(ms) || ms < 0 || ms > 86_400_000) return reply(res, 400, { error: "hash (12 hex) and ms are required", code: "bad-body" }), true;
      // Only posters of the file this card plays.
      const { widget } = cardFile(file, id);
      if ((widget.config as { hash?: string }).hash !== hash) return reply(res, 409, { error: "the card plays another file now", code: "stale" }), true;
      const p = posterPath(docFile, hash, ms);
      if (m === "GET") {
        const png = await fs.promises.readFile(p).catch(() => null);
        if (!png) return reply(res, 404, { error: "no poster yet", code: "not-found" }), true;
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(png);
        return true;
      }
      if (m === "PUT") {
        const png = await readBytes(req, MAX_POSTER);
        if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new WidgetError(400, "bad-body", "The body must be a PNG");
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        await fs.promises.writeFile(tmp, png);
        await fs.promises.rename(tmp, p);
        return reply(res, 200, { saved: true }), true;
      }
    } else if (what === "hash" && m === "POST") {
      // A card added without a hash (a hand-edited widgets.json): hash its file now.
      const { abs } = cardFile(file, id);
      const hash = await fileHash(abs);
      const { widget } = await updateWidget(file, id, { config: { hash } }, { record: { label: "Video Change", ...who } });
      return reply(res, 200, { hash, widget }), true;
    }
    reply(res, 404, { error: "not found", code: "not-found" });
  } catch (e) {
    if (res.headersSent) { res.destroy(); return true; }
    if (e instanceof WidgetError) reply(res, e.status || 500, { error: e.message, code: e.code });
    else reply(res, 500, { error: (e as Error).message });
  }
  return true;
}
