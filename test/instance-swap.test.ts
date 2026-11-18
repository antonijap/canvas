// Swap instance, reset one override, push changes to main (src/overrides.ts): a swap keeps the
// overrides of layers whose names and hierarchy match in the new component; a reset can take one property; a push
// moves an instance's overrides into its main component. Each is one undo step.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("instance-swap");
process.env.CANVAS_ROOTS = dir;
const text = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ type: "text", id, content, fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000", ...extra });
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "Lib", name: "Library", x: 0, y: 0, width: 800, height: 400, layout: "none", children: [
      { type: "frame", id: "Pri", name: "Button/Primary", reusable: true, x: 20, y: 20, width: 120, height: 40, layout: "horizontal", fill: "#111827", children: [
        { type: "ellipse", id: "PDot", name: "Dot", width: 8, height: 8, fill: "#FFFFFF" },
        text("PLbl", "OK", { name: "Label" }),
        text("PSub", "sub", { name: "Hint" }),
      ] },
      { type: "frame", id: "Sec", name: "Button/Secondary", reusable: true, x: 200, y: 20, width: 140, height: 40, layout: "horizontal", fill: "#E5E7EB", children: [
        text("SLbl", "Cancel", { name: "Label" }),
        { type: "rectangle", id: "SDot", name: "Dot", width: 8, height: 8, fill: "#000000" },
      ] },
      { type: "frame", id: "Card", name: "Card", reusable: true, x: 400, y: 20, width: 200, height: 120, layout: "vertical", children: [
        text("CTitle", "Title", { name: "Title" }),
        { type: "ref", id: "CBtn", ref: "Pri" },
      ] },
      // A component whose nested instance has overrides of its own (the main's): Label's font size, Dot's fill.
      { type: "frame", id: "Row", name: "Row", reusable: true, x: 620, y: 20, width: 160, height: 60, layout: "horizontal", children: [
        { type: "ref", id: "RBtn", ref: "Pri", descendants: { PLbl: { fontSize: 20 }, PDot: { fill: "#FF0000" } } },
      ] },
    ] },
    { type: "frame", id: "Screen", name: "Screen", x: 900, y: 0, width: 400, height: 400, layout: "none", children: [
      { type: "ref", id: "I1", name: "Button/Primary", ref: "Pri", x: 10, y: 10, fill: "#DC2626", descendants: { PLbl: { content: "Go", fontSize: 18 }, PDot: { fill: "#00FF00" }, PSub: { content: "later" } } },
      { type: "ref", id: "I2", name: "My button", ref: "Pri", x: 10, y: 80 },
      { type: "ref", id: "CI", ref: "Card", x: 10, y: 150, descendants: { CTitle: { content: "Hello" }, "CBtn/PLbl": { content: "Buy" } } },
      { type: "ref", id: "RI", ref: "Row", x: 10, y: 300 },
    ] },
  ],
};
const file = path.join(dir, "swap.canvas.json");
fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
const real = fs.realpathSync(file);
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(() => {
  fs.unwatchFile(real);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let clock = 40_000_000;
history.setClock(() => clock);
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const q = (s: string) => encodeURIComponent(s);
const undo = () => call("POST", `/api/history/undo?file=${q(real)}`);
const redo = () => call("POST", `/api/history/redo?file=${q(real)}`);
const label = async () => (await call("GET", `/api/history?file=${q(real)}`)).body.undo;
const read = () => JSON.parse(fs.readFileSync(real, "utf8"));
const find = (id: string): any => {
  const seek = (list: any[]): any => {
    for (const n of list ?? []) {
      if (n.id === id) return n;
      const h = seek(n.children);
      if (h) return h;
    }
  };
  return seek(read().children);
};
const swap = (body: Record<string, unknown>) => call("POST", "/api/overrides/swap", { file: real, ...body });
const push = (id: string) => call("POST", "/api/overrides/push", { file: real, id });
const reset = (id: string, keys?: string[]) => call("POST", "/api/overrides/reset", { file: real, id, keys });

beforeEach(async () => {
  fs.writeFileSync(real, JSON.stringify(DOC, null, 2));
  await call("POST", "/api/update", { file: real, id: "Lib", props: {} });
  history.resetHistory();
  clock += 5000;
});

describe("swap instance", () => {
  test("points the instance at the new component; text and fill overrides carry over where names and type match", async () => {
    const r = await swap({ id: "I1", component: "Sec" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    const i1 = find("I1");
    assert.equal(i1.ref, "Sec");
    // Label matches by name and type: its overrides move to the new key. Dot is an ellipse there, a rectangle here:
    // dropped. Hint has no match: dropped.
    assert.deepEqual(i1.descendants, { SLbl: { content: "Go", fontSize: 18 } });
    assert.equal(r.body.kept, 1);
    assert.deepEqual(r.body.dropped.sort(), ["Dot", "Hint"]);
    // The instance's own override and its place stay; its name followed the old main, so it follows the new one.
    assert.equal(i1.fill, "#DC2626");
    assert.equal(i1.x, 10);
    assert.equal(i1.name, undefined);
    assert.equal(await label(), "Swap Instance");
    // The scene draws it: the label text is the override.
    const scene = await call("GET", `/api/node?file=${q(real)}&id=${q("I1/SLbl")}`);
    assert.equal(scene.status, 200, JSON.stringify(scene.body));
    await undo();
    const back = find("I1");
    assert.equal(back.ref, "Pri");
    assert.equal(back.name, "Button/Primary");
    assert.deepEqual(back.descendants, (DOC.children[1].children[0] as any).descendants);
    await redo();
    assert.equal(find("I1").ref, "Sec");
  });

  test("a renamed instance keeps its name; several instances swap in one undo step", async () => {
    const r = await swap({ ids: ["I1", "I2"], component: "Sec" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("I2").ref, "Sec");
    assert.equal(find("I2").name, "My button");
    await undo();
    assert.equal(find("I1").ref, "Pri");
    assert.equal(find("I2").ref, "Pri");
  });

  test("nested overrides map through a nested instance by names", async () => {
    // Card's CBtn/PLbl ("Buy") and Title: swap the Card instance to Button/Primary, which has neither path.
    const r = await swap({ id: "CI", component: "Pri" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("CI").descendants, undefined);
    assert.equal(r.body.kept, 0);
  });

  test("the same component, a non-instance, a missing or non-component target, and a loop refuse or do nothing", async () => {
    const before = fs.readFileSync(real, "utf8");
    assert.equal((await swap({ id: "I1", component: "Pri" })).body.changed, false);
    assert.equal((await swap({ id: "Screen", component: "Pri" })).status, 400);
    assert.equal((await swap({ id: "I1", component: "Nope" })).status, 404);
    assert.equal((await swap({ id: "I1", component: "Lib" })).status, 400);
    // Card holds an instance of Pri: Pri cannot become a Card (Card would contain itself).
    const loop = await swap({ id: "CBtn", component: "Card" });
    assert.equal(loop.status, 400, JSON.stringify(loop.body));
    assert.match(loop.body.error, /cannot contain itself/);
    // A nested instance: not a component, not an instance, or its own component.
    assert.equal((await swap({ id: "CI/CBtn", component: "Lib" })).status, 400);
    assert.equal((await swap({ id: "CI/CTitle", component: "Sec" })).status, 400);
    assert.equal((await swap({ id: "CI/CBtn", component: "Pri" })).body.changed, false);
    assert.equal(fs.readFileSync(real, "utf8"), before);
  });
});

describe("swap a nested instance", () => {
  const sceneNode = async (board: string, id: string) => {
    const sc = await call("GET", `/api/scene?file=${q(real)}&id=${q(board)}`);
    assert.equal(sc.status, 200, JSON.stringify(sc.body));
    const seek = (n: any): any => { if (!n || typeof n !== "object") return; if (n.id === id) return n; for (const c of n.children ?? []) { const h = seek(c); if (h) return h; } };
    return seek(sc.body.root);
  };
  const node = (id: string) => call("GET", `/api/node?file=${q(real)}&id=${q(id)}`);

  test("an override sets ref inside the outer instance; overrides below it carry by layer names; the main is left alone; undo gives the bytes back", async () => {
    const before = fs.readFileSync(real, "utf8");
    const r = await swap({ id: "CI/CBtn", component: "Sec" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    assert.equal(r.body.kept, 1);
    assert.deepEqual(r.body.dropped, []);
    // Label matched by name and type: "Buy" moves to Button/Secondary's label. Title stays.
    assert.deepEqual(find("CI").descendants, { CTitle: { content: "Hello" }, CBtn: { ref: "Sec" }, "CBtn/SLbl": { content: "Buy" } });
    assert.equal(find("CBtn").ref, "Pri", "the main component keeps its own nested instance");
    assert.equal(await label(), "Swap Instance");
    // The nested instance keeps its id path; it draws the new component, the carried text on it.
    const nested = await node("CI/CBtn");
    assert.equal(nested.status, 200, JSON.stringify(nested.body));
    assert.equal(nested.body.node.__ref, "Sec");
    assert.equal(nested.body.context.kind, "instance");
    assert.equal(nested.body.context.main.id, "Sec", "Go to main component goes to the new main");
    assert.ok(nested.body.overrides.includes("ref"), "the swap is an override of the nested instance");
    const lbl = await node("CI/CBtn/SLbl");
    assert.equal(lbl.body.node.content, "Buy");
    assert.equal(lbl.body.context.main.id, "Sec");
    // The scene (what the canvas and export draw) has it too.
    const sn = await sceneNode("Screen", "CI/CBtn");
    assert.equal(sn.component, "Sec");
    assert.equal(sn.fill, "#E5E7EB");
    await undo();
    assert.equal(fs.readFileSync(real, "utf8"), before, "undo gives the original bytes");
    await redo();
    assert.equal(find("CI").descendants.CBtn.ref, "Sec");
  });

  test("the main's own overrides on the nested instance carry into the swap; others are dropped and named", async () => {
    const r = await swap({ id: "RI/RBtn", component: "Sec" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(find("RI").descendants, { RBtn: { ref: "Sec", descendants: { SLbl: { fontSize: 20 } } } });
    assert.deepEqual(r.body.dropped, ["Dot"]);
    assert.equal((await node("RI/RBtn/SLbl")).body.node.fontSize, 20);
    // Button/Secondary's Dot is a rectangle: the main's ellipse fill does not land on it.
    assert.equal((await node("RI/RBtn/SDot")).body.node.fill, "#000000");
    assert.deepEqual(find("RBtn").descendants, { PLbl: { fontSize: 20 }, PDot: { fill: "#FF0000" } });
  });

  test("reset of ref puts the original back; overrides below map back by names; swapping to the original is the same", async () => {
    await swap({ id: "CI/CBtn", component: "Sec" });
    const r = await reset("CI/CBtn", ["ref"]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    assert.deepEqual(find("CI").descendants, { CTitle: { content: "Hello" }, "CBtn/PLbl": { content: "Buy" } });
    assert.equal((await node("CI/CBtn")).body.node.__ref, "Pri");
    await swap({ id: "RI/RBtn", component: "Sec" });
    const back = await swap({ id: "RI/RBtn", component: "Pri" });
    assert.equal(back.body.changed, true);
    assert.equal(find("RI").descendants, undefined, "the main's overrides apply again on their own");
    // Reset all changes on the nested instance takes the swap and everything below it.
    await swap({ id: "CI/CBtn", component: "Sec" });
    assert.equal((await reset("CI/CBtn")).body.changed, true);
    assert.deepEqual(find("CI").descendants, { CTitle: { content: "Hello" } });
  });

  test("nested and top-level instances swap in one step; two levels down works too", async () => {
    const r = await swap({ ids: ["CI/CBtn", "I2"], component: "Sec" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("I2").ref, "Sec");
    assert.equal(find("CI").descendants.CBtn.ref, "Sec");
    await undo();
    assert.equal(find("I2").ref, "Pri");
    assert.equal(find("CI").descendants.CBtn, undefined);
    // A Card inside an instance of a component that holds a Card instance.
    const deep = await call("POST", "/api/structure", { file: real, op: "add", nodes: [
      { type: "frame", id: "Deck", name: "Deck", reusable: true, x: 0, y: 500, width: 300, height: 200, layout: "vertical", children: [{ type: "ref", id: "DCard", ref: "Card" }] },
      { type: "ref", id: "DI", ref: "Deck", x: 400, y: 500 },
    ], place: { parent: null } });
    assert.equal(deep.status, 200, JSON.stringify(deep.body));
    const s = await swap({ id: "DI/DCard/CBtn", component: "Sec" });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(find("DI").descendants, { "DCard/CBtn": { ref: "Sec" } });
    assert.equal((await node("DI/DCard/CBtn/SLbl")).body.node.content, "Cancel");
  });

  test("duplicate, detach and push keep what the swapped instance draws", async () => {
    await swap({ id: "CI/CBtn", component: "Sec" });
    const dup = await call("POST", "/api/structure", { file: real, op: "duplicate", ids: ["CI"] });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    const copy = dup.body.select[0];
    assert.deepEqual(find(copy).descendants.CBtn, { ref: "Sec" });
    assert.equal((await node(copy + "/CBtn/SLbl")).body.node.content, "Buy");
    // Detach: plain layers drawn from Button/Secondary with the carried text.
    const det = await call("POST", "/api/structure", { file: real, op: "detach", ids: [copy] });
    assert.equal(det.status, 200, JSON.stringify(det.body));
    const flat = JSON.stringify(find(copy));
    assert.match(flat, /"content":"Buy"/);
    assert.match(flat, /"fill":"#E5E7EB"/);
    // Push: the main's nested instance becomes Button/Secondary, with the text as the main's override on it.
    const p = await push("CI");
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(find("CBtn").ref, "Sec");
    assert.deepEqual(find("CBtn").descendants, { SLbl: { content: "Buy" } });
    assert.equal(find("CTitle").content, "Hello");
    assert.equal(find("CI").descendants, undefined);
    await undo();
    assert.equal(find("CBtn").ref, "Pri");
    assert.equal(find("CBtn").descendants, undefined);
    assert.equal(find("CI").descendants.CBtn.ref, "Sec");
  });

  test("the component a swap points at is kept when deleted, and goes along to another file", async () => {
    await swap({ id: "CI/CBtn", component: "Sec" });
    // Deleting Button/Secondary: CI still draws it, so it waits in the hidden holder.
    const del = await call("POST", "/api/structure", { file: real, op: "delete", ids: ["Sec"] });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const holder = read().children.find((n: any) => n.metadata?.canvasDeletedComponents === true);
    assert.ok(holder?.children.some((n: any) => n.id === "Sec"), "Button/Secondary waits for the swap that uses it");
    assert.equal((await node("CI/CBtn/SLbl")).body.node.content, "Buy");
    await undo();
    // Copied into another file: the swap's component comes along with Card and Button/Primary.
    const other = path.join(dir, "other.canvas.json");
    fs.writeFileSync(other, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "OB", name: "Other", x: 0, y: 0, width: 600, height: 400, layout: "none", children: [] }] }, null, 2));
    const otherReal = fs.realpathSync(other);
    const c = await call("POST", "/api/structure", { file: real, op: "copy", ids: ["CI"] });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const p = await call("POST", "/api/structure", { file: otherReal, op: "paste", payload: c.body.payload, place: { parent: "OB" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const pasted = p.body.select[0];
    const lbl = await call("GET", `/api/node?file=${q(otherReal)}&id=${q(pasted + "/CBtn/SLbl")}`);
    assert.equal(lbl.status, 200, JSON.stringify(lbl.body));
    assert.equal(lbl.body.node.content, "Buy");
    fs.unwatchFile(otherReal);
  });

  test("a push that would put a component inside itself is refused", async () => {
    // Card's nested button swapped to Card in one instance draws fine; pushed, Card would contain itself.
    const add = await call("POST", "/api/structure", { file: real, op: "add", nodes: [{ type: "ref", id: "CJ", ref: "Card", x: 200, y: 300 }], place: { parent: "Screen" } });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    const s = await swap({ id: "CJ/CBtn", component: "Card" });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const before = fs.readFileSync(real, "utf8");
    const p = await push("CJ");
    assert.equal(p.status, 400, JSON.stringify(p.body));
    assert.match(p.body.error, /contain itself/);
    assert.equal(fs.readFileSync(real, "utf8"), before);
  });
});

describe("reset one override", () => {
  test("on an instance: one own property, then the layers inside", async () => {
    const r = await reset("I1", ["fill"]);
    assert.equal(r.body.changed, true);
    assert.equal(find("I1").fill, undefined);
    assert.ok(find("I1").descendants.PLbl, "the layers inside keep theirs");
    assert.equal(await label(), "Reset Override");
    const d = await reset("I1", ["descendants"]);
    assert.equal(d.body.changed, true);
    assert.equal(find("I1").descendants, undefined);
    const restoreLayers = await undo();
    assert.equal(restoreLayers.status, 200, JSON.stringify(restoreLayers.body));
    const restoreOwn = await undo();
    assert.equal(restoreOwn.status, 200, JSON.stringify(restoreOwn.body));
    assert.equal(find("I1").fill, "#DC2626");
  });

  test("on a layer inside an instance: one property; the entry goes when nothing is left", async () => {
    assert.equal((await reset("I1/PLbl", ["fontSize"])).body.changed, true);
    assert.deepEqual(find("I1").descendants.PLbl, { content: "Go" });
    assert.equal((await reset("I1/PLbl", ["content"])).body.changed, true);
    assert.equal(find("I1").descendants.PLbl, undefined);
    assert.ok(find("I1").descendants.PDot);
    // A property that is not overridden: nothing to do.
    assert.equal((await reset("I1/PDot", ["opacity"])).body.changed, false);
  });
});

describe("push changes to main", () => {
  test("the instance's overrides become the main's own values, and leave the instance; one undo step", async () => {
    const r = await push("I1");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    assert.equal(r.body.main, "Pri");
    assert.equal(find("Pri").fill, "#DC2626");
    assert.equal(find("PLbl").content, "Go");
    assert.equal(find("PLbl").fontSize, 18);
    assert.equal(find("PDot").fill, "#00FF00");
    const i1 = find("I1");
    assert.equal(i1.fill, undefined);
    assert.equal(i1.descendants, undefined);
    assert.equal(i1.x, 10);
    assert.equal(await label(), "Push Changes to Main");
    await undo();
    assert.equal(find("Pri").fill, "#111827");
    assert.equal(find("PLbl").content, "OK");
    assert.equal(find("I1").fill, "#DC2626");
    assert.equal(find("I1").descendants.PLbl.content, "Go");
  });

  test("an override below a nested instance lands as the main's override on that instance", async () => {
    const r = await push("CI");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("CTitle").content, "Hello");
    assert.deepEqual(find("CBtn").descendants, { PLbl: { content: "Buy" } });
    assert.equal(find("PLbl").content, "OK", "the nested component itself is left alone");
    assert.equal(find("CI").descendants, undefined);
  });

  test("no overrides: nothing written; not an instance: refused", async () => {
    assert.equal((await push("I2")).body.changed, false);
    assert.equal((await push("Screen")).status, 400);
  });
});
