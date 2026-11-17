// Tree operations on a parsed document. All functions mutate `doc` in place and throw on bad input.

import { randomInt } from "node:crypto";
import { factsOf, IdSet } from "./boardindex.ts";
import type { CanvasDoc } from "./docfile.ts";
import { type Json, type DocNode, validateNode, ValidationError } from "./schema.ts";
import { follow, normalize, SPAN_KEYS, without, type Span } from "../page/text-spans.js";
import { followLists, normalizeLists, paragraphCount } from "../page/text-paras.js";

export const ROOT = "document";

export type Found = { node: DocNode; parent: DocNode | null; siblings: DocNode[]; index: number; ancestors: DocNode[] };

/** Walk the main tree (document children and nested children). Instance overrides under `descendants` are not separate nodes. */
export function walk(doc: CanvasDoc, fn: (n: DocNode, parent: DocNode | null, ancestors: DocNode[]) => void | false) {
  const visit = (list: DocNode[], parent: DocNode | null, ancestors: DocNode[]) => {
    for (const n of list) {
      if (!n || typeof n !== "object") continue;
      if (fn(n, parent, ancestors) === false) continue;
      if (Array.isArray(n.children)) visit(n.children, n, [...ancestors, n]);
    }
  };
  visit(doc.children, null, []);
}

/** Every id used anywhere in the document, including replacement nodes inside instance `descendants`. */
export function allIds(doc: CanvasDoc): Set<string> {
  const walkOne = (b: DocNode, ids: Set<string>) => {
    const visit = (v: Json | undefined) => {
      if (Array.isArray(v)) return v.forEach(visit);
      if (!v || typeof v !== "object") return;
      const o = v as Record<string, Json>;
      if (typeof o.id === "string" && typeof o.type === "string") ids.add(o.id);
      if (Array.isArray(o.children)) o.children.forEach(visit);
      if (o.descendants && typeof o.descendants === "object" && !Array.isArray(o.descendants)) Object.values(o.descendants).forEach(visit);
    };
    visit(b as unknown as Json);
  };
  // Boards of an adopted version answer from their index (boardindex.ts); the rest are walked now.
  return new IdSet(doc, walkOne);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** A new id: 5 random letters and digits, unique in `taken` (which is updated). */
export function newId(taken: Set<string>): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < 5; i++) id += ALPHABET[randomInt(ALPHABET.length)];
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

export function findNode(doc: CanvasDoc, id: string): Found {
  let hit: Found | null = null;
  const visit = (list: DocNode[], parent: DocNode | null, ancestors: DocNode[]) => {
    for (let i = 0; i < list.length && !hit; i++) {
      const n = list[i];
      if (n?.id === id) hit = { node: n, parent, siblings: list, index: i, ancestors };
      else if (Array.isArray(n?.children)) visit(n.children, n, [...ancestors, n]);
    }
  };
  // Top level: a board of an adopted version that does not hold the id is not walked (boardindex.ts).
  const top = doc.children;
  for (let i = 0; i < top.length && !hit; i++) {
    const n = top[i];
    if (n?.id === id) hit = { node: n, parent: null, siblings: top, index: i, ancestors: [] };
    else if (Array.isArray(n?.children)) {
      const f = factsOf(n);
      if (f && !f.index.has(id)) continue;
      visit(n.children, n, [n]);
    }
  }
  // Not found through the indexes: walk everything before saying so (a board changed in place, against the rule,
  // until verify() forgets it).
  if (!hit) visit(top, null, []);
  if (!hit) throw new Error(`no node with id "${id}"`);
  return hit;
}

function childList(doc: CanvasDoc, parentId: string | null | undefined): { list: DocNode[]; parent: DocNode | null } {
  if (!parentId || parentId === ROOT) return { list: doc.children, parent: null };
  const { node } = findNode(doc, parentId);
  if (node.type !== "frame" && node.type !== "group") {
    throw new ValidationError(`"${parentId}" is a ${node.type}; only frames and groups hold children${node.type === "ref" ? ' (change an instance\'s content through its "descendants")' : ""}`);
  }
  if (!Array.isArray(node.children)) node.children = [];
  return { list: node.children, parent: node };
}

function clampIndex(index: number | undefined, len: number) {
  if (index === undefined || index === null || index < 0 || index > len) return len;
  return Math.floor(index);
}

/** Give every node in the subtree an id: keep valid unused ones, replace missing or clashing ones. Returns created/kept ids. */
function assignIds(node: DocNode, taken: Set<string>, opts: { fresh: boolean }, out: string[]) {
  if (opts.fresh || typeof node.id !== "string" || !node.id || node.id.includes("/") || taken.has(node.id)) {
    if (!opts.fresh && typeof node.id === "string" && taken.has(node.id)) {
      throw new ValidationError(`id "${node.id}" is already used in this file; leave id out to get a fresh one`);
    }
    node.id = newId(taken);
  } else taken.add(node.id);
  out.push(node.id);
  if (Array.isArray(node.children)) for (const c of node.children) assignIds(c, taken, opts, out);
}

function checkRefs(doc: CanvasDoc, node: DocNode) {
  const targets = new Map<string, DocNode>();
  walk(doc, (n) => {
    if (typeof n.id === "string") targets.set(n.id, n);
  });
  const visit = (n: DocNode) => {
    if (n.type === "ref" && typeof n.ref === "string" && !n.ref.includes(":")) {
      const t = targets.get(n.ref);
      if (!t) throw new ValidationError(`instance ${n.id} points to "${n.ref}", which does not exist`);
      if (t.reusable !== true) throw new ValidationError(`instance ${n.id} points to "${n.ref}", which is not a reusable component`);
    }
    if (Array.isArray(n.children)) n.children.forEach(visit);
  };
  visit(node);
}

function assertValid(errs: string[]) {
  if (errs.length) throw new ValidationError(errs.slice(0, 15).join("\n") + (errs.length > 15 ? `\n…and ${errs.length - 15} more` : ""));
}

export function insertNode(doc: CanvasDoc, parentId: string | null | undefined, node: DocNode, index?: number): string[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new ValidationError("node must be one object");
  const copy = structuredClone(node);
  assertValid(validateNode(copy));
  const ids: string[] = [];
  assignIds(copy, allIds(doc), { fresh: false }, ids);
  const { list } = childList(doc, parentId);
  list.splice(clampIndex(index, list.length), 0, copy);
  try {
    checkRefs(doc, copy);
  } catch (e) {
    list.splice(list.indexOf(copy), 1);
    throw e;
  }
  return ids;
}

export function updateNode(doc: CanvasDoc, id: string, props: Record<string, Json>, remove: string[] = []): DocNode {
  const { node } = findNode(doc, id);
  for (const k of ["id", "type"]) if (k in props && props[k] !== node[k]) throw new ValidationError(`cannot change "${k}"; delete and insert instead`);
  if ("children" in props) throw new ValidationError(`use insert_node / move_node / delete_node to change children`);
  // New content under styled ranges: the ranges follow the edit (typed text takes the style before it), unless the
  // same write sets them (src/page/text-spans.js).
  if (typeof props.content === "string" && !("spans" in props) && Array.isArray(node.spans) && !remove.includes("spans")) {
    const before = typeof node.content === "string" ? node.content : "";
    const spans = follow(node.spans as Span[], before, props.content);
    props = { ...props, spans: spans as unknown as Json };
    if (!spans.length) { props = { ...props }; delete props.spans; remove = [...remove, "spans"]; }
  }
  // Lists follow new content the same way (a paragraph split by a typed newline continues its list), unless the
  // write sets them (src/page/text-paras.js).
  if (typeof props.content === "string" && !("lists" in props) && Array.isArray(node.lists) && !remove.includes("lists")) {
    const lists = followLists(node.lists, typeof node.content === "string" ? node.content : "", props.content);
    if (lists.length) props = { ...props, lists: lists as unknown as Json };
    else { props = { ...props }; delete props.lists; remove = [...remove, "lists"]; }
  }
  if (Array.isArray(props.lists)) {
    const content = typeof props.content === "string" ? props.content : typeof node.content === "string" ? node.content : "";
    assertValid(validateNode({ type: "text", content, lists: props.lists }, { keys: ["lists"] }));
    const lists = normalizeLists(props.lists, paragraphCount(content));
    if (lists.length) props = { ...props, lists: lists as unknown as Json };
    else { props = { ...props }; delete props.lists; remove = [...remove, "lists"]; }
  }
  // A style set on the whole layer wins over its ranges: the ranges stop setting those keys.
  const whole = SPAN_KEYS.filter((k) => k in props || remove.includes(k));
  if (whole.length && !("spans" in props) && Array.isArray(node.spans)) {
    const len = typeof props.content === "string" ? props.content.length : typeof node.content === "string" ? node.content.length : undefined;
    const spans = without(node.spans as Span[], whole, len);
    if (spans.length) props = { ...props, spans: spans as unknown as Json };
    else if (!remove.includes("spans")) remove = [...remove, "spans"];
  }
  if (Array.isArray(props.spans)) {
    const len = typeof props.content === "string" ? props.content.length : typeof node.content === "string" ? node.content.length : undefined;
    const errs = (validateNode({ type: "text", content: "x".repeat(len ?? 0), spans: props.spans }, { keys: ["spans"] }));
    assertValid(errs);
    const spans = normalize(props.spans, len);
    if (spans.length) props = { ...props, spans: spans as unknown as Json };
    else { props = { ...props }; delete props.spans; remove = [...remove, "spans"]; }
  }
  const trial: DocNode = { ...node, ...structuredClone(props) };
  for (const k of remove) {
    if (k === "id" || k === "type" || k === "children") throw new ValidationError(`cannot remove "${k}"`);
    delete trial[k];
  }
  assertValid(validateNode(trial, { keys: Object.keys(props) }));
  if (trial.type === "ref" && "ref" in props) checkRefs(doc, trial);
  for (const k of remove) delete node[k];
  Object.assign(node, structuredClone(props));
  return node;
}

export function deleteNode(doc: CanvasDoc, id: string, force = false): number {
  const f = findNode(doc, id);
  const removedIds = new Set<string>();
  const gather = (n: DocNode) => {
    if (typeof n.id === "string") removedIds.add(n.id);
    n.children?.forEach(gather);
  };
  gather(f.node);
  if (!force) {
    // Instances also live inside other instances' overrides, and an override can swap the component with a bare ref.
    const users: string[] = [];
    const look = (n: DocNode, label: string, gone: boolean) => {
      const out = gone || removedIds.has(String(n.id));
      if (typeof n.ref === "string" && removedIds.has(n.ref) && !out) users.push(label);
      n.children?.forEach((c) => look(c, String(c.id), out));
      for (const [key, d] of Object.entries((n.descendants as Record<string, DocNode>) ?? {})) {
        if (d && typeof d === "object") look(d, `${label}/${key}`, out);
      }
    };
    doc.children.forEach((c) => look(c, String(c.id), false));
    if (users.length) {
      throw new ValidationError(`"${id}" contains a component used by ${users.length} instance(s) elsewhere (${users.slice(0, 8).join(", ")}). Change the component in place, or remove those instances first.`);
    }
  }
  f.siblings.splice(f.index, 1);
  return removedIds.size;
}

export function moveNode(doc: CanvasDoc, id: string, newParentId: string | null | undefined, index?: number) {
  const f = findNode(doc, id);
  if (newParentId && newParentId !== ROOT) {
    if (newParentId === id) throw new ValidationError("cannot move a node into itself");
    const target = findNode(doc, newParentId);
    if (target.ancestors.some((a) => a.id === id)) throw new ValidationError("cannot move a node into its own child");
  }
  const { list } = childList(doc, newParentId);
  f.siblings.splice(f.index, 1);
  list.splice(clampIndex(index, list.length), 0, f.node);
}

export function duplicateNode(doc: CanvasDoc, id: string, overrides: Record<string, Json> = {}, parentId?: string | null): { id: string; ids: string[] } {
  const f = findNode(doc, id);
  const copy = structuredClone(f.node);
  const ids: string[] = [];
  assignIds(copy, allIds(doc), { fresh: true }, ids);
  for (const k of ["id", "type", "children"]) if (k in overrides) throw new ValidationError(`cannot override "${k}" when duplicating`);
  Object.assign(copy, structuredClone(overrides));
  assertValid(validateNode(copy, { keys: Object.keys(overrides) }));
  if (parentId === undefined) f.siblings.splice(f.index + 1, 0, copy);
  else childList(doc, parentId).list.push(copy);
  return { id: copy.id as string, ids };
}

// ---------- read helpers ----------

const short = (s: unknown, n = 40) => {
  const t = String(s ?? "").replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function describe(n: DocNode, names?: Map<string, string>): string {
  const parts = [`${n.id}`, `${n.type}`];
  if (n.name) parts.push(`"${short(n.name)}"`);
  if (n.reusable === true) parts.push("[component]");
  if (n.type === "ref") parts.push(`→ ${n.ref}${names?.get(String(n.ref)) ? ` "${short(names.get(String(n.ref)), 30)}"` : ""}`);
  if (n.type === "text" && typeof n.content === "string") parts.push(`'${short(n.content, 50)}'`);
  if (n.width !== undefined || n.height !== undefined) parts.push(`${n.width ?? "?"}×${n.height ?? "?"}`);
  if (n.x !== undefined || n.y !== undefined) parts.push(`@${n.x ?? 0},${n.y ?? 0}`);
  if (n.layout && n.layout !== "none") parts.push(`layout:${n.layout}`);
  if (n.enabled === false) parts.push("(hidden)");
  return parts.join(" ");
}

export function outline(doc: CanvasDoc, rootId: string | null | undefined, depth = 2, maxLines = 400): string {
  const names = new Map<string, string>();
  walk(doc, (n) => {
    if (n.reusable === true && typeof n.id === "string") names.set(n.id, String(n.name ?? ""));
  });
  const lines: string[] = [];
  let truncated = false;
  const visit = (list: DocNode[], level: number) => {
    for (const n of list) {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      const kids = Array.isArray(n.children) ? n.children.length : 0;
      lines.push(`${"  ".repeat(level)}${describe(n, names)}${kids && level + 1 >= depth ? ` (+${kids} children)` : ""}`);
      if (kids && level + 1 < depth) visit(n.children as DocNode[], level + 1);
    }
  };
  if (!rootId || rootId === ROOT) visit(doc.children, 0);
  else {
    const { node } = findNode(doc, rootId);
    visit([node], 0);
  }
  if (truncated) lines.push(`… stopped at ${maxLines} lines; pass a nodeId or a smaller depth`);
  return lines.join("\n");
}

/** A copy of the node with children cut off below `depth` levels. */
export function trimmed(n: DocNode, depth: number): DocNode {
  const c: DocNode = { ...n };
  if (Array.isArray(n.children)) {
    if (depth <= 0) (c as Record<string, Json>).children = `${n.children.length} children (raise depth to see them)` as unknown as Json;
    else c.children = n.children.map((k) => trimmed(k, depth - 1));
  }
  return c;
}

export function findNodes(doc: CanvasDoc, q: { name?: string; type?: string; text?: string; reusable?: boolean; within?: string }, limit = 50) {
  const name = q.name?.toLowerCase();
  const text = q.text?.toLowerCase();
  const out: { id: string; type: string; name?: string; text?: string; path: string }[] = [];
  let total = 0;
  const scope: CanvasDoc = q.within && q.within !== ROOT ? { ...doc, children: [findNode(doc, q.within).node] } : doc;
  walk(scope, (n, _p, anc) => {
    if (q.type && n.type !== q.type) return;
    if (name && !String(n.name ?? "").toLowerCase().includes(name)) return;
    if (text && !(typeof n.content === "string" && n.content.toLowerCase().includes(text))) return;
    if (q.reusable !== undefined && (n.reusable === true) !== q.reusable) return;
    total++;
    if (out.length < limit) {
      out.push({
        id: String(n.id),
        type: String(n.type),
        ...(n.name ? { name: String(n.name) } : {}),
        ...(typeof n.content === "string" ? { text: short(n.content, 80) } : {}),
        path: anc.map((a) => short(a.name ?? a.id, 24)).join(" / "),
      });
    }
  });
  return { total, results: out };
}
