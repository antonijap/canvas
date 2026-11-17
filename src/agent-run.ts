// Talk to the selection: the server runs the person's own local agent (Claude Code or Codex) headless on what is
// selected, with only the Canvas MCP tools, and streams its steps to the page (src/page/spark.js).
//
// Safety, in order of what could go wrong:
// - The harness binary must be the person's own: found on PATH or in ~/.local/bin, resolved through symlinks, owned
//   by this user and writable by nobody else. Anything else is not offered and never run.
// - Only Canvas MCP tools: Claude Code gets no built-in tools (--tools ""), only the canvas server from our own MCP
//   config (--strict-mcp-config), user/project settings, hooks and plugins skipped (--restricted), and a permission
//   mode that denies anything not allowed up front (dontAsk, no prompts). Codex runs in a read-only sandbox with its
//   shell and every other tool family off, no user config and approval "never". Tools that leave the selection
//   (open files, move the camera, change the selection, pages, widgets, undo) are denied by name.
// - The child gets a minimal environment (no API keys, tokens or other secrets from the server's environment), runs
//   in an empty folder, in its own process group: Stop, the time cap (Settings > Agents, 10 minutes by default), the output cap and the server's
//   exit kill the whole group.
// - ~/Library/Logs/Canvas/agent-runs.log gets one line per run: when, harness, file name, status, duration, edits,
//   and only the first line of the prompt (trimmed).
// The edits land through canvas-mcp like any agent's, under a session id this run names, so the run is one undo step
// (src/history.ts) and its summary is counted from exactly its own history entries.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docChanged, originOk } from "./bridge.ts";
import { displayPath } from "./docpath.ts";
import { findNode, resolveDocPath, type CanvasDoc, type DocNode } from "./engine.ts";
import { entries, finishAgent, undo, type Entry, type NodeOp } from "./history.ts";
import { listPages } from "./pages.ts";
import { agentSettings, runCapMs } from "./settings.ts";
import { changeThreads, PROMPT_MAX, readThreads, recentAsks, threadsNow, withOutcome, withRun, type Harness, type Run, type Step, type Thread } from "./threads.ts";
import { countUsage } from "./usage-counts.ts";

export const OUTPUT_MAX = 20 * 1024 * 1024;
export const LINE_MAX = 4 * 1024 * 1024;
export const MAX_RUNS = 3;
const REPO = fileURLToPath(new URL("..", import.meta.url));
const MCP_SERVER = path.join(REPO, "mcp", "server.ts");

// ---------- the harnesses ----------

export type HarnessInfo = { id: Harness; label: string; path: string; real: string };
export const HARNESS_LABEL: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };

/** Where to look: PATH, then ~/.local/bin and the usual install places (Finder starts apps with a bare PATH). */
export function searchDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  if (env.CANVAS_AGENT_PATH) return env.CANVAS_AGENT_PATH.split(":").filter(Boolean);
  const dirs = (env.PATH ?? "").split(":").filter((d) => d && path.isAbsolute(d));
  dirs.push(path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
  return [...new Set(dirs)];
}

/** Why a binary is not the person's own, or null when it is: owned by this user, writable by nobody else, nor its folder. */
export function untrusted(real: string, uid = process.getuid?.() ?? -1): string | null {
  let st: fs.Stats, dir: fs.Stats;
  try {
    st = fs.statSync(real);
    dir = fs.statSync(path.dirname(real));
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "not a file";
  if (!(st.mode & 0o111)) return "not executable";
  if (st.uid !== uid) return "owned by someone else";
  if (st.mode & 0o022) return "writable by others";
  if (dir.mode & 0o002 && !(dir.mode & 0o1000)) return "in a folder anyone can write";
  return null;
}

let harnessCache: { at: number; list: HarnessInfo[] } | null = null;
/** The installed harnesses that pass the ownership check, first found on the search path wins. Cached for a minute. */
export function detectHarnesses(force = false): HarnessInfo[] {
  if (!force && harnessCache && Date.now() - harnessCache.at < 60_000) return harnessCache.list;
  const list: HarnessInfo[] = [];
  for (const id of ["claude", "codex"] as Harness[]) {
    for (const d of searchDirs()) {
      const p = path.join(d, id);
      let real: string;
      try {
        real = fs.realpathSync(p);
      } catch {
        continue;
      }
      if (untrusted(real)) continue;
      list.push({ id, label: HARNESS_LABEL[id], path: p, real });
      break;
    }
  }
  harnessCache = { at: Date.now(), list };
  return list;
}

/** Canvas MCP tools a run may not use: they leave the selection (files, camera, selection, pages, widgets, history). */
export const DENIED_TOOLS = [
  "launch_canvas", "open_file", "close_tab", "set_theme", "fit_view", "set_zoom", "pan_view",
  "create_page", "rename_page", "delete_page", "move_boards_to_page", "set_active_page",
  "select_nodes", "clear_selection", "wait_for_selection", "get_events",
  "add_widget", "update_widget", "remove_widget", "widget_action", "refresh_widget", "reveal_widget",
  "add_video", "create_shader", "update_shader", "export_shader", "export_nodes", "undo", "redo",
  // Variations (src/variations.ts): only the person starts, keeps or discards them; only a variations run marks one done.
  "make_variations", "keep_variation", "discard_variations", "mark_variation",
];
/** Mobbin's read tools, the only ones a variations run may call (no collections, comments or saves). */
export const MOBBIN_TOOLS = ["search_screens", "search_flows", "search_sections"];

export type CommandOpts = {
  harness: HarnessInfo;
  /** The MCP session id canvas-mcp sends with every edit. */
  mcpSession: string;
  /** Claude Code: the session id of a new run (we choose it), or the one to resume. Codex: the thread to resume. */
  session?: string;
  resume: boolean;
  /** Where the run's MCP config goes (Claude Code). */
  mcpConfigPath: string;
  image?: string;
  /** More pictures after `image` (a variations run: the neighbouring boards). */
  images?: string[];
  /**
   * A variations run (src/variations.ts): the person's skills, web search and, when she has it, Mobbin's read tools
   * on top of Canvas MCP. `deny` replaces DENIED_TOOLS (it lets mark_variation through).
   */
  wide?: { mobbin?: string; deny: string[] };
  node: string;
  port: number;
  serverVersion: string;
};

/** canvas-mcp, for this run only: its session, our port, and never a server of its own. */
export function mcpServerSpec(o: Pick<CommandOpts, "node" | "mcpSession" | "port" | "serverVersion">) {
  return { command: o.node, args: [MCP_SERVER], env: { CANVAS_MCP_SESSION: o.mcpSession, CANVAS_PORT: String(o.port), CANVAS_MCP_NO_SPAWN: "1", CANVAS_MCP_NO_APP: "1", CANVAS_MCP_WANT_VERSION: o.serverVersion } };
}

/** The exact command line. The prompt goes on stdin (never in argv, where `ps` would show it). */
export function buildCommand(o: CommandOpts): { cmd: string; args: string[]; mcpConfig?: string } {
  if (o.harness.id === "claude") {
    const w = o.wide;
    const servers: Record<string, unknown> = { canvas: mcpServerSpec(o) };
    if (w?.mobbin) servers.mobbin = { type: "http", url: w.mobbin };
    const mcpConfig = JSON.stringify({ mcpServers: servers });
    // A variations run keeps skills on (no --disable-slash-commands) and gets the Skill and WebSearch tools; no
    // Read, Bash or WebFetch, so nothing it reads on the web can make it open files or send them anywhere.
    const allowed = w ? ["mcp__canvas", "Skill", "WebSearch", ...(w.mobbin ? MOBBIN_TOOLS.map((t) => `mcp__mobbin__${t}`) : [])] : ["mcp__canvas"];
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--tools", w ? "Skill,WebSearch" : "",
      "--mcp-config", o.mcpConfigPath, "--strict-mcp-config",
      "--allowedTools", allowed.join(","),
      "--disallowedTools", (w?.deny ?? DENIED_TOOLS).map((t) => `mcp__canvas__${t}`).join(","),
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--restricted", ...(w ? [] : ["--disable-slash-commands"]), "--no-chrome",
    ];
    if (o.resume && o.session) args.push("--resume", o.session);
    else if (o.session) args.push("--session-id", o.session);
    return { cmd: o.harness.real, args, mcpConfig };
  }
  const spec = mcpServerSpec(o);
  const toml = (v: unknown) => JSON.stringify(v);
  const env = `{${Object.entries(spec.env).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`;
  const conf = [
    `mcp_servers.canvas.command=${toml(spec.command)}`,
    `mcp_servers.canvas.args=${toml(spec.args)}`,
    `mcp_servers.canvas.env=${env}`,
    `mcp_servers.canvas.disabled_tools=${toml(o.wide?.deny ?? DENIED_TOOLS)}`,
    `mcp_servers.canvas.default_tools_approval_mode="approve"`,
    ...(o.wide?.mobbin ? [`mcp_servers.mobbin.url=${toml(o.wide.mobbin)}`, `mcp_servers.mobbin.enabled_tools=${toml(MOBBIN_TOOLS)}`, `mcp_servers.mobbin.default_tools_approval_mode="approve"`] : []),
    `sandbox_mode="read-only"`,
    `approval_policy="never"`,
    `web_search=${o.wide ? `"live"` : `"disabled"`}`,
  ].flatMap((c) => ["-c", c]);
  const off = ["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "image_generation", "computer_use", "browser_use", "in_app_browser", "memories", "hooks"].flatMap((f) => ["--disable", f]);
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", ...conf, ...off, ...[o.image, ...(o.images ?? [])].filter((x): x is string => !!x).flatMap((x) => ["-i", x])];
  const args = o.resume && o.session ? ["exec", "resume", o.session, ...common, "-"] : ["exec", "--sandbox", "read-only", ...common, "-"];
  return { cmd: o.harness.real, args };
}

/** What the child sees of the environment: enough to find its own login, nothing else (no keys or tokens). */
// The server's own Node is on the PATH too: a harness installed with npm is a Node script ("#!/usr/bin/env node").
export function childEnv(env: NodeJS.ProcessEnv, harnessReal: string, nodeBin = process.execPath): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: [...new Set([path.dirname(harnessReal), path.dirname(nodeBin), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":") };
  for (const k of ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "__CF_USER_TEXT_ENCODING"]) if (env[k]) out[k] = env[k];
  for (const [k, v] of Object.entries(env)) if (k.startsWith("LC_") && v) out[k] = v;
  return out;
}

// ---------- the prompt ----------

export type PromptInput = { message: string; file: string; page?: { id: string; name: string } | null; nodes: { id: string; name: string; type: string; layers: number }[]; image: boolean; followUp: boolean };

export function buildPrompt(p: PromptInput): string {
  const sel = p.nodes.map((n) => `- ${n.name} (id ${n.id}, ${n.type}, ${n.layers} ${n.layers === 1 ? "layer" : "layers"})`).join("\n");
  const rules = [
    `Work only on the selected layers and what is inside them, with the Canvas MCP tools (mcp__canvas__*). Do not change anything else in the file.`,
    `Pass file "${p.file}" to every tool that takes a file.`,
    `Start your reply with one line: "Plan: <step> | <step> | ..." (2 to 5 steps, each under 40 characters, in plain words like "Softening the shadow").`,
    `When you begin a step, write one line: "Step <n>: <the step>".`,
    `When you are done, call finish_work once with a short summary, then end with one line: "Summary: <what changed, under 120 characters>".`,
    `If the request is unclear, make the smallest change that fits it. Do not ask questions: nobody can answer them during the run.`,
  ];
  if (p.followUp) {
    return [`Follow-up on the same selection in Canvas (file ${p.file}${p.page ? `, page "${p.page.name}"` : ""}):`, sel, ``, `The person says:`, p.message, ``, `Rules, as before:`, ...rules.map((r) => `- ${r}`)].join("\n");
  }
  return [
    `You are editing a design in Canvas, a design tool, for the person using it. You can only use the Canvas MCP tools.`,
    `File: ${p.file}`,
    ...(p.page ? [`Page: ${p.page.name} (id ${p.page.id})`] : []),
    `The selection:`,
    sel,
    p.image ? `A picture of the selection as it looks now is attached. Read the layers with inspect_node before you change them.` : `Read the layers with inspect_node (and render_node to see them) before you change them.`,
    ``,
    `The person asks about exactly this selection:`,
    p.message,
    ``,
    `Rules:`,
    ...rules.map((r) => `- ${r}`),
  ].join("\n");
}

// ---------- the event stream ----------

export type AgentEvent =
  | { k: "session"; id: string }
  | { k: "text"; text: string }
  | { k: "tool"; name: string; input: Record<string, unknown> }
  | { k: "tool_error"; text: string }
  | { k: "result"; ok: boolean; text?: string }
  | { k: "error"; text: string };

const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("") : "");
const shortName = (n: string) => n.replace(/^mcp__canvas__/, "");

/** One line of Claude Code's --output-format stream-json, as the events this file uses. Unknown lines give none. */
export function parseClaudeLine(line: string): AgentEvent[] {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (!j || typeof j !== "object") return [];
  const out: AgentEvent[] = [];
  if (j.type === "system" && j.subtype === "init" && typeof j.session_id === "string") out.push({ k: "session", id: j.session_id });
  else if (j.type === "assistant" && j.message && Array.isArray(j.message.content)) {
    // An API error comes as a synthetic assistant message (a usage limit, an overload): it is the run's error.
    if (j.error || j.is_api_error_message) {
      out.push({ k: "error", text: textOf(j.message.content) || String(j.error) });
      return out;
    }
    for (const c of j.message.content) {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) out.push({ k: "text", text: c.text });
      else if (c?.type === "tool_use" && typeof c.name === "string") out.push({ k: "tool", name: shortName(c.name), input: c.input && typeof c.input === "object" ? c.input : {} });
    }
  } else if (j.type === "user" && j.message && Array.isArray(j.message.content)) {
    for (const c of j.message.content) if (c?.type === "tool_result" && c.is_error) out.push({ k: "tool_error", text: textOf(c.content).slice(0, 300) });
  } else if (j.type === "result") {
    const ok = j.subtype === "success" && !j.is_error;
    out.push({ k: "result", ok, ...(typeof j.result === "string" ? { text: j.result } : {}) });
  }
  return out;
}

/** One line of `codex exec --json`, as the events this file uses. */
export function parseCodexLine(line: string): AgentEvent[] {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (!j || typeof j !== "object") return [];
  const item = j.item ?? {};
  switch (j.type) {
    case "thread.started": return typeof j.thread_id === "string" ? [{ k: "session", id: j.thread_id }] : [];
    case "item.started":
      if (item.type === "mcp_tool_call" && typeof item.tool === "string") return [{ k: "tool", name: shortName(item.tool), input: argsOf(item.arguments) }];
      return [];
    case "item.completed":
      if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) return [{ k: "text", text: item.text }];
      if (item.type === "mcp_tool_call" && (item.status === "failed" || item.error)) return [{ k: "tool_error", text: String(item.error?.message ?? item.error ?? "failed").slice(0, 300) }];
      if (item.type === "error" && typeof item.message === "string") return [{ k: "error", text: item.message }];
      return [];
    case "turn.completed": return [{ k: "result", ok: true }];
    case "turn.failed": return [{ k: "result", ok: false, text: String(j.error?.message ?? "The run failed") }];
    case "error": return [{ k: "error", text: String(j.message ?? "error") }];
  }
  return [];
}
function argsOf(a: unknown): Record<string, unknown> {
  if (a && typeof a === "object") return a as Record<string, unknown>;
  if (typeof a === "string") {
    try {
      const j = JSON.parse(a);
      return j && typeof j === "object" ? j : {};
    } catch {}
  }
  return {};
}

// ---------- steps ----------

const READS = new Set(["get_selection", "inspect_node", "lookup_nodes", "get_document_summary", "get_fonts", "list_installed_fonts", "get_current_file", "canvas_status", "list_pages", "get_viewport", "get_theme", "list_tabs", "list_widgets", "list_widget_kinds", "list_shaders", "list_shader_presets", "list_videos"]);
const LOOKS = new Set(["render_node", "screenshot_view", "video_frame"]);

/** A tool call in plain words, for a run whose agent gave no plan. */
export function toolLabel(name: string, input: Record<string, unknown> = {}): string {
  if (READS.has(name)) return "Reading the layers";
  if (LOOKS.has(name)) return "Looking at it";
  if (name === "set_node_props") {
    const keys = Object.keys((input.props as object) ?? {}).slice(0, 3);
    return keys.length ? `Setting ${keys.join(", ")}` : "Changing properties";
  }
  const words: Record<string, string> = {
    add_nodes: "Adding layers", delete_nodes: "Removing layers", duplicate_nodes: "Duplicating layers", group_nodes: "Grouping layers",
    ungroup_nodes: "Ungrouping", reorder_nodes: "Reordering layers", place_nodes: "Moving layers", add_auto_layout: "Adding auto layout",
    remove_auto_layout: "Removing auto layout", scale_nodes: "Scaling", move_board: "Moving the board", highlight_nodes: "Pointing at layers",
    clear_highlights: "Clearing highlights", notify_user: "Leaving a note", finish_work: "Finishing up",
  };
  return words[name] ?? name.replace(/_/g, " ");
}

const PLAN_RE = /^\s*\**\s*Plan\s*\**\s*:\s*(.+)$/im;
export const PLAN_MAX = 8;
const STEP_RE = /^\s*\**\s*Step\s+(\d+)\s*\**\s*[:.)\-–]\s*(.+)$/gim;
const SUMMARY_RE = /^\s*\**\s*Summary\s*\**\s*:\s*(.+)$/im;
/** One line for the UI: no markdown bold, no middots (Canvas never uses · as a separator), collapsed spaces. */
const clean = (s: string, max: number) => s.replace(/\*\*/g, "").replace(/\s*·\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * What a run has done so far, from its events: the plan the agent announced (each "Step n:" line moves it on), or
 * one step per kind of tool call when it gave none. Feed it every event in order.
 */
export class StepTracker {
  plan: string[] | null = null;
  current = -1;
  loose: string[] = [];
  session: string | null = null;
  summary: string | null = null;
  lastText = "";
  error: string | null = null;
  ok: boolean | null = null;
  finishCalled = false;
  tools = 0;

  apply(e: AgentEvent): void {
    if (e.k === "session") this.session = e.id;
    else if (e.k === "text") {
      this.lastText = e.text;
      const plan = PLAN_RE.exec(e.text);
      if (plan && !this.plan) {
        const items = plan[1].split("|").map((s) => clean(s, 60)).filter(Boolean).slice(0, PLAN_MAX);
        if (items.length) {
          this.plan = items;
          if (this.current < 0) this.current = 0;
        }
      }
      for (const m of e.text.matchAll(STEP_RE)) {
        const n = Number(m[1]) - 1;
        // A plan has at most 8 steps: "Step 99999999:" from a confused agent must not grow the list (or hang the server).
        if (!Number.isInteger(n) || n < 0 || n >= PLAN_MAX) continue;
        const label = clean(m[2], 60);
        if (!this.plan) this.plan = [];
        while (this.plan.length <= n) this.plan.push(label);
        if (label) this.plan[n] = label;
        this.current = Math.max(this.current, n);
      }
      const sum = SUMMARY_RE.exec(e.text);
      if (sum) this.summary = clean(sum[1], 200);
    } else if (e.k === "tool") {
      this.tools++;
      if (e.name === "finish_work") this.finishCalled = true;
      if (!this.plan) {
        const label = toolLabel(e.name, e.input);
        if (this.loose[this.loose.length - 1] !== label) this.loose.push(label);
      } else if (this.current < 0) this.current = 0;
    } else if (e.k === "error") this.error = clean(e.text, 300);
    else if (e.k === "result") {
      this.ok = e.ok && !this.error;
      if (!e.ok && e.text && !this.error) this.error = clean(e.text, 300);
      if (e.ok && e.text) {
        const sum = SUMMARY_RE.exec(e.text);
        if (sum) this.summary = clean(sum[1], 200);
        this.lastText = e.text;
      }
    }
  }

  /** The steps to show. `ended`: the run is over, every step it reached is done (a stopped run keeps the rest open). */
  steps(ended: "done" | "stopped" | false = false): Step[] {
    if (this.plan) {
      return this.plan.map((label, i) => ({ label, state: ended === "done" || i < this.current ? "done" : i === this.current && !ended ? "now" : i === this.current && ended === "stopped" ? "done" : "next" }));
    }
    return this.loose.slice(-8).map((label, i, a) => ({ label, state: ended || i < a.length - 1 ? "done" : "now" }));
  }

  /** The step under way: label, 1-based index and the count, for the ring's tooltip ("Softening the shadow, 3 of 4"). */
  now(): { label: string; index: number; total: number } | null {
    const s = this.steps();
    const i = s.findIndex((x) => x.state === "now");
    return i < 0 ? null : { label: s[i].label, index: i + 1, total: s.length };
  }

  /** What the agent said it changed: its Summary line, else the last thing it said, without the protocol lines. */
  detail(): string | undefined {
    if (this.summary) return this.summary;
    const lines = this.lastText.split("\n").map((l) => l.trim()).filter((l) => l && !PLAN_RE.test(l) && !/^\**\s*Step\s+\d+/i.test(l));
    const s = lines[lines.length - 1];
    return s ? clean(s, 200) : undefined;
  }
}

// ---------- what a run changed ----------

/** "Changed 6 properties on 4 layers" from a run's undo entries; null when it changed nothing. */
export function summarize(list: Entry[]): { line: string; properties: number; layers: number; structure: number } | null {
  let properties = 0, structure = 0;
  const layers = new Set<string>();
  for (const e of list) {
    for (const op of e.ops) {
      if (op.t === "node") {
        properties += Object.keys((op as NodeOp).props).length;
        layers.add(op.id);
      } else if (op.t === "tree" || op.t === "move") {
        structure++;
        layers.add(op.t === "move" ? op.id : String(op.node?.id ?? ""));
      } else if (op.t === "widget") {
        structure++;
      }
    }
  }
  if (!properties && !structure) return null;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (properties) parts.push(n(properties, "property", "properties"));
  if (structure) parts.push(n(structure, "structure change", "structure changes"));
  return { line: `Changed ${parts.join(" and ")} on ${n(layers.size || 1, "layer", "layers")}`, properties, layers: layers.size, structure };
}

const sessionEntries = (docFile: string, session: string): Entry[] => entries(docFile).undo.filter((e) => e.agent?.session === session);

// ---------- runs ----------

export type RunView = {
  id: string; file: string; key: string; ids: string[]; harness: Harness; status: Run["status"]; prompt: string;
  steps: Step[]; now: { label: string; index: number; total: number } | null; summary?: string; detail?: string; error?: string;
  startedAt: number; endedAt?: number; seqs: number[]; session?: string;
  /** How many properties and structure changes the run made (the pill's "6 changes"). */
  changes?: number;
  /** Why another harness ran than the default ("Claude Code could not start: ... Codex ran instead."). */
  note?: string;
};

type Active = {
  view: RunView;
  docFile: string;
  mcpSession: string;
  child: ChildProcess | null;
  tracker: StepTracker;
  thread: Omit<Thread, "runs" | "createdAt" | "updatedAt">;
  stopReason: "stop" | "timeout" | "output" | null;
  timer?: NodeJS.Timeout;
  dir: string;
  launch: { harness: HarnessInfo; resume?: string; page: { id: string; name: string } | null; nodes: { id: string; name: string; type: string; layers: number }[]; image: string | null; earlier?: Run };
};

export type AgentCtx = {
  /** The document as the server has it. */
  docOf(file: string): { doc: CanvasDoc; boards: { id: string }[] } | null;
  /** The server's port and version, for canvas-mcp. */
  port(): number;
  version(): string;
  /** finish_work's gloss, toast and sound, for a run that ended without calling it. */
  finish(file: string, summary: string | undefined): Promise<unknown>;
  /** Picture of one node (PNG path), or null. */
  render?(file: string, id: string, out: string): Promise<string | null>;
  /** Tests: spawn something else. */
  spawn?: typeof spawn;
};

const runs = new Map<string, Active>();
const listeners = new Map<string, Set<http.ServerResponse>>();
const logFile = () => process.env.CANVAS_AGENT_LOG ?? path.join(os.homedir(), "Library", "Logs", "Canvas", "agent-runs.log");

function logRun(a: Active, extra: string) {
  try {
    const first = a.view.prompt.split("\n")[0].replace(/\s+/g, " ").slice(0, 100);
    const line = `${new Date().toISOString()} run=${a.view.id} harness=${a.view.harness} file=${path.basename(a.view.file)} layers=${a.view.ids.length} ${extra} prompt=${JSON.stringify(first)}\n`;
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), line);
  } catch {}
}

const keyOf = (file: string) => {
  try {
    return displayPath(resolveDocPath(file));
  } catch {
    return file;
  }
};

function broadcast(file: string, msg: unknown) {
  const set = listeners.get(keyOf(file));
  if (!set) return;
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of set) {
    try {
      res.write(data);
    } catch {}
  }
}

const pushT = new Map<string, NodeJS.Timeout>();
/** At most ten updates a second per run; the last one always goes out. */
function push(a: Active, now = false) {
  const send = () => {
    pushT.delete(a.view.id);
    broadcast(a.view.file, { type: "run", run: a.view });
  };
  if (now) {
    clearTimeout(pushT.get(a.view.id));
    send();
  } else if (!pushT.has(a.view.id)) pushT.set(a.view.id, setTimeout(send, 100));
}

export const activeRuns = (file?: string): RunView[] => [...runs.values()].filter((a) => !file || keyOf(a.view.file) === keyOf(file)).map((a) => a.view);

/** The node, its type and how many layers it holds (itself included). */
function nodeFacts(doc: CanvasDoc, id: string): { id: string; name: string; type: string; layers: number; board: string } | null {
  try {
    const f = findNode(doc, id);
    const count = (n: DocNode): number => 1 + (Array.isArray(n.children) ? (n.children as DocNode[]).reduce((s, c) => s + count(c), 0) : 0);
    const n = f.node;
    const top = f.ancestors[0] ?? n;
    return { id, name: typeof n.name === "string" && n.name ? n.name : typeof n.content === "string" ? String(n.content).slice(0, 40) : String(n.type), type: String(n.type), layers: count(n), board: String(top.id) };
  } catch {
    return null;
  }
}

/** The chip's facts for a selection: its first layer's name and how many layers the selection holds. */
export function selectionFacts(ctx: AgentCtx, file: string, ids: string[]) {
  const d = ctx.docOf(file);
  const nodes = d ? ids.map((id) => nodeFacts(d.doc, id)).filter((x): x is NonNullable<typeof x> => !!x) : [];
  const layers = nodes.reduce((s, n) => s + n.layers, 0);
  const name = nodes.length ? nodes[0].name + (nodes.length > 1 ? ` and ${nodes.length - 1} more` : "") : "";
  return { name, layers, nodes };
}

function pageOfBoard(file: string, ctx: AgentCtx, board: string): { id: string; name: string } | null {
  try {
    const d = ctx.docOf(file);
    const p = listPages(file, () => (d ? d.boards.map((b) => b.id) : [])).pages.find((x) => x.boards.includes(board));
    return p ? { id: p.id, name: p.name } : null;
  } catch {
    return null;
  }
}

/** harness: the one picked on the pill (its logo menu) for this ask; else the thread's for a follow-up, else Settings' default. */
export type StartInput = { file: string; ids: string[]; prompt: string; followUp?: boolean; harness?: Harness };

/**
 * The default harness first (Settings > Agents: Claude Code unless the person picked Codex), the other one only when
 * it is not installed. A follow-up stays with the harness its session is in.
 */
export function pickHarness(installed: HarnessInfo[], followUpHarness?: Harness, preferred: Harness = "claude"): HarnessInfo | null {
  if (followUpHarness) {
    const h = installed.find((x) => x.id === followUpHarness);
    if (h) return h;
  }
  return byPreference(installed, preferred)[0] ?? null;
}
/** The installed harnesses, the preferred one first. */
export const byPreference = (installed: HarnessInfo[], preferred: Harness = "claude"): HarnessInfo[] =>
  [...installed].sort((a, b) => (a.id === preferred ? 0 : 1) - (b.id === preferred ? 0 : 1));

/**
 * Codex steps in when Claude Code could not start: it failed before doing anything (no tool call, no edit, not
 * stopped), say a usage limit or a login problem. Once it has started working, a failure is the run's.
 */
export function fallBackTo(harness: Harness, t: Pick<StepTracker, "tools" | "ok" | "error">, edits: number, stopped: boolean, installed: HarnessInfo[]): HarnessInfo | null {
  if (harness !== "claude" || stopped || edits || t.tools || t.ok === true) return null;
  return installed.find((x) => x.id === "codex") ?? null;
}

export async function startRun(ctx: AgentCtx, inp: StartInput): Promise<RunView> {
  const file = keyOf(inp.file);
  const ids = inp.ids.filter((x) => typeof x === "string" && x && !x.startsWith("widget:")).slice(0, 50);
  if (!ids.length) throw new AgentError(400, "invalid", "Select a layer first");
  const prompt = String(inp.prompt ?? "").trim().slice(0, PROMPT_MAX);
  if (!prompt) throw new AgentError(400, "invalid", "Say what to do");
  if (runs.size + starting.size >= MAX_RUNS) throw new AgentError(409, "busy", `${MAX_RUNS} runs are going already; wait for one to finish`);
  const key = ids[0];
  const slot = `${file}\n${key}`;
  for (const a of runs.values()) if (keyOf(a.view.file) === file && a.view.key === key) throw new AgentError(409, "busy", "This layer has a run going; stop it first");
  if (starting.has(slot)) throw new AgentError(409, "busy", "This layer has a run going; stop it first");
  const facts = selectionFacts(ctx, file, ids);
  if (!facts.nodes.length) throw new AgentError(404, "not_found", "The selection is not in the file any more");
  // The slot is taken before the first await: a second Return (or a second request) in the meantime is refused
  // instead of starting a second run on the same layer, or a fourth run.
  starting.add(slot);
  try {
    const view = await startReserved(ctx, inp, file, ids, prompt, key, facts);
    countUsage("agent.prompt");
    return view;
  } finally {
    starting.delete(slot);
  }
}
const starting = new Set<string>();

async function startReserved(ctx: AgentCtx, inp: StartInput, file: string, ids: string[], prompt: string, key: string, facts: ReturnType<typeof selectionFacts>): Promise<RunView> {

  const old = (await readThreads(file).catch(() => [] as Thread[])).find((t) => t.key === key);
  const followUp = !!inp.followUp && !!old?.session;
  const harness = pickHarness(detectHarnesses(), inp.harness ?? (followUp ? old!.harness : undefined), agentSettings().harness);
  if (!harness) throw new AgentError(400, "unsupported", "Neither Claude Code nor Codex is installed (looked on PATH and in ~/.local/bin)");

  const id = randomBytes(6).toString("hex");
  const dir = path.join(os.tmpdir(), "canvas-agent", id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const page = pageOfBoard(file, ctx, facts.nodes[0].board);
  // A follow-up on another harness than the thread's starts a new session there (it cannot resume the old one).
  const resume = followUp && harness.id === old!.harness ? old!.session : undefined;
  const earlier = followUp && old ? old.runs[old.runs.length - 1] : undefined;

  const view: RunView = { id, file, key, ids, harness: harness.id, status: "running", prompt, steps: [{ label: "Starting", state: "now" }], now: null, startedAt: Date.now(), seqs: [] };
  const a: Active = {
    view, docFile: resolveDocPath(file), mcpSession: `run-${id}`, child: null, tracker: new StepTracker(), dir, stopReason: null,
    thread: { key, ids, name: facts.name, ...(page ? { page: page.id } : {}), harness: harness.id },
    launch: { harness, resume, page, nodes: facts.nodes, image: null, earlier },
  };
  runs.set(id, a);
  push(a, true);
  // The thread knows about the run at once (the spark gets its dot even if the server goes away mid-run).
  await saveRun(a).catch(() => {});

  void (async () => {
    // A resumed session has seen the selection already: no picture (and no headless Chrome) for a follow-up.
    if (ctx.render && !resume) {
      a.view.steps = [{ label: "Looking at the selection", state: "now" }];
      push(a);
      a.launch.image = await ctx.render(file, ids[0], path.join(dir, "selection.png")).catch(() => null);
    }
    if (a.stopReason) return end(ctx, a, null);
    launch(ctx, a);
  })().catch((e) => {
    a.tracker.error = (e as Error).message;
    void end(ctx, a, null);
  });
  return view;
}

/** Start (or, for a fallback, start again with another harness) the run's process and read its events. */
function launch(ctx: AgentCtx, a: Active) {
  const { harness, resume, page, nodes, image, earlier } = a.launch;
  const file = a.view.file;
  const session = resume ?? (harness.id === "claude" ? randomUUID() : undefined);
  a.view.harness = harness.id;
  a.thread.harness = harness.id;
  if (session) {
    a.view.session = session;
    a.thread.session = session;
  } else {
    delete a.view.session;
    delete a.thread.session;
  }
  const message = !resume && earlier ? `${a.view.prompt}\n\n(Earlier on this selection the person asked: "${earlier.prompt.split("\n")[0].slice(0, 300)}". ${earlier.summary ?? ""} ${earlier.detail ?? ""})`.trim() : a.view.prompt;
  const text = buildPrompt({ message, file: resolveDocPath(file), page, nodes, image: !!image && !resume, followUp: !!resume });
  const mcpConfigPath = path.join(a.dir, "mcp.json");
  const c = buildCommand({ harness, mcpSession: a.mcpSession, session, resume: !!resume, mcpConfigPath, image: (!resume && image) || undefined, node: process.execPath, port: ctx.port(), serverVersion: ctx.version() });
  if (c.mcpConfig) fs.writeFileSync(mcpConfigPath, c.mcpConfig, { mode: 0o600 });
  const cwd = path.join(os.tmpdir(), "canvas-agent", "cwd");
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  let child: ChildProcess;
  try {
    child = (ctx.spawn ?? spawn)(c.cmd, c.args, { cwd, env: childEnv(process.env, harness.real), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    a.tracker.error = `Could not start ${harness.label}: ${(e as Error).message}`;
    void end(ctx, a, null);
    return;
  }
  a.child = child;
  a.view.steps = [{ label: "Thinking", state: "now" }];
  push(a);
  clearTimeout(a.timer);
  a.timer = setTimeout(() => kill(a, "timeout"), Math.max(1000, runCapMs() - (Date.now() - a.view.startedAt)));
  child.on("error", (e) => { a.tracker.error = `${harness.label} failed to start: ${e.message}`; });
  // The prompt, on stdin. Claude Code reads one stream-json user message, with the picture as an image block.
  if (harness.id === "claude") {
    const content: unknown[] = [];
    if (image && !resume) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: fs.readFileSync(image).toString("base64") } });
    content.push({ type: "text", text });
    child.stdin?.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  } else child.stdin?.end(text);
  child.stdin?.on("error", () => {});

  const parse = harness.id === "claude" ? parseClaudeLine : parseCodexLine;
  let buf = "", total = 0, stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    total += chunk.length;
    if (total > OUTPUT_MAX) return kill(a, "output");
    buf += chunk;
    if (buf.length > LINE_MAX && !buf.includes("\n")) { buf = ""; return; }
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      for (const ev of parse(line)) a.tracker.apply(ev);
      refresh(a);
      push(a);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (s: string) => { if (stderr.length < 16_000) stderr += s; });
  child.on("close", (code) => {
    if (a.child !== child) return;
    if (buf.trim()) for (const ev of parse(buf)) a.tracker.apply(ev);
    if (code !== 0 && !a.tracker.error && !a.stopReason && a.tracker.ok !== true) {
      const last = stderr.trim().split("\n").filter(Boolean).slice(-1)[0];
      a.tracker.error = last ? last.slice(0, 300) : `${harness.label} exited with code ${code}`;
    }
    void end(ctx, a, code);
  });
}

function refresh(a: Active) {
  const t = a.tracker;
  if (t.session && !a.view.session) {
    a.view.session = t.session;
    a.thread.session = t.session;
  }
  const steps = t.steps();
  if (steps.length) a.view.steps = steps;
  a.view.now = t.now();
  a.view.seqs = sessionEntries(a.docFile, a.mcpSession).map((e) => e.seq);
}

function kill(a: Active, why: "stop" | "timeout" | "output") {
  if (!a.stopReason) a.stopReason = why;
  const pid = a.child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }, 2000).unref();
}

/** Stop a run: its process group goes, the edits made so far stay (one undo step). */
export function stopRun(id: string): boolean {
  const a = runs.get(id);
  if (!a) return false;
  kill(a, "stop");
  if (!a.child) a.stopReason = "stop";
  return true;
}

// Quitting the server (the app quits) takes every run's process group with it.
process.on("exit", () => {
  for (const a of runs.values()) {
    if (!a.child?.pid) continue;
    try {
      process.kill(-a.child.pid, "SIGKILL");
    } catch {}
  }
});

async function end(ctx: AgentCtx, a: Active, code: number | null) {
  if (a.view.status !== "running") return;
  clearTimeout(a.timer);
  const t = a.tracker;
  const mine = sessionEntries(a.docFile, a.mcpSession);
  const backup = fallBackTo(a.launch.harness.id, t, mine.length, !!a.stopReason, detectHarnesses());
  if (backup && (t.error || t.ok === false || code !== 0)) {
    const why = clean(t.error ?? `exited with code ${code}`, 160);
    logRun(a, `status=fallback from=${a.launch.harness.id} to=${backup.id}${code !== null ? ` code=${code}` : ""}`);
    a.view.note = `Claude Code could not start (${why}). Codex ran instead.`;
    a.tracker = new StepTracker();
    a.launch = { ...a.launch, harness: backup, resume: undefined, earlier: a.launch.earlier };
    a.child = null;
    launch(ctx, a);
    return;
  }
  const sum = summarize(mine);
  const stopped = !!a.stopReason;
  const failed = !stopped && (t.ok === false || !!t.error || (t.ok === null && code !== 0));
  a.view.status = stopped ? "stopped" : failed ? "failed" : "done";
  a.view.steps = t.steps(stopped || failed ? "stopped" : "done");
  if (!a.view.steps.length) a.view.steps = [];
  a.view.now = null;
  a.view.seqs = mine.map((e) => e.seq);
  if (sum) a.view.changes = sum.properties + sum.structure;
  a.view.summary = sum?.line ?? (stopped ? "Stopped before any change" : failed ? undefined : "Nothing changed");
  const detail = t.detail();
  if (detail) a.view.detail = detail;
  if (stopped) a.view.error = a.stopReason === "timeout" ? `Stopped after ${agentSettings().runCapMin} minute${agentSettings().runCapMin === 1 ? "" : "s"}` : a.stopReason === "output" ? "Stopped: the agent wrote too much output" : undefined;
  else if (failed) a.view.error = t.error ?? "The run failed";
  a.view.endedAt = Date.now();
  if (a.view.status === "done") countUsage("agent.run_done");
  // The run's undo step closes and takes the summary as its name; one it never glossed is glossed now.
  finishAgent(a.mcpSession, (a.view.detail ?? a.view.summary)?.slice(0, 140));
  if (sum && !t.finishCalled) await ctx.finish(a.view.file, a.view.detail ?? a.view.summary).catch(() => {});
  await saveRun(a).catch(() => {});
  runs.delete(a.view.id);
  push(a, true);
  logRun(a, `status=${a.view.status} ms=${a.view.endedAt - a.view.startedAt} edits=${mine.length} props=${sum?.properties ?? 0}${code !== null ? ` code=${code}` : ""}`);
  try {
    fs.rmSync(a.dir, { recursive: true, force: true });
  } catch {}
}

async function saveRun(a: Active) {
  const v = a.view;
  const run: Run = {
    id: v.id, prompt: v.prompt, at: v.startedAt, status: v.status, steps: v.steps,
    ...(v.endedAt ? { endedAt: v.endedAt } : {}), ...(v.summary ? { summary: v.summary } : {}), ...(v.detail ? { detail: v.detail } : {}),
    ...(v.error ? { error: v.error } : {}), ...(v.seqs.length ? { seqs: v.seqs } : {}), ...(v.changes ? { changes: v.changes } : {}),
  };
  const list = await changeThreads(v.file, (l) => withRun(l, a.thread, run));
  broadcast(v.file, { type: "threads", threads: list });
}

/** Undo a run: its entries, newest first, while they are the newest in the history. */
export async function undoRun(file: string, key: string, runId: string): Promise<{ undone: number; label?: string }> {
  const docFile = resolveDocPath(file);
  const t = (await readThreads(file)).find((x) => x.key === key);
  const run = t?.runs.find((r) => r.id === runId);
  if (!run) throw new AgentError(404, "not_found", "No such run");
  const seqs = new Set(run.seqs ?? []);
  // Every step of the run still in the history must be on top, together: another run (or anyone) editing the same
  // file in between leaves its steps among the run's, and undoing only the top part is not undoing the run.
  const stack = entries(docFile).undo;
  const mine = stack.filter((e) => seqs.has(e.seq));
  if (seqs.size && (!mine.length || !stack.slice(-mine.length).every((e) => seqs.has(e.seq)))) throw new AgentError(409, "moved", "Other edits came after this run; undo them first (Cmd+Z)");
  let undone = 0;
  for (let i = 0; i < mine.length; i++) {
    const top = entries(docFile).undo.at(-1);
    if (!top || !seqs.has(top.seq)) break;
    await undo(docFile, { docWritten: (p, rev) => docChanged(p, rev, "inspector", { undo: true }) }, { expect: top.seq });
    undone++;
  }
  const list = await changeThreads(file, (l) => withOutcome(l, key, runId, "undone"));
  broadcast(file, { type: "threads", threads: list });
  return { undone };
}

export class AgentError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- HTTP ----------

const SYMBOLS = path.join(REPO, "src", "page", "symbols");

/**
 * A JSON object body. The bytes are joined first and decoded once: decoding chunk by chunk turns a character split
 * across two chunks (an accented letter, an emoji in a prompt) into U+FFFD.
 */
export async function jsonBody(req: AsyncIterable<Buffer | string>, max = 64 * 1024): Promise<Record<string, any>> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    n += b.length;
    if (n > max) throw new AgentError(413, "too_large", "The request is too large");
    parts.push(b);
  }
  const s = Buffer.concat(parts).toString("utf8");
  if (!s) return {};
  const j = JSON.parse(s);
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new AgentError(400, "invalid", "Expected a JSON object");
  return j;
}

/**
 * GET  /api/agent/harnesses                  the installed harnesses
 * GET  /api/agent/context?file=&ids=a,b      the chip (name, layers), this layer's thread, the runs going
 * GET  /api/agent/recent?file=               the palette's Recent asks, newest first
 * GET  /api/agent/events?file=               SSE: {type:"hello"|"run"|"threads"}
 * GET  /api/agent/symbols/<name>.png         the SF Symbols the page draws (masks)
 * POST /api/agent/run   {file, ids, prompt, harness?, followUp?}
 * POST /api/agent/stop  {run}
 * POST /api/agent/undo  {file, key, run}
 * POST /api/agent/keep  {file, key, run}
 */
export async function handleAgentRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AgentCtx): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/agent/")) return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (!originOk(req)) return reply(403, { error: "forbidden", code: "forbidden" }), true;
    if (req.method !== "GET" && req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    if (p.startsWith("/api/agent/symbols/")) {
      const name = decodeURIComponent(p.slice("/api/agent/symbols/".length));
      if (!/^[a-z0-9.]+\.png$/.test(name)) return reply(404, { error: "not found" }), true;
      try {
        const b = fs.readFileSync(path.join(SYMBOLS, name));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
        res.end(b);
      } catch {
        reply(404, { error: "not found" });
      }
      return true;
    }
    // The harness marks (template images: black on transparent), drawn by the page as masks in the text colour.
    if (p === "/api/agent/logo/claude.png" || p === "/api/agent/logo/codex.png") {
      try {
        const b = fs.readFileSync(path.join(REPO, "apps", "macos", "Harness", `${p.endsWith("claude.png") ? "claude" : "codex"}-template.png`));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
        res.end(b);
      } catch {
        reply(404, { error: "not found" });
      }
      return true;
    }
    if (p === "/api/agent/harnesses") return reply(200, { harnesses: byPreference(detectHarnesses(), agentSettings().harness).map(({ id, label }) => ({ id, label })) }), true;
    const file = url.searchParams.get("file");
    if (req.method === "GET") {
      if (!file) return reply(400, { error: "file is required", code: "invalid" }), true;
      if (p === "/api/agent/context") {
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 50);
        const f = selectionFacts(ctx, file, ids);
        const thread = (await readThreads(file)).find((t) => t.key === ids[0]) ?? null;
        return reply(200, { name: f.name, layers: f.layers, thread, runs: activeRuns(file), harnesses: detectHarnesses().map(({ id, label }) => ({ id, label })) }), true;
      }
      if (p === "/api/agent/recent") {
        const d = ctx.docOf(file);
        const list = await readThreads(file);
        const asks = recentAsks(list, (id) => {
          const n = d ? nodeFacts(d.doc, id) : null;
          return n ? { name: n.name, board: n.board } : null;
        }, (board) => pageOfBoard(file, ctx, board));
        return reply(200, { asks }), true;
      }
      if (p === "/api/agent/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const k = keyOf(file);
        let set = listeners.get(k);
        if (!set) listeners.set(k, (set = new Set()));
        set.add(res);
        res.write(`retry: 2000\ndata: ${JSON.stringify({ type: "hello", runs: activeRuns(file), threads: threadsNow(file) })}\n\n`);
        const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15_000);
        req.on("close", () => {
          clearInterval(ping);
          set!.delete(res);
          if (!set!.size) listeners.delete(k);
        });
        return true;
      }
      return reply(404, { error: "not found" }), true;
    }
    const b = await jsonBody(req);
    if (p === "/api/agent/run") {
      const v = await startRun(ctx, { file: String(b.file ?? ""), ids: Array.isArray(b.ids) ? b.ids : [], prompt: String(b.prompt ?? ""), followUp: b.followUp === true, harness: b.harness === "codex" || b.harness === "claude" ? b.harness : undefined });
      return reply(200, { ok: true, run: v }), true;
    }
    if (p === "/api/agent/stop") return reply(200, { ok: stopRun(String(b.run ?? "")) }), true;
    if (p === "/api/agent/undo") return reply(200, { ok: true, ...(await undoRun(String(b.file ?? ""), String(b.key ?? ""), String(b.run ?? ""))) }), true;
    if (p === "/api/agent/keep") {
      const list = await changeThreads(String(b.file ?? ""), (l) => withOutcome(l, String(b.key ?? ""), String(b.run ?? ""), "kept"));
      broadcast(String(b.file ?? ""), { type: "threads", threads: list });
      return reply(200, { ok: true }), true;
    }
    return reply(404, { error: "not found" }), true;
  } catch (e) {
    if (e instanceof AgentError) return reply(e.status, { error: e.message, code: e.code }), true;
    if (e instanceof SyntaxError) return reply(400, { error: "invalid JSON", code: "invalid" }), true;
    const st = (e as { status?: number }).status;
    return reply(typeof st === "number" ? st : 500, { error: (e as Error).message, code: "failed" }), true;
  }
}

/** A picture of one node, made in a child process (the headless renderer blocks its thread). PNG path or null. */
export function renderInChild(port: number) {
  return (file: string, id: string, out: string): Promise<string | null> => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, "src", "agent-render.ts"), String(port), resolveDocPath(file), id, out], { stdio: "ignore", env: { ...process.env } });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(null); }, 30_000);
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(out) ? out : null);
    });
  });
}
