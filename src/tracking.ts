// Auto letter spacing: the tracking a text node gets for its font and size when the inspector's "Auto" is on.
// Inter follows Rasmus Andersson's Dynamic Metrics, San Francisco and New York follow Apple's published
// tracking tables, and any other font gets a damped Inter curve shifted by the font's x-height
// (research and reasoning: .planning/research/auto-tracking.md).
//
// Units: a document stores letterSpacing in px (points), as the renderers read it, so every public
// function here answers in px for a given size unless its name says em.
//
// Auto mode lives on the node, in the format's extension slot: `metadata: { type: "canvas", canvasLetterSpacing: "auto" }`.
// The schema declares `metadata?: { type: string; [key: string]: any }`; nothing draws from it and every writer keeps
// it, so the flag travels with copies and duplicates and never changes how the text is drawn. A node that already
// carries someone else's metadata keeps its `type`; Canvas only adds its one key.

import { findFont } from "./fontfiles.ts";
import { defaultTheme, findNode, resolveVariable, type Json, type CanvasDoc, type DocNode } from "./engine.ts";

// ---------------------------------------------------------------- the curves

/** Inter Dynamic Metrics, in em: -0.0223 + 0.185 * e^(-0.1745 * size). */
export function interTrackingEm(size: number): number {
  return -0.0223 + 0.185 * Math.exp(-0.1745 * size);
}

/** Apple HIG tracking tables, in points by point size (copied from ~/.claude/skills/sf-typography, 5 Nov 2026). */
export const SF_PRO: Record<number, number> = {
  6: 0.24, 7: 0.23, 8: 0.21, 9: 0.17, 10: 0.12, 11: 0.06, 12: 0, 13: -0.08, 14: -0.15, 15: -0.23, 16: -0.31, 17: -0.43, 18: -0.44,
  19: -0.45, 20: -0.45, 21: -0.36, 22: -0.26, 23: -0.1, 24: 0.07, 25: 0.15, 26: 0.22, 27: 0.29, 28: 0.38, 29: 0.4, 30: 0.4, 31: 0.39,
  32: 0.41, 33: 0.4, 34: 0.4, 35: 0.38, 36: 0.37, 37: 0.36, 38: 0.37, 39: 0.38, 40: 0.37, 41: 0.36, 42: 0.37, 43: 0.38, 44: 0.37,
  45: 0.35, 46: 0.36, 47: 0.37, 48: 0.35, 50: 0.34, 52: 0.33, 54: 0.32, 56: 0.3, 60: 0.26, 64: 0.22, 72: 0.14, 76: 0.07, 80: 0,
};
export const SF_PRO_ROUNDED: Record<number, number> = {
  6: 0.51, 7: 0.54, 8: 0.57, 9: 0.57, 10: 0.57, 11: 0.56, 12: 0.54, 13: 0.51, 14: 0.48, 15: 0.44, 16: 0.41, 17: 0.37, 18: 0.37,
  19: 0.37, 20: 0.36, 21: 0.35, 22: 0.34, 23: 0.35, 24: 0.35, 25: 0.35, 26: 0.36, 28: 0.36, 30: 0.37, 32: 0.38, 34: 0.38, 40: 0.39,
  48: 0.35, 60: 0.23,
};
export const NEW_YORK: Record<number, number> = {
  11: 0.12, 12: 0.07, 13: 0.05, 14: 0.03, 15: 0, 16: -0.03, 17: -0.07, 18: -0.11, 19: -0.15, 20: -0.2, 22: -0.23, 24: -0.26,
  28: -0.33, 34: -0.45, 40: -0.55,
};

/**
 * A row of an Apple table. Apple publishes whole sizes only, so a size between rows takes the nearest row
 * (the lower one on a tie); below the table the first row holds, above it the last (SF Pro's last row is 80+ = 0).
 */
export function appleTracking(table: Record<number, number>, size: number): number {
  const sizes = Object.keys(table).map(Number).sort((a, b) => a - b);
  let best = sizes[0];
  for (const s of sizes) if (Math.abs(s - size) < Math.abs(best - size)) best = s;
  return table[best];
}

/** What a font file says about its proportions. Any field may be missing. */
export type FontMetrics = { upm: number; xHeight?: number; capHeight?: number; avgWidth?: number; monospace?: boolean };

/** Inter 4's x-height over its em (1118 / 2048): the generic curve is Inter's, moved by how far a font's x-height is from this. */
export const INTER_X_HEIGHT = 1118 / 2048;
/** Fonts that were not drawn with this curve in mind get 60% of Inter's correction. */
export const GENERIC_STRENGTH = 0.6;

/**
 * Any other font, in em. A larger x-height reads as a larger size, so the font sits further along Inter's
 * curve: size * (x-height ratio / Inter's), clamped to 0.8-1.25 so a wild metric cannot run away. The result is
 * damped to GENERIC_STRENGTH of Inter's curve. Monospaced fonts stay at 0: their spacing is the design.
 */
export function genericTrackingEm(size: number, m?: FontMetrics): number {
  if (m?.monospace) return 0;
  const xh = m?.xHeight && m.upm ? m.xHeight / m.upm : INTER_X_HEIGHT;
  const ratio = Math.min(1.25, Math.max(0.8, xh / INTER_X_HEIGHT));
  return GENERIC_STRENGTH * interTrackingEm(size * ratio);
}

export type TrackingMethod = "inter" | "sf" | "sf-rounded" | "new-york" | "generic";

/** Which curve a family takes. The first name of a CSS-style list counts; quotes and case do not matter. */
export function trackingMethod(family: string): TrackingMethod {
  const f = family.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (/^(inter|inter variable|intervariable|inter var)$/.test(f)) return "inter";
  if (/^(sf pro rounded|ui-rounded|\.sf ns rounded)$/.test(f)) return "sf-rounded";
  if (/^(new york( small| medium| large| extra large)?|ui-serif)$/.test(f)) return "new-york";
  if (/^(sf pro( text| display)?|san francisco|system-ui|-apple-system|blinkmacsystemfont|\.sf ns( text| display)?|\.applesystemuifont)$/.test(f)) return "sf";
  return "generic";
}

/** Round to Apple's precision (0.01 px) and never answer -0. */
const r2 = (v: number) => {
  const x = Math.round(v * 100) / 100;
  return Object.is(x, -0) ? 0 : x;
};

/** The auto letter spacing in px for a family at a size, and the curve that produced it. */
export function autoTracking(family: string, size: number, metrics?: FontMetrics): { px: number; method: TrackingMethod } {
  const method = trackingMethod(family);
  if (!(size > 0) || !Number.isFinite(size)) return { px: 0, method };
  switch (method) {
    case "inter":
      return { px: r2(interTrackingEm(size) * size), method };
    case "sf":
      return { px: r2(appleTracking(SF_PRO, size)), method };
    case "sf-rounded":
      return { px: r2(appleTracking(SF_PRO_ROUNDED, size)), method };
    case "new-york":
      return { px: r2(appleTracking(NEW_YORK, size)), method };
    default:
      return { px: r2(genericTrackingEm(size, metrics) * size), method };
  }
}

// ---------------------------------------------------------------- font metrics from an sfnt

/** units per em (head), x-height, cap height and average advance (OS/2), fixed pitch (post). */
export function sfntMetrics(sfnt: Buffer): FontMetrics | undefined {
  if (sfnt.length < 12) return undefined;
  const n = sfnt.readUInt16BE(4);
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    if (at + 16 > sfnt.length) break;
    const tag = sfnt.toString("latin1", at, at + 4);
    const off = sfnt.readUInt32BE(at + 8), len = sfnt.readUInt32BE(at + 12);
    if (off + len <= sfnt.length) tables.set(tag, sfnt.subarray(off, off + len));
  }
  const head = tables.get("head");
  if (!head || head.length < 20) return undefined;
  const m: FontMetrics = { upm: head.readUInt16BE(18) };
  const os2 = tables.get("OS/2");
  if (os2 && os2.length >= 4) {
    m.avgWidth = os2.readInt16BE(2);
    if (os2.readUInt16BE(0) >= 2 && os2.length >= 90) {
      const xh = os2.readInt16BE(86), ch = os2.readInt16BE(88);
      if (xh > 0) m.xHeight = xh;
      if (ch > 0) m.capHeight = ch;
    }
    if (os2.length >= 42 && os2[32] === 2 && os2[35] === 9) m.monospace = true; // PANOSE: Latin text, monospaced proportion
  }
  const post = tables.get("post");
  if (post && post.length >= 16 && post.readUInt32BE(12) !== 0) m.monospace = true;
  return m.upm > 0 ? m : undefined;
}

const metricsCache = new Map<string, Promise<FontMetrics | undefined>>();

export type MetricsLookup = (family: string, weight: number) => Promise<FontMetrics | undefined>;

/**
 * The metrics of the font the canvas would draw this family and weight with (Google, then installed). Cached.
 * A document's own @font-face files are not consulted: x-height barely moves between faces of one family.
 */
export const lookupMetrics: MetricsLookup = (family, weight) => {
  const key = `${family.toLowerCase()}|${weight}`;
  let p = metricsCache.get(key);
  if (!p) {
    p = findFont({ family, weight, italic: false })
      .then((hit) => (hit ? sfntMetrics(hit.bytes) : undefined))
      .catch(() => undefined);
    metricsCache.set(key, p);
  }
  return p;
};

// ---------------------------------------------------------------- auto mode on a node

export const AUTO_KEY = "canvasLetterSpacing";

export function isAutoTracking(node: DocNode | Record<string, unknown> | undefined): boolean {
  const m = node?.metadata;
  return !!m && typeof m === "object" && !Array.isArray(m) && (m as Record<string, unknown>)[AUTO_KEY] === "auto";
}

/** The metadata value that turns auto on or off, keeping whatever else the node's metadata holds. Null removes metadata. */
export function autoMetadata(current: unknown, on: boolean): Json {
  const m = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, Json>) } : {};
  if (on) return { type: typeof m.type === "string" ? m.type : "canvas", ...m, [AUTO_KEY]: "auto" };
  delete m[AUTO_KEY];
  const keys = Object.keys(m);
  return keys.length === 0 || (keys.length === 1 && m.type === "canvas") ? null : m;
}

type Theme = Record<string, string>;
const themeOf = (n: Record<string, unknown> | undefined) => (n && n.theme && typeof n.theme === "object" && !Array.isArray(n.theme) ? (n.theme as Theme) : undefined);

/**
 * The theme a node draws in: the document's default, then every ancestor's `theme`, then its own (`node`, when
 * given, stands in for the stored node: an edit not written yet). A node not in the tree gets the default and its own.
 */
export function themeOfNode(doc: CanvasDoc, id: string | undefined, node?: Record<string, unknown>): Theme {
  // A layer inside an instance ("Ins/child") sits where its instance does.
  const path = !!id && id.includes("/");
  const target = id ? id.split("/")[0] : undefined;
  let theme: Theme | undefined;
  const seek = (ns: DocNode[] | undefined, t: Theme): boolean => {
    for (const n of ns ?? []) {
      if (String(n.id) === target) { theme = { ...t, ...(themeOf(path ? n : (node ?? n)) ?? {}), ...(path ? (themeOf(node) ?? {}) : {}) }; return true; }
      if (seek(n.children as DocNode[] | undefined, { ...t, ...(themeOf(n) ?? {}) })) return true;
    }
    return false;
  };
  const base = defaultTheme(doc) as Theme;
  if (target) seek(doc.children, base);
  return theme ?? { ...base, ...(themeOf(node) ?? {}) };
}

/** A `$name` follows the document's variables to a plain value, in the theme given (the engine's resolver). */
function plain(doc: CanvasDoc, v: unknown, theme: Theme): unknown {
  return typeof v === "string" && v.startsWith("$") ? resolveVariable(doc, v.slice(1), theme) : v;
}

/**
 * The family, size and weight auto tracking reads from a text node, variables resolved in the theme the node
 * draws in (its own and its ancestors'; `theme` overrides that). The default family is Inter.
 */
export function fontOf(doc: CanvasDoc, node: Record<string, unknown>, theme?: Theme): { family: string; size: number | undefined; weight: number } {
  const t = theme ?? themeOfNode(doc, typeof node.id === "string" ? node.id : undefined, node);
  const fam = plain(doc, node.fontFamily, t);
  const size = Number(plain(doc, node.fontSize, t));
  const weight = Number(plain(doc, node.fontWeight, t)) || 400;
  return { family: typeof fam === "string" && fam ? fam : "Inter", size: Number.isFinite(size) && size > 0 ? size : undefined, weight };
}

/** Keys whose change (set or removed) makes an auto node recompute. The theme picks the value a size token has. */
const TRIGGERS = ["fontFamily", "fontSize", "fontWeight", "metadata", "theme"];
const touches = (props: Record<string, unknown>, remove: string[]) => TRIGGERS.some((k) => k in props || remove.includes(k));

/**
 * Before a write: the metrics the write will need, fetched ahead because writeDoc's change runs synchronously.
 * Undefined when the node is not (or will not be) auto, or its family has its own table.
 */
export async function prepareAutoTracking(doc: CanvasDoc, id: string, props: Record<string, unknown>, remove: string[] = [], lookup: MetricsLookup = lookupMetrics): Promise<FontMetrics | undefined> {
  if (!touches(props, remove)) return undefined;
  let node: DocNode;
  try {
    node = findNode(doc, id).node;
  } catch {
    return undefined;
  }
  const next = { ...node, ...props } as Record<string, unknown>;
  for (const k of remove) delete next[k];
  if (next.type !== "text" || !isAutoTracking(next as DocNode)) return undefined;
  const { family, weight } = fontOf(doc, next);
  return trackingMethod(family) === "generic" ? lookup(family, weight) : undefined;
}

/**
 * Inside a write, after the props landed on `node`: an auto node gets the letterSpacing its font and size call
 * for. An explicit letterSpacing in the same edit (an agent or a typed value) wins and turns auto off, unless
 * the same edit sets auto on in `metadata`: then auto is the explicit choice.
 * Returns the px written, or undefined when nothing changed.
 */
export function applyAutoTracking(doc: CanvasDoc, node: DocNode, props: Record<string, unknown>, metrics?: FontMetrics, remove: string[] = []): number | undefined {
  if (node.type !== "text" || !isAutoTracking(node)) return undefined;
  if ("letterSpacing" in props && !isAutoTracking(props as DocNode)) {
    const meta = autoMetadata(node.metadata, false);
    if (meta === null) delete node.metadata;
    else node.metadata = meta;
    return undefined;
  }
  if (!touches(props, remove)) return undefined;
  const { family, size } = fontOf(doc, node);
  if (size === undefined) return undefined;
  const { px } = autoTracking(family, size, metrics);
  if (node.letterSpacing === px) return undefined;
  node.letterSpacing = px;
  return px;
}
