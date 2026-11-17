// .canvas packages: path resolution, the file scan, save-as and new, widgets and edits inside a package.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { FIXTURE_DOC, tmpDir, writeDoc } from "./helpers.ts";

const dir = tmpDir("canvasdoc");
process.env.CANVAS_ROOTS = dir;
const { resolveDoc, newCanvas, saveAsCanvas, DocError } = await import("../src/docpath.ts");
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const pkg = path.join(dir, "Mine.canvas");
fs.mkdirSync(pkg);
fs.writeFileSync(path.join(pkg, "document.json"), JSON.stringify(FIXTURE_DOC, null, 2));
const pkgReal = fs.realpathSync(pkg);
const docFile = writeDoc(dir, "plain");
fs.writeFileSync(path.join(dir, "obsidian.canvas"), JSON.stringify({ nodes: [], edges: [] }));

after(() => {
  for (const f of [path.join(pkgReal, "document.json"), docFile]) fs.unwatchFile(f);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (p: string, body: unknown, headers: Record<string, string> = { "x-canvas": "1" }) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (p: string) => fetch(`${base}${p}`).then((r) => r.json() as Promise<any>);

describe("a package on disk", () => {
  const made = (name: string) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "document.json"), JSON.stringify(FIXTURE_DOC, null, 2));
    return d;
  };

  test("the server reads and saves a package, and the save lands in document.json", async () => {
    const d = made("Saved.canvas");
    const real = fs.realpathSync(d);
    const s = await get(`/api/summary?file=${encodeURIComponent(d)}`);
    assert.equal(s.file, real, "the summary names the package, not the inner file");
    assert.ok(s.boards.length > 0);
    const id = "Scr01";
    const res = await post("/api/update", { file: d, id, props: { opacity: 0.25 } });
    assert.equal(res.status, 200, await res.clone().text());
    await fetch(`${base}/api/flush`, { method: "POST", headers: { "x-canvas": "1" } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(JSON.parse(fs.readFileSync(path.join(real, "document.json"), "utf8")).children[0].opacity, 0.25);
    fs.unwatchFile(path.join(real, "document.json"));
  });
});

describe("resolveDoc", () => {
  test("a .canvas.json is its own design, with a sidecar", () => {
    const d = resolveDoc(docFile);
    assert.deepEqual(d, { docFilePath: docFile, widgetsPath: docFile.replace(/\.canvas\.json$/, "") + ".widgets.json", displayPath: docFile, kind: "file" });
  });

  test("a .canvas package resolves to its inner document.json and widgets.json", () => {
    const d = resolveDoc(pkg);
    assert.equal(d.kind, "canvas");
    assert.equal(d.docFilePath, path.join(pkgReal, "document.json"));
    assert.equal(d.widgetsPath, path.join(pkgReal, "widgets.json"));
    assert.equal(d.displayPath, pkgReal);
    assert.deepEqual(resolveDoc(path.join(pkg, "document.json")), d, "the inner design is the same document");
    assert.deepEqual(resolveDoc("file://" + encodeURI(pkg)), d);
  });

  test("a plain .canvas file (Obsidian) and other extensions are refused", () => {
    assert.throws(() => resolveDoc(path.join(dir, "obsidian.canvas")), /plain file, not a Canvas document/);
    assert.throws(() => resolveDoc(path.join(dir, "x.txt")), /not a Canvas file/);
  });
});

describe("scan", () => {
  test("lists a package once, as the package, and skips the Obsidian file", async () => {
    let files: { file: string; name: string }[] = [];
    for (let i = 0; i < 40 && !files.some((f) => f.file === pkgReal); i++) {
      files = await get("/api/files");
      if (!files.some((f) => f.file === pkgReal)) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(!files.some((f) => f.file === docFile), "a single .canvas.json is not listed");
    assert.equal(files.filter((f) => f.file === pkgReal).length, 1);
    assert.equal(files.find((f) => f.file === pkgReal)?.name, "Mine");
    assert.ok(!files.some((f) => f.file.endsWith("document.json")));
    assert.ok(!files.some((f) => f.file.endsWith("obsidian.canvas")));
  });
});

describe("documents served from a package", () => {
  test("/api/doc and /api/update work with the package path", async () => {
    const q = `?file=${encodeURIComponent(pkg)}`;
    const d = await get(`/api/doc${q}`);
    assert.equal(d.name, "Mine");
    assert.deepEqual(d.boards.map((b: any) => b.id), ["Scr01", "Scr02"]);
    const r = await post("/api/update", { file: pkg, id: "Scr01", props: { opacity: 0.5 } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(pkgReal, "document.json"), "utf8")).children[0].opacity, 0.5);
    assert.equal((await fetch(`${base}/api/doc?file=${encodeURIComponent(path.join(dir, "obsidian.canvas"))}`)).status, 404);
  });

  test("widgets read and write widgets.json, not a sidecar", async () => {
    const r = await post(`/api/widgets?file=${encodeURIComponent(pkg)}`, { kind: "note", name: "N" });
    assert.equal(r.status, 201);
    const stored = JSON.parse(fs.readFileSync(path.join(pkgReal, "widgets.json"), "utf8"));
    assert.equal(stored.widgets.length, 1);
    assert.equal(stored.widgets[0].name, "N");
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".widgets.json")), []);
    const list = await get(`/api/widgets?file=${encodeURIComponent(pkg)}`);
    assert.equal(list.widgets.length, 1);
  });
});

describe("save-as and new", () => {
  test("save-as copies the design and the sidecar widgets into a package", async () => {
    fs.writeFileSync(docFile.replace(/\.canvas\.json$/, "") + ".widgets.json", JSON.stringify({ version: 1, widgets: [{ id: "w_1", kind: "note", name: "Keep", x: 0, y: 0, w: 200, h: 100, locked: false, config: {} }] }));
    const target = path.join(dir, "Copy.canvas");
    const r = await post("/api/canvas/save-as", { file: docFile, target });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).file, fs.realpathSync(target));
    assert.equal(fs.readFileSync(path.join(target, "document.json"), "utf8"), fs.readFileSync(docFile, "utf8"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "widgets.json"), "utf8")).widgets[0].name, "Keep");
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
  });

  test("save-as refuses an existing target, a non-.canvas target and strangers", async () => {
    const existing = await post("/api/canvas/save-as", { file: docFile, target: pkg });
    assert.equal(existing.status, 409);
    assert.equal((await post("/api/canvas/save-as", { file: docFile, target: path.join(dir, "x.canvas.json") })).status, 400);
    assert.equal((await post("/api/canvas/save-as", { file: docFile, target: path.join(dir, "y.canvas") }, {})).status, 403);
    assert.equal(fs.existsSync(path.join(dir, "y.canvas")), false);
  });

  test("new makes an empty document that opens", async () => {
    const target = path.join(dir, "Fresh.canvas");
    const r = await post("/api/canvas/new", { target });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, "document.json"), "utf8")), { version: "2.21", children: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, "widgets.json"), "utf8")), { version: 1, widgets: [] });
    assert.equal((await post("/api/canvas/new", { target })).status, 409);
    const d = await get(`/api/doc?file=${encodeURIComponent(target)}`);
    assert.equal(d.name, "Fresh");
    fs.unwatchFile(path.join(fs.realpathSync(target), "document.json"));
  });

  test("save-as copies relatively referenced images into the package and reports missing ones", async () => {
    const src = path.join(dir, "imgsrc");
    fs.mkdirSync(path.join(src, "assets", "deep"), { recursive: true });
    fs.writeFileSync(path.join(src, "assets", "a.png"), "<svg>AAA</svg>");
    fs.writeFileSync(path.join(src, "assets", "deep", "b.png"), "<svg>BBB</svg>");
    const img = (url: string) => ({ type: "image", url });
    const doc = { version: "2.21", children: [
      { type: "frame", id: "Scr01", x: 0, y: 0, width: 100, height: 100, fill: img("assets/a.png"), children: [] },
      { type: "frame", id: "Scr02", x: 200, y: 0, width: 100, height: 100, fill: img("./assets/deep/b.png"), children: [] },
      { type: "frame", id: "Scr03", x: 400, y: 0, width: 100, height: 100, fill: img("https://example.com/r.png"), children: [] },
      { type: "frame", id: "Scr04", x: 600, y: 0, width: 100, height: 100, fill: img("assets/missing.png"), children: [] },
      { type: "frame", id: "Scr05", x: 800, y: 0, width: 100, height: 100, fill: img("../outside.png"), children: [] },
    ] };
    fs.writeFileSync(path.join(dir, "outside.png"), "<svg>OUT</svg>");
    fs.writeFileSync(path.join(src, "d.canvas.json"), JSON.stringify(doc));
    fs.writeFileSync(path.join(src, "d.widgets.json"), JSON.stringify({ version: 1, widgets: [], pages: [{ id: "p1", name: "One", boards: ["Scr01"] }] }));
    const target = path.join(dir, "WithImages.canvas");
    const r = await post("/api/canvas/save-as", { file: path.join(src, "d.canvas.json"), target });
    assert.equal(r.status, 200);
    const j = (await r.json()) as any;
    assert.equal(fs.readFileSync(path.join(target, "assets", "a.png"), "utf8"), "<svg>AAA</svg>");
    assert.equal(fs.readFileSync(path.join(target, "assets", "deep", "b.png"), "utf8"), "<svg>BBB</svg>");
    assert.equal(fs.existsSync(path.join(target, "assets", "missing.png")), false);
    assert.deepEqual(j.warnings.length, 1);
    assert.ok(j.warnings[0].includes("missing.png"));
    // A file outside the design's folder is copied into linked/ and its reference rewritten in the package copy only.
    const packed = JSON.parse(fs.readFileSync(path.join(target, "document.json"), "utf8"));
    const outRef: string = packed.children[4].fill.url;
    assert.match(outRef, /^linked\/[0-9a-f]{8}-outside\.png$/);
    assert.equal(fs.readFileSync(path.join(target, outRef), "utf8"), "<svg>OUT</svg>");
    assert.equal(packed.children[0].fill.url, "assets/a.png", "in-folder refs keep their path");
    assert.equal(JSON.parse(fs.readFileSync(path.join(src, "d.canvas.json"), "utf8")).children[4].fill.url, "../outside.png", "the source is untouched");
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "widgets.json"), "utf8")).pages[0].name, "One", "pages carry over");
    const scene = await get(`/api/scene?file=${encodeURIComponent(target)}&id=Scr01`);
    const urls: string[] = JSON.parse(JSON.stringify(scene)).images ?? [];
    const asset = decodeURIComponent((urls[0] ?? "").replace("/asset?p=", ""));
    assert.ok(asset.startsWith(fs.realpathSync(target)), `scene image resolves inside the package: ${asset}`);
    assert.equal((await fetch(`${base}${urls[0]}`)).status, 200);
    fs.unwatchFile(path.join(fs.realpathSync(target), "document.json"));
  });

  test("hunt-1 #4: save-as rewrites only image and font references, never text or ids holding the same string", () => {
    const src = path.join(dir, "rwsrc");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(dir, "logo.png"), "<svg>LOGO</svg>");
    const doc = { version: "2.21", children: [
      { type: "frame", id: "../logo.png", x: 0, y: 0, width: 10, height: 10, fill: { type: "image", url: "../logo.png" }, children: [
        { type: "text", id: "T1", content: "../logo.png", fontFamily: "Inter", fontSize: 12 },
      ] },
    ] };
    fs.writeFileSync(path.join(src, "r.canvas.json"), JSON.stringify(doc, null, 2) + "\n");
    const target = saveAsCanvas(path.join(src, "r.canvas.json"), path.join(dir, "Rewrite.canvas"));
    const packed = JSON.parse(fs.readFileSync(path.join(target, "document.json"), "utf8"));
    assert.match(packed.children[0].fill.url, /^linked\/[0-9a-f]{8}-logo\.png$/);
    assert.equal(packed.children[0].id, "../logo.png");
    assert.equal(packed.children[0].children[0].content, "../logo.png");
  });

  test("helpers throw DocError with a status", () => {
    assert.throws(() => newCanvas("nope.txt"), (e: any) => e instanceof DocError && e.status === 400);
    assert.throws(() => saveAsCanvas(path.join(dir, "missing.canvas.json"), path.join(dir, "Z.canvas")), (e: any) => e.status === 404);
  });
});
