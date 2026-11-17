// Resizing from the canvas (src/resize.ts, POST /api/resize) and what the page needs to draw an undo before the
// server answers (src/history.ts: the history state's peek at the next step, and ?expect=<seq>).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("resize");
process.env.CANVAS_ROOTS = dir;
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B1", name: "Board one", x: 0, y: 0, width: 390, height: 844, layout: "none", children: [
      { type: "rectangle", id: "Abs", x: 10, y: 20, width: 50, height: 50, fill: "#FF0000" },
      { type: "text", id: "Txt", x: 100, y: 100, content: "Hello", fontSize: 14 },
    ] },
    { type: "frame", id: "B2", name: "Board two", x: 500, y: 100, width: 600, height: 300, layout: "vertical", children: [
      { type: "rectangle", id: "Flow", width: 50, height: 50, fill: "#00FF00" },
    ] },
  ],
};
const docFile = path.join(dir, "resize.canvas.json");
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

let clock = 9_000_000;
history.setClock(() => clock);

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = { "x-canvas": "1" }) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const resize = (b: Record<string, unknown>) => call("POST", "/api/resize", { file, ...b });
const q = `?file=${encodeURIComponent(file)}`;
const find = (id: string) => {
  const seek = (ns: any[]): any => { for (const n of ns) { if (n.id === id) return n; const h = n.children && seek(n.children); if (h) return h; } };
  return seek(JSON.parse(fs.readFileSync(file, "utf8")).children);
};

beforeEach(async () => {
  fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
  await call("POST", "/api/update", { file, id: "B1", props: {} }); // the first-write refusal after an outside change
  history.resetHistory();
  clock += 5000;
});

describe("POST /api/resize", () => {
  test("a board's size and position, with its children kept in place, in one undo step", async () => {
    const r = await resize({ id: "B1", props: { x: -20, width: 410 }, children: [{ id: "Abs", x: 30, y: 20 }, { id: "Txt", x: 120, y: 100 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.changed.sort(), ["Abs", "B1", "Txt"]);
    assert.equal(find("B1").x, -20);
    assert.equal(find("B1").width, 410);
    assert.equal(find("Abs").x, 30);
    const h = (await call("GET", `/api/history${q}`)).body;
    assert.equal(h.undo, "Resize");
    assert.equal(h.undoDepth, 1);
    // The page draws the undo from the peek: every node's values before the step.
    const ids = h.peek.undo.nodes.map((n: any) => n.id).sort();
    assert.deepEqual(ids, ["Abs", "B1", "Txt"]);
    assert.deepEqual(h.peek.undo.nodes.find((n: any) => n.id === "B1").set, { x: 0, width: 390 });
    const u = await call("POST", `/api/history/undo${q}&expect=${h.peek.undo.seq}`);
    assert.equal(u.status, 200);
    assert.equal(find("B1").x, 0);
    assert.equal(find("Abs").x, 10);
  });

  test("a resized text box becomes fixed; Resize to Fit is its own label", async () => {
    const r = await resize({ id: "Txt", props: { width: 80, textGrowth: "fixed-width" }, label: "Resize to Fit" });
    assert.equal(r.status, 200);
    assert.equal(find("Txt").textGrowth, "fixed-width");
    assert.equal((await call("GET", `/api/history${q}`)).body.undo, "Resize to Fit");
  });

  test("an auto-layout child keeps its place: x/y are dropped, the size is written", async () => {
    const r = await resize({ id: "Flow", props: { width: 80, x: 5 } });
    assert.equal(r.status, 200);
    assert.equal(find("Flow").width, 80);
    assert.equal(find("Flow").x, undefined);
  });

  test("fit_content sizes are allowed; anything but geometry is refused before reading", async () => {
    assert.equal((await resize({ id: "B2", props: { width: "fit_content", height: "fit_content" } })).status, 200);
    assert.equal(find("B2").height, "fit_content");
    for (const props of [{ fill: "#000" }, { width: -1 }, { width: "huge" }, { textGrowth: "wild" }]) {
      const r = await resize({ id: "B1", props });
      assert.equal(r.status, 400, JSON.stringify(props));
    }
    assert.equal((await resize({ id: "Ins/Child", props: { width: 10 } })).status, 400);
  });

  test("children must be direct children of the resized node; nothing is written otherwise", async () => {
    const r = await resize({ id: "B2", props: { width: 700 }, children: [{ id: "Abs", x: 0, y: 0 }] });
    assert.equal(r.status, 409);
    assert.equal(find("B2").width, 600);
  });

  test("forbidden without the page header", async () => {
    assert.equal((await call("POST", "/api/resize", { file, id: "B1", props: { width: 1 } }, {})).status, 403);
  });
});

describe("history peek and expect", () => {
  test("the peek is per direction: undo sets the before values, redo the after ones, removals listed", async () => {
    await call("POST", "/api/update", { file, id: "Abs", props: { height: 70 }, remove: ["fill"] });
    let h = (await call("GET", `/api/history${q}`)).body;
    assert.deepEqual(h.peek.undo.nodes, [{ id: "Abs", set: { height: 50, fill: "#FF0000" }, remove: [] }]);
    assert.equal(h.peek.redo, null);
    await call("POST", `/api/history/undo${q}`);
    h = (await call("GET", `/api/history${q}`)).body;
    assert.deepEqual(h.peek.redo.nodes, [{ id: "Abs", set: { height: 70 }, remove: ["fill"] }]);
  });

  test("expect refuses with 'moved' when another step is on top, and changes nothing", async () => {
    await call("POST", "/api/update", { file, id: "Abs", props: { height: 70 } });
    const seq = (await call("GET", `/api/history${q}`)).body.peek.undo.seq;
    clock += 5000;
    await call("POST", "/api/update", { file, id: "Abs", props: { width: 90 } });
    const r = await call("POST", `/api/history/undo${q}&expect=${seq}`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "moved");
    assert.equal(find("Abs").width, 90);
    assert.equal((await call("GET", `/api/history${q}`)).body.undoDepth, 2);
  });
});
