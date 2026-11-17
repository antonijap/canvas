// The save log: what changed since document.json was last written whole, appended next to it.
//
// A save of a big document used to rewrite the whole file (18 to 77 MB: serialize, write, fsync, rename). Now a
// save appends the layers that changed (or whole boards) to a log beside the document, and fsyncs that; the whole file is
// written again only when the log grows past a share of the document, after the edits pause (compaction), and when
// Canvas quits. document.json stays a complete, plain document at all times: a build that does not know the log
// reads the file as of its last whole write (seconds old while Canvas runs, current after a clean quit).
//
// File: `.<document>.canvas-log` in the document's folder (inside a .canvas package: `.document.json.canvas-log`).
//
//   CANVASLOG 2 <sha256 of the document.json bytes the log applies to> <tie> <owner>\n
//   then records, each:  R <payload bytes> <sha256 of the payload>\n<payload>\n
//
//   tie    inode:mtime of that very document.json: the same bytes put back later (an older build's undo, a git
//          checkout, a sync client) are another file, and the log does not apply to them. Then :inode of the log
//          file itself (logs made since the second review): a log whose own inode is not that one was copied with
//          its package (Finder Duplicate, cp -R, a backup put back), and applies to the copy's document when that
//          holds the bytes it was written for (the copy holds the same edits as the original);
//   owner  pid.session.start of the Canvas server that appends to it. Only the owner appends; any other Canvas
//          server writes the document whole, with the log's edits in it, and then retires the log. Appends and
//          those whole writes hold the lock file `.<document>.canvas-lock` (flock), so they never interleave.
//
// Version 1 logs (no tie, no owner) still apply when their base matches; a log of any other version is left alone.
//
// A payload is JSON: {"s": seq, "b": [board, ...], "n"?: [{"p": [id, ...], "v": node}, ...], "ids"?: [id, ...],
// "top"?: [[key, value | null], ...]}
//   b     top-level children (boards) whose content changed, whole, replacing the child with the same id;
//   n     a layer deeper in a board, whole, replacing the one at path p (ids from the board down, each unique among
//         its siblings): what changed in a board of thousands of layers, without the rest of it;
//   ids   the new order of the top-level children by id, when boards were added, removed or reordered (a child not
//         in `b` keeps the object it had);
//   top   every top-level key of the document in order, with its value (null for "children", which the record
//         carries as above), when any key other than children changed.
//
// Reading: the log applies only when its header names the document's own bytes and file (any other save of
// document.json, by an older build or another app, makes the log stale: its owner puts its edits back on top
// of that save; a stale log whose owner is gone is kept as a recovery copy). Records apply in order up to the
// first one that is cut short or does not match its hash (a crash in the middle of an append): everything before
// it was fsynced before its save answered. The state's revision is a hash chained over the records, so the same
// bytes on disk always give the same revision.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CanvasDoc } from "./docfile.ts";
import type { DocNode } from "./schema.ts";

export const LOG_VERSION = 2;
const HEAD = "CANVASLOG";

export const logPathOf = (docFile: string) => path.join(path.dirname(docFile), `.${path.basename(docFile)}.canvas-log`);
export const lockPathOf = (docFile: string) => path.join(path.dirname(docFile), `.${path.basename(docFile)}.canvas-lock`);
/** The tie of a document file: inode, mtime and ctime, as fs.stat gives them. */
export const tieOf = (st: { ino: number; mtimeMs: number; ctimeMs: number }) => `${st.ino}:${st.mtimeMs}:${st.ctimeMs}`;
/** The document part of a header's tie (inode:mtime), without the log's own inode. */
const docTie = (t: string | undefined) => t?.split(":").slice(0, 2).join(":");
/** The inode a header says its log file has (undefined: a log made before that was written). */
const logInoOf = (t: string | undefined) => t?.split(":")[2];
/** The document's ctime a header's tie names (undefined: a log made before the ctime was in it). */
export const tieCtimeOf = (t: string | undefined) => t?.split(":")[3];
/**
 * Whether a header's tie names the document file whose tie (tieOf) is `now`: the same inode and mtime, and the same
 * ctime when the header has one. A write in place that sets the mtime back (cp -p, a backup tool restoring a file)
 * still moves the ctime, which nothing can set back.
 */
function tieMatches(head: string | undefined, now: string): boolean {
  const [ino, mtime, ctime] = now.split(":");
  if (docTie(head) !== `${ino}:${mtime}`) return false;
  const c = tieCtimeOf(head);
  return c === undefined || ctime === undefined || c === ctime;
}
/**
 * The document was put back in place to the very bytes the log applies to (same inode, same mtime, only the ctime
 * moved): a restore (cp -p, a backup tool), or someone touched only its attributes. The log's edits are not put on top.
 */
function restoredInPlace(head: LogHead, base: string, now: string | undefined): boolean {
  if (!now || head.base !== base || !head.tie) return false;
  const [ino, mtime, ctime] = now.split(":");
  const c = tieCtimeOf(head.tie);
  return docTie(head.tie) === `${ino}:${mtime}` && c !== undefined && ctime !== undefined && c !== ctime;
}
/**
 * A log read from a file other than the one its header was written in: a copy of the package (or a backup put
 * back). `sig` is the log file's inode:bytes as read (inode 0: not read from a file, never a copy).
 */
export function isCopy(head: LogHead, sig: string): boolean {
  const ino = logInoOf(head.tie);
  const now = sig.split(":")[0];
  return !!ino && now !== "0" && ino !== now;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** A log that applies to the document: how far its valid records go, and the state hash they chain to. */
export type LogInfo = {
  /** sha256 of the document.json bytes the log applies to. */
  base: string;
  /** Bytes of the log up to the end of its last valid record (where the next append goes). */
  size: number;
  /** Valid records. */
  records: number;
  /** The last record's seq (0: none). */
  seq: number;
  /** The base hash chained with every valid record's hash: the state's identity (its revision). */
  chain: string;
  /** Header version (1: no tie, no owner). */
  version?: number;
  /** The server that appends to it (version 2); undefined: unknown (a version 1 log), taken as gone. */
  owner?: string;
  /** inode:mtime of the document.json it applies to (version 2), then :inode of the log file itself. */
  tie?: string;
  /** A copy of another package's log (isCopy) that applies to these bytes: folded into document.json at once. */
  copy?: boolean;
};

/** What a log file's first line says. */
export type LogHead = { version: number; base: string; tie?: string; owner?: string };

export type LogRecord = { s: number; b: DocNode[]; n?: { p: string[]; v: DocNode }[]; ids?: string[]; top?: [string, unknown][] };

export function headerOf(base: string, tie = "-", owner = "-"): Buffer {
  return Buffer.from(`${HEAD} ${LOG_VERSION} ${base} ${tie} ${owner}\n`);
}

/** A log's first line. null: cut short (nothing in it was ever acknowledged); unknown: not a header this build reads. */
export function headOf(raw: Buffer): LogHead | { unknown: string } | null {
  const nl = raw.indexOf(10);
  if (nl < 0) return null;
  const head = raw.subarray(0, nl).toString("latin1").split(" ");
  if (head[0] !== HEAD) return { unknown: "not a save log" };
  const version = Number(head[1]);
  if (version === 1 && head.length === 3) return { version, base: head[2] };
  if (version === 2 && head.length === 5) return { version, base: head[2], ...(head[3] !== "-" ? { tie: head[3] } : {}), ...(head[4] !== "-" ? { owner: head[4] } : {}) };
  return { unknown: `version ${head[1]}` };
}

/** chain' = sha256(chain + record hash). */
export const chainOf = (chain: string, recordHash: string) => sha256(chain + recordHash);

/** One record as bytes, from its payload's parts (board pieces as the writer already has them serialized). */
export function encodeRecord(seq: number, boards: Buffer[], ids?: string[], top?: [string, unknown][], nodes?: { p: string[]; v: DocNode }[]): { bytes: Buffer; hash: string } {
  const head = `{"s":${seq}${ids ? `,"ids":${JSON.stringify(ids)}` : ""}${top ? `,"top":${JSON.stringify(top)}` : ""}${nodes && nodes.length ? `,"n":${JSON.stringify(nodes)}` : ""},"b":[`;
  const parts: Buffer[] = [Buffer.from(head)];
  boards.forEach((b, i) => {
    if (i) parts.push(Buffer.from(","));
    parts.push(b);
  });
  parts.push(Buffer.from("]}"));
  const payload = Buffer.concat(parts);
  const hash = sha256(payload);
  return { bytes: Buffer.concat([Buffer.from(`R ${payload.length} ${hash}\n`), payload, Buffer.from("\n")]), hash };
}

/**
 * The records of a log's bytes that apply to a document hashing to `base` whose file has the tie `tie` (not checked
 * when undefined). null: no log (or a header cut short); unknown: a version this build does not read (never
 * removed); stale: it belongs to other bytes or another file. `anyBase` reads the records of a stale log too.
 */
export function parseLog(raw: Buffer, base: string, tie?: string, anyBase = false): { info: LogInfo; records: LogRecord[]; ends: { hash: string; end: number }[]; head: LogHead } | { stale: string; head: LogHead } | { unknown: string } | null {
  const h = headOf(raw);
  if (!h || "unknown" in h) return h;
  const tieOk = tie === undefined || h.version < 2 || tieMatches(h.tie, tie);
  if (!anyBase && (h.base !== base || !tieOk)) return { stale: h.base, head: h };
  const records: LogRecord[] = [];
  const ends: { hash: string; end: number }[] = [];
  let at = raw.indexOf(10) + 1, chain = h.base, seq = 0;
  for (;;) {
    const e = raw.indexOf(10, at);
    if (e < 0) break;
    const m = /^R (\d+) ([0-9a-f]{64})$/.exec(raw.subarray(at, e).toString("latin1"));
    if (!m) break;
    const len = Number(m[1]);
    const start = e + 1, end = start + len;
    if (end + 1 > raw.length || raw[end] !== 10) break;
    const payload = raw.subarray(start, end);
    if (sha256(payload) !== m[2]) break;
    let rec: LogRecord;
    try {
      rec = JSON.parse(payload.toString("utf8"));
    } catch {
      break;
    }
    if (!rec || !Array.isArray(rec.b)) break;
    records.push(rec);
    chain = chainOf(chain, m[2]);
    seq = rec.s;
    at = end + 1;
    ends.push({ hash: m[2], end: at });
  }
  return { info: { base: h.base, size: at, records: records.length, seq, chain, version: h.version, ...(h.owner ? { owner: h.owner } : {}), ...(h.tie ? { tie: h.tie } : {}) }, records, ends, head: h };
}

/**
 * Apply records to a document just parsed from document.json (changed in place: it is the caller's own copy).
 * Returns how many applied; a record that does not fit the document (an id it names is not there) stops it.
 */
export function applyRecords(doc: CanvasDoc, records: LogRecord[]): number {
  let n = 0;
  for (const r of records) {
    const byId = new Map<string, DocNode>();
    for (const c of doc.children) if (c && typeof c === "object" && typeof c.id === "string") byId.set(c.id, c);
    for (const b of r.b) if (b && typeof b.id === "string") byId.set(b.id, b);
    let children: DocNode[];
    if (r.ids) {
      const out: DocNode[] = [];
      for (const id of r.ids) {
        const c = byId.get(id);
        if (!c) return n;
        out.push(c);
      }
      children = out;
    } else {
      const at = new Map<string, number>();
      doc.children.forEach((c, i) => c && typeof c.id === "string" && at.set(c.id, i));
      children = doc.children.slice();
      for (const b of r.b) {
        const i = typeof b?.id === "string" ? at.get(b.id) : undefined;
        if (i === undefined) return n;
        children[i] = b;
      }
    }
    // Layers deeper in a board: every path is found first, so a record that does not fit changes nothing.
    const puts: { list: DocNode[]; i: number; v: DocNode }[] = [];
    for (const e of r.n ?? []) {
      if (!e || !Array.isArray(e.p) || !e.p.length || !e.v || typeof e.v !== "object") return n;
      let list = children, i = -1;
      for (let d = 0; d < e.p.length; d++) {
        if (d) {
          const kids = list[i]?.children as DocNode[] | undefined;
          if (!Array.isArray(kids)) return n;
          list = kids;
        }
        let hit = -1, many = false;
        for (let k = 0; k < list.length; k++) {
          const c = list[k];
          if (c && typeof c === "object" && c.id === e.p[d]) {
            many ||= hit >= 0;
            hit = k;
          }
        }
        if (hit < 0 || many) return n;
        i = hit;
      }
      puts.push({ list, i, v: e.v });
    }
    for (const p of puts) p.list[p.i] = p.v;
    if (r.top) {
      for (const k of Object.keys(doc)) delete (doc as Record<string, unknown>)[k];
      for (const [k, v] of r.top) (doc as Record<string, unknown>)[k] = k === "children" ? children : v;
      if (!r.top.some(([k]) => k === "children")) doc.children = children;
    } else doc.children = children;
    n++;
  }
  return n;
}

/** What a loader found beside the document: the log applied, or why not, and the log file as it was read. */
export type WithLog = {
  doc: CanvasDoc;
  /** The log that applied (records on top of the document). */
  log?: LogInfo;
  /** A log for other bytes or another file: not applied. */
  stale?: boolean;
  /** That stale log is a copy of another package's (isCopy): its edits are recovered over these bytes, never dropped. */
  copy?: boolean;
  /**
   * That stale log is for these very bytes in this very file, and only the file's ctime moved (restoredInPlace): the
   * file was put back to them (a restore in place), so its edits are not put on top; they are kept as a recovery copy.
   */
  restored?: boolean;
  /** A log this build does not read (a newer version): not applied, never removed. */
  unknown?: boolean;
  /** Its first line, when it has one this build reads. */
  head?: LogHead;
  /** The log file as read: inode:bytes (undefined: there was none). */
  seen?: string;
};

/**
 * The document with its log applied, for a loader that just parsed `doc` from bytes hashing to `base` in a file
 * whose tie is `tie`. `log` is absent when there is no log that applies (none, stale, unknown, or no record valid).
 */
export function withLog(docFile: string, base: string, doc: CanvasDoc, read: { raw: Buffer; sig: string } | Buffer | null, tie?: string): WithLog {
  if (!read) return { doc };
  const { raw, sig } = Buffer.isBuffer(read) ? { raw: read, sig: `0:${read.length}` } : read;
  let p = parseLog(raw, base, tie);
  if (!p) return { doc, seen: sig };
  if ("unknown" in p) return { doc, unknown: true, seen: sig };
  let copy = false;
  if ("stale" in p) {
    copy = isCopy(p.head, sig);
    // A copy of a package whose log came along, next to the very bytes it was written for: it applies (the copy
    // holds the same edits as the original), and is folded into the copy's document.json at once.
    const q = copy && p.head.base === base ? parseLog(raw, base) : null;
    if (!q || !("records" in q)) return { doc, stale: true, head: p.head, seen: sig, ...(copy ? { copy } : !copy && restoredInPlace(p.head, base, tie) ? { restored: true } : {}) };
    p = q;
  }
  const meta = { head: p.head, seen: sig };
  if (copy) p.info.copy = true;
  if (!p.records.length) return { doc, log: { ...p.info, chain: base }, ...meta };
  const applied = applyRecords(doc, p.records);
  if (applied < p.records.length) {
    // A record that does not fit the document (never one a writer appended: it checks first). The ones before it
    // still hold; the log is taken as ending there.
    console.error(`[canvas] ${path.basename(docFile)}: the save log holds a record that does not fit the document; ${p.records.length - applied} record(s) ignored`);
    let chain = base;
    for (let i = 0; i < applied; i++) chain = chainOf(chain, p.ends[i].hash);
    const size = applied ? p.ends[applied - 1].end : raw.indexOf(10) + 1;
    return { doc, log: { ...p.info, size, records: applied, seq: applied ? p.records[applied - 1].s : 0, chain }, ...meta };
  }
  return { doc, log: p.info, ...meta };
}

/** Read the log of `docFile` with its inode:bytes, if there is one (null when there is none). */
export function readLogSync(docFile: string): { raw: Buffer; sig: string } | null {
  let fd: number;
  try {
    fd = fs.openSync(logPathOf(docFile), "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const raw = fs.readFileSync(fd);
    return { raw, sig: `${fs.fstatSync(fd).ino}:${raw.length}` };
  } finally {
    fs.closeSync(fd);
  }
}

export async function readLog(docFile: string): Promise<{ raw: Buffer; sig: string } | null> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(logPathOf(docFile), "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const raw = await fh.readFile();
    return { raw, sig: `${(await fh.stat()).ino}:${raw.length}` };
  } finally {
    await fh.close();
  }
}

/** The log file as it is now: inode:bytes, or "none". */
export function logSigSync(docFile: string): string {
  try {
    const s = fs.statSync(logPathOf(docFile));
    return `${s.ino}:${s.size}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw e;
  }
}
export async function logSig(docFile: string): Promise<string> {
  try {
    const s = await fs.promises.stat(logPathOf(docFile));
    return `${s.ino}:${s.size}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw e;
  }
}

/** The state hash a revision is cut from: the log's chain when records apply, else the document's own hash. */
export const stateHashOf = (l: { hash: string; log?: LogInfo }) => (l.log && l.log.records ? l.log.chain : l.hash);

// ---------------------------------------------------------------- the lock

// Appending to the log, and writing the document whole while a log is there, happen under an exclusive lock on
// `.<document>.canvas-lock`, so two Canvas servers on one file never interleave them: an append never lands in a
// log another server is folding into a whole write, and a whole write never misses a record appended meanwhile.
// On macOS it is flock (open with O_EXLOCK): the kernel lets go of it when its process dies. Elsewhere, or on a
// volume without flock, a lock file of its own (`.held`, created exclusively, holding the pid) stands in.
const O_EXLOCK = 0x20; // <sys/fcntl.h>, macOS
const BUSY = new Set(["EAGAIN", "EWOULDBLOCK"]);
const NO_FLOCK = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL"]);
const heldHere = new Set<string>();
const noFlock = new Set<string>();

const pidAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** One try. A release function, or null when someone holds it. */
function tryLock(file: string): (() => void) | null {
  if (process.platform === "darwin" && !noFlock.has(path.dirname(file))) {
    try {
      const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | O_EXLOCK | fs.constants.O_NONBLOCK, 0o600);
      return () => {
        try {
          fs.closeSync(fd);
        } catch {}
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (BUSY.has(code)) return null;
      if (!NO_FLOCK.has(code)) throw e;
      noFlock.add(path.dirname(file));
    }
  }
  const held = `${file}.held`;
  try {
    const fd = fs.openSync(held, "wx", 0o600);
    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return () => fs.rmSync(held, { force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(held, "utf8"));
    } catch {}
    if (pid && pid !== process.pid && !pidAlive(pid)) fs.rmSync(held, { force: true }); // its process is gone: the next try takes it
    return null;
  }
}

/** Whether this process holds the lock of `docFile` right now. */
export const holdsLogLock = (docFile: string) => heldHere.has(lockPathOf(docFile));

function claim(docFile: string, release: () => void): () => void {
  const file = lockPathOf(docFile);
  heldHere.add(file);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    heldHere.delete(file);
    release();
  };
}

/** Take the lock of `docFile` (waits for whoever holds it, up to `timeoutMs`). Returns its release. */
export async function lockLog(docFile: string, timeoutMs = 15_000): Promise<() => void> {
  const file = lockPathOf(docFile);
  const t0 = Date.now();
  for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
    if (!heldHere.has(file)) {
      const r = tryLock(file);
      if (r) return claim(docFile, r);
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`the save log of ${path.basename(docFile)} stayed locked by another Canvas for ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** One try at the lock of `docFile`, without waiting: its release, or null when someone (this process too) holds it. */
export function tryLockLog(docFile: string): (() => void) | null {
  const file = lockPathOf(docFile);
  if (heldHere.has(file)) return null;
  const r = tryLock(file);
  return r ? claim(docFile, r) : null;
}

/**
 * How long a synchronous caller waits for the lock. A standalone process (a script, a test) may wait; the Canvas server
 * sets it short (docwriter.ts setDocHost): a wait there holds every request (the review measured 4.9 s on /health).
 */
export const lockConfig = { syncWaitMs: 5000 };

const nap = new Int32Array(new SharedArrayBuffer(4));
/** lockLog for synchronous callers: blocks while another process holds it (never one of this process: that throws). */
export function lockLogSync(docFile: string, timeoutMs = lockConfig.syncWaitMs): () => void {
  const file = lockPathOf(docFile);
  if (heldHere.has(file)) throw new Error(`the save log of ${path.basename(docFile)} is busy in this process`);
  const t0 = Date.now();
  for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
    const r = tryLock(file);
    if (r) return claim(docFile, r);
    if (Date.now() - t0 > timeoutMs) throw new Error(`the save log of ${path.basename(docFile)} stayed locked by another Canvas for ${timeoutMs} ms`);
    Atomics.wait(nap, 0, 0, wait);
  }
}

/** Remove the log of `docFile` (it was folded into a whole write, or retired). */
export function removeLogSync(docFile: string): void {
  fs.rmSync(logPathOf(docFile), { force: true });
}
