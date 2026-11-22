import assert from "node:assert/strict";
import test from "node:test";
import { compare, findMachine, parseBudgets, recordBudget, summarize, type Budget, type Machine } from "../bench/perf-budgets.ts";

const commit = "a".repeat(40);
const budget: Budget = { value: 100, spread: 0.02, tolerance: 0.05, date: "2026-11-22", commit };
const machine: Machine = { cpu: "Apple M4 Pro", cores: 14, memoryGiB: 48, os: "darwin", arch: "arm64" };
const entry = { machine, metrics: { "open-2000": budget } };

test("parses budgets and rejects malformed or private fields", () => {
  const parse = (machines: unknown) => parseBudgets(JSON.stringify({ version: 2, machines }));
  assert.deepEqual(parse([entry]), { version: 2, machines: [entry] });
  assert.throws(() => parse([entry, entry]), /duplicate/i);
  for (const patch of [{ value: 0 }, { spread: -0.01 }, { spread: 0.1 }, { tolerance: 0.04 }, { tolerance: 0.06 }, { value: "100" }, { commit: "HEAD" }, { date: "yesterday" }, { date: "2026-02-30" }]) {
    assert.throws(() => parse([{ machine, metrics: { "open-2000": { ...budget, ...patch } } }]));
  }
  assert.throws(() => parse([{ ...entry, machine: { ...machine, hostname: "private" } }]));
  assert.throws(() => parse([{ ...entry, machine: { ...machine, cpu: ["/Users", "example"].join("/") } }]));
  assert.throws(() => parse([{ ...entry, metrics: { typo: budget } }]));
});

test("matches only an identical hardware and platform class", () => {
  const budgets = parseBudgets(JSON.stringify({ version: 2, machines: [entry] }));
  assert.deepEqual(findMachine(budgets, { ...machine }), entry);
  assert.equal(findMachine(budgets, { ...machine, memoryGiB: 64 }), undefined);
  assert.equal(findMachine(budgets, { ...machine, os: "linux" }), undefined);
});

const result = (median: number, spread = 0.02) => ({ median, spread });
const noisyBudget = { ...budget, spread: 0.125, tolerance: 0.25 };

test("records spread and tolerance from the measured samples", () => {
  const metadata = { date: budget.date, commit };
  assert.deepEqual(recordBudget(result(100), metadata), budget);
  assert.deepEqual(recordBudget(result(100, 0.125), metadata), noisyBudget);
});

test("fails only above the stored tolerance, even when the new run is noisy", () => {
  assert.equal(compare(budget, result(105, 0.25)), "pass");
  assert.equal(compare(budget, result(105.01, 0.25)), "fail");
  assert.equal(compare(noisyBudget, result(125)), "pass");
  assert.equal(compare(noisyBudget, result(125.01)), "fail");
  assert.equal(compare({ ...budget, value: 16.67 }, result(16.67 * 1.05)), "pass");
});

test("ratchets only past the stored tolerance and below 5% spread", () => {
  assert.equal(compare(budget, result(95)), "pass");
  assert.equal(compare(budget, result(94.99, 0.05)), "pass");
  assert.equal(compare(budget, result(94.99, 0.0499)), "ratchet");
  assert.equal(compare(noisyBudget, result(75)), "pass");
  assert.equal(compare(noisyBudget, result(74.99)), "ratchet");
});

test("explicit updates also refresh spread and tolerance at the same median", () => {
  assert.equal(compare(budget, result(105.01), true), "update");
  assert.equal(compare(budget, result(100, 0.125), true), "update");
  assert.equal(compare(undefined, result(100)), "missing");
  assert.equal(compare(undefined, result(100), true), "update");
});

test("uses the middle of five samples and divides the full range by the median", () => {
  assert.deepEqual(summarize([102, 97, 100, 99, 101]), { median: 100, spread: 0.05 });
  assert.throws(() => summarize([100, NaN, 101, 102, 103]));
  assert.throws(() => summarize([100, 101]));
});
