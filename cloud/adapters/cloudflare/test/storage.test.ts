import { beforeEach, expect, it, vi } from "vitest";
import { reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { Operations } from "../src/operations";
import { bindings, envelope, member, owner, post, register, rules } from "./helpers";

beforeEach(reset);
it("never snapshots during valid, invalid, duplicate, or forbidden ops", async () => {
  const doc = await register();
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    const operations = new Operations(state.storage);
    const spy = vi.spyOn(operations, "snapshot").mockImplementation(() => { throw new Error("Full scan"); });
    try {
      const op = envelope(doc);
      expect(operations.submit(doc, [op, op, null], { email: owner, name: "owner" }, "owner").acks).toHaveLength(2);
      expect(operations.submit(doc, [envelope(doc)], { email: member, name: "member" }, "viewer").rejected[0].code).toBe("forbidden");
    } finally { spy.mockRestore(); }
  });
});
it("indexes comments transactionally, retains tombstones, and rejects reuse across threads", async () => {
  const doc = await register();
  const a = envelope(doc), b = envelope(doc);
  if (a.op.kind !== "thread.create" || b.op.kind !== "thread.create") throw new Error("Expected create");
  await post(doc, [a, b]);
  await post(doc, [envelope(doc, { kind: "comment.delete", comment: a.op.comment })]);
  const duplicate = envelope(doc, { kind: "comment.add", thread: b.op.thread, comment: a.op.comment, body: "reuse" });
  expect((await post(doc, [duplicate])).rejected[0].code).toBe("conflict");
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM comment_threads").toArray()).toHaveLength(2);
  });
  await evictDurableObject(bindings.ROOM.getByName(doc));
  expect((await post(doc, [duplicate])).rejected[0].code).toBe("conflict");
});
it("rejects the 20 MiB JSON quota atomically, counting UTF-8 bytes", async () => {
  const doc = await register();
  await post(doc, [envelope(doc)]);
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    const json = JSON.stringify("é".repeat(512 * 1024 - 64));
    state.storage.transactionSync(() => {
      for (let i = 2; i <= 21; i++) state.storage.sql.exec("INSERT INTO ops VALUES (?, ?, ?, ?, ?, ?)", i, `seed-${i}`, owner, "owner", new Date().toISOString(), json);
    });
  });
  const op = envelope(doc);
  if (op.op.kind !== "thread.create") throw new Error("Expected create");
  op.op.body = "é".repeat(1000);
  expect((await post(doc, [op])).rejected[0]?.code).toBe("quota");
  expect(await bindings.ROOM.getByName(doc).snapshot()).toMatchObject({ seq: 21, threads: [{}] });
});
it("prunes to 10000 ops while preserving increasing sequence numbers", async () => {
  const doc = await register();
  await post(doc, [envelope(doc)]);
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    state.storage.sql.exec(`WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO ops SELECT x, 'seed-' || x, ?, 'owner', ?, '{}' FROM n`, owner, new Date().toISOString());
  });
  expect((await post(doc, [envelope(doc)])).acks[0].seq).toBe(10001);
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n, MIN(seq) AS first, MAX(seq) AS last FROM ops").one()).toEqual({ n: 10000, first: 2, last: 10001 });
  });
});
it("charges invalid and forbidden ops across rooms before validation", async () => {
  await rules([{ match: member, role: "viewer" }]);
  const a = await register(), b = await register();
  await post(a, Array(100).fill(null), member);
  await post(b, Array(20).fill(null), member);
  expect((await post(b, [envelope(b)], member)).rejected[0].code).toBe("quota");
});
it("backfills legacy comments and byte totals once, and compacts old history on wake", async () => {
  const doc = await register();
  const first = envelope(doc);
  if (first.op.kind !== "thread.create") throw new Error("Expected create");
  const comment = first.op.comment;
  await post(doc, [first]);
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    for (const table of ["ops", "threads"]) for (const action of ["insert", "update", "delete"]) state.storage.sql.exec(`DROP TRIGGER IF EXISTS ${table}_bytes_${action}`);
    state.storage.sql.exec("DROP TRIGGER IF EXISTS ops_receipt_insert; DROP TABLE IF EXISTS op_receipts; DROP TABLE IF EXISTS comment_threads; DROP TABLE IF EXISTS room_usage");
    state.storage.sql.exec(`WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<10001)
      INSERT INTO ops SELECT x, 'seed-' || x, ?, 'owner', ?, '{}' FROM n`, owner, new Date().toISOString());
    new Operations(state.storage);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM ops").one()).toEqual({ n: 10000 });
    expect(state.storage.sql.exec("SELECT comment_id FROM comment_threads").one()).toEqual({ comment_id: comment });
    const totals = () => state.storage.sql.exec(`SELECT
      (SELECT bytes FROM room_usage WHERE id = 1) AS tracked,
      (SELECT SUM(length(CAST(json AS BLOB))) FROM threads) +
      (SELECT SUM(length(CAST(op_json AS BLOB))) FROM ops) +
      (SELECT SUM(length(CAST(op_id AS BLOB)) + 8) FROM op_receipts) AS actual`).one();
    expect(totals().tracked).toBe(totals().actual);
    new Operations(state.storage);
    expect(totals().tracked).toBe(totals().actual);
  });
  expect((await post(doc, [envelope(doc, { kind: "comment.edit", comment, body: "indexed" })])).acks[0].seq).toBe(10002);
});
it("charges oversized rejected batches to the op budget", async () => {
  const doc = await register();
  await post(doc, Array(121).fill(null));
  expect((await post(doc, [envelope(doc)])).rejected[0]?.code).toBe("quota");
});
it("acknowledges a pruned op's original sequence without reverting newer edits", async () => {
  const doc = await register();
  const first = envelope(doc);
  if (first.op.kind !== "thread.create") throw new Error("Expected create");
  const comment = first.op.comment;
  const edit = envelope(doc, { kind: "comment.edit", comment, body: "old edit" });
  await post(doc, [first, edit, envelope(doc, { kind: "comment.edit", comment, body: "new edit" })]);
  await runInDurableObject(bindings.ROOM.getByName(doc), (_instance, state) => {
    state.storage.sql.exec(`WITH RECURSIVE n(x) AS (SELECT 4 UNION ALL SELECT x+1 FROM n WHERE x<10001)
      INSERT INTO ops SELECT x, 'seed-' || x, ?, 'owner', ?, '{}' FROM n`, owner, new Date().toISOString());
  });
  expect((await post(doc, [envelope(doc)])).acks[0].seq).toBe(10002);
  expect((await post(doc, [edit])).acks).toEqual([{ opId: edit.opId, seq: 2 }]);
  const snapshot = await bindings.ROOM.getByName(doc).snapshot();
  expect(snapshot.seq).toBe(10002);
  expect(snapshot.threads.flatMap(t => t.comments).find(c => c.id === comment)?.body).toBe("new edit");
});
