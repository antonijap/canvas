// Settings > Agents: the model and reasoning level each agent runs with (src/settings.ts, src/agent-run.ts).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildCommand, modelsOf } from "../src/agent-run.ts";
import { cleanSettings } from "../src/settings.ts";

const base = { mcpSession: "s", mcpConfigPath: "/tmp/m.json", node: "/usr/bin/node", port: 5189, serverVersion: "v" };
const claude = { id: "claude" as const, label: "Claude Code", path: "/x/claude", real: "/x/claude" };
const codex = { id: "codex" as const, label: "Codex", path: "/x/codex", real: "/x/codex" };

test("defaults: no model and no effort, so each agent uses its own", () => {
  const s = cleanSettings({});
  assert.deepEqual(s.claude, { model: "", effort: "" });
  assert.deepEqual(s.codex, { model: "", effort: "" });
  const c = buildCommand({ ...base, harness: claude, choice: s.claude });
  assert.ok(!c.args.includes("--model") && !c.args.includes("--effort"));
  const x = buildCommand({ ...base, harness: codex, choice: s.codex });
  assert.ok(!x.args.includes("-m") && !x.args.some((a) => a.startsWith("model_reasoning_effort")));
});

test("Claude Code gets --model and --effort", () => {
  const s = cleanSettings({ claude: { model: "opus", effort: "high" } });
  const c = buildCommand({ ...base, harness: claude, choice: s.claude });
  assert.deepEqual(c.args.slice(c.args.indexOf("--model"), c.args.indexOf("--model") + 2), ["--model", "opus"]);
  assert.deepEqual(c.args.slice(c.args.indexOf("--effort"), c.args.indexOf("--effort") + 2), ["--effort", "high"]);
});

test("Codex gets -m and model_reasoning_effort", () => {
  const s = cleanSettings({ codex: { model: "gpt-6.1-sol", effort: "xhigh" } });
  const c = buildCommand({ ...base, harness: codex, choice: s.codex });
  assert.equal(c.args[c.args.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.ok(c.args.includes('model_reasoning_effort="xhigh"'), c.args.join(" "));
  assert.ok(c.args.indexOf("-m") < c.args.indexOf("-"), "the model comes before the prompt marker");
});

test("anything unexpected falls back to the default: no flags, no shell text on the command line", () => {
  const s = cleanSettings({ claude: { model: "opus; rm -rf ~", effort: "ultra" }, codex: { model: "--danger", effort: "turbo" } });
  assert.deepEqual(s.claude, { model: "", effort: "" }, "ultra is not a Claude Code level");
  assert.deepEqual(s.codex, { model: "", effort: "" });
});

test("Codex's models come from its own cache, with the levels each takes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-models-"));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-a", display_name: "GPT A", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "bogus" }] },
    { slug: "bad slug!", supported_reasoning_levels: [] },
  ] }));
  assert.deepEqual(modelsOf("codex", home), [{ id: "gpt-a", label: "GPT A", efforts: ["low", "high"] }]);
  assert.deepEqual(modelsOf("codex", path.join(home, "none")), [], "no cache: no list");
  assert.ok(modelsOf("claude").some((m) => m.id === "opus"));
  fs.rmSync(home, { recursive: true, force: true });
});
