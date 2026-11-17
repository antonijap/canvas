// Auto layout ops (src/autolayout.ts, POST /api/layout): inference, add, remove, place, sizing, settings, the
// canvasLayout metadata merge, and their undo steps.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { inferLayout, inferPadding, mergeCanvasLayout, paddingValue, readPadding, settingsProps, sizeMode, slotToIndex } from "../src/autolayout.ts";

const dir = tmpDir("autolayout");
process.env.CANVAS_ROOTS = dir;
const rect = (id: string, x: number, y: number, w = 40, h = 40) => ({ type: "rectangle", id, x, y, width: w, height: h, fill: "#FF0000" });
const box = (id: string, w: number, h: number) => ({ type: "rectangle", id, width: w, height: h, fill: "#00FF00" });
const DOC = {
  version: "2.21",
  children: [
    // Loose layers, layer order 3, 1, 2 (visual order 1, 2, 3).
    { type: "frame", id: "B1", name: "Board", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [
      rect("R3", 100, 0), rect("R1", 0, 0), rect("R2", 50, 0),
      { type: "frame", id: "LN", name: "Card", x: 0, y: 200, width: 200, height: 100, layout: "none", children: [rect("K2", 124, 12, 60, 76), rect("K1", 16, 12, 60, 76)] },
    ] },
    // A vertical auto layout frame.
    { type: "frame", id: "F1", name: "Stack", x: 500, y: 0, width: 200, layout: "vertical", gap: 10, padding: 10, children: [box("A", 100, 20), box("B", 100, 30), box("C", 100, 40)] },
    // A horizontal frame that hugs (no width or height).
    { type: "frame", id: "F2", name: "Row", x: 0, y: 1000, layout: "horizontal", padding: 10, children: [box("D", 50, 50)] },
    { type: "frame", id: "Cmp", name: "Button", reusable: true, x: 0, y: 1200, width: 120, height: 40, layout: "horizontal", children: [box("CmpL", 20, 20)] },
    { type: "ref", id: "I1", ref: "Cmp", x: 200, y: 1200 },
  ],
};
const F1_RECTS = { F1: { x: 500, y: 0, w: 200, h: 130 }, A: { x: 510, y: 10, w: 100, h: 20 }, B: { x: 510, y: 40, w: 100, h: 30 }, C: { x: 510, y: 80, w: 100, h: 40 } };

const p = path.join(dir, "layout.canvas.json");
fs.writeFileSync(p, JSON.stringify(DOC, null, 2));
const file = fs.realpathSync(p);
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
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
const user = { "x-canvas": "1" };
async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = user) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const op = (body: Record<string, unknown>) => call("POST", "/api/layout", { file, ...body });
const undo = () => call("POST", `/api/history/undo?file=${encodeURIComponent(file)}`);
const redo = () => call("POST", `/api/history/redo?file=${encodeURIComponent(file)}`);
const depth = async () => (await call("GET", `/api/history?file=${encodeURIComponent(file)}`)).body.undoDepth as number;
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const find = (id: string): any => {
  const seek = (list: any[]): any => {
    for (const n of list) {
      if (n.id === id) return n;
      const h = n.children && seek(n.children);
      if (h) return h;
    }
  };
  return seek(read().children);
};
const kids = (id: string): string[] => (id === "document" ? read().children : find(id).children).map((n: any) => n.id);

beforeEach(async () => {
  fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
  // the engine refuses the first write after an outside change; spend that refusal here.
  await call("POST", "/api/update", { file, id: "B1", props: {} });
  history.resetHistory();
  clock += 5000;
});

describe("inference (pure)", () => {
  test("three 40x40 rects at x 0, 50, 100: horizontal, gap 10, start, ordered by x whatever the layer order", () => {
    const rs = [{ x: 100, y: 0, w: 40, h: 40 }, { x: 0, y: 0, w: 40, h: 40 }, { x: 50, y: 0, w: 40, h: 40 }];
    assert.deepEqual(inferLayout(rs), { layout: "horizontal", gap: 10, alignItems: "start", order: [1, 2, 0] });
  });
  test("a vertical stack with gaps 8 and 12: vertical, gap 10", () => {
    const rs = [{ x: 0, y: 0, w: 80, h: 20 }, { x: 0, y: 28, w: 80, h: 20 }, { x: 0, y: 60, w: 80, h: 20 }];
    const r = inferLayout(rs);
    assert.equal(r.layout, "vertical");
    assert.equal(r.gap, 10);
  });
  test("shared centre lines: center; shared bottoms: end; overlaps count 0", () => {
    assert.equal(inferLayout([{ x: 0, y: 0, w: 20, h: 40 }, { x: 30, y: 10, w: 20, h: 20 }, { x: 60, y: 15, w: 20, h: 10 }]).alignItems, "center");
    assert.equal(inferLayout([{ x: 0, y: 0, w: 20, h: 40 }, { x: 30, y: 20, w: 20, h: 20 }]).alignItems, "end");
    assert.equal(inferLayout([{ x: 0, y: 0, w: 40, h: 40 }, { x: 30, y: 0, w: 40, h: 40 }, { x: 80, y: 0, w: 40, h: 40 }]).gap, 5);
  });
  test("frame 200x100 with content from 16,12 to 184,88: padding 12,16,12,16", () => {
    assert.deepEqual(inferPadding({ w: 200, h: 100 }, [{ x: 16, y: 12, w: 60, h: 76 }, { x: 124, y: 12, w: 60, h: 76 }]), [12, 16, 12, 16]);
    assert.deepEqual(paddingValue([12, 16, 12, 16]), [12, 16]);
    assert.equal(paddingValue([8, 8, 8, 8]), 8);
    assert.equal(paddingValue([0, 0, 0, 0]), undefined);
    assert.deepEqual(paddingValue([1, 2, 3, 4]), [1, 2, 3, 4]);
    assert.deepEqual(readPadding([4, 6]), [4, 6, 4, 6]);
  });
  test("sizeMode and slotToIndex", () => {
    assert.equal(sizeMode({ type: "frame", id: "x" } as any, "width"), "hug");
    assert.equal(sizeMode({ type: "frame", id: "x", width: "fill_container(320)" } as any, "width"), "fill");
    assert.equal(sizeMode({ type: "text", id: "x", textGrowth: "fixed-width" } as any, "width"), "fixed");
    assert.equal(sizeMode({ type: "text", id: "x", textGrowth: "fixed-width" } as any, "height"), "hug");
    assert.equal(slotToIndex(["a", "b", "c"], ["a"], 3), 2);
    assert.equal(slotToIndex(["a", "b", "c"], ["c"], 0), 0);
  });
});

describe("canvasLayout metadata (pure)", () => {
  test("the merge keeps foreign type and keys; removing the last Canvas key removes metadata", () => {
    const foreign = { type: "other-plugin", note: "keep me" };
    const on = mergeCanvasLayout(foreign, { wrap: true, minWidth: 120 }) as any;
    assert.deepEqual(on, { type: "other-plugin", note: "keep me", canvasLayout: { wrap: true, minWidth: 120 } });
    assert.deepEqual(mergeCanvasLayout(on, { wrap: null, minWidth: null }), foreign);
    const mine = mergeCanvasLayout(undefined, { stacking: "first" }) as any;
    assert.deepEqual(mine, { type: "canvas", canvasLayout: { stacking: "first" } });
    assert.equal(mergeCanvasLayout(mine, { stacking: "last" }), null);
    const both = mergeCanvasLayout({ type: "canvas", canvasLetterSpacing: "auto" }, { baseline: true }) as any;
    assert.deepEqual(mergeCanvasLayout(both, { baseline: false }), { type: "canvas", canvasLetterSpacing: "auto" });
  });
  test("settings write native fallbacks: evenly -> space_around, baseline -> end", () => {
    const f = { type: "frame", id: "f", layout: "horizontal" } as any;
    assert.deepEqual(settingsProps(f, { gapMode: "evenly" }), { set: { justifyContent: "space_around", metadata: { type: "canvas", canvasLayout: { gapMode: "evenly" } } }, remove: [] });
    assert.deepEqual(settingsProps(f, { gapMode: "between" }), { set: { justifyContent: "space_between" }, remove: [] });
    assert.deepEqual(settingsProps(f, { baseline: true }).set.alignItems, "end");
    const based = { ...f, alignItems: "end", metadata: { type: "canvas", canvasLayout: { baseline: true } } };
    assert.deepEqual(settingsProps(based, { baseline: false }), { set: {}, remove: ["alignItems", "metadata"] });
    assert.throws(() => settingsProps(f, { bogus: 1 } as any), /unknown auto layout setting/);
    assert.throws(() => settingsProps({ type: "rectangle", id: "r" } as any, { wrap: true }), /frame setting/);
  });
});

describe("add (Shift+A)", () => {
  test("loose layers: a new hugging frame where they were, ordered left to right, gap 10, padding 0; undo removes it", async () => {
    const before = read();
    const r = await op({ op: "add", ids: ["R3", "R1", "R2"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.label, "Add Auto Layout");
    const fid = r.body.select[0];
    const f = find(fid);
    assert.deepEqual([f.type, f.name, f.layout, f.gap, f.padding, f.width, f.height, f.x, f.y], ["frame", "Frame 1", "horizontal", 10, undefined, "fit_content", "fit_content", 0, 0]);
    assert.deepEqual(f.children.map((c: any) => [c.id, c.x, c.y]), [["R1", undefined, undefined], ["R2", undefined, undefined], ["R3", undefined, undefined]]);
    assert.deepEqual(kids("B1"), [fid, "LN"]);
    assert.equal(await depth(), 1);
    assert.equal((await undo()).status, 200);
    assert.deepEqual(read(), before);
    assert.equal(JSON.stringify(read()), JSON.stringify(before), "every key where it was");
    assert.equal((await redo()).status, 200);
    assert.deepEqual(kids(fid), ["R1", "R2", "R3"]);
  });
  test("a frame with content: it becomes auto layout, padding from its edges to the content, hugs both axes", async () => {
    const r = await op({ op: "add", ids: ["LN"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.select, ["LN"]);
    const f = find("LN");
    assert.deepEqual([f.layout, f.gap, f.padding, f.width, f.height], ["horizontal", 48, [12, 16], "fit_content", "fit_content"]);
    assert.deepEqual(f.children.map((c: any) => [c.id, c.x, c.y]), [["K1", undefined, undefined], ["K2", undefined, undefined]]);
    await undo();
    assert.deepEqual(read(), DOC);
  });
  test("children of an auto layout frame: wrapped in a nested frame at the first one's place", async () => {
    const r = await op({ op: "add", ids: ["B", "C"], rects: F1_RECTS });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const fid = r.body.select[0];
    assert.deepEqual(kids("F1"), ["A", fid]);
    const f = find(fid);
    assert.deepEqual([f.layout, f.gap, f.x, f.y], ["vertical", 10, undefined, undefined]);
  });
  test("instance layers refuse with 409 instance", async () => {
    const r = await op({ op: "add", ids: ["I1/CmpL"] });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "instance");
  });
});

describe("remove (Option+Shift+A)", () => {
  test("children get x/y from rects, the frame and Fill children get fixed sizes; undo restores the auto layout", async () => {
    const doc = structuredClone(DOC);
    (doc.children[1] as any).children[0].width = "fill_container";
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    await call("POST", "/api/update", { file, id: "B1", props: {} });
    history.resetHistory();
    const r = await op({ op: "remove", ids: ["F1"], rects: { ...F1_RECTS, A: { x: 510, y: 10, w: 180, h: 20 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.label, "Remove Auto Layout");
    const f = find("F1");
    assert.deepEqual([f.layout, f.gap, f.padding, f.width, f.height], ["none", undefined, undefined, 200, 130]);
    assert.deepEqual(f.children.map((c: any) => [c.id, c.x, c.y, c.width]), [["A", 10, 10, 180], ["B", 10, 40, 100], ["C", 10, 80, 100]]);
    assert.equal((await undo()).status, 200);
    assert.deepEqual(read(), doc);
  });
  test("without rects it works from the file's numbers; deep removes nested auto layout too", async () => {
    const r = await op({ op: "remove", ids: ["F1"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(find("F1").children.map((c: any) => [c.x, c.y]), [[10, 10], [10, 40], [10, 80]]);
    await undo();
    const wrap = await op({ op: "add", ids: ["B", "C"], rects: F1_RECTS });
    const deep = await op({ op: "remove", ids: ["F1"], deep: true, rects: F1_RECTS });
    assert.equal(deep.status, 200, JSON.stringify(deep.body));
    assert.equal(find(wrap.body.select[0]).layout, "none");
  });
  test("an instance refuses; a frame without auto layout says there is nothing to remove", async () => {
    assert.equal((await op({ op: "remove", ids: ["I1"] })).body.code, "instance");
    assert.equal((await op({ op: "remove", ids: ["LN"] })).status, 400);
  });
});

describe("place", () => {
  test("reorder in a flow: one step, redo works, ids unchanged", async () => {
    const r = await op({ op: "place", ids: ["A"], parent: "F1", index: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.label, "Reorder");
    assert.deepEqual(kids("F1"), ["B", "C", "A"]);
    assert.equal(await depth(), 1);
    await undo();
    assert.deepEqual(read(), DOC);
    await redo();
    assert.deepEqual(kids("F1"), ["B", "C", "A"]);
  });
  test("several layers land together in their order", async () => {
    await op({ op: "place", ids: ["C", "A"], parent: "F1", index: 0 });
    assert.deepEqual(kids("F1"), ["A", "C", "B"]);
  });
  test("into a flow from a free board: x/y dropped, one step", async () => {
    const r = await op({ op: "place", ids: ["R1"], parent: "F1", index: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.label, "Move Into Frame");
    assert.deepEqual(kids("F1"), ["A", "R1", "B", "C"]);
    assert.deepEqual([find("R1").x, find("R1").y], [undefined, undefined]);
    await undo();
    assert.deepEqual(read(), DOC);
    await redo();
    assert.deepEqual(kids("F1"), ["A", "R1", "B", "C"]);
  });
  test("out of a flow onto a board: x/y keep it where it was drawn", async () => {
    const r = await op({ op: "place", ids: ["B"], parent: "B1", index: 4, rects: { ...F1_RECTS, B1: { x: 0, y: 0, w: 400, h: 400 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.label, "Move Out of Frame");
    assert.deepEqual(kids("B1"), ["R3", "R1", "R2", "LN", "B"]);
    assert.deepEqual([find("B").x, find("B").y], [510, 40]);
    await undo();
    assert.deepEqual(read(), DOC);
  });
  test("absolute into a flow: layoutPosition absolute at the given x/y", async () => {
    const r = await op({ op: "place", ids: ["R1"], parent: "F1", index: 3, absolute: [{ x: 5, y: 6 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const n = find("R1");
    assert.deepEqual([n.x, n.y, n.layoutPosition], [5, 6, "absolute"]);
  });
  test("into its own descendant: 400; into or out of an instance: 409", async () => {
    assert.equal((await op({ op: "place", ids: ["B1"], parent: "LN", index: 0 })).status, 400);
    assert.equal((await op({ op: "place", ids: ["LN"], parent: "LN", index: 0 })).status, 400);
    const inst = await op({ op: "place", ids: ["R1"], parent: "I1", index: 0 });
    assert.deepEqual([inst.status, inst.body.code], [409, "instance"]);
    assert.equal((await op({ op: "place", ids: ["R1"], parent: "I1/CmpL", index: 0 })).status, 409);
    assert.equal((await op({ op: "place", ids: ["I1/CmpL"], parent: "F1", index: 0 })).status, 409);
    assert.equal((await op({ op: "place", ids: ["R1"], parent: "F1", index: -1 })).status, 400);
  });
  test("the same place: no write, no undo step", async () => {
    const r = await op({ op: "place", ids: ["B"], parent: "F1", index: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, false);
    assert.equal(await depth(), 0);
    assert.deepEqual(read(), DOC);
  });
  test("an arrow-key burst (merge nudge) is one undo step", async () => {
    for (const index of [1, 2, 1, 2]) {
      const r = await op({ op: "place", ids: ["A"], parent: "F1", index, merge: "nudge" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      clock += 200;
    }
    assert.deepEqual(kids("F1"), ["B", "C", "A"]);
    assert.equal(await depth(), 1);
    await undo();
    assert.deepEqual(kids("F1"), ["A", "B", "C"]);
    clock += 5000;
    await op({ op: "place", ids: ["A"], parent: "F1", index: 1, merge: "nudge" });
    clock += 5000;
    await op({ op: "place", ids: ["A"], parent: "F1", index: 2, merge: "nudge" });
    assert.equal(await depth(), 2, "a pause starts a new step");
  });
});

describe("sizing", () => {
  test("Fill under a hugging parent makes the parent Fixed in the same step", async () => {
    const r = await op({ op: "sizing", id: "D", axis: "width", mode: "fill", rects: { F2: { x: 0, y: 1000, w: 70, h: 70 }, D: { x: 10, y: 1010, w: 50, h: 50 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.label, "Size Change");
    assert.equal(find("D").width, "fill_container");
    assert.equal(find("F2").width, 70);
    assert.equal(find("F2").height, undefined);
    assert.equal(await depth(), 1);
    await undo();
    assert.deepEqual(read(), DOC);
  });
  test("Hug on an auto layout frame, Fixed from rects; Fill outside a flow and Hug on a plain rect refuse", async () => {
    assert.equal((await op({ op: "sizing", id: "F1", axis: "width", mode: "hug" })).status, 200);
    assert.equal(find("F1").width, "fit_content");
    assert.equal((await op({ op: "sizing", id: "F2", axis: "height", mode: "fixed", rects: { F2: { x: 0, y: 1000, w: 70, h: 70 } } })).status, 200);
    assert.equal(find("F2").height, 70);
    assert.equal((await op({ op: "sizing", id: "R1", axis: "width", mode: "fill" })).status, 400);
    assert.equal((await op({ op: "sizing", id: "A", axis: "width", mode: "hug" })).status, 400);
    assert.equal((await op({ op: "sizing", id: "A", axis: "depth", mode: "hug" })).status, 400);
  });
  test("Hug on an instance of an auto layout component: fit_content, or the instance's own size goes when the component hugs", async () => {
    const r = await op({ op: "sizing", id: "I1", axis: "width", mode: "hug" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("I1").width, "fit_content", "the component has a set width: the instance hugs on its own");
    await undo();
    assert.equal((await call("POST", "/api/update", { file, id: "Cmp", props: { width: "fit_content" } })).status, 200);
    assert.equal((await call("POST", "/api/update", { file, id: "I1", props: { width: 135 } })).status, 200);
    assert.equal((await op({ op: "sizing", id: "I1", axis: "width", mode: "hug" })).status, 200);
    assert.equal(find("I1").width, undefined, "the component hugs: the instance follows it again");
  });
  test("Hug is refused while a child fills that axis", async () => {
    await op({ op: "sizing", id: "A", axis: "width", mode: "fill" });
    const r = await op({ op: "sizing", id: "F1", axis: "width", mode: "hug" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /fills the width/);
  });
});

describe("settings", () => {
  test("wrap, min width and evenly land in metadata with fallbacks, keeping foreign metadata; one step", async () => {
    const doc = structuredClone(DOC) as any;
    doc.children[1].metadata = { type: "other", keep: 1 };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    await call("POST", "/api/update", { file, id: "B1", props: {} });
    history.resetHistory();
    const r = await op({ op: "settings", ids: ["F1"], layout: { wrap: true, minWidth: 120, gapMode: "evenly" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = find("F1");
    assert.equal(f.justifyContent, "space_around");
    assert.deepEqual(f.metadata, { type: "other", keep: 1, canvasLayout: { wrap: true, minWidth: 120, gapMode: "evenly" } });
    await op({ op: "settings", ids: ["F1"], layout: { wrap: null, minWidth: null, gapMode: null } });
    assert.deepEqual(find("F1").metadata, { type: "other", keep: 1 });
    assert.equal(find("F1").justifyContent, undefined);
    assert.equal((await op({ op: "settings", ids: ["F1"], layout: { wrap: "yes" } })).status, 400);
  });
});

describe("route", () => {
  test("needs the x-canvas header, file and op; unknown ops are 400", async () => {
    assert.equal((await call("POST", "/api/layout", { file, op: "add", ids: ["R1"] }, {})).status, 403);
    assert.equal((await call("POST", "/api/layout", { op: "add" })).status, 400);
    assert.equal((await op({ op: "explode", ids: ["R1"] })).status, 400);
    assert.equal((await op({ op: "add", ids: ["Nope"] })).status, 404);
  });
});
