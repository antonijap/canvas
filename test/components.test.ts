// Components and instances (QA pass 2026-11-15, .planning/research/qa-components.md): no instance inside
// its own component (paste, duplicate), a main component copies as an instance in the same file, deleting a main
// keeps it hidden for its instances, overrides on layers inside instances (src/overrides.ts) with reset, and what
// /api/node says about instances (drawn parent, children, resolved props, overrides).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
// @ts-ignore: a plain ES module the page imports too
import { handleChanged } from "../src/page/autolayout-logic.js";
// @ts-ignore: a plain ES module the page imports too
import { pickTarget } from "../src/page/geometry.js";

const dir = tmpDir("components");
process.env.CANVAS_ROOTS = dir;
const text = (id: string, content: string) => ({ type: "text", id, content, fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" });
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "Lib", name: "Library", x: 0, y: 0, width: 600, height: 400, layout: "none", children: [
      { type: "frame", id: "Btn", name: "Button", reusable: true, x: 20, y: 20, width: 120, height: 40, layout: "horizontal", padding: [12, 16], fill: "#9747FF", cornerRadius: 8, children: [
        { type: "ellipse", id: "Dot", width: 8, height: 8, fill: "#FFFFFF" },
        text("Lbl", "OK"),
      ] },
      { type: "frame", id: "Card", name: "Card", reusable: true, x: 200, y: 20, width: 200, height: 120, layout: "vertical", children: [
        { type: "ref", id: "CardBtn", ref: "Btn" },
      ] },
    ] },
    { type: "frame", id: "Screen", name: "Screen", x: 800, y: 0, width: 400, height: 400, layout: "none", children: [
      { type: "ref", id: "I1", ref: "Btn", x: 10, y: 10 },
      { type: "ref", id: "I2", ref: "Btn", x: 10, y: 80 },
      { type: "ref", id: "CI", ref: "Card", x: 10, y: 150 },
    ] },
  ],
};
const file = path.join(dir, "components.canvas.json");
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

let clock = 30_000_000;
history.setClock(() => clock);
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const q = (s: string) => encodeURIComponent(s);
const op = (body: Record<string, unknown>) => call("POST", "/api/structure", { file: real, ...body });
const update = (body: Record<string, unknown>) => call("POST", "/api/update", { file: real, ...body });
const undo = () => call("POST", `/api/history/undo?file=${q(real)}`);
const node = (id: string, depth = 1) => call("GET", `/api/node?file=${q(real)}&id=${q(id)}&depth=${depth}`);
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
const holder = () => read().children.find((n: any) => n.metadata?.canvasDeletedComponents === true);

beforeEach(async () => {
  fs.writeFileSync(real, JSON.stringify(DOC, null, 2));
  await call("POST", "/api/update", { file: real, id: "Lib", props: {} });
  history.resetHistory();
  clock += 5000;
});

describe("no instance inside its own component", () => {
  test("pasting an instance into its own main component refuses (409 cycle) and writes nothing", async () => {
    const c = await op({ op: "copy", ids: ["I1"] });
    const before = fs.readFileSync(real, "utf8");
    const r = await op({ op: "paste", payload: c.body.payload, place: { parent: "Btn" } });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "cycle");
    assert.match(r.body.error, /Button/);
    assert.equal(fs.readFileSync(real, "utf8"), before);
  });
  test("a two-step loop (a Card instance into Button, which Card uses) refuses too", async () => {
    const c = await op({ op: "copy", ids: ["CI"] });
    const r = await op({ op: "paste", payload: c.body.payload, place: { parent: "Btn" } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "cycle");
  });
  test("a paste next to the component is fine", async () => {
    const c = await op({ op: "copy", ids: ["I1"] });
    assert.equal((await op({ op: "paste", payload: c.body.payload, place: { parent: "Lib" } })).status, 200);
  });
});

describe("main components copy as instances in the same file", () => {
  test("Cmd+D on a main makes an instance of it next to it", async () => {
    const r = await op({ op: "duplicate", ids: ["Btn"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const copy = find(r.body.select[0]);
    assert.equal(copy.type, "ref");
    assert.equal(copy.ref, "Btn");
    assert.equal(copy.reusable, undefined);
    assert.equal(read().children[0].children.filter((n: any) => n.reusable).length, 2, "still two mains: Button and Card");
  });
  test("copy and paste of a main pastes an instance; a board holding a main pastes with an instance in its place", async () => {
    const c = await op({ op: "copy", ids: ["Btn"] });
    const r = await op({ op: "paste", payload: c.body.payload, place: { parent: "Screen" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([find(r.body.select[0]).type, find(r.body.select[0]).ref], ["ref", "Btn"]);
    const b = await op({ op: "copy", ids: ["Lib"] });
    const r2 = await op({ op: "paste", payload: b.body.payload, place: { parent: null } });
    const pasted = find(r2.body.select[0]);
    assert.deepEqual(pasted.children.map((n: any) => [n.type, n.ref]), [["ref", "Btn"], ["ref", "Card"]]);
  });
  test("cut and paste moves a main component: same id, its instances still use it, no holder left", async () => {
    const cut = await op({ op: "cut", ids: ["Btn"] });
    assert.equal(cut.status, 200, JSON.stringify(cut.body));
    assert.ok(holder(), "parked while its instances need it");
    const r = await op({ op: "paste", payload: cut.body.payload, place: { parent: "Screen" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.select, ["Btn"]);
    assert.equal(find("Btn").reusable, true);
    assert.equal(holder(), undefined);
    assert.equal((await call("GET", `/api/board?file=${q(real)}&id=Screen`)).status, 200);
  });
});

describe("deleting a main component that has instances", () => {
  test("its instances keep drawing; it waits hidden, undo puts it back, it goes once nothing uses it", async () => {
    const r = await op({ op: "delete", ids: ["Btn"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const h = holder();
    assert.equal(h.enabled, false);
    assert.deepEqual(h.children.map((n: any) => n.id), ["Btn"]);
    const board = await call("GET", `/api/board?file=${q(real)}&id=Screen`);
    assert.equal(board.status, 200);
    assert.ok(board.body.html.includes("OK"), "the instance still draws its label");
    // Not in the file's component list, and Go to main has nowhere to go.
    const docInfo = await call("GET", `/api/doc?file=${q(real)}`);
    assert.ok(!docInfo.body.components.some((c: any) => c.id === "Btn"));
    assert.equal(docInfo.body.boards.some((b: any) => b.id === h.id), false, "the holder is no board");
    assert.equal((await node("I1")).body.context.main, undefined);
    await undo();
    assert.equal(holder(), undefined);
    assert.equal(find("Btn").reusable, true);
    // A board holding a main: the board goes, the main waits; deleting the last users clears it all.
    await op({ op: "delete", ids: ["Lib"] });
    assert.deepEqual(holder().children.map((n: any) => n.id).sort(), ["Btn", "Card"]);
    await op({ op: "delete", ids: ["I1", "I2"] });
    assert.deepEqual(holder().children.map((n: any) => n.id).sort(), ["Btn", "Card"], "Card still uses Button, CI uses Card");
    await op({ op: "delete", ids: ["CI"] });
    assert.equal(holder(), undefined);
  });
});

describe("overrides on layers inside instances", () => {
  test("fill, opacity, visibility and radius go into the instance's descendants; undo takes them out", async () => {
    const r = await update({ id: "I1/Dot", props: { fill: "#FF0000", opacity: 0.5 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(find("I1").descendants, { Dot: { fill: "#FF0000", opacity: 0.5 } });
    assert.equal(find("Dot").fill, "#FFFFFF", "the component is left alone");
    assert.equal((await update({ id: "I1/Lbl", props: { enabled: false } })).status, 200);
    assert.equal(find("I1").descendants.Lbl.enabled, false);
    await undo();
    assert.equal(find("I1").descendants.Lbl, undefined);
    await undo();
    assert.equal(find("I1").descendants, undefined);
  });
  test("font props on a text inside a nested instance; a bad value refuses", async () => {
    const r = await update({ id: "CI/CardBtn/Lbl", props: { fontWeight: "700", fontSize: 16 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(find("CI").descendants, { "CardBtn/Lbl": { fontWeight: "700", fontSize: 16 } });
    const bad = await update({ id: "I1/Lbl", props: { fontWeight: 700 } });
    assert.equal(bad.status, 422);
    assert.equal((await update({ id: "I1/Lbl", props: { type: "rectangle" } })).status, 422);
  });
  test("several layers at once, inside and outside instances: one write, one undo step", async () => {
    const r = await update({ ids: ["I1/Dot", "I2/Dot", "Screen"], props: { fill: "#00FF00" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("I1").descendants.Dot.fill, "#00FF00");
    assert.equal(find("I2").descendants.Dot.fill, "#00FF00");
    assert.equal(find("Screen").fill, "#00FF00");
    await undo();
    assert.equal(find("I1").descendants, undefined);
    assert.equal(find("Screen").fill, undefined);
  });
  test("removing an override resets it; removing a fill the component draws writes none", async () => {
    await update({ id: "I1/Dot", props: { fill: "#FF0000", opacity: 0.5 } });
    await update({ id: "I1/Dot", props: {}, remove: ["opacity"] });
    assert.deepEqual(find("I1").descendants, { Dot: { fill: "#FF0000" } });
    await update({ id: "I1/Dot", props: {}, remove: ["fill"] });
    assert.deepEqual(find("I1").descendants, { Dot: { fill: [] } });
  });
  test("Reset all changes: on a layer inside, then on the instance (its own props and every layer's)", async () => {
    await update({ id: "I1/Dot", props: { fill: "#FF0000" } });
    await update({ id: "I1/Lbl", props: { content: "Go" } });
    await update({ id: "I1", props: { fill: "#000000", x: 50 } });
    const one = await call("POST", "/api/overrides/reset", { file: real, id: "I1/Dot" });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.deepEqual(find("I1").descendants, { Lbl: { content: "Go" } });
    const all = await call("POST", "/api/overrides/reset", { file: real, id: "I1" });
    assert.equal(all.body.changed, true);
    const i1 = find("I1");
    assert.equal(i1.descendants, undefined);
    assert.equal(i1.fill, undefined);
    assert.equal(i1.x, 50, "where it sits is not an override");
    assert.equal((await call("GET", `/api/history?file=${q(real)}`)).body.undo, "Reset Overrides");
    await undo();
    assert.equal(find("I1").fill, "#000000");
    assert.equal((await call("POST", "/api/overrides/reset", { file: real, id: "I2" })).body.changed, false);
    assert.equal((await call("POST", "/api/overrides/reset", { file: real, id: "Screen" })).status, 400);
  });
});

describe("renaming a main component", () => {
  test("instances still named after it follow, in the same undo step; renamed ones keep their name", async () => {
    const doc = structuredClone(DOC) as any;
    doc.children[1].children[0].name = "Button";
    doc.children[1].children[1].name = "Primary";
    fs.writeFileSync(real, JSON.stringify(doc, null, 2));
    await call("POST", "/api/update", { file: real, id: "Lib", props: {} });
    history.resetHistory();
    assert.equal((await update({ id: "Btn", props: { name: "CTA" } })).status, 200);
    assert.equal(find("I1").name, undefined);
    assert.equal(find("I2").name, "Primary");
    await undo();
    assert.equal(find("I1").name, "Button");
    assert.equal(find("Btn").name, "Button");
  });
});

describe("/api/node for instances", () => {
  test("a layer inside an instance has the instance as parent (nested: the nested instance), and its overrides", async () => {
    await update({ id: "I1/Dot", props: { fill: "#FF0000" } });
    const a = await node("I1/Dot");
    assert.equal(a.body.parentId, "I1");
    assert.equal(a.body.instance, "I1");
    assert.deepEqual(a.body.overrides, ["fill"]);
    assert.equal((await node("CI/CardBtn/Lbl")).body.parentId, "CI/CardBtn");
    assert.equal((await node("CI/CardBtn")).body.parentId, "CI");
  });
  test("an instance lists the layers it draws and its props as drawn, overrides named", async () => {
    await update({ id: "I2", props: { padding: [12, 16] } });
    const r = await node("I2");
    assert.deepEqual(r.body.node.children.map((c: any) => c.id), ["I2/Dot", "I2/Lbl"]);
    assert.equal(r.body.resolved.fill, "#9747FF");
    assert.equal(r.body.resolved.layout, "horizontal");
    assert.equal(r.body.resolved.cornerRadius, 8);
    assert.deepEqual(r.body.overrides, ["padding"]);
    assert.equal(r.body.node.fill, undefined, "node stays the stored instance");
  });
});

describe("page logic", () => {
  test("the click rule", () => {
    const chain = ["B", "F", "G", "T"];
    assert.equal(pickTarget(chain, []), "F", "nothing selected: the board's direct child");
    assert.equal(pickTarget(chain, [["B", "X"]]), "F", "another layer of the board selected");
    assert.equal(pickTarget(chain, [["B2", "Y"]]), "F", "another board");
    assert.equal(pickTarget(chain, [["B", "F"]]), "G", "inside the selected container: its child");
    assert.equal(pickTarget(chain, [["B", "F", "G"]]), "T", "one more level");
    assert.equal(pickTarget(chain, [["B", "F", "H"]]), "G", "a sibling of the selection");
    assert.equal(pickTarget(chain, [["B", "F", "G", "T"]]), "T", "the leaf stays");
    assert.equal(pickTarget(chain, [], true), "T", "Cmd: deepest");
    assert.equal(pickTarget(["B"], []), "B", "a board's background is the board");
    assert.equal(pickTarget(["B", "I1", "I1/Lbl"], []), "I1", "an instance as a whole");
    assert.equal(pickTarget(["B", "I1", "I1/Lbl"], [["B", "I1"]]), "I1/Lbl", "then inside it");
    assert.equal(pickTarget([], []), null);
  });
  test("a padding or gap handle dragged back where it started writes nothing", () => {
    const start = { pad: [12, 16, 12, 16], gap: 8, auto: false };
    assert.equal(handleChanged(start, { padding: [12, 16] }), false);
    assert.equal(handleChanged(start, { padding: [12, 17] }), true);
    assert.equal(handleChanged(start, { gap: 8 }), false);
    assert.equal(handleChanged(start, { gap: 9 }), true);
    assert.equal(handleChanged({ ...start, auto: true }, { gap: 8 }), true, "a drag ends Auto");
    assert.equal(handleChanged(start, null), false);
  });
});
