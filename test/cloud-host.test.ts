// A Cloud hosted on a Mac (cloud/node): enrolment with single-use join codes, device tokens, removal, person ids,
// the screening every request gets, storage, the room socket and its framing, and the separate process.

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CloudHost, INVITE_MS, newSecret, parseSecret } from "../cloud/node/host.ts";
import { acceptKey } from "../cloud/node/websocket.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const dirs: string[] = [];
const hosts: CloudHost[] = [];
after(async () => {
  for (const h of hosts) await h.stop().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-cloud-host-")); dirs.push(d); return d; };
async function host(opts: { pingMs?: number; now?: () => number } = {}) {
  const dir = tmp();
  const h = new CloudHost({ dir, port: 0, ...opts });
  hosts.push(h);
  const port = await h.start();
  return { h, dir, base: `http://127.0.0.1:${port}`, port };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await sleep(20); } };
const post = (base: string, p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
/** Joins with an invite as a new device; returns the device token. */
async function join(base: string, code: string, device = "Ben's MacBook") {
  const token = newSecret("ccd");
  const r = await post(base, "/v1/join", { token, device }, bearer(code));
  return { status: r.status, body: await r.json() as any, token };
}

test("secrets: the shape, never the same twice, parsed by kind", () => {
  const a = newSecret("ccd"), b = newSecret("ccd"), j = newSecret("ccj");
  assert.notEqual(a, b);
  assert.ok(parseSecret("ccd", a) && parseSecret("ccj", j));
  assert.equal(parseSecret("ccd", j), null);
  assert.equal(parseSecret("ccd", "ccd_short"), null);
});

test("a join code works once, within 48 hours, and becomes a device token", async () => {
  let now = Date.now();
  const { h, base } = await host({ now: () => now });
  h.ownerDevice("Anna");
  const { code } = h.invite("ben@studio.test");
  const first = await join(base, code);
  assert.equal(first.status, 200);
  assert.equal(first.body.hostId, h.hostId());
  assert.equal(first.body.me.email, "ben@studio.test");
  assert.equal(first.body.me.role, "editor");
  const me = await (await fetch(`${base}/v1/me`, { headers: bearer(first.token) })).json() as any;
  assert.equal(me.id, first.body.me.id);
  // Used: dead.
  assert.equal((await join(base, code)).status, 401);
  // Expired: dead, and gone.
  const late = h.invite("cy@studio.test");
  now += INVITE_MS + 1;
  assert.equal((await join(base, late.code)).status, 401);
  now -= INVITE_MS + 1;
  assert.equal((await join(base, late.code)).status, 401, "an expired code is deleted when tried");
  // A wrong code of the right shape.
  assert.equal((await join(base, newSecret("ccj"))).status, 401);
  const people = h.people();
  assert.deepEqual(people.find((p) => p.label === "ben@studio.test")!.devices.map((d) => d.name), ["Ben's MacBook"]);
});

test("every route needs a device token, /v1/info and the socket included; a join code is not one", async () => {
  const { h, base } = await host();
  const owner = h.ownerDevice("Anna");
  const { code } = h.invite("ben@studio.test");
  for (const p of ["/v1/info", "/v1/me", `/v1/docs/${crypto.randomUUID()}/threads`]) {
    assert.equal((await fetch(base + p)).status, 401, p);
    assert.equal((await fetch(base + p, { headers: bearer(newSecret("ccd")) })).status, 401, p);
    assert.equal((await fetch(base + p, { headers: bearer(code) })).status, 401, `${p} with a join code`);
  }
  assert.equal((await fetch(`${base}/v1/info`, { headers: bearer(owner) })).status, 200);
  const info = await (await fetch(`${base}/v1/info`, { headers: bearer(owner) })).json() as any;
  assert.equal(info.hostId, h.hostId());
  // The token is taken from Authorization only.
  assert.equal((await fetch(`${base}/v1/info?token=${encodeURIComponent(owner)}`)).status, 401);
});

test("screening: internal identity headers are 401; browsers, foreign Hosts and dev emails never get in", async () => {
  const { h, base, port } = await host();
  const owner = h.ownerDevice("Anna");
  const status = async (headers: Record<string, string>) => (await fetch(`${base}/v1/me`, { headers: { ...bearer(owner), ...headers } })).status;
  assert.equal(await status({ "x-canvas-internal-email": "anna@studio.test" }), 401);
  assert.equal(await status({ "x-canvas-internal-role": "owner" }), 401);
  assert.equal(await status({ "x-canvas-dev-email": "anna@studio.test" }), 401);
  assert.equal(await status({ "cf-access-token": "x" }), 401);
  assert.equal(await status({ origin: "http://127.0.0.1" }), 403);
  assert.equal(await status({ "sec-fetch-site": "cross-site" }), 403);
  // A rebound name: the Host is not loopback.
  const raw = await new Promise<string>((resolve) => {
    const c = net.connect(port, "127.0.0.1", () => c.write(`GET /v1/me HTTP/1.1\r\nHost: studio.example.com\r\nAuthorization: Bearer ${owner}\r\nConnection: close\r\n\r\n`));
    let s = ""; c.on("data", (d) => (s += d)); c.on("end", () => resolve(s)); c.on("error", () => resolve(s));
  });
  assert.match(raw, /^HTTP\/1\.1 403/);
  // No dev path: an email header alone is nothing.
  assert.equal((await fetch(`${base}/v1/me`, { headers: { "x-canvas-dev-email": "anna@studio.test" } })).status, 401);
});

test("the Cloud port serves the Cloud API only: editor, bridge and MCP routes are 404 even with a token", async () => {
  const { h, base } = await host();
  const owner = h.ownerDevice("Anna");
  for (const p of ["/", "/api/state", "/api/comments?file=x", "/api/cloud/status", "/api/cloud/host", "/api/bridge", "/mcp", "/index.html", "/v1/people", "/v1/export"]) {
    const r = await fetch(base + p, { headers: bearer(owner) });
    assert.equal(r.status, 404, p);
    assert.equal((await r.json() as any).code, "not_found", p);
  }
  for (const p of ["/api/state", "/mcp"]) assert.equal((await fetch(base + p)).status, 401, `${p} without a token says nothing`);
});

test("the Cloud listens on 127.0.0.1 only", async () => {
  const { port } = await host();
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!lan) return;
  const reached = await new Promise<boolean>((resolve) => {
    const c = net.connect(port, lan);
    c.on("connect", () => { c.destroy(); resolve(true); });
    c.on("error", () => resolve(false));
  });
  assert.equal(reached, false, "not on the Mac's network address");
});

test("removal: devices, pending codes and sockets go at once; a new person with the same label is someone else", async () => {
  const { h, base } = await host();
  const owner = h.ownerDevice("Anna");
  const { code } = h.invite("ben@studio.test", "commenter");
  const ben = await join(base, code);
  const doc = crypto.randomUUID();
  assert.equal((await post(base, "/v1/docs", { doc }, bearer(owner))).status, 200);
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/v1/docs/${doc}/socket`, { headers: bearer(ben.token) } as unknown as string[]);
  const got: any[] = [];
  let closed = false;
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  ws.onclose = () => { closed = true; };
  await new Promise<void>((r) => { ws.onopen = () => r(); });
  ws.send(JSON.stringify({ type: "hello", protocol: 1, doc, since: 0 }));
  await until(() => got.some((m) => m.type === "welcome"));
  // Ben writes a comment.
  const thread = crypto.randomUUID(), comment = crypto.randomUUID();
  ws.send(JSON.stringify({ type: "ops", ops: [{ opId: crypto.randomUUID(), doc, at: new Date().toISOString(), op: { kind: "thread.create", thread, comment, anchor: { x: 0, y: 0 }, body: "From Ben" } }] }));
  await until(() => got.some((m) => m.type === "ack"));
  const benId = ben.body.me.id;
  const pending = h.invite("ben@studio.test", "commenter"); // a second device on its way
  assert.ok(h.remove(benId));
  await until(() => closed);
  assert.equal((await fetch(`${base}/v1/me`, { headers: bearer(ben.token) })).status, 401);
  assert.equal((await join(base, pending.code)).status, 401, "the pending code was cancelled");
  // A new person who happens to get the same label cannot edit Ben's comment: ids decide, not labels.
  const again = await join(base, h.invite("ben@studio.test", "commenter").code);
  assert.notEqual(again.body.me.id, benId);
  const r = await (await post(base, `/v1/docs/${doc}/ops`, { ops: [{ opId: crypto.randomUUID(), doc, at: new Date().toISOString(), op: { kind: "comment.edit", comment, body: "Taken over" } }] }, bearer(again.token))).json() as any;
  assert.equal(r.rejected[0]?.code, "forbidden");
  const read = await (await fetch(`${base}/v1/docs/${doc}/threads`, { headers: bearer(owner) })).json() as any;
  assert.equal(read.threads[0].comments[0].body, "From Ben");
  assert.equal(read.threads[0].comments[0].author.id, benId);
  assert.throws(() => h.remove(h.people()[0].id), /cannot remove itself/);
});

test("room socket: the other person gets ops live; history replays with person ids; a retry is acked once", async () => {
  const { h, base, port } = await host();
  const anna = h.ownerDevice("Anna");
  const ben = (await join(base, h.invite("ben@studio.test").code)).token;
  const doc = crypto.randomUUID();
  await post(base, "/v1/docs", { doc }, bearer(anna));
  const open = (token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/docs/${doc}/socket`, { headers: bearer(token) } as unknown as string[]);
    const got: any[] = [];
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
    return { ws, got, ready: new Promise<void>((r) => { ws.onopen = () => r(); }) };
  };
  const a = open(anna), b = open(ben);
  await Promise.all([a.ready, b.ready]);
  for (const s of [a, b]) s.ws.send(JSON.stringify({ type: "hello", protocol: 1, doc, since: 0 }));
  await until(() => a.got.some((m) => m.type === "welcome") && b.got.some((m) => m.type === "welcome"));
  const opId = crypto.randomUUID();
  const env = { opId, doc, at: new Date().toISOString(), op: { kind: "thread.create", thread: crypto.randomUUID(), comment: crypto.randomUUID(), anchor: { x: 1, y: 2 }, body: "Hi Ben" } };
  a.ws.send(JSON.stringify({ type: "ops", ops: [env] }));
  await until(() => b.got.some((m) => m.type === "applied"));
  a.ws.send(JSON.stringify({ type: "ops", ops: [env] }));
  await until(() => a.got.filter((m) => m.type === "ack").length === 2);
  assert.equal(b.got.filter((m) => m.type === "applied").length, 1);
  const history = await (await fetch(`${base}/v1/docs/${doc}/threads?since=0`, { headers: bearer(ben) })).json() as any;
  assert.equal(history.threads[0].createdBy.label ?? history.threads[0].createdBy.name, "Anna");
  const replay = await (await fetch(`${base}/v1/docs/${doc}/threads?since=1`, { headers: bearer(ben) })).json() as any;
  assert.deepEqual(replay.entries, []);
  a.ws.close(); b.ws.close();
});

test("a socket upgrade is refused before 101 without a token, for an unknown document, or from a browser", async () => {
  const { h, port } = await host();
  const t = h.ownerDevice("Anna");
  const doc = crypto.randomUUID();
  h.team.register(doc, "x");
  const status = (headers: string[], d = doc) => new Promise<string>((resolve) => {
    const c = net.connect(port, "127.0.0.1", () => c.write([`GET /v1/docs/${d}/socket HTTP/1.1`, "Host: 127.0.0.1", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${Buffer.alloc(16, 1).toString("base64")}`, ...headers, "", ""].join("\r\n")));
    let s = ""; c.on("data", (x) => { s += x; c.destroy(); resolve(s.split("\r\n")[0]); }); c.on("error", () => resolve(s));
  });
  assert.match(await status([]), / 401 /);
  assert.match(await status([`Authorization: Bearer ${t}`], crypto.randomUUID()), / 404 /);
  assert.match(await status([`Authorization: Bearer ${t}`, "Origin: http://127.0.0.1"]), / 403 /);
  assert.match(await status([`Authorization: Bearer ${t}`, "X-Canvas-Internal-Email: anna@studio.test"]), / 401 /);
  assert.match(await status([`Authorization: Bearer ${t}`]), / 101 /);
});

test("storage: folder 0700, databases 0600, no token or code in clear; Stop revokes all; Delete removes the folder", async () => {
  const { h, base, dir } = await host();
  const owner = h.ownerDevice("Anna");
  const { code } = h.invite("ben@studio.test");
  const ben = await join(base, code);
  const doc = crypto.randomUUID();
  await post(base, "/v1/docs", { doc }, bearer(owner));
  await fetch(`${base}/v1/docs/${doc}/threads`, { headers: bearer(owner) });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "rooms")).mode & 0o777, 0o700);
  const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), ...fs.readdirSync(path.join(dir, "rooms")).map((f) => path.join(dir, "rooms", f))].filter((f) => fs.statSync(f).isFile());
  assert.ok(files.some((f) => f.endsWith("-wal")), "WAL files exist and are checked");
  for (const f of files) assert.equal(fs.statSync(f).mode & 0o777, 0o600, path.basename(f));
  const bytes = files.map((f) => fs.readFileSync(f).toString("latin1")).join("");
  for (const s of [owner, code, ben.token]) assert.ok(!bytes.includes(s) && !bytes.includes(s.split(".")[1]), "no secret in clear");
  h.revokeAll();
  assert.equal((await fetch(`${base}/v1/me`, { headers: bearer(owner) })).status, 401);
  assert.equal((await fetch(`${base}/v1/me`, { headers: bearer(ben.token) })).status, 401);
  await h.wipe();
  assert.ok(!fs.existsSync(dir));
});

test("failed sign-ins are slowed: 30 a minute, then 429 for everyone (tunnel peers all arrive as 127.0.0.1)", async () => {
  const { h, base } = await host();
  const t = h.ownerDevice("Anna");
  for (let i = 0; i < 30; i++) await fetch(`${base}/v1/info`, { headers: bearer(newSecret("ccd")) });
  assert.equal((await fetch(`${base}/v1/info`, { headers: bearer(t) })).status, 429);
});

// ---------- framing ----------

async function rawSocket(port: number, token: string, doc: string) {
  const c = net.connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  let ended = false;
  c.on("data", (d) => chunks.push(d));
  c.on("close", () => { ended = true; });
  c.on("error", () => {});
  await new Promise<void>((r) => c.on("connect", () => r()));
  c.write([`GET /v1/docs/${doc}/socket HTTP/1.1`, "Host: 127.0.0.1", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${Buffer.alloc(16, 2).toString("base64")}`, `Authorization: Bearer ${token}`, "", ""].join("\r\n"));
  await until(() => Buffer.concat(chunks).includes("\r\n\r\n"));
  const body = () => { const all = Buffer.concat(chunks); return all.subarray(all.indexOf("\r\n\r\n") + 4); };
  return { c, body, ended: () => ended };
}
const masked = (opcode: number, payload: Buffer, fin = true, rsv = 0) => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  const len = payload.length < 126 ? Buffer.from([0x80 | payload.length]) : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | rsv | opcode]), len, mask, body]);
};
const closeCode = (b: Buffer) => { const i = b.indexOf(0x88); return i >= 0 ? b.readUInt16BE(i + 2) : -1; };

test("framing: fragments joined, ping answered with its payload, malformed frames closed with the right code", async () => {
  const { h, port } = await host();
  const t = h.ownerDevice("Anna");
  const doc = crypto.randomUUID();
  h.team.register(doc, "x");
  const hello = Buffer.from(JSON.stringify({ type: "hello", protocol: 1, doc, since: 0 }));
  let s = await rawSocket(port, t, doc);
  s.c.write(Buffer.concat([masked(0x1, hello.subarray(0, 10), false), masked(0x0, hello.subarray(10, 20), false), masked(0x9, Buffer.from("hi")), masked(0x0, hello.subarray(20), true)]));
  await until(() => s.body().toString("latin1").includes('"welcome"'));
  assert.ok(s.body().includes(Buffer.from([0x8a, 2, 0x68, 0x69])), "a ping between fragments is answered");
  s.c.destroy();
  const cases: [string, Buffer, number][] = [
    ["unmasked", Buffer.concat([Buffer.from([0x81, hello.length]), hello]), 1002],
    ["reserved bits", masked(0x1, hello, true, 0x40), 1002],
    ["binary", masked(0x2, Buffer.from([1, 2, 3])), 1003],
    ["continuation first", masked(0x0, hello), 1002],
    ["fragmented ping", masked(0x9, Buffer.from("x"), false), 1002],
    ["unknown opcode", masked(0x3, Buffer.from("x")), 1002],
    ["bad UTF-8", masked(0x1, Buffer.from([0xc3, 0x28])), 1007],
    ["oversized length", Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, 0x7f, 0, 0, 0, 1, 2, 3, 4]), 1009],
  ];
  for (const [name, bytes, code] of cases) {
    s = await rawSocket(port, t, doc);
    s.c.write(bytes);
    await until(() => closeCode(s.body()) !== -1 || s.ended(), 2000).catch(() => {});
    assert.equal(closeCode(s.body()), code, name);
    s.c.destroy();
  }
});

test("framing: too many fragments close the socket; a peer that stops answering pings, or trickles a frame, is dropped", async () => {
  const { h, port } = await host({ pingMs: 150 });
  const t = h.ownerDevice("Anna");
  const doc = crypto.randomUUID();
  h.team.register(doc, "x");
  let s = await rawSocket(port, t, doc);
  const parts = [masked(0x1, Buffer.from("["), false)];
  for (let i = 0; i < 1100; i++) parts.push(masked(0x0, Buffer.from(" "), false));
  s.c.write(Buffer.concat(parts));
  await until(() => closeCode(s.body()) !== -1, 2000);
  assert.equal(closeCode(s.body()), 1009);
  s.c.destroy();
  // Silent: no pong.
  s = await rawSocket(port, t, doc);
  await until(() => s.ended(), 2000);
  // Slow: half a frame, then nothing; the pong cannot arrive, so it is dropped.
  s = await rawSocket(port, t, doc);
  s.c.write(masked(0x1, Buffer.from("hello")).subarray(0, 4));
  await until(() => s.ended(), 2000);
});

test("acceptKey: the RFC 6455 example; anything but a version 13 upgrade is null", () => {
  const req = (h: Record<string, string>) => ({ method: "GET", headers: h }) as any;
  const ok = { upgrade: "websocket", connection: "keep-alive, Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
  assert.equal(acceptKey(req(ok)), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.equal(acceptKey(req({ ...ok, "sec-websocket-version": "8" })), null);
  assert.equal(acceptKey(req({ ...ok, upgrade: "h2c" })), null);
  assert.equal(acceptKey(req({ ...ok, "sec-websocket-key": "short" })), null);
});

// ---------- the separate process ----------

test("the host process imports cloud code only", () => {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of fs.readFileSync(file, "utf8").matchAll(/^import[^"]*"([^"]+)"/gm)) {
      if (!m[1].startsWith(".")) { assert.match(m[1], /^node:/, `${path.relative(ROOT, file)} imports ${m[1]}`); continue; }
      const next = path.resolve(path.dirname(file), m[1]);
      assert.ok(next.startsWith(path.join(ROOT, "cloud") + path.sep) && !next.includes(`${path.sep}cloudflare${path.sep}`), `${path.relative(ROOT, file)} imports ${m[1]}`);
      walk(next);
    }
  };
  walk(path.join(ROOT, "cloud", "node", "main.ts"));
  assert.ok(seen.size >= 5);
});

test("the host process: answers orders over IPC only, binds 127.0.0.1, exits when Canvas goes", async () => {
  const dir = tmp();
  const child = fork(path.join(ROOT, "cloud", "node", "main.ts"), [], { env: { ...process.env, CANVAS_CLOUD_HOST_DIR: dir, CANVAS_CLOUD_HOST_PORT: "0" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const replies = new Map<number, any>();
  child.on("message", (m: any) => { if (m.id) replies.set(m.id, m); });
  let n = 0;
  const ask = async (op: string, args: Record<string, unknown> = {}) => { const id = ++n; child.send({ id, op, ...args }); await until(() => replies.has(id), 5000); return replies.get(id); };
  const started = await ask("start", { label: "Anna" });
  assert.equal(started.ok, true);
  const { port, ownerToken, hostId } = started.result;
  assert.ok(parseSecret("ccd", ownerToken) && hostId);
  const me = await (await fetch(`http://127.0.0.1:${port}/v1/me`, { headers: bearer(ownerToken) })).json() as any;
  assert.equal(me.role, "owner");
  const inv = await ask("invite", { label: "ben@studio.test", role: "commenter" });
  assert.ok(parseSecret("ccj", inv.result.code));
  const people = await ask("people");
  assert.equal(people.result.people.length, 2);
  assert.equal((await ask("nonsense")).ok, false);
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  // Canvas goes away: the IPC channel closes and the host exits.
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  child.disconnect();
  assert.equal(await exited, 0);
  assert.ok(!out.includes(ownerToken) && !out.includes(inv.result.code), "no secret on stdout or stderr");
  const gone = await new Promise<boolean>((resolve) => { const c = net.connect(port, "127.0.0.1"); c.on("connect", () => { c.destroy(); resolve(false); }); c.on("error", () => resolve(true)); });
  assert.ok(gone, "the port is closed");
});
