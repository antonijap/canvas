// A document in one screenful: boards, counts, components, variables, fonts in use. Pure; no I/O.

import fs from "node:fs";
import path from "node:path";
import type { BoardMeta, Snapshot } from "./boards.ts";
import { type CanvasDoc, type DocNode, walk } from "./engine.ts";

export type FontUse = { family: string; weights: string[]; nodes: number; source: "embedded" | "system" | "other"; embeddedFile?: { url: string; exists: boolean } };

const SYSTEM_FONT = /^(SF Pro|San Francisco|Helvetica|Arial|Times|Georgia|Courier|Menlo|system-ui)/i;

/** The text families the document sets, with the weights used and whether the file embeds them. */
export function fontsUsed(doc: CanvasDoc, file?: string): FontUse[] {
  const embedded = new Map<string, string>();
  for (const f of Array.isArray(doc.fonts) ? (doc.fonts as Record<string, unknown>[]) : []) {
    if (f && typeof f.name === "string" && typeof f.url === "string") embedded.set(f.name, f.url);
  }
  const by = new Map<string, { weights: Set<string>; nodes: number }>();
  walk(doc, (n) => {
    if (n.type !== "text" || typeof n.fontFamily !== "string") return;
    const g = by.get(n.fontFamily) ?? { weights: new Set<string>(), nodes: 0 };
    g.weights.add(String(n.fontWeight ?? "400"));
    g.nodes++;
    by.set(n.fontFamily, g);
  });
  return [...by.entries()]
    .sort((a, b) => b[1].nodes - a[1].nodes)
    .map(([family, g]) => {
      const url = embedded.get(family);
      const use: FontUse = { family, weights: [...g.weights].sort(), nodes: g.nodes, source: url ? "embedded" : SYSTEM_FONT.test(family) ? "system" : "other" };
      if (url) {
        const abs = url.startsWith("file://") ? decodeURIComponent(new URL(url).pathname) : path.isAbsolute(url) ? url : file ? path.resolve(path.dirname(file), url) : url;
        use.embeddedFile = { url, exists: /^https?:/.test(url) ? true : fs.existsSync(abs) };
      }
      return use;
    });
}

/** top-level board id for every node id in the stored tree. */
export function boardIndex(doc: CanvasDoc): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: DocNode, top: string) => {
    if (typeof n.id === "string") out.set(n.id, top);
    for (const c of (n.children as DocNode[] | undefined) ?? []) visit(c, top);
  };
  for (const t of doc.children) visit(t, String(t.id));
  return out;
}

/** The board an id belongs to; instance paths ("Ins01/Lbl01") go by their first segment. */
export function boardOf(index: Map<string, string>, id: string): string | undefined {
  return index.get(id) ?? index.get(id.split("/")[0]);
}

function countNodes(n: DocNode): number {
  return 1 + ((n.children as DocNode[] | undefined) ?? []).reduce((a, c) => a + countNodes(c), 0);
}

export type Summary = {
  file: string;
  name: string;
  revision: string;
  version: unknown;
  boards: (Pick<BoardMeta, "id" | "name" | "x" | "y"> & { width?: number; height?: number; type: string; children: number; nodes: number })[];
  counts: { topLevel: number; nodes: number; byType: Record<string, number>; components: number; instances: number; variables: number };
  components: { id: string; name: string; type: string }[];
  variables: { name: string; type: unknown; value: unknown }[];
  themes: Record<string, unknown>;
  fonts: FontUse[];
};

export function summaryOf(snap: Snapshot): Summary {
  const byType: Record<string, number> = {};
  let nodes = 0;
  let instances = 0;
  walk(snap.doc, (n) => {
    nodes++;
    byType[String(n.type)] = (byType[String(n.type)] ?? 0) + 1;
    if (n.type === "ref") instances++;
  });
  const top = new Map(snap.doc.children.map((n) => [String(n.id), n]));
  return {
    file: snap.path,
    name: snap.name,
    revision: snap.revision,
    version: snap.doc.version,
    boards: snap.boards.map((b) => {
      const n = top.get(b.id)!;
      return { id: b.id, name: b.name, x: b.x, y: b.y, width: b.width, height: b.height, type: String(n.type), children: ((n.children as DocNode[] | undefined) ?? []).length, nodes: countNodes(n) };
    }),
    counts: { topLevel: snap.doc.children.length, nodes, byType, components: snap.components.length, instances, variables: Object.keys(snap.variables).length },
    components: snap.components.map((c) => ({ id: c.id, name: c.name, type: c.type })),
    variables: Object.entries(snap.variables).map(([name, def]) => {
      const d = def as { type?: unknown; value?: unknown };
      return { name, type: d?.type, value: d?.value };
    }),
    themes: snap.themes,
    fonts: fontsUsed(snap.doc, snap.path),
  };
}
