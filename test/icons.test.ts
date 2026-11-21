import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { iconArt } from "../src/doc/render/icons.ts";
import { sceneOf } from "../src/scene.ts";
import type { CanvasDoc } from "../src/engine.ts";

const examples = [
  ["phosphor", "heart", 256],
  ["phosphor", "heart-fill", 256],
  ["Material Symbols Outlined", "favorite", 24],
  ["Material Symbols Rounded", "favorite", 24],
  ["Material Symbols Sharp", "favorite", 24],
] as const;

test("the large sets stay unloaded until first use", () => {
  const require = createRequire(import.meta.url);
  const ph = require.resolve("@iconify-json/ph/icons.json");
  const material = require.resolve("@iconify-json/material-symbols/icons.json");
  assert.equal(iconArt("lucide", "heart")?.kind, "svg");
  assert.equal(iconArt("feather", "heart")?.kind, "svg");
  assert.equal(require.cache[ph], undefined);
  assert.equal(require.cache[material], undefined);
  assert.equal(iconArt("phosphor", "heart")?.kind, "svg");
  assert.ok(require.cache[ph]);
  assert.equal(require.cache[material], undefined);
  assert.equal(iconArt("Material Symbols Outlined", "favorite")?.kind, "svg");
  assert.ok(require.cache[material]);
});

test("Phosphor and Material Symbols resolve to local artwork", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("network disabled"); });
  for (const [library, name, size] of examples) {
    const art = iconArt(library, name);
    assert.equal(art?.kind, "svg", `${library} ${name}`);
    assert.equal(art.size, size);
    assert.match(art.body, /<path\b/);
  }
  assert.notDeepEqual(iconArt("phosphor", "heart"), iconArt("phosphor", "heart-fill"));
  assert.notDeepEqual(iconArt("Material Symbols Outlined", "favorite"), iconArt("Material Symbols Rounded", "favorite"));
  assert.equal(fetch.mock.callCount(), 0);
});

test("icon aliases, Material underscores and base-name fallback resolve locally", () => {
  assert.deepEqual(iconArt("phosphor", "archive-box"), iconArt("phosphor", "box-arrow-down"));
  const sharp = iconArt("Material Symbols Sharp", "favorite");
  assert.equal(sharp?.kind, "svg");
  assert.deepEqual(sharp, iconArt("Material Symbols Sharp", "favorite-sharp"));
  const edit = iconArt("Material Symbols Outlined", "edit_note");
  assert.equal(edit?.kind, "svg");
  assert.deepEqual(edit, iconArt("Material Symbols Outlined", "edit-note"));
  // This name is present only in the base style.
  const base = iconArt("Material Symbols Outlined", "account-circle-full");
  assert.equal(base?.kind, "svg");
  assert.deepEqual(base, iconArt("Material Symbols Rounded", "account-circle-full"));
  assert.deepEqual(base, iconArt("Material Symbols Sharp", "account-circle-full"));
  assert.equal(iconArt("phosphor", "unknown-icon"), null);
  assert.equal(iconArt("Material Symbols Rounded", "unknown-icon"), null);
  assert.equal(iconArt("unknown-library", "heart"), null);
  assert.equal(iconArt("constructor", "heart"), null);
  assert.equal(iconArt("phosphor", "constructor"), null);
});

test("engine scenes include local icon paths without fetching", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("network disabled"); });
  const doc: CanvasDoc = { version: "2.21", children: [{
    type: "frame", id: "board", width: 320, height: 64,
    children: examples.map(([library, icon], i) => ({ type: "icon", id: `icon-${i}`, library, icon, x: i * 64 })),
  }] };
  const scene = await sceneOf(doc, "/tmp/icons.canvas/document.json", "board");
  for (const [i, node] of (scene.root.children as Record<string, unknown>[]).entries()) {
    assert.equal(node.iconSize, examples[i][2]);
    assert.ok(Array.isArray(node.iconShapes) && node.iconShapes.length > 0);
  }
  assert.deepEqual(scene.warnings, []);
  assert.equal(fetch.mock.callCount(), 0);
});
