// The pure half of comments on the canvas (src/page/comments-logic.js): anchors, where a pin goes, which threads show.

import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore: a browser module without types
import * as L from "../src/page/comments-logic.js";

const thread = (over: Record<string, unknown> = {}) => ({ id: "t", anchor: { nodeId: "A", x: 0.25, y: 0.5, board: "B" }, comments: [], ...over });

test("refusals explain permissions, deletes and limits in plain words", () => {
  const reason = (code?: string, message?: string, kind = "comment.add", role?: string) => L.refusalReason({ code, message, kind }, role);
  assert.equal(reason("forbidden", "This role cannot apply the op", "comment.add", "viewer"), "You can view this file but not comment on it");
  for (const kind of ["comment.edit", "comment.delete", "thread.delete"]) {
    assert.equal(reason("forbidden", "This role cannot apply the op", kind, "commenter"), "Only the person who wrote it can change it");
    assert.equal(reason("forbidden", "This role cannot apply the op", kind, "viewer"), "You can view this file but not comment on it");
  }
  for (const message of ["thread deleted", "comment deleted", "This thread was deleted", "This comment was deleted"]) {
    assert.equal(reason("conflict", message), "This thread was deleted");
  }
  assert.equal(reason("quota", "Too many ops in one minute"), "Too many comments at once. Canvas will try again");
  assert.equal(reason("invalid", "body is invalid"), "Canvas could not send this comment");
  for (const code of ["server", "conflict", "forbidden", "unauthenticated", "not_found", "version", undefined]) {
    assert.equal(reason(code, "Internal server detail"), "The server did not accept this comment");
  }
});

test("a click on a layer is stored as fractions of its box, with the layer's name, type and size", () => {
  const a = L.anchorFor({ nodeId: "A", rect: { x: 100, y: 200, w: 80, h: 40 }, point: { x: 120, y: 230 }, page: "p1", board: "B", info: { name: "Title", type: "text" } });
  assert.deepEqual(a, { page: "p1", nodeId: "A", x: 0.25, y: 0.75, board: "B", preview: { name: "Title", type: "text", width: 80, height: 40 } });
});

test("a click on empty canvas, or on a layer with no size, is a point on the page", () => {
  assert.deepEqual(L.anchorFor({ nodeId: null, rect: null, point: { x: 12.34567, y: -8 }, page: "p1" }), { page: "p1", x: 12.3457, y: -8 });
  assert.deepEqual(L.anchorFor({ nodeId: "A", rect: { x: 0, y: 0, w: 0, h: 10 }, point: { x: 1, y: 2 } }), { x: 1, y: 2 });
});

test("a pin goes where its layer is now, so it follows a move and a resize", () => {
  const t = thread();
  assert.deepEqual(L.pinSpot(t, { layerRect: { x: 0, y: 0, w: 100, h: 100 } }), { x: 25, y: 50, kind: "layer" });
  assert.deepEqual(L.pinSpot(t, { layerRect: { x: 40, y: 10, w: 200, h: 20 } }), { x: 90, y: 20, kind: "layer" });
});

test("a thread with no layer sits on its page point", () => {
  assert.deepEqual(L.pinSpot({ anchor: { x: 5, y: 6 } }, {}), { x: 5, y: 6, kind: "page" });
});

test("a deleted layer's thread goes to its board's corner, stacked, and never onto another layer", () => {
  const t = thread();
  const board = { x: 1000, y: 0, w: 400, h: 300 };
  const s0 = L.pinSpot(t, { gone: true, boardRect: board, slot: 0 })!;
  const s1 = L.pinSpot(t, { gone: true, boardRect: board, slot: 1 })!;
  assert.equal(s0.kind, "board");
  assert.ok(s0.x >= board.x + board.w, "outside the board's right edge");
  assert.ok(s1.y > s0.y, "the next one sits below");
  // Unknown: not deleted but not drawn (its board is off screen): no pin yet, not a guess.
  assert.equal(L.pinSpot(t, {}), null);
  assert.equal(L.pinSpot(t, { gone: true }), null, "no board either: nowhere");
});

test("deleted threads never show; resolved ones only with Show resolved", () => {
  const ts = [thread({ id: "a" }), thread({ id: "b", resolvedAt: "x" }), thread({ id: "c", deletedAt: "x" })];
  assert.deepEqual(L.visibleThreads(ts, false).map((t: any) => t.id), ["a"]);
  assert.deepEqual(L.visibleThreads(ts, true).map((t: any) => t.id), ["a", "b"]);
  assert.deepEqual(L.counts(ts), { open: 1, resolved: 1 });
  assert.equal(L.stillOpen("b", ts, false), null);
  assert.equal(L.stillOpen("b", ts, true), "b");
});

test("a thread shows on the page of its board, else the page it was made on, else the first", () => {
  const pageOfBoard = (b: string) => (b === "B" ? "p2" : null);
  assert.equal(L.pageOf(thread(), pageOfBoard, "p1"), "p2");
  assert.equal(L.pageOf({ anchor: { x: 0, y: 0, page: "p3" } }, pageOfBoard, "p1"), "p3");
  assert.equal(L.pageOf({ anchor: { x: 0, y: 0 } }, pageOfBoard, "p1"), "p1");
});

test("times read short: Now, 5 m, 2 h, 3 d, then a date", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(L.ago(at(10_000), now), "Now");
  assert.equal(L.ago(at(5 * 60_000), now), "5 m");
  assert.equal(L.ago(at(2 * 3600_000), now), "2 h");
  assert.equal(L.ago(at(3 * 86400_000), now), "3 d");
  assert.match(L.ago(at(30 * 86400_000), now), /\w/);
  assert.equal(L.ago("nonsense", now), "");
});

test("people get a steady colour and an initial; agents are told by their client's name", () => {
  assert.equal(L.colorOf("Antonija"), L.colorOf("Antonija"));
  assert.ok(L.AVATARS.includes(L.colorOf("Ben")));
  assert.equal(L.initialOf("  ana"), "A");
  assert.equal(L.initialOf(""), "?");
  assert.equal(L.isAgent({ name: "Claude Code" }), true);
  assert.equal(L.isAgent({ name: "Codex" }), true);
  assert.equal(L.isAgent({ name: "Ben" }), false);
  assert.equal(L.isAgent({ name: "Claude Code", email: "a@b.c" }), false, "a verified person is never an agent");
});

test("the deleted layer line says what it was", () => {
  assert.equal(L.previewLine({ name: "Start free trial", type: "frame", width: 288, height: 44 }), "Start free trial, a frame 288 × 44");
  assert.equal(L.previewLine({ name: "Icon", type: "icon" }), "Icon, an icon");
  assert.equal(L.previewLine(undefined), "Layer");
});

test("the card sits right of its pin, flips left at the edge and stays inside the view", () => {
  assert.deepEqual(L.popoverAt({ x: 100, y: 200 }, { w: 340, h: 200 }, 1000, 800), { x: 118, y: 184 });
  assert.equal(L.popoverAt({ x: 900, y: 200 }, { w: 340, h: 200 }, 1000, 800).x, 900 - 18 - 340);
  assert.equal(L.popoverAt({ x: 100, y: 780 }, { w: 340, h: 200 }, 1000, 800).y, 800 - 200 - 8);
});
