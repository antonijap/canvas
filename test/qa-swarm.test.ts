// pnpm qa:swarm's pure parts (qa/swarm-lib.ts): flags and the dry-run default, the plan, the prompts, the findings
// contract, dedupe, ranking, the report and the scenario stubs. Nothing here spawns an agent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../qa/catalog.ts";
import { claudeArgs, codexArgs } from "../qa/swarm.ts";
import {
  MAX_AGENTS, PERSONAS, buildPlan, checkFinding, dedupe, guessCover, normalizeTitle, otherHarness, parseFindings, parseSwarmArgs,
  parseVerdict, placeholderRuntime, rank, renderFinderPrompt, renderReport, renderScenarioStubs, renderVerifierPrompt, scrubFinding,
  type Finding, type Group, type Tagged,
} from "../qa/swarm-lib.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cat = loadCatalog();

const finding = (over: Partial<Finding> = {}): Finding => ({
  title: "Undo after a page switch restores the wrong page", area: "history", feature: "undo-redo",
  steps: ["canvas key 2 shift", "canvas key z meta"], expected: "the move is undone", actual: "nothing changes", severity: "high", ...over,
});
const tagged = (over: Partial<Tagged> = {}): Tagged => ({ ...finding(), agent: "a01-keyboard-history", harness: "claude", persona: "keyboard", fixture: "playground", ...over });

describe("swarm flags", () => {
  test("a bare run is a dry run with the defaults", () => {
    const o = parseSwarmArgs([]);
    assert.equal(o.go, false);
    assert.equal(o.agents, 10);
    assert.equal(o.harness, "mix");
    assert.equal(o.minutes, 20);
    assert.equal(o.verifyMinutes, 10);
    assert.equal(o.claudeModel, "sonnet");
  });
  test("only --go spawns, and --dry-run wins over it", () => {
    assert.equal(parseSwarmArgs(["--go"]).go, true);
    assert.equal(parseSwarmArgs(["--go", "--dry-run"]).go, false);
    assert.equal(parseSwarmArgs(["--dry-run", "--go"]).go, false);
  });
  test("limits and choices", () => {
    assert.equal(parseSwarmArgs(["--agents", String(MAX_AGENTS)]).agents, MAX_AGENTS);
    assert.throws(() => parseSwarmArgs(["--agents", String(MAX_AGENTS + 1)]), /--agents/);
    assert.throws(() => parseSwarmArgs(["--agents", "0"]), /--agents/);
    assert.throws(() => parseSwarmArgs(["--agents", "2.5"]), /whole/);
    assert.throws(() => parseSwarmArgs(["--harness", "gemini"]), /--harness/);
    assert.throws(() => parseSwarmArgs(["--claude-model", "fable"]), /sonnet or opus/);
    assert.throws(() => parseSwarmArgs(["--persona", "robot"]), /--persona/);
    assert.throws(() => parseSwarmArgs(["--minutes"]), /needs a value/);
    assert.throws(() => parseSwarmArgs(["--bogus"]), /unknown flag/);
    assert.equal(parseSwarmArgs(["--minutes", "4"]).verifyMinutes, 4);
    assert.equal(parseSwarmArgs(["--minutes", "30", "--verify-minutes", "12"]).verifyMinutes, 12);
  });
  test("pnpm qa:swarm with no flags prints a dry run and spawns nothing", () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, "qa/swarm.ts"), "--agents", "2", "--area", "select"], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });
    assert.match(out, /^DRY RUN: nothing is spawned/m);
    assert.match(out, /a01-designer-select/);
    assert.match(out, /\$ claude -p --model sonnet/);
    assert.match(out, /\$ codex exec/);
    assert.match(out, /a02-agent-select/);
    assert.match(out, /## Persona: Agent-heavy user/);
  });
});

describe("swarm plan", () => {
  test("the first agents cover every area once, personas take turns, harnesses alternate", () => {
    const areas = [...new Set(cat.features.map((f) => f.area))];
    const plan = buildPlan(parseSwarmArgs(["--agents", "20"]), cat.features);
    assert.equal(plan.length, 20);
    assert.deepEqual(new Set(plan.slice(0, areas.length).map((p) => p.area)), new Set(areas));
    assert.equal(new Set(plan.map((p) => `${p.persona.id}/${p.area}`)).size, 20, "no pair twice");
    assert.ok(new Set(plan.slice(0, 5).map((p) => p.persona.id)).size >= 4, "personas vary");
    assert.deepEqual(plan.slice(0, 4).map((p) => p.harness), ["claude", "codex", "claude", "codex"]);
    assert.ok(plan.every((p) => p.features.length && p.features.every((f) => f.area === p.area)));
    assert.equal(plan[0].budgetUsd, 3);
    assert.equal(plan[1].budgetUsd, null, "codex has no spend cap");
  });
  test("--area and --persona narrow it; more agents than pairs repeat the pairs", () => {
    const plan = buildPlan(parseSwarmArgs(["--agents", "7", "--area", "move"]), cat.features);
    assert.ok(plan.every((p) => p.area === "move"));
    assert.equal(new Set(plan.slice(0, 5).map((p) => p.persona.id)).size, 5);
    assert.equal(plan[5].persona.id, plan[0].persona.id);
    const one = buildPlan(parseSwarmArgs(["--agents", "3", "--persona", "a11y", "--harness", "codex"]), cat.features);
    assert.ok(one.every((p) => p.persona.id === "a11y" && p.harness === "codex" && p.model === null));
    assert.throws(() => buildPlan(parseSwarmArgs(["--area", "nowhere"]), cat.features), /no area "nowhere"/);
  });
  test("verifiers use the other harness only when mixed", () => {
    assert.equal(otherHarness("claude", "mix"), "codex");
    assert.equal(otherHarness("codex", "mix"), "claude");
    assert.equal(otherHarness("codex", "codex"), "codex");
  });
});

describe("swarm prompts", () => {
  const plan = buildPlan(parseSwarmArgs(["--agents", "3", "--area", "select", "--persona", "keyboard"]), cat.features);
  const rt = placeholderRuntime("/repo", "/tmp/s/a01", "Playground.canvas");
  test("a finder prompt has the persona, the area's catalog, the ways to drive Canvas, the rules and the contract", () => {
    const s = renderFinderPrompt(plan[0], rt, new Map([["marquee", ["nested"]]]));
    assert.match(s, /## Persona: Keyboard-only user/);
    assert.match(s, /## Your area: select/);
    for (const f of cat.features.filter((x) => x.area === "select")) assert.ok(s.includes(`\`${f.id}\``), f.id);
    assert.match(s, /`marquee`.*No test yet for: nested\./);
    assert.match(s, /\/tmp\/s\/a01\/canvas/);
    assert.match(s, /api\/flush/);
    assert.match(s, /attached as `canvas`/);
    assert.match(s, /~\/Desktop or ~\/Documents/);
    assert.match(s, /"severity": "critical\|high\|medium\|low"/);
    assert.match(s, /FINDINGS[\s\S]*END_FINDINGS/);
    assert.doesNotMatch(s, /\u2014/, "no em dashes");
  });
  test("a verifier prompt replays the steps and asks for a verdict", () => {
    const s = renderVerifierPrompt(finding(), rt, 7);
    assert.match(s, /1\. canvas key 2 shift\n2\. canvas key z meta/);
    assert.match(s, /CONFIRMED/);
    assert.match(s, /NOT_REPRODUCED/);
    assert.match(s, /You have 7 minutes/);
  });
});

describe("swarm findings", () => {
  test("the contract: required fields, severities, steps as a list or numbered lines", () => {
    assert.equal(checkFinding(finding()).ok, true);
    const r = checkFinding({ ...finding(), steps: "1. open\n2) press Z\n" });
    assert.ok(r.ok && r.finding.steps.length === 2 && r.finding.steps[1] === "press Z");
    const bad = checkFinding({ title: "x", severity: "urgent" });
    assert.ok(!bad.ok && /area is required/.test(bad.error) && /steps/.test(bad.error) && /severity/.test(bad.error));
    assert.equal(checkFinding({ ...finding(), severity: "HIGH" }).ok, true);
  });
  test("checked against the catalog when given", () => {
    assert.equal(checkFinding(finding(), cat).ok, true);
    const nf = checkFinding(finding({ feature: "teleport" }), cat);
    assert.ok(!nf.ok && /not in qa\/features.yaml/.test(nf.error));
    const nc = checkFinding({ ...finding(), case: "upside-down" }, cat);
    assert.ok(!nc.ok && /not a case of undo-redo/.test(nc.error));
  });
  test("parsed from a final message: JSON lines, fences and bullets, bad lines reported", () => {
    const text = ["Here is what I found.", "FINDINGS", "```", JSON.stringify(finding()), `- ${JSON.stringify(finding({ title: "Second" }))}`, '{"title": "broken", ', "```", "END_FINDINGS", '{"verdict": "x"}'].join("\n");
    const r = parseFindings(text, cat);
    assert.deepEqual(r.findings.map((f) => f.title), ["Undo after a page switch restores the wrong page", "Second"]);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /not JSON/);
    assert.deepEqual(parseFindings("NO_FINDINGS"), { findings: [], errors: [] });
  });
  test("verdicts: the last valid one wins", () => {
    assert.equal(parseVerdict("nothing"), null);
    const v = parseVerdict('{"verdict": "confirmed", "notes": "a"}\nthen\n{"verdict": "NOT_REPRODUCED", "notes": "b", "evidence": "x.png"}\n{"verdict": "maybe"}');
    assert.deepEqual(v, { verdict: "NOT_REPRODUCED", notes: "b", evidence: "x.png" });
  });
  test("an agent's server, file and folder become placeholders, so the steps replay anywhere", () => {
    const dir = "/var/folders/T/canvas-swarm-ab/a01", file = `${dir}/Playground.canvas`, base = "http://127.0.0.1:61674";
    const f = scrubFinding(tagged({ steps: [`POST ${base}/api/history/undo?file=${encodeURIComponent(file)}`, `cat /private${file}/widgets.json`, `${dir}/canvas key z meta`], actual: `${file} kept a page` }), { base, file, dir });
    assert.deepEqual(f.steps, ["POST <base>/api/history/undo?file=<file-url>", "cat <file>/widgets.json", "<dir>/canvas key z meta"]);
    assert.equal(f.actual, "<file> kept a page");
    assert.equal(f.agent, "a01-keyboard-history", "tags stay");
  });
});

describe("swarm harness command lines", () => {
  test("Claude: no prompts, an allowlist, only the canvas MCP server, a spend cap, the launch tools off", () => {
    const a = claudeArgs("sonnet", 2, "/s/mcp.json", "/s/canvas");
    for (const x of ["dontAsk", "--strict-mcp-config", "--no-session-persistence", "Bash(/s/canvas:*)", "mcp__canvas", "mcp__canvas__launch_canvas", "mcp__canvas__open_file"]) assert.ok(a.includes(x), x);
    assert.equal(a[a.indexOf("--max-budget-usd") + 1], "2");
    assert.ok(!a.includes("Write") && !a.includes("Edit") && !a.includes("Bash"), "no file writes, no open shell");
  });
  test("Codex: no user config, sandboxed to the scratch folder, canvas tools approved, the launch tools off", () => {
    const a = codexArgs(null, "/s", 5000, "/s/last.txt").join(" ");
    for (const x of ["--ignore-user-config", "--ephemeral", "-s workspace-write", "sandbox_workspace_write.network_access=true", 'CANVAS_PORT="5000"', "default_tools_approval_mode=\"approve\"", 'disabled_tools=["launch_canvas","open_file","close_tab"]', "-C /s", "-o /s/last.txt"]) assert.ok(a.includes(x), x);
    assert.ok(!a.includes("danger"), "never bypasses the sandbox");
    assert.ok(!a.includes(" -m "), "Codex's own default model");
    assert.ok(codexArgs("gpt-x", "/s", 1, "/l").join(" ").includes("-m gpt-x"));
  });
});

describe("swarm dedupe and ranking", () => {
  test("normalized titles ignore case, punctuation, filler words and word order", () => {
    assert.equal(normalizeTitle("Undo, after a page switch: restores the WRONG page!"), normalizeTitle("undo restores wrong page after page switch"));
    assert.notEqual(normalizeTitle("Undo restores wrong page"), normalizeTitle("Redo restores wrong page"));
  });
  test("same feature and title are one group, led by the most severe report", () => {
    const gs = dedupe([
      tagged({ severity: "medium", agent: "a01" }),
      tagged({ title: "undo restores the wrong page after page switch", severity: "critical", agent: "a02" }),
      tagged({ feature: "nudge", agent: "a03" }),
      tagged({ title: "Something else", agent: "a04" }),
    ]);
    assert.equal(gs.length, 3);
    const g = gs.find((x) => x.all.length === 2)!;
    assert.equal(g.finding.agent, "a02");
    assert.equal(g.finding.severity, "critical");
  });
  test("ranked by severity, then confirmed before unverified before not reproduced, then reporters", () => {
    const mk = (title: string, severity: Finding["severity"], verdict: "CONFIRMED" | "NOT_REPRODUCED" | null, n = 1): Group => {
      const f = tagged({ title, severity });
      return { key: title, finding: f, all: Array(n).fill(f), ...(verdict ? { verdict: { verdict, notes: "", by: "codex" as const, agent: "v" } } : {}) };
    };
    const order = rank([mk("low", "low", "CONFIRMED"), mk("high-no", "high", "NOT_REPRODUCED"), mk("high-yes", "high", "CONFIRMED"), mk("high-open", "high", null), mk("crit", "critical", null), mk("high-yes-2", "high", "CONFIRMED", 3)]);
    assert.deepEqual(order.map((g) => g.finding.title), ["crit", "high-yes-2", "high-yes", "high-open", "high-no", "low"]);
  });
});

describe("swarm report and stubs", () => {
  const confirmed: Group = { key: "k", finding: tagged({ severity: "high", evidence: "evidence/a01/undo.png" }), all: [tagged(), tagged({ agent: "a07" })], verdict: { verdict: "CONFIRMED", notes: "Saw it twice.", by: "codex", agent: "v01-undo-redo" } };
  const refuted: Group = { key: "r", finding: tagged({ title: "Nudge moves 2 px", feature: "nudge", severity: "low" }), all: [tagged()], verdict: { verdict: "NOT_REPRODUCED", notes: "Moves 1 px.", by: "claude", agent: "v02-nudge" } };
  test("the report lists confirmed findings first, with steps, verifier and agents", () => {
    const md = renderReport({ stamp: "2026-11-16T10-00-00", opts: parseSwarmArgs(["--agents", "2"]), groups: [refuted, confirmed], rejected: ["a03: severity: want critical, high, medium, low: {...}"], rawCount: 3,
      runs: [{ id: "a01-keyboard-history", role: "finder", persona: "keyboard", area: "history", harness: "claude", model: "sonnet", exit: 0, timedOut: false, ms: 240000, costUsd: 0.42, tokens: null, findings: 2 },
        { id: "v01-undo-redo", role: "verifier", persona: "keyboard", area: "history", harness: "codex", model: null, exit: null, timedOut: true, ms: 600000, costUsd: null, tokens: 51234, findings: 0 }] });
    assert.ok(md.indexOf("## Confirmed") < md.indexOf("[high] Undo after a page switch") && md.indexOf("[high] Undo after a page switch") < md.indexOf("## Not reproduced"));
    assert.match(md, /3 findings reported, 2 after dedupe: 1 confirmed, 1 not reproduced, 0 without a verdict\. 1 lines refused/);
    assert.match(md, /Found by: a01-keyboard-history \(claude, keyboard\); also a07/);
    assert.match(md, /Verifier \(codex, v01-undo-redo\): CONFIRMED\. Saw it twice\./);
    assert.match(md, /  1\. canvas key 2 shift/);
    assert.match(md, /\[low\] Nudge moves 2 px \(`nudge`, a01-keyboard-history\): Moves 1 px\./);
    assert.match(md, /\| v01-undo-redo \| verifier .* \| time box \| 10\.0 min \| 51,234 tok \| 0 \|/);
    assert.match(md, /Claude spend: \$0\.42/);
    assert.doesNotMatch(md, /\u00b7|\u2014/, "no middots or em dashes");
  });
  test("stubs: one sc(...) per confirmed finding, covers filled, in qa/scenarios.ts form", () => {
    const ts = renderScenarioStubs("2026-11-16T10-00-00", [refuted, confirmed], cat);
    assert.match(ts, /import \{ sc, type T \} from "\.\.\/\.\.\/\.\.\/harness\.ts";/);
    assert.equal(ts.match(/^sc\(/gm)?.length, 1);
    assert.match(ts, /sc\("history", "Undo after a page switch restores the wrong page", \{ covers: \["undo-redo:keyboard"\] \}, async \(t: T\) => \{/);
    assert.match(ts, /t\.skip\("swarm stub, not written yet: /);
    assert.match(ts, /\/\/   2\. canvas key z meta/);
    assert.match(renderScenarioStubs("x", [refuted], cat), /No confirmed findings/);
  });
  test("the covers pair: the finding's case, else the persona's first case the feature has, else the first case", () => {
    assert.deepEqual(guessCover(tagged({ case: "many" }), cat), { pair: "undo-redo:many", guessed: false });
    assert.deepEqual(guessCover(tagged({ persona: "agent" }), cat), { pair: "undo-redo:agent", guessed: true });
    const kb = guessCover(tagged({ feature: "nudge", persona: "keyboard" }), cat);
    assert.deepEqual(kb, { pair: "nudge:keyboard", guessed: true });
    const f = cat.features.find((x) => !PERSONAS.find((p) => p.id === "newcomer")!.covers.some((c) => x.cases.includes(c)))!;
    assert.deepEqual(guessCover(tagged({ feature: f.id, persona: "newcomer" }), cat), { pair: `${f.id}:${f.cases[0]}`, guessed: true });
  });
});
