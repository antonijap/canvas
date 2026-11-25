import assert from "node:assert/strict";
import { after, test } from "node:test";
import { validateNode, type DocNode } from "../cloud/core/schema.ts";
import { applyAction, isReject } from "../cloud/core/files/apply.ts";
import { DocTree } from "../src/cloud-files-tree.ts";
import { makeAction } from "../src/cloud-files-ops.ts";
import { copyNodes, pasteNodes } from "../src/structure.ts";
import { exportTargets, shutdownRenderer, type CanvasDoc } from "../src/engine.ts";
import { applyPeerPreviews } from "../src/page/presence-client.js";

const sticky: DocNode = { id: "note", type: "sticky", color: "yellow", width: 184, height: 184, content: "Draft",
  spans: [{ start: 0, end: 5, fontWeight: "700" }], author: { name: "Anna", id: "person" }, showAuthor: true, autoHeight: true };
const sticker: DocNode = { id: "seal", type: "sticker", kind: "love", on: { layer: "note", x: 0.9, y: 0.1 }, by: { name: "Anna", id: "person" } };

test("whiteboard nodes validate through the shared document schema", () => {
  assert.deepEqual(validateNode(sticky), []);
  assert.deepEqual(validateNode(sticker), []);
  assert.match(validateNode({ ...sticker, on: { layer: "note", x: 3, y: 0 } }).join(), /fractions/);
  assert.match(validateNode({ ...sticky, author: { name: "Anna" } }).join(), /author/);
});

test("peer typing updates a sticky preview without editing the original", () => {
  const draft = structuredClone(sticky);
  assert.equal(applyPeerPreviews(draft, [{ editing: { id: "note", text: "Draft in progress" } }]), true);
  assert.equal(draft.content, "Draft in progress");
  assert.equal(sticky.content, "Draft");
});

test("the Cloud applies the regular insert, set and text actions to a whiteboard", () => {
  const tree = new DocTree({ children: [] });
  const inserted = applyAction(tree, makeAction([
    { k: "insert", parent: null, after: null, node: sticky },
    { k: "insert", parent: null, after: sticky.id!, node: sticker },
  ]));
  assert.ok(!isReject(inserted), JSON.stringify(inserted));
  const edited = applyAction(tree, makeAction([
    { k: "set", id: sticky.id!, props: { showAuthor: { v: false }, color: { v: "blue" } } },
    { k: "text", id: sticky.id!, baseSeq: 0, from: 5, del: 0, ins: " together" },
    { k: "set", id: sticker.id!, props: { on: { v: { layer: sticky.id!, x: 0.8, y: 0.2 } } } },
  ]));
  assert.ok(!isReject(edited), JSON.stringify(edited));
  assert.equal(tree.node(sticky.id!)?.props.content, "Draft together");
  assert.equal(tree.node(sticky.id!)?.props.showAuthor, false);
  assert.deepEqual(tree.node(sticker.id!)?.props.on, { layer: sticky.id!, x: 0.8, y: 0.2 });
});

test("copying a note with its sticker retargets it to the pasted note", () => {
  const file = "/tmp/whiteboard.canvas.json";
  const doc = { children: [structuredClone(sticky), structuredClone(sticker)] };
  const payload = copyNodes(doc, [sticky.id!, sticker.id!], {}, file);
  const result = pasteNodes(doc, payload, { parent: null }, file);
  const pasted = doc.children.filter((node) => result.select.includes(node.id!));
  const note = pasted.find((node) => node.type === "sticky")!;
  const seal = pasted.find((node) => node.type === "sticker")!;
  assert.notEqual(note.id, sticky.id);
  assert.equal(note.content, sticky.content);
  assert.deepEqual(note.spans, sticky.spans);
  assert.deepEqual(seal.on, { layer: note.id, x: 0.9, y: 0.1 });
});

after(shutdownRenderer);
test("SVG exports the authored note and the stacked seal, including either sticker by id", () => {
  const board: DocNode = { type: "frame", id: "board", layout: "none", width: 400, height: 400, children: [
    { ...sticky, x: 60, y: 80 }, sticker, { ...sticker, id: "another", by: { name: "Ben", id: "ben" } },
  ] };
  const doc: CanvasDoc = { children: [board] };
  const [all, first, second] = exportTargets([board], { doc, file: "/tmp/whiteboard.canvas.json" }, [
    { id: "board", format: "svg" }, { id: sticker.id!, format: "svg" }, { id: "another", format: "svg" },
  ]);
  assert.match(all.svg!, /Draft/);
  assert.match(all.svg!, /Anna/);
  assert.match(all.svg!, /Love it/);
  assert.match(all.svg!, />2<\/text>/);
  assert.equal(first.rect.width, 42);
  assert.equal(second.rect.pageX, first.rect.pageX);
  assert.equal(second.svg, first.svg);
});
