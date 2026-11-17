// Smart selection and Tidy up (src/page/smart-logic.js): every layer an equal distance apart, overlapping on the x or
// the y axis (1D), or on both (2D).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as M from "../src/page/smart-logic.js";

const row = [
  { id: "a", x: 0, y: 0, w: 40, h: 40 },
  { id: "b", x: 60, y: 10, w: 20, h: 20 },
  { id: "c", x: 100, y: 0, w: 60, h: 40 },
];
const col = [
  { id: "a", x: 0, y: 0, w: 40, h: 40 },
  { id: "b", x: 5, y: 52, w: 30, h: 10 },
  { id: "c", x: 0, y: 74, w: 40, h: 20 },
];
const grid = [
  { id: "a", x: 0, y: 0, w: 40, h: 40 }, { id: "b", x: 50, y: 0, w: 40, h: 40 }, { id: "c", x: 100, y: 0, w: 40, h: 40 },
  { id: "d", x: 0, y: 60, w: 40, h: 40 }, { id: "e", x: 50, y: 60, w: 40, h: 40 },
];

describe("detect", () => {
  test("a row: equal gaps, overlapping across, any sizes, in any selection order", () => {
    const m = M.detect([row[2], row[0], row[1]]);
    assert.deepEqual(m, { kind: "1d", axis: "x", lines: [["a", "b", "c"]], gap: 20, crossGap: null });
  });
  test("a column", () => {
    assert.deepEqual(M.detect(col), { kind: "1d", axis: "y", lines: [["a", "b", "c"]], gap: 12, crossGap: null });
  });
  test("a grid: rows of the same gap, the rows evenly spaced (rows may differ in length)", () => {
    assert.deepEqual(M.detect(grid), { kind: "2d", axis: "x", lines: [["a", "b", "c"], ["d", "e"]], gap: 10, crossGap: 20 });
  });
  test("not evenly spaced, not overlapping across, overlapping along, or fewer than three: none", () => {
    assert.equal(M.detect([row[0], row[1], { ...row[2], x: 110 }]), null);
    assert.equal(M.detect([row[0], { ...row[1], y: 100 }, { ...row[2], y: 300 }]), null);
    assert.equal(M.detect([row[0], row[1]]), null); // two side by side: no rings on every pair
    assert.equal(M.detect([row[0], { ...row[1], x: 20, y: 0 }, { ...row[2], x: 40, y: 0 }]), null);
    assert.equal(M.detect([row[0]]), null);
    assert.equal(M.detect([...grid.slice(0, 4), { ...grid[4], x: 56 }]), null); // the second row's gap differs
  });
  test("within a pixel counts as equal", () => {
    assert.ok(M.detect([row[0], row[1], { ...row[2], x: 100.8 }]));
  });
});

describe("arrange", () => {
  test("a new gap: the row starts where it did, each layer keeps its place across", () => {
    const m = M.detect(row);
    const p = M.arrange(m, row, m.lines, 8);
    assert.deepEqual(Object.fromEntries(p), { a: { x: 0, y: 0 }, b: { x: 48, y: 10 }, c: { x: 76, y: 0 } });
    assert.deepEqual(M.deltas(row, p), [{ id: "b", dx: -12, dy: 0 }, { id: "c", dx: -24, dy: 0 }]);
  });
  test("a grid's two gaps", () => {
    const m = M.detect(grid);
    const p = M.arrange(m, grid, m.lines, 20, 0);
    assert.deepEqual(p.get("c"), { x: 120, y: 0 });
    assert.deepEqual(p.get("e"), { x: 60, y: 40 });
  });
  test("a new order: same gap, the moved layer at its slot", () => {
    const m = M.detect(row);
    const mv = M.moveTo(m, row, ["a"], { x: 150, y: 20 });
    assert.deepEqual(mv.lines, [["b", "c", "a"]]);
    assert.deepEqual(mv.slot, { line: 0, index: 2 });
    assert.deepEqual(Object.fromEntries(M.arrange(m, row, mv.lines)), { b: { x: 0, y: 10 }, c: { x: 40, y: 0 }, a: { x: 120, y: 0 } });
  });
  test("several marked layers move together, in their order", () => {
    const m = M.detect(row);
    assert.deepEqual(M.moveTo(m, row, ["c", "a"], { x: 75, y: 20 }).lines, [["b", "a", "c"]]);
  });
  test("2D: a layer moves into another row", () => {
    const m = M.detect(grid);
    const mv = M.moveTo(m, grid, ["b"], { x: 95, y: 80 });
    assert.deepEqual(mv.lines, [["a", "c"], ["d", "e", "b"]]);
  });
  test("Cmd swaps two layers", () => {
    const m = M.detect(row);
    const lines = M.swap(m, "a", M.layerAt(m, row, { x: 120, y: 5 }, ["a"]));
    assert.deepEqual(lines, [["c", "b", "a"]]);
    assert.deepEqual(Object.fromEntries(M.arrange(m, row, lines)), { c: { x: 0, y: 0 }, b: { x: 80, y: 10 }, a: { x: 120, y: 0 } });
    assert.equal(M.swap(m, "a", null), null);
  });
  test("the insertion line sits halfway in the gap the layer goes to", () => {
    const m = M.detect(row);
    const mv = M.moveTo(m, row, ["a"], { x: 85, y: 20 });
    assert.deepEqual(M.slotLine(m, row, mv.lines, mv.slot, ["a"]), { x0: 90, y0: 0, x1: 90, y1: 40 });
  });
  test("Cmd+D copies land after their originals; Delete closes the gap", () => {
    const m = M.detect(row);
    assert.deepEqual(M.withCopies(m, new Map([["b", "b2"]])), [["a", "b", "b2", "c"]]);
    assert.deepEqual(M.without(m, ["b"]), [["a", "c"]]);
  });
});

describe("handles and fields", () => {
  test("a row has a handle in each gap, a grid one between its rows too", () => {
    assert.deepEqual(M.gapAreas(M.detect(row), row), [
      { kind: "gap", axis: "x", rect: { x: 40, y: 10, w: 20, h: 20 } },
      { kind: "gap", axis: "x", rect: { x: 80, y: 10, w: 20, h: 20 } },
    ]);
    const g = M.gapAreas(M.detect(grid), grid);
    assert.equal(g.filter((a: any) => a.kind === "gap").length, 3);
    assert.deepEqual(g.find((a: any) => a.kind === "cross"), { kind: "cross", axis: "y", rect: { x: 0, y: 40, w: 140, h: 20 } });
  });
  test("dragging a handle: whole px, Shift in big-nudge steps, may go negative", () => {
    assert.equal(M.dragGap(20, 13, 2), 27);
    assert.equal(M.dragGap(20, 13, 1, true, 10), 30);
    assert.equal(M.dragGap(20, -50, 1), -30);
  });
  test("the inspector's space between fields", () => {
    assert.deepEqual(M.spacingOf(M.detect(row)), { x: 20, y: null });
    assert.deepEqual(M.spacingOf(M.detect(col)), { x: null, y: 12 });
    assert.deepEqual(M.spacingOf(M.detect(grid)), { x: 10, y: 20 });
    assert.deepEqual(M.gapsFrom(M.detect(grid), { x: 4, y: null }), { gap: 4, crossGap: 20 });
    assert.deepEqual(M.gapsFrom(M.detect(col), { x: null, y: 6 }), { gap: 6, crossGap: null });
  });
});

describe("tidy up", () => {
  test("a loose row becomes evenly spaced from its left, its mean gap rounded, tops aligned", () => {
    const t = M.tidy([{ id: "a", x: 0, y: 5, w: 40, h: 40 }, { id: "b", x: 47, y: 0, w: 40, h: 40 }, { id: "c", x: 100, y: 10, w: 40, h: 40 }]);
    assert.deepEqual(Object.fromEntries(t.pos), { a: { x: 0, y: 0 }, b: { x: 50, y: 0 }, c: { x: 100, y: 0 } });
    assert.equal(t.model.gap, 10);
  });
  test("a loose grid becomes rows aligned to the top-left, and then it is a smart selection", () => {
    const rs = [{ id: "a", x: 0, y: 0, w: 40, h: 40 }, { id: "b", x: 55, y: 3, w: 40, h: 40 }, { id: "c", x: 2, y: 70, w: 40, h: 40 }, { id: "d", x: 50, y: 62, w: 40, h: 40 }];
    const t = M.tidy(rs);
    assert.deepEqual(Object.fromEntries(t.pos), { a: { x: 0, y: 0 }, b: { x: 52, y: 0 }, c: { x: 0, y: 59 }, d: { x: 52, y: 59 } });
    const after = rs.map((r) => ({ ...r, ...t.pos.get(r.id) }));
    assert.equal(M.detect(after).kind, "2d");
  });
  test("overlapping layers tidy with no gap (two are enough to tidy); one layer is nothing to tidy", () => {
    const t = M.tidy([{ id: "a", x: 0, y: 0, w: 40, h: 40 }, { id: "b", x: 30, y: 0, w: 40, h: 40 }]);
    assert.deepEqual(t.pos.get("b"), { x: 40, y: 0 });
    assert.equal(M.tidy([{ id: "a", x: 0, y: 0, w: 1, h: 1 }]), null);
  });
});
