// Repeat the last edit on a new selection (Edit > Repeat, the "." key). Every property edit the server writes
// for someone (the inspector, the page's handles and keys, an agent's set_node_props) leaves a note here, per
// document; Repeat applies it to the layers selected now, in one write and one undo step.
//
// Absolute or relative: a value set outright (a fill picked, a radius dragged, "24" typed) repeats as that value.
// A change made from the layer's own value ("+10" typed in a field, Up on a Mixed field, an arrow-key nudge)
// repeats as the same change, from each layer's own value. The writer says which with `rel` ({key: {op, by}}, in
// the file's units); the toast says which happened.
//
// The note is in memory only, like undo history. A repeat does not replace it: pressing Repeat again on the next
// selection does the same thing again.

import { NODE_KEYS, type Json } from "./engine.ts";
import { nodeLabel } from "./history.ts";

/** A relative change of one numeric property: add `by`, or multiply by it. */
export type Rel = { op: "+" | "*"; by: number };
export type RepeatEdit = {
  kind: "props" | "move";
  /** Values set outright. */
  props: Record<string, Json>;
  remove: string[];
  /** Values changed from each layer's own. */
  rel: Record<string, Rel>;
  /** A nudge: moved by dx, dy from where each layer is. */
  move?: { dx: number; dy: number };
  /** What the Edit menu and the toast call it: "Fill Change", "Width +10", "Nudge". */
  label: string;
  at: number;
  /** A nudge burst's key: the presses of one burst add up. */
  burst?: string;
};

/** Keys that never repeat: a layer's identity, its text and its name are its own. */
const SKIP = new Set(["id", "type", "children", "name", "content", "metadata", "ref", "reusable", "descendants", "context", "slot", "placeholder"]);
/** How a key reads in a relative label. */
const NAMES: Record<string, string> = {
  x: "X", y: "Y", width: "Width", height: "Height", rotation: "Rotation", opacity: "Opacity", cornerRadius: "Corner Radius",
  fontSize: "Font Size", lineHeight: "Line Height", letterSpacing: "Letter Spacing", gap: "Gap", strokeWidth: "Stroke Width",
  strokeThickness: "Stroke Width", fontWeight: "Font Weight",
};
/** The value a layer has for a key it does not hold, where the file's default is plain. */
const DEFAULTS: Record<string, number> = { x: 0, y: 0, rotation: 0, opacity: 1, cornerRadius: 0, gap: 0, letterSpacing: 0 };
/** Where a relative result stops. */
const LIMITS: Record<string, [number, number]> = {
  opacity: [0, 1], width: [0.01, Infinity], height: [0.01, Infinity], cornerRadius: [0, Infinity], fontSize: [1, Infinity],
  strokeWidth: [0, Infinity], strokeThickness: [0, Infinity], fontWeight: [1, 1000], lineHeight: [0, Infinity],
};

const r2 = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};
const human = (k: string) => NAMES[k] ?? k.replace(/^./, (c) => c.toUpperCase()).replace(/([a-z])([A-Z])/g, "$1 $2");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A writer's `rel` hint, checked: "+" and "*" with a finite number ("-" and "/" are folded in by the writer). */
export function cleanRel(rel: unknown): Record<string, Rel> {
  const out: Record<string, Rel> = {};
  if (!rel || typeof rel !== "object" || Array.isArray(rel)) return out;
  for (const [k, v] of Object.entries(rel as Record<string, unknown>)) {
    if (SKIP.has(k) || !v || typeof v !== "object") continue;
    const op = (v as { op?: unknown }).op, by = Number((v as { by?: unknown }).by);
    if (!Number.isFinite(by)) continue;
    if (op === "+" || op === "-") out[k] = { op: "+", by: op === "-" ? -by : by };
    else if (op === "*") out[k] = { op: "*", by };
    else if (op === "/" && by !== 0) out[k] = { op: "*", by: 1 / by };
  }
  return out;
}

/** "+10", "-4", "x2" for a relative change; opacity reads in percent like its field. */
export function relText(k: string, r: Rel): string {
  if (r.op === "*") return "×" + r2(r.by);
  const by = k === "opacity" ? r2(r.by * 100) : r2(r.by);
  return (by < 0 ? "−" + Math.abs(by) : "+" + by) + (k === "opacity" ? "%" : "");
}

/**
 * The note an /api/update leaves, or null when nothing in it repeats. `each` (a value per layer, a Mixed field)
 * repeats a key when `rel` says how it changed, or when every layer got the same value.
 */
export function fromUpdate(b: { props?: Record<string, Json>; remove?: string[]; each?: Record<string, Record<string, Json>>; rel?: unknown }, at = Date.now()): RepeatEdit | null {
  const rel = cleanRel(b.rel);
  const props: Record<string, Json> = {};
  for (const [k, v] of Object.entries(b.props ?? {})) if (!SKIP.has(k) && !(k in rel) && v !== undefined) props[k] = v;
  if (b.each && typeof b.each === "object") {
    const per = Object.values(b.each).filter((p) => p && typeof p === "object");
    const keys = new Set(per.flatMap((p) => Object.keys(p)));
    for (const k of keys) {
      if (SKIP.has(k) || k in rel || k in props) continue;
      const vals = per.map((p) => p[k]);
      if (vals.every((v) => v !== undefined && same(v, vals[0]))) props[k] = vals[0];
    }
  }
  // A relative key the write did not carry at all is not part of this edit.
  const carried = new Set([...Object.keys(b.props ?? {}), ...Object.values(b.each ?? {}).flatMap((p) => Object.keys(p ?? {}))]);
  for (const k of Object.keys(rel)) if (!carried.has(k)) delete rel[k];
  const remove = (Array.isArray(b.remove) ? b.remove : []).filter((k) => typeof k === "string" && !SKIP.has(k) && !(k in props) && !(k in rel));
  const keys = [...Object.keys(props), ...remove, ...Object.keys(rel)];
  if (!keys.length) return null;
  const relKeys = Object.keys(rel);
  const label = relKeys.length === 1 && keys.length === 1 ? `${human(relKeys[0])} ${relText(relKeys[0], rel[relKeys[0]])}` : nodeLabel([...new Set(keys)].sort());
  return { kind: "props", props, remove, rel, label, at };
}

/** A nudge burst goes on adding up while its presses keep coming (the page sends them a write at a time). */
export const BURST_MS = 1500;
/** Arrow-key nudges repeat (by the same distance); drags and aligns do not (they are not an edit to repeat). */
export function isNudge(merge: unknown): merge is string {
  return merge === "nudge" || (typeof merge === "string" && merge.startsWith("group:nudge-"));
}
/** The note an /api/move nudge leaves: the burst's total so far. */
export function fromNudge(prev: RepeatEdit | null, b: { id?: string; dx?: unknown; dy?: unknown; items?: { id?: string; dx?: unknown; dy?: unknown }[]; merge?: unknown }, at = Date.now()): RepeatEdit | null {
  if (!isNudge(b.merge)) return null;
  const first = Array.isArray(b.items) ? b.items[0] : b;
  const dx = Number(first?.dx ?? 0), dy = Number(first?.dy ?? 0);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return null;
  const ids = Array.isArray(b.items) ? b.items.map((i) => i?.id).join(",") : String(b.id ?? "");
  const burst = `${b.merge}:${ids}`;
  const go = prev && prev.kind === "move" && prev.burst === burst && at - prev.at < BURST_MS && prev.move ? prev.move : { dx: 0, dy: 0 };
  const move = { dx: r2(go.dx + dx), dy: r2(go.dy + dy) };
  if (!move.dx && !move.dy) return null;
  return { kind: "move", props: {}, remove: [], rel: {}, move, label: "Nudge", at, burst };
}

/** Whether a layer of this type can hold the key (a rectangle has no padding); unknown types and instances take any. */
const takes = (n: Record<string, unknown>, k: string) => {
  const keys = typeof n.type === "string" ? NODE_KEYS[n.type] : undefined;
  return !keys || !keys.size || keys.has(k);
};

/**
 * What a repeat writes on each layer: `nodes` maps the selected ids to their stored properties (null: gone).
 * Relative keys go from each layer's own number (a key it does not hold counts from the file's default; a layer
 * whose value is not a number, Hug or a token, keeps its own). Keys a layer's type cannot hold are left out for
 * it; layers it would not change are left out.
 */
export function planRepeat(e: RepeatEdit, nodes: Map<string, Record<string, unknown> | null>): { each: Record<string, Record<string, Json>>; remove: string[]; skipped: string[]; same: string[] } {
  const each: Record<string, Record<string, Json>> = {};
  const skipped: string[] = [], unchanged: string[] = [];
  for (const [id, n] of nodes) {
    if (!n) { skipped.push(id); continue; }
    const p: Record<string, Json> = {};
    let missed = false;
    for (const [k, v] of Object.entries(e.props)) {
      if (!takes(n, k)) { missed = true; continue; }
      if (!same(n[k], v)) p[k] = v;
    }
    for (const [k, r] of Object.entries(e.rel)) {
      if (!takes(n, k)) { missed = true; continue; }
      const cur = typeof n[k] === "number" ? (n[k] as number) : n[k] === undefined && k in DEFAULTS ? DEFAULTS[k] : null;
      if (cur === null || !Number.isFinite(cur)) { missed = true; continue; }
      let v = r.op === "+" ? cur + r.by : cur * r.by;
      const lim = LIMITS[k];
      if (lim) v = Math.min(lim[1], Math.max(lim[0], v));
      if (k === "rotation") v = ((((v + 180) % 360) + 360) % 360) - 180;
      v = r2(v);
      if (v !== cur) p[k] = v;
    }
    const removes = e.remove.filter((k) => n[k] !== undefined);
    if (Object.keys(p).length || removes.length) each[id] = p;
    else if (missed) skipped.push(id);
    else unchanged.push(id);
  }
  return { each, remove: e.remove.slice(), skipped, same: unchanged };
}

/** The toast after a repeat: what, on how many, and whether it was the same value or the same change. */
export function repeatToast(e: RepeatEdit, changed: number, skipped = 0): string {
  const what = e.kind === "move" && e.move ? `Nudge (${r2(e.move.dx)}, ${r2(e.move.dy)})` : e.label;
  if (!changed) return skipped ? `Could not repeat ${what} on this selection` : `The selection already has ${what}`;
  const n = changed === 1 ? "1 layer" : `${changed} layers`;
  const how = e.kind === "move" ? "from each one's own position" : Object.keys(e.rel).length ? (Object.keys(e.props).length || e.remove.length ? "same values, and changes from each one's own" : "from each one's own value") : "same value";
  return `Repeated ${what} on ${n}, ${how}` + (skipped ? `; ${skipped} skipped` : "");
}

// ---------- per document ----------
const notes = new Map<string, RepeatEdit>();
const listeners = new Set<(docFile: string) => void>();
/** Hear when a document's repeatable edit changes (the Edit menu's "Repeat ..." title rides on the history event). */
export function onRepeat(f: (docFile: string) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
export const lastEdit = (docFile: string): RepeatEdit | null => notes.get(docFile) ?? null;
export function noteEdit(docFile: string, e: RepeatEdit | null): void {
  if (!e) return;
  const was = notes.get(docFile);
  notes.set(docFile, e);
  if (was?.label === e.label) return; // the menu title is the same; nothing to tell
  for (const f of listeners) {
    try { f(docFile); } catch (err) { console.error(`[canvas] repeat listener: ${err}`); }
  }
}
export const resetRepeat = (docFile?: string) => (docFile ? notes.delete(docFile) : notes.clear());
/** What the Edit menu shows: {label} or null. */
export const repeatInfo = (docFile: string): { label: string; kind: string } | null => {
  const e = notes.get(docFile);
  return e ? { label: e.label, kind: Object.keys(e.rel).length || e.kind === "move" ? "relative" : "absolute" } : null;
};
