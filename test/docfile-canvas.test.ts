// The headless loader (render_node, export_nodes) takes .canvas packages, their document.json, and loose .canvas.json files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDoc, resolveDocPath } from "../src/doc/docfile.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docfile-canvas-"));
const doc = JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "b1", x: 0, y: 0, width: 10, height: 10 }] });

test("a .canvas package resolves to its document.json and loads", () => {
  const pkg = path.join(dir, "New.canvas");
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "document.json"), doc);
  assert.equal(resolveDocPath(pkg), fs.realpathSync(path.join(pkg, "document.json")));
  assert.equal(loadDoc(pkg).doc.children[0].id, "b1");
  assert.equal(loadDoc(path.join(pkg, "document.json")).doc.children[0].id, "b1");
});

test("other files are refused", () => {
  assert.throws(() => resolveDocPath(path.join(dir, "notes.json")), /not a Canvas file/);
  assert.throws(() => resolveDocPath(path.join(dir, "document.json")), /not a Canvas file/);
});
