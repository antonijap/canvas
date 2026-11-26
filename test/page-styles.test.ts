import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tmpDir } from "./helpers.ts";

const doc = {
  version: "2.21",
  variables: { Accent: { type: "color", value: "#AABBCC" } },
  children: [
    { type: "frame", id: "board", width: 100, height: 100, children: [
      { type: "group", id: "group", children: [
        { type: "rectangle", id: "shape", width: 10, height: 10, fill: ["#abc", { type: "color", color: "#aabbccff" }], stroke: "#ABC", strokeWidth: 1 },
        { type: "text", id: "title", content: "Title", fill: "$Accent", fontWeight: "600", fontSize: 16, lineHeight: 1.2,
          spans: [{ start: 1, end: 3, fill: "#abc", fontSize: 12 }] },
        { type: "rectangle", id: "image", width: 10, height: 10, fill: { type: "image", url: "sample.png" } },
        { type: "rectangle", id: "gradient", width: 10, height: 10, fill: { type: "gradient", gradientType: "linear", colors: [{ position: 0, color: "#ABC" }, { position: 1, color: "#123456" }] } },
        { type: "ref", id: "instance", ref: "main" },
      ] },
    ] },
    { type: "frame", id: "main", reusable: true, width: 40, height: 40, children: [
      { type: "text", id: "copy", content: "Copy", fill: "$Accent", fontWeight: 600, fontSize: 16, lineHeight: 1.2 },
    ] },
  ],
};

test("page styles count layers once, preserve tokens, and select expanded instance children", async (t) => {
  const dir = tmpDir("page-styles");
  process.env.CANVAS_ROOTS = dir;
  const file = path.join(dir, "studio.canvas.json");
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.writeFileSync(path.join(dir, "studio.widgets.json"), JSON.stringify({ version: 1, widgets: [], pages: [
    { id: "page-1", name: "Page 1", boards: ["board"] },
    { id: "library", name: "Library", boards: ["main"] },
    { id: "empty", name: "Empty", boards: [] },
  ] }));
  const { startServer } = await import("../src/server.ts");
  const server = await startServer(0);
  t.after(() => {
    for (const f of fs.readdirSync(dir)) fs.unwatchFile(path.join(dir, f));
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const q = "?file=" + encodeURIComponent(file);
  const endpoint = "/api/page-styles" + q;
  const read = async (page: string) => {
    const response = await fetch(base + endpoint + "&page=" + page);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (route: string, body?: unknown) => {
    const response = await fetch(base + route, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };

  const styles = await read("page-1");
  assert.equal(typeof styles.rev, "string");
  assert.deepEqual(styles.colors.map(({ value, token, count, ids }: any) => ({ value, token, count, ids })), [
    { value: "#AABBCC", token: undefined, count: 2, ids: ["shape", "title"] },
    { value: "#AABBCC", token: "Accent", count: 2, ids: ["title", "instance/copy"] },
  ]);
  assert.deepEqual(styles.text, [
    { family: "Inter", weight: 600, size: 16, lineHeight: 1.2, count: 2, ids: ["title", "instance/copy"] },
    { family: "Inter", weight: 600, size: 12, lineHeight: 1.2, count: 1, ids: ["title"] },
  ]);
  assert.deepEqual(await read("empty"), { rev: styles.rev, colors: [], text: [] });
  assert.equal((await fetch(base + endpoint + "&page=missing")).status, 404);

  await t.test("replacing a token writes one undo step across ordinary and instance layers", async () => {
    await post(endpoint, { page: "page-1", rev: styles.rev, from: "$Accent", to: "#F03456" });
    const changed = await read("page-1");
    assert.notEqual(changed.rev, styles.rev);
    assert.deepEqual(changed.colors.map((row: any) => [row.token ?? row.value, row.count]), [["#AABBCC", 2], ["#F03456", 2]]);
    assert.deepEqual((await read("library")).colors.map((row: any) => [row.token, row.value]), [["Accent", "#AABBCC"]]);
    assert.equal((await (await fetch(base + "/api/history" + q)).json()).undo, "Replace Page Color");
    const stale = await fetch(base + endpoint, {
      method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" },
      body: JSON.stringify({ page: "page-1", rev: styles.rev, from: "#F03456", to: "#000000" }),
    });
    assert.equal(stale.status, 409);
    await post("/api/history/undo" + q);
    assert.deepEqual((await read("page-1")).colors, styles.colors);
  });

  await t.test("replacing a literal skips gradients and preserves other paint properties", async () => {
    const before = await read("page-1");
    await post(endpoint, { page: "page-1", rev: before.rev, from: "#abc", to: "#123456" });
    const get = async (id: string) => (await (await fetch(base + "/api/node" + q + "&id=" + id)).json()).node;
    assert.deepEqual((await get("shape")).fill, ["#123456", { type: "color", color: "#123456" }]);
    assert.equal((await get("shape")).stroke, "#123456");
    assert.equal((await get("title")).spans[0].fill, "#123456");
    assert.equal((await get("gradient")).fill.colors[0].color, "#ABC");
    await post("/api/history/undo" + q);
    assert.deepEqual((await read("page-1")).colors, before.colors);
  });
});
