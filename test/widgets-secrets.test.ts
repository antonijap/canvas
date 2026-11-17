// Secrets: read from the (stubbed) Keychain, sent only where approved, and never visible anywhere else.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fakeServer, sendJson, sseClient, stubSecurity, tmpDir, writeDoc } from "./helpers.ts";
import { json } from "./fixtures/json-kind.ts";
import { registerKind } from "../src/widgets/registry.ts";

registerKind(json); // a test-only kind with a URL and auth (test/fixtures/json-kind.ts)

const SECRET = "sk_live_SUPERSECRET_9f8e7d6c";
const ROTATED = "sk_live_ROTATED_1a2b3c4d5e";

const dir = tmpDir("secrets");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_TRUST_FILE = path.join(dir, "trust.json");
process.env.CANVAS_SECURITY_BIN = stubSecurity(dir, { "acme:token": SECRET });
const keychainFile = path.join(dir, "keychain", "acme:token");

// Everything the server prints, in case it ever prints a secret.
const printed: string[] = [];
for (const m of ["log", "info", "warn", "error", "debug"] as const) {
  const orig = console[m];
  console[m] = (...a: unknown[]) => {
    printed.push(a.map(String).join(" "));
    orig(...a);
  };
}
const seenBodies: string[] = [];

const docFile = writeDoc(dir);
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const upstream = await fakeServer((req, res) => {
  const auth = req.headers.authorization;
  const key = req.headers["x-api-key"];
  if (req.url === "/deny") return sendJson(res, { error: "no" }, 401);
  if (req.url === "/rotated") return auth === `Bearer ${ROTATED}` ? sendJson(res, { n: 9 }) : sendJson(res, { error: "old key" }, 401);
  if (req.url === "/header") return key === SECRET ? sendJson(res, { n: 7 }) : sendJson(res, { error: "nope" }, 403);
  return auth === `Bearer ${SECRET}` ? sendJson(res, { n: 5 }) : sendJson(res, { error: "nope" }, 401);
});

after(async () => {
  await upstream.close();
  fs.unwatchFile(docFile);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const q = `?file=${encodeURIComponent(docFile)}`;
const jcall = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${base}${p}`, { method, headers: { "x-canvas": "1", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  seenBodies.push(text);
  return { status: r.status, body: JSON.parse(text) as any };
};
const bearer = { type: "bearer", secret: { service: "acme", account: "token" } };
const add = (config: Record<string, unknown>) => jcall("POST", `/api/widgets${q}`, { kind: "json", config: { path: "$.n", ...config } }).then((r) => r.body.widget.id as string);

const es = sseClient(`${base}/events${q}`);
await es.until(() => es.events.some((e) => e.event === "hello"));
const clientId = es.events.find((e) => e.event === "hello")!.data.clientId;
const lease = (ids: string[]) => jcall("POST", `/api/widgets/visibility${q}`, { clientId, ids });
const reading = (id: string, state: string) => es.until(() => es.events.some((e) => e.event === "wdata" && e.data[id]?.state === state)).then(() => es.events.filter((e) => e.event === "wdata" && e.data[id]?.state === state).at(-1)!.data[id]);

describe("secrets", () => {
  test("nothing is sent until the user approves the origin; then the bearer key goes out", async () => {
    const id = await add({ url: `${upstream.url}/ok`, auth: bearer });
    await lease([id]);
    const blocked = await reading(id, "needs-approval");
    assert.match(blocked.error.message, new RegExp(upstream.url.replace(/[.]/g, "\\.")));
    assert.equal(upstream.hits.length, 0, "the secret request went out before approval");

    const trust = await jcall("POST", `/api/widgets/${id}/trust${q}`, {});
    assert.deepEqual(trust.body, { ok: true, origin: upstream.url });
    const ok = await reading(id, "ok");
    assert.equal(ok.value, 5);
    assert.equal(upstream.hits.length, 1);
    assert.equal(upstream.hits[0].headers.authorization, `Bearer ${SECRET}`);
    // The approval file holds origins, not values.
    const trustFile = fs.readFileSync(process.env.CANVAS_TRUST_FILE!, "utf8");
    assert.deepEqual(JSON.parse(trustFile).approvals, { "acme\0token": [upstream.url] });
    assert.equal(fs.statSync(process.env.CANVAS_TRUST_FILE!).mode & 0o777, 0o600);
    await lease([]);
  });

  test("a custom header carries the secret when the widget says so", async () => {
    const id = await add({ url: `${upstream.url}/header`, auth: { type: "header", header: "x-api-key", secret: { service: "acme", account: "token" } } });
    await lease([id]);
    assert.equal((await reading(id, "ok")).value, 7);
    assert.equal(upstream.hits.at(-1)!.headers["x-api-key"], SECRET);
    assert.equal(upstream.hits.at(-1)!.headers.authorization, undefined);
    await lease([]);
  });

  test("a missing Keychain item (exit 44) reads as needs-secret and sends nothing", async () => {
    const before_ = upstream.hits.length;
    const id = await add({ url: `${upstream.url}/ok`, auth: { type: "bearer", secret: { service: "acme", account: "absent" } } });
    await lease([id]);
    const r = await reading(id, "needs-secret");
    assert.equal(r.error.code, "needs-secret");
    assert.equal(upstream.hits.length, before_);
    await lease([]);
  });

  test("a bearer widget with no secret chosen says so", async () => {
    const id = await add({ url: `${upstream.url}/ok`, auth: { type: "bearer" } });
    await lease([id]);
    assert.equal((await reading(id, "needs-secret")).error.code, "needs-secret");
    await lease([]);
  });

  test("a 401 forgets the cached secret, so a rotated key is picked up", async () => {
    const denied = await add({ url: `${upstream.url}/deny`, auth: bearer });
    await lease([denied]);
    assert.equal((await reading(denied, "error")).error.code, "auth");
    await lease([]);
    fs.writeFileSync(keychainFile, ROTATED);
    const fresh = await add({ url: `${upstream.url}/rotated`, auth: bearer });
    await lease([fresh]);
    assert.equal((await reading(fresh, "ok")).value, 9, "still sending the cached old key");
    assert.equal(upstream.hits.at(-1)!.headers.authorization, `Bearer ${ROTATED}`);
    await lease([]);
  });

  test("secret-changed drops the cached secret, so a replaced key is used at once (no 401 needed)", async () => {
    // The cache holds ROTATED from the test above; the shell saves SECRET again and says so.
    fs.writeFileSync(keychainFile, SECRET);
    assert.equal((await fetch(`${base}/api/widgets/secret-changed`, { method: "POST", body: JSON.stringify({ service: "acme", account: "token" }) })).status, 403, "needs x-canvas");
    assert.equal((await jcall("POST", "/api/widgets/secret-changed", { service: "acme", account: "../x" })).status, 400);
    assert.deepEqual((await jcall("POST", "/api/widgets/secret-changed", { service: "acme", account: "token" })).body, { ok: true });
    const id = await add({ url: `${upstream.url}/ok`, auth: bearer });
    await lease([id]);
    assert.equal((await reading(id, "ok")).value, 5, "still sending the cached old key");
    assert.equal(upstream.hits.at(-1)!.headers.authorization, `Bearer ${SECRET}`);
    await lease([]);
  });

  test("a secret never goes over plain http to a host that is not local", async () => {
    const id = await add({ url: "http://example.com/stats", auth: bearer });
    await lease([id]);
    await reading(id, "needs-approval");
    await jcall("POST", `/api/widgets/${id}/trust${q}`, {});
    const r = await reading(id, "error");
    assert.equal(r.error.code, "insecure-auth");
    await lease([]);
  });

  test("secret-status answers present or not, never the value", async () => {
    const yes = await jcall("GET", "/api/widgets/secret-status?service=acme&account=token");
    assert.deepEqual(yes.body, { present: true });
  });

  test("the secret appears in no response, event, file, error or log line", async () => {
    await new Promise((r) => setTimeout(r, 400)); // let the last pushes flush
    const haystack = [
      ["api responses", seenBodies.join("\n")],
      ["sse events", JSON.stringify(es.events)],
      ["sidecar", fs.readFileSync(docFile.replace(/\.canvas\.json$/, ".widgets.json"), "utf8")],
      ["trust file", fs.readFileSync(process.env.CANVAS_TRUST_FILE!, "utf8")],
      ["console", printed.join("\n")],
      ["listing", JSON.stringify(await (await fetch(`${base}/api/widgets${q}`)).json())],
      ["kinds", JSON.stringify(await (await fetch(`${base}/api/widgets/kinds`)).json())],
    ] as const;
    for (const [where, text] of haystack) {
      for (const s of [SECRET, ROTATED, "SUPERSECRET", "ROTATED_1a2b"]) assert.equal(text.includes(s), false, `${s} leaked into ${where}`);
    }
    assert.ok(seenBodies.length > 10 && es.events.length > 10, "the checks looked at real traffic");
    es.close();
  });
});
