import assert from "node:assert/strict";
import { test, after } from "node:test";
import { PORT, resolveFile, ensureServer, cmd, api } from "../mcp/client.ts";
import { tool } from "../mcp/tool.ts";
import { z } from "zod";

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => new Response(JSON.stringify(String(input).endsWith('/health') ? { ok: true, headless: true, version: 'test' } : {}))) as typeof fetch;
after(() => { globalThis.fetch = originalFetch; });
process.env.CANVAS_MCP_BACKGROUND = "1";
delete process.env.CANVAS_PORT;

test("background port defaults to 5199 and never uses the app port", () => {
  assert.equal(PORT(), 5199);
  process.env.CANVAS_PORT = "5189";
  assert.equal(PORT(), 5199);
  process.env.CANVAS_PORT = "5201";
  assert.equal(PORT(), 5201);
  delete process.env.CANVAS_PORT;
});

test("background resolveFile requires an explicit file", async () => {
  assert.equal(await resolveFile("/tmp/design.canvas"), "/tmp/design.canvas");
  await assert.rejects(resolveFile(), /background mode needs file/);
});

async function invoke(name: string, shape: any, args: any) {
  let callback: any;
  const server = { registerTool(_name: string, _config: any, cb: any) { callback = cb; } };
  let ran = false;
  tool(server as any, name, "test", shape, () => { ran = true; return { done: true }; });
  const out = await callback(args, {});
  return { out, ran };
}

test("background refuses every window-only tool before its handler", async () => {
  for (const name of ["open_file", "launch_canvas", "close_tab", "screenshot_view", "fit_view", "pan_view", "set_zoom", "select_nodes", "clear_selection", "highlight_nodes", "clear_highlights", "wait_for_selection", "get_selection", "reveal_widget", "notify_user", "get_viewport", "set_active_page", "list_tabs", "get_current_file", "get_theme", "set_theme"]) {
    const { out, ran } = await invoke(name, {}, {});
    assert.equal(ran, false, name);
    assert.equal(out.isError, true, name);
    assert.match(out.content[0].text, /^background_mode:.*render_node/, name);
  }
});

test("background disk tools require file after expanding links", async () => {
  for (const name of ["add_nodes", "set_node_props", "delete_nodes", "place_nodes", "list_widgets", "list_pages", "set_page_background", "set_page_pattern", "list_comments", "render_node", "inspect_node", "lookup_nodes", "get_document_summary", "check_variation", "finish_work", "create_shader", "update_shader", "video_frame"]) {
    const { out, ran } = await invoke(name, { file: z.string().optional() }, {});
    assert.equal(ran, false, name);
    assert.match(out.content[0].text, /background mode needs file/, name);
  }
  const r = await invoke("get_document_summary", { file: z.string().optional() }, { link: "canvas://open?file=%2Ftmp%2Fdesign.canvas" });
  assert.equal(r.ran, true);
  assert.equal(r.out.isError, undefined);
});

test("background permits server-wide tools without file", async () => {
  for (const name of ["canvas_status", "list_widget_kinds", "list_shader_presets", "list_installed_fonts"]) {
    assert.equal((await invoke(name, {}, {})).ran, true, name);
  }
});


test("background refuses a non-headless server and never sends live commands", async () => {
  const stub = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ ok: true, version: "test" }));
  }) as typeof fetch;
  try {
    await assert.rejects(ensureServer(), /not a headless Canvas server/);
    await assert.rejects(cmd({ op: "open" }), /Background mode has no live page/);
    await assert.rejects(api("GET", "/api/bridge/state"), /explicit node ids/);
    assert.deepEqual(urls, ["http://127.0.0.1:5199/health"]);
  } finally { globalThis.fetch = stub; }
});

test("normal mode keeps its default port and permits window tools", async () => {
  process.env.CANVAS_MCP_BACKGROUND = "0";
  try {
    assert.equal(PORT(), 5189);
    assert.equal((await invoke("open_file", {}, {})).ran, true);
  } finally { process.env.CANVAS_MCP_BACKGROUND = "1"; }
});
