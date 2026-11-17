// Load, serialize and safely save document files (document.json in a .canvas package, or a single .canvas.json).
// A document is plain JSON, usually JSON.stringify(doc, null, 2) with or without a trailing newline.
// We keep the file's own indent and trailing whitespace so an unchanged document round-trips byte for byte.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Json, DocNode } from "./schema.ts";
import { holdsLogLock, lockLogSync, logSigSync, readLogSync, removeLogSync, tieOf, withLog, type LogHead, type LogInfo, type WithLog } from "./doclog.ts";

export type CanvasDoc = {
  version?: string;
  children: DocNode[];
  variables?: Record<string, Json>;
  themes?: Record<string, string[]>;
  [k: string]: Json | undefined;
};

export type LoadedDoc = {
  path: string; // real path
  raw: string;
  hash: string;
  mtimeMs: number;
  size: number;
  mode: number;
  indent: string;
  trailing: string;
  doc: CanvasDoc;
  /** The save log beside the file applied on top of it (doclog.ts); `hash` stays the hash of the file's own bytes. */
  log?: LogInfo;
  /** A save log is there but belongs to other bytes (the file was saved whole by someone else since): ignored. */
  logStale?: boolean;
  /** That stale log was copied here with its package (doclog.ts isCopy): recovered over these bytes, never dropped. */
  logCopy?: boolean;
  /** That stale log is for these very bytes in this very file, only its ctime moved: put back in place (a restore). */
  logRestored?: boolean;
  /** A save log this build does not read (a newer version): ignored, and never removed. */
  logUnknown?: boolean;
  /** The save log's first line (who appends to it, what it applies to). */
  logHead?: LogHead;
  /** The save log file as it was read: inode:bytes (undefined: there was none). */
  logSeen?: string;
};

/** The log fields of a LoadedDoc, from what withLog found. */
export const logFields = (lg: WithLog): Partial<LoadedDoc> => ({
  ...(lg.log ? { log: lg.log } : {}),
  ...(lg.stale ? { logStale: true } : {}),
  ...(lg.copy ? { logCopy: true } : {}),
  ...(lg.restored ? { logRestored: true } : {}),
  ...(lg.unknown ? { logUnknown: true } : {}),
  ...(lg.head ? { logHead: lg.head } : {}),
  ...(lg.seen ? { logSeen: lg.seen } : {}),
});

export class StaleFileError extends Error {}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const revisionOf = (hash: string) => hash.slice(0, 12);

/** The design file inside a .canvas package (src/docpath.ts DESIGN_FILE). */
const PACKAGE_FILE = "document.json";

export function resolveDocPath(file: string): string {
  if (!file) throw new Error("file is required");
  let p = file.startsWith("file://") ? decodeURIComponent(new URL(file).pathname) : file;
  if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  p = path.resolve(p);
  // A .canvas package holds its design as document.json.
  if (p.endsWith(".canvas")) p = path.join(p, PACKAGE_FILE);
  if (!p.endsWith(".canvas.json") && !(path.basename(p) === PACKAGE_FILE && path.dirname(p).endsWith(".canvas"))) throw new Error(`not a Canvas file: ${p}`);
  const r = fs.existsSync(p) ? fs.realpathSync(p) : p;
  // The design inside a package must stay inside it: a link out (a hostile package) is never read or written.
  const pkg = path.dirname(p);
  if (pkg.endsWith(".canvas") && path.basename(p) === PACKAGE_FILE) {
    const root = fs.existsSync(pkg) ? fs.realpathSync(pkg) : pkg;
    const out = r === p ? fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true : !r.startsWith(root + path.sep);
    if (out) throw new Error(`${p} is a link to somewhere outside its package; Canvas does not read or write through it`);
  }
  return r;
}

export function loadDoc(file: string): LoadedDoc {
  const p = resolveDocPath(file);
  // The save log first: a whole write that lands between the two reads makes the log stale for the new bytes
  // (ignored, and they hold everything), never the other way round (old bytes without the log that went with them).
  const logRaw = readLogSync(p);
  // The bytes and the file they came from (the log's tie) from one descriptor: a save landing in between cannot pair them wrong.
  const fd = fs.openSync(p, "r");
  let raw: string, st: fs.Stats;
  try {
    raw = fs.readFileSync(fd, "utf8");
    st = fs.fstatSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let doc: CanvasDoc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${p} is not plain JSON (${(e as Error).message}). This server only edits plain-JSON Canvas documents.`);
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.children)) throw new Error(`${p} has no "children" array; not a Canvas document`);
  const m = raw.match(/^\{\r?\n([ \t]+)"/);
  const indent = m ? m[1] : raw.startsWith("{\n") || raw === "{}" ? "  " : "";
  // Not /\s*$/: on a big file that regex retries from every position and costs ~0.4 s for 18 MB.
  const trailing = raw.slice(raw.trimEnd().length);
  const hash = sha(raw);
  const lg = withLog(p, hash, doc, logRaw, tieOf(st));
  return { path: p, raw, hash, mtimeMs: st.mtimeMs, size: st.size, mode: st.mode & 0o777, indent, trailing, doc: lg.doc, ...logFields(lg) };
}

export function serialize(loaded: Pick<LoadedDoc, "indent" | "trailing">, doc: CanvasDoc): string {
  return JSON.stringify(doc, null, loaded.indent || undefined) + loaded.trailing;
}

/** Where backups of every write go: ~/Library/Application Support/Canvas, or CANVAS_STATE_DIR. */
export function stateHome(): string {
  return process.env.CANVAS_STATE_DIR || path.join(os.homedir(), "Library", "Application Support", "Canvas");
}

export function backupDirFor(p: string): string {
  const tag = createHash("sha1").update(p).digest("hex").slice(0, 8);
  return path.join(stateHome(), "backups", `${path.basename(p, ".canvas.json")}-${tag}`);
}

const KEEP_BACKUPS = 10;

export function backup(loaded: LoadedDoc): string {
  const dir = backupDirFor(loaded.path);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${stamp}-${revisionOf(loaded.hash)}.json.gz`);
  // Level 1: half the time of the default on an 18 MB file, for a slightly bigger backup.
  fs.writeFileSync(dest, gzipSync(loaded.raw, { level: 1 }), { mode: 0o600 });
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, old), { force: true });
  return dest;
}

const KEEP_VERSIONS = 20;

/** Autosave history, kept apart from per-edit backups so a busy editing day cannot push either one out. */
export function versionBackup(loaded: LoadedDoc): string {
  const dir = path.join(backupDirFor(loaded.path), "autosave");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${stamp}-${revisionOf(loaded.hash)}.json.gz`);
  fs.writeFileSync(dest, gzipSync(loaded.raw), { mode: 0o600 });
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_VERSIONS))) fs.rmSync(path.join(dir, old), { force: true });
  return dest;
}

/**
 * The replaced bytes matched. Someone may still hold the old file open and write to it a moment later (their write
 * would go nowhere once the last name is gone): the copy stays 2 s and is checked again. Changed, it is kept as a
 * conflict copy; when this process ends first, it simply stays (never deleted unchecked).
 */
function laterRemove(prev: string, hash: string, doc: string): void {
  let size = -1, mtime = -1;
  try {
    const s0 = fs.statSync(prev);
    size = s0.size;
    mtime = s0.mtimeMs;
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      const s1 = fs.statSync(prev);
      if (s1.size === size && s1.mtimeMs === mtime && sha(fs.readFileSync(prev, "utf8")) === hash) {
        fs.rmSync(prev, { force: true });
        return;
      }
      const dest = `${doc}.conflict-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
      fs.linkSync(prev, dest);
      fs.rmSync(prev, { force: true });
      console.error(`[canvas] a late write to the replaced file is kept as ${dest}`);
    } catch {}
  }, 2000).unref();
}

/** fsync a folder so a rename in it survives a power loss (best effort: not every volume allows it). */
function syncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

/**
 * Write `doc` over the file that `loaded` came from.
 * Refuses when the file on disk no longer matches what was loaded. Backs up the old bytes first.
 * Writes a temp file in the same folder, fsyncs it and renames it over the original (atomic on one volume).
 */
export function saveDoc(loaded: LoadedDoc, doc: CanvasDoc): { hash: string; backup: string; bytes: number; conflict?: string } {
  const assertUnchanged = (quick = false) => {
    // Up front a matching size and mtime is enough; the check right before the swap always compares bytes.
    if (quick) {
      const st = fs.statSync(loaded.path);
      if (st.size === loaded.size && st.mtimeMs === loaded.mtimeMs) return;
    }
    const now = fs.readFileSync(loaded.path, "utf8");
    if (sha(now) !== loaded.hash) {
      throw new StaleFileError(`${loaded.path} changed on disk after it was read. Nothing was written. Read it again and redo the change.`);
    }
  };
  assertUnchanged(true);
  const out = serialize(loaded, doc);
  JSON.parse(out); // never write something that does not parse
  const bak = backup(loaded);
  const tmp = path.join(path.dirname(loaded.path), `.${path.basename(loaded.path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", loaded.mode || 0o644);
  try {
    // A write may take fewer bytes than it was given: loop until all of them are written (never a short file).
    const buf = Buffer.from(out);
    for (let off = 0; off < buf.length; ) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new Error(`a write made no progress at byte ${off} of ${buf.length}`);
      off += n;
    }
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  // The bytes being replaced stay reachable (a hard link) until the swap is done: if someone writes them in the
  // instant between the last check and the rename, their save is kept next to the file instead of lost.
  // Without a way to keep them (no hard links on the volume: a clone checked against what was loaded), nothing is replaced.
  const prev = `${tmp}.prev`;
  let kind: "link" | "copy" | undefined;
  // A save log beside the file (doclog.ts): no Canvas may append to it or fold it while this save swaps the file,
  // it must still be the log this load applied, and once the swap is done it is retired (this save holds its edits).
  let unlock: (() => void) | undefined;
  try {
    if (loaded.logSeen) {
      if (holdsLogLock(loaded.path)) throw new StaleFileError(`${loaded.path} is being saved by Canvas right now. Nothing was written. Read it again and redo the change.`);
      unlock = lockLogSync(loaded.path);
      if (logSigSync(loaded.path) !== loaded.logSeen) throw new StaleFileError(`${loaded.path} changed on disk after it was read (its save log). Nothing was written. Read it again and redo the change.`);
    }
    fs.chmodSync(tmp, loaded.mode || 0o644);
    assertUnchanged(); // last check right before the swap
    try {
      fs.linkSync(loaded.path, prev);
      kind = "link";
    } catch (e) {
      if (!["EPERM", "ENOTSUP", "EXDEV", "EMLINK", "ENOSYS", "EOPNOTSUPP"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      fs.copyFileSync(loaded.path, prev, fs.constants.COPYFILE_FICLONE);
      kind = "copy";
      if (sha(fs.readFileSync(prev, "utf8")) !== loaded.hash) throw new StaleFileError(`${loaded.path} changed on disk after it was read. Nothing was written. Read it again and redo the change.`);
    }
    fs.renameSync(tmp, loaded.path);
  } catch (e) {
    unlock?.();
    fs.rmSync(tmp, { force: true });
    if (kind) fs.rmSync(prev, { force: true });
    throw e;
  }
  try {
    // The log this load applied (or one with no header: a crash while it was created, nothing in it answered) is
    // in the bytes just written. A stale log or a newer build's stays: it is not in them.
    if (loaded.log || (loaded.logSeen && !loaded.logHead && !loaded.logUnknown)) removeLogSync(loaded.path);
  } catch (e) {
    console.error(`[canvas] retiring the save log of ${loaded.path}: ${(e as Error).message}`);
  } finally {
    unlock?.();
  }
  // The rename landed: the save is done. Nothing after this may fail it (a caller would run the change again).
  let conflict: string | undefined;
  try {
    syncDir(path.dirname(loaded.path));
    let same = kind === "copy";
    if (kind === "link") {
      try {
        same = sha(fs.readFileSync(prev, "utf8")) === loaded.hash;
      } catch {
        same = false; // unreadable is unknown, never the same: the copy is kept
      }
    }
    if (same) laterRemove(prev, loaded.hash, loaded.path);
    else {
      // A name nobody has (a hard link claims it exclusively): never over an earlier conflict copy.
      const base = `${loaded.path}.conflict-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      conflict = prev;
      for (let i = 0; i < 20; i++) {
        const name = i ? `${base}-${randomBytes(3).toString("hex")}` : base;
        try {
          fs.linkSync(prev, name);
          fs.rmSync(prev, { force: true });
          syncDir(path.dirname(loaded.path));
          conflict = name;
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") break; // it stays under its temp name
        }
      }
    }
  } catch (e) {
    console.error(`[canvas] after saving ${loaded.path}: ${(e as Error).message}`);
  }
  return { hash: sha(out), backup: bak, bytes: Buffer.byteLength(out), ...(conflict ? { conflict } : {}) };
}
