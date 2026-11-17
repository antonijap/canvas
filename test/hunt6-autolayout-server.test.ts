// Regression tests for bug hunt round 6, auto layout on the server (.planning/research/hunt-6-autolayout.md and
// hunt-6-codex.md): hidden siblings, pages, component cycles, remove without rects, wrap on Hug, Shift+A on a
// Fill frame, arrow bursts, hidden Fill children, cross gap.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
// @ts-ignore: a plain ES module the page imports too
import * as A from "../src/page/autolayout-logic.js";

const dir = tmpDir("hunt6-al");
process.env.CANVAS_ROOTS = dir;
const box = (id: string, w: number, h: number, extra = {}) => ({ type: "rectangle", id, width: w, height: h, fill: "#00FF00", ...extra });
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B1", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [] },
    { type: "frame", id: "F", x: 500, y: 0, width: 400, height: 60, layout: "horizontal", gap: 10, children: [box("H", 30, 30, { enabled: false }), box("A", 30, 30), box("B", 30, 30), box("C", 30, 30)] },
    { type: "frame", id: "Cmp", reusable: true, x: 0, y: 600, layout: "horizontal", children: [box("CL", 20, 20)] },
    { type: "frame", id: "Holder", x: 0, y: 700, layout: "horizontal", children: [{ type: "ref", id: "I1", ref: "Cmp" }] },
    { type: "frame", id: "J", x: 0, y: 900, width: 200, height: 100, layout: "horizontal", justifyContent: "center", alignItems: "center", children: [box("J1", 40, 20), box("J2", 40, 20)] },
    { type: "frame", id: "P", x: 0, y: 1100, width: 400, height: 200, layout: "vertical", children: [
      { type: "frame", id: "N", layout: "none", width: "fill_container", height: 100, children: [box("r", 20, 20, { x: 10, y: 10 })] },
    ] },
    { type: "frame", id: "W", x: 0, y: 1400, layout: "horizontal", gap: 10, padding: 10, children: [box("W1", 100, 40), box("W2", 100, 40), box("W3", 100, 40)] },
    { type: "frame", id: "HF", x: 0, y: 1500, width: 300, layout: "horizontal", children: [box("HF1", 50, 50), box("HF2", 20, 20, { enabled: false, width: "fill_container" })] },
    { type: "frame", id: "T", x: 0, y: 1600, layout: "horizontal", children: [{ type: "text", id: "T1", content: "Hello", fontSize: 14, fontFamily: "Inter", fontWeight: "400", fill: "#000000" }] },
  ],
};
const p = path.join(dir, "h.canvas.json");
fs.writeFileSync(p, JSON.stringify(DOC, null, 2));
const file = fs.realpathSync(p);
const widgetsJson = path.join(dir, "h.widgets.json");
const PAGES = { widgets: [], pages: [{ id: "p1", name: "One", boards: ["B1"] }, { id: "p2", name: "Two", boards: ["F", "Cmp", "Holder", "J", "P", "W", "HF", "T"] }] };
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const { removeAutoLayout } = await import("../src/autolayout.ts");
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

async function call(method: string, q: string, body?: unknown) {
  const r = await fetch(base + q, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const op = (b: Record<string, unknown>) => call("POST", "/api/layout", { file, ...b });
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const find = (id: string): any => {
  const s = (l: any[]): any => { for (const n of l) { if (n.id === id) return n; const h = n.children && s(n.children); if (h) return h; } };
  return s(read().children);
};
const kids = (id: string) => find(id).children.map((n: any) => n.id);
const depth = async () => (await call("GET", `/api/history?file=${encodeURIComponent(file)}`)).body.undoDepth as number;
beforeEach(async () => {
  fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
  fs.writeFileSync(widgetsJson, JSON.stringify(PAGES));
  await call("POST", "/api/update", { file, id: "B1", props: {} });
  history.resetHistory();
  clock += 5000;
});

describe("hunt 6: place", () => {
  test("#1 / codex 4: arrow Right on A beside a hidden sibling moves it (the page sends the sibling to land before)", async () => {
    // The page draws no hidden layers: it sees [A, B, C].
    const flow = ["A", "B", "C"];
    const slot = A.arrowSlot("horizontal", 1, 0, flow, ["A"]);
    const order = A.orderWith(flow, flow, ["A"], slot);
    assert.deepEqual(order, ["B", "A", "C"]);
    const r = await op({ op: "place", ids: ["A"], parent: "F", before: A.beforeIn(order, ["A"]), merge: "nudge" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    assert.deepEqual(kids("F"), ["H", "B", "A", "C"]);
    // To the end: before null.
    await op({ op: "place", ids: ["A"], parent: "F", before: null });
    assert.deepEqual(kids("F"), ["H", "B", "C", "A"]);
    // A sibling that is not there is refused, not guessed.
    assert.equal((await op({ op: "place", ids: ["A"], parent: "F", before: "nope" })).status, 400);
  });

  test("#2: a layer dropped on empty canvas from page 2 becomes a board on page 2", async () => {
    const r = await op({ op: "place", ids: ["C"], parent: null, index: 0, absolute: [{ x: 1200, y: 0 }], page: "p2" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pg = await call("GET", `/api/pages?file=${encodeURIComponent(file)}`);
    assert.equal(pg.body.pages.find((x: any) => x.boards.includes("C"))?.id, "p2");
    // An agent's place without a page: the page of the board it came from.
    const r2 = await op({ op: "place", ids: ["B"], parent: null, index: 0, absolute: [{ x: 1300, y: 0 }] });
    assert.equal(r2.status, 200);
    const pg2 = await call("GET", `/api/pages?file=${encodeURIComponent(file)}`);
    assert.equal(pg2.body.pages.find((x: any) => x.boards.includes("B"))?.id, "p2");
  });

  test("#3: an instance cannot go inside its own component", async () => {
    const r = await op({ op: "place", ids: ["I1"], parent: "Cmp", index: 1 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "cycle");
    assert.deepEqual(kids("Cmp"), ["CL"]);
    const sc = await call("GET", `/api/scene?file=${encodeURIComponent(file)}&id=Cmp`);
    assert.equal(sc.status, 200);
  });

  test("#3: nor inside a component it uses through another instance (Holder holds I1 of Cmp)", async () => {
    // Make Holder a component; an instance of Holder placed into Cmp would draw Cmp inside Cmp.
    await call("POST", "/api/update", { file, id: "Holder", props: { reusable: true } });
    const doc = read();
    doc.children[0].children = [{ type: "ref", id: "I2", ref: "Holder" }];
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    await call("POST", "/api/update", { file, id: "B1", props: {} });
    const r = await op({ op: "place", ids: ["I2"], parent: "Cmp", index: 0 });
    assert.equal(r.body.code, "cycle", JSON.stringify(r.body));
  });

  test("#11: an arrow burst moving two adjacent siblings folds into one undo step", async () => {
    // File indexes ([H, A, B, C]): the history fold is what is tested here, not the page's anchors.
    await op({ op: "place", ids: ["A", "B"], parent: "F", index: 2, merge: "nudge" });
    clock += 100;
    assert.deepEqual(kids("F"), ["H", "C", "A", "B"]);
    await op({ op: "place", ids: ["A", "B"], parent: "F", index: 1, merge: "nudge" });
    assert.deepEqual(kids("F"), ["H", "A", "B", "C"]);
    assert.equal(await depth(), 1, "two presses on [A, B]: one step");
    clock += 5000;
    await op({ op: "place", ids: ["B", "C"], parent: "F", index: 1, merge: "nudge" });
    clock += 100;
    await op({ op: "place", ids: ["B", "C"], parent: "F", index: 2, merge: "nudge" });
    clock += 100;
    await op({ op: "place", ids: ["B", "C"], parent: "F", index: 1, merge: "nudge" });
    assert.deepEqual(kids("F"), ["H", "B", "C", "A"]);
    assert.equal(await depth(), 2, "three presses on [B, C]: one more step");
    await call("POST", "/api/history/undo?file=" + encodeURIComponent(file));
    assert.deepEqual(kids("F"), ["H", "A", "B", "C"], "undo puts the burst back in one go");
  });
});

describe("hunt 6: remove, add, sizing, settings", () => {
  test("#8: remove without rects honours justifyContent and alignItems center", async () => {
    const r = await op({ op: "remove", ids: ["J"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([find("J1").x, find("J1").y, find("J2").x, find("J2").y], [60, 40, 100, 40]);
  });

  test("#8: remove without rects refuses a size it cannot know instead of guessing 0", async () => {
    const r = await op({ op: "remove", ids: ["T"] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /open the file in Canvas/);
    assert.equal(find("T").layout, "horizontal");
  });

  test("#12 / QA item 20: a hidden flow child lands after the last layer of the flow, not at 0,0 nor on a sibling", () => {
    const doc: any = { children: [{ type: "frame", id: "F", x: 0, y: 0, layout: "horizontal", padding: 20, gap: 10, children: [
      { type: "rectangle", id: "a", width: 30, height: 30 }, { type: "rectangle", id: "h", width: 30, height: 30, enabled: false }, { type: "rectangle", id: "b", width: 30, height: 30 }] }] };
    removeAutoLayout(doc, ["F"], { F: { x: 0, y: 0, w: 110, h: 70 }, a: { x: 20, y: 20, w: 30, h: 30 }, b: { x: 60, y: 20, w: 30, h: 30 } });
    const [a, h, b] = doc.children[0].children;
    assert.deepEqual([a.x, a.y, b.x, b.y], [20, 20, 60, 20], "shown layers stay where they were drawn");
    assert.deepEqual([h.x, h.y], [100, 20], "after b (60 + 30 + gap 10), not on top of it");
  });

  test("#9: Wrap on a frame that hugs its width makes the width Fixed at its size", async () => {
    const r = await op({ op: "settings", ids: ["W"], layout: { wrap: true }, rects: { W: { x: 0, y: 1400, w: 340, h: 60 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("W").width, 340);
    assert.equal(find("W").metadata.canvasLayout.wrap, true);
    // Without rects (an agent, Canvas closed): the size its flow gives it.
    await call("POST", "/api/history/undo?file=" + encodeURIComponent(file));
    const r2 = await op({ op: "settings", ids: ["W"], layout: { wrap: true } });
    assert.equal(r2.status, 200);
    assert.equal(find("W").width, 340);
    assert.equal(find("W").height, undefined, "the cross axis keeps hugging");
  });

  test("#10: Shift+A on a layout-none frame that fills its parent keeps Fill", async () => {
    const r = await op({ op: "add", ids: ["N"], rects: { P: { x: 0, y: 1100, w: 400, h: 200 }, N: { x: 0, y: 1100, w: 400, h: 100 }, r: { x: 10, y: 1110, w: 20, h: 20 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("N").width, "fill_container");
    assert.equal(find("N").height, "fit_content");
  });

  test("#13: a hidden Fill child does not stop Hug (the inspector offers it)", async () => {
    const r = await op({ op: "sizing", id: "HF", axis: "width", mode: "hug" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("HF").width, "fit_content");
  });

  test("#18: a negative cross gap is refused", async () => {
    const r = await op({ op: "settings", ids: ["F"], layout: { wrap: true, crossGap: -8 } });
    assert.equal(r.status, 400);
    assert.equal(find("F").metadata, undefined);
  });
});
