// demos/learn.canvas (built by demos/build-learn.ts), the file a first launch copies to Welcome.canvas.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const doc = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../demos/learn.canvas/document.json"), "utf8"));

test("the Playground board's hint sits inside the board, clear of its name label, and does not repeat the name", () => {
  const board = doc.children.find((n: any) => n.id === "playground");
  assert.ok(board, "the Playground board");
  const hint = board.children.find((n: any) => n.type === "text");
  assert.ok(hint, "its hint");
  // A frame without `layout` is a horizontal row, which puts the hint at the board's top left corner whatever its x
  // and y say: on the edge, right under the board's name label.
  assert.equal(board.layout, "none", "the hint keeps its own x and y");
  assert.ok(hint.x >= 24 && hint.y >= 24, `the hint is inset from the board's corner (${hint.x}, ${hint.y})`);
  assert.ok(hint.y + hint.fontSize * 2 <= board.height, "and inside the board");
  assert.ok(!hint.content.includes(board.name), `the label already says "${board.name}": "${hint.content}"`);
  assert.equal(hint.content, "Make something, or ask your agent to.");
});
