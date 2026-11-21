import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Author, Thread } from "../cloud/protocol.ts";
import { CommentReads, isUnread } from "../src/comment-reads.ts";

const anna = { name: "Anna", id: "anna" };
const ben = { name: "Ben", id: "ben" };
const at = (ms: number) => new Date(ms).toISOString();
function thread(id: string, ...messages: [Author, number][]): Thread {
  return {
    id, doc: "file", anchor: { x: 0, y: 0 }, createdAt: at(messages[0][1]), createdBy: messages[0][0],
    comments: messages.map(([author, ms], i) => ({ id: String(i), thread: id, author, body: "Check the spacing", createdAt: at(ms) })),
  };
}

test("unread requires a newer live message from someone else", () => {
  const t = thread("thread", [ben, 10], [anna, 30]);
  assert.equal(isUnread(t, anna, 10), false);
  assert.equal(isUnread(t, anna, 9), true);
  assert.equal(isUnread(t, ben, 10), true);
  assert.equal(isUnread(thread("same-name", [{ ...ben, name: "Anna" }, 30]), anna, 10), true);
  assert.equal(isUnread(thread("old-author", [{ name: "Anna" }, 30]), anna, 10), false);
  assert.equal(isUnread(thread("agent", [{ name: "Anna", agent: true }, 30]), anna, 10), true);
  t.comments[0].deletedAt = at(30);
  assert.equal(isUnread(t, anna, 9), false);
  assert.equal(isUnread({ ...t, deletedAt: at(30) }, ben, 0), false);
});

test("read marks survive restart and stay scoped to the person, file and thread", (test) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-comment-reads-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CommentReads(dir, 20);
  test.after(() => store.close());
  const old = thread("old", [ben, 15]);
  const fresh = thread("fresh", [ben, 30], [anna, 31]);
  const other = thread("other", [ben, 32]);
  assert.deepEqual(store.unread("file", anna, [old, fresh, other]), ["fresh", "other"]);
  store.mark("file", anna, [fresh], false, 35);

  const reopened = new CommentReads(dir, 99);
  test.after(() => reopened.close());
  assert.deepEqual(reopened.unread("file", { ...anna, name: "Anna Studio" }, [old, fresh, other]), ["other"]);
  assert.deepEqual(reopened.unread("file", ben, [fresh]), ["fresh"]);
  assert.deepEqual(reopened.unread("copy", anna, [fresh]), ["fresh"]);
  reopened.mark("file", anna, [old], true, 36);
  assert.deepEqual(reopened.unread("file", anna, [old, fresh, other]), ["old", "other"]);
  reopened.mark("file", anna, [old, other], false, 40);
  assert.deepEqual(reopened.unread("file", anna, [old, fresh, other]), []);
  fresh.comments.push({ ...fresh.comments[0], id: "new", createdAt: at(45) });
  old.comments.push({ ...old.comments[0], id: "new", createdAt: at(46) });
  assert.deepEqual(reopened.unread("file", anna, [old, fresh, other]), ["old", "fresh"]);
});
