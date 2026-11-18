// Comments sync (src/cloud-sync.ts, src/cloud.ts): the confirmed threads and the outbox kept apart, what the page shows,
// acks and refusals, reconnects, sharing a file, who the token is sent to, and the 401 rules. The real server is run
// by qa/cloud-e2e.ts; here the state is plain objects and the network is a fake.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { applyOp, checkEnvelope, type Applied, type CommentsFile, type OpEnvelope, type Thread } from "../cloud/protocol.ts";
import type { SyncFile } from "../src/cloud-sync.ts";
import { fakeServer, tmpDir } from "./helpers.ts";

const dir = tmpDir("cloud-sync");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_STATE_DIR = path.join(dir, ".state");
process.env.CANVAS_COMMENT_NAME = "Ana Test";
process.env.CANVAS_CLOUD_KEYCHAIN_SERVICE = "canvas.test.cloud"; // never the real Keychain item
delete process.env.CANVAS_CLOUD_URL;
delete process.env.CANVAS_CLOUD_DEV_EMAIL;

const S = await import("../src/cloud-sync.ts");
const Cfg = await import("../src/cloud-config.ts");
const Cl = await import("../src/cloud.ts");
const { startServer } = await import("../src/server.ts");
after(() => { Cl.stopAll(); fs.rmSync(dir, { recursive: true, force: true }); });

const uuid = () => crypto.randomUUID();
const DOC = uuid();
const ME = { email: "anna@studio.test", name: "anna" };
const BEN = { email: "ben@studio.test", name: "ben" };
const anchor = { nodeId: "N1", x: 0.5, y: 0.5 };
const at = "2026-11-17T10:00:00.000Z";
const env = (op: OpEnvelope["op"]): OpEnvelope => ({ opId: uuid(), doc: DOC, at, op });
const shared = (over: Partial<SyncFile> = {}): SyncFile => ({ format: 1, doc: DOC, server: { url: "https://team.example.com" }, seq: 0, threads: [], outbox: [], me: ME, ...over });
const create = (body = "Hello") => { const thread = uuid(), comment = uuid(); return { thread, comment, e: env({ kind: "thread.create", thread, comment, anchor, body }) }; };
const entry = (seq: number, e: OpEnvelope, by = BEN): Applied => ({ seq, opId: e.opId, by, at: "2026-11-17T10:00:0" + seq + ".000Z", op: e.op });
const fb = { name: "Ana Test" };

describe("what the page shows: confirmed threads plus the outbox", () => {
  test("a queued comment shows at once, as this person's, and is not in the confirmed threads", () => {
    const f = shared();
    const c = create("Typed offline");
    const r = S.queueLocal(f, [{ ...c.e, doc: S.NIL_DOC }], { name: "Ana Test" }, fb);
    assert.deepEqual(r.queued, [c.e.opId]);
    assert.equal(f.outbox.length, 1);
    assert.equal(f.outbox[0].doc, DOC, "the nil doc is replaced before anything is stored");
    assert.equal(f.threads.length, 0, "the confirmed side is untouched");
    const v = S.viewOf(f, fb);
    assert.equal(v[0].comments[0].body, "Typed offline");
    assert.equal(v[0].comments[0].author.email, ME.email);
  });

  test("the server's entry replaces the optimistic one: its author and time win, the outbox empties", () => {
    const f = shared();
    const c = create();
    S.queueLocal(f, [c.e], { name: "x" }, fb);
    assert.equal(S.confirm(f, [entry(1, c.e, ME)]), true);
    assert.equal(f.outbox.length, 0);
    assert.equal(f.seq, 1);
    assert.equal(f.threads[0].comments[0].createdAt, "2026-11-17T10:00:01.000Z");
    assert.equal(S.viewOf(f, fb).length, 1, "shown once, not twice");
  });

  test("an ack removes the op only once its entry is applied; before that it stays", () => {
    const f = shared();
    const c = create();
    S.queueLocal(f, [c.e], { name: "x" }, fb);
    assert.equal(S.acknowledge(f, c.e.opId, 1), false, "seq 1 is not applied yet");
    assert.equal(f.outbox.length, 1);
    f.seq = 1;
    assert.equal(S.acknowledge(f, c.e.opId, 1), true);
    assert.equal(f.outbox.length, 0);
  });

  test("duplicates are ignored: the same entry twice, an old seq, an op already in the outbox", () => {
    const f = shared();
    const c = create();
    S.confirm(f, [entry(1, c.e)]);
    S.confirm(f, [entry(1, c.e)]);
    S.confirm(f, [entry(1, create("older").e)]);
    assert.equal(f.threads.length, 1);
    assert.equal(f.seq, 1);
    const d = create();
    S.queueLocal(f, [d.e, d.e], { name: "x" }, fb);
    assert.equal(f.outbox.length, 1, "the same opId queued twice is queued once");
  });

  test("a reconnect with since: replayed entries at or below seq change nothing, newer ones apply in order", () => {
    const f = shared();
    const a = create("a"), b = create("b"), c = create("c");
    S.confirm(f, [entry(1, a.e), entry(2, b.e)]);
    S.confirm(f, [entry(3, c.e), entry(2, b.e), entry(1, a.e)]);
    assert.deepEqual(f.threads.map((t: Thread) => t.comments[0].body), ["a", "b", "c"]);
    assert.equal(f.seq, 3);
  });

  test("a snapshot replaces the confirmed threads and keeps the outbox on top", () => {
    const f = shared({ seq: 2 });
    const old = create("stale");
    S.confirm(f, [entry(3, old.e)]);
    const mine = create("mine");
    S.queueLocal(f, [mine.e], { name: "x" }, fb);
    const server = create("server truth");
    const t: Thread = { id: server.thread, doc: DOC, anchor, createdAt: at, createdBy: BEN, comments: [{ id: server.comment, thread: server.thread, author: BEN, body: "server truth", createdAt: at }] };
    S.snapshot(f, [t], 9);
    assert.equal(f.seq, 9);
    assert.deepEqual(f.threads.map((x: Thread) => x.id), [server.thread]);
    assert.deepEqual(S.viewOf(f, fb).map((x) => x.comments[0].body), ["server truth", "mine"]);
  });

  test("a refused op leaves the outbox, is kept with its reason, and Retry and Discard work", () => {
    const f = shared();
    const c = create();
    const reply = env({ kind: "comment.add", thread: c.thread, comment: uuid(), body: "reply" });
    S.queueLocal(f, [c.e, reply], { name: "x" }, fb);
    assert.equal(S.reject(f, [{ opId: c.e.opId, code: "forbidden", message: "This role cannot apply the op" }]), true);
    assert.equal(f.outbox.length, 1);
    assert.equal(f.rejected!.length, 1);
    assert.equal(S.viewOf(f, fb)[0].comments[0].body, "Hello", "a refused create is still shown, with its reason");
    const states = S.pendingStates(f, S.viewOf(f, fb));
    assert.equal(states.rejected[0].message, "This role cannot apply the op");
    assert.equal(states.rejected[0].comment, c.comment);
    assert.equal(S.retry(f, c.e.opId), true);
    assert.equal(f.rejected!.length, 0);
    assert.equal(f.outbox.at(-1)!.opId, c.e.opId, "Retry puts it back at the end of the outbox");
    S.reject(f, [{ opId: c.e.opId, code: "forbidden", message: "no" }]);
    assert.equal(S.discard(f, c.e.opId), true);
    assert.equal(f.rejected!.length, 0);
    assert.equal(f.outbox.length, 0, "the reply that depended on the discarded thread goes with it");
  });

  test("a change that cannot apply to what is shown is refused at once, like the server would", () => {
    const f = shared();
    const r = S.queueLocal(f, [env({ kind: "comment.add", thread: uuid(), comment: uuid(), body: "orphan" })], { name: "x" }, fb);
    assert.equal(r.queued.length, 0);
    assert.equal(r.refused[0].code, "conflict");
  });

  test("an agent's comment is queued as the person's but shown as the agent's (Author.agent)", () => {
    const f = shared();
    const c = create("From the agent");
    S.queueLocal(f, [c.e], { name: "Claude Code", agent: true }, fb);
    assert.deepEqual(S.viewOf(f, fb)[0].comments[0].author, { name: "Claude Code", agent: true });
    S.confirm(f, [entry(1, c.e, ME)]);
    assert.equal(f.threads[0].comments[0].author.email, ME.email, "the server only knows the person");
    assert.deepEqual(S.viewOf(f, fb)[0].comments[0].author, { name: "Claude Code", agent: true }, "this machine still shows the agent");
  });
});

describe("sharing a file", () => {
  test("sharing sends the same ids, anchors and tombstones and keeps them after confirmation", () => {
    const t1 = uuid(), t2 = uuid(), t3 = uuid(), c1 = uuid(), c2 = uuid(), c3 = uuid(), c4 = uuid(), c5 = uuid();
    const author = { name: "Ana Test" };
    const com = (id: string, thread: string, body: string, deletedAt?: string) => ({ id, thread, author, body, createdAt: at, ...(deletedAt ? { deletedAt } : {}) });
    const f: CommentsFile = {
      format: 1, doc: DOC, seq: 0, outbox: [],
      threads: [
        { id: t1, doc: DOC, anchor, createdAt: at, createdBy: author, comments: [com(c1, t1, "one"), com(c2, t1, "two"), com(c3, t1, "", at)] },
        { id: t2, doc: DOC, anchor: { x: 1, y: 2 }, createdAt: at, createdBy: author, resolvedAt: at, resolvedBy: author, comments: [com(c4, t2, "resolved")] },
        { id: t3, doc: DOC, anchor, createdAt: at, createdBy: author, deletedAt: at, comments: [com(c5, t3, "", at)] },
      ],
    };
    const ops = S.opsForShare(f).map((e) => e.op);
    assert.deepEqual(ops.map((o) => o.kind), ["thread.create", "comment.add", "comment.add", "comment.delete", "thread.create", "thread.resolve", "thread.create", "thread.delete"]);
    assert.deepEqual(ops[0], { kind: "thread.create", thread: t1, anchor, comment: c1, body: "one" });
    assert.deepEqual(ops[1], { kind: "comment.add", thread: t1, comment: c2, body: "two" });
    assert.deepEqual(ops[2], { kind: "comment.add", thread: t1, comment: c3, body: "Deleted" });
    assert.deepEqual(ops[3], { kind: "comment.delete", comment: c3 });
    assert.deepEqual(ops[4], { kind: "thread.create", thread: t2, anchor: { x: 1, y: 2 }, comment: c4, body: "resolved" });
    assert.deepEqual(ops[6], { kind: "thread.create", thread: t3, anchor, comment: c5, body: "Deleted" });
    assert.deepEqual(ops[7], { kind: "thread.delete", thread: t3 });
    const shared2 = S.shareLocal(f, "https://team.example.com", ME);
    assert.equal(shared2.server!.url, "https://team.example.com");
    assert.equal(shared2.outbox.length, 8);
    assert.equal(shared2.threads.length, 0, "the confirmed side starts empty: the server confirms them");
    assert.equal(S.viewOf(shared2, fb).filter((t) => !t.deletedAt).length, 2, "the page still shows both live threads");
    const server: Thread[] = [];
    const applied = shared2.outbox.map((e, i) => {
      assert.equal(checkEnvelope(e), null);
      assert.equal(applyOp(server, DOC, e.op, ME, at), null);
      return { seq: i + 1, opId: e.opId, by: ME, at, op: e.op };
    });
    S.confirm(shared2, applied);
    assert.equal(shared2.outbox.length, 0);
    assert.deepEqual(shared2.threads, server);
    assert.ok(shared2.threads[0].comments[2].deletedAt);
    assert.ok(shared2.threads[2].deletedAt);

    const old = structuredClone(f);
    for (const t of old.threads) {
      delete t.deletedAt;
      for (const c of t.comments) { delete c.deletedAt; c.body ||= "Old copy"; }
    }
    const stale = S.shareLocal(old, "https://team.example.com", ME, S.opsForShare(old, new Date(at)));
    S.snapshot(stale, server, applied.length);
    // An old copy's creates, replies and edits cannot replace the server's tombstones.
    for (const e of stale.outbox) applyOp(server, DOC, e.op, ME, at);
    assert.equal(applyOp(server, DOC, { kind: "comment.edit", comment: c3, body: "Old copy" }, ME, at), "comment deleted");
    assert.equal(applyOp(server, DOC, { kind: "comment.add", thread: t3, comment: uuid(), body: "Old copy" }, ME, at), "thread deleted");
    assert.deepEqual(S.viewOf(stale, fb), shared2.threads);
    assert.deepEqual(server, shared2.threads);
  });

  test("sharing preserves a deleted first comment, an all-deleted thread and every id inside a deleted thread", () => {
    const original = shared({ server: undefined });
    const roots = [create(), create(), create()];
    const replies = roots.map((r) => env({ kind: "comment.add", thread: r.thread, comment: uuid(), body: "Reply" }));
    for (const [i, r] of roots.entries()) {
      applyOp(original.threads, DOC, r.e.op, ME, at);
      applyOp(original.threads, DOC, replies[i].op, ME, at);
      applyOp(original.threads, DOC, { kind: "comment.delete", comment: r.comment }, ME, at);
    }
    applyOp(original.threads, DOC, { kind: "comment.delete", comment: (replies[1].op as { comment: string }).comment }, ME, at);
    applyOp(original.threads, DOC, { kind: "thread.delete", thread: roots[2].thread }, ME, at);
    const f = S.shareLocal(original, "https://team.example.com", ME, S.opsForShare(original, new Date(at)));
    const shown = S.viewOf(f, fb);
    assert.deepEqual(shown, original.threads);
    assert.equal(shown[0].comments[1].body, "Reply");
    assert.equal(shown[1].deletedAt, undefined, "deleting all comments does not delete their thread");
    for (const e of f.outbox) assert.equal(checkEnvelope(e), null);
  });
});

describe("whom the sign-in goes to", () => {
  test("the dev email goes only to the exact http://localhost or http://127.0.0.1 address it was given for, never a token with it, never to another host", async () => {
    Cfg.setCloudConfig({ clouds: [{ url: "https://team.example.com", devEmail: "anna@studio.test" }, { url: "http://localhost:8787", devEmail: "anna@studio.test" }, { url: "http://127.0.0.1:8787", devEmail: "ben@studio.test" }] });
    assert.deepEqual(await Cl.authHeaders("http://localhost:8787"), { "x-canvas-dev-email": "anna@studio.test" });
    assert.deepEqual(await Cl.authHeaders("http://127.0.0.1:8787"), { "x-canvas-dev-email": "ben@studio.test" }, "each address its own email");
    assert.equal(await Cl.authHeaders("http://127.0.0.1:8788"), null, "another port on this Mac is another service: no email");
    assert.equal(await Cl.authHeaders("http://localhost"), null);
    assert.equal(Cfg.devEmailFor("https://team.example.com"), "", "an https Cloud never keeps a dev email");
    assert.equal(await Cl.authHeaders("https://team.example.com"), null, "an https host with no token is signed out, whatever the dev email");
    assert.equal(await Cl.authHeaders("http://team.example.com"), null);
    assert.equal(await Cl.authHeaders("https://localhost.evil.example"), null);
    Cl.setToken("https://team.example.com", "eyJhbGciOi.payload.signature");
    assert.deepEqual(await Cl.authHeaders("https://team.example.com"), { "cf-access-token": "eyJhbGciOi.payload.signature" });
    Cl.setToken("https://team.example.com", null);
    assert.equal(await Cl.authHeaders("https://team.example.com"), null);
  });

  test("a server address is https, or http on this machine, and nothing else", () => {
    assert.equal(Cfg.cleanServerUrl("https://studio-canvas.workers.dev/some/path"), "https://studio-canvas.workers.dev");
    assert.equal(Cfg.cleanServerUrl("http://localhost:8787"), "http://localhost:8787");
    assert.equal(Cfg.cleanServerUrl("http://studio.example.com"), null);
    assert.equal(Cfg.cleanServerUrl("https://user:pw@studio.example.com"), null);
    assert.equal(Cfg.cleanServerUrl("file:///etc/passwd"), null);
    assert.equal(Cfg.cleanServerUrl("studio"), null);
  });
});

describe("the 401 rules", () => {
  test("Access answers become Sign in again; the Worker's own answers keep their meaning", () => {
    assert.equal(Cl.classify({ status: 401 }), "signInAgain");
    assert.equal(Cl.classify({ status: 403, contentType: "text/html" }), "signInAgain");
    assert.equal(Cl.classify({ status: 302, type: "opaqueredirect" }), "signInAgain");
    assert.equal(Cl.classify({ status: 200, contentType: "text/html; charset=utf-8" }), "signInAgain", "a login page answered with 200");
    assert.equal(Cl.classify({ status: 403, contentType: "application/json", code: "forbidden" }), "forbidden");
    assert.equal(Cl.classify({ status: 503 }), "offline");
    assert.equal(Cl.classify({ status: 200, contentType: "application/json" }), "ok");
  });

  test("the reconnect delay doubles from 1 s to 60 s with jitter", () => {
    const d = (n: number, r = 0.5) => Cl.backoffMs(n, r);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map((n) => d(n)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    assert.equal(d(0, 0), 800);
    assert.equal(d(0, 1), 1200);
    assert.equal(d(8, 1), 72000);
  });

  test("a server that wants a login: status Sign in again, and the file's comments are kept", async () => {
    let mode: "login" | "ok" = "login";
    const fake = await fakeServer((req, res) => {
      if (mode === "login") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>Sign in</html>"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/v1/info" ? JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }) : JSON.stringify({ email: "anna@studio.test", name: "anna", role: "owner" }));
    });
    try {
      const origin = `http://127.0.0.1:${fake.port}`;
      Cfg.setCloudConfig({ clouds: [{ url: origin, devEmail: "anna@studio.test" }] });
      assert.equal((await Cl.checkServer(origin, true)).status, "signInAgain");
      mode = "ok";
      const ok = await Cl.checkServer(origin, true);
      assert.equal(ok.status, "connected");
      assert.equal(ok.role, "owner");
      assert.equal(fake.hits[0].headers["x-canvas-dev-email"], "anna@studio.test");
      assert.equal(fake.hits[0].headers["cf-access-token"], undefined);
    } finally {
      await fake.close();
    }
  });

  test("a connected answer is reused for a minute, a fresh look after 3 s, and a new development email asks again", async () => {
    const fake = await fakeServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/v1/info" ? JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }) : JSON.stringify({ email: "anna@studio.test", name: "anna", role: "owner" }));
    });
    const saved = { ...Cl.STATUS_REUSE_MS };
    try {
      const origin = `http://127.0.0.1:${fake.port}`;
      Cfg.setCloudConfig({ clouds: [{ url: origin, devEmail: "anna@studio.test" }] });
      assert.equal((await Cl.checkServer(origin, true)).status, "connected");
      assert.equal(fake.hits.length, 2, "info and me");
      // Within the minute: no request, plain or fresh (fresh waits for 3 s).
      for (let i = 0; i < 5; i++) await Cl.checkServer(origin);
      await Cl.checkServer(origin, false, true);
      assert.equal(fake.hits.length, 2, "reused");
      // A fresh look once the answer is older than STATUS_REUSE_MS.fresh asks again.
      Cl.STATUS_REUSE_MS.fresh = 20;
      await new Promise((r) => setTimeout(r, 40));
      await Cl.checkServer(origin, false, true);
      assert.equal(fake.hits.length, 4, "fresh asks");
      await Cl.checkServer(origin);
      assert.equal(fake.hits.length, 4, "and a plain look reuses that");
      // Past the minute (shortened here): asked again.
      Cl.STATUS_REUSE_MS.connected = 20;
      await new Promise((r) => setTimeout(r, 40));
      await Cl.checkServer(origin);
      assert.equal(fake.hits.length, 6, "asked after the connected window");
      // Another development email is another person: asked at once.
      Cl.STATUS_REUSE_MS.connected = 60_000;
      Cfg.setCloudConfig({ clouds: [{ url: origin, devEmail: "ben@studio.test" }] });
      await Cl.checkServer(origin);
      assert.equal(fake.hits.length, 8, "a new email asks again");
      assert.equal(fake.hits[7].headers["x-canvas-dev-email"], "ben@studio.test");
    } finally {
      Object.assign(Cl.STATUS_REUSE_MS, saved);
      await fake.close();
    }
  });

  test("an answer that is not connected is reused for 3 s only", async () => {
    const fake = await fakeServer((_req, res) => { res.writeHead(503); res.end(); });
    const saved = { ...Cl.STATUS_REUSE_MS };
    try {
      const origin = `http://127.0.0.1:${fake.port}`;
      Cfg.setCloudConfig({ clouds: [{ url: origin, devEmail: "anna@studio.test" }] });
      assert.equal((await Cl.checkServer(origin, true)).status, "offline");
      await Cl.checkServer(origin);
      assert.equal(fake.hits.length, 1, "reused within 3 s");
      Cl.STATUS_REUSE_MS.other = 20;
      await new Promise((r) => setTimeout(r, 40));
      await Cl.checkServer(origin);
      assert.equal(fake.hits.length, 2, "asked again after it");
    } finally {
      Object.assign(Cl.STATUS_REUSE_MS, saved);
      await fake.close();
    }
  });

  test("a too old server says so", async () => {
    const fake = await fakeServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ protocol: 0, server: "0.0.1", capabilities: [] })); });
    try {
      const origin = `http://127.0.0.1:${fake.port}`;
      Cfg.setCloudConfig({ clouds: [{ url: origin, devEmail: "anna@studio.test" }] });
      assert.equal((await Cl.checkServer(origin, true)).status, "tooOld");
    } finally {
      await fake.close();
    }
  });
});

const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => { await new Promise((r) => server.close(r)); });

describe("through the local server", () => {
  const pkgDir = path.join(dir, "shared.canvas");
  fs.mkdirSync(pkgDir);
  fs.writeFileSync(path.join(pkgDir, "document.json"), JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "Scr01", name: "S", x: 0, y: 0, width: 100, height: 100, children: [] }] }));
  const pkg = fs.realpathSync(pkgDir);
  const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}file=${encodeURIComponent(pkg)}`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, j: (await r.json()) as any };
  };

  test("a file linked to an unreachable server keeps every comment in the outbox and shows it pending", async () => {
    Cfg.setCloudConfig({ clouds: [{ url: "http://127.0.0.1:9", devEmail: "anna@studio.test" }] });
    const f: CommentsFile = { format: 1, doc: DOC, server: { url: "http://127.0.0.1:9" }, seq: 0, threads: [], outbox: [] };
    fs.writeFileSync(path.join(pkg, "comments.json"), JSON.stringify(f));
    const c = create("Offline comment");
    const r = await post("/api/comments/ops", { ops: [{ ...c.e, doc: S.NIL_DOC }] });
    assert.equal(r.status, 200);
    assert.equal(r.j.threads[0].comments[0].body, "Offline comment");
    assert.equal(r.j.sync.pending[0].comment, c.comment);
    const disk = JSON.parse(fs.readFileSync(path.join(pkg, "comments.json"), "utf8")) as CommentsFile;
    assert.equal(disk.outbox[0].doc, DOC, "the real doc, not the nil one");
    assert.equal(disk.threads.length, 0);
    const g = await (await fetch(`${base}/api/comments?file=${encodeURIComponent(pkg)}`)).json() as any;
    assert.equal(g.threads.length, 1);
    assert.ok(["offline", "signedOut"].includes(g.sync.status), g.sync.status);
    assert.equal(g.sync.host, "127.0.0.1:9");
    Cl.disconnect(pkg);
  });

  test("an agent's comment on a shared file is marked Author.agent in what the page gets", async () => {
    const c = create("Agent says");
    const r = await post("/api/comments/ops", { ops: [c.e] }, { "x-canvas-source": "mcp", "x-canvas-agent": "claude-code" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.j.threads.find((t: Thread) => t.id === c.thread).comments[0].author, { name: "Claude Code", agent: true });
    Cl.disconnect(pkg);
  });

  test("Retry and Discard on a refused comment, through the routes", async () => {
    Cfg.setCloudConfig({ clouds: [{ url: "http://127.0.0.1:9", devEmail: "anna@studio.test" }] });
    const a = create("refused one"), b = create("refused two");
    const f: SyncFile = { format: 1, doc: DOC, server: { url: "http://127.0.0.1:9" }, seq: 0, threads: [], outbox: [], me: ME,
      rejected: [{ envelope: a.e, code: "forbidden", message: "This role cannot apply the op" }, { envelope: b.e, code: "quota", message: "Too big" }] };
    fs.writeFileSync(path.join(pkg, "comments.json"), JSON.stringify(f));
    const g = await (await fetch(`${base}/api/comments?file=${encodeURIComponent(pkg)}`)).json() as any;
    assert.equal(g.threads.length, 2, "refused comments are still shown");
    assert.deepEqual(g.sync.rejected.map((r: any) => r.message), ["This role cannot apply the op", "Too big"]);
    const r1 = await post("/api/comments/retry", { opId: a.e.opId });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.j.sync.pending.map((p: any) => p.opId), [a.e.opId], "Retry puts it back in the outbox");
    const r2 = await post("/api/comments/discard", { opId: b.e.opId });
    assert.equal(r2.status, 200);
    assert.equal(r2.j.threads.length, 1, "Discard drops it");
    assert.equal((await post("/api/comments/discard", { opId: uuid() })).status, 404);
    const noHeader = await fetch(`${base}/api/comments/retry?file=${encodeURIComponent(pkg)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ opId: a.e.opId }) });
    assert.equal(noHeader.status, 403, "x-canvas guarded");
    Cl.disconnect(pkg);
  });

  test("the token is kept in memory: no file under the state or the package has it", async () => {
    const origin = "https://team.example.com";
    Cfg.setCloudConfig({ clouds: [{ url: origin }] });
    const token = "tok_" + "A1b2C3d4E5f6".repeat(6);
    const r = await post("/api/cloud/token", { url: origin, token });
    assert.equal(r.status, 200);
    assert.deepEqual(await Cl.authHeaders(origin), { "cf-access-token": token });
    const hits: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (fs.readFileSync(p).includes(token)) hits.push(p); } };
    walk(dir);
    assert.deepEqual(hits, []);
    const bad = await post("/api/cloud/token", { url: "https://other.example.com", token });
    assert.equal(bad.status, 400, "only the configured server");
    const noHeader = await fetch(`${base}/api/cloud/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: origin, token }) });
    assert.equal(noHeader.status, 403, "x-canvas guarded");
    await post("/api/cloud/signout", { url: origin });
    assert.equal(await Cl.authHeaders(origin), null);
  });
});
