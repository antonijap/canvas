// Board snapshots (src/page/snapshots.js): which boards are captured and at what size, which stored pictures go.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports
import * as S from "../src/page/snapshots.js";

const cam = { x: 0, y: 0, z: 1 };

describe("captureRect", () => {
  test("a board wholly in view is read at device pixels", () => {
    assert.deepEqual(S.captureRect({ x: 10, y: 20, w: 100, h: 200 }, cam, 800, 600, 2), { sx: 20, sy: 40, sw: 200, sh: 400, w: 200, h: 400 });
  });
  test("the camera places it: zoom and pan", () => {
    const r = S.captureRect({ x: 100, y: 100, w: 400, h: 300 }, { x: -50, y: 10, z: 0.5 }, 800, 600, 1);
    assert.deepEqual(r, { sx: 0, sy: 60, sw: 200, sh: 150, w: 200, h: 150 });
  });
  test("partly off screen, or too small, is not captured", () => {
    assert.equal(S.captureRect({ x: -1, y: 0, w: 100, h: 100 }, cam, 800, 600, 1), null);
    assert.equal(S.captureRect({ x: 750, y: 0, w: 100, h: 100 }, cam, 800, 600, 1), null);
    assert.equal(S.captureRect({ x: 0, y: 0, w: S.SNAP_MIN_SIDE - 1, h: 400 }, cam, 800, 600, 1), null);
    assert.equal(S.captureRect({ x: 0, y: 0, w: 0, h: 100 }, cam, 800, 600, 1), null);
    assert.equal(S.captureRect(null, cam, 800, 600, 1), null);
  });
  test("the picture's long side is capped", () => {
    const r = S.captureRect({ x: 0, y: 0, w: 1000, h: 3000 }, cam, 2000, 4000, 2);
    assert.equal(r.sh, 6000);
    assert.equal(r.h, S.SNAP_MAX_SIDE);
    assert.equal(r.w, Math.round(2000 * (S.SNAP_MAX_SIDE / 6000)));
  });
});

describe("toCapture", () => {
  let at = 0; // each test board in its own place: boards that overlap are not captured
  const board = (id: string, o: object = {}) => ({ id, key: "k-" + id, loadedKey: "k-" + id, rect: { x: 0, y: (at++ % 4) * 150, w: 100, h: 100 }, ...o });
  const opts = { cam, vw: 800, vh: 600, dpr: 1 };
  test("only boards drawn at their current key", () => {
    const got = S.toCapture([board("a"), board("b", { loadedKey: "old" }), board("c", { loadedKey: null }), board("d", { key: "" })], opts);
    assert.deepEqual(got.map((x: { id: string }) => x.id), ["a"]);
  });
  test("not under another board", () => {
    const list = [board("a"), board("b", { rect: { x: 50, y: 50, w: 100, h: 100 } }), board("c", { rect: { x: 400, y: 0, w: 100, h: 100 } })];
    list[0].rect = { x: 0, y: 0, w: 100, h: 100 };
    assert.deepEqual(S.toCapture(list, opts).map((x: { id: string }) => x.id), ["c"]);
  });
  test("not under a card, not with live edits on top", () => {
    const list = [board("a", { rect: { x: 0, y: 0, w: 100, h: 100 } }), board("b", { rect: { x: 300, y: 0, w: 100, h: 100 } }), board("c", { rect: { x: 500, y: 0, w: 100, h: 100 } })];
    const got = S.toCapture(list, { ...opts, cards: [{ x: 50, y: 50, w: 10, h: 10 }], touched: (id: string) => id === "b" });
    assert.deepEqual(got.map((x: { id: string }) => x.id), ["c"]);
  });
  test("a stored picture is replaced only by a clearly sharper one", () => {
    assert.equal(S.toCapture([board("a")], { ...opts, have: () => ({ w: 100 }) }).length, 0);
    assert.equal(S.toCapture([board("a")], { ...opts, dpr: 2, have: () => ({ w: 100 }) }).length, 1);
    assert.equal(S.worthStoring(null, 10), true);
    assert.equal(S.worthStoring({ w: 100 }, 124), false);
    assert.equal(S.worthStoring({ w: 100 }, 126), true);
  });
  test("capture stops checking storage once its batch is full", () => {
    const list = [board("a", { rect: { x: 0, y: 0, w: 100, h: 100 } }), board("b", { rect: { x: 300, y: 0, w: 100, h: 100 } })];
    let checks = 0;
    const got = S.toCapture(list, { ...opts, limit: 1, have: () => { checks++; return null; } });
    assert.deepEqual(got.map((x: { id: string }) => x.id), ["a"]);
    assert.equal(checks, 1);
  });
});

describe("toEvict", () => {
  const m = (id: string, o: object) => ({ id, file: "f", board: id, key: "k", bytes: 10, used: 0, ...o });
  test("keys a board no longer has, and boards gone, go first (this file only)", () => {
    const metas = [m("a", { key: "k1" }), m("b", { key: "k2" }), m("c", { key: "k3" }), m("x", { file: "other", key: "zz" })];
    const keys = new Map([["a", "k1"], ["b", "NEW"]]);
    assert.deepEqual(S.toEvict(metas, 1e9, "f", keys).sort(), ["b", "c"]);
  });
  test("then the least recently used until everything fits the budget", () => {
    const metas = [m("a", { used: 3, bytes: 50 }), m("b", { used: 1, bytes: 50 }), m("c", { used: 2, bytes: 50 })];
    assert.deepEqual(S.toEvict(metas, 100), ["b"]);
    assert.deepEqual(S.toEvict(metas, 50), ["b", "c"]);
    assert.deepEqual(S.toEvict(metas, 1000), []);
  });
  test("a stale one already going counts toward the budget", () => {
    const metas = [m("a", { used: 1, bytes: 60, key: "old" }), m("b", { used: 2, bytes: 60 })];
    assert.deepEqual(S.toEvict(metas, 100, "f", new Map([["a", "new"], ["b", "k"]])), ["a"]);
  });
  test("ids keep file, board, key and canvas colour apart", () => {
    const ids = new Set([S.snapId("f", "b", "k", "white"), S.snapId("f", "b", "k", "black"), S.snapId("f", "b", "k2", "white"), S.snapId("g", "b", "k", "white")]);
    assert.equal(ids.size, 4);
  });
  test("a different render environment cannot reuse an old board image", () => {
    assert.notEqual(S.snapId("f", "b", "k", "white", "old"), S.snapId("f", "b", "k", "white", "new"));
  });
});

test("replacing an asset at the same URL changes the snapshot key", () => {
  const url = "/asset?p=picture.png";
  assert.notEqual(
    S.snapId("f", "b", "k", "white", "env", [[url, '"old"']]),
    S.snapId("f", "b", "k", "white", "env", [[url, '"new"']]),
  );
});
