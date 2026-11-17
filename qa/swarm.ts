// pnpm qa:swarm: exploratory QA by a swarm of agents (docs/qa-plan.md section 7). Runs only when a person types
// the command: nothing schedules it, and without --go it is a dry run that prints the plan and the exact prompts
// and spawns nothing, so a bare `pnpm qa:swarm` spends no tokens.
//
// With --go, each finder agent (claude -p or codex exec) gets its own scratch folder under the OS temp folder, a
// copy of its persona's fixture, its own Canvas server (the QA harness's scratch server), its own headless Chrome
// with the file open, the Canvas MCP server pointed at that server, and a `canvas` command (qa/swarm-tool.ts) to
// drive the page and record findings. Each agent runs under a wall-clock kill and, for Claude, a spend cap. Then
// the findings are deduped (feature + normalized title) and each goes to a verifier on a fresh scratch server (the
// other harness when mixed), which answers CONFIRMED or NOT_REPRODUCED. Output in qa/out/swarm/<timestamp>/:
// report.md (ranked by severity), findings.jsonl, scenarios.ts (a qa/scenarios.ts stub per confirmed finding),
// evidence/ and logs/. The scratch folders are removed at the end.
//
//   pnpm qa:swarm                                   dry run: plan and prompts for 10 agents
//   pnpm qa:swarm --go --agents 4 --area select     4 agents on the select area
//   pnpm qa:swarm --help                            every flag (qa/swarm-lib.ts USAGE)
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSynthetic } from "../bench/lib.ts";
import { launchChrome, type Chrome } from "../fidelity/cdp.ts";
import { loadCatalog } from "./catalog.ts";
import { coverage } from "./coverage.ts";
import { T } from "./harness.ts";
import { ROOT, copyDir, openTab, sleep, startServer, type Scratch } from "./lib.ts";
import { PLAYGROUND } from "./playground.ts";
import { OUT } from "./runner.ts";
import {
  FIXTURE_NAMES, USAGE, buildPlan, dedupe, modelFor, otherHarness, parseFindings, parseSwarmArgs, parseVerdict, scrubFinding,
  placeholderRuntime, rank, renderFinderPrompt, renderReport, renderScenarioStubs, renderVerifierPrompt,
  type AgentPlan, type AgentRun, type Fixture, type Group, type HarnessId, type Runtime, type SwarmOpts, type Tagged,
} from "./swarm-lib.ts";

const SWARM_OUT = path.join(OUT, "swarm");
const TOOL = path.join(ROOT, "qa", "swarm-tool.ts");
const MCP = path.join(ROOT, "mcp", "server.ts");
/** Kept from an agent's own output, per agent, in logs/. */
const LOG_MAX = 400_000;
/** Node for the MCP server and the agent's command: mise's major-version path when there is one (it survives patch
 *  upgrades), else this process's own. */
const NODE = (() => {
  const m = /^(.*\/installs\/node\/)(\d+)\.[\d.]+(\/bin\/node)$/.exec(process.execPath);
  const major = m ? `${m[1]}${m[2]}${m[3]}` : "";
  return major && fs.existsSync(major) ? major : process.execPath;
})();

// ---------------------------------------------------------------- what an agent may do

/** MCP tools a swarm agent must not call: they open, close or launch things outside its scratch file. */
export const MCP_OFF = ["launch_canvas", "open_file", "close_tab"];

/** Claude: no prompts (dontAsk denies anything not listed), only these tools, only the canvas MCP server. */
export function claudeArgs(model: string, budgetUsd: number, mcpConfig: string, tool: string): string[] {
  const allowed = [`Bash(${tool}:*)`, "Bash(curl:*)", "Bash(node:*)", "Bash(cat:*)", "Bash(ls:*)", "Bash(grep:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(jq:*)", "Bash(sleep:*)", "Read", "Grep", "Glob", "mcp__canvas"];
  return ["-p", "--model", model, "--output-format", "json", "--permission-mode", "dontAsk", "--allowedTools", ...allowed, "--disallowedTools", ...MCP_OFF.map((t) => `mcp__canvas__${t}`),
    "--mcp-config", mcpConfig, "--strict-mcp-config", "--setting-sources", "project", "--no-session-persistence", "--max-budget-usd", String(budgetUsd)];
}

/** Codex: its own config ignored (no other MCP servers), writes only in the scratch folder, network for localhost.
 *  The canvas MCP tools are approved up front (exec has nobody to ask, so they would all fail), except MCP_OFF. */
export function codexArgs(model: string | null, dir: string, port: number | string, lastMessage: string): string[] {
  const env = `{CANVAS_PORT="${port}",CANVAS_MCP_NO_SPAWN="1",CANVAS_MCP_NO_APP="1"}`;
  return ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true",
    "-c", `mcp_servers.canvas.command=${JSON.stringify(NODE)}`, "-c", `mcp_servers.canvas.args=[${JSON.stringify(MCP)}]`, "-c", `mcp_servers.canvas.env=${env}`,
    "-c", 'mcp_servers.canvas.default_tools_approval_mode="approve"', "-c", `mcp_servers.canvas.disabled_tools=${JSON.stringify(MCP_OFF)}`,
    "-C", dir, "-o", lastMessage, ...(model ? ["-m", model] : []), "-"];
}

/** The environment a harness runs in: the host session's Claude variables left out, so the CLI uses its own login. */
function harnessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC)/.test(k)) delete env[k];
  return env;
}

// ---------------------------------------------------------------- scratch Canvas per agent

export type Box = { dir: string; file: string; srv: Scratch; chrome: Chrome; rt: Runtime; mcpConfig: string; stop: () => Promise<void> };

const ERROR_RECORDER = `(() => { if (window.__swarmErrors) return; const xs = window.__swarmErrors = []; const keep = (s) => { if (xs.length < 200) xs.push(String(s).slice(0, 500)); };
  addEventListener("error", (e) => keep("exception: " + (e.error && e.error.stack || e.message)));
  addEventListener("unhandledrejection", (e) => keep("unhandled rejection: " + (e.reason && e.reason.stack || e.reason)));
  const ce = console.error; console.error = function (...a) { keep("console.error: " + a.map((x) => x && x.stack || (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")); return ce.apply(this, a); }; })();`;

function writeFixture(fixture: Fixture, file: string) {
  if (fixture === "big") {
    fs.mkdirSync(file, { recursive: true });
    writeSynthetic(path.join(file, "document.json"), 300, 30);
  } else copyDir(fixture === "sample" ? path.join(ROOT, "demos", "learn.canvas") : PLAYGROUND, file);
}

export async function openBox(root: string, id: string, fixture: Fixture, minutes: number): Promise<Box> {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  const file = path.join(dir, FIXTURE_NAMES[fixture]);
  writeFixture(fixture, file);
  const serverLog = path.join(dir, "server.log");
  let srv: Scratch | undefined, chrome: Chrome | undefined;
  const stop = async () => { await chrome?.stop().catch(() => {}); await srv?.stop().catch(() => {}); };
  try {
    srv = await startServer(dir);
    for (const s of [srv.proc.stdout, srv.proc.stderr]) s!.on("data", (d) => fs.appendFileSync(serverLog, d));
    fs.writeFileSync(serverLog, srv.log.join(""));
    chrome = await launchChrome();
    const tab = await openTab(chrome.port);
    await tab.page.send("Page.addScriptToEvaluateOnNewDocument", { source: ERROR_RECORDER });
    // T.open sets the window size and Reduce Motion for as long as this connection stays open (the agent's life).
    await new T(tab.page, file, srv).open();
    await tab.page.eval(ERROR_RECORDER);
    const deadline = Date.now() + minutes * 60_000;
    const tool = path.join(dir, "canvas");
    fs.writeFileSync(tool, `#!/bin/sh\nexec ${JSON.stringify(NODE)} ${JSON.stringify(TOOL)} --cdp ${chrome.port} --base ${srv.base} --dir ${JSON.stringify(dir)} --deadline ${deadline} "$@"\n`, { mode: 0o755 });
    const mcpConfig = path.join(dir, "mcp.json");
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { canvas: { command: NODE, args: [MCP], env: { CANVAS_PORT: String(srv.port), CANVAS_MCP_NO_SPAWN: "1", CANVAS_MCP_NO_APP: "1" } } } }, null, 1));
    const rt: Runtime = { repo: ROOT, dir, file, base: srv.base, tool, evidence: path.join(dir, "evidence"), serverLog, deadline: new Date(deadline).toLocaleTimeString("en-GB"), mcp: true };
    return { dir, file, srv, chrome, rt, mcpConfig, stop: async () => { tab.page.close(); await stop(); } };
  } catch (e) {
    await stop();
    throw e;
  }
}

// ---------------------------------------------------------------- one agent process

type Ran = { exit: number | null; timedOut: boolean; ms: number; text: string; costUsd: number | null; tokens: number | null; error?: string };
const live = new Set<number>();

function runHarness(h: HarnessId, prompt: string, box: Box, model: string | null, budgetUsd: number, minutes: number, logFile: string): Promise<Ran> {
  const last = path.join(box.dir, "last-message.txt");
  const [cmd, args] = h === "claude" ? ["claude", claudeArgs(model ?? "sonnet", budgetUsd, box.mcpConfig, box.rt.tool)] : ["codex", codexArgs(model, box.dir, box.srv.port, last)];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const kid = spawn(cmd, args, { cwd: box.dir, env: harnessEnv(), detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    kid.stdout!.on("data", (d) => { out += d; });
    kid.stderr!.on("data", (d) => { err += d; });
    kid.stdin!.end(prompt);
    if (kid.pid) live.add(kid.pid);
    // The hard wall-clock kill: the whole process group (the harness and the shells it started), never anything else.
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-kid.pid!, sig); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 5000).unref(); }, minutes * 60_000 + 30_000);
    kid.on("error", (e) => { err += `\nspawn ${cmd}: ${e.message}`; });
    kid.on("close", (code) => {
      clearTimeout(timer);
      if (kid.pid) live.delete(kid.pid);
      fs.writeFileSync(logFile, `$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n\n--- stdout\n${out.slice(-LOG_MAX)}\n--- stderr\n${err.slice(-LOG_MAX)}\n`);
      let text = out, costUsd: number | null = null, tokens: number | null = null, error: string | undefined;
      if (h === "claude") {
        try {
          const j = JSON.parse(out);
          text = String(j.result ?? "");
          costUsd = typeof j.total_cost_usd === "number" ? j.total_cost_usd : null;
          if (j.is_error) error = String(j.api_error ?? j.result ?? "error").slice(0, 200);
        } catch {}
      } else {
        try { text = fs.readFileSync(last, "utf8"); } catch {}
        const m = /tokens used\s*\n?\s*([\d,]+)/i.exec(err + out);
        if (m) tokens = Number(m[1].replace(/,/g, ""));
      }
      if (!error && code && !timedOut) error = (err.trim().split("\n").pop() ?? "").slice(0, 200);
      resolve({ exit: code, timedOut, ms: Date.now() - t0, text, costUsd, tokens, error });
    });
  });
}

// ---------------------------------------------------------------- the run

/** Catalog cases no scenario covers yet (as pnpm qa:coverage counts them), per feature: the prompts point at them. */
async function gapsByFeature(): Promise<Map<string, string[]>> {
  const m = new Map<string, string[]>();
  try {
    const { pairs } = await coverage();
    for (const p of pairs) if (p.state === "missing") m.set(p.feature, [...(m.get(p.feature) ?? []), p.case]);
  } catch (e) { console.log(`(prompts without coverage gaps: ${(e as Error).message.split("\n")[0]})`); }
  return m;
}

function dryRun(o: SwarmOpts, plan: AgentPlan[], gaps: Map<string, string[]>) {
  const root = path.join(os.tmpdir(), "canvas-swarm-<timestamp>");
  console.log(`DRY RUN: nothing is spawned and no tokens are spent. Add --go to run it.\n`);
  console.log(`${plan.length} finders, ${o.minutes} min each (killed after), Claude cap $${o.budgetUsd} per finder; then one verifier per deduped finding (${o.verifyMinutes} min, ${o.harness === "mix" ? "the other harness" : o.harness}).\n`);
  const pad = (s: string, k: number) => (s.length >= k ? s : s + " ".repeat(k - s.length));
  console.log(`${pad("AGENT", 26)}${pad("PERSONA", 24)}${pad("AREA", 13)}${pad("HARNESS", 16)}FIXTURE`);
  for (const p of plan) console.log(`${pad(p.id, 26)}${pad(p.persona.name, 24)}${pad(p.area, 13)}${pad(`${p.harness}${p.model ? ` (${p.model})` : ""}`, 16)}${FIXTURE_NAMES[p.persona.fixture]}`);
  for (const p of plan) {
    const dir = path.join(root, p.id);
    const rt = placeholderRuntime(ROOT, dir, FIXTURE_NAMES[p.persona.fixture]);
    const cmd = p.harness === "claude" ? ["claude", ...claudeArgs(p.model ?? "sonnet", p.budgetUsd ?? o.budgetUsd, `${dir}/mcp.json`, rt.tool)] : ["codex", ...codexArgs(p.model, dir, "<server-port>", `${dir}/last-message.txt`)];
    console.log(`\n${"=".repeat(100)}\n${p.id}\n$ ${cmd.map((a) => (/[\s"*()]/.test(a) ? `'${a}'` : a)).join(" ")} < prompt\n${"-".repeat(100)}\n${renderFinderPrompt(p, rt, gaps)}`);
  }
}

async function preflight(hs: Set<HarnessId>, claudeModel: string) {
  for (const h of hs) {
    try { execFileSync("which", [h], { stdio: "ignore" }); } catch { throw new Error(`${h} is not on PATH (use --harness ${h === "claude" ? "codex" : "claude"})`); }
  }
  // A tiny call, so a spent quota or a logged-out CLI stops the run before the servers start.
  if (hs.has("claude")) {
    let out = "";
    try {
      out = execFileSync("claude", ["-p", "--model", claudeModel, "--output-format", "json", "--strict-mcp-config", "--setting-sources", "project", "--no-session-persistence", "--max-budget-usd", "0.05"], { input: "Reply with the single word ok.", env: harnessEnv(), cwd: os.tmpdir(), timeout: 120_000, encoding: "utf8" });
    } catch (e) { out = String((e as { stdout?: string }).stdout ?? "") || (e as Error).message; }
    let why = "";
    try { const j = JSON.parse(out); if (j.is_error) why = String(j.result ?? j.api_error); } catch { why = out.split("\n")[0].slice(0, 200); }
    if (why) throw new Error(`claude cannot run: ${why} (use --harness codex)`);
  }
}

async function main() {
  let o: SwarmOpts;
  try { o = parseSwarmArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); process.exit(2); }
  if (o.help) { console.log(USAGE); return; }
  const cat = loadCatalog();
  const plan = buildPlan(o, cat.features);
  const gaps = await gapsByFeature();
  if (!o.go) return dryRun(o, plan, gaps);

  if (!fs.existsSync(path.join(ROOT, "engine", "pkg", "canvas_engine_bg.wasm"))) throw new Error("engine/pkg is missing: run engine/build.sh (the page needs the engine)");
  const verifierHarnesses = new Set(plan.map((p) => otherHarness(p.harness, o.harness)));
  await preflight(new Set([...plan.map((p) => p.harness), ...verifierHarnesses]), o.claudeModel);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.join(SWARM_OUT, stamp);
  fs.mkdirSync(path.join(out, "logs"), { recursive: true });
  fs.mkdirSync(path.join(out, "evidence"), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-swarm-"));
  // In-app agent runs (Spark, Make variations) find no harness on the scratch servers: a swarm agent cannot start
  // nested model runs through Canvas. Their logs stay in the scratch folder.
  fs.mkdirSync(path.join(root, "no-agents"));
  process.env.CANVAS_AGENT_PATH = path.join(root, "no-agents");
  process.env.CANVAS_AGENT_LOG = path.join(root, "agent-runs.log");
  const boxes = new Set<Box>();
  const cleanup = async () => {
    for (const pid of live) try { process.kill(-pid, "SIGKILL"); } catch {}
    await Promise.all([...boxes].map((b) => b.stop()));
    fs.rmSync(root, { recursive: true, force: true });
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, async () => { console.log("\nstopping: killing the agents, servers and Chromes this run started"); await cleanup(); process.exit(130); });
  console.log(`swarm ${stamp}: ${plan.length} finders, ${o.minutes} min each; output in ${path.relative(ROOT, out)}`);

  const runs: AgentRun[] = [];
  const rejected: string[] = [];
  const raw: Tagged[] = [];

  /** Evidence an agent named, copied out of its scratch folder; the finding then names the copy. */
  const keepEvidence = (box: Box, agent: string, name: string | undefined): string | undefined => {
    if (!name) return undefined;
    const src = [path.join(box.dir, "evidence", name), path.join(box.dir, "evidence", `${name}.png`), path.isAbsolute(name) ? name : ""].find((p) => p && p.startsWith(box.dir) && fs.existsSync(p) && fs.statSync(p).isFile());
    if (!src) return `${name} (not found)`;
    const dest = path.join(out, "evidence", agent, path.basename(src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return path.relative(out, dest);
  };

  // ------------------------------------------------ finders, all at once (staggered starts)
  await Promise.all(plan.map(async (p, i) => {
    await sleep(i * 1500);
    const base: AgentRun = { id: p.id, role: "finder", persona: p.persona.id, area: p.area, harness: p.harness, model: p.model, exit: null, timedOut: false, ms: 0, costUsd: null, tokens: null, findings: 0 };
    let box: Box | undefined;
    try {
      box = await openBox(root, p.id, p.persona.fixture, p.minutes);
      boxes.add(box);
      console.log(`${p.id}: started (${p.harness}, ${box.srv.base})`);
      const r = await runHarness(p.harness, renderFinderPrompt(p, box.rt, gaps), box, p.model, p.budgetUsd ?? o.budgetUsd, p.minutes, path.join(out, "logs", `${p.id}.log`));
      // The findings file the agent wrote with `canvas finding`, else its final message.
      let file = "";
      try { file = fs.readFileSync(path.join(box.dir, "findings.jsonl"), "utf8"); } catch {}
      const fromFile = parseFindings(file, cat), fromText = parseFindings(r.text, cat);
      const got = fromFile.findings.length ? fromFile : fromText;
      rejected.push(...fromText.errors.map((e) => `${p.id}: ${e}`));
      for (const f of got.findings) raw.push({ ...scrubFinding(f, { base: box.srv.base, file: box.file, dir: box.dir }), evidence: keepEvidence(box, p.id, f.evidence), agent: p.id, harness: p.harness, persona: p.persona.id, fixture: p.persona.fixture });
      runs.push({ ...base, exit: r.exit, timedOut: r.timedOut, ms: r.ms, costUsd: r.costUsd, tokens: r.tokens, findings: got.findings.length, error: r.error });
      console.log(`${p.id}: ${got.findings.length} findings in ${(r.ms / 60000).toFixed(1)} min${r.timedOut ? " (time box)" : ""}${r.error ? ` (${r.error})` : ""}`);
    } catch (e) {
      runs.push({ ...base, error: (e as Error).message.split("\n")[0] });
      console.log(`${p.id}: failed to start: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      if (box) { await box.stop(); boxes.delete(box); }
    }
  }));

  // ------------------------------------------------ verifiers, one per deduped finding
  const groups: Group[] = rank(dedupe(raw));
  console.log(`\n${raw.length} findings, ${groups.length} after dedupe; verifying`);
  const queue = [...groups];
  let vn = 0;
  await Promise.all(Array.from({ length: Math.min(plan.length, groups.length) }, async (_, w) => {
    await sleep(w * 1500);
    for (let g = queue.shift(); g; g = queue.shift()) {
      const f = g.finding;
      const h = otherHarness(f.harness, o.harness);
      const id = `v${String(++vn).padStart(2, "0")}-${f.feature}`;
      const base: AgentRun = { id, role: "verifier", persona: f.persona, area: f.area, harness: h, model: modelFor(h, o), exit: null, timedOut: false, ms: 0, costUsd: null, tokens: null, findings: 0 };
      let box: Box | undefined;
      try {
        box = await openBox(root, id, f.fixture, o.verifyMinutes);
        boxes.add(box);
        const r = await runHarness(h, renderVerifierPrompt(f, box.rt, o.verifyMinutes), box, modelFor(h, o), o.budgetUsd / 2, o.verifyMinutes, path.join(out, "logs", `${id}.log`));
        let v = null;
        try { v = parseVerdict(fs.readFileSync(path.join(box.dir, "verdict.json"), "utf8")); } catch {}
        v ??= parseVerdict(r.text);
        if (v) g.verdict = { ...v, evidence: keepEvidence(box, id, v.evidence), by: h, agent: id };
        else g.verifyError = r.timedOut ? "time box ran out" : r.error ?? "no verdict in the output";
        runs.push({ ...base, exit: r.exit, timedOut: r.timedOut, ms: r.ms, costUsd: r.costUsd, tokens: r.tokens, error: r.error });
        console.log(`${id}: ${v?.verdict ?? `no verdict (${g.verifyError})`}: ${f.title}`);
      } catch (e) {
        g.verifyError = (e as Error).message.split("\n")[0];
        runs.push({ ...base, error: g.verifyError });
      } finally {
        if (box) { await box.stop(); boxes.delete(box); }
      }
    }
  }));

  // ------------------------------------------------ report
  fs.writeFileSync(path.join(out, "findings.jsonl"), rank(groups).map((g) => JSON.stringify({ ...g.finding, reporters: g.all.map((x) => x.agent), verdict: g.verdict ?? null, verifyError: g.verifyError ?? null })).join("\n") + (groups.length ? "\n" : ""));
  fs.writeFileSync(path.join(out, "report.md"), renderReport({ stamp, opts: o, groups, rejected, runs, rawCount: raw.length }));
  fs.writeFileSync(path.join(out, "scenarios.ts"), renderScenarioStubs(stamp, groups, cat));
  await cleanup();
  const confirmed = groups.filter((g) => g.verdict?.verdict === "CONFIRMED").length;
  console.log(`\n${confirmed} confirmed of ${groups.length}. Report: ${path.relative(ROOT, path.join(out, "report.md"))}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { await main(); } catch (e) { console.error(`qa:swarm: ${(e as Error).message}`); process.exit(1); }
}
