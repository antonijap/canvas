// Structure edits through the server (src/structure.ts, POST /api/structure) and their undo steps (tree ops in
// src/history.ts): delete, duplicate, copy/cut/paste (same file and across files), group, frame, ungroup, reorder,
// several layers' props at once, conflicts, and the MCP's agent step.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("structure");
process.env.CANVAS_ROOTS = dir;
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B1", name: "Board one", x: 0, y: 0, width: 400, height: 800, layout: "none", children: [
      { type: "rectangle", id: "R1", x: 10, y: 20, width: 50, height: 50, fill: "#FF0000" },
      { type: "rectangle", id: "R2", x: 100, y: 120, width: 40, height: 30, fill: "#00FF00" },
      { type: "ref", id: "I1", ref: "Cmp", x: 200, y: 300 },
      { type: "rectangle", id: "R3", x: 0, y: 0, width: 10, height: 10, fill: "#0000FF" },
    ] },
    { type: "frame", id: "B2", name: "Board two", x: 500, y: 0, width: 300, height: 300, layout: "vertical", gap: 8, children: [
      { type: "text", id: "T1", content: "One", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" },
      { type: "text", id: "T2", content: "Two", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" },
    ] },
    { type: "frame", id: "Cmp", name: "Button", reusable: true, x: 0, y: 1000, width: 120, height: 40, layout: "none", children: [
      { type: "text", id: "CmpL", content: "OK", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" },
    ] },
  ],
};
const write = (name: string, doc: unknown) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  return fs.realpathSync(p);
};
const file = write("structure.canvas.json", DOC);
const other = write("other.canvas.json", { version: "2.21", children: [{ type: "frame", id: "O1", name: "Other", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [] }] });
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(() => {
  for (const f of [file, other]) fs.unwatchFile(f);
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
const op = (body: Record<string, unknown>, f = file, headers = user) => call("POST", "/api/structure", { file: f, ...body }, headers);
const undo = (f = file) => call("POST", `/api/history/undo?file=${encodeURIComponent(f)}`);
const redo = (f = file) => call("POST", `/api/history/redo?file=${encodeURIComponent(f)}`);
const read = (f = file) => JSON.parse(fs.readFileSync(f, "utf8"));
const kids = (id: string, f = file): string[] => {
  const seek = (list: any[]): any => {
    for (const n of list) {
      if (n.id === id) return n;
      const h = n.children && seek(n.children);
      if (h) return h;
    }
  };
  return id === "document" ? read(f).children.map((n: any) => n.id) : (seek(read(f).children)?.children ?? []).map((n: any) => n.id);
};
const find = (id: string, f = file): any => {
  const seek = (list: any[]): any => {
    for (const n of list) {
      if (n.id === id) return n;
      const h = n.children && seek(n.children);
      if (h) return h;
    }
  };
  return seek(read(f).children);
};

beforeEach(async () => {
  fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
  fs.writeFileSync(other, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "O1", name: "Other", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [] }] }, null, 2));
  // the engine refuses the first write after an outside change; spend that refusal here.
  for (const f of [file, other]) await call("POST", "/api/update", { file: f, id: f === file ? "B1" : "O1", props: {} });
  history.resetHistory();
  clock += 5000;
});

describe("delete", () => {
  test("removes layers in one step, selects the next sibling, undo puts them back with the same ids", async () => {
    const r = await op({ op: "delete", ids: ["R1", "R2"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(kids("B1"), ["I1", "R3"]);
    assert.deepEqual(r.body.select, ["I1"]);
    assert.equal((await call("GET", `/api/history?file=${encodeURIComponent(file)}`)).body.undo, "Delete");
    assert.equal((await undo()).status, 200);
    assert.deepEqual(kids("B1"), ["R1", "R2", "I1", "R3"]);
    assert.deepEqual(find("R2"), DOC.children[0].children![1]);
    assert.equal((await redo()).status, 200);
    assert.deepEqual(kids("B1"), ["I1", "R3"]);
  });
  test("a board deletes with nothing selected after; a layer inside a selected board is skipped", async () => {
    const r = await op({ op: "delete", ids: ["B2", "T1"] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.select, []);
    assert.deepEqual(kids("document"), ["B1", "Cmp"]);
    await undo();
    assert.deepEqual(kids("document"), ["B1", "B2", "Cmp"]);
    assert.deepEqual(kids("B2"), ["T1", "T2"]);
  });
  test("the last child selects its parent; a component in use is kept hidden for its instances", async () => {
    await op({ op: "delete", ids: ["T1"] });
    const r = await op({ op: "delete", ids: ["T2"] });
    assert.deepEqual(r.body.select, ["B2"]);
    const c = await op({ op: "delete", ids: ["Cmp"] });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const holder = read().children.find((n: any) => n.metadata?.canvasDeletedComponents === true);
    assert.equal(holder.enabled, false);
    assert.deepEqual(holder.children.map((n: any) => n.id), ["Cmp"]);
    // The component and its only instance together go for good, holder and all.
    await undo();
    assert.equal((await op({ op: "delete", ids: ["Cmp", "I1"] })).status, 200);
    assert.equal(find("Cmp"), undefined);
    assert.equal(read().children.some((n: any) => n.metadata?.canvasDeletedComponents), false);
  });
  test("instance layers and unknown ids refuse without writing", async () => {
    const before = fs.readFileSync(file, "utf8");
    assert.equal((await op({ op: "delete", ids: ["I1/CmpL"] })).body.code, "instance");
    assert.equal((await op({ op: "delete", ids: ["Nope"] })).status, 404);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
  test("undo refuses when a removed layer's id came back; nothing is written", async () => {
    await op({ op: "delete", ids: ["R1"] });
    const doc = read();
    doc.children[1].children.push({ type: "rectangle", id: "R1", width: 5, height: 5 });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const before = fs.readFileSync(file, "utf8");
    const u = await undo();
    assert.equal(u.status, 409);
    assert.match(u.body.error, /"R1" exists again/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

describe("duplicate", () => {
  test("a board lands to the right with a gap, clear of other boards; undo removes it", async () => {
    const r = await op({ op: "duplicate", ids: ["B2"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [id] = r.body.select;
    const copy = find(id);
    assert.equal(copy.x, 500 + 300 + 40);
    assert.equal(copy.y, 0);
    assert.notEqual(copy.children[0].id, "T1");
    assert.deepEqual(kids("document"), ["B1", "B2", id, "Cmp"]);
    // B1 to the right would hit B2: it moves on until it is clear.
    const r2 = await op({ op: "duplicate", ids: ["B1"] });
    const c2 = find(r2.body.select[0]);
    assert.ok(c2.x >= 840 + 300, `copy at ${c2.x}`);
    await undo();
    await undo();
    assert.deepEqual(kids("document"), ["B1", "B2", "Cmp"]);
  });
  test("absolute layers land in place on top; auto-layout layers go right after themselves", async () => {
    const a = await op({ op: "duplicate", ids: ["R1"] });
    const ca = find(a.body.select[0]);
    assert.deepEqual([ca.x, ca.y], [10, 20]);
    assert.deepEqual(kids("B1").slice(0, 2), ["R1", a.body.select[0]]);
    const t = await op({ op: "duplicate", ids: ["T1", "T2"] });
    assert.equal(t.body.select.length, 2);
    assert.deepEqual(kids("B2"), ["T1", t.body.select[0], "T2", t.body.select[1]]);
    assert.equal(find(t.body.select[0]).x, undefined);
  });
});

describe("copy, cut, paste", () => {
  test("copy then paste into a frame with fresh ids; undo takes it out", async () => {
    const c = await op({ op: "copy", ids: ["R1"] });
    assert.equal(c.status, 200);
    assert.equal(c.body.payload.kind, "canvas/nodes");
    const p = await op({ op: "paste", payload: c.body.payload, place: { parent: "B2" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const id = p.body.select[0];
    assert.notEqual(id, "R1");
    assert.deepEqual(kids("B2"), ["T1", "T2", id]);
    await undo();
    assert.deepEqual(kids("B2"), ["T1", "T2"]);
    await redo();
    assert.deepEqual(kids("B2"), ["T1", "T2", id]);
  });
  test("paste at a position, at an index, and from the server's slot", async () => {
    const c = await op({ op: "copy", ids: ["R2", "R1"] });
    assert.deepEqual(c.body.payload.nodes.map((n: any) => n.id), ["R1", "R2"]);
    const p = await op({ op: "paste", fromServer: true, place: { parent: null, index: 0, positions: [{ x: -300, y: 5 }, null] } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const [a, b] = p.body.select;
    assert.deepEqual(kids("document").slice(0, 3), [a, b, "B1"]);
    assert.deepEqual([find(a).x, find(a).y], [-300, 5]);
    assert.deepEqual([find(b).x, find(b).y], [100, 120]);
  });
  test("cut removes in one step and leaves the payload; paste in another file brings the component along", async () => {
    const c = await op({ op: "cut", ids: ["I1"] });
    assert.equal(c.status, 200);
    assert.equal(find("I1"), undefined);
    assert.equal((await call("GET", `/api/history?file=${encodeURIComponent(file)}`)).body.undo, "Cut");
    const otherBefore = fs.readFileSync(other, "utf8");
    const p = await op({ op: "paste", payload: c.body.payload, place: { parent: "O1" } }, other);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const pasted = find(p.body.select[0], other);
    assert.equal(pasted.type, "ref", "the instance stays an instance");
    assert.equal(pasted.ref, "Cmp", "Button keeps its id: it is free in other.canvas.json");
    assert.equal(pasted.x, 200);
    const holder = read(other).children.find((n: any) => n.metadata?.canvasDeletedComponents === true);
    assert.equal(holder.enabled, false, "the main component sits in a hidden holder, off the canvas");
    assert.deepEqual(holder.children.map((n: any) => [n.id, n.reusable, n.children[0].content]), [["Cmp", true, "OK"]]);
    // A second paste links to it instead of bringing another copy.
    const p2 = await op({ op: "paste", payload: c.body.payload, place: { parent: "O1" } }, other);
    assert.equal(find(p2.body.select[0], other).ref, "Cmp");
    assert.equal(read(other).children.find((n: any) => n.metadata?.canvasDeletedComponents === true).children.length, 1);
    // One undo per paste; the second undo takes the holder away too, byte for byte.
    assert.equal((await undo(other)).status, 200);
    assert.equal((await undo(other)).status, 200);
    assert.equal(fs.readFileSync(other, "utf8"), otherBefore);
    // In its own file the instance stays an instance.
    const back = await op({ op: "paste", payload: c.body.payload, place: { parent: "B1" } });
    assert.equal(find(back.body.select[0]).type, "ref");
  });
  test("a layer inside an instance copies as a detached layer", async () => {
    const c = await op({ op: "copy", ids: ["I1/CmpL"] });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const p = await op({ op: "paste", payload: c.body.payload, place: { parent: "B1" } });
    assert.equal(find(p.body.select[0]).content, "OK");
  });
  test("paste refuses a leaf target and garbage", async () => {
    const c = await op({ op: "copy", ids: ["R1"] });
    assert.equal((await op({ op: "paste", payload: c.body.payload, place: { parent: "R2" } })).status, 400);
    assert.equal((await op({ op: "paste", payload: { nodes: [] }, place: { parent: null } })).status, 400);
  });
});

describe("group, frame, ungroup", () => {
  test("Cmd+G wraps siblings at the topmost one's place, children keep their place on the canvas", async () => {
    const r = await op({ op: "group", ids: ["R2", "R1"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const gid = r.body.select[0];
    assert.deepEqual(kids("B1"), [gid, "I1", "R3"]);
    const g = find(gid);
    assert.equal(g.type, "group");
    assert.deepEqual([g.x, g.y], [10, 20]);
    assert.deepEqual(g.children.map((c: any) => [c.id, c.x, c.y]), [["R1", 0, 0], ["R2", 90, 100]]);
    assert.equal((await undo()).status, 200);
    assert.deepEqual(read(), DOC);
    assert.equal((await redo()).status, 200);
    assert.equal(find(gid).children.length, 2);
  });
  test("Opt+Cmd+G makes a frame the size of the selection; auto-layout layers use the page's rects", async () => {
    const rects = { B2: { x: 500, y: 0, w: 300, h: 300 }, T1: { x: 500, y: 0, w: 30, h: 17 }, T2: { x: 500, y: 25, w: 30, h: 17 } };
    const r = await op({ op: "frame", ids: ["T1", "T2"], rects });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = find(r.body.select[0]);
    assert.equal(f.type, "frame");
    assert.equal(f.layout, "none");
    assert.deepEqual([f.width, f.height, f.x], [30, 42, undefined]);
    assert.deepEqual(f.children.map((c: any) => [c.x, c.y]), [[0, 0], [0, 25]]);
    await undo();
    assert.deepEqual(read(), DOC);
  });
  test("layers in different parents refuse", async () => {
    assert.equal((await op({ op: "group", ids: ["R1", "T1"] })).status, 400);
  });
  test("Shift+Cmd+G gives the layers back in place; undo restores the group", async () => {
    const g = await op({ op: "group", ids: ["R1", "R2"] });
    const gid = g.body.select[0];
    const u = await op({ op: "ungroup", ids: [gid] });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.deepEqual(u.body.select, ["R1", "R2"]);
    assert.deepEqual(read(), DOC);
    await undo();
    assert.equal(find(gid).children.length, 2);
    await undo();
    assert.deepEqual(read(), DOC);
  });
  test("ungrouping a component refuses", async () => {
    assert.equal((await op({ op: "ungroup", ids: ["Cmp"] })).body.code, "component");
  });
});

describe("reorder", () => {
  test("forward, backward, front and back; selected layers do not pass each other", async () => {
    await op({ op: "reorder", ids: ["R1"], dir: "forward" });
    assert.deepEqual(kids("B1"), ["R2", "R1", "I1", "R3"]);
    await op({ op: "reorder", ids: ["R1", "R2"], dir: "front" });
    assert.deepEqual(kids("B1"), ["I1", "R3", "R2", "R1"]);
    await op({ op: "reorder", ids: ["R1"], dir: "back" });
    assert.deepEqual(kids("B1"), ["R1", "I1", "R3", "R2"]);
    await op({ op: "reorder", ids: ["R2"], dir: "backward" });
    assert.deepEqual(kids("B1"), ["R1", "I1", "R2", "R3"]);
    for (let i = 0; i < 4; i++) assert.equal((await undo()).status, 200);
    assert.deepEqual(read(), DOC);
    const top = await op({ op: "reorder", ids: ["R3"], dir: "forward" });
    assert.equal(top.body.code, "no_change");
  });
  test("undo of a reorder refuses when somebody reordered the same layers since", async () => {
    await op({ op: "reorder", ids: ["R1"], dir: "forward" });
    const doc = read();
    const [a, b, c] = doc.children[0].children;
    doc.children[0].children = [a, c, b, doc.children[0].children[3]];
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const before = fs.readFileSync(file, "utf8");
    assert.equal((await undo()).status, 409);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
  test("undo of a reorder refuses when the layer moved to another parent since", async () => {
    await op({ op: "reorder", ids: ["R1"], dir: "front" });
    const doc = read();
    const r1 = doc.children[0].children.pop();
    doc.children[1].children.push(r1);
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const u = await undo();
    assert.equal(u.status, 409);
    assert.match(u.body.error, /moved/);
  });
});

describe("several layers and agents", () => {
  test("props on several layers write once and undo in one step", async () => {
    const r = await call("POST", "/api/update", { file, ids: ["R1", "R2"], props: { fill: "#123456" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("R1").fill, "#123456");
    assert.equal(find("R2").fill, "#123456");
    await undo();
    assert.equal(find("R1").fill, "#FF0000");
    assert.equal(find("R2").fill, "#00FF00");
  });
  test("an agent's structure edits and prop edits fold into its step and undo together", async () => {
    const agent = { "x-canvas": "1", "x-canvas-source": "mcp", "x-canvas-session": "s9" };
    await call("POST", "/api/update", { file, id: "R1", props: { x: 15 } }, agent);
    const g = await op({ op: "group", ids: ["R1", "R2"] }, file, agent);
    await call("POST", "/api/update", { file, id: g.body.select[0], props: { name: "Pair" } }, agent);
    await op({ op: "delete", ids: ["R3"] }, file, agent);
    const st = (await call("GET", `/api/history?file=${encodeURIComponent(file)}`)).body;
    assert.equal(st.undoDepth, 1);
    assert.equal((await undo()).status, 200);
    assert.deepEqual(read(), DOC);
    assert.equal((await redo()).status, 200);
    assert.equal(find(g.body.select[0]).name, "Pair");
    assert.equal(find("R3"), undefined);
    assert.deepEqual([find("R1").x, find("R2").x], [0, 85]);
  });
});

describe("add (add_nodes)", () => {
  test("adds a board with children at the top level, keeping free ids; one undo removes it, redo brings it back", async () => {
    const board = { type: "frame", id: "New1", name: "Idea", x: 900, y: 0, width: 200, height: 100, layout: "vertical", gap: 4, children: [
      { type: "text", id: "NewT", content: "Hello", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" },
      { type: "ref", ref: "Cmp" },
    ] };
    const r = await op({ op: "add", nodes: [board], place: { parent: null } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.select, ["New1"]);
    assert.deepEqual(kids("document"), ["B1", "B2", "Cmp", "New1"]);
    assert.equal(find("NewT").content, "Hello");
    const inst = find("New1").children[1];
    assert.equal(inst.type, "ref");
    assert.equal(inst.ref, "Cmp");
    assert.ok(typeof inst.id === "string" && inst.id.length > 0, "a layer without an id gets one");
    assert.equal((await call("GET", `/api/history?file=${encodeURIComponent(file)}`)).body.undo, "Add layer");
    assert.equal((await undo()).status, 200);
    assert.deepEqual(kids("document"), ["B1", "B2", "Cmp"]);
    assert.equal((await redo()).status, 200);
    assert.deepEqual(kids("document"), ["B1", "B2", "Cmp", "New1"]);
    assert.equal(find("NewT").content, "Hello");
  });
  test("adds into a frame at an index; a taken id gets a fresh one", async () => {
    const r = await op({ op: "add", nodes: [{ type: "rectangle", id: "R1", x: 5, y: 5, width: 10, height: 10, fill: "#123456" }, { type: "ellipse", id: "E9", x: 0, y: 0, width: 8, height: 8, fill: "#654321" }], place: { parent: "B1", index: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [fresh, e9] = r.body.select;
    assert.notEqual(fresh, "R1");
    assert.equal(e9, "E9");
    assert.deepEqual(kids("B1"), ["R1", fresh, "E9", "R2", "I1", "R3"]);
    assert.equal(find(fresh).fill, "#123456");
    assert.equal(find("R1").fill, "#FF0000");
  });
  test("a new component and an instance of it in the same add both land", async () => {
    const r = await op({ op: "add", nodes: [
      { type: "frame", id: "Chip", name: "Chip", reusable: true, x: 0, y: 1200, width: 60, height: 20, layout: "none", children: [] },
      { type: "ref", id: "ChipI", ref: "Chip", x: 0, y: 1300 },
    ], place: { parent: null } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("Chip").reusable, true);
    assert.equal(find("ChipI").ref, "Chip");
  });
  test("a new group fits its layers: a turned layer at 0,0 moves the group's corner, the drawn layers stay put", async () => {
    const r = await op({ op: "add", nodes: [{ type: "group", id: "G9", x: 100, y: 150, children: [
      { type: "rectangle", id: "G9a", x: 0, y: 0, width: 100, height: 60, rotation: 45, fill: "#111111" },
      { type: "rectangle", id: "G9b", x: 140, y: 0, width: 80, height: 80, fill: "#222222" },
    ] }], place: { parent: "B1" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const g = find("G9"), a = find("G9a"), b2 = find("G9b");
    assert.ok(g.y < 150, `group moved up to the turned layer's top (y ${g.y})`);
    assert.equal(Math.round((g.y + b2.y) * 100) / 100, 150, "the plain layer stays where it was drawn");
    assert.equal(Math.round((g.x + a.x) * 100) / 100, 100);
    assert.equal((await undo()).status, 200);
    assert.equal(find("G9"), undefined);
  });
  test("refuses bad input and writes nothing", async () => {
    const before = fs.readFileSync(file, "utf8");
    for (const nodes of [[], [{ id: "x" }], [{ type: "rectangle", id: "D", width: 1, height: 1 }, { type: "rectangle", id: "D", width: 1, height: 1 }], [{ type: "ellipse", width: 1, height: 1, cornerSmoothing: 1 }], [{ type: "ref", ref: "Nope" }]]) {
      const r = await op({ op: "add", nodes, place: { parent: null } });
      assert.ok(r.status >= 400, `${JSON.stringify(nodes)} -> ${r.status}`);
    }
    assert.equal((await op({ op: "add", nodes: [{ type: "rectangle", width: 1, height: 1 }], place: { parent: "R1" } })).status, 400);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});
