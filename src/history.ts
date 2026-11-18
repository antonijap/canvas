// Undo and redo, per document, in the server's memory (never on disk). Every edit the server writes for
// someone (the inspector, the page, the shell, an agent through the MCP) is recorded as an entry of ops that
// carry the value before and after, per node property, per widget and for the page list. Undo writes the
// before values back through the same write paths (writeDoc for the design file, the store queue for the sidecar),
// but only where the document still holds the after values: a property somebody changed since makes the
// whole step refuse with a clear message instead of clobbering their change. Changes to other nodes or
// widgets do not get in the way.
// Rapid edits of the same thing (typing in a number field, nudging a widget) merge into one step. An agent's
// edits through the MCP are one step per MCP session until it calls finish_work.
// Structure changes (delete, duplicate, paste, group, ungroup, reorder; src/structure.ts) add tree ops: a whole
// subtree inserted or removed at a parent and index, and a node moved between two places. A step that holds them
// runs its ops in order (reversed for undo), each checking that the document is where the step left it on a copy
// first, so a refused step writes nothing. Ids stay the same through undo and redo.

import type http from "node:http";
import { allIds, buildIndex, findNode, loadDoc, revisionOf, stateHashOf, StaleFileError, updateNode, type Json, type DocNode } from "./engine.ts";
import { currentDoc, editDoc, pendingEdits, writerHooks } from "./docwriter.ts";
import { asOneAction, lastActionWrites, lastDocOrders, type Writers } from "./cloud-files-ops.ts";
import { envelopeHook, storeForAsync, type EnvelopeState } from "./widgets/store.ts";
import type { Widget } from "./widgets/types.ts";
import { countUsage } from "./usage-counts.ts";

export const MERGE_MS = 500;
export const MAX_ENTRIES = 200;
export const MAX_BYTES = 20 * 1024 * 1024;

/** A value as stored, or null when the property was absent. */
type Val = { v: Json } | null;
/** keys: the node's key order before and after, kept when the edit added or removed a key, so undo and redo put
 *  a property back where it was and the file comes back byte for byte (orderKeys). */
export type NodeOp = { t: "node"; id: string; props: Record<string, { b: Val; a: Val }>; keys?: { b: string[]; a: string[] } };

/** The key orders of a node op between `before` and `after`, when the set of keys differs (else none). */
export function keyOrders(before: Record<string, unknown>, after: Record<string, unknown>): NodeOp["keys"] {
  const b = Object.keys(before).filter((k) => before[k] !== undefined), a = Object.keys(after).filter((k) => after[k] !== undefined);
  // propsOf leaves children out but remembers where they were among the keys.
  const full = (o: Record<string, unknown>, ks: string[]) => ((o as any)[KEY_ORDER] as string[] | undefined)?.filter((k) => k === "children" || ks.includes(k)) ?? ks;
  const kb = full(before, b), ka = full(after, a);
  return kb.length === ka.length && kb.every((k, i) => k === ka[i]) ? undefined : { b: kb, a: ka };
}
const KEY_ORDER = Symbol("keyOrder");

/** Put a node's keys in `order` (in place). A key the order does not name (children: ops leave it out) stays right
 *  after the named key it follows now. */
export function orderKeys(node: Record<string, unknown>, order: string[] | undefined): Record<string, unknown> {
  if (!order) return node;
  const now = Object.keys(node);
  const named = new Set(order);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const k of now) {
    if (named.has(k)) anchor = k;
    else after.set(anchor, [...(after.get(anchor) ?? []), k]);
  }
  const want = [...(after.get(null) ?? [])];
  for (const k of order) if (Object.hasOwn(node, k)) want.push(k, ...(after.get(k) ?? []));
  if (want.every((k, i) => now[i] === k)) return node;
  const vals = Object.fromEntries(now.map((k) => [k, node[k]]));
  for (const k of now) delete node[k];
  for (const k of want) node[k] = vals[k];
  return node;
}
export type WidgetOp = { t: "widget"; id: string; b: Widget | null; a: Widget | null; bi: number; ai: number };
export type PagesOp = { t: "pages"; b: unknown; a: unknown };
/** A subtree that appeared (insert) or went away (remove) at parent (null: the document) and index. `node` is a full copy. */
export type TreeOp = { t: "tree"; kind: "insert" | "remove"; parent: string | null; index: number; node: DocNode };
export type Place = { parent: string | null; index: number };
/** A node that moved from one place in the tree to another (reorder, into a new group). */
export type MoveOp = { t: "move"; id: string; b: Place; a: Place };
/** A document-level key (variables, themes, fonts) before and after. */
export type DocOp = { t: "doc"; key: string; b: Val; a: Val; keys?: { b: string[]; a: string[] } };
export type Op = NodeOp | WidgetOp | PagesOp | TreeOp | MoveOp | DocOp;
const isStructural = (o: Op): o is TreeOp | MoveOp => o.t === "tree" || o.t === "move";

export type Entry = {
  /** Last writers of this step's values, carried by its next undo or redo action. */
  writers?: Writers;
  seq: number;
  label: string;
  ops: Op[];
  /** The design file's revision the step left behind (when it wrote the design file). */
  revision?: string;
  at: number;
  mergeKey?: string;
  /** An agent's step: open until its session calls finish_work. */
  agent?: { session: string; open: boolean; edits: number };
  /** The selection before the step, for an Undo that leaves nothing of its own to select (Duplicate). */
  selBefore?: string[];
  /** The selection the step was made with, brought back by undo and redo (a group resized by its handles). */
  sel?: string[];
  bytes: number;
  /**
   * The edits folded into this step, each with its own ops: `ops` is their fold. An edit not yet on disk that is
   * replayed on someone else's bytes (src/docwriter.ts) gets the ops it applied as, and the step is folded again.
   */
  parts?: { edit?: string; ops: Op[]; /** when it was recorded (Date.now), for compact() */ at?: number }[];
  /** Files the step added to the document's folder (a paste from another file): its undo takes back the ones
   *  nothing uses any more (`stash`: where they wait for a redo), see src/pastefiles.ts. */
  files?: StepFile[];
};
export type StepFile = { path: string; stash?: string };

/** Who made an edit and how it merges. */
export type RecordMeta = { label: string; source?: "user" | "mcp"; session?: string; mergeKey?: string; mergeMs?: number; /** editDoc's write.edit */ edit?: string; /** the layers selected before the step (a duplicate's originals) */ selBefore?: string[]; /** the selection the step was made with */ sel?: string[]; /** join the step with this seq (joinTop), even when other steps landed on top of it since */ into?: number };

export class HistoryError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Stacks = { undo: Entry[]; redo: Entry[] };
const files = new Map<string, Stacks>();
let seq = 0;
let now = () => Date.now();
/** Tests move the clock. */
export const setClock = (f: () => number) => void (now = f);

const stacks = (docFile: string): Stacks => {
  let s = files.get(docFile);
  if (!s) files.set(docFile, (s = { undo: [], redo: [] }));
  return s;
};

const listeners = new Set<(docFile: string) => void>();
/** Hear every change to a document's history (to tell open pages, which tell the shell's Edit menu). */
export function onHistory(f: (docFile: string) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
const versions = new Map<string, number>();
const notify = (docFile: string) => {
  versions.set(docFile, (versions.get(docFile) ?? 0) + 1);
  for (const f of listeners) {
    try {
      f(docFile);
    } catch (e) {
      console.error(`[canvas] history listener: ${e}`);
    }
  }
};

const agentListeners = new Set<(docFile: string, session: string, ops: Op[]) => void>();
/** Hear every edit an agent makes through the MCP, as recorded (the agent cursor, src/agent-cursor.ts). */
export function onAgentEdit(f: (docFile: string, session: string, ops: Op[]) => void): () => void {
  agentListeners.add(f);
  return () => agentListeners.delete(f);
}

/** `v` grows with every change, so a listener can drop an older state that arrives late. */
export type HistoryState = { undo: string | null; redo: string | null; undoDepth: number; redoDepth: number; agentOpen: boolean; v: number; peek?: { undo: HistoryPeek | null; redo: HistoryPeek | null } };
export function historyState(docFile: string): HistoryState {
  const s = files.get(docFile);
  const top = s?.undo.at(-1);
  const r = s?.redo.at(-1);
  return { undo: top?.label ?? null, redo: r?.label ?? null, undoDepth: s?.undo.length ?? 0, redoDepth: s?.redo.length ?? 0, agentOpen: !!s?.undo.some((e) => e.agent?.open), v: versions.get(docFile) ?? 0, peek: { undo: peekOf(top, "undo"), redo: peekOf(r, "redo") } };
}

/**
 * What undoing or redoing an entry will write, so the page can draw it before the server answers
 * (src/page/live.js): per node, the properties it sets and the ones it removes. Only for entries made of node
 * property changes and small enough to send with every history event; anything else waits for the server.
 * `seq` names the entry: the page sends it back as `expect`, and the server refuses when another one is on top.
 */
export type HistoryPeek = { seq: number; nodes: { id: string; set: Record<string, Json>; remove: string[] }[] };
export const PEEK_MAX_NODES = 64;
export const PEEK_MAX_BYTES = 32 * 1024;
export function peekOf(e: Entry | undefined, dir: "undo" | "redo"): HistoryPeek | null {
  if (!e || !e.ops.length || e.ops.length > PEEK_MAX_NODES || e.ops.some((o) => o.t !== "node") || e.bytes > PEEK_MAX_BYTES) return null;
  const nodes = (e.ops as NodeOp[]).map((op) => {
    const set: Record<string, Json> = {};
    const remove: string[] = [];
    for (const [k, d] of Object.entries(op.props)) {
      const to = dir === "undo" ? d.b : d.a;
      if (to === null) remove.push(k);
      else set[k] = to.v;
    }
    return { id: op.id, set, remove };
  });
  return { seq: e.seq, nodes };
}
/** The entries, newest last (tests and the MCP's history view). */
export const entries = (docFile: string): { undo: Entry[]; redo: Entry[] } => ({ undo: [...(files.get(docFile)?.undo ?? [])], redo: [...(files.get(docFile)?.redo ?? [])] });
export const resetHistory = (docFile?: string) => (docFile ? files.delete(docFile) : files.clear());

// ---------- values ----------

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as any)[k] !== undefined);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as any)[k], (b as any)[k]));
}
const sameVal = (x: Val, y: Val) => (x === null || y === null ? x === y : same(x.v, y.v));
const valOf = (n: Record<string, unknown>, k: string): Val => (Object.hasOwn(n, k) && n[k] !== undefined ? { v: structuredClone(n[k]) as Json } : null);
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

// ---------- labels ----------

const PROP_NAMES: Record<string, string> = {
  fill: "Fill", stroke: "Stroke", strokeWidth: "Stroke Width", effect: "Effect", opacity: "Opacity", cornerRadius: "Corner Radius",
  x: "Position", y: "Position", width: "Size", height: "Size", rotation: "Rotation", content: "Text", fontFamily: "Font", fontSize: "Font Size",
  fontWeight: "Font Weight", lineHeight: "Line Height", letterSpacing: "Letter Spacing", textAlign: "Text Alignment", textAlignVertical: "Text Alignment",
  textGrowth: "Text Resizing", layout: "Layout", gap: "Gap", padding: "Padding", justifyContent: "Alignment", alignItems: "Alignment", name: "Name",
  enabled: "Visibility", locked: "Lock", clip: "Clip Content", ref: "Component", fontStyle: "Font Style", textDecoration: "Text Decoration",
  textTransform: "Text Case", blendMode: "Blend Mode", effects: "Effect", strokeAlign: "Stroke", strokeThickness: "Stroke Width",
  strokeAlignment: "Stroke Position", minWidth: "Size", maxWidth: "Size", minHeight: "Size", maxHeight: "Size", theme: "Theme", reusable: "Component", descendants: "Override",
};
/**
 * "Fill Change", "Size Change", "Property Change" for a node edit of these keys. `metadata` is where Canvas keeps auto
 * letter spacing (src/tracking.ts): alone it reads "Auto Letter Spacing"; next to other keys it says nothing new.
 */
export function nodeLabel(keys: string[]): string {
  const real = keys.filter((k) => k !== "metadata");
  if (!real.length && keys.length) return "Auto Letter Spacing";
  const names = [...new Set(real.map((k) => PROP_NAMES[k] ?? k.replace(/^./, (c) => c.toUpperCase()).replace(/([a-z])([A-Z])/g, "$1 $2")))];
  if (names.length === 1) return `${names[0]} Change`;
  // A stroke added or removed writes its paint, weight and position together: one "Stroke Change".
  if (real.every((k) => k.startsWith("stroke"))) return "Stroke Change";
  return "Property Change";
}

// ---------- recording ----------

function size(ops: Op[]): number {
  try {
    return JSON.stringify(ops).length;
  } catch {
    return 0;
  }
}

/**
 * What a step holds in memory: its ops and the parts it keeps for rebasing. Merged edits each leave a part, so the
 * budget counts them too (1,000 keystrokes into a long text kept every intermediate text).
 */
function bytesOf(e: Pick<Entry, "ops" | "parts">): number {
  return size(e.ops) + (e.parts ?? []).reduce((n, p) => n + size(p.ops), 0);
}

/**
 * Fold a step's parts that can no longer be rebased: an edit already on disk (or one without an edit name, a
 * sidecar write) is never replayed again, so neighbouring ones are one part. Parts of edits still waiting for
 * the disk stay apart, so a replay can still find and rebase them (rebaseEdit).
 */
export const compactConfig = { afterMs: 2000 };
function compact(docFile: string, e: Entry): void {
  if (!e.parts || e.parts.length < 2) return;
  const live = pendingEdits(docFile);
  const out: { edit?: string; ops: Op[]; settled: boolean; at?: number }[] = [];
  // A part is folded only a while after it was made: the writer drops an edit from its pending list a moment before
  // it may still replay it (a crossing outside save), and a folded part could no longer be found and rebased.
  const old = Date.now() - compactConfig.afterMs;
  for (const p of e.parts) {
    const settled = !p.edit || (!live.has(p.edit) && (p.at ?? 0) <= old);
    const prev = out.at(-1);
    if (prev && settled && prev.settled) prev.ops = mergeOps(prev.ops, clone(p.ops));
    else out.push({ ...p, settled });
  }
  if (out.length === e.parts.length) return;
  e.parts = out.map(({ settled, ...p }) => (settled ? { ops: p.ops } : p));
}

/** Fold `ops` into `into`: the oldest before and the newest after of each thing. Things back where they started drop out. */
function mergeOps(into: Op[], ops: Op[]): Op[] {
  const out = [...into];
  for (const op of ops) {
    if (op.t === "node") {
      // A structure op is a barrier: a property change folds only into changes made after the last one, or a
      // remove/insert snapshot in between would no longer match on undo.
      const barrier = out.findLastIndex(isStructural);
      const have = out.find((o, i): o is NodeOp => i > barrier && o.t === "node" && o.id === op.id);
      if (!have) out.push({ ...op, props: { ...op.props } });
      else {
        for (const [k, d] of Object.entries(op.props)) have.props[k] = have.props[k] ? { b: have.props[k].b, a: d.a } : d;
        if (op.keys) have.keys = { b: have.keys?.b ?? op.keys.b, a: op.keys.a };
      }
    } else if (isStructural(op)) {
      // Kept in order and never folded: each one depends on the tree the ones before it left.
      out.push(op);
    } else if (op.t === "widget") {
      const at = out.findIndex((o) => o.t === "widget" && o.id === op.id);
      if (at < 0) out.push(op);
      else out[at] = { ...(out[at] as WidgetOp), a: op.a, ai: op.ai };
    } else if (op.t === "doc") {
      const at = out.findIndex((o) => o.t === "doc" && o.key === op.key);
      if (at < 0) out.push(op);
      else {
        const prev = out[at] as DocOp;
        out[at] = { ...prev, a: op.a, ...(op.keys ? { keys: { b: prev.keys?.b ?? op.keys.b, a: op.keys.a } } : {}) };
      }
    } else {
      const at = out.findIndex((o) => o.t === "pages");
      if (at < 0) out.push(op);
      else out[at] = { ...(out[at] as PagesOp), a: op.a };
    }
  }
  return out.filter((o) => {
    if (o.t === "node") {
      for (const [k, d] of Object.entries(o.props)) if (sameVal(d.b, d.a)) delete o.props[k];
      return Object.keys(o.props).length > 0 || !!(o.keys && !same(o.keys.b, o.keys.a));
    }
    if (o.t === "widget") return !same(o.b, o.a);
    if (o.t === "tree") return true;
    if (o.t === "move") return !same(o.b, o.a);
    if (o.t === "doc") return !sameVal(o.b, o.a) || !!(o.keys && !same(o.keys.b, o.keys.a));
    return !same(o.b ?? null, o.a ?? null);
  });
}

/**
 * A burst of moves played on the places of the layers they touch: each layer's place after the step, so a later
 * move of a neighbour (which shifts this layer's index without moving it) is counted. Starts from `at`.
 */
function playMoves(moves: MoveOp[], at = new Map<string, Place>(), check?: (op: MoveOp, now: Place | undefined) => boolean): Map<string, Place> | null {
  for (const op of moves) {
    if (check && !check(op, at.get(op.id))) return null;
    for (const [id, p] of at) {
      if (id === op.id) continue;
      let i = p.index;
      if (p.parent === op.b.parent && i > op.b.index) i--;
      if (p.parent === op.a.parent && i >= op.a.index) i++;
      if (i !== p.index) at.set(id, { parent: p.parent, index: i });
    }
    at.set(op.id, { ...op.a });
  }
  return at;
}

/** Each thing `next` changes starts where `prev` left it (no unrecorded change slipped in between). */
function continuous(prev: Op[], next: Op[]): boolean {
  if (prev.length && prev.every((o) => o.t === "move") && next.length && next.every((o) => o.t === "move")) {
    // An arrow-key reorder burst (src/autolayout.ts place, merge "nudge"): moves chain onto a step of moves only,
    // each starting where the step left that layer, neighbours' moves included. Undo runs them back in reverse.
    const at = playMoves(prev as MoveOp[]);
    return !!at && !!playMoves(next as MoveOp[], at, (op, now) => !now || same(now, op.b));
  }
  for (const op of next) {
    if (op.t === "node") {
      const p = prev.find((o): o is NodeOp => o.t === "node" && o.id === op.id);
      if (p) for (const [k, d] of Object.entries(op.props)) if (p.props[k] && !sameVal(p.props[k].a, d.b)) return false;
    } else if (op.t === "widget") {
      const p = prev.find((o): o is WidgetOp => o.t === "widget" && o.id === op.id);
      if (p && !same(p.a, op.b)) return false;
    } else if (op.t === "move" && prev.length && prev.every((o) => o.t === "move")) {
      // An arrow-key reorder burst (src/autolayout.ts place, merge "nudge"): moves chain onto a step of moves only,
      // each starting where the step left that layer. Undo runs them back in reverse.
      const p = prev.findLast((o): o is MoveOp => o.t === "move" && o.id === op.id);
      if (p && !same(p.a, op.b)) return false;
    } else if (isStructural(op)) {
      // A structure step merges only into one that changed no layers (the cards of a mixed selection deleted with
      // their layers: one step); after layer changes its tree snapshots would no longer match on undo.
      if (prev.some((o) => o.t === "node" || isStructural(o))) return false;
    } else if (op.t === "doc") {
      const p = prev.findLast((o): o is DocOp => o.t === "doc" && o.key === op.key);
      if (p && !sameVal(p.a, op.b)) return false;
    } else {
      const p = prev.find((o): o is PagesOp => o.t === "pages");
      if (p && !same(p.a ?? null, op.b ?? null)) return false;
    }
  }
  return true;
}

function trim(s: Stacks) {
  let bytes = s.undo.reduce((n, e) => n + e.bytes, 0) + s.redo.reduce((n, e) => n + e.bytes, 0);
  while (s.redo.length && bytes > MAX_BYTES) bytes -= s.redo.shift()!.bytes;
  while (s.undo.length > 1 && (s.undo.length > MAX_ENTRIES || bytes > MAX_BYTES)) bytes -= s.undo.shift()!.bytes;
}

/** Record one edit that already happened. Clears redo. Merges per the rules at the top of this file. */
export function record(docFile: string, ops: Op[], meta: RecordMeta, revision?: string): void {
  ops = ops.map((op) => op.t === "doc" && !op.keys && lastDocOrders(docFile) ? { ...op, keys: lastDocOrders(docFile) } : op);
  ops = mergeOps([], ops);
  if (!ops.length) return;
  const part = { edit: meta.edit, ops: clone(ops), at: Date.now() };
  const s = stacks(docFile);
  s.redo = [];
  const t = now();
  const top = s.undo.at(-1);
  if (meta.source === "mcp") {
    for (const f of agentListeners) {
      try {
        f(docFile, meta.session || "mcp", ops);
      } catch (e) {
        console.error(`[canvas] agent edit listener: ${e}`);
      }
    }
  }
  // A follow-up write of a step (joinTop: a structure op's page list, a paste's cards) joins that step even when
  // someone else's step landed on top of it in between (an agent's write in the ~30 ms before the sidecar is
  // written), as long as nothing above touches what it changes: undo takes the steps above back first, then this one whole.
  if (meta.into !== undefined) {
    const at = s.undo.findIndex((e) => e.seq === meta.into);
    const e = s.undo[at];
    if (e && continuous(e.ops, ops) && !touchedAbove(s.undo.slice(at + 1), ops)) {
      e.ops = mergeOps(e.ops, ops);
      e.writers = { ...e.writers, ...lastActionWrites(docFile) };
      e.parts?.push(part);
      if (at === s.undo.length - 1) e.at = t;
      compact(docFile, e);
      e.bytes = bytesOf(e);
      if (!e.ops.length) s.undo.splice(at, 1);
      trim(s);
      notify(docFile);
      return;
    }
  }
  if (meta.source === "mcp") {
    // An agent's edits gather in the step on top while it is that session's open step. Anyone else's edit in
    // between starts a fresh step for the agent's next edits (finish_work names them all): folding across
    // another person's change would make undo erase that change too.
    const session = meta.session || "mcp";
    // ...and only while each value goes on from where the step left it: an outside change in between (a reload)
    // starts a new step, so undo stops at that value instead of erasing it.
    if (top?.agent?.open && top.agent.session === session && !breaks(top.ops, ops)) {
      top.ops = mergeOps(top.ops, ops);
      top.writers = { ...top.writers, ...lastActionWrites(docFile) };
      top.parts?.push(part);
      top.agent.edits++;
      top.at = t;
      if (revision) top.revision = revision;
      compact(docFile, top);
      top.bytes = bytesOf(top);
      if (!top.ops.length) s.undo.pop();
    } else {
      if (top?.agent?.open && top.agent.session === session) top.agent.open = false;
      s.undo.push({ seq: ++seq, label: "Agent Edits", ops, revision, at: t, agent: { session, open: true, edits: 1 }, bytes: bytesOf({ ops, parts: [part] }), parts: [part] });
    }
  } else {
    if (top && !top.agent && meta.mergeKey && top.mergeKey === meta.mergeKey && t - top.at < (meta.mergeMs ?? MERGE_MS) && continuous(top.ops, ops)) {
      top.ops = mergeOps(top.ops, ops);
      top.writers = { ...top.writers, ...lastActionWrites(docFile) };
      top.parts?.push(part);
      top.at = t;
      if (revision) top.revision = revision;
      compact(docFile, top);
      top.bytes = bytesOf(top);
      if (!top.ops.length) s.undo.pop();
    } else s.undo.push({ seq: ++seq, label: meta.label, ops, revision, at: t, mergeKey: meta.mergeKey, bytes: bytesOf({ ops, parts: [part] }), parts: [part], ...(meta.selBefore?.length ? { selBefore: [...meta.selBefore] } : {}), ...(meta.sel?.length ? { sel: [...meta.sel] } : {}) });
  }
  const recorded = s.undo.at(-1);
  if (recorded && !recorded.writers) recorded.writers = lastActionWrites(docFile);
  trim(s);
  notify(docFile);
}

/** The step on top's number (read right after recording one), or null. */
export function topSeq(docFile: string): number | null {
  return files.get(docFile)?.undo.at(-1)?.seq ?? null;
}

/** Files step `seq` added to the document's folder (absolute paths), for its undo to take back. */
export function addStepFiles(docFile: string, seq: number | null, paths: string[]): void {
  if (seq === null || !paths.length) return;
  const e = files.get(docFile)?.undo.find((x) => x.seq === seq);
  if (!e) return;
  const have = new Set((e.files ??= []).map((f) => f.path));
  for (const p of paths) if (!have.has(p)) e.files.push({ path: p });
}

let filesHook: ((docFile: string, list: StepFile[], dir: Dir) => Promise<void>) | null = null;
/** What runs on a step's files after it is undone or redone (src/pastefiles.ts). */
export const setStepFilesHook = (f: typeof filesHook) => void (filesHook = f);

/** Rename the step on top when it is the one recorded under `mergeKey` (a page delete: its boards' step took the page's removal in). */
export function relabelTop(docFile: string, mergeKey: string, label: string): void {
  const top = files.get(docFile)?.undo.at(-1);
  if (!top || top.agent || top.mergeKey !== mergeKey || top.label === label) return;
  top.label = label;
  notify(docFile);
}

/**
 * How a follow-up write joins the step on top (keepOnPage in structure.ts: the page list naming the boards a structure
 * op just made), so one Undo takes both back. Read it right after the step is recorded; null when there is none.
 */
export function joinTop(docFile: string): RecordMeta | null {
  const top = files.get(docFile)?.undo.at(-1);
  if (!top) return null;
  if (top.agent) return top.agent.open ? { label: top.label, source: "mcp", session: top.agent.session, into: top.seq } : null;
  return top.mergeKey ? { label: top.label, source: "user", mergeKey: top.mergeKey, mergeMs: 10_000, into: top.seq } : null;
}

/** What an op changes, as keys two ops share when they touch the same thing (a node, a parent's children, a widget, the page list). */
function touchKeys(o: Op): string[] {
  if (o.t === "pages") return ["pages"];
  if (o.t === "widget") return [`w:${o.id}`];
  if (o.t === "node") return [`n:${o.id}`];
  if (o.t === "doc") return [`d:${o.key}`];
  if (o.t === "move") return [`n:${o.id}`, `p:${o.b.parent}`, `p:${o.a.parent}`];
  return [...idsIn(o.node).map((id) => `n:${id}`), `p:${o.parent}`];
}

/** Do the steps `above` change anything `ops` changes? Then `ops` cannot join a step below them. */
function touchedAbove(above: Entry[], ops: Op[]): boolean {
  if (!above.length) return false;
  const keys = new Set(above.flatMap((e) => e.ops.flatMap(touchKeys)));
  return ops.some((o) => touchKeys(o).some((k) => keys.has(k)));
}

/**
 * An edit not yet on disk was replayed on someone else's bytes (docwriter.ts): the step holding it takes the ops it
 * applied as (a nudge of +1 from x=0 replayed on x=100 now undoes to 100), or loses it (null: it could not be
 * replayed). A step left with nothing goes.
 */
export function rebaseEdit(docFile: string, edit: string, ops: Op[] | null): void {
  const s = files.get(docFile);
  if (!s) return;
  let hit = false;
  for (const [stack, older] of [[s.undo, true], [s.redo, false]] as const) {
    for (let at = 0; at < stack.length; at++) {
      const e = stack[at];
      const i = e.parts?.findIndex((p) => p.edit === edit) ?? -1;
      if (i < 0) continue;
      if (ops === null) e.parts!.splice(i, 1);
      else e.parts![i] = { edit, ops: clone(mergeOps([], clone(ops))), at: e.parts![i].at };
      const split = regroup(e);
      // Undo runs the newest step first: on the undo stack the older half sits below; on redo, above.
      stack.splice(at, 1, ...(older ? split : [...split].reverse()));
      at += split.length - 1;
      hit = true;
    }
  }
  if (!hit) return;
  s.undo = s.undo.filter((e) => e.ops.length);
  s.redo = s.redo.filter((e) => e.ops.length);
  notify(docFile);
}

/** Does `next` start somewhere else than where `prev` left a value (a replay moved it)? */
function breaks(prev: Op[], next: Op[]): boolean {
  // Where `prev` left each value: the after-value of the last op that set it; a structure op naming the node (it
  // may move it under another parent, changing what its position means) leaves it unknown, which counts as a break.
  const last = new Map<string, Val | "unknown">();
  for (const o of prev) {
    if (o.t === "node") {
      for (const [k, d] of Object.entries(o.props)) last.set(`${o.id}\n${k}`, d.a);
      continue;
    }
    const moved = o.t === "move" ? [o.id] : o.t === "tree" ? idsIn(o.node) : [];
    for (const id of moved) for (const key of last.keys()) if (key.startsWith(`${id}\n`)) last.set(key, "unknown");
  }
  for (const op of next) {
    if (op.t === "widget") {
      // A widget (or the page list) that changed outside between two of the agent's edits: undo must stop there.
      const p = prev.findLast((o): o is WidgetOp => o.t === "widget" && o.id === op.id);
      if (p && !same(p.a, op.b)) return true;
      continue;
    }
    if (op.t === "pages") {
      const p = prev.findLast((o): o is PagesOp => o.t === "pages");
      if (p && !same(p.a ?? null, op.b ?? null)) return true;
      continue;
    }
    if (op.t === "doc") {
      const p = prev.findLast((o): o is DocOp => o.t === "doc" && o.key === op.key);
      if (p && !sameVal(p.a, op.b)) return true;
      continue;
    }
    if (op.t !== "node") continue;
    for (const [k, d] of Object.entries(op.props)) {
      const was = last.get(`${op.id}\n${k}`);
      if (was === undefined) continue;
      if (was === "unknown" || !sameVal(was, d.b)) return true;
    }
  }
  return false;
}

/**
 * Fold a step's parts again after a rebase. Where one part no longer starts where the one before it ended (an edit
 * already on disk, then one replayed on an outside value), folding across would make undo jump over the outside
 * value: the step splits there, oldest part first.
 */
function regroup(e: Entry): Entry[] {
  const groups: { edit?: string; ops: Op[] }[][] = [];
  let fold: Op[] = [];
  for (const p of e.parts ?? []) {
    if (groups.length && breaks(fold, p.ops)) {
      groups.push([p]);
      fold = mergeOps([], clone(p.ops));
    } else {
      if (!groups.length) groups.push([]);
      groups.at(-1)!.push(p);
      fold = mergeOps(fold, clone(p.ops));
    }
  }
  if (!groups.length) groups.push([]);
  const out = groups.map((parts, i): Entry => {
    const ops = parts.reduce<Op[]>((acc, p) => mergeOps(acc, clone(p.ops)), []);
    if (i === 0) return Object.assign(e, { parts, ops, bytes: bytesOf({ ops, parts }) });
    return { seq: ++seq, label: e.label, ops, parts, writers: e.writers && { ...e.writers }, revision: e.revision, at: 0, mergeKey: e.mergeKey, bytes: bytesOf({ ops, parts }) };
  });
  if (out.length > 1 && e.agent) {
    // The newest half carries the agent's step on; the older ones are closed.
    out.at(-1)!.agent = e.agent;
    e.agent = { ...e.agent, open: false };
  }
  return out;
}
writerHooks.replayed = rebaseEdit;
writerHooks.applyOps = (doc, ops) => replayOps(doc as unknown as Doc, ops);

/** A node's own properties (no children), copied: what nodeDiff compares. */
export function propsOf(n: DocNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) if (k !== "children" && v !== undefined) out[k] = structuredClone(v);
  // Where children sat among the keys, for keyOrders (not a property: entries and JSON never see it).
  Object.defineProperty(out, KEY_ORDER, { value: Object.keys(n).filter((k) => n[k] !== undefined) });
  return out;
}

/** The node op between two copies of a node's properties (propsOf): every key that differs. */
export function nodeDiff(id: string, before: Record<string, unknown>, after: Record<string, unknown>): NodeOp {
  const out: NodeOp = { t: "node", id, props: {} };
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = valOf(before, k), a = valOf(after, k);
    if (!sameVal(b, a)) out.props[k] = { b, a };
  }
  const keys = keyOrders(before, after);
  if (keys) out.keys = keys;
  return out;
}

/** The ops between two states of the sidecar: each widget that changed, and the page list when it did. */
export function envelopeOps(before: EnvelopeState, after: EnvelopeState): Op[] {
  const ops: Op[] = [];
  const bi = new Map(before.widgets.map((w, i) => [w.id, i]));
  const ai = new Map(after.widgets.map((w, i) => [w.id, i]));
  for (const id of new Set([...bi.keys(), ...ai.keys()])) {
    const b = bi.has(id) ? before.widgets[bi.get(id)!] : null;
    const a = ai.has(id) ? after.widgets[ai.get(id)!] : null;
    if (!same(b, a)) ops.push({ t: "widget", id, b: clone(b), a: clone(a), bi: bi.get(id) ?? -1, ai: ai.get(id) ?? -1 });
  }
  if (!same(before.extra.pages ?? null, after.extra.pages ?? null)) ops.push({ t: "pages", b: clone(before.extra.pages), a: clone(after.extra.pages) });
  return ops;
}

// Every sidecar write made with a `record` option lands here.
envelopeHook.fn = (docFile, before, after, meta) => record(docFile, envelopeOps(before, after), meta as RecordMeta);

/** An agent finished: its open steps (one session's, or every open one) close and take the summary as their name. */
export function finishAgent(session: string | undefined, summary?: string): number {
  let n = 0;
  for (const [docFile, s] of files) {
    let hit = false;
    for (const e of s.undo) {
      if (!e.agent?.open || (session && e.agent.session !== session)) continue;
      e.agent.open = false;
      e.label = summary ? `Agent: ${summary}` : "Agent Edits";
      hit = true;
      n++;
    }
    if (hit) notify(docFile);
  }
  return n;
}

// ---------- undo / redo ----------

type Dir = "undo" | "redo";
const wantOf = <T>(dir: Dir, b: T, a: T) => (dir === "undo" ? a : b);
const toOf = <T>(dir: Dir, b: T, a: T) => (dir === "undo" ? b : a);

const nodeName = (n: DocNode) => (typeof n.name === "string" && n.name ? `"${n.name}"` : `"${n.id}"`);
const widgetName = (w: Widget | null | undefined, id: string) => (w?.name ? `widget "${w.name}"` : `widget "${id}"`);

/** What in the document no longer matches what the step left. Empty: the step can be reversed. */
function docConflicts(doc: { children: DocNode[] }, ops: NodeOp[], dir: Dir): string[] {
  const out: string[] = [];
  for (const op of ops) {
    let node: DocNode;
    try {
      node = findNode(doc as any, op.id).node;
    } catch {
      out.push(`node "${op.id}" was deleted`);
      continue;
    }
    const keys = Object.entries(op.props).filter(([k, d]) => !sameVal(valOf(node, k), wantOf(dir, d.b, d.a))).map(([k]) => k);
    if (keys.length) out.push(`${nodeName(node)} ${[...new Set(keys.map((k) => (PROP_NAMES[k] ?? k).toLowerCase()))].join(", ")}`);
  }
  return out;
}

/** Document keys (variables, themes, fonts) that no longer hold what the step left. */
function docKeyConflicts(doc: { children: DocNode[] }, ops: DocOp[], dir: Dir): string[] {
  return ops.filter((op) => !sameVal(valOf(doc as unknown as Record<string, unknown>, op.key), wantOf(dir, op.b, op.a))).map((op) => `the document's ${op.key}`);
}

function envConflicts(widgets: Widget[], extra: Record<string, unknown>, ops: Op[], dir: Dir): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op.t === "pages") {
      if (!same(extra.pages ?? null, wantOf(dir, op.b, op.a) ?? null)) out.push("the pages");
      continue;
    }
    if (op.t !== "widget") continue;
    const want = wantOf(dir, op.b, op.a);
    const cur = widgets.find((w) => w.id === op.id);
    if (want === null) {
      if (cur) out.push(`${widgetName(cur, op.id)} exists again`);
      continue;
    }
    if (!cur) {
      out.push(`${widgetName(want, op.id)} was deleted`);
      continue;
    }
    const to = toOf(dir, op.b, op.a);
    const keys = to === null ? Object.keys(want) : [...new Set([...Object.keys(want), ...Object.keys(to)])].filter((k) => !same((want as any)[k], (to as any)[k]));
    if (keys.some((k) => !same((cur as any)[k], (want as any)[k]))) out.push(widgetName(cur, op.id));
  }
  return out;
}

function applyEnv(widgets: Widget[], extra: Record<string, unknown>, ops: Op[], dir: Dir): void {
  const wops = ops.filter((o): o is WidgetOp => o.t === "widget");
  // Removals first, then changes, then insertions in index order, so restored widgets land where they were.
  for (const op of wops) {
    const to = toOf(dir, op.b, op.a);
    if (to !== null) continue;
    const at = widgets.findIndex((w) => w.id === op.id);
    if (at >= 0) widgets.splice(at, 1);
  }
  for (const op of wops) {
    const want = wantOf(dir, op.b, op.a), to = toOf(dir, op.b, op.a);
    if (want === null || to === null) continue;
    const cur = widgets.find((w) => w.id === op.id)! as Record<string, unknown>;
    for (const k of new Set([...Object.keys(want), ...Object.keys(to)])) {
      if (same((want as any)[k], (to as any)[k])) continue;
      if ((to as any)[k] === undefined) delete cur[k];
      else cur[k] = clone((to as any)[k]);
    }
  }
  const adds = wops.filter((op) => wantOf(dir, op.b, op.a) === null && toOf(dir, op.b, op.a) !== null).sort((x, y) => toOf(dir, x.bi, x.ai) - toOf(dir, y.bi, y.ai));
  for (const op of adds) {
    const idx = toOf(dir, op.bi, op.ai);
    widgets.splice(idx < 0 ? widgets.length : Math.min(idx, widgets.length), 0, clone(toOf(dir, op.b, op.a)!));
  }
  for (const op of ops) if (op.t === "pages") extra.pages = clone(toOf(dir, op.b, op.a));
}

const refuse = (dir: Dir, e: Entry, what: string[]) =>
  new HistoryError(409, "conflict", `Can't ${dir} ${e.label}: ${what.slice(0, 3).join("; ")}${what.length > 3 ? ` and ${what.length - 3} more` : ""} changed since. Nothing was changed.`);

// ---------- structure: tree ops in order ----------

type Doc = { children: DocNode[] };
/** Where a node sits: its parent's id (null: the document), its index and the list it is in. */
export function placeOf(doc: Doc, id: string): (Place & { node: DocNode; list: DocNode[] }) | null {
  try {
    const f = findNode(doc as any, id);
    return { parent: f.parent ? String(f.parent.id) : null, index: f.index, node: f.node, list: f.siblings };
  } catch {
    return null;
  }
}
/** The children list of a place's parent, or a reason it cannot take children. */
function listOf(doc: Doc, parent: string | null): DocNode[] | string {
  if (parent === null) return doc.children;
  const p = placeOf(doc, parent);
  if (!p) return `"${parent}" was deleted`;
  if (p.node.type !== "frame" && p.node.type !== "group") return `${nodeName(p.node)} can no longer hold layers`;
  if (!Array.isArray(p.node.children)) p.node.children = [];
  return p.node.children as DocNode[];
}
/** Component ids a subtree's instances use (overrides included), not counting components inside the subtree itself. */
function refsOf(n: DocNode): string[] {
  const inside = new Set(idsIn(n));
  const out = new Set<string>();
  const look = (x: DocNode) => {
    if (typeof x.ref === "string" && !inside.has(x.ref)) out.add(x.ref);
    for (const c of (x.children as DocNode[] | undefined) ?? []) look(c);
    for (const d of Object.values((x.descendants as Record<string, DocNode> | undefined) ?? {})) if (d && typeof d === "object" && !Array.isArray(d)) look(d);
  };
  look(n);
  return [...out];
}
function idsIn(n: DocNode, out: string[] = []): string[] {
  if (typeof n.id === "string") out.push(n.id);
  for (const c of (n.children as DocNode[] | undefined) ?? []) idsIn(c, out);
  return out;
}

/** An instance anywhere in the document (overrides included) that uses one of these ids as its component. */
function refUser(doc: Doc, ids: Set<string>): string | null {
  let hit: string | null = null;
  const look = (n: DocNode) => {
    if (hit) return;
    if (typeof n.ref === "string" && ids.has(n.ref)) hit = String(n.id);
    for (const c of (n.children as DocNode[] | undefined) ?? []) look(c);
    for (const d of Object.values((n.descendants as Record<string, DocNode> | undefined) ?? {})) if (d && typeof d === "object") look(d);
  };
  doc.children.forEach(look);
  return hit;
}

/** Undo (reverse order, each op backwards) or redo the ops of a structure step on `doc`. Throws the step's conflict at the first op the document does not match. */
function runSequence(doc: Doc, ops: Op[], dir: Dir, e: Entry): void {
  const list = dir === "undo" ? [...ops].reverse() : ops;
  const fail = (what: string) => {
    throw refuse(dir, e, [what]);
  };
  const inserted: DocNode[] = [];
  const removed: DocNode[] = [];
  for (const op of list) {
    if (op.t === "doc") {
      if (!sameVal(valOf(doc as unknown as Record<string, unknown>, op.key), wantOf(dir, op.b, op.a))) fail(`the document's ${op.key}`);
      writeDocKey(doc, op.key, toOf(dir, op.b, op.a), op.keys && toOf(dir, op.keys.b, op.keys.a));
    } else if (op.t === "node") {
      const c = docConflicts(doc, [op], dir);
      if (c.length) fail(c[0]);
      const set: Record<string, Json> = {};
      const remove: string[] = [];
      for (const [k, d] of Object.entries(op.props)) {
        const to = toOf(dir, d.b, d.a);
        if (to === null) remove.push(k);
        else set[k] = clone(to.v);
      }
      orderKeys(updateNode(doc as any, op.id, set, remove), op.keys && toOf(dir, op.keys.b, op.keys.a));
    } else if (op.t === "tree") {
      // Undoing an insert removes; undoing a remove inserts.
      const adding = (op.kind === "insert") === (dir === "redo");
      const id = String(op.node.id);
      if (adding) {
        const kids = listOf(doc, op.parent);
        if (typeof kids === "string") fail(kids);
        const taken = allIds(doc as any);
        const clash = idsIn(op.node).find((i) => taken.has(i));
        if (clash) fail(`"${clash}" exists again`);
        const added = clone(op.node);
        (kids as DocNode[]).splice(Math.min(op.index, (kids as DocNode[]).length), 0, added);
        inserted.push(added);
      } else {
        const at = placeOf(doc, id);
        if (!at) fail(`${nodeName(op.node)} was deleted`);
        else if (at.parent !== op.parent) fail(`${nodeName(at.node)} moved`);
        else if (!same(at.node, op.node)) fail(`${nodeName(at.node)} or a layer inside it`);
        else {
          at.list.splice(at.index, 1);
          removed.push(at.node);
        }
      }
    } else if (op.t === "move") {
      const want = wantOf(dir, op.b, op.a), to = toOf(dir, op.b, op.a);
      const at = placeOf(doc, op.id);
      if (!at) fail(`"${op.id}" was deleted`);
      else if (at.parent !== want.parent || at.index !== want.index) fail(`${nodeName(at.node)} moved`);
      else {
        if (to.parent !== null && (to.parent === op.id || idsIn(at.node).includes(to.parent))) fail(`${nodeName(at.node)} moved`);
        const kids = listOf(doc, to.parent);
        if (typeof kids === "string") fail(kids);
        at.list.splice(at.index, 1);
        (kids as DocNode[]).splice(Math.min(to.index, (kids as DocNode[]).length), 0, at.node);
      }
    }
  }
  // Checked once every op ran (a step may remove an instance after its component, or insert an instance before its
  // component): instances made since that use a component the step took away would point at nothing...
  const left = allIds(doc as any);
  for (const n of removed) {
    const gone = new Set(idsIn(n).filter((i) => !left.has(i)));
    const user = gone.size ? refUser(doc, gone) : null;
    if (user) fail(`an instance (${user}) now uses a component inside ${nodeName(n)}`);
  }
  // ...and instances brought back must find their components (one deleted since would leave them pointing at nothing).
  const missing = missingRef(doc, inserted);
  if (missing) fail(`the component "${missing.ref}" that ${nodeName(missing.node)} uses is gone`);
}

/** The first component one of these subtrees uses that the document no longer holds as a component. */
function missingRef(doc: Doc, nodes: DocNode[]): { ref: string; node: DocNode } | null {
  let index: ReturnType<typeof buildIndex> | undefined;
  for (const n of nodes) {
    const refs = refsOf(n);
    if (!refs.length) continue;
    index ??= buildIndex(doc as any);
    const ref = refs.find((r) => index!.get(r)?.reusable !== true);
    if (ref) return { ref, node: n };
  }
  return null;
}

/** The ops that undo `ops`, in the order they run (forward, as replayOps runs them). */
export function invertOps(ops: Op[]): Op[] {
  return [...ops].reverse().map((o): Op => {
    if (o.t === "node") return { t: "node", id: o.id, props: Object.fromEntries(Object.entries(o.props).map(([k, d]) => [k, { b: clone(d.a), a: clone(d.b) }])), ...(o.keys ? { keys: { b: o.keys.a.slice(), a: o.keys.b.slice() } } : {}) };
    if (o.t === "tree") return { ...o, kind: o.kind === "insert" ? "remove" : "insert", node: clone(o.node) };
    if (o.t === "move") return { t: "move", id: o.id, b: { ...o.a }, a: { ...o.b } };
    if (o.t === "doc") return { t: "doc", key: o.key, b: clone(o.a), a: clone(o.b), ...(o.keys ? { keys: { b: o.keys.a.slice(), a: o.keys.b.slice() } } : {}) };
    return clone(o);
  });
}

/** Set a document-level key to a value (null: remove it). */
function writeDocKey(doc: Doc, key: string, to: Val, order?: string[]): void {
  const d = doc as unknown as Record<string, unknown>;
  if (to === null) delete d[key];
  else d[key] = clone(to.v);
  orderKeys(d, order);
}

/**
 * A structure edit's ops replayed on another version of the document (src/docwriter.ts, after an outside save,
 * before the edit reached the disk): the same ids at the same places, so later edits that name them still work.
 * Returns the ops as they applied here (what was really removed, where things really were). Throws when the
 * document cannot take them (a parent or node gone, an id taken); the caller runs it on a copy.
 */
export function replayOps(doc: Doc, ops: Op[]): Op[] {
  const out: Op[] = [];
  const inserted: DocNode[] = [], removed: DocNode[] = [];
  for (const op of ops) {
    if (op.t === "node") {
      let node: DocNode;
      try {
        node = findNode(doc as any, op.id).node;
      } catch {
        throw new Error(`node "${op.id}" was deleted`);
      }
      const set: Record<string, Json> = {};
      const remove: string[] = [];
      const props: NodeOp["props"] = {};
      for (const [k, d] of Object.entries(op.props)) {
        const b = valOf(node, k);
        if (d.a === null) remove.push(k);
        else set[k] = clone(d.a.v);
        if (!sameVal(b, d.a)) props[k] = { b, a: d.a === null ? null : { v: clone(d.a.v) } };
      }
      const keysBefore = Object.keys(node);
      orderKeys(updateNode(doc as any, op.id, set, remove), op.keys?.a);
      if (Object.keys(props).length) out.push({ t: "node", id: op.id, props, ...(op.keys ? { keys: { b: keysBefore, a: op.keys.a.slice() } } : {}) });
    } else if (op.t === "doc") {
      const b = valOf(doc as unknown as Record<string, unknown>, op.key);
      const keys = op.keys ? { b: Object.keys(doc), a: op.keys.a.slice() } : undefined;
      writeDocKey(doc, op.key, op.a, op.keys?.a);
      if (!sameVal(b, op.a) || keys) out.push({ t: "doc", key: op.key, b, a: clone(op.a), ...(keys ? { keys } : {}) });
    } else if (op.t === "tree") {
      if (op.kind === "insert") {
        const kids = listOf(doc, op.parent);
        if (typeof kids === "string") throw new Error(kids);
        const taken = allIds(doc as any);
        const clash = idsIn(op.node).find((i) => taken.has(i));
        if (clash) throw new Error(`"${clash}" exists already`);
        const at = Math.min(op.index, kids.length);
        const added = clone(op.node);
        kids.splice(at, 0, added);
        inserted.push(added);
        out.push({ t: "tree", kind: "insert", parent: op.parent, index: at, node: clone(op.node) });
      } else {
        const id = String(op.node.id);
        const at = placeOf(doc, id);
        if (!at) throw new Error(`${nodeName(op.node)} was deleted`);
        if (at.parent !== op.parent) throw new Error(`${nodeName(at.node)} moved`);
        // The subtree must hold the same layers it held when the edit was made: one added inside it meanwhile
        // (someone else's) would go with it.
        const now = idsIn(at.node).sort().join("\n"), then = idsIn(op.node).sort().join("\n");
        if (now !== then) throw new Error(`${nodeName(at.node)} holds other layers now`);
        at.list.splice(at.index, 1);
        removed.push(at.node);
        out.push({ t: "tree", kind: "remove", parent: at.parent, index: at.index, node: clone(at.node) });
      }
    } else if (op.t === "move") {
      const at = placeOf(doc, op.id);
      if (!at) throw new Error(`"${op.id}" was deleted`);
      if (at.parent !== op.b.parent) throw new Error(`${nodeName(at.node)} moved`);
      if (op.a.parent !== null && (op.a.parent === op.id || idsIn(at.node).includes(op.a.parent))) throw new Error(`${nodeName(at.node)} moved`);
      const from = { parent: at.parent, index: at.index };
      at.list.splice(at.index, 1);
      const kids = listOf(doc, op.a.parent);
      if (typeof kids === "string") throw new Error(kids);
      const to = Math.min(op.a.index, kids.length);
      kids.splice(to, 0, at.node);
      out.push({ t: "move", id: op.id, b: from, a: { parent: op.a.parent, index: to } });
    }
  }
  // Components are checked once every op ran: a duplicate or paste may insert an instance before its component.
  // An instance the edit took away with its component is no user of it; one that stays (made meanwhile) is.
  const left = allIds(doc as any);
  for (const n of removed) {
    const gone = new Set(idsIn(n).filter((i) => !left.has(i)));
    const user = gone.size ? refUser(doc, gone) : null;
    if (user) throw new Error(`an instance (${user}) now uses a component inside ${nodeName(n)}`);
  }
  // Every component an inserted subtree uses must still exist as a component here (it may have been deleted meanwhile).
  const missing = missingRef(doc, inserted);
  if (missing) throw new Error(`the component "${missing.ref}" it uses is gone`);
  return out;
}

export type ApplyHooks = { docWritten?: (docFile: string, revision: string) => void };

/** Reverse (undo) or replay (redo) one entry. Throws HistoryError 409 conflict without writing anything when the document moved. */
async function apply(docFile: string, e: Entry, dir: Dir, hooks: ApplyHooks): Promise<string | undefined> {
  // The edits the step held when it was picked. A rebase that splits it (or drops a part) before this undo runs or
  // replays would leave `e` as only a part of what was asked for, starting below an outside value: refuse then.
  const picked = (e.parts ?? []).map((p) => p.edit).join("\n");
  const unsplit = () => {
    if ((e.parts ?? []).map((p) => p.edit).join("\n") !== picked) throw refuse(dir, e, ["the document"]);
  };
  const nodeOps = e.ops.filter((o): o is NodeOp => o.t === "node");
  const docOps = e.ops.filter((o): o is DocOp => o.t === "doc");
  const envOps = e.ops.filter((o) => o.t === "widget" || o.t === "pages");
  const layerOp = (o: Op) => o.t === "node" || o.t === "doc" || isStructural(o);
  // A step with structure changes runs its tree, node and document ops in order (reversed for undo).
  const seqOps = e.ops.some(isStructural) ? e.ops.filter(layerOp) : null;
  const store = envOps.length ? await storeForAsync(docFile) : undefined;
  // Check both halves before writing either, so a refused step leaves everything as it was.
  if (store) {
    const st = store.peek();
    const c = envConflicts(st.widgets, st.extra, envOps, dir);
    if (c.length) throw refuse(dir, e, c);
  }
  let revision: string | undefined;
  // Every node and parent the ops name: their boards are the ones the step changes (docwriter.ts copies them first,
  // so a step that throws halfway leaves the document as it was, and no dry run on a copy of everything is needed).
  const touches = new Set<string | null>();
  for (const o of e.ops) {
    if (o.t === "node") touches.add(o.id);
    else if (o.t === "tree") touches.add(o.parent).add(String(o.node.id));
    else if (o.t === "move") touches.add(o.id).add(o.b.parent).add(o.a.parent);
  }
  /** The design file's half of the step, run in direction `d` (the other way puts it back when the cards' half fails). */
  const writeLayers = (d: Dir): string | undefined => {
    for (let attempt = 0; ; attempt++) {
      const loaded = currentDoc(docFile);
      const c = seqOps ? [] : [...docConflicts(loaded.doc, nodeOps, d), ...docKeyConflicts(loaded.doc, docOps, d)];
      if (c.length) throw refuse(d, e, c);
      try {
        // What the step does, as ops that run forward (the crash journal keeps them): redo as recorded, undo inverted.
        const recorded = seqOps ? () => { const now = e.ops.filter(layerOp); return d === "redo" ? clone(now) : invertOps(now); } : undefined;
        const { write } = editDoc(docFile, { expectedRevision: loaded.revision, touches, deep: !!seqOps, urgent: !!seqOps, recorded }, (doc) => {
          // The step's ops as they are when this runs: a replay after an outside save may have rebased them.
          if (d === dir) unsplit();
          const seqNow = seqOps ? e.ops.filter(layerOp) : null;
          if (seqNow) return void runSequence(doc, seqNow, d, e);
          const nodeNow = e.ops.filter((o): o is NodeOp => o.t === "node");
          const docNow = e.ops.filter((o): o is DocOp => o.t === "doc");
          // The same check on the bytes the write is based on.
          const c2 = [...docConflicts(doc, nodeNow, d), ...docKeyConflicts(doc, docNow, d)];
          if (c2.length) throw refuse(d, e, c2);
          for (const op of docNow) writeDocKey(doc as unknown as Doc, op.key, toOf(d, op.b, op.a), op.keys && toOf(d, op.keys.b, op.keys.a));
          for (const op of nodeNow) {
            const set: Record<string, Json> = {};
            const remove: string[] = [];
            for (const [k, v] of Object.entries(op.props)) {
              const to = toOf(d, v.b, v.a);
              if (to === null) remove.push(k);
              else set[k] = clone(to.v);
            }
            orderKeys(updateNode(doc, op.id, set, remove), op.keys && toOf(d, op.keys.b, op.keys.a));
          }
        });
        const rev = write.revision ?? revisionOf(stateHashOf(loadDoc(docFile)));
        if (rev) hooks.docWritten?.(docFile, rev);
        return rev;
      } catch (err) {
        if (err instanceof StaleFileError && attempt < 2) continue;
        throw err;
      }
    }
  };
  const layers = !!(nodeOps.length || docOps.length || seqOps);
  if (layers) revision = writeLayers(dir);
  if (store) {
    try {
      await store.mutateEnvelope((widgets, extra) => {
        if (!layers) unsplit();
        const c = envConflicts(widgets, extra, envOps, dir);
        if (c.length) throw refuse(dir, e, c);
        applyEnv(widgets, extra, envOps, dir);
        return { widgets, extra };
      });
    } catch (err) {
      // The cards' half failed after the layers' half was written: put the layers back, so the step stays whole
      // (on its stack, where it was) and can run again, instead of half reversed and refusing every retry.
      if (layers) {
        try {
          writeLayers(dir === "undo" ? "redo" : "undo");
        } catch (back) {
          console.error(`[canvas] ${dir}: the cards could not be changed and the layers could not be put back: ${(back as Error).message}`);
          if (err instanceof Error) err.message += " The layers were changed but the cards were not.";
        }
      }
      throw err;
    }
  }
  return revision;
}

export type StepResult = { label: string; revision?: string; skipped?: true; state: HistoryState; select?: string[]; boards?: Record<string, string> };

/**
 * The board each selected layer is on (a board: itself), so the page can show the page of an Undo's change before
 * it selects it: without it the layers would be selected on a page that does not draw them.
 */
export function boardsOf(ids: string[], doc: { children: DocNode[] }): Record<string, string> {
  const want = new Set(ids.filter((id) => !id.startsWith("widget:")));
  const out: Record<string, string> = {};
  if (!want.size) return out;
  const visit = (list: DocNode[], board: string) => {
    for (const n of list) {
      if (want.has(String(n.id))) out[String(n.id)] = board;
      if (Array.isArray(n.children)) visit(n.children as DocNode[], board);
    }
  };
  for (const b of doc.children) {
    if (want.has(String(b.id))) out[String(b.id)] = String(b.id);
    if (Array.isArray(b.children)) visit(b.children as DocNode[], String(b.id));
  }
  return out;
}

/**
 * What the page selects after a step, restoring the selection each step had: the layers and cards the
 * step touched that are in the document once it ran (inserted, moved or edited), outermost only. A step that only
 * removed things selects nothing. Parents that merely lost or gained a child are left out.
 */
export function stepSelection(ops: Op[], dir: Dir, doc: { children: DocNode[] } | null): string[] {
  const want: string[] = [];
  const add = (id: string | null | undefined) => { if (id && !want.includes(id)) want.push(id); };
  for (const o of ops) {
    if (o.t === "node") add(o.id);
    else if (o.t === "move") add(o.id);
    else if (o.t === "tree") { const kind = dir === "undo" ? (o.kind === "insert" ? "remove" : "insert") : o.kind; if (kind === "insert") add(String(o.node.id)); }
    else if (o.t === "widget") { if ((dir === "undo" ? o.b : o.a) !== null) add("widget:" + o.id); }
  }
  if (!doc) return want.filter((id) => id.startsWith("widget:"));
  const parentOf = new Map<string, string | null>();
  // Layers parked in the hidden "Deleted components" frame (structure.ts) are gone as far as the person sees: not selected.
  const parked = new Set<string>();
  const visit = (list: DocNode[], parent: string | null, hidden: boolean) => {
    for (const n of list) {
      const id = String(n.id);
      parentOf.set(id, parent);
      const h = hidden || (parent === null && (n.metadata as Record<string, unknown> | undefined)?.canvasDeletedComponents === true);
      if (h) parked.add(id);
      if (Array.isArray(n.children)) visit(n.children as DocNode[], id, h);
    }
  };
  visit(doc.children, null, false);
  const there = want.filter((id) => id.startsWith("widget:") || (parentOf.has(id) && !parked.has(id)));
  const set = new Set(there);
  return there.filter((id) => { for (let p = parentOf.get(id) ?? null; p; p = parentOf.get(p) ?? null) if (set.has(p)) return false; return true; });
}

/** A refused step and when: pressing again within this window skips it. */
const SKIP_MS = 10_000;
const refused = new Map<string, { seq: number; at: number }>();

/**
 * Undo the newest step. A step that conflicts stays where it is (redo is untouched) and the error says what
 * moved; undoing again within 10 s, or `skip: true`, drops it, so the next undo reaches the step before.
 */
export async function undo(docFile: string, hooks: ApplyHooks = {}, opts: { skip?: boolean; expect?: number } = {}): Promise<StepResult> {
  return step(docFile, "undo", hooks, opts);
}
export async function redo(docFile: string, hooks: ApplyHooks = {}, opts: { skip?: boolean; expect?: number } = {}): Promise<StepResult> {
  return step(docFile, "redo", hooks, opts);
}

const busy = new Map<string, Promise<unknown>>();

async function step(docFile: string, dir: Dir, hooks: ApplyHooks, opts: { skip?: boolean; expect?: number }): Promise<StepResult> {
  // One step at a time per document: a held-down Cmd+Z must not run two reversals on the same base.
  const prev = busy.get(docFile) ?? Promise.resolve();
  const run = async (): Promise<StepResult> => {
    const s = stacks(docFile);
    const from = dir === "undo" ? s.undo : s.redo;
    const e = from.at(-1);
    if (!e) throw new HistoryError(409, "empty", dir === "undo" ? "Nothing to undo" : "Nothing to redo");
    // The page drew the step it expected on top (peekOf); another step got there first, so nothing runs.
    if (opts.expect !== undefined && e.seq !== opts.expect) throw new HistoryError(409, "moved", `The ${dir} step changed before it ran. Nothing was changed.`);
    const key = `${docFile}\n${dir}`;
    const last = refused.get(key);
    const again = last?.seq === e.seq && now() - last.at < SKIP_MS;
    if (opts.skip) {
      from.pop();
      refused.delete(key);
      notify(docFile);
      return { label: e.label, skipped: true, state: historyState(docFile) };
    }
    let revision: string | undefined;
    try {
      revision = await asOneAction(docFile, () => apply(docFile, e, dir, hooks), undefined, e.writers);
      const writes = lastActionWrites(docFile);
      // Undoing a later step restores an earlier step's value with a new writer. The next undo must name that
      // writer. Outside edits never enter here, so a change away and back still fails its precondition.
      for (const entry of [...s.undo, ...s.redo]) entry.writers = { ...entry.writers, ...writes };
    } catch (err) {
      if (!(err instanceof HistoryError) || err.code !== "conflict") throw err;
      // The second press on the same blocked step drops it, so the one before is reachable; nothing is written.
      if (again) {
        from.pop();
        refused.delete(key);
        notify(docFile);
        return { label: e.label, skipped: true, state: historyState(docFile) };
      }
      refused.set(key, { seq: e.seq, at: now() });
      err.message += ` ${dir === "undo" ? "Undo" : "Redo"} again to skip this step.`;
      throw err;
    }
    refused.delete(key);
    // `e` itself: a rebase while the step ran may have put a split-off part above it.
    const at = from.lastIndexOf(e);
    if (at >= 0) from.splice(at, 1);
    if (e.agent) e.agent.open = false; // an undone agent step never takes more edits
    // A step made by Canvas's own agent run (talk to the selection: its MCP session is "run-<id>", src/agent-run.ts).
    if (dir === "undo" && e.agent?.session.startsWith("run-")) countUsage("agent.run_undone");
    e.at = 0; // a reversed step never merges with the next edit
    if (revision) e.revision = revision;
    (dir === "undo" ? s.redo : s.undo).push(e);
    notify(docFile);
    if (e.files?.length && filesHook) await filesHook(docFile, e.files, dir).catch((err) => console.error(`[canvas] ${dir}: the step's files: ${(err as Error).message}`));
    let doc: { children: DocNode[] } | null = null;
    try { doc = currentDoc(docFile).doc as { children: DocNode[] }; } catch { /* a cards-only document */ }
    let select = stepSelection(e.ops, dir, doc);
    // A step made with a selection of its own (a group resized by its handles) selects that again, when it is all there.
    if (e.sel && doc) { const again = stepSelection(e.sel.map((id) => ({ t: "node", id }) as unknown as Op), dir, doc); if (again.length === e.sel.length) select = again; }
    // Undo of a Duplicate leaves nothing it touched: the originals selected before it come back.
    if (!select.length && dir === "undo" && e.selBefore && doc) select = stepSelection(e.selBefore.map((id) => ({ t: "node", id }) as unknown as Op), dir, doc);
    return { label: e.label, revision, state: historyState(docFile), select, ...(doc ? { boards: boardsOf(select, doc) } : {}) };
  };
  const p = prev.then(run, run);
  busy.set(docFile, p.catch(() => undefined));
  return p;
}

// ---------- HTTP: /api/history ----------

/**
 * GET /api/history?file= → state. POST /api/history/undo|redo?file= (x-canvas: 1) → {ok, label, revision, state},
 * or 409 {code: "empty" | "conflict" | "moved"}. `?skip=1` drops a conflicting step; `?expect=<seq>` runs only when that
 * entry is the one on top (the page drew it already), else 409 "moved".
 */
export async function handleHistoryRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, docFileOf: (file: string) => string, hooks: ApplyHooks): Promise<boolean> {
  const p = url.pathname;
  if (p !== "/api/history" && p !== "/api/history/undo" && p !== "/api/history/redo") return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    const file = url.searchParams.get("file");
    if (!file) return reply(400, { error: "file is required", code: "invalid" }), true;
    const docFile = docFileOf(file);
    if (p === "/api/history") {
      if (req.method !== "GET") return reply(405, { error: "GET only", code: "invalid" }), true;
      return reply(200, historyState(docFile)), true;
    }
    if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    for await (const _ of req) {
      // The body is not used.
    }
    const skip = url.searchParams.get("skip") === "1";
    const ex = Number(url.searchParams.get("expect"));
    const expect = url.searchParams.has("expect") && Number.isInteger(ex) ? ex : undefined;
    const r = p.endsWith("/undo") ? await undo(docFile, hooks, { skip, expect }) : await redo(docFile, hooks, { skip, expect });
    return reply(200, { ok: true, ...r }), true;
  } catch (e) {
    if (e instanceof HistoryError) return reply(e.status, { error: e.message, code: e.code, state: safeState(url, docFileOf) }), true;
    return reply(422, { error: (e as Error).message, code: "failed" }), true;
  }
}

function safeState(url: URL, docFileOf: (file: string) => string): HistoryState | null {
  try {
    return historyState(docFileOf(url.searchParams.get("file") ?? ""));
  } catch {
    return null;
  }
}
