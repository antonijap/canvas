// A Cloud file room and several Macs in one process, on the memory adapter, with sockets as queues the caller steps
// by hand: what test/cloud-files-*.test.ts and qa/cloud-files-fuzz.ts drive. Sockets deliver in order (as TCP does);
// the caller decides which socket moves next, so deliveries between Macs interleave in any order. Macs and the room
// can crash at their commit points, and a socket can drop at any step.

import { FileRoom, type Conn, type FileRoomOptions } from "../cloud/core/files/room.ts";
import { NodeSqlStore } from "../cloud/core/files/memory.ts";
import { MemoryObjects } from "../cloud/core/files/objects.ts";
import { Replica, type ReplicaDurable } from "../cloud/core/files/replica.ts";
import { buildSnapshot, recoverSnapshots, treeFromManifest } from "../cloud/core/files/snapshots.ts";
import { materialize } from "../cloud/core/files/state.ts";
import type { ActionsMessage, FileServerMessage, Hello, Role } from "../cloud/core/files/messages.ts";
import type { AppliedAction, Author, FileOp, Json, Reject, Action } from "../cloud/core/files/seam.ts";

export const FILE = "0f9d6a52-3c1e-4b8a-9d47-2b6f1e0c7a11";

/** The seed every test starts from: two boards, a component and an instance of it, a text layer, one page. */
export function seedDocument(): { document: Record<string, Json>; envelope: Record<string, Json> } {
  return {
    document: {
      version: "2.22",
      children: [
        {
          id: "b1", type: "frame", name: "Board", x: 0, y: 0, width: 400, height: 300, children: [
            { id: "r1", type: "rectangle", name: "Box", x: 10, y: 10, width: 50, height: 50, fill: "#ff0000" },
            { id: "t1", type: "text", name: "Title", content: "Hello world", x: 0, y: 100 },
            { id: "c1", type: "frame", name: "Button", reusable: true, width: 80, height: 30, children: [{ id: "c1l", type: "text", content: "OK" }] },
            { id: "g1", type: "group", name: "Group", children: [{ id: "e1", type: "ellipse", width: 20, height: 20 }] },
          ],
        },
        { id: "b2", type: "frame", name: "Second", x: 500, y: 0, width: 400, height: 300, children: [{ id: "i1", type: "ref", ref: "c1", x: 10, y: 10 }] },
      ],
    },
    envelope: { widgets: [{ id: "w1", kind: "note", config: { text: "hi" } }], pages: [{ id: "p1", name: "Page 1", boards: ["b1", "b2"] }] },
  };
}

type Socket = { up: (Hello | ActionsMessage)[]; down: FileServerMessage[]; joined: boolean };

export class SimClient {
  replica: Replica;
  conn: Conn;
  socket: Socket | null = null;
  /** The last durable commit, and the one before the last receive (a crash before that receive's commit). */
  durable: ReplicaDurable;
  beforeReceive: ReplicaDurable | null = null;
  /** Every action this Mac committed (proposed), by id. */
  made = new Map<string, Action>();
  localRejects = 0;
  constructor(replica: Replica, role: Role) {
    this.replica = replica;
    this.conn = { author: replica.author, role };
    this.durable = replica.durable();
  }
  commit(): void {
    this.durable = this.replica.durable();
  }
}

export interface SimOptions {
  apply?: FileRoomOptions["apply"];
  fault?: FileRoomOptions["fault"];
  now?: () => number;
  seed?: { document: Record<string, Json>; envelope: Record<string, Json> };
}

export class Sim {
  readonly store = new NodeSqlStore();
  readonly objects = new MemoryObjects();
  room!: FileRoom;
  clients: SimClient[] = [];
  /** Every applied action the room broadcast, in order (a double apply shows here as an id twice). */
  log: AppliedAction[] = [];
  serverCrashes = 0;
  private readonly o: SimOptions;
  constructor(o: SimOptions = {}) {
    this.o = o;
    this.openRoom();
  }
  openRoom(): void {
    this.room = new FileRoom({ store: this.store, objects: this.objects, file: FILE, apply: this.o.apply, fault: this.o.fault, now: this.o.now });
    recoverSnapshots(this.room);
  }
  async init(): Promise<void> {
    const s = this.o.seed ?? seedDocument();
    this.room.seed(s.document, s.envelope);
    await buildSnapshot(this.room);
  }

  /** A Mac that opens the file from the room's latest snapshot. */
  async addClient(author: Author, role: Role = "editor"): Promise<SimClient> {
    const row = this.store.sql.exec<{ manifest: string }>("SELECT manifest FROM snapshots WHERE state = 'done' ORDER BY seq DESC LIMIT 1").one();
    const { tree, manifest } = await treeFromManifest(this.objects, row.manifest);
    let n = 0;
    const replica = new Replica(author, tree.state(), manifest.seq, manifest.epoch, { newId: () => `${author.id}-${this.clients.length}-${n++}-${Math.random().toString(36).slice(2, 8)}` });
    const c = new SimClient(replica, role);
    this.clients.push(c);
    return c;
  }

  connect(c: SimClient): void {
    c.socket = { up: [c.replica.hello(FILE)], down: [], joined: false };
  }
  drop(c: SimClient): void {
    c.socket = null;
    c.replica.joined = false;
  }
  /** Commit a local edit (pending, durable) and put it on the socket when one is open. */
  propose(c: SimClient, ops: FileOp[]): Action | Reject {
    const r = c.replica.propose(ops);
    if ("reject" in r) {
      c.localRejects++;
      return r;
    }
    c.made.set(r.id, r);
    c.commit();
    return r;
  }
  flush(c: SimClient): void {
    if (!c.socket || !c.replica.joined) return;
    for (;;) {
      const out = c.replica.outgoing(100);
      if (!out.length) break;
      c.socket.up.push({ type: "actions", epoch: c.replica.epoch, actions: out });
    }
  }

  /** The room takes the next message of `c`'s socket. A crash inside the room drops every socket. */
  serverStep(c: SimClient): boolean {
    const msg = c.socket?.up.shift();
    if (!msg || !c.socket) return false;
    if (msg.type === "hello") {
      c.socket.down.push(...this.room.hello(c.conn, msg));
      c.socket.joined = true;
      return true;
    }
    let res;
    try {
      res = this.room.submit(c.conn, msg, JSON.stringify(msg).length);
    } catch (e) {
      if (!String((e as Error).message).startsWith("crash")) throw e;
      this.crashServer();
      return true;
    }
    if (res.applied.length) {
      this.log.push(...res.applied);
      for (const x of this.clients) if (x.socket?.joined) x.socket.down.push({ type: "applied", actions: res.applied });
    }
    c.socket.down.push(...res.replies);
    return true;
  }

  /** `c` takes the next message from its socket, then commits (or crashes before the commit). */
  async clientStep(c: SimClient, crashBeforeCommit = false): Promise<boolean> {
    const msg = c.socket?.down.shift();
    if (!msg) return false;
    c.beforeReceive = c.durable;
    const r = await c.replica.receive(msg, this.objects);
    if (crashBeforeCommit) {
      this.crashClient(c, true);
      return true;
    }
    c.commit();
    if (r !== "ok") {
      this.drop(c);
      this.connect(c);
    }
    return true;
  }

  /** The Mac stops: it comes back from its last commit (or the one before its last receive), with no socket. */
  crashClient(c: SimClient, beforeCommit = false): void {
    const d = beforeCommit && c.beforeReceive ? c.beforeReceive : c.durable;
    c.replica = Replica.restore(c.replica.author, d, { newId: c.replica.newId });
    c.durable = c.replica.durable();
    c.socket = null;
  }
  /** The room stops: a new one opens on the same rows; every socket drops. */
  crashServer(): void {
    this.serverCrashes++;
    for (const c of this.clients) this.drop(c);
    this.openRoom();
  }

  /** Deliver everything until nothing moves: every Mac connected, every pending action confirmed or refused. */
  async quiesce(maxRounds = 200): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      let moved = false;
      for (const c of this.clients) {
        if (!c.socket) this.connect(c);
        if (c.replica.needHello) {
          this.drop(c);
          this.connect(c);
        }
        this.flush(c);
        while (this.serverStep(c)) moved = true;
      }
      for (const c of this.clients) while (await this.clientStep(c)) moved = true;
      const busy = this.clients.some((c) => c.replica.pending.length || c.socket?.up.length || c.socket?.down.length);
      if (!moved && !busy) return;
    }
    throw new Error("the room and the Macs did not settle");
  }

  /** Every way the Macs and the room disagree after a quiesce (empty: none). */
  divergences(): string[] {
    const out: string[] = [];
    const server = this.room.materialize();
    for (const c of this.clients) {
      const mine = materialize(c.replica.tree);
      for (const k of ["document", "widgets", "blobs", "vers"] as const) if (mine[k] !== server[k]) out.push(`${c.replica.author.id}: ${k} differs from the room${firstDiff(mine[k], server[k])}`);
      if (c.replica.seq !== this.room.meta().seq) out.push(`${c.replica.author.id}: at seq ${c.replica.seq}, the room at ${this.room.meta().seq}`);
      const view = materialize(c.replica.view());
      if (view.document !== mine.document || view.widgets !== mine.widgets) out.push(`${c.replica.author.id}: the view differs from the confirmed state with nothing pending`);
    }
    return out;
  }

  /** Actions a Mac committed that are neither in the room's receipts nor refused on that Mac. */
  lost(): string[] {
    const out: string[] = [];
    for (const c of this.clients) {
      const refused = new Set(c.replica.refused.map((r) => r.action.id));
      for (const id of c.made.keys()) {
        if (refused.has(id)) continue;
        if (!this.store.sql.exec("SELECT 1 FROM receipts WHERE action = ?", id).toArray().length) out.push(`${c.replica.author.id}: ${id}`);
      }
    }
    return out;
  }
  /** Action ids the room broadcast more than once. */
  doubles(): string[] {
    const seen = new Set<string>(), out: string[] = [];
    for (const a of this.log) {
      if (seen.has(a.id)) out.push(a.id);
      seen.add(a.id);
    }
    return out;
  }
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return ` at ${i}: ...${a.slice(Math.max(0, i - 40), i + 40)} vs ...${b.slice(Math.max(0, i - 40), i + 40)}`;
}
