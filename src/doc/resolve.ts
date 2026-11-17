// Turn the stored tree into what gets drawn: component instances expanded, variables replaced by values.
// Instance children get path ids ("instance/child", "instance/nested/child"), the paths every tool and the page use.

import { BoardIndex } from "./boardindex.ts";
import type { CanvasDoc } from "./docfile.ts";
import type { Json, DocNode } from "./schema.ts";

export type Theme = Record<string, string>;
export type Index = Map<string, DocNode>;

export function buildIndex(doc: CanvasDoc): Index {
  // A document with boards of an adopted version: their indexes answer, the rest is walked now (boardindex.ts).
  if (doc.children.length > 8) return new BoardIndex(doc);
  const index: Index = new Map();
  const visit = (n: DocNode) => {
    if (typeof n.id === "string") index.set(n.id, n);
    if (Array.isArray(n.children)) n.children.forEach(visit);
  };
  doc.children.forEach(visit);
  return index;
}

const REF_OWN = new Set(["id", "type", "ref", "descendants", "reusable"]);

// Overrides belong to the instance that wrote them. A replacement node stays in its author's scope, so its path skips
// the instance it landed in: a component that replaces Tab/Icon with node R addresses R's parts as "R/part", not "Tab/R/part".
type Scope = { prefix: string; overrides: Map<string, { node: DocNode; owner: Scope }> };

function expandIn(index: Index, node: DocNode, scope: Scope, depth: number, warnings?: string[]): DocNode {
  if (depth > 40) throw new Error(`components nest too deep at ${node.id}; check for a component that contains itself`);
  const id = String(node.id ?? "");
  const entry = scope.overrides.get(id);
  if (entry?.node.type) {
    const replacement = { ...entry.node, id: entry.node.id ?? id } as DocNode;
    if (entry.owner !== scope || replacement.id !== id) return expandIn(index, replacement, entry.owner, depth + 1, warnings);
  }
  const cur: DocNode = entry && !entry.node.type ? ({ ...node, ...entry.node, id } as DocNode) : node;
  // An override that swaps a nested instance (`ref` without a type): the instance's own overrides were for the old
  // component; the ones the swap carried come with it.
  if (cur !== node && typeof entry!.node.ref === "string" && entry!.node.ref !== node.ref && entry!.node.descendants === undefined) delete cur.descendants;
  const fullId = scope.prefix ? `${scope.prefix}/${id}` : id;

  if (cur.type === "ref") {
    const inner: Scope = { prefix: fullId, overrides: new Map() };
    for (const [k, v] of Object.entries((cur.descendants as Record<string, DocNode> | undefined) ?? {})) inner.overrides.set(k, { node: v, owner: scope });
    for (const [k, v] of scope.overrides) {
      if (!k.startsWith(`${id}/`)) continue;
      const key = k.slice(id.length + 1);
      const have = inner.overrides.get(key);
      if (have && !v.node.type) inner.overrides.set(key, { node: { ...have.node, ...v.node } as DocNode, owner: have.owner });
      else inner.overrides.set(key, v);
    }
    const target = index.get(String(cur.ref));
    if (!target) {
      warnings?.push(`instance ${fullId} points to a missing component "${cur.ref}"`);
      return { id: fullId, type: "frame", name: cur.name as string, width: 24, height: 24 } as DocNode;
    }
    const own: Record<string, Json> = {};
    for (const [k, v] of Object.entries(cur)) if (!REF_OWN.has(k) && v !== undefined) own[k] = v as Json;
    // A component can itself be an instance of another component.
    if (target.type === "ref") {
      const merged = { ...target, ...own, id, descendants: { ...((target.descendants as Record<string, Json>) ?? {}), ...((cur.descendants as Record<string, Json>) ?? {}) } } as DocNode;
      return expandIn(index, merged, { prefix: scope.prefix, overrides: new Map() }, depth + 1, warnings);
    }
    const children = (own.children as DocNode[] | undefined) ?? target.children;
    const result = { ...target, ...own, id: fullId } as DocNode;
    delete result.reusable;
    (result as Record<string, Json>).__ref = String(cur.ref);
    if (Array.isArray(children)) result.children = children.map((c) => expandIn(index, c, inner, depth + 1, warnings));
    return result;
  }

  const result: DocNode = { ...cur, id: fullId };
  if (Array.isArray(cur.children)) result.children = cur.children.map((c) => expandIn(index, c, scope, depth + 1, warnings));
  return result;
}

/** Expand one node and everything below it. Instance children get path ids. */
export function expand(index: Index, node: DocNode, warnings?: string[]): DocNode {
  return expandIn(index, node, { prefix: "", overrides: new Map() }, 0, warnings);
}

/** Default theme: the first value of every axis the document declares. */
export function defaultTheme(doc: CanvasDoc): Theme {
  const t: Theme = {};
  for (const [axis, values] of Object.entries(doc.themes ?? {})) if (Array.isArray(values) && values[0]) t[axis] = values[0];
  return t;
}

export function resolveVariable(doc: CanvasDoc, name: string, theme: Theme, seen = new Set<string>()): Json | undefined {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const def = (doc.variables as Record<string, { value: Json }> | undefined)?.[name];
  if (!def) return undefined;
  let value: Json | undefined = def.value;
  if (Array.isArray(value)) {
    // Themed values: the last entry that matches wins, an entry without a theme is the default.
    let picked: Json | undefined;
    for (const e of value as { value: Json; theme?: Theme }[]) {
      if (!e.theme || Object.entries(e.theme).every(([a, v]) => theme[a] === v)) picked = e.value;
    }
    value = picked ?? (value as { value: Json }[])[0]?.value;
  }
  if (typeof value === "string" && value.startsWith("$")) return resolveVariable(doc, value.slice(1), theme, seen);
  return value;
}

const NEVER_RESOLVE = new Set(["id", "type", "ref", "name", "context", "metadata", "geometry", "children", "descendants", "url", "href", "__ref"]);

/** A copy of one node's own properties with every $variable replaced. Children are left alone. */
export function resolveProps(doc: CanvasDoc, node: DocNode, theme: Theme, warnings?: string[]): DocNode {
  const walkValue = (v: Json, key: string): Json => {
    if (typeof v === "string" && v.startsWith("$") && v.length > 1) {
      const r = resolveVariable(doc, v.slice(1), theme);
      if (r === undefined) {
        // Text content can legitimately start with a dollar sign.
        if (key !== "content") warnings?.push(`${node.id}: unknown variable ${v}`);
        return key === "content" ? v : (null as Json);
      }
      return r;
    }
    if (Array.isArray(v)) return v.map((x) => walkValue(x, key));
    if (v && typeof v === "object") {
      const o: Record<string, Json> = {};
      for (const [k, x] of Object.entries(v)) o[k] = walkValue(x as Json, k);
      return o;
    }
    return v;
  };
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(node)) out[k] = NEVER_RESOLVE.has(k) ? (v as Json) : walkValue(v as Json, k);
  return out as DocNode;
}
