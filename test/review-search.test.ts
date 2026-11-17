// Codex review b3 and b4 (docs/evidence/review-fixes.md): Replace All stopped at 10,000 matches in a layer and
// left the rest; whole-word matching looked at half a surrogate pair, so "cat" matched inside "𐐀cat".

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("review-search");
process.env.CANVAS_ROOTS = dir;
const file = path.join(dir, "s.canvas.json");
const doc = (content: string) => ({ version: "2.21", children: [{ type: "frame", id: "B", x: 0, y: 0, width: 100, height: 100, layout: "none", children: [{ type: "text", id: "T", content }] }] });
fs.writeFileSync(file, JSON.stringify(doc("a".repeat(10_001))));
const { startServer } = await import("../src/server.ts");
const { findAll } = await import("../src/search.ts");
const pw = await import("../src/docwriter.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  fs.unwatchFile(file);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const call = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const text = () => (pw.currentDoc(file).doc as any).children[0].children[0].content as string;

test("b3: Replace All replaces every match in a layer, past 10,000", async () => {
  await fetch(`${base}/api/doc?file=${encodeURIComponent(file)}`);
  const r = await call("/api/replace", { file, query: "a", replacement: "b", matchCase: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replaced, 10_001, "the count says every match");
  assert.equal(text(), "b".repeat(10_001), "no a is left");
});

test("b4: whole words read the letter before a match as a whole code point", () => {
  const astral = "\u{10400}"; // DESERET CAPITAL LONG I: a letter outside the BMP (a surrogate pair)
  assert.deepEqual(findAll(`${astral}cat`, "cat", { wholeWord: true }), [], "a letter before it: not a whole word");
  assert.deepEqual(findAll(`cat${astral}`, "cat", { wholeWord: true }), [], "a letter after it: not a whole word");
  assert.deepEqual(findAll(`😀cat 😀`, "cat", { wholeWord: true }), [2], "an emoji is no letter: a whole word");
  assert.deepEqual(findAll("a cat", "cat", { wholeWord: true }), [2]);
});

// Claude bug hunt S1: the hidden board that holds deleted main components (metadata.canvasDeletedComponents) is not
// a place the person can see: Find and the search palette skip it, as usage.ts does.
test("S1: find and search skip the hidden holder of deleted components", async () => {
  const { snapshotOfDoc } = await import("../src/boards.ts");
  const { findText, search, searchAll } = await import("../src/search.ts");
  const d: any = { version: "2.21", children: [
    { type: "frame", id: "Vis", name: "Visible", x: 0, y: 0, width: 100, height: 100, layout: "none", children: [{ type: "text", id: "T1", name: "Label", content: "zebra here" }] },
    { type: "frame", id: "Holder", name: "Deleted components", enabled: false, metadata: { canvasDeletedComponents: true }, x: 0, y: 0, width: 10, height: 10, layout: "none", children: [
      { type: "frame", id: "Gone", name: "Zebra card", reusable: true, x: 0, y: 0, width: 10, height: 10, layout: "none", children: [{ type: "text", id: "T2", name: "Inside", content: "zebra inside" }] },
    ] },
  ] };
  const snap = snapshotOfDoc("/nowhere/holder.canvas.json", d, "r1");
  assert.deepEqual(findText(snap, "zebra").matches.map((m) => m.id), ["T1"], "Find lists only the visible text");
  const ids = search(snap, "zebra", null).groups.flatMap((g) => g.items.map((i) => i.id));
  assert.ok(!ids.includes("T2") && !ids.includes("Gone") && !ids.includes("Holder"), `the palette skips the holder: ${ids.join(", ")}`);
  assert.deepEqual(searchAll(snap, "zebra", "text", null).ids, ["T1"]);
});

test("S1: the QA document check accepts the holder on no page", async () => {
  const { checkDocument } = await import("../qa/checks.ts");
  const d: any = { version: "2.21", children: [
    { type: "frame", id: "B1", x: 0, y: 0, width: 10, height: 10, layout: "none", children: [] },
    { type: "frame", id: "B2", x: 0, y: 0, width: 10, height: 10, layout: "none", children: [] },
    { type: "frame", id: "Holder", enabled: false, metadata: { canvasDeletedComponents: true }, x: 0, y: 0, width: 10, height: 10, layout: "none", children: [] },
  ] };
  const side = { version: 1, widgets: [], pages: [{ id: "p1", name: "One", boards: ["B1"] }, { id: "p2", name: "Two", boards: ["B2"] }] };
  const errs = checkDocument(d, side);
  assert.ok(!errs.some((e) => e.includes("Holder")), errs.join(" | "));
});

// Claude bug hunt T2: a multi-edit wrote the main layer's styled ranges and lists into every layer.
test("T2: multi-edit keeps each other layer's own ranges, mapped to the new text", async () => {
  const f2 = path.join(dir, "multi.canvas.json");
  const bold = [{ start: 0, end: 4, fontWeight: "700", fill: "#FF0000" }];
  fs.writeFileSync(f2, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "B", x: 0, y: 0, width: 100, height: 100, layout: "none", children: [
    { type: "text", id: "A", content: "Alpha" },
    { type: "text", id: "Bb", content: "Beta", spans: bold },
  ] }] }));
  await fetch(`${base}/api/doc?file=${encodeURIComponent(f2)}`);
  const node = (id: string) => (pw.currentDoc(f2).doc as any).children[0].children.find((n: any) => n.id === id);
  // Main Bb (styled), A also: A takes the text, never Bb's ranges.
  let r = await call("/api/text", { file: f2, id: "Bb", content: "Hi", spans: [{ start: 0, end: 2, fontWeight: "700", fill: "#FF0000" }], also: ["A"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(node("A").content, "Hi");
  assert.deepEqual(node("A").spans ?? [], [], `A keeps no ranges of its own: ${JSON.stringify(node("A").spans)}`);
  // Main A (plain), Bb also: Bb keeps its bold, mapped from "Hi" to "Hi there" as a single edit maps it.
  // @ts-ignore: a plain ES module the page imports too
  const SP = await import("../src/page/text-spans.js");
  const want = SP.follow(node("Bb").spans, "Hi", "Hi there");
  r = await call("/api/text", { file: f2, id: "A", content: "Hi there", also: ["Bb"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(node("Bb").content, "Hi there");
  assert.deepEqual(node("Bb").spans, want);
  assert.ok(want.length > 0);
});
