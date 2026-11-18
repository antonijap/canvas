// Copy and paste across pages and files (src/structure.ts clipboardOp, src/clipcards.ts): the payload carries
// images, components, variables and cards; ids are remapped on a clash; each paste is one undo step.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("clipboard");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_TRUST_FILE = path.join(dir, ".trust.json");
process.env.CANVAS_VIDEO_PROXIES = path.join(dir, ".proxies");

const PNG_A = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const PNG_B = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000020806000000f478d4fa", "hex");

function pkg(name: string, doc: unknown): string {
  const p = path.join(dir, `${name}.canvas`);
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, "document.json"), JSON.stringify(doc, null, 2) + "\n");
  fs.writeFileSync(path.join(p, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }, null, 2) + "\n");
  return fs.realpathSync(p);
}
const A = pkg("A", {
  version: "2.21", themes: { mode: ["light", "dark"] },
  variables: { brand: { type: "color", value: "#FF0000" }, gap: { type: "number", value: 12 } },
  children: [
    { type: "frame", id: "Icon", name: "Icon", reusable: true, x: 0, y: 900, width: 16, height: 16, layout: "none", children: [
      { type: "rectangle", id: "IconR", x: 0, y: 0, width: 16, height: 16, fill: "$brand" },
    ] },
    { type: "frame", id: "Btn", name: "Button", reusable: true, x: 100, y: 900, width: 120, height: 40, layout: "horizontal", gap: "$gap", children: [
      { type: "ref", id: "BtnIcon", ref: "Icon" },
      { type: "text", id: "BtnL", content: "Go", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#000000" },
    ] },
    { type: "frame", id: "BA", name: "Board A", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [
      { type: "rectangle", id: "Pic", x: 10, y: 10, width: 50, height: 50, fill: { type: "image", url: "images/pic.png", mode: "fill" } },
      { type: "rectangle", id: "Pic2", x: 70, y: 10, width: 50, height: 50, fill: { type: "image", url: "images/clash.png", mode: "fill" } },
      { type: "ref", id: "Inst", ref: "Btn", x: 10, y: 100, descendants: { BtnL: { content: "Buy" } } },
      { type: "rectangle", id: "Tok", x: 200, y: 10, width: 20, height: 20, fill: "$brand" },
    ] },
  ],
});
fs.mkdirSync(path.join(A, "images"));
fs.writeFileSync(path.join(A, "images", "pic.png"), PNG_A);
fs.writeFileSync(path.join(A, "images", "clash.png"), PNG_A);
const B = pkg("B", {
  version: "2.21",
  variables: { brand: { type: "color", value: "#0000FF" } },
  children: [
    { type: "frame", id: "BB", name: "Board B", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [] },
    // Same id as a layer in A: the pasted copy must get another id.
    { type: "frame", id: "Tok", name: "Taken id", x: 500, y: 0, width: 10, height: 10, layout: "none", children: [] },
  ],
});
fs.mkdirSync(path.join(B, "images"));
fs.writeFileSync(path.join(B, "images", "clash.png"), PNG_B);

const clip = path.join(dir, "outside", "clip.mp4");
fs.mkdirSync(path.dirname(clip));
fs.writeFileSync(clip, Buffer.alloc(5000, 7));

const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 50_000_000;
history.setClock(() => (clock += 5000));

async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "x-canvas": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
const q = (f: string) => `?file=${encodeURIComponent(f)}`;
const op = (f: string, body: Record<string, unknown>) => call("POST", "/api/structure", { file: f, ...body });
const flush = (f: string) => call("POST", `/api/flush${q(f)}`);
const undo = async (f: string) => { const r = await call("POST", `/api/history/undo${q(f)}`); await flush(f); return r; };
const doc = (f: string) => JSON.parse(fs.readFileSync(path.join(f, "document.json"), "utf8"));
const widgets = (f: string) => JSON.parse(fs.readFileSync(path.join(f, "widgets.json"), "utf8")).widgets as any[];
const bytes = (f: string) => fs.readFileSync(path.join(f, "document.json"), "utf8") + fs.readFileSync(path.join(f, "widgets.json"), "utf8");
const findIn = (list: any[], id: string): any => {
  for (const n of list) {
    if (n.id === id) return n;
    const h = n.children && findIn(n.children, id);
    if (h) return h;
  }
};

describe("layers into another file", () => {
  test("images are copied into the package; a clash of names gets its own file; the token resolves; ids remap", async () => {
    const c = await op(A, { op: "copy", ids: ["Pic", "Pic2", "Tok"] });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const before = bytes(B);
    const p = await op(B, { op: "paste", payload: c.body.payload, place: { parent: "BB" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await flush(B);
    const [pic, pic2, tok] = p.body.select.map((id: string) => findIn(doc(B).children, id));
    assert.equal(pic.fill.url, "images/pic.png", "a free name keeps its path");
    assert.deepEqual(fs.readFileSync(path.join(B, "images", "pic.png")), PNG_A);
    assert.match(pic2.fill.url, /^assets\/clash-[0-9a-f]{8}\.png$/, "B's own clash.png is another image");
    assert.deepEqual(fs.readFileSync(path.join(B, pic2.fill.url)), PNG_A);
    assert.deepEqual(fs.readFileSync(path.join(B, "images", "clash.png")), PNG_B, "B's image is untouched");
    assert.notEqual(tok.id, "Tok", "Tok is taken in B: a fresh id");
    assert.equal(tok.fill, "#FF0000", "B's brand is another colour: the colour A drew");
    assert.equal((await undo(B)).status, 200);
    assert.equal(bytes(B), before, "one undo takes the paste back");
  });

  test("an instance brings its component and the components that one uses; overrides and tokens survive", async () => {
    const c = await op(A, { op: "copy", ids: ["Inst"] });
    const p = await op(B, { op: "paste", payload: c.body.payload, place: { parent: "BB" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await flush(B);
    const d = doc(B);
    const inst = findIn(d.children, p.body.select[0]);
    assert.deepEqual([inst.type, inst.ref], ["ref", "Btn"]);
    assert.deepEqual(inst.descendants, { BtnL: { content: "Buy" } });
    const holder = d.children.find((n: any) => n.metadata?.canvasDeletedComponents === true);
    assert.equal(holder.name, "Components from other files");
    assert.deepEqual(holder.children.map((n: any) => n.id).sort(), ["Btn", "Icon"]);
    assert.equal(findIn(holder.children, "IconR").fill, "#FF0000", "brand differs in B: the value A drew");
    assert.equal(findIn(holder.children, "Btn").gap, 12, "B has no gap variable: its value");
    assert.equal((await undo(B)).status, 200);
    assert.equal(doc(B).children.some((n: any) => n.metadata?.canvasDeletedComponents === true), false);
  });

  test("a payload without definitions (older) still pastes detached layers", async () => {
    const c = await op(A, { op: "copy", ids: ["Inst"] });
    const old = { ...c.body.payload };
    delete old.mains;
    const p = await op(B, { op: "paste", payload: old, place: { parent: "BB" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await flush(B);
    assert.equal(findIn(doc(B).children, p.body.select[0]).type, "frame");
    await undo(B);
  });
});

describe("cards", () => {
  const ids: Record<string, string> = {};
  test("setup: a page and one card of each kind in A", async () => {
    assert.equal((await call("PUT", `/api/pages${q(A)}`, { pages: [{ id: "p1", name: "One", boards: ["BA", "Btn", "Icon"] }, { id: "p2", name: "Two", boards: [] }] })).status, 200);
    assert.equal((await call("PUT", `/api/pages${q(B)}`, { pages: [{ id: "q1", name: "One", boards: ["BB", "Tok"] }, { id: "q2", name: "Two", boards: [] }] })).status, 200);
    const add = async (p: string, body: unknown) => { const r = await call("POST", p + q(A), body); assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body.widget.id as string; };
    ids.todo = await add("/api/widgets", { kind: "todo", name: "List", x: 600, y: 0, config: { title: "Ship", items: [{ text: "One" }, { text: "Two", done: true }] } });
    ids.note = await add("/api/widgets", { kind: "note", name: "Memo", x: 900, y: 0, config: { text: "# Hello\nworld", tone: "yellow" } });
    ids.posthog = await add("/api/widgets", { kind: "posthog", name: "Signups", x: 600, y: 300, config: { host: "https://us.posthog.com", projectId: "123" } });
    ids.shader = await add("/api/shaders", { source: "fn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(0.5, 0.0, 0.0, 1.0); }", name: "Red", x: 900, y: 300 });
    ids.video = await add("/api/videos", { path: clip, name: "Clip", x: 600, y: 600 });
    assert.ok(widgets(A).find((w) => w.id === ids.posthog).config.secret, "a PostHog card names its Keychain item");
  });

  test("same file, another page: every kind, one undo step, the shader keeps its source", async () => {
    const all = Object.values(ids).map((id) => "widget:" + id);
    const c = await op(A, { op: "copy", ids: all });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.payload.cards.length, 5);
    const before = bytes(A);
    const p = await op(A, { op: "paste", payload: c.body.payload, page: "p2", place: { parent: null } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.select.length, 5);
    assert.equal(p.body.widgets.length, 5);
    const made = widgets(A).filter((w) => p.body.select.includes("widget:" + w.id));
    assert.ok(made.every((w) => w.page === "p2"), "on the page the paste happened on");
    assert.ok(made.every((w) => !Object.values(ids).includes(w.id)), "fresh ids");
    const posthog = made.find((w) => w.kind === "posthog");
    assert.deepEqual(posthog.config.secret, widgets(A).find((w) => w.id === ids.posthog).config.secret, "its own file keeps the reference");
    const sh = made.find((w) => w.kind === "shader");
    const src = await (await fetch(`${base}/api/shaders/${sh.id}/source${q(A)}`)).text();
    assert.match(src,/vec4<f32>\(0\.5, 0\.0, 0\.0, 1\.0\)/);
    assert.equal(made.find((w) => w.kind === "video").config.src, widgets(A).find((w) => w.id === ids.video).config.src, "the same media file");
    assert.deepEqual(made.find((w) => w.kind === "todo").config.items.map((i: any) => [i.text, i.done]), [["One", false], ["Two", true]]);
    assert.equal((await undo(A)).status, 200);
    assert.equal(bytes(A), before, "one undo removes all five");
  });

  test("another file: the video is copied in, the shader written, the secret dropped; mixed with layers is one step", async () => {
    const c = await op(A, { op: "copy", ids: ["Tok", ...Object.values(ids).map((id) => "widget:" + id)] });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.ok(!JSON.stringify(c.body.payload).includes("sk_"), "no secret value is ever in the payload");
    const before = bytes(B);
    const p = await op(B, { op: "paste", payload: c.body.payload, page: "q1", place: { parent: null, positions: [{ x: 700, y: 700 }], cards: [{ x: 2000, y: 0 }, null, null, null, null] } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await flush(B);
    assert.equal(p.body.select.length, 6);
    const made = widgets(B);
    assert.equal(made.length, 5);
    assert.ok(made.every((w) => w.page === undefined), "the first page: no page field");
    const todo = made.find((w) => w.kind === "todo");
    assert.deepEqual([todo.x, todo.y], [2000, 0], "the place the page asked for");
    const posthog = made.find((w) => w.kind === "posthog");
    assert.equal(posthog.config.secret, undefined, "never a secret across files: the card asks to connect");
    assert.equal(posthog.config.projectId, "123");
    const video = made.find((w) => w.kind === "video");
    assert.match(video.config.src, /^media\//);
    assert.ok(fs.existsSync(path.join(B, video.config.src)), "the file is in B's package");
    const sh = made.find((w) => w.kind === "shader");
    assert.ok(fs.existsSync(path.join(B, "shaders", `${sh.id}.wgsl`)));
    const tok = findIn(doc(B).children, p.body.select[0]);
    assert.deepEqual([tok.x, tok.y], [700, 700]);
    assert.equal((await undo(B)).status, 200);
    assert.equal(bytes(B), before, "one undo takes layers and cards back");
  });

  test("cut cards and layers: one step; pasted back in the same file they keep their ids", async () => {
    const before = bytes(A);
    const c = await op(A, { op: "cut", ids: ["Tok", "widget:" + ids.note, "widget:" + ids.todo] });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await flush(A);
    assert.equal(widgets(A).some((w) => w.id === ids.note || w.id === ids.todo), false);
    assert.equal(findIn(doc(A).children, "Tok"), undefined);
    const p = await op(A, { op: "paste", fromServer: true, page: "p1", place: { parent: "BA" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body.select, ["Tok", "widget:" + ids.note, "widget:" + ids.todo]);
    assert.equal((await undo(A)).status, 200);
    assert.equal((await undo(A)).status, 200);
    assert.equal(bytes(A), before, "undo of the paste, then of the cut");
  });

  test("cards alone copy, and a paste of nothing is refused", async () => {
    const c = await op(A, { op: "copy", ids: ["widget:" + ids.note] });
    assert.equal(c.status, 200);
    assert.deepEqual(c.body.payload.nodes, []);
    assert.equal((await op(A, { op: "copy", ids: ["widget:nope"] })).status, 400);
    assert.equal((await op(A, { op: "paste", payload: { kind: "canvas/nodes", v: 1, nodes: [], detached: [] }, place: { parent: null } })).status, 400);
  });
});

test("local paste, media creation and history emit one complete action each", async () => {
  const { onAction } = await import("../src/cloud-files-ops.ts");
  const { DocTree } = await import("../src/cloud-files-tree.ts");
  const { applyAction, isReject } = await import("../cloud/core/files/apply.ts");
  const target = pkg("actions", { version: "2.21", children: [] });
  const emitted: import("../cloud/protocol-files.ts").Action[] = [];
  const off = onAction((file, action) => { if (file === path.join(target, "document.json")) emitted.push(action); });
  const env = () => {
    const { widgets, version: _version, ...extra } = JSON.parse(fs.readFileSync(path.join(target, "widgets.json"), "utf8"));
    return { widgets, extra };
  };
  let writers: Record<string, string> = {};
  const check = async (change: () => Promise<any>) => {
    const before = doc(target), side = env();
    emitted.length = 0;
    const r = await change();
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
    await flush(target);
    assert.equal(emitted.length, 1);
    const tree = new DocTree(before, side, [], Object.entries(writers));
    const applied = applyAction(tree, emitted[0]);
    assert.ok(!isReject(applied), JSON.stringify(applied));
    writers = tree.allVers();
    assert.equal(JSON.stringify(tree.doc), JSON.stringify(doc(target)));
    assert.equal(JSON.stringify(tree.envelope), JSON.stringify(env()));
    return emitted[0];
  };
  try {
    const copied = await op(A, { op: "copy", ids: ["Tok"] });
    await check(() => op(target, { op: "paste", payload: copied.body.payload, place: { parent: null } }));
    await check(() => call("POST", `/api/history/undo${q(target)}`));
    await check(() => call("POST", `/api/history/redo${q(target)}`));
    const action = await check(() => call("POST", `/api/shaders${q(target)}`, { source: "fn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.0); }" }));
    assert.ok(action.ops.some((o) => o.k === "blob"));
    assert.ok(action.ops.some((o) => o.k === "widget"));
    const video = await check(() => call("POST", `/api/videos${q(target)}`, { path: clip }));
    assert.ok(video.ops.some((o) => o.k === "blob"));
    assert.ok(video.ops.some((o) => o.k === "widget"));
  } finally { off(); }
});

test("legacy local media adds still carry a confined blob op", async () => {
  const { onAction } = await import("../src/cloud-files-ops.ts");
  const { checkBlobPath } = await import("../cloud/protocol-files.ts");
  const target = pkg("legacy-actions", { version: "2.21", children: [] });
  const source = path.join(dir, "outside", "clip with spaces.mp4");
  fs.copyFileSync(clip, source);
  const actions: import("../cloud/protocol-files.ts").Action[] = [];
  const off = onAction((file, a) => { if (file === path.join(target, "document.json")) actions.push(a); });
  try {
    const r = await call("POST", `/api/videos${q(target)}`, { path: source });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(actions.length, 1);
    const blobs = actions[0].ops.filter((o) => o.k === "blob");
    assert.equal(blobs.length, 1);
    assert.equal(checkBlobPath(blobs[0].path), null);
    assert.equal(r.body.widget.config.src, "media/clip with spaces.mp4");
    assert.equal(fs.readFileSync(path.join(target, r.body.widget.config.src)).length, 5000);
  } finally { off(); }
});
