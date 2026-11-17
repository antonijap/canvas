// Connect (src/mcp-connect.ts): one click registers Canvas MCP with Claude Code or Codex. Every CLI here is a fake
// that keeps its config in a scratch folder (CLAUDE_CONFIG_DIR, CODEX_HOME): no test runs the real `claude mcp add`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("mcp-connect");
const bin = path.join(dir, "bin");
const empty = path.join(dir, "empty");
const log = path.join(dir, "argv.log");
/** The fakes see only childEnv's environment (no test variables): these files switch them instead. */
const failFile = path.join(dir, "fail");
const sleepFile = path.join(dir, "sleep");
fs.mkdirSync(bin);
fs.mkdirSync(empty);
process.env.CANVAS_ROOTS = dir;
process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
process.env.CODEX_HOME = path.join(dir, "codex");
process.env.CANVAS_AGENT_PATH = bin;
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
fs.mkdirSync(process.env.CODEX_HOME);
const claudeJson = path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
const codexToml = path.join(process.env.CODEX_HOME, "config.toml");

/**
 * A fake `claude`: `mcp add canvas --scope user -- <cmd> <args>` writes ~/.claude.json's user mcpServers and fails
 * with the real CLI's words when canvas is there; `mcp remove canvas --scope user` takes it out. Every call is logged.
 */
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(["claude", ...a]) + "\\n");
const file = process.env.CLAUDE_CONFIG_DIR + "/.claude.json";
const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
j.mcpServers = j.mcpServers || {};
if (fs.existsSync(${JSON.stringify(failFile)})) { process.stderr.write("  " + fs.readFileSync(${JSON.stringify(failFile)}, "utf8") + "\\n\\n"); process.exit(1); }
if (a[0] === "mcp" && a[1] === "add") {
  if (j.mcpServers[a[2]]) { process.stderr.write("MCP server " + a[2] + " already exists in user config\\n"); process.exit(1); }
  const i = a.indexOf("--");
  j.mcpServers[a[2]] = { type: "stdio", command: a[i + 1], args: a.slice(i + 2), env: {} };
  fs.writeFileSync(file, JSON.stringify(j));
  process.stdout.write("Added stdio MCP server " + a[2] + "\\n");
} else if (a[0] === "mcp" && a[1] === "remove") {
  if (!j.mcpServers[a[2]]) { process.stderr.write("No MCP server named \\"" + a[2] + "\\" in user scope\\n"); process.exit(1); }
  delete j.mcpServers[a[2]];
  fs.writeFileSync(file, JSON.stringify(j));
} else process.exit(2);
`;
/** A fake `codex`: `mcp add canvas -- <cmd> <args>` writes (or replaces) [mcp_servers.canvas] in config.toml. */
const FAKE_CODEX = `#!${process.execPath}
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(["codex", ...a]) + "\\n");
if (fs.existsSync(${JSON.stringify(sleepFile)})) { setTimeout(() => {}, 60000); return; }
const file = process.env.CODEX_HOME + "/config.toml";
if (a[0] === "mcp" && a[1] === "add") {
  const i = a.indexOf("--");
  fs.writeFileSync(file, "model = \\"x\\"\\n\\n[mcp_servers.canvas]\\ncommand = " + JSON.stringify(a[i + 1]) + "\\nargs = " + JSON.stringify(a.slice(i + 2)) + "\\n\\n[other]\\nk = 1\\n");
  process.stdout.write("Added global MCP server 'canvas'.\\n");
} else process.exit(2);
`;

function install(name: "claude" | "codex", mode = 0o755) {
  const p = path.join(bin, name);
  fs.writeFileSync(p, name === "claude" ? FAKE_CLAUDE : FAKE_CODEX);
  fs.chmodSync(p, mode);
  return p;
}
const calls = (): string[][] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const C = await import("../src/mcp-connect.ts");
const { setupCommands } = await import("../src/onboarding.ts");
const { MCP_SCRIPT } = await import("../src/onboarding.ts");
const NODE = "/opt/node/24/bin/node";

beforeEach(() => {
  for (const f of [log, claudeJson, codexToml, failFile, sleepFile]) fs.rmSync(f, { force: true });
  for (const f of fs.readdirSync(bin)) fs.rmSync(path.join(bin, f), { force: true });
  C.forgetRegistered();
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("connectAgent", () => {
  test("Claude Code: adds canvas at user scope with the absolute node and server paths", async () => {
    install("claude");
    const r = await C.connectAgent("claude", { node: NODE, server: MCP_SCRIPT });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r, { ok: true, agent: "claude", registered: true, message: "Added. Start a new Claude Code session." });
    assert.deepEqual(calls(), [["claude", "mcp", "add", "canvas", "--scope", "user", "--", NODE, MCP_SCRIPT]]);
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeJson, "utf8")).mcpServers.canvas.args, [MCP_SCRIPT]);
  });

  test("Codex: adds canvas with the same paths", async () => {
    install("codex");
    const r = await C.connectAgent("codex", { node: NODE, server: MCP_SCRIPT });
    assert.deepEqual(r, { ok: true, agent: "codex", registered: true, message: "Added. Start a new Codex session." });
    assert.deepEqual(calls(), [["codex", "mcp", "add", "canvas", "--", NODE, MCP_SCRIPT]]);
  });

  test("a canvas entry already there (an old app path) is removed and added again", async () => {
    install("claude");
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { canvas: { type: "stdio", command: "/old/node", args: ["/Old/Canvas.app/server.ts"] }, other: { command: "x" } } }));
    const r = await C.connectAgent("claude", { node: NODE, server: MCP_SCRIPT });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(calls().map((c) => c.slice(0, 3)), [["claude", "mcp", "add"], ["claude", "mcp", "remove"], ["claude", "mcp", "add"]]);
    assert.deepEqual(calls()[1], ["claude", "mcp", "remove", "canvas", "--scope", "user"]);
    const j = JSON.parse(fs.readFileSync(claudeJson, "utf8"));
    assert.deepEqual(j.mcpServers.canvas.args, [MCP_SCRIPT], "the new path");
    assert.equal(j.mcpServers.canvas.command, NODE);
    assert.deepEqual(j.mcpServers.other, { command: "x" }, "other servers stay");
  });

  test("a binary someone else could have changed is refused and never run", async () => {
    install("claude", 0o777);
    const r = await C.connectAgent("claude", { node: NODE, server: MCP_SCRIPT });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "untrusted");
    assert.match(!r.ok ? r.error : "", /writable by others/);
    assert.deepEqual(calls(), [], "not run");
    assert.ok(!fs.existsSync(claudeJson));
  });

  test("no CLI installed: says where Canvas looked", async () => {
    const r = await C.connectAgent("codex", { node: NODE, server: MCP_SCRIPT, dirs: [empty] });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "missing");
    assert.match(!r.ok ? r.error : "", /^Codex is not installed/);
  });

  test("a CLI error comes back trimmed", async () => {
    install("claude");
    fs.writeFileSync(failFile, "Invalid scope: user\n" + "x".repeat(2000));
    const r = await C.connectAgent("claude", { node: NODE, server: MCP_SCRIPT });
    assert.equal(r.ok, false);
    const e = !r.ok ? r.error : "";
    assert.ok(e.startsWith("Invalid scope: user"), e);
    assert.ok(e.length <= 400, `trimmed: ${e.length}`);
    assert.equal(!r.ok && r.code, "failed");
  });

  test("a CLI that hangs is stopped at the timeout", async () => {
    install("codex");
    fs.writeFileSync(sleepFile, "1");
    const t0 = Date.now();
    const r = await C.connectAgent("codex", { node: NODE, server: MCP_SCRIPT, timeoutMs: 400 });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /did not answer/);
    assert.ok(Date.now() - t0 < 5000);
  });
});

describe("registered", () => {
  test("reads both agents' configs; an entry for another app's server does not count", async () => {
    assert.deepEqual(await C.registeredState({ server: MCP_SCRIPT }), { claude: false, codex: false });
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { canvas: { type: "stdio", command: process.execPath, args: [MCP_SCRIPT] } } }));
    fs.writeFileSync(codexToml, `[mcp_servers.canvas]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["/Elsewhere/Canvas.app/mcp/server.ts"]\n`);
    C.forgetRegistered();
    assert.deepEqual(await C.registeredState({ server: MCP_SCRIPT }), { claude: true, codex: false });
    fs.writeFileSync(codexToml, `[mcp_servers."canvas"]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(MCP_SCRIPT)}]\n`);
    C.forgetRegistered();
    assert.deepEqual(await C.registeredState({ server: MCP_SCRIPT }), { claude: true, codex: true });
    // A Node that is gone (moved app, removed version): not registered, so Connect shows and fixes it.
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { canvas: { type: "stdio", command: "/gone/node", args: [MCP_SCRIPT] } } }));
    fs.writeFileSync(codexToml, `[mcp_servers.canvas]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(MCP_SCRIPT)}]\nenabled = false\n`);
    C.forgetRegistered();
    assert.deepEqual(await C.registeredState({ server: MCP_SCRIPT }), { claude: false, codex: false }, "a missing Node, a disabled entry");
  });
});

describe("POST /api/mcp/connect", async () => {
  const { startServer } = await import("../src/server.ts");
  const server = await startServer(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  after(() => new Promise((r) => server.close(r)));
  const post = (body: unknown, headers: Record<string, string> = { "x-canvas": "1" }) =>
    fetch(`${base}/api/mcp/connect`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("adds canvas and the setup state says registered", async () => {
    install("claude");
    install("codex");
    const before = (await (await fetch(`${base}/api/mcp/setup`)).json()) as any;
    assert.deepEqual(before.registered, { claude: false, codex: false });
    assert.deepEqual(before.installed, { claude: true, codex: true });
    const r = await post({ agent: "claude" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, agent: "claude", registered: true, message: "Added. Start a new Claude Code session." });
    const c = calls()[0];
    assert.deepEqual(c.slice(0, 7), ["claude", "mcp", "add", "canvas", "--scope", "user", "--"]);
    assert.deepEqual(c.slice(7), [setupCommands().node, MCP_SCRIPT], "the absolute paths setupCommands shows");
    const s = (await (await fetch(`${base}/api/mcp/setup`)).json()) as any;
    assert.deepEqual(s.registered, { claude: true, codex: false });
  });

  test("another site cannot call it", async () => {
    install("claude");
    for (const h of [
      { "x-canvas": "1", origin: "http://evil.example" },
      { "x-canvas": "1", origin: "http://127.0.0.1:1" },
      { "x-canvas": "1", "sec-fetch-site": "cross-site" },
      {},
    ]) {
      const r = await post({ agent: "claude" }, h as Record<string, string>);
      assert.equal(r.status, 403, JSON.stringify(h));
    }
    assert.deepEqual(calls(), [], "no CLI ran");
  });

  test("an unknown agent, or a missing CLI, is an error the card can show", async () => {
    const bad = await post({ agent: "cursor" });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as any).ok, false);
    const missing = await post({ agent: "codex" });
    assert.equal(missing.status, 404);
    const j = (await missing.json()) as any;
    assert.equal(j.ok, false);
    assert.match(j.error, /^Codex is not installed/);
  });
});
