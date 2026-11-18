import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, isReject } from "../cloud/core/files/apply.ts";
import { DocTree } from "../src/cloud-files-tree.ts";
import { makeAction } from "../src/cloud-files-ops.ts";
import type { FileOp } from "../cloud/protocol-files.ts";

const seed = () => new DocTree({ children: [
  { id: "board", type: "frame", children: [] },
  { id: "component", type: "frame", reusable: true, children: [] },
  { id: "instance", type: "ref", ref: "component" },
] });
const send = (tree: DocTree, ops: FileOp[]) => applyAction(tree, makeAction(ops));

test("remove preconditions protect changes inside the subtree", () => {
  const tree = seed();
  const a = makeAction([{ k: "insert", parent: "board", after: null, node: { id: "group", type: "group", children: [] } }]);
  assert.ok(!isReject(applyAction(tree, a)));
  assert.ok(!isReject(send(tree, [{ k: "insert", parent: "group", after: null, node: { id: "child", type: "rectangle" } }])));
  const before = JSON.stringify(tree.doc);
  assert.ok(isReject(send(tree, [{ k: "remove", id: "group", if: a.id }])));
  assert.equal(JSON.stringify(tree.doc), before);
});

test("moves reject component cycles and roll back", () => {
  const tree = seed();
  const before = JSON.stringify(tree.doc);
  assert.ok(isReject(send(tree, [{ k: "move", id: "instance", parent: "component", after: null }])));
  assert.equal(JSON.stringify(tree.doc), before);
  assert.ok(!isReject(send(tree, [{ k: "insert", parent: "board", after: null, node: { id: "other", type: "frame", reusable: true, children: [{ id: "nested", type: "ref", ref: "component" }] } }])));
  assert.ok(isReject(send(tree, [{ k: "move", id: "other", parent: "component", after: null }])));
});
