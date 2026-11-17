// Shader fills and dropped images: how a shader fill resolves (src/shader-fill.ts), what the schema accepts, the
// write a Cmd-drop makes (one undo step, byte for byte), the engine scene it gives, and image files copied into
// the document (src/images.ts). Against a real server on its own port, on a .canvas package.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import zlib from "node:zlib";
import { tmpDir } from "./helpers.ts";
import { presetFill, resolveShaderFill } from "../src/shader-fill.ts";
import { imageSize, safeStem, sniffImage } from "../src/images.ts";
import { validateNode } from "../src/engine.ts";
// @ts-ignore: a browser module without types
import { fillTarget, shaderFill, withFill, imageFill } from "../src/page/drop-logic.js";

const dir = tmpDir("shader-fill");
process.env.CANVAS_ROOTS = dir;
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const watched: string[] = [];
after(() => {
  for (const p of watched) fs.unwatchFile(p);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 90_000_000;
history.setClock(() => clock);
async function call(method: string, p: string, body?: unknown, raw?: Buffer) {
  const r = await fetch(base + p, { method, headers: { "content-type": raw ? "application/octet-stream" : "application/json", "x-canvas": "1" }, body: raw ? new Uint8Array(raw) : (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
const q = (file: string, extra = "") => `?file=${encodeURIComponent(file)}${extra}`;

const DOC = {
  version: "2.22",
  children: [
    { type: "frame", id: "Lib", x: 0, y: 0, width: 300, height: 200, layout: "none", children: [
      { type: "frame", id: "Btn", name: "Button", reusable: true, x: 10, y: 10, width: 160, height: 48, cornerRadius: 12, layout: "none", fill: "#222222", children: [
        { type: "rectangle", id: "Bg", x: 4, y: 4, width: 40, height: 40, fill: "#FF0000" },
      ] },
    ] },
    { type: "frame", id: "Screen", x: 400, y: 0, width: 400, height: 300, layout: "none", fill: "#FFFFFF", children: [
      { type: "frame", id: "Card", x: 20, y: 20, width: 200, height: 100, cornerRadius: 16, layout: "none", fill: "#EEEEEE", children: [] },
      { type: "ref", id: "Inst", ref: "Btn", x: 20, y: 200 },
    ] },
  ],
};

async function freshPackage(name: string) {
  const pkg = path.join(dir, name + ".canvas");
  fs.mkdirSync(pkg, { recursive: true });
  const doc = path.join(pkg, "document.json");
  fs.writeFileSync(doc, JSON.stringify(DOC, null, 2));
  watched.push(fs.realpathSync(doc));
  await call("POST", "/api/update", { file: pkg, id: "Lib", props: {} });
  history.resetHistory();
  clock += 5000;
  return { pkg: fs.realpathSync(pkg), doc: fs.realpathSync(doc) };
}
const findIn = (list: any[], id: string): any => {
  for (const n of list ?? []) {
    if (n.id === id) return n;
    const k = findIn(n.children, id);
    if (k) return k;
  }
  return null;
};

describe("resolveShaderFill", () => {
  test("a Paper preset gives its WGSL, packed params and whether it moves", () => {
    const r = resolveShaderFill({ type: "shader", shader: "mesh-gradient" }) as any;
    assert.match(r.source, /fn shade/);
    assert.ok(r.uniforms.length > 2 && r.uniforms.every(Number.isFinite));
    assert.equal(r.play, true);
    const still = resolveShaderFill({ type: "shader", shader: "dot-grid" }) as any;
    assert.equal(still.play, false, "dot-grid does not animate");
    const slow = resolveShaderFill({ type: "shader", shader: "mesh-gradient", params: { speed: 0 } }) as any;
    assert.equal(slow.play, false);
    assert.notDeepEqual((resolveShaderFill({ type: "shader", shader: "mesh-gradient", preset: "Ink" }) as any).uniforms, r.uniforms);
  });
  test("an unknown preset name starts from the default; unknown shaders and params are errors", () => {
    assert.deepEqual((resolveShaderFill({ type: "shader", shader: "mesh-gradient", preset: "Custom" }) as any).uniforms, (resolveShaderFill({ type: "shader", shader: "mesh-gradient" }) as any).uniforms);
    assert.match((resolveShaderFill({ type: "shader", shader: "nope" }) as any).error, /no Paper shader/);
    assert.match((resolveShaderFill({ type: "shader", shader: "mesh-gradient", params: { wobble: 1 } }) as any).error, /no parameter "wobble"/);
    assert.match((resolveShaderFill({ type: "shader" }) as any).error, /needs shader/);
  });
  test("hand-written WGSL passes through with its uniforms", () => {
    const src = "fn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.0); }";
    assert.deepEqual(resolveShaderFill({ type: "shader", source: src, uniforms: [1, 2, Infinity] }), { source: src, uniforms: [1, 2, 0], play: true });
  });
  test("presetFill names the shader and preset with its params", () => {
    const f = presetFill("mesh-gradient/Ink") as any;
    assert.equal(f.shader, "mesh-gradient");
    assert.equal(f.preset, "Ink");
    assert.ok(Array.isArray(f.params.colors));
  });
});

describe("schema", () => {
  const node = (fill: unknown) => ({ type: "rectangle", id: "r", width: 10, height: 10, fill }) as any;
  test("a shader fill needs shader or source; the rest is typed", () => {
    assert.deepEqual(validateNode(node({ type: "shader", shader: "mesh-gradient", preset: "Ink", params: { speed: 1 }, opacity: 0.5 })), []);
    assert.deepEqual(validateNode(node({ type: "shader", source: "fn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.0); }", uniforms: [1, 2] })), []);
    assert.match(validateNode(node({ type: "shader" })).join(), /needs shader/);
    assert.match(validateNode(node({ type: "shader", shader: "Mesh Gradient" })).join(), /Paper shader id/);
    assert.match(validateNode(node({ type: "shader", shader: "x", uniforms: ["a"] })).join(), /uniforms/);
  });
});

describe("Cmd-drop of a shader tile (the page's write)", () => {
  test("goes on top of the layer's fills, one undo step, byte for byte", async () => {
    const { pkg, doc } = await freshPackage("card");
    const before = fs.readFileSync(doc, "utf8");
    const n = (await call("GET", "/api/node" + q(pkg, "&id=Card&depth=0"))).body;
    const fill = withFill(n.node.fill, shaderFill("mesh-gradient"));
    const r = await call("POST", "/api/update", { file: pkg, id: "Card", props: { fill }, expectedRevision: n.revision });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after1 = fs.readFileSync(doc, "utf8");
    assert.deepEqual(findIn(JSON.parse(after1).children, "Card").fill, ["#EEEEEE", { type: "shader", shader: "mesh-gradient", preset: "Default" }]);
    // The engine's scene: WGSL and packed params, how it plays.
    const scene = (await call("GET", "/api/scene" + q(pkg, "&id=Screen"))).body;
    const sf = findIn([scene.root], "Card").fill[1];
    assert.match(sf.source, /fn shade/);
    assert.ok(Array.isArray(sf.uniforms) && sf.play === true);
    clock += 5000;
    assert.equal((await call("POST", "/api/history/undo" + q(pkg))).status, 200);
    assert.equal(fs.readFileSync(doc, "utf8"), before, "undo gives the original bytes");
    assert.equal((await call("POST", "/api/history/redo" + q(pkg))).status, 200);
    assert.equal(fs.readFileSync(doc, "utf8"), after1, "redo gives the end bytes");
  });
  test("on a layer inside an instance: an override; the component stays", async () => {
    const { pkg, doc } = await freshPackage("inst");
    const n = (await call("GET", "/api/node" + q(pkg, "&id=" + encodeURIComponent("Inst/Bg") + "&depth=0"))).body;
    assert.equal(n.node.fill, "#FF0000", "the layer's fill as drawn");
    const target = fillTarget(["Screen", "Inst", "Inst/Bg"], (id: string) => (id === "Inst/Bg" ? "rectangle" : "frame"), null);
    assert.equal(target, "Inst/Bg");
    const r = await call("POST", "/api/update", { file: pkg, id: target, props: { fill: withFill(n.node.fill, shaderFill("dot-grid")) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = JSON.parse(fs.readFileSync(doc, "utf8"));
    assert.equal(findIn(d.children, "Bg").fill, "#FF0000", "the component is left alone");
    assert.deepEqual(findIn(d.children, "Inst").descendants.Bg.fill, ["#FF0000", { type: "shader", shader: "dot-grid", preset: "Default" }]);
    const scene = (await call("GET", "/api/scene" + q(pkg, "&id=Screen"))).body;
    assert.match(findIn([scene.root], "Inst/Bg").fill[1].source, /fn shade/);
  });
});

// A real PNG of w x h (one red row repeated), so sizes and decoding are honest.
function png(w: number, h: number): Buffer {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4, Buffer.from([255, 0, 0, 255]))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

describe("images from Finder or the pasteboard", () => {
  test("sizes from every format's header", () => {
    assert.deepEqual(imageSize(png(7, 5), "png"), { width: 7, height: 5 });
    const gif = Buffer.from("GIF89a\x0a\x00\x14\x00", "latin1");
    assert.equal(sniffImage(gif), "gif");
    assert.deepEqual(imageSize(gif, "gif"), { width: 10, height: 20 });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 3, 0, 0, 0]);
    assert.equal(sniffImage(jpg), "jpg");
    assert.deepEqual(imageSize(jpg, "jpg"), { width: 40, height: 30 });
    const webp = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8X", "latin1"), Buffer.alloc(8), Buffer.from([99, 0, 0, 49, 0, 0])]);
    assert.equal(sniffImage(webp), "webp");
    assert.deepEqual(imageSize(webp, "webp"), { width: 100, height: 50 });
    const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"><rect/></svg>');
    assert.equal(sniffImage(svg), "svg");
    assert.deepEqual(imageSize(svg, "svg"), { width: 24, height: 12 });
    assert.equal(sniffImage(Buffer.from("hello")), null);
    assert.equal(safeStem("Screenshot 2026-11-16 at 21.04.png"), "screenshot-2026-11-16-at-21-04");
  });
  test("copied into the package's media folder once per content; not-images refused", async () => {
    const { pkg } = await freshPackage("img");
    const bytes = png(30, 20);
    const a = await call("POST", "/api/images" + q(pkg, "&name=" + encodeURIComponent("My Shot.png")), undefined, bytes);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.match(a.body.url, /^media\/my-shot-[0-9a-f]{10}\.png$/);
    assert.deepEqual([a.body.width, a.body.height], [30, 20]);
    assert.deepEqual(fs.readFileSync(path.join(pkg, a.body.url)), bytes);
    const b = await call("POST", "/api/images" + q(pkg, "&name=My%20Shot.png"), undefined, bytes);
    assert.equal(b.body.url, a.body.url);
    assert.equal(fs.readdirSync(path.join(pkg, "media")).length, 1);
    const bad = await call("POST", "/api/images" + q(pkg, "&name=notes.png"), undefined, Buffer.from("not an image"));
    assert.equal(bad.status, 415);
    const forbidden = await fetch(base + "/api/images" + q(pkg), { method: "POST", body: new Uint8Array(bytes) });
    assert.equal(forbidden.status, 403);
  });
  test("a plain drop adds an image layer into the frame (one undo step); a Cmd-drop makes it the fill", async () => {
    const { pkg, doc } = await freshPackage("imgdrop");
    const before = fs.readFileSync(doc, "utf8");
    const up = (await call("POST", "/api/images" + q(pkg, "&name=a.png"), undefined, png(40, 30))).body;
    const add = await call("POST", "/api/structure", { file: pkg, op: "add", nodes: [{ type: "rectangle", name: "a", x: 10, y: 10, width: 40, height: 30, fill: imageFill(up.url) }], place: { parent: "Card" } });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    const id = add.body.select[0];
    const scene = (await call("GET", "/api/scene" + q(pkg, "&id=Screen"))).body;
    const layer = findIn([scene.root], id);
    assert.match(layer.fill.url, /^\/asset\?p=.*media.*a-[0-9a-f]{10}\.png$/);
    assert.ok(scene.images.includes(layer.fill.url));
    const asset = await fetch(base + layer.fill.url);
    assert.equal(asset.status, 200);
    clock += 5000;
    await call("POST", "/api/history/undo" + q(pkg));
    assert.equal(fs.readFileSync(doc, "utf8"), before);
    clock += 5000;
    const fill = await call("POST", "/api/update", { file: pkg, id: "Card", props: { fill: withFill("#EEEEEE", imageFill(up.url)) } });
    assert.equal(fill.status, 200);
    assert.deepEqual(findIn(JSON.parse(fs.readFileSync(doc, "utf8")).children, "Card").fill, ["#EEEEEE", { type: "image", url: up.url, mode: "fill" }]);
  });
});
