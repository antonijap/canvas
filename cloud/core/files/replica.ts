// A Mac's side of a Cloud file, as plain state: the confirmed copy (server order), the actions it made that the room
// has not confirmed, and the ones the room refused. The view is confirmed + pending, rebuilt with the shared apply.
// This is the model the tests and the fuzz run drive; Phase 3 builds src/cloud-files-tree.ts and state.sqlite on it.
//
// Rules it keeps: applied actions only in seq order (seq = mine + 1, else ask again with a hello); an action once
// sent is never changed and is resent byte for byte; a text op is made only on a layer whose text no pending action
// of this Mac changes, so its splice is relative to the confirmed text at its baseSeq and the room can move it.

import { MemoryTree } from "./tree-memory.ts";
import { treeFromManifest } from "./snapshots.ts";
import { textEditsOf, transformSplice, type TextEdit } from "./text.ts";
import { actionSha, type FileRejectCode, type FileServerMessage, type Hello } from "./messages.ts";
import { applyAction, isReject, FILE_LIMITS, type Action, type AppliedAction, type ApplyFn, type Author, type FileOp, type Reject } from "./seam.ts";
import type { ObjectStore } from "./objects.ts";
import type { FileState } from "./state.ts";

export type Pending = { action: Action; sha: string; sent: boolean };
export type Refused = { action: Action; code: FileRejectCode | "local"; message: string };

/** What a Mac commits durably (state.sqlite in Phase 3): enough to come back after a crash. */
export interface ReplicaDurable {
  state: FileState;
  seq: number;
  epoch: number;
  textEdits: TextEdit[];
  pending: Pending[];
  refused: Refused[];
}

export class Divergence extends Error {}

let counter = 0;
const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `a-${Date.now().toString(36)}-${(counter++).toString(36)}`);

export class Replica {
  readonly author: Author;
  tree: MemoryTree;
  seq: number;
  epoch: number;
  textEdits: TextEdit[] = [];
  pending: Pending[] = [];
  refused: Refused[] = [];
  /** Set after a welcome; applied messages before it are ignored. */
  joined = false;
  /** A gap or a reset: the socket must say hello again. */
  needHello = true;
  private readonly apply: ApplyFn;
  readonly newId: () => string;

  constructor(author: Author, state: FileState, seq: number, epoch: number, o: { apply?: ApplyFn; newId?: () => string } = {}) {
    this.author = author;
    this.tree = new MemoryTree(state);
    this.seq = seq;
    this.epoch = epoch;
    this.apply = o.apply ?? applyAction;
    this.newId = o.newId ?? uuid;
  }

  durable(): ReplicaDurable {
    return structuredClone({ state: this.tree.state(), seq: this.seq, epoch: this.epoch, textEdits: this.textEdits, pending: this.pending, refused: this.refused });
  }
  static restore(author: Author, d: ReplicaDurable, o: { apply?: ApplyFn; newId?: () => string } = {}): Replica {
    const r = new Replica(author, d.state, d.seq, d.epoch, o);
    const c = structuredClone(d);
    r.textEdits = c.textEdits;
    r.pending = c.pending.map((p) => ({ ...p, sent: false }));
    r.refused = c.refused;
    return r;
  }

  private ctx(seq: number, by: Author = this.author) {
    return { by, seq, limits: FILE_LIMITS, confine: true };
  }

  /** A text op of a pending action moved over what the room confirmed since its baseSeq (for the view only). */
  private local(op: FileOp): FileOp | null {
    if (op.k !== "text") return op;
    const t = transformSplice(op, this.textEdits.filter((e) => e.node === op.id && e.seq > op.baseSeq));
    return "conflict" in t ? null : { ...op, from: t.from, del: t.del };
  }

  /** Confirmed + pending, as the person sees it. A pending action that no longer fits is left out ("waiting"). */
  view(): MemoryTree {
    const v = this.tree.copy();
    for (const p of this.pending) {
      const ops = p.action.ops.map((op) => this.local(op));
      if (ops.some((o) => o === null)) continue;
      this.apply(v, { ...p.action, ops: ops as FileOp[] }, this.ctx(0));
    }
    return v;
  }

  /** May a text op on `id` be made now: the layer's text is the confirmed text (no pending action of this Mac changed
   *  it), so a splice on the view is a splice on the confirmed text at this seq. */
  canType(id: string, view: MemoryTree = this.view()): boolean {
    const c = this.tree.node(id), v = view.node(id);
    if (!c || !v || typeof c.props.content !== "string" || c.props.content !== v.props.content) return false;
    return !this.pending.some((p) => p.action.ops.some((op) => (op.k === "text" && op.id === id) || (op.k === "set" && op.id === id && ["content", "spans", "lists"].some((k) => Object.hasOwn(op.props, k)))));
  }

  /** A local edit: checked on the view, then pending. Returns the action, or why it does not fit (nothing changes). */
  propose(ops: FileOp[], at = new Date().toISOString()): Action | Reject {
    const view = this.view();
    for (const op of ops) if (op.k === "text" && !this.canType(op.id, view)) return { reject: "conflict", message: "this text has an edit waiting for the Cloud" };
    const ops2 = ops.map((op) => (op.k === "text" ? { ...op, baseSeq: this.seq } : op));
    const action: Action = { id: this.newId(), baseSeq: this.seq, epoch: this.epoch, at, ops: ops2 };
    const r = this.apply(view, action, this.ctx(0));
    if (isReject(r)) return r;
    this.pending.push({ action, sha: actionSha(action), sent: false });
    return action;
  }

  hello(file: string): Hello {
    this.joined = false;
    this.needHello = false;
    return { type: "hello", protocol: 2, file, since: this.seq, epoch: this.epoch, pending: this.pending.slice(0, 500).map((p) => ({ id: p.action.id, sha: p.sha })) };
  }

  /** Actions to send now, in order, at most `maxOps` ops in all; they are marked sent. */
  outgoing(maxOps = 100): Action[] {
    if (!this.joined) return [];
    const out: Action[] = [];
    let n = 0;
    for (const p of this.pending) {
      if (p.sent) continue;
      if (n + p.action.ops.length > maxOps && out.length) break;
      p.sent = true;
      out.push(p.action);
      n += p.action.ops.length;
    }
    return out;
  }

  /** Apply what the room confirmed. Returns "gap" when an action is missing before these (say hello again). */
  confirm(actions: AppliedAction[]): "ok" | "gap" {
    for (const a of actions) {
      if (a.last <= this.seq) continue;
      if (a.first !== this.seq + 1) {
        this.needHello = true;
        return "gap";
      }
      const r = this.apply(this.tree, { id: a.id, ops: a.ops, at: a.at }, this.ctx(a.first, a.by));
      if (isReject(r)) throw new Divergence(`the room applied ${a.id} at ${a.first}, this Mac cannot: ${r.message}`);
      this.seq = a.last;
      this.textEdits.push(...textEditsOf(a));
      if (this.textEdits.length > 2000) this.textEdits = this.textEdits.slice(-1000);
      this.pending = this.pending.filter((p) => p.action.id !== a.id);
    }
    return "ok";
  }

  private refuse(id: string, code: Refused["code"], message: string): void {
    const i = this.pending.findIndex((p) => p.action.id === id);
    if (i < 0) return;
    this.refused.push({ action: this.pending[i].action, code, message });
    this.pending.splice(i, 1);
  }

  /** Every pending action becomes a refused copy (the file was restored, or the edit is too old to apply). */
  private refuseAll(code: Refused["code"], message: string): void {
    for (const p of this.pending) this.refused.push({ action: p.action, code, message });
    this.pending = [];
  }

  /** One message from the room. Async only for a welcome that starts from a snapshot. */
  async receive(msg: FileServerMessage, objects: ObjectStore): Promise<"ok" | "gap" | "hello"> {
    switch (msg.type) {
      case "reset":
        this.refuseAll("reset", "the file was restored; your edits are kept as a copy");
        this.epoch = msg.epoch;
        this.joined = false;
        this.needHello = true;
        return "hello";
      case "welcome": {
        if (msg.epoch !== this.epoch) {
          if (this.epoch) this.refuseAll("reset", "the file was restored; your edits are kept as a copy");
          this.epoch = msg.epoch;
        }
        if (msg.snapshot) {
          const { tree, manifest } = await treeFromManifest(objects, msg.snapshot.manifest);
          this.tree = tree;
          this.seq = manifest.seq;
          this.textEdits = [];
          this.epoch = manifest.epoch;
        }
        const known = new Map(msg.known.map((k) => [k.id, k]));
        for (const p of this.pending) p.sent = known.has(p.action.id);
        this.pending = this.pending.filter((p) => !(known.has(p.action.id) && known.get(p.action.id)!.last <= this.seq));
        this.joined = true;
        return "ok";
      }
      case "applied":
        if (!this.joined) return "ok";
        return this.confirm(msg.actions);
      case "ack":
        return "ok";
      case "reject":
        if (msg.code === "reset") {
          this.refuse(msg.id, "reset", msg.message);
          this.needHello = true;
          return "hello";
        }
        this.refuse(msg.id, msg.code, msg.message);
        return "ok";
      case "error":
        this.needHello = true;
        return "hello";
    }
  }
}
