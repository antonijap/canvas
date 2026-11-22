import assert from "node:assert/strict";
import test from "node:test";
import { compare, findMachine, parseBudgets, summarize, type Budget, type Machine } from "../bench/perf-budgets.ts";

const commit = "a".repeat(40);
const budget: Budget = { value: 100, date: "2026-11-22", commit };
const machine: Machine = { cpu: "Apple M4 Pro", cores: 14, memoryGiB: 48, os: "darwin", arch: "arm64" };
const entry = { machine, metrics: { "open-2000": budget } };

test("parses budgets and rejects malformed or private fields", () => {
  const parse = (machines: unknown) => parseBudgets(JSON.stringify({ version: 1, machines }));
  assert.deepEqual(parse([entry]), { version: 1, machines: [entry] });
  assert.throws(() => parse([entry, entry]), /duplicate/i);
  for (const patch of [{ value: 0 }, { value: "100" }, { commit: "HEAD" }, { date: "yesterday" }, { date: "2026-02-30" }]) {
    assert.throws(() => parse([{ machine, metrics: { "open-2000": { ...budget, ...patch } } }]));
  }
  assert.throws(() => parse([{ ...entry, machine: { ...machine, hostname: "private" } }]));
  assert.throws(() => parse([{ ...entry, machine: { ...machine, cpu: ["/Users", "example"].join("/") } }]));
  assert.throws(() => parse([{ ...entry, metrics: { typo: budget } }]));
});

test("matches only an identical hardware and platform class", () => {
  const budgets = parseBudgets(JSON.stringify({ version: 1, machines: [entry] }));
  assert.deepEqual(findMachine(budgets, { ...machine }), entry);
  assert.equal(findMachine(budgets, { ...machine, memoryGiB: 64 }), undefined);
  assert.equal(findMachine(budgets, { ...machine, os: "linux" }), undefined);
});

test("fails above 5% and tightens only beyond a 3% improvement", () => {
  assert.equal(compare(budget, 105), "pass");
  assert.equal(compare(budget, 105.01), "fail");
  assert.equal(compare(budget, 97), "pass");
  assert.equal(compare(budget, 96.99), "ratchet");
  assert.equal(compare(budget, 105.01, true), "update");
  assert.equal(compare(undefined, 100), "missing");
  assert.equal(compare(undefined, 100, true), "update");
  assert.equal(compare(budget, 100, true), "pass");
  assert.equal(compare({ ...budget, value: 16.67 }, 16.67 * 1.05), "pass");
});

test("uses the median of three and reports range relative to the median", () => {
  assert.deepEqual(summarize([102, 97, 100]), { median: 100, spread: 0.05 });
  assert.throws(() => summarize([100, NaN, 101]));
  assert.throws(() => summarize([100, 101]));
});
