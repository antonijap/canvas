// Layout guides (src/page/layout-guides-logic.js): grid, columns and rows on a frame, saved in its metadata, drawn
// over the canvas and snapped to; Control+G / Shift+G show and hide them (src/page/navigate-logic.js); the board
// metas list every frame with guides (src/boards.ts).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boardsOf } from "../src/boards.ts";
import * as LG from "../src/page/layout-guides-logic.js";
import * as N from "../src/page/navigate-logic.js";
// @ts-ignore: a plain ES module the page imports too
import { keyAction } from "../src/page/structure.js";

const key = (o: Record<string, unknown>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", code: "", ...o });

describe("layout guides", () => {
  test("Control+G and Shift+G toggle them; Cmd+G stays Group and Control+G is no longer Group", () => {
    assert.deepEqual(N.navKey(key({ ctrlKey: true, key: "g", code: "KeyG" })), { op: "layoutGuides" });
    assert.deepEqual(N.navKey(key({ shiftKey: true, key: "G", code: "KeyG" })), { op: "layoutGuides" });
    assert.equal(N.navKey(key({ metaKey: true, key: "g", code: "KeyG" })), null);
    assert.equal(N.navKey(key({ metaKey: true, shiftKey: true, key: "g", code: "KeyG" })), null, "Shift+Cmd+G stays Ungroup");
    assert.equal(keyAction(key({ ctrlKey: true, key: "g", code: "KeyG" }) as never), null);
    assert.equal((keyAction(key({ metaKey: true, key: "g", code: "KeyG" }) as never) as { op: string } | null)?.op, "group");
  });

  test("defaults: a 10 px grid, five stretched columns with a 20 px gutter, red at 10%", () => {
    assert.deepEqual(LG.defaultGuide(), { type: "grid", size: 10, color: "#FF00001A" });
    assert.deepEqual(LG.defaultGuide("columns"), { type: "columns", count: 5, align: "stretch", gutter: 20, margin: 0, color: "#FF00001A" });
  });

  test("stretch columns share the width left after margins and gutters", () => {
    const g = LG.cleanGuide({ type: "columns", count: 4, align: "stretch", gutter: 20, margin: 40, color: "#FF00001A" })!;
    // 1000 - 80 margins - 60 gutters = 860 / 4 = 215
    assert.deepEqual(LG.bands(g, 1000), [{ a: 40, b: 255 }, { a: 275, b: 490 }, { a: 510, b: 725 }, { a: 745, b: 960 }]);
  });

  test("fixed columns sit at the start, end or centre, offset from their edge", () => {
    const base = { type: "columns", count: 2, gutter: 10, width: 100, offset: 20, color: "#FF00001A" };
    assert.deepEqual(LG.bands(LG.cleanGuide({ ...base, align: "start" })!, 500), [{ a: 20, b: 120 }, { a: 130, b: 230 }]);
    assert.deepEqual(LG.bands(LG.cleanGuide({ ...base, align: "end" })!, 500), [{ a: 270, b: 370 }, { a: 380, b: 480 }]);
    assert.deepEqual(LG.bands(LG.cleanGuide({ ...base, align: "center" })!, 500), [{ a: 145, b: 245 }, { a: 255, b: 355 }]);
  });

  test("rows run down the frame; a grid draws lines every `size` px inside it", () => {
    const rows = LG.shapes(LG.cleanGuide({ type: "rows", count: 2, align: "stretch", gutter: 0, margin: 0 })!, 300, 200);
    assert.deepEqual(rows.rects, [{ x: 0, y: 0, w: 300, h: 100 }, { x: 0, y: 100, w: 300, h: 100 }]);
    const grid = LG.shapes(LG.cleanGuide({ type: "grid", size: 50 })!, 120, 100);
    assert.deepEqual(grid.lines, [{ axis: "x", at: 50 }, { axis: "x", at: 100 }, { axis: "y", at: 50 }]);
  });

  test("snap lines are the column edges in world px; hidden guides give none", () => {
    const g = LG.cleanGuide({ type: "columns", count: 2, align: "stretch", gutter: 20, margin: 10 })!;
    const r = LG.snapRects({ x: 100, y: 50, w: 230, h: 400 }, [g]);
    assert.deepEqual(r.map((x) => x.x), [110, 205, 225, 320]);
    assert.ok(r.every((x) => x.w === 0 && x.y === 50 && x.h === 400));
    assert.deepEqual(LG.snapRects({ x: 0, y: 0, w: 100, h: 100 }, [{ ...g, visible: false }]), []);
  });

  test("saved in metadata next to other keys; bad entries are dropped; none left removes the key", () => {
    const m = LG.withLayoutGuides({ type: "canvas", canvasGuides: [{ axis: "x", at: 4 }] }, [LG.defaultGuide(), { type: "nope" }]);
    assert.deepEqual(m, { type: "canvas", canvasGuides: [{ axis: "x", at: 4 }], canvasLayoutGuides: [{ type: "grid", size: 10, color: "#FF00001A" }] });
    assert.equal(LG.withLayoutGuides({ type: "canvas", canvasLayoutGuides: [LG.defaultGuide()] }, []), null);
    assert.deepEqual(LG.guidesOf({ canvasLayoutGuides: [{ type: "rows", count: "x", gutter: -5, color: "red" }] }), [{ type: "rows", count: 5, align: "stretch", gutter: 0, margin: 0, color: "#FF00001A" }]);
    assert.equal(LG.cssColor("#FF00001A"), "rgba(255,0,0,0.102)");
  });

  test("board metas list the frames with guides, the board's own and nested ones", () => {
    const doc = {
      version: "2.6",
      children: [
        { type: "frame", id: "B", x: 0, y: 0, width: 400, height: 300, metadata: { type: "canvas", canvasLayoutGuides: [{ type: "grid", size: 8 }] }, children: [
          { type: "frame", id: "C", x: 10, y: 10, width: 100, height: 100, metadata: { type: "canvas", canvasLayoutGuides: [{ type: "columns", count: 3 }] } },
          { type: "rectangle", id: "R", x: 0, y: 0, width: 10, height: 10 },
        ] },
        { type: "frame", id: "D", x: 500, y: 0, width: 10, height: 10 },
      ],
    } as never;
    const metas = boardsOf(doc);
    assert.deepEqual(metas[0].layoutGuides?.map((f) => [f.id, f.guides[0].type]), [["B", "grid"], ["C", "columns"]]);
    assert.equal(metas[1].layoutGuides, undefined);
  });
});
