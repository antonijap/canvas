// The one shared pure apply: what an action does to a design file. A Cloud's file room runs it on its SQL rows
// (Phase 2, tree-sql.ts) and the Mac runs it on a copy on write document (src/cloud-files-tree.ts), so both end with
// the same bytes. An action applies whole or not at all: the first op that does not fit rejects it, and the tree
// rolls back to where it was.
//
// Rules (Section 2.3 of the plan): a property write never names a node's identity or tree keys, and only keys its
// type takes (an instance any, its overrides as `descendants/<path>`); values are checked with validateNode. A value
// `{v}` sets, `null` removes. Keys keep their order: existing keys keep their place, new keys go last, removed keys
// go; `order` overrides. Inserts bring whole subtrees whose ids are all free; moves never put a node inside itself.
// A component that live instances use is never removed; an instance names a live component, and no component holds
// an instance of itself. `if` preconditions name the action that must have written a key last (0: none since load).

import { whiteboardPerson } from "../../../src/page/whiteboard-model.js";
import { docKeyError, setKeyError, validateNode, validateVariable, DESCENDANTS_PREFIX, PROTO_KEYS, type DocNode, type Json } from "../schema.ts";
import { shift as shiftSpans } from "../../../src/page/text-spans.js";
import { shiftLists, type ListItem } from "../../../src/page/text-paras.js";
import { checkBlobPath, blobTypeOf, FILE_LIMITS, META_KEYS, type Action, type AppliedAction, type AppliedOp, type Author, type BlobPath, type FileOp, type Reject, type RejectCode, type Val } from "../../protocol-files.ts";

/** A version: the id of the action that wrote something last, or 0 when nothing did since the state was loaded. */
export type Ver = string | 0;

/** A live node as the apply sees it. `props` holds every key in the node's order; a children list shows as
 *  `children: null` (where it sits among the keys), never its content. */
export type NodeView = { id: string; parent: string | null; type: string; props: Record<string, Json> };
export type PageRow = { id: string; name: string; boards: readonly string[] };
export type BlobRow = { sha256: string; bytes: number; type: string };

/**
 * The state an action applies to. Reads see only live state (a removed node, or one under a removed parent, is
 * null). Writes happen only inside applyAction, between begin and commit (or rollback, which puts every write of
 * the action back). Targets of `ver`: `n:<id>:<key>` a node key, `t:<id>` a node's place, `d:<docKey>`, `w:<id>`,
 * `p:<id>`, `po:<board>`, `m:<key>`.
 */
export interface TreeAccess {
  node(id: string): NodeView | null;
  children(parent: string | null): readonly string[];
  /** Up to `max` ids above `id`, nearest first. */
  ancestors(id: string, max: number): string[];
  /** The live subtree as stored (children included); read only. */
  subtree(id: string): DocNode | null;
  /** A live node with `reusable: true`. */
  isComponent(id: string): boolean;
  /** A live node uses `id` as its component (its own ref, or one inside its overrides). */
  hasRefUsers(id: string): boolean;
  docValue(key: "variables" | "themes" | "fonts"): Json | undefined;
  widgetIds(): readonly string[];
  widget(id: string): Json | undefined;
  /** The stored page list, or null when the file has none (one implicit page shows every board). */
  pages(): readonly PageRow[] | null;
  meta(key: string): Json | undefined;
  blob(path: string): BlobRow | null;
  ver(target: string): Ver;

  begin(): void;
  commit(): void;
  rollback(): void;
  /** Every key of the node in order, as nextProps made them; `children` stands for the node's own list. */
  writeProps(id: string, props: Record<string, Json>): void;
  insert(parent: string | null, index: number, node: DocNode): void;
  remove(id: string): void;
  move(id: string, parent: string | null, index: number): void;
  writeDocValue(key: "variables" | "themes" | "fonts", value: Json | undefined): void;
  orderDocKeys(order: string[]): void;
  writeWidget(id: string, value: Json | undefined, index: number | undefined): void;
  writePages(list: PageRow[] | null): void;
  writeMeta(key: string, value: Json | undefined): void;
  addBlob(path: string, row: BlobRow): void;
  setVer(target: string, ver: string): void;
}

export type ApplyCtx = {
  by?: Author;
  /** A previously accepted action can predate the current whiteboard write rules. */
  replay?: boolean;
  /** The seq the action's first op takes (the room's next); 0 on the Mac before the server answers. */
  seq?: number;
  /** Per action and per insert bounds; null leaves them out (a local check that only counts them). */
  limits?: typeof FILE_LIMITS | null;
  /** Cloud files: every media reference must be a package file a blob op added (Section 5). */
  confine?: boolean;
};

export class ApplyError extends Error {
  code: RejectCode;
  op: number;
  constructor(code: RejectCode, message: string, op = -1) {
    super(message);
    this.code = code;
    this.op = op;
  }
}

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const isVal = (v: unknown): v is Val => v === null || (isObj(v) && Object.keys(v).length === 1 && Object.hasOwn(v, "v") && v.v !== undefined);
const CONTAINERS = new Set(["frame", "group"]);

/**
 * Put `keys` in `order` (history.ts orderKeys on key lists): keys the order names go in its order; a key it does not
 * name stays right after the named key it follows now.
 */
export function orderLike(keys: string[], order: string[]): string[] {
  const named = new Set(order);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const k of keys) {
    if (named.has(k)) anchor = k;
    else after.set(anchor, [...(after.get(anchor) ?? []), k]);
  }
  const have = new Set(keys);
  const out = [...(after.get(null) ?? [])];
  for (const k of order) if (have.has(k)) out.push(k, ...(after.get(k) ?? []));
  return out;
}

/** An object's keys after a write: existing keys keep their place, new keys go last (in the write's order), removed
 *  keys go; `order` puts them in that order instead. Values are the write's own (the caller clones). */
export function nextProps(cur: Record<string, Json>, set: Record<string, Val>, order?: string[]): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const k of Object.keys(cur)) {
    if (!Object.hasOwn(set, k)) out[k] = cur[k];
    else if (set[k] !== null) out[k] = set[k]!.v;
  }
  for (const k of Object.keys(set)) if (!Object.hasOwn(cur, k) && set[k] !== null) out[k] = set[k]!.v;
  if (!order) return out;
  const re: Record<string, Json> = {};
  for (const k of orderLike(Object.keys(out), order)) re[k] = out[k];
  return re;
}

/** Ids in a subtree (the node first), and its depth (1: a leaf). */
function walk(n: DocNode, visit: (x: DocNode, depth: number) => void, depth = 1): number {
  visit(n, depth);
  let d = depth;
  for (const c of Array.isArray(n.children) ? (n.children as DocNode[]) : []) if (isObj(c)) d = Math.max(d, walk(c, visit, depth + 1));
  return d;
}

/** Component ids an override object (or a list of them) names, at any depth. */
export function refsInOverrides(v: Json, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) refsInOverrides(x, out);
  else if (isObj(v)) {
    if (typeof v.ref === "string") out.push(v.ref);
    for (const [k, x] of Object.entries(v)) if (k !== "ref" && x && typeof x === "object") refsInOverrides(x, out);
  }
  return out;
}

/** The components a node uses itself: its ref and the refs inside its overrides. */
export function refsOfNode(n: Record<string, Json>): string[] {
  const out: string[] = [];
  if (typeof n.ref === "string") out.push(n.ref);
  if (isObj(n.descendants)) refsInOverrides(n.descendants, out);
  return out;
}

/** Media a node's own properties name: image fills and strokes, a script's file. */
export function mediaRefsOfNode(n: Record<string, Json>): string[] {
  const out: string[] = [];
  const paint = (p: Json) => {
    for (const f of Array.isArray(p) ? p : [p]) if (isObj(f) && f.type === "image" && typeof f.url === "string") out.push(f.url);
  };
  paint(n.fill);
  paint(n.stroke);
  if (typeof n.scriptUri === "string") out.push(n.scriptUri);
  if (isObj(n.descendants)) for (const o of Object.values(n.descendants)) if (isObj(o)) out.push(...mediaRefsOfNode(o));
  return out;
}

/** Media a card names: a video's file, a shader's source. */
export function mediaRefsOfWidget(w: Json): string[] {
  if (!isObj(w) || !isObj(w.config)) return [];
  const out: string[] = [];
  if (w.kind === "video" && typeof w.config.src === "string") out.push(w.config.src);
  if (w.kind === "shader" && typeof w.config.source === "string") out.push(w.config.source);
  return out;
}

/** Media the document's font list names. */
export function mediaRefsOfFonts(v: Json | undefined): string[] {
  const out: string[] = [];
  for (const f of Array.isArray(v) ? v : []) if (isObj(f)) for (const k of ["url", "file", "src"]) if (typeof f[k] === "string") out.push(f[k] as string);
  return out;
}

/**
 * Why `ref` may not be named by a Cloud file (null: it may): it must be a package file the file holds as a blob. Web
 * addresses and data URLs are refused (fetching one tells a site every viewer's address; a data URL skips the caps).
 */
export function confinedRefError(tree: Pick<TreeAccess, "blob">, ref: string): string | null {
  const bad = checkBlobPath(ref);
  if (bad) return bad;
  return tree.blob(ref) ? null : `"${ref}" is not a file of this design`;
}

/** Apply one action. Returns what it applied, or why it was rejected (the tree is then as it was). */
export function applyAction(tree: TreeAccess, action: Pick<Action, "id" | "ops"> & Partial<Action>, ctx: ApplyCtx = {}): AppliedAction | Reject {
  const limits = ctx.limits === undefined ? FILE_LIMITS : ctx.limits;
  if (!action || typeof action.id !== "string" || !action.id || !Array.isArray(action.ops)) return { reject: "invalid", message: "an action needs an id and a list of ops" };
  if (limits && action.ops.length > limits.opsPerAction) return { reject: "invalid", message: `an action holds at most ${limits.opsPerAction} ops` };
  tree.begin();
  try {
    const run = new Run(tree, action.id, ctx, limits);
    const ops = action.ops.map((op, i) => {
      run.at = i;
      return run.op(op);
    });
    run.finish();
    tree.commit();
    const first = ctx.seq ?? 0;
    return { first, last: first + Math.max(0, ops.length - 1), id: action.id, by: ctx.by ?? { id: "" }, at: action.at ?? new Date(0).toISOString(), ops };
  } catch (e) {
    tree.rollback();
    if (e instanceof ApplyError) return { reject: e.code, message: e.message, ...(e.op >= 0 ? { op: e.op } : {}) };
    return { reject: "invalid", message: (e as Error).message };
  }
}

export const isReject = (r: AppliedAction | Reject): r is Reject => "reject" in r;

/**
 * Ops applied one at a time, without a transaction. Call finish() after the last op for the final checks.
 * A working copy follows an edit op by op (src/cloud-files-ops.ts places each op against the tree the ops before
 * it left). Throws ApplyError for an op that does not fit.
 */
export function opRunner(tree: TreeAccess, actionId: string, ctx: ApplyCtx = {}): ((op: FileOp) => AppliedOp) & { finish(): void } {
  const run = new Run(tree, actionId, ctx, ctx.limits ?? null);
  return Object.assign((op: FileOp) => run.op(op), { finish: () => run.finish() });
}

class Run {
  at = -1;
  /** Components the action removed, and (user, component) pairs it made: checked once every op ran, since an action may
   *  remove an instance after its component or insert an instance before its component. */
  private removedComponents: string[] = [];
  private uses: { user: string; ref: string }[] = [];
  /** Nodes whose components must be checked for cycles at the end. */
  private cycleSeeds: string[] = [];
  /** References to package files: checked at the end (a blob op may come later in the same action). */
  private media: string[] = [];
  private tree: TreeAccess;
  private id: string;
  private ctx: ApplyCtx;
  private limits: typeof FILE_LIMITS | null;
  constructor(tree: TreeAccess, id: string, ctx: ApplyCtx, limits: typeof FILE_LIMITS | null) {
    this.tree = tree;
    this.id = id;
    this.ctx = ctx;
    this.limits = limits;
  }

  private fail(code: RejectCode, message: string): never {
    throw new ApplyError(code, message, this.at);
  }
  private checkIf(target: string, want: Ver | undefined) {
    if (want === undefined) return;
    const have = this.tree.ver(target);
    if (have !== want) this.fail("conflict", `${target} was changed by another action since`);
  }
  private live(id: unknown, what = "node"): NodeView {
    if (typeof id !== "string" || !id) this.fail("invalid", `a ${what} id must be a non-empty string`);
    const n = this.tree.node(id);
    if (!n) this.fail("conflict", `${what} "${id}" is gone`);
    return n;
  }
  /** The children list of `parent`, or a reason it cannot take children. */
  private holder(parent: unknown): readonly string[] {
    if (parent === null) return this.tree.children(null);
    const p = this.live(parent, "parent");
    if (!CONTAINERS.has(p.type)) this.fail("invalid", `"${p.id}" is a ${p.type}; only frames and groups hold layers`);
    return this.tree.children(p.id);
  }
  /** The index right after `after` in `list` (null: the start). */
  private indexAfter(list: readonly string[], after: unknown, what: string): number {
    if (after === null) return 0;
    if (typeof after !== "string") this.fail("invalid", `${what}: after must be an id or null`);
    const i = list.indexOf(after);
    if (i < 0) this.fail("conflict", `${what}: "${after}" is not there any more`);
    return i + 1;
  }
  private depthOf(parent: string | null): number {
    return parent === null ? 0 : this.tree.ancestors(parent, (this.limits?.treeDepth ?? 1024) + 1).length + 1;
  }

  op(op: FileOp): AppliedOp {
    if (!isObj(op)) this.fail("invalid", "an op must be an object");
    switch (op.k) {
      case "set": return this.set(op);
      case "insert": return this.insert(op);
      case "remove": return this.remove(op);
      case "move": return this.move(op);
      case "text": return this.text(op);
      case "doc": return this.doc(op);
      case "widget": return this.widget(op);
      case "page": return this.page(op);
      case "pageOf": return this.pageOf(op);
      case "meta": return this.metaOp(op);
      case "blob": return this.blob(op);
      default: this.fail("invalid", `unknown op "${(op as { k?: unknown }).k}"`);
    }
  }

  private set(op: Extract<FileOp, { k: "set" }>): AppliedOp {
    const n = this.live(op.id);
    if (!isObj(op.props)) this.fail("invalid", "set: props must be an object");
    const keys = Object.keys(op.props);
    if (!keys.length && op.order === undefined) this.fail("invalid", "set: nothing to set");
    if (op.order !== undefined && (!Array.isArray(op.order) || op.order.some((k) => typeof k !== "string"))) this.fail("invalid", "set: order must be a list of keys");
    const whole: Record<string, Val> = {};
    const paths: Record<string, Val> = {};
    for (const k of keys) {
      const v = op.props[k];
      if (!isVal(v)) this.fail("invalid", `set: "${k}" must be {v: value} or null`);
      const bad = setKeyError(n.type, k);
      if (bad) this.fail(PROTO_KEYS.has(k) || k === "id" || k === "type" || k === "children" ? "forbidden" : "invalid", `set on "${n.id}": ${bad}`);
      if (op.if && Object.hasOwn(op.if, k)) this.checkIf(`n:${n.id}:${k}`, op.if[k]);
      if (k.startsWith(DESCENDANTS_PREFIX)) paths[k.slice(DESCENDANTS_PREFIX.length)] = v;
      else whole[k] = v;
    }
    if (op.if) for (const k of Object.keys(op.if)) if (!Object.hasOwn(op.props, k)) this.fail("invalid", `set: if names "${k}", which the op does not set`);
    let props = nextProps(n.props, clone(whole), undefined);
    if (Object.keys(paths).length) {
      const cur = props.descendants;
      if (cur !== undefined && !isObj(cur)) this.fail("invalid", `set on "${n.id}": its overrides are not an object`);
      const next = nextProps(cur ?? {}, clone(paths));
      if (cur !== undefined || Object.keys(next).length) props = nextProps(props, { descendants: { v: next } });
    }
    if (op.order) props = nextProps(props, {}, op.order);
    const changed = keys.filter((k) => !k.startsWith(DESCENDANTS_PREFIX) && whole[k] !== null);
    const sticker = n.type === "sticker" && !this.ctx.replay;
    if (changed.length || sticker) {
      const probe = { ...props };
      delete probe.children;
      const errs = validateNode(probe as DocNode, { keys: changed, required: sticker });
      if (errs.length) this.fail("invalid", errs.slice(0, 3).join("; "));
    }
    const attribution = n.type === "sticky" ? "author" : n.type === "sticker" ? "by" : null;
    if (this.ctx.by && !this.ctx.replay && attribution && whole[attribution]) {
      const prior = n.props[attribution];
      const next = props[attribution];
      const allowed = prior === undefined ? whiteboardPerson(next)?.id === this.ctx.by.id : JSON.stringify(prior) === JSON.stringify(next);
      if (!allowed) this.fail("forbidden", `set on "${n.id}": cannot change whiteboard attribution`);
    }
    if (Object.hasOwn(whole, "ref") || Object.hasOwn(whole, "descendants") || Object.keys(paths).length) {
      for (const r of refsOfNode(props)) this.uses.push({ user: n.id, ref: r });
      this.cycleSeeds.push(n.id);
    }
    if (Object.hasOwn(whole, "reusable")) this.cycleSeeds.push(n.id);
    if (this.ctx.confine) this.media.push(...mediaRefsOfNode(Object.fromEntries(Object.entries(whole).filter(([, v]) => v !== null).map(([k, v]) => [k, v!.v]))), ...Object.values(paths).flatMap((v) => (v && isObj(v.v) ? mediaRefsOfNode(v.v) : [])));
    if (Object.hasOwn(n.props, "reusable") && n.props.reusable === true && whole.reusable !== undefined && (whole.reusable === null || whole.reusable.v !== true)) this.removedComponents.push(n.id);
    this.tree.writeProps(n.id, props);
    for (const k of keys) this.tree.setVer(`n:${n.id}:${k}`, this.id);
    // A whole reset also writes each path it removes or replaces. A path write changes the whole override value,
    // but leaves other paths' writers alone so independent overrides still commute.
    if (Object.hasOwn(whole, "descendants")) {
      for (const p of new Set([...Object.keys(isObj(n.props.descendants) ? n.props.descendants : {}), ...Object.keys(isObj(props.descendants) ? props.descendants : {})])) this.tree.setVer(`n:${n.id}:${DESCENDANTS_PREFIX}${p}`, this.id);
    }
    if (Object.keys(paths).length) this.tree.setVer(`n:${n.id}:descendants`, this.id);
    return op;
  }

  private insert(op: Extract<FileOp, { k: "insert" }>): AppliedOp {
    const list = this.holder(op.parent);
    const index = this.indexAfter(list, op.after, "insert");
    const node = op.node;
    if (!isObj(node)) this.fail("invalid", "insert: node must be an object");
    const errs = validateNode(node as DocNode);
    if (errs.length) this.fail("invalid", errs.slice(0, 3).join("; "));
    const ids = new Set<string>();
    let count = 0;
    const depth = walk(node as DocNode, (x) => {
      count++;
      const id = x.id;
      if (typeof id !== "string" || !id) this.fail("invalid", "insert: every node needs an id");
      if (PROTO_KEYS.has(id)) this.fail("forbidden", `insert: "${id}" is not an id`);
      if (ids.has(id)) this.fail("invalid", `insert: "${id}" appears twice`);
      if (this.tree.node(id)) this.fail("conflict", `insert: "${id}" exists already`);
      ids.add(id);
      for (const r of refsOfNode(x as Record<string, Json>)) this.uses.push({ user: id, ref: r });
      if (x.reusable === true || x.ref !== undefined || x.descendants !== undefined) this.cycleSeeds.push(id);
      if (this.ctx.confine) this.media.push(...mediaRefsOfNode(x as Record<string, Json>));
    });
    if (this.limits) {
      if (count > this.limits.insertNodes) this.fail("invalid", `insert: at most ${this.limits.insertNodes} layers at once`);
      if (depth > this.limits.insertDepth) this.fail("invalid", `insert: at most ${this.limits.insertDepth} levels deep`);
      if (this.depthOf(op.parent) + depth > this.limits.treeDepth) this.fail("invalid", `insert: the tree would be over ${this.limits.treeDepth} levels deep`);
    }
    this.tree.insert(op.parent, index, clone(node as DocNode));
    for (const id of ids) {
      this.tree.setVer(`t:${id}`, this.id);
      // An id brought back (undo) starts a fresh subtree version, not the one it had before it was removed.
      if (this.tree.ver(`s:${id}`) !== 0) this.tree.setVer(`s:${id}`, this.id);
    }
    this.touchUp(op.parent);
    return { ...op, index };
  }

  /**
   * A subtree's structure version, what a remove's `if` names: the last action that inserted, removed or moved
   * anything inside it, or moved it (`s:<id>`, written on every ancestor of such a change); until one did, the node's
   * own place version. So an undo of an insert refuses when someone added, moved or removed a layer inside since.
   */
  private structVer(id: string): Ver {
    const s = this.tree.ver(`s:${id}`);
    return s === 0 ? this.tree.ver(`t:${id}`) : s;
  }
  private touchUp(parent: string | null): void {
    if (parent === null) return;
    for (const a of [parent, ...this.tree.ancestors(parent, (this.limits?.treeDepth ?? 1024) + 1)]) this.tree.setVer(`s:${a}`, this.id);
  }

  private remove(op: Extract<FileOp, { k: "remove" }>): AppliedOp {
    const n = this.live(op.id);
    if (op.if !== undefined && this.structVer(n.id) !== op.if) this.fail("conflict", `t:${n.id} was changed by another action since`);
    const sub = this.tree.subtree(op.id)!;
    walk(sub, (x) => {
      if (x.reusable === true && typeof x.id === "string") this.removedComponents.push(x.id);
    });
    this.tree.remove(op.id);
    this.tree.setVer(`t:${op.id}`, this.id);
    this.touchUp(n.parent);
    return op;
  }

  private move(op: Extract<FileOp, { k: "move" }>): AppliedOp {
    const n = this.live(op.id);
    this.checkIf(`t:${n.id}`, op.if);
    if (op.parent !== null) {
      if (op.parent === n.id) this.fail("invalid", `move: "${n.id}" cannot go inside itself`);
      this.live(op.parent, "parent");
      if (this.tree.ancestors(op.parent, Infinity).includes(n.id)) this.fail("invalid", `move: "${n.id}" cannot go inside itself`);
    }
    const list = this.holder(op.parent).filter((x) => x !== n.id);
    if (op.after === n.id) this.fail("invalid", "move: a node cannot go after itself");
    const index = this.indexAfter(list, op.after, "move");
    if (this.limits) {
      const sub = walk(this.tree.subtree(n.id)!, () => {});
      if (this.depthOf(op.parent) + sub > this.limits.treeDepth) this.fail("invalid", `move: the tree would be over ${this.limits.treeDepth} levels deep`);
    }
    this.tree.move(n.id, op.parent, index);
    this.tree.setVer(`t:${n.id}`, this.id);
    this.tree.setVer(`s:${n.id}`, this.id);
    this.touchUp(n.parent);
    this.touchUp(op.parent);
    // A move can put an instance inside its own component (or a component inside one it holds an instance of).
    this.cycleSeeds.push(n.id);
    return { ...op, index };
  }

  private text(op: Extract<FileOp, { k: "text" }>): AppliedOp {
    const n = this.live(op.id);
    const content = n.props.content;
    if (typeof content !== "string") this.fail("invalid", `text: "${n.id}" holds no text`);
    const { from, del, ins } = op;
    if (!Number.isInteger(from) || !Number.isInteger(del) || from < 0 || del < 0 || from + del > content.length || typeof ins !== "string") this.fail("invalid", "text: the splice does not fit the text");
    const after = content.slice(0, from) + ins + content.slice(from + del);
    const set: Record<string, Val> = { content: { v: after } };
    if (op.spans !== undefined) set.spans = op.spans === null ? null : { v: op.spans };
    else if (Array.isArray(n.props.spans)) set.spans = { v: shiftSpans(n.props.spans as never, from, del, ins.length) as unknown as Json };
    if (op.lists !== undefined) set.lists = op.lists === null ? null : { v: op.lists };
    else if (Array.isArray(n.props.lists)) set.lists = { v: shiftLists(n.props.lists as unknown as ListItem[], content, from, del, ins) as unknown as Json };
    this.set({ k: "set", id: n.id, props: set });
    return { ...op, from, del };
  }

  private doc(op: Extract<FileOp, { k: "doc" }>): AppliedOp {
    const bad = docKeyError(op.key);
    if (bad) this.fail(PROTO_KEYS.has(String(op.key)) || op.key === ("children" as never) ? "forbidden" : "invalid", `doc: ${bad}`);
    if (!isVal(op.value)) this.fail("invalid", "doc: value must be {v: value} or null");
    if (op.order !== undefined && (!Array.isArray(op.order) || op.order.some((k) => typeof k !== "string"))) this.fail("invalid", "doc: order must be a list of keys");
    this.checkIf(`d:${op.key}`, op.if);
    if (op.key.startsWith("variables/")) {
      const name = op.key.slice("variables/".length);
      const cur = this.tree.docValue("variables");
      if (cur !== undefined && !isObj(cur)) this.fail("invalid", "doc: the variables are not an object");
      if (op.value) {
        const errs = validateVariable(name, op.value.v);
        if (errs.length) this.fail("invalid", `doc: variable "${name}": ${errs.join("; ")}`);
      }
      if (cur === undefined && op.value === null) return op;
      this.tree.writeDocValue("variables", nextProps(cur ?? {}, { [name]: clone(op.value) }));
      this.tree.setVer("d:variables", this.id);
    } else if (op.key === "variables") {
      const cur = this.tree.docValue("variables");
      if ((isObj(cur) && Object.keys(cur).length) || (op.value && (!isObj(op.value.v) || Object.keys(op.value.v).length))) this.fail("invalid", "doc: variables only changes an empty container; write values per variable");
      this.tree.writeDocValue("variables", op.value === null ? undefined : {});
    } else {
      if (op.key === "themes" && op.value && !isObj(op.value.v)) this.fail("invalid", "doc: themes must be an object");
      if (op.key === "fonts" && op.value && !Array.isArray(op.value.v)) this.fail("invalid", "doc: fonts must be a list");
      if (this.ctx.confine && op.key === "fonts" && op.value) this.media.push(...mediaRefsOfFonts(op.value.v));
      this.tree.writeDocValue(op.key as "themes" | "fonts", op.value === null ? undefined : clone(op.value.v));
    }
    this.tree.setVer(`d:${op.key}`, this.id);
    if (op.order) this.tree.orderDocKeys(op.order);
    return op;
  }

  private widget(op: Extract<FileOp, { k: "widget" }>): AppliedOp {
    if (typeof op.id !== "string" || !op.id || PROTO_KEYS.has(op.id)) this.fail("invalid", "widget: id must be a non-empty string");
    if (!isVal(op.value)) this.fail("invalid", "widget: value must be {v: card} or null");
    this.checkIf(`w:${op.id}`, op.if);
    const list = this.tree.widgetIds();
    const has = list.includes(op.id);
    if (op.value === null) {
      if (op.after !== undefined) this.fail("invalid", "widget: a removal has no place");
      if (has) this.tree.writeWidget(op.id, undefined, undefined);
    } else {
      const w = op.value.v;
      if (!isObj(w) || w.id !== op.id || typeof w.kind !== "string" || !w.kind) this.fail("invalid", "widget: a card is an object with this id and a kind");
      if (this.ctx.confine) this.media.push(...mediaRefsOfWidget(w));
      const index = op.after === undefined ? undefined : this.indexAfter(list.filter((x) => x !== op.id), op.after, "widget");
      this.tree.writeWidget(op.id, clone(w), index);
    }
    this.tree.setVer(`w:${op.id}`, this.id);
    return op;
  }

  private pagesNow(): PageRow[] {
    return (this.tree.pages() ?? []).map((p) => ({ id: p.id, name: p.name, boards: [...p.boards] }));
  }

  private page(op: Extract<FileOp, { k: "page" }>): AppliedOp {
    if (typeof op.id !== "string" || !op.id || op.id.length > 200 || PROTO_KEYS.has(op.id)) this.fail("invalid", "page: id must be a non-empty string");
    this.checkIf(`p:${op.id}`, op.if);
    const list = this.pagesNow();
    const at = list.findIndex((p) => p.id === op.id);
    if (op.value === null) {
      if (op.after !== undefined) this.fail("invalid", "page: a removal has no place");
      if (at < 0) return op;
      if (list.length === 1) this.fail("invalid", "page: a file keeps at least one page");
      list.splice(at, 1);
    } else {
      const v = op.value;
      if (!isObj(v) || !isObj(v.v) || Object.keys(v).length !== 1 || typeof v.v.name !== "string" || !v.v.name || v.v.name.length > 200 || Object.keys(v.v).length !== 1) this.fail("invalid", "page: value must be {v: {name}}");
      const row = at >= 0 ? list.splice(at, 1)[0] : { id: op.id, name: "", boards: [] as string[] };
      row.name = v.v.name as string;
      const index = op.after === undefined ? (at >= 0 ? at : list.length) : this.indexAfter(list.map((p) => p.id), op.after, "page");
      list.splice(index, 0, row);
    }
    this.tree.writePages(list);
    this.tree.setVer(`p:${op.id}`, this.id);
    return op;
  }

  private pageOf(op: Extract<FileOp, { k: "pageOf" }>): AppliedOp {
    if (typeof op.board !== "string" || !op.board) this.fail("invalid", "pageOf: board must be an id");
    this.checkIf(`po:${op.board}`, op.if);
    const list = this.pagesNow();
    for (const p of list) {
      const i = p.boards.indexOf(op.board);
      if (i >= 0) (p.boards as string[]).splice(i, 1);
    }
    if (op.page !== null) {
      if (op.after === op.board) this.fail("invalid", "pageOf: a board cannot go after itself");
      const p = list.find((x) => x.id === op.page);
      if (!p) this.fail("conflict", `pageOf: page "${op.page}" is gone`);
      const index = op.after === undefined ? p.boards.length : this.indexAfter(p.boards, op.after, "pageOf");
      (p.boards as string[]).splice(index, 0, op.board);
    } else if (op.after !== undefined) this.fail("invalid", "pageOf: a board on no page has no place");
    if (!this.tree.pages() && op.page === null) return op;
    this.tree.writePages(list);
    this.tree.setVer(`po:${op.board}`, this.id);
    return op;
  }

  private metaOp(op: Extract<FileOp, { k: "meta" }>): AppliedOp {
    if (!META_KEYS.includes(op.key)) this.fail(PROTO_KEYS.has(String(op.key)) ? "forbidden" : "invalid", `meta: "${op.key}" is not a key a file keeps beside its cards`);
    if (!isVal(op.value)) this.fail("invalid", "meta: value must be {v: value} or null");
    this.checkIf(`m:${op.key}`, op.if);
    this.tree.writeMeta(op.key, op.value === null ? undefined : clone(op.value.v));
    this.tree.setVer(`m:${op.key}`, this.id);
    return op;
  }

  private blob(op: Extract<FileOp, { k: "blob" }>): AppliedOp {
    const bad = checkBlobPath(op.path);
    if (bad) this.fail("forbidden", `blob: ${bad}`);
    if (typeof op.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(op.sha256)) this.fail("invalid", "blob: sha256 must be 64 hex digits");
    if (!Number.isSafeInteger(op.bytes) || op.bytes < 0) this.fail("invalid", "blob: bytes must be a whole number");
    if (op.type !== blobTypeOf(op.path as BlobPath)) this.fail("invalid", `blob: ${op.path} is stored as ${blobTypeOf(op.path as BlobPath)}`);
    const have = this.tree.blob(op.path);
    if (have) {
      if (have.sha256 !== op.sha256) this.fail("conflict", `blob: ${op.path} holds other bytes; a file is never replaced`);
      return op;
    }
    this.tree.addBlob(op.path, { sha256: op.sha256, bytes: op.bytes, type: op.type });
    return op;
  }

  /** The checks that wait until every op ran. */
  finish(): void {
    this.at = -1;
    for (const c of this.removedComponents) {
      if (this.tree.isComponent(c)) continue;
      if (this.tree.hasRefUsers(c)) this.fail("conflict", `"${c}" is a component that instances use`);
    }
    for (const u of this.uses) if (this.tree.node(u.user) && !this.tree.isComponent(u.ref)) this.fail("invalid", `"${u.user}" uses "${u.ref}", which is not a component`);
    for (const m of this.media) {
      const bad = confinedRefError(this.tree, m);
      if (bad) this.fail("forbidden", bad);
    }
    const seen = new Set<string>();
    for (const s of this.cycleSeeds) {
      if (!this.tree.node(s)) continue;
      for (const c of [s, ...this.tree.ancestors(s, Infinity)]) {
        if (seen.has(c) || !this.tree.isComponent(c)) continue;
        seen.add(c);
        if (this.reaches(c, c)) this.fail("invalid", `the component "${c}" would hold an instance of itself`);
      }
    }
  }

  /** Does the subtree of component `from` use `target`, directly or through the components it uses? */
  private reaches(from: string, target: string): boolean {
    const done = new Set<string>();
    const todo = [from];
    while (todo.length) {
      const c = todo.pop()!;
      if (done.has(c)) continue;
      done.add(c);
      const sub = this.tree.subtree(c);
      if (!sub) continue;
      let hit = false;
      walk(sub, (x) => {
        for (const r of refsOfNode(x as Record<string, Json>)) {
          if (r === target) hit = true;
          else if (!done.has(r)) todo.push(r);
        }
      });
      if (hit) return true;
    }
    return false;
  }
}
