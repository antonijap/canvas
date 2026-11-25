import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-host-keys-"));
const security = path.join(tmp, "security");
const store = path.join(tmp, "keys.json");
const blocked = path.join(tmp, "blocked");
const tunnels = path.join(tmp, "tunnels");
fs.mkdirSync(tunnels);
delete process.env.CANVAS_CLOUD_SECRETS_FILE;
Object.assign(process.env, {
  CANVAS_SECURITY_BIN: security,
  CANVAS_TUNNEL_BIN: path.join(import.meta.dirname, "fixtures", "fake-tunnel.sh"),
  CANVAS_FAKE_TUNNEL_DIR: tunnels,
  CANVAS_FAKE_TUNNEL_NODE: process.execPath,
  CANVAS_FAKE_TUNNEL_ANY_PORT: "1",
  CANVAS_CLOUD_HOST_PORT: "0",
});
fs.writeFileSync(security, `#!${process.execPath}
const fs = require("node:fs");
const file = ${JSON.stringify(store)};
const keys = JSON.parse(fs.readFileSync(file, "utf8"));
const [op, ...args] = process.argv.slice(2);
const account = args[args.indexOf("-a") + 1];
if (op === "find-generic-password") {
  if (fs.existsSync(${JSON.stringify(blocked)})) {
    if (fs.readFileSync(${JSON.stringify(blocked)}, "utf8") === "signal") process.kill(process.pid, "SIGTERM");
    else process.exit(1);
    return;
  }
  if (!(account in keys)) process.exit(44);
  console.log(Buffer.from(keys[account]).toString("base64"));
} else if (op === "-i") {
  const words = fs.readFileSync(0, "utf8").trim().split(" ");
  keys[words[words.indexOf("-a") + 1]] = Buffer.from(words[words.indexOf("-w") + 1], "base64").toString();
  fs.writeFileSync(file, JSON.stringify(keys));
} else if (op === "delete-generic-password") {
  delete keys[account];
  fs.writeFileSync(file, JSON.stringify(keys));
}
`, { mode: 0o700 });

const { hostIdFor, stopHelpers } = await import("../src/cloud-tunnel.ts");
const readError = "Couldn't read this Cloud's keys from the Keychain. Unlock the Keychain and try again.";
const publicKey = `nodekey:${"ab".repeat(32)}`;
const id = hostIdFor(publicKey);
const keys = JSON.stringify({
  member: { key: {}, addr: `tc${"a".repeat(30)}`, public: publicKey },
  enrol: { key: {}, addr: `tc${"b".repeat(30)}`, public: publicKey },
});
const opts = { name: "Studio", label: "Anna" };
const originalIndex = JSON.stringify({ main: id });
let caseNumber = 0;

async function setup({ raw, indexed = true, locked = false }: { raw?: string; indexed?: boolean; locked?: boolean } = {}) {
  const state = fs.mkdtempSync(path.join(tmp, "state-"));
  process.env.CANVAS_STATE_DIR = state;
  const index = path.join(state, "cloud-hosts.json");
  if (indexed) fs.writeFileSync(index, originalIndex);
  fs.writeFileSync(store, JSON.stringify(raw === undefined ? {} : { "host:keys": raw }));
  if (locked) fs.writeFileSync(blocked, "");
  else fs.rmSync(blocked, { force: true });
  const hostModule = new URL("../src/cloud-host.ts", import.meta.url);
  hostModule.searchParams.set("test", String(++caseNumber));
  const host: typeof import("../src/cloud-host.ts") = await import(hostModule.href);
  return { host, index, state };
}

after(() => { stopHelpers(); fs.rmSync(tmp, { recursive: true, force: true }); });

for (const [label, raw, locked, error] of [
  ["a failed Keychain read", keys, true, { message: readError }],
  ["missing keys", undefined, false, /keys are missing/i],
  ["corrupt keys", "{", false, /keys are invalid/i],
  ["keys for a different Cloud", keys.replaceAll(publicKey, `nodekey:${"cd".repeat(32)}`), false, /keys do not match/i],
] as const) {
  test(`an indexed Cloud keeps its identity and stored values after ${label}`, async (t) => {
    const { host, index, state } = await setup({ raw, locked });
    t.after(() => host.stopHosting());
    const before = fs.readFileSync(store, "utf8");
    await assert.rejects(host.startHosting({ ...opts, hostId: id }), error);
    assert.equal(fs.readFileSync(store, "utf8"), before);
    assert.equal(fs.readFileSync(index, "utf8"), originalIndex);
    assert.equal(fs.existsSync(path.join(state, "cloud-host")), false, "a failed read does not create a database");
    assert.equal(host.hosting(), false);
    const one = await host.hostStatus(id);
    assert.equal(one.hostId, id);
    assert.equal(one.tunnel, "error");
    if (locked) assert.equal(one.tunnelError, readError);
    assert.deepEqual((await host.hostStatusAll()).clouds, [one]);
    await host.stopHosting(id);
    assert.equal((await host.hostStatus(id)).tunnelError, null);
  });
}

test("a failed read of an unindexed main slot blocks starting a new Cloud and resolving an unknown id", async (t) => {
  const { host, index } = await setup({ raw: keys, indexed: false, locked: true });
  t.after(() => host.stopHosting());
  const before = fs.readFileSync(store, "utf8");
  await assert.rejects(host.startHosting(opts), { message: readError });
  await assert.rejects(host.startHosting({ ...opts, hostId: id }), { message: readError });
  assert.equal(fs.readFileSync(store, "utf8"), before);
  assert.equal(fs.existsSync(index), false);
  assert.deepEqual((await host.hostStatusAll()).clouds, []);
  assert.equal((await host.hostStatus(id)).hosting, false);
});

test("an unindexed slot with a kept database stays listed when key reads fail", async (t) => {
  const { host, index, state } = await setup({ indexed: false, locked: true });
  t.after(() => host.stopHosting());
  const dir = path.join(state, "cloud-hosts", "11111111");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "team.sqlite"));
  db.exec("CREATE TABLE host (id INTEGER PRIMARY KEY, host_id TEXT)");
  db.prepare("INSERT INTO host VALUES (1, ?)").run(id);
  db.close();
  await assert.rejects(host.startHosting({ ...opts, hostId: id }), { message: readError });
  assert.equal((await host.hostStatusAll()).clouds[0]?.hostId, id);
  assert.equal((await host.hostStatus(id)).tunnelError, readError);
  assert.equal(fs.existsSync(index), false);
  fs.rmSync(blocked);
  await assert.rejects(host.startHosting({ ...opts, hostId: id }), /keys are missing/i);
  await host.wipeHosting(id);
  assert.deepEqual((await host.hostStatusAll()).clouds, []);
});

test("a genuinely unused slot generates keys and a matching host id", async (t) => {
  const { host, index } = await setup({ indexed: false });
  t.after(() => host.stopHosting());
  const hostId = await host.startHosting(opts);
  const stored = JSON.parse(JSON.parse(fs.readFileSync(store, "utf8"))["host:keys"]);
  assert.equal(hostId, hostIdFor(stored.enrol.public));
  assert.equal(JSON.parse(fs.readFileSync(index, "utf8")).main, hostId);
  await host.stopHosting(hostId);
  fs.writeFileSync(blocked, "");
  await assert.rejects(host.startHosting({ ...opts, hostId }), { message: readError });
  fs.rmSync(blocked);
  assert.equal(await host.startHosting({ ...opts, hostId }), hostId);
  assert.equal((await host.hostStatus(hostId)).tunnelError, null);
});

test("the file stand-in distinguishes missing values from failed reads and preserves a corrupt store", async () => {
  const { readSecretStrict, writeSecret } = await import("../src/cloud-secrets.ts");
  const file = path.join(tmp, "stand-in.json");
  process.env.CANVAS_CLOUD_SECRETS_FILE = file;
  try {
    assert.deepEqual(await readSecretStrict("host:keys"), { status: "missing" });
    fs.writeFileSync(file, '{"hosted:example":"kept"}');
    assert.deepEqual(await readSecretStrict("host:keys"), { status: "missing" });
    assert.deepEqual(await readSecretStrict("hosted:example"), { status: "found", value: "kept" });
    assert.equal(await writeSecret("host:keys", "new"), true);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["hosted:example"], "kept");
    for (const bad of ['{"hosted:example":"kept",', "null", "[]"]) {
      fs.writeFileSync(file, bad);
      assert.deepEqual(await readSecretStrict("host:keys"), { status: "failed" });
      assert.equal(await writeSecret("host:keys", "new"), false);
      assert.equal(fs.readFileSync(file, "utf8"), bad);
    }
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.deepEqual(await readSecretStrict("host:keys"), { status: "failed" });
    assert.equal(await writeSecret("host:keys", "new"), false);
  } finally { delete process.env.CANVAS_CLOUD_SECRETS_FILE; }
});

test("a signaled or missing security binary is a read failure", async () => {
  const { readSecretStrict } = await import("../src/cloud-secrets.ts");
  fs.writeFileSync(blocked, "signal");
  try {
    assert.deepEqual(await readSecretStrict("host:keys"), { status: "failed" });
    process.env.CANVAS_SECURITY_BIN = path.join(tmp, "missing-security");
    assert.deepEqual(await readSecretStrict("host:keys"), { status: "failed" });
  } finally {
    process.env.CANVAS_SECURITY_BIN = security;
    fs.rmSync(blocked);
  }
});
