// Comments in a local file (src/comments.ts, src/comments-file.ts, mcp/tools/comments.ts): comments.json in the package,
// the two routes, the guards, tombstones, Save As and the MCP tools end to end.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LIMITS, type CommentsFile, type OpEnvelope } from "../cloud/protocol.ts";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("comments");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_COMMENT_NAME = "Ana Test";
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "Scr01", name: "Screen", x: 0, y: 0, width: 390, height: 844, children: [{ type: "text", id: "Ttl01", name: "Title", content: "Hi", fontSize: 20 }] },
    { type: "frame", id: "Scr02", name: "Wide", x: 500, y: 0, width: 600, height: 300, children: [] },
  ],
};
function pkg(name: string): string {
  const p = path.join(dir, `${name}.canvas`);
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, "document.json"), JSON.stringify(DOC, null, 2));
  return fs.realpathSync(p);
}

const C = await import("../src/comments.ts");
const F = await import("../src/comments-file.ts");
const U = await import("../src/usage-counts.ts");
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const serverVersion = ((await (await fetch(`${base}/health`)).json()) as { version: string }).version;
const mcps: Client[] = [];
after(async () => {
  for (const c of mcps) await c.close().catch(() => {});
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const uuid = () => crypto.randomUUID();
const q = (p: string) => encodeURIComponent(p);
const env = (op: OpEnvelope["op"], doc = C.NIL_DOC): OpEnvelope => ({ opId: uuid(), doc, at: new Date().toISOString(), op });
const create = (body = "Make this bigger", nodeId = "Ttl01") => {
  const thread = uuid(), comment = uuid();
  return { thread, comment, e: env({ kind: "thread.create", thread, comment, anchor: { nodeId, x: 0.25, y: 0.5, board: "Scr01", preview: { name: "Title", type: "text" } }, body }) };
};
async function post(file: string, ops: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}/api/comments/ops?file=${q(file)}`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", ...headers }, body: JSON.stringify({ ops }) });
  return { status: r.status, j: (await r.json()) as any };
}
const get = async (file: string) => (await (await fetch(`${base}/api/comments?file=${q(file)}`)).json()) as any;
const onDisk = (p: string) => JSON.parse(fs.readFileSync(path.join(p, "comments.json"), "utf8")) as CommentsFile;

describe("routes", () => {
  test("a file with no comments has no comments.json, and the first comment makes it with a new doc uuid", async () => {
    const p = pkg("first");
    assert.deepEqual(await get(p), { doc: null, threads: [], me: "Ana Test" });
    assert.ok(!fs.existsSync(path.join(p, "comments.json")), "reading creates nothing");
    const { thread, e } = create();
    const r = await post(p, [e]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.j.rejected, []);
    assert.equal(r.j.applied.length, 1);
    const f = onDisk(p);
    assert.equal(f.format, 1);
    assert.match(f.doc, /^[0-9a-f-]{36}$/);
    assert.notEqual(f.doc, C.NIL_DOC);
    assert.equal(f.seq, 0);
    assert.deepEqual(f.outbox, []);
    assert.equal(f.server, undefined);
    assert.equal(f.threads[0].id, thread);
    assert.equal(f.threads[0].doc, f.doc);
    assert.deepEqual(f.threads[0].comments[0].author, { name: "Ana Test" });
    assert.equal(f.threads[0].comments[0].body, "Make this bigger");
    assert.deepEqual((await get(p)).threads.map((t: any) => t.id), [thread]);
    assert.equal((await get(p)).doc, f.doc);
  });

  test("replies, resolve and reopen apply; the document in an envelope may be the file's own doc", async () => {
    const p = pkg("flow");
    const { thread, e } = create();
    const first = await post(p, [e]);
    const doc = first.j.doc;
    const reply = env({ kind: "comment.add", thread, comment: uuid(), body: "Agreed" }, doc);
    const r = await post(p, [reply, env({ kind: "thread.resolve", thread, resolved: true })]);
    assert.deepEqual(r.j.rejected, []);
    let t = onDisk(p).threads[0];
    assert.equal(t.comments.length, 2);
    assert.ok(t.resolvedAt);
    assert.deepEqual(t.resolvedBy, { name: "Ana Test" });
    await post(p, [env({ kind: "thread.resolve", thread, resolved: false })]);
    t = onDisk(p).threads[0];
    assert.equal(t.resolvedAt, undefined);
  });

  test("bad envelopes are rejected one by one and the good ones in the same request still apply", async () => {
    const p = pkg("bad");
    const ok = create();
    const empty = create("   ");
    const long = create("x".repeat(LIMITS.bodyChars + 1));
    const other = env({ kind: "thread.resolve", thread: ok.thread, resolved: true }, uuid());
    const r = await post(p, [empty.e, ok.e, long.e, other, { nonsense: true }]);
    assert.equal(r.status, 200);
    assert.equal(r.j.applied.length, 1);
    assert.deepEqual(r.j.rejected.map((x: any) => x.code), ["invalid", "invalid", "conflict", "invalid"]);
    assert.match(r.j.rejected[2].message, /another document/);
    assert.equal(onDisk(p).threads.length, 1);
  });

  test("an op on an unknown thread is a conflict; a replayed create or reply is acknowledged once, not applied twice", async () => {
    const p = pkg("replay");
    const { thread, e } = create();
    await post(p, [e]);
    const again = await post(p, [e]);
    assert.equal(again.j.applied.length, 1);
    assert.equal(onDisk(p).threads.length, 1);
    assert.equal(onDisk(p).threads[0].comments.length, 1);
    const reply = env({ kind: "comment.add", thread, comment: uuid(), body: "one" });
    await post(p, [reply, reply]);
    await post(p, [reply]);
    assert.equal(onDisk(p).threads[0].comments.length, 2);
    const lost = await post(p, [env({ kind: "comment.add", thread: uuid(), comment: uuid(), body: "x" })]);
    assert.equal(lost.j.rejected[0].code, "conflict");
    assert.match(lost.j.rejected[0].message, /no such thread/);
  });

  test("deletes are tombstones that survive a reload, and nothing comes back to a deleted thread", async () => {
    const p = pkg("tomb");
    const { thread, e } = create("secret");
    const reply = env({ kind: "comment.add", thread, comment: uuid(), body: "me too" });
    await post(p, [e, reply]);
    const mine = onDisk(p).threads[0].comments[1].id;
    await post(p, [env({ kind: "comment.delete", comment: mine })]);
    let t = onDisk(p).threads[0];
    assert.equal(t.comments[1].body, "");
    assert.ok(t.comments[1].deletedAt);
    await post(p, [env({ kind: "thread.delete", thread })]);
    // A new server instance reads the same file: the tombstones are in the bytes.
    t = F.readCommentsFile(p)!.threads[0];
    assert.ok(t.deletedAt);
    assert.deepEqual(t.comments.map((c) => c.body), ["", ""]);
    assert.ok(t.comments.every((c) => c.deletedAt));
    const revive = await post(p, [env({ kind: "comment.add", thread, comment: uuid(), body: "back" }), env({ kind: "thread.resolve", thread, resolved: true }), env({ kind: "comment.edit", comment: mine, body: "edited" })]);
    assert.deepEqual(revive.j.rejected.map((x: any) => x.code), ["conflict", "conflict", "conflict"]);
    assert.equal(F.readCommentsFile(p)!.threads[0].comments.every((c) => c.body === ""), true);
    // Replaying the original create does not bring the thread back either.
    await post(p, [e]);
    assert.ok(F.readCommentsFile(p)!.threads[0].deletedAt);
  });

  test("the guards: a write needs x-canvas, a request from another site is refused, a single-file document is turned away", async () => {
    const p = pkg("guard");
    const body = JSON.stringify({ ops: [create().e] });
    const noHeader = await fetch(`${base}/api/comments/ops?file=${q(p)}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(noHeader.status, 403);
    const foreign = await fetch(`${base}/api/comments/ops?file=${q(p)}`, { method: "POST", headers: { "x-canvas": "1", origin: "http://evil.example", "content-type": "application/json" }, body });
    assert.equal(foreign.status, 403);
    assert.ok(!fs.existsSync(path.join(p, "comments.json")));
    const legacy = path.join(dir, "old.canvas.json");
    fs.writeFileSync(legacy, JSON.stringify(DOC));
    const r = await post(legacy, [create().e]);
    assert.equal(r.status, 400);
    assert.match(r.j.error, /\.canvas/);
    assert.equal((await fetch(`${base}/api/comments`)).status, 400);
  });

  test("at most 100 ops in a request, and at most 5000 threads in a document", async () => {
    const p = pkg("limits");
    const many = Array.from({ length: LIMITS.opsPerMessage + 1 }, () => create().e);
    assert.equal((await post(p, many)).status, 413);
    const f: CommentsFile = { format: 1, doc: uuid(), seq: 0, outbox: [], threads: [] };
    for (let i = 0; i < LIMITS.threadsPerDoc; i++) f.threads.push({ id: uuid(), doc: f.doc, anchor: { x: 0, y: 0 }, createdAt: "2026-01-01T00:00:00.000Z", createdBy: { name: "A" }, comments: [] });
    F.writeCommentsFile(p, f);
    const r = await post(p, [create().e]);
    assert.equal(r.j.rejected[0].code, "quota");
  });

  test("the author is the person's name; an agent's comment carries its client's name; neither has an email", async () => {
    const p = pkg("authors");
    const a = create("from the person");
    const b = create("from an agent");
    await post(p, [a.e]);
    await post(p, [b.e], { "x-canvas-source": "mcp", "x-canvas-agent": "claude-code" });
    const c = create("from codex");
    await post(p, [c.e], { "x-canvas-source": "mcp", "x-canvas-agent": "codex-mcp-client" });
    const d = create("from another");
    await post(p, [d.e], { "x-canvas-source": "mcp", "x-canvas-agent": "Some Tool <b>markup</b>" });
    const names = onDisk(p).threads.map((t) => t.createdBy);
    assert.deepEqual(names, [{ name: "Ana Test" }, { name: "Claude Code", agent: true }, { name: "Codex", agent: true }, { name: "Some Tool b markup b", agent: true }]);
    assert.equal(C.agentName(undefined), "Agent");
  });

  test("comments are counted by what happened, by name", async () => {
    for (const n of ["comment.thread_created", "comment.replied", "comment.resolved"]) assert.ok(U.isEvent(n), n);
    const p = pkg("counted");
    const { thread, e } = create();
    const r = C.applyEnvelopes(p, [e, env({ kind: "comment.add", thread, comment: uuid(), body: "r" }), env({ kind: "thread.resolve", thread, resolved: true }), env({ kind: "thread.resolve", thread, resolved: false })], { name: "A" });
    assert.deepEqual(r.counts, ["comment.thread_created", "comment.replied", "comment.resolved"]);
  });
});

describe("the file", () => {
  test("the write is atomic: no temp file is left, and a write that cannot finish leaves the old file whole", async () => {
    const p = pkg("atomic");
    await post(p, [create("one").e]);
    assert.deepEqual(fs.readdirSync(p).filter((n) => n.includes(".tmp")), []);
    const before = fs.readFileSync(path.join(p, "comments.json"), "utf8");
    fs.chmodSync(p, 0o555); // no new files in the folder: the temp file cannot be made
    try {
      assert.throws(() => C.applyEnvelopes(p, [create("two").e], { name: "A" }));
    } finally {
      fs.chmodSync(p, 0o755);
    }
    assert.equal(fs.readFileSync(path.join(p, "comments.json"), "utf8"), before);
    assert.deepEqual(fs.readdirSync(p).filter((n) => n.includes(".tmp")), []);
  });

  test("a comments.json that is not comments is never overwritten", async () => {
    const p = pkg("corrupt");
    const bad = "{ not json";
    fs.writeFileSync(path.join(p, "comments.json"), bad);
    const r = await post(p, [create().e]);
    assert.equal(r.status, 422);
    assert.match(r.j.error, /not valid JSON/);
    assert.equal(fs.readFileSync(path.join(p, "comments.json"), "utf8"), bad);
    assert.equal((await fetch(`${base}/api/comments?file=${q(p)}`)).status, 422);
  });

  test("Save As gives the copy a new doc uuid and the threads under it; a plain copy keeps the doc", async () => {
    const p = pkg("orig");
    const { thread, e } = create();
    await post(p, [e, env({ kind: "comment.add", thread, comment: uuid(), body: "a reply" })]);
    const orig = onDisk(p);
    const target = path.join(dir, "forked.canvas");
    const r = await fetch(`${base}/api/canvas/save-as`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file: p, target }) });
    assert.equal(r.status, 200);
    const fork = onDisk(target);
    assert.notEqual(fork.doc, orig.doc);
    assert.match(fork.doc, /^[0-9a-f-]{36}$/);
    assert.equal(fork.threads.length, 1);
    assert.equal(fork.threads[0].id, thread);
    assert.ok(fork.threads.every((t) => t.doc === fork.doc));
    assert.equal(fork.threads[0].comments.length, 2);
    assert.deepEqual(fork.outbox, []);
    assert.equal(onDisk(p).doc, orig.doc, "the original is untouched");
    // A sync folder or Finder copies the folder as it is: the same document.
    const copy = path.join(dir, "copied.canvas");
    fs.cpSync(p, copy, { recursive: true });
    assert.equal(onDisk(copy).doc, orig.doc);
    // Save As of a file with no comments makes no comments.json.
    const none = pkg("nocomments");
    const t2 = path.join(dir, "none-copy.canvas");
    await fetch(`${base}/api/canvas/save-as`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file: none, target: t2 }) });
    assert.ok(fs.existsSync(path.join(t2, "document.json")));
    assert.ok(!fs.existsSync(path.join(t2, "comments.json")));
  });

  test("comments are not in the design file: document.json is byte for byte what it was", async () => {
    const p = pkg("untouched");
    const before = fs.readFileSync(path.join(p, "document.json"), "utf8");
    await post(p, [create().e]);
    assert.equal(fs.readFileSync(path.join(p, "document.json"), "utf8"), before);
  });
});

describe("MCP tools", () => {
  async function connect(name: string) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(import.meta.dirname, "../mcp/server.ts")],
      env: { ...(process.env as Record<string, string>), CANVAS_PORT: String(port), CANVAS_MCP_NO_SPAWN: "1", CANVAS_MCP_NO_APP: "1", CANVAS_MCP_WANT_VERSION: serverVersion },
      stderr: "pipe",
    });
    const c = new Client({ name, version: "1" });
    await c.connect(transport);
    mcps.push(c);
    return c;
  }
  const run = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r: any = await c.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { isError: !!r.isError, text, json };
  };

  test("add, list, reply and resolve round trip through the same routes, named after the client", async () => {
    const p = pkg("mcp");
    const c = await connect("claude-code");
    const added = await run(c, "add_comment", { file: p, nodeId: "Ttl01", body: "Is this the right size?", x: 0.1, y: 0.9 });
    assert.equal(added.isError, false, added.text);
    const t = added.json.thread;
    assert.equal(t.comments[0].author, "Claude Code");
    assert.equal(t.anchor.nodeId, "Ttl01");
    assert.equal(t.anchor.board, "Scr01");
    assert.deepEqual([t.anchor.x, t.anchor.y], [0.1, 0.9]);
    assert.equal(t.anchor.preview.name, "Title");
    assert.equal(t.anchor.preview.type, "text");
    // The default is the middle of the layer.
    const mid = await run(c, "add_comment", { file: p, nodeId: "Scr02", body: "Middle" });
    assert.deepEqual([mid.json.thread.anchor.x, mid.json.thread.anchor.y], [0.5, 0.5]);
    assert.equal(onDisk(p).threads[1].anchor.preview?.width, 600);

    // The person replies in the app (the page's route), then the agent reads it.
    await post(p, [env({ kind: "comment.add", thread: t.id, comment: uuid(), body: "No, smaller" })]);
    const listed = await run(c, "list_comments", { file: p });
    assert.equal(listed.json.threads.length, 2);
    const first = listed.json.threads.find((x: any) => x.id === t.id);
    assert.deepEqual(first.comments.map((x: any) => [x.author, x.body]), [["Claude Code", "Is this the right size?"], ["Ana Test", "No, smaller"]]);
    assert.deepEqual(first.layer, { name: "Title", type: "text" });

    const rep = await run(c, "reply_comment", { file: p, threadId: t.id, body: "Done" });
    assert.equal(rep.json.thread.comments.length, 3);
    const res = await run(c, "resolve_comment", { file: p, threadId: t.id, resolved: true });
    assert.equal(res.json.thread.resolved, true);
    assert.deepEqual((await run(c, "list_comments", { file: p })).json.threads.map((x: any) => x.id), [mid.json.thread.id]);
    const all = await run(c, "list_comments", { file: p, includeResolved: true });
    assert.equal(all.json.threads.length, 2);
    await run(c, "resolve_comment", { file: p, threadId: t.id, resolved: false });
    assert.equal((await run(c, "list_comments", { file: p })).json.threads.length, 2);
  });

  test("a thread whose layer is gone lists as deleted with the layer's old name; unknown threads and layers are errors", async () => {
    const p = pkg("mcp-gone");
    const c = await connect("codex");
    const a = await run(c, "add_comment", { file: p, nodeId: "Ttl01", body: "hi" });
    assert.equal(a.json.thread.comments[0].author, "Codex");
    const f = onDisk(p);
    f.threads[0].anchor.nodeId = "Gone99";
    F.writeCommentsFile(p, f);
    const l = await run(c, "list_comments", { file: p });
    assert.deepEqual(l.json.threads[0].layer, { deleted: true, name: "Title" });
    const bad = await run(c, "reply_comment", { file: p, threadId: uuid(), body: "x" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /^not_found:/);
    assert.equal((await run(c, "add_comment", { file: p, nodeId: "Nope00", body: "x" })).isError, true);
    assert.equal((await run(c, "add_comment", { file: p, nodeId: "Ttl01", body: "" })).isError, true);
  });
});
