// Instance overrides: a layer inside a component instance ("Inst/Child", "Inst/Nested/Child") takes
// its own fill, stroke, opacity, visibility, corner radius, font and text props. The change goes into the outer
// instance's `descendants`, keyed by the path below it, the same place text overrides go (src/textedit.ts); the
// component itself is left alone. An instance's own props (its fill, padding...) are stored on the ref node.
//
// POST /api/update with any path id lands here (src/server.ts): one write, one undo step, plain ids in the same
// request are updated as usual. `remove` on a path id resets that property to what the component draws; a fill,
// stroke or effect the component still draws becomes an empty list instead ("no fill" is an override too).
//
// POST /api/overrides/reset {file, id, keys?} -> {ok, changed, revision}: "Reset all changes". On an instance:
// its own overrides (not where it sits or its size) and every override below it. On a layer inside one: that layer's
// overrides and those below it. With `keys`, only those properties (a reset of one property; "descendants" on
// an instance is every override on the layers inside it).
//
// POST /api/overrides/swap {file, id | ids, component} -> {ok, changed, kept, dropped, revision}: instance
// swap. The instance points at another component; its own overrides stay, and an override on a layer inside it
// carries over when the new component has a layer of the same type at the same path of layer names (the rule:
// names and hierarchy match). An instance whose name was its old main's follows the new main's. One undo step.
// A nested instance ("Outer/Nested", a swap from a nested instance's menu) swaps through an override in the
// outer instance's `descendants` at its path: `{ref, descendants?}` without a node type (isSwapEntry). Its id path
// stays; the outer instance's overrides below it carry over by the same rule, and so do the main's own overrides on
// it (into the override's `descendants`). Reset of `ref` (keys ["ref"]) puts the component it drew back.
//
// POST /api/overrides/push {file, id} -> {ok, changed, pushed, kept, main, revision}: "Push changes to main
// component". The instance's overrides become the main component's own values (every instance without an override
// of its own takes them) and leave the instance; a replacement node stays on the instance. One undo step.
//
// overrideInfo (GET /api/node): which props of a node are overrides, and an instance's props as drawn.

import type http from "node:http";
import { buildIndex, expand, findNode, StaleFileError, updateNode, validateNode, ValidationError, type Json, type CanvasDoc, type DocNode } from "./engine.ts";
import { currentDoc, editDoc } from "./docwriter.ts";
import { nodeDiff, nodeLabel, propsOf, record, type NodeOp } from "./history.ts";
import { replacementsIn } from "./scale.ts";
import { drawnNode, textTarget, type TextTarget } from "./textedit.ts";
import { readBodyText } from "./body.ts";

export class OverrideError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Keys an override never holds: what the node is, and the tree. */
const STRUCTURAL = new Set(["id", "type", "children", "ref", "descendants", "reusable"]);
/** An instance's own keys that say where it sits, not how it looks: never counted or reset as overrides. */
const PLACEMENT = new Set(["id", "type", "ref", "descendants", "x", "y", "width", "height", "layoutPosition", "rotation", "flipX", "flipY", "name", "metadata", "context", "theme"]);
/** Paint lists: removing one the component draws writes an empty list ("none"), not a reset. */
const LISTS = new Set(["fill", "stroke", "effect"]);

const clone = <T>(v: T): T => structuredClone(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Where a write to scene id `id` goes, or a 404/409 OverrideError. */
export function targetOf(doc: CanvasDoc, id: string): TextTarget {
  const t = textTarget(doc, id);
  if (t) return t;
  throw new OverrideError(id.includes("/") ? 409 : 404, id.includes("/") ? "unsupported" : "not_found", id.includes("/") ? "that layer lives inside a component in a way Canvas cannot override; edit the component" : `no node "${id}"`);
}

/** The override entry a target edits, created on demand (null for a plain node). */
function entryOf(d: Record<string, DocNode>, t: TextTarget, create: boolean): Record<string, Json> | null {
  if (t.kind === "override") {
    if (!isObj(d[t.key])) { if (!create) return null; d[t.key] = {} as DocNode; }
    return d[t.key] as Record<string, Json>;
  }
  if (t.kind === "repOverride") {
    const rep = replacementsIn(d).get(t.rep);
    if (!rep) throw new OverrideError(404, "not_found", `no replacement "${t.rep}" in ${t.inst}`);
    const rd = (isObj(rep.descendants) ? rep.descendants : (rep.descendants = {} as Json)) as Record<string, Json>;
    if (!isObj(rd[t.key])) { if (!create) return null; rd[t.key] = {}; }
    return rd[t.key] as Record<string, Json>;
  }
  if (t.kind === "replacement") {
    const rep = replacementsIn(d).get(t.id);
    if (!rep) throw new OverrideError(404, "not_found", `no replacement "${t.id}" in ${t.inst}`);
    return rep as Record<string, Json>;
  }
  return null;
}

/** Drop empty override entries (an entry that only held what was just reset). */
function prune(d: Record<string, DocNode>, t: TextTarget): void {
  if (t.kind === "override" && isObj(d[t.key]) && !Object.keys(d[t.key]).length) delete d[t.key];
  if (t.kind === "repOverride") {
    const rep = replacementsIn(d).get(t.rep);
    const rd = rep && isObj(rep.descendants) ? (rep.descendants as Record<string, Json>) : null;
    if (rd && isObj(rd[t.key]) && !Object.keys(rd[t.key] as object).length) delete rd[t.key];
    if (rep && rd && !Object.keys(rd).length) delete rep.descendants;
  }
}

/**
 * Write props (and removals) for one scene id into `doc`: the node itself, or an override in its instance.
 * Returns the stored id whose props changed (for the undo op).
 */
export function applyUpdate(doc: CanvasDoc, id: string, props: Record<string, Json>, remove: string[] = []): string {
  const t = targetOf(doc, id);
  if (t.kind === "node") { updateNode(doc, t.id, props, remove); return t.id; }
  for (const k of [...Object.keys(props), ...remove]) if (STRUCTURAL.has(k)) throw new ValidationError(`"${k}" cannot be overridden in an instance`);
  const drawn = drawnNode(doc, t, id);
  if (!drawn) throw new OverrideError(404, "not_found", "that layer was deleted");
  // What the layer would draw with this change: the same checks a plain node's edit gets.
  const trial: DocNode = { ...drawn, ...clone(props), id: id.split("/").pop() ?? id } as DocNode;
  for (const k of remove) delete trial[k];
  const errs = validateNode(trial, { keys: Object.keys(props) });
  if (errs.length) throw new ValidationError(errs.join("; "));
  const inst = findNode(doc, t.inst).node;
  const d = clone((isObj(inst.descendants) ? inst.descendants : {}) as Record<string, DocNode>);
  const entry = entryOf(d, t, true)!;
  for (const k of remove) delete entry[k];
  Object.assign(entry, clone(props));
  inst.descendants = d as unknown as Json;
  // A removed paint the component still draws: "none", an empty list.
  const now = remove.length ? drawnNode(doc, t, id) : undefined;
  if (now) for (const k of remove) if (LISTS.has(k) && now[k] !== undefined && !(Array.isArray(now[k]) && !(now[k] as Json[]).length)) entry[k] = [];
  prune(d, t);
  if (Object.keys(d).length) inst.descendants = d as unknown as Json;
  else delete inst.descendants;
  return t.inst;
}

/**
 * Reset the overrides of a scene id (see the top of this file): all of them, or only `keys`. Returns the stored id
 * that changed, or null.
 */
export function applyReset(doc: CanvasDoc, id: string, keys?: string[]): string | null {
  const t = targetOf(doc, id);
  const only = Array.isArray(keys) && keys.length ? new Set(keys) : null;
  if (t.kind === "node") {
    const n = findNode(doc, t.id).node;
    if (n.type !== "ref") throw new OverrideError(400, "invalid", "select an instance, or a layer inside one, to reset its overrides");
    const own = Object.keys(n).filter((k) => !PLACEMENT.has(k) && (!only || only.has(k)));
    const inside = n.descendants !== undefined && (!only || only.has("descendants"));
    if (!own.length && !inside) return null;
    for (const k of own) delete n[k];
    if (inside) delete n.descendants;
    return t.id;
  }
  // A nested instance's swap: Reset of `ref` puts back the component it drew (resetNestedSwap).
  const swapReset = !!only?.has("ref") && t.kind === "override" && resetNestedSwap(doc, id, t);
  const inst = findNode(doc, t.inst).node;
  if (!isObj(inst.descendants)) return swapReset ? t.inst : null;
  const d = clone(inst.descendants as Record<string, DocNode>);
  if (only) {
    // That layer's named properties only; the layers below it keep theirs.
    if (t.kind === "replacement") return null;
    const entry = entryOf(d, t, false);
    const gone = entry ? Object.keys(entry).filter((k) => only.has(k) && !STRUCTURAL.has(k)) : [];
    if (!entry || !gone.length) return swapReset ? t.inst : null;
    for (const k of gone) delete entry[k];
    prune(d, t);
    if (Object.keys(d).length) inst.descendants = d as unknown as Json;
    else delete inst.descendants;
    return t.inst;
  }
  let changed = false;
  const clear = (o: Record<string, Json>, key: string) => {
    for (const k of Object.keys(o)) if (k === key || k.startsWith(key + "/")) {
      // A replacement node keeps itself (it is not a property override); its own overrides go.
      if (k === key && isObj(o[k]) && (o[k] as DocNode).type) continue;
      delete o[k];
      changed = true;
    }
  };
  if (t.kind === "override") clear(d as Record<string, Json>, t.key);
  else if (t.kind === "repOverride") {
    const rep = replacementsIn(d).get(t.rep);
    if (rep && isObj(rep.descendants)) { clear(rep.descendants as Record<string, Json>, t.key); if (!Object.keys(rep.descendants).length) delete rep.descendants; }
  } else return null;
  if (!changed) return null;
  if (Object.keys(d).length) inst.descendants = d as unknown as Json;
  else delete inst.descendants;
  return t.inst;
}

/**
 * What the inspector needs about a node's overrides: the overridden keys, and for an instance its props as drawn
 * (its component's, with its own on top) and its children (instance paths), so Enter can step into it.
 */
export function overrideInfo(doc: CanvasDoc, id: string): { overrides: string[]; resolved?: DocNode; instance?: string } {
  const t = textTarget(doc, id);
  if (!t) return { overrides: [] };
  if (t.kind === "node") {
    let n: DocNode;
    try { n = findNode(doc, t.id).node; } catch { return { overrides: [] }; }
    if (n.type !== "ref") return { overrides: [] };
    const overrides = Object.keys(n).filter((k) => !PLACEMENT.has(k));
    let resolved: DocNode | undefined;
    try {
      const e = expand(buildIndex(doc), n, []);
      resolved = { ...e };
      delete (resolved as Record<string, unknown>).__ref;
      delete resolved.children;
    } catch { /* a missing or looping component: the stored ref is all there is */ }
    if (isObj(n.descendants) && Object.keys(n.descendants).length) overrides.push("descendants");
    return { overrides, resolved, instance: t.id };
  }
  const inst = findNode(doc, t.inst).node;
  const d = clone((isObj(inst.descendants) ? inst.descendants : {}) as Record<string, DocNode>);
  let entry: Record<string, Json> | null = null;
  try { entry = entryOf(d, t, false); } catch { entry = null; }
  const overrides = entry ? Object.keys(entry).filter((k) => !STRUCTURAL.has(k)) : [];
  // A swapped nested instance: the swap is an override of its own (Reset puts the original component back).
  if (t.kind === "override" && isSwapEntry(entry)) overrides.unshift("ref");
  return { overrides, instance: t.inst };
}

/**
 * An instance's name stays in step with its main component until the instance is renamed. The file stores a name
 * on most instances, so: the instances whose stored name is the main's old name, when `props` renames a main.
 */
export function renameFollowers(doc: CanvasDoc, id: string, props: Record<string, Json>): string[] {
  if (typeof props.name !== "string" || id.includes("/")) return [];
  let main: DocNode;
  try { main = findNode(doc, id).node; } catch { return []; }
  if (main.reusable !== true || typeof main.name !== "string" || main.name === props.name) return [];
  const out: string[] = [];
  const visit = (n: DocNode) => {
    if (n.type === "ref" && n.ref === id && n.name === main.name && typeof n.id === "string") out.push(n.id);
    for (const c of (n.children as DocNode[] | undefined) ?? []) visit(c);
  };
  doc.children.forEach(visit);
  return out;
}
/** Drop the stored name of each follower, so it shows its main's name; the undo ops for it. */
export function followRename(doc: CanvasDoc, ids: string[]): NodeOp[] {
  const ops: NodeOp[] = [];
  for (const id of ids) {
    let n: DocNode;
    try { n = findNode(doc, id).node; } catch { continue; }
    const before = propsOf(n);
    delete n.name;
    const op = nodeDiff(id, before, propsOf(n));
    if (Object.keys(op.props).length) ops.push(op);
  }
  return ops;
}

export type UpdateBody = { file?: string; id?: string; ids?: string[]; props?: Record<string, Json>; remove?: string[]; expectedRevision?: string; gesture?: string };

/** One write and one undo step for an update that names a layer inside an instance (plain ids may come along). */
export function updateWithOverrides(docFile: string, b: UpdateBody, who: { source: "user" | "mcp"; session?: string }): { revision?: string; ids: string[] } {
  const ids = (b.id ? [b.id] : (b.ids ?? [])).filter((i) => typeof i === "string" && i && !i.startsWith("widget:"));
  if (!ids.length || !isObj(b.props)) throw new OverrideError(400, "invalid", "file, ids and props are required");
  const props = b.props as Record<string, Json>, remove = Array.isArray(b.remove) ? b.remove : [];
  let ops: NodeOp[] = [];
  const { write } = editDoc(docFile, { expectedRevision: b.expectedRevision, touches: ids.map((i) => i.split("/")[0]) }, (doc) => {
    // The change may run twice (a replay after an outside save); the last run is the one written.
    const before = new Map<string, Record<string, unknown>>();
    const touched: string[] = [];
    for (const id of ids) {
      const anchor = targetOf(doc, id).kind === "node" ? id : (targetOf(doc, id) as { inst: string }).inst;
      if (!before.has(anchor)) { before.set(anchor, propsOf(findNode(doc, anchor).node)); touched.push(anchor); }
      applyUpdate(doc, id, props, remove);
    }
    ops = touched.map((a) => nodeDiff(a, before.get(a)!, propsOf(findNode(doc, a).node))).filter((o) => Object.keys(o.props).length);
  });
  const keys = [...new Set([...Object.keys(props), ...remove])].sort();
  if (ops.length) record(docFile, ops, { label: nodeLabel(keys), source: who.source, session: who.session, mergeKey: `nodes:${[...ids].sort().join(",")}:${keys.join(",")}${typeof b.gesture === "string" && b.gesture ? `#gesture:${b.gesture.slice(0, 64)}` : ""}`, ...(b.gesture ? { mergeMs: 60_000 } : {}), edit: write.edit }, write.revision);
  return { revision: write.revision, ids };
}

/** Reset overrides: one write, one undo step ("Reset Overrides"). No overrides: no write. */
export function resetOverrides(docFile: string, id: string, expectedRevision: string | undefined, who: { source: "user" | "mcp"; session?: string }, keys?: string[]): { changed: boolean; revision?: string } {
  const doc = currentDoc(docFile).doc;
  const probe = clone(doc);
  if (!applyReset(probe, id, keys)) return { changed: false };
  let op: NodeOp | undefined;
  const { write } = editDoc(docFile, { expectedRevision, touches: [id.split("/")[0]] }, (d) => {
    const t = targetOf(d, id);
    const anchor = t.kind === "node" ? t.id : t.inst;
    const before = propsOf(findNode(d, anchor).node);
    applyReset(d, id, keys);
    op = nodeDiff(anchor, before, propsOf(findNode(d, anchor).node));
  });
  if (op && Object.keys(op.props).length) record(docFile, [op], { label: keys?.length ? "Reset Override" : "Reset Overrides", source: who.source, session: who.session, mergeKey: `reset:${Date.now()}:${Math.random()}`, edit: write.edit }, write.revision);
  return { changed: true, revision: write.revision };
}

// ---------------------------------------------------------------- swap instance

type LayerPath = { names: string; type: string; inst: boolean };

/**
 * The layers below `root` (an expanded node whose id is `rootId`) by their key below it ("Lbl", "Nested/Lbl"), with
 * their path of layer names (an unnamed layer by its type), type and whether each is an instance. Siblings of the
 * same name count up ("Label#1").
 */
function namePaths(root: DocNode, rootId: string): Map<string, LayerPath> {
  const out = new Map<string, LayerPath>();
  const pre = rootId + "/";
  const visit = (n: DocNode, prefix: string) => {
    const seen = new Map<string, number>();
    for (const c of Array.isArray(n.children) ? (n.children as DocNode[]) : []) {
      if (!c || typeof c !== "object" || typeof c.id !== "string" || !c.id.startsWith(pre)) continue;
      const label = typeof c.name === "string" && c.name ? c.name : `<${String(c.type)}>`;
      const k = seen.get(label) ?? 0;
      seen.set(label, k + 1);
      const names = `${prefix}/${label}#${k}`;
      out.set(c.id.slice(pre.length), { names, type: String(c.type), inst: typeof (c as Record<string, unknown>).__ref === "string" });
      visit(c, names);
    }
  };
  visit(root, "");
  return out;
}

/** Every layer of a component as an instance draws it (see namePaths). */
export function layerNamePaths(doc: CanvasDoc, component: string): Map<string, LayerPath> {
  const ROOT = "\u0000swap";
  let root: DocNode;
  try { root = expand(buildIndex(doc), { id: ROOT, type: "ref", ref: component } as DocNode, []); } catch { return new Map(); }
  return namePaths(root, ROOT);
}

/**
 * An override that swaps a nested instance: `ref` (and the overrides it carried, `descendants`) without a node type,
 * stored in the outer instance's `descendants` under the nested instance's path. A node with a type replaces the layer.
 */
export const isSwapEntry = (v: unknown): v is Record<string, Json> & { ref: string } => isObj(v) && typeof v.ref === "string" && !(v as DocNode).type;

const prettyNames = (names: string) => names.split("/").map((s) => s.replace(/#\d+$/, "")).filter(Boolean).join("/");

/**
 * Overrides keyed below an instance of one component, re-keyed for an instance of another (the rule: a layer of
 * the same type at the same path of layer names; a swap only lands on an instance). `from`: the old component's
 * layers; `drawn`: the layers as the instance draws them now (a deeper swap's layers). The rest is dropped, by name.
 */
function carry(entries: Record<string, Json>, from: Map<string, LayerPath>, to: Map<string, LayerPath>, drawn?: Map<string, LayerPath>): { kept: Record<string, Json>; dropped: string[] } {
  const byNames = new Map<string, LayerPath & { key: string }>();
  for (const [key, v] of to) byNames.set(v.names, { key, ...v });
  const kept: Record<string, Json> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    const a = from.get(k) ?? drawn?.get(k), b = a ? byNames.get(a.names) : undefined;
    if (a && b && b.type === a.type && (!isSwapEntry(v) || b.inst)) kept[b.key] = clone(v);
    else dropped.push(a ? prettyNames(a.names) : k);
  }
  return { kept, dropped };
}

/** The components a component draws through its instances (refs in its tree and in its overrides), itself included. */
function reachable(doc: CanvasDoc, component: string): Set<string> {
  const index = buildIndex(doc);
  const out = new Set<string>();
  const walkRefs = (n: DocNode) => {
    if (!n || typeof n !== "object") return;
    if ((n.type === "ref" || isSwapEntry(n)) && typeof n.ref === "string") add(n.ref);
    if (isObj(n.descendants)) for (const v of Object.values(n.descendants)) if (isObj(v)) walkRefs(v as DocNode);
    for (const c of Array.isArray(n.children) ? (n.children as DocNode[]) : []) walkRefs(c);
  };
  const add = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    const n = index.get(id);
    if (n) walkRefs(n);
  };
  add(component);
  return out;
}

/** The target component checked: it exists and is a component, and the instance's components are not inside it. */
function checkTarget(doc: CanvasDoc, component: string, ancestors: DocNode[]): DocNode {
  let main: DocNode;
  try { main = findNode(doc, component).node; } catch { throw new OverrideError(404, "not_found", `no component "${component}"`); }
  if (main.reusable !== true) throw new OverrideError(400, "invalid", `"${component}" is not a component`);
  // An instance inside a component cannot become (or hold) that component.
  const owners = ancestors.filter((a) => a.reusable === true).map((a) => String(a.id));
  const reach = reachable(doc, component);
  const loop = owners.find((o) => reach.has(o));
  if (loop) throw new OverrideError(400, "invalid", `"${String(main.name ?? component)}" holds the component this instance sits in; an instance cannot contain itself`);
  return main;
}

/** The stored node a scene id starts from: the id itself, or the instance whose overrides a path id writes. */
function anchorOf(doc: CanvasDoc, id: string): string {
  if (!id.includes("/")) return id;
  const t = textTarget(doc, id);
  if (!t) throw new OverrideError(404, "not_found", `no node "${id}"`);
  return t.kind === "node" ? t.id : t.inst;
}

/** Point instance `id` at `component` (see the top of this file). null when it already does. */
export function applySwap(doc: CanvasDoc, id: string, component: string): { kept: number; dropped: string[] } | null {
  if (id.includes("/")) return applyNestedSwap(doc, id, component);
  let found: { node: DocNode; ancestors: DocNode[] };
  try { found = findNode(doc, id); } catch { throw new OverrideError(404, "not_found", `no node "${id}"`); }
  const n = found.node;
  if (n.type !== "ref") throw new OverrideError(400, "invalid", "select an instance to swap");
  if (n.ref === component) return null;
  checkTarget(doc, component, found.ancestors);
  const oldId = String(n.ref);
  let oldName: unknown;
  try { oldName = findNode(doc, oldId).node.name; } catch { oldName = undefined; }
  let drawn: Map<string, LayerPath> | undefined;
  try { drawn = namePaths(expand(buildIndex(doc), n, []), id); } catch { drawn = undefined; }
  const { kept, dropped } = carry(isObj(n.descendants) ? (n.descendants as Record<string, Json>) : {}, layerNamePaths(doc, oldId), layerNamePaths(doc, component), drawn);
  n.ref = component;
  if (Object.keys(kept).length) n.descendants = kept as Json;
  else delete n.descendants;
  // An instance's name stays in step with its main until the instance is renamed.
  if (typeof n.name === "string" && n.name === oldName) delete n.name;
  return { kept: Object.keys(kept).length, dropped };
}

/** The node at scene id `id` as instance `inst` (stored, the path's head) draws it. */
function seekDrawn(doc: CanvasDoc, inst: DocNode, id: string): DocNode | undefined {
  const seek = (n: DocNode): DocNode | undefined => {
    if (!n || typeof n !== "object") return undefined;
    if (String(n.id) === id) return n;
    if (!id.startsWith(String(n.id) + "/")) return undefined;
    for (const c of Array.isArray(n.children) ? (n.children as DocNode[]) : []) {
      const hit = seek(c);
      if (hit) return hit;
    }
    return undefined;
  };
  try { return seek(expand(buildIndex(doc), inst, [])); } catch { return undefined; }
}

/** The component a nested instance draws without its outer instance's swap of it: what Reset puts back. */
function nestedOriginal(doc: CanvasDoc, inst: DocNode, key: string, id: string): string | undefined {
  const base = clone(inst);
  const d = isObj(base.descendants) ? (base.descendants as Record<string, Json>) : {};
  const e = isObj(d[key]) ? { ...(d[key] as Record<string, Json>) } : null;
  if (e && isSwapEntry(e)) {
    delete (e as Record<string, Json>).ref;
    delete e.descendants;
    if (Object.keys(e).length) d[key] = e;
    else delete d[key];
  }
  base.descendants = d as Json;
  const n = seekDrawn(doc, base, id);
  const r = n ? (n as Record<string, unknown>).__ref : undefined;
  return typeof r === "string" ? r : undefined;
}

/**
 * Swap the nested instance at scene id `id` ("Outer/Nested", "Outer/Inner/Nested") for `component`, a swap of
 * a nested instance: an override in the outer instance's `descendants` at the nested instance's path sets `ref`; the
 * main components are left alone. The outer instance's overrides below it, and the main's own overrides on it, carry
 * over by layer names (as a top-level swap's do); the main's go with the swap (`descendants` on the override). Back to
 * the component it draws without the swap: no override at all.
 */
function applyNestedSwap(doc: CanvasDoc, id: string, component: string): { kept: number; dropped: string[] } | null {
  const t = textTarget(doc, id);
  if (!t) throw new OverrideError(404, "not_found", `no node "${id}"`);
  if (t.kind !== "override") throw new OverrideError(409, "unsupported", "that instance sits in a layer that replaced one of its component's; swap it in the component that placed it");
  const found = findNode(doc, t.inst);
  const inst = found.node;
  const key = t.key;
  const now = seekDrawn(doc, inst, id);
  if (!now) throw new OverrideError(404, "not_found", `no node "${id}"`);
  const cur = (now as Record<string, unknown>).__ref;
  if (typeof cur !== "string") throw new OverrideError(400, "invalid", "select an instance to swap");
  const d = clone((isObj(inst.descendants) ? inst.descendants : {}) as Record<string, Json>);
  const entry = isObj(d[key]) ? (d[key] as Record<string, Json>) : {};
  if ((entry as DocNode).type) throw new OverrideError(409, "unsupported", "that instance replaced a layer of its component; swap it in the component that placed it");
  if (cur === component) return null;
  checkTarget(doc, component, found.ancestors);
  const original = nestedOriginal(doc, inst, key, id);
  const from = layerNamePaths(doc, cur), to = layerNamePaths(doc, component), drawn = namePaths(now, id);
  // The outer instance's overrides on layers below the nested one.
  const below: Record<string, Json> = {};
  for (const k of Object.keys(d)) if (k.startsWith(key + "/")) { below[k.slice(key.length + 1)] = d[k]; delete d[k]; }
  const outer = carry(below, from, to, drawn);
  // The main's own overrides on the nested instance (or the ones an earlier swap carried), when they are for `cur`.
  let own: Record<string, Json> = {};
  if (isSwapEntry(entry)) own = isObj(entry.descendants) ? (entry.descendants as Record<string, Json>) : {};
  else {
    try {
      const stored = findNode(doc, key.split("/").pop()!).node;
      if (stored.type === "ref" && stored.ref === cur && isObj(stored.descendants)) own = stored.descendants as Record<string, Json>;
    } catch { /* the nested layer's stored node is not in this file: nothing of the main's to carry */ }
  }
  const swapped = component !== original;
  const mains = swapped ? carry(own, from, to, drawn) : { kept: {}, dropped: [] };
  const next: Record<string, Json> = { ...entry };
  delete next.ref;
  delete next.descendants;
  if (swapped) {
    next.ref = component;
    if (Object.keys(mains.kept).length) next.descendants = mains.kept as Json;
  }
  if (Object.keys(next).length) d[key] = next as Json;
  else delete d[key];
  for (const [k, v] of Object.entries(outer.kept)) d[`${key}/${k}`] = v;
  if (Object.keys(d).length) inst.descendants = d as Json;
  else delete inst.descendants;
  return { kept: Object.keys(outer.kept).length + Object.keys(mains.kept).length, dropped: [...outer.dropped, ...mains.dropped] };
}

/** A nested instance's swap undone (Reset of `ref`): the component it draws without it, overrides carried back. */
function resetNestedSwap(doc: CanvasDoc, id: string, t: Extract<TextTarget, { kind: "override" }>): boolean {
  const inst = findNode(doc, t.inst).node;
  const e = isObj(inst.descendants) ? (inst.descendants as Record<string, Json>)[t.key] : undefined;
  if (!isSwapEntry(e)) return false;
  const original = nestedOriginal(doc, inst, t.key, id);
  if (!original) {
    // Nothing to draw without it (the original component is gone): the swap and what it carried go.
    const d = clone(inst.descendants as Record<string, Json>);
    const next = { ...(d[t.key] as Record<string, Json>) };
    delete next.ref;
    delete next.descendants;
    if (Object.keys(next).length) d[t.key] = next;
    else delete d[t.key];
    if (Object.keys(d).length) inst.descendants = d as Json;
    else delete inst.descendants;
    return true;
  }
  return !!applyNestedSwap(doc, id, original);
}

/** Swap instances: one write, one undo step ("Swap Instance"). Top-level and nested instances alike. */
export function swapInstances(docFile: string, ids: string[], component: string, expectedRevision: string | undefined, who: { source: "user" | "mcp"; session?: string }): { changed: boolean; kept: number; dropped: string[]; revision?: string } {
  const probe = clone(currentDoc(docFile).doc);
  let any = false;
  for (const id of ids) if (applySwap(probe, id, component)) any = true;
  if (!any) return { changed: false, kept: 0, dropped: [] };
  let ops: NodeOp[] = [];
  let kept = 0, dropped: string[] = [];
  const { write } = editDoc(docFile, { expectedRevision, touches: [...new Set(ids.map((i) => i.split("/")[0]))] }, (d) => {
    ops = []; kept = 0; dropped = [];
    const before = new Map<string, Record<string, unknown>>();
    for (const id of ids) {
      const anchor = anchorOf(d, id);
      if (!before.has(anchor)) before.set(anchor, propsOf(findNode(d, anchor).node));
      const r = applySwap(d, id, component);
      if (!r) continue;
      kept += r.kept;
      dropped.push(...r.dropped);
    }
    ops = [...before].map(([a, b]) => nodeDiff(a, b, propsOf(findNode(d, a).node)));
    // A loop the checks missed would draw forever: refuse it.
    for (const a of before.keys()) expand(buildIndex(d), findNode(d, a).node, []);
  });
  ops = ops.filter((o) => Object.keys(o.props).length);
  if (ops.length) record(docFile, ops, { label: "Swap Instance", source: who.source, session: who.session, mergeKey: `swap:${Date.now()}:${Math.random()}`, edit: write.edit }, write.revision);
  return { changed: true, kept, dropped: [...new Set(dropped)], revision: write.revision };
}

// ---------------------------------------------------------------- push changes to main

/** Move instance `id`'s overrides into its main component (see the top of this file); null when it has none. */
export function applyPush(doc: CanvasDoc, id: string): { main: string; pushed: number; kept: string[] } | null {
  if (id.includes("/")) throw new OverrideError(409, "unsupported", "push from the instance itself, not a layer inside it");
  let n: DocNode;
  try { n = findNode(doc, id).node; } catch { throw new OverrideError(404, "not_found", `no node "${id}"`); }
  if (n.type !== "ref") throw new OverrideError(400, "invalid", "select an instance to push its changes to its main component");
  const mainId = String(n.ref);
  let main: DocNode;
  try { main = findNode(doc, mainId).node; } catch { throw new OverrideError(404, "not_found", `the main component "${mainId}" is not in this file`); }
  const own = Object.keys(n).filter((k) => !PLACEMENT.has(k));
  const desc = isObj(n.descendants) ? (n.descendants as Record<string, Json>) : {};
  if (!own.length && !Object.keys(desc).length) return null;
  let pushed = 0;
  if (own.length) {
    const props: Record<string, Json> = {};
    for (const k of own) props[k] = clone(n[k] as Json);
    updateNode(doc, mainId, props);
    for (const k of own) delete n[k];
    pushed += own.length;
  }
  const stay: Record<string, Json> = {};
  const kept: string[] = [];
  // Outer paths first: a swapped nested instance takes its new component before the overrides below it land.
  const entries = Object.entries(desc).sort(([a], [b]) => a.split("/").length - b.split("/").length);
  for (const [k, v] of entries) {
    // A replacement node is not a property change of a layer the main has: it stays on the instance.
    if (!isObj(v) || (v as DocNode).type) { stay[k] = v; kept.push(k); continue; }
    const segs = k.split("/");
    let at: DocNode = main, i = 0;
    for (; i < segs.length && at.type !== "ref"; i++) {
      const next = (Array.isArray(at.children) ? (at.children as DocNode[]) : []).find((c) => c && c.id === segs[i]);
      if (!next) break;
      at = next;
    }
    if (at.type === "ref" && i < segs.length) {
      // Below a nested instance in the main: an override there, as the main's own.
      const rest = segs.slice(i).join("/");
      const d = isObj(at.descendants) ? clone(at.descendants as Record<string, Json>) : {};
      d[rest] = { ...(isObj(d[rest]) ? (d[rest] as Record<string, Json>) : {}), ...clone(v as Record<string, Json>) };
      // A swap brings the overrides it carried; the ones for the old component do not apply to the new one.
      if (isSwapEntry(v) && v.descendants === undefined) delete (d[rest] as Record<string, Json>).descendants;
      at.descendants = d as Json;
    } else if (i === segs.length) {
      if (isSwapEntry(v) && at.type === "ref") {
        // A swapped nested instance: the main's own nested instance becomes the new component.
        const props = clone(v as Record<string, Json>);
        updateNode(doc, String(at.id), props, v.descendants === undefined && at.descendants !== undefined ? ["descendants"] : []);
      } else updateNode(doc, String(at.id), clone(v as Record<string, Json>));
    } else { stay[k] = v; kept.push(k); continue; }
    pushed += Object.keys(v).length;
  }
  if (Object.keys(stay).length) n.descendants = stay as Json;
  else delete n.descendants;
  // A swap pushed into the main that would put the main inside itself draws forever: refuse it.
  try { expand(buildIndex(doc), main, []); } catch {
    throw new OverrideError(400, "invalid", `pushing these changes would put "${String(main.name ?? mainId)}" inside itself; an instance cannot contain itself`);
  }
  return pushed ? { main: mainId, pushed, kept } : null;
}

/** Push changes to main: one write, one undo step ("Push Changes to Main"). */
export function pushOverrides(docFile: string, id: string, expectedRevision: string | undefined, who: { source: "user" | "mcp"; session?: string }): { changed: boolean; pushed: number; kept: string[]; main?: string; revision?: string } {
  const probe = clone(currentDoc(docFile).doc);
  const dry = applyPush(probe, id);
  if (!dry) return { changed: false, pushed: 0, kept: [] };
  let ops: NodeOp[] = [];
  let result = dry;
  // recorded: the push changes layers inside the main too, which a diff of the touched nodes alone would miss.
  const { write } = editDoc(docFile, { expectedRevision, touches: [id, dry.main], deep: true, recorded: () => ops }, (d) => {
    const main = findNode(d, dry.main).node;
    const ids: string[] = [id];
    const gather = (x: DocNode) => { if (typeof x.id === "string") ids.push(x.id); for (const c of Array.isArray(x.children) ? (x.children as DocNode[]) : []) gather(c); };
    gather(main);
    const before = new Map(ids.map((i) => [i, propsOf(findNode(d, i).node)]));
    result = applyPush(d, id) ?? dry;
    ops = ids.map((i) => nodeDiff(i, before.get(i)!, propsOf(findNode(d, i).node))).filter((o) => Object.keys(o.props).length);
  });
  if (ops.length) record(docFile, ops, { label: "Push Changes to Main", source: who.source, session: who.session, mergeKey: `push:${Date.now()}:${Math.random()}`, edit: write.edit }, write.revision);
  return { changed: true, pushed: result.pushed, kept: result.kept, main: result.main, revision: write.revision };
}

export type OverrideDeps = {
  prime: (file: string) => Promise<void>;
  docFileOf: (file: string) => string;
  written: (docFile: string, revision: string | undefined, by: "mcp" | "inspector", id: string) => void;
};

const ROUTES = new Set(["/api/overrides/reset", "/api/overrides/swap", "/api/overrides/push"]);

/** POST /api/overrides/reset, /swap, /push (see the top of this file). */
export async function handleOverrideRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: OverrideDeps): Promise<boolean> {
  if (!ROUTES.has(url.pathname)) return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const raw = await readBodyText(req, 100_000);
    if (raw === null) return reply(413, { error: "too large", code: "invalid" }), true;
    const b = JSON.parse(raw || "{}") as { file?: string; id?: string; ids?: string[]; keys?: string[]; component?: string; expectedRevision?: string };
    const ids = (typeof b.id === "string" && b.id ? [b.id] : Array.isArray(b.ids) ? b.ids : []).filter((i): i is string => typeof i === "string" && !!i && !i.startsWith("widget:"));
    if (!b.file || !ids.length) return reply(400, { error: "file and id are required", code: "invalid" }), true;
    await deps.prime(b.file);
    const docFile = deps.docFileOf(b.file);
    const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
    const who = { source: by === "mcp" ? "mcp" as const : "user" as const, session: String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined };
    if (url.pathname === "/api/overrides/swap") {
      if (typeof b.component !== "string" || !b.component) return reply(400, { error: "component is required", code: "invalid" }), true;
      const r = swapInstances(docFile, [...new Set(ids)], b.component, b.expectedRevision, who);
      if (r.changed) deps.written(docFile, r.revision, by, ids[0]);
      return reply(200, { ok: true, ...r }), true;
    }
    if (url.pathname === "/api/overrides/push") {
      const r = pushOverrides(docFile, ids[0], b.expectedRevision, who);
      if (r.changed) deps.written(docFile, r.revision, by, ids[0]);
      return reply(200, { ok: true, ...r }), true;
    }
    const keys = Array.isArray(b.keys) ? b.keys.filter((k): k is string => typeof k === "string" && !!k) : undefined;
    const r = resetOverrides(docFile, ids[0], b.expectedRevision, who, keys);
    if (r.changed) deps.written(docFile, r.revision, by, ids[0]);
    return reply(200, { ok: true, ...r }), true;
  } catch (e) {
    if (e instanceof OverrideError) return reply(e.status, { error: e.message, code: e.code }), true;
    if (e instanceof StaleFileError) return reply(409, { error: (e as Error).message, code: "stale_revision" }), true;
    return reply(422, { error: (e as Error).message, code: "invalid" }), true;
  }
}
