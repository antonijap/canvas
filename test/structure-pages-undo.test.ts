// QA swarm finding: a structure op that puts a new board on a page (keepOnPage in src/structure.ts) wrote the page
// list as a change of its own, outside the undo step. Deleting a main component that instances still use parks it in
// a new hidden "Deleted components" board, listed on the component's page; Undo took the board out of the document
// but left its id in the page list, one more dangling id per delete and undo.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("structpages");
process.env.CANVAS_ROOTS = dir;
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const { currentDoc } = await import("../src/docwriter.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const docFiles: string[] = [];
after(() => {
  for (const p of docFiles) fs.unwatchFile(p);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 9_000_000;
history.setClock(() => clock);
const later = (ms = 5000) => void (clock += ms);

async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j: any = text;
  try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j };
}

const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "lay", name: "Layout", x: 0, y: 0, width: 400, height: 300, children: [
      { type: "ref", id: "inst", ref: "btn", x: 20, y: 20 },
    ] },
    { type: "frame", id: "cmp_main", name: "Main components", x: 0, y: 0, width: 400, height: 300, children: [
      { type: "frame", id: "btn", name: "Button", reusable: true, x: 20, y: 20, width: 100, height: 40, children: [] },
    ] },
  ],
};

async function setup(name: string) {
  const sub = path.join(dir, name);
  fs.mkdirSync(sub, { recursive: true });
  const docFile = path.join(sub, `${name}.canvas.json`);
  fs.writeFileSync(docFile, JSON.stringify(DOC, null, 2));
  const real = fs.realpathSync(docFile);
  docFiles.push(real);
  await call("POST", "/api/update", { file: real, id: "lay", props: {} });
  const q = `?file=${encodeURIComponent(real)}`;
  assert.equal((await call("PUT", `/api/pages${q}`, { pages: [{ id: "layout", name: "Layout", boards: ["lay"] }, { id: "components", name: "Components", boards: ["cmp_main"] }] })).status, 200);
  history.resetHistory();
  later();
  return { docFile: real, q, sidecar: real.replace(/\.canvas\.json$/, ".widgets.json") };
}

const topIds = (docFile: string) => (currentDoc(docFile).doc.children as any[]).map((n) => String(n.id));
const listed = (sidecar: string): string[] => JSON.parse(fs.readFileSync(sidecar, "utf8")).pages.flatMap((p: any) => p.boards);

describe("structure ops and the page list share one undo step", () => {
  test("delete a used main component's board, undo: the page list holds no id the document lacks; redo lists the holder again", async () => {
    const { docFile, q, sidecar } = await setup("cmpdel");
    const before = fs.readFileSync(sidecar, "utf8");
    for (let round = 0; round < 2; round++) {
      const r = await call("POST", "/api/structure", { file: docFile, op: "delete", ids: ["cmp_main"], page: "components" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const holder = topIds(docFile).find((id) => id !== "lay");
      assert.ok(holder, "the hidden Deleted components board exists");
      assert.equal(history.entries(docFile).undo.length, 1, "one undo step for the delete and its page listing");
      later();
      assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
      assert.deepEqual(topIds(docFile), ["lay", "cmp_main"]);
      const ids = new Set(topIds(docFile));
      assert.deepEqual(listed(sidecar).filter((id) => !ids.has(id)), [], "no dangling board ids after undo");
      assert.equal(fs.readFileSync(sidecar, "utf8"), before, "the sidecar is back as it was");
      later();
      assert.equal((await call("POST", `/api/history/redo${q}`)).status, 200);
      assert.deepEqual(topIds(docFile), ["lay", holder]);
      assert.ok(listed(sidecar).includes(holder!), "redo lists the holder on its page again");
      later();
      assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
      history.resetHistory();
      later();
    }
    assert.equal(fs.readFileSync(sidecar, "utf8"), before);
  });

  test("duplicate a board on page 2, undo: its copy leaves the page list too", async () => {
    const { docFile, q, sidecar } = await setup("dupe");
    const before = fs.readFileSync(sidecar, "utf8");
    assert.equal((await call("POST", "/api/structure", { file: docFile, op: "duplicate", ids: ["cmp_main"], page: "components" })).status, 200);
    assert.equal(topIds(docFile).length, 3);
    assert.equal(history.entries(docFile).undo.length, 1);
    later();
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    assert.equal(fs.readFileSync(sidecar, "utf8"), before);
  });
});

// QA swarm finding: nudge a board, open an empty page, Cmd+Z. The board came back selected on a page that does not
// draw it, and Backspace then deleted it from the other page.
describe("an undo of a change on another page", () => {
  test("the undo answer names the board of each layer it selects, so the page can show that page first", async () => {
    const { docFile, q } = await setup("undoboards");
    const u = await call("POST", "/api/structure", { file: docFile, op: "duplicate", ids: ["btn"], page: "components" });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    later();
    const r = await call("POST", `/api/history/undo${q}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.select, ["btn"]);
    assert.deepEqual(r.body.boards, { btn: "cmp_main" });
  });

  test("a delete sent from one page leaves layers on other pages alone", async () => {
    const { docFile } = await setup("offpage");
    const r = await call("POST", "/api/structure", { file: docFile, op: "delete", ids: ["cmp_main"], page: "layout" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "other_page");
    assert.deepEqual(topIds(docFile), ["lay", "cmp_main"]);
    const mixed = await call("POST", "/api/structure", { file: docFile, op: "delete", ids: ["inst", "btn"], page: "layout" });
    assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
    const left = JSON.stringify(currentDoc(docFile).doc);
    assert.ok(left.includes('"btn"'), "the layer on the other page stays");
    assert.ok(!left.includes('"inst"'), "the layer on this page goes");
  });
});
