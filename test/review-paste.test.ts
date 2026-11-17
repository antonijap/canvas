// Codex review of the 2026-11-16 merges, the paste and file findings (docs/evidence/review-fixes.md):
// a1 a forged payload names a private file under metadata.fonts and the paste copied it; c1 (server half) Save As
// and a paste copy only images, videos and fonts by their bytes, and nothing from a hidden folder outside the
// document's; a2 redo keeps the original bytes when another app wrote the same path meanwhile; a3 an undo that
// stashes a pasted file never stashes one a paste in the gap now uses.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("review-paste");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_TRUST_FILE = path.join(dir, ".trust.json");
process.env.CANVAS_VIDEO_PROXIES = path.join(dir, ".proxies");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const PNG2 = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000020806000000f478d4fa", "hex");
// What a private key file starts with (built, so the repo scan for committed keys does not flag this test).
const KEY_TEXT = ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" ") + "\nnot a real key\n";

function pkg(name: string, doc: unknown, at = dir): string {
  const p = path.join(at, `${name}.canvas`);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "document.json"), JSON.stringify(doc, null, 2) + "\n");
  fs.writeFileSync(path.join(p, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }, null, 2) + "\n");
  return fs.realpathSync(p);
}
const board = (id: string, children: unknown[] = []) => ({ type: "frame", id, name: id, x: 0, y: 0, width: 400, height: 400, layout: "none", children });
const A = pkg("A", { version: "2.21", children: [board("BA", [
  { type: "rectangle", id: "Pic", x: 10, y: 10, width: 50, height: 50, fill: { type: "image", url: "images/pic.png", mode: "fill" } },
])] });
fs.mkdirSync(path.join(A, "images"));
fs.writeFileSync(path.join(A, "images", "pic.png"), PNG);
const B = pkg("B", { version: "2.21", children: [board("BB")] });

const secret = path.join(dir, "private");
fs.mkdirSync(secret);
fs.writeFileSync(path.join(secret, "passport.png"), PNG2);

const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const S = await import("../src/structure.ts");
const D = await import("../src/docpath.ts");
const PF = await import("../src/pastefiles.ts");
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
const redo = async (f: string) => { const r = await call("POST", `/api/history/redo${q(f)}`); await flush(f); return r; };
const doc = (f: string) => JSON.parse(fs.readFileSync(path.join(f, "document.json"), "utf8"));
const filesIn = (p: string) => (fs.readdirSync(p, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(p, f)).isFile() && !/^(document|widgets)\.json$/.test(f) && !f.startsWith(".")).sort();
const findIn = (list: any[], id: string): any => {
  for (const n of list) {
    if (n.id === id) return n;
    const h = n.children && findIn(n.children, id);
    if (h) return h;
  }
};

describe("a1: every file reference in a payload from the clipboard is screened", () => {
  /** Another app's payload: claims to come from A (a real package), names a file outside it under metadata.fonts. */
  const forged = () => ({
    kind: "canvas/nodes", v: 1, source: path.join(A, "document.json"), at: Date.now(),
    nodes: [{ type: "rectangle", id: "F1", x: 0, y: 0, width: 40, height: 40, fill: "#FF0000", metadata: { fonts: [{ family: "X", url: "../private/passport.png" }] } }],
    detached: [{ type: "rectangle", id: "F1", x: 0, y: 0, width: 40, height: 40, fill: "#FF0000", metadata: { fonts: [{ family: "X", url: "../private/passport.png" }] } }],
  });

  test("screenPayload drops a font url outside the source package and counts it", () => {
    const r = S.screenPayload(forged() as any, path.join(B, "document.json"));
    assert.equal(r.dropped, 1, "the font url is a file reference like an image fill");
    assert.ok(!JSON.stringify(r.payload).includes("passport"), JSON.stringify(r.payload));
  });

  test("the paste copies nothing and says so", async () => {
    const before = filesIn(B);
    const p = await op(B, { op: "paste", payload: forged(), place: { parent: "BB" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await flush(B);
    assert.deepEqual(filesIn(B), before, "no file came into B");
    assert.ok(!JSON.stringify(doc(B)).includes("passport"));
    assert.match(p.body.notice ?? "", /1 file/);
    assert.equal((await undo(B)).status, 200);
  });
});

describe("c1 (server half): only media files travel, never from a hidden folder", () => {
  test("Save As refuses a private key named as an image fill, and a fake image", () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), KEY_TEXT);
    fs.writeFileSync(path.join(home, "notes.png"), "not a picture at all");
    fs.mkdirSync(path.join(home, ".private"), { recursive: true });
    fs.writeFileSync(path.join(home, ".private", "real.png"), PNG);
    fs.writeFileSync(path.join(home, "ok.png"), PNG);
    const src = pkg("Design", { version: "2.21", children: [board("S", [
      { type: "rectangle", id: "K", x: 0, y: 0, width: 10, height: 10, fill: { type: "image", url: "../.ssh/id_rsa" } },
      { type: "rectangle", id: "N", x: 0, y: 0, width: 10, height: 10, fill: { type: "image", url: "../notes.png" } },
      { type: "rectangle", id: "H", x: 0, y: 0, width: 10, height: 10, fill: { type: "image", url: "../.private/real.png" } },
      { type: "rectangle", id: "O", x: 0, y: 0, width: 10, height: 10, fill: { type: "image", url: "../ok.png" } },
    ])] }, path.join(home, "Documents"));
    // The package sits in home/Documents: its refs climb one more level.
    const d = JSON.parse(fs.readFileSync(path.join(src, "document.json"), "utf8"));
    for (const n of d.children[0].children) n.fill.url = "../" + n.fill.url;
    fs.writeFileSync(path.join(src, "document.json"), JSON.stringify(d));
    const warnings: string[] = [];
    const out = D.saveAsCanvas(src, path.join(dir, "Copy.canvas"), warnings);
    const linked = fs.existsSync(path.join(out, "linked")) ? fs.readdirSync(path.join(out, "linked")) : [];
    assert.deepEqual(linked.map((f) => f.replace(/^[0-9a-f]{8}-/, "")), ["ok.png"], `only the real picture outside a hidden folder: ${linked.join(", ")}`);
    for (const f of linked) assert.ok(!fs.readFileSync(path.join(out, "linked", f), "utf8").includes("PRIVATE KEY"));
    assert.equal(warnings.length, 3, warnings.join(" | "));
  });

  test("a paste from another document copies a picture but not a text file named .png", () => {
    fs.writeFileSync(path.join(A, "images", "fake.png"), "plain text, not a picture");
    const payload = {
      kind: "canvas/nodes", v: 1, source: path.join(A, "document.json"), at: Date.now(),
      nodes: [
        { type: "rectangle", id: "R1", x: 0, y: 0, width: 4, height: 4, fill: { type: "image", url: "images/fake.png" } },
        { type: "rectangle", id: "R2", x: 0, y: 0, width: 4, height: 4, fill: { type: "image", url: "images/pic.png" } },
      ],
      detached: [],
    };
    const dest = pkg("PlanDest", { version: "2.21", children: [] });
    const created: string[] = [];
    const m = S.planAssets(payload as any, path.join(dest, "document.json"), created);
    assert.equal(m.get("images/pic.png"), "images/pic.png");
    assert.equal(m.has("images/fake.png"), false, "a file that is no image by its bytes stays where it is");
    assert.equal(fs.existsSync(path.join(dest, "images", "fake.png")), false);
    fs.rmSync(path.join(A, "images", "fake.png"));
  });

  test("mediaKind reads the bytes, not the name", () => {
    const f = path.join(dir, "probe.bin");
    const kinds: [Buffer, string | null][] = [
      [PNG, "image"], [Buffer.from("ffd8ffe000104a464946", "hex"), "image"], [Buffer.from("GIF89a...."), "image"],
      [Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]), "image"],
      [Buffer.from("<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), "image"],
      [Buffer.concat([Buffer.from("00000018", "hex"), Buffer.from("ftypmp42")]), "video"],
      [Buffer.from("1a45dfa3", "hex"), "video"],
      [Buffer.from("00010000000c", "hex"), "font"], [Buffer.from("wOF2...."), "font"], [Buffer.from("OTTO...."), "font"],
      [Buffer.from(KEY_TEXT), null], [Buffer.from("hello"), null], [Buffer.alloc(0), null],
    ];
    for (const [bytes, want] of kinds) {
      fs.writeFileSync(f, bytes);
      assert.equal(D.mediaKind(f), want, bytes.toString("hex").slice(0, 24));
    }
  });
});

describe("a2: redo after another app wrote the pasted file's path", () => {
  test("keeps the original bytes beside the new ones instead of deleting them", async () => {
    const dest = pkg("Redo", { version: "2.21", children: [board("BR")] });
    const c = await op(A, { op: "copy", ids: ["Pic"] });
    const p = await op(dest, { op: "paste", payload: c.body.payload, place: { parent: "BR" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await flush(dest);
    const img = path.join(dest, "images", "pic.png");
    assert.deepEqual(fs.readFileSync(img), PNG);
    assert.equal((await undo(dest)).status, 200);
    assert.equal(fs.existsSync(img), false, "undo stashed the pasted file");
    // Another app writes different bytes at the same path.
    fs.mkdirSync(path.dirname(img), { recursive: true });
    fs.writeFileSync(img, PNG2);
    assert.equal((await redo(dest)).status, 200);
    assert.deepEqual(fs.readFileSync(img), PNG2, "the other app's file stays as it is");
    const kept = filesIn(dest).filter((f) => f !== path.join("images", "pic.png"));
    assert.equal(kept.length, 1, `the original bytes are kept beside it: ${filesIn(dest).join(", ")}`);
    assert.deepEqual(fs.readFileSync(path.join(dest, kept[0])), PNG);
  });

  test("the same bytes there already: the stash goes, nothing is duplicated", async () => {
    const dest = pkg("RedoSame", { version: "2.21", children: [board("BS")] });
    const c = await op(A, { op: "copy", ids: ["Pic"] });
    assert.equal((await op(dest, { op: "paste", payload: c.body.payload, place: { parent: "BS" } })).status, 200);
    await flush(dest);
    assert.equal((await undo(dest)).status, 200);
    const img = path.join(dest, "images", "pic.png");
    fs.mkdirSync(path.dirname(img), { recursive: true });
    fs.writeFileSync(img, PNG);
    assert.equal((await redo(dest)).status, 200);
    assert.deepEqual(filesIn(dest), [path.join("images", "pic.png")]);
  });
});

describe("a3: a paste in the gap of an undo's file moves", () => {
  test("the file the new paste reuses is not stashed by the undo that began before it", async () => {
    const dest = pkg("Gap", { version: "2.21", children: [board("BG")] });
    const docFile = path.join(dest, "document.json");
    const c = await op(A, { op: "copy", ids: ["Pic"] });
    const p1 = await op(dest, { op: "paste", payload: c.body.payload, place: { parent: "BG" } });
    assert.equal(p1.status, 200);
    await flush(dest);
    const img = path.join(dest, "images", "pic.png");
    // The undo's ops already ran (the layer is gone); its files hook starts and yields at its first await.
    const undone = await op(dest, { op: "delete", ids: p1.body.select });
    assert.equal(undone.status, 200);
    const list = [{ path: img } as { path: string; stash?: string }];
    // Fault injection: the undo's move waits at its await until the other tab's paste is in.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    PF.settleHooks.beforeMove = () => gate;
    const settling = PF.settleFiles(docFile, list, "undo");
    // Another tab pastes the same image while the undo's move is in flight: planAssets sees the bytes there and reuses them.
    const p2 = await op(dest, { op: "paste", payload: c.body.payload, place: { parent: "BG" } });
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    release();
    await settling;
    PF.settleHooks.beforeMove = undefined;
    await flush(dest);
    const url = findIn(doc(dest).children, p2.body.select[0]).fill.url;
    assert.ok(fs.existsSync(path.join(dest, url)), `the second paste's image ${url} is there`);
  });
});
