// Selection colours ("Selection colors"): with several layers selected, or a frame or group, every colour
// their fills, strokes and shadows use (descendants included), each listed once, variables first; editing one
// changes it everywhere in the selection, in one write and one undo step.
//
// GET  /api/selection-colors?file=...&ids=a,b     -> {colors: [{color, count}]}  ("#RRGGBB", "#RRGGBBAA" or "$variable")
// POST /api/selection-colors {file, ids, from, to, gesture?}  -> /api/update's `each` for the layers that use `from`
//
// Pure: the server reads the nodes and writes through updateMany. Instances count with their own overrides; the
// layers inside them are their component's.

import type { Json, DocNode } from "./engine.ts";

export type SelectionColor = { color: string; count: number };

const HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** "#abc" -> "#AABBCC", "#AABBCCFF" -> "#AABBCC"; a $variable stays as it is; anything else null. */
export function normColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (v.startsWith("$") && v.length > 1) return v;
  if (!HEX.test(v)) return null;
  let h = v.slice(1).toUpperCase();
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  if (h.length === 8 && h.endsWith("FF")) h = h.slice(0, 6);
  return "#" + h;
}

/** Every colour a paint value holds (a string, a colour fill, gradient stops), in order. */
function paintColors(v: unknown, out: string[]) {
  for (const f of Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]) {
    if (typeof f === "string") { const c = normColor(f); if (c) out.push(c); continue; }
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    if (o.type === "color" || (o.type === undefined && o.color !== undefined)) { const c = normColor(o.color); if (c) out.push(c); }
    if (o.type === "gradient" && Array.isArray(o.colors)) for (const s of o.colors) { const c = normColor((s as Record<string, unknown>)?.color); if (c) out.push(c); }
  }
}

function effectColors(v: unknown, out: string[]) {
  for (const e of Array.isArray(v) ? v : v ? [v] : []) {
    if (e && typeof e === "object" && (e as Record<string, unknown>).type === "shadow") { const c = normColor((e as Record<string, unknown>).color); if (c) out.push(c); }
  }
}

/** The colours one node's own properties use. */
export function nodeColors(n: DocNode): string[] {
  const out: string[] = [];
  paintColors(n.fill, out);
  paintColors(n.stroke, out);
  effectColors(n.effect, out);
  return out;
}

/** The nodes and every layer inside them (not inside instances), each once. */
export function walk(nodes: DocNode[]): DocNode[] {
  const seen = new Set<string>();
  const out: DocNode[] = [];
  const visit = (n: DocNode) => {
    if (!n || typeof n !== "object" || (n.id && seen.has(n.id))) return;
    if (n.id) seen.add(n.id);
    out.push(n);
    if (n.type !== "ref" && Array.isArray(n.children)) for (const c of n.children) visit(c);
  };
  nodes.forEach(visit);
  return out;
}

/** Each colour once with how many times it is used: variables first, then the most used. */
export function selectionColors(nodes: DocNode[]): SelectionColor[] {
  const count = new Map<string, number>();
  for (const n of walk(nodes)) for (const c of nodeColors(n)) count.set(c, (count.get(c) ?? 0) + 1);
  const list = [...count].map(([color, count], i) => ({ color, count, i }));
  list.sort((a, b) => Number(b.color.startsWith("$")) - Number(a.color.startsWith("$")) || b.count - a.count || a.i - b.i);
  return list.map(({ color, count }) => ({ color, count }));
}

/** `to` in place of every use of `from` in one paint value; the same value when nothing matched. */
function swapPaint(v: Json | undefined, from: string, to: string): Json | undefined {
  if (v === undefined || v === null) return v;
  const one = (f: Json): Json => {
    if (typeof f === "string") return normColor(f) === from ? to : f;
    if (!f || typeof f !== "object" || Array.isArray(f)) return f;
    const o = f as Record<string, Json>;
    if ((o.type === "color" || o.type === undefined) && normColor(o.color) === from) return { ...o, color: to };
    if (o.type === "gradient" && Array.isArray(o.colors)) {
      let hit = false;
      const colors = o.colors.map((s) => {
        if (s && typeof s === "object" && !Array.isArray(s) && normColor((s as Record<string, Json>).color) === from) { hit = true; return { ...(s as Record<string, Json>), color: to }; }
        return s;
      });
      return hit ? { ...o, colors } : f;
    }
    return f;
  };
  return Array.isArray(v) ? v.map(one) : one(v);
}

function swapEffect(v: Json | undefined, from: string, to: string): Json | undefined {
  if (v === undefined || v === null) return v;
  const one = (e: Json): Json => {
    if (e && typeof e === "object" && !Array.isArray(e) && (e as Record<string, Json>).type === "shadow" && normColor((e as Record<string, Json>).color) === from) return { ...(e as Record<string, Json>), color: to };
    return e;
  };
  return Array.isArray(v) ? v.map(one) : one(v);
}

/** The props one node needs for `from` to become `to` (only the keys that change), or null. */
export function replaceInNode(n: DocNode, from: string, to: string): Record<string, Json> | null {
  const f = normColor(from), t = normColor(to);
  if (!f || !t) return null;
  const out: Record<string, Json> = {};
  for (const [k, swap] of [["fill", swapPaint], ["stroke", swapPaint], ["effect", swapEffect]] as const) {
    const v = n[k] as Json | undefined;
    const next = swap(v, f, t);
    if (JSON.stringify(next) !== JSON.stringify(v)) out[k] = next as Json;
  }
  return Object.keys(out).length ? out : null;
}

/** /api/update's `each` for the selection: every layer (descendants included) that uses `from`. */
export function replaceEach(nodes: DocNode[], from: string, to: string): Record<string, Record<string, Json>> {
  const each: Record<string, Record<string, Json>> = {};
  for (const n of walk(nodes)) {
    if (!n.id) continue;
    const p = replaceInNode(n, from, to);
    if (p) each[n.id] = p;
  }
  return each;
}
