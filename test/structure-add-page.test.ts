// A board added through /api/structure op:add shows on the page the request names (the page the person looks at),
// the first page included, and in files whose pages are implicit. A board deleted (Backspace) or cut leaves its
// page's list, and Undo puts the list back byte for byte.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("structure-add-page");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_STATE_DIR = path.join(dir, "state-home");
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const boards = (n: number) => ({ version: "2.21", children: Array.from({ length: n }, (_, i) => ({ type: "frame", id: `B${i}`, name: `B${i}`, x: i * 500, y: 0, width: 400, height: 300, layout: "none", children: [] })) });
const make = (name: string, n: number) => {
  const p = path.join(dir, `${name}.canvas.json`);
  fs.writeFileSync(p, JSON.stringify(boards(n), null, 2));
  return fs.realpathSync(p);
};
const q = (file: string) => `?file=${encodeURIComponent(file)}`;
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
const pages = async (file: string) => (await call("GET", `/api/pages${q(file)}`)).body;
const pageOf = async (file: string, id: string) => ((await pages(file)).pages as any[]).find((p) => p.boards.includes(id))?.id;
/** The page lists as stored in the sidecar (not resolved): which page names the board. */
const storedPageOf = (file: string, id: string) => {
  const side = JSON.parse(fs.readFileSync(file.replace(/\.canvas\.json$/, ".widgets.json"), "utf8"));
  return (side.pages as any[]).find((p) => p.boards.includes(id))?.id;
};
const add = (file: string, id: string, page?: string) =>
  call("POST", "/api/structure", { file, op: "add", nodes: [{ type: "frame", id, name: id, x: 3000, y: 0, width: 200, height: 100, layout: "none", children: [] }], place: { parent: null }, ...(page ? { page } : {}) });

describe("structure add: the new board's page", () => {
  test("added on the first page, it is listed on the first page and stays there when the pages are reordered", async () => {
    const file = make("first", 2);
    await call("GET", `/api/doc${q(file)}`);
    assert.equal((await call("PUT", `/api/pages${q(file)}`, { pages: [{ id: "p1", name: "One", boards: ["B0"] }, { id: "p2", name: "Two", boards: ["B1"] }] })).status, 200);
    const r = await add(file, "N1", "p1");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await pageOf(file, "N1"), "p1", "shown on the first page");
    assert.equal(storedPageOf(file, "N1"), "p1", "listed on the first page");
    // Another page put first: the board stays where it was made.
    assert.equal((await call("PATCH", `/api/pages/p2${q(file)}`, { index: 0 })).status, 200);
    assert.equal(await pageOf(file, "N1"), "p1", "still on p1 after the reorder");
  });

  test("one undo takes the board and its listing on the first page back", async () => {
    const file = make("undo", 2);
    await call("GET", `/api/doc${q(file)}`);
    await call("PUT", `/api/pages${q(file)}`, { pages: [{ id: "p1", name: "One", boards: ["B0"] }, { id: "p2", name: "Two", boards: ["B1"] }] });
    assert.equal((await add(file, "N4", "p1")).status, 200);
    assert.equal(storedPageOf(file, "N4"), "p1");
    assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
    assert.equal(storedPageOf(file, "N4"), undefined, "undo takes it off the page list");
    assert.equal(await pageOf(file, "N4"), undefined, "and out of the document");
    assert.equal((await call("POST", `/api/history/redo${q(file)}`)).status, 200);
    assert.equal(storedPageOf(file, "N4"), "p1", "redo lists it again");
  });

  test("added on another page, it is listed there", async () => {
    const file = make("second", 2);
    await call("GET", `/api/doc${q(file)}`);
    await call("PUT", `/api/pages${q(file)}`, { pages: [{ id: "p1", name: "One", boards: ["B0"] }, { id: "p2", name: "Two", boards: ["B1"] }] });
    assert.equal((await add(file, "N2", "p2")).status, 200);
    assert.equal(await pageOf(file, "N2"), "p2");
    assert.equal(storedPageOf(file, "N2"), "p2");
  });

  test("a file with implicit pages shows it on its one page, and stays without stored pages", async () => {
    const file = make("implicit", 1);
    await call("GET", `/api/doc${q(file)}`);
    assert.equal((await add(file, "N3", "page-1")).status, 200);
    const v = await pages(file);
    assert.equal(v.implicit, true, "no pages written for a file without them");
    assert.equal(await pageOf(file, "N3"), "page-1");
    // A second page made later keeps it on the page it was made on.
    assert.equal((await call("POST", `/api/pages${q(file)}`, { name: "Two", index: 0 })).status, 201);
    assert.equal(await pageOf(file, "N3"), "page-1", "still on Page 1 after a page is put first");
  });

  const sidecar = (file: string) => fs.readFileSync(file.replace(/\.canvas\.json$/, ".widgets.json"), "utf8");
  const listed = (file: string): string[] => JSON.parse(sidecar(file)).pages.flatMap((p: any) => p.boards);

  test("an edit after a board delete is an undo step of its own (the delete's page listing does not swallow it)", async () => {
    const file = make("delete-then-edit", 3);
    await call("GET", `/api/doc${q(file)}`);
    await call("PUT", `/api/pages${q(file)}`, { pages: [{ id: "p1", name: "One", boards: ["B0", "B1"] }, { id: "p2", name: "Two", boards: ["B2"] }] });
    assert.equal((await call("POST", "/api/structure", { file, op: "delete", ids: ["B1"], page: "p1" })).status, 200);
    const h0 = (await call("GET", `/api/history${q(file)}`)).body;
    assert.equal((await call("POST", "/api/update", { file, id: "B0", props: { name: "Renamed meanwhile" } })).status, 200);
    const h1 = (await call("GET", `/api/history${q(file)}`)).body;
    assert.notEqual(JSON.stringify(h1.undo), JSON.stringify(h0.undo), `the rename joined the delete: ${JSON.stringify(h1)}`);
    // One undo takes the rename only; the next one the delete, with its listing.
    assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
    assert.ok(!listed(file).includes("B1"), "the first undo took the rename only");
    assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
    assert.ok(listed(file).includes("B1"), "the second undo brings the board and its listing back");
  });

  test("in a .canvas package too: an edit after a board delete is its own undo step", async () => {
    const pkg = path.join(dir, "play.canvas");
    fs.cpSync(path.join(import.meta.dirname, "..", "demos", "playground.canvas"), pkg, { recursive: true });
    const file = fs.realpathSync(pkg);
    await call("GET", `/api/doc${q(file)}`);
    const before = fs.readFileSync(path.join(file, "widgets.json"), "utf8");
    // Deleted, brought back by Undo (the toast's), deleted again: then a rename from elsewhere.
    assert.equal((await call("POST", "/api/structure", { file, op: "delete", ids: ["lay_clip"], page: "layout" })).status, 200);
    assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
    assert.equal(fs.readFileSync(path.join(file, "widgets.json"), "utf8"), before, "the first undo restores widgets.json");
    assert.equal((await call("POST", "/api/structure", { file, op: "delete", ids: ["lay_clip"], page: "layout" })).status, 200);
    const pagesNow = () => JSON.parse(fs.readFileSync(path.join(file, "widgets.json"), "utf8")).pages.flatMap((p: any) => p.boards);
    assert.ok(!pagesNow().includes("lay_clip"), "lay_clip left the Layout page's list");
    const h0 = (await call("GET", `/api/history${q(file)}`)).body;
    assert.equal((await call("POST", "/api/update", { file, id: "lay_nest", props: { name: "Renamed meanwhile" } })).status, 200);
    const h1 = (await call("GET", `/api/history${q(file)}`)).body;
    assert.notEqual(JSON.stringify(h1.undo), JSON.stringify(h0.undo), `the rename joined the delete: ${JSON.stringify(h0)} then ${JSON.stringify(h1)}`);
    assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
    assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
    assert.equal(fs.readFileSync(path.join(file, "widgets.json"), "utf8"), before, "widgets.json back byte for byte");
  });

  for (const [op, page, id] of [["delete", "p1", "B0"], ["delete", "p2", "B2"], ["cut", "p2", "B2"]] as const) {
    test(`${op} a board on ${page}: its id leaves the page list; undo restores the list byte for byte, redo takes it out again`, async () => {
      const file = make(`${op}-${page}`, 3);
      await call("GET", `/api/doc${q(file)}`);
      await call("PUT", `/api/pages${q(file)}`, { pages: [{ id: "p1", name: "One", boards: ["B0", "B1"] }, { id: "p2", name: "Two", boards: ["B2"] }] });
      const before = sidecar(file);
      const r = await call("POST", "/api/structure", { file, op, ids: [id], page });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(!listed(file).includes(id), `${id} is still listed after the ${op}: ${JSON.stringify(listed(file))}`);
      assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
      assert.equal(sidecar(file), before, "the sidecar is back as it was");
      assert.equal(await pageOf(file, id), page, "the board is back on its page");
      assert.equal((await call("POST", `/api/history/redo${q(file)}`)).status, 200);
      assert.ok(!listed(file).includes(id), "redo takes it off the list again");
    });
  }
});
