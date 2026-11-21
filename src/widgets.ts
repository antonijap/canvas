import { bodyChunks } from "./body.ts";
// Widgets on the canvas: todo lists, notes and live numbers that sit beside the boards. Their
// definitions live in a sidecar (widgets.json in the package, or foo.widgets.json next to foo.canvas.json); live values are fetched here,
// never stored, and pushed to open pages over the same /events stream as document changes.
// The functions below the HTTP section are the same ones an MCP server can call directly.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardsOf } from "./boards.ts";
import { loadDoc, resolveDocPath, type CanvasDoc } from "./engine.ts";
import { pageName } from "./page/widget-page.js";
import { pathExists } from "./docpath.ts";
import { redact } from "./widgets/ctx.ts";
import { clearSecret, hasSecret, parseRef } from "./widgets/keychain.ts";
import { syncPageName } from "./widgets/kinds/note.ts";
import { readLocalWidget } from "./widgets/local.ts";
import { Poller } from "./widgets/poller.ts";
import { ID_RE, kindList, kindOf, mergeConfig } from "./widgets/registry.ts";
import { cleanPages, resolvePages, type ResolvedPages } from "./pages.ts";
import { BOARD_GAP, clearCardSpot, obstacles, type Rect } from "./placement.ts";
import { GROUP_MERGE_MS, isGroupMerge } from "./move.ts";
import { storeFor, type Store, type StoreState, type WriteOpts } from "./widgets/store.ts";
import { approve, approveLocalWidget, approveSource, isLocalWidgetApproved, isSourceApproved } from "./widgets/trust.ts";
import { WidgetError, type Config, type Reading, type Widget } from "./widgets/types.ts";
import { countUsage } from "./usage-counts.ts";

export { WidgetError } from "./widgets/types.ts";
export type { Reading, Widget } from "./widgets/types.ts";

// ---------- state ----------

/** One page connection to /events. */
type Sse = { res: http.ServerResponse; clientId: string };
const sse = new Map<string, Set<Sse>>(); // by design file path
const wired = new Set<string>();

const send = (c: Sse, event: string, data: unknown) => c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const widgetsPayload = (s: StoreState) => ({ rev: s.rev, ...(s.warning ? { warning: s.warning } : {}), widgets: s.widgets });
/** The stored pages as written (the page resolves them against its own board list). */
const pagesPayload = (s: StoreState) => ({ rev: s.rev, pages: cleanPages(s.extra.pages) });

const poller = new Poller({
  widgetsOf: (file) => storeFor(file).snapshot().widgets,
  hold: (file) => storeFor(file).retain(),
  emit: (file, batch) => {
    for (const c of sse.get(file) ?? []) send(c, "wdata", batch);
  },
});

/** Every file the widgets code touches gets one change hook: tell open pages, re-plan the polling. */
function store(file: string): Store {
  const s = storeFor(file);
  if (!wired.has(file)) {
    wired.add(file);
    let lastPages = JSON.stringify(pagesPayload(s.peek()).pages);
    s.onChange((state) => {
      for (const c of sse.get(file) ?? []) send(c, "widgets", widgetsPayload(state));
      const pages = pagesPayload(state);
      const key = JSON.stringify(pages.pages);
      if (key !== lastPages) {
        lastPages = key;
        for (const c of sse.get(file) ?? []) send(c, "pages", pages);
      }
      poller.reconcile(file);
    });
  }
  return s;
}

/** The design file a request names, which must exist (the sidecar is created on first add, the design file never is). */
export function docFileFor(file: unknown): string {
  if (typeof file !== "string" || !file) throw new WidgetError(400, "file-required", "file is required");
  let p: string;
  try {
    p = resolveDocPath(file);
  } catch (e) {
    throw new WidgetError(404, "no-file", (e as Error).message);
  }
  if (!pathExists(p)) throw new WidgetError(404, "no-file", `No such file: ${p}`);
  return p;
}

// ---------- facade (HTTP and MCP both call these) ----------

export type WidgetInput = { kind: string; name?: string; x?: number; y?: number; w?: number; h?: number; locked?: boolean; config?: Config; id?: string; index?: number; page?: string; allowOverlap?: boolean; rects?: Record<string, Rect> };
/** `page: null` puts the widget back on the first page. */
export type WidgetPatch = { name?: string; x?: number; y?: number; w?: number; h?: number; locked?: boolean; config?: Config; page?: string | null };
type Opts = WriteOpts;

const newId = () => "w_" + [...randomBytes(8)].map((b) => (b % 36).toString(36)).join("");

export function listWidgets(file: string) {
  const p = docFileFor(file);
  const s = store(p).snapshot();
  return { ...widgetsPayload(s), data: poller.readings(p) };
}

export function getWidget(file: string, id: string) {
  const p = docFileFor(file);
  const s = store(p).snapshot();
  const widget = s.widgets.find((w) => w.id === id);
  if (!widget) throw new WidgetError(404, "no-widget", `No widget "${id}"`);
  return { rev: s.rev, widget, data: poller.readings(p)[id] };
}

export function kinds(picker = false) {
  return kindList().filter((k) => !k.hidden).map((k) => ({
    id: k.id, title: k.title, description: k.description, picker: k.picker, live: !!k.source, symbol: k.symbol,
    defaultSize: k.defaultSize, minSize: k.minSize, fields: k.fields, defaults: k.defaults(),
    actions: Object.keys(k.actions ?? {}),
    ...(k.local ? { local: true } : {}),
    ...(picker && k.local ? { bundle: k.local.hash, previewHTML: k.local.previewHTML, approved: isLocalWidgetApproved(k.id, k.local.hash) } : {}),
  }));
}

/** Where placement reads the boards from. The server swaps in its snapshot cache; the default reads the file. */
export const widgetHooks: { docOf: (docFile: string) => CanvasDoc } = { docOf: (docFile) => loadDoc(docFile).doc };

/** Legacy fallback for a pasted card without a position. */
function autoPlace(docFile: string, existing: Widget[], size: { w: number; h: number }): { x: number; y: number } {
  let right = 0;
  let top = 0;
  try {
    const boards = boardsOf(widgetHooks.docOf(docFile));
    if (boards.length) {
      right = Math.max(...boards.map((b) => b.x + (b.width ?? 400))) + 80;
      top = Math.min(...boards.map((b) => b.y));
    }
  } catch {
    // An unreadable .canvas.json still gets widgets: they start at the origin.
  }
  let y = top;
  for (;;) {
    const hit = existing.find((w) => w.x < right + size.w && w.x + w.w > right && w.y < y + size.h && w.y + w.h > y);
    if (!hit) return { x: right, y };
    y = hit.y + hit.h + 24;
  }
}

function cardPosition(file: string, input: WidgetInput, size: { w: number; h: number }, list: Widget[], pages: unknown) {
  const { x, y } = input;
  const exact = input.allowOverlap === true || (input.id !== undefined && input.index !== undefined);
  if (x !== undefined && y !== undefined && exact) return { x, y };

  let children: CanvasDoc["children"] = [];
  try { children = widgetHooks.docOf(file).children; } catch { /* An unreadable document can still hold cards. */ }
  const { pages: resolved }: ResolvedPages = resolvePages(pages, children.map((n) => String(n.id)));
  const byId = new Map(resolved.map((p) => [p.id, p]));
  const pageOf = (id: unknown) => (typeof id === "string" ? byId.get(id) : undefined) ?? resolved[0];
  const page = pageOf(input.page);
  const measured = (id: string) => {
    const r = input.rects?.[id];
    return r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w >= 0 && r.h >= 0 ? r : undefined;
  };
  const rects: Record<string, Rect> = Object.fromEntries(page.boards.flatMap((id) => {
    const r = measured(id);
    return r ? [[id, r]] : [];
  }));
  const boards = obstacles({ children }, new Set(), new Set(page.boards), rects);
  const cards = list.filter((w) => pageOf(w.page) === page).map((w) => measured("widget:" + w.id) ?? w);
  const others = [...boards, ...cards];
  const want = {
    x: x ?? (others.length ? Math.max(...others.map((r) => r.x + r.w)) + BOARD_GAP : 0),
    y: y ?? (boards.length ? Math.min(...boards.map((r) => r.y)) : 0),
    ...size,
  };
  return exact ? want : clearCardSpot(want, others);
}

export async function addWidget(file: string, input: WidgetInput, opts: Opts = {}) {
  const p = docFileFor(file);
  const k = kindOf(String(input?.kind));
  if (!k) throw new WidgetError(422, "unknown-kind", `Unknown widget kind "${String(input?.kind)}". Known: ${kindList().map((x) => x.id).join(", ")}`);
  if (input.id !== undefined && (typeof input.id !== "string" || !ID_RE.test(input.id))) throw new WidgetError(422, "invalid-widget", "id must be 1-40 letters, digits, - or _");
  if (input.config !== undefined && (typeof input.config !== "object" || input.config === null || Array.isArray(input.config))) throw new WidgetError(422, "invalid-widget", "config must be an object");
  const { state, result } = await store(p).mutateEnvelope<Widget>((list, extra) => {
    const size = { w: input.w ?? k.defaultSize.w, h: input.h ?? k.defaultSize.h };
    const at = cardPosition(p, input, size, list, extra.pages);
    const config = k.validate(mergeConfig(k.defaults(), input.config ?? {}));
    const widget: Widget = {
      id: input.id ?? newId(),
      kind: k.id,
      name: k.id === "note" ? syncPageName(config, input.name) : input.name ?? k.title,
      x: at.x,
      y: at.y,
      w: size.w,
      h: size.h,
      locked: input.locked === true,
      config,
      ...(typeof input.page === "string" && input.page ? { page: input.page } : {}),
    };
    if (list.some((w) => w.id === widget.id)) throw new WidgetError(409, "id-exists", `A widget "${widget.id}" already exists`);
    const index = typeof input.index === "number" ? Math.max(0, Math.min(list.length, Math.trunc(input.index))) : list.length;
    list.splice(index, 0, widget);
    return { widgets: list, extra, result: widget };
  }, opts);
  countUsage(k.local ? "widget.add.local" : `widget.add.${k.id}`);
  return { rev: state.rev, widget: state.widgets.find((w) => w.id === result!.id)!, ...(k.local ? { local: true } : {}) };
}

/**
 * Several cards in one write (a paste): one undo step, all or none. An id that is taken or missing gets a fresh
 * one. The cards keep the order given, after the existing ones.
 */
export async function addWidgets(file: string, inputs: WidgetInput[], opts: Opts = {}) {
  const p = docFileFor(file);
  const { state, result } = await store(p).mutate<string[]>((list) => {
    const ids: string[] = [];
    for (const input of inputs) {
      const k = kindOf(String(input?.kind));
      const id = typeof input.id === "string" && ID_RE.test(input.id) && !list.some((w) => w.id === input.id) ? input.id : newId();
      const size = { w: input.w ?? k?.defaultSize.w ?? 240, h: input.h ?? k?.defaultSize.h ?? 160 };
      const at = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : autoPlace(p, list, size);
      // A kind Canvas no longer has keeps its config as it is (shown as an unsupported card, like on load).
      const config = k ? k.validate(mergeConfig(k.defaults(), input.config ?? {})) : { ...(input.config ?? {}) };
      list.push({ id, kind: k ? k.id : String(input.kind), name: k?.id === "note" ? pageName(String(config.text ?? "")) : input.name ?? k?.title ?? String(input.kind), x: at.x, y: at.y, w: size.w, h: size.h, locked: input.locked === true, config, ...(typeof input.page === "string" && input.page ? { page: input.page } : {}) });
      ids.push(id);
    }
    return { widgets: list, result: ids };
  }, opts);
  const ids = result ?? [];
  return { rev: state.rev, widgets: ids.map((id) => state.widgets.find((w) => w.id === id)!).filter(Boolean) };
}

/** Several cards removed in one write (a cut): one undo step. Ids that are not there are left out. */
export async function removeWidgets(file: string, ids: string[], opts: Opts = {}) {
  const p = docFileFor(file);
  const gone = new Set(ids);
  const { state } = await store(p).mutate((list) => ({ widgets: list.filter((w) => !gone.has(w.id)) }), opts);
  return { rev: state.rev };
}

export async function updateWidget(file: string, id: string, patch: WidgetPatch, opts: Opts = {}) {
  const p = docFileFor(file);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new WidgetError(400, "bad-body", "Send an object of changes");
  const { state } = await store(p).mutate((list) => {
    const w = list.find((x) => x.id === id);
    if (!w) throw new WidgetError(404, "no-widget", `No widget "${id}"`);
    const locked = patch.locked ?? w.locked;
    for (const k of ["x", "y", "w", "h"] as const) {
      if (patch[k] === undefined || patch[k] === w[k]) continue;
      if (locked) throw new WidgetError(409, "locked", "This widget is locked; unlock it to move or resize it");
      w[k] = patch[k] as number;
    }
    if (w.kind !== "note" && patch.name !== undefined) w.name = patch.name;
    if (patch.locked !== undefined) w.locked = patch.locked;
    if (patch.page === null || patch.page === "") delete w.page;
    else if (patch.page !== undefined) w.page = patch.page;
    if (patch.config !== undefined) {
      if (typeof patch.config !== "object" || patch.config === null || Array.isArray(patch.config)) throw new WidgetError(422, "invalid-widget", "config must be an object");
      w.config = mergeConfig(w.config, patch.config);
    }
    if (w.kind === "note") {
      const hasText = Object.hasOwn(patch.config ?? {}, "text");
      if (hasText || patch.name !== undefined) w.name = syncPageName(w.config, patch.name, !hasText);
      if (patch.w !== undefined && !hasText && !Object.hasOwn(patch.config ?? {}, "pageWidth")) {
        w.config.pageWidth = Math.max(280, Number(patch.w));
      }
    }
    return { widgets: list };
  }, opts);
  return { rev: state.rev, widget: state.widgets.find((w) => w.id === id)! };
}

export async function removeWidget(file: string, id: string, opts: Opts = {}) {
  const p = docFileFor(file);
  const { state, result } = await store(p).mutate<number>((list) => {
    const at = list.findIndex((w) => w.id === id);
    if (at < 0) throw new WidgetError(404, "no-widget", `No widget "${id}"`);
    list.splice(at, 1);
    return { widgets: list, result: at };
  }, opts);
  return { rev: state.rev, index: result as number };
}

export async function runWidgetAction(file: string, id: string, name: string, args: Record<string, unknown>, opts: Opts = {}) {
  const p = docFileFor(file);
  const { state, result } = await store(p).mutate<unknown>((list) => {
    const w = list.find((x) => x.id === id);
    if (!w) throw new WidgetError(404, "no-widget", `No widget "${id}"`);
    const act = Object.hasOwn(kindOf(w.kind)?.actions ?? {}, name) ? kindOf(w.kind)!.actions![name] : undefined;
    if (!act) throw new WidgetError(404, "unknown-action", `Widgets of kind "${w.kind}" have no action "${name}"`);
    const r = act(w.config, args ?? {});
    w.config = r.config;
    return { widgets: list, result: r.result };
  }, opts);
  return { rev: state.rev, widget: state.widgets.find((w) => w.id === id)!, result };
}

/** Fetch now (at most every 5 s per widget) and return the fresh reading. */
export async function refreshWidget(file: string, id: string) {
  const p = docFileFor(file);
  store(p);
  if (!store(p).snapshot().widgets.some((w) => w.id === id)) throw new WidgetError(404, "no-widget", `No widget "${id}"`);
  const r = await poller.refresh(p, id);
  if (r.retryAfterSec) throw new WidgetError(429, "throttled", `Refreshed a moment ago; try again in ${r.retryAfterSec}s`, r.retryAfterSec);
  return { data: r.reading as Reading };
}

/** A page says which widgets it is showing. Repeat within 90 s to keep the lease; an empty list ends it. */
export function setVisibility(file: string, clientId: unknown, ids: unknown) {
  const p = docFileFor(file);
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) throw new WidgetError(400, "bad-body", "clientId is required");
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((i) => typeof i !== "string")) throw new WidgetError(400, "bad-body", "ids must be a list of widget ids");
  store(p);
  poller.setInterest(p, clientId, ids as string[]);
  return { ok: true, leaseSec: 90 };
}

function approveSavedSource(w: Widget, editedConfig?: Config) {
  const rule = kindOf(w.kind)?.source?.approval;
  if (!rule || (editedConfig && !Object.hasOwn(editedConfig, rule.field))) return;
  const target = rule.target(w.config);
  if (!target) return;
  approveSource(w.kind, target);
  poller.retryBlocked();
}

/** Approve the source, local bundle or secret named by the card. */
export async function trustWidget(file: string, id: string, bundle?: unknown, fromMcp = false, target?: unknown) {
  if (fromMcp) throw new WidgetError(403, "forbidden", "Approve widgets from the canvas.");
  const p = docFileFor(file);
  const w = store(p).snapshot().widgets.find((x) => x.id === id);
  if (!w) throw new WidgetError(404, "no-widget", `No widget "${id}"`);
  const kind = kindOf(w.kind);
  if (kind?.local) {
    if (bundle !== kind.local.hash) throw new WidgetError(409, "widget-changed", "This local widget changed. Review it again.");
    approveLocalWidget(w.kind, kind.local.hash);
    poller.retryBlocked();
    return { ok: true, local: true };
  }
  const primary = kind?.source?.approval?.target(w.config);
  if (target !== undefined) {
    const pending = poller.readings(p)[id]?.approvalTarget;
    const matches = typeof target === "string" && (target === primary || (primary && isSourceApproved(w.kind, primary) && target === pending));
    if (!matches) throw new WidgetError(409, "widget-changed", "This widget changed. Review its source again.");
    approveSource(w.kind, target);
    poller.retryBlocked();
    return { ok: true, target };
  }
  if (primary && !isSourceApproved(w.kind, primary)) throw new WidgetError(409, "needs-approval", "Allow the source on the canvas first.");
  const use = kind?.source?.secretUse?.(w.config);
  if (!use) throw new WidgetError(422, "no-secret", "This widget does not send a secret");
  approve(use.ref, use.origin);
  poller.retryBlocked(p);
  return { ok: true, origin: use.origin };
}

/** The shell replaced a Keychain item: drop the cached copy so the next fetch reads the new value. */
export function secretChanged(service: unknown, account: unknown) {
  const ref = parseRef({ service, account });
  if (!ref) throw new WidgetError(400, "bad-ref", "service and account must be letters, digits and . _ @ : -");
  clearSecret(ref);
  return { ok: true };
}

export async function secretStatus(service: unknown, account: unknown) {
  const ref = parseRef({ service, account });
  if (!ref) throw new WidgetError(400, "bad-ref", "service and account must be letters, digits and . _ @ : -");
  return { present: await hasSecret(ref) };
}

// ---------- SSE ----------

/** Called by /events once the document is sent: hello, the widget list, then every reading we hold. */
export function attachWidgetClient(file: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const s = store(file);
  const client: Sse = { res, clientId: randomBytes(9).toString("base64url") };
  let set = sse.get(file);
  if (!set) sse.set(file, (set = new Set()));
  set.add(client);
  const release = s.retain();
  send(client, "hello", { clientId: client.clientId });
  send(client, "widgets", widgetsPayload(s.snapshot()));
  send(client, "pages", pagesPayload(s.peek()));
  const data = poller.readings(file);
  if (Object.keys(data).length) send(client, "wdata", data);
  req.on("close", () => {
    set!.delete(client);
    if (!set!.size) sse.delete(file);
    poller.dropClient(client.clientId);
    release();
  });
}

// ---------- HTTP ----------

const PAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "page");
/** The page file a /page/ path names, or null. Any .js or .css file in src/page is served, read from disk on each
 *  request: a fixed allowlist read at start went stale when a running server met a page module with a new import
 *  (the import 404ed and every module that needed it died without a word). The name pattern keeps it inside PAGE_DIR. */
export function pageFileName(pathname: string): string | null {
  return /^\/page\/([a-z0-9][a-z0-9-]*\.(?:js|css))$/.exec(pathname)?.[1] ?? null;
}
const BODY_MAX = 512 * 1024;

function reply(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of bodyChunks(req)) {
    size += (c as Buffer).length;
    if (size > BODY_MAX) throw new WidgetError(413, "too-large", "The request body is larger than 512 KB");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  let j: unknown;
  try {
    j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WidgetError(400, "bad-json", "The request body is not valid JSON");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new WidgetError(400, "bad-body", "The request body must be a JSON object");
  return j as Record<string, unknown>;
}

/** Undo labels for the todo actions ("Undo Add To-Do"). */
const ACTION_LABELS: Record<string, string> = { addItem: "Add To-Do", toggleItem: "Check To-Do", updateItem: "Edit To-Do", removeItem: "Delete To-Do", moveItem: "Reorder To-Dos" };
/** Which writes of a card fold into one step: a content change that also grows the card (a note) is a content change. */
function patchKeys(p: WidgetPatch): string {
  const k = Object.keys(p ?? {});
  return (k.includes("config") ? k.filter((x) => x !== "h") : k).sort().join(",");
}

function widgetPatchLabel(p: WidgetPatch): string {
  const k = Object.keys(p ?? {});
  if (k.length && k.every((x) => x === "x" || x === "y")) return "Move Widget";
  if (k.length && k.every((x) => ["x", "y", "w", "h"].includes(x))) return "Resize Widget";
  if (k.length === 1 && k[0] === "name") return "Rename Widget";
  if (k.length === 1 && k[0] === "locked") return p.locked ? "Lock Widget" : "Unlock Widget";
  if (k.length === 1 && k[0] === "page") return "Move Widget to Page";
  return "Widget Change";
}

/** Answers /api/widgets* and /page/*.js|css. Returns false for anything else so the server carries on. */
/** `onAgentEdit` hears each widget an MCP call (x-canvas-source: mcp) added or changed, for finish_work. */
export async function handleWidgetRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, onAgentEdit?: (file: string, id: string) => void): Promise<boolean> {
  const out = (status: number, body: unknown): true => {
    reply(res, status, body);
    return true;
  };
  if (url.pathname.startsWith("/page/")) {
    const name = pageFileName(url.pathname);
    if (req.method !== "GET" || !name) return out(404, { error: "not found" });
    try {
      const body = fs.readFileSync(path.join(PAGE_DIR, name));
      const type = name.endsWith(".css") ? "text/css" : "text/javascript";
      res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    } catch {
      reply(res, 404, { error: "not found" });
    }
    return true;
  }
  if (url.pathname !== "/api/widgets" && !url.pathname.startsWith("/api/widgets/")) return false;
  try {
    const parts = url.pathname.split("/").slice(3).map(decodeURIComponent); // after /api/widgets
    const m = req.method ?? "GET";
    const file = url.searchParams.get("file");
    const mutating = m !== "GET";
    if (mutating && req.headers["x-canvas"] !== "1") return out(403, { error: "forbidden", code: "forbidden" });
    const ifMatch = (req.headers["if-match"] ?? "").toString().replace(/^W\/|"/g, "") || undefined;
    const [a, b, c] = parts;
    const agent = req.headers["x-canvas-source"] === "mcp" && file;
    // What the undo history calls this write, and which writes merge (typing in a field, nudging a widget).
    const who = { source: (agent ? "mcp" : "user") as "mcp" | "user", session: String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined };
    const opts = (label?: string, mergeKey?: string): WriteOpts => ({ ifMatch, ...(label ? { record: { label, mergeKey, ...who } } : {}) });
    const edited = (id: string) => { if (agent && onAgentEdit) onAgentEdit(file, id); };

    if (!a) {
      if (m === "GET") return out(200, listWidgets(file as string));
      if (m === "POST") {
        const body = await readBody(req);
        // A card Option-dragged with layers or boards (their duplicate through /api/structure carries the same key): one undo step.
        const groupKey = req.headers["x-canvas-merge"];
        const o = isGroupMerge(groupKey) ? opts("Duplicate", groupKey) : opts("Add Widget");
        if (isGroupMerge(groupKey) && o.record) o.record.mergeMs = GROUP_MERGE_MS;
        const added = await addWidget(file as string, body as WidgetInput, o);
        if (!agent && req.headers["x-canvas-copy"] !== "1") approveSavedSource(added.widget);
        edited(added.widget.id);
        return out(201, added);
      }
    } else if (a === "kinds" && !b && m === "GET") {
      return out(200, kinds(url.searchParams.get("view") === "picker"));
    } else if (a === "local-renderer" && b && !c && m === "GET") {
      const local = kindOf(b)?.local && readLocalWidget(b);
      if (!local || url.searchParams.get("bundle") !== local.hash) return out(404, { code: "widget-changed", error: "Local widget unavailable" });
      if (!isLocalWidgetApproved(b, local.hash)) return out(403, { code: "needs-approval", error: "Approve this local widget on the canvas." });
      return out(200, { renderer: local.renderer });
    } else if (a === "secret-status" && !b && m === "GET") {
      return out(200, await secretStatus(url.searchParams.get("service"), url.searchParams.get("account")));
    } else if (a === "secret-changed" && !b && m === "POST") {
      const body = await readBody(req);
      return out(200, secretChanged(body.service, body.account));
    } else if (a === "visibility" && !b && m === "POST") {
      const body = await readBody(req);
      return out(200, setVisibility(file as string, body.clientId, body.ids));
    } else if (!b) {
      if (m === "GET") return out(200, getWidget(file as string, a));
      if (m === "PATCH") {
        const patch = (await readBody(req)) as WidgetPatch;
        // Arrow-key nudges (x-canvas-merge: nudge) fold into one step while they keep coming (src/move.ts).
        const nudge = req.headers["x-canvas-merge"] === "nudge";
        // A multi-selection moved together: its writes (POST /api/move items, then each widget) share one step.
        const groupKey = req.headers["x-canvas-merge"];
        const group = isGroupMerge(groupKey);
        const o = group ? opts(groupKey.startsWith("group:nudge") ? "Nudge" : "Move", groupKey) : nudge ? opts("Nudge", `nudge:widget:${a}`) : opts(widgetPatchLabel(patch), `widget:${a}:${patchKeys(patch)}`);
        if (nudge && o.record) o.record.mergeMs = 1000;
        if (group && o.record) o.record.mergeMs = GROUP_MERGE_MS;
        const updated = await updateWidget(file as string, a, patch, o);
        if (!agent && patch.config) approveSavedSource(updated.widget, patch.config);
        edited(a);
        return out(200, updated);
      }
      if (m === "DELETE") {
        // A mixed selection deleted at once (its layers through /api/structure with the same key): one undo step.
        const groupKey = req.headers["x-canvas-merge"];
        const o = isGroupMerge(groupKey) ? opts("Delete", groupKey) : opts("Delete Widget");
        if (isGroupMerge(groupKey) && o.record) o.record.mergeMs = GROUP_MERGE_MS;
        return out(200, await removeWidget(file as string, a, o));
      }
    } else if (b === "actions" && c && m === "POST") {
      const args = await readBody(req);
      const acted = await runWidgetAction(file as string, a, c, args, opts(ACTION_LABELS[c] ?? "Widget Change", `widget:${a}:action:${c}:${typeof args.id === "string" ? args.id : ""}`));
      edited(a);
      return out(200, acted);
    } else if (b === "refresh" && !c && m === "POST") {
      return out(200, await refreshWidget(file as string, a));
    } else if (b === "trust" && !c && m === "POST") {
      const body = await readBody(req);
      return out(200, await trustWidget(file as string, a, body.bundle, !!agent, body.target));
    }
    reply(res, 404, { error: "not found", code: "not-found" });
  } catch (e) {
    if (e instanceof WidgetError) {
      reply(res, e.status || 500, { error: redact(e.message), code: e.code, ...(e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {}) }, e.retryAfterSec ? { "retry-after": String(e.retryAfterSec) } : {});
    } else reply(res, 500, { error: redact((e as Error).message) });
  }
  return true;
}
