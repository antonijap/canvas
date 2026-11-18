// Image files brought into a document: a file dragged from Finder onto the canvas, or an image pasted with Cmd+V
// (a screenshot). The bytes are copied next to the design so the document keeps working when the original moves:
//   Name.canvas/media/<name>-<hash>.<ext>        inside a package
//   foo.media/<name>-<hash>.<ext>                beside a plain foo.canvas.json
// and the layer's image fill names that path relative to the design, as image fills do (src/scene.ts resolves it).
// The same bytes twice land in one file (the name carries a hash of the content).
//
// POST /api/images?file=...&name=<original file name>  body: the image bytes (at most 50 MB)
//   -> 201 {url, width, height, bytes}   width and height in the image's own px (SVG: its width/height or viewBox)
// Writes need x-canvas: 1. Refused: not an image Canvas draws (PNG, JPEG, GIF, WebP, SVG), or a size it cannot read.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { mediaAdded } from "./cloud-files-ops.ts";
import { inPackage, resolveDoc } from "./docpath.ts";

export const MAX_IMAGE = 50 * 1024 * 1024;

export class ImageError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type ImageKind = "png" | "jpg" | "gif" | "webp" | "svg";

/** What the bytes are, by their signature (not the name a file came with). */
export function sniffImage(b: Buffer): ImageKind | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  const head = b.subarray(0, 2048).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** An image's own size in px, read from its header, or null when it cannot be read. */
export function imageSize(b: Buffer, kind: ImageKind): { width: number; height: number } | null {
  const ok = (width: number, height: number) => (width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null);
  try {
    switch (kind) {
      case "png":
        return ok(b.readUInt32BE(16), b.readUInt32BE(20));
      case "gif":
        return ok(b.readUInt16LE(6), b.readUInt16LE(8));
      case "webp": {
        const chunk = b.subarray(12, 16).toString("latin1");
        if (chunk === "VP8X") return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
        if (chunk === "VP8L") {
          const bits = b.readUInt32LE(21);
          return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
        }
        if (chunk === "VP8 ") return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
        return null;
      }
      case "jpg": {
        // The first start-of-frame marker (SOF0..SOF15 but DHT, JPG and DAC) holds the size.
        let i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) { i++; continue; }
          const m = b[i + 1];
          if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
          const len = b.readUInt16BE(i + 2);
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
          i += 2 + len;
        }
        return null;
      }
      case "svg": {
        const tag = b.toString("utf8").match(/<svg\b[^>]*>/i)?.[0] ?? "";
        const attr = (k: string) => tag.match(new RegExp(`\\s${k}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, "i"))?.[1];
        const w = Number(attr("width")), h = Number(attr("height"));
        if (w > 0 && h > 0) return ok(w, h);
        const vb = tag.match(/\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i);
        return vb ? ok(Number(vb[1]), Number(vb[2])) : ok(300, 150);
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** The folder a document keeps its images in, and how its image fills name a file in it. */
export function mediaDir(file: string): { dir: string; rel: string } {
  const doc = resolveDoc(file);
  if (doc.kind === "canvas") return { dir: inPackage(doc.displayPath, "media"), rel: "media" };
  const stem = path.basename(doc.docFilePath, ".canvas.json");
  return { dir: path.join(path.dirname(doc.docFilePath), `${stem}.media`), rel: `${stem}.media` };
}

/** A file name that is safe on disk and in a URL: the original's stem, lower case, letters, digits and dashes. */
export function safeStem(name: string): string {
  const stem = path.basename(name || "image").replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const s = stem.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "image";
}

/** Copy image bytes into the document's media folder (once per content). */
export async function saveImage(file: string, bytes: Buffer, name: string): Promise<{ url: string; width: number; height: number; bytes: number }> {
  if (!bytes.length) throw new ImageError(400, "empty", "The image is empty");
  if (bytes.length > MAX_IMAGE) throw new ImageError(413, "too-large", `The image is larger than ${MAX_IMAGE / 1048576} MB`);
  const kind = sniffImage(bytes);
  if (!kind) throw new ImageError(415, "not-image", `${name || "The file"} is not an image Canvas can show (PNG, JPEG, GIF, WebP or SVG)`);
  const size = imageSize(bytes, kind);
  if (!size) throw new ImageError(415, "unreadable", `Canvas cannot read the size of ${name || "the image"}`);
  let where;
  try {
    where = mediaDir(file);
  } catch (e) {
    throw new ImageError(404, "no-file", (e as Error).message);
  }
  const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 10);
  const fname = `${safeStem(name)}-${hash}.${kind}`;
  const dest = path.join(where.dir, fname);
  if (!fs.existsSync(dest)) {
    await fs.promises.mkdir(where.dir, { recursive: true });
    const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.promises.writeFile(tmp, bytes);
    await fs.promises.rename(tmp, dest);
  }
  // A media add: its blob op is an action of its own, before the edit that names the file.
  mediaAdded(resolveDoc(file).docFilePath, dest);
  return { url: `${where.rel}/${fname}`, ...size, bytes: bytes.length };
}

/** POST /api/images. Returns false for any other path. */
export async function handleImageRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/images") return false;
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "POST") return reply(405, { error: "POST an image", code: "method" }), true;
    if (req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_IMAGE) throw new ImageError(413, "too-large", `The image is larger than ${MAX_IMAGE / 1048576} MB`);
      chunks.push(c as Buffer);
    }
    const out = await saveImage(url.searchParams.get("file") ?? "", Buffer.concat(chunks), url.searchParams.get("name") ?? "image");
    reply(201, out);
  } catch (e) {
    if (e instanceof ImageError) reply(e.status, { error: e.message, code: e.code });
    else reply(500, { error: (e as Error).message });
  }
  return true;
}
