import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "src/server.ts");
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw e;
  }
};

async function launch(t: TestContext, withParent = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-server-quit-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CANVAS_PORT: "0", CANVAS_ROOTS: dir, CANVAS_STATE_DIR: dir,
    CANVAS_LOG_DIR: dir, CANVAS_CLOUD_HOST_PORT: "0", CANVAS_CLOUD_SECRETS_FILE: path.join(dir, "secrets.json"),
    CANVAS_TUNNEL_BIN: path.join(root, "test/fixtures/fake-tunnel.sh"),
    CANVAS_FAKE_TUNNEL_DIR: dir, CANVAS_FAKE_TUNNEL_ANY_PORT: "1", CANVAS_FAKE_TUNNEL_NODE: process.execPath };
  delete env.CANVAS_PARENT_PID;
  // Keep the edit queued well past the parent check. Only a save on quit can put it on disk before this test ends.
  const preload = path.join(dir, "slow-writes.mjs");
  fs.writeFileSync(preload, `import { writeConfig } from ${JSON.stringify(new URL("../src/docwriter.ts", import.meta.url).href)};
    Object.assign(writeConfig, { syncBytes: 0, debounceMs: 30000, maxDelayMs: 30000 });`);
  const args = ["--import", preload, script];
  const parentCode = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, process.argv.slice(1), {
      env: { ...process.env, CANVAS_PARENT_PID: String(process.pid) },
      stdio: ["ignore", "inherit", "inherit"],
    });
    console.log("pid: " + child.pid);
    child.on("exit", code => process.exit(code ?? 1));
    process.stdin.once("data", () => process.exit(0));
  `;
  const proc = spawn(process.execPath, withParent ? ["-e", parentCode, "--", ...args] : args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(proc, "exit");
  let stderr = "", pid = withParent ? 0 : proc.pid!;
  proc.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const output = createInterface({ input: proc.stdout });
  output.on("line", line => { if (line.startsWith("pid: ")) pid = Number(line.slice(5)); });
  t.after(async () => {
    proc.kill("SIGKILL");
    if (pid && pid !== proc.pid && alive(pid)) process.kill(pid, "SIGKILL");
    await exited;
    output.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${stderr}`)), 5000);
    output.on("line", line => {
      if (line.startsWith("canvas: ")) { clearTimeout(timer); resolve(line.slice(8)); }
    });
    void exited.then(() => { clearTimeout(timer); reject(new Error(`Server exited before listening: ${stderr}`)); }, reject);
  });
  const get = (route: string) => fetch(new URL(route, base), { signal: AbortSignal.timeout(5000) });
  const post = (route: string, body?: unknown) => fetch(new URL(route, base), {
    method: "POST", headers: { "content-type": "application/json", "x-canvas": "1" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  return { dir, proc, pid, exited, get, post };
}

test("a server started by the app saves queued edits and exits when its parent dies", { timeout: 15_000 }, async t => {
  const { dir, proc, pid, exited, post } = await launch(t, true);
  const file = fs.realpathSync(dir) + "/queued.canvas.json";
  const readX = () => JSON.parse(fs.readFileSync(file, "utf8")).children[0].x;
  fs.writeFileSync(file, JSON.stringify({ version: "2.21", children: [
    { type: "rectangle", id: "rect", x: 0, y: 0, width: 40, height: 40, fill: "#FF0000" },
  ] }));
  const edit = await post("/api/update", { file, id: "rect", props: { x: 42 } });
  assert.equal(edit.status, 200, await edit.text());
  assert.equal(readX(), 0, "the edit is still queued");
  proc.stdin.end("exit");
  assert.deepEqual(await exited, [0, null]);
  for (let i = 0; i < 100 && alive(pid); i++) await delay(50);
  assert.equal(alive(pid), false, "the server exited after losing its parent");
  assert.equal(readX(), 42, "the queued edit was saved before exiting");
});

test("POST /quit waits for hosted Clouds and their tunnel helpers to exit", { timeout: 15_000 }, async t => {
  const { dir, get, post, exited } = await launch(t);
  assert.equal((await get("/health")).status, 200);
  const ports: number[] = [];
  for (const name of ["Studio", "Review"]) {
    const start = await post("/api/cloud/host/start", { name });
    const host = await start.json() as { port: number; tunnel: string };
    assert.equal(start.status, 200, JSON.stringify(host));
    assert.equal(host.tunnel, "up");
    ports.push(host.port);
  }
  const helpers = fs.readdirSync(dir)
    .filter(file => /^tc[a-f0-9]{64}\.json$/.test(file))
    .map(file => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).pid as number);
  assert.equal(helpers.length, 2);
  assert.ok(helpers.every(alive));
  assert.equal((await post("/quit")).status, 200);
  assert.deepEqual(await exited, [0, null]);
  assert.ok(helpers.every(pid => !alive(pid)), "the tunnel helpers exited");
  for (const port of ports) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/info`, { signal: AbortSignal.timeout(1000) }),
      (e: Error) => (e.cause as NodeJS.ErrnoException)?.code === "ECONNREFUSED");
  }
});
