// Regression tests for bug hunt round 6 (.planning/research/hunt-6-textedit-meter.md and hunt-6-codex.md 1-3):
// inline text editing. The server half (UTF-8 bodies, size limits, a deleted or variable-bound text) runs against
// a real server; the page half (src/page/text-edit.js attach) runs on a small stand-in DOM, enough for the editor.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { after, beforeEach, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
// @ts-ignore: a plain ES module the page imports too
import * as T from "../src/page/text-edit.js";

// ---------------------------------------------------------------- the server half

const dir = tmpDir("hunt6");
process.env.CANVAS_ROOTS = dir;
const DOC = {
  version: "2.21",
  variables: { greeting: { type: "string", value: "Hi there" } },
  children: [
    { type: "frame", id: "B1", name: "Board", x: 0, y: 0, width: 400, height: 300, layout: "none", children: [
      { type: "text", id: "T", x: 10, y: 10, content: "Hello", fontFamily: "Inter", fontSize: 14 },
      { type: "text", id: "V", x: 10, y: 40, content: "$greeting", fontFamily: "Inter", fontSize: 14 },
      { type: "text", id: "Dollar", x: 10, y: 70, content: "$5 off", fontFamily: "Inter", fontSize: 14 },
      { type: "ref", id: "Inst", ref: "Btn", x: 100, y: 100, descendants: { BtnLabel: { type: "text", id: "RepT", content: "Rep", fontFamily: "Inter" } } },
    ] },
    { type: "frame", id: "Btn", reusable: true, x: 600, y: 0, width: 80, height: 30, layout: "horizontal", children: [
      { type: "text", id: "BtnLabel", content: "Go", fontFamily: "Inter", fontSize: 13 },
    ] },
  ],
};
const file = path.join(dir, "t.canvas.json");
fs.writeFileSync(file, JSON.stringify(DOC));
const { startServer } = await import("../src/server.ts");
const { readBodyText } = await import("../src/body.ts");
const pw = await import("../src/docwriter.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  fs.unwatchFile(file);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 12_000_000;
history.setClock(() => clock);

async function call(p: string, body: unknown) {
  const r = await fetch(base + p, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  let j: any = t;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}
const text = (id: string, content: unknown) => call("/api/text", { file, id, content });
const find = (id: string) => {
  const seek = (ns: any[]): any => { for (const n of ns) { if (n.id === id) return n; const h = n.children && seek(n.children); if (h) return h; } };
  return seek((pw.currentDoc(file).doc as any).children);
};

describe("server: text bodies", () => {
  beforeEach(async () => {
    fs.writeFileSync(file, JSON.stringify(DOC));
    await call("/api/update", { file, id: "B1", props: {} }); // the first-write refusal after an outside change
    history.resetHistory();
    clock += 5000;
  });

  test("finding 3: a long non-ASCII text survives the 64 KB chunk boundaries (no U+FFFD)", async () => {
    const s = "Ž😀".repeat(60_000); // 180 000 UTF-16 units, about 420 KB of UTF-8
    const r = await text("T", s);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const got = find("T").content as string;
    assert.equal((got.match(/�/g) || []).length, 0, "no replacement characters");
    assert.equal(got, s);
  });

  test("finding 3: the inspector's /api/update reads its body the same way", async () => {
    const s = "čćžšđ漢字😀".repeat(30_000);
    const r = await call("/api/update", { file, id: "T", props: { content: s } });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(find("T").content, s);
  });

  test("finding 3: the shared reader joins bytes before decoding", async () => {
    const bytes = Buffer.from("aŽ😀b", "utf8");
    // Every byte its own chunk: each multi-byte character is split.
    const one = (n: number) => Object.assign(Readable.from([...bytes].map((b) => Buffer.from([b]))), {}) as any;
    assert.equal(await readBodyText(one(0), 1000), "aŽ😀b");
    assert.equal(await readBodyText(Readable.from([bytes]) as any, 3), null, "over the byte limit: null");
  });

  test("finding 7: 200 000 control characters (6 bytes each as JSON) are under the limit and save", async () => {
    const r = await text("T", "\u0001".repeat(200_000));
    assert.equal(r.status, 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(find("T").content.length, 200_000);
  });

  test("finding 7: a text over the limit answers 413 with its message (the client reads it, no reset)", async () => {
    const r = await text("T", "x".repeat(T.MAX_TEXT + 1));
    assert.equal(r.status, 413);
    assert.match(r.body.error, /too long/);
  });

  test("finding 4: a text deleted while it was typed in answers 404 'deleted', not a component error", async () => {
    assert.equal((await call("/api/structure", { file, op: "delete", ids: ["T"] })).status, 200);
    const r = await text("T", "typed meanwhile");
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.code, "not_found");
    assert.match(r.body.error, /deleted/);
    assert.doesNotMatch(r.body.error, /component/);
  });

  test("finding 6: text bound to a string variable is refused (the binding stays), a literal dollar is not", async () => {
    const r = await text("V", "Typed over");
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "variable");
    assert.match(r.body.error, /\$greeting/);
    assert.equal(find("V").content, "$greeting");
    const d = await text("Dollar", "$6 off");
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(find("Dollar").content, "$6 off");
  });

  test("finding 6: the board scene marks variable-bound text (contentVar) so the page refuses before typing", async () => {
    const r = await fetch(`${base}/api/scene?file=${encodeURIComponent(file)}&id=B1`);
    const j: any = await r.json();
    const seek = (n: any, id: string): any => (n.id === id ? n : (n.children || []).map((c: any) => seek(c, id)).find(Boolean));
    const root = j.root ?? j.scene?.root ?? j;
    assert.equal(seek(root, "V").content, "Hi there");
    assert.equal(seek(root, "V").contentVar, "$greeting");
    assert.equal(seek(root, "Dollar").contentVar, undefined, "a dollar that is no variable is plain text");
    assert.equal(seek(root, "T").contentVar, undefined);
  });

  test("finding 10: emptying a replacement inside an instance keeps the layer (deleted false): the page re-selects it", async () => {
    const r = await text("RepT", "");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deleted, undefined);
    assert.equal(T.commitPlan("Rep", "", "RepT").kind, "delete", "the page predicts a delete; its answer corrects it (see the page tests)");
  });
});

// ---------------------------------------------------------------- the pure half

const key = (o: Record<string, unknown>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", code: "", ...o });

describe("pure helpers", () => {
  test("finding 8: keys during an IME composition belong to the IME", () => {
    assert.equal(T.keyIntent(key({ key: "Escape", isComposing: true })), "compose");
    assert.equal(T.keyIntent(key({ key: "Enter", metaKey: true, keyCode: 229 })), "compose");
    assert.equal(T.keyIntent(key({ key: "Tab", isComposing: true })), "compose");
    assert.equal(T.keyIntent(key({ key: "Escape" })), "commit");
  });
  test("finding 12: Shift+Tab stays in the editor", () => {
    assert.equal(T.keyIntent(key({ key: "Tab", shiftKey: true })), "swallow");
    assert.equal(T.keyIntent(key({ key: "Tab" })), "tab");
  });
  test("finding 8: a composition is one undo step however long it takes; the next one is its own", () => {
    assert.equal(T.inputKind("insertCompositionText"), "compose");
    const h = new T.TextHistory();
    const st = (value: string) => ({ value, start: value.length, end: value.length });
    let v = "";
    h.end(st(v));
    for (const [i, ch] of ["k", "か", "かn", "かな"].entries()) { h.begin(st(v), "compose", i * 5000); v = ch; h.end(st(v)); }
    h.endComposition();
    h.begin(st(v), "compose", 30_000); v = "かなk"; h.end(st(v));
    assert.equal(h.undo(st(v))?.value, "かな", "the second composition undoes on its own");
    assert.equal(h.undo(st("かな"))?.value, "", "the first one is one step");
    assert.equal(h.undo(st("")), null);
  });
  test("finding 14: the editor's history keeps a character budget, not 500 full copies", () => {
    const h = new T.TextHistory();
    const big = "x".repeat(400_000);
    h.end({ value: big, start: 0, end: 0 });
    for (let i = 0; i < 100; i++) h.begin({ value: big + i, start: 0, end: 0 }, "other", i * 10_000);
    assert.ok(h.chars <= T.TextHistory.MAX_CHARS, `kept ${h.chars} characters`);
    assert.ok(h.undos.length >= 1 && h.undos.length < 100);
    assert.equal(h.undo({ value: "now", start: 0, end: 0 })?.value, big + 99, "the newest step still undoes");
  });
  test("finding 13: a turned box's own size from its bounds", () => {
    const w = 200, h = 40, deg = 30;
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const r = T.sizeFromBounds({ x: 0, y: 0, w: w * c + h * s, h: w * s + h * c }, deg);
    assert.ok(r && Math.abs(r.w - w) < 1e-6 && Math.abs(r.h - h) < 1e-6, JSON.stringify(r));
    assert.deepEqual(T.sizeFromBounds({ x: 0, y: 0, w: 10, h: 5 }, 0), { w: 10, h: 5 });
    assert.equal(T.sizeFromBounds({ x: 0, y: 0, w: 100, h: 100 }, 45), null, "at 45 degrees the bounds do not say");
    const r90 = T.sizeFromBounds({ x: 0, y: 0, w: 40, h: 200 }, 90);
    assert.ok(r90 && Math.abs(r90.w - 200) < 1e-6 && Math.abs(r90.h - 40) < 1e-6, JSON.stringify(r90));
  });
});

// ---------------------------------------------------------------- the page half, on a stand-in DOM

type Listener = (e: any) => void;
// The editor's field is a plain-text contenteditable (src/page/text-edit.js): text nodes in spans, a selection, ranges.
class Txt {
  nodeType = 3; nodeName = "#text"; parent: El | null = null; data: string;
  constructor(s: string) { this.data = s; }
  get length() { return this.data.length; }
  contains(n: unknown) { return n === this; }
}
type Kid = El | Txt;
class El {
  tagName: string; nodeName: string; nodeType = 1; id = ""; className = ""; style: Record<string, string> = {}; children: Kid[] = []; parent: El | null = null;
  attrs: Record<string, string> = {}; listeners = new Map<string, Listener[]>(); dataset: Record<string, string> = {};
  offsetWidth = 0; offsetHeight = 0;
  classList = { add: (c: string) => { this.cls.add(c); }, remove: (c: string) => { this.cls.delete(c); }, contains: (c: string) => this.cls.has(c) };
  cls = new Set<string>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; }
  get childNodes() { return this.children; }
  get textContent(): string { return this.children.map((c) => (c instanceof Txt ? c.data : c.textContent)).join(""); }
  set textContent(s: string) { this.children = []; if (s) this.appendChild(new Txt(s)); }
  /** What typing into the field leaves in it (the browser's own edit, before the editor reads it back). */
  set value(s: string) { this.textContent = s; }
  appendChild(c: Kid) { c.parent = this; this.children.push(c); return c; }
  replaceChildren(frag: El) { this.children = []; for (const c of frag.children) this.appendChild(c); }
  querySelector(sel: string): El | null {
    for (const c of this.children) { if (!(c instanceof El)) continue; if (sel === "br[data-end]" && c.tagName === "BR" && "end" in c.dataset) return c; const h = c.querySelector(sel); if (h) return h; }
    return null;
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  contains(n: unknown): boolean { return n === this || this.children.some((c) => c.contains(n)); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(n: string, f: Listener) { if (!this.listeners.has(n)) this.listeners.set(n, []); this.listeners.get(n)!.push(f); }
  dispatch(n: string, e: any) { for (const f of this.listeners.get(n) ?? []) f(e); return e; }
  focus() { doc.activeElement = this; }
  get isConnected(): boolean { let n: El | null = this; while (n) { if (n === doc.body) return true; n = n.parent; } return false; }
}
const textsIn = (root: El): Txt[] => root.children.flatMap((c) => (c instanceof Txt ? [c] : textsIn(c)));
/** The letters of `root` before the point (node, off): what a range from the root's start to there holds. */
function before(root: El, node: Kid, off: number): string {
  if (node instanceof Txt) { let s = ""; for (const t of textsIn(root)) { if (t === node) return s + t.data.slice(0, off); s += t.data; } return s; }
  if (node === root) return node.children.slice(0, off).map((c) => (c instanceof Txt ? c.data : c.textContent)).join("");
  return before(root, node, 0);
}
const selection: any = { rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0,
  setBaseAndExtent(a: Kid, ao: number, f: Kid, fo: number) { Object.assign(selection, { rangeCount: 1, anchorNode: a, anchorOffset: ao, focusNode: f, focusOffset: fo }); } };
const ev = (o: Record<string, unknown> = {}) => {
  const e: any = { defaultPrevented: false, propagationStopped: false, ...o };
  e.preventDefault = () => { e.defaultPrevented = true; };
  e.stopPropagation = () => { e.propagationStopped = true; };
  e.stopImmediatePropagation = () => { e.propagationStopped = true; };
  return e;
};
const doc: any = {};
let win = new El("window");
function freshDom() {
  doc.head = new El("head");
  doc.body = new El("body");
  doc.activeElement = doc.body;
  doc.createElement = (t: string) => new El(t);
  doc.createDocumentFragment = () => new El("#fragment");
  doc.createTreeWalker = (root: El) => { const ts = textsIn(root); let i = 0; return { nextNode: () => ts[i++] ?? null }; };
  doc.createRange = () => {
    const r: any = { setStart(n: El) { r.root = n; }, setEnd(n: Kid, o: number) { r.end = [n, o]; },
      cloneContents() { const f = new El("#fragment"); f.textContent = before(r.root, r.end[0], r.end[1]); return f; } };
    return r;
  };
  doc.getElementById = () => null;
  doc.fonts = { add() {} };
  doc.execCommand = () => true;
  doc.listeners = new El("document");
  doc.addEventListener = (n: string, f: Listener) => doc.listeners.addEventListener(n, f);
  win = new El("window");
  const g = globalThis as any;
  g.document = doc;
  g.getSelection = () => selection;
  g.Node = { DOCUMENT_POSITION_PRECEDING: 2 };
  g.NodeFilter = { SHOW_TEXT: 4 };
  selection.rangeCount = 0;
  g.addEventListener = (n: string, f: Listener) => win.addEventListener(n, f);
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
}
let fontGate: { resolve: () => void; promise: Promise<void> };
class FakeFontFace {
  status = "unloaded";
  loaded: Promise<void>;
  constructor() { this.loaded = fontGate.promise; }
  load() { this.status = "loading"; return fontGate.promise.then(() => { this.status = "loaded"; }); }
}
type Sent = { url: string; body: any; keepalive: boolean; answer: (status: number, j: any) => void };
let sent: Sent[] = [];
function fakeFetch(url: string, init: any) {
  return new Promise((resolve) => {
    sent.push({ url, body: JSON.parse(init.body), keepalive: !!init.keepalive, answer: (status, j) => resolve({ ok: status < 400, status, statusText: "", json: async () => j }) });
  });
}

function makeHost(o: { content?: string; contentVar?: string; file?: string | null; spans?: unknown[]; others?: any[] } = {}) {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const node: any = { id: "T", type: "text", content: o.content ?? "Hello", fontFamily: "Inter" };
  if (o.contentVar) node.contentVar = o.contentVar;
  if (o.spans) node.spans = o.spans;
  const scene: any = { fonts: [{ family: "Inter", url: "/f/inter", weight: 400, style: "normal" }], root: { id: "B1", type: "frame", children: [node, ...(o.others ?? [])] } };
  const under = new Map<string, any>();
  let op = 1000;
  const h: any = {
    file: o.file === null ? undefined : (o.file ?? "/x.canvas.json"), native: true, renderer: "engine", view: new El("div"), boards: new Map([["B1", {}]]),
    cam: { x: 0, y: 0, z: 1 }, sel: null as string | null, posts: [] as any[], tracked: [] as Promise<unknown>[], overrides: [] as any[], acks: [] as any[], pins: new Map(),
    sceneHooks: [] as ((b: string, s: any) => void)[], scene, under,
    engineView: { isLoaded: () => true, rect: () => ({ x: 0, y: 0, w: 100, h: 20 }), fetchScene: async () => true },
    on(n: string, f: (...a: any[]) => void) { (handlers[n] ||= []).push(f); },
    emit(n: string, ...a: any[]) { for (const f of handlers[n] ?? []) f(...a); },
    selection() { return h.sel ? [h.sel] : []; },
    selectId(id: string) { h.sel = id; h.emit("select", id); },
    clearSel() { h.sel = null; h.emit("deselect"); },
    syncSel() {}, pick: () => "T",
    post(m: any) { h.posts.push(m); },
    trackWrite(p: Promise<unknown>) { h.tracked.push(p); return p; },
  };
  h.live = {
    busy: false, boardOf: () => "B1", sceneOf: () => scene,
    pin(id: string, p: any) { h.pins.set(id, p); }, unpin(id: string) { h.pins.delete(id); },
    underPin: (id: string) => under.get(id) || null, nextOp: () => ++op,
    override(...a: any[]) { h.overrides.push(a); }, ack(...a: any[]) { h.acks.push(a); },
    onScene(f: (b: string, s: any) => void) { h.sceneHooks.push(f); },
  };
  return h;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const toasts = (h: any) => h.posts.filter((m: any) => m.toast).map((m: any) => m.toast as string);

describe("page: the editor", () => {
  const g = globalThis as any;
  const saved = { fetch: g.fetch, FontFace: g.FontFace };
  beforeEach(() => {
    freshDom();
    sent = [];
    let resolve!: () => void;
    fontGate = { promise: new Promise<void>((r) => { resolve = r; }), resolve: () => resolve() };
    g.fetch = fakeFetch;
    g.FontFace = FakeFontFace;
  });
  after(() => { g.fetch = saved.fetch; g.FontFace = saved.FontFace; delete g.document; delete g.addEventListener; delete g.getSelection; delete g.Node; delete g.NodeFilter; });

  async function open(h: any, o: any = { all: true }) {
    T.attach(h);
    const p = h.textEdit.enter("T", o);
    fontGate.resolve();
    assert.equal(await p, true);
    return h.textEdit;
  }

  test("finding 1 / codex 2: Esc (or a click away) while the fonts load leaves the text as it was, never deletes it", async () => {
    const h = makeHost();
    T.attach(h);
    const p = h.textEdit.enter("T", { all: true });
    await Promise.resolve();
    assert.equal(h.textEdit.active, true);
    win.dispatch("keydown", ev({ key: "Escape", target: doc.body }));
    assert.equal(h.textEdit.active, false);
    assert.equal(sent.length, 0, "no write: nothing was typed (it used to post content \"\" and delete T)");
    fontGate.resolve();
    assert.equal(await p, false);
  });

  test("finding 1: a click away during the font load writes nothing either", async () => {
    const h = makeHost();
    T.attach(h);
    const p = h.textEdit.enter("T", { all: true });
    await Promise.resolve();
    win.dispatch("pointerdown", ev({ target: doc.body }));
    assert.equal(sent.length, 0);
    fontGate.resolve();
    await p;
  });

  test("finding 1: keys typed while the fonts load land in the editor and are saved", async () => {
    const h = makeHost();
    T.attach(h);
    const p = h.textEdit.enter("T", { all: true });
    await Promise.resolve();
    const ta = doc.activeElement as El;
    assert.equal(ta.attrs.contenteditable, "plaintext-only", "the editor has focus from the start");
    assert.equal(ta.isConnected, true);
    ta.value = "Typed early";
    ta.dispatch("input", ev());
    fontGate.resolve();
    await p;
    assert.equal(h.textEdit.value, "Typed early", "the late caret placement never undoes the typing");
    h.textEdit.commit();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.content, "Typed early");
  });

  test("finding 2 / codex 1: the page going away (reload, tab switch, quit) writes the typing", async () => {
    const h = makeHost();
    const te = await open(h);
    doc.activeElement.value = "Typed before reload";
    doc.activeElement.dispatch("input", ev());
    win.dispatch("pagehide", ev());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.content, "Typed before reload");
    assert.equal(sent[0].keepalive, true, "keepalive: the write outlives the page");
    assert.equal(te.active, false);
  });

  test("finding 2 / codex 1: flush() (the app, before it loads another page or quits) ends the edit and waits for the write", async () => {
    const h = makeHost();
    const te = await open(h);
    doc.activeElement.value = "Before Cmd+Q";
    doc.activeElement.dispatch("input", ev());
    let done: boolean | undefined;
    te.flush().then((ok: boolean) => { done = ok; });
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(done, undefined, "waits for the answer");
    sent[0].answer(200, { ok: true, changed: true });
    await tick(); await tick();
    assert.equal(done, true);
    let failed: boolean | undefined;
    const h2 = makeHost();
    freshDom();
    const te2 = await open(h2);
    doc.activeElement.value = "x"; doc.activeElement.dispatch("input", ev());
    te2.flush().then((ok: boolean) => { failed = ok; });
    await tick();
    sent[sent.length - 1].answer(422, { error: "boom", code: "failed" });
    await tick(); await tick();
    assert.equal(failed, false, "a failed write keeps the app from leaving");
  });

  test("codex 3: a text write is registered with the shared pending-write tracker (Undo waits for it)", async () => {
    const h = makeHost();
    const te = await open(h);
    doc.activeElement.value = "Saved"; doc.activeElement.dispatch("input", ev());
    te.commit();
    assert.equal(h.tracked.length, 1, "host.trackWrite got the write");
    let settled = false;
    h.tracked[0].then(() => { settled = true; });
    await tick();
    assert.equal(settled, false, "pending until the server answers");
    sent[0].answer(200, { ok: true, changed: true });
    await tick(); await tick();
    assert.equal(settled, true);
  });

  test("finding 4: the layer deleted under the edit: say so, keep the typing on the clipboard", async () => {
    const h = makeHost();
    await open(h);
    doc.activeElement.value = "My paragraph"; doc.activeElement.dispatch("input", ev());
    h.scene.root.children = [];
    for (const f of h.sceneHooks) f("B1", h.scene);
    await tick();
    assert.equal(h.textEdit.active, false);
    assert.ok(toasts(h).some((t: string) => /deleted while you typed/.test(t) && /clipboard/.test(t)), toasts(h).join(" | "));
    assert.ok(h.posts.some((m: any) => m.clipboard === "My paragraph"));
  });

  test("finding 4: a write answered 404 (deleted) says so instead of blaming a component", async () => {
    const h = makeHost();
    const te = await open(h);
    doc.activeElement.value = "Lost?"; doc.activeElement.dispatch("input", ev());
    te.commit();
    sent[0].answer(404, { error: "that text was deleted", code: "not_found" });
    await tick(); await tick();
    const t = toasts(h);
    assert.ok(t.some((x: string) => /deleted while you typed/.test(x)), t.join(" | "));
    assert.ok(!t.some((x: string) => /component/.test(x)));
    assert.ok(h.posts.some((m: any) => m.clipboard === "Lost?"));
  });

  test("finding 5: an agent's write under the edit is reported when the typing replaces it", async () => {
    const h = makeHost();
    const te = await open(h);
    doc.activeElement.value = "User typed"; doc.activeElement.dispatch("input", ev());
    h.under.set("T", { content: "Agent wrote this" });
    te.commit();
    sent[0].answer(200, { ok: true, changed: true });
    await tick(); await tick();
    assert.ok(toasts(h).some((t: string) => /agent changed this text/i.test(t)), toasts(h).join(" | "));
  });

  test("finding 5: nothing typed: the agent's text stays (no write over it)", async () => {
    const h = makeHost();
    const te = await open(h);
    h.under.set("T", { content: "Agent wrote this" });
    te.commit();
    assert.equal(sent.length, 0);
  });

  test("finding 6: text bound to a variable does not open the editor", async () => {
    const h = makeHost({ contentVar: "$greeting" });
    T.attach(h);
    assert.equal(await h.textEdit.enter("T", { all: true }), false);
    assert.equal(h.textEdit.active, false);
    assert.ok(toasts(h).some((t: string) => t.includes("$greeting")));
  });

  test("finding 7: a text over the limit keeps the editor open with a message, nothing is lost", async () => {
    const h = makeHost();
    const te = await open(h);
    doc.activeElement.value = "x".repeat(T.MAX_TEXT + 1); doc.activeElement.dispatch("input", ev());
    te.commit();
    assert.equal(te.active, true, "still editing");
    assert.equal(sent.length, 0);
    assert.ok(toasts(h).some((t: string) => /too long/.test(t)));
    assert.equal(await te.flush(), false, "the app does not leave the page over it");
  });

  test("finding 8: Esc during an IME composition does not end the edit", async () => {
    const h = makeHost();
    const te = await open(h);
    const ta = doc.activeElement as El;
    const e = ta.dispatch("keydown", ev({ key: "Escape", isComposing: true }));
    assert.equal(te.active, true);
    assert.equal(e.defaultPrevented, false, "the IME gets the key");
  });

  test("finding 9: a page without a file (the empty page) still tells the app no edit is open", () => {
    const h = makeHost({ file: null });
    T.attach(h);
    assert.ok(h.posts.some((m: any) => m.textEditing === false));
  });

  test("finding 10: an empty replacement the server kept (deleted false) is selected again", async () => {
    const h = makeHost({ content: "Rep" });
    const te = await open(h);
    doc.activeElement.value = ""; doc.activeElement.dispatch("input", ev());
    te.commit();
    assert.equal(h.sel, null, "predicted a delete");
    sent[0].answer(200, { ok: true, changed: true, id: "T" });
    await tick(); await tick();
    assert.equal(h.sel, "T", "the layer is still there, so it stays selected");
  });

  test("finding 12: Shift+Tab is held in the editor; a key typed with focus elsewhere is not swallowed", async () => {
    const h = makeHost();
    const te = await open(h);
    const ta = doc.activeElement as El;
    const e = ta.dispatch("keydown", ev({ key: "Tab", shiftKey: true }));
    assert.equal(e.defaultPrevented, true);
    doc.activeElement = doc.body;
    const k = win.dispatch("keydown", ev({ key: "a", target: doc.body }));
    assert.equal(doc.activeElement, ta, "focus goes back to the editor");
    assert.equal(k.defaultPrevented, false, "the key goes on to the editor instead of being eaten");
    assert.equal(k.propagationStopped, true, "no canvas key handler hears it");
    assert.equal(te.active, true);
  });

  // Codex review b1 (docs/evidence/review-fixes.md): `touched` stayed true after Undo took every edit back.
  test("review b1: multi-edit undone back to the original writes nothing to the other layers", async () => {
    const h = makeHost({ content: "Alpha", others: [{ id: "U", type: "text", content: "Beta", fontFamily: "Inter" }] });
    T.attach(h);
    const p = h.textEdit.enter("T", { all: true, also: ["U"] });
    fontGate.resolve();
    assert.equal(await p, true);
    const ta = doc.activeElement as El;
    ta.value = "Typed";
    ta.dispatch("input", ev());
    assert.equal(h.pins.get("U")?.content, "Typed", "the other layer shows the typing");
    h.textEdit.step("undo");
    assert.equal(h.textEdit.value, "Alpha", "undo is back at the original");
    assert.deepEqual(h.pins.get("U"), {}, "the other layer shows its own text again");
    h.textEdit.commit();
    assert.equal(sent.length, 0, `nothing to write: ${JSON.stringify(sent.map((s) => s.body))}`);
    h.textEdit.step("redo");
  });

  test("review b1: redo after that writes the typing to every layer again", async () => {
    const h = makeHost({ content: "Alpha", others: [{ id: "U", type: "text", content: "Beta", fontFamily: "Inter" }] });
    T.attach(h);
    const p = h.textEdit.enter("T", { all: true, also: ["U"] });
    fontGate.resolve();
    await p;
    const ta = doc.activeElement as El;
    ta.value = "Typed";
    ta.dispatch("input", ev());
    h.textEdit.step("undo");
    h.textEdit.step("redo");
    h.textEdit.commit();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body.also, ["U"]);
    assert.equal(sent[0].body.content, "Typed");
  });

  // Claude bug hunt T2 (page half): the other layers showed the main layer's styled ranges while typing.
  test("hunt T2: the other layers of a multi-edit show their own styling, not the main layer's", async () => {
    const h = makeHost({ content: "Bold", spans: [{ start: 0, end: 4, fontWeight: "700" }], others: [{ id: "U", type: "text", content: "Plain", fontFamily: "Inter" }] });
    T.attach(h);
    const p = h.textEdit.enter("T", { all: true, also: ["U"] });
    fontGate.resolve();
    await p;
    const ta = doc.activeElement as El;
    ta.value = "Hi";
    ta.dispatch("input", ev());
    assert.equal(h.pins.get("U").content, "Hi");
    assert.equal(h.pins.get("U").spans, undefined, JSON.stringify(h.pins.get("U")));
    h.textEdit.commit();
    const ov = h.overrides.find((o: any[]) => o[0] === "U");
    assert.equal(ov[1].spans, undefined, `the override after the commit: ${JSON.stringify(ov[1])}`);
  });

  // Claude bug hunt T1: a paste whose clipboard holds only an image (no text/plain) deleted the selected letters.
  test("hunt T1: a paste with no text on the clipboard changes nothing", async () => {
    const h = makeHost({ content: "Keep me" });
    const te = await open(h);
    const ta = doc.activeElement as El;
    const e = ta.dispatch("paste", ev({ clipboardData: { getData: (t: string) => (t === "text/plain" ? "" : "") } }));
    assert.equal(e.defaultPrevented, true, "the browser's own paste (an image into the field) stays off");
    assert.equal(te.value, "Keep me");
    te.commit();
    assert.equal(sent.length, 0, "nothing to write");
  });

  // Claude bug hunt T3: Backspace after a flag (two regional indicators), a ZWJ family or a skin tone, with no
  // target ranges from the browser, deleted half of it.
  test("hunt T3: Backspace and Delete take a whole emoji (flag, ZWJ sequence, skin tone)", async () => {
    for (const emoji of ["🇭🇷", "👨‍👩‍👧", "👍🏽", "é"]) {
      sent = [];
      const h = makeHost({ content: "Hi " + emoji + "!" });
      const te = await open(h, {});
      const ta = doc.activeElement as El;
      const end = ("Hi " + emoji).length;
      te.select(end, end);
      ta.dispatch("beforeinput", ev({ inputType: "deleteContentBackward" }));
      assert.equal(te.value, "Hi !", `Backspace after ${emoji}: ${JSON.stringify(te.value)}`);
      te.step("undo");
      te.select(3, 3);
      ta.dispatch("beforeinput", ev({ inputType: "deleteContentForward" }));
      assert.equal(te.value, "Hi !", `Delete before ${emoji}: ${JSON.stringify(te.value)}`);
      te.cancel();
    }
    assert.equal(T.clusterBefore("a🇭🇷", 5), 1);
    assert.equal(T.clusterAfter("🇭🇷a", 0), 4);
  });

  // Codex review b2: a click away during an IME composition wrote the composed text with the styled ranges of the
  // text before it (ends past the new length), which the server refuses after the editor closed.
  test("review b2: a commit during an IME composition sends ranges that fit the composed text", async () => {
    const h = makeHost({ content: "Hello", spans: [{ start: 0, end: 5, fontWeight: "700" }] });
    const te = await open(h);
    const ta = doc.activeElement as El;
    ta.dispatch("beforeinput", ev({ inputType: "insertCompositionText", isComposing: true, data: "日" }));
    ta.value = "日";
    ta.dispatch("input", ev({ isComposing: true }));
    win.dispatch("pointerdown", ev({ target: doc.body, button: 0, clientX: 500, clientY: 500 }));
    assert.equal(te.active, false, "the click away ended the edit");
    assert.equal(sent.length, 1);
    const b = sent[0].body;
    assert.equal(b.content, "日");
    for (const s of b.spans ?? []) assert.ok(s.end <= b.content.length && s.start < s.end, `a range inside the text: ${JSON.stringify(b.spans)}`);
    assert.ok((b.spans ?? []).some((s: any) => s.fontWeight === "700"), "the composed letter keeps the bold it replaced");
  });
});
