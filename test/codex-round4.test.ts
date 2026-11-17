// Codex review round 4 (.planning/research/codex-round4.md): a multi-selection drop into several parents is one
// write and one undo step; stretching a group with a layer turned at an angle that is not a quarter turn keeps the
// requested bounds; a turned group holding auto-sized text or hug frames rotates again.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
// @ts-ignore: a plain ES module the page imports too
import * as ML from "../src/page/move-logic.js";

const rect = (id: string, x: number, y: number, w = 40, h = 40) => ({ type: "rectangle", id, x, y, width: w, height: h, fill: "#FF0000" });

/** The world bounding box of a w x h layer at stored x/y turned r degrees (a .canvas.json rotation turns about x/y). */
function bbox(x: number, y: number, w: number, h: number, r: number) {
  const t = (-r * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [u, v] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const px = x + c * u - s * v, py = y + s * u + c * v;
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const near = (a: number, b: number, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

describe("1. a multi-selection dropped on several parents is one undo step", () => {
  const dir = tmpDir("codex-round4");
  process.env.CANVAS_ROOTS = dir;
  const p = path.join(dir, "drop.canvas.json");
  const DOC = { version: "2.22", children: [
    { type: "frame", id: "B1", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [rect("R1", 10, 10), rect("R2", 100, 10)] },
    { type: "frame", id: "B2", x: 1000, y: 0, width: 400, height: 400, layout: "none", children: [] },
  ] };
  fs.writeFileSync(p, JSON.stringify(DOC, null, 2));
  const file = fs.realpathSync(p);
  let server: any;
  after(() => { fs.unwatchFile(file); server?.closeAllConnections(); server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  test("R1 into B2 and R2 onto the canvas: both land, one Cmd+Z puts both back", async () => {
    const { startServer } = await import("../src/server.ts");
    server = await startServer(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route: string, body?: unknown) => {
      const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-canvas": "1" }, body: JSON.stringify({ file, ...(body as object ?? {}) }) });
      return { status: r.status, body: (await r.json()) as any };
    };
    const body = ML.placeBody(file, undefined, [
      { parent: "B2", ids: ["R1"], absolute: [{ x: 50, y: 60 }] },
      { parent: null, ids: ["R2"], absolute: [{ x: 600, y: 500 }] },
    ], { rects: { R1: { x: 1050, y: 60, w: 40, h: 40 }, R2: { x: 600, y: 500, w: 40, h: 40 }, B1: { x: 0, y: 0, w: 400, h: 400 }, B2: { x: 1000, y: 0, w: 400, h: 400 } } });
    const r = await call("/api/layout", body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([...r.body.select].sort(), ["R1", "R2"]);
    await call("/api/flush");
    let d = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(d.children.map((n: any) => n.id), ["B1", "B2", "R2"]);
    assert.deepEqual(d.children[1].children.map((n: any) => [n.id, n.x, n.y]), [["R1", 50, 60]]);
    const h = await fetch(`${base}/api/history?file=${encodeURIComponent(file)}`).then((x) => x.json()) as any;
    assert.equal(h.undoDepth, 1);
    const u = await fetch(`${base}/api/history/undo?file=${encodeURIComponent(file)}`, { method: "POST", headers: { "x-canvas": "1" } });
    assert.equal(u.status, 200);
    await call("/api/flush");
    d = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(d.children.map((n: any) => n.id), ["B1", "B2"]);
    assert.deepEqual(d.children[0].children.map((n: any) => [n.id, n.x, n.y]), [["R1", 10, 10], ["R2", 100, 10]]);
  });
  test("a drop that reparents some layers and moves others: the reparenting first, then the move, folds into one step", async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route: string, body?: unknown) => (await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-canvas": "1" }, body: JSON.stringify({ file, ...(body as object ?? {}) }) })).json() as any;
    fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
    await call("/api/update", { id: "B1", props: {} });
    const history = await import("../src/history.ts");
    history.resetHistory();
    const merge = "group:round4-mixed";
    assert.equal((await call("/api/layout", ML.placeBody(file, undefined, [{ parent: "B2", ids: ["R1"], absolute: [{ x: 5, y: 5 }] }], { merge }))).ok, true);
    assert.equal((await call("/api/move", { items: [{ id: "R2", dx: 5, dy: 0 }], merge })).ok, true);
    const h = await fetch(`${base}/api/history?file=${encodeURIComponent(file)}`).then((x) => x.json()) as any;
    assert.equal(h.undoDepth, 1);
  });
  test("the page sends one request for every destination", () => {
    const b = ML.placeBody("f.canvas.json", "p1", [{ parent: "F", ids: ["a"], absolute: [{ x: 1, y: 2 }] }, { parent: null, ids: ["b", "c"], absolute: [{ x: 3, y: 4 }, { x: 5, y: 6 }] }], { copy: true });
    assert.deepEqual(b, { file: "f.canvas.json", page: "p1", op: "place", ids: ["a", "b", "c"], parent: "F", before: null, absolute: [{ x: 1, y: 2 }], rects: {},
      parts: [{ parent: "F", ids: ["a"], before: null, absolute: [{ x: 1, y: 2 }] }, { parent: null, ids: ["b", "c"], before: null, absolute: [{ x: 3, y: 4 }, { x: 5, y: 6 }] }], copy: true });
  });
});

describe("2. stretching a group with a layer turned at an angle keeps the requested bounds", () => {
  // A 100x100 rectangle turned 45 degrees: its box is 141.42 square.
  const own = { x: 0, y: 70.71 };
  const wr = bbox(own.x, own.y, 100, 100, 45);
  const items = [{ id: "R", wr, own, type: "rectangle", rot: 45, w0: 100, h0: 100 }];
  test("a turned layer at 45 degrees makes the resize uniform; quarter turns and plain layers do not", () => {
    assert.equal(ML.needsUniformScale(items), true);
    assert.equal(ML.needsUniformScale([{ ...items[0], rot: 90 }, { id: "S", rot: 0 }]), false);
    assert.equal(ML.needsUniformScale([{ id: "S" }]), false);
    assert.equal(ML.needsUniformScale([{ ...items[0], rot: -270 }]), false);
    assert.equal(ML.needsUniformScale([{ ...items[0], rot: 30 }]), true);
  });
  test("a uniform stretch draws the layer exactly in the requested box", () => {
    const r = { x: wr.x, y: wr.y, w: wr.w * 2, h: wr.h * 2 };
    const p = ML.groupResizeItems(items, wr, r)[0].props;
    near(p.width, 200); near(p.height, 200);
    const b = bbox(p.x, p.y, p.width, p.height, 45);
    near(b.x, r.x); near(b.y, r.y); near(b.w, r.w); near(b.h, r.h);
  });
  test("30 degrees, uniform: the drawn box is the requested one", () => {
    const o = { x: 10, y: 60 }, w0 = 120, h0 = 40, b0 = bbox(o.x, o.y, w0, h0, 30);
    const it = [{ id: "R", wr: b0, own: o, type: "rectangle", rot: 30, w0, h0 }];
    const r = { x: b0.x - 5, y: b0.y, w: b0.w * 1.5, h: b0.h * 1.5 };
    const p = ML.groupResizeItems(it, b0, r)[0].props;
    const b = bbox(p.x, p.y, p.width, p.height, 30);
    near(b.x, r.x); near(b.y, r.y); near(b.w, r.w); near(b.h, r.h);
  });
});

describe("3. a turned group with auto-sized text or a hug frame rotates again", () => {
  // Text 100 wide, Auto height (40 drawn), in a group turned 30 degrees.
  const text = { type: "text", id: "T", x: 0, y: 0, width: 100, textGrowth: "fixed-width", content: "hi" };
  const hug = { type: "frame", id: "H", x: 0, y: 50, layout: "vertical", children: [rect("c", 0, 0, 80, 30)] };
  const group = { type: "group", id: "G", x: 200, y: 200, rotation: 30, children: [text, hug] };
  const root = { type: "frame", id: "B", x: 0, y: 0, width: 800, height: 800, children: [group] };
  // Drawn boxes: T 100x40 at 0,0 and H 80x30 at 0,50 in G's frame, G turned 30 degrees about 200,200.
  const at = (x: number, y: number, w: number, h: number) => {
    const t = (-30 * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    return bbox(200 + c * x - s * y, 200 + s * x + c * y, w, h, 30);
  };
  const rects: Record<string, any> = { T: at(0, 0, 100, 40), H: at(0, 50, 80, 30), G: at(0, 0, 100, 80) };
  test("the old reading gives up (sizes not in the file)", () => {
    assert.equal(ML.groupExtent(group.children), null);
  });
  test("the drawn boxes give the layers' own sizes, so the group's own size is known", () => {
    const e = ML.turnedGroupSize(root, "G", (id: string) => rects[id] ?? null);
    assert.ok(e);
    near(e.w, 100); near(e.h, 80);
  });
  test("measured sizes with a known side: the text's width stays its own", () => {
    near(ML.sizeFromBox(100, undefined, rects.T, 30).h, 40);
    const s = ML.sizeFromBox(undefined, undefined, rects.H, 30);
    near(s.w, 80); near(s.h, 30);
    assert.equal(ML.sizeFromBox(undefined, undefined, bbox(0, 0, 80, 30, 45), 45), null);
  });
  test("at 45 degrees a hug frame's size comes from when it was last measured", () => {
    const g45 = { ...group, id: "G45", rotation: 45, children: [{ ...hug, y: 0 }] };
    const r0 = { B: null, G45: { x: 0, y: 0, w: 80, h: 30 }, H: { x: 0, y: 0, w: 80, h: 30 } } as Record<string, any>;
    // Not yet turned: its size is its box.
    const flat = ML.turnedGroupSize({ ...root, children: [{ ...g45, rotation: 0 }] }, "G45", (id: string) => r0[id] ?? null);
    near(flat.w, 80); near(flat.h, 30);
    const b45 = bbox(0, 0, 80, 30, 45), r45: Record<string, any> = { G45: b45, H: b45 };
    const e = ML.turnedGroupSize({ ...root, children: [g45] }, "G45", (id: string) => r45[id] ?? null);
    assert.ok(e);
    near(e.w, 80); near(e.h, 30);
  });
});
