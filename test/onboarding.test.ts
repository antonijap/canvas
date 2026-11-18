// First run (src/onboarding.ts): the MCP server's name and description, the setup commands, the Connected indicator,
// the Welcome file and its card, and the browser page saying the engine build is missing.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("onboarding");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_WELCOME_DIR = path.join(dir, "Documents", "Canvas");
const noEngine = path.join(dir, "no-engine");
fs.mkdirSync(noEngine);

const O = await import("../src/onboarding.ts");
const { temporaryServer } = await import("../src/mcp-connect.ts");
const { startServer } = await import("../src/server.ts");
const { kinds } = await import("../src/widgets.ts");
const { codeRootId, mcpCodeVersion, version: codeVersion } = await import("../src/version.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const version = ((await (await fetch(`${base}/health`)).json()) as { version: string }).version;

const clients: Client[] = [];
async function connect(env: Record<string, string> = {}, name = "claude-code") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(import.meta.dirname, "../mcp/server.ts")],
    env: { ...(process.env as Record<string, string>), CANVAS_PORT: String(port), CANVAS_MCP_NO_SPAWN: "1", CANVAS_MCP_NO_APP: "1", CANVAS_MCP_WANT_VERSION: version, ...env },
    stderr: "pipe",
  });
  const c = new Client({ name, version: "1" });
  await c.connect(transport);
  clients.push(c);
  return c;
}
const setup = async () => (await fetch(`${base}/api/mcp/setup`)).json() as Promise<any>;
const until = async (f: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the MCP server is named canvas and says in one line what it is", async () => {
  const c = await connect();
  const info = c.getServerVersion()!;
  assert.equal(info.name, "canvas");
  assert.equal(info.title, "Canvas");
  assert.ok(typeof info.description === "string" && info.description.length > 20 && info.description.length < 160, info.description);
  assert.ok(!/\n/.test(info.description!), "one line");
  await c.close();
});

test("setup commands register the server as canvas with absolute paths", async () => {
  const s = await setup();
  assert.equal(s.name, "canvas");
  assert.match(s.claude, /^claude mcp add canvas --scope user -- \S+node \S+\/mcp\/server\.ts$/);
  assert.match(s.codex, /^codex mcp add canvas -- \S+node \S+\/mcp\/server\.ts$/);
  assert.ok(path.isAbsolute(s.node) && path.isAbsolute(s.server));
  assert.ok(fs.existsSync(s.server), "the MCP script it names exists");
  // Whether Connect may run here (a server in a temporary worktree: no; the card offers Copy command instead).
  assert.equal(typeof s.temporary, "boolean", "setup says whether the server is in a temporary worktree");
  assert.equal(s.temporary, temporaryServer(s.server));
  // A mise patch version is registered as its major folder, so a Node update does not break it.
  assert.equal(O.stableNode("/u/.local/share/mise/installs/node/24.11.1/bin/node", () => true), "/u/.local/share/mise/installs/node/24/bin/node");
  assert.equal(O.stableNode("/opt/homebrew/bin/node", () => true), "/opt/homebrew/bin/node");
  assert.equal(O.setupCommands("/a b/node", "/x/mcp/server.ts", "/Users/me").claude, "claude mcp add canvas --scope user -- '/a b/node' /x/mcp/server.ts");
  // The home folder is the shell's own (~ or "$HOME"), so no user name is on screen, and a paste expands it.
  const home = os.userInfo().homedir;
  assert.ok(!s.claude.includes(home) && !s.codex.includes(home), `no home path on screen: ${s.claude}`);
  const c = O.setupCommands("/Users/me/.local/share/mise/installs/node/24/bin/node", "/Users/me/My Code/canvas/mcp/server.ts", "/Users/me");
  assert.equal(c.claude, `claude mcp add canvas --scope user -- ~/.local/share/mise/installs/node/24/bin/node "$HOME/My Code/canvas/mcp/server.ts"`);
  assert.equal(O.homeArg(`/Users/me/a"b$c`, "/Users/me"), `"$HOME/a\\"b\\$c"`);
  // What bash makes of it: the absolute paths, one argument each.
  const args = c.claude.replace(/^claude mcp add canvas --scope user -- /, "");
  const out = execFileSync("bash", ["-c", `for a in ${args}; do echo "[$a]"; done`], { env: { ...process.env, HOME: "/Users/me" }, encoding: "utf8" });
  assert.equal(out, "[/Users/me/.local/share/mise/installs/node/24/bin/node]\n[/Users/me/My Code/canvas/mcp/server.ts]\n");
});

test("Connected turns on when an MCP client connects, not for Canvas's own runs, and goes off after silence", async () => {
  O.resetMcpSeen();
  assert.equal((await setup()).connected, false);
  // Canvas's own agent run: not the person's registration.
  const run = await connect({ CANVAS_MCP_SESSION: "run-abcdef" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await setup()).connected, false, "a Canvas run does not count");
  await run.close();
  await connect({}, "claude-code");
  assert.ok(await until(async () => (await setup()).connected === true), "connected after the client connects");
  assert.equal((await setup()).client, "Claude");
  const s = O.mcpStatus(Date.now() + O.OFF_AFTER_MS + 1);
  assert.equal(s.connected, false, "off after OFF_AFTER_MS of silence");
  assert.equal((await setup()).outdated, false, "an MCP of this version is not older");
});

test("an MCP from before an update counts as Connected, older version (GitHub issue 9)", async () => {
  O.resetMcpSeen();
  // An older MCP sends no hello and no read header: only x-canvas-source on its writes, and no version.
  // The server notes every request before routing it, so any write path will do.
  const write = (headers: Record<string, string>) => fetch(`${base}/api/no-such-route`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", ...headers }, body: "{}" }).then((r) => r.body?.cancel());
  await write({ "x-canvas-source": "mcp" });
  let s = await setup();
  assert.equal(s.connected, true, "any request from an MCP counts");
  assert.equal(s.outdated, true, "it says which: an older version");
  // An MCP of this copy whose code is no longer on disk (the app updated under it) is older.
  O.resetMcpSeen();
  await write({ "x-canvas-source": "mcp", "x-canvas-session": "s-old", "x-canvas-mcp-version": "000000000000", "x-canvas-mcp-root": codeRootId() });
  s = await setup();
  assert.equal(s.outdated, true, "this copy's MCP with code that is gone");
  assert.equal(s.otherCopy, false);
  // An MCP of another copy (a checkout talking to the installed app) is not older: restarting would load the same
  // copy again. It is Connected, and says it is another copy.
  O.resetMcpSeen();
  await write({ "x-canvas-source": "mcp", "x-canvas-session": "s-other", "x-canvas-mcp-version": "111111111111", "x-canvas-mcp-root": "ffffffffffff" });
  s = await setup();
  assert.equal(s.connected, true, "another copy's MCP counts");
  assert.equal(s.outdated, false, "and is not called older");
  assert.equal(s.otherCopy, true, "it is another copy");
  // An MCP of this copy with the code on disk now (src and mcp): current.
  O.resetMcpSeen();
  await write({ "x-canvas-source": "mcp", "x-canvas-session": "s-now", "x-canvas-mcp-version": mcpCodeVersion(), "x-canvas-mcp-root": codeRootId() });
  s = await setup();
  assert.deepEqual([s.connected, s.outdated, s.otherCopy], [true, false, false], "this copy's current MCP");
  // A real canvas-mcp, while an older one also talks: it sends this copy's current version, so plain Connected wins.
  O.resetMcpSeen();
  await write({ "x-canvas-source": "mcp" });
  const c = await connect({}, "claude-code");
  assert.ok(await until(async () => (await setup()).outdated === false), "a current MCP wins");
  s = await setup();
  assert.equal(s.connected, true);
  assert.equal(s.client, "Claude");
  await c.close();
  // Canvas's own runs never count, old or new.
  O.resetMcpSeen();
  await write({ "x-canvas-source": "mcp", "x-canvas-session": "run-abc" });
  assert.equal((await setup()).connected, false, "a Canvas run does not count");
});

test("an MCP's code version covers mcp/ as well as src/, so an MCP-only change is noticed", () => {
  const root = fs.mkdtempSync(path.join(dir, "code-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "mcp"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "one");
  fs.writeFileSync(path.join(root, "mcp", "tools.ts"), "tools");
  const src = path.join(root, "src");
  const v1 = mcpCodeVersion(src), s1 = codeVersion(src);
  assert.match(v1, /^[0-9a-f]{12}$/);
  fs.writeFileSync(path.join(root, "mcp", "tools.ts"), "tools, changed");
  assert.notEqual(mcpCodeVersion(src), v1, "an mcp/ change is a new MCP version");
  assert.equal(codeVersion(src), s1, "the server's version (src only) stays");
  fs.writeFileSync(path.join(root, "src", "a.ts"), "two");
  assert.notEqual(codeVersion(src), s1, "a src/ change is both");
});

test("the Welcome file is a copy of the course with the welcome card, made once", async () => {
  const post = () => fetch(`${base}/api/welcome`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: "{}" }).then((r) => r.json() as Promise<any>);
  const a = await post();
  assert.equal(a.created, true);
  assert.equal(a.file, fs.realpathSync(path.join(process.env.CANVAS_WELCOME_DIR!, "Welcome.canvas")));
  const sample = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../demos/learn.canvas/document.json"), "utf8"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.file, "document.json"), "utf8")), sample);
  const ws = JSON.parse(fs.readFileSync(path.join(a.file, "widgets.json"), "utf8")).widgets;
  const card = ws.find((w: any) => w.kind === "welcome");
  assert.ok(card, "the welcome card");
  const left = Math.min(...sample.children.map((n: any) => n.x));
  assert.ok(card.x + card.w <= left, "left of the boards");
  // Edited by the person, then asked again: theirs stays.
  fs.writeFileSync(path.join(a.file, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }));
  const b = await post();
  assert.equal(b.created, false);
  assert.equal(b.file, a.file);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.file, "widgets.json"), "utf8")).widgets.length, 0);
  assert.equal(fs.readdirSync(process.env.CANVAS_WELCOME_DIR!).filter((f) => f.startsWith(".")).length, 0, "no temp copy left");
  // Writes need the header.
  assert.equal((await fetch(`${base}/api/welcome`, { method: "POST" })).status, 403);
});

test("the welcome card is not offered in the Widgets panel", () => {
  assert.ok(!kinds().some((k) => k.id === "welcome"));
});

test("the browser page says when the engine build is missing", async () => {
  const was = process.env.CANVAS_ENGINE_PKG;
  process.env.CANVAS_ENGINE_PKG = noEngine;
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /data-engine="missing"/);
    assert.match(html, /Drawing with the fallback renderer\. Run <code>pnpm build:engine<\/code>\./);
    assert.match(html, /The Mac app is the main way to use Canvas\. Run <code>pnpm app<\/code>/);
  } finally {
    if (was === undefined) delete process.env.CANVAS_ENGINE_PKG; else process.env.CANVAS_ENGINE_PKG = was;
  }
  const engine = fs.existsSync(path.resolve(import.meta.dirname, "../engine/pkg/canvas_engine.js")) ? "ok" : "missing";
  assert.match(await (await fetch(`${base}/`)).text(), new RegExp(`data-engine="${engine}"`));
});
