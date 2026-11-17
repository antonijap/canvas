// Anonymous usage counts (src/usage-counts.ts) against the website's contract: the list of names, the body's shape,
// UTC days, one POST per completed day, failures kept for tomorrow, the monthly install id, and what never sends
// (a checkout, sharing off, a QA build). The sender posts to a local server (CANVAS_USAGE_URL) so the test sees the
// exact request.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import {
  cleanEvents, cleanFacts, handleUsageCountsRoute, KEEP_DAYS, MAX_BYTES, MAX_COUNT, MAX_NAMES, RE, runsFromBundle, USAGE_EVENTS, UsageCounts, utcDay,
} from "../src/usage-counts.ts";

type Got = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
const got: Got[] = [];
let answer: { status: number; body: string } = { status: 200, body: JSON.stringify({ ok: true, stored: 1 }) };
const site = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  got.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
  res.writeHead(answer.status, { "content-type": "application/json" });
  res.end(answer.body);
});
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/api/usage`;
process.env.CANVAS_USAGE_URL = siteUrl;
after(() => site.close());

const FACTS = { share: true, improve: false, version: "0.1.0", commit: "ed205ff", os: "15.2", qa: false };

/** A counter in its own folder, its clock set by `at`, a release build unless told otherwise. */
function counter(o: { release?: boolean; arch?: string } = {}) {
  const dir = tmpDir("usage-counts");
  let at = new Date("2026-11-17T12:00:00Z");
  const u = new UsageCounts({ dir: () => dir, now: () => at, release: () => o.release ?? true, arch: o.arch ?? "arm64", debounceMs: 60_000 });
  return { u, dir, set: (iso: string) => { at = new Date(iso); }, stored: () => JSON.parse(fs.readFileSync(path.join(dir, o.release === false ? "usage-dev.json" : "usage.json"), "utf8")) };
}
const reset = (status = 200, body = JSON.stringify({ ok: true, stored: 1 })) => { got.length = 0; answer = { status, body }; };

test("the list of names: every one fits the contract, fewer than 60, unknown names are not counted", () => {
  assert.ok(USAGE_EVENTS.length <= MAX_NAMES);
  for (const n of USAGE_EVENTS) assert.match(n, RE.name, n);
  assert.equal(new Set(USAGE_EVENTS).size, USAGE_EVENTS.length, "no name twice");
  const { u } = counter();
  u.setFacts(FACTS);
  u.count("app.open");
  u.count("file.open");
  u.count("file.open");
  u.count("not.a.thing");
  u.count("/Users/you/Secret.canvas");
  u.count("Export.PNG");
  assert.deepEqual(u.bodyFor("2026-11-17")!.events, { "app.open": 1, "file.open": 2 });
  u.stop();
});

test("names and counts: known names only, whole positive counts, capped at 100000, at most 60 names", () => {
  assert.deepEqual(cleanEvents({ "file.save": 3.7, "file.open": 0, "file.new": -2, "app.open": Number.NaN, "crash": 1, "bogus.name": 4 }), { "file.save": 3, crash: 1 });
  assert.deepEqual(cleanEvents({ "file.save": 5_000_000 }), { "file.save": MAX_COUNT });
  const many: Record<string, number> = {};
  for (let i = 0; i < 80; i++) many[`e.n${String(i).padStart(2, "0")}`] = 1;
  const capped = cleanEvents(many, () => true);
  assert.equal(Object.keys(capped).length, MAX_NAMES);
  assert.deepEqual(cleanEvents({ "Bad Name": 1, "x": 1, "a.b": 1 }, () => true), { "a.b": 1 }, "the contract's name shape holds even for a known name");
  // Counting past the cap stays at the cap.
  const { u } = counter();
  u.setFacts(FACTS);
  for (let i = 0; i < 5; i++) u.count("crash");
  assert.equal(u.bodyFor("2026-11-17")!.events.crash, 5);
  u.stop();
});

test("the body: every field in the contract's shape, nothing else, under 8 KB", () => {
  const { u } = counter({ arch: "x64" });
  u.setFacts({ ...FACTS, improve: true });
  for (const n of USAGE_EVENTS) u.count(n);
  const b = u.bodyFor("2026-11-17")!;
  assert.deepEqual(Object.keys(b), ["v", "build", "os", "arch", "day", "events", "install"]);
  assert.match(b.v, RE.v);
  assert.match(b.build!, RE.build);
  assert.match(b.os!, RE.os);
  assert.equal(b.arch, "x86_64", "Node's x64 is the contract's x86_64");
  assert.match(b.day, RE.day);
  assert.match(b.install!, RE.install);
  assert.equal(Object.keys(b.events).length, USAGE_EVENTS.length);
  for (const [k, n] of Object.entries(b.events)) { assert.match(k, RE.name); assert.ok(Number.isInteger(n) && n > 0 && n <= MAX_COUNT); }
  assert.ok(Buffer.byteLength(JSON.stringify(b)) <= MAX_BYTES);
  // What the shell sends is checked too: a bad version, commit or macOS string is left out, not sent.
  const f = cleanFacts({ share: true, improve: true, version: "0.1 beta", commit: "XYZ", os: "fifteen", qa: "yes" });
  assert.deepEqual(f, { share: true, improve: true, version: null, commit: null, os: null, qa: false });
  assert.equal(cleanFacts({ share: false, improve: true }).improve, false, "improve needs share");
  u.stop();
});

test("days are UTC days: a count at 23:59:59 UTC and one a second past midnight land on two days", () => {
  const { u, set } = counter();
  u.setFacts(FACTS);
  set("2026-11-17T23:59:59Z");
  u.count("file.save");
  set("2026-11-18T00:00:01Z");
  u.count("file.save");
  u.count("file.save");
  assert.equal(utcDay(new Date("2026-11-18T00:30:00+02:00")), "2026-11-17", "a local time after midnight east of UTC is still the day before");
  assert.equal(u.bodyFor("2026-11-17")!.events["file.save"], 1);
  assert.equal(u.bodyFor("2026-11-18")!.events["file.save"], 2);
  u.stop();
});

test("one POST per completed day, oldest first; today waits; a success drops the day", async () => {
  reset();
  const { u, set, stored } = counter();
  u.setFacts(FACTS);
  await u.sendDue();
  set("2026-11-15T10:00:00Z"); u.count("app.open");
  set("2026-11-16T10:00:00Z"); u.count("file.open"); u.count("file.open");
  set("2026-11-17T09:00:00Z"); u.count("crash");
  got.length = 0;
  assert.deepEqual(await u.sendDue(), ["2026-11-15", "2026-11-16"]);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((g) => JSON.parse(g.body).day), ["2026-11-15", "2026-11-16"]);
  assert.deepEqual(JSON.parse(got[1].body).events, { "file.open": 2 });
  // Again the same day, and again an hour later: nothing more goes.
  assert.deepEqual(await u.sendDue(), []);
  set("2026-11-17T10:00:00Z");
  assert.deepEqual(await u.sendDue(), []);
  assert.equal(got.length, 2);
  u.flush();
  assert.deepEqual(Object.keys(stored().days), ["2026-11-17"], "sent days are gone, today stays");
  // Tomorrow, yesterday goes.
  set("2026-11-18T08:00:00Z");
  assert.deepEqual(await u.sendDue(), ["2026-11-17"]);
  u.stop();
});

test("a failure keeps the day's counts and waits until the next day; no retry loop", async () => {
  const { u, set, stored } = counter();
  u.setFacts(FACTS);
  set("2026-11-16T10:00:00Z"); u.count("file.new");
  set("2026-11-17T10:00:00Z");
  for (const [status, body] of [[500, "{}"], [429, "{}"], [400, "{}"], [200, '{"ok":false}'], [200, "not json"]] as const) {
    reset(status, body);
    const v = counter();
    v.u.setFacts(FACTS);
    v.set("2026-11-16T10:00:00Z"); v.u.count("file.new");
    v.set("2026-11-17T10:00:00Z");
    assert.deepEqual(await v.u.sendDue(), [], `${status} ${body} is a failure`);
    assert.deepEqual(await v.u.sendDue(), [], "no second try the same day");
    assert.equal(got.length, 1, `${status}: one request, then it waits`);
    v.u.flush();
    assert.equal(v.stored().lastTry, "2026-11-17");
    assert.deepEqual(v.stored().days["2026-11-16"], { "file.new": 1 }, "the counts stay");
    v.u.stop();
  }
  // Unreachable: the same.
  reset(500);
  site.close();
  try {
    assert.deepEqual(await u.sendDue(), []);
  } finally {
    await new Promise<void>((r) => site.listen(Number(new URL(siteUrl).port), "127.0.0.1", r));
  }
  u.flush();
  assert.equal(stored().lastTry, "2026-11-17");
  // Tomorrow it tries once more, and this time it lands.
  reset();
  set("2026-11-18T07:00:00Z");
  assert.deepEqual(await u.sendDue(), ["2026-11-16"]);
  assert.equal(got.length, 1);
  u.stop();
});

test("the install id: only with Help improve Canvas, the same all month, new the next month, gone when turned off", () => {
  const { u, set, stored } = counter();
  u.setFacts(FACTS);
  u.count("app.open");
  assert.equal(u.bodyFor("2026-11-17")!.install, undefined, "default: no install id");
  u.setFacts({ ...FACTS, improve: true });
  const id = u.bodyFor("2026-11-17")!.install!;
  assert.match(id, RE.install);
  set("2026-11-30T23:00:00Z");
  u.count("app.open");
  assert.equal(u.bodyFor("2026-11-30")!.install, id, "the same id within the month");
  set("2026-12-01T00:00:01Z");
  u.count("app.open");
  const next = u.bodyFor("2026-12-01")!.install!;
  assert.match(next, RE.install);
  assert.notEqual(next, id, "a new calendar month, a new random id");
  u.flush();
  assert.equal(stored().install.month, "2026-12");
  u.setFacts({ ...FACTS, improve: false });
  u.flush();
  assert.equal(stored().install, undefined, "turned off: the id is deleted");
  assert.equal(u.bodyFor("2026-12-01")!.install, undefined);
  u.stop();
});

test("a checkout never sends; it counts into usage-dev.json for Show what's sent", async () => {
  reset();
  assert.equal(runsFromBundle(), false, "this test runs from a checkout");
  assert.equal(runsFromBundle("/Applications/Canvas.app/Contents/Resources/server/src/usage-counts.ts"), true);
  assert.equal(runsFromBundle("/Users/x/Code/canvas/src/usage-counts.ts"), false);
  const dir = tmpDir("usage-checkout");
  let at = new Date("2026-11-16T10:00:00Z");
  const u = new UsageCounts({ dir: () => dir, now: () => at, debounceMs: 60_000 }); // the real release check
  u.setFacts(FACTS);
  u.count("app.open");
  at = new Date("2026-11-17T10:00:00Z");
  assert.equal(u.sends(), false);
  assert.deepEqual(await u.sendDue(), []);
  assert.equal(got.length, 0);
  u.flush();
  assert.ok(fs.existsSync(path.join(dir, "usage-dev.json")));
  assert.ok(!fs.existsSync(path.join(dir, "usage.json")), "a dev build's counts never reach the release's file");
  assert.deepEqual(u.preview().sends, false);
  u.stop();
});

test("a QA build never sends, even from a bundle", async () => {
  reset();
  const { u, set } = counter();
  u.setFacts({ ...FACTS, qa: true });
  set("2026-11-16T10:00:00Z"); u.count("app.open");
  set("2026-11-17T10:00:00Z");
  assert.equal(u.sends(), false);
  assert.deepEqual(await u.sendDue(), []);
  const was = process.env.CANVAS_QA;
  process.env.CANVAS_QA = "1";
  try {
    u.setFacts(FACTS);
    assert.equal(u.sends(), false, "CANVAS_QA=1 (pnpm qa:native's servers) never sends");
  } finally {
    if (was === undefined) delete process.env.CANVAS_QA; else process.env.CANVAS_QA = was;
  }
  assert.equal(got.length, 0);
  u.stop();
});

test("Share usage counts off: nothing counted, nothing kept, nothing sent", async () => {
  reset();
  const { u, dir, set } = counter();
  u.setFacts(FACTS);
  set("2026-11-16T10:00:00Z"); u.count("app.open");
  u.flush();
  assert.ok(fs.existsSync(path.join(dir, "usage.json")));
  u.setFacts({ share: false, improve: true, version: "0.1.0" });
  assert.ok(!fs.existsSync(path.join(dir, "usage.json")), "turning it off deletes what was waiting");
  u.count("file.open");
  set("2026-11-17T10:00:00Z");
  assert.equal(u.sends(), false);
  assert.deepEqual(await u.sendDue(), []);
  assert.equal(u.preview().body, null);
  u.flush();
  assert.ok(!fs.existsSync(path.join(dir, "usage.json")), "nothing written while off");
  // Back on: only what happens from now.
  u.setFacts(FACTS);
  assert.equal(u.bodyFor("2026-11-16"), null);
  assert.deepEqual(u.preview().body!.events, {});
  assert.equal(got.length, 0);
  u.stop();
});

test("before the app says anything, counts wait in memory; the app's answer keeps or drops them", () => {
  const a = counter();
  a.u.count("app.open");
  a.u.count("crash");
  a.u.flush();
  assert.ok(!fs.existsSync(path.join(a.dir, "usage.json")), "no shell, nothing on disk (tests, pnpm qa, a browser)");
  assert.equal(a.u.preview().body, null);
  a.u.setFacts(FACTS);
  assert.deepEqual(a.u.bodyFor("2026-11-17")!.events, { "app.open": 1, crash: 1 });
  a.u.stop();
  const b = counter();
  b.u.count("app.open");
  b.u.setFacts({ share: false });
  b.u.setFacts(FACTS);
  assert.equal(b.u.bodyFor("2026-11-17"), null, "share off dropped them");
  b.u.stop();
});

test("at most 30 unsent days are kept", () => {
  const { u, set, stored } = counter();
  u.setFacts(FACTS);
  for (let i = 0; i < 40; i++) {
    set(new Date(Date.UTC(2026, 9, 1 + i, 12)).toISOString());
    u.count("app.open");
  }
  u.flush();
  const days = Object.keys(stored().days).sort();
  assert.equal(days.length, KEEP_DAYS);
  assert.equal(days.at(-1), "2026-11-09");
  u.stop();
});

test("the request: a POST of JSON with no Origin header (Node's fetch), within 5 s, to CANVAS_USAGE_URL", async () => {
  reset();
  const { u, set } = counter();
  u.setFacts({ ...FACTS, improve: true });
  await u.sendDue(); // the send the first facts start (nothing due yet)
  set("2026-11-16T10:00:00Z"); u.count("export.png");
  set("2026-11-17T10:00:00Z");
  await u.sendDue();
  assert.equal(got.length, 1);
  const r = got[0];
  assert.equal(r.method, "POST");
  assert.equal(r.url, "/api/usage");
  assert.equal(r.headers.origin, undefined, "no Origin header");
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers.cookie, undefined);
  assert.ok(Buffer.byteLength(r.body) <= MAX_BYTES);
  const b = JSON.parse(r.body);
  assert.deepEqual(b.events, { "export.png": 1 });
  assert.match(b.install, RE.install);
  u.stop();
});

test("POST /api/usage/count needs x-canvas and a known name; GET /api/usage/preview answers today's body", async () => {
  const { u } = counter({ release: false });
  u.setFacts(FACTS);
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!(await handleUsageCountsRoute(req, res, url, u))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const post = (body: unknown, headers: Record<string, string> = { "x-canvas": "1" }) => fetch(`${base}/api/usage/count`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ name: "app.open" }, {})).status, 403);
    assert.deepEqual(await (await post({ name: "app.open" })).json(), { ok: true, counted: true });
    assert.deepEqual(await (await post({ name: "secret.file" })).json(), { ok: true, counted: false });
    const p = (await (await fetch(`${base}/api/usage/preview`)).json()) as { body: { events: Record<string, number>; day: string }; sends: boolean; share: boolean };
    assert.deepEqual(p.body.events, { "app.open": 1 });
    assert.equal(p.body.day, "2026-11-17");
    assert.equal(p.sends, false);
    assert.equal(p.share, true);
  } finally {
    srv.close();
    u.stop();
  }
});

test("an MCP client counts once per session, by name: claude, codex or other", async () => {
  process.env.CANVAS_STATE_DIR = tmpDir("usage-state");
  const { usage } = await import("../src/usage-counts.ts");
  const { noteMcp, connectedEvent, resetMcpSeen } = await import("../src/onboarding.ts");
  resetMcpSeen();
  usage.setFacts(FACTS);
  const hello = (session: string, agent?: string) => noteMcp({ headers: { "x-canvas-source": "mcp", "x-canvas-session": session, ...(agent ? { "x-canvas-agent": agent } : {}) } } as unknown as http.IncomingMessage);
  hello("s1", "claude-code");
  hello("s1", "claude-code"); // a heartbeat
  hello("s2", "codex-mcp-client");
  hello("s3");
  hello("run-abc", "claude-code"); // Canvas's own run: not a connection
  const ev = usage.preview().body!.events;
  assert.equal(ev["agent.connected.claude"], 1);
  assert.equal(ev["agent.connected.codex"], 1);
  assert.equal(ev["agent.connected.other"], 1);
  assert.equal(connectedEvent("Cursor"), "agent.connected.other");
  usage.setFacts({ share: false });
  usage.stop();
});

test("the server counts a saved edit as file.save, and the shell's counts through POST /api/usage/count", async () => {
  const dir = tmpDir("usage-server");
  process.env.CANVAS_ROOTS = dir;
  process.env.CANVAS_STATE_DIR = path.join(dir, ".state");
  const file = path.join(dir, "Counted.canvas.json");
  fs.writeFileSync(file, JSON.stringify({ version: "2.11", children: [{ type: "frame", id: "B1", name: "Board", x: 0, y: 0, width: 100, height: 100, children: [] }] }));
  const { usage } = await import("../src/usage-counts.ts");
  const { startServer } = await import("../src/server.ts");
  usage.setFacts(FACTS);
  const server = await startServer(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/api/update", { file, id: "B1", props: { opacity: 0.5 } })).status, 200);
    assert.equal((await post("/api/flush", { file })).status, 200);
    assert.deepEqual(await (await post("/api/usage/count", { name: "app.open" })).json(), { ok: true, counted: true });
    const p = (await (await fetch(`${base}/api/usage/preview`)).json()) as { body: { events: Record<string, number> }; sends: boolean };
    assert.ok(p.body.events["file.save"] >= 1, `file.save: ${JSON.stringify(p.body.events)}`);
    assert.equal(p.body.events["app.open"], 1);
    assert.equal(p.sends, false, "a checkout never sends");
  } finally {
    server.close();
    usage.setFacts({ share: false });
    usage.stop();
  }
});
