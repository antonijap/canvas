// The colours a document uses, for the native colour picker: every colour literal and every colour
// variable reference counted across the stored tree (fills, strokes, gradient stops, shadows, instance
// overrides), most used first, plus the solid background behind a node so the picker can rate text
// colours for contrast. Pure over a parsed document; cached per document object, so one revision pays once.

import type { CanvasDoc, DocNode } from "./engine.ts";
import { usageIndex } from "./usage.ts";

/** One colour the document uses. `variable` is set when the uses go through a colour variable. */
export type DocColor = { hex: string; count: number; variable?: string };
export type ColorStats = { colors: DocColor[]; total: number };

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** "#abc" -> "#AABBCC", "#AABBCCFF" -> "#AABBCC" (opaque alpha dropped). Null for anything that is not hex. */
export function normalizeHex(s: string): string | null {
  if (!HEX_RE.test(s)) return null;
  let h = s.slice(1).toUpperCase();
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  if (h.length === 8 && h.endsWith("FF")) h = h.slice(0, 6);
  return `#${h}`;
}

/** A colour variable's first value (the first theme's, for a themed variable), as normalized hex. */
function varHex(doc: CanvasDoc, name: string, seen = new Set<string>()): string | null {
  const def = (doc.variables as Record<string, unknown> | undefined)?.[name];
  if (!def || typeof def !== "object" || (def as { type?: unknown }).type !== "color") return null;
  let v = (def as { value?: unknown }).value;
  if (Array.isArray(v)) v = (v[0] as { value?: unknown } | undefined)?.value;
  if (typeof v !== "string") return null;
  if (v.startsWith("$") && !seen.has(name)) return varHex(doc, v.slice(1), seen.add(name));
  return normalizeHex(v);
}

const SKIP = new Set(["children", "content", "id", "name", "ref", "geometry", "icon", "fontFamily"]);

function collect(v: unknown, into: Set<string>): void {
  if (typeof v === "string") {
    if (v.charCodeAt(0) === 35 && HEX_RE.test(v)) into.add(normalizeHex(v)!);
    else if (v.length > 1 && v.charCodeAt(0) === 36) into.add(v);
  } else if (Array.isArray(v)) {
    for (const x of v) collect(x, into);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) collect(x, into);
  }
}

const cache = new WeakMap<object, ColorStats>();

/** Every colour in the document, most used first. A node counts once per distinct colour it holds. */
export function colorStats(doc: CanvasDoc): ColorStats {
  const hit = cache.get(doc);
  if (hit) return hit;
  const counts = new Map<string, DocColor>();
  let total = 0;
  const visit = (n: DocNode) => {
    const found = new Set<string>();
    for (const [k, v] of Object.entries(n)) if (!SKIP.has(k)) collect(v, found);
    for (const c of found) {
      let entry: DocColor;
      if (c.startsWith("$")) {
        const name = c.slice(1);
        const hex = varHex(doc, name);
        if (!hex) continue; // not a colour variable (a number, a font)
        entry = counts.get(c) ?? { hex, count: 0, variable: name };
      } else {
        entry = counts.get(c) ?? { hex: c, count: 0 };
      }
      entry.count++;
      total++;
      counts.set(c, entry);
    }
    for (const ch of (n.children as DocNode[] | undefined) ?? []) visit(ch);
  };
  for (const top of doc.children) visit(top);
  const colors = [...counts.values()].sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex) || (a.variable ?? "").localeCompare(b.variable ?? ""));
  const out = { colors, total };
  cache.set(doc, out);
  return out;
}

/** A fill value's solid colour: a hex string, a $variable, a colour fill object, or the topmost solid of an array. */
export function solidOf(doc: CanvasDoc, fill: unknown): string | null {
  if (typeof fill === "string") return fill.startsWith("$") ? varHex(doc, fill.slice(1)) : normalizeHex(fill);
  if (Array.isArray(fill)) {
    for (let i = fill.length - 1; i >= 0; i--) {
      const s = solidOf(doc, fill[i]);
      if (s) return s;
    }
    return null;
  }
  if (fill && typeof fill === "object") {
    const f = fill as { type?: unknown; color?: unknown; enabled?: unknown };
    if (f.enabled === false || f.type !== "color" || typeof f.color !== "string") return null;
    return solidOf(doc, f.color);
  }
  return null;
}

/** The solid colour behind a node: the nearest ancestor with a solid fill. Null when none (the canvas shows through). */
export function backgroundOf(doc: CanvasDoc, id: string): string | null {
  const ix = usageIndex(doc);
  let cur = ix.nodes.get(id.split("/").pop() ?? id)?.parent ?? null;
  while (cur) {
    const e = ix.nodes.get(cur);
    if (!e) break;
    const s = solidOf(doc, e.node.fill);
    if (s) return s;
    cur = e.parent;
  }
  return null;
}

/** /api/colors?file=…[&id=node]: the document's colours, most used first, and the background behind `id`. */
export function handleColorsRoute(url: URL, doc: CanvasDoc, revision: string, reply: (v: unknown, status?: number) => void): boolean {
  if (url.pathname !== "/api/colors") return false;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 32, 1), 200);
  const s = colorStats(doc);
  const id = url.searchParams.get("id");
  reply({ revision, total: s.total, colors: s.colors.slice(0, limit), ...(id ? { background: backgroundOf(doc, id) } : {}) });
  return true;
}
