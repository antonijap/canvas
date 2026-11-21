// Regression tests for bug hunt round 5 (.planning/research/hunt-5-codex.md "codex-server", hunt-5-claude-page.md):
// Save As, shader and widget undo, mixed steps, replay of duplicates, the history budget, ungroup.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { FIXTURE_DOC, tmpDir, writeDoc } from "./helpers.ts";
import type { DocNode } from "../src/engine.ts";

const dir = tmpDir("hunt5");
process.env.CANVAS_ROOTS = dir;
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const { saveAsCanvas } = await import("../src/docpath.ts");
const { storeTestHooks } = await import("../src/widgets/store.ts");
const { duplicateNodes, groupNodes, ungroupNodes, runStructure } = await import("../src/structure.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const docFiles: string[] = [];
after(() => {
  for (const p of docFiles) fs.unwatchFile(p);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 5_000_000;
history.setClock(() => clock);
const later = (ms = 5000) => void (clock += ms);

const user = { "x-canvas": "1" };
const agent = (session = "s5") => ({ "x-canvas": "1", "x-canvas-source": "mcp", "x-canvas-session": session });
async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = user) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j: any = text;
  try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j };
}
async function freshDoc(name: string) {
  const sub = path.join(dir, name);
  fs.mkdirSync(sub, { recursive: true });
  const docFile = writeDoc(sub, name);
  docFiles.push(docFile);
  // the engine refuses the first write after an outside change: spend it here.
  await call("POST", "/api/update", { file: docFile, id: "Scr01", props: {} });
  history.resetHistory();
  later();
  return docFile;
}
const find = (list: DocNode[], id: string): DocNode | undefined => {
  for (const n of list) {
    if (n.id === id) return n;
    const hit = find((n.children as DocNode[]) ?? [], id);
    if (hit) return hit;
  }
};

const OK_A = "fn shade(p: vec2<f32>) -> vec4<f32> {\n  return vec4<f32>(1.0, 0.0, 0.0, 1.0);\n}\n";
const OK_B = "fn shade(p: vec2<f32>) -> vec4<f32> {\n  return vec4<f32>(0.0, 1.0, 0.0, 1.0);\n}\n";

describe("hunt 5: data loss", () => {
  test("codex-server 1: Save As copies shader sources and copied videos, and rewrites the videos' src", () => {
    const sub = path.join(dir, "saveas");
    fs.mkdirSync(path.join(sub, "doc.shaders"), { recursive: true });
    fs.mkdirSync(path.join(sub, "doc.media"), { recursive: true });
    fs.writeFileSync(path.join(sub, "doc.canvas.json"), JSON.stringify(FIXTURE_DOC));
    fs.writeFileSync(path.join(sub, "doc.shaders", "sh_1.wgsl"), OK_B);
    fs.writeFileSync(path.join(sub, "doc.media", "clip.mp4"), "VIDEO");
    fs.writeFileSync(path.join(sub, "doc.widgets.json"), JSON.stringify({ version: 1, widgets: [
      { id: "sh_1", kind: "shader", x: 0, y: 0, w: 100, h: 100, config: { rev: "abc" } },
      { id: "v_1", kind: "video", x: 0, y: 0, w: 100, h: 100, config: { src: "doc.media/clip.mp4", hash: "h" } },
      { id: "v_2", kind: "video", x: 0, y: 0, w: 100, h: 100, config: { src: "/elsewhere/linked.mp4", hash: "h2" } },
    ] }, null, 2));
    const target = saveAsCanvas(path.join(sub, "doc.canvas.json"), path.join(dir, "Copy.canvas"));
    assert.equal(fs.readFileSync(path.join(target, "shaders", "sh_1.wgsl"), "utf8"), OK_B, "the shader's source came along");
    assert.equal(fs.readFileSync(path.join(target, "media", "clip.mp4"), "utf8"), "VIDEO", "the copied video came along");
    const ws = JSON.parse(fs.readFileSync(path.join(target, "widgets.json"), "utf8")).widgets;
    assert.equal(ws[1].config.src, "media/clip.mp4");
    assert.equal(ws[2].config.src, "/elsewhere/linked.mp4", "a linked video stays linked");
  });

  test("codex-server 2: Undo of a shader source change brings the old source back; Redo the new one", async () => {
    const docFile = await freshDoc("shader");
    const q = `?file=${encodeURIComponent(docFile)}`;
    const made = await call("POST", `/api/shaders${q}`, { source: OK_A, x: 0, y: 0, w: 100, h: 100 });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.widget.id;
    later();
    assert.equal((await call("PATCH", `/api/shaders/${id}${q}`, { source: OK_B })).status, 200);
    later();
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    const back = await call("GET", `/api/shaders/${id}/source${q}`);
    assert.equal(back.body, OK_A, "undo restored A's source, not only its rev");
    assert.equal((await call("POST", `/api/history/redo${q}`)).status, 200);
    assert.equal((await call("GET", `/api/shaders/${id}/source${q}`)).body, OK_B);
  });

  test("review: snapshots a step still needs survive pruning; Save As copies the source the config names", async () => {
    const docFile = await freshDoc("shprune");
    const q = `?file=${encodeURIComponent(docFile)}`;
    const made = await call("POST", `/api/shaders${q}`, { source: OK_A, x: 0, y: 0, w: 100, h: 100 });
    const id = made.body.widget.id;
    later();
    for (let i = 0; i < 70; i++) await call("PATCH", `/api/shaders/${id}${q}`, { source: OK_B.replace("0.0, 1.0, 0.0", `0.0, 1.0, ${i}.0`) });
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    // No /source read in between: Save As must still copy A.
    const r = await call("POST", "/api/canvas/save-as", { file: docFile, target: path.join(dir, "Pruned.canvas") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fs.readFileSync(path.join(r.body.file, "shaders", `${id}.wgsl`), "utf8"), OK_A);
  });

  test("codex-server 3: an agent's widget edits split at an outside change; Undo stops there", async () => {
    const docFile = await freshDoc("wext");
    const q = `?file=${encodeURIComponent(docFile)}`;
    const w = await call("POST", `/api/widgets${q}`, { kind: "note", name: "A", x: 0, y: 0 }, user);
    const id = w.body.widget.id;
    later();
    await call("PATCH", `/api/widgets/${id}${q}`, { name: "B" }, agent());
    // Someone edits the sidecar outside Canvas.
    const side = docFile.replace(/\.canvas\.json$/, ".widgets.json");
    const env = JSON.parse(fs.readFileSync(side, "utf8"));
    env.widgets.find((x: any) => x.id === id).name = "C";
    fs.writeFileSync(side, JSON.stringify(env, null, 2));
    await call("PATCH", `/api/widgets/${id}${q}`, { name: "D" }, agent());
    const r = await call("POST", `/api/history/undo${q}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const now = JSON.parse(fs.readFileSync(side, "utf8")).widgets.find((x: any) => x.id === id);
    assert.equal(now.name, "C", "undo stops at the outside value instead of erasing it");
  });

  test("codex-server 4: a mixed Undo whose cards' write fails puts the layers back and can run again", async () => {
    const docFile = await freshDoc("mixed");
    const q = `?file=${encodeURIComponent(docFile)}`;
    const w = await call("POST", `/api/widgets${q}`, { kind: "note", config: { text: "N0" }, x: 0, y: 0 }, user);
    const id = w.body.widget.id;
    later();
    await call("POST", "/api/update", { file: docFile, id: "Scr01", props: { opacity: 0.5 } }, agent("mix"));
    const changed = await call("PATCH", `/api/widgets/${id}${q}`, { config: { text: "N1" } }, agent("mix"));
    assert.equal(changed.status, 200);
    assert.equal(changed.body.widget.name, "N1");
    const fill = () => JSON.parse(fs.readFileSync(docFile, "utf8")).children[0].opacity;
    const card = () => JSON.parse(fs.readFileSync(docFile.replace(/\.canvas\.json$/, ".widgets.json"), "utf8")).widgets[0];
    storeTestHooks.beforeCommit = () => { throw new Error("disk full"); };
    let r;
    try {
      r = await call("POST", `/api/history/undo${q}`);
    } finally {
      storeTestHooks.beforeCommit = undefined;
    }
    assert.notEqual(r.status, 200);
    const { currentDoc } = await import("../src/docwriter.ts");
    assert.equal((currentDoc(docFile).doc.children[0] as DocNode).opacity, 0.5, "the layers' half was put back");
    assert.equal(card().config.text, "N1");
    const again = await call("POST", `/api/history/undo${q}`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(fill(), undefined);
    assert.equal(card().config.text, "N0");
    assert.equal(card().name, "N0");
  });

  test("codex-server 5: a duplicate of a component and its instance replays (component inserted after the instance)", () => {
    const doc = { children: [
      { type: "frame", id: "C", reusable: true, x: 0, y: 0, width: 10, height: 10, layout: "none", children: [] },
      { type: "ref", id: "I", ref: "C", x: 50, y: 0 },
    ] } as any;
    const r = duplicateNodes(structuredClone(doc), ["C", "I"]);
    const replayed = structuredClone(doc);
    assert.doesNotThrow(() => history.replayOps(replayed, r.ops));
    assert.equal(replayed.children.length, 4);
  });

  test("codex-server 6: merged edits count their kept parts, which fold once on disk: the budget holds", () => {
    const docFile = path.join(dir, "budget.canvas.json");
    history.resetHistory(docFile);
    const big = "x".repeat(20000);
    history.compactConfig.afterMs = 0; // every part is old enough to fold here
    for (let i = 0; i < 300; i++) {
      history.record(docFile, [{ t: "node", id: "T", props: { content: { b: { v: big + i }, a: { v: big + (i + 1) } } } }], { label: "Text", mergeKey: "text:T", edit: "e" + i });
    }
    history.compactConfig.afterMs = 2000;
    const e = history.entries(docFile).undo;
    assert.equal(e.length, 1);
    const held = JSON.stringify(e[0]).length;
    assert.ok(held < 200_000, `one step holds ${held} bytes`);
    assert.ok(e[0].bytes >= held / 2, `its budget (${e[0].bytes}) counts what it holds (${held})`);
  });
});

describe("hunt 5: ungroup", () => {
  const row = (kids: DocNode[]) => ({ children: [{ type: "frame", id: "F", x: 0, y: 0, width: 1000, height: 200, layout: "horizontal", children: kids }] }) as any;

  test("codex-server 7: Group then Ungroup keeps absolute layers absolute, where they were", () => {
    const doc = row([
      { type: "rectangle", id: "A", layoutPosition: "absolute", x: 10, y: 10, width: 20, height: 20 },
      { type: "rectangle", id: "B", layoutPosition: "absolute", x: 50, y: 30, width: 20, height: 20 },
    ]);
    const g = groupNodes(doc, ["A", "B"]);
    ungroupNodes(doc, g.select);
    for (const [id, x, y] of [["A", 10, 10], ["B", 50, 30]] as const) {
      const n = find(doc.children, id)!;
      assert.equal(n.layoutPosition, "absolute", id);
      assert.deepEqual([n.x, n.y], [x, y], id);
    }
  });

  test("codex-server 8: a filling layer keeps its drawn size when its frame is ungrouped", () => {
    const doc = row([{ type: "frame", id: "G", width: 100, height: 50, layout: "vertical", children: [{ type: "rectangle", id: "T", width: "fill_container", height: 20 }] }]);
    ungroupNodes(doc, ["G"], { G: { x: 0, y: 0, w: 100, h: 50 }, T: { x: 0, y: 0, w: 100, h: 20 } });
    assert.equal(find(doc.children, "T")!.width, 100);
  });

  test("codex-server 9: ungrouping a rotated, flipped group keeps each layer's turn and place", () => {
    const doc = { children: [{ type: "frame", id: "Bd", x: 0, y: 0, width: 500, height: 500, layout: "none", children: [
      { type: "group", id: "G", x: 100, y: 100, rotation: 90, children: [{ type: "rectangle", id: "R", x: 10, y: 0, width: 20, height: 10 }] },
      { type: "group", id: "H", x: 300, y: 300, flipX: true, children: [{ type: "rectangle", id: "S", x: 10, y: 0, rotation: 30, width: 20, height: 10 }] },
    ] }] } as any;
    ungroupNodes(doc, ["G", "H"]);
    const r = find(doc.children, "R")!, s = find(doc.children, "S")!;
    assert.equal(r.rotation, 90);
    assert.deepEqual([r.x, r.y], [100, 90]);
    assert.equal(s.flipX, true);
    assert.equal(s.rotation, 330, "one flip mirrors the layer's own turn");
    assert.deepEqual([s.x, s.y], [290, 300]);
  });
});

describe("hunt 5: one step for a mixed delete", () => {
  test("claude 6: cards and layers deleted together undo in one step", async () => {
    const docFile = await freshDoc("mixdel");
    const q = `?file=${encodeURIComponent(docFile)}`;
    const w = await call("POST", `/api/widgets${q}`, { kind: "note", name: "N", x: 0, y: 0 });
    const id = w.body.widget.id;
    later();
    const key = "group:delete-test1";
    assert.equal((await call("DELETE", `/api/widgets/${id}${q}`, undefined, { ...user, "x-canvas-merge": key })).status, 200);
    assert.equal((await call("POST", "/api/structure", { file: docFile, op: "delete", ids: ["Scr02"], merge: key })).status, 200);
    const st = history.entries(docFile).undo;
    assert.equal(st.length, 2, "the note's add, then one delete step");
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    const { currentDoc } = await import("../src/docwriter.ts");
    assert.ok(currentDoc(docFile).doc.children.some((n: any) => n.id === "Scr02"));
    assert.equal(JSON.parse(fs.readFileSync(docFile.replace(/\.canvas\.json$/, ".widgets.json"), "utf8")).widgets.length, 1);
    void runStructure;
  });
});
