// Moving, resizing and rotating (QA moving and selection): where a dropped layer belongs, Shift's axis
// lock, a group's resize, rotation about the centre, the resize handles' hit zones and flips, distance pills that
// keep clear of the size badge, Shift+H that keeps the layer in place, the selection an undo brings back, and the
// batch resize write.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as M from "../src/page/move-logic.js";
// @ts-ignore: a plain ES module the page imports too
import * as L from "../src/page/live-edit.js";
// @ts-ignore: a plain ES module the page imports too
import * as S from "../src/page/snap.js";
// @ts-ignore: a plain ES module the page imports too
import * as K from "../src/page/shortcuts-logic.js";
import { stepSelection } from "../src/history.ts";
import { tmpDir } from "./helpers.ts";

describe("drop target (P1-2)", () => {
  test("homeFrame skips groups and instances", () => {
    assert.equal(M.homeFrame([]), null);
    assert.equal(M.homeFrame([{ id: "B", type: "frame" }, { id: "G", type: "group" }]), "B");
    assert.equal(M.homeFrame([{ id: "B", type: "frame" }, { id: "F", type: "frame" }]), "F");
    assert.equal(M.homeFrame([{ id: "G", type: "group" }]), null);
    assert.equal(M.homeFrame([{ id: "B", type: "frame" }, { id: "I", type: "frame", component: "C" }]), "B");
  });
  test("dropParent: a new frame or the canvas adopts; the same home keeps it", () => {
    assert.deepEqual(M.dropParent("BA", { id: "BB" }, "BA"), { parent: "BB" });
    assert.deepEqual(M.dropParent("BA", null, "BA"), { parent: null });
    assert.equal(M.dropParent("BA", { id: "BA" }, "G1"), null); // in a group inside BA, dropped inside BA
    assert.equal(M.dropParent(null, null, "G"), null); // in a top-level group, dropped on canvas
    assert.deepEqual(M.dropParent(null, { id: "BB" }, null), { parent: "BB" }); // a board dropped in a frame nests
    assert.equal(M.dropParent(null, null, null), null); // a board dropped on the canvas stays a board
    assert.deepEqual(M.dropParent("F1", { id: "F2" }, "F1"), { parent: "F2" });
  });
  test("axisLock keeps the dominant axis", () => {
    assert.deepEqual(M.axisLock(136, 27), { dx: 136, dy: 0 });
    assert.deepEqual(M.axisLock(-5, 40), { dx: 0, dy: 40 });
  });
});

describe("group and multi-selection resize (P2-4)", () => {
  const items = [
    { id: "a", wr: { x: 150, y: 20, w: 50, h: 50 }, own: { x: 0, y: 0 }, type: "rectangle" },
    { id: "b", wr: { x: 220, y: 20, w: 50, h: 50 }, own: { x: 70, y: 0 }, type: "text" },
  ];
  const r0 = { x: 150, y: 20, w: 120, h: 50 };
  test("each layer scales with the box, each axis on its own", () => {
    const out = M.groupResizeItems(items, r0, { x: 150, y: 20, w: 240, h: 100 });
    assert.deepEqual(out[0].props, { x: 0, y: 0, width: 100, height: 100 });
    assert.deepEqual(out[1].props, { x: 140, y: 0, width: 100, height: 100, textGrowth: "fixed-width-height" });
  });
  test("a crossed box mirrors the layers and flips them; a flipped layer's x is its right edge", () => {
    const out = M.groupResizeItems(items, r0, { x: 30, y: 20, w: 120, h: 50, flipX: true });
    // b (rightmost) lands leftmost at world 30..80: stored x = 70 + (30 - 220) + 50 = -70
    assert.deepEqual(out[1].props, { x: -70, y: 0, width: 50, height: 50, textGrowth: "fixed-width-height", flipX: true });
    assert.equal(out[0].props.flipX, true);
  });
});

describe("rotation (P3-9)", () => {
  test("the zone is just outside a corner, never inside or on a handle", () => {
    const s = { x: 100, y: 100, w: 50, h: 50 };
    assert.equal(M.rotateZoneAt(s, 92, 92, false), "nw");
    assert.equal(M.rotateZoneAt(s, 160, 160, false), "se");
    assert.equal(M.rotateZoneAt(s, 120, 120, false), null);
    assert.equal(M.rotateZoneAt(s, 98, 98, true), null);
    assert.equal(M.rotateZoneAt(s, 125, 80, false), null);
  });
  test("the centre stays put", () => {
    const own = { x: 100, y: 100 }, w = 100, h = 60;
    const c0 = M.centreOffset(w, h, 0);
    const p = M.rotatedPosition(own, w, h, 0, 90);
    const c1 = M.centreOffset(w, h, 90);
    assert.ok(Math.abs(own.x + c0.x - (p.x + c1.x)) < 0.01 && Math.abs(own.y + c0.y - (p.y + c1.y)) < 0.01);
    assert.deepEqual(M.rotatedPosition(own, w, h, 30, 30), own);
  });
  test("a moved rotation origin: the layer goes round it; at its centre nothing changes", () => {
    const own = { x: 100, y: 100 }, w = 100, h = 60, centre = { x: 150, y: 130 };
    assert.deepEqual(M.turnAbout({ x: 1, y: 0 }, { x: 0, y: 0 }, 90), { x: 6.123233995736766e-17, y: -1 });
    assert.deepEqual(M.pivotedPosition(own, w, h, 0, 90, centre, centre), M.rotatedPosition(own, w, h, 0, 90));
    // About its left middle by 90 degrees: the centre goes from (150, 130) to (100, 80).
    const p = M.pivotedPosition(own, w, h, 0, 90, centre, { x: 100, y: 130 });
    const q = M.rotatedPosition(own, w, h, 0, 90);
    assert.deepEqual(p, { x: q.x - 50, y: q.y - 50 });
  });
  test("dragRotation: clockwise on screen is negative, Shift snaps 15, wraps", () => {
    assert.equal(M.dragRotation(0, 0, Math.PI / 2, false), -90);
    assert.equal(M.dragRotation(0, 0, -0.3, true), 15);
    assert.equal(M.dragRotation(170, 0, -Math.PI / 9, false), -170);
  });
});

describe("handles (P2-5, P3-8, P3-2)", () => {
  test("no handles on a box under 10 px on screen", () => {
    assert.equal(L.handleAt({ x: 100, y: 100, w: 1.6, h: 1.2 }, 101, 101), null);
    assert.notEqual(L.handleAt({ x: 100, y: 100, w: 200, h: 2 }, 300, 101), null); // a thin line keeps its end handles
  });
  test("the corner zone is the handle square, not 8 px into the box", () => {
    const s = { x: 0, y: 0, w: 200, h: 100 };
    assert.equal(L.handleAt(s, 7, 7), null);
    assert.equal(L.handleAt(s, 3, 3), "nw");
    assert.equal(L.handleAt(s, -4, -4), "nw");
  });
  test("an edge dragged past the opposite one flips and keeps resizing", () => {
    const r = L.resizeRect({ x: 20, y: 20, w: 80, h: 60 }, "e", -120, 0);
    assert.deepEqual(r, { x: -20, y: 20, w: 40, h: 60, flipX: true });
    assert.deepEqual(L.resizeRect({ x: 20, y: 20, w: 80, h: 60 }, "n", 0, 100), { x: 20, y: 80, w: 80, h: 40, flipY: true });
    assert.deepEqual(L.resizeRect({ x: 20, y: 20, w: 80, h: 60 }, "e", 10, 0), { x: 20, y: 20, w: 90, h: 60 });
  });
  test("flipWrites: a flipped layer's stored x is its right edge", () => {
    const w = { props: { width: 40 }, children: [] };
    L.flipWrites(w, { x: 20, y: 20, w: 80, h: 60 }, { x: -20, y: 20, w: 40, h: 60, flipX: true }, { positioned: true, own: { x: 20, y: 20 } });
    assert.deepEqual(w.props, { width: 40, flipX: true }); // its right edge (20) stays the stored x
    const w2 = { props: { width: 100 }, children: [] };
    L.flipWrites(w2, { x: 20, y: 20, w: 80, h: 60 }, { x: 20, y: 20, w: 100, h: 60 }, { flipX: true, positioned: true, own: { x: 100, y: 20 } });
    assert.deepEqual(w2.props, { width: 100, x: 120 });
  });
});

describe("pills, flip key, undo selection", () => {
  test("a distance pill moves off the size badge", () => {
    const first = S.pillSpot("y", 100, 100, 20, 16, 1, null);
    assert.deepEqual(first, { x: 90, y: 104 });
    const moved = S.pillSpot("y", 100, 100, 20, 16, 1, [{ x: 80, y: 100, w: 50, h: 20 }]);
    assert.deepEqual(moved, { x: 90, y: 80 });
  });
  test("Shift+H keeps the layer where it shows", () => {
    const rect = () => ({ x: 20, y: 20, w: 80, h: 60 });
    assert.deepEqual(K.flipItems([{ id: "R", x: 20, y: 20 }], "flipX", rect), [{ id: "R", props: { flipX: true, x: 100 } }]);
    assert.deepEqual(K.flipItems([{ id: "R", x: 100, y: 20, flipX: true }], "flipX", rect), [{ id: "R", props: { flipX: false, x: 20 } }]);
  });
  test("stepSelection: what the step leaves, outermost only", () => {
    const doc = { children: [{ id: "B", type: "frame", children: [{ id: "G", type: "group", children: [{ id: "a", type: "rectangle" }] }] }] } as any;
    const ins = { t: "tree", kind: "insert", parent: "B", index: 0, node: { id: "G" } } as any;
    assert.deepEqual(stepSelection([ins, { t: "move", id: "a", b: {}, a: {} } as any], "redo", doc), ["G"]);
    assert.deepEqual(stepSelection([{ t: "tree", kind: "remove", parent: "B", index: 0, node: { id: "a" } } as any], "undo", doc), ["a"]);
    assert.deepEqual(stepSelection([{ t: "tree", kind: "remove", parent: "B", index: 0, node: { id: "x" } } as any], "redo", doc), []);
  });
});

describe("POST /api/resize items (one undo step)", async () => {
  const dir = tmpDir("resize-items");
  process.env.CANVAS_ROOTS = dir;
  const docFile = path.join(dir, "t.canvas.json");
  fs.writeFileSync(docFile, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "B", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [
    { type: "rectangle", id: "a", x: 0, y: 0, width: 50, height: 50 }, { type: "rectangle", id: "b", x: 70, y: 0, width: 50, height: 50 }] }] }));
  const { startServer } = await import("../src/server.ts");
  const server = await startServer(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(b) });
  test("writes every item, undoes in one step, refuses non-geometry", async () => {
    const r = await post("/api/resize", { file: docFile, items: [{ id: "a", props: { width: 100, height: 100 } }, { id: "b", props: { x: 140, width: 100, height: 100, flipX: true } }] });
    assert.equal(r.status, 200);
    const node = async (id: string) => (await (await fetch(`${base}/api/node?file=${encodeURIComponent(docFile)}&id=${id}`)).json()).node;
    assert.equal((await node("a")).width, 100);
    assert.equal((await node("b")).x, 140);
    assert.equal((await node("b")).flipX, true);
    const u = await post(`/api/history/undo?file=${encodeURIComponent(docFile)}`, {});
    const j = await u.json();
    assert.deepEqual(j.select.sort(), ["a", "b"]);
    assert.equal((await node("a")).width, 50);
    assert.equal((await node("b")).x, 70);
    assert.equal((await post("/api/resize", { file: docFile, items: [{ id: "a", props: { fill: "#000" } }] })).status, 400);
  });
});
