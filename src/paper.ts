// The Paper Shaders library (github.com/paper-design/shaders, Apache-2.0): web-effect shaders as shader
// card presets. scripts/paper/gen.ts builds src/paper/library.json from vendor/paper-shaders: each shader's
// WGSL (translated from Paper's GLSL at build time), its parameters with Paper's ranges and defaults, its
// presets, and the slots its uniforms take in u.params. A card stores Paper-style params (colors as
// strings, enums by name) in config.paper and the packed floats in config.uniforms; the page hands those to
// the engine, so moving a slider never recompiles.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getShaderColorFromString } from "../vendor/paper-shaders/packages/shaders/src/get-shader-color-from-string.ts";

/** vec4 slots in u.params (engine/src/shaders.rs WRAPPER: params: array<vec4<f32>, 32>). Slot 0 is speed, frame. */
export const PARAM_SLOTS = 32;

export type ParamDef = {
  name: string;
  type: "number" | "boolean" | "enum" | "color" | "colors";
  description: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  maxCount?: number;
  default: unknown;
};
/** How one uniform is computed from the params, read from Paper's React component. */
export type UniformMap = { uniform: string; kind: "value" | "color" | "colors" | "count" | "enum" | "noise" | "image" | "bool"; param: string; enumName?: string };
/** Where a uniform lives in u.params: vec4 slot, component (scalars), array length. */
export type Slot = { uniform: string; type: string; count: number; slot: number; comp: number };
export type Preset = { name: string; params: Record<string, unknown> };
export type PaperShader = {
  id: string;
  name: string;
  description: string;
  component: string;
  fragmentExport: string;
  animated: boolean;
  noise: boolean;
  params: ParamDef[];
  presets: Preset[];
  uniforms: UniformMap[];
  enums: Record<string, Record<string, number>>;
  slots: Slot[];
  wgsl: string;
};
export type Library = { source: string; commit: string; license: string; version?: string; shaders: PaperShader[] };

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "paper", "library.json");
let lib: Library | null = null;

export function library(): Library {
  if (!lib) lib = JSON.parse(fs.readFileSync(LIB, "utf8")) as Library;
  return lib;
}

export function paperShader(id: string): PaperShader | undefined {
  return library().shaders.find((s) => s.id === id);
}

/** Paper's package version the snippets name (vendor/paper-shaders/packages/shaders-react/package.json). */
export const PAPER_VERSION = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(path.dirname(LIB), "../../vendor/paper-shaders/packages/shaders-react/package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "latest";
  }
})();

export class PaperError extends Error {}

const defaultPreset = (s: PaperShader) => s.presets.find((p) => p.name === "Default") ?? s.presets[0];

/**
 * A preset's params with overrides, checked against the schema: unknown names refused, numbers clamped to
 * Paper's ranges, enums one of the options, colours strings Paper can read.
 */
export function resolveParams(s: PaperShader, preset?: string, over: Record<string, unknown> = {}, base?: Record<string, unknown>): { preset: string; params: Record<string, unknown> } {
  const pr = preset ? s.presets.find((p) => p.name.toLowerCase() === preset.toLowerCase()) : undefined;
  if (preset && !pr) throw new PaperError(`${s.name} has no preset "${preset}"; presets: ${s.presets.map((p) => p.name).join(", ")}`);
  const from = pr ?? (base ? undefined : defaultPreset(s));
  const params: Record<string, unknown> = { ...defaultPreset(s).params, ...(base ?? {}), ...(from ? from.params : {}) };
  for (const [k, v] of Object.entries(over)) {
    const d = s.params.find((p) => p.name === k);
    if (!d) throw new PaperError(`${s.name} has no parameter "${k}"; parameters: ${s.params.map((p) => p.name).join(", ")}`);
    params[k] = checkParam(s, d, v);
  }
  return { preset: pr?.name ?? (base ? "Custom" : from!.name), params };
}

const isColor = (v: unknown) => typeof v === "string" && v.length <= 64 && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(v.trim());

function checkParam(s: PaperShader, d: ParamDef, v: unknown): unknown {
  const bad = (why: string) => new PaperError(`${s.name} ${d.name}: ${why}`);
  switch (d.type) {
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad("must be a number");
      let x = v;
      // frame and speed have no range in Paper's schema; keep them finite and sane.
      if (d.min !== undefined) x = Math.max(d.min, x);
      if (d.max !== undefined) x = Math.min(d.max, x);
      if (d.name === "speed") x = Math.max(-100, Math.min(100, x));
      if (d.name === "frame") x = Math.max(0, Math.min(1e9, x));
      return x;
    }
    case "boolean":
      if (typeof v !== "boolean") throw bad("must be true or false");
      return v;
    case "enum":
      if (typeof v !== "string" || !d.options!.includes(v)) throw bad(`must be one of ${d.options!.join(", ")}`);
      return v;
    case "color":
      if (!isColor(v)) throw bad("must be a colour (#rrggbb, rgb(), hsl())");
      return (v as string).trim();
    case "colors": {
      if (!Array.isArray(v) || !v.length) throw bad("must be a list of colours");
      if (d.maxCount && v.length > d.maxCount) throw bad(`at most ${d.maxCount} colours`);
      if (!v.every(isColor)) throw bad("every entry must be a colour (#rrggbb, rgb(), hsl())");
      return v.map((c: string) => c.trim());
    }
  }
}

type U = number | boolean | number[] | number[][];

/** The uniforms Paper's component computes from these params, and our packing of them into u.params. */
export function packUniforms(s: PaperShader, input: Record<string, unknown>): { uniforms: Record<string, U>; packed: number[] } {
  const params = { ...defaultPreset(s).params, ...input };
  const uniforms: Record<string, U> = {};
  for (const m of s.uniforms) {
    const v = params[m.param];
    switch (m.kind) {
      case "value": uniforms[m.uniform] = v as number; break;
      case "color": uniforms[m.uniform] = getShaderColorFromString(v as string); break;
      case "colors": uniforms[m.uniform] = (v as string[]).map((c) => getShaderColorFromString(c)); break;
      case "count": uniforms[m.uniform] = (v as unknown[]).length; break;
      case "enum": uniforms[m.uniform] = s.enums[m.enumName!]![v as string]!; break;
      case "bool": uniforms[m.uniform] = false; break; // Boolean(image): no source image
      case "noise": case "image": break;
    }
  }
  const out = new Array<number>(PARAM_SLOTS * 4).fill(0);
  out[0] = s.animated ? Number(params.speed ?? 0) : 0;
  out[1] = s.animated ? Number(params.frame ?? 0) : 0;
  const num = (x: unknown) => (typeof x === "boolean" ? (x ? 1 : 0) : typeof x === "number" && Number.isFinite(x) ? x : 0);
  for (const sl of s.slots) {
    const v = uniforms[sl.uniform];
    if (v === undefined) continue; // not set by Paper either: GL's default, 0
    const base = sl.slot * 4;
    if (sl.count && sl.type === "vec4") (v as number[][]).slice(0, sl.count).forEach((c, k) => c.forEach((x, j) => { out[base + k * 4 + j] = num(x); }));
    else if (sl.count) (v as number[]).slice(0, sl.count).forEach((x, k) => { out[base + k] = num(x); });
    else if (Array.isArray(v)) (v as number[]).forEach((x, j) => { out[base + j] = num(x); });
    else out[base + sl.comp] = num(v);
  }
  return { uniforms, packed: out };
}

/** What a card stores: shader, preset name, the full params. */
export type PaperConfig = { shader: string; preset: string; params: Record<string, unknown> };

/** The schema an agent or the inspector sees (no WGSL). */
export function listPresets() {
  const l = library();
  return {
    source: l.source, commit: l.commit, license: l.license, version: PAPER_VERSION,
    shaders: l.shaders.map((s) => ({ id: s.id, name: s.name, description: s.description, animated: s.animated, params: s.params, presets: s.presets.map((p) => p.name) })),
  };
}

/** The full presets of one shader (names and params). */
export function presetsOf(id: string) {
  const s = paperShader(id);
  if (!s) throw new PaperError(`No Paper shader "${id}"`);
  return s.presets;
}

// ---------- export: the same effect on a web page ----------

const SIZING = new Set(["fit", "scale", "rotation", "offsetX", "offsetY", "originX", "originY", "worldWidth", "worldHeight"]);

/** Params worth writing out: everything in the schema that differs from the component's own default. */
function written(s: PaperShader, params: Record<string, unknown>) {
  const d = defaultPreset(s).params;
  return s.params.filter((p) => params[p.name] !== undefined && (JSON.stringify(params[p.name]) !== JSON.stringify(d[p.name]) || !SIZING.has(p.name)));
}

const jsx = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : `{${JSON.stringify(v)}}`);

export function reactSnippet(cfg: PaperConfig, size: { w: number; h: number }): string {
  const s = paperShader(cfg.shader);
  if (!s) throw new PaperError(`No Paper shader "${cfg.shader}"`);
  const props = [`width={${Math.round(size.w)}}`, `height={${Math.round(size.h)}}`, ...written(s, cfg.params).map((p) => `${p.name}=${jsx(cfg.params[p.name])}`)];
  return [
    `// pnpm add @paper-design/shaders-react@${PAPER_VERSION}`,
    `import { ${s.component} } from '@paper-design/shaders-react';`,
    "",
    `export function ${s.component}Effect() {`,
    "  return (",
    `    <${s.component}`,
    ...props.map((p) => `      ${p}`),
    "    />",
    "  );",
    "}",
    "",
  ].join("\n");
}

/** Vanilla JS: ShaderMount with the uniforms Paper's React component would pass. */
export function htmlSnippet(cfg: PaperConfig, size: { w: number; h: number }): string {
  const s = paperShader(cfg.shader);
  if (!s) throw new PaperError(`No Paper shader "${cfg.shader}"`);
  const params = { ...defaultPreset(s).params, ...cfg.params };
  const lines: string[] = [];
  const imports = new Set(["ShaderMount", s.fragmentExport]);
  for (const m of s.uniforms) {
    const v = params[m.param];
    if (m.kind === "value") lines.push(`    ${m.uniform}: ${JSON.stringify(v)},`);
    else if (m.kind === "color") { imports.add("getShaderColorFromString"); lines.push(`    ${m.uniform}: getShaderColorFromString(${JSON.stringify(v)}),`); }
    else if (m.kind === "colors") { imports.add("getShaderColorFromString"); lines.push(`    ${m.uniform}: ${JSON.stringify(v)}.map(getShaderColorFromString),`); }
    else if (m.kind === "count") lines.push(`    ${m.uniform}: ${(v as unknown[]).length},`);
    else if (m.kind === "enum") { imports.add(m.enumName!); lines.push(`    ${m.uniform}: ${m.enumName}[${JSON.stringify(v)}],`); }
    else if (m.kind === "bool") lines.push(`    ${m.uniform}: false,`);
    else if (m.kind === "noise") { imports.add("getShaderNoiseTexture"); lines.push(`    ${m.uniform}: noise,`); }
  }
  const noise = s.uniforms.some((m) => m.kind === "noise");
  const speed = s.animated ? Number(params.speed ?? 0) : 0, frame = s.animated ? Number(params.frame ?? 0) : 0;
  return [
    `<div id="paper-${s.id}" style="width: ${Math.round(size.w)}px; height: ${Math.round(size.h)}px"></div>`,
    `<script type="module">`,
    `  import { ${[...imports].join(", ")} } from 'https://esm.sh/@paper-design/shaders@${PAPER_VERSION}';`,
    ...(noise ? ["  const noise = getShaderNoiseTexture();", "  await noise.decode();"] : []),
    `  new ShaderMount(document.getElementById('paper-${s.id}'), ${s.fragmentExport}, {`,
    ...lines,
    `  }, undefined, ${speed}, ${frame});`,
    `</script>`,
    "",
  ].join("\n");
}
