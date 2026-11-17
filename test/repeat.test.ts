// Edit > Repeat (src/repeat.ts, POST /api/repeat): the last property edit again on a new selection, the same value
// or the same change from each layer's own value, one write and one undo step; and the corner radius handles'
// math (src/page/radius-logic.js).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { cleanRel, fromNudge, fromUpdate, planRepeat, relText, repeatToast, type RepeatEdit } from "../src/repeat.ts";
// @ts-ignore: a plain ES module the page imports too
import * as R from "../src/page/radius-logic.js";

describe("what an edit leaves to repeat", () => {
  test("a value set outright repeats as that value, named like its undo step", () => {
    const e = fromUpdate({ props: { fill: "#FF0000" } })!;
    assert.deepEqual(e.props, { fill: "#FF0000" });
    assert.equal(e.label, "Fill Change");
    assert.deepEqual(e.rel, {});
  });
  test("a typed +10 repeats as +10; - and / fold into + and x", () => {
    assert.deepEqual(cleanRel({ width: { op: "-", by: 4 }, opacity: { op: "/", by: 2 }, bad: { op: "%", by: 1 }, nan: { op: "+", by: "x" } }), { width: { op: "+", by: -4 }, opacity: { op: "*", by: 0.5 } });
    const e = fromUpdate({ props: { width: 130 }, rel: { width: { op: "+", by: 10 } } })!;
    assert.deepEqual(e.props, {});
    assert.deepEqual(e.rel, { width: { op: "+", by: 10 } });
    assert.equal(e.label, "Width +10");
    assert.equal(relText("opacity", { op: "+", by: -0.1 }), "−10%");
    assert.equal(relText("width", { op: "*", by: 2 }), "×2");
  });
  test("a Mixed step (each layer its own value) repeats only with its change, or when every layer got the same", () => {
    const step = fromUpdate({ props: {}, each: { a: { width: 11 }, b: { width: 21 } }, rel: { width: { op: "+", by: 1 } } })!;
    assert.deepEqual(step.rel, { width: { op: "+", by: 1 } });
    assert.equal(fromUpdate({ props: {}, each: { a: { width: 11 }, b: { width: 21 } } }), null);
    assert.deepEqual(fromUpdate({ props: {}, each: { a: { opacity: 0.5 }, b: { opacity: 0.5 } } })!.props, { opacity: 0.5 });
  });
  test("names, text and identity never repeat; an edit of only those leaves nothing", () => {
    assert.equal(fromUpdate({ props: { name: "Card", content: "Hi" } }), null);
    const e = fromUpdate({ props: { name: "Card", cornerRadius: 8 }, remove: ["metadata", "stroke"] })!;
    assert.deepEqual(e.props, { cornerRadius: 8 });
    assert.deepEqual(e.remove, ["stroke"]);
    assert.equal(e.label, "Property Change");
  });
  test("a rel hint for a key the write did not carry is ignored", () => {
    const e = fromUpdate({ props: { fill: "#000" }, rel: { width: { op: "+", by: 10 } } })!;
    assert.deepEqual(e.rel, {});
  });
  test("arrow-key nudges add up per burst; other moves are not edits to repeat", () => {
    const a = fromNudge(null, { id: "A", dx: 1, dy: 0, merge: "nudge" }, 1000)!;
    const b = fromNudge(a, { id: "A", dx: 1, dy: 0, merge: "nudge" }, 1200)!;
    assert.deepEqual(b.move, { dx: 2, dy: 0 });
    const later = fromNudge(b, { id: "A", dx: 0, dy: 10, merge: "nudge" }, 9000)!;
    assert.deepEqual(later.move, { dx: 0, dy: 10 }); // a new burst
    const group = fromNudge(null, { items: [{ id: "A", dx: 0, dy: -10 }, { id: "B", dx: 0, dy: -10 }], merge: "group:nudge-3-x" }, 1)!;
    assert.deepEqual(group.move, { dx: 0, dy: -10 });
    assert.equal(fromNudge(null, { id: "A", dx: 5, dy: 0 }, 1), null); // a drag
    assert.equal(fromNudge(null, { items: [{ id: "A", dx: 5, dy: 0 }], merge: "group:align-x" }, 1), null);
  });
});

describe("planRepeat", () => {
  const abs: RepeatEdit = { kind: "props", props: { fill: "#F00" }, remove: [], rel: {}, label: "Fill Change", at: 0 };
  const rel: RepeatEdit = { kind: "props", props: {}, remove: [], rel: { width: { op: "+", by: 10 } }, label: "Width +10", at: 0 };
  test("absolute: the same value on each, layers that already have it left out", () => {
    const p = planRepeat(abs, new Map<string, any>([["a", { fill: "#000" }], ["b", { fill: "#F00" }], ["gone", null]]));
    assert.deepEqual(p.each, { a: { fill: "#F00" } });
    assert.deepEqual(p.same, ["b"]);
    assert.deepEqual(p.skipped, ["gone"]);
  });
  test("relative: from each layer's own number; Hug and tokens keep theirs", () => {
    const p = planRepeat(rel, new Map<string, any>([["a", { width: 100 }], ["b", { width: 37.5 }], ["hug", { width: "fit_content" }]]));
    assert.deepEqual(p.each, { a: { width: 110 }, b: { width: 47.5 } });
    assert.deepEqual(p.skipped, ["hug"]);
  });
  test("relative results stay in range; a missing key counts from the file's default", () => {
    const op: RepeatEdit = { ...rel, rel: { opacity: { op: "+", by: 0.3 }, rotation: { op: "+", by: 200 } } };
    const p = planRepeat(op, new Map<string, any>([["a", { opacity: 0.9 }]]));
    assert.deepEqual(p.each, { a: { opacity: 1, rotation: -160 } });
    const r = planRepeat({ ...rel, rel: { cornerRadius: { op: "*", by: 2 } } }, new Map<string, any>([["a", {}], ["b", { cornerRadius: 6 }]]));
    assert.deepEqual(r.each, { b: { cornerRadius: 12 } });
  });
  test("the toast says how many and whether it was the same value or the same change", () => {
    assert.equal(repeatToast(abs, 2), "Repeated Fill Change on 2 layers, same value");
    assert.equal(repeatToast(rel, 1, 1), "Repeated Width +10 on 1 layer, from each one's own value; 1 skipped");
    assert.equal(repeatToast(abs, 0), "The selection already has Fill Change");
    assert.equal(repeatToast({ kind: "move", props: {}, remove: [], rel: {}, move: { dx: 10, dy: 0 }, label: "Nudge", at: 0 }, 3), "Repeated Nudge (10, 0) on 3 layers, from each one's own position");
  });
});

describe("corner radius handles (radius-logic.js)", () => {
  test("radii from any stored form; tokens have none", () => {
    assert.deepEqual(R.radii(undefined), [0, 0, 0, 0]);
    assert.deepEqual(R.radii(8), [8, 8, 8, 8]);
    assert.deepEqual(R.radii([1, 2, 3, 4]), [1, 2, 3, 4]);
    assert.equal(R.radii("$radius"), null);
    assert.equal(R.radiusTarget({ type: "frame", cornerRadius: "$r" }), false);
    assert.equal(R.radiusTarget({ type: "rectangle" }), true);
    assert.equal(R.radiusTarget({ type: "rectangle", rotation: 15 }), false);
    assert.equal(R.radiusTarget({ type: "text" }), false);
  });
  test("a drag writes one number for all corners, Option one corner in the four-value form", () => {
    assert.equal(R.radiusForm([1, 2, 3, 4], -1, 10), 10);
    assert.deepEqual(R.radiusForm(8, 2, 20), [8, 8, 20, 8]);
    assert.equal(R.radiusForm([8, 8, 20, 8], 2, 8), 8); // all equal again: one number
  });
  test("knobs sit inside the corners, at least INSET_PX in, where the radius ends, never past the middle", () => {
    const s = { x: 100, y: 100, w: 200, h: 100 };
    const k = R.knobs(s, [0, 0, 0, 0], 1);
    assert.equal(k.length, 4);
    assert.deepEqual([k[0].x, k[0].y], [100 + R.INSET_PX, 100 + R.INSET_PX]);
    assert.deepEqual([k[2].x, k[2].y], [300 - R.INSET_PX, 200 - R.INSET_PX]);
    const big = R.knobs(s, [30, 30, 30, 30], 2); // 60 px on screen, but the middle is 50 px in
    assert.deepEqual([big[0].x, big[0].y], [150, 150]);
    assert.deepEqual(R.knobs({ x: 0, y: 0, w: 39, h: 200 }, [0, 0, 0, 0], 1), []); // too small on screen
  });
  test("a flipped layer's screen corner is the stored corner across", () => {
    assert.equal(R.storedCorner(0, 0), 0);
    assert.equal(R.storedCorner(0, 0, true), 1);
    assert.equal(R.storedCorner(1, 1, false, true), 1);
    assert.equal(R.knobs({ x: 0, y: 0, w: 100, h: 100 }, [40, 0, 0, 0], 1, true)[1].corner, 0);
  });
  test("a press grabs the nearest knob within HIT_PX and nothing further", () => {
    const k = R.knobs({ x: 0, y: 0, w: 100, h: 100 }, [0, 0, 0, 0], 1);
    assert.equal(R.knobAt(k, 14, 13).corner, 0);
    assert.equal(R.knobAt(k, 12 + R.HIT_PX + 1, 12), null);
  });
  test("dragging toward the centre rounds more, whole px with pixel snapping, never past half the short side", () => {
    const tl = { sx: 1, sy: 1 }, br = { sx: -1, sy: -1 };
    assert.equal(R.dragRadius(tl, 0, 10, 10, 1, 50), 10);
    assert.equal(R.dragRadius(br, 0, -10, -6, 1, 50), 8);
    assert.equal(R.dragRadius(tl, 8, -20, -20, 1, 50), 0);
    assert.equal(R.dragRadius(tl, 0, 500, 500, 1, 50), 50);
    assert.equal(R.dragRadius(tl, 0, 7, 7, 2, 50), 4); // 3.5 world px at 200%, rounded
    assert.equal(R.dragRadius(tl, 0, 7, 7, 2, 50, false), 3.5);
    assert.equal(R.dragRadius(tl, 0, 500, 500, 1, 20.5), 20);
  });
});

// ---------- the server ----------
const dir = tmpDir("repeat");
process.env.CANVAS_ROOTS = dir;
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B", name: "Board", x: 0, y: 0, width: 600, height: 400, layout: "none", children: [
      { type: "rectangle", id: "R1", x: 10, y: 10, width: 100, height: 50, fill: "#000000" },
      { type: "rectangle", id: "R2", x: 10, y: 100, width: 80, height: 50, fill: "#111111" },
      { type: "rectangle", id: "R3", x: 10, y: 200, width: 60, height: 50, fill: "#222222", cornerRadius: 4 },
      { type: "frame", id: "AL", x: 200, y: 10, width: 200, height: 100, layout: "horizontal", padding: 10, gap: 8, children: [
        { type: "rectangle", id: "K1", width: 40, height: 40 },
        { type: "rectangle", id: "K2", width: 40, height: 40 },
      ] },
    ] },
  ],
};
const file = path.join(dir, "repeat.canvas.json");
fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
const real = fs.realpathSync(file);
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const repeat = await import("../src/repeat.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  fs.unwatchFile(real);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 50_000_000;
history.setClock(() => clock);
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const q = (s: string) => encodeURIComponent(s);
const update = (body: Record<string, unknown>) => call("POST", "/api/update", { file: real, ...body });
const rep = (ids: string[]) => call("POST", "/api/repeat", { file: real, ids });
const undo = () => call("POST", `/api/history/undo?file=${q(real)}`);
const node = async (id: string) => (await call("GET", `/api/node?file=${q(real)}&id=${q(id)}&depth=0`)).body.node;

describe("POST /api/repeat", () => {
  beforeEach(() => { clock += 10_000; });
  test("nothing to repeat before an edit", async () => {
    repeat.resetRepeat();
    const r = await rep(["R1"]);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "nothing");
  });
  test("a fill set in the inspector repeats on two other layers, one undo step, same value", async () => {
    assert.equal((await update({ id: "R1", props: { fill: "#FF0000" } })).status, 200);
    assert.deepEqual((await call("GET", `/api/repeat?file=${q(real)}`)).body.repeat, { label: "Fill Change", kind: "absolute" });
    clock += 10_000;
    const depth = history.entries(real).undo.length;
    const r = await rep(["R2", "R3"]);
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, 2);
    assert.match(r.body.toast, /Repeated Fill Change on 2 layers, same value/);
    assert.equal((await node("R2")).fill, "#FF0000");
    assert.equal((await node("R3")).fill, "#FF0000");
    assert.equal(history.entries(real).undo.length, depth + 1);
    assert.equal((await undo()).status, 200);
    assert.equal((await node("R2")).fill, "#111111");
    assert.equal((await node("R3")).fill, "#222222");
    assert.equal((await node("R1")).fill, "#FF0000"); // the original edit stays
  });
  test("a relative +10 repeats from each layer's own width; two repeats are two undo steps", async () => {
    await update({ id: "R1", props: { width: 110 }, rel: { width: { op: "+", by: 10 } } });
    clock += 10_000;
    const r = await rep(["R2", "R3"]);
    assert.match(r.body.toast, /Width \+10 on 2 layers, from each one's own value/);
    assert.equal((await node("R2")).width, 90);
    assert.equal((await node("R3")).width, 70);
    const depth = history.entries(real).undo.length;
    await rep(["R2"]); // at once: still its own step
    assert.equal((await node("R2")).width, 100);
    assert.equal(history.entries(real).undo.length, depth + 1);
    await undo();
    assert.equal((await node("R2")).width, 90);
  });
  test("a padding handle drag repeats on another frame; a layer that cannot hold it is skipped; the note stays", async () => {
    await call("POST", "/api/update", { file: real, ids: ["B"], props: { layout: "vertical" } });
    clock += 10_000;
    await update({ id: "AL", props: { padding: 24 }, gesture: "spacing-1" });
    clock += 10_000;
    const r = await rep(["B", "R3"]);
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, 1);
    assert.match(r.body.toast, /1 skipped/);
    assert.equal((await node("B")).padding, 24);
    assert.equal(repeat.lastEdit(real)!.label, "Padding Change");
    await call("POST", "/api/update", { file: real, ids: ["B"], props: { layout: "none" } }); // free layers again
  });
  test("an arrow-key nudge repeats by the same distance", async () => {
    const m = await call("POST", "/api/move", { file: real, id: "R1", dx: 10, dy: 0, merge: "nudge" });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    const x2 = (await node("R2")).x;
    clock += 10_000;
    const r = await rep(["R2"]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await node("R2")).x, x2 + 10, JSON.stringify(r.body));
    assert.match(r.body.toast, /Nudge \(10, 0\)/);
  });
  test("cards in the selection are left out; only cards is refused", async () => {
    const r = await rep(["widget:abc"]);
    assert.equal(r.status, 400);
  });
});
