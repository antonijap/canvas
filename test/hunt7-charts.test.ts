// Bug hunt 2026-11-16: chart geometry.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import { barSizes } from "../src/page/charts.js";

describe("grouped bars", () => {
  test("a narrow card with many labels and series still draws bars of at least 1 px", () => {
    const band = 240 / 30; // 320 px card, 30 labels
    const { subW, gap } = barSizes(band, 30, 8, false);
    assert.ok(subW >= 1, "subW " + subW);
    assert.ok(gap >= 0);
  });
  test("roomy bands keep the 2 px gap", () => {
    const { gap, subW } = barSizes(40, 5, 2, false);
    assert.equal(gap, 2);
    assert.ok(subW > 1);
  });
});
