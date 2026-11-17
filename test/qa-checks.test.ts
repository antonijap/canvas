// The QA runner's pure parts: the catalog's YAML subset (qa/yaml.ts), the catalog and covers (qa/catalog.ts),
// and the shared checks that need no browser (qa/checks.ts).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { checkCovers, loadCatalog, parseCatalog } from "../qa/catalog.ts";
import { checkDocument, checkPackage, comparePng, firstDifference, latencyProblems } from "../qa/checks.ts";
import { parseYaml } from "../qa/yaml.ts";
import { encodePng } from "../fidelity/png.ts";

describe("qa yaml subset", () => {
  test("maps, lists, flow lists, scalars, comments", () => {
    const y = parseYaml(`# top
a: 1
b: "two # not a comment"
c: [x, 'y z', 3, true]
d:
  - id: one
    n: null
    sub:
      - p
      - q
  - plain
e:
- 1
- 2
`);
    assert.deepEqual(y, { a: 1, b: "two # not a comment", c: ["x", "y z", 3, true], d: [{ id: "one", n: null, sub: ["p", "q"] }, "plain"], e: [1, 2] });
  });
  test("refuses what it does not support, with the line", () => {
    assert.throws(() => parseYaml("a: &x 1"), /line 1/);
    assert.throws(() => parseYaml("a: {b: 1}"), /flow maps/);
    assert.throws(() => parseYaml("a: 1\na: 2"), /duplicate key/);
    assert.throws(() => parseYaml("a:\n\t- 1"), /tabs/);
  });
});

describe("qa catalog", () => {
  test("the real catalog loads, expands its sets and has every scripted area", () => {
    const c = loadCatalog();
    assert.ok(c.features.length > 50);
    const resize = c.byId.get("resize")!;
    assert.ok(resize.cases.includes("handle-nw") && resize.cases.includes("card-video") && resize.cases.includes("rectangle"));
    assert.equal(c.dimensionOf("dark"), "theme");
    assert.equal(c.dimensionOf("handle-nw"), "own");
  });
  test("bad catalogs are refused", () => {
    const base = (f: string) => `dimensions:\n  node: [rect]\nsets:\n  s: [rect]\nfeatures:\n${f}`;
    assert.throws(() => parseCatalog(base("  - id: a\n    name: A\n    area: x\n    driven: [page]\n    cases: [$nope]")), /no set \$nope/);
    assert.throws(() => parseCatalog(base("  - id: a\n    name: A\n    area: x\n    driven: [robot]\n    cases: [rect]")), /driven "robot"/);
    assert.throws(() => parseCatalog(base("  - id: a\n    name: A\n    area: x\n    driven: [page]\n    cases: [$s, rect]")), /listed twice/);
    assert.throws(() => parseCatalog("dimensions:\n  a: [x]\n  b: [x]\nfeatures: []"), /two dimensions/);
  });
  test("covers are checked against it", () => {
    const c = loadCatalog();
    assert.deepEqual(checkCovers(c, ["move:rectangle", "resize:handle-se"]), []);
    assert.equal(checkCovers(c, ["move:dodecahedron", "nope:x", "move"]).length, 3);
  });
});

describe("qa file check", () => {
  const doc = () => ({
    version: "2.21",
    variables: { brand: { type: "color", value: "#112233" } },
    children: [
      { type: "frame", id: "b1", x: 0, y: 0, width: 100, height: 100, children: [
        { type: "frame", id: "cmp", reusable: true, width: 10, height: 10, children: [{ type: "text", id: "lbl", content: "x" }] },
        { type: "ref", id: "i1", ref: "cmp", descendants: { lbl: { content: "y" } } },
        { type: "rectangle", id: "r1", width: 5, height: 5, fill: "$brand" },
      ] },
    ],
  });
  const side = () => ({ pages: [{ id: "p", boards: ["b1"] }, { id: "q", boards: [] }], widgets: [{ id: "w1", kind: "note", page: "p", x: 0, y: 0, w: 10, h: 10 }] });
  test("a sound document passes", () => assert.deepEqual(checkDocument(doc() as any, side()), []));
  test("duplicate ids, missing components, stale overrides, missing variables", () => {
    const d: any = doc();
    d.children[0].children.push({ type: "rectangle", id: "r1", width: 1, height: 1 });
    d.children[0].children[1].ref = "gone";
    d.children[0].children.push({ type: "ref", id: "i2", ref: "r1", descendants: { ghost: {} } });
    d.children[0].children[2].fill = "$nope";
    const errs = checkDocument(d, side()).join("\n");
    assert.match(errs, /duplicate id r1/);
    assert.match(errs, /i1 refers to "gone"/);
    assert.match(errs, /i2 refers to r1, which is not a component/);
    assert.match(errs, /overrides ghost/);
    assert.match(errs, /\$nope/);
  });
  test("a nested instance's swap (ref inside descendants) names a component; the overrides it carried name layers", () => {
    const d: any = doc();
    d.children[0].children.push(
      { type: "frame", id: "card", reusable: true, width: 10, height: 10, children: [{ type: "ref", id: "nb", ref: "cmp" }] },
      { type: "frame", id: "cmp2", reusable: true, width: 10, height: 10, children: [{ type: "text", id: "lbl2", content: "z" }] },
      { type: "ref", id: "ci", ref: "card", descendants: { nb: { ref: "cmp2", descendants: { lbl2: { fontSize: 20 } } }, "nb/lbl2": { content: "w" } } },
    );
    assert.deepEqual(checkDocument(d, side()), [], "a sound swap passes");
    d.children[0].children.at(-1).descendants.nb = { ref: "r1", descendants: { ghost: {} } };
    const errs = checkDocument(d, side()).join("\n");
    assert.match(errs, /ci swaps nb to r1, which is not a component/);
    assert.match(errs, /ci overrides nb\/ghost/);
  });
  test("pages and cards: missing boards, boards on two pages or none, cards on missing pages", () => {
    const d: any = doc();
    d.children.push({ type: "frame", id: "b2", width: 1, height: 1 });
    const s: any = side();
    s.pages[1].boards = ["b1", "zz"];
    s.widgets.push({ id: "w1", kind: "note", page: "nowhere", x: 0, y: 0, w: 0, h: 10 });
    const errs = checkDocument(d, s).join("\n");
    assert.match(errs, /b1 is on two pages/);
    assert.match(errs, /lists zz/);
    assert.match(errs, /b2 is on no page/);
    assert.match(errs, /duplicate card w1/);
    assert.match(errs, /page nowhere/);
    assert.match(errs, /size 0 x 10/);
  });
  test("the playground package is sound", () => {
    assert.deepEqual(checkPackage(path.join(import.meta.dirname, "..", "demos", "playground.canvas")), []);
  });
});

describe("qa byte comparison", () => {
  test("names the first differing path, by node id", () => {
    const a = { "document.json": JSON.stringify({ children: [{ id: "x", w: 1 }] }) };
    assert.equal(firstDifference(a, { ...a }), null);
    assert.match(firstDifference(a, { "document.json": JSON.stringify({ children: [{ id: "x", w: 2 }] }) })!, /\[x\]\.w: 1 -> 2/);
    assert.match(firstDifference(a, { "document.json": JSON.stringify({ children: [{ w: 1, id: "x" }] }) })!, /key order id,w -> w,id/);
    assert.match(firstDifference(a, { "document.json": JSON.stringify({ children: [{ id: "x", w: 1 }] }, null, 2) })!, /same JSON but other bytes/);
  });
});

describe("qa pixels and latency", () => {
  const img = (w: number, h: number, f: (x: number, y: number) => number[]) => {
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 4);
    return encodePng({ width: w, height: h, data: d });
  };
  test("same pictures pass; a changed block fails with a diff image; a size change fails", () => {
    const a = img(40, 40, () => [255, 255, 255, 255]);
    assert.equal(comparePng(a, a).ok, true);
    const b = img(40, 40, (x, y) => (x > 10 && x < 20 && y > 10 && y < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const d = comparePng(a, b);
    assert.equal(d.ok, false);
    assert.ok(d.mismatched > 30 && d.diffPng);
    assert.equal(comparePng(a, img(41, 40, () => [255, 255, 255, 255])).sizeMismatch, true);
  });
  test("latency: single samples against the budget, p95 from five on", () => {
    assert.deepEqual(latencyProblems([{ kind: "write", ms: 40, what: "a" }]), []);
    assert.deepEqual(latencyProblems([{ kind: "write", ms: 140, what: "a" }]), [], "one slow sample under twice the budget is load");
    assert.match(latencyProblems([{ kind: "write", ms: 240, what: "a" }])[0], /write a 240\.0 ms, over twice the 100 ms budget/);
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: "input" as const, ms: i === 19 ? 50 : 5, what: "k" }));
    assert.deepEqual(latencyProblems(many), [], "one slow sample in 20 is above p95");
  });
});

// A scratch dir for checkPackage on a broken package.
test("qa: a package whose document does not parse is reported, not thrown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-checks-"));
  try {
    fs.writeFileSync(path.join(dir, "document.json"), "{");
    assert.match(checkPackage(dir)[0], /document\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("qa: every scripted scenario says what it covers, in the catalog's terms, and opts out only with a reason", async () => {
  const { scenarios } = await import("../qa/harness.ts");
  await import("../qa/scenarios.ts");
  const c = loadCatalog();
  const bad: string[] = [];
  for (const s of scenarios) {
    if (!s.covers.length) bad.push(`${s.name}: no covers`);
    for (const e of checkCovers(c, s.covers)) bad.push(`${s.name}: ${e}`);
    for (const [k, why] of Object.entries(s.skip ?? {})) if (!why || why.length < 12) bad.push(`${s.name}: opts out of ${k} without a reason`);
  }
  assert.deepEqual(bad, []);
});
