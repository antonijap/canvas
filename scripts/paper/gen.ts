// Builds the Paper Shaders library (src/paper/library.json) from the vendored sources in
// vendor/paper-shaders: the GLSL ES 3.0 fragment shaders become WGSL for our shader cards, translated at
// build time by the naga tool in engine/glsl (only the WGSL ships). Run: node scripts/paper/gen.ts
//
// For each shader it takes, from Paper's own code:
//   - the fragment shader (packages/shaders), with the vertex stage (vertex-shader.ts) folded into it
//   - the parameters, ranges and descriptions (docs/src/shader-defs)
//   - the presets and how parameters become uniforms (packages/shaders-react), checked by calling the
//     React component itself with a stubbed ShaderMount
// and writes the WGSL, the parameter schema, the presets and the uniform slots src/paper.ts packs into
// u.params. It also writes the noise texture the engine binds (engine/src/paper_noise.rgba) and, under
// bench/out/paper-parity, the cases the parity page renders with WebGL2 (Paper's GLSL) and WebGPU (ours).
//
// The vendored files are imported after a TypeScript transpile into a temp dir; nothing from them runs at
// app runtime except get-shader-color-from-string.ts (src/paper.ts).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import ts from "typescript";
import { lintWgsl } from "../../src/shaders.ts";
import { PARAM_SLOTS, packUniforms, type PaperShader, type UniformMap, type Slot } from "../../src/paper.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VENDOR = path.join(ROOT, "vendor/paper-shaders");
const TOOL = path.join(ROOT, "engine/glsl/target/release/canvas-glsl");
const OUT_LIB = path.join(ROOT, "src/paper/library.json");
const OUT_NOISE = path.join(ROOT, "engine/src/paper_noise.rgba");
const OUT_PARITY = path.join(ROOT, "bench/out/paper-parity");
const COMMIT = fs.readFileSync(path.join(VENDOR, "COMMIT"), "utf8").trim();

/** The shaders in the library, in the order the rail shows them. Image-only shaders are not vendored. */
const IDS = [
  "mesh-gradient", "grain-gradient", "static-mesh-gradient", "static-radial-gradient", "liquid-metal", "metaballs", "warp", "swirl",
  "waves", "neuro-noise", "dot-orbit", "dot-grid", "smoke-ring", "voronoi", "god-rays", "perlin-noise", "simplex-noise",
  "pulsing-border", "color-panels", "spiral", "dithering", "water",
];

// ---------- transpile the vendored TypeScript into a temp dir ----------

const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-paper-"));
const STUBS: Record<string, string> = {
  "react.js": "export const memo = (f) => f; export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}]; export const useEffect = () => {}; export const useLayoutEffect = () => {}; export const useMemo = (f) => f(); export const useRef = (v) => ({ current: v }); export const useCallback = (f) => f; export default {};",
  "jsx-runtime.js": "export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = 'Fragment';",
  "shader-mount.js": "export const ShaderMount = 'ShaderMount'; export const isPaperShaderElement = () => false;",
  "color-props-are-equal.js": "export const colorPropsAreEqual = () => false;",
  "suspend.js": "export const suspend = () => undefined;",
};
for (const [f, src] of Object.entries(STUBS)) fs.writeFileSync(path.join(BUILD, f), src);

function rewrite(spec: string, fromOut: string): string {
  const rel = (to: string) => {
    let r = path.relative(path.dirname(fromOut), path.join(BUILD, to));
    if (!r.startsWith(".")) r = "./" + r;
    return r;
  };
  if (spec === "react") return rel("react.js");
  if (spec === "react/jsx-runtime") return rel("jsx-runtime.js");
  if (spec === "@paper-design/shaders") return rel("shaders-entry.js");
  if (spec === "@paper-design/shaders-react") return rel("react-entry.js");
  if (spec.endsWith("/shader-mount.js")) return rel("shader-mount.js");
  if (spec.endsWith("/color-props-are-equal.js")) return rel("color-props-are-equal.js");
  if (spec.endsWith("/suspend.js")) return rel("suspend.js");
  if (spec.startsWith(".") && !spec.endsWith(".js")) return spec + ".js";
  return spec;
}

function transpileAll() {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(VENDOR);
  for (const f of files) {
    const rel = path.relative(VENDOR, f).replace(/\.tsx?$/, ".js");
    const out = path.join(BUILD, rel);
    const r = ts.transpileModule(fs.readFileSync(f, "utf8"), {
      fileName: f,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
    });
    const code = r.outputText.replace(/(from\s+|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g, (_m, pre, q, spec) => `${pre}${q}${rewrite(spec, out)}${q}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, code);
  }
  const shaderMods = IDS.map((id) => `export * from './packages/shaders/src/shaders/${id}.js';`);
  fs.writeFileSync(path.join(BUILD, "shaders-entry.js"), [
    ...shaderMods,
    "export * from './packages/shaders/src/shader-sizing.js';",
    "export * from './packages/shaders/src/shader-utils.js';",
    "export { getShaderColorFromString } from './packages/shaders/src/get-shader-color-from-string.js';",
    "export { getShaderNoiseTexture } from './packages/shaders/src/get-shader-noise-texture.js';",
    "export { vertexShaderSource } from './packages/shaders/src/vertex-shader.js';",
    "export const ShaderMount = 'ShaderMount';",
  ].join("\n"));
  // Every React module exports `defaultPreset`: name each module instead of `export *`.
  fs.writeFileSync(path.join(BUILD, "react-entry.js"), IDS.map((id) => {
    const src = fs.readFileSync(path.join(VENDOR, `packages/shaders-react/src/shaders/${id}.tsx`), "utf8");
    const names = [...src.matchAll(/export const (\w+Presets)\b/g)].map((m) => m[1]);
    return names.length ? `export { ${names.join(", ")} } from './packages/shaders-react/src/shaders/${id}.js';` : "";
  }).join("\n"));
}

// ---------- the noise texture (a palette PNG in get-shader-noise-texture.ts) ----------

function decodePng(buf: Buffer): { w: number; h: number; rgba: Buffer } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let i = 8, w = 0, h = 0, depth = 0, type = 0, plte: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), kind = buf.toString("ascii", i + 4, i + 8), data = buf.subarray(i + 8, i + 8 + len);
    if (kind === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12]) throw new Error("interlaced PNG"); }
    else if (kind === "PLTE") plte = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    i += 12 + len;
  }
  if (depth !== 8) throw new Error(`PNG depth ${depth}`);
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let k = 0; k < w * h; k++) {
    let r, g, b, al = 255;
    if (type === 3) { const p = px[k]; r = plte![p * 3]; g = plte![p * 3 + 1]; b = plte![p * 3 + 2]; if (trns && p < trns.length) al = trns[p]; }
    else if (type === 2) { r = px[k * 3]; g = px[k * 3 + 1]; b = px[k * 3 + 2]; }
    else if (type === 6) { r = px[k * 4]; g = px[k * 4 + 1]; b = px[k * 4 + 2]; al = px[k * 4 + 3]; }
    else if (type === 0) { r = g = b = px[k]; }
    else { r = g = b = px[k * 2]; al = px[k * 2 + 1]; }
    // WebGL uploads it with UNPACK_PREMULTIPLY_ALPHA_WEBGL (shader-mount.ts).
    rgba.set([Math.round((r * al) / 255), Math.round((g * al) / 255), Math.round((b * al) / 255), al], k * 4);
  }
  return { w, h, rgba };
}

// ---------- GLSL ES 3.0 (fragment + vertex) to one GLSL 4.50 unit for naga ----------

type Decl = { name: string; type: string; count: number };
const UNIFORM_RE = /^[ \t]*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;[^\n]*$/gm;

function uniformsIn(src: string): Decl[] {
  return [...src.matchAll(UNIFORM_RE)].map((m) => ({ type: m[1], name: m[2], count: m[3] ? Number(m[3]) : 0 }));
}

/** `fn(name, ...)` calls replaced, parentheses matched. */
function replaceCalls(src: string, head: RegExp, make: (args: string) => string): string {
  let out = "", i = 0;
  for (;;) {
    head.lastIndex = i;
    const m = head.exec(src);
    if (!m) return out + src.slice(i);
    let depth = 1, j = m.index + m[0].length;
    for (; j < src.length && depth; j++) { if (src[j] === "(") depth++; else if (src[j] === ")") depth--; }
    out += src.slice(i, m.index) + make(src.slice(m.index + m[0].length, j - 1));
    i = j;
  }
}

/** Shared by fragment and vertex code: strip the ES header, uniforms become private globals (declared once). */
function common(src: string): string {
  return src
    .replace(/^[ \t]*#version[^\n]*$/m, "")
    .replace(/^[ \t]*precision\s+\w+\s+\w+\s*;[^\n]*$/gm, "")
    .replace(UNIFORM_RE, "");
}

const SPECIAL = new Set(["u_time", "u_resolution", "u_pixelRatio"]);
const glslType = (d: Decl) => d.type;

function buildGlsl(frag: string, vert: string): { glsl: string; slots: Slot[]; noise: boolean } {
  const decls = new Map<string, Decl>();
  for (const d of [...uniformsIn(vert), ...uniformsIn(frag)]) if (!decls.has(d.name)) decls.set(d.name, d);
  // Vertex: outputs become private globals, main becomes canvasVertex(clip position).
  const varyings = [...vert.matchAll(/^[ \t]*out\s+(\w+)\s+(\w+)\s*;/gm)].map((m) => ({ type: m[1], name: m[2] }));
  const v = common(vert)
    .replace(/^[ \t]*layout\s*\([^)]*\)\s*in\s+[^;]+;/m, "")
    .replace(/^[ \t]*out\s+\w+\s+\w+\s*;[^\n]*$/gm, "")
    .replace(/\bvoid\s+main\s*\(\s*\)/, "void canvasVertex(vec2 canvas_pos)")
    .replace(/\bgl_Position\s*=\s*a_position\s*;/, "vec4 canvas_glPosition = vec4(canvas_pos, 0.0, 1.0);")
    .replace(/\bgl_Position\b/g, "canvas_glPosition");
  // Fragment: inputs are the vertex outputs above, the output a private global, main becomes paperMain.
  const outName = /^[ \t]*out\s+vec4\s+(\w+)\s*;/m.exec(frag)?.[1];
  if (!outName) throw new Error("no fragment output");
  let f = common(frag)
    .replace(/^[ \t]*in\s+\w+\s+\w+\s*;[^\n]*$/gm, "")
    .replace(/^[ \t]*out\s+vec4\s+\w+\s*;[^\n]*$/m, "")
    .replace(/\bvoid\s+main\s*\(\s*\)/, "void paperMain()")
    .replace(/\bgl_FragCoord\b/g, "canvas_fragCoord");
  const noise = /\bu_noiseTexture\b/.test(f);
  f = replaceCalls(f, /\btexture\s*\(\s*u_noiseTexture\s*,/g, (args) => `canvas_noise_stub(${args})`);
  // No source image: Paper samples a transparent pixel then (shaders-react transparent-pixel.ts).
  f = replaceCalls(f, /\btexture(?:Grad|Lod)?\s*\(\s*u_image\s*,/g, () => "vec4(0.0)");
  f = f.replace(/\btextureSize\s*\(\s*u_image\s*,\s*0\s*\)/g, "ivec2(1)");
  if (/\bu_image\b(?!AspectRatio)/.test(f) || /\bsampler2D\b/.test(f)) {
    // A helper that takes the image as a parameter: called only on the image path.
    f = f.replace(/\bsampler2D\s+(\w+)/g, "float $1").replace(/\btexture(Grad|Lod)?\s*\(\s*(tex|img|image)\s*,/g, "canvas_zero(0.0,")
      .replace(/\btextureSize\s*\(\s*(tex|img|image)\s*,\s*0\s*\)/g, "ivec2(1)").replace(/\(\s*u_image\s*,/g, "(0.0,");
  }
  const slots: Slot[] = [];
  let slot = 1, comp = 0; // slot 0: speed, frame
  const next = (whole: boolean, count: number) => {
    if (whole || comp === 4) { if (comp) slot++; comp = 0; }
    const at = { slot, comp };
    if (whole) slot += count; else { comp++; }
    return at;
  };
  for (const d of decls.values()) {
    if (SPECIAL.has(d.name) || d.type === "sampler2D") continue;
    if (d.count) {
      if (d.type !== "vec4" && d.type !== "float") throw new Error(`array of ${d.type}`);
      const at = next(true, d.type === "vec4" ? d.count : Math.ceil(d.count / 4));
      slots.push({ uniform: d.name, type: d.type, count: d.count, ...at });
    } else if (d.type === "vec2" || d.type === "vec3" || d.type === "vec4") {
      slots.push({ uniform: d.name, type: d.type, count: 0, ...next(true, 1) });
    } else if (d.type === "float" || d.type === "int" || d.type === "bool") {
      slots.push({ uniform: d.name, type: d.type, count: 0, ...next(false, 1) });
    } else throw new Error(`uniform type ${d.type}`);
  }
  if ((comp ? slot + 1 : slot) > PARAM_SLOTS) throw new Error(`needs ${slot + 1} slots`);
  const C = "xyzw";
  const assign = slots.map((s) => {
    if (s.count && s.type === "vec4") return Array.from({ length: s.count }, (_, k) => `  ${s.uniform}[${k}] = P[${s.slot + k}];`).join("\n");
    if (s.count) return Array.from({ length: s.count }, (_, k) => `  ${s.uniform}[${k}] = P[${s.slot + (k >> 2)}].${C[k & 3]};`).join("\n");
    if (s.type === "vec4") return `  ${s.uniform} = P[${s.slot}];`;
    if (s.type === "vec3") return `  ${s.uniform} = P[${s.slot}].xyz;`;
    if (s.type === "vec2") return `  ${s.uniform} = P[${s.slot}].xy;`;
    const x = `P[${s.slot}].${C[s.comp]}`;
    return s.type === "bool" ? `  ${s.uniform} = ${x} > 0.5;` : s.type === "int" ? `  ${s.uniform} = int(${x});` : `  ${s.uniform} = ${x};`;
  }).join("\n");
  const privates = [
    "float u_time;", "vec2 u_resolution;", "float u_pixelRatio;", "vec4 canvas_fragCoord;", `vec4 ${outName};`,
    ...[...decls.values()].filter((d) => !SPECIAL.has(d.name) && d.type !== "sampler2D").map((d) => `${glslType(d)} ${d.name}${d.count ? `[${d.count}]` : ""};`),
    ...varyings.map((x) => `${x.type} ${x.name};`),
  ];
  const glsl = [
    "#version 450",
    ...privates,
    "vec4 canvas_noise_stub(vec2 uv) { return vec4(uv, 0.0, 0.0); }",
    "vec4 canvas_zero(float t, vec2 uv) { return vec4(0.0); }",
    "vec4 canvas_zero(float t, vec2 uv, vec2 a, vec2 b) { return vec4(0.0); }",
    "vec4 canvas_zero(float t, vec2 uv, float l) { return vec4(0.0); }",
    v,
    f,
    // p: card px, y down; res: card size in card px; texel: card px per texture px; P: u.params.
    `vec4 canvasShade(vec2 p, vec2 res, vec2 texel, float time, vec4 P[${PARAM_SLOTS}]) {`,
    "  u_resolution = res / texel;",
    "  u_pixelRatio = 1.0 / texel.x;",
    "  u_time = P[0].y * 0.001 + time * P[0].x;",
    "  canvas_fragCoord = vec4(p.x / texel.x, (res.y - p.y) / texel.y, 0.5, 1.0);",
    assign,
    "  canvasVertex(vec2(p.x / res.x * 2.0 - 1.0, 1.0 - p.y / res.y * 2.0));",
    "  paperMain();",
    `  return ${outName};`,
    "}",
    "void main() {}",
    "",
  ].join("\n");
  return { glsl, slots, noise };
}

function translate(id: string, glsl: string): string {
  let out: string;
  try {
    out = execFileSync(TOOL, { input: glsl, encoding: "utf8" });
  } catch (e) {
    const o = (e as { stdout?: string }).stdout ?? "";
    fs.mkdirSync(OUT_PARITY, { recursive: true });
    fs.writeFileSync(path.join(OUT_PARITY, `${id}.failed.glsl`), glsl);
    throw new Error(`${id}: ${o.slice(0, 2000)}`);
  }
  const wgsl = (JSON.parse(out) as { wgsl: string }).wgsl;
  // The noise stub becomes the engine's canvas_noise (engine/src/shaders.rs WRAPPER); canvas_zero stays.
  const noStub = wgsl.replace(/fn canvas_noise_stub\([^)]*\)\s*->\s*vec4<f32>\s*\{[\s\S]*?\n\}\n?/, "").replace(/\bcanvas_noise_stub\(/g, "canvas_noise(");
  return [
    // Paper's GLSL takes derivatives (fwidth) under branches on its uniforms, which are private globals here,
    // so WGSL's uniformity analysis cannot see they are uniform. GLSL gives the same results.
    ...(/\b(fwidth|dpdx|dpdy)\w*\(/.test(noStub) ? ["diagnostic(off, derivative_uniformity);"] : []),
    `// Paper Shaders "${id}" (github.com/paper-design/shaders@${COMMIT.slice(0, 12)}, Apache-2.0), modified:`,
    "// translated from GLSL ES 3.0 to WGSL by naga at build time (scripts/paper/gen.ts), the vertex stage folded",
    "// into the fragment, uniforms read from u.params. Do not edit; regenerate.",
    noStub.trim(),
    "",
    "fn shade(p: vec2<f32>) -> vec4<f32> {",
    "  return canvasShade(p, u.resolution, u.canvas_texel, u.time, u.params);",
    "}",
    "",
  ].join("\n");
}

// ---------- params -> uniforms, read from the React component and checked against it ----------

function uniformMap(id: string): UniformMap[] {
  const src = fs.readFileSync(path.join(VENDOR, `packages/shaders-react/src/shaders/${id}.tsx`), "utf8");
  const body = /const uniforms\s*=\s*\{([\s\S]*?)\}\s*satisfies/.exec(src)?.[1];
  if (!body) throw new Error(`${id}: no uniforms object`);
  const out: UniformMap[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim().replace(/,$/, "");
    if (!line) continue;
    const m = /^(\w+):\s*(.+)$/.exec(line);
    if (!m) throw new Error(`${id}: cannot read "${line}"`);
    const [, uniform, e] = m;
    let r: RegExpExecArray | null;
    if ((r = /^(\w+)(?:\s*\?\?\s*defaultPreset\.params\.\w+)?$/.exec(e))) out.push(r[1] === "processedImage" || (r[1] === "image" && uniform === "u_image") ? { uniform, kind: "image", param: "" } : { uniform, kind: "value", param: r[1] });
    else if ((r = /^getShaderColorFromString\((\w+)\)$/.exec(e))) out.push({ uniform, kind: "color", param: r[1] });
    else if ((r = /^(\w+)\.map\(getShaderColorFromString\)$/.exec(e))) out.push({ uniform, kind: "colors", param: r[1] });
    else if ((r = /^(\w+)\.length$/.exec(e))) out.push({ uniform, kind: "count", param: r[1] });
    else if ((r = /^(\w+)\[(\w+)\]$/.exec(e))) out.push({ uniform, kind: "enum", param: r[2], enumName: r[1] });
    else if (e === "getShaderNoiseTexture()") out.push({ uniform, kind: "noise", param: "" });
    else if (e === "Boolean(image)") out.push({ uniform, kind: "bool", param: "" });
    else throw new Error(`${id}: unknown uniform expression ${uniform}: ${e}`);
  }
  return out;
}

const camel = (id: string) => id.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());
const pascal = (id: string) => camel(id).replace(/^\w/, (c) => c.toUpperCase());

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  return a === b;
}

async function main() {
  if (!fs.existsSync(TOOL)) execFileSync("cargo", ["build", "--release", "--locked"], { cwd: path.join(ROOT, "engine/glsl"), stdio: "inherit" });
  transpileAll();
  const imp = (rel: string) => import(pathToFileURL(path.join(BUILD, rel)).href);
  const shadersMod = await imp("shaders-entry.js");
  const vert: string = shadersMod.vertexShaderSource;
  const noiseSrc = /noiseSrc\s*=\s*'data:image\/png;base64,([^']+)'/.exec(fs.readFileSync(path.join(VENDOR, "packages/shaders/src/get-shader-noise-texture.ts"), "utf8"))![1];
  const noise = decodePng(Buffer.from(noiseSrc, "base64"));
  if (noise.w !== 128 || noise.h !== 128) throw new Error(`noise ${noise.w}x${noise.h}`);
  fs.writeFileSync(OUT_NOISE, noise.rgba);

  const shaders: PaperShader[] = [];
  const cases: unknown[] = [];
  const failures: string[] = [];
  for (const id of IDS) {
    try {
      const react = await imp(`packages/shaders-react/src/shaders/${id}.js`);
      const defMod = await imp(`docs/src/shader-defs/${id}-def.js`);
      const def = Object.values(defMod).find((x: any) => x && Array.isArray(x.params)) as { name: string; description: string; params: any[] };
      const presets = react[`${camel(id)}Presets`] as { name: string; params: Record<string, unknown> }[];
      const Component = react[pascal(id)] as (p: Record<string, unknown>) => { props: { fragmentShader: string; uniforms: Record<string, unknown>; speed?: number; frame?: number } };
      if (!def || !presets || typeof Component !== "function") throw new Error("def, presets or component missing");
      const fragExport = Object.entries(shadersMod).find(([k]) => k === `${camel(id)}FragmentShader`);
      if (!fragExport) throw new Error("fragment shader export missing");
      const frag = fragExport[1] as string;
      const map = uniformMap(id);
      const enums: Record<string, Record<string, number>> = {};
      for (const m of map) if (m.kind === "enum") enums[m.enumName!] = m.enumName === "ShaderFitOptions" ? shadersMod.ShaderFitOptions : shadersMod[m.enumName!];
      const { glsl, slots, noise: usesNoise } = buildGlsl(frag, vert);
      const wgsl = translate(id, glsl);
      const lint = lintWgsl(wgsl);
      if (lint.length) throw new Error(`lint: ${lint.map((e) => `${e.line}:${e.col} ${e.message}`).join("; ")}`);
      const defaults = { ...presets[0].params };
      const params = def.params
        .filter((p) => !["width", "height", "minPixelRatio", "maxPixelCount", "image", "suspendWhenProcessingImage"].includes(p.name))
        .map((p) => {
          // Presets may use values the docs leave out of the picker (fit: "none" on pattern presets).
          const options = p.options ? [...new Set([...(p.options as any[]).map((o) => (typeof o === "string" ? o : o.name)), ...presets.map((pr) => pr.params[p.name]).filter((x): x is string => typeof x === "string")])] : undefined;
          const dflt = p.defaultValue !== undefined && !(Array.isArray(p.defaultValue) && !p.defaultValue.length) ? p.defaultValue : defaults[p.name];
          const type = p.isColor ? (p.type.endsWith("[]") ? "colors" : "color") : options ? "enum" : p.type === "boolean" ? "boolean" : "number";
          const maxCount = type === "colors" ? (Object.entries(shadersMod).find(([k]) => k === `${camel(id)}Meta`)?.[1] as any)?.maxColorCount : undefined;
          return { name: p.name, type, description: p.description, ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.step !== undefined ? { step: p.step } : {}), ...(options ? { options } : {}), ...(maxCount ? { maxCount } : {}), default: dflt ?? defaults[p.name] };
        });
      // Every parameter the uniforms read must be in the schema.
      for (const m of map) if (m.param && !params.some((p) => p.name === m.param) && !(m.param in defaults)) throw new Error(`uniform ${m.uniform} reads ${m.param}, not in the schema`);
      const shader: PaperShader = {
        id, name: def.name, description: def.description, component: pascal(id), fragmentExport: `${camel(id)}FragmentShader`,
        animated: params.some((p) => p.name === "speed"), noise: usesNoise, params, presets: presets.map((p) => ({ name: p.name, params: p.params })),
        uniforms: map, enums, slots, wgsl,
      };
      // Our params -> uniforms must equal Paper's for every preset (the React component's own uniforms object).
      for (const pr of presets) {
        const theirs = Component(pr.params).props;
        const ours = packUniforms(shader, pr.params).uniforms;
        for (const [k, v] of Object.entries(theirs.uniforms)) {
          if (k === "u_noiseTexture" || k === "u_image") continue;
          if (!same(ours[k], v)) throw new Error(`${pr.name}: ${k} ours ${JSON.stringify(ours[k])} theirs ${JSON.stringify(v)}`);
        }
        cases.push({ id, preset: pr.name, frag, vert, uniforms: Object.fromEntries(Object.entries(theirs.uniforms).filter(([k]) => k !== "u_noiseTexture" && k !== "u_image")), speed: theirs.speed ?? 0, frame: theirs.frame ?? 0, packed: packUniforms(shader, pr.params).packed, noise: usesNoise, hasImage: /\bu_image\b/.test(frag) });
      }
      shaders.push(shader);
      console.log(`ok   ${id}: ${presets.length} presets, ${slots.length} uniforms, ${wgsl.length} B wgsl`);
    } catch (e) {
      failures.push(`${id}: ${(e as Error).message}`);
      console.log(`FAIL ${id}: ${(e as Error).message.slice(0, 600)}`);
    }
  }
  fs.mkdirSync(path.dirname(OUT_LIB), { recursive: true });
  fs.writeFileSync(OUT_LIB, JSON.stringify({ source: "github.com/paper-design/shaders", commit: COMMIT, license: "Apache-2.0", shaders }, null, 1) + "\n");
  fs.mkdirSync(OUT_PARITY, { recursive: true });
  fs.writeFileSync(path.join(OUT_PARITY, "cases.json"), JSON.stringify({ cases, wrapper: wrapperFromEngine(), wgsl: Object.fromEntries(shaders.map((s) => [s.id, s.wgsl])) }));
  fs.writeFileSync(path.join(OUT_PARITY, "noise.rgba"), noise.rgba);
  fs.rmSync(BUILD, { recursive: true, force: true });
  console.log(`${shaders.length}/${IDS.length} translated, ${cases.length} presets${failures.length ? `; failed: ${failures.length}` : ""}`);
  if (failures.length) process.exitCode = 1;
}

/** The engine's WRAPPER (engine/src/shaders.rs), so the parity page compiles exactly what a card compiles. */
function wrapperFromEngine(): string {
  const rs = fs.readFileSync(path.join(ROOT, "engine/src/shaders.rs"), "utf8");
  const m = /pub const WRAPPER: &str = r#"([\s\S]*?)"#;/.exec(rs);
  if (!m) throw new Error("WRAPPER not found in engine/src/shaders.rs");
  return m[1];
}

main().catch((e) => { fs.rmSync(BUILD, { recursive: true, force: true }); console.error(e); process.exit(1); });
