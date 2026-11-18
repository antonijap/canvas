// The nine findings of the security review of the file room (2026-11-18), one test each, written to fail before the
// fix: a restore that snapshots old boards, actions that throw out of the room, removed members who can still upload,
// blob ops that lie about their bytes, paths that differ only by case, a restore racing collection, web pages in
// browser layers, links in a package, empty actions; and versions that outlive 30 days.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoom, NodeSqlStore } from "../cloud/core/files/memory.ts";
import { FileRoom, type Conn } from "../cloud/core/files/room.ts";
import { buildSnapshot, restoreVersion, manifestAt, treeFromManifest, compact } from "../cloud/core/files/snapshots.ts";
import { collectGarbage } from "../cloud/core/files/gc.ts";
import { reserveUpload, putUpload, StorageLedger } from "../cloud/core/files/uploads.ts";
import { RoleCache } from "../cloud/core/files/access.ts";
import { keptVersions } from "../cloud/core/files/versions.ts";
import { openInPackage } from "../cloud/core/files/confine.ts";
import { materialize, stateFromFiles } from "../cloud/core/files/state.ts";
import { Replica } from "../cloud/core/files/replica.ts";
import { MemoryObjects } from "../cloud/core/files/objects.ts";
import { seedDocument, FILE } from "../qa/cloud-files-sim.ts";
import type { Role } from "../cloud/core/files/messages.ts";
import type { Action, FileOp, Json } from "../cloud/core/files/seam.ts";

const anna: Conn = { author: { id: "anna@studio.test", name: "Anna" }, role: "editor" };
let n = 0;
function seeded(o: Parameters<typeof memoryRoom>[1] = {}): FileRoom {
  const room = memoryRoom(FILE, o);
  room.seed(seedDocument().document, seedDocument().envelope);
  return room;
}
const act = (room: FileRoom, ops: FileOp[]): Action => ({ id: `rv-${++n}`, baseSeq: room.meta().seq, epoch: room.meta().epoch, at: "", ops });
const send = (room: FileRoom, ops: FileOp[], conn = anna) => room.submit(conn, { type: "actions", epoch: room.meta().epoch, actions: [act(room, ops)] });
const png = (len: number, salt = 0) => {
  const b = new Uint8Array(len);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < len; i++) b[i] = (i * 13 + salt) & 0xff;
  return b;
};
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test("1. a restore's snapshot holds the restored boards, not the ones before it", async () => {
  const room = seeded();
  const v0 = await buildSnapshot(room, { pinned: true });
  assert.equal(send(room, [{ k: "set", id: "r1", props: { x: { v: 777 } } }]).replies[0].type, "ack");
  await buildSnapshot(room);
  await restoreVersion(room, v0);
  const { tree } = await treeFromManifest(room.objects, (await manifestAt(room, room.meta().seq))!);
  assert.equal(tree.node("r1")!.props.x, 10);
  assert.deepEqual(materialize(tree), room.materialize());
});

test("2. a crafted action never throws out of the room; earlier actions of the message keep their acks", () => {
  const room = seeded();
  let deep: Json = {};
  for (let i = 0; i < 20000; i++) deep = { a: deep };
  const m = room.meta();
  const good = act(room, [{ k: "set", id: "r1", props: { x: { v: 1 } } }]);
  const bad: Action = { id: "deep", baseSeq: m.seq, epoch: m.epoch, at: "", ops: [{ k: "meta", key: "brief", value: { v: deep } }] };
  const r = room.submit(anna, { type: "actions", epoch: m.epoch, actions: [good, bad] });
  assert.deepEqual(r.replies.map((x) => x.type), ["ack", "reject"]);
  assert.equal(r.applied.length, 1);
  assert.equal((r.replies[1] as { code: string }).code, "invalid");
  // A viewer's crafted action is refused before the room hashes anything.
  const v = room.submit({ ...anna, role: "viewer" }, { type: "actions", epoch: m.epoch, actions: [{ ...bad, id: "deep2" }] });
  assert.equal((v.replies[0] as { code: string }).code, "forbidden");
  // Nesting the room can still store and snapshot is fine.
  let ok: Json = {};
  for (let i = 0; i < 40; i++) ok = { a: ok };
  assert.equal(send(room, [{ k: "meta", key: "brief", value: { v: ok } }]).replies[0].type, "ack");
});

test("3. a removed member cannot reserve or upload: uploads ask the room's role check, not the socket's role", async () => {
  let t = Date.parse("2026-11-18T10:00:00Z");
  const roles = new Map<string, Role | null>([[anna.author.id, "editor"]]);
  const cache = new RoleCache({ role: (p) => roles.get(p) ?? null }, () => t);
  const room = seeded({ roles: cache, now: () => t });
  const ledger = new StorageLedger(new NodeSqlStore(), 1e6);
  const b = png(64);
  const id = reserveUpload(room, ledger, anna, { id: "up-rev-0001", sha256: hex(b), bytes: b.length, type: "image/png" });
  cache.push(anna.author.id, null);
  await assert.rejects(putUpload(room, ledger, anna, id, b), /not a member/);
  assert.throws(() => reserveUpload(room, ledger, anna, { id: "up-rev-0002", sha256: hex(b), bytes: b.length, type: "image/png" }), /not a member/);
  // Another member cannot put bytes into Anna's reservation.
  cache.push(anna.author.id, "editor");
  roles.set("ben@studio.test", "editor");
  await assert.rejects(putUpload(room, ledger, { author: { id: "ben@studio.test" }, role: "editor" }, id, b), /someone else's upload/);
});

test("4. a blob op must name the bytes and type its upload stored", async () => {
  const room = seeded();
  const ledger = new StorageLedger(new NodeSqlStore(), 1e9);
  const b = png(5000);
  const id = reserveUpload(room, ledger, anna, { id: "up-blob-0001", sha256: hex(b), bytes: b.length, type: "image/png" });
  await putUpload(room, ledger, anna, id, b);
  const lie = (bytes: number, path: string, type: string) => send(room, [{ k: "blob", path: path as never, sha256: hex(b), bytes, type: type as never }]).replies[0];
  assert.equal((lie(0, "media/a.png", "image/png") as { code: string }).code, "invalid", "bytes 0 would dodge the file cap");
  assert.equal((lie(b.length, "shaders/a.wgsl", "text/wgsl") as { code: string }).code, "invalid", "PNG bytes named as a shader");
  assert.equal(lie(b.length, "media/a.png", "image/png").type, "ack");
  // A second path for the same bytes takes the stored row's size too.
  assert.equal((lie(1, "media/b.png", "image/png") as { code: string }).code, "invalid");
});

test("5. two paths that differ only by case are one file on the Mac's disk: the second is refused", async () => {
  const room = seeded();
  const ledger = new StorageLedger(new NodeSqlStore(), 1e9);
  const b = png(100, 1);
  await putUpload(room, ledger, anna, reserveUpload(room, ledger, anna, { id: "up-case-001", sha256: hex(b), bytes: b.length, type: "image/png" }), b);
  const blob = (path: string) => send(room, [{ k: "blob", path: path as never, sha256: hex(b), bytes: b.length, type: "image/png" }]).replies[0];
  assert.equal(blob("media/Logo.png").type, "ack");
  assert.equal((blob("media/logo.png") as { code: string }).code, "conflict");
  assert.equal((blob("media/LOGO.PNG") as { code: string }).code, "conflict");
  assert.equal(blob("media/Logo.png").type, "ack", "the same path again is the same file");
});

test("6. a restore holds the room's lock throughout: collection between its steps cannot drop its version", async () => {
  let t = Date.parse("2026-10-01T00:00:00Z");
  const room = seeded({ now: () => t });
  const ledger = new StorageLedger(new NodeSqlStore(), 1e9);
  const v0 = await buildSnapshot(room);
  t += 29 * 86_400_000;
  send(room, [{ k: "set", id: "r1", props: { x: { v: 5 } } }]);
  await buildSnapshot(room);
  t += 2 * 86_400_000; // v0 is now past 30 days: the next collection drops it
  const restoring = restoreVersion(room, v0);
  const gc = collectGarbage(room, ledger);
  await Promise.all([restoring, gc]);
  assert.equal(room.tree.node("r1")!.props.x, 10, "the restore ran on v0's objects");
  const { tree } = await treeFromManifest(room.objects, (await manifestAt(room, room.meta().seq))!);
  assert.deepEqual(materialize(tree), room.materialize());
});

test("7. a browser layer in a Cloud file loads no web page: its url is refused", () => {
  const room = seeded();
  const insert = send(room, [{ k: "insert", parent: "b2", after: null, node: { id: "web", type: "browser", url: "https://example.com/track", width: 100, height: 100 } }]).replies[0];
  assert.equal((insert as { code: string }).code, "forbidden");
  assert.equal(send(room, [{ k: "insert", parent: "b2", after: null, node: { id: "web", type: "browser", width: 100, height: 100 } }]).replies[0].type, "ack");
  assert.equal((send(room, [{ k: "set", id: "web", props: { url: { v: "https://example.com/x" } } }]).replies[0] as { code: string }).code, "forbidden");
  assert.equal((send(room, [{ k: "set", id: "i1", props: { "descendants/c1l": { v: { url: "https://example.com/y" } } } }]).replies[0] as { code: string }).code, "forbidden");
  assert.equal(send(room, [{ k: "set", id: "web", props: { url: null } }]).replies[0].type, "ack");
});

test("8. a package file is opened without following links, and a hard link to a file outside is refused", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "canvas-open-"));
  try {
    const root = join(dir, "pkg");
    fs.mkdirSync(join(root, "media"), { recursive: true });
    fs.writeFileSync(join(root, "media", "real.png"), "real");
    fs.writeFileSync(join(dir, "secret.png"), "secret");
    fs.linkSync(join(dir, "secret.png"), join(root, "media", "hard.png"));
    fs.symlinkSync(join(dir, "secret.png"), join(root, "media", "soft.png"));
    const ok = openInPackage(root, "media/real.png", fs);
    assert.ok("fd" in ok);
    assert.equal(fs.readFileSync(ok.fd, "utf8"), "real");
    fs.closeSync(ok.fd);
    assert.match((openInPackage(root, "media/hard.png", fs) as { refused: string }).refused, /link/);
    assert.match((openInPackage(root, "media/soft.png", fs) as { refused: string }).refused, /link/);
    // The folder swapped for a link after the check: the open still refuses it.
    fs.renameSync(join(root, "media"), join(root, "old"));
    fs.mkdirSync(join(dir, "elsewhere"));
    fs.writeFileSync(join(dir, "elsewhere", "real.png"), "elsewhere");
    fs.symlinkSync(join(dir, "elsewhere"), join(root, "media"));
    assert.ok("refused" in openInPackage(root, "media/real.png", fs));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("9. an empty action is refused and burns no seq; a message holds at most 100 actions", () => {
  const room = seeded();
  const seq = room.meta().seq;
  const r = send(room, []).replies[0];
  assert.equal((r as { code: string }).code, "invalid");
  assert.equal(room.meta().seq, seq);
  const many = Array.from({ length: 101 }, () => act(room, []));
  assert.equal(room.submit(anna, { type: "actions", epoch: 1, actions: many }).replies[0].type, "error");
});

test("decision 7: pinned versions also go after 30 days; the newest is always kept", () => {
  const now = Date.parse("2026-11-18T00:00:00Z");
  const day = 86_400_000;
  const rows = [
    { seq: 1, at: now - 40 * day, pinned: true, state: "done" as const },
    { seq: 2, at: now - 20 * day, pinned: true, state: "done" as const },
    { seq: 3, at: now - 1000, pinned: false, state: "done" as const },
  ];
  assert.deepEqual([...keptVersions(rows, now)].sort(), [2, 3]);
  void compact;
});

// The second review (Codex), six more.

test("C1. two splices in one action move over a remote splice in the coordinates the first one left", () => {
  const room = seeded();
  assert.equal(send(room, [{ k: "set", id: "t1", props: { content: { v: "abcdefghij" } } }]).replies[0].type, "ack");
  const base = room.meta().seq;
  assert.equal(send(room, [{ k: "text", id: "t1", baseSeq: base, from: 8, del: 0, ins: "X" }]).replies[0].type, "ack");
  const r = send(room, [{ k: "text", id: "t1", baseSeq: base, from: 0, del: 5, ins: "" }, { k: "text", id: "t1", baseSeq: base, from: 4, del: 1, ins: "" }]).replies[0];
  assert.equal(r.type, "ack");
  assert.equal(room.tree.node("t1")!.props.content, "fghXi");
  // The Mac's view moves them the same way.
  const s = seedDocument();
  const mac = new Replica(anna.author, stateFromFiles(s.document, s.envelope), 0, 1);
  mac.confirm(room.tail(0));
  assert.equal(mac.tree.node("t1")!.props.content, "fghXi");
  // Splices of one action on one layer share a base.
  const m = room.meta().seq;
  assert.equal((send(room, [{ k: "text", id: "t1", baseSeq: m, from: 0, del: 0, ins: "a" }, { k: "text", id: "t1", baseSeq: m - 1, from: 0, del: 0, ins: "b" }]).replies[0] as { code: string }).code, "invalid");
});

test("C2. undoing an insert refuses when someone changed the subtree inside since", () => {
  const room = seeded();
  const a = act(room, [{ k: "insert", parent: "b2", after: null, node: { id: "G", type: "group", children: [] } }]);
  assert.equal(room.submit(anna, { type: "actions", epoch: 1, actions: [a] }).replies[0].type, "ack");
  assert.equal(send(room, [{ k: "insert", parent: "G", after: null, node: { id: "X", type: "rectangle" } }], { author: { id: "ben@studio.test" }, role: "editor" }).replies[0].type, "ack");
  const r = send(room, [{ k: "remove", id: "G", if: a.id }]).replies[0];
  assert.equal((r as { code: string }).code, "conflict");
  assert.ok(room.tree.node("X"), "Ben's layer stays");
  // A move of G itself is not someone's work inside it: its own undo still goes.
  const mv = act(room, [{ k: "move", id: "G", parent: "b1", after: null }]);
  assert.equal(room.submit(anna, { type: "actions", epoch: 1, actions: [mv] }).replies[0].type, "ack");
  assert.equal(send(room, [{ k: "move", id: "G", parent: "b2", after: null, if: mv.id }]).replies[0].type, "ack");
});

test("C3. a move cannot put an instance inside its own component", () => {
  const room = seeded();
  const r = send(room, [{ k: "move", id: "i1", parent: "c1", after: null }]).replies[0];
  assert.equal((r as { code: string }).code, "invalid");
  // Nor a component that holds an instance of another into that other.
  assert.equal(send(room, [{ k: "insert", parent: "b2", after: null, node: { id: "c2", type: "frame", reusable: true, children: [{ id: "i9", type: "ref", ref: "c1" }] } }]).replies[0].type, "ack");
  assert.equal((send(room, [{ k: "move", id: "c2", parent: "c1", after: null }]).replies[0] as { code: string }).code, "invalid");
});

test("C4. past the hello's window of 500, an action the room applied stops waiting when its ack comes", () => {
  const s = seedDocument();
  const mac = new Replica(anna.author, stateFromFiles(s.document, s.envelope), 0, 1);
  for (let i = 0; i < 501; i++) mac.pending.push({ action: { id: `w${i}`, baseSeq: 0, epoch: 1, at: "", ops: [{ k: "set", id: "r1", props: { x: { v: i } } }] }, sha: "", sent: true });
  // The Mac came back from a snapshot at seq 600 that holds all of them; the hello named the first 500 only.
  mac.seq = 600;
  mac.joined = true;
  void mac.receive({ type: "ack", id: "w500", first: 501, last: 501 }, new MemoryObjects());
  assert.equal(mac.pending.length, 501 - 1);
  assert.ok(!mac.pending.some((p) => p.action.id === "w500"));
});

test("C5. the file's byte count is UTF-8 bytes, so text in other scripts cannot pass the 500 MB cap", () => {
  const room = seeded();
  const before = room.store.sql.exec<{ n: number }>("SELECT node_bytes AS n FROM file_meta").one().n;
  assert.equal(send(room, [{ k: "insert", parent: "b2", after: null, node: { id: "wide", type: "text", content: "界".repeat(1000) } }]).replies[0].type, "ack");
  const after = room.store.sql.exec<{ n: number }>("SELECT node_bytes AS n FROM file_meta").one().n;
  const row = room.store.sql.exec<{ n: number }>("SELECT length(CAST(props AS BLOB)) AS n FROM nodes WHERE id = 'wide'").one().n;
  assert.equal(after - before, row);
  assert.ok(row > 3000);
  const all = room.store.sql.exec<{ n: number }>("SELECT SUM(length(CAST(props AS BLOB))) AS n FROM nodes").one().n;
  assert.equal(after, all, "seed and writes count the same way");
});

test("C6. a board holds at most 32 MB of layers", () => {
  const room = seeded();
  const big = "x".repeat(1_000_000);
  let refused: string | null = null;
  for (let i = 0; i < 40 && !refused; i++) {
    const r = send(room, [{ k: "insert", parent: "b2", after: null, node: { id: `big${i}`, type: "text", content: big } }]).replies[0];
    if (r.type === "reject") refused = (r as { message: string }).message;
  }
  assert.match(refused ?? "", /32 MB/);
  // Another board still takes layers, and moving a big layer into the full board is refused too.
  assert.equal(send(room, [{ k: "insert", parent: "b1", after: null, node: { id: "elsewhere", type: "text", content: big } }]).replies[0].type, "ack");
  assert.equal(send(room, [{ k: "move", id: "elsewhere", parent: "b2", after: null }]).replies[0].type, "reject");
  const sum = room.store.sql.exec<{ n: number }>("SELECT bytes AS n FROM board_bytes WHERE board = 'b2'").one().n;
  assert.ok(sum <= 32 * 1024 * 1024);
});
