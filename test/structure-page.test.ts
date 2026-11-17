// The page half of structure editing (src/page/structure.js): which key does what, the shared props of several
// layers, reading the clipboard, the marquee rectangle and where a paste lands.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-expect-error a plain browser module without types
import { clipFromEvent, clipHtml, clipText, codeOf, keyAction, marqueeRect, MARKER, pastePlace, readClip, sharedProps, unionOf } from "../src/page/structure.js";

const key = (o: Record<string, unknown>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", code: "", ...o });

describe("keys", () => {
  test("the structure keys", () => {
    assert.deepEqual(keyAction(key({ key: "Backspace" })), { op: "delete" });
    assert.deepEqual(keyAction(key({ key: "Delete" })), { op: "delete" });
    assert.equal(keyAction(key({ key: "Backspace", metaKey: true })), null);
    assert.equal(keyAction(key({ metaKey: true, code: "KeyD" })).op, "duplicate");
    assert.equal(keyAction(key({ metaKey: true, code: "KeyG" })).op, "group");
    assert.equal(keyAction(key({ metaKey: true, altKey: true, code: "KeyG", key: "©" })).op, "frame");
    assert.equal(keyAction(key({ metaKey: true, shiftKey: true, code: "KeyG" })).op, "ungroup");
    assert.deepEqual(keyAction(key({ metaKey: true, code: "BracketRight" })), { op: "reorder", dir: "forward", menu: true });
    assert.equal(keyAction(key({ metaKey: true, altKey: true, code: "BracketRight" })).dir, "front");
    assert.equal(keyAction(key({ metaKey: true, code: "BracketLeft" })).dir, "backward");
    assert.equal(keyAction(key({ metaKey: true, altKey: true, code: "BracketLeft" })).dir, "back");
    assert.deepEqual(keyAction(key({ key: "Enter" })), { op: "children" });
    assert.deepEqual(keyAction(key({ key: "Enter", shiftKey: true })), { op: "parent" });
    assert.equal(keyAction(key({ metaKey: true, code: "KeyA" })).op, "selectAll");
    assert.equal(keyAction(key({ key: "d" })), null);
    assert.equal(keyAction(key({ metaKey: true, code: "KeyZ" })), null);
  });
  test("an event without code falls back to its key", () => {
    assert.equal(codeOf(key({ key: "d" })), "KeyD");
    assert.equal(codeOf(key({ key: "]" })), "BracketRight");
    assert.equal(codeOf(key({ key: "Enter" })), "");
    assert.equal(keyAction(key({ metaKey: true, key: "g" })).op, "group");
  });
});

describe("helpers", () => {
  test("shared props keep only equal values", () => {
    assert.deepEqual(sharedProps([{ id: "a", type: "text", fill: "#000", x: 1 }, { id: "b", type: "text", fill: "#000", x: 2 }]), { type: "text", fill: "#000" });
    assert.deepEqual(sharedProps([]), {});
  });
  test("clipboard text: payload, marker, or nothing", () => {
    assert.deepEqual(readClip(MARKER + "123"), { fromServer: true });
    const p = { kind: "canvas/nodes", v: 1, nodes: [{ id: "a" }], detached: [{ id: "a" }] };
    assert.deepEqual(readClip(JSON.stringify(p)), { payload: p });
    assert.equal(readClip("hello"), null);
    assert.equal(readClip("{not json"), null);
    assert.equal(readClip(""), null);
  });
  test("marquee and union rects", () => {
    assert.deepEqual(marqueeRect({ x: 30, y: 40 }, { x: 10, y: 0 }, { x: 10, y: 0, z: 2 }), { x: 0, y: 0, w: 10, h: 20 });
    assert.deepEqual(unionOf([{ x: 0, y: 0, w: 10, h: 10 }, null, { x: 20, y: 5, w: 10, h: 10 }]), { x: 0, y: 0, w: 30, h: 15 });
    assert.equal(unionOf([]), null);
  });
});

describe("where a paste lands", () => {
  const payload = (o: Record<string, unknown> = {}) => ({ kind: "canvas/nodes", v: 1, nodes: [{ id: "R1", x: 10, y: 20 }], detached: [{ id: "R1" }], rects: [{ x: 110, y: 220, w: 50, h: 50 }], parents: ["B1"], ...o });
  test("into a selected frame; back into its own parent lands in place", () => {
    const frame = { id: "B1", isContainer: true, placesChildren: false, parentId: null, parentPlaces: false, index: 0, rect: { x: 100, y: 200, w: 400, h: 400 }, parentRect: null };
    assert.deepEqual(pastePlace({ target: frame, payload: payload(), exists: () => true }), { parent: "B1", index: undefined, positions: [{ x: 10, y: 20 }] });
    // Cut (the original is gone): it keeps its own x/y.
    assert.deepEqual(pastePlace({ target: frame, payload: payload(), exists: () => false }).positions, [null]);
    // In place: the same spot on the canvas, in the frame's coordinates.
    assert.deepEqual(pastePlace({ target: { ...frame, rect: { x: 0, y: 0, w: 1, h: 1 } }, payload: payload(), inPlace: true }).positions, [{ x: 110, y: 220 }]);
  });
  test("a leaf selected: after it, in its parent; auto layout gets no positions", () => {
    const leaf = { id: "T1", isContainer: false, placesChildren: false, parentId: "B2", parentPlaces: true, index: 3, rect: null, parentRect: null };
    assert.deepEqual(pastePlace({ target: leaf, payload: payload() }), { parent: "B2", index: 4, positions: [null] });
  });
  test("Paste here (sweep S2): the copied layers' top-left lands on the pointer, into the frame under it", () => {
    const two = { kind: "canvas/nodes", nodes: [{ id: "A" }, { id: "B" }], rects: [{ x: 100, y: 100, w: 50, h: 50 }, { x: 200, y: 160, w: 20, h: 20 }] };
    // On the canvas: world coordinates, the group's shape kept.
    assert.deepEqual(pastePlace({ target: null, payload: two, at: { x: 1000, y: 500 } }),
      { parent: null, index: undefined, positions: [{ x: 1000, y: 500 }, { x: 1100, y: 560 }] });
    // Into a free frame under the pointer: relative to the frame.
    const frame = { id: "F", isContainer: true, placesChildren: false, rect: { x: 900, y: 400, w: 600, h: 400 } };
    assert.deepEqual(pastePlace({ target: frame, payload: two, at: { x: 1000, y: 500 } }).positions, [{ x: 100, y: 100 }, { x: 200, y: 160 }]);
    assert.equal(pastePlace({ target: frame, payload: two, at: { x: 1000, y: 500 } }).parent, "F");
    // Auto layout places them itself.
    assert.deepEqual(pastePlace({ target: { ...frame, placesChildren: true }, payload: two, at: { x: 1000, y: 500 } }).positions, [null, null]);
    // Never into a layer that is itself being pasted.
    assert.equal(pastePlace({ target: { ...frame, id: "A" }, payload: two, at: { x: 1, y: 2 } }).parent, null);
  });
  test("the copied frame itself selected: next to it, not inside it", () => {
    const self = { id: "R1", isContainer: true, placesChildren: false, parentId: "B1", parentPlaces: false, index: 0, rect: null, parentRect: { x: 100, y: 200, w: 1, h: 1 } };
    assert.deepEqual(pastePlace({ target: self, payload: payload(), exists: () => true }), { parent: "B1", index: 1, positions: [{ x: 10, y: 20 }] });
  });
  test("nothing selected: a board lands right of the original, clear of other boards; in place when cut", () => {
    const board = payload({ nodes: [{ id: "B1", x: 0, y: 0 }], rects: [{ x: 0, y: 0, w: 100, h: 100 }], parents: [null] });
    assert.deepEqual(pastePlace({ target: null, payload: board, exists: () => true }).positions, [{ x: 140, y: 0 }]);
    assert.deepEqual(pastePlace({ target: null, payload: board, exists: () => true, boards: [{ x: 150, y: 0, w: 50, h: 50 }] }).positions, [{ x: 280, y: 0 }]);
    assert.deepEqual(pastePlace({ target: null, payload: board, exists: () => false }).positions, [{ x: 0, y: 0 }]);
    // Another page (the original is not here): the same spot when it is free, next to it when a board is there.
    assert.deepEqual(pastePlace({ target: null, payload: board, exists: () => false, boards: [{ x: 50, y: 50, w: 50, h: 50 }] }).positions, [{ x: 140, y: 0 }]);
  });
});

describe("cards on the clipboard", () => {
  const card = (o: Record<string, unknown> = {}) => ({ id: "w1", kind: "note", name: "Memo", x: 500, y: 0, w: 200, h: 100, config: {}, ...o });
  const only = (o: Record<string, unknown> = {}) => ({ kind: "canvas/nodes", v: 1, nodes: [], detached: [], cards: [card()], ...o });
  test("cards alone: where they were when free, else to the right of everything they would cover", () => {
    assert.deepEqual(pastePlace({ target: null, payload: only() }).cards, [{ x: 500, y: 0 }]);
    assert.deepEqual(pastePlace({ target: null, payload: only(), exists: (id: string) => id === "widget:w1" }).cards, [{ x: 740, y: 0 }], "the original is still there");
    assert.deepEqual(pastePlace({ target: null, payload: only(), cards: [{ x: 600, y: 50, w: 10, h: 10 }] }).cards, [{ x: 740, y: 0 }], "another card is there");
    assert.deepEqual(pastePlace({ target: null, payload: only(), inPlace: true, exists: () => true }).cards, [{ x: 500, y: 0 }]);
  });
  test("cards never go into a frame: a selected frame takes the layers, the cards stay on the canvas", () => {
    const frame = { id: "F", isContainer: true, placesChildren: false, rect: { x: 0, y: 0, w: 400, h: 400 } };
    const p = only({ nodes: [{ id: "R", x: 10, y: 10 }], detached: [{ id: "R" }], rects: [{ x: 10, y: 10, w: 20, h: 20 }], parents: ["F"] });
    const place = pastePlace({ target: frame, payload: p });
    assert.equal(place.parent, "F");
    assert.deepEqual(place.cards, [{ x: 500, y: 0 }]);
    assert.equal("shift" in place, false, "nothing extra goes to the server");
  });
  test("boards and cards pasted together move by the same step; Paste here keeps their arrangement", () => {
    const p = only({ nodes: [{ id: "B", x: 0, y: 0 }], detached: [{ id: "B" }], rects: [{ x: 0, y: 0, w: 400, h: 300 }], parents: [null] });
    const place = pastePlace({ target: null, payload: p, exists: () => true });
    assert.deepEqual(place.positions, [{ x: 740, y: 0 }]);
    assert.deepEqual(place.cards, [{ x: 1240, y: 0 }]);
    const here = pastePlace({ target: null, payload: p, at: { x: 1000, y: 1000 } });
    assert.deepEqual(here.positions, [{ x: 1000, y: 1000 }]);
    assert.deepEqual(here.cards, [{ x: 1500, y: 1000 }]);
  });
  test("another app gets the names, never the JSON; Canvas finds its marker in the HTML part", () => {
    assert.equal(clipText(["Board one", " Hero\ntitle ", "", "Memo"]), "Board one\nHero title\nMemo");
    assert.equal(clipText(Array.from({ length: 60 }, (_, i) => "L" + i)).split("\n").at(-1), "10 more");
    const html = clipHtml("A <b>\nB");
    assert.match(html, /data-canvas-clipboard/);
    assert.match(html, /A &lt;b&gt;<br>B/);
    assert.equal(clipFromEvent(html, "A <b>\nB"), MARKER);
    assert.equal(clipFromEvent("<p>hi</p>", "hi"), "hi");
    assert.deepEqual(readClip(clipFromEvent(html, "")), { fromServer: true });
  });
});
