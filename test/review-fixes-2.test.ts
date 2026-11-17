// The second review's server-side fixes (docs/evidence/review-fixes-2.md): canvas moves leave locked layers where
// they are (src/move.ts), find and replace still edits a locked text (a property), and the node schema
// keeps keys it does not know on a whole new node, with a warning, so files from a newer Canvas still paste.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { insertNode, unknownKeys, validateNode } from "../src/engine.ts";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("review2");
process.env.CANVAS_ROOTS = dir;
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B1", name: "Board", x: 0, y: 0, width: 400, height: 300, layout: "none", children: [
      { type: "rectangle", id: "Free", x: 10, y: 20, width: 50, height: 50, fill: "#FF0000" },
      { type: "rectangle", id: "Held", x: 100, y: 20, width: 50, height: 50, fill: "#00FF00", locked: true },
      { type: "frame", id: "Box", x: 200, y: 20, width: 120, height: 120, layout: "none", locked: true, children: [
        { type: "rectangle", id: "Inside", x: 10, y: 10, width: 20, height: 20, fill: "#0000FF" },
      ] },
      { type: "text", id: "Words", x: 10, y: 200, content: "Hello there", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000", locked: true },
    ] },
    { type: "frame", id: "B2", name: "Locked board", x: 600, y: 0, width: 200, height: 200, layout: "none", locked: true, children: [] },
  ],
};
const docFile = path.join(dir, "review2.canvas.json");
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

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, { method, headers: { "x-canvas": "1", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const move = (b: Record<string, unknown>, headers?: Record<string, string>) => call("POST", "/api/move", { file, ...b }, headers);
const find = (id: string) => {
  const seek = (ns: any[]): any => { for (const n of ns) { if (n.id === id) return n; const h = n.children && seek(n.children); if (h) return h; } };
  return seek(JSON.parse(fs.readFileSync(file, "utf8")).children);
};
const MCP = { "x-canvas-source": "mcp" };

beforeEach(async () => {
  fs.writeFileSync(file, JSON.stringify(DOC, null, 2));
  await call("POST", "/api/update", { file, id: "B1", props: {} });
  history.resetHistory();
});

describe("canvas moves leave locked layers where they are", () => {
  test("a user's move of several (arrows, align, tidy) skips the locked ones, by their own lock or a parent's", async () => {
    const r = await move({ items: [{ id: "Free", dx: 5 }, { id: "Held", dx: 5 }, { id: "Inside", dx: 5 }, { id: "B2", dx: 5 }], merge: "group:t1" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.moved.map((m: any) => m.id), ["Free"]);
    assert.deepEqual(r.body.skipped, [{ id: "Held", code: "locked" }, { id: "Inside", code: "locked" }, { id: "B2", code: "locked" }]);
    assert.deepEqual([find("Free").x, find("Held").x, find("Inside").x, find("B2").x], [15, 100, 10, 600]);
  });
  test("a user's move of one locked layer is refused; an agent's move_board still moves it", async () => {
    const r = await move({ id: "Held", dx: 1, merge: "nudge" });
    assert.deepEqual([r.status, r.body.code], [409, "locked"]);
    assert.equal(find("Held").x, 100);
    const m = await move({ id: "Held", x: 120 }, MCP);
    assert.equal(m.status, 200);
    assert.equal(find("Held").x, 120);
  });
  test("the inspector's X still moves a locked layer (its properties stay editable)", async () => {
    const r = await call("POST", "/api/update", { file, id: "Held", props: { x: 130 } });
    assert.equal(r.status, 200);
    assert.equal(find("Held").x, 130);
  });
  test("Repeat (.) of a nudge leaves a locked layer where it is", async () => {
    await move({ id: "Free", dx: 3, merge: "nudge" });
    const r = await call("POST", "/api/repeat", { file, ids: ["Held", "Free"] });
    assert.equal(r.status, 200);
    assert.deepEqual([find("Free").x, find("Held").x], [16, 100]);
  });
  test("find and replace edits a locked text layer: its content is a property, not a place on the canvas", async () => {
    const r = await call("POST", "/api/replace", { file, query: "there", replacement: "world" });
    assert.equal(r.status, 200);
    assert.equal(find("Words").content, "Hello world");
  });
});

describe("the schema keeps keys it does not know on a new node", () => {
  const future = { type: "rectangle", id: "N", width: 10, height: 10, fill: "#000000", glowRadius: 4 } as any;
  test("validateNode lets an unknown key through on a whole node; unknownKeys names it", () => {
    assert.deepEqual(validateNode(future), []);
    assert.deepEqual(unknownKeys(future), ['node N: "glowRadius" is a property this version of Canvas does not know; kept as it is']);
    assert.deepEqual(unknownKeys({ type: "frame", id: "F", children: [future] } as any).length, 1, "children too");
    assert.deepEqual(unknownKeys({ type: "ref", id: "I", ref: "C", anything: 1 } as any), [], "an instance takes any key");
  });
  test("a property write still refuses an unknown key; a key of another type is a mistake; children stay for frames and groups", () => {
    assert.equal(validateNode(future, { keys: ["glowRadius"] }).length, 1);
    assert.equal(validateNode({ type: "ellipse", id: "E", cornerSmoothing: 0.5 } as any).length, 1, "cornerSmoothing is a frame and rectangle key");
    assert.deepEqual(unknownKeys({ type: "ellipse", id: "E", cornerSmoothing: 0.5 } as any), [], "refused, not warned");
    assert.equal(validateNode({ type: "rectangle", id: "R", children: [] } as any).length, 1);
    assert.equal(validateNode({ type: "rectangle", id: "R", opacity: "lots" } as any).length, 1, "a known key's value is still checked");
  });
  test("insertNode keeps the key in the file", () => {
    const doc = { version: "2.21", children: [] } as any;
    insertNode(doc, null, structuredClone(future));
    assert.equal(doc.children[0].glowRadius, 4);
  });
  test("add_nodes and a paste of a payload from a newer Canvas keep the key and warn", async () => {
    const add = await call("POST", "/api/structure", { file, op: "add", nodes: [{ ...future, id: "Fut" }], place: { parent: "B1" } });
    assert.equal(add.status, 200);
    assert.equal(find("Fut").glowRadius, 4);
    assert.match(add.body.warnings[0], /"glowRadius" is a property this version of Canvas does not know/);
    const copy = await call("POST", "/api/structure", { file, op: "copy", ids: ["Fut"] });
    assert.equal(copy.status, 200);
    const paste = await call("POST", "/api/structure", { file, op: "paste", fromServer: true, place: { parent: "B1" } });
    assert.equal(paste.status, 200);
    const made = find(paste.body.select[0]);
    assert.equal(made.glowRadius, 4);
    assert.match(paste.body.warnings[0], /glowRadius/);
  });
});
