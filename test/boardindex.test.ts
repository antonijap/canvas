// Board indexes (src/doc/boardindex.ts): lookups through frozen boards' facts answer exactly what a full walk does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetBoard } from "../src/boardcache.ts";
import { allIds, buildIndex, findNode, type CanvasDoc, type DocNode } from "../src/engine.ts";
import { BoardIndex, boardLacks, freezeBoards, IdSet } from "../src/doc/boardindex.ts";
import { cowDoc } from "../src/docwriter.ts";
import { nextName } from "../src/structure.ts";

function makeDoc(boards = 20): CanvasDoc {
  const children: DocNode[] = [];
  for (let b = 0; b < boards; b++) {
    children.push({
      type: "frame", id: `B${b}`, name: `Frame ${b + 1}`, layout: "none", children: [
        { type: "group", id: `G${b}`, name: `Group ${b * 2}`, children: [{ type: "rectangle", id: `R${b}a` }, { type: "text", id: `T${b}`, content: "x" }] },
        { type: "ref", id: `I${b}`, ref: "C0", descendants: { "C0-t": { content: "y" }, "C0-swap": { type: "rectangle", id: `S${b}` } } },
        { type: "frame", id: `F${b}`, children: [{ type: "rectangle", id: `R${b}b` }] },
      ],
    } as DocNode);
  }
  children.push({ type: "frame", id: "C0", reusable: true, children: [{ type: "text", id: "C0-t", content: "c" }] } as DocNode);
  return { version: "2.21", children } as CanvasDoc;
}

/** The walks as they were before the indexes. */
function walkIndex(doc: CanvasDoc): Map<string, DocNode> {
  const m = new Map<string, DocNode>();
  const v = (n: DocNode) => { if (typeof n.id === "string") m.set(n.id, n); (n.children as DocNode[] | undefined)?.forEach(v); };
  doc.children.forEach(v);
  return m;
}
function walkIds(doc: CanvasDoc): Set<string> {
  const s = new Set<string>();
  const v = (o: any) => { if (Array.isArray(o)) return o.forEach(v); if (!o || typeof o !== "object") return; if (typeof o.id === "string" && typeof o.type === "string") s.add(o.id); if (Array.isArray(o.children)) o.children.forEach(v); if (o.descendants && typeof o.descendants === "object") Object.values(o.descendants).forEach(v); };
  doc.children.forEach(v);
  return s;
}

test("buildIndex, allIds and findNode on a frozen document answer what a full walk does", () => {
  const doc = makeDoc();
  freezeBoards(doc);
  const idx = buildIndex(doc);
  assert.ok(idx instanceof BoardIndex);
  const ref = walkIndex(doc);
  for (const [k, v] of ref) { assert.equal(idx.has(k), true, k); assert.equal(idx.get(k), v, k); }
  assert.equal(idx.has("nope"), false);
  assert.deepEqual([...buildIndex(doc).keys()].sort(), [...ref.keys()].sort(), "iterating builds the whole map");
  const ids = allIds(doc);
  assert.ok(ids instanceof IdSet);
  for (const k of walkIds(doc)) assert.equal(ids.has(k), true, k);
  assert.equal(ids.has("S3"), true, "replacement nodes inside overrides count");
  ids.add("NEW1");
  assert.equal(ids.has("NEW1"), true);
  assert.equal(ids.size, walkIds(doc).size + 1);
  for (const k of ref.keys()) {
    const f = findNode(doc, k);
    assert.equal(f.node, ref.get(k));
    if (f.parent) assert.ok((f.parent.children as DocNode[]).includes(f.node));
    assert.equal(f.siblings[f.index], f.node);
  }
  assert.deepEqual(findNode(doc, "R4a").ancestors.map((a) => a.id), ["B4", "G4"]);
  assert.throws(() => findNode(doc, "missing"), /no node with id "missing"/);
});

test("an edit's copies are walked; shared frozen boards answer from their facts; the map is the document as it was", () => {
  const doc = makeDoc();
  freezeBoards(doc);
  const next = cowDoc(doc, ["R3a"]);
  assert.notEqual(next.children[3], doc.children[3], "the touched board is a copy");
  assert.equal(next.children[4], doc.children[4], "the others are shared");
  assert.equal(boardLacks(next.children[3], ["R3a"]), false, "a copy is never skipped");
  // Change the copy in place (as a structure op does): lookups see it.
  const g = findNode(next, "G3").node;
  (g.children as DocNode[]).push({ type: "rectangle", id: "NEWR" } as DocNode);
  assert.equal(findNode(next, "NEWR").parent?.id, "G3");
  const idx = buildIndex(next);
  (g.children as DocNode[]).push({ type: "rectangle", id: "LATER" } as DocNode);
  assert.equal(idx.has("NEWR"), true);
  assert.equal(idx.has("LATER"), false, "made before LATER was added, like a walked map");
  assert.equal(allIds(next).has("LATER"), true);
});

test("a frozen board changed in place against the rule: findNode still finds a moved node; forgetBoard re-indexes", () => {
  const doc = makeDoc();
  freezeBoards(doc);
  buildIndex(doc).get("R1a"); // facts made
  const b1 = doc.children[1] as DocNode;
  (b1.children as DocNode[]).push({ type: "rectangle", id: "SNEAK" } as DocNode);
  assert.equal(findNode(doc, "SNEAK").parent?.id, "B1", "the fallback walk finds it");
  forgetBoard(b1);
  assert.equal(buildIndex(doc).has("SNEAK"), true);
});

test("nextName reads the boards' facts", () => {
  const doc = makeDoc(30);
  freezeBoards(doc);
  assert.equal(nextName(doc, "Group"), "Group 59");
  assert.equal(nextName(doc, "Frame"), "Frame 31");
});
