// Document paths. The server opens two kinds of document:
//   Name.canvas/         a macOS package (a folder Finder shows as one file) holding document.json
//                        (the design, plain JSON) and widgets.json (the sidecar envelope). This is what
//                        Canvas.app opens and what the file list shows.
//   foo.canvas.json      a single plain-JSON design file (tests, benchmarks, golden fixtures); its widgets
//                        live in a sidecar, foo.widgets.json, beside it.
// Everything inside the server works on the file that holds the design (docFilePath). The package path
// (displayPath) is what people see and what tabs, listings and bridge events echo.
// Obsidian also uses .canvas for JSON Canvas files, which are plain files; those are not ours.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { loadDoc, serialize } from "./doc/docfile.ts";
import { logPathOf } from "./doc/doclog.ts";
import { forkComments } from "./comments-file.ts";

export const PACKAGE_EXT = ".canvas";
export const DESIGN_FILE = "document.json";
/** A single-file document: the design as one plain JSON file. */
export const FILE_EXT = ".canvas.json";
/** A single-file document's path without FILE_EXT: its sidecars (widgets, shaders, media) are named from it. */
export const stemOf = (file: string): string => (file.endsWith(FILE_EXT) ? file.slice(0, -FILE_EXT.length) : file);
export const WIDGETS_FILE = "widgets.json";
const EMPTY_DOC = { version: "2.21", children: [] };
const EMPTY_WIDGETS = { version: 1, widgets: [] };

export type DocRef = {
  /** The file with the design. */
  docFilePath: string;
  /** Where this document's widgets are stored. */
  widgetsPath: string;
  /** What people see: the package for a .canvas, the loose file itself otherwise. */
  displayPath: string;
  kind: "file" | "canvas";
};

export const plain = (file: string): string => {
  let p = file.startsWith("file://") ? decodeURIComponent(new URL(file).pathname) : file;
  if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
};
// What the async prime (primeDoc) found out about a path, kept for a few seconds. A request primes first, then the
// sync helpers below answer from memory; a path nobody primed falls back to the sync fs call.
const FRESH_MS = 5000;
type Probe = { real?: string; kind?: "file" | "dir" | "none"; at: number };
const probes = new Map<string, Probe>();
const probed = (p: string): Probe | undefined => {
  const x = probes.get(p);
  return x && Date.now() - x.at < FRESH_MS ? x : undefined;
};

/** Resolve and stat a path without blocking the event loop, so the sync helpers that follow answer from memory. */
export async function primeDoc(file: string): Promise<void> {
  if (typeof file !== "string" || !file) return;
  let p: string;
  try {
    p = plain(file);
  } catch {
    return;
  }
  const one = async (q: string) => {
    let real: string | undefined;
    let kind: Probe["kind"] = "none";
    try {
      real = await fs.promises.realpath(q);
      const st = await fs.promises.stat(real);
      kind = st.isFile() ? "file" : st.isDirectory() ? "dir" : "none";
    } catch {
      // Missing or unreadable: "none", the sync path reports the real error.
    }
    probes.set(q, { real, kind, at: Date.now() });
    return real;
  };
  const r = await one(p);
  if (!r) return;
  if (r !== p) probes.set(r, { real: r, kind: probes.get(p)!.kind, at: Date.now() });
  if (p.endsWith(PACKAGE_EXT)) {
    await one(path.join(r, DESIGN_FILE));
  } else if (p.endsWith(FILE_EXT) || path.basename(p) === DESIGN_FILE) {
    if (p.endsWith(FILE_EXT)) await one(sidecarOf(r));
    const dir = path.dirname(r);
    if (path.basename(r) === DESIGN_FILE && path.extname(dir) === PACKAGE_EXT) {
      await one(dir);
      await one(path.join(dir, WIDGETS_FILE));
    }
  }
}

/** Does this path exist? Answers from the last prime when there is one. */
export const pathExists = (p: string): boolean => {
  const x = probed(p);
  return x ? x.kind !== "none" : fs.existsSync(p);
};
const real = (p: string): string => {
  const x = probed(p);
  if (x) return x.real ?? p;
  return fs.existsSync(p) ? fs.realpathSync(p) : p;
};
const isDir = (p: string) => {
  const x = probed(p);
  return x ? x.kind === "dir" : fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
};
const isFile = (p: string) => {
  const x = probed(p);
  return x ? x.kind === "file" : fs.statSync(p, { throwIfNoEntry: false })?.isFile() === true;
};

/**
 * `pkg/<parts>` (pkg is a real path), refused when an existing part of it is a link that leads out of the package.
 * A hostile package could carry document.json, widgets.json, shaders/ or media/ as a symlink to a file or folder
 * elsewhere, and every edit would then be written there.
 */
export function inPackage(pkg: string, ...parts: string[]): string {
  let p = pkg;
  for (const part of parts) {
    p = path.join(p, part);
    const r = real(p);
    // A dangling link has no real path yet: a write would create its target, wherever that is.
    const out = r === p ? fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true : r !== pkg && !r.startsWith(pkg + path.sep);
    if (out) throw new Error(`${p} is a link to somewhere outside its package; Canvas does not read or write through it`);
  }
  return p;
}

const canvasRef = (pkg: string): DocRef => ({ docFilePath: inPackage(pkg, DESIGN_FILE), widgetsPath: inPackage(pkg, WIDGETS_FILE), displayPath: pkg, kind: "canvas" });

/** The widgets file beside a single-file document: foo.canvas.json keeps them in foo.widgets.json. */
export const sidecarOf = (docFile: string): string => stemOf(docFile) + ".widgets.json";

/** Resolve a path a client sent (absolute, ~/..., file://) to a document. Throws for anything else. */
export function resolveDoc(file: string): DocRef {
  if (!file) throw new Error("file is required");
  const p = plain(file);
  if (p.endsWith(PACKAGE_EXT)) {
    if (isFile(p)) throw new Error(`${p} is a plain file, not a Canvas document (Obsidian also uses .canvas for its own files). Canvas documents are folders.`);
    return canvasRef(real(p));
  }
  // The design inside a package, named directly: same document.
  if (path.basename(p) === DESIGN_FILE) {
    const rp = real(p);
    if (path.extname(path.dirname(rp)) === PACKAGE_EXT && isDir(path.dirname(rp))) return canvasRef(path.dirname(rp));
  }
  if (p.endsWith(FILE_EXT)) {
    const rp = real(p);
    return { docFilePath: rp, widgetsPath: sidecarOf(rp), displayPath: rp, kind: "file" };
  }
  throw new Error(`not a Canvas file: ${p}`);
}

/** The path of the file that holds a document's design: what loading, watching and writing use. */
export const resolveDocPath = (file: string): string => resolveDoc(file).docFilePath;

/** What to show for a design path the server holds. Unknown or unrelated paths come back unchanged. */
export function displayPath(docFilePath: string): string {
  try {
    return resolveDoc(docFilePath).displayPath;
  } catch {
    return docFilePath;
  }
}

/** The widgets file for a design: package widgets.json inside a .canvas, the sidecar otherwise. */
export const widgetsPathFor = (docFile: string): string => {
  try {
    return resolveDoc(docFile).widgetsPath;
  } catch {
    return sidecarOf(docFile);
  }
};

/** Build `target` (a new .canvas package) from the given files, in a temp folder beside it, then rename it into place. */
export function createPackage(target: string, fill: (tmp: string) => void): string {
  if (!target.endsWith(PACKAGE_EXT)) throw new DocError(400, `The new document must end in ${PACKAGE_EXT}`);
  if (fs.existsSync(target)) throw new DocError(409, `${target} already exists`);
  const dir = path.dirname(target);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new DocError(404, `No such folder: ${dir}`);
  // Hidden and not ending in .canvas, so a scan never lists half-built documents.
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmp);
  try {
    fill(tmp);
    if (fs.existsSync(target)) throw new DocError(409, `${target} already exists`);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  probes.clear();
  return real(target);
}

export class DocError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const targetPath = (t: unknown): string => {
  if (typeof t !== "string" || !t) throw new DocError(400, "target is required");
  const p = plain(t);
  if (!p.endsWith(PACKAGE_EXT)) throw new DocError(400, `The new document must end in ${PACKAGE_EXT}`);
  return p;
};

/** An empty document. Returns its package path. */
export function newCanvas(target: unknown): string {
  return createPackage(targetPath(target), (tmp) => {
    fs.writeFileSync(path.join(tmp, DESIGN_FILE), JSON.stringify(EMPTY_DOC, null, 2) + "\n");
    fs.writeFileSync(path.join(tmp, WIDGETS_FILE), JSON.stringify(EMPTY_WIDGETS, null, 2) + "\n");
  });
}

/** Relative file references in a design: image fills (`url` on an object of type "image") and document fonts. */
function relativeRefs(doc: unknown): string[] {
  const out = new Set<string>();
  visitRefs(doc, (ref) => (out.add(ref), undefined));
  return [...out];
}

/** Calls `fn` on every file reference field (the same fields relativeRefs reads); a returned string replaces the value. */
export function visitRefs(doc: unknown, fn: (ref: string) => string | undefined): void {
  const walk = (v: unknown, inFonts: boolean) => {
    if (Array.isArray(v)) return void v.forEach((x) => walk(x, inFonts));
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.url === "string" && (o.type === "image" || inFonts)) {
      const r = fn(o.url);
      if (r !== undefined) o.url = r;
    }
    if (typeof o.image === "string") {
      const r = fn(o.image);
      if (r !== undefined) o.image = r;
    }
    for (const [k, x] of Object.entries(o)) walk(x, inFonts || k === "fonts");
  };
  walk(doc, false);
}

/**
 * What a file is by its first bytes: an image, a video or a font, else null. A file reference in a design (an
 * image fill, a font, a video) may name any path, so a copy into a package (Save As, a paste from another file)
 * takes only files that are what a design can use, whatever their name says: never a key, a note or a document.
 */
export function mediaKind(file: string): "image" | "video" | "font" | null {
  let b: Buffer;
  try {
    const fd = fs.openSync(file, "r");
    try {
      b = Buffer.alloc(512);
      b = b.subarray(0, fs.readSync(fd, b, 0, 512, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const at = (o: number, s: string) => b.length >= o + s.length && b.toString("latin1", o, o + s.length) === s;
  const hex = (o: number, h: string) => b.length >= o + h.length / 2 && b.subarray(o, o + h.length / 2).toString("hex") === h;
  if (hex(0, "89504e470d0a1a0a") || hex(0, "ffd8ff") || at(0, "GIF87a") || at(0, "GIF89a") || at(0, "BM") || hex(0, "49492a00") || hex(0, "4d4d002a") || hex(0, "00000100")) return "image";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image";
  if (at(0, "RIFF") && at(8, "AVI ")) return "video";
  if (at(4, "ftyp")) return /^(avi[fs]|hei[cfsx]|mif1|msf1|hevc)$/.test(b.toString("latin1", 8, 12)) ? "image" : "video";
  if (at(4, "moov") || at(4, "mdat") || at(4, "wide") || at(4, "free") || hex(0, "1a45dfa3")) return "video";
  if (hex(0, "00010000") || at(0, "OTTO") || at(0, "true") || at(0, "ttcf") || at(0, "wOFF") || at(0, "wOF2")) return "font";
  // SVG: text that opens an <svg> element within its first bytes (after an XML declaration, comments, a doctype).
  const head = b.toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "image";
  return null;
}

/**
 * May a copy into a package take `file`, named by a document in `docDir`? Only a media file (mediaKind), and none
 * that sits in a hidden folder (~/.ssh, ~/.aws, ~/.config) the document's own folder is not itself inside.
 */
export function copyableMedia(file: string, docDir: string): boolean {
  if (!mediaKind(file)) return false;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const rel = path.relative(real(docDir), real(file)).split(path.sep);
  return !rel.some((s) => s.startsWith(".") && s !== ".." && s !== ".");
}

/**
 * Copy the files a design points at by relative path into the new package. Files inside the design's
 * folder keep their relative path. Files outside it (`../…`) are copied to `linked/<hash>-<name>` and
 * their references in the package's document.json are rewritten, so the package stays self-contained.
 * Files are cloned when the filesystem can.
 */
function copyReferencedFiles(docFilePath: string, pkgTmp: string, warnings: string[], design = docFilePath): void {
  let raw: string;
  let doc: unknown;
  try {
    raw = fs.readFileSync(design, "utf8");
    doc = JSON.parse(raw);
  } catch {
    return;
  }
  const srcDir = path.dirname(docFilePath);
  const rewrites = new Map<string, string>();
  const copy = (from: string, to: string) => {
    if (fs.existsSync(to)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
  };
  for (const ref of relativeRefs(doc)) {
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref) && !ref.startsWith("file:")) continue; // http(s), data, etc.
    if (ref.startsWith("file:") || path.isAbsolute(ref)) continue;
    const rel = path.normalize(ref.split(/[?#]/)[0]);
    if (!rel || rel === "." || path.isAbsolute(rel)) continue;
    const from = path.join(srcDir, rel);
    if (!fs.statSync(from, { throwIfNoEntry: false })?.isFile()) {
      warnings.push(`${ref}: file not found, not copied`);
      continue;
    }
    if (!copyableMedia(from, srcDir)) {
      warnings.push(`${ref}: not an image, video or font file, not copied`);
      continue;
    }
    if (rel.startsWith("..")) {
      const name = `linked/${createHash("sha1").update(path.resolve(from)).digest("hex").slice(0, 8)}-${path.basename(rel)}`;
      copy(from, path.join(pkgTmp, name));
      rewrites.set(ref, name);
      continue;
    }
    const to = path.join(pkgTmp, rel);
    if (to === path.join(pkgTmp, DESIGN_FILE) || to === path.join(pkgTmp, WIDGETS_FILE)) continue;
    copy(from, to);
  }
  if (!rewrites.size) return;
  // Only the reference fields change: a text node or an id that happens to hold the same string stays as it is.
  visitRefs(doc, (ref) => rewrites.get(ref));
  const indent = raw.match(/^[{[]\r?\n([ \t]+)/)?.[1] ?? (raw.includes("\n") ? 2 : undefined);
  fs.writeFileSync(path.join(pkgTmp, DESIGN_FILE), JSON.stringify(doc, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
}

/** A copy of an open document (design and widgets) as a .canvas package. Returns its package path. */
export function saveAsCanvas(file: unknown, target: unknown, warnings: string[] = []): string {
  if (typeof file !== "string" || !file) throw new DocError(400, "file is required");
  const to = targetPath(target);
  let src: DocRef;
  try {
    src = resolveDoc(file);
  } catch (e) {
    throw new DocError(400, (e as Error).message);
  }
  if (!fs.existsSync(src.docFilePath)) throw new DocError(404, `No such file: ${src.docFilePath}`);
  return createPackage(to, (tmp) => {
    // The design as Canvas reads it: document.json with its save log on top (doc/doclog.ts). Another Canvas may own a
    // log with edits not folded yet, or one left by a crash, and this server may never have opened the file: the copy
    // holds every edit either way, written whole. The log itself never comes along (it belongs to the original).
    const l = fs.existsSync(logPathOf(src.docFilePath)) ? loadDoc(src.docFilePath) : undefined;
    if (l?.log?.records) fs.writeFileSync(path.join(tmp, DESIGN_FILE), serialize(l, l.doc));
    else fs.copyFileSync(src.docFilePath, path.join(tmp, DESIGN_FILE));
    copyReferencedFiles(src.docFilePath, tmp, warnings, path.join(tmp, DESIGN_FILE));
    if (fs.existsSync(src.widgetsPath)) fs.copyFileSync(src.widgetsPath, path.join(tmp, WIDGETS_FILE));
    else fs.writeFileSync(path.join(tmp, WIDGETS_FILE), JSON.stringify(EMPTY_WIDGETS, null, 2) + "\n");
    copyCardFiles(src, tmp, warnings);
    // Comments come along as a fork: the copy is another document, so it gets its own comment identity.
    if (src.kind === "canvas") {
      try {
        forkComments(src.displayPath, tmp);
      } catch (e) {
        warnings.push(`The comments were not copied: ${(e as Error).message}`);
      }
    }
  });
}

/**
 * The files the cards keep beside the design: each shader card's WGSL (and its current poster) and each copied
 * video. Without them a Save As copy shows the template shader and broken videos, and deleting the original loses
 * them. A video inside the old document's folder goes to the package's media/ and its card's src is rewritten;
 * a linked video (an absolute src) stays where it is.
 */
function copyCardFiles(src: DocRef, pkgTmp: string, warnings: string[]): void {
  const wPath = path.join(pkgTmp, WIDGETS_FILE);
  let raw: string;
  let env: { widgets?: { id?: unknown; kind?: unknown; config?: Record<string, unknown> }[] };
  try {
    raw = fs.readFileSync(wPath, "utf8");
    env = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(env?.widgets)) return;
  const shaderDir = src.kind === "canvas" ? path.join(src.displayPath, "shaders") : src.docFilePath.replace(/\.canvas\.json$/, "") + ".shaders";
  const base = src.kind === "canvas" ? src.displayPath : path.dirname(src.docFilePath);
  const copy = (from: string, to: string) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
  };
  const isFile = (p: string) => !!fs.statSync(p, { throwIfNoEntry: false })?.isFile();
  const media = new Map<string, string>(); // source file -> its name in the package
  let changed = false;
  for (const w of env.widgets) {
    const id = typeof w?.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(w.id) ? w.id : null;
    if (!id) continue;
    if (w.kind === "shader") {
      const wgsl = path.join(shaderDir, `${id}.wgsl`);
      if (isFile(wgsl)) copy(wgsl, path.join(pkgTmp, "shaders", `${id}.wgsl`));
      const rev = typeof w.config?.rev === "string" ? w.config.rev : "";
      const poster = path.join(shaderDir, `${id}.poster-${rev}.png`);
      if (rev && isFile(poster)) copy(poster, path.join(pkgTmp, "shaders", path.basename(poster)));
    } else if (w.kind === "video" && w.config && typeof w.config.src === "string" && w.config.src && !path.isAbsolute(w.config.src)) {
      const from = path.resolve(base, w.config.src);
      if (!from.startsWith(base + path.sep) || !isFile(from)) {
        warnings.push(`${w.config.src}: video not found, not copied`);
        continue;
      }
      let name = media.get(from);
      if (!name) {
        const ext = path.extname(from), stem = path.basename(from, ext);
        const used = new Set(media.values());
        for (let n = 1; ; n++) {
          const cand = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
          if (!used.has(cand)) { name = cand; break; }
        }
        copy(from, path.join(pkgTmp, "media", name));
        media.set(from, name);
      }
      const next = `media/${name}`;
      if (w.config.src !== next) {
        w.config.src = next;
        changed = true;
      }
    }
  }
  if (!changed) return;
  const indent = raw.match(/^[{[]\r?\n([ \t]+)/)?.[1] ?? (raw.includes("\n") ? 2 : undefined);
  fs.writeFileSync(wPath, JSON.stringify(env, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
}

/** Rename only a package beside its current path. Never replace an existing entry. */
export function renameCanvas(file: string, raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.startsWith(".") || name.includes("/") || name.includes("\0")) throw new DocError(400, "Choose a name without slashes or a leading dot");
  const source = plain(file);
  if (!source.endsWith(PACKAGE_EXT) || !fs.lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) throw new DocError(400, "Choose a Canvas package");
  const target = path.join(path.dirname(source), name.endsWith(PACKAGE_EXT) ? name : name + PACKAGE_EXT);
  if (path.dirname(target) !== path.dirname(source)) throw new DocError(400, "The file must stay in the same folder");
  if (target === source) return source;
  if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new DocError(409, "A file with that name already exists");
  fs.renameSync(source, target);
  probes.clear();
  return fs.realpathSync(target);
}
