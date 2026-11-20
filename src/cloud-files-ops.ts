// Every local edit as one action of file ops (cloud/protocol-files.ts): the design file's half from the ops an edit
// recorded (history.ts's vocabulary: node, tree, move and doc ops), the sidecar's half from the envelope before and
// after (cards, pages, the other kept keys), and package files the edit added as blob ops. Nothing is sent anywhere
// yet: Phase 1 makes the actions complete, and proves it.
//
// The proof: with checks on (tests: NODE_TEST_CONTEXT; `pnpm qa`'s servers: CANVAS_CHECK_ACTIONS=1), every write
// runs its action through the shared apply (cloud/core/files/apply.ts) on the state before it, and the result must
// be the very state the edit wrote, key order included (the document's JSON, the sidecar's bytes). An edit whose
// action falls short is refused loudly (ActionCheckError) instead of written.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyAction, isReject, nextProps, opRunner } from "../cloud/core/files/apply.ts";
import { DESCENDANTS_PREFIX, type DocNode, type Json } from "../cloud/core/schema.ts";
import { actionBytes, blobTypeOf, checkBlobPath, FILE_LIMITS, META_KEYS, type Action, type BlobPath, type FileOp, type MetaKey, type Val } from "../cloud/protocol-files.ts";
import { DocTree, type DocLike, type Envelope } from "./cloud-files-tree.ts";
import type { Op } from "./history.ts";

export class ActionCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionCheckError";
  }
}
/** An edit that has no action in the file ops' terms (a document key outside the allowlist, a node gone). */
export class TranslateError extends Error {}

/** Checks on, and what they counted (for the report a test or QA run can print). */
export const actionChecks = {
  enabled: process.env.CANVAS_CHECK_ACTIONS === "1" || (!!process.env.NODE_TEST_CONTEXT && process.env.CANVAS_CHECK_ACTIONS !== "0"),
  checked: { doc: 0, envelope: 0, media: 0 },
  /** Actions over the wire limits (100 ops, 1 MB, inserts of 5,000 nodes or 64 levels): counted, not refused here. */
  overLimit: { ops: 0, bytes: 0, insert: 0 },
  /** Media adds whose package path a Cloud file could not take as it is (checkBlobPath): counted. */
  blobPathRefused: 0,
};

// CANVAS_ACTION_STATS=<file>: each process appends what its checks counted there when it ends (a QA or test run's tally).
if (process.env.CANVAS_ACTION_STATS) {
  const file = process.env.CANVAS_ACTION_STATS;
  process.once("exit", () => {
    const c = actionChecks.checked;
    if (c.doc + c.envelope + c.media) fs.appendFileSync(file, JSON.stringify({ pid: process.pid, ...actionChecks }) + "\n");
  });
}

type Listener = (docFile: string, action: Action) => void;
const listeners = new Set<Listener>();
const durableListeners = new Set<Listener>();
/** Hear every action a local edit makes (tests; later the Cloud outbox). */
export function onAction(f: Listener, durable = false): () => void {
  const set = durable ? durableListeners : listeners;
  set.add(f);
  return () => set.delete(f);
}
/** Is anyone asking for actions (checks on, or a listener)? Without, edits make none: today's cost stays. */
export const wantActions = () => actionChecks.enabled || listeners.size > 0 || durableListeners.size > 0;

// ---------- one action per step ----------

export type Writers = Record<string, string | 0>;
const versions = new Map<string, Writers>();
export function adoptWriters(file:string, writers:Writers):void { versions.set(file,{...writers}); }
const recent = new Map<string, { id: string; writes: Writers }>();
const docOrders = new Map<string, { b: string[]; a: string[] }>();
export const lastDocOrders = (file: string) => docOrders.get(file);
/** Writers of the last local action, for the history step recorded immediately after its writes. */
export const lastActionWrites = (file: string): Writers => ({ ...recent.get(file)?.writes });
const versionEntries = (file: string): [string, string][] => Object.entries(versions.get(file) ?? {}).filter((p): p is [string, string] => typeof p[1] === "string");

function remember(file: string, tree: DocTree, id: string) {
  const writes = Object.fromEntries(Object.entries(tree.allVers()).filter(([, v]) => v === id));
  versions.set(file, { ...versions.get(file), ...writes });
  recent.set(file, { id, writes: { ...(recent.get(file)?.id === id ? recent.get(file)!.writes : {}), ...writes } });
}

type Delivery = { ready: boolean; action?: Action };
const deliveries = new Map<string, Delivery[]>();
function reserve(file: string): Delivery {
  const slot: Delivery = { ready: false };
  const queue = deliveries.get(file) ?? [];
  queue.push(slot);
  deliveries.set(file, queue);
  return slot;
}
function release(file: string, slot: Delivery, action?: Action) {
  slot.ready = true;
  slot.action = action;
  const queue = deliveries.get(file)!;
  while (queue[0]?.ready) {
    const next = queue.shift()!;
    if (next.action) emit(file, next.action);
  }
  if (!queue.length) deliveries.delete(file);
}

type Scope = { slot?: Delivery; id: string; versions: [string, string][]; closed?: boolean; docFile: string; ops: FileOp[]; agent?: string; before?: DocLike; after?: DocLike; envelopeBefore?: Envelope; envelopeAfter?: Envelope };
const scopes = new AsyncLocalStorage<Scope>();
const agents = new AsyncLocalStorage<string | undefined>();
export function withActionAgent<T>(label:string|undefined,fn:()=>T):T { return agents.run(label?.replace(/[^\p{L}\p{N} ._-]/gu,' ').trim().slice(0,80),fn); }
const actionChains = new Map<string, Promise<void>>();
const activeScope = () => {
  const scope = scopes.getStore();
  return scope?.closed ? undefined : scope;
};

/**
 * Run `fn` as one step: the document and sidecar writes it makes (an undo of layers and cards, a structure op and
 * the page list that follows it) become one action, emitted when it ends. Writes outside any step are each one.
 */
export async function asOneAction<T>(docFile: string, fn: () => Promise<T> | T, agent?: string, writers?: Writers): Promise<T> {
  if (!wantActions() || activeScope()?.docFile === docFile) return fn();
  const run = (actionChains.get(docFile) ?? Promise.resolve()).then(() => runAction(docFile, fn, agent, writers));
  const settled = run.then(() => undefined, () => undefined);
  actionChains.set(docFile, settled);
  try { return await run; }
  finally { if (actionChains.get(docFile) === settled) actionChains.delete(docFile); }
}

async function runAction<T>(docFile: string, fn: () => Promise<T> | T, agent?: string, writers?: Writers): Promise<T> {
  const scope: Scope = { id: randomUUID(), versions: versionEntries(docFile), docFile, ops: [], agent };
  const previous = recent.get(docFile);
  let result: T;
  try {
    result = await scopes.run(scope, fn);
  } catch (error) {
    scope.closed = true;
    const reverted = !scope.ops.some((op) => op.k === "blob") && (!scope.before || !firstDifference(scope.before, scope.after)) && (!scope.envelopeBefore || !firstDifference(scope.envelopeBefore, scope.envelopeAfter));
    if (reverted) {
      const restored = { ...versions.get(docFile) }, before = Object.fromEntries(scope.versions);
      for (const [key, writer] of Object.entries(restored)) if (writer === scope.id) {
        if (before[key]) restored[key] = before[key];
        else delete restored[key];
      }
      versions.set(docFile, restored);
      if (recent.get(docFile)?.id === scope.id) {
        if (previous) recent.set(docFile, previous);
        else recent.delete(docFile);
      }
      if (scope.slot) release(docFile, scope.slot);
    } else publishScope(scope, writers);
    throw error;
  } finally {
    scope.closed = true;
  }
  publishScope(scope, writers);
  return result;
}

function publishScope(scope: Scope, writers?: Writers) {
  const { docFile, agent } = scope;
  try {
    if (!scope.ops.length) {
      if (scope.slot) release(docFile, scope.slot);
      return;
    }
    const action = { ...makeAction(scope.ops, agent), id: scope.id };
    if (writers) action.ops = withPreconditions(action.ops, writers, action.id, new DocTree(scope.before ?? { children: [] }, scope.envelopeBefore, [], scope.versions));
    if (actionChecks.enabled) {
      const tree = new DocTree(scope.before ?? { children: [] }, scope.envelopeBefore, [], scope.versions);
      const r = applyAction(tree, action, { limits: null });
      const difference = isReject(r) ? r.message : firstDifference(tree.doc, scope.after ?? tree.doc) ?? firstDifference(tree.envelope, scope.envelopeAfter ?? tree.envelope);
      if (difference) throw new ActionCheckError(`The combined action is incomplete: ${difference}`);
    }
    release(docFile, scope.slot!, action);
  } catch (error) {
    if (scope.slot && !scope.slot.ready) release(docFile, scope.slot);
    throw error;
  }
}

function emit(docFile: string, action: Action) {
  if (actionChecks.enabled) {
    if (action.ops.length > FILE_LIMITS.opsPerAction) actionChecks.overLimit.ops++;
    if (actionBytes(action) > FILE_LIMITS.actionBytes) actionChecks.overLimit.bytes++;
  }
  for (const f of durableListeners) f(docFile, action);
  for (const f of listeners) {
    try {
      f(docFile, action);
    } catch (e) {
      console.error(`[canvas] action listener: ${(e as Error).message}`);
    }
  }
}

/** Hand the ops of one write to the step it is part of, or emit them as their own action. */
function deliver(docFile: string, ops: FileOp[], id = activeScope()?.docFile === docFile ? activeScope()!.id : randomUUID()) {
  if (!ops.length) return;
  const scope = activeScope();
  if (scope && scope.docFile === docFile) {
    scope.slot ??= reserve(docFile);
    scope.ops.push(...ops);
  } else release(docFile, reserve(docFile), { ...makeAction(ops), id });
}

/** Only the first write of a target checks history's writer; later writes check this action itself. */
function withPreconditions(ops: FileOp[], writers: Writers, id: string, tree: DocTree): FileOp[] {
  const run = opRunner(tree, id, { limits: null });
  const want = (target: string) => tree.ver(target) === id ? id : writers[target] ?? 0;
  const guard = (op: FileOp): FileOp => {
    switch (op.k) {
      case "set": return { ...op, if: Object.fromEntries(Object.keys(op.props).map((k) => [k, want(`n:${op.id}:${k}`)])) };
      case "doc": return { ...op, if: want(`d:${op.key}`) };
      case "widget": return { ...op, if: want(`w:${op.id}`) };
      case "page": return { ...op, if: want(`p:${op.id}`) };
      case "pageOf": return { ...op, if: want(`po:${op.board}`) };
      case "meta": return { ...op, if: want(`m:${op.key}`) };
      case "move": return { ...op, if: want(`t:${op.id}`) };
      case "remove": return { ...op, if: want(tree.ver(`s:${op.id}`) !== 0 ? `s:${op.id}` : `t:${op.id}`) };
      default: return op;
    }
  };
  return ops.map((op): FileOp => {
    const guarded = guard(op);
    run(op);
    return guarded;
  });
}

export function makeAction(ops: FileOp[], agent: string | undefined = agents.getStore()): Action {
  return { id: randomUUID(), baseSeq: 0, epoch: 0, at: new Date().toISOString(), ops, ...(agent ? { agent } : {}) };
}

// ---------- translation: the design file ----------

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const val = (v: unknown): Val => (v === undefined ? null : { v: clone(v) as Json });

/** Run `op` on the working tree as the next op of the translation; a refusal names the op. */
function stepper(tree: DocTree, id = "translate") {
  const run = opRunner(tree, id, { limits: null });
  const out: FileOp[] = [];
  const push = (op: FileOp) => {
    try {
      run(op);
    } catch (e) {
      throw new TranslateError(`${op.k} ${"id" in op ? `"${op.id}"` : "key" in op ? `"${op.key}"` : ""}: ${(e as Error).message}`);
    }
    out.push(op);
  };
  return { out, push, finish: () => run.finish() };
}

/** The sibling a place's index comes right after in `list` (null: first). */
const anchorOf = (list: readonly string[], index: number): string | null => (index <= 0 ? null : (list[Math.min(index, list.length) - 1] ?? null));

/** Per-path override ops for an instance's `descendants`, when they give exactly `after` (else the whole key). */
function overridePaths(before: Json | undefined, after: Json | undefined): Record<string, Val> | null {
  if ((before !== undefined && !isObj(before)) || !isObj(after)) return null;
  if (before === undefined && !Object.keys(after).length) return null;
  before ??= {};
  const set: Record<string, Val> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = after[k] === undefined ? null : { v: after[k] };
    const b = before[k] === undefined ? null : { v: before[k] };
    if (JSON.stringify(a) !== JSON.stringify(b)) set[k] = a === null ? null : { v: clone(a.v) };
  }
  const predicted = Object.keys(nextProps(before, set)).join("\n");
  return predicted === Object.keys(after).filter((k) => after[k] !== undefined).join("\n") ? set : null;
}

/**
 * The file ops of a design-file edit: `ops` as they ran on `before`, in order. Inserts and moves are placed by the
 * sibling they go after, as the tree stands when each runs; overrides travel per path; a node whose type changes
 * goes out and comes back whole.
 */
export function docFileOps(before: DocLike, ops: Op[]): FileOp[] {
  return translateDoc(new DocTree(before), ops);
}

function translateDoc(tree: DocTree, ops: Op[], id = "translate", blobs: FileOp[] = []): FileOp[] {
  const { out, push, finish } = stepper(tree, id);
  for (const blob of blobs) push(blob);
  for (const op of ops) {
    if (op.t === "node") {
      const n = tree.node(op.id);
      if (!n) throw new TranslateError(`node op on "${op.id}", which is not in the document`);
      if (["id", "type", "children"].some((k) => Object.hasOwn(op.props, k))) {
        // Identity changes: the node goes and comes back with its children, where it was.
        const sub = clone(tree.subtree(op.id)!) as Record<string, Json>;
        const set: Record<string, Val> = {};
        for (const [k, d] of Object.entries(op.props)) set[k] = d.a;
        const next = nextProps(sub, set, op.keys?.a);
        const siblings = tree.children(n.parent);
        const after = anchorOf(siblings, siblings.indexOf(op.id));
        push({ k: "remove", id: op.id });
        push({ k: "insert", parent: n.parent, after, node: next as DocNode });
        continue;
      }
      const props: Record<string, Val> = {};
      for (const [k, d] of Object.entries(op.props)) {
        if (k === "descendants" && n.type === "ref") {
          const paths = overridePaths(n.props.descendants, d.a?.v);
          if (paths) {
            for (const [p, v] of Object.entries(paths)) props[DESCENDANTS_PREFIX + p] = v;
            continue;
          }
        }
        props[k] = d.a === null ? null : { v: clone(d.a.v) };
      }
      if (!Object.keys(props).length && !op.keys) continue;
      // Whole keys apply before per-path overrides. Keep the recorded order when both add new keys.
      const order = op.keys?.a.slice();
      push({ k: "set", id: op.id, props, ...(order ? { order } : {}) });
    } else if (op.t === "tree") {
      if (op.kind === "insert") {
        const list = tree.children(op.parent);
        push({ k: "insert", parent: op.parent, after: anchorOf(list, op.index), node: clone(op.node) });
      } else {
        const id = String(op.node.id);
        if (!tree.node(id)) throw new TranslateError(`remove of "${id}", which is not in the document`);
        push({ k: "remove", id });
      }
    } else if (op.t === "move") {
      const list = tree.children(op.a.parent).filter((x) => x !== op.id);
      push({ k: "move", id: op.id, parent: op.a.parent, after: anchorOf(list, op.a.index) });
    } else if (op.t === "doc") {
      const changes = docKeyOps(tree, op.key, op.a);
      for (let i = 0; i < changes.length; i++) {
        const d = changes[i];
        if (d.k === "doc" && i === changes.length - 1 && op.keys) d.order = op.keys.a.slice();
        push(d);
      }
    } else throw new TranslateError(`a ${op.t} op in a design-file edit`);
  }
  finish();
  return out;
}

/** Doc ops that take the document's `key` to `after`: variables one by one, themes and fonts whole. */
function docKeyOps(tree: DocTree, key: string, after: Val): FileOp[] {
  if (key === "themes" || key === "fonts") return [{ k: "doc", key, value: after === null ? null : { v: clone(after.v) } }];
  if (key !== "variables") throw new TranslateError(`the document key "${key}" is not one an edit may change (variables, themes, fonts)`);
  const b = tree.docValue("variables"), a = after?.v;
  if ((b !== undefined && !isObj(b)) || (a !== undefined && !isObj(a))) throw new TranslateError("the variables are not an object");
  const set: Record<string, Val> = {};
  for (const name of new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])) {
    const x = b?.[name], y = a?.[name];
    if (JSON.stringify(x) !== JSON.stringify(y)) set[name] = val(y);
  }
  const predicted = Object.keys(nextProps(b ?? {}, set)).join("\n");
  const out: FileOp[] = predicted !== Object.keys(a ?? {}).join("\n")
    ? [...Object.keys(b ?? {}).map((name): FileOp => ({ k: "doc", key: `variables/${name}`, value: null })), ...Object.entries(a ?? {}).map(([name, v]): FileOp => ({ k: "doc", key: `variables/${name}`, value: val(v) }))]
    : Object.entries(set).map(([name, v]): FileOp => ({ k: "doc", key: `variables/${name}`, value: v }));
  if (a === undefined && b !== undefined) out.push({ k: "doc", key: "variables", value: null });
  else if (a !== undefined && !Object.keys(a).length && b === undefined) out.push({ k: "doc", key: "variables", value: { v: {} } });
  return out;
}

// ---------- translation: the sidecar ----------

/**
 * Items of `cur` that keep their place on the way to `target` (a longest run in the same order), and the others,
 * each to be placed after the item before it in `target`.
 */
export function placements(cur: readonly string[], target: readonly string[]): { id: string; after: string | null }[] {
  const pos = new Map(target.map((id, i) => [id, i]));
  const seq = cur.filter((id) => pos.has(id)).map((id) => pos.get(id)!);
  // Longest increasing run of target positions (patience), so the fewest items move.
  const tails: number[] = [], prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(seq[i]);
  const out: { id: string; after: string | null }[] = [];
  target.forEach((id, i) => {
    if (!keep.has(i)) out.push({ id, after: i > 0 ? target[i - 1] : null });
  });
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A page list in the shape page ops describe: {id, name, boards} each, ids unique, every board on one page. */
export function pagesInShape(v: unknown): v is { id: string; name: string; boards: string[] }[] {
  if (!Array.isArray(v)) return false;
  const ids = new Set<string>(), boards = new Set<string>();
  for (const p of v) {
    if (!isObj(p) || Object.keys(p).join(",") !== "id,name,boards" || typeof p.id !== "string" || !p.id || ids.has(p.id) || typeof p.name !== "string" || !p.name || !Array.isArray(p.boards)) return false;
    ids.add(p.id);
    for (const b of p.boards) {
      if (typeof b !== "string" || !b || boards.has(b)) return false;
      boards.add(b);
    }
  }
  return true;
}

/** The file ops that take the sidecar from `before` to `after`: cards, pages and the other kept keys. */
export function envelopeFileOps(before: Envelope, after: Envelope): FileOp[] {
  const tree = new DocTree({ children: [] }, before);
  const { out, push } = stepper(tree);
  // Cards: gone ones go, then each one placed (or changed in place) in the order `after` has them.
  const ids = after.widgets.map((w) => String(w.id));
  const keepIds = new Set(ids);
  for (const w of before.widgets) if (!keepIds.has(String(w.id))) push({ k: "widget", id: String(w.id), value: null });
  const moves = new Map(placements(tree.widgetIds(), ids).map((p) => [p.id, p.after]));
  const old = new Map(before.widgets.map((w) => [String(w.id), w]));
  for (const w of after.widgets) {
    const id = String(w.id);
    if (moves.has(id)) push({ k: "widget", id, value: val(w), after: moves.get(id)! });
    else if (!same(old.get(id), w)) push({ k: "widget", id, value: val(w) });
  }
  // Pages.
  const bp = before.extra.pages, ap = after.extra.pages;
  if (!same(bp, ap)) {
    if ((bp === undefined || pagesInShape(bp)) && pagesInShape(ap) && ap.length) {
      // New and moved pages first, gone ones last: a file is never without a page on the way.
      const pm = new Map(placements((tree.pages() ?? []).map((p) => p.id), ap.map((p) => p.id)).map((p) => [p.id, p.after]));
      for (const p of ap) {
        const was = (tree.pages() ?? []).find((x) => x.id === p.id);
        if (pm.has(p.id)) push({ k: "page", id: p.id, value: { v: { name: p.name } }, after: pm.get(p.id)! });
        else if (was && was.name !== p.name) push({ k: "page", id: p.id, value: { v: { name: p.name } } });
      }
      const listed = new Set(ap.flatMap((p) => p.boards));
      for (const p of tree.pages() ?? []) for (const b of p.boards) if (!listed.has(b)) push({ k: "pageOf", board: b, page: null });
      for (const p of ap) {
        const now = (tree.pages() ?? []).find((x) => x.id === p.id)!.boards;
        for (const m of placements(now, p.boards)) push({ k: "pageOf", board: m.id, page: p.id, after: m.after });
      }
      for (const p of (bp ?? []) as { id: string }[]) if (!ap.some((q) => q.id === p.id)) push({ k: "page", id: p.id, value: null });
    } else push({ k: "meta", key: "pages", value: val(ap) });
  }
  // The other kept keys, whole.
  for (const k of new Set([...Object.keys(before.extra), ...Object.keys(after.extra)])) {
    if (k === "pages" || same(before.extra[k], after.extra[k])) continue;
    if (!META_KEYS.includes(k as MetaKey)) throw new TranslateError(`the sidecar key "${k}" is not one a file keeps (${META_KEYS.join(", ")})`);
    push({ k: "meta", key: k as MetaKey, value: val(after.extra[k]) });
  }
  return out;
}

// ---------- media ----------

/**
 * The package path a media file of `docFile` takes in a Cloud file: `media/<name>` or `shaders/<name>`. A plain
 * foo.canvas.json keeps them in foo.media and foo.shaders; those map to the same names. Null: not one of those folders.
 */
export function blobPathOf(docFile: string, abs: string): string | null {
  const base = path.dirname(docFile);
  const rel = path.relative(base, abs).split(path.sep).join("/");
  const stem = path.basename(docFile).endsWith(".canvas.json") ? path.basename(docFile, ".canvas.json") : null;
  const m = rel.match(/^([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const dir = m[1] === "media" || (stem && m[1] === `${stem}.media`) ? "media" : m[1] === "shaders" || (stem && m[1] === `${stem}.shaders`) ? "shaders" : null;
  return dir ? `${dir}/${m[2]}` : null;
}

/** The blob op for a file just added to a document's package (null: not a package file a blob can name). */
export function blobOpOf(docFile: string, abs: string): FileOp | null {
  let p = blobPathOf(docFile, abs);
  const rel = path.relative(path.dirname(docFile), abs);
  if (path.isAbsolute(rel) || !rel || rel === ".." || rel.startsWith(".." + path.sep)) {
    if (actionChecks.enabled) actionChecks.blobPathRefused++;
    return null;
  }
  // Older local packages keep media in other folders and allow spaces. Their blob identity is content addressed;
  // local references and disk names stay as written. Cloud import must rewrite those references before confinement.
  const bytes = fs.readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!p || checkBlobPath(p)) {
    const ext = path.extname(abs).slice(1).toLowerCase();
    const canonical = ext === "wgsl" ? `shaders/legacy-${sha256}.wgsl` : `media/legacy-${sha256}.${ext}`;
    if (checkBlobPath(canonical)) {
      if (actionChecks.enabled) actionChecks.blobPathRefused++;
      return null;
    }
    p = canonical;
  }
  return { k: "blob", path: p as BlobPath, sha256, bytes: bytes.length, type: blobTypeOf(p as BlobPath) };
}

/**
 * A media file was added to `docFile`'s package (an image dropped or pasted, a video copied in, a shader source):
 * its blob op goes with the step it is part of, or as an action of its own (an image upload comes before the edit
 * that names it). Checked like every action: the blob row it adds must be there after.
 */
export function mediaAdded(docFile: string, abs: string): void {
  if (!wantActions()) return;
  let op: FileOp | null;
  try {
    op = blobOpOf(docFile, abs);
  } catch (e) {
    if (actionChecks.enabled) throw new ActionCheckError(`media add ${abs}: ${(e as Error).message}`);
    return;
  }
  if (!op || op.k !== "blob") return;
  if (actionChecks.enabled) {
    const tree = new DocTree({ children: [] });
    const r = applyAction(tree, makeAction([op]), { limits: null });
    if (isReject(r) || tree.blob(op.path)?.sha256 !== op.sha256) throw new ActionCheckError(`media add ${op.path}: the action does not add it${isReject(r) ? ` (${r.message})` : ""}`);
    actionChecks.checked.media++;
  }
  deliver(docFile, [op]);
}

/** Refuse a package file a Cloud file names when it is a symlink or sits under one (lstat on every part). */
export function confinedFile(pkgDir: string, blobPath: string): string | null {
  const bad = checkBlobPath(blobPath);
  if (bad) throw new Error(bad);
  let at = pkgDir;
  for (const part of blobPath.split("/")) {
    at = path.join(at, part);
    const st = fs.lstatSync(at, { throwIfNoEntry: false });
    if (!st) return null;
    if (st.isSymbolicLink()) throw new Error(`${blobPath} is a symlink; a Cloud file only reads its own files`);
  }
  return at;
}

// ---------- the checks ----------

/** Where two JSON values first differ (key order included), or null when they serialize the same. */
export function firstDifference(a: unknown, b: unknown, where = ""): string | null {
  if (a === b) return null;
  const ja = typeof a === "number" || typeof a === "string" || typeof a === "boolean" || a === null || a === undefined;
  if (ja || b === null || typeof b !== "object") return JSON.stringify(a) === JSON.stringify(b) ? null : `${where || "(root)"}: ${short(a)} vs ${short(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${where}: one is a list`;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return `${where}: ${a.length} vs ${bb.length} items`;
    for (let i = 0; i < a.length; i++) {
      const id = isObj(a[i]) && typeof (a[i] as Record<string, unknown>).id === "string" ? `#${(a[i] as Record<string, unknown>).id}` : `[${i}]`;
      const d = firstDifference(a[i] ?? null, bb[i] ?? null, `${where}${id}`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.join("\n") !== kb.join("\n")) return `${where || "(root)"}: keys ${ka.join(",")} vs ${kb.join(",")}`;
  for (const k of ka) {
    const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${where}.${k}`);
    if (d) return d;
  }
  return null;
}
const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? "absent" : s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

// Indexed state follows immutable snapshots. An outside save has a different snapshot and builds fresh indexes.
const translationTrees = new WeakMap<DocLike, { file: string; tree: DocTree }>();

/**
 * A design-file edit made: `before` became `after` with `ops` (what it recorded, or the property changes it made)
 * and `media` (package files it added). Returns its file ops for the step (delivered to listeners); with checks on,
 * refuses an edit whose ops, applied by the shared apply to `before`, do not give `after`.
 */
export function docEditAction(docFile: string, before: DocLike, after: DocLike, ops: Op[] | undefined, media: string[] = [], defer = false): (() => void) | undefined {
  if (!wantActions()) return;
  const fail = (msg: string): never => {
    console.error(`[canvas] action check: ${msg}`);
    throw new ActionCheckError(`The edit's action is incomplete: ${msg}`);
  };
  const id = activeScope()?.docFile === docFile ? activeScope()!.id : randomUUID();
  const cached = translationTrees.get(before);
  const tree = cached?.file === docFile ? cached.tree : new DocTree(before, undefined, [], versionEntries(docFile));
  // This tree is being advanced. If the caller never publishes, a later edit rebuilds from its snapshot.
  translationTrees.delete(before);
  tree.begin();
  let fileOps: FileOp[];
  try {
    if (!ops) throw new TranslateError('the edit touches "all" and recorded no ops');
    const blobs = media.map((f) => blobOpOf(docFile, f)).filter((o): o is FileOp => !!o);
    // Translation already runs the shared op runner. Use that same tree for checks and writer tracking.
    fileOps = translateDoc(tree, ops, id, blobs);
    if (actionChecks.enabled) {
      const d = firstDifference(tree.doc, after);
      if (d) fail(`applied to the state before, it gives another document: ${d}`);
      countInserts(fileOps);
      actionChecks.checked.doc++;
    }
  } catch (e) {
    tree.rollback();
    if (!actionChecks.enabled) return;
    if (e instanceof ActionCheckError) throw e;
    return fail((e as Error).message);
  }
  const publish = () => {
    tree.commit();
    translationTrees.set(after, { file: docFile, tree });
    remember(docFile, tree, id);
    docOrders.set(docFile, { b: Object.keys(before), a: Object.keys(after) });
    const scope = activeScope();
    if (scope?.docFile === docFile) {
      scope.before ??= before;
      scope.after = after;
    }
    deliver(docFile, fileOps, id);
  };
  if (defer) return publish;
  publish();
}

/**
 * The sidecar edit counterpart of docEditAction: `bytes` is what the store is about to write, `serialize` how it
 * writes. Returns the ops for deliverOps once the write landed (the store may retry on newer bytes), or null.
 */
export function envelopeEditAction(before: Envelope, after: Envelope, bytes: string, serialize: (widgets: never[], extra: Record<string, unknown>) => string): FileOp[] | null {
  if (!wantActions()) return null;
  const fail = (msg: string) => {
    console.error(`[canvas] action check (cards and pages): ${msg}`);
    throw new ActionCheckError(`The edit's action is incomplete: ${msg}`);
  };
  let fileOps: FileOp[];
  try {
    fileOps = envelopeFileOps(before, after);
  } catch (e) {
    if (!actionChecks.enabled) return null;
    return fail((e as Error).message);
  }
  if (actionChecks.enabled) {
    const tree = new DocTree({ children: [] }, before);
    const r = applyAction(tree, makeAction(fileOps), { limits: null });
    if (isReject(r)) return fail(`the shared apply refused it: ${r.message}`);
    const got = serialize(tree.envelope.widgets as never[], tree.envelope.extra);
    if (got !== bytes) return fail(`applied to the state before, it gives other bytes: ${firstDifference(JSON.parse(got), JSON.parse(bytes))}`);
    actionChecks.checked.envelope++;
  }
  return fileOps;
}

/** A write's ops, once it landed: to the step it is part of, or as an action of its own. */
export function deliverOps(docFile: string, ops: FileOp[] | null, before?: Envelope, after?: Envelope): void {
  const scope = activeScope();
  if (scope?.docFile === docFile && before && after) {
    scope.envelopeBefore ??= before;
    scope.envelopeAfter = after;
  }
  if (ops) {
    const id = scope?.docFile === docFile ? scope.id : randomUUID();
    if (before) {
      const tree = new DocTree({ children: [] }, before, [], versionEntries(docFile));
      const r = applyAction(tree, { ...makeAction(ops), id }, { limits: null });
      if (!isReject(r)) remember(docFile, tree, id);
    }
    deliver(docFile, ops, id);
  }
}

function countInserts(ops: FileOp[]) {
  for (const op of ops) {
    if (op.k !== "insert") continue;
    let n = 0, depth = 0;
    const walk = (x: DocNode, d: number) => {
      n++;
      depth = Math.max(depth, d);
      for (const c of Array.isArray(x.children) ? (x.children as DocNode[]) : []) walk(c, d + 1);
    };
    walk(op.node, 1);
    if (n > FILE_LIMITS.insertNodes || depth > FILE_LIMITS.insertDepth) actionChecks.overLimit.insert++;
  }
}
