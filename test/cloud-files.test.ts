import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyAction, isReject } from "../cloud/core/files/apply.ts";
import { DocTree, type DocLike } from "../src/cloud-files-tree.ts";
import { makeAction } from "../src/cloud-files-ops.ts";
import type { FileOp } from "../cloud/protocol-files.ts";
import { asOneAction, onAction, docEditAction, envelopeFileOps } from "../src/cloud-files-ops.ts";
import { actionSha, blobTypeOf, checkBlobPath } from "../cloud/protocol-files.ts";
import { docFileOps } from "../src/cloud-files-ops.ts";
import { deliverOps } from "../src/cloud-files-ops.ts";
import { actionBytes } from "../cloud/protocol-files.ts";

const seed = () => new DocTree({ children: [
  { id: "board", type: "frame", children: [] },
  { id: "component", type: "frame", reusable: true, children: [] },
  { id: "instance", type: "ref", ref: "component" },
] });
const send = (tree: DocTree, ops: FileOp[]) => applyAction(tree, makeAction(ops));

test("sidecar preserves explicit null separately from absence", () => {
  const before = { widgets: [], extra: {} };
  const after = { widgets: [], extra: { brief: null } };
  const tree = new DocTree({ children: [] }, before);
  assert.ok(!isReject(send(tree, envelopeFileOps(before, after))));
  assert.equal(JSON.stringify(tree.envelope), JSON.stringify(after));
});

test("a failed action scope does not publish a partial action", async () => {
  const heard: unknown[] = [];
  const off = onAction((_, a) => heard.push(a));
  try {
    await assert.rejects(asOneAction("placeholder", () => {
      docEditAction("placeholder", { children: [] }, { children: [{ id: "x", type: "rectangle" }] }, [{ t: "tree", kind: "insert", parent: null, index: 0, node: { id: "x", type: "rectangle" } }]);
      throw new Error("abort");
    }), /abort/);
    assert.equal(heard.length, 0);
  } finally { off(); }
});

for (const key of ["id", "type", "children", "__proto__", "constructor", "prototype", "unknown"]) {
  test(`set refuses ${key} atomically`, () => {
    const tree = seed(), before = JSON.stringify(tree.doc);
    const r = send(tree, [{ k: "set", id: "board", props: { x: { v: 1 } } }, { k: "set", id: "board", props: Object.fromEntries([[key, { v: "bad" }]]) }]);
    assert.ok(isReject(r));
    assert.equal(JSON.stringify(tree.doc), before);
    assert.equal(tree.ver("n:board:x"), 0);
  });
}
for (const key of ["id", "children", "__proto__", "constructor", "variables/__proto__", "variables/constructor", "variables/", "other"]) {
  test(`doc refuses ${key}`, () => {
    assert.ok(isReject(send(seed(), [{ k: "doc", key: key as "fonts", value: { v: [] } }])));
  });
}
for (const p of ["/media/a.png", "../a.png", "media/../a.png", "media/.a.png", "media/a/b.png", "media/a%2fb.png", "media/a\\b.png", "https://example.test/a.png", "data:image/png,a", "file:///a.png", "//example.test/a.png", "shaders/a.png", "media/a.wgsl", "media/a.html"]) {
  test(`blob refuses ${p}`, () => {
    assert.ok(checkBlobPath(p));
    assert.ok(isReject(send(seed(), [{ k: "blob", path: p as "media/a.png", sha256: "a".repeat(64), bytes: 1, type: "image/png" }])));
  });
}
test("set preserves null, absence and key order with explicit ordering", () => {
  const tree = seed();
  assert.ok(!isReject(send(tree, [{ k: "set", id: "board", props: { metadata: { v: null }, x: { v: 4 } } }])));
  assert.equal(tree.node("board")!.props.metadata, null);
  assert.ok(!isReject(send(tree, [{ k: "set", id: "board", props: { metadata: null, y: { v: 5 } }, order: ["id", "type", "y", "x", "children"] }])));
  assert.equal(Object.hasOwn(tree.node("board")!.props, "metadata"), false);
  assert.deepEqual(Object.keys(tree.node("board")!.props), ["id", "type", "y", "x", "children"]);
});

test("document variables, themes and fonts replay", () => {
  const tree = seed();
  assert.ok(!isReject(send(tree, [
    { k: "doc", key: "variables/accent", value: { v: { type: "color", value: "#ffffff" } } },
    { k: "doc", key: "themes", value: { v: {} } },
    { k: "doc", key: "fonts", value: { v: [] } },
  ])));
  assert.deepEqual(tree.doc.variables, { accent: { type: "color", value: "#ffffff" } });
  assert.ok(!isReject(send(tree, [{ k: "doc", key: "variables/accent", value: null }])));
  assert.deepEqual(tree.doc.variables, {});
});

test("instance overrides travel per path and keep null", () => {
  const before: DocLike = { children: [{ id: "component", type: "frame", reusable: true }, { id: "instance", type: "ref", ref: "component", descendants: { child: { fill: "#ffffff" } } }] };
  const ops = docFileOps(before, [{ t: "node", id: "instance", props: { descendants: { b: { v: { child: { fill: "#ffffff" } } }, a: { v: { child: { fill: null }, other: { opacity: 0.5 } } } } } }]);
  assert.equal(ops[0].k, "set");
  assert.deepEqual(Object.keys((ops[0] as Extract<FileOp, { k: "set" }>).props), ["descendants/child", "descendants/other"]);
  const tree = new DocTree(before);
  assert.ok(!isReject(send(tree, ops)));
  assert.deepEqual(tree.node("instance")!.props.descendants, { child: { fill: null }, other: { opacity: 0.5 } });
  assert.ok(isReject(send(tree, [{ k: "set", id: "instance", props: { "descendants/__proto__": { v: {} } } }])));
});

test("text splice, move, remove and restored ids replay", () => {
  const tree = seed();
  assert.ok(!isReject(send(tree, [{ k: "insert", parent: "board", after: null, node: { id: "text", type: "text", content: "abcd" } }])));
  assert.ok(!isReject(send(tree, [{ k: "text", id: "text", baseSeq: 0, from: 1, del: 2, ins: "X" }])));
  assert.equal(tree.node("text")!.props.content, "aXd");
  const move = makeAction([{ k: "move", id: "text", parent: null, after: "board" }]);
  assert.ok(!isReject(applyAction(tree, move)));
  assert.ok(!isReject(send(tree, [{ k: "move", id: "text", parent: "board", after: null, if: move.id }])));
  assert.ok(!isReject(send(tree, [{ k: "remove", id: "text" }])));
  assert.equal(tree.node("text"), null);
  assert.ok(!isReject(send(tree, [{ k: "insert", parent: "board", after: null, node: { id: "text", type: "text", content: "aXd" } }])));
});

test("pages, board membership, widgets and metadata replay in one action", () => {
  const tree = seed();
  assert.ok(!isReject(send(tree, [
    { k: "page", id: "one", value: { v: { name: "One" } } },
    { k: "page", id: "two", value: { v: { name: "Two" } }, after: "one" },
    { k: "pageOf", board: "board", page: "two" },
    { k: "widget", id: "card", value: { v: { id: "card", kind: "note", text: "hello" } } },
    { k: "meta", key: "brief", value: { v: null } },
    { k: "page", id: "one", value: null },
  ])));
  assert.deepEqual(tree.pages(), [{ id: "two", name: "Two", boards: ["board"] }]);
  assert.ok(isReject(send(tree, [{ k: "page", id: "two", value: null }])));
  assert.ok(!isReject(send(tree, [{ k: "widget", id: "card", value: null }, { k: "pageOf", board: "board", page: null }])));
  assert.deepEqual(tree.widgetIds(), []);
});

test("blobs and confined media validate without disk access", () => {
  const tree = seed();
  const blob: FileOp = { k: "blob", path: "media/a.png", sha256: "a".repeat(64), bytes: 4, type: blobTypeOf("media/a.png") };
  assert.equal(checkBlobPath("shaders/a.wgsl"), null);
  assert.ok(!isReject(applyAction(tree, makeAction([blob, { k: "set", id: "board", props: { fill: { v: { type: "image", url: "media/a.png" } } } }]), { confine: true })));
  assert.ok(isReject(applyAction(tree, makeAction([{ k: "set", id: "board", props: { fill: { v: { type: "image", url: "https://example.test/a.png" } } } }]), { confine: true })));
});

test("action hash binds all payload fields and uses UTF-8", () => {
  const a = makeAction([{ k: "meta", key: "brief", value: { v: "hello 🌲" } }]);
  const expected = createHash("sha256").update(JSON.stringify([a.id, a.baseSeq, a.epoch, a.at, a.ops, null])).digest("hex");
  assert.equal(actionSha(a), expected);
  assert.notEqual(actionSha({ ...a, epoch: a.epoch + 1 }), expected);
});

test("compound document and sidecar writes publish one complete action", async () => {
  const before = { children: [] };
  const after = { children: [{ id: "added", type: "rectangle" }] };
  const envBefore = { widgets: [], extra: {} };
  const envAfter = { widgets: [], extra: { pages: [{ id: "page", name: "Page", boards: ["added"] }] } };
  const actions: import("../cloud/protocol-files.ts").Action[] = [];
  const off = onAction((_, a) => actions.push(a));
  try {
    await asOneAction("placeholder", async () => {
      docEditAction("placeholder", before, after, [{ t: "tree", kind: "insert", parent: null, index: 0, node: after.children[0] }]);
      await asOneAction("placeholder", () => deliverOps("placeholder", envelopeFileOps(envBefore, envAfter), envBefore, envAfter));
    });
    assert.equal(actions.length, 1);
    const tree = new DocTree(before, envBefore);
    assert.ok(!isReject(applyAction(tree, actions[0])));
    assert.equal(JSON.stringify(tree.doc), JSON.stringify(after));
    assert.equal(JSON.stringify(tree.envelope), JSON.stringify(envAfter));
  } finally { off(); }
});

test("subtree structure versions track insert, remove and both sides of a move", () => {
  const tree = seed();
  const insertion = makeAction([{ k: "insert", parent: "board", after: null, node: { id: "group", type: "group", children: [{ id: "child", type: "rectangle" }] } }]);
  assert.ok(!isReject(applyAction(tree, insertion)));
  assert.equal(tree.ver("s:board"), insertion.id);
  const mv = makeAction([{ k: "move", id: "child", parent: "component", after: null }]);
  assert.ok(!isReject(applyAction(tree, mv)));
  for (const id of ["group", "board", "component", "child"]) assert.equal(tree.ver(`s:${id}`), mv.id);
  assert.ok(isReject(send(tree, [{ k: "remove", id: "group", if: insertion.id }])));
  const rm = makeAction([{ k: "remove", id: "child" }]);
  assert.ok(!isReject(applyAction(tree, rm)));
  assert.equal(tree.ver("s:component"), rm.id);
  assert.ok(!isReject(send(tree, [{ k: "remove", id: "group", if: mv.id }])));
  const restored = makeAction([{ k: "insert", parent: "board", after: null, node: { id: "group", type: "group", children: [] } }]);
  assert.ok(!isReject(applyAction(tree, restored)));
  assert.equal(tree.ver("s:group"), restored.id);
});

test("action size counts UTF-8 bytes", () => {
  const a = makeAction([{ k: "meta", key: "brief", value: { v: "🌲" } }]);
  assert.equal(actionBytes(a), Buffer.byteLength(JSON.stringify(a.ops)));
});

test("the first instance override uses a per-path op", () => {
  const before: DocLike = { children: [{ id: "component", type: "frame", reusable: true }, { id: "instance", type: "ref", ref: "component" }] };
  const ops = docFileOps(before, [{ t: "node", id: "instance", props: { descendants: { b: null, a: { v: { child: { fill: "#ffffff" } } } } } }]);
  assert.deepEqual(Object.keys((ops[0] as Extract<FileOp, { k: "set" }>).props), ["descendants/child"]);
  const tree = new DocTree(before);
  assert.ok(!isReject(send(tree, ops)));
  assert.deepEqual(tree.node("instance")!.props.descendants, { child: { fill: "#ffffff" } });
});

test("first override and a new own key keep their local insertion order", () => {
  const before: DocLike = { children: [{ id: "component", type: "frame", reusable: true }, { id: "instance", type: "ref", ref: "component" }] };
  const ops = docFileOps(before, [{ t: "node", id: "instance", props: { descendants: { b: null, a: { v: { child: { fill: "#ffffff" } } } }, fill: { b: null, a: { v: "#000000" } } }, keys: { b: ["id", "type", "ref"], a: ["id", "type", "ref", "descendants", "fill"] } }]);
  const tree = new DocTree(before);
  assert.ok(!isReject(send(tree, ops)));
  assert.deepEqual(Object.keys(tree.node("instance")!.props), ["id", "type", "ref", "descendants", "fill"]);
});

test("writes scheduled after an action closes publish a fresh immutable action", async () => {
  const actions: import("../cloud/protocol-files.ts").Action[] = [];
  const before: DocLike = { children: [{ id: "node", type: "rectangle", x: 0 }] };
  const middle: DocLike = { children: [{ id: "node", type: "rectangle", x: 1 }] };
  const after: DocLike = { children: [{ id: "node", type: "rectangle", x: 2 }] };
  const off = onAction((_, a) => actions.push(a));
  let late: Promise<void>;
  try {
    await asOneAction("placeholder", () => {
      docEditAction("placeholder", before, middle, [{ t: "node", id: "node", props: { x: { b: { v: 0 }, a: { v: 1 } } } }]);
      late = new Promise<void>((resolve) => setTimeout(() => {
        docEditAction("placeholder", middle, after, [{ t: "node", id: "node", props: { x: { b: { v: 1 }, a: { v: 2 } } } }]);
        resolve();
      }, 0));
    });
    await late!;
    assert.equal(actions.length, 2);
    assert.equal(actions[0].ops.length, 1);
    assert.notEqual(actions[0].id, actions[1].id);
  } finally { off(); }
});
