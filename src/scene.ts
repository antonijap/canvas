// The GPU engine's input: one board as a fully resolved tree. Resolution stays here in TypeScript,
// exactly as html.ts does it: component instances expanded (path ids), $variables resolved for the
// active theme (a node's `theme` narrows it for its subtree), disabled nodes dropped, image URLs
// pointed at /asset, icon artwork turned into SVG path data, and every font face the board's text
// needs listed with the URL that serves its bytes. The engine only does layout and paint.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "./boards.ts";
import { buildIndex, defaultTheme, expand, iconArt, resolveProps, resolveVariable, type Json, type CanvasDoc, type DocNode } from "./engine.ts";
import { keyedAnswer, sceneEnvOf } from "./keyed.ts";
import { readBodyText } from "./body.ts";
import { resolveShaderFill } from "./shader-fill.ts";
import { adjustFragment } from "./page/image-adjust.js";
import { version } from "./version.ts";
import { googleFailed, localPath, fallbackFace, fallbackFamilies, FALLBACK_MAX_BYTES, FALLBACK_MAX_BYTES_CJK, FALLBACK_ORDER, findFont, googleFaces, installedFaces, isSystemFamily, pickFace, pickGoogle, SYSTEM_UI, webFontsOn, weightOf, coverageOfFile, type Coverage } from "./fontfiles.ts";

type Theme = Record<string, string>;

export const SCENE_VERSION = 2;

export type IconShape = { d: string; fill: string; stroke: string; strokeWidth?: number; cap?: string; join?: string; fillRule?: string };
/**
 * One font file a board needs. `family` is what the engine registers it under. A family split into
 * Google unicode-range subsets, and the platform fonts behind `system-ui`, carry a tag after
 * FAMILY_SEP (`Inter\u001f2:cyrillic`, `system-ui\u001f1:Lucida Grande`): the engine chains every
 * tagged face of a family after the plain one, in tag-number order, like the browser's per-character
 * fallback.
 */
export type FontRef = { family: string; weight: number; style: "normal" | "italic"; url: string; fallback?: boolean };
export const FAMILY_SEP = "\u001f";
export type SceneBoard = { version: number; id: string; x: number; y: number; root: DocNode; fonts: FontRef[]; images: string[]; warnings: string[] };

const DROP = new Set(["children", "descendants", "metadata", "context", "reusable", "__ref", "theme", "slot", "href", "placeholder"]);
const TEXTY = new Set(["text", "note", "prompt", "context"]);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ---------------------------------------------------------------- auto layout extras

/**
 * Canvas's auto layout keys the format has no native slot for, kept in `metadata.canvasLayout` (the rest of
 * `metadata` stays dropped). Only known keys with values of the right type reach the engine; `$variables`
 * resolve like any other number. Absent keys mean the default.
 */
const LAYOUT_BOOL = ["wrap", "crossAuto", "baseline"] as const;
const LAYOUT_NUM = ["crossGap", "minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
const LAYOUT_ENUM: Record<string, readonly string[]> = { gapMode: ["between", "around", "evenly"], stacking: ["first", "last"] };

export function canvasLayoutOf(raw: DocNode, doc: CanvasDoc, theme: Theme, warnings: string[]): Record<string, Json> | undefined {
  const meta = raw.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const cl = (meta as Record<string, Json>).canvasLayout;
  if (!cl || typeof cl !== "object" || Array.isArray(cl)) return undefined;
  const value = (k: string): Json | undefined => {
    const v = (cl as Record<string, Json>)[k];
    if (typeof v === "string" && v.startsWith("$") && v.length > 1) {
      const r = resolveVariable(doc, v.slice(1), theme);
      if (r === undefined) warnings.push(`${raw.id}: unknown variable ${v}`);
      return r;
    }
    return v;
  };
  const out: Record<string, Json> = {};
  for (const k of LAYOUT_BOOL) if (typeof value(k) === "boolean") out[k] = value(k) as boolean;
  for (const k of LAYOUT_NUM) {
    const v = value(k);
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  for (const [k, allowed] of Object.entries(LAYOUT_ENUM)) {
    const v = value(k);
    if (typeof v === "string" && allowed.includes(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- icons

const attrsOf = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = m[3] ?? m[4] ?? "";
  return out;
};
const f = (v: string | undefined, d = 0) => {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : d;
};

function shapeD(tag: string, a: Record<string, string>): string | undefined {
  switch (tag) {
    case "path":
      return a.d;
    case "circle":
    case "ellipse": {
      const [cx, cy] = [f(a.cx), f(a.cy)];
      const rx = tag === "circle" ? f(a.r) : f(a.rx);
      const ry = tag === "circle" ? f(a.r) : f(a.ry);
      if (rx <= 0 || ry <= 0) return undefined;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case "line":
      return `M${f(a.x1)} ${f(a.y1)}L${f(a.x2)} ${f(a.y2)}`;
    case "rect": {
      const [x, y, w, h] = [f(a.x), f(a.y), f(a.width), f(a.height)];
      let rx = a.rx !== undefined ? f(a.rx) : a.ry !== undefined ? f(a.ry) : 0;
      let ry = a.ry !== undefined ? f(a.ry) : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case "polyline":
    case "polygon": {
      const p = (a.points ?? "").trim().split(/[\s,]+/).map(Number);
      if (p.length < 4) return undefined;
      let d = `M${p[0]} ${p[1]}`;
      for (let i = 2; i + 1 < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
      return tag === "polygon" ? `${d}Z` : d;
    }
  }
  return undefined;
}

/** Flatten SVG markup into path shapes, with fill/stroke inherited through <g>. */
export function svgShapes(body: string, warnings: string[] = [], where = "icon"): IconShape[] {
  const out: IconShape[] = [];
  const stack: Record<string, string>[] = [{ fill: "#000", stroke: "none" }];
  const PAINT = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule"];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    const [, close, tag, rest, self] = m;
    if (close) {
      if (tag === "g" || tag === "svg") stack.pop();
      continue;
    }
    const a = attrsOf(rest);
    if (a.style) for (const decl of a.style.split(";")) {
      const [k, v] = decl.split(":").map((x) => x.trim());
      if (k && v && PAINT.includes(k)) a[k] = v;
    }
    const inherited = { ...stack[stack.length - 1] };
    for (const k of PAINT) if (a[k] !== undefined) inherited[k] = a[k];
    if (tag === "g" || tag === "svg") {
      if (!self) stack.push(inherited);
      continue;
    }
    if (a.transform) warnings.push(`${where}: SVG transform on <${tag}> is ignored`);
    if (a.opacity !== undefined && f(a.opacity, 1) === 0) continue;
    const d = shapeD(tag, a);
    if (!d) continue;
    const paint = (v: string | undefined) => (!v || v === "none" ? "none" : v === "currentColor" ? "current" : v);
    out.push({
      d,
      fill: paint(inherited.fill),
      stroke: paint(inherited.stroke),
      ...(inherited["stroke-width"] !== undefined ? { strokeWidth: f(inherited["stroke-width"], 1) } : {}),
      ...(inherited["stroke-linecap"] ? { cap: inherited["stroke-linecap"] } : {}),
      ...(inherited["stroke-linejoin"] ? { join: inherited["stroke-linejoin"] } : {}),
      ...(inherited["fill-rule"] ? { fillRule: inherited["fill-rule"] } : {}),
    });
  }
  return out;
}

const remoteIcons = new Map<string, Promise<{ size: number; body: string } | undefined>>();

function remoteIcon(url: string): Promise<{ size: number; body: string } | undefined> {
  let p = remoteIcons.get(url);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return undefined;
        const svg = await r.text();
        const vb = /viewBox\s*=\s*"([^"]+)"/.exec(svg)?.[1].split(/[\s,]+/).map(Number);
        return { size: vb && vb.length === 4 ? Math.max(vb[2], vb[3]) : 24, body: svg };
      } catch {
        return undefined;
      }
    })();
    remoteIcons.set(url, p);
  }
  return p;
}

// ---------------------------------------------------------------- tree

/** What text a board draws per family, weight and style: the code points decide which subsets and fallbacks it needs. */
type TextUse = { family: string; weight: number; style: "normal" | "italic"; cps: Set<number> };
type Ctx = { doc: CanvasDoc; baseDir: string; warnings: string[]; fonts: Map<string, TextUse>; images: Set<string>; file: string; icons: Promise<void>[]; transient?: boolean };

function assetUrl(url: string, baseDir: string): string {
  if (/^(https?:|data:)/.test(url)) return url;
  const abs = localPath(url, baseDir);
  return `/asset?p=${encodeURIComponent(abs)}`;
}

export const fontUrl = (family: string, weight: number, style: string, file?: string) =>
  `/api/fonts/file?family=${encodeURIComponent(family)}&weight=${weight}&style=${style}${file ? `&file=${encodeURIComponent(file)}` : ""}`;

function rewritePaints(v: Json | undefined, c: Ctx): Json | undefined {
  if (v === undefined || v === null) return v;
  const one = (p: Json): Json => {
    if (p && typeof p === "object" && !Array.isArray(p) && p.type === "image" && typeof p.url === "string") {
      // Adjustments name a recoloured copy of the image (src/page/image-adjust.js; the page applies them as it decodes).
      const url = assetUrl(p.url, c.baseDir) + adjustFragment(p.adjust);
      c.images.add(url);
      return { ...p, url };
    }
    // A shader fill: the engine gets WGSL and packed params (src/shader-fill.ts), whichever way the file names it.
    if (p && typeof p === "object" && !Array.isArray(p) && p.type === "shader") {
      const r = resolveShaderFill(p as Record<string, unknown>);
      if ("error" in r) {
        c.warnings.push(`shader fill: ${r.error}`);
        return p;
      }
      return { ...p, source: r.source, uniforms: r.uniforms, play: r.play };
    }
    return p;
  };
  return Array.isArray(v) ? v.map(one) : one(v);
}

function sceneNode(raw: DocNode, theme: Theme, c: Ctx): DocNode | undefined {
  if (raw.enabled === false) return undefined;
  const active: Theme = raw.theme ? { ...theme, ...(raw.theme as Theme) } : theme;
  const n = resolveProps(c.doc, raw, active, c.warnings);
  if (n.enabled === false) return undefined;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(n)) if (!DROP.has(k) && v !== undefined && v !== null) out[k] = v as Json;
  // An instance names its component, so the page never offers a drop into the component it would draw.
  if (typeof raw.__ref === "string") out.component = raw.__ref;
  const layoutExtras = canvasLayoutOf(raw, c.doc, active, c.warnings);
  if (layoutExtras) out.canvasLayout = layoutExtras;
  else delete out.canvasLayout;
  // Lock aspect ratio (metadata.canvasLockAspect, set beside W and H): the page's resize handles keep the ratio.
  const meta = raw.metadata as Record<string, Json> | undefined;
  if (meta && typeof meta === "object" && !Array.isArray(meta) && meta.canvasLockAspect === true) out.lockAspect = true;
  else delete out.lockAspect;
  if (out.fill !== undefined) out.fill = rewritePaints(out.fill, c) as Json;
  if (out.stroke !== undefined) out.stroke = rewritePaints(out.stroke, c) as Json;
  const type = String(n.type);
  if (TEXTY.has(type)) {
    const family = n.fontFamily ? String(n.fontFamily) : "Inter";
    const weight = weightOf(n.fontWeight);
    const style = typeof n.fontStyle === "string" && /italic/i.test(n.fontStyle) ? "italic" : "normal";
    const key = `${family}|${weight}|${style}`;
    let use = c.fonts.get(key);
    if (!use) c.fonts.set(key, (use = { family, weight, style, cps: new Set() }));
    for (const ch of String(n.content ?? "")) use.cps.add(ch.codePointAt(0) ?? 0);
    // Styled ranges (src/page/text-spans.js) in another family, weight or style need those faces too.
    if (Array.isArray(n.spans)) {
      const content = String(n.content ?? "");
      for (const s of n.spans as Record<string, Json>[]) {
        if (!s || typeof s !== "object" || typeof s.start !== "number" || typeof s.end !== "number") continue;
        const fam = typeof s.fontFamily === "string" && s.fontFamily ? s.fontFamily : family;
        const w = s.fontWeight !== undefined && s.fontWeight !== null ? weightOf(s.fontWeight) : weight;
        const st = typeof s.fontStyle === "string" ? (/italic/i.test(s.fontStyle) ? "italic" : "normal") : style;
        const k = `${fam}|${w}|${st}`;
        let u = c.fonts.get(k);
        if (!u) c.fonts.set(k, (u = { family: fam, weight: w, style: st, cps: new Set() }));
        for (const ch of content.slice(s.start, s.end)) u.cps.add(ch.codePointAt(0) ?? 0);
      }
    }
    // Content bound to a string variable: the editor on the page (src/page/text-edit.js) refuses to type over it.
    if (typeof raw.content === "string" && raw.content.length > 1 && raw.content.startsWith("$") && n.content !== raw.content) out.contentVar = raw.content;
  }
  if (type === "icon") {
    const art = iconArt(String(n.library ?? "lucide"), String(n.icon ?? ""));
    if (!art) c.warnings.push(`${n.id}: no icon "${n.icon}" in ${n.library}`);
    else if (art.kind === "svg") {
      const weight = num(n.weight);
      const body = weight ? art.body.replace(/stroke-width="[\d.]+"/g, `stroke-width="${(2 * weight) / 400}"`) : art.body;
      out.iconSize = art.size;
      out.iconMode = "svg";
      out.iconShapes = svgShapes(body, c.warnings, String(n.id)) as unknown as Json;
    } else {
      out.iconMode = "mask";
      c.icons.push(
        remoteIcon(art.url).then((r) => {
          if (!r) return void c.warnings.push(`${n.id}: icon ${art.url} could not be fetched`);
          out.iconSize = r.size;
          out.iconShapes = svgShapes(r.body, c.warnings, String(n.id)) as unknown as Json;
        }),
      );
    }
  }
  const kids = Array.isArray(raw.children) ? (raw.children as DocNode[]) : [];
  if (kids.length) out.children = kids.map((k) => sceneNode(k, active, c)).filter((k): k is DocNode => !!k) as unknown as Json;
  return out as DocNode;
}

// ---------------------------------------------------------------- fonts

/** The installed faces of one family (lower case), looked up once per list: every board's text asked again. */
const byFamily = new WeakMap<object, Map<string, Awaited<ReturnType<typeof installedFaces>>>>();
function facesNamed(all: Awaited<ReturnType<typeof installedFaces>>, lower: string): Awaited<ReturnType<typeof installedFaces>> {
  let m = byFamily.get(all);
  if (!m) byFamily.set(all, (m = new Map()));
  let hit = m.get(lower);
  if (!hit) m.set(lower, (hit = all.filter((x) => x.families.some((n) => n.toLowerCase() === lower))));
  return hit;
}

const isWhite = (cp: number) => cp < 0x21 || cp === 0xa0 || (cp >= 0x2000 && cp <= 0x200f) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0xfeff;

let sfCoverage: Coverage | undefined;

/**
 * Every font file the board's text needs, in the order the browser would try them per character:
 * the family (its Google subsets that the text touches, else the document's or an installed file),
 * then `system-ui` (SF Pro), then the platform font CoreText picks for what neither has.
 */
async function fontRefs(uses: TextUse[], c: Ctx): Promise<FontRef[]> {
  const out: FontRef[] = [];
  const seen = new Set<string>();
  const push = ({ key, ...r }: FontRef & { key?: string }) => {
    // One file per variable face and subset, whatever weights the text asks for.
    const k = key ?? r.url;
    if (!seen.has(k)) out.push(r), seen.add(k);
  };
  const docFonts = new Set((Array.isArray(c.doc.fonts) ? (c.doc.fonts as { name?: string }[]) : []).map((f) => String(f.name ?? "").toLowerCase()));
  const web = webFontsOn();
  sfCoverage ??= coverageOfFile("/System/Library/Fonts/SFNS.ttf");
  const missing = new Map<string, { weight: number; style: "normal" | "italic"; cps: Set<number> }>();
  for (const u of uses) {
    let covered: ((cp: number) => boolean) | undefined;
    const askGoogle = web && !docFonts.has(u.family.toLowerCase()) && !isSystemFamily(u.family);
    const google = askGoogle ? pickGoogle(await googleFaces(u.family), u.weight, u.style === "italic") : [];
    if (askGoogle && googleFailed(u.family)) c.transient = true; // offline: the faces may be there next time
    if (google.length) {
      // Only the subsets the text touches, the way the browser only downloads those.
      const need = google.filter((g) => [...u.cps].some((cp) => !isWhite(cp) && g.ranges.some(([a, b]) => cp >= a && cp <= b)));
      const list = need.length ? need : google.filter((g) => g.subset === "latin").slice(0, 1);
      list.forEach((g) => push({ key: `${u.family}|${g.subset}|${g.italic}|${g.wMin}-${g.wMax}`, family: `${u.family}${FAMILY_SEP}${google.indexOf(g)}:${g.subset}`, weight: u.weight, style: u.style, url: `${fontUrl(u.family, u.weight, u.style, c.file)}&subset=${encodeURIComponent(g.subset)}` }));
      covered = (cp) => google.some((g) => g.ranges.some(([a, b]) => cp >= a && cp <= b));
    } else if (u.family.toLowerCase() === "apple color emoji" && !docFonts.has("apple color emoji")) {
      // Named on purpose: only the glyphs the text uses that the face has (the whole face is 183 MB, and was
      // sent once per weight). Every other character falls back as usual.
      const f = pickFace(facesNamed(await installedFaces(), "apple color emoji"), 400, false);
      const cov = f ? coverageOfFile(f.file, f.index) : new Set<number>();
      const cps = [...u.cps].filter((cp) => !isWhite(cp) && cov.has(cp)).map((x) => x.toString(16)).sort();
      if (cps.length) push({ key: `emoji|${cps.join(",")}`, family: u.family, weight: 400, style: "normal", url: fontUrl(u.family, 400, "normal") + `&text=${cps.join(",")}` });
      covered = (cp) => cov.has(cp);
    } else {
      push({ family: u.family, weight: u.weight, style: u.style, url: fontUrl(u.family, u.weight, u.style, c.file) });
      if (!docFonts.has(u.family.toLowerCase())) {
        const lower = u.family.toLowerCase();
        const f = pickFace(facesNamed(await installedFaces(), lower), u.weight, u.style === "italic");
        if (f) {
          const cov = coverageOfFile(f.file, f.index);
          covered = (cp) => cov.has(cp);
        }
      }
    }
    // The browser's fallback for every family: `"Family",system-ui,sans-serif`.
    push({ family: SYSTEM_UI, weight: 400, style: u.style, url: fontUrl(SYSTEM_UI, 400, u.style), fallback: true });
    if (!covered) continue; // a document font: its coverage is unknown here, so no platform fallback
    for (const cp of u.cps) {
      if (isWhite(cp) || covered(cp) || sfCoverage.has(cp)) continue;
      const k = `${u.weight}|${u.style}`;
      if (!missing.has(k)) missing.set(k, { weight: u.weight, style: u.style, cps: new Set() });
      missing.get(k)!.cps.add(cp);
    }
  }
  // What CoreText would pick for characters neither the family nor SF Pro has.
  for (const m of missing.values()) {
    const picked = new Map<string, number[]>();
    for (const cp of m.cps) {
      for (const fam of fallbackFamilies(cp)) {
        const f = await fallbackFace(fam, m.weight, m.style === "italic");
        const emoji = fam === "Apple Color Emoji";
        const cjk = (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0xf900 && cp <= 0xfaff) || cp >= 0x20000;
        if (!f || !f.coverage.has(cp) || (!emoji && f.bytes > (cjk ? FALLBACK_MAX_BYTES_CJK : FALLBACK_MAX_BYTES))) continue;
        if (!picked.has(fam)) picked.set(fam, []);
        picked.get(fam)!.push(cp);
        break;
      }
    }
    for (const [fam, cps] of picked) {
      const order = FALLBACK_ORDER.indexOf(fam);
      const text = fam === "Apple Color Emoji" ? `&text=${cps.map((x) => x.toString(16)).sort().join(",")}` : "";
      push({ family: `${SYSTEM_UI}${FAMILY_SEP}${order < 0 ? 99 : order}:${fam}`, weight: m.weight, style: m.style, url: fontUrl(fam, m.weight, m.style) + text, fallback: true });
    }
  }
  return out;
}

// Component index per loaded document: building it walks the whole file, and a page asks for
// every board of a document in a row.
const indexes = new WeakMap<CanvasDoc, ReturnType<typeof buildIndex>>();
const indexOf = (doc: CanvasDoc) => {
  let i = indexes.get(doc);
  if (!i) indexes.set(doc, (i = buildIndex(doc)));
  return i;
};

/** One board, resolved for the engine. */
export async function sceneOf(doc: CanvasDoc, file: string, id: string): Promise<SceneBoard> {
  const raw = doc.children.find((n) => String(n.id) === id);
  if (!raw) throw new Error(`no board "${id}"`);
  const warnings: string[] = [];
  const c: Ctx = { doc, baseDir: path.dirname(file), warnings, fonts: new Map(), images: new Set(), file, icons: [] };
  const root = sceneNode(expand(indexOf(doc), raw, warnings), defaultTheme(doc), c);
  if (!root) throw new Error(`board "${id}" is disabled`);
  await Promise.all(c.icons);
  const fonts = await fontRefs([...c.fonts.values()], c);
  const scene: SceneBoard = { version: SCENE_VERSION, id, x: num(raw.x) ?? 0, y: num(raw.y) ?? 0, root, fonts, images: [...c.images], warnings };
  if (c.transient) transientScenes.add(scene);
  return scene;
}

/** Scenes built while a web font could not be fetched: never cached, here or by the browser. */
const transientScenes = new WeakSet<SceneBoard>();
export const isTransient = (s: SceneBoard): boolean => transientScenes.has(s);

let env: string | undefined;
/** This server's scene environment (src/keyed.ts): the `v` a keyed scene request must carry to be cached. */
export const sceneEnv = (): string => (env ??= sceneEnvOf(version(), SCENE_VERSION, webFontsOn()));

/**
 * Scenes per document revision (a revision is one CanvasDoc object): a board's scene is built once, so the page's
 * idle prefetch of other pages' first boards makes the first visit of that page instant. A failed build is not kept.
 */
const sceneCache = new WeakMap<CanvasDoc, Map<string, Promise<SceneBoard>>>();
export function cachedScene(doc: CanvasDoc, file: string, id: string): Promise<SceneBoard> {
  let m = sceneCache.get(doc);
  if (!m) sceneCache.set(doc, (m = new Map()));
  const key = file + "\0" + id;
  let p = m.get(key);
  if (!p) {
    p = sceneOf(doc, file, id);
    m.set(key, p);
    p.then((s) => { if (isTransient(s) && m!.get(key) === p) m!.delete(key); }, () => m!.delete(key));
  }
  return p;
}

const fontUnions = new WeakMap<CanvasDoc, Promise<FontRef[]>>();
/**
 * Every font file any board of the document needs, in board order then each board's own order, once each.
 * The page registers these with the engine while it is idle: a face registered after boards that use its
 * family exist lays those boards out again, which costs a frame or more mid-gesture.
 */
export function docFonts(doc: CanvasDoc, file: string): Promise<FontRef[]> {
  let p = fontUnions.get(doc);
  if (!p) {
    p = (async () => {
      const out: FontRef[] = [];
      const seen = new Set<string>();
      for (const b of doc.children) {
        if (b.enabled === false) continue;
        let scene: SceneBoard;
        try {
          scene = await sceneOf(doc, file, String(b.id));
        } catch {
          continue;
        }
        for (const f of scene.fonts) if (!seen.has(f.url)) seen.add(f.url), out.push(f);
      }
      return out;
    })();
    fontUnions.set(doc, p);
  }
  return p;
}

// ---------------------------------------------------------------- routes

const sendJson = (res: http.ServerResponse, v: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(v));
};

/** Where the wasm build lives (engine/build.sh writes it; it is not in git). CANVAS_ENGINE_PKG overrides it. */
export const enginePkgDir = () => process.env.CANVAS_ENGINE_PKG ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "engine", "pkg");
const PKG_FILES: Record<string, string> = { "canvas_engine.js": "text/javascript; charset=utf-8", "canvas_engine_bg.wasm": "application/wasm" };

/**
 * GET /engine/canvas_engine.js and /engine/canvas_engine_bg.wasm: the engine the page draws boards with.
 * 404 when it was never built, and the page falls back to the DOM renderer. Revalidated by ETag, so the
 * browser keeps its compiled wasm between loads.
 */
function serveEnginePkg(req: http.IncomingMessage | undefined, url: URL, res: http.ServerResponse): boolean {
  const name = url.pathname.slice("/engine/".length);
  const type = Object.hasOwn(PKG_FILES, name) ? PKG_FILES[name] : undefined;
  const file = path.join(enginePkgDir(), name);
  let st: fs.Stats;
  try {
    if (!type) throw new Error("not served");
    st = fs.statSync(file);
  } catch {
    return sendJson(res, { error: "engine not built (pnpm build:engine, see the README)" }, 404), true;
  }
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  if (req?.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag, "cache-control": "no-cache" });
    res.end();
    return true;
  }
  res.writeHead(200, { "content-type": type, "content-length": st.size, etag, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  streamFile(file, res);
  return true;
}

/** Streams a file to the response. A read error (unreadable, deleted after the stat) ends the response instead of
 *  crashing the server: a bare .pipe() leaves the stream's "error" unhandled. */
export function streamFile(file: string, res: http.ServerResponse): void {
  pipeline(fs.createReadStream(file), res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.destroy();
  });
}

/**
 * POST /api/scenes?file= {ids}: many boards' scenes in one answer, each written as soon as it is built, in the order
 * asked (the page asks nearest the view first). NDJSON, two lines per board: {"id","key"} and then the same body GET
 * /api/scene answers; a board that cannot be built has "error" in its first line and no second. An overview of
 * 2,000 boards was 2,000 requests through the browser's six connections, and the page placed none of them until
 * the last had arrived. The build yields every few ms, so edits and other requests go on meanwhile.
 */
async function bulkScenes(url: URL, res: http.ServerResponse, snapOf: (file: string) => Snapshot, req?: http.IncomingMessage): Promise<void> {
  if (req?.method !== "POST") return void sendJson(res, { error: "POST only" }, 405);
  const file = url.searchParams.get("file");
  if (!file) return void sendJson(res, { error: "file is required" }, 400);
  let ids: string[] = [];
  try {
    const raw = req ? await readBodyText(req, 8_000_000) : null;
    const b = JSON.parse(raw || "{}") as { ids?: unknown };
    ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string").slice(0, 50_000) : [];
  } catch {
    return void sendJson(res, { error: "body must be {ids: [...]}" }, 400);
  }
  let snap: Snapshot;
  try {
    snap = snapOf(file);
  } catch (e) {
    return void sendJson(res, { error: (e as Error).message }, 404);
  }
  const keys = new Map(snap.boards.map((b) => [b.id, b.key]));
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  let t0 = performance.now();
  for (const id of ids) {
    if (res.destroyed) return;
    const key = keys.get(id);
    let out: string;
    try {
      const scene = await cachedScene(snap.doc, snap.path, id);
      out = JSON.stringify({ id, key }) + "\n" + JSON.stringify({ ...scene, key, revision: snap.revision }) + "\n";
    } catch (e) {
      out = JSON.stringify({ id, key, error: (e as Error).message }) + "\n";
    }
    if (!res.write(out)) await new Promise<void>((r) => { res.once("drain", r); res.once("close", r); });
    if (performance.now() - t0 > 8) {
      await new Promise<void>((r) => setImmediate(r));
      t0 = performance.now();
    }
  }
  res.end();
}

/** GET /api/scene?file=&id= and GET /api/fonts/file?family=&weight=&style=[&file=]. True when handled. */
export async function handleEngineRoute(url: URL, res: http.ServerResponse, snapOf: (file: string) => Snapshot, req?: http.IncomingMessage): Promise<boolean> {
  if (url.pathname.startsWith("/engine/")) return serveEnginePkg(req, url, res);
  if (url.pathname === "/api/scene/fonts") {
    const file = url.searchParams.get("file");
    if (!file) return sendJson(res, { error: "file is required" }, 400), true;
    let snap: Snapshot;
    try {
      snap = snapOf(file);
    } catch (e) {
      return sendJson(res, { error: (e as Error).message }, 404), true;
    }
    return sendJson(res, { revision: snap.revision, fonts: await docFonts(snap.doc, snap.path) }), true;
  }
  if (url.pathname === "/api/scenes") return bulkScenes(url, res, snapOf, req), true;
  if (url.pathname === "/api/scene") {
    const file = url.searchParams.get("file");
    if (!file) return sendJson(res, { error: "file is required" }, 400), true;
    let snap: Snapshot;
    try {
      snap = snapOf(file);
    } catch (e) {
      return sendJson(res, { error: (e as Error).message }, 404), true;
    }
    const id = url.searchParams.get("id") ?? "";
    // Asked for by content key (src/keyed.ts): an unchanged board comes from the browser's cache from then on.
    const asked = { key: url.searchParams.get("key"), v: url.searchParams.get("v") };
    const current = snap.boards.find((b) => b.id === id)?.key;
    const pre = keyedAnswer(asked, current, sceneEnv(), req?.headers["if-none-match"]);
    if (pre.notModified) {
      res.writeHead(304, pre.headers);
      res.end();
      return true;
    }
    try {
      const scene = await cachedScene(snap.doc, snap.path, id);
      const k = keyedAnswer(asked, current, sceneEnv(), undefined, isTransient(scene));
      // A cached answer is only what the key names: no revision (that moves with every edit anywhere in the file).
      const body = k.cacheable ? { ...scene, key: current } : { ...scene, key: current, revision: snap.revision };
      res.writeHead(200, { "content-type": "application/json", "x-content-type-options": "nosniff", ...k.headers });
      res.end(JSON.stringify(body));
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 404);
    }
    return true;
  }
  if (url.pathname === "/api/fonts/file") {
    const family = (url.searchParams.get("family") ?? "").trim();
    if (!family || family.length > 200) return sendJson(res, { error: "family is required" }, 400), true;
    const weight = weightOf(url.searchParams.get("weight") ?? 400);
    const italic = /italic|oblique/i.test(url.searchParams.get("style") ?? "");
    let doc: { fonts?: { name: string; url: string; weight?: number | string; style?: string }[]; baseDir: string } | undefined;
    const file = url.searchParams.get("file");
    if (file) {
      try {
        const snap = snapOf(file);
        doc = { fonts: Array.isArray(snap.doc.fonts) ? (snap.doc.fonts as never) : [], baseDir: path.dirname(snap.path) };
      } catch {
        // A file that does not open still lets installed and web fonts answer.
      }
    }
    const subset = url.searchParams.get("subset") ?? undefined;
    const text = (url.searchParams.get("text") ?? "")
      .split(",")
      .map((h) => Number.parseInt(h, 16))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 512);
    let hit;
    try {
      hit = await findFont({ family, weight, italic, doc, subset, text });
    } catch (e) {
      return sendJson(res, { error: `font could not be read: ${(e as Error).message}` }, 422), true;
    }
    if (!hit) return sendJson(res, { error: `no font "${family}" ${weight} ${italic ? "italic" : "normal"}` }, 404), true;
    const cff = hit.bytes.toString("latin1", 0, 4) === "OTTO";
    res.writeHead(200, {
      "content-type": cff ? "font/otf" : "font/ttf",
      "cache-control": "max-age=3600",
      "x-content-type-options": "nosniff",
      "x-font-source": hit.source,
      "x-font-weight": String(hit.weight),
      "x-font-style": hit.italic ? "italic" : "normal",
      "access-control-expose-headers": "x-font-source, x-font-weight, x-font-style",
    });
    res.end(hit.bytes);
    return true;
  }
  return false;
}
