// Layer lock and the selection niceties around the Layers panel: `locked` in the file format (schema, the
// outline's `l` flag, the undo label), the lock toggle's rule, Select matching layers (same name in the other boards),
// Select All with the same stroke or effect, Select inverse, and the keys that ask for them.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { snapshotOfDoc } from "../src/boards.ts";
import type { CanvasDoc } from "../src/engine.ts";
import { validateNode } from "../src/doc/schema.ts";
import { outlineOf } from "../src/layers.ts";
import { nodeLabel } from "../src/history.ts";
import { matchActions } from "../src/search.ts";
// @ts-ignore: plain ES modules the page imports too
import * as S from "../src/page/shortcuts-logic.js";
// @ts-ignore
import { keyAction } from "../src/page/structure.js";
// @ts-ignore
import { BIG, STEP, boxRect, clampTo, kbKey } from "../src/page/keybox.js";

describe("locked in the file format", () => {
  test("the schema takes locked as a boolean on any layer", () => {
    assert.deepEqual(validateNode({ type: "rectangle", id: "r", locked: true } as any, { keys: ["locked"] }), []);
    assert.deepEqual(validateNode({ type: "group", id: "g", locked: true } as any, { keys: ["locked"] }), []);
    assert.ok(validateNode({ type: "frame", id: "f", locked: "yes" } as any, { keys: ["locked"] }).length > 0, "not a boolean");
  });
  test("the Layers outline flags a locked layer with l", () => {
    const o = outlineOf({ type: "frame", id: "f", locked: true, children: [{ type: "rectangle", id: "r" }] } as any);
    assert.equal(o.l, 1);
    assert.equal(o.c![0].l, undefined, "a child keeps its own flag; the panel works out that its parent locks it");
  });
  test("undo names the step Lock Change", () => {
    assert.equal(nodeLabel(["locked"]), "Lock Change");
  });
});

describe("Shift+Cmd+L", () => {
  test("locks the selection unless every layer in it is locked", () => {
    assert.equal(S.lockAll([{ locked: true }, {}]), true);
    assert.equal(S.lockAll([{ locked: true }]), false);
    assert.equal(S.lockAll([]), false);
  });
});

describe("selection keys", () => {
  test("backslash selects the parent, like Shift+Enter", () => {
    const k = (key: string, mods = {}) => keyAction({ key, code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
    assert.deepEqual(k("\\"), { op: "parent" });
    assert.equal(k("\\", { metaKey: true }), null, "Cmd+\\ hides the panels");
  });
  test("the page keys for lock, select inverse, select matching and collapse all", () => {
    const k = (code: string, mods = {}) => S.layerKey({ code, key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
    assert.equal(k("KeyL", { metaKey: true, shiftKey: true }), "lock");
    assert.equal(k("KeyA", { metaKey: true, shiftKey: true }), "selectInverse");
    assert.equal(k("KeyA", { metaKey: true, altKey: true }), "selectMatching");
    assert.equal(k("KeyL", { altKey: true }), "collapseLayers");
    assert.equal(k("KeyL", { metaKey: true }), null, "Cmd+L copies a link");
    assert.equal(k("KeyL", { metaKey: true, altKey: true }), null, "Option+Cmd+L aligns text left");
    assert.equal(k("KeyA", { metaKey: true }), null, "Cmd+A selects all");
  });
  test("select inverse: the same scope as Select All, without the selection", () => {
    assert.deepEqual(S.inverseOf(["a", "b", "c", "d"], ["b", "d"]), ["a", "c"]);
    assert.deepEqual(S.inverseOf(["a", "b"], ["a", "b"]), []);
  });
});

const doc = {
  version: "2.21",
  children: [
    { type: "frame", id: "A", name: "Home", x: 0, y: 0, width: 300, height: 600, children: [
      { type: "text", id: "A1", name: "Title", content: "Home", fontFamily: "Inter", fontSize: 24 },
      { type: "rectangle", id: "A2", name: "Card", fill: "#FFFFFF", stroke: { type: "color", color: "#E5E5E5" }, strokeWidth: 1, effect: [{ type: "shadow", color: "#00000022", offset: { x: 0, y: 2 }, blur: 8 }] },
    ] },
    { type: "frame", id: "B", name: "Settings", x: 400, y: 0, width: 300, height: 600, children: [
      { type: "text", id: "B1", name: "Title", content: "Settings", fontFamily: "Inter", fontSize: 24 },
      { type: "rectangle", id: "B2", name: "Card", fill: "#000000", stroke: "#e5e5e5", strokeWidth: 1, effect: [{ type: "shadow", color: "#00000022", offset: { x: 0, y: 2 }, blur: 8 }] },
      { type: "text", id: "B3", name: "Title", content: "Again", fontFamily: "Inter", fontSize: 12, locked: true },
      { type: "frame", id: "Lk", name: "Locked box", locked: true, children: [{ type: "text", id: "B4", name: "Title", content: "Inside", fontFamily: "Inter", fontSize: 12 }] },
    ] },
    { type: "frame", id: "C", name: "Profile", x: 800, y: 0, width: 300, height: 600, children: [
      { type: "rectangle", id: "C1", name: "Title", fill: "#FF0000" },
      { type: "ellipse", id: "C2", name: "Avatar", stroke: "#E5E5E5" },
    ] },
  ],
} as unknown as CanvasDoc;
const snap = snapshotOfDoc("/nowhere/lock.canvas.json", doc, "r1");
const action = (ids: string[], key: string) => matchActions(snap, ids, "page-1").actions.find((a) => a.key === key);

describe("Select matching layers (Option+Cmd+A)", () => {
  test("same name and kind in the other boards, the selected layer included; locked layers stay out", () => {
    const a = action(["A1"], "matching");
    assert.ok(a, "the action is offered");
    assert.deepEqual(a!.ids.sort(), ["A1", "B1"], "C1 is a rectangle, B3 and B4 are locked");
  });
  test("nothing matches in another board: no action", () => {
    assert.equal(action(["C2"], "matching"), undefined);
  });
  test("a board itself has no matching layers", () => {
    assert.equal(action(["A"], "matching"), undefined);
  });
});

describe("Select All with the same stroke or effect", () => {
  test("stroke: the same paint, however it is written", () => {
    assert.deepEqual(action(["A2"], "stroke")!.ids.sort(), ["A2", "B2", "C2"]);
  });
  test("effect: the same effects", () => {
    assert.deepEqual(action(["A2"], "effect")!.ids.sort(), ["A2", "B2"]);
  });
  test("locked layers are left out of the other matches too", () => {
    assert.ok(!action(["A1"], "font")!.ids.includes("B3"));
  });
});

describe("keyboard selection (Option+Space)", () => {
  const ev = (key: string, code = "", mods = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  test("Option+Space puts the cursor out and away; its keys only count while it is out", () => {
    assert.deepEqual(kbKey(ev(" ", "Space", { altKey: true }), false), { op: "toggle" });
    assert.deepEqual(kbKey(ev(" ", "Space", { altKey: true }), true), { op: "toggle" });
    assert.equal(kbKey(ev(" ", "Space"), false), null, "Space alone is the hand");
    assert.equal(kbKey(ev("ArrowLeft"), false), null, "arrows nudge when the cursor is away");
  });
  test("arrows move it, Shift ten times as far, Command draws a box; Return picks, Esc closes", () => {
    assert.deepEqual(kbKey(ev("ArrowRight"), true), { op: "move", dx: STEP, dy: 0, box: false });
    assert.deepEqual(kbKey(ev("ArrowUp", "", { shiftKey: true }), true), { op: "move", dx: 0, dy: -BIG, box: false });
    assert.deepEqual(kbKey(ev("ArrowDown", "", { metaKey: true }), true), { op: "move", dx: 0, dy: STEP, box: true });
    assert.deepEqual(kbKey(ev("Enter"), true), { op: "pick" });
    assert.deepEqual(kbKey(ev("Escape"), true), { op: "close" });
  });
  test("the box runs between the anchor and the cursor, inside the view", () => {
    assert.deepEqual(boxRect({ x: 50, y: 40 }, { x: 10, y: 90 }), { x: 10, y: 40, w: 40, h: 50 });
    assert.deepEqual(boxRect({ x: 5, y: 5 }, { x: 5, y: 5 }), { x: 5, y: 5, w: 1, h: 1 });
    assert.deepEqual(clampTo({ x: -20, y: 900 }, 800, 600), { x: 4, y: 596 });
  });
});
