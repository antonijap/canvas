// An agent's new and moved boards never land on top of other boards (src/placement.ts): add_nodes without x/y goes
// right of the last board, a position that overlaps moves right until clear (and the answer says so), allowOverlap
// keeps it, move_board and place_nodes onto the canvas follow the same rule, and Cmd+D of a board that hugs its
// content no longer lands on itself.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { clearSpot, estimateSize, overlaps, type Rect } from "../src/placement.ts";

const dir = tmpDir("placement");
process.env.CANVAS_ROOTS = dir;
const HUG = { type: "frame", id: "Hug", name: "Hugging", x: 500, y: 0, layout: "vertical", gap: 10, padding: 20, children: [
  { type: "text", id: "H1", content: "A heading that runs long", fontFamily: "Inter", fontSize: 32, fontWeight: "600", fill: "#000000" },
  { type: "rectangle", id: "H2", width: 600, height: 400, fill: "#EEEEEE" },
] };
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "A", name: "Home", x: 0, y: 0, width: 400, height: 800, layout: "none", children: [
      { type: "rectangle", id: "A1", x: 20, y: 20, width: 100, height: 100, fill: "#FF0000" },
    ] },
    HUG,
  ],
};
const file = path.join(dir, "placement.canvas.json");
const reset = () => fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
reset();
const real = fs.realpathSync(file);
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  fs.unwatchFile(real);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const mcp = { "x-canvas": "1", "x-canvas-source": "mcp" };
const user = { "x-canvas": "1" };
async function call(p: string, body: unknown, headers: Record<string, string> = mcp) {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const add = (nodes: unknown[], extra: Record<string, unknown> = {}) => call("/api/structure", { file: real, op: "add", nodes, place: { parent: null }, ...extra });
const read = () => JSON.parse(fs.readFileSync(real, "utf8"));
const top = (id: string) => read().children.find((n: any) => n.id === id);
const hug = estimateSize(HUG as any);
const boxes = (): Rect[] => read().children.filter((n: any) => n.enabled !== false).map((n: any) => ({ x: n.x ?? 0, y: n.y ?? 0, w: n.width ?? (n.id === "Hug" ? hug.w : 0), h: n.height ?? (n.id === "Hug" ? hug.h : 0) }));
const clear = (id: string) => {
  const n = top(id);
  const me = { x: n.x, y: n.y, w: n.width ?? estimateSize(n).w, h: n.height ?? estimateSize(n).h };
  const hits = read().children.filter((o: any) => o.id !== id && o.enabled !== false).filter((o: any) => overlaps(me, { x: o.x ?? 0, y: o.y ?? 0, w: o.width ?? estimateSize(o).w, h: o.height ?? estimateSize(o).h }));
  assert.deepEqual(hits.map((o: any) => o.id), [], `${id} at ${me.x},${me.y} ${me.w}x${me.h} overlaps`);
};

beforeEach(async () => {
  // A fresh file each test: the server reloads it from disk.
  reset();
  await new Promise((r) => setTimeout(r, 30));
  await fetch(`${base}/api/summary?file=${encodeURIComponent(real)}`);
});

describe("estimateSize", () => {
  test("a vertical frame that hugs: padding, gap and its tallest and widest children", () => {
    assert.ok(hug.w >= 640, `width ${hug.w}`); // 600 wide rectangle + 2 x 20 padding
    assert.ok(hug.h >= 400 + 32 + 10 + 40, `height ${hug.h}`);
  });
  test("numbers in the file win", () => assert.deepEqual(estimateSize({ type: "frame", width: 10, height: 20 } as any), { w: 10, h: 20 }));
});

describe("clearSpot", () => {
  test("moves right past what it hits, one gap away, until clear", () => {
    const s = clearSpot({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 50, y: 0, w: 100, h: 100, name: "a" }, { x: 190, y: 50, w: 50, h: 50, name: "b" }], 40);
    assert.deepEqual(s, { x: 280, y: 0, hit: ["a", "b"] });
  });
  test("a free spot stays", () => assert.deepEqual(clearSpot({ x: 0, y: 500, w: 10, h: 10 }, [{ x: 0, y: 0, w: 10, h: 10 }]), { x: 0, y: 500, hit: [] }));
});

describe("add_nodes on the canvas", () => {
  test("a board written at 0,0 over Home moves right until clear of both boards; the answer says where and why", async () => {
    const r = await add([{ type: "frame", id: "New", name: "New", x: 0, y: 0, width: 375, height: 812, layout: "none", children: [] }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    clear("New");
    assert.equal(top("New").y, 0, "stays in its row");
    assert.equal(top("New").x, 500 + hug.w + 40);
    assert.deepEqual(r.body.placed, [{ id: "New", x: 500 + hug.w + 40, y: 0, width: 375, height: 812, movedFrom: { x: 0, y: 0 }, clearOf: ['"Home"', '"Hugging"'] }]);
    assert.match(r.body.note, /would have overlapped "Home", "Hugging" at 0,0: moved right/);
  });
  test("without x/y: right of everything on the page, level with its top board, 40 px away", async () => {
    const r = await add([{ type: "frame", id: "N2", name: "N2", width: 200, height: 200, layout: "none", children: [] }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([top("N2").x, top("N2").y], [500 + hug.w + 40, 0]);
    assert.equal(r.body.note, undefined, "nothing was moved off a spot the agent gave");
  });
  test("several boards without x/y line up in a row, none on another", async () => {
    const r = await add([1, 2, 3].map((i) => ({ type: "frame", id: `S${i}`, name: `S${i}`, width: 300, height: 600, layout: "none", children: [] })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const id of ["S1", "S2", "S3"]) clear(id);
    assert.deepEqual(["S1", "S2", "S3"].map((id) => top(id).x), [0, 1, 2].map((i) => 500 + hug.w + 40 + i * 340));
  });
  test("a board that hugs its content is placed by its estimated size", async () => {
    const r = await add([{ type: "frame", id: "HugNew", name: "Hug new", x: 100, y: 100, layout: "vertical", children: [{ type: "rectangle", width: 500, height: 500, fill: "#000000" }] }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    clear("HugNew");
    assert.equal(r.body.placed[0].sizeEstimated, true);
  });
  test("allowOverlap keeps the spot given", async () => {
    const r = await add([{ type: "note", id: "Over", x: 10, y: 10, width: 100, height: 100, content: "On purpose" }], { allowOverlap: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([top("Over").x, top("Over").y], [10, 10]);
  });
  test("a free spot the agent gives stays as given", async () => {
    const r = await add([{ type: "frame", id: "Below", x: 0, y: 2000, width: 100, height: 100, layout: "none", children: [] }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([top("Below").x, top("Below").y], [0, 2000]);
  });
  test("without x/y on a page whose last layer is a stray text low down: still right of everything, in the top row", async () => {
    await add([{ type: "text", id: "Stray", x: 0, y: 3000, content: "Note", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" }]);
    const r = await add([{ type: "frame", id: "N3", width: 200, height: 200, layout: "none", children: [] }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([top("N3").x, top("N3").y], [500 + hug.w + 40, 0]);
  });
  test("a person's add (an image dropped over a board) stays where it was put", async () => {
    const r = await call("/api/structure", { file: real, op: "add", nodes: [{ type: "rectangle", id: "Drop", x: 50, y: 50, width: 100, height: 100, fill: "#000000" }], place: { parent: null } }, user);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([top("Drop").x, top("Drop").y], [50, 50]);
    assert.equal(r.body.placed, undefined);
  });
  test("layers added into a board keep their x/y", async () => {
    const r = await call("/api/structure", { file: real, op: "add", nodes: [{ type: "rectangle", id: "In", x: 20, y: 20, width: 10, height: 10, fill: "#000000" }], place: { parent: "A" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const n = read().children[0].children.find((c: any) => c.id === "In");
    assert.deepEqual([n.x, n.y], [20, 20]);
    assert.equal(r.body.placed, undefined);
  });
  test("one undo takes the board away, placement included", async () => {
    // Its own agent session: an agent's steps join one step until finish_work, and the earlier tests' files were reset.
    const r = await call("/api/structure", { file: real, op: "add", nodes: [{ type: "frame", id: "U", x: 0, y: 0, width: 100, height: 100, layout: "none", children: [] }], place: { parent: null } }, { ...mcp, "x-canvas-session": "undo-test" });
    assert.ok(r.body.placed[0].movedFrom, "moved clear of Home");
    assert.ok(top("U"));
    const u = await call(`/api/history/undo?file=${encodeURIComponent(real)}`, {}, user);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(top("U"), undefined);
  });
});

describe("move_board", () => {
  test("an agent's move onto another board moves right until clear and says so", async () => {
    const r = await call("/api/move", { file: real, id: "A", x: 600, y: 100 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    clear("A");
    assert.equal(r.body.x, 500 + hug.w + 40);
    assert.deepEqual(r.body.movedFrom, { x: 600, y: 100 });
    assert.match(r.body.note, /"Hugging"/);
  });
  test("allowOverlap and a person's drag keep the spot", async () => {
    assert.equal((await call("/api/move", { file: real, id: "A", x: 600, y: 100, allowOverlap: true })).body.x, 600);
    assert.equal((await call("/api/move", { file: real, id: "A", x: 610, y: 100 }, user)).body.x, 610);
  });
});

describe("place_nodes onto the canvas", () => {
  test("a layer an agent moves out of a board lands clear of it", async () => {
    const r = await call("/api/layout", { file: real, op: "place", ids: ["A1"], parent: null, index: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    clear("A1");
    assert.equal(r.body.placed[0].id, "A1");
    assert.match(r.body.note, /"Home"/);
  });
});

describe("duplicate", () => {
  test("Cmd+D of a board that hugs its content lands clear of it (it had no width and went 40 px right, on top)", async () => {
    const r = await call("/api/structure", { file: real, op: "duplicate", ids: ["Hug"] }, user);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const copy = r.body.select[0];
    clear(copy);
    assert.ok(boxes().length === 3);
  });
});
