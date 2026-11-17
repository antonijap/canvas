// Bug hunt 2026-11-16: note Markdown round trips.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as D from "../src/page/note-doc.js";

describe("note Markdown round trip: backslashes and indented paragraphs", () => {
  const back = (doc: any[]) => D.parse(D.serialize(doc));
  test("a bold run ending in a backslash survives a save", () => {
    const doc = [D.block("p", [{ text: "C:\\", b: true }, { text: " ok" }])];
    const again = back(doc);
    assert.equal(D.textOf(again[0].runs), "C:\\ ok");
    assert.equal(again[0].runs[0].b, true);
    assert.deepEqual(back(again), again);
  });
  test("an indented paragraph that reads like a list or heading stays a paragraph", () => {
    for (const t of ["  - x", "  1. x", "  # x"]) {
      const again = back([D.block("p", [{ text: t }])]);
      assert.equal(again[0].type, "p", t);
      assert.equal(D.textOf(again[0].runs), t);
    }
  });
});
