// QA native round 2 (.planning/research/qa-native-round2.md) and Codex round 2 items 9 and 10, server side:
// Mixed X/Y skips layers auto layout places, a value per layer (`each`) is one write and one undo step, undo labels
// for strokes and flips, layers inside instances in the Layers outline, Undo of Duplicate selects the originals.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { nodeLabel } from "../src/history.ts";
import { resizeLabel } from "../src/resize.ts";
import { withoutPlacedXY } from "../src/autolayout.ts";
import { textProps } from "../src/usage.ts";

const dir = tmpDir("qa-native2");
process.env.CANVAS_ROOTS = dir;
const rect = (id: string, extra = {}) => ({ type: "rectangle", id, width: 10, height: 10, fill: "#00FF00", ...extra });
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B1", name: "Home", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [
      { type: "frame", id: "Col", layout: "vertical", children: [rect("c1"), rect("c2")] },
      rect("free", { x: 5, y: 5 }),
      rect("free2", { x: 30, y: 7 }),
      { type: "ref", id: "Inst", ref: "Main", x: 100, y: 100 },
    ] },
    { type: "frame", id: "Main", name: "Main", reusable: true, x: 600, y: 0, gap: 8, children: [
      { type: "frame", id: "Inner", children: [{ type: "text", id: "Lbl", content: "Days", fontSize: 12, fontFamily: "Inter", fontWeight: "400", fill: "#000000" }] },
    ] },
  ],
};
const p = path.join(dir, "q.canvas.json");
fs.writeFileSync(p, JSON.stringify(DOC, null, 2));
const file = fs.realpathSync(p);
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  fs.unwatchFile(file);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (route: string, body?: unknown, method = "POST") => {
  const r = await fetch(base + route, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify({ file, ...(body as object) }) });
  return { status: r.status, body: (await r.json()) as any };
};
const q = `?file=${encodeURIComponent(file)}`;
const find = (id: string) => {
  const s = (l: any[]): any => { for (const n of l) { if (n.id === id) return n; const h = n.children && s(n.children); if (h) return h; } };
  return s(JSON.parse(fs.readFileSync(file, "utf8")).children);
};

describe("pure", () => {
  test("x/y of a layer auto layout places are left out, unless the edit takes it out of the flow", () => {
    const flow = { type: "frame", id: "f", layout: "vertical" } as any;
    assert.deepEqual(withoutPlacedXY(flow, { id: "c" } as any, { x: 50, opacity: 1 }), { opacity: 1 });
    assert.deepEqual(withoutPlacedXY(flow, { id: "c" } as any, { x: 50, layoutPosition: "absolute" }), { x: 50, layoutPosition: "absolute" });
    assert.deepEqual(withoutPlacedXY(flow, { id: "c", layoutPosition: "absolute" } as any, { x: 50 }), { x: 50 });
    assert.deepEqual(withoutPlacedXY({ type: "frame", id: "f", layout: "none" } as any, { id: "c" } as any, { x: 50 }), { x: 50 });
    assert.deepEqual(withoutPlacedXY(null, { id: "c" } as any, { x: 50 }), { x: 50 });
  });
  test("undo labels: a stroke added is one Stroke Change, a flip names itself", () => {
    assert.equal(nodeLabel(["stroke", "strokeWidth"]), "Stroke Change");
    assert.equal(nodeLabel(["stroke", "strokeAlignment", "strokeWidth"]), "Stroke Change");
    assert.equal(nodeLabel(["strokeWidth"]), "Stroke Width Change");
    assert.equal(nodeLabel(["fill", "opacity"]), "Property Change");
    assert.equal(resizeLabel("Flip Horizontal"), "Flip Horizontal");
    assert.equal(resizeLabel("Flip Vertical"), "Flip Vertical");
    assert.equal(resizeLabel("anything"), "Resize");
  });
  test("a text without a family groups as Inter, no em dash", () => {
    assert.equal(textProps({ type: "text", id: "t" } as any).fontFamily, "Inter");
  });
});

describe("server", () => {
  test("Mixed X on a free layer and an auto layout child moves only the free one", async () => {
    const r = await call("/api/update", { ids: ["free", "c1"], props: { x: 50 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("free").x, 50);
    assert.equal(find("c1").x, undefined, "no stray x on the auto layout child");
    const one = await call("/api/update", { id: "c2", props: { x: 9 } });
    assert.equal(one.status, 200);
    assert.equal(find("c2").x, undefined, "nor through a single write");
  });

  test("a value per layer (`each`) is one write and one undo step", async () => {
    const before = (await call(`/api/history${q}`, undefined, "GET")).body.undoDepth;
    const r = await call("/api/update", { ids: ["free", "free2"], props: {}, each: { free: { x: 60 }, free2: { x: 40 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(find("free").x, 60);
    assert.equal(find("free2").x, 40);
    const h = (await call(`/api/history${q}`, undefined, "GET")).body;
    assert.equal(h.undoDepth, before + 1, "one step");
    assert.equal(h.undo, "Position Change");
    await call(`/api/history/undo${q}`, {});
    assert.equal(find("free").x, 50);
    assert.equal(find("free2").x, 30);
    const one = await call("/api/update", { ids: ["free2"], props: {}, each: { free2: { x: 41 } } });
    assert.equal(one.status, 200, "a single layer left after skipping still takes its value");
    assert.equal(find("free2").x, 41);
  });

  test("the Layers outline lists what an instance draws, and reveals a layer inside it", async () => {
    const r = await fetch(`${base}/api/layers${q}&boards=B1&keys=&reveal=${encodeURIComponent("Inst/Lbl")}`);
    const j = (await r.json()) as any;
    const tree = j.boards.find((b: any) => b.id === "B1").tree;
    const inst = tree.c.find((n: any) => n.i === "Inst");
    assert.equal(inst.k, "instance");
    assert.equal(inst.c[0].i, "Inst/Inner");
    assert.equal(inst.c[0].ct, undefined, "nothing inside an instance is a drop target");
    assert.equal(inst.c[0].c[0].i, "Inst/Lbl");
    assert.deepEqual(j.reveal["Inst/Lbl"].path, ["B1", "Inst", "Inst/Inner"]);
  });

  test("Undo of Duplicate selects the original again", async () => {
    const d = await call("/api/structure", { op: "duplicate", ids: ["free"] });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const u = await call(`/api/history/undo${q}`, {});
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.deepEqual(u.body.select, ["free"]);
  });
});
