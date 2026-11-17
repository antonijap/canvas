// What the canvas draws and lists for one document: boards with change keys, one board as HTML,
// components, variables and the text styles actually used in the file.

import { createHash } from "node:crypto";
import path from "node:path";
import { displayPath } from "./docpath.ts";
import { boardCache } from "./boardcache.ts";
import { freezeBoards, warmBoardFacts } from "./doc/boardindex.ts";
import { reusableNodes, styleKey, textProps, usageIndex } from "./usage.ts";
import { guidesOf as layoutGuidesIn, type LayoutGuide } from "./page/layout-guides-logic.js";
import { buildIndex, defaultTheme, expand, fontAssets, nodeHtml, revisionOf, stateHashOf, type LoadedDoc, type CanvasDoc, type DocNode, walk } from "./engine.ts";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

const numOr = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** type: the node's type. Only frames are boards in the person's eyes: other top-level layers show no name label. */
/** `guides`: ruler guides saved on the board (metadata.canvasGuides, src/page/navigate.js), offsets from its top-left. */
/** `layoutGuides`: the frames in the board (itself included) that have layout guides (metadata.canvasLayoutGuides,
 * src/page/layout-guides-logic.js), with their guides; the page draws them over the canvas. */
export type BoardMeta = { id: string; name: string; type: string; x: number; y: number; width?: number; height?: number; key: string; guides?: { axis: "x" | "y"; at: number }[]; layoutGuides?: { id: string; guides: LayoutGuide[] }[] };

/** A board's ruler guides, when it has any: well-formed ones only. */
function guidesOf(n: Record<string, any>): { guides?: { axis: "x" | "y"; at: number }[] } {
  const list = n.metadata?.canvasGuides;
  if (!Array.isArray(list)) return {};
  const guides = list.filter((g) => g && (g.axis === "x" || g.axis === "y") && typeof g.at === "number" && Number.isFinite(g.at)).map((g) => ({ axis: g.axis as "x" | "y", at: g.at as number }));
  return guides.length ? { guides } : {};
}

function hasRef(n: DocNode): boolean {
  if (n.type === "ref") return true;
  return Array.isArray(n.children) && (n.children as DocNode[]).some(hasRef);
}

/** Per board object: a digest of its content, whether it uses components, and a digest of the components it holds. */
type BoardFacts = { digest: string; hasRef: boolean; comps: string; layoutGuides: { id: string; guides: LayoutGuide[] }[] };
const facts = boardCache<BoardFacts>();
function factsOf(n: DocNode): BoardFacts {
  let f = facts.get(n);
  if (f) return f;
  const components: DocNode[] = [];
  const layoutGuides: { id: string; guides: LayoutGuide[] }[] = [];
  walk({ children: [n] } as CanvasDoc, (c) => {
    if (c.reusable === true) components.push(c);
    if (c.type === "frame" && c.metadata && typeof c.metadata === "object") {
      const g = layoutGuidesIn(c.metadata);
      if (g.length) layoutGuides.push({ id: String(c.id), guides: g });
    }
  });
  f = { digest: sha1(JSON.stringify(n)), hasRef: hasRef(n), comps: components.length ? sha1(JSON.stringify(components)) : "", layoutGuides };
  facts.set(n, f);
  return f;
}

/** True when this board object's cached digest no longer matches its content (it was changed in place). */
export function boardDigestStale(n: object): boolean {
  const f = facts.get(n);
  return !!f && f.digest !== sha1(JSON.stringify(n));
}

/**
 * Top-level boards with their place on the canvas and a key that changes when anything drawn in them
 * could. A board that uses components also depends on every component, wherever it lives; all boards
 * depend on variables and fonts. Each board's own digest is worked out once per board object (boardcache.ts),
 * so after an edit only the boards it touched cost anything.
 */
export function boardsOf(doc: CanvasDoc): BoardMeta[] {
  const shared = sha1(JSON.stringify([doc.variables ?? {}, doc.themes ?? {}, doc.fonts ?? []]));
  const all = doc.children.map((n) => (n && typeof n === "object" ? factsOf(n) : undefined));
  const comps = sha1(all.map((f) => f?.comps ?? "").join(","));
  return doc.children
    .map((n, i) => ({ n, f: all[i] }))
    .filter(({ n }) => n && typeof n === "object" && n.enabled !== false)
    .map(({ n, f }) => ({
      id: String(n.id),
      name: String(n.name ?? n.type ?? ""),
      type: String(n.type ?? ""),
      x: numOr(n.x) ?? 0,
      y: numOr(n.y) ?? 0,
      width: numOr(n.width),
      height: numOr(n.height),
      key: sha1(`${shared}:${f!.hasRef ? comps : ""}:${f!.digest}`),
      ...guidesOf(n),
      ...(f!.layoutGuides.length ? { layoutGuides: f!.layoutGuides } : {}),
    }));
}

/** One board as HTML for the page, plus the fonts it needs. Images and fonts on disk go through /asset. */
export function boardHtml(doc: CanvasDoc, file: string, id: string): { html: string; faces: string; links: string[]; warnings: string[] } {
  const raw = doc.children.find((n) => String(n.id) === id);
  if (!raw) throw new Error(`no board "${id}"`);
  const warnings: string[] = [];
  const o = { doc, baseDir: path.dirname(file), theme: defaultTheme(doc), warnings, assetUrl: (abs: string) => `/asset?p=${encodeURIComponent(abs)}` };
  const families = new Set<string>();
  const html = nodeHtml(expand(buildIndex(doc), raw, warnings), { layout: "none", root: true }, o, families, o.theme);
  return { html, ...fontAssets(o, families), warnings };
}

/** `board` is the top-level board the component sits in; `instances` how many ref nodes point at it. */
export type ComponentInfo = { id: string; name: string; type: string; isText: boolean; board: string; instances: number };

/** The design system: reusable nodes. A reusable text node doubles as a text style. */
export function componentsOf(doc: CanvasDoc): ComponentInfo[] {
  const ix = usageIndex(doc);
  return reusableNodes(doc).map(({ node: n, board }) => {
    const id = String(n.id);
    return { id, name: String(n.name ?? n.type ?? ""), type: String(n.type ?? ""), isText: n.type === "text", board, instances: ix.instances.get(id)?.length ?? 0 };
  });
}

export type TextStyle = { key: string; props: Record<string, unknown>; count: number };

/** Text styles as they are actually used: every distinct set of text properties, most used first. */
const styleParts = boardCache<Map<string, TextStyle>>();
export function textStylesOf(doc: CanvasDoc): TextStyle[] {
  const groups = new Map<string, TextStyle>();
  for (const top of doc.children) {
    if (!top || typeof top !== "object") continue;
    let part = styleParts.get(top);
    if (!part) {
      part = new Map();
      walk({ children: [top] } as CanvasDoc, (n) => {
        if (n.type !== "text") return;
        const props = textProps(n);
        const key = styleKey(props);
        const g = part!.get(key);
        if (g) g.count++;
        else part!.set(key, { key, props, count: 1 });
      });
      styleParts.set(top, part);
    }
    for (const [key, p] of part) {
      const g = groups.get(key);
      if (g) g.count += p.count;
      else groups.set(key, { key, props: p.props, count: p.count });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** One watched document: everything the page needs, reloaded when the file changes on disk. */
export type Snapshot = {
  path: string;
  name: string;
  revision: string;
  doc: CanvasDoc;
  boards: BoardMeta[];
  components: ComponentInfo[];
  styles: TextStyle[];
  variables: Record<string, unknown>;
  themes: Record<string, unknown>;
  /** sha256 of the bytes it was loaded from (absent for a state only in memory). */
  hash?: string;
  /** How the file spells its JSON, so a write keeps the bytes of everything that did not change. */
  format?: { indent: string; trailing: string; mode: number; size: number };
};

const nameOf = (file: string) => {
  const d = displayPath(file);
  return path.basename(d, d.endsWith(".canvas") ? ".canvas" : ".canvas.json");
};

export function snapshotOf(loaded: LoadedDoc): Snapshot {
  // A file just read: its boards' indexes are worked out while the server is idle, so the first structure op on a
  // big file does not pay for all of them (100 ms on 2,000 boards).
  warmBoardFacts(loaded.doc);
  return snapshotOfDoc(loaded.path, loaded.doc, revisionOf(stateHashOf(loaded)), { indent: loaded.indent, trailing: loaded.trailing, mode: loaded.mode, size: loaded.size }, loaded.hash);
}

/**
 * A snapshot of a document (loaded, or an edit held in memory). Boards, components and styles are worked out on
 * first read, so an edit can answer before they are; per-board facts are reused across versions (boardcache.ts).
 */
export function snapshotOfDoc(file: string, doc: CanvasDoc, revision: string, format?: Snapshot["format"], hash?: string): Snapshot {
  // This version is what Canvas holds now: its boards are never changed in place (edits copy them first).
  freezeBoards(doc);
  const s = {
    path: file,
    name: nameOf(file),
    revision,
    doc,
    variables: (doc.variables ?? {}) as Record<string, unknown>,
    themes: (doc.themes ?? {}) as Record<string, unknown>,
    ...(hash ? { hash } : {}),
    ...(format ? { format } : {}),
  } as Snapshot;
  const lazy = <K extends "boards" | "components" | "styles">(key: K, make: () => Snapshot[K]) => {
    let v: Snapshot[K] | undefined;
    Object.defineProperty(s, key, {
      enumerable: true,
      configurable: true,
      get: () => (v ??= make()),
      set: (x: Snapshot[K]) => void (v = x),
    });
  };
  lazy("boards", () => boardsOf(doc));
  lazy("components", () => componentsOf(doc));
  lazy("styles", () => textStylesOf(doc));
  return s;
}
