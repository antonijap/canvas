import { expect, it } from "vitest";
import { applyOp, checkEnvelope } from "../../protocol";
import type { Thread } from "../../protocol";
import { envelope } from "./helpers";

it("records the shared creation helper's comment-id reuse gap", () => {
  const doc = crypto.randomUUID();
  const first = envelope(doc);
  const second = envelope(doc);
  if (first.op.kind !== "thread.create" || second.op.kind !== "thread.create") throw new Error("Expected creates");
  second.op.comment = first.op.comment;
  const threads: Thread[] = [];
  const by = { email: "owner@example.com", name: "owner" };
  expect(applyOp(threads, doc, first.op, by, first.at)).toBeNull();
  expect(applyOp(threads, doc, second.op, by, second.at)).toBeNull();
  expect(threads[0].comments[0].id).toBe(threads[1].comments[0].id);
});
it("records the shared envelope helper's partial timestamp and anchor validation", () => {
  const op = envelope(crypto.randomUUID());
  op.at = "not a timestamp";
  if (op.op.kind !== "thread.create") throw new Error("Expected create");
  Object.assign(op.op.anchor, { nodeId: 42, revision: "not-a-uuid" });
  expect(checkEnvelope(op)).toBeNull();
});
