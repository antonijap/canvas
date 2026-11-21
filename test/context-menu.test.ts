// Sweep S2: the right-click menu's edit items (apps/macos ShellLogic.swift ContextMenuLayout) are the Edit menu's
// own commands (main.swift StructureActions): every selector exists there, with the same key equivalents.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const logic = fs.readFileSync(new URL("../apps/macos/ShellLogic.swift", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../apps/macos/main.swift", import.meta.url), "utf8");
const layout = logic.slice(logic.indexOf("enum ContextMenuLayout"));
const entries = [...layout.matchAll(/Entry\(title: "([^"]+)", selector: "([a-zA-Z]+):"(?:, key: "([^"]*)"|, key: backspace)?([^)]*)\)/g)]
  .map((m) => ({ title: m[1], sel: m[2], key: m[3] ?? (m[0].includes("key: backspace") ? "\b" : ""), rest: m[4] }));

test("every right-click edit item calls a StructureActions method", () => {
  assert.ok(entries.length >= 14, `found ${entries.length}`);
  const actions = main.slice(main.indexOf("final class StructureActions"), main.indexOf("let structureActions"));
  for (const e of entries) assert.match(actions, new RegExp(`@objc func ${e.sel}\\(_ s: Any\\?\\)`), `${e.title} -> ${e.sel}`);
});

test("shortcut hints match the Edit menu's key equivalents", () => {
  const menu = [...main.matchAll(/addEditItem\((?:editMenu|arrangeMenu), "[^"]+", #selector\(StructureActions\.([a-zA-Z]+)\(_:\)\), "([^"]*)"(?:, \[([^\]]*)\])?\)/g)]
    .map((m) => ({ sel: m[1], key: m[2], mods: (m[3] ?? ".command").replace(/\s/g, "") }));
  for (const e of entries) {
    const m = menu.find((x) => x.sel === e.sel);
    if (!m || !m.key) continue; // Paste here, Delete: no Edit-menu key
    if (e.sel === "paste") { assert.equal(e.key, "v"); continue; }
    assert.equal(e.key, m.key, `${e.title} key`);
    assert.equal(/option: true/.test(e.rest), m.mods.includes(".option"), `${e.title} option`);
    assert.equal(/shift: true/.test(e.rest), m.mods.includes(".shift"), `${e.title} shift`);
  }
});

test("Paste here carries the click point; the canvas menu exists for empty canvas", () => {
  assert.match(main, /@objc func pasteHere\(_ s: Any\?\)/);
  const lib = fs.readFileSync(new URL("../apps/macos/Library.swift", import.meta.url), "utf8");
  assert.match(lib, /e\.selector == "pasteHere:" \{ item\.representedObject = NSValue\(point: at\)/);
  assert.match(lib, /func showCanvasMenu\(at point: CGPoint\)/);
  const ctx = fs.readFileSync(new URL("../src/page/context.js", import.meta.url), "utf8");
  assert.match(ctx, /context: \{ x, y, target: null, canvas: true \}/);
});

test("Delete is the last layer action and board creation starts the empty canvas menu", () => {
  const lib = fs.readFileSync(new URL("../apps/macos/Library.swift", import.meta.url), "utf8");
  const layerMenu = lib.slice(lib.indexOf("func showContextMenu("), lib.indexOf("func showCanvasMenu("));
  assert.match(layerMenu, /Copy Link to Layer[\s\S]*menu\.separator\(\)\s+menu\.edit\(ContextMenuLayout\.delete\)/);
  const canvasMenu = lib.slice(lib.indexOf("func showCanvasMenu("), lib.indexOf("func exportTargets("));
  assert.ok(canvasMenu.includes("New Board here"));
  assert.ok(canvasMenu.indexOf("New Board here") < canvasMenu.indexOf("ContextMenuLayout.canvas"));
});
