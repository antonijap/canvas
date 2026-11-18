// The Cloud file room's rules (plan Sections 2.3 and 3): every rule on the room's own SQL rows, all or nothing actions,
// receipts that outlive compaction, epochs, contiguous delivery, text transform, allowlists and path refusals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoom } from "../cloud/core/files/memory.ts";
import { FileRoom, type Conn } from "../cloud/core/files/room.ts";
import { buildSnapshot, compact, restoreVersion } from "../cloud/core/files/snapshots.ts";
import { keyBetween, keyAt, evenKeys, MAX_KEY, isKey } from "../cloud/core/files/positions.ts";
import { transformSplice } from "../cloud/core/files/text.ts";
import { sha256Hex } from "../cloud/core/files/sha256.ts";
import { resolveInPackage } from "../cloud/core/files/confine.ts";
import { actionSha, type FileServerMessage } from "../cloud/core/files/messages.ts";
import { documentOf } from "../cloud/core/files/state.ts";
import { MemoryTree } from "../cloud/core/files/tree-memory.ts";
import { stateFromFiles } from "../cloud/core/files/state.ts";
import { Sim, seedDocument, FILE } from "../qa/cloud-files-sim.ts";
import { createHash } from "node:crypto";
import type { Action, FileOp, Json } from "../cloud/core/files/seam.ts";

const anna: Conn = { author: { id: "anna@studio.test", name: "Anna" }, role: "editor" };
const ben: Conn = { author: { id: "ben@studio.test", name: "Ben" }, role: "editor" };
const viewer: Conn = { author: { id: "viewer@studio.test", name: "Viewer" }, role: "viewer" };

let n = 0;
function seeded(): FileRoom {
  const room = memoryRoom(FILE);
  const s = seedDocument();
  room.seed(s.document, s.envelope);
  return room;
}
function action(room: FileRoom, ops: FileOp[], o: Partial<Action> = {}): Action {
  const m = room.meta();
  return { id: `act-${++n}`, baseSeq: m.seq, epoch: m.epoch, at: "2026-11-18T10:00:00.000Z", ops, ...o };
}
function send(room: FileRoom, conn: Conn, a: Action | Action[]) {
  const actions = Array.isArray(a) ? a : [a];
  return room.submit(conn, { type: "actions", epoch: actions[0]?.epoch ?? room.meta().epoch, actions });
}
function one(room: FileRoom, conn: Conn, ops: FileOp[], o: Partial<Action> = {}): FileServerMessage {
  return send(room, conn, action(room, ops, o)).replies[0];
}
const ok = (m: FileServerMessage) => assert.equal(m.type, "ack", JSON.stringify(m));
const refused = (m: FileServerMessage, code: string) => {
  assert.equal(m.type, "reject", JSON.stringify(m));
  assert.equal((m as { code: string }).code, code, JSON.stringify(m));
};
const node = (room: FileRoom, id: string) => {
  room.tree.forget();
  return room.tree.node(id)?.props;
};
const doc = (room: FileRoom) => JSON.parse(room.materialize().document);

test("same node: different keys both apply, the same key goes to the later seq", () => {
  const room = seeded();
  const base = room.meta().seq;
  ok(one(room, anna, [{ k: "set", id: "r1", props: { x: { v: 40 } } }], { baseSeq: base }));
  ok(one(room, ben, [{ k: "set", id: "r1", props: { y: { v: 70 } } }], { baseSeq: base }));
  assert.equal(node(room, "r1")!.x, 40);
  assert.equal(node(room, "r1")!.y, 70);
  ok(one(room, ben, [{ k: "set", id: "r1", props: { x: { v: 1 } } }], { baseSeq: base }));
  ok(one(room, anna, [{ k: "set", id: "r1", props: { x: { v: 2 } } }], { baseSeq: base }));
  assert.equal(node(room, "r1")!.x, 2);
});

test("null and absent stay apart, and key order is canonical (new keys last, order overrides)", () => {
  const room = seeded();
  ok(one(room, anna, [{ k: "set", id: "r1", props: { opacity: { v: 0.5 }, name: null } }]));
  const p = node(room, "r1")!;
  assert.equal(Object.hasOwn(p, "name"), false, "null removes the key");
  assert.deepEqual(Object.keys(p), ["id", "type", "x", "y", "width", "height", "fill", "opacity"]);
  ok(one(room, anna, [{ k: "set", id: "r1", props: { name: { v: "Box" } }, order: ["id", "type", "name", "x", "y", "width", "height", "fill", "opacity"] }]));
  assert.deepEqual(Object.keys(node(room, "r1")!).slice(0, 3), ["id", "type", "name"]);
  ok(one(room, anna, [{ k: "doc", key: "variables/brand", value: { v: { type: "color", value: "#00ff00" } } }]));
  assert.deepEqual(doc(room).variables, { brand: { type: "color", value: "#00ff00" } });
  ok(one(room, anna, [{ k: "set", id: "i1", props: { "descendants/c1l": { v: { content: null } } } }]));
  assert.deepEqual(node(room, "i1")!.descendants, { c1l: { content: null } }, "a JSON null inside a value stays a value");
});

test("allowlists: identity, tree and prototype keys are refused, and so is any document key outside the list", () => {
  const room = seeded();
  for (const k of ["id", "type", "children", "__proto__", "constructor", "prototype"]) refused(one(room, anna, [{ k: "set", id: "r1", props: { [k]: { v: "x" } } }]), "forbidden");
  refused(one(room, anna, [{ k: "set", id: "r1", props: { content: { v: "x" } } }]), "invalid");
  refused(one(room, anna, [{ k: "doc", key: "children" as never, value: { v: [] } }]), "forbidden");
  refused(one(room, anna, [{ k: "doc", key: "__proto__" as never, value: { v: {} } }]), "forbidden");
  refused(one(room, anna, [{ k: "doc", key: "version" as never, value: { v: "9" } }]), "invalid");
  refused(one(room, anna, [{ k: "doc", key: "variables/__proto__", value: { v: { type: "number", value: 1 } } }]), "invalid");
  refused(one(room, anna, [{ k: "set", id: "i1", props: { "descendants/__proto__": { v: {} } } }]), "invalid");
  refused(one(room, anna, [{ k: "meta", key: "__proto__" as never, value: { v: 1 } }]), "forbidden");
  refused(one(room, anna, [{ k: "insert", parent: "b1", after: null, node: { id: "__proto__", type: "rectangle" } }]), "forbidden");
  assert.equal(Object.getPrototypeOf(doc(room)), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("path refusals: ../, absolute, scheme, data and web image fills, and a symlink in the package", () => {
  const room = seeded();
  const sha = "a".repeat(64);
  for (const p of ["media/../secret.png", "/etc/passwd.png", "file:///etc/hosts", "https://example.com/a.png", "media/sub/a.png", "media/.hidden.png", "media\\a.png", "shaders/a.png"]) {
    refused(one(room, anna, [{ k: "blob", path: p as never, sha256: sha, bytes: 1, type: "image/png" }]), "forbidden");
  }
  for (const url of ["https://example.com/a.png", "data:image/png;base64,AAAA", "/Users/you/a.png", "media/missing.png"]) {
    refused(one(room, anna, [{ k: "set", id: "r1", props: { fill: { v: { type: "image", url } } } }]), "forbidden");
  }
  refused(one(room, anna, [{ k: "widget", id: "w9", value: { v: { id: "w9", kind: "video", config: { src: "/Users/you/movie.mp4" } } } }]), "forbidden");
  // A blob op must name bytes this file holds: no upload, no blob.
  refused(one(room, anna, [{ k: "blob", path: "media/a.png", sha256: sha, bytes: 1, type: "image/png" }]), "invalid");

  const dir = mkdtempSync(join(tmpdir(), "canvas-confine-"));
  try {
    mkdirSync(join(dir, "pkg", "media"), { recursive: true });
    writeFileSync(join(dir, "secret.png"), "x");
    writeFileSync(join(dir, "pkg", "media", "real.png"), "x");
    symlinkSync(join(dir, "secret.png"), join(dir, "pkg", "media", "link.png"));
    symlinkSync(join(dir, "pkg", "media"), join(dir, "pkg", "shaders"));
    const lstat = (p: string) => {
      try {
        return lstatSync(p);
      } catch {
        return null;
      }
    };
    const root = join(dir, "pkg");
    assert.deepEqual(resolveInPackage(root, "media/real.png", lstat), { path: join(root, "media", "real.png") });
    assert.ok("refused" in resolveInPackage(root, "media/link.png", lstat));
    assert.ok("refused" in resolveInPackage(root, "shaders/x.wgsl", lstat), "a linked folder is refused too");
    assert.ok("refused" in resolveInPackage(root, "media/../secret.png", lstat));
    assert.ok("refused" in resolveInPackage(root, "/etc/hosts", lstat));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all or nothing: one bad op refuses the whole action and leaves every row as it was", () => {
  const room = seeded();
  const before = room.materialize();
  const seq = room.meta().seq;
  refused(one(room, anna, [
    { k: "set", id: "r1", props: { x: { v: 99 } } },
    { k: "insert", parent: "b1", after: "r1", node: { id: "new1", type: "rectangle" } },
    { k: "remove", id: "t1" },
    { k: "set", id: "nope", props: { x: { v: 1 } } },
  ]), "conflict");
  assert.deepEqual(room.materialize(), before);
  assert.equal(room.meta().seq, seq);
  assert.equal(room.tail(seq).length, 0);
  assert.equal(room.store.sql.exec("SELECT COUNT(*) AS n FROM receipts").one().n, 0);
  // The same id may come again once it fits, since nothing of it was kept.
  const a = action(room, [{ k: "set", id: "r1", props: { x: { v: 99 } } }]);
  ok(send(room, anna, a).replies[0]);
  assert.equal(room.meta().seq, seq + 1);
});

test("delete wins over edit; removal tombstones the root; undo brings the same ids back, a live id never twice", () => {
  const room = seeded();
  const base = room.meta().seq;
  ok(one(room, anna, [{ k: "remove", id: "g1" }], { baseSeq: base }));
  refused(one(room, ben, [{ k: "set", id: "e1", props: { x: { v: 5 } } }], { baseSeq: base }), "conflict");
  refused(one(room, ben, [{ k: "move", id: "e1", parent: "b2", after: null }], { baseSeq: base }), "conflict");
  const rows = room.store.sql.exec<{ id: string; deleted_seq: number | null }>("SELECT id, deleted_seq FROM nodes WHERE id IN ('g1','e1') ORDER BY id").toArray();
  assert.deepEqual(rows.map((r) => [r.id, r.deleted_seq !== null]), [["e1", false], ["g1", true]], "only the root carries the tombstone");
  ok(one(room, anna, [{ k: "insert", parent: "b1", after: "c1", node: { id: "g1", type: "group", name: "Group", children: [{ id: "e1", type: "ellipse", width: 20, height: 20 }] } }]));
  assert.equal(node(room, "e1")!.width, 20);
  refused(one(room, anna, [{ k: "insert", parent: "b2", after: null, node: { id: "r1", type: "rectangle" } }]), "conflict");
  refused(one(room, anna, [{ k: "insert", parent: "b2", after: null, node: { id: "z", type: "group", children: [{ id: "z1", type: "rectangle" }, { id: "z1", type: "rectangle" }] } }]), "invalid");
  // A reinsert with fewer children leaves no old child behind.
  ok(one(room, anna, [{ k: "remove", id: "g1" }]));
  ok(one(room, anna, [{ k: "insert", parent: "b1", after: null, node: { id: "g1", type: "group", children: [] } }]));
  room.tree.forget();
  assert.deepEqual(room.tree.children("g1"), []);
  assert.equal(room.tree.node("e1"), null);
});

test("a remote remove after a local move: the move lands first, the remove takes the node from its new place", async () => {
  const sim = new Sim();
  await sim.init();
  const a = await sim.addClient(anna.author), b = await sim.addClient(ben.author);
  sim.connect(a);
  sim.connect(b);
  await sim.quiesce();
  sim.propose(a, [{ k: "move", id: "r1", parent: "b2", after: null }]);
  sim.propose(b, [{ k: "remove", id: "r1" }]);
  sim.flush(a);
  sim.flush(b);
  sim.serverStep(a);
  sim.serverStep(b);
  await sim.quiesce();
  assert.deepEqual(sim.divergences(), []);
  assert.equal(sim.room.tree.node("r1"), null);
  assert.ok(!JSON.parse(sim.room.materialize().document).children[1].children.some((c: { id: string }) => c.id === "r1"));
  // And the other way: the remove lands first, the move is refused as a conflict and stays refused on that Mac.
  sim.propose(b, [{ k: "move", id: "t1", parent: "b2", after: null }]);
  sim.propose(a, [{ k: "remove", id: "t1" }]);
  sim.flush(a);
  sim.flush(b);
  sim.serverStep(a);
  sim.serverStep(b);
  await sim.quiesce();
  assert.deepEqual(sim.divergences(), []);
  assert.equal(b.replica.refused.at(-1)!.code, "conflict");
  assert.deepEqual(sim.lost(), []);
});

test("tree moves: never into itself or below itself, never into a leaf, never into a removed node", () => {
  const room = seeded();
  refused(one(room, anna, [{ k: "move", id: "b1", parent: "b1", after: null }]), "invalid");
  refused(one(room, anna, [{ k: "move", id: "b1", parent: "g1", after: null }]), "invalid");
  refused(one(room, anna, [{ k: "move", id: "e1", parent: "r1", after: null }]), "invalid");
  ok(one(room, anna, [{ k: "remove", id: "b2" }]));
  refused(one(room, anna, [{ k: "move", id: "r1", parent: "b2", after: null }]), "conflict");
  ok(one(room, anna, [{ k: "move", id: "e1", parent: null, after: "b1" }]));
  room.tree.forget();
  assert.deepEqual(room.tree.children(null), ["b1", "e1"]);
});

test("components: no removal while instances use one, no instance of a non component, no cycle", () => {
  const room = seeded();
  refused(one(room, anna, [{ k: "remove", id: "c1" }]), "conflict");
  refused(one(room, anna, [{ k: "set", id: "c1", props: { reusable: null } }]), "conflict");
  refused(one(room, anna, [{ k: "insert", parent: "b2", after: null, node: { id: "i2", type: "ref", ref: "r1" } }]), "invalid");
  refused(one(room, anna, [{ k: "insert", parent: "c1", after: null, node: { id: "i3", type: "ref", ref: "c1" } }]), "invalid");
  // Indirect: c2 holds an instance of c1, then c1 takes an instance of c2.
  ok(one(room, anna, [{ k: "insert", parent: "b2", after: null, node: { id: "c2", type: "frame", reusable: true, children: [{ id: "i4", type: "ref", ref: "c1" }] } }]));
  refused(one(room, anna, [{ k: "insert", parent: "c1", after: null, node: { id: "i5", type: "ref", ref: "c2" } }]), "invalid");
  refused(one(room, anna, [{ k: "set", id: "i1", props: { "descendants/x": { v: { ref: "nope" } } } }]), "invalid");
  // Removing the instance and then the component in one action works.
  ok(one(room, anna, [{ k: "remove", id: "i1" }, { k: "remove", id: "i4" }, { k: "remove", id: "c1" }]));
});

test("undo preconditions: a key must still hold the undone action's value, change away and back included", () => {
  const room = seeded();
  const a1 = action(room, [{ k: "set", id: "r1", props: { x: { v: 50 } } }]);
  ok(send(room, anna, a1).replies[0]);
  ok(one(room, ben, [{ k: "set", id: "r1", props: { x: { v: 60 } } }]));
  ok(one(room, ben, [{ k: "set", id: "r1", props: { x: { v: 50 } } }]));
  // Anna's undo of a1 sees the same value (50), but another action wrote it since.
  refused(one(room, anna, [{ k: "set", id: "r1", props: { x: { v: 10 } }, if: { x: a1.id } }]), "conflict");
  const a2 = action(room, [{ k: "set", id: "r1", props: { x: { v: 77 } } }]);
  ok(send(room, anna, a2).replies[0]);
  ok(one(room, anna, [{ k: "set", id: "r1", props: { x: { v: 50 } }, if: { x: a2.id } }]));
  ok(one(room, anna, [{ k: "set", id: "t1", props: { x: { v: 3 } }, if: { x: 0 } }])); // 0: never written since load
  refused(one(room, anna, [{ k: "remove", id: "t1", if: a2.id }]), "conflict");
});

test("pages: at least one stays; boards move between pages; variables, themes and cards by key", () => {
  const room = seeded();
  refused(one(room, anna, [{ k: "page", id: "p1", value: null }]), "invalid");
  ok(one(room, anna, [{ k: "page", id: "p2", value: { v: { name: "Two" } } }, { k: "pageOf", board: "b2", page: "p2" }]));
  ok(one(room, anna, [{ k: "page", id: "p1", value: null }]));
  const env = JSON.parse(room.materialize().widgets);
  assert.deepEqual(env.pages, [{ id: "p2", name: "Two", boards: ["b2"] }]);
  ok(one(room, anna, [{ k: "doc", key: "themes", value: { v: { mode: ["light", "dark"] } } }, { k: "widget", id: "w2", value: { v: { id: "w2", kind: "note", config: {} } }, after: null }]));
  assert.deepEqual(JSON.parse(room.materialize().widgets).widgets.map((w: { id: string }) => w.id), ["w2", "w1"]);
  refused(one(room, anna, [{ k: "doc", key: "themes", value: { v: [1] } }]), "invalid");
});

test("reorder keys stay bounded: hundreds of inserts in one gap renumber the parent and keep the order", () => {
  const room = seeded();
  let after: string | null = "r1";
  for (let i = 0; i < 400; i++) {
    // Always right after r1: every new key lands in the same, shrinking gap.
    ok(one(room, anna, [{ k: "insert", parent: "b1", after: "r1", node: { id: `n${i}`, type: "rectangle" } }]));
    after = `n${i}`;
  }
  void after;
  const keys = room.store.sql.exec<{ pos: string }>("SELECT pos FROM nodes WHERE parent = 'b1' AND deleted_seq IS NULL").toArray().map((r) => r.pos);
  assert.ok(keys.every((k) => k.length <= MAX_KEY), `longest key ${Math.max(...keys.map((k) => k.length))}`);
  room.tree.forget();
  const order = room.tree.children("b1");
  assert.deepEqual(order.slice(0, 3), ["r1", "n399", "n398"]);
  assert.equal(order.at(-4), "n0");
  // The Mac's copy agrees after the same actions (the applied ops carry `after`, not keys).
  const mem = new MemoryTree(stateFromFiles(seedDocument().document, seedDocument().envelope));
  for (const a of room.tail(0)) for (const op of a.ops) if (op.k === "insert") mem.insert("b1", 1, op.node as never);
  assert.deepEqual(mem.children("b1"), order);
});

test("position keys: between, even and bounded", () => {
  assert.ok(keyBetween(null, null).length === 1);
  const a = keyBetween(null, null), b = keyBetween(a, null), c = keyBetween(a, b);
  assert.ok(a < c && c < b);
  for (const k of evenKeys(1000)) assert.ok(isKey(k));
  const ks = evenKeys(1000);
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i - 1] < ks[i]);
  let lo = "1", hi = "2";
  for (let i = 0; i < 2000; i++) {
    const r = keyAt([lo, hi], 1);
    if (r.renumber) {
      assert.equal(r.renumber.length, 3);
      assert.ok(r.renumber.every((k) => k.length <= MAX_KEY));
      return;
    }
    hi = r.key;
  }
  assert.fail("the key never asked for a renumber");
});

test("text: non overlapping splices are moved over each other; overlaps, whole writes and old bases conflict", () => {
  const room = seeded();
  const base = room.meta().seq; // "Hello world"
  ok(one(room, anna, [{ k: "text", id: "t1", baseSeq: base, from: 0, del: 5, ins: "Howdy there" }]));
  ok(one(room, ben, [{ k: "text", id: "t1", baseSeq: base, from: 6, del: 5, ins: "Canvas" }]));
  assert.equal(node(room, "t1")!.content, "Howdy there Canvas");
  const applied = room.tail(base).at(-1)!.ops[0] as { from: number; del: number };
  assert.deepEqual([applied.from, applied.del], [12, 5], "the applied op carries the resolved splice");
  refused(one(room, ben, [{ k: "text", id: "t1", baseSeq: base, from: 2, del: 6, ins: "x" }]), "conflict");
  const b2 = room.meta().seq;
  ok(one(room, anna, [{ k: "set", id: "t1", props: { content: { v: "Fresh" } } }]));
  refused(one(room, ben, [{ k: "text", id: "t1", baseSeq: b2, from: 0, del: 0, ins: "A" }]), "conflict");
  // Same insertion point: theirs first, ours after.
  assert.deepEqual(transformSplice({ from: 3, del: 0 }, [{ node: "t", seq: 1, action: "a", whole: false, from: 3, del: 0, ins: 2 }]), { from: 5, del: 0 });
  const many = Array.from({ length: 51 }, (_, i) => ({ node: "t", seq: i + 1, action: "a", whole: false, from: 100, del: 0, ins: 1 }));
  assert.ok("conflict" in transformSplice({ from: 0, del: 0 }, many));
  assert.ok("conflict" in transformSplice({ from: 0, del: 0, spans: [] }, many.slice(0, 1)));
  // Spans shift with the splice when the op does not set them.
  const b3 = room.meta().seq;
  ok(one(room, anna, [{ k: "set", id: "t1", props: { content: { v: "Hello world" }, spans: { v: [{ start: 6, end: 11, fontWeight: "700" }] } } }]));
  ok(one(room, anna, [{ k: "text", id: "t1", baseSeq: b3 + 1, from: 0, del: 0, ins: ">> " }]));
  assert.deepEqual(node(room, "t1")!.spans, [{ start: 9, end: 14, fontWeight: "700" }]);
});

test("receipts: a resend acks without applying again, outlives compaction, refuses the same id with another payload", async () => {
  let t = Date.parse("2026-10-01T00:00:00Z");
  const room = memoryRoom(FILE, { now: () => t });
  room.seed(seedDocument().document, seedDocument().envelope);
  await buildSnapshot(room);
  t += 2 * 86_400_000;
  const a = action(room, [{ k: "set", id: "r1", props: { x: { v: 11 } } }]);
  const first = send(room, anna, a);
  ok(first.replies[0]);
  assert.equal(first.applied.length, 1);
  const again = send(room, anna, a);
  assert.deepEqual(again.replies[0], first.replies[0]);
  assert.equal(again.applied.length, 0, "nothing is broadcast twice");
  for (let i = 0; i < 5; i++) ok(one(room, ben, [{ k: "set", id: "r1", props: { y: { v: i } } }]));
  await buildSnapshot(room);
  // 29 days after the action: the first version is past 30 days and goes, the log below the next one goes with it.
  t += 29 * 86_400_000;
  const c = compact(room);
  assert.equal(c.versionsDropped, 1);
  assert.ok(c.logDropped >= 6, "the log was trimmed");
  assert.equal(c.receiptsDropped, 0);
  assert.equal(room.tail(0).some((x) => x.id === a.id), false);
  const third = send(room, anna, a);
  assert.deepEqual(third.replies[0], first.replies[0], "the receipt outlives the log");
  refused(send(room, anna, { ...a, ops: [{ k: "set", id: "r1", props: { x: { v: 12 } } }] }).replies[0], "invalid");
  refused(send(room, ben, a).replies[0], "invalid");
  // The hello names it as known, with its seq range.
  const w = room.hello(anna, { type: "hello", protocol: 2, file: FILE, since: room.meta().seq, epoch: room.meta().epoch, pending: [{ id: a.id, sha: actionSha(a) }, { id: "never", sha: "x" }] });
  const welcome = w.find((m) => m.type === "welcome") as Extract<FileServerMessage, { type: "welcome" }>;
  assert.deepEqual(welcome.known, [{ id: a.id, first: (first.replies[0] as { first: number }).first, last: (first.replies[0] as { last: number }).last }]);
});

test("expired: after 30 days receipts go, the floor rises, and an action on an older base is refused", async () => {
  let t = Date.parse("2026-11-01T00:00:00Z");
  const room = memoryRoom(FILE, { now: () => t });
  const s = seedDocument();
  room.seed(s.document, s.envelope);
  await buildSnapshot(room);
  const oldBase = room.meta().seq;
  ok(one(room, anna, [{ k: "set", id: "r1", props: { x: { v: 1 } } }]));
  t += 31 * 86_400_000;
  ok(one(room, anna, [{ k: "set", id: "r1", props: { x: { v: 2 } } }]));
  await buildSnapshot(room);
  const c = compact(room);
  assert.equal(c.receiptsDropped, 1);
  assert.equal(room.meta().receiptFloor, oldBase + 1);
  refused(one(room, ben, [{ k: "set", id: "r1", props: { y: { v: 3 } } }], { baseSeq: oldBase }), "expired");
  ok(one(room, ben, [{ k: "set", id: "r1", props: { y: { v: 3 } } }]));
});

test("epoch: a restore bumps it; old actions are refused reset and Macs start again from the restored snapshot", async () => {
  const sim = new Sim();
  await sim.init();
  const a = await sim.addClient(anna.author);
  sim.connect(a);
  await sim.quiesce();
  const v1 = sim.room.meta().seq;
  sim.propose(a, [{ k: "set", id: "r1", props: { x: { v: 123 } } }]);
  await sim.quiesce();
  const r = await restoreVersion(sim.room, v1);
  assert.equal(r.epoch, 2);
  assert.equal(sim.room.tree.node("r1")!.props.x, 10);
  refused(one(sim.room, ben, [{ k: "set", id: "r1", props: { x: { v: 1 } } }], { epoch: 1 }), "reset");
  // Anna's Mac had an edit waiting; the restore keeps it as a refused copy and her Mac matches the room again.
  sim.propose(a, [{ k: "set", id: "r1", props: { y: { v: 5 } } }]);
  sim.drop(a);
  await sim.quiesce();
  assert.deepEqual(sim.divergences(), []);
  assert.equal(a.replica.epoch, 2);
  assert.equal(a.replica.refused.at(-1)!.code, "reset");
  assert.deepEqual(sim.lost(), []);
});

test("contiguous delivery: a Mac applies only seq + 1, and a gap makes it say hello again", async () => {
  const sim = new Sim();
  await sim.init();
  const a = await sim.addClient(anna.author), b = await sim.addClient(ben.author);
  sim.connect(a);
  sim.connect(b);
  await sim.quiesce();
  for (let i = 0; i < 3; i++) sim.propose(a, [{ k: "set", id: "r1", props: { x: { v: i } } }]);
  sim.flush(a);
  sim.serverStep(a);
  // Lose the first applied message on Ben's socket: the next one is a gap.
  const lost = b.socket!.down.shift();
  assert.equal(lost!.type, "applied");
  const seq = b.replica.seq;
  const next = { type: "applied" as const, actions: sim.log.slice(-1) };
  assert.equal(b.replica.confirm(next.actions), "gap");
  assert.equal(b.replica.seq, seq, "nothing applied past the gap");
  assert.equal(b.replica.needHello, true);
  b.socket!.down.length = 0;
  await sim.quiesce();
  assert.deepEqual(sim.divergences(), []);
  // Welcome and tail come in one turn: the hello reply is [welcome, applied].
  const out = sim.room.hello(ben, { type: "hello", protocol: 2, file: FILE, since: seq, epoch: sim.room.meta().epoch, pending: [] });
  assert.deepEqual(out.map((m) => m.type), ["welcome", "applied"]);
  const tail = (out[1] as { actions: { first: number; last: number }[] }).actions;
  for (let i = 1; i < tail.length; i++) assert.equal(tail[i].first, tail[i - 1].last + 1);
});

test("roles: viewers and commenters cannot edit; a hello from someone outside the Cloud gets nothing", () => {
  const room = seeded();
  refused(one(room, viewer, [{ k: "set", id: "r1", props: { x: { v: 1 } } }]), "forbidden");
  refused(one(room, { ...viewer, role: "commenter" }, [{ k: "set", id: "r1", props: { x: { v: 1 } } }]), "forbidden");
  const out = room.hello({ author: { id: "x@example.com" }, role: null as never }, { type: "hello", protocol: 2, file: FILE, since: 0, epoch: 0, pending: [] });
  assert.deepEqual(out.map((m) => m.type), ["error"]);
});

test("limits: 100 ops per message and per action, 1 MB per action, 5,000 layers and 64 levels per insert", () => {
  const room = seeded();
  const ops = Array.from({ length: 101 }, (): FileOp => ({ k: "set", id: "r1", props: { x: { v: 1 } } }));
  assert.equal(send(room, anna, action(room, ops)).replies[0].type, "error");
  refused(one(room, anna, [{ k: "set", id: "r1", props: { name: { v: "x".repeat(1024 * 1024) } } }]), "invalid");
  const wide = { id: "wide", type: "frame", children: Array.from({ length: 5001 }, (_, i) => ({ id: `w${i}`, type: "rectangle" })) };
  refused(one(room, anna, [{ k: "insert", parent: null, after: null, node: wide as never }]), "invalid");
  let deep: Record<string, Json> = { id: "d65", type: "rectangle" };
  for (let i = 64; i >= 0; i--) deep = { id: `d${i}`, type: "group", children: [deep] };
  refused(one(room, anna, [{ k: "insert", parent: null, after: null, node: deep as never }]), "invalid");
});

test("rows written per action are metered and small", () => {
  const room = seeded();
  ok(one(room, anna, [{ k: "set", id: "r1", props: { x: { v: 3 } } }]));
  assert.ok(room.lastRowsWritten >= 4 && room.lastRowsWritten <= 8, `${room.lastRowsWritten} rows for a one key set`);
});

test("sha256 matches node:crypto", () => {
  for (const s of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "é漢字", "y".repeat(100_000)]) assert.equal(sha256Hex(s), createHash("sha256").update(s).digest("hex"));
});

test("the document keeps its top level key order and the room's copy reads back as the seed", () => {
  const room = seeded();
  const s = seedDocument();
  assert.deepEqual(JSON.parse(room.materialize().document), s.document);
  assert.deepEqual(documentOf(new MemoryTree(stateFromFiles(s.document, s.envelope))), s.document);
});
