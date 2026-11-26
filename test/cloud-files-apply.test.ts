import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, isReject } from "../cloud/core/files/apply.ts";
import { DocTree } from "../src/cloud-files-tree.ts";
import { makeAction } from "../src/cloud-files-ops.ts";
import type { FileOp } from "../cloud/protocol-files.ts";
import type { Json } from "../cloud/core/schema.ts";

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

test("whole override resets and per-path writes share writer preconditions", () => {
  const tree = seed();
  const path = makeAction([{ k: "set", id: "instance", props: { "descendants/label": { v: { content: "One" } } } }]);
  assert.ok(!isReject(applyAction(tree, path)));
  assert.equal(tree.ver("n:instance:descendants"), path.id);
  const reset = makeAction([{ k: "set", id: "instance", props: { descendants: null }, if: { descendants: path.id } }]);
  assert.ok(!isReject(applyAction(tree, reset)));
  assert.equal(tree.ver("n:instance:descendants/label"), reset.id);
  assert.ok(isReject(send(tree, [{ k: "set", id: "instance", props: { "descendants/label": { v: { content: "Two" } } }, if: { "descendants/label": path.id } }])));
});

test("Cloud checks nested override motion on writes and accepts old log entries on replay", () => {
  const override = { descendants: { inner: { children: [{ id: "replacement", type: "rectangle", motion: [{}] }] } } };
  const flat = { motion: [{}] };
  const ops: FileOp[] = [
    { k: "set", id: "instance", props: { "descendants/child": { v: override } } },
    { k: "set", id: "instance", props: { descendants: { v: { child: override } } } },
    { k: "insert", parent: "board", after: null, node: { id: "another", type: "ref", ref: "component", descendants: { child: override } } },
    { k: "set", id: "instance", props: { "descendants/child": { v: flat } } },
    { k: "set", id: "instance", props: { descendants: { v: { child: flat } } } },
  ];
  for (const op of ops) {
    const tree = seed(), action = makeAction([op]);
    const result = applyAction(tree, action);
    assert.ok(isReject(result), JSON.stringify(op));
    assert.match(result.message, /descendants\/child.*\.motion/);
  }
  for (const op of ops) assert.ok(!isReject(applyAction(seed(), makeAction([op]), { replay: true })), JSON.stringify(op));
});

test("future animation fields on an override stay opaque to Cloud component checks", () => {
  const tree = seed();
  const motion = [{ id: "fade", on: "boardHover", ref: "future-value", tracks: [{ prop: "opacity", to: 0.5 }] }];
  const descendants = { child: { motion } };
  const result = send(tree, [{ k: "set", id: "instance", props: { "descendants/child": { v: descendants.child } } }]);
  assert.ok(!isReject(result), JSON.stringify(result));
  assert.deepEqual(tree.node("instance")?.props.descendants, descendants);
});

test("Cloud applies keyframes with or without matching fallback fields", () => {
  const tree = seed();
  const keys: Json[] = [{ t: 0, v: 1 }, { t: 120, v: 0.5 }, { t: 300, v: 0, ease: "easeOut" }];
  const motion = [{ id: "fade", on: "boardHover", tracks: [{ prop: "opacity", keys }] }];
  const update = (v: NonNullable<FileOp & { k: "set" }>["props"][string]) => send(tree, [{ k: "set", id: "board", props: { motion: v } }]);
  assert.ok(!isReject(update({ v: motion })));
  const compatible = [{ ...motion[0], tracks: [{ prop: "opacity", keys, from: 1, to: 0, delay: 0, duration: 300, ease: "easeOut" }] }];
  assert.ok(!isReject(update({ v: compatible })));
  const mixed = [{ ...motion[0], tracks: [{ ...compatible[0].tracks[0], to: 0.5 }] }];
  assert.ok(isReject(update({ v: mixed })));
  assert.deepEqual(tree.node("board")?.props.motion, compatible);
  const oldAction = makeAction([{ k: "set", id: "board", props: { motion: { v: mixed } } }]);
  assert.ok(!isReject(applyAction(tree, oldAction, { replay: true })));
  assert.deepEqual(tree.node("board")?.props.motion, mixed);
  assert.ok(!isReject(update({ v: compatible })));
});

test("Cloud restores and replaces subtrees with stale keyframe fallbacks", () => {
  const tree = seed(), peer = seed();
  const keys = [{ t: 0, v: 1 }, { t: 300, v: 0.5 }];
  const track = { prop: "opacity", keys, from: 1, to: 0, delay: 0, duration: 300 };
  const motion = [{ id: "fade", on: "boardHover", tracks: [track] }];
  const node = { id: "group", type: "frame", children: [{ id: "layer", type: "rectangle", motion }] };
  const insert = { k: "insert", parent: "board", after: null, node } as const;
  const remove = { k: "remove", id: node.id } as const;
  const old = applyAction(tree, makeAction([insert]), { replay: true });
  assert.ok(!isReject(old));
  assert.deepEqual(tree.node("layer")?.props.motion, motion);
  assert.ok(!isReject(send(tree, [remove])));
  for (const ops of [[insert], [remove, insert]]) {
    const result = send(tree, ops);
    assert.ok(!isReject(result), JSON.stringify(result));
    assert.deepEqual(tree.node("layer")?.props.motion, [{ ...motion[0], tracks: [{ ...track, to: 0.5 }] }]);
    assert.ok(!isReject(applyAction(peer, result, { replay: true })));
    assert.deepEqual(peer.doc, tree.doc);
  }
});
