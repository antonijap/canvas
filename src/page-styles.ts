import type { Snapshot } from "./boards.ts";
import { buildIndex, defaultTheme, expand, resolveVariable, type CanvasDoc, type DocNode, type Json } from "./engine.ts";
import { weightOf } from "./fontfiles.ts";
import { isTextLayer } from "./page/whiteboard-model.js";
import { storedIndex } from "./scale.ts";
import { normColor } from "./selection-colors.ts";
import { textTarget } from "./textedit.ts";

type Theme = Record<string, string>;
type Usage = { count: number; ids: string[] };
type ColorStyle = { value: string; token?: string; editable: boolean } & Usage;
type TextStyle = { family: string; weight: number; size: number; lineHeight?: number };
type ColorChange = { from: string; to: string };

function object(v: Json | undefined): v is Record<string, Json> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function layerPaint(node: DocNode, visit: (color: string) => void, change?: ColorChange): Record<string, Json> {
  const props: Record<string, Json> = {};
  function swatch(value: Json | undefined): Json | undefined {
    const color = normColor(value);
    if (!color) return value;
    visit(color);
    return color === change?.from ? change.to : value;
  }
  function solid(paint: Json): Json {
    if (typeof paint === "string") return swatch(paint) ?? paint;
    if (!object(paint) || (paint.type !== "color" && paint.type !== undefined)) return paint;
    const color = swatch(paint.color);
    return color !== undefined && color !== paint.color ? { ...paint, color } : paint;
  }
  for (const key of ["fill", "stroke"]) {
    const paint = node[key];
    if (paint === undefined) continue;
    const next = Array.isArray(paint) ? paint.map(solid) : solid(paint);
    if (Array.isArray(paint) && Array.isArray(next) ? next.some((v, i) => v !== paint[i]) : next !== paint) props[key] = next;
  }
  if (isTextLayer(node.type) && Array.isArray(node.spans)) {
    const spans = node.spans.map((span) => {
      if (!object(span)) return span;
      const fill = swatch(span.fill);
      return fill !== undefined && fill !== span.fill ? { ...span, fill } : span;
    });
    // A whole-layer fill write normally removes fill overrides from its text ranges.
    if ("fill" in props || spans.some((span, i) => span !== (node.spans as Json[])[i])) props.spans = spans;
  }
  return props;
}

function visitPage(doc: CanvasDoc, boards: readonly string[], visit: (node: DocNode, id: string, theme: Theme) => void) {
  const roots = new Set(boards);
  const seen = new Set<string>();
  let index: ReturnType<typeof buildIndex> | undefined;
  function walk(node: DocNode, inherited: Theme) {
    if (!node || typeof node.id !== "string") return;
    const id = node.id;
    if (seen.has(id)) return;
    seen.add(id);
    if (node.type === "ref") {
      // A broken instance should not hide the other layers on the page.
      try { node = expand(index ??= buildIndex(doc), node); } catch { /* use its own props */ }
    }
    const theme = object(node.theme) ? { ...inherited, ...node.theme } as Theme : inherited;
    visit(node, id, theme);
    if (node.type !== "ref" && Array.isArray(node.children)) for (const child of node.children) walk(child as DocNode, theme);
  }
  const theme = defaultTheme(doc);
  for (const board of doc.children) if (board && roots.has(String(board.id))) walk(board, theme);
}

function plain(doc: CanvasDoc, value: Json | undefined, theme: Theme) {
  return typeof value === "string" && value.startsWith("$") ? resolveVariable(doc, value.slice(1), theme) : value;
}

function textStyles(doc: CanvasDoc, node: DocNode, theme: Theme): TextStyle[] {
  const height = plain(doc, node.lineHeight, theme);
  const style = (span?: Record<string, Json>): TextStyle => {
    const family = plain(doc, span?.fontFamily ?? node.fontFamily, theme);
    const size = plain(doc, span?.fontSize ?? node.fontSize, theme);
    return {
      family: typeof family === "string" && family ? family : "Inter",
      weight: weightOf(plain(doc, span?.fontWeight ?? node.fontWeight, theme)),
      size: typeof size === "number" ? size : 13,
      ...(typeof height === "number" ? { lineHeight: height } : {}),
    };
  };
  const content = plain(doc, node.content, theme);
  const length = typeof content === "string" ? content.length : 0;
  const spans = Array.isArray(node.spans) ? node.spans.filter(object)
    .filter((s) => typeof s.start === "number" && typeof s.end === "number" && s.end > s.start)
    .sort((a, b) => Number(a.start) - Number(b.start)) : [];
  const styles: TextStyle[] = [];
  let end = 0;
  for (const span of spans) {
    const start = Math.max(end, Number(span.start));
    const next = Math.min(length, Number(span.end));
    if (next <= start) continue;
    if (start > end) styles.push(style());
    styles.push(style(span));
    end = next;
  }
  if (!styles.length || end < length) styles.push(style());
  return styles;
}

export function pageStyles(snap: Pick<Snapshot, "doc" | "revision">, boards: readonly string[]) {
  const colors = new Map<string, ColorStyle>();
  const text = new Map<string, TextStyle & Usage>();
  const add = (row: Usage, id: string) => {
    if (row.ids.at(-1) === id) return;
    row.ids.push(id);
    row.count++;
  };
  let stored: ReturnType<typeof storedIndex> | undefined;
  visitPage(snap.doc, boards, (node, id, theme) => {
    layerPaint(node, (color) => {
      let row = colors.get(color);
      if (!row) {
        const token = color.startsWith("$") ? color.slice(1) : undefined;
        const value = token ? normColor(resolveVariable(snap.doc, token, theme)) : color;
        row = { value: value ?? color, ...(token ? { token } : {}), count: 0, ids: [], editable: false };
        colors.set(color, row);
      }
      add(row, id);
      row.editable ||= textTarget(snap.doc, id, stored ??= storedIndex(snap.doc)) !== undefined;
    });
    if (isTextLayer(node.type)) for (const style of textStyles(snap.doc, node, theme)) {
      const key = JSON.stringify(style);
      const row = text.get(key) ?? { ...style, count: 0, ids: [] };
      add(row, id);
      text.set(key, row);
    }
  });
  const byCount = (a: Usage, b: Usage) => b.count - a.count;
  return { rev: snap.revision, colors: [...colors.values()].sort(byCount), text: [...text.values()].sort(byCount) };
}

export function replacePageColor(doc: CanvasDoc, boards: readonly string[], from: string, to: string) {
  const entries: [string, Record<string, Json>][] = [];
  let overrides = false;
  let stored: ReturnType<typeof storedIndex> | undefined;
  if (from !== to) visitPage(doc, boards, (node, id) => {
    const props = layerPaint(node, () => {}, { from, to });
    if (!Object.keys(props).length) return;
    const target = textTarget(doc, id, stored ??= storedIndex(doc));
    if (!target) return;
    entries.push([id, props]);
    overrides ||= target.kind !== "node";
  });
  return { ids: entries.map(([id]) => id), each: Object.fromEntries(entries), overrides };
}
