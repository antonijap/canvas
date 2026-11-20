import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { actionChecks, docEditAction, docFileOps, onAction } from "../src/cloud-files-ops.ts";
import { DocTree } from "../src/cloud-files-tree.ts";
import { applyAction, isReject } from "../cloud/core/files/apply.ts";
import { editDoc } from "../src/docwriter.ts";
import { nodeDiff, propsOf, record, undo, redo, resetHistory } from "../src/history.ts";
import type { Action } from "../cloud/protocol-files.ts";

const initial = () => ({ children: [{ id: "node", type: "rectangle", x: 0 }] });

async function withFile(fn: (file: string, actions: Action[]) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-actions-"));
  const file = path.join(dir, "example.canvas.json");
  const oldState = process.env.CANVAS_STATE_DIR;
  process.env.CANVAS_STATE_DIR = path.join(dir, "state");
  fs.writeFileSync(file, JSON.stringify(initial()));
  const actions: Action[] = [];
  const off = onAction((f, a) => { if (f === file) actions.push(a); });
  try { await fn(file, actions); }
  finally { if (oldState === undefined) delete process.env.CANVAS_STATE_DIR; else process.env.CANVAS_STATE_DIR = oldState; off(); resetHistory(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("test mode checks edits and refuses unrecorded inserts before writing", async () => {
  assert.equal(actionChecks.enabled, true);
  await withFile(async (file, actions) => {
    const before = fs.readFileSync(file, "utf8");
    await assert.rejects(() => editDoc(file, { touches: [null] }, (doc) => {
      doc.children.push({ id: "new", type: "rectangle" });
    }), /incomplete/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(actions.length, 0);
  });
});

test("merged property edits restore exact key order through undo and redo", async () => {
  await withFile(async (file, actions) => {
    const original = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [k, value] of [["fill", "#ffffff"], ["name", "Shape"]] as const) {
      let op: ReturnType<typeof nodeDiff>;
      await editDoc(file, { touches: ["node"] }, (doc) => {
        const n = doc.children[0], before = propsOf(n);
        n[k] = value;
        op = nodeDiff("node", before, propsOf(n));
      });
      record(file, [op!], { label: "Properties", mergeKey: "properties" });
    }
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    await undo(file);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))), JSON.stringify(original));
    await redo(file);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))), JSON.stringify(after));
    const inverse = actions[2].ops[0];
    assert.equal(inverse.k, "set");
    if (inverse.k !== "set") return;
    assert.deepEqual(inverse.if, { fill: actions[0].id, name: actions[1].id });
    const tree = new DocTree(original);
    for (const action of actions) assert.ok(!isReject(applyAction(tree, action)), JSON.stringify(action));
    assert.equal(JSON.stringify(tree.doc), JSON.stringify(after));
  });
});

test("an ordering-only property edit is recorded and translated", () => {
  const before = initial();
  const after = { children: [{ type: "rectangle", x: 0, id: "node" }] };
  const op = nodeDiff("node", propsOf(before.children[0]), propsOf(after.children[0]));
  assert.ok(op.keys);
  docEditAction("ordering", before, after, [op]);
  const tree = new DocTree(before);
  const result = applyAction(tree, { id: "order", ops: docFileOps(before, [op]) });
  assert.ok(!isReject(result));
  assert.equal(JSON.stringify(tree.doc), JSON.stringify(after));
});

test("document keys produce undo and redo actions", async () => {
  await withFile(async (file, actions) => {
    const original = { ...initial(), variables: { accent: { type: "color", value: "#ffffff" } }, themes: { mode: ["light"] } };
    fs.writeFileSync(file, JSON.stringify(original));
    const next = { accent: { type: "color", value: "#000000" } };
    await editDoc(file, { touches: [] }, (doc) => { doc.variables = next; });
    record(file, [{ t: "doc", key: "variables", b: { v: original.variables }, a: { v: next } }], { label: "Variable" });
    await undo(file);
    await redo(file);
    assert.equal(actions.length, 3);
    assert.equal(actions[1].ops[0].k, "doc");
    if (actions[1].ops[0].k === "doc") assert.equal(actions[1].ops[0].if, actions[0].id);
    const tree = new DocTree(original);
    for (const action of actions) assert.ok(!isReject(applyAction(tree, action)));
    assert.equal(JSON.stringify(tree.doc), fs.readFileSync(file, "utf8"));
  });
});

test("document values stay isolated in a copy on write edit", async () => {
  const { cowDoc } = await import("../src/docwriter.ts");
  const before = { ...initial(), variables: { accent: { type: "color", value: "#ffffff" } }, themes: { mode: ["light"] }, fonts: [{ family: "Example" }] };
  const bytes = JSON.stringify(before);
  const next = cowDoc(before, [], false, ["variables", "themes", "fonts"]);
  (next.variables as typeof before.variables).accent.value = "#000000";
  (next.themes as typeof before.themes).mode.push("dark");
  (next.fonts as typeof before.fonts)[0].family = "Other";
  assert.equal(JSON.stringify(before), bytes);
});

test("first variable creation and empty container transitions undo byte for byte", async () => {
  await withFile(async (file, actions) => {
    const original = initial();
    const vars = { accent: { type: "color", value: "#ffffff" } };
    await editDoc(file, { touches: [] }, (doc) => { doc.variables = vars; });
    record(file, [{ t: "doc", key: "variables", b: null, a: { v: vars } }], { label: "Variable" });
    await undo(file);
    assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(original));
    await redo(file);
    const tree = new DocTree(original);
    for (const action of actions) assert.ok(!isReject(applyAction(tree, action)));
    assert.equal(JSON.stringify(tree.doc), fs.readFileSync(file, "utf8"));
  });
});

test("document key deletion restores its original place on undo", async () => {
  await withFile(async (file, actions) => {
    const original = { themes: { mode: ["light"] }, ...initial(), fonts: [] };
    fs.writeFileSync(file, JSON.stringify(original));
    await editDoc(file, { touches: [] }, (doc) => { delete doc.themes; });
    record(file, [{ t: "doc", key: "themes", b: { v: original.themes }, a: null }], { label: "Themes" });
    await undo(file);
    assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(original));
    const tree = new DocTree(original);
    for (const action of actions) assert.ok(!isReject(applyAction(tree, action)));
    assert.equal(JSON.stringify(tree.doc), JSON.stringify(original));
  });
});

test("new document keys keep edit order in the client and the room", async () => {
  const { MemoryTree } = await import("../cloud/core/files/tree-memory.ts");
  const { stateFromFiles, documentOf } = await import("../cloud/core/files/state.ts");
  const before = { children: [] };
  const local = new DocTree(before), room = new MemoryTree(stateFromFiles(before));
  const action: Action = { id: "doc-order", epoch: 0, baseSeq: 0, at: "", ops: [
    { k: "doc", key: "fonts", value: { v: [] } },
    { k: "doc", key: "themes", value: { v: {} } },
    { k: "doc", key: "variables/accent", value: { v: { type: "color", value: "#ffffff" } } },
  ] };
  assert.ok(!isReject(applyAction(local, action)));
  assert.ok(!isReject(applyAction(room, action)));
  assert.equal(JSON.stringify(local.doc), JSON.stringify(documentOf(room)));
});

test("a failed compound edit still publishes changes it committed", async () => {
  const { asOneAction } = await import("../src/cloud-files-ops.ts");
  await withFile(async (file, actions) => {
    await assert.rejects(asOneAction(file, async () => {
      await editDoc(file, { touches: ["node"] }, (doc) => { doc.children[0].x = 1; });
      throw new Error("sidecar failed");
    }), /sidecar failed/);
    assert.equal(actions.length, 1);
    const tree = new DocTree(initial());
    assert.ok(!isReject(applyAction(tree, actions[0])));
    assert.equal(JSON.stringify(tree.doc), fs.readFileSync(file, "utf8"));
  });
});

test("an async compound action is delivered before edits that depend on its insert", async () => {
  const { asOneAction } = await import("../src/cloud-files-ops.ts");
  await withFile(async (file, actions) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { entered = r; });
    const node = { id: "added", type: "rectangle", x: 0 };
    const pending = asOneAction(file, async () => {
      await editDoc(file, { touches: [null], recorded: () => [{ t: "tree", kind: "insert", node, parent: null, index: 1 }] }, (doc) => { doc.children.push(node); });
      entered();
      await gate;
    });
    await started;
    const standalone = editDoc(file, { touches: ["added"] }, (doc) => { doc.children[1].x = 2; });
    release();
    await Promise.all([pending, standalone]);
    assert.equal(actions.length, 2);
    const tree = new DocTree(initial());
    for (const action of actions) assert.ok(!isReject(applyAction(tree, action)), JSON.stringify(action));
    assert.equal(JSON.stringify(tree.doc), fs.readFileSync(file, "utf8"));
  });
});

test("sidecar writes wait until a compound edit finishes", async () => {
  const { asOneAction } = await import("../src/cloud-files-ops.ts");
  const { storeForAsync } = await import("../src/widgets/store.ts");
  await withFile(async (file, actions) => {
    const store = await storeForAsync(file);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { entered = r; });
    const first = asOneAction(file, async () => {
      await store.mutateEnvelope((widgets, extra) => ({ widgets, extra: { ...extra, brief: "First" } }));
      entered();
      await gate;
      await store.mutateEnvelope((widgets, extra) => ({ widgets, extra: { ...extra, threads: [] } }));
    });
    await started;
    const second = store.mutateEnvelope((widgets, extra) => ({ widgets, extra: { ...extra, brief: "Second" } }));
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([first, second]);
    assert.equal(actions.length, 2);
    const tree = new DocTree(initial());
    for (const action of actions) assert.ok(!isReject(applyAction(tree, action)), JSON.stringify(action));
    assert.equal(JSON.stringify(tree.envelope), JSON.stringify({ widgets: store.peek().widgets, extra: store.peek().extra }));
  });
});

test("variable key reordering survives edit, undo and redo", async () => {
  await withFile(async (file, actions) => {
    const a = { type: "number", value: 1 }, b = { type: "number", value: 2 };
    const original = { ...initial(), variables: { a, b } };
    const next = { b, a };
    fs.writeFileSync(file, JSON.stringify(original));
    await editDoc(file, { touches: [] }, (doc) => { doc.variables = next; });
    record(file, [{ t: "doc", key: "variables", b: { v: original.variables }, a: { v: next } }], { label: "Variables" });
    await undo(file);
    assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(original));
    await redo(file);
    assert.equal(actions.length, 3);
    const tree = new DocTree(original);
    for (const action of actions) assert.ok(!isReject(applyAction(tree, action)), JSON.stringify(action));
    assert.equal(JSON.stringify(tree.doc), fs.readFileSync(file, "utf8"));
  });
});


test("concurrent standalone edits keep their own history writers", async () => {
  const { entries } = await import("../src/history.ts");
  await withFile(async (file, actions) => {
    await Promise.all([1, 2].map(async (x) => {
      let op: ReturnType<typeof nodeDiff>;
      const { write } = await editDoc(file, { touches: ["node"] }, (doc) => {
        const n = doc.children[0], before = propsOf(n);
        n.x = x;
        op = nodeDiff("node", before, propsOf(n));
      });
      record(file, [op!], { label: "Position", mergeKey: `position-${x}`, edit: write.edit, ...write.history });
    }));
    const steps = entries(file).undo;
    assert.equal(steps.length, 2);
    assert.equal(steps[0].writers?.["n:node:x"], actions[0].id);
    assert.equal(steps[1].writers?.["n:node:x"], actions[1].id);
  });
});

test('agent action labels stay in their request context',async()=>{
 const {withActionAgent,makeAction}=await import('../src/cloud-files-ops.ts');
 const ops:any[]=[{k:'set',id:'node',props:{x:{v:1}}}];
 const a=await withActionAgent('Helper',async()=>makeAction(ops));assert.equal(a.agent,'Helper');assert.equal(makeAction(ops).agent,undefined);
});
