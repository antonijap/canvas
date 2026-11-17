// The widget layer's pure helpers (src/page/geometry.js), the same file the browser imports.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore untyped browser module
import * as g from "../src/page/geometry.js";

const cam = { x: 100, y: 50, z: 2 };

describe("page geometry", () => {
  test("world and view coordinates round-trip through the camera", () => {
    const v = g.worldToView(cam, { x: 10, y: 20 });
    assert.deepEqual(v, { x: 120, y: 90 });
    assert.deepEqual(g.viewToWorld(cam, v), { x: 10, y: 20 });
    assert.deepEqual(g.rectToView(cam, { x: 10, y: 20, w: 30, h: 40 }), { x: 120, y: 90, w: 60, h: 80 });
  });

  test("visible area grows by a fraction of the view on every side", () => {
    const a = g.visibleWorldRect({ x: 0, y: 0, z: 1 }, 1000, 500, 0);
    assert.deepEqual(a, { x: 0, y: 0, w: 1000, h: 500 });
    const b = g.visibleWorldRect({ x: 0, y: 0, z: 1 }, 1000, 500, 0.6);
    assert.deepEqual(b, { x: -600, y: -300, w: 2200, h: 1100 });
    const c = g.visibleWorldRect({ x: -200, y: 0, z: 2 }, 1000, 500, 0);
    assert.deepEqual(c, { x: 100, y: 0, w: 500, h: 250 });
  });

  test("rect intersection treats touching edges as apart", () => {
    const r = { x: 0, y: 0, w: 10, h: 10 };
    assert.ok(g.rectsIntersect(r, { x: 9, y: 9, w: 5, h: 5 }));
    assert.ok(!g.rectsIntersect(r, { x: 10, y: 0, w: 5, h: 5 }));
    assert.ok(!g.rectsIntersect(r, { x: 0, y: -5, w: 10, h: 5 }));
  });

  test("idsInView keeps list order and honours the margin", () => {
    const ws = [{ id: "a", x: 0, y: 0, w: 100, h: 100 }, { id: "b", x: 1100, y: 0, w: 100, h: 100 }, { id: "c", x: 5000, y: 0, w: 100, h: 100 }];
    const id = { x: 0, y: 0, z: 1 };
    assert.deepEqual(g.idsInView(ws, id, 1000, 800, 0), ["a"]);
    assert.deepEqual(g.idsInView(ws, id, 1000, 800, 0.3), ["a", "b"]);
  });

  test("level of detail reports only a crossing of zoom 0.25", () => {
    assert.equal(g.lodCrossing(false, 0.3), null);
    assert.equal(g.lodCrossing(false, 0.2), true);
    assert.equal(g.lodCrossing(true, 0.1), null);
    assert.equal(g.lodCrossing(true, 0.25), false);
  });

  test("sameSet ignores order", () => {
    assert.ok(g.sameSet(["a", "b"], ["b", "a"]));
    assert.ok(!g.sameSet(["a"], ["a", "b"]));
    assert.ok(g.sameSet([], []));
  });

  test("placeCentered puts the middle of the card in the middle of the free view", () => {
    const p = g.placeCentered({ x: 0, y: 0, z: 1 }, 1000, 800, { l: 0, t: 0, r: 0, b: 0 }, { w: 200, h: 100 });
    assert.deepEqual(p, { x: 400, y: 350 });
    const q = g.placeCentered({ x: 0, y: 0, z: 1 }, 1000, 800, { l: 200, t: 0, r: 0, b: 0 }, { w: 200, h: 100 });
    assert.deepEqual(q, { x: 500, y: 350 });
    const z = g.placeCentered({ x: 100, y: 100, z: 2 }, 1000, 800, { l: 0, t: 0, r: 0, b: 0 }, { w: 200, h: 100 });
    assert.deepEqual(z, { x: 100, y: 100 });
  });

  test("camToReveal centres the card and never zooms in past maxZ", () => {
    const c = g.camToReveal({ x: 100, y: 100, w: 200, h: 100 }, 1000, 800, { l: 0, t: 0, r: 0, b: 0 }, { maxZ: 1 });
    assert.equal(c.z, 1);
    assert.equal(c.x + 100 * c.z + 100, 500);
    assert.equal(c.y + 100 * c.z + 50, 400);
    const big = g.camToReveal({ x: 0, y: 0, w: 4000, h: 100 }, 1000, 800, { l: 0, t: 0, r: 0, b: 0 }, { maxZ: 1 });
    assert.ok(big.z < 0.25);
  });

  test("resizeRect keeps the opposite corner fixed", () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    assert.deepEqual(g.resizeRect(r, "br", 50, 20), { x: 100, y: 100, w: 250, h: 120 });
    assert.deepEqual(g.resizeRect(r, "tl", -30, -10), { x: 70, y: 90, w: 230, h: 110 });
    assert.deepEqual(g.resizeRect(r, "tr", 10, -10), { x: 100, y: 90, w: 210, h: 110 });
    assert.deepEqual(g.resizeRect(r, "bl", -10, 10), { x: 90, y: 100, w: 210, h: 110 });
  });

  test("resizeRect on an edge changes one dimension and keeps the opposite edge", () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    assert.deepEqual(g.resizeRect(r, "r", 50, 20), { x: 100, y: 100, w: 250, h: 100 });
    assert.deepEqual(g.resizeRect(r, "l", -30, 99), { x: 70, y: 100, w: 230, h: 100 });
    assert.deepEqual(g.resizeRect(r, "t", 99, -10), { x: 100, y: 90, w: 200, h: 110 });
    assert.deepEqual(g.resizeRect(r, "b", 99, 10), { x: 100, y: 100, w: 200, h: 110 });
    assert.deepEqual(g.resizeRect(r, "l", 500, 0, { w: 120, h: 80 }), { x: 180, y: 100, w: 120, h: 100 }, "the minimum holds, the right edge stays");
  });

  test("resizeRect: Option resizes from the centre, Shift on an edge keeps the ratio about the middle", () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    const min = { w: 40, h: 40 };
    assert.deepEqual(g.resizeRect(r, "r", 30, 0, min, false, true), { x: 70, y: 100, w: 260, h: 100 }, "an edge, both sides");
    assert.deepEqual(g.resizeRect(r, "tl", -10, -10, min, false, true), { x: 90, y: 90, w: 220, h: 120 }, "a corner, both axes");
    assert.deepEqual(g.resizeRect(r, "r", 40, 0, min, true), { x: 100, y: 90, w: 240, h: 120 }, "Shift on a side edge grows the height about the middle");
    assert.deepEqual(g.resizeRect(r, "b", 0, 50, min, true), { x: 50, y: 100, w: 300, h: 150 }, "Shift on a bottom edge grows the width about the middle");
    assert.deepEqual(g.resizeRect(r, "br", 40, 40, min, true), { x: 100, y: 100, w: 280, h: 140 }, "Shift on a corner keeps the far corner");
  });

  test("resizeZone: 6 px edges inside the card, corners reach 12 px, none on a card too small on screen", () => {
    const z = (x: number, y: number, w = 200, h = 100) => g.resizeZone(x, y, w, h);
    assert.equal(z(100, 50), null, "the middle moves the card");
    assert.equal(z(100, 2), "t");
    assert.equal(z(100, 97), "b");
    assert.equal(z(1, 50), "l");
    assert.equal(z(198, 50), "r");
    assert.equal(z(2, 2), "tl");
    assert.equal(z(10, 3), "tl", "a corner reaches along the edge");
    assert.equal(z(197, 98), "br");
    assert.equal(z(198, 9), "tr");
    assert.equal(z(9, 98), "bl");
    assert.equal(z(100, 7), null, "just inside the band");
    assert.equal(z(1, 1, 20, 20), null, "too small on screen: a press moves it");
    assert.equal(z(-1, 50), null);
    assert.equal(g.ZONE_CURSOR.t, "ns-resize");
    assert.equal(g.ZONE_CURSOR.l, "ew-resize");
  });

  test("resizeZone: a point outside a rounded corner is not on the card", () => {
    const r = g.CARD_RADIUS;
    assert.equal(g.resizeZone(1, 1, 200, 100, 6, r), null, "outside the curve");
    assert.equal(g.resizeZone(1, 1, 200, 100), "tl", "square corners keep the old zone");
    assert.equal(g.resizeZone(4, 4, 200, 100, 6, r), "tl", "inside the curve");
    assert.equal(g.resizeZone(198, 98, 200, 100, 6, r), null);
    assert.equal(g.resizeZone(100, 2, 200, 100, 6, r), "t", "edges away from the corner are unchanged");
    assert.equal(g.resizeZone(2, 50, 200, 100, 6, r), "l");
  });

  test("resizeRect clamps to the minimum size and anchors the far corner", () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    const m = { w: 120, h: 80 };
    assert.deepEqual(g.resizeRect(r, "br", -500, -500, m), { x: 100, y: 100, w: 120, h: 80 });
    // Shrinking from the top-left must leave the bottom-right at (300, 200).
    const tl = g.resizeRect(r, "tl", 500, 500, m);
    assert.deepEqual(tl, { x: 180, y: 120, w: 120, h: 80 });
  });

  test("resizeRect with Shift keeps the aspect ratio", () => {
    const r = { x: 0, y: 0, w: 200, h: 100 };
    const a = g.resizeRect(r, "br", 100, 5, { w: 40, h: 40 }, true);
    assert.equal(a.w / a.h, 2);
    assert.equal(a.w, 300);
    const b = g.resizeRect(r, "br", 5, 100, { w: 40, h: 40 }, true);
    assert.equal(b.h, 200);
    assert.equal(b.w, 400);
    const small = g.resizeRect(r, "br", -190, -90, { w: 100, h: 40 }, true);
    assert.ok(small.w >= 100 && small.h >= 40);
    assert.equal(Math.round((small.w / small.h) * 100), 200);
  });

  test("moveRect rounds to whole pixels", () => {
    assert.deepEqual(g.moveRect({ x: 10, y: 10, w: 5, h: 5 }, 2.4, -3.6), { x: 12, y: 6, w: 5, h: 5 });
  });

  test("sparkPoints scales to the box, oldest left", () => {
    assert.equal(g.sparkPoints([1]), "");
    assert.equal(g.sparkPoints([]), "");
    assert.equal(g.sparkPoints(undefined), "");
    const pts = g.sparkPoints([0, 10], 100, 30, 2).split(" ");
    assert.deepEqual(pts, ["0,28", "100,2"]);
    assert.equal(g.sparkPoints([5, 5, 5], 100, 30), "0,15 50,15 100,15");
    assert.equal(g.sparkPoints([1, NaN, 3], 100, 30, 0), "0,30 100,0");
  });

  test("fitRows reserves a line for the +N more note", () => {
    assert.deepEqual(g.fitRows(300, 30, 84, 5), { shown: 5, more: 0 });
    assert.deepEqual(g.fitRows(300, 30, 84, 10), { shown: 6, more: 4 });
    assert.deepEqual(g.fitRows(60, 30, 84, 3), { shown: 0, more: 3 });
  });

  test("delta sign, age labels and origins", () => {
    assert.equal(g.deltaSign({ value: 3, display: "+3" }), 1);
    assert.equal(g.deltaSign({ value: -1, display: "-1" }), -1);
    assert.equal(g.deltaSign({ value: 0, display: "0" }), 0);
    assert.equal(g.deltaSign(undefined), 0);
    assert.equal(g.ageSec(1000, 6000), 5);
    assert.equal(g.ageSec(undefined), null);
    assert.equal(g.ageLabel(5), "5s");
    assert.equal(g.ageLabel(125), "2m");
    assert.equal(g.ageLabel(7300), "2h");
    assert.equal(g.originOf("json", { url: "http://127.0.0.1:9000/x?y=1" }), "http://127.0.0.1:9000");
    assert.equal(g.originOf("posthog", { host: "eu" }), "https://eu.posthog.com");
    assert.equal(g.originOf("posthog", { host: "https://ph.example.com/a" }), "https://ph.example.com");
    assert.equal(g.originOf("json", { url: "nope" }), "");
  });
});

describe("token usages: where to fly (maintainer sweep)", () => {
  const view = { w: 1000, h: 800 };
  const at = { x: 0, y: 0, z: 1 };
  test("a usage already on screen: stay", () => {
    assert.equal(g.usageFocus([{ x: 100, y: 100, w: 200, h: 200 }], at, view.w, view.h), null);
  });
  test("usages off screen: the union of their boards", () => {
    const r = g.usageFocus([{ x: 3000, y: 0, w: 400, h: 400 }, { x: 3600, y: 0, w: 400, h: 400 }], at, view.w, view.h);
    assert.deepEqual(r, { x: 3000, y: 0, w: 1000, h: 400 });
  });
  test("spread too far to read together: the nearest board", () => {
    const r = g.usageFocus([{ x: 90000, y: 0, w: 400, h: 400 }, { x: 2000, y: 0, w: 400, h: 400 }, { x: -90000, y: 0, w: 400, h: 400 }], at, view.w, view.h);
    assert.deepEqual(r, { x: 2000, y: 0, w: 400, h: 400 });
  });
  test("under the side panels counts as off screen", () => {
    const r = g.usageFocus([{ x: 10, y: 10, w: 100, h: 100 }], at, view.w, view.h, { l: 300, t: 0, r: 0, b: 0 });
    assert.deepEqual(r, { x: 10, y: 10, w: 100, h: 100 });
  });
  test("nothing on this page: nothing to fly to", () => {
    assert.equal(g.usageFocus([], at, view.w, view.h), null);
  });
});

describe("NudgeQueue (arrow keys on widget cards)", () => {
  test("presses on another card while one card's write is out keep their own writes", async () => {
    const sent: string[] = [];
    const pending: (() => void)[] = [];
    const q = new g.NudgeQueue((id: string, at: { x: number }) => { sent.push(id + "@" + at.x); return new Promise<unknown>((r) => pending.push(() => r({ id }))); });
    q.push("A", { x: 1, y: 0 });
    q.push("B", { x: 5, y: 0 });
    q.push("C", { x: 9, y: 0 });
    q.push("B", { x: 6, y: 0 });
    assert.deepEqual(sent, ["A@1", "B@5", "C@9"]);
    assert.deepEqual(q.held("B"), { x: 6, y: 0 });
    while (pending.length) { pending.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    // B's later spot went out after its first write answered; nobody's write was dropped.
    assert.deepEqual(sent, ["A@1", "B@5", "C@9", "B@6"]);
    assert.equal(q.held("B"), null);
  });
  test("a failed write lets the card go and reports it", async () => {
    const failed: string[] = [];
    const q = new g.NudgeQueue(() => Promise.reject(new Error("409")), () => {}, (id: string) => failed.push(id));
    q.push("A", { x: 1, y: 0 });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(failed, ["A"]);
    assert.equal(q.held("A"), null);
  });
});

describe("double-click target", () => {
  const nested = ["Board", "Outer", "Inner", "Leaf"];
  test("nothing selected: one level below the board's child", () => {
    assert.equal(g.dblClickTarget(nested, []), "Inner");
    assert.equal(g.dblClickTarget(["Board", "Group", "Leaf"], []), "Leaf");
  });
  test("a selected container the pointer is in: its child, never two levels (QA playground)", () => {
    assert.equal(g.dblClickTarget(nested, [["Board", "Outer"]]), "Inner");
    assert.equal(g.dblClickTarget(nested, [["Board", "Outer", "Inner"]]), "Leaf");
  });
  test("a sibling selected, the leaf itself selected, or the board: stays at the layer's own level", () => {
    assert.equal(g.dblClickTarget(nested, [["Board", "Outer", "Inner", "Other"]]), "Leaf");
    assert.equal(g.dblClickTarget(nested, [nested]), "Leaf");
    assert.equal(g.dblClickTarget(nested, [["Board"]]), "Inner");
    assert.equal(g.dblClickTarget(["Board"], []), "Board");
  });
  test("text: a double-click that drills down to it selects it; the next double-click on it edits", () => {
    // A text in a group, nothing selected: the first click picks the group, the double-click drills to the text.
    const chain = ["Board", "Group", "Text"];
    const first = g.pickTarget(chain, [], false);
    assert.equal(first, "Group");
    const target = g.dblClickTarget(chain, []);
    assert.equal(target, "Text");
    assert.equal(g.dblClickEdits(target, [first]), false, "reached by the drill-down: select only");
    // Now the text is selected: the next double-click keeps it (first click) and lands on it again: edit.
    const pre = [chain];
    assert.equal(g.pickTarget(chain, pre, false), "Text");
    assert.equal(g.dblClickTarget(chain, pre), "Text");
    assert.equal(g.dblClickEdits("Text", ["Text"]), true);
    // A board's direct child: the first click already selects it, so the double-click edits (as before).
    assert.equal(g.pickTarget(["Board", "Title"], [], false), "Title");
    assert.equal(g.dblClickTarget(["Board", "Title"], []), "Title");
    assert.equal(g.dblClickEdits("Title", ["Title"]), true);
    // No second press seen (a synthetic dblclick): edit, as before.
    assert.equal(g.dblClickEdits("Text", null), true);
  });
});

describe("a rotated layer's own size from its drawn box (qa: the inspector got a turned group's box)", () => {
  const near = (a: { w: number; h: number }, b: { w: number; h: number }) => assert.ok(Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 1e-6, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  test("upright: the box is the size", () => near(g.unrotatedSize(136, 60, 0), { w: 136, h: 60 }));
  test("a quarter turn swaps the sides", () => {
    near(g.unrotatedSize(60, 136, -90), { w: 136, h: 60 });
    near(g.unrotatedSize(60, 136, 270), { w: 136, h: 60 });
  });
  test("30 degrees", () => {
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    near(g.unrotatedSize(100 * c + 40 * s, 100 * s + 40 * c, 30), { w: 100, h: 40 });
  });
  test("a known side gives the other one, even at 45 degrees", () => {
    const k = Math.SQRT1_2;
    near(g.unrotatedSize(100 * k + 40 * k, 100 * k + 40 * k, 45, 100), { w: 100, h: 40 });
    near(g.unrotatedSize(100 * k + 40 * k, 100 * k + 40 * k, 45, undefined, 40), { w: 100, h: 40 });
  });
  test("45 degrees with neither side known has no answer: null", () => assert.equal(g.unrotatedSize(99, 99, 45), null));
});
