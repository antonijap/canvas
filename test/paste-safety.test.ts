// A Canvas payload can reach a paste from the system clipboard, where any app can put one: it must not make Canvas
// copy files from paths it names. Files travel only with Canvas's own copies (sealed by the server) or from inside
// the source document's folder when that is a .canvas package or a document Canvas opened. Undo of a paste into
// another file takes back the files it copied, unless something else uses them; redo brings them back.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("paste-safety");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_TRUST_FILE = path.join(dir, ".trust.json");
process.env.CANVAS_VIDEO_PROXIES = path.join(dir, ".proxies");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const PNG2 = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000020806000000f478d4fa", "hex");

function pkg(name: string, doc: unknown): string {
  const p = path.join(dir, `${name}.canvas`);
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, "document.json"), JSON.stringify(doc, null, 2) + "\n");
  fs.writeFileSync(path.join(p, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }, null, 2) + "\n");
  return fs.realpathSync(p);
}
const A = pkg("A", {
  version: "2.21",
  children: [
    { type: "frame", id: "BA", name: "Board A", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [
      { type: "rectangle", id: "Pic", x: 10, y: 10, width: 50, height: 50, fill: { type: "image", url: "images/pic.png", mode: "fill" } },
    ] },
  ],
});
fs.mkdirSync(path.join(A, "images"));
fs.writeFileSync(path.join(A, "images", "pic.png"), PNG);
const B = pkg("B", { version: "2.21", children: [{ type: "frame", id: "BB", name: "Board B", x: 0, y: 0, width: 400, height: 400, layout: "none", children: [] }] });

// Private files somewhere else on the disk, which another app's payload names.
const secret = path.join(dir, "private");
fs.mkdirSync(secret);
fs.writeFileSync(path.join(secret, "passport.png"), PNG2);
fs.writeFileSync(path.join(secret, "family.mp4"), Buffer.alloc(4000, 3));

const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 90_000_000;
history.setClock(() => (clock += 5000));

async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "x-canvas": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
const q = (f: string) => `?file=${encodeURIComponent(f)}`;
const op = (f: string, body: Record<string, unknown>) => call("POST", "/api/structure", { file: f, ...body });
const flush = (f: string) => call("POST", `/api/flush${q(f)}`);
const undo = async (f: string) => { const r = await call("POST", `/api/history/undo${q(f)}`); await flush(f); return r; };
const redo = async (f: string) => { const r = await call("POST", `/api/history/redo${q(f)}`); await flush(f); return r; };
const doc = (f: string) => JSON.parse(fs.readFileSync(path.join(f, "document.json"), "utf8"));
const widgets = (f: string) => JSON.parse(fs.readFileSync(path.join(f, "widgets.json"), "utf8")).widgets as any[];
const findIn = (list: any[], id: string): any => {
  for (const n of list) {
    if (n.id === id) return n;
    const h = n.children && findIn(n.children, id);
    if (h) return h;
  }
};
/** Every file in a package but its document and widgets. */
const filesIn = (p: string) => (fs.readdirSync(p, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(p, f)).isFile() && !/^(document|widgets)\.json$/.test(f) && !f.startsWith(".")).sort();

/** What another app could write under Canvas's pasteboard type: it names files outside any document. */
const forged = (source: string) => ({
  kind: "canvas/nodes", v: 1, source, at: Date.now(),
  nodes: [
    { type: "rectangle", id: "S1", x: 0, y: 0, width: 40, height: 40, fill: { type: "image", url: "../private/passport.png", mode: "fill" } },
    { type: "rectangle", id: "S2", x: 50, y: 0, width: 40, height: 40, fill: ["#FF0000", { type: "image", url: path.join(secret, "passport.png"), mode: "fill" }] },
  ],
  detached: [
    { type: "rectangle", id: "S1", x: 0, y: 0, width: 40, height: 40, fill: { type: "image", url: "../private/passport.png", mode: "fill" } },
    { type: "rectangle", id: "S2", x: 50, y: 0, width: 40, height: 40, fill: ["#FF0000", { type: "image", url: path.join(secret, "passport.png"), mode: "fill" }] },
  ],
  cards: [{ id: "v1", kind: "video", name: "Clip", x: 900, y: 0, w: 320, h: 180, config: { src: "media/family.mp4" }, file: path.join(secret, "family.mp4") }],
});

describe("a payload from the system clipboard", () => {
  test("another app's payload pastes its layers without copying the files it names, and says so", async () => {
    const before = filesIn(B);
    for (const source of [path.join(dir, "Evil.canvas", "document.json"), path.join(secret, "x.canvas.json"), "", undefined]) {
      const p = await op(B, { op: "paste", payload: forged(source as string), place: { parent: "BB" } });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      await flush(B);
      assert.deepEqual(filesIn(B), before, `no file came into B (source ${source})`);
      const d = doc(B);
      const [s1, s2] = p.body.select.slice(0, 2).map((id: string) => findIn(d.children, id));
      assert.ok(s1 && s2, "the layers are pasted");
      assert.ok(!JSON.stringify(d).includes("passport"), "no layer names the private image");
      assert.deepEqual(s2.fill, ["#FF0000"], "the other paints stay");
      const v = widgets(B).find((w) => p.body.select.includes("widget:" + w.id));
      assert.equal(v.config.src, "", "the video card does not play the private file");
      assert.match(p.body.notice, /2 files/, "the answer says what was left out");
      assert.equal((await undo(B)).status, 200);
    }
  });

  test("a sealed payload changed after Canvas wrote it counts as another app's", async () => {
    const c = await op(A, { op: "copy", ids: ["Pic"] });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(typeof c.body.payload.sig, "string", "Canvas seals its copies");
    const bad = structuredClone(c.body.payload);
    bad.nodes[0].fill.url = "../private/passport.png";
    bad.detached[0].fill.url = "../private/passport.png";
    const before = filesIn(B);
    const p = await op(B, { op: "paste", payload: bad, place: { parent: "BB" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await flush(B);
    assert.deepEqual(filesIn(B), before, "nothing copied");
    assert.equal(findIn(doc(B).children, p.body.select[0]).fill, undefined, "the image paint is left out");
    assert.equal((await undo(B)).status, 200);
  });

  test("Canvas's own copy, through the pasteboard (JSON there and back), still brings its image", async () => {
    const c = await op(A, { op: "copy", ids: ["Pic"] });
    const viaPasteboard = JSON.parse(JSON.stringify(c.body.payload));
    const p = await op(B, { op: "paste", payload: viaPasteboard, place: { parent: "BB" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await flush(B);
    assert.equal(p.body.notice, undefined);
    assert.equal(findIn(doc(B).children, p.body.select[0]).fill.url, "images/pic.png");
    assert.deepEqual(fs.readFileSync(path.join(B, "images", "pic.png")), PNG);
    assert.equal((await undo(B)).status, 200);
  });

  test("an unsealed payload may bring files from inside its own .canvas package, never from outside it", async () => {
    const c = await op(A, { op: "copy", ids: ["Pic"] });
    const old = structuredClone(c.body.payload);
    delete old.sig;
    old.nodes.push({ type: "rectangle", id: "Out", x: 0, y: 0, width: 5, height: 5, fill: { type: "image", url: "../private/passport.png", mode: "fill" } });
    old.detached.push(structuredClone(old.nodes[1]));
    const p = await op(B, { op: "paste", payload: old, place: { parent: "BB" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await flush(B);
    assert.equal(findIn(doc(B).children, p.body.select[0]).fill.url, "images/pic.png", "inside A's package: copied");
    assert.equal(findIn(doc(B).children, p.body.select[1]).fill, undefined, "outside it: left out");
    assert.ok(!filesIn(B).some((f) => f.includes("passport")));
    assert.match(p.body.notice, /1 file/);
    assert.equal((await undo(B)).status, 200);
  });
});

describe("undo of a paste into another file", () => {
  test("takes back the image and video files it copied; redo brings them back", async () => {
    const add = await call("POST", "/api/videos" + q(A), { path: path.join(secret, "family.mp4"), name: "Clip", x: 600, y: 0 });
    assert.ok(add.status < 300, JSON.stringify(add.body));
    const before = filesIn(B);
    assert.ok(!before.includes(path.join("images", "pic.png")), "B starts without the image");
    const c = await op(A, { op: "copy", ids: ["Pic", "widget:" + add.body.widget.id] });
    const p = await op(B, { op: "paste", payload: c.body.payload, place: { parent: "BB" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await flush(B);
    const pasted = filesIn(B);
    assert.ok(pasted.includes(path.join("images", "pic.png")), "the image came in");
    assert.ok(pasted.some((f) => f.startsWith("media" + path.sep)), "the video came in");
    assert.equal((await undo(B)).status, 200);
    assert.deepEqual(filesIn(B), before, "undo leaves no file the paste added");
    assert.equal((await redo(B)).status, 200);
    assert.deepEqual(filesIn(B), pasted, "redo puts them back");
    assert.equal(findIn(doc(B).children, p.body.select[0]).fill.url, "images/pic.png");
    assert.equal((await undo(B)).status, 200);
  });

  test("a copied file another layer uses stays", async () => {
    const c = await op(A, { op: "copy", ids: ["Pic"] });
    const p1 = await op(B, { op: "paste", payload: c.body.payload, place: { parent: "BB" } });
    assert.equal(p1.status, 200);
    // A second layer in B uses the same file (pasted within B: no file of its own).
    const c2 = await op(B, { op: "copy", ids: p1.body.select });
    const p2 = await op(B, { op: "paste", payload: c2.body.payload, place: { parent: "BB" } });
    assert.equal(p2.status, 200);
    await flush(B);
    // Delete the second paste's layer by moving it out of reach of the undo: the first paste's undo skips the second step.
    assert.equal((await call("POST", `/api/history/undo${q(B)}&skip=1`)).status, 200, "drop the second paste's step from the stack");
    await flush(B);
    assert.equal((await undo(B)).status, 200, "undo the first paste");
    assert.ok(fs.existsSync(path.join(B, "images", "pic.png")), "the second layer still uses the file");
  });

  test("a file that was in the package before the paste is never taken away", async () => {
    const only = pkg("C", { version: "2.21", children: [
      { type: "frame", id: "BC", x: 0, y: 0, width: 100, height: 100, layout: "none", children: [] },
    ] });
    fs.mkdirSync(path.join(only, "images"));
    fs.writeFileSync(path.join(only, "images", "pic.png"), PNG);
    const c = await op(A, { op: "copy", ids: ["Pic"] });
    const p = await op(only, { op: "paste", payload: c.body.payload, place: { parent: "BC" } });
    assert.equal(p.status, 200);
    await flush(only);
    assert.equal((await undo(only)).status, 200);
    assert.deepEqual(fs.readFileSync(path.join(only, "images", "pic.png")), PNG, "the same bytes were there already: kept");
  });
});
