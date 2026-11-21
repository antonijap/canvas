import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpDir } from "./helpers.ts";
import { cleanPages, resolvePages, validatePages } from "../src/pages.ts";

const dir = tmpDir("page-background");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_HEADLESS = "1";
const file = path.join(dir, "Design.canvas");
fs.mkdirSync(file);
const document = JSON.stringify({ version: "2.21", children: [] });
fs.writeFileSync(path.join(file, "document.json"), document);
fs.writeFileSync(path.join(file, "widgets.json"), JSON.stringify({ version: 1, widgets: [], pages: [{ id: "one", name: "Page 1", boards: [] }] }));
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const version = (await (await fetch(base + "/health")).json() as any).version;
const client = new Client({ name: "page-background-test", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("mcp/server.ts")], env: { ...process.env, CANVAS_PORT: String(port), CANVAS_MCP_BACKGROUND: "1", CANVAS_MCP_NO_SPAWN: "1", CANVAS_MCP_WANT_VERSION: version } as Record<string, string>, stderr: "pipe" }));
after(async () => { await client.close(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(name: string, args: any) {
  const r: any = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, r.content[0].text);
  return JSON.parse(r.content[0].text);
}
const pages = async () => (await call("list_pages", { file })).pages;
const stored = () => JSON.parse(fs.readFileSync(path.join(file, "widgets.json"), "utf8")).pages;

test("old pages load unchanged; background survives cleaning and resolution; malformed colours fail validation", () => {
  const old = [{ id: "one", name: "Page 1", boards: [] }];
  assert.deepEqual(cleanPages(old), old);
  assert.deepEqual(resolvePages(old, []).pages, old);
  const set = [{ ...old[0], background: "#123ABC" }];
  assert.deepEqual(cleanPages(set), set);
  assert.deepEqual(resolvePages(set, []).pages, set);
  for (const background of ["red", "#12345678", "#fff", 42]) assert.throws(() => validatePages([{ ...old[0], background }]), /background/);
});

test("headless MCP sets, resets and undoes a package page background without changing board bytes", async () => {
  assert.equal((await pages())[0].background, null);
  await call("set_page_background", { file, page: "one", color: "#12aBcD" });
  assert.equal((await pages())[0].background, "#12ABCD");
  assert.equal(stored()[0].background, "#12ABCD");
  await call("finish_work", { file, summary: "Set page background" });
  await call("set_page_background", { file, page: "one", color: null });
  await call("finish_work", { file, summary: "Reset page background" });
  assert.equal((await pages())[0].background, null);
  assert.equal(stored()[0].background, undefined);
  await call("undo", { file });
  assert.equal((await pages())[0].background, "#12ABCD");
  await call("undo", { file });
  assert.equal((await pages())[0].background, null);
  assert.equal(fs.readFileSync(path.join(file, "document.json"), "utf8"), document);
  const bad: any = await client.callTool({ name: "set_page_background", arguments: { file, page: "one", color: "red" } });
  assert.ok(bad.isError);
  const missing: any = await client.callTool({ name: "set_page_background", arguments: { page: "one", color: null } });
  assert.ok(missing.isError);
});

test("HTTP validates colours without writes, and other page edits preserve the background", async () => {
  const patch = async (body: any) => fetch(`${base}/api/pages/one?file=${encodeURIComponent(file)}`, { method: "PATCH", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const background of ["red", "#FFF", "#12345678", 42]) {
    const before = fs.readFileSync(path.join(file, "widgets.json"), "utf8");
    assert.equal((await patch({ background })).status, 422);
    assert.equal(fs.readFileSync(path.join(file, "widgets.json"), "utf8"), before);
  }
  assert.equal((await patch({ background: "#ABCDEF" })).status, 200);
  assert.equal((await patch({ name: "Renamed page" })).status, 200);
  assert.equal(stored()[0].background, "#ABCDEF");
  assert.equal((await patch({ background: null })).status, 200);
  assert.equal(stored()[0].background, undefined);
});
