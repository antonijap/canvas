// Copy as (src/copy-as.ts, src/codegen.ts) and the export formats and settings (src/export.ts): the picture math,
// the code a layer becomes, and real runs through the server with Chrome (skipped without a Chromium).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { cssFor, hexRgba, swiftUIFor, textOf } from "../src/codegen.ts";
import { composePng, composeSvg, layoutPicture, over, validateCopy } from "../src/copy-as.ts";
import { decodePng, encodePng, exportFileName, exportPaths, runExport, validateExport } from "../src/export.ts";
import { chromePath } from "../src/doc/render/chrome-path.ts";
import { noisePng } from "../qa/lib.ts";
import { tmpDir } from "./helpers.ts";

const noChrome = (() => { try { chromePath(); return false; } catch { return "no Chromium-family browser"; } })();

test("the export runner delivers a multi-megabyte inline PNG", { skip: noChrome }, async () => {
  const dir = tmpDir("inline-export");
  try {
    const file = path.join(dir, "doc.canvas.json");
    fs.writeFileSync(path.join(dir, "noise.png"), noisePng(2000, 2000));
    fs.writeFileSync(file, JSON.stringify({ version: "2.21", children: [
      { type: "frame", id: "board", width: 1000, height: 1000, layout: "none", fill: { type: "image", url: "noise.png", mode: "fill" } },
    ] }));
    const req = validateExport({ file, ids: ["board"], format: "png", scale: 2, inline: true });
    const { files: [result] } = await runExport(0, file, req, 30_000);
    assert.ok(result?.data, "an inline PNG");
    const bytes = Buffer.from(result.data, "base64");
    assert.equal(bytes.length, result.bytes);
    assert.ok(bytes.length > 2 * 1024 * 1024, "the PNG exceeds 2 MiB");
    const png = decodePng(bytes);
    assert.deepEqual([png.width, png.height], [2000, 2000]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("export settings and formats", () => {
  test("a suffix goes on the name as typed and replaces the scale's @2x", () => {
    assert.equal(exportFileName("HomePage", "png", { scale: 1, suffix: "draft" }), "HomePagedraft.png");
    assert.equal(exportFileName("Home", "png", { scale: 2, suffix: "-dark" }), "Home-dark.png");
    assert.equal(exportFileName("Home", "jpg", { scale: 2 }), "Home@2x.jpg");
    assert.equal(exportFileName("Home", "webp", { scale: 1 }), "Home.webp");
    assert.equal(exportFileName("Home", "pdf", { scale: 3 }), "Home.pdf", "vector formats have one size");
    assert.equal(exportFileName("Home", "svg", { suffix: "/x" }), "Home-x.svg", "no slash in a suffix");
  });

  test("items: one setting per file, checked; vector formats drop the scale", () => {
    const r = validateExport({ file: "/x.canvas", dir: "/tmp", items: [{ id: "a", format: "png", scale: 2 }, { id: "a", format: "pdf", scale: 3 }, { id: "b", format: "jpg", suffix: "-s" }, { id: "widget:w" }] });
    assert.deepEqual(r.items, [{ id: "a", format: "png", scale: 2 }, { id: "a", format: "pdf" }, { id: "b", format: "jpg", suffix: "-s" }]);
    assert.deepEqual(exportPaths(r, ["A", "A", "B"]), ["/tmp/A@2x.png", "/tmp/A.pdf", "/tmp/B-s.jpg"]);
    assert.throws(() => validateExport({ file: "/x", dir: "/tmp", items: [{ id: "a", format: "gif" }] }), /format/);
    assert.throws(() => validateExport({ file: "/x", dir: "/tmp", items: [] }), /items/);
    assert.equal(validateExport({ file: "/x", ids: ["a"], inline: true }).inline, true, "inline needs no path");
    assert.deepEqual(exportPaths({ format: "jpg", path: "/tmp/a.jpeg", items: [{ id: "a", format: "jpg" }] }, ["A"]), ["/tmp/a.jpeg"]);
  });
});

describe("one picture of several layers", () => {
  const solid = (w: number, h: number, rgba: number[]) => ({ width: w, height: h, channels: 4 as const, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => rgba[i % 4]) });
  test("drawings land where they sit on the canvas, at the scale", () => {
    const p = layoutPicture([{ x: 10, y: 20, width: 20, height: 20 }, { x: 40, y: 20, width: 10, height: 40 }], 2);
    assert.deepEqual(p, { width: 70, height: 40, at: [{ dx: 0, dy: 0 }, { dx: 60, dy: 0 }] });
  });
  test("source-over blending; gaps stay transparent", () => {
    const a = encodePng(solid(2, 2, [255, 0, 0, 255])).toString("base64");
    const b = encodePng(solid(2, 2, [0, 0, 255, 128])).toString("base64");
    const out = composePng([{ x: 0, y: 0, width: 2, height: 2, data: a }, { x: 1, y: 0, width: 2, height: 2, data: b }, { x: 4, y: 0, width: 2, height: 2, data: a }], 1);
    const px = decodePng(out.png);
    assert.deepEqual([px.width, px.height], [6, 2]);
    const at = (x: number) => [...px.data.slice(x * 4, x * 4 + 4)];
    assert.deepEqual(at(0), [255, 0, 0, 255]);
    assert.deepEqual(at(1), [127, 0, 128, 255], "half blue over red");
    assert.deepEqual(at(2), [0, 0, 255, 128], "half blue over nothing");
    assert.equal(at(3)[3], 0, "the gap is empty");
    const d = solid(1, 1, [0, 0, 0, 0]);
    over(d, solid(1, 1, [10, 20, 30, 0]), 0, 0);
    assert.deepEqual([...d.data], [0, 0, 0, 0], "a transparent pixel changes nothing");
  });
  test("SVGs nest at their offsets inside one root", () => {
    const one = (w: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="10"><rect/></svg>`).toString("base64");
    const s = composeSvg([{ x: 5, y: 5, width: 10, height: 10, data: one(10) }, { x: 25, y: 10, width: 20, height: 10, data: one(20) }]);
    assert.equal(s.width, 40);
    assert.equal(s.height, 15);
    assert.match(s.svg, /^<svg xmlns[^>]* width="40" height="15"/);
    assert.match(s.svg, /<svg x="0" y="0" xmlns/);
    assert.match(s.svg, /<svg x="20" y="5" xmlns/);
  });
  test("requests are checked; 2x by default; cards are left out", () => {
    assert.equal(validateCopy({ file: "/x", ids: ["a"] }).scale, 2);
    assert.equal(validateCopy({ file: "/x", ids: ["a"], format: "css" }).format, "css");
    assert.throws(() => validateCopy({ file: "/x", ids: ["widget:w"] }), /Cards/);
    assert.throws(() => validateCopy({ file: "/x", ids: ["a"], format: "gif" }), /format/);
  });
});

describe("Copy as code", () => {
  const doc = { version: "2.21", variables: { brand: { type: "color", value: "#0766EB" } }, children: [] } as any;
  const base = { doc, theme: {}, warnings: [] as string[] };
  test("CSS: size, position in a plain frame, paint, corners, effects, in the usual order", () => {
    const node = { type: "rectangle", id: "r", name: "Card", width: 120, height: 40, fill: "$brand", stroke: "#000000", strokeWidth: 1, cornerRadius: 8, opacity: 0.5, effect: { type: "shadow", offset: { x: 0, y: 4 }, blur: 12, color: "#0000001A" } };
    const css = cssFor({ ...base, node, parent: { type: "frame", id: "p", layout: "none" }, box: { x: 20, y: 10, width: 120, height: 40 } });
    assert.equal(css, ["/* Card */", "", "position: absolute;", "width: 120px;", "height: 40px;", "left: 20px;", "top: 10px;", "", "background: #0766EB;", "border: 1px solid #000000;", "border-radius: 8px;", "box-shadow: 0px 4px 12px #0000001A;", "opacity: 0.5;"].join("\n"));
  });
  test("CSS: auto layout and a child that fills, type", () => {
    const frame = cssFor({ ...base, node: { type: "frame", id: "f", name: "Row", layout: "horizontal", gap: 8, padding: [8, 16], alignItems: "center", width: "fit_content", height: 40 }, parent: null, box: { x: 0, y: 0, width: 200, height: 40 } });
    assert.match(frame, /\/\* Auto layout \*\/\ndisplay: flex;\nflex-direction: row;\njustify-content: flex-start;\nalign-items: center;\npadding: 8px 16px;\ngap: 8px;/);
    assert.ok(!/position/.test(frame), "a board has no position");
    const text = cssFor({ ...base, node: { type: "text", id: "t", name: "Label", content: "Hi", fontFamily: "Inter", fontSize: 14, fontWeight: "600", lineHeight: 1.2, letterSpacing: -0.2, fill: "#111111", width: "fill_container" }, parent: { type: "frame", id: "f", layout: "horizontal" }, box: { x: 16, y: 8, width: 100, height: 17 } });
    assert.match(text, /flex: 1 1 0;/);
    assert.match(text, /font-family: 'Inter';\nfont-style: normal;\nfont-weight: 600;\nfont-size: 14px;\nline-height: 120%;\nletter-spacing: -0.2px;\ncolor: #111111;/);
    assert.ok(!/left:/.test(text), "a flow child has no left/top");
  });
  test("SwiftUI: a Text with its font and colour, a shape with fill and stroke, a stack for auto layout", () => {
    const t = swiftUIFor({ ...base, node: { type: "text", id: "t", name: "Title", content: "Hello \"you\"", fontFamily: "SF Pro", fontSize: 17, fontWeight: "600", fill: "#FF0000" }, parent: null, box: { x: 0, y: 0, width: 80, height: 22 } });
    assert.match(t, /^\/\/ Title\nText\("Hello \\"you\\""\)\n    \.font\(\.system\(size: 17, weight: \.semibold\)\)\n    \.foregroundStyle\(Color\(red: 1, green: 0, blue: 0\)\)/);
    const r = swiftUIFor({ ...base, node: { type: "rectangle", id: "r", width: 10, height: 10, cornerRadius: 4, fill: "#00000080", stroke: "#FFFFFF", strokeWidth: 2 }, parent: null, box: { x: 0, y: 0, width: 10, height: 10 } });
    assert.match(r, /RoundedRectangle\(cornerRadius: 4\)\n    \.fill\(Color\(red: 0, green: 0, blue: 0\)\.opacity\(0\.5\)\)\n    \.frame\(width: 10, height: 10\)\n    \.overlay\(RoundedRectangle\(cornerRadius: 4\)\.stroke\(Color\(red: 1, green: 1, blue: 1\), lineWidth: 2\)\)/);
    const s = swiftUIFor({ ...base, node: { type: "frame", id: "f", layout: "vertical", gap: 12, padding: 16, alignItems: "center" }, parent: null, box: { x: 0, y: 0, width: 300, height: 200 } });
    assert.match(s, /VStack\(alignment: \.center, spacing: 12\) \{\n    \/\/ children\n\}\n    \.padding\(16\)/);
  });
  test("text: every text layer's text in order; colours parse", () => {
    assert.equal(textOf({ type: "frame", id: "f", children: [{ type: "text", id: "a", content: "One" }, { type: "frame", id: "g", children: [{ type: "text", id: "b", content: "Two" }, { type: "text", id: "c", content: "Gone", enabled: false }] }] } as any), "One\nTwo");
    assert.deepEqual(hexRgba("#F00"), { r: 1, g: 0, b: 0, a: 1 });
    assert.equal(hexRgba("red"), null);
  });
});

describe("POST /api/copy-as and the new export formats, through the server", () => {
  const dir = tmpDir("copyas");
  process.env.CANVAS_ROOTS = dir;
  const docFile = path.join(dir, "doc.canvas.json");
  fs.writeFileSync(docFile, JSON.stringify({ version: "2.21", children: [
    { type: "frame", id: "B", name: "Board", x: 100, y: 50, width: 200, height: 120, fill: "#FFFFFF", layout: "none", children: [
      { type: "rectangle", id: "R1", name: "Red", x: 10, y: 10, width: 40, height: 30, fill: "#FF0000" },
      { type: "rectangle", id: "R2", name: "Blue", x: 110, y: 60, width: 50, height: 40, fill: "#0000FF", cornerRadius: 6 },
      { type: "text", id: "T", name: "Label", x: 10, y: 80, content: "Hello", fontSize: 14, fill: "#111111" },
    ] },
  ] }));
  let base = "";
  let server: any;
  after(() => {
    fs.unwatchFile(docFile);
    server?.closeAllConnections();
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = async (route: string, body: unknown, headers: Record<string, string> = { "x-canvas": "1" }) => {
    if (!server) {
      const { startServer } = await import("../src/server.ts");
      server = await startServer(0);
      base = `http://127.0.0.1:${server.address().port}`;
    }
    const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };

  test("needs x-canvas and a valid request", async () => {
    assert.equal((await post("/api/copy-as", { file: docFile, ids: ["R1"] }, {})).status, 403);
    assert.equal((await post("/api/copy-as", { file: docFile, ids: ["R1"], format: "gif" })).status, 422);
  });

  test("PNG at 2x: one layer, then two layers as one picture with the gap empty", { skip: noChrome }, async () => {
    const one = await post("/api/copy-as", { file: docFile, ids: ["R1"] });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const p1 = decodePng(Buffer.from(one.body.data, "base64"));
    assert.deepEqual([p1.width, p1.height, one.body.width, one.body.mime], [80, 60, 80, "image/png"]);
    assert.deepEqual([...p1.data.slice(0, 4)], [255, 0, 0, 255]);
    const two = await post("/api/copy-as", { file: docFile, ids: ["R1", "R2"] });
    const p2 = decodePng(Buffer.from(two.body.data, "base64"));
    // R1 at (10,10) 40x30, R2 at (110,60) 50x40: the union is 150x90, 300x180 at 2x.
    assert.deepEqual([p2.width, p2.height], [300, 180]);
    const at = (x: number, y: number) => [...p2.data.slice((y * p2.width + x) * 4, (y * p2.width + x) * 4 + 4)];
    assert.deepEqual(at(10, 10), [255, 0, 0, 255], "red top-left");
    assert.deepEqual(at(250, 150), [0, 0, 255, 255], "blue bottom-right");
    assert.equal(at(150, 20)[3], 0, "the white board between them is not in the picture");
  });

  test("SVG, CSS, SwiftUI and text", { skip: noChrome }, async () => {
    const svg = await post("/api/copy-as", { file: docFile, ids: ["R2"], format: "svg" });
    assert.match(svg.body.text, /^<svg[^>]*width="50"/);
    const css = await post("/api/copy-as", { file: docFile, ids: ["R2", "T"], format: "css" });
    assert.match(css.body.text, /^\/\* Blue \*\/\n\nposition: absolute;\nwidth: 50px;\nheight: 40px;\nleft: 110px;\ntop: 60px;/);
    assert.match(css.body.text, /\n\n\/\* Label \*\/\n/);
    const sw = await post("/api/copy-as", { file: docFile, ids: ["T"], format: "swiftui" });
    assert.match(sw.body.text, /^\/\/ Label\nText\("Hello"\)/);
    const text = await post("/api/copy-as", { file: docFile, ids: ["B"], format: "text" });
    assert.equal(text.body.text, "Hello");
  });

  test("export: JPG over white, WebP, PDF, and a suffix", { skip: noChrome }, async () => {
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    const r = await post("/api/export", { file: docFile, dir: out, items: [{ id: "R2", format: "jpg", scale: 2 }, { id: "R2", format: "webp" }, { id: "B", format: "pdf" }, { id: "R1", format: "png", suffix: "-mark" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.files.map((f: any) => path.basename(f.path)), ["Blue@2x.jpg", "Blue.webp", "Board.pdf", "Red-mark.png"]);
    const jpg = fs.readFileSync(path.join(out, "Blue@2x.jpg"));
    assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], "a JPEG");
    assert.deepEqual([r.body.files[0].width, r.body.files[0].height], [100, 80]);
    assert.equal(fs.readFileSync(path.join(out, "Blue.webp")).toString("latin1", 8, 12), "WEBP");
    const pdf = fs.readFileSync(path.join(out, "Board.pdf"));
    assert.equal(pdf.toString("latin1", 0, 5), "%PDF-");
    assert.match(pdf.toString("latin1"), /MediaBox \[0 0 150 90\]/, "one page the board's size (200x120 px is 150x90 pt)");
  });
});
