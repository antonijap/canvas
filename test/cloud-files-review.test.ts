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
import { materialize } from "../cloud/core/files/state.ts";
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
