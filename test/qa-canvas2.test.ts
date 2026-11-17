// QA canvas round 2 (.planning/research/qa-canvas-round2.md): a group's bounds follow its layers after a resize,
// a flip, a move or a layer taken out (an empty group goes); undo and redo of a group resize select the group; undo
// of a paste or an Option-drag copy selects what was selected; redo of deleting a main component selects nothing;
// a layer dropped on empty canvas goes on top; a note's growth is one undo step with its text; rotated resize math;
// paste in place with a frame selected elsewhere.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { refitGroups, groupsAround, localBox } from "../src/groupfit.ts";
// @ts-ignore: a plain ES module the page imports too
import * as M from "../src/page/move-logic.js";
// @ts-ignore: a plain ES module the page imports too
import { pastePlace } from "../src/page/structure.js";

const rect = (id: string, x: number, y: number, extra = {}) => ({ type: "rectangle", id, x, y, width: 60, height: 40, fill: "#0000FF", ...extra });
const group = () => ({ type: "group", id: "G1", name: "Group 1", x: 200, y: 200, children: [rect("G1a", 0, 0), rect("G1b", 80, 0)] });
const DOC = {
  version: "2.22",
  children: [
    { type: "frame", id: "BA", name: "Board A", x: 0, y: 0, width: 800, height: 600, layout: "none", children: [
      group(),
      { type: "frame", id: "F1", name: "Frame 1", x: 400, y: 200, width: 300, height: 300, layout: "none", children: [] },
      rect("R1", 20, 20),
      { type: "group", id: "G2", x: 10, y: 400, children: [rect("G2a", 0, 0)] },
      { type: "group", id: "G3", x: 300, y: 400, children: [rect("G3a", 0, 0), rect("G3b", 100, 0)] },
    ] },
    { type: "frame", id: "Main", name: "Main", reusable: true, x: 1000, y: 0, width: 100, height: 100, layout: "none", children: [] },
    { type: "ref", id: "Inst", ref: "Main", x: 1200, y: 0 },
  ],
};

describe("pure", () => {
  test("refit moves a group to its layers' corner and the layers back", () => {
    const doc = { children: [structuredClone(group())] } as any;
    doc.children[0].children[0].x = -20; doc.children[0].children[0].y = -10;
    const set: Record<string, any> = {};
    refitGroups(doc, ["G1"], (id, p) => { set[id] = { ...(set[id] || {}), ...p }; Object.assign(id === "G1" ? doc.children[0] : doc.children[0].children.find((c: any) => c.id === id), p); });
    assert.deepEqual(set.G1, { x: 180, y: 190 });
    assert.deepEqual(set.G1a, { x: 0, y: 0 });
    assert.deepEqual(set.G1b, { x: 100, y: 10 });
  });
  test("a flipped layer's box starts at its stored x minus its width", () => {
    assert.deepEqual(localBox({ id: "a", type: "rectangle", x: 0, y: 0, width: 60, height: 40, flipX: true } as any), { x0: -60, y0: 0, x1: 0, y1: 40 });
  });
  test("groupsAround gives the run of group ancestors, deepest first", () => {
    const doc = { children: [{ type: "frame", id: "B", children: [{ type: "group", id: "Go", children: [{ type: "group", id: "Gi", children: [{ type: "rectangle", id: "r" }] }] }] }] } as any;
    assert.deepEqual(groupsAround(doc, ["r"]), ["Gi", "Go"]);
    assert.deepEqual(groupsAround(doc, ["B"]), []);
  });
  test("rotated resize keeps the sides it was not dragged by", () => {
    // 90 degrees: a 60x40 layer at 0,0 turned about its corner. Drag its own right edge (local e) out by 20.
    const r = 90, w0 = 60, h0 = 40;
    const rect1 = { x: -w0 / 2, y: -h0 / 2, w: w0 + 20, h: h0 };
    const p = M.rotatedResize({ x: 0, y: 0 }, w0, h0, r, rect1);
    assert.equal(p.width, 80);
    assert.equal(p.height, 40);
    // The left edge (the stored corner's side) stays: with no flip, the corner is where it was.
    assert.equal(Math.abs(p.x) < 1e-6 ? 0 : p.x, 0);
    assert.equal(Math.abs(p.y) < 1e-6 ? 0 : p.y, 0);
    // Unrotated, a left-edge drag moves x by the drag.
    const q = M.rotatedResize({ x: 10, y: 10 }, 60, 40, 0, { x: -40, y: -20, w: 70, h: 40 });
    assert.deepEqual(q, { x: 0, y: 10, width: 70, height: 40 });
  });
  test("rotated cursors follow the turn", () => {
    assert.equal(M.rotatedCursor("e", 0), "ew-resize");
    assert.equal(M.rotatedCursor("e", 90), "ns-resize");
    assert.equal(M.rotatedCursor("e", 45), "nesw-resize");
    assert.equal(M.rotatedCursor("se", 0), "nwse-resize");
  });
  test("paste in place with a frame selected elsewhere keeps the canvas position, in the old parent", () => {
    const payload = { nodes: [{ id: "R1" }], rects: [{ x: 20, y: 20, w: 60, h: 40 }], parents: ["BA"] };
    const target = { id: "BC", isContainer: true, rect: { x: 0, y: 800, w: 800, h: 600 } };
    const out = pastePlace({ target, payload, inPlace: true, exists: (id: string) => id === "BA" || id === "R1", rectOf: (id: string) => (id === "BA" ? { x: 0, y: 0, w: 800, h: 600 } : null) });
    assert.deepEqual(out, { parent: "BA", index: undefined, positions: [{ x: 20, y: 20 }] });
    const gone = pastePlace({ target, payload, inPlace: true, exists: () => false });
    assert.deepEqual(gone, { parent: null, index: undefined, positions: [{ x: 20, y: 20 }] });
  });
});

const dir = tmpDir("qa-canvas2");
process.env.CANVAS_ROOTS = dir;
const p = path.join(dir, "q.canvas.json");
fs.writeFileSync(p, JSON.stringify(DOC, null, 2));
const file = fs.realpathSync(p);
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  fs.unwatchFile(file);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const call = async (route: string, body?: unknown, method = "POST") => {
  const r = await fetch(base + route, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify({ file, ...(body as object) }) });
  return { status: r.status, body: (await r.json()) as any };
};
const q = `?file=${encodeURIComponent(file)}`;
const doc = async () => { await call("/api/flush", {}); return JSON.parse(fs.readFileSync(file, "utf8")); };
const find = (d: any, id: string) => {
  const s = (l: any[]): any => { for (const n of l) { if (n.id === id) return n; const h = n.children && s(n.children); if (h) return h; } };
  return s(d.children);
};
const undo = () => call("/api/history/undo" + q, undefined);
const redo = () => call("/api/history/redo" + q, undefined);

describe("server", () => {
  test("a group resized from its centre refits; undo and redo select the group", async () => {
    const r = await call("/api/resize", { items: [{ id: "G1a", props: { x: -20, y: -10, width: 80, height: 60 } }, { id: "G1b", props: { x: 100, y: -10, width: 80, height: 60 } }], select: ["G1"] });
    assert.equal(r.status, 200);
    let d = await doc();
    assert.deepEqual([find(d, "G1").x, find(d, "G1").y], [180, 190]);
    assert.deepEqual([find(d, "G1a").x, find(d, "G1a").y], [0, 0]);
    assert.deepEqual([find(d, "G1b").x, find(d, "G1b").y], [120, 0]);
    const u = await undo();
    assert.deepEqual(u.body.select, ["G1"]);
    d = await doc();
    assert.deepEqual([find(d, "G1").x, find(d, "G1a").x, find(d, "G1b").x], [200, 0, 80]);
    const re = await redo();
    assert.deepEqual(re.body.select, ["G1"]);
    await undo();
  });
  test("a group child flipped past the group's left edge refits", async () => {
    await call("/api/resize", { items: [{ id: "G1a", props: { x: 0, width: 60, flipX: true } }, { id: "G1b", props: { x: -20, width: 60, flipX: true } }], select: ["G1"] });
    const d = await doc();
    assert.equal(find(d, "G1").x, 120); // the layers now span 120..200 on the board
    assert.equal(find(d, "G1b").x, 60); // its right edge, 60 into the group
    assert.equal(find(d, "G1a").x, 80);
    await undo();
  });
  test("a layer moved left of its group's origin refits the group", async () => {
    const r = await call("/api/move", { id: "G1a", x: -30, y: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.body.x, 0);
    const d = await doc();
    assert.equal(find(d, "G1").x, 170);
    assert.equal(find(d, "G1b").x, 110);
    await undo();
    const d2 = await doc();
    assert.deepEqual([find(d2, "G1").x, find(d2, "G1a").x, find(d2, "G1b").x], [200, 0, 80]);
  });
  test("a layer taken out of a group into a frame refits the group; the last one out removes it", async () => {
    let r = await call("/api/layout", { op: "place", ids: ["G1a"], parent: "F1", before: null, absolute: [{ x: 10, y: 10 }] });
    assert.equal(r.status, 200);
    let d = await doc();
    assert.equal(find(d, "G1").x, 280);
    assert.equal(find(d, "G1b").x, 0);
    r = await call("/api/layout", { op: "place", ids: ["G2a"], parent: "F1", before: null, absolute: [{ x: 100, y: 10 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    d = await doc();
    assert.equal(find(d, "G2"), undefined);
    await undo();
    d = await doc();
    assert.ok(find(d, "G2"));
    assert.equal(find(d, "G2a").x, 0);
    await undo();
    d = await doc();
    assert.equal(find(d, "G1").x, 200);
    assert.equal(find(d, "G1a").x, 0);
  });
  test("deleting a group's first layer refits it, the last one removes it", async () => {
    await call("/api/structure", { op: "delete", ids: ["G3a"] });
    let d = await doc();
    assert.equal(find(d, "G3").x, 400);
    assert.equal(find(d, "G3b").x, 0);
    const r = await call("/api/structure", { op: "delete", ids: ["G3b"] });
    assert.deepEqual(r.body.select, []);
    d = await doc();
    assert.equal(find(d, "G3"), undefined);
    await undo();
    await undo();
    d = await doc();
    assert.deepEqual([find(d, "G3").x, find(d, "G3a").x, find(d, "G3b").x], [300, 0, 100]);
  });
  test("a layer dropped on empty canvas goes on top of everything", async () => {
    const r = await call("/api/layout", { op: "place", ids: ["R1"], parent: null, before: null, absolute: [{ x: 900, y: 20 }] });
    assert.equal(r.status, 200);
    const d = await doc();
    assert.equal(d.children.at(-1).id, "R1");
    await undo();
  });
  test("undo of a paste selects what was selected; undo of an Option-drag copy selects the original", async () => {
    await call("/api/structure", { op: "copy", ids: ["R1"] });
    const pz = await call("/api/structure", { op: "paste", fromServer: true, place: { parent: "F1", positions: [null] }, selBefore: ["F1"] });
    assert.equal(pz.status, 200);
    const u = await undo();
    assert.deepEqual(u.body.select, ["F1"]);
    const cp = await call("/api/layout", { op: "place", copy: true, ids: ["R1"], parent: "F1", before: null, absolute: [{ x: 5, y: 5 }] });
    assert.equal(cp.status, 200);
    const u2 = await undo();
    assert.deepEqual(u2.body.select, ["R1"]);
  });
  test("redo of deleting a main component selects nothing", async () => {
    const del = await call("/api/structure", { op: "delete", ids: ["Main"] });
    assert.equal(del.status, 200);
    await undo();
    const re = await redo();
    assert.deepEqual(re.body.select, []);
    await undo();
  });
  test("a note's text and the growth it brings are one undo step", async () => {
    const add = await call("/api/widgets" + q, { kind: "note", x: 0, y: 900, w: 220, h: 220, config: { text: "a" } });
    assert.equal(add.status, 201);
    const id = add.body.widget.id;
    await call(`/api/widgets/${id}${q}`, { config: { text: "a b" } }, "PATCH");
    await call(`/api/widgets/${id}${q}`, { config: { text: "a b\n\n\nc" }, h: 300 }, "PATCH");
    const u = await undo();
    assert.equal(u.body.label, "Widget Change");
    const w = (await call(`/api/widgets/${id}${q}`, undefined, "GET")).body;
    assert.equal((w.widget ?? w).h, 220);
    assert.equal((w.widget ?? w).config.text, "a");
  });
});
