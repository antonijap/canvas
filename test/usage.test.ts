// Usage counts, the tokens library, component marks and right-click target resolution: pure helpers over a document.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { componentsOf, textStylesOf } from "../src/boards.ts";
import { docDiff, docPayload, applyDocDiff } from "../src/docdiff.ts";
import { snapshotOf } from "../src/boards.ts";
import { loadDoc, type CanvasDoc } from "../src/engine.ts";
import { contextTarget, groupByFamily, isComponentish, marksOf, nameFamily, tokenLibrary, usageList, variableCounts, handleUsageRoute } from "../src/usage.ts";
import { tmpDir } from "./helpers.ts";

const themed = (light: string, dark: string) => ({ type: "color", value: [{ value: light, theme: { mode: "light" } }, { value: dark, theme: { mode: "dark" } }] });
const doc = {
  version: "2.21",
  themes: { mode: ["light", "dark"] },
  variables: {
    "surface-card": themed("#E5E5E7", "#18181B"),
    "surface-input": themed("#F2F2F2", "#27272A"),
    accent: { type: "color", value: "#0766EB" },
    "accent-lip": { type: "color", value: "#054FB8" },
    danger: { type: "color", value: "#FF383C" },
    gutter: { type: "number", value: 16 },
    "radius-card": { type: "number", value: 12 },
    "radius-sheet": { type: "number", value: 24 },
    "font-text": { type: "string", value: "SF Pro Text" },
    label: { type: "string", value: "Hello" },
    unused: { type: "color", value: "#000000" },
  },
  children: [
    {
      type: "frame", id: "Cmp", name: "Button", reusable: true, x: 0, y: 0, width: 100, height: 40, fill: "$accent",
      children: [{ type: "text", id: "Lbl", name: "Label", content: "Go", fontFamily: "$font-text", fontSize: 14, fontWeight: "600", fill: "$accent" }],
    },
    {
      type: "frame", id: "Scr", name: "Screen", x: 200, y: 0, width: 300, height: 600, fill: "$surface-card", padding: ["$gutter", 8], cornerRadius: "$radius-card",
      children: [
        { type: "ref", id: "I1", ref: "Cmp", descendants: { Lbl: { fill: "$danger" } } },
        { type: "ref", id: "I2", ref: "Cmp" },
        { type: "text", id: "T1", name: "Title", content: "Hi", fontFamily: "$font-text", fontSize: 14, fontWeight: "600", fill: "$accent" },
        { type: "frame", id: "Plain", name: "Plain", fill: "$accent", children: [] },
      ],
    },
    { type: "ref", id: "TopInst", ref: "Cmp", x: 600, y: 0 },
  ],
} as unknown as CanvasDoc;

describe("variable usage", () => {
  test("counts nodes that reference a variable, once per node, overrides included", () => {
    const c = variableCounts(doc);
    assert.equal(c.accent, 4); // Cmp, Lbl, T1, Plain
    assert.equal(c["surface-card"], 1);
    assert.equal(c.gutter, 1); // inside an array
    assert.equal(c.danger, 1); // the I1 override
    assert.equal(c["font-text"], 2);
    assert.equal(c.unused, undefined);
  });

  test("usageList names the nodes, instance overrides as a path, and caps the list", () => {
    const l = usageList(doc, "variable", "danger");
    assert.deepEqual(l.items.map((i) => i.id), ["I1/Lbl"]);
    assert.equal(l.items[0].name, "Label");
    assert.equal(l.items[0].boardName, "Screen");
    assert.equal(l.boards["I1/Lbl"], "Scr");
    const big = { version: "2", children: [{ type: "frame", id: "B", children: Array.from({ length: 450 }, (_, i) => ({ type: "rectangle", id: `r${i}`, fill: "$x" })) }] } as unknown as CanvasDoc;
    const u = usageList(big, "variable", "x");
    assert.equal(u.total, 450);
    assert.equal(u.items.length, 200);
  });

  test("font variables are the ones used as a font family", () => {
    const lib = tokenLibrary(doc, textStylesOf(doc));
    assert.deepEqual(lib.variables.map((s) => s.id), ["colors", "numbers", "strings", "fonts"]);
    const fonts = lib.variables.find((s) => s.id === "fonts")!;
    assert.deepEqual(fonts.entries.map((e) => ("name" in e ? e.name : e.title)), ["font-text"]);
  });
});

describe("tokens library", () => {
  test("nameFamily splits on the first - / or .", () => {
    assert.equal(nameFamily("surface-card"), "surface");
    assert.equal(nameFamily("radius/sheet"), "radius");
    assert.equal(nameFamily("a.b.c"), "a");
    assert.equal(nameFamily("accent"), "");
  });

  test("groups by type, then by family; a lone name stays top level; the family's own name joins its group", () => {
    const lib = tokenLibrary(doc, textStylesOf(doc));
    const colors = lib.variables[0];
    assert.equal(colors.title, "Colors");
    const names = colors.entries.map((e) => ("items" in e ? `${e.title}: ${e.items.map((i) => i.leaf).join(",")}` : e.name));
    assert.deepEqual(names, ["accent: accent,lip", "danger", "surface: card,input", "unused"]);
    const nums = lib.variables[1].entries.map((e) => ("items" in e ? `${e.title}: ${e.items.map((i) => i.leaf).join(",")}` : e.name));
    assert.deepEqual(nums, ["gutter", "radius: card,sheet"]);
  });

  test("themed values keep their theme; plain values have none; counts come from usage", () => {
    const lib = tokenLibrary(doc, textStylesOf(doc));
    const surface = lib.variables[0].entries.find((e) => "items" in e && e.title === "surface") as { items: { name: string; values: { theme: string; value: string }[]; count: number }[] };
    assert.deepEqual(surface.items[0].values, [{ theme: "light", value: "#E5E5E7" }, { theme: "dark", value: "#18181B" }]);
    assert.equal(surface.items[0].count, 1);
    assert.deepEqual(lib.themes, ["light", "dark"]);
    const danger = lib.variables[0].entries.find((e) => !("items" in e) && e.name === "danger") as { values: unknown[]; count: number };
    assert.deepEqual(danger.values, [{ theme: "", value: "#FF383C" }]);
    assert.equal(danger.count, 1);
  });

  test("text styles group by font family", () => {
    const lib = tokenLibrary(doc, textStylesOf(doc));
    // Lbl and T1 share one style: two uses.
    assert.equal(lib.styles.length, 1);
    const s = lib.styles[0] as { key: string; title: string; count: number };
    assert.equal(s.title, "font-text 14/600");
    assert.equal(s.count, 2);
    assert.equal(usageList(doc, "style", s.key).total, 2);
    const grouped = groupByFamily([{ n: "A 12/400" }, { n: "A 14/400" }, { n: "B 12/400" }], (t) => t.n, (t) => t, (n) => n.replace(/ \S*$/, ""));
    assert.deepEqual(grouped.map((e) => ("items" in e ? e.title : e.n)), ["A", "B 12/400"]);
  });

  test("the diff carries tokens and marks only when they change", () => {
    const dir = tmpDir("usage");
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const f = path.join(dir, "d.canvas.json");
    fs.writeFileSync(f, JSON.stringify(doc));
    const a = snapshotOf(loadDoc(f));
    const edited = JSON.parse(JSON.stringify(doc));
    edited.children[1].children[3].fill = "#ff0000"; // Plain stops using $accent
    fs.writeFileSync(f, JSON.stringify(edited));
    const b = snapshotOf(loadDoc(f));
    const pa = docPayload(a), pb = docPayload(b);
    const d = docDiff(pa, pb);
    assert.ok(d.tokens, "usage counts moved");
    assert.equal(d.marks, undefined);
    assert.deepEqual(applyDocDiff(pa, d).tokens, pb.tokens);
    assert.equal(docDiff(pa, pa).tokens, undefined);
  });
});

describe("components", () => {
  test("a component knows its board and how many instances it has", () => {
    const [c] = componentsOf(doc);
    assert.deepEqual({ id: c.id, board: c.board, instances: c.instances }, { id: "Cmp", board: "Cmp", instances: 3 });
    assert.deepEqual(usageList(doc, "component", "Cmp").items.map((i) => i.id), ["I1", "I2", "TopInst"]);
  });

  test("marks list components, what is inside them, and instances; isComponentish reads paths", () => {
    const m = marksOf(doc);
    assert.deepEqual(m.comps.sort(), ["Cmp", "Lbl"]);
    assert.deepEqual(m.refs.sort(), ["I1", "I2", "TopInst"]);
    assert.equal(isComponentish(m, "Cmp"), true);
    assert.equal(isComponentish(m, "Lbl"), true);
    assert.equal(isComponentish(m, "I1"), true);
    assert.equal(isComponentish(m, "I1/Lbl"), true);
    assert.equal(isComponentish(m, "Scr"), false);
    assert.equal(isComponentish(m, "T1"), false);
    assert.equal(isComponentish(null, "x"), false);
  });
});

describe("right-click target", () => {
  test("a component: family with its instance count, no main to go to", () => {
    const t = contextTarget(doc, "Cmp")!;
    assert.equal(t.kind, "component");
    assert.equal(t.purple, true);
    assert.equal(t.main, undefined);
    assert.deepEqual(t.family, { id: "Cmp", name: "Button", instances: 3 });
  });

  test("an instance: its main component and board", () => {
    const t = contextTarget(doc, "I2")!;
    assert.equal(t.kind, "instance");
    assert.deepEqual(t.main, { id: "Cmp", name: "Button", board: "Cmp", boardName: "Button", focus: "Cmp" });
    assert.equal(t.board, "Scr");
    assert.equal(t.family?.instances, 3);
    assert.equal(contextTarget(doc, "TopInst")!.board, "TopInst");
  });

  test("a node inside an instance goes to the same node inside the component", () => {
    const t = contextTarget(doc, "I1/Lbl")!;
    assert.equal(t.kind, "inside-instance");
    assert.equal(t.name, "Label");
    assert.equal(t.main?.id, "Cmp");
    assert.equal(t.main?.focus, "Lbl");
    assert.equal(t.board, "Scr");
    assert.equal(t.purple, true);
  });

  test("a node inside a component definition is part of the component", () => {
    const t = contextTarget(doc, "Lbl")!;
    assert.equal(t.kind, "inside-component");
    assert.equal(t.main?.id, "Cmp");
    assert.equal(t.main?.focus, "Lbl");
  });

  test("a plain node is not purple and has no component menu items; unknown ids are null", () => {
    const t = contextTarget(doc, "T1")!;
    assert.deepEqual({ kind: t.kind, purple: t.purple, main: t.main, family: t.family }, { kind: "node", purple: false, main: undefined, family: undefined });
    assert.equal(contextTarget(doc, "nope"), null);
    assert.equal(contextTarget(doc, "I1/nope"), null);
  });

  test("a nested instance inside a component goes to the nested component", () => {
    const nested = {
      version: "2", children: [
        { type: "frame", id: "Icon", name: "Icon", reusable: true, children: [{ type: "rectangle", id: "Dot" }] },
        { type: "frame", id: "Card", name: "Card", reusable: true, children: [{ type: "ref", id: "CardIcon", ref: "Icon" }] },
        { type: "frame", id: "Use", children: [{ type: "ref", id: "Inst", ref: "Card" }] },
      ],
    } as unknown as CanvasDoc;
    const t = contextTarget(nested, "Inst/CardIcon/Dot")!;
    assert.equal(t.kind, "inside-instance");
    assert.equal(t.main?.id, "Icon");
    assert.equal(t.main?.focus, "Dot");
    const mid = contextTarget(nested, "Inst/CardIcon")!;
    assert.equal(mid.kind, "instance");
    assert.equal(mid.main?.id, "Icon");
  });

  test("the routes answer context and usage and refuse a bad kind", () => {
    const out: [unknown, number | undefined][] = [];
    const reply = (v: unknown, s?: number) => out.push([v, s]);
    assert.equal(handleUsageRoute(new URL("http://x/api/context?id=I2"), doc, reply), true);
    assert.equal(handleUsageRoute(new URL("http://x/api/usage?kind=variable&key=accent"), doc, reply), true);
    assert.equal(handleUsageRoute(new URL("http://x/api/usage?kind=bogus"), doc, reply), true);
    assert.equal(handleUsageRoute(new URL("http://x/api/context?id=zzz"), doc, reply), true);
    assert.equal(handleUsageRoute(new URL("http://x/api/doc"), doc, reply), false);
    assert.equal((out[0][0] as { kind: string }).kind, "instance");
    assert.equal((out[1][0] as { total: number }).total, 4);
    assert.equal(out[2][1], 400);
    assert.equal(out[3][1], 404);
  });
});
