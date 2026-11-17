// MCP answers an agent tripped over while building a whole website design: a server another copy of Canvas runs
// called stale, list_pages' write guard read as a revision, id lookups that only matched exactly, inspect_node
// ignoring depth 0, and live tools failing without saying another file is in front.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FakeClient } from "./fake-page.ts";
import { tmpDir } from "./helpers.ts";
import { nodeDepth } from "../src/doc/tree.ts";
import { codeRootId } from "../src/version.ts";

const dir = tmpDir("mcp-edges");
process.env.CANVAS_ROOTS = dir;
const doc = (prefix: string) => ({
  version: "2.21",
  children: [
    {
      type: "frame", id: `${prefix}Scr01`, name: "Screen", x: 0, y: 0, width: 390, height: 844, layout: "vertical",
      children: [
        { type: "text", id: `${prefix}Ttl01`, name: "Title", content: "Hello", fontFamily: "Inter", fontSize: 24 },
        { type: "text", id: `${prefix}Sub01`, name: "Subtitle", content: "Again", fontFamily: "Inter", fontSize: 14 },
      ],
    },
    { type: "frame", id: `${prefix}Scr02`, name: "Wide", x: 500, y: 0, width: 600, height: 300, children: [] },
  ],
});
const write = (name: string, prefix: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(doc(prefix), null, 2));
  return fs.realpathSync(f);
};
const file = write("one.canvas.json", "m_");
const other = write("two.canvas.json", "n_");

const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const health = (await (await fetch(`${base}/health`)).json()) as { version: string; root?: string };

const mcps: Client[] = [];
async function connect(env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(import.meta.dirname, "../mcp/server.ts")],
    env: { ...(process.env as Record<string, string>), CANVAS_PORT: String(port), CANVAS_MCP_NO_SPAWN: "1", CANVAS_MCP_NO_APP: "1", CANVAS_MCP_WANT_VERSION: health.version, ...env },
    stderr: "pipe",
  });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  mcps.push(c);
  return c;
}
const client = await connect();

async function call(name: string, args: Record<string, unknown> = {}, c = client) {
  const r: any = await c.callTool({ name, arguments: args });
  const text: string = r.content.find((x: any) => x.type === "text")?.text ?? "";
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: r.isError === true, text, json };
}

const fakes: FakeClient[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) f.close();
  await new Promise((r) => setTimeout(r, 40));
});
after(async () => {
  for (const c of mcps) await c.close();
  for (const f of fs.readdirSync(dir)) fs.unwatchFile(path.join(dir, f));
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("which copy of the code a server runs", () => {
  test("/health names the copy without its path", () => {
    assert.equal(health.root, codeRootId());
    assert.match(health.root!, /^[0-9a-f]{12}$/);
    assert.notEqual(codeRootId("/a/canvas/src"), codeRootId("/b/canvas/src"));
  });

  test("a server another copy runs (the installed app) is not stale, and restartStale leaves it alone", async () => {
    const c = await connect({ CANVAS_MCP_WANT_VERSION: "000000000000", CANVAS_MCP_WANT_ROOT: "ffffffffffff" });
    const st = await call("canvas_status", {}, c);
    assert.equal(st.json.server.stale, false);
    assert.equal(st.json.server.otherCopy, true);
    assert.match(st.json.server.note, /another copy of Canvas/);
    const l = await call("launch_canvas", { mode: "server", restartStale: true }, c);
    assert.equal(l.isError, false, l.text);
    assert.equal(l.json.server.replaced, false);
    assert.equal(l.json.server.stale, false);
    assert.equal((await fetch(`${base}/health`)).ok, true);
  });

  test("older code of the same copy is still stale", async () => {
    const c = await connect({ CANVAS_MCP_WANT_VERSION: "000000000000" });
    const st = await call("canvas_status", {}, c);
    assert.equal(st.json.server.stale, true);
    assert.equal(st.json.server.otherCopy, undefined);
  });
});

describe("disk answers", () => {
  test("list_pages carries no rev that disagrees with the document's revision", async () => {
    const l = await call("list_pages", { file });
    assert.equal(l.isError, false, l.text);
    assert.equal("rev" in l.json, false);
    assert.deepEqual(l.json.pages[0].boards, ["m_Scr01", "m_Scr02"]);
  });

  test("lookup_nodes id: exact id answers that node, anything else matches as a substring", async () => {
    const exact = await call("lookup_nodes", { file, id: "m_Ttl01" });
    assert.equal(exact.json.total, 1);
    assert.equal(exact.json.results[0].path, "Screen");
    const part = await call("lookup_nodes", { file, id: "m_" });
    assert.equal(part.isError, false, part.text);
    assert.equal(part.json.total, 4);
    const ci = await call("lookup_nodes", { file, id: "SCR0" });
    assert.deepEqual(ci.json.results.map((r: any) => r.id), ["m_Scr01", "m_Scr02"]);
    const withType = await call("lookup_nodes", { file, id: "m_", type: "text" });
    assert.deepEqual(withType.json.results.map((r: any) => r.id), ["m_Ttl01", "m_Sub01"]);
    assert.match((await call("lookup_nodes", { file, id: "zzz" })).text, /^not_found: /);
  });

  test("inspect_node depth 0 cuts off every child", async () => {
    const i = await call("inspect_node", { file, id: "m_Scr01", depth: 0 });
    assert.equal(i.isError, false, i.text);
    assert.equal(typeof i.json.node.children, "string");
    const deep = await call("inspect_node", { file, id: "m_Scr01" });
    assert.equal(Array.isArray(deep.json.node.children), true);
  });

  test("nodeDepth: 0 is 0, absent or junk is the fallback, the rest is clamped", () => {
    assert.equal(nodeDepth("0"), 0);
    assert.equal(nodeDepth(null), 4);
    assert.equal(nodeDepth(""), 4);
    assert.equal(nodeDepth("abc"), 4);
    assert.equal(nodeDepth("2"), 2);
    assert.equal(nodeDepth("99"), 8);
    assert.equal(nodeDepth("-3"), 0);
  });
});

describe("live answers for a file in a background tab", () => {
  test("rendered sizes say which file is in front and how to bring this one forward", async () => {
    const p = await new FakeClient(base, { file }).connect();
    fakes.push(p);
    await p.state();
    const r = await call("lookup_nodes", { file: other, id: "n_Ttl01", rendered: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.results[0].rendered, null);
    assert.match(r.json.note, /one\.canvas\.json in front/);
    assert.match(r.json.note, /open_file/);
  });
});
