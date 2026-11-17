// Moving and renaming boards and layers through the server (src/move.ts, /api/update): board drops, nudges that
// fold into one undo step, auto-layout refusal, instance paths, the info route and renames.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("move");
process.env.CANVAS_ROOTS = dir;
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B1", name: "Board one", x: 0, y: 0, width: 390, height: 844, layout: "none", children: [
      { type: "rectangle", id: "Abs", x: 10, y: 20, width: 50, height: 50, fill: "#FF0000" },
    ] },
    { type: "frame", id: "B2", name: "Board two", x: 500, y: 100, width: 600, height: 300, layout: "vertical", children: [
      { type: "rectangle", id: "Flow", width: 50, height: 50, fill: "#00FF00" },
      { type: "rectangle", id: "Pin", x: 5, y: 6, width: 10, height: 10, layoutPosition: "absolute", fill: "#0000FF" },
    ] },
  ],
};
const docFile = path.join(dir, "move.canvas.json");
fs.writeFileSync(docFile, JSON.stringify(DOC, null, 2));
const file = fs.realpathSync(docFile);
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

let clock = 5_000_000;
history.setClock(() => clock);
const later = (ms: number) => void (clock += ms);

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = { "x-canvas": "1" }) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const move = (b: Record<string, unknown>, headers?: Record<string, string>) => call("POST", "/api/move", { file, ...b }, headers);
const q = `?file=${encodeURIComponent(file)}`;
const undo = () => call("POST", `/api/history/undo${q}`);
const find = (id: string) => {
  const seek = (ns: any[]): any => { for (const n of ns) { if (n.id === id) return n; const h = n.children && seek(n.children); if (h) return h; } };
  return seek(JSON.parse(fs.readFileSync(file, "utf8")).children);
};

beforeEach(async () => {
  fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
  // the engine refuses the first write after an outside change; spend that refusal here.
  await call("POST", "/api/update", { file, id: "B1", props: {} });
  history.resetHistory();
  later(5000);
});

describe("/api/move", () => {
  test("a board drop writes x/y once and undoes in one step", async () => {
    const r = await move({ id: "B2", x: 700, y: 140 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, "board");
    assert.deepEqual([find("B2").x, find("B2").y], [700, 140]);
    const st = (await call("GET", `/api/history${q}`)).body;
    assert.equal(st.undo, "Move Board");
    assert.equal(st.undoDepth, 1);
    assert.equal((await undo()).status, 200);
    assert.deepEqual([find("B2").x, find("B2").y], [500, 100]);
  });

  test("two quick drops of the same board stay two steps", async () => {
    await move({ id: "B1", x: 10, y: 0 });
    later(100);
    await move({ id: "B1", x: 20, y: 0 });
    assert.equal((await call("GET", `/api/history${q}`)).body.undoDepth, 2);
  });

  test("a burst of nudges is one undo step; a pause starts the next", async () => {
    for (let i = 0; i < 5; i++) { await move({ id: "Abs", dx: 1, dy: 0, merge: "nudge", round: true }); later(300); }
    await move({ id: "Abs", dx: 0, dy: 10, merge: "nudge", round: true });
    assert.deepEqual([find("Abs").x, find("Abs").y], [15, 30]);
    let st = (await call("GET", `/api/history${q}`)).body;
    assert.equal(st.undoDepth, 1);
    assert.equal(st.undo, "Nudge");
    later(1500);
    await move({ id: "Abs", dx: -1, merge: "nudge" });
    st = (await call("GET", `/api/history${q}`)).body;
    assert.equal(st.undoDepth, 2);
    await undo();
    await undo();
    assert.deepEqual([find("Abs").x, find("Abs").y], [10, 20]);
  });

  test("dx/dy round to whole px when asked; absolute set keeps fractions otherwise", async () => {
    await move({ id: "Pin", dx: 0.4, dy: 0.6, round: true });
    assert.deepEqual([find("Pin").x, find("Pin").y], [5, 7]);
    later(2000);
    await move({ id: "Pin", x: 1.5, y: 2.25 });
    assert.deepEqual([find("Pin").x, find("Pin").y], [1.5, 2.25]);
  });

  test("auto-layout children refuse; instance paths refuse; unknown ids 404", async () => {
    const auto = await move({ id: "Flow", dx: 1 });
    assert.equal(auto.status, 409);
    assert.equal(auto.body.code, "auto_layout");
    assert.equal(find("Flow").x, undefined, "nothing written");
    assert.equal((await move({ id: "Ins/Child", dx: 1 })).status, 400);
    assert.equal((await move({ id: "Nope", dx: 1 })).status, 404);
    assert.equal((await move({ id: "B1" })).status, 400);
    assert.equal((await call("POST", "/api/move", { file, id: "B1", x: 1 }, {})).status, 403);
  });

  test("GET says how a node moves", async () => {
    const info = async (id: string) => (await call("GET", `/api/move${q}&id=${id}`)).body;
    assert.equal((await info("B1")).mode, "board");
    const abs = await info("Abs");
    assert.deepEqual([abs.mode, abs.parentId, abs.x, abs.y], ["absolute", "B1", 10, 20]);
    assert.equal((await info("Flow")).mode, "auto");
    const pin = await info("Pin");
    assert.equal(pin.mode, "absolute");
    assert.deepEqual(pin.siblings, ["Flow"]);
  });

  test("an agent's move lands in its open step", async () => {
    const r = await move({ id: "B1", dx: 5 }, { "x-canvas": "1", "x-canvas-source": "mcp", "x-canvas-session": "s9" });
    assert.equal(r.status, 200);
    assert.equal((await call("GET", `/api/history${q}`)).body.undo, "Agent Edits");
  });
});

describe("rename", () => {
  test("a board rename is one undoable Name Change", async () => {
    const r = await call("POST", "/api/update", { file, id: "B1", props: { name: "Home" } });
    assert.equal(r.status, 200);
    assert.equal(find("B1").name, "Home");
    assert.equal((await call("GET", `/api/history${q}`)).body.undo, "Name Change");
    await undo();
    assert.equal(find("B1").name, "Board one");
  });
});

describe("/api/move items (a multi-selection moved together)", () => {
  test("boards and absolute layers move in one write and one undo step; auto layout and nested ones are skipped", async () => {
    const r = await move({ items: [{ id: "B1", dx: 10, dy: 5 }, { id: "Pin", dx: 10, dy: 5 }, { id: "Flow", dx: 10, dy: 5 }, { id: "Abs", dx: 10, dy: 5 }], round: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.moved.map((m: any) => m.id), ["B1", "Pin"]);
    assert.deepEqual(r.body.skipped, [{ id: "Flow", code: "auto_layout" }, { id: "Abs", code: "inside" }]);
    assert.deepEqual([find("B1").x, find("B1").y, find("Pin").x, find("Pin").y, find("Abs").x], [10, 5, 15, 11, 10]);
    const st = (await call("GET", `/api/history${q}`)).body;
    assert.equal(st.undoDepth, 1);
    assert.equal(st.undo, "Move");
    await undo();
    assert.deepEqual([find("B1").x, find("B1").y, find("Pin").x, find("Pin").y], [0, 0, 5, 6]);
  });

  test("a card of the same gesture (x-canvas-merge group:) folds into the layers' step", async () => {
    const added = await call("POST", `/api/widgets${q}`, { kind: "note", x: 100, y: 100 });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    history.resetHistory();
    later(5000);
    const key = "group:test1";
    await move({ items: [{ id: "B2", dx: 20, dy: 0 }], round: true, merge: key });
    const w = await call("PATCH", `/api/widgets/${added.body.widget.id}${q}`, { x: 120, y: 100 }, { "x-canvas": "1", "x-canvas-merge": key });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    let st = (await call("GET", `/api/history${q}`)).body;
    assert.equal(st.undoDepth, 1);
    assert.equal(st.undo, "Move");
    await undo();
    assert.equal(find("B2").x, 500);
    const got = (await call("GET", `/api/widgets/${added.body.widget.id}${q}`)).body;
    assert.equal((got.widget ?? got).x, 100);
    // Another gesture is another step.
    later(100);
    await move({ items: [{ id: "B2", dx: 1 }], merge: "group:test2" });
    await move({ items: [{ id: "B2", dx: 1 }], merge: "group:test3" });
    st = (await call("GET", `/api/history${q}`)).body;
    assert.equal(st.undoDepth, 2);
  });

  test("a nudge burst of a multi-selection reads Nudge; bad items refuse", async () => {
    await move({ items: [{ id: "B1", dx: 1 }, { id: "B2", dx: 1 }], merge: "group:nudge-1-a", round: true });
    later(200);
    await move({ items: [{ id: "B1", dx: 1 }, { id: "B2", dx: 1 }], merge: "group:nudge-1-a", round: true });
    const st = (await call("GET", `/api/history${q}`)).body;
    assert.deepEqual([st.undoDepth, st.undo], [1, "Nudge"]);
    assert.deepEqual([find("B1").x, find("B2").x], [2, 502]);
    assert.equal((await move({ items: [] })).status, 400);
  });
});
