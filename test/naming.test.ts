// New frames and groups are numbered: "Frame 1", "Frame 2", ... (QA item 23).

import assert from "node:assert/strict";
import { test } from "node:test";
import { nextName } from "../src/structure.ts";

test("the first frame is Frame 1, the next one more than the highest", () => {
  assert.equal(nextName({ children: [] }, "Frame"), "Frame 1");
  const doc = { children: [{ type: "frame", name: "Frame 2", children: [{ type: "frame", name: "Frame 7" }, { type: "group", name: "Group 1" }] }, { type: "frame", name: "Frame" }, { type: "frame", name: "Frame 3b" }] };
  assert.equal(nextName(doc, "Frame"), "Frame 8", "nested names count; other names do not");
  assert.equal(nextName(doc, "Group"), "Group 2");
});
