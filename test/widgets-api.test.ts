// The widgets HTTP API and its SSE events, against a real server on its own port.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeServer, sendJson, sseClient, stubSecurity, tmpDir, writeDoc, type Fake } from "./helpers.ts";
import { json } from "./fixtures/json-kind.ts";
import { registerKind } from "../src/widgets/registry.ts";

registerKind(json); // a test-only kind with a URL, headers and auth (test/fixtures/json-kind.ts)

const dir = tmpDir("api");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_TRUST_FILE = path.join(dir, "trust.json");
process.env.CANVAS_SECURITY_BIN = stubSecurity(dir, { "svc:present": "abc-secret" });

const docFile = writeDoc(dir);
const docBytes = fs.readFileSync(docFile);
const { startServer, version } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
let upstream: Fake;

before(async () => {
  upstream = await fakeServer((_q, res) => sendJson(res, { stats: { users: 42, days: [{ n: 1 }, { n: 2 }, { n: 5 }] } }));
});
after(async () => {
  await upstream.close();
  fs.unwatchFile(docFile);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const q = (extra = "") => `?file=${encodeURIComponent(docFile)}${extra}`;
const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = { "x-canvas": "1" }) =>
  fetch(`${base}${p}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const jcall = async (method: string, p: string, body?: unknown, headers?: Record<string, string>) => {
  const r = await call(method, p, body, headers);
  return { status: r.status, body: (await r.json()) as any };
};

describe("widgets API", () => {
  test("empty at first; kinds are described for the native shell", async () => {
    const r = await jcall("GET", `/api/widgets${q()}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.widgets, []);
    assert.deepEqual(r.body.data, {});
    assert.ok(r.body.rev);
    const k = await jcall("GET", "/api/widgets/kinds");
    assert.deepEqual(k.body.map((x: any) => x.id).filter((id: string) => id !== "json"), ["todo", "note", "posthog", "shader", "video"]);
    const todo = k.body[0];
    assert.deepEqual(Object.keys(todo).sort(), ["actions", "defaultSize", "defaults", "fields", "id", "minSize", "symbol", "title"]);
    assert.deepEqual(todo.actions, ["addItem", "toggleItem", "updateItem", "removeItem", "moveItem"]);
    assert.ok(k.body[2].fields.some((f: any) => f.type === "secret"));
  });

  test("anything that changes state needs the x-canvas header", async () => {
    const none = {};
    for (const [m, p, b] of [
      ["POST", `/api/widgets${q()}`, { kind: "note" }],
      ["PATCH", `/api/widgets/w_x${q()}`, { name: "a" }],
      ["DELETE", `/api/widgets/w_x${q()}`, undefined],
      ["POST", `/api/widgets/w_x/actions/addItem${q()}`, {}],
      ["POST", `/api/widgets/w_x/refresh${q()}`, {}],
      ["POST", `/api/widgets/visibility${q()}`, { clientId: "c", ids: [] }],
      ["POST", `/api/widgets/w_x/trust${q()}`, {}],
    ] as const) {
      const r = await jcall(m, p, b, none);
      assert.equal(r.status, 403, `${m} ${p}`);
    }
    assert.equal(fs.existsSync(docFile.replace(/\.canvas\.json$/, ".widgets.json")), false);
  });

  test("errors: missing file 400, unknown file 404, unknown widget 404, unknown route 404, bad kind/config 422, bad JSON 400", async () => {
    assert.equal((await jcall("GET", "/api/widgets")).status, 400);
    assert.equal((await jcall("GET", `/api/widgets?file=${encodeURIComponent(path.join(dir, "nope.canvas.json"))}`)).status, 404);
    assert.equal((await jcall("GET", `/api/widgets/w_nope${q()}`)).status, 404);
    assert.equal((await jcall("GET", `/api/widgets/w_nope/zzz${q()}`)).status, 404);
    assert.equal((await jcall("POST", `/api/widgets${q()}`, { kind: "hologram" })).body.code, "unknown-kind");
    assert.equal((await jcall("POST", `/api/widgets${q()}`, { kind: "note", config: { tone: "neon" } })).status, 422);
    assert.equal((await jcall("POST", `/api/widgets${q()}`, { kind: "json", config: { url: "ftp://x" } })).status, 422);
    assert.equal((await jcall("POST", `/api/widgets${q()}`, { kind: "json", config: { path: "$.__proto__.x" } })).status, 422);
    assert.equal((await jcall("POST", `/api/widgets${q()}`, { kind: "json", config: { headers: { Authorization: "x" } } })).status, 422);
    const bad = await call("POST", `/api/widgets${q()}`);
    assert.equal(bad.status, 422, "no kind in an empty body");
    const junk = await fetch(`${base}/api/widgets${q()}`, { method: "POST", headers: { "x-canvas": "1" }, body: "{nope" });
    assert.equal(junk.status, 400);
    assert.equal(((await junk.json()) as any).code, "bad-json");
  });

  test("a body over 512 KB is refused with 413", async () => {
    const r = await jcall("POST", `/api/widgets${q()}`, { kind: "note", config: { text: "x".repeat(600 * 1024) } });
    assert.equal(r.status, 413);
    assert.equal(r.body.code, "too-large");
  });

  let todoId = "";
  test("create (auto-placed), read, patch (deep config merge), If-Match, delete and restore by id and index", async () => {
    const a = await jcall("POST", `/api/widgets${q()}`, { kind: "todo", name: "Today", config: { title: "Today" } });
    assert.equal(a.status, 201);
    todoId = a.body.widget.id;
    assert.match(todoId, /^w_[a-z0-9]{8}$/);
    assert.deepEqual([a.body.widget.x, a.body.widget.y, a.body.widget.w, a.body.widget.h], [1180, 0, 280, 160]);
    const b = await jcall("POST", `/api/widgets${q()}`, { kind: "note", name: "Memo", config: { text: "hello", tone: "yellow" } });
    assert.equal(b.body.widget.y, 184, "stacks below the first");
    const list = await jcall("GET", `/api/widgets${q()}`);
    assert.deepEqual(list.body.widgets.map((w: any) => w.name), ["Today", "Memo"]);
    assert.equal((await jcall("GET", `/api/widgets/${todoId}${q()}`)).body.widget.name, "Today");

    const patched = await jcall("PATCH", `/api/widgets/${todoId}${q()}`, { x: 20, y: 30, name: "Renamed", config: { hideDone: true } }, { "x-canvas": "1", "if-match": list.body.rev });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.widget.config.hideDone, true);
    assert.equal(patched.body.widget.config.title, "Today", "config merged, not replaced");
    const stale = await jcall("PATCH", `/api/widgets/${todoId}${q()}`, { name: "Again" }, { "x-canvas": "1", "if-match": list.body.rev });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "rev-mismatch");

    const del = await jcall("DELETE", `/api/widgets/${todoId}${q()}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.index, 0);
    assert.equal((await jcall("GET", `/api/widgets/${todoId}${q()}`)).status, 404);
    const undo = await jcall("POST", `/api/widgets${q()}`, { ...patched.body.widget, index: del.body.index });
    assert.equal(undo.status, 201);
    assert.deepEqual((await jcall("GET", `/api/widgets${q()}`)).body.widgets.map((w: any) => w.id)[0], todoId);
    assert.equal((await jcall("POST", `/api/widgets${q()}`, patched.body.widget)).status, 409, "restoring over an existing id");
  });

  test("todo actions: add, toggle, update, move, remove", async () => {
    const act = (name: string, body: unknown) => jcall("POST", `/api/widgets/${todoId}/actions/${name}${q()}`, body);
    const one = await act("addItem", { text: "milk" });
    assert.equal(one.status, 200);
    const two = await act("addItem", { text: "eggs" });
    const three = await act("addItem", { text: "first!", index: 0 });
    assert.deepEqual(three.body.widget.config.items.map((i: any) => i.text), ["first!", "milk", "eggs"]);
    const milk = one.body.result.id;
    assert.match(milk, /^i_[a-z0-9]{6}$/);
    assert.equal((await act("toggleItem", { id: milk })).body.widget.config.items[1].done, true);
    assert.equal((await act("toggleItem", { id: milk, done: false })).body.widget.config.items[1].done, false);
    assert.equal((await act("updateItem", { id: milk, text: "oat milk" })).body.widget.config.items[1].text, "oat milk");
    const moved = await act("moveItem", { id: two.body.result.id, index: 0 });
    assert.deepEqual(moved.body.widget.config.items.map((i: any) => i.text), ["eggs", "first!", "oat milk"]);
    assert.equal((await act("removeItem", { id: milk })).body.widget.config.items.length, 2);
    assert.equal((await act("removeItem", { id: "i_nothere" })).status, 404);
    assert.equal((await act("addItem", {})).status, 422);
    assert.equal((await act("addItem", { text: "x".repeat(501) })).status, 422);
    assert.equal((await act("explode", {})).body.code, "unknown-action");
    assert.equal((await jcall("POST", `/api/widgets/w_nope/actions/addItem${q()}`, { text: "a" })).status, 404);
    // No action named after an Object.prototype member sneaks through.
    assert.equal((await act("constructor", {})).body.code, "unknown-action");
  });

  test("the todo list stops at 200 items", async () => {
    const w = await jcall("POST", `/api/widgets${q()}`, { kind: "todo", config: { items: Array.from({ length: 200 }, (_, i) => ({ text: `t${i}` })) } });
    assert.equal(w.status, 201);
    assert.equal((await jcall("POST", `/api/widgets/${w.body.widget.id}/actions/addItem${q()}`, { text: "one too many" })).status, 422);
    await jcall("DELETE", `/api/widgets/${w.body.widget.id}${q()}`);
  });

  test("/page/*.js serves the allowlist only", async () => {
    const ok = await fetch(`${base}/page/widgets.js`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type")!, /javascript/);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    for (const n of ["geometry.js", "widget-kinds.js"]) assert.equal((await fetch(`${base}/page/${n}`)).status, 200, n);
    for (const p of ["/page/server.js", "/page/..%2fserver.ts", "/page/widgets.ts", "/page/"]) assert.equal((await fetch(`${base}${p}`)).status, 404, p);
    assert.notEqual((await fetch(`${base}/page/%2e%2e/widgets.js`)).status, 200, "dot segments never reach the page folder");
    assert.equal((await fetch(`${base}/`).then((r) => r.text())).includes('src="/page/widgets.js"'), true);
  });

  test("the version covers every file under src, so an old server is replaced", async () => {
    const health = (await fetch(`${base}/health`).then((r) => r.json())) as any;
    assert.equal(health.version, version());
    const f = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "page", "widgets.js");
    const before_ = fs.readFileSync(f);
    try {
      const v1 = version();
      fs.writeFileSync(f, before_ + "// touched\n");
      assert.notEqual(version(), v1);
    } finally {
      fs.writeFileSync(f, before_);
    }
  });

  test("secret-status reports presence without reading the value", async () => {
    assert.deepEqual((await jcall("GET", "/api/widgets/secret-status?service=svc&account=present")).body, { present: true });
    assert.deepEqual((await jcall("GET", "/api/widgets/secret-status?service=svc&account=absent")).body, { present: false });
    assert.equal((await jcall("GET", "/api/widgets/secret-status?service=a%20b&account=c")).status, 400);
    assert.equal((await jcall("GET", "/api/widgets/secret-status")).status, 400);
  });

  test("SSE: hello, widgets, then live data once a page holds a lease; changes are pushed", async () => {
    const app = await jcall("POST", `/api/widgets${q()}`, {
      kind: "json",
      name: "Users",
      config: { url: `${upstream.url}/stats`, path: "$.stats.users", sparkPath: "$.stats.days[*].n", format: "integer", refreshSec: 300 },
    });
    assert.equal(app.status, 201, JSON.stringify(app.body));
    const id = app.body.widget.id;
    const hits0 = upstream.hits.length;

    const es = sseClient(`${base}/events${q()}`);
    await es.until(() => es.events.some((e) => e.event === "widgets"));
    const names = es.events.map((e) => e.event);
    assert.deepEqual(names.slice(0, 3), ["doc", "hello", "widgets"], "hello comes right after the document");
    const clientId = es.events[1].data.clientId;
    assert.match(clientId, /^[A-Za-z0-9_-]{6,}$/);
    assert.ok(es.events[2].data.widgets.length >= 2);
    assert.equal(upstream.hits.length, hits0, "nothing fetched without a lease");

    const vis = await jcall("POST", `/api/widgets/visibility${q()}`, { clientId, ids: [id] });
    assert.deepEqual(vis.body, { ok: true, leaseSec: 90 });
    await es.until(() => es.events.some((e) => e.event === "wdata" && e.data[id]?.state === "ok"));
    const reading = es.events.find((e) => e.event === "wdata" && e.data[id]?.state === "ok")!.data[id];
    assert.equal(reading.value, 42);
    assert.equal(reading.display, "42");
    assert.deepEqual(reading.spark, [1, 2, 5]);
    assert.equal(reading.delta.display, "+150%");
    assert.equal(reading.label, "Users");
    assert.ok(reading.updatedAt > 0);
    assert.equal(upstream.hits.length, hits0 + 1);
    assert.equal(upstream.hits[hits0].headers.cookie, undefined);

    // The cached reading rides along in the list and on a second connection.
    assert.equal((await jcall("GET", `/api/widgets${q()}`)).body.data[id].value, 42);
    const es2 = sseClient(`${base}/events${q()}`);
    await es2.until(() => es2.events.some((e) => e.event === "wdata"));
    assert.equal(es2.events.find((e) => e.event === "wdata")!.data[id].value, 42);
    es2.close();

    // A change through the API reaches open pages as a `widgets` event.
    const seen = es.events.length;
    const r = await jcall("PATCH", `/api/widgets/${id}${q()}`, { name: "Renamed" });
    await es.until(() => es.events.slice(seen).some((e) => e.event === "widgets" && e.data.rev === r.body.rev));
    // Refresh pulls a new sample now and returns it.
    const fresh = await jcall("POST", `/api/widgets/${id}/refresh${q()}`, {});
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.data.state, "ok");
    assert.equal(upstream.hits.length, hits0 + 2);
    assert.equal((await jcall("POST", `/api/widgets/${id}/refresh${q()}`, {})).status, 429, "refresh is throttled");
    assert.equal((await jcall("POST", `/api/widgets/${id}/refresh${q()}`, {})).body.code, "throttled");

    // A page that hides its tab drops the lease.
    await jcall("POST", `/api/widgets/visibility${q()}`, { clientId, ids: [] });
    es.close();
    assert.equal((await jcall("POST", `/api/widgets/visibility${q()}`, { clientId: "bad id!", ids: [] })).status, 400);
    assert.equal((await jcall("POST", `/api/widgets/visibility${q()}`, { clientId: "c", ids: "all" })).status, 400);
  });

  test("a todo or note has no live data to refresh", async () => {
    const r = await jcall("POST", `/api/widgets/${todoId}/refresh${q()}`, {});
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "no-source");
    assert.equal((await jcall("POST", `/api/widgets/${todoId}/trust${q()}`, {})).body.code, "no-secret");
  });

  test("a document from before the App value card was dropped still opens; the old card can be moved and deleted", async () => {
    const old = writeDoc(dir, "old-app-card");
    const oq = `?file=${encodeURIComponent(old)}`;
    const card = { id: "w_oldapp", kind: "app", name: "Users", x: 10, y: 20, w: 220, h: 140, locked: false, config: { url: "http://127.0.0.1:1/x", path: "$.n" } };
    fs.writeFileSync(old.replace(/\.canvas\.json$/, ".widgets.json"), JSON.stringify({ version: 1, widgets: [card] }));
    const list = await jcall("GET", `/api/widgets${oq}`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.widgets.map((w: any) => [w.id, w.kind]), [["w_oldapp", "app"]]);
    assert.ok(!(await jcall("GET", "/api/widgets/kinds")).body.some((k: any) => k.id === "app"), "no longer offered");
    assert.equal((await jcall("POST", `/api/widgets${oq}`, { kind: "app" })).body.code, "unknown-kind", "no new ones");
    assert.equal((await jcall("POST", `/api/widgets/w_oldapp/refresh${oq}`, {})).body.code, "no-source", "nothing polls it");
    const moved = await jcall("PATCH", `/api/widgets/w_oldapp${oq}`, { x: 40 });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.widget.config, card.config, "its data is kept as it was");
    assert.equal((await jcall("DELETE", `/api/widgets/w_oldapp${oq}`)).status, 200);
    assert.deepEqual((await jcall("GET", `/api/widgets${oq}`)).body.widgets, []);
    fs.unwatchFile(old);
  });

  test("the .canvas.json file is byte for byte what it was", () => {
    assert.deepEqual(fs.readFileSync(docFile), docBytes);
  });
});
