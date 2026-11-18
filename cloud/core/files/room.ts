// A Cloud file room: orders every action, checks it against its own rows with the shared apply, applies it whole or
// not at all, and hands back what to send. Plain logic over a SqlStore and an ObjectStore, so the Worker's Durable
// Object and a Cloud hosted on a Mac run the same code; sockets, alarms and the Team stay with the adapter.
//
// One SQLite transaction per action holds everything it changes: the rows, its log row, its receipt, its text edits,
// the dirty boards and the room's seq. A crash anywhere before the commit leaves no trace; a resend after the commit
// is answered from the receipt and never applies twice.

import type { SqlStore } from "../sql.ts";
import { initFileRoomSchema } from "./room-schema.ts";
import { SqlTree } from "./tree-sql.ts";
import { materialize, stateFromFiles, type FileState } from "./state.ts";
import { transformSplice, textEditsOf, MAX_TEXT_EDITS, type TextEdit } from "./text.ts";
import { actionSha, CAN_EDIT, type ActionsMessage, type FileRejectCode, type FileServerMessage, type Hello, type Role, type Welcome } from "./messages.ts";
import { applyAction as sharedApply, isReject, actionBytes, FILE_LIMITS, type Action, type AppliedAction, type ApplyFn, type Author, type FileOp, type Json, type Reject } from "./seam.ts";
import type { ObjectStore } from "./objects.ts";
import type { RoleCache } from "./access.ts";
import type { RoomLeases } from "./leases.ts";

export const ROOM_LIMITS = { ...FILE_LIMITS, opsPerMessage: 100, actionsPerMessage: 100, pendingInHello: 500, actionIdLength: 100, jsonDepth: 300, jsonValues: 300_000 };
export const RECEIPT_DAYS = 30;
/** Node data per file (Section 3). */
export const FILE_NODE_CAP = 500 * 1024 * 1024;
export const DAY_MS = 86_400_000;

export interface Conn {
  author: Author;
  /** The role the socket was opened with; a RoleCache (when the room has one) has the last word. */
  role: Role;
}
export interface FileRoomOptions {
  store: SqlStore;
  objects: ObjectStore;
  file: string;
  now?: () => number;
  apply?: ApplyFn;
  /** Who may do what: the Team through a RoleCache (re-checked every 60 s, pushes in force at once), or "socket", which trusts
   *  the role the socket was opened with and never sees a removal (tests and a single process only). Required, so no
   *  adapter forgets it. */
  roles: RoleCache | "socket";
  leases?: RoomLeases;
  /** Tests: called at each step inside an action's transaction; a throw there is a crash before the commit. */
  fault?: (point: "applied" | "logged" | "receipted") => void;
}
export interface SubmitResult {
  /** To the sender, in order. */
  replies: FileServerMessage[];
  /** To every socket of the room (the sender too), as one `applied` message. */
  applied: AppliedAction[];
}
export interface RoomMeta {
  file: string;
  epoch: number;
  seq: number;
  logFloor: number;
  receiptFloor: number;
  snapshotSeq: number;
}

/**
 * Why a value from the wire is too deep or too big to walk (null: it is not). Iterative, so a crafted value cannot
 * overflow the stack here; everything after it (hashing, the apply, snapshots) then walks a bounded value.
 */
export function jsonShapeError(v: unknown, maxDepth: number, maxValues: number): string | null {
  const stack: [unknown, number][] = [[v, 1]];
  let seen = 0;
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (++seen > maxValues) return `an action holds at most ${maxValues} values`;
    if (x === null || typeof x !== "object") {
      if (typeof x === "number" && !Number.isFinite(x)) return "numbers must be finite";
      if (x !== null && typeof x !== "string" && typeof x !== "number" && typeof x !== "boolean") return "an action holds JSON only";
      continue;
    }
    if (d > maxDepth) return `an action nests at most ${maxDepth} levels`;
    for (const c of Array.isArray(x) ? x : Object.values(x)) stack.push([c, d + 1]);
  }
  return null;
}

/** A browser layer's address, or an override's: a Cloud file loads no web page (it would tell a site every viewer's address). */
function webAddressIn(ops: FileOp[], typeOf: (id: string) => string | undefined): string | null {
  const has = (v: unknown) => typeof v === "string" && v !== "";
  const inNode = (n: unknown): string | null => {
    const stack = [n];
    while (stack.length) {
      const x = stack.pop() as Record<string, unknown> | null;
      if (!x || typeof x !== "object" || Array.isArray(x)) continue;
      if (x.type === "browser" && has(x.url)) return String(x.url);
      if (x.type === "ref" && x.descendants && typeof x.descendants === "object") for (const o of Object.values(x.descendants)) if (o && typeof o === "object" && has((o as Record<string, unknown>).url)) return String((o as Record<string, unknown>).url);
      if (Array.isArray(x.children)) stack.push(...x.children);
    }
    return null;
  };
  for (const op of ops) {
    if (op.k === "insert") {
      const hit = inNode(op.node);
      if (hit) return hit;
    } else if (op.k === "set") {
      const type = typeOf(op.id);
      for (const [k, val] of Object.entries(op.props)) {
        const v = val?.v as Record<string, unknown> | undefined;
        if (k === "url" && (type === "browser" || type === "ref") && has(v)) return String(v);
        if (k.startsWith("descendants/") && v && typeof v === "object" && has(v.url)) return String(v.url);
        if (k === "descendants" && v && typeof v === "object") for (const o of Object.values(v)) if (o && typeof o === "object" && has((o as Record<string, unknown>).url)) return String((o as Record<string, unknown>).url);
      }
    }
  }
  return null;
}

class Refusal extends Error {
  code: FileRejectCode;
  constructor(code: FileRejectCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Usage the room counts in memory and writes with its next snapshot (an estimate; a crash may drop the last few). */
export type Usage = { messages: number; actions: number; rowsWritten: number; rowsRead: number; bytesIn: number };

export class FileRoom {
  readonly store: SqlStore;
  readonly objects: ObjectStore;
  readonly file: string;
  readonly tree: SqlTree;
  readonly now: () => number;
  private readonly apply: ApplyFn;
  private readonly roles: RoleCache | "socket";
  private readonly leases?: RoomLeases;
  private readonly fault?: FileRoomOptions["fault"];
  private lock: Promise<unknown> = Promise.resolve();
  usage: Usage = { messages: 0, actions: 0, rowsWritten: 0, rowsRead: 0, bytesIn: 0 };
  /** Rows written by the last applied action (the meter the plan's cost table uses). */
  lastRowsWritten = 0;
  /** Rows written by every action this room object applied. */
  rowsWrittenTotal = 0;

  constructor(o: FileRoomOptions) {
    this.store = o.store;
    this.objects = o.objects;
    this.file = o.file;
    this.now = o.now ?? Date.now;
    this.apply = o.apply ?? sharedApply;
    this.roles = o.roles;
    this.leases = o.leases;
    this.fault = o.fault;
    initFileRoomSchema(this.store, this.file);
    this.tree = new SqlTree(this.store);
  }

  meta(): RoomMeta {
    const r = this.store.sql.exec<{ file: string; epoch: number; seq: number; log_floor: number; receipt_floor: number; snapshot_seq: number }>(
      "SELECT file, epoch, seq, log_floor, receipt_floor, snapshot_seq FROM file_meta WHERE id = 1",
    ).one();
    return { file: r.file, epoch: r.epoch, seq: r.seq, logFloor: r.log_floor, receiptFloor: r.receipt_floor, snapshotSeq: r.snapshot_seq };
  }

  /** Run `fn` with no other snapshot build, collection, restore or upload of this room in between. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Put a whole file in an empty room at seq 0 (a new file, or an import's first state). */
  seed(document: Record<string, Json>, envelope: Record<string, Json> = {}): void {
    this.seedState(stateFromFiles(document, envelope));
  }
  seedState(state: FileState): void {
    this.store.transactionSync(() => {
      const m = this.meta();
      if (m.seq !== 0 || this.store.sql.exec("SELECT 1 FROM nodes LIMIT 1").toArray().length) throw new Error("this room already holds a file");
      this.tree.seq = 0;
      this.tree.load(state);
      this.store.sql.exec("DELETE FROM dirty_boards");
    });
    this.tree.forget();
  }

  materialize() {
    this.tree.forget();
    return materialize(this.tree);
  }

  /** Applied actions after `since`, in seq order (contiguous: the log holds every action after the log floor). */
  tail(since: number): AppliedAction[] {
    return this.store.sql
      .exec<{ first: number; last: number; action: string; by_json: string; at: string; ops_json: string }>("SELECT first, last, action, by_json, at, ops_json FROM log WHERE first > ? ORDER BY first", since)
      .toArray()
      .map((r) => ({ first: r.first, last: r.last, id: r.action, by: JSON.parse(r.by_json), at: r.at, ops: JSON.parse(r.ops_json) }));
  }

  /** The role this room acts on for `conn` now (uploads ask it too). */
  roleFor(conn: Conn): Role | null {
    return this.roles === "socket" ? conn.role : this.roles.role(conn.author.id);
  }
  /** True once a fault hook threw: the room is gone, and the error leaves it. */
  private killed = false;
  private faultAt(point: "applied" | "logged" | "receipted"): void {
    try {
      this.fault?.(point);
    } catch (e) {
      this.killed = true;
      throw e;
    }
  }

  /** A socket's hello: the welcome, then (in the same turn) the tail it is missing. */
  hello(conn: Conn, h: Hello): FileServerMessage[] {
    this.usage.messages++;
    const role = this.roleFor(conn);
    if (!role) return [{ type: "error", code: "forbidden", message: "you are not a member of this Cloud" }];
    if (!h || h.type !== "hello" || h.file !== this.file) return [{ type: "error", code: "invalid", message: "this socket is for another file" }];
    const m = this.meta();
    const out: FileServerMessage[] = [];
    const since = Number.isSafeInteger(h.since) && h.since >= 0 ? h.since : 0;
    const staleEpoch = h.epoch !== m.epoch;
    if (h.epoch && staleEpoch) out.push({ type: "reset", epoch: m.epoch, reason: "restored" });
    let from = since;
    let snapshot: Welcome["snapshot"];
    if (staleEpoch || since < m.logFloor || since > m.seq) {
      const s = this.store.sql.exec<{ seq: number; manifest: string }>("SELECT seq, manifest FROM snapshots WHERE state = 'done' AND seq >= ? ORDER BY seq DESC LIMIT 1", m.logFloor).toArray()[0];
      if (!s) return [{ type: "error", code: "invalid", message: "this file has no snapshot to start from yet" }];
      snapshot = { seq: s.seq, manifest: s.manifest };
      from = s.seq;
    }
    const pending = Array.isArray(h.pending) ? h.pending.slice(0, ROOM_LIMITS.pendingInHello) : [];
    const known: Welcome["known"] = [];
    for (const p of pending) {
      if (!p || typeof p.id !== "string") continue;
      const r = this.receipt(p.id);
      if (r && r.sha === p.sha && r.by_id === conn.author.id) known.push({ id: p.id, first: r.first, last: r.last });
    }
    out.push({ type: "welcome", protocol: 2, role, me: conn.author, epoch: m.epoch, seq: m.seq, ...(snapshot ? { snapshot } : {}), known, limits: { opsPerMessage: ROOM_LIMITS.opsPerMessage, actionBytes: ROOM_LIMITS.actionBytes } });
    const tail = this.tail(from);
    if (tail.length) out.push({ type: "applied", actions: tail });
    return out;
  }

  private receipt(id: string) {
    return this.store.sql.exec<{ by_id: string; epoch: number; sha: string; first: number; last: number }>("SELECT by_id, epoch, sha, first, last FROM receipts WHERE action = ?", id).toArray()[0];
  }

  /** The text edits a layer had after `since`, in seq order (at most MAX_TEXT_EDITS + 1 of them). */
  textEditsSince(node: string, since: number): TextEdit[] {
    return this.store.sql
      .exec<{ node: string; seq: number; action: string; whole: number; from_: number; del: number; ins: number }>("SELECT node, seq, action, whole, from_, del, ins FROM text_edits WHERE node = ? AND seq > ? ORDER BY seq LIMIT ?", node, since, MAX_TEXT_EDITS + 1)
      .toArray()
      .map((r) => ({ node: r.node, seq: r.seq, action: r.action, whole: !!r.whole, from: r.from_, del: r.del, ins: r.ins }));
  }

  /** An `actions` message. Each action applies whole or is refused on its own; nothing is half done. */
  submit(conn: Conn, msg: ActionsMessage, bytesIn = 0): SubmitResult {
    this.usage.messages++;
    this.usage.bytesIn += bytesIn;
    const replies: FileServerMessage[] = [];
    const applied: AppliedAction[] = [];
    if (!msg || msg.type !== "actions" || !Array.isArray(msg.actions)) return { replies: [{ type: "error", code: "invalid", message: "an actions message holds a list of actions" }], applied };
    if (msg.actions.length > ROOM_LIMITS.actionsPerMessage) return { replies: [{ type: "error", code: "invalid", message: `a message holds at most ${ROOM_LIMITS.actionsPerMessage} actions` }], applied };
    const total = msg.actions.reduce((n, a) => n + (a && Array.isArray(a.ops) ? a.ops.length : 0), 0);
    if (total > ROOM_LIMITS.opsPerMessage) return { replies: [{ type: "error", code: "invalid", message: `a message holds at most ${ROOM_LIMITS.opsPerMessage} ops` }], applied };
    if (this.leases && !this.leases.take(conn.author.id, "messages", 1)) {
      for (const a of msg.actions) replies.push({ type: "reject", id: a && typeof a.id === "string" ? a.id : "", code: "quota", message: "too many messages this minute; your edits wait and go on their own" });
      return { replies, applied };
    }
    for (const a of msg.actions) {
      const id = a && typeof a.id === "string" ? a.id : "";
      try {
        const r = this.one(conn, msg.epoch, a);
        if ("duplicate" in r) replies.push({ type: "ack", id, first: r.first, last: r.last });
        else {
          applied.push(r);
          replies.push({ type: "ack", id, first: r.first, last: r.last });
        }
      } catch (e) {
        // A crash (the process is going away) leaves the room; anything else this action threw is its own refusal,
        // so the actions before it in the message keep their acks and broadcast.
        if (this.killed) throw e;
        if (e instanceof Refusal) replies.push({ type: "reject", id, code: e.code, message: e.message });
        else replies.push({ type: "reject", id, code: "invalid", message: `the room could not apply this action: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
      }
    }
    return { replies, applied };
  }

  private one(conn: Conn, epoch: number, a: Action): AppliedAction | { duplicate: true; first: number; last: number } {
    const m = this.meta();
    if (epoch !== m.epoch) throw new Refusal("reset", "this file was restored; open it again");
    if (!a || typeof a !== "object" || typeof a.id !== "string" || !a.id || a.id.length > ROOM_LIMITS.actionIdLength) throw new Refusal("invalid", "an action needs an id");
    if (!Array.isArray(a.ops)) throw new Refusal("invalid", "an action needs a list of ops");
    if (!Number.isSafeInteger(a.baseSeq) || a.baseSeq < 0) throw new Refusal("invalid", "an action needs the seq it was made on");
    if (a.epoch !== m.epoch) throw new Refusal("reset", "this action was made before the file was restored");
    // Who may edit comes before any work on the payload; its shape is bounded before anything walks it recursively.
    const role = this.roleFor(conn);
    if (!role || !CAN_EDIT[role]) throw new Refusal("forbidden", role ? "your role in this Cloud cannot edit files" : "you are not a member of this Cloud");
    if (!a.ops.length) throw new Refusal("invalid", "an action holds at least one op");
    if (a.ops.length > ROOM_LIMITS.opsPerAction) throw new Refusal("invalid", `an action holds at most ${ROOM_LIMITS.opsPerAction} ops`);
    const shape = jsonShapeError(a, ROOM_LIMITS.jsonDepth, ROOM_LIMITS.jsonValues);
    if (shape) throw new Refusal("invalid", shape);
    const sha = actionSha(a);
    const rec = this.receipt(a.id);
    if (rec) {
      if (rec.sha === sha && rec.by_id === conn.author.id && rec.epoch === a.epoch) return { duplicate: true, first: rec.first, last: rec.last };
      throw new Refusal("invalid", "another action already has this id");
    }
    if (a.baseSeq < m.receiptFloor) throw new Refusal("expired", "this edit was made on a version older than the Cloud keeps; your version is kept as a copy");
    if (a.baseSeq > m.seq) throw new Refusal("invalid", "this action names a seq the file has not reached");
    if (actionBytes(a) > ROOM_LIMITS.actionBytes) throw new Refusal("invalid", "an action holds at most 1 MB");
    if (this.leases && !this.leases.take(conn.author.id, "ops", Math.max(1, a.ops.length))) throw new Refusal("quota", "too many edits this minute; they wait and go on their own");

    const ops: FileOp[] = a.ops.map((op) => {
      if (!op || typeof op !== "object" || op.k !== "text") return op;
      if (typeof op.id !== "string" || !Number.isSafeInteger(op.baseSeq) || op.baseSeq < 0) throw new Refusal("invalid", "text: the op needs a layer and the seq it was typed on");
      if (op.baseSeq > m.seq) throw new Refusal("invalid", "text: the op names a seq the file has not reached");
      if (op.baseSeq < m.logFloor) throw new Refusal("conflict", "this text was typed on a version older than the Cloud keeps; your text is kept as a copy");
      const t = transformSplice(op, this.textEditsSince(op.id, op.baseSeq));
      if ("conflict" in t) throw new Refusal("conflict", t.conflict);
      return { ...op, from: t.from, del: t.del };
    });

    const first = m.seq + 1;
    const at = new Date(this.now()).toISOString();
    const before = this.tree.rowsWritten;
    let result!: AppliedAction;
    try {
      this.store.transactionSync(() => {
        this.tree.seq = first;
        this.tree.bytesDelta = 0;
        const r = this.apply(this.tree, { ...a, ops, at }, { by: conn.author, seq: first, limits: FILE_LIMITS, confine: true });
        if (isReject(r)) throw new Refusal(r.reject, (r as Reject).message);
        this.uploadsFor(ops);
        this.faultAt("applied");
        const last = r.last;
        const w = (q: string, ...b: unknown[]) => {
          this.store.sql.exec(q, ...b);
          this.tree.rowsWritten++;
        };
        w("INSERT INTO log (first, last, action, by_json, at, ops_json) VALUES (?, ?, ?, ?, ?, ?)", first, last, a.id, JSON.stringify(conn.author), at, JSON.stringify(r.ops));
        this.faultAt("logged");
        w("INSERT INTO receipts (action, by_id, epoch, sha, first, last, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)", a.id, conn.author.id, a.epoch, sha, first, last, this.now());
        this.faultAt("receipted");
        for (const e of textEditsOf(r)) w("INSERT INTO text_edits (node, seq, action, whole, from_, del, ins) VALUES (?, ?, ?, ?, ?, ?, ?)", e.node, e.seq, e.action, e.whole ? 1 : 0, e.from, e.del, e.ins);
        const bytes = this.store.sql.exec<{ n: number }>("SELECT node_bytes AS n FROM file_meta WHERE id = 1").one().n + this.tree.bytesDelta;
        if (this.tree.bytesDelta > 0 && bytes > FILE_NODE_CAP) throw new Refusal("quota", `this file is full: it holds at most ${FILE_NODE_CAP / 1024 / 1024} MB of layers`);
        w("UPDATE file_meta SET seq = ?, node_bytes = ? WHERE id = 1", last, bytes);
        result = { ...r, first, last };
      });
    } catch (e) {
      this.tree.forget();
      throw e;
    }
    this.lastRowsWritten = this.tree.rowsWritten - before;
    this.rowsWrittenTotal += this.lastRowsWritten;
    this.usage.actions++;
    this.usage.rowsWritten += this.lastRowsWritten;
    return result;
  }

  /**
   * A blob op names bytes this file holds already or an upload of this file that stored them (uploads.ts); applying
   * the action makes those uploads part of the file, so their 24 hour grace no longer applies.
   */
  private uploadsFor(ops: FileOp[]): void {
    for (const op of ops) {
      if (!op || op.k !== "blob" || typeof op.sha256 !== "string") continue;
      // The size and type come from what was stored, never from the op: a blob op that claims 0 bytes would dodge the
      // file's cap, one that names PNG bytes a shader would hand them to the shader compiler.
      type Src = { bytes: number; type: string };
      const had = this.store.sql.exec<Src>("SELECT bytes, type FROM blobs WHERE sha256 = ? AND added_seq < ? LIMIT 1", op.sha256, this.tree.seq).toArray()[0];
      const up = this.store.sql.exec<Src & { id: string }>("SELECT id, bytes, type FROM uploads WHERE sha256 = ? AND state IN ('stored', 'used') LIMIT 1", op.sha256).toArray()[0];
      const src = had ?? up;
      if (!src) throw new Refusal("invalid", `blob: the bytes of ${String(op.path)} were not uploaded`);
      if (src.bytes !== op.bytes || src.type !== op.type) throw new Refusal("invalid", `blob: ${String(op.path)} names ${op.bytes} bytes of ${op.type}; the stored file is ${src.bytes} bytes of ${src.type}`);
      // A Mac's disk folds case: media/Logo.png and media/logo.png would be one file there.
      const twin = this.store.sql.exec<{ path: string }>("SELECT path FROM blobs WHERE lower(path) = lower(?) AND path != ? LIMIT 1", op.path, op.path).toArray()[0];
      if (twin) throw new Refusal("conflict", `blob: ${String(op.path)} and ${twin.path} differ only by case; a Mac would keep one file for both`);
      if (up) this.store.sql.exec("UPDATE uploads SET state = 'used' WHERE sha256 = ? AND state = 'stored'", op.sha256);
    }
    const web = webAddressIn(ops, (id) => this.tree.node(id)?.type);
    if (web) throw new Refusal("forbidden", `"${web.slice(0, 100)}" is a web page; a layer in a Cloud file loads none, as that would tell the site every viewer's address`);
  }

  /** Write the usage counted in memory to today's row (snapshots call it; an adapter may on its alarm). */
  flushUsage(): void {
    const u = this.usage;
    if (!u.messages && !u.actions) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    this.store.sql.exec(
      `INSERT INTO usage_days (day, messages, actions, rows_written, rows_read, bytes_in) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET messages = messages + excluded.messages, actions = actions + excluded.actions,
       rows_written = rows_written + excluded.rows_written, rows_read = rows_read + excluded.rows_read, bytes_in = bytes_in + excluded.bytes_in`,
      day, u.messages, u.actions, u.rowsWritten, this.tree.rowsRead, u.bytesIn,
    );
    this.tree.rowsRead = 0;
    this.usage = { messages: 0, actions: 0, rowsWritten: 0, rowsRead: 0, bytesIn: 0 };
  }
}
