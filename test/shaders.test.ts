// Shader cards on disk: the static checks (same rules as engine/src/shaders.rs), the source file beside
// the widgets, revisions, posters and the quarantine, against a real server on its own port.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { lintWgsl, revOf, shaderDir, SHADER_TEMPLATE } from "../src/shaders.ts";
import { tmpDir, writeDoc } from "./helpers.ts";

const dir = tmpDir("shaders");
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

const q = (file: string, extra = "") => `?file=${encodeURIComponent(file)}${extra}`;
async function j(method: string, p: string, body?: unknown, headers: Record<string, string> = { "x-canvas": "1" }) {
  const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
const OK = "fn shade(p: vec2<f32>) -> vec4<f32> {\n  let uv = p / u.resolution;\n  return vec4<f32>(uv, 0.5, 1.0);\n}\n";

describe("lintWgsl", () => {
  test("a plain shader and the template pass", () => {
    assert.deepEqual(lintWgsl(OK), []);
    assert.deepEqual(lintWgsl(SHADER_TEMPLATE), []);
  });
  test("entry points, bindings, memory, textures, extensions: refused with line and column", () => {
    const e = lintWgsl("@group(0) @binding(1) var<storage, read_write> b: array<f32>;\n@compute @workgroup_size(1) fn main() {}\nenable f16;\nfn f(t: texture_2d<f32>, s: sampler) {}\n" + OK);
    const at = e.map((x) => `${x.line}:${x.col}:${x.message.split(":")[0]}`);
    for (const want of ["1:1:@group", "1:11:@binding", "2:1:@compute", "2:10:@workgroup_size", "3:1:enable", "4:9:textures are not allowed", "4:29:sampler"]) assert.ok(at.includes(want), `${want} in ${at.join(", ")}`);
    assert.ok(e.some((x) => x.line === 1 && x.message.startsWith("storage")));
  });
  test("comments and identifiers that contain a banned word pass", () => {
    assert.deepEqual(lintWgsl("// @compute storage loop\n/* while (true) */\n" + OK.replace("let uv", "let storage_like = 1.0; let my_loop = 2.0; let uv")), []);
  });
  test("loops: unbounded ones refused, bounded ones pass (best effort)", () => {
    const bad = "fn shade(p: vec2<f32>) -> vec4<f32> {\n  loop { }\n  while (true) { }\n  for (var i = 0; ; i++) { }\n  return vec4<f32>(1.0);\n}\n";
    assert.deepEqual(lintWgsl(bad).map((e) => e.line), [2, 3, 4]);
    assert.deepEqual(lintWgsl("fn shade(p: vec2<f32>) -> vec4<f32> {\n  var s = 0.0;\n  for (var i = 0; i < 64; i++) { s += 0.01; }\n  loop { s += 1.0; if (s > 3.0) { break; } }\n  return vec4<f32>(s);\n}\n"), []);
  });
  test("needs fn shade and stays under 64 KB", () => {
    assert.match(lintWgsl("const shade = 1.0;")[0].message, /fn shade/);
    assert.match(lintWgsl(OK + " ".repeat(64 * 1024))[0].message, /limit/);
  });
});

describe("shader files", () => {
  test("create writes the source beside the widgets, then the widget with its revision", async () => {
    const r = await j("POST", "/api/shaders" + q(docFile), { source: OK, name: "Glow", x: 10, y: 20, w: 300, h: 200 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const w = r.body.widget;
    assert.equal(w.kind, "shader");
    assert.equal(w.config.rev, revOf(OK));
    assert.deepEqual(r.body.problems, []);
    const file = path.join(dir, "demo.shaders", `${w.id}.wgsl`);
    assert.equal(shaderDir(docFile), path.join(dir, "demo.shaders"));
    assert.equal(fs.readFileSync(file, "utf8"), OK);
    assert.deepEqual(fs.readdirSync(path.join(dir, "demo.shaders")).filter((f) => f.endsWith(".tmp")), [], "no temp files left");
    const src = await fetch(base + `/api/shaders/${w.id}/source` + q(docFile));
    assert.equal(await src.text(), OK);
    assert.equal(src.headers.get("x-shader-rev"), revOf(OK));
  });

  test("a new source gets a new revision and clears the quarantine; problems come back, the file is kept", async () => {
    const made = (await j("POST", "/api/shaders" + q(docFile), { source: OK })).body.widget;
    await j("PATCH", `/api/widgets/${made.id}` + q(docFile), { config: { quarantined: true } });
    const bad = "@compute fn x() {}\n";
    const r = await j("PUT", `/api/shaders/${made.id}` + q(docFile), { source: bad });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.rev, revOf(bad));
    assert.equal(r.body.widget.config.quarantined, false);
    assert.ok(r.body.problems.length >= 2);
    const list = (await j("GET", "/api/shaders" + q(docFile))).body.shaders.find((s: any) => s.id === made.id);
    assert.equal(list.rev, revOf(bad));
    assert.equal(list.template, false);
  });

  test("a copy of a custom shader card (copyFrom) keeps the source", async () => {
    const src = (await j("POST", "/api/shaders" + q(docFile), { source: OK, name: "Glow" })).body.widget;
    const r = await j("POST", "/api/shaders" + q(docFile), { copyFrom: src.id, x: 50, y: 60, w: 300, h: 200 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const copy = r.body.widget;
    assert.notEqual(copy.id, src.id);
    assert.equal(copy.name, "Glow");
    assert.equal(copy.config.rev, revOf(OK));
    const text = await fetch(base + `/api/shaders/${copy.id}/source` + q(docFile));
    assert.equal(text.headers.get("x-shader-template"), "0");
    assert.equal(await text.text(), OK);
    assert.equal(fs.readFileSync(path.join(dir, "demo.shaders", `${copy.id}.wgsl`), "utf8"), OK);
    assert.equal((await j("POST", "/api/shaders" + q(docFile), { copyFrom: "sh_nope" })).status, 404);
  });

  test("a card added through the generic widget route reads the template until it is saved", async () => {
    const w = (await j("POST", "/api/widgets" + q(docFile), { kind: "shader" })).body.widget;
    assert.equal(w.config.autoplay, true);
    const src = await fetch(base + `/api/shaders/${w.id}/source` + q(docFile));
    assert.equal(src.headers.get("x-shader-template"), "1");
    assert.equal(await src.text(), SHADER_TEMPLATE);
  });

  test("posters: stored per revision, only for the current one, older ones removed", async () => {
    const w = (await j("POST", "/api/shaders" + q(docFile), { source: OK })).body.widget;
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const put = (rev: string, body: Buffer) => fetch(base + `/api/shaders/${w.id}/poster` + q(docFile, `&rev=${rev}`), { method: "PUT", headers: { "x-canvas": "1", "content-type": "image/png" }, body: new Uint8Array(body) });
    assert.equal((await (await put(revOf(OK), png)).json()).saved, true);
    assert.equal((await fetch(base + `/api/shaders/${w.id}/poster` + q(docFile, `&rev=${revOf(OK)}`))).status, 200);
    assert.equal((await (await put("aaaaaaaaaaaa", png)).json()).saved, false, "not the current source");
    assert.equal((await put(revOf(OK), Buffer.from("not a png"))).status, 400);
    const next = OK.replace("0.5", "0.25");
    await j("PUT", `/api/shaders/${w.id}` + q(docFile), { source: next });
    await put(revOf(next), png);
    const files = fs.readdirSync(shaderDir(docFile)).filter((f) => f.startsWith(`${w.id}.poster-`));
    assert.deepEqual(files, [`${w.id}.poster-${revOf(next)}.png`]);
  });

  test("writes need the x-canvas header; a package keeps shaders inside it; too big is refused", async () => {
    assert.equal((await j("POST", "/api/shaders" + q(docFile), { source: OK }, {})).status, 403);
    const pkg = path.join(dir, "Doc.canvas");
    fs.mkdirSync(pkg);
    fs.copyFileSync(docFile, path.join(pkg, "document.json"));
    fs.writeFileSync(path.join(pkg, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }));
    const r = await j("POST", "/api/shaders" + q(pkg), { source: OK });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(fs.existsSync(path.join(pkg, "shaders", `${r.body.widget.id}.wgsl`)));
    assert.equal((await j("POST", "/api/shaders" + q(docFile), { source: "x".repeat(65 * 1024) })).status, 413);
  });
});
