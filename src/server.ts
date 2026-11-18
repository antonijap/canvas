#!/usr/bin/env node
// Canvas: a lightweight local design surface for .canvas documents.
// Agents design through Canvas MCP (it edits the file through this server); Canvas watches the file and
// redraws the changed boards in place. Pan by drag or scroll, zoom by pinch or Cmd+scroll,
// click a node to see its properties, left rail lists boards, components, text styles and variables.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardHtml, type Snapshot } from "./boards.ts";
import { docDiff, applyDocDiff, docPayload } from "./docdiff.ts";
import { SnapshotCache } from "./snapcache.ts";
import { compactWrites, currentDoc, editDoc, writeSettled, finishWrites, flushWrites, hasPendingWrites, journalSynced, persistedRevision, reconcileLoad, restoreSuspected, resumeWrites, setDocHost, writerHooks } from "./docwriter.ts";
import { PAGE_BRIDGE_JS } from "./bridge-page.ts";
import { dispatch, docChanged, finishWork, trackChange, handleBridge, originOk, handleDocRoute, noteDoc, emit as bridgeEmit, type BridgeCtx } from "./bridge.ts";
import { DESIGN_FILE, DocError, displayPath, newCanvas, primeDoc, renameCanvas, saveAsCanvas } from "./docpath.ts";
import { storeForAsync } from "./widgets/store.ts";
import { enginePkgDir, handleEngineRoute, sceneEnv, streamFile } from "./scene.ts";
import { keyedAnswer } from "./keyed.ts";
import { contextTarget, handleUsageRoute, isComponentish, mediaSlot } from "./usage.ts";
import { handleSearchRoute } from "./search.ts";
import { handleLayersRoute } from "./layers.ts";
import { handleColorsRoute } from "./colors.ts";
import { applyAutoTracking, prepareAutoTracking } from "./tracking.ts";
import { cssVariables } from "./tokens.ts";
import { codeRootId, version } from "./version.ts";
import { attachWidgetClient, handleWidgetRoute, widgetHooks } from "./widgets.ts";
import { handleCommentsRoute } from "./comments.ts";
import { handleCloudRoute, onChanged as onCloudChanged } from "./cloud.ts";
import { scrubSecrets } from "./cloud-secrets.ts";
import { handlePagesRoute, resolvePages } from "./pages.ts";
import { handleShaderRoute, settleShaderSources } from "./shaders.ts";
import { handleImageRoute } from "./images.ts";
import { handleVideoRoute } from "./videos.ts";
import { loadBox } from "./boardbox.ts";
import { fitCam, keepLabels, overlayNode, pickPage, retryDelay, unionRect, wheelAction, zoomAt } from "./pagelogic.ts";
import { handleHistoryRoute, historyState, nodeDiff, nodeLabel, onAgentEdit, onHistory, propsOf, record, type NodeOp } from "./history.ts";
import { agentLabel, cursorActions } from "./agent-cursor.ts";
import { GROUP_MERGE_MS, handleMoveRoute, isGroupMerge, moveModeOf, moveNodes, MoveError } from "./move.ts";
import { handleResizeRoute } from "./resize.ts";
import { handleScaleRoute } from "./scale.ts";
import { handleStructureRoute, isDeletedHolder, keepOnPage, runStructure } from "./structure.ts";
import { handleVariationsRoute, type VarCtx } from "./variations.ts";
import { handleExportRoute } from "./export.ts";
import { handleCopyAsRoute } from "./copy-as.ts";
import { handleLayoutRoute, runLayout, withoutPlacedXY } from "./autolayout.ts";
import { handleTextRoute } from "./textedit.ts";
import { fromNudge, fromUpdate, lastEdit, noteEdit, onRepeat, planRepeat, repeatInfo, repeatToast } from "./repeat.ts";
import { followRename, handleOverrideRoute, OverrideError, overrideInfo, renameFollowers, updateWithOverrides } from "./overrides.ts";
import { replaceEach, selectionColors } from "./selection-colors.ts";
import { nodeDepth } from "./doc/tree.ts";
import { buildIndex, defaultTheme, expand, findNode, FIT_SCRIPT, resolveDocPath, resolveVariable, StaleFileError, updateNode, type Json, type CanvasDoc, type DocNode } from "./engine.ts";
import { readBodyText } from "./body.ts";
import { handleAgentRoute, renderInChild, type AgentCtx } from "./agent-run.ts";
import { handleOnboardingRoute, noteMcp } from "./onboarding.ts";
import { countUsage, handleUsageCountsRoute, usage } from "./usage-counts.ts";

export const PORT = () => Number(process.env.CANVAS_PORT ?? 5189);
const IDLE_EXIT_MS = 30 * 60_000;

export { version };

// A rejected background scan must not take the server down (node exits on unhandled rejections).
process.on("unhandledRejection", (e) => console.error(scrubSecrets(`[canvas] ${e}`)));

/** /asset responses: an SVG opened as a page gets an opaque origin and no script. */
export const ASSET_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
const ASSET_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};

let lastActivity = Date.now();

const clients = new Map<string, Set<http.ServerResponse>>();

// Every request trusts the cache after one fs.stat; see snapcache.ts. A change is announced once, by
// whichever of the directory watcher and a request notices it first.
const cache = new SnapshotCache({
  onFirst: (snap) => noteDoc(snap.path, snap.revision),
  onChange: (fresh, prev) => announce(fresh, prev),
  // A document with edits not yet on disk stays loaded (docwriter.ts holds them only here).
  pinned: (file) => !!clients.get(file)?.size || hasPendingWrites(file),
  reconcile: reconcileLoad,
  // Only the ctime moved and the bytes are the same, but a save log applies whose tie names another ctime: maybe a
  // restore in place to the log's base bytes, so the file is loaded again (docwriter.ts restoreSuspected).
  ctimeOnlyChanges: (f, sig) => restoreSuspected(f, sig),
  // Tabs the app keeps alive but hidden hold no stream: the last few documents stay parsed regardless, so showing
  // such a tab again never waits for a parse; any other idle document goes after half an hour.
  idleMs: 30 * 60_000,
  keepRecent: 3,
});
// Edits change the document in memory and the file is written in the background (src/docwriter.ts).
setDocHost({
  peek: (f) => cache.peek(f),
  get: (f) => cache.get(f),
  adopt: (f, s) => cache.adopt(f, s),
  ensure: (f) => cache.ensure(f),
  markOwn: (f, k, h) => cache.markOwn(f, k, h),
  confirmOwn: (f, sig) => cache.confirmOwn(f, sig),
  load: (f, l, sig) => void cache.applyLoaded(f, sig, l),
});
// A save that failed, an edit that could not be kept, a recovery copy: the log and every page showing the file say so.
writerHooks.problem = (docFile, message) => {
  logLine(`[canvas] ${message}`);
  const msg = sse("saveproblem", { file: docFile, message });
  for (const c of clients.get(docFile) ?? []) c.write(msg);
};
/** Where server.log goes: CANVAS_LOG_DIR (a QA instance's own folder), else ~/Library/Logs/Canvas. */
const logDir = () => process.env.CANVAS_LOG_DIR || path.join(os.homedir(), "Library", "Logs", "Canvas");
/** A line in ~/Library/Logs/Canvas/server.log (where the app's crash lines go too). */
function logLine(line: string): void {
  try {
    const logs = logDir();
    fs.mkdirSync(logs, { recursive: true });
    fs.appendFileSync(path.join(logs, "server.log"), `${new Date().toISOString()} ${scrubSecrets(line)}\n`);
  } catch {}
}
/**
 * Exit once every edit is on disk. New edits are refused from the start. Whatever could not be written in time is
 * saved as a recovery copy next to its file and reported (log, pages) first; then the exit code says it (1). When
 * not even a recovery copy could be written, the server stays up: the edits exist only in its memory (a second
 * SIGTERM still ends it).
 */
let quitting = false;
function quitSafely(code: number): void {
  if (quitting) return;
  quitting = true;
  void finishWrites(5000).then(
    ({ problems, kept }) => {
      if (!kept) {
        quitting = false;
        logLine("[canvas] not quitting: some edits could not be saved anywhere and exist only in memory");
        return;
      }
      setTimeout(() => process.exit(problems.length ? code || 1 : code), problems.length ? 300 : 50);
    },
    (e) => {
      // Nothing says every edit is safe: stay up rather than lose what only memory holds.
      quitting = false;
      resumeWrites();
      logLine(`[canvas] not quitting: finishing the writes failed (${(e as Error).message})`);
    },
  );
}
// peek() first: a request primes its document asynchronously (prime below), so the sync helpers answer from memory.
const watched = (file: string): Snapshot => cache.peek(file) ?? cache.get(file);

/** Resolve, stat and load a document and its widgets file with fs.promises, so one slow or blocked file never stops the event loop. */
async function prime(file: string): Promise<void> {
  await primeDoc(file);
  let docFile: string;
  try {
    docFile = resolveDocPath(file);
  } catch {
    return;
  }
  await Promise.all([cache.ensure(docFile).catch(() => {}), storeForAsync(docFile).catch(() => {})]);
}
widgetHooks.docOf = (docFile) => watched(docFile).doc;

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** Every page showing the file reads its comments again (an agent commented, another page did, the team server sent something). */
function tellCommentPages(f: string | null): void {
  if (!f) return;
  let docFile: string;
  try { docFile = resolveDocPath(f); } catch { return; }
  const msg = sse("comments", { at: Date.now() });
  for (const c of clients.get(docFile) ?? []) c.write(msg);
}
onCloudChanged((display) => tellCommentPages(display));
// Undo history changes reach every page showing the document; the native page hands them to the Edit menu.
// The last repeatable edit's name rides along (Edit > Repeat, src/repeat.ts).
const historyMsg = (docFile: string) => sse("history", { ...historyState(docFile), repeat: repeatInfo(docFile) });
const tellHistory = (docFile: string) => {
  const msg = historyMsg(docFile);
  for (const c of clients.get(docFile) ?? []) c.write(msg);
};
onHistory(tellHistory);
onRepeat(tellHistory);
// The agent cursor (src/agent-cursor.ts, src/page/agent-cursor.js): every edit an agent makes through the MCP reaches
// the pages showing the document as what it did and where, named after the agent (its MCP client, x-canvas-agent).
const agentNames = new Map<string, string>();
function noteAgent(req: http.IncomingMessage) {
  const session = req.headers["x-canvas-session"], agent = req.headers["x-canvas-agent"];
  if (typeof session !== "string" || !session || typeof agent !== "string" || !agent) return;
  if (agentNames.size > 200) agentNames.clear();
  agentNames.set(session.slice(0, 80), agentLabel(agent.slice(0, 80)));
}
onAgentEdit((docFile, session, ops) => {
  const set = clients.get(docFile);
  if (!set?.size) return;
  const actions = cursorActions(ops);
  if (!actions.length) return;
  const msg = sse("agentedit", { session, agent: agentNames.get(session) ?? "Agent", actions });
  for (const c of set) c.write(msg);
});
/**
 * A change reaches the bridge at once and open pages at most every BROADCAST_MS: a burst of edits (100 MCP writes
 * arriving over fresh connections, one or two per turn of the loop) is one diff from what pages last got to the
 * newest snapshot, not one full board, component and usage pass per edit (that was most of the first burst's tail).
 */
export const BROADCAST_MS = 40;
const lastBroadcast = new Map<string, number>();
const heldBroadcast = new Map<string, { s: Snapshot; prev?: Snapshot }>();
function announce(s: Snapshot, prev?: Snapshot) {
  docChanged(s.path, s.revision);
  const held = heldBroadcast.get(s.path);
  if (held) { held.s = s; return; } // the diff goes from what pages have (held.prev) to the newest
  const wait = (lastBroadcast.get(s.path) ?? 0) + BROADCAST_MS - Date.now();
  if (wait <= 0 || !clients.get(s.path)?.size) {
    lastBroadcast.set(s.path, Date.now());
    return broadcast(s, prev);
  }
  const h = { s, prev };
  heldBroadcast.set(s.path, h);
  setTimeout(() => {
    heldBroadcast.delete(s.path);
    lastBroadcast.set(s.path, Date.now());
    broadcast(h.s, h.prev);
  }, wait);
}
/** One `docdiff` event for a change (or a full `doc` when the diff would not be smaller). The first event on a connection is always the full `doc`. */
const broadcast = (s: Snapshot, prev?: Snapshot) => {
  docChanged(s.path, s.revision);
  const set = clients.get(s.path);
  if (!set?.size) return;
  const full = docPayload(s);
  let msg = prev ? sse("docdiff", docDiff(docPayload(prev), full)) : "";
  if (!msg || msg.length > JSON.stringify(full).length + 40) msg = sse("doc", full);
  for (const c of set) c.write(msg);
};

/**
 * The variables a node's own properties name, each resolved the way the canvas draws that node: in its effective
 * theme (the document's default, then every ancestor's and its own `theme`). The inspector shows and detaches
 * these values; resolving in the app's appearance instead wrote black for a node that draws white.
 */
export function nodeTokens(doc: CanvasDoc, id: string, node: DocNode): Record<string, string> {
  const names = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === "string") { if (v.startsWith("$") && v.length > 1) names.add(v.slice(1)); return; }
    if (Array.isArray(v)) return v.forEach(collect);
    if (v && typeof v === "object") for (const x of Object.values(v)) collect(x);
  };
  for (const [k, v] of Object.entries(node)) if (k !== "children" && k !== "content" && k !== "id") collect(v);
  if (!names.size) return {};
  // The theme where the node sits: an instance path takes its instance's place.
  const target = id.split("/")[0];
  let theme: Record<string, string> | undefined;
  const seek = (ns: DocNode[] | undefined, t: Record<string, string>): boolean => {
    for (const n of ns ?? []) {
      const here = n.theme && typeof n.theme === "object" ? { ...t, ...(n.theme as Record<string, string>) } : t;
      if (String(n.id) === target) { theme = here; return true; }
      if (seek(n.children as DocNode[] | undefined, here)) return true;
    }
    return false;
  };
  seek(doc.children, defaultTheme(doc) as Record<string, string>);
  if (!theme) return {};
  if (id.includes("/") && node.theme && typeof node.theme === "object") theme = { ...theme, ...(node.theme as Record<string, string>) };
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = resolveVariable(doc, name, theme);
    if (v !== undefined && v !== null && typeof v !== "object") out[name] = String(v);
  }
  return out;
}

/** The node at an id or instance path ("Ins01/Lbl01"), from the expanded tree, with where it sits. */
function nodeAt(s: Snapshot, id: string, depth = 4): { node: DocNode; parentId: string; index: number; path: boolean } | undefined {
  const trim = (n: DocNode, depth: number): DocNode => {
    const c: DocNode = JSON.parse(JSON.stringify({ ...n, children: undefined }));
    delete (c as Record<string, unknown>).children;
    if (Array.isArray(n.children)) {
      const kids = n.children as DocNode[];
      (c as Record<string, unknown>).children = depth <= 0 ? "…" : kids.map((k) => trim(k, depth - 1));
    }
    return c;
  };
  if (!id.includes("/")) {
    try {
      const f = findNode(s.doc, id);
      const node = trim(f.node, depth);
      // An instance lists the layers it draws (instance paths), so Enter can step into it like into a frame.
      if (f.node.type === "ref") {
        try {
          const ex = expand(buildIndex(s.doc), f.node, []);
          if (Array.isArray(ex.children)) (node as Record<string, unknown>).children = depth <= 0 ? "…" : (ex.children as DocNode[]).map((k) => trim(k, depth - 1));
        } catch { /* a missing or looping component draws nothing to step into */ }
      }
      return { node, parentId: f.parent?.id ?? "document", index: f.index, path: false };
    } catch {
      // A rendered id that is not in the stored tree (an expanded instance child) falls through.
    }
  }
  // The drawn parent of an instance layer: the frame or instance it sits in ("Inst" for "Inst/Child"), so Esc and
  // Shift+Enter walk up through instances, not straight to the board.
  const seek = (n: DocNode, id: string, parent: DocNode | null, index: number): { hit: DocNode; parent: DocNode | null; index: number } | undefined => {
    if (String(n.id) === id) return { hit: n, parent, index };
    const kids = (n.children as DocNode[] | undefined) ?? [];
    for (let i = 0; i < kids.length; i++) {
      const r = seek(kids[i], id, n, i);
      if (r) return r;
    }
    return undefined;
  };
  const rootId = id.split("/")[0];
  for (const top of s.doc.children) {
    if (String(top.id) !== rootId && !JSON.stringify(top).includes(`"${rootId}"`)) continue;
    const ex = expand(buildIndex(s.doc), top, []);
    const r = seek(ex, id, null, -1);
    if (r) return { node: trim(r.hit, depth), parentId: r.parent ? String(r.parent.id) : String(top.id), index: r.parent ? r.index : -1, path: id.includes("/") };
  }
  return undefined;
}

const bridgeCtx: BridgeCtx = { snapOf: (file) => watched(resolveDocPath(file)), nodeAt, prime };

const SKIP_DIRS = new Set(["node_modules", "worktrees", "Library", "dist", "build", "Pods", "DerivedData", ".git", "target", ".build", "vendor", "vendor.bundle"]);

type FileEntry = { file: string; name: string; modified: string };

// Scanning runs in the background and never on the request path: Desktop and Code can hold
// iCloud-synced or simply huge directories, and a blocking walk once stalled every request.
// Shallow directories are visited before deep ones, so near-root files appear within moments.
let fileList: FileEntry[] = [];
let scanStartedAt = 0;

async function scanAsync(dir: string, depth: number, out: FileEntry[]): Promise<void> {
  if (depth < 0 || out.length > 400) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    // A .canvas folder is one document: listed once, never descended into. A plain .canvas file is Obsidian's.
    if (e.isDirectory() && e.name.endsWith(".canvas")) {
      try {
        const st = await fs.promises.stat(path.join(p, DESIGN_FILE));
        if (st.isFile()) out.push({ file: fs.realpathSync(p), name: path.basename(p, ".canvas"), modified: st.mtime.toISOString() });
      } catch {}
    } else if (e.isDirectory()) subdirs.push(p);
  }
  await Promise.all(subdirs.map((d) => scanAsync(d, depth - 1, out)));
}

async function listFiles(): Promise<FileEntry[]> {
  if (scanStartedAt && Date.now() - scanStartedAt < 10_000) return fileList;
  scanStartedAt = Date.now();
  const out: FileEntry[] = [];
  const h = os.homedir();
  const roots = process.env.CANVAS_ROOTS
    ? process.env.CANVAS_ROOTS.split(path.delimiter).filter(Boolean)
    : [path.join(h, "Desktop"), path.join(h, "Code")];
  (async () => {
    try {
      for (const r of roots) {
        await scanAsync(r, 4, out);
        // Publish what each root yielded as soon as it is done, so near-root files land early.
        fileList = out
          .slice()
          .sort((a, b) => b.modified.localeCompare(a.modified))
          .slice(0, 400);
      }
    } finally {
      scanStartedAt = 0;
    }
  })().catch((e) => console.error(`[canvas] scan: ${e}`));
  return fileList;
}

/**
 * An /api/update write's undo merge. merge "group:<key>" (a shortcut writing different values to several layers,
 * src/page/shortcuts.js) folds every write with that key into one step; otherwise one layer (or set) and its keys,
 * and a gesture (a scrub) for a minute.
 */
/** POST /api/update's body. */
type UpdateBody = { file?: string; id?: string; ids?: string[]; props?: Record<string, Json>; remove?: string[]; expectedRevision?: string; gesture?: string; merge?: string; each?: Record<string, Record<string, Json>>; rel?: unknown };

/**
 * Several layers in one write and one undo step: `props` on each, a layer's own `each` values on top (a Mixed field
 * stepped from each layer's value, a repeat). The inspector's "N selected" and Repeat (src/repeat.ts) write here.
 */
async function updateMany(file: string, b: UpdateBody & { ids: string[] }, by: "mcp" | "inspector", session?: string): Promise<{ revision?: string; changed: boolean }> {
  const metrics = await Promise.all(b.ids.map((id) => prepareAutoTracking(watched(file).doc, id, { ...(b.props ?? {}), ...(b.each?.[id] ?? {}) }, b.remove ?? [])));
  let ops: NodeOp[] = [];
  const { write } = editDoc(file, { expectedRevision: b.expectedRevision, touches: b.ids }, (doc) => {
    ops = b.ids.map((id, i) => {
      const found = findNode(doc, id);
      const before = propsOf(found.node);
      const props = { ...(b.props ?? {}), ...(b.each?.[id] ?? {}) };
      const node = updateNode(doc, id, withoutPlacedXY(found.parent, found.node, props), b.remove ?? []);
      applyAutoTracking(doc, node, props, metrics[i], b.remove ?? []);
      return nodeDiff(id, before, propsOf(node));
    });
  });
  const keys = [...new Set([...Object.keys(b.props ?? {}), ...Object.values(b.each ?? {}).flatMap((p) => Object.keys(p ?? {})), ...(b.remove ?? [])])].sort();
  record(file, ops, { label: nodeLabel(keys), source: by === "mcp" ? "mcp" : "user", session, ...updateMerge(b, `nodes:${[...b.ids].sort().join(",")}:${keys.join(",")}`), edit: write.edit }, write.revision);
  if (write.revision) docChanged(file, write.revision, by, { id: b.ids[0] });
  if (by === "inspector") bridgeEmit("user_edit", { file: displayPath(file), id: b.ids[0], ids: b.ids, props: keys.filter((k) => !(b.remove ?? []).includes(k)), remove: b.remove ?? [] });
  return { revision: write.revision, changed: ops.some((o) => Object.keys(o.props).length > 0) };
}

/**
 * POST /api/repeat {file, ids, round}: the document's last repeatable edit (src/repeat.ts) on these layers, one
 * write, one undo step. Answers {ok, label, toast, changed, ids, each} (each: what each layer got, for the page to
 * draw at once), or 409 {code: "nothing"} when there is no edit to repeat.
 */
async function repeatEdit(b: { file?: string; ids?: unknown; round?: unknown }, by: "mcp" | "inspector", session?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!b.file || !Array.isArray(b.ids)) return { status: 400, body: { error: "file and ids are required", code: "invalid" } };
  await prime(b.file);
  const file = resolveDocPath(b.file);
  const e = lastEdit(file);
  if (!e) return { status: 409, body: { error: "Nothing to repeat yet: change a property first", code: "nothing" } };
  const ids = [...new Set(b.ids.filter((i): i is string => typeof i === "string" && !!i && !i.startsWith("widget:")))].slice(0, 2000);
  if (!ids.length) return { status: 400, body: { error: "Select layers to repeat " + e.label + " on", code: "invalid" } };
  if (e.kind === "move" && e.move) {
    const r = moveNodes(file, { items: ids.map((id) => ({ id, dx: e.move!.dx, dy: e.move!.dy })), round: b.round !== false }, { source: by === "mcp" ? "mcp" : "user", session });
    if (r.moved.length) {
      if (r.revision) docChanged(file, r.revision, by, { id: r.moved[0].id });
      if (by === "inspector") bridgeEmit("user_edit", { file: displayPath(file), id: r.moved[0].id, ids: r.moved.map((m) => m.id), props: ["x", "y"], remove: [] });
    }
    return { status: 200, body: { ok: true, label: e.label, changed: r.moved.length, ids: r.moved.map((m) => m.id), moved: r.moved, toast: repeatToast(e, r.moved.length, r.skipped.length) } };
  }
  const doc = watched(file).doc;
  const nodes = new Map<string, Record<string, unknown> | null>();
  const paths: string[] = [];
  for (const id of ids) {
    if (id.includes("/")) { paths.push(id); continue; }
    try { nodes.set(id, findNode(doc, id).node as Record<string, unknown>); } catch { nodes.set(id, null); }
  }
  const plan = planRepeat(e, nodes);
  // Layers inside an instance take a set value as an override; a change from their own value needs the layer's
  // number, which lives in the component: they are left out of a relative repeat.
  const relative = Object.keys(e.rel).length > 0;
  const targets = Object.keys(plan.each);
  const gesture = "repeat-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let skipped = plan.skipped.length;
  if (paths.length && (relative || targets.length)) skipped += paths.length;
  if (paths.length && !relative && !targets.length) {
    const r = updateWithOverrides(file, { file, ids: paths, props: e.props, remove: e.remove, gesture }, { source: by === "mcp" ? "mcp" : "user", session });
    if (r.revision) docChanged(file, r.revision, by, { id: r.ids[0] });
    if (by === "inspector") bridgeEmit("user_edit", { file: displayPath(file), id: r.ids[0], ids: r.ids, props: Object.keys(e.props), remove: e.remove });
    return { status: 200, body: { ok: true, label: e.label, changed: r.ids.length, ids: r.ids, each: {}, toast: repeatToast(e, r.ids.length, plan.skipped.length) } };
  }
  if (!targets.length) return { status: 200, body: { ok: true, label: e.label, changed: 0, ids: [], each: {}, toast: repeatToast(e, 0, skipped) } };
  const r = await updateMany(file, { file, ids: targets, props: {}, each: plan.each, remove: plan.remove, gesture }, by, session);
  return { status: 200, body: { ok: true, label: e.label, changed: r.changed ? targets.length : 0, ids: targets, each: plan.each, remove: plan.remove, revision: r.revision, toast: repeatToast(e, r.changed ? targets.length : 0, skipped) } };
}

function updateMerge(b: { merge?: unknown; gesture?: unknown }, key: string): { mergeKey: string; mergeMs?: number } {
  if (isGroupMerge(b.merge)) return { mergeKey: b.merge, mergeMs: GROUP_MERGE_MS };
  const g = typeof b.gesture === "string" && b.gesture ? b.gesture : "";
  return { mergeKey: key + (g ? `#gesture:${g.slice(0, 64)}` : ""), ...(b.gesture ? { mergeMs: 60_000 } : {}) };
}

/**
 * Hold a response's writes and its end, in order, while journal fsyncs are pending (docwriter.ts journalSynced). A
 * response with nothing pending writes straight through. A held write answers false (backpressure: a piped stream
 * pauses) and "drain" follows once it went out, so a stream that respects it keeps one chunk waiting. Writers that
 * ignore it (event streams) queue what they send during one fsync, a few ms.
 */
export function gateOnJournal(res: http.ServerResponse): void {
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
  let chain: Promise<void> | undefined;
  let ending = false;
  const gate = (fn: () => unknown, isWrite: boolean): boolean => {
    const wait = journalSynced();
    if (!wait && !chain) return fn() !== false;
    const p: Promise<void> = (chain ?? Promise.resolve())
      .then(() => wait)
      .then(() => {
        // The socket's own "drain" follows a write it could not take at once.
        if (fn() !== false && isWrite && !ending) res.emit("drain");
      })
      .catch((e) => {
        console.error(scrubSecrets(`[canvas] response: ${(e as Error).message}`));
        res.destroy(e as Error);
      });
    chain = p;
    void p.finally(() => { if (chain === p) chain = undefined; });
    return false;
  };
  res.write = ((...a: unknown[]) => gate(() => write(...a), true)) as typeof res.write;
  res.end = ((...a: unknown[]) => ((ending = true), gate(() => end(...a), false), res)) as typeof res.end;
}

export function startServer(port = PORT()): Promise<http.Server> {
  const ver = version();
  const send = (res: http.ServerResponse, status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(body);
  };
  const json = (res: http.ServerResponse, v: unknown, status = 200) => send(res, status, "application/json", JSON.stringify(v));
  // Talk to the selection (src/agent-run.ts): local agent runs on what is selected, their threads, their events.
  const agentCtx: AgentCtx = {
    docOf: (file) => { try { return watched(resolveDocPath(file)); } catch { return null; } },
    port: () => (server.address() as { port: number }).port, version: () => ver,
    finish: (file, summary) => finishWork({ file, summary }, bridgeCtx), render: (f, id, out) => renderInChild((server.address() as { port: number }).port)(f, id, out),
  };
  // Variations in one keystroke (src/variations.ts): the copies and the Keep and Discard deletes go through the
  // structure route's own steps (written, pages told, new boards kept on their page).
  const varCtx: VarCtx = {
    ...agentCtx,
    structure: async (file, b, who) => {
      await prime(file);
      const docFile = resolveDocPath(file);
      const before = currentDoc(docFile).doc.children.map((n) => String(n.id));
      const r = runStructure(docFile, b, who);
      await keepOnPage(docFile, b, before);
      const by = who.source === "mcp" ? "mcp" : "inspector";
      if (r.revision) docChanged(docFile, r.revision, by, { id: r.select[0] ?? null, structure: r.label ?? r.op });
      if (by === "mcp") for (const id of r.select.slice(0, 20)) trackChange(docFile, id, bridgeCtx);
      else bridgeEmit("user_edit", { file: displayPath(docFile), id: r.select[0] ?? null, ids: b.ids ?? [], structure: r.label ?? r.op, props: [], remove: [] });
      return { select: r.select, revision: r.revision };
    },
    // The boards' drawn boxes from the page showing the file: a board that hugs its content has no size in the file.
    measure: async (file, ids) => {
      const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
      for (let i = 0; i < ids.length && i < 300; i += 50) {
        try {
          const r = (await dispatch({ op: "measure", args: { ids: ids.slice(i, i + 50) }, file, timeoutMs: 4000 }, bridgeCtx)).result as { nodes: { id: string; world?: { x: number; y: number; w: number; h: number } }[] };
          for (const n of r.nodes) if (n.world) out[n.id] = n.world;
        } catch { break; }
      }
      return out;
    },
    layout: async (file, b, who) => {
      await prime(file);
      const docFile = resolveDocPath(file);
      const r = runLayout(docFile, b, who);
      const by = who.source === "mcp" ? "mcp" : "inspector";
      if (r.revision) docChanged(docFile, r.revision, by, { id: r.select[0] ?? null, structure: r.label });
      return { select: r.select, revision: r.revision };
    },
  };

  const server = http.createServer(async (req, res) => {
    // canvas-mcp's heartbeat (src/onboarding.ts) says an agent is connected; it is not someone using Canvas.
    if (!(req.url ?? "").startsWith("/api/mcp/hello")) lastActivity = Date.now();
    // Nothing leaves the server before the crash journal holds every edit made so far durably (docwriter.ts group
    // commit): not an edit's answer (its request ends after its journal line was appended, whichever route made it),
    // and not what tells others about it (bridge events a GET waits for, docdiff on an event stream).
    gateOnJournal(res);
    // Only this machine's browser or the Canvas app, by name too: a web page that rebinds its own
    // domain to 127.0.0.1 gets nothing.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return send(res, 403, "text/plain", "forbidden");
    // Anything that changes something comes from this server's own pages or from a client with no Origin (the app,
    // canvas-mcp): never from another site or another local port, whatever headers it managed to send.
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && !originOk(req)) return send(res, 403, "text/plain", "forbidden");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    noteAgent(req);
    noteMcp(req);
    try {
      const fileQ = url.searchParams.get("file");
      if (fileQ) await prime(fileQ);
      if (await handleShaderRoute(req, res, url, (f, id) => trackChange(f, "widget:" + id))) return;
      if (await handleImageRoute(req, res, url)) return;
      if (await handleVideoRoute(req, res, url, (f, id) => trackChange(f, "widget:" + id))) return;
      if (await handleWidgetRoute(req, res, url, (f, id) => trackChange(f, "widget:" + id))) return;
      if (await handleCommentsRoute(req, res, url, tellCommentPages)) return;
      if (await handleCloudRoute(req, res, url, tellCommentPages)) return;
      if (await handleAgentRoute(req, res, url, agentCtx)) return;
      if (await handleOnboardingRoute(req, res, url, json)) return;
      if (await handleUsageCountsRoute(req, res, url)) return;
      if (await handleVariationsRoute(req, res, url, varCtx)) return;
      if (await handleBridge(req, res, url, bridgeCtx)) return;
      // Deleting a page deletes its boards: one structure step that the page's own removal joins (src/pages.ts).
      if (await handlePagesRoute(req, res, url, (docFile) => watched(docFile).boards.map((b) => b.id), (docFile, ids, merge, rec) => {
        // Hidden boards listed on the page go too; the hidden "Deleted components" holder never does.
        const top = new Map(currentDoc(docFile).doc.children.map((n) => [String(n.id), n as DocNode]));
        const boards = ids.filter((id) => top.has(id) && !isDeletedHolder(top.get(id)));
        if (!boards.length) return 0;
        const by = rec.source === "mcp" ? "mcp" : "inspector";
        const r = runStructure(docFile, { op: "delete", ids: boards, merge }, { source: rec.source ?? "user", session: rec.session });
        if (r.revision) docChanged(docFile, r.revision, by, { id: null, structure: "Delete" });
        if (by !== "mcp") bridgeEmit("user_edit", { file: displayPath(docFile), id: null, ids: boards, structure: "Delete", props: [], remove: [] });
        return boards.length;
      })) return;
      if (await handleHistoryRoute(req, res, url, (f) => resolveDocPath(f), { docWritten: (docFile, rev) => docChanged(docFile, rev, "inspector", { undo: true }) })) return;
      // Board drags, arrow-key nudges and the MCP's move_board (src/move.ts).
      if (await handleMoveRoute(req, res, url, {
        measure: varCtx.measure, prime, docFileOf: (f) => resolveDocPath(f), docOf: (docFile) => watched(docFile).doc, revisionOf: (docFile) => watched(docFile).revision,
        written: (docFile, rev, by, id) => {
          if (rev) docChanged(docFile, rev, by, { id });
          if (by === "mcp") trackChange(docFile, id, bridgeCtx);
          else bridgeEmit("user_edit", { file: displayPath(docFile), id, props: ["x", "y"], remove: [] });
        },
        // An arrow-key nudge is an edit Repeat can do again on another selection (src/repeat.ts).
        moved: (docFile, b) => noteEdit(docFile, fromNudge(lastEdit(docFile), b)),
      })) return;
      // Resize handles and Resize to fit (src/resize.ts, src/page/live.js): the node and its children, one undo step.
      if (await handleResizeRoute(req, res, url, {
        prime, docFileOf: (f) => resolveDocPath(f), revisionOf: (docFile) => watched(docFile).revision,
        written: (docFile, rev, by, ids) => {
          if (rev) docChanged(docFile, rev, by, { id: ids[0] ?? null });
          if (by === "mcp") for (const id of ids.slice(0, 20)) trackChange(docFile, id, bridgeCtx);
          else bridgeEmit("user_edit", { file: displayPath(docFile), id: ids[0], props: ["width", "height", "x", "y"], remove: [] });
          void cache.ensure(docFile).catch(() => {}); // pages hear the change now, not when the file watcher notices it
        },
      })) return;
      // The scale tool (K), the inspector's Scale field and scale_nodes (src/scale.ts): a layer and everything in it, one undo step.
      if (await handleScaleRoute(req, res, url, {
        prime, docFileOf: (f) => resolveDocPath(f),
        written: (docFile, rev, by, ids) => {
          if (rev) docChanged(docFile, rev, by, { id: ids[0] ?? null });
          if (by === "mcp") for (const id of ids.slice(0, 20)) trackChange(docFile, id, bridgeCtx);
          else bridgeEmit("user_edit", { file: displayPath(docFile), id: ids[0], ids: ids.slice(0, 200), props: ["width", "height", "x", "y"], remove: [] });
          void cache.ensure(docFile).catch(() => {});
        },
      })) return;
      // Export as PNG / SVG (src/export.ts), in a child process: the renderer blocks while Chrome works.
      if (await handleExportRoute(req, res, url, { prime, docFileOf: (f) => resolveDocPath(f), port: () => (server.address() as { port: number }).port })) return;
      if (await handleCopyAsRoute(req, res, url, { prime, docFileOf: (f) => resolveDocPath(f), port: () => (server.address() as { port: number }).port })) return;
      // Delete, duplicate, copy/cut/paste, group, ungroup, reorder (src/structure.ts): one write, one undo step each.
      if (await handleStructureRoute(req, res, url, {
        measure: varCtx.measure, prime, docFileOf: (f) => resolveDocPath(f),
        written: (docFile, rev, by, ids, label) => {
          if (rev) docChanged(docFile, rev, by, { id: ids[0] ?? null, structure: label });
          if (by === "mcp") for (const id of ids.slice(0, 20)) trackChange(docFile, id, bridgeCtx);
          else bridgeEmit("user_edit", { file: displayPath(docFile), id: ids[0] ?? null, ids, structure: label, props: [], remove: [] });
        },
      })) return;
      // Auto layout: add, remove, place (reorder, drag in/out), sizing, settings (src/autolayout.ts): one undo step each.
      if (await handleLayoutRoute(req, res, url, {
        prime, docFileOf: (f) => resolveDocPath(f),
        written: (docFile, rev, by, ids, label) => {
          if (rev) docChanged(docFile, rev, by, { id: ids[0] ?? null, structure: label });
          if (by === "mcp") for (const id of ids.slice(0, 20)) trackChange(docFile, id, bridgeCtx);
          else bridgeEmit("user_edit", { file: displayPath(docFile), id: ids[0] ?? null, ids, structure: label, props: [], remove: [] });
        },
      })) return;
      // Inline text editing (src/textedit.ts, src/page/text-edit.js): one write when the edit ends, one undo step.
      if (await handleTextRoute(req, res, url, {
        prime, docFileOf: (f) => resolveDocPath(f),
        written: (docFile, rev, by, id, deleted) => {
          if (rev) docChanged(docFile, rev, by, deleted ? { id, structure: "Delete" } : { id });
          if (by === "mcp") trackChange(docFile, id, bridgeCtx);
          else bridgeEmit("user_edit", { file: displayPath(docFile), id, ...(deleted ? { ids: [id], structure: "Delete", props: [] } : { props: ["content"] }), remove: [] });
          void cache.ensure(docFile).catch(() => {});
        },
      })) return;
      // Reset overrides on an instance or a layer inside one (src/overrides.ts): one write, one undo step.
      if (await handleOverrideRoute(req, res, url, {
        prime, docFileOf: (f) => resolveDocPath(f),
        written: (docFile, rev, by, id) => {
          if (rev) docChanged(docFile, rev, by, { id });
          if (by === "mcp") trackChange(docFile, id, bridgeCtx);
          else bridgeEmit("user_edit", { file: displayPath(docFile), id, props: [], remove: [] });
        },
      })) return;
      // app names Canvas: the Mac app stops a server on its port only when it is positively Canvas (ServerCode.health).
      if (url.pathname === "/health") return json(res, { ok: true, app: "canvas", version: ver, root: codeRootId() });
      if (url.pathname === "/quit" && req.method === "POST") {
        // A foreign page can submit a form here (no preflight for a simple POST): it carries neither the header nor our Origin.
        if (req.headers["x-canvas"] !== "1" || !originOk(req)) return json(res, { error: "forbidden" }, 403);
        json(res, { ok: true });
        // Edits still being written land first; what cannot land in time is kept in a recovery copy (quitSafely).
        quitSafely(0);
        return;
      }
      if (url.pathname === "/asset") {
        const p = path.resolve(url.searchParams.get("p") ?? "");
        const type = ASSET_TYPES[path.extname(p).toLowerCase()];
        const ok = type ? await fs.promises.stat(p).then((st) => st.isFile(), () => false) : false;
        if (!type || !ok) return send(res, 404, "text/plain", "not found");
        // Revalidated by size and modification time after a minute: a reload asks, and an unchanged image is a 304
        // with no bytes; a file replaced on disk under the same name is fetched again.
        const st = await fs.promises.stat(p).catch(() => null);
        const etag = st ? `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"` : "";
        if (etag && req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag, "cache-control": "max-age=60", "cross-origin-resource-policy": "same-origin" });
          res.end();
          return;
        }
        // An SVG opened as a document must not run script with this origin (it could call /api/*): the sandbox CSP
        // gives it an opaque origin and no script. Images and fonts loaded by the page are unaffected.
        // Any image on disk is reachable by path: another site may not embed one (and learn that it exists, or its size).
        res.writeHead(200, { "content-type": type, "cache-control": "max-age=60", ...(etag ? { etag } : {}), "x-content-type-options": "nosniff", "content-security-policy": ASSET_CSP, "cross-origin-resource-policy": "same-origin" });
        streamFile(p, res);
        return;
      }
      // The inspector's manual controls: one node's properties, merged. The same write path the
      // agent's MCP uses, so every tool and every open page see one file. The custom header keeps
      // a foreign web page from posting here (it would need a CORS preflight, which is never answered).
      // Wait until the state Canvas shows is on disk: {revision, fileRevision} (fileRevision is the file hash revision of
      // those bytes), or 503 not_saved. render_node and the headless export use it.
      if (url.pathname === "/api/flush" && req.method === "POST") {
        if (req.headers["x-canvas"] !== "1") return json(res, { error: "forbidden" }, 403);
        const raw = await readBodyText(req, 100_000);
      if (raw === null) return json(res, { error: "too large" }, 413);
        let f: string;
        try {
          f = String((JSON.parse(raw || "{}") as { file?: string }).file ?? "");
          if (!f) return json(res, { error: "file is required" }, 400);
          await prime(f);
          f = resolveDocPath(f);
          watched(f);
        } catch (e) {
          return json(res, { error: (e as Error).message, code: "not_found" }, 404);
        }
        // Edits keep arriving while it waits: flush again until the state shown and the bytes on disk are one.
        for (let i = 0; i < 20; i++) {
          try {
            await flushWrites(f, { early: true }); // answers once the bytes are in place (docwriter flushOne)
          } catch (e) {
            return json(res, { error: (e as Error).message, code: "not_saved" }, 503);
          }
          await cache.ensure(f).catch(() => {});
          const fileRevision = persistedRevision(f);
          if (fileRevision) return json(res, { ok: true, revision: watched(f).revision, fileRevision });
          // The write that landed is still finishing (its bookkeeping, a whole write after a save log): wait for it, not
          // a fixed 25 ms (most flushes that came back for a second look waited 20 ms on a write done in 1).
          await writeSettled(f, 25);
        }
        return json(res, { error: "the document kept changing; Canvas's state and the file did not settle", code: "not_saved" }, 503);
      }
      if (url.pathname === "/api/update" && req.method === "POST") {
        if (req.headers["x-canvas"] !== "1") return json(res, { error: "forbidden" }, 403);
        const raw = await readBodyText(req, 1_000_000);
      if (raw === null) return json(res, { error: "too large" }, 413);
        // `each`: a value per layer ({id: props}, a Mixed field stepped from each layer's own value), one undo step.
        // `rel`: which keys changed from the layer's own value ({key: {op, by}}), so Repeat does the same change (src/repeat.ts).
        const b = JSON.parse(raw) as UpdateBody;
        if (b.each && (typeof b.each !== "object" || Array.isArray(b.each))) return json(res, { error: "each must map ids to props" }, 400);
        // A layer inside a component instance: the edit is an override on the instance (src/overrides.ts).
        if (b.file && [b.id, ...(Array.isArray(b.ids) ? b.ids : [])].some((i) => typeof i === "string" && i.includes("/"))) {
          try {
            await prime(b.file);
            const file = resolveDocPath(b.file);
            const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
            const r = updateWithOverrides(file, b, { source: by === "mcp" ? "mcp" : "user", session: String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined });
            noteEdit(file, fromUpdate(b));
            if (r.revision) docChanged(file, r.revision, by, { id: r.ids[0] });
            if (by === "inspector") bridgeEmit("user_edit", { file: displayPath(file), id: r.ids[0], ids: r.ids, props: Object.keys(b.props ?? {}), remove: b.remove ?? [] });
            return json(res, { ok: true, revision: r.revision, ids: r.ids });
          } catch (e) {
            if (e instanceof OverrideError) return json(res, { error: e.message, code: e.code }, e.status);
            if (e instanceof StaleFileError) return json(res, { error: (e as Error).message, code: "stale_revision" }, 409);
            return json(res, { error: (e as Error).message }, 422);
          }
        }
        // Several selected layers (the inspector's "N selected"): the same props on each, one write, one undo step.
        if (Array.isArray(b.ids) && (b.ids.length > 1 || b.each) && !b.id) {
          if (!b.file || typeof b.props !== "object" || b.ids.some((i) => typeof i !== "string" || !i)) return json(res, { error: "file, ids and props are required" }, 400);
          // Cards selected with layers (widgets, videos, shaders) have no layer properties: the layers take the edit.
          b.ids = b.ids.filter((i) => !i.startsWith("widget:"));
          if (!b.ids.length) return json(res, { error: "cards have no layer properties to change", code: "invalid" }, 400);
          try {
            await prime(b.file);
            const file = resolveDocPath(b.file);
            const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
            const r = await updateMany(file, b as UpdateBody & { ids: string[] }, by, String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined);
            noteEdit(file, fromUpdate(b));
            return json(res, { ok: true, revision: r.revision, ids: b.ids });
          } catch (e) {
            if (e instanceof StaleFileError) return json(res, { error: (e as Error).message, code: "stale_revision" }, 409);
            return json(res, { error: (e as Error).message }, 422);
          }
        }
        if (Array.isArray(b.ids) && b.ids.length === 1 && !b.id) b.id = b.ids[0];
        if (!b.file || !b.id || typeof b.props !== "object") return json(res, { error: "file, id and props are required" }, 400);
        try {
          await prime(b.file);
          const file = resolveDocPath(b.file);
          // Auto letter spacing (src/tracking.ts): an auto text node recomputes in the same write as its font change.
          const metrics = await prepareAutoTracking(watched(file).doc, b.id, b.props ?? {}, b.remove ?? []);
          let op: NodeOp | undefined;
          // A main component renamed: instances still named after it follow, in the same step.
          const followers = renameFollowers(watched(file).doc, b.id, b.props ?? {});
          let follow: NodeOp[] = [];
          const { result, write } = editDoc(file, { expectedRevision: b.expectedRevision, touches: [b.id, ...followers] }, (doc) => {
            // The node before the change, for undo. editDoc may run this twice (a replay after an outside
            // save); the last run is the one written.
            const found = findNode(doc, b.id!);
            const before = propsOf(found.node);
            const node = updateNode(doc, b.id!, withoutPlacedXY(found.parent, found.node, b.props ?? {}), b.remove ?? []);
            applyAutoTracking(doc, node, b.props ?? {}, metrics, b.remove ?? []);
            op = nodeDiff(b.id!, before, propsOf(node));
            follow = followRename(doc, followers);
            const n = { ...node };
            delete n.children;
            return n;
          });
          const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
          noteEdit(file, fromUpdate(b));
          if (op) {
            const keys = [...new Set([...Object.keys(b.props ?? {}), ...(b.remove ?? [])])].sort();
            record(file, [op, ...follow], { label: nodeLabel(keys), source: by === "mcp" ? "mcp" : "user", session: String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined, ...updateMerge(b, `node:${b.id}:${keys.join(",")}`), edit: write.edit }, write.revision);
          }
          if (write.revision) docChanged(file, write.revision, by, { id: b.id });
          if (by === "mcp") trackChange(file, b.id, bridgeCtx);
          if (by === "inspector") bridgeEmit("user_edit", { file: displayPath(file), id: b.id, props: Object.keys(b.props ?? {}), remove: b.remove ?? [] });
          return json(res, { ok: true, revision: write.revision, node: result });
        } catch (e) {
          if (e instanceof StaleFileError) return json(res, { error: (e as Error).message, code: "stale_revision" }, 409);
          return json(res, { error: (e as Error).message }, 422);
        }
      }
      // Selection colours (src/selection-colors.ts): each colour the selection uses, once; one edit changes it everywhere.
      if (url.pathname === "/api/selection-colors") {
        const read = async (file: string, ids: string[]) => {
          await prime(file);
          const doc = watched(resolveDocPath(file)).doc;
          return ids.flatMap((id) => { try { return [findNode(doc, id).node as DocNode]; } catch { return []; } });
        };
        try {
          if (req.method === "GET") {
            const f = url.searchParams.get("file");
            const ids = (url.searchParams.get("ids") ?? "").split(",").filter((i) => i && !i.includes("/") && !i.startsWith("widget:")).slice(0, 500);
            if (!f) return json(res, { error: "file is required" }, 400);
            return json(res, { colors: selectionColors(await read(f, ids)).slice(0, 200) });
          }
          if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return json(res, { error: "forbidden" }, 403);
          const raw = await readBodyText(req, 200_000);
          if (raw === null) return json(res, { error: "too large" }, 413);
          const b = JSON.parse(raw || "{}") as { file?: string; ids?: string[]; from?: string; to?: string; gesture?: string };
          if (!b.file || !Array.isArray(b.ids) || typeof b.from !== "string" || typeof b.to !== "string") return json(res, { error: "file, ids, from and to are required" }, 400);
          const each = replaceEach(await read(b.file, b.ids.filter((i) => typeof i === "string" && !i.includes("/"))), b.from, b.to);
          const targets = Object.keys(each);
          if (!targets.length) return json(res, { ok: true, ids: [] });
          const file = resolveDocPath(b.file);
          const r = await updateMany(file, { file, ids: targets, props: {}, each, gesture: typeof b.gesture === "string" ? b.gesture : undefined }, "inspector");
          return json(res, { ok: true, revision: r.revision, ids: targets });
        } catch (e) {
          if (e instanceof StaleFileError) return json(res, { error: (e as Error).message, code: "stale_revision" }, 409);
          return json(res, { error: (e as Error).message }, 422);
        }
      }
      // Edit > Repeat (the "." key): the last property edit again, on the layers selected now (src/repeat.ts).
      if (url.pathname === "/api/repeat") {
        if (req.method === "GET") {
          const f = url.searchParams.get("file");
          if (!f) return json(res, { error: "file is required" }, 400);
          return json(res, { repeat: repeatInfo(resolveDocPath(f)) });
        }
        if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return json(res, { error: "forbidden" }, 403);
        const raw = await readBodyText(req, 200_000);
        if (raw === null) return json(res, { error: "too large" }, 413);
        try {
          const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
          const r = await repeatEdit(JSON.parse(raw || "{}"), by, String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined);
          return json(res, r.body, r.status);
        } catch (e) {
          if (e instanceof MoveError) return json(res, { error: e.message, code: e.code }, e.status);
          if (e instanceof OverrideError) return json(res, { error: e.message, code: e.code }, e.status);
          if (e instanceof StaleFileError) return json(res, { error: (e as Error).message, code: "stale_revision" }, 409);
          return json(res, { error: (e as Error).message }, 422);
        }
      }
      if (url.pathname === "/api/canvas/rename" && req.method === "POST") {
        if (req.headers["x-canvas"] !== "1") return json(res, { error: "forbidden" }, 403);
        const raw = await readBodyText(req, 100_000);
        if (raw === null) return json(res, { error: "too large" }, 413);
        try {
          const b = JSON.parse(raw || "{}") as { file: string; name: unknown };
          if (typeof b.file !== "string" || !b.file) throw new DocError(400, "file is required");
          const src = resolveDocPath(b.file);
          await flushWrites(src);
          await compactWrites(src);
          await settleShaderSources(b.file);
          const file = renameCanvas(b.file, b.name);
          fileList = [];
          scanStartedAt = 0;
          return json(res, { ok: true, file });
        } catch (e) {
          return json(res, { error: (e as Error).message }, e instanceof DocError ? e.status : 400);
        }
      }
      if ((url.pathname === "/api/canvas/new" || url.pathname === "/api/canvas/save-as") && req.method === "POST") {
        if (req.headers["x-canvas"] !== "1") return json(res, { error: "forbidden" }, 403);
        const raw = await readBodyText(req, 100_000);
      if (raw === null) return json(res, { error: "too large" }, 413);
        try {
          const b = JSON.parse(raw || "{}") as { file?: string; target?: string };
          const warnings: string[] = [];
          if (url.pathname === "/api/canvas/save-as") {
            // Save As copies the file on disk: every edit made so far must be in it first.
            let src: string | undefined;
            try {
              src = resolveDocPath(String(b.file ?? ""));
            } catch {}
            if (src) {
              try {
                await flushWrites(src);
                await compactWrites(src); // Save As copies document.json: whole, not with edits only in its save log
                // A shader card undone since its source last loaded: its file is put back to the source its config names.
                await settleShaderSources(String(b.file ?? ""));
              } catch (e) {
                return json(res, { error: `Save As did not copy anything: the document's latest edits could not be saved first (${(e as Error).message}).`, code: "not_saved" }, 503);
              }
            }
          }
          const file = url.pathname === "/api/canvas/new" ? newCanvas(b.target) : saveAsCanvas(b.file, b.target, warnings);
          if (url.pathname === "/api/canvas/new") countUsage("file.new");
          fileList = [];
          scanStartedAt = 0;
          return json(res, { ok: true, file, ...(warnings.length ? { warnings } : {}) });
        } catch (e) {
          return json(res, { error: (e as Error).message }, e instanceof DocError ? e.status : 400);
        }
      }
      if (url.pathname === "/api/files") return json(res, await listFiles());
      // The GPU engine's inputs: a resolved board tree and font file bytes (src/scene.ts).
      if (await handleEngineRoute(url, res, (f) => watched(resolveDocPath(f)), req)) return;
      // The scene environment rides on the page (src/keyed.ts): keyed board requests carry it as v.
      // data-engine: whether the engine build is there, so a browser can say why it draws with the fallback renderer.
      if (url.pathname === "/") {
        const engine = fs.existsSync(path.join(enginePkgDir(), "canvas_engine.js")) ? "ok" : "missing";
        return send(res, 200, "text/html; charset=utf-8", PAGE.replace('<html lang="en">', `<html lang="en" data-env="${sceneEnv()}" data-engine="${engine}">`));
      }
      const fileParam = url.searchParams.get("file");
      if (!fileParam) return json(res, { error: "file is required" }, 400);
      let snap: Snapshot;
      try {
        snap = watched(resolveDocPath(fileParam));
      } catch (e) {
        return json(res, { error: (e as Error).message }, 404);
      }
      if (await handleDocRoute(url, snap, bridgeCtx, (v, status) => json(res, v, status))) return;
      if (handleUsageRoute(url, snap.doc, (v, status) => json(res, v, status))) return;
      if (handleSearchRoute(url, snap, (v, status) => json(res, v, status))) return;
      if (handleLayersRoute(url, snap, (v, status) => json(res, v, status))) return;
      if (handleColorsRoute(url, snap.doc, snap.revision, (v, status) => json(res, v, status))) return;
      if (url.pathname === "/api/doc") return json(res, docPayload(snap));
      if (url.pathname === "/api/board") {
        const id = url.searchParams.get("id") ?? "";
        // Asked for by content key (src/keyed.ts), like /api/scene: the browser keeps an unchanged board.
        const current = snap.boards.find((m) => m.id === id)?.key;
        const k = keyedAnswer({ key: url.searchParams.get("key"), v: url.searchParams.get("v") }, current, sceneEnv(), req.headers["if-none-match"]);
        if (k.notModified) {
          res.writeHead(304, k.headers);
          res.end();
          return;
        }
        try {
          const b = boardHtml(snap.doc, snap.path, id);
          // The page compares this key with the one from /api/doc; without it every board reloads in a loop.
          res.writeHead(200, { "content-type": "application/json", "x-content-type-options": "nosniff", ...k.headers });
          res.end(JSON.stringify({ id, key: current, ...b }));
          return;
        } catch (e) {
          return json(res, { error: (e as Error).message }, 404);
        }
      }
      if (url.pathname === "/api/export-settings") {
        // Shift+Cmd+E with nothing selected (a bulk export): the layers on these boards that carry export
        // settings (metadata.canvasExports, edited in the inspector's Export section), in document order.
        const want = new Set((url.searchParams.get("boards") ?? "").split(",").filter(Boolean));
        const ids: string[] = [];
        const walk = (n: any) => {
          if (!n || typeof n !== "object") return;
          if (Array.isArray(n.metadata?.canvasExports) && n.metadata.canvasExports.length) ids.push(String(n.id));
          if (n.type !== "ref") for (const c of n.children ?? []) walk(c);
        };
        for (const b of (snap.doc.children ?? []) as any[]) if (!want.size || want.has(String(b.id))) walk(b);
        return json(res, { ids });
      }
      if (url.pathname === "/api/node") {
        const hit = nodeAt(snap, url.searchParams.get("id") ?? "", nodeDepth(url.searchParams.get("depth")));
        if (!hit) return json(res, { error: `no node "${url.searchParams.get("id")}"` }, 404);
        const ctxId = url.searchParams.get("id") ?? "";
        const context = contextTarget(snap.doc, ctxId);
        // Instances: which props are overrides, what the instance draws (the inspector shows inherited values).
        const ov = overrideInfo(snap.doc, ctxId);
        // placed: an auto layout frame places this layer (align, distribute and tidy up leave it where it is).
        let placed = false;
        try { placed = moveModeOf(snap.doc as any, ctxId).mode === "auto"; } catch {}
        return json(res, { ...hit, placed, tokens: nodeTokens(snap.doc, ctxId, ov.resolved ? { ...ov.resolved, ...hit.node } : hit.node), context: context ? { ...context, ...mediaSlot(snap.doc, context.id) } : null, overrides: ov.overrides, ...(ov.instance ? { instance: ov.instance } : {}), ...(ov.resolved ? { resolved: ov.resolved } : {}), revision: snap.revision });
      }
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        // A page coming back (a tab shown again) says which revision it has: the same one needs no whole document.
        const since = url.searchParams.get("since");
        res.write(`retry: 1000\n${since && since === snap.revision ? sse("docsame", { revision: snap.revision }) : sse("doc", docPayload(snap))}`);
        let set = clients.get(snap.path);
        if (!set) clients.set(snap.path, (set = new Set()));
        set.add(res);
        req.on("close", () => {
          set!.delete(res);
          if (!set!.size) clients.delete(snap.path);
        });
        attachWidgetClient(snap.path, req, res);
        res.write(historyMsg(snap.path));
        return;
      }
      return send(res, 404, "text/plain", "not found");
    } catch (e) {
      return json(res, { error: (e as Error).message }, 500);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// Quit when nothing has looked at the canvas for 30 minutes; the app or the page restarts it.
setInterval(() => {
  if (Date.now() - lastActivity > IDLE_EXIT_MS) quitSafely(0);
}, 60_000).unref();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  // A crash says why before the process goes: stderr and ~/Library/Logs/Canvas/server.log.
  process.on("uncaughtException", (e) => {
    const line = scrubSecrets(`${new Date().toISOString()} [canvas] uncaught: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.stderr.write(line);
    try {
      const logs = logDir();
      fs.mkdirSync(logs, { recursive: true });
      fs.appendFileSync(path.join(logs, "server.log"), line);
    } catch {}
    process.exit(1);
  });
  // Quitting the app sends SIGTERM: edits still being written land first (at most 5 s, then a recovery copy), then the usual exit code.
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) process.once(sig, () => quitSafely(code));
  // Usage counts (src/usage-counts.ts): written on the way out, sent once a day by a release build.
  process.on("exit", () => usage.flush());
  usage.start();
  startServer().then((s) => {
    const port = (s.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/${file ? `?file=${encodeURIComponent(file)}` : ""}`;
    console.log(`canvas: ${url}`);
    if (file) watched(resolveDocPath(file));
    listFiles(); // warm the file menu in the background
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Canvas</title>
<link rel="stylesheet" href="/page/widgets.css">
<link rel="stylesheet" href="/page/charts.css">
<style>
${cssVariables()}
html,body{margin:0;height:100%;overflow:hidden;background:var(--c-canvas-bg);color:var(--c-fg);font:var(--c-size-sm)/1.45 var(--c-font-sans)}
/* Nothing on the canvas is page text: a drag that starts in a card's field must never select boards, labels or other
   cards. Only places you type in take a text selection. */
html,body{-webkit-user-select:none;user-select:none}
input,textarea,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]{-webkit-user-select:text;user-select:text}
*{scrollbar-width:none}
::-webkit-scrollbar{width:var(--c-scrollbar);height:var(--c-scrollbar)}
::-webkit-scrollbar-thumb{background:var(--c-scrollbar-thumb);border-radius:calc(var(--c-scrollbar)/2);background-clip:content-box;padding:var(--c-inset)}
::-webkit-scrollbar-thumb:hover{background:var(--c-scrollbar-thumb-active);background-clip:content-box}
::-webkit-scrollbar-track:hover{background:var(--c-scrollbar-track-hover)}
#bar{position:fixed;top:34px;left:calc(var(--c-inset) + var(--c-sidebar-width));right:calc(var(--c-inset) + var(--c-props-width));display:flex;align-items:flex-start;justify-content:space-between;gap:var(--c-gap);pointer-events:none;z-index:10}
.island{pointer-events:auto;display:flex;align-items:center;gap:8px;height:var(--c-island-height);padding:0 12px;background:var(--c-island);border:1px solid var(--c-island-rim);border-radius:var(--c-radius-island);box-shadow:0 3px 3px #0000001f;transition:box-shadow var(--c-island-ease)}
.island:hover{box-shadow:0 4px 10px #0000001a}
.island b{font-size:var(--c-size-sm);font-weight:600;letter-spacing:-.01em}
#files{max-width:240px;background:transparent;color:var(--c-fg);border:0;border-radius:var(--c-radius);padding:4px 6px;font:inherit;outline:none}
#files:hover{background:var(--c-accent)}
#files:focus-visible{outline:2px solid var(--c-ring)}
#rev{color:var(--c-muted-fg);font-size:var(--c-size-2xs);font-variant-numeric:tabular-nums}
button{font:inherit;color:var(--c-fg);background:transparent;border:0;border-radius:var(--c-radius);padding:5px 10px;cursor:pointer;transition:background var(--c-fast)}
button:hover{background:var(--c-accent)}
button:focus-visible{outline:2px solid var(--c-ring)}
.spacer{flex:1}
#left{position:fixed;left:0;top:0;bottom:0;width:var(--c-sidebar-width);box-sizing:border-box;overflow:auto;background:var(--c-sidebar);border-right:1px solid var(--c-sidebar-border);padding:40px 10px 14px var(--c-inset);z-index:5;color:var(--c-sidebar-fg)}
#left h3{margin:16px 0 6px;font-size:var(--c-size-2xs);text-transform:uppercase;letter-spacing:.8px;color:var(--c-muted-fg);font-weight:600}
.row{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:var(--c-radiusRow);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:var(--c-size-xs);transition:background var(--c-fast)}
.row:hover{background:var(--c-accent)}
.row.on{background:var(--c-accent);font-weight:600}
.row .dim{color:var(--c-muted-fg);font-size:var(--c-size-2xs);font-variant-numeric:tabular-nums;margin-left:auto}
.chip{width:12px;height:12px;border-radius:3px;border:1px solid var(--c-island-rim);flex:none}
#view{position:fixed;left:var(--c-sidebar-width);top:0;right:var(--c-props-width);bottom:0;background:var(--c-canvas-bg);cursor:default;touch-action:none;overflow:hidden}
#view.panning{cursor:grabbing}
#view.hand,#view.hand *{cursor:grab!important}
#view.hand.panning,#view.hand.panning *{cursor:grabbing!important}
#view.hand *{pointer-events:none!important}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
.board{position:absolute}
.board.cv,.board.flat{content-visibility:hidden}
.board.flat{background:var(--bf,#fff)}
.board.flat>.ph{display:none}
#labels{position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:strict}
.no-labels #labels{display:none}
#labels>div{position:absolute;left:0;top:0;display:none;height:16px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--c-muted-fg);font-size:var(--c-size-xs);pointer-events:auto;cursor:default;user-select:none;-webkit-user-select:none}
#labels>div.editing{visibility:hidden}
#guides{position:absolute;left:0;top:0;pointer-events:none;display:none}
#rename{position:absolute;left:0;top:0;height:20px;box-sizing:border-box;padding:0 4px;margin:-2px 0 0 -5px;font:inherit;font-size:var(--c-size-xs);color:var(--c-fg);background:var(--c-island);border:1px solid var(--c-sel);border-radius:4px;outline:none;z-index:3}
html{--c-guide:#F24822}
#snapPop{position:fixed;display:none;z-index:30;padding:10px 12px;background:var(--c-island);border:1px solid var(--c-island-rim);border-radius:var(--c-radius-island);box-shadow:0 4px 10px #0000001a;font-size:var(--c-size-xs)}
#snapPop label{display:flex;align-items:center;gap:8px;padding:3px 0;white-space:nowrap}
#snapPop input[type=number]{width:52px;font:inherit;color:var(--c-fg);background:var(--c-muted);border:0;border-radius:var(--c-radius);padding:2px 6px}
#labels>div.sel{color:var(--c-sel)}
html{--cmp-icon:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M5 0l1.6 1.6L5 3.2 3.4 1.6zM1.6 3.4L3.2 5 1.6 6.6 0 5zM8.4 3.4L10 5 8.4 6.6 6.8 5zM5 6.8l1.6 1.6L5 10 3.4 8.4z'/%3E%3C/svg%3E")}
#labels>div.cmp,#labels>div.cmp.sel{color:var(--c-component)}
.cmpi{display:inline-block;width:10px;height:10px;flex:none;background:var(--c-component);-webkit-mask:var(--cmp-icon) center/contain no-repeat;mask:var(--cmp-icon) center/contain no-repeat}
#labels>div.cmp::before{content:"";display:inline-block;width:9px;height:9px;margin-right:4px;vertical-align:-1px;background:currentColor;-webkit-mask:var(--cmp-icon) center/contain no-repeat;mask:var(--cmp-icon) center/contain no-repeat}
.board>.ph,.eph{background:#FFFFFF66;border-radius:2px}
.eph{position:absolute;pointer-events:none}
#phc{position:absolute;left:0;top:0;pointer-events:none}
.eph.snap{background:none;border-radius:0}
.eph>img{display:block;width:100%;height:100%}
.board>.next{position:absolute;left:0;top:0;visibility:hidden}
#sel,#hov{--ov:var(--c-sel);position:absolute;display:none;pointer-events:none;border:1px solid var(--ov);box-sizing:border-box}
#sel.cmp,#hov.cmp{--ov:var(--c-component)}
#hov{opacity:.55}
.mbox{--ov:var(--c-sel);position:absolute;display:none;pointer-events:none;border:1px solid var(--ov);box-sizing:border-box;opacity:.7}
#marquee{position:absolute;display:none;pointer-events:none;border:1px solid var(--c-sel);background:color-mix(in srgb,var(--c-sel) 10%,transparent);box-sizing:border-box}
#sel.tiny i,#sel.locked i{display:none}
#sel i{position:absolute;width:8px;height:8px;background:#fff;border:1px solid var(--ov);box-sizing:border-box}
#sel i:nth-child(1){left:-4px;top:-4px}#sel i:nth-child(2){right:-4px;top:-4px}#sel i:nth-child(3){left:-4px;bottom:-4px}#sel i:nth-child(4){right:-4px;bottom:-4px}
#seldim{position:absolute;left:50%;top:100%;transform:translate(-50%,8px);background:var(--ov);color:#fff;font:500 11px/16px var(--c-font-sans);padding:0 6px;border-radius:4px;white-space:nowrap;font-variant-numeric:tabular-nums}
#props{position:fixed;right:0;top:0;bottom:0;width:var(--c-props-width);box-sizing:border-box;overflow:auto;background:var(--c-sidebar);border-left:1px solid var(--c-sidebar-border);padding:40px 14px 14px;z-index:5;color:var(--c-sidebar-fg)}
#props h2{margin:0 0 2px;font-size:var(--c-size-sm);font-weight:600}
#props .tid{color:var(--c-muted-fg);font-size:var(--c-size-2xs);margin-bottom:8px;word-break:break-all}
#props h4{margin:14px 0 4px;font-size:var(--c-size-2xs);text-transform:uppercase;letter-spacing:.8px;color:var(--c-muted-fg);font-weight:600}
#props .kv{display:flex;gap:8px;padding:2px 0;font-size:var(--c-size-xs)}
#props .k{color:var(--c-muted-fg);min-width:88px}
#props .v{word-break:break-all;white-space:pre-wrap;font-variant-numeric:tabular-nums}
#props details{margin-top:10px}
#props summary{color:var(--c-muted-fg);cursor:pointer;font-size:var(--c-size-2xs)}
#props pre{font:10px/1.55 var(--c-font-mono);background:var(--c-muted);border-radius:var(--c-radius);padding:8px;overflow:auto;max-height:260px;white-space:pre-wrap;word-break:break-all}
#msg{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);background:var(--c-island);border:1px solid var(--c-island-rim);border-radius:var(--c-radius-island);padding:7px 14px;font-size:var(--c-size-xs);display:none;z-index:20;box-shadow:0 3px 3px #0000001f}
#wtoast{position:fixed;left:50%;bottom:48px;transform:translateX(-50%);display:none;align-items:center;gap:10px;background:var(--c-island);border:1px solid var(--c-island-rim);border-radius:var(--c-radius-island);padding:5px 8px 5px 14px;font-size:var(--c-size-xs);z-index:30;box-shadow:0 3px 3px #0000001f}
/* The browser page says what it is: the engine build missing, and that the Mac app is the main way (src/onboarding.ts). */
#webhint{position:fixed;left:calc(var(--c-sidebar-width) + var(--c-inset));bottom:14px;display:flex;align-items:flex-start;gap:10px;max-width:min(560px,calc(100vw - var(--c-sidebar-width) - var(--c-props-width) - 48px));background:var(--c-island);border-radius:var(--c-radius-island);padding:9px 8px 9px 14px;font-size:var(--c-size-xs);line-height:1.45;z-index:20;box-shadow:0 0 0 .5px #0000001a,0 1px 2px #00000014,0 6px 16px #0000001a}
#webhint[hidden]{display:none}
#webhint .wh-lines{display:flex;flex-direction:column;gap:2px;padding-top:1px}
#webhint .wh-lines>div[hidden]{display:none}
#webhint code{font:500 11px/1 var(--c-font-mono);background:var(--c-muted);border-radius:5px;padding:2px 5px;-webkit-user-select:text;user-select:text}
#webhint button{flex:none;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--c-muted-fg);font:15px/22px var(--c-font-sans);padding:0;cursor:pointer}
#webhint button:hover{background:var(--c-muted);color:var(--c-fg)}
.native #bar,.native #left,.native #props,.native #msg,.native #webhint{display:none}
.native #view{left:0;right:0}
</style>
</head>
<body>
<header id="bar">
<div class="island"><b>Canvas</b><select id="files"></select></div>
<div class="island"><span id="rev"></span><span class="spacer"></span><button id="fit" title="Zoom to selection, or the whole page  F">Fit</button><button id="z100" title="Zoom to 100%  0">100%</button><button id="snapBtn" title="Snapping and nudge settings">Snap</button></div>
</header>
<aside id="left">
  <h3>Pages</h3><div id="pages"></div>
  <h3>Boards</h3><div id="boards"></div>
  <h3>Components</h3><div id="comps"></div>
  <h3>Text styles</h3><div id="styles"></div>
  <h3>Variables</h3><div id="vars"></div>
</aside>
<main id="view"><div id="world"></div><div id="labels"></div><div id="hov"></div><div id="marquee"></div><div id="sel"><i></i><i></i><i></i><i></i><span id="seldim"></span></div><canvas id="guides"></canvas></main>
<div id="snapPop" role="dialog" aria-label="Snapping"><label><input type="checkbox" data-k="objects"> Snap to objects</label><label><input type="checkbox" data-k="pixel"> Snap to pixel grid</label><label><input type="checkbox" data-k="guides"> Show smart guides</label><label>Big nudge <input type="number" min="1" max="1000" data-k="bigNudge"> px</label></div>
<aside id="props"><div id="propsBody">Click any node to inspect it.</div></aside>
<div id="msg"></div>
<div id="webhint" role="status" hidden><div class="wh-lines"><div class="wh-engine" hidden>Drawing with the fallback renderer. Run <code>pnpm build:engine</code>.</div><div class="wh-app" hidden>The Mac app is the main way to use Canvas. Run <code>pnpm app</code> to build and open it.</div></div><button type="button" aria-label="Hide" title="Hide">&#x2715;</button></div>
<script>${FIT_SCRIPT}</script>
<script>
(() => {
const q = new URLSearchParams(location.search);
const file = q.get("file");
const view = document.getElementById("view"), world = document.getElementById("world");
const selBox = document.getElementById("sel"), selDim = document.getElementById("seldim"), hovBox = document.getElementById("hov");
const api = (p) => p + "?file=" + encodeURIComponent(file);
// Board data asked for by content key and scene environment (src/keyed.ts): the browser keeps it, an unchanged
// board is never fetched again (reloads, tab switches, launches).
const SCENE_ENV = document.documentElement.dataset.env || "";
const keyedQ = (key) => (key && SCENE_ENV ? "&key=" + encodeURIComponent(key) + "&v=" + SCENE_ENV : "");
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
// Pure helpers, node-tested (src/pagelogic.ts).
const zoomAt = ${zoomAt};
const wheelAction = ${wheelAction};
const fitCam = ${fitCam};
const pickPage = ${pickPage};
const retryDelay = ${retryDelay};
const keepLabels = ${keepLabels};
const unionRect = ${unionRect};
const overlayNode = ${overlayNode};
// The camera is kept per file and page (the first page keeps the file's old key). A stored one is restored when the
// page opens; only a page never opened here fits its first board. Which page shows is this viewer's, kept per file.
let cam = null;
let restoredCam = false;
const pageKey = "canvas:page:" + file;
let activePage = store.get(pageKey) || null;
// The page this viewer had last time. Until the document's real page list is known (it may arrive after the
// 800 ms grace below), or while a page list arrives without it (another process rewriting the sidecar has the
// file aside for a moment), a fallback page shows; the remembered one is opened once it exists (pickPage).
// Only the person's own choice is remembered: picking a page, or working on the one shown. A page an agent shows
// (the bridge) or a stand-in is never written over it.
let wantPage = activePage, rememberedPage = activePage;
function rememberPage() {
  wantPage = null;
  if (activePage && rememberedPage !== activePage) { rememberedPage = activePage; store.set(pageKey, activePage); }
}
let pagesStored = null, pagesReady = false, pendingDoc = null, pagesTimer = 0;
let pageList = [{ id: "page-1", name: "Page 1", boards: [] }], pageImplicit = true, pageBoards = new Set();
// Saved under the page's own id. The file's old key (from before pages) is read for the first page only.
const camStoreKey = (p) => "canvas:" + file + "#" + (p || "page-1");
const validCam = (c) => (c && [c.x, c.y, c.z].every(Number.isFinite) && c.z > 0 ? c : null);
function loadCam(p) { return validCam(store.get(camStoreKey(p))) || (!p || p === pageList[0].id ? validCam(store.get("canvas:" + file)) : null); }
/** True when the camera shows some of this page's boards (or the page has none): a saved camera can point at empty space. */
function camShowsBoards(c) {
  if (!boards.size) return true;
  const vw = view.clientWidth || 1, vh = view.clientHeight || 1;
  for (const b of boards.values()) {
    const w = (b.w || b.meta.width || 400) * c.z, h = (b.h || b.meta.height || 400) * c.z;
    const sx = b.meta.x * c.z + c.x, sy = b.meta.y * c.z + c.y;
    if (sx < vw && sy < vh && sx + w > 0 && sy + h > 0) return true;
  }
  return false;
}
let boards = new Map(); // id -> {meta, el, loadedKey, loading}
let doc = null;         // last /api/doc payload
let sel = null;         // selected node id
let multi = null;       // every selected id (src/page/structure.js) when more than one is; sel is one of them
const labelsEl = document.getElementById("labels"), z100El = document.getElementById("z100");
const elBoard = new WeakMap(); // .board element -> board record
// LOD for the DOM fallback: ?lod=off | cull | flat. cull: boards outside the viewport plus prefetch margin skip render
// (content-visibility). flat (default): below LOD_FLAT_Z every drawn board is a flat placeholder in its fill colour too.
const lodMode = q.get("lod") || "flat";
const LOD_FLAT_Z = lodMode === "flat" ? 0.1 : 0, LOD_FLAT_OUT = LOD_FLAT_Z * 1.1, CULL = lodMode !== "off";
const WILLCHANGE = q.get("wc") === "1"; // opt-in: on the 81-board overview a will-change layer cost 30 to 50% fps (measured)
const PREFETCH = 0.6, LABEL_MIN_W = 40, LABEL_H = 16, LABEL_GAP = 6;
let VW = view.clientWidth, VH = view.clientHeight; // cached: the camera path reads no layout
let selBoard = null;
const fonts = new Set();
// Renderer: "engine" (WebGPU, the default when the browser has it), "dom" (?renderer=dom, or the fallback when
// WebGPU is missing, the engine fails to start, or its GPU device is lost), "pending" while the engine starts.
// Board records, titles and every overlay are the same in both; only the engine skips the board DOM.
const rendererParam = q.get("renderer");
let mode = rendererParam !== "dom" && navigator.gpu ? "pending" : "dom";
let rendererNote = mode === "dom" ? (rendererParam === "dom" ? "?renderer=dom" : "no WebGPU in this browser") : "";
let ev = null; // the engine view (src/page/engine-view.js) while mode is "engine"
let VL = 0, VT = 0; // the view's offset in the window, for canvas-relative hit tests
const readViewBox = () => { const r = view.getBoundingClientRect(); VL = r.left; VT = r.top; };
// Inside Canvas.app the SwiftUI shell draws the chrome; this page is just the canvas, and
// tells the shell what it shows. insets is the part of the view the shell's islands cover.
const native = q.get("shell") === "native";
if (native) document.documentElement.classList.add("native");
// In a browser: a missing engine build says so (the server checks engine/pkg), and the page points at the app. Automation
// (headless Chrome) never sees the app line unless ?hint=1 asks; Hide keeps it away on this browser.
if (!native) {
  const hint = document.getElementById("webhint"), engineLine = hint.querySelector(".wh-engine"), appLine = hint.querySelector(".wh-app");
  const missing = document.documentElement.dataset.engine === "missing";
  let hid = false;
  try { hid = localStorage.getItem("canvas:webhint") === "hidden"; } catch {}
  const app = q.get("hint") === "1" || (!navigator.webdriver && !hid);
  engineLine.hidden = !missing;
  appLine.hidden = !app;
  hint.hidden = !missing && !app;
  hint.querySelector("button").onclick = () => { hint.hidden = true; try { localStorage.setItem("canvas:webhint", "hidden"); } catch {} };
}
let insets = { l: 0, t: 0, r: 0, b: 0 };
const post = (m) => { try { window.webkit.messageHandlers.canvasState.postMessage(JSON.stringify(m)); } catch {} };
// Settings the app owns (Canvas > Settings, apps/macos/SettingsLogic.swift): the shell sends them as {cmd: "prefs"}
// (with the snapping ones, whenever the page says snapHello) and the page keeps a copy, so the next load starts with
// them. A browser has the defaults.
const PREF_DEFAULTS = { boardLabels: true, openView: "restore", scrollZooms: false, agentCursor: true, agentCursorSpeed: 1, snapshotMB: 200 };
let prefs = Object.assign({}, PREF_DEFAULTS, native ? store.get("canvas:prefs") || {} : {});
document.documentElement.classList.toggle("no-labels", !prefs.boardLabels);
function setPrefs(p) {
  if (!p || typeof p !== "object") return;
  prefs = Object.assign({}, prefs, p);
  store.set("canvas:prefs", prefs);
  document.documentElement.classList.toggle("no-labels", !prefs.boardLabels);
  if (snaps && snaps.setBudget) snaps.setBudget(Math.max(16, Number(prefs.snapshotMB) || 200) * 1048576);
  host.emit("prefs", prefs);
}
const bus = new Map();
const beforeFrame = []; // host.beforeFrame: run in flushCam before the engine draws
// What the widget layer (/page/widgets.js) needs from this script. Events: cam, visible, select, deselect, cmd.
const host = {
  view, world, file, native, post, api,
  get cam() { return cam; }, get insets() { return insets; }, get sel() { return sel && sel.id; },
  selectId: (id) => select(id), clearSel: () => deselect(), syncSel: () => syncSel(), get hand() { return space; }, setCam: (c) => { endTween(true); firstFit = null; cam = c; applyCam(); }, flushCam: () => flushNow(),
  on(n, f) { if (!bus.has(n)) bus.set(n, []); bus.get(n).push(f); },
  emit(n, a) { for (const f of bus.get(n) || []) { try { f(a); } catch (err) { console.error(err); } } },
  get doc() { return doc; }, get boards() { return boards; }, isCmp: (id) => !!doc && isComponentish(doc.marks, id),
  boxOf: (id) => { const b = boards.get(id); return b ? boxOf(b) : null; },
  worldRectOf: (id) => worldRectOf(id), fitRect: (r, pad, maxZ, o) => fitRect(r, pad, maxZ, o), fit: (id, o) => fit(id, o), fitTarget: (r, pad, maxZ) => fitTarget(r, pad, maxZ),
  // Pages: only the active page's boards are in host.boards. setPage resolves once the page shows.
  get page() { return activePage; }, get pages() { return pageList; }, get pageImplicit() { return pageImplicit; }, setPage: (id) => switchPage(id),
  pageOfBoard: (id) => { const p = pageList.find((x) => x.boards.includes(id)); return p ? p.id : null; },
  widgetOnPage: (w) => (pageList.some((p) => p.id === w.page) ? w.page : pageList[0].id) === activePage,
  widgetPageOf: null,
  widgetRect: null, es: null, early: [],
  get renderer() { return mode; }, get rendererNote() { return rendererNote; },
  get engineView() { return mode === "engine" ? ev : null; }, requestFrame: () => requestFlush(false),
  /** fn runs in every frame of the camera loop, before the engine draws (host.requestFrame asks for one). */
  beforeFrame: (fn) => { beforeFrame.push(fn); },
  pick: (cx, cy) => pick(cx, cy), pickAll: (cx, cy) => pickAll(cx, cy), layerInfo: (id) => layerInfo(id), isLocked: (id) => isLocked(id), pickSelectable: (cx, cy, deep) => pickSelectable(cx, cy, deep), chainOf: (id) => chainOf(id), radiusOf: (id, r) => (mode === "engine" && ev ? ev.radiusOf(id, r) : null),
  freeze: () => (mode === "engine" && ev ? ev.freeze() : { frozen: false }), thaw: () => (ev ? ev.thaw() : { thawed: false }),
  // Several selected layers (src/page/structure.js): the ids, in the order they were picked; sel is the last.
  selection: () => (multi ? multi.slice() : sel ? [sel.id] : []),
  setSelection: (ids) => setSelection(ids), toggleSel: (id) => setSelection(toggled(id)),
  // Optimistic board deletes: drawn nowhere until the file says otherwise (restore: the request failed).
  hideBoards: (ids) => { for (const id of ids) { const b = boards.get(id); if (!b) continue; b.gone = true; if (ev) ev.removeBoard(id); if (b.el) b.el.style.display = "none"; b.lbl.el.style.visibility = "hidden"; } requestFlush(); },
  restoreBoards: (ids) => { for (const id of ids) { const b = boards.get(id); if (!b || !b.gone) continue; b.gone = false; b.loadedKey = null; b.failedKey = null; if (b.el) b.el.style.display = ""; b.lbl.el.style.visibility = ""; } scheduleVisible(); requestFlush(); },
  get viewBox() { return { l: VL, t: VT }; },
  prefs: () => prefs,
  get selGen() { return selGen; },
};
window.canvasHost = host;
const isW = (id) => typeof id === "string" && id.startsWith("widget:");
const pageMetas = () => (doc ? doc.boards.filter((b) => pageBoards.has(b.id)) : []);
const docMsg = () => doc && ({ name: doc.name, revision: doc.revision, boards: pageMetas().map((b) => ({ id: b.id, name: b.name, width: b.width, height: b.height })), components: doc.components, styles: doc.styles, variables: doc.variables, tokens: doc.tokens });
const pagesMsg = () => ({ active: activePage, implicit: pageImplicit, list: pageList.map((p) => ({ id: p.id, name: p.name, count: p.boards.length })) });

// ---------- camera loop ----------
// Wheel, pointer and commands only change cam and ask for a frame. One rAF applies it: transform, labels,
// culling, overlays, zoom text, host.emit("cam"). Nothing in here reads layout.
let camRaf = 0, camDirty = false, gesturing = false, settleT = 0, saveT = 0, shownPct = -1, postedPct = -1, postT = 0, lastPostAt = 0;
// camWork false: only the engine wants a frame (a board, font or image arrived, tiles still rendering).
function requestFlush(camWork = true) {
  if (camWork) camDirty = true;
  // Asked from inside flushCam before it draws (live edits laid out, host.beforeFrame work): this frame draws it.
  // A second rAF here ran flushCam twice in the next frame, and the engine composited twice.
  if (camRaf || preDraw) return;
  if (document.hidden) { flushCam(); return; } // rAF does not run in a hidden page; commands still land
  camRaf = requestAnimationFrame(flushCam);
}
function flushNow() { if (camRaf) { cancelAnimationFrame(camRaf); flushCam(); } }
// Playing shader cards: sleep until the next one is due (30 fps, 60 hovered) instead of drawing every display frame.
let wakeT = 0;
function shaderWake() {
  clearTimeout(wakeT);
  const ms = ev && ev.engine.shaderWakeMs ? ev.engine.shaderWakeMs() : -1;
  if (ms >= 0 && !document.hidden) wakeT = setTimeout(() => requestFlush(false), Math.max(0, ms));
}
function applyCam() { gestureTick(); requestFlush(); }
// A gesture is any camera change. It ends 150 ms after the last one: will-change goes off so text re-rasters crisp,
// and hover hit testing resumes.
function gestureTick() {
  if (!gesturing) { gesturing = true; if (WILLCHANGE) world.style.willChange = "transform"; clearHover(); }
  clearTimeout(settleT);
  settleT = setTimeout(settle, 150);
}
function settle() {
  gesturing = false;
  if (ev) ev.refineImages();
  world.style.willChange = "";
  if (hovFrame) { cancelAnimationFrame(hovFrame); hovFrame = 0; } // a frame that never ran (page was hidden) must not block hover
  queueHover();
}
// A camera made while the view had no size (a hidden window at launch) is meaningless: never kept.
function saveCam() { if (cam && activePage && !zeroFit && view.clientWidth && view.clientHeight) store.set(camStoreKey(activePage), cam); }
function postZoom() {
  if (!native || shownPct === postedPct) return;
  const wait = 100 - (performance.now() - lastPostAt);
  clearTimeout(postT);
  if (wait > 0) { postT = setTimeout(postZoom, wait); return; }
  lastPostAt = performance.now();
  postedPct = shownPct;
  post({ zoom: shownPct });
}
let preDraw = false;
function flushCam() {
  camRaf = 0;
  if (!cam) return;
  // A drag's position goes in first: it is a live edit, and the flush below lays its board out in this frame
  // (after the flush, every move showed one frame late).
  if (mvDirty) { mvDirty = false; mvApply(); }
  preDraw = true;
  try {
    if (host.live) host.live.flush(); // live edits lay their boards out again before this frame draws (/page/live.js)
    // Work that must land in this frame, after the input it follows (an auto layout drag puts its layer at the pointer).
    for (const f of beforeFrame) { try { f(); } catch (err) { console.error(err); } }
  } finally { preDraw = false; }
  if (tween) { stepTween(performance.now()); camDirty = true; gestureTick(); }
  if (camDirty) { camDirty = false; camWork(); phDirty = true; }
  if (phDirty) drawPh();
  if (mode === "engine" && ev) {
    // The engine draws in this same frame, after the overlays moved: one rAF for both.
    let more = false;
    try { ev.setCam(cam); more = ev.frame(); } catch (err) { engineLost("engine frame failed: " + (err && err.message || err)); return; }
    engineBusy = more;
    // A hidden page draws nothing (its tab or window is out of sight): the work waits until it shows again.
    if (more && !document.hidden) camRaf = requestAnimationFrame(flushCam);
    else shaderWake();
    if (!more) { for (const b of boards.values()) if (b.ph && b.loadedKey) syncPh(b); scheduleSnap(); }
  }
  if (tween && !camRaf) { if (document.hidden) { endTween(false); requestFlush(); } else camRaf = requestAnimationFrame(flushCam); }
}
// ---------- fly-to ----------
// A camera move to a target as an ease-out tween inside the loop above (no second rAF loop): the world point
// at the middle of the free area travels in a straight line and the zoom moves in log space, so a fly out and
// back in feels even. Any wheel, drag, zoom key, new navigation or page switch cancels it where it is. Instant
// under Reduce Motion, in a hidden page, before the first camera, and in a zero-size view.
const FLY_MS = 280, reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
let tween = null;
function endTween(cancelled) {
  const t = tween;
  if (!t) return;
  tween = null;
  if (!cancelled) cam = t.to;
  t.resolve({ flight: cancelled ? "cancelled" : "done" });
}
function flyTo(to, o) {
  endTween(true);
  firstFit = null;
  if ((o && o.instant) || !cam || reduceMotion.matches || document.hidden || !view.clientWidth || !view.clientHeight) {
    cam = to;
    applyCam();
    return Promise.resolve({ flight: "instant" });
  }
  const ax = insets.l + (view.clientWidth - insets.l - insets.r) / 2, ay = insets.t + (view.clientHeight - insets.t - insets.b) / 2;
  const from = cam;
  return new Promise((resolve) => {
    tween = { from, to, t0: performance.now(), ax, ay, resolve, c0: { x: (ax - from.x) / from.z, y: (ay - from.y) / from.z }, c1: { x: (ax - to.x) / to.z, y: (ay - to.y) / to.z } };
    applyCam();
  });
}
function stepTween(now) {
  const t = tween, k = Math.min(1, (now - t.t0) / FLY_MS);
  if (k >= 1) { endTween(false); return; }
  const e = 1 - Math.pow(1 - k, 3);
  const z = Math.exp(Math.log(t.from.z) + (Math.log(t.to.z) - Math.log(t.from.z)) * e);
  const cx = t.c0.x + (t.c1.x - t.c0.x) * e, cy = t.c0.y + (t.c1.y - t.c0.y) * e;
  cam = { z, x: t.ax - cx * z, y: t.ay - cy * z };
}
document.addEventListener("visibilitychange", () => { if (document.hidden && tween) { endTween(false); requestFlush(); } if (!document.hidden) requestFlush(false); });
let engineBusy = false;
function camWork() {
  world.style.transform = "translate(" + cam.x + "px," + cam.y + "px) scale(" + cam.z + ")";
  const pct = Math.round(cam.z * 100);
  if (pct !== shownPct) { shownPct = pct; z100El.textContent = pct + "%"; postZoom(); }
  clearTimeout(saveT);
  saveT = setTimeout(saveCam, 250);
  placeBoards();
  scheduleVisible();
  placeOverlays();
  host.emit("cam");
}
addEventListener("pagehide", () => { if (cam) saveCam(); });
// One pass over the boards from cached sizes: screen-space title labels and render culling.
// States: 0 drawn, 1 outside the viewport plus margin (content-visibility), 2 flat placeholder (far zoom out).
let flatOn = false;
// Titles: each truncated to its board's on-screen width (ellipsis), hidden below ~40 px of board, and
// a collision pass over the placed rects (selected board first, then bigger boards, then document order) drops
// any title that would touch one already kept. Text widths are measured once per name in the label font (2D
// canvas, no DOM reads) and forgotten when fonts load. Hysteresis: a hidden title needs 8 px of clearance and a
// 40 px board to come back; a shown one stays while it keeps 2 px and 36 px. The pass is cached until the camera,
// board bounds, selection, names or fonts change.
const LABEL_HIDE_W = LABEL_MIN_W - 4, LABEL_KEEP_GAP = 2, LABEL_SHOW_GAP = 8;
let labelsVer = 0, labelsKey = "", labelFont = "";
const labelProbe = document.createElement("div");
labelsEl.appendChild(labelProbe);
const labelCtx = document.createElement("canvas").getContext("2d");
function labelWidth(name) {
  if (!labelFont) { labelFont = getComputedStyle(labelProbe).font || "12px sans-serif"; labelCtx.font = labelFont; }
  return Math.ceil(labelCtx.measureText(name || "").width) + 1;
}
const CMP_ICON = 13; // the diamond a component title carries (9 px + 4 px gap)
if (document.fonts) document.fonts.addEventListener("loadingdone", () => { labelFont = ""; for (const b of boards.values()) b.lbl.tw = 0; labelsVer++; requestFlush(); });
const labelPrio = (a, b) => (b === selBoard) - (a === selBoard) || b.w * b.h - a.w * a.h || a.idx - b.idx;
function placeBoards() {
  const z = cam.z, dpr = window.devicePixelRatio || 1;
  const L = -VW * PREFETCH, T = -VH * PREFETCH, R = VW * (1 + PREFETCH), B = VH * (1 + PREFETCH);
  flatOn = LOD_FLAT_Z > 0 && z < (flatOn ? LOD_FLAT_OUT : LOD_FLAT_Z); // 10% hysteresis so a zoom hovering at the threshold does not flicker
  const flat = flatOn;
  for (const b of boards.values()) {
    const sx = b.meta.x * z + cam.x, sy = b.meta.y * z + cam.y, sw = b.w * z, sh = b.h * z;
    const inMargin = sx < R && sx + sw > L && sy < B && sy + sh > T;
    if (CULL && b.el) {
      const want = !inMargin ? 1 : flat && b.loadedKey ? 2 : 0;
      if (want !== b.cv) setBoardState(b, want);
    }
  }
  placeLabels();
}
function placeLabels() {
  const key = cam.x + "," + cam.y + "," + cam.z + "," + VW + "," + VH + "," + labelsVer + "," + (selBoard ? selBoard.meta.id : "");
  if (key === labelsKey) return;
  labelsKey = key;
  const z = cam.z, dpr = window.devicePixelRatio || 1, cand = [];
  for (const b of boards.values()) {
    const lb = b.lbl, sx = b.meta.x * z + cam.x, sy = b.meta.y * z + cam.y, sw = b.w * z, ly = sy - LABEL_H - LABEL_GAP;
    // Only boards (top-level frames) carry a name above them; an instance, group, shape or text at the top level
    // does not; its name is in the layers panel.
    lb.want = (!b.meta.type || b.meta.type === "frame") && sw >= (lb.shown || b === selBoard ? LABEL_HIDE_W : LABEL_MIN_W) && sx < VW && sx + sw > 0 && sy > 0 && ly < VH;
    if (!lb.want) continue;
    if (!lb.tw) lb.tw = labelWidth(b.meta.name) + (lb.cmp ? CMP_ICON : 0);
    lb.r = { x: sx, y: ly, w: Math.min(lb.tw, Math.floor(sw)) };
    cand.push(b);
  }
  cand.sort(labelPrio);
  const keep = keepLabels(cand.map((b) => ({ x: b.lbl.r.x, y: b.lbl.r.y, w: b.lbl.r.w, g: b.lbl.shown || b === selBoard ? LABEL_KEEP_GAP : LABEL_SHOW_GAP })), LABEL_H);
  cand.forEach((b, i) => { b.lbl.want = keep[i]; });
  for (const b of boards.values()) {
    const lb = b.lbl;
    if (!lb.want) { if (lb.shown) { lb.el.style.display = "none"; lb.shown = false; } continue; }
    if (!lb.shown) { lb.el.style.display = "block"; lb.shown = true; }
    if (lb.r.w !== lb.mw) { lb.mw = lb.r.w; lb.el.style.maxWidth = lb.r.w + "px"; }
    lb.el.style.transform = "translate3d(" + Math.round(lb.r.x * dpr) / dpr + "px," + Math.round(lb.r.y * dpr) / dpr + "px,0)";
  }
}
function setBoardState(b, st) {
  if (!b.el) return;
  b.cv = st;
  const c = b.el.classList;
  c.toggle("cv", st === 1);
  c.toggle("flat", st === 2);
}
// Draw a culled board again (a measurement inside it needs real layout); the next frame culls it again if it should be.
function showBoard(b) { if (b.cv) { setBoardState(b, 0); requestFlush(); } }
// A page opened with no saved camera fits its first board before that board's real size is known (a
// fit_content board reports none): fit again once it is measured, unless the camera was moved meanwhile.
let firstFit = null;
let zeroFit = false; // the page was fitted while the view had no size: fit again once it has one
function setBoardSize(b, w, h) {
  if (b.w !== w || b.h !== h) labelsVer++;
  b.w = w; b.h = h;
  if (firstFit === b && b.measured) { firstFit = null; if (w !== b.meta.width || h !== b.meta.height) fitAll({ instant: true }); }
  if (b.el) b.el.style.containIntrinsicSize = w + "px " + h + "px";
}
function boxOf(b) { return { x: b.meta.x, y: b.meta.y, w: b.w, h: b.h }; }
// GPU renderer: a board the engine has not drawn yet (a page's first visit) shows a plain placeholder at its place
// and size, with its title, from the first frame. The DOM renderer has its own (.board>.ph).
// A board with a snapshot (/page/snapshots.js) shows it in the placeholder, and keeps it there after the engine laid
// the board out until the engine has drawn it, images included (no frame of grey tiles or empty image slots in
// between): at most SNAP_HOLD_MS, and only until the person first moves the camera or presses on the canvas.
// Placeholders without a snapshot are drawn on one canvas, not as a div each: Chrome gave each of thousands of divs
// over the engine's canvas a compositing layer of its own (they are too far apart to share one), and layerizing them
// took 250 to 300 ms a frame with 5,000 boards: 26 s of a 30 s open.
const phs = new Set();
let phDirty = false, phCanvas = null;
function flatPh() {
  const p = { flat: true, r: null, remove() { phs.delete(p); phDirty = true; requestFlush(false); } };
  phs.add(p);
  return p;
}
function drawPh() {
  phDirty = false;
  if (!phs.size && !phCanvas) return;
  if (!phCanvas) {
    phCanvas = document.createElement("canvas");
    phCanvas.id = "phc";
    view.insertBefore(phCanvas, world);
  }
  const dpr = window.devicePixelRatio || 1, w = Math.max(1, Math.round(VW * dpr)), h = Math.max(1, Math.round(VH * dpr));
  if (!phs.size || !cam) { phCanvas.style.display = "none"; return; }
  phCanvas.style.display = "";
  if (phCanvas.width !== w || phCanvas.height !== h) { phCanvas.width = w; phCanvas.height = h; phCanvas.style.width = VW + "px"; phCanvas.style.height = VH + "px"; }
  const g = phCanvas.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#FFFFFF66";
  const z = cam.z * dpr, ox = cam.x * dpr, oy = cam.y * dpr, rad = 2 * z;
  g.beginPath();
  for (const p of phs) {
    const r = p.r;
    if (!r) continue;
    const x = r.x * z + ox, y = r.y * z + oy, rw = r.w * z, rh = r.h * z;
    if (x > w || y > h || x + rw < 0 || y + rh < 0) continue;
    if (rad >= 0.5 && rw > 2 * rad && rh > 2 * rad) g.roundRect(x, y, rw, rh, rad);
    else g.rect(x, y, rw, rh);
  }
  g.fill();
}
function syncPh(b) {
  // A held picture of an older version of the board must not outlive a key change.
  if (b.snap && b.snap.el && b.snap.key !== b.meta.key) { URL.revokeObjectURL(b.snap.url); b.snap = null; }
  const shown = boards.get(b.meta.id) === b && (mode === "engine" || mode === "pending");
  const drawing = engineBusy || camRaf || (ev && ev.imagesPending() > 0);
  const want = shown && (!b.loadedKey || (b.snap && b.snap.el && snapHold && drawing && performance.now() < b.snap.until));
  if (!want) {
    if (b.ph) { b.ph.remove(); b.ph = null; }
    // A shown snapshot goes with it; a lookup still in flight checks for itself whether it is still wanted.
    if (b.snap && b.snap.el) { URL.revokeObjectURL(b.snap.url); b.snap = null; }
    return;
  }
  const r = { x: b.meta.x, y: b.meta.y, w: b.w || b.meta.width || 400, h: b.h || b.meta.height || 400 };
  if (!(b.snap && b.snap.el)) {
    // A plain placeholder is a rect on the shared placeholder canvas.
    if (b.ph && !b.ph.flat) { b.ph.remove(); b.ph = null; }
    if (!b.ph) b.ph = flatPh();
    b.ph.r = r;
    phDirty = true;
    requestFlush(false);
    return;
  }
  if (b.ph && b.ph.flat) { b.ph.remove(); b.ph = null; }
  if (!b.ph) { b.ph = document.createElement("div"); b.ph.className = "eph"; world.appendChild(b.ph); }
  if (b.snap && b.snap.el && b.snap.el.parentNode !== b.ph) { b.ph.appendChild(b.snap.el); b.ph.classList.add("snap"); }
  const st = b.ph.style;
  st.left = b.meta.x + "px"; st.top = b.meta.y + "px"; st.width = (b.w || b.meta.width || 400) + "px"; st.height = (b.h || b.meta.height || 400) + "px";
}
/** The camera that fits a world rect into the free area: padded, centered, zoom at most maxZ. */
function fitTarget(r, pad = 70, maxZ = 4) { return fitCam(r, view.clientWidth, view.clientHeight, insets, pad, maxZ); }
/** Fly to fit a world rect. Resolves when the camera arrives ({flight: done | instant}) or is cancelled. */
function fitRect(r, pad = 70, maxZ = 4, o) { return flyTo(fitTarget(r, pad, maxZ), o); }
function fit(id, o) {
  const b = boards.get(id) || boards.get(firstBoardId()) || boards.values().next().value;
  if (!b) return Promise.resolve({ flight: "none" });
  return fitRect(boxOf(b), 70, 4, o);
}
const firstBoardId = () => { const m = pageMetas()[0]; return m && m.id; };
/** The boards list: select the board and fly to it. */
function flyToBoard(id) { if (!boards.has(id)) return; select(id); fit(id); }
// A node's box in world coordinates, from where it is drawn now; null when its board is not drawn yet.
function worldRectOf(id) {
  if (isW(id)) { const r = host.widgetRect && host.widgetRect(id); return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null; }
  if (mode === "engine") return ev ? ev.rect(id) : null;
  if (mode !== "dom") return null;
  const el = liveEl(id);
  return el ? measureWorld(el) : null;
}
// The node under a window point: the engine's hit test, or the DOM's [data-id] under the pointer.
// The click rule (pickTarget in /page/geometry.js): the layer a click selects, given what is selected now.
let pickRule = null, dblRule = null, ownSize = null;
import("/page/geometry.js").then((m) => { pickRule = m.pickTarget; dblRule = m.dblClickTarget; ownSize = m.unrotatedSize; }).catch((err) => console.warn("[canvas] pick rule", err));
/** A drawn layer's ancestry from its board down to it ([board, ..., id]). */
function chainOf(id) {
  const out = [];
  if (mode === "engine" && ev && ev.parentOf) { for (let x = id, g = 0; x && g < 500; x = ev.parentOf(x), g++) out.unshift(x); }
  else if (mode === "dom") { let el = liveEl(id); while (el) { out.unshift(el.getAttribute("data-id")); el = el.parentElement && el.parentElement.closest("[data-id]"); } }
  return out.length ? out : [id];
}
/** Command held for a pointer event: its own flag, or the Command state the page and the shell track (cmdHeld). */
function metaOf(e) { return !!(e && (e.metaKey || cmdHeld)); }
/** What a click at a window point selects: the click rule, or the deepest layer with Cmd (deep). */
function pickSelectable(cx, cy, deep) {
  const leaf = pick(cx, cy);
  if (!leaf || isW(leaf) || !pickRule) return leaf;
  const selIds = (multi || (sel ? [sel.id] : [])).filter((x) => !isW(x));
  return pickRule(chainOf(leaf), selIds.map(chainOf), !!deep);
}
/** Every layer under a window point, topmost first: the engine's list, or the DOM's [data-id] elements there. */
function pickAll(cx, cy) {
  if (mode === "engine") {
    if (!ev || document.elementFromPoint(cx, cy) !== ev.canvas || !ev.pickAll) return [];
    return ev.pickAll(cx - VL, cy - VT);
  }
  if (mode !== "dom") return [];
  const out = [];
  for (const t of document.elementsFromPoint(cx, cy)) {
    const hit = t.closest && t.closest(".board>.cur [data-id]");
    const id = hit && hit.getAttribute("data-id");
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
/** A drawn layer's name and type, for lists the shell shows (Select layer), or null. */
function layerInfo(id) {
  if (mode === "engine" && ev && ev.infoOf) return ev.infoOf(id);
  const el = mode === "dom" ? liveEl(id) : null;
  return el ? { name: el.getAttribute("data-name") || "", type: el.getAttribute("data-t") || "" } : null;
}
function pick(cx, cy) {
  if (mode === "engine") {
    if (!ev || document.elementFromPoint(cx, cy) !== ev.canvas) return null; // a widget or a chrome island is on top
    return pastLocked(ev.pick(cx - VL, cy - VT));
  }
  if (mode !== "dom") return null;
  const t = document.elementFromPoint(cx, cy), hit = t && t.closest("[data-id]");
  return hit ? hit.getAttribute("data-id") : null;
}
// Locked layers (the locked property): the canvas does not pick them or anything inside them; the
// Layers panel still selects them. The engine's hit test and the DOM drawing (pointer-events) already skip them;
// this guards an engine build from before the lock, where a hit inside a locked layer goes to the layer above it.
const lockCache = new Map(); // board id -> {t: scene text, s: Set of locked ids | null}
function lockedSet(board) {
  const t = mode === "engine" && ev && ev.sceneText ? ev.sceneText(board) : null;
  if (!t) return null;
  const c = lockCache.get(board);
  if (c && c.t === t) return c.s;
  let s = null;
  if (t.includes('"locked":true')) {
    s = new Set();
    const walk = (n) => { if (!n || typeof n !== "object") return; if (n.locked === true) s.add(String(n.id)); if (Array.isArray(n.children)) n.children.forEach(walk); };
    try { walk(JSON.parse(t).root); } catch { s = null; }
  }
  lockCache.set(board, { t, s });
  return s;
}
function pastLocked(leaf) {
  if (!leaf || isW(leaf)) return leaf;
  const chain = chainOf(leaf), s = lockedSet(chain[0]);
  const k = s ? chain.findIndex((x) => s.has(x)) : -1;
  return k < 0 ? leaf : k === 0 ? null : chain[k - 1];
}
/** Is a layer locked, by itself or by a parent? */
function isLocked(id) {
  if (!id || isW(id)) return false;
  if (mode === "dom") { const el = liveEl(id); return !!(el && el.closest("[data-locked]")); }
  const chain = chainOf(id), s = lockedSet(chain[0]);
  return !!s && chain.some((x) => s.has(x));
}
// The drawn element for a node id. Only the live drawing counts: the hidden .next copy a board is
// rebuilt in (and the .ph placeholder) must never answer, or an overlay lands on something invisible.
function liveEl(id) { return world.querySelector(".board>.cur [data-id=" + JSON.stringify(id) + "]"); }
function measureWorld(el) {
  flushNow(); // the world must be where cam says before it is measured
  const be = el.closest(".board"), bd = be && elBoard.get(be);
  if (bd) showBoard(bd);
  const r = el.getBoundingClientRect(), v = view.getBoundingClientRect();
  return { x: (r.left - v.left - cam.x) / cam.z, y: (r.top - v.top - cam.y) / cam.z, w: r.width / cam.z, h: r.height / cam.z };
}
const wait = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
async function loadBoard(b) {
  const seq = (b.seq = (b.seq || 0) + 1);
  b.loading = b.meta.key;
  let d;
  try { d = await (await fetch(api("/api/board") + "&id=" + encodeURIComponent(b.meta.id) + keyedQ(b.meta.key))).json(); } catch { b.loading = null; return; }
  if (d.error || boards.get(b.meta.id) !== b) { b.loading = null; return; }
  for (const href of d.links || []) if (!fonts.has(href)) { fonts.add(href); const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l); }
  if (d.faces && !fonts.has(d.faces)) { fonts.add(d.faces); const s = document.createElement("style"); s.textContent = d.faces; document.head.appendChild(s); }
  // Build the new drawing hidden next to the old one, let fonts and images settle, then swap in one frame: no flash.
  const next = document.createElement("div");
  next.className = "next";
  next.innerHTML = d.html;
  b.el.appendChild(next);
  await wait(document.fonts.ready, 3000);
  await wait(Promise.all([...next.querySelectorAll("img")].map((i) => i.decode().catch(() => {}))), 5000);
  if (seq < (b.applied || 0) || !next.isConnected) { next.remove(); return; }
  b.applied = seq;
  showBoard(b); // a culled board has no layout to fit or measure
  window.__fit(next, cam.z);
  for (const old of b.el.querySelectorAll(":scope>.cur,:scope>.ph")) old.remove();
  next.className = "cur";
  b.measured = true;
  setBoardSize(b, next.offsetWidth || b.meta.width || 400, next.offsetHeight || b.meta.height || 400); // the one layout read per swap
  if (LOD_FLAT_Z > 0) { const f = next.firstElementChild; b.el.style.setProperty("--bf", f ? getComputedStyle(f).backgroundColor : "#fff"); }
  b.loadedKey = d.key;
  b.loading = null;
  requestFlush(); // a drawn board may now be flat or culled
  if (b.meta.key !== d.key) scheduleVisible();
  syncSel();
  queueHover();
  host.emit("render", b.meta.id);
}
let visTimer = 0;
function scheduleVisible() { if (!visTimer) visTimer = setTimeout(() => { visTimer = 0; loadVisible(); host.emit("visible"); }, 16); }
function loadVisible() {
  if (!cam) return; // no document yet
  const batch = [];
  const m = PREFETCH, vw = VW, vh = VH;
  const L = -vw * m, T = -vh * m, R = vw * (1 + m), B = vh * (1 + m);
  for (const b of boards.values()) {
    if (b.loadedKey === b.meta.key || b.loading === b.meta.key || b.gone) continue;
    const r = loadBox(b.meta, b.w, b.h, b.measured);
    const sx = r.x * cam.z + cam.x, sy = r.y * cam.z + cam.y;
    if (!(sx < R && sx + r.w * cam.z > L && sy < B && sy + r.h * cam.z > T)) continue;
    if (!b.loadedKey && !b.snap) wantSnap(b);
    // A board whose load failed is asked for again after a bounded backoff (a server hiccup must not leave it blank).
    if (mode === "engine") { if (b.failedKey !== b.meta.key || performance.now() >= b.retryAt) batch.push(b); }
    else if (mode === "dom") loadBoard(b);
  }
  if (batch.length) engineLoad(batch);
}
// Engine: fetch the boards' resolved scenes, register what they need, hand them to the engine. Only changed boards come here.
async function engineLoad(list) {
  const view0 = ev, keys = list.map((b) => b.meta.key);
  for (const b of list) b.loading = b.meta.key;
  let retryIn = 0;
  // Each board lands as soon as the engine has it (boards are placed in slices across frames, nearest first).
  const done = new Set();
  const landed = (i, r) => {
    done.add(i);
    if (ev !== view0 || mode !== "engine") return;
    const b = list[i], key = keys[i];
    // A board that left the page (or the document) while it loaded: the engine must not keep it.
    if (boards.get(b.meta.id) !== b) { if (!boards.has(b.meta.id) && ev && !ev.isParked(b.meta.id)) ev.removeBoard(b.meta.id); return; }
    if (b.loading === key) b.loading = null;
    if (r && r.stale) return;
    if (!r || !r.root) {
      b.fails = b.failedKey === key ? (b.fails || 0) + 1 : 1;
      b.failedKey = key;
      const wait = retryDelay(b.fails);
      b.retryAt = performance.now() + wait;
      retryIn = retryIn ? Math.min(retryIn, wait) : wait;
      return;
    }
    b.failedKey = null; b.fails = 0;
    b.loadedKey = r.key || key;
    perfAt("landed");
    b.measured = true;
    setBoardSize(b, r.root.w, r.root.h);
    if (b.snap && b.snap.el) { b.snap.until = performance.now() + SNAP_HOLD_MS; setTimeout(() => syncPh(b), SNAP_HOLD_MS + 20); }
    syncPh(b);
    if (b.meta.key !== b.loadedKey) scheduleVisible();
    host.emit("render", b.meta.id);
    requestFlush();
  };
  try { await ev.loadBoards(list.map((b) => b.meta), landed); } catch (err) { console.warn("[canvas] engine boards", err); }
  for (let i = 0; i < list.length; i++) if (!done.has(i)) landed(i, null); // the batch failed: retried after a backoff
  if (ev !== view0 || mode !== "engine") return;
  if (retryIn) setTimeout(scheduleVisible, retryIn + 20);
  requestFlush();
  syncSel();
  queueHover();
  ev.warmFonts(); // the first boards are up: the rest of the document's fonts follow while idle
  schedulePrefetch(); // and, a moment later, the other pages' first boards
}
/** The size badge under a selection: the inspector's numbers (two decimals at most), so H 92.8 is 92.8 on both. */
const dimNum = (v) => String(Math.round(v * 100) / 100);
const dimText = (r) => dimNum(r.w) + " × " + dimNum(r.h);
/** The badge's text: a rotated layer shows its own W × H (as the inspector does), not its bounding box. */
function badgeText(r) {
  const sh = selShape();
  if (sh) return dimNum(sh.w) + " × " + dimNum(sh.h);
  let n = null;
  try { n = !multi && sel && shownSel && shownSel.id === sel.id && shownSel.n ? shownSel.n.node : null; } catch { n = null; } // shownSel is declared further down
  const rot = n && typeof n.rotation === "number" ? n.rotation % 360 : 0;
  if (rot && typeof n.width === "number" && typeof n.height === "number") return dimNum(n.width) + " × " + dimNum(n.height);
  return dimText(r);
}
// The selection and hover boxes live in view space, not world space, so their line weight,
// handles and badge stay one size at any zoom. Each box remembers its node's rectangle in world
// coordinates (read from the live drawing once, when the node or its drawing changes) and is placed
// from the camera by arithmetic, so a camera change reads no layout and cannot go stale.
let selWorld = null, hovWorld = null, hovId = null, ptr = null, space = false;
/** The selected layer's own box when it is rotated ({r, w, h}, /page/live.js), or null. */
const selShape = () => (!multi && sel && !isW(sel.id) && host.live && host.live.shape ? host.live.shape(sel.id) : null);
function putBox(box, w) {
  if (!w || !cam) { box.style.display = "none"; return; }
  box.style.display = "block";
  if (box === selBox) {
    // A rotated layer: the box (and its handles) turn with it about its centre, sized as the layer itself;
    // the size badge under it stays upright.
    const sh = selShape();
    if (sh) {
      const bw = sh.w * cam.z, bh = sh.h * cam.z, cx = (w.x + w.w / 2) * cam.z + cam.x, cy = (w.y + w.h / 2) * cam.z + cam.y;
      box.style.left = cx - bw / 2 + "px";
      box.style.top = cy - bh / 2 + "px";
      box.style.width = bw + "px";
      box.style.height = bh + "px";
      box.style.transform = "rotate(" + -sh.r + "deg)";
      selDim.style.transform = "translate(-50%,8px) rotate(" + sh.r + "deg)";
      box.classList.toggle("tiny", bw < 10 && bh < 10);
      return;
    }
    if (box.style.transform) { box.style.transform = ""; selDim.style.transform = ""; }
  }
  box.style.left = w.x * cam.z + cam.x + "px";
  box.style.top = w.y * cam.z + cam.y + "px";
  box.style.width = w.w * cam.z + "px";
  box.style.height = w.h * cam.z + "px";
  // A selected card's outline hugs its rounded corners (12 world px, CARD_RADIUS in /page/geometry.js; widgets.css).
  const card = box === selBox ? box.classList.contains("wsel") : box.classList.contains("wbox");
  const radius = card ? 12 * cam.z + "px" : "";
  if (box.style.borderRadius !== radius) box.style.borderRadius = radius;
  // Too small on screen for handles (they hide; a press moves it): HANDLE_MIN_PX in /page/live-edit.js.
  if (box === selBox) box.classList.toggle("tiny", w.w * cam.z < 10 && w.h * cam.z < 10);
}
function placeOverlays() {
  putBox(selBox, selWorld);
  if (selWorld) selDim.textContent = badgeText(selWorld);
  placeMultiBoxes(); // each selected layer's own outline moves with the camera too
  putBox(hovBox, hovWorld);
  queueHover(); // what is under the pointer changes when the world moves under it
}
// Re-read the selected node from the live drawing, then place. Call when the selection or a drawing changes.
function syncSel() {
  // Mid-drag, and after a layer's move until its board redraws, the box shows where the person put it.
  const held = sel && (mv && mv.pos && mv.id === sel.id ? { x: mv.pos.x, y: mv.pos.y, w: mv.r0.w, h: mv.r0.h } : selHold && selHold.id === sel.id ? selHold.rect : null);
  if (held) { selWorld = held; putBox(selBox, selWorld); return; }
  if (multi) {
    // Several layers: the box goes around all of them, each gets a thin outline of its own. Mid-drag, and after a
    // drop until the boards redraw, the moved ones show where the person put them.
    const moving = mv && mv.kind === "group" && mv.pos ? groupRects(mv) : null;
    if (multiHold && performance.now() > multiHold.until) multiHold = null;
    multiWorld = multi.map((id) => (moving && moving.get(id)) || (multiHold && multiHold.rects.get(id)) || worldRectOf(id));
    const rs = multiWorld.filter(Boolean);
    selWorld = rs.length ? rs.reduce((u, r) => { const x = Math.min(u.x, r.x), y = Math.min(u.y, r.y); return { x, y, w: Math.max(u.x + u.w, r.x + r.w) - x, h: Math.max(u.y + u.h, r.y + r.h) - y }; }) : null;
  } else if (sel && isW(sel.id)) {
    // Widgets are placed by math from the camera, so a card mid-drag still gets its box.
    selWorld = host.widgetRect ? host.widgetRect(sel.id) : null;
  } else if (mode === "engine") {
    selWorld = sel && ev && cam ? ev.rect(sel.id) : null;
  } else {
    const el = sel && mode === "dom" && liveEl(sel.id);
    selWorld = el && cam ? measureWorld(el) : null;
  }
  let sb = null;
  if (sel && !isW(sel.id) && selWorld) {
    if (mode === "engine") sb = boards.get(ev.boardOf(sel.id)) || null;
    else { const bel = liveEl(sel.id).closest(".board"); sb = (bel && elBoard.get(bel)) || null; }
  }
  if (sb !== selBoard) { if (selBoard) selBoard.lbl.el.classList.remove("sel"); selBoard = sb; if (sb) sb.lbl.el.classList.add("sel"); labelsVer++; if (cam) placeLabels(); if (native) post({ selBoard: sb ? sb.meta.id : null }); if (doc) renderLeft(doc); }
  selBox.classList.toggle("cmp", !!sel && !multi && host.isCmp(sel.id));
  // A locked layer (selected in the Layers panel) shows its box without handles: it does not move or resize here.
  selBox.classList.toggle("locked", !!sel && !multi && isLocked(sel.id));
  putBox(selBox, selWorld);
  if (selWorld) selDim.textContent = badgeText(selWorld);
  placeMultiBoxes();
  // A drawn size the inspector shows is out of date (the layout moved after the last post): send it again.
  const off = (a, b) => a !== null && a !== undefined && Math.abs(a - b) > 0.01;
  if (native && sel && !multi && selWorld && postedSize && postedSize.id === sel.id && shownSel && shownSel.id === sel.id && (off(postedSize.w, selWorld.w) || off(postedSize.h, selWorld.h))) {
    cancelAnimationFrame(selPostFrame);
    selPostFrame = requestAnimationFrame(postSel);
  }
}
let multiWorld = [];
const multiBoxes = [];
function placeMultiBoxes() {
  const want = multi ? multiWorld.length : 0;
  while (multiBoxes.length < want) { const d = el("div", "mbox"); view.insertBefore(d, selBox); multiBoxes.push(d); }
  multiBoxes.forEach((d, i) => { if (i < want) { d.classList.toggle("cmp", host.isCmp(multi[i])); d.classList.toggle("wbox", isW(multi[i])); putBox(d, multiWorld[i]); } else d.style.display = "none"; });
}
// A board another page lists is drawn nowhere here: selected, Delete and the arrow keys would reach it unseen.
const offPage = (id) => !isW(id) && !boards.has(id) && pageList.some((p) => p.id !== activePage && p.boards.includes(id));
const toggled = (id) => { const cur = host.selection(); return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]; };
/** Select several layers (one or none fall back to select / deselect). The inspector shows "N selected". */
function setSelection(ids) {
  // Layers, boards and widget cards together: a drag or the arrow keys move them all (beginGroupMove, groupNudge).
  ids = [...new Set((ids || []).filter((x) => typeof x === "string" && x && !offPage(x)))];
  if (ids.length <= 1) { multi = null; if (ids.length) select(ids[0]); else deselect(); return; }
  multi = ids;
  selGen++;
  shownSel = null;
  sel = { id: ids[ids.length - 1] };
  selMove = null;
  multiHold = null;
  loadGroupInfo(ids);
  syncSel();
  host.emit("select", sel.id);
  showMulti(ids);
}
// Cards deleted since (an Undo, an agent, another window) leave a multi-selection too.
host.on("widgets", () => {
  if (!multi || !host.widgetPageOf) return;
  const keep = multi.filter((id) => !isW(id) || host.widgetPageOf(id.slice(7)) !== null);
  if (keep.length !== multi.length) setSelection(keep);
});
/** The inspector for several layers: the count and the properties they share (editable in the app). */
async function showMulti(ids) {
  const body = document.getElementById("propsBody");
  body.textContent = "";
  body.append(el("h2", "", ids.length + " selected"));
  let nodes = [];
  const gone = new Set();
  const layers = ids.filter((id) => !isW(id));
  try { nodes = await Promise.all(layers.map((id) => fetch(api("/api/node") + "&id=" + encodeURIComponent(id) + "&depth=0").then((r) => { if (r.status === 404) gone.add(id); return r.json(); }))); } catch {}
  if (!multi || multi.join(",") !== ids.join(",")) return;
  // Layers deleted since (an Undo, an agent): they leave the selection, and the shell hears the new one.
  if (gone.size) { setSelection(ids.filter((id) => !gone.has(id))); return; }
  const shared = host.sharedProps ? host.sharedProps(nodes.map((n) => n && n.node).filter(Boolean)) : {};
  for (const [k, v] of Object.entries(shared)) if (k !== "id" && k !== "children" && (typeof v !== "object" || v === null)) { const r = kv(k, v); if (r) body.append(r); }
  const rs = multiWorld.filter(Boolean);
  // free: how many of these align, distribute and tidy up work with (not placed by auto layout, not inside an instance).
  const stuck = new Set(layers.filter((id, i) => id.includes("/") || (nodes[i] && nodes[i].placed)));
  if (native) post({ selection: { id: sel.id, ids, count: ids.length, free: ids.length - stuck.size, node: Object.assign({}, shared, { name: ids.length + " selected" }), parentId: null, path: ids.some((x) => x.includes("/")), w: selWorld ? selWorld.w : null, h: selWorld ? selWorld.h : null, cmp: false, ctx: null } });
}
function clearHover() { hovId = null; hovWorld = null; hovBox.style.display = "none"; }
let hovFrame = 0;
function queueHover() {
  if (hovFrame || gesturing) return; // no hit testing while the camera moves; settle() resumes it
  hovFrame = requestAnimationFrame(() => {
    hovFrame = 0;
    // An auto layout reorder drag (/page/autolayout.js) draws the layer at the pointer: no hover box chasing it a frame behind.
    if (gesturing || drag || mv || space || !ptr || (host.autolayout && host.autolayout.dragging)) { clearHover(); return; }
    const id = titleAt(ptr.x, ptr.y) || pickSelectable(ptr.x, ptr.y, false);
    if (!id || isW(id) || (sel && id === sel.id)) { clearHover(); return; } // a card shows no hover box
    hovId = id;
    hovBox.classList.toggle("cmp", host.isCmp(id));
    hovWorld = worldRectOf(id);
    putBox(hovBox, hovWorld);
  });
}
view.addEventListener("pointermove", (e) => { ptr = { x: e.clientX, y: e.clientY }; if (!drag) queueHover(); });
view.addEventListener("pointerleave", () => { ptr = null; clearHover(); });
// Working on the page shown makes it the one this viewer comes back to (see rememberPage).
for (const n of ["pointerdown", "wheel"]) view.addEventListener(n, () => rememberPage(), { capture: true, passive: true });
addEventListener("keydown", () => rememberPage(), true);
function setDoc(d) {
  doc = d;
  document.getElementById("rev").textContent = d.revision || "";
  // Pages: only the active page's boards get records (titles, hit tests, the engine, overview fit).
  const rp = resolvePages(pagesStored, d.boards.map((b) => b.id));
  pageList = rp.pages; pageImplicit = rp.implicit;
  const pk = pickPage(pageList.map((p) => p.id), activePage, wantPage);
  wantPage = pk.want;
  const pg = pageList.find((p) => p.id === pk.page);
  if (pk.page !== activePage) {
    // The wanted page is here (open it, with its own camera), or the shown one is gone (a stand-in shows).
    // cam = null: the restore below loads this page's camera through the same check (does it show any board?).
    if (cam) { endTween(true); cam = null; restoredCam = false; zeroFit = false; if (sel) deselect(); }
    activePage = pg.id;
  }
  pageBoards = new Set(pg.boards);
  const seen = new Set();
  let idx = 0, reordered = false;
  for (let meta of d.boards) {
    idx++;
    if (!pageBoards.has(meta.id)) continue;
    seen.add(meta.id);
    // A board being dragged or just dropped stays where the person put it until the file says so too.
    const hold = posHold.get(meta.id);
    if (hold) { if ((meta.x === hold.x && meta.y === hold.y) || performance.now() > hold.until) posHold.delete(meta.id); else meta = Object.assign({}, meta, { x: hold.x, y: hold.y }); }
    let b = boards.get(meta.id);
    if (!b) {
      const lel = document.createElement("div");
      labelsEl.appendChild(lel);
      b = { meta, el: null, lbl: { el: lel, shown: false, mw: -1, tw: 0 }, loadedKey: null, loading: null, failedKey: null, fails: 0, retryAt: 0, cv: 0, w: 0, h: 0, measured: false, idx };
      labelBoard.set(lel, b);
      boards.set(meta.id, b);
      if (mode === "dom") boardEl(b);
    }
    if (b.idx !== idx) { b.idx = idx; reordered = true; }
    if (b.meta.x !== meta.x || b.meta.y !== meta.y) labelsVer++;
    b.meta = meta;
    if (!b.measured) setBoardSize(b, meta.width || 400, meta.height || 400);
    if (b.lbl.el.textContent !== (meta.name || "")) { b.lbl.el.textContent = meta.name || ""; b.lbl.tw = 0; labelsVer++; }
    const cmp = host.isCmp(meta.id);
    if (b.lbl.cmp !== cmp) { b.lbl.cmp = cmp; b.lbl.el.classList.toggle("cmp", cmp); b.lbl.tw = 0; labelsVer++; }
    if (b.el) { b.el.style.left = meta.x + "px"; b.el.style.top = meta.y + "px"; }
    syncPh(b);
    if (mode === "engine" && ev) ev.moveBoard(meta.id, meta.x, meta.y); // shows a move this frame; the content reload follows
  }
  // Boards of another page are parked in the engine (hidden, kept laid out: going back draws at once); boards gone
  // from the document are removed.
  const inDoc = new Set(d.boards.map((m) => m.id));
  if (mode === "engine" && ev) ev.pruneParked(inDoc);
  for (const [id, b] of boards) if (!seen.has(id)) { if (b.ph) { b.ph.remove(); b.ph = null; } if (b.snap && b.snap.url) URL.revokeObjectURL(b.snap.url); if (b.el) b.el.remove(); if (ev) { if (inDoc.has(id)) ev.park(id); else ev.removeBoard(id); } b.lbl.el.remove(); if (selBoard === b) selBoard = null; boards.delete(id); labelsVer++; }
  if (reordered) {
    // Arrange (Cmd+[ ]) changed the document order: the drawing and the hit tests follow it.
    labelsVer++;
    for (const b of [...boards.values()].sort((a, c) => a.idx - c.idx)) if (b.el) world.appendChild(b.el);
    if (mode === "engine" && ev) ev.reorder();
  }
  if (!cam) {
    // A saved camera that shows none of the page's boards (they moved, or it predates pages) counts as none.
    // Settings > General > "Open files at": the view they had (default), or fitted to the page.
    cam = prefs.openView === "fit" ? null : loadCam(activePage);
    if (cam && !camShowsBoards(cam)) cam = null;
    restoredCam = !!cam;
    if (cam) { zeroFit = false; applyCam(); }
    else { cam = { x: 0, y: 0, z: 1 }; fitAll({ instant: true }); zeroFit = !view.clientWidth || !view.clientHeight; const fb = boards.get(firstBoardId()); if (fb && !fb.measured) firstFit = fb; }
  } else requestFlush();
  if (mode === "engine") loadVisible(); // changed boards reload now, not a frame later
  showSnaps();
  pruneSnaps();
  syncSel(); // boards may have moved
  renderLeft(d);
  if (native) post({ file, doc: docMsg(), pages: pagesMsg() });
  schedulePrefetch();
}
// While idle, ask the server for the first boards of the other pages (their scenes are cached per revision, see
// scene.ts) and warm the browser's cache with their images and fonts, so a page's first visit draws at once.
const PREFETCH_PER_PAGE = 3;
const prefetched = new Set();
let prefetchT = 0;
function schedulePrefetch() {
  clearTimeout(prefetchT);
  if (mode !== "engine" || !doc || pageList.length < 2) return;
  prefetchT = setTimeout(prefetchPages, 1500);
}
async function prefetchPages() {
  prefetchT = 0;
  const rev = doc && doc.revision;
  for (const p of pageList) {
    if (p.id === activePage) continue;
    for (const id of p.boards.slice(0, PREFETCH_PER_PAGE)) {
      if (!doc || doc.revision !== rev || mode !== "engine") return; // the document moved on: a later schedule redoes it
      const k = rev + ":" + id;
      if (prefetched.has(k)) continue;
      // Never during a gesture or while the visible boards still load.
      while (gesturing || drag || engineBusy || [...boards.values()].some((b) => b.loading)) { await new Promise((r) => setTimeout(r, 400)); if (!doc || doc.revision !== rev) return; }
      prefetched.add(k);
      try {
        const meta = doc.boards.find((m) => m.id === id);
        const sc = await fetch(api("/api/scene") + "&id=" + encodeURIComponent(id) + keyedQ(meta && meta.key)).then((r) => r.json());
        const urls = [...(sc.images || []), ...(sc.fonts || []).map((f) => f && f.url).filter(Boolean)];
        for (const u of urls) await fetch(u).then((r) => r.arrayBuffer()).catch(() => {});
      } catch {}
    }
  }
}
const pageSel = new Map(); // page id -> the selection it had when the person left it
/** Show another page: its boards replace this page's, with the camera this viewer last had there. */
// remember: the person picked it (rail, shell); an agent's switch (the bridge) shows it without remembering it.
function switchPage(id, remember) {
  if (!doc || !pageList.some((p) => p.id === id)) return Promise.resolve(false);
  wantPage = null;
  if (id === activePage) { if (remember) rememberPage(); return Promise.resolve(true); }
  endTween(true);
  saveCam();
  perfMark("page");
  // Each page keeps its own selection: it comes back when the person returns to the page.
  if (activePage) pageSel.set(activePage, multi ? multi.slice() : sel ? [sel.id] : []);
  if (sel) deselect();
  activePage = id;
  if (remember) rememberPage();
  cam = null;
  setDoc(doc);
  host.emit("page", id);
  const back = pageSel.get(id);
  if (back && back.length) setTimeout(() => { if (activePage === id && !sel) setSelection(back.filter((x) => isW(x) ? host.widgetPageOf && host.widgetPageOf(x.slice(7)) === id : true)); }, 0);
  return Promise.resolve(true);
}
// The DOM renderer's element for a board: a placeholder until loadBoard swaps its drawing in.
function boardEl(b) {
  const el = document.createElement("div");
  el.className = "board";
  const ph = document.createElement("div");
  ph.className = "ph";
  ph.style.width = (b.meta.width || 400) + "px";
  ph.style.height = (b.meta.height || 400) + "px";
  el.append(ph);
  el.style.left = b.meta.x + "px";
  el.style.top = b.meta.y + "px";
  world.appendChild(el);
  b.el = el;
  b.cv = 0;
  elBoard.set(el, b);
}
function announceRenderer() {
  console.info("[canvas] renderer: " + mode + (rendererNote ? " (" + rendererNote + ")" : ""));
  host.emit("renderer", mode);
}
// Switch to the DOM renderer (never back): build every board's element and let loadVisible draw them.
function useDom(note) {
  if (mode === "dom") return;
  const old = ev;
  ev = null;
  mode = "dom";
  rendererNote = note;
  if (old) { try { old.destroy(); } catch {} }
  for (const b of boards.values()) { b.loadedKey = null; b.loading = null; b.failedKey = null; b.measured = false; syncPh(b); if (!b.el) boardEl(b); setBoardSize(b, b.meta.width || 400, b.meta.height || 400); }
  labelsVer++;
  announceRenderer();
  requestFlush();
  scheduleVisible();
  syncSel();
}
function engineFailed(note) { console.warn("[canvas] " + note + "; using the DOM renderer"); useDom(note); }
// The engine went away (its GPU device was lost: a driver reset, a GPU switch; or it threw): a new one starts after a
// short wait and loads the boards again. The DOM renderer only when that keeps happening (engineRestartDelay).
let engineMod = null; // /page/engine-view.js, once imported
const engineLosses = []; // performance.now() of each loss
function engineLost(note) {
  if (mode !== "engine" || !engineMod) { engineFailed(note); return; }
  const now = performance.now(), wait = engineMod.engineRestartDelay(engineLosses, now);
  engineLosses.push(now);
  if (wait < 0) { engineFailed(note + " (" + engineLosses.length + " times)"); return; }
  console.warn("[canvas] " + note + "; starting a new engine");
  const old = ev;
  ev = null;
  mode = "pending";
  rendererNote = note;
  if (old) { try { old.destroy(); } catch {} }
  for (const b of boards.values()) { b.loadedKey = null; b.loading = null; b.failedKey = null; }
  host.emit("renderer", mode); // shader and video cards let go of the old engine
  setTimeout(() => { if (mode === "pending") startEngine(); }, wait);
}
async function startEngine() {
  try {
    engineMod = await import("/page/engine-view.js");
    const v = await engineMod.createEngineView({
      view, api, sceneEnv: SCENE_ENV, onChange: () => requestFlush(false), onLost: (why) => engineLost(why), getCam: () => cam, isIdle: () => !gesturing && !drag,
      posOf: (id) => { const b = boards.get(id); return b ? { x: b.meta.x, y: b.meta.y } : null; },
      orderOf: (id) => { const b = boards.get(id); return b ? b.idx : 1e9; },
      onLayout: () => { syncSel(); host.emit("render", null); },
      rebase: (id, scene, t) => (host.live ? host.live.rebase(id, scene, t) : false),
    });
    if (mode !== "pending") { v.destroy(); return; }
    ev = v;
    mode = "engine";
    perfAt("engine");
    readViewBox();
    announceRenderer();
    if (cam) ev.setCam(cam);
  } catch (err) {
    engineFailed("engine did not start: " + (err && err.message || err));
    return;
  }
  requestFlush();
  loadVisible();
  syncSel();
}
window.__canvas = {
  get renderer() { return mode; }, get note() { return rendererNote; }, get engine() { return ev && ev.engine; },
  stats: () => (ev ? ev.stats() : null),
  // True when every board near the view is drawn and the engine needs no more frames (bench + tests).
  settled() {
    if (mode !== "engine" || !ev || !cam) return false;
    return window.__canvas.inViewLoaded(PREFETCH) && !engineBusy && !camRaf;
  },
  // Every board in the view (and m views around it) is laid out at its current content.
  inViewLoaded(m = 0) {
    if (mode !== "engine" || !ev || !cam) return false;
    const L = -VW * m, T = -VH * m, R = VW * (1 + m), B = VH * (1 + m);
    for (const b of boards.values()) {
      const r = loadBox(b.meta, b.w, b.h, b.measured), sx = r.x * cam.z + cam.x, sy = r.y * cam.z + cam.y;
      if (sx < R && sx + r.w * cam.z > L && sy < B && sy + r.h * cam.z > T && b.loadedKey !== b.meta.key && b.failedKey !== b.meta.key) return false;
    }
    return true;
  },
  loseDevice: () => ev && ev.loseDevice(),
  // Tests: the visible title rects and the fly-to target for a rect.
  labelRects: () => [...boards.values()].filter((b) => b.lbl.shown).map((b) => ({ id: b.meta.id, x: b.lbl.r.x, y: b.lbl.r.y, w: b.lbl.r.w, h: LABEL_H })),
  get flying() { return !!tween; },
  // Bench: snap query times (ms) since the last call, and the settings in force.
  snapStats() { const t = snapTimes.splice(0).sort((a, b) => a - b); return { n: t.length, p50: t[Math.floor(t.length * 0.5)] || 0, p95: t[Math.floor(t.length * 0.95)] || 0, max: t[t.length - 1] || 0, cfg: snapCfg, ready: !!snapLib }; },
  boardPos: (id) => { const b = boards.get(id); return b ? { x: b.meta.x, y: b.meta.y, w: b.w, h: b.h } : null; },
};
// ---------- timings ----------
// How long until the canvas is fully drawn (settled: every board near the view is in and the engine idle) after
// the page loaded (load, from navigation start), was shown again (show: a hidden tab or window comes back) and
// after a page switch (page). look: until every board in view shows its content or its snapshot. Reported to the
// bridge (canvas_status) and read by bench/cache.ts.
// doc, engine, landed: when the document arrived, the engine was up and the first board was laid out (from navigation start).
// picture: the first complete picture after the load: every board in view laid out, its images in, and every tile in
// view drawn at the exact scale (the engine's tilesMissing is 0), with the camera at rest. load waits for the engine
// to go idle too, which includes work no one sees yet (base textures, tiles ahead of the view): bench/speed.ts reads
// picture.
const perf = host.perf = { load: null, look: null, show: null, page: null, shows: 0, pages: 0, snapshots: 0, doc: null, engine: null, landed: null, idle: null, imgs: null, picture: null };
const perfAt = (k) => { if (perf[k] === null) perf[k] = Math.round(performance.now()); };
let perfWait = [], perfT = 0;
function perfMark(kind, t0) {
  perfWait = perfWait.filter((w) => w.kind !== kind);
  perfWait.push({ kind, t0: t0 === undefined ? performance.now() : t0 });
  if (!perfT) perfT = setInterval(perfPoll, 16);
}
function perfPoll() {
  const now = performance.now();
  // The DOM renderer never settles, and a wait over a minute is no timing: stop asking.
  perfWait = mode === "dom" ? [] : perfWait.filter((w) => now - w.t0 < 60_000);
  if (!perfWait.length) { clearInterval(perfT); perfT = 0; return; }
  if (document.hidden) return;
  if (perf.look === null && host.looksDone && host.looksDone()) perf.look = Math.round(now);
  // The camera at rest (no move waiting for its frame, no fly-to): the last frame drew this view. Not "no frame
  // requested": the engine asks for frames while it renders work no one sees yet (base textures), and that held
  // picture back until load.
  if (perf.picture === null && perf.landed !== null && !camDirty && !tween && !gesturing && window.__canvas.inViewLoaded() && ev && ev.imagesPending() === 0) {
    const s = ev.pictureState();
    if (s.missing === 0 && s.blank === 0 && s.exact) perf.picture = Math.round(now);
  }
  if (perf.landed !== null) { if (!engineBusy && !camRaf) perfAt("idle"); if (ev && ev.imagesPending() === 0) perfAt("imgs"); }
  if (!window.__canvas.settled() || (ev && ev.imagesPending() > 0)) return;
  for (const w of perfWait) { perf[w.kind] = Math.round(now - w.t0); if (w.kind === "show") perf.shows++; if (w.kind === "page") perf.pages++; }
  if (perf.look === null) perf.look = perf.load;
  perfWait = [];
  host.emit("perf", perf);
}
perfMark("load", 0);
// ---------- board snapshots ----------
// What the engine last drew of each board, kept by content key (/page/snapshots.js): a board not laid out yet shows
// its picture at once, and the engine's drawing takes its place. Captured when the canvas is at rest and fully drawn.
const SNAP_HOLD_MS = 8000;
let snapHold = true;
// The person is working on the canvas: what they see must be the live drawing.
const endSnapHold = () => { if (!snapHold) return; snapHold = false; for (const b of boards.values()) if (b.ph && b.loadedKey) syncPh(b); };
for (const n of ["pointerdown", "wheel", "keydown"]) addEventListener(n, endSnapHold, { capture: true, passive: true });
let picLib = null, snaps = null, snapT = 0, pruneT = 0;
const bgNow = () => getComputedStyle(view).backgroundColor;
if (file && mode !== "dom") import("/page/snapshots.js").then((m) => { picLib = m; snaps = m.createSnapshots(file, { budget: Math.max(16, Number(prefs.snapshotMB) || 200) * 1048576 }); return snaps.ready(); }).then(() => showSnaps()).catch((err) => console.warn("[canvas] snapshots", err));
// Settings > Performance: how much the snapshots take, and Clear (every file's; the store is shared by all pages).
function snapshotsCmd(op) {
  import("/page/snapshots.js").then(async (m) => {
    if (op === "clear") { await m.clearAll(); if (snaps) snaps.forget(); }
    if (native) post({ snapshotBytes: await m.totalBytes() });
  }).catch(() => {});
}
/** Boards near the view that the engine has not laid out yet: their snapshots, if any. */
function showSnaps() {
  if (!snaps || !cam || mode === "dom") return;
  const L = -VW * PREFETCH, T = -VH * PREFETCH, R = VW * (1 + PREFETCH), B = VH * (1 + PREFETCH);
  for (const b of boards.values()) {
    if (!snapUseful(b)) continue;
    const sx = b.meta.x * cam.z + cam.x, sy = b.meta.y * cam.z + cam.y;
    if (sx < R && sx + (b.w || 400) * cam.z > L && sy < B && sy + (b.h || 400) * cam.z > T) wantSnap(b);
  }
}
/** A board not laid out yet, or laid out at its key with images still decoding (before the person did anything). */
const snapUseful = (b) => !b.gone && !b.snap && (!b.loadedKey || (snapHold && b.loadedKey === b.meta.key && !!ev && ev.imagesPending() > 0));
function wantSnap(b) {
  if (!snaps || !snapUseful(b) || mode === "dom") return;
  const key = b.meta.key, bg = bgNow();
  if (!snaps.meta(b.meta.id, key, bg)) return;
  const tok = (b.snap = { key, el: null, url: null, until: performance.now() + SNAP_HOLD_MS });
  snaps.get(b.meta.id, key, bg).then((s) => {
    if (!s) { if (b.snap === tok) b.snap = null; return; }
    const img = new Image();
    img.alt = "";
    img.src = s.url;
    return img.decode().then(() => {
      const late = b.loadedKey && (b.loadedKey !== key || !snapHold || !(ev && ev.imagesPending() > 0)); // drawn whole meanwhile
      if (b.snap !== tok || late || boards.get(b.meta.id) !== b || b.meta.key !== key) { URL.revokeObjectURL(s.url); if (b.snap === tok) b.snap = null; return; }
      tok.el = img; tok.url = s.url;
      if (!b.measured && s.ww > 0 && s.wh > 0) setBoardSize(b, s.ww, s.wh); // a Hug board's size before its layout
      perf.snapshots++;
      syncPh(b);
      setTimeout(() => syncPh(b), Math.max(0, tok.until - performance.now()) + 20);
    });
  }).catch(() => { if (b.snap === tok) b.snap = null; });
}
function scheduleSnap() { if (snaps && !snapT) snapT = setTimeout(takeSnaps, 700); }
function takeSnaps() {
  snapT = 0;
  if (!snaps || !picLib || mode !== "engine" || !ev || !cam || document.hidden || gesturing || tween || drag || mv || engineBusy || camRaf) return;
  if (!window.__canvas.settled() || ev.imagesPending() > 0 || (host.textEdit && host.textEdit.active)) return;
  const bg = bgNow(), dpr = window.devicePixelRatio || 1;
  const cards = host.widgetsShown ? host.widgetsShown().map((w) => host.widgetRect(w.id)).filter(Boolean) : [];
  const list = [];
  for (const b of boards.values()) if (!b.gone && b.measured) list.push({ id: b.meta.id, key: b.meta.key, loadedKey: b.loadedKey, rect: { x: b.meta.x, y: b.meta.y, w: b.w, h: b.h } });
  const todo = picLib.toCapture(list, { cam, vw: VW, vh: VH, dpr, cards, touched: (id) => !!(host.live && host.live.touched && host.live.touched(id)), have: (x) => snaps.meta(x.id, x.key, bg) }).slice(0, 4);
  if (!todo.length) return;
  let pics;
  try { pics = ev.capture(todo.map((t) => t.crop)); } catch (err) { console.warn("[canvas] snapshot", err); return; }
  todo.forEach((t, i) => pics[i].toBlob((blob) => { if (blob) snaps.put(t.id, t.key, bg, blob, { w: t.crop.w, h: t.crop.h, ww: t.rect.w, wh: t.rect.h }).then(() => scheduleSnap()); }, "image/jpeg", 0.85));
}
/** Snapshots of keys this document's boards no longer have go, a while after the document changed. */
function pruneSnaps() {
  if (!snaps || !doc) return;
  clearTimeout(pruneT);
  pruneT = setTimeout(() => { if (doc) snaps.evict(new Map(doc.boards.map((m) => [m.id, m.key]))); }, 5000);
}
/** Every board in view shows its content or its snapshot (the "look" timing). */
host.looksDone = () => {
  if (!cam || !boards.size) return false;
  let any = false;
  for (const b of boards.values()) {
    const sx = b.meta.x * cam.z + cam.x, sy = b.meta.y * cam.z + cam.y;
    if (!(sx < VW && sx + (b.w || 400) * cam.z > 0 && sy < VH && sy + (b.h || 400) * cam.z > 0)) continue;
    any = true;
    if (b.snap && b.snap.el) continue;
    if (b.loadedKey === b.meta.key && !engineBusy && !(ev && ev.imagesPending() > 0)) continue;
    return false;
  }
  return any;
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) perfMark("show"); });
// ---------- left rail ----------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function renderLeft(d) {
  const pagesEl = document.getElementById("pages");
  pagesEl.textContent = "";
  for (const p of pageList) {
    const r = el("div", "row" + (p.id === activePage ? " on" : ""), p.name);
    r.append(el("span", "dim", String(p.boards.length)));
    r.onclick = () => switchPage(p.id, true);
    pagesEl.append(r);
  }
  const boardsEl = document.getElementById("boards");
  boardsEl.textContent = "";
  for (const b of pageMetas()) {
    const r = el("div", "row" + (selBoard && selBoard.meta.id === b.id ? " on" : ""), b.name || b.id);
    r.append(el("span", "dim", (b.width || "?") + "×" + (b.height || "?")));
    r.onclick = () => flyToBoard(b.id);
    boardsEl.append(r);
  }
  const compsEl = document.getElementById("comps");
  compsEl.textContent = "";
  for (const c of d.components || []) {
    const r = el("div", "row", (c.isText ? "T " : "") + (c.name || c.type));
    r.prepend(el("span", "cmpi"));
    r.append(el("span", "dim", (c.instances ? c.instances + " ×, " : "") + c.type));
    r.onclick = () => select(c.id);
    compsEl.append(r);
  }
  const stylesEl = document.getElementById("styles");
  stylesEl.textContent = "";
  for (const s of (d.styles || []).slice(0, 14)) {
    const p = s.props;
    const r = el("div", "row");
    const chip = el("span", "chip");
    chip.style.background = String(p.fill || "#000").startsWith("$") ? "#888" : String(p.fill || "#000");
    r.append(chip, el("span", "", (p.fontFamily || "") + " " + (p.fontSize || "") + "/" + (p.fontWeight || "")), el("span", "dim", "×" + s.count));
    stylesEl.append(r);
  }
  const varsEl = document.getElementById("vars");
  varsEl.textContent = "";
  for (const [name, def] of Object.entries(d.variables || {})) {
    const r = el("div", "row", name);
    const value = def && typeof def === "object" ? def.value : def;
    if (def && def.type === "color") { const chip = el("span", "chip"); chip.style.background = String(value); r.prepend(chip); }
    else r.append(el("span", "dim", String(value)));
    varsEl.append(r);
  }
}
// ---------- selection + properties ----------
function kv(k, v) { if (v === undefined || v === null || v === "") return null; const r = el("div", "kv"); r.append(el("span", "k", k), el("span", "v", String(v))); return r; }
function section(title, rows) {
  const have = rows.filter(Boolean);
  if (!have.length) return null;
  const w = el("div");
  w.append(el("h4", "", title));
  for (const r of have) w.append(r);
  return w;
}
// What the app's inspector shows for the selected node: the file's answer (/api/node) with the edits the file does
// not have yet on top (undo/redo drawn ahead, a resize or move in progress, inspector writes in flight), so it
// never shows numbers older than the canvas (src/page/live.js keeps those edits).
let shownSel = null, selPostFrame = 0;
// The size last sent with the selection, for the axes the drawing decides (Hug, Fill): when a relayout changes
// them after the post (a Size Change, an override reset), the inspector hears it again (syncSel).
let postedSize = null;
function postSel() {
  if (!native || !shownSel || !sel || sel.id !== shownSel.id || multi) return;
  const { id, n, at } = shownSel;
  // An instance shows what it draws: its component's props with its own on top (/api/node resolved), overrides marked.
  const node = overlayNode(n.resolved ? Object.assign({}, n.resolved, n.node) : n.node, host.live && host.live.overlay ? host.live.overlay(id, at) : []);
  const wr = selWorld || worldRectOf(id);
  const fixedW = typeof node.width === "number", fixedH = typeof node.height === "number";
  // The drawn box is axis-aligned: a turned layer whose size the layout decides (a group, Hug) shows its own size.
  // The turned box the selection draws (live.js shape: the badge's numbers) when the page has it; else solved from the
  // drawn box, which for a group is its layers' ink, not its box.
  const sh = (!fixedW || !fixedH) && host.live && host.live.shape ? host.live.shape(id) : null;
  const own = sh ? { w: sh.w, h: sh.h } : wr && (!fixedW || !fixedH) && typeof node.rotation === "number" && node.rotation % 180 && node.type !== "group" && ownSize ? ownSize(wr.w, wr.h, node.rotation, fixedW ? node.width : undefined, fixedH ? node.height : undefined) : null;
  const w = fixedW ? node.width : own ? own.w : wr ? wr.w : null, h = fixedH ? node.height : own ? own.h : wr ? wr.h : null;
  // What syncSel compares with the drawing to know the post is out of date: the drawn box, as drawn.
  postedSize = { id, w: fixedW ? null : wr ? wr.w : null, h: fixedH ? null : wr ? wr.h : null };
  // A layer inside an instance takes overrides (src/overrides.ts): it is no read-only path, only placed by its component.
  const inst = !!(n.path && n.instance);
  // rtype: the type an instance draws as (its component's), so the inspector shows the auto layout and Hug it inherits.
  post({ selection: { id, node, parentId: n.parentId, path: n.path && !inst, inst, overrides: n.overrides || [], w, h, rtype: n.resolved && n.resolved.type || null, cmp: host.isCmp(id), ctx: n.context || null, tokens: n.tokens || null } });
}
/** The page changed the selected node ahead of the file: show it in the inspector in the next frame. */
host.selectionEdited = (id) => {
  if (!shownSel || shownSel.id !== id || selPostFrame) return;
  selPostFrame = requestAnimationFrame(() => { selPostFrame = 0; postSel(); });
};
// Every selection change gets a number (selGen): work started for one selection (a structure op's answer, a nudge
// burst) checks it is still the same one. A refresh after a document change is not a new selection, so it does
// not bump it (it did, and Cmd+D / Cmd+G then lost their result to the doc event that came first); its answers are
// numbered on their own (selAsk), so one that comes back after a newer one started never reaches the inspector.
let selGen = 0, selAsk = 0;
async function select(id, refresh) {
  if (offPage(id)) { deselect(); return; }
  if (!refresh) multi = null;
  else if (multi) { showMulti(multi); return; }
  if (!refresh) selGen++;
  const gen = selGen, ask = ++selAsk;
  sel = { id };
  syncSel();
  loadMoveInfo(id, refresh);
  if (isW(id)) { post({ selection: null, widget: { id: id.slice(7) } }); host.emit("select", id); return; }
  if (!refresh) host.emit("select", id);
  const body = document.getElementById("propsBody");
  body.textContent = "…";
  let n;
  const at = performance.now();
  let gone = false;
  try { const r = await fetch(api("/api/node") + "&id=" + encodeURIComponent(id)); gone = r.status === 404; n = await r.json(); } catch { if (gen === selGen && ask === selAsk) body.textContent = "Could not read the node."; return; }
  if (gen !== selGen || ask !== selAsk) return;
  // The selected layer went away (an Undo, an agent's delete): nothing is selected, and the shell hears it.
  if (refresh && gone) { deselect(); return; }
  if (!n || n.error) { body.textContent = ""; body.append(el("div", "", "No node " + id + ". It changed or lives outside this board. Click it again.")); return; }
  const node = n.node;
  shownSel = { id, n, at };
  postSel();
  body.textContent = "";
  body.append(el("h2", "", node.name || node.type || id));
  body.append(el("div", "tid", node.type + ", " + id + (n.path ? ", instance path" : "")));
  const fill = Array.isArray(node.fill) ? node.fill[0] : node.fill;
  const fillV = fill && typeof fill === "object" ? (fill.color ?? fill.type) : fill;
  const stroke = Array.isArray(node.stroke) ? node.stroke[0] : node.stroke;
  const strokeV = stroke && typeof stroke === "object" ? (stroke.color ?? stroke.type) : stroke;
  // A flipped layer's stored x (y) is its right (bottom) edge (a document's flip mirrors about the corner): show the box's left (top).
  const boxX = node.flipX === true && typeof node.x === "number" && typeof node.width === "number" ? node.x - node.width : node.x;
  const boxY = node.flipY === true && typeof node.y === "number" && typeof node.height === "number" ? node.y - node.height : node.y;
  body.append(...[
    section("Position & size", [kv("x", boxX), kv("y", boxY), kv("width", node.width), kv("height", node.height)]),
    section("Appearance", [node.fill ? (() => { const r = kv("fill", fillV); if (r) { const c = el("span", "chip"); c.style.background = String(fillV).startsWith("$") ? "#888" : String(fillV); r.children[1].prepend(c); } return r; })() : null, kv("fill extras", Array.isArray(node.fill) && node.fill.length > 1 ? "+" + (node.fill.length - 1) : undefined), kv("stroke", strokeV), kv("strokeWidth", node.strokeWidth), kv("cornerRadius", node.cornerRadius), kv("opacity", node.opacity)]),
    section("Text", [kv("content", node.content), kv("font", node.fontFamily), kv("size", node.fontSize), kv("weight", node.fontWeight), kv("lineHeight", node.lineHeight), kv("letterSpacing", node.letterSpacing), kv("textGrowth", node.textGrowth)]),
    section("Layout", [kv("layout", node.layout), kv("gap", node.gap), kv("padding", Array.isArray(node.padding) ? node.padding.join(" ") : node.padding), kv("justify", node.justifyContent), kv("align", node.alignItems)]),
    section("Component", [kv("instance of", node.ref), kv("overrides", node.descendants ? Object.keys(node.descendants).length : undefined), kv("children", Array.isArray(node.children) ? node.children.length : undefined), kv("parent", n.parentId)]),
  ].filter(Boolean)); // an empty section is null, which append would write out as "null"
  const pre = el("pre");
  pre.textContent = JSON.stringify(node, null, 1);
  const det = el("details");
  det.append(el("summary", "", "raw json"), pre);
  body.append(det);
}
function deselect() { selGen++; shownSel = null; if (native) post({ selection: null }); sel = null; multi = null; syncSel(); document.getElementById("propsBody").textContent = "Click any node to inspect it."; host.emit("deselect"); }
// Selecting happens on pointerup, not click: the drag below captures the pointer, which makes the
// browser aim the click at the view itself. The element under the cursor is what was pressed.
let down = null;
const secondary = (e) => e.button === 2 || (e.button === 0 && e.ctrlKey); // a right-click: the native menu opens, no pan or pick follows
// A double-click goes one level in from the selection before its first press (dblClickTarget), never two. The
// browser's click count (mousedown detail) says which press is the second one.
let dblPre = null;
view.addEventListener("pointerdown", (e) => { if (secondary(e)) return; down = { x: e.clientX, y: e.clientY, moved: false, hand: space, now: host.selection().filter((x) => !isW(x)) }; });
view.addEventListener("mousedown", (e) => { if (!down) return; if (e.detail === 1) dblPre = down.now; down.dbl = e.detail === 2 ? dblPre : null; }, true);
view.addEventListener("pointerup", (e) => {
  // A press that travelled past the threshold at any point was a pan, even if it ended where it began;
  // a press made in hand mode (Space held) never picks anything.
  // A press that already picked (it selected the layer under it, to drag it in the same gesture) is done.
  const skip = !down || down.moved || down.hand || down.title || down.picked || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
  const meta = metaOf(e);
  const dbl = down && down.dbl && !meta && !e.shiftKey && dblRule ? down.dbl : null;
  // The selection as a double-click's second press went down: the text editor edits only a text layer that was in
  // it (src/page/geometry.js dblClickEdits); one the double-click drills down to is only selected.
  if (down && down.dbl) host.dblSel = down.now.slice();
  down = null;
  if (skip) return;
  // A click selects the board's direct child, one level in from the selection; Cmd picks the deepest layer.
  const leaf = dbl && pick(e.clientX, e.clientY);
  const id = leaf && !isW(leaf) ? dblRule(chainOf(leaf), dbl.map(chainOf)) : pickSelectable(e.clientX, e.clientY, meta);
  // Shift-click adds or removes a layer (src/page/structure.js keeps the rest of the selection rules).
  if (id && e.shiftKey) setSelection(toggled(id));
  else if (id) select(id);
  else if (!e.shiftKey) deselect();
});
// ---------- move: drag, snap, nudge, rename ----------
// A board moves by its title, or by its body once selected; an absolutely placed layer by its body once
// selected. While dragging, the engine moves the board every frame (engine.moveBoard, no layout) and the
// overlays follow by math; x/y are written once, on drop (/api/move, src/move.ts): one undo step. Snapping
// (src/page/snap.js) aligns edges and centres with nearby boards, layers and widgets inside a screen-px
// threshold, rounds to whole px and draws guides in screen space. Control or Cmd held skips object snapping.
let snapLib = null, snapCfg = { objects: true, pixel: true, guides: true, bigNudge: 10 };
let mv = null, mvDirty = false, selMove = null, selHold = null, renaming = null;
// Space held during a layer drag (the layer keeps its parent). spaceKept: this Space press went to a drag, so
// it never turns into the hand, even after the drop, until it is let go.
let keepParent = false, spaceKept = false;
/** A layer, board or several are being dragged (the page's move or an auto layout reorder). */
const layerDragging = () => !!(mv || (host.autolayout && host.autolayout.dragging));
function setKeepParent(on) {
  if (on) spaceKept = true;
  if (keepParent === on) return;
  keepParent = on;
  if (mv) {
    mv.keep = on;
    if (on && host.autolayout) host.autolayout.clearInto();
    else if (!on && mv.moved && mv.px !== undefined && (mv.kind === "node" || mv.kind === "board") && host.autolayout) host.autolayout.overInto(mv.id, mv.px, mv.py, mv.mods);
  }
  if (host.autolayout && host.autolayout.keepParent) host.autolayout.keepParent(on);
}
host.keepParent = () => keepParent;
// Arrow presses on a layer before the page knows how it moves (nudge): played when the answer comes.
let earlyNudge = null;
const posHold = new Map(); // board id -> {x, y, until}: where a moved board shows until the file agrees
const labelBoard = new WeakMap(); // title element -> board record
const nudges = new Map(); // id -> {dx, dy, busy, board}: arrow presses not yet written
const snapTimes = []; // ms per snap query, for the bench
const guideCv = document.getElementById("guides"), guideCtx = guideCv.getContext("2d");
let guidesShown = false, guideColor = "";
function sizeGuides() { const dpr = window.devicePixelRatio || 1; guideCv.width = Math.max(1, Math.round(VW * dpr)); guideCv.height = Math.max(1, Math.round(VH * dpr)); guideCv.style.width = VW + "px"; guideCv.style.height = VH + "px"; }
sizeGuides();
function paintGuides(gs) {
  if (!snapLib || !gs || !gs.length || !snapCfg.guides || !cam) { clearGuides(); return; }
  const dpr = window.devicePixelRatio || 1;
  if (guideCv.width !== Math.max(1, Math.round(VW * dpr))) sizeGuides();
  if (!guideColor) guideColor = getComputedStyle(document.documentElement).getPropertyValue("--c-guide").trim() || "#F24822";
  guideCtx.clearRect(0, 0, guideCv.width, guideCv.height);
  // Distance pills keep clear of the selection's size badge (both read, P3-6).
  let avoid = null;
  if (selBox.style.display === "block") { const d = selDim.getBoundingClientRect(), v = view.getBoundingClientRect(); if (d.width) avoid = [{ x: d.left - v.left, y: d.top - v.top, w: d.width, h: d.height }]; }
  snapLib.drawGuides(guideCtx, gs, cam, dpr, guideColor, undefined, avoid);
  if (!guidesShown) { guidesShown = true; guideCv.style.display = "block"; }
}
function clearGuides() { if (!guidesShown) return; guidesShown = false; guideCtx.clearRect(0, 0, guideCv.width, guideCv.height); guideCv.style.display = "none"; }
const tell = (t) => { if (native) post({ toast: t }); else say(t); };
let toldAt = 0;
const tellOnce = (t) => { if (performance.now() - toldAt > 2500) { toldAt = performance.now(); tell(t); } };
// Settings: in the app the shell owns them (toolbar popover, app settings) and sends {cmd: "snap"}; in a
// browser the Snap button's popover keeps them in localStorage.
const snapPop = document.getElementById("snapPop"), snapBtn = document.getElementById("snapBtn");
function syncSnapPop() {
  for (const i of snapPop.querySelectorAll("input")) {
    const k = i.dataset.k;
    if (i.type === "checkbox") i.checked = !!snapCfg[k]; else if (document.activeElement !== i) i.value = snapCfg[k];
  }
}
function setSnap(v, save) {
  const m = Object.assign({}, snapCfg, v || {});
  snapCfg = snapLib ? snapLib.snapSettings(m) : m;
  if (save) store.set("canvas:snap", snapCfg);
  syncSnapPop();
}
import("/page/snap.js").then((m) => { snapLib = m; setSnap(native ? {} : store.get("canvas:snap"), false); }).catch((err) => console.warn("[canvas] snap", err));
if (native) post({ snapHello: true });
snapBtn.onclick = (e) => {
  e.stopPropagation();
  if (snapPop.style.display === "block") { snapPop.style.display = "none"; return; }
  const r = snapBtn.getBoundingClientRect();
  snapPop.style.left = Math.max(8, r.right - 210) + "px";
  snapPop.style.top = r.bottom + 8 + "px";
  syncSnapPop();
  snapPop.style.display = "block";
};
snapPop.addEventListener("change", (e) => { const i = e.target; if (i && i.dataset && i.dataset.k) setSnap({ [i.dataset.k]: i.type === "checkbox" ? i.checked : Number(i.value) }, true); });
addEventListener("pointerdown", (e) => { if (snapPop.style.display === "block" && !snapPop.contains(e.target) && e.target !== snapBtn) snapPop.style.display = "none"; }, true);
host.snap = () => snapCfg;
// The board whose title is under a window point.
function titleAt(cx, cy) {
  const t = document.elementFromPoint(cx, cy), lb = t && t.closest && t.closest("#labels>div"), b = lb && labelBoard.get(lb);
  return b ? b.meta.id : null;
}
// How the selected layer moves (GET /api/move): absolute layers drag and nudge; auto-layout children do not.
function loadMoveInfo(id, refresh) {
  // A refresh keeps what it knows until the answer comes: arrow presses in between would otherwise be dropped.
  if (!refresh || !selMove || selMove.id !== id) selMove = null;
  if (earlyNudge && earlyNudge.id !== id) earlyNudge = null;
  if (isW(id) || boards.has(id) || id.includes("/")) { selMove = null; return; }
  fetch(api("/api/move") + "&id=" + encodeURIComponent(id)).then((r) => r.json()).then((j) => {
    if (sel && sel.id === id && j && j.mode) { selMove = Object.assign({ id }, j); if (mv && mv.pending && mv.id === id) resolvePending(); }
    const early = earlyNudge && earlyNudge.id === id ? earlyNudge : null;
    earlyNudge = null;
    if (early && selMove && selMove.id === id && sel && sel.id === id) nudge(early.dx, early.dy);
    nudgeSettled();
  }).catch(() => { earlyNudge = null; nudgeSettled(); });
}
function sendMove(body) {
  return fetch("/api/move", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }));
}
// What a moving thing may snap to: boards and widgets on this page for a board or a widget, the siblings and
// the parent for a layer. Only the ones near the view: you align to what you can see.
function candsFor(kind, id) {
  const out = [];
  if (kind === "node") {
    for (const s of (selMove && selMove.siblings) || []) { const r = worldRectOf(s); if (r) out.push({ id: s, x: r.x, y: r.y, w: r.w, h: r.h }); }
    const pr = selMove && selMove.parentId ? worldRectOf(selMove.parentId) : null;
    if (pr) out.push({ id: selMove.parentId, x: pr.x, y: pr.y, w: pr.w, h: pr.h });
    // The parent frame's layout guides (columns, rows, grid), while they show (src/page/navigate.js).
    if (selMove && host.layoutGuideRects) for (const g of host.layoutGuideRects(selMove.parentId)) out.push(g);
  } else {
    // A group moving: none of its own boards or cards is something to snap to.
    const skip = kind === "group" && mv && mv.exclude ? mv.exclude : null;
    for (const b of boards.values()) if (b.meta.id !== id && !(skip && skip.has(b.meta.id))) out.push({ id: b.meta.id, x: b.meta.x, y: b.meta.y, w: b.w, h: b.h });
    for (const w of host.widgetsShown ? host.widgetsShown() : []) if ("widget:" + w.id !== id && !(skip && skip.has("widget:" + w.id))) out.push({ id: "widget:" + w.id, x: w.x, y: w.y, w: w.w, h: w.h });
    // Layers moved together snap to the other layers beside them and to their parents too, like one layer does.
    if (kind === "group" && skip) {
      const seen = new Set();
      for (const lid of skip) {
        const gi = groupInfo.get(lid);
        if (!gi) continue;
        for (const s of [...(gi.siblings || []), gi.parentId]) {
          if (!s || seen.has(s) || skip.has(s) || boards.has(s)) continue;
          seen.add(s);
          const r = worldRectOf(s);
          if (r) out.push({ id: s, x: r.x, y: r.y, w: r.w, h: r.h });
        }
      }
    }
  }
  return snapLib.nearbyRects(out, cam, VW, VH, 0.5);
}
// One snap query: where the rect lands and the guides to draw. ev: the pointer event (Control bypasses).
function snapQuery(s, raw, e) {
  if (!snapLib || !cam) return { x: raw.x, y: raw.y, guides: [] };
  const t0 = performance.now();
  const objects = snapCfg.objects && !snapLib.bypassSnap(e);
  if (objects && !s.index) s.index = snapLib.snapIndex(candsFor(s.kind, s.id));
  const out = snapLib.snapRect(objects ? s.index : null, raw, { z: cam.z, objects, pixel: snapCfg.pixel, guides: snapCfg.guides });
  snapTimes.push(performance.now() - t0);
  if (snapTimes.length > 2000) snapTimes.splice(0, 1000);
  return out;
}
// Widgets drag in /page/widgets.js and snap through these.
host.snapBegin = (id) => ({ kind: "widget", id, index: null });
host.snapRect = (s, r, e) => { const o = snapQuery(s, r, e); paintGuides(o.guides); return { x: o.x, y: o.y, w: r.w, h: r.h }; };
host.snapEnd = () => clearGuides();
// Live edits and resize handles (/page/live.js) draw through these.
host.snapIndex = (kind, id) => (snapLib && cam ? snapLib.snapIndex(candsFor(kind, id)) : null);
host.paintGuides = (gs) => paintGuides(gs);
host.clearGuides = () => clearGuides();
host.moveInfo = (id) => (selMove && selMove.id === id ? selMove : null);
/** Show a board somewhere now; it stays there until the file agrees (or 5 s pass). */
host.placeBoard = (id, x, y) => { const b = boards.get(id); if (!b) return; posHold.set(id, { x, y, until: performance.now() + 5000 }); placeBoardAt(b, x, y); requestFlush(false); };
/** A board's drawn size changed (a live edit laid it out again). Runs inside the frame, before the overlays are placed. */
host.boardSized = (id, w, h) => { const b = boards.get(id); if (!b) return; b.measured = true; setBoardSize(b, w, h); camDirty = true; };
/** Fetch and draw a board's scene now (what the server made of an edit), without waiting for the file watcher. */
host.reloadBoard = (id) => { const b = boards.get(id); if (b && mode === "engine" && ev && !b.gone) engineLoad([b]); };
const worldAt = (cx, cy) => ({ x: (cx - VL - cam.x) / cam.z, y: (cy - VT - cam.y) / cam.z });
/** A press that starts a move: a board title, or inside the selected board or absolute layer. */
function beginMove(e) {
  if (e.button !== 0 || space || !cam || !doc) return false;
  const lb = e.target && e.target.closest && e.target.closest("#labels>div");
  let b = lb ? labelBoard.get(lb) : null, kind = null;
  // A locked board's title does not pick or drag it; a locked selection does not move with the pointer.
  if (b && isLocked(b.meta.id)) return false;
  if (!b && host.selection().some(isLocked)) return pressSelect(e);
  if (b && e.shiftKey) {
    if (down) down.title = true;
    const had = host.selection().includes(b.meta.id);
    setSelection(toggled(b.meta.id));
    // A board just added drags with the rest of the selection; one taken out does not move.
    if (!had && multi) beginGroupMove(e);
    return true;
  }
  if (b && multi && multi.includes(b.meta.id)) {
    if (down) down.title = true;
    return beginGroupMove(e) || true;
  }
  if (b) {
    if (!sel || sel.id !== b.meta.id || multi) select(b.meta.id);
    if (down) down.title = true;
    kind = "board";
  } else if (multi && selWorld) {
    // Several selected: a press inside their box drags them all; a click without a drag still picks.
    const p = worldAt(e.clientX, e.clientY), w = selWorld;
    if (p.x < w.x || p.y < w.y || p.x > w.x + w.w || p.y > w.y + w.h) return pressSelect(e);
    if (host.autolayout && host.autolayout.beginDrag(e, multi.slice())) return true; // siblings in one auto layout frame: reorder, Option: copy (/page/autolayout.js)
    return beginGroupMove(e);
  } else if (sel && !isW(sel.id) && selWorld && !multi) {
    const p = worldAt(e.clientX, e.clientY), w = selWorld;
    if (p.x < w.x || p.y < w.y || p.x > w.x + w.w || p.y > w.y + w.h) return pressSelect(e);
    if (boards.has(sel.id)) { b = boards.get(sel.id); kind = "board"; }
    else if (selMove && selMove.id === sel.id && selMove.mode === "absolute") kind = "node";
    else if (host.autolayout && host.autolayout.beginDrag(e, [sel.id])) return true; // a flow child: reorder drag (/page/autolayout.js)
    else if (sel.id.includes("/")) return true; // a layer inside an instance does not move on its own; no pan either
    else if (!selMove || selMove.id !== sel.id) return pendingMove(e, sel.id); // its move info is still on the way
    else return false;
  } else return pressSelect(e);
  const r0 = kind === "board" ? { x: b.meta.x, y: b.meta.y, w: b.w, h: b.h } : { x: selWorld.x, y: selWorld.y, w: selWorld.w, h: selWorld.h };
  mv = { kind, b, id: kind === "board" ? b.meta.id : sel.id, r0, cx: e.clientX, cy: e.clientY, moved: false, pos: null, guides: [], index: null, node0: kind === "node" ? { x: selMove.x || 0, y: selMove.y || 0 } : null, dup: e.altKey, shownDup: false };
  endTween(true);
  firstFit = null;
  try { view.setPointerCapture(e.pointerId); } catch {}
  clearHover();
  return true;
}
/**
 * A press on a layer that is not selected selects it (the click rule) and a drag moves it, in one gesture.
 * A flow child starts its reorder drag at once; an absolutely placed layer moves once GET /api/move has said so
 * (mv.pending). A layer inside an instance is only selected. Boards, Shift and Cmd (marquee) keep their own presses.
 */
function pressSelect(e) {
  if (e.shiftKey && !metaOf(e) && !e.ctrlKey) return shiftPress(e);
  if (e.shiftKey || metaOf(e) || e.ctrlKey) return false;
  const id = pickSelectable(e.clientX, e.clientY, false);
  if (!id || isW(id) || boards.has(id)) return false;
  if (down) down.picked = true;
  select(id);
  if (id.includes("/")) return true; // no pan: the press was on a layer
  if (host.autolayout && host.autolayout.beginDrag(e, [id])) return true;
  return pendingMove(e, id);
}
/**
 * Shift+press on a layer not selected: it joins the selection, and a drag moves the whole selection (Shift locks
 * the axis). A press on nothing, or on a selected layer, keeps the old rules (marquee, click toggles).
 */
function shiftPress(e) {
  const id = pickSelectable(e.clientX, e.clientY, false);
  if (!id || isW(id) || boards.has(id) || id.includes("/")) return false;
  const cur = host.selection();
  if (cur.includes(id)) return false;
  if (down) down.picked = true;
  setSelection(cur.concat(id));
  if (!multi) return pendingMove(e, id);
  return beginGroupMove(e) || true;
}
/** A move of layer id that starts once GET /api/move says it is absolutely placed (see the pointermove below). */
function pendingMove(e, id) {
  const r = worldRectOf(id);
  if (!r) return true;
  mv = { kind: "node", b: null, id, r0: { x: r.x, y: r.y, w: r.w, h: r.h }, cx: e.clientX, cy: e.clientY, moved: false, pos: null, guides: [], index: null, node0: null, dup: e.altKey, shownDup: false, pending: true };
  endTween(true);
  firstFit = null;
  try { view.setPointerCapture(e.pointerId); } catch {}
  clearHover();
  return true;
}
/**
 * A press on a layer not selected before moves it once its move info says it is absolutely placed. Pointer moves
 * and the release that come first are kept, so a quick flick still lands where it was let go.
 * False while the info is still on the way.
 */
function resolvePending() {
  const m = mv;
  if (!m || !m.pending) return true;
  if (!selMove || selMove.id !== m.id) return false;
  if (selMove.mode !== "absolute") { mv = null; return false; }
  m.node0 = { x: selMove.x || 0, y: selMove.y || 0 };
  m.pending = false;
  clearTimeout(m.pendT);
  if (m.last) movePointer(m.last);
  if (mv === m && m.endAfter) endMove(false);
  return true;
}
view.addEventListener("pointermove", (e) => {
  if (!mv) return;
  if (mv.pending) {
    mv.last = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey };
    if (!resolvePending()) return;
    if (!mv) return;
  }
  movePointer(e);
});
function movePointer(e) {
  if (!mv) return;
  let dxp = e.clientX - mv.cx, dyp = e.clientY - mv.cy;
  if (!mv.moved) { if (Math.hypot(dxp, dyp) < 3) return; mv.moved = true; if (down) down.moved = true; }
  // Shift: the move keeps its dominant axis only; the other stays where it started, snapping included.
  const lock = e.shiftKey ? (Math.abs(dxp) >= Math.abs(dyp) ? "y" : "x") : null;
  if (lock === "y") dyp = 0; else if (lock === "x") dxp = 0;
  const s = snapQuery(mv, { x: mv.r0.x + dxp / cam.z, y: mv.r0.y + dyp / cam.z, w: mv.r0.w, h: mv.r0.h }, e);
  mv.pos = { x: lock === "x" ? mv.r0.x : s.x, y: lock === "y" ? mv.r0.y : s.y };
  mv.guides = lock ? s.guides.filter((g) => g.axis !== lock) : s.guides;
  // Where the drop lands is judged at the pointer as the layer carries it: with Shift, on the locked axis, not where
  // the pointer wandered off to (QA round 2 #11).
  mv.px = mv.cx + dxp; mv.py = mv.cy + dyp; mv.mods = { ctrl: e.ctrlKey, meta: e.metaKey };
  mv.dup = e.altKey; // Option: drag copies, the originals stay; pressing or letting go mid-drag switches
  mv.keep = keepParent || !!mv.keepUp; // Space held: the layer keeps its parent, so no frame lights up to take it
  if ((mv.kind === "node" || mv.kind === "board") && host.autolayout) { if (mv.keep) host.autolayout.clearInto(); else host.autolayout.overInto(mv.id, mv.px, mv.py, mv.mods); }
  mvDirty = true;
  requestFlush(false);
}
view.addEventListener("pointerup", () => {
  // Let go before the move info came: the drop waits for it (2 s at most), then lands where the pointer left.
  if (mv && mv.pending && mv.last) { const m = mv; m.endAfter = true; m.keepUp = keepParent; m.pendT = setTimeout(() => { if (mv === m && m.pending) mv = null; }, 2000); return; }
  endMove(false);
});
// Option pressed or let go while the pointer holds still: the drag switches between moving and copying now.
const altFlip = (e) => { if (e.key !== "Alt" || !mv || !mv.moved || mv.dup === e.altKey) return; mv.dup = e.altKey; mvDirty = true; requestFlush(false); };
addEventListener("keydown", altFlip, true);
addEventListener("keyup", altFlip, true);
host.moving = () => !!mv;
/** Put a board somewhere now: engine, DOM, title. The file is written separately. */
function placeBoardAt(b, x, y) {
  if (b.meta.x === x && b.meta.y === y) return;
  b.meta = Object.assign({}, b.meta, { x, y });
  if (b.el) { b.el.style.left = x + "px"; b.el.style.top = y + "px"; }
  if (mode === "engine" && ev) ev.moveBoard(b.meta.id, x, y);
  labelsVer++;
  if (cam) placeLabels();
}
// ---------- several selected, moved together ----------
// Boards, absolutely placed layers and widget cards of a multi-selection move as one: snapping works on their
// union box, boards and cards follow the pointer, layers' outlines do (their drawing follows the write), and
// the drop is one undo step: POST /api/move {items} for the boards and layers, then each card's write with the
// same merge key (src/move.ts, src/widgets.ts). Layers placed by auto layout, instance layers and layers inside
// a selected board stay out (the server skips them too).
const groupInfo = new Map(); // layer id -> GET /api/move answer ({mode}) for the layers of a multi-selection
let multiHold = null; // {rects: Map(id -> world rect), armed, until}: moved layers' outlines until their boards redraw
function loadGroupInfo(ids) {
  for (const id of ids) {
    if (isW(id) || boards.has(id) || id.includes("/") || groupInfo.has(id)) continue;
    fetch(api("/api/move") + "&id=" + encodeURIComponent(id)).then((r) => r.json()).then((j) => { if (j && j.mode) groupInfo.set(id, j); }).catch(() => {});
  }
}
function groupItems() {
  const items = [];
  for (const id of multi || []) {
    if (isW(id)) { const r = host.widgetRect && host.widgetRect(id); if (r) items.push({ id, kind: "widget", r0: r }); continue; }
    if (isLocked(id)) continue; // a locked layer or board (selected in the Layers panel) stays where it is
    const b = boards.get(id);
    if (b) { items.push({ id, kind: "board", b, r0: boxOf(b) }); continue; }
    if (id.includes("/")) continue;
    const gi = groupInfo.get(id);
    if (gi && gi.mode !== "absolute") continue;
    const bo = mode === "engine" && ev ? ev.boardOf(id) : null;
    if (bo && multi.includes(bo)) continue; // goes along with its board
    const r = (multiHold && multiHold.rects.get(id)) || worldRectOf(id);
    if (r) items.push({ id, kind: "node", r0: r, own: host.live ? host.live.ownPos(id) : null });
  }
  return items;
}
/** Where each moving item shows during a group drag. */
function groupRects(m) {
  const dx = m.pos.x - m.r0.x, dy = m.pos.y - m.r0.y, out = new Map();
  for (const it of m.items) out.set(it.id, { x: it.r0.x + dx, y: it.r0.y + dy, w: it.r0.w, h: it.r0.h });
  return out;
}
function beginGroupMove(e) {
  if (e.button !== 0 || space || !cam || !doc || !multi || mv) return false;
  const items = groupItems();
  if (!items.length) return false;
  mv = { kind: "group", items, id: "group", r0: unionRect(items.map((i) => i.r0)), cx: e.clientX, cy: e.clientY, moved: false, pos: null, guides: [], index: null, exclude: new Set(multi) };
  endTween(true);
  firstFit = null;
  try { view.setPointerCapture(e.pointerId); } catch {}
  clearHover();
  return true;
}
host.beginGroupMove = (e) => beginGroupMove(e); // a press on a selected widget card (/page/widgets.js)
function groupApply(m) {
  const dx = m.pos.x - m.r0.x, dy = m.pos.y - m.r0.y;
  if (dupApply(m, dx, dy)) {
    const moved = groupRects(m);
    multiWorld = (multi || []).map((id, k) => moved.get(id) || multiWorld[k] || null);
    selWorld = unionRect(multiWorld);
    putBox(selBox, selWorld);
    placeMultiBoxes();
    paintGuides(m.guides);
    return;
  }
  for (const it of m.items) if (it.kind === "board") { posHold.set(it.id, { x: it.r0.x + dx, y: it.r0.y + dy, until: Infinity }); placeBoardAt(it.b, it.r0.x + dx, it.r0.y + dy); }
  if (host.widgetGroup) host.widgetGroup.preview(m.items.filter((i) => i.kind === "widget").map((i) => i.id), dx, dy);
  for (const it of m.items) if (it.kind === "node" && it.own && host.live) host.live.place(it.id, it.own.x + dx, it.own.y + dy); // layers follow the pointer too
  const moved = groupRects(m);
  multiWorld = (multi || []).map((id, k) => moved.get(id) || multiWorld[k] || null);
  selWorld = unionRect(multiWorld);
  putBox(selBox, selWorld);
  placeMultiBoxes();
  paintGuides(m.guides);
}
function groupDrop(m, cancel) {
  const round = (v) => (snapCfg.pixel ? Math.round(v) : v);
  const dx = m.pos.x - m.r0.x, dy = m.pos.y - m.r0.y;
  if (m.dup || m.shownDup) { dupEnd(m); if (m.dup && !cancel && (dx || dy)) { if (!groupDupInto(m, dx, dy)) dupDrop(m, dx, dy); return; } syncSel(); requestFlush(false); if (m.dup || cancel || (!dx && !dy)) return; }
  const cards = m.items.filter((i) => i.kind === "widget").map((i) => i.id);
  // Layers only, dropped on an auto layout frame: they join its flow at the slot, one place write.
  if (!cancel && !m.keep && (dx || dy) && m.px !== undefined && host.autolayout && host.autolayout.dropManyInto && m.items.every((i) => i.kind === "node")) {
    const w = host.autolayout.dropManyInto(m.items.map((i) => i.id), m.px, m.py, m.mods || {});
    if (w) {
      if (host.live) for (const it of m.items) if (it.own) host.live.unplace(it.id);
      multiHold = null;
      if (w.then) trackWrite(w);
      syncSel();
      requestFlush(false);
      return;
    }
  }
  const revert = () => {
    for (const it of m.items) if (it.kind === "board") { posHold.delete(it.id); placeBoardAt(it.b, it.r0.x, it.r0.y); }
    if (host.widgetGroup) host.widgetGroup.preview(cards, 0, 0);
    if (host.live) for (const it of m.items) if (it.kind === "node" && it.own) host.live.unplace(it.id);
    multiHold = null;
    syncSel();
    requestFlush(false);
  };
  if (cancel || (!dx && !dy)) { revert(); return; }
  const key = "group:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rects = new Map();
  for (const it of m.items) {
    if (it.kind === "widget") continue;
    const x = it.kind === "board" ? round(it.r0.x + dx) : it.r0.x + dx, y = it.kind === "board" ? round(it.r0.y + dy) : it.r0.y + dy;
    if (it.kind === "board") { posHold.set(it.id, { x, y, until: performance.now() + 5000 }); placeBoardAt(it.b, x, y); }
    rects.set(it.id, { x, y, w: it.r0.w, h: it.r0.h });
  }
  multiHold = { rects, armed: false, until: performance.now() + 5000 };
  syncSel();
  requestFlush(false);
  // Layers dropped on another frame, board or empty canvas change parent there (/page/reparent.js), in the same undo step.
  const pl = host.reparent && m.px !== undefined && !m.keep ? host.reparent.plan(m.items.filter((i) => i.kind === "node" && rects.has(i.id)).map((i) => ({ id: i.id, rect: rects.get(i.id) })), m.px, m.py, m.mods || {}, null) : null;
  const repar = new Set(pl ? pl.moves.map((x) => x.id) : []);
  const nodes = m.items.filter((i) => i.kind !== "widget" && !repar.has(i.id));
  // The layers stay drawn where they were dropped until the write answers (the server rounds when pixel snapping is on).
  const gop = host.live ? host.live.nextOp() : 0, round1 = (v) => (snapCfg.pixel ? Math.round(v) : v);
  const placed = gop ? nodes.filter((it) => it.kind === "node" && it.own && host.live.place(it.id, round1(it.own.x + dx), round1(it.own.y + dy), gop)) : [];
  const move = () => (nodes.length ? sendMove({ file, items: nodes.map((i) => ({ id: i.id, dx, dy })), round: snapCfg.pixel, merge: key }) : Promise.resolve(null));
  // The reparenting goes first: history folds the plain moves (property changes) into a step that holds tree changes,
  // never tree changes into one that holds property changes, so the other order would make two undo steps.
  const write = repar.size ? host.reparent.apply(pl, { merge: key, keepSelection: true }).then(move) : move();
  // Undo waits for the whole drop (the layers' write, then the cards'), or the cards would land after it as a new step.
  trackWrite(write.then((j) => {
    if (multiHold && multiHold.rects === rects) multiHold.armed = true;
    // What the server left where it was (auto layout, inside a moved node) goes back on screen too.
    const skipped = j && Array.isArray(j.skipped) ? j.skipped : [];
    for (const it of placed) host.live.ack(it.id, gop, !skipped.some((sk) => sk.id === it.id));
    for (const sk of skipped) { const it = m.items.find((i) => i.id === sk.id); if (it && it.kind === "board") { posHold.delete(it.id); placeBoardAt(it.b, it.r0.x, it.r0.y); } rects.delete(sk.id); }
    if (skipped.some((sk) => sk.code === "auto_layout")) tellOnce("Auto layout places some of these layers; they stayed");
    if (cards.length && host.widgetGroup) host.widgetGroup.commit(cards, dx, dy, key);
    syncSel();
  }, (err) => { for (const it of placed) host.live.ack(it.id, gop, false); revert(); tell("Could not move: " + err.message); }));
}
host.on("render", () => { if (multiHold && multiHold.armed) { multiHold = null; syncSel(); } });
// Runs in the frame (flushCam), before the engine draws.
function mvApply() {
  const m = mv;
  if (!m || !m.pos) return;
  if (m.kind === "group") { groupApply(m); return; }
  if (dupApply(m, m.pos.x - m.r0.x, m.pos.y - m.r0.y)) {
    selWorld = { x: m.pos.x, y: m.pos.y, w: m.r0.w, h: m.r0.h };
    putBox(selBox, selWorld);
    paintGuides(m.guides);
    return;
  }
  if (m.kind === "board") { posHold.set(m.id, { x: m.pos.x, y: m.pos.y, until: Infinity }); placeBoardAt(m.b, m.pos.x, m.pos.y); }
  // The layer itself follows the pointer (drawn by the page), and the inspector's x and y with it. A layer inside a
  // clipping frame is lifted out for the drag (drawn unclipped, on top): a copy on the overlay board moves.
  if (m.kind === "node" && m.lift === undefined) m.lift = liftLayer(m);
  if (host.live) {
    const p = movedTo(m);
    if (m.lift) { host.ghost.move(m.pos.x - m.r0.x, m.pos.y - m.r0.y); host.live.note(m.id, p, [], 0); }
    else if (m.kind === "node") host.live.place(m.id, p.x, p.y);
    else host.live.note(m.id, p, [], 0);
  }
  selWorld = { x: m.pos.x, y: m.pos.y, w: m.r0.w, h: m.r0.h };
  putBox(selBox, selWorld);
  paintGuides(m.guides);
}
function endMove(cancel) {
  const m = mv;
  if (!m) return;
  mv = null;
  mvDirty = false;
  clearGuides();
  unlift(m);
  if (!m.moved || !m.pos) return;
  if (m.kind === "group") { groupDrop(m, cancel); return; }
  if (m.dup || m.shownDup) {
    dupEnd(m);
    if (m.dup) {
      if (m.kind === "node" && host.autolayout) {
        // Dropped on an auto layout frame: the copy joins its flow there; the layer stays.
        if (!cancel && !m.keep && m.px !== undefined && host.autolayout.dropInto(m.id, m.px, m.py, m.mods, { copy: true })) { syncSel(); return; }
        host.autolayout.clearInto();
      }
      // Dropped on another frame, board or empty canvas: the copy lands there (/page/reparent.js).
      if (!cancel && m.kind === "node" && dropReparent(m, true)) return;
      if (!cancel && (m.pos.x !== m.r0.x || m.pos.y !== m.r0.y)) dupDrop(m, m.pos.x - m.r0.x, m.pos.y - m.r0.y);
      else { syncSel(); requestFlush(false); }
      return;
    }
  }
  if (m.kind === "node" && host.autolayout) {
    // Dropped on an auto layout frame: it joins the flow there (one place write) instead of moving (/page/autolayout.js).
    if (!cancel && !m.keep && m.px !== undefined && host.autolayout.dropInto(m.id, m.px, m.py, m.mods)) { if (host.live) { host.live.unplace(m.id); host.live.noteForget(m.id); } syncSel(); return; }
    host.autolayout.clearInto();
  }
  // Dropped on another frame, board or empty canvas: it changes parent there (/page/reparent.js).
  if (!cancel && m.kind === "node" && dropReparent(m, false)) return;
  if (m.kind === "board" && host.autolayout) {
    // A board dropped on an auto layout frame joins its flow there; the place write hides it from the canvas.
    const w = !cancel && !m.keep && m.px !== undefined && (m.pos.x !== m.r0.x || m.pos.y !== m.r0.y) ? host.autolayout.dropInto(m.id, m.px, m.py, m.mods) : false;
    if (w) {
      posHold.delete(m.id);
      trackWrite(Promise.resolve(w).then((j) => { if (!j) { placeBoardAt(m.b, m.r0.x, m.r0.y); syncSel(); requestFlush(false); } }));
      syncSel();
      requestFlush(false);
      return;
    }
    host.autolayout.clearInto();
  }
  // A board dropped inside another board or frame nests there.
  if (!cancel && m.kind === "board" && dropBoardInto(m)) return;
  const revert = () => { if (m.kind === "board") { posHold.delete(m.id); placeBoardAt(m.b, m.r0.x, m.r0.y); } selHold = null; if (host.live) { if (m.kind === "node") host.live.unplace(m.id); host.live.noteForget(m.id); } syncSel(); requestFlush(false); };
  if (cancel || (m.pos.x === m.r0.x && m.pos.y === m.r0.y)) { revert(); return; }
  let body;
  if (m.kind === "board") {
    posHold.set(m.id, { x: m.pos.x, y: m.pos.y, until: performance.now() + 5000 });
    body = { file, id: m.id, x: m.pos.x, y: m.pos.y };
  } else {
    selHold = { id: m.id, rect: { x: m.pos.x, y: m.pos.y, w: m.r0.w, h: m.r0.h }, board: mode === "engine" && ev ? ev.boardOf(m.id) : null, armed: false };
    body = { file, id: m.id, x: m.node0.x + m.pos.x - m.r0.x, y: m.node0.y + m.pos.y - m.r0.y, round: snapCfg.pixel };
  }
  const op = host.live ? host.live.nextOp() : 0;
  const drawn = op && m.kind === "node" ? host.live.place(m.id, movedTo(m).x, movedTo(m).y, op) : false;
  if (op && !drawn) host.live.note(m.id, movedTo(m), [], op);
  // The layer's x/y as this drop leaves them, now: a second drag before the answer starts from here, not from
  // where the first one started (both would save the same x). Only the newest drop's answer is kept.
  const tag = ++moveTag;
  const was = m.kind === "node" && selMove && selMove.id === m.id ? { x: selMove.x, y: selMove.y } : null;
  if (was) Object.assign(selMove, movedTo(m));
  // One drop's write after the other for the same layer: sent together they can reach the server in either order.
  trackWrite(moveAfter(m.id, body).then((j) => {
    if (op) { if (drawn) host.live.ack(m.id, op, true); else host.live.noteAck(m.id, op, true); }
    if (tag === moveTag && selMove && selMove.id === m.id) { selMove.x = j.x; selMove.y = j.y; }
    if (selHold && selHold.id === m.id) selHold.armed = true;
  }, (err) => {
    if (op) { if (drawn) host.live.ack(m.id, op, false); else host.live.noteAck(m.id, op, false); }
    if (was && tag === moveTag && selMove && selMove.id === m.id) Object.assign(selMove, was);
    revert();
    tell("Could not move: " + err.message);
  }));
}
let moveTag = 0;
const moveChain = new Map();
/** sendMove once the previous drop of the same layer has its answer. */
function moveAfter(id, body) {
  const prev = moveChain.get(id);
  const p = prev ? prev.catch(() => {}).then(() => sendMove(body)) : sendMove(body);
  moveChain.set(id, p);
  const clear = () => { if (moveChain.get(id) === p) moveChain.delete(id); };
  p.then(clear, clear);
  return p;
}
/** A board dropped inside another frame becomes a layer of it (one place write); it stays selected. False: a plain move. */
function dropBoardInto(m) {
  if (!host.reparent || m.keep || m.px === undefined || (m.pos.x === m.r0.x && m.pos.y === m.r0.y)) return false;
  const rect = { x: m.pos.x, y: m.pos.y, w: m.r0.w, h: m.r0.h };
  const pl = host.reparent.plan([{ id: m.id, rect }], m.px, m.py, m.mods || {}, { w: m.r0.w, h: m.r0.h });
  if (!pl || !pl.moves.length || pl.target.kind !== "frame") return false;
  const w = host.reparent.apply(pl, {});
  posHold.delete(m.id);
  host.hideBoards([m.id]);
  trackWrite(w.then(() => { if (sel && sel.id === m.id) select(m.id, true); }, () => { host.restoreBoards([m.id]); placeBoardAt(m.b, m.r0.x, m.r0.y); syncSel(); requestFlush(false); }));
  syncSel();
  requestFlush(false);
  return true;
}
/**
 * A single layer's drop that changes its parent (the frame under the pointer adopts it): one place write
 * (/page/reparent.js), the selection stays on the layer (or goes to the copy). False: a plain move does it.
 */
function dropReparent(m, copy) {
  if (!host.reparent || m.keep || m.px === undefined || (m.pos.x === m.r0.x && m.pos.y === m.r0.y)) return false;
  const rect = { x: m.pos.x, y: m.pos.y, w: m.r0.w, h: m.r0.h };
  const pl = host.reparent.plan([{ id: m.id, rect }], m.px, m.py, m.mods || {}, { w: m.r0.w, h: m.r0.h });
  if (!pl || !pl.moves.length) return false;
  if (!copy) selHold = { id: m.id, rect, board: null, armed: false };
  trackWrite(host.reparent.apply(pl, { copy }).then(() => {
    if (selHold && selHold.id === m.id) selHold.armed = true;
    if (!copy && sel && sel.id === m.id) loadMoveInfo(m.id, true);
  }, () => { selHold = null; if (host.live && !copy) host.live.unplace(m.id); syncSel(); requestFlush(false); }));
  syncSel();
  requestFlush(false);
  return true;
}
// ---------- Option-drag: copies ----------
// Option held while dragging drags copies and leaves the originals; pressing or letting go of Option mid-drag
// switches. The originals go back to where they were, the copies show under the pointer (host.ghost, an overlay
// board in /page/shortcuts.js; cards clone in /page/widgets.js), and the drop writes the copies in one undo step:
// POST /api/structure duplicate {offset} for boards and layers, the cards' copies joining it by merge key.
/** One frame of a drag in copy mode (true), or, leaving it, the originals' previews come back (false). */
function dupApply(m, dx, dy) {
  const items = m.kind === "group" ? m.items : [{ id: m.id, kind: m.kind, b: m.b, r0: m.r0 }];
  if (!m.dup) {
    if (m.shownDup) { dupEnd(m); m.shownDup = false; }
    return false;
  }
  if (!m.shownDup) {
    m.shownDup = true;
    if (m.lift) unlift(m); // the copy takes the overlay board now; the layer shows where it was
    // The originals back in place: their drawing stays there while the copies move.
    for (const it of items) {
      if (it.kind === "board") { posHold.delete(it.id); placeBoardAt(it.b, it.r0.x, it.r0.y); }
      else if (it.kind === "node" && host.live) host.live.unplace(it.id);
    }
    if (host.widgetGroup) host.widgetGroup.preview(items.filter((i) => i.kind === "widget").map((i) => i.id), 0, 0);
    if (host.ghost) host.ghost.build(items.filter((i) => i.kind !== "widget").map((i) => ({ id: i.id, rect: i.r0 })));
  }
  if (host.ghost) host.ghost.move(dx, dy);
  if (host.widgetGroup && host.widgetGroup.ghost) host.widgetGroup.ghost(items.filter((i) => i.kind === "widget").map((i) => i.id), dx, dy);
  return true;
}
/**
 * A multi-selection's Option-drag dropped on an auto layout frame, another frame, board or empty canvas: the copies
 * land there, not in the originals' parents. Layers staying in their own frame are copied in place with the
 * same merge key, so the drop is one undo step. False: no copy changes parent (dupDrop does it all).
 */
function groupDupInto(m, dx, dy) {
  if (m.keep) return false; // Space held: the copies stay beside the originals, in their parents
  const nodes = m.items.filter((i) => i.kind === "node");
  if (m.px === undefined || !nodes.length) return false;
  if (nodes.length === m.items.length && host.autolayout && host.autolayout.dropManyInto) {
    const w = host.autolayout.dropManyInto(nodes.map((i) => i.id), m.px, m.py, m.mods || {}, { copy: true });
    if (w) { if (w.then) trackWrite(w); syncSel(); requestFlush(false); return true; }
  }
  if (!host.reparent) return false;
  const pl = host.reparent.plan(nodes.map((i) => ({ id: i.id, rect: { x: i.r0.x + dx, y: i.r0.y + dy, w: i.r0.w, h: i.r0.h } })), m.px, m.py, m.mods || {}, null);
  if (!pl || !pl.moves.length) return false;
  const moving = new Set(pl.moves.map((x) => x.id));
  const rest = m.items.filter((i) => !moving.has(i.id));
  const merge = rest.length ? "group:dup-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : undefined;
  syncSel();
  requestFlush(false);
  const gen = selGen;
  trackWrite(host.reparent.apply(pl, { copy: true, keepSelection: true, ...(merge ? { merge } : {}) }).then((j) => {
    const made = j && Array.isArray(j.select) ? j.select.slice() : [];
    if (rest.length) { dupDrop({ kind: "group", items: rest }, dx, dy, merge, made); return; }
    if (made.length && selGen === gen) setSelection(made);
  }, () => {}));
  return true;
}
/** The copy-mode drawing goes (the ghost and card clones). */
function dupEnd(m) {
  if (host.ghost) host.ghost.hide();
  if (host.widgetGroup && host.widgetGroup.clearGhost) host.widgetGroup.clearGhost();
  void m;
}
/** The drop of a copy drag: boards and layers through one duplicate, cards with the same merge key; the copies are selected. */
function dupDrop(m, dx, dy, merge0, made0) {
  const items = m.kind === "group" ? m.items : [{ id: m.id, kind: m.kind }];
  const nodes = items.filter((i) => i.kind !== "widget").map((i) => i.id), cards = items.filter((i) => i.kind === "widget").map((i) => i.id);
  const merge = merge0 || (nodes.length && cards.length ? "group:dup-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : undefined);
  const gen = selGen;
  syncSel();
  requestFlush(false);
  const made = made0 ? made0.slice() : [];
  const w1 = nodes.length ? fetch("/api/structure", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, page: activePage || undefined, op: "duplicate", ids: nodes, offset: { dx, dy }, round: snapCfg.pixel, ...(merge ? { merge } : {}) }) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
    .then((j) => { if (Array.isArray(j.select)) { made.push(...j.select); host.lastDuplicate = { src: nodes.slice(), copies: j.select.slice() }; } })
    : Promise.resolve();
  const w2 = w1.then(() => (cards.length && host.widgetGroup && host.widgetGroup.duplicate ? host.widgetGroup.duplicate(cards, dx, dy, merge) : [])).then((c) => { made.push(...(c || [])); });
  trackWrite(w2.then(() => { if (made.length && selGen === gen) setSelection(made); }, (err) => tell("Could not duplicate: " + err.message)));
}
/**
 * Lift a dragged layer out of a clipping frame or board (QA round 2 #5): its copy draws on the overlay board, above
 * everything and unclipped, and the layer itself is hidden until the drop. Only unrotated, unflipped layers (the
 * overlay draws the copy at its box). True when lifted.
 */
function liftLayer(m) {
  const L = host.live;
  if (!L || !host.ghost || mode !== "engine") return false;
  const b = L.boardOf(m.id), scene = b ? L.sceneOf(b) : null;
  if (!scene) return false;
  let hit = null;
  const walk = (n, clipped) => {
    if (hit || !n || typeof n !== "object") return;
    if (String(n.id) === m.id) { hit = { n, clipped }; return; }
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c, clipped || n.clip === true);
  };
  walk(scene.root, false);
  if (!hit || !hit.clipped || Number(hit.n.rotation) || hit.n.flipX === true || hit.n.flipY === true) return false;
  if (!host.ghost.build([{ id: m.id, rect: m.r0 }])) return false;
  L.hide(m.id);
  return true;
}
/** The lifted layer goes back to its board (before the drop draws it where it landed). */
function unlift(m) {
  if (!m.lift) return;
  m.lift = undefined;
  if (host.ghost) host.ghost.hide();
  if (host.live) host.live.unhide(m.id);
}
/** A single drag's x/y as the file will have them (a layer's own x/y, not its world rect). */
function movedTo(m) {
  if (m.kind === "board") return { x: m.pos.x, y: m.pos.y };
  const r = (v) => (snapCfg.pixel ? Math.round(v) : v);
  return { x: r(m.node0.x + m.pos.x - m.r0.x), y: r(m.node0.y + m.pos.y - m.r0.y) };
}
// A moved layer's box stays where it was dropped until its board has redrawn with it there.
host.on("render", (bid) => { if (selHold && selHold.armed && (!bid || !selHold.board || bid === selHold.board)) { selHold = null; syncSel(); } });
/** Arrow keys: move now on screen, write in the background; presses that arrive mid-write go out together. */
function nudge(dx, dy) {
  const id = sel.id;
  if (mv) return;
  // Locked layers do not move on the canvas; the Layers panel selects them for the inspector's edits.
  // With a locked one in the selection the arrows do not reorder a flow; the unlocked ones move (groupItems).
  if (multi) { if (multi.some(isLocked) || !(host.autolayout && host.autolayout.arrow(dx, dy))) groupNudge(dx, dy); return; }
  if (isW(id)) { host.emit("nudge", { id, dx, dy }); return; }
  if (isLocked(id)) return;
  if (id.includes("/")) { tellOnce("This layer is inside a component instance; move the instance instead"); return; }
  const b = boards.get(id);
  if (!b) {
    // Still asking how it moves (GET /api/move): keep the presses and play them once the answer is in.
    if (!selMove || selMove.id !== id) { earlyNudge = { id, dx: (earlyNudge && earlyNudge.id === id ? earlyNudge.dx : 0) + dx, dy: (earlyNudge && earlyNudge.id === id ? earlyNudge.dy : 0) + dy }; return; }
    if (host.autolayout && host.autolayout.arrow(dx, dy)) return; // a flow child: arrow keys reorder (/page/autolayout.js)
    if (selMove.mode === "auto") { tellOnce("Auto layout places this layer. Change the parent's gap or padding, or make the layer absolute."); return; }
    if (selMove.mode !== "absolute") return;
  }
  if (b) {
    let x = b.meta.x + dx, y = b.meta.y + dy;
    if (snapCfg.pixel) { x = Math.round(x); y = Math.round(y); }
    posHold.set(id, { x, y, until: Infinity });
    placeBoardAt(b, x, y);
    selWorld = { x, y, w: b.w, h: b.h };
  } else if (selWorld) {
    const r = selHold && selHold.id === id ? selHold.rect : selWorld;
    selHold = { id, rect: { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, board: mode === "engine" && ev ? ev.boardOf(id) : null, armed: false };
    selWorld = selHold.rect;
  }
  putBox(selBox, selWorld);
  requestFlush(false);
  let q = nudges.get(id);
  if (!q) nudges.set(id, (q = { dx: 0, dy: 0, busy: false, board: !!b, px: b ? 0 : selMove.x || 0, py: b ? 0 : selMove.y || 0 }));
  q.dx += dx; q.dy += dy;
  // The inspector's x and y move with each press (a preview: the write that follows carries it).
  if (b) { if (host.live) host.live.note(id, { x: b.meta.x, y: b.meta.y }, [], 0); }
  else {
    q.px = snapCfg.pixel ? Math.round(q.px + dx) : q.px + dx; q.py = snapCfg.pixel ? Math.round(q.py + dy) : q.py + dy;
    if (host.live) host.live.note(id, { x: q.px, y: q.py }, [], 0);
  }
  flushNudge(id);
}
// Arrow keys with several selected: every board, layer and card moves; the presses of a burst are one undo step.
let gnudge = null; // {key, gen, dx, dy, busy}: the burst for this selection
function groupNudge(dx, dy) {
  const items = groupItems();
  if (!items.length) return;
  // The burst keeps the layers it started with: presses queued behind a write in flight move those, never a
  // selection made meanwhile (a new selection starts a new burst).
  if (!gnudge || gnudge.gen !== selGen) gnudge = { key: "group:nudge-" + selGen + "-" + Date.now().toString(36), gen: selGen, dx: 0, dy: 0, busy: false, items: items.filter((i) => i.kind !== "widget") };
  const g = gnudge, round = (v) => (snapCfg.pixel ? Math.round(v) : v);
  const rects = multiHold ? new Map(multiHold.rects) : new Map();
  for (const it of items) {
    if (it.kind === "widget") { host.emit("nudge", { id: it.id, dx, dy, merge: g.key }); continue; }
    if (it.kind === "board") { const x = round(it.b.meta.x + dx), y = round(it.b.meta.y + dy); posHold.set(it.id, { x, y, until: Infinity }); placeBoardAt(it.b, x, y); }
    rects.set(it.id, { x: it.r0.x + dx, y: it.r0.y + dy, w: it.r0.w, h: it.r0.h });
  }
  multiHold = { rects, armed: false, until: Infinity };
  syncSel();
  requestFlush(false);
  g.dx += dx; g.dy += dy;
  flushGroupNudge(g);
}
function flushGroupNudge(g) {
  if (g.busy || (!g.dx && !g.dy)) return;
  const items = g.items;
  if (!items.length) { g.dx = 0; g.dy = 0; return; }
  const body = { file, items: items.map((i) => ({ id: i.id, dx: g.dx, dy: g.dy })), round: snapCfg.pixel, merge: g.key };
  g.dx = 0; g.dy = 0; g.busy = true;
  sendMove(body).then(() => {
    g.busy = false;
    if (g.dx || g.dy) { flushGroupNudge(g); return; }
    for (const it of items) if (it.kind === "board") { const h = posHold.get(it.id); if (h) h.until = performance.now() + 5000; }
    if (multiHold && gnudge === g) { multiHold.armed = true; multiHold.until = performance.now() + 5000; }
    nudgeSettled();
  }, (err) => {
    g.busy = false; g.dx = 0; g.dy = 0;
    if (gnudge === g) multiHold = null;
    for (const it of items) if (it.kind === "board") { posHold.delete(it.id); const m = doc && doc.boards.find((x) => x.id === it.id); if (m) placeBoardAt(it.b, m.x, m.y); }
    syncSel();
    tell("Could not nudge: " + err.message);
    nudgeSettled();
  });
}
function flushNudge(id) {
  const q = nudges.get(id);
  if (!q || q.busy || (!q.dx && !q.dy)) return;
  const body = { file, id, dx: q.dx, dy: q.dy, round: snapCfg.pixel, merge: "nudge" };
  q.dx = 0; q.dy = 0; q.busy = true;
  sendMove(body).then((j) => {
    q.busy = false;
    if (q.dx || q.dy) { flushNudge(id); return; }
    nudges.delete(id);
    if (q.board) { const h = posHold.get(id); if (h) h.until = performance.now() + 5000; }
    if (selMove && selMove.id === id) { selMove.x = j.x; selMove.y = j.y; }
    if (selHold && selHold.id === id) selHold.armed = true;
    nudgeSettled();
  }, (err) => {
    nudges.delete(id);
    const b = boards.get(id), m = doc && doc.boards.find((x) => x.id === id);
    if (b) { posHold.delete(id); if (m) placeBoardAt(b, m.x, m.y); }
    if (selHold && selHold.id === id) selHold = null;
    syncSel();
    tell("Could not nudge: " + err.message);
    nudgeSettled();
  });
}
/** Arrow presses not yet on disk: a write in flight, or presses queued behind one. */
function nudgesPending() {
  for (const q of nudges.values()) if (q.busy || q.dx || q.dy) return true;
  if (writesOut > 0 || (host.widgetWritesPending && host.widgetWritesPending())) return true;
  if (host.autolayout && host.autolayout.pending()) return true;
  return !!(earlyNudge || (gnudge && (gnudge.busy || gnudge.dx || gnudge.dy)));
}
// Drops (a layer's, a group's with its cards) and cards' writes (/page/widgets.js) still out: Undo waits for them too.
let writesOut = 0;
function trackWrite(p) {
  writesOut++;
  const done = () => { writesOut--; nudgeSettled(); };
  p.then(done, done);
  return p;
}
host.writesSettled = () => nudgeSettled();
// Tests and QA: the page still has a write on its way (a nudge, a card edit, an auto layout op).
host.writesPending = () => nudgesPending();
// Writes of the page modules (a committed text edit, /page/text-edit.js): Undo and Redo wait for them too.
host.trackWrite = (p) => trackWrite(p);
// Undo and Redo wait for them: run first, a queued nudge tail would land after the undo as a new step and clear Redo.
let nudgeWaiters = [];
function nudgeSettled() {
  if (nudgesPending() || !nudgeWaiters.length) return;
  const w = nudgeWaiters;
  nudgeWaiters = [];
  for (const f of w) f();
}
/** Rename a board in place: a field over its title. Enter or clicking away saves, Esc cancels. */
function renameBoard(b) {
  if (renaming) renaming.finish(true);
  if (!cam || !file) return;
  if (!sel || sel.id !== b.meta.id) select(b.meta.id);
  const inp = document.createElement("input");
  inp.id = "rename";
  inp.value = b.meta.name || "";
  inp.spellcheck = false;
  inp.setAttribute("aria-label", "Board name");
  const place = () => {
    const x = b.meta.x * cam.z + cam.x, y = b.meta.y * cam.z + cam.y - LABEL_H - LABEL_GAP;
    inp.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
    inp.style.width = Math.max(140, Math.min(360, labelWidth(inp.value) + 40)) + "px";
  };
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    renaming = null;
    const v = inp.value.trim(), was = b.meta.name || "";
    inp.remove();
    b.lbl.el.classList.remove("editing");
    if (!ok || !v || v === was) return;
    b.lbl.el.textContent = v; b.lbl.tw = 0; labelsVer++; placeLabels();
    fetch("/api/update", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id: b.meta.id, props: { name: v } }) })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); }))
      .catch((err) => { b.lbl.el.textContent = b.meta.name || ""; b.lbl.tw = 0; labelsVer++; placeLabels(); tell("Could not rename: " + err.message); });
  };
  renaming = { b, finish, place };
  inp.addEventListener("keydown", (k) => { k.stopPropagation(); if (k.key === "Enter") { k.preventDefault(); finish(true); } else if (k.key === "Escape") { k.preventDefault(); finish(false); } });
  inp.addEventListener("input", place);
  inp.addEventListener("blur", () => finish(true));
  for (const n of ["pointerdown", "pointerup", "dblclick"]) inp.addEventListener(n, (k) => k.stopPropagation());
  place();
  view.appendChild(inp);
  b.lbl.el.classList.add("editing");
  inp.focus();
  inp.select();
}
host.on("cam", () => { if (renaming) renaming.place(); if (mv && mv.guides.length) paintGuides(mv.guides); });
// The press captured the pointer, so the double-click is aimed at the view: find the title under it.
view.addEventListener("dblclick", (e) => { const id = titleAt(e.clientX, e.clientY), b = id && boards.get(id); if (b) { e.preventDefault(); renameBoard(b); } });
// ---------- camera ----------
view.addEventListener("wheel", (e) => {
  e.preventDefault();
  endTween(true);
  firstFit = null;
  ptr = { x: e.clientX, y: e.clientY };
  // Cmd+scroll and pinch zoom about the pointer, scroll pans, Shift+scroll pans sideways (src/pagelogic.ts).
  const a = wheelAction(e, cmdHeld, !!prefs.scrollZooms);
  if ("zoom" in a) {
    const z = Math.min(MAX_ZOOM, Math.max(0.02, cam.z * a.zoom));
    cam = zoomAt(cam, e.clientX - VL, e.clientY - VT, z); // the camera lives in view px; the event is in window px
  } else cam = { ...cam, x: cam.x - a.dx, y: cam.y - a.dy };
  applyCam();
}, { passive: false });
// The Command key as the page and the shell see it (a wheel event re-posted by a scroll utility can lose its flags;
// a click in WKWebView may arrive without it too). The shell's flagsChanged monitor (apps/macos/main.swift) sends
// {cmd: "mods"} whenever Command goes down or up, wherever focus is. A key event's own flags are always right, so one
// without Command clears a state that went stale.
let cmdHeld = false, shellCmd = false;
addEventListener("keydown", (e) => { if (e.key === "Meta") cmdHeld = true; else if (!e.metaKey) cmdHeld = shellCmd = false; }, true);
addEventListener("keyup", (e) => { if (e.key === "Meta") cmdHeld = shellCmd = false; }, true);
host.cmdHeld = () => cmdHeld;
addEventListener("blur", () => { cmdHeld = false; });
// Option during a drag from the shell (a component onto an instance swaps it, /page/drops.js): WebKit's drag events
// do not always carry it, so the shell sends it with Command in {cmd: "mods", alt}.
let altHeld = false;
addEventListener("keydown", (e) => { if (e.key === "Alt") altHeld = true; else if (!e.altKey) altHeld = false; }, true);
addEventListener("keyup", (e) => { if (e.key === "Alt") altHeld = false; }, true);
addEventListener("blur", () => { altHeld = false; });
host.altHeld = () => altHeld;
let drag = null;
view.addEventListener("pointerdown", (e) => { if (secondary(e)) return; if (beginMove(e)) return; if (host.beginMarquee && host.beginMarquee(e)) { if (down) down.moved = false; return; } endTween(true); firstFit = null; drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y }; view.setPointerCapture(e.pointerId); view.classList.add("panning"); clearHover(); });
view.addEventListener("pointermove", (e) => { if (down && !down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true; if (drag) { cam = { ...cam, x: drag.cx + e.clientX - drag.x, y: drag.cy + e.clientY - drag.y }; applyCam(); } });
const endDrag = () => { drag = null; view.classList.remove("panning"); };
view.addEventListener("pointerup", endDrag);
view.addEventListener("pointercancel", () => { down = null; endDrag(); endMove(true); });
addEventListener("resize", () => { VW = view.clientWidth; VH = view.clientHeight; if (zeroFit && VW && VH) { zeroFit = false; fitAll({ instant: true }); } readViewBox(); sizeGuides(); requestFlush(); scheduleVisible(); });
addEventListener("keydown", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || (t.closest && t.closest("[contenteditable]")))) return;
  // Space held while a layer is being dragged (other keys held too): it keeps its parent: it does not leave
  // its frame or nest into the one it is dropped on. The hand waits until Space is let go and pressed again.
  if (e.code === "Space" && (layerDragging() || spaceKept)) { e.preventDefault(); if (layerDragging()) setKeepParent(true); return; }
  if (e.code === "Space" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    // Hand mode: Space held means drag pans and nothing is picked.
    if (!space) { space = true; view.classList.add("hand"); clearHover(); }
    return;
  }
  // Undo/redo of the document (text fields returned above and keep their own). In the app the Edit menu owns
  // these keys: it knows whether a native text field has focus, and one dispatcher means one step per press.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.code === "KeyZ" || (e.ctrlKey && e.code === "KeyY"))) {
    if (native) return;
    e.preventDefault();
    historyStep(e.shiftKey || e.code === "KeyY" ? "redo" : "undo");
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
    e.preventDefault();
    endTween(true);
    const z = e.key === "0" ? 1 : Math.min(MAX_ZOOM, Math.max(0.02, cam.z * (e.key === "-" ? 0.8 : 1.25)));
    const cx = view.clientWidth / 2, cy = view.clientHeight / 2;
    cam = { z, x: cx - (cx - cam.x) * (z / cam.z), y: cy - (cy - cam.y) * (z / cam.z) };
    applyCam();
  }
  // Zoom keys (zoomKey in /page/shortcuts-logic.js): Shift+1 fits the page, Shift+2 the selection, Shift+0 is
  // 100%. Bare digits are opacity (/page/shortcuts.js) and never zoom; F does nothing here (kept free for a frame tool).
  const zk = zoomKeyOf ? zoomKeyOf(e) : null;
  if (zk) {
    e.preventDefault();
    if (zk === "fitAll") fitAll();
    else if (zk === "fitSelection") fitSelectionOrPage();
    else document.getElementById("z100").onclick();
  }
  // Esc cancels a move, else deselects, nested layers too (the common convention; Shift+Return or \ selects the parent).
  // The canvas used the key: preventDefault keeps the browser's own Esc (stop loading) away.
  if (e.key === "Escape") { if (mv) { endMove(true); return; } if (host.marqueeActive && host.marqueeActive()) return; e.preventDefault(); deselect(); }
  // Arrow keys nudge the selection: 1 px, Shift for the big nudge (settings). Text fields returned above.
  if (sel && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.startsWith("Arrow")) {
    const s = e.shiftKey ? snapCfg.bigNudge : 1;
    const dx = e.key === "ArrowLeft" ? -s : e.key === "ArrowRight" ? s : 0, dy = e.key === "ArrowUp" ? -s : e.key === "ArrowDown" ? s : 0;
    if (dx || dy) { e.preventDefault(); nudge(dx, dy); }
  }
});
const MAX_ZOOM = 256; // 25600%, the limit (the engine clamps the camera there too)
let zoomKeyOf = null; // zoomKey from /page/shortcuts-logic.js, once loaded
import("/page/shortcuts-logic.js").then((m) => { zoomKeyOf = m.zoomKey; }).catch((err) => console.warn("[canvas] zoom keys", err));
/** The fit button and Shift+2: the selection if there is one (Shift+2), else the whole page (Shift+1). */
function fitSelectionOrPage(o) {
  const r = multi ? unionRect(multi.map((id) => worldRectOf(id))) : sel ? worldRectOf(sel.id) : null;
  r ? fitRect(r, undefined, undefined, o) : fitAll(o);
}
/** Fit every board and card on the active page (Shift+1). */
function fitAll(o) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (r) => { if (!r) return; x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); };
  for (const m of pageMetas()) {
    const b = boards.get(m.id);
    if (b) add(boxOf(b));
  }
  for (const w of host.widgetsShown ? host.widgetsShown() : []) add(host.widgetRect ? host.widgetRect("widget:" + w.id) || w : w);
  if (x0 === Infinity) return;
  fitRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 70, 1, o);
}
const endHand = () => { if (!space) return; space = false; view.classList.remove("hand"); queueHover(); };
addEventListener("keyup", (e) => { if (e.code === "Space") { if (space || spaceKept) e.preventDefault(); setKeepParent(false); spaceKept = false; endHand(); } });
addEventListener("blur", () => { setKeepParent(false); spaceKept = false; endHand(); });
document.getElementById("fit").onclick = () => fitSelectionOrPage();
document.getElementById("z100").onclick = () => { endTween(true); const cx = view.clientWidth / 2, cy = view.clientHeight / 2; cam = { z: 1, x: cx - (cx - cam.x) / cam.z, y: cy - (cy - cam.y) / cam.z }; applyCam(); };
// ---------- files + live ----------
const filesSel = document.getElementById("files");
const loadFiles = (tries = 30) => fetch("/api/files").then((r) => r.json()).then((files) => {
  if (!files.length) { if (tries > 0) setTimeout(() => loadFiles(tries - 1), 500); return; }
  for (const f of files) { const o = el("option", "", f.name); o.value = f.file; filesSel.append(o); }
  if (file) filesSel.value = file;
  if (native) post({ file, files: files.map((f) => ({ name: f.name, file: f.file })) });
});
loadFiles();
filesSel.onchange = () => { location.href = "/?file=" + encodeURIComponent(filesSel.value); };
// The native shell records the file so the next launch reopens it; a plain browser ignores this.
const postFile = () => { if (file && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.canvasFile) window.webkit.messageHandlers.canvasFile.postMessage(file); };
postFile();
const msg = document.getElementById("msg");
const say = (t) => { msg.textContent = t; msg.style.display = "block"; setTimeout(() => { msg.style.display = "none"; }, 4000); };
// A page module (or one it imports) that fails to load kills every feature it carries while the page looks normal.
// Say so, once, in the console and as a toast, instead of failing without a word.
let moduleFailed = false;
window.addEventListener("error", (e) => {
  const t = e.target;
  if (!t || t.tagName !== "SCRIPT" || moduleFailed) return;
  moduleFailed = true;
  const name = String(t.src || "").replace(/^.*\\/page\\//, "");
  console.error("[canvas] page module failed to load: " + name);
  const text = "Part of Canvas failed to load (" + name + "). Reload the window or restart Canvas.";
  if (native) post({ toast: text }); else { msg.textContent = text; msg.style.display = "block"; }
}, true);
if (!file) { say("Pick a file from the top-left menu."); }
// The document stream. In the app a hidden tab closes it (canvasCmd "tab"): WebKit allows six connections per host,
// and every tab kept alive would hold two. Shown again, it reconnects with the revision it has; the server answers
// with the whole document only when that changed, so nothing the tab missed stays on screen.
function docStream() {
  const listeners = [];
  let src = null, onerr = null;
  const s = {
    addEventListener(n, f) { listeners.push([n, f]); if (src) src.addEventListener(n, f); },
    set onerror(f) { onerr = f; if (src) src.onerror = f; },
    get open() { return !!src; },
    connect() {
      if (src) return;
      src = new EventSource(api("/events") + (doc && doc.revision ? "&since=" + encodeURIComponent(doc.revision) : ""));
      for (const [n, f] of listeners) src.addEventListener(n, f);
      if (onerr) src.onerror = onerr;
    },
    close() { if (src) { src.close(); src = null; } },
  };
  return s;
}
const es = docStream();
const onDoc = (d) => {
  // The first document waits for the pages (they follow on the same stream) so no other page's board loads.
  if (!pagesReady) {
    pendingDoc = d;
    if (!pagesTimer) pagesTimer = setTimeout(pagesArrived, 800);
    return;
  }
  const first = !doc;
  setDoc(d);
  if (first) perfAt("doc");
  if (sel && !isW(sel.id)) select(sel.id, true); // properties stay current when the agent edits the selected node
  if (first && !restoredCam && native) setTimeout(() => { if (!restoredCam) fitAll({ instant: true }); }, 250); // insets arrive just after load
};
function pagesArrived() {
  if (pagesReady) return;
  pagesReady = true;
  clearTimeout(pagesTimer);
  if (pendingDoc) { const d = pendingDoc; pendingDoc = null; onDoc(d); }
}
es.addEventListener("pages", (e) => {
  let d;
  try { d = JSON.parse(e.data); } catch { return; }
  pagesStored = Array.isArray(d.pages) ? d.pages : [];
  if (!pagesReady) pagesArrived();
  else if (doc) { setDoc(doc); host.emit("page", activePage); }
});
const resolvePages = ${resolvePages};
const loadBox = ${loadBox};
const isComponentish = ${isComponentish};
// The first event on a connection (and after a reconnect) is the whole document; later ones are diffs against the last revision.
let docGen = 0; // bumped by every document the stream installs, so a recovery fetch it overtook is dropped
es.addEventListener("doc", (e) => { docGen++; onDoc(JSON.parse(e.data)); });
// Back on a stream with the document unchanged: the shell hears it again (it may have shown another tab meanwhile).
es.addEventListener("docsame", () => { if (doc && native) post({ file, doc: docMsg(), pages: pagesMsg() }); });
const applyDocDiff = ${applyDocDiff};
es.addEventListener("docdiff", (e) => {
  const d = applyDocDiff(doc, JSON.parse(e.data));
  if (d) { docGen++; onDoc(d); return; }
  // Missed a revision: ask for the whole thing. A newer document that arrives first (the stream's full "doc", a
  // later fetch) wins: an answer that comes back after it would roll the canvas back.
  const g = ++docGen;
  fetch(api("/api/doc")).then((r) => r.json()).then((full) => { if (g === docGen) onDoc(full); }).catch(() => {});
});
host.es = es;
// widgets.js is a deferred module; keep what the stream says before it starts listening.
for (const n of ["hello", "widgets", "wdata"]) es.addEventListener(n, (e) => { if (host.early) host.early.push([n, e.data]); });
es.onerror = () => {};
es.connect();
let tabShown = true;
function setTabShown(on) {
  if (on === tabShown) return;
  tabShown = on;
  if (on) { es.connect(); requestFlush(false); scheduleVisible(); } else es.close();
  host.emit("tab", on);
}
readViewBox();
if (mode === "pending") startEngine(); else announceRenderer();
window.canvasCmd = (c) => {
  // Fit and zoom commands carry the shell's current insets: a fit never uses a stale or missing free area.
  if (c.insets && typeof c.insets.l === "number") { insets = { l: c.insets.l, t: c.insets.t, r: c.insets.r, b: c.insets.b }; VW = view.clientWidth; VH = view.clientHeight; readViewBox(); }
  if (c.cmd === "mods") { shellCmd = !!c.meta; cmdHeld = shellCmd; if (c.alt !== undefined) altHeld = !!c.alt; return; }
  // The app shows or hides this page's tab (one web view per tab, apps/macos/Model.swift).
  if (c.cmd === "tab") { setTabShown(!!c.active); return; }
  if (c.cmd === "resync") { resync(); return; }
  if (c.cmd === "fit") c.id ? fit(c.id) : fitSelectionOrPage();
  else if (c.cmd === "fitAll") fitAll();
  else if (c.cmd === "fly") flyToBoard(c.id);
  else if (c.cmd === "page") switchPage(c.id, true);
  else if (c.cmd === "zoom") {
    endTween(true);
    const cx = insets.l + (view.clientWidth - insets.l - insets.r) / 2, cy = insets.t + (view.clientHeight - insets.t - insets.b) / 2;
    const z = Math.min(MAX_ZOOM, Math.max(0.02, c.to !== undefined ? c.to : cam.z * c.by));
    cam = { z, x: cx - (cx - cam.x) * (z / cam.z), y: cy - (cy - cam.y) * (z / cam.z) };
    applyCam();
  } else if (c.cmd === "select") select(c.id);
  else if (c.cmd === "deselect") deselect();
  else if (c.cmd === "insets") { insets = { l: c.l, t: c.t, r: c.r, b: c.b }; VW = view.clientWidth; VH = view.clientHeight; readViewBox(); sizeGuides(); }
  else if (c.cmd === "zoomCorner") {
    // Keep geometry on the root even when the comments module has not loaded yet.
    const shown = Number.isFinite(c.left) && c.left > 0 && Number.isFinite(c.bottom) && c.bottom > 0;
    const style = document.documentElement.style;
    style.setProperty("--cm-hint-right", shown ? "calc(100% - " + c.left + "px + var(--c-island-gap))" : "var(--c-inset)");
    style.setProperty("--cm-hint-bottom", shown ? "calc(100% - " + c.bottom + "px)" : "var(--c-inset)");
  }
  else if (c.cmd === "snap") setSnap(c, false);
  else if (c.cmd === "prefs") setPrefs(c.prefs);
  else if (c.cmd === "snapshots") snapshotsCmd(c.op);
  else if (c.cmd === "renameBoard") { const b = boards.get(c.id); if (b) renameBoard(b); }
  else if (c.cmd === "undoIf") host.undoIf(c.label);
  else if (c.cmd === "undo" || c.cmd === "redo") {
    // From the app's Edit menu. Text being edited on the canvas steps through its own typing (/page/text-edit.js);
    // with the web view focused on another page text field, that field's own undo runs.
    const a = document.activeElement;
    if (host.textEdit && host.textEdit.active) host.textEdit.step(c.cmd);
    else if (c.web && a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) document.execCommand(c.cmd);
    else historyStep(c.cmd);
  }
  else host.emit("cmd", c);
};
// The app shows this tab again: everything its chrome shows from this page, said once more.
function resync() {
  if (!native) return;
  if (doc) post({ file, doc: docMsg(), pages: pagesMsg(), history: { undo: history.undo, redo: history.redo, repeat: history.repeat ? history.repeat.label : null }, selBoard: selBoard ? selBoard.meta.id : null });
  postedPct = -1; postZoom();
  if (multi) showMulti(multi); else if (sel) select(sel.id, true); else post({ selection: null });
  post({ snapHello: true });
  host.emit("resync");
}
// ---------- undo / redo ----------
// The history lives on the server (src/history.ts), per document; this page only asks for a step and shows refusals.
let history = { undo: null, redo: null };
host.history = () => history;
// Toasts with buttons (Undo): the app draws them ({toast, toastActions}) and sends a click back as {cmd: "toastAction",
// id}; a browser shows them in #msg. Only the newest toast's buttons answer.
const toastRuns = new Map();
let toastN = 0, msgT = 0;
host.toast = (text, o = {}) => {
  toastRuns.clear();
  const acts = (o.actions || []).map((a) => { const id = "t" + ++toastN; toastRuns.set(id, a.run); return { id, label: a.label }; });
  if (native) { post({ toast: text, ...(o.icon ? { toastIcon: o.icon } : {}), ...(acts.length ? { toastActions: acts } : {}) }); return; }
  msg.textContent = "";
  msg.append(document.createTextNode(text));
  for (const a of acts) {
    const b = document.createElement("button");
    b.textContent = a.label;
    b.style.cssText = "margin-left:10px;border:0;border-radius:999px;padding:2px 10px;background:var(--c-muted);color:inherit;font:inherit;font-weight:600;cursor:pointer";
    b.onclick = () => { msg.style.display = "none"; const f = toastRuns.get(a.id); toastRuns.clear(); if (f) f(); };
    msg.append(b);
  }
  msg.style.display = "block";
  clearTimeout(msgT);
  msgT = setTimeout(() => { msg.style.display = "none"; }, acts.length ? 6000 : 4000);
};
host.on("cmd", (c) => { if (c && c.cmd === "toastAction") { const f = toastRuns.get(c.id); toastRuns.clear(); if (f) f(); } });
// Undo from a toast (Deleted Home, Deleted page): only while that step is still the one Undo would take.
host.undoIf = (label) => {
  if (history.undo === label) { historyStep("undo"); return true; }
  host.toast("Other edits came after it. Use Edit > Undo to step back to it.");
  return false;
};
es.addEventListener("saveproblem", (e) => {
  let p;
  try { p = JSON.parse(e.data); } catch { return; }
  if (p && p.message) { if (native) post({ toast: p.message }); else say(p.message); }
});
es.addEventListener("history", (e) => {
  let h;
  try { h = JSON.parse(e.data); } catch { return; }
  history = h;
  // Edit > Repeat's title ("Repeat Fill Change") comes with it (src/repeat.ts).
  if (native) post({ history: { undo: h.undo, redo: h.redo, repeat: h.repeat ? h.repeat.label : null } });
});
// An Undo or Redo of a change on another page shows that page first, then selects what changed. Only what is
// on the page shown is selected: a layer selected but drawn nowhere would take Delete and the arrow keys.
async function showStep(ids, owners) {
  const pageOf = (id) => {
    if (isW(id)) return host.widgetPageOf ? host.widgetPageOf(id.slice(7)) : null;
    const b = owners[id];
    return b ? host.pageOfBoard(b) || (pageList[0] && pageList[0].id) : null;
  };
  const target = ids.map(pageOf).find((p) => p) || null;
  if (target && target !== activePage) {
    pageSel.delete(target); // the step's selection, not the one the page had when the person left it
    await switchPage(target, true);
  }
  const here = ids.filter((id) => { const p = pageOf(id); return !p || p === activePage; });
  if (here.length) setSelection(here); else deselect();
}
// Presses are not dropped while one is in flight: the server runs them one after another.
function historyStep(dir, plain) {
  if (!file) return;
  if (host.autolayout) host.autolayout.cancelDrag(); // a reorder drag held during Undo lets go first
  if (nudgesPending()) { nudgeWaiters.push(() => historyStep(dir, plain)); return; }
  // The step is drawn now from the history event's peek at it (/page/live.js); the server refuses with "moved"
  // when another step got on top first, and the press goes again the plain way.
  const live = !plain && host.live ? host.live.historyStart(dir, history) : null;
  fetch(api("/api/history/" + dir) + (live && live.expect ? "&expect=" + live.expect : ""), { method: "POST", headers: { "x-canvas": "1" } })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      if (live) live.done(ok);
      if (!ok && j.code === "moved") { historyStep(dir, true); return; }
      // Undo and Redo bring back the selection each step had: the layers the step touched that are there now (src/history.ts).
      if (ok && !j.skipped && Array.isArray(j.select)) showStep(j.select, j.boards || {});
      const text = !ok ? (j.code === "empty" ? "" : j.error || "Could not " + dir) : j.skipped ? "Skipped " + j.label : "";
      if (text) { if (native) post({ toast: text }); else say(text); }
    })
    .catch(() => { if (live) live.done(false); });
}
})();
</script>
<script>${PAGE_BRIDGE_JS}</script>
<script type="module" src="/page/widgets.js"></script>
<script type="module" src="/page/drops.js"></script>
<script type="module" src="/page/shaders.js"></script>
<script type="module" src="/page/videos.js"></script>
<script type="module" src="/page/context.js"></script>
<script type="module" src="/page/structure.js"></script>
<script type="module" src="/page/autolayout.js"></script>
<script type="module" src="/page/smart.js"></script>
<script type="module" src="/page/radius.js"></script>
<script type="module" src="/page/image-crop.js"></script>
<script type="module" src="/page/reparent.js"></script>
<script type="module" src="/page/group-resize.js"></script>
<script type="module" src="/page/rotate.js"></script>
<script type="module" src="/page/live.js"></script>
<script type="module" src="/page/text-edit.js"></script>
<script type="module" src="/page/shortcuts.js"></script>
<script type="module" src="/page/keybox.js"></script>
<script type="module" src="/page/layers.js"></script>
<script type="module" src="/page/palette.js"></script>
<script type="module" src="/page/link.js"></script>
<script type="module" src="/page/copy-as.js"></script>
<script type="module" src="/page/navigate.js"></script>
<script type="module" src="/page/find-replace.js"></script>
<script type="module" src="/page/spark.js"></script>
<script type="module" src="/page/variations.js"></script>
<script type="module" src="/page/agent-cursor.js"></script>
<script type="module" src="/page/comments.js"></script>
</body>
</html>`;
