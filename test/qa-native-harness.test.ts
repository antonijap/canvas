// The qa:native harness's own guards (qa/native/harness.ts, app.ts): text recognition one read at a time across
// runs, a dead run's lock cleared, and bundle ids unique per run so parallel runs never clear each other's storage.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { NT, withVisionLock } from "../qa/native/harness.ts";
import { QaApp, BUNDLE_BASE } from "../qa/native/app.ts";
import { systemDragHelper } from "../qa/native/system-drag.ts";

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

test("systemDrag posts from a runner child using the window screen frame", async (ctx) => {
  const calls: { file: string; args: string[] }[] = [];
  const exists = fs.existsSync;
  ctx.mock.method(fs, "existsSync", (file: fs.PathLike) => String(file).includes("/qa/out/system-drag-") || exists(file));
  ctx.mock.method(childProcess, "execFile", (file: string, args: string[], options: unknown, cb: Function) => {
    calls.push({ file, args });
    cb(null, "", "");
    return {};
  });
  const ops: string[] = [];
  const app = { pid: 123, base: "http://127.0.0.1:1", cmd: async ({ op }: { op: string }) => {
    ops.push(op);
    return { window: { x: -800, y: 240, width: 1000, height: 700, scale: 2 } };
  } };
  const t = new NT(app as unknown as QaApp, "example.canvas");
  await t.systemDrag({ x: 12, y: 20 }, { x: 240, y: 50 }, { steps: 3, mods: ["shift"], holdMs: 25, dwellMs: 40 });
  assert.deepEqual(ops, ["qa.state"], "no in-app drag or input fallback");
  const drag = calls.find((c) => c.file.includes("system-drag-") && c.file !== "xcrun");
  assert.ok(drag, "system drag must execute a runner child");
  assert.deepEqual(JSON.parse(drag.args[0]), {
    pid: 123, from: { x: -788, y: 920 }, to: { x: -560, y: 890 },
    mods: ["shift"], steps: 3, holdMs: 25, dwellMs: 40,
  });
});

test("systemDrag fails the scenario on helper permission refusal without fallback", async (ctx) => {
  const exists = fs.existsSync;
  ctx.mock.method(fs, "existsSync", (file: fs.PathLike) => String(file).includes("/qa/out/system-drag-") || exists(file));
  ctx.mock.method(childProcess, "execFile", (_file: string, _args: string[], _options: unknown, cb: Function) => {
    cb(Object.assign(new Error("exit 77"), { code: 77 }), "", "System drag requires Accessibility for Terminal.app. Enable it in System Settings > Privacy & Security > Accessibility.");
    return {};
  });
  const ops: string[] = [];
  const app = { pid: 123, base: "http://127.0.0.1:1", cmd: async ({ op }: { op: string }) => {
    ops.push(op);
    return { window: { x: 0, y: 0, height: 700 } };
  } };
  const t = new NT(app as unknown as QaApp, "example.canvas");
  await assert.rejects(t.systemDrag({ x: 12, y: 20 }, { x: 240, y: 20 }), /Accessibility for Terminal.app/);
  assert.deepEqual(ops, ["qa.state"]);
});

test("system drag helper compiles once per source hash and never caches a failed build", (ctx) => {
  const dir = tmpDir("system-drag-cache"), source = path.join(dir, "input.swift"), out = path.join(dir, "out");
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(source, "first source");
  let builds = 0;
  ctx.mock.method(childProcess, "execFileSync", (_file: string, args: string[]) => {
    builds++;
    fs.writeFileSync(args[args.length - 1], "compiled helper");
    return "";
  });
  const first = systemDragHelper(source, out);
  assert.equal(systemDragHelper(source, out), first);
  assert.equal(builds, 1);
  fs.writeFileSync(source, "second source");
  assert.notEqual(systemDragHelper(source, out), first);
  assert.equal(builds, 2);
  fs.writeFileSync(source, "broken source");
  ctx.mock.method(childProcess, "execFileSync", (_file: string, args: string[]) => {
    fs.writeFileSync(args[args.length - 1], "partial build");
    throw new Error("compile failed");
  });
  assert.throws(() => systemDragHelper(source, out), /compile failed/);
  assert.equal(fs.readdirSync(out).length, 2, "no partial binary or cached failure");
});

test("mark waits for the target window to finish resizing before a click", async () => {
  let reads = 0;
  const app = { base: "http://127.0.0.1:1", cmd: async () => ({ marks: [{ id: "cloud-row", label: "Review", x: 20, y: 80, w: 200, h: 40,
    windowFrame: { x: 0, y: 0, w: 500, h: Math.max(400, 700 - ++reads * 50) } }] }) };
  const t = new NT(app as unknown as QaApp, "example.canvas");
  const mark = await t.mark({ id: "cloud-row", window: "settings" });
  assert.equal((mark as any).windowFrame.h, 400, "window-relative row coordinates can stay still while the window resizes");
});

test("mark never returns a stale click target that disappeared while settling", async () => {
  let reads = 0;
  const app = { base: "http://127.0.0.1:1", cmd: async () => ({ marks: ++reads === 1 ? [{ id: "cloud-row", label: "Review", x: 20, y: 80, w: 200, h: 40 }] : [] }) };
  const t = new NT(app as unknown as QaApp, "example.canvas");
  await assert.rejects(t.mark({ id: "cloud-row" }), /disappeared/);
});
