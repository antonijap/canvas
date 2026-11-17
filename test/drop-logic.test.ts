// Drops on the canvas, the pure part (src/page/drop-logic.js): which layer a Cmd-drop fills, the fill list it gets,
// and where a plain image drop puts its layers.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a browser module without types
import { cardFill, centredAt, dropParent, fillTarget, flowIndex, imageFill, imageLayerSize, isImageFile, shaderFill, sideBySide, swapTarget, tileTarget, withFill } from "../src/page/drop-logic.js";

const types: Record<string, string> = { B: "frame", card: "frame", label: "text", icon: "icon", g: "group", r: "rectangle", e: "ellipse", "I": "frame", "I/bg": "rectangle", "I/t": "text" };
const typeOf = (id: string) => types[id] ?? null;

describe("tileTarget (a shader tile from the Widgets panel)", () => {
  test("a plain drop fills the layer under the pointer, no Cmd needed", () => {
    assert.equal(tileTarget(["B", "card", "r"], typeOf, null), "r");
    assert.equal(tileTarget(["B", "card", "label"], typeOf, null), "card");
    assert.equal(tileTarget(["B"], typeOf, null), "B");
  });
  test("over empty canvas, or with Option held, it is a card", () => {
    assert.equal(tileTarget([], typeOf, null), null);
    assert.equal(tileTarget(["B", "card", "r"], typeOf, null, true), null);
  });
});

describe("fillTarget (the layer a Cmd-drop fills)", () => {
  test("the deepest fillable layer under the pointer; text and icons pass it to the layer around them", () => {
    assert.equal(fillTarget(["B", "card", "r"], typeOf, null), "r");
    assert.equal(fillTarget(["B", "card", "label"], typeOf, null), "card");
    assert.equal(fillTarget(["B", "card", "g", "icon"], typeOf, null), "card");
    assert.equal(fillTarget(["B", "e"], typeOf, null), "e");
    assert.equal(fillTarget(["B"], typeOf, null), "B", "a board's background fills the board");
  });
  test("the selected layer takes it when the pointer is over it, even over a child", () => {
    assert.equal(fillTarget(["B", "card", "r"], typeOf, "card"), "card");
    assert.equal(fillTarget(["B", "card", "r"], typeOf, "e"), "r", "a selection elsewhere changes nothing");
    assert.equal(fillTarget(["B", "card", "label"], typeOf, "label"), "card", "a selected text is not fillable");
  });
  test("inside an instance: the layer as drawn (its path id), an override", () => {
    assert.equal(fillTarget(["B", "I", "I/t"], typeOf, null), "I");
    assert.equal(fillTarget(["B", "I", "I/bg"], typeOf, null), "I/bg");
  });
  test("empty canvas: nothing", () => {
    assert.equal(fillTarget([], typeOf, null), null);
    assert.equal(fillTarget(["g", "icon"], typeOf, null), null);
  });
});

describe("withFill", () => {
  const sh = shaderFill("mesh-gradient");
  test("goes on top; colours stay underneath", () => {
    assert.deepEqual(withFill(undefined, sh), [sh]);
    assert.deepEqual(withFill("#FF0000", sh), ["#FF0000", sh]);
    assert.deepEqual(withFill([{ type: "color", color: "#000000" }, "$brand"], sh), [{ type: "color", color: "#000000" }, "$brand", sh]);
  });
  test("a fill of the same kind is replaced, another kind stays", () => {
    const old = { type: "shader", shader: "dot-grid", preset: "Default" };
    assert.deepEqual(withFill(["#FFFFFF", old], sh), ["#FFFFFF", sh]);
    const img = imageFill("media/a-1.png");
    assert.deepEqual(withFill(["#FFFFFF", old], img), ["#FFFFFF", old, img]);
    assert.deepEqual(withFill([imageFill("media/old.png"), "#FFFFFF"], img), ["#FFFFFF", img]);
  });
  test("a tile's fill names the shader and its default preset; a variant when given", () => {
    assert.deepEqual(shaderFill("mesh-gradient"), { type: "shader", shader: "mesh-gradient", preset: "Default" });
    assert.deepEqual(shaderFill("mesh-gradient/Ink"), { type: "shader", shader: "mesh-gradient", preset: "Ink" });
    assert.deepEqual(imageFill("media/x.png"), { type: "image", url: "media/x.png", mode: "fill" });
  });
});

describe("image layers from a plain drop", () => {
  test("their own size, the long side at most 4096", () => {
    assert.deepEqual(imageLayerSize(400, 300), { w: 400, h: 300 });
    assert.deepEqual(imageLayerSize(3200, 2000), { w: 3200, h: 2000 });
    assert.deepEqual(imageLayerSize(8192, 2048), { w: 4096, h: 1024 });
  });
  test("side by side, 20 apart, the row centred under the pointer", () => {
    assert.deepEqual(sideBySide([{ w: 100, h: 50 }], { x: 500, y: 500 }), [{ x: 450, y: 475, w: 100, h: 50 }]);
    assert.deepEqual(sideBySide([{ w: 100, h: 100 }, { w: 60, h: 40 }], { x: 0, y: 0 }), [{ x: -90, y: -50, w: 100, h: 100 }, { x: 30, y: -50, w: 60, h: 40 }]);
  });
  test("into the deepest stored frame under the pointer, never into an instance", () => {
    const info = (id: string) => ({ B: { type: "frame", instance: false }, card: { type: "frame", instance: false }, I: { type: "frame", instance: true }, r: { type: "rectangle", instance: false } } as any)[id] ?? null;
    assert.equal(dropParent(["B", "card", "r"], info), "card");
    assert.equal(dropParent(["B", "I", "I/bg"], info), "B");
    assert.equal(dropParent([], info), null);
  });
  test("image files by type or name", () => {
    assert.ok(isImageFile({ type: "image/png", name: "a.png" }));
    assert.ok(isImageFile({ type: "", name: "Photo.JPEG" }));
    assert.ok(!isImageFile({ type: "application/pdf", name: "a.pdf" }));
  });
});

describe("cardFill (a shader card Cmd-dragged onto a layer)", () => {
  test("a Paper preset card: its shader, preset and params", () => {
    assert.deepEqual(cardFill({ rev: "abc", autoplay: true, paper: { shader: "mesh-gradient", preset: "Ink", params: { speed: 0.5 } } }, null), { type: "shader", shader: "mesh-gradient", preset: "Ink", params: { speed: 0.5 } });
    assert.deepEqual(cardFill({ paper: { shader: "dot-grid", preset: "", params: {} } }, "fn shade(...)"), { type: "shader", shader: "dot-grid", preset: "Default" }, "no params, no preset: the default; the source is not needed");
  });
  test("a hand-written card: its WGSL source and uniforms; a still card stays still", () => {
    const src = "fn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.0); }";
    assert.deepEqual(cardFill({ rev: "abc", autoplay: true }, src), { type: "shader", source: src });
    assert.deepEqual(cardFill({ autoplay: false, uniforms: [0.5, 1] }, src), { type: "shader", source: src, uniforms: [0.5, 1], autoplay: false });
  });
  test("nothing to fill with: no preset and no source", () => {
    assert.equal(cardFill({ rev: "" }, null), null);
    assert.equal(cardFill({}, ""), null);
    assert.equal(cardFill(null, null), null);
  });
});

describe("a component dragged from the Components panel", () => {
  const info = (id: string) => ({
    B: { type: "frame", instance: false }, I: { type: "frame", instance: true }, "I/N": { type: "frame", instance: true }, "I/N/t": { type: "text", instance: false },
    "I/bg": { type: "rectangle", instance: false }, r: { type: "rectangle", instance: false },
  } as any)[id] ?? null;
  test("Option over an instance swaps it: the deepest instance under the pointer, a nested one too", () => {
    assert.equal(swapTarget(["B", "I", "I/bg"], info), "I");
    assert.equal(swapTarget(["B", "I", "I/N", "I/N/t"], info), "I/N");
    assert.equal(swapTarget(["B", "r"], info), null, "no instance: no swap");
    assert.equal(swapTarget([], info), null);
  });
  test("the instance's middle lands under the pointer, on whole pixels", () => {
    assert.deepEqual(centredAt({ x: 500, y: 300 }, { w: 120, h: 41 }), { x: 440, y: 280 });
    assert.deepEqual(centredAt({ x: 10.4, y: 0 }, null), { x: 10, y: 0 }, "no size known: its corner under the pointer");
  });
  test("in an auto layout frame: the flow slot under the pointer, as an index into its children", () => {
    const row = { type: "frame", layout: "horizontal", children: [{ id: "a" }, { id: "abs", layoutPosition: "absolute" }, { id: "b" }, { id: "c" }] };
    const rects: Record<string, { x: number; y: number; w: number; h: number }> = { a: { x: 0, y: 0, w: 100, h: 40 }, b: { x: 110, y: 0, w: 100, h: 40 }, c: { x: 220, y: 0, w: 100, h: 40 }, abs: { x: 0, y: 100, w: 10, h: 10 } };
    const rectOf = (id: string) => rects[id] ?? null;
    assert.equal(flowIndex(row, rectOf, { x: 20, y: 20 }), 0, "before a");
    assert.equal(flowIndex(row, rectOf, { x: 180, y: 20 }), 3, "between b and c: c's place");
    assert.equal(flowIndex(row, rectOf, { x: 400, y: 20 }), 4, "after the last");
    assert.equal(flowIndex({ type: "frame", layout: "vertical", children: [] }, rectOf, { x: 0, y: 0 }), 0, "an empty flow");
    assert.equal(flowIndex({ type: "frame", layout: "none", children: [{ id: "a" }] }, rectOf, { x: 0, y: 0 }), null, "a free frame places by x and y");
    assert.equal(flowIndex(null, rectOf, { x: 0, y: 0 }), null);
  });
});
