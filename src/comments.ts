// Comments in a local file (phase 1: no server). They live in comments.json inside the .canvas package, in the
// shape cloud/protocol.ts defines (docs/cloud/protocol.md); the same applyOp that a team's server runs applies them
// here, so a file that later syncs has nothing to convert. Comments are not part of the undo history and never touch
// document.json.
//
//   GET  /api/comments?file=            { doc, threads }   (no file yet: doc null, no threads)
//   POST /api/comments/ops?file=        { ops: OpEnvelope[] } -> { doc, applied, rejected, threads }
//
// An envelope's `doc` may be the nil uuid (NIL_DOC): "this file's own document". The first comment makes the file
// with a new doc uuid. The author is the local person's name (no email), or the MCP client's name for an agent.
// While the file has no `server`, seq stays 0 and the outbox stays empty.

import type http from "node:http";
import { randomUUID } from "node:crypto";
import { applyOp, checkEnvelope, isVoteOp, LIMITS, UPDATE_COMMENT_HOST, type Author, type CommentsFile, type Op, type OpEnvelope, type Rejected, type Thread } from "../cloud/protocol.ts";
import { readBodyText } from "./body.ts";
import { CommentsError, emptyComments, readCommentsFile, writeCommentsFile } from "./comments-file.ts";
import { resolveDoc } from "./docpath.ts";
import { agentSettings } from "./settings.ts";
import { hooks, isShared, NIL_DOC as NIL, queueLocal, viewOf, withDoc, type SyncFile } from "./cloud-sync.ts";
import { countUsage } from "./usage-counts.ts";
import { commentReads, unreadThreads } from "./comment-reads.ts";

/** An envelope that says "the document of the file this request names". */
export const NIL_DOC = NIL;

const MAX_BODY = 4 * 1024 * 1024;

/** The name a comment made by the person at this Canvas carries: Settings > General > Your name in comments. */
export function localName(): string {
  return agentSettings().commentName || process.env.CANVAS_COMMENT_NAME?.trim() || "Me";
}

/** "Claude Code" for any Claude client, "Codex", else the client's own name (letters, digits, spaces, . _ -). */
export function agentName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/[^\p{L}\p{N} ._-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40) : "";
  if (!s) return "Agent";
  const l = s.toLowerCase();
  return l.includes("claude") ? "Claude Code" : l.includes("codex") ? "Codex" : s;
}

/** Who a request's comments are by: an MCP client by its name, else the person here. No email: nothing verified it. */
export function authorOf(req: Pick<http.IncomingMessage, "headers">): Author {
  return req.headers["x-canvas-source"] === "mcp" ? { name: agentName(req.headers["x-canvas-agent"]), agent: true } : { name: localName() };
}

/** The package folder a file argument names, or a CommentsError for a single-file document (comments need a package). */
export function packageOf(file: string): string {
  let ref;
  try {
    ref = resolveDoc(file);
  } catch (e) {
    throw new CommentsError(404, "not_found", (e as Error).message);
  }
  if (ref.kind !== "canvas") throw new CommentsError(400, "invalid", "Comments are saved in a .canvas document. This is a single-file document: Save As a .canvas first.");
  return ref.displayPath;
}

export type OpsResult = { doc: string; applied: { opId: string; seq: number }[]; rejected: Rejected[]; threads: Thread[]; counts: string[]; queued?: boolean };

/**
 * Checks and applies envelopes to the file in `pkg` and writes it once, atomically, when anything applied. Written
 * whole in one synchronous step, so two requests never interleave. A file that is not valid comments is never overwritten.
 */
export function applyEnvelopes(pkg: string, envelopes: unknown, by: Author, now = new Date()): OpsResult {
  if (!Array.isArray(envelopes)) throw new CommentsError(400, "invalid", "ops must be a list");
  if (envelopes.length > LIMITS.opsPerMessage) throw new CommentsError(413, "quota", `At most ${LIMITS.opsPerMessage} ops in one request`);
  const existing = readCommentsFile(pkg);
  const file: CommentsFile = existing ?? emptyComments();
  const applied: OpsResult["applied"] = [];
  const rejected: Rejected[] = [];
  const counts: string[] = [];
  const at = now.toISOString();
  if (isShared(file)) return queueShared(pkg, file as SyncFile, envelopes, by);
  const seen = new Set<string>();
  for (const raw of envelopes) {
    const bad = checkEnvelope(raw);
    const opId = typeof (raw as OpEnvelope | undefined)?.opId === "string" ? (raw as OpEnvelope).opId : "";
    if (bad) { rejected.push({ opId, code: "invalid", message: bad }); continue; }
    const e = raw as OpEnvelope;
    if (seen.has(e.opId)) { applied.push({ opId: e.opId, seq: 0 }); continue; } // the same op twice in one request: once
    seen.add(e.opId);
    if (e.doc !== NIL_DOC && e.doc !== file.doc) { rejected.push({ opId: e.opId, code: "conflict", message: "This op is for another document" }); continue; }
    const op = e.op;
    // A replay of a create or a reply that already landed is acknowledged, not applied twice.
    if (replayed(file.threads, op)) { applied.push({ opId: e.opId, seq: 0 }); continue; }
    if (op.kind === "thread.create" && file.threads.length >= LIMITS.threadsPerDoc) { rejected.push({ opId: e.opId, code: "quota", message: "This document has the most comment threads it can hold" }); continue; }
    const why = applyOp(file.threads, file.doc, op, by, at);
    if (why) { rejected.push({ opId: e.opId, code: "conflict", message: why }); continue; }
    applied.push({ opId: e.opId, seq: 0 });
    const c = countOf(op);
    if (c) counts.push(c);
  }
  if (applied.length) writeCommentsFile(pkg, file);
  return { doc: file.doc, applied, rejected, threads: file.threads, counts };
}

/**
 * A shared file: a change made here goes to the outbox (with the real doc on it) and shows at once; src/cloud.ts sends
 * it when the socket is up. Nothing is applied to the confirmed threads: only the server's answer does that.
 */
function queueShared(pkg: string, file: SyncFile, envelopes: unknown[], by: Author): OpsResult {
  if (file.voteRole === "viewer" && file.voteCapable === false) throw new CommentsError(426, "version", UPDATE_COMMENT_HOST);
  if (envelopes.some(e => e && typeof e === "object" && "op" in e && e.op && typeof e.op === "object" && isVoteOp(e.op as Op)))
    throw new CommentsError(400, "invalid", "Use the vote controls to vote.");
  const list = envelopes.map((e) => (e && typeof e === "object" ? withDoc(e as OpEnvelope, file.doc) : e)) as OpEnvelope[];
  // What the file arrived with is held back first (src/cloud.ts vouch): only the ops made here now go out at once.
  const held = hooks.vouch(pkg, file);
  const { queued, refused } = queueLocal(file, list, by, { name: localName() });
  if (held && !queued.length) writeCommentsFile(pkg, file);
  const counts: string[] = [];
  for (const e of list) if (queued.includes(e.opId)) { const c = countOf(e.op); if (c) counts.push(c); }
  if (queued.length) { writeCommentsFile(pkg, file); hooks.touch(pkg, null); }
  return { doc: file.doc, applied: queued.map((opId) => ({ opId, seq: 0 })), rejected: refused, threads: viewOf(file, { name: localName() }), counts, queued: true };
}

const countOf = (op: Op): string | null =>
  op.kind === "thread.create" ? "comment.thread_created" : op.kind === "comment.add" ? "comment.replied" : op.kind === "thread.resolve" && op.resolved ? "comment.resolved" : null;

function replayed(threads: Thread[], op: Op): boolean {
  if (op.kind === "thread.create") return threads.some((t) => t.id === op.thread && t.comments.some((c) => c.id === op.comment));
  if (op.kind === "comment.add") return threads.some((t) => t.id === op.thread && t.comments.some((c) => c.id === op.comment));
  return false;
}

/** The threads of a file and its doc id; a file with no comments yet answers doc null. A shared file answers what the page shows (confirmed plus outbox) and its sync state. */
export function readThreads(pkg: string): { doc: string | null; threads: Thread[]; sync?: unknown } {
  const f = readCommentsFile(pkg);
  if (!f) return { doc: null, threads: [] };
  if (!isShared(f)) return { doc: f.doc, threads: f.threads };
  return { doc: f.doc, threads: viewOf(f, { name: localName() }), sync: hooks.info(pkg, f as SyncFile) };
}

const readerOf = (sync: unknown): Author => (sync as { me?: Author } | undefined)?.me || { name: localName() };

/** Builds the ops a client would send for one new thread (the page and canvas-mcp build theirs the same way). */
export function threadCreateEnvelope(anchor: Thread["anchor"], body: string, at = new Date()): OpEnvelope {
  return { opId: randomUUID(), doc: NIL_DOC, at: at.toISOString(), op: { kind: "thread.create", thread: randomUUID(), anchor, comment: randomUUID(), body } };
}

/** Answers /api/comments*. Returns false for anything else. `changed` tells the open pages of that file. */
export async function handleCommentsRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, changed?: (file: string, pkg: string) => void): Promise<boolean> {
  if (!["/api/comments", "/api/comments/ops", "/api/comments/read"].includes(url.pathname)) return false;
  const out = (status: number, body: unknown): true => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
    return true;
  };
  try {
    const file = url.searchParams.get("file");
    if (!file) return out(400, { error: "file is required" });
    const pkg = packageOf(file);
    if (url.pathname === "/api/comments") {
      if (req.method !== "GET") return out(405, { error: "method not allowed" });
      hooks.touch(pkg, file); // opening a shared file's comments connects it (a no-op for any other file)
      const threads = readThreads(pkg);
      const { fileInfo } = await import("./cloud-files.ts");
      const cloud = fileInfo(file)?.cloud || (threads.sync as { url?: string } | undefined)?.url;
      let people: unknown[] = [];
      if (cloud) {
        try {
          const { target } = await import("./cloud.ts");
          const t = await target(cloud);
          if (!("fail" in t)) {
            const r = await fetch(t.base + "/v1/members", { headers: t.headers, signal: AbortSignal.timeout(3000) });
            if (r.ok) { const data = await r.json(); if (Array.isArray(data)) people = data; }
          }
        } catch { /* Offline: keep comments readable. */ }
      }
      const unread = unreadThreads(threads.doc, readerOf(threads.sync), threads.threads);
      return out(200, { ...threads, unread, me: localName(), ...(cloud ? { people } : {}) });
    }
    if (req.method !== "POST") return out(405, { error: "method not allowed" });
    if (req.headers["x-canvas"] !== "1") return out(403, { error: "forbidden", code: "forbidden" });
    const raw = await readBodyText(req, MAX_BODY);
    if (raw === null) return out(413, { error: "too large" });
    let body: { ops?: unknown; thread?: unknown; unread?: unknown };
    try {
      body = JSON.parse(raw || "{}");
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch {
      return out(400, { error: "The request body must be JSON" });
    }
    if (url.pathname === "/api/comments/read") {
      // Omit the thread to mark the whole document read.
      const id = body.thread;
      if ((id !== undefined && typeof id !== "string") || (body.unread !== undefined && typeof body.unread !== "boolean") || (id === undefined && body.unread)) {
        return out(400, { error: "Invalid comment read mark" });
      }
      const { doc, threads, sync } = readThreads(pkg);
      const { fileInfo } = await import("./cloud-files.ts");
      const me = fileInfo(file)?.author || readerOf(sync);
      const selected = id === undefined ? threads : threads.filter(t => t.id === id && !t.deletedAt);
      if (id !== undefined && !selected.length) return out(404, { error: "This comment is no longer available" });
      if (!doc) return out(200, { unread: [] });
      const reads = commentReads();
      reads.mark(doc, me, selected, body.unread === true);
      changed?.(file, pkg);
      return out(200, { unread: reads.unread(doc, me, threads) });
    }
    const r = applyEnvelopes(pkg, body.ops, authorOf(req));
    for (const c of r.counts) countUsage(c);
    if (r.applied.length && changed) changed(file, pkg);
    const sync = r.queued ? readThreads(pkg).sync : undefined;
    const unread = unreadThreads(r.doc, readerOf(sync), r.threads);
    return out(200, { doc: r.doc, applied: r.applied, rejected: r.rejected, threads: r.threads, unread, me: localName(), ...(sync ? { sync } : {}) });
  } catch (e) {
    if (e instanceof CommentsError) return out(e.status, { error: e.message, code: e.code });
    return out(500, { error: (e as Error).message });
  }
}
