import { beforeEach, expect, it } from "vitest";
import { listDurableObjectIds, reset, runInDurableObject } from "cloudflare:test";
import { Team } from "../src/team";
import { LIMITS, PROTOCOL_VERSION, roleFor } from "../../protocol";
import { bindings, call, envelope, member, owner, post, register, rules } from "./helpers";

beforeEach(reset);
it("authenticates before touching any objects or trusting internal headers", async () => {
  const response = await call("/v1/me", "", "GET", undefined, { "x-canvas-internal-email": owner, "x-canvas-internal-role": "owner" });
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "unauthenticated" });
  expect(await listDurableObjectIds(bindings.TEAM)).toHaveLength(0);
  expect(await listDurableObjectIds(bindings.ROOM)).toHaveLength(0);
});
it("returns version, identity, and bootstrap owner above deny rules", async () => {
  expect(await (await call("/v1/info")).json()).toEqual({ protocol: PROTOCOL_VERSION, server: "0.1.0", capabilities: ["comments"] });
  await rules([{ match: "@example.com", role: "deny" }]);
  expect(await (await call("/v1/me")).json()).toEqual({ email: owner, name: "owner", role: "owner" });
  expect((await call("/v1/me", member)).status).toBe(403);
});
it("deny beats domain and exact beats domain", async () => {
  expect(roleFor(member, [{ match: "@example.com", role: "editor" }, { match: member, role: "viewer" }])).toBe("viewer");
  expect(roleFor(member, [{ match: "@example.com", role: "deny" }, { match: member, role: "editor" }])).toBeNull();
  await rules([{ match: "@example.com", role: "editor" }, { match: member, role: "viewer" }]);
  expect(await (await call("/v1/me", member)).json()).toMatchObject({ role: "viewer" });
});
it("protects the last owner from removal or deny", async () => {
  // With no bootstrap override, the stored owner list must still leave an owner.
  const team = bindings.TEAM.getByName("team");
  await runInDurableObject(team, async (_instance, state) => {
    const instance = new Team(state, { ...bindings, OWNER_EMAILS: "" });
    state.storage.sql.exec("INSERT INTO people (match, role) VALUES (?, ?)", owner, "owner");
    expect(await instance.replaceRules([])).toMatchObject({ code: "conflict" });
    expect(await instance.replaceRules([{ match: owner, role: "deny" }])).toMatchObject({ code: "conflict" });
  });
});
it.each(["GET", "PUT"])("people %s is owner only", async method => {
  await rules([{ match: member, role: "editor" }]);
  expect((await call("/v1/people", member, method, method === "PUT" ? [] : undefined)).status).toBe(403);
});
it("export is owner only and includes persisted document state", async () => {
  await rules([{ match: member, role: "viewer" }]);
  expect((await call("/v1/export", member)).status).toBe(403);
  const doc = await register();
  await post(doc, [envelope(doc)]);
  expect(await (await call("/v1/export")).json()).toMatchObject({ rules: [{ match: member, role: "viewer" }], docs: [{ doc, createdBy: owner, seq: 1, threads: [{ doc }] }] });
});
it.each([
  [{ match: "MEMBER@example.com", role: "editor" }],
  [{ match: "@example.com", role: "admin" }],
  [{ match: "example.com", role: "viewer" }],
  [{ match: member, role: "viewer" }, { match: member, role: "editor" }],
])("validates people rules: %j", async (...list) => {
  expect((await call("/v1/people", owner, "PUT", list)).status).toBe(400);
});
it("unregistered docs return 404 without creating a room", async () => {
  const before = (await listDurableObjectIds(bindings.ROOM)).map(id => id.toString());
  const doc = crypto.randomUUID();
  for (const [route, method, body] of [["threads", "GET", undefined], ["ops", "POST", { ops: [] }], ["socket", "GET", undefined]] as const) {
    expect((await call(`/v1/docs/${doc}/${route}`, owner, method, body)).status).toBe(404);
  }
  expect((await listDurableObjectIds(bindings.ROOM)).map(id => id.toString())).toEqual(before);
});
it("registration is idempotent, editors may register, commenters may not", async () => {
  await rules([{ match: member, role: "commenter" }]);
  const doc = crypto.randomUUID();
  expect((await call("/v1/docs", member, "POST", { doc })).status).toBe(403);
  await rules([{ match: member, role: "editor" }]);
  expect((await call("/v1/docs", member, "POST", { doc })).status).toBe(200);
  expect((await call("/v1/docs", owner, "POST", { doc })).status).toBe(200);
  const data = await (await call("/v1/export")).json<{ docs: { createdBy: string }[] }>();
  expect(data.docs).toHaveLength(1);
  expect(data.docs[0].createdBy).toBe(member);
});
it("viewers can read but cannot post ops", async () => {
  await rules([{ match: member, role: "viewer" }]);
  const doc = await register();
  expect((await call(`/v1/docs/${doc}/threads?since=0`, member)).status).toBe(200);
  expect((await post(doc, [envelope(doc)], member)).rejected[0].code).toBe("forbidden");
});
it("commenters cannot edit another author and editors may delete any comment", async () => {
  const doc = await register();
  const op = envelope(doc);
  await post(doc, [op]);
  if (op.op.kind !== "thread.create") throw new Error("Expected create");
  await rules([{ match: member, role: "commenter" }]);
  expect((await post(doc, [envelope(doc, { kind: "comment.edit", comment: op.op.comment, body: "changed" })], member)).rejected[0].code).toBe("forbidden");
  await rules([{ match: member, role: "editor" }]);
  expect((await post(doc, [envelope(doc, { kind: "comment.delete", comment: op.op.comment })], member)).acks[0].seq).toBe(2);
});
it("applies once per opId with strictly increasing sequence numbers", async () => {
  const doc = await register();
  const first = envelope(doc);
  const second = envelope(doc);
  expect((await post(doc, [first, first, second])).acks.map(a => a.seq)).toEqual([1, 1, 2]);
  expect((await post(doc, [first])).acks[0].seq).toBe(1);
  expect(await (await call(`/v1/docs/${doc}/threads?since=1`)).json()).toMatchObject({ seq: 2, threads: [{}, {}] });
});
it("reply to a deleted thread conflicts and stores nothing", async () => {
  const doc = await register();
  const first = envelope(doc);
  if (first.op.kind !== "thread.create") throw new Error("Expected create");
  await post(doc, [first, envelope(doc, { kind: "thread.delete", thread: first.op.thread })]);
  const result = await post(doc, [envelope(doc, { kind: "comment.add", thread: first.op.thread, comment: crypto.randomUUID(), body: "reply" })]);
  expect(result.rejected[0].code).toBe("conflict");
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM ops").toArray()).toHaveLength(2);
    const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM threads").one();
    expect(JSON.parse(row.json).comments).toHaveLength(1);
  });
});
it("rejects body and batch limits and enforces rate limits", async () => {
  const doc = await register();
  const op = envelope(doc);
  if (op.op.kind !== "thread.create") throw new Error("Expected create");
  op.op.body = "a".repeat(LIMITS.bodyChars + 1);
  expect((await post(doc, [op])).rejected[0].code).toBe("invalid");
  expect((await call(`/v1/docs/${doc}/ops`, owner, "POST", { ops: Array.from({ length: LIMITS.opsPerMessage + 1 }, () => envelope(doc)) })).status).toBe(429);
  expect((await post(doc, Array.from({ length: 100 }, () => envelope(doc)))).acks).toHaveLength(100);
  const rest = await post(doc, Array.from({ length: 21 }, () => envelope(doc)));
  expect(rest.acks).toHaveLength(20);
  expect(rest.rejected[0].code).toBe("quota");
});
it("rechecks a delayed REST sender's role at the Room", async () => {
  await rules([{ match: member, role: "viewer" }]);
  const doc = await register();
  const result = await bindings.ROOM.getByName(doc).submit(doc, [envelope(doc)], { email: member, name: "member" }, "editor");
  expect(result.rejected[0].code).toBe("forbidden");
});
it("rejects an envelope for another document", async () => {
  const doc = await register();
  expect((await post(doc, [envelope(crypto.randomUUID())])).rejected[0].code).toBe("invalid");
  expect(await (await call(`/v1/docs/${doc}/threads`)).json()).toEqual({ threads: [], seq: 0 });
});
it("limits threads without appending another op", async () => {
  const doc = await register();
  const template = envelope(doc);
  await post(doc, [template]);
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM threads").one();
    state.storage.transactionSync(() => {
      for (let i = 1; i < LIMITS.threadsPerDoc; i++) {
        const thread = { ...JSON.parse(row.json), id: crypto.randomUUID() };
        state.storage.sql.exec("INSERT INTO threads (id, json) VALUES (?, ?)", thread.id, JSON.stringify(thread));
      }
    });
  });
  expect((await post(doc, [envelope(doc)])).rejected[0].code).toBe("quota");
  expect((await bindings.ROOM.getByName(doc).snapshot()).seq).toBe(1);
});
it("limits comments using the shared apply rules", async () => {
  const doc = await register();
  const first = envelope(doc);
  await post(doc, [first]);
  if (first.op.kind !== "thread.create") throw new Error("Expected create");
  const threadId = first.op.thread;
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM threads").one();
    const thread = JSON.parse(row.json);
    thread.comments = Array.from({ length: LIMITS.commentsPerThread }, () => ({ ...thread.comments[0], id: crypto.randomUUID() }));
    state.storage.sql.exec("UPDATE threads SET json = ? WHERE id = ?", JSON.stringify(thread), thread.id);
  });
  expect((await post(doc, [envelope(doc, { kind: "comment.add", thread: threadId, comment: crypto.randomUUID(), body: "extra" })])).rejected[0].code).toBe("conflict");
});
it("rejects malformed JSON, ids, envelopes, and cursors as JSON errors", async () => {
  expect((await call("/v1/docs", owner, "POST", { doc: "bad" })).status).toBe(400);
  const doc = await register();
  expect((await post(doc, [null, {}, { opId: crypto.randomUUID() }])).rejected.map(r => r.code)).toEqual(["invalid", "invalid", "invalid"]);
  expect((await call(`/v1/docs/${doc}/threads?since=-1`)).status).toBe(400);
  expect((await call(`/v1/docs/${doc}/ops`, owner, "POST", { ops: "bad" })).status).toBe(400);
});
it("rejects comment-id reuse before it can grant another author's edit permission", async () => {
  const doc = await register();
  const original = envelope(doc);
  if (original.op.kind !== "thread.create") throw new Error("Expected create");
  await post(doc, [original]);
  await rules([{ match: member, role: "commenter" }]);
  const duplicate = envelope(doc);
  if (duplicate.op.kind !== "thread.create") throw new Error("Expected create");
  duplicate.op.comment = original.op.comment;
  const result = await post(doc, [duplicate, envelope(doc, { kind: "comment.edit", comment: original.op.comment, body: "replaced" })], member);
  expect(result.rejected.map(value => value.code)).toEqual(["conflict", "forbidden"]);
  expect(result.acks).toEqual([]);
  expect(await bindings.ROOM.getByName(doc).snapshot()).toMatchObject({ seq: 1, threads: [{ comments: [{ body: "Hello", author: { email: owner } }] }] });
});
