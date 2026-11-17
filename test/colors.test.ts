// Document colour stats for the colour picker: literal and variable counts, the background behind a node,
// and the /api/colors route on a live server.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { backgroundOf, colorStats, handleColorsRoute, normalizeHex, solidOf } from "../src/colors.ts";
import type { CanvasDoc } from "../src/engine.ts";

const doc = {
  version: "2.21",
  variables: {
    accent: { type: "color", value: "#0766eb" },
    surface: { type: "color", value: [{ value: "#FFFFFF", theme: { mode: "light" } }, { value: "#18181B", theme: { mode: "dark" } }] },
    alias: { type: "color", value: "$accent" },
    gutter: { type: "number", value: 16 },
  },
  children: [
    {
      type: "frame", id: "Scr", name: "Screen", fill: "$surface",
      children: [
        { type: "text", id: "T1", content: "#123456 is not a colour here", fill: "#fff", fontFamily: "Inter" },
        { type: "rectangle", id: "R1", fill: "#FFFFFFFF", stroke: { fill: "#0766EB", thickness: 1 }, padding: "$gutter" },
        { type: "frame", id: "Card", fill: [{ type: "color", color: "#F4F4F5" }, { type: "gradient", colors: [{ color: "#000000", position: 0 }] }], children: [
          { type: "text", id: "T2", content: "Hi", fill: "$accent" },
          { type: "rectangle", id: "R2", fill: "$alias" },
        ] },
        { type: "ref", id: "I1", ref: "Card", descendants: { T2: { fill: "#0766EB" } } },
      ],
    },
  ],
} as unknown as CanvasDoc;

describe("colour stats", () => {
  test("normalizeHex expands short forms, uppercases and drops opaque alpha", () => {
    assert.equal(normalizeHex("#abc"), "#AABBCC");
    assert.equal(normalizeHex("#aabbccff"), "#AABBCC");
    assert.equal(normalizeHex("#aabbcc80"), "#AABBCC80");
    assert.equal(normalizeHex("#abcd"), "#AABBCCDD");
    assert.equal(normalizeHex("red"), null);
    assert.equal(normalizeHex("#12345"), null);
  });

  test("counts literals and colour variables once per node, skips text content and non-colour variables", () => {
    const s = colorStats(doc);
    const lit = (hex: string) => s.colors.find((c) => c.hex === hex && !c.variable)?.count;
    const v = (name: string) => s.colors.find((c) => c.variable === name);
    assert.equal(lit("#FFFFFF"), 2); // T1 (#fff) and R1 (#FFFFFFFF)
    assert.equal(lit("#0766EB"), 2); // R1 stroke, I1 override
    assert.equal(lit("#123456"), undefined); // text content is not a colour
    assert.equal(lit("#000000"), 1); // gradient stop
    assert.equal(lit("#F4F4F5"), 1);
    assert.deepEqual(v("accent"), { hex: "#0766EB", count: 1, variable: "accent" });
    assert.deepEqual(v("alias"), { hex: "#0766EB", count: 1, variable: "alias" }); // resolved through the alias
    assert.equal(v("surface")?.hex, "#FFFFFF"); // first theme
    assert.equal(v("gutter"), undefined);
    assert.equal(s.total, s.colors.reduce((n, c) => n + c.count, 0));
    for (let i = 1; i < s.colors.length; i++) assert.ok(s.colors[i - 1].count >= s.colors[i].count, "most used first");
  });

  test("is cached per document object", () => {
    assert.equal(colorStats(doc), colorStats(doc));
  });

  test("solidOf reads strings, variables, colour fill objects and the topmost solid of an array", () => {
    assert.equal(solidOf(doc, "#000"), "#000000");
    assert.equal(solidOf(doc, "$surface"), "#FFFFFF");
    assert.equal(solidOf(doc, { type: "color", color: "#111111" }), "#111111");
    assert.equal(solidOf(doc, { type: "color", color: "#111111", enabled: false }), null);
    assert.equal(solidOf(doc, [{ type: "color", color: "#111111" }, { type: "color", color: "#222222" }]), "#222222");
    assert.equal(solidOf(doc, { type: "gradient" }), null);
  });

  test("backgroundOf is the nearest ancestor's solid fill", () => {
    assert.equal(backgroundOf(doc, "T2"), "#F4F4F5");
    assert.equal(backgroundOf(doc, "T1"), "#FFFFFF");
    assert.equal(backgroundOf(doc, "Scr"), null);
    assert.equal(backgroundOf(doc, "I1/T2"), "#F4F4F5");
  });

  test("handleColorsRoute answers /api/colors only, with a limit and the background", () => {
    const out: unknown[] = [];
    const reply = (v: unknown) => out.push(v);
    assert.equal(handleColorsRoute(new URL("http://x/api/usage"), doc, "r1", reply), false);
    assert.equal(handleColorsRoute(new URL("http://x/api/colors?limit=2&id=T2"), doc, "r1", reply), true);
    const r = out[0] as { revision: string; colors: unknown[]; background: string };
    assert.equal(r.revision, "r1");
    assert.equal(r.colors.length, 2);
    assert.equal(r.background, "#F4F4F5");
  });
});

describe("GET /api/colors on a live server", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-colors-")));
  const file = path.join(tmp, "colors.canvas.json");
  fs.writeFileSync(file, JSON.stringify(doc));
  process.env.CANVAS_ROOTS = tmp;
  let close = () => {};
  after(() => {
    fs.unwatchFile(file);
    close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("returns the document's colours with its revision", async () => {
    const { startServer } = await import("../src/server.ts");
    const server = await startServer(0);
    const port = (server.address() as { port: number }).port;
    close = () => server.close();
    const r = await fetch(`http://127.0.0.1:${port}/api/colors?file=${encodeURIComponent(file)}&id=T2`).then((x) => x.json() as Promise<{ revision: string; colors: { hex: string; count: number }[]; background: string }>);
    assert.ok(r.revision);
    assert.equal(r.background, "#F4F4F5");
    assert.ok(r.colors.some((c) => c.hex === "#0766EB"));
  });
});
