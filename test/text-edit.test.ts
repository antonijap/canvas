// Inline text editing: the page's pure helpers (src/page/text-edit.js: fonts, CSS, rotation, words, the editor's
// own undo history, what a commit writes) and the write (src/textedit.ts, POST /api/text): one undo step per edit,
// never merged, empty text deletes the layer in one step, instance overrides (nested, replacements), refusals.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
// @ts-ignore: a plain ES module the page imports too
import * as T from "../src/page/text-edit.js";

// ---------------------------------------------------------------- the pure half

describe("fonts the editor uses", () => {
  test("the node's family, plain face first, then its subsets in tag order, then the system fallback", () => {
    const fonts = [
      { family: "Inter\u001f2:cyrillic", weight: 400, style: "normal", url: "/f/cyr" },
      { family: "Inter", weight: 400, style: "normal", url: "/f/latin" },
      { family: "system-ui\u001f1:Lucida Grande", weight: 400, style: "normal", url: "/f/lucida" },
      { family: "Roboto", weight: 400, style: "normal", url: "/f/roboto" },
    ];
    const p = T.fontPlan(fonts, "Inter");
    assert.equal(p.faces.length, 2);
    assert.equal(p.faces[0].url, "/f/latin");
    assert.equal(p.faces[1].url, "/f/cyr");
    assert.equal(p.faces[0].weight, "1 1000", "one file for the family takes every weight (a variable face)");
    const names = p.stack.split(",");
    assert.equal(names.length, 4);
    assert.equal(names[0], JSON.stringify(p.faces[0].name));
    assert.equal(names[1], JSON.stringify(p.faces[1].name));
    assert.deepEqual(names.slice(2), ["system-ui", "sans-serif"]);
  });
  test("several files of one family keep their own weights and styles", () => {
    const p = T.fontPlan([
      { family: "Lora", weight: 400, style: "normal", url: "/a" },
      { family: "Lora", weight: 700, style: "normal", url: "/b" },
      { family: "Lora", weight: 400, style: "italic", url: "/c" },
    ], "lora");
    assert.deepEqual(p.faces.map((f: any) => [f.url, f.weight, f.style]), [["/a", "400", "normal"], ["/b", "700", "normal"], ["/c", "400", "italic"]]);
    assert.equal(new Set(p.faces.map((f: any) => f.name)).size, 1);
  });
  test("the system font draws as system-ui; an unlisted family by its own name", () => {
    assert.deepEqual(T.fontPlan([], "SF Pro Text"), { faces: [], stack: "system-ui,sans-serif" });
    assert.deepEqual(T.fontPlan([], "system-ui"), { faces: [], stack: "system-ui,sans-serif" });
    assert.equal(T.fontPlan([], "Comic Neue").stack, '"Comic Neue",system-ui,sans-serif');
  });
});

describe("the editor's CSS matches the engine's text layout", () => {
  test("defaults: 13 px, line height 1.45, weight 400, left, auto width does not wrap", () => {
    const c = T.textCss({ type: "text", content: "x" }, "s");
    assert.deepEqual(c, { fontFamily: "s", fontSize: "13px", fontWeight: "400", fontStyle: "normal", letterSpacing: "0px", lineHeight: "1.45", textAlign: "left", whiteSpace: "pre", overflowWrap: "normal", textTransform: "none", fontFeatureSettings: "normal" });
  });
  test("letter case: the field draws its letters in the layer's case, so the caret sits where the canvas draws them", () => {
    assert.equal(T.textCss({ letterCase: "upper" }, "s").textTransform, "uppercase");
    assert.equal(T.textCss({ letterCase: "title" }, "s").textTransform, "none", "title case: the field wraps each word's first letter (wordStarts), not CSS capitalize, whose words differ between Chrome and WebKit");
    assert.equal(T.textCss({ letterCase: "small-caps" }, "s").fontFeatureSettings, '"smcp" 1');
  });
  test("given values, a fixed width wraps like the engine (pre-wrap, break-word)", () => {
    const c = T.textCss({ fontSize: 20, fontWeight: "600", fontStyle: "Italic", letterSpacing: -0.4, lineHeight: 1.2, textAlign: "center", textGrowth: "fixed-width" }, "s");
    assert.equal(c.fontSize, "20px");
    assert.equal(c.fontWeight, "600");
    assert.equal(c.fontStyle, "italic");
    assert.equal(c.letterSpacing, "-0.4px");
    assert.equal(c.lineHeight, "1.2");
    assert.equal(c.textAlign, "center");
    assert.equal(c.whiteSpace, "pre-wrap");
    assert.equal(c.overflowWrap, "break-word");
  });
  test("weights as the engine reads them", () => {
    assert.equal(T.weightOf("bold"), 700);
    assert.equal(T.weightOf("regular"), 400);
    assert.equal(T.weightOf(" 500 "), 500);
    assert.equal(T.weightOf(undefined), 400);
    assert.equal(T.weightOf(300), 300);
  });
  test("caret colour: the text's solid colour, else black", () => {
    assert.equal(T.caretOf({ fill: "#FF0000" }), "#FF0000");
    assert.equal(T.caretOf({ fill: "#11223380" }), "#112233");
    assert.equal(T.caretOf({ fill: [{ type: "gradient" }, { type: "color", color: "#00FF00" }] }), "#00FF00");
    assert.equal(T.caretOf({ fill: { type: "gradient" } }), "#000000");
    assert.equal(T.caretOf({}), "#000000");
  });
  test("the mirror keeps an empty last line", () => {
    assert.equal(T.mirrorText(""), "​");
    assert.equal(T.mirrorText("a\n"), "a\n​");
    assert.equal(T.mirrorText("a"), "a");
  });
});

describe("rotation", () => {
  test("the rotation is the node's and its ancestors'", () => {
    const root = { id: "B", rotation: 10, children: [{ id: "F", children: [{ id: "T", type: "text", rotation: 20 }] }] };
    const p = T.pathTo(root, "T");
    assert.deepEqual(p.map((n: any) => n.id), ["B", "F", "T"]);
    assert.equal(T.rotationOf(p), 30);
    assert.equal(T.pathTo(root, "nope"), null);
  });
  test("the top-left of a turned box from its bounds", () => {
    assert.deepEqual(T.originFromBounds({ x: 5, y: 6, w: 10, h: 4 }, 10, 4, 0), { x: 5, y: 6 });
    // 90° counter-clockwise (CSS rotate(-90deg) about the top-left): the box goes up from the origin.
    const o = T.originFromBounds({ x: 0, y: -10, w: 4, h: 10 }, 10, 4, 90);
    assert.ok(Math.abs(o.x - 0) < 1e-9 && Math.abs(o.y - 0) < 1e-9, JSON.stringify(o));
    // Round trip at an odd angle.
    const deg = 33, w = 120, h = 30, t = (-deg * Math.PI) / 180;
    const xs = [0, w * Math.cos(t), -h * Math.sin(t), w * Math.cos(t) - h * Math.sin(t)].map((x) => x + 50);
    const ys = [0, w * Math.sin(t), h * Math.cos(t), w * Math.sin(t) + h * Math.cos(t)].map((y) => y + 70);
    const b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const r = T.originFromBounds(b, w, h, deg);
    assert.ok(Math.abs(r.x - 50) < 1e-9 && Math.abs(r.y - 70) < 1e-9, JSON.stringify(r));
  });
});

describe("words, keys and what a commit writes", () => {
  test("the word under the caret, the word just before it, a run of spaces", () => {
    const s = "Hello brave  world";
    assert.deepEqual(T.wordRange(s, 2), [0, 5]);
    assert.deepEqual(T.wordRange(s, 5), [0, 5], "just past a word's last letter");
    assert.deepEqual(T.wordRange(s, 6), [6, 11]);
    assert.deepEqual(T.wordRange(s, s.length), [13, 18]);
    assert.deepEqual(T.wordRange("", 0), [0, 0]);
    const sp = T.wordRange(s, 11);
    assert.deepEqual(sp, [6, 11], "between a word and spaces: the word");
  });
  test("commitPlan: nothing, a write, or a delete (never for a layer inside an instance)", () => {
    assert.deepEqual(T.commitPlan("Hi", "Hi", "T"), { kind: "none" });
    assert.deepEqual(T.commitPlan("Hi", "Hi\r\nthere", "T"), { kind: "write", content: "Hi\nthere" });
    assert.deepEqual(T.commitPlan("Hi", "", "T"), { kind: "delete" });
    assert.deepEqual(T.commitPlan("Hi", "", "Inst/Label"), { kind: "write", content: "" });
    assert.deepEqual(T.commitPlan(undefined, "", "T"), { kind: "none" });
  });
  test("keys: Esc and Cmd+Enter commit, Enter is the textarea's (a new line), Cmd+Z is the editor's unless the app's menu owns it", () => {
    const k = (o: any, native = false) => T.keyIntent({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o }, native);
    assert.equal(k({ key: "Escape" }), "commit");
    assert.equal(k({ key: "Enter", metaKey: true }), "commit");
    assert.equal(k({ key: "Enter", ctrlKey: true }), "commit");
    assert.equal(k({ key: "Enter" }), null);
    assert.equal(k({ key: "Enter", shiftKey: true }), null);
    assert.equal(k({ key: "Tab" }), "tab");
    assert.equal(k({ key: "z", code: "KeyZ", metaKey: true }), "undo");
    assert.equal(k({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true }), "redo");
    assert.equal(k({ key: "y", code: "KeyY", ctrlKey: true }), "redo");
    assert.equal(k({ key: "z", code: "KeyZ", metaKey: true }, true), null, "in the app the Edit menu sends {cmd: undo}");
    assert.equal(k({ key: "a", code: "KeyA", metaKey: true }), "selectAll", "Cmd+A selects the text, never the canvas");
    assert.equal(k({ key: "a", code: "KeyA", metaKey: true }, true), "selectAll");
    assert.equal(k({ key: "ArrowLeft", altKey: true }), null);
    assert.equal(k({ key: "k", code: "KeyK" }), null);
  });
  test("commitPlan with styled ranges: a style change alone is a write; ranges go with the content", () => {
    const sp = [{ start: 0, end: 2, fontWeight: "700" }];
    assert.deepEqual(T.commitPlan("Hi", "Hi", "T", [], sp), { kind: "write", content: "Hi", spans: sp });
    assert.deepEqual(T.commitPlan("Hi", "Hi", "T", sp, sp.map((s) => ({ ...s }))), { kind: "none" });
    assert.deepEqual(T.commitPlan("Hi", "Hey", "T", sp, sp), { kind: "write", content: "Hey", spans: sp });
    assert.deepEqual(T.commitPlan("Hi", "Hey", "T"), { kind: "write", content: "Hey" }, "no ranges anywhere: as before");
    assert.deepEqual(T.commitPlan("Hi", "", "T", sp, []), { kind: "delete" });
  });
  test("keys: the text style keys style the selected letters while editing", () => {
    const k = (o: any) => T.keyIntent({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
    assert.equal(k({ code: "KeyB", metaKey: true }), "style:bold");
    assert.equal(k({ code: "KeyI", metaKey: true }), "style:italic");
    assert.equal(k({ code: "KeyU", metaKey: true }), "style:underline");
    assert.equal(k({ code: "KeyX", metaKey: true, shiftKey: true }), "style:strike");
    assert.equal(k({ code: "Period", metaKey: true, shiftKey: true }), "style:bigger");
    assert.equal(k({ code: "Comma", metaKey: true, shiftKey: true }), "style:smaller");
    assert.equal(k({ code: "Period", altKey: true }), "style:tracking+");
    assert.equal(k({ code: "Comma", altKey: true, metaKey: true }), "style:weight-");
    assert.equal(k({ code: "Period", altKey: true, shiftKey: true }), "style:leading+");
    assert.equal(k({ code: "KeyX", metaKey: true }), null, "Cut stays the text's");
  });
  test("styleStep: what a style key sets on each stretch of the selection, from its own value", () => {
    const base = { fontWeight: "400", fontSize: 16 };
    const sp = [{ start: 2, end: 4, fontWeight: "700" }];
    // Bold over plain and bold letters: all bold; over bold letters only: back to the layer's weight.
    assert.deepEqual(T.styleStep(sp, 0, 4, base, 6, "bold"), [{ start: 0, end: 4, fontWeight: "700" }]);
    assert.deepEqual(T.styleStep(sp, 2, 4, base, 6, "bold"), []);
    assert.deepEqual(T.styleStep([], 0, 3, base, 6, "italic"), [{ start: 0, end: 3, fontStyle: "italic" }]);
    assert.deepEqual(T.styleStep([], 0, 3, base, 6, "underline"), [{ start: 0, end: 3, underline: true }]);
    // Size and weight step each stretch from its own value.
    assert.deepEqual(T.styleStep([{ start: 0, end: 2, fontSize: 20 }], 0, 4, base, 6, "bigger"), [{ start: 0, end: 2, fontSize: 21 }, { start: 2, end: 4, fontSize: 17 }]);
    assert.deepEqual(T.styleStep(sp, 0, 4, base, 6, "weight+"), [{ start: 0, end: 2, fontWeight: "500" }, { start: 2, end: 4, fontWeight: "800" }]);
    assert.deepEqual(T.styleStep([], 0, 2, { ...base, letterSpacing: 0.2 }, 6, "tracking+"), [{ start: 0, end: 2, letterSpacing: 0.3 }]);
  });
  test("nextEdit: a plain click on another text layer while editing edits that one", () => {
    const base = { editing: "A", leaf: "B", isText: true, button: 0, shift: false, meta: false, alt: false, hand: false };
    const n = (o: any) => T.nextEdit({ ...base, ...o });
    assert.equal(n({}), "B");
    assert.equal(n({ leaf: "Inst/Label" }), "Inst/Label", "text inside an instance edits as an override");
    assert.equal(n({ leaf: "A" }), null, "the same layer: the editor has the click");
    assert.equal(n({ isText: false }), null, "not text: the click only ends the edit");
    assert.equal(n({ leaf: null }), null, "empty canvas");
    assert.equal(n({ leaf: "widget:x" }), null, "a card");
    assert.equal(n({ editing: null }), null, "no edit open");
    for (const o of [{ shift: true }, { meta: true }, { alt: true }, { hand: true }, { button: 2 }]) assert.equal(n(o), null, JSON.stringify(o));
  });
});

describe("the editor's undo history", () => {
  const S = (value: string, start = value.length, end = start) => ({ value, start, end });
  test("typing in one run is one step; a pause, a jump or a different kind starts another", () => {
    const h = new T.TextHistory();
    let cur = S("");
    h.end(cur);
    const type = (ch: string, now: number) => { h.begin(cur, "insert", now); cur = S(cur.value + ch); h.end(cur); };
    type("a", 0); type("b", 100); type("c", 200);
    type("d", 5000); // after a pause
    assert.deepEqual(h.undo(cur), S("abc"));
    cur = S("abc");
    assert.deepEqual(h.undo(cur), S(""));
    cur = S("");
    assert.equal(h.undo(cur), null);
    assert.deepEqual(h.redo(cur), S("abc"));
    cur = S("abc");
    assert.deepEqual(h.redo(cur), S("abcd"));
  });
  test("a delete after typing is its own step; a new input clears redo", () => {
    const h = new T.TextHistory();
    let cur = S("hello");
    h.end(cur);
    h.begin(cur, "insert", 0); cur = S("hello!"); h.end(cur);
    h.begin(cur, "delete", 10); cur = S("hello"); h.end(cur);
    assert.deepEqual(h.undo(cur), S("hello!"));
    cur = S("hello!");
    h.begin(cur, "insertFromPaste", 20); cur = S("hello!xx"); h.end(cur);
    assert.equal(h.redo(cur), null, "redo went with the new input");
    assert.deepEqual(h.undo(cur), S("hello!"));
  });
  test("inputKind", () => {
    assert.equal(T.inputKind("insertText"), "insert");
    assert.equal(T.inputKind("deleteContentBackward"), "delete");
    assert.equal(T.inputKind("deleteByCut"), "deleteByCut");
    assert.equal(T.inputKind("insertLineBreak"), "insertLineBreak");
  });
});

// ---------------------------------------------------------------- the write

const dir = tmpDir("textedit");
process.env.CANVAS_ROOTS = dir;
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B1", name: "Board", x: 0, y: 0, width: 400, height: 300, layout: "none", children: [
      { type: "text", id: "T", x: 10, y: 10, content: "Hello", fontFamily: "Inter", fontSize: 14 },
      { type: "text", id: "T2", x: 10, y: 40, content: "Other", fontFamily: "Inter", fontSize: 14 },
      { type: "rectangle", id: "R", x: 10, y: 80, width: 20, height: 20, fill: "#FF0000" },
      { type: "ref", id: "Inst", ref: "Btn", x: 100, y: 100, descendants: { BtnLabel: { fontSize: 12 } } },
      { type: "ref", id: "Inst2", ref: "Card", x: 100, y: 160 },
      { type: "ref", id: "Inst3", ref: "Card", x: 100, y: 220, descendants: { CardBtn: { type: "ref", id: "Rep", ref: "Btn", descendants: {} } } },
    ] },
    { type: "frame", id: "Btn", reusable: true, x: 600, y: 0, width: 80, height: 30, layout: "horizontal", children: [
      { type: "text", id: "BtnLabel", content: "Go", fontFamily: "Inter", fontSize: 13 },
    ] },
    { type: "frame", id: "Card", reusable: true, x: 800, y: 0, width: 120, height: 60, layout: "vertical", children: [
      { type: "text", id: "CardTitle", content: "Title", fontFamily: "Inter", fontSize: 13 },
      { type: "ref", id: "CardBtn", ref: "Btn" },
    ] },
  ],
};
const docFile = path.join(dir, "text.canvas.json");
fs.writeFileSync(docFile, JSON.stringify(DOC, null, 2));
const file = fs.realpathSync(docFile);
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const pw = await import("../src/docwriter.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(() => {
  fs.unwatchFile(file);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let clock = 9_000_000;
history.setClock(() => clock);

async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const text = (id: string, content: unknown) => call("POST", "/api/text", { file, id, content });
const q = `?file=${encodeURIComponent(file)}`;
const mem = () => pw.currentDoc(file).doc as any;
const find = (id: string, doc = mem()) => {
  const seek = (ns: any[]): any => { for (const n of ns) { if (n.id === id) return n; const h = n.children && seek(n.children); if (h) return h; } };
  return seek(doc.children);
};
const hist = async () => (await call("GET", `/api/history${q}`)).body;

beforeEach(async () => {
  fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
  await call("POST", "/api/update", { file, id: "B1", props: {} }); // the first-write refusal after an outside change
  history.resetHistory();
  clock += 5000;
});

describe("POST /api/text", () => {
  test("a text layer: its content, one undo step named Edit Text; undo and redo", async () => {
    const r = await text("T", "Hello\nthere");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    assert.equal(find("T").content, "Hello\nthere");
    const h = await hist();
    assert.equal(h.undo, "Edit Text");
    assert.equal(h.undoDepth, 1);
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    assert.equal(find("T").content, "Hello");
    assert.equal((await call("POST", `/api/history/redo${q}`)).status, 200);
    assert.equal(find("T").content, "Hello\nthere");
  });

  test("two edits of the same layer a moment apart are two steps (never merged)", async () => {
    assert.equal((await text("T", "One")).status, 200);
    assert.equal((await text("T", "Two")).status, 200);
    assert.equal((await hist()).undoDepth, 2);
    await call("POST", `/api/history/undo${q}`);
    assert.equal(find("T").content, "One");
  });

  test("the same text: no write, no step", async () => {
    const r = await text("T", "Hello");
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, false);
    assert.equal((await hist()).undoDepth, 0);
  });

  test("CRLF lands as LF", async () => {
    await text("T", "a\r\nb\rc");
    assert.equal(find("T").content, "a\nb\nc");
  });

  test("empty text deletes the layer in one step; undo brings it back where it was", async () => {
    const r = await text("T", "");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deleted, true);
    assert.equal(find("T"), undefined);
    const h = await hist();
    assert.equal(h.undoDepth, 1);
    assert.equal(h.undo, "Delete");
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    assert.deepEqual(find("T"), DOC.children[0].children![0]);
    assert.equal(find("B1").children[0].id, "T", "back at its index");
  });

  test("text inside an instance: an override on the instance, merged with what it had; the component untouched", async () => {
    const r = await text("Inst/BtnLabel", "Buy");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(find("Inst").descendants, { BtnLabel: { fontSize: 12, content: "Buy" } });
    assert.equal(find("BtnLabel").content, "Go");
    const h = await hist();
    assert.equal(h.undo, "Edit Text");
    await call("POST", `/api/history/undo${q}`);
    assert.deepEqual(find("Inst").descendants, { BtnLabel: { fontSize: 12 } });
  });

  test("a nested instance: the outer instance holds the override, keyed by the path below it", async () => {
    const r = await text("Inst2/CardBtn/BtnLabel", "Nested");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(find("Inst2").descendants, { "CardBtn/BtnLabel": { content: "Nested" } });
    assert.equal(find("BtnLabel").content, "Go");
    // What the board draws now.
    const scene = (await call("GET", `/api/scene${q}&id=B1`)).body;
    const seek = (n: any): any => (n.id === "Inst2/CardBtn/BtnLabel" ? n : (n.children || []).map(seek).find(Boolean));
    assert.equal(seek(scene.root).content, "Nested");
  });

  test("a layer below a replacement instance: the override goes on the replacement", async () => {
    const r = await text("Rep/BtnLabel", "Swapped");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(find("Inst3").descendants.CardBtn.descendants, { BtnLabel: { content: "Swapped" } });
  });

  test("empty text inside an instance stays an empty override (an instance's layer cannot be deleted)", async () => {
    const r = await text("Inst/BtnLabel", "");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deleted, undefined);
    assert.equal(find("Inst").descendants.BtnLabel.content, "");
  });

  test("refusals: not text, no such layer, bad bodies, no header", async () => {
    assert.equal((await text("R", "x")).status, 400);
    // A layer the file does not hold: 404 "deleted" (hunt 6: it used to blame a component, 409).
    assert.equal((await text("Nope", "x")).status, 404);
    assert.equal((await text("Inst/Nope", "x")).status, 404);
    assert.equal((await text("T", 5)).status, 400);
    assert.equal((await call("POST", "/api/text", { file, content: "x" })).status, 400);
    const r = await fetch(base + "/api/text", { method: "POST", body: JSON.stringify({ file, id: "T", content: "x" }) });
    assert.equal(r.status, 403);
    assert.equal(find("T").content, "Hello");
    assert.equal((await hist()).undoDepth, 0);
  });

  test("the page serves the editor module", async () => {
    const r = await fetch(base + "/page/text-edit.js");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /export function fontPlan/);
  });
});

describe("find and replace (GET /api/search/text, POST /api/replace)", () => {
  const replace = (b: Record<string, unknown>) => call("POST", "/api/replace", { file, ...b });
  test("findAll: literal, case, whole words, no overlaps", async () => {
    const { findAll } = await import("../src/search.ts");
    assert.deepEqual(findAll("Go go GO", "go"), [0, 3, 6]);
    assert.deepEqual(findAll("Go go GO", "go", { matchCase: true }), [3]);
    assert.deepEqual(findAll("go gone ago go", "go", { wholeWord: true }), [0, 12]);
    assert.deepEqual(findAll("aaaa", "aa"), [0, 2]);
    assert.deepEqual(findAll("abc", ""), []);
  });
  test("find lists every occurrence in every text layer, components included, with snippets", async () => {
    const r = await call("GET", `/api/search/text${q}&q=o`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const where = r.body.matches.map((m: any) => m.id + ":" + m.start);
    assert.deepEqual(where, ["T:4", "T2:0", "BtnLabel:1"]);
    assert.equal(r.body.total, 3);
    assert.equal(r.body.layers, 3);
    assert.deepEqual(r.body.matches[0].ranges, [[4, 1]]);
  });
  test("replace all: every layer, one undo step named Replace Text; undo brings every one back", async () => {
    const r = await replace({ query: "o", replacement: "0" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.replaced, r.body.layers], [3, 3]);
    assert.deepEqual([find("T").content, find("T2").content, find("BtnLabel").content], ["Hell0", "0ther", "G0"]);
    const h = await hist();
    assert.deepEqual([h.undo, h.undoDepth], ["Replace Text", 1]);
    await call("POST", `/api/history/undo${q}`);
    assert.deepEqual([find("T").content, find("T2").content, find("BtnLabel").content], ["Hello", "Other", "Go"]);
  });
  test("replace one: only the occurrence the find bar shows; a stale one is refused", async () => {
    await call("POST", "/api/text", { file, id: "T", content: "lo lo lo" });
    const r = await replace({ query: "lo", replacement: "hi", only: { id: "T", start: 3 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("T").content, "lo hi lo");
    assert.equal((await replace({ query: "lo", replacement: "hi", only: { id: "T", start: 3 } })).status, 409);
    assert.equal((await replace({ query: "", replacement: "x" })).status, 400);
    assert.equal((await replace({ query: "x" })).status, 400);
    const none = await replace({ query: "zzz", replacement: "x" });
    assert.deepEqual([none.status, none.body.replaced], [200, 0]);
  });
  test("POST /api/text with styled ranges: one step; a style change alone is a write; bad ranges refused", async () => {
    const r = await call("POST", "/api/text", { file, id: "T", content: "Hello", spans: [{ start: 0, end: 2, fontWeight: "700", fill: "#ff0000" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true, "same letters, new style");
    assert.deepEqual(find("T").spans, [{ start: 0, end: 2, fontWeight: "700", fill: "#ff0000" }]);
    assert.equal((await hist()).undo, "Edit Text");
    assert.equal((await call("POST", "/api/text", { file, id: "T", content: "Hello", spans: [{ start: 0, end: 9, fontWeight: "700" }] })).status, 400);
    assert.equal((await call("POST", "/api/text", { file, id: "T", content: "Hello", spans: [{ start: 0, end: 2, color: "#fff" }] })).status, 400);
    const same = await call("POST", "/api/text", { file, id: "T", content: "Hello", spans: [{ start: 0, end: 2, fontWeight: "700", fill: "#ff0000" }] });
    assert.equal(same.body.changed, false);
    // No spans: the ranges come off.
    await call("POST", "/api/text", { file, id: "T", content: "Hello", spans: [] });
    assert.equal(find("T").spans, undefined);
    await call("POST", `/api/history/undo${q}`);
    assert.deepEqual(find("T").spans, [{ start: 0, end: 2, fontWeight: "700", fill: "#ff0000" }], "undo brings them back");
    // Text inside an instance: the ranges go in the override.
    await call("POST", "/api/text", { file, id: "Inst/BtnLabel", content: "Go on", spans: [{ start: 3, end: 5, fontStyle: "italic" }] });
    assert.deepEqual(find("Inst").descendants.BtnLabel.spans, [{ start: 3, end: 5, fontStyle: "italic" }]);
  });
  test("POST /api/text with lists: one step; a list change alone is a write; bad lists refused; content edits carry them", async () => {
    const r = await call("POST", "/api/text", { file, id: "T", content: "One\nTwo", lists: [{ p: 0, type: "bullet", level: 1 }, { p: 1, type: "number", level: 2 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(find("T").lists, [{ p: 0, type: "bullet", level: 1 }, { p: 1, type: "number", level: 2 }]);
    assert.equal((await hist()).undo, "Edit Text");
    assert.equal((await call("POST", "/api/text", { file, id: "T", content: "One", lists: [{ p: 1, type: "bullet" }] })).status, 400, "past the last paragraph");
    assert.equal((await call("POST", "/api/text", { file, id: "T", content: "One", lists: [{ p: 0, type: "dash" }] })).status, 400, "an unknown kind");
    const same = await call("POST", "/api/text", { file, id: "T", content: "One\nTwo", lists: [{ p: 0, type: "bullet", level: 1 }, { p: 1, type: "number", level: 2 }] });
    assert.equal(same.body.changed, false);
    // A write without lists: they follow the new content ("New" and a newline typed at the start of "Two").
    await text("T", "One\nNew\nTwo");
    assert.deepEqual(find("T").lists, [{ p: 0, type: "bullet", level: 1 }, { p: 1, type: "number", level: 2 }, { p: 2, type: "number", level: 2 }], "the new paragraph takes the list of the one it was typed into");
    await call("POST", "/api/text", { file, id: "T", content: "One\nNew\nTwo", lists: [] });
    assert.equal(find("T").lists, undefined, "an empty list takes them off");
    // Paragraph settings are plain props.
    const u = await call("POST", "/api/update", { file, id: "T", props: { paragraphSpacing: 12, paragraphIndent: 20 } });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal((await call("POST", "/api/update", { file, id: "T", props: { paragraphSpacing: -1 } })).status, 422, "a validation error");
  });
  test("multi-edit: also names more layers; all take the text in one step; undo brings each back", async () => {
    const r = await call("POST", "/api/text", { file, id: "T", also: ["T2", "Inst/BtnLabel"], content: "Same" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([find("T").content, find("T2").content, find("Inst").descendants.BtnLabel.content], ["Same", "Same", "Same"]);
    assert.deepEqual([(await hist()).undo, (await hist()).undoDepth], ["Edit Text", 1]);
    await call("POST", `/api/history/undo${q}`);
    assert.deepEqual([find("T").content, find("T2").content, find("Inst").descendants.BtnLabel.content], ["Hello", "Other", undefined]);
    assert.equal((await call("POST", "/api/text", { file, id: "T", also: ["R"], content: "x" })).status, 400, "a rectangle in the set: refused, nothing written");
    assert.equal(find("T").content, "Hello");
    // Emptied: every layer goes, one step.
    const d = await call("POST", "/api/text", { file, id: "T", also: ["T2"], content: "" });
    assert.equal(d.body.deleted, true);
    assert.equal(find("T") ?? find("T2"), undefined);
  });
  test("a whole-layer style wins over the ranges'; content edits carry the ranges along", async () => {
    await call("POST", "/api/update", { file, id: "T", props: { content: "Hello world", spans: [{ start: 0, end: 5, fontWeight: "700", fill: "#ff0000" }] } });
    await call("POST", "/api/update", { file, id: "T", props: { fontWeight: "300" } });
    assert.deepEqual(find("T").spans, [{ start: 0, end: 5, fill: "#ff0000" }], "the weight is the layer's now");
    await call("POST", "/api/update", { file, id: "T", props: { content: "So, Hello world" } });
    assert.deepEqual(find("T").spans, [{ start: 0, end: 9, fill: "#ff0000" }], "typed at the very start: it takes the first letter's style");
    await call("POST", "/api/update", { file, id: "T", props: { fill: "#00ff00" } });
    assert.equal(find("T").spans, undefined, "nothing left to set: no ranges");
  });
  test("styled ranges follow the replacement", async () => {
    const u = await call("POST", "/api/update", { file, id: "T", props: { content: "Hello world", spans: [{ start: 6, end: 11, fontWeight: "700" }] } });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.deepEqual(find("T").spans, [{ start: 6, end: 11, fontWeight: "700" }]);
    await replace({ query: "Hello", replacement: "Hi" });
    assert.equal(find("T").content, "Hi world");
    assert.deepEqual(find("T").spans, [{ start: 3, end: 8, fontWeight: "700" }]);
    await replace({ query: "world", replacement: "there" });
    assert.deepEqual(find("T").spans, [{ start: 3, end: 8, fontWeight: "700" }], "a replaced word keeps its style");
  });
});
