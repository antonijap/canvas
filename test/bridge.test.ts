// The bridge: client registry, state, commands and acks, active-client choice, the event log, security.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { after, afterEach, describe, test } from "node:test";
import { FakeClient, getJson, postJson } from "./fake-page.ts";
import { tmpDir, writeDoc } from "./helpers.ts";

const dir = tmpDir("bridge");
process.env.CANVAS_ROOTS = dir;
const docA = writeDoc(dir, "a");
const docB = writeDoc(dir, "b");

const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const open: FakeClient[] = [];
const mk = async (o: ConstructorParameters<typeof FakeClient>[1] = {}) => {
  const c = await new FakeClient(base, o).connect();
  open.push(c);
  return c;
};
afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  await new Promise((r) => setTimeout(r, 40));
});
after(() => {
  for (const f of fs.readdirSync(dir)) fs.unwatchFile(`${dir}/${f}`);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const cmd = (body: Record<string, unknown>) => postJson(base, "/api/bridge/cmd", body);
const wait = (q: string) => getJson(base, `/api/bridge/wait?${q}`);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("registry", () => {
  test("hello carries the boot id; going away is client_down and a command to it is client_gone", async () => {
    const since = (await wait("timeoutMs=0")).body.seq;
    const p = await mk({ file: docA });
    assert.match(p.boot, /^[0-9a-f]{10}$/);
    assert.equal(p.messages[0].role, "page");
    await p.state();
    const st = await getJson(base, "/api/bridge/status");
    assert.equal(st.body.boot, p.boot);
    assert.ok(st.body.pages.some((x: any) => x.client === p.id && x.file === docA));
    p.close();
    const ev = await wait(`since=${since}&types=client_down&timeoutMs=2000`);
    assert.equal(ev.body.events[0].client, p.id);
    const r = await cmd({ op: "deselect", client: p.id });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, "client_gone");
    assert.ok(r.body.boot);
  });

  test("a command waiting on a client that drops fails with client_gone", async () => {
    const p = await mk({ file: docA });
    await p.state();
    p.autoAck = false;
    const pending = cmd({ op: "deselect", client: p.id, timeoutMs: 5000 });
    await p.until(() => p.cmds.length === 1);
    p.close();
    const r = await pending;
    assert.equal(r.body.error.code, "client_gone");
  });

  test("state for a client with no stream is refused", async () => {
    const r = await postJson(base, "/api/state", { client: "p_nobody1", role: "page" });
    assert.equal(r.status, 404);
  });
});

describe("state and selection", () => {
  test("a selection becomes an event and a derived node, with the revision", async () => {
    const p = await mk({ file: docA });
    await p.state();
    const since = (await wait("timeoutMs=0")).body.seq;
    await p.select(["Scr01"], 1);
    const ev = await wait(`since=${since}&types=selection&timeoutMs=2000`);
    assert.equal(ev.body.events.length, 1);
    assert.deepEqual(ev.body.events[0].ids, ["Scr01"]);
    assert.equal(ev.body.events[0].node.node.name, "Screen");
    const st = await getJson(base, `/api/bridge/state?client=${p.id}`);
    const pg = st.body.page;
    assert.equal(pg.selection.nodes[0].node.id, "Scr01");
    assert.match(pg.revision, /^[0-9a-f]{12}$/);
    assert.equal(pg.selection.rendered.width, 10);
    // Same pick again is not a new selection; a new pick is.
    await p.select(["Scr01"], 1);
    await p.select(["Scr01"], 2);
    const ev2 = await wait(`since=${ev.body.next}&types=selection&timeoutMs=500`);
    assert.equal(ev2.body.events.length, 1);
    await p.select([], 3);
    const ev3 = await wait(`since=${ev2.body.next}&types=selection&timeoutMs=500`);
    assert.deepEqual(ev3.body.events[0].ids, []);
  });

  test("a widget selection has no node; an unknown id is marked missing", async () => {
    const p = await mk({ file: docA });
    await p.state();
    await p.select(["widget:w_abc"], 1);
    let st = await getJson(base, `/api/bridge/state?client=${p.id}`);
    assert.equal(st.body.page.selection.nodes[0].widget, "w_abc");
    await p.select(["Nope99"], 2);
    st = await getJson(base, `/api/bridge/state?client=${p.id}`);
    assert.equal(st.body.page.selection.nodes[0].missing, true);
  });

  test("a page showing an older revision is reported stale", async () => {
    const p = await mk({ file: docA });
    await p.state({ docRevision: "000000000000" });
    const st = await getJson(base, `/api/bridge/state?client=${p.id}`);
    assert.equal(st.body.page.stale, true);
  });

  test("file and tabs changes are events", async () => {
    const since = (await wait("timeoutMs=0")).body.seq;
    const p = await mk({ file: docA });
    await p.state();
    p.file = docB;
    await p.state();
    const sh = await mk({ role: "shell", host: "native" });
    await sh.state({ openFiles: [docA] });
    await sh.state({ openFiles: [docA, docB], currentFile: docB });
    const ev = await wait(`since=${since}&types=file,tabs&timeoutMs=1000`);
    assert.ok(ev.body.events.some((e: any) => e.type === "file" && e.file === docB));
    assert.ok(ev.body.events.some((e: any) => e.type === "tabs" && e.currentFile === docB));
    sh.close();
    p.close();
    await nap(50);
  });
});

describe("commands", () => {
  test("round trip: args are cleaned, boards are added, the result comes back", async () => {
    const p = await mk({ file: docA });
    await p.state({ focused: true });
    p.handler = (c) => ({ echoed: c.op, args: c.args });
    const r = await cmd({ op: "select", args: { ids: ["Scr02"], junk: "x" }, client: p.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.client, p.id);
    const got = p.cmds[0];
    assert.equal(got.op, "select");
    assert.deepEqual(got.args, { ids: ["Scr02"], reveal: true, boards: { Scr02: "Scr02" } });
    assert.equal(r.body.result.echoed, "select");
    p.close();
  });

  test("an id that is not in the document is not_found before it reaches the page", async () => {
    const p = await mk({ file: docA });
    await p.state();
    const r = await cmd({ op: "select", args: { ids: ["Zzz99"] }, client: p.id });
    assert.equal(r.status, 404);
    assert.equal(p.cmds.length, 0);
    p.close();
  });

  test("no answer means timeout, and a late ack is refused", async () => {
    const p = await mk({ file: docA });
    await p.state();
    p.autoAck = false;
    const r = await cmd({ op: "deselect", client: p.id, timeoutMs: 500 });
    assert.equal(r.status, 504);
    assert.equal(r.body.error.code, "timeout");
    const late = await p.ack(p.cmds[0].id, true, {});
    assert.equal(late.status, 404);
    p.close();
  });

  test("a failing page op returns its error code", async () => {
    const p = await mk({ file: docA });
    await p.state();
    p.handler = () => {
      throw Object.assign(new Error("not drawn"), { code: "not_found" });
    };
    const r = await cmd({ op: "fit", args: { ids: ["Scr01"] }, client: p.id });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.message, "not drawn");
    p.close();
  });

  test("shell ops need a shell; page ops need a page", async () => {
    // No shell connected in this section.
    const a = await cmd({ op: "tabs" });
    assert.equal(a.body.error.code, "no_shell");
    const sh = await mk({ role: "shell", host: "native" });
    await sh.state();
    sh.handler = (c) => ({ tabs: [], current: null, op: c.op });
    const b = await cmd({ op: "tabs" });
    assert.equal(b.body.ok, true);
    assert.equal((await cmd({ op: "deselect", client: sh.id })).body.error.code, "invalid");
    // The updater's ops (apps/macos/Updater.swift) go to the shell with no arguments; the app itself decides that
    // check and restart run only under the local update test.
    for (const op of ["update.state", "update.check", "update.restart"]) {
      sh.cmds.length = 0;
      const r = await cmd({ op, args: { file: "/etc/passwd" } });
      assert.equal(r.body.ok, true, op);
      assert.deepEqual(sh.cmds.map((c) => [c.op, c.args]), [[op, {}]], op);
    }
    sh.close();
    await nap(50);
  });
});

describe("engine renderer", () => {
  test("the page's renderer shows in status and state", async () => {
    const p = await mk({ file: docA, host: "native" });
    await p.state({ renderer: "engine" });
    const st = await getJson(base, "/api/bridge/status");
    assert.equal(st.body.pages.find((x: any) => x.client === p.id).renderer, "engine");
    await p.state({ renderer: "dom", rendererNote: "GPU device lost" });
    const s2 = await getJson(base, `/api/bridge/state?client=${p.id}`);
    assert.equal(s2.body.page.state.renderer, "dom");
    assert.equal(s2.body.page.state.rendererNote, "GPU device lost");
    p.close();
  });

  test("snapshot: engine pages in the app freeze before the shell's picture and thaw after; others are left alone", async () => {
    const order: string[] = [];
    const eng = await mk({ file: docA, host: "native" });
    await eng.state({ renderer: "engine" });
    eng.handler = (c) => { order.push(`engine:${c.op}`); return c.op === "freeze" ? { frozen: true } : { thawed: true }; };
    const dom = await mk({ file: docA, host: "native" });
    await dom.state({ renderer: "dom" });
    dom.handler = (c) => { order.push(`dom:${c.op}`); return {}; };
    const sh = await mk({ role: "shell", host: "native" });
    await sh.state({ currentFile: docA });
    sh.handler = (c) => { order.push(`shell:${c.op}`); return { mime: "image/png", data: "", width: 1, height: 1, windowVisible: true }; };
    const r = await cmd({ op: "snapshot", args: {} });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.result.mime, "image/png");
    await nap(100);
    assert.deepEqual(order, ["engine:freeze", "shell:snapshot", "engine:thaw"]);
    eng.close(); dom.close(); sh.close();
    await nap(50);
  });

  test("snapshot still answers when an engine page never acks its freeze, and that page is told to thaw anyway", async () => {
    const eng = await mk({ file: docA, host: "native" });
    await eng.state({ renderer: "engine" });
    eng.autoAck = false;
    const sh = await mk({ role: "shell", host: "native" });
    await sh.state({ currentFile: docA });
    sh.handler = () => ({ mime: "image/png", data: "", width: 1, height: 1, windowVisible: true });
    const r = await cmd({ op: "snapshot", args: {} });
    assert.equal(r.body.ok, true);
    assert.equal(eng.cmds[0].op, "freeze");
    await eng.until(() => eng.cmds.length === 2);
    assert.equal(eng.cmds[1].op, "thaw", "a late freeze ack must not leave the copy up");
    eng.close(); sh.close();
    await nap(50);
  });
});

describe("which client is active", () => {
  test("visible beats hidden, focus beats idle, recent input beats older, a named client always wins", async () => {
    const hidden = await mk({ file: docA });
    const idle = await mk({ file: docA });
    const typing = await mk({ file: docA });
    const focused = await mk({ file: docB });
    for (const c of [hidden, idle, typing, focused]) c.handler = () => ({ who: c.id });
    await hidden.state({ visible: false, focused: true, lastInputAt: Date.now() + 5000 });
    await idle.state({ lastInputAt: 1 });
    await typing.state({ lastInputAt: Date.now() });
    const whom = async (body: Record<string, unknown>) => (await cmd({ op: "deselect", ...body })).body.client;
    assert.equal(await whom({}), typing.id);
    await focused.state({ focused: true });
    assert.equal(await whom({}), focused.id);
    assert.equal(await whom({ file: docA }), typing.id, "a file filter limits the choice");
    assert.equal(await whom({ client: idle.id }), idle.id);
    const r = await cmd({ op: "deselect" });
    assert.ok(r.body.others.length >= 3, "others are listed when several pages are open");
    for (const c of [hidden, idle, typing, focused]) c.close();
    await nap(50);
  });

  test("a native page counts as focused when the shell window is", async () => {
    const browser = await mk({ file: docA });
    const native = await mk({ file: docA, host: "native" });
    const shell = await mk({ role: "shell", host: "native" });
    for (const c of [browser, native]) c.handler = () => ({});
    await browser.state({ focused: false, lastInputAt: 100 });
    await native.state({ focused: false, lastInputAt: 1 });
    await shell.state({ windowFocused: false });
    assert.equal((await cmd({ op: "deselect" })).body.client, browser.id);
    await shell.state({ windowFocused: true });
    assert.equal((await cmd({ op: "deselect" })).body.client, native.id);
    for (const c of [browser, native, shell]) c.close();
    await nap(50);
  });

  test("when every page is hidden the newest still answers", async () => {
    const p = await mk({ file: docA });
    p.handler = () => ({});
    await p.state({ visible: false });
    const r = await cmd({ op: "deselect" });
    assert.equal(r.body.client, p.id);
    p.close();
    await nap(50);
  });
});

describe("the event log", () => {
  test("since returns what happened after it; a wait wakes on the next event; timeout returns nothing", async () => {
    const start = (await wait("timeoutMs=0")).body.seq;
    const t0 = Date.now();
    const empty = await wait(`since=${start}&types=selection&timeoutMs=300`);
    assert.equal(empty.body.events.length, 0);
    assert.ok(Date.now() - t0 >= 250);
    const p = await mk({ file: docA });
    await p.state();
    const waiting = wait(`since=${start}&types=selection&timeoutMs=5000`);
    await nap(100);
    await p.select(["Scr01"], 7);
    const got = await waiting;
    assert.equal(got.body.events[0].type, "selection");
    assert.ok(Date.now() - t0 < 3000);
    const again = await wait(`since=0&types=selection&limit=1`);
    assert.equal(again.body.events.length, 1);
    p.close();
    await nap(50);
  });

  test("an edit by the inspector, by mcp, and by someone else are told apart", async () => {
    const f = writeDoc(dir, "edits");
    const since = (await wait("timeoutMs=0")).body.seq;
    const doc = () => JSON.parse(fs.readFileSync(f, "utf8"));
    const revisionOf = async () => (await getJson(base, `/api/summary?file=${encodeURIComponent(f)}`)).body.revision as string;
    const r0 = await revisionOf();
    const a = await postJson(base, "/api/update", { file: f, id: "Scr01", props: { name: "One" } });
    assert.equal(a.status, 200);
    assert.equal(a.body.node.name, "One");
    assert.equal(a.body.node.children, undefined);
    const b = await postJson(base, "/api/update", { file: f, id: "Scr01", props: { name: "Two" } }, { "x-canvas": "1", "x-canvas-source": "mcp" });
    assert.notEqual(b.body.revision, a.body.revision);
    const d = doc();
    d.children[1].name = "Three";
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
    // The file watcher picks the outside change up (polling every 150 ms).
    const ev = await wait(`since=${since}&types=doc,user_edit&timeoutMs=4000&limit=10`);
    let events = ev.body.events;
    for (let i = 0; i < 20 && !events.some((e: any) => e.by === "external"); i++) {
      await nap(200);
      events = (await wait(`since=${since}&types=doc,user_edit&limit=10`)).body.events;
    }
    assert.deepEqual(events.filter((e: any) => e.type === "doc").map((e: any) => e.by), ["inspector", "mcp", "external"]);
    assert.equal(events.filter((e: any) => e.type === "user_edit").length, 1);
    assert.ok(r0);
  });
});

describe("edits", () => {
  test("expectedRevision: a match writes, a stale one is a 409 with code stale_revision and writes nothing", async () => {
    const f = writeDoc(dir, "stale");
    const rev = (await getJson(base, `/api/summary?file=${encodeURIComponent(f)}`)).body.revision;
    const ok = await postJson(base, "/api/update", { file: f, id: "Scr01", props: { name: "Fresh" }, expectedRevision: rev });
    assert.equal(ok.status, 200);
    const before = fs.readFileSync(f, "utf8");
    const stale = await postJson(base, "/api/update", { file: f, id: "Scr01", props: { name: "Late" }, expectedRevision: rev });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "stale_revision");
    assert.equal(fs.readFileSync(f, "utf8"), before);
  });
});

describe("document routes", () => {
  test("summary, find with boards, fonts through the shell", async () => {
    const f = writeDoc(dir, "docs");
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.children[0].children = [{ type: "text", id: "T1", name: "Title", content: "Hello there", fontFamily: "Zork Sans", fontSize: 20, fontWeight: "600", fill: "#000000" }, { type: "text", id: "T2", content: "x", fontFamily: "Helvetica Neue", fontSize: 12, fill: "#000000" }];
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
    const sum = await getJson(base, `/api/summary?file=${encodeURIComponent(f)}`);
    assert.equal(sum.body.boards.length, 2);
    assert.equal(sum.body.counts.byType.text, 2);
    const find = await getJson(base, `/api/find?file=${encodeURIComponent(f)}&text=hello`);
    assert.equal(find.body.results[0].id, "T1");
    assert.equal(find.body.results[0].board, "Scr01");
    const sh = await mk({ role: "shell", host: "native" });
    await sh.state();
    sh.handler = () => ({ families: ["Helvetica Neue", "Inter"] });
    const fonts = await getJson(base, `/api/fonts?file=${encodeURIComponent(f)}`);
    assert.equal(fonts.body.installedSource, "shell");
    const by = Object.fromEntries(fonts.body.fonts.map((x: any) => [x.family, x.status]));
    assert.deepEqual(by, { "Zork Sans": "web", "Helvetica Neue": "installed" });
    sh.close();
    await nap(50);
  });
});

describe("security", () => {
  const raw = (method: string, path: string, headers: Record<string, string>, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on("error", reject);
      r.end(body);
    });

  test("every POST needs x-canvas", async () => {
    for (const path of ["/api/state", "/api/ack", "/api/bridge/cmd"]) {
      const r = await raw("POST", path, { "content-type": "application/json" }, "{}");
      assert.equal(r.status, 403, path);
    }
  });

  test("a foreign Origin or Sec-Fetch-Site: cross-site is refused, a same-origin one is not", async () => {
    const h = { "x-canvas": "1", "content-type": "application/json" };
    assert.equal((await raw("POST", "/api/bridge/cmd", { ...h, origin: "http://evil.example" }, JSON.stringify({ op: "ping" }))).status, 403);
    assert.equal((await raw("POST", "/api/bridge/cmd", { ...h, origin: "http://127.0.0.1:9999" }, JSON.stringify({ op: "ping" }))).status, 403);
    assert.equal((await raw("POST", "/api/bridge/cmd", { ...h, origin: "null" }, JSON.stringify({ op: "ping" }))).status, 403);
    assert.equal((await raw("POST", "/api/bridge/cmd", { ...h, "sec-fetch-site": "cross-site" }, JSON.stringify({ op: "ping" }))).status, 403);
    assert.equal((await raw("GET", "/api/bridge/status", { origin: "http://evil.example" })).status, 403);
    const same = await raw("POST", "/api/bridge/cmd", { ...h, origin: `http://localhost:${port}`, "sec-fetch-site": "same-origin" }, JSON.stringify({ op: "ping" }));
    assert.equal(same.status, 503, "allowed through to the no_shell answer");
  });

  test("the op list is closed and arguments are checked", async () => {
    assert.equal((await cmd({ op: "rm -rf" })).status, 501);
    assert.equal((await cmd({ op: "eval", args: { code: "1" } })).status, 501);
    const p = await mk({ file: docA });
    await p.state();
    assert.equal((await cmd({ op: "highlight", client: p.id, args: { ids: [] } })).status, 400);
    assert.equal((await cmd({ op: "highlight", client: p.id, args: { ids: ["Scr01"], color: "red;background:url(x)" } })).status, 400);
    assert.equal((await cmd({ op: "zoom", client: p.id, args: { percent: 5000 } })).status, 400);
    assert.equal((await cmd({ op: "toast_fallback", client: p.id, args: { message: "x".repeat(201) } })).status, 400);
    assert.equal(p.cmds.length, 0);
    p.close();
  });

  test("open takes only an existing .canvas.json file", async () => {
    const sh = await mk({ role: "shell", host: "native" });
    await sh.state();
    sh.handler = () => ({ opened: true });
    assert.equal((await cmd({ op: "open", args: { file: "/etc/passwd" } })).status, 400);
    assert.equal((await cmd({ op: "open", args: { file: path_(dir, "nope.canvas.json") } })).status, 404);
    const ok = await cmd({ op: "open", args: { file: docA } });
    assert.equal(ok.status, 200);
    assert.equal(sh.cmds[0].args.file, docA);
    sh.close();
    await nap(50);
  });

  test("body limits: 1 MB for state, bigger acks are fine", async () => {
    const p = await mk({ file: docA });
    const big = await p.post("/api/state", { client: p.id, role: "page", pad: "x".repeat(1_100_000) });
    assert.equal(big.status, 413);
    p.autoAck = false;
    const pending = cmd({ op: "deselect", client: p.id, timeoutMs: 5000 });
    await p.until(() => p.cmds.length === 1);
    const ack = await p.ack(p.cmds[0].id, true, { data: "y".repeat(3_000_000) });
    assert.equal(ack.status, 200);
    assert.equal((await pending).body.result.data.length, 3_000_000);
    p.close();
    await nap(50);
  });
});

const path_ = (d: string, f: string) => `${d}/${f}`;
