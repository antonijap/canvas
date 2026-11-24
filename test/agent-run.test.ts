// Talk to the selection, the server half (src/agent-run.ts, src/threads.ts): the exact harness command lines and
// their tool limits, the environment the child gets, the ownership check, the stream parsers fed recorded lines,
// the steps, the summary, Claude Code first with Codex as the backup, thread storage in the sidecar, the palette's
// Recent asks, and one whole run through a fake harness.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  activeRuns, buildCommand, buildPrompt, childEnv, DENIED_TOOLS, fallBackTo, parseClaudeLine, parseCodexLine, pickHarness, startRun, StepTracker, summarize, toolLabel, untrusted,
  type AgentCtx, type AgentEvent, type HarnessInfo, type RunView,
} from "../src/agent-run.ts";
import type { Entry } from "../src/history.ts";
import { loadDoc } from "../src/engine.ts";
import { changeThreads, cleanThreads, readThreads, conversations, recentAsks, RUNS_KEPT, withOutcome, withRun, type Run, type Thread } from "../src/threads.ts";
import { tmpDir } from "./helpers.ts";

const FIX = fileURLToPath(new URL("./fixtures/agent/", import.meta.url));
const lines = (name: string) => fs.readFileSync(path.join(FIX, name), "utf8").split("\n").filter(Boolean);
const claude: HarnessInfo = { id: "claude", label: "Claude Code", path: "/Users/me/.local/bin/claude", real: "/Users/me/.local/share/claude/versions/2.1.318" };
const codex: HarnessInfo = { id: "codex", label: "Codex", path: "/Users/me/.local/bin/codex", real: "/Users/me/.codex/packages/standalone/current/bin/codex" };
const base = { mcpSession: "run-abc123", mcpConfigPath: "/tmp/canvas-agent/abc/mcp.json", node: "/usr/local/bin/node", port: 5189, serverVersion: "v1" };

describe("harness command lines", () => {
  test("Claude Code: no built-in tools, only our canvas MCP server, denied tools, no prompts, a session we name", () => {
    const c = buildCommand({ ...base, harness: claude, session: "8dcf92c2-dfed-4ce4-96dc-7f933eb3ada6", resume: false });
    assert.equal(c.cmd, claude.real, "runs the resolved binary, not the symlink");
    assert.deepEqual(c.args, [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--tools", "",
      "--mcp-config", "/tmp/canvas-agent/abc/mcp.json", "--strict-mcp-config",
      "--allowedTools", "mcp__canvas",
      "--disallowedTools", DENIED_TOOLS.map((t) => `mcp__canvas__${t}`).join(","),
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--restricted", "--disable-slash-commands", "--no-chrome",
      "--session-id", "8dcf92c2-dfed-4ce4-96dc-7f933eb3ada6",
    ]);
    const cfg = JSON.parse(c.mcpConfig!);
    assert.deepEqual(Object.keys(cfg.mcpServers), ["canvas"], "one MCP server, canvas");
    assert.equal(cfg.mcpServers.canvas.command, "/usr/local/bin/node");
    assert.match(cfg.mcpServers.canvas.args[0], /mcp\/server\.ts$/);
    assert.deepEqual(cfg.mcpServers.canvas.env, { CANVAS_MCP_SESSION: "run-abc123", CANVAS_PORT: "5189", CANVAS_MCP_NO_SPAWN: "1", CANVAS_MCP_NO_APP: "1", CANVAS_MCP_WANT_VERSION: "v1" });
    assert.ok(!c.args.some((a) => /make the padding/.test(a)), "the prompt is never in argv");
  });

  test("Claude Code follow-up resumes the session", () => {
    const c = buildCommand({ ...base, harness: claude, session: "s-1", resume: true });
    assert.deepEqual(c.args.slice(-2), ["--resume", "s-1"]);
    assert.ok(!c.args.includes("--session-id"));
  });

  test("Codex: read-only sandbox, approval never, shell and other tool families off, canvas MCP only, prompt on stdin", () => {
    const c = buildCommand({ ...base, harness: codex, resume: false, image: "/tmp/canvas-agent/abc/selection.png" });
    assert.equal(c.cmd, codex.real);
    assert.equal(c.mcpConfig, undefined);
    const a = c.args;
    assert.deepEqual(a.slice(0, 4), ["exec", "--sandbox", "read-only", "--json"]);
    for (const f of ["--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]) assert.ok(a.includes(f), f);
    const conf = a.flatMap((x, i) => (a[i - 1] === "-c" ? [x] : []));
    assert.ok(conf.includes(`mcp_servers.canvas.command="/usr/local/bin/node"`));
    assert.ok(conf.some((x) => x.startsWith("mcp_servers.canvas.args=[") && x.endsWith(`mcp/server.ts"]`)));
    assert.ok(conf.includes(`mcp_servers.canvas.env={CANVAS_MCP_SESSION="run-abc123",CANVAS_PORT="5189",CANVAS_MCP_NO_SPAWN="1",CANVAS_MCP_NO_APP="1",CANVAS_MCP_WANT_VERSION="v1"}`));
    assert.ok(conf.includes(`mcp_servers.canvas.disabled_tools=${JSON.stringify(DENIED_TOOLS)}`));
    for (const x of [`sandbox_mode="read-only"`, `approval_policy="never"`, `web_search="disabled"`]) assert.ok(conf.includes(x), x);
    const off = a.flatMap((x, i) => (a[i - 1] === "--disable" ? [x] : []));
    for (const f of ["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "computer_use", "browser_use", "hooks"]) assert.ok(off.includes(f), f);
    assert.deepEqual(a.slice(-3), ["-i", "/tmp/canvas-agent/abc/selection.png", "-"]);
  });

  test("Codex follow-up: exec resume <thread>", () => {
    const c = buildCommand({ ...base, harness: codex, session: "01a1e3d7", resume: true });
    assert.deepEqual(c.args.slice(0, 3), ["exec", "resume", "01a1e3d7"]);
    assert.equal(c.args.at(-1), "-");
  });

  test("the denied tools leave the selection alone: files, camera, selection, pages, widgets, history", () => {
    for (const t of ["open_file", "launch_canvas", "close_tab", "select_nodes", "clear_selection", "fit_view", "pan_view", "set_zoom", "delete_page", "set_page_background", "set_page_pattern", "add_widget", "undo", "redo", "wait_for_selection", "export_shader"]) assert.ok(DENIED_TOOLS.includes(t), t);
    for (const t of ["inspect_node", "set_node_props", "add_nodes", "render_node", "finish_work"]) assert.ok(!DENIED_TOOLS.includes(t), t);
  });

  test("the child's environment: a short PATH and the login basics, no keys or tokens", () => {
    const env = childEnv({ HOME: "/Users/me", USER: "me", PATH: "/opt/evil:/usr/bin", ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-y", FAL_KEY: "k", GITHUB_TOKEN: "t", LC_ALL: "en_US.UTF-8", TMPDIR: "/tmp/" }, claude.real, "/opt/node/bin/node");
    assert.deepEqual(env, { PATH: "/Users/me/.local/share/claude/versions:/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/me", USER: "me", TMPDIR: "/tmp/", LC_ALL: "en_US.UTF-8" });
  });

  test("only the person's own binary runs", () => {
    const dir = tmpDir("agent-own");
    const bin = path.join(dir, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
    assert.equal(untrusted(bin), null);
    fs.chmodSync(bin, 0o777);
    assert.equal(untrusted(bin), "writable by others");
    fs.chmodSync(bin, 0o644);
    assert.equal(untrusted(bin), "not executable");
    fs.chmodSync(bin, 0o755);
    assert.equal(untrusted(bin, 12345), "owned by someone else");
    assert.equal(untrusted(path.join(dir, "missing")), "missing");
  });
});

describe("Claude Code first, Codex the backup", () => {
  test("pickHarness", () => {
    assert.equal(pickHarness([codex, claude])?.id, "claude");
    assert.equal(pickHarness([codex])?.id, "codex");
    assert.equal(pickHarness([]), null);
    assert.equal(pickHarness([claude, codex], "codex")?.id, "codex", "a follow-up stays in its thread's harness");
    assert.equal(pickHarness([claude], "codex")?.id, "claude", "unless it is gone");
  });
  test("Codex steps in only when Claude Code failed before doing anything", () => {
    const failed = { tools: 0, ok: false as boolean | null, error: "You've hit your weekly limit" };
    assert.equal(fallBackTo("claude", failed, 0, false, [claude, codex])?.id, "codex");
    assert.equal(fallBackTo("claude", { ...failed, tools: 2 }, 0, false, [claude, codex]), null, "it had started working");
    assert.equal(fallBackTo("claude", failed, 1, false, [claude, codex]), null, "it had edited");
    assert.equal(fallBackTo("claude", failed, 0, true, [claude, codex]), null, "stopped by the person");
    assert.equal(fallBackTo("claude", failed, 0, false, [claude]), null, "no Codex");
    assert.equal(fallBackTo("codex", failed, 0, false, [claude, codex]), null, "Codex has no backup");
  });
});

describe("stream parsers on recorded lines", () => {
  const feed = (evs: AgentEvent[]) => { const t = new StepTracker(); for (const e of evs) t.apply(e); return t; };

  test("a run error or failed result gives terminal sign-in steps", () => {
    const text = "Not logged in · Please run /login";
    const hint = "Claude Code is not signed in. Open Terminal, run claude, sign in, then try again.";
    assert.equal(feed([{ k: "error", text }]).error, hint);
    assert.equal(feed([{ k: "result", ok: false, text }]).error, hint);
  });

  test("Claude Code at its usage limit: the session, then the error as the run's error", () => {
    const evs = lines("claude-limit.jsonl").flatMap(parseClaudeLine);
    assert.deepEqual(evs[0], { k: "session", id: "3f1c2b4e-1111-4222-8333-123456789abc" });
    assert.equal(evs[1].k, "error");
    assert.match((evs[1] as { text: string }).text, /weekly limit/);
    assert.deepEqual(evs[2], { k: "result", ok: false, text: "You've hit your weekly limit · resets Nov 17 at 11pm (Europe/Helsinki)" });
    const t = feed(evs);
    assert.equal(t.ok, false);
    assert.equal(t.error, "You've hit your weekly limit, resets Nov 17 at 11pm (Europe/Helsinki)", "no middots in the UI");
    assert.equal(t.tools, 0);
  });

  test("Claude Code run: the plan, steps moving on, tool calls, a tool error, the summary line", () => {
    const evs = lines("claude-run.jsonl").flatMap(parseClaudeLine);
    assert.deepEqual(evs.filter((e) => e.k === "tool").map((e) => (e as { name: string }).name), ["inspect_node", "set_node_props", "set_node_props", "finish_work"], "mcp__canvas__ is dropped");
    assert.equal(evs.filter((e) => e.k === "tool_error").length, 1);
    const t = new StepTracker();
    const seen: string[] = [];
    for (const e of evs) { t.apply(e); const n = t.now(); if (n) seen.push(`${n.index}/${n.total} ${n.label}`); }
    assert.deepEqual([...new Set(seen)], ["1/3 Read the row", "2/3 Padding 16 → 24", "3/3 Corners 8 → 12"]);
    assert.equal(t.finishCalled, true);
    assert.equal(t.ok, true);
    assert.equal(t.detail(), "Padding 16 → 24 and corners 8 → 12 on the row.");
    assert.deepEqual(t.steps("done").map((s) => s.state), ["done", "done", "done"]);
    assert.equal(t.session, "8dcf92c2-dfed-4ce4-96dc-7f933eb3ada6");
  });

  test("Codex run: thread id, MCP tool calls, a failed call, agent messages, the turn", () => {
    const evs = lines("codex-run.jsonl").flatMap(parseCodexLine);
    assert.deepEqual(evs[0], { k: "session", id: "01a1e3d9-f824-7970-8327-68cf55ebca5f" });
    assert.deepEqual(evs.filter((e) => e.k === "tool").map((e) => (e as { name: string }).name), ["lookup_nodes", "set_node_props"]);
    assert.deepEqual((evs.find((e) => e.k === "tool" && e.name === "set_node_props") as { input: unknown }).input, { file: "/x/playground.canvas", id: "al_row", props: { padding: 24, cornerRadius: 12 } });
    assert.equal(evs.filter((e) => e.k === "tool_error").length, 1);
    assert.deepEqual(evs.at(-1), { k: "result", ok: true });
    const t = feed(evs);
    assert.deepEqual(t.steps(), [{ label: "Inspect selected row", state: "done" }, { label: "Set padding and corners", state: "now" }]);
    assert.equal(t.detail(), "done");
  });

  test("no plan: one step per kind of tool call, in plain words", () => {
    const t = feed([{ k: "tool", name: "inspect_node", input: {} }, { k: "tool", name: "lookup_nodes", input: {} }, { k: "tool", name: "set_node_props", input: { props: { padding: 24, cornerRadius: 12 } } }]);
    assert.deepEqual(t.steps(), [{ label: "Reading the layers", state: "done" }, { label: "Setting padding, cornerRadius", state: "now" }]);
    assert.equal(toolLabel("render_node"), "Looking at it");
  });

  test("junk lines give nothing", () => {
    assert.deepEqual(parseClaudeLine("not json"), []);
    assert.deepEqual(parseCodexLine("{\"type\":\"turn.started\"}"), []);
  });
});

describe("prompt and summary", () => {
  test("the prompt names the file, the selection, the rules", () => {
    const p = buildPrompt({ message: "make the padding 24 and the corners 12", file: "/x/design.canvas.json", page: { id: "layout", name: "Layout" }, nodes: [{ id: "al_row", name: "Row (hug)", type: "frame", layers: 4 }], image: true, followUp: false });
    for (const s of ["File: /x/design.canvas.json", "Page: Layout", "Row (hug) (id al_row, frame, 4 layers)", "make the padding 24", "A picture of the selection", "finish_work once", "Plan:", "Step <n>:", "Summary:", 'Pass file "/x/design.canvas.json"']) assert.ok(p.includes(s), s);
    const f = buildPrompt({ message: "a bit less", file: "/x/design.canvas.json", nodes: [{ id: "al_row", name: "Row", type: "frame", layers: 1 }], image: false, followUp: true });
    assert.match(f, /^Follow-up on the same selection/);
  });
  test("summarize counts properties and layers from the run's entries", () => {
    const e = (ops: unknown[]) => ({ seq: 1, label: "Agent Edits", ops, at: 0, bytes: 0 }) as unknown as Entry;
    const s = summarize([e([{ t: "node", id: "a", props: { padding: {}, cornerRadius: {} } }, { t: "node", id: "b", props: { fill: {} } }]), e([{ t: "node", id: "a", props: { gap: {} } }])]);
    assert.equal(s?.line, "Changed 4 properties on 2 layers");
    assert.equal(summarize([e([{ t: "node", id: "a", props: { padding: {} } }])])?.line, "Changed 1 property on 1 layer");
    assert.equal(summarize([e([{ t: "tree", kind: "insert", parent: "a", index: 0, node: { id: "n", type: "rectangle" } }])])?.line, "Changed 1 structure change on 1 layer");
    assert.equal(summarize([]), null);
  });
});

describe("threads", () => {
  const run = (id: string, at: number, extra: Partial<Run> = {}): Run => ({ id, prompt: `ask ${id}`, at, status: "done", steps: [], ...extra });
  const t0 = { key: "al_row", ids: ["al_row"], name: "Row", harness: "claude" as const, session: "s1" };

  test("withRun keeps the last five runs of a layer and replaces a run by id", () => {
    let list: Thread[] = [];
    for (let i = 0; i < 7; i++) list = withRun(list, t0, run(`r${i}`, i), 100 + i);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].runs.map((r) => r.id), ["r2", "r3", "r4", "r5", "r6"]);
    assert.equal(RUNS_KEPT, 5);
    list = withRun(list, t0, run("r4", 4, { status: "stopped" }), 200);
    assert.deepEqual(list[0].runs.map((r) => `${r.id}:${r.status}`), ["r2:done", "r3:done", "r4:stopped", "r5:done", "r6:done"]);
    list = withOutcome(list, "al_row", "r6", "undone");
    assert.equal(list[0].runs.at(-1)!.outcome, "undone");
  });

  test("cleanThreads drops junk and marks a run cut off mid-way as stopped", () => {
    const list = cleanThreads([{ key: "a", runs: [{ id: "x", prompt: "p", at: 1, status: "running", steps: [{ label: "Doing", state: "now" }] }] }, { nope: 1 }, "x", { key: "b", runs: [] }]);
    assert.equal(list.length, 1);
    assert.equal(list[0].runs[0].status, "stopped");
    assert.equal(cleanThreads("nope").length, 0);
  });

  test("Recent asks: newest first, layer and page names now, gone layers left out", () => {
    const list: Thread[] = [
      { ...t0, key: "a", ids: ["a"], name: "Old name", createdAt: 1, updatedAt: 1, runs: [run("1", 10)] },
      { ...t0, key: "b", ids: ["b"], name: "B", createdAt: 1, updatedAt: 3, runs: [run("2", 5), run("3", 30, { endedAt: 40, prompt: "Make it calmer\nsecond line" })] },
      { ...t0, key: "gone", ids: ["gone"], name: "Gone", createdAt: 1, updatedAt: 9, runs: [run("4", 99)] },
    ];
    const names: Record<string, { name: string; board: string }> = { a: { name: "Pricing card", board: "B1" }, b: { name: "Hero", board: "B2" } };
    const asks = recentAsks(list, (id) => names[id] ?? null, (board) => (board === "B1" ? { id: "p1", name: "Final" } : null));
    assert.deepEqual(asks.map((a) => [a.key, a.prompt, a.name, a.pageName, a.at]), [["b", "Make it calmer", "Hero", null, 40], ["a", "ask 1", "Pricing card", "Final", 10]]);
  });

  test("Conversations: every run of every thread, newest first, with the layer now, going ones marked", () => {
    const list: Thread[] = [
      { ...t0, key: "a", ids: ["a"], name: "Old name", createdAt: 1, updatedAt: 1, runs: [run("1", 10), run("2", 50, { status: "failed", error: "boom" })] },
      { ...t0, key: "gone", ids: ["gone"], name: "Gone", createdAt: 1, updatedAt: 9, runs: [run("3", 30)] },
    ];
    const names: Record<string, { name: string; board: string }> = { a: { name: "Pricing card", board: "B1" } };
    const rows = conversations(list, (id) => names[id] ?? null, (board) => (board === "B1" ? { id: "p1", name: "Final" } : null), new Set(["2"]));
    assert.deepEqual(rows.map((r) => [r.run, r.name, r.gone, r.running, r.status, r.pageName]), [["2", "Pricing card", false, true, "running", "Final"], ["3", "Gone", true, false, "done", null], ["1", "Pricing card", false, false, "done", "Final"]]);
  });

  test("stored in the sidecar, not the .canvas.json, and read back", async () => {
    const dir = tmpDir("agent-threads");
    const docFile = path.join(dir, "demo.canvas.json");
    fs.writeFileSync(docFile, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "B", name: "Board", x: 0, y: 0, width: 10, height: 10 }] }));
    const before = fs.readFileSync(docFile, "utf8");
    await changeThreads(docFile, (l) => withRun(l, { ...t0, key: "B", ids: ["B"] }, run("r1", 1)));
    assert.equal(fs.readFileSync(docFile, "utf8"), before, "the .canvas.json is untouched");
    const side = JSON.parse(fs.readFileSync(path.join(dir, "demo.widgets.json"), "utf8"));
    assert.equal(side.threads[0].key, "B");
    assert.deepEqual((await readThreads(docFile)).map((t) => t.runs[0].id), ["r1"]);
  });
});

describe("a whole run through a fake harness", () => {
  const dir = tmpDir("agent-run");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const docFile = path.join(dir, "demo.canvas.json");
  fs.writeFileSync(docFile, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "B", name: "Board", x: 0, y: 0, width: 100, height: 100, children: [{ type: "frame", id: "Row", name: "Row (hug)", children: [{ type: "rectangle", id: "R1" }] }] }] }));
  // A stand-in for `claude`: reads the stream-json prompt, checks it, plays back the recorded run.
  const fake = path.join(bin, "claude");
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require("fs");let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const m=JSON.parse(s);const t=m.message.content.at(-1).text;if(!/Row \\(hug\\)/.test(t)||process.env.ANTHROPIC_API_KEY)process.exit(3);fs.writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))},JSON.stringify(process.argv.slice(2)));process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(FIX, "claude-run.jsonl"))},"utf8"));});\n`);
  fs.chmodSync(fake, 0o755);
  const log = path.join(dir, "agent-runs.log");
  const prev = { path: process.env.CANVAS_AGENT_PATH, log: process.env.CANVAS_AGENT_LOG, key: process.env.ANTHROPIC_API_KEY };
  after(() => {
    for (const [k, v] of [["CANVAS_AGENT_PATH", prev.path], ["CANVAS_AGENT_LOG", prev.log], ["ANTHROPIC_API_KEY", prev.key]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  test("streams steps, ends done, stores the thread, logs one line without the prompt's other lines", async () => {
    process.env.CANVAS_AGENT_PATH = bin;
    process.env.CANVAS_AGENT_LOG = log;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-reach-the-child";
    const finished: string[] = [];
    const ctx: AgentCtx = {
      docOf: () => { const l = loadDoc(docFile); return { doc: l.doc, boards: [{ id: "B" }] }; },
      port: () => 1, version: () => "v",
      finish: async (_f, s) => { finished.push(String(s)); },
    };
    const v = await startRun(ctx, { file: docFile, ids: ["Row"], prompt: "make the padding 24\nsecret second line" });
    assert.equal(v.status, "running");
    assert.equal(v.harness, "claude");
    let last: RunView | undefined;
    for (let i = 0; i < 100 && activeRuns().length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(activeRuns().length, 0, "the run ended");
    const t = (await readThreads(docFile)).find((x) => x.key === "Row")!;
    last = t.runs.at(-1) as unknown as RunView;
    assert.equal(t.harness, "claude");
    assert.equal(t.session, v.session, "the session we named, for --resume");
    assert.equal(last.status, "done");
    assert.deepEqual(last.steps.map((s) => s.label), ["Read the row", "Padding 16 → 24", "Corners 8 → 12"]);
    assert.equal(last.summary, "Nothing changed", "the fake made no edits through the MCP");
    assert.equal(last.detail, "Padding 16 → 24 and corners 8 → 12 on the row.");
    assert.equal(finished.length, 0, "nothing to gloss");
    const argv = JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"));
    assert.ok(argv.includes("--strict-mcp-config") && argv.includes("--session-id"));
    const logged = fs.readFileSync(log, "utf8");
    assert.match(logged, /harness=claude file=demo\.canvas\.json layers=1 status=done/);
    assert.match(logged, /prompt="make the padding 24"/);
    assert.doesNotMatch(logged, /secret second line/);
  });
});
