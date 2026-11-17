// The layers panel's outline (src/layers.ts, GET /api/layers): icons per layer type, names, hidden and container
// flags, change keys, revealing a selected layer's parents, and the page module and edits the panel drives
// (rename and hide through /api/update, reorder and reparent through /api/layout place with `before`).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { layerKind, layerName, outlineOf } from "../src/layers.ts";

const dir = tmpDir("layers");
process.env.CANVAS_ROOTS = dir;
const rect = (id: string, extra = {}) => ({ type: "rectangle", id, width: 10, height: 10, fill: "#00FF00", ...extra });
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B1", name: "Home", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [
      { type: "frame", id: "Row", name: "Row", layout: "horizontal", children: [rect("r1"), rect("r2"), rect("r3")] },
      { type: "group", id: "G", children: [rect("g1", { x: 5, y: 5 })] },
      { type: "text", id: "T", content: "Hello\nworld", fontSize: 14, fontFamily: "Inter", fontWeight: "400", fill: "#000000" },
      rect("Hid", { enabled: false, x: 50, y: 50 }),
    ] },
    { type: "frame", id: "B2", x: 600, y: 0, width: 200, height: 200, layout: "vertical", children: [] },
  ],
};
const p = path.join(dir, "l.canvas.json");
fs.writeFileSync(p, JSON.stringify(DOC, null, 2));
const file = fs.realpathSync(p);
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  fs.unwatchFile(file);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = async (q: string) => (await (await fetch(`${base}/api/layers?file=${encodeURIComponent(file)}&${q}`)).json()) as any;
const post = async (route: string, body: unknown) => {
  const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-canvas": "1" }, body: JSON.stringify({ file, ...(body as object) }) });
  return { status: r.status, body: (await r.json()) as any };
};
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const kids = (id: string) => {
  const s = (l: any[]): any => { for (const n of l) { if (n.id === id) return n; const h = n.children && s(n.children); if (h) return h; } };
  return (s(read().children).children ?? []).map((n: any) => n.id);
};

describe("outline", () => {
  test("kinds follow the usual layer icons", () => {
    assert.equal(layerKind({ type: "frame", id: "a" } as any), "frameH", "a frame without layout is horizontal (the format's default)");
    assert.equal(layerKind({ type: "frame", id: "a", layout: "none" } as any), "frame");
    assert.equal(layerKind({ type: "frame", id: "a", layout: "vertical" } as any), "frameV");
    assert.equal(layerKind({ type: "frame", id: "a", reusable: true } as any), "component");
    assert.equal(layerKind({ type: "ref", id: "a", ref: "x" } as any), "instance");
    assert.equal(layerKind({ type: "rectangle", id: "a", fill: { type: "image", url: "x.png" } } as any), "image");
    assert.equal(layerKind({ type: "rectangle", id: "a", fill: [{ type: "color", color: "#000" }, { type: "image", url: "x" }] } as any), "image");
    assert.equal(layerKind({ type: "rectangle", id: "a", fill: "#000" } as any), "rect");
    assert.equal(layerKind({ type: "path", id: "a" } as any), "vector");
    assert.equal(layerKind({ type: "text", id: "a" } as any), "text");
    assert.equal(layerKind({ type: "browser", id: "a" } as any), "other");
  });
  test("names: own, else a text's words, else the type", () => {
    assert.equal(layerName({ type: "text", id: "a", content: "Hi\n  there" } as any), "Hi there");
    assert.equal(layerName({ type: "rectangle", id: "a" } as any), "Rectangle");
    assert.equal(layerName({ type: "ref", id: "a" } as any), "Instance");
    assert.equal(layerName({ type: "icon_font", id: "a" } as any), "Icon font");
    assert.equal(layerName({ type: "frame", id: "a", name: "Card" } as any), "Card");
  });
  test("instances show no children; hidden, containers and first-on-top are flagged", () => {
    const o = outlineOf({ type: "frame", id: "f", metadata: { canvasLayout: { stacking: "first" } }, children: [{ type: "ref", id: "i", ref: "c", children: [{ type: "text", id: "x" }] }, { type: "rectangle", id: "h", enabled: false }] } as any);
    assert.deepEqual(o, { i: "f", n: "Frame", k: "frameH", ct: 1, ft: 1, c: [{ i: "i", n: "Instance", k: "instance" }, { i: "h", n: "Rectangle", k: "rect", h: 1 }] });
  });
});

describe("GET /api/layers", () => {
  test("trees for the asked boards, skipped when the key is known", async () => {
    const a = await get("boards=B1,B2,nope");
    assert.deepEqual(a.boards.map((b: any) => b.id), ["B1", "B2"]);
    const b1 = a.boards[0];
    assert.equal(b1.tree.n, "Home");
    assert.deepEqual(b1.tree.c.map((c: any) => [c.i, c.k]), [["Row", "frameH"], ["G", "group"], ["T", "text"], ["Hid", "rect"]]);
    assert.equal(b1.tree.c[2].n, "Hello world");
    assert.equal(b1.tree.c[3].h, 1);
    const again = await get(`boards=B1,B2&keys=${b1.key},stale`);
    assert.equal(again.boards[0].tree, undefined, "same key: no tree");
    assert.ok(again.boards[1].tree, "other key: the tree");
  });
  test("reveal: the parents of a layer, and its board's tree", async () => {
    const a = await get("boards=&reveal=r2,g1,missing,inst/child");
    assert.deepEqual(a.reveal.r2.path, ["B1", "Row"]);
    assert.deepEqual(a.reveal.g1.path, ["B1", "G"]);
    assert.equal(a.reveal.missing, undefined);
    assert.deepEqual(a.boards.map((b: any) => b.id), ["B1"]);
    assert.ok(a.boards[0].tree);
  });
});

describe("the edits the panel makes", () => {
  test("rename and hide are one write each, and the outline follows", async () => {
    assert.equal((await post("/api/update", { id: "g1", props: { name: "Dot" } })).status, 200);
    assert.equal((await post("/api/update", { id: "r1", props: { enabled: false } })).status, 200);
    const t = (await get("boards=B1")).boards[0].tree;
    assert.equal(t.c[1].c[0].n, "Dot");
    assert.equal(t.c[0].c[0].h, 1);
    assert.equal((await post("/api/update", { id: "r1", props: {}, remove: ["enabled"] })).status, 200);
    assert.equal((await get("boards=B1")).boards[0].tree.c[0].c[0].h, undefined);
  });
  test("a drop reorders a flow with before, and moves a layer into another frame", async () => {
    // Panel shows Row as r3, r2, r1; dropping r1 above r3 (the top row) lands at the front: before null.
    let r = await post("/api/layout", { op: "place", ids: ["r1"], parent: "Row", before: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(kids("Row"), ["r2", "r3", "r1"]);
    // r1 below r2 (the bottom row): before r2.
    r = await post("/api/layout", { op: "place", ids: ["r1"], parent: "Row", before: "r2" });
    assert.deepEqual(kids("Row"), ["r1", "r2", "r3"]);
    // Into the group, at its front.
    r = await post("/api/layout", { op: "place", ids: ["T"], parent: "G", before: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(kids("G"), ["g1", "T"]);
    assert.ok(!kids("B1").includes("T"));
  });
  test("the page module is served", async () => {
    const r = await fetch(base + "/page/layers.js");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /op === "hover"/);
  });
});
