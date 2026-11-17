// Design-tool shortcuts: Option-drag copies (duplicate with an offset, place copy
// into a frame, one undo step with cards), Cmd+D repeating the last step, and the pure math of
// src/page/shortcuts-logic.js (Option+hover distances, Option+W/A/S/D/H/V align, Tab, flip, show/hide).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir, writeDoc } from "./helpers.ts";
import type { DocNode } from "../src/engine.ts";
// @ts-ignore: a plain ES module the page imports too
import * as S from "../src/page/shortcuts-logic.js";

const dir = tmpDir("shortcuts");
process.env.CANVAS_ROOTS = dir;
const { duplicateNodes } = await import("../src/structure.ts");
const { placeCopies } = await import("../src/autolayout.ts");
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const docFiles: string[] = [];
after(() => {
  for (const p of docFiles) fs.unwatchFile(p);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 9_000_000;
history.setClock(() => clock);
const later = (ms = 5000) => void (clock += ms);

const find = (list: DocNode[], id: string): DocNode | undefined => {
  for (const n of list) {
    if (n.id === id) return n;
    const hit = find((n.children as DocNode[]) ?? [], id);
    if (hit) return hit;
  }
};
const ids = (list: DocNode[]) => list.map((n) => String(n.id));

describe("Option-drag: duplicate with an offset", () => {
  const doc = () => ({ children: [
    { type: "frame", id: "B", x: 0, y: 0, width: 400, height: 300, layout: "none", children: [
      { type: "rectangle", id: "R", x: 10, y: 20, width: 50, height: 50 },
      { type: "frame", id: "F", x: 100, y: 100, width: 200, height: 60, layout: "horizontal", children: [
        { type: "rectangle", id: "F1", width: 20, height: 20 },
        { type: "rectangle", id: "F2", width: 20, height: 20 },
      ] },
    ] },
    { type: "frame", id: "B2", x: 600, y: 0, width: 100, height: 100, layout: "none", children: [] },
  ] });

  test("a board's copy lands at the board plus the offset, the board stays", () => {
    const d = doc();
    const r = duplicateNodes(d as any, ["B"], {}, { offset: { dx: 0, dy: 500 } });
    assert.equal(r.label, "Duplicate");
    assert.deepEqual(ids(d.children as DocNode[]).slice(0, 1), ["B"]);
    const copy = find(d.children as DocNode[], r.select[0])!;
    assert.equal(copy.x, 0);
    assert.equal(copy.y, 500);
    assert.equal(find(d.children as DocNode[], "B")!.y, 0, "the original did not move");
  });

  test("an absolute layer's copy keeps the drag's step; rounding follows pixel snapping", () => {
    const d = doc();
    const r = duplicateNodes(d as any, ["R"], {}, { offset: { dx: 30.4, dy: -5.6 }, round: true });
    const copy = find(d.children as DocNode[], r.select[0])!;
    assert.equal(copy.x, 40);
    assert.equal(copy.y, 14);
    const b = find(d.children as DocNode[], "B")!;
    assert.deepEqual(ids(b.children as DocNode[]).slice(0, 2), ["R", r.select[0]], "the copy sits right above its original");
  });

  test("a flow child's copy goes right after it (auto layout places it)", () => {
    const d = doc();
    const r = duplicateNodes(d as any, ["F1"], {}, { offset: { dx: 99, dy: 99 } });
    const f = find(d.children as DocNode[], "F")!;
    assert.deepEqual(ids(f.children as DocNode[]), ["F1", r.select[0], "F2"]);
    assert.equal(find(d.children as DocNode[], r.select[0])!.x, undefined);
  });

  test("copies map back to their originals, in document order", () => {
    const d = doc();
    const r = duplicateNodes(d as any, ["B2", "B"], {}, { offset: { dx: 10, dy: 0 } });
    assert.equal(r.copies.size, 2);
    assert.deepEqual(r.select, [r.copies.get("B"), r.copies.get("B2")]);
    assert.equal(find(d.children as DocNode[], r.copies.get("B2")!)!.x, 610);
  });

  test("Cmd+D without an offset puts the copy in place, on top", () => {
    const d = doc();
    const r = duplicateNodes(d as any, ["R"]);
    const copy = find(d.children as DocNode[], r.select[0])!;
    assert.equal(copy.x, 10);
    assert.equal(copy.y, 20);
  });
});

describe("Option-drag into a frame: place copies", () => {
  const doc = () => ({ children: [
    { type: "frame", id: "B", x: 0, y: 0, width: 400, height: 300, layout: "none", children: [
      { type: "rectangle", id: "R", x: 10, y: 20, width: 50, height: 50 },
      { type: "frame", id: "F", x: 100, y: 100, width: 200, height: 60, layout: "horizontal", children: [
        { type: "rectangle", id: "F1", width: 20, height: 20 },
        { type: "rectangle", id: "F2", width: 20, height: 20 },
      ] },
    ] },
  ] });

  test("a flow child copied to another slot: the copy lands there, the child stays", () => {
    const d = doc();
    const r = placeCopies(d as any, ["F1"], "F", undefined, { before: null });
    const f = find(d.children as DocNode[], "F")!;
    assert.equal(r.label, "Duplicate");
    assert.equal(r.select.length, 1);
    assert.notEqual(r.select[0], "F1");
    assert.deepEqual(ids(f.children as DocNode[]), ["F1", "F2", r.select[0]]);
  });

  test("before an original sibling works (the originals stay in the list)", () => {
    const d = doc();
    const r = placeCopies(d as any, ["F2"], "F", undefined, { before: "F1" });
    assert.deepEqual(ids(find(d.children as DocNode[], "F")!.children as DocNode[]), [r.select[0], "F1", "F2"]);
  });

  test("an absolute layer copied into a flow frame joins the flow (no x/y)", () => {
    const d = doc();
    const r = placeCopies(d as any, ["R"], "F", undefined, { before: "F2" });
    const f = find(d.children as DocNode[], "F")!;
    assert.deepEqual(ids(f.children as DocNode[]), ["F1", r.select[0], "F2"]);
    const copy = find(d.children as DocNode[], r.select[0])!;
    assert.equal(copy.x, undefined);
    assert.equal(find(d.children as DocNode[], "R")!.x, 10, "the original stayed");
  });

  test("onto the canvas: the copy becomes a board where it was dropped", () => {
    const d = doc();
    const r = placeCopies(d as any, ["F1"], null, 0, { absolute: [{ x: 900, y: 40 }] });
    const copy = find(d.children as DocNode[], r.select[0])!;
    assert.equal(d.children[0].id, r.select[0]);
    assert.equal(copy.x, 900);
    assert.equal(copy.y, 40);
    assert.deepEqual(ids(find(d.children as DocNode[], "F")!.children as DocNode[]), ["F1", "F2"]);
  });
});

describe("Option-drag: one undo step through the server", () => {
  const user = { "x-canvas": "1" };
  async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = user) {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let j: any = text;
    try { j = JSON.parse(text); } catch {}
    return { status: r.status, body: j };
  }
  async function freshDoc(name: string) {
    const sub = path.join(dir, name);
    fs.mkdirSync(sub, { recursive: true });
    const docFile = writeDoc(sub, name);
    docFiles.push(docFile);
    await call("POST", "/api/update", { file: docFile, id: "Scr01", props: {} });
    history.resetHistory();
    later();
    return docFile;
  }
  const boardsOf = async (docFile: string) => (await call("GET", `/api/doc?file=${encodeURIComponent(docFile)}`)).body.boards.map((b: { id: string }) => b.id);

  test("a board and a card copied together: Undo removes both copies", async () => {
    const docFile = await freshDoc("dupmix");
    const q = `?file=${encodeURIComponent(docFile)}`;
    const card = await call("POST", `/api/widgets${q}`, { kind: "note", x: 0, y: 900, w: 200, h: 120 });
    assert.equal(card.status, 201);
    later();
    const merge = "group:dup-test1";
    const d = await call("POST", "/api/structure", { file: docFile, op: "duplicate", ids: ["Scr01"], offset: { dx: 0, dy: 1000 }, round: true, merge });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const w = await call("POST", `/api/widgets${q}`, { kind: "note", x: 0, y: 1900, w: 200, h: 120 }, { ...user, "x-canvas-merge": merge });
    assert.equal(w.status, 201);
    assert.equal((await boardsOf(docFile)).length, 3);
    assert.equal((await call("GET", `/api/widgets${q}`)).body.widgets.length, 2);
    later();
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    assert.deepEqual(await boardsOf(docFile), ["Scr01", "Scr02"], "the board copy went");
    assert.equal((await call("GET", `/api/widgets${q}`)).body.widgets.length, 1, "the card copy went in the same step");
  });

  test("detach is one step: Undo brings the instance back", async () => {
    const docFile = await freshDoc("detach");
    const q = `?file=${encodeURIComponent(docFile)}`;
    const doc = JSON.parse(fs.readFileSync(docFile, "utf8"));
    doc.children.push({ type: "frame", id: "Cmp", reusable: true, x: 0, y: 1000, width: 80, height: 30, layout: "none", children: [{ type: "rectangle", id: "CmpR", width: 10, height: 10 }] });
    doc.children[0].children = [{ type: "ref", id: "Ins", ref: "Cmp", x: 4, y: 4 }];
    fs.writeFileSync(docFile, JSON.stringify(doc, null, 2));
    await call("POST", "/api/update", { file: docFile, id: "Scr01", props: {} });
    later();
    history.resetHistory();
    const r = await call("POST", "/api/structure", { file: docFile, op: "detach", ids: ["Ins"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find(JSON.parse(fs.readFileSync(docFile, "utf8")).children, "Ins")!.type, "frame");
    later();
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    const back = find(JSON.parse(fs.readFileSync(docFile, "utf8")).children, "Ins")!;
    assert.equal(back.type, "ref");
    assert.equal(back.ref, "Cmp");
  });

  test("a place copy is one step: Undo removes the copy and leaves the layer", async () => {
    const docFile = await freshDoc("placecopy");
    const q = `?file=${encodeURIComponent(docFile)}`;
    const p = await call("POST", "/api/layout", { file: docFile, op: "place", copy: true, ids: ["Scr02"], parent: "Scr01", before: null, absolute: [{ x: 5, y: 6 }] });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.label, "Duplicate");
    const doc = JSON.parse(fs.readFileSync(docFile, "utf8"));
    const inner = find(doc.children, "Scr01")!.children as DocNode[];
    assert.equal(inner.length, 1);
    assert.equal(inner[0].x, 5);
    assert.ok(find(doc.children, "Scr02"), "the original board stayed");
    later();
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    const back = JSON.parse(fs.readFileSync(docFile, "utf8"));
    assert.equal(((find(back.children, "Scr01")!.children as DocNode[]) ?? []).length, 0);
    assert.ok(find(back.children, "Scr02"));
  });
});

describe("shortcuts-logic", () => {
  test("measureLines: inside another, four lines to its sides", () => {
    const m = S.measureLines({ x: 10, y: 10, w: 20, h: 20 }, { x: 0, y: 0, w: 100, h: 50 });
    assert.deepEqual(m.lines.map((l: { d: number }) => l.d), [10, 70, 10, 20]);
    assert.equal(m.dashes.length, 0);
  });
  test("measureLines: side by side, the gap on the shared band", () => {
    const m = S.measureLines({ x: 0, y: 0, w: 10, h: 10 }, { x: 25, y: 5, w: 10, h: 10 });
    assert.equal(m.lines.length, 1);
    assert.deepEqual(m.lines[0], { x1: 10, y1: 7.5, x2: 25, y2: 7.5, d: 15 });
  });
  test("measureLines: apart on both axes, two gaps and dashed leads", () => {
    const m = S.measureLines({ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 40, w: 10, h: 10 });
    assert.deepEqual(m.lines.map((l: { d: number }) => l.d), [20, 30]);
    assert.equal(m.dashes.length, 2);
  });
  test("measureLines: same box or nothing hovered: no lines", () => {
    assert.equal(S.measureLines({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }).lines.length, 0);
    assert.equal(S.measureLines({ x: 0, y: 0, w: 10, h: 10 }, null).lines.length, 0);
  });
  test("alignDeltas: Option+A/D/W/S/H/V", () => {
    const rs = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 40, y: 20, w: 20, h: 30 }];
    const box = S.unionOf(rs);
    assert.deepEqual(box, { x: 0, y: 0, w: 60, h: 50 });
    assert.deepEqual(S.alignDeltas(rs, box, "left"), [{ dx: 0, dy: 0 }, { dx: -40, dy: 0 }]);
    assert.deepEqual(S.alignDeltas(rs, box, "right"), [{ dx: 50, dy: 0 }, { dx: 0, dy: 0 }]);
    assert.deepEqual(S.alignDeltas(rs, box, "hcenter"), [{ dx: 25, dy: 0 }, { dx: -20, dy: 0 }]);
    assert.deepEqual(S.alignDeltas(rs, box, "bottom"), [{ dx: 0, dy: 40 }, { dx: 0, dy: 0 }]);
    assert.deepEqual(S.alignDeltas(rs, box, "vcenter"), [{ dx: 0, dy: 20 }, { dx: 0, dy: -10 }]);
    assert.equal(S.ALIGN_KEYS.KeyW, "top");
    assert.equal(S.ALIGN_KEYS.KeyS, "bottom");
  });
  test("siblingStep: Tab walks down the layers panel and wraps", () => {
    const kids = ["a", "b", "c"]; // file order: c is on top, the panel's first row
    assert.equal(S.siblingStep(kids, "c", false), "b");
    assert.equal(S.siblingStep(kids, "a", false), "c");
    assert.equal(S.siblingStep(kids, "c", true), "a");
    assert.equal(S.siblingStep(["a"], "a", false), null);
    assert.equal(S.siblingStep(kids, "x", false), null);
  });
  test("repeatOffset: Cmd+D on moved copies repeats their step", () => {
    const rects: Record<string, { x: number; y: number; w: number; h: number }> = { A: { x: 0, y: 0, w: 10, h: 10 }, A2: { x: 30, y: 5, w: 10, h: 10 } };
    const rectOf = (id: string) => rects[id] ?? null;
    assert.deepEqual(S.repeatOffset({ src: ["A"], copies: ["A2"] }, ["A2"], rectOf), { dx: 30, dy: 5 });
    assert.equal(S.repeatOffset({ src: ["A"], copies: ["A2"] }, ["A"], rectOf), null, "the original selected: a plain Cmd+D");
    assert.equal(S.repeatOffset(null, ["A2"], rectOf), null);
    rects.A2 = { x: 0, y: 0, w: 10, h: 10 };
    assert.equal(S.repeatOffset({ src: ["A"], copies: ["A2"] }, ["A2"], rectOf), null, "a copy on top of its original: no step");
  });
  test("flipGroups and hideAll", () => {
    assert.deepEqual(S.flipGroups([{ id: "a" }, { id: "b", flipX: true }], "flipX"), { on: ["a"], off: ["b"] });
    assert.equal(S.hideAll([{ enabled: false }, {}]), true);
    assert.equal(S.hideAll([{ enabled: false }]), false);
  });
  test("opacityFromDigits: 1 is 10%, 0 is 100%, two digits a percentage", () => {
    assert.equal(S.opacityFromDigits(null, 5), 0.5);
    assert.equal(S.opacityFromDigits(null, 0), 1);
    assert.equal(S.opacityFromDigits(4, 5), 0.45);
    assert.equal(S.opacityFromDigits(0, 0), 0);
  });
  test("zoomKey: only Shift+1 / 2 / 0 zoom; bare digits and F never do (QA item 3)", () => {
    const k = (code: string, mods: Record<string, boolean> = {}) => S.zoomKey({ code, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });
    assert.equal(k("Digit1", { shiftKey: true }), "fitAll");
    assert.equal(k("Digit2", { shiftKey: true }), "fitSelection");
    assert.equal(k("Digit0", { shiftKey: true }), "zoom100");
    for (const c of ["Digit1", "Digit2", "Digit0", "Digit5", "KeyF"]) assert.equal(k(c), null, c);
    assert.equal(k("KeyF", { shiftKey: true }), null);
    assert.equal(k("Digit1", { shiftKey: true, metaKey: true }), null);
    assert.equal(k("Digit1", { shiftKey: true, altKey: true }), null);
  });
  test("distributeDeltas: equal gaps, outer layers stay", () => {
    const rs = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 15, y: 0, w: 10, h: 10 }, { x: 90, y: 0, w: 10, h: 10 }];
    assert.deepEqual(S.distributeDeltas(rs, "h"), [{ dx: 0, dy: 0 }, { dx: 30, dy: 0 }, { dx: 0, dy: 0 }]);
    assert.deepEqual(S.distributeDeltas(rs.slice(0, 2), "h"), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }], "two layers: nothing to distribute");
  });
  test("resizeBy: Cmd+arrows", () => {
    const r = { x: 0, y: 0, w: 10, h: 20 };
    assert.deepEqual(S.resizeBy(r, "ArrowRight", 1), { width: 11 });
    assert.deepEqual(S.resizeBy(r, "ArrowUp", 10), { height: 10 });
    assert.deepEqual(S.resizeBy(r, "ArrowLeft", 10), { width: 1 }, "never below 1");
    // Lock aspect ratio: the other side follows.
    assert.deepEqual(S.resizeBy(r, "ArrowRight", 10, true), { width: 20, height: 40 });
    assert.deepEqual(S.resizeBy(r, "ArrowUp", 10, true), { height: 10, width: 5 });
    assert.deepEqual(S.resizeBy({ x: 0, y: 0, w: 3, h: 1 }, "ArrowRight", 1, true), { width: 4, height: 1.33 });
  });
  test("rotateBy: Cmd+Option+Up/Down turn 1 degree, in -180...180", () => {
    assert.deepEqual(S.rotateBy({ rotation: 10 }, "ArrowUp"), { rotation: 11 });
    assert.deepEqual(S.rotateBy({}, "ArrowDown"), { rotation: -1 });
    assert.deepEqual(S.rotateBy({ rotation: 180 }, "ArrowUp"), { rotation: -179 });
    assert.deepEqual(S.rotateBy({ rotation: 1 }, "ArrowDown"), { rotation: 0 });
    assert.equal(S.rotateBy({ rotation: "$turn" }, "ArrowUp"), null, "a token-bound rotation is left alone");
    assert.equal(S.rotateBy({ rotation: 0 }, "ArrowLeft"), null);
  });
  test("ownSize: Cmd+arrows grow a turned layer from its own size, not its drawn box (qa matrix)", () => {
    // A 90 x 50 layer turned 30 degrees draws about 103 x 88: Cmd+Right makes it 91 wide, not 104.
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const drawn = { x: 0, y: 0, w: 90 * c + 50 * s, h: 90 * s + 50 * c };
    assert.deepEqual(S.resizeBy(S.ownSize({ type: "rectangle", width: 90, height: 50, rotation: 30 }, drawn), "ArrowRight", 1), { width: 91 });
    // Hug sizes come from the drawing, unturned.
    const hug = S.ownSize({ type: "frame", width: "fit_content", height: "fit_content", rotation: 30 }, drawn);
    assert.ok(Math.abs(hug.w - 90) < 1e-6 && Math.abs(hug.h - 50) < 1e-6, JSON.stringify(hug));
    assert.deepEqual(S.ownSize({ type: "rectangle", width: 10, height: 20 }, { x: 0, y: 0, w: 10, h: 20 }), { x: 0, y: 0, w: 10, h: 20 });
  });
  test("textToggle: bold, italic, underline, size, align on text layers only", () => {
    const nodes = [{ id: "t1", type: "text", fontWeight: "700" }, { id: "t2", type: "text", fontWeight: "400", fontSize: 12 }, { id: "r", type: "rectangle" }];
    assert.deepEqual(S.textToggle(nodes, "bold").map((w: any) => w.props.fontWeight), ["700", "700"], "mixed: all become bold");
    assert.deepEqual(S.textToggle([nodes[0]], "bold")[0].props, { fontWeight: "400" });
    assert.deepEqual(S.textToggle([{ id: "a", type: "text", fontStyle: "italic" }], "italic")[0].remove, ["fontStyle"]);
    assert.deepEqual(S.textToggle([nodes[1]], "bigger")[0].props, { fontSize: 13 });
    assert.deepEqual(S.textToggle([nodes[1]], "align-center")[0].props, { textAlign: "center" });
    assert.equal(S.textToggle([nodes[2]], "bold").length, 0);
    assert.deepEqual(S.batchWrites(S.textToggle(nodes, "bold")).map((b: any) => b.ids), [["t1", "t2"]]);
  });
  test("textToggle type keys: letter spacing 0.1 px, line height 1 px, weight to the next hundred, each from its own value", () => {
    const a = { id: "a", type: "text", fontSize: 20, letterSpacing: -0.4, lineHeight: 1.2, fontWeight: "700" };
    const b = { id: "b", type: "text", fontSize: 10 };
    const p = (n: any, w: string) => S.textToggle([n], w)[0]?.props;
    assert.deepEqual(p(a, "tracking+"), { letterSpacing: -0.3 });
    assert.deepEqual(p(a, "tracking-"), { letterSpacing: -0.5 });
    assert.deepEqual(p(b, "tracking+"), { letterSpacing: 0.1 }, "none set: from 0");
    // 1.2 x 20 = 24 px: 25 px is 1.25 of the size; the line height steps in px.
    assert.deepEqual(p(a, "leading+"), { lineHeight: 1.25 });
    assert.deepEqual(p(a, "leading-"), { lineHeight: 1.15 });
    // Auto (no lineHeight) is 1.45 x 10 = 14.5 px drawn: it becomes a fixed value, rounded first.
    assert.deepEqual(p(b, "leading+"), { lineHeight: 1.6 });
    assert.deepEqual(p({ ...b, lineHeight: 0.1 }, "leading-"), undefined, "never below 1 px");
    assert.deepEqual(p(a, "weight+"), { fontWeight: "800" });
    assert.deepEqual(p(a, "weight-"), { fontWeight: "600" });
    assert.deepEqual(p({ ...a, fontWeight: "bold" }, "weight+"), { fontWeight: "800" });
    assert.deepEqual(p(b, "weight-"), { fontWeight: "300" }, "none set: from 400");
    assert.deepEqual(p({ ...a, fontWeight: "900" }, "weight+"), undefined, "nothing past 900");
    assert.deepEqual(p({ ...a, fontWeight: "100" }, "weight-"), undefined, "nothing under 100");
    assert.deepEqual(p({ ...a, fontWeight: "650" }, "weight+"), { fontWeight: "700" }, "between two: the next hundred");
    assert.equal(S.textToggle([{ ...a, letterSpacing: "$track" }], "tracking+").length, 0, "a variable stays bound");
    assert.equal(S.textToggle([{ ...a, fontSize: "$size" }], "leading+").length, 0, "no size to step from");
  });
  test("copyLook / pasteLook: the look goes to the keys each type takes", () => {
    const look = S.copyLook({ id: "a", type: "rectangle", fill: "#ff0000", cornerRadius: 8, opacity: 0.5, width: 10 });
    assert.deepEqual(look.props, { fill: "#ff0000", opacity: 0.5, cornerRadius: 8 });
    const onEllipse = S.pasteLook(look, "ellipse");
    assert.deepEqual(onEllipse.props, { fill: "#ff0000", opacity: 0.5 });
    assert.deepEqual(onEllipse.remove, ["stroke", "effect"]);
    assert.equal(S.pasteLook(look, "ref"), null);
  });
  test("nextBoard: N and Shift+N wrap", () => {
    assert.equal(S.nextBoard(["a", "b", "c"], "c", false), "a");
    assert.equal(S.nextBoard(["a", "b", "c"], "a", true), "c");
    assert.equal(S.nextBoard(["a", "b"], null, false), "a");
    assert.equal(S.nextBoard([], "a", false), null);
  });
});

describe("detach instance (Option+Cmd+B)", () => {
  test("an instance becomes plain layers with its overrides, under its own id", async () => {
    const { detachNodes } = await import("../src/structure.ts");
    const doc = { children: [
      { type: "frame", id: "C", reusable: true, x: 0, y: 0, width: 100, height: 40, layout: "none", children: [{ type: "text", id: "CL", content: "Hi", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" }] },
      { type: "ref", id: "I", ref: "C", x: 300, y: 10, descendants: { CL: { content: "Yo" } } },
    ] };
    const r = detachNodes(doc as any, ["I"]);
    assert.equal(r.label, "Detach Instance");
    const n = find(doc.children as unknown as DocNode[], "I")!;
    assert.equal(n.type, "frame");
    assert.equal(n.reusable, undefined);
    assert.equal(n.x, 300);
    const kid = (n.children as DocNode[])[0];
    assert.equal(kid.content, "Yo");
    assert.ok(!String(kid.id).includes("/") && kid.id !== "CL", "the children get ids of their own");
    assert.throws(() => detachNodes(doc as any, ["C"]), /instance/);
  });
});

