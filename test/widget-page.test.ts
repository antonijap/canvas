import assert from "node:assert/strict";
import { test } from "node:test";
import { pageName, pageWidth } from "../src/page/widget-page.js";

test("Page name comes from the first visible line", () => {
  assert.equal(pageName("\n# My **Canvas**\nBelow"), "My Canvas");
  assert.equal(pageName("- [ ] [First](https://example.com)\nSecond"), "First");
  assert.equal(pageName(""), "Page");
});

test("Page width fits content without squeezing short text or stretching the column", () => {
  assert.equal(pageWidth(20), 480);
  assert.equal(pageWidth(510), 574);
  assert.equal(pageWidth(6000), 664);
  assert.equal(pageWidth(510, 200), 280);
});
