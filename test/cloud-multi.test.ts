// Many Clouds (src/cloud-config.ts, src/cloud.ts): the shell's list is the only way in, every network path and
// Keychain read is refused for an address that is not exactly one of them, a removed Cloud gets nothing more, and the
// races around removing, signing out and sharing. The servers here are fakes on 127.0.0.1 (DEV mode, a dev email).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, describe, test } from "node:test";
import type { CommentsFile } from "../cloud/protocol.ts";
import { fakeServer, tmpDir, type Fake } from "./helpers.ts";

const dir = tmpDir("cloud-multi");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_STATE_DIR = path.join(dir, ".state");
process.env.CANVAS_COMMENT_NAME = "Anna";
process.env.CANVAS_CLOUD_KEYCHAIN_SERVICE = "canvas.test.multi";
process.env.CANVAS_CLOUD_SECRETS_FILE = path.join(dir, "secrets.json");
process.env.CANVAS_TUNNEL_BIN = path.join(dir, "no-helper"); // no tunnel helper: a join stops before any network
delete process.env.CANVAS_CLOUD_URL;
delete process.env.CANVAS_CLOUD_DEV_EMAIL;

// A stand-in for /usr/bin/security: every read is logged (service and account), its answer is a fixed token, and
// SLOW makes it take a while (a Keychain prompt).
const log = path.join(dir, "keychain-reads.log");
const slow = path.join(dir, "keychain-slow");
const bin = path.join(dir, "security.sh");
fs.writeFileSync(bin, `#!/bin/sh
svc=""; acct=""
while [ $# -gt 0 ]; do case "$1" in -s) svc="$2"; shift;; -a) acct="$2"; shift;; esac; shift; done
echo "$svc $acct" >> "${log}"
[ -f "${slow}" ] && sleep 0.4
echo "tok_saved_in_keychain_0123456789"
exit 0
`, { mode: 0o755 });
process.env.CANVAS_SECURITY_BIN = bin;
const reads = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

const Cfg = await import("../src/cloud-config.ts");
const Cl = await import("../src/cloud.ts");
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => { Cl.stopAll(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let rev = 0;
/** The shell's list, as the app sends it, each time a newer revision. */
const list = (...clouds: { url: string; devEmail?: string }[]) => Cfg.setCloudConfig({ clouds, cloudsRev: ++rev });

/** A team server in DEV mode; `hold` delays the answers to a path until released. */
async function team(email = "anna@studio.test"): Promise<Fake & { hold: (p: string) => () => void }> {
  const holds = new Map<string, Promise<void>>();
  const f = await fakeServer(async (req, res) => {
    const p = (req.url ?? "").split("?")[0];
    const h = holds.get(p);
    if (h) await h;
    res.writeHead(200, { "content-type": "application/json" });
    if (p === "/v1/info") res.end(JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }));
    else if (p === "/v1/me") res.end(JSON.stringify({ email, name: "anna", role: "owner" }));
    else if (p === "/v1/docs") res.end(JSON.stringify({ ok: true }));
    else res.end("{}");
  });
  return Object.assign(f, {
    hold(p: string) { let release!: () => void; holds.set(p, new Promise<void>((r) => { release = r; })); return () => { holds.delete(p); release(); }; },
  });
}

const call = async (p: string, body: unknown = {}, method = "POST") => {
  const r = await fetch(base + p, method === "GET" ? {} : { method, headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: (await r.json()) as any };
};

function pkgWith(name: string, comments?: Partial<CommentsFile>): string {
  const p = path.join(dir, `${name}.canvas`);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "document.json"), JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "Scr01", name: "S", x: 0, y: 0, width: 100, height: 100, children: [] }] }));
  if (comments) fs.writeFileSync(path.join(p, "comments.json"), JSON.stringify({ format: 1, doc: crypto.randomUUID(), seq: 0, threads: [], outbox: [], ...comments }));
  return fs.realpathSync(p);
}
const disk = (pkg: string) => JSON.parse(fs.readFileSync(path.join(pkg, "comments.json"), "utf8"));

describe("the list", () => {
  test("cleaned: canonical addresses, no repeats, unsafe ones dropped, at most 200, an email only for a development address", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ url: `https://t${i}.example.com/` }));
    const clean = Cfg.cleanCloudList([
      { url: "https://Team.Example.com/path", devEmail: "anna@studio.test" },
      { url: "https://team.example.com" },
      { url: "http://team.example.com" },
      { url: "http://localhost:8787", devEmail: " Anna@Studio.test " },
      { url: "canvas-cloud://3F2B8C1E-5D4A-4E6F-9A7B-1C2D3E4F5A6B" },
      { url: "javascript:alert(1)" }, null, "https://x.example.com", ...many,
    ]);
    assert.deepEqual(clean.slice(0, 3), [
      { url: "https://team.example.com", devEmail: "" },
      { url: "http://localhost:8787", devEmail: "anna@studio.test" },
      { url: "canvas-cloud://3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b", devEmail: "" },
    ]);
    assert.equal(clean.length, Cfg.CLOUD_LIMITS.clouds);
  });

  test("the environment counts only while no shell sent a list; an empty list is a list", () => {
    Cfg.resetCloudConfig();
    process.env.CANVAS_CLOUD_URL = "https://env.example.com";
    try {
      assert.ok(Cfg.isConfigured("https://env.example.com"), "tests and dev: the environment");
      Cfg.setCloudConfig({ harness: "claude" });
      assert.ok(Cfg.isConfigured("https://env.example.com"), "settings without a list change nothing");
      list();
      assert.equal(Cfg.isConfigured("https://env.example.com"), false, "the shell's empty list wins over the environment");
    } finally { delete process.env.CANVAS_CLOUD_URL; }
  });

  test("an older list than the one in force is ignored; the same one again (the heartbeat) changes nothing", () => {
    list({ url: "https://a.example.com" }, { url: "https://b.example.com" });
    const now = rev;
    Cfg.setCloudConfig({ clouds: [{ url: "https://a.example.com" }], cloudsRev: now - 1 });
    assert.ok(Cfg.isConfigured("https://b.example.com"), "a late, older list does not remove b");
    assert.equal(Cfg.isConfigured("https://B.example.com"), false, "only the canonical form counts");
    assert.equal(Cfg.isConfigured("https://b.example.com/"), false);
  });

  test("a Cloud added here counts until a newer list; removed here, it stays out until a newer list names it", () => {
    list({ url: "https://a.example.com" });
    Cfg.addCloud("canvas-cloud://3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b");
    Cfg.setCloudConfig({ clouds: [{ url: "https://a.example.com" }], cloudsRev: rev });
    assert.ok(Cfg.isConfigured("canvas-cloud://3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b"), "the same list again keeps a join the shell has not seen");
    list({ url: "https://a.example.com" });
    assert.equal(Cfg.isConfigured("canvas-cloud://3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b"), false, "a newer list without it: gone");
    const g = Cfg.generation("https://a.example.com");
    Cfg.removeCloud("https://a.example.com");
    assert.equal(Cfg.isConfigured("https://a.example.com"), false);
    assert.ok(Cfg.generation("https://a.example.com") > g, "work begun before the removal is outdated");
    Cfg.setCloudConfig({ clouds: [{ url: "https://a.example.com" }], cloudsRev: rev });
    assert.equal(Cfg.isConfigured("https://a.example.com"), false, "the list sent before the removal does not bring it back");
    list({ url: "https://a.example.com" }, { url: "https://b.example.com" });
    assert.equal(Cfg.isConfigured("https://a.example.com"), false, "a newer list sent before the shell dropped it (another Cloud renamed meanwhile) does not bring it back either");
    list({ url: "https://b.example.com" });
    assert.equal(Cfg.isConfigured("https://a.example.com"), false, "the shell drops it: still out");
    list({ url: "https://a.example.com" });
    assert.ok(Cfg.isConfigured("https://a.example.com"), "a newer list that names it again does");
  });
});

describe("nothing reaches a Cloud that is not in the list", () => {
  test("unsafe or foreign file addresses are refused before any Keychain read", async () => {
    list({ url: "https://team.example.com" });
    fs.rmSync(log, { force: true });
    for (const u of ["http://team.example.com", "https://other.example.com", "https://team.example.com/", "https://TEAM.example.com", "http://localhost:8787"]) {
      assert.deepEqual(await Cl.target(u), { fail: "notAdded" }, u);
      assert.equal(await Cl.authHeaders(u), null, u);
    }
    assert.deepEqual(reads(), [], "not one Keychain read");
    assert.ok(!("fail" in await Cl.target("https://team.example.com")), "the configured one gets its token");
    assert.deepEqual(reads(), ["canvas.test.multi team.example.com"]);
  });

  test("a file shared to a Cloud that is not in the list never connects; its comments wait; adding the Cloud connects it", async () => {
    const t = await team();
    try {
      list();
      const pkg = pkgWith("orphan", { server: { url: t.url }, outbox: [] });
      const g = await call(`/api/comments?file=${encodeURIComponent(pkg)}`, undefined, "GET");
      assert.equal(g.j.sync.status, "notAdded");
      await sleep(300);
      assert.equal(t.hits.length, 0, "not one request");
      list({ url: t.url, devEmail: "anna@studio.test" });
      for (let i = 0; i < 40 && !t.hits.length; i++) await sleep(50);
      assert.ok(t.hits.length > 0, "added again: it connects");
      assert.equal(t.hits[0].headers["x-canvas-dev-email"], "anna@studio.test");
    } finally { Cl.stopAll(); await t.close(); }
  });

  test("status, token, sign-out and share refuse an address that is not one of the Clouds, and ask nobody", async () => {
    const t = await team();
    try {
      list({ url: "https://team.example.com" });
      const st = await call(`/api/cloud/status?url=${encodeURIComponent(t.url)}`, undefined, "GET");
      assert.equal(st.status, 404);
      assert.equal((await call("/api/cloud/token", { url: t.url, token: "tok_abcdefgh123" })).status, 400);
      assert.equal((await call("/api/cloud/token", { url: "https://other.example.com", token: "tok_abcdefgh123" })).status, 400);
      assert.equal((await call("/api/cloud/signout", { url: "https://other.example.com" })).status, 400);
      const pkg = pkgWith("refused");
      const sh = await call(`/api/cloud/share?file=${encodeURIComponent(pkg)}&url=${encodeURIComponent(t.url)}`);
      assert.equal(sh.status, 404);
      assert.equal(fs.existsSync(path.join(pkg, "comments.json")) && !!disk(pkg).server, false, "the file is not linked");
      assert.equal(t.hits.length, 0, "the unlisted server heard nothing");
    } finally { await t.close(); }
  });

  test("the status list names every Cloud, each with its own answer", async () => {
    const a = await team("anna@studio.test"), b = await team("ben@studio.test");
    try {
      list({ url: a.url, devEmail: "anna@studio.test" }, { url: b.url, devEmail: "ben@studio.test" });
      const all = await call("/api/cloud/status?fresh=1", undefined, "GET");
      assert.deepEqual(all.j.clouds.map((c: any) => [c.url, c.status, c.email]), [[a.url, "connected", "anna@studio.test"], [b.url, "connected", "ben@studio.test"]]);
      assert.equal(b.hits.find((h) => h.url === "/v1/me")?.headers["x-canvas-dev-email"], "ben@studio.test", "each its own email");
    } finally { await a.close(); await b.close(); }
  });
});

describe("sharing to a chosen Cloud", () => {
  test("to the one asked for; with two and none named, it asks which; a file already shared keeps its Cloud", async () => {
    const a = await team(), b = await team();
    try {
      list({ url: a.url, devEmail: "anna@studio.test" }, { url: b.url, devEmail: "anna@studio.test" });
      const pkg = pkgWith("chosen");
      const none = await call(`/api/cloud/share?file=${encodeURIComponent(pkg)}`);
      assert.equal(none.status, 400);
      assert.match(none.j.error, /Choose which Cloud/);
      const r = await call(`/api/cloud/share?file=${encodeURIComponent(pkg)}&url=${encodeURIComponent(b.url)}`);
      assert.equal(r.status, 200, JSON.stringify(r.j));
      assert.equal(r.j.url, b.url);
      assert.equal(disk(pkg).server.url, b.url);
      assert.ok(b.hits.some((h) => h.url === "/v1/docs"));
      assert.ok(!a.hits.some((h) => h.url === "/v1/docs"), "a registered nothing");
      const again = await call(`/api/cloud/share?file=${encodeURIComponent(pkg)}&url=${encodeURIComponent(a.url)}`);
      assert.equal(again.status, 200);
      assert.equal(again.j.already, true);
      assert.equal(again.j.url, b.url, "the answer names the Cloud the file is on, not the one asked for");
      assert.ok(!a.hits.some((h) => h.url === "/v1/docs"));
    } finally { Cl.stopAll(); await a.close(); await b.close(); }
  });

  test("two shares of one file at once, to two Clouds: one registers and links, the other is told where it went", async () => {
    const a = await team(), b = await team();
    try {
      list({ url: a.url, devEmail: "anna@studio.test" }, { url: b.url, devEmail: "anna@studio.test" });
      const pkg = pkgWith("race");
      const release = a.hold("/v1/docs");
      const pa = call(`/api/cloud/share?file=${encodeURIComponent(pkg)}&url=${encodeURIComponent(a.url)}`);
      await sleep(150);
      const pb = call(`/api/cloud/share?file=${encodeURIComponent(pkg)}&url=${encodeURIComponent(b.url)}`);
      await sleep(150);
      release();
      const [ra, rb] = await Promise.all([pa, pb]);
      assert.equal(ra.j.url, a.url);
      assert.equal(rb.j.url, a.url);
      assert.equal(rb.j.already, true);
      assert.equal(disk(pkg).server.url, a.url);
      assert.equal(b.hits.filter((h) => h.url === "/v1/docs").length, 0, "the second never registered");
    } finally { Cl.stopAll(); await a.close(); await b.close(); }
  });

  test("a Cloud removed while a share waits for it: the share fails and the file stays unshared", async () => {
    const a = await team();
    try {
      list({ url: a.url, devEmail: "anna@studio.test" });
      const pkg = pkgWith("removed-mid-share");
      const release = a.hold("/v1/docs");
      const p = call(`/api/cloud/share?file=${encodeURIComponent(pkg)}&url=${encodeURIComponent(a.url)}`);
      for (let i = 0; i < 40 && !a.hits.some((h) => h.url === "/v1/docs"); i++) await sleep(25);
      assert.equal((await call("/api/cloud/remove", { url: a.url })).status, 200);
      release();
      const r = await p;
      assert.equal(r.status, 404, JSON.stringify(r.j));
      assert.equal(fs.existsSync(path.join(pkg, "comments.json")) ? disk(pkg).server : undefined, undefined, "not linked");
    } finally { Cl.stopAll(); await a.close(); }
  });
});

describe("removing and signing out", () => {
  test("removed while its status is asked: the late answer is not kept and nothing more goes to it", async () => {
    const a = await team();
    try {
      list({ url: a.url, devEmail: "anna@studio.test" });
      const release = a.hold("/v1/me");
      const p = Cl.checkServer(a.url, true);
      for (let i = 0; i < 40 && !a.hits.some((h) => h.url === "/v1/me"); i++) await sleep(25);
      await call("/api/cloud/remove", { url: a.url });
      release();
      assert.equal((await p).status, "notAdded");
      const before = a.hits.length;
      assert.equal((await Cl.checkServer(a.url, true)).status, "notAdded");
      assert.equal((await call(`/api/cloud/status?url=${encodeURIComponent(a.url)}`, undefined, "GET")).status, 404);
      assert.equal(a.hits.length, before, "no request after the removal");
    } finally { await a.close(); }
  });

  test("a shared file's socket stops on removal and does not come back; it does when the Cloud is added again", async () => {
    const a = await team();
    try {
      list({ url: a.url, devEmail: "anna@studio.test" });
      const pkg = pkgWith("socket", { server: { url: a.url } });
      await call(`/api/comments?file=${encodeURIComponent(pkg)}`, undefined, "GET");
      for (let i = 0; i < 40 && !a.hits.length; i++) await sleep(50);
      await call("/api/cloud/remove", { url: a.url });
      const g = await call(`/api/comments?file=${encodeURIComponent(pkg)}`, undefined, "GET");
      assert.equal(g.j.sync.status, "notAdded");
      const before = a.hits.length;
      await sleep(1600); // past the first reconnect delay
      assert.equal(a.hits.length, before, "no reconnect, no status check");
      list(); // the shell drops the entry
      list({ url: a.url, devEmail: "anna@studio.test" }); // and later adds it again
      for (let i = 0; i < 60 && a.hits.length === before; i++) await sleep(50);
      assert.ok(a.hits.length > before, "added again: it reconnects");
    } finally { Cl.stopAll(); await a.close(); }
  });

  test("sign-out: the saved token is not read again, and a Keychain read under way is dropped", async () => {
    const origin = "https://team.example.com";
    list({ url: origin });
    Cl.setToken(origin, "tok_fresh_from_sign_in_0123");
    fs.writeFileSync(slow, "1");
    try {
      Cl.setToken(origin, null); // signed out; memory forgotten
      fs.rmSync(log, { force: true });
      assert.equal(await Cl.authHeaders(origin), null);
      assert.deepEqual(reads(), [], "no Keychain read after sign-out");
      // Signed in again, then out again while a read of the Keychain is under way.
      Cl.setToken(origin, "tok_second_sign_in_0123");
      Cl.setToken(origin, null);
      Cfg.setCloudConfig({ clouds: [{ url: origin }], cloudsRev: rev }); // a heartbeat changes nothing
      assert.equal(await Cl.authHeaders(origin), null);
      const third = "tok_third_sign_in_0123";
      Cl.setToken(origin, third);
      assert.deepEqual(await Cl.authHeaders(origin), { "cf-access-token": third });
      // A Keychain read that started before a sign-out is not used.
      Cl.stopAll();
      list(); list({ url: origin }); // removed and added: memory empty
      const p = Cl.authHeaders(origin);
      await sleep(100);
      Cl.setToken(origin, null);
      assert.equal(await p, null, "the late Keychain answer is dropped");
      assert.equal(await Cl.authHeaders(origin), null, "and not cached");
    } finally { fs.rmSync(slow, { force: true }); }
  });

  test("a token for a Cloud removed meanwhile (a sign-in window finishing late) is refused", async () => {
    list({ url: "https://late.example.com" });
    await call("/api/cloud/remove", { url: "https://late.example.com" });
    assert.equal((await call("/api/cloud/token", { url: "https://late.example.com", token: "tok_late_0123456" })).status, 400);
  });

  test("join: never into a Cloud this Mac is already in", async () => {
    const id = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
    list({ url: `canvas-cloud://${id}` });
    const link = `canvas://cloud/join?${new URLSearchParams({ v: "1", name: "Studio", host: id, tc: `tc${"a".repeat(64)}`, code: `ccj_0123456789abcdef.${"b".repeat(43)}` })}`;
    const r = await call("/api/cloud/join", { link, device: "A Mac" });
    assert.equal(r.status, 400);
    assert.match(r.j.error, /already in that Cloud/);
  });
});

/** A team server that accepts room sockets (a bare RFC 6455 handshake) and records who connected and when they left. */
async function socketServer() {
  const upgrades: { email?: string; closed: boolean }[] = [];
  const socks = new Set<import("node:net").Socket>();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/v1/info" ? JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }) : JSON.stringify({ email: "anna@studio.test", name: "anna", role: "owner" }));
  });
  srv.on("upgrade", (req, sock) => {
    const u = { email: req.headers["x-canvas-dev-email"] as string | undefined, closed: false };
    upgrades.push(u);
    const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socks.add(sock as import("node:net").Socket);
    // Closed: the TCP connection ended, or the client sent a close frame (0x88: FIN and opcode 8).
    sock.on("close", () => { u.closed = true; });
    sock.on("data", (d: Buffer) => { if (d[0] === 0x88) u.closed = true; });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { url, upgrades, close: async () => { for (const k of socks) k.destroy(); srv.closeAllConnections(); await new Promise<void>((r) => srv.close(() => r())); } };
}
const until = async (ok: () => boolean, what: string, ms = 5000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(25); } };

describe("races found in review", () => {
  test("removed right after target answered (before the request goes): nothing is sent, nothing is kept", async () => {
    const a = await team();
    try {
      list({ url: a.url, devEmail: "anna@studio.test" });
      Cl.testHooks.afterTarget = (url) => { Cfg.removeCloud(url); };
      const st = await Cl.checkServer(a.url, true);
      assert.equal(st.status, "notAdded");
      assert.equal(a.hits.length, 0, "the request with the development email never left");
    } finally { Cl.testHooks.afterTarget = undefined; await a.close(); }
  });

  test("a room socket is not opened for a Cloud removed right after target answered", async () => {
    const s = await socketServer();
    try {
      list({ url: s.url, devEmail: "anna@studio.test" });
      const pkg = pkgWith("socket-race", { server: { url: s.url } });
      Cl.testHooks.afterTarget = (url) => { Cfg.removeCloud(url); };
      await call(`/api/comments?file=${encodeURIComponent(pkg)}`, undefined, "GET");
      await sleep(600);
      assert.equal(s.upgrades.length, 0, "no socket with the old headers");
    } finally { Cl.testHooks.afterTarget = undefined; Cl.stopAll(); await s.close(); }
  });

  test("a new development email closes the socket and connects again as the new person", async () => {
    const s = await socketServer();
    try {
      list({ url: s.url, devEmail: "anna@studio.test" });
      const pkg = pkgWith("email-change", { server: { url: s.url } });
      await call(`/api/comments?file=${encodeURIComponent(pkg)}`, undefined, "GET");
      await until(() => s.upgrades.length === 1, "the first socket");
      assert.equal(s.upgrades[0].email, "anna@studio.test");
      const g = Cfg.generation(s.url);
      list({ url: s.url, devEmail: "ben@studio.test" });
      assert.ok(Cfg.generation(s.url) > g, "work begun as Anna is outdated");
      await until(() => s.upgrades[0].closed, "Anna's socket to close (a close frame)");
      await until(() => s.upgrades.some((u) => u.email === "ben@studio.test"), "a socket as Ben");
      assert.ok(!s.upgrades.slice(1).some((u) => u.email === "anna@studio.test"), "nothing more as Anna");
    } finally { Cl.stopAll(); await s.close(); }
  });

  test("a copy that arrives with ops waiting sends none of them as this person: they wait as refused, Retry sends them", async () => {
    const a = await team();
    try {
      list({ url: a.url, devEmail: "anna@studio.test" });
      const doc = crypto.randomUUID();
      const thread = crypto.randomUUID(), comment = crypto.randomUUID();
      const waiting = { opId: crypto.randomUUID(), doc, at: "2026-11-18T10:00:00.000Z", op: { kind: "thread.create", thread, comment, anchor: { nodeId: "Scr01", x: 0.5, y: 0.5 }, body: "Written by someone else" } };
      const pkg = pkgWith("arrived", { doc, server: { url: a.url }, outbox: [waiting] as any });
      const g = await call(`/api/comments?file=${encodeURIComponent(pkg)}`, undefined, "GET");
      assert.deepEqual(disk(pkg).outbox, [], "nothing of it waits to be sent");
      assert.equal(disk(pkg).rejected[0].envelope.opId, waiting.opId);
      assert.match(disk(pkg).rejected[0].message, /Retry sends it as you/);
      assert.equal(g.j.sync.rejected[0].opId, waiting.opId, "the page shows it with Retry and Discard");
      // A comment made here now goes out as usual; the held one stays held.
      const mine = { opId: crypto.randomUUID(), doc, at: "2026-11-18T10:01:00.000Z", op: { kind: "comment.add", thread, comment: crypto.randomUUID(), body: "Mine" } };
      const r = await call(`/api/comments/ops?file=${encodeURIComponent(pkg)}`, { ops: [mine] });
      assert.equal(r.status, 200);
      assert.deepEqual(disk(pkg).outbox.map((e: any) => e.opId), [mine.opId]);
      // Retry is the person saying yes.
      await call(`/api/comments/retry?file=${encodeURIComponent(pkg)}`, { opId: waiting.opId });
      assert.ok(disk(pkg).outbox.some((e: any) => e.opId === waiting.opId), "after Retry it is sent");
      // A file shared from this Mac is vouched for: its share ops are sent, never held.
      const own = pkgWith("own-share", { threads: [{ id: thread, doc: "", anchor: { nodeId: "Scr01", x: 0.5, y: 0.5 }, createdAt: "2026-11-18T10:00:00.000Z", createdBy: { name: "Anna" }, comments: [{ id: comment, body: "Hi", author: { name: "Anna" }, createdAt: "2026-11-18T10:00:00.000Z" }] }] as any });
      const fresh = disk(own); fresh.threads[0].doc = fresh.doc; fs.writeFileSync(path.join(own, "comments.json"), JSON.stringify(fresh));
      const sh = await call(`/api/cloud/share?file=${encodeURIComponent(own)}&url=${encodeURIComponent(a.url)}`);
      assert.equal(sh.status, 200, JSON.stringify(sh.j));
      await call(`/api/comments?file=${encodeURIComponent(own)}`, undefined, "GET");
      assert.equal((disk(own).rejected ?? []).length, 0, "nothing of a file shared here is held");
      assert.ok(disk(own).outbox.length > 0 || disk(own).seq > 0, "its ops go out");
    } finally { Cl.stopAll(); await a.close(); }
  });
});
