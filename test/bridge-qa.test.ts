// qa.* bridge ops (pnpm qa:native) reach the shell only when the server runs with CANVAS_QA=1.

import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatch, isQaOp } from "../src/bridge.ts";

test("qa ops exist only on a QA server", () => {
  assert.equal(isQaOp("qa.mouse", {}), false);
  assert.equal(isQaOp("qa.mouse", { CANVAS_QA: "0" }), false);
  assert.equal(isQaOp("qa.mouse", { CANVAS_QA: "1" }), true);
  assert.equal(isQaOp("qa.", { CANVAS_QA: "1" }), false);
  assert.equal(isQaOp("qa.mouse;rm", { CANVAS_QA: "1" }), false);
  assert.equal(isQaOp("snapshot", { CANVAS_QA: "1" }), false);
});

test("a normal server refuses qa ops before looking for a shell", async () => {
  const saved = process.env.CANVAS_QA;
  delete process.env.CANVAS_QA;
  try {
    await assert.rejects(dispatch({ op: "qa.mouse", args: { x: 1, y: 1 } }, {} as never), (e: { code?: string }) => e.code === "unsupported");
  } finally {
    if (saved !== undefined) process.env.CANVAS_QA = saved;
  }
});

test("a QA server sends qa ops to the shell", async () => {
  const saved = process.env.CANVAS_QA;
  process.env.CANVAS_QA = "1";
  try {
    // No shell is connected in this test: the op got past the op check and failed on the missing shell.
    await assert.rejects(dispatch({ op: "qa.mouse", args: { x: 1, y: 1 } }, {} as never), (e: { code?: string }) => e.code === "no_shell");
  } finally {
    if (saved === undefined) delete process.env.CANVAS_QA; else process.env.CANVAS_QA = saved;
  }
});
