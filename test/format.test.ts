import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deltaOf, formatValue } from "../src/widgets/format.ts";

describe("format", () => {
  test("auto, integer, compact, percent, currency, duration", () => {
    assert.equal(formatValue(1234, "auto"), "1,234");
    assert.equal(formatValue(1234.5678, "auto"), "1,234.57");
    assert.equal(formatValue(12_345, "auto"), "12.3K");
    assert.equal(formatValue(1234.6, "integer"), "1,235");
    assert.equal(formatValue(1_500_000, "compact"), "1.5M");
    assert.equal(formatValue(0.423, "percent"), "42.3%");
    assert.equal(formatValue(1200, "currency:USD"), "$1,200");
    assert.equal(formatValue(12.5, "currency:EUR"), "€12.50");
    assert.equal(formatValue(42, "duration"), "42s");
    assert.equal(formatValue(3725, "duration"), "1h 2m");
    assert.equal(formatValue(90061, "duration"), "1d 1h");
  });
  test("numeric strings format, other text passes through, units attach", () => {
    assert.equal(formatValue("42", "integer"), "42");
    assert.equal(formatValue("healthy", "auto"), "healthy");
    assert.equal(formatValue(250, "auto", "ms"), "250 ms");
    assert.equal(formatValue(12, "auto", "%"), "12%");
  });
  test("deltas carry sign and a ratio when there is a base", () => {
    assert.deepEqual(deltaOf(110, 100), { value: 10, pct: 0.1, display: "+10%" });
    assert.equal(deltaOf(50, 100)?.display, "-50%");
    assert.equal(deltaOf(5, 0)?.display, "+5");
    assert.equal(deltaOf(1, NaN), undefined);
  });
});
