// Regression tests for Codex bug hunt round 4 (.planning/research/codex-hunt-4.md) that need the server.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("hunt4");
process.env.CANVAS_ROOTS = dir;
const file = path.join(dir, "mixed.canvas.json");
fs.writeFileSync(file, JSON.stringify({ version: "2.21", children: [
  { type: "frame", id: "B", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [
    { type: "rectangle", id: "R", x: 0, y: 0, width: 10, height: 10, fill: "#FF0000" },
    { type: "rectangle", id: "S", x: 20, y: 0, width: 10, height: 10, fill: "#00FF00" },
  ] },
] }));
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  fs.unwatchFile(fs.realpathSync(file));
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const update = async (body: unknown) => {
  const r = await fetch(base + "/api/update", { method: "POST", headers: { "content-type": "application/json", "x-canvas": "1" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const node = (id: string) => JSON.parse(fs.readFileSync(file, "utf8")).children[0].children.find((n: any) => n.id === id);

describe("codex hunt 4: server", () => {
  test("6 an inspector edit on layers selected with a card saves on the layers", async () => {
    const r = await update({ file, ids: ["R", "widget:W"], props: { opacity: 0.5 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(node("R").opacity, 0.5);
    const two = await update({ file, ids: ["widget:W", "R", "S"], props: { opacity: 0.25 } });
    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.deepEqual([node("R").opacity, node("S").opacity], [0.25, 0.25]);
    // Cards alone have no layer properties.
    assert.equal((await update({ file, ids: ["widget:W", "widget:V"], props: { opacity: 0.5 } })).status, 400);
  });
});
