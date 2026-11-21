// Real stdio MCP clients, a spawned headless server, disk writes and a rendered image.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { freePort } from "./lib.ts";

export async function exerciseBackground(video: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-background-"));
  const file = path.join(dir, "Design.canvas");
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, "document.json"), JSON.stringify({ version: "2.21", children: [] }));
  const port = await freePort();
  const root = path.resolve(import.meta.dirname, "..");
  const audit = path.join(dir, "requests.log");
  const clients: Client[] = [];
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, undefined, `${name}: ${JSON.stringify(r.content)}`);
    return r;
  };
  try {
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: "background-qa", version: "1" });
      clients.push(client);
      const env = { ...process.env, CANVAS_MCP_BACKGROUND: "1", CANVAS_PORT: String(port), CANVAS_ROOTS: dir,
        CANVAS_STATE_DIR: path.join(dir, "state"), CANVAS_LOG_DIR: path.join(dir, "logs"), CANVAS_FETCH_AUDIT: audit,
        CANVAS_MCP_NO_SPAWN: "0", CANVAS_MCP_NO_APP: "0" } as Record<string, string>;
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: ["--import", path.join(root, "test/fixtures/mcp-fetch-audit.ts"), path.join(root, "mcp/server.ts")], env, stderr: "pipe" }));
    }
    const missing: any = await clients[0].callTool({ name: "add_nodes", arguments: { nodes: [{ type: "frame", width: 10, height: 10 }] } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /background mode needs file/);
    const refused: any = await clients[0].callTool({ name: "open_file", arguments: { file } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^background_mode:/);
    assert.equal(fs.existsSync(audit), false, "mode gates do not contact any server");
    // Both clients see a missing server and may race to start it. The port has one winner.
    await Promise.all(clients.map(c => call(c, "canvas_status")));
    await Promise.all(clients.map((c, i) => call(c, "add_nodes", { file, nodes: [{ type: "frame", id: `Board${i}`, name: `Board ${i}`, width: 160, height: 100, fill: "#336699", children: [] }] })));
    const summary = JSON.parse((await call(clients[0], "get_document_summary", { file })).content[0].text);
    assert.equal(summary.boards.length, 2);
    await call(clients[0], "set_node_props", { file, id: "Board0", props: { name: "Updated" } });
    for (const [name, args] of [
      ["inspect_node", { id: "Board0" }], ["lookup_nodes", { name: "Updated", rendered: true }],
      ["list_pages", {}], ["list_widgets", {}], ["list_comments", {}], ["check_variation", { id: "Board0" }],
    ] as const) await call(clients[0], name, { file, ...args });
    const image = await call(clients[0], "render_node", { link: `canvas://open?file=${encodeURIComponent(file)}&node=Board0` });
    assert.ok(image.content.some((c: any) => c.type === "image" && Buffer.from(c.data, "base64").length > 100));
    const page = JSON.parse((await call(clients[0], "create_page", { file, name: "Details" })).content[0].text);
    assert.ok(page);
    const widget = JSON.parse((await call(clients[0], "add_widget", { file, kind: "note", config: { text: "Review" } })).content[0].text);
    assert.ok(widget);
    await call(clients[0], "add_comment", { file, nodeId: "Board0", body: "Review this board" });
    await call(clients[0], "add_nodes", { file, parent: "Board0", nodes: [{ type: "rectangle", id: "Temporary", width: 10, height: 10 }] });
    await call(clients[0], "place_nodes", { file, ids: ["Temporary"], parent: "Board1", index: 0 });
    await call(clients[0], "delete_nodes", { file, ids: ["Temporary"] });
    const shader = await call(clients[0], "create_shader", { file, source: "fn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }", w: 100, h: 100 });
    assert.ok(shader.content.some((c: any) => c.type === "image"), "background shader renders a frame");
    const clip = path.join(dir, "Clip.webm");
    fs.writeFileSync(clip, Buffer.from(video, "base64"));
    const addedVideo = await call(clients[0], "add_video", { file, path: clip, posterTime: 0 });
    assert.ok(addedVideo.content.some((c: any) => c.type === "image"), "background video addition renders a frame");
    const videoMeta = JSON.parse(addedVideo.content.find((c: any) => c.type === "text").text);
    const videoFrame = await call(clients[0], "video_frame", { file, id: videoMeta.id, t: 0, maxSide: 64 });
    assert.ok(videoFrame.content.some((c: any) => c.type === "image"), "background video_frame returns an image");
    const finished = await call(clients[0], "finish_work", { file, summary: "Updated boards" });
    assert.match(finished.content[0].text, /background_mode/);
    assert.equal(JSON.parse(finished.content[0].text).toast, false);
    assert.equal(JSON.parse(finished.content[0].text).sound, "off");
    await call(clients[0], "set_node_props", { file, id: "Board0", props: { name: "Temporary name" } });
    await call(clients[0], "undo", { file });
    // finish_work closed the first undo step; this undo affects only the later edit.

    const disk = JSON.parse(fs.readFileSync(path.join(file, "document.json"), "utf8"));
    assert.equal(disk.children.length, 2);
    assert.equal(disk.children.find((n: any) => n.id === "Board0").name, "Updated");
    const st = JSON.parse((await call(clients[1], "canvas_status")).content[0].text);
    assert.equal(st.mode, "background");
    assert.equal(st.port, port);
    assert.equal(st.app.untouched, true);
    const resource: any = await clients[0].readResource({ uri: "canvas://state" });
    assert.equal(JSON.parse(resource.contents[0].text).mode, "background");
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await (await fetch(base + "/health")).json() as any).headless, true);
    for (const role of ["shell", "page"]) {
      const forbidden = await fetch(base + `/api/bridge/events?client=test-client&role=${role}`);
      assert.equal(forbidden.status, 500);
      await forbidden.body?.cancel();
    }
    const requests = fs.readFileSync(audit, "utf8").trim().split("\n").map(s => new URL(s));
    assert.ok(requests.length > 10);
    assert.ok(requests.every(u => u.port === String(port)), "MCP never contacted the app port");
    assert.ok(requests.every(u => u.pathname !== "/api/bridge/cmd"), "MCP sent no shell or page command");
    return { requests: requests.length, boards: disk.children.length, rendered: true };
  } finally {
    await Promise.all(clients.map(c => c.close().catch(() => {})));
    await fetch(`http://127.0.0.1:${port}/quit`, { method: "POST", headers: { "x-canvas": "1" } }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
