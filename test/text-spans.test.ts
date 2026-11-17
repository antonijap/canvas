// Styled ranges in a text layer (src/page/text-spans.js): the format's rules, typing around spans, setting a style
// on a range, reading it back (Mixed), and dropping keys a whole-layer edit sets.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as S from "../src/page/text-spans.js";

describe("text spans", () => {
  test("validation: sorted, not overlapping, inside the text, known keys with values they take", () => {
    assert.deepEqual(S.spanErrors([{ start: 0, end: 3, fontWeight: "700" }, { start: 3, end: 5, fill: "#ff0000" }], 5), []);
    assert.deepEqual(S.spanErrors([{ start: 0, end: 3, fill: "$accent" }], 5), [], "a variable is fine");
    assert.equal(S.spanErrors("x", 5).length, 1);
    assert.match(S.spanErrors([{ start: 2, end: 2 }], 5)[0], /start < end/);
    assert.match(S.spanErrors([{ start: 0, end: 9, fontWeight: "700" }], 5)[0], /past the text/);
    assert.match(S.spanErrors([{ start: 0, end: 3, fontWeight: "700" }, { start: 2, end: 4, fontWeight: "400" }], 5)[0], /overlap/);
    assert.match(S.spanErrors([{ start: 0, end: 3, color: "#fff" }], 5)[0], /not a span style/);
    assert.match(S.spanErrors([{ start: 0, end: 3, fill: "red" }], 5)[0], /cannot take/);
    assert.match(S.spanErrors([{ start: 0, end: 3, fontSize: -1 }], 5)[0], /cannot take/);
  });

  test("normalize: merges equal neighbours, drops empty and style-less spans, clamps, later wins on overlap", () => {
    assert.deepEqual(S.normalize([{ start: 0, end: 2, fontWeight: "700" }, { start: 2, end: 4, fontWeight: "700" }], 10), [{ start: 0, end: 4, fontWeight: "700" }]);
    assert.deepEqual(S.normalize([{ start: 3, end: 3, fontWeight: "700" }, { start: 4, end: 6 }], 10), []);
    assert.deepEqual(S.normalize([{ start: 8, end: 20, fill: "#000000" }], 10), [{ start: 8, end: 10, fill: "#000000" }]);
    assert.deepEqual(S.normalize([{ start: 0, end: 4, fontWeight: "700" }, { start: 2, end: 6, fontWeight: "400" }], 10),
      [{ start: 0, end: 2, fontWeight: "700" }, { start: 2, end: 6, fontWeight: "400" }]);
    assert.deepEqual(S.normalize([{ start: 0, end: 4, fontWeight: "700", fill: "#111111" }], 10, { fontWeight: "700" }), [{ start: 0, end: 4, fill: "#111111" }], "the layer's own value is no span");
  });

  test("typing: inside a span grows it, after it takes its style, before it does not, deletes shrink it", () => {
    const sp = [{ start: 2, end: 5, fontWeight: "700" }];
    assert.deepEqual(S.shift(sp, 3, 0, 2), [{ start: 2, end: 7, fontWeight: "700" }], "inside");
    assert.deepEqual(S.shift(sp, 5, 0, 1), [{ start: 2, end: 6, fontWeight: "700" }], "right after: the letter before is bold");
    assert.deepEqual(S.shift(sp, 2, 0, 1), [{ start: 3, end: 6, fontWeight: "700" }], "right before: the letter before is plain");
    assert.deepEqual(S.shift(sp, 0, 1, 0), [{ start: 1, end: 4, fontWeight: "700" }], "delete before it");
    assert.deepEqual(S.shift(sp, 3, 1, 0), [{ start: 2, end: 4, fontWeight: "700" }], "delete inside");
    assert.deepEqual(S.shift(sp, 1, 5, 0), [], "deleted with it");
    assert.deepEqual(S.shift(sp, 4, 3, 2), [{ start: 2, end: 6, fontWeight: "700" }], "a selection over its end typed over: the new letters follow the letter before");
    assert.deepEqual(S.shift([{ start: 0, end: 2, fill: "#ff0000" }], 0, 0, 1), [{ start: 0, end: 3, fill: "#ff0000" }], "typed at the start: the first letter's style");
  });

  test("follow: spans carried over an edit found by diff", () => {
    assert.deepEqual(S.diff("Hello world", "Hello big world"), { at: 6, removed: 0, inserted: 4 });
    assert.equal(S.diff("a", "a"), null);
    assert.deepEqual(S.follow([{ start: 6, end: 11, fontWeight: "700" }], "Hello world", "Hello big world"), [{ start: 10, end: 15, fontWeight: "700" }]);
  });

  test("apply: a style on a range splits spans around it and merges what matches; null takes a key off", () => {
    const len = 11; // "Hello world"
    let sp = S.apply([], 6, 11, { fontWeight: "700" }, len);
    assert.deepEqual(sp, [{ start: 6, end: 11, fontWeight: "700" }]);
    sp = S.apply(sp, 0, 8, { fill: "#ff0000" }, len);
    assert.deepEqual(sp, [{ start: 0, end: 6, fill: "#ff0000" }, { start: 6, end: 8, fontWeight: "700", fill: "#ff0000" }, { start: 8, end: 11, fontWeight: "700" }]);
    sp = S.apply(sp, 0, 11, { fontWeight: null }, len);
    assert.deepEqual(sp, [{ start: 0, end: 8, fill: "#ff0000" }]);
    assert.deepEqual(S.apply(sp, 0, 8, { fill: "#000000" }, len, { fill: "#000000" }), [], "back to the layer's own: no span");
  });

  test("styleAt: a range's value per key, Mixed where letters differ, a caret reads the letter before it", () => {
    const base = { fontWeight: "400", fontSize: 16, fill: "#000000" };
    const sp = [{ start: 6, end: 11, fontWeight: "700" }];
    assert.equal(S.styleAt(sp, 6, 11, base, 11).fontWeight, "700");
    assert.equal(S.styleAt(sp, 0, 11, base, 11).fontWeight, "mixed");
    assert.equal(S.styleAt(sp, 0, 11, base, 11).fontSize, 16);
    assert.equal(S.styleAt(sp, 8, 8, base, 11).fontWeight, "700", "caret inside");
    assert.equal(S.styleAt(sp, 6, 6, base, 11).fontWeight, "400", "caret right before the span: the letter before is plain");
    assert.deepEqual(S.keysIn([{ start: 0, end: 1, fill: "#ff0000", fontSize: 20 }]).sort(), ["fill", "fontSize"]);
    assert.deepEqual(S.without([{ start: 0, end: 1, fill: "#ff0000", fontSize: 20 }], ["fill"], 5), [{ start: 0, end: 1, fontSize: 20 }]);
    assert.deepEqual(S.without([{ start: 0, end: 1, fill: "#ff0000" }], ["fill"], 5), []);
  });
});
