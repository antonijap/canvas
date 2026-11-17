// Bug hunt 2026-11-16, talk to the selection (src/agent-run.ts, src/threads.ts): a huge "Step N:" line, a run's Undo
// with another run's steps among its own, two sends at once, a harness switch keeping the other harness's session,
// a request body split inside a character, and an npm-installed harness that needs Node on its PATH.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("agent-hunt");
const bin = path.join(dir, "bin");
fs.mkdirSync(bin);
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_AGENT_PATH = bin;
process.env.CANVAS_AGENT_LOG = path.join(dir, "agent-runs.log");
// A stand-in for `claude` that takes a moment and ends well.
fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>{process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Summary: ok"})+"\\n");},300));\n`);
fs.chmodSync(path.join(bin, "claude"), 0o755);

const AR: any = await import("../src/agent-run.ts");
const TH = await import("../src/threads.ts");
const H = await import("../src/history.ts");
const { loadDoc } = await import("../src/engine.ts");

const docFile = path.join(dir, "hunt.canvas.json");
fs.writeFileSync(docFile, JSON.stringify({ version: "2.21", children: [
  { type: "frame", id: "A", name: "A", x: 0, y: 0, width: 100, height: 100, children: [] },
  { type: "frame", id: "B", name: "B", x: 200, y: 0, width: 100, height: 100, children: [] },
  { type: "frame", id: "C", name: "C", x: 400, y: 0, width: 100, height: 100, children: [] },
  { type: "frame", id: "D", name: "D", x: 600, y: 0, width: 100, height: 100, children: [] },
] }));
const file = fs.realpathSync(docFile);
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("bug hunt: talk to the selection", () => {
  test("1. a huge Step number neither grows the plan nor hangs the server", () => {
    const t = new AR.StepTracker();
    const at = Date.now();
    t.apply({ k: "text", text: "Plan: One | Two\nStep 100000: Way past the plan\nStep 0: Nothing\nStep 2: Two" });
    assert.ok(Date.now() - at < 200);
    assert.ok(t.plan.length <= 8, `plan has ${t.plan.length} steps`);
    assert.deepEqual(t.plan, ["One", "Two"]);
    assert.equal(t.current, 1);
  });

  test("2. a run's Undo refuses when another run's steps sit among its own, and undoes nothing", async () => {
    H.resetHistory();
    const op = (id: string, b: number, a: number) => [{ t: "node", id, props: { x: { b: { v: b }, a: { v: a } } } }] as any;
    H.record(file, op("A", 0, 1), { label: "e", source: "mcp", session: "run-a" });
    H.record(file, op("B", 200, 201), { label: "e", source: "mcp", session: "run-b" });
    H.record(file, op("A", 1, 2), { label: "e", source: "mcp", session: "run-a" });
    const seqs = H.entries(file).undo.filter((e) => e.agent?.session === "run-a").map((e) => e.seq);
    assert.equal(seqs.length, 2, "interleaved: run-a has two steps");
    const run = { id: "ra", prompt: "p", at: 1, status: "done" as const, steps: [], seqs };
    await TH.changeThreads(file, (l) => TH.withRun(l, { key: "A", ids: ["A"], name: "A", harness: "claude" }, run));
    await assert.rejects(AR.undoRun(file, "A", "ra"), (e: any) => e.code === "moved");
    assert.equal(H.entries(file).undo.length, 3, "nothing undone");
    assert.equal((await TH.readThreads(file)).find((t) => t.key === "A")!.runs[0].outcome, undefined, "not marked undone");
  });

  test("2. a run keeps every step it made, not only the last 20", () => {
    const seqs = Array.from({ length: 60 }, (_, i) => i + 1);
    const [t] = TH.cleanThreads([{ key: "A", ids: ["A"], name: "A", harness: "claude", runs: [{ id: "r", prompt: "p", at: 1, status: "done", steps: [], seqs }] }]);
    assert.equal(t.runs[0].seqs!.length, 60);
  });

  test("3. two sends at once start one run; never more than MAX_RUNS", async () => {
    const ctx = { docOf: () => { const l = loadDoc(file); return { doc: l.doc, boards: l.doc.children.map((n: any) => ({ id: n.id })) }; }, port: () => 1, version: () => "v", finish: async () => {} };
    const two = await Promise.allSettled([AR.startRun(ctx, { file, ids: ["C"], prompt: "one" }), AR.startRun(ctx, { file, ids: ["C"], prompt: "two" })]);
    assert.deepEqual(two.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal((two.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code, "busy");
    const more = await Promise.allSettled(["A", "B", "D"].map((id) => AR.startRun(ctx, { file, ids: [id], prompt: "x" })));
    assert.equal(AR.activeRuns().length, AR.MAX_RUNS);
    assert.equal(more.filter((r) => r.status === "fulfilled").length, AR.MAX_RUNS - 1);
    for (let i = 0; i < 100 && AR.activeRuns().length; i++) await new Promise((r) => setTimeout(r, 50));
  });

  test("10. switching harness never keeps the other harness's session", () => {
    const old = TH.withRun([], { key: "K", ids: ["K"], name: "K", harness: "claude", session: "claude-session" }, { id: "r1", prompt: "p", at: 1, status: "done", steps: [] });
    const next = TH.withRun(old, { key: "K", ids: ["K"], name: "K", harness: "codex" }, { id: "r2", prompt: "p", at: 2, status: "failed", steps: [] });
    const t = next.find((x) => x.key === "K")!;
    assert.equal(t.harness, "codex");
    assert.equal(t.session, undefined);
    const same = TH.withRun(old, { key: "K", ids: ["K"], name: "K", harness: "claude" }, { id: "r3", prompt: "p", at: 3, status: "done", steps: [] });
    assert.equal(same.find((x) => x.key === "K")!.session, "claude-session", "same harness: the session carries over");
  });

  test("21. a body split inside a character decodes whole", async () => {
    const bytes = Buffer.from(JSON.stringify({ prompt: "Café ☕ Zürich" }));
    const cut = bytes.indexOf(Buffer.from("é")) + 1;
    async function* chunks() { yield bytes.subarray(0, cut); yield bytes.subarray(cut); }
    assert.equal(typeof AR.jsonBody, "function");
    assert.deepEqual(await AR.jsonBody(chunks()), { prompt: "Café ☕ Zürich" });
  });

  test("22. the child's PATH has the server's Node (an npm-installed harness is a Node script)", () => {
    const env = AR.childEnv({ HOME: "/Users/me", PATH: "/secret/bin" }, "/Users/me/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js", "/Users/me/.local/share/mise/installs/node/24/bin/node");
    assert.ok(env.PATH.split(":").includes("/Users/me/.local/share/mise/installs/node/24/bin"), env.PATH);
    assert.ok(!env.PATH.includes("/secret/bin"));
  });
});
