// Regression tests for bug hunt round 5 on the page (.planning/research/hunt-5-claude-page.md and the codex
// "src/server.ts" section): the page script's functions run extracted from src/server.ts in a sandbox; the
// page modules run with a fake host.

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import { attach as attachStructure, pastePlace } from "../src/page/structure.js";
// @ts-ignore: a plain ES module the page imports too
import { NudgeQueue } from "../src/page/geometry.js";

const page = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
/** A top-level (async) function of the page script, by brace matching. */
const fn = (name: string): string => {
  let at = page.indexOf(`\nfunction ${name}(`);
  if (at < 0) at = page.indexOf(`\nasync function ${name}(`);
  if (at < 0) return "";
  let depth = 0;
  for (let i = page.indexOf("{", at); i < page.length; i++) {
    if (page[i] === "{") depth++;
    else if (page[i] === "}" && --depth === 0) return page.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
};
const src = (f: string) => fs.readFileSync(new URL(`../src/page/${f}`, import.meta.url), "utf8");
const tick = () => new Promise((r) => setImmediate(r));

describe("hunt 5: selection", () => {
  const base = () => {
    const calls: string[] = [];
    const ctx: any = {
      multi: null, sel: { id: "A" }, selGen: 5, selAsk: 0, selMove: null, shownSel: null, native: true,
      syncSel() {}, offPage: () => false, isW: (id: string) => id.startsWith("widget:"), post: (m: unknown) => calls.push("post " + JSON.stringify(m)), postSel() {},
      host: { emit: (n: string) => calls.push("emit " + n) }, api: (p: string) => p, performance: { now: () => 0 },
      document: { getElementById: () => ({ textContent: "", append() {} }) }, el: () => ({}), section: () => null, kv: () => null,
      deselect: () => calls.push("deselect"), loadMoveInfo() {}, showMulti: () => calls.push("showMulti"),
    };
    return { ctx, calls };
  };

  test("claude 1 + 3: a refresh is not a new selection (selGen stays), and a selected layer that went away is deselected", async () => {
    const { ctx, calls } = base();
    ctx.fetch = async () => ({ status: 404, json: async () => ({ error: "no node" }) });
    const code = "let selGen = 5, selAsk = 0;\n" + fn("select") + "\n;({ select, gen: () => selGen })";
    const r = vm.runInNewContext(code, ctx);
    await r.select("A", true);
    assert.equal(r.gen(), 5, "a refresh must not look like a new selection to Cmd+D / Cmd+G");
    assert.ok(calls.includes("deselect"), "the deleted layer leaves the selection");
  });

  test("claude 2: a refresh keeps how the layer moves until the new answer comes", () => {
    const ctx: any = { selMove: { id: "A", mode: "absolute", x: 0, y: 0 }, earlyNudge: null, sel: { id: "A" }, isW: () => false, boards: new Map(), api: (p: string) => p, fetch: () => new Promise(() => {}) };
    const r = vm.runInNewContext(fn("loadMoveInfo") + "\n;({ loadMoveInfo, get: () => selMove })", ctx);
    r.loadMoveInfo("A", true);
    assert.ok(r.get(), "arrow presses during the refresh still know the layer is absolute");
    r.loadMoveInfo("B");
    assert.equal(r.get(), null);
  });

  test("claude 3: layers deleted since leave a multi-selection", async () => {
    const picked: string[][] = [];
    const ctx: any = {
      multi: ["A", "B", "widget:W"], sel: { id: "widget:W" }, multiWorld: [], selWorld: null, native: false,
      isW: (id: string) => id.startsWith("widget:"), api: (p: string) => p, el: () => ({}), kv: () => null,
      document: { getElementById: () => ({ textContent: "", append() {} }) }, host: {}, post() {},
      setSelection: (ids: string[]) => picked.push(ids),
      fetch: async (u: string) => ({ status: u.includes("id=B") ? 404 : 200, json: async () => (u.includes("id=B") ? { error: "gone" } : { node: { id: "A" } }) }),
    };
    vm.runInNewContext(fn("showMulti") + "\n;showMulti(multi)", ctx);
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(picked, [["A", "widget:W"]]);
  });
});

describe("hunt 5: undo waits for every write", () => {
  test("claude 4 + 5: card nudges and a group drop still out keep Undo waiting", async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const ctx: any = {
      nudges: new Map(), gnudge: null, host: { widgetWritesPending: () => false, widgetGroup: { commit: () => log.push("commit"), preview() {} } },
      snapCfg: { pixel: true }, posHold: new Map(), multiHold: null, file: "f", performance: { now: () => 0 },
      placeBoardAt() {}, syncSel() {}, requestFlush() {}, tell() {}, tellOnce() {},
      sendMove: () => new Promise((r) => { release = () => r({ skipped: [] }); }),
      fetch: () => { log.push("undo"); return Promise.resolve({ ok: true, json: async () => ({}) }); }, api: (p: string) => p,
    };
    const head = "let nudgeWaiters = [];\nlet writesOut = 0;\nlet earlyNudge = null;\n";
    const r = vm.runInNewContext(head + ["nudgesPending", "nudgeSettled", "trackWrite", "groupDrop", "historyStep"].map(fn).join("\n") + "\n;({ nudgesPending, groupDrop, historyStep })", ctx);
    ctx.host.widgetWritesPending = () => true;
    assert.equal(r.nudgesPending(), true, "a card's nudge write still out");
    ctx.host.widgetWritesPending = () => false;
    r.groupDrop({ pos: { x: 10, y: 0 }, r0: { x: 0, y: 0 }, items: [{ id: "N", kind: "node", r0: { x: 0, y: 0, w: 1, h: 1 } }, { id: "widget:W", kind: "widget", r0: { x: 0, y: 0, w: 1, h: 1 } }] }, false);
    assert.equal(r.nudgesPending(), true, "the drop's layer write is out");
    r.historyStep("undo");
    assert.deepEqual(log, []);
    release();
    for (let i = 0; i < 4; i++) await tick();
    assert.deepEqual(log, ["commit", "undo"], "the cards' write goes before the Undo");
  });

  test("claude 4: widgets.js reports its writes (nudges, drags, group commits) and wakes Undo when they settle", () => {
    const s = src("widgets.js");
    assert.match(s, /host\.widgetWritesPending = \(\) => writesOut > 0 \|\| nudges\.busy\(\)/);
    assert.match(s, /commit\(ids, dx, dy, mergeKey\) \{[\s\S]*?return track\(Promise\.all/);
    assert.match(s, /host\.writesSettled\(\)/);
  });
});

describe("hunt 5: drags and nudges", () => {
  test("codex-src 1: a second drag before the first answers starts from where the first dropped", () => {
    const sent: any[] = [];
    const ctx: any = {
      mv: { kind: "node", id: "N", moved: true, pos: { x: 110, y: 0 }, r0: { x: 100, y: 0, w: 10, h: 10 }, node0: { x: 0, y: 0 } },
      mvDirty: false, selMove: { id: "N", mode: "absolute", x: 0, y: 0 }, selHold: null, snapCfg: { pixel: true }, mode: "dom", ev: null, file: "f",
      host: {}, clearGuides() {}, syncSel() {}, requestFlush() {}, tell() {}, nudgeSettled() {},
      sendMove: (b: any) => { sent.push(b); return new Promise(() => {}); },
    };
    const head = "let writesOut = 0, moveTag = 0;\nconst moveChain = new Map();\n";
    const r = vm.runInNewContext(head + ["trackWrite", "endMove", "moveAfter", "movedTo", "dropReparent", "unlift", "dropBoardInto"].map(fn).join("\n") + "\n;({ endMove, get: () => selMove })", ctx);
    r.endMove(false);
    assert.equal(sent[0].x, 10);
    assert.equal(r.get().x, 10, "the next drag's node0 is the dropped x, not the old one");
  });

  test("claude 9 / codex-src 6: a linked video card's arrow nudge moves what is shown and lets go of its node", async () => {
    const s = src("widgets.js");
    const h = s.slice(s.indexOf('host.on("nudge"'), s.indexOf("// ---------- several selected"));
    assert.match(h, /const r = shownRect\(e\.w\)/);
    assert.match(h, /config: \{ link: null \}/);
    // The queue keeps the release when a later press replaces a queued one.
    const sent: any[] = [];
    let go: () => void = () => {};
    const q = new NudgeQueue((_id: string, at: any) => { sent.push(at); return new Promise((r) => { go = () => r({}); }); });
    q.push("V", { x: 1, y: 0 });
    q.push("V", { x: 2, y: 0, extra: { config: { link: null } } });
    q.push("V", { x: 3, y: 0 });
    go();
    await tick();
    assert.deepEqual(sent[1], { x: 3, y: 0, extra: { config: { link: null } } });
  });

  test("codex-src 2: an old widget answer never draws over a newer write", () => {
    const s = src("widgets.js");
    assert.match(s, /const stampWrite = \(id\) =>/);
    assert.match(s, /act: \(name, args\) => \{ const land = stampWrite\(e\.id\)/);
    assert.match(s, /patch: \(config, extra\) => \{ const land = stampWrite\(e\.id\)/);
  });
});

describe("hunt 5: structure on the page", () => {
  const setup = (sel: string[], fetchImpl: (u: string, o?: any) => Promise<any>) => {
    const handlers: Record<string, ((c: unknown) => void)[]> = {};
    const told: string[] = [];
    const removed: unknown[] = [];
    const el = () => ({ style: {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    const g = globalThis as any;
    const saved = { document: g.document, addEventListener: g.addEventListener, fetch: g.fetch };
    g.document = { getElementById: el, addEventListener() {}, activeElement: null };
    g.addEventListener = () => {};
    g.fetch = fetchImpl;
    const host: any = {
      file: "f.canvas.json", view: el(), boards: new Map([["B1", {}]]), selection: () => sel, sel: sel.at(-1), selGen: 0, page: "p", native: true,
      on: (n: string, f: (c: unknown) => void) => { (handlers[n] ??= []).push(f); }, post: (m: any) => { if (m.toast) told.push(m.toast); },
      boxOf: () => ({ x: 0, y: 0, w: 10, h: 10 }), worldRectOf: () => ({ x: 0, y: 0, w: 10, h: 10 }), widgetsShown: () => [], widgetRect: () => null,
      setSelection() {}, clearSel() {}, hideBoards() {}, restoreBoards() {}, api: (p: string) => p,
      widgetGroup: { remove: (ids: string[], key: string) => { removed.push([ids, key]); return Promise.resolve(); } },
    };
    attachStructure(host);
    const restore = () => Object.assign(g, saved);
    return { handlers, told, removed, restore, host };
  };
  const ok = (j: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => j });

  test("claude 6: a mixed delete sends the cards and the layers with one merge key", async () => {
    const bodies: any[] = [];
    const t = setup(["R", "widget:W"], (u, o) => { if (u === "/api/structure") bodies.push(JSON.parse(o.body)); return ok({ select: [] }); });
    try {
      for (const f of t.handlers.cmd) f({ cmd: "structure", op: "delete" });
      await tick();
      const [[cards, key]] = t.removed as [string[], string][];
      assert.deepEqual(cards, ["widget:W"]);
      assert.match(key, /^group:delete-/);
      assert.equal(bodies[0].merge, key);
    } finally { t.restore(); }
  });

  // Cards copy and duplicate now (2026-11-16): with layers they go along, one undo step, nothing is left out.
  test("claude 12: Duplicate and Copy take the cards along", async () => {
    const bodies: any[] = [];
    const dups: unknown[][] = [];
    const t = setup(["R", "widget:W"], (u, o) => { if (u === "/api/structure") bodies.push(JSON.parse(o.body)); return ok({ select: ["R2"], payload: { kind: "canvas/nodes", nodes: [] } }); });
    t.host.widgetGroup.duplicate = (...a: unknown[]) => { dups.push(a); return Promise.resolve(["widget:W2"]); };
    t.host.widgetRect = () => ({ x: 0, y: 0, w: 10, h: 10 });
    try {
      for (const f of t.handlers.cmd) f({ cmd: "structure", op: "duplicate" });
      await tick();
      for (const f of t.handlers.cmd) f({ cmd: "copy" });
      await tick();
      assert.equal(t.told.length, 0, JSON.stringify(t.told));
      const dup = bodies.find((b) => b.op === "duplicate");
      assert.deepEqual(dup.ids, ["R"]);
      assert.equal(dups.length, 1);
      assert.deepEqual(dups[0][0], ["widget:W"]);
      assert.equal(dups[0][3], dup.merge, "the card's copy joins the layers' duplicate: one undo step");
      assert.deepEqual(bodies.find((b) => b.op === "copy").ids, ["R", "widget:W"], "copy sends the card to the server");
    } finally { t.restore(); }
  });

  test("codex-src 3: Paste right after Cut waits for the cut (it pastes what was cut)", async () => {
    const order: string[] = [];
    const t = setup(["R"], async (u, o) => {
      if (u === "/api/structure") {
        const b = JSON.parse(o.body);
        order.push(b.op);
        return ok(b.op === "cut" ? { payload: { kind: "canvas/nodes", nodes: [{ id: "R" }] } } : { select: [] });
      }
      await tick(); await tick(); // node lookups are slow
      return ok({ node: { id: "R", type: "rectangle" }, parentId: "B1", index: 0 });
    });
    try {
      for (const f of t.handlers.cmd) f({ cmd: "cut" });
      t.host.sel = undefined; t.host.selection = () => [];
      for (const f of t.handlers.cmd) f({ cmd: "paste" });
      for (let i = 0; i < 12; i++) await tick();
      assert.deepEqual(order, ["cut", "paste"]);
    } finally { t.restore(); }
  });

  test("claude 7: a copied board pasted with another board selected lands inside it, centred, not at canvas x", () => {
    const payload = { nodes: [{ id: "Bcopy", x: 3000, y: 2000 }], rects: [{ x: 3000, y: 2000, w: 100, h: 50 }], parents: [null] };
    const target = { id: "B2", isContainer: true, placesChildren: false, parentId: null, index: 0, rect: { x: 0, y: 0, w: 400, h: 300 } };
    const p = pastePlace({ target, payload, exists: () => true });
    assert.equal(p.parent, "B2");
    assert.deepEqual(p.positions, [{ x: 150, y: 125 }]);
  });
});

describe("hunt 5: page details", () => {
  test("claude 10: Space with several selected is the hand tool, not a video toggle", () => {
    assert.match(src("videos.js"), /host\.on\("select", \(id\) => \{ const many = host\.selection && host\.selection\(\)\.length > 1; selected = !many/);
  });
  test("codex-src 7: a failed shader source fetch says so and tries again", () => {
    const s = src("shaders.js");
    assert.match(s, /c\.loadError = "Could not load the shader's source/);
    assert.match(s, /if \(c\.tries <= 5\) setTimeout\(\(\) => \{ if \(live\(\)\) load\(c\); \}/);
    assert.match(s, /if \(c\.loadError\) return \{ state: "error"/);
  });
  test("codex-src 4: a scene too large for the cache is not fetched again every frame", () => {
    const s = src("live.js");
    assert.match(s, /if \(ok && v\.sceneText\(board\) === null\) \{ uncached\.set\(board/);
    assert.match(s, /\(uncached\.get\(board\) \|\| 0\) > performance\.now\(\)\) return;/);
  });
  test("codex-src 5: a board moved onto another restacks in document order", () => {
    const s = src("engine-view.js");
    const mv = s.slice(s.indexOf("function moveBoard(id, x, y)"), s.indexOf("// ---- live edits"));
    assert.match(mv, /overlaps\(r, rec\.rect\); \}\)\) reorder\(\)/);
  });
  test("claude 11: the MCP's selected node is the primary one; cards are named, not skipped silently", () => {
    assert.match(src("bridge.js"), /primary: id/);
    const edits = fs.readFileSync(new URL("../mcp/tools/edits.ts", import.meta.url), "utf8");
    assert.match(edits, /id = typeof sel\?\.primary === "string" \? sel\.primary : sel\?\.ids\?\.at\(-1\)/);
    const st = fs.readFileSync(new URL("../mcp/tools/structure.ts", import.meta.url), "utf8");
    assert.match(st, /leftOut: cards/);
  });
});
