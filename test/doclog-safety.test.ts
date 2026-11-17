// The save log when something else writes the same file (src/doc/doclog.ts, src/docwriter.ts). Each test is a case the
// 2026-11-17 review reproduced as silent data loss (docs/evidence/speed.md, "Save log review"): two Canvas servers on
// one file, an outside whole save before compaction, a same-bytes rewrite during an append, an old log coming back
// when document.json returns to its base bytes, a newer build's log deleted. Scratch copies only, with the log on
// (CANVAS_SAVE_LOG=1, documents of 2 MB).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

process.env.CANVAS_SAVE_LOG = "1"; // this process and every server it starts
const dir = tmpDir("doclog-safety");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_STATE_DIR = path.join(dir, "state-home");

const { startServer: spawnServer, sleep } = await import("../qa/lib.ts");
const pw = await import("../src/docwriter.ts");
const { startServer } = await import("../src/server.ts");
const { loadDoc, writeDoc } = await import("../src/engine.ts");
const L = await import("../src/doc/doclog.ts");
type Scratch = Awaited<ReturnType<typeof spawnServer>>;

const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const spawned = new Set<Scratch>();

after(async () => {
  for (const s of spawned) await s.stop();
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** boards x perBoard layers, about 2 MB at the defaults (over the log's 1 MB). */
const bigDoc = (boards = 120, perBoard = 60) => ({
  version: "2.21",
  children: Array.from({ length: boards }, (_, b) => ({
    type: "frame", id: `B${b}`, name: `Board ${b}`, x: (b % 20) * 500, y: Math.floor(b / 20) * 900, width: 390, height: 844, fill: "#ffffff", layout: "none",
    children: Array.from({ length: perBoard }, (_, i) => ({
      type: i % 3 ? "rectangle" : "text", id: `B${b}N${i}`, name: `Layer ${b}.${i}`, x: (i % 6) * 60, y: 120 + Math.floor(i / 6) * 40, width: 50, height: 30,
      ...(i % 3 ? { fill: "#e4e4e7", cornerRadius: 6 } : { content: `Text ${b}.${i} `.repeat(4), fontSize: 14, fontFamily: "Inter" }),
    })),
  })),
});

let n = 0;
/** A fresh .canvas package in its own folder (a spawned server reads only under it). */
function pkg(name: string, doc: unknown = bigDoc()) {
  const root = path.join(dir, `${name}-${n++}`);
  const p = path.join(root, "Big.canvas");
  fs.mkdirSync(p, { recursive: true });
  const docPath = path.join(p, "document.json");
  fs.writeFileSync(docPath, JSON.stringify(doc, null, 2));
  fs.writeFileSync(path.join(p, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }));
  return { root, pkg: fs.realpathSync(p), docPath: fs.realpathSync(docPath), logPath: L.logPathOf(fs.realpathSync(docPath)) };
}

/** An HTTP client for one server and one package. */
function client(b: string, file: string) {
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${b}${p}${p.includes("?") ? "&" : "?"}file=${encodeURIComponent(file)}`, { method, headers: { "x-canvas": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify({ file, ...(body as object) }), signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      j = text;
    }
    return { status: r.status, ok: r.ok, j };
  };
  return {
    open: () => call("GET", "/api/doc"),
    update: (id: string, props: Record<string, unknown>) => call("POST", "/api/update", { id, props }),
    move: (id: string, dx: number) => call("POST", "/api/move", { id, dx, dy: 0 }),
    flush: () => call("POST", "/api/flush", {}),
  };
}

async function spawn(root: string): Promise<Scratch> {
  const s = await spawnServer(root);
  spawned.add(s);
  return s;
}
async function stop(s: Scratch) {
  await s.stop();
  spawned.delete(s);
}
function kill9(s: Scratch): Promise<void> {
  spawned.delete(s);
  s.proc.kill("SIGKILL");
  return new Promise<void>((r) => (s.proc.exitCode !== null || s.proc.signalCode ? r() : s.proc.once("exit", () => r())));
}

/** A node by id in a document. */
function nodeIn(doc: any, id: string): any {
  let out: any;
  const walk = (ns: any[]) => {
    for (const x of ns ?? []) {
      if (x?.id === id) out = x;
      walk(x?.children);
    }
  };
  walk(doc.children);
  return out;
}
const withLog = (docPath: string) => loadDoc(docPath).doc; // document.json with its log, as any loader sees it
const alone = (docPath: string) => JSON.parse(fs.readFileSync(docPath, "utf8")); // what an older build or another app reads
/** Someone who does not know the log saves document.json whole (temp file and rename, as most apps and editors do). */
function outsideSave(docPath: string, change: (d: any) => void, from = alone(docPath)) {
  change(from);
  fs.writeFileSync(docPath + ".outside", JSON.stringify(from, null, 2));
  fs.renameSync(docPath + ".outside", docPath);
}
async function until(cond: () => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(50);
  return cond();
}

describe("two Canvas servers on one file", () => {
  test("each keeps the other's acknowledged edits: one owns the log, the other writes whole with it", async () => {
    const p = pkg("two");
    const A = await spawn(p.root), B = await spawn(p.root);
    try {
      const a = client(A.base, p.pkg), b = client(B.base, p.pkg);
      await a.open();
      await b.open();
      const acked: [string, string][] = [];
      const edit = async (c: typeof a, id: string, name: string) => {
        const u = await c.update(id, { name });
        const f = await c.flush();
        if (u.ok && f.ok) acked.push([id, name]);
        return f;
      };
      // The review's order: A appends (creates the log), B saves, A appends again at its own offset.
      await edit(a, "B0N1", "A-1");
      assert.ok(fs.existsSync(p.logPath), "A saved through the log");
      await edit(b, "B1N1", "B-1");
      await edit(a, "B2N1", "A-2");
      // Then both at once, each flushing after every edit.
      await Promise.all([
        (async () => { for (let i = 0; i < 12; i++) await edit(a, `B${10 + i}N2`, `A-burst-${i}`); })(),
        (async () => { for (let i = 0; i < 12; i++) await edit(b, `B${40 + i}N2`, `B-burst-${i}`); })(),
      ]);
      assert.equal(acked.length, 27, "every edit was answered");
      const now = withLog(p.docPath);
      for (const [id, name] of acked) assert.equal(nodeIn(now, id).name, name, `${id} on disk (document.json and its log)`);
      // Both compact once edits pause: document.json alone holds everything.
      assert.ok(await until(() => !fs.existsSync(p.logPath), 15_000), "the log was folded into document.json");
      const whole = alone(p.docPath);
      for (const [id, name] of acked) assert.equal(nodeIn(whole, id).name, name, `${id} in document.json`);
    } finally {
      await stop(A);
      await stop(B);
    }
  });
});

describe("someone who does not know the log saves document.json", () => {
  test("while Canvas runs, before compaction: Canvas's flushed edit goes back on top of their save", async () => {
    const p = pkg("outside");
    const s = await spawn(p.root);
    try {
      const c = client(s.base, p.pkg);
      await c.open();
      assert.equal((await c.update("B0N1", { name: "CANVAS" })).status, 200);
      assert.equal((await c.flush()).status, 200);
      assert.equal(nodeIn(alone(p.docPath), "B0N1").name, "Layer 0.1", "the edit is only in the log");
      // An older build (or another app) that read document.json alone saves an edit of its own.
      outsideSave(p.docPath, (d) => (nodeIn(d, "B5N6").name = "THEIRS"));
      await sleep(400);
      await c.flush();
      assert.ok(await until(() => !fs.existsSync(p.logPath)), "compacted");
      const d = alone(p.docPath);
      assert.equal(nodeIn(d, "B5N6").name, "THEIRS", "their save is kept");
      assert.equal(nodeIn(d, "B0N1").name, "CANVAS", "Canvas's acknowledged edit is not lost");
    } finally {
      await stop(s);
    }
  });

  test("after a crash: no edit comes back from an old log, and none is lost silently (a recovery copy)", async () => {
    for (const how of ["different", "the base bytes again"]) {
      const p = pkg("crash");
      const orig = fs.readFileSync(p.docPath);
      let s = await spawn(p.root);
      const c = client(s.base, p.pkg);
      await c.open();
      await c.update("B0N1", { name: "E1" });
      assert.equal((await c.flush()).status, 200);
      await kill9(s);
      assert.equal(nodeIn(withLog(p.docPath), "B0N1").name, "E1", "the crash kept the edit in the log");
      // An older build opens document.json (no E1), saves; in the second case it then puts the very bytes back
      // (its undo, or a git checkout).
      outsideSave(p.docPath, (d) => (nodeIn(d, "B5N6").name = "OLD-BUILD"));
      if (how !== "different") {
        fs.writeFileSync(p.docPath + ".t", orig);
        fs.renameSync(p.docPath + ".t", p.docPath);
      }
      assert.notEqual(nodeIn(withLog(p.docPath), "B0N1").name, "E1", `${how}: the old log does not apply to a file it was not written for`);
      s = await spawn(p.root);
      try {
        await client(s.base, p.pkg).open();
        await client(s.base, p.pkg).flush();
        assert.ok(await until(() => !fs.existsSync(p.logPath)), `${how}: the stale log is retired`);
        const d = alone(p.docPath);
        assert.equal(nodeIn(d, "B0N1").name, "Layer 0.1", `${how}: the document is what the other app saved`);
        const rec = fs.readdirSync(p.pkg).filter((f) => f.startsWith("document.json.recovered-"));
        assert.equal(rec.length, 1, `${how}: a recovery copy`);
        const r = JSON.parse(fs.readFileSync(path.join(p.pkg, rec[0]), "utf8"));
        assert.equal(nodeIn(r, "B0N1").name, "E1", `${how}: the recovery copy holds Canvas's edit`);
        assert.equal(nodeIn(r, "B5N6").name, how === "different" ? "OLD-BUILD" : "Layer 5.6", `${how}: on top of what the other app saved`);
      } finally {
        await stop(s);
      }
    }
  });

  test("document.json rewritten with the same bytes during appends: every nudge applies exactly once", async () => {
    const p = pkg("samebytes");
    const s = await spawn(p.root);
    try {
      const c = client(s.base, p.pkg);
      await c.open();
      const x0 = nodeIn(alone(p.docPath), "B3N4").x;
      let stop = false, rewrites = 0, acked = 0;
      // A sync client, cp or git checkout of an unchanged file: the same bytes, a new file.
      const rewriter = (async () => {
        while (!stop) {
          const bytes = fs.readFileSync(p.docPath);
          fs.writeFileSync(p.docPath + ".sync", bytes);
          fs.renameSync(p.docPath + ".sync", p.docPath);
          rewrites++;
          await sleep(15);
        }
      })();
      await Promise.all(Array.from({ length: 3 }, async () => {
        for (let i = 0; i < 60; i++) {
          if ((await c.move("B3N4", 1)).ok) acked++;
          if (i % 5 === 0) await c.flush();
        }
      }));
      stop = true;
      await rewriter;
      await c.flush();
      assert.ok(rewrites > 20, `the file was rewritten ${rewrites} times`);
      assert.equal(nodeIn(withLog(p.docPath), "B3N4").x, x0 + acked, `${acked} nudges, ${rewrites} same-bytes rewrites: on disk once each`);
    } finally {
      await stop(s);
    }
  });

  test("compaction runs right after opening a file whose server is gone", async () => {
    const p = pkg("reopen");
    let s = await spawn(p.root);
    await client(s.base, p.pkg).open();
    await client(s.base, p.pkg).update("B7N7", { name: "BEFORE THE CRASH" });
    assert.equal((await client(s.base, p.pkg).flush()).status, 200);
    await kill9(s);
    assert.ok(fs.existsSync(p.logPath));
    s = await spawn(p.root);
    try {
      await client(s.base, p.pkg).open();
      assert.ok(await until(() => !fs.existsSync(p.logPath), 5000), "folded into document.json without waiting for an edit");
      assert.equal(nodeIn(alone(p.docPath), "B7N7").name, "BEFORE THE CRASH", "an older build sees it now");
    } finally {
      await stop(s);
    }
  });

  test("a log of a newer version is never deleted; saves are whole", async () => {
    const p = pkg("newer");
    const head = "CANVASLOG 3 base tie owner and-more\nRECORDS A NEWER BUILD WROTE\n";
    fs.writeFileSync(p.logPath, head);
    const s = await spawn(p.root);
    try {
      const c = client(s.base, p.pkg);
      await c.open();
      await c.update("B2N2", { name: "SAVED WHOLE" });
      assert.equal((await c.flush()).status, 200);
      assert.equal(nodeIn(alone(p.docPath), "B2N2").name, "SAVED WHOLE", "written into document.json");
      await sleep(300);
      assert.equal(fs.readFileSync(p.logPath, "utf8"), head, "the newer log is left as it was");
    } finally {
      await stop(s);
    }
  });
});

// In this process: the writer's settings are reachable.
const at = (p: { pkg: string }) => client(base, p.pkg);

describe("in one server", () => {
  test("the log is folded at the latest compactMaxMs after its first record, even while edits never pause", async () => {
    const p = pkg("maxage");
    const c = at(p);
    await c.open();
    const keep = pw.writeConfig.compactMaxMs;
    pw.writeConfig.compactMaxMs = 400;
    try {
      let folded = false;
      for (let i = 0; i < 40 && !folded; i++) {
        await c.update(`B${i % 100}N3`, { name: `n${i}` });
        await c.flush();
        folded ||= nodeIn(alone(p.docPath), "B0N3").name === "n0";
        await sleep(40); // well under compactAfterMs: the edits never pause
      }
      assert.ok(folded, "document.json alone holds the first edit while edits went on");
    } finally {
      pw.writeConfig.compactMaxMs = keep;
      await pw.compactWrites(p.docPath);
    }
  });

  test("a whole write by store.ts (writeDoc) retires the log it folded: nothing is applied twice", async () => {
    const p = pkg("plainsave");
    const c = at(p);
    await c.open();
    const x0 = nodeIn(alone(p.docPath), "B1N1").x;
    assert.equal((await c.move("B1N1", 5)).status, 200);
    await c.flush();
    assert.ok(fs.existsSync(p.logPath), "the nudge is in the log");
    writeDoc(p.docPath, {}, (d) => void (nodeIn(d, "B9N9").name = "PLAIN-WRITE"));
    assert.equal(fs.existsSync(p.logPath), false, "retired by the whole write that holds it");
    const d = alone(p.docPath);
    assert.equal(nodeIn(d, "B1N1").x, x0 + 5);
    assert.equal(nodeIn(d, "B9N9").name, "PLAIN-WRITE");
    // The server sees the new bytes; its logged nudge is in them, not put back again.
    for (let i = 0; i < 100 && nodeIn(pw.currentDoc(p.docPath).doc, "B9N9").name !== "PLAIN-WRITE"; i++) await sleep(20);
    await c.update("B2N2", { name: "after" });
    await c.flush();
    assert.equal(nodeIn(withLog(p.docPath), "B1N1").x, x0 + 5, "the nudge once");
    assert.equal(nodeIn(pw.currentDoc(p.docPath).doc, "B1N1").x, x0 + 5);
    await pw.compactWrites(p.docPath);
  });

});

// ------------------------------------------------------------------------------------------------------------------
// The second review (docs/evidence/speed.md, "Save log, second review fixes"): each case lost acknowledged edits with
// the log on, none with it off.

/** Another process holds the log's lock for `ms` (a hung or slow Canvas in the middle of a whole write). */
async function holdLock(lockPath: string, ms: number) {
  const { spawn: spawnProc } = await import("node:child_process");
  const code = `const fs=require("fs");const fd=fs.openSync(process.argv[1],fs.constants.O_RDWR|fs.constants.O_CREAT|0x20,0o600);console.log("HELD");setTimeout(()=>{fs.closeSync(fd);console.log("RELEASED")},Number(process.argv[2]))`;
  const h = spawnProc(process.execPath, ["-e", code, lockPath, String(ms)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => h.stdout!.on("data", (d) => String(d).includes("HELD") && r()));
  const released = new Promise<void>((r) => (h.exitCode !== null ? r() : h.once("exit", () => r())));
  return { released, kill: () => void h.kill("SIGKILL") };
}
/** Where an edit is kept: in the document (with its log), or in a recovery copy beside it (false: nowhere). */
function keptAnywhere(p: { pkg: string; docPath: string }, id: string, name: string): string | false {
  if (nodeIn(withLog(p.docPath), id)?.name === name) return "document";
  for (const f of fs.readdirSync(p.pkg).filter((f) => f.startsWith("document.json.recovered-"))) {
    if (nodeIn(JSON.parse(fs.readFileSync(path.join(p.pkg, f), "utf8")), id)?.name === name) return f;
  }
  return false;
}
/** The package moved to `name` beside it (a Finder rename): its paths at the new place. */
function moved(p: ReturnType<typeof pkg>, name: string) {
  const to = path.join(p.root, name);
  fs.renameSync(p.pkg, to);
  const docPath = path.join(to, "document.json");
  return { root: p.root, pkg: to, docPath, logPath: L.logPathOf(docPath) };
}
/** A server with the save log on or off (the setting is read when it starts). */
async function spawnWith(root: string, log: "0" | "1"): Promise<Scratch> {
  const keep = process.env.CANVAS_SAVE_LOG;
  process.env.CANVAS_SAVE_LOG = log;
  try {
    return await spawn(root);
  } finally {
    process.env.CANVAS_SAVE_LOG = keep;
  }
}

describe("second review: the log deleted, moved or copied from outside", () => {
  test("the log deleted while Canvas runs (a cleanup tool, or a version control clean or stash): its edits are written again", async () => {
    for (const next of ["an edit", "compaction"]) {
      const p = pkg("logdeleted");
      const s = await spawn(p.root);
      try {
        const c = client(s.base, p.pkg);
        await c.open();
        assert.equal((await c.update("B0N1", { name: "E1" })).status, 200);
        assert.equal((await c.flush()).status, 200);
        assert.ok(fs.existsSync(p.logPath), "E1 is in the log");
        assert.equal(nodeIn(alone(p.docPath), "B0N1").name, "Layer 0.1", "and only there");
        fs.rmSync(p.logPath);
        if (next === "an edit") {
          assert.equal((await c.update("B1N1", { name: "E2" })).status, 200);
          assert.equal((await c.flush()).status, 200);
          assert.equal(nodeIn(withLog(p.docPath), "B1N1").name, "E2");
        }
        assert.ok(await until(() => nodeIn(alone(p.docPath), "B0N1").name === "E1", 8000), `${next}: the deleted log's edit is in document.json`);
      } finally {
        await stop(s);
      }
      assert.equal(nodeIn(alone(p.docPath), "B0N1").name, "E1", `${next}: after quitting`);
    }
  });

  test("the package moved and reopened at its new path by the same server, then saved by another app: the logged edit is kept", async () => {
    for (const order of ["open, then the other app saves", "the other app saves, then open"]) {
      const p = pkg("moved");
      const s = await spawn(p.root);
      try {
        const a = client(s.base, p.pkg);
        await a.open();
        assert.equal((await a.update("B0N1", { name: "E1" })).status, 200);
        assert.equal((await a.flush()).status, 200);
        const m = moved(p, "Moved.canvas");
        const b = client(s.base, m.pkg);
        if (order.startsWith("open")) {
          assert.equal((await b.open()).status, 200);
          await sleep(300);
        }
        outsideSave(m.docPath, (d) => (nodeIn(d, "B5N6").name = "OUT"));
        if (!order.startsWith("open")) assert.equal((await b.open()).status, 200);
        await sleep(400);
        await b.flush();
        await sleep(2000);
        await b.flush();
        assert.equal(nodeIn(withLog(m.docPath), "B5N6").name, "OUT", `${order}: the other app's save is kept`);
        assert.ok(keptAnywhere(m, "B0N1", "E1"), `${order}: E1 is in document.json or a recovery copy`);
      } finally {
        await stop(s);
      }
    }
  });

  test("a copy of the package (Finder Duplicate) made while the log has records holds the same edits as the original", async () => {
    for (const who of ["the same server", "a second server", "a server started after the first quit"]) {
      const p = pkg("copy");
      const A = await spawn(p.root);
      let B: Scratch | undefined;
      try {
        const a = client(A.base, p.pkg);
        await a.open();
        assert.equal((await a.update("B0N1", { name: "E1" })).status, 200);
        assert.equal((await a.flush()).status, 200);
        const cp = path.join(p.root, "Big copy.canvas");
        fs.cpSync(p.pkg, cp, { recursive: true, preserveTimestamps: true });
        const c = { pkg: cp, docPath: path.join(cp, "document.json"), logPath: L.logPathOf(path.join(cp, "document.json")) };
        assert.ok(fs.existsSync(c.logPath), "the copy has the log");
        if (who === "a second server") B = await spawn(p.root);
        if (who.startsWith("a server started")) {
          await stop(A);
          B = await spawn(p.root);
        }
        const s = client((B ?? A).base, c.pkg);
        assert.equal((await s.open()).status, 200);
        assert.ok(await until(() => !fs.existsSync(c.logPath), 8000), `${who}: the copy's log is folded into the copy`);
        assert.equal(nodeIn(alone(c.docPath), "B0N1").name, "E1", `${who}: the copy holds the original's edit`);
        assert.equal(nodeIn(withLog(p.docPath), "B0N1").name, "E1", `${who}: the original still holds it`);
      } finally {
        await stop(A);
        if (B) await stop(B);
      }
    }
  });
});

describe("second review: the lock held by another Canvas", () => {
  test("a log is never recovered or deleted without the lock: it waits for it, and the server keeps answering", async () => {
    const p = pkg("lockheld");
    let s = await spawn(p.root);
    await client(s.base, p.pkg).open();
    assert.equal((await client(s.base, p.pkg).update("B0N1", { name: "E1" })).status, 200);
    assert.equal((await client(s.base, p.pkg).flush()).status, 200);
    await kill9(s);
    outsideSave(p.docPath, (d) => (nodeIn(d, "B5N6").name = "OUT")); // the log is stale now, its server gone
    const logBytes = fs.readFileSync(p.logPath);
    const h = await holdLock(L.lockPathOf(p.docPath), 7000);
    try {
      s = await spawn(p.root);
      const c = client(s.base, p.pkg);
      const t0 = Date.now();
      assert.equal((await c.open()).status, 200);
      let worst = 0;
      while (Date.now() - t0 < 6000) {
        const q = Date.now();
        await fetch(`${s.base}/health`).then((r) => r.arrayBuffer());
        worst = Math.max(worst, Date.now() - q);
        await sleep(100);
      }
      assert.ok(worst < 1000, `the server kept answering while the lock was held (slowest answer ${worst} ms)`);
      assert.deepEqual(fs.readFileSync(p.logPath), logBytes, "the log is untouched while another Canvas holds the lock");
      assert.equal(fs.readdirSync(p.pkg).filter((f) => f.startsWith("document.json.recovered-")).length, 0, "no recovery made without the lock");
      await h.released;
      assert.ok(await until(() => !fs.existsSync(p.logPath), 8000), "settled once the lock was free");
      assert.ok(keptAnywhere(p, "B0N1", "E1"), "E1 kept (a recovery copy)");
      assert.equal(nodeIn(alone(p.docPath), "B5N6").name, "OUT");
    } finally {
      h.kill();
      await stop(s);
    }
  });

  test("an edit while the lock is held: answered at once, on disk once the lock is free, with the other app's save", async () => {
    const p = pkg("lockedit");
    const s = await spawn(p.root);
    let h: Awaited<ReturnType<typeof holdLock>> | undefined;
    try {
      const c = client(s.base, p.pkg);
      await c.open();
      assert.equal((await c.update("B0N1", { name: "E1" })).status, 200);
      assert.equal((await c.flush()).status, 200);
      h = await holdLock(L.lockPathOf(p.docPath), 6000);
      outsideSave(p.docPath, (d) => (nodeIn(d, "B5N6").name = "OUT"));
      await sleep(300);
      const t0 = Date.now();
      assert.equal((await c.update("B1N1", { name: "E2" })).status, 200);
      const took = Date.now() - t0;
      assert.ok(took < 1000, `the edit answered in ${took} ms`);
      const q = Date.now();
      await fetch(`${s.base}/health`).then((r) => r.arrayBuffer());
      assert.ok(Date.now() - q < 1000, "health answers");
      await h.released;
      assert.equal((await c.flush()).status, 200);
      const d = withLog(p.docPath);
      assert.equal(nodeIn(d, "B0N1").name, "E1");
      assert.equal(nodeIn(d, "B1N1").name, "E2");
      assert.equal(nodeIn(d, "B5N6").name, "OUT");
    } finally {
      h?.kill();
      await stop(s);
    }
  });
});

describe("second review: the package renamed while open", () => {
  test("an edit sent to the old path fails loudly instead of being answered and lost (log on and off)", async () => {
    for (const log of ["1", "0"] as const) {
      const p = pkg("rename");
      const s = await spawnWith(p.root, log);
      try {
        const a = client(s.base, p.pkg);
        await a.open();
        assert.equal((await a.update("B0N1", { name: "E1" })).status, 200);
        assert.equal((await a.flush()).status, 200);
        const m = moved(p, "Renamed.canvas");
        const u = await a.update("B1N1", { name: "E2-old-path" });
        assert.notEqual(u.status, 200, `log ${log}: an edit to a file that is not there is refused`);
        assert.match(JSON.stringify(u.j), /moved or deleted/, `log ${log}: and says why`);
        assert.ok(s.log.join("").includes("moved or deleted"), `log ${log}: the page is told (saveproblem)`);
        await stop(s);
        assert.equal(nodeIn(withLog(m.docPath), "B0N1").name, "E1", `log ${log}: the edit before the rename is kept`);
      } finally {
        await stop(s);
      }
    }
  });
});
