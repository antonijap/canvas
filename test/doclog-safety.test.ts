// The save log when something else writes the same file (src/doc/doclog.ts, src/docwriter.ts). Each test is a case the
// 2026-11-17 review reproduced as silent data loss (docs/evidence/speed.md, "Save log review"): two Canvas servers on
// one file, an outside whole save before compaction, a same-bytes rewrite during an append, an old log coming back
// when document.json returns to its base bytes, a newer build's log deleted. Scratch copies only, with the log on
// (CANVAS_SAVE_LOG=1, documents of 2 MB).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
      // A sync client, cp or git checkout of an unchanged file: the same bytes, a new file. Only over the file it read:
      // when Canvas replaced it meanwhile, that round is skipped (writing back older bytes is another case).
      const rewriter = (async () => {
        while (!stop) {
          const fd = fs.openSync(p.docPath, "r");
          let ino: number, bytes: Buffer;
          try {
            ino = fs.fstatSync(fd).ino;
            bytes = fs.readFileSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          fs.writeFileSync(p.docPath + ".sync", bytes);
          if (fs.statSync(p.docPath).ino === ino) {
            fs.renameSync(p.docPath + ".sync", p.docPath);
            rewrites++;
          } else fs.rmSync(p.docPath + ".sync");
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

  // An edit that comes in while a write pass looks at the disk (before its append) is saved by that pass, and leaves
  // the writer dirty: the pass after it has nothing new to append. Found under load (12 of 64 same-bytes runs).
  const records = (p: { logPath: string }) => {
    const r = L.parseLog(fs.readFileSync(p.logPath), "", undefined, true);
    return r && "info" in r ? r.info.records : -1;
  };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  /** Someone puts the same bytes in place again (a sync client): a new file, nothing else changed. */
  const sameBytesAgain = (docPath: string) => {
    fs.writeFileSync(docPath + ".sync", fs.readFileSync(docPath));
    fs.renameSync(docPath + ".sync", docPath);
  };
  /** FileHandle.prototype.sync patched to call `after(fh)` once each fsync is done; returns the restore. */
  async function onSync(docPath: string, after: (fh: fs.promises.FileHandle) => void) {
    const probe = await fs.promises.open(docPath, "r");
    const FH = Object.getPrototypeOf(probe);
    await probe.close();
    const sync = FH.sync;
    FH.sync = async function (this: fs.promises.FileHandle) {
      await sync.call(this);
      after(this);
    };
    return () => void (FH.sync = sync);
  }
  /** Whether a file handle is the log beside `logPath`. */
  const isLog = (fh: fs.promises.FileHandle, logPath: string) => {
    try {
      return fs.fstatSync(fh.fd).ino === fs.statSync(logPath).ino;
    } catch {
      return false;
    }
  };
  /**
   * E1 flushed (the log holds one record), then E2 saved while E3 comes in during the write pass's first look at the
   * disk. `afterLogSync(n)` runs right after the n-th fsync of the log from then on.
   */
  async function editInLookWindow(p: ReturnType<typeof pkg>, afterLogSync?: (n: number) => void) {
    const c = at(p);
    await c.open();
    assert.equal((await c.update("B0N1", { name: "E1" })).status, 200);
    assert.equal((await c.flush()).status, 200);
    assert.equal(records(p), 1, "E1 is the log's first record");
    const keepCompact = pw.writeConfig.compactAfterMs;
    pw.writeConfig.compactAfterMs = 60_000; // no fold while the case runs
    const stat = fs.promises.stat;
    let armed = true, syncs = 0;
    fs.promises.stat = async function (this: unknown, f: fs.PathLike, ...rest: unknown[]) {
      const inPass = armed && String(f) === p.docPath && !!new Error().stack?.includes("runWrites");
      const r = await (stat as (...a: unknown[]) => Promise<fs.Stats>).call(this, f, ...rest);
      if (inPass && armed) {
        armed = false;
        assert.equal((await c.update("B0N3", { name: "E3" })).status, 200);
      }
      return r;
    } as typeof stat;
    const restore = await onSync(p.docPath, (fh) => {
      if (isLog(fh, p.logPath)) afterLogSync?.(++syncs);
    });
    try {
      assert.equal((await c.update("B0N2", { name: "E2" })).status, 200);
      await c.flush();
      assert.equal(armed, false, "E3 came in during the pass's look at the disk");
      await until(() => !pw.hasPendingWrites(p.docPath));
      await c.flush();
    } finally {
      fs.promises.stat = stat;
      restore();
      pw.writeConfig.compactAfterMs = keepCompact;
    }
  }

  test("a write pass with nothing new appends no record", async () => {
    const p = pkg("noempty");
    await editInLookWindow(p);
    assert.equal(records(p), 2, "E1, then E2 and E3 in one record; no empty one after it");
    const d = withLog(p.docPath);
    for (const [id, name] of [["B0N1", "E1"], ["B0N2", "E2"], ["B0N3", "E3"]]) assert.equal(nodeIn(d, id).name, name);
    await pw.compactWrites(p.docPath);
  });

  test("the same bytes put in place during the pass after an edit came in: Canvas's own log is not taken for someone else's", async () => {
    const p = pkg("noemptyrename");
    await editInLookWindow(p, (n) => n === 2 && sameBytesAgain(p.docPath));
    const d = withLog(p.docPath);
    for (const [id, name] of [["B0N1", "E1"], ["B0N2", "E2"], ["B0N3", "E3"]]) assert.equal(nodeIn(d, id).name, name, `${id} on disk`);
    assert.deepEqual(fs.readdirSync(p.pkg).filter((f) => f.startsWith("document.json.recovered-")), [], "no recovery copy: nothing was someone else's");
    assert.equal(nodeIn(pw.currentDoc(p.docPath).doc, "B0N3").name, "E3", "and Canvas still shows E3");
    await pw.compactWrites(p.docPath);
  });

  test("an append that fails right after the log's fsync: once a retry finds its record, the journal lets go of the edit and the log is folded on time", async () => {
    const p = pkg("syncfail");
    const c = at(p);
    await c.open();
    const x0 = nodeIn(alone(p.docPath), "B3N4").x;
    const keep = pw.writeConfig.compactAfterMs;
    pw.writeConfig.compactAfterMs = 2000;
    let failed = false;
    const restore = await onSync(p.docPath, (fh) => {
      if (failed || !isLog(fh, p.logPath)) return;
      failed = true;
      throw new Error("injected: an error right after the log's fsync");
    });
    try {
      assert.equal((await c.move("B3N4", 5)).status, 200);
      assert.equal((await c.flush()).status, 200);
      assert.ok(failed, "the append failed after its record was durable");
      await until(() => !pw.hasPendingWrites(p.docPath));
      const journals = fs.readdirSync(p.pkg).filter((f) => f.startsWith(".document.json.canvas-journal-") && !f.includes("-kept"));
      for (const f of journals) {
        const lines = fs.readFileSync(path.join(p.pkg, f), "utf8").split("\n").filter(Boolean).slice(1);
        assert.deepEqual(lines.filter((l) => "edit" in JSON.parse(l)), [], `${f} no longer holds the saved edit`);
      }
      assert.equal(nodeIn(withLog(p.docPath), "B3N4").x, x0 + 5, "the nudge is on disk, in the log");
      assert.ok(await until(() => !fs.existsSync(p.logPath), 6000), "the log is folded once edits pause");
      assert.equal(nodeIn(alone(p.docPath), "B3N4").x, x0 + 5, "document.json alone holds the nudge, once");
    } finally {
      restore();
      pw.writeConfig.compactAfterMs = keep;
      await pw.compactWrites(p.docPath);
    }
  });

  test("another server's log put in place of ours while an append retries is recovered, not taken as ours", async () => {
    const p = pkg("foreignwindow");
    const c = at(p);
    await c.open();
    assert.equal((await c.update("B0N1", { name: "E1" })).status, 200);
    assert.equal((await c.flush()).status, 200);
    assert.equal(records(p), 1);
    let done = false;
    const restore = await onSync(p.docPath, (fh) => {
      if (done || !isLog(fh, p.logPath)) return;
      done = true;
      // Right after our record is durable: a log another (gone) server wrote for these bytes takes our log's place,
      // and the same bytes are put in place again, so the append retries before its bookkeeping.
      const bytes = fs.readFileSync(p.docPath);
      const st0 = fs.statSync(p.docPath);
      const tmp = p.logPath + ".other";
      fs.writeFileSync(tmp, "-");
      const ino = fs.statSync(tmp).ino;
      const head = L.headerOf(sha(bytes), `${st0.ino}:${st0.mtimeMs}:${ino}:${st0.ctimeMs}`, "99999999.feed.1");
      const rec = L.encodeRecord(1, [], undefined, undefined, [{ p: ["B7", "B7N7"], v: { ...nodeIn(JSON.parse(bytes.toString("utf8")), "B7N7"), name: "FOREIGN" } }]);
      fs.writeFileSync(tmp, Buffer.concat([head, rec.bytes])); // in place: its tie names this very log file
      fs.renameSync(tmp, p.logPath);
      sameBytesAgain(p.docPath);
    });
    try {
      assert.equal((await c.update("B1N1", { name: "E2" })).status, 200);
      await c.flush();
      assert.ok(done, "the other log came in during the append");
      await until(() => !pw.hasPendingWrites(p.docPath));
      await c.flush();
    } finally {
      restore();
    }
    const d = withLog(p.docPath);
    assert.equal(nodeIn(d, "B0N1").name, "E1", "our logged edit is kept");
    assert.equal(nodeIn(d, "B1N1").name, "E2", "and our pending one");
    assert.notEqual(nodeIn(d, "B7N7").name, "FOREIGN", "the other server's record is not put on top as if it were ours");
    const rec = fs.readdirSync(p.pkg).filter((f) => f.startsWith("document.json.recovered-"));
    assert.equal(rec.length, 1, "it is kept as a recovery copy");
    assert.equal(nodeIn(JSON.parse(fs.readFileSync(path.join(p.pkg, rec[0]), "utf8")), "B7N7").name, "FOREIGN");
    await pw.compactWrites(p.docPath);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// The second review (docs/evidence/speed.md, "Save log, second review fixes"): each case lost acknowledged edits with
// the log on, none with it off.

/** Another process holds the log's lock until released, or for `ms` when given. */
async function holdLock(lockPath: string, ms?: number) {
  const { spawn: spawnProc } = await import("node:child_process");
  const code = `const fs=require("fs");const fd=fs.openSync(process.argv[1],fs.constants.O_RDWR|fs.constants.O_CREAT|0x20,0o600);const release=()=>{fs.closeSync(fd);console.log("RELEASED");process.stdin.destroy()};console.log("HELD");if(Number(process.argv[2]))setTimeout(release,Number(process.argv[2]));else{process.stdin.resume();process.stdin.once("end",release)}`;
  const h = spawnProc(process.execPath, ["-e", code, lockPath, String(ms ?? 0)], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((r) => h.stdout!.on("data", (d) => String(d).includes("HELD") && r()));
  const released = new Promise<void>((r) => (h.exitCode !== null ? r() : h.once("exit", () => r())));
  return { released, release: () => h.stdin!.end(), kill: () => void h.kill("SIGKILL") };
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
    const h = await holdLock(L.lockPathOf(p.docPath));
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
      h.release();
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

// ------------------------------------------------------------------------------------------------------------------
// The last four cases (docs/evidence/speed.md, "Save log, last cases"): a plain whole save whose load saw no log, the
// lock on a volume without flock, Save As by a server that never opened the source, a restore in place of the base.

const { saveDoc } = await import("../src/doc/docfile.ts");
const { execFileSync } = await import("node:child_process");
const { pathToFileURL } = await import("node:url");

/**
 * Another Canvas in the middle of folding the log into a whole write: it holds the lock from its last look at the
 * disk until its rename (`ms` later), then puts `bytes` in place and retires the log, as runWrites does.
 */
async function foldBy(p: { root: string; docPath: string; logPath: string }, bytes: string, ms: number) {
  const { spawn: spawnProc } = await import("node:child_process");
  const src = path.join(p.root, `fold-${n++}.json`);
  fs.writeFileSync(src, bytes);
  const code = `const fs=require("fs");const [lock,doc,log,src,ms]=process.argv.slice(1);const fd=fs.openSync(lock,fs.constants.O_RDWR|fs.constants.O_CREAT|0x20|fs.constants.O_NONBLOCK,0o600);console.log("HELD");setTimeout(()=>{fs.copyFileSync(src,doc+".fold.tmp");fs.renameSync(doc+".fold.tmp",doc);fs.rmSync(log,{force:true});fs.closeSync(fd);console.log("DONE")},Number(ms))`;
  const h = spawnProc(process.execPath, ["-e", code, L.lockPathOf(p.docPath), p.docPath, p.logPath, src, String(ms)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => h.stdout!.on("data", (d) => String(d).includes("HELD") && r()));
  return { done: new Promise<void>((r) => (h.exitCode !== null ? r() : h.once("exit", () => r()))) };
}
/** A server started with extra environment (read when it starts). */
async function spawnEnv(root: string, env: Record<string, string>): Promise<Scratch> {
  const keep = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await spawn(root);
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
/** A preload that makes every volume look like one without flock (a network share whose server has no lock support). */
function noFlockPreload(): string {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "no-flock.mjs");
  fs.writeFileSync(
    f,
    `import fs from "node:fs";
const open = fs.openSync;
fs.openSync = function (p, flags, ...rest) {
  if (typeof flags === "number" && flags & 0x20 && String(p).endsWith(".canvas-lock")) throw Object.assign(new Error("ENOTSUP: operation not supported (simulated: no flock on this volume)"), { code: "ENOTSUP" });
  return open.call(this, p, flags, ...rest);
};
`,
  );
  return f;
}
/** A layer's name as a running server shows it. */
async function shown(b: string, file: string, id: string): Promise<string | undefined> {
  const r = await fetch(`${b}/api/node?file=${encodeURIComponent(file)}&id=${encodeURIComponent(id)}&depth=0`, { headers: { "x-canvas": "1" } });
  const j: any = await r.json();
  return j?.name ?? j?.node?.name;
}

describe("last cases", () => {
  test("a plain whole save (store.ts saveDoc) whose load saw no log takes the lock: it never lands inside another Canvas's fold", async () => {
    const p = pkg("plainlock");
    const l = loadDoc(p.docPath); // before any log existed
    assert.equal(l.logSeen, undefined);
    // Another Canvas makes a log, answers an edit from it, and crashes; a third Canvas folds that log into a whole
    // write (it holds the lock from its last look at the disk until its rename).
    const B = await spawn(p.root);
    const b = client(B.base, p.pkg);
    await b.open();
    assert.equal((await b.update("B0N1", { name: "E1" })).status, 200);
    assert.equal((await b.flush()).status, 200);
    await kill9(B);
    assert.ok(fs.existsSync(p.logPath), "E1 is in the log");
    const fold = await foldBy(p, JSON.stringify(withLog(p.docPath), null, 2), 1500);
    const keep = L.lockConfig.syncWaitMs;
    L.lockConfig.syncWaitMs = 5000; // a standalone process (a script, the MCP server) waits for the lock
    let answered = false, refused = "";
    try {
      nodeIn(l.doc, "B9N9").name = "PLAIN";
      saveDoc(l, l.doc);
      answered = true;
    } catch (e) {
      refused = (e as Error).message;
    } finally {
      L.lockConfig.syncWaitMs = keep;
    }
    await fold.done;
    const d = alone(p.docPath);
    assert.equal(nodeIn(d, "B0N1").name, "E1", "the other Canvas's acknowledged edit is in document.json");
    if (answered) assert.equal(nodeIn(d, "B9N9").name, "PLAIN", "the plain save answered: its edit is in document.json");
    else assert.match(refused, /changed on disk/, "the plain save was refused, and says why");
    // Redone on what is there now: both.
    writeDoc(p.docPath, {}, (x) => void (nodeIn(x, "B9N9").name = "PLAIN"));
    const e = alone(p.docPath);
    assert.equal(nodeIn(e, "B0N1").name, "E1");
    assert.equal(nodeIn(e, "B9N9").name, "PLAIN");
  });

  test("on a volume without flock the log stays off: saves are whole, no stand-in lock file, and a log that came along is still folded", async () => {
    const pre = noFlockPreload();
    const env = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(pre).href}`.trim() };
    const p = pkg("noflock");
    const s = await spawnEnv(p.root, env);
    try {
      const c = client(s.base, p.pkg);
      await c.open();
      assert.equal((await c.update("B0N1", { name: "E1" })).status, 200);
      assert.equal((await c.flush()).status, 200);
      assert.equal(fs.existsSync(p.logPath), false, "the log stays off on a volume without flock");
      assert.equal(nodeIn(alone(p.docPath), "B0N1").name, "E1", "the edit is in document.json, saved whole");
      assert.equal(fs.existsSync(L.lockPathOf(p.docPath) + ".held"), false, "no stand-in lock file");
    } finally {
      await stop(s);
    }
    // A package with a log in it (made where flock works, its server gone) copied onto such a volume: still applied
    // and folded into document.json.
    const q = pkg("noflock-copy");
    const B = await spawn(q.root);
    await client(B.base, q.pkg).open();
    assert.equal((await client(B.base, q.pkg).update("B2N2", { name: "LOGGED" })).status, 200);
    assert.equal((await client(B.base, q.pkg).flush()).status, 200);
    await kill9(B);
    assert.ok(fs.existsSync(q.logPath));
    const t = await spawnEnv(q.root, env);
    try {
      assert.equal((await client(t.base, q.pkg).open()).status, 200);
      assert.ok(await until(() => !fs.existsSync(q.logPath), 8000), "the log is folded");
      assert.equal(nodeIn(alone(q.docPath), "B2N2").name, "LOGGED");
      assert.equal(fs.existsSync(L.lockPathOf(q.docPath) + ".held"), false, "no stand-in lock file");
    } finally {
      await stop(t);
    }
  });

  test("Save As by a server that never opened the source: the copy holds every acknowledged edit, and no log", async () => {
    for (const owner of ["alive", "crashed"]) {
      const p = pkg("saveas");
      const B = await spawn(p.root);
      let A: Scratch | undefined;
      try {
        const b = client(B.base, p.pkg);
        await b.open();
        assert.equal((await b.update("B0N1", { name: "E1" })).status, 200);
        assert.equal((await b.flush()).status, 200);
        assert.ok(fs.existsSync(p.logPath), `${owner}: E1 is in the log`);
        if (owner === "crashed") await kill9(B);
        A = await spawn(p.root);
        const target = path.join(p.root, `Copy ${owner}.canvas`);
        const r = await fetch(`${A.base}/api/canvas/save-as`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file: p.pkg, target }) });
        assert.equal(r.status, 200, `${owner}: ${await r.clone().text()}`);
        const cp = path.join(fs.realpathSync(target), "document.json");
        assert.equal(nodeIn(alone(cp), "B0N1").name, "E1", `${owner}: the copy's document.json holds the edit`);
        assert.equal(fs.existsSync(L.logPathOf(cp)), false, `${owner}: no log carried over`);
        assert.equal(nodeIn(withLog(p.docPath), "B0N1").name, "E1", `${owner}: the original still holds it`);
      } finally {
        if (A) await stop(A);
        if (owner === "alive") await stop(B);
      }
    }
  });

  test("document.json put back in place to the log's base bytes with the old mtime (cp -p, a backup tool): the logged edit is not applied again, and is kept as a recovery copy", async () => {
    for (const when of ["after a crash", "while Canvas runs"]) {
      const p = pkg("restore");
      const backup = path.join(p.root, "backup-document.json");
      execFileSync("cp", ["-p", p.docPath, backup]); // the backup: these bytes, this mtime
      let s = await spawn(p.root);
      try {
        const c = client(s.base, p.pkg);
        await c.open();
        assert.equal((await c.update("B0N1", { name: "E1" })).status, 200);
        assert.equal((await c.flush()).status, 200);
        assert.ok(fs.existsSync(p.logPath), `${when}: E1 is in the log`);
        if (when === "after a crash") await kill9(s);
        const st0 = fs.statSync(p.docPath);
        await sleep(30);
        execFileSync("cp", ["-p", backup, p.docPath]); // the person rolls the file back to the backup, in place
        const st1 = fs.statSync(p.docPath);
        assert.equal(st1.ino, st0.ino, "the same file");
        assert.equal(st1.mtimeMs, st0.mtimeMs, "the same mtime");
        assert.notEqual(st1.ctimeMs, st0.ctimeMs, "only the ctime moved");
        if (when === "after a crash") {
          s = await spawn(p.root);
          assert.equal((await client(s.base, p.pkg).open()).status, 200);
        } else await sleep(1500);
        await client(s.base, p.pkg).flush();
        assert.ok(await until(() => !fs.existsSync(p.logPath), 8000), `${when}: the log is settled`);
        assert.equal(nodeIn(alone(p.docPath), "B0N1").name, "Layer 0.1", `${when}: the restore stands (the logged edit is not applied again)`);
        assert.equal(await shown(s.base, p.pkg, "B0N1"), "Layer 0.1", `${when}: Canvas shows the restored file`);
        const rec = fs.readdirSync(p.pkg).filter((f) => f.startsWith("document.json.recovered-"));
        assert.equal(rec.length, 1, `${when}: a recovery copy`);
        assert.equal(nodeIn(JSON.parse(fs.readFileSync(path.join(p.pkg, rec[0]), "utf8")), "B0N1").name, "E1", `${when}: the recovery copy holds the logged edit`);
        assert.ok(s.log.join("").includes(rec[0]), `${when}: and the person is told where it is`);
      } finally {
        await stop(s);
      }
    }
  });

  // Found by the two-server fuzz (docs/evidence/speed.md, "Save log, last cases").
  test("a log of ours loaded at a new path (the package moved) and made stale before it was folded: its edits are kept", async () => {
    const p = pkg("movedstale");
    const s = await spawn(p.root);
    let h: Awaited<ReturnType<typeof holdLock>> | undefined;
    try {
      const a = client(s.base, p.pkg);
      await a.open();
      assert.equal((await a.update("B0N1", { name: "E1" })).status, 200);
      assert.equal((await a.flush()).status, 200);
      const m = moved(p, "Moved.canvas");
      // Another Canvas holds the lock, so the fold of the log this server now loads at the new path waits...
      h = await holdLock(L.lockPathOf(m.docPath), 1500);
      assert.equal((await client(s.base, m.pkg).open()).status, 200);
      assert.equal(await shown(s.base, m.pkg, "B0N1"), "E1", "the log applies at the new path");
      // ...while a sync client writes the same bytes again (another file: the log is stale for it).
      fs.writeFileSync(m.docPath + ".sync", fs.readFileSync(m.docPath));
      fs.renameSync(m.docPath + ".sync", m.docPath);
      await h.released;
      await sleep(500);
      await client(s.base, m.pkg).flush();
      assert.ok(await until(() => !fs.existsSync(m.logPath), 8000), "the log is settled");
      assert.ok(keptAnywhere(m, "B0N1", "E1"), "E1 is in document.json or a recovery copy");
    } finally {
      h?.kill();
      await stop(s);
    }
  });

  // Found by the two-server fuzz: a nudge on disk twice.
  test("another Canvas folds the log into a whole write and dies before retiring it: the owner applies nothing twice", async () => {
    // That other Canvas is killed right after its rename of document.json lands (before it removes the log).
    fs.mkdirSync(dir, { recursive: true });
    const pre = path.join(dir, "die-after-rename.mjs");
    fs.writeFileSync(
      pre,
      `import fs from "node:fs";
const rename = fs.promises.rename;
fs.promises.rename = async function (a, b, ...rest) {
  await rename.call(this, a, b, ...rest);
  if (String(b).endsWith("/document.json") && String(a).endsWith(".tmp")) process.kill(process.pid, "SIGKILL");
};
`,
    );
    const p = pkg("foldcrash");
    const S = await spawn(p.root);
    try {
      const s = client(S.base, p.pkg);
      await s.open();
      const x0 = nodeIn(alone(p.docPath), "B3N4").x;
      assert.equal((await s.move("B3N4", 1)).status, 200);
      assert.equal((await s.flush()).status, 200);
      assert.ok(fs.existsSync(p.logPath), "the nudge is in S's log");
      const N = await spawnEnv(p.root, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(pre).href}`.trim() });
      spawned.delete(N);
      const n = client(N.base, p.pkg);
      await n.open();
      assert.equal((await n.update("B9N9", { name: "N-EDIT" })).status, 200);
      void n.flush().catch(() => {});
      await new Promise<void>((r) => (N.proc.exitCode !== null || N.proc.signalCode ? r() : N.proc.once("exit", () => r())));
      assert.equal(nodeIn(alone(p.docPath), "B9N9").name, "N-EDIT", "N's whole write landed");
      assert.equal(nodeIn(alone(p.docPath), "B3N4").x, x0 + 1, "with S's nudge in it");
      // N died before removing S's log; S may have settled it already (it reads the fold line), so no look at it here.
      await sleep(800);
      await s.flush();
      assert.ok(await until(() => !fs.existsSync(p.logPath), 8000), "the log is settled");
      assert.equal(nodeIn(withLog(p.docPath), "B3N4").x, x0 + 1, "the nudge is on disk once");
      assert.equal(nodeIn(withLog(p.docPath), "B9N9").name, "N-EDIT");
      assert.equal((await fetch(`${S.base}/api/node?file=${encodeURIComponent(p.pkg)}&id=B3N4&depth=0`).then((r) => r.json()) as any).node.x, x0 + 1, "and in S once");
    } finally {
      await stop(S);
    }
  });
});
