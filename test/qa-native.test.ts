// pnpm qa:native's scenario list: every covers pair is in the catalog, and ids are unique.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("native artifact names fit a filesystem component and keep long scenarios distinct", async () => {
  const { nativeFileStem } = await import("../qa/native/harness.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-native-name-"));
  try {
    const names = ["Join with an invite ".repeat(30), "Join with an invite ".repeat(30) + " again", "Cloud " + "☁".repeat(300)];
    const stems = names.map((name) => nativeFileStem({ area: "settings", name }));
    assert.equal(new Set(stems).size, names.length);
    for (const stem of stems) {
      const file = `07-${stem}.canvas`;
      assert.ok(Buffer.byteLength(file) <= 200);
      fs.mkdirSync(path.join(dir, file));
      fs.writeFileSync(path.join(dir, `${stem}.png`), "image placeholder");
    }
    assert.equal(nativeFileStem({ area: "settings", name: "Cloud" }), "settings-cloud");
    assert.equal(stems[0], nativeFileStem({ area: "settings", name: names[0] }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
