// A structure action includes its page-list write. A competing agent edit queued from the sidecar commit hook
// waits until that action finishes. Each action keeps its own undo step, with the boards and page list together.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("joingap");
process.env.CANVAS_ROOTS = dir;
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const { storeTestHooks } = await import("../src/widgets/store.ts");
const { currentDoc } = await import("../src/docwriter.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const docFiles: string[] = [];
after(() => {
  storeTestHooks.beforeCommit = undefined;
  for (const p of docFiles) fs.unwatchFile(p);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 7_000_000;
history.setClock(() => clock);
const later = (ms = 5000) => void (clock += ms);

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j: any = text;
  try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j };
}

const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "a", name: "A", x: 0, y: 0, width: 200, height: 100, fill: "#EEEEEE", children: [] },
    { type: "frame", id: "b", name: "B", x: 300, y: 0, width: 200, height: 100, fill: "#DDDDDD", children: [] },
    { type: "frame", id: "c", name: "C", x: 0, y: 300, width: 200, height: 100, fill: "#CCCCCC", children: [] },
  ],
};

async function setup(name: string) {
  const sub = path.join(dir, name);
  fs.mkdirSync(sub, { recursive: true });
  const docFile = path.join(sub, `${name}.canvas.json`);
  fs.writeFileSync(docFile, JSON.stringify(DOC, null, 2));
  const real = fs.realpathSync(docFile);
  docFiles.push(real);
  await call("POST", "/api/update", { file: real, id: "a", props: {} });
  const q = `?file=${encodeURIComponent(real)}`;
  assert.equal((await call("PUT", `/api/pages${q}`, { pages: [{ id: "p1", name: "One", boards: ["a", "b"] }, { id: "p2", name: "Two", boards: ["c"] }] })).status, 200);
  history.resetHistory();
  later();
  return { docFile: real, q, sidecar: real.replace(/\.canvas\.json$/, ".widgets.json") };
}

const topIds = (docFile: string) => (currentDoc(docFile).doc.children as any[]).map((n) => String(n.id));
const listed = (sidecar: string): string[] => JSON.parse(fs.readFileSync(sidecar, "utf8")).pages.flatMap((p: any) => p.boards);
const fillOf = (docFile: string, id: string) => (currentDoc(docFile).doc.children as any[]).find((n) => n.id === id)?.fill;

/** Start a competing request while the page list waits, then await it outside the compound action. */
function agentInGap(docFile: string, target: string) {
  let fired = false;
  let pending: ReturnType<typeof call> | undefined;
  storeTestHooks.beforeCommit = async (file) => {
    if (fired || !file.startsWith(path.dirname(docFile))) return;
    fired = true;
    pending = call("POST", "/api/update", { file: docFile, id: target, props: { fill: "#FF0000" } }, { "x-canvas-source": "mcp", "x-canvas-session": "gap-agent" });
  };
  return async () => {
    assert.ok(fired, "the agent request started in the gap");
    const r = await pending!;
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
}

describe("a structure op and its page-list write stay one undo step with competing edits", () => {
  for (const op of ["duplicate", "delete"] as const) {
    test(`${op} on page 2 with an agent's write queued in the gap: one step for the op and its listing, one for the agent`, async () => {
      const { docFile, q, sidecar } = await setup(`gap-${op}`);
      const sidecarBefore = fs.readFileSync(sidecar, "utf8");
      const docBefore = JSON.stringify(currentDoc(docFile).doc);
      const fired = agentInGap(docFile, "a");
      const r = await call("POST", "/api/structure", { file: docFile, op, ids: ["c"], page: "p2" });
      storeTestHooks.beforeCommit = undefined;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await fired();
      const steps = history.entries(docFile).undo;
      assert.deepEqual(steps.map((e) => e.label), [op === "duplicate" ? "Duplicate" : "Delete", "Agent Edits"], "the op (with its page list) and the agent's edit: two steps, nothing labelled like the op on its own");
      assert.ok(steps[0].ops.some((o) => o.t === "pages"), "the page list rides on the op's step");
      assert.ok(!steps[1].ops.some((o) => o.t === "pages"), "the agent's step holds only its own edit");
      // Undo the agent's edit: the op and its listing stay together.
      later();
      assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
      assert.equal(fillOf(docFile, "a"), "#EEEEEE");
      const ids = new Set(topIds(docFile));
      assert.deepEqual(listed(sidecar).filter((id) => !ids.has(id)), [], "no page lists an id the document lacks");
      if (op === "duplicate") assert.equal(topIds(docFile).length, 4);
      else assert.ok(!topIds(docFile).includes("c"));
      // Undo the op: document and sidecar back byte for byte.
      later();
      assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
      assert.equal(fs.readFileSync(sidecar, "utf8"), sidecarBefore, "the sidecar is back as it was");
      assert.equal(JSON.stringify(currentDoc(docFile).doc), docBefore, "the document is back as it was");
      // Redo both: the board and its listing come back together, then the agent's fill.
      later();
      assert.equal((await call("POST", `/api/history/redo${q}`)).status, 200);
      const again = new Set(topIds(docFile));
      assert.deepEqual(listed(sidecar).filter((id) => !again.has(id)), []);
      later();
      assert.equal((await call("POST", `/api/history/redo${q}`)).status, 200);
      assert.equal(fillOf(docFile, "a"), "#FF0000");
    });
  }

  test("a step in the gap that changes the same thing (the page list, a sibling's place): the follow-up stays a step of its own, so undo never jumps over it", () => {
    const docFile = path.join(dir, "history-only.canvas.json");
    history.resetHistory(docFile);
    const tree = (id: string): any => ({ t: "tree", kind: "insert", parent: null, index: 3, node: { type: "frame", id } });
    const pages = (b: string[], a: string[]): any => ({ t: "pages", b: [{ id: "p", boards: b }], a: [{ id: "p", boards: a }] });
    history.record(docFile, [tree("d")], { label: "Duplicate", mergeKey: "s1" });
    const join = history.joinTop(docFile)!;
    assert.equal(join.into, history.topSeq(docFile));
    history.record(docFile, [pages(["a"], ["a", "x"])], { label: "Agent", source: "mcp", session: "gap" });
    history.record(docFile, [pages(["a", "x"], ["a", "x", "d"])], join);
    assert.deepEqual(history.entries(docFile).undo.map((e) => e.label), ["Duplicate", "Agent Edits", "Duplicate"], "the page list changed above: no join");
    history.resetHistory(docFile);
    history.record(docFile, [tree("d")], { label: "Duplicate", mergeKey: "s2" });
    const join2 = history.joinTop(docFile)!;
    history.record(docFile, [{ t: "node", id: "q", props: { fill: { b: { v: "#000" }, a: { v: "#fff" } } } }], { label: "Agent", source: "mcp", session: "gap" });
    history.record(docFile, [pages(["a"], ["a", "d"])], join2);
    assert.deepEqual(history.entries(docFile).undo.map((e) => e.label), ["Duplicate", "Agent Edits"], "an unrelated edit above: the listing joins the op");
    history.resetHistory(docFile);
    history.record(docFile, [tree("d")], { label: "Duplicate", mergeKey: "s3" });
    const join3 = history.joinTop(docFile)!;
    history.record(docFile, [tree("e")], { label: "Agent", source: "mcp", session: "gap" });
    history.record(docFile, [tree("f")], join3);
    assert.equal(history.entries(docFile).undo.length, 3, "an insert among the same siblings above: no join (its index depends on the one above)");
    history.resetHistory(docFile);
  });
});
