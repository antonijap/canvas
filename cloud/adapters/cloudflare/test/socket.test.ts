import { afterEach, beforeEach, expect, it } from "vitest";
import { evictDurableObject, reset } from "cloudflare:test";
import { LIMITS, PROTOCOL_VERSION } from "../../../protocol";
import { bindings, call, connect, envelope, member, owner, post, register, rules } from "./helpers";

const sockets: WebSocket[] = [];
beforeEach(reset);
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); });
async function open(doc: string, email = owner, since = 0) {
  const connection = await connect(doc, email);
  sockets.push(connection.socket);
  connection.socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, doc, since }));
  return connection;
}
it("hello since zero gets a snapshot, since n gets only newer entries", async () => {
  const doc = await register();
  await post(doc, [envelope(doc), envelope(doc)]);
  const first = await open(doc);
  expect(await first.next()).toMatchObject({ type: "welcome", seq: 2, threads: [{}, {}] });
  const replay = await open(doc, owner, 1);
  const welcome = await replay.next();
  expect(welcome).toMatchObject({ type: "welcome", seq: 2 });
  expect(welcome).not.toHaveProperty("threads");
  expect(await replay.next()).toMatchObject({ type: "applied", entries: [{ seq: 2 }] });
});
it("two sockets receive applied and sender receives an ack", async () => {
  const doc = await register();
  const a = await open(doc);
  const b = await open(doc);
  await a.next(); await b.next();
  const op = envelope(doc);
  a.socket.send(JSON.stringify({ type: "ops", ops: [op] }));
  const sender = [await a.next(), await a.next()];
  expect(sender).toContainEqual({ type: "ack", opId: op.opId, seq: 1 });
  expect(sender).toContainEqual(expect.objectContaining({ type: "applied", entries: [expect.objectContaining({ seq: 1, opId: op.opId, by: { email: owner, name: "owner" } })] }));
  expect(await b.next()).toMatchObject({ type: "applied", entries: [{ seq: 1 }] });
});
it("REST ops also broadcast and duplicates do not broadcast twice", async () => {
  const doc = await register();
  const a = await open(doc);
  await a.next();
  const op = envelope(doc);
  await post(doc, [op, op]);
  expect(await a.next()).toMatchObject({ type: "applied", entries: [{ seq: 1 }] });
});
it("protocol mismatch sends version and closes", async () => {
  const doc = await register();
  const { socket, next } = await connect(doc);
  sockets.push(socket);
  const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION + 1, doc, since: 0 }));
  expect(await next()).toMatchObject({ type: "error", code: "version" });
  expect((await closed).code).toBe(1008);
});
it("rejects a foreign Origin and accepts the own origin", async () => {
  const doc = await register();
  expect((await call(`/v1/docs/${doc}/socket`, owner, "GET", undefined, { Upgrade: "websocket", Origin: "https://foreign.example" })).status).toBe(403);
  const { socket } = await connect(doc, owner, { Origin: "http://localhost" });
  sockets.push(socket);
});
it("lowering to deny closes a person's open socket", async () => {
  await rules([{ match: member, role: "commenter" }]);
  const doc = await register();
  const a = await open(doc, member);
  await a.next();
  const closed = new Promise<CloseEvent>(resolve => a.socket.addEventListener("close", resolve, { once: true }));
  await rules([{ match: member, role: "deny" }]);
  expect((await closed).code).toBe(1008);
  expect((await call(`/v1/docs/${doc}/threads`, member)).status).toBe(403);
});
it("enforces permissions at message arrival", async () => {
  await rules([{ match: member, role: "viewer" }]);
  const doc = await register();
  const a = await open(doc, member);
  await a.next();
  a.socket.send(JSON.stringify({ type: "ops", ops: [envelope(doc)] }));
  expect(await a.next()).toMatchObject({ type: "reject", rejected: [{ code: "forbidden" }] });
  await rules([{ match: member, role: "commenter" }]);
  a.socket.send(JSON.stringify({ type: "ops", ops: [envelope(doc)] }));
  expect([await a.next(), await a.next()]).toContainEqual(expect.objectContaining({ type: "ack", seq: 1 }));
});
it("closes the oldest socket above the per-person limit", async () => {
  const doc = await register();
  const a = await open(doc);
  await a.next();
  const closed = new Promise<CloseEvent>(resolve => a.socket.addEventListener("close", resolve, { once: true }));
  for (let n = 0; n < LIMITS.socketsPerUserPerDoc; n++) {
    const socket = await open(doc);
    await socket.next();
  }
  expect((await closed).code).toBe(1008);
});
it("restores attachments and threads after hibernation", async () => {
  const doc = await register();
  const a = await open(doc);
  await a.next();
  await evictDurableObject(bindings.ROOM.getByName(doc));
  a.socket.send(JSON.stringify({ type: "ops", ops: [envelope(doc)] }));
  expect([await a.next(), await a.next()]).toContainEqual(expect.objectContaining({ type: "ack", seq: 1 }));
  expect(await (await call(`/v1/docs/${doc}/threads`)).json()).toMatchObject({ seq: 1, threads: [{}] });
});
it("overwrites client-supplied internal identity headers", async () => {
  await rules([{ match: member, role: "viewer" }]);
  const doc = await register();
  const { socket, next } = await connect(doc, member, { "x-canvas-internal-email": owner, "x-canvas-internal-role": "owner", "x-canvas-internal-doc": crypto.randomUUID() });
  sockets.push(socket);
  socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, doc, since: 0 }));
  expect(await next()).toMatchObject({ type: "welcome", me: { email: member }, role: "viewer" });
});
it("rejects ops before hello, malformed JSON, foreign docs, and oversized batches", async () => {
  const doc = await register();
  const { socket, next } = await connect(doc);
  sockets.push(socket);
  socket.send(JSON.stringify({ type: "ops", ops: [envelope(doc)] }));
  expect(await next()).toMatchObject({ type: "error", code: "invalid" });
  socket.send("{");
  expect(await next()).toMatchObject({ type: "error", code: "invalid" });
  socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, doc: crypto.randomUUID(), since: 0 }));
  expect(await next()).toMatchObject({ type: "error", code: "invalid" });
  socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, doc, since: 0 }));
  await next();
  socket.send(JSON.stringify({ type: "ops", ops: Array.from({ length: LIMITS.opsPerMessage + 1 }, () => envelope(doc)) }));
  expect(await next()).toMatchObject({ type: "error", code: "quota" });
  socket.send(JSON.stringify({ type: "ops", ops: [envelope(crypto.randomUUID())] }));
  expect(await next()).toMatchObject({ type: "reject", rejected: [{ code: "invalid" }] });
});
it("falls back to threads when the requested replay has been pruned", async () => {
  const doc = await register();
  await post(doc, [envelope(doc), envelope(doc), envelope(doc)]);
  await bindings.ROOM.getByName(doc).snapshot();
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM ops WHERE seq < 3");
  });
  const a = await open(doc, owner, 1);
  expect(await a.next()).toMatchObject({ type: "welcome", seq: 3, threads: [{}, {}, {}] });
});
it("closes sockets on domain removal and role lowering", async () => {
  await rules([{ match: "@example.com", role: "editor" }]);
  const doc = await register();
  const a = await open(doc, member);
  await a.next();
  const closed = new Promise<CloseEvent>(resolve => a.socket.addEventListener("close", resolve, { once: true }));
  await rules([{ match: "@example.com", role: "viewer" }]);
  expect((await closed).code).toBe(1008);
  const b = await open(doc, member);
  await b.next();
  const removed = new Promise<CloseEvent>(resolve => b.socket.addEventListener("close", resolve, { once: true }));
  await rules([]);
  expect((await removed).code).toBe(1008);
});
