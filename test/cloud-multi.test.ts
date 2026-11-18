// Many Clouds (src/cloud-config.ts, src/cloud.ts): the shell's list is the only way in, every network path and
// Keychain read is refused for an address that is not exactly one of them, a removed Cloud gets nothing more, and the
// races around removing, signing out and sharing. The servers here are fakes on 127.0.0.1 (DEV mode, a dev email).

import assert from "node:assert/strict";
import fs from "node:fs";
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
      list({ url: a.url, devEmail: "anna@studio.test" });
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
