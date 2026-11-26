// The state of a shared file's comments (docs/cloud/protocol.md), without any network: what the server confirmed, what
// is still waiting in the outbox, and what the page shows (the two together). src/cloud.ts moves bytes; this file
// decides what they mean, so every rule here is testable on plain objects.
//
// comments.json of a shared file keeps two things apart:
//   threads  = the SERVER-CONFIRMED threads, as of `seq` (a snapshot, then every applied entry in order)
//   outbox   = this app's ops the server has not acknowledged, oldest first
//   rejected = ops the server refused, kept until the person retries or discards them
// What the page shows is viewOf(file): the confirmed threads with the outbox (and the refused creates) applied on top,
// so a comment appears the moment it is typed and is never lost offline. Nothing else is stored twice.
//
// The contract also keeps local display metadata:
//   me       = who the server said this app is (email and name), to show pending comments as theirs
//   relayed  = agent authors, by comment id. The server knows people only, so a comment an agent wrote through this
//              app is sent as this person's. On this machine it keeps showing as the agent's (Author.agent).

import { applyOp, checkEnvelope, isVoteOp, LIMITS, type Applied, type Author, type CommentsFile, type ErrorCode, type Op, type OpEnvelope, type Rejected, type Thread } from "../cloud/protocol.ts";

/** An envelope that says "the document of the file this request names" (the local server replaces it before storing or sending). */
export const NIL_DOC = "00000000-0000-4000-8000-000000000000";

export type RefusedOp = NonNullable<CommentsFile["rejected"]>[number];
export interface SyncFile extends CommentsFile {
  me?: Author;
  relayed?: Record<string, Author>;
}

const clone = <T>(v: T): T => structuredClone(v);
const commentOf = (op: Op): string | undefined => ("comment" in op ? op.comment : undefined);

/** Ops that make a comment: the page shows their state on that comment. */
export const makesComment = (op: Op): boolean => op.kind === "thread.create" || op.kind === "comment.add";

export const isShared = (f: CommentsFile | null | undefined): boolean => !!f?.server?.url;

/** Who an op in the outbox is by: the agent that wrote it through this app, else the person this app is. */
function authorOfOp(f: SyncFile, op: Op, fallback: Author): Author {
  const c = commentOf(op);
  return (c && f.relayed?.[c]) || f.me || fallback;
}

/** What the page shows: the confirmed threads, the outbox and the refused creates applied on top, agents marked. */
export function viewOf(f: SyncFile, fallback: Author = { name: "Me" }): Thread[] {
  const threads = clone(f.threads);
  if (!isShared(f)) return threads;
  for (const e of f.outbox) if (!isVoteOp(e.op)) applyOp(threads, f.doc, e.op, authorOfOp(f, e.op, fallback), e.at);
  for (const r of f.rejected ?? []) if (makesComment(r.envelope.op)) applyOp(threads, f.doc, r.envelope.op, authorOfOp(f, r.envelope.op, fallback), r.envelope.at);
  if (f.relayed) for (const t of threads) for (const c of t.comments) { const a = f.relayed[c.id]; if (a) c.author = a; }
  return threads;
}

/** One op the page shows a state for: waiting to be sent, or refused. */
export interface OpState {
  opId: string;
  kind: Op["kind"];
  thread?: string;
  comment?: string;
  /** Present when the server refused it. */
  code?: ErrorCode;
  message?: string;
}

/** The thread an op is about, found through the view when it names only a comment. */
function threadOfOp(op: Op, view: Thread[]): string | undefined {
  if ("thread" in op) return op.thread;
  const c = commentOf(op);
  return c ? view.find((t) => t.comments.some((x) => x.id === c))?.id : undefined;
}

export function pendingStates(f: SyncFile, view: Thread[]): { pending: OpState[]; rejected: OpState[] } {
  const st = (e: OpEnvelope): OpState => ({ opId: e.opId, kind: e.op.kind, thread: threadOfOp(e.op, view), comment: commentOf(e.op) });
  return {
    pending: f.outbox.map(st),
    rejected: (f.rejected ?? []).map((r) => ({ ...st(r.envelope), code: r.code, message: r.message })),
  };
}

// ---------- changes to the file (each returns true when something changed) ----------

/** Puts the real doc on an envelope that carries the nil one. */
export const withDoc = (e: OpEnvelope, doc: string): OpEnvelope => (e.doc === NIL_DOC ? { ...e, doc } : e);

/**
 * A change made here on a shared file: checked against what the page shows (a reply to a deleted comment is refused
 * now, as the server would), then queued. Returns what was queued and what was refused.
 */
export function queueLocal(f: SyncFile, envelopes: OpEnvelope[], by: Author, fallback: Author): { queued: string[]; refused: Rejected[] } {
  const queued: string[] = [], refused: Rejected[] = [];
  const have = new Set([...f.outbox.map((e) => e.opId), ...(f.rejected ?? []).map((r) => r.envelope.opId)]);
  for (const raw of envelopes) {
    const bad = checkEnvelope(withDoc(raw, f.doc));
    if (bad) { refused.push({ opId: raw.opId ?? "", code: "invalid", message: bad }); continue; }
    const e = withDoc(raw, f.doc);
    if (e.doc !== f.doc) { refused.push({ opId: e.opId, code: "conflict", message: "This op is for another document" }); continue; }
    if (have.has(e.opId)) { queued.push(e.opId); continue; }
    const shown = viewOf(f, fallback);
    if (e.op.kind === "thread.create" && shown.length >= LIMITS.threadsPerDoc) { refused.push({ opId: e.opId, code: "quota", message: "This document has the most comment threads it can hold" }); continue; }
    const why = applyOp(shown, f.doc, e.op, by, e.at);
    if (why) { refused.push({ opId: e.opId, code: "conflict", message: why }); continue; }
    f.outbox.push(e);
    have.add(e.opId);
    const c = commentOf(e.op);
    if (c && by.agent) (f.relayed ??= {})[c] = { name: by.name, agent: true };
    queued.push(e.opId);
  }
  return { queued, refused };
}

/**
 * Entries the server applied, in its order. An entry at or below `seq` was already applied (a replay after a
 * reconnect): skipped. Our own ops leave the outbox when their entry arrives.
 */
export function confirm(f: SyncFile, entries: Applied[]): boolean {
  let changed = false;
  for (const x of [...entries].sort((a, b) => a.seq - b.seq)) {
    const mine = f.outbox.findIndex((e) => e.opId === x.opId);
    if (mine >= 0) { f.outbox.splice(mine, 1); changed = true; }
    if (x.seq <= f.seq) continue;
    // The server's author and time win. An op that cannot apply here (it already did through a snapshot) changes nothing.
    applyOp(f.threads, f.doc, x.op, x.by, x.at);
    f.seq = x.seq;
    changed = true;
  }
  return changed;
}

/** The server's whole truth at `seq` (a welcome with threads): it replaces the confirmed threads. The outbox stays. */
export function snapshot(f: SyncFile, threads: Thread[], seq: number): void {
  f.threads = clone(threads);
  f.seq = seq;
}

/** An ack: the op is in the server's history at `seq`. It leaves the outbox once that seq is applied here. */
export function acknowledge(f: SyncFile, opId: string, seq: number): boolean {
  if (seq > f.seq) return false; // its "applied" entry has not arrived yet; confirm() removes it then
  const i = f.outbox.findIndex((e) => e.opId === opId);
  if (i < 0) return false;
  f.outbox.splice(i, 1);
  return true;
}

/** Refusals: each op leaves the outbox and is kept, with the reason, until the person retries or discards it. */
export function reject(f: SyncFile, list: Rejected[]): boolean {
  let changed = false;
  for (const r of list) {
    const i = f.outbox.findIndex((e) => e.opId === r.opId);
    if (i < 0) continue;
    const [envelope] = f.outbox.splice(i, 1);
    (f.rejected ??= []).push({ envelope, code: r.code, message: r.message });
    changed = true;
  }
  return changed;
}

/** Retry: a refused op goes back to the end of the outbox. */
export function retry(f: SyncFile, opId: string): boolean {
  const i = (f.rejected ?? []).findIndex((r) => r.envelope.opId === opId);
  if (i < 0) return false;
  const item = f.rejected![i];
  if (isVoteOp(item.envelope.op) && !item.retryableVote) return false;
  const [r] = f.rejected!.splice(i, 1);
  f.outbox.push(r.envelope);
  return true;
}

/** Discard: a refused op is dropped for good. A refused create takes the later ops that depend on it with it. */
export function discard(f: SyncFile, opId: string): boolean {
  const i = (f.rejected ?? []).findIndex((r) => r.envelope.opId === opId);
  if (i < 0) return false;
  const [r] = f.rejected!.splice(i, 1);
  const op = r.envelope.op;
  if (op.kind === "thread.create") {
    const gone = (o: Op) => ("thread" in o && o.thread === op.thread) || (o.kind === "comment.edit" || o.kind === "comment.delete" ? o.comment === op.comment : false);
    f.outbox = f.outbox.filter((e) => !gone(e.op));
    f.rejected = f.rejected!.filter((x) => !gone(x.envelope.op));
  } else if (op.kind === "comment.add") {
    const gone = (o: Op) => (o.kind === "comment.edit" || o.kind === "comment.delete") && o.comment === op.comment;
    f.outbox = f.outbox.filter((e) => !gone(e.op));
    f.rejected = f.rejected!.filter((x) => !gone(x.envelope.op));
  }
  const c = commentOf(op);
  if (c && f.relayed) delete f.relayed[c];
  return true;
}

// ---------- sharing a file ----------

/**
 * The ops that make a local file's threads exist on a server, sent from the sharer: thread.create with the same ids
 * and anchors, comment.add for the replies, thread.resolve for the resolved ones. Tombstones are created with a
 * placeholder body, then deleted, so the server remembers every id without receiving the deleted text.
 */
export function opsForShare(f: CommentsFile, now: Date = new Date(), id: () => string = () => crypto.randomUUID()): OpEnvelope[] {
  const at = now.toISOString();
  const out: OpEnvelope[] = [];
  const env = (op: Op): OpEnvelope => ({ opId: id(), doc: f.doc, at, op });
  for (const t of f.threads) {
    const [first, ...rest] = t.comments;
    if (!first) continue;
    const body = (c: Thread["comments"][number]) => t.deletedAt || c.deletedAt ? "Deleted" : c.body;
    out.push(env({ kind: "thread.create", thread: t.id, anchor: t.anchor, comment: first.id, body: body(first) }));
    if (first.deletedAt && !t.deletedAt) out.push(env({ kind: "comment.delete", comment: first.id }));
    for (const c of rest) {
      out.push(env({ kind: "comment.add", thread: t.id, comment: c.id, body: body(c) }));
      if (c.deletedAt && !t.deletedAt) out.push(env({ kind: "comment.delete", comment: c.id }));
    }
    if (t.deletedAt) out.push(env({ kind: "thread.delete", thread: t.id }));
    else if (t.resolvedAt) out.push(env({ kind: "thread.resolve", thread: t.id, resolved: true }));
  }
  return out;
}

/**
 * The file as it is once shared to `url`: the threads become ops in the outbox (the server's copy starts empty and
 * is built from them), so the confirmed side holds exactly what the server confirmed: nothing yet.
 */
export function shareLocal(f: SyncFile, url: string, by: Author, ops = opsForShare(f)): SyncFile {
  const relayed: Record<string, Author> = {};
  for (const t of f.threads) for (const c of t.comments) if (c.author.agent && !c.deletedAt) relayed[c.id] = { name: c.author.name, agent: true };
  return { ...f, server: { url }, seq: 0, threads: [], outbox: [...f.outbox, ...ops], rejected: [], me: by, ...(Object.keys(relayed).length ? { relayed } : {}) };
}

// ---------- what runs around the network (set by src/cloud.ts; plain no-ops in a test of this file alone) ----------

export interface SyncHooks {
  /** A shared file was opened or changed here: connect it (if it is not) and send what waits. */
  touch(pkg: string, file: string | null): void;
  /** What the page needs to draw the shared bar, or null for a file that is not shared. */
  info(pkg: string, f: SyncFile): unknown;
  /**
   * Before anything of a shared file is sent from this Mac for the first time: ops it arrived with (a copy made by
   * someone else) move to the refused list, for the person to Retry (send as them) or Discard. Changes `f`; true when
   * it did.
   */
  vouch(pkg: string, f: SyncFile): boolean;
}
export const hooks: SyncHooks = { touch() {}, info: () => null, vouch: () => false };
