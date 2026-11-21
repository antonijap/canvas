// Shader cards: a WGSL fragment shader drawn by the GPU engine on a free-standing card. The source
// lives in a file beside the widgets (src/shaders.ts); the widget holds its revision and how it plays.

import { bad, bool, extras, obj, str } from "../check.ts";
import type { Config, WidgetKind } from "../types.ts";

const KNOWN = ["rev", "autoplay", "quarantined", "paper", "uniforms"];

/** A Paper Shaders preset card (src/paper.ts): which shader, the preset it started from, its params. */
function paper(v: unknown): Config | undefined {
  if (v === undefined || v === null) return undefined;
  const o = obj(v, "paper");
  const shader = str(o.shader, "paper.shader", "", 60);
  if (!/^[a-z0-9-]+$/.test(shader)) throw bad("paper.shader", "must be a Paper shader id");
  const params = obj(o.params, "paper.params");
  if (JSON.stringify(params).length > 16 * 1024) throw bad("paper.params", "is too large");
  return { shader, preset: str(o.preset, "paper.preset", "", 60), params };
}

/** u.params for the engine: at most 128 finite numbers. */
function uniforms(v: unknown): number[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 128 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) throw bad("uniforms", "must be at most 128 finite numbers");
  return v as number[];
}

/** What a new shader card starts with. Same contract as engine/src/shaders.rs. */
export const SHADER_TEMPLATE = `// fn shade gets this pixel in card px: (0,0) top-left, u.resolution bottom-right.
// Uniforms: u.resolution, u.time (s), u.delta, u.frame, u.mouse (x, y, hovered, pressed), u.params[4].
// Return premultiplied RGBA (rgb already multiplied by alpha).
fn shade(p: vec2<f32>) -> vec4<f32> {
  let uv = p / u.resolution;
  let t = u.time * 0.4;
  let a = 0.5 + 0.5 * sin(6.2831 * (uv.x + t));
  let b = 0.5 + 0.5 * sin(6.2831 * (uv.y * 0.8 - t * 0.7));
  let c = mix(vec3<f32>(0.10, 0.12, 0.35), vec3<f32>(0.95, 0.45, 0.30), a * b);
  return vec4<f32>(c, 1.0);
}
`;

export const shader: WidgetKind = {
  id: "shader",
  title: "Shader",
  description: "A live shader canvas",
  symbol: "camera.filters",
  defaultSize: { w: 480, h: 270 },
  minSize: { w: 96, h: 64 },
  defaults: () => ({ rev: "", autoplay: true, quarantined: false }),
  validate(c: Config): Config {
    const rev = str(c.rev, "rev", "", 40);
    if (!/^[0-9a-f]*$/.test(rev)) throw bad("rev", "must be a hex revision");
    const p = paper(c.paper), u = uniforms(c.uniforms);
    return { rev, autoplay: bool(c.autoplay, "autoplay", true), quarantined: bool(c.quarantined, "quarantined", false), ...(p ? { paper: p } : {}), ...(u ? { uniforms: u } : {}), ...extras(c, KNOWN) };
  },
  fields: [
    { key: "autoplay", label: "Play on its own", type: "bool", help: "Off: it shows a still frame and plays only while the pointer is over it." },
  ],
};
