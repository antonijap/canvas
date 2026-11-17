// The bridge: what lets an agent see and drive the running canvas. Pages (browser or the app's
// WKWebView) and the app's shell connect over SSE, report their state with POST /api/state and
// execute commands the MCP queues with POST /api/bridge/cmd. The full wire format is in
// .planning/bridge-contract.md. MCP and shell only ever talk HTTP to this file.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type { Snapshot } from "./boards.ts";
import { displayPath, pathExists, resolveDoc } from "./docpath.ts";
import { findNode, findNodes, resolveDocPath, type CanvasDoc, type DocNode } from "./engine.ts";
import { fontStatuses, systemFonts } from "./fonts.ts";
import { finishAgent } from "./history.ts";
import { listPages } from "./pages.ts";
import { setAgentSettings } from "./settings.ts";
import { usage } from "./usage-counts.ts";
import { boardIndex, boardOf, fontsUsed, summaryOf } from "./summary.ts";
import { version } from "./version.ts";

export type NodeHit = { node: DocNode; parentId: string; index: number; path: boolean };
export type BridgeCtx = {
  snapOf(file: string): Snapshot;
  /** Load a document without blocking the event loop, so snapOf and the sync path helpers answer from memory. */
  prime?(file: string): Promise<void>;
  nodeAt(snap: Snapshot, id: string, depth?: number): NodeHit | undefined;
};

type Role = "page" | "shell";
type Json = Record<string, any>;

type Client = {
  id: string;
  role: Role;
  host: "native" | "browser";
  res: http.ServerResponse;
  connectedAt: number;
  file?: string;
  state?: Json;
  stateAt: number;
  seq: number;
};

type Pending = { client: string; op: string; resolve: (v: unknown) => void; reject: (e: BridgeError) => void; timer: NodeJS.Timeout };

export class BridgeError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const STATUS: Record<string, number> = { forbidden: 403, invalid: 400, not_found: 404, no_page: 503, no_shell: 503, client_gone: 503, timeout: 504, unsupported: 501, failed: 500, too_large: 413 };

const boot = randomBytes(5).toString("hex");
const clients = new Map<string, Client>();
const pending = new Map<string, Pending>();
let cmdCounter = 0;

// ---------- events ring ----------

export type BridgeEvent = { seq: number; t: number; type: string } & Json;
const RING = 500;
const ring: BridgeEvent[] = [];
let seq = 0;
const waiters = new Set<{ since: number; types?: Set<string>; wake: () => void }>();

export function emit(type: string, payload: Json = {}): BridgeEvent {
  const ev = { seq: ++seq, t: Date.now(), type, ...payload } as BridgeEvent;
  ring.push(ev);
  if (ring.length > RING) ring.shift();
  for (const w of [...waiters]) if (ev.seq > w.since && (!w.types || w.types.has(type))) w.wake();
  return ev;
}

const eventsSince = (since: number, types?: Set<string>, limit = 100) => ring.filter((e) => e.seq > since && (!types || types.has(e.type))).slice(0, limit);

const lastDoc = new Map<string, string>();
/** A document changed on disk. `by` is who wrote it when we know; a change nobody announced came from outside. */
export function docChanged(docFile: string, revision: string, by?: "inspector" | "mcp", extra: Json = {}) {
  const file = displayPath(docFile);
  if (lastDoc.get(file) === revision) return;
  lastDoc.set(file, revision);
  emit("doc", { file, revision, by: by ?? "external", ...extra });
}
/** Remember a revision without announcing it (first load). */
export function noteDoc(docFile: string, revision: string) {
  const file = displayPath(docFile);
  if (!lastDoc.has(file)) lastDoc.set(file, revision);
}

// ---------- clients, active pick ----------

const shellClient = (): Client | undefined => [...clients.values()].filter((c) => c.role === "shell").sort((a, b) => b.connectedAt - a.connectedAt)[0];

const isFocused = (c: Client): boolean => c.state?.focused === true || (c.host === "native" && shellClient()?.state?.windowFocused === true);

function pageRank(c: Client): [number, number, number] {
  return [isFocused(c) ? 1 : 0, Number(c.state?.lastInputAt) || 0, c.stateAt];
}

/** Connected and visible pages first, then by focus, last input, last report. A hidden page is a last resort. */
export function pickPage(opts: { client?: string; file?: string } = {}): { page?: Client; others: Client[] } {
  if (opts.client) {
    const c = clients.get(opts.client);
    return { page: c?.role === "page" ? c : undefined, others: [] };
  }
  let pages = [...clients.values()].filter((c) => c.role === "page" && c.state);
  if (opts.file) {
    const f = safeResolve(opts.file);
    pages = pages.filter((c) => c.state?.file === f);
  }
  const vis = (c: Client) => c.state?.visible !== false;
  pages.sort((a, b) => Number(vis(b)) - Number(vis(a)) || pageRank(b)[0] - pageRank(a)[0] || pageRank(b)[1] - pageRank(a)[1] || pageRank(b)[2] - pageRank(a)[2]);
  return { page: pages[0], others: pages.slice(1) };
}

function safeResolve(file: string): string {
  try {
    return resolveDoc(file).displayPath;
  } catch {
    return file;
  }
}

const pageSummary = (c: Client) => ({
  client: c.id,
  host: c.host,
  file: c.state?.file ?? c.file ?? null,
  visible: c.state?.visible !== false,
  focused: isFocused(c),
  docRevision: c.state?.docRevision ?? null,
  renderer: c.state?.renderer ?? null,
  page: c.state?.page ?? null,
  selection: c.state?.selection?.ids ?? [],
  lastInputAt: c.state?.lastInputAt ?? null,
  reportedAt: c.stateAt,
  ...(c.state?.perf ? { perf: c.state.perf } : {}),
});

const shellSummary = (c: Client | undefined) =>
  c && {
    client: c.id,
    windowFocused: c.state?.windowFocused ?? null,
    windowVisible: c.state?.windowVisible ?? null,
    theme: c.state?.theme ?? null,
    openFiles: c.state?.openFiles ?? [],
    currentFile: c.state?.currentFile ?? null,
    reportedAt: c.stateAt,
  };

// ---------- commands ----------

const SHELL_OPS = new Set(["tabs", "open", "close", "theme.get", "theme.set", "snapshot", "fonts", "toast", "activate", "ping", "sound"]);
/**
 * Native QA input (pnpm qa:native): a QA build of the app answers qa.* ops (post mouse and key events into its own
 * window, read its state, screenshot it). Only a server started with CANVAS_QA=1 forwards them; any other server
 * refuses them, and the normal app has no code for them.
 */
export const isQaOp = (op: string, env: NodeJS.ProcessEnv = process.env): boolean => env.CANVAS_QA === "1" && /^qa\.[a-z]+$/.test(op);
const PAGE_OPS = new Set(["select", "deselect", "fit", "zoom", "pan", "highlight", "clear_highlights", "measure", "navigate", "toast_fallback", "gloss", "freeze", "thaw", "page", "shader_frame", "video_frame"]);

const str = (v: unknown, name: string, max = 500): string => {
  if (typeof v !== "string" || !v || v.length > max) throw new BridgeError("invalid", `${name} must be a non-empty string of at most ${max} characters`);
  return v;
};
const num = (v: unknown, name: string, lo: number, hi: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new BridgeError("invalid", `${name} must be a number from ${lo} to ${hi}`);
  return v;
};
const opt = <T,>(v: unknown, f: (x: unknown) => T): T | undefined => (v === undefined || v === null ? undefined : f(v));
const oneOf = <T extends string>(v: unknown, name: string, list: readonly T[]): T => {
  if (!list.includes(v as T)) throw new BridgeError("invalid", `${name} must be one of ${list.join(", ")}`);
  return v as T;
};
const ids = (v: unknown, name = "ids", max = 20, min = 1): string[] => {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw new BridgeError("invalid", `${name} must be a list of ${min} to ${max} node ids`);
  return v.map((x) => str(x, "id", 200));
};
const existingDoc = (v: unknown): string => {
  const raw = str(v, "file", 2000);
  let d;
  try {
    d = resolveDoc(raw);
  } catch (e) {
    throw new BridgeError("invalid", `file must be a .canvas document: ${(e as Error).message}`);
  }
  if (!pathExists(d.docFilePath)) throw new BridgeError("not_found", `No such file: ${d.displayPath}`);
  return d.displayPath;
};
const toastArgs = (a: Json): Json => {
  if (a.clear === true) return { id: str(a.id, "id", 40), clear: true };
  return {
    message: str(a.message, "message", 200),
    level: opt(a.level, (x) => oneOf(x, "level", ["info", "success", "warn", "error"] as const)) ?? "info",
    durationMs: opt(a.durationMs, (x) => num(x, "durationMs", 0, 120_000)) ?? 4000,
    ...(a.id !== undefined ? { id: str(a.id, "id", 40) } : {}),
  };
};
const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;

/** Server-side argument check: only known keys get through, with limits. */
function cleanArgs(op: string, a: Json): Json {
  switch (op) {
    case "tabs": case "theme.get": case "fonts": case "activate": case "ping": case "deselect": case "clear_highlights": case "freeze": case "thaw": return {};
    case "open": return { file: existingDoc(a.file), focus: a.focus === true };
    case "close": return a.file === undefined ? {} : { file: safeResolve(str(a.file, "file", 2000)) };
    case "theme.set": return { mode: oneOf(a.mode, "mode", ["light", "dark", "system"] as const) };
    case "snapshot": return {
      maxSide: opt(a.maxSide, (x) => num(x, "maxSide", 100, 4000)) ?? 1600,
      format: opt(a.format, (x) => oneOf(x, "format", ["png", "jpeg"] as const)) ?? "png",
      ...(a.quality !== undefined ? { quality: num(a.quality, "quality", 0, 1) } : {}),
    };
    case "toast": case "toast_fallback": return toastArgs(a);
    case "select": return { ids: ids(a.ids, "ids", 20), reveal: a.reveal !== false };
    case "fit": return {
      ...(a.ids !== undefined ? { ids: ids(a.ids, "ids", 50) } : {}),
      padding: opt(a.padding, (x) => num(x, "padding", 0, 500)) ?? 70,
      maxZoomPercent: opt(a.maxZoomPercent, (x) => num(x, "maxZoomPercent", 2, 800)) ?? 400,
    };
    case "zoom": {
      const anchor = a.anchor;
      return {
        percent: num(a.percent, "percent", 2, 800),
        ...(anchor === undefined || anchor === "center" || anchor === "selection" ? (anchor ? { anchor } : {}) : { anchor: { x: num(anchor?.x, "anchor.x", -1e7, 1e7), y: num(anchor?.y, "anchor.y", -1e7, 1e7), space: oneOf(anchor?.space ?? "screen", "anchor.space", ["screen", "world"] as const) } }),
      };
    }
    case "pan": {
      const space = opt(a.space, (x) => oneOf(x, "space", ["world", "screen"] as const)) ?? "world";
      if (a.nodeId !== undefined) return { nodeId: str(a.nodeId, "nodeId", 200) };
      if (a.to) return { to: { x: num(a.to.x, "to.x", -1e7, 1e7), y: num(a.to.y, "to.y", -1e7, 1e7) }, space };
      if (a.by) return { by: { dx: num(a.by.dx, "by.dx", -1e7, 1e7), dy: num(a.by.dy, "by.dy", -1e7, 1e7) }, space };
      throw new BridgeError("invalid", "pan needs to, by or nodeId");
    }
    case "highlight": return {
      ids: ids(a.ids, "ids", 20),
      style: opt(a.style, (x) => oneOf(x, "style", ["pulse", "outline", "flash"] as const)) ?? "pulse",
      ...(a.color !== undefined ? { color: (() => { const c = str(a.color, "color", 20); if (!COLOR.test(c)) throw new BridgeError("invalid", "color must be #hex or a color name"); return c; })() } : {}),
      durationMs: opt(a.durationMs, (x) => num(x, "durationMs", 0, 60_000)) ?? 3000,
      ...(a.label !== undefined ? { label: str(a.label, "label", 60) } : {}),
      reveal: a.reveal === true,
    };
    case "sound": return { name: opt(a.name, (x) => oneOf(x, "name", ["Glass", "Hero"] as const)) ?? "Glass" };
    case "gloss": return {
      ids: ids(a.ids, "ids", 40),
      reveal: a.reveal !== false,
      chime: a.chime === true,
      durationMs: opt(a.durationMs, (x) => num(x, "durationMs", 200, 3000)) ?? 900,
    };
    case "measure": return { ids: a.ids === undefined ? [] : ids(a.ids, "ids", 50, 0) };
    case "navigate": return { board: str(a.board, "board", 200) };
    case "page": return { page: str(a.page, "page", 40) };
    case "video_frame": return {
      id: str(a.id, "id", 40),
      t: opt(a.t, (x) => num(x, "t", 0, 86_400)) ?? 1,
      maxSide: opt(a.maxSide, (x) => num(x, "maxSide", 32, 2048)) ?? 768,
    };
    case "shader_frame": return {
      id: str(a.id, "id", 40),
      t: opt(a.t, (x) => num(x, "t", 0, 3600)) ?? 2,
      maxSide: opt(a.maxSide, (x) => num(x, "maxSide", 32, 1024)) ?? 512,
      ...(a.rev !== undefined ? { rev: str(a.rev, "rev", 40) } : {}),
      waitMs: opt(a.waitMs, (x) => num(x, "waitMs", 0, 20_000)) ?? 8000,
    };
    default: throw new BridgeError("unsupported", `Unknown op "${op}"`);
  }
}

function write(c: Client, msg: Json): boolean {
  try {
    if (c.res.destroyed || c.res.writableEnded) return false;
    c.res.write(`data: ${JSON.stringify(msg)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function sendCmd(c: Client, op: string, args: Json, timeoutMs: number): Promise<unknown> {
  const id = `c${++cmdCounter}`;
  return new Promise((resolve, reject) => {
    const key = `${c.id}:${id}`;
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new BridgeError("timeout", `${op} got no answer from ${c.role} ${c.id} within ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(key, { client: c.id, op, resolve, reject, timer });
    if (!write(c, { type: "cmd", id, op, args })) {
      clearTimeout(timer);
      pending.delete(key);
      reject(new BridgeError("client_gone", `${c.role} ${c.id} disconnected`));
    }
  });
}

function failPending(clientId: string, e: BridgeError) {
  for (const [k, p] of pending) {
    if (p.client !== clientId) continue;
    clearTimeout(p.timer);
    pending.delete(k);
    p.reject(e);
  }
}

export type CmdRequest = { op: string; args?: Json; client?: string; role?: Role; file?: string; timeoutMs?: number };
export type CmdResult = { result: unknown; client: string; role: Role; others?: ReturnType<typeof pageSummary>[] };

/** Queue one command to the right client and wait for its answer. */
export async function dispatch(req: CmdRequest, ctx: BridgeCtx): Promise<CmdResult> {
  const op = String(req.op ?? "");
  const qa = isQaOp(op);
  const role: Role = SHELL_OPS.has(op) || qa ? "shell" : PAGE_OPS.has(op) ? "page" : (() => { throw new BridgeError("unsupported", `Unknown op "${op}"`); })();
  const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 10_000, 500), 60_000);
  let target: Client | undefined;
  let others: Client[] = [];
  if (req.client) {
    target = clients.get(req.client);
    if (!target) throw new BridgeError("client_gone", `No connected client "${req.client}"`, "Call canvas_status to see who is connected.");
    if (target.role !== role) throw new BridgeError("invalid", `"${op}" runs on a ${role}, but ${req.client} is a ${target.role}`);
  } else if (role === "shell") {
    target = shellClient();
    if (!target) throw new BridgeError("no_shell", "The Canvas app is not connected", "Start it with launch_canvas {mode:'app'}.");
  } else {
    ({ page: target, others } = pickPage({ file: req.file }));
    if (!target) throw new BridgeError("no_page", req.file ? `No open canvas page shows ${req.file}` : "No canvas page is open", "Open one with open_file or launch_canvas.");
  }
  let args = qa ? (req.args ?? {}) : cleanArgs(op, req.args ?? {});
  if (role === "page") args = withBoards(op, args, target, ctx);
  if (op === "snapshot") return { result: await snapshotWithEngine(target, args, timeoutMs), client: target.id, role };
  const result = await sendCmd(target, op, args, timeoutMs);
  return { result, client: target.id, role, ...(others.length ? { others: others.map(pageSummary) } : {}) };
}

/**
 * The shell's snapshot (WKWebView.takeSnapshot) may not capture a WebGPU canvas. Pages in the app that draw
 * with the engine are asked first to "freeze": put a 2D copy of the current frame over the GPU canvas. They
 * "thaw" right after. A page that does not answer in time is snapshotted as it is.
 */
async function snapshotWithEngine(shell: Client, args: Json, timeoutMs: number): Promise<Json> {
  const current = shell.state?.currentFile;
  const pages = [...clients.values()].filter((c) => c.role === "page" && c.host === "native" && c.state?.renderer === "engine" && (!current || c.state?.file === current));
  // Every page asked to freeze is told to thaw afterwards, answered or not: a freeze ack that lands after
  // the 1.5 s wait still left a copy over the canvas. The page also thaws on its own after 3 s.
  await Promise.all(pages.map((p) => sendCmd(p, "freeze", {}, 1500).catch(() => null)));
  try {
    return (await sendCmd(shell, "snapshot", args, timeoutMs)) as Json;
  } finally {
    for (const p of pages) sendCmd(p, "thaw", {}, 1500).catch(() => {});
  }
}

/** Page ops that take node ids also get each id's top-level board, so the page can load a board it has not drawn yet. */
function withBoards(op: string, args: Json, page: Client, ctx: BridgeCtx): Json {
  const list: string[] = args.ids ?? (args.nodeId ? [args.nodeId] : []);
  const file = page.state?.file ?? page.file;
  if (!list.length || !file) return args;
  let index: Map<string, string>;
  try {
    index = boardIndex(ctx.snapOf(file).doc);
  } catch {
    return args;
  }
  const boards: Record<string, string> = {};
  for (const id of list) {
    if (id.startsWith("widget:")) continue;
    const b = boardOf(index, id);
    if (b) boards[id] = b;
    else if (op === "select") throw new BridgeError("not_found", `No node "${id}" in ${file}`, "Use lookup_nodes to find ids.");
  }
  return { ...args, boards };
}

// ---------- finish_work: what an agent changed since it last finished ----------

type Changed = { ids: Set<string>; boards: Map<string, string> };
const changed = new Map<string, Changed>();
/** Above this many changed nodes in one board the gloss covers the whole board. */
const BOARD_GLOSS_AT = 4;
const GLOSS_MAX = 40;

/** boardOf(boardIndex(doc), id) without indexing every node: one walk that stops at the hit (an MCP edit asks per node). */
function topBoardOf(doc: CanvasDoc, id: string): string | undefined {
  const find = (want: string) => {
    const has = (n: DocNode): boolean => n?.id === want || (Array.isArray(n?.children) && (n.children as DocNode[]).some(has));
    const top = doc.children.find(has);
    return top ? String(top.id) : undefined;
  };
  return find(id) ?? (id.includes("/") ? find(id.split("/")[0]) : undefined);
}

/** Remember a node (or "widget:<id>") an agent changed through the MCP, with its board when known. */
export function trackChange(file: string, id: string, ctx?: BridgeCtx) {
  const key = displayPath(resolveDocPath(file));
  let board: string | undefined;
  if (ctx && !id.startsWith("widget:")) {
    try {
      board = topBoardOf(ctx.snapOf(key).doc, id);
    } catch {
      // No board known: the gloss covers the node itself.
    }
  }
  let c = changed.get(key);
  if (!c) changed.set(key, (c = { ids: new Set(), boards: new Map() }));
  c.ids.add(id);
  if (board) c.boards.set(id, board);
}
export const trackedChanges = (file: string): string[] => [...(changed.get(displayPath(resolveDocPath(file)))?.ids ?? [])];

/** What to gloss: the changed nodes, or a whole board when many of its nodes changed. Boards, then nodes, capped. */
function glossTargets(c: Changed): string[] {
  const perBoard = new Map<string, string[]>();
  const loose: string[] = [];
  for (const id of c.ids) {
    const b = c.boards.get(id);
    if (b) (perBoard.get(b) ?? perBoard.set(b, []).get(b)!).push(id);
    else loose.push(id);
  }
  const out: string[] = [];
  for (const [b, list] of perBoard) {
    if (list.length > BOARD_GLOSS_AT) out.push(b);
    else out.push(...list);
  }
  out.push(...loose);
  return out.slice(0, GLOSS_MAX);
}

export type FinishRequest = { summary?: unknown; ids?: unknown; sound?: unknown; file?: unknown; client?: unknown };

/** The agent is done: reveal and gloss what changed, toast, sound, then forget the tracked set. */
export async function finishWork(b: FinishRequest, ctx: BridgeCtx): Promise<Json> {
  const summary = b.summary === undefined || b.summary === null || b.summary === "" ? undefined : str(b.summary, "summary", 140);
  const wantSound = b.sound !== false;
  const explicit = b.ids === undefined || b.ids === null ? undefined : ids(b.ids, "ids", GLOSS_MAX);
  const client = typeof b.client === "string" ? b.client : undefined;
  const { page } = pickPage({ client, file: typeof b.file === "string" ? b.file : undefined });
  const pageFile = typeof b.file === "string" ? b.file : page?.state?.file ?? page?.file;
  const key = pageFile ? displayPath(resolveDocPath(pageFile)) : undefined;
  const tracked = key ? changed.get(key) : undefined;
  const targets = explicit ?? (tracked ? glossTargets(tracked) : []);
  const trackedCount = tracked?.ids.size ?? 0;
  // The tracked set is consumed only once a page has shown it (below): with no viewer, or a failed gloss,
  // the changes stay tracked for the next finish_work.
  const consume = () => { if (key && tracked && changed.get(key) === tracked) changed.delete(key); };

  const shell = shellClient();
  const message = summary ? `Done: ${summary}` : "Done";
  const result: Json = { glossed: [], trackedCount, toast: false, sound: "off" };
  if (!page && !shell) return { ...result, note: "No canvas page or app is connected, so nothing was shown; the changes stay tracked." };
  if (!page && trackedCount) result.note = "No canvas page shows this file, so nothing was glossed; the changes stay tracked.";

  const jobs: Promise<void>[] = [];
  if (page && targets.length) {
    jobs.push(dispatch({ op: "gloss", args: { ids: targets, reveal: true, chime: wantSound && !shell }, client: page.id, timeoutMs: 8000 }, ctx).then((r) => {
      // What the page actually glossed, and what it could not find (deleted, or never there).
      const got = (r.result ?? {}) as Json;
      result.glossed = Array.isArray(got.glossed) ? got.glossed : targets;
      if (Array.isArray(got.missing) && got.missing.length) result.missing = got.missing;
      Object.assign(result, { revealed: got.revealed ?? false });
      consume();
      if (wantSound && !shell) result.sound = "page";
    }, (e) => { result.glossError = e instanceof BridgeError ? `${e.code}: ${e.message}` : String(e); }));
  } else if (!targets.length) result.note = "Nothing was tracked since the last finish_work, so there was nothing to gloss. Pass ids to point at nodes.";
  jobs.push(dispatch({ op: shell ? "toast" : "toast_fallback", args: { message, level: "success", durationMs: 4000 }, client: shell ? undefined : page?.id, timeoutMs: 5000 }, ctx).then(() => { result.toast = true; }, () => {}));
  if (shell && wantSound) jobs.push(dispatch({ op: "sound", args: { name: "Glass" }, timeoutMs: 5000 }, ctx).then(() => { result.sound = "shell"; }, () => {}));
  await Promise.all(jobs);
  return result;
}

function handleAck(body: Json): void {
  const key = `${String(body.client)}:${String(body.id)}`;
  const p = pending.get(key);
  if (!p) throw new BridgeError("not_found", "No command waiting for that id (it may have timed out)");
  clearTimeout(p.timer);
  pending.delete(key);
  if (body.ok === true) p.resolve(body.result ?? {});
  else {
    const e = (body.error ?? {}) as Json;
    p.reject(new BridgeError(typeof e.code === "string" ? e.code : "failed", typeof e.message === "string" ? e.message.slice(0, 500) : `${p.op} failed`));
  }
}

// ---------- state ----------

const sizeBox = (b: any) => (b && typeof b === "object" ? { x: Number(b.x) || 0, y: Number(b.y) || 0, w: Number(b.w) || 0, h: Number(b.h) || 0 } : undefined);

function cleanPageState(b: Json): Json {
  const sel = b.selection && typeof b.selection === "object" && Array.isArray(b.selection.ids) ? b.selection : null;
  const ins = b.view?.insets ?? {};
  return {
    host: b.host === "native" ? "native" : "browser",
    file: typeof b.file === "string" ? safeResolve(b.file) : null,
    docRevision: typeof b.docRevision === "string" ? b.docRevision.slice(0, 40) : null,
    selection: sel
      ? {
          ids: sel.ids.filter((x: unknown) => typeof x === "string").slice(0, 50).map((x: string) => x.slice(0, 200)),
          // The one the inspector shows (the last clicked); absent from older pages.
          ...(typeof sel.primary === "string" && sel.ids.includes(sel.primary) ? { primary: sel.primary.slice(0, 200) } : {}),
          pick: Number(sel.pick) || 0,
          source: sel.source === "mcp" ? "mcp" : "user",
          rendered: sel.rendered ? { width: Number(sel.rendered.width) || 0, height: Number(sel.rendered.height) || 0, world: sizeBox(sel.rendered.world), screen: sizeBox(sel.rendered.screen) } : null,
        }
      : null,
    selectionSource: b.selectionSource === "mcp" ? "mcp" : (sel?.source === "mcp" ? "mcp" : "user"),
    hover: b.hover && typeof b.hover.id === "string" ? { id: b.hover.id.slice(0, 200) } : null,
    cam: b.cam ? { x: Number(b.cam.x) || 0, y: Number(b.cam.y) || 0, z: Number(b.cam.z) || 1 } : null,
    view: b.view ? { w: Number(b.view.w) || 0, h: Number(b.view.h) || 0, insets: { l: Number(ins.l) || 0, t: Number(ins.t) || 0, r: Number(ins.r) || 0, b: Number(ins.b) || 0 } } : null,
    // The page (of the document's pages) this viewer shows.
    page: typeof b.page === "string" && b.page ? b.page.slice(0, 40) : null,
    visible: b.visible !== false,
    focused: b.focused === true,
    lastInputAt: Number(b.lastInputAt) || 0,
    // Which renderer draws the boards: "engine" (WebGPU) or "dom", with why the DOM one runs.
    renderer: b.renderer === "engine" || b.renderer === "dom" || b.renderer === "pending" ? b.renderer : null,
    ...(typeof b.rendererNote === "string" && b.rendererNote ? { rendererNote: b.rendererNote.slice(0, 200) } : {}),
    // Timings in ms (page script, "timings"): load, look, show and page switch to a fully drawn canvas.
    ...(b.perf && typeof b.perf === "object" ? { perf: cleanPerf(b.perf) } : {}),
  };
}

const PERF_KEYS = ["load", "look", "show", "page", "shows", "pages", "snapshots", "doc", "engine", "landed", "idle", "imgs"] as const;
function cleanPerf(p: Json): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of PERF_KEYS) out[k] = typeof p[k] === "number" && Number.isFinite(p[k]) ? Math.round(p[k]) : null;
  return out;
}

function cleanShellState(b: Json): Json {
  const files = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 100).map((x: string) => safeResolve(x)) : []);
  return {
    windowFocused: b.windowFocused === true,
    windowVisible: b.windowVisible !== false,
    // The contract says {mode, effective}; a bare mode string is accepted too.
    theme: typeof b.theme === "string" ? { mode: b.theme, effective: b.theme === "system" ? "light" : b.theme } : b.theme && typeof b.theme === "object" ? { mode: String(b.theme.mode ?? "system"), effective: String(b.theme.effective ?? "light") } : null,
    openFiles: files(b.openFiles),
    currentFile: typeof b.currentFile === "string" ? safeResolve(b.currentFile) : null,
  };
}

function derive(ctx: BridgeCtx, file: string | null, idList: string[], depth = 4) {
  let snap: Snapshot | undefined;
  try {
    snap = file ? ctx.snapOf(file) : undefined;
  } catch {
    snap = undefined;
  }
  return {
    revision: snap?.revision ?? null,
    nodes: idList.map((id) => {
      if (id.startsWith("widget:")) return { id, widget: id.slice(7) };
      const hit = snap && ctx.nodeAt(snap, id, depth);
      return hit ? { id, node: hit.node, parentId: hit.parentId, path: hit.path } : { id, missing: true };
    }),
  };
}

function receiveState(b: Json, ctx: BridgeCtx) {
  const c = clients.get(String(b.client));
  if (!c) throw new BridgeError("not_found", "Unknown client; reconnect the event stream");
  if (b.role !== c.role) throw new BridgeError("invalid", `client ${c.id} is a ${c.role}`);
  const n = Number(b.seq);
  if (Number.isFinite(n) && c.seq && n < c.seq) return; // an older post that overtook a newer one
  if (Number.isFinite(n)) c.seq = n;
  const prev = c.state;
  const next = c.role === "page" ? cleanPageState(b) : cleanShellState(b);
  // Settings > Agents rides on the shell's state (src/settings.ts).
  if (c.role === "shell" && b.settings && typeof b.settings === "object") setAgentSettings(b.settings);
  // Settings > Privacy and the facts only the app knows (version, commit, macOS) for usage counts (src/usage-counts.ts).
  if (c.role === "shell" && b.usage && typeof b.usage === "object") usage.setFacts(b.usage);
  c.state = next;
  c.stateAt = Date.now();
  if (c.role === "page") {
    if (prev) {
      const key = (s: Json | undefined) => (s?.selection ? `${s.selection.ids.join(",")}#${s.selection.pick}` : "");
      if (key(prev) !== key(next)) {
        const ids_: string[] = next.selection?.ids ?? [];
        const d = ids_.length ? derive(ctx, next.file, ids_.slice(0, 1)) : undefined;
        emit("selection", { client: c.id, file: next.file, ids: ids_, source: next.selection?.source ?? next.selectionSource ?? "user", ...(d ? { node: d.nodes[0], revision: d.revision } : {}) });
      }
      if (prev.file !== next.file) emit("file", { client: c.id, file: next.file });
    }
  } else if (prev && JSON.stringify(prev.openFiles) !== JSON.stringify(next.openFiles)) {
    emit("tabs", { openFiles: next.openFiles, currentFile: next.currentFile });
  } else if (prev && prev.currentFile !== next.currentFile) {
    emit("tabs", { openFiles: next.openFiles, currentFile: next.currentFile });
  }
}

// ---------- HTTP ----------

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function refuse(res: http.ServerResponse, status: number, e: BridgeError) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-canvas-boot": boot });
  res.end(JSON.stringify({ error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }, boot }));
}

function ok(res: http.ServerResponse, body: Json, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-canvas-boot": boot, "x-content-type-options": "nosniff" });
  res.end(JSON.stringify({ ...body, boot }));
}

/** Browsers add Origin and Sec-Fetch-Site; a foreign page shows up in them. Clients without a browser send neither. */
export function originOk(req: http.IncomingMessage): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const o = new URL(String(origin));
    const hostPort = String(req.headers.host ?? "").match(/:(\d+)$/)?.[1] ?? "80";
    return o.protocol === "http:" && LOOPBACK.has(o.hostname) && (o.port || "80") === hostPort;
  } catch {
    return false;
  }
}

async function readJson(req: http.IncomingMessage, max: number): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // Keep reading (and dropping) an oversize body so the sender sees the 413, not a broken pipe.
    if (size <= max) chunks.push(c as Buffer);
    else if (size > max + 64 * 1024 * 1024) break;
  }
  if (size > max) throw new BridgeError("too_large", `The request body is larger than ${Math.round(max / 1024)} KB`);
  if (!size) return {};
  let j: unknown;
  try {
    j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError("invalid", "The request body is not valid JSON");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new BridgeError("invalid", "The request body must be a JSON object");
  return j as Json;
}

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

function openStream(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const id = url.searchParams.get("client") ?? "";
  const role = url.searchParams.get("role");
  if (!ID_RE.test(id)) throw new BridgeError("invalid", "client must be 6-64 letters, digits, - or _");
  if (role !== "page" && role !== "shell") throw new BridgeError("invalid", "role must be page or shell");
  const host = role === "shell" || url.searchParams.get("host") === "native" ? "native" : "browser";
  const file = url.searchParams.get("file");
  const old = clients.get(id);
  if (old) {
    failPending(id, new BridgeError("client_gone", `client ${id} reconnected`));
    old.res.end();
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-canvas-boot": boot });
  const c: Client = { id, role, host, res, connectedAt: Date.now(), file: file ? safeResolve(file) : undefined, stateAt: 0, seq: 0 };
  clients.set(id, c);
  write(c, { type: "hello", client: id, boot, role, serverVersion: version() });
  emit("client_up", { client: id, role, host, file: c.file ?? null });
  req.on("close", () => {
    if (clients.get(id) !== c) return;
    clients.delete(id);
    failPending(id, new BridgeError("client_gone", `${role} ${id} disconnected`));
    emit("client_down", { client: id, role });
  });
}

setInterval(() => {
  for (const c of clients.values()) {
    try {
      c.res.write(": ping\n\n");
    } catch {
      // The close handler removes it.
    }
  }
}, 15_000).unref();

function statusBody() {
  const pages = [...clients.values()].filter((c) => c.role === "page");
  const { page } = pickPage();
  return { version: version(), seq, pages: pages.map(pageSummary), shell: shellSummary(shellClient()) ?? null, active: page ? { client: page.id, file: page.state?.file ?? null } : null };
}

function stateBody(url: URL, ctx: BridgeCtx) {
  const { page, others } = pickPage({ client: url.searchParams.get("client") ?? undefined, file: url.searchParams.get("file") ?? undefined });
  if (!page) throw new BridgeError("no_page", "No canvas page is open", "Open one with open_file or launch_canvas.");
  const st = page.state ?? {};
  const depth = Math.min(Math.max(Number(url.searchParams.get("depth")) || 4, 0), 8);
  const idList: string[] = st.selection?.ids ?? [];
  const d = idList.length && url.searchParams.get("includeNode") !== "0" ? derive(ctx, st.file, idList.slice(0, 5), depth) : undefined;
  let revision: string | null = null;
  try {
    revision = st.file ? ctx.snapOf(st.file).revision : null;
  } catch {
    revision = null;
  }
  return { page: { ...pageSummary(page), state: st, selection: st.selection ? { ...st.selection, nodes: d?.nodes } : null, revision, stale: Boolean(revision && st.docRevision && revision !== st.docRevision) }, others: others.map(pageSummary), shell: shellSummary(shellClient()) ?? null, seq };
}

/** /api/bridge/*, /api/state, /api/ack. Returns false for anything else. */
export async function handleBridge(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: BridgeCtx): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/bridge/") && p !== "/api/state" && p !== "/api/ack") return false;
  const method = req.method ?? "GET";
  try {
    if (!originOk(req)) throw new BridgeError("forbidden", "Cross-origin requests are not allowed");
    if (method !== "GET" && req.headers["x-canvas"] !== "1") throw new BridgeError("forbidden", "Missing x-canvas header");
    if (p === "/api/bridge/events" && method === "GET") return void openStream(req, res, url), true;
    if (p === "/api/state" && method === "POST") {
      receiveState(await readJson(req, 1_000_000), ctx);
      ok(res, { ok: true });
      return true;
    }
    if (p === "/api/ack" && method === "POST") {
      handleAck(await readJson(req, 25 * 1024 * 1024));
      ok(res, { ok: true });
      return true;
    }
    if (p === "/api/bridge/cmd" && method === "POST") {
      const b = await readJson(req, 1_000_000);
      for (const f of [b.file, b.args?.file]) if (typeof f === "string") await ctx.prime?.(f);
      const out = await dispatch({ op: b.op, args: b.args && typeof b.args === "object" ? b.args : {}, client: typeof b.client === "string" ? b.client : undefined, file: typeof b.file === "string" ? b.file : undefined, timeoutMs: b.timeoutMs }, ctx);
      ok(res, { ok: true, ...out });
      return true;
    }
    if (p === "/api/bridge/finish" && method === "POST") {
      const body = await readJson(req, 1_000_000);
      // The agent's undo step closes and takes the summary as its name ("Undo Agent: <summary>").
      finishAgent(String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined, typeof body.summary === "string" && body.summary ? body.summary.slice(0, 140) : undefined);
      ok(res, { ok: true, ...(await finishWork(body, ctx)) });
      return true;
    }
    if (p === "/api/bridge/installed-fonts" && method === "GET") return ok(res, await installedFamilies(ctx)), true;
    if (p === "/api/bridge/status" && method === "GET") return ok(res, statusBody()), true;
    if (p === "/api/bridge/state" && method === "GET") return ok(res, stateBody(url, ctx)), true;
    if (p === "/api/bridge/wait" && method === "GET") {
      const types = url.searchParams.get("types")?.split(",").filter(Boolean);
      const set = types?.length ? new Set(types) : undefined;
      const sinceParam = url.searchParams.get("since");
      const since = sinceParam === null || sinceParam === "" ? seq : Number(sinceParam) || 0;
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
      const timeoutMs = Math.min(Math.max(Number(url.searchParams.get("timeoutMs")) || 0, 0), 55_000);
      const reply = () => {
        const events = eventsSince(since, set, limit);
        ok(res, { events, next: events.length ? events[events.length - 1].seq : Math.max(since, seq), seq });
      };
      if (eventsSince(since, set, 1).length || !timeoutMs) return reply(), true;
      await new Promise<void>((done) => {
        const w = { since, types: set, wake: () => finish() };
        const timer = setTimeout(() => finish(), timeoutMs);
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(w);
          done();
        };
        waiters.add(w);
        req.on("close", finish);
      });
      if (!res.writableEnded && !res.destroyed) reply();
      return true;
    }
    throw new BridgeError("not_found", "Unknown bridge route");
  } catch (e) {
    const be = e instanceof BridgeError ? e : new BridgeError("failed", (e as Error).message);
    if (!res.headersSent) refuse(res, STATUS[be.code] ?? 500, be);
    else res.end();
    return true;
  }
}

/** /api/summary, /api/find, /api/fonts: facts about one document, with no page needed. */
export async function handleDocRoute(url: URL, snap: Snapshot, ctx: BridgeCtx, json: (v: unknown, status?: number) => void): Promise<boolean> {
  const p = url.pathname;
  if (p === "/api/summary") {
    let pages: unknown = null;
    try {
      const v = listPages(snap.path, () => snap.boards.map((b) => b.id));
      pages = v.pages.map((x) => ({ id: x.id, name: x.name, boards: x.boards, ...(x.default ? { default: true } : {}) }));
    } catch {
      // An unreadable sidecar: the summary still answers, without pages.
    }
    return json({ ...summaryOf(snap), file: displayPath(snap.path), pages }), true;
  }
  if (p === "/api/find") {
    const q = url.searchParams;
    const index = boardIndex(snap.doc);
    const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 500);
    try {
      const id = q.get("id");
      if (id) {
        const f = findNode(snap.doc, id);
        const n = f.node;
        return json({ revision: snap.revision, total: 1, results: [{ id: String(n.id), type: String(n.type), ...(n.name ? { name: String(n.name) } : {}), board: boardOf(index, String(n.id)) ?? null, path: f.ancestors.map((a) => String(a.name ?? a.id)).join(" / ") }] }), true;
      }
      const r = findNodes(snap.doc, { name: q.get("name") ?? undefined, type: q.get("type") ?? undefined, text: q.get("text") ?? undefined, reusable: q.has("reusable") ? q.get("reusable") === "true" : undefined, within: q.get("within") ?? undefined }, limit);
      return json({ revision: snap.revision, total: r.total, results: r.results.map((x) => ({ ...x, board: boardOf(index, x.id) ?? null })) }), true;
    } catch (e) {
      return json({ error: { code: "not_found", message: (e as Error).message } }, 404), true;
    }
  }
  if (p === "/api/fonts") {
    const used = fontsUsed(snap.doc, snap.path);
    let installed = new Set<string>();
    let source = "unknown";
    if (shellClient()) {
      try {
        const r = (await dispatch({ op: "fonts", timeoutMs: 5000 }, ctx)).result as { families?: string[] };
        installed = new Set(r.families ?? []);
        source = "shell";
      } catch {
        // Fall back to the system list below.
      }
    }
    if (source === "unknown") {
      installed = await systemFonts();
      if (installed.size) source = "system";
    }
    return json({ file: displayPath(snap.path), revision: snap.revision, installedSource: source, installedCount: installed.size, fonts: fontStatuses(used, installed), ...(source === "unknown" ? { note: "Installed fonts could not be read; non-system families are reported as web." } : {}) }), true;
  }
  return false;
}

/** For the MCP's installed-fonts search: the whole list. */
export async function installedFamilies(ctx: BridgeCtx): Promise<{ source: string; families: string[] }> {
  if (shellClient()) {
    try {
      const r = (await dispatch({ op: "fonts", timeoutMs: 5000 }, ctx)).result as { families?: string[] };
      return { source: "shell", families: r.families ?? [] };
    } catch {
      // fall through
    }
  }
  return { source: "system", families: [...(await systemFonts())].sort() };
}

export const bootId = () => boot;
