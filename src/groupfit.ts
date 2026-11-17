// A group's bounds are the union of its layers. The engine sizes a group from its own origin (layout.rs
// none_children: extents from 0,0), so a layer moved left of or above that origin would draw outside the group's
// box. After any write that changes a group's layers (a move, a resize, a flip, a layer taken out), refit: the group
// moves to its layers' top-left corner and the layers shift back by the same amount, so nothing moves on screen.
// A stored width/height (files may carry one) follows the layers' extent.
//
// Pure functions on a document; the callers record the ops (move.ts, resize.ts, autolayout.ts placeNodes,
// structure.ts deleteNodes).

import { findNode, type Json, type DocNode } from "./engine.ts";
import { boardLacks } from "./doc/boardindex.ts";

type Doc = { children: DocNode[] };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const r2 = (v: number) => Math.round(v * 100) / 100;
const EPS = 1e-6;

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** "fit_content(40)" / "fill_container(40)": the fallback number; undefined when there is none. */
const fallbackOf = (v: unknown) => { const m = /\(\s*(-?[\d.]+)\s*\)$/.exec(str(v)); return m ? Number(m[1]) : undefined; };
/** Padding as [top, right, bottom, left] (a number, [v, h], [t, h, b] or [t, r, b, l]). */
function padOf(p: unknown): [number, number, number, number] {
  if (typeof p === "number" && Number.isFinite(p)) return [p, p, p, p];
  if (Array.isArray(p)) {
    const n = p.map((v) => num(v) ?? 0);
    if (n.length === 1) return [n[0], n[0], n[0], n[0]];
    if (n.length === 2) return [n[0], n[1], n[0], n[1]];
    if (n.length === 3) return [n[0], n[1], n[2], n[1]];
    if (n.length >= 4) return [n[0], n[1], n[2], n[3]];
  }
  return [0, 0, 0, 0];
}

/**
 * Resolves layers' sizes the way the engine lays them out (engine/src/layout.rs), for the cases the file decides
 * without measuring text: numbers, hug and fill frames (their flow or their layers' extent, padding and gap), groups,
 * component instances (the main's size unless the instance sets its own), icons (24) and plain shapes (0). A text
 * box that sizes itself, a $variable or anything else that needs measuring is undefined on that axis.
 */
class Sizer {
  private mains: Map<string, DocNode> | null = null;
  private memo = new Map<DocNode, { w?: number; h?: number }>();
  private doc: Doc;
  constructor(doc: Doc) { this.doc = doc; }
  /** Forget measured sizes (a refit changed layers' places, and with them their groups' sizes). */
  forget() { this.memo.clear(); }
  private main(id: string): DocNode | undefined {
    if (!this.mains) {
      const m = new Map<string, DocNode>();
      const walk = (l: DocNode[]) => { for (const n of l) { if (!n || typeof n !== "object") continue; if (n.id !== undefined) m.set(String(n.id), n); if (Array.isArray(n.children)) walk(n.children as DocNode[]); } };
      walk(this.doc.children);
      this.mains = m;
    }
    return this.mains.get(id);
  }
  /** An instance's node as drawn: the main's props under the instance's own (size, layout...), the main's layers. */
  private expand(n: DocNode, depth = 0): DocNode {
    if (n.type !== "ref" || depth > 16) return n;
    const m = this.main(str(n.ref));
    if (!m) return n;
    const own: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) if (k !== "type" && k !== "ref" && k !== "descendants" && k !== "children" && v !== undefined) own[k] = v;
    return { ...this.expand(m, depth + 1), ...own } as DocNode;
  }
  size(n0: DocNode, parentFlow: string | null = null): { w?: number; h?: number } {
    const hit = this.memo.get(n0);
    if (hit && parentFlow === null) return hit;
    const n = this.expand(n0);
    const out = { w: this.axis(n, true, parentFlow), h: this.axis(n, false, parentFlow) };
    if (parentFlow === null) this.memo.set(n0, out);
    return out;
  }
  private axis(n: DocNode, horizontal: boolean, parentFlow: string | null): number | undefined {
    const v = horizontal ? n.width : n.height;
    if (n.type === "group") { const e = this.extent(n); return Math.max(0, horizontal ? e.x1 : e.y1); }
    if (num(v) !== undefined) return v as number;
    const s = str(v);
    if (s.startsWith("$")) return undefined;
    const fill = s.startsWith("fill_container"), fit = s === "" || s.startsWith("fit_content");
    if (!fill && !fit) return undefined;
    const fb = fallbackOf(v);
    // Fill in a flow parent takes the parent's free space (or stretches): only the page knows it.
    if (fill && parentFlow && parentFlow !== "none") return undefined;
    if (fill && fb !== undefined) return fb;
    if (n.type === "frame") {
      const kids = ((n.children as DocNode[] | undefined) ?? []).filter((k) => k && typeof k === "object" && k.enabled !== false);
      const layout = str(n.layout) || "horizontal";
      const ex = (n.canvasLayout && typeof n.canvasLayout === "object" ? n.canvasLayout : (n.metadata as Record<string, unknown> | undefined)?.canvasLayout ?? {}) as Record<string, unknown>;
      if (ex.wrap || num(ex[horizontal ? "minWidth" : "minHeight"]) || num(ex[horizontal ? "maxWidth" : "maxHeight"])) return undefined; // the engine's wrapping and limits
      if (layout === "none") {
        if (!kids.length) return fb ?? 0;
        const e = this.extent(n);
        return horizontal ? (Number.isFinite(e.x1) ? Math.max(0, e.x1) : undefined) : (Number.isFinite(e.y1) ? Math.max(0, e.y1) : undefined);
      }
      const flow = kids.filter((k) => k.layoutPosition !== "absolute");
      if (!flow.length) return fb ?? (padOf(n.padding)[horizontal ? 1 : 0] + padOf(n.padding)[horizontal ? 3 : 2]);
      const pad = padOf(n.padding);
      const main = (layout === "vertical") !== horizontal;
      const gap = num(n.gap) ?? 0;
      let total = 0;
      for (const k of flow) {
        const ks = this.size(k, layout);
        const kv = horizontal ? ks.w : ks.h;
        if (kv === undefined) return undefined;
        total = main ? total + kv : Math.max(total, kv);
      }
      if (main) total += gap * (flow.length - 1);
      return total + (horizontal ? pad[1] + pad[3] : pad[0] + pad[2]);
    }
    if (n.type === "text" || n.type === "note" || n.type === "prompt" || n.type === "context") return fb;
    if (n.type === "icon" || n.type === "icon_font") return 24;
    return fb ?? 0;
  }
  /** A group's or layout-none frame's layers' extent from its origin (NaN where a layer's size is unknown). */
  extent(g: DocNode): { x0: number; y0: number; x1: number; y1: number } {
    const kids = (g.children as DocNode[] | undefined) ?? [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of kids) {
      if (!k || typeof k !== "object" || k.enabled === false) continue; // the engine draws no hidden layer
      const b = this.box(k);
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    return x0 === Infinity ? { x0: 0, y0: 0, x1: 0, y1: 0 } : { x0, y0, x1, y1 }; // Math.min/max keep a NaN
  }
  /** The box a layer covers in its parent's coordinates; NaN on an axis its unknown size could reach. */
  box(n: DocNode): { x0: number; y0: number; x1: number; y1: number } {
    const s = this.size(n);
    const b = boxOf(n, { w: s.w ?? 0, h: s.h ?? 0 });
    // An unknown size moves only the far edge of an upright, unflipped layer; turned or flipped, any edge.
    const turned = !!(num(n.rotation) ?? 0);
    if (s.w === undefined) { if (turned) { b.x0 = b.y0 = b.y1 = NaN; } else if (n.flipX === true) b.x0 = NaN; b.x1 = NaN; }
    if (s.h === undefined) { if (turned) { b.x0 = b.y0 = b.x1 = NaN; } else if (n.flipY === true) b.y0 = NaN; b.y1 = NaN; }
    return b;
  }
}

/** A layer's size from the file: its numbers, or for a group its layers' extent; 0 where the file does not say. */
function sizeOf(n: DocNode): { w: number; h: number } {
  if (n.type === "group" && num(n.width) === undefined) {
    const e = extentOf(n);
    return { w: Math.max(0, e.x1), h: Math.max(0, e.y1) };
  }
  return { w: num(n.width) ?? 0, h: num(n.height) ?? 0 };
}

/** The box a layer covers in its parent's coordinates, rotation (degrees counterclockwise about x/y) and flips included. */
export function localBox(n: DocNode): { x0: number; y0: number; x1: number; y1: number } {
  return boxOf(n, sizeOf(n));
}
function boxOf(n: DocNode, { w, h }: { w: number; h: number }): { x0: number; y0: number; x1: number; y1: number } {
  return turnedBox(n, num(n.x) ?? 0, num(n.y) ?? 0, w, h);
}
/** The box a layer of size w x h stored at x/y covers, with `n`'s rotation and flips. */
export function turnedBox(n: DocNode, x: number, y: number, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } {
  const r = num(n.rotation) ?? 0;
  const sw = n.flipX === true ? -w : w, sh = n.flipY === true ? -h : h;
  if (!r && n.flipX !== true && n.flipY !== true) return { x0: x, y0: y, x1: x + w, y1: y + h };
  const t = (-r * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [u, v] of [[0, 0], [sw, 0], [0, sh], [sw, sh]]) {
    const px = c * u - s * v, py = s * u + c * v;
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  return { x0: x + x0, y0: y + y0, x1: x + x1, y1: y + y1 };
}

function extentOf(g: DocNode): { x0: number; y0: number; x1: number; y1: number } {
  const kids = (g.children as DocNode[] | undefined) ?? [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of kids) {
    if (!k || typeof k !== "object") continue;
    const b = localBox(k);
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/** Does `parent` place this layer itself (auto layout flow)? Then the layer's x/y mean nothing. */
function placedByParent(parent: DocNode | null, n: DocNode): boolean {
  if (!parent || parent.type === "group") return false;
  const layout = typeof parent.layout === "string" ? parent.layout : "horizontal";
  return layout !== "none" && n.layoutPosition !== "absolute";
}

/** The groups whose bounds follow `ids`' layers: each layer's run of group ancestors, nearest first, deepest first overall. */
export function groupsAround(doc: Doc, ids: Iterable<string | null | undefined>): string[] {
  const want = new Set<string>();
  for (const id of ids) if (id && !id.includes("/")) want.add(id);
  const depth = new Map<string, number>();
  if (!want.size) return [];
  let left = want.size;
  // One walk for every id: a multi-selection of thousands must not search the document once per layer.
  const visit = (list: DocNode[], chain: DocNode[]) => {
    for (const n of list) {
      if (!left) return;
      if (!n || typeof n !== "object") continue;
      if (want.has(String(n.id))) {
        left--;
        // The node itself when it is a group (its layers changed), then its run of group ancestors.
        if (n.type === "group") depth.set(String(n.id), chain.length);
        for (let i = chain.length - 1; i >= 0 && chain[i].type === "group"; i--) depth.set(String(chain[i].id), i);
      }
      if (Array.isArray(n.children)) visit(n.children as DocNode[], [...chain, n]);
    }
  };
  for (const b of doc.children) {
    if (!left) break;
    if (!b || typeof b !== "object") continue;
    // A board of an adopted version that holds none of the ids is not walked (boardindex.ts).
    if (boardLacks(b, want)) continue;
    visit([b], []);
  }
  return [...depth.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Every id a refit of those groups may change: the groups and their direct layers (for editDoc's touches). */
export function fitTouches(doc: Doc, groups: string[]): string[] {
  const out: string[] = [];
  for (const g of groups) {
    let f;
    try { f = findNode(doc as never, g); } catch { continue; }
    out.push(g);
    for (const k of (f.node.children as DocNode[] | undefined) ?? []) if (k && typeof k.id === "string") out.push(k.id);
  }
  return out;
}

/**
 * Refit `groups` (deepest first, as groupsAround gives them): each group's x/y moves to its layers' top-left corner
 * and the layers shift back. `set` writes props (the caller records them). An empty group is left to the caller.
 * Returns the empty groups met.
 */
export function refitGroups(doc: Doc, groups: string[], set: (id: string, props: Record<string, Json>) => void): string[] {
  const empty: string[] = [];
  const sizer = new Sizer(doc);
  for (const id of groups) {
    sizer.forget();
    let f;
    try { f = findNode(doc as never, id); } catch { continue; }
    const g = f.node;
    if (g.type !== "group") continue;
    const kids = ((g.children as DocNode[] | undefined) ?? []).filter((k) => k && typeof k === "object");
    if (!kids.length) { empty.push(id); continue; }
    // Layers' sizes as the engine lays them out (hug frames, instances); an axis a layer's unknown size could reach
    // (text that sizes itself, turned or flipped) is left as it is rather than fitted to a guess.
    const e = sizer.extent(g);
    const dx = Number.isFinite(e.x0) && Math.abs(e.x0) > EPS ? e.x0 : 0, dy = Number.isFinite(e.y0) && Math.abs(e.y0) > EPS ? e.y0 : 0;
    if (dx || dy) {
      for (const k of kids) {
        const p: Record<string, Json> = {};
        if (dx) p.x = r2((num(k.x) ?? 0) - dx);
        if (dy) p.y = r2((num(k.y) ?? 0) - dy);
        set(String(k.id), p);
      }
      if (!placedByParent(f.parent, g)) {
        // The layers' corner in the group's parent: the group's own rotation and flips apply to it.
        const r = num(g.rotation) ?? 0, t = (-r * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
        const u = g.flipX === true ? -dx : dx, v = g.flipY === true ? -dy : dy;
        set(id, { x: r2((num(g.x) ?? 0) + c * u - s * v), y: r2((num(g.y) ?? 0) + s * u + c * v) });
      }
    }
    const size: Record<string, Json> = {};
    if (num(g.width) !== undefined && Number.isFinite(e.x1 - e.x0) && Math.abs((g.width as number) - (e.x1 - e.x0)) > 0.005) size.width = r2(e.x1 - e.x0);
    if (num(g.height) !== undefined && Number.isFinite(e.y1 - e.y0) && Math.abs((g.height as number) - (e.y1 - e.y0)) > 0.005) size.height = r2(e.y1 - e.y0);
    if (Object.keys(size).length) set(id, size);
  }
  return empty;
}

/**
 * Refit the groups around `seeds` (layers that moved, or the parents that lost or gained layers). A group left with
 * no layers goes (`remove`: an empty group is deleted) and the groups around it fit again. Returns the removed ids.
 */
export function fitAround(doc: Doc, seeds: Iterable<string | null | undefined>, set: (id: string, props: Record<string, Json>) => void, remove?: (id: string) => void): string[] {
  const removed: string[] = [];
  let groups = groupsAround(doc, seeds);
  for (let pass = 0; pass < 32 && groups.length; pass++) {
    const empty = refitGroups(doc, groups, set);
    if (!remove || !empty.length) break;
    const parents: string[] = [];
    for (const g of empty) {
      let f;
      try { f = findNode(doc as never, g); } catch { continue; }
      remove(g);
      removed.push(g);
      if (f.parent) parents.push(String(f.parent.id));
    }
    groups = groupsAround(doc, parents);
  }
  return removed;
}
