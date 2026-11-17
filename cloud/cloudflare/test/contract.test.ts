import { expect, it } from "vitest";
import { applyOp, checkEnvelope } from "../../protocol";
import type { Thread } from "../../protocol";
import { envelope } from "./helpers";

it("rejects reused initial comment ids in the shared creation helper", () => {
  const doc = crypto.randomUUID();
  const first = envelope(doc);
  const second = envelope(doc);
  if (first.op.kind !== "thread.create" || second.op.kind !== "thread.create") throw new Error("Expected creates");
  second.op.comment = first.op.comment;
  const threads: Thread[] = [];
  const by = { email: "owner@example.com", name: "owner" };
  expect(applyOp(threads, doc, first.op, by, first.at)).toBeNull();
  expect(applyOp(threads, doc, second.op, by, second.at)).toBe("comment exists");
  expect(threads).toHaveLength(1);
});
it("accepts ISO times and plain anchors under the shared limits", () => {
  const op = envelope(crypto.randomUUID());
  op.at = "2026-11-17T12:00:00.000Z";
  if (op.op.kind !== "thread.create") throw new Error("Expected create");
  Object.assign(op.op.anchor, { nodeId: "layer", revision: crypto.randomUUID() });
  expect(checkEnvelope(op)).toBeNull();
  op.at = "x".repeat(41);
  expect(checkEnvelope(op)).not.toBeNull();
  op.at = new Date().toISOString();
  Object.assign(op.op.anchor, { unknown: true });
  expect(checkEnvelope(op)).not.toBeNull();
});
