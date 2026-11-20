// The comments protocol shared by the Canvas app (src/) and a team's own Canvas server (cloud/adapters/cloudflare).
// Plain types and pure helpers, no imports: it runs in Node, in the page and in a Worker. The rules are in
// docs/cloud/protocol.md; change both together, and bump PROTOCOL_VERSION for any change an older side cannot read.

export const PROTOCOL_VERSION = 1;

/** A UUID (crypto.randomUUID()). Ids never change and are never reused. */
export type Uuid = string;
/** An ISO 8601 time in UTC. */
export type Iso = string;

export type Role = "owner" | "editor" | "commenter" | "viewer";
/** What a role may do with comments. Viewers read only. */
export const CAN_COMMENT: Record<Role, boolean> = { owner: true, editor: true, commenter: true, viewer: false };

export interface Author {
  /**
   * On a Cloudflare server: verified by Cloudflare Access. On a Cloud hosted on a Mac: a label the host typed, not
   * verified, and `id` is who it is. Absent on a comment made in a local file that never synced.
   */
  email?: string;
  name: string;
  /**
   * A Cloud hosted on a Mac: the person's id there, random and never reused. When set, it decides whose comment this is
   * (mayApply), not the email. Optional and additive: a side that does not know it ignores it, so no protocol bump.
   */
  id?: string;
  /** An agent (Claude Code, Codex) wrote it through MCP, not a person. Set by whoever records the comment. */
  agent?: boolean;
}

/**
 * Where a thread points. A layer id plus a point on that layer, as fractions of its box (0..1, may fall outside for a
 * pin beside it), so the pin moves with the layer. With no layer: a point on the page in canvas coordinates.
 */
export interface Anchor {
  page?: string;
  nodeId?: string;
  /** With nodeId: fraction of the layer's width. Without: canvas x. */
  x: number;
  /** With nodeId: fraction of the layer's height. Without: canvas y. */
  y: number;
  /** The board that held the layer when the thread was made: where to show it if the layer is deleted. */
  board?: string;
  /** The published revision a reviewer commented on (web review); absent for comments made in the app. */
  revision?: Uuid;
  /** What the layer was, for the "layer deleted" state: never reattach a thread to another layer. */
  preview?: { name?: string; type?: string; width?: number; height?: number };
}

export interface Mention { start: number; end: number; name: string; email?: string; id?: string }

/** Call after shape validation. Recipient ids take precedence; names and emails come from membership. */
export function canonicalMentions<T extends Op>(op: T, members: readonly Author[]): T {
  if (!("mentions" in op) || !op.mentions) return op;
  return { ...op, mentions: op.mentions.flatMap(mention => {
    const member = mention.id !== undefined
      ? members.find(person => person.id === mention.id)
      : mention.email !== undefined ? members.find(person => person.email === mention.email) : undefined;
    return member ? [{ start: mention.start, end: mention.end, name: member.name,
      ...(member.id ? { id: member.id } : {}), ...(member.email ? { email: member.email } : {}) }] : [];
  }) };
}

export interface Comment {
  id: Uuid;
  thread: Uuid;
  author: Author;
  body: string;
  mentions?: Mention[];
  createdAt: Iso;
  editedAt?: Iso;
  /** Tombstone: kept so a replay or an old copy never brings it back. The body is emptied. */
  deletedAt?: Iso;
}

export interface Thread {
  id: Uuid;
  doc: Uuid;
  anchor: Anchor;
  createdAt: Iso;
  createdBy: Author;
  resolvedAt?: Iso;
  resolvedBy?: Author;
  deletedAt?: Iso;
  comments: Comment[];
}

/** One change. Every change to comments is one of these, locally and on the server. */
export type Op =
  | { kind: "thread.create"; thread: Uuid; anchor: Anchor; comment: Uuid; body: string; mentions?: Mention[] }
  | { kind: "comment.add"; thread: Uuid; comment: Uuid; body: string; mentions?: Mention[] }
  | { kind: "comment.edit"; comment: Uuid; body: string; mentions?: Mention[] }
  | { kind: "comment.delete"; comment: Uuid }
  | { kind: "thread.resolve"; thread: Uuid; resolved: boolean }
  | { kind: "thread.move"; thread: Uuid; anchor: Anchor }
  | { kind: "thread.delete"; thread: Uuid };

/** An op as a client sends it. The same opId sent twice is applied once (idempotent retries). */
export interface OpEnvelope {
  opId: Uuid;
  doc: Uuid;
  /** The client's clock, for display only; order comes from the server's seq. */
  at: Iso;
  op: Op;
}

/** An op the server applied, in the order everyone sees. */
export interface Applied {
  seq: number;
  opId: Uuid;
  by: Author;
  /** The server's clock. */
  at: Iso;
  op: Op;
}

export type ErrorCode = "unauthenticated" | "forbidden" | "not_found" | "invalid" | "conflict" | "quota" | "version" | "server";

export interface Rejected {
  opId: Uuid;
  code: ErrorCode;
  message: string;
}

// ---------- the room socket: /v1/docs/:doc/socket ----------

export type ClientMessage =
  | { type: "hello"; protocol: number; doc: Uuid; since: number }
  | { type: "ops"; ops: OpEnvelope[] };

export type ServerMessage =
  | { type: "welcome"; protocol: number; server: string; role: Role; me: Author; seq: number; threads?: Thread[] }
  | { type: "applied"; entries: Applied[] }
  | { type: "ack"; opId: Uuid; seq: number }
  | { type: "reject"; rejected: Rejected[] }
  | { type: "error"; code: ErrorCode; message: string };

// ---------- REST ----------

/** GET /v1/info, open to anyone who passed Access: what this server is and can do. */
export interface ServerInfo {
  protocol: number;
  /** The server template's version, e.g. "0.1.0". */
  server: string;
  capabilities: string[];
}

/** A people rule (owner only: GET and PUT /v1/people). An email rule beats a domain rule; a deny beats any role. */
export interface PeopleRule {
  /** "anna@studio.com" or "@studio.com". Lower case. */
  match: string;
  role: Role | "deny";
}

// ---------- the local file: comments.json in the .canvas package ----------

export interface CommentsFile {
  format: 1;
  /** The document's comment identity. Save As makes a new one (a fork); a copy synced by a folder keeps it. */
  doc: Uuid;
  /** Set once the file is shared to a server. */
  server?: { url: string };
  /** The last server seq this file has applied. */
  seq: number;
  threads: Thread[];
  /** Ops made here and not yet acknowledged by the server, oldest first. Empty for a file never shared. */
  outbox: OpEnvelope[];
  /** Who this app is on the server (from /v1/me), so the page can tell its own comments. Shared files only. */
  me?: Author;
  /** Comments an agent wrote here through MCP and this app sent as its person: comment id to the agent, shown as the agent on this Mac only. */
  relayed?: Record<Uuid, Author>;
  /** Ops the server refused, kept so nothing typed is lost; shown to the person. */
  rejected?: { envelope: OpEnvelope; code: ErrorCode; message: string }[];
}

// ---------- limits both sides enforce ----------

export const LIMITS = {
  bodyChars: 10_000,
  opsPerMessage: 100,
  opsPerMinutePerUser: 120,
  threadsPerDoc: 5_000,
  commentsPerThread: 500,
  socketsPerUserPerDoc: 5,
  anchorBytes: 2_048,
} as const;

// ---------- pure helpers (both sides use these, so they agree) ----------

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

const ANCHOR_KEYS = new Set(["page", "nodeId", "x", "y", "board", "revision", "preview"]);
const PREVIEW_KEYS = new Set(["name", "type", "width", "height"]);
const shortText = (v: unknown, max: number) => v === undefined || (typeof v === "string" && v.length <= max);

/** Null when an anchor is small and plain: known keys only, short strings, finite numbers, under LIMITS.anchorBytes. */
export function checkAnchor(a: unknown): string | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return "anchor is not an object";
  const x = a as Record<string, unknown>;
  if (Object.keys(x).some((k) => !ANCHOR_KEYS.has(k))) return "anchor has an unknown key";
  if (!finite(x.x) || !finite(x.y)) return "anchor needs finite x and y";
  if (!shortText(x.page, 200) || !shortText(x.nodeId, 200) || !shortText(x.board, 200) || !shortText(x.revision, 64)) return "anchor text is too long";
  if (x.preview !== undefined) {
    const p = x.preview as Record<string, unknown>;
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((k) => !PREVIEW_KEYS.has(k))) return "anchor preview is not plain";
    if (!shortText(p.name, 200) || !shortText(p.type, 40)) return "anchor preview text is too long";
    if ((p.width !== undefined && !finite(p.width)) || (p.height !== undefined && !finite(p.height))) return "anchor preview size is not a number";
  }
  return JSON.stringify(x).length > LIMITS.anchorBytes ? "anchor is too large" : null;
}

/** Null when the envelope is well formed, else why not. Shape and limits only; permissions are the server's job. */
export function checkEnvelope(e: unknown): string | null {
  if (!e || typeof e !== "object") return "not an object";
  const x = e as Partial<OpEnvelope>;
  if (!isUuid(x.opId)) return "opId is not a uuid";
  if (!isUuid(x.doc)) return "doc is not a uuid";
  if (typeof x.at !== "string" || x.at.length > 40) return "at is missing or too long";
  const op = x.op as Op | undefined;
  if (!op || typeof op !== "object") return "op is missing";
  const body = (b: unknown) => (typeof b !== "string" ? "body is not text" : b.trim() === "" ? "body is empty" : b.length > LIMITS.bodyChars ? "body is too long" : null);
  const mentions = (op: { body: string; mentions?: Mention[] }) => {
    if (op.mentions === undefined) return null;
    if (!Array.isArray(op.mentions) || op.mentions.length > 100) return "invalid mentions";
    let end = 0;
    for (const m of op.mentions) {
      if (!m || !Number.isInteger(m.start) || !Number.isInteger(m.end) || m.start < end || m.end <= m.start || m.end > op.body.length || typeof m.name !== "string" || !m.name || m.name.length > 120 || op.body.slice(m.start, m.end) !== "@" + m.name || (m.email !== undefined && (typeof m.email !== "string" || m.email.length > 254)) || (m.id !== undefined && (typeof m.id !== "string" || m.id.length > 120))) return "invalid mentions";
      end = m.end;
    }
    return null;
  };
  const anchor = (a: unknown) => checkAnchor(a);
  switch (op.kind) {
    case "thread.create": return !isUuid(op.thread) || !isUuid(op.comment) ? "thread and comment need uuids" : anchor(op.anchor) ?? body(op.body) ?? mentions(op);
    case "comment.add": return !isUuid(op.thread) || !isUuid(op.comment) ? "thread and comment need uuids" : body(op.body) ?? mentions(op);
    case "comment.edit": return !isUuid(op.comment) ? "comment needs a uuid" : body(op.body) ?? mentions(op);
    case "comment.delete": return !isUuid(op.comment) ? "comment needs a uuid" : null;
    case "thread.resolve": return !isUuid(op.thread) || typeof op.resolved !== "boolean" ? "thread needs a uuid and resolved a boolean" : null;
    case "thread.move": return !isUuid(op.thread) ? "thread needs a uuid" : anchor(op.anchor);
    case "thread.delete": return !isUuid(op.thread) ? "thread needs a uuid" : null;
    default: return "unknown op kind";
  }
}

/**
 * Applies one op to a list of threads (in place) the way the server does. Returns null when applied, or a conflict
 * reason when the op cannot apply (its thread or comment is deleted or unknown). The local file uses it for its own
 * ops; the server for everyone's, in seq order.
 */
export function applyOp(threads: Thread[], doc: Uuid, op: Op, by: Author, at: Iso): string | null {
  const thread = (id: Uuid) => threads.find((t) => t.id === id);
  const comment = (id: Uuid) => { for (const t of threads) { const c = t.comments.find((c) => c.id === id); if (c) return { t, c }; } return null; };
  switch (op.kind) {
    case "thread.create": {
      if (thread(op.thread)) return "thread exists";
      if (comment(op.comment)) return "comment exists";
      threads.push({ id: op.thread, doc, anchor: op.anchor, createdAt: at, createdBy: by, comments: [{ id: op.comment, thread: op.thread, author: by, body: op.body, ...(op.mentions?.length ? { mentions: structuredClone(op.mentions) } : {}), createdAt: at }] });
      return null;
    }
    case "comment.add": {
      const t = thread(op.thread);
      if (!t) return "no such thread";
      if (t.deletedAt) return "thread deleted";
      if (comment(op.comment)) return "comment exists";
      if (t.comments.length >= LIMITS.commentsPerThread) return "thread is full";
      t.comments.push({ id: op.comment, thread: t.id, author: by, body: op.body, ...(op.mentions?.length ? { mentions: structuredClone(op.mentions) } : {}), createdAt: at });
      return null;
    }
    case "comment.edit": {
      const f = comment(op.comment);
      if (!f) return "no such comment";
      if (f.c.deletedAt || f.t.deletedAt) return "comment deleted";
      f.c.body = op.body; f.c.editedAt = at;
      if (op.mentions?.length) f.c.mentions = structuredClone(op.mentions); else delete f.c.mentions;
      return null;
    }
    case "comment.delete": {
      const f = comment(op.comment);
      if (!f) return "no such comment";
      if (!f.c.deletedAt) { f.c.deletedAt = at; f.c.body = ""; delete f.c.mentions; }
      return null;
    }
    case "thread.resolve": {
      const t = thread(op.thread);
      if (!t) return "no such thread";
      if (t.deletedAt) return "thread deleted";
      if (op.resolved) { t.resolvedAt = at; t.resolvedBy = by; } else { delete t.resolvedAt; delete t.resolvedBy; }
      return null;
    }
    case "thread.move": {
      const t = thread(op.thread);
      if (!t) return "no such thread";
      if (t.deletedAt) return "thread deleted";
      t.anchor = op.anchor;
      return null;
    }
    case "thread.delete": {
      const t = thread(op.thread);
      if (!t) return "no such thread";
      if (!t.deletedAt) { t.deletedAt = at; for (const c of t.comments) { c.deletedAt ??= at; c.body = ""; } }
      return null;
    }
  }
}

/**
 * Who may change what: authors edit and delete their own comments; owners and editors may delete any. A thread is
 * moved (its pin dragged, or put on a layer again) by its author or an owner, as editing goes: not by other editors.
 */
export function mayApply(op: Op, role: Role, me: Author, threads: Thread[]): boolean {
  if (!CAN_COMMENT[role]) return false;
  const same = (a: Author) => (a.id || me.id ? !!a.id && a.id === me.id : !!a.email && a.email === me.email);
  const own = (id: Uuid) => threads.some((t) => t.comments.some((c) => c.id === id && same(c.author)));
  const ownThread = (id: Uuid) => threads.some((t) => t.id === id && same(t.createdBy));
  const admin = role === "owner" || role === "editor";
  switch (op.kind) {
    case "comment.edit": return own(op.comment);
    case "comment.delete": return own(op.comment) || admin;
    case "thread.delete": return ownThread(op.thread) || admin;
    case "thread.move": return ownThread(op.thread) || role === "owner";
    default: return true;
  }
}

/** The role for an email under a list of people rules: deny beats all, then an exact email, then its domain. */
export function roleFor(email: string, rules: PeopleRule[]): Role | null {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  const domain = e.slice(at);
  const exact = rules.filter((r) => r.match === e);
  const byDomain = rules.filter((r) => r.match === domain);
  if ([...exact, ...byDomain].some((r) => r.role === "deny")) return null;
  const pick = exact[0] ?? byDomain[0];
  return pick && pick.role !== "deny" ? pick.role : null;
}
