import { bodyChunks } from "./body.ts";
// Pages: named groups of boards. The design file has no pages, so they are Canvas metadata and live
// in the same envelope as the widgets (widgets.json in a package, foo.widgets.json beside a single foo.canvas.json), as
// `pages: [{id, name, boards: [board ids]}]`, written through the same store mutation queue.
// Rules: array order is page order; a board belongs to at most one page (the first that lists it); boards
// no page lists show on the first page (the default page); ids the document no longer has stay in the file,
// ignored on display, until someone reassigns them; at least one page always exists. A file without
// `pages` has one implicit page holding every board. Which page a viewer looks at is theirs (with the
// camera, in the page's localStorage), never stored here.

import { asOneAction } from "./cloud-files-ops.ts";
import { isCloudFile } from "./cloud-files-runtime.ts";
import { randomBytes } from "node:crypto";
import type http from "node:http";
import { relabelTop } from "./history.ts";
import { docFileFor } from "./widgets.ts";
import { storeFor, type WriteOpts } from "./widgets/store.ts";
import { WidgetError, type Widget } from "./widgets/types.ts";

export type Page = { id: string; name: string; boards: string[]; background?: string };
export type ResolvedPages = { pages: Page[]; implicit: boolean };

export const IMPLICIT_PAGE: Readonly<Page> = { id: "page-1", name: "Page 1", boards: [] };
const PAGE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_PAGES = 200;
const MAX_NAME = 120;

/**
 * The pages as shown for a document whose boards are `boardIds` (in document order). Each page lists the
 * boards it holds in document order; unlisted boards go to the first page; unknown ids are dropped.
 * Plain JS under its annotations: the page script embeds this function's source, like applyDocDiff.
 */
export function resolvePages(stored: any, boardIds: any): any {
  const list: any[] = [];
  const seen = new Set();
  const owner = new Map();
  for (const p of Array.isArray(stored) ? stored : []) {
    if (!p || typeof p.id !== "string" || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    const page = { id: p.id, name: typeof p.name === "string" && p.name ? p.name : p.id, boards: [] as string[], ...(typeof p.background === "string" && /^#[0-9a-f]{6}$/i.test(p.background) ? { background: p.background.toUpperCase() } : {}) };
    for (const b of Array.isArray(p.boards) ? p.boards : []) if (typeof b === "string" && !owner.has(b)) owner.set(b, p.id);
    list.push(page);
  }
  const implicit = !list.length;
  if (implicit) list.push({ id: "page-1", name: "Page 1", boards: [] });
  const byId = new Map(list.map((p) => [p.id, p]));
  for (const id of boardIds) (byId.get(owner.get(id)) || list[0]).boards.push(id);
  return { pages: list, implicit };
}

/** The stored list as it should be written: valid entries only, unique page ids, each board once (first wins). Unknown board ids are kept. */
export function cleanPages(stored: unknown): Page[] {
  const out: Page[] = [];
  const seen = new Set<string>();
  const owned = new Set<string>();
  for (const p of Array.isArray(stored) ? stored : []) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    const boards: string[] = [];
    for (const b of Array.isArray(p.boards) ? p.boards : []) if (typeof b === "string" && b && !owned.has(b)) { owned.add(b); boards.push(b); }
    out.push({ id: p.id, name: typeof p.name === "string" && p.name ? p.name : p.id, boards, ...(typeof p.background === "string" && /^#[0-9a-f]{6}$/i.test(p.background) ? { background: p.background.toUpperCase() } : {}) });
  }
  return out;
}

/** Check a full list someone sent (PUT). Throws WidgetError 422 with what is wrong. */
export function validatePages(v: unknown): Page[] {
  const bad = (m: string) => new WidgetError(422, "invalid-pages", m);
  if (!Array.isArray(v) || !v.length) throw bad("pages must be a list of at least one page");
  if (v.length > MAX_PAGES) throw bad(`at most ${MAX_PAGES} pages`);
  const ids = new Set<string>();
  for (const [i, p] of v.entries()) {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw bad(`pages[${i}] must be an object`);
    if (typeof p.id !== "string" || !PAGE_ID.test(p.id)) throw bad(`pages[${i}].id must be 1-40 letters, digits, - or _`);
    if (ids.has(p.id)) throw bad(`two pages share the id "${p.id}"`);
    ids.add(p.id);
    if (p.background !== undefined && p.background !== null && (typeof p.background !== "string" || !/^#[0-9a-f]{6}$/i.test(p.background))) throw bad(`pages[${i}].background must be #RRGGBB or null`);
    nameOf(p.name, `pages[${i}].name`);
    if (!Array.isArray(p.boards) || p.boards.some((b: unknown) => typeof b !== "string" || !b || b.length > 200)) throw bad(`pages[${i}].boards must be a list of board ids`);
  }
  return cleanPages(v);
}

function nameOf(v: unknown, what = "name"): string {
  if (typeof v !== "string" || !v.trim() || v.length > MAX_NAME) throw new WidgetError(422, "invalid-pages", `${what} must be text of 1 to ${MAX_NAME} characters`);
  return v.trim();
}

const newId = () => "pg_" + [...randomBytes(8)].map((b) => (b % 36).toString(36)).join("");
const storedOf = (extra: Record<string, unknown>): Page[] => cleanPages(extra.pages);

// ---------- facade (HTTP and MCP both go through these) ----------

/** The document's top-level board ids, in order. The server passes its snapshot cache. */
export type BoardIds = (docFile: string) => string[];

export type PagesView = { rev: string; implicit: boolean; pages: (Page & { default?: true })[]; unknownBoards?: string[] };

function view(rev: string, stored: Page[], boardIds: string[]): PagesView {
  const r = resolvePages(stored, boardIds) as ResolvedPages;
  const have = new Set(boardIds);
  const unknown = stored.flatMap((p) => p.boards.filter((b) => !have.has(b)));
  return { rev, implicit: r.implicit, pages: r.pages.map((p, i) => (i === 0 ? { ...p, default: true as const } : p)), ...(unknown.length ? { unknownBoards: unknown } : {}) };
}

export function listPages(file: string, boardIds: BoardIds): PagesView {
  const docFile = docFileFor(file);
  const s = storeFor(docFile).snapshot();
  return view(s.rev, storedOf(s.extra), boardIds(docFile));
}

type Opts = WriteOpts;

/** One change to the stored pages (and, for a delete, the widgets on it), under the store's lock. */
async function change<T>(file: string, boardIds: BoardIds, opts: Opts, fn: (pages: Page[], widgets: Widget[], boards: string[]) => T): Promise<PagesView & { result: T }> {
  const docFile = docFileFor(file);
  const boards = boardIds(docFile);
  const { state, result } = await storeFor(docFile).mutateEnvelope<T>((widgets, extra) => {
    // A file without pages gets its implicit page written out on the first change, listing today's boards, so
    // reordering pages later does not carry them along to whichever page comes first.
    const pages = storedOf(extra);
    if (!pages.length) pages.push({ ...IMPLICIT_PAGE, boards: [...boards] });
    const firstBefore = pages[0].id;
    // Only widgets that were on the first page implicitly before the change follow the rule below; one that fn
    // itself made implicit (moved to the new first page) is where fn wanted it.
    const implicitBefore = new Set(widgets.filter((w) => typeof w.page !== "string" || !w.page).map((w) => w.id));
    const result = fn(pages, widgets, boards);
    keepImplicitOwners(pages, widgets, boards, firstBefore, implicitBefore);
    return { widgets, extra: { ...extra, pages: cleanPages(pages) }, result };
  }, opts);
  return { ...view(state.rev, storedOf(state.extra), boards), result: result as T };
}

/**
 * Widgets without a `page` and boards no page lists belong to the first page implicitly. When a change puts a
 * different page first (reorder, insert at 0), they would silently follow the new first page: write their old
 * page out explicitly instead. Widgets that now name the first page go back to implicit, like everywhere else.
 */
function keepImplicitOwners(pages: Page[], widgets: Widget[], boards: string[], firstBefore: string, implicitBefore: Set<string>): void {
  const first = pages[0]?.id;
  const old = pages.find((p) => p.id === firstBefore);
  if (!first || !old || first === firstBefore) return;
  for (const w of widgets) if ((typeof w.page !== "string" || !w.page) && implicitBefore.has(w.id)) w.page = firstBefore;
  const listed = new Set(pages.flatMap((p) => p.boards));
  for (const b of boards) if (!listed.has(b)) old.boards.push(b);
  for (const w of widgets) if (w.page === first) delete w.page;
}

const pageAt = (pages: Page[], id: unknown): Page => {
  const p = pages.find((x) => x.id === id);
  if (!p) throw new WidgetError(404, "no-page", `No page "${String(id)}"`);
  return p;
};
const clampIndex = (i: unknown, len: number) => (typeof i === "number" && Number.isFinite(i) ? Math.max(0, Math.min(len, Math.trunc(i))) : len);

function takeBoards(pages: Page[], ids: string[], to: Page, docBoards: string[]) {
  const have = new Set(docBoards);
  const missing = ids.filter((b) => !have.has(b));
  if (missing.length) throw new WidgetError(404, "no-board", `No board ${missing.map((m) => `"${m}"`).join(", ")} in this document`);
  const move = new Set(ids);
  for (const p of pages) p.boards = p.boards.filter((b) => !move.has(b));
  to.boards.push(...ids);
}

export async function createPage(file: string, input: { name?: unknown; index?: unknown; boards?: unknown; id?: unknown }, boardIds: BoardIds, opts: Opts = {}) {
  if (input.boards !== undefined && (!Array.isArray(input.boards) || input.boards.some((b) => typeof b !== "string"))) throw new WidgetError(422, "invalid-pages", "boards must be a list of board ids");
  if (input.id !== undefined && (typeof input.id !== "string" || !PAGE_ID.test(input.id))) throw new WidgetError(422, "invalid-pages", "id must be 1-40 letters, digits, - or _");
  return change(file, boardIds, opts, (pages, _w, doc) => {
    if (pages.length >= MAX_PAGES) throw new WidgetError(422, "invalid-pages", `at most ${MAX_PAGES} pages`);
    const id = (input.id as string | undefined) ?? newId();
    if (pages.some((p) => p.id === id)) throw new WidgetError(409, "id-exists", `A page "${id}" already exists`);
    let name = input.name === undefined ? "" : nameOf(input.name);
    if (!name) for (let n = pages.length + 1; !name || pages.some((p) => p.name === name); n++) name = `Page ${n}`;
    const page: Page = { id, name, boards: [] };
    pages.splice(clampIndex(input.index, pages.length), 0, page);
    if (input.boards) takeBoards(pages, input.boards as string[], page, doc);
    return page.id;
  });
}

export async function updatePage(file: string, id: string, patch: { name?: unknown; index?: unknown; background?: unknown }, boardIds: BoardIds, opts: Opts = {}) {
  if (!patch || typeof patch !== "object") throw new WidgetError(400, "bad-body", "Send an object of changes");
  const changesBackground = Object.hasOwn(patch, "background");
  if (changesBackground) requireLocalBackground(file);
  return change(file, boardIds, opts, (pages) => {
    const p = pageAt(pages, id);
    if (changesBackground) {
      if (patch.background === null) delete p.background;
      else if (typeof patch.background === "string" && /^#[0-9a-f]{6}$/i.test(patch.background)) p.background = patch.background.toUpperCase();
      else throw new WidgetError(422, "invalid-pages", "background must be #RRGGBB or null");
    }
    if (patch.name !== undefined) p.name = nameOf(patch.name);
    if (patch.index !== undefined) {
      pages.splice(pages.indexOf(p), 1);
      pages.splice(clampIndex(patch.index, pages.length), 0, p);
    }
    return p.id;
  });
}

/**
 * Deletes the boards of a page from the design file as one structure step (src/structure.ts), recorded under `merge` so the
 * page's own removal joins it: one undo brings back the boards, their layers, the page and its cards. The server
 * passes it; without one (tests of the sidecar alone) the boards are left in the document, unlisted.
 */
export type DeleteBoards = (docFile: string, ids: string[], merge: string, record: NonNullable<WriteOpts["record"]>) => number | Promise<number>;

/** How long the board half and the page half of a page delete may be apart and still be one undo step. */
export const PAGE_DELETE_MERGE_MS = 3000;

/**
 * Delete a page and everything on it: its boards go from the design file, its cards from the sidecar, the page from
 * the list, as one undo step. The last page cannot go. Boards and cards no page lists belong to the first page, so
 * deleting the first page takes them too.
 */
export function deletePage(file: string, id: string, boardIds: BoardIds, opts: Opts = {}, deleteBoards?: DeleteBoards) {
  // One delete at a time per file: the last-page rule and the boards that go are read after the one before finished.
  const docFile = docFileFor(file);
  const run = (deleteChains.get(docFile) ?? Promise.resolve()).then(() => asOneAction(docFile, () => deletePageNow(file, id, boardIds, opts, deleteBoards)));
  const tail = run.catch(() => {});
  deleteChains.set(docFile, tail);
  void tail.then(() => { if (deleteChains.get(docFile) === tail) deleteChains.delete(docFile); });
  return run;
}
const deleteChains = new Map<string, Promise<unknown>>();

async function deletePageNow(file: string, id: string, boardIds: BoardIds, opts: Opts, deleteBoards?: DeleteBoards) {
  const docFile = docFileFor(file);
  const now = listPages(file, boardIds);
  const page = now.pages.find((p) => p.id === id);
  if (!page) throw new WidgetError(404, "no-page", `No page "${id}"`);
  if (now.pages.length === 1) throw new WidgetError(409, "last-page", "A document keeps at least one page");
  // Checked before the boards go, so a stale request changes nothing at all.
  if (opts.ifMatch && opts.ifMatch !== now.rev) throw new WidgetError(409, "rev-mismatch", "The pages changed since you read them");
  const first = now.pages[0].id === id;
  const record = opts.record ?? { label: "Delete Page" };
  const merge = `group:page-delete:${id}:${Date.now().toString(36)}`;
  // The boards it shows, and hidden ones it lists (the view leaves those out).
  const listed = storedOf(storeFor(docFile).snapshot().extra).find((p) => p.id === id)?.boards ?? [];
  const ids = [...new Set([...page.boards, ...listed])];
  const boards = ids.length && deleteBoards ? await deleteBoards(docFile, ids, merge, record) : 0;
  const out = await change(file, boardIds, { record: { ...record, mergeKey: merge, mergeMs: PAGE_DELETE_MERGE_MS } }, (pages, widgets) => {
    const p = pageAt(pages, id);
    pages.splice(pages.indexOf(p), 1);
    let removed = 0;
    for (let i = widgets.length - 1; i >= 0; i--) {
      const w = widgets[i];
      const on = typeof w.page === "string" && w.page ? w.page === id : first;
      if (on) { widgets.splice(i, 1); removed++; }
    }
    // A card with no page shows on the first page; one naming the new first page goes implicit like everywhere else.
    for (const w of widgets) if (w.page === pages[0].id) delete w.page;
    return { boards, widgets: removed };
  });
  if (boards) relabelTop(docFile, merge, record.label);
  return out;
}

export async function moveBoardsToPage(file: string, boards: unknown, to: string, boardIds: BoardIds, opts: Opts = {}) {
  if (!Array.isArray(boards) || !boards.length || boards.length > 5000 || boards.some((b) => typeof b !== "string" || !b)) throw new WidgetError(422, "invalid-pages", "boards must be a list of board ids");
  return change(file, boardIds, opts, (pages, _w, doc) => {
    const page = pageAt(pages, to);
    takeBoards(pages, boards as string[], page, doc);
    return { moved: boards.length, to: page.id };
  });
}

/**
 * After a structure op (src/structure.ts keepOnPage), one change: `fresh` boards listed on page `to` (when given),
 * and `gone` ids (boards the op deleted, cut or put inside another layer) taken off every list, so no page names an
 * id the document lacks. Undo of the op's step puts the stored list back as it was.
 */
export async function settleBoards(file: string, fresh: string[], to: string | null, gone: string[], boardIds: BoardIds, opts: Opts = {}) {
  return change(file, boardIds, opts, (pages, _w, doc) => {
    const drop = new Set(gone);
    if (drop.size) for (const p of pages) p.boards = p.boards.filter((b) => !drop.has(b));
    if (to && fresh.length) takeBoards(pages, fresh, pageAt(pages, to), doc);
    return { moved: to ? fresh.length : 0, unlisted: drop.size };
  });
}

export async function replacePages(file: string, pages: unknown, boardIds: BoardIds, opts: Opts = {}) {
  const next = validatePages(pages);
  if (next.some((p) => p.background !== undefined)) requireLocalBackground(file);
  return change(file, boardIds, opts, (list, widgets) => {
    list.splice(0, list.length, ...next);
    // Widgets on pages that no longer exist fall back to the first page.
    const ids = new Set(next.map((p) => p.id));
    for (const w of widgets) if (typeof w.page === "string" && (!ids.has(w.page) || w.page === next[0].id)) delete w.page;
    return next.length;
  });
}

function requireLocalBackground(file: string): void {
  if (isCloudFile(docFileFor(file))) throw new WidgetError(422, "invalid", "Page colours stay on local files for now");
}

// ---------- HTTP: /api/pages ----------

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of bodyChunks(req)) {
    chunks.push(Buffer.from(c));
    size += c.length;
    if (size > 1_000_000) throw new WidgetError(413, "too-large", "The request body is larger than 1 MB");
  }
  const raw = Buffer.concat(chunks).toString("utf8"); // decoded once: a character split across chunks stays whole
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error();
    return j;
  } catch {
    throw new WidgetError(400, "bad-json", "The request body must be a JSON object");
  }
}

/**
 * GET /api/pages, PUT /api/pages {pages}, POST /api/pages {name?, index?, boards?}, PATCH|DELETE /api/pages/:id (a
 * delete takes the page's boards and cards with it),
 * POST /api/pages/move {boards, to}. Writes need x-canvas: 1 and honour If-Match (the envelope rev).
 */
export async function handlePagesRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, boardIds: BoardIds, deleteBoards?: DeleteBoards): Promise<boolean> {
  if (url.pathname !== "/api/pages" && !url.pathname.startsWith("/api/pages/")) return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    const m = req.method ?? "GET";
    const file = url.searchParams.get("file") ?? "";
    if (m !== "GET" && req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const ifMatch = (req.headers["if-match"] ?? "").toString().replace(/^W\/|"/g, "") || undefined;
    const mcp = req.headers["x-canvas-source"] === "mcp";
    const session = String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined;
    // What the undo history calls this change.
    const opts = (label: string, mergeKey?: string): WriteOpts => ({ ifMatch, record: { label, mergeKey, source: mcp ? "mcp" : "user", session } });
    const sub = url.pathname.slice("/api/pages/".length);
    if (url.pathname === "/api/pages") {
      if (m === "GET") return reply(200, listPages(file, boardIds)), true;
      if (m === "PUT") return reply(200, await replacePages(file, (await body(req)).pages, boardIds, opts("Change Pages"))), true;
      if (m === "POST") {
        const b = await body(req);
        return reply(201, await createPage(file, b, boardIds, opts("New Page"))), true;
      }
    } else if (sub === "move" && m === "POST") {
      const b = await body(req);
      return reply(200, await moveBoardsToPage(file, b.boards, String(b.to ?? ""), boardIds, opts(Array.isArray(b.boards) && b.boards.length === 1 ? "Move Board to Page" : "Move Boards to Page"))), true;
    } else if (sub && !sub.includes("/")) {
      const id = decodeURIComponent(sub);
      if (m === "PATCH") {
        const b = await body(req);
        const label = Object.hasOwn(b, "background") ? "Change Page Background" : b.name !== undefined && b.index === undefined ? "Rename Page" : b.name === undefined ? "Reorder Pages" : "Page Change";
        return reply(200, await updatePage(file, id, b, boardIds, opts(label, Object.hasOwn(b, "background") ? undefined : `page:${id}:${Object.keys(b).sort().join(",")}`))), true;
      }
      if (m === "DELETE") return reply(200, await deletePage(file, id, boardIds, opts("Delete Page"), deleteBoards)), true;
    }
    reply(404, { error: "not found", code: "not-found" });
  } catch (e) {
    if (e instanceof WidgetError) reply(e.status || 500, { error: e.message, code: e.code });
    else reply(500, { error: (e as Error).message });
  }
  return true;
}
