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
const falseMissing = path.join(tmp, "false-missing");
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
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const [op, ...args] = process.argv.slice(2);
const account = args[args.indexOf("-a") + 1];
if (op === "find-generic-password") {
  if (fs.existsSync(${JSON.stringify(blocked)})) {
    if (fs.readFileSync(${JSON.stringify(blocked)}, "utf8") === "signal") process.kill(process.pid, "SIGTERM");
    else process.exit(1);
    return;
  }
  const keys = read();
  if (!(account in keys) || fs.existsSync(${JSON.stringify(falseMissing)})) process.exit(44);
  console.log(Buffer.from(keys[account]).toString("base64"));
} else if (op === "-i") {
  const words = fs.readFileSync(0, "utf8").trim().split(" ");
  const target = words[words.indexOf("-a") + 1];
  const lock = file + ".lock";
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) { if (e.code !== "EEXIST") throw e; Atomics.wait(wait, 0, 0, 5); }
  }
  try {
    const keys = read();
    if (target in keys && !words.includes("-U")) process.exitCode = 1;
    else {
      keys[target] = Buffer.from(words[words.indexOf("-w") + 1], "base64").toString();
      fs.writeFileSync(file + ".tmp", JSON.stringify(keys));
      fs.renameSync(file + ".tmp", file);
    }
  } finally { fs.rmdirSync(lock); }
} else if (op === "delete-generic-password") {
  const keys = read();
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

async function loadHost(): Promise<typeof import("../src/cloud-host.ts")> {
  const hostModule = new URL("../src/cloud-host.ts", import.meta.url);
  hostModule.searchParams.set("test", String(++caseNumber));
  return import(hostModule.href);
}

async function setup({ raw, indexed = true, locked = false }: { raw?: string; indexed?: boolean; locked?: boolean } = {}) {
  const state = fs.mkdtempSync(path.join(tmp, "state-"));
  process.env.CANVAS_STATE_DIR = state;
  const index = path.join(state, "cloud-hosts.json");
  if (indexed) fs.writeFileSync(index, originalIndex);
  fs.writeFileSync(store, JSON.stringify(raw === undefined ? {} : { "host:keys": raw }));
  if (locked) fs.writeFileSync(blocked, "");
  else fs.rmSync(blocked, { force: true });
  return { host: await loadHost(), index, state };
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

test("a false missing result cannot replace existing tunnel keys", async (t) => {
  const { host, index } = await setup({ raw: keys, indexed: false });
  t.after(async () => { fs.rmSync(falseMissing); await host.stopHosting(); });
  fs.writeFileSync(falseMissing, "");
  const before = fs.readFileSync(store, "utf8");
  await assert.rejects(host.startHosting(opts), /could not create.*keys.*keychain/i);
  assert.equal(fs.readFileSync(store, "utf8"), before);
  assert.equal(fs.existsSync(index), false);
});

test("only one server can create tunnel keys for the same slot", async (t) => {
  const { host, index } = await setup({ indexed: false });
  const other = await loadHost();
  t.after(async () => { fs.rmSync(falseMissing); await Promise.all([host.stopHosting(), other.stopHosting()]); });
  // Both servers see a missing key, even if one reaches the add before the other.
  fs.writeFileSync(falseMissing, "");
  const results = await Promise.allSettled([host.startHosting(opts), other.startHosting(opts)]);
  const started = results.filter((r) => r.status === "fulfilled");
  const refused = results.filter((r) => r.status === "rejected");
  assert.equal(started.length, 1, "exactly one server starts");
  assert.match(refused[0].reason.message, /could not create.*keys.*keychain/i);
  const stored = JSON.parse(JSON.parse(fs.readFileSync(store, "utf8"))["host:keys"]);
  assert.equal(started[0].value, hostIdFor(stored.enrol.public));
  assert.equal(JSON.parse(fs.readFileSync(index, "utf8")).main, started[0].value);
});

test("without a helper an indexed slot rebuilds its missing database with the same id", async (t) => {
  const { host, index, state } = await setup();
  const bin = process.env.CANVAS_TUNNEL_BIN;
  delete process.env.CANVAS_TUNNEL_BIN;
  t.after(async () => { process.env.CANVAS_TUNNEL_BIN = bin; await host.stopHosting(); });
  assert.equal(fs.existsSync(path.join(state, "cloud-host", "team.sqlite")), false);
  assert.equal(await host.startHosting({ ...opts, hostId: id }), id);
  assert.equal(fs.readFileSync(index, "utf8"), originalIndex);
});

test("without a helper a kept database and a conflicting index are preserved", async (t) => {
  const { host, index, state } = await setup();
  const bin = process.env.CANVAS_TUNNEL_BIN;
  delete process.env.CANVAS_TUNNEL_BIN;
  t.after(async () => { process.env.CANVAS_TUNNEL_BIN = bin; await host.stopHosting(); });
  const dir = path.join(state, "cloud-host");
  fs.mkdirSync(dir);
  const db = new DatabaseSync(path.join(dir, "team.sqlite"));
  const otherId = "00000000-0000-4000-8000-000000000000";
  try {
    db.exec("CREATE TABLE host (id INTEGER PRIMARY KEY, host_id TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.prepare("INSERT INTO host VALUES (1, ?, '2020-01-01')").run(otherId);
    await assert.rejects(host.startHosting({ ...opts, hostId: id }), /saved identities do not match/i);
    assert.equal(fs.readFileSync(index, "utf8"), originalIndex);
    assert.equal(db.prepare("SELECT host_id FROM host WHERE id = 1").get()?.host_id, otherId);
  } finally { db.close(); }
});

test("a new start that fails in the worker clears the earlier Keychain error", async (t) => {
  const { host } = await setup({ raw: keys, locked: true });
  const port = process.env.CANVAS_CLOUD_HOST_PORT;
  t.after(async () => { process.env.CANVAS_CLOUD_HOST_PORT = port; await host.stopHosting(); });
  await assert.rejects(host.startHosting({ ...opts, hostId: id }), { message: readError });
  assert.equal((await host.hostStatus(id)).tunnelError, readError);
  fs.rmSync(blocked);
  process.env.CANVAS_CLOUD_HOST_PORT = "65536";
  await assert.rejects(host.startHosting({ ...opts, hostId: id }), { message: "The Cloud could not do that" });
  assert.equal((await host.hostStatus(id)).tunnelError, null);
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

test("the file stand-in only creates a new account and keeps existing values", async () => {
  const { createSecret, writeSecret } = await import("../src/cloud-secrets.ts");
  const file = path.join(tmp, "create-only.json");
  process.env.CANVAS_CLOUD_SECRETS_FILE = file;
  try {
    assert.equal(await createSecret("host:keys", "first"), true);
    const before = fs.readFileSync(file, "utf8");
    assert.equal(await createSecret("host:keys", "second"), false);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(await writeSecret("host:keys", "replacement"), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { "host:keys": "replacement" });
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
