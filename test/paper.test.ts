// Paper Shaders presets (src/paper.ts, src/paper/library.json from scripts/paper/gen.ts): the library, the
// params schema and checks, the packing into u.params, the React/HTML export, and the shader routes that
// create and change preset cards, against a real server on its own port.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { htmlSnippet, library, packUniforms, PARAM_SLOTS, paperShader, reactSnippet, resolveParams } from "../src/paper.ts";
import { cardRev, lintWgsl, shaderDir } from "../src/shaders.ts";
import { tmpDir, writeDoc } from "./helpers.ts";

const dir = tmpDir("paper");
process.env.CANVAS_ROOTS = dir;
const docFile = writeDoc(dir);
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
after(() => {
  fs.unwatchFile(docFile);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const q = (extra = "") => `?file=${encodeURIComponent(docFile)}${extra}`;
async function j(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "x-canvas": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

describe("library", () => {
  test("every shader: WGSL that passes our checks and fits, a schema, a Default preset, slots inside u.params", () => {
    const lib = library();
    assert.match(lib.commit, /^[0-9a-f]{40}$/);
    assert.ok(lib.shaders.length >= 20, `${lib.shaders.length} shaders`);
    for (const s of lib.shaders) {
      assert.deepEqual(lintWgsl(s.wgsl), [], s.id);
      assert.ok(s.wgsl.length < 64 * 1024, s.id);
      assert.match(s.wgsl, /fn shade\(p: vec2<f32>\) -> vec4<f32>/, s.id);
      assert.ok(s.presets.some((p) => p.name === "Default"), s.id);
      for (const sl of s.slots) {
        const end = sl.slot + (sl.count && sl.type === "vec4" ? sl.count : sl.count ? Math.ceil(sl.count / 4) : 1);
        assert.ok(sl.slot >= 1 && end <= PARAM_SLOTS, `${s.id} ${sl.uniform}`);
      }
      // Two uniforms never share a component.
      const used = new Set<string>();
      for (const sl of s.slots) {
        const comps = sl.count && sl.type === "vec4" ? Array.from({ length: sl.count * 4 }, (_, k) => sl.slot * 4 + k)
          : sl.count ? Array.from({ length: sl.count }, (_, k) => sl.slot * 4 + k)
          : sl.type.startsWith("vec") ? [0, 1, 2, 3].map((k) => sl.slot * 4 + k) : [sl.slot * 4 + sl.comp];
        for (const c of comps) { assert.ok(!used.has(String(c)), `${s.id} ${sl.uniform} overlaps at ${c}`); used.add(String(c)); }
      }
    }
  });

  test("packing: speed and frame in slot 0, colours as premultiplied-free RGBA, counts and enums", () => {
    const s = paperShader("mesh-gradient")!;
    const { packed, uniforms } = packUniforms(s, { speed: 0.5, frame: 1200, colors: ["#ff0000", "#00ff0080"] });
    assert.equal(packed.length, PARAM_SLOTS * 4);
    assert.deepEqual(packed.slice(0, 2), [0.5, 1200]);
    const colors = s.slots.find((x) => x.uniform === "u_colors")!;
    assert.deepEqual(packed.slice(colors.slot * 4, colors.slot * 4 + 8).map((x) => Math.round(x * 100) / 100), [1, 0, 0, 1, 0, 1, 0, 0.5]);
    assert.equal(uniforms.u_colorsCount, 2);
    const fit = s.slots.find((x) => x.uniform === "u_fit")!;
    assert.equal(packed[fit.slot * 4 + fit.comp], 1, "contain");
    const g = paperShader("grain-gradient")!;
    const shape = g.slots.find((x) => x.uniform === "u_shape")!;
    assert.equal(packUniforms(g, { shape: "wave" }).packed[shape.slot * 4 + shape.comp], g.enums.GrainGradientShapes!.wave);
  });

  test("params: presets by name, ranges clamped, unknown names and bad values refused", () => {
    const s = paperShader("mesh-gradient")!;
    assert.equal(resolveParams(s, "ink").preset, "Ink");
    const r = resolveParams(s, undefined, { distortion: 7, scale: -3 });
    assert.equal(r.params.distortion, 1);
    assert.equal(r.params.scale, 0.01);
    assert.throws(() => resolveParams(s, "nope"), /no preset "nope"/);
    assert.throws(() => resolveParams(s, undefined, { wobble: 1 }), /no parameter "wobble"/);
    assert.throws(() => resolveParams(s, undefined, { colors: ["red"] }), /colour/);
    assert.throws(() => resolveParams(s, undefined, { colors: Array(11).fill("#fff") }), /at most 10/);
    assert.throws(() => resolveParams(paperShader("grain-gradient")!, undefined, { shape: "lava" }), /one of/);
  });

  test("export: React component and vanilla ShaderMount with the card's params", () => {
    const s = paperShader("grain-gradient")!;
    const { params } = resolveParams(s, "Wave", { softness: 0.3 });
    const react = reactSnippet({ shader: s.id, preset: "Wave", params }, { w: 480, h: 270 });
    assert.match(react, /import \{ GrainGradient \} from '@paper-design\/shaders-react';/);
    assert.match(react, /width=\{480\}/);
    assert.match(react, /softness=\{0\.3\}/);
    assert.match(react, /shape="wave"/);
    const html = htmlSnippet({ shader: s.id, preset: "Wave", params }, { w: 480, h: 270 });
    assert.match(html, /new ShaderMount\(document.getElementById\('paper-grain-gradient'\), grainGradientFragmentShader/);
    assert.match(html, /u_shape: GrainGradientShapes\["wave"\]/);
    assert.match(html, /await noise.decode\(\)/);
  });
});

describe("preset cards", () => {
  test("list, create from a preset, change params without a new source, switch shader, export, back to WGSL", async () => {
    const list = await j("GET", "/api/shaders/presets");
    assert.equal(list.status, 200);
    assert.ok(list.body.shaders.some((s: any) => s.id === "metaballs" && s.presets.includes("Default")));
    const one = await j("GET", "/api/shaders/presets/metaballs");
    assert.ok(one.body.presets[0].params.colors.length > 0);

    const made = await j("POST", "/api/shaders" + q(), { preset: "mesh-gradient/Ink", params: { distortion: 0.5 }, x: 0, y: 0, w: 400, h: 300 });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const w = made.body.widget;
    assert.equal(w.name, "Mesh Gradient (Ink)");
    assert.equal(w.config.paper.shader, "mesh-gradient");
    assert.equal(w.config.paper.params.distortion, 0.5);
    assert.equal(w.config.paper.params.rotation, 90, "Ink's rotation");
    assert.deepEqual(made.body.problems, []);
    const file = path.join(shaderDir(docFile), `${w.id}.wgsl`);
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source, paperShader("mesh-gradient")!.wgsl);
    assert.equal(w.config.rev, cardRev(source, w.config.uniforms));
    const src = await fetch(base + `/api/shaders/${w.id}/source` + q());
    assert.equal(src.headers.get("x-shader-rev"), w.config.rev);
    await src.text();

    const mtime = fs.statSync(file).mtimeMs;
    const p2 = await j("PUT", `/api/shaders/${w.id}` + q(), { params: { swirl: 0.9, colors: ["#000000", "#ffffff"] } });
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    assert.equal(p2.body.widget.config.paper.params.swirl, 0.9);
    assert.equal(p2.body.widget.config.paper.params.distortion, 0.5, "kept");
    assert.deepEqual(p2.body.widget.config.paper.params.colors, ["#000000", "#ffffff"]);
    assert.equal(p2.body.widget.config.paper.preset, "Custom");
    assert.notEqual(p2.body.rev, w.config.rev, "new params, new revision (and poster)");
    assert.equal(fs.statSync(file).mtimeMs, mtime, "same source: not rewritten");

    const bad = await j("PUT", `/api/shaders/${w.id}` + q(), { params: { wobble: 1 } });
    assert.equal(bad.status, 422);
    assert.match(bad.body.error, /no parameter "wobble"/);

    const sw = await j("PUT", `/api/shaders/${w.id}` + q(), { preset: "dot-grid" });
    assert.equal(sw.status, 200, JSON.stringify(sw.body));
    assert.equal(sw.body.widget.config.paper.shader, "dot-grid");
    assert.equal(sw.body.widget.config.paper.params.swirl, undefined, "mesh params cleared");
    assert.equal(fs.readFileSync(file, "utf8"), paperShader("dot-grid")!.wgsl);

    const ex = await j("GET", `/api/shaders/${w.id}/export` + q("&format=react"));
    assert.equal(ex.status, 200);
    assert.match(ex.body.code, /<DotGrid/);
    assert.match(ex.body.code, /width=\{400\}/);
    const listed = (await j("GET", "/api/shaders" + q())).body.shaders.find((s: any) => s.id === w.id);
    assert.equal(listed.paper.shader, "dot-grid");

    const custom = await j("PUT", `/api/shaders/${w.id}` + q(), { source: "fn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.0); }\n" });
    assert.equal(custom.status, 200);
    assert.equal(custom.body.widget.config.paper, undefined);
    assert.equal(custom.body.widget.config.uniforms, undefined);
    assert.equal((await j("GET", `/api/shaders/${w.id}/export` + q())).status, 422);
    assert.equal((await j("PUT", `/api/shaders/${w.id}` + q(), { params: { speed: 1 } })).status, 422, "not a preset card any more");
  });

  test("unknown shader and bad variant are refused before anything is written", async () => {
    const before = fs.existsSync(shaderDir(docFile)) ? fs.readdirSync(shaderDir(docFile)).length : 0;
    const a = await j("POST", "/api/shaders" + q(), { preset: "lava-lamp" });
    assert.equal(a.status, 422);
    assert.match(a.body.error, /No Paper shader "lava-lamp"/);
    assert.equal((await j("POST", "/api/shaders" + q(), { preset: "warp", variant: "Nope" })).status, 422);
    assert.equal(fs.existsSync(shaderDir(docFile)) ? fs.readdirSync(shaderDir(docFile)).length : 0, before);
  });
});
