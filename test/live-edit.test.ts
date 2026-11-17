// Live edits (src/page/live-edit.js): what an inspector edit may patch on the page, token resolution, the
// overrides that stay on top of server scenes until their write is acknowledged (and not one moment longer),
// and the resize math behind the selection handles (edges, corners, Shift, Option, snapping, fit to content).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as L from "../src/page/live-edit.js";
// @ts-ignore: a plain ES module the page imports too
import * as S from "../src/page/snap.js";

const scene = () => ({
  id: "B",
  root: { id: "B", type: "frame", width: 400, height: 300, layout: "none", children: [
    { id: "R", type: "rectangle", x: 10, y: 20, width: 50, height: 40, fill: "#FF0000" },
    { id: "T", type: "text", x: 0, y: 0, content: "Hi", fontSize: 14 },
  ] },
  fonts: [], images: [],
});
const VARS = { brand: { type: "color", value: [{ value: "#111111" }, { value: "#EEEEEE", theme: { mode: "dark" } }] }, alias: { type: "color", value: "$brand" }, gap: { type: "number", value: 12 } };

describe("prepareEdit", () => {
  test("literal geometry and colour are drawn on the page", () => {
    const p = L.prepareEdit({ height: 80, fill: "#00FF00", cornerRadius: [4, 4, 0, 0] }, [], {});
    assert.equal(p.ok, true);
    assert.deepEqual(p.props, { height: 80, fill: "#00FF00", cornerRadius: [4, 4, 0, 0] });
  });
  test("tokens resolve through aliases and inside paint objects", () => {
    const p = L.prepareEdit({ fill: "$alias", gap: "$gap", stroke: { type: "color", color: "$brand" } }, [], { vars: VARS });
    assert.equal(p.ok, true);
    assert.deepEqual(p.props, { fill: "#111111", gap: 12, stroke: { type: "color", color: "#111111" } });
  });
  test("hunt-5 #8: a token whose value depends on the theme waits for the server (the page cannot tell a node's theme)", () => {
    const themes = { mode: ["light", "dark"] };
    // Before: drawn in the default (light) theme, even on a dark board.
    assert.equal(L.prepareEdit({ fill: "$alias" }, [], { vars: VARS, themes }).ok, false);
    assert.equal(L.prepareEdit({ stroke: { type: "color", color: "$brand" } }, [], { vars: VARS, themes }).ok, false);
    // The same in every theme: drawn now.
    const p = L.prepareEdit({ gap: "$gap", height: 4 }, [], { vars: VARS, themes });
    assert.equal(p.ok, true);
    assert.deepEqual(p.props, { gap: 12, height: 4 });
  });
  test("what needs the server is refused whole: unknown tokens, fonts, content, images, visibility", () => {
    for (const props of [{ fill: "$nope" }, { fontFamily: "Inter" }, { fontWeight: "700" }, { content: "x" }, { fill: { type: "image", url: "a.png" } }, { enabled: false }, { height: 10, ref: "C" }]) {
      assert.equal(L.prepareEdit(props, [], { vars: VARS }).ok, false, JSON.stringify(props));
    }
  });
  test("a removal is refused on an instance (the component's value would come back) and allowed elsewhere", () => {
    assert.equal(L.prepareEdit({}, ["fill"], { instance: true }).ok, false);
    assert.deepEqual(L.prepareEdit({}, ["fill"], {}).remove, ["fill"]);
  });
  test("a board's x/y is a move, not a scene patch; names change nothing drawn", () => {
    const p = L.prepareEdit({ x: 100, y: -20, name: "New" }, [], { board: true });
    assert.deepEqual(p.pos, { x: 100, y: -20 });
    assert.deepEqual(p.props, {});
  });
});

describe("LiveEdits", () => {
  let t = 1000;
  const mk = () => new L.LiveEdits({ now: () => t });

  test("apply patches the node and reports a change once", () => {
    const e = mk(), s = scene();
    e.set("B", "R", { height: 80 }, ["fill"], 1);
    assert.equal(e.apply("B", s), true);
    const r = L.findNode(s.root, "R");
    assert.equal(r.height, 80);
    assert.equal("fill" in r, false);
    assert.equal(e.apply("B", s), false, "already applied");
  });

  test("a server scene asked for before the write answered gets the override again (no flicker back)", () => {
    const e = mk();
    t = 1000;
    e.set("B", "R", { height: 80 }, [], 7);
    const old = scene(); // the server still has 40
    assert.equal(e.rebase("B", old, 1005), true);
    assert.equal(L.findNode(old.root, "R").height, 80);
    assert.equal(e.has("B"), true);
  });

  test("equal values never count as the answer: only the write's acknowledgement does", () => {
    const e = mk();
    t = 1000;
    e.set("B", "R", { height: 40 }, [], 3); // same value the old scene has
    const s = scene();
    e.rebase("B", s, 1010);
    assert.equal(e.has("B"), true, "kept: an old scene matched by chance");
  });

  test("after the acknowledgement, the next scene asked for drops the override and the server's value shows", () => {
    const e = mk();
    t = 1000;
    e.set("B", "R", { height: 80 }, [], 5);
    t = 1200;
    assert.deepEqual(e.ack("R", 5, true), ["B"]);
    assert.equal(e.pending("B"), false);
    // A scene requested before the answer still gets the override.
    const early = scene();
    assert.equal(e.rebase("B", early, 1100), true);
    // One requested after it is the truth (here the server rounded to 79).
    const s = scene();
    L.findNode(s.root, "R").height = 79;
    assert.equal(e.rebase("B", s, 1300), false);
    assert.equal(L.findNode(s.root, "R").height, 79);
    assert.equal(e.has("B"), false);
  });

  test("an acknowledgement covers that write and earlier ones, not later edits", () => {
    const e = mk();
    t = 1000;
    e.set("B", "R", { height: 80 }, [], 1);
    e.set("B", "R", { width: 70 }, [], 2);
    e.ack("R", 1, true);
    assert.equal(e.pending("B"), true, "width waits for write 2");
  });

  test("a failed write takes its override away; a newer edit of another property stays", () => {
    const e = mk();
    t = 1000;
    e.set("B", "R", { height: 80 }, [], 1);
    e.set("B", "R", { width: 70 }, [], 2);
    e.ack("R", 1, false);
    const s = scene();
    e.apply("B", s);
    assert.equal(L.findNode(s.root, "R").height, 40);
    assert.equal(L.findNode(s.root, "R").width, 70);
  });

  test("previews with no write give up after PREVIEW_MS; unanswered writes after HOLD_MS", () => {
    const e = mk();
    t = 1000;
    e.set("B", "R", { height: 80 }, [], 0);
    e.set("B", "T", { fontSize: 20 }, [], 9);
    t = 1000 + L.PREVIEW_MS + 1;
    assert.deepEqual(e.expire(), ["B"]);
    assert.equal(e.pending("B"), true, "the write still waits");
    t = 1000 + L.HOLD_MS + 1;
    e.expire();
    assert.equal(e.has("B"), false);
  });

  test("commit tags a drag's previews with the write that carries them", () => {
    const e = mk();
    t = 1000;
    e.set("B", "R", { width: 90 }, [], 0);
    e.commit("B", ["R"], 12);
    e.ack("R", 12, true);
    assert.equal(e.pending("B"), false);
  });
});

describe("resize math", () => {
  const r0 = { x: 100, y: 100, w: 200, h: 100 };
  test("keepsRatio: Lock aspect ratio keeps it unless Control; unlocked, Shift keeps it", () => {
    assert.equal(L.keepsRatio(true, {}), true);
    assert.equal(L.keepsRatio(true, { ctrlKey: true }), false);
    assert.equal(L.keepsRatio(true, { shiftKey: true }), true);
    assert.equal(L.keepsRatio(false, {}), false);
    assert.equal(L.keepsRatio(false, { shiftKey: true }), true);
  });
  test("edges and corners move only their sides; whole px", () => {
    assert.deepEqual(L.resizeRect(r0, "e", 20.4, 50), { x: 100, y: 100, w: 220, h: 100 });
    assert.deepEqual(L.resizeRect(r0, "w", 20, 0), { x: 120, y: 100, w: 180, h: 100 });
    assert.deepEqual(L.resizeRect(r0, "n", 0, -30), { x: 100, y: 70, w: 200, h: 130 });
    assert.deepEqual(L.resizeRect(r0, "se", 10, 10), { x: 100, y: 100, w: 210, h: 110 });
    assert.deepEqual(L.resizeRect(r0, "nw", -10, -10), { x: 90, y: 90, w: 210, h: 110 });
  });
  test("past the opposite edge it flips and keeps resizing on the other side", () => {
    assert.deepEqual(L.resizeRect(r0, "w", 500, 0), { x: 300, y: 100, w: 300, h: 100, flipX: true });
    assert.deepEqual(L.resizeRect(r0, "w", 200, 0), { x: 299, y: 100, w: 1, h: 100 }, "never below the minimum");
  });
  test("Shift keeps the ratio on corners and edges", () => {
    const c = L.resizeRect(r0, "se", 100, 0, { shift: true });
    assert.deepEqual(c, { x: 100, y: 100, w: 300, h: 150 });
    const e = L.resizeRect(r0, "s", 0, 100, { shift: true });
    assert.equal(e.w / e.h, 2);
    assert.equal(e.x + e.w / 2, 200, "an edge with Shift grows about the middle");
  });
  test("Option resizes from the centre", () => {
    assert.deepEqual(L.resizeRect(r0, "e", 10, 0, { alt: true }), { x: 90, y: 100, w: 220, h: 100 });
    assert.deepEqual(L.resizeRect(r0, "nw", -5, -5, { alt: true }), { x: 95, y: 95, w: 210, h: 110 });
  });
  test("a moving edge snaps to guides within the screen threshold", () => {
    const idx = S.snapIndex([{ x: 0, y: 0, w: 333, h: 50 }]);
    const snap = L.edgeSnapper(idx, 1);
    assert.deepEqual(L.resizeRect(r0, "e", 30, 0, { snap }), { x: 100, y: 100, w: 233, h: 100 });
    assert.deepEqual(L.resizeRect(r0, "e", 20, 0, { snap }), { x: 100, y: 100, w: 220, h: 100 }, "too far: no snap");
  });
  test("handles: corners, edges inside and outside, nothing in the middle", () => {
    const s = { x: 0, y: 0, w: 200, h: 100 };
    assert.equal(L.handleAt(s, 200, 50), "e");
    assert.equal(L.handleAt(s, 203, 50), "e");
    assert.equal(L.handleAt(s, -3, 50), "w");
    assert.equal(L.handleAt(s, 100, 0), "n");
    assert.equal(L.handleAt(s, 100, 102), "s");
    assert.equal(L.handleAt(s, 1, 1), "nw");
    assert.equal(L.handleAt(s, 199, 99), "se");
    assert.equal(L.handleAt(s, 100, 50), null);
    assert.equal(L.handleAt(s, 300, 50), null);
    assert.equal(L.CURSOR.ne, "nesw-resize");
  });
  test("fit to content: all sides or one; the children stay where they are on the canvas", () => {
    const frame = { x: 0, y: 0, w: 400, h: 300 };
    const c = L.boundsOf([{ x: 20, y: 30, w: 50, h: 40 }, { x: 100, y: 10, w: 10, h: 10 }]);
    assert.deepEqual(c, { x: 20, y: 10, w: 90, h: 60 });
    assert.deepEqual(L.fitRect(frame, c), { x: 20, y: 10, w: 90, h: 60 });
    assert.deepEqual(L.fitRect(frame, c, "e"), { x: 0, y: 0, w: 110, h: 300 });
    const w = L.resizeWrites(frame, L.fitRect(frame, c), { positioned: true, own: { x: 0, y: 0 }, keepChildren: true, kids: [{ id: "a", x: 20, y: 30 }, { id: "b", x: 100, y: 10 }] });
    assert.deepEqual(w.props, { width: 90, height: 60, x: 20, y: 10 });
    assert.deepEqual(w.children, [{ id: "a", x: 0, y: 20 }, { id: "b", x: 80, y: 0 }]);
  });
  test("an auto-layout child takes no x/y; children move with the left edge unless kept", () => {
    const w = L.resizeWrites(r0, { x: 90, y: 100, w: 210, h: 100 }, { positioned: false, kids: [{ id: "a", x: 0, y: 0 }] });
    assert.deepEqual(w, { props: { width: 210 }, children: [] });
  });
});

describe("text resize growth (QA item 4)", () => {
  // An auto-width text 22.6 px tall: pixel rounding makes the dragged box 23 px tall on a right-edge drag.
  const r0 = { x: 10, y: 10.4, w: 80, h: 22.6 };
  const right = { x: 10, y: 10, w: 140, h: 23 };
  test("a side drag of auto-width text gives Fixed size at the height it had", () => {
    const w = L.textResizeWrites(L.resizeWrites(r0, right, { positioned: true, own: { x: 10, y: 10.4 } }), "e", "auto", right, r0);
    assert.deepEqual(w.props, { width: 140, height: 22.6, textGrowth: "fixed-width-height" });
    const none = L.textResizeWrites(L.resizeWrites(r0, right, { positioned: true }), "w", undefined, right, r0);
    assert.equal(none.props.textGrowth, "fixed-width-height");
    assert.equal(none.props.height, 22.6);
  });
  test("a side drag keeps Auto height and Fixed size as they are", () => {
    for (const g of ["fixed-width", "fixed-width-height"]) {
      const w = L.textResizeWrites({ props: { width: 140, height: 23 }, children: [] }, "e", g, right, r0);
      assert.deepEqual(w.props, { width: 140 }, g);
    }
  });
  test("top, bottom or a corner gives Fixed size with both sides", () => {
    const down = { x: 10, y: 10, w: 80, h: 60 };
    assert.deepEqual(L.textResizeWrites({ props: { height: 60 }, children: [] }, "s", "auto", down).props, { height: 60, textGrowth: "fixed-width-height", width: 80 });
    assert.deepEqual(L.textResizeWrites({ props: { width: 90, height: 60 }, children: [] }, "se", "fixed-width", down).props, { width: 90, height: 60, textGrowth: "fixed-width-height" });
    assert.deepEqual(L.textResizeWrites({ props: { height: 60 }, children: [] }, "n", "fixed-width-height", down).props, { height: 60, width: 80 });
  });
  test("nothing resized writes nothing", () => {
    assert.deepEqual(L.textResizeWrites({ props: {}, children: [] }, "e", "auto", right).props, {});
  });
});
