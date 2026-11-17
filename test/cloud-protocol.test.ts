// The comments protocol's shared rules (cloud/protocol.ts): what an op does, who may send it, who gets in.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOp, checkEnvelope, mayApply, roleFor, type Author, type Thread } from "../cloud/protocol.ts";

const doc = "00000000-0000-4000-8000-000000000000";
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const anna: Author = { email: "anna@studio.com", name: "Anna" };
const ben: Author = { email: "ben@studio.com", name: "Ben" };

test("ops apply once, deletes are final, replies to a deleted thread conflict", () => {
  const ts: Thread[] = [];
  assert.equal(applyOp(ts, doc, { kind: "thread.create", thread: u(1), anchor: { nodeId: "a", x: 0.5, y: 0.5 }, comment: u(2), body: "Hi" }, anna, "t1"), null);
  assert.equal(applyOp(ts, doc, { kind: "thread.create", thread: u(1), anchor: { x: 0, y: 0 }, comment: u(3), body: "again" }, anna, "t2"), "thread exists");
  assert.equal(applyOp(ts, doc, { kind: "comment.add", thread: u(1), comment: u(4), body: "Reply" }, ben, "t3"), null);
  assert.equal(applyOp(ts, doc, { kind: "thread.delete", thread: u(1) }, anna, "t4"), null);
  assert.ok(ts[0].comments.every((c) => c.deletedAt && c.body === ""), "a deleted thread's comments are tombstones");
  assert.equal(applyOp(ts, doc, { kind: "comment.add", thread: u(1), comment: u(5), body: "late" }, ben, "t5"), "thread deleted");
  assert.equal(applyOp(ts, doc, { kind: "comment.edit", comment: u(2), body: "back?" }, anna, "t6"), "comment deleted");
});

test("envelopes are checked for shape and limits", () => {
  assert.equal(checkEnvelope({ opId: u(9), doc, at: "x", op: { kind: "comment.add", thread: u(1), comment: u(2), body: "ok" } }), null);
  assert.match(checkEnvelope({ opId: "nope", doc, at: "x", op: { kind: "comment.add", thread: u(1), comment: u(2), body: "ok" } })!, /opId/);
  assert.match(checkEnvelope({ opId: u(9), doc, at: "x", op: { kind: "comment.add", thread: u(1), comment: u(2), body: "  " } })!, /empty/);
  assert.match(checkEnvelope({ opId: u(9), doc, at: "x", op: { kind: "comment.add", thread: u(1), comment: u(2), body: "x".repeat(10_001) } })!, /too long/);
  assert.match(checkEnvelope({ opId: u(9), doc, at: "x", op: { kind: "thread.create", thread: u(1), comment: u(2), body: "a", anchor: { x: NaN, y: 0 } } })!, /anchor/);
  assert.match(checkEnvelope({ opId: u(9), doc, at: "x", op: { kind: "drop.tables" } })!, /unknown/);
});

test("authors edit their own comments; viewers cannot comment; editors may delete any", () => {
  const ts: Thread[] = [];
  applyOp(ts, doc, { kind: "thread.create", thread: u(1), anchor: { x: 0, y: 0 }, comment: u(2), body: "Hi" }, anna, "t");
  assert.equal(mayApply({ kind: "comment.edit", comment: u(2), body: "x" }, "commenter", anna, ts), true);
  assert.equal(mayApply({ kind: "comment.edit", comment: u(2), body: "x" }, "owner", ben, ts), false, "not even an owner edits someone else's words");
  assert.equal(mayApply({ kind: "comment.delete", comment: u(2) }, "editor", ben, ts), true);
  assert.equal(mayApply({ kind: "comment.delete", comment: u(2) }, "commenter", ben, ts), false);
  assert.equal(mayApply({ kind: "comment.add", thread: u(1), comment: u(3), body: "x" }, "viewer", ben, ts), false);
});

test("people rules: deny wins, then an exact email, then the domain", () => {
  const rules = [{ match: "@studio.com", role: "commenter" as const }, { match: "anna@studio.com", role: "owner" as const }, { match: "eve@studio.com", role: "deny" as const }];
  assert.equal(roleFor("Anna@Studio.com", rules), "owner");
  assert.equal(roleFor("ben@studio.com", rules), "commenter");
  assert.equal(roleFor("eve@studio.com", rules), null);
  assert.equal(roleFor("mallory@evil.com", rules), null);
  assert.equal(roleFor("not-an-email", rules), null);
});

test("a new thread cannot reuse an existing comment's id (it would take over that comment)", () => {
  const ts: Thread[] = [];
  applyOp(ts, doc, { kind: "thread.create", thread: u(1), anchor: { x: 0, y: 0 }, comment: u(2), body: "Anna's" }, anna, "t1");
  assert.equal(applyOp(ts, doc, { kind: "thread.create", thread: u(3), anchor: { x: 0, y: 0 }, comment: u(2), body: "Ben's" }, ben, "t2"), "comment exists");
  assert.equal(ts.length, 1);
});

test("anchors are small and plain: known keys, short strings, a size cap", () => {
  const env = (anchor: unknown) => ({ opId: u(9), doc, at: "2026-11-17T10:00:00.000Z", op: { kind: "thread.create", thread: u(1), comment: u(2), body: "a", anchor } });
  assert.equal(checkEnvelope(env({ page: "page-1", nodeId: "Btn01", x: 0.5, y: 0.5, board: "b1", preview: { name: "Start free trial", type: "frame", width: 288, height: 44 } })), null);
  assert.match(checkEnvelope(env({ x: 0, y: 0, extra: "x" }))!, /anchor/);
  assert.match(checkEnvelope(env({ x: 0, y: 0, nodeId: "x".repeat(201) }))!, /anchor/);
  assert.match(checkEnvelope(env({ x: 0, y: 0, preview: { name: { deep: "object" } } }))!, /anchor/);
  assert.match(checkEnvelope(env({ x: 0, y: 0, preview: { name: "x".repeat(2000) } }))!, /anchor/);
  assert.match(checkEnvelope({ ...env({ x: 0, y: 0 }), at: "x".repeat(100) })!, /at/);
});
