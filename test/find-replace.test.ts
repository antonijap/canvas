// The find and replace bar's pure helpers (src/page/find-replace.js). The server half is in test/text-edit.test.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as F from "../src/page/find-replace.js";

describe("find and replace bar", () => {
  test("stepIndex wraps both ways; the first Return shows the first match, Shift+Return the last", () => {
    assert.equal(F.stepIndex(-1, 3, 1), 0);
    assert.equal(F.stepIndex(-1, 3, -1), 2);
    assert.equal(F.stepIndex(2, 3, 1), 0);
    assert.equal(F.stepIndex(0, 3, -1), 2);
    assert.equal(F.stepIndex(0, 0, 1), -1);
  });
  test("countLabel", () => {
    assert.equal(F.countLabel("", -1, 0), "");
    assert.equal(F.countLabel("x", -1, 0), "No results");
    assert.equal(F.countLabel("x", -1, 12), "12");
    assert.equal(F.countLabel("x", 2, 12), "3 of 12");
  });
  test("keepIndex: the same match when it is still there, else the one in its slot", () => {
    const ms = [{ id: "a", start: 0 }, { id: "a", start: 5 }, { id: "b", start: 1 }];
    assert.equal(F.keepIndex({ id: "a", start: 5 }, ms, 0), 1);
    assert.equal(F.keepIndex({ id: "c", start: 0 }, ms, 2), 2);
    assert.equal(F.keepIndex({ id: "c", start: 0 }, ms, 7), 2);
    assert.equal(F.keepIndex(null, [], 1), -1);
  });
});
