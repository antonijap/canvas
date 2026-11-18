// The qa:native harness's own guards (qa/native/harness.ts, app.ts): text recognition one read at a time across
// runs, a dead run's lock cleared, and bundle ids unique per run so parallel runs never clear each other's storage.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { NT, withVisionLock } from "../qa/native/harness.ts";
import { QaApp, BUNDLE_BASE } from "../qa/native/app.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("qa:native harness", () => {
  test("text recognition reads never overlap, whoever asks", async () => {
    const lock = path.join(tmpDir("vision-lock"), "lock");
    let inside = 0, most = 0;
    const read = () => withVisionLock(async () => { inside++; most = Math.max(most, inside); await sleep(20); inside--; return true; }, lock);
    const r = await Promise.all(Array.from({ length: 8 }, read));
    assert.equal(r.length, 8);
    assert.equal(most, 1, "two reads ran at once");
    assert.ok(!fs.existsSync(lock), "the lock is released");
  });

  test("a lock a dead run left behind is taken over after a minute", async () => {
    const lock = path.join(tmpDir("vision-lock-stale"), "lock");
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    const t0 = Date.now();
    assert.equal(await withVisionLock(async () => "read", lock), "read");
    assert.ok(Date.now() - t0 < 2000, "it did not wait for the stale lock");
  });

  test("a read that throws releases the lock", async () => {
    const lock = path.join(tmpDir("vision-lock-throw"), "lock");
    await assert.rejects(withVisionLock(async () => { throw new Error("e5rt"); }, lock), /e5rt/);
    assert.ok(!fs.existsSync(lock));
  });

  test("each run's instances have bundle ids of their own", () => {
    const a = new QaApp("/tmp/x", 1);
    assert.ok(a.bundleId.startsWith(`${BUNDLE_BASE}.`));
    assert.ok(a.bundleId.includes(String(process.pid)), `${a.bundleId} does not name the run`);
    assert.notEqual(a.bundleId, new QaApp("/tmp/x", 2).bundleId);
  });
});

test("systemDrag sends fast input through the system mode", async () => {
  let sent: unknown;
  const app = { cmd: async (message: unknown) => { sent = message; return {}; }, base: "http://127.0.0.1:1" };
  const t = new NT(app as unknown as QaApp, "example.canvas");
  await t.systemDrag({ x: 12, y: 20 }, { x: 240, y: 20 }, { steps: 3 });
  assert.deepEqual(sent, { op: "qa.drag", args: { system: true, from: [12, 20], to: [240, 20], mods: [], steps: 3, holdMs: 0, dwellMs: 0 }, timeoutMs: 30000 });
});
