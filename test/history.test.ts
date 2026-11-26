// Undo/redo (src/history.ts) against a real server: inspector and agent node edits, widgets, todo actions,
// pages, merging, conflicts, redo clearing and the history event on the page stream.

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, beforeEach, describe, test } from "node:test";
import { FIXTURE_DOC, sseClient, tmpDir, writeDoc } from "./helpers.ts";

const dir = tmpDir("history");
process.env.CANVAS_ROOTS = dir;
const docFile = writeDoc(dir);
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(() => {
  fs.unwatchFile(docFile);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let clock = 1_000_000;
history.setClock(() => clock);
const later = (ms = 2000) => void (clock += ms);
beforeEach(async () => {
  fs.writeFileSync(docFile, JSON.stringify(FIXTURE_DOC, null, 2));
  fs.rmSync(docFile.replace(/\.canvas\.json$/, ".widgets.json"), { force: true });
  // the engine refuses the first write after an outside change (and then forgets it); spend that refusal here.
  await edit("Scr01", {});
  history.resetHistory();
  later();
});

const q = `?file=${encodeURIComponent(docFile)}`;
const user = { "x-canvas": "1" };
const agent = (session = "s1") => ({ "x-canvas": "1", "x-canvas-source": "mcp", "x-canvas-session": session });
async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = user) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const edit = (id: string, props: Record<string, unknown>, headers = user, remove?: string[]) => call("POST", "/api/update", { file: docFile, id, props, remove }, headers);
const undo = () => call("POST", `/api/history/undo${q}`);
const redo = () => call("POST", `/api/history/redo${q}`);
const state = async () => (await call("GET", `/api/history${q}`)).body;
const node = (id: string) => JSON.parse(fs.readFileSync(docFile, "utf8")).children.find((n: any) => n.id === id);
const widgets = () => {
  try {
    return JSON.parse(fs.readFileSync(docFile.replace(/\.canvas\.json$/, ".widgets.json"), "utf8"));
  } catch {
    return { widgets: [] };
  }
};
/** An edit somebody made outside Canvas (another app, git). */
function external(id: string, props: Record<string, unknown>) {
  const doc = JSON.parse(fs.readFileSync(docFile, "utf8"));
  Object.assign(doc.children.find((n: any) => n.id === id), props);
  fs.writeFileSync(docFile, JSON.stringify(doc, null, 2));
}

describe("node edits", () => {
  test("undo restores a subtree with a repaired keyframe fallback and redo removes it", async () => {
    const keys = [{ t: 0, v: 1 }, { t: 300, v: 0.5 }];
    const track = { prop: "opacity", keys, from: 1, to: 0, delay: 0, duration: 300 };
    external("Scr01", { children: [{ id: "fade-layer", type: "rectangle", width: 20, height: 20,
      motion: [{ id: "fade", on: "boardHover", tracks: [track] }],
    }] });
    await edit("Scr02", {});
    const deleted = await call("POST", "/api/structure", { file: docFile, op: "delete", ids: ["Scr01"] });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(node("Scr01"), undefined);
    const restored = await undo();
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(node("Scr01").children[0].motion[0].tracks[0], { ...track, to: 0.5 });
    assert.equal((await redo()).status, 200);
    assert.equal(node("Scr01"), undefined);
  });

  test("undo restores, redo reapplies, labels name the property", async () => {
    assert.equal((await edit("Scr01", { fill: "#FF0000" })).status, 200);
    assert.equal((await state()).undo, "Fill Change");
    const u = await undo();
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.label, "Fill Change");
    assert.equal(node("Scr01").fill, undefined);
    assert.equal((await state()).redo, "Fill Change");
    assert.equal((await redo()).status, 200);
    assert.equal(node("Scr01").fill, "#FF0000");
    const empty = await redo();
    assert.equal(empty.status, 409);
    assert.equal(empty.body.code, "empty");
  });

  test("a removed property comes back on undo", async () => {
    await edit("Scr02", { opacity: 0.5 });
    later();
    await edit("Scr02", {}, user, ["opacity"]);
    assert.equal(node("Scr02").opacity, undefined);
    await undo();
    assert.equal(node("Scr02").opacity, 0.5);
    await undo();
    assert.equal(node("Scr02").opacity, undefined);
  });

  test("undo and redo put a removed or added property back where it was in the node (qa: byte-for-byte undo)", async () => {
    const keys = (id: string) => Object.keys(node(id)).join(",");
    const k0 = keys("Scr01");
    await edit("Scr01", {}, user, ["x", "y"]);
    await undo();
    assert.equal(keys("Scr01"), k0, "x and y back before width");
    await redo();
    await undo();
    assert.equal(keys("Scr01"), k0);
    later();
    // An added property sits where it was added, again after an undo and a redo.
    await edit("Scr01", { opacity: 0.5 });
    const k1 = keys("Scr01");
    later();
    await edit("Scr01", {}, user, ["opacity"]);
    await undo();
    assert.equal(keys("Scr01"), k1);
  });

  test("rapid edits of the same field are one step; a pause or another field starts a new one", async () => {
    await edit("Scr01", { width: 400 });
    clock += 200;
    await edit("Scr01", { width: 410 });
    clock += 200;
    await edit("Scr01", { width: 420 });
    assert.equal((await state()).undoDepth, 1);
    clock += 900;
    await edit("Scr01", { width: 430 });
    clock += 100;
    await edit("Scr01", { height: 900 });
    assert.equal((await state()).undoDepth, 3);
    await undo();
    await undo();
    assert.equal(node("Scr01").width, 420);
    await undo();
    assert.equal(node("Scr01").width, 390);
  });

  test("a new edit clears redo", async () => {
    await edit("Scr01", { opacity: 0.3 });
    await undo();
    assert.equal((await state()).redoDepth, 1);
    await edit("Scr01", { opacity: 0.7 });
    assert.equal((await state()).redoDepth, 0);
    assert.equal((await redo()).body.code, "empty");
  });

  test("an outside change to another node does not block undo; one to the same property refuses, then skips", async () => {
    await edit("Scr01", { fill: "#00FF00" });
    external("Scr02", { fill: "#123456" });
    const u = await undo();
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(node("Scr01").fill, undefined);
    assert.equal(node("Scr02").fill, "#123456");

    later();
    await edit("Scr01", { fill: "#0000FF" });
    external("Scr01", { fill: "#ABCDEF" });
    const refused = await undo();
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "conflict");
    assert.match(refused.body.error, /Can't undo Fill Change: "Screen" fill changed since\. Nothing was changed\. Undo again to skip/);
    assert.equal(node("Scr01").fill, "#ABCDEF");
    assert.equal(refused.body.state.undo, "Fill Change", "the blocked step stays");
    const skipped = await undo();
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.skipped, true);
    assert.equal(node("Scr01").fill, "#ABCDEF");
    assert.equal((await state()).undoDepth, 0);
  });
});

describe("agent edits", () => {
  test("everything one MCP session does up to finish_work is one step named by its summary", async () => {
    await edit("Scr01", { fill: "#111111" }, agent());
    await edit("Scr02", { fill: "#222222" }, agent());
    const w = await call("POST", `/api/widgets${q}`, { kind: "note", x: 0, y: 0 }, agent());
    assert.equal(w.status, 201);
    let s = await state();
    assert.equal(s.undoDepth, 1);
    assert.equal(s.undo, "Agent Edits");
    assert.equal(s.agentOpen, true);
    const fin = await call("POST", "/api/bridge/finish", { summary: "Darker screens", sound: false }, agent());
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    s = await state();
    assert.equal(s.undo, "Agent: Darker screens");
    assert.equal(s.agentOpen, false);
    const u = await undo();
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(node("Scr01").fill, undefined);
    assert.equal(node("Scr02").fill, undefined);
    assert.equal(widgets().widgets.length, 0);
    await redo();
    assert.equal(node("Scr02").fill, "#222222");
    assert.equal(widgets().widgets.length, 1);
    await call("DELETE", `/api/widgets/${w.body.widget.id}${q}`);
  });

  test("a person's edit in between splits the agent's work; finish_work names both parts; sessions stay apart", async () => {
    await edit("Scr01", { opacity: 0.1 }, agent("a"));
    await edit("Scr02", { opacity: 0.2 }, user);
    await edit("Scr01", { opacity: 0.3 }, agent("a"));
    await edit("Scr02", { rotation: 5 }, agent("b"));
    assert.equal((await state()).undoDepth, 4);
    await call("POST", "/api/bridge/finish", { summary: "Fade", sound: false }, agent("a"));
    const e = history.entries(docFile).undo.map((x) => x.label);
    assert.deepEqual(e, ["Agent: Fade", "Opacity Change", "Agent: Fade", "Agent Edits"]);
  });
});

describe("widgets and pages", () => {
  test("add, move, todo actions and delete each undo; delete comes back where it was", async () => {
    const a = (await call("POST", `/api/widgets${q}`, { kind: "todo", x: 10, y: 10 })).body.widget;
    later();
    const b = (await call("POST", `/api/widgets${q}`, { kind: "note", x: 500, y: 10 })).body.widget;
    later();
    await call("PATCH", `/api/widgets/${a.id}${q}`, { x: 100, y: 120 });
    assert.equal((await state()).undo, "Move Widget");
    later();
    await call("POST", `/api/widgets/${a.id}/actions/addItem${q}`, { text: "Ship it" });
    assert.equal((await state()).undo, "Add To-Do");
    later();
    await call("DELETE", `/api/widgets/${a.id}${q}`);
    assert.deepEqual(widgets().widgets.map((w: any) => w.id), [b.id]);
    await undo();
    assert.deepEqual(widgets().widgets.map((w: any) => w.id), [a.id, b.id], "restored at its old index");
    assert.equal(widgets().widgets[0].config.items.length, 1);
    await undo();
    assert.equal(widgets().widgets[0].config.items.length, 0);
    await undo();
    assert.equal(widgets().widgets[0].x, 10);
    await undo();
    await undo();
    assert.equal(widgets().widgets.length, 0);
  });

  test("a widget moved again behind the history refuses undo of the move", async () => {
    const a = (await call("POST", `/api/widgets${q}`, { kind: "note", x: 0, y: 0 })).body.widget;
    later();
    await call("PATCH", `/api/widgets/${a.id}${q}`, { x: 50 });
    // Somebody edits the sidecar by hand.
    const f = docFile.replace(/\.canvas\.json$/, ".widgets.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.widgets[0].x = 70;
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
    const r = await undo();
    assert.equal(r.status, 409);
    assert.match(r.body.error, /widget "Page"/);
    assert.equal((await undo()).body.skipped, true);
    // Undoing the add would delete a widget someone has changed since: refused too.
    assert.equal((await undo()).status, 409);
    assert.equal(widgets().widgets.length, 1);
  });

  test("page create, rename and delete undo, with the board and widget a deleted page took along", async () => {
    const p = (await call("POST", `/api/pages${q}`, { name: "Second", boards: ["Scr02"] })).body;
    assert.equal((await state()).undo, "New Page");
    const pid = p.result;
    later();
    await call("PATCH", `/api/pages/${pid}${q}`, { name: "Renamed" });
    assert.equal((await state()).undo, "Rename Page");
    later();
    const w = (await call("POST", `/api/widgets${q}`, { kind: "note", x: 0, y: 0, page: pid })).body.widget;
    later();
    await call("DELETE", `/api/pages/${pid}${q}`);
    assert.equal(widgets().widgets.length, 0, "the page's card went with it");
    assert.equal(node("Scr02"), undefined, "so did its board");
    assert.equal(widgets().pages.length, 1);
    assert.equal((await state()).undo, "Delete Page");
    await undo();
    assert.equal(node("Scr02").id, "Scr02");
    assert.equal(widgets().pages[1].name, "Renamed");
    assert.deepEqual(widgets().pages[1].boards, ["Scr02"]);
    assert.equal(widgets().widgets.find((x: any) => x.id === w.id).page, pid);
    await undo();
    await undo();
    assert.equal(widgets().pages[1].name, "Second");
    await undo();
    assert.equal(widgets().pages, undefined, "the file goes back to having no pages");
  });
});

describe("pages hear the history", () => {
  test("the stream starts with the history and sends each change", async () => {
    const es = sseClient(`${base}/events${q}`);
    try {
      await es.until(() => es.events.some((e) => e.event === "history"));
      await edit("Scr01", { cornerRadius: 8 });
      await es.until(() => es.events.some((e) => e.event === "history" && e.data.undo === "Corner Radius Change"));
      await undo();
      await es.until(() => es.events.some((e) => e.event === "history" && e.data.redo === "Corner Radius Change" && e.data.undo === null));
    } finally {
      es.close();
    }
  });

  test("the page script still parses", async () => {
    const html = await (await fetch(`${base}/${q}`)).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.some((s) => s.includes("historyStep")));
    for (const s of scripts) assert.doesNotThrow(() => new Function(s));
  });
});

describe("history limits", () => {
  test("capped at 200 steps", async () => {
    for (let i = 0; i < 205; i++) history.record(docFile, [{ t: "node", id: "Scr01", props: { x: { b: { v: i }, a: { v: i + 1 } } } }], { label: "Position Change" });
    assert.equal(history.entries(docFile).undo.length, 200);
  });
});

describe("undo labels (maintainer sweep)", () => {
  test("property keys read as names; toggling auto letter spacing (metadata only) is 'Auto Letter Spacing'", () => {
    assert.equal(history.nodeLabel(["metadata"]), "Auto Letter Spacing");
    assert.equal(history.nodeLabel(["letterSpacing", "metadata"]), "Letter Spacing Change");
    assert.equal(history.nodeLabel(["fontSize"]), "Font Size Change");
    assert.equal(history.nodeLabel(["fill"]), "Fill Change");
    assert.equal(history.nodeLabel(["width", "height"]), "Size Change");
    assert.equal(history.nodeLabel(["fill", "opacity"]), "Property Change");
  });
});

describe("key order through structure ops (qa matrix: auto layout on a group, undone)", () => {
  test("a node op recorded from propsOf keeps where children sat", async () => {
    const { Recorder } = await import("../src/structure.ts");
    const doc: any = { children: [{ type: "group", id: "G", name: "G", x: 1, y: 2, children: [{ type: "rectangle", id: "R", x: 0, y: 0, width: 5, height: 5 }] }] };
    const before = JSON.stringify(doc);
    const rec = new Recorder(doc);
    rec.props("G", {}, ["x", "y"]);
    const [op] = rec.ops as any[];
    // Undo it the way history does: put x and y back, then the recorded order.
    const g = doc.children[0];
    Object.assign(g, { x: 1, y: 2 });
    history.orderKeys(g, op.keys.b);
    assert.equal(JSON.stringify(doc), before);
  });
});
