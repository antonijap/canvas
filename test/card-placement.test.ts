import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as placement from "../src/placement.ts";

describe("clearCardSpot", () => {
  const card = { x: 0, y: 0, w: 80, h: 80 };
  test("keeps the preferred spot when it is clear", () => {
    assert.deepEqual(placement.clearCardSpot(card, [{ x: 80, y: 0, w: 100, h: 100 }]), { x: 0, y: 0 });
  });
  test("prefers the right on a tie", () => {
    assert.deepEqual(placement.clearCardSpot(card, [{ x: 0, y: 0, w: 100, h: 100 }]), { x: 140, y: 0 });
  });
  test("moves below when successive obstacles make the right further away", () => {
    const others = [{ x: 0, y: 0, w: 100, h: 140 }, { x: 140, y: 0, w: 150, h: 80 }];
    assert.deepEqual(placement.clearCardSpot(card, others), { x: 0, y: 180 });
  });
  test("checks every obstacle when moving down too", () => {
    const others = [{ x: 0, y: 0, w: 400, h: 100 }, { x: 0, y: 140, w: 80, h: 80 }];
    assert.deepEqual(placement.clearCardSpot(card, others), { x: 0, y: 260 });
  });
});
