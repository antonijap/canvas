// Variations in one keystroke: select a board or a layer, press Shift+Cmd+Return (or Cmd+K > Make 3 Variations, or the
// MCP's make_variations), and the person's own agent makes three variations side by side; she keeps one and the rest
// go in one undo step. The page half is src/page/variations.js; the harness is the talk-to-the-selection one
// (src/agent-run.ts: the person's own Claude Code, Codex when it cannot start, its environment, limits and process
// group), with skills, web search and Mobbin's read tools added for this run only.
//
// Quality comes from a context pack, not from the model's taste:
// 1. Her design system first: the file's variables, text styles and components, the colours and spacing it uses, and
//    pictures of the original and its two nearest boards (contextPack, packText).
// 2. A per-file product brief in the sidecar under `brief` (what the product is, who for, platform, tone). The first
//    run drafts one when there is none and saves it (set_product_brief); Cmd+K > Edit Product Brief edits it.
// 3. Real references: Mobbin's MCP when the person has it set up for her harness, else web search.
// 4. Her design skills, inlined from her skill folders (no-ai-design-slop, interfaces-that-feel, sf-typography or
//    inter-typography for the file's fonts), so they apply whichever harness runs; Claude Code also keeps skills on.
// 5. Three named directions tied to references ("Directions: Calmer: ... like Headspace's paywall | ...").
// 6. A quality gate (lintVariation): tokens only, the file's spacing scale, alignment, separators edge to edge, no grey
//    text on colour, single-line labels at line height 100% and no clipped glyphs. mark_variation refuses a copy
//    while it fails, twice; the third time it takes it as it is.
// 7. The server makes the three copies itself before the agent starts (under the run's MCP session, so the copies
//    and every edit the agent makes are one undo step). Keep deletes the other two, Discard all three: one undo step
//    each. Undo brings the captions back (reconcile).
// Sets live in the sidecar under `variations` (the last SETS_KEPT), so captions survive a reload.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { originOk } from "./bridge.ts";
import { displayPath } from "./docpath.ts";
import { findNode, resolveDocPath, type CanvasDoc, type DocNode } from "./engine.ts";
import { textStylesOf } from "./boards.ts";
import { buildCommand, childEnv, jsonBody, detectHarnesses, DENIED_TOOLS, fallBackTo, parseClaudeLine, parseCodexLine, pickHarness, StepTracker, OUTPUT_MAX, LINE_MAX, type AgentCtx, type HarnessInfo } from "./agent-run.ts";
import { finishAgent, onHistory, relabelTop } from "./history.ts";
import { listPages } from "./pages.ts";
import { currentDoc } from "./docwriter.ts";
import { agentSettings, runCapMs } from "./settings.ts";
import { placesChildren, type Rect, type StructureBody, type Who } from "./structure.ts";
import type { LayoutBody } from "./autolayout.ts";
import type { Harness } from "./threads.ts";
import { storeFor, storeForAsync } from "./widgets/store.ts";
import { docFileFor } from "./widgets.ts";
import { countUsage } from "./usage-counts.ts";

export const COUNT = 3;
export const GAP = 80;
/** Room under each copy for its caption (world units), kept free of other boards. */
export const CAPTION = 64;
export const BRIEF_MAX = 2000;
export const SETS_KEPT = 10;
/** mark_variation takes a copy that still fails the gate on this try. */
export const GATE_TRIES = 3;
/** Canvas MCP tools a variations run may not use: the talk run's list, minus mark_variation (its own). */
export const VARIATION_DENIED = DENIED_TOOLS.filter((t) => t !== "mark_variation");
/** The design skills a run inlines, when the person has them. Font skills only for the fonts the file uses. */
export const SKILLS = ["no-ai-design-slop", "interfaces-that-feel"];
const FONT_SKILLS: [RegExp, string][] = [[/^(SF Pro|San Francisco|New York|-apple-system|system-ui|ui-rounded)/i, "sf-typography"], [/^Inter\b/i, "inter-typography"]];

type Doc = { children: DocNode[]; variables?: Record<string, unknown> };
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const kids = (n: DocNode | undefined): DocNode[] => (Array.isArray(n?.children) ? (n!.children as DocNode[]) : []);

// ---------- the product brief ----------

export type Brief = { text: string; drafted: boolean; updatedAt: number };

export function cleanBrief(v: unknown): Brief | null {
  const b = v as Partial<Brief> | null;
  if (!b || typeof b !== "object" || typeof b.text !== "string" || !b.text.trim()) return null;
  return { text: b.text.trim().slice(0, BRIEF_MAX), drafted: b.drafted === true, updatedAt: num(b.updatedAt) ?? 0 };
}
/** The file's product brief, from its sidecar (widgets.json in a .canvas, or foo.widgets.json), or null. */
export async function readBrief(file: string): Promise<Brief | null> {
  const s = await storeForAsync(docFileFor(file));
  return cleanBrief(s.snapshot().extra.brief);
}
/** Save the brief (empty text removes it). Not an undo step: it is a note about the file, not the design. */
export async function writeBrief(file: string, text: string, drafted = false): Promise<Brief | null> {
  const docFile = docFileFor(file);
  await storeForAsync(docFile);
  const t = String(text ?? "").trim().slice(0, BRIEF_MAX);
  const brief = t ? { text: t, drafted, updatedAt: Date.now() } : null;
  await storeFor(docFile).mutateEnvelope((widgets, extra) => {
    const next = { ...extra };
    if (brief) next.brief = brief;
    else delete next.brief;
    return { widgets, extra: next };
  });
  return brief;
}

// ---------- where the copies go ----------

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where `n` copies of the board `o` go, side by side with `gap` between, each with CAPTION room under it, clear of
 * `others`: right of the original if that is free, else under it, else further right until free.
 */
export function placeRow(o: Rect, others: Rect[], n = COUNT, gap = GAP): { x: number; y: number }[] {
  const step = Math.max(1, o.w) + gap;
  const row = (x: number, y: number): Rect => ({ x, y, w: n * step - gap, h: o.h + CAPTION });
  const at = (x: number, y: number) => Array.from({ length: n }, (_, i) => ({ x: Math.round(x + i * step), y: Math.round(y) }));
  const free = (r: Rect) => !others.some((b) => overlaps(r, b));
  if (free(row(o.x + step, o.y))) return at(o.x + step, o.y);
  const below = o.y + o.h + CAPTION + gap;
  if (free(row(o.x, below))) return at(o.x, below);
  let x = o.x + step;
  for (let i = 0; i < 200 && !free(row(x, o.y)); i++) {
    const hit = others.filter((b) => overlaps(row(x, o.y), b));
    x = Math.max(x + step / 4, ...hit.map((b) => b.x + b.w + gap));
  }
  return at(x, o.y);
}

/** The child-index path from `root` to `id` (root itself: []), or null. Instance paths ("Ref/Child") use their first id. */
export function pathTo(root: DocNode, id: string): number[] | null {
  const want = id.split("/")[0];
  if (String(root.id) === want) return [];
  const list = kids(root);
  for (let i = 0; i < list.length; i++) {
    const p = pathTo(list[i], want);
    if (p) return [i, ...p];
  }
  return null;
}
/** The layer in `copy` at the place `id` has in `original` (an instance path keeps its tail), or null. */
export function mapInto(original: DocNode, copy: DocNode, id: string): string | null {
  const p = pathTo(original, id);
  if (!p) return null;
  let n: DocNode | undefined = copy;
  for (const i of p) n = kids(n)[i];
  if (!n) return null;
  const tail = id.split("/").slice(1);
  return [String(n.id), ...tail].join("/");
}

// ---------- the context pack ----------

export type Pack = {
  board: { id: string; name: string; w: number; h: number };
  layers: { id: string; name: string; type: string }[];
  variables: { name: string; type: string; value: string }[];
  textStyles: { props: Record<string, unknown>; count: number }[];
  components: { id: string; name: string; type: string }[];
  neighbours: { id: string; name: string }[];
  colours: string[];
  spacing: number[];
  fonts: string[];
  brief: Brief | null;
};

const HEX = /^#[0-9a-f]{3,8}$/i;
const nameOf = (n: DocNode) => (typeof n.name === "string" && n.name ? n.name : typeof n.content === "string" ? String(n.content).slice(0, 40) : String(n.type));
function walkNodes(list: DocNode[], f: (n: DocNode, parent: DocNode | null) => void, parent: DocNode | null = null) {
  for (const n of list) {
    if (!n || typeof n !== "object") continue;
    f(n, parent);
    walkNodes(kids(n), f, n);
  }
}
/** Every colour string (#hex or $variable) a value holds: a fill, a stroke, an effect, a list of them. */
export function coloursIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    if (HEX.test(v) || v.startsWith("$")) out.push(v);
  } else if (Array.isArray(v)) for (const x of v) coloursIn(x, out);
  else if (v && typeof v === "object") for (const k of ["color", "fill", "colors", "stops"]) if (k in (v as object)) coloursIn((v as Record<string, unknown>)[k], out);
  return out;
}
const paintOf = (n: DocNode): string[] => [...coloursIn(n.fill), ...coloursIn(n.stroke), ...coloursIn(n.effect)];
const spacingOf = (n: DocNode): number[] => {
  const out: number[] = [];
  if (num(n.gap) !== undefined) out.push(n.gap as number);
  const p = n.padding;
  if (num(p) !== undefined) out.push(p as number);
  else if (Array.isArray(p)) for (const x of p) if (num(x) !== undefined) out.push(x as number);
  return out;
};
/** A variable's value in the default theme (aliases followed), as a string. */
export function varValue(doc: Doc, name: string, depth = 0): string | undefined {
  const def = (doc.variables ?? {})[name.replace(/^\$/, "")] as { value?: unknown } | undefined;
  let v: unknown = def?.value;
  if (Array.isArray(v)) v = (v.find((x: any) => !x?.theme || Object.keys(x.theme).length === 0) ?? v[0])?.value;
  if (typeof v === "string" && v.startsWith("$") && depth < 8) return varValue(doc, v, depth + 1);
  return v === undefined ? undefined : String(v);
}
function describeVar(name: string, def: any): { name: string; type: string; value: string } {
  const v = def?.value;
  const value = Array.isArray(v) ? v.map((x: any) => `${x?.value}${x?.theme ? ` (${Object.values(x.theme).join(", ")})` : ""}`).join(", ") : String(v);
  return { name, type: String(def?.type ?? typeof v), value };
}

/** What a set's copies are, so the file's colours and spacing are counted without them. */
type Skip = Set<string>;

/** The literal colours and the spacing values the file uses (outside `skip`), most used first. */
export function fileTokens(doc: Doc, skip: Skip = new Set()): { colours: string[]; spacing: number[] } {
  const colours = new Map<string, number>(), spacing = new Map<number, number>();
  for (const top of doc.children) {
    if (skip.has(String(top.id))) continue;
    walkNodes([top], (n) => {
      for (const c of paintOf(n)) if (HEX.test(c)) colours.set(c.toUpperCase(), (colours.get(c.toUpperCase()) ?? 0) + 1);
      for (const s of spacingOf(n)) spacing.set(s, (spacing.get(s) ?? 0) + 1);
    });
  }
  return { colours: [...colours.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c), spacing: [...spacing.keys()].sort((a, b) => a - b) };
}

/**
 * Everything a variations run should know before it designs: the file's design system (variables, text styles as
 * used, components, colours and spacing), the selection, its nearest boards on the page and the product brief.
 * `pageBoards`: the top-level ids on the selection's page (neighbours come from those).
 */
export function contextPack(doc: Doc, ids: string[], o: { brief?: Brief | null; pageBoards?: string[]; skip?: Skip } = {}): Pack {
  const first = findNode(doc as CanvasDoc, ids[0]);
  const board = (first.ancestors[0] ?? first.node) as DocNode;
  const bid = String(board.id);
  const skip = o.skip ?? new Set<string>();
  const tops = new Map(doc.children.map((n) => [String(n.id), n]));
  const box = (n: DocNode) => ({ x: num(n.x) ?? 0, y: num(n.y) ?? 0, w: num(n.width) ?? 0, h: num(n.height) ?? 0 });
  const b = box(board);
  const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const c0 = centre(b);
  const neighbours = (o.pageBoards ?? [...tops.keys()])
    .filter((id) => id !== bid && !skip.has(id) && tops.has(id) && tops.get(id)!.enabled !== false && tops.get(id)!.reusable !== true && (tops.get(id)!.type === "frame" || tops.get(id)!.type === "ref"))
    .map((id) => ({ id, d: Math.hypot(centre(box(tops.get(id)!)).x - c0.x, centre(box(tops.get(id)!)).y - c0.y) }))
    .sort((a, b2) => a.d - b2.d).slice(0, 3)
    .map(({ id }) => ({ id, name: nameOf(tops.get(id)!) }));
  const fonts = new Set<string>();
  walkNodes(doc.children, (n) => { if (n.type === "text") fonts.add(String(n.fontFamily ?? "Inter")); });
  const t = fileTokens(doc, skip);
  return {
    board: { id: bid, name: nameOf(board), w: b.w, h: b.h },
    layers: ids.map((id) => {
      try {
        const n = findNode(doc as CanvasDoc, id).node;
        return { id, name: nameOf(n), type: String(n.type) };
      } catch {
        return null;
      }
    }).filter((x): x is { id: string; name: string; type: string } => !!x),
    variables: Object.entries(doc.variables ?? {}).map(([k, v]) => describeVar(k, v)),
    textStyles: textStylesOf(doc as CanvasDoc).slice(0, 12).map((s) => ({ props: Object.fromEntries(Object.entries(s.props).filter(([, v]) => v !== undefined)), count: s.count })),
    components: walkComponents(doc).slice(0, 40),
    neighbours,
    colours: t.colours.slice(0, 24),
    spacing: t.spacing,
    fonts: [...fonts],
    brief: o.brief ?? null,
  };
}
function walkComponents(doc: Doc): { id: string; name: string; type: string }[] {
  const out: { id: string; name: string; type: string }[] = [];
  walkNodes(doc.children, (n) => { if (n.reusable === true) out.push({ id: String(n.id), name: nameOf(n), type: String(n.type) }); });
  return out;
}

/** The pack as prompt text. */
export function packText(p: Pack): string {
  const list = <T>(xs: T[], f: (x: T) => string, none: string) => (xs.length ? xs.map((x) => `- ${f(x)}`).join("\n") : `- ${none}`);
  return [
    `Variables (use them as $name for every colour and number they cover):`,
    list(p.variables, (v) => `$${v.name} (${v.type}): ${v.value}`, "none: use the colours and spacing below"),
    `Text styles as the file uses them (family, size, weight, line height, letter spacing), most used first:`,
    list(p.textStyles, (s) => `${JSON.stringify(s.props)} used ${s.count}x`, "none"),
    `Components (reuse with {"type":"ref","ref":"<id>"}):`,
    list(p.components, (c) => `${c.name} (id ${c.id}, ${c.type})`, "none"),
    `Literal colours already in the file: ${p.colours.join(", ") || "none"}`,
    `Spacing values the file uses (gap, padding): ${p.spacing.join(", ") || "none"}`,
    `Fonts in use: ${p.fonts.join(", ") || "none"}`,
    `Neighbouring boards (their pictures follow the original's): ${p.neighbours.map((n) => `${n.name} (id ${n.id})`).join(", ") || "none"}`,
  ].join("\n");
}

// ---------- the quality gate ----------

export type Issue = { id: string; name: string; rule: "tokens" | "spacing" | "alignment" | "separator" | "contrast" | "line-height" | "clipped" | "copy"; message: string };

function rgbOf(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "");
  const full = h.length === 3 || h.length === 4 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6 && full.length !== 8) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}
/** Hue-free facts: saturation and lightness (HSL). */
export function satLight(hex: string): { s: number; l: number } | null {
  const c = rgbOf(hex);
  if (!c) return null;
  const mx = Math.max(...c), mn = Math.min(...c), l = (mx + mn) / 2;
  const s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
  return { s, l };
}
const resolveColour = (doc: Doc, c: string): string | undefined => (c.startsWith("$") ? varValue(doc, c) : c);
const solidFill = (doc: Doc, n: DocNode): string | undefined => {
  const f = n.fill;
  const first = typeof f === "string" ? f : Array.isArray(f) ? f.find((x) => typeof x === "string" || (x && typeof x === "object" && (x as any).type === "color" && (x as any).enabled !== false)) : f && typeof f === "object" && (f as any).type === "color" ? f : undefined;
  const raw = typeof first === "string" ? first : (first as any)?.color;
  const v = typeof raw === "string" ? resolveColour(doc, raw) : undefined;
  return v && HEX.test(v) ? v : undefined;
};

export type GateRules = { colours: Set<string>; spacing: Set<number>; varByValue: Map<string, string>; hasColourVars: boolean };

/** The rules a variation is held to, from the file outside the set's copies (`skip`). */
export function gateRules(doc: Doc, skip: Skip = new Set()): GateRules {
  const t = fileTokens(doc, skip);
  const spacing = new Set<number>([0, ...t.spacing]);
  const varByValue = new Map<string, string>();
  let hasColourVars = false;
  for (const [k, def] of Object.entries(doc.variables ?? {})) {
    const v = varValue(doc, k);
    if ((def as any)?.type === "color") hasColourVars = true;
    if (v === undefined) continue;
    if (HEX.test(v)) varByValue.set(v.toUpperCase(), k);
    else if (num(Number(v)) !== undefined && (def as any)?.type === "number") spacing.add(Number(v));
  }
  // A file on a 4 pt grid allows every step of it.
  const fours = t.spacing.filter((x) => x % 4 === 0).length;
  if (!t.spacing.length || fours / t.spacing.length >= 0.8) for (let i = 0; i <= 160; i += 4) spacing.add(i);
  return { colours: new Set(t.colours), spacing, varByValue, hasColourVars };
}

const isSeparator = (n: DocNode) => (n.type === "rectangle" || n.type === "line" || (n.type === "frame" && !kids(n).length))
  && ((num(n.height) !== undefined && (n.height as number) <= 2 && (n.width === "fill_container" || (num(n.width) ?? 0) >= 4 * Math.max(1, n.height as number)))
    || /divider|separator|hairline|rule\b/i.test(String(n.name ?? "")));
const singleLine = (n: DocNode) => n.type === "text" && typeof n.content === "string" && !n.content.includes("\n") && (n.textGrowth === undefined || n.textGrowth === "auto");
const hPad = (p: unknown): number => (num(p) !== undefined ? (p as number) : Array.isArray(p) ? (p.length === 2 ? num(p[1]) ?? 0 : Math.max(num(p[1]) ?? 0, num(p[3]) ?? 0)) : 0);

/**
 * The quality gate: what in the layer `rootId` (and inside it) breaks the person's rules. Static checks on the
 * stored layers, so they run without a page: the agent also looks at a render for what only a picture shows.
 */
export function lintVariation(doc: Doc, rootId: string, rules: GateRules, max = 40): Issue[] {
  const root = findNode(doc as CanvasDoc, rootId);
  const out: Issue[] = [];
  const add = (n: DocNode, rule: Issue["rule"], message: string) => { if (out.length < max) out.push({ id: String(n.id), name: nameOf(n), rule, message }); };
  // The ancestors' fills, for text on colour.
  const chain: DocNode[] = [...root.ancestors] as DocNode[];
  const visit = (n: DocNode, parent: DocNode | null) => {
    // Tokens: no invented colours; a literal that is a variable's value uses the variable.
    for (const c of paintOf(n)) {
      if (!HEX.test(c)) continue;
      const up = c.toUpperCase();
      const v = rules.varByValue.get(up);
      if (v) add(n, "tokens", `${c} is the value of $${v}: use $${v}`);
      else if (!rules.colours.has(up) && (rules.hasColourVars || rules.colours.size)) add(n, "tokens", `${c} is not in the file's colours or variables: use a $variable or a colour the file already uses`);
    }
    // Spacing on the file's scale.
    for (const s of spacingOf(n)) if (!rules.spacing.has(s)) add(n, "spacing", `spacing ${s} is off the file's scale (${[...rules.spacing].filter((x) => x <= 64).sort((a, b) => a - b).join(", ")})`);
    // Separators edge to edge: pad the sections, not the divider's parent.
    if (parent && isSeparator(n)) {
      if (placesChildren(parent) && parent.layout === "vertical" && hPad(parent.padding) > 0) add(n, "separator", `the divider sits inside ${hPad(parent.padding)} px of side padding: set the parent's horizontal padding to 0, make the divider fill_container and pad the sections instead`);
      else if (!placesChildren(parent) && num(n.width) !== undefined && num(parent.width) !== undefined && ((num(n.x) ?? 0) > 0 || (n.width as number) < (parent.width as number))) add(n, "separator", `the divider does not span its parent (x ${num(n.x) ?? 0}, width ${n.width} of ${parent.width}): make it edge to edge`);
    }
    // Copy: no middots as separators and no em or en dashes (the maintainer's writing rules).
    if (n.type === "text" && typeof n.content === "string") {
      if (n.content.includes("\u00B7")) add(n, "copy", `"${n.content.slice(0, 40)}" uses a middot (\u00B7) as a separator: use a comma, or put the parts in separate labels`);
      if (/[\u2014\u2013]/.test(n.content)) add(n, "copy", `"${n.content.slice(0, 40)}" uses a dash: end the sentence or use a comma`);
    }
    if (n.type === "text") {
      const lh = num(n.lineHeight);
      if (singleLine(n) && lh !== 1) add(n, "line-height", `one-line label with line height ${lh === undefined ? "auto" : `${Math.round(lh * 100)}%`}: set lineHeight 1 (100%)`);
      if (lh !== undefined && lh < 1) add(n, "clipped", `line height ${Math.round(lh * 100)}% clips ascenders and descenders: use 1 or more`);
      const fs2 = num(n.fontSize) ?? 14;
      if (n.textGrowth === "fixed-width-height" && num(n.height) !== undefined && (n.height as number) < fs2 * Math.max(1, lh ?? 1.2) - 0.5) add(n, "clipped", `fixed height ${n.height} is shorter than one line (${Math.round(fs2 * Math.max(1, lh ?? 1.2))}): glyphs are clipped`);
      // Grey text on a coloured background: secondary text takes the tint's hue, darker.
      const tc = solidFill(doc, n), tsl = tc && satLight(tc);
      const bg = [...chain, ...(parent ? [] : [])].reverse().map((a) => solidFill(doc, a)).find(Boolean);
      const bsl = bg && satLight(bg);
      if (tsl && bsl && tsl.s < 0.12 && tsl.l > 0.2 && tsl.l < 0.8 && bsl.s > 0.3 && bsl.l > 0.15 && bsl.l < 0.92) add(n, "contrast", `grey text ${tc} on the coloured background ${bg}: use a darker shade of the background's hue`);
    }
    // Alignment: absolutely placed siblings whose left edges nearly line up (off by 1 to 3 px).
    if (kids(n).length > 1 && !placesChildren(n)) {
      const xs = kids(n).map((c) => ({ c, x: num(c.x) })).filter((v): v is { c: DocNode; x: number } => v.x !== undefined);
      for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
        const d = Math.abs(xs[i].x - xs[j].x);
        if (d > 0 && d <= 3) add(xs[j].c, "alignment", `left edge ${xs[j].x} is ${d} px off ${nameOf(xs[i].c)} (${xs[i].x}): align them`);
      }
    }
    chain.push(n);
    for (const c of kids(n)) visit(c, n);
    chain.pop();
  };
  visit(root.node as DocNode, (root.ancestors.at(-1) as DocNode | undefined) ?? null);
  return out;
}

// ---------- the directions ----------

const DIR_RE = /^\s*\**\s*Directions\s*\**\s*:\s*(.+)$/im;
const tidy = (s: string, max: number) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*/g, "").replace(/\s*·\s*/g, ", ").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, max);
/** "Directions: Calmer: fewer elements, like Headspace | Denser: ... | Bolder: ..." as {name, why}. */
export function parseDirections(text: string): { name: string; why: string }[] | null {
  const m = DIR_RE.exec(text);
  if (!m) return null;
  const out = m[1].split("|").map((s) => {
    const [name, ...rest] = s.split(":");
    return { name: tidy(name, 40), why: tidy(rest.join(":"), 160) };
  }).filter((d) => d.name);
  return out.length ? out.slice(0, COUNT) : null;
}

// ---------- skills and references ----------

const owned = (p: string) => {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.uid === (process.getuid?.() ?? -1) && !(st.mode & 0o022) && st.size < 200_000;
  } catch {
    return false;
  }
};
export const skillDirs = (home = os.homedir()) => (process.env.CANVAS_SKILL_DIRS ? process.env.CANVAS_SKILL_DIRS.split(":") : [path.join(home, ".claude", "skills"), path.join(home, ".agents", "skills"), path.join(home, ".codex", "skills")]);
/** The skills that apply to a file: the design ones, plus the type skill for each font family it sets. */
export function skillsFor(fonts: string[]): string[] {
  const out = [...SKILLS];
  for (const [re, name] of FONT_SKILLS) if (fonts.some((f) => re.test(f)) && !out.includes(name)) out.push(name);
  return out;
}
/** Each skill's SKILL.md (frontmatter cut, at most 7000 characters) from the person's skill folders, when it is hers. */
export function readSkills(names: string[], dirs = skillDirs()): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const name of names) {
    for (const d of dirs) {
      let real: string;
      try {
        real = fs.realpathSync(path.join(d, name, "SKILL.md"));
      } catch {
        continue;
      }
      if (!owned(real)) continue;
      const text = fs.readFileSync(real, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim().slice(0, 7000);
      if (text) out.push({ name, text });
      break;
    }
  }
  return out;
}

/** Mobbin's MCP, as the person set it up for this harness (its URL), or undefined. */
export function mobbinFor(harness: Harness, home = os.homedir()): string | undefined {
  const ok = (u: unknown) => typeof u === "string" && /^https:\/\/([\w-]+\.)*mobbin\.com\/mcp\/?$/.test(u) ? u : undefined;
  try {
    if (harness === "claude") {
      const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
      return ok(j?.mcpServers?.mobbin?.url);
    }
    const t = fs.readFileSync(path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml"), "utf8");
    const m = /\[mcp_servers\.mobbin\][^[]*?url\s*=\s*"([^"]+)"/.exec(t);
    return ok(m?.[1]);
  } catch {
    return undefined;
  }
}

// ---------- the prompt ----------

export type PromptIn = {
  file: string; pack: Pack; original: { id: string; name: string }; layers: { id: string; name: string }[];
  copies: { id: string; layers: string[] }[]; pictures: number; mobbin: boolean; skills: { name: string; text: string }[];
};

export function buildVariationsPrompt(p: PromptIn): string {
  const isBoard = !p.layers.length;
  const what = isBoard ? `the board "${p.original.name}" (id ${p.original.id})` : `${p.layers.map((l) => `the layer "${l.name}" (id ${l.id})`).join(", ")} on the board "${p.original.name}" (id ${p.original.id})`;
  const copies = p.copies.map((c, i) => `- Copy ${i + 1}: board ${c.id}${isBoard ? "" : `, where the selection is ${c.layers.join(", ")}`}`).join("\n");
  const scope = isBoard ? "the copy board and everything in it" : "that copy's version of the selected layers and what is inside them (leave the rest of the copy board as it is)";
  const brief = p.pack.brief
    ? `Product brief (the person's, follow it):\n${p.pack.brief.text}`
    : `There is no product brief yet. Before anything else, draft one from what the file shows: four short lines (Product: ..., For: ..., Platform: ..., Tone: ...). Save it with set_product_brief, then follow it.`;
  const refs = p.mobbin
    ? `Use the Mobbin tools (search_screens, search_flows) to find 6 to 10 real screens of shipped apps for this pattern. If Mobbin fails, use web search.`
    : `Use web search to find 6 to 10 real screens of shipped apps and close competitors for this pattern. If search is not available, use apps you know well and say so.`;
  return [
    `You are making ${COUNT} design variations in Canvas, a design tool, for the person using it. You have the Canvas MCP tools (mcp__canvas__*), and web search${p.mobbin ? " and Mobbin" : ""} for references. Nobody can answer questions during the run: decide and go on.`,
    `File: ${p.file} (pass it as "file" to every tool that takes one).`,
    `The selection: ${what}.`,
    p.pictures ? `Pictures attached: the original first${p.pictures > 1 ? `, then its ${p.pictures - 1} nearest boards (the rest of the product)` : ""}.` : `Look at the original with render_node before you start.`,
    ``,
    `${COUNT} copies of the board already sit beside the original, one per direction. Change only ${scope}, never the original or any other board:`,
    copies,
    ``,
    `The file's design system. Variations use it and nothing else: no invented colours, fonts or sizes.`,
    packText(p.pack),
    ``,
    brief,
    ``,
    ...(p.skills.length ? [`The person's design skills. Follow them:`, ...p.skills.map((s) => `<skill name="${s.name}">\n${s.text}\n</skill>`), ``] : []),
    `How to work:`,
    `1. Read the original with inspect_node (depth 6) and understand what it is for.`,
    `2. References: ${refs}`,
    `3. Write one line: "Directions: <name>: <the one idea it changes, and the reference it follows, like Headspace's paywall> | <name>: ... | <name>: ...". Three directions that differ in one clear idea each (for example calmer, denser, a bolder hierarchy), each tied to a reference you found. Names are one or two words.`,
    `4. For copy n, build direction n with set_node_props, add_nodes, delete_nodes, place_nodes and add_auto_layout. Rename the copy board to "${p.original.name} (<direction name>)". Colours and numbers as $variables where the file has them; text in the file's text styles; its components as {"type":"ref"} instances.`,
    `5. Quality gate, for each copy before you show it: call check_variation on the copy board and fix every issue it lists; look at it with render_node and fix what looks off (spacing, alignment, clipped text, overflow). Then call mark_variation with the copy board's id, the direction's name, one line on why, and the references (app names). mark_variation runs the gate again and refuses while issues remain.`,
    `6. When all ${COUNT} are marked, call finish_work once, then end with one line: "Summary: <under 120 characters>".`,
    ``,
    `Her rules, which the gate checks: spacing on the file's scale; tokens only; aligned edges; dividers span their container edge to edge (pad the sections, not the divider's parent); secondary text on a tinted background uses that tint's hue, darker, never grey; one-line labels have line height 100% (lineHeight 1); no clipped glyphs; separation by layered shadows rather than borders; controls in a row share one height.`,
  ].join("\n");
}

// ---------- sets ----------

export type Copy = { id: string; layers: string[]; done: boolean; direction?: string; why?: string; refs?: string[]; issues?: number; tries?: number };
export type SetStatus = "making" | "review" | "kept" | "discarded" | "failed" | "gone";
export type VarSet = {
  id: string; file: string; original: string; name: string; layers: string[]; copies: Copy[]; status: SetStatus; harness: Harness;
  session: string; startedAt: number; endedAt?: number; kept?: string; directions?: { name: string; why: string }[]; note?: string; error?: string;
};

const SET_STATUS = new Set(["making", "review", "kept", "discarded", "failed", "gone"]);
const strs = (v: unknown, n: number, max = 200) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, n).map((x) => x.slice(0, max)) : []);
export function cleanSets(v: unknown): VarSet[] {
  if (!Array.isArray(v)) return [];
  const out: VarSet[] = [];
  for (const s of v as any[]) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || typeof s.original !== "string" || !Array.isArray(s.copies)) continue;
    const copies: Copy[] = s.copies.filter((c: any) => c && typeof c.id === "string").slice(0, COUNT).map((c: any) => ({
      id: c.id, layers: strs(c.layers, 50), done: c.done === true,
      ...(typeof c.direction === "string" ? { direction: c.direction.slice(0, 40) } : {}), ...(typeof c.why === "string" ? { why: c.why.slice(0, 200) } : {}),
      ...(Array.isArray(c.refs) ? { refs: strs(c.refs, 10, 80) } : {}), ...(num(c.issues) !== undefined ? { issues: c.issues } : {}),
    }));
    out.push({
      id: s.id.slice(0, 40), file: String(s.file ?? ""), original: s.original, name: String(s.name ?? s.original).slice(0, 200), layers: strs(s.layers, 50), copies,
      // A set still making in the file was cut off (the server quit): what it made is up for review.
      status: SET_STATUS.has(s.status) ? (s.status === "making" ? "review" : s.status) : "review",
      harness: s.harness === "codex" ? "codex" : "claude", session: String(s.session ?? ""), startedAt: num(s.startedAt) ?? 0,
      ...(num(s.endedAt) !== undefined ? { endedAt: s.endedAt } : {}), ...(typeof s.kept === "string" ? { kept: s.kept } : {}),
      ...(Array.isArray(s.directions) ? { directions: s.directions.filter((d: any) => d && typeof d.name === "string").slice(0, COUNT).map((d: any) => ({ name: String(d.name).slice(0, 40), why: String(d.why ?? "").slice(0, 160) })) } : {}),
      ...(typeof s.note === "string" ? { note: s.note.slice(0, 300) } : {}), ...(typeof s.error === "string" ? { error: s.error.slice(0, 300) } : {}),
    });
  }
  return out.slice(-SETS_KEPT);
}

/**
 * A set after the document changed under it (an undo, a redo): its status follows which copies exist. Pure.
 * Undoing a Keep or a Discard (all copies back) reviews again; undoing the run (no copies) ends it; redoing a Keep
 * (only the kept one) is kept again.
 */
export function reconcile(s: VarSet, exists: (id: string) => boolean): VarSet {
  if (s.status === "making" || s.status === "failed") return s;
  const here = s.copies.filter((c) => exists(c.id));
  if (here.length === s.copies.length && (s.status === "kept" || s.status === "discarded" || s.status === "gone")) return { ...s, status: "review", kept: undefined };
  if (s.status === "review" && !here.length) return { ...s, status: s.kept ? "kept" : "gone" };
  if (s.status === "review" && here.length === 1 && s.copies.length > 1) return { ...s, status: "kept", kept: here[0].id };
  return s;
}

/**
 * A Keep of a set made on a layer inside a board of several screens (a row of phones, say): the kept copy's screen
 * takes the original screen's place, so the board does not end up duplicated. The screen is the highest ancestor of
 * the varied layer that sits among two or more screen-sized frames (200 x 200 or more). Null when there is no such
 * screen (the board itself is the screen: the kept copy stays beside the original), or a layer is missing.
 */
export function layerSwap(doc: Doc, s: VarSet, keep: string): { pairs: { original: string; copy: string; parent: string; index: number; at: { x: number; y: number } | null }[] } | null {
  if (!s.layers.length) return null;
  const board = doc.children.find((n) => String(n.id) === s.original);
  const copy = doc.children.find((n) => String(n.id) === keep);
  if (!board || !copy) return null;
  const screenSized = (n: DocNode) => (n.type === "frame" || n.type === "group") && (num(n.width) ?? 0) >= 200 && (num(n.height) ?? 0) >= 200;
  const units = new Map<string, { parent: DocNode; index: number; node: DocNode }>();
  for (const id of s.layers) {
    if (id.includes("/")) return null;
    const path = pathTo(board as DocNode, id);
    if (!path || !path.length) return null;
    // Walk down from the board; the first level where the node sits among 2+ screen-sized frames is the screen.
    let parent = board as DocNode, unit: { parent: DocNode; index: number; node: DocNode } | null = null;
    for (const i of path) {
      const kids = (parent.children ?? []) as DocNode[];
      const node = kids[i];
      if (screenSized(node) && kids.filter(screenSized).length >= 2) { unit = { parent, index: i, node }; break; }
      parent = node;
    }
    if (!unit) return null;
    units.set(String(unit.node.id), unit);
  }
  const pairs = [];
  for (const [id, u] of units) {
    const cid = mapInto(board as DocNode, copy as DocNode, id);
    if (!cid) return null;
    const x = num(u.node.x), y = num(u.node.y);
    pairs.push({ original: id, copy: cid, parent: String(u.parent.id), index: u.index, at: !placesChildren(u.parent) && x !== undefined && y !== undefined ? { x, y } : null });
  }
  return { pairs };
}

/** Which copies a Keep deletes: every copy but the one kept that is still in the document. */
export function keepPlan(s: VarSet, keep: string, exists: (id: string) => boolean): string[] {
  if (!s.copies.some((c) => c.id === keep)) throw new VarError(404, "not_found", "That board is not one of these variations");
  return s.copies.filter((c) => c.id !== keep && exists(c.id)).map((c) => c.id);
}

export async function readSets(file: string): Promise<VarSet[]> {
  const s = await storeForAsync(docFileFor(file));
  return cleanSets(s.snapshot().extra.variations);
}
function setsNow(file: string): VarSet[] {
  try {
    return cleanSets(storeFor(docFileFor(file)).snapshot().extra.variations);
  } catch {
    return [];
  }
}
/** Store a set (replacing the one with its id). Not an undo step. */
export async function saveSet(file: string, set: VarSet): Promise<VarSet[]> {
  const docFile = docFileFor(file);
  await storeForAsync(docFile);
  const { state } = await storeFor(docFile).mutateEnvelope((widgets, extra) => {
    const list = cleanSets(extra.variations).filter((x) => x.id !== set.id);
    list.push(set);
    return { widgets, extra: { ...extra, variations: list.slice(-SETS_KEPT) } };
  });
  return cleanSets(state.extra.variations);
}

export class VarError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- runs ----------

export type VarCtx = AgentCtx & {
  /** One structure op, the way the structure route runs it: written, open pages told, new boards kept on their page. */
  structure(file: string, body: StructureBody, who: Who): Promise<{ select: string[]; revision?: string }>;
  /** One layout op (place), the way the layout route runs it. Keep uses it to put a varied layer back. */
  layout?(file: string, body: LayoutBody, who: Who): Promise<{ select: string[]; revision?: string }>;
  /** Drawn world boxes of top-level boards, from the page showing the file (none when no page shows it). */
  measure?(file: string, ids: string[]): Promise<Record<string, Rect>>;
};

type Active = {
  set: VarSet; docFile: string; child: ChildProcess | null; tracker: StepTracker; harness: HarnessInfo; dir: string;
  stopReason: "stop" | "timeout" | "output" | "discard" | null; timer?: NodeJS.Timeout; prompt: string; images: string[]; mobbin?: string;
};
const active = new Map<string, Active>();
const listeners = new Map<string, Set<http.ServerResponse>>();
const keyOf = (file: string) => {
  try {
    return displayPath(resolveDocPath(file));
  } catch {
    return file;
  }
};
function broadcast(file: string, msg: unknown) {
  const set = listeners.get(keyOf(file));
  if (!set) return;
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of set) {
    try {
      res.write(data);
    } catch {}
  }
}
async function publish(set: VarSet) {
  await saveSet(set.file, set).catch(() => {});
  broadcast(set.file, { type: "set", set });
}
const logFile = () => process.env.CANVAS_AGENT_LOG ?? path.join(os.homedir(), "Library", "Logs", "Canvas", "agent-runs.log");
function logSet(s: VarSet, extra: string) {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), `${new Date().toISOString()} variations=${s.id} harness=${s.harness} file=${path.basename(s.file)} ${extra}\n`);
  } catch {}
}
export const activeSets = (file?: string): VarSet[] => [...active.values()].filter((a) => !file || keyOf(a.set.file) === keyOf(file)).map((a) => a.set);

const boxOfTop = (n: DocNode, rect?: Rect): Rect => ({ x: num(n.x) ?? rect?.x ?? 0, y: num(n.y) ?? rect?.y ?? 0, w: num(n.width) ?? rect?.w ?? 400, h: num(n.height) ?? rect?.h ?? 400 });
function pageBoardsOf(file: string, ctx: AgentCtx, board: string): string[] | undefined {
  try {
    const d = ctx.docOf(file);
    return listPages(file, () => (d ? d.boards.map((b) => b.id) : [])).pages.find((p) => p.boards.includes(board))?.boards;
  } catch {
    return undefined;
  }
}

export type MakeInput = { file: string; ids: string[]; harness?: Harness; rects?: Record<string, Rect> };

/** Start a set: the copies first (one undo step with what the agent then does), then the agent. */
export async function makeVariations(ctx: VarCtx, inp: MakeInput): Promise<VarSet> {
  const file = keyOf(inp.file);
  const docFile = resolveDocPath(file);
  const ids = (inp.ids ?? []).filter((x) => typeof x === "string" && x && !x.startsWith("widget:")).slice(0, 50);
  if (!ids.length) throw new VarError(400, "invalid", "Select a board or a layer first");
  if (activeSets(file).length) throw new VarError(409, "busy", "Variations are being made in this file already; wait or press Esc");
  const doc = currentDoc(docFile).doc as unknown as Doc;
  let hit;
  try {
    hit = findNode(doc as CanvasDoc, ids[0]);
  } catch {
    throw new VarError(404, "not_found", "The selection is not in the file any more");
  }
  const board = (hit.ancestors[0] ?? hit.node) as DocNode;
  const bid = String(board.id);
  const layers = ids.filter((id) => id !== bid && (() => { try { return String((findNode(doc as CanvasDoc, id).ancestors[0] ?? {}).id) === bid; } catch { return false; } })());
  const harness = pickHarness(detectHarnesses(), inp.harness, agentSettings().harness);
  if (!harness) throw new VarError(400, "unsupported", "Neither Claude Code nor Codex is installed (looked on PATH and in ~/.local/bin)");

  const id = randomBytes(6).toString("hex");
  const session = `run-${id}`;
  const who: Who = { source: "mcp", session };
  // The copies, beside the original. A board that hugs its content has no width or height in the file: its drawn
  // box comes from the caller (the page sends rects) or from the page itself; without it copies landed on top of
  // each other.
  let rects = inp.rects ?? {};
  const unsized = doc.children.filter((n) => (num(n.width) === undefined || num(n.height) === undefined) && !rects[String(n.id)]).map((n) => String(n.id));
  if (unsized.length && ctx.measure) rects = { ...(await ctx.measure(file, unsized).catch(() => ({}))), ...rects };
  const orig = boxOfTop(board, rects[bid]);
  const others = doc.children.filter((n) => String(n.id) !== bid && n.enabled !== false).map((n) => boxOfTop(n, rects[String(n.id)]));
  const spots = placeRow(orig, others);
  const copies: Copy[] = [];
  for (const s of spots) {
    const r = await ctx.structure(file, { file, op: "duplicate", ids: [bid], offset: { dx: s.x - orig.x, dy: s.y - orig.y }, round: true }, who);
    const cid = r.select[0];
    const now = currentDoc(docFile).doc as unknown as Doc;
    const copy = now.children.find((n) => String(n.id) === cid);
    copies.push({ id: cid, layers: copy ? layers.map((l) => mapInto(board, copy, l)).filter((x): x is string => !!x) : [], done: false });
  }
  const set: VarSet = { id, file, original: bid, name: nameOf(board), layers, copies, status: "making", harness: harness.id, session, startedAt: Date.now() };
  const dir = path.join(os.tmpdir(), "canvas-agent", `var-${id}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const a: Active = { set, docFile, child: null, tracker: new StepTracker(), harness, dir, stopReason: null, prompt: "", images: [] };
  active.set(id, a);
  await publish(set);
  logSet(set, `status=start layers=${layers.length}`);

  void (async () => {
    const brief = await readBrief(file).catch(() => null);
    const skip = new Set(copies.map((c) => c.id));
    const pack = contextPack(currentDoc(docFile).doc as unknown as Doc, layers.length ? layers : [bid], { brief, pageBoards: pageBoardsOf(file, ctx, bid), skip });
    // Pictures: the original, then up to two neighbours, made side by side.
    const shots = ctx.render ? await Promise.all([bid, ...pack.neighbours.slice(0, 2).map((n) => n.id)].map((b, i) => ctx.render!(file, b, path.join(dir, `pic-${i}.png`)).catch(() => null))) : [];
    a.images = shots.filter((x): x is string => !!x);
    a.prompt = buildVariationsPrompt({
      file: docFile, pack, original: { id: bid, name: nameOf(board) }, layers: pack.layers.filter((l) => l.id !== bid),
      copies, pictures: a.images.length, mobbin: false, skills: readSkills(skillsFor(pack.fonts)),
    });
    if (a.stopReason) return end(ctx, a, null);
    launch(ctx, a);
  })().catch((e) => {
    a.tracker.error = (e as Error).message;
    void end(ctx, a, null);
  });
  return set;
}

function launch(ctx: VarCtx, a: Active) {
  const h = a.harness;
  a.set.harness = h.id;
  a.mobbin = mobbinFor(h.id);
  const prompt = a.mobbin ? a.prompt.replace(/use web search to find 6 to 10[^\n]*/i, "Use the Mobbin tools (search_screens, search_flows) to find 6 to 10 real screens of shipped apps for this pattern. If Mobbin fails, use web search.") : a.prompt;
  const mcpConfigPath = path.join(a.dir, "mcp.json");
  const c = buildCommand({
    harness: h, choice: agentSettings()[h.id], mcpSession: a.set.session, session: h.id === "claude" ? randomUUID() : undefined, resume: false, mcpConfigPath,
    image: a.images[0], images: a.images.slice(1), node: process.execPath, port: ctx.port(), serverVersion: ctx.version(),
    wide: { deny: VARIATION_DENIED, ...(a.mobbin ? { mobbin: a.mobbin } : {}) },
  });
  if (c.mcpConfig) fs.writeFileSync(mcpConfigPath, c.mcpConfig, { mode: 0o600 });
  const cwd = path.join(os.tmpdir(), "canvas-agent", "cwd");
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  let child: ChildProcess;
  try {
    child = (ctx.spawn ?? spawn)(c.cmd, c.args, { cwd, env: childEnv(process.env, h.real), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    a.tracker.error = `Could not start ${h.label}: ${(e as Error).message}`;
    void end(ctx, a, null);
    return;
  }
  a.child = child;
  clearTimeout(a.timer);
  a.timer = setTimeout(() => kill(a, "timeout"), Math.max(1000, runCapMs() - (Date.now() - a.set.startedAt)));
  child.on("error", (e) => { a.tracker.error = `${h.label} failed to start: ${e.message}`; });
  if (h.id === "claude") {
    const content: unknown[] = a.images.map((p) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(p).toString("base64") } }));
    content.push({ type: "text", text: prompt });
    child.stdin?.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  } else child.stdin?.end(prompt);
  child.stdin?.on("error", () => {});
  const parse = h.id === "claude" ? parseClaudeLine : parseCodexLine;
  let buf = "", total = 0, stderr = "";
  const take = (line: string) => {
    for (const ev of parse(line)) {
      a.tracker.apply(ev);
      if (ev.k === "text" && !a.set.directions) {
        const d = parseDirections(ev.text);
        if (d) {
          a.set.directions = d;
          void publish(a.set);
        }
      }
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    total += chunk.length;
    if (total > OUTPUT_MAX) return kill(a, "output");
    buf += chunk;
    if (buf.length > LINE_MAX && !buf.includes("\n")) { buf = ""; return; }
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) take(line);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (s: string) => { if (stderr.length < 16_000) stderr += s; });
  child.on("close", (code) => {
    if (a.child !== child) return;
    if (buf.trim()) take(buf);
    if (code !== 0 && !a.tracker.error && !a.stopReason && a.tracker.ok !== true) {
      const last = stderr.trim().split("\n").filter(Boolean).slice(-1)[0];
      a.tracker.error = last ? last.slice(0, 300) : `${h.label} exited with code ${code}`;
    }
    void end(ctx, a, code);
  });
}

function kill(a: Active, why: NonNullable<Active["stopReason"]>) {
  if (!a.stopReason) a.stopReason = why;
  const pid = a.child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }, 2000).unref();
}
process.on("exit", () => {
  for (const a of active.values()) {
    if (!a.child?.pid) continue;
    try {
      process.kill(-a.child.pid, "SIGKILL");
    } catch {}
  }
});

const existsIn = (docFile: string) => {
  let doc: CanvasDoc | null = null;
  try {
    doc = currentDoc(docFile).doc;
  } catch {}
  return (id: string) => {
    if (!doc) return false;
    try {
      findNode(doc, id);
      return true;
    } catch {
      return false;
    }
  };
};

async function end(ctx: VarCtx, a: Active, code: number | null) {
  if (a.set.status !== "making") return;
  clearTimeout(a.timer);
  const t = a.tracker;
  const backup = fallBackTo(a.harness.id, t, 0, !!a.stopReason, detectHarnesses());
  if (backup && (t.error || t.ok === false || code !== 0)) {
    logSet(a.set, `status=fallback from=${a.harness.id} to=${backup.id}`);
    a.set.note = `Claude Code could not start (${tidy(t.error ?? `exited with code ${code}`, 160)}). Codex ran instead.`;
    a.tracker = new StepTracker();
    a.harness = backup;
    a.child = null;
    await publish(a.set);
    launch(ctx, a);
    return;
  }
  const s = a.set;
  const stopped = !!a.stopReason;
  const failed = !stopped && (t.ok === false || !!t.error || (t.ok === null && code !== 0));
  const exists = existsIn(a.docFile);
  // A run that never got to work leaves nothing behind: its untouched copies go in the same (agent) step.
  if ((failed || stopped) && !t.tools && a.stopReason !== "discard") {
    const here = s.copies.map((c) => c.id).filter(exists);
    if (here.length) await ctx.structure(s.file, { file: s.file, op: "delete", ids: here }, { source: "mcp", session: s.session }).catch(() => {});
  }
  // Copies the agent never marked keep the direction it announced for them.
  s.copies.forEach((c, i) => {
    if (c.done) return;
    const d = s.directions?.[i];
    if (d && !c.direction) Object.assign(c, { direction: d.name, why: d.why });
    if (!failed && !stopped && t.tools) c.done = true;
  });
  const left = s.copies.filter((c) => exists(c.id));
  s.status = a.stopReason === "discard" ? "making" : left.length ? "review" : failed ? "failed" : "gone";
  if (failed) s.error = tidy(t.error ?? "The run failed", 300);
  else if (a.stopReason === "timeout") s.error = `Stopped after ${agentSettings().runCapMin} minute${agentSettings().runCapMin === 1 ? "" : "s"}`;
  s.endedAt = Date.now();
  finishAgent(s.session, `${s.copies.length} variations of ${s.name}`.slice(0, 140));
  if (t.tools && !t.finishCalled && left.length) await ctx.finish(s.file, `${left.length} variations of ${s.name}`).catch(() => {});
  active.delete(s.id);
  logSet(s, `status=${failed ? "failed" : stopped ? `stopped:${a.stopReason}` : "done"} ms=${s.endedAt - s.startedAt} tools=${t.tools} marked=${s.copies.filter((c) => c.done).length}${code !== null ? ` code=${code}` : ""}`);
  try {
    fs.rmSync(a.dir, { recursive: true, force: true });
  } catch {}
  if (a.stopReason === "discard") {
    await discardVariations(ctx, s.file, s.id, s).catch(() => {});
    return;
  }
  await publish(s);
}

async function findSet(file: string, id: string): Promise<VarSet> {
  const live = active.get(id);
  if (live) return live.set;
  const s = (await readSets(file)).find((x) => x.id === id);
  if (!s) throw new VarError(404, "not_found", "No such variations");
  return s;
}

/** Stop the agent: what it made so far stays up for review. */
export function stopVariations(id: string): boolean {
  const a = active.get(id);
  if (!a) return false;
  kill(a, "stop");
  if (!a.child) a.stopReason = "stop";
  return true;
}

/** Keep one: the others are deleted in one undo step ("Keep Variation"); the kept one is what the page selects. */
export async function keepVariation(ctx: VarCtx, file: string, setId: string, keep: string): Promise<VarSet> {
  const s = await findSet(file, setId);
  if (s.status === "making") throw new VarError(409, "busy", "Still making them; wait or stop first");
  const docFile = resolveDocPath(file);
  const gone = keepPlan(s, keep, existsIn(docFile));
  const merge = `group:variations-keep-${s.id}-${Date.now()}`;
  // A layer varied inside a board of several screens: the kept copy's screen takes the original's place and every
  // copy board goes. A board that is one screen: the kept copy stays beside the original.
  const swap = layerSwap(currentDoc(docFile).doc as unknown as Doc, s, keep);
  if (swap && ctx.layout) {
    for (const p of swap.pairs) {
      await ctx.layout(file, { file, op: "place", ids: [p.copy], parent: p.parent, index: p.index, absolute: p.at ? [p.at] : undefined, merge } as LayoutBody, { source: "user" });
    }
    await ctx.structure(file, { file, op: "delete", ids: [...swap.pairs.map((p) => p.original), ...s.copies.map((c) => c.id).filter(existsIn(docFile))], merge }, { source: "user" });
    relabelTop(docFile, merge, "Keep Variation");
  } else if (gone.length) {
    await ctx.structure(file, { file, op: "delete", ids: gone, merge }, { source: "user" });
    relabelTop(docFile, merge, "Keep Variation");
  }
  const next: VarSet = { ...s, status: "kept", kept: keep };
  await publish(next);
  return next;
}

/** Discard: every copy goes in one undo step ("Discard Variations"). While making, the agent stops first. */
export async function discardVariations(ctx: VarCtx, file: string, setId: string, known?: VarSet): Promise<VarSet> {
  const live = active.get(setId);
  if (live) {
    kill(live, "discard");
    if (!live.child) live.stopReason = "discard";
    return live.set;
  }
  const s = known ?? (await findSet(file, setId));
  const docFile = resolveDocPath(file);
  const here = s.copies.map((c) => c.id).filter(existsIn(docFile));
  if (here.length) {
    const merge = `group:variations-discard-${s.id}-${Date.now()}`;
    await ctx.structure(file, { file, op: "delete", ids: here, merge }, { source: "user" });
    relabelTop(docFile, merge, "Discard Variations");
  }
  const next: VarSet = { ...s, status: "discarded", kept: undefined };
  await publish(next);
  return next;
}

/** The gate for one copy (the rules from the rest of the file). */
export function checkVariation(file: string, id: string): Issue[] {
  const docFile = resolveDocPath(file);
  const doc = currentDoc(docFile).doc as unknown as Doc;
  const skip = new Set<string>();
  for (const s of [...activeSets(file), ...setsNow(file)]) for (const c of s.copies) skip.add(c.id);
  skip.add(id.split("/")[0]);
  try {
    findNode(doc as CanvasDoc, id);
  } catch {
    throw new VarError(404, "not_found", `No layer "${id}"`);
  }
  return lintVariation(doc, id, gateRules(doc, skip));
}

/** The agent says a copy is done. The gate runs again: it refuses while issues remain, GATE_TRIES - 1 times. */
export async function markVariation(file: string, b: { id: string; direction?: string; why?: string; refs?: string[] }) {
  const a = [...active.values()].find((x) => x.set.copies.some((c) => c.id === b.id) && keyOf(x.set.file) === keyOf(file));
  if (!a) throw new VarError(404, "not_found", "That board is not a variation being made");
  const c = a.set.copies.find((x) => x.id === b.id)!;
  const issues = checkVariation(file, b.id);
  c.tries = (c.tries ?? 0) + 1;
  if (issues.length && c.tries < GATE_TRIES) return { ok: false, issues, hint: `Fix these and call mark_variation again (${GATE_TRIES - c.tries} more refusal${GATE_TRIES - c.tries === 1 ? "" : "s"} before it is taken as it is).` };
  Object.assign(c, { done: true, issues: issues.length, ...(b.direction ? { direction: tidy(b.direction, 40) } : {}), ...(b.why ? { why: tidy(b.why, 200) } : {}), ...(Array.isArray(b.refs) ? { refs: b.refs.filter((x) => typeof x === "string").slice(0, 10).map((x) => tidy(x, 80)) } : {}) });
  await publish(a.set);
  const done = a.set.copies.filter((x) => x.done).length;
  return { ok: true, done, of: a.set.copies.length, ...(issues.length ? { note: `Taken with ${issues.length} open issue(s)` } : {}) };
}

// The captions follow the document: an undo of a Keep brings them back (src/history.ts tells every change).
let reconT: NodeJS.Timeout | null = null;
const dirty = new Set<string>();
onHistory((docFile) => {
  dirty.add(docFile);
  if (reconT) return;
  reconT = setTimeout(() => {
    reconT = null;
    const docFiles = [...dirty];
    dirty.clear();
    for (const docFile of docFiles) {
      let list: VarSet[];
      try {
        list = setsNow(docFile);
      } catch {
        continue;
      }
      const exists = existsIn(docFile);
      for (const s of list) {
        if (active.has(s.id)) continue;
        const next = reconcile(s, exists);
        if (next !== s) void publish(next);
      }
    }
  }, 30);
});

// ---------- HTTP ----------

/**
 * GET  /api/variations/events?file=           SSE: {type:"hello", sets} then {type:"set", set}
 * GET  /api/variations/sets?file=             the stored sets and the ones being made
 * GET  /api/variations/brief?file=            {brief}
 * GET  /api/variations/context?file=&ids=     the context pack (get_design_context)
 * GET  /api/variations/check?file=&id=        the quality gate's issues (check_variation)
 * POST /api/variations/make    {file, ids, harness?, rects?}
 * POST /api/variations/stop    {set}
 * POST /api/variations/keep    {file, set, id}
 * POST /api/variations/discard {file, set}
 * POST /api/variations/mark    {file, id, direction, why?, refs?}
 * POST /api/variations/brief   {file, text, drafted?}
 */
export async function handleVariationsRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: VarCtx): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/variations/")) return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (!originOk(req)) return reply(403, { error: "forbidden", code: "forbidden" }), true;
    if (req.method !== "GET" && req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    if (req.method === "GET") {
      const file = url.searchParams.get("file");
      if (!file) return reply(400, { error: "file is required", code: "invalid" }), true;
      if (p === "/api/variations/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const k = keyOf(file);
        let set = listeners.get(k);
        if (!set) listeners.set(k, (set = new Set()));
        set.add(res);
        const live = activeSets(file);
        const stored = (await readSets(file).catch(() => [] as VarSet[])).filter((s) => !live.some((l) => l.id === s.id));
        res.write(`retry: 2000\ndata: ${JSON.stringify({ type: "hello", sets: [...stored, ...live] })}\n\n`);
        const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15_000);
        req.on("close", () => {
          clearInterval(ping);
          set!.delete(res);
          if (!set!.size) listeners.delete(k);
        });
        return true;
      }
      if (p === "/api/variations/sets") {
        const live = activeSets(file);
        return reply(200, { sets: [...(await readSets(file)).filter((s) => !live.some((l) => l.id === s.id)), ...live] }), true;
      }
      if (p === "/api/variations/brief") return reply(200, { brief: await readBrief(file) }), true;
      if (p === "/api/variations/context") {
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 50);
        if (!ids.length) return reply(400, { error: "ids is required", code: "invalid" }), true;
        const docFile = resolveDocPath(file);
        const doc = currentDoc(docFile).doc as unknown as Doc;
        let board: string;
        try {
          const h = findNode(doc as CanvasDoc, ids[0]);
          board = String((h.ancestors[0] ?? h.node).id);
        } catch {
          return reply(404, { error: `no node "${ids[0]}"`, code: "not_found" }), true;
        }
        const pack = contextPack(doc, ids, { brief: await readBrief(file), pageBoards: pageBoardsOf(file, ctx, board) });
        return reply(200, { ...pack, skills: readSkills(skillsFor(pack.fonts)).map((s) => s.name) }), true;
      }
      if (p === "/api/variations/check") return reply(200, { issues: checkVariation(file, url.searchParams.get("id") ?? "") }), true;
      return reply(404, { error: "not found" }), true;
    }
    const b = await jsonBody(req);
    const file = String(b.file ?? "");
    if (p === "/api/variations/make") {
      const rects = b.rects && typeof b.rects === "object" ? (b.rects as Record<string, Rect>) : undefined;
      const set = await makeVariations(ctx, { file, ids: Array.isArray(b.ids) ? b.ids : [], harness: b.harness === "codex" || b.harness === "claude" ? b.harness : undefined, rects });
      countUsage("variations.make");
      return reply(200, { ok: true, set }), true;
    }
    if (p === "/api/variations/stop") return reply(200, { ok: stopVariations(String(b.set ?? "")) }), true;
    if (p === "/api/variations/keep") {
      const set = await keepVariation(ctx, file, String(b.set ?? ""), String(b.id ?? ""));
      countUsage("variations.keep");
      return reply(200, { ok: true, set }), true;
    }
    if (p === "/api/variations/discard") {
      const set = await discardVariations(ctx, file, String(b.set ?? ""));
      countUsage("variations.discard");
      return reply(200, { ok: true, set }), true;
    }
    if (p === "/api/variations/mark") return reply(200, await markVariation(file, { id: String(b.id ?? ""), direction: b.direction, why: b.why, refs: b.refs })), true;
    if (p === "/api/variations/brief") {
      const brief = await writeBrief(file, String(b.text ?? ""), b.drafted === true);
      broadcast(file, { type: "brief", brief });
      return reply(200, { ok: true, brief }), true;
    }
    return reply(404, { error: "not found" }), true;
  } catch (e) {
    if (e instanceof VarError) return reply(e.status, { error: e.message, code: e.code }), true;
    if (e instanceof SyntaxError) return reply(400, { error: "invalid JSON", code: "invalid" }), true;
    const st = (e as { status?: number }).status;
    return reply(typeof st === "number" ? st : 500, { error: (e as Error).message, code: (e as { code?: string }).code ?? "failed" }), true;
  }
}
