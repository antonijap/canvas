// pnpm qa:native's scenario list: every covers pair is in the catalog, and ids are unique.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCovers, loadCatalog } from "../qa/catalog.ts";
import { nativeSlug, scenarios } from "../qa/native/harness.ts";
import "../qa/native/scenarios.ts";

test("native scenarios name only catalog pairs", () => {
  const cat = loadCatalog();
  assert.ok(scenarios.length > 10);
  for (const s of scenarios) assert.deepEqual(checkCovers(cat, s.covers), [], `${s.area} / ${s.name}`);
});

test("native scenario ids are unique and never a page scenario's", () => {
  const ids = scenarios.map(nativeSlug);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^native-/);
});
