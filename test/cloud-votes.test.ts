import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Operations } from "../cloud/core/operations.ts";
import { SqliteStore } from "../cloud/adapters/mac/sqlite.ts";
import { LIMITS, type Op, type Role } from "../cloud/protocol.ts";

const anna = { id: "anna-person", email: "anna@studio.test", name: "Anna" };
const ben = { id: "ben-person", email: "ben@studio.test", name: "Ben" };
const doc = randomUUID();
const vote = randomUUID();
const start = { kind: "vote.start", vote, scope: { page: "page", frame: "frame" }, on: "stickies", perPerson: 1, hidden: true, anonymous: true } as const;
const at = new Date().toISOString();
const ballot = randomUUID();
const cast = { kind: "vote.cast", vote, ballot, layer: "sticky" } as const;
const envelope = (op: Op) => ({ doc, opId: randomUUID(), at, op });
const design = {
  page: (id: string) => id === "page" || /^page-\d+$/.test(id),
  node: (id: string) => ({
    frame: { page: "page", chain: ["frame"], type: "frame" },
    sticky: { page: "page", chain: ["frame", "sticky"], type: "sticky" },
    outside: { page: "page", chain: ["outside"], type: "sticky" },
    shape: { page: "page", chain: ["frame", "shape"], type: "rectangle" },
    disabled: { page: "page", chain: ["frame", "disabled"], type: "sticky", disabled: true },
  } as Record<string, { page: string; chain: string[]; type: string; disabled?: boolean }>)[id],
};
function room(t: TestContext) {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const ops = new Operations(store);
  store.sql.exec("ALTER TABLE ops ADD COLUMN by_id TEXT");
  return { store, ops, submit: (op: Op, by = anna, role: Role = "owner") => ops.submit(doc, [envelope(op)], by, role, 100, [], design) };
}

test("room filters anonymous hidden ballots from peers, history and exports", t => {
  const { store, ops, submit } = room(t);
  assert.equal(submit(start).acks.length, 1);
  const applied = submit(cast, ben, "viewer");
  assert.equal(applied.acks.length, 1);
  assert.doesNotMatch(JSON.stringify(applied.entries), /vote\.cast|sticky|ben-person|Ben/);
  assert.deepEqual(ops.voteView(anna)[0].ballots, []);
  assert.deepEqual(ops.voteView(ben)[0].ballots, [{ id: ballot, layer: "sticky" }]);
  assert.doesNotMatch(JSON.stringify(ops.read(1)), /vote\.cast|sticky|ben-person|Ben/);
  assert.doesNotMatch(JSON.stringify(ops.snapshot()), /votes|sticky|ben-person|Ben/);
  const privateData = store.sql.exec<{ json: string }>("SELECT json FROM room_votes").one().json;
  assert.match(privateData, /sticky/);
  assert.doesNotMatch(privateData, /anna-person|ben-person|Anna|Ben/);
  const key = JSON.parse(privateData).anonymousKey;
  const voter = createHmac("sha256", Buffer.from(key, "hex")).update(JSON.stringify([vote, ben.id])).digest("hex");
  assert.equal(JSON.parse(privateData).ballots[0].voter.id, voter);
  assert.equal(submit({ kind: "vote.end", vote }, anna, "editor").acks.length, 1);
  assert.deepEqual(ops.voteView(anna)[0].totals, [{ layer: "sticky", count: 1, names: [] }]);
  assert.deepEqual(ops.voteView(ben)[0].ballots, []);
});

test("room enforces current roles, scope, targets, allowance and retract ownership", t => {
  const { submit, ops } = room(t);
  assert.equal(submit(start, ben, "viewer").rejected[0].code, "forbidden");
  assert.equal(submit({ ...start, scope: { page: "missing" } }).rejected[0].code, "conflict");
  assert.equal(submit({ ...start, scope: { page: "page", frame: "sticky" } }).rejected[0].code, "conflict");
  assert.equal(submit(start).acks.length, 1);
  for (const layer of ["missing", "outside", "shape", "disabled"])
    assert.equal(submit({ ...cast, layer }, ben, "viewer").rejected[0].code, "conflict");
  assert.equal(submit(cast, ben, "viewer").acks.length, 1);
  assert.equal(submit({ ...cast, ballot: randomUUID() }, ben, "viewer").rejected[0].code, "conflict");
  const retract = { kind: "vote.retract", vote, ballot } as const;
  assert.equal(submit(retract).rejected[0].code, "conflict");
  assert.equal(submit(retract, ben, "viewer").acks.length, 1);
  assert.equal(submit(cast, ben, "viewer").acks.length, 1);
  assert.deepEqual(ops.voteView(ben)[0].ballots, []);
  for (const op of [{ kind: "vote.end", vote }, { kind: "vote.clear", vote }, { kind: "timer.set", vote, ms: 3000 }] as const)
    assert.equal(submit(op, ben, "viewer").rejected[0].code, "forbidden");
  assert.equal(submit({ kind: "vote.end", vote }, ben, "editor").acks.length, 1);
  assert.equal(submit({ kind: "vote.clear", vote }, anna, "editor").acks.length, 1);
  const thread = { kind: "thread.create", thread: randomUUID(), comment: randomUUID(), anchor: { x: 0, y: 0 }, body: "A note" } as const;
  assert.equal(submit(thread, ben, "viewer").acks.length, 1);
});

test("room caps open votes and gives the winning end operation to its author only", t => {
  const { ops, submit } = room(t);
  for (let i = 0; i < LIMITS.openVotesPerDoc; i++)
    assert.equal(submit({ ...start, scope: { page: `page-${i}` }, vote: randomUUID() }).acks.length, 1);
  assert.equal(submit(start).rejected[0].code, "conflict");
  const another = new SqliteStore(":memory:");
  t.after(() => another.close());
  const live = new Operations(another);
  const end = envelope({ kind: "vote.end", vote });
  live.submit(doc, [envelope(start)], anna, "owner", 100, [], design);
  live.submit(doc, [end], ben, "editor", 100, [], design);
  live.submit(doc, [envelope({ kind: "vote.end", vote })], anna, "owner", 100, [], design);
  assert.equal(live.voteView(ben)[0].conclusionOp, end.opId);
  assert.equal(live.voteView(anna)[0].conclusionOp, undefined);
  assert.equal(ops.voteView(anna).length, LIMITS.openVotesPerDoc);
});

test("a timer closes against the room clock and one editor can claim its conclusion", t => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  let now = Date.parse(at);
  const ops = new Operations(store, () => now);
  const apply = (op: Op, by = anna, role: Role = "owner") => ops.submit(doc, [envelope(op)], by, role, 100, [], design);
  assert.equal(apply(start).acks.length, 1);
  assert.equal(apply({ kind: "timer.set", vote, ms: 3000 }).acks.length, 1);
  assert.equal(ops.voteView(anna)[0].timer?.startedAt, at);
  now += 3000;
  const refused = apply(cast, ben, "viewer");
  assert.equal(refused.rejected[0].code, "conflict");
  assert.equal(refused.entries[0].op.kind, "vote.changed");
  assert.equal(ops.voteView(ben)[0].state, "ended");
  assert.equal(ops.voteView(anna)[0].needsConclusion, true);
  assert.equal(apply({ kind: "vote.end", vote }, ben, "viewer").rejected[0].code, "forbidden");
  assert.equal(apply({ kind: "vote.end", vote }, ben, "editor").acks.length, 1);
  assert.equal(apply({ kind: "vote.end", vote }, anna).acks.length, 1);
  assert.ok(ops.voteView(ben)[0].conclusionOp);
  assert.equal(ops.voteView(anna)[0].conclusionOp, undefined);
});

test("anonymous open voting shows progress only and erases live linkage at end", t => {
  const { store, ops, submit } = room(t);
  const second = randomUUID();
  submit({ ...start, hidden: false });
  submit({ ...start, vote: second, scope: { page: "page-2" } });
  submit(cast, ben, "viewer");
  assert.equal(ops.voteView(anna)[0].totals, undefined);
  assert.equal(ops.voteView(anna)[0].done, 1);
  const raw = (id: string) => JSON.parse(store.sql.exec<{ json: string }>("SELECT json FROM room_votes WHERE id = ?", id).one().json);
  const live = raw(vote);
  assert.ok(live.anonymousKey);
  assert.notEqual(live.anonymousKey, raw(second).anonymousKey);
  submit({ kind: "vote.end", vote });
  const ended = raw(vote);
  assert.equal(ended.anonymousKey, undefined);
  assert.notEqual(ended.ballots[0].voter.id, live.ballots[0].voter.id);
  assert.notEqual(ended.ballots[0].id, ballot);
  assert.deepEqual(ops.voteView(anna)[0].totals, [{ layer: "sticky", count: 1, names: [] }]);
});

test("reading an idle room expires its timer without a submitted op", t => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  let now = Date.parse(at);
  const ops = new Operations(store, () => now);
  ops.submit(doc, [envelope(start), envelope({ kind: "timer.set", vote, ms: 3000 })], anna, "owner", 100, [], design);
  now += 3000;
  assert.equal(ops.read(2).seq, 3);
  assert.equal(ops.voteView(anna)[0].state, "ended");
});

test("publishing one vote design leaves another page's vote intact", t => {
  const { ops } = room(t);
  const second = randomUUID();
  const submit = (op: Op) => ops.submit(doc, [envelope(op)], anna, "owner", 100, [], true);
  const topology = (id: string, page: string, layer: string) => ({ vote: id, pages: [page], nodes: [[layer, { page, chain: [layer], type: "sticky" }]] });
  assert.ok(ops.setVoteDesign(topology(vote, "page", "sticky")));
  assert.equal(submit({ ...start, scope: { page: "page" } }).acks.length, 1);
  assert.ok(ops.setVoteDesign(topology(second, "page-2", "other")));
  assert.equal(submit({ ...start, vote: second, scope: { page: "page-2" } }).acks.length, 1);
  assert.equal(submit(cast).acks.length, 1);
});

test("a shared package never writes personal vote views or waiting ballots", async t => {
  const { randomUUID } = await import("node:crypto");
  const { emptyComments, readCommentsFile, writeCommentsFile } = await import("../src/comments-file.ts");
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-vote-sidecar-"));
  t.after(() => fs.rmSync(pkg, { recursive: true, force: true }));
  const file = emptyComments(), id = randomUUID(), ballot = randomUUID();
  const view = { id, scope: { page: "page-1" }, on: "anything", perPerson: 1, hidden: true, anonymous: false,
    state: "active", ballots: [{ id: ballot, layer: "private-target" }] } as const;
  writeCommentsFile(pkg, { ...file, server: { url: "https://studio.test" },
    cloudVotes: [{ ...view, ballots: [...view.ballots] }], voteConclusions: [id],
    outbox: [{ doc: file.doc, opId: randomUUID(), at: new Date().toISOString(), op: { kind: "vote.cast", vote: id, ballot, layer: "private-target" } }] });
  const stored = readCommentsFile(pkg)!;
  assert.equal(stored.cloudVotes, undefined);
  assert.equal(stored.voteConclusions, undefined);
  assert.deepEqual(stored.outbox, []);
  assert.doesNotMatch(fs.readFileSync(path.join(pkg, "comments.json"), "utf8"), /private-target/);
});


test("a comments-only account reloads its own vote queue from private storage", async t => {
  const { emptyComments } = await import("../src/comments-file.ts");
  const { savePrivateVotes, withPrivateVotes } = await import("../src/vote-state.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-private-votes-"));
  const oldDir = process.env.CANVAS_STATE_DIR;
  process.env.CANVAS_STATE_DIR = dir;
  t.after(() => {
    if (oldDir === undefined) delete process.env.CANVAS_STATE_DIR;
    else process.env.CANVAS_STATE_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = { ...emptyComments(), server: { url: "https://studio.test" } };
  const queued = { ...envelope(cast), doc: file.doc };
  savePrivateVotes({ ...file, outbox: [queued] }, anna.id);
  assert.deepEqual(withPrivateVotes(file, anna.id).outbox, [queued]);
  assert.deepEqual(withPrivateVotes(file, ben.id).outbox, []);
  assert.deepEqual(withPrivateVotes({ ...file, doc: randomUUID() }, anna.id).outbox, []);
  const cache = path.join(dir, "cloud-votes");
  assert.equal(fs.statSync(path.join(cache, fs.readdirSync(cache)[0])).mode & 0o777, 0o600);
});

test("the standalone timer uses server time, keeps its paused time and broadcasts idle expiry", t => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  let now = Date.parse(at);
  const ops = new Operations(store, () => now);
  const apply = (action: Op, role: Role = "editor") => ops.submit(doc, [envelope(action)], anna, role, 100, [], design);
  const timer = { kind: "timer.set", standalone: true, vote: randomUUID() } as const;
  assert.equal(apply({ ...timer, action: "start", ms: 4000 }, "viewer").rejected[0].code, "forbidden");
  assert.equal(apply({ ...timer, action: "start", ms: 4000 }).acks.length, 1);
  assert.deepEqual(ops.socialView(anna).timer, ops.socialView(ben).timer);
  assert.equal(ops.nextVoteExpiry(), now + 4000);
  now += 1000;
  assert.equal(apply({ ...timer, action: "pause" }).acks.length, 1);
  assert.equal(ops.nextVoteExpiry(), undefined);
  now += 5000;
  assert.equal(apply({ ...timer, action: "extend" }).acks.length, 1);
  assert.equal(ops.socialView(ben).timer?.remainingMs, 63_000);
  assert.equal(apply({ ...timer, action: "resume" }).acks.length, 1);
  assert.equal(ops.nextVoteExpiry(), now + 63_000);
  const expiry: number[] = [];
  ops.onVotesExpired = entries => expiry.push(...entries.map(e => e.seq));
  now += 63_000;
  ops.expireDueVotes();
  ops.expireDueVotes();
  assert.equal(expiry.length, 1);
  assert.equal(ops.socialView(ben).timer?.endedAt, new Date(now).toISOString());
  assert.equal(ops.nextVoteExpiry(), undefined);
  assert.equal(ops.socialView(anna).votes.length, 0);
  assert.equal(apply({ ...timer, action: "stop" }).acks.length, 1);
  assert.equal(ops.socialView(ben).timer, null);
});

test("a legacy whole-document vote design stays live after vote start", t => {
  const { ops, store } = room(t);
  const submit = (op: Op) => ops.submit(doc, [envelope(op)], anna, "owner", 100, [], true);
  assert.ok(ops.setVoteDesign({ pages: ["page"], nodes: [] }));
  assert.equal(submit({ ...start, scope: { page: "page" } }).acks.length, 1);
  assert.ok(ops.setVoteDesign({ pages: ["page"], nodes: [["sticky", { page: "page", chain: ["sticky"], type: "sticky" }]] }));
  assert.equal(submit(cast).acks.length, 1);
  // Upgraded rooms may already contain a frozen copy from a previous start.
  store.sql.exec("INSERT INTO vote_designs (id, json) VALUES (?, ?)", vote, JSON.stringify({ pages: ["page"], nodes: [] }));
  assert.equal(submit({ ...cast, ballot: randomUUID() }).rejected[0].message, "You have no votes left");
});

test("an unconfirmed conclusion can be reclaimed after its lease, then confirmed", t => {
  const { store } = room(t);
  let now = Date.parse(at);
  const ops = new Operations(store, () => now);
  const target = "vote-conclusion-" + vote;
  const submit = (op: Op, by = anna, cardExists = false) => ops.submit(doc, [envelope(op)], by, "editor", 100, [], {
    ...design, node: id => id === target && cardExists ? { type: "frame", page: "page", chain: [id] } : design.node(id),
  });
  submit(start);
  submit({ kind: "vote.end", vote }, ben);
  assert.equal(ops.voteView(anna)[0].needsConclusion, false);
  now += 10 * 60_000;
  ops.expireDueVotes();
  assert.equal(ops.voteView(anna)[0].needsConclusion, true);
  const claim = submit({ kind: "vote.end", vote, expired: true });
  assert.equal(ops.voteView(anna)[0].conclusionOp, claim.acks[0].opId);
  const confirm = { kind: "vote.conclusion", vote, claim: claim.acks[0].opId } as const;
  assert.equal(submit(confirm).rejected[0].code, "conflict");
  assert.equal(submit(confirm, anna, true).acks.length, 1);
  now += 10 * 60_000;
  assert.equal(ops.voteView(ben)[0].needsConclusion, false);
});

test("a migrated anonymous conclusion becomes claimable again", t => {
  const { store, submit } = room(t);
  submit(start);
  submit(cast, ben, "viewer");
  submit({ kind: "vote.end", vote });
  const row = store.sql.exec<{ json: string }>("SELECT json FROM room_votes WHERE id = ?", vote).one();
  const legacy = { ...JSON.parse(row.json), conclusion: { by: "", opId: randomUUID() } };
  store.sql.exec("UPDATE room_votes SET json = ? WHERE id = ?", JSON.stringify(legacy), vote);
  const migrated = new Operations(store);
  assert.equal(migrated.voteView(anna)[0].needsConclusion, true);
  assert.deepEqual(migrated.voteView(anna)[0].totals, [{ layer: "sticky", count: 1, names: [] }]);
});

test("a full room returns a permanent timer refusal distinct from rate limiting", t => {
  const { store, submit, ops } = room(t);
  store.sql.exec("UPDATE room_usage SET bytes = ? WHERE id = 1", 20 * 1024 * 1024);
  const op = { kind: "timer.set", standalone: true, vote, ms: 1000, action: "start" } as const;
  assert.equal(submit(op).rejected[0].code, "storage_quota");
  assert.equal(ops.submit(doc, [envelope(op)], anna, "owner", 0, [], design).rejected[0].code, "quota");
});

test("transfers omit unsupported timers without dropping ballots", async () => {
  const { voteOpsForTransfer } = await import("../src/vote-state.ts");
  const timer = { kind: "timer.set", standalone: true, vote, action: "pause" } as const;
  const ops = [envelope({ ...start, timerMs: 3000 }), envelope(cast), envelope(timer)];
  assert.deepEqual(voteOpsForTransfer(ops, false).map(e => e.op), [start, cast]);
  assert.deepEqual(voteOpsForTransfer([envelope(timer)], false), []);
});

test("legacy vote migration matches the verified account and holds ambiguous entries", async t => {
  const { emptyComments } = await import("../src/comments-file.ts");
  const { stageLegacyVoteQueue, migrateLegacyVoteQueue } = await import("../src/vote-state.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-legacy-queue-"));
  const oldDir = process.env.CANVAS_STATE_DIR;
  process.env.CANVAS_STATE_DIR = dir;
  t.after(() => {
    if (oldDir === undefined) delete process.env.CANVAS_STATE_DIR;
    else process.env.CANVAS_STATE_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = { ...emptyComments(), server: { url: "https://studio.test" }, me: anna };
  const queued = { ...envelope(cast), doc: file.doc };
  stageLegacyVoteQueue("known", { ...file, outbox: [queued] }, true);
  assert.deepEqual(migrateLegacyVoteQueue("known", file, ben.id).outbox, []);
  assert.deepEqual(migrateLegacyVoteQueue("known", file, anna.id).outbox, [queued]);
  const ambiguous = { ...queued, opId: randomUUID() };
  stageLegacyVoteQueue("unknown", { ...file, outbox: [ambiguous] }, false);
  const unverified = migrateLegacyVoteQueue("unknown", file, anna.id);
  assert.deepEqual(unverified.outbox, [queued]);
  assert.deepEqual(unverified.rejected?.map(r => r.envelope), [ambiguous]);
});
