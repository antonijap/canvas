// The conversations sidebar, the pure half (src/page/conversations-logic.js): state words, what a row says, running first.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a browser module without types
import * as L from "../src/page/conversations-logic.js";

const c = (o: object) => ({ key: "a", ids: ["a"], run: "r", prompt: "Make it calmer", name: "Hero", page: "p1", pageName: "Final", board: "B", at: 0, status: "done", running: false, gone: false, harness: "claude", ...o });

describe("conversations sidebar", () => {
  test("state words", () => {
    assert.deepEqual(["running", "done", "stopped", "failed"].map(L.stateWord), ["Running", "Done", "Stopped", "Failed"]);
  });
  test("a row names the layer, the prompt and where it is; a deleted layer says so and cannot be opened", () => {
    const r = L.rowOf(c({ at: new Date(2026, 10, 1, 18, 40).getTime() }), new Date(2026, 10, 1, 20, 0).getTime());
    assert.deepEqual([r.title, r.prompt, r.state, r.when, r.where, r.canOpen], ["Hero", "Make it calmer", "Done", "18:40", "Final", true]);
    const g = L.rowOf(c({ gone: true, board: null, pageName: null }), 0);
    assert.deepEqual([g.where, g.canOpen], ["Layer deleted", false]);
  });
  test("running ones come first, each group keeps its order", () => {
    const list = [c({ run: "1" }), c({ run: "2", running: true, status: "running" }), c({ run: "3" }), c({ run: "4", running: true, status: "running" })];
    assert.deepEqual(L.runningFirst(list).map((x: any) => x.run), ["2", "4", "1", "3"]);
  });
});
