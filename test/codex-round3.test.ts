// Codex review round 3 (.planning/research/codex-round3.md): group refit with hug sizes, instances and flips;
// rotated text side resize keeps Auto height; rotated auto layout frames stop at their padding; a board dropped
// on an auto layout frame joins its flow.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { refitGroups } from "../src/groupfit.ts";
// @ts-ignore: a plain ES module the page imports too
import * as L from "../src/page/live-edit.js";

const rect = (id: string, x: number, y: number, w = 100, h = 40) => ({ type: "rectangle", id, x, y, width: w, height: h });
const fitOf = (doc: any, ids: string[]) => {
  const set: Record<string, any> = {};
  refitGroups(doc, ids, (id, p) => { set[id] = { ...(set[id] || {}), ...p }; });
  return set;
};

describe("1. group refit resolves automatic sizes", () => {
  test("a flipped hug frame's box reaches back by its content's width", () => {
    // Hug frame at x 100, flipped: it covers 0..100 in the group, so the group already fits.
    const doc = { children: [{ type: "group", id: "G", x: 50, y: 50, children: [
      { type: "frame", id: "H", x: 100, y: 0, flipX: true, children: [rect("c", 0, 0)] },
    ] }] } as any;
    assert.deepEqual(fitOf(doc, ["G"]), {});
  });
  test("nudged by 1, the group moves by 1 and the frame keeps its x", () => {
    const doc = { children: [{ type: "group", id: "G", x: 50, y: 50, children: [
      { type: "frame", id: "H", x: 101, y: 0, flipX: true, layout: "vertical", padding: 0, children: [rect("c", 0, 0)] },
    ] }] } as any;
    assert.deepEqual(fitOf(doc, ["G"]), { H: { x: 100 }, G: { x: 51, y: 50 } });
  });
  test("hug size counts padding and gap", () => {
    const doc = { children: [{ type: "group", id: "G", x: 0, y: 0, children: [
      { type: "frame", id: "H", x: 130, y: 0, flipX: true, width: "fit_content", gap: 10, padding: [0, 5], children: [rect("a", 0, 0, 50), rect("b", 0, 0, 50)] },
    ] }] } as any;
    // 5 + 50 + 10 + 50 + 5 = 120 wide: covers 10..130.
    assert.deepEqual(fitOf(doc, ["G"]), { H: { x: 120 }, G: { x: 10, y: 0 } });
  });
  test("an instance takes its main's size", () => {
    const doc = { children: [
      { type: "frame", id: "M", reusable: true, x: 0, y: 0, width: 80, height: 30, layout: "none", children: [] },
      { type: "group", id: "G", x: 0, y: 0, children: [{ type: "ref", id: "I", ref: "M", x: 90, y: 0, flipX: true }] },
    ] } as any;
    assert.deepEqual(fitOf(doc, ["G"]), { I: { x: 80 }, G: { x: 10, y: 0 } });
  });
  test("a flipped text that sizes itself is left alone (its width is not known)", () => {
    const doc = { children: [{ type: "group", id: "G", x: 0, y: 0, children: [
      { type: "text", id: "T", x: 100, y: 0, flipX: true, content: "hi", textGrowth: "auto" },
    ] }] } as any;
    assert.deepEqual(fitOf(doc, ["G"]), {});
  });
});

describe("2. rotated text side resize keeps Auto height; auto width becomes Fixed size", () => {
  test("a side drag writes no height and keeps fixed-width", () => {
    const props = { width: 60, height: 40, x: 3, y: 4 };
    L.rotatedTextWrites(props, "e", "fixed-width");
    assert.deepEqual(props, { width: 60, x: 3, y: 4 });
  });
  test("a side drag of auto-width text makes it Fixed size at the height it had", () => {
    const props = { width: 60, height: 40, x: 3, y: 4 };
    L.rotatedTextWrites(props, "w", "auto");
    assert.deepEqual(props, { width: 60, height: 40, x: 3, y: 4, textGrowth: "fixed-width-height" });
  });
  test("a top, bottom or corner drag makes it Fixed size", () => {
    for (const h of ["n", "se"]) {
      const props: any = { width: 60, height: 40 };
      L.rotatedTextWrites(props, h, "fixed-width");
      assert.equal(props.textGrowth, "fixed-width-height");
      assert.equal(props.height, 40);
    }
  });
});

describe("3. a rotated auto layout frame stops at its padding", () => {
  test("dragging the right handle in by 95 leaves the padding's 80", () => {
    const r0 = { x: -50, y: -50, w: 100, h: 100 };
    const r = L.rotatedResizeRect(r0, "e", -95, 0, { min: { w: 80, h: 80 } });
    assert.equal(r.w, 80);
    assert.equal(r.x, -50); // the left edge stays
  });
  test("from the left edge, the right edge stays", () => {
    const r = L.rotatedResizeRect({ x: -50, y: -50, w: 100, h: 100 }, "w", 95, 0, { min: { w: 80, h: 80 } });
    assert.deepEqual([r.x, r.w], [-30, 80]);
  });
  test("Option keeps the centre", () => {
    const r = L.rotatedResizeRect({ x: -50, y: -50, w: 100, h: 100 }, "e", -45, 0, { alt: true, min: { w: 80, h: 80 } });
    assert.deepEqual([r.x, r.w], [-40, 80]);
  });
  test("a flip is refused (null)", () => {
    assert.equal(L.rotatedResizeRect({ x: -50, y: -50, w: 100, h: 100 }, "e", -150, 0, {}), null);
  });
});

describe("1. server: nudging a flipped hug frame in a group", () => {
  const dir = tmpDir("codex-round3");
  process.env.CANVAS_ROOTS = dir;
  const p = path.join(dir, "g.canvas.json");
  fs.writeFileSync(p, JSON.stringify({ version: "2.22", children: [
    { type: "frame", id: "B", x: 0, y: 0, width: 800, height: 600, layout: "none", children: [
      { type: "group", id: "G", x: 50, y: 50, children: [
        { type: "frame", id: "H", x: 100, y: 0, flipX: true, layout: "vertical", children: [rect("c", 0, 0)] },
        rect("r", 120, 0, 20, 20),
      ] },
    ] },
  ] }, null, 2));
  const file = fs.realpathSync(p);
  const p2 = path.join(dir, "d.canvas.json");
  fs.writeFileSync(p2, JSON.stringify({ version: "2.22", children: [
    { type: "frame", id: "B", x: 0, y: 0, width: 800, height: 600, layout: "none", children: [
      { type: "group", id: "G1", x: 50, y: 50, children: [rect("G1a", 0, 0), rect("G1b", 120, 0)] },
      { type: "frame", id: "F", x: 400, y: 300, width: 300, height: 200, layout: "none", children: [] },
    ] },
  ] }, null, 2));
  const file2 = fs.realpathSync(p2);
  let server: any;
  after(() => { fs.unwatchFile(file); fs.unwatchFile(file2); server?.closeAllConnections(); server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  test("the frame keeps its place in the group; the group moves with it", async () => {
    const { startServer } = await import("../src/server.ts");
    server = await startServer(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route: string, body: unknown) => (await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-canvas": "1" }, body: JSON.stringify({ file, ...(body as object) }) })).json() as any;
    const r = await call("/api/move", { id: "H", dx: -10, merge: "nudge" });
    assert.equal(r.ok, true);
    await call("/api/flush", {});
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    const g = d.children[0].children[0];
    // H covers -10..90 in G now: G moves left by 10, H back to 100, r to 130.
    assert.deepEqual([g.x, g.children[0].x, g.children[1].x], [40, 100, 130]);
  });
  test("QA3 P3-1: undo of deleting a layer in a group, or taking it out, selects the layer", async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const q = `?file=${encodeURIComponent(file2)}`;
    const call = async (route: string, body?: unknown) => (await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify({ file: file2, ...(body as object) }) })).json() as any;
    let r = await call("/api/structure", { op: "delete", ids: ["G1a"] });
    assert.equal(r.ok, true);
    r = await call("/api/history/undo" + q);
    assert.deepEqual(r.select, ["G1a"]);
    r = await call("/api/layout", { op: "place", ids: ["G1a"], parent: "F", before: null, absolute: [{ x: 10, y: 10 }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    r = await call("/api/history/undo" + q);
    assert.deepEqual(r.select, ["G1a"]);
  });
});

// ---------- QA round 3 (.planning/research/qa-canvas-round3.md) ----------
// @ts-ignore: a plain ES module the page imports too
import * as ML from "../src/page/move-logic.js";

describe("QA3 P1-1. a multi-selection's drop reparents only the layers that leave their frame", () => {
  const boards: Record<string, any> = { A: { x: 0, y: 0, w: 1000, h: 600 }, B: { x: 1100, y: 0, w: 800, h: 600 }, D: { x: 0, y: 700, w: 300, h: 300 } };
  const at = (p: any) => { for (const [id, r] of Object.entries(boards)) if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return { kind: "frame", id, layout: "none" }; return { kind: "canvas" }; };
  test("a short drag of layers in two boards keeps each in its board", () => {
    const items = [
      { id: "RBx", rect: { x: 1210, y: 20, w: 60, h: 40 }, from: { home: "B", parent: "B" } },
      { id: "R1", rect: { x: 30, y: 20, w: 60, h: 40 }, from: { home: "A", parent: "A" } },
    ];
    assert.deepEqual(ML.multiDrops(items, (id: string) => boards[id], at), []);
  });
  test("a layer that leaves its board goes to the board under its own centre", () => {
    const items = [
      { id: "DR", rect: { x: 50, y: 500, w: 40, h: 40 }, from: { home: "D", parent: "D" } }, // left D, centre in A
      { id: "R1", rect: { x: 30, y: 20, w: 60, h: 40 }, from: { home: "A", parent: "A" } },
      { id: "X", rect: { x: 2000, y: 20, w: 60, h: 40 }, from: { home: "A", parent: "A" } }, // onto empty canvas
    ];
    const out = ML.multiDrops(items, (id: string) => boards[id], at);
    assert.deepEqual(out.map((o: any) => [o.id, o.target.kind === "frame" ? o.target.id : null]), [["DR", "A"], ["X", null]]);
  });
});

// @ts-ignore: a plain ES module the page imports too
import * as AL from "../src/page/autolayout-logic.js";
describe("QA3 P2-1. a frame inside a group is a drop target", () => {
  const tree = { type: "frame", id: "A", layout: "none", children: [
    { type: "group", id: "G", children: [{ type: "frame", id: "S", layout: "vertical", children: [] }, { type: "group", id: "G2", children: [{ type: "frame", id: "F", layout: "none", children: [] }] }] },
  ] };
  const R: Record<string, any> = { A: { x: 0, y: 0, w: 1000, h: 1000 }, G: { x: 100, y: 100, w: 500, h: 300 }, S: { x: 100, y: 100, w: 200, h: 300 }, G2: { x: 400, y: 100, w: 200, h: 200 }, F: { x: 400, y: 100, w: 200, h: 200 } };
  const rectOf = (id: string) => R[id];
  test("the stack in a group, and a frame in a nested group", () => {
    assert.equal(AL.dropTarget(tree, { x: 150, y: 150 }, rectOf, new Set(), null).id, "S");
    assert.equal(AL.dropTarget(tree, { x: 450, y: 150 }, rectOf, new Set(), null).id, "F");
    assert.equal(AL.dropTarget(tree, { x: 800, y: 800 }, rectOf, new Set(), null).id, "A");
  });
});

import { groupNodes } from "../src/structure.ts";
describe("QA3 P2-2. grouping or framing a rotated layer wraps its drawn box", () => {
  const mk = () => ({ children: [{ type: "frame", id: "A", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [
    { type: "rectangle", id: "R2", x: 90, y: 100, width: 60, height: 60, rotation: -45 },
  ] }] }) as any;
  const find = (d: any, id: string): any => { const s = (l: any[]): any => { for (const n of l ?? []) { if (n.id === id) return n; const h = s(n.children); if (h) return h; } }; return s(d.children); };
  for (const asFrame of [false, true]) test(asFrame ? "Opt+Cmd+G" : "Cmd+G", () => {
    const d = mk();
    const r = groupNodes(d, ["R2"], {}, asFrame);
    const g = find(d, r.select[0]);
    // Turned 45 degrees clockwise about its corner: the diamond reaches 42.43 left of x and 84.85 down.
    assert.deepEqual([g.x, g.y], [47.57, 100]);
    assert.deepEqual([find(d, "R2").x, find(d, "R2").y], [42.43, 0]);
    if (asFrame) assert.deepEqual([g.width, g.height], [84.85, 84.85]);
  });
});

describe("QA3 P2-3. a group or multi-selection with a rotated layer resizes", () => {
  // R2: 60x60 turned 90 degrees, stored corner 100,100: its box covers 100..160 x 40..100. R1: 0,40 60x60.
  const items = [
    { id: "R1", wr: { x: 0, y: 40, w: 60, h: 60 }, own: { x: 0, y: 40 }, type: "rectangle" },
    { id: "R2", wr: { x: 100, y: 40, w: 60, h: 60 }, own: { x: 100, y: 100 }, type: "rectangle", rot: 90, w0: 60, h0: 60 },
  ];
  const r0 = { x: 0, y: 40, w: 160, h: 60 };
  test("doubling the box doubles the rotated layer about the box's corner", () => {
    const out = ML.groupResizeItems(items, r0, { x: 0, y: 40, w: 320, h: 120 });
    const p = out[1].props;
    assert.deepEqual([p.width, p.height], [120, 120]);
    // Its box now covers 200..320 x 40..160: the stored corner (bottom-left on screen) is 200,160.
    assert.deepEqual([p.x, p.y], [200, 160]);
    assert.equal(p.rotation, undefined);
  });
  test("a stretch along x widens the turned layer's own height (its axis that lies along x)", () => {
    const p = ML.groupResizeItems(items, r0, { x: 0, y: 40, w: 320, h: 60 })[1].props;
    assert.deepEqual([p.width, p.height], [60, 120]);
  });
  test("mirrored past the left edge: flipped, turned the other way, box mirrored", () => {
    const p = ML.groupResizeItems(items, r0, { x: -160, y: 40, w: 160, h: 60, flipX: true })[1].props;
    assert.equal(p.flipX, true);
    assert.equal(p.rotation, -90);
    assert.deepEqual([p.width, p.height], [60, 60]);
  });
});

describe("QA3 P3-2. the outer pixels of an auto layout frame's edge resize, padding handles start further in", () => {
  test("1 px inside the top edge is not the top padding's handle; its middle is", () => {
    const f = { x: 0, y: 0, w: 300, h: 100 };
    const cam = { x: 0, y: 0, z: 1 };
    const as = AL.spacingAreas(f, [10, 10, 10, 10], [], "horizontal", cam);
    const frame = { x: 0, y: 0, w: 300, h: 100 };
    assert.equal(AL.handleUnder(as, 150, 1, 5, frame), null);
    assert.equal(AL.handleUnder(as, 150, 7, 5, frame)?.side, 0);
    assert.equal(AL.handleUnder(as, 299, 50, 5, frame), null);
  });
});

describe("QA3 P3-3. groups rotate: a group's own size from its layers", () => {
  test("the extent from the group's origin, turned and flipped layers included; unknown sizes give null", () => {
    assert.deepEqual(ML.groupExtent([{ x: 0, y: 0, width: 60, height: 40 }, { x: 100, y: 10, width: 20, height: 50 }]), { w: 120, h: 60 });
    assert.deepEqual(ML.groupExtent([{ x: 60, y: 0, width: 60, height: 40, flipX: true }]), { w: 60, h: 40 });
    assert.deepEqual(ML.groupExtent([{ x: 0, y: 60, width: 60, height: 60, rotation: 90 }]), { w: 60, h: 60 });
    assert.equal(ML.groupExtent([{ x: 0, y: 0, width: "fit_content", height: 40 }]), null);
  });
});
