import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NT, sc } from "./harness.ts";

sc("mcp-background", "quiet-open keeps the active tab and its selection", { covers: ["mcp-background:quiet-open"] }, async (t: NT) => {
  const other = path.join(t.app.docs, "Quiet.canvas");
  fs.cpSync(t.file, other, { recursive: true });
  await t.selectIds(["r_free"]);
  const before = await t.state();
  const selection = await t.js("return window.canvasHost.selection()");
  const client = new Client({ name: "quiet-open-qa", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(import.meta.dirname, "../../mcp/server.ts")],
    env: { ...process.env, CANVAS_PORT: String(t.app.port), CANVAS_MCP_BACKGROUND: "0", CANVAS_MCP_NO_APP: "1", CANVAS_MCP_NO_SPAWN: "1" } as Record<string, string>, stderr: "pipe" }));
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>;
  try {
    const quiet = await call("open_file", { file: other, focus: false });
    t.ok(!quiet.isError && JSON.parse(quiet.content[0].text).live === false, "quiet open succeeds and explains the hidden page");
    t.eq((await t.state()).file, before.file, "quiet open keeps the active tab");
    t.eq(await t.js("return window.canvasHost.selection()"), selection, "quiet open keeps selection");
    const after = await t.state();
    t.eq([after.window.key, after.window.active, after.homeShown], [before.window.key, before.window.active, before.homeShown], "quiet open keeps window focus and Home");
    const tabs = await t.cmd("tabs");
    t.ok(tabs.tabs.some((x: any) => x.file === other), "quiet file has a tab");
    const live = await call("get_viewport", { file: other });
    t.ok(live.isError && /no_page:.*CANVAS_MCP_BACKGROUND/.test(live.content[0].text), "live tools target the file and explain background mode");
    const same = await call("open_file", { file: t.file });
    t.ok(!same.isError, "default quiet open works for the active page");
    t.eq((await t.state()).file, before.file, "quiet reopen keeps active tab");
    const focused = await call("open_file", { file: other, focus: true });
    t.ok(!focused.isError, "explicit focus opens the live page");
    await t.waitState(s => s.file === other, "explicit focus switches the tab");
    await call("open_file", { file: t.file, focus: true });
    await t.waitState(s => s.file === t.file, "original file restored");
    // A previously shown tab has a cached web view, but its bridge disconnects while hidden.
    await call("open_file", { file: other });
    t.eq((await t.state()).file, t.file, "quiet reopen of a cached tab stays hidden");
  } finally { await client.close(); }
});
