import assert from "node:assert/strict";
import childProcess, { type ExecFileOptions } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { tmpDir } from "./helpers.ts";

test("unapproved file widgets do not fetch or execute, even on manual refresh", async (t) => {
  const dir = tmpDir("approval");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.CANVAS_TRUST_FILE = path.join(dir, "trust.json");
  const requests = t.mock.method(http, "request", () => { throw new Error("Unexpected HTTP request"); });
  let remote = "owner/first";
  const commands = t.mock.fn((name: string, args: string[], _options: ExecFileOptions, reply: (error: null, output: { stdout: string }) => void) => {
    const stdout = name === "/usr/bin/git" && args.includes("remote")
      ? "https://github.com/" + remote : "[]";
    reply(null, { stdout });
  });
  const execFile = childProcess.execFile;
  childProcess.execFile = commands as unknown as typeof execFile;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = execFile;
    syncBuiltinESMExports();
  });
  const { Poller } = await import("../src/widgets/poller.ts");
  const cases = [
    ["metric", { url: "\u00a0http://localhost:8080\u00a0" }],
    ["page-preview", { url: "http://localhost:8080" }],
    ["git-status", { repo: dir }],
    ["ci", { repo: "owner/repo" }],
    ["posthog", { host: "https://analytics.example", projectId: 1, insight: { shortId: "abc" }, secret: { service: "widget", account: "test" } }],
  ] as const;
  const widgets = cases.map(([kind, config]) => ({ id: kind, kind, config, name: kind, x: 0, y: 0, w: 400, h: 300, locked: false }));
  const file = path.join(dir, "shared.canvas");
  fs.writeFileSync(file, JSON.stringify(widgets));
  const poller = new Poller({ widgetsOf: () => JSON.parse(fs.readFileSync(file, "utf8")), emit() {} });
  t.after(() => poller.stop());

  poller.setInterest(file, "test", widgets.map((w) => w.id));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const states = widgets.map((w) => poller.readings(file)[w.id]?.state);
  const refreshes = await Promise.all(widgets.map((w) => poller.refresh(file, w.id)));
  assert.equal(requests.mock.callCount(), 0, "no network requests");
  assert.equal(commands.mock.callCount(), 0, "no child processes");
  assert.deepEqual(states, widgets.map(() => "needs-approval"));
  assert.deepEqual(refreshes.map((r) => r.reading?.state), states);

  await t.test("CI approves the current remote separately and only gh receives tokens", async () => {
    const { approveSource } = await import("../src/widgets/trust.ts");
    const config = widgets.find((w) => w.kind === "ci")!;
    process.env.GH_TOKEN = "fixture-gh-token";
    process.env.CANVAS_PRIVATE_FIXTURE = "fixture-private-value";
    const read = async () => {
      const next = new Poller({ widgetsOf: () => [{ ...config, config: { repo: dir } }], emit() {} });
      try { return (await next.refresh(file, "ci")).reading; }
      finally { next.stop(); }
    };
    assert.equal((await read())?.approvalTarget, dir);
    assert.equal(commands.mock.callCount(), 0);
    approveSource("ci", dir);
    assert.equal((await read())?.approvalTarget, remote);
    assert.equal(commands.mock.callCount(), 1);
    const [git, args, options] = commands.mock.calls[0].arguments;
    assert.equal(git, "/usr/bin/git");
    assert.deepEqual(args, ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "remote", "get-url", "origin"]);
    assert.equal(options.env?.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(options.env?.GH_TOKEN, undefined);
    assert.equal(options.env?.CANVAS_PRIVATE_FIXTURE, undefined);

    approveSource("ci", remote);
    remote = "owner/second";
    assert.equal((await read())?.approvalTarget, remote);
    assert.equal(commands.mock.callCount(), 2, "the changed remote must make no gh calls");
    approveSource("ci", remote);
    assert.equal((await read())?.state, "empty");
    assert.equal(commands.mock.callCount(), 5);
    for (const call of commands.mock.calls.slice(3)) {
      const [name, args, options] = call.arguments;
      assert.equal(path.basename(name), "gh");
      assert.ok(args.includes("github.com/owner/second"));
      assert.equal(options.env?.GH_TOKEN, "fixture-gh-token");
      assert.equal(options.env?.CANVAS_PRIVATE_FIXTURE, undefined);
    }
  });
});
