// Release checklist (docs/qa-plan.md section 8): an agent run keeps its tool allowlist, its time cap, its output cap
// and the cap on runs at once. A fake `claude` stands in for the person's harness (the same trick as agent-run.test.ts).
import { after, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { activeRuns, buildCommand, DENIED_TOOLS, MAX_RUNS, MOBBIN_TOOLS, OUTPUT_MAX, startRun, stopRun, type AgentCtx, type HarnessInfo } from "../src/agent-run.ts";
import { loadDoc } from "../src/engine.ts";
import { runCapMs, setAgentSettings } from "../src/settings.ts";
import { readThreads } from "../src/threads.ts";
import { tmpDir } from "./helpers.ts";

const claude: HarnessInfo = { id: "claude", label: "Claude Code", path: "/x/claude", real: "/x/claude" };
const codex: HarnessInfo = { id: "codex", label: "Codex", path: "/x/codex", real: "/x/codex" };
const base = { resume: false, mcpSession: "run-x", mcpConfigPath: "/tmp/mcp.json", node: "/usr/bin/node", port: 1, serverVersion: "v" };
// Tools that would let a run leave the canvas: read or write files, run commands, fetch pages.
const ESCAPES = ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "Glob", "Grep", "Task", "Agent"];

describe("tool allowlist", () => {
  const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  test("Claude Code: only Canvas MCP; a variations run adds Skill and WebSearch (and Mobbin's read tools), nothing that leaves the canvas", () => {
    for (const wide of [undefined, { deny: DENIED_TOOLS }, { deny: DENIED_TOOLS, mobbin: "https://mobbin.com/mcp" }]) {
      const { args, mcpConfig } = buildCommand({ ...base, harness: claude, wide });
      const tools = argOf(args, "--tools").split(",").filter(Boolean);
      const allowed = argOf(args, "--allowedTools").split(",");
      for (const t of [...tools, ...allowed]) assert.ok(!ESCAPES.includes(t), `${t} must not be granted`);
      assert.deepEqual(tools, wide ? ["Skill", "WebSearch"] : []);
      assert.ok(allowed.every((t) => t === "mcp__canvas" || t === "Skill" || t === "WebSearch" || MOBBIN_TOOLS.some((m) => t === `mcp__mobbin__${m}`)), allowed.join(","));
      assert.ok(args.includes("--strict-mcp-config") && args.includes("--restricted"));
      assert.equal(argOf(args, "--permission-mode"), "dontAsk");
      assert.deepEqual(Object.keys(JSON.parse(mcpConfig!).mcpServers).sort(), wide?.mobbin ? ["canvas", "mobbin"] : ["canvas"]);
      for (const t of DENIED_TOOLS) assert.ok(argOf(args, "--disallowedTools").split(",").includes(`mcp__canvas__${t}`));
    }
  });

  test("Codex: read-only sandbox, no shell, approval never, no user config", () => {
    for (const wide of [undefined, { deny: DENIED_TOOLS }]) {
      const { args } = buildCommand({ ...base, harness: codex, wide });
      const conf = args.filter((_, i) => args[i - 1] === "-c");
      const off = args.filter((_, i) => args[i - 1] === "--disable");
      assert.ok(conf.includes(`sandbox_mode="read-only"`) && conf.includes(`approval_policy="never"`));
      assert.ok(off.includes("shell_tool") && off.includes("unified_exec"));
      assert.ok(args.includes("--ignore-user-config") && args.includes("--ignore-rules"));
      assert.ok(conf.includes(wide ? `web_search="live"` : `web_search="disabled"`));
    }
  });
});

describe("run limits, through a fake harness", () => {
  const dir = tmpDir("release-agent");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const docFile = path.join(dir, "demo.canvas.json");
  const layers = ["L1", "L2", "L3", "L4"];
  fs.writeFileSync(docFile, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "B", name: "Board", x: 0, y: 0, width: 100, height: 100, children: layers.map((id) => ({ type: "rectangle", id, name: id })) }] }));
  // The fake reads its prompt, then does what the prompt's first word says: "flood" writes more than the output cap,
  // anything else sits there (until the cap or Stop kills it).
  const fake = path.join(bin, "claude");
  fs.writeFileSync(fake, `#!${process.execPath}
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
  const text = JSON.parse(s).message.content.at(-1).text;
  if (/flood/.test(text)) {
    const line = JSON.stringify({ type: "assistant", pad: "x".repeat(1024 * 1024) }) + "\\n";
    let n = 0;
    const more = () => { while (n < ${Math.ceil(OUTPUT_MAX / (1024 * 1024)) + 4}) { n++; if (!process.stdout.write(line)) return process.stdout.once("drain", more); } };
    more();
  }
  setInterval(() => {}, 1000);
});
`);
  fs.chmodSync(fake, 0o755);
  const prev = { path: process.env.CANVAS_AGENT_PATH, log: process.env.CANVAS_AGENT_LOG };
  process.env.CANVAS_AGENT_PATH = bin;
  process.env.CANVAS_AGENT_LOG = path.join(dir, "agent-runs.log");
  const pids: number[] = [];
  after(() => {
    for (const pid of pids) try { process.kill(-pid, "SIGKILL"); } catch {}
    for (const [k, v] of [["CANVAS_AGENT_PATH", prev.path], ["CANVAS_AGENT_LOG", prev.log]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ctx = (onSpawn?: () => void): AgentCtx => ({
    docOf: () => { const l = loadDoc(docFile); return { doc: l.doc, boards: [{ id: "B" }] }; },
    port: () => 1, version: () => "v",
    finish: async () => {},
    spawn: ((cmd: string, args: string[], opts: object) => {
      onSpawn?.();
      const c = spawn(cmd, args, opts as never);
      if (c.pid) pids.push(c.pid);
      return c;
    }) as never,
  });
  const ended = async (ms = 15_000) => {
    const t = Date.now();
    while (activeRuns().length && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50));
    assert.equal(activeRuns().length, 0, "every run ended");
  };
  const lastRun = async (key: string) => (await readThreads(docFile)).find((t) => t.key === key)!.runs.at(-1)!;

  test("output cap: a run that floods its output is stopped and says why", async () => {
    await startRun(ctx(), { file: docFile, ids: ["L1"], prompt: "flood" });
    await ended();
    const run = await lastRun("L1");
    assert.equal(run.status, "stopped");
    assert.equal(run.error, "Stopped: the agent wrote too much output");
  });

  test(`time cap: a run is stopped at the cap (${runCapMs() / 60_000} min by default), not before`, async () => {
    let started = false;
    await startRun(ctx(() => { mock.timers.enable({ apis: ["setTimeout"] }); started = true; }), { file: docFile, ids: ["L2"], prompt: "sit" });
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setImmediate(r));
    assert.ok(started, "the harness was started");
    try {
      const pid = pids.at(-1)!;
      mock.timers.tick(runCapMs() - 2000);
      assert.doesNotThrow(() => process.kill(pid, 0), "still running just before the cap");
      mock.timers.tick(2000);
    } finally {
      mock.timers.reset();
    }
    await ended();
    const run = await lastRun("L2");
    assert.equal(run.status, "stopped");
    assert.match(run.error ?? "", /^Stopped after 10 minutes$/);
  });

  test(`at most ${MAX_RUNS} runs at once, one per layer; Stop ends them`, async () => {
    const views = [];
    for (const id of layers.slice(0, MAX_RUNS)) views.push(await startRun(ctx(), { file: docFile, ids: [id], prompt: "sit" }));
    await assert.rejects(startRun(ctx(), { file: docFile, ids: [layers[MAX_RUNS]], prompt: "sit" }), /runs are going already/);
    for (const v of views) assert.ok(stopRun(v.id));
    await ended();
    await assert.rejects(Promise.all([startRun(ctx(), { file: docFile, ids: ["L1"], prompt: "sit" }), startRun(ctx(), { file: docFile, ids: ["L1"], prompt: "sit" })]), /has a run going/);
    for (const v of activeRuns()) stopRun(v.id);
    await ended();
  });

  test("a run asks for the model and reasoning level chosen in Settings > Agents", async () => {
    setAgentSettings({ harness: "claude", claude: { model: "opus", effort: "high" } });
    let seen: string[] = [];
    try {
      const c = ctx();
      const v = await startRun({ ...c, spawn: ((cmd: string, args: string[], opts: object) => { seen = args; return (c.spawn as any)(cmd, args, opts); }) as never }, { file: docFile, ids: ["L3"], prompt: "sit" });
      assert.equal(seen[seen.indexOf("--model") + 1], "opus", seen.join(" "));
      assert.equal(seen[seen.indexOf("--effort") + 1], "high", seen.join(" "));
      assert.ok(v.id);
      for (let i = 0; i < 100 && !activeRuns().length; i++) await new Promise((r) => setTimeout(r, 20));
      for (const r of activeRuns()) stopRun(r.id);
      await ended();
    } finally {
      setAgentSettings({});
    }
  });
});
