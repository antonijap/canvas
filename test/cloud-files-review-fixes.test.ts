import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { asOneAction, docEditAction, onAction, actionChecks } from "../src/cloud-files-ops.ts";
import { cowDoc, editDoc } from "../src/docwriter.ts";
import { entries, invertOps, nodeDiff, propsOf, record, rebaseEdit, replayOps, resetHistory } from "../src/history.ts";
import { DocTree, type DocLike } from "../src/cloud-files-tree.ts";
import { applyAction, isReject } from "../cloud/core/files/apply.ts";
import type { Action } from "../cloud/protocol-files.ts";

test("standalone document mutations wait behind the compound action", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-order-"));
  const file = path.join(dir, "example.canvas.json");
  const stateDir = process.env.CANVAS_STATE_DIR;
  process.env.CANVAS_STATE_DIR = path.join(dir, "state");
  const before = { children: [{ id: "node", type: "rectangle", x: 0 }] };
  fs.writeFileSync(file, JSON.stringify(before));
  const actions: Action[] = [];
  const off = onAction((f, action) => { if (f === file) actions.push(action); });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { entered = r; });
  try {
    const compound = asOneAction(file, async () => {
      await editDoc(file, { touches: ["node"] }, (doc) => { doc.children[0].x = 1; });
      entered();
      await gate;
      await editDoc(file, { touches: ["node"] }, (doc) => { doc.children[0].x = 3; });
    });
    await started;
    let mutated = false;
    const standalone = editDoc(file, { touches: ["node"] }, (doc) => { mutated = true; doc.children[0].x = 2; });
    await new Promise<void>((r) => setImmediate(r));
    const interleaved = mutated;
    release();
    await Promise.all([compound, standalone]);
    const replay = new DocTree(before);
    for (const action of actions) assert.ok(!isReject(applyAction(replay, action)));
    assert.equal(JSON.stringify(replay.doc), fs.readFileSync(file, "utf8"));
    assert.equal(interleaved, false);
    assert.equal(actions.length, 2);
    assert.equal(replay.doc.children[0].x, 2);
  } finally { release(); off(); if (stateDir === undefined) delete process.env.CANVAS_STATE_DIR; else process.env.CANVAS_STATE_DIR = stateDir; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("order-only replay retains a reversible history operation", () => {
  const doc = { children: [{ id: "node", type: "rectangle", x: 0 }] };
  const reordered = { x: 0, type: "rectangle", id: "node" };
  const op = nodeDiff("node", propsOf(doc.children[0]), propsOf(reordered));
  const before = JSON.stringify(doc);
  const replayed = replayOps(doc, [op]);
  assert.equal(replayed.length, 1);
  record("order-rebase-review", [op], { label: "Key order", edit: "pending-order" });
  rebaseEdit("order-rebase-review", "pending-order", replayed);
  assert.equal(entries("order-rebase-review").undo.length, 1);
  resetHistory();
  assert.deepEqual(replayOps(doc, [op]), []);
  replayOps(doc, invertOps(replayed));
  assert.equal(JSON.stringify(doc), before);
});

test("node copy on write shares untouched document values", () => {
  const doc = { children: [{ id: "node", type: "rectangle", x: 0 }], variables: { size: { type: "number", value: 4 } }, themes: { mode: ["light"] }, fonts: [{ family: "Example" }] };
  const next = cowDoc(doc, ["node"]);
  next.children[0].x = 1;
  assert.equal(next.variables, doc.variables);
  assert.equal(next.themes, doc.themes);
  assert.equal(next.fonts, doc.fonts);
  assert.equal(doc.children[0].x, 0);
});

test("observed actions reuse indexes without reading unrelated nodes again", () => {
  const enabled = actionChecks.enabled;
  actionChecks.enabled = false;
  let reads = 0;
  const unrelated = { get id() { reads++; return "unrelated"; }, type: "rectangle" };
  const first = { children: [{ id: "node", type: "rectangle", x: 0 }, unrelated] };
  const second = { children: [{ id: "node", type: "rectangle", x: 1 }, unrelated] };
  const third = { children: [{ id: "node", type: "rectangle", x: 2 }, unrelated] };
  const off = onAction(() => {});
  try {
    docEditAction("indexed-review", first, second, [{ t: "node", id: "node", props: { x: { b: { v: 0 }, a: { v: 1 } } } }]);
    reads = 0;
    docEditAction("indexed-review", second, third, [{ t: "node", id: "node", props: { x: { b: { v: 1 }, a: { v: 2 } } } }]);
    assert.equal(reads, 0);
  } finally { off(); actionChecks.enabled = enabled; }
});

test("translation keeps final reference checks and recovers after a rejected edit", () => {
  const first: DocLike = { children: [{ id: "node", type: "ref", ref: "component", x: 0 }, { id: "component", type: "frame", reusable: true }] };
  const second = { children: [{ ...first.children[0], x: 1 }, first.children[1]] };
  docEditAction("reference-review", first, second, [{ t: "node", id: "node", props: { x: { b: { v: 0 }, a: { v: 1 } } } }]);
  assert.throws(() => docEditAction("reference-review", second, { children: [second.children[0]] }, [{ t: "tree", kind: "remove", parent: null, index: 1, node: second.children[1] }]), /component that instances use/);
  const third = { children: [{ ...second.children[0], x: 2 }, second.children[1]] };
  docEditAction("reference-review", second, third, [{ t: "node", id: "node", props: { x: { b: { v: 1 }, a: { v: 2 } } } }]);
});

test("a fresh outside snapshot invalidates the translation index", () => {
  const before = { children: [{ id: "old", type: "rectangle", x: 0 }] };
  const after = { children: [{ id: "old", type: "rectangle", x: 1 }] };
  docEditAction("outside-review", before, after, [{ t: "node", id: "old", props: { x: { b: { v: 0 }, a: { v: 1 } } } }]);
  const outside = { children: [{ id: "new", type: "rectangle", x: 4 }] };
  const next = { children: [{ id: "new", type: "rectangle", x: 5 }] };
  docEditAction("outside-review", outside, next, [{ t: "node", id: "new", props: { x: { b: { v: 4 }, a: { v: 5 } } } }]);
});
