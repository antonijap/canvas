// Regression tests for bug hunt round 6, auto layout on the page (.planning/research/hunt-6-autolayout.md and
// hunt-6-codex.md): the pure logic, and src/page/autolayout.js run with a fake host (its imports swapped for the
// modules themselves).

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as A from "../src/page/autolayout-logic.js";
// @ts-ignore: a plain ES module the page imports too
import * as LE from "../src/page/live-edit.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
const pageSrc = fs.readFileSync(new URL("../src/page/autolayout.js", import.meta.url), "utf8")
  .replace(/^import \* as A from "\/page\/autolayout-logic\.js";$/m, "")
  .replace('import("/page/live-edit.js")', "Promise.resolve(LE)");

type Rect = { x: number; y: number; w: number; h: number };
const RECTS: Record<string, Rect> = {
  BD: { x: 0, y: 0, w: 600, h: 400 }, F: { x: 0, y: 0, w: 400, h: 60 },
  A: { x: 10, y: 10, w: 40, h: 40 }, B: { x: 60, y: 10, w: 40, h: 40 }, C: { x: 110, y: 10, w: 40, h: 40 },
};
const sceneOf = (frame: Record<string, unknown> = {}, board: Record<string, unknown> = {}) => ({
  id: "BD", root: { type: "frame", id: "BD", layout: "none", width: 600, height: 400, ...board, children: [
    // The file's F holds a hidden H first; the scene never has it.
    { type: "frame", id: "F", layout: "horizontal", gap: 10, padding: 10, width: 400, height: 60, ...frame, children: ["A", "B", "C"].map((id) => ({ type: "rectangle", id, width: 40, height: 40 })) },
  ] },
});

/** autolayout.js on a fake host. fetchImpl answers its requests. */
function load(o: { sel?: string[]; scene?: any; fetchImpl?: (url: string, init: any) => Promise<any> } = {}) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const hostOn: Record<string, ((c: any) => void)[]> = {};
  const log: string[] = [];
  const acks: [string, number, boolean][] = [];
  const edits: [string, any, string[], number][] = [];
  const setSel: string[][] = [];
  const bodies: any[] = [];
  let opn = 0;
  let sel = o.sel ?? ["A"];
  const scene = o.scene ?? sceneOf();
  const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : () => {}), set: () => true });
  const view = { getBoundingClientRect: () => ({ left: 0, top: 0 }), appendChild() {}, addEventListener() {}, clientWidth: 800, clientHeight: 600, style: {} as any, setPointerCapture() {}, contains: () => true };
  const live = {
    boardOf: () => "BD", sceneOf: () => scene, nextOp: () => ++opn, order() {}, raw() {}, redraw() {}, onScene() {}, busy: false,
    ack: (id: string, op: number, ok: boolean) => acks.push([id, op, ok]),
    edit: (id: string, props: any, rm: string[], op: number) => { edits.push([id, props, rm, op]); return true; },
  };
  const engine = { setBoard() {}, raiseBoards() {}, removeBoard() {}, nodeRectIn: (_b: string, id: string) => RECTS[id] ?? null };
  const host: any = {
    file: "f.canvas.json", view, renderer: "engine", engineView: { isLoaded: () => true, engine }, live, boards: new Map([["BD", {}]]),
    cam: { x: 0, y: 0, z: 1 }, worldRectOf: (id: string) => RECTS[id] ?? null, boxOf: (id: string) => RECTS[id] ?? null,
    selection: () => sel, get sel() { return sel.at(-1); }, native: true, post: (m: any) => { if (m.toast) log.push("toast " + m.toast); },
    on: (n: string, f: (c: any) => void) => { (hostOn[n] ??= []).push(f); },
    setSelection: (s: string[]) => setSel.push(s), writesSettled: () => log.push("settled"), requestFrame() {}, syncSel() {},
    reloadBoard: (b: string) => log.push("reload " + b), snap: () => ({}),
  };
  const fetchImpl = o.fetchImpl ?? (async () => ({ ok: true, json: async () => ({ select: [] }) }));
  const fetch = (url: string, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    log.push(`fetch ${url} ${b.op ?? ""} ${b.id ?? ""}`.trim());
    return fetchImpl(url, b);
  };
  const doc = { getElementById: () => null, createElement: () => ({ style: {}, getContext: () => ctx, width: 0, height: 0 }) };
  const run = new Function("A", "LE", "window", "addEventListener", "document", "matchMedia", "requestAnimationFrame", "cancelAnimationFrame", "fetch", pageSrc);
  run(A, LE, { canvasHost: host, devicePixelRatio: 1 }, (t: string, f: (e: any) => void) => { (listeners[t] ??= []).push(f); }, doc, () => ({ matches: true }), () => 1, () => {}, fetch);
  const fire = (t: string, e: any) => { for (const f of listeners[t] ?? []) f({ stopPropagation() {}, stopImmediatePropagation() {}, preventDefault() {}, target: {}, button: 0, pointerId: 1, ...e }); };
  const emit = (n: string, c?: any) => { for (const f of hostOn[n] ?? []) f(c); };
  return { host, al: host.autolayout, log, acks, edits, setSel, bodies, fire, emit, setSelection: (s: string[]) => { sel = s; } };
}
/** A fetch answer after the test lets it go. */
function gate() {
  const waiting: (() => void)[] = [];
  const impl = (ok = true, j: any = { select: [] }) => (_u: string, _b: any) => new Promise<any>((res) => waiting.push(() => res({ ok, status: ok ? 200 : 400, statusText: "", json: async () => j })));
  return { impl, release: async () => { while (waiting.length) { waiting.shift()!(); await tick(); await tick(); } } };
}

describe("hunt 6: logic", () => {
  test("#1: beforeIn names the sibling after the moved block (null at the end)", () => {
    assert.equal(A.beforeIn(["B", "A", "C"], ["A"]), "C");
    assert.equal(A.beforeIn(["B", "C", "A"], ["A"]), null);
    assert.equal(A.beforeIn(["A", "B", "C"], ["A", "B"]), "C");
  });
  test("#6: gap 0 and a negative gap still get a gap handle", () => {
    const f = { x: 0, y: 0, w: 200, h: 50 }, cam = { x: 0, y: 0, z: 1 };
    const touching = [{ x: 0, y: 0, w: 50, h: 50 }, { x: 50, y: 0, w: 50, h: 50 }];
    const overlap = [{ x: 0, y: 0, w: 50, h: 50 }, { x: 40, y: 0, w: 50, h: 50 }];
    const g0 = A.spacingAreas(f, [0, 0, 0, 0], touching, "horizontal", cam, 0).filter((a: any) => a.kind === "gap");
    const gn = A.spacingAreas(f, [0, 0, 0, 0], overlap, "horizontal", cam, -10).filter((a: any) => a.kind === "gap");
    assert.equal(g0.length, 1);
    assert.equal(gn.length, 1);
    assert.equal(g0[0].value, 0);
    assert.equal(gn[0].value, -10);
    assert.ok(Math.abs(g0[0].rect.x + g0[0].rect.w / 2 - 50) < 0.01, "centred on the seam");
  });
  test("#19: the insertion line at a wrap boundary follows the line the pointer is in", () => {
    // Line 1: x 0..90 (two items), line 2 starts at y 60.
    const rects = [{ x: 0, y: 0, w: 40, h: 40 }, { x: 50, y: 0, w: 40, h: 40 }, { x: 0, y: 60, w: 40, h: 40 }];
    const f = { x: 0, y: 0, w: 100, h: 100 };
    const p = { x: 2, y: 80 };
    const slot = A.slotAt(rects, p, "horizontal", true);
    assert.equal(slot, 2);
    const line = A.lineAt(rects, p, "horizontal");
    const ln = A.insertionLine(f, [0, 0, 0, 0], rects, "horizontal", slot, true, line);
    assert.ok(ln.x0 <= 0.01 && ln.y0 >= 60, `drawn at the start of line 2: ${JSON.stringify(ln)}`);
  });
  test("#3: a drop target never offers a component the dragged layers use, nor a frame inside it", () => {
    const root = { type: "frame", id: "BD", layout: "none", children: [
      { type: "frame", id: "Cmp", layout: "horizontal", children: [{ type: "frame", id: "In", layout: "horizontal", children: [] }] },
    ] };
    const rect = () => ({ x: 0, y: 0, w: 100, h: 100 });
    const uses = A.componentsIn([{ type: "frame", id: "I1", component: "Cmp", children: [] }]);
    assert.deepEqual([...uses], ["Cmp"]);
    assert.equal(A.dropTarget(root, { x: 5, y: 5 }, rect, new Set(), null, false, uses).id, "BD");
    assert.equal(A.dropTarget(root, { x: 5, y: 5 }, rect, new Set(), null, false).id, "In");
  });
  test("#16: a rotated board or grandparent counts", () => {
    const root = { id: "BD", rotation: 12, children: [{ id: "F", children: [{ id: "A" }] }] };
    assert.equal(A.rotatedPath(root, "A"), true);
    assert.equal(A.rotatedPath({ id: "BD", children: [{ id: "F", children: [{ id: "A" }] }] }, "A"), false);
  });
});

describe("hunt 6: the page", () => {
  test("#1 / codex 4: an arrow press sends the sibling to land before, not a drawn index", async () => {
    const t = load();
    assert.equal(t.al.arrow(1, 0), true);
    await tick();
    const b = t.bodies.find((x) => x.op === "place");
    assert.equal(b.before, "C");
    assert.equal("index" in b, false);
  });

  test("#7: an answer that arrives after the person picked another layer does not take the selection back", async () => {
    const g = gate();
    const t = load({ fetchImpl: g.impl(true, { select: ["A"] }) });
    t.al.arrow(1, 0);
    await tick();
    t.setSelection(["Other"]);
    await g.release();
    assert.deepEqual(t.setSel, []);
  });

  test("codex 5: a multi-selection sizing chain stays pending until its last call settles", async () => {
    const g = gate();
    const t = load({ sel: ["A", "B"], fetchImpl: g.impl() });
    t.emit("cmd", { cmd: "layout", op: "sizing", axis: "width", mode: "fixed" });
    await tick();
    assert.equal(t.al.pending(), true);
    await g.release();
    const fetches = t.log.filter((l) => l.startsWith("fetch"));
    assert.equal(fetches.length, 2);
    assert.deepEqual(t.log.filter((l) => l === "settled" || l.startsWith("fetch")), [...fetches, "settled"], t.log.join(" | "));
    assert.equal(t.al.pending(), false);
  });

  test("#17: a refused Option+double-click Fill takes its preview back at once", async () => {
    const t = load({ fetchImpl: async () => ({ ok: false, status: 400, statusText: "", json: async () => ({ error: "no", code: "invalid" }) }) });
    await tick(); // handleAt loads
    const r = RECTS.A;
    t.fire("dblclick", { altKey: true, clientX: r.x + r.w, clientY: r.y + r.h / 2 });
    await tick(); await tick();
    const pv = t.edits.find((e) => e[0] === "A" && e[1].width === "fill_container");
    assert.ok(pv, "previewed");
    assert.ok(pv![3] > 0, "the preview rides on a write");
    assert.ok(t.acks.some(([id, op, ok]) => id === "A" && op === pv![3] && ok === false), JSON.stringify(t.acks));
  });

  test("#15: Undo during a reorder drag lets the drag go first", () => {
    const t = load();
    assert.equal(t.al.beginDrag({ button: 0, clientX: 30, clientY: 30, pointerId: 1 }, ["A"]), true);
    t.fire("pointermove", { clientX: 80, clientY: 30 });
    assert.equal(t.al.dragging, true);
    assert.equal(t.al.cancelDrag(), true);
    assert.equal(t.al.dragging, false);
    const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    assert.match(server, /function historyStep\(dir, plain\) \{\n  if \(!file\) return;\n  if \(host\.autolayout\) host\.autolayout\.cancelDrag\(\);/);
  });

  test("#16: no reorder drag in a rotated board", () => {
    const t = load({ scene: sceneOf({}, { rotation: 15 }) });
    assert.equal(t.al.beginDrag({ button: 0, clientX: 30, clientY: 30, pointerId: 1 }, ["A"]), false);
  });

  test("#14: dragging the gap handle of an Auto gap frame ends Auto", async () => {
    const t = load({ sel: ["F"], scene: sceneOf({ justifyContent: "space_between" }) });
    t.emit("select", "F");
    await tick();
    const kids = ["A", "B", "C"].map((id) => RECTS[id]);
    const gap = A.spacingAreas(RECTS.F, [10, 10, 10, 10], kids, "horizontal", { x: 0, y: 0, z: 1 }, 10).find((a: any) => a.kind === "gap");
    const cx = gap.bar.x + gap.bar.w / 2, cy = gap.bar.y + gap.bar.h / 2;
    t.fire("pointerdown", { clientX: cx, clientY: cy });
    t.fire("pointermove", { clientX: cx + 6, clientY: cy });
    t.fire("pointerup", { clientX: cx + 6, clientY: cy });
    await tick();
    const up = t.bodies.find((b) => b.props && "gap" in b.props);
    assert.ok(up, t.log.join(" | "));
    assert.deepEqual(up.remove, ["justifyContent"]);
    assert.equal(up.props.gap, 16, "starts from the gap drawn (10) plus the drag");
  });
});
