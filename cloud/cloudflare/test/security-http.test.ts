import { beforeEach, expect, it, vi } from "vitest";
import { reset, runInDurableObject } from "cloudflare:test";
import { PROTOCOL_VERSION } from "../../protocol";
import { bindings, call, connect, envelope, owner, post, register } from "./helpers";

beforeEach(reset);
it.each(["POST", "PUT", "DELETE", "OPTIONS"])("rejects foreign origins before any %s route work", async method => {
  expect((await call("/v1/docs", owner, method, {}, { Origin: "https://foreign.example" })).status).toBe(403);
});
it.each(["text/plain", "application/x-www-form-urlencoded", ""])("rejects non-JSON content type %s", async type => {
  expect((await call("/v1/docs", owner, "POST", { doc: crypto.randomUUID() }, { "Content-Type": type })).status).toBe(403);
});
it("accepts own-origin JSON with charset and absent Origin for native callers", async () => {
  expect((await call("/v1/docs", owner, "POST", { doc: crypto.randomUUID() }, { Origin: "http://localhost", "Content-Type": "application/json; charset=utf-8" })).status).toBe(200);
  await register();
});
it("caps registrations at 1000 but allows an existing document", async () => {
  const doc = await register();
  await runInDurableObject(bindings.TEAM.getByName("team"), (_instance, state) => {
    state.storage.transactionSync(() => {
      for (let i = 1; i < 1000; i++) state.storage.sql.exec("INSERT INTO documents VALUES (?, ?, ?)", crypto.randomUUID(), owner, new Date().toISOString());
    });
  });
  expect((await call("/v1/docs", owner, "POST", { doc })).status).toBe(200);
  const response = await call("/v1/docs", owner, "POST", { doc: crypto.randomUUID() });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "quota" });
});
it("exports 50 documents per cursor page without skips", async () => {
  const ids = Array.from({ length: 51 }, () => crypto.randomUUID()).sort();
  for (const doc of ids) await call("/v1/docs", owner, "POST", { doc });
  const first = await (await call("/v1/export")).json<{ docs: { doc: string }[]; cursor: string | null }>();
  expect(first.docs.map(d => d.doc)).toEqual(ids.slice(0, 50));
  expect(first.cursor).toBe(ids[49]);
  const last = await (await call(`/v1/export?cursor=${first.cursor}`)).json<{ docs: { doc: string }[]; cursor: string | null }>();
  expect(last.docs.map(d => d.doc)).toEqual(ids.slice(50));
  expect(last.cursor).toBeNull();
  expect((await call("/v1/export?cursor=bad")).status).toBe(400);
});
it("serves REST replay and falls back for zero, future, or pruned cursors", async () => {
  const doc = await register();
  await post(doc, [envelope(doc), envelope(doc), envelope(doc)]);
  expect(await (await call(`/v1/docs/${doc}/threads?since=1`)).json()).toMatchObject({ seq: 3, entries: [{ seq: 2 }, { seq: 3 }] });
  expect(await (await call(`/v1/docs/${doc}/threads?since=3`)).json()).toEqual({ seq: 3, entries: [] });
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => { state.storage.sql.exec("DELETE FROM ops WHERE seq < 3"); });
  for (const since of [0, 1, 99]) expect(await (await call(`/v1/docs/${doc}/threads?since=${since}`)).json()).toMatchObject({ seq: 3, threads: [{}, {}, {}] });
});
it("counts invalid HTTP bodies and GET threads before room work", async () => {
  const doc = await register();
  for (let i = 0; i < 120; i++) await call(`/v1/docs/${doc}/ops`, owner, "POST", { ops: "invalid" });
  expect((await call(`/v1/docs/${doc}/threads`)).status).toBe(429);
});
it("counts repeated GET threads and socket hello against the same email budget", async () => {
  const doc = await register();
  const { socket, next } = await connect(doc);
  try {
    socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, doc, since: 0 }));
    expect(await next()).toMatchObject({ type: "welcome" });
    for (let i = 0; i < 117; i++) expect((await call(`/v1/docs/${doc}/threads`)).status).toBe(200);
    expect((await call(`/v1/docs/${doc}/threads`)).status).toBe(429);
  } finally { socket.close(); }
});
it("looks up roles by indexed email and domain keys", async () => {
  await runInDurableObject(bindings.TEAM.getByName("team"), instance => {
    const spy = vi.spyOn(instance, "rules").mockImplementation(() => { throw new Error("Full rule scan"); });
    try { expect(instance.role(owner)).toBe("owner"); expect(instance.role("nobody@example.net")).toBeNull(); }
    finally { spy.mockRestore(); }
  });
});
