// The MCP server end to end: a real stdio MCP process talks to an in-process Canvas server, with a
// fake page and fake shell standing in for the browser and the app.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromePath } from "../src/doc/render/chrome-path.ts";
import { FakeClient, getJson, postJson } from "./fake-page.ts";
import { freePort, tmpDir } from "./helpers.ts";
import { buildLink } from "../src/page/link-logic.js";

const dir = tmpDir("mcp");
process.env.CANVAS_ROOTS = dir;
const FIXTURE = {
  version: "2.21",
  children: [
    {
      type: "frame", id: "Scr01", name: "Screen", x: 0, y: 0, width: 390, height: 844, layout: "vertical", fill: "#FFFFFF",
      children: [
        { type: "text", id: "Ttl01", name: "Title", content: "Hello world", fontFamily: "Inter", fontSize: 24, fontWeight: "700", fill: "#111111" },
        { type: "text", id: "Sub01", name: "Subtitle", content: "Hello again", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#444444" },
      ],
    },
    { type: "frame", id: "Scr02", name: "Wide", x: 500, y: 100, width: 600, height: 300, fill: "#EEEEEE", children: [] },
  ],
};
const docFile = path.join(dir, "demo.canvas.json");
fs.writeFileSync(docFile, JSON.stringify(FIXTURE, null, 2));
const file = fs.realpathSync(docFile);

const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// The version the in-process server reports, fixed at its start. The MCP child compares against this
// instead of hashing src/ again at call time, which differs whenever a file under src/ changes mid-run.
const serverVersion = ((await (await fetch(`${base}/health`)).json()) as { version: string }).version;

const mcps: Client[] = [];
async function connect(at = port, wantVersion = serverVersion): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(import.meta.dirname, "../mcp/server.ts")],
    env: { ...(process.env as Record<string, string>), CANVAS_PORT: String(at), CANVAS_MCP_NO_SPAWN: "1", CANVAS_MCP_NO_APP: "1", CANVAS_MCP_WANT_VERSION: wantVersion },
    stderr: "pipe",
  });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  mcps.push(c);
  return c;
}
const client = await connect();

type Out = { isError: boolean; text: string; json: any; content: any[] };
async function call(name: string, args: Record<string, unknown> = {}, c = client, opts?: any): Promise<Out> {
  const r: any = await c.callTool({ name, arguments: args }, undefined, opts);
  const text = r.content.find((x: any) => x.type === "text")?.text ?? "";
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: r.isError === true, text, json, content: r.content };
}

const fakes: FakeClient[] = [];
const page = async (o: ConstructorParameters<typeof FakeClient>[1] = {}) => {
  const p = await new FakeClient(base, { file, ...o }).connect();
  fakes.push(p);
  return p;
};
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(async () => {
  for (const f of fakes.splice(0)) f.close();
  await nap(40);
});
after(async () => {
  for (const c of mcps) await c.close();
  fs.unwatchFile(file);
  for (const f of fs.readdirSync(dir)) fs.unwatchFile(path.join(dir, f));
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const TOOLS = [
  "canvas_status", "launch_canvas", "list_tabs", "open_file", "close_tab", "get_current_file", "get_theme", "set_theme",
  "get_document_summary", "get_fonts", "list_installed_fonts", "lookup_nodes", "inspect_node",
  "get_selection", "select_nodes", "clear_selection", "wait_for_selection", "highlight_nodes", "clear_highlights", "get_events",
  "get_viewport", "fit_view", "set_zoom", "pan_view", "screenshot_view", "render_node", "export_nodes", "set_node_props", "move_board", "scale_nodes", "undo", "redo",
  "swap_instance", "reset_overrides", "push_overrides",
  "add_nodes", "delete_nodes", "duplicate_nodes", "group_nodes", "ungroup_nodes", "reorder_nodes",
  "add_auto_layout", "remove_auto_layout", "place_nodes",
  "list_widgets", "list_widget_kinds", "add_widget", "update_widget", "remove_widget", "widget_action", "refresh_widget", "reveal_widget",
  "list_shaders", "list_shader_presets", "create_shader", "update_shader", "export_shader",
  "list_videos", "add_video", "video_frame",
  "notify_user", "finish_work",
  "list_pages", "create_page", "rename_page", "delete_page", "move_boards_to_page", "set_active_page",
  "make_variations", "list_variations", "keep_variation", "discard_variations", "get_product_brief", "set_product_brief", "get_design_context", "check_variation", "mark_variation",
  "resolve_link",
  "list_comments", "add_comment", "reply_comment", "resolve_comment",
];

describe("tools", () => {
  test("listTools: every tool is there with a description and an object schema", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort());
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 20, t.name);
      assert.equal(t.inputSchema.type, "object", t.name);
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(by.set_node_props.inputSchema.required, ["props"]);
    assert.ok("expectedRevision" in (by.set_node_props.inputSchema.properties as object));
    assert.equal((by.wait_for_selection.inputSchema.properties as any).timeoutMs.maximum, 55000);
    // ids may come from a canvas:// link instead (mcp/link.ts): the schema leaves it optional, the tool still asks.
    assert.deepEqual(by.highlight_nodes.inputSchema.required ?? [], []);
    for (const n of ["select_nodes", "inspect_node", "lookup_nodes", "render_node", "fit_view", "get_design_context"]) assert.ok("link" in (by[n].inputSchema.properties as object), `${n} takes link`);
    assert.ok(!tools.some((t) => /trust|secret|visibility/i.test(t.name)), "no trust, secret or visibility tools");
  });

  test("the instructions and the canvas://state resource are served", async () => {
    assert.match(client.getInstructions() ?? "", /get_selection/);
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "canvas://state"));
    const r: any = await client.readResource({ uri: "canvas://state" });
    assert.equal(JSON.parse(r.contents[0].text).server.running, true);
  });
});

describe("errors", () => {
  test("no_server when nothing answers and spawning is off", async () => {
    const lonely = await connect(await freePort());
    const r = await call("get_document_summary", { file }, lonely);
    assert.equal(r.isError, true);
    assert.match(r.text, /^no_server: /);
    const st = await call("canvas_status", {}, lonely);
    assert.equal(st.json.server.running, false);
  });

  test("no_page when no canvas page is open, no_shell without the app", async () => {
    const a = await call("get_selection");
    assert.match(a.text, /^no_page: /);
    const b = await call("select_nodes", { ids: ["Scr01"] });
    assert.match(b.text, /^no_page: /);
    const c = await call("set_theme", { mode: "dark" });
    assert.match(c.text, /^no_shell: /);
    const d = await call("screenshot_view");
    assert.match(d.text, /^unsupported: /);
  });
});

describe("disk tools", () => {
  test("summary, lookup, inspect, fonts work with no page open", async () => {
    const s = await call("get_document_summary", { file });
    assert.equal(s.json.boards.length, 2);
    assert.equal(s.json.fonts[0].family, "Inter");
    const l = await call("lookup_nodes", { file, text: "hello" });
    assert.equal(l.json.total, 2);
    assert.equal(l.json.results[0].board, "Scr01");
    const l2 = await call("lookup_nodes", { file, text: "hello", rendered: true });
    assert.match(l2.json.note, /No rendered sizes/);
    const i = await call("inspect_node", { file, id: "Ttl01" });
    assert.equal(i.json.node.name, "Title");
    assert.equal(i.json.parentId, "Scr01");
    const miss = await call("inspect_node", { file, id: "Nope" });
    assert.match(miss.text, /^not_found: /);
    const f = await call("get_fonts", { file });
    assert.equal(f.json.fonts[0].family, "Inter");
    const f2 = await call("get_fonts", { file, onlyMissing: true });
    assert.ok(f2.json.fonts.every((x: any) => x.status === "web" || x.status === "missing"));
  });

  test("render_node draws a board (skipped without a Chromium)", { skip: (() => { try { chromePath(); return false; } catch { return "no Chromium-family browser"; } })() }, async () => {
    const r = await call("render_node", { file, id: "Scr02", maxSide: 400 });
    assert.equal(r.isError, false, r.text);
    const img = r.content.find((x: any) => x.type === "image");
    assert.equal(img.mimeType, "image/png");
    assert.ok(Buffer.from(img.data, "base64").subarray(1, 4).toString() === "PNG");
    const bad = await call("render_node", { file, id: "Nope" });
    assert.match(bad.text, /^not_found: /);
  });

  test("export_nodes writes a PNG at a scale, a store preset and an SVG (skipped without a Chromium)", { skip: (() => { try { chromePath(); return false; } catch { return "no Chromium-family browser"; } })() }, async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-export-"));
    try {
      const png = await call("export_nodes", { file, ids: ["Scr02"], scale: 2, path: out });
      assert.equal(png.isError, false, png.text);
      const f = png.json.files[0];
      assert.equal(path.dirname(f.path), out);
      assert.match(path.basename(f.path), /@2x\.png$/);
      const head = fs.readFileSync(f.path);
      assert.deepEqual([head.readUInt32BE(16), head.readUInt32BE(20)], [f.width, f.height]);
      const store = await call("export_nodes", { file, ids: ["Scr02"], preset: "play", path: path.join(out, "store.png") });
      assert.equal(store.isError, false, store.text);
      const s = fs.readFileSync(path.join(out, "store.png"));
      assert.deepEqual([s.readUInt32BE(16), s.readUInt32BE(20), s[25]], [1080, 1920, 2], "exact size, RGB without alpha");
      const svg = await call("export_nodes", { file, ids: ["Scr01", "Scr02"], format: "svg", path: out });
      assert.equal(svg.isError, false, svg.text);
      assert.equal(svg.json.files.length, 2);
      assert.match(fs.readFileSync(svg.json.files[0].path, "utf8"), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.match((await call("export_nodes", { file, ids: ["Nope"], path: out })).text, /^not_found: /);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("selection and camera through a page", () => {
  test("get_selection returns ids, node JSON and the revision", async () => {
    const p = await page();
    await p.state({ focused: true });
    assert.match((await call("get_selection")).json.note, /Nothing is selected/);
    await p.select(["Ttl01"], 1);
    const r = await call("get_selection");
    assert.deepEqual(r.json.selected, ["Ttl01"]);
    assert.equal(r.json.nodes[0].node.content, "Hello world");
    assert.match(r.json.revision, /^[0-9a-f]{12}$/);
    const lean = await call("get_selection", { includeNode: false });
    assert.equal(lean.json.nodes, undefined);
  });

  test("select_nodes sends select with the board, by id and by name; ambiguity lists candidates", async () => {
    const p = await page();
    await p.state({ focused: true });
    p.handler = async (c) => {
      if (c.op === "select") await p.select(c.args.ids, 9, undefined, "mcp");
      return { selected: c.args.ids, rendered: null };
    };
    const a = await call("select_nodes", { ids: ["Sub01"] });
    assert.equal(a.isError, false, a.text);
    assert.deepEqual(p.cmds[0].args, { ids: ["Sub01"], reveal: true, boards: { Sub01: "Scr01" } });
    assert.deepEqual(a.json.selected, ["Sub01"]);
    const b = await call("select_nodes", { name: "Subtitle", reveal: false });
    assert.equal(p.cmds[1].args.ids[0], "Sub01");
    assert.equal(p.cmds[1].args.reveal, false);
    assert.equal(b.isError, false);
    const amb = await call("select_nodes", { text: "hello" });
    assert.match(amb.text, /^ambiguous: .*Ttl01.*Sub01/);
    const many = await call("select_nodes", { ids: ["Ttl01", "Sub01"] });
    assert.equal(many.isError, false, many.text);
    assert.deepEqual(p.cmds.at(-1)!.args.ids, ["Ttl01", "Sub01"]);
  });

  test("wait_for_selection returns the person's click, ignores the agent's own, and reports progress", async () => {
    const p = await page();
    await p.state({ focused: true });
    p.handler = () => ({});
    let progressed = 0;
    const waiting = call("wait_for_selection", { timeoutMs: 8000, prompt: "Click the title" }, client, { onprogress: () => progressed++ });
    await nap(300);
    await p.select(["Sub01"], 1, undefined, "mcp");
    await nap(100);
    await p.select(["Ttl01"], 2, undefined, "user");
    const r = await waiting;
    assert.equal(r.json.timedOut, false);
    assert.deepEqual(r.json.selected, ["Ttl01"]);
    assert.ok(r.json.sinceSeq > 0);
    assert.ok(progressed >= 1, "progress notifications arrive");
    const ops = p.cmds.map((c) => `${c.op}:${c.args.clear ? "clear" : "show"}`);
    assert.deepEqual(ops, ["toast_fallback:show", "toast_fallback:clear"]);
    assert.equal(p.cmds[0].args.message, "Click the title");
    assert.equal(p.cmds[0].args.durationMs, 0);
  });

  test("wait_for_selection: an existing selection counts unless ignoreCurrent; a timeout returns a cursor", async () => {
    const p = await page();
    await p.state({ focused: true });
    await p.select(["Ttl01"], 1);
    const now = await call("wait_for_selection", { timeoutMs: 1000 });
    assert.equal(now.json.immediate, true);
    const t0 = Date.now();
    const none = await call("wait_for_selection", { timeoutMs: 500, ignoreCurrent: true });
    assert.equal(none.json.timedOut, true);
    assert.ok(Date.now() - t0 >= 450);
    assert.ok(typeof none.json.sinceSeq === "number");
    // Clicking after the timeout is caught by passing the cursor back.
    await p.select(["Sub01"], 2);
    const again = await call("wait_for_selection", { timeoutMs: 1000, sinceSeq: none.json.sinceSeq });
    assert.deepEqual(again.json.selected, ["Sub01"]);
  });

  test("camera tools send the right ops", async () => {
    const p = await page();
    await p.state({ focused: true });
    p.handler = (c) => (c.op === "measure" ? { nodes: [], viewport: { zoomPercent: 100, boardsInView: [] } } : { ok: true, op: c.op });
    assert.equal((await call("get_viewport")).json.zoomPercent, 100);
    await call("fit_view", { ids: ["Scr02"], padding: 20 });
    await call("fit_view");
    await call("set_zoom", { percent: 50, anchor: "selection" });
    await call("pan_view", { by: { dx: 10, dy: -5 }, space: "screen" });
    await call("pan_view", { nodeId: "Ttl01" });
    await call("highlight_nodes", { ids: ["Ttl01", "Sub01"], style: "outline", label: "look" });
    await call("clear_highlights");
    await call("clear_selection");
    const ops = p.cmds.map((c) => c.op);
    assert.deepEqual(ops, ["measure", "fit", "fit", "zoom", "pan", "pan", "highlight", "clear_highlights", "deselect"]);
    assert.deepEqual(p.cmds[1].args, { ids: ["Scr02"], padding: 20, maxZoomPercent: 400, boards: { Scr02: "Scr02" } });
    assert.equal(p.cmds[2].args.ids, undefined);
    assert.equal(p.cmds[3].args.anchor, "selection");
    assert.deepEqual(p.cmds[4].args.by, { dx: 10, dy: -5 });
    assert.equal(p.cmds[6].args.label, "look");
    assert.deepEqual(p.cmds[6].args.boards, { Ttl01: "Scr01", Sub01: "Scr01" });
    const bad = await call("highlight_nodes", { ids: [] });
    assert.equal(bad.isError, true);
  });

  test("notify_user goes to the page when there is no app, to the app when there is", async () => {
    const p = await page();
    await p.state({ focused: true });
    p.handler = () => ({ shown: true });
    assert.equal((await call("notify_user", { message: "Done" })).json.via, "page");
    assert.equal(p.cmds[0].op, "toast_fallback");
    const sh = await page({ role: "shell", host: "native", file: undefined });
    await sh.state();
    sh.handler = () => ({ shown: true });
    assert.equal((await call("notify_user", { message: "Done", level: "success" })).json.via, "app");
    assert.equal(sh.cmds[0].op, "toast");
    assert.equal(sh.cmds[0].args.level, "success");
  });
});

describe("the app through a fake shell", () => {
  test("tabs, theme, snapshot, current file, open_file with a board", async () => {
    const sh = await page({ role: "shell", host: "native", file: undefined });
    sh.handler = (c) => {
      if (c.op === "tabs") return { tabs: [{ file, name: "demo", current: true }], current: file };
      if (c.op === "theme.get") return { mode: "system", effective: "dark" };
      if (c.op === "theme.set") return { mode: c.args.mode, effective: c.args.mode };
      if (c.op === "snapshot") return { mime: "image/jpeg", data: Buffer.from("fakejpeg").toString("base64"), width: 100, height: 50, windowVisible: false };
      if (c.op === "open") return { file: c.args.file, opened: false, current: c.args.file };
      return {};
    };
    await sh.state({ openFiles: [file], currentFile: file });
    assert.equal((await call("list_tabs")).json.tabs[0].name, "demo");
    assert.equal((await call("get_current_file")).json.file, file);
    assert.equal((await call("get_theme")).json.effective, "dark");
    assert.equal((await call("set_theme", { mode: "light" })).json.mode, "light");
    const shot = await call("screenshot_view", { format: "jpeg", maxSide: 800 });
    assert.equal(shot.content[0].type, "image");
    assert.equal(shot.content[0].mimeType, "image/jpeg");
    assert.equal(JSON.parse(shot.content[1].text).windowVisible, false);
    assert.deepEqual(sh.cmds.find((c) => c.op === "snapshot")!.args, { maxSide: 800, format: "jpeg" });
    // hunt-1 MCP #4: a browser tab on the same file, connected first, is not the app's page.
    const browser = await page();
    await browser.state({ focused: true, host: "browser" });
    browser.handler = (c) => ({ op: c.op, board: c.args.board });
    const p = await page({ host: "native" });
    await p.state({ focused: true, host: "native" });
    p.handler = (c) => ({ op: c.op, board: c.args.board });
    const o = await call("open_file", { file, board: "Scr02" });
    assert.equal(o.isError, false, o.text);
    assert.equal(o.json.client, p.id);
    assert.equal(sh.cmds.find((c) => c.op === "open")!.args.file, file);
    assert.equal(p.cmds.find((c) => c.op === "navigate")!.args.board, "Scr02");
    assert.ok(!browser.cmds.some((c) => c.op === "navigate"));
    assert.match((await call("open_file", { file: "/etc/passwd" })).text, /^invalid: /);
  });

  test("open_file on a .canvas package waits for the page that shows the package, not its inner file", async () => {
    const pkg = path.join(dir, "Pkg.canvas");
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "document.json"), JSON.stringify(FIXTURE, null, 2));
    const pkgReal = fs.realpathSync(pkg);
    const sh = await page({ role: "shell", host: "native", file: undefined });
    sh.handler = (c) => (c.op === "open" ? { file: c.args.file, opened: true, current: c.args.file } : {});
    await sh.state({ openFiles: [pkgReal], currentFile: pkgReal });
    const p = await page({ host: "native", file: pkgReal });
    await p.state({ focused: true, host: "native" });
    p.handler = (c) => ({ op: c.op, board: c.args.board });
    const o = await call("open_file", { file: pkg, board: "Scr02", waitMs: 2000 });
    assert.equal(o.isError, false, o.text);
    assert.equal(o.json.opened, pkgReal);
    assert.equal(o.json.client, p.id);
    assert.equal(p.cmds.find((c) => c.op === "navigate")!.args.board, "Scr02");
    fs.unwatchFile(path.join(pkgReal, "document.json"));
  });

  test("launch_canvas in server mode reuses the running server", async () => {
    const r = await call("launch_canvas", { mode: "server", file });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.mode, "server");
    assert.equal(r.json.server.started, false);
    assert.equal(r.json.server.stale, false);
    const st = await call("canvas_status");
    assert.equal(st.json.server.running, true);
    assert.equal(st.json.server.stale, false);
    assert.equal(st.json.server.version, serverVersion);
  });

  test("a server whose version differs from the wanted one is reported stale", async () => {
    const other = await connect(port, "000000000000");
    const r = await call("launch_canvas", { mode: "server", file }, other);
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.server.stale, true);
    assert.equal((await call("canvas_status", {}, other)).json.server.stale, true);
  });
});

describe("edits", () => {
  test("set_node_props writes through the inspector's path; a stale revision is refused", async () => {
    const p = await page();
    await p.state({ focused: true });
    await p.select(["Ttl01"], 1);
    const sel = await call("get_selection");
    const ok = await call("set_node_props", { id: "Ttl01", props: { content: "Changed" }, expectedRevision: sel.json.revision });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).children[0].children[0].content, "Changed");
    assert.notEqual(ok.json.revision, sel.json.revision);
    const stale = await call("set_node_props", { props: { content: "Late" }, expectedRevision: sel.json.revision });
    assert.match(stale.text, /^stale_revision: /);
    assert.match(stale.text, /Hint: /);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).children[0].children[0].content, "Changed");
    // With no id it edits the selection, and the doc event says mcp did it.
    const since = (await getJson(base, "/api/bridge/wait?timeoutMs=0")).body.seq;
    const sel2 = await call("get_selection");
    const again = await call("set_node_props", { props: { fill: "#FF0000" }, remove: [], expectedRevision: sel2.json.revision });
    assert.equal(again.isError, false, again.text);
    const ev = await getJson(base, `/api/bridge/wait?since=${since}&types=doc,user_edit&timeoutMs=1000`);
    assert.equal(ev.body.events[0].by, "mcp");
    assert.ok(!ev.body.events.some((e: any) => e.type === "user_edit"));
    const bad = await call("set_node_props", { id: "Ttl01", props: { type: "frame" } });
    assert.equal(bad.isError, true);
  });

  test("undo/redo: the session's edits are one step until finish_work, named by its summary", async () => {
    const content = () => JSON.parse(fs.readFileSync(file, "utf8")).children[0].children[0].content;
    await call("finish_work", { file, sound: false }); // closes the step the test above left open
    const was = content();
    assert.equal((await call("set_node_props", { file, id: "Ttl01", props: { content: "Step one" } })).isError, false);
    assert.equal((await call("set_node_props", { file, id: "Ttl01", props: { content: "Step two" } })).isError, false);
    await call("finish_work", { file, summary: "Retitled", sound: false });
    const u = await call("undo", { file });
    assert.equal(u.isError, false, u.text);
    assert.equal(u.json.undid, "Agent: Retitled");
    assert.equal(content(), was);
    const r = await call("redo", { file });
    assert.equal(r.json.redid, "Agent: Retitled");
    assert.equal(content(), "Step two");
    const empty = await call("redo", { file });
    assert.match(empty.text, /^empty: Nothing to redo/);
  });
});

describe("structure", () => {
  test("duplicate, group, reorder, ungroup and delete through Canvas; one agent step undoes them all", async () => {
    await call("finish_work", { file, sound: false });
    const before = fs.readFileSync(file, "utf8");
    const d = await call("duplicate_nodes", { file, ids: ["Sub01"] });
    assert.equal(d.isError, false, d.text);
    const copy = d.json.select[0];
    const g = await call("group_nodes", { file, ids: ["Sub01", copy], frame: true });
    assert.equal(g.isError, false, g.text);
    assert.equal((await call("reorder_nodes", { file, ids: [g.json.select[0]], dir: "back" })).isError, false);
    assert.equal((await call("ungroup_nodes", { file, ids: g.json.select })).isError, false);
    const del = await call("delete_nodes", { file, ids: [copy] });
    assert.equal(del.isError, false, del.text);
    assert.match((await call("delete_nodes", { file, ids: ["Nope"] })).text, /^not_found: /);
    await call("finish_work", { file, summary: "Shuffled", sound: false });
    assert.equal((await call("undo", { file })).json.undid, "Agent: Shuffled");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(before));
  });
});

describe("add_nodes", () => {
  test("adds a board with layers, keeps the ids given; one agent step undoes it", async () => {
    await call("finish_work", { file, sound: false });
    const before = fs.readFileSync(file, "utf8");
    const r = await call("add_nodes", { file, nodes: [{ type: "frame", id: "Idea01", name: "Idea", x: 5000, y: 0, width: 300, height: 200, layout: "vertical", children: [
      { type: "text", id: "IdeaT1", content: "Pitch", fontFamily: "Inter", fontSize: 20, fontWeight: "600", fill: "#111111" },
    ] }] });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.select, ["Idea01"]);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const board = doc.children.find((n: any) => n.id === "Idea01");
    assert.equal(board.children[0].id, "IdeaT1");
    assert.match((await call("add_nodes", { file, nodes: [{ type: "nope" }] })).text, /^invalid: /);
    await call("finish_work", { file, summary: "Idea", sound: false });
    assert.equal((await call("undo", { file })).json.undid, "Agent: Idea");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(before));
  });
});

describe("auto layout", () => {
  test("place_nodes reorders, remove_auto_layout keeps layers where the page draws them, add_auto_layout infers; one agent step", async () => {
    await call("finish_work", { file, sound: false });
    const before = fs.readFileSync(file, "utf8");
    const screen = () => JSON.parse(fs.readFileSync(file, "utf8")).children[0];
    const placed = await call("place_nodes", { file, ids: ["Sub01"], parent: "Scr01", index: 0 });
    assert.equal(placed.isError, false, placed.text);
    assert.equal(placed.json.done, "Reorder");
    assert.deepEqual(screen().children.map((c: any) => c.id), ["Sub01", "Ttl01"]);
    // A page that shows the file answers measure: the layers keep the place it draws them at.
    const p = await page();
    await p.state({ focused: true });
    const world: Record<string, { x: number; y: number; w: number; h: number }> = { Scr01: { x: 0, y: 0, w: 390, h: 844 }, Sub01: { x: 0, y: 0, w: 80, h: 17 }, Ttl01: { x: 0, y: 30, w: 130, h: 29 } };
    p.handler = (c) => (c.op === "measure" ? { nodes: c.args.ids.map((id: string) => (world[id] ? { id, drawn: true, world: world[id] } : { id, drawn: false })) } : {});
    const removed = await call("remove_auto_layout", { file, ids: ["Scr01"] });
    assert.equal(removed.isError, false, removed.text);
    assert.ok(p.cmds.some((c) => c.op === "measure" && c.args.ids.includes("Ttl01")), "children were measured");
    assert.equal(screen().layout, "none");
    const t = screen().children.find((c: any) => c.id === "Ttl01");
    assert.deepEqual([t.x, t.y], [0, 30]);
    const added = await call("add_auto_layout", { file, ids: ["Scr01"] });
    assert.equal(added.isError, false, added.text);
    assert.equal(screen().layout, "vertical");
    assert.deepEqual(screen().children.map((c: any) => [c.id, c.x]), [["Sub01", undefined], ["Ttl01", undefined]]);
    assert.match((await call("place_nodes", { file, ids: ["Ttl01"], parent: "Ttl01", index: 0 })).text, /^invalid: /);
    await call("finish_work", { file, summary: "Laid out", sound: false });
    assert.equal((await call("undo", { file })).json.undid, "Agent: Laid out");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(before));
  });
});

describe("shaders", () => {
  test("create, update and list: source in a file, revision in the widget, compile check needs a page", async () => {
    const src = "fn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(p / u.resolution, 0.5, 1.0); }\n";
    const made = await call("create_shader", { file, source: src, name: "Glow", x: 0, y: 3000, w: 320, h: 180 });
    assert.equal(made.isError, false, made.text);
    assert.equal(made.json.compiled, false, "no page answers shader_frame: not compiled");
    assert.equal(made.json.widget.kind, "shader");
    assert.match(made.json.rev, /^[0-9a-f]{12}$/);
    const id = made.json.id;
    const bad = await call("update_shader", { file, id, source: "@compute @workgroup_size(1) fn main() {}\n" });
    assert.equal(bad.isError, false, bad.text);
    assert.ok(bad.json.problems.some((p: any) => p.line === 1 && /compute/.test(p.message)), bad.text);
    assert.ok(bad.json.problems.some((p: any) => /fn shade/.test(p.message)), bad.text);
    const list = await call("list_shaders", { file });
    const s = list.json.shaders.find((x: any) => x.id === id);
    assert.equal(s.rev, bad.json.rev);
    assert.ok(s.problems.length >= 2);
    assert.match((await call("update_shader", { file, id: "nope", name: "x" })).text, /^not_found: /);
    assert.equal((await call("remove_widget", { file, id })).isError, false);
  });

  test("Paper presets: list, create from a preset with params, change params, export", async () => {
    const lib = await call("list_shader_presets", {});
    assert.equal(lib.isError, false, lib.text);
    assert.ok(lib.json.shaders.some((s: any) => s.id === "mesh-gradient"));
    const one = await call("list_shader_presets", { id: "warp" });
    assert.ok(one.json.presets.length >= 2);
    const made = await call("create_shader", { file, preset: "grain-gradient/Wave", params: { softness: 0.2 }, x: 0, y: 3400, w: 320, h: 180 });
    assert.equal(made.isError, false, made.text);
    assert.equal(made.json.widget.config.paper.params.shape, "wave");
    assert.equal(made.json.widget.config.paper.params.softness, 0.2);
    const id = made.json.id;
    const up = await call("update_shader", { file, id, params: { intensity: 0.9 } });
    assert.equal(up.isError, false, up.text);
    assert.equal(up.json.widget.config.paper.params.intensity, 0.9);
    const ex = await call("export_shader", { file, id, format: "html" });
    assert.match(ex.json.code, /grainGradientFragmentShader/);
    assert.match((await call("create_shader", { file })).text, /source.*preset/);
    assert.equal((await call("remove_widget", { file, id })).isError, false);
  });
});

describe("widgets", () => {
  test("add, act on, update (deep merge), refresh, remove", async () => {
    const kinds = await call("list_widget_kinds");
    assert.ok(kinds.json.some((k: any) => k.id === "todo"));
    const add = await call("add_widget", { file, kind: "todo", name: "Tasks", config: { title: "Ship it" }, nearNodeId: "Scr02" });
    assert.equal(add.isError, false, add.text);
    const w = add.json.widget;
    assert.equal(w.config.title, "Ship it");
    assert.equal(w.x, 500 + 600 + 40);
    assert.equal(w.y, 100);
    const act = await call("widget_action", { file, id: w.id, action: "addItem", args: { text: "write tests" } });
    assert.equal(act.json.widget.config.items[0].text, "write tests");
    const itemId = act.json.result.id;
    await call("widget_action", { file, id: w.id, action: "toggleItem", args: { id: itemId, done: true } });
    const upd = await call("update_widget", { file, id: w.id, patch: { config: { title: "Renamed" }, w: 400 } });
    assert.equal(upd.json.widget.config.title, "Renamed");
    assert.equal(upd.json.widget.config.items[0].done, true, "deep merge keeps what the patch does not mention");
    assert.equal(upd.json.widget.w, 400);
    const list = await call("list_widgets", { file });
    assert.equal(list.json.widgets.length, 1);
    assert.match((await call("refresh_widget", { file, id: w.id })).text, /^unsupported: /);
    assert.match((await call("widget_action", { file, id: w.id, action: "nope" })).text, /^not_found: /);
    assert.match((await call("add_widget", { file, kind: "bogus" })).text, /^invalid: /);
    assert.match((await call("remove_widget", { file, id: "missing" })).text, /^not_found: /);
    assert.equal((await call("remove_widget", { file, id: w.id })).isError, false);
    assert.equal((await call("list_widgets", { file })).json.widgets.length, 0);
  });

  test("reveal_widget fits and selects through the page", async () => {
    const add = await call("add_widget", { file, kind: "note", x: 0, y: 1000 });
    const id = add.json.widget.id;
    const p = await page();
    await p.state({ focused: true });
    p.handler = (c) => ({ op: c.op });
    const r = await call("reveal_widget", { file, id });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(p.cmds.map((c) => c.op), ["fit", "select"]);
    assert.deepEqual(p.cmds[0].args.ids, [`widget:${id}`]);
    await call("remove_widget", { file, id });
  });
});

describe("finish_work", () => {
  const edit = (id: string, content: string) => call("set_node_props", { file, id, props: { content } });
  const drain = async () => {
    const p = await page();
    await p.state({ focused: true });
    p.handler = () => ({});
    await call("finish_work", { sound: false, file });
    p.close();
    await nap(60);
  };

  test("glosses what the MCP changed, toasts, plays the page chime without a shell, then forgets", async () => {
    await drain();
    await edit("Ttl01", "One");
    await edit("Sub01", "Two");
    // An edit from the inspector (no mcp header) is not the agent's.
    await postJson(base, "/api/update", { file, id: "Scr02", props: { name: "Inspector" } });
    const p = await page();
    await p.state({ focused: true });
    p.handler = (c) => (c.op === "gloss" ? { glossed: c.args.ids, revealed: false } : { shown: true });
    const r = await call("finish_work", { summary: "Tightened the header" });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.glossed.sort(), ["Sub01", "Ttl01"]);
    assert.equal(r.json.trackedCount, 2);
    assert.equal(r.json.toast, true);
    assert.equal(r.json.sound, "page");
    const g = p.cmds.find((c) => c.op === "gloss")!;
    assert.equal(g.args.chime, true);
    assert.equal(g.args.reveal, true);
    assert.deepEqual(g.args.boards, { Ttl01: "Scr01", Sub01: "Scr01" });
    const t = p.cmds.find((c) => c.op === "toast_fallback")!;
    assert.equal(t.args.message, "Done: Tightened the header");
    assert.equal(t.args.level, "success");
    // The set is cleared: a second call has nothing to gloss.
    const again = await call("finish_work", {});
    assert.deepEqual(again.json.glossed, []);
    assert.equal(again.json.trackedCount, 0);
    assert.equal(p.cmds.filter((c) => c.op === "gloss").length, 1);
  });

  test("with the app connected the sound goes to the shell and the page does not chime", async () => {
    await drain();
    await edit("Ttl01", "Three");
    const p = await page();
    await p.state({ focused: true });
    p.handler = () => ({ glossed: [] });
    const sh = await page({ role: "shell", host: "native", file: undefined });
    await sh.state();
    sh.handler = () => ({ shown: true, played: true });
    const r = await call("finish_work", {});
    assert.equal(r.json.sound, "shell");
    assert.equal(r.json.toast, true);
    assert.deepEqual(sh.cmds.map((c) => c.op).sort(), ["sound", "toast"]);
    assert.equal(sh.cmds.find((c) => c.op === "sound")!.args.name, "Glass");
    assert.equal(sh.cmds.find((c) => c.op === "toast")!.args.message, "Done");
    assert.equal(p.cmds.find((c) => c.op === "gloss")!.args.chime, false);
    assert.ok(!p.cmds.some((c) => c.op === "toast_fallback"));
    // sound:false is silent everywhere.
    await edit("Ttl01", "Four");
    sh.cmds.length = 0;
    p.cmds.length = 0;
    const quiet = await call("finish_work", { sound: false });
    assert.equal(quiet.json.sound, "off");
    assert.ok(!sh.cmds.some((c) => c.op === "sound"));
  });

  test("ids override the tracked set and still clear it; widgets are tracked too", async () => {
    await drain();
    await edit("Ttl01", "Five");
    const add = await call("add_widget", { file, kind: "note", x: 0, y: 2000 });
    await call("update_widget", { file, id: add.json.widget.id, patch: { name: "N" } });
    const p = await page();
    await p.state({ focused: true });
    p.handler = () => ({});
    const r = await call("finish_work", { ids: ["Scr02"], sound: false });
    assert.deepEqual(r.json.glossed, ["Scr02"]);
    assert.equal(r.json.trackedCount, 2); // Ttl01 and the widget, both cleared
    assert.deepEqual(p.cmds.find((c) => c.op === "gloss")!.args.ids, ["Scr02"]);
    await edit("Sub01", "Six");
    const second = await call("finish_work", { sound: false });
    assert.deepEqual(second.json.glossed, ["Sub01"]);
    await call("remove_widget", { file, id: add.json.widget.id });
  });

  test("many changed nodes in one board gloss the whole board", async () => {
    await drain();
    const f2 = path.join(dir, "many.canvas.json");
    fs.writeFileSync(f2, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "Big01", name: "Big", x: 0, y: 0, width: 400, height: 800, layout: "vertical", children: Array.from({ length: 6 }, (_, i) => ({ type: "text", id: `T${i}`, content: "x", fontFamily: "Inter", fontSize: 14, fill: "#111111" })) }] }));
    const many = fs.realpathSync(f2);
    for (let i = 0; i < 6; i++) await call("set_node_props", { file: many, id: `T${i}`, props: { content: `y${i}` } });
    const p = await page({ file: many });
    await p.state({ focused: true });
    p.handler = () => ({});
    const r = await call("finish_work", { file: many, sound: false });
    assert.deepEqual(r.json.glossed, ["Big01"]);
    assert.equal(r.json.trackedCount, 6);
    fs.unwatchFile(many);
  });

  test("with nothing open it says so instead of failing", async () => {
    await drain();
    const r = await call("finish_work", { summary: "x" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.note, /No canvas page or app/);
  });
});

describe("pages", () => {
  test("list_pages, create_page, rename_page, move_boards_to_page, delete_page, and the summary", async () => {
    const l0 = await call("list_pages", { file });
    assert.equal(l0.isError, false, l0.text);
    assert.equal(l0.json.implicit, true);
    assert.deepEqual(l0.json.pages[0].boards, ["Scr01", "Scr02"]);
    const c = await call("create_page", { file, name: "Proposal", boards: ["Scr02"] });
    assert.equal(c.isError, false, c.text);
    const pid = c.json.pages[1].id;
    assert.deepEqual(c.json.pages.map((p: any) => [p.name, p.boards]), [["Page 1", ["Scr01"]], ["Proposal", ["Scr02"]]]);
    const r = await call("rename_page", { file, id: pid, name: "Proposals", index: 0 });
    assert.deepEqual(r.json.pages.map((p: any) => p.name), ["Proposals", "Page 1"]);
    const m = await call("move_boards_to_page", { file, boards: ["Scr01"], page: pid });
    assert.deepEqual(m.json.pages.map((p: any) => p.boards), [["Scr01", "Scr02"], []]);
    assert.match((await call("move_boards_to_page", { file, boards: ["Nope"], page: pid })).text, /^not_found: /);
    const sum = await call("get_document_summary", { file });
    assert.deepEqual(sum.json.pages.map((p: any) => p.name), ["Proposals", "Page 1"]);
    const d = await call("delete_page", { file, id: m.json.pages[1].id });
    assert.equal(d.isError, false, d.text);
    assert.equal(d.json.pages.length, 1);
    assert.match((await call("delete_page", { file, id: pid })).text, /^invalid: .*at least one page/);
  });

  test("set_active_page runs the page op; list_pages reports the page the canvas shows", async () => {
    const p = await page();
    const pid = (await call("list_pages", { file })).json.pages[0].id;
    await p.state({ focused: true, page: pid });
    p.handler = (c) => ({ page: c.args.page, zoomPercent: 100 });
    const r = await call("set_active_page", { page: pid });
    assert.equal(r.isError, false, r.text);
    assert.equal(p.cmds[0].op, "page");
    assert.deepEqual(p.cmds[0].args, { page: pid });
    assert.equal((await call("list_pages", { file })).json.active, pid);
  });
});

describe("codex hunt 1: MCP", () => {
  const docB = path.join(dir, "other.canvas.json");
  fs.writeFileSync(docB, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "ScrB", name: "B screen", x: 0, y: 0, width: 100, height: 100, children: [{ type: "text", id: "TtlB1", name: "Title", content: "B", fontFamily: "Inter", fontSize: 12, fontWeight: "400", fill: "#000000" }] }] }, null, 2));
  const fileB = fs.realpathSync(docB);
  after(() => fs.unwatchFile(fileB));

  test("#1 select_nodes by name looks the node up in the named client's file, not the active one", async () => {
    const a = await page();
    await a.state({ focused: true });
    a.handler = () => ({});
    const b = await page({ file: fileB });
    await b.state();
    b.handler = () => ({ selected: ["TtlB1"], rendered: null });
    const r = await call("select_nodes", { client: b.id, name: "Title", reveal: false });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(b.cmds.find((c) => c.op === "select")!.args.ids, ["TtlB1"]);
    assert.ok(!a.cmds.some((c) => c.op === "select"));
  });

  test("#2 wait_for_selection returns the selection its event recorded, and what the page shows now apart", async () => {
    const p = await page();
    await p.state({ focused: true });
    const cursor = (await call("get_events", {})).json.nextSeq;
    await p.select(["Ttl01"], 1);
    await nap(50);
    // The same viewer switches to B and the agent selects something there.
    await p.state({ focused: true, file: fileB, selection: { ids: ["TtlB1"], pick: 2, source: "mcp", rendered: null } });
    const r = await call("wait_for_selection", { timeoutMs: 2000, sinceSeq: cursor });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.selected, ["Ttl01"]);
    assert.equal(r.json.file, file);
    assert.equal(r.json.nodes[0].node.id, "Ttl01");
    assert.equal(r.json.current.file, fileB);
    assert.deepEqual(r.json.current.selected, ["TtlB1"]);
  });

  test("#5 a deselect the agent made keeps its source: a user-selection wait does not wake on it", async () => {
    const p = await page();
    await p.state({ focused: true });
    await p.select(["Ttl01"], 1);
    await nap(50);
    const waiting = call("wait_for_selection", { timeoutMs: 1200, ignoreCurrent: true, includeClear: true });
    await nap(300);
    await p.state({ focused: true, selection: null, selectionSource: "mcp" });
    const r = await waiting;
    assert.equal(r.json.timedOut, true, r.text);
    const ev = (await call("get_events", { sinceSeq: 0, types: ["selection"] })).json.events;
    const last = ev[ev.length - 1];
    assert.deepEqual(last.ids, []);
    assert.equal(last.source, "mcp");
  });

  test("#6 finish_work with no viewer keeps the tracked changes for the next call; #7 missing ids are reported", async () => {
    // Spend whatever earlier tests left tracked.
    const d = await page();
    await d.state({ focused: true });
    d.handler = (c) => (c.op === "gloss" ? { glossed: c.args.ids, missing: [], revealed: false } : {});
    await call("finish_work", { sound: false, file });
    d.close();
    await nap(80);
    await call("set_node_props", { file, id: "Ttl01", props: { content: "Kept" } });
    const none = await call("finish_work", { sound: false, file });
    assert.deepEqual(none.json.glossed, []);
    assert.equal(none.json.trackedCount, 1);
    const p = await page();
    await p.state({ focused: true });
    p.handler = (c) => (c.op === "gloss" ? { glossed: c.args.ids.filter((x: string) => x !== "Nope1"), missing: c.args.ids.filter((x: string) => x === "Nope1"), revealed: true } : {});
    const shown = await call("finish_work", { sound: false, file });
    assert.deepEqual(shown.json.glossed, ["Ttl01"], "the change made with no viewer is still tracked");
    const cleared = await call("finish_work", { sound: false, file });
    assert.equal(cleared.json.trackedCount, 0, "and consumed once shown");
    const mixed = await call("finish_work", { sound: false, file, ids: ["Ttl01", "Nope1"] });
    assert.deepEqual(mixed.json.glossed, ["Ttl01"]);
    assert.deepEqual(mixed.json.missing, ["Nope1"]);
  });
});

describe("scale_nodes", () => {
  test("scales a layer with what is inside it about an anchor, one step; exactly one of factor, width, height", async () => {
    const board = () => JSON.parse(fs.readFileSync(file, "utf8")).children.find((n: any) => n.id === "Scr02");
    const before = board();
    const r = await call("scale_nodes", { file, ids: ["Scr02"], factor: 0.5, anchor: "center" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.factor, 0.5);
    await nap(50);
    const b = board();
    assert.deepEqual([b.x, b.y, b.width, b.height], [before.x + before.width / 4, before.y + before.height / 4, before.width / 2, before.height / 2]);
    const back = await call("scale_nodes", { file, ids: ["Scr02"], width: before.width, anchor: "center" });
    assert.equal(back.isError, false, back.text);
    await nap(50);
    const c = board();
    assert.deepEqual([c.x, c.y, c.width, c.height], [before.x, before.y, before.width, before.height]);
    assert.match((await call("scale_nodes", { file, ids: ["Scr02"], factor: 2, width: 10 })).text, /^invalid: /);
    await call("finish_work", { sound: false, file });
  });
});

describe("swap_instance, reset_overrides, push_overrides", () => {
  test("swap keeps a matching label's text, reset takes one property, push moves overrides into the main", async () => {
    const disk = () => JSON.parse(fs.readFileSync(file, "utf8"));
    const find = (id: string): any => { const seek = (l: any[]): any => { for (const n of l ?? []) { if (n.id === id) return n; const h = seek(n.children); if (h) return h; } }; return seek(disk().children); };
    const lbl = (id: string, content: string) => ({ type: "text", id, name: "Label", content, fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" });
    const add = await call("add_nodes", { file, nodes: [{ type: "frame", id: "SwapLib", name: "Swap lib", x: 6000, y: 0, width: 600, height: 300, layout: "none", children: [
      { type: "frame", id: "SwA", name: "A", reusable: true, x: 0, y: 0, width: 100, height: 40, fill: "#111111", children: [lbl("SwALbl", "A")] },
      { type: "frame", id: "SwB", name: "B", reusable: true, x: 200, y: 0, width: 100, height: 40, fill: "#222222", children: [lbl("SwBLbl", "B")] },
      { type: "ref", id: "SwI", ref: "SwA", x: 0, y: 100, fill: "#FF0000", descendants: { SwALbl: { content: "Mine" } } },
    ] }] });
    assert.equal(add.isError, false, add.text);
    const s = await call("swap_instance", { file, ids: ["SwI"], component: "SwB" });
    assert.equal(s.isError, false, s.text);
    assert.equal(s.json.kept, 1);
    await nap(50);
    assert.equal(find("SwI").ref, "SwB");
    assert.deepEqual(find("SwI").descendants, { SwBLbl: { content: "Mine" } });
    const r = await call("reset_overrides", { file, id: "SwI", props: ["fill"] });
    assert.equal(r.isError, false, r.text);
    await nap(50);
    assert.equal(find("SwI").fill, undefined);
    const p = await call("push_overrides", { file, id: "SwI" });
    assert.equal(p.isError, false, p.text);
    assert.equal(p.json.main, "SwB");
    await nap(50);
    assert.equal(find("SwBLbl").content, "Mine");
    assert.equal(find("SwI").descendants, undefined);
    assert.match((await call("swap_instance", { file, ids: ["SwI"], component: "Scr02" })).text, /^invalid: /);
    // A nested instance: an instance of SwCard holds an instance of A; swapping it to B is an override in SwCI.
    const nest = await call("add_nodes", { file, parent: "SwapLib", nodes: [
      { type: "frame", id: "SwCard", name: "Card", reusable: true, x: 400, y: 0, width: 120, height: 60, layout: "vertical", children: [{ type: "ref", id: "SwN", ref: "SwA" }] },
      { type: "ref", id: "SwCI", ref: "SwCard", x: 400, y: 120, descendants: { "SwN/SwALbl": { content: "Nested" } } },
    ] });
    assert.equal(nest.isError, false, nest.text);
    const n = await call("swap_instance", { file, ids: ["SwCI/SwN"], component: "SwB" });
    assert.equal(n.isError, false, n.text);
    assert.equal(n.json.kept, 1);
    await nap(50);
    assert.deepEqual(find("SwCI").descendants, { SwN: { ref: "SwB" }, "SwN/SwBLbl": { content: "Nested" } });
    assert.equal(find("SwN").ref, "SwA", "the main component's own nested instance stays");
    const back = await call("reset_overrides", { file, id: "SwCI/SwN", props: ["ref"] });
    assert.equal(back.isError, false, back.text);
    await nap(50);
    assert.deepEqual(find("SwCI").descendants, { "SwN/SwALbl": { content: "Nested" } });
    await call("delete_nodes", { file, ids: ["SwapLib"] });
    await call("finish_work", { sound: false, file });
  });
});

describe("canvas:// links (Cmd+L)", () => {
  const link = (nodes: string[], page?: string) => buildLink({ file, page, nodes })!;

  test("resolve_link names the file, the page and each node; a gone node is listed as missing", async () => {
    const r = await call("resolve_link", { link: link(["Ttl01", "Scr02", "Gone01"]) });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.file, file);
    // Earlier tests renamed layers: the names are whatever the file says now.
    const nameOf = async (id: string) => (await call("inspect_node", { file, id })).json.node.name;
    assert.deepEqual(r.json.nodes.map((n: any) => [n.id, n.name, n.type, n.board]), [["Ttl01", await nameOf("Ttl01"), "text", "Scr01"], ["Scr02", await nameOf("Scr02"), "frame", "Scr02"]]);
    assert.ok(r.json.nodes[0].page && r.json.nodes[0].page.id, "each node says its page");
    assert.deepEqual(r.json.missing, ["Gone01"]);
    assert.equal(r.json.open, false);
    assert.match((await call("resolve_link", { link: link([]) })).json.note, /names the page/);
    assert.match((await call("resolve_link", { link: "https://example.com" })).text, /^invalid: /);
    assert.match((await call("resolve_link", { link: buildLink({ file: path.join(dir, "nope.canvas") })! })).text, /^not_found: /);
  });

  test("disk tools take a link as link, in place of id, or in place of file", async () => {
    const i = await call("inspect_node", { link: link(["Ttl01"]) });
    assert.equal(i.isError, false, i.text);
    assert.equal(i.json.node.id, "Ttl01");
    assert.equal((await call("inspect_node", { id: link(["Sub01"]) })).json.node.id, "Sub01");
    assert.equal((await call("get_document_summary", { file: link([]) })).json.boards.length, 2);
    const l = await call("lookup_nodes", { link: link(["Scr01"]), type: "text" });
    const want = await call("lookup_nodes", { file, within: "Scr01", type: "text" });
    assert.ok(want.json.total > 0);
    assert.deepEqual(l.json.results.map((x: any) => x.id), want.json.results.map((x: any) => x.id), "the link's node is the lookup's scope");
    const many = await call("inspect_node", { link: link(["Ttl01", "Sub01"]) });
    assert.match(many.text, /^invalid: The link names 2 nodes/);
    assert.match((await call("inspect_node", { link: "canvas://open?node=x" })).text, /^invalid: That is not a Canvas link/);
    assert.match((await call("highlight_nodes", {})).text, /^invalid: ids is required/);
  });

  test("select_nodes and fit_view take the link's ids and its file", async () => {
    const p = await page();
    await p.state({ focused: true });
    p.handler = async (c) => {
      if (c.op === "select") await p.select(c.args.ids, 9, undefined, "mcp");
      return c.op === "select" ? { selected: c.args.ids, rendered: null } : { fitted: c.args.ids };
    };
    const a = await call("select_nodes", { link: link(["Ttl01", "Sub01"]) });
    assert.equal(a.isError, false, a.text);
    assert.deepEqual(p.cmds[0].args.ids, ["Ttl01", "Sub01"]);
    const b = await call("fit_view", { ids: [link(["Scr02"])] });
    assert.equal(b.isError, false, b.text);
    assert.deepEqual(p.cmds[1].args.ids, ["Scr02"]);
    // Ids passed beside the link win over its nodes.
    await call("select_nodes", { link: link(["Ttl01"]), ids: ["Scr02"] });
    assert.deepEqual(p.cmds[2].args.ids, ["Scr02"]);
  });
});
