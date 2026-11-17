// The document summary, fonts in use, and the board index: pure functions over a parsed document.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { snapshotOf } from "../src/boards.ts";
import { loadDoc } from "../src/engine.ts";
import { fontStatuses } from "../src/fonts.ts";
import { boardIndex, boardOf, fontsUsed, summaryOf } from "../src/summary.ts";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("summary");
after(() => fs.rmSync(dir, { recursive: true, force: true }));
fs.writeFileSync(path.join(dir, "Brand.ttf"), "x");
const doc = {
  version: "2.21",
  fonts: [
    { name: "Brand", url: "Brand.ttf" },
    { name: "Gone", url: "missing.ttf" },
  ],
  variables: { accent: { type: "color", value: "#0766EB" } },
  children: [
    { type: "frame", id: "Cmp01", name: "Button", reusable: true, x: 0, y: 0, width: 100, height: 40, children: [{ type: "text", id: "Lbl01", content: "Go", fontFamily: "Inter", fontSize: 14, fontWeight: "600", fill: "#000000" }] },
    {
      type: "frame", id: "Scr01", name: "Screen", x: 200, y: 0, width: 300, height: 600,
      children: [
        { type: "ref", id: "Ins01", ref: "Cmp01" },
        { type: "text", id: "T1", content: "Hi", fontFamily: "Brand", fontSize: 20, fontWeight: "400", fill: "#000000" },
        { type: "text", id: "T2", content: "Yo", fontFamily: "Gone", fontSize: 20, fill: "#000000" },
        { type: "text", id: "T3", content: "Ya", fontFamily: "Helvetica Neue", fontSize: 20, fill: "#000000" },
        { type: "text", id: "T4", content: "Ye", fontFamily: "Inter", fontSize: 12, fontWeight: "700", fill: "#000000" },
      ],
    },
  ],
};
const file = path.join(dir, "s.canvas.json");
fs.writeFileSync(file, JSON.stringify(doc));
const snap = snapshotOf(loadDoc(file));

describe("summary", () => {
  test("counts, boards and components", () => {
    const s = summaryOf(snap);
    assert.equal(s.counts.topLevel, 2);
    assert.equal(s.counts.byType.text, 5);
    assert.equal(s.counts.instances, 1);
    assert.equal(s.counts.components, 1);
    assert.equal(s.boards.find((b) => b.id === "Scr01")?.children, 5);
    assert.deepEqual(s.variables, [{ name: "accent", type: "color", value: "#0766EB" }]);
    assert.match(s.revision, /^[0-9a-f]{12}$/);
  });

  test("fonts: source, weights, embedded file existence", () => {
    const f = Object.fromEntries(fontsUsed(snap.doc, file).map((x) => [x.family, x]));
    assert.equal(f.Brand.source, "embedded");
    assert.equal(f.Brand.embeddedFile?.exists, true);
    assert.equal(f.Gone.embeddedFile?.exists, false);
    assert.equal(f["Helvetica Neue"].source, "system");
    assert.deepEqual(f.Inter.weights, ["600", "700"]);
    assert.equal(f.Inter.nodes, 2);
  });

  test("statuses: installed, embedded, web, missing", () => {
    const st = Object.fromEntries(fontStatuses(fontsUsed(snap.doc, file), new Set()).map((x) => [x.family, x.status]));
    assert.deepEqual(st, { Inter: "web", Brand: "embedded", Gone: "missing", "Helvetica Neue": "installed" });
    const st2 = Object.fromEntries(fontStatuses(fontsUsed(snap.doc, file), new Set(["Inter"])).map((x) => [x.family, x.status]));
    assert.equal(st2.Inter, "installed");
  });
});

describe("board index", () => {
  test("every stored id maps to its top-level board; instance paths go by their first segment", () => {
    const ix = boardIndex(snap.doc);
    assert.equal(boardOf(ix, "T1"), "Scr01");
    assert.equal(boardOf(ix, "Scr01"), "Scr01");
    assert.equal(boardOf(ix, "Lbl01"), "Cmp01");
    assert.equal(boardOf(ix, "Ins01/Lbl01"), "Scr01");
    assert.equal(boardOf(ix, "Nope"), undefined);
  });
});
