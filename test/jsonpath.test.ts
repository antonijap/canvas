import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { evalPath, parsePath, pick } from "../src/widgets/jsonpath.ts";

const data = { stats: { users: 42, "odd key": 7, list: [{ n: 1 }, { n: 2 }, { n: 3 }] }, items: [10, 20, 30], nothing: null };

describe("jsonpath", () => {
  test("keys, brackets, indexes and negative indexes", () => {
    assert.equal(pick(data, "$.stats.users"), 42);
    assert.equal(pick(data, '$["stats"]["odd key"]'), 7);
    assert.equal(pick(data, "$['stats'].users"), 42);
    assert.equal(pick(data, "$.items[0]"), 10);
    assert.equal(pick(data, "$.items[-1]"), 30);
    assert.equal(pick(data, "$.stats.list[1].n"), 2);
    assert.deepEqual(pick(data, "$.items"), [10, 20, 30]);
    assert.equal(pick(data, "$"), data);
  });
  test("a missing step is undefined, not an error", () => {
    assert.equal(pick(data, "$.nope.deeper"), undefined);
    assert.equal(pick(data, "$.items[9]"), undefined);
    assert.equal(pick(data, "$.items.x"), undefined);
    assert.equal(pick(data, "$.nothing.x"), undefined);
    assert.equal(pick(data, "$.stats[0]"), undefined);
  });
  test("[*] only where the caller allows it, and it collects", () => {
    assert.throws(() => parsePath("$.items[*]"), /only allowed/);
    assert.deepEqual(pick(data, "$.stats.list[*].n", { wildcard: true }), [1, 2, 3]);
    assert.deepEqual(pick(data, "$.items[*]", { wildcard: true }), [10, 20, 30]);
    assert.equal(pick(data, "$.stats[*]", { wildcard: true }), undefined);
  });
  test("keys that reach the prototype are rejected, and inherited keys never read", () => {
    for (const p of ["$.__proto__", "$.constructor", "$.constructor.prototype", '$["__proto__"]', "$['prototype']"]) assert.throws(() => parsePath(p), /not allowed/, p);
    assert.equal(evalPath({}, [{ t: "key", v: "toString" }]), undefined);
    assert.equal(evalPath([], [{ t: "key", v: "length" }]), undefined);
  });
  test("malformed paths throw", () => {
    for (const p of ["stats", "$.", "$..a", "$[", "$[a]", "$.a b", "$.items[1.5]", "$" + ".a".repeat(30), "$." + "x".repeat(300)]) assert.throws(() => parsePath(p), Error, p);
  });
});
