// Convert an expanded document tree into HTML + CSS. The format's layout model is flexbox, so frames map onto it directly.
// Chrome then does the layout and text measuring. Every drawn node carries data-id so its bounds can be read back.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CanvasDoc } from "../docfile.ts";
import { resolveProps, type Theme } from "../resolve.ts";
import type { Json, DocNode } from "../schema.ts";
import { stackStickers, stickerData, stickerGlyph, stickyFrame, STICKERS, STICKER_SIZE, WHITEBOARD_PAINT, type Sticker } from "../../page/whiteboard-model.js";
import { iconArt } from "./icons.ts";
import { caseCss, hasParagraphs, markerColor, paragraphPlan, paragraphStarts, wordStarts } from "../../page/text-paras.js";
// Pure colour math shared with the engine's page (the one import from outside this folder).
import { adjustMatrix, adjustValues, svgMatrixValues } from "../../page/image-adjust.js";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const px = (v: number) => `${Math.round(v * 1000) / 1000}px`;
type Style = Record<string, string>;
const css = (s: Style) => Object.entries(s).map(([k, v]) => `${k}:${v}`).join(";");

type ParentCtx = { layout: "horizontal" | "vertical" | "none"; root?: boolean };
export type HtmlOptions = { doc: CanvasDoc; baseDir: string; theme: Theme; warnings: string[]; assetUrl?: (abs: string) => string; layerNames?: boolean; layerIds?: boolean; whiteboard?: { seals: Map<string, Sticker[][]>; attached: Set<string> }; canvasView?: boolean };

const sizing = (v: unknown): { mode: "fixed" | "fit" | "fill"; value?: number } => {
  if (typeof v === "number") return { mode: "fixed", value: v };
  if (typeof v === "string") {
    const m = v.match(/^(fit_content|fill_container)(?:\(\s*(-?[\d.]+)\s*\))?$/);
    if (m) return { mode: m[1] === "fill_container" ? "fill" : "fit", value: m[2] === undefined ? undefined : Number(m[2]) };
  }
  return { mode: "fit" };
};

function sizeCss(s: Style, axis: "width" | "height", raw: unknown, parent: ParentCtx, hasChildren: boolean) {
  const z = sizing(raw);
  const inLayout = parent.layout !== "none" && !parent.root;
  const main = (parent.layout === "horizontal" && axis === "width") || (parent.layout === "vertical" && axis === "height");
  if (z.mode === "fixed") {
    s[axis] = px(z.value as number);
    if (main) s["flex-basis"] = px(z.value as number);
    return;
  }
  if (z.mode === "fill" && inLayout && s.position !== "absolute") {
    if (main) {
      s["flex-grow"] = "1";
      s["flex-basis"] = "0";
      s[axis === "width" ? "min-width" : "min-height"] = "0";
    } else s["align-self"] = "stretch";
    return;
  }
  // fit_content, or fill_container with no layout parent: the fallback number applies when there is nothing to fit.
  if (z.value !== undefined && (z.mode === "fill" || !hasChildren)) s[axis] = px(z.value);
  else s[axis] = axis === "width" ? "max-content" : "auto";
}

function withAlpha(color: string, opacity: number): string {
  if (opacity >= 1 || !color?.startsWith("#")) return color;
  let h = color.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const base = h.slice(0, 6);
  const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
  return `#${base}${Math.round(a * opacity * 255).toString(16).padStart(2, "0")}`;
}

export function gradientCss(f: Record<string, any>): string {
  const op = num(f.opacity) ?? 1;
  const stops = (Array.isArray(f.colors) ? f.colors : []).map((c: any) => `${withAlpha(String(c.color), op)} ${(num(c.position) ?? 0) * 100}%`);
  const list = stops.length ? stops.join(",") : "transparent,transparent";
  const cx = (num(f.center?.x) ?? 0.5) * 100;
  const cy = (num(f.center?.y) ?? 0.5) * 100;
  const w = (num(f.size?.width) ?? 1) * 100;
  const h = (num(f.size?.height) ?? 1) * 100;
  const rot = num(f.rotation) ?? 0;
  if (f.gradientType === "radial") return `radial-gradient(ellipse ${w / 2}% ${h / 2}% at ${cx}% ${cy}%,${list})`;
  if (f.gradientType === "angular") return `conic-gradient(from ${-rot}deg at ${cx}% ${cy}%,${list})`;
  // The file: degrees counter-clockwise, 0 pointing up. CSS: clockwise, 0 pointing up.
  return `linear-gradient(${-rot}deg,${list})`;
}

const asList = (v: unknown): any[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const enabled = (f: any) => !(f && typeof f === "object" && f.enabled === false);

const BLEND: Record<string, string> = { multiply: "multiply", screen: "screen", overlay: "overlay", darken: "darken", light: "lighten", colorDodge: "color-dodge", colorBurn: "color-burn", hardLight: "hard-light", softLight: "soft-light", difference: "difference", exclusion: "exclusion", hue: "hue", saturation: "saturation", color: "color", luminosity: "luminosity" };

function imageSrc(url: string, o: HtmlOptions): string {
  if (/^(https?:|data:)/.test(url)) return url;
  const abs = path.resolve(o.baseDir, url.startsWith("file://") ? new URL(url).pathname : url);
  return o.assetUrl ? o.assetUrl(abs) : pathToFileURL(abs).href;
}

/** WGSL and packed params for a shader fill (src/shader-fill.ts, registered by src/engine.ts: this folder imports nothing outside it). */
export type ShaderResolver = (f: Record<string, unknown>) => { source: string; uniforms: number[] } | { error: string };
let shaderResolver: ShaderResolver | null = null;
export function setShaderResolver(fn: ShaderResolver) {
  shaderResolver = fn;
}
/** Shader fills a document's HTML draws, per render: documentHtml hands them to SHADER_SCRIPT. */
const shaderJobs = new WeakMap<HtmlOptions, { id: string; source: string; uniforms: number[] }[]>();

/**
 * Children with a mask (`mask: true`): the mask is not drawn, the siblings above it are clipped to its shape
 * (a rectangle with its radius or an ellipse at its own place in a free frame). The engine cuts by the mask's alpha
 * (engine/src/paint.rs paint_kids); here paths with a viewBox and polygons clip to their outline, other shapes to the
 * mask's box, and masks in auto layout are left out.
 */
function maskedKids(kids: DocNode[], ctx: ParentCtx, o: HtmlOptions, one: (k: DocNode) => string): string {
  const at = kids.findIndex((k) => k.mask === true && k.enabled !== false);
  if (at < 0) return kids.map(one).join("");
  const m = kids[at];
  const x = num(m.x) ?? 0, y = num(m.y) ?? 0, w = num(m.width) ?? 0, h = num(m.height) ?? 0;
  const r = num(m.cornerRadius) ?? 0;
  const clip = m.type === "ellipse" ? `ellipse(${w / 2}px ${h / 2}px at ${x + w / 2}px ${y + h / 2}px)` : `polygon(${x}px ${y}px, ${x + w}px ${y}px, ${x + w}px ${y + h}px, ${x}px ${y + h}px)`;
  const box = m.type === "ellipse" || !r ? clip : `inset(${y}px calc(100% - ${x + w}px) calc(100% - ${y + h}px) ${x}px round ${r}px)`;
  if (ctx.layout !== "none") {
    // Wrapping the siblings would take them out of the flow: the mask is left out instead.
    o.warnings.push(`${m.id}: a mask in auto layout is not drawn by the HTML renderer`);
    return kids.filter((k) => k !== m).map(one).join("");
  }
  const rest = maskedKids(kids.slice(at + 1), ctx, o, one);
  // Paths and polygons clip to their own outline through an SVG clipPath placed in the frame's space.
  const outline = maskOutline(m, x, y, w, h);
  const id = outline ? `cm${++maskSeq}` : "";
  const defs = outline ? `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><clipPath id="${id}" clipPathUnits="userSpaceOnUse">${outline}</clipPath></defs></svg>` : "";
  return kids.slice(0, at).map(one).join("") + `${defs}<div data-mask="${esc(m.id)}" style="position:absolute;inset:0;pointer-events:none;clip-path:${outline ? `url(#${id})` : box}"><div style="position:absolute;inset:0;pointer-events:auto">${rest}</div></div>`;
}

let maskSeq = 0;

/** A path or polygon mask's outline in the parent frame's space, or "" to clip to the box. */
function maskOutline(m: DocNode, x: number, y: number, w: number, h: number): string {
  if (m.type === "polygon") return `<polygon transform="translate(${x} ${y})" points="${polygonPoints(m, w, h)}"/>`;
  if (m.type !== "path" || typeof m.geometry !== "string" || !Array.isArray(m.viewBox)) return "";
  const [vx, vy, vw, vh] = (m.viewBox as unknown[]).map((v) => num(v) ?? 0);
  if (!vw || !vh) return "";
  return `<path transform="translate(${x} ${y}) scale(${w / vw} ${h / vh}) translate(${-vx} ${-vy})" d="${esc(m.geometry)}" clip-rule="${esc(m.fillRule ?? "nonzero")}"/>`;
}

let adjustSeq = 0;
/**
 * An image fill as HTML: Fill (cover), Fit (contain), Stretch, Crop (the image at its fractions of the box) or Tile
 * (repeated at `scale` x its own size), turned `rotation` (quarter turns) inside the box, with its adjustments
 * (an SVG colour matrix) and blend mode. The engine draws the same (engine/src/paint.rs image_places).
 */
function imageFill(f: any, n: DocNode, o: HtmlOptions, radius: string): string {
  const src = esc(imageSrc(String(f.url), o));
  const op = num(f.opacity);
  const rot = (((Math.round((num(f.rotation) ?? 0) / 90) % 4) + 4) % 4) * 90;
  const blend = typeof f.blendMode === "string" && BLEND[f.blendMode] ? `mix-blend-mode:${BLEND[f.blendMode]};` : "";
  let filter = "", defs = "";
  const adj = adjustValues(f.adjust);
  if (adj) {
    const id = `adj${++adjustSeq}`;
    defs = `<svg width="0" height="0" style="position:absolute"><filter id="${id}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${svgMatrixValues(adjustMatrix(adj))}"/></filter></svg>`;
    filter = `filter:url(#${id});`;
  }
  // The box the image is drawn in: turned a quarter, its width and height swap (container units of the layer).
  const odd = rot % 180 !== 0;
  const turned = rot ? `left:50%;top:50%;width:${odd ? "100cqh" : "100%"};height:${odd ? "100cqw" : "100%"};transform:translate(-50%,-50%) rotate(${rot}deg);` : "inset:0;width:100%;height:100%;";
  const outer = `position:absolute;inset:0;overflow:hidden;container-type:size;${radius}${op !== undefined ? `opacity:${op};` : ""}${blend}`;
  const mode = String(f.mode ?? "fill");
  let inner: string;
  if (mode === "tile") {
    const sc = Math.max(0.01, num(f.scale) ?? 1);
    inner = `<div style="position:absolute;left:0;top:0;width:${100 / sc}%;height:${100 / sc}%;transform:scale(${sc});transform-origin:0 0;background:url(&quot;${src}&quot;) repeat 0 0 / auto;${filter}"></div>`;
  } else if (mode === "crop") {
    const c = f.crop ?? {};
    const x = num(c.x) ?? 0, y = num(c.y) ?? 0, w = num(c.width) ?? 1, h = num(c.height) ?? 1;
    inner = `<img alt="" src="${src}" style="position:absolute;left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;max-width:none;object-fit:fill;${filter}">`;
  } else {
    const fit = mode === "contain" || mode === "fit" ? "contain" : mode === "stretch" ? "fill" : "cover";
    inner = `<img alt="" src="${src}" style="position:absolute;${turned}object-fit:${fit};${filter}">`;
  }
  if (rot && (mode === "tile" || mode === "crop")) inner = `<div style="position:absolute;${turned}container-type:size">${inner}</div>`;
  return `${defs}<div data-img="${esc(n.id)}" style="${outer}">${inner}</div>`;
}

/** Background style for a box, plus <img> layers for image fills and <canvas> layers for shader fills. */
function fillBox(s: Style, n: DocNode, o: HtmlOptions): string {
  const layers: string[] = [];
  const modes: string[] = [];
  let imgs = "";
  const radius = s["border-radius"] ? "border-radius:inherit;" : "";
  const layer = (css: string, f: any) => {
    layers.unshift(css);
    modes.unshift(f && typeof f === "object" && typeof f.blendMode === "string" && BLEND[f.blendMode] ? BLEND[f.blendMode] : "normal");
  };
  for (const f of asList(n.fill).filter(enabled)) {
    if (typeof f === "string") layer(`linear-gradient(${f},${f})`, f);
    else if (f?.type === "color") layer(`linear-gradient(${f.color},${f.color})`, f);
    else if (f?.type === "gradient") layer(gradientCss(f), f);
    else if (f?.type === "image" && f.url) {
      imgs += imageFill(f, n, o, radius);
    } else if (f?.type === "mesh_gradient" && Array.isArray(f.colors) && f.colors.length) {
      o.warnings.push(`${n.id}: mesh gradient drawn as a plain gradient`);
      layer(`linear-gradient(135deg,${f.colors.join(",")})`, f);
    } else if (f?.type === "shader") {
      // A still at t = 2 s (a shader card's poster frame), drawn by WebGPU in the page (SHADER_SCRIPT).
      const r = shaderResolver ? shaderResolver(f) : { error: "no shader resolver" };
      if ("error" in r) { o.warnings.push(`${n.id}: shader fill not drawn: ${r.error}`); continue; }
      let jobs = shaderJobs.get(o);
      if (!jobs) shaderJobs.set(o, (jobs = []));
      const op = num(f.opacity);
      imgs += `<canvas data-shader="${jobs.length}" style="position:absolute;inset:0;width:100%;height:100%;${radius}${op !== undefined ? `opacity:${op};` : ""}"></canvas>`;
      jobs.push({ id: String(n.id), source: r.source, uniforms: r.uniforms });
    }
  }
  if (layers.length) s.background = layers.join(",");
  if (modes.some((m) => m !== "normal")) s["background-blend-mode"] = modes.join(",");
  return imgs;
}

function firstColor(v: unknown): string | undefined {
  for (const f of asList(v).filter(enabled)) {
    if (typeof f === "string") return f;
    if (f?.type === "color") return f.color;
    if (f?.type === "gradient" && Array.isArray(f.colors) && f.colors[0]) return f.colors[0].color;
  }
  return undefined;
}

function strokeBox(s: Style, n: DocNode): string {
  const list = asList(n.stroke).filter(enabled);
  if (!list.length || n.strokeWidth === undefined) return "";
  const align = String(n.strokeAlignment ?? "inner");
  const w = n.strokeWidth as any;
  const uniform = typeof w === "number";
  const solid = typeof list[0] === "string" || list[0]?.type === "color";
  if (uniform && solid) {
    if (!w) return "";
    const color = typeof list[0] === "string" ? list[0] : list[0].color;
    s.outline = `${px(w)} solid ${color}`;
    s["outline-offset"] = px(align === "inner" ? -w : align === "center" ? -w / 2 : 0);
    return "";
  }
  // Per-side widths or a gradient stroke: an overlay that does not take part in layout.
  const side = (k: string) => (uniform ? w : (num(w?.[k]) ?? 0));
  const out = (k: string) => (align === "inner" ? 0 : align === "center" ? -side(k) / 2 : -side(k));
  const inset = `${px(out("top"))} ${px(out("right"))} ${px(out("bottom"))} ${px(out("left"))}`;
  const widths = `${px(side("top"))} ${px(side("right"))} ${px(side("bottom"))} ${px(side("left"))}`;
  const paint = list[0]?.type === "gradient" ? gradientCss(list[0]) : `linear-gradient(${firstColor(list)},${firstColor(list)})`;
  return `<div style="position:absolute;inset:${inset};border-radius:inherit;padding:${widths};background:${paint};mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);pointer-events:none"></div>`;
}

function effects(s: Style, n: DocNode, boxy: boolean) {
  const shadows: string[] = [];
  const filters: string[] = [];
  for (const e of asList(n.effect).filter(enabled) as any[]) {
    if (e?.type === "shadow") {
      const x = num(e.offset?.x) ?? 0;
      const y = num(e.offset?.y) ?? 0;
      const blur = num(e.blur) ?? 0;
      const spread = num(e.spread) ?? 0;
      const color = e.color ?? "#00000040";
      if (boxy) shadows.push(`${e.shadowType === "inner" ? "inset " : ""}${px(x)} ${px(y)} ${px(blur)} ${px(spread)} ${color}`);
      else filters.push(`drop-shadow(${px(x)} ${px(y)} ${px(blur / 2)} ${color})`);
    } else if (e?.type === "blur") filters.push(`blur(${px((num(e.radius) ?? 0) / 2)})`);
    else if (e?.type === "background_blur") s["backdrop-filter"] = `blur(${px((num(e.radius) ?? 0) / 2)})`;
  }
  if (shadows.length) s["box-shadow"] = shadows.join(",");
  if (filters.length) s.filter = filters.join(" ");
}

function padding(v: unknown): string | undefined {
  if (typeof v === "number") return px(v);
  if (Array.isArray(v)) {
    const a = v.map((x) => (typeof x === "number" ? x : 0));
    if (a.length === 2) return `${px(a[0])} ${px(a[1])}`;
    if (a.length === 4) return a.map(px).join(" ");
  }
  return undefined;
}

const JUSTIFY: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", space_between: "space-between", space_around: "space-around" };
const ALIGN: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end" };

function textStyle(s: Style, n: DocNode, families: Set<string>) {
  const fam = n.fontFamily ? String(n.fontFamily) : "Inter";
  families.add(fam);
  s["font-family"] = `"${fam.replace(/"/g, "")}",system-ui,sans-serif`;
  if (num(n.fontSize) !== undefined) s["font-size"] = px(n.fontSize as number);
  if (n.fontWeight !== undefined) s["font-weight"] = String(n.fontWeight);
  if (typeof n.fontStyle === "string" && /italic/i.test(n.fontStyle)) s["font-style"] = "italic";
  if (num(n.letterSpacing) !== undefined) s["letter-spacing"] = px(n.letterSpacing as number);
  if (num(n.lineHeight) !== undefined) s["line-height"] = String(n.lineHeight);
  const deco = [n.underline === true ? "underline" : "", n.strikethrough === true ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) s["text-decoration"] = deco;
  if (typeof n.textAlign === "string") s["text-align"] = n.textAlign;
  // Letter case (`letterCase`): the letters drawn in their case, the file keeps them as typed (src/page/text-paras.js).
  const lc = caseCss(n as Record<string, unknown>);
  if (lc.textTransform !== "none") s["text-transform"] = lc.textTransform;
  if (lc.fontFeatureSettings !== "normal") s["font-feature-settings"] = lc.fontFeatureSettings;
}

/**
 * A text's letters with its styled ranges (src/page/text-spans.js) as spans of their own; plain text when it has
 * none. Offsets are UTF-16, as String.slice counts. A text with a gradient fill keeps one paint (no span colours).
 */
function textBody(n: DocNode, families: Set<string>, gradient: boolean): string {
  const content = String(n.content ?? "");
  if (hasParagraphs(n)) return paragraphsBody(n, content, families, gradient);
  return runsHtml(n, content, 0, content.length, families, gradient);
}

/**
 * Paragraph spacing, indent and lists (src/page/text-paras.js): one block per paragraph, its space above as a top
 * margin, its first line's start as text-indent, a list item's lines a hanging indent with the marker beside the first
 * (a real letter, so SVG export keeps it) in its item's first letter's colour. A hanging opening quote sits in a box
 * of no width whose letter runs out to the left (flex-end), so the letter after it starts where the line does. A final
 * newline makes no paragraph, as in CSS `pre`.
 */
function paragraphsBody(n: DocNode, content: string, families: Set<string>, gradient: boolean): string {
  const size = num(n.fontSize) ?? 13;
  const plan = paragraphPlan(n as Record<string, unknown>, content, size);
  const starts = paragraphStarts(content);
  const last = content.endsWith("\n") ? starts.length - 1 : starts.length;
  let out = "";
  for (let p = 0; p < last; p++) {
    const a = starts[p], b = p + 1 < starts.length ? starts[p + 1] - 1 : content.length;
    const pl = plan[p];
    const s: Style = { position: "relative" };
    if (pl.before) s["margin-top"] = px(pl.before);
    if (pl.rest) s["padding-left"] = px(pl.rest);
    s["text-indent"] = px(pl.first - pl.rest);
    const color = gradient ? null : markerColor(n as Record<string, unknown>, content, a);
    const mark = pl.marker ? `<span style="position:absolute;left:${px(pl.markerX)};text-indent:0;text-decoration:none${color ? `;color:${color}` : ""}">${esc(pl.marker)}</span>` : "";
    const hang = pl.hang && b > a ? `<span style="display:inline-flex;width:0;justify-content:flex-end;text-indent:0">${runsHtml(n, content, a, a + 1, families, gradient)}</span>` : "";
    out += `<div style="${esc(css(s))}">${mark}${hang}${b > a ? runsHtml(n, content, hang ? a + 1 : a, b, families, gradient) : "<br>"}</div>`;
  }
  return out;
}

let starts: [string, Set<number>] = ["", new Set()];
/**
 * The letters [from, to) of a text, escaped. Title case: each word's first letter in a span drawn in upper case
 * (src/page/text-paras.js wordStarts, the engine's rule).
 */
function letters(n: DocNode, content: string, from: number, to: number): string {
  if (n.letterCase !== "title" || to <= from) return esc(content.slice(from, to));
  if (starts[0] !== content) starts = [content, new Set(wordStarts(content))];
  let out = "", at = from;
  for (let i = from; i < to; i++) {
    if (!starts[1].has(i)) continue;
    const len = content.codePointAt(i)! > 0xffff ? 2 : 1;
    out += esc(content.slice(at, i)) + `<span style="text-transform:uppercase">${esc(content.slice(i, i + len))}</span>`;
    at = i + len;
  }
  return out + esc(content.slice(at, to));
}

/** The letters [from, to) of a text with its styled ranges as spans of their own. */
function runsHtml(n: DocNode, content: string, from: number, to: number, families: Set<string>, gradient: boolean): string {
  const spans = Array.isArray(n.spans) ? (n.spans as Record<string, unknown>[]).filter((s) => s && typeof s.start === "number" && typeof s.end === "number" && (s.end as number) > (s.start as number)) : [];
  if (!spans.length) return letters(n, content, from, to);
  let out = "", at = from;
  for (const sp of [...spans].sort((a, b) => (a.start as number) - (b.start as number))) {
    const a = Math.max(at, Math.min(to, sp.start as number)), b = Math.min(to, sp.end as number);
    if (b <= a) continue;
    out += letters(n, content, at, a);
    const s: Style = {};
    if (typeof sp.fontFamily === "string" && sp.fontFamily) { families.add(sp.fontFamily); s["font-family"] = `"${sp.fontFamily.replace(/"/g, "")}",system-ui,sans-serif`; }
    if (num(sp.fontSize) !== undefined) s["font-size"] = px(sp.fontSize as number);
    if (sp.fontWeight !== undefined && sp.fontWeight !== null) s["font-weight"] = String(sp.fontWeight);
    if (typeof sp.fontStyle === "string") s["font-style"] = /italic/i.test(sp.fontStyle) ? "italic" : "normal";
    if (num(sp.letterSpacing) !== undefined) s["letter-spacing"] = px(sp.letterSpacing as number);
    if (!gradient && typeof sp.fill === "string" && /^#[0-9a-f]{3,8}$/i.test(sp.fill)) s.color = sp.fill;
    if (sp.underline !== undefined || sp.strikethrough !== undefined) {
      const u = sp.underline ?? n.underline, st = sp.strikethrough ?? n.strikethrough;
      s["text-decoration"] = [u === true ? "underline" : "", st === true ? "line-through" : ""].filter(Boolean).join(" ") || "none";
    }
    out += `<span style="${esc(Object.entries(s).map(([k, v]) => `${k}:${v}`).join(";"))}">${letters(n, content, a, b)}</span>`;
    at = b;
  }
  return out + letters(n, content, at, to);
}

function ellipsePath(n: DocNode, w: number, h: number): string {
  const inner = Math.min(num(n.innerRadius) ?? 0, 0.999);
  const start = ((num(n.startAngle) ?? 0) * Math.PI) / 180;
  const sweep = Math.max(-360, Math.min(360, num(n.sweepAngle) ?? 360));
  const rad = (sweep * Math.PI) / 180;
  const rx = w / 2;
  const ry = h / 2;
  const pt = (a: number, k: number) => `${rx + k * rx * Math.cos(a)} ${ry - k * ry * Math.sin(a)}`;
  if (Math.abs(sweep) >= 360) {
    const ring = (k: number) => (k > 0 ? `M${rx - k * rx} ${ry}a${k * rx} ${k * ry} 0 1 0 ${2 * k * rx} 0a${k * rx} ${k * ry} 0 1 0 ${-2 * k * rx} 0Z` : "");
    return ring(1) + ring(inner);
  }
  const large = Math.abs(sweep) > 180 ? 1 : 0;
  const ccw = sweep > 0 ? 0 : 1; // SVG sweep flag: y points down
  const end = start + rad;
  const inward = inner > 0 ? `L${pt(end, inner)}A${inner * rx} ${inner * ry} 0 ${large} ${ccw ? 0 : 1} ${pt(start, inner)}` : `L${rx} ${ry}`;
  return `M${pt(start, 1)}A${rx} ${ry} 0 ${large} ${ccw} ${pt(end, 1)}${inward}Z`;
}

function polygonPoints(n: DocNode, w: number, h: number): string {
  const count = Math.max(3, Math.round(num(n.polygonCount) ?? 3));
  const pts: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    pts.push(`${w / 2 + (w / 2) * Math.cos(a)},${h / 2 + (h / 2) * Math.sin(a)}`);
  }
  return pts.join(" ");
}

function svgPaint(n: DocNode, s: Style): { fill: string; defs: string; stroke: string } {
  const c = firstColor(n.fill);
  const strokeColor = firstColor(n.stroke);
  const w = typeof n.strokeWidth === "number" ? n.strokeWidth : 0;
  const stroke = strokeColor && w ? ` stroke="${esc(strokeColor)}" stroke-width="${w}" vector-effect="non-scaling-stroke"${n.strokeLinecap ? ` stroke-linecap="${esc(n.strokeLinecap)}"` : ""}${n.strokeLinejoin ? ` stroke-linejoin="${esc(n.strokeLinejoin)}"` : ""}` : "";
  // Gradient fills on vector shapes go through a CSS mask so they keep the shape's outline.
  const grad = asList(n.fill).filter(enabled).find((f: any) => f?.type === "gradient");
  if (grad) s["--grad"] = gradientCss(grad);
  return { fill: c ?? "none", defs: "", stroke };
}

function stickerHtml(group: Sticker[], position: string): string {
  const { id, kind } = group[0];
  const art = STICKERS[kind], white = WHITEBOARD_PAINT.white, ink = WHITEBOARD_PAINT.ink;
  const count = group.length > 1 ? `<div data-id="${esc(id)}/:count" style="position:absolute;top:-4px;right:-5px;min-width:16px;height:16px;border-radius:8px;background:${ink};color:${white};font:600 11px/16px system-ui;text-align:center">${group.length}</div>` : "";
  return `<div data-id="${esc(id)}" data-t="sticker" data-name="${esc(art.label)}" style="${position};width:${STICKER_SIZE}px;height:${STICKER_SIZE}px;box-sizing:border-box;border-radius:50%;background:${art.color};color:${white};box-shadow:inset 0 0 0 2px ${white},0 3px 8px ${WHITEBOARD_PAINT.shadow};display:grid;place-items:center">${stickerGlyph(kind)}${count}</div>`;
}

function appendedStickers(id: string, o: HtmlOptions): string {
  return (o.whiteboard?.seals.get(id) ?? []).map((group) => {
    const { x, y } = group[0].on;
    const position = `position:absolute;left:calc(${x * 100}% - ${STICKER_SIZE / 2}px);top:calc(${y * 100}% - ${STICKER_SIZE / 2}px);z-index:1`;
    const seal = stickerHtml(group, position);
    // Each design node can be exported by id. The aliases have the seal's box and are transparent during a board export.
    const aliases = group.slice(1).map((s) => `<div data-id="${esc(s.id)}" data-sticker-alias="${esc(group[0].id)}" style="${position};width:${STICKER_SIZE}px;height:${STICKER_SIZE}px"></div>`).join("");
    return seal + aliases;
  }).join("");
}

export function nodeHtml(raw: DocNode, parent: ParentCtx, o: HtmlOptions, families: Set<string>, theme: Theme): string {
  if (raw.enabled === false) return "";
  const activeTheme: Theme = raw.theme ? { ...theme, ...(raw.theme as Theme) } : theme;
  const resolved = resolveProps(o.doc, raw, activeTheme, o.warnings);
  if (resolved.enabled === false) return "";
  if (resolved.type === "sticker") {
    const sticker = stickerData(resolved);
    if (!sticker || o.whiteboard?.attached.has(sticker.id)) return "";
    if (o.canvasView) return `<div data-id="${esc(sticker.id)}" data-t="sticker" style="position:absolute;width:0;height:0;pointer-events:none"></div>`;
    const { x: left, y: top } = sticker;
    return stickerHtml([sticker], parent.root ? "position:relative" : `position:absolute;left:${left}px;top:${top}px`);
  }
  const n = resolved.type === "sticky" ? stickyFrame(resolved) : resolved;
  const body = renderNodeHtml(n, resolved, parent, o, families, activeTheme);
  const stickers = appendedStickers(String(n.id), o);
  return stickers && body.endsWith("</div>") ? body.slice(0, -6) + stickers + "</div>" : body;
}

function renderNodeHtml(n: DocNode, raw: DocNode, parent: ParentCtx, o: HtmlOptions, families: Set<string>, activeTheme: Theme): string {
  const type = String(n.type);
  const s: Style = { "box-sizing": "border-box", "flex-shrink": "0" };
  const absolute = !parent.root && (parent.layout === "none" || n.layoutPosition === "absolute");
  s.position = absolute ? "absolute" : "relative";
  if (absolute) {
    s.left = px(num(n.x) ?? 0);
    s.top = px(num(n.y) ?? 0);
  }
  if (parent.root) s.display = "block";
  if (num(n.opacity) !== undefined) s.opacity = String(n.opacity);
  if (typeof n.blendMode === "string" && BLEND[n.blendMode]) s["mix-blend-mode"] = BLEND[n.blendMode];
  // Locked: the canvas's pointer goes through it and its children to what is under them.
  if (n.locked === true) s["pointer-events"] = "none";
  const tf: string[] = [];
  if (num(n.rotation)) tf.push(`rotate(${-(n.rotation as number)}deg)`);
  if (n.flipX === true) tf.push("scaleX(-1)");
  if (n.flipY === true) tf.push("scaleY(-1)");
  if (tf.length) {
    s.transform = tf.join(" ");
    s["transform-origin"] = "0 0";
  }
  const r = n.cornerRadius;
  if (typeof r === "number" && r > 0) s["border-radius"] = px(r);
  else if (Array.isArray(r)) s["border-radius"] = r.map((x) => px(typeof x === "number" ? x : 0)).join(" ");

  const attrs: string[] = [`data-id="${esc(n.id)}"`, `data-t="${esc(type)}"`];
  if (o.layerNames && n.name) attrs.push(`data-name="${esc(n.name)}"`);
  if (n.locked === true) attrs.push(`data-locked="1"`);
  const kids = Array.isArray(raw.type === "sticky" ? n.children : raw.children) ? (raw.type === "sticky" ? n.children! : raw.children!) : [];
  const open = () => `<div ${attrs.join(" ")} style="${esc(css(s))}">`;

  if (type === "frame" || type === "group") {
    const layout = type === "group" ? "none" : ((n.layout as string) ?? "horizontal");
    const ctx: ParentCtx = { layout: layout === "vertical" ? "vertical" : layout === "none" ? "none" : "horizontal" };
    if (ctx.layout !== "none") {
      s.display = "flex";
      s["flex-direction"] = ctx.layout === "vertical" ? "column" : "row";
      s["justify-content"] = JUSTIFY[String(n.justifyContent)] ?? "flex-start";
      s["align-items"] = ALIGN[String(n.alignItems)] ?? "flex-start";
      if (num(n.gap)) s.gap = px(n.gap as number);
    }
    if (raw.type === "sticky") {
      attrs[1] = 'data-t="sticky"';
      const layout = n.canvasLayout as Record<string, Json> | undefined;
      if (typeof layout?.minHeight === "number") s["min-height"] = px(layout.minHeight);
    }
    const p = padding(n.padding);
    if (p) s.padding = p;
    const needsFit = type === "group" || (ctx.layout === "none" && sizing(n.width).mode !== "fixed") || (ctx.layout === "none" && sizing(n.height).mode !== "fixed");
    if (needsFit) attrs.push(`data-fit="${type === "group" || sizing(n.width).mode !== "fixed" ? "w" : ""}${type === "group" || sizing(n.height).mode !== "fixed" ? "h" : ""}"`);
    if (type === "frame") {
      sizeCss(s, "width", n.width, parent, kids.length > 0);
      sizeCss(s, "height", n.height, parent, kids.length > 0);
    }
    if (n.clip === true) {
      s.overflow = "hidden";
      attrs.push(`data-clip="1"`);
    }
    effects(s, n, type === "frame");
    const imgs = type === "frame" ? fillBox(s, n, o) : "";
    const over = type === "frame" ? strokeBox(s, n) : "";
    const inner = maskedKids(kids, ctx, o, (k) => nodeHtml(k, ctx, o, families, activeTheme));
    return `${open()}${imgs}${inner}${over}</div>`;
  }

  if (type === "text" || type === "note" || type === "prompt" || type === "context") {
    textStyle(s, n, families);
    const growth = type === "text" ? String(n.textGrowth ?? "auto") : "fixed-width-height";
    if (growth === "auto") s["white-space"] = "pre";
    else {
      s["white-space"] = "pre-wrap";
      s["overflow-wrap"] = "break-word";
      sizeCss(s, "width", n.width, parent, false);
      if (growth === "fixed-width-height") sizeCss(s, "height", n.height, parent, false);
    }
    // Truncate text: an ellipsis after Max lines, or where a fixed-size box ends.
    if (type === "text" && n.textTruncation === "ending") {
      const lines = num(n.maxLines);
      s.overflow = "hidden";
      if (lines !== undefined && lines >= 1) { s.display = "-webkit-box"; s["-webkit-box-orient"] = "vertical"; s["-webkit-line-clamp"] = String(Math.floor(lines)); }
      else if (growth === "auto") s["text-overflow"] = "ellipsis";
    }
    if (typeof n.textAlignVertical === "string" && n.textAlignVertical !== "top" && growth === "fixed-width-height" && s.display !== "-webkit-box") {
      s.display = "flex";
      s["flex-direction"] = "column";
      s["justify-content"] = n.textAlignVertical === "middle" ? "center" : "flex-end";
    }
    if (type !== "text") {
      s.background = type === "note" ? "#FEF3C7" : "#EDE9FE";
      s.padding = "12px";
      s.color = "#18181B";
    } else {
      const fills = asList(n.fill).filter(enabled);
      const grad = fills.find((f: any) => f?.type === "gradient");
      if (grad) {
        s.background = gradientCss(grad);
        s["-webkit-background-clip"] = "text";
        s["background-clip"] = "text";
        s.color = "transparent";
      } else s.color = firstColor(n.fill) ?? "#000000";
      const stroke = firstColor(n.stroke);
      if (stroke && typeof n.strokeWidth === "number" && n.strokeWidth) s["-webkit-text-stroke"] = `${px(n.strokeWidth)} ${stroke}`;
    }
    effects(s, n, false);
    return `${open()}${type === "text" ? textBody(n, families, asList(n.fill).filter(enabled).some((f: any) => f?.type === "gradient")) : esc(n.content)}</div>`;
  }

  // Everything below has a plain box.
  sizeCss(s, "width", n.width ?? 0, parent, false);
  sizeCss(s, "height", n.height ?? 0, parent, false);

  if (type === "rectangle") {
    const imgs = fillBox(s, n, o);
    const over = strokeBox(s, n);
    effects(s, n, true);
    return `${open()}${imgs}${over}</div>`;
  }

  if (type === "ellipse") {
    const simple = !num(n.innerRadius) && (num(n.sweepAngle) === undefined || Math.abs(n.sweepAngle as number) >= 360);
    if (simple) {
      s["border-radius"] = "50%";
      const imgs = fillBox(s, n, o);
      const over = strokeBox(s, n);
      effects(s, n, true);
      return `${open()}${imgs}${over}</div>`;
    }
    const w = num(n.width) ?? 100;
    const h = num(n.height) ?? 100;
    const p = svgPaint(n, s);
    effects(s, n, false);
    return `${open()}<svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;overflow:visible"><path d="${esc(ellipsePath(n, w, h))}" fill-rule="evenodd" fill="${esc(p.fill)}"${p.stroke}/></svg></div>`;
  }

  if (type === "polygon") {
    const w = num(n.width) ?? 100;
    const h = num(n.height) ?? 100;
    const p = svgPaint(n, s);
    effects(s, n, false);
    return `${open()}<svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;overflow:visible"><polygon points="${polygonPoints(n, w, h)}" fill="${esc(p.fill)}"${p.stroke}/></svg></div>`;
  }

  if (type === "path") {
    const p = svgPaint(n, s);
    effects(s, n, false);
    const vb = Array.isArray(n.viewBox) ? (n.viewBox as number[]).join(" ") : "";
    return `${open()}<svg width="100%" height="100%" ${vb ? `viewBox="${esc(vb)}"` : `data-tight="1"`} preserveAspectRatio="none" style="display:block;overflow:visible"><path d="${esc(n.geometry)}" fill="${esc(p.fill)}" fill-rule="${esc(n.fillRule ?? "nonzero")}"${p.stroke}/></svg></div>`;
  }

  if (type === "icon") {
    if (n.width === undefined) s.width = "24px";
    if (n.height === undefined) s.height = "24px";
    effects(s, n, false);
    const color = firstColor(n.fill) ?? "#000000";
    const art = iconArt(String(n.library ?? "lucide"), String(n.icon ?? ""));
    if (!art) {
      o.warnings.push(`${n.id}: no icon "${n.icon}" in ${n.library}`);
      return `${open()}</div>`;
    }
    s.color = color;
    const weight = num(n.weight);
    const body = weight ? art.body.replace(/stroke-width="[\d.]+"/g, `stroke-width="${(2 * weight) / 400}"`) : art.body;
    return `${open()}<svg width="100%" height="100%" viewBox="0 0 ${art.size} ${art.size}" style="display:block">${body}</svg></div>`;
  }

  o.warnings.push(`${n.id}: ${type} nodes are drawn as a placeholder`);
  s.background = "#F4F4F5";
  return `${open()}</div>`;
}

const SYSTEM_FONT = /^(SF Pro|San Francisco|Helvetica|Arial|Times|Georgia|Courier|Menlo|system-ui)/i;

/** Fonts a page needs: @font-face rules for the document's own fonts, Google Fonts stylesheets for anything else. */
export function fontAssets(o: HtmlOptions, families: Set<string>): { faces: string; links: string[] } {
  const faces = (Array.isArray(o.doc.fonts) ? (o.doc.fonts as Record<string, Json>[]) : [])
    .filter((f) => families.has(String(f.name)))
    .map((f) => `@font-face{font-family:"${esc(f.name)}";src:url("${esc(imageSrc(String(f.url), o))}");${f.style ? `font-style:${esc(f.style)};` : ""}${f.weight ? `font-weight:${esc(f.weight)};` : ""}}`)
    .join("");
  const custom = new Set((Array.isArray(o.doc.fonts) ? (o.doc.fonts as Record<string, Json>[]) : []).map((f) => String(f.name)));
  const links = [...families]
    .filter((f) => !custom.has(f) && !SYSTEM_FONT.test(f))
    .flatMap((f) => {
      const q = encodeURIComponent(f).replace(/%20/g, "+");
      return [`https://fonts.googleapis.com/css2?family=${q}:ital,wght@0,100..900;1,100..900&display=block`, `https://fonts.googleapis.com/css2?family=${q}:wght@400;500;600;700&display=block`];
    });
  return { faces, links };
}

/** Page CSS: fonts from the document, Google Fonts for anything else, then the layout script. */
export function pageHead(o: HtmlOptions, families: Set<string>): string {
  const { faces, links } = fontAssets(o, families);
  return `<meta charset="utf-8">${links.map((l) => `<link rel="stylesheet" href="${esc(l)}">`).join("")}<style>html,body{margin:0;padding:0;background:transparent}body{width:max-content}.stage{display:flow-root;width:max-content;margin:0 0 40px 0}${faces}</style>`;
}

/** Runs in the page after the browser lays out: fit vector viewBoxes to their art and size groups to their children. `k` is the page's zoom, if it has one. */
export const FIT_SCRIPT = `window.__fit=function(root,k){k=k||1;
  for(const svg of root.querySelectorAll('svg[data-tight]')){const b=svg.firstElementChild.getBBox();if(b.width||b.height)svg.setAttribute('viewBox',[b.x,b.y,b.width||1,b.height||1].join(' '));}
  const fits=[...root.querySelectorAll('[data-fit]')].reverse();
  for(const el of fits){const f=el.dataset.fit;const r=el.getBoundingClientRect();let maxX=0,maxY=0;
    for(const c of el.children){const q=c.getBoundingClientRect();maxX=Math.max(maxX,q.right-r.left);maxY=Math.max(maxY,q.bottom-r.top);}
    if(f.includes('w'))el.style.width=maxX/k+'px';if(f.includes('h'))el.style.height=maxY/k+'px';}
};`;

/** Runs in the page: wait for fonts and images, size groups, read every node's box. */
export const LAYOUT_SCRIPT = `${FIT_SCRIPT}
window.__layout=async function(){
  const wait=(p,ms)=>Promise.race([p,new Promise(r=>setTimeout(r,ms))]);
  await wait(document.fonts.ready,4000);
  await wait(Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))),8000);
  if(window.__shaders)await wait(window.__shaders().catch(e=>console.warn('shader fill',e)),8000);
  window.__fit(document);
  const out={};const sx=window.scrollX,sy=window.scrollY;
  // A group's box is the union of its layers' boxes, turned ones included (the engine's, layout.rs): a layer left of or above the group's own corner is inside it.
  const box=(el)=>{const r=el.getBoundingClientRect();if(el.dataset.t!=='group')return r;let l=Infinity,t=Infinity,rt=-Infinity,b=-Infinity;
    for(const c of el.children){if(!c.dataset||c.dataset.id===undefined)continue;const q=box(c);l=Math.min(l,q.left);t=Math.min(t,q.top);rt=Math.max(rt,q.right);b=Math.max(b,q.bottom);}
    return l===Infinity?r:{left:l,top:t,right:rt,bottom:b,width:rt-l,height:b-t};};
  for(const el of document.querySelectorAll('[data-id]')){const r=box(el);const p=el.parentElement.closest('[data-id]');const q=p?p.getBoundingClientRect():null;
    let problems;let a=el.parentElement;const area=r.width*r.height;
    while(a&&a.closest){a=a.closest('[data-clip]');if(!a)break;const k=a.getBoundingClientRect();const ix=Math.min(r.right,k.right)-Math.max(r.left,k.left);const iy=Math.min(r.bottom,k.bottom)-Math.max(r.top,k.top);
      if(ix<=0||iy<=0){problems='fully clipped';break;}if(ix<r.width-0.5||iy<r.height-0.5)problems='partially clipped';a=a.parentElement;}
    out[el.dataset.id]={x:q?r.left-q.left:0,y:q?r.top-q.top:0,width:r.width,height:r.height,pageX:r.left+sx,pageY:r.top+sy,...(problems?{problems}:{})};}
  return out;};`;

function whiteboardExport(roots: DocNode[], doc: CanvasDoc): HtmlOptions["whiteboard"] {
  const visit = (nodes: DocNode[], take: (node: DocNode) => void) => {
    for (const node of nodes) {
      if (node.enabled === false) continue;
      take(node);
      if (node.children) visit(node.children, take);
    }
  };
  const all = new Map<string, Sticker>();
  const collect = (node: DocNode) => {
    const sticker = stickerData(node);
    if (sticker) all.set(sticker.id, sticker);
  };
  visit(doc.children, collect);
  visit(roots, collect);
  if (!all.size) return undefined;
  const seen = new Set<string>();
  visit(roots, (node) => { if (node.type !== "sticker") seen.add(String(node.id)); });
  const seals = new Map<string, Sticker[][]>(), attached = new Set<string>();
  for (const group of stackStickers(all.values()).values()) {
    const id = group[0].on.layer;
    if (!seen.has(id)) continue;
    const existing = seals.get(id);
    if (existing) existing.push(group);
    else seals.set(id, [group]);
    for (const member of group) attached.add(member.id);
  }
  return { seals, attached };
}

export function documentHtml(roots: DocNode[], o: HtmlOptions): string {
  const whiteboard = whiteboardExport(roots, o.doc);
  if (whiteboard) o = { ...o, whiteboard };
  const families = new Set<string>();
  const bodies = roots.map((r) => `<div class="stage">${nodeHtml(r, { layout: "none", root: true }, o, families, o.theme)}</div>`).join("");
  const jobs = shaderJobs.get(o);
  const shaders = jobs && jobs.length ? `<script>window.__shaderJobs=${JSON.stringify(jobs).replace(/</g, "\\u003c")};window.__noise="${noiseBase64()}";${SHADER_SCRIPT}</script>` : "";
  return `<!doctype html><html><head>${pageHead(o, families)}<script>${LAYOUT_SCRIPT}</script>${shaders}</head><body>${bodies}</body></html>`;
}

// ---------------------------------------------------------------- shader fills

let noiseB64: string | null = null;
/** Paper Shaders' 128 px noise texture (engine/src/paper_noise.rgba), for canvas_noise(). */
function noiseBase64(): string {
  if (noiseB64 === null) {
    try {
      noiseB64 = fs.readFileSync(new URL("../../../engine/src/paper_noise.rgba", import.meta.url)).toString("base64");
    } catch {
      noiseB64 = "";
    }
  }
  return noiseB64;
}

/**
 * Draws every <canvas data-shader> once, at t = 2 s, with the engine's wrapper (engine/src/shaders.rs WRAPPER: the
 * same uniforms, entry points and noise texture), into a texture read back to the canvas as straight-alpha pixels.
 * Without WebGPU the canvases stay empty (the layer's other fills show).
 */
export const SHADER_SCRIPT = `window.__shaders=async function(){
  const els=[...document.querySelectorAll('canvas[data-shader]')];
  if(!els.length||!navigator.gpu)return;
  const ad=await navigator.gpu.requestAdapter();if(!ad)return;
  const dev=await ad.requestDevice();
  const WRAP=\`
struct CanvasUniforms { resolution: vec2<f32>, time: f32, delta: f32, mouse: vec4<f32>, canvas_texel: vec2<f32>, frame: f32, canvas_pad: f32, params: array<vec4<f32>, 32>, };
@group(0) @binding(0) var<uniform> u: CanvasUniforms;
@group(0) @binding(1) var canvas_noise_tex: texture_2d<f32>;
@group(0) @binding(2) var canvas_noise_smp: sampler;
fn canvas_noise(uv: vec2<f32>) -> vec4<f32> { return textureSampleLevel(canvas_noise_tex, canvas_noise_smp, uv, 0.0); }
@vertex fn canvas_vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var c = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(c[i], 0.0, 1.0);
}
@fragment fn canvas_fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let c = shade(pos.xy * u.canvas_texel);
  return clamp(c, vec4<f32>(0.0), vec4<f32>(1.0));
}\`;
  const nb=atob(window.__noise||''),N=128,noise=dev.createTexture({size:[N,N],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  if(nb.length===N*N*4){const a=new Uint8Array(nb.length);for(let i=0;i<a.length;i++)a[i]=nb.charCodeAt(i);dev.queue.writeTexture({texture:noise},a,{bytesPerRow:N*4},[N,N]);}
  const smp=dev.createSampler({magFilter:'linear',minFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
  const bgl=dev.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},{binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},{binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}]});
  const layout=dev.createPipelineLayout({bindGroupLayouts:[bgl]});
  for(const el of els){
    const job=window.__shaderJobs[+el.dataset.shader];if(!job)continue;
    const w=el.offsetWidth,h=el.offsetHeight;if(w<1||h<1)continue;
    const k=Math.min(3,2048/Math.max(w,h)),tw=Math.max(1,Math.round(w*k)),th=Math.max(1,Math.round(h*k));
    const mod=dev.createShaderModule({code:job.source+'\\n'+WRAP});
    const info=await mod.getCompilationInfo();if(info.messages.some(m=>m.type==='error')){console.warn('shader fill',job.id,info.messages.map(m=>m.message).join('; '));continue;}
    const pipe=dev.createRenderPipeline({layout,vertex:{module:mod,entryPoint:'canvas_vs'},fragment:{module:mod,entryPoint:'canvas_fs',targets:[{format:'rgba8unorm'}]}});
    const u=new Float32Array(12+128);u[0]=w;u[1]=h;u[2]=2;u[3]=0;u[8]=w/tw;u[9]=h/th;u[10]=60;u.set(job.uniforms.slice(0,128),12);
    const ub=dev.createBuffer({size:u.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});dev.queue.writeBuffer(ub,0,u);
    const bg=dev.createBindGroup({layout:bgl,entries:[{binding:0,resource:{buffer:ub}},{binding:1,resource:noise.createView()},{binding:2,resource:smp}]});
    const tex=dev.createTexture({size:[tw,th],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
    const row=Math.ceil(tw*4/256)*256,out=dev.createBuffer({size:row*th,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const enc=dev.createCommandEncoder();
    const pass=enc.beginRenderPass({colorAttachments:[{view:tex.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});
    pass.setPipeline(pipe);pass.setBindGroup(0,bg);pass.draw(3);pass.end();
    enc.copyTextureToBuffer({texture:tex},{buffer:out,bytesPerRow:row},[tw,th]);
    dev.queue.submit([enc.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    const src=new Uint8Array(out.getMappedRange()),px=new Uint8ClampedArray(tw*th*4);
    for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const i=y*row+x*4,o=(y*tw+x)*4,a=src[i+3];
      if(a){px[o]=Math.min(255,src[i]*255/a);px[o+1]=Math.min(255,src[i+1]*255/a);px[o+2]=Math.min(255,src[i+2]*255/a);px[o+3]=a;}}
    out.unmap();
    el.width=tw;el.height=th;el.getContext('2d').putImageData(new ImageData(px,tw,th),0,0);
  }
};`;

// Poses are computed on the server with the same evaluator as the canvas. The fitted stage is cloned
// for each timestamp, so its layout, fonts and mask wrappers stay in place while its layers move.
export const MOTION_STRIP_SCRIPT = `(spec) => {
  const stage = document.querySelector(".stage");
  const strip = document.createElement("div");
  const width = Math.ceil(spec.width), height = Math.ceil(spec.height);
  const columns = Math.min(4, spec.frames.length);
  strip.style.cssText = "display:grid;gap:8px;padding:8px;background:#22262c;color:white;box-sizing:border-box;width:max-content";
  strip.style.gridTemplateColumns = "repeat(" + columns + "," + width + "px)";
  for (const frame of spec.frames) {
    const cell = document.createElement("div"), crop = document.createElement("div"), label = document.createElement("div");
    crop.style.cssText = "position:relative;overflow:hidden;background:#f0f1f3;width:" + width + "px;height:" + height + "px";
    const copy = stage.cloneNode(true);
    copy.style.cssText = "position:absolute;margin:0;left:" + (-spec.x) + "px;top:" + (-spec.y) + "px";
    for (const el of copy.querySelectorAll("[data-id]")) {
      const pose = frame.poses[el.dataset.id];
      if (!pose || !Object.hasOwn(frame.poses, el.dataset.id)) continue;
      const [a,b,c,d,e,f,alpha] = pose;
      if ([a,b,c,d,e,f].some((n, i) => n !== [1,0,0,1,0,0][i])) {
        el.style.transformOrigin = "0 0";
        el.style.transform = "matrix(" + [a,b,c,d,e,f].join(",") + ") " + (el.style.transform === "none" ? "" : el.style.transform);
      }
      if (alpha !== null) el.style.opacity = alpha;
    }
    label.textContent = frame.time + " ms";
    label.style.cssText = "font:12px system-ui;line-height:24px;padding-left:6px";
    crop.append(copy); cell.append(crop, label); strip.append(cell);
  }
  document.body.replaceChildren(strip);
  const box = strip.getBoundingClientRect();
  return { width: box.width, height: box.height };
}`;
