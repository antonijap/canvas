// Node validation for Canvas documents.
// The node types and properties of the document format, version 2.21/2.22.
// Only new or changed properties are checked. Keys that already sit in a file are never touched.

import { spanErrors } from "../page/text-spans.js";
import { listErrors, paragraphCount } from "../page/text-paras.js";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type DocNode = { [k: string]: Json } & { id?: string; type?: string; children?: DocNode[] };

const ENTITY = ["id", "type", "name", "context", "reusable", "theme", "enabled", "locked", "mask", "opacity", "blendMode", "flipX", "flipY", "layoutPosition", "metadata", "rotation", "x", "y"];
const SIZE = ["width", "height"];
const STROKE = ["stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeAlignment"];
const GRAPHICS = ["fill", "effect", ...STROKE];
const LAYOUT = ["layout", "gap", "layoutIncludeStroke", "padding", "justifyContent", "alignItems"];
const TEXT_STYLE = ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "fontStyle", "underline", "lineHeight", "textAlign", "textAlignVertical", "strikethrough", "href"];

export const NODE_KEYS: Record<string, Set<string>> = {
  frame: new Set([...ENTITY, ...SIZE, ...GRAPHICS, "cornerRadius", "cornerSmoothing", "children", ...LAYOUT, "clip", "placeholder", "slot"]),
  group: new Set([...ENTITY, "children", "effect"]),
  rectangle: new Set([...ENTITY, ...SIZE, ...GRAPHICS, "cornerRadius", "cornerSmoothing"]),
  ellipse: new Set([...ENTITY, ...SIZE, ...GRAPHICS, "innerRadius", "startAngle", "sweepAngle"]),
  polygon: new Set([...ENTITY, ...SIZE, ...GRAPHICS, "polygonCount", "cornerRadius"]),
  path: new Set([...ENTITY, ...SIZE, ...GRAPHICS, "fillRule", "geometry", "viewBox"]),
  text: new Set([...ENTITY, ...SIZE, ...GRAPHICS, ...TEXT_STYLE, "content", "textGrowth", "spans", "textTruncation", "maxLines", "paragraphSpacing", "paragraphIndent", "lists", "listSpacing", "hangingList", "hangingPunctuation", "letterCase"]),
  note: new Set([...ENTITY, ...SIZE, ...TEXT_STYLE, "content", "color"]),
  prompt: new Set([...ENTITY, ...SIZE, ...TEXT_STYLE, "content", "model"]),
  context: new Set([...ENTITY, ...SIZE, ...TEXT_STYLE, "content"]),
  icon: new Set([...ENTITY, ...SIZE, "effect", "library", "icon", "weight", "fill"]),
  script: new Set([...ENTITY, ...SIZE, "clip", "scriptUri", "inputs"]),
  browser: new Set([...ENTITY, ...SIZE, "effect", ...STROKE, "url", "deviceId", "zoom", "scrollX", "scrollY", "cornerRadius"]),
  ref: new Set(), // instances accept any property override
};

export const NODE_TYPES = Object.keys(NODE_KEYS);
/** Every key some node type takes: a key outside it is one this version of Canvas has never heard of. */
const KNOWN_KEYS = new Set(Object.values(NODE_KEYS).flatMap((s) => [...s]));
export const CONTAINER_TYPES = new Set(["frame", "group", "ref"]);

/** Blend modes of a layer or a paint (the file's names; CSS mix-blend-mode). */
export const BLEND_MODES = ["normal", "darken", "multiply", "colorBurn", "light", "screen", "colorDodge", "overlay", "softLight", "hardLight", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];
/** Image fill modes: Fill, Fit, Crop, Tile and Stretch (older files: cover, contain). */
export const IMAGE_MODES = ["fill", "fit", "crop", "tile", "stretch", "cover", "contain"];

const ENUMS: Record<string, string[]> = {
  layout: ["none", "vertical", "horizontal"],
  justifyContent: ["start", "center", "end", "space_between", "space_around"],
  alignItems: ["start", "center", "end"],
  layoutPosition: ["auto", "absolute"],
  textGrowth: ["auto", "fixed-width", "fixed-width-height"],
  textTruncation: ["disabled", "ending"],
  textAlign: ["left", "center", "right", "justify"],
  textAlignVertical: ["top", "middle", "bottom"],
  strokeLinecap: ["butt", "round", "square"],
  strokeLinejoin: ["miter", "bevel", "round"],
  strokeAlignment: ["inner", "center", "outer"],
  fillRule: ["nonzero", "evenodd"],
  blendMode: BLEND_MODES,
  letterCase: ["original", "upper", "lower", "title", "small-caps"],
};

const NUMERIC = ["x", "y", "opacity", "cornerSmoothing", "rotation", "gap", "fontSize", "letterSpacing", "lineHeight", "maxLines", "paragraphSpacing", "paragraphIndent", "listSpacing", "innerRadius", "startAngle", "sweepAngle", "polygonCount", "weight", "zoom", "scrollX", "scrollY"];
const BOOLEAN = ["reusable", "enabled", "locked", "mask", "flipX", "flipY", "clip", "underline", "strikethrough", "layoutIncludeStroke", "placeholder", "hangingList", "hangingPunctuation"];

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const SIZING_RE = /^(fit_content|fill_container)(\(\s*-?\d+(\.\d+)?\s*\))?$/;
const isVar = (v: unknown) => typeof v === "string" && v.startsWith("$") && v.length > 1;
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const numOrVar = (v: unknown) => isNum(v) || isVar(v);

export class ValidationError extends Error {}

function checkFill(v: Json, where: string, errs: string[]) {
  const one = (f: Json) => {
    if (typeof f === "string") {
      if (!COLOR_RE.test(f) && !isVar(f)) errs.push(`${where}: "${f}" is not a hex color (#RGB, #RRGGBB, #RRGGBBAA) or $variable`);
      return;
    }
    if (!f || typeof f !== "object" || Array.isArray(f)) return void errs.push(`${where}: fill must be a color string, a fill object or an array of them`);
    const t = (f as Record<string, Json>).type;
    if (!["color", "gradient", "image", "shader", "mesh_gradient"].includes(String(t))) errs.push(`${where}: unknown fill type "${t}"`);
    if (t === "color") {
      const c = (f as Record<string, Json>).color;
      if (typeof c !== "string" || (!COLOR_RE.test(c) && !isVar(c))) errs.push(`${where}: color fill needs a hex color or $variable`);
    }
    const o = f as Record<string, Json>;
    if (o.blendMode !== undefined && (typeof o.blendMode !== "string" || !BLEND_MODES.includes(o.blendMode))) errs.push(`${where}: blendMode must be one of ${BLEND_MODES.join(", ")}`);
    if (t === "image") {
      if (typeof o.url !== "string" || !o.url) errs.push(`${where}: image fill needs url`);
      if (o.mode !== undefined && (typeof o.mode !== "string" || !IMAGE_MODES.includes(o.mode))) errs.push(`${where}: image mode must be one of fill, fit, crop, tile, stretch`);
      const c = o.crop as Record<string, Json> | undefined;
      if (c !== undefined && (!c || typeof c !== "object" || Array.isArray(c) || !["x", "y", "width", "height"].every((k) => isNum(c[k])) || !((c.width as number) > 0 && (c.height as number) > 0))) {
        errs.push(`${where}: crop must be {x, y, width, height}, fractions of the layer's size (width and height above 0)`);
      }
      if (o.scale !== undefined && !(isNum(o.scale) && (o.scale as number) > 0)) errs.push(`${where}: scale must be a number above 0`);
      if (o.rotation !== undefined && !(isNum(o.rotation) && (o.rotation as number) % 90 === 0)) errs.push(`${where}: an image fill turns by 90, 180 or 270 degrees`);
      const a = o.adjust as Record<string, Json> | undefined;
      if (a !== undefined && (!a || typeof a !== "object" || Array.isArray(a) || Object.entries(a).some(([k, v]) => !["exposure", "contrast", "saturation", "temperature", "tint"].includes(k) || !isNum(v) || Math.abs(v as number) > 1))) {
        errs.push(`${where}: adjust takes exposure, contrast, saturation, temperature and tint, each from -1 to 1`);
      }
    }
    if (t === "gradient") {
      if (o.gradientType !== undefined && !["linear", "radial", "angular"].includes(String(o.gradientType))) errs.push(`${where}: gradientType must be linear, radial or angular`);
      if (o.colors !== undefined && (!Array.isArray(o.colors) || !o.colors.every((s) => s && typeof s === "object" && !Array.isArray(s) && typeof (s as Record<string, Json>).color === "string" && isNum((s as Record<string, Json>).position)))) {
        errs.push(`${where}: gradient colors must be [{color, position}] with positions from 0 to 1`);
      }
    }
    if (t === "shader") {
      // src/shader-fill.ts: a Paper shader id (with preset and params), or WGSL source (with uniforms).
      const o = f as Record<string, Json>;
      if (o.shader === undefined && o.source === undefined) errs.push(`${where}: shader fill needs shader (a Paper shader id, see list_shader_presets) or source (WGSL with fn shade)`);
      if (o.shader !== undefined && (typeof o.shader !== "string" || !/^[a-z0-9-]{1,60}$/.test(o.shader))) errs.push(`${where}: shader must be a Paper shader id like "mesh-gradient"`);
      if (o.source !== undefined && (typeof o.source !== "string" || o.source.length > 64 * 1024)) errs.push(`${where}: source must be WGSL text of at most 64 KB`);
      if (o.preset !== undefined && typeof o.preset !== "string") errs.push(`${where}: preset must be a preset name`);
      if (o.params !== undefined && (!o.params || typeof o.params !== "object" || Array.isArray(o.params))) errs.push(`${where}: params must be an object of Paper parameters`);
      if (o.uniforms !== undefined && (!Array.isArray(o.uniforms) || o.uniforms.length > 128 || !o.uniforms.every(isNum))) errs.push(`${where}: uniforms must be at most 128 numbers`);
      if (o.opacity !== undefined && !numOrVar(o.opacity)) errs.push(`${where}: opacity must be a number from 0 to 1`);
      if (o.autoplay !== undefined && typeof o.autoplay !== "boolean") errs.push(`${where}: autoplay must be true or false`);
    }
  };
  if (Array.isArray(v)) v.forEach(one);
  else one(v);
}

/** Validate one node (and its children). `full` = check every key (new node); otherwise only `keys`. */
export function validateNode(node: DocNode, opts: { keys?: string[]; path?: string } = {}): string[] {
  const errs: string[] = [];
  const where = opts.path ?? (node.id ? `node ${node.id}` : "node");
  if (!node || typeof node !== "object" || Array.isArray(node)) return [`${where}: must be an object`];
  const type = node.type;
  if (typeof type !== "string" || !(type in NODE_KEYS)) {
    return [`${where}: type must be one of ${NODE_TYPES.join(", ")} (got ${JSON.stringify(type)})`];
  }
  if (node.id !== undefined && (typeof node.id !== "string" || node.id.length === 0 || node.id.includes("/"))) {
    errs.push(`${where}: id must be a non-empty string without "/"`);
  }
  const keys = opts.keys ?? Object.keys(node);
  const allowed = NODE_KEYS[type];
  for (const k of keys) {
    const v = node[k];
    if (v === undefined) continue;
    if (type !== "ref" && !allowed.has(k)) {
      // A whole new node (an insert, a paste, a copy from a newer Canvas) keeps keys this version has never heard
      // of: unknownKeys warns about them, so the next format additions do not break older builds. A key another
      // type takes (cornerSmoothing on an ellipse, lists on a rectangle) is a mistake and still refused, and so is
      // any unknown key in a property write (opts.keys).
      if (!opts.keys && !KNOWN_KEYS.has(k)) continue;
      errs.push(`${where}: "${k}" is not a ${type} property. Allowed: ${[...allowed].join(", ")}`);
      continue;
    }
    if (k in ENUMS && typeof v === "string" && !isVar(v) && !ENUMS[k].includes(v)) {
      errs.push(`${where}: ${k} must be one of ${ENUMS[k].join(", ")} (got "${v}")`);
    }
    if (NUMERIC.includes(k) && !numOrVar(v)) errs.push(`${where}: ${k} must be a number or $variable`);
    if (BOOLEAN.includes(k) && typeof v !== "boolean" && !isVar(v)) errs.push(`${where}: ${k} must be true/false or $variable`);
    if ((k === "width" || k === "height") && !(numOrVar(v) || (typeof v === "string" && SIZING_RE.test(v)))) {
      errs.push(`${where}: ${k} must be a number, $variable, "fit_content", "fill_container" (optionally with a fallback like "fill_container(320)")`);
    }
    if (k === "fill" || k === "stroke") checkFill(v, `${where}.${k}`, errs);
    if (k === "padding" && !(numOrVar(v) || (Array.isArray(v) && (v.length === 2 || v.length === 4) && v.every(numOrVar)))) {
      errs.push(`${where}: padding must be a number, [vertical, horizontal] or [top, right, bottom, left]`);
    }
    if (k === "cornerRadius" && !(numOrVar(v) || (Array.isArray(v) && v.length === 4 && v.every(numOrVar)))) {
      errs.push(`${where}: cornerRadius must be a number or 4 numbers`);
    }
    if (k === "fontWeight" && typeof v !== "string") errs.push(`${where}: fontWeight must be a string such as "400" or "700"`);
    if ((k === "content" || k === "name" || k === "fontFamily" || k === "geometry") && typeof v !== "string") {
      errs.push(`${where}: ${k} must be a string`);
    }
    // Styled ranges over the content (src/page/text-spans.js): checked against the content they sit on.
    if (k === "spans") {
      const content = typeof node.content === "string" ? node.content : undefined;
      for (const e of spanErrors(v, content === undefined ? undefined : content.length)) errs.push(`${where}: ${e}`);
    }
    // Paragraph settings and lists (src/page/text-paras.js): lists checked against the paragraphs they sit on.
    if ((k === "paragraphSpacing" || k === "paragraphIndent" || k === "listSpacing") && isNum(v) && (v as number) < 0) errs.push(`${where}: ${k} must be 0 or more`);
    if (k === "lists") {
      const content = typeof node.content === "string" ? node.content : undefined;
      for (const e of listErrors(v, content === undefined ? undefined : paragraphCount(content))) errs.push(`${where}: ${e}`);
    }
    if (k === "children") {
      if (!CONTAINER_TYPES.has(type)) errs.push(`${where}: a ${type} cannot have children (only frame and group)`);
      else if (!Array.isArray(v)) errs.push(`${where}: children must be an array`);
      else (v as DocNode[]).forEach((c, i) => errs.push(...validateNode(c, { path: `${where}.children[${i}]` })));
    }
  }
  if (type === "ref" && keys.includes("ref") && (typeof node.ref !== "string" || !node.ref)) errs.push(`${where}: ref must be the id of a reusable component`);
  if (type === "ref" && !opts.keys && node.ref === undefined) errs.push(`${where}: an instance needs "ref" (the id of a reusable component)`);
  if (type === "path" && !opts.keys && typeof node.geometry !== "string") errs.push(`${where}: a path needs "geometry" (an SVG path string)`);
  if (type === "icon" && !opts.keys && (typeof node.icon !== "string" || typeof node.library !== "string")) {
    errs.push(`${where}: an icon needs "library" (lucide, feather, Material Symbols Outlined/Rounded/Sharp, phosphor) and "icon"`);
  }
  return errs;
}

/**
 * The keys of a node (and, with `deep`, of its children) that this version of Canvas has never heard of:
 * validateNode lets them through on a whole new node, and this says so. Instances take any key.
 */
export function unknownKeys(node: DocNode, deep = true, path?: string): string[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  const where = path ?? (node.id ? `node ${node.id}` : "node");
  const type = node.type;
  const out: string[] = [];
  if (typeof type === "string" && type !== "ref" && type in NODE_KEYS) {
    const allowed = NODE_KEYS[type];
    for (const k of Object.keys(node)) if (node[k] !== undefined && !allowed.has(k) && !KNOWN_KEYS.has(k)) out.push(`${where}: "${k}" is a property this version of Canvas does not know; kept as it is`);
  }
  if (deep && Array.isArray(node.children)) node.children.forEach((c, i) => out.push(...unknownKeys(c, true, path ? `${where}.children[${i}]` : undefined)));
  return out;
}

export function validateVariable(name: string, def: Json): string[] {
  const errs: string[] = [];
  if (!name || name.includes(":")) errs.push(`variable name must be non-empty and contain no ":"`);
  if (!def || typeof def !== "object" || Array.isArray(def)) return [...errs, "variable must be { type, value }"];
  const t = (def as Record<string, Json>).type;
  if (!["boolean", "color", "number", "string"].includes(String(t))) errs.push(`variable type must be boolean, color, number or string`);
  const val = (def as Record<string, Json>).value;
  const checkOne = (v: Json) => {
    if (isVar(v)) return;
    if (t === "color" && !(typeof v === "string" && COLOR_RE.test(v))) errs.push(`color variable value must be a hex color`);
    if (t === "number" && !isNum(v)) errs.push(`number variable value must be a number`);
    if (t === "boolean" && typeof v !== "boolean") errs.push(`boolean variable value must be true/false`);
    if (t === "string" && typeof v !== "string") errs.push(`string variable value must be a string`);
  };
  if (Array.isArray(val)) {
    for (const e of val) {
      if (!e || typeof e !== "object" || Array.isArray(e) || !("value" in e)) errs.push(`themed values must be [{ value, theme: { axis: value } }]`);
      else checkOne((e as Record<string, Json>).value);
    }
  } else checkOne(val as Json);
  return errs;
}
