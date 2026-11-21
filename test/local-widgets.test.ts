import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readLocalWidget, parseLocalManifest } from "../src/widgets/local.ts";
import { approveLocalWidget, isLocalWidgetApproved } from "../src/widgets/trust.ts";
import { kindOf, validateWidget } from "../src/widgets/registry.ts";
import { tmpDir } from "./helpers.ts";

const manifest = {
  id: "hello", title: "Hello", description: "Example greeting",
  defaultSize: { w: 240, h: 160 },
  settings: [{ key: "greeting", label: "Greeting", type: "text", default: "Hello" }],
};

test("local manifest validates its id, size and settings schema", () => {
  assert.equal(parseLocalManifest(manifest, "hello").settings[0].key, "greeting");
  for (const invalid of [
    { ...manifest, id: "other" }, { ...manifest, defaultSize: { w: -1, h: 160 } },
    { ...manifest, settings: [{ key: "__proto__", label: "Greeting", type: "text" }] },
    { ...manifest, settings: [{ ...manifest.settings[0], default: 3 }] },
    { ...manifest, pollIntervalSec: 1 },
  ]) assert.throws(() => parseLocalManifest(invalid, "hello"));
});

test("local approvals bind manifest, renderer and fetcher bytes and coexist with origin approvals", (t) => {
  const root = tmpDir("local-widgets");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.CANVAS_WIDGETS_DIR = root;
  process.env.CANVAS_TRUST_FILE = path.join(root, "trust.json");
  fs.writeFileSync(process.env.CANVAS_TRUST_FILE, JSON.stringify({ approvals: { "example": ["https://example.test"] } }));
  const folder = path.join(root, "hello");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest));
  const renderer = path.join(folder, "renderer.js");
  fs.writeFileSync(renderer, "export default () => 'Hello';");
  const original = readLocalWidget("hello")!;
  assert.ok(original);
  assert.equal(isLocalWidgetApproved("hello", original.hash), false);
  approveLocalWidget("hello", original.hash);
  assert.equal(isLocalWidgetApproved("hello", original.hash), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.CANVAS_TRUST_FILE, "utf8")).approvals, { example: ["https://example.test"] });
  fs.appendFileSync(renderer, "\n// updated");
  const updated = readLocalWidget("hello")!;
  assert.notEqual(updated.hash, original.hash);
  assert.equal(isLocalWidgetApproved("hello", updated.hash), false);
  fs.writeFileSync(path.join(folder, "fetch.json"), JSON.stringify({ url: "https://example.test/data" }));
  const polling = readLocalWidget("hello")!;
  assert.notEqual(polling.hash, updated.hash);
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({ ...manifest, previewHTML: "<b>Hello</b>" }));
  assert.notEqual(readLocalWidget("hello")!.hash, polling.hash);

  const config = { greeting: "Hi", extra: { value: 3 } };
  assert.equal(kindOf("hello")?.local?.hash, readLocalWidget("hello")!.hash);
  fs.rmSync(folder, { recursive: true });
  assert.equal(kindOf("hello"), undefined);
  assert.deepEqual(validateWidget({ id: "missing", kind: "hello", name: "Hello", x: 0, y: 0, w: 240, h: 160, locked: false, config }).config, config);
});
