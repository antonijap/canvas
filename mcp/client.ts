// HTTP to the Canvas server, errors as ToolError, the server start-up and event-cursor rules.
// stdout is the MCP protocol: nothing in this folder may write to it.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { codeRootId, mcpCodeVersion, version as codeVersion } from "../src/version.ts";

/** How often canvas-mcp says hello; src/onboarding.ts calls it gone after OFF_AFTER_MS (50 s) of silence. */
export const HEARTBEAT_MS = 20_000;

export class ToolError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** This MCP process's id: the server's undo history keeps one agent step per session until finish_work. */
// A run Canvas started itself (src/agent-run.ts) names its session, so it can count and undo exactly that run's edits.
const NAMED = process.env.CANVAS_MCP_SESSION;
export const SESSION = NAMED && /^[A-Za-z0-9_-]{4,64}$/.test(NAMED) ? NAMED : `mcp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** The MCP client's own name (its initialize clientInfo, "claude-code"): the agent cursor's tag (src/agent-cursor.ts). */
let AGENT = "";
export const setAgentName = (name: unknown) => void (AGENT = typeof name === "string" ? name.replace(/[^\w .:@/-]/g, "").slice(0, 80) : "");

export const background = () => process.env.CANVAS_MCP_BACKGROUND === "1";
export const PORT = () => {
  const port = Number(process.env.CANVAS_PORT ?? (background() ? 5199 : 5189));
  return background() && port === 5189 ? 5199 : port;
};
export const backgroundError = (name: string) => new ToolError("background_mode", `${name} needs the person's window.`, "Use render_node to look; ask the person to open the file.");
export const BASE = () => `http://127.0.0.1:${PORT()}`;
export const SERVER_SCRIPT = fileURLToPath(new URL("../src/server.ts", import.meta.url));
export const REPO = fileURLToPath(new URL("..", import.meta.url));

const WIDGET_CODES: Record<string, string> = {
  "no-widget": "not_found", "no-page": "not_found", "no-board": "not_found", "invalid-pages": "invalid", "last-page": "invalid", "no-file": "not_found", "unknown-action": "not_found", "not-found": "not_found",
  "invalid-widget": "invalid", "invalid-config": "invalid", "unknown-kind": "invalid", "bad-body": "invalid", "bad-json": "invalid", "file-required": "invalid", "bad-ref": "invalid",
  "rev-mismatch": "stale_revision", "id-exists": "invalid", "no-source": "unsupported", throttled: "throttled", locked: "invalid", forbidden: "forbidden",
};

/** Last server boot id seen; a change means the server restarted and event cursors are void. */
let boot: string | undefined;
const bootListeners: (() => void)[] = [];
export const onBootChange = (f: () => void) => void bootListeners.push(f);
export const currentBoot = () => boot;
function seeBoot(b: unknown) {
  if (typeof b !== "string") return;
  if (boot && boot !== b) for (const f of bootListeners) f();
  boot = b;
}

/**
 * The code this process loaded (src and mcp, src/version.ts mcpCodeVersion), worked out once at start: an update that
 * replaces the files later does not change what runs here. With the copy it comes from (codeRootId), the server tells
 * an MCP of its own copy whose code is gone (older: its agent session must restart) from another copy's (src/onboarding.ts).
 */
const LOADED_VERSION = mcpCodeVersion(fileURLToPath(new URL("../src/", import.meta.url)));
const LOADED_ROOT = codeRootId(fileURLToPath(new URL("../src/", import.meta.url)));
/** Who asks, on every request: the agent's name and this MCP's code version and copy. */
const who = (): Record<string, string> => ({ "x-canvas-mcp-version": LOADED_VERSION, "x-canvas-mcp-root": LOADED_ROOT, ...(AGENT ? { "x-canvas-agent": AGENT } : {}) });
/** Reads say who asks (x-canvas-mcp: the session), so the Welcome card and Settings > Agents can show "Connected". */
const readHeaders = (): Record<string, string> => ({ "x-canvas-mcp": SESSION, ...who() });
/** Writes say they come from an MCP (x-canvas-source), for the undo history and the agent cursor. */
const writeHeaders = (): Record<string, string> => ({ "x-canvas": "1", "content-type": "application/json", "x-canvas-source": "mcp", "x-canvas-session": SESSION, ...who() });

/** canvas-mcp is here: on connect, then every HEARTBEAT_MS while it runs (src/onboarding.ts). Never starts a server. */
export function sayHello(): void {
  if (background()) return;
  const once = () => fetch(`${BASE()}/api/mcp/hello`, {
    method: "POST",
    headers: writeHeaders(),
    body: "{}",
    signal: AbortSignal.timeout(1500),
  }).then((r) => r.body?.cancel(), () => {});
  void once();
  if (NAMED?.startsWith("run-")) return; // Canvas's own runs do not count; one hello is enough for their cursor tag
  setInterval(once, HEARTBEAT_MS).unref();
}

/** `root`: which copy of the code the server runs (src/version.ts codeRootId); older servers leave it out. */
export type Health = { ok: boolean; version: string; root?: string; headless?: boolean };

export async function health(timeoutMs = 800): Promise<Health | undefined> {
  try {
    const r = await fetch(`${BASE()}/health`, { headers: readHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? ((await r.json()) as Health) : undefined;
  } catch {
    return undefined;
  }
}

export const noServer = () => new ToolError("no_server", `No Canvas server answers on port ${PORT()}`, "Call launch_canvas, or start it with: pnpm start in the canvas repo.");

/** Raw call. Errors from the server become ToolError with its code. */
export async function api<T = any>(method: string, path: string, body?: unknown, o: { timeoutMs?: number } = {}): Promise<T> {
  if (background() && path.startsWith("/api/bridge/state")) throw new ToolError("invalid", "Background mode needs explicit node ids", "Pass id or ids; selection belongs to the person.");
  let r: Response;
  try {
    r = await fetch(BASE() + path, {
      method,
      headers: method === "GET" ? readHeaders() : writeHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new ToolError("timeout", `${method} ${path} did not answer in time`);
    throw noServer();
  }
  seeBoot(r.headers.get("x-canvas-boot"));
  const text = await r.text();
  let j: any;
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { error: text.slice(0, 200) };
  }
  if (!r.ok) {
    const e = j?.error;
    if (e && typeof e === "object") throw new ToolError(String(e.code ?? "failed"), String(e.message ?? "request failed"), e.hint);
    const code = String(j?.code ?? (r.status === 404 ? "not_found" : r.status === 409 ? "stale_revision" : r.status === 400 || r.status === 422 ? "invalid" : "failed"));
    throw new ToolError(WIDGET_CODES[code] ?? code, String(e ?? `HTTP ${r.status}`), j?.retryAfterSec ? `Try again in ${j.retryAfterSec}s.` : undefined);
  }
  if (j && typeof j === "object") seeBoot(j.boot);
  return j as T;
}

export function spawnServer(file?: string): void {
  const child = spawn(process.execPath, [SERVER_SCRIPT, ...(file ? [file] : [])], { detached: true, stdio: "ignore", env: { ...process.env, CANVAS_PORT: String(PORT()), ...(background() ? { CANVAS_HEADLESS: "1" } : {}) } });
  child.on("error", () => {});
  child.unref();
}

export async function waitHealthy(ms: number, want?: string): Promise<Health | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const h = await health();
    if (h && (!want || h.version === want)) return h;
    if (Date.now() > end) return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Make sure a server answers. Starts one (no window) unless CANVAS_MCP_NO_SPAWN=1. */
export async function ensureServer(): Promise<void> {
  const check = (h: Health) => {
    if (background() && !h.headless) throw new ToolError("background_mode", `Port ${PORT()} is not a headless Canvas server`, "Choose an unused CANVAS_PORT other than 5189. The app is untouched.");
  };
  const h = await health();
  if (h) { check(h); return; }
  if (process.env.CANVAS_MCP_NO_SPAWN === "1") throw noServer();
  spawnServer();
  const started = await waitHealthy(8000);
  if (started) { check(started); return; }
  throw new ToolError("no_server", `The Canvas server did not start on port ${PORT()}`, "Is something else using the port? Set CANVAS_PORT, or run pnpm start in the canvas repo to see the error.");
}

/** The version a running server must report to count as current. CANVAS_MCP_WANT_VERSION pins it (tests do, so edits to src/ mid-run cannot flip the answer). */
export const wantVersion = (): string => process.env.CANVAS_MCP_WANT_VERSION || codeVersion();

/** This MCP's copy of the code, to compare with Health.root. CANVAS_MCP_WANT_ROOT pins it for tests. */
export const wantRoot = (): string => process.env.CANVAS_MCP_WANT_ROOT || codeRootId(fileURLToPath(new URL("../src/", import.meta.url)));

/**
 * Whether the running server is older code of this MCP's own copy, and so worth replacing. A server that another copy
 * runs (the installed Canvas.app, while this MCP runs from a checkout) is not stale: it runs its own code, and
 * replacing it would swap the app's server for the checkout's.
 */
export function staleness(h: Health): { stale: boolean; otherCopy: boolean } {
  const otherCopy = Boolean(h.root) && h.root !== wantRoot();
  return { stale: !otherCopy && h.version !== wantVersion(), otherCopy };
}

export const OTHER_COPY_NOTE = "The running server is another copy of Canvas (usually the installed app) with its own code. That is expected; it is not stale and is not replaced.";

export type Status = {
  boot: string;
  version: string;
  seq: number;
  pages: { client: string; host: string; file: string | null; visible: boolean; focused: boolean; docRevision: string | null; selection: string[]; page?: string | null }[];
  shell: { client: string; windowFocused: boolean | null; windowVisible: boolean | null; theme: { mode: string; effective: string } | null; openFiles: string[]; currentFile: string | null } | null;
  active: { client: string; file: string | null } | null;
};

export async function status(): Promise<Status> {
  await ensureServer();
  return api<Status>("GET", "/api/bridge/status");
}

/** The file a tool means: the one passed, else the active page's, else the app's front tab. */
export async function resolveFile(file?: string): Promise<string> {
  if (file) return file;
  if (background()) throw new ToolError("invalid", "background mode needs file", "Pass file or a canvas:// link naming the file.");
  const s = await status();
  const f = s.active?.file ?? s.shell?.currentFile ?? s.pages[0]?.file;
  if (!f) throw new ToolError("invalid", "file is required: no canvas page or tab is open", "Pass file, or open one with open_file.");
  return f;
}

export type Cmd = { op: string; args?: Record<string, unknown>; client?: string; file?: string; timeoutMs?: number };
export type CmdOut = { ok: true; result: any; client: string; role: string; others?: unknown[] };

/** Run a command on a page or the shell and wait for its answer. */
export async function cmd(c: Cmd): Promise<CmdOut> {
  if (background()) throw new ToolError("no_page", "Background mode has no live page", "Use render_node to look at the file.");
  await ensureServer();
  try {
    return await api<CmdOut>("POST", "/api/bridge/cmd", c, { timeoutMs: (c.timeoutMs ?? 10_000) + 3000 });
  } catch (e) {
    if (e instanceof ToolError && e.code === "no_page") e.hint = 'Use CANVAS_MCP_BACKGROUND=1 with file for disk tools, or ask the person to open the file with open_file focus:true.';
    throw e;
  }
}

export async function waitEvents(since: number | undefined, types: string[] | undefined, timeoutMs: number, limit?: number) {
  await ensureServer();
  const q = new URLSearchParams();
  if (since !== undefined) q.set("since", String(since));
  if (types?.length) q.set("types", types.join(","));
  q.set("timeoutMs", String(timeoutMs));
  if (limit) q.set("limit", String(limit));
  return api<{ events: any[]; next: number; seq: number; boot: string }>("GET", `/api/bridge/wait?${q}`, undefined, { timeoutMs: timeoutMs + 5000 });
}
