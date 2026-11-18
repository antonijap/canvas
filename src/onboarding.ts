// First run: the Welcome file, the commands that register Canvas MCP with Claude Code and Codex, and whether an
// MCP client is talking to this server right now.
//
//   GET  /api/mcp/setup   {name, claude, codex, node, server, connected, client, seenMs, installed, registered}
//                         installed/registered: {claude, codex} booleans, for Connect (src/mcp-connect.ts);
//                         temporary: this server runs from a temporary worktree, so Connect refuses (Copy command only)
//   POST /api/mcp/connect {agent}: registers canvas with that agent's CLI (src/mcp-connect.ts)
//   POST /api/mcp/hello   canvas-mcp says it is there (on connect, then every HEARTBEAT_MS while it runs)
//   POST /api/welcome     {file}: ~/Documents/Canvas/Welcome.canvas, a copy of demos/learn.canvas (the course) with the
//                         welcome card on it; made once, answered again as it is after that
//
// Any request canvas-mcp makes (x-canvas-source: mcp on writes, x-canvas-mcp on reads) counts as it talking. Runs Canvas starts itself (src/agent-run.ts,
// sessions "run-...") do not: they say nothing about whether the person registered the server. An MCP whose
// x-canvas-mcp-version is not this server's code version (or that sends none: one from before an update) counts as
// Connected, older version: `outdated` in the setup answer.

import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentLabel } from "./agent-cursor.ts";
import { DESIGN_FILE } from "./docpath.ts";
import { kindOf, validateWidget } from "./widgets/registry.ts";
import { countUsage } from "./usage-counts.ts";
import { handleConnectRoute, installedState, registeredState, temporaryServer } from "./mcp-connect.ts";
import { version as codeVersion } from "./version.ts";

export const MCP_NAME = "canvas";
/** canvas-mcp says hello every 20 s (HEARTBEAT_MS in mcp/client.ts); the indicator goes off after OFF_AFTER_MS of silence. */
export const OFF_AFTER_MS = 50_000;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MCP_SCRIPT = path.join(REPO, "mcp", "server.ts");
const COURSE = path.join(REPO, "demos", "learn.canvas");

/** Quoted for a POSIX shell only when it needs it, so the common path stays readable. */
export const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The Node to register: a mise install's major-version folder (node/24) when there is one, so a Node update does not
 * break the registration; otherwise the Node running this server.
 */
export function stableNode(exec = process.execPath, exists = (p: string) => fs.existsSync(p)): string {
  const m = /^(.*\/installs\/node\/)(\d+)\.\d+\.\d+(\/bin\/node)$/.exec(exec);
  if (m && exists(m[1] + m[2] + m[3])) return m[1] + m[2] + m[3];
  return exec;
}

/** The account's home folder (the system's record, not HOME: a QA server runs with a scratch HOME, the person's shell does not). */
const userHome = () => { try { return os.userInfo().homedir; } catch { return os.homedir(); } };

/**
 * A path as a shell argument with the home folder written as the shell's own: `~/...` when the rest needs no quoting,
 * else `"$HOME/..."`. Pasted into zsh or bash it expands to the absolute path, and no one's user name is on screen.
 */
export function homeArg(p: string, home = userHome()): string {
  if (!home || (p !== home && !p.startsWith(home + "/"))) return shq(p);
  const rest = p.slice(home.length + 1);
  if (/^[\w@%+=:,./-]*$/.test(rest)) return rest ? `~/${rest}` : "~";
  return `"$HOME/${rest.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function setupCommands(node = stableNode(), script = MCP_SCRIPT, home = userHome()) {
  const run = `${homeArg(node, home)} ${homeArg(script, home)}`;
  return {
    name: MCP_NAME,
    node,
    server: script,
    claude: `claude mcp add ${MCP_NAME} --scope user -- ${run}`,
    codex: `codex mcp add ${MCP_NAME} -- ${run}`,
  };
}

// ---------- who is talking ----------

let seen: { at: number; client: string } | null = null;
/**
 * The last request from an MCP of other code than this server's: one from before an update (it sends no
 * x-canvas-mcp-version, often only x-canvas-source on its writes), or one whose code differs. Agent sessions that were
 * open during an update keep running it until they restart.
 */
let seenOld: { at: number; client: string } | null = null;
let serverVersion: string | undefined;
/** This server's code version (src/version.ts), worked out once: the code it runs does not change under it. */
const ownVersion = () => (serverVersion ??= codeVersion());
/** MCP sessions already counted as a connection (usage counts): one per session, not one per heartbeat. */
const counted = new Set<string>();

/** agent.connected.claude, .codex or .other, from the client's name (x-canvas-agent). */
export function connectedEvent(agent: unknown): string {
  const s = typeof agent === "string" ? agent.toLowerCase() : "";
  return s.includes("claude") ? "agent.connected.claude" : s.includes("codex") ? "agent.connected.codex" : "agent.connected.other";
}

/** Notes a request from canvas-mcp. Only clients the person runs count, never Canvas's own runs. */
export function noteMcp(req: http.IncomingMessage, now = Date.now()): boolean {
  // Writes carry x-canvas-source; reads carry only x-canvas-mcp (the session), so no read route mistakes them for writes.
  const mcpRead = req.headers["x-canvas-mcp"];
  if (req.headers["x-canvas-source"] !== "mcp" && typeof mcpRead !== "string") return false;
  const session = String(req.headers["x-canvas-session"] ?? mcpRead ?? "");
  // An MCP from before sessions were sent has none: it still counts, as an older version.
  if (session.startsWith("run-")) return false;
  const agent = req.headers["x-canvas-agent"];
  if (session && !counted.has(session)) {
    if (counted.size > 500) counted.clear();
    counted.add(session);
    countUsage(connectedEvent(agent));
  }
  const v = req.headers["x-canvas-mcp-version"];
  const old = typeof v !== "string" || v !== ownVersion();
  const was = old ? seenOld : seen;
  const next = { at: now, client: typeof agent === "string" && agent ? agentLabel(agent.slice(0, 80)) : was?.client ?? "An agent" };
  if (old) seenOld = next;
  else seen = next;
  return true;
}

/**
 * connected: an MCP talked within OFF_AFTER_MS. outdated: only an older one did (no MCP of this version), so the
 * agent sessions running it must restart to get the current tools.
 */
export function mcpStatus(now = Date.now()) {
  const on = !!seen && now - seen.at < OFF_AFTER_MS;
  const oldOn = !on && !!seenOld && now - seenOld.at < OFF_AFTER_MS;
  const last = on ? seen : oldOn ? seenOld : null;
  const any = [seen, seenOld].filter((s) => !!s).map((s) => now - s!.at);
  return { connected: on || oldOn, outdated: oldOn, client: last ? last.client : null, seenMs: any.length ? Math.min(...any) : null };
}

/** Tests: forget who talked. */
export const resetMcpSeen = () => { seen = null; seenOld = null; counted.clear(); };

// ---------- the Welcome file ----------

export const welcomeDir = () => process.env.CANVAS_WELCOME_DIR ?? path.join(os.homedir(), "Documents", "Canvas");
export const WELCOME_ID = "welcome";
/** As tall as the card's content: the title, two agent rows and the footer line (src/page/widgets.css .wc). */
export const WELCOME_SIZE = { w: 400, h: 180 };

/** Left of the sample's boards, top edges level: the first thing the fitted view shows. */
function welcomeAt(doc: { children?: { x?: number; y?: number }[] }) {
  const kids = (doc.children ?? []).filter((n) => typeof n.x === "number" && typeof n.y === "number");
  const x = kids.length ? Math.min(...kids.map((n) => n.x!)) : 0;
  const y = kids.length ? Math.min(...kids.map((n) => n.y!)) : 0;
  return { x: x - WELCOME_SIZE.w - 80, y };
}

/** Makes the Welcome file once (a copy of the course, the welcome card on it) and answers its path. */
export function ensureWelcome(dir = welcomeDir(), sample = COURSE): { file: string; created: boolean } {
  const file = path.join(dir, "Welcome.canvas");
  if (fs.existsSync(path.join(file, DESIGN_FILE))) return { file: fs.realpathSync(file), created: false };
  fs.mkdirSync(dir, { recursive: true });
  // Built next to it and renamed into place: a half-copied package is never opened.
  const tmp = path.join(dir, `.Welcome-${process.pid}-${Date.now()}.canvas`);
  fs.cpSync(sample, tmp, { recursive: true });
  const doc = JSON.parse(fs.readFileSync(path.join(tmp, DESIGN_FILE), "utf8"));
  const sidecar = path.join(tmp, "widgets.json");
  const side = fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, "utf8")) : { version: 1, widgets: [] };
  const k = kindOf("welcome")!;
  const card = validateWidget({ id: WELCOME_ID, kind: k.id, name: "Welcome", ...welcomeAt(doc), ...WELCOME_SIZE, locked: false, config: k.defaults() });
  side.widgets = [card, ...(side.widgets ?? []).filter((w: { id?: string }) => w.id !== WELCOME_ID)];
  fs.writeFileSync(sidecar, JSON.stringify(side, null, 2) + "\n");
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    // Another start made it first: theirs stands.
    if (!fs.existsSync(path.join(file, DESIGN_FILE))) throw e;
  }
  return { file: fs.realpathSync(file), created: true };
}

// ---------- routes ----------

type Json = (res: http.ServerResponse, v: unknown, status?: number) => void;

export async function handleOnboardingRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, json: Json): Promise<boolean> {
  if (url.pathname === "/api/mcp/setup" && req.method === "GET") {
    const cmds = setupCommands();
    json(res, { ...cmds, ...mcpStatus(), installed: installedState(), registered: await registeredState({ server: cmds.server }), temporary: temporaryServer(cmds.server) });
    return true;
  }
  if (await handleConnectRoute(req, res, url, json, () => { const c = setupCommands(); return { node: c.node, server: c.server }; })) return true;
  if (url.pathname === "/api/mcp/hello" && req.method === "POST") {
    if (req.headers["x-canvas"] !== "1") { json(res, { error: "forbidden" }, 403); return true; }
    json(res, { ok: true, counted: noteMcp(req) });
    return true;
  }
  if (url.pathname === "/api/welcome" && req.method === "POST") {
    if (req.headers["x-canvas"] !== "1") { json(res, { error: "forbidden" }, 403); return true; }
    try {
      json(res, ensureWelcome());
    } catch (e) {
      json(res, { error: `Canvas could not make the Welcome file: ${(e as Error).message}` }, 500);
    }
    return true;
  }
  return false;
}
