// The other pastes (src/structure.ts, src/page/structure.js, src/page/drop-logic.js): Paste to replace
// (Shift+Cmd+R), a paste into several selected frames, plain text from another app as a text layer, and Space held
// while adding ("keep the parent": the paste or drop does not go into the frame).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
// @ts-expect-error a plain browser module without types
import { frameTargets, keyAction, pastePlace, textLayer } from "../src/page/structure.js";
// @ts-expect-error a plain browser module without types
import { dropParent } from "../src/page/drop-logic.js";

const dir = tmpDir("paste-more");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_TRUST_FILE = path.join(dir, ".trust.json");

const P = path.join(dir, "P.canvas");
fs.mkdirSync(P);
fs.writeFileSync(path.join(P, "document.json"), JSON.stringify({
  version: "2.21",
  children: [
    { type: "frame", id: "B1", name: "Board", x: 0, y: 0, width: 600, height: 400, layout: "none", children: [
      { type: "rectangle", id: "R1", x: 10, y: 20, width: 40, height: 40, fill: "#FF0000" },
      { type: "ellipse", id: "E1", x: 200, y: 120, width: 30, height: 30, fill: "#00FF00" },
      { type: "rectangle", id: "Top", x: 300, y: 300, width: 10, height: 10, fill: "#000000" },
      { type: "frame", id: "Row", x: 0, y: 300, width: 300, height: 60, layout: "horizontal", gap: 8, children: [
        { type: "rectangle", id: "A1", width: 20, height: 20, fill: "#111111" },
        { type: "rectangle", id: "A2", width: 20, height: 20, fill: "#222222" },
        { type: "rectangle", id: "A3", width: 20, height: 20, fill: "#333333" },
      ] },
      { type: "frame", id: "F1", x: 350, y: 10, width: 100, height: 100, layout: "none", children: [] },
      { type: "frame", id: "F2", x: 470, y: 10, width: 100, height: 100, layout: "none", children: [] },
    ] },
    { type: "frame", id: "Src", name: "Source", x: 0, y: 600, width: 200, height: 200, layout: "none", children: [
      { type: "rectangle", id: "Star", name: "Star", x: 5, y: 5, width: 24, height: 12, fill: "#0000FF" },
      { type: "text", id: "Lbl", name: "Label", x: 5, y: 30, content: "Hi", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" },
    ] },
  ],
}, null, 2) + "\n");
fs.writeFileSync(path.join(P, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }) + "\n");

const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 70_000_000;
history.setClock(() => (clock += 5000));

async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "x-canvas": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
const q = (f: string) => `?file=${encodeURIComponent(f)}`;
const op = (body: Record<string, unknown>) => call("POST", "/api/structure", { file: P, ...body });
const flush = () => call("POST", `/api/flush${q(P)}`);
const undo = async () => { const r = await call("POST", `/api/history/undo${q(P)}`); await flush(); return r; };
const raw = () => fs.readFileSync(path.join(P, "document.json"), "utf8");
const doc = () => JSON.parse(raw());
const findIn = (list: any[], id: string): any => {
  for (const n of list) {
    if (n.id === id) return n;
    const h = n.children && findIn(n.children, id);
    if (h) return h;
  }
};
const kidsOf = (id: string) => findIn(doc().children, id).children as any[];

describe("paste to replace", () => {
  test("each selected layer gives way to a copy of the clipboard, at its spot and index; one undo", async () => {
    const c = await op({ op: "copy", ids: ["Star"], rects: { Star: { x: 5, y: 605, w: 24, h: 12 } } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await flush();
    const before = raw();
    const order = kidsOf("B1").map((n) => n.id);
    const r = await op({ op: "paste", payload: c.body.payload, replace: ["R1", "E1"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.label, "Paste to Replace");
    assert.equal(r.body.select.length, 2);
    await flush();
    const kids = kidsOf("B1");
    assert.equal(findIn(doc().children, "R1"), undefined, "R1 is gone");
    assert.equal(findIn(doc().children, "E1"), undefined, "E1 is gone");
    const [a, b] = r.body.select.map((id: string) => kids.find((k) => k.id === id));
    assert.deepEqual([a.type, a.fill, a.x, a.y], ["rectangle", "#0000FF", 10, 20], "at R1's spot");
    assert.deepEqual([b.x, b.y], [200, 120], "at E1's spot");
    assert.equal(kids.indexOf(a), order.indexOf("R1"), "at R1's index");
    assert.equal(kids.indexOf(b), order.indexOf("E1"), "at E1's index");
    assert.equal((await undo()).status, 200);
    assert.equal(raw(), before, "one undo puts both back");
  });

  test("several copied layers keep their arrangement; in auto layout the copy takes the index", async () => {
    const c = await op({ op: "copy", ids: ["Star", "Lbl"], rects: { Star: { x: 5, y: 605, w: 24, h: 12 }, Lbl: { x: 5, y: 630, w: 14, h: 20 } } });
    const r = await op({ op: "paste", payload: c.body.payload, replace: ["Top"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await flush();
    const [s, l] = r.body.select.map((id: string) => findIn(doc().children, id));
    assert.deepEqual([s.x, s.y, l.x, l.y], [300, 300, 300, 325], "the group's top-left at Top's, 25 apart as before");
    await undo();
    const c2 = await op({ op: "copy", ids: ["Star"] });
    const r2 = await op({ op: "paste", payload: c2.body.payload, replace: ["A2"] });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    await flush();
    assert.deepEqual(kidsOf("Row").map((n) => n.id), ["A1", r2.body.select[0], "A3"], "the second child, replaced in place");
    await undo();
  });

  test("a clipboard of cards only, or nothing selected, is refused", async () => {
    const note = await call("POST", "/api/widgets" + q(P), { kind: "note", name: "Memo", x: 900, y: 0, config: { text: "hi" } });
    const c = await op({ op: "copy", ids: ["widget:" + note.body.widget.id] });
    assert.equal((await op({ op: "paste", payload: c.body.payload, replace: ["R1"] })).status, 400);
    const c2 = await op({ op: "copy", ids: ["Star"] });
    assert.equal((await op({ op: "paste", payload: c2.body.payload, replace: ["nope"] })).status, 404);
  });
});

describe("paste into several frames", () => {
  test("one copy into each frame, one undo", async () => {
    const c = await op({ op: "copy", ids: ["Star", "Lbl"] });
    const before = raw();
    const r = await op({ op: "paste", payload: c.body.payload, places: [{ parent: "F1", positions: [null, null] }, { parent: "F2", positions: [null, null] }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.select.length, 4);
    await flush();
    assert.deepEqual(kidsOf("F1").map((n) => [n.fill, n.x, n.y]), [["#0000FF", 5, 5], ["#000000", 5, 30]], "their own x/y in F1");
    assert.deepEqual(kidsOf("F2").map((n) => [n.fill, n.x, n.y]), [["#0000FF", 5, 5], ["#000000", 5, 30]], "and in F2");
    assert.equal(new Set(r.body.select).size, 4, "fresh ids for each copy");
    assert.equal((await undo()).status, 200);
    assert.equal(raw(), before);
  });
});

describe("the page's half", () => {
  const key = (o: Record<string, unknown>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", code: "", ...o });
  test("Shift+Cmd+R is Paste to replace (the app's Edit menu owns it)", () => {
    assert.deepEqual(keyAction(key({ metaKey: true, shiftKey: true, code: "KeyR" })), { op: "pasteReplace", menu: true });
    assert.equal(keyAction(key({ metaKey: true, code: "KeyR" })), null, "Cmd+R is Rename");
  });

  test("plain text becomes an Inter text layer centred on the point: auto width when short, 400 wide when long", () => {
    const t = textLayer("Hello there\nsecond line", { x: 100, y: 100 });
    assert.equal(t.type, "text");
    assert.equal(t.content, "Hello there\nsecond line");
    assert.equal(t.name, "Hello there");
    assert.equal(t.fontFamily, "Inter");
    assert.equal(t.fontSize, 14);
    assert.equal(t.textGrowth, "auto");
    assert.equal(t.letterSpacing, -0.09, "Inter Dynamic Metrics at 14 px");
    assert.equal(t.lineHeight, 1.45);
    assert.deepEqual(t.metadata, { type: "canvas", canvasLetterSpacing: "auto" });
    assert.ok(t.x < 100 && t.y < 100, "the box is centred on the point");
    const long = textLayer("word ".repeat(80), { x: 0, y: 0 });
    assert.deepEqual([long.textGrowth, long.width], ["fixed-width", 400]);
    assert.equal(long.name.length <= 40, true, "the name is the start of the text");
    assert.equal(textLayer("x\r\ny", { x: 0, y: 0 }).content, "x\ny", "line ends as \\n");
    assert.equal(textLayer("   ", { x: 0, y: 0 }), null, "nothing but spaces: nothing to paste");
  });

  test("several frames selected: one target each; a mixed selection or one copied frame is not", () => {
    const fr = (id: string, extra = {}) => ({ id, isContainer: true, type: "frame", rect: { x: 0, y: 0, w: 10, h: 10 }, ...extra });
    const payload = { nodes: [{ id: "Star" }], rects: [null] };
    assert.equal(frameTargets([fr("F1"), fr("F2")], payload).length, 2);
    assert.equal(frameTargets([fr("F1")], payload), null, "one frame: the usual paste");
    assert.equal(frameTargets([fr("F1"), { id: "R1", isContainer: false, type: "rectangle" }], payload), null);
    assert.equal(frameTargets([fr("F1"), fr("G", { type: "group" })], payload), null, "frames only");
    assert.equal(frameTargets([fr("F1"), fr("Star")], payload), null, "a copied frame is not pasted into itself");
  });

  test("Space held: a paste with a frame selected goes beside it, not in it", () => {
    const target = { id: "F1", isContainer: true, placesChildren: false, parentId: "B1", parentPlaces: false, index: 3, rect: { x: 350, y: 10, w: 100, h: 100 }, parentRect: { x: 0, y: 0, w: 600, h: 400 } };
    const payload = { nodes: [{ id: "Star", x: 5, y: 5 }], rects: [{ x: 5, y: 605, w: 24, h: 12 }], parents: ["Src"] };
    assert.equal(pastePlace({ target, payload }).parent, "F1");
    const kept = pastePlace({ target, payload, keep: true });
    assert.deepEqual([kept.parent, kept.index], ["B1", 4], "a sibling after the frame");
  });

  test("into a smaller frame: the copy keeps its x/y on an axis that fits and is centred on one that does not", () => {
    const frame = (w: number, h: number) => ({ id: "F", isContainer: true, placesChildren: false, parentId: "B1", index: 0, rect: { x: 1000, y: 1000, w, h }, parentRect: null });
    const payload = { nodes: [{ id: "R", x: 300, y: 20 }], rects: [{ x: 300, y: 20, w: 70, h: 50 }], parents: ["Other"] };
    assert.deepEqual(pastePlace({ target: frame(240, 150), payload }).positions, [{ x: 85, y: 20 }], "x does not fit: centred; y fits: kept");
    assert.deepEqual(pastePlace({ target: frame(400, 60), payload }).positions, [{ x: 300, y: 5 }], "y does not fit: centred");
    assert.deepEqual(pastePlace({ target: frame(400, 400), payload }).positions, [null], "fits: its own x/y");
    const two = { nodes: [{ id: "A", x: 200, y: 0 }, { id: "B", x: 260, y: 0 }], rects: [{ x: 0, y: 0, w: 40, h: 40 }, { x: 60, y: 0, w: 40, h: 40 }], parents: ["Other", "Other"] };
    assert.deepEqual(pastePlace({ target: frame(120, 100), payload: two }).positions, [{ x: 10, y: 0 }, { x: 70, y: 0 }], "several: centred as a group, their spacing kept");
  });

  test("Space held: a drop lands on the canvas, not in the frame under it", () => {
    const info = (id: string) => ({ F1: { type: "frame" }, B1: { type: "frame" } } as Record<string, unknown>)[id] ?? null;
    assert.equal(dropParent(["B1", "F1"], info), "F1");
    assert.equal(dropParent(["B1", "F1"], info, true), null);
  });
});
