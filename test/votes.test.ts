import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyOp, checkEnvelope, LIMITS, type Op, type Vote } from "../cloud/protocol.ts";
import { applyEnvelopes, NIL_DOC, threadCreateEnvelope } from "../src/comments.ts";
import { emptyComments, forkComments, readCommentsFile, writeCommentsFile } from "../src/comments-file.ts";
import { opsForShare, shareLocal } from "../src/cloud-sync.ts";
import { visibleVotes } from "../src/votes.ts";
import type { CanvasDoc } from "../src/engine.ts";

const at = new Date().toISOString();
const anna = { id: randomUUID(), name: "Anna" };
const ben = { id: randomUUID(), name: "Ben" };
const envelope = (op: Op) => ({ doc: NIL_DOC, at, opId: randomUUID(), op });

test("vote rules enforce budgets, host ownership, anonymity and ballot retries", () => {
  const votes: Vote[] = [];
  const vote = randomUUID();
  const start: Op = { kind: "vote.start", vote, scope: { page: "page", frame: "frame" }, on: "anything", perPerson: 2, hidden: true, anonymous: true };
  const apply = (op: Op, who = anna) => applyOp([], NIL_DOC, op, who, at, votes);
  assert.match(checkEnvelope(envelope({ ...start, perPerson: LIMITS.votesPerPerson + 1 })) ?? "", /votes each/i);
  assert.equal(checkEnvelope(envelope(start)), null);
  assert.equal(apply(start), null);
  assert.equal(votes[0].host.name, undefined);
  const first: Op = { kind: "vote.cast", vote, ballot: randomUUID(), layer: "layer" };
  const second = { ...first, ballot: randomUUID() };
  assert.equal(apply(first), null);
  assert.equal(apply(first), null);
  assert.equal(apply(second), null);
  assert.equal(votes[0].ballots.length, 2);
  assert.equal(votes[0].ballots[0].voter.name, undefined);
  assert.match(apply({ ...first, ballot: randomUUID() }) ?? "", /votes left/i);
  assert.match(apply({ kind: "vote.retract", vote, ballot: first.ballot }, ben) ?? "", /own/i);
  assert.equal(apply({ kind: "vote.retract", vote, ballot: first.ballot }), null);
  assert.equal(apply(first), null);
  assert.equal(votes[0].ballots.length, 1);
  assert.match(apply({ kind: "vote.end", vote }, ben) ?? "", /host/i);
  assert.equal(apply({ kind: "vote.end", vote }), null);
  assert.match(apply({ ...first, ballot: randomUUID() }) ?? "", /ended/i);
  assert.equal(apply({ kind: "vote.clear", vote }), null);
  assert.equal(votes[0].state, "dismissed");
});

test("comment edits preserve votes and Save As keeps ballots with a fresh document identity", (t) => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-votes-"));
  t.after(() => fs.rmSync(pkg, { recursive: true, force: true }));
  const copy = path.join(pkg, "copy");
  fs.mkdirSync(copy);
  const file = emptyComments();
  const votes: Vote[] = [];
  const vote = randomUUID();
  assert.equal(applyOp([], file.doc, { kind: "vote.start", vote, scope: { page: "page" }, on: "stickies", perPerson: 3, hidden: true, anonymous: false }, anna, at, votes), null);
  assert.equal(applyOp([], file.doc, { kind: "vote.cast", vote, ballot: randomUUID(), layer: "sticky" }, anna, at, votes), null);
  writeCommentsFile(pkg, { ...file, votes });
  const reply = applyEnvelopes(pkg, [threadCreateEnvelope({ x: 0, y: 0 }, "A comment")], { name: "Agent", agent: true });
  assert.equal(reply.applied.length, 1);
  const written = readCommentsFile(pkg)!;
  assert.deepEqual(written.votes, votes);
  assert.equal(written.seq, 0);
  assert.deepEqual(opsForShare(written).map(e => e.op.kind), ["thread.create"]);
  assert.deepEqual(shareLocal(written, "https://example.com", anna).votes, votes);
  forkComments(pkg, copy);
  assert.notEqual(readCommentsFile(copy)!.doc, written.doc);
  assert.deepEqual(readCommentsFile(copy)!.votes, votes);
});

test("hidden votes reveal counts and only the names that people chose to show", () => {
  const file = emptyComments();
  const votes: Vote[] = file.votes = [];
  const vote = randomUUID();
  const doc: CanvasDoc = { version: "2.21", children: [{ type: "sticky", id: "sticky", content: "Review the plan" }] };
  const apply = (op: Op, who = anna) => applyOp([], file.doc, op, who, at, votes);
  apply({ kind: "vote.start", vote, scope: { page: "page" }, on: "stickies", perPerson: 2, hidden: true, anonymous: false });
  const first = randomUUID();
  apply({ kind: "vote.cast", vote, ballot: first, layer: "sticky" });
  apply({ kind: "vote.cast", vote, ballot: randomUUID(), layer: "sticky", showName: false }, ben);
  const [before] = visibleVotes(file, anna.id, doc);
  assert.deepEqual(before.ballots, [{ layer: "sticky", id: first, own: true }]);
  assert.equal(before.results, undefined);
  assert.deepEqual(opsForShare(file), []);
  apply({ kind: "vote.end", vote });
  const [after] = visibleVotes(file, anna.id, doc);
  assert.deepEqual(after.ballots, []);
  assert.deepEqual(after.results?.map(({ color, ...row }) => row), [{ layer: "sticky", name: "Review the plan", count: 2, rank: 1, names: ["Anna"] }]);
});

test("vote ops on an unvouched file are held with its comments", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-vote-vouch-"));
  const stateDir = process.env.CANVAS_STATE_DIR;
  process.env.CANVAS_STATE_DIR = dir;
  t.after(() => {
    if (stateDir === undefined) delete process.env.CANVAS_STATE_DIR;
    else process.env.CANVAS_STATE_DIR = stateDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { vouch } = await import("../src/cloud.ts");
  const f = shareLocal(emptyComments(), "https://example.com", anna);
  const queued = { ...envelope({ kind: "vote.end", vote: randomUUID() }), doc: f.doc };
  f.outbox.push(queued);
  assert.equal(vouch(dir, f), true);
  assert.deepEqual(f.outbox, []);
  assert.deepEqual(f.rejected?.map(r => r.envelope), [queued]);
});
