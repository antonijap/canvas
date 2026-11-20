// Limits a Cloud file room keeps (plan Sections 5 and 5b): storage reserved before bytes arrive, so parallel uploads
// racing for the last bytes never pass the cap; a person's per minute budget shared by leases across rooms; and a
// removal the room never heard about still takes effect within the 60 second role check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { memoryRoom, NodeSqlStore } from "../cloud/core/files/memory.ts";
import { FileRoom, FILE_NODE_CAP, type Conn } from "../cloud/core/files/room.ts";
import { BOARD_CAP } from "../cloud/core/files/tree-sql.ts";
import { Replica, PENDING_CAP } from "../cloud/core/files/replica.ts";
import { stateFromFiles } from "../cloud/core/files/state.ts";
import { reserveUpload, putUpload, StorageLedger, UploadError, UPLOAD_LIMITS, sniffType } from "../cloud/core/files/uploads.ts";
import { LeaseBank, RoomLeases, LEASE_LIMITS } from "../cloud/core/files/leases.ts";
import { RoleCache, ROLE_FRESH_MS } from "../cloud/core/files/access.ts";
import { MemoryObjects } from "../cloud/core/files/objects.ts";
import { seedDocument, FILE } from "../qa/cloud-files-sim.ts";
import type { Role } from "../cloud/core/files/messages.ts";
import type { Action } from "../cloud/core/files/seam.ts";

const anna: Conn = { author: { id: "anna@studio.test", name: "Anna" }, role: "editor" };
const ben: Conn = { author: { id: "ben@studio.test", name: "Ben" }, role: "editor" };

const png = (n: number, salt: number) => {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < n; i++) b[i] = (i * 31 + salt) & 0xff;
  return b;
};
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function seeded(file = FILE, o: Parameters<typeof memoryRoom>[1] = {}): FileRoom {
  const room = memoryRoom(file, o);
  room.seed(seedDocument().document, seedDocument().envelope);
  return room;
}
let n = 0;
const set = (room: FileRoom, x: number): Action => ({ id: `q-${++n}`, baseSeq: room.meta().seq, epoch: room.meta().epoch, at: "", ops: [{ k: "set", id: "r1", props: { x: { v: x } } }] });

test("parallel uploads racing for the last bytes: exactly those that fit get in, across rooms of one Cloud", async () => {
  const team = new NodeSqlStore();
  const ledger = new StorageLedger(team, 1000);
  const objects = new MemoryObjects();
  const rooms = [0, 1, 2].map((i) => seeded(`0f9d6a52-3c1e-4b8a-9d47-2b6f1e0c7a1${i}`, { objects }));
  const files = Array.from({ length: 9 }, (_, i) => png(300, i));
  const results = await Promise.allSettled(
    files.map(async (b, i) => {
      const room = rooms[i % 3];
      const id = reserveUpload(room, ledger, i % 2 ? anna : ben, { id: `up-race-${i}`, sha256: hex(b), bytes: b.length, type: "image/png" });
      return putUpload(room, ledger, i % 2 ? anna : ben, id, b);
    }),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const quota = results.filter((r) => r.status === "rejected" && (r.reason as UploadError).code === "quota").length;
  assert.equal(ok, 3, "3 x 300 bytes fit in 1000");
  assert.equal(quota, 6);
  assert.ok(ledger.held() <= 1000);
  assert.equal(ledger.held(), 900);
  // Bytes that do not match what was reserved are refused, and their reservation goes back.
  const b = png(50, 99);
  reserveUpload(rooms[0], ledger, anna, { id: "up-bad-hash", sha256: hex(png(50, 98)), bytes: 50, type: "image/png" });
  assert.equal(ledger.held(), 950);
  await assert.rejects(putUpload(rooms[0], ledger, anna, "up-bad-hash", b), /hash/);
  assert.equal(ledger.held(), 900);
});

test("upload checks: role, type sniffed from the bytes, per kind and per file sizes", async () => {
  const ledger = new StorageLedger(new NodeSqlStore(), 10 * 1024 ** 3);
  const room = seeded();
  const b = png(80, 1);
  assert.throws(() => reserveUpload(room, ledger, { ...anna, role: "viewer" }, { id: "up-v-00001", sha256: hex(b), bytes: 80, type: "image/png" }), /cannot add files/);
  assert.throws(() => reserveUpload(room, ledger, anna, { id: "up-x-00001", sha256: hex(b), bytes: 80, type: "application/x-sh" }), /not a type/);
  assert.throws(() => reserveUpload(room, ledger, anna, { id: "up-big-0001", sha256: hex(b), bytes: UPLOAD_LIMITS.image + 1, type: "image/png" }), /at most 100 MB/);
  reserveUpload(room, ledger, anna, { id: "up-lie-0001", sha256: hex(b), bytes: 80, type: "image/jpeg" });
  await assert.rejects(putUpload(room, ledger, anna, "up-lie-0001", b), /image\/png, not image\/jpeg/);
  // Per file: 1 GB of blobs, counted before any bytes come.
  for (let i = 0; i < 10; i++) reserveUpload(room, ledger, anna, { id: `up-gb-${String(i).padStart(4, "0")}`, sha256: hex(png(10, i)), bytes: 100 * 1024 * 1024, type: "image/png" });
  assert.throws(() => reserveUpload(room, ledger, anna, { id: "up-gb-last", sha256: hex(b), bytes: 100 * 1024 * 1024, type: "image/png" }), /at most 1 GB/);
  assert.equal(sniffType(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')), "image/svg+xml");
  assert.equal(sniffType(new TextEncoder().encode("@fragment fn main() {}")), "text/wgsl");
  assert.equal(sniffType(new Uint8Array([0, 1, 2, 0])), null);
});

test("leases: a person's budget per minute holds across 3 rooms, and a lease covers many actions with one Team call", () => {
  let t = Date.parse("2026-11-18T10:00:05Z");
  const bank = new LeaseBank(new NodeSqlStore());
  const leases = [0, 1, 2].map(() => new RoomLeases(bank, () => t));
  const rooms = leases.map((l, i) => seeded(`0f9d6a52-3c1e-4b8a-9d47-2b6f1e0c7a2${i}`, { leases: l, now: () => t }));
  let acked = 0, quota = 0;
  for (let i = 0; i < 300; i++) {
    const room = rooms[i % 3];
    const r = room.submit(anna, { type: "actions", epoch: 1, actions: [set(room, i)] }).replies[0];
    if (r.type === "ack") acked++;
    else if (r.type === "reject" && r.code === "quota") quota++;
  }
  assert.equal(acked, LEASE_LIMITS.ops, "120 one-op actions a minute, in all rooms together");
  assert.equal(quota, 300 - LEASE_LIMITS.ops);
  assert.equal(bank.granted(anna.author.id, "ops", t), LEASE_LIMITS.ops);
  const calls = leases.reduce((s, l) => s + l.calls, 0);
  assert.ok(calls < 60, `${calls} Team calls for 300 actions`);
  // Ben has his own budget; and the next minute Anna has hers back.
  assert.equal(rooms[0].submit(ben, { type: "actions", epoch: 1, actions: [set(rooms[0], 1)] }).replies[0].type, "ack");
  t += 60_000;
  assert.equal(rooms[1].submit(anna, { type: "actions", epoch: 1, actions: [set(rooms[1], 1)] }).replies[0].type, "ack");
});

test("a removal push that never arrived: the room asks the Team again after 60 s and refuses from then on", () => {
  let t = Date.parse("2026-11-18T10:00:00Z");
  const roles = new Map<string, Role | null>([[anna.author.id, "editor"]]);
  const cache = new RoleCache({ role: (p) => roles.get(p) ?? null }, () => t);
  const room = seeded(FILE, { roles: cache, now: () => t });
  assert.equal(room.submit(anna, { type: "actions", epoch: 1, actions: [set(room, 1)] }).replies[0].type, "ack");
  // The Team removes Anna; its push to this room is lost.
  roles.set(anna.author.id, null);
  t += ROLE_FRESH_MS - 1000;
  assert.equal(room.submit(anna, { type: "actions", epoch: 1, actions: [set(room, 2)] }).replies[0].type, "ack", "inside the window the old answer stands");
  t += 1000;
  const r = room.submit(anna, { type: "actions", epoch: 1, actions: [set(room, 3)] }).replies[0];
  assert.equal(r.type, "reject");
  assert.equal((r as { code: string }).code, "forbidden");
  assert.equal(room.hello(anna, { type: "hello", protocol: 2, file: FILE, since: 0, epoch: 1, pending: [] })[0].type, "error");
  // A push that does arrive takes effect at once, inside the window.
  roles.set(ben.author.id, "editor");
  assert.equal(room.submit(ben, { type: "actions", epoch: 1, actions: [set(room, 4)] }).replies[0].type, "ack");
  cache.push(ben.author.id, "viewer");
  assert.equal(room.submit(ben, { type: "actions", epoch: 1, actions: [set(room, 5)] }).replies[0].type, "reject");
});

test("caps on the room's rows: a layer row stays under 2 MB, a file under 20,000 boards and 500 MB of layers", () => {
  const room = seeded();
  const send = (ops: Action["ops"]) => room.submit(anna, { type: "actions", epoch: 1, actions: [{ id: `cap-${++n}`, baseSeq: room.meta().seq, epoch: 1, at: "", ops }] }).replies[0];
  // Overrides grow one path at a time; the third 900 KB one would pass the row cap.
  const big = "x".repeat(900 * 1024);
  assert.equal(send([{ k: "set", id: "i1", props: { "descendants/a": { v: { name: big } } } }]).type, "ack");
  assert.equal(send([{ k: "set", id: "i1", props: { "descendants/b": { v: { name: big } } } }]).type, "ack");
  const r = send([{ k: "set", id: "i1", props: { "descendants/c": { v: { name: big } } } }]);
  assert.equal(r.type, "reject");
  assert.match((r as { message: string }).message, /at most 2 MB/);
  // The file's layer bytes are counted with every write; near the cap, growth is refused and shrinking is not.
  const used = room.store.sql.exec<{ n: number }>("SELECT node_bytes AS n FROM file_meta").one().n;
  assert.ok(used > 2 * 900 * 1024, `${used} bytes counted`);
  room.store.sql.exec("UPDATE file_meta SET node_bytes = ? WHERE id = 1", FILE_NODE_CAP - 10);
  const full = send([{ k: "insert", parent: "b2", after: null, node: { id: "more", type: "rectangle", name: "More" } }]);
  assert.equal((full as { code: string }).code, "quota");
  assert.equal(send([{ k: "set", id: "i1", props: { "descendants/a": null } }]).type, "ack", "a write that frees bytes goes through");
  // Boards.
  const many = memoryRoom(FILE);
  many.seed({ children: Array.from({ length: BOARD_CAP }, (_, i) => ({ id: `b${i}`, type: "frame" })) });
  const r2 = many.submit(anna, { type: "actions", epoch: 1, actions: [{ id: "one-more", baseSeq: 0, epoch: 1, at: "", ops: [{ k: "insert", parent: null, after: null, node: { id: "extra", type: "frame" } }] }] }).replies[0];
  assert.match((r2 as { message: string }).message, /at most 20000 boards/);
});

test("a Mac keeps at most 50,000 ops waiting, then asks for a copy instead of queueing more", () => {
  const s = seedDocument();
  const r = new Replica(anna.author, stateFromFiles(s.document, s.envelope), 0, 1);
  const ops: Action["ops"] = Array.from({ length: 100 }, () => ({ k: "set", id: "r1", props: { x: { v: 1 } } }));
  for (let i = 0; i < PENDING_CAP.ops / 100; i++) r.pending.push({ action: { id: `p${i}`, baseSeq: 0, epoch: 1, at: "", ops }, sha: "", sent: false });
  const out = r.propose([{ k: "set", id: "r1", props: { x: { v: 2 } } }]);
  assert.ok("reject" in out && out.reject === "quota");
});

test('the file cap includes existing layer data when reserving media',()=>{
 const cap=UPLOAD_LIMITS.file,room=memoryRoom(crypto.randomUUID());UPLOAD_LIMITS.file=400;
 try{room.store.sql.exec('UPDATE file_meta SET node_bytes=300 WHERE id=1');assert.throws(()=>reserveUpload(room,{reserve:()=>true,release:()=>{}},{author:{id:'anna',name:'Anna'},role:'editor'},{id:crypto.randomUUID(),sha256:'a'.repeat(64),bytes:200,type:'image/png'}),/1 GB|full/);}finally{UPLOAD_LIMITS.file=cap;(room.store as NodeSqlStore).close();}
});
