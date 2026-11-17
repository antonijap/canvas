// Parsed documents, kept until the file changes. A request costs one fs.stat (inode, size, mtime,
// ctime); the file is read and parsed again only when that signature moves. Most apps save by
// renaming a new file over the old one, which changes the inode, so the signature catches it, and the
// directory watch (not a watch on the file, which would stay glued to the replaced inode) tells us when to look.
// A document nobody has asked for or listened to for IDLE_MS is dropped, with its watcher.

import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { snapshotOf, type Snapshot } from "./boards.ts";
import { loadDoc, loadDocAsync, type LoadedDoc } from "./engine.ts";

/** The sha256 of a file's bytes, read off the main thread and hashed a megabyte at a time. */
// Read and hashed off the main thread (WebCrypto's digest runs on libuv's pool).
async function hashFile(file: string): Promise<string> {
  const raw = await fs.promises.readFile(file);
  return Buffer.from(await webcrypto.subtle.digest("SHA-256", raw)).toString("hex");
}

const key3Of = (sig: string) => sig.split(":").slice(0, 3).join(":");
export const sigOf = (st: fs.Stats) => `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;

/** `shown` is the snapshot last announced through onChange: the next announcement diffs against it. */
type Entry = { snap: Snapshot; sig: string; /** The hash of the bytes on disk as last loaded or written by us. */ diskHash?: string; /** A write of ours was put in place since `sig` was taken: `diskHash` no longer says what is on disk. */ ownSince?: boolean; used: number; timer?: NodeJS.Timeout; poll?: boolean; shown?: Snapshot };
type OwnWrite = { key: string; ctime?: string; hash?: string };
type DirWatch = { watcher?: fs.FSWatcher; files: Set<string> };

export type SnapshotCacheOptions = {
  /** Called when a file's content (not just its stat) changed after it was first loaded. */
  onChange: (fresh: Snapshot, prev: Snapshot) => void;
  /** Called the first time a file is loaded (and again after it was evicted). */
  onFirst?: (snap: Snapshot) => void;
  /** Documents with a live listener are never evicted. */
  pinned?: (file: string) => boolean;
  load?: (file: string) => LoadedDoc;
  /** The non-blocking loader the request path and the watchers use. */
  loadAsync?: (file: string) => Promise<LoadedDoc>;
  debounceMs?: number;
  idleMs?: number;
  /** The most recently used this many documents are never dropped for being idle. */
  keepRecent?: number;
  /**
   * Called with every load (first or after an outside change) before its snapshot is made: docwriter.ts replays
   * edits that were not on disk yet onto the new bytes, and may hand back the revision to use instead of the hash.
   */
  reconcile?: (file: string, loaded: LoadedDoc, sig: string) => { revision?: string } | void;
  /** A signature `sig` whose ctime alone moved changes the document even with the same bytes (docwriter.ts restoreSuspected). */
  ctimeOnlyChanges?: (file: string, sig: string) => boolean;
  /** Skip fs.watch and poll with fs.watchFile (what the cache falls back to when fs.watch fails). */
  forcePoll?: boolean;
  pollMs?: number;
};

export class SnapshotCache {
  private entries = new Map<string, Entry>();
  private dirs = new Map<string, DirWatch>();
  private o: Required<Omit<SnapshotCacheOptions, "onFirst" | "pinned" | "reconcile" | "ctimeOnlyChanges">> & Pick<SnapshotCacheOptions, "onFirst" | "pinned" | "reconcile" | "ctimeOnlyChanges">;
  /**
   * Files the server itself wrote (docwriter.ts), the last few per document: the temp file's inode:size:mtime, the
   * ctime the rename left (once known) and the hash of the bytes. A stat that matches all of it is ours, even when
   * taken just before a newer write of ours lands. One that matches inode, size and mtime but not the ctime (an
   * outside edit that put the mtime back, or the moment before the ctime was noted) is checked by its bytes' hash.
   */
  private own = new Map<string, OwnWrite[]>();
  private sweeper?: NodeJS.Timeout;
  private verifier?: NodeJS.Timeout;
  /** Reads of the file contents since creation: what the tests count to prove a request did not re-read. */
  loads = 0;

  constructor(o: SnapshotCacheOptions) {
    this.o = { debounceMs: 20, idleMs: 10 * 60_000, keepRecent: 0, forcePoll: false, pollMs: 150, load: loadDoc, loadAsync: o.load ? async (f: string) => o.load!(f) : loadDocAsync, ...o };
    this.sweeper = setInterval(() => this.sweep(), Math.max(1000, Math.min(60_000, this.o.idleMs / 4)));
    this.sweeper.unref();
    // Safety net for a lost watcher event: documents with a live listener are statted once a second (about 20 microseconds each).
    this.verifier = setInterval(() => { for (const f of this.entries.keys()) if (this.o.pinned?.(f)) this.schedule(f); }, 1000);
    this.verifier.unref();
  }

  /** The current snapshot of a file (a resolved real path). Throws when the file cannot be read or parsed. */
  get(file: string): Snapshot {
    const e = this.entries.get(file);
    if (e) e.used = Date.now();
    return this.refresh(file);
  }

  /** The cached snapshot without touching the disk, if there is one. Kept fresh by ensure() and the watchers. */
  peek(file: string): Snapshot | undefined {
    const e = this.entries.get(file);
    if (e) e.used = Date.now();
    return e?.snap;
  }

  private inflight = new Map<string, Promise<Snapshot>>();

  /**
   * Like get(), but the stat and the read are async: a file the OS holds up (a protected folder waiting on
   * its privacy prompt) delays only the requests that ask for it. Concurrent calls share one load.
   */
  ensure(file: string): Promise<Snapshot> {
    const e = this.entries.get(file);
    if (e) e.used = Date.now();
    let p = this.inflight.get(file);
    if (!p) {
      p = this.refreshAsync(file).finally(() => this.inflight.delete(file));
      this.inflight.set(file, p);
    }
    return p;
  }

  private async refreshAsync(file: string, again = 0): Promise<Snapshot> {
    const st0 = await fs.promises.stat(file);
    const sig = sigOf(st0);
    const e = this.entries.get(file);
    if (e && e.sig === sig) return e.snap;
    const own = e ? this.ownOf(file, sig) : undefined;
    if (e && own === true) return (e.sig = sig), (e.ownSince = false), e.snap;
    // A write of ours whose ctime is not confirmed, or a file whose ctime alone moved (a tag, a link): its bytes
    // decide, hashed without parsing them.
    const known = own && own !== true && own.hash ? own.hash : e && !e.ownSince && key3Of(sig) === key3Of(e.sig) && !this.o.ctimeOnlyChanges?.(file, sig) ? e.diskHash : undefined;
    if (e && known) {
      const h = await hashFile(file).catch(() => "");
      const still = sigOf(await fs.promises.stat(file)) === sig;
      if (still && h === known && this.entries.get(file) === e) {
        if (own && own !== true) own.ctime = sig.split(":")[3];
        e.sig = sig;
        e.diskHash = h;
        e.ownSince = false;
        return e.snap;
      }
    }
    const gen = this.gen;
    const l = await this.o.loadAsync(file);
    // The bytes must be the ones the signature was taken for: a write that landed mid-read (ours or anyone's) makes
    // this read neither, and applying it under that signature would roll the document back. Look again.
    // (Only for a regular file: reading a pipe changes its times, and reading it again would wait for another writer.)
    const after = st0.isFile() ? await fs.promises.stat(file).then(sigOf, () => "") : sig;
    const moved = after !== sig || (this.gen !== gen && again < 3);
    if (moved) {
      if (again < 6) return this.refreshAsync(file, again + 1);
      const cur = this.entries.get(file);
      if (after !== sig) {
        if (cur) {
          this.schedule(file); // the file keeps moving: keep what is current and look again shortly
          return cur.snap;
        }
        throw new Error(`${file} kept changing while it was read`);
      }
    }
    return this.apply(file, sig, l);
  }

  /** Bumped by every adopt and load: an async read that started before a bump is not applied blindly. */
  private gen = 0;

  has(file: string) {
    return this.entries.has(file);
  }

  private refresh(file: string, again = 0): Snapshot {
    if (again > 5) throw new Error(`${file} kept changing while it was read`);
    const e = this.entries.get(file);
    const st0 = fs.statSync(file);
    const sig = sigOf(st0);
    if (e && e.sig === sig) return e.snap;
    const own = e ? this.ownOf(file, sig) : undefined;
    if (e && own === true) return (e.sig = sig), (e.ownSince = false), e.snap;
    const known = own && own !== true && own.hash ? own.hash : e && !e.ownSince && key3Of(sig) === key3Of(e.sig) && !this.o.ctimeOnlyChanges?.(file, sig) ? e.diskHash : undefined;
    if (e && known) {
      let h = "";
      try {
        h = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      } catch {}
      if (h === known && sigOf(fs.statSync(file)) === sig) {
        if (own && own !== true) own.ctime = sig.split(":")[3];
        e.sig = sig;
        e.diskHash = h;
        e.ownSince = false;
        return e.snap;
      }
    }
    const l = this.o.load(file);
    // The bytes must belong to the signature taken before the read (see refreshAsync).
    if (st0.isFile() && sigOf(fs.statSync(file)) !== sig) return this.refresh(file, again + 1);
    return this.apply(file, sig, l);
  }

  /**
   * true: our latest write, exactly. Our latest write with another ctime: its bytes decide. undefined: not ours.
   * Only the newest write counts (and the one before it while the newest is not confirmed on disk yet): an older
   * version of ours put back by someone else is their change, and is loaded as one.
   */
  private ownOf(file: string, sig: string): true | OwnWrite | undefined {
    const [ino, size, mtime, ctime] = sig.split(":");
    const k = `${ino}:${size}:${mtime}`;
    let maybe: OwnWrite | undefined;
    const list = this.own.get(file) ?? [];
    const last = list.at(-1);
    for (const w of last && last.ctime === undefined ? list.slice(-2) : list.slice(-1)) {
      if (w.key !== k) continue;
      if (w.ctime !== undefined && w.ctime === ctime) return true;
      maybe = w;
    }
    return maybe;
  }

  /** Take `l` (bytes someone else saved, read from elsewhere) as the file's content, with `sig` as what is on disk now. */
  applyLoaded(file: string, sig: string, l: LoadedDoc): Snapshot {
    return this.apply(file, sig, l);
  }

  /** The server is about to put a file with this inode:size:mtime and hash in place (null: the one just marked did not land). */
  markOwn(file: string, key: string | null, hash?: string): void {
    this.gen++; // a read in flight may have started before this write: it looks again
    const ent = this.entries.get(file);
    if (ent && key) ent.ownSince = true;
    const list = this.own.get(file) ?? [];
    if (key) {
      list.push({ key, hash });
      if (list.length > 16) list.shift();
      this.own.set(file, list);
    } else list.pop(); // the write just marked did not land
  }

  /** The full signature (ctime included) the write just marked has, now that it is in place. */
  confirmOwn(file: string, sig: string): void {
    const [ino, size, mtime, ctime] = sig.split(":");
    const k = `${ino}:${size}:${mtime}`;
    const w = this.own.get(file)?.findLast((o) => o.key === k);
    if (w) w.ctime = ctime;
  }

  /**
   * Make `snap` the current state of a loaded file: an edit made in memory, written to disk later. The change is
   * announced on the next turn of the loop: after the editing request has said who made it (bridge docChanged keeps
   * the first) and after its answer went out (the diff works out the new snapshot's boards and usage).
   */
  adopt(file: string, snap: Snapshot): void {
    const e = this.entries.get(file);
    if (!e) throw new Error(`${file} is not loaded`);
    const prev = e.snap;
    e.snap = snap;
    e.used = Date.now();
    this.gen++;
    setImmediate(() => {
      // A later edit or load in the same turn announces itself, against what was shown last.
      if (this.entries.get(file) !== e || e.snap !== snap) return;
      const before = e.shown ?? prev;
      e.shown = snap;
      this.o.onChange(snap, before);
    });
  }

  private apply(file: string, sig: string, l: LoadedDoc): Snapshot {
    let r: { revision?: string } | void;
    try {
      r = this.o.reconcile?.(file, l, sig);
    } catch (e) {
      // The writer is putting a file in place right now: keep what is current and look again shortly. Or another
      // Canvas holds the save log's lock (`ready`): the writer loads again itself once it has it.
      const cur = this.entries.get(file);
      if ((e as Error).name === "ReloadLater" && cur) {
        if (!(e as { ready?: Promise<void> }).ready) setTimeout(() => this.schedule(file), 10).unref();
        return cur.snap;
      }
      throw e;
    }
    this.loads++;
    this.gen++;
    const snap = snapshotOf(l);
    if (r && r.revision) snap.revision = r.revision;
    const e = this.entries.get(file);
    if (!e) {
      // What pages are first shown (the full document on connect): the first change diffs against it. Without
      // it, a burst whose first announcement came after several edits diffed from the edit before last, a base no
      // page had, and every page fetched the whole document again.
      this.entries.set(file, { snap, sig, used: Date.now(), diskHash: l.hash, shown: snap });
      this.o.onFirst?.(snap);
      this.watch(file);
      return snap;
    }
    const prev = e.snap;
    e.sig = sig;
    e.diskHash = l.hash;
    e.ownSince = false;
    if (snap.revision === prev.revision) return prev; // touched, same bytes
    e.snap = snap;
    const before = e.shown ?? prev;
    e.shown = snap;
    this.o.onChange(snap, before); // whoever noticed first (a request or the watcher) announces it, once
    return snap;
  }

  private watch(file: string) {
    const dir = path.dirname(file);
    let d = this.dirs.get(dir);
    if (!d) {
      d = { files: new Set() };
      this.dirs.set(dir, d);
      if (!this.o.forcePoll) {
        try {
          const w = fs.watch(dir, { persistent: false }, (_ev, name) => this.onEvent(dir, name ? String(name) : null));
          w.on("error", () => this.fallBack(dir));
          d.watcher = w;
        } catch {
          // EMFILE, ENOSPC, a network volume: poll instead.
        }
      }
    }
    d.files.add(file);
    if (!d.watcher) this.poll(file);
    // Watchers take a moment to arm (FSEvents, and watchFile's first stat): an edit inside that window raises no event. Look once after it.
    setTimeout(() => this.schedule(file), 300).unref();
  }

  private fallBack(dir: string) {
    const d = this.dirs.get(dir);
    if (!d) return;
    try { d.watcher?.close(); } catch {}
    d.watcher = undefined;
    for (const f of d.files) this.poll(f);
  }

  private poll(file: string) {
    const e = this.entries.get(file);
    if (!e || e.poll) return;
    e.poll = true;
    fs.watchFile(file, { interval: this.o.pollMs, persistent: false }, () => this.schedule(file));
  }

  private onEvent(dir: string, name: string | null) {
    const d = this.dirs.get(dir);
    if (!d) return;
    if (name === null) for (const f of d.files) this.schedule(f);
    else {
      const f = path.join(dir, name);
      if (d.files.has(f)) this.schedule(f);
    }
  }

  private schedule(file: string) {
    const e = this.entries.get(file);
    if (!e) return;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      e.timer = undefined;
      this.ensure(file).catch(() => {
        // Half-written or briefly missing: the next change event tries again.
      });
    }, this.o.debounceMs);
  }

  private sweep(now = Date.now()) {
    const recent = new Set([...this.entries].sort((a, b) => b[1].used - a[1].used).slice(0, this.o.keepRecent).map(([f]) => f));
    for (const [file, e] of this.entries) if (now - e.used > this.o.idleMs && !recent.has(file) && !this.o.pinned?.(file)) this.drop(file);
  }

  /** Runs the idle sweep as if it were `now` (tests). */
  sweepAt(now: number) {
    this.sweep(now);
  }

  drop(file: string) {
    const e = this.entries.get(file);
    if (!e) return;
    clearTimeout(e.timer);
    if (e.poll) fs.unwatchFile(file);
    this.entries.delete(file);
    const dir = path.dirname(file);
    const d = this.dirs.get(dir);
    if (d) {
      d.files.delete(file);
      if (!d.files.size) {
        try { d.watcher?.close(); } catch {}
        this.dirs.delete(dir);
      }
    }
  }

  close() {
    clearInterval(this.sweeper);
    clearInterval(this.verifier);
    for (const f of [...this.entries.keys()]) this.drop(f);
  }
}
