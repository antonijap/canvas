// Connect: one click registers Canvas MCP (as "canvas") with Claude Code or Codex, the same thing the commands on the
// welcome card and in Settings > Agents do when pasted into Terminal.
//
//   POST /api/mcp/connect {agent: "claude" | "codex"}   {ok, agent, registered: true, message} or {ok: false, error, code}
//
// The CLI is the one the person installed: found where the agent runs look (searchDirs: PATH, ~/.local/bin,
// /opt/homebrew/bin, /usr/local/bin, as a Finder-launched app has a bare PATH) and refused when someone else could have
// changed it (untrusted). It runs with execFile (no shell), its arguments as an array, a timeout and childEnv's
// environment. Claude Code: `claude mcp add canvas --scope user -- <node> <server>`; when canvas is already there (a
// moved app, another Node) it is removed and added again. Codex: `codex mcp add canvas -- <node> <server>`, which
// replaces an entry by itself.
//
// Whether canvas is registered (GET /api/mcp/setup's `registered`) is read from the agents' own config files, never
// with `claude mcp get`: that health-checks the server, which would start canvas-mcp and turn the Connected dot on.

import { execFile } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { childEnv, HARNESS_LABEL, searchDirs, untrusted } from "./agent-run.ts";
import { originOk } from "./bridge.ts";
import { countUsage } from "./usage-counts.ts";

export type Agent = "claude" | "codex";
export const AGENTS: Agent[] = ["claude", "codex"];
const NAME = "canvas";
export const CONNECT_TIMEOUT_MS = 20_000;
const ERROR_MAX = 400;

export type Ran = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };
export type Connected = { ok: true; agent: Agent; registered: true; message: string };
export type NotConnected = { ok: false; agent: Agent; error: string; code: "missing" | "untrusted" | "failed" | "timeout" };

/** The agent's CLI, as the agent runs find it, or why there is none to run. Checked on every call, never cached. */
export function locateCli(id: Agent, dirs = searchDirs()): { ok: true; path: string; real: string } | { ok: false; code: "missing" | "untrusted"; path?: string; reason?: string } {
  let refused: { path: string; reason: string } | null = null;
  for (const d of dirs) {
    const p = path.join(d, id);
    let real: string;
    try {
      real = fs.realpathSync(p);
    } catch {
      continue;
    }
    const why = untrusted(real);
    if (!why) return { ok: true, path: p, real };
    refused ??= { path: p, reason: why };
  }
  return refused ? { ok: false, code: "untrusted", ...refused } : { ok: false, code: "missing" };
}

export function addArgs(id: Agent, node: string, server: string): string[] {
  return id === "claude" ? ["mcp", "add", NAME, "--scope", "user", "--", node, server] : ["mcp", "add", NAME, "--", node, server];
}
const removeArgs = (id: Agent) => (id === "claude" ? ["mcp", "remove", NAME, "--scope", "user"] : ["mcp", "remove", NAME]);

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8", cwd: os.tmpdir() }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      const timedOut = !!e && e.killed === true;
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut,
        ...(e && typeof e.code === "string" ? { spawnError: `${e.code}: ${e.message}` } : {}),
      });
    });
  });
}

/** The CLI's own words, trimmed to what fits on the card. */
export function cliError(r: Ran): string {
  const said = (r.stderr.trim() || r.stdout.trim() || r.spawnError || `exited with code ${r.code}`).replace(/\s*\n\s*/g, " ");
  return said.length > ERROR_MAX ? said.slice(0, ERROR_MAX - 1) + "…" : said;
}

/**
 * A server inside a temporary git worktree (.../.claude/worktrees/<name>/...). Registering it points every Claude
 * Code and Codex session at a folder that is deleted when the worktree's job is done, and the MCP breaks for all of them.
 */
export function temporaryServer(server: string, env = process.env): boolean {
  // QA runs from worktrees against scratch agent configs (CLAUDE_CONFIG_DIR, a scratch HOME): nothing lasting to break.
  if (env.CANVAS_CONNECT_TEMPORARY === "1") return false;
  const parts = path.resolve(server).split(path.sep);
  return parts.some((p, i) => p === ".claude" && parts[i + 1] === "worktrees" && i + 2 < parts.length - 1);
}
export const TEMPORARY_SERVER = "This Canvas runs from a temporary worktree; connect from the installed app or the main checkout.";

const inflight = new Map<Agent, Promise<Connected | NotConnected>>();

/** Registers canvas with the agent. One at a time per agent: a second click waits for the first. */
export function connectAgent(id: Agent, o: { node: string; server: string; dirs?: string[]; timeoutMs?: number }): Promise<Connected | NotConnected> {
  const going = inflight.get(id);
  if (going) return going;
  const p = connectNow(id, o).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function connectNow(id: Agent, o: { node: string; server: string; dirs?: string[]; timeoutMs?: number }): Promise<Connected | NotConnected> {
  const label = HARNESS_LABEL[id];
  if (temporaryServer(o.server)) return { ok: false, agent: id, code: "untrusted", error: TEMPORARY_SERVER };
  const cli = locateCli(id, o.dirs);
  if (!cli.ok) {
    if (cli.code === "untrusted") return { ok: false, agent: id, code: "untrusted", error: `Canvas did not run ${cli.path}: it is ${cli.reason}. Copy the command into Terminal instead.` };
    return { ok: false, agent: id, code: "missing", error: `${label} is not installed: Canvas looked in PATH, ~/.local/bin, /opt/homebrew/bin and /usr/local/bin.` };
  }
  const env = childEnv(process.env, cli.real);
  const ms = o.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const call = (args: string[]) => run(cli.real, args, env, ms);
  const failed = (r: Ran): NotConnected => r.timedOut
    ? { ok: false, agent: id, code: "timeout", error: `${label} did not answer in ${Math.round(ms / 1000)} s. Copy the command into Terminal instead.` }
    : { ok: false, agent: id, code: "failed", error: cliError(r) };
  let r = await call(addArgs(id, o.node, o.server));
  if (r.code !== 0 && !r.timedOut && /already exists/i.test(r.stderr + r.stdout)) {
    const rm = await call(removeArgs(id));
    if (rm.code !== 0) return failed(rm);
    r = await call(addArgs(id, o.node, o.server));
  }
  forgetRegistered();
  if (r.code !== 0) return failed(r);
  return { ok: true, agent: id, registered: true, message: addedMessage(label) };
}

/**
 * What Connect says once it worked. Agent sessions already open keep the MCP they started with (an older one after an
 * update) until they restart, so it says that too. The welcome card (src/page/widget-kinds.js welcomeAdded) and
 * Settings > Agents (apps/macos/SettingsLogic.swift ConnectCopy.added) say the same.
 */
export const addedMessage = (label: string) => `Added. New ${label} sessions use it; restart any that are open.`;

// ---------- registered or not ----------

type Entry = { command?: unknown; args?: unknown; enabled?: unknown } | null;

/** Claude Code's user-scope entry: mcpServers.canvas in ~/.claude.json ($CLAUDE_CONFIG_DIR/.claude.json when set). */
export function claudeEntry(env = process.env): Entry {
  const file = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
  try {
    const e = JSON.parse(fs.readFileSync(file, "utf8"))?.mcpServers?.[NAME];
    return e && typeof e === "object" ? e : null;
  } catch {
    return null;
  }
}

/** Codex's entry: the [mcp_servers.canvas] table in ~/.codex/config.toml ($CODEX_HOME/config.toml when set). */
export function codexEntry(env = process.env): Entry {
  const file = path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[\s*mcp_servers\s*\.\s*(canvas|"canvas")\s*\]\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  const out: Record<string, unknown> = {};
  for (const l of lines.slice(start + 1)) {
    if (/^\s*\[/.test(l)) break;
    const m = /^\s*(command|args|enabled)\s*=\s*(.+?)\s*$/.exec(l);
    if (!m) continue;
    try { out[m[1]] = JSON.parse(m[2]); } catch { out[m[1]] = m[2]; }
  }
  return out;
}

/** Points at this server, with a Node that is there and the entry on. */
export function entryIsCurrent(e: Entry, server: string): boolean {
  if (!e || e.enabled === false) return false;
  const args = Array.isArray(e.args) ? e.args : [];
  if (!args.includes(server)) return false;
  return typeof e.command === "string" && (!path.isAbsolute(e.command) || fs.existsSync(e.command));
}

let cache: { at: number; server: string; v: Record<Agent, boolean> } | null = null;
const CACHE_MS = 3000;
export const forgetRegistered = () => { cache = null; };

/** Whether each agent has canvas registered for this server. Cached a few seconds: the card asks every 2 s. */
export async function registeredState(o: { server: string }): Promise<Record<Agent, boolean>> {
  if (cache && cache.server === o.server && Date.now() - cache.at < CACHE_MS) return cache.v;
  const v = { claude: entryIsCurrent(claudeEntry(), o.server), codex: entryIsCurrent(codexEntry(), o.server) };
  cache = { at: Date.now(), server: o.server, v };
  return v;
}

/** Which agents' CLIs Canvas would run (trusted and found). */
export function installedState(dirs = searchDirs()): Record<Agent, boolean> {
  return { claude: locateCli("claude", dirs).ok, codex: locateCli("codex", dirs).ok };
}

// ---------- route ----------

type Json = (res: http.ServerResponse, v: unknown, status?: number) => void;

async function readBody(req: http.IncomingMessage, max = 4096): Promise<unknown> {
  let s = "";
  for await (const c of req) {
    s += String(c);
    if (s.length > max) throw new Error("too large");
  }
  return s ? JSON.parse(s) : {};
}

const STATUS: Record<NotConnected["code"], number> = { missing: 404, untrusted: 403, failed: 502, timeout: 504 };

/** POST /api/mcp/connect. It changes the person's agent config: only Canvas's own page or app may call it. */
export async function handleConnectRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, json: Json, paths: () => { node: string; server: string }): Promise<boolean> {
  if (url.pathname !== "/api/mcp/connect") return false;
  if (req.method !== "POST") { json(res, { ok: false, error: "POST only" }, 405); return true; }
  // A foreign page can send a simple POST with no preflight: it carries neither the header nor our Origin.
  if (req.headers["x-canvas"] !== "1" || !originOk(req)) { json(res, { ok: false, error: "forbidden" }, 403); return true; }
  let body: unknown;
  try { body = await readBody(req); } catch { json(res, { ok: false, error: "The request is not JSON." }, 400); return true; }
  const agent = (body as { agent?: unknown } | null)?.agent;
  if (agent !== "claude" && agent !== "codex") { json(res, { ok: false, error: `agent must be "claude" or "codex"` }, 400); return true; }
  countUsage("mcp.connect_clicked");
  const r = await connectAgent(agent, paths());
  json(res, r, r.ok ? 200 : STATUS[r.code]);
  return true;
}
