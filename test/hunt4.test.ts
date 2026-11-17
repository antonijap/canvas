// Regression tests for Codex bug hunt round 4 (.planning/research/codex-hunt-4.md). Structure ops and auto tracking
// run as pure functions; the page script's nudge queue and Fit Page run extracted from src/server.ts in a sandbox.

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { describe, test } from "node:test";
import { copyNodes, duplicateNodes, pasteNodes } from "../src/structure.ts";
import { applyAutoTracking } from "../src/tracking.ts";
import type { CanvasDoc, DocNode } from "../src/engine.ts";
// @ts-ignore: a plain ES module the page imports too
import { resizeWrites } from "../src/page/live-edit.js";
// @ts-ignore: a plain ES module the page imports too
import * as videos from "../src/page/videos.js";
// @ts-ignore: a plain ES module the page imports too
import { attach as attachStructure } from "../src/page/structure.js";

const findIn = (list: DocNode[], id: string): DocNode | undefined => {
  for (const n of list) {
    if (n.id === id) return n;
    const hit = findIn((n.children as DocNode[]) ?? [], id);
    if (hit) return hit;
  }
  return undefined;
};

describe("codex hunt 4: structure", () => {
  const button = (label: string) => ({ type: "frame", id: "C", name: "Button", reusable: true, x: 0, y: 500, width: 100, height: 40, layout: "none", children: [
    { type: "text", id: "CL", content: label, fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" },
  ] });
  const fileA = () => ({ children: [button("SOURCE"), { type: "frame", id: "BA", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [{ type: "ref", id: "I", ref: "C", x: 10, y: 10 }] }] });

  test("1 a paste from another file never binds to a different component with the same id", () => {
    const payload = copyNodes(fileA() as any, ["I"], {}, "/a/a.canvas.json");
    const other = { children: [{ ...button("OTHER"), x: 900 }, { type: "frame", id: "BB", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [] }] };
    const r = pasteNodes(other as any, payload, { parent: "BB" }, "/b/b.canvas.json");
    const pasted = findIn(other.children as DocNode[], r.select[0])!;
    // B's Button is another component: the layer must not become its instance. A's Button comes along instead.
    assert.equal(pasted.type, "ref");
    assert.notEqual(pasted.ref, "C", "not B's own Button");
    const brought = findIn(other.children as DocNode[], pasted.ref as string)!;
    assert.equal(brought.reusable, true);
    assert.equal((brought.children as DocNode[])[0].content, "SOURCE");
    const holder = (other.children as DocNode[]).find((n) => (n.metadata as any)?.canvasDeletedComponents === true)!;
    assert.ok(holder && holder.enabled === false, "the brought component sits in the hidden holder");
    assert.ok(findIn([holder], pasted.ref as string));
    // The same component (moved elsewhere on B's canvas) stays an instance.
    const same = { children: [{ ...button("SOURCE"), x: 700, y: 900 }, { type: "frame", id: "BB", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [] }] };
    const r2 = pasteNodes(same as any, payload, { parent: "BB" }, "/b/b.canvas.json");
    const inst = findIn(same.children as DocNode[], r2.select[0])!;
    assert.equal(inst.type, "ref");
    assert.equal(inst.ref, "C");
  });

  // The component rule: in one file a copied main component becomes an
  // instance of it, so a duplicated board holds an instance where its main was, and its instances keep the main.
  test("2 a duplicated board's main becomes an instance of it; the copied instance keeps the main, overrides included", () => {
    const doc = { children: [{ type: "frame", id: "B", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [
      { ...button("OK"), y: 0 },
      { type: "ref", id: "I", ref: "C", x: 0, y: 100, descendants: { CL: { content: "Yes" } } },
    ] }] };
    const r = duplicateNodes(doc as any, ["B"]);
    const copy = findIn(doc.children as DocNode[], r.select[0])!;
    const [cmp, inst] = copy.children as DocNode[];
    assert.notEqual(cmp.id, "C");
    assert.deepEqual([cmp.type, cmp.ref, cmp.reusable], ["ref", "C", undefined], "the copied main is an instance of it");
    assert.equal(inst.ref, "C");
    assert.deepEqual(inst.descendants, { CL: { content: "Yes" } }, "the override still names the main's label");
    // The original still points at the original.
    const orig = findIn(doc.children as DocNode[], "I")!;
    assert.equal(orig.ref, "C");
    assert.deepEqual(orig.descendants, { CL: { content: "Yes" } });
  });

  test("2b a board pasted in its own file: its main pastes as an instance, its instance keeps the main", () => {
    const doc = { children: [{ type: "frame", id: "B", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [
      { type: "ref", id: "I", ref: "C", x: 0, y: 100 },
      { ...button("OK"), y: 0 },
    ] }] };
    const payload = copyNodes(doc as any, ["B"], {}, "/a/a.canvas.json");
    const r = pasteNodes(doc as any, payload, { parent: null }, "/a/a.canvas.json");
    const [inst, cmp] = findIn(doc.children as DocNode[], r.select[0])!.children as DocNode[];
    assert.equal(inst.ref, "C");
    assert.deepEqual([cmp.type, cmp.ref], ["ref", "C"]);
  });
  test("2c a board pasted into another file brings its component: the pasted instance uses the pasted component", () => {
    const doc = { children: [{ type: "frame", id: "B", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [
      { type: "ref", id: "I", ref: "C", x: 0, y: 100 },
      { ...button("OK"), y: 0 },
    ] }] };
    const payload = copyNodes(doc as any, ["B"], {}, "/a/a.canvas.json");
    const other = { children: [] as DocNode[] };
    const r = pasteNodes(other as any, payload, { parent: null }, "/b/b.canvas.json");
    const [inst, cmp] = findIn(other.children, r.select[0])!.children as DocNode[];
    assert.equal(inst.ref, cmp.id, "an instance placed before its component in the paste still validates and binds to the copy");
  });

  test("1b review: a component that is an instance itself, pasted with its instance where its base is missing, brings the base", () => {
    const src = { children: [
      { ...button("BASE"), id: "D" },
      { type: "ref", id: "C", ref: "D", reusable: true, x: 0, y: 700 },
      { type: "ref", id: "I", ref: "C", x: 0, y: 800 },
    ] };
    const payload = copyNodes(src as any, ["C", "I"], {}, "/a/a.canvas.json");
    const bare = { children: [] as DocNode[] };
    const r = pasteNodes(bare as any, payload, { parent: null }, "/b/b.canvas.json");
    const [c, i] = r.select.map((id) => findIn(bare.children, id)!);
    // The base comes along (its id is free here), so both stay instances.
    assert.deepEqual([c.type, c.ref, i.type, i.ref], ["ref", "D", "ref", c.id]);
    assert.equal(((findIn(bare.children, "D")!.children as DocNode[])[0]).content, "BASE");
    assert.equal(bare.children.length, 3, "C, I and the holder with D");
  });

  test("3 a paste into a file without the variable keeps the colour; an equal variable stays a token", () => {
    const src = { themes: { mode: ["light", "dark"] }, variables: { brand: { type: "color", value: [{ value: "#FF0000", theme: { mode: "light" } }, { value: "#00FF00", theme: { mode: "dark" } }] }, accent: { type: "color", value: "$brand" } }, children: [
      { type: "frame", id: "B", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [{ type: "rectangle", id: "R", x: 0, y: 0, width: 10, height: 10, fill: "$brand" }] },
      { type: "frame", id: "D", theme: { mode: "dark" }, x: 400, y: 0, width: 300, height: 300, layout: "none", children: [{ type: "rectangle", id: "RD", x: 0, y: 0, width: 10, height: 10, fill: "$accent" }] },
    ] };
    const payload = copyNodes(src as any, ["R", "RD"], {}, "/a/a.canvas.json");
    const bare = { children: [{ type: "frame", id: "T", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [] }] };
    const r = pasteNodes(bare as any, payload, { parent: "T" }, "/b/b.canvas.json");
    assert.equal(findIn(bare.children as DocNode[], r.select[0])!.fill, "#FF0000");
    assert.equal(findIn(bare.children as DocNode[], r.select[1])!.fill, "#00FF00", "the dark board's alias resolves in dark");
    // Another definition under the same name: the source's colour, not the target's.
    const clash = { variables: { brand: { type: "color", value: "#0000FF" } }, children: [{ type: "frame", id: "T", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [] }] };
    const r2 = pasteNodes(clash as any, payload, { parent: "T" }, "/b/b.canvas.json");
    assert.equal(findIn(clash.children as DocNode[], r2.select[0])!.fill, "#FF0000");
    // The same definitions: the token stays.
    const twin = { themes: src.themes, variables: structuredClone(src.variables), children: [{ type: "frame", id: "T", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [] }] };
    const r3 = pasteNodes(twin as any, payload, { parent: "T" }, "/b/b.canvas.json");
    assert.equal(findIn(twin.children as DocNode[], r3.select[0])!.fill, "$brand");
  });
});

describe("codex hunt 4: auto letter spacing", () => {
  test("7 a size token resolves in the text's own theme", () => {
    const d = {
      version: "2.21", themes: { mode: ["light", "dark"] },
      variables: { size: { type: "number", value: [{ value: 12, theme: { mode: "light" } }, { value: 48, theme: { mode: "dark" } }] } },
      children: [{ type: "frame", id: "B", children: [{ type: "text", id: "T", content: "Hi", fontFamily: "Inter", fontSize: "$size", theme: { mode: "dark" } }] }],
    } as unknown as CanvasDoc;
    const t = (d.children[0] as DocNode).children![0];
    const props = { metadata: { type: "canvas", canvasLetterSpacing: "auto" } };
    Object.assign(t, props);
    assert.equal(applyAutoTracking(d, t, props), -1.07, "48 px Inter, not 12 px");
    // Inherited from a board too.
    const d2 = structuredClone(d) as any;
    delete d2.children[0].children[0].theme;
    delete d2.children[0].children[0].letterSpacing;
    d2.children[0].theme = { mode: "dark" };
    const t2 = d2.children[0].children[0];
    Object.assign(t2, props);
    assert.equal(applyAutoTracking(d2, t2, props), -1.07);
  });
});

describe("codex hunt 4: page", () => {
  const page = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  /** A top-level function of the page script, by brace matching (none of these has a brace in a string). */
  const fn = (name: string): string => {
    const at = page.indexOf(`\nfunction ${name}(`);
    if (at < 0) return "";
    let depth = 0;
    for (let i = page.indexOf("{", at); i < page.length; i++) {
      if (page[i] === "{") depth++;
      else if (page[i] === "}" && --depth === 0) return page.slice(at, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };

  test("4 Undo waits for queued nudges, so their tail does not land after it and clear Redo", async () => {
    const log: string[] = [];
    const moves: (() => void)[] = [];
    const ctx: Record<string, unknown> = {
      nudges: new Map(), gnudge: null, file: "f.canvas.json", snapCfg: { pixel: true }, posHold: new Map(), selMove: null, selHold: null, multiHold: null,
      boards: new Map(), doc: null, native: false, history: {}, host: {}, performance: { now: () => 0 },
      syncSel() {}, tell() {}, placeBoardAt() {}, say() {}, post() {}, api: (p: string) => p + "?file=f.canvas.json",
      sendMove: (b: { dx: number }) => { log.push(`move ${b.dx}`); return new Promise<{ x: number; y: number }>((r) => moves.push(() => r({ x: 0, y: 0 }))); },
      fetch: (u: string) => { log.push(u.includes("undo") ? "undo" : u); return Promise.resolve({ ok: true, json: async () => ({}) }); },
    };
    const waiters = (page.includes("let nudgeWaiters = [];") ? "let nudgeWaiters = [];\n" : "") + (page.includes("let writesOut = 0;") ? "let writesOut = 0;\n" : "") + (page.includes("let earlyNudge = null;") ? "let earlyNudge = null;\n" : "");
    const code = waiters + ["flushNudge", "flushGroupNudge", "nudgesPending", "nudgeSettled", "historyStep"].map(fn).join("\n") + "\n;({ flushNudge, historyStep })";
    const { flushNudge, historyStep } = vm.runInNewContext(code, ctx) as { flushNudge: (id: string) => void; historyStep: (d: string) => void };
    const q = { dx: 1, dy: 0, busy: false, board: false };
    (ctx.nudges as Map<string, unknown>).set("N", q);
    flushNudge("N"); // first press: its write is slow
    q.dx += 1; // second press, queued behind it
    flushNudge("N");
    historyStep("undo");
    const tick = () => new Promise((r) => setImmediate(r));
    moves.shift()!();
    await tick();
    moves.shift()?.();
    await tick();
    await tick();
    assert.deepEqual(log, ["move 1", "move 1", "undo"]);
  });

  test("10 Fit Page takes in the page's cards: a card-only page panned away comes back", () => {
    const fits: unknown[] = [];
    const ctx = {
      pageMetas: () => [], boards: new Map(), boxOf: () => null,
      host: { widgetsShown: () => [{ id: "W", x: 5000, y: 4000, w: 200, h: 100 }], widgetRect: (id: string) => (id === "widget:W" ? { x: 5000, y: 4000, w: 200, h: 100 } : null) },
      fitRect: (r: unknown) => fits.push(r),
    };
    const { fitAll } = vm.runInNewContext(fn("fitAll") + "\n;({ fitAll })", ctx) as { fitAll: () => void };
    fitAll();
    assert.deepEqual(JSON.parse(JSON.stringify(fits)), [{ x: 5000, y: 4000, w: 200, h: 100 }]);
  });

  test("5 a paused video stops hearing hover, so the pointer over it cannot play it again", () => {
    const engineHover = videos.engineHover;
    assert.equal(engineHover("V", { userPaused: true }), "");
    assert.equal(engineHover("V", { userPaused: false }), "V");
    assert.equal(engineHover("", undefined), "");
    const s = fs.readFileSync(new URL("../src/page/videos.js", import.meta.url), "utf8");
    const toggle = s.slice(s.indexOf("    toggle(id) {"), s.indexOf("    seek(id, t) {"));
    assert.match(toggle, /if \(c\.hoverId === id\) eng\.setShaderHover\(engineHover\(id, c\)/, "Pause under the pointer takes the hover away");
    assert.match(s, /eng\.setShaderHover\(engineHover\(id, c\), x \|\| 0, y \|\| 0, false\)/);
  });

  test("8 Cmd-resizing an auto-layout frame keeps its absolute children in place", () => {
    const s = fs.readFileSync(new URL("../src/page/live.js", import.meta.url), "utf8");
    const writesOf = s.slice(s.indexOf("function writesOf(z)"), s.indexOf("function showResize(op)"));
    assert.match(writesOf, /kids: z\.info\.kids/);
    assert.doesNotMatch(writesOf, /layout === "none"/);
    // info.kids of an auto-layout frame holds its absolute children; they shift back by the left edge's move.
    const w = resizeWrites({ x: 100, y: 0, w: 200, h: 100 }, { x: 50, y: 0, w: 250, h: 100 }, { positioned: true, own: { x: 100, y: 0 }, keepChildren: true, kids: [{ id: "Abs", x: 20, y: 10 }] });
    assert.deepEqual(w.children, [{ id: "Abs", x: 70, y: 10 }]);
  });

  test("9 Select All takes the page's cards with its boards", async () => {
    const handlers: Record<string, ((c: unknown) => void)[]> = {};
    const selected: string[][] = [];
    const el = () => ({ style: {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    const g = globalThis as any;
    const saved = { document: g.document, addEventListener: g.addEventListener };
    g.document = { getElementById: el, addEventListener() {}, activeElement: null };
    g.addEventListener = () => {};
    try {
      const host = {
        file: "f.canvas.json", view: el(), boards: new Map([["B1", {}]]), selection: () => [], sel: undefined, selGen: 0, page: "p",
        on: (n: string, f: (c: unknown) => void) => { (handlers[n] ??= []).push(f); },
        boxOf: () => ({ x: 0, y: 0, w: 10, h: 10 }), widgetsShown: () => [{ id: "W1", x: 0, y: 0, w: 1, h: 1 }, { id: "V1", x: 0, y: 0, w: 1, h: 1 }],
        widgetRect: () => null, setSelection: (ids: string[]) => selected.push(ids), clearSel() {}, api: (p: string) => p, post() {},
      };
      attachStructure(host);
      for (const f of handlers.cmd) f({ cmd: "selectAll" });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(selected, [["B1", "widget:W1", "widget:V1"]]);
      // A card-only page selects its cards.
      selected.length = 0;
      host.boards = new Map();
      for (const f of handlers.cmd) f({ cmd: "selectAll" });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(selected, [["widget:W1", "widget:V1"]]);
    } finally {
      g.document = saved.document;
      g.addEventListener = saved.addEventListener;
    }
  });
});
