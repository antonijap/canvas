import { afterEach, beforeEach, expect, it } from "vitest";
import { evictDurableObject, reset } from "cloudflare:test";
import { CLOUD_VOTES, COMMENTS_CAPABILITIES_HEADER, LIMITS, PROTOCOL_VERSION } from "../../../protocol";
import { bindings, call, connect, envelope, member, owner, post, register, rules } from "./helpers";

const sockets: WebSocket[] = [];
beforeEach(reset);
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); });
async function open(doc: string, email = owner, since = 0, capabilities?: string[]) {
  const connection = await connect(doc, email);
  sockets.push(connection.socket);
  connection.socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, doc, since, capabilities }));
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
it("enforces vote management permissions at message arrival", async () => {
  await rules([{ match: member, role: "viewer" }]);
  const doc = await register();
  const a = await open(doc, member, 0, [CLOUD_VOTES]);
  await a.next();
  const vote = crypto.randomUUID();
  a.socket.send(JSON.stringify({ type: "ops", ops: [envelope(doc, { kind: "vote.end", vote })] }));
  expect(await a.next()).toMatchObject({ type: "reject", rejected: [{ code: "forbidden" }] });
  a.socket.send(JSON.stringify({ type: "ops", ops: [envelope(doc)] }));
  expect([await a.next(), await a.next()]).toContainEqual(expect.objectContaining({ type: "ack", seq: 1 }));
});
it("filters hidden ballots across legacy live, welcome, replay and export routes", async () => {
  await rules([{ match: member, role: "viewer" }]);
  const doc = await register(), vote = crypto.randomUUID(), ballot = crypto.randomUUID();
  const headers = { [COMMENTS_CAPABILITIES_HEADER]: CLOUD_VOTES };
  const topology = { pages: ["page"], nodes: [["note", { page: "page", type: "sticky", chain: ["note"] }]] };
  const route = `/v1/docs/${doc}`;
  expect((await call(route + "/vote-design", member, "PUT", topology)).status).toBe(403);
  expect((await call(route + "/vote-design", owner, "PUT", topology)).status).toBe(200);
  const a = await open(doc, owner, 0, [CLOUD_VOTES]);
  const b = await open(doc, member, 0, [CLOUD_VOTES]);
  const old = await open(doc);
  expect(await a.next()).toMatchObject({ serverTime: expect.any(String) });
  await b.next(); await old.next();
  const start = envelope(doc, { kind: "vote.start", vote, scope: { page: "page" }, on: "stickies", perPerson: 1, hidden: true, anonymous: true });
  const cast = envelope(doc, { kind: "vote.cast", vote, ballot, layer: "note" });
  const submit = (email: string, ops: unknown[]) => call(route + "/ops", email, "POST", { ops }, headers);
  await submit(owner, [start]);
  await a.next(); await b.next(); await old.next();
  await submit(member, [cast]);
  expect(await a.next()).toMatchObject({ type: "applied", votes: [{ ballots: [] }] });
  expect(await b.next()).toMatchObject({ type: "applied", entries: [{ op: { kind: "vote.changed" } }], votes: [{ ballots: [{ id: ballot, layer: "note" }] }] });
  const legacy = await old.next();
  expect(legacy).toMatchObject({ type: "applied", entries: [{ seq: 2, op: { kind: "vote.changed" } }] });
  expect(legacy).not.toHaveProperty("votes");
  const replay = await open(doc, owner, 1, [CLOUD_VOTES]);
  expect(await replay.next()).toMatchObject({ type: "welcome", votes: [{ ballots: [] }] });
  expect(JSON.stringify(await replay.next())).not.toContain(ballot);
  expect(JSON.stringify(await (await call(route + "/threads?since=1", owner, "GET", undefined, headers)).json())).not.toContain(ballot);
  expect(JSON.stringify(await (await call("/v1/export")).json())).not.toContain(ballot);
  const end = envelope(doc, { kind: "vote.end", vote });
  await submit(owner, [end]);
  expect(await b.next()).toMatchObject({ type: "applied", votes: [{ totals: [{ layer: "note", count: 1, names: [] }], ballots: [] }] });
  expect(await a.next()).toMatchObject({ type: "applied", votes: [{ conclusionOp: end.opId }] });
  const exported = await (await call("/v1/export")).json();
  expect(exported).toMatchObject({ docs: [{ doc, votes: [{ id: vote, totals: [{ layer: "note", count: 1 }] }] }] });
  expect(JSON.stringify(exported)).not.toContain(ballot);

});
it("broadcasts when an idle room's vote timer ends", async () => {
  const doc = await register(), vote = crypto.randomUUID(), route = `/v1/docs/${doc}`;
  expect((await call(route + "/vote-design", owner, "PUT", { vote, pages: ["page"], nodes: [] })).status).toBe(200);
  const a = await open(doc, owner, 0, [CLOUD_VOTES]);
  await a.next();
  const headers = { [COMMENTS_CAPABILITIES_HEADER]: CLOUD_VOTES };
  const response = await call(route + "/ops", owner, "POST", { ops: [
    envelope(doc, { kind: "vote.start", vote, scope: { page: "page" }, on: "anything", perPerson: 1, hidden: true, anonymous: true }),
    envelope(doc, { kind: "timer.set", vote, ms: 250 }),
  ] }, headers);
  expect(await response.json()).toMatchObject({ rejected: [] });
  expect(await a.next()).toMatchObject({ votes: [{ id: vote, state: "active" }] });
  expect(await a.next()).toMatchObject({ type: "applied", entries: [{ seq: 3 }], votes: [{ id: vote, state: "ended", needsConclusion: true }] });
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
