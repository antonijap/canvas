// Auto layout on the page (src/page/autolayout-logic.js, the order override in src/page/live-edit.js): slot
// finding, the order a reorder or a move gives a parent, arrow-key reorder, the insertion line, the drop target,
// the pink spacing handles, padding forms, and the order override drawn until the server's scene has it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as A from "../src/page/autolayout-logic.js";
// @ts-ignore: a plain ES module the page imports too
import * as L from "../src/page/live-edit.js";

const row = (n: number, w = 40, gap = 10, x0 = 0, y = 0) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * (w + gap), y, w, h: 40 }));

describe("layoutOf / inFlow", () => {
  test("a frame without layout is horizontal; groups and shapes never lay out", () => {
    assert.equal(A.layoutOf({ type: "frame" }), "horizontal");
    assert.equal(A.layoutOf({ type: "frame", layout: "vertical" }), "vertical");
    assert.equal(A.layoutOf({ type: "frame", layout: "none" }), "none");
    assert.equal(A.layoutOf({ type: "group", layout: "vertical" }), "none");
    assert.equal(A.layoutOf({ type: "rectangle" }), "none");
  });
  test("absolute children are out of the flow", () => {
    assert.equal(A.inFlow({ type: "frame" }, { id: "a" }), true);
    assert.equal(A.inFlow({ type: "frame" }, { id: "a", layoutPosition: "absolute" }), false);
    assert.equal(A.inFlow({ type: "frame", layout: "none" }, { id: "a" }), false);
  });
});

describe("slotAt", () => {
  test("pointer over the 2nd half of item 2 in a 4-item row gives slot 2", () => {
    const r = row(4);
    assert.equal(A.slotAt(r, { x: 50 + 30, y: 20 }, "horizontal"), 2);
    assert.equal(A.slotAt(r, { x: 50 + 10, y: 20 }, "horizontal"), 1);
    assert.equal(A.slotAt(r, { x: -100, y: 20 }, "horizontal"), 0);
    assert.equal(A.slotAt(r, { x: 1000, y: 20 }, "horizontal"), 4);
  });
  test("a vertical flow uses y", () => {
    const r = [0, 1, 2].map((i) => ({ x: 0, y: i * 50, w: 200, h: 40 }));
    assert.equal(A.slotAt(r, { x: 500, y: 75 }, "vertical"), 2);
    assert.equal(A.slotAt(r, { x: 500, y: 65 }, "vertical"), 1);
  });
  test("a wrapped flow picks the line first, then the slot in it", () => {
    // Two lines of three: y 0 and y 60.
    const r = [...row(3), ...row(3, 40, 10, 0, 60)];
    assert.equal(A.slotAt(r, { x: 80, y: 70 }, "horizontal", true), 5); // line 2, past the 2nd item's middle
    assert.equal(A.slotAt(r, { x: 5, y: 70 }, "horizontal", true), 3); // line 2, before its first
    assert.equal(A.slotAt(r, { x: 80, y: 10 }, "horizontal", true), 2);
    assert.equal(A.slotAt(r, { x: 80, y: 200 }, "horizontal", true), 5); // below everything: the nearest line
  });
  test("no items: slot 0", () => assert.equal(A.slotAt([], { x: 0, y: 0 }, "horizontal"), 0));
});

describe("orderWith / indexIn / slotOf", () => {
  test("dragging item 1 of 3 past item 3 gives 2, 3, 1", () => {
    const order = A.orderWith(["a", "b", "c"], ["b", "c"], ["a"], 2);
    assert.deepEqual(order, ["b", "c", "a"]);
    assert.equal(A.indexIn(order, "a"), 2);
  });
  test("absolute children keep their place in the list", () => {
    // x is absolute; flow is a, b, c.
    assert.deepEqual(A.orderWith(["a", "x", "b", "c"], ["a", "b", "c"], ["c"], 0), ["c", "a", "x", "b"]);
    assert.deepEqual(A.orderWith(["a", "x", "b", "c"], ["a", "b", "c"], ["a"], 1), ["x", "b", "a", "c"]);
  });
  test("a layer coming from elsewhere is inserted", () => {
    assert.deepEqual(A.orderWith(["a", "b"], ["a", "b"], ["z"], 1), ["a", "z", "b"]);
    assert.deepEqual(A.orderWith([], [], ["z"], 0), ["z"]);
  });
  test("several layers move as one block, in their order", () => {
    assert.deepEqual(A.orderWith(["a", "b", "c", "d"], ["a", "b", "c", "d"], ["a", "b"], 2), ["c", "d", "a", "b"]);
  });
  test("slotOf finds where the moving layers sit", () => {
    assert.equal(A.slotOf(["a", "b", "c"], ["b"]), 1);
    assert.equal(A.slotOf(["a", "b", "c"], ["z"]), -1);
  });
});

describe("arrowSlot", () => {
  const five = ["1", "2", "3", "4", "5"];
  test("Right x3 on item 1 of 5 walks it to slot 3", () => {
    let flow = five.slice();
    for (let i = 0; i < 3; i++) {
      const s = A.arrowSlot("horizontal", 1, 0, flow, ["1"]);
      assert.notEqual(s, null);
      flow = A.orderWith(flow, flow, ["1"], s);
    }
    assert.deepEqual(flow, ["2", "3", "4", "1", "5"]);
    assert.equal(flow.indexOf("1"), 3);
  });
  test("cross-axis arrows do nothing; the ends stop", () => {
    assert.equal(A.arrowSlot("horizontal", 0, -1, five, ["1"]), null);
    assert.equal(A.arrowSlot("vertical", 1, 0, five, ["1"]), null);
    assert.equal(A.arrowSlot("horizontal", -1, 0, five, ["1"]), null);
    assert.equal(A.arrowSlot("horizontal", 1, 0, five, ["5"]), null);
    assert.equal(A.arrowSlot("vertical", 0, 10, five, ["1"]), 1); // Shift's big step still moves one slot
  });
  test("a block of two moves together", () => {
    assert.equal(A.arrowSlot("horizontal", 1, 0, five, ["2", "3"]), 2);
  });
});

describe("insertionLine", () => {
  const f = { x: 0, y: 0, w: 200, h: 60 };
  const pad = [10, 10, 10, 10];
  test("centred in the gap, across the content box", () => {
    const r = row(3, 40, 10, 10, 10);
    assert.deepEqual(A.insertionLine(f, pad, r, "horizontal", 1), { x0: 55, y0: 10, x1: 55, y1: 50 });
  });
  test("before the first and after the last item, not past the padding edge", () => {
    const r = row(3, 40, 10, 10, 10);
    assert.equal(A.insertionLine(f, pad, r, "horizontal", 0).x0, 10);
    assert.equal(A.insertionLine(f, pad, r, "horizontal", 3).x0, 155);
  });
  test("a vertical flow draws a horizontal line", () => {
    const r = [0, 1].map((i) => ({ x: 10, y: 10 + i * 30, w: 100, h: 20 }));
    assert.deepEqual(A.insertionLine({ x: 0, y: 0, w: 120, h: 70 }, pad, r, "vertical", 1), { x0: 10, y0: 35, x1: 110, y1: 35 });
  });
  test("an empty frame: at the padding edge", () => {
    assert.deepEqual(A.insertionLine(f, pad, [], "horizontal", 0), { x0: 10, y0: 10, x1: 10, y1: 50 });
  });
});

describe("dropTarget", () => {
  const tree = { id: "B", type: "frame", layout: "none", children: [
    { id: "F", type: "frame", layout: "horizontal", children: [{ id: "a", type: "rectangle" }, { id: "N", type: "frame", layout: "vertical", children: [] }] },
    { id: "I", type: "frame", children: [{ id: "I/x", type: "frame", children: [] }] },
  ] };
  const R: Record<string, { x: number; y: number; w: number; h: number }> = { B: { x: 0, y: 0, w: 1000, h: 1000 }, F: { x: 0, y: 0, w: 300, h: 100 }, N: { x: 100, y: 0, w: 50, h: 50 }, I: { x: 500, y: 0, w: 200, h: 200 }, "I/x": { x: 500, y: 0, w: 100, h: 100 } };
  const rectOf = (id: string) => R[id] || null;
  test("the deepest frame under the point", () => {
    assert.equal(A.dropTarget(tree, { x: 110, y: 10 }, rectOf, new Set(), null).id, "N");
    assert.equal(A.dropTarget(tree, { x: 10, y: 10 }, rectOf, new Set(), null).id, "F");
    assert.equal(A.dropTarget(tree, { x: 900, y: 900 }, rectOf, new Set(), null).id, "B");
  });
  test("an auto layout frame smaller than the layer passes it to its parent, unless Cmd", () => {
    assert.equal(A.dropTarget(tree, { x: 110, y: 10 }, rectOf, new Set(), { w: 80, h: 30 }).id, "F");
    assert.equal(A.dropTarget(tree, { x: 110, y: 10 }, rectOf, new Set(), { w: 80, h: 30 }, true).id, "N");
  });
  test("never the dragged layer or inside it, never an instance or inside one: the frame around it takes the layer", () => {
    assert.equal(A.dropTarget(tree, { x: 110, y: 10 }, rectOf, new Set(["F"]), null).id, "B");
    assert.equal(A.dropTarget(tree, { x: 510, y: 10 }, rectOf, new Set(), null).id, "B");
    const leaf = { id: "B", type: "frame", layout: "vertical", children: [{ id: "I", type: "frame", component: "C", children: [] }] };
    assert.equal(A.dropTarget(leaf, { x: 510, y: 10 }, rectOf, new Set(), null).id, "B");
  });
});

describe("padding", () => {
  test("sides from every form", () => {
    assert.deepEqual(A.sides(8), [8, 8, 8, 8]);
    assert.deepEqual(A.sides([4, 12]), [4, 12, 4, 12]);
    assert.deepEqual(A.sides([1, 2, 3, 4]), [1, 2, 3, 4]);
    assert.deepEqual(A.sides(undefined), [0, 0, 0, 0]);
  });
  test("the file's form is kept while the change fits it, widened only as needed", () => {
    assert.deepEqual(A.paddingForm([10, 20], [10, 30, 10, 30]), [10, 30]); // Option on left: left and right together
    assert.equal(A.paddingForm(10, [12, 12, 12, 12]), 12);
    assert.deepEqual(A.paddingForm(10, [10, 14, 10, 14]), [10, 14]);
    assert.deepEqual(A.paddingForm([10, 20], [10, 20, 10, 5]), [10, 20, 10, 5]);
    assert.deepEqual(A.paddingForm([1, 2, 3, 4], [5, 5, 5, 5]), [5, 5, 5, 5]);
  });
  test("modifier keys: Option takes the opposite side, Option+Shift all four, Shift alone keeps the one side", () => {
    assert.deepEqual(A.sidesFor(3, false, false), [3]);
    assert.deepEqual(A.sidesFor(3, true, false), [1, 3]);
    assert.deepEqual(A.sidesFor(0, true, false), [0, 2]);
    assert.deepEqual(A.sidesFor(2, false, true), [2]); // Shift alone: big-nudge steps on this side (handleSteps)
    assert.deepEqual(A.sidesFor(1, true, true), [0, 1, 2, 3]);
  });
  test("a point inside a frame, clear of its resize edge", () => {
    const f = { x: 0, y: 0, w: 100, h: 40 };
    assert.equal(A.inside(f, 50, 20), true);
    assert.equal(A.inside(f, 3, 20), false);
    assert.equal(A.inside(f, 50, 38), false);
    assert.equal(A.inside(f, 6, 6), true);
  });
  test("Shift steps by the big nudge on a padding and on a gap; Option+Shift on a padding is all four sides, 1 px steps", () => {
    assert.equal(A.handleSteps("pad", false, true), true);
    assert.equal(A.handleSteps("gap", false, true), true);
    assert.equal(A.handleSteps("pad", true, true), false);
    assert.equal(A.handleSteps("pad", false, false), false);
    assert.equal(A.handleSteps("gap", true, true), true);
  });
  test("an Option+Shift drag on a padding writes all four sides in the file's form", () => {
    // Left padding dragged from 10 to 18 with Option+Shift: one number again.
    const s = A.sides(10).slice();
    for (const i of A.sidesFor(3, true, true)) s[i] = 18;
    assert.equal(A.paddingForm(10, s), 18);
    // [v, h] form, Option on the top: top and bottom only, the form kept.
    const t = A.sides([8, 16]).slice();
    for (const i of A.sidesFor(0, true, false)) t[i] = 12;
    assert.deepEqual(A.paddingForm([8, 16], t), [12, 16]);
  });
});

describe("spacing handles", () => {
  const cam = { x: 0, y: 0, z: 1 };
  const f = { x: 0, y: 0, w: 170, h: 60 };
  const kids = row(3, 40, 10, 10, 10);
  test("one area per padding side and per gap, with a centred bar", () => {
    const a = A.spacingAreas(f, [10, 10, 10, 10], kids, "horizontal", cam, 10);
    assert.equal(a.filter((x: any) => x.kind === "pad").length, 4);
    const gaps = a.filter((x: any) => x.kind === "gap");
    assert.equal(gaps.length, 2);
    assert.deepEqual(gaps[0].rect, { x: 50, y: 10, w: 10, h: 40 });
    assert.deepEqual(gaps[0].bar, { x: 54, y: 24, w: 2, h: 12 });
    assert.equal(gaps[0].cursor, "ew-resize");
    const left = a.find((x: any) => x.kind === "pad" && x.side === 3);
    assert.equal(left.cursor, "ew-resize");
    assert.equal(A.handleUnder(a, 55, 30).kind, "gap");
  });
  test("too small on screen: no handle", () => {
    const a = A.spacingAreas(f, [10, 10, 10, 10], kids, "horizontal", { x: 0, y: 0, z: 0.4 }, 10);
    assert.equal(a.length, 0);
  });
  test("dragging grows the spacing the way the pointer pulls; padding stops at 0, a gap goes negative", () => {
    const left = { kind: "pad", side: 3, cursor: "ew-resize" };
    const right = { kind: "pad", side: 1, cursor: "ew-resize" };
    const top = { kind: "pad", side: 0, cursor: "ns-resize" };
    assert.equal(A.dragValue(left, 10, 6, 0, 1), 16);
    assert.equal(A.dragValue(right, 10, 6, 0, 1), 4);
    assert.equal(A.dragValue(top, 10, 0, -40, 1), 0);
    assert.equal(A.dragValue({ kind: "gap", cursor: "ew-resize" }, 10, -30, 0, 1), -20);
    assert.equal(A.dragValue({ kind: "gap", cursor: "ew-resize" }, 10, 13, 0, 2), 17); // 6.5 world px at 200%, rounded
    assert.equal(A.dragValue(left, 10, 14, 0, 1, true, 10), 20);
  });
  test("whole px while pixel snapping is on, hundredths when it is off", () => {
    const gap = { kind: "gap", cursor: "ns-resize" };
    assert.equal(A.dragValue(gap, 10, 0, 7, 4), 12); // 1.75 world px at 400%: 11.75, snapped to 12
    assert.equal(A.dragValue(gap, 10, 0, 7, 4, false, 10, false), 11.75);
    assert.equal(A.dragValue({ kind: "pad", side: 3 }, 0, -3, 0, 4, false, 10, false), 0); // padding never below 0
  });
  test("an unchanged drag writes nothing; a changed side does", () => {
    assert.equal(A.handleChanged({ pad: [10, 10, 10, 10], gap: 8 }, { padding: 10 }), false);
    assert.equal(A.handleChanged({ pad: [10, 10, 10, 10], gap: 8 }, { padding: [10, 12] }), true);
    assert.equal(A.handleChanged({ pad: [0, 0, 0, 0], gap: 8 }, { gap: 8 }), false);
    assert.equal(A.handleChanged({ pad: [0, 0, 0, 0], gap: 8, auto: true }, { gap: 8 }), true); // ends Auto gap
  });
});

describe("resize clamp", () => {
  test("an auto layout frame cannot be smaller than its padding", () => {
    const min = A.minSize([10, 20, 10, 20]);
    assert.deepEqual(min, { w: 40, h: 20 });
    assert.deepEqual(A.clampResize({ x: 90, y: 0, w: 10, h: 50 }, { x: 0, y: 0, w: 100, h: 50 }, "w", min), { x: 60, y: 0, w: 40, h: 50 });
    assert.deepEqual(A.clampResize({ x: 0, y: 0, w: 10, h: 5 }, { x: 0, y: 0, w: 100, h: 50 }, "se", min), { x: 0, y: 0, w: 40, h: 20 });
  });
});

describe("easing", () => {
  test("ease runs 0 to 1 and slows at the end", () => {
    assert.equal(A.ease(0), 0);
    assert.equal(A.ease(1), 1);
    assert.ok(A.ease(0.5) > 0.5);
    assert.deepEqual(A.lerpRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 20, w: 10, h: 10 }, 0.5), { x: 5, y: 10, w: 10, h: 10 });
  });
});

describe("order override (live-edit.js)", () => {
  const scene = () => ({ id: "B", root: { id: "B", type: "frame", layout: "none", children: [
    { id: "F", type: "frame", layout: "horizontal", children: [{ id: "a", type: "rectangle", width: 10, height: 10 }, { id: "b", type: "rectangle", width: 10, height: 10 }, { id: "c", type: "rectangle", width: 10, height: 10 }] },
    { id: "G", type: "frame", layout: "vertical", children: [{ id: "g1", type: "rectangle", width: 10, height: 10 }] },
  ] } });
  const kids = (s: any, id: string) => L.findNode(s.root, id).children.map((c: any) => c.id);
  test("applyOrder reorders, moves between parents, and drops what the list leaves out", () => {
    const s = scene();
    assert.equal(L.applyOrder(s.root, [["F", ["b", "c", "a"]]]), true);
    assert.deepEqual(kids(s, "F"), ["b", "c", "a"]);
    assert.equal(L.applyOrder(s.root, [["F", ["b", "c", "a"]]]), false);
    L.applyOrder(s.root, [["F", ["b", "a"]], ["G", ["g1", "c"]]]);
    assert.deepEqual(kids(s, "F"), ["b", "a"]);
    assert.deepEqual(kids(s, "G"), ["g1", "c"]);
    L.applyOrder(s.root, [["G", ["g1", { id: "z", node: { id: "z", type: "rectangle" } }]]]);
    assert.deepEqual(kids(s, "G"), ["g1", "z"]);
  });
  test("drawn on every scene until its write is acknowledged and a newer scene came", () => {
    let now = 1000;
    const e = new L.LiveEdits({ now: () => now });
    const op = L.PAGE_OPS + 1;
    e.setOrder("B", "F", ["c", "a", "b"], op);
    e.set("B", "c", { opacity: 0.5 }, [], op);
    const s1 = scene();
    assert.equal(e.apply("B", s1), true);
    assert.deepEqual(kids(s1, "F"), ["c", "a", "b"]);
    assert.equal(L.findNode(s1.root, "c").opacity, 0.5);
    // The write answers; a scene asked for before the answer still gets the override.
    now = 2000;
    e.ack("F", op, true);
    e.ack("c", op, true);
    const s2 = scene();
    e.rebase("B", s2, 1500);
    assert.deepEqual(kids(s2, "F"), ["c", "a", "b"]);
    // A scene asked for after it: the server has the order, the override lets go.
    const s3 = scene();
    e.rebase("B", s3, 2500);
    assert.deepEqual(kids(s3, "F"), ["a", "b", "c"]);
    assert.equal(e.has("B"), false);
  });
  test("a failed write drops it", () => {
    const e = new L.LiveEdits({ now: () => 0 });
    e.setOrder("B", "F", ["c", "a", "b"], 5);
    e.ack("F", 5, false);
    const s = scene();
    assert.equal(e.apply("B", s), false);
    assert.deepEqual(kids(s, "F"), ["a", "b", "c"]);
  });
});
