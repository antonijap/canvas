// Fills (docs/interaction-conventions.md, Fills and Images): Selection colors (src/selection-colors.ts, /api/selection-colors,
// one undo step), image fill adjustments (src/page/image-adjust.js), image modes, rotation and blend modes in the
// HTML renderer, the schema for them, the paint keys (Option+/, Shift+/, Shift+X in src/page/shortcuts-logic.js) and
// the canvas crop's math (src/page/image-crop-logic.js).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { normColor, replaceEach, selectionColors } from "../src/selection-colors.ts";
import { validateNode } from "../src/doc/schema.ts";
import type { DocNode } from "../src/engine.ts";
// @ts-ignore: plain ES modules the page imports too
import * as A from "../src/page/image-adjust.js";
// @ts-ignore
import * as S from "../src/page/shortcuts-logic.js";
// @ts-ignore
import * as C from "../src/page/image-crop-logic.js";

const dir = tmpDir("fills");
process.env.CANVAS_ROOTS = dir;
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B", x: 0, y: 0, width: 400, height: 300, layout: "none", fill: "#FFFFFF", children: [
      { type: "rectangle", id: "R1", x: 0, y: 0, width: 50, height: 50, fill: "#ff0000", stroke: "#000000", strokeWidth: 1 },
      { type: "rectangle", id: "R2", x: 60, y: 0, width: 50, height: 50, fill: ["#FF0000", { type: "gradient", colors: [{ color: "#FF0000", position: 0 }, { color: "#0000FF", position: 1 }] }] },
      { type: "ellipse", id: "E", x: 120, y: 0, width: 50, height: 50, fill: "#00FF00", effect: { type: "shadow", color: "#FF0000", offset: { x: 0, y: 2 }, blur: 4 } },
      { type: "text", id: "T", x: 0, y: 100, content: "Hi", fill: "$brand" },
    ] },
  ],
};
const p = path.join(dir, "fills.canvas.json");
fs.writeFileSync(p, JSON.stringify(DOC, null, 2));
const file = fs.realpathSync(p);
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  fs.unwatchFile(file);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 9_000_000;
history.setClock(() => clock);
async function call(method: string, q: string, body?: unknown) {
  const r = await fetch(base + q, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const node = (id: string): any => {
  const seek = (l: any[]): any => { for (const n of l) { if (n.id === id) return n; const h = n.children && seek(n.children); if (h) return h; } };
  return seek(read().children);
};
beforeEach(async () => {
  fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
  await call("POST", "/api/update", { file, id: "B", props: {} });
  history.resetHistory();
  clock += 5000;
});

describe("Selection colors", () => {
  test("each colour once, variables first, then the most used; descendants and strokes, stops and shadows count", () => {
    const list = selectionColors([DOC.children[0] as unknown as DocNode]);
    assert.deepEqual(list.map((c) => c.color), ["$brand", "#FF0000", "#FFFFFF", "#000000", "#0000FF", "#00FF00"]);
    assert.equal(list.find((c) => c.color === "#FF0000")!.count, 4, "R1 fill, R2 fill, R2 stop, E shadow");
    assert.equal(normColor("#abc"), "#AABBCC");
    assert.equal(normColor("#AABBCCFF"), "#AABBCC");
    assert.equal(normColor("red"), null);
  });

  test("an edit names every layer that uses the colour, in its own form", () => {
    const each = replaceEach([DOC.children[0] as unknown as DocNode], "#FF0000", "#123456");
    assert.deepEqual(Object.keys(each).sort(), ["E", "R1", "R2"]);
    assert.deepEqual(each.R1, { fill: "#123456" });
    assert.deepEqual((each.R2.fill as any[])[1].colors[0].color, "#123456");
    assert.equal((each.E.effect as any).color, "#123456");
  });

  test("GET lists them; POST changes the colour everywhere in one undo step", async () => {
    const g = await call("GET", `/api/selection-colors?file=${encodeURIComponent(file)}&ids=R1,R2,E`);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.colors[0], { color: "#FF0000", count: 4 });
    const r = await call("POST", "/api/selection-colors", { file, ids: ["R1", "R2", "E"], from: "#FF0000", to: "#00AAFF" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ids.sort(), ["E", "R1", "R2"]);
    assert.equal(node("R1").fill, "#00AAFF");
    assert.equal(node("R2").fill[0], "#00AAFF");
    assert.equal(node("R2").fill[1].colors[0].color, "#00AAFF");
    assert.equal(node("E").effect.color, "#00AAFF");
    const h = await call("GET", `/api/history?file=${encodeURIComponent(file)}`);
    assert.equal(h.body.undoDepth, 1, "one undo step");
    await call("POST", `/api/history/undo?file=${encodeURIComponent(file)}`);
    assert.equal(node("R1").fill, "#ff0000", "undo puts every use back");
    assert.equal(node("E").effect.color, "#FF0000");
  });

  test("a picker drag (one gesture) is one undo step", async () => {
    for (const [from, to] of [["#FF0000", "#EE0000"], ["#EE0000", "#DD0000"], ["#DD0000", "#CC0000"]]) {
      await call("POST", "/api/selection-colors", { file, ids: ["B"], from, to, gesture: "g1" });
      clock += 100;
    }
    assert.equal(node("R1").fill, "#CC0000");
    assert.equal((await call("GET", `/api/history?file=${encodeURIComponent(file)}`)).body.undoDepth, 1);
  });
});

describe("image fill adjustments", () => {
  test("nothing to do at zero; the URL fragment rounds and round-trips", () => {
    assert.equal(A.adjustValues({ exposure: 0 }), null);
    assert.equal(A.adjustFragment({}), "");
    assert.equal(A.adjustFragment({ exposure: 0.5, tint: -0.123 }), "#adjust=50,0,0,0,-12");
    assert.deepEqual(A.adjustFromUrl("/asset?p=a.png#adjust=50,0,0,0,-12"), [0.5, 0, 0, 0, -0.12]);
  });
  test("the matrix: exposure doubles, saturation -1 is grey, contrast spreads from mid grey, temperature warms", () => {
    const px = (v: number[], m: number[][]) => Array.from(A.adjustPixels(new Uint8ClampedArray([...v, 255]), m)).slice(0, 3);
    assert.deepEqual(px([50, 100, 25], A.adjustMatrix([1, 0, 0, 0, 0])), [100, 200, 50]);
    const g = px([255, 0, 0], A.adjustMatrix([0, 0, -1, 0, 0]));
    assert.ok(g[0] === g[1] && g[1] === g[2], `grey: ${g}`);
    assert.deepEqual(px([128, 64, 192], A.adjustMatrix([0, 1, 0, 0, 0])), [128, 0, 255]);
    const w = px([128, 128, 128], A.adjustMatrix([0, 0, 0, 1, 0]));
    assert.ok(w[0] > 128 && w[2] < 128, `warmer: ${w}`);
    assert.match(A.svgMatrixValues(A.adjustMatrix([0, 0, 0, 0, 0])), /^1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0$/);
  });
});

describe("schema and HTML for fills", () => {
  test("image modes, crop, scale, rotation, adjust and blend modes validate", () => {
    const ok = validateNode({ type: "rectangle", id: "r", blendMode: "multiply", cornerSmoothing: 0.6, fill: [{ type: "image", url: "a.png", mode: "crop", crop: { x: -0.5, y: 0, width: 2, height: 1 }, rotation: 90, adjust: { exposure: 0.3 }, blendMode: "screen" }, { type: "image", url: "b.png", mode: "tile", scale: 0.5 }] } as any);
    assert.deepEqual(ok, []);
    const bad = validateNode({ type: "rectangle", id: "r", blendMode: "glow", fill: [{ type: "image", url: "a.png", mode: "zoom", crop: { x: 0 }, rotation: 45, adjust: { vibe: 2 } }, { type: "gradient", gradientType: "diamond" }] } as any);
    assert.equal(bad.length, 6, bad.join("\n"));
    assert.equal(validateNode({ type: "ellipse", id: "e", cornerSmoothing: 0.5 } as any).length, 1, "only frames and rectangles have corner smoothing");
  });

  test("the HTML renderer draws crop, tile, rotation, adjustments and blend modes", async () => {
    const { nodeHtml } = await import("../src/doc/render/html.ts");
    const o = { doc: { children: [], variables: {}, themes: {} } as any, baseDir: dir, theme: {}, warnings: [] as string[] };
    const html = (n: any) => nodeHtml(n, { layout: "none" }, o as any, new Set(), {});
    const crop = html({ type: "rectangle", id: "c", width: 100, height: 100, fill: { type: "image", url: "a.png", mode: "crop", crop: { x: -0.5, y: 0, width: 2, height: 1 } } });
    assert.match(crop, /left:-50%;top:0%;width:200%;height:100%/);
    const tile = html({ type: "rectangle", id: "t", width: 100, height: 100, fill: { type: "image", url: "a.png", mode: "tile", scale: 0.5 } });
    assert.match(tile, /width:200%;height:200%;transform:scale\(0.5\)/);
    assert.match(tile, /repeat/);
    const turned = html({ type: "rectangle", id: "r", width: 100, height: 50, fill: { type: "image", url: "a.png", rotation: 90, adjust: { saturation: -1 }, blendMode: "multiply" } });
    assert.match(turned, /rotate\(90deg\)/);
    assert.match(turned, /width:100cqh;height:100cqw/);
    assert.match(turned, /feColorMatrix/);
    assert.match(turned, /mix-blend-mode:multiply/);
    const paints = html({ type: "rectangle", id: "p", width: 10, height: 10, blendMode: "screen", fill: ["#FF0000", { type: "color", color: "#00FF00", blendMode: "overlay" }] });
    assert.match(paints, /background-blend-mode:overlay,normal/);
    assert.match(paints, /mix-blend-mode:screen/);
  });
});

describe("paint keys", () => {
  test("Option+/ and Shift+/ remove fills or strokes; an instance writes an empty list", () => {
    assert.deepEqual(S.removePaintWrite({ type: "rectangle", fill: "#F00" }, "fill"), { props: {}, remove: ["fill"] });
    assert.deepEqual(S.removePaintWrite({ type: "rectangle", stroke: "#000", strokeWidth: 2 }, "stroke"), { props: {}, remove: ["stroke", "strokeWidth"] });
    assert.equal(S.removePaintWrite({ type: "rectangle" }, "fill"), null);
    assert.deepEqual(S.removePaintWrite({ type: "ref", ref: "C" }, "fill"), { props: { fill: [] }, remove: [] });
    assert.equal(S.removePaintWrite({ type: "group" }, "fill"), null);
  });
  test("Shift+X swaps fill and stroke; a new stroke gets 1 px", () => {
    assert.deepEqual(S.swapPaintWrite({ type: "rectangle", fill: "#F00" }), { props: { stroke: "#F00", strokeWidth: 1 }, remove: ["fill"] });
    assert.deepEqual(S.swapPaintWrite({ type: "rectangle", fill: "#F00", stroke: "#000", strokeWidth: 3 }), { props: { fill: "#000", stroke: "#F00" }, remove: [] });
    assert.deepEqual(S.swapPaintWrite({ type: "rectangle", stroke: "#000", strokeWidth: 3 }), { props: { fill: "#000" }, remove: ["stroke"] });
    assert.equal(S.swapPaintWrite({ type: "rectangle" }), null);
  });
});

describe("use as mask", () => {
  test("Control+Cmd+M: every selected layer becomes a mask, or stops when all are; boards never", () => {
    assert.deepEqual(S.maskWrites([{ id: "a", type: "ellipse" }, { id: "b", type: "rectangle", mask: true }]), [{ id: "a", props: { mask: true }, remove: [] }, { id: "b", props: { mask: true }, remove: [] }]);
    assert.deepEqual(S.maskWrites([{ id: "b", type: "rectangle", mask: true }]), [{ id: "b", props: {}, remove: ["mask"] }]);
    assert.equal(S.maskWrites([{ id: "B", type: "frame" }], (id: string) => id === "B"), null);
  });
  test("the HTML renderer leaves the mask out and clips the layers above it to its shape", async () => {
    const { nodeHtml } = await import("../src/doc/render/html.ts");
    const o = { doc: { children: [], variables: {}, themes: {} } as any, baseDir: dir, theme: {}, warnings: [] as string[] };
    const html = nodeHtml({ type: "frame", id: "f", width: 200, height: 200, layout: "none", children: [
      { type: "rectangle", id: "under", x: 0, y: 0, width: 200, height: 200, fill: "#00FF00" },
      { type: "ellipse", id: "m", x: 50, y: 50, width: 100, height: 60, fill: "#000000", mask: true },
      { type: "rectangle", id: "over", x: 0, y: 0, width: 200, height: 200, fill: "#FF0000" },
    ] } as any, { layout: "none" }, o as any, new Set(), {});
    assert.ok(!html.includes('data-id="m"'), "the mask is not drawn");
    assert.match(html, /clip-path:ellipse\(50px 30px at 100px 80px\)"><div[^>]*><div data-id="over"/);
    assert.ok(html.indexOf('data-id="under"') < html.indexOf("data-mask"), "the layer under the mask is outside the clip");
  });
});

describe("crop on the canvas (math)", () => {
  test("Crop starts where Fill showed the image; a pan and a corner drag keep the aspect", () => {
    const f = { type: "image", url: "a", mode: "fill" };
    const c = C.cropOf(f, 100, 100, 200, 100);
    assert.deepEqual(c, { x: -0.5, y: 0, width: 2, height: 1 });
    assert.deepEqual(C.cropOf({ ...f, mode: "fit" }, 100, 100, 200, 100), { x: 0, y: 0.25, width: 1, height: 0.5 });
    assert.deepEqual(C.cropOf({ ...f, rotation: 90 }, 100, 100, 200, 100), { x: 0, y: -0.5, width: 1, height: 2 }, "turned: tall");
    assert.deepEqual(C.panned(c, 10, -5, 100, 100), { x: -0.4, y: -0.05, width: 2, height: 1 });
    // The bottom right corner pulled out 20 px across: 220 x 110, the top left stays.
    const s = C.scaled(c, 2, 20, 0, 100, 100);
    assert.deepEqual([s.x, s.y, s.width, +s.height.toFixed(6)], [-0.5, 0, 2.2, 1.1]);
    // The top left corner pulled in: the bottom right stays.
    const t = C.scaled(c, 0, 20, 10, 100, 100);
    assert.ok(Math.abs(t.x + t.width - 1.5) < 1e-9 && Math.abs(t.y + t.height - 1) < 1e-9 && Math.abs(t.width / t.height - 2) < 1e-9);
    assert.deepEqual(C.withCrop([{ type: "image", url: "a" }, "#FFF"], 0, { x: -0.123456, y: 0, width: 2, height: 1 })[0].crop, { x: -0.1235, y: 0, width: 2, height: 1 });
    assert.equal(C.topImage(["#FFF", { type: "image", url: "a", enabled: false }]), null);
    assert.equal(C.cornerAt({ x: 0, y: 0, w: 100, h: 50 }, 98, 52), 2);
  });
});
