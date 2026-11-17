// Export (src/export.ts, src/doc/render/svg.ts): size math for scales and store presets, file names, the PNG
// codec that flattens and pads Chrome's screenshots, the SVG helpers, and POST /api/export's checks.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { decodePng, encodePng, EXPORT_PRESETS, exportFileName, exportPaths, exportPlan, finishPng, place, safeName, uniqueNames, validateExport } from "../src/export.ts";
import { cornerRadii, gradientLine, gradientStops, parseColor, roundedPath, roundedShape, splitTop } from "../src/doc/render/svg.ts";
import { tmpDir } from "./helpers.ts";

describe("size math", () => {
  test("a scale rounds each side; 2x of 393 x 852 is 786 x 1704", () => {
    const p = exportPlan({ width: 393, height: 852 }, { scale: 2 });
    assert.deepEqual([p.width, p.height, p.scale, p.opaque, p.dx, p.dy], [786, 1704, 2, false, 0, 0]);
    assert.deepEqual([exportPlan({ width: 10.4, height: 10.6 }, { scale: 3 }).width, exportPlan({ width: 10.4, height: 10.6 }, { scale: 3 }).height], [31, 32]);
    assert.equal(exportPlan({ width: 100, height: 100 }, {}).width, 100, "1x by default");
  });

  test("presets are their exact size and opaque; a board of the preset's shape fills it", () => {
    for (const [id, p] of Object.entries(EXPORT_PRESETS)) {
      const plan = exportPlan({ width: p.width / 3, height: p.height / 3 }, { preset: id as any });
      assert.deepEqual([plan.width, plan.height, plan.opaque], [p.width, p.height, true], id);
      assert.deepEqual([plan.drawn.width, plan.drawn.height, plan.dx, plan.dy], [p.width, p.height, 0, 0], id);
    }
    // iPhone 15 Pro (393 x 852) into 6.9" (1290 x 2796): within 0.5% of the shape, so it fills, a sliver cropped.
    const near = exportPlan({ width: 393, height: 852 }, { preset: "app-store-6.9" });
    assert.ok(near.drawn.width >= 1290 && near.drawn.height >= 2796, JSON.stringify(near));
    assert.ok(near.dx <= 0 && near.dy <= 0);
  });

  test("another shape is fitted inside the preset and centred on white", () => {
    const sq = exportPlan({ width: 500, height: 500 }, { preset: "play" });
    assert.deepEqual([sq.width, sq.height, sq.drawn.width, sq.drawn.height, sq.dx, sq.dy], [1080, 1920, 1080, 1080, 0, 420]);
    const wide = exportPlan({ width: 1000, height: 200 }, { preset: "app-store-6.5" });
    assert.equal(wide.drawn.width, 1242);
    assert.equal(wide.dy, Math.floor((2688 - wide.drawn.height) / 2));
  });
});

describe("file names", () => {
  test("named after the layer, with the scale or the preset size", () => {
    assert.equal(exportFileName("Home", "png", { scale: 1 }), "Home.png");
    assert.equal(exportFileName("Home", "png", { scale: 2 }), "Home@2x.png");
    assert.equal(exportFileName("Home", "png", { preset: "app-store-6.9" }), "Home 1290x2796.png");
    assert.equal(exportFileName("Home", "svg", { scale: 3 }), "Home.svg");
    assert.equal(safeName("a/b:c\u0000"), "a-b-c-");
    assert.equal(safeName("  "), "Layer");
    assert.equal(safeName("..hidden"), "hidden");
    assert.deepEqual(uniqueNames(["Card.png", "card.png", "Card.png", "Other.png"]), ["Card.png", "card 2.png", "Card 3.png", "Other.png"]);
  });

  test("a path gets the format's extension; a folder gets one file per layer", () => {
    assert.deepEqual(exportPaths({ file: "x", ids: ["a"], format: "png", path: "/tmp/shot" }, ["A"]), ["/tmp/shot.png"]);
    assert.deepEqual(exportPaths({ file: "x", ids: ["a"], format: "svg", path: "/tmp/shot.SVG" }, ["A"]), ["/tmp/shot.SVG"]);
    assert.deepEqual(exportPaths({ file: "x", ids: ["a", "b"], format: "png", scale: 3, dir: "/tmp/o" }, ["Card", "Card"]), ["/tmp/o/Card@3x.png", "/tmp/o/Card@3x 2.png"]);
  });

  test("requests are checked", () => {
    const ok = { file: "/x.canvas.json", ids: ["a"], format: "png", path: "/tmp/a.png" };
    assert.equal(validateExport(ok).format, "png");
    assert.deepEqual(validateExport({ ...ok, ids: ["a", "widget:w1"] }).ids, ["a"], "cards are left out");
    const bad = (b: Record<string, unknown>, re: RegExp) => assert.throws(() => validateExport({ ...ok, ...b }), re);
    bad({ ids: ["widget:w1"] }, /cards do not/);
    bad({ format: "gif" }, /format/);
    bad({ scale: 9 }, /scale/);
    bad({ preset: "ipad" }, /preset/);
    bad({ preset: "play", format: "svg" }, /PNG sizes/);
    bad({ preset: "play", scale: 2 }, /not both/);
    bad({ path: "rel/a.png" }, /absolute/);
    bad({ path: undefined }, /path .* or dir/);
    bad({ ids: ["a", "b"] }, /folder/);
  });
});

describe("PNG", () => {
  const px = (w: number, h: number, rgba: number[]) => ({ width: w, height: h, channels: 4 as const, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => rgba[i % 4]) });

  test("encode and decode round-trip, RGBA and RGB", () => {
    const a = px(5, 3, [10, 200, 30, 128]);
    const back = decodePng(encodePng(a));
    assert.deepEqual([back.width, back.height, back.channels], [5, 3, 4]);
    assert.deepEqual([...back.data], [...a.data]);
    const noisy = { width: 7, height: 4, channels: 3 as const, data: Uint8Array.from({ length: 84 }, (_, i) => (i * 37) % 256) };
    assert.deepEqual([...decodePng(encodePng(noisy)).data], [...noisy.data]);
  });

  test("placing on white drops the alpha channel and blends over white; padding is white", () => {
    const half = px(2, 2, [0, 0, 0, 128]);
    const out = place(half, 4, 2, 1, 0, true);
    assert.equal(out.channels, 3);
    assert.deepEqual([...out.data.slice(0, 3)], [255, 255, 255], "padding");
    assert.deepEqual([...out.data.slice(3, 6)], [127, 127, 127], "50% black over white");
    const enc = encodePng(out);
    assert.equal(enc[25], 2, "colour type 2: RGB, no alpha");
  });

  test("finishPng makes a screenshot the plan's exact size", () => {
    const plan = exportPlan({ width: 500, height: 500 }, { preset: "play" });
    // Chrome gave a pixel more than the rounded size: it is centred and cropped, the file is still 1080 x 1920.
    const shot = encodePng(px(1081, 1081, [255, 0, 0, 255]));
    const f = decodePng(finishPng(shot, plan));
    assert.deepEqual([f.width, f.height, f.channels], [1080, 1920, 3]);
    const at = (x: number, y: number) => [...f.data.slice((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3)];
    assert.deepEqual(at(0, 0), [255, 255, 255]);
    assert.deepEqual(at(540, 960), [255, 0, 0]);
    const exact = encodePng(px(20, 10, [1, 2, 3, 4]));
    assert.equal(finishPng(exact, exportPlan({ width: 10, height: 5 }, { scale: 2 })), exact, "already right: the bytes as they are");
  });
});

describe("SVG helpers", () => {
  test("colours become hex and opacity", () => {
    assert.deepEqual(parseColor("rgb(255, 0, 16)"), { hex: "#FF0010", a: 1 });
    assert.deepEqual(parseColor("rgba(0, 0, 0, 0.25)"), { hex: "#000000", a: 0.25 });
    assert.deepEqual(parseColor("#0f08"), { hex: "#00FF00", a: 0.533 });
    assert.equal(parseColor("transparent")!.a, 0);
    assert.equal(parseColor("color(display-p3 1 0 0)"), null);
  });

  test("lists split at top-level commas; stops get CSS's positions", () => {
    assert.deepEqual(splitTop("linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6)), url(a,b)"), ["linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))", "url(a,b)"]);
    assert.deepEqual(gradientStops(["red", "green", "blue 80%", "black"]).map((s) => s.at), [0, 0.4, 0.8, 1]);
    assert.deepEqual(gradientStops(["red 50%", "blue 20%"]).map((s) => s.at), [0.5, 0.5], "never goes back");
  });

  test("a CSS gradient angle becomes the SVG gradient line", () => {
    assert.deepEqual(gradientLine(180, 100, 50), { x1: 50, y1: 0, x2: 50, y2: 50 }, "to bottom");
    assert.deepEqual(gradientLine(90, 100, 50), { x1: 0, y1: 25, x2: 100, y2: 25 }, "to right");
    const d = gradientLine(45, 100, 100);
    assert.ok(Math.abs(d.x2 - d.x1 - 100) < 0.01 && Math.abs(d.y1 - d.y2 - 100) < 0.01, "corner to corner");
  });

  test("corner radii: rect when they allow, a path when they differ, overlap scaled like CSS", () => {
    assert.deepEqual(cornerRadii(["50%", "50%", "50%", "50%"], 120, 50), [[60, 25], [60, 25], [60, 25], [60, 25]]);
    assert.deepEqual(roundedShape(0, 0, 10, 10, [[0, 0], [0, 0], [0, 0], [0, 0]]).tag, "rect");
    assert.match(roundedShape(0, 0, 100, 40, [[8, 8], [8, 8], [8, 8], [8, 8]]).attrs, /rx="8"/);
    assert.equal(roundedShape(0, 0, 100, 40, [[24, 24], [24, 24], [0, 0], [0, 0]]).tag, "path");
    // 40 + 40 on a 60 px side: both scale by 0.75.
    assert.match(roundedPath(0, 0, 60, 60, [[40, 40], [40, 40], [0, 0], [0, 0]]), /A30 30/);
  });
});

describe("POST /api/export", () => {
  const dir = tmpDir("export");
  process.env.CANVAS_ROOTS = dir;
  const docFile = path.join(dir, "doc.canvas.json");
  fs.writeFileSync(docFile, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "A", name: "A", x: 0, y: 0, width: 10, height: 10, children: [] }] }));
  let base = "";
  let server: any;
  after(() => {
    fs.unwatchFile(docFile);
    server?.closeAllConnections();
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = async (body: unknown, headers: Record<string, string> = { "x-canvas": "1" }) => {
    if (!server) {
      const { startServer } = await import("../src/server.ts");
      server = await startServer(0);
      base = `http://127.0.0.1:${server.address().port}`;
    }
    const r = await fetch(base + "/api/export", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };

  test("needs x-canvas, a valid request and a folder that exists", async () => {
    assert.equal((await post({ file: docFile, ids: ["A"], path: path.join(dir, "a.png") }, {})).status, 403);
    const bad = await post({ file: docFile, ids: ["A"], format: "gif", path: path.join(dir, "a.gif") });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, "invalid");
    const gone = await post({ file: docFile, ids: ["A"], path: path.join(dir, "nowhere", "a.png") });
    assert.equal(gone.status, 404);
    assert.match(gone.body.error, /No folder/);
  });
});
