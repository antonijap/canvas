// Edits that never stop the server. The plain write path (store.ts writeDoc) reads, parses, serializes, hashes and
// saves the whole document synchronously: about 240 ms on an 18 MB file, during which no request, event stream or bridge message
// moves. Here an edit changes the document Canvas already holds in memory (snapcache.ts) and the file is written
// afterwards, off the request:
//
// - Copy on write. An edit names the nodes it touches; they and the path down to them are copied before the change
//   runs (cowDoc), so every document version stays as it was, a change that throws leaves nothing behind, and
//   everything worked out per top-level board object (boardcache.ts: serialized bytes, change keys, usage) is
//   reused for the boards an edit did not touch. A safety net (verify) catches a change that edited more.
// - One write in flight per file. Edits that land while it runs are written by the next pass, so a burst costs
//   a couple of writes and the file ends at the latest state. A write serializes only the boards that changed,
//   hashes in slices, writes a temp file next to the document, fsyncs it and renames it over the original:
//   a crash leaves the old file or the new one, never a partial one. Every write is based on one disk signature
//   (inode:size:mtime:ctime) taken with its snapshot; anything else on disk at rename time drops the write.
// - The save log. A document of writeConfig.logMinBytes or more saves by appending the layers that changed to a log
//   beside it (doc/doclog.ts, appendLog), fsynced; the whole write above runs when edits pause (compaction), at the
//   latest compactMaxMs after the log's first record, when the log grows past its share, before Save As and at quit,
//   so document.json alone is always a whole document. One server owns a log; others write whole under its lock,
//   and an outside whole save gets the log's edits back on top (see "the save log" below).
// - Revisions. An edit answers at once with a new revision for the state in memory. Once that state is on disk,
//   the file's own hash (the revision store.ts reports) is accepted as the same revision. Small documents
//   (under writeConfig.syncBytes) are still written before the answer, and their revision is the file hash.
// - Our own writes are recognised (inode, size, mtime and the ctime right after the rename; a hash of the bytes
//   when only part of that matches), so the watcher does not reload them. Anyone else's change is reloaded;
//   edits not yet on disk are replayed on the new bytes, each on its own copy: a structure edit replays the ops it
//   first made (the same ids), a property edit runs again and its undo step takes the values it now changed.
//   An edit that cannot be replayed is reported, and Canvas's version from before is saved next to the file.
// - Failures are kept, not forgotten: flushWrites rejects until the state it waits for is on disk, and
//   finishWrites (quit) saves a recovery copy of anything that never made it.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { boardCache, forgetBoard } from "./boardcache.ts";
import { boardLacks } from "./doc/boardindex.ts";
import { applyRecords, chainOf, encodeRecord, headerOf, holdsLogLock, LOG_VERSION, lockConfig, lockLog, lockLogSync, logLockable, logPathOf, logSig, logSigSync, parseLog, readLogSync, removeLogSync, tieCtimeOf, tryLockLog, type LogInfo } from "./doc/doclog.ts";
import { boardDigestStale, snapshotOfDoc, type Snapshot } from "./boards.ts";
import { backupDirFor, findNode, loadDoc, loadDocAsync, revisionOf, sha, StaleFileError, writeDoc, type LoadedDoc, type CanvasDoc, type DocNode } from "./engine.ts";
import type { NodeOp, Op } from "./history.ts";
import { countUsage } from "./usage-counts.ts";

/** What the writer needs from the snapshot cache (server.ts wires it). Without a host, edits go straight to writeDoc. */
export type DocHost = {
  peek(docFile: string): Snapshot | undefined;
  /** The current snapshot, loading it synchronously if needed. */
  get(docFile: string): Snapshot;
  /** Make `snap` the current state (an edit in memory) and announce it. */
  adopt(docFile: string, snap: Snapshot): void;
  /** Take `l` as someone else's bytes for `docFile` (reconcileLoad runs), with `sig` as the signature of what is on disk now. */
  load?(docFile: string, l: LoadedDoc, sig: string): void;
  /** Re-stat the file and reload it when someone else changed it (reconcileLoad runs). */
  ensure(docFile: string): Promise<Snapshot>;
  /**
   * The temp file's inode:size:mtime and the hash of its bytes, just before it is renamed over the document, so the
   * watcher does not take it for an outside change (null: the one just marked did not land).
   */
  markOwn(docFile: string, key: string | null, hash?: string): void;
  /** The document's full signature right after that rename (the ctime the rename gave it). */
  confirmOwn?(docFile: string, sig: string): void;
};

let host: DocHost | undefined;
export function setDocHost(h: DocHost | undefined): void {
  host = h;
  // In the server, a synchronous wait for the save log's lock holds every request: the plain whole write (saveDoc)
  // waits a moment at most, then fails (and says so) rather than stall the server.
  if (h) lockConfig.syncWaitMs = 200;
}

/**
 * Listeners: history.ts rebases an undo step on the ops an edit replayed as (null: it could not be replayed);
 * server.ts shows a save problem to the person.
 */
export const writerHooks: {
  replayed?: (docFile: string, edit: string, ops: Op[] | null) => void;
  /** Applies recorded ops (history.ts replayOps): the crash journal's recovery uses it. */
  applyOps?: (doc: CanvasDoc, ops: Op[]) => Op[];
  problem?: (docFile: string, message: string) => void;
  /** Fault injection for tests: between readStable's read and its second look at the signature. */
  afterStableRead?: (docFile: string) => Promise<void> | void;
} = {};

export const writeConfig = {
  /** Documents up to this size are written before the edit answers (a few ms at most). */
  syncBytes: 256 * 1024,
  /** At most one backup of the previous bytes per file in this window (docfile.ts's backup folder, its 10 newest kept). */
  backupEveryMs: 60_000,
  /** After writes settle, check that every board's cached bytes still match the board. */
  verifyAfterMs: 2000,
  /** Longest stretch of serializing or hashing before the writer yields to other work. */
  sliceMs: 4,
  /** A write starts this long after the last edit (a gesture's edits share one write)... */
  debounceMs: 25,
  /** ...but never later than this after the first edit it carries (the most a crash can lose). */
  maxDelayMs: 250,
  /** Failed attempts before the writer stops retrying on its own (the next edit or flush tries again). */
  maxRetries: 6,
  /**
   * Documents at least this big save by appending the boards that changed to the save log (doc/doclog.ts) instead of
   * rewriting the whole file. Infinity: never (CANVAS_SAVE_LOG=0 turns it off; docs/evidence/speed.md, save log review).
   */
  logMinBytes: process.env.CANVAS_SAVE_LOG === "1" ? 1024 * 1024 : Infinity,
  /** The log is folded into a whole write once it passes this share of the document (or logMaxBytes, if larger)... */
  logMaxShare: 0.25,
  logMaxBytes: 4 * 1024 * 1024,
  /** ...and once edits pause this long (compaction: older builds read document.json alone)... */
  compactAfterMs: 1500,
  /** ...and at the latest this long after the log's first record, even while edits never pause. */
  compactMaxMs: 10_000,
};

type Format = NonNullable<Snapshot["format"]>;
const DEFAULT_FORMAT: Format = { indent: "  ", trailing: "", mode: 0o644, size: 0 };

type Pending = {
  /** The memory version that holds this edit (renumbered when it is replayed on someone else's bytes). */
  version: number;
  /** The edit's name: history.ts finds its undo step by it. */
  edit: string;
  change: (doc: CanvasDoc) => unknown;
  /** Replays the edit exactly as it first applied (the same ids), returning the ops as they applied: structure edits. */
  replay?: (doc: CanvasDoc) => Op[];
  touches: EditOpts["touches"];
  deep?: boolean;
  /** What the edit did, as ops: the structure ops it recorded, or the property changes it made (its last replay's). */
  ops?: Op[];
  /** `ops` came from the edit itself (structure, undo/redo): a replay never swaps them for a property diff. */
  fixedOps?: boolean;
  /** The effect accepted when the edit was made: never replaced, so every later replay is held to it. */
  accepted?: Op[];
  /** The edit's own account of its ops (EditOpts.recorded), asked again after a replay. */
  recorded?: () => Op[];
  /** The save log record that holds it (our log), set as the record is written. */
  seq?: number;
};
/**
 * An open journal. Lines are appended synchronously as edits are made; the fsync that makes them durable runs off
 * the main thread and is shared by every line appended before it started (group commit): `waiting` is the next
 * round, which starts when the one in flight ends, so a burst of edits costs a couple of fsyncs, not one each.
 */
type Journal = {
  fd: number;
  /** The fd was closed (exactly once: closeJournal or the fsync that ended after it). */
  fdClosed?: boolean;
  base: string;
  /** An fsync of this fd is running (its callback closes the fd when the journal was closed meanwhile). */
  inFlight?: boolean;
  /** Lines appended since the round in flight started: the next round, and everyone waiting for it. */
  waiting?: { promise: Promise<void>; resolve: () => void };
  closed?: boolean;
  /** A journal created in place (journalLine's fresh one): its folder entry is fsynced with its first round. */
  needDir?: boolean;
  /** Bytes of its header line: a journal with nothing pending is cut back to it (rewriteJournal). */
  head?: number;
};
type FileState = {
  docFile: string;
  /** Bumped by every edit in memory and every load. */
  version: number;
  /** The version whose bytes are on disk; -1 when the disk holds something we have not loaded yet. */
  diskVersion: number;
  /** The newest version known to be on disk. flushWrites waits for this. */
  saved: number;
  diskHash?: string;
  /** inode:size:mtime:ctime of the file as we last loaded or wrote it. */
  diskKey?: string;
  bytes: number;
  /** Edits that are not on disk yet, in order: replayed when someone else's bytes arrive first. */
  pending: Pending[];
  dirty: boolean;
  writing?: Promise<void>;
  /** Resolves when the write in flight has its bytes renamed into place and durable (settle), before the checks after it. */
  landed?: { promise: Promise<void>; resolve: () => void };
  /**
   * The checks after the last write landed (were the replaced bytes the ones it was based on; are the written ones
   * what it wrote), running beside the next write: that write waits for them before its own rename.
   */
  checking?: Promise<void>;
  /** Bumped when a write in flight must not land: someone else's bytes were loaded. */
  epoch: number;
  /** Bumped by every load (reconcileLoad). */
  loads: number;
  /** A rename of ours is under way: a load now cannot tell which edits its bytes hold, so it waits (ReloadLater). */
  renaming?: boolean;
  lastBackup: number;
  retries: number;
  lastError?: string;
  /** Edits that could not be kept, not yet reported to a flush. */
  dropped: string[];
  /** Versions of the document whose recovery copy could not be written yet (finishWrites tries again). */
  unrecovered: { doc: CanvasDoc; format?: Format; why: string }[];
  /** The crash journal: every edit not yet on disk, appended (and fsynced, group commit) before the edit answers. */
  journal?: Journal;
  journalFailed?: boolean;
  /** A rename of ours whose folder could not be synced: not durable yet (flush rejects, quit keeps a copy). */
  undurable?: boolean;
  /** How many in-memory recovery copies the kept journal(s) cover. */
  journalKeptFor?: number;
  /** The journal of a not-yet-durable rename was kept aside. */
  undurableKept?: boolean;
  writes: number;
  /** The last write's phases, ms (writerStats; bench/structure-prof.ts prints them). */
  lastWrite?: { serialize: number; write: number; swap: number; dirSync: number; landed: number; checks?: number; bytes: number; appended?: boolean };
  verifyTimer?: NodeJS.Timeout;
  writeTimer?: NodeJS.Timeout;
  /** When the oldest edit not yet picked up by a write, and the newest edit, were made. */
  firstDirty: number;
  lastEdit: number;
  /** Temp files a killed server left next to the document, being cleaned up (cleanStaleTemps); never rejects. */
  cleaning?: Promise<void>;
  /**
   * The save log on top of document.json that this state holds (doc/doclog.ts): what it holds, its open file once
   * this run appended, and when its first record was written (ours).
   */
  log?: { info: LogInfo; fh?: fs.promises.FileHandle; checked?: boolean; since?: number; /** This state appended every record in it (it made the log): `logged` holds all their edits. */ mine?: boolean };
  /** The log file as this state last saw it: inode:bytes, or "none". Any other is someone else's change. */
  logSeen: string;
  /** Edits saved in our log, not in document.json yet: they go on top of a save that does not know the log. */
  logged: Pending[];
  /** The log file is in this state (applied, ours, or one with nothing answered in it): a whole write of it retires it. */
  logFold?: boolean;
  /** A log of a version this build does not read is there: never removed, saves are whole. */
  logUnknown?: boolean;
  /**
   * Document ctimes this server caused itself while a log was in play (a hard link to the document made and removed
   * by a whole write that then did not land): not a restore in place (restoreSuspected).
   */
  ownCtimes?: Set<string>;
  /** The release of the log lock this write holds (run takes it, and lets go when it ends). */
  unlock?: () => void;
  /** Waiting for the log lock another Canvas holds, to load again under it (settleLater). */
  loadLockWait?: Promise<void>;
  /** That lock, taken: the next load (reconcileLoad) takes it over and lets go when it is done. */
  loadLock?: () => void;
  /**
   * The document as it is on disk (document.json and the log), as objects shared with the snapshots: a save appends
   * the top-level boards that are not the same objects any more. Undefined: not known (the next save is whole).
   */
  logDoc?: CanvasDoc;
  /** The next write is whole (compaction): edits paused, the log grew, or a board changed without being copied. */
  compactDue?: boolean;
  compactTimer?: NodeJS.Timeout;
};

const states = new Map<string, FileState>();
/** The same signature snapcache.ts keeps: inode:size:mtime:ctime. */
const keyOf = (st: { ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
/** inode:size:mtime: what a temp file keeps through its rename (the rename may move the ctime). */
export const key3 = (sig: string) => sig.split(":").slice(0, 3).join(":");
const token = () => randomBytes(6).toString("hex");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Edits made here that are not on disk yet (history.ts keeps their undo parts apart; the others it may fold). */
export function pendingEdits(docFile: string): Set<string> {
  return new Set(states.get(docFile)?.pending.map((p) => p.edit) ?? []);
}

function stateOf(docFile: string): FileState {
  let st = states.get(docFile);
  if (!st) {
    st = { docFile, version: 0, diskVersion: -1, saved: 0, bytes: Infinity, pending: [], dirty: false, epoch: 0, loads: 0, lastBackup: 0, retries: 0, dropped: [], unrecovered: [], writes: 0, firstDirty: 0, lastEdit: 0, logSeen: "none", logged: [] };
    states.set(docFile, st);
    st.cleaning = cleanStaleTemps(docFile); // a flush waits for it: once it answers, a crash's leftovers are settled
  }
  return st;
}

const alivePid = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Temp files a killed server left next to the document (the document itself is whole: the old bytes or the new
 * ones, the rename is atomic). A kept copy of replaced bytes (-prev.tmp) is not disposable unless it is known: its
 * bytes are the ones the dead server's write was based on (their hash is in its name, see prevName: bytes that server
 * wrote or loaded itself, which settlePrev would have removed), or the document's. Anything else may be the only copy
 * of someone's save, so it is kept as a conflict copy.
 */
async function cleanStaleTemps(docFile: string): Promise<void> {
  const prefix = `.${path.basename(docFile)}.canvas-`;
  try {
    for (const f of await fs.promises.readdir(path.dirname(docFile))) {
      if (!f.startsWith(prefix) || !f.endsWith(".tmp")) continue;
      const pid = Number(f.slice(prefix.length).split("-")[0]);
      if (pid === process.pid || alivePid(pid)) continue;
      const full = path.join(path.dirname(docFile), f);
      if (f.endsWith("-prev.tmp")) {
        const a = await hashFile(full).catch(() => "");
        if (!a) continue; // unreadable: unknown, so it stays
        const base = prevBase(f);
        const b = base && a.startsWith(base) ? a : await hashFile(docFile).catch(() => "");
        if (!b) continue;
        if (a !== b) {
          keepConflict({ docFile } as FileState, full);
          continue;
        }
      }
      await fs.promises.rm(full, { force: true });
    }
  } catch {}
}

/** Journals kept aside are done once nothing they cover is only in memory or not durable. */
function dropKeptJournals(st: FileState): void {
  if (st.unrecovered.length || st.undurable) return;
  st.journalKeptFor = 0;
  st.undurableKept = false;
  try {
    const base = path.basename(journalPath(st.docFile));
    for (const f of fs.readdirSync(path.dirname(st.docFile))) if (f.startsWith(`${base}-kept`)) fs.rmSync(path.join(path.dirname(st.docFile), f), { force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // the folder is gone (moved or deleted): nothing kept here
    console.error(`[canvas] removing kept journals of ${st.docFile}: ${(e as Error).message}`);
  }
}

const unsaved = (st: FileState) => st.dirty || !!st.writing || st.pending.length > 0 || st.saved < st.version || st.unrecovered.length > 0 || !!st.undurable;

/** Edits in memory that are not on disk yet (the cache keeps such a document). */
export const hasPendingWrites = (docFile: string) => {
  const st = states.get(docFile);
  return !!st && unsaved(st);
};

/** What is on disk, as a hash: document.json's own, or the save log's chain over it when the log holds records. */
const stateHash = (st: FileState) => (st.log && st.log.info.records && st.log.info.base === st.diskHash ? st.log.info.chain : st.diskHash);

export const writerStats = (docFile: string) => {
  const st = states.get(docFile);
  return st ? { version: st.version, diskVersion: st.diskVersion, saved: st.saved, writes: st.writes, pending: st.pending.length, writing: !!st.writing, retries: st.retries, lastWrite: st.lastWrite, log: st.log ? { ...st.log.info } : undefined } : undefined;
};

/** The file-hash revision (store.ts's) of the state Canvas shows, when exactly that state is on disk. */
export function persistedRevision(docFile: string): string | undefined {
  const st = states.get(docFile);
  if (st) return !unsaved(st) && st.diskVersion === st.version && st.diskHash ? revisionOf(stateHash(st)!) : undefined;
  const s = host?.peek(docFile);
  return s?.hash ? revisionOf(s.hash) : undefined;
}

function report(docFile: string, message: string): void {
  console.error(`[canvas] ${message}`);
  try {
    writerHooks.problem?.(docFile, message);
  } catch {}
}

/** fsync a folder, so a rename or a new file in it survives a power loss (best effort: not every volume allows it). */
// Only "this volume cannot sync a folder" counts as nothing to do; a permission or descriptor error is a failure.
const NO_DIR_SYNC = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);
function syncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    // A volume that cannot sync folders at all is not a failure; an I/O error is.
    if (!NO_DIR_SYNC.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
}

/** syncDir off the main thread: the folder's fsync runs on libuv's pool, so requests keep moving meanwhile. */
async function syncDirAsync(dir: string): Promise<void> {
  try {
    // Opening the folder is a lookup; the fsync is what takes time (5 to 20 ms on a loaded machine).
    const fd = fs.openSync(dir, "r");
    try {
      await new Promise<void>((res, rej) => fs.fsync(fd, (e) => (e ? rej(e) : res())));
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (!NO_DIR_SYNC.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
}

/**
 * Move `src` to `dest`, or to `dest-<random>` when that name is taken: never over an existing file (a hard link
 * claims the name exclusively; a copy that refuses to overwrite where links are not possible). Returns the name used.
 */
export function moveExclusive(src: string, dest: string, strictSync = true): string {
  const sync = (dir: string) => {
    try {
      syncDir(dir);
    } catch (e) {
      if (strictSync) throw e;
    }
  };
  for (let i = 0; ; i++) {
    const name = i ? `${dest}-${randomBytes(3).toString("hex")}` : dest;
    try {
      fs.linkSync(src, name);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST" && i < 20) continue;
      if (!NO_LINK.has(code)) throw e;
      try {
        fs.copyFileSync(src, name, fs.constants.COPYFILE_EXCL);
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === "EEXIST" && i < 20) continue;
        throw e2;
      }
      // The copy's bytes are durable before the original goes.
      const fd = fs.openSync(name, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    sync(path.dirname(name)); // the new name is durable before the old one goes
    fs.rmSync(src, { force: true });
    sync(path.dirname(src));
    return name;
  }
}

/**
 * Canvas's version of a document, saved next to it (document.json.recovered-<time>), or in the temp folder when that
 * folder cannot take it. Returns the path; throws when neither worked.
 */
export function writeRecovery(docFile: string, doc: CanvasDoc, format?: Format): string {
  const f = format ?? DEFAULT_FORMAT;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const buf = Buffer.from(JSON.stringify(doc, null, f.indent || undefined) + f.trailing);
  let first: Error | undefined;
  for (const dir of [path.dirname(docFile), os.tmpdir()]) {
    let out = path.join(dir, `${path.basename(docFile)}.recovered-${stamp}`);
    let created = false;
    try {
      let fd: number | undefined;
      // A name nobody has: "wx" refuses one that exists (another process may have just taken it), then a fresh one.
      for (let i = 0; fd === undefined; i++) {
        try {
          fd = fs.openSync(out, "wx", 0o600);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST" || i > 20) throw e;
          out = path.join(dir, `${path.basename(docFile)}.recovered-${stamp}-${randomBytes(3).toString("hex")}`);
        }
      }
      created = true;
      try {
        writeAllSync(fd, buf);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      syncDir(dir);
      return out;
    } catch (e) {
      // Only a file this call created is removed (never someone else's recovery copy).
      if (created) {
        try {
          fs.rmSync(out, { force: true });
        } catch {}
      }
      first ??= e as Error;
    }
  }
  throw first!;
}

/** A recovery copy, or (when no disk takes it) the document kept in memory for finishWrites to try again. */
function recover(st: FileState, doc: CanvasDoc, format: Format | undefined, why: string): string {
  try {
    return writeRecovery(st.docFile, doc, format);
  } catch (e) {
    st.unrecovered.push({ doc, format, why });
    console.error(`[canvas] recovery copy of ${st.docFile} failed: ${(e as Error).message}; it stays in memory`);
    return "";
  }
}

/** Edits that could not be replayed: said out loud, and what memory held before is kept in a recovery copy. */
function reportLost(st: FileState, lost: Pending[], before: Snapshot | undefined, over: string): void {
  const copy = before ? recover(st, before.doc, before.format, `${lost.length} edit(s) not applied over ${over}`) : "";
  const msg = `${lost.length} unsaved edit${lost.length === 1 ? "" : "s"} to ${path.basename(st.docFile)} could not be applied over ${over}${copy ? `; Canvas's version from before is saved as ${copy}` : before ? "; Canvas's version from before could not be saved yet and is kept in memory" : ""}`;
  st.dropped.push(msg);
  report(st.docFile, msg);
}

// ---------------------------------------------------------------- crash journal

// Edits not yet on disk live in memory for up to maxDelayMs (longer while the disk refuses). So that a crash in that
// window loses nothing, each is appended to a journal next to the document (.document.json.canvas-journal), as the ops
// it made, and fsynced before the edit answers. The fsync is a group commit: lines are appended as edits come, one
// fsync off the main thread covers every line written before it started, and the server holds each answer until
// the fsync covering its edit is done (journalSynced), so a burst of 100 edits costs a few fsyncs, not 100. A write
// that lands rewrites the journal to what is still pending (removing it when nothing is). A server that finds a journal when it first loads the document applies it to a copy
// and saves that as a recovery copy next to the file: nothing is put over the document behind anyone's back.

/**
 * This server's journal for a document: named by process id and a token for this run, so no later process (even one
 * that gets the same pid) ever writes over it, and two servers on one file never share or remove each other's.
 */
const SESSION = randomBytes(6).toString("hex");
const STARTED = Date.now() - process.uptime() * 1000;
/** This server, as a save log's header names its owner. */
const OWNER = `${process.pid}.${SESSION}.${Math.round(STARTED)}`;
const journalPath = (docFile: string) => path.join(path.dirname(docFile), `.${path.basename(docFile)}.canvas-journal-${process.pid}-${SESSION}`);

/** Is the server that wrote a journal still running: its pid alive, and started when the journal says it was? */
function journalOwnerAlive(pid: number, started: number | undefined): boolean {
  if (!alivePid(pid)) return false;
  if (!started) return true; // no start time to compare: assume the owner, never take a live server's journal
  try {
    const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    const t = Date.parse(lstart);
    return Number.isFinite(t) && Math.abs(t - started) < 3000;
  } catch {
    return true;
  }
}

function closeJournal(st: FileState): void {
  const j = st.journal;
  if (!j) return;
  st.journal = undefined;
  j.closed = true;
  // An fsync running (or due) on this fd closes it when it ends: the number must not be reused under it.
  if (j.inFlight || j.waiting) return;
  closeFd(j);
}

/** Close a journal's fd once: a second close could hit a newer file that got the same number. */
function closeFd(j: Journal): void {
  if (j.fdClosed) return;
  j.fdClosed = true;
  try {
    fs.closeSync(j.fd);
  } catch {}
}

/** Journal fsyncs not finished yet (each resolves once the lines appended before it was asked for are durable). */
const journalWaits = new Set<Promise<void>>();

/**
 * Make every line appended to `j` so far durable: joins the round that has not started yet, or starts one. Never
 * rejects: a failed fsync is reported, and the journal rewritten (and fsynced) from what is pending.
 */
function syncJournal(st: FileState, j: Journal): Promise<void> {
  if (j.waiting) return j.waiting.promise;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  j.waiting = { promise, resolve };
  journalWaits.add(promise);
  void promise.then(() => journalWaits.delete(promise));
  if (!j.inFlight) syncRound(st, j);
  return promise;
}

function syncRound(st: FileState, j: Journal): void {
  const round = j.waiting!;
  j.waiting = undefined;
  j.inFlight = true;
  fs.fsync(j.fd, (err0) => {
    // A journal just created in place: its name is made durable in the same round (the folder's fsync, also off the
    // main thread), before anyone waiting on this round is answered.
    if (!err0 && j.needDir) {
      j.needDir = false;
      syncDirAsync(path.dirname(journalPath(st.docFile))).then(() => after(null), (e) => after(e as Error));
    } else after(err0);
  });
  function after(err: NodeJS.ErrnoException | Error | null): void {
    j.inFlight = false;
    if (err) {
      // As when fsyncSync failed here before: said out loud, and every pending edit written into a fresh journal
      // and fsynced right here (also when this one was already replaced or kept aside: the lines this fsync was to
      // cover may be in no durable journal). A rewrite that fails too is reported the same way.
      journalFailed(st, err);
      rewriteJournal(st, st.diskHash ?? "unknown");
      // The rewrite failed too: the lines this fsync was to cover are in no durable journal.
      if (st.journalFailed) {
        void holdForDocument(st).then(() => round.resolve());
        if (j.waiting) syncRound(st, j);
        else if (j.closed) closeFd(j);
        return;
      }
    }
    round.resolve();
    if (j.waiting) syncRound(st, j);
    else if (j.closed) closeFd(j);
  }
}

/**
 * Resolves once every edit journaled so far is durable in its journal (undefined: nothing is waiting). The server
 * holds each answer until then, so an edit is never acknowledged before a crash could no longer lose it.
 */
export function journalSynced(): Promise<void> | undefined {
  if (!journalWaits.size) return undefined;
  return Promise.all(journalWaits).then(() => {});
}

/** Rewrite the journal to the pending edits on top of the bytes hashing to `base` (removed when there are none). */
function rewriteJournal(st: FileState, base: string | undefined, extra: { edit: string; ops?: Op[] }[] = [], opts: { fresh?: boolean } = {}): void {
  // Nothing pending after a save that kept the document's bytes (an append to the save log): the journal is cut back
  // to its header instead of removed, so the next edit appends a line to it (one fsync, the group commit's) instead of
  // creating it again (a new file and a folder fsync before that edit could answer: 15 ms every structure op).
  const j = st.journal;
  if (j && !j.closed && !j.fdClosed && j.head && j.base === base && !opts.fresh && !extra.length && !st.pending.length && !st.unrecovered.length && !st.undurable) {
    try {
      fs.ftruncateSync(j.fd, j.head);
      return;
    } catch {
      // the usual way below
    }
  }
  closeJournal(st);
  const file = journalPath(st.docFile);
  // The first edit after a save (the journal was removed with nothing pending): nothing to replace, so the journal
  // is created in place and made durable by the group commit (journalSynced, which the answer waits for), instead
  // of a temp file, a rename and two fsyncs on the main thread before the edit could answer.
  if (opts.fresh && !extra.length && st.pending.length && base !== undefined && !st.unrecovered.length && !st.undurable) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "ax", 0o600); // appending: a journal cut back to its header goes on after it
      const lines = [JSON.stringify({ base, file: path.basename(st.docFile), pid: process.pid, started: STARTED }), ...st.pending.map((p) => JSON.stringify({ edit: p.edit, ops: p.ops ?? null }))];
      writeAllSync(fd, Buffer.from(lines.join("\n") + "\n"));
      st.journal = { fd, base, needDir: true, head: Buffer.byteLength(lines[0]) + 1 };
      void syncJournal(st, st.journal);
      return;
    } catch (e) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
        fs.rmSync(file, { force: true });
      }
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") console.error(`[canvas] crash journal for ${st.docFile}: ${(e as Error).message}; writing it the safe way`);
      // A journal by that name exists (or creating it failed): the temp file and rename below.
    }
  }
  // Edits whose recovery copy exists only in memory are in the journal as it is: keep that one aside (a later run
  // recovers it if this one dies) before writing a new one.
  // Every time, while anything is not durable or only in memory: each journal generation is kept, none replaced.
  if (st.unrecovered.length || st.undurable) {
    try {
      if (fs.existsSync(file)) {
        // (The folder may refuse to sync, which is already the trouble being reported: the names are still kept.)
        moveExclusive(file, `${file}-kept${Date.now()}`, false);
      }
      st.journalKeptFor = st.unrecovered.length;
      if (st.undurable) st.undurableKept = true;
    } catch (e) {
      journalFailed(st, e as Error);
      return; // keep the old journal rather than lose what it holds
    }
  }
  try {
    if ((!st.pending.length && !extra.length) || base === undefined) {
      // Edits that exist only in memory (a recovery copy no disk took) keep the journal they are in.
      if (!st.unrecovered.length) fs.rmSync(file, { force: true });
      return;
    }
    const lines = [JSON.stringify({ base, file: path.basename(st.docFile), pid: process.pid, started: STARTED }), ...[...st.pending, ...extra].map((p) => JSON.stringify({ edit: p.edit, ops: p.ops ?? null }))];
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      writeAllSync(fd, Buffer.from(lines.join("\n") + "\n"));
      fs.fsyncSync(fd);
    } catch (e) {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
    let synced = true;
    try {
      syncDir(path.dirname(file));
    } catch (e) {
      synced = false;
      journalFailed(st, e as Error); // the journal is written, its name not yet durable
    }
    st.journal = { fd: fs.openSync(file, "a"), base, head: Buffer.byteLength(lines[0]) + 1 };
    if (synced) st.journalFailed = false;
  } catch (e) {
    journalFailed(st, e as Error);
  }
}

/** The journal cannot be written: edits not yet on disk would not survive a crash. Said once per failure streak. */
function journalFailed(st: FileState, e: Error): void {
  console.error(`[canvas] crash journal for ${st.docFile}: ${e.message}`);
  if (st.journalFailed) return;
  st.journalFailed = true;
  report(st.docFile, `Canvas cannot keep its crash journal for ${path.basename(st.docFile)} (${e.message}): edits not yet saved would be lost if Canvas crashed now`);
}

/**
 * Append one edit to the journal. The line is written now and fsynced in the next group commit (journalSynced):
 * once that resolves, a crash cannot lose the edit. A rewrite (a new base) is fsynced before this returns.
 */
function journalEdit(st: FileState, p: Pending): void {
  journalLine(st, p);
  if (st.journalFailed) void holdForDocument(st);
}

function journalLine(st: FileState, p: Pending): void {
  const base = st.diskHash ?? "unknown";
  if (!st.journal || st.journal.base !== base) return rewriteJournal(st, base, [], { fresh: true });
  try {
    writeAllSync(st.journal.fd, Buffer.from(JSON.stringify({ edit: p.edit, ops: p.ops ?? null }) + "\n"));
  } catch (e) {
    journalFailed(st, e as Error);
    rewriteJournal(st, base);
    return;
  }
  void syncJournal(st, st.journal);
}

/**
 * No durable journal holds the edits just made (it could not be written or fsynced, and rewriting it failed too):
 * the answers wait for the document itself to be written, at once, instead of going out while a crash would lose
 * them. A write that fails as well is reported like any failed save (the journal failure was said out loud
 * already) and lets the answers go, so a broken disk does not stall every request.
 */
function holdForDocument(st: FileState): Promise<void> {
  const p = Promise.resolve()
    .then(() => flushOne(st))
    .catch((e) => console.error(`[canvas] ${st.docFile}: no journal, and the document could not be written either: ${(e as Error).message}`));
  journalWaits.add(p);
  void p.then(() => journalWaits.delete(p));
  return p;
}

/**
 * Journals a crashed server left (its process is gone): their edits applied to a copy of `doc`, saved as a recovery
 * copy and reported. A journal is removed only when every edit in it is in that copy; otherwise it is kept, renamed
 * next to the document (document.json.journal-<time>), and that is reported too.
 */
function recoverJournal(st: FileState, doc: CanvasDoc, hash: string, format?: Format): void {
  const dir = path.dirname(st.docFile);
  const prefix = `.${path.basename(st.docFile)}.canvas-journal-`;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && !f.endsWith(".tmp") && !f.endsWith(SESSION));
  } catch {}
  for (const name of names) {
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter(Boolean);
    let head: { base?: string; pid?: number; started?: number } = {};
    try {
      head = JSON.parse(lines[0] ?? "{}");
    } catch {}
    if (journalOwnerAlive(Number(head.pid ?? name.slice(prefix.length).split("-")[0]), head.started)) continue; // a live server's
    let copy = structuredClone(doc);
    let applied = 0, skipped = 0;
    // A {saved} line says every edit up to the one it names is in the save log: those are on disk already.
    const entries: ({ edit?: string; ops?: Op[] | null } | null)[] = [];
    for (const line of lines.slice(1)) {
      let entry: { edit?: string; ops?: Op[] | null; saved?: string };
      try {
        entry = JSON.parse(line);
      } catch {
        entries.push(null); // a line cut by the crash
        continue;
      }
      if (typeof entry.saved === "string") {
        const at = entries.findIndex((e) => e?.edit === entry.saved);
        if (at >= 0) entries.splice(0, at + 1);
        continue;
      }
      entries.push(entry);
    }
    for (const entry of entries) {
      if (!entry) {
        skipped++;
        continue;
      }
      if (!entry.ops || !writerHooks.applyOps) {
        skipped++;
        continue;
      }
      const next = structuredClone(copy);
      try {
        writerHooks.applyOps(next, entry.ops);
        copy = next;
        applied++;
      } catch {
        skipped++;
      }
    }
    if (!applied && !skipped) {
      fs.rmSync(file, { force: true });
      continue;
    }
    const out = applied ? recover(st, copy, format, "crash journal") : "";
    let kept = "";
    if (skipped || !out) {
      try {
        kept = moveExclusive(file, `${st.docFile}.journal-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      } catch {
        kept = file;
      }
    } else fs.rmSync(file, { force: true });
    report(
      st.docFile,
      `Canvas stopped before saving ${applied + skipped} edit${applied + skipped === 1 ? "" : "s"} to ${path.basename(st.docFile)}${head.base && head.base !== hash ? " (the file changed since)" : ""}` +
        `${applied ? `; ${applied} ${out ? `are in ${out}` : "could not be saved as a recovery copy yet"}` : ""}` +
        `${skipped ? `; ${skipped} could not be applied` : ""}${kept ? `; the journal is kept as ${kept}` : ""}`,
    );
  }
}

// ---------------------------------------------------------------- replay

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as any)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b as object, k) && same((a as any)[k], (b as any)[k]));
}

const valOf = (n: DocNode, k: string) => (n[k] === undefined ? null : { v: structuredClone(n[k]) as any });
function nodeDiffOf(id: string, b: DocNode, a: DocNode): NodeOp | undefined {
  const props: NodeOp["props"] = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (k !== "children" && !same(b[k], a[k])) props[k] = { b: valOf(b, k), a: valOf(a, k) };
  if (!Object.keys(props).length) return undefined;
  // A key added or removed: keep both key orders, so undo and redo write the node back byte for byte (history.ts orderKeys).
  const kb = Object.keys(b).filter((k) => b[k] !== undefined), ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const sameKeys = kb.length === ka.length && kb.every((k) => a[k] !== undefined);
  return sameKeys ? { t: "node", id, props } : { t: "node", id, props, keys: { b: kb, a: ka } };
}

/**
 * The property ops a change made on the nodes it touched (what history.ts records for such an edit). Walks only the
 * nodes copy on write replaced, side by side with the originals; a touched node it does not meet that way is
 * looked up.
 */
function effectOf(before: CanvasDoc, after: CanvasDoc, touches: EditOpts["touches"]): Op[] | undefined {
  if (touches === "all") return undefined;
  const want = new Set<string>();
  for (const id of touches) if (id) want.add(id);
  const ops: NodeOp[] = [];
  const met = new Set<string>();
  const walk = (a: DocNode[], b: DocNode[]) => {
    if (a === b || !Array.isArray(a) || !Array.isArray(b)) return;
    for (let i = 0; i < a.length; i++) {
      const n = a[i], o = b[i];
      if (n === o || !n || typeof n !== "object" || !o || typeof o !== "object" || n.id !== o.id) continue;
      const id = String(n.id);
      if (want.has(id) && !met.has(id)) {
        met.add(id);
        const op = nodeDiffOf(id, o, n);
        if (op) ops.push(op);
      }
      walk(n.children as DocNode[], o.children as DocNode[]);
    }
  };
  walk(after.children, before.children);
  for (const id of want) {
    if (met.has(id)) continue;
    try {
      const op = nodeDiffOf(id, findNode(before, id).node, findNode(after, id).node);
      if (op) ops.push(op);
    } catch {}
  }
  return ops;
}

/** Ids a set of ops names (nodes, parents, inserted subtrees): what a replay of them may change. */
function opIds(ops: Op[]): Set<string | null> {
  const out = new Set<string | null>();
  for (const o of ops) {
    if (o.t === "node") out.add(o.id);
    else if (o.t === "tree") out.add(o.parent).add(String(o.node.id));
    else if (o.t === "move") out.add(o.id).add(o.b.parent).add(o.a.parent);
  }
  return out;
}

/**
 * A property this edit set the first time that its replay no longer sets, and that does not already hold the value
 * (a move that now skips a layer, a resize whose child became auto layout): the edit no longer does what was
 * accepted, so it counts as not replayed.
 */
function missingEffect(first: Op[] | undefined, now: Op[] | undefined, doc: CanvasDoc): string | undefined {
  if (!first || !now) return undefined;
  const have = new Set<string>();
  for (const o of now) if (o.t === "node") for (const k of Object.keys(o.props)) have.add(`${o.id}\n${k}`);
  for (const o of first) {
    if (o.t !== "node") continue;
    for (const [k, d] of Object.entries(o.props)) {
      if (have.has(`${o.id}\n${k}`)) continue;
      let cur: unknown;
      try {
        cur = valOf(findNode(doc, o.id).node, k);
      } catch {
        return `"${o.id}" is gone`;
      }
      if (!same(cur, d.a)) return `"${o.id}" ${k}`;
    }
  }
  return undefined;
}

/** One pending edit on another version of the document, on its own copy: the new document, or why it could not. */
function replayOne(doc: CanvasDoc, p: Pending): { doc: CanvasDoc; ops?: Op[] } | { error: Error } {
  try {
    if (p.replay) {
      // Copy everything the recorded ops name, wherever it sits in these bytes, so a replay that stops halfway
      // leaves `doc` as it was.
      const touches = p.touches === "all" ? "all" : new Set([...p.touches, ...opIds(p.ops ?? [])]);
      const next = cowDoc(doc, touches, p.deep);
      return { doc: next, ops: p.replay(next) };
    }
    const next = cowDoc(doc, p.touches, p.deep);
    p.change(next);
    const ops = effectOf(doc, next, p.touches);
    const miss = missingEffect(p.accepted ?? p.ops, ops, next);
    if (miss) throw new Error(`it no longer applies to ${miss}`);
    return { doc: next, ops };
  } catch (e) {
    return { error: e as Error };
  }
}

const tellReplayed = (docFile: string, edit: string, ops: Op[] | null | undefined) => {
  if (ops === undefined) return;
  try {
    writerHooks.replayed?.(docFile, edit, ops);
  } catch (e) {
    console.error(`[canvas] history rebase: ${(e as Error).message}`);
  }
};

/**
 * The snapshot cache loaded `l` (first load, or someone else changed the file). Returns the revision to use when
 * edits made here were not on disk yet: they are replayed on the new bytes, in order, and written again.
 */
/** An edit to a file that is no longer where it was opened (moved or deleted): refused, never answered and lost. */
export class FileGoneError extends StaleFileError {}

/**
 * Thrown by reconcileLoad while a rename of ours is under way, or while another Canvas holds the save log's lock: the
 * snapshot cache keeps what it has and looks again (`ready`: the load is made again under the lock once it is free).
 */
export class ReloadLater extends Error {
  readonly ready?: Promise<void>;
  constructor(ready?: Promise<void>) {
    super(ready ? "another Canvas holds the save log's lock; loading again once it is free" : "a write is landing; load again in a moment");
    this.name = "ReloadLater";
    this.ready = ready;
  }
}

/** The inode in an inode:bytes signature of the log file (undefined: none). */
const inoOf = (seen: string | undefined) => (seen && seen !== "none" ? seen.split(":")[0] : undefined);

/** The last seq of the log beside `docFile` as it is now, whatever bytes it was written for (0: none, or no record). */
function logSeqNow(docFile: string): number {
  try {
    const raw = readLogSync(docFile)?.raw;
    const p = raw ? parseLog(raw, "", undefined, true) : null;
    return p && "info" in p ? p.info.seq : 0;
  } catch {
    return Infinity; // unreadable: never taken as covered
  }
}

/**
 * Another Canvas holds the save log's lock, and the log must be settled under it: wait for it off the main thread
 * (the server keeps answering), then load again holding it (reconcileLoad takes it over). Never touched without it.
 */
function settleLater(st: FileState): Promise<void> {
  st.loadLockWait ??= (async () => {
    const release = await lockLog(st.docFile, 10 * 60_000);
    st.loadLock = release;
    try {
      await reloadNow(st);
    } finally {
      if (st.loadLock === release) {
        st.loadLock = undefined;
        release();
      }
    }
  })()
    .catch((e) => console.error(`[canvas] settling the save log of ${st.docFile}: ${(e as Error).message}`))
    .finally(() => {
      st.loadLockWait = undefined;
    });
  return st.loadLockWait;
}

export function reconcileLoad(docFile: string, l: LoadedDoc, sig: string): { revision?: string } {
  const st = stateOf(docFile);
  if (st.renaming) throw new ReloadLater();
  const before = host?.peek(docFile);
  const format: Format = { indent: l.indent, trailing: l.trailing, mode: l.mode, size: l.size };
  // What this state held before this load: the log it knew (ours, when it appended to it or loaded it as ours) and
  // the highest record of it whose edits it holds (logged, or pending with that record's seq: an append whose
  // bookkeeping a load came before). A log of ours that this state did not hold (the package was moved or copied,
  // or opened at another path) is never taken as covered: its edits are nowhere in memory.
  const prevLog = st.log;
  const prevOurs = !!prevLog && prevLog.info.owner === OWNER;
  // (No log held, but pending edits carry a seq: the log this state was creating when the disk moved under it.)
  const creating = !prevLog && st.logSeen === "none" && st.pending.some((p) => p.seq !== undefined) && (l.log?.owner ?? l.logHead?.owner) === OWNER;
  const sameIno = prevOurs && inoOf(st.logSeen) !== undefined && inoOf(st.logSeen) === inoOf(l.logSeen);
  // Covered only when this state wrote every record of that file: a log of ours it loaded (written by this server at
  // another path, before a move) has records whose edits are in no Pending here, so it is never taken as covered.
  const sameFile = creating || (sameIno && !!prevLog!.mine);
  const heldSeq = sameFile ? Math.max(prevLog?.info.seq ?? 0, ...st.pending.map((p) => p.seq ?? 0)) : -1;
  // A stale log that is ours, a copy, or one whose owner is gone is settled under the lock: no other Canvas is
  // folding it into a whole write at this moment (it would remove it right after), so whether it is still there says
  // whose it is. Without the lock it is never recovered or removed: the load waits for it (not on the main thread).
  const owner = l.logHead?.owner;
  const needLock = !!(l.logStale && l.logHead && (l.logCopy || owner === OWNER || !ownerAlive(owner)));
  let unlock: (() => void) | undefined;
  let deferred = false;
  if (st.loadLock) {
    unlock = st.loadLock; // settleLater waited for it: this load holds it now
    st.loadLock = undefined;
  } else if (needLock && !holdsLogLock(docFile)) {
    unlock = tryLockLog(docFile) ?? undefined;
    if (!unlock) {
      const ready = settleLater(st);
      if (before) throw new ReloadLater(ready);
      // The first load: shown now, the log left as it is (saves are whole and do not retire it) until settleLater.
      deferred = true;
    }
  }
  const locked = !!unlock || holdsLogLock(docFile);
  if (st.version === 0 && !st.pending.length) recoverJournal(st, l.doc, l.hash, format);
  try {
    st.version++;
    st.epoch++; // a write in flight was based on the bytes these replace: it must not land
    st.loads++;
    st.diskHash = l.hash;
    st.diskKey = sig;
    st.bytes = l.size;
    // The save log as the loader found it, and the document it makes (before any edit replays on top): the next save
    // appends what differs from it.
    const prevLogged = st.logged;
    const since = st.log?.since;
    closeLog(st);
    st.log = undefined;
    st.logged = [];
    st.logFold = false;
    st.logSeen = l.logSeen ?? "none";
    st.logUnknown = !!l.logUnknown;
    st.logDoc = l.doc;
    st.compactDue = false;
    const stillThere = () => {
      try {
        return logSigSync(docFile) === st.logSeen;
      } catch {
        return false;
      }
    };
    /** Edits only in our log that these bytes do not hold: they go on top of them, like edits not saved yet. */
    let merge: Pending[] = [];
    let retire = false, compact = false;
    // Our log is gone (or another file stands in its place) while document.json is still the very bytes it applied
    // to: no whole write folded it (that writes new bytes); something deleted it (a version control clean or stash,
    // a sync or cleanup tool). Its edits are on disk nowhere: back as pending, and written whole.
    if (prevOurs && prevLogged.length && !sameIno && l.hash === prevLog!.info.base) {
      merge = prevLogged;
      compact = true;
    }
    // The same for a log of ours this state loaded rather than wrote (folding it was due): its records are in what
    // Canvas showed, nowhere else. That version is kept as a recovery copy.
    if (prevOurs && !prevLog!.mine && prevLog!.info.records && !sameIno && !l.log && l.hash === prevLog!.info.base && before) {
      const out = recover(st, before.doc, before.format, "save log gone");
      report(docFile, `${path.basename(docFile)}: its save log was removed from outside before Canvas folded it${out ? `; Canvas's version with its ${prevLog!.info.records} save${prevLog!.info.records === 1 ? "" : "s"} is saved as ${out}` : ""}`);
    }
    if (l.log) {
      st.log = { info: { ...l.log }, since: l.log.owner === OWNER ? (since ?? Date.now()) : Date.now(), mine: false };
      st.logFold = true; // the state holds it: a whole write of this state retires it
      if (l.log.copy) compact = true; // copied with its package: into the copy's document.json at once
      else if (l.log.owner === OWNER) {
        if (sameFile && l.log.seq <= heldSeq) {
          const seq = l.log.seq;
          st.log.mine = true;
          st.logged = prevLogged.filter((p) => p.seq !== undefined && p.seq <= seq);
          merge = prevLogged.filter((p) => !(p.seq !== undefined && p.seq <= seq));
        } else compact = true; // ours by name, but not this state's: its edits into document.json at once
      } else if (!ownerAlive(l.log.owner)) compact = true; // nobody appends to it any more: into document.json at once
      // Another live server's log: edits of ours that were in a log of ours are in it (the whole write that retired
      // ours held them).
    } else if (l.logStale && l.logHead && !deferred && locked) {
      if (l.logCopy) {
        // A copy of another package's log, for bytes that are not the ones it was written for: its edits over these
        // bytes as a recovery copy.
        if (stillThere()) retire = recoverStaleLog(st, l, format);
      } else if (l.logRestored) {
        // The file was put back in place to the very bytes the log started from (cp -p, a backup tool): the person
        // rolled it back. The logged edits are not put on top again (whoever owns the log), and not lost either:
        // a recovery copy, and the person is told.
        if (stillThere()) retire = recoverStaleLog(st, l, format, "restored");
      } else if (l.logHead.owner === OWNER) {
        // Someone saved document.json whole without our log's edits (an older build, another app, a sync client): they go on
        // top of their save. Gone meanwhile: a Canvas folded it into the bytes it wrote, which hold them. A log of
        // ours whose edits this state does not hold (the package moved since) is kept as a recovery copy instead.
        if (stillThere()) {
          if (sameFile && logSeqNow(docFile) <= heldSeq) {
            merge = prevLogged;
            retire = true;
          } else retire = recoverStaleLog(st, l, format);
        }
      } else if (!ownerAlive(l.logHead.owner)) {
        // A log whose server is gone, for bytes that are no longer there: its edits are kept as a recovery copy.
        if (stillThere()) retire = recoverStaleLog(st, l, format);
      }
      // A live server's stale log is that server's to put back on top (and retire).
    } else if (l.logSeen && !l.logUnknown && !l.logHead) st.logFold = true; // no header: a crash while it was made, nothing in it answered
    // Edits an append wrote whose record these bytes already hold (the load came between the append and its
    // bookkeeping): in the state, not replayed again.
    if (st.log && st.log.info.owner === OWNER && sameFile) {
      const seq = st.log.info.seq;
      const covered = st.pending.filter((p) => p.seq !== undefined && p.seq <= seq);
      if (covered.length) {
        st.pending = st.pending.filter((p) => !covered.includes(p));
        st.logged.push(...covered);
      }
    }
    if (merge.length) st.pending = [...merge, ...st.pending];
    for (const p of st.pending) p.seq = undefined;
    if (compact) {
      st.compactDue = true;
      st.dirty = true;
      setImmediate(() => kick(st));
    }
    const done = () => {
      if (retire && locked) {
        try {
          removeLogSync(docFile);
          st.logSeen = "none";
          st.logFold = false;
        } catch (e) {
          console.error(`[canvas] retiring the save log of ${docFile}: ${(e as Error).message}`);
        }
      }
    };
    if (!st.pending.length) {
      st.diskVersion = st.version;
      st.saved = st.version;
      done();
      return {};
    }
    const kept: Pending[] = [];
    const lost: Pending[] = [];
    let doc = l.doc;
    for (const p of st.pending) {
      const r = replayOne(doc, p);
      if ("error" in r) {
        console.error(`[canvas] an edit could not be replayed on ${docFile} after it changed on disk: ${r.error.message}`);
        lost.push(p);
        tellReplayed(docFile, p.edit, null);
        continue;
      }
      doc = r.doc;
      tellReplayed(docFile, p.edit, r.ops);
      // The ops the journal keeps: what the edit records now (an undo whose step was just rebased records the new
      // values), else the recorded or replayed ones.
      kept.push({ ...p, version: st.version, seq: undefined, ops: p.replay ? (r.ops ?? p.ops) : p.recorded ? p.recorded() : (r.ops ?? p.ops) });
    }
    l.doc = doc;
    st.pending = kept;
    if (lost.length) reportLost(st, lost, before, "the outside change");
    // The journal holds every edit not in these bytes (those of our stale log too) before that log goes.
    rewriteJournal(st, l.hash);
    done();
    if (!kept.length) {
      st.diskVersion = st.version;
      st.saved = st.version;
      return {};
    }
    st.diskVersion = -1;
    st.dirty = true;
    setImmediate(() => kick(st));
    return { revision: token() };
  } finally {
    unlock?.();
  }
}

/**
 * A stale log whose server is gone (it crashed, then document.json was saved by something else): its records
 * applied to the new bytes are saved as a recovery copy and reported. True when the log may go (its edits are in
 * that copy, or it held none); otherwise it is moved next to the document instead (and true as well).
 */
function recoverStaleLog(st: FileState, l: LoadedDoc, format: Format, why?: "restored"): boolean {
  let raw: Buffer | undefined;
  try {
    raw = readLogSync(st.docFile)?.raw;
  } catch {}
  if (!raw) return false;
  const p = parseLog(raw, "", undefined, true);
  if (!p || !("records" in p) || !p.records.length) return true;
  const copy = structuredClone(l.doc);
  const n = applyRecords(copy, p.records);
  const out = n ? recover(st, copy, format, "save log") : "";
  let kept = "";
  if (!out || n < p.records.length) {
    try {
      kept = moveExclusive(logPathOf(st.docFile), `${st.docFile}.savelog-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    } catch (e) {
      console.error(`[canvas] keeping the stale save log of ${st.docFile}: ${(e as Error).message}`);
      return false;
    }
  }
  const saves = `${p.records.length} save${p.records.length === 1 ? "" : "s"}`;
  report(
    st.docFile,
    (why === "restored"
      ? `${path.basename(st.docFile)} was put back to an earlier version by another app (a restore), without the last ${saves} Canvas had made`
      : `${path.basename(st.docFile)} was saved by another app after Canvas stopped, without ${saves} Canvas had made`) +
      `${out ? `; Canvas's version with ${n === p.records.length ? "them" : `${n} of them`} is saved as ${out}` : ""}${kept ? `; Canvas's save log is kept as ${kept}` : ""}`,
  );
  return true;
}

/** Whether the server named in a log's header (pid.session.start) is running. */
const ownerSeen = new Map<string, { at: number; alive: boolean }>();
function ownerAlive(owner: string | undefined): boolean {
  if (!owner) return false; // a version 1 log: nobody owns it any more
  if (owner === OWNER) return true;
  const c = ownerSeen.get(owner);
  if (c && Date.now() - c.at < 2000) return c.alive;
  const [pid, , started] = owner.split(".");
  const alive = Number(pid) !== process.pid && journalOwnerAlive(Number(pid), Number(started) || undefined);
  ownerSeen.set(owner, { at: Date.now(), alive });
  return alive;
}

/** Whether `expected` names the state in memory: its revision, or the file's hash once that state is on disk. */
function accepts(st: FileState, snap: Snapshot, expected: string): boolean {
  if (expected === snap.revision) return true;
  return !unsaved(st) && st.diskVersion === st.version && !!st.diskHash && stateHash(st)!.startsWith(expected);
}

/**
 * Copy on write: a new document whose path from the root to every touched node is made of copies (each with its
 * own children list), and every other object is shared with `doc`. `deep` copies a touched node's whole subtree,
 * for changes that rewrite its descendants too (structure ops). One walk, which stops once every id was found.
 */
export function cowDoc(doc: CanvasDoc, ids: Iterable<string | null | undefined> | "all", deep = false): CanvasDoc {
  const next = { ...doc, children: doc.children.slice() } as CanvasDoc;
  if (ids === "all") {
    next.children = structuredClone(doc.children);
    return next;
  }
  const want = new Set<string>();
  for (const id of ids) if (id) want.add(id);
  let left = want.size;
  const rec = (n: DocNode): DocNode => {
    if (!left || !n || typeof n !== "object") return n;
    const self = want.has(String(n.id));
    if (self) left--;
    if (self && deep) return structuredClone(n);
    let kids: DocNode[] | undefined;
    const list = n.children as DocNode[] | undefined;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length && left; i++) {
        const r = rec(list[i]);
        if (r !== list[i]) (kids ??= list.slice())[i] = r;
      }
    }
    if (!self && !kids) return n;
    const copy = { ...n };
    if (Array.isArray(list)) copy.children = kids ?? list.slice();
    return copy;
  };
  // A board of an adopted version that holds none of the ids stays shared without being walked (boardindex.ts).
  for (let i = 0; i < next.children.length && left; i++) if (!boardLacks(next.children[i], want)) next.children[i] = rec(next.children[i]);
  return next;
}

export type EditOpts = {
  expectedRevision?: string;
  /**
   * Ids of every node whose own properties or children list the change edits (a parent it inserts into or removes
   * from included; null stands for the document's list, which is always copied). "all" copies everything.
   */
  touches: Iterable<string | null | undefined> | "all";
  /** The change also edits nodes below the touched ones (ungroup moves a group's children): copy whole subtrees. */
  deep?: boolean;
  /** Write without waiting for more edits. */
  urgent?: boolean;
  /**
   * How to replay the edit on someone else's bytes when it is not on disk yet, instead of running `change` again:
   * a change that makes new ids replays the ops it made the first time. Returns the ops as they applied.
   */
  replay?: (doc: CanvasDoc) => Op[];
  /** The ops the change made (structure edits record them as they go): the crash journal keeps them. */
  recorded?: () => Op[];
};
export type EditResult<T> = { result: T; write: { revision?: string; note?: string; edit?: string } };

/**
 * Apply `change` to the document in memory and write the file in the background. Same contract as store.ts
 * writeDoc: StaleFileError when `expectedRevision` is not the current state, the change may run again (a replay
 * after an outside save), and a change that throws changes nothing. `write.edit` names the edit for history.ts.
 */
export function editDoc<T>(docFile: string, opts: EditOpts, change: (doc: CanvasDoc) => T): EditResult<T> {
  if (closing) throw new Error("Canvas is quitting: the edit was not made");
  if (!host) return writeDoc(docFile, { expectedRevision: opts.expectedRevision }, change);
  // The file was moved (a Finder rename of its package) or deleted while open: an edit answered here could never be
  // saved. It is refused, and every page showing the file is told.
  if (!fs.existsSync(docFile)) {
    const name = path.basename(docFile) === "document.json" ? path.basename(path.dirname(docFile)) : path.basename(docFile);
    const msg = `${name} was moved or deleted while open in Canvas, so this edit was not made. Open it from its new place.`;
    report(docFile, msg);
    throw new FileGoneError(msg);
  }
  const st = stateOf(docFile);
  let snap = host.peek(docFile) ?? host.get(docFile);
  if (st.diskKey === undefined) {
    // Loaded before this module heard about it (no reconcile): take the disk as it is now.
    st.diskKey = keyOf(fs.statSync(docFile));
    st.diskHash = snap.hash;
    st.bytes = snap.format?.size ?? Infinity;
    st.diskVersion = st.version;
    st.saved = st.version;
    st.logSeen = logSigSync(docFile); // not ours to append to or retire: saves are whole
  }
  if (opts.expectedRevision && !accepts(st, snap, opts.expectedRevision)) {
    throw new StaleFileError(`${docFile} is at revision ${snap.revision}, not ${opts.expectedRevision}. It changed; read it again before editing.`);
  }
  const next = cowDoc(snap.doc, opts.touches, opts.deep);
  const result = change(next);
  st.version++;
  const edit = token();
  const ops = opts.recorded ? opts.recorded() : effectOf(snap.doc, next, opts.touches);
  const pending: Pending = { version: st.version, edit, change, replay: opts.replay, touches: opts.touches, deep: opts.deep, ops, fixedOps: !!opts.recorded, accepted: ops, recorded: opts.recorded };
  st.pending.push(pending);
  const format = snap.format ?? DEFAULT_FORMAT;
  const small = !st.writing && !st.dirty && st.bytes <= writeConfig.syncBytes && st.diskVersion === st.version - 1 && st.saved === st.version - 1;
  let buf: Buffer | undefined, hash: string | undefined;
  if (small) {
    buf = Buffer.from(JSON.stringify(next, null, format.indent || undefined) + format.trailing);
    hash = sha256(buf);
  }
  snap = snapshotOfDoc(docFile, next, hash ? revisionOf(hash) : token(), format);
  host.adopt(docFile, snap);
  // Journaled first, also when the save happens right now: if that save cannot be made durable, the journal stays.
  journalEdit(st, pending);
  if (buf && hash && writeSmall(st, format, buf, hash)) {
    // written before the answer, as before
    st.logDoc = next;
  } else {
    st.dirty = true;
    st.lastEdit = Date.now();
    st.retries = 0;
    if (!st.firstDirty) st.firstDirty = st.lastEdit;
    if (opts.urgent) st.firstDirty = st.lastEdit - writeConfig.maxDelayMs;
    scheduleWrite(st);
  }
  scheduleVerify(st);
  return { result, write: { revision: snap.revision, edit } };
}

/** The document an edit would start from: memory when the server holds it, else the file. */
export function currentDoc(docFile: string): { doc: CanvasDoc; revision: string } {
  if (!host) {
    const l = loadDoc(docFile);
    return { doc: l.doc, revision: revisionOf(l.hash) };
  }
  const s = host.peek(docFile) ?? host.get(docFile);
  return { doc: s.doc, revision: s.revision };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until the state memory holds now is on disk. Rejects when it could not be written, or an edit was lost. */
async function flushOne(st: FileState, early = false): Promise<void> {
  if (st.cleaning) {
    await st.cleaning;
    st.cleaning = undefined;
  }
  const target = st.version;
  // The writer gave up retrying on its own: an explicit flush tries once more.
  if (st.retries >= writeConfig.maxRetries) st.retries = writeConfig.maxRetries - 1;
  for (let i = 0; ; i++) {
    if (st.dropped.length) throw new Error(st.dropped.splice(0).join("; "));
    if (st.undurable && !st.writing) {
      try {
        syncDir(path.dirname(st.docFile));
        st.undurable = false;
        dropKeptJournals(st);
        if (!st.pending.length) rewriteJournal(st, st.diskHash);
      } catch (e) {
        throw new Error(`${st.docFile} is written but not durable yet (its folder could not be synced: ${(e as Error).message})`);
      }
    }
    // Quitting (not early) also waits for the checks after the last write.
    if (!early && st.checking && st.saved >= target && !st.undurable) {
      await st.checking;
      continue;
    }
    if (st.saved >= target && !st.undurable) return;
    if (st.retries >= writeConfig.maxRetries) throw new Error(`${st.docFile} is not saved: ${st.lastError ?? "writing it failed"}`);
    if (i >= 1000 || !host) throw new Error(`${st.docFile} is not saved yet`);
    if (st.writing) {
      // early: the bytes are in place once settle ran; the checks that follow (were the replaced bytes the ones the
      // write was based on, confirming its signature) hash the whole file twice and need not hold the answer.
      await (early ? Promise.race([st.writing, landedOf(st).promise]) : st.writing);
      continue;
    }
    if (st.retries) await sleep(50 * st.retries);
    if (st.writing) continue;
    st.dirty = true;
    kick(st);
    // early: like a write already in flight above, the answer goes once this one's bytes are in place, not after
    // its checks (a 30 MB file's flush waited 50 ms for them).
    await (st.writing ? (early ? Promise.race([st.writing, landedOf(st).promise]) : st.writing) : yieldNow());
  }
}

/** Resolves when the write in flight for `docFile` has finished (at once when none is), or after `ms` with nothing in flight. Never rejects. */
export function writeSettled(docFile: string, ms: number): Promise<void> {
  const w = states.get(docFile)?.writing;
  if (w) return w.then(() => undefined, () => undefined);
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until every edit made so far is on disk (one file, or all). Rejects unless it is. */
export async function flushWrites(docFile?: string, opts: { early?: boolean } = {}): Promise<void> {
  const list = docFile ? [states.get(docFile)].filter((s): s is FileState => !!s) : [...states.values()];
  const errors: Error[] = [];
  for (const st of list) {
    try {
      await flushOne(st, !!opts.early);
    } catch (e) {
      errors.push(e as Error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
}

/**
 * Before the process exits: wait for every write (at most `timeoutMs`), and save a recovery copy next to each file
 * that still has edits only in memory. Returns what went wrong; empty means everything is on disk.
 */
let closing = false;
/** Take edits again after finishWrites (tests; a quit that could not keep everything stays up and goes on). */
export const resumeWrites = () => void (closing = false);

export async function finishWrites(timeoutMs = 5000): Promise<{ problems: string[]; kept: boolean }> {
  closing = true; // no edit is taken from here on: the set to save is fixed
  settleLingering();
  const problems: string[] = [];
  let kept = true;
  let timer: NodeJS.Timeout | undefined;
  try {
    // Every edit is on disk once flushed (the save log included); document.json is then written whole, so a build
    // that does not read the log opens the file as Canvas left it. A failure there loses nothing (the log stays).
    await Promise.race([flushWrites().then(() => compactWrites().catch((e) => console.error(`[canvas] ${(e as Error).message}`))), new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`saving did not finish within ${timeoutMs} ms`)), timeoutMs)))]);
  } catch (e) {
    problems.push((e as Error).message);
  } finally {
    clearTimeout(timer);
  }
  for (const st of states.values()) {
    try {
      finishOne(st, problems) || (kept = false);
    } catch (e) {
      // Whatever went wrong here, this document may still hold edits only in memory: the process must not exit.
      kept = false;
      problems.push(`${st.docFile}: ${(e as Error).message}`);
    }
  }
  settleLingering();
  if (!kept) closing = false; // the process stays up (edits are only in memory): editing goes on
  return { problems, kept };
}

/** One document at quit: recovery copies still owed, then a copy of anything not on disk. False: something stays only in memory. */
function finishOne(st: FileState, problems: string[]): boolean {
  let kept = true;
  // Recovery copies that could not be written earlier: once more.
  for (const r of st.unrecovered.slice()) {
    try {
      const out = writeRecovery(st.docFile, r.doc, r.format);
      st.unrecovered.splice(st.unrecovered.indexOf(r), 1);
      const msg = `${path.basename(st.docFile)}: ${r.why}; Canvas's version is saved as ${out}`;
      problems.push(msg);
      report(st.docFile, msg);
    } catch (e) {
      kept = false;
      const msg = `${st.docFile}: ${r.why}, and no recovery copy could be written (${(e as Error).message})`;
      problems.push(msg);
      report(st.docFile, msg);
    }
  }
  if (!st.unrecovered.length) dropKeptJournals(st); // every copy is on disk now
  if (!unsaved(st)) return kept;
  const snap = host?.peek(st.docFile);
  let msg: string;
  if (!snap) msg = `${st.docFile} has edits that are not saved, and no copy in memory to recover them from`;
  else {
    try {
      msg = `${path.basename(st.docFile)} has edits that are not saved; they are kept in ${writeRecovery(st.docFile, snap.doc, snap.format)}`;
    } catch (e) {
      kept = false;
      msg = `${st.docFile} has edits that are not saved, and the recovery copy failed: ${(e as Error).message}`;
    }
  }
  problems.push(msg);
  report(st.docFile, msg);

  return kept;
}

// ---------------------------------------------------------------- serializing

const pieces = boardCache<{ indent: string; buf: Buffer }>();

const pieceString = (board: unknown, indent: string): string => {
  let s = JSON.stringify(board, null, indent || undefined) ?? "null";
  if (indent && board && typeof board === "object") s = s.replaceAll("\n", "\n" + indent + indent);
  return s;
};

/** One top-level board as JSON.stringify(doc, null, indent) spells it inside the children array (without the leading indent), as UTF-8. */
function piece(board: unknown, indent: string): Buffer {
  if (!board || typeof board !== "object") return Buffer.from(pieceString(board, indent));
  const c = pieces.get(board);
  if (c && c.indent === indent) return c.buf;
  const buf = Buffer.from(pieceString(board, indent));
  pieces.set(board, { indent, buf });
  return buf;
}

/**
 * The bytes of JSON.stringify(doc, null, indent) + trailing, as a list of buffers, built from per-board pieces
 * (cached per board object, so a write converts only the boards an edit replaced). Calls `each` after every
 * piece so a caller can yield.
 */
export async function serializeDoc(doc: CanvasDoc, format: Pick<Format, "indent" | "trailing">, each?: () => void | Promise<void>): Promise<Buffer[]> {
  const ind = format.indent;
  const out: Buffer[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push(Buffer.from(text));
    text = "";
  };
  const entries: [string, string | null][] = [];
  for (const k of Object.keys(doc)) {
    if (k === "children") {
      entries.push([k, null]);
      continue;
    }
    const v = JSON.stringify((doc as Record<string, unknown>)[k], null, ind || undefined);
    if (v !== undefined) entries.push([k, ind ? v.replaceAll("\n", "\n" + ind) : v]);
  }
  text += "{";
  for (let i = 0; i < entries.length; i++) {
    const [k, v] = entries[i];
    text += ind ? `${i ? "," : ""}\n${ind}${JSON.stringify(k)}: ` : `${i ? "," : ""}${JSON.stringify(k)}:`;
    if (v !== null) {
      text += v;
      continue;
    }
    const kids = doc.children;
    if (!kids.length) {
      text += "[]";
      continue;
    }
    text += "[";
    for (let j = 0; j < kids.length; j++) {
      text += (j ? "," : "") + (ind ? "\n" + ind + ind : "");
      flush();
      out.push(piece(kids[j], ind));
      await each?.();
    }
    text += ind ? "\n" + ind + "]" : "]";
  }
  text += (ind && entries.length ? "\n}" : "}") + format.trailing;
  flush();
  return out;
}

// ---------------------------------------------------------------- writing

function kick(st: FileState): void {
  clearTimeout(st.writeTimer);
  st.writeTimer = undefined;
  if (st.writing || !host) return;
  st.writing = run(st).finally(() => {
    st.writing = undefined;
    land(st);
    // A retry already has its timer; after the last retry the next edit or flush tries again.
    if (st.dirty && !st.writeTimer && st.retries < writeConfig.maxRetries) scheduleWrite(st);
  });
}

/** Start a write once edits pause for debounceMs, or maxDelayMs after the first one it will carry. */
function scheduleWrite(st: FileState): void {
  if (st.writing) return; // the write in flight looks again when it ends
  const now = Date.now();
  const first = st.firstDirty || now;
  const due = Math.min((st.lastEdit || now) + writeConfig.debounceMs, first + writeConfig.maxDelayMs);
  clearTimeout(st.writeTimer);
  // Not unref'd: an edit waiting to be written keeps the process alive until it is.
  st.writeTimer = setTimeout(() => kick(st), Math.max(0, due - now));
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));
const tmpName = (docFile: string) => path.join(path.dirname(docFile), `.${path.basename(docFile)}.canvas-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);

/** inode:size:mtime:ctime of the file; null only when it does not exist. Any other error throws (the write retries). */
/**
 * The file's bytes (parsed) with the signature they were read under. The signature is read before and after the
 * read: a save in between (theirs replaced ours mid-read) makes them differ, and the file is read again. Null when
 * it never held still (or is gone).
 */
export async function readStable(docFile: string, tries = 4): Promise<{ loaded: LoadedDoc; sig: string } | null> {
  for (let i = 0; i < tries; i++) {
    const before = await statKey(docFile);
    if (!before) return null;
    const loaded = await loadDocAsync(docFile);
    await writerHooks.afterStableRead?.(docFile);
    const after = await statKey(docFile);
    if (after === before) return { loaded, sig: after };
  }
  return null;
}

async function statKey(docFile: string): Promise<string | null> {
  try {
    return keyOf(await fs.promises.stat(docFile));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** writev until every byte is written (a write may take fewer bytes than it was given). */
async function writeAll(fh: fs.promises.FileHandle, bufs: Buffer[]): Promise<void> {
  for (let i = 0; i < bufs.length; i += 512) {
    let batch = bufs.slice(i, i + 512);
    while (batch.length) {
      const total = batch.reduce((n, b) => n + b.length, 0);
      if (!total) break;
      const { bytesWritten } = await fh.writev(batch);
      if (bytesWritten >= total) break;
      if (!(bytesWritten > 0)) throw new Error(`a write made no progress (${total} bytes left)`);
      let skip = bytesWritten;
      const rest: Buffer[] = [];
      for (const b of batch) {
        if (skip >= b.length) skip -= b.length;
        else {
          rest.push(skip ? b.subarray(skip) : b);
          skip = 0;
        }
      }
      batch = rest;
    }
  }
}

/** writeSync until every byte is written; a write that takes nothing throws (never a short file). */
function writeAllSync(fd: number, buf: Buffer): void {
  for (let off = 0; off < buf.length; ) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`a write made no progress at byte ${off} of ${buf.length}`);
    off += n;
  }
}

/**
 * The sha256 of one buffer, computed on libuv's thread pool (WebCrypto's digest): the main thread does none of it.
 * A 30 MB document hashed in 4 ms slices on the main thread took 18 ms of it per hash, four hashes per save.
 */
async function digestHex(buf: Buffer): Promise<string> {
  return Buffer.from(await webcrypto.subtle.digest("SHA-256", buf)).toString("hex");
}

/** The sha256 of a file's bytes (read and hashed off the main thread). */
async function hashFile(file: string): Promise<string> {
  return digestHex(await fs.promises.readFile(file));
}

/**
 * Only the ctime of the document moved (signature `sig`, same inode, size and mtime), while a log with records applies
 * to it whose tie names another ctime: the file may have been put back in place to the log's base bytes (cp -p, a
 * backup tool). Then it is loaded again rather than taken as unchanged, and the load decides (a restore: the logged
 * edits go to a recovery copy, not on top). The snapshot cache asks the same (server.ts).
 */
export function restoreSuspected(docFile: string, sig: string): boolean {
  const st = states.get(docFile);
  const tie = st?.log?.info.records ? st.log.info.tie : undefined;
  const c = tieCtimeOf(tie);
  if (!st || c === undefined) return false;
  const [ino, , mtime, ctime] = sig.split(":");
  if (`${ino}:${mtime}` !== tie!.split(":").slice(0, 2).join(":")) return false;
  return ctime !== c && !st.ownCtimes?.has(ctime);
}

/** A whole write of ours linked the document and took the link away without replacing it: its ctime is ours. */
function ownCtime(st: FileState, base: string | undefined): void {
  if (!st.log || !base) return;
  try {
    const now = keyOf(fs.statSync(st.docFile));
    if (key3(now) === key3(base)) (st.ownCtimes ??= new Set()).add(now.split(":")[3]);
  } catch {}
}

/**
 * The disk shows `key` instead of what we noted (only the ctime moved: a tag, a chmod, or a write of ours whose
 * signature is not verified yet): are its bytes the ones we last wrote? The signature must hold still around the read.
 */
async function sameBytes(st: FileState, key: string): Promise<boolean> {
  if (!st.diskHash || !st.diskKey || key3(key) !== key3(st.diskKey)) return false;
  if (restoreSuspected(st.docFile, key)) return false;
  try {
    const h = await hashFile(st.docFile);
    return h === st.diskHash && (await statKey(st.docFile)) === key;
  } catch {
    return false;
  }
}

/**
 * Our temp file (inode:size:mtime `key`, bytes hashing to `hash`) now is the document, holding version `v`.
 * Synchronous. The full signature is not trusted yet (`key:?`): the next look at the disk checks the bytes once
 * (sameBytes), so an outside edit in the instant after the rename is never taken for ours.
 */
function settle(st: FileState, key: string, hash: string, v: number, keepJournal = false): void {
  st.diskKey = `${key}:?`;
  st.diskHash = hash;
  st.diskVersion = v;
  // Usage counts: one file.save per write that put a changed document on disk.
  if (v > st.saved) countUsage("file.save");
  st.saved = Math.max(st.saved, v);
  st.bytes = Number(key.split(":")[1]);
  st.pending = st.pending.filter((p) => p.version > v);
  st.writes++;
  st.retries = 0;
  st.lastError = undefined;
  st.compactDue = false;
  // The whole document is on disk: the save log it holds is done (run holds the lock when there is one). Only once
  // the rename is durable; until then the old bytes and their log may be what a crash leaves, and no append happens
  // (logEligible).
  if (!keepJournal) retireLog(st);
  if (!keepJournal) rewriteJournal(st, hash);
}

// ---------------------------------------------------------------- the save log (doc/doclog.ts)

// One owner per log: the server that created it (its header names it) is the only one that appends. Another server
// on the same file writes whole: under the lock it checks that the log is still what its state was loaded with
// (else it loads it first), writes the document with the log's edits in it, and retires the log. The owner learns
// it at its next look (the document changed and its log is gone: its edits are in those bytes). Someone who does not
// know the log (an older build, another app, a sync client) saves document.json whole without its edits: the owner finds
// its log stale and puts them back on top of that save, as it does with edits not saved yet.

function closeLog(st: FileState): void {
  const fh = st.log?.fh;
  if (!fh) return;
  st.log!.fh = undefined;
  void fh.close().catch(() => {});
}

/** The lock this write holds (taken once per run of the writer, let go when it ends). */
async function takeLock(st: FileState): Promise<void> {
  if (!st.unlock) st.unlock = await lockLog(st.docFile);
}
function dropLock(st: FileState): void {
  const u = st.unlock;
  st.unlock = undefined;
  u?.();
}

/** Load the document and its log as they are now (another Canvas changed the log): edits not saved replay on them. */
async function reloadNow(st: FileState): Promise<void> {
  const r = await readStable(st.docFile);
  if (!r || !host?.load) throw new Error(`${st.docFile} keeps changing on disk`);
  host.load(st.docFile, r.loaded, r.sig);
}

/**
 * After a whole write of ours landed (durably, under the lock): the log it holds goes (ours, or one this state was
 * loaded with); a log it does not hold (another live server's stale one, a newer build's) stays.
 */
function retireLog(st: FileState): void {
  closeLog(st);
  st.log = undefined;
  st.logged = [];
  if (st.logFold && st.logSeen !== "none") {
    try {
      removeLogSync(st.docFile);
      st.logSeen = "none";
    } catch (e) {
      console.error(`[canvas] removing the save log of ${st.docFile}: ${(e as Error).message}`);
    }
  }
  st.logFold = false;
}

/** Whether the next save of `st` may append to the log rather than write the whole document. */
function logEligible(st: FileState): boolean {
  if (!(st.bytes >= writeConfig.logMinBytes) || !Number.isFinite(st.bytes)) return false;
  if (!st.logDoc || st.compactDue || st.undurable || !st.diskHash || st.logUnknown) return false;
  if (!logLockable(st.docFile)) return false; // no flock on this volume: no log (doc/doclog.ts, the lock)
  if (st.log) {
    // Only our own log, for the bytes on disk, and not older than compactMaxMs (the window an older build or another app
    // reads document.json without it stays short even while edits never pause).
    if (st.log.info.base !== st.diskHash || st.log.info.owner !== OWNER || st.log.info.version !== LOG_VERSION || st.log.info.copy) return false;
    if (st.log.since !== undefined && Date.now() - st.log.since >= writeConfig.compactMaxMs) {
      st.compactDue = true;
      return false;
    }
  } else if (st.logSeen !== "none" && !st.logFold) return false; // someone else's log we do not hold: whole writes
  return true;
}

const logLimit = (st: FileState) => Math.max(writeConfig.logMaxBytes, st.bytes * writeConfig.logMaxShare);

/**
 * What a save appends: the top-level children of `next` that are not the very objects `prev` has (edits copy what
 * they change: cowDoc), the new order of ids when children were added, removed or moved, and every top-level key
 * when one other than children changed. Null when a log record cannot say it (a child without a unique string id).
 */
function logDiff(prev: CanvasDoc, next: CanvasDoc): { boards: DocNode[]; nodes: { p: string[]; v: DocNode }[]; ids?: string[]; top?: [string, unknown][] } | null {
  const pk = prev.children, nk = next.children;
  const ids: string[] = new Array(nk.length);
  const seen = new Set<string>();
  for (let i = 0; i < nk.length; i++) {
    const c = nk[i];
    if (!c || typeof c !== "object" || typeof c.id !== "string" || seen.has(c.id)) return null;
    seen.add(c.id);
    ids[i] = c.id;
  }
  let sameOrder = pk.length === nk.length;
  for (let i = 0; sameOrder && i < pk.length; i++) sameOrder = !!pk[i] && typeof pk[i] === "object" && pk[i].id === ids[i];
  let changed: DocNode[];
  if (sameOrder) changed = nk.filter((c, i) => c !== pk[i]);
  else {
    const had = new Set<unknown>(pk);
    changed = nk.filter((c) => !had.has(c));
  }
  // A changed board that was there before: only the layers that changed in it (a board of thousands of layers
  // was a megabyte appended for one property), unless it changed at its own level.
  const prevById = new Map<unknown, DocNode>();
  if (changed.length) for (const c of pk) if (c && typeof c === "object") prevById.set(c.id, c);
  const boards: DocNode[] = [];
  const nodes: { p: string[]; v: DocNode }[] = [];
  for (const c of changed) {
    const old = prevById.get(c.id);
    if (!old) {
      boards.push(c);
      continue;
    }
    const out: { p: string[]; v: DocNode }[] = [];
    nodeDiff(old, c, [c.id as string], out);
    if (out.some((e) => e.p.length === 1)) boards.push(c);
    else nodes.push(...out);
  }
  const pkeys = Object.keys(prev).filter((k) => (prev as Record<string, unknown>)[k] !== undefined);
  const nkeys = Object.keys(next).filter((k) => (next as Record<string, unknown>)[k] !== undefined);
  let topSame = pkeys.length === nkeys.length && pkeys.every((k, i) => k === nkeys[i]);
  for (const k of nkeys) {
    if (!topSame) break;
    if (k === "children") continue;
    const a = (prev as Record<string, unknown>)[k], b = (next as Record<string, unknown>)[k];
    topSame = a === b || same(a, b);
  }
  const top = topSame ? undefined : nkeys.map((k): [string, unknown] => [k, k === "children" ? null : (next as Record<string, unknown>)[k]]);
  return { boards, nodes, ...(sameOrder ? {} : { ids }), ...(top ? { top } : {}) };
}

/**
 * The topmost layers of `b` (a later version of `a`, sharing what it did not change) that differ from `a` in their
 * own properties or in which children they hold, each with its path of ids. Below a layer whose children line up
 * (the same ids, unique, in the same order) only the children that are other objects are looked at.
 */
function nodeDiff(a: DocNode, b: DocNode, path: string[], out: { p: string[]; v: DocNode }[]): void {
  if (a === b) return;
  const own = (n: DocNode) => Object.keys(n).filter((k) => k !== "children" && n[k] !== undefined);
  const ka = own(a), kb = own(b);
  const ownSame = ka.length === kb.length && kb.every((k, i) => k === ka[i] && (a[k] === b[k] || same(a[k], b[k])));
  const ac = a.children as DocNode[] | undefined, bc = b.children as DocNode[] | undefined;
  let aligned = ac === undefined && bc === undefined;
  if (Array.isArray(ac) && Array.isArray(bc) && ac.length === bc.length) {
    const ids = new Set<string>();
    aligned = bc.every((c, i) => !!c && typeof c === "object" && typeof c.id === "string" && !ids.has(c.id) && !!ids.add(c.id) && !!ac[i] && ac[i].id === c.id);
  }
  if (!ownSame || !aligned) {
    out.push({ p: path, v: b });
    return;
  }
  if (!bc) return;
  for (let i = 0; i < bc.length; i++) if (bc[i] !== ac![i]) nodeDiff(ac![i], bc[i], [...path, bc[i].id as string], out);
}

/** pwrite until every byte is written at `at`. */
async function writeAt(fh: fs.promises.FileHandle, buf: Buffer, at: number): Promise<void> {
  for (let off = 0; off < buf.length; ) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, at + off);
    if (!(bytesWritten > 0)) throw new Error(`a write made no progress at byte ${off} of ${buf.length}`);
    off += bytesWritten;
  }
}

/**
 * Save version `v` (the snapshot `snap`) by appending what changed since `st.logDoc` to the save log, durably.
 * "full": a whole write instead (not loggable, too big, or the log is not ours to append to); "retry": the disk
 * moved under it (the loop looks again); "reload": the log is not what this state was loaded with (the loop loads
 * it, under the lock); "done": saved.
 */
async function appendLog(st: FileState, snap: Snapshot, format: Format, v: number, epoch: number, base: string | undefined): Promise<"done" | "full" | "retry" | "reload"> {
  if (!logEligible(st)) return "full";
  const w0 = performance.now();
  const d = logDiff(st.logDoc!, snap.doc);
  if (!d) return "full";
  const pieces = d.boards.map((b) => piece(b, format.indent));
  const seq = (st.log?.info.seq ?? 0) + 1;
  const rec = encodeRecord(seq, pieces, d.ids, d.top, d.nodes);
  const size = st.log?.info.size ?? 0;
  // Past the log's share of the document, or a record that is most of a whole write anyway: write it whole.
  if (size + rec.bytes.length > logLimit(st) || rec.bytes.length > st.bytes * 0.3) return "full";
  const w1 = performance.now();
  // As before a rename: the checks of the last whole write first, then the disk must still be the bytes this save
  // is based on, nobody (an outside reload) having moved it meanwhile.
  if (st.checking) await st.checking;
  if (st.epoch !== epoch || (await statKey(st.docFile)) !== base || st.diskKey !== base) return "retry";
  // Under the lock no other Canvas appends to the log or folds it into a whole write: the document and the log must
  // both still be what this save is based on.
  await takeLock(st);
  if (st.epoch !== epoch || (await statKey(st.docFile)) !== base) return "retry";
  if ((await logSig(st.docFile)) !== st.logSeen) return "reload";
  const file = logPathOf(st.docFile);
  const docHash = st.diskHash!;
  const saving = st.pending.filter((p) => p.version <= v);
  let lg = st.log;
  let fresh: fs.promises.FileHandle | undefined;
  let info: LogInfo;
  // From the first byte written until the bookkeeping below, a load cannot tell whether this record counts: it waits
  // (ReloadLater). What a load that comes after a "retry" finds, the edits' seq says (reconcileLoad).
  st.renaming = true;
  try {
    if (!lg) {
      // A log with no header (a crash while it was made: nothing in it was answered) is replaced; any other was
      // ruled out above. Created exclusively: never over a log someone else just made.
      if (st.logSeen !== "none") await fs.promises.rm(file, { force: true });
      fresh = await fs.promises.open(file, "wx", format.mode || 0o644);
      // The tie: the document's inode:mtime, the log file's own inode (a copy of the package has another), and the
      // document's ctime (a restore in place can set the mtime back, never the ctime).
      const k = base!.split(":");
      const tie = `${k[0]}:${k[2]}:${(await fresh.stat()).ino}:${k[3]}`;
      const head = headerOf(docHash, tie, OWNER);
      for (const p of saving) p.seq = seq;
      await writeAt(fresh, Buffer.concat([head, rec.bytes]), 0);
      await fresh.sync();
      await syncDirAsync(path.dirname(file)); // the new name, before any edit in it counts as saved
      info = { base: docHash, size: head.length + rec.bytes.length, records: 1, seq, chain: chainOf(docHash, rec.hash), version: LOG_VERSION, owner: OWNER, tie };
    } else {
      if (!lg.fh) {
        try {
          lg.fh = await fs.promises.open(file, "r+");
        } catch {
          st.compactDue = true; // gone or unreadable: the whole document holds everything once written
          return "full";
        }
      }
      if (!lg.checked) {
        // The first append of this run to a log it loaded: the file must end where its last valid record does (a
        // longer one has a record cut by a crash): whole write instead.
        const now = await lg.fh.stat();
        if (now.size !== lg.info.size) {
          st.compactDue = true;
          return "full";
        }
        lg.checked = true;
      }
      for (const p of saving) p.seq = seq;
      await writeAt(lg.fh, rec.bytes, lg.info.size);
      await lg.fh.sync();
      info = { ...lg.info, size: lg.info.size + rec.bytes.length, records: lg.info.records + 1, seq, chain: chainOf(lg.info.chain, rec.hash) };
    }
    const w2 = performance.now();
    // Outside writers take no lock: the document must still be the bytes the log applies to. If it is not, the
    // record is in a log that no longer applies; the next load puts its edits on top of what is there.
    if ((await statKey(st.docFile)) !== base || st.epoch !== epoch) {
      await fresh?.close().catch(() => {});
      return "retry";
    }
    const ino = fresh ? (await fresh.stat()).ino : Number(st.logSeen.split(":")[0]);
    if (fresh) lg = st.log = { info, fh: fresh, checked: true, since: Date.now(), mine: true };
    else lg!.info = info;
    fresh = undefined;
    st.logSeen = `${ino}:${info.size}`;
    st.logFold = true;
    st.diskVersion = v;
    if (v > st.saved) countUsage("file.save"); // usage counts: the edits are on disk, in the save log
    st.saved = Math.max(st.saved, v);
    const savedEdits = st.pending.filter((p) => p.version <= v);
    st.pending = st.pending.filter((p) => p.version > v);
    st.logged.push(...savedEdits);
    st.writes++;
    st.retries = 0;
    st.lastError = undefined;
    st.logDoc = snap.doc;
    const j = st.journal;
    if (st.pending.length && savedEdits.length && j && !j.closed && !j.fdClosed && j.base === st.diskHash && !st.unrecovered.length && !st.undurable) {
      // Edits made while this one was written are still pending: the journal keeps them and says which of its lines
      // the log holds now ({saved}), made durable by the next edit's group commit. Rewriting it here (a temp file, two
      // fsyncs and a rename, on the main thread) held every request behind it. Lost in a crash, the line only means
      // the recovery copy applies those saved edits once more.
      try {
        writeAllSync(j.fd, Buffer.from(JSON.stringify({ saved: savedEdits.at(-1)!.edit }) + "\n"));
      } catch (e) {
        journalFailed(st, e as Error);
        rewriteJournal(st, st.diskHash);
      }
    } else rewriteJournal(st, st.diskHash);
    const r = (n: number) => Math.round(n * 10) / 10;
    st.lastWrite = { serialize: r(w1 - w0), write: r(w2 - w1), swap: 0, dirSync: 0, landed: r(performance.now() - w0), bytes: rec.bytes.length, appended: true };
    scheduleCompact(st);
    return "done";
  } catch (e) {
    await fresh?.close().catch(() => {});
    throw e;
  } finally {
    st.renaming = false;
  }
}

/** Fold the log into a whole write once edits pause, or once it is compactMaxMs old (older builds and other apps read document.json alone). */
function scheduleCompact(st: FileState): void {
  clearTimeout(st.compactTimer);
  if (!writeConfig.compactAfterMs) return;
  const now = Date.now();
  const due = Math.min(Math.max((st.lastEdit || now) + writeConfig.compactAfterMs, now), (st.log?.since ?? now) + writeConfig.compactMaxMs);
  st.compactTimer = setTimeout(() => {
    st.compactTimer = undefined;
    if (!st.log?.info.records || !host) return;
    const t = Date.now();
    const old = st.log.since !== undefined && t - st.log.since >= writeConfig.compactMaxMs;
    if (st.writing) {
      // The write in flight appends again (and schedules this) or writes whole (which retires the log).
      st.compactTimer = setTimeout(() => scheduleCompact(st), 50);
      st.compactTimer.unref();
      return;
    }
    if (t - st.lastEdit < writeConfig.compactAfterMs && !old) return scheduleCompact(st);
    st.compactDue = true;
    st.dirty = true;
    kick(st);
  }, Math.max(0, due - now));
  st.compactTimer.unref();
}

/**
 * Write the whole document of `docFile` (or every file) now if its save log holds records: Save As copies
 * document.json, and quitting leaves it current for builds that do not read the log. Rejects if it could not.
 */
export async function compactWrites(docFile?: string): Promise<void> {
  const list = docFile ? [states.get(docFile)].filter((s): s is FileState => !!s) : [...states.values()];
  for (const st of list) {
    // Moved or deleted, with every edit in its log: the log went along with the document (whoever opens it there
    // applies it); there is no document.json here to write it into.
    if (!st.pending.length && st.log && !fs.existsSync(st.docFile)) continue;
    for (let i = 0; i < 3 && st.log?.info.records && host; i++) {
      while (st.writing) await st.writing;
      if (!st.log?.info.records) break;
      st.compactDue = true;
      st.dirty = true;
      kick(st);
      while (st.writing) await st.writing;
    }
    if (st.log?.info.records) throw new Error(`${st.docFile} could not be written whole (${st.lastError ?? "its save log is kept"})`);
  }
}

/** The promise the write in flight resolves once its bytes are in place (made on first ask). */
function landedOf(st: FileState): { promise: Promise<void>; resolve: () => void } {
  if (!st.landed) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    st.landed = { promise, resolve };
  }
  return st.landed;
}
function land(st: FileState): void {
  const l = st.landed;
  st.landed = undefined;
  l?.resolve();
}

/**
 * Check the bytes of a write just made and, when they are ours, trust its full signature (no hash next time). In
 * two parts: the stat, read and hash start at once (done), and apply() trusts the full signature only if the
 * write's key and hash are still what they were when it started.
 */
function confirmLater(st: FileState): { done: Promise<string | null>; apply: () => Promise<void> } {
  const k = st.diskKey, h0 = st.diskHash;
  const done = (async () => {
    if (!k?.endsWith(":?") || !h0) return null;
    const sig = await statKey(st.docFile).catch(() => null);
    if (!sig || key3(sig) !== key3(k)) return null;
    const h = await hashFile(st.docFile).catch(() => "");
    if (h !== h0) return null;
    return (await statKey(st.docFile).catch(() => null)) === sig ? sig : null;
  })();
  const apply = async () => {
    const sig = await done;
    if (sig && st.diskKey === k && st.diskHash === h0) {
      st.diskKey = sig;
      host?.confirmOwn?.(st.docFile, sig);
    }
  };
  return { done, apply };
}

/**
 * The copy a write keeps of the bytes it replaces. Its name carries the start of their hash (the bytes the write was
 * based on), so after a crash a copy that still holds exactly those bytes is known as the dead server's own
 * (cleanStaleTemps), not as someone's save.
 */
const prevName = (tmp: string, base: string | undefined) => tmp.replace(/\.tmp$/, base && /^[0-9a-f]{16}/.test(base) ? `-${base.slice(0, 16)}-prev.tmp` : "-prev.tmp");
const prevBase = (name: string) => name.match(/-([0-9a-f]{16})-prev\.tmp$/)?.[1];
const NO_LINK = new Set(["EPERM", "ENOTSUP", "EXDEV", "EMLINK", "ENOSYS", "EOPNOTSUPP"]);

/**
 * Keep the bytes now at `docFile` at `prev` until our rename is done: a hard link (the very inode, so an edit made to it
 * up to the rename still shows), or where the volume has no links, a copy checked against the bytes the write was
 * based on. Throws when neither works: the write must not go ahead unprotected.
 */
const warnedNoLinks = new Set<string>();
/** The volume cannot hard-link: a save someone makes at the very moment of ours cannot be kept. Said once per file. */
function warnNoLinks(docFile: string): void {
  if (warnedNoLinks.has(docFile)) return;
  warnedNoLinks.add(docFile);
  report(docFile, `The volume holding ${path.basename(docFile)} does not support hard links: Canvas cannot keep a save another app makes at the very same moment as one of Canvas's. Keep design files on the Mac's own disk to be safe.`);
}

async function preserve(docFile: string, prev: string, baseHash: string | undefined): Promise<"link" | "copy"> {
  try {
    await fs.promises.link(docFile, prev);
    return "link";
  } catch (e) {
    if (!NO_LINK.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
  warnNoLinks(docFile);
  await fs.promises.copyFile(docFile, prev, fs.constants.COPYFILE_FICLONE);
  if (baseHash && (await hashFile(prev)) !== baseHash) {
    await fs.promises.rm(prev, { force: true });
    throw new Error(`${docFile} changed on disk while it was written`);
  }
  return "copy";
}
function preserveSync(docFile: string, prev: string, baseHash: string | undefined): "link" | "copy" {
  try {
    fs.linkSync(docFile, prev);
    return "link";
  } catch (e) {
    if (!NO_LINK.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
  warnNoLinks(docFile);
  fs.copyFileSync(docFile, prev, fs.constants.COPYFILE_FICLONE);
  if (baseHash && sha256(fs.readFileSync(prev)) !== baseHash) {
    fs.rmSync(prev, { force: true });
    throw new Error(`${docFile} changed on disk while it was written`);
  }
  return "copy";
}

/**
 * The replaced bytes matched what the write was based on. Someone may still hold the old file open and write to it
 * a moment later (their write would go nowhere once the last name is gone), so the copy stays a little longer and
 * is checked again before it goes; quitting checks whatever is left (finishWrites).
 */
const PREV_GRACE_MS = 2000;
const lingering = new Map<string, { st: FileState; base?: string; size: number; mtime: number; timer: NodeJS.Timeout }>();
function laterRemove(st: FileState, prev: string, base: string | undefined): void {
  let size = -1, mtime = -1;
  try {
    const s0 = fs.statSync(prev);
    size = s0.size;
    mtime = s0.mtimeMs;
  } catch {}
  const timer = setTimeout(() => void settlePrevAsync(prev), PREV_GRACE_MS);
  timer.unref();
  lingering.set(prev, { st, base, size, mtime, timer });
}
/** Look at a lingering copy once more: unchanged, it goes; changed or unreadable, it is kept as a conflict copy. */
function settlePrev(prev: string): void {
  const l = lingering.get(prev);
  if (!l) return;
  clearTimeout(l.timer);
  lingering.delete(prev);
  let same = false;
  try {
    const s1 = fs.statSync(prev);
    same = s1.size === l.size && s1.mtimeMs === l.mtime && (!l.base || sha256(fs.readFileSync(prev)) === l.base);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  if (same) {
    try {
      fs.rmSync(prev, { force: true });
    } catch {}
  } else keepConflict(l.st, prev);
}
/**
 * settlePrev off the main thread's critical path: the hash of an 18 MB file read and hashed synchronously held every
 * request behind it for about 25 ms, two seconds after each write. The file is read and hashed in slices, and its
 * signature must hold still around the read. Quitting still settles synchronously (settleLingering).
 */
async function settlePrevAsync(prev: string): Promise<void> {
  const l = lingering.get(prev);
  if (!l) return;
  clearTimeout(l.timer);
  lingering.delete(prev);
  const unchanged = async () => {
    const s1 = await fs.promises.stat(prev);
    return s1.size === l.size && s1.mtimeMs === l.mtime;
  };
  let same = false;
  try {
    same = (await unchanged()) && (!l.base || (await hashFile(prev)) === l.base) && (await unchanged());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  if (same) {
    try {
      fs.rmSync(prev, { force: true });
    } catch {}
  } else keepConflict(l.st, prev);
}
/** Settle every lingering copy now (quit). */
export function settleLingering(): void {
  for (const prev of [...lingering.keys()]) settlePrev(prev);
}

/** Bytes someone else saved that a write of ours replaced: kept next to the document and reported. */
function keepConflict(st: FileState, prev: string): string {
  let keep = prev;
  try {
    keep = moveExclusive(prev, `${st.docFile}.conflict-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  } catch {}
  report(st.docFile, `Someone saved ${path.basename(st.docFile)} at the same moment as Canvas; their save is kept as ${keep}.`);
  return keep;
}

/**
 * Someone saved the document in the instant between our last check and our rename, and the rename replaced it.
 * Their bytes are not lost: the hard link taken before the rename kept them. They are loaded as an outside change
 * (every edit not yet on disk, the ones this write carried included, replays on them and is written next), a copy
 * stays next to the file, and it is reported.
 */
function displaced(st: FileState, prev: string, key: string, hash: string, written: Pending[]): boolean {
  let keep = prev;
  try {
    keep = moveExclusive(prev, `${st.docFile}.conflict-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  } catch {}
  let sig: string | undefined;
  try {
    sig = keyOf(fs.statSync(st.docFile));
  } catch {}
  let merged = false;
  try {
    const raw = fs.readFileSync(keep, "utf8");
    const doc = JSON.parse(raw) as CanvasDoc;
    if (!doc || !Array.isArray(doc.children)) throw new Error("not a Canvas document");
    const m = raw.match(/^\{\r?\n([ \t]+)"/);
    const ks = fs.statSync(keep);
    const l: LoadedDoc = { path: st.docFile, raw, hash: sha(raw), mtimeMs: ks.mtimeMs, size: ks.size, mode: ks.mode & 0o777, indent: m ? m[1] : raw.startsWith("{\n") ? "  " : "", trailing: raw.slice(raw.trimEnd().length), doc };
    if (host?.load && sig && key3(sig) === key) {
      st.diskHash = hash;
      // Their bytes lack the edits this write carried: those replay on them too, before the newer ones.
      st.pending = [...written, ...st.pending];
      host.load(st.docFile, l, sig);
      st.diskHash = hash; // the disk holds our bytes; memory holds theirs with our edits on top, written next
      st.logDoc = undefined; // and the next write is whole
      st.logSeen = logSigSync(st.docFile); // a log left there is not one this state holds: kept, and saves are whole
      st.logFold = false;
      st.diskKey = `${key}:?`;
      merged = true;
    }
  } catch (e) {
    console.error(`[canvas] could not read the save that crossed ours: ${(e as Error).message}`);
  }
  report(st.docFile, `Someone saved ${path.basename(st.docFile)} at the same moment as Canvas. ${merged ? "Canvas took their version and applied its own edits on top." : "Canvas kept its own version."} Their save is kept as ${keep}.`);
  return merged;
}

async function run(st: FileState): Promise<void> {
  try {
    await runWrites(st);
  } finally {
    dropLock(st);
  }
}

async function runWrites(st: FileState): Promise<void> {
  const docFile = st.docFile;
  let looks = 0;
  while (st.dirty && host) {
    st.dirty = false;
    st.firstDirty = 0; // edits from here on wait for the next write
    try {
      // Someone else changed the file: load their bytes first (reconcileLoad replays what is not on disk yet).
      const before = await statKey(docFile);
      if (before === null) {
        // Missing: moved or deleted with nothing left to save but compaction (the log went with the document): there
        // is nothing to fold it into here.
        if (!st.pending.length && st.saved >= st.version && !st.unrecovered.length) {
          st.compactDue = false;
          return;
        }
        // Edits not saved: they stay in memory (and the journal); the retries look again.
        throw new Error(`${docFile} is missing`);
      }
      if (before !== st.diskKey) {
        const e0 = st.epoch;
        if ((await sameBytes(st, before)) && st.epoch === e0) st.diskKey = before;
        else {
          if (++looks > 5) throw new Error(`${docFile} keeps changing on disk`);
          st.dirty = true;
          await host.ensure(docFile);
          // Another Canvas holds the save log's lock that the load needs: wait for it (not a look of its own).
          if (st.loadLockWait && !st.unlock) {
            await st.loadLockWait;
            looks--;
          }
          continue;
        }
      }
      const snap = host.peek(docFile);
      if (!snap) return;
      // Everything this write is based on, fixed now: the version, the bytes it replaces, and its epoch.
      const v = st.version, epoch = st.epoch, loads = st.loads, base = st.diskKey;
      const format = snap.format ?? DEFAULT_FORMAT;
      // A big document saves by appending what changed to its save log, durably; the whole file is written when
      // the log cannot say it, grew too long, or edits paused (compaction).
      const logged = await appendLog(st, snap, format, v, epoch, base);
      if (logged === "reload") {
        // The save log is not what this state was loaded with (another Canvas appended to it, or folded it): load it
        // now, still under the lock, and write again on top of it.
        await reloadNow(st);
        st.dirty = true;
        if (++looks > 5) throw new Error(`${docFile} keeps changing on disk`);
        continue;
      }
      if (logged === "retry") {
        st.dirty = true;
        if (++looks > 5) throw new Error(`${docFile} keeps changing on disk`);
        continue;
      }
      if (logged === "done") {
        land(st);
        if (st.version !== v) {
          st.dirty = true;
          return; // newer edits: kick's finally schedules their write (debounced), or a flush starts it now
        }
        continue;
      }
      // A whole write while a save log is there: the log must be what this state was loaded with (another Canvas may
      // have appended to it), so this write holds every edit in it before it retires it. Loaded first, under the lock.
      if ((await logSig(docFile)) !== st.logSeen) {
        await takeLock(st);
        if ((await logSig(docFile)) !== st.logSeen) {
          await reloadNow(st);
          st.dirty = true;
          if (++looks > 5) throw new Error(`${docFile} keeps changing on disk`);
          continue;
        }
      }
      let t0 = performance.now();
      const w0 = t0;
      const chunks = await serializeDoc(snap.doc, format, async () => {
        if (performance.now() - t0 > writeConfig.sliceMs) {
          await yieldNow();
          t0 = performance.now();
        }
      });
      // One buffer: hashed on the thread pool while the same bytes are written and fsynced (both off the main
      // thread), so a save costs the longer of the two instead of their sum.
      const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      const w1 = performance.now();
      const hashing = digestHex(bytes);
      hashing.catch(() => {}); // awaited below; a write that fails first must not leave it unhandled
      void backupIfDue(st); // its read starts from the bytes on disk now and goes on beside the write
      const tmp = tmpName(docFile);
      const fh = await fs.promises.open(tmp, "wx", format.mode || 0o644);
      let key: string;
      try {
        await writeAll(fh, [bytes]);
        await fh.sync();
        await fh.chmod(format.mode || 0o644);
        key = key3(keyOf(await fh.stat()));
      } catch (e) {
        await fh.close().catch(() => {});
        await fs.promises.rm(tmp, { force: true });
        throw e;
      }
      await fh.close();
      const hash = await hashing;
      const w2 = performance.now();
      // The checks after the write before this one finish first: what they find (someone's save crossed it, the
      // bytes on disk are not what it wrote) changes what this write may replace.
      if (st.checking) await st.checking;
      // The swap and the log's retirement happen under the lock, so no Canvas appends to the log or folds it in between.
      // Always, not only when this state saw a log: another Canvas may have made one since and be folding it right now
      // (between its last look at the disk and its rename); a rename of ours in there would be lost under its.
      if (!st.unlock) await takeLock(st);
      // Last look before the swap: the disk must still be the bytes this write was based on, and nobody (an outside
      // reload) invalidated it meanwhile.
      const now = await statKey(docFile);
      if (st.epoch !== epoch || now !== base || st.diskKey !== base) {
        await fs.promises.rm(tmp, { force: true });
        st.dirty = true;
        if (++looks > 5) throw new Error(`${docFile} keeps changing on disk`);
        continue;
      }
      if (st.unlock && (await logSig(docFile)) !== st.logSeen) {
        // The log moved since the look before serializing: load it (under the lock) and write again.
        await fs.promises.rm(tmp, { force: true });
        await reloadNow(st);
        st.dirty = true;
        if (++looks > 5) throw new Error(`${docFile} keeps changing on disk`);
        continue;
      }
      // Keep the bytes being replaced until the rename is done (a hard link; a checked clone where links are not
      // possible). Without that, the write does not happen.
      const baseHash = st.diskHash;
      const prev = prevName(tmp, baseHash);
      let kind: "link" | "copy";
      try {
        kind = await preserve(docFile, prev, baseHash);
      } catch (e) {
        await fs.promises.rm(tmp, { force: true });
        throw e;
      }
      if (st.epoch !== epoch || (kind === "link" && key3(keyOf(await fs.promises.stat(prev))) !== key3(base!))) {
        await fs.promises.rm(prev, { force: true });
        await fs.promises.rm(tmp, { force: true });
        if (kind === "link") ownCtime(st, base);
        st.dirty = true;
        if (++looks > 5) throw new Error(`${docFile} keeps changing on disk`);
        continue;
      }
      host.markOwn(docFile, key, hash);
      st.renaming = true;
      try {
        await fs.promises.rename(tmp, docFile);
      } catch (e) {
        st.renaming = false;
        host.markOwn(docFile, null);
        await fs.promises.rm(tmp, { force: true });
        await fs.promises.rm(prev, { force: true });
        if (kind === "link") ownCtime(st, base);
        throw e;
      }
      // The written file's full signature (the ctime the rename gave it), read at once.
      let sigNow: string | null = null;
      try {
        sigNow = keyOf(fs.statSync(docFile));
      } catch {}
      // The rename is done: the bookkeeping follows at once (synchronously), so no load from here on can replay
      // an edit these bytes already hold.
      // The folder's fsync runs off the main thread; st.renaming holds loads back until the bookkeeping below is done.
      let durable = true;
      let dirError: Error | undefined;
      const w3 = performance.now();
      await syncDirAsync(path.dirname(docFile)).catch((e) => void (dirError = e as Error));
      const w4 = performance.now();
      // The edits this write holds: those not saved yet, and those only in the save log it folds.
      const written = [...st.logged, ...st.pending.filter((p) => p.version <= v)];
      try {
        if (dirError) throw dirError;
      } catch (e) {
        durable = false;
        st.undurable = true;
        st.dropped.push(`${path.basename(docFile)} was written but its folder could not be synced (${(e as Error).message}); the crash journal is kept`);
        report(docFile, st.dropped.at(-1)!);
      }
      if (durable && st.undurable) {
        st.undurable = false;
        dropKeptJournals(st);
      }
      settle(st, key, hash, v, !durable); // the journal is retired only once the rename is durable
      st.logDoc = snap.doc; // what the next append is the difference from
      st.renaming = false;
      land(st);
      const r = (n: number) => Math.round(n * 10) / 10;
      st.lastWrite = { serialize: r(w1 - w0), write: r(w2 - w1), swap: r(w3 - w2), dirSync: r(w4 - w3), landed: r(performance.now() - w0), bytes: bytes.length };
      // That signature is trusted at once, so the next write does not hash the file before it starts. The checks run
      // beside the next write (which waits for them before its own rename): were the replaced bytes the ones this
      // write was based on, and are the written ones what it wrote (hashed; a mismatch takes the trust back and
      // the file is read again as someone else's).
      const trusted = sigNow && key3(sigNow) === key && st.diskKey === `${key}:?` ? sigNow : null;
      if (trusted) {
        st.diskKey = trusted;
        host.confirmOwn?.(docFile, trusted);
      }
      const confirming = trusted ? null : confirmLater(st);
      const checks = (async () => {
        // Were the bytes we replaced the ones this write was based on? Hashed: an edit in place that kept the size
        // and the mtime shows too. Unreadable means unknown, never the same: the copy is kept.
        let check: "same" | "crossed" | "unknown" = "same";
        if (kind === "link") {
          try {
            check = key3(keyOf(fs.statSync(prev))) !== key3(base!) || (!!baseHash && (await hashFile(prev)) !== baseHash) ? "crossed" : "same";
          } catch {
            check = "unknown";
          }
        }
        let crossed = false;
        if (check === "same") laterRemove(st, prev, baseHash);
        else if (check === "unknown" || st.loads !== loads) keepConflict(st, prev); // a load since holds our bytes or later
        else crossed = displaced(st, prev, key, hash, written);
        if (crossed) {
          await confirming?.done;
          // Their bytes and our edits on top are in memory now: written next.
          st.dirty = true;
          if (!st.writing && !st.writeTimer) scheduleWrite(st);
        } else if (confirming) await confirming.apply();
        else if (trusted) {
          const h = await hashFile(docFile).catch(() => "");
          const still = await statKey(docFile).catch(() => null);
          if ((h !== hash || still !== trusted) && st.diskKey === trusted) {
            // Not what we wrote after all (someone wrote in the instant after the rename): their bytes are loaded as
            // an outside change (edits not on disk replay on them). The watcher was told the signature was ours, so
            // it would not read them again on its own.
            st.diskKey = `${key}:?`;
            try {
              const r = await readStable(docFile);
              if (host?.load && r && st.diskKey === `${key}:?`) host.load(docFile, r.loaded, r.sig);
              else void host?.ensure(docFile).catch(() => {});
            } catch {
              void host?.ensure(docFile).catch(() => {});
            }
          }
        }
        if (st.lastWrite) st.lastWrite.checks = Math.round((performance.now() - w0 - st.lastWrite.landed) * 10) / 10;
      })()
        .catch((e) => console.error(`[canvas] checking the write of ${docFile}: ${(e as Error).message}`))
        .finally(() => {
          if (st.checking === checks) st.checking = undefined;
        });
      st.checking = checks;
      if (st.version !== v) {
        st.dirty = true;
        return; // newer edits: kick's finally schedules their write (debounced), or a flush starts it now
      }
    } catch (e) {
      st.retries++;
      st.dirty = true; // still not on disk: flushWrites keeps waiting (and rejects once the retries are spent)
      st.lastError = (e as Error).message;
      console.error(`[canvas] writing ${docFile} failed (attempt ${st.retries}): ${st.lastError}`);
      if (st.retries < writeConfig.maxRetries) {
        clearTimeout(st.writeTimer);
        st.writeTimer = setTimeout(() => kick(st), 100 * 2 ** st.retries);
      } else report(docFile, `Canvas could not save ${path.basename(docFile)} (${st.lastError}); ${st.pending.length} edit(s) are only in memory. The next edit tries again.`);
      return;
    }
  }
}

/** A small document: written now, the way store.ts saveDoc does, all synchronous. False when the async path must take it. */
function writeSmall(st: FileState, format: Format, buf: Buffer, hash: string): boolean {
  if (st.log || st.logged.length || st.logSeen !== "none") return false; // a save log in play: the background path, under its lock
  // The lock, as every whole write takes it (runWrites): another Canvas may have made a log since this state looked and
  // be folding it. One try; when someone holds it, or a log is there now, the background path takes the write.
  let unlock: (() => void) | null;
  try {
    unlock = tryLockLog(st.docFile);
  } catch {
    return false;
  }
  if (!unlock) return false;
  try {
    if (logSigSync(st.docFile) !== "none") return false;
    return writeSmallLocked(st, format, buf, hash);
  } finally {
    unlock();
  }
}

function writeSmallLocked(st: FileState, format: Format, buf: Buffer, hash: string): boolean {
  const docFile = st.docFile;
  let base: string | null;
  try {
    base = keyOf(fs.statSync(docFile));
  } catch {
    base = null;
  }
  if (base === null || !st.diskKey) return false;
  // The disk must be the bytes memory was based on: the signature we noted, or (not verified yet) the same bytes.
  if (base !== st.diskKey) {
    if (key3(base) !== key3(st.diskKey) || !st.diskHash) return false;
    try {
      if (sha256(fs.readFileSync(docFile)) !== st.diskHash) return false;
    } catch {
      return false;
    }
  }
  let tmp: string | undefined, prev: string | undefined;
  try {
    if (Date.now() - st.lastBackup >= writeConfig.backupEveryMs) {
      st.lastBackup = Date.now();
      writeBackup(docFile, st.diskHash, fs.readFileSync(docFile), (raw) => zlib.gzipSync(raw, { level: 1 }));
    }
    tmp = tmpName(docFile);
    const fd = fs.openSync(tmp, "wx", format.mode || 0o644);
    let key: string;
    try {
      writeAllSync(fd, buf);
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, format.mode || 0o644);
      key = key3(keyOf(fs.fstatSync(fd)));
    } finally {
      fs.closeSync(fd);
    }
    // The same last look and the same keeping of the replaced bytes as the background write.
    if (keyOf(fs.statSync(docFile)) !== base) throw new Error("it changed on disk while it was written");
    const kind = preserveSync(docFile, prevName(tmp, st.diskHash), st.diskHash);
    prev = prevName(tmp, st.diskHash);
    if (kind === "link" && key3(keyOf(fs.statSync(prev))) !== key3(base)) throw new Error("it changed on disk while it was written");
    host!.markOwn(docFile, key, hash);
    try {
      fs.renameSync(tmp, docFile);
    } catch (e) {
      host!.markOwn(docFile, null);
      throw e;
    }
    tmp = undefined;
    const baseHash = st.diskHash;
    const written = st.pending.slice();
    let durable = true;
    try {
      syncDir(path.dirname(docFile));
    } catch (e) {
      durable = false;
      st.undurable = true;
      st.dropped.push(`${path.basename(docFile)} was written but its folder could not be synced (${(e as Error).message}); the crash journal is kept`);
      report(docFile, st.dropped.at(-1)!);
    }
    if (durable && st.undurable) {
      st.undurable = false;
      dropKeptJournals(st);
    }
    settle(st, key, hash, st.version, !durable);
    let check: "same" | "crossed" | "unknown" = "same";
    if (kind === "link") {
      try {
        check = key3(keyOf(fs.statSync(prev))) !== key3(base) || (!!baseHash && sha256(fs.readFileSync(prev)) !== baseHash) ? "crossed" : "same";
      } catch {
        check = "unknown";
      }
    }
    const p0 = prev;
    prev = undefined;
    if (check === "same") laterRemove(st, p0, baseHash);
    else if (check === "unknown") keepConflict(st, p0);
    else if (displaced(st, p0, key, hash, written)) return false; // merged: the merged state is written by the background path
    return true;
  } catch (e) {
    for (const f of [tmp, prev]) {
      if (!f) continue;
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
    console.error(`[canvas] writing ${docFile} failed: ${(e as Error).message}`);
    return false;
  }
}

const KEEP_BACKUPS = 10;
function writeBackup(docFile: string, hash: string | undefined, raw: Buffer, gz: (b: Buffer) => Buffer): void {
  const dir = backupDirFor(docFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(dir, `${stamp}-${revisionOf(hash ?? sha(raw.toString("utf8")))}.json.gz`), gz(raw), { mode: 0o600 });
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, old), { force: true });
}

/** The bytes about to be replaced, gzipped next to docfile.ts's backups; at most once per backupEveryMs. Reading and gzip run off the main thread. */
async function backupIfDue(st: FileState): Promise<void> {
  if (Date.now() - st.lastBackup < writeConfig.backupEveryMs) return;
  st.lastBackup = Date.now();
  // Opened now, before this write renames anything: the read goes on from this inode, the bytes being replaced,
  // whenever the rename lands. So the write does not wait for the read and the gzip (on a 30 MB file, the slowest
  // save of every minute).
  let fd: number;
  try {
    fd = fs.openSync(st.docFile, "r");
  } catch (e) {
    console.error(`[canvas] backup of ${st.docFile} failed: ${(e as Error).message}`);
    return;
  }
  const rev = revisionOf(st.diskHash ?? "unknown00000");
  try {
    const raw = await new Promise<Buffer>((res, rej) => fs.readFile(fd, (e, b) => (e ? rej(e) : res(b))));
    const gz = await promisify(zlib.gzip)(raw, { level: 1 });
    const dir = backupDirFor(st.docFile);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.promises.writeFile(path.join(dir, `${stamp}-${rev}.json.gz`), gz, { mode: 0o600 });
    const all = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".json.gz")).sort();
    await Promise.all(all.slice(0, Math.max(0, all.length - KEEP_BACKUPS)).map((f) => fs.promises.rm(path.join(dir, f), { force: true })));
  } catch (e) {
    console.error(`[canvas] backup of ${st.docFile} failed: ${(e as Error).message}`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

// ---------------------------------------------------------------- safety net

function scheduleVerify(st: FileState): void {
  if (!writeConfig.verifyAfterMs) return;
  clearTimeout(st.verifyTimer);
  st.verifyTimer = setTimeout(() => void verify(st).catch((e) => console.error(`[canvas] verify ${st.docFile}: ${(e as Error).message}`)), writeConfig.verifyAfterMs);
  st.verifyTimer.unref();
}

/**
 * Every board's cached facts (serialized piece, change key, usage) belong to the board object as it is now.
 * A change that edited a board it did not name in `touches` would leave them stale: that board is forgotten,
 * the snapshot rebuilt and the file written again. Runs in slices once writes settle. Returns the boards it fixed.
 */
export async function verify(st: FileState | string): Promise<number> {
  const s = typeof st === "string" ? states.get(st) : st;
  if (!s || !host) return 0;
  if (s.writing || s.dirty) {
    scheduleVerify(s);
    return 0;
  }
  const snap = host.peek(s.docFile);
  if (!snap) return 0;
  const ind = (snap.format ?? DEFAULT_FORMAT).indent;
  let bad = 0;
  let t0 = performance.now();
  for (const b of snap.doc.children) {
    if (!b || typeof b !== "object") continue;
    const c = pieces.get(b);
    let stale = boardDigestStale(b);
    if (!stale && c && c.indent === ind) stale = !c.buf.equals(Buffer.from(pieceString(b, ind)));
    if (stale) {
      bad++;
      forgetBoard(b);
    }
    if (performance.now() - t0 > writeConfig.sliceMs) {
      await yieldNow();
      if (host.peek(s.docFile) !== snap) return 0; // an edit came in: the next settle checks again
      t0 = performance.now();
    }
  }
  if (!bad) return 0;
  console.error(`[canvas] ${bad} board(s) of ${s.docFile} changed without being copied first; rewriting them`);
  s.compactDue = true; // the same objects as on disk, so an append would not see them: the whole document
  s.version++;
  s.pending.push({ version: s.version, edit: token(), change: () => undefined, touches: [] });
  host.adopt(s.docFile, snapshotOfDoc(s.docFile, { ...snap.doc, children: snap.doc.children.slice() } as CanvasDoc, token(), snap.format));
  s.dirty = true;
  kick(s);
  return bad;
}
