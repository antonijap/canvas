// Shader fills: a layer's fill of type "shader", drawn by the engine from a texture its shader renders into (like a
// shader card's), clipped to the layer's shape and under its children. Two ways to name the shader:
//
//   { "type": "shader", "shader": "mesh-gradient", "preset": "Ink", "params": { "speed": 0.5 } }
//       a Paper Shaders preset (list_shader_presets): `preset` and `params` optional, params override the preset
//   { "type": "shader", "source": "fn shade(p: vec2<f32>) -> vec4<f32> { ... }", "uniforms": [0.5, 1] }
//       hand-written WGSL with the shader card contract (src/widgets/kinds/shader.ts), uniforms are u.params
//
// Both take `opacity` (0 to 1), `enabled` and `autoplay` (default: the preset moves, or true for WGSL). Fills paint
// in list order, the last on top. A shader tile dropped on a layer (src/page/shader-drop-logic.js) adds one on top.
//
// The engine and the headless renderer need WGSL and packed params: `resolveShaderFill` turns either form into
// { source, uniforms, play }. The scene (src/scene.ts) and the HTML renderer (src/doc/render/html.ts) call it.

import { packUniforms, paperShader, PaperError, resolveParams } from "./paper.ts";

/** Largest WGSL source (the engine refuses bigger ones too; src/shaders.ts MAX_SOURCE). */
const MAX_SOURCE = 64 * 1024;

export type ResolvedShader = { source: string; uniforms: number[]; play: boolean };

const trimZeros = (a: number[]) => {
  let n = a.length;
  while (n && a[n - 1] === 0) n--;
  return a.slice(0, n).map((x) => Math.round(x * 1e6) / 1e6);
};

// The same preset and params resolve to the same answer: a board scene with forty buttons asks forty times.
const cache = new Map<string, ResolvedShader | string>();
const CACHE_MAX = 256;

/** WGSL, packed params and whether it plays, or an error message saying what is wrong with the fill. */
export function resolveShaderFill(f: Record<string, unknown>): ResolvedShader | { error: string } {
  const key = JSON.stringify([f.shader, f.preset, f.params, f.source, f.uniforms, f.autoplay]);
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = resolveUncached(f);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, hit);
  }
  return typeof hit === "string" ? { error: hit } : hit;
}

function resolveUncached(f: Record<string, unknown>): ResolvedShader | string {
  const autoplay = typeof f.autoplay === "boolean" ? f.autoplay : undefined;
  if (typeof f.shader === "string") {
    const s = paperShader(f.shader);
    if (!s) return `no Paper shader "${f.shader}" (list_shader_presets lists them)`;
    // A preset name the shader does not have (an old file, "Custom") starts from its default.
    const preset = typeof f.preset === "string" && s.presets.some((p) => p.name.toLowerCase() === String(f.preset).toLowerCase()) ? f.preset : undefined;
    const over = f.params && typeof f.params === "object" && !Array.isArray(f.params) ? (f.params as Record<string, unknown>) : {};
    try {
      const r = resolveParams(s, preset, over);
      return { source: s.wgsl, uniforms: trimZeros(packUniforms(s, r.params).packed), play: autoplay ?? (s.animated && Number(r.params.speed ?? 0) !== 0) };
    } catch (e) {
      return e instanceof PaperError ? e.message : String(e);
    }
  }
  if (typeof f.source === "string") {
    if (Buffer.byteLength(f.source) > MAX_SOURCE) return `the shader is larger than ${MAX_SOURCE / 1024} KB`;
    // The engine checks the source before it compiles it (engine/src/shaders.rs check_source) and draws nothing for one it refuses.
    const u = Array.isArray(f.uniforms) ? f.uniforms.slice(0, 128).map((x) => (typeof x === "number" && Number.isFinite(x) ? x : 0)) : [];
    return { source: f.source, uniforms: u, play: autoplay ?? true };
  }
  return "a shader fill needs shader (a Paper shader id) or source (WGSL)";
}

/** The fill a Paper shader tile makes: "mesh-gradient" or "mesh-gradient/Ink", with the preset's full params. */
export function presetFill(preset: string): Record<string, unknown> {
  const [id, variant] = preset.includes("/") ? preset.split("/", 2) : [preset, undefined];
  const s = paperShader(id);
  if (!s) throw new PaperError(`No Paper shader "${id}"`);
  const r = resolveParams(s, variant);
  return { type: "shader", shader: s.id, preset: r.preset, params: r.params };
}
