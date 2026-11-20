import { cloudFileHooks } from "../cloud-files-runtime.ts";
// The sidecar: a document's widgets live in widgets.json inside its package (foo.widgets.json beside a single
// foo.canvas.json). The server is the only writer; the design file is never touched. Every change is a pure function
// applied under a per-file lock, on top of whatever is on disk right now, and written by renaming a temp file into place.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { asOneAction, deliverOps, envelopeEditAction, wantActions } from "../cloud-files-ops.ts";
import { widgetsPathFor } from "../docpath.ts";
import { isObject } from "./check.ts";
import { kindOf, validateWidget } from "./registry.ts";
import { WidgetError, type Widget } from "./types.ts";

export type StoreState = {
  rev: string;
  widgets: Widget[];
  /** Set when the file on disk cannot be read as widgets. The last good list stays; writes are refused. */
  warning?: string;
  invalid: boolean;
  /** Top-level keys of the file other than version and widgets, kept as found. */
  extra: Record<string, unknown>;
};
type Listener = (s: StoreState) => void;

/** The widgets and the other envelope keys (pages) at one moment, for the undo history. */
export type EnvelopeState = { widgets: Widget[]; extra: Record<string, unknown> };
/** Who made a write and how it merges (history.ts's RecordMeta). A write with `record` lands in the undo history. */
export type WriteOpts = { ifMatch?: string; record?: { label: string; source?: "user" | "mcp"; session?: string; mergeKey?: string; mergeMs?: number } };
/** Set by history.ts: hears every recorded write after it is on disk, inside the store's queue. */
export const envelopeHook: { fn?: (docFile: string, before: EnvelopeState, after: EnvelopeState, meta: NonNullable<WriteOpts["record"]>) => void } = {};

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const EMPTY_REV = sha("");

/** Where a document's widgets live: widgets.json inside a .canvas package, foo.widgets.json beside a single foo.canvas.json. */
export const sidecarPath = widgetsPathFor;

const FIRST = ["id", "kind", "name", "x", "y", "w", "h", "locked", "config"];

/** Fixed key order, so the file only changes when a widget does. */
function canonical(w: Widget): Widget {
  const out: Record<string, unknown> = {};
  for (const k of FIRST) out[k] = w[k];
  for (const k of Object.keys(w).sort()) if (!FIRST.includes(k)) out[k] = w[k];
  return out as Widget;
}

export function serialize(widgets: Widget[], extra: Record<string, unknown> = {}): string {
  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(extra).sort()) extras[k] = extra[k];
  return JSON.stringify({ version: 1, ...extras, widgets: widgets.map(canonical) }, null, 2) + "\n";
}

/** Fill what a hand-edited file may leave out, without judging the config (that happens on write). */
function shape(raw: unknown, n: number): Widget {
  if (!isObject(raw) || typeof raw.id !== "string" || !raw.id || typeof raw.kind !== "string" || !raw.kind) throw new Error(`widgets[${n}] needs a text id and kind`);
  const size = kindOf(raw.kind)?.defaultSize ?? { w: 240, h: 160 };
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    ...raw,
    id: raw.id,
    kind: raw.kind,
    name: typeof raw.name === "string" ? raw.name : "",
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    w: num(raw.w, size.w),
    h: num(raw.h, size.h),
    locked: raw.locked === true,
    config: isObject(raw.config) ? raw.config : {},
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class Store {
  readonly docFile: string;
  readonly file: string;
  private state: StoreState = { rev: EMPTY_REV, widgets: [], invalid: false, extra: {} };
  /** Hash of the file as last read or written; null when it did not exist. Same hash means nothing to do. */
  private seen: string | null | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<Listener>();
  private holds = 0;
  private timer: NodeJS.Timeout | undefined;

  /** Until this time the last async read counts as current (see refreshAsync). */
  private freshUntil = 0;

  /** `pre` is the file as an async read found it (null: no file), so building a store never blocks on the disk. */
  constructor(docFile: string, pre?: { raw: string | null | Unreadable }) {
    this.docFile = docFile;
    this.file = sidecarPath(docFile);
    this.refresh(pre?.raw);
  }

  /** Read the file without blocking the event loop, then apply it like refresh(). Marks the state current for a moment. */
  async refreshAsync(settle = false): Promise<boolean> {
    let raw = await readRawOrError(this.file);
    // `settle` (a write is about to build on this): a file we had that is missing now gets its few looks right here.
    for (let i = 0; settle && raw === null && typeof this.seen === "string" && !this.committing && i < GONE_LOOKS; i++) {
      await new Promise((r) => setTimeout(r, GONE_WAIT_MS));
      raw = await readRawOrError(this.file);
    }
    this.freshUntil = Date.now() + 2000;
    return this.refresh(raw, settle);
  }

  /** Re-read the file if it changed. Tells listeners when the visible state moved. `known` skips the (sync) read. `gone`: the file was confirmed missing. */
  refresh(known?: string | null | Unreadable, gone = false): boolean {
    let raw: string | null | Unreadable;
    if (known !== undefined) raw = known;
    else {
      try {
        raw = fs.readFileSync(this.file, "utf8");
      } catch (e) {
        raw = (e as NodeJS.ErrnoException).code === "ENOENT" ? null : { unreadable: (e as Error).message };
      }
    }
    // Our own swap has the file aside for a moment; that is not a deletion.
    if (raw === null && this.committing) return false;
    // Another process saving by rename (or by our move-aside-and-link swap) leaves the path empty for a moment too.
    // A file we had read is called deleted only after a few looks, so an empty page list is never sent for that gap.
    if (raw === null && !gone && typeof this.seen === "string") {
      this.confirmGone();
      return false;
    }
    if (isUnreadable(raw)) {
      // Keep the last good list and refuse writes until the file can be read again (mutate checks `invalid`).
      const warning = `${this.file} cannot be read: ${raw.unreadable}`;
      if (this.state.invalid && this.state.warning === warning) return false;
      this.seen = undefined;
      this.state = { ...this.state, invalid: true, warning };
      this.emit();
      return true;
    }
    const h = raw === null ? null : sha(raw);
    if (h === this.seen) return false;
    this.seen = h;
    if (raw === null) this.state = { rev: EMPTY_REV, widgets: [], invalid: false, extra: {} };
    else {
      try {
        const j = JSON.parse(raw) as unknown;
        if (!isObject(j) || !Array.isArray(j.widgets)) throw new Error('expected an object with a "widgets" list');
        const widgets = j.widgets.map(shape);
        const ids = new Set(widgets.map((w) => w.id));
        if (ids.size !== widgets.length) throw new Error("two widgets share an id");
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(j)) if (k !== "version" && k !== "widgets") extra[k] = v;
        this.state = { rev: h!, widgets, invalid: false, extra };
      } catch (e) {
        this.state = { ...this.state, rev: h!, invalid: true, warning: `${this.file} cannot be read: ${(e as Error).message}` };
      }
    }
    this.emit();
    return true;
  }

  private confirming = false;
  /** Look again GONE_LOOKS times, GONE_WAIT_MS apart: a file that comes back is read, one that stays away is gone. */
  private confirmGone(): void {
    if (this.confirming) return;
    this.confirming = true;
    void (async () => {
      try {
        for (let i = 0; i < GONE_LOOKS; i++) {
          await new Promise((r) => setTimeout(r, GONE_WAIT_MS));
          const raw = await readRawOrError(this.file);
          if (raw !== null) {
            this.refresh(raw);
            return;
          }
        }
        this.refresh(null, true);
      } finally {
        this.confirming = false;
      }
    })().catch((e) => console.error(`[canvas] widgets: ${e}`));
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l(this.state);
      } catch (e) {
        console.error(`[canvas] widgets listener: ${e}`);
      }
    }
  }

  forget(): void {
    fs.unwatchFile(this.file); clearTimeout(this.timer); this.listeners.clear();
    this.state={rev:EMPTY_REV,widgets:[],invalid:false,extra:{}};this.seen=undefined;
  }

  snapshot(): StoreState {
    if (Date.now() >= this.freshUntil) this.refresh();
    return this.state;
  }

  /** Last known state, without touching the disk. Fresh as long as someone holds the store. */
  peek(): StoreState {
    return this.state;
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Watch the file while somebody cares (an open page, a lease). Polling the path survives rename-over saves. */
  retain(): () => void {
    if (this.holds++ === 0) {
      fs.watchFile(this.file, { interval: 250, persistent: false }, () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(), 60);
      });
      // watchFile takes its baseline a moment after starting; catch an edit that landed before it.
      this.timer = setTimeout(() => this.refresh(), 300);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.holds === 0) {
        fs.unwatchFile(this.file);
        clearTimeout(this.timer);
      }
    };
  }

  /**
   * Apply `fn` to a copy of the widgets and store the result. `fn` runs against the file as it is
   * now; if the file moves between reading and renaming, it runs again on the new content.
   */
  mutate<T = undefined>(fn: (widgets: Widget[]) => { widgets: Widget[]; result?: T }, opts: WriteOpts = {}): Promise<{ state: StoreState; result: T | undefined }> {
    return this.mutateEnvelope<T>((widgets, extra) => ({ ...fn(widgets), extra }), opts);
  }

  /**
   * The same queue for everything in the envelope: `fn` gets copies of the widgets and of the other keys
   * (pages live there) and returns both. One lock, one atomic write, one rebase rule.
   */
  mutateEnvelope<T = undefined>(fn: (widgets: Widget[], extra: Record<string, unknown>) => { widgets: Widget[]; extra: Record<string, unknown>; result?: T }, opts: WriteOpts = {}): Promise<{ state: StoreState; result: T | undefined }> {
    return asOneAction(this.docFile, () => this.mutateEnvelopeNow(fn, opts));
  }

  private mutateEnvelopeNow<T>(fn: (widgets: Widget[], extra: Record<string, unknown>) => { widgets: Widget[]; extra: Record<string, unknown>; result?: T }, opts: WriteOpts): Promise<{ state: StoreState; result: T | undefined }> {
    const run = async () => {
      cloudFileHooks.assertEdit?.(this.docFile);
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.refreshAsync(true);
        // What `fn` runs on. A watcher's refresh() may move this.seen meanwhile; the swap compares against this.
        const base = this.seen;
        if (this.state.invalid) throw new WidgetError(409, "sidecar-invalid", `${this.state.warning}. Fix or delete the file to edit widgets again.`);
        if (opts.ifMatch && opts.ifMatch !== this.state.rev) throw new WidgetError(409, "rev-mismatch", "The widgets changed since you read them");
        const before = this.state.widgets;
        const beforeExtra = this.state.extra;
        const out = fn(before.map((w) => JSON.parse(JSON.stringify(w)) as Widget), JSON.parse(JSON.stringify(this.state.extra)) as Record<string, unknown>);
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(out.extra ?? {})) if (k !== "version" && k !== "widgets" && v !== undefined) extra[k] = v;
        const oldById = new Map(before.map((w) => [w.id, w]));
        const next = out.widgets.map((w) => (same(w, oldById.get(w.id)) ? w : validateWidget(w)));
        if (new Set(next.map((w) => w.id)).size !== next.length) throw new WidgetError(409, "id-exists", "A widget with that id already exists");
        const bytes = serialize(next, extra);
        // The write as one action of file ops (src/cloud-files-ops.ts); with checks on, an incomplete one is refused.
        const fileOps = wantActions() ? envelopeEditAction({ widgets: before, extra: beforeExtra }, { widgets: next, extra }, bytes, serialize) : null;
        // Another writer slipped in since refresh(): start over on top of it.
        if (base === undefined || (await this.fileHash()) !== base) continue;
        if (!(await this.commit(bytes, base))) continue;
        deliverOps(this.docFile, fileOps, { widgets: before, extra: beforeExtra }, { widgets: next, extra });
        this.seen = sha(bytes);
        this.state = { rev: this.seen, widgets: next, invalid: false, extra };
        if (opts.record && envelopeHook.fn) {
          try {
            envelopeHook.fn(this.docFile, { widgets: before, extra: beforeExtra }, { widgets: next, extra }, opts.record);
          } catch (e) {
            console.error(`[canvas] history: ${e}`);
          }
        }
        this.emit();
        return { state: this.state, result: out.result };
      }
      throw new WidgetError(409, "busy", "The widgets file keeps changing on disk; try again");
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async fileHash(): Promise<string | null> {
    const raw = await readRaw(this.file);
    return raw === null ? null : sha(raw);
  }

  /** True while commit() has the file moved aside: a watcher that finds no file then must not read it as "no widgets". */
  private committing = false;

  /**
   * Compare-and-swap on the path. The current file is renamed aside (atomic: it captures exactly what is there now),
   * its hash checked against what `fn` ran on, and the new bytes linked into place; link() fails if any writer put a
   * file there meanwhile. False: someone else wrote, nothing of theirs was replaced, the caller retries on top of it.
   */
  private async commit(bytes: string, base: string | null): Promise<boolean> {
    const tag = `${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    const tmp = `${this.file}.${tag}.tmp`;
    const aside = `${this.file}.${tag}.prev`;
    await fs.promises.writeFile(tmp, bytes);
    this.committing = true;
    // The moved-aside original may be deleted only once the path holds a complete file again (ours, it, or a newer one).
    let asideSafe = true;
    /** Put the original back unless a newer file took the path. True when the path holds a file. */
    const putBack = async () => {
      try {
        await fs.promises.link(aside, this.file);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EEXIST";
      }
    };
    /** Exclusive install: fails with EEXIST if any file is at the path. Hard link (atomic), else an exclusive copy. */
    const install = async () => {
      try {
        await fs.promises.link(tmp, this.file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e;
        await fs.promises.copyFile(tmp, this.file, fs.constants.COPYFILE_EXCL);
      }
    };
    try {
      await storeTestHooks.beforeCommit?.(this.file);
      if (base !== null) {
        try {
          await fs.promises.rename(this.file, aside);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          return false; // it was there when we read it; gone now: somebody else is writing
        }
        asideSafe = false;
        let was: string;
        try {
          was = await fs.promises.readFile(aside, "utf8");
        } catch (e) {
          asideSafe = await putBack();
          throw e;
        }
        if (sha(was) !== base) {
          // Theirs: put it back unless an even newer file already took the path.
          asideSafe = await putBack();
          return false;
        }
      }
      try {
        await install();
      } catch (e) {
        if (base !== null) asideSafe = await putBack();
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; // a writer created the file in the gap: keep theirs
        throw e;
      }
      asideSafe = true;
      return true;
    } finally {
      this.committing = false;
      await fs.promises.unlink(tmp).catch(() => undefined);
      // If neither ours nor the original could be put in place, the original stays beside it as *.prev.
      if (asideSafe) await fs.promises.unlink(aside).catch(() => undefined);
    }
  }
}

const GONE_LOOKS = 3;
const GONE_WAIT_MS = 20;

/** Test seam: runs between the last change check and the swap, where another writer would slip in. */
export const storeTestHooks: { beforeCommit?: (file: string) => unknown } = {};

/** Marks a sidecar that exists but cannot be read (permissions, I/O): never the same as a missing file. */
type Unreadable = { unreadable: string };
const isUnreadable = (v: unknown): v is Unreadable => typeof v === "object" && v !== null && "unreadable" in v;

async function readRawOrError(file: string): Promise<string | null | Unreadable> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { unreadable: (e as Error).message };
  }
}

/** The raw file, null when it does not exist. Any other read error throws: an unreadable file is not an empty one. */
const readRaw = async (file: string): Promise<string | null> => {
  const r = await readRawOrError(file);
  if (isUnreadable(r)) throw new WidgetError(409, "sidecar-invalid", `${file} cannot be read: ${r.unreadable}`);
  return r;
};

const stores = new Map<string, Store>();
/** storeFor() that reads the sidecar with fs.promises, and refreshes an existing store the same way. */
export async function storeForAsync(docFile: string): Promise<Store> {
  const have = stores.get(docFile);
  if (have) {
    await have.refreshAsync();
    return have;
  }
  const raw = await readRawOrError(sidecarPath(docFile));
  let s = stores.get(docFile);
  if (!s) stores.set(docFile, (s = new Store(docFile, { raw })));
  else await s.refreshAsync();
  return s;
}
export function storeFor(docFile: string): Store {
  let s = stores.get(docFile);
  if (!s) stores.set(docFile, (s = new Store(docFile)));
  return s;
}

export function forgetStore(docFile:string):void { const s=stores.get(docFile);s?.forget();stores.delete(docFile); }
