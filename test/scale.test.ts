// The scale tool (K): what scaling does to every property class (src/page/scale.js), the drag math, and the write
// (src/scale.ts, POST /api/scale): instance overrides, nested auto layout, tokens kept, auto letter spacing, one
// undo step, copy on write (docwriter's safety net finds nothing), and a preview that equals the write.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
// @ts-ignore: a plain ES module the page imports too
import * as K from "../src/page/scale.js";
// @ts-ignore: a plain ES module the page imports too
import * as L from "../src/page/live-edit.js";
import { autoTracking } from "../src/tracking.ts";

// ---------------------------------------------------------------- the pure half

describe("scaleProps: every property class", () => {
  const sp = (n: any, f = 2, o: any = {}) => K.scaleProps(n, f, o);

  test("positions, sizes (modes stay, fallbacks scale), an icon's default size", () => {
    const n = { x: 10, y: -5, width: 100, height: "fit_content" };
    assert.deepEqual(sp(n).props, { x: 20, y: -10, width: 200 });
    assert.deepEqual(sp({ type: "icon", icon: "star", width: 16 }).props, { width: 32, height: 48 }, "a missing side is the 24 px the icon draws at");
    assert.deepEqual(sp({ width: "fill_container", height: "fit_content(80)" }).props, { height: "fit_content(160)" });
    assert.deepEqual(sp({ x: 10, y: 10, width: 50 }, 2, { root: true }).props, { width: 100 }, "the layer's own x/y belong to the anchor");
  });

  test("type: a text's styled ranges scale their own size and tracking, other styles stay", () => {
    const n = { type: "text", content: "Hello world", fontSize: 14, spans: [{ start: 0, end: 5, fontSize: 20, letterSpacing: 1, fontWeight: "700" }, { start: 6, end: 11, fill: "#ff0000" }] };
    assert.deepEqual(sp(n, 2).props.spans, [{ start: 0, end: 5, fontSize: 40, letterSpacing: 2, fontWeight: "700" }, { start: 6, end: 11, fill: "#ff0000" }]);
    assert.equal(sp({ type: "text", fontSize: 14 }, 2).props.spans, undefined, "no ranges: none written");
  });
  test("type: font size and letter spacing scale, line height (a multiple of the size) stays", () => {
    assert.deepEqual(sp({ type: "text", fontSize: 14, letterSpacing: -0.3, lineHeight: 1.4, fontWeight: "600" }, 1.5).props, { fontSize: 21, letterSpacing: -0.45 });
    assert.deepEqual(sp({ type: "text", content: "x" }).props, { fontSize: 26 }, "text without a size draws at 13 px: scaled, it gets one");
  });

  test("strokes, uniform and per side; radii, uniform and per corner; padding 1, 2 or 4; gap", () => {
    assert.deepEqual(sp({ strokeWidth: 1.5 }).props, { strokeWidth: 3 });
    assert.deepEqual(sp({ strokeWidth: { top: 1, bottom: 2 } }).props, { strokeWidth: { top: 2, bottom: 4 } });
    assert.deepEqual(sp({ cornerRadius: 8 }).props, { cornerRadius: 16 });
    assert.deepEqual(sp({ cornerRadius: [1, 2, 3, 4] }).props, { cornerRadius: [2, 4, 6, 8] });
    assert.deepEqual(sp({ padding: 4, gap: 6 }).props, { padding: 8, gap: 12 });
    assert.deepEqual(sp({ padding: [4, 8] }).props, { padding: [8, 16] });
    assert.deepEqual(sp({ padding: [1, 2, 3, 4] }).props, { padding: [2, 4, 6, 8] });
  });

  test("effects: shadow offset, blur and spread; layer and background blur radius; colours stay", () => {
    const n = { effect: [{ type: "shadow", shadowType: "inner", offset: { x: 1, y: 2 }, blur: 4, spread: -1, color: "#00000040" }, { type: "blur", radius: 3 }, { type: "background_blur", radius: 10, enabled: false }] };
    assert.deepEqual(sp(n).props.effect, [{ type: "shadow", shadowType: "inner", offset: { x: 2, y: 4 }, blur: 8, spread: -2, color: "#00000040" }, { type: "blur", radius: 6 }, { type: "background_blur", radius: 20, enabled: false }]);
    assert.deepEqual(sp({ effect: { type: "shadow", offset: { x: 0, y: 3 }, blur: 6 } }).props.effect, { type: "shadow", offset: { x: 0, y: 6 }, blur: 12 });
  });

  test("token-bound values stay bound and are reported, also inside lists and effects", () => {
    const n = { width: "$w", gap: "$g", cornerRadius: [4, "$r", 4, 4], effect: [{ type: "shadow", offset: { x: 0, y: "$e" }, blur: 2 }], fontSize: 12 };
    const r = sp(n);
    assert.deepEqual(r.props, { cornerRadius: [8, "$r", 8, 8], effect: [{ type: "shadow", offset: { x: 0, y: "$e" }, blur: 4 }], fontSize: 24 });
    assert.deepEqual(r.kept.sort(), ["cornerRadius.1", "effect.0.offset.y", "gap", "width"]);
    // A resolved scene: the server says which paths were tokens.
    const scene = { width: 100, gap: 8, cornerRadius: [4, 6, 4, 4] };
    assert.deepEqual(sp(scene, 2, { bound: new Set(["width", "gap", "cornerRadius.1"]) }).props, { cornerRadius: [8, 6, 8, 8] });
  });

  test("what does not scale: rotation, opacity, angles, ratios, fills, path geometry; the node itself is never changed", () => {
    const n = { rotation: 15, opacity: 0.5, startAngle: 10, sweepAngle: 90, innerRadius: 0.4, fill: "#FF0000", cornerRadius: [1, 1, 1, 1], geometry: "M0 0L10 10", viewBox: [0, 0, 10, 10] };
    const copy = structuredClone(n);
    assert.deepEqual(sp(n).props, { cornerRadius: [2, 2, 2, 2] });
    assert.deepEqual(n, copy);
    assert.deepEqual(sp(n, 1).props, {}, "a factor of 1 changes nothing");
  });

  test("values land on 1/100 px", () => {
    assert.deepEqual(sp({ width: 10, fontSize: 13 }, 1 / 3).props, { width: 3.33, fontSize: 4.33 });
  });
});

describe("the scale drag", () => {
  const r0 = { x: 100, y: 100, w: 200, h: 100 };
  test("a corner scales from the opposite one, keeping the aspect ratio", () => {
    const g = K.scaleDrag(r0, "se", 100, 0);
    assert.equal(g.f, 1.5);
    assert.deepEqual(g.rect, { x: 100, y: 100, w: 300, h: 150 });
    const nw = K.scaleDrag(r0, "nw", -100, -30);
    assert.equal(nw.f, 1.5);
    assert.deepEqual(nw.rect, { x: 0, y: 50, w: 300, h: 150 }, "the bottom-right corner stays");
  });
  test("an edge scales from the opposite edge's middle; Option from the centre", () => {
    const s = K.scaleDrag(r0, "s", 0, 50);
    assert.equal(s.f, 1.5);
    assert.deepEqual(s.rect, { x: 50, y: 100, w: 300, h: 150 });
    const alt = K.scaleDrag(r0, "e", 50, 0, { alt: true });
    assert.equal(alt.f, 1.5);
    assert.deepEqual(alt.rect, { x: 50, y: 75, w: 300, h: 150 });
  });
  test("the dragged side lands on a whole px; the factor never reaches 0", () => {
    assert.equal(K.scaleDrag(r0, "e", 33.3, 0).rect.w, 233);
    assert.ok(K.scaleDrag(r0, "e", -1000, 0).f > 0);
  });
});

// ---------------------------------------------------------------- the write

const dir = tmpDir("scale");
process.env.CANVAS_ROOTS = dir;
const INTER16 = autoTracking("Inter", 16).px;
const DOC = {
  version: "2.21",
  variables: { r: { type: "number", value: 6 }, sp: { type: "number", value: 8 } },
  children: [
    { type: "frame", id: "B1", name: "Board", x: 0, y: 0, width: 400, height: 300, layout: "none", children: [
      { type: "frame", id: "Card", x: 10, y: 20, width: 200, height: 100, layout: "vertical", gap: 8, padding: [4, 6], cornerRadius: [2, "$r", 4, 0], stroke: "#000000", strokeWidth: 1,
        effect: [{ type: "shadow", offset: { x: 1, y: 2 }, blur: 4, spread: 1, color: "#00000044" }, { type: "blur", radius: 3 }], children: [
        { type: "text", id: "T", content: "Hi", fontFamily: "Inter", fontSize: 14, letterSpacing: 0.5, lineHeight: 1.4, width: "fill_container", textGrowth: "fixed-width" },
        { type: "frame", id: "Row", layout: "horizontal", gap: "$sp", padding: 2, width: "fit_content(80)", height: 20, children: [
          { type: "rectangle", id: "Dot1", width: 16, height: 16, cornerRadius: 8, fill: "#FF0000" },
        ] },
        { type: "ref", id: "Inst", ref: "Btn", descendants: { BtnLabel: { fontSize: 12 } } },
      ] },
      { type: "text", id: "Auto", x: 300, y: 10, content: "Auto", fontFamily: "Inter", fontSize: 16, letterSpacing: INTER16, metadata: { type: "canvas", canvasLetterSpacing: "auto" } },
    ] },
    { type: "frame", id: "Btn", reusable: true, x: 600, y: 0, width: 80, height: 30, cornerRadius: 8, padding: [6, 12], layout: "horizontal", children: [
      { type: "text", id: "BtnLabel", content: "Go", fontFamily: "Inter", fontSize: 13 },
      { type: "ref", id: "BtnInner", ref: "Dot" },
    ] },
    { type: "frame", id: "Dot", reusable: true, x: 800, y: 0, width: 10, height: 10, cornerRadius: 5 },
  ],
};
const docFile = path.join(dir, "scale.canvas.json");
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

let clock = 7_000_000;
history.setClock(() => clock);

async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const scale = (b: Record<string, unknown>) => call("POST", "/api/scale", { file, ...b });
const q = `?file=${encodeURIComponent(file)}`;
const mem = () => pw.currentDoc(file).doc as any;
const find = (id: string, doc = mem()) => {
  const seek = (ns: any[]): any => { for (const n of ns) { if (n.id === id) return n; const h = n.children && seek(n.children); if (h) return h; } };
  return seek(doc.children);
};

beforeEach(async () => {
  fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
  await call("POST", "/api/update", { file, id: "B1", props: {} }); // the first-write refusal after an outside change
  history.resetHistory();
  clock += 5000;
});

describe("POST /api/scale", () => {
  test("every descendant, nested auto layout and instance overrides scale; tokens stay and are counted", async () => {
    const r = await scale({ ids: ["Card"], factor: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kept, 2, "cornerRadius $r and Row's gap $sp");
    const c = find("Card");
    assert.deepEqual([c.x, c.y, c.width, c.height], [10, 20, 400, 200], "top-left stays by default");
    assert.equal(c.gap, 16);
    assert.deepEqual(c.padding, [8, 12]);
    assert.deepEqual(c.cornerRadius, [4, "$r", 8, 0]);
    assert.equal(c.strokeWidth, 2);
    assert.deepEqual(c.effect, [{ type: "shadow", offset: { x: 2, y: 4 }, blur: 8, spread: 2, color: "#00000044" }, { type: "blur", radius: 6 }]);
    const t = find("T");
    assert.deepEqual([t.fontSize, t.letterSpacing, t.lineHeight, t.width], [28, 1, 1.4, "fill_container"]);
    const row = find("Row");
    assert.deepEqual([row.gap, row.padding, row.width, row.height], ["$sp", 4, "fit_content(160)", 40]);
    assert.deepEqual([find("Dot1").width, find("Dot1").cornerRadius], [32, 16]);
    // The instance: its own size and the component root's radius and padding as overrides; inner layers as
    // descendants overrides (the existing one scaled from its value); the component itself untouched.
    const inst = find("Inst");
    assert.deepEqual([inst.width, inst.height, inst.cornerRadius, inst.padding, inst.x], [160, 60, 16, [12, 24], undefined]);
    assert.equal(inst.descendants.BtnLabel.fontSize, 24);
    assert.deepEqual(inst.descendants.BtnInner, { width: 20, height: 20, cornerRadius: 10 }, "a nested instance's component x/y is not where it sits");
    assert.deepEqual(find("Btn"), DOC.children[1]);
    assert.deepEqual(find("Dot"), DOC.children[2]);
    // The board and the sibling outside the selection are untouched.
    assert.equal(find("B1").width, 400);
    assert.equal(find("Auto").fontSize, 16);
  });

  test("one undo step named Scale puts every node back; redo scales again", async () => {
    const before = structuredClone(mem().children);
    assert.equal((await scale({ ids: ["Card"], factor: 1.5 })).status, 200);
    const h = (await call("GET", `/api/history${q}`)).body;
    assert.equal(h.undo, "Scale");
    assert.equal(h.undoDepth, 1);
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    assert.deepEqual(mem().children, before);
    assert.equal((await call("POST", `/api/history/redo${q}`)).status, 200);
    assert.equal(find("T").fontSize, 21);
    assert.equal(find("Inst").descendants.BtnLabel.fontSize, 18);
  });

  test("copy on write: the version before is untouched and the safety net finds nothing to fix", async () => {
    await call("GET", `/api/doc${q}`);
    const old = mem();
    const was = JSON.stringify(old);
    assert.equal((await scale({ ids: ["Card", "Auto"], factor: 3 })).status, 200);
    assert.equal(JSON.stringify(old), was);
    await pw.flushWrites(file);
    assert.equal(await pw.verify(file), 0);
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(find("T", disk).fontSize, 42);
    assert.equal(find("Inst", disk).descendants.BtnLabel.fontSize, 36);
  });

  test("auto letter spacing recomputes for the new size instead of scaling", async () => {
    assert.equal((await scale({ ids: ["Auto"], factor: 2 })).status, 200);
    const a = find("Auto");
    assert.equal(a.fontSize, 32);
    assert.equal(a.letterSpacing, autoTracking("Inter", 32).px);
    assert.notEqual(a.letterSpacing, INTER16 * 2);
  });

  test("anchors, width instead of a factor, and the page's own positions", async () => {
    assert.equal((await scale({ ids: ["Card"], factor: 2, anchor: "center" })).status, 200);
    assert.deepEqual([find("Card").x, find("Card").y], [-90, -30]);
    fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
    await call("POST", "/api/update", { file, id: "B1", props: {} });
    const w = await scale({ ids: ["Card"], width: 300, anchor: "bottom-right" });
    assert.equal(w.body.factor, 1.5);
    assert.deepEqual([find("Card").x, find("Card").y, find("Card").width], [-90, -30, 300]);
    fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
    await call("POST", "/api/update", { file, id: "B1", props: {} });
    assert.equal((await scale({ ids: ["Card"], factor: 2, items: [{ id: "Card", x: 3, y: 4 }] })).status, 200);
    assert.deepEqual([find("Card").x, find("Card").y], [3, 4]);
  });

  test("a layer selected with its ancestor scales once; several layers share one anchor", async () => {
    assert.equal((await scale({ ids: ["Card", "T"], factor: 2 })).status, 200);
    assert.equal(find("T").fontSize, 28);
    fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
    await call("POST", "/api/update", { file, id: "B1", props: {} });
    // Btn (600..680) and Dot (800..810) about their union's top-left: Dot moves away from Btn.
    assert.equal((await scale({ ids: ["Btn", "Dot"], factor: 2 })).status, 200);
    assert.deepEqual([find("Btn").x, find("Dot").x, find("Dot").width], [600, 1000, 20]);
  });

  test("refusals: a bad factor, two sizes, a layer inside an instance, an unknown id, a missing header", async () => {
    assert.equal((await scale({ ids: ["Card"], factor: 0 })).status, 400);
    assert.equal((await scale({ ids: ["Card"], factor: 2, width: 10 })).status, 400);
    assert.equal((await scale({ ids: ["Inst/BtnLabel"], factor: 2 })).body.code, "instance");
    assert.equal((await scale({ ids: ["Nope"], factor: 2 })).status, 404);
    assert.equal((await scale({ ids: ["T"], width: 50 })).body.code, "no_size", "fill_container has no width to scale to");
    const r = await fetch(base + "/api/scale", { method: "POST", body: JSON.stringify({ file, ids: ["Card"], factor: 2 }) });
    assert.equal(r.status, 403);
    await r.text();
    assert.equal(find("Card").width, 200);
  });

  test("plan: the token paths a scale keeps, per scene id (instance layers included)", async () => {
    const p = await scale({ ids: ["Card"], plan: true });
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.nodes.Card.bound, ["cornerRadius.1"]);
    assert.deepEqual(p.body.nodes.Row.bound, ["gap"]);
    assert.deepEqual((await scale({ ids: ["Auto"], plan: true })).body.nodes.Auto, { auto: true });
  });

  test("the live preview (the page's math on the board's scene) equals the scene after the write", async () => {
    const sceneOf = async () => (await call("GET", `/api/scene${q}&id=B1`)).body;
    const s0 = await sceneOf();
    const plan = (await scale({ ids: ["Card"], plan: true })).body.nodes;
    const bound = new Map(Object.entries(plan).map(([id, v]: [string, any]) => [id, new Set(v.bound ?? [])]));
    const card = L.findNode(s0.root, "Card");
    const f = 1.75;
    // What live.js does: every node's scaled props as overrides; the layer's place from the anchor.
    const edits = new L.LiveEdits();
    const pos = { x: K.r2(card.x + (K.scaleRectAbout({ x: card.x, y: card.y, w: 200, h: 100 }, card.x, card.y, f).x - card.x)), y: card.y };
    for (const n of K.scaleScene(card, f, bound)) edits.set("B1", n.id, n.id === "Card" ? { ...n.props, ...pos } : n.props, [], 1);
    const preview = structuredClone(s0);
    edits.apply("B1", preview);
    assert.equal((await scale({ ids: ["Card"], factor: f, items: [{ id: "Card", ...pos }] })).status, 200);
    const s1 = await sceneOf();
    const flat = (n: any, out: Record<string, any> = {}) => {
      const keep: Record<string, unknown> = {};
      for (const k of K.SCALED_KEYS) if (n[k] !== undefined) keep[k] = n[k];
      keep.lineHeight = n.lineHeight;
      out[n.id] = keep;
      for (const c of n.children ?? []) flat(c, out);
      return out;
    };
    const want = flat(L.findNode(s1.root, "Card"));
    assert.ok(Object.keys(want).includes("Inst/BtnLabel"), "instance layers are compared too");
    assert.deepEqual(flat(L.findNode(preview.root, "Card")), want);
  });
});
