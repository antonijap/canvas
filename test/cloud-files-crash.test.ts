// Crashes at every persistence boundary of a Cloud file (plan Phase 2): the room's action transaction, the reply that
// never left, a Mac's commit of what it received (its state store) and of its view, a snapshot build, an upload. The
// room's rows live in a real SQLite file that the test closes in the middle of a transaction, as a killed process
// would, and opens again. After every restart: nothing lost, nothing applied twice, every copy equal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSqlStore } from "../cloud/core/files/memory.ts";
import { FileRoom, type Conn } from "../cloud/core/files/room.ts";
import { MemoryObjects, blobKey } from "../cloud/core/files/objects.ts";
import { buildSnapshot, recoverSnapshots, compact, manifestAt, treeFromManifest } from "../cloud/core/files/snapshots.ts";
import { collectGarbage } from "../cloud/core/files/gc.ts";
import { reserveUpload, putUpload, StorageLedger, UPLOAD_GRACE_MS } from "../cloud/core/files/uploads.ts";
import { Replica } from "../cloud/core/files/replica.ts";
import { materialize } from "../cloud/core/files/state.ts";
import { FILE_ROOM_TABLES } from "../cloud/core/files/room-schema.ts";
import { actionSha } from "../cloud/core/files/messages.ts";
import { Sim, seedDocument, FILE } from "../qa/cloud-files-sim.ts";
import type { Action } from "../cloud/core/files/seam.ts";
import { createHash } from "node:crypto";

const anna: Conn = { author: { id: "anna@studio.test", name: "Anna" }, role: "editor" };
const ben: Conn = { author: { id: "ben@studio.test", name: "Ben" }, role: "editor" };

/** A room on a SQLite file that can be killed (closed mid transaction) and opened again. */
class Disk {
  dir = mkdtempSync(join(tmpdir(), "canvas-files-crash-"));
  path = join(this.dir, "room.sqlite");
  objects = new MemoryObjects();
  store!: NodeSqlStore;
  room!: FileRoom;
  t = Date.parse("2026-11-18T09:00:00Z");
  killAt: string | null = null;
  open(): FileRoom {
    this.store = new NodeSqlStore(this.path);
    this.room = new FileRoom({
      store: this.store, objects: this.objects, file: FILE, now: () => this.t,
      fault: (point) => {
        if (point !== this.killAt) return;
        this.killAt = null;
        this.store.db.close();
        throw new Error(`crash: killed at ${point}`);
      },
    });
    recoverSnapshots(this.room);
    return this.room;
  }
  reopen(): FileRoom {
    this.store.close();
    return this.open();
  }
  done() {
    this.store.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
  counts() {
    return Object.fromEntries(FILE_ROOM_TABLES.map((t) => [t, this.store.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).one().n]));
  }
}

function act(room: FileRoom, id: string, x: number): Action {
  const m = room.meta();
  return { id, baseSeq: m.seq, epoch: m.epoch, at: "2026-11-18T09:00:00.000Z", ops: [{ k: "set", id: "r1", props: { x: { v: x } } }, { k: "insert", parent: "b1", after: "r1", node: { id: `n-${id}`, type: "rectangle" } }] };
}

for (const point of ["applied", "logged", "receipted"] as const) {
  test(`room killed inside an action's transaction (${point}): no trace; the resend applies once`, async () => {
    const d = new Disk();
    try {
      const room = d.open();
      room.seed(seedDocument().document, seedDocument().envelope);
      await buildSnapshot(room);
      const before = { state: room.materialize(), counts: d.counts(), meta: room.meta() };
      const a = act(room, "a1", 42);
      d.killAt = point;
      assert.throws(() => room.submit(anna, { type: "actions", epoch: a.epoch, actions: [a] }), /crash|not open/);
      const again = d.open();
      assert.deepEqual(again.materialize(), before.state, "the killed transaction left nothing");
      assert.deepEqual(d.counts(), before.counts);
      assert.deepEqual(again.meta(), before.meta);
      // The Mac never got an ack, so its hello names the action as pending; the room does not know it.
      const w = again.hello(anna, { type: "hello", protocol: 2, file: FILE, since: before.meta.seq, epoch: 1, pending: [{ id: a.id, sha: actionSha(a) }] });
      assert.deepEqual((w[0] as { known: unknown[] }).known, []);
      const r = again.submit(anna, { type: "actions", epoch: 1, actions: [a] });
      assert.equal(r.replies[0].type, "ack");
      assert.equal(r.applied.length, 1);
      const r2 = again.submit(anna, { type: "actions", epoch: 1, actions: [a] });
      assert.equal(r2.applied.length, 0, "a second resend is answered from the receipt");
      assert.equal(again.tail(0).filter((x) => x.id === a.id).length, 1);
      assert.equal(again.tree.node("r1")!.props.x, 42);
    } finally {
      d.done();
    }
  });
}

test("room killed after the commit, before the reply left: the hello says known and the Mac never resends", async () => {
  const sim = new Sim();
  await sim.init();
  const a = await sim.addClient(anna.author), b = await sim.addClient(ben.author);
  sim.connect(a);
  sim.connect(b);
  await sim.quiesce();
  const made = sim.propose(a, [{ k: "set", id: "r1", props: { x: { v: 7 } } }]) as Action;
  sim.flush(a);
  sim.serverStep(a); // applied and committed in the room
  sim.crashServer(); // every reply and broadcast of that turn is gone
  await sim.quiesce();
  assert.deepEqual(sim.divergences(), []);
  assert.deepEqual(sim.doubles(), []);
  assert.equal(sim.room.tail(0).filter((x) => x.id === made.id).length, 1);
  assert.deepEqual(sim.lost(), []);
});

test("Mac killed before committing what it received: it asks again from its last commit and applies each action once", async () => {
  const sim = new Sim();
  await sim.init();
  const a = await sim.addClient(anna.author), b = await sim.addClient(ben.author);
  sim.connect(a);
  sim.connect(b);
  await sim.quiesce();
  for (let i = 0; i < 4; i++) sim.propose(a, [{ k: "set", id: "r1", props: { x: { v: i } } }, { k: "text", id: "t1", baseSeq: 0, from: 0, del: 0, ins: `${i}` }].slice(0, i % 2 ? 1 : 2) as never);
  sim.flush(a);
  while (sim.serverStep(a));
  // Ben's Mac reads the broadcast, then dies before its state store commits.
  await sim.clientStep(b, true);
  assert.equal(b.socket, null);
  const seqAfterCrash = b.replica.seq;
  await sim.quiesce();
  assert.ok(b.replica.seq > seqAfterCrash);
  assert.deepEqual(sim.divergences(), []);
  assert.deepEqual(sim.doubles(), []);
  assert.deepEqual(sim.lost(), []);
});

test("Mac killed after committing a local edit, before sending it: the edit goes after the restart, once", async () => {
  const sim = new Sim();
  await sim.init();
  const a = await sim.addClient(anna.author);
  sim.connect(a);
  await sim.quiesce();
  const made = sim.propose(a, [{ k: "insert", parent: "b2", after: null, node: { id: "fresh", type: "text", content: "New" } }]) as Action;
  sim.crashClient(a);
  // The view the Mac rebuilds from its state store already shows the edit, before the room has it.
  assert.ok(a.replica.view().node("fresh"));
  assert.equal(a.replica.tree.node("fresh"), null);
  await sim.quiesce();
  assert.equal(sim.room.tree.node("fresh")!.props.content, "New");
  assert.equal(sim.log.filter((x) => x.id === made.id).length, 1);
  assert.deepEqual(sim.divergences(), []);
});

test("Mac killed after sending, before the ack: it resends byte for byte and the receipt answers", async () => {
  const sim = new Sim();
  await sim.init();
  const a = await sim.addClient(anna.author);
  sim.connect(a);
  await sim.quiesce();
  const made = sim.propose(a, [{ k: "set", id: "r1", props: { y: { v: 99 } } }]) as Action;
  sim.flush(a);
  sim.serverStep(a);
  sim.crashClient(a); // its socket and everything on it are gone
  const durable = a.replica.pending.map((p) => p.sha);
  assert.deepEqual(durable, [actionSha(made)], "the same bytes as before");
  await sim.quiesce();
  assert.deepEqual(sim.doubles(), []);
  assert.deepEqual(sim.divergences(), []);
  assert.equal(a.replica.pending.length, 0);
});

test("snapshot build killed between its objects and its manifest: the room recovers, collection keeps nothing it needs", async () => {
  const d = new Disk();
  try {
    const room = d.open();
    room.seed(seedDocument().document, seedDocument().envelope);
    await buildSnapshot(room);
    const ledger = new StorageLedger(new NodeSqlStore(), 1e9);
    for (let i = 0; i < 3; i++) assert.equal(room.submit(anna, { type: "actions", epoch: 1, actions: [act(room, `s${i}`, i)] }).replies[0].type, "ack");
    const want = room.materialize();
    // Two writes in: one board object stored, the vers object and the manifest never.
    d.objects.failAfter = 1;
    await assert.rejects(buildSnapshot(room), /crash/);
    assert.equal(d.store.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM snapshots WHERE state = 'building'").one().n, 1);
    assert.equal(d.store.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM dirty_boards").one().n, 0, "the draft took the dirty boards");
    // Collection while the build is half done keeps what the draft names.
    const half = await collectGarbage(room, ledger);
    assert.deepEqual(half.deleted, []);
    const restarted = d.reopen();
    assert.equal(d.store.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM snapshots WHERE state = 'building'").one().n, 0, "recovered");
    assert.ok(d.store.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM dirty_boards").one().n >= 1, "the boards are dirty again");
    const seq = await buildSnapshot(restarted);
    compact(restarted);
    await collectGarbage(restarted, ledger);
    const { tree } = await treeFromManifest(d.objects, (await manifestAt(restarted, seq))!);
    assert.deepEqual(materialize(tree), want, "the rebuilt snapshot is the room's state");
    // A Mac that starts from it matches the room.
    const r = new Replica(anna.author, tree.state(), seq, 1);
    assert.deepEqual(materialize(r.tree), restarted.materialize());
  } finally {
    d.done();
  }
});

test("snapshot build killed after every object, before done: rebuilt with the same objects, nothing duplicated", async () => {
  const d = new Disk();
  try {
    const room = d.open();
    room.seed(seedDocument().document, seedDocument().envelope);
    await buildSnapshot(room);
    room.submit(anna, { type: "actions", epoch: 1, actions: [act(room, "x1", 5)] });
    const writes = d.objects.writes;
    // Board b1, the vers object, then the manifest: kill on the manifest.
    d.objects.failAfter = 2;
    await assert.rejects(buildSnapshot(room), /crash/);
    const after1 = d.objects.writes - writes;
    const restarted = d.reopen();
    const seq = await buildSnapshot(restarted);
    assert.equal(d.objects.writes - writes - after1, 1, "only the manifest is new; the board and vers objects were reused");
    const { tree } = await treeFromManifest(d.objects, (await manifestAt(restarted, seq))!);
    assert.deepEqual(materialize(tree), restarted.materialize());
  } finally {
    d.done();
  }
});

const png = (n: number) => {
  const b = new Uint8Array(64 + n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < b.length; i++) b[i] = (i * 7 + n) & 0xff;
  return b;
};
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test("upload killed after its bytes were stored, before the room noted it: the retry finds them, nothing is stored twice", async () => {
  const d = new Disk();
  try {
    const room = d.open();
    room.seed(seedDocument().document, seedDocument().envelope);
    await buildSnapshot(room);
    const ledger = new StorageLedger(new NodeSqlStore(), 10_000);
    const bytes = png(100);
    const sha = hex(bytes);
    reserveUpload(room, ledger, anna, { id: "up-00000001", sha256: sha, bytes: bytes.length, type: "image/png" });
    // The object lands, then the room dies before it marks the upload stored.
    await d.objects.putIfAbsent(blobKey(FILE, sha), bytes);
    const restarted = d.reopen();
    assert.equal(d.store.sql.exec<{ state: string }>("SELECT state FROM uploads WHERE id = 'up-00000001'").one().state, "open");
    const r = await putUpload(restarted, ledger, "up-00000001", bytes);
    assert.equal(r.stored, false, "the bytes were there; never overwritten");
    assert.equal(d.store.sql.exec<{ state: string }>("SELECT state FROM uploads WHERE id = 'up-00000001'").one().state, "stored");
    assert.equal(ledger.held(), bytes.length, "reserved once");
    // The action that uses it applies; collection keeps it.
    const a = { id: "use-1", baseSeq: restarted.meta().seq, epoch: 1, at: "", ops: [{ k: "blob" as const, path: "media/a.png" as const, sha256: sha, bytes: bytes.length, type: "image/png" as const }, { k: "set" as const, id: "r1", props: { fill: { v: { type: "image", url: "media/a.png" } } } }] };
    assert.equal(restarted.submit(anna, { type: "actions", epoch: 1, actions: [a] }).replies[0].type, "ack");
    d.t += UPLOAD_GRACE_MS * 2;
    const gc = await collectGarbage(restarted, ledger);
    assert.ok(!gc.deleted.includes(blobKey(FILE, sha)));
    assert.equal(ledger.held(), bytes.length);
  } finally {
    d.done();
  }
});

test("upload killed after its reservation, before any bytes: the reservation goes back after the grace, never earlier", async () => {
  const d = new Disk();
  try {
    const room = d.open();
    room.seed(seedDocument().document, seedDocument().envelope);
    await buildSnapshot(room);
    const ledger = new StorageLedger(new NodeSqlStore(), 10_000);
    const bytes = png(10);
    reserveUpload(room, ledger, anna, { id: "up-00000002", sha256: hex(bytes), bytes: bytes.length, type: "image/png" });
    const restarted = d.reopen();
    assert.equal((await collectGarbage(restarted, ledger)).uploadsExpired, 0);
    assert.equal(ledger.held(), bytes.length);
    d.t += UPLOAD_GRACE_MS + 1;
    assert.equal((await collectGarbage(restarted, ledger)).uploadsExpired, 1);
    assert.equal(ledger.held(), 0);
    // An upload that stored bytes no action used: its object goes too.
    const other = png(20);
    reserveUpload(restarted, ledger, anna, { id: "up-00000003", sha256: hex(other), bytes: other.length, type: "image/png" });
    await putUpload(restarted, ledger, "up-00000003", other);
    d.t += UPLOAD_GRACE_MS + 1;
    const gc = await collectGarbage(restarted, ledger);
    assert.ok(gc.deleted.includes(blobKey(FILE, hex(other))));
    assert.equal(ledger.held(), 0);
  } finally {
    d.done();
  }
});

test("a crash in the middle of a long run of actions, many times over: every copy equal, nothing lost or doubled", async () => {
  let k = 0;
  const sim = new Sim({ fault: () => { if (++k % 7 === 0) throw new Error("crash: fault"); } });
  await sim.init();
  const cs = [await sim.addClient(anna.author), await sim.addClient(ben.author)];
  for (const c of cs) sim.connect(c);
  await sim.quiesce();
  for (let i = 0; i < 60; i++) {
    const c = cs[i % 2];
    sim.propose(c, [{ k: "set", id: i % 3 ? "r1" : "e1", props: { x: { v: i } } }]);
    if (i % 5 === 0) sim.propose(c, [{ k: "insert", parent: "b2", after: null, node: { id: `k${i}`, type: "rectangle" } }]);
    sim.flush(c);
    sim.serverStep(c);
    if (i % 11 === 0) sim.crashClient(cs[(i + 1) % 2]);
    if (i % 4 === 0) await sim.clientStep(cs[(i + 1) % 2], i % 8 === 0);
  }
  await sim.quiesce();
  assert.ok(sim.serverCrashes > 0, "the room crashed along the way");
  assert.deepEqual(sim.divergences(), []);
  assert.deepEqual(sim.doubles(), []);
  assert.deepEqual(sim.lost(), []);
});
