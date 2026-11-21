// PostHog widgets against a fake server that answers in the documented response shapes.
// No live key has been used: live verification against real PostHog is still pending.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeServer, sendJson, stubSecurity, tmpDir, writeDoc, type Fake } from "./helpers.ts";

const dir = tmpDir("posthog");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_TRUST_FILE = path.join(dir, "trust.json");
process.env.CANVAS_SECURITY_BIN = stubSecurity(dir, { "posthog:key": "phx_test_KEY_123456" });

const w = await import("../src/widgets.ts");
const { baseOf, normalize } = await import("../src/widgets/kinds/posthog.ts");
const { approveSource } = await import("../src/widgets/trust.ts");

const docFile = writeDoc(dir);
let fake: Fake;
before(async () => {
  fake = await fakeServer((req, res, body) => {
    const url = new URL(req.url!, "http://x");
    if (req.headers.authorization !== "Bearer phx_test_KEY_123456") return sendJson(res, { detail: "Authentication credentials were not provided." }, 401);
    if (req.method === "POST" && url.pathname === "/api/projects/123/query/") {
      const b = JSON.parse(body);
      if (b.query.query.includes("single")) return sendJson(res, { columns: ["c"], results: [[1234]] });
      if (b.query.query.includes("rows")) return sendJson(res, { columns: ["day", "n"], results: [["d1", 10], ["d2", 20], ["d3", 30]] });
      if (b.query.query.includes("limited")) return sendJson(res, { detail: "slow down" }, 429, { "retry-after": "120" });
      if (b.query.query.includes("trends")) return sendJson(res, { results: [{ data: [1, 2, 3, 6], days: ["a", "b", "c", "d"], count: 12, label: "Pageviews" }] });
      if (b.query.query.includes("wide")) return sendJson(res, { columns: ["a", "b", "c"], results: [[1, 2, 3]] });
      return sendJson(res, { results: [] });
    }
    if (req.method === "GET" && url.pathname === "/api/projects/123/insights/") {
      const id = url.searchParams.get("short_id");
      if (id === "trend1") return sendJson(res, { results: [{ short_id: "trend1", result: [{ data: [10, 20, 40], count: 70, aggregated_value: 70 }, { data: [5, 5, 5], count: 15, compare_label: "previous" }] }] });
      if (id === "funnel") return sendJson(res, { results: [{ short_id: "funnel", result: [{ name: "step1", count: 10 }, { name: "step2", count: 4 }] }] });
      if (id === "empty") return sendJson(res, { results: [] });
    }
    sendJson(res, { detail: "not found" }, 404);
  });
  process.env.CANVAS_POSTHOG_BASE = fake.url;
  approveSource("posthog", fake.url);
});
after(async () => {
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const base = { host: "us", projectId: "123", secret: { service: "posthog", account: "key" } };
const make = async (config: Record<string, unknown>, name = "PH") => (await w.addWidget(docFile, { kind: "posthog", name, config: { ...base, ...config } })).widget;
const read = async (id: string) => (await w.refreshWidget(docFile, id)).data;

describe("posthog widget", () => {
  test("us and eu map to the cloud origins; a custom origin passes through", () => {
    const saved = process.env.CANVAS_POSTHOG_BASE;
    delete process.env.CANVAS_POSTHOG_BASE;
    assert.equal(baseOf("us"), "https://us.posthog.com");
    assert.equal(baseOf("eu"), "https://eu.posthog.com");
    assert.equal(baseOf("https://ph.example.com"), "https://ph.example.com");
    process.env.CANVAS_POSTHOG_BASE = saved;
  });

  test("HogQL 1x1 is the value; the request has the documented path, bearer key and body", async () => {
    const wd = await make({ source: "query", query: { kind: "HogQLQuery", query: "select single" }, display: { format: "integer" } });
    const r = await read(wd.id);
    assert.equal(r.state, "ok");
    assert.equal(r.value, 1234);
    assert.equal(r.display, "1,234");
    assert.equal(r.label, "PH");
    const hit = fake.hits.at(-1)!;
    assert.equal(hit.method, "POST");
    assert.equal(hit.url, "/api/projects/123/query/");
    assert.equal(hit.headers.authorization, "Bearer phx_test_KEY_123456");
    assert.deepEqual(JSON.parse(hit.body), { query: { kind: "HogQLQuery", query: "select single" }, name: "canvas-widget", refresh: "force_blocking" });
  });

  test("HogQL n x 2 rows: last value, whole series, delta from the last two", async () => {
    const wd = await make({ source: "query", query: { kind: "HogQLQuery", query: "select rows" }, display: { label: "Signups" } });
    const r = await read(wd.id);
    assert.equal(r.value, 30);
    assert.deepEqual(r.spark, [10, 20, 30]);
    assert.deepEqual(r.delta, { value: 10, pct: 0.5, display: "+50%" });
    assert.equal(r.label, "Signups");
  });

  test("the spark can be switched off", async () => {
    const wd = await make({ source: "query", query: { kind: "HogQLQuery", query: "select rows" }, display: { spark: false } });
    assert.equal((await read(wd.id)).spark, undefined);
  });

  test("a TrendsQuery-shaped answer: aggregated count as value, data as spark", async () => {
    const wd = await make({ source: "query", query: { kind: "HogQLQuery", query: "select trends" } });
    const r = await read(wd.id);
    assert.equal(r.value, 12);
    assert.deepEqual(r.spark, [1, 2, 3, 6]);
    assert.equal(r.delta?.value, 3);
  });

  test("insight by short id: GET path and params, trends result, compare to previous period", async () => {
    const wd = await make({ source: "insight", insight: { shortId: "trend1" }, display: { compare: true, format: "compact" } });
    const r = await read(wd.id);
    assert.equal(r.state, "ok");
    assert.equal(r.value, 70);
    assert.deepEqual(r.spark, [10, 20, 40]);
    assert.equal(r.delta?.pct, (70 - 15) / 15);
    const hit = fake.hits.at(-1)!;
    assert.equal(hit.method, "GET");
    assert.equal(hit.url, "/api/projects/123/insights/?short_id=trend1&refresh=force_blocking");
  });

  test("insights that are not numbers say so; wrong shapes do not crash", async () => {
    const funnel = await make({ source: "insight", insight: { shortId: "funnel" } });
    const r = await read(funnel.id);
    assert.equal(r.state, "error");
    assert.equal(r.error?.code, "unsupported-insight");
    const empty = await make({ source: "insight", insight: { shortId: "empty" } });
    assert.equal((await read(empty.id)).error?.code, "unsupported-insight");
    const wide = await make({ source: "query", query: { kind: "HogQLQuery", query: "select wide" } });
    assert.equal((await read(wide.id)).error?.code, "unsupported-result");
    const none = await make({ source: "query", query: { kind: "HogQLQuery", query: "select nothing" } });
    assert.equal((await read(none.id)).error?.code, "no-data");
    assert.throws(() => normalize("junk", "query", {}), /no results/);
  });

  test("429 becomes a backoff error that carries Retry-After; the refresh button is throttled", async () => {
    const wd = await make({ source: "query", query: { kind: "HogQLQuery", query: "select limited" } });
    const r = await read(wd.id);
    assert.equal(r.state, "error");
    assert.equal(r.error?.code, "rate-limited");
    await assert.rejects(w.refreshWidget(docFile, wd.id), (e: any) => e.status === 429 && e.code === "throttled");
  });

  test("an unconfigured widget says what is missing and sends nothing", async () => {
    const hits = fake.hits.length;
    const wd = await make({ projectId: "", source: "insight" });
    const r = await read(wd.id);
    assert.equal(r.error?.code, "not-configured");
    const noKey = (await w.addWidget(docFile, { kind: "posthog", config: { projectId: "123", source: "insight", insight: { shortId: "trend1" } } })).widget;
    assert.equal((await read(noKey.id)).state, "needs-secret");
    assert.equal(fake.hits.length, hits);
  });

  test("a custom host needs the user's approval before the key leaves; approving unblocks it", async () => {
    const hits = fake.hits.length;
    // The fake is on 127.0.0.1 over http; a custom origin must be https, so approval is checked on a different origin.
    const wd = await make({ host: "https://ph.example.org", source: "insight", insight: { shortId: "trend1" } });
    const r = await read(wd.id);
    assert.equal(r.state, "needs-approval");
    assert.equal(r.approvalTarget, "https://ph.example.org");
    assert.match(r.error!.message, /ph\.example\.org/);
    assert.equal(fake.hits.length, hits, "nothing was sent");
    assert.deepEqual(await w.trustWidget(docFile, wd.id, undefined, false, r.approvalTarget), { ok: true, target: "https://ph.example.org" });
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.CANVAS_TRUST_FILE!, "utf8")).approvals, {}, "allowing a source does not release a secret");
    assert.deepEqual(await w.trustWidget(docFile, wd.id), { ok: true, origin: "https://ph.example.org" });
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.CANVAS_TRUST_FILE!, "utf8")).approvals, { "posthog\0key": ["https://ph.example.org"] });
  });

  test("config checks: host, project id, insight id, refresh floor", async () => {
    await assert.rejects(make({ host: "http://ph.example.org" }), (e: any) => e.status === 422);
    await assert.rejects(make({ host: "https://ph.example.org/path" }), (e: any) => e.status === 422);
    await assert.rejects(make({ projectId: "12; drop" }), (e: any) => e.status === 422);
    await assert.rejects(make({ insight: { shortId: "a b" } }), (e: any) => e.status === 422);
    await assert.rejects(make({ refreshSec: 5 }), (e: any) => e.status === 422);
    assert.equal((await make({ projectId: 123 })).config.projectId, "123");
  });
});
