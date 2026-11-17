// Data safety of the background writer (src/docwriter.ts), one test per way an edit could be lost, rolled back,
// cut short or shown differently from the file: an outside reload during a write, structure edits replayed under
// new ids, short synchronous writes, failures that looked like a successful flush, undo after a relative replay,
// timestamp-preserving outside edits, file-hash revisions, and renders of what is on disk. Faults are injected by
// stubbing fs in this process.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("docwriter-safety");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_STATE_DIR = path.join(dir, "state-home");

const pw = await import("../src/docwriter.ts");
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const { moveNode } = await import("../src/move.ts");
const { revisionOf, sha, writeDoc } = await import("../src/engine.ts");
const { SnapshotCache } = await import("../src/snapcache.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
pw.writeConfig.syncBytes = 0;

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const docOf = (boards: number, kids = 5) => ({
  version: "2.21",
  children: Array.from({ length: boards }, (_, b) => ({
    type: "frame", id: `B${b}`, name: `Board ${b}`, x: b * 500, y: 0, width: 390, height: 844, layout: "none",
    children: Array.from({ length: kids }, (_, k) => ({ type: "rectangle", id: `R${b}_${k}`, x: k * 10, y: k * 10, width: 40, height: 40, fill: "#FF0000" })),
  })),
});
const make = (name: string, doc: unknown = docOf(10)) => {
  const p = path.join(dir, `${name}.canvas.json`);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  return fs.realpathSync(p);
};
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const q = (file: string) => `?file=${encodeURIComponent(file)}`;
const open = (file: string) => call("GET", `/api/doc${q(file)}`);
const update = (file: string, id: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) => call("POST", "/api/update", { file, id, props, ...extra });
const node = (file: string, id: string) => call("GET", `/api/node${q(file)}&id=${encodeURIComponent(id)}`);
const disk = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const nodeIn = (doc: any, id: string): any => {
  const seek = (ns: any[]): any => { for (const n of ns ?? []) { if (n.id === id) return n; const h = seek(n.children); if (h) return h; } };
  return seek(doc.children);
};
/** Someone else saves the file the way most apps do: a temp file renamed over it. */
const outsideSave = (file: string, edit: (doc: any) => void) => {
  const d = disk(file);
  edit(d);
  fs.writeFileSync(file + ".x", JSON.stringify(d, null, 2));
  fs.renameSync(file + ".x", file);
};
const isTemp = (file: string, p: unknown) => typeof p === "string" && path.basename(p).startsWith(`.${path.basename(file)}.canvas-`);
const recoveries = (file: string) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.recovered-`));

/** Hold the next background write of `file` at its fsync (before the rename) until release(). */
function holdAtSync(file: string) {
  const orig = fs.promises.open;
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hit = new Promise<void>((r) => (reached = r));
  let once = false;
  (fs.promises as any).open = async (p: any, ...rest: any[]) => {
    const fh = await (orig as any).call(fs.promises, p, ...rest);
    if (!once && isTemp(file, p)) {
      once = true;
      const sync = fh.sync.bind(fh);
      fh.sync = async () => {
        reached();
        await gate;
        return sync();
      };
    }
    return fh;
  };
  return { hit, release, restore: () => ((fs.promises as any).open = orig) };
}

/** Hold the next rename onto `file` (already past every check) until release(); every rename's result is kept. */
function holdAtRename(file: string, opts: { hold?: boolean } = {}) {
  const orig = fs.promises.rename;
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hit = new Promise<void>((r) => (reached = r));
  let once = !opts.hold;
  const commits: string[] = [];
  (fs.promises as any).rename = async (from: any, to: any) => {
    if (to === file && !once) {
      once = true;
      reached();
      await gate;
    }
    await (orig as any).call(fs.promises, from, to);
    if (to === file) commits.push(fs.readFileSync(file, "utf8"));
  };
  return { hit, release, commits, restore: () => ((fs.promises as any).rename = orig) };
}

async function slowWrites<T>(f: () => Promise<T>, ms = 5000): Promise<T> {
  const d = pw.writeConfig.debounceMs, m = pw.writeConfig.maxDelayMs;
  pw.writeConfig.debounceMs = ms;
  pw.writeConfig.maxDelayMs = ms;
  try {
    return await f();
  } finally {
    pw.writeConfig.debounceMs = d;
    pw.writeConfig.maxDelayMs = m;
  }
}

describe("writer data safety", () => {
  test("1. an outside save during a write in flight: no write of ours ever drops it from the file", async () => {
    const file = make("inflight");
    await open(file);
    const held = holdAtSync(file);
    const renames = holdAtRename(file);
    try {
      assert.equal((await update(file, "R1_1", { fill: "#123456" })).status, 200);
      await held.hit; // our write has its temp file, not renamed yet
      outsideSave(file, (d) => d.children.push({ type: "frame", id: "Theirs", name: "Theirs", x: 0, y: 2000, width: 10, height: 10, children: [] }));
      assert.equal((await node(file, "Theirs")).status, 200, "Canvas loaded their save");
      held.release();
      await pw.flushWrites(file);
      for (const c of renames.commits) assert.ok(nodeIn(JSON.parse(c), "Theirs"), "every file we put in place keeps their board");
      const d = disk(file);
      assert.ok(nodeIn(d, "Theirs"));
      assert.equal(nodeIn(d, "R1_1").fill, "#123456");
    } finally {
      held.release();
      held.restore();
      renames.restore();
    }
  });

  test("3. a duplicate and a move of it, then an outside save: replayed with the same id, the move kept, undo works", async () => {
    const file = make("dupmove");
    await open(file);
    history.resetHistory(file);
    const held = holdAtSync(file);
    try {
      const dup = await call("POST", "/api/structure", { file, op: "duplicate", ids: ["R2_0"] });
      assert.equal(dup.status, 200);
      const id = dup.body.select[0];
      await held.hit;
      assert.equal((await call("POST", "/api/move", { file, id, x: 99 })).status, 200);
      outsideSave(file, (d) => d.children.push({ type: "frame", id: "Theirs", name: "Theirs", x: 0, y: 2000, width: 10, height: 10, children: [] }));
      assert.equal((await node(file, "Theirs")).status, 200);
      held.release();
      await pw.flushWrites(file);
      const d = disk(file);
      assert.ok(nodeIn(d, "Theirs"));
      assert.equal(nodeIn(d, id)?.x, 99, "the duplicate kept its id and the move");
      assert.equal(nodeIn(d, "B2").children.length, 6, "one duplicate, not two");
      assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
      assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
      await pw.flushWrites(file);
      assert.equal(nodeIn(disk(file), id), undefined, "undo removed the duplicate");
      assert.ok(nodeIn(disk(file), "Theirs"));
    } finally {
      held.release();
      held.restore();
    }
  });

  test("5. a short synchronous write never puts a truncated file in place", async () => {
    const file = make("short", docOf(2, 2));
    await open(file);
    const orig = fs.writeSync;
    pw.writeConfig.syncBytes = 1e9;
    (fs as any).writeSync = (fd: number, data: any, ...rest: any[]) => {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      const off = typeof rest[0] === "number" ? rest[0] : 0;
      const len = typeof rest[1] === "number" ? rest[1] : buf.length - off;
      return orig(fd, buf, off, Math.min(len, 7));
    };
    try {
      assert.equal((await update(file, "R0_0", { fill: "#ABCDEF" })).status, 200);
    } finally {
      (fs as any).writeSync = orig;
      pw.writeConfig.syncBytes = 0;
    }
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R0_0").fill, "#ABCDEF");
  });

  test("6. writes that keep failing: flush rejects, and quitting keeps a recovery copy", async () => {
    const file = make("failing");
    await open(file);
    const orig = fs.promises.open;
    (fs.promises as any).open = async (p: any, ...rest: any[]) => {
      if (isTemp(file, p)) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return (orig as any).call(fs.promises, p, ...rest);
    };
    try {
      assert.equal((await update(file, "R4_4", { fill: "#0F0F0F" })).status, 200);
      await assert.rejects(pw.flushWrites(file), /not saved/);
      assert.equal(nodeIn(disk(file), "R4_4").fill, "#FF0000");
      const { problems, kept } = await pw.finishWrites(1000);
      pw.resumeWrites();
      assert.ok(problems.length > 0);
      assert.equal(kept, true);
      const rec = recoveries(file);
      assert.equal(rec.length, 1);
      assert.equal(nodeIn(JSON.parse(fs.readFileSync(path.join(dir, rec[0]), "utf8")), "R4_4").fill, "#0F0F0F", "the recovery copy holds the edit");
    } finally {
      (fs.promises as any).open = orig;
    }
    await pw.flushWrites(file); // the disk works again: the next flush writes it
    assert.equal(nodeIn(disk(file), "R4_4").fill, "#0F0F0F");
  });

  test("7. a nudge replayed on an outside value: undo goes back to that value", async () => {
    const file = make("nudge");
    await open(file);
    history.resetHistory(file);
    await slowWrites(async () => {
      assert.equal((await call("POST", "/api/move", { file, id: "R5_0", dx: 1, merge: "nudge" })).status, 200);
      outsideSave(file, (d) => (nodeIn(d, "R5_0").x = 100));
      assert.equal((await node(file, "R5_0")).body.node.x, 101, "the nudge replayed on their value");
    });
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R5_0").x, 101);
    const u = await call("POST", `/api/history/undo${q(file)}`);
    assert.equal(u.status, 200, u.body.error);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R5_0").x, 100);
  });

  test("8. an outside edit that keeps inode, size and mtime is not taken for our own write", async () => {
    const file = make("mtime");
    await open(file);
    const t = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    const orig = fs.promises.open;
    (fs.promises as any).open = async (p: any, ...rest: any[]) => {
      const fh = await (orig as any).call(fs.promises, p, ...rest);
      if (isTemp(file, p)) {
        const sync = fh.sync.bind(fh);
        fh.sync = async () => {
          await fh.utimes(t, t); // a whole-second mtime, so the outside edit below can put it back exactly
          return sync();
        };
      }
      return fh;
    };
    try {
      assert.equal((await update(file, "R6_0", { fill: "#111111" })).status, 200);
      await pw.flushWrites(file);
    } finally {
      (fs.promises as any).open = orig;
    }
    await node(file, "R6_0");
    const before = fs.statSync(file);
    assert.equal(before.mtimeMs, t.getTime());
    // Same inode (written in place), same length, mtime put back.
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"#111111"', '"#222222"'));
    fs.utimesSync(file, t, t);
    const now = fs.statSync(file);
    assert.equal(`${now.ino}:${now.size}:${now.mtimeMs}`, `${before.ino}:${before.size}:${before.mtimeMs}`);
    assert.equal((await node(file, "R6_0")).body.node.fill, "#222222", "their edit is what Canvas shows");
    assert.equal((await update(file, "R6_1", { fill: "#333333" })).status, 200);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R6_0").fill, "#222222", "and our next write keeps it");
    assert.equal(nodeIn(disk(file), "R6_1").fill, "#333333");
  });

  test("9. the file-hash revision of a state written in the background is accepted", async () => {
    const file = make("hashrev");
    await open(file);
    assert.equal((await update(file, "R7_0", { fill: "#444444" })).status, 200);
    await pw.flushWrites(file);
    const rev = revisionOf(sha(fs.readFileSync(file, "utf8")));
    const r = await update(file, "R7_1", { fill: "#555555" }, { expectedRevision: rev });
    assert.equal(r.status, 200, r.body.error);
    // And the other way: Canvas hands out that revision once its state is on disk.
    const f = await call("POST", "/api/flush", { file });
    assert.equal(f.status, 200);
    assert.equal(f.body.fileRevision, revisionOf(sha(fs.readFileSync(file, "utf8"))));
  });

  test("10. a render right after an edit sees it: /api/flush puts that state on disk and names its bytes", async () => {
    const file = make("render");
    await open(file);
    await slowWrites(async () => {
      const dup = await call("POST", "/api/structure", { file, op: "duplicate", ids: ["R8_0"] });
      const id = dup.body.select[0];
      assert.equal((await update(file, id, { fill: "#666666" })).status, 200);
      const f = await call("POST", "/api/flush", { file });
      assert.equal(f.status, 200);
      const raw = fs.readFileSync(file, "utf8");
      assert.equal(f.body.fileRevision, revisionOf(sha(raw)), "the bytes on disk are the state it names");
      assert.equal(nodeIn(JSON.parse(raw), id)?.fill, "#666666", "the new node is on disk before the render reads it");
    });
  });
});

describe("writer data safety, second review", () => {
  test("11. an outside edit in place while our rename is in flight is kept (the replaced bytes are linked first)", async () => {
    const file = make("crossed");
    await open(file);
    const orig = fs.promises.rename;
    let once = false;
    (fs.promises as any).rename = async (from: any, to: any) => {
      if (to === file && !once) {
        once = true;
        // Someone writes the file in place, after every check of ours and before our rename lands.
        const d = disk(file);
        d.children.push({ type: "frame", id: "Theirs", name: "Theirs", x: 0, y: 2000, width: 10, height: 10, children: [] });
        fs.writeFileSync(file, JSON.stringify(d, null, 2));
      }
      return (orig as any).call(fs.promises, from, to);
    };
    try {
      assert.equal((await update(file, "R1_1", { fill: "#123456" })).status, 200);
      await pw.flushWrites(file).catch(() => {});
      await pw.flushWrites(file);
    } finally {
      (fs.promises as any).rename = orig;
    }
    const d = disk(file);
    assert.ok(nodeIn(d, "Theirs"), "their save is in the file");
    assert.equal(nodeIn(d, "R1_1").fill, "#123456", "and so is our edit");
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("crossed.canvas.json.conflict-")), "their bytes are also kept as they were");
  });

  test("12. an outside edit right after our rename (same inode, size and mtime) is not taken for ours", async () => {
    const file = make("afterrename");
    await open(file);
    const t = new Date(Math.floor(Date.now() / 1000) * 1000 - 120_000);
    const open0 = fs.promises.open, rename0 = fs.promises.rename;
    let once = false;
    (fs.promises as any).open = async (p: any, ...rest: any[]) => {
      const fh = await (open0 as any).call(fs.promises, p, ...rest);
      if (isTemp(file, p)) {
        const sync = fh.sync.bind(fh);
        fh.sync = async () => {
          await fh.utimes(t, t);
          return sync();
        };
      }
      return fh;
    };
    (fs.promises as any).rename = async (from: any, to: any) => {
      await (rename0 as any).call(fs.promises, from, to);
      if (to === file && !once) {
        once = true;
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"#111111"', '"#222222"'));
        fs.utimesSync(file, t, t);
      }
    };
    try {
      assert.equal((await update(file, "R6_0", { fill: "#111111" })).status, 200);
      await pw.flushWrites(file);
    } finally {
      (fs.promises as any).open = open0;
      (fs.promises as any).rename = rename0;
    }
    assert.equal(nodeIn(disk(file), "R6_0").fill, "#222222");
    assert.equal((await update(file, "R6_1", { fill: "#333333" })).status, 200);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R6_0").fill, "#222222", "our next write keeps their edit");
    assert.equal((await node(file, "R6_0")).body.node.fill, "#222222", "and Canvas shows it");
  });

  test("13. a group that cannot be replayed (its layers moved elsewhere) leaves nothing behind", async () => {
    const file = make("groupmoved");
    await open(file);
    const held = holdAtSync(file);
    try {
      assert.equal((await call("POST", "/api/structure", { file, op: "group", ids: ["R0_1", "R0_2"] })).status, 200);
      await held.hit;
      outsideSave(file, (d) => {
        const b0 = nodeIn(d, "B0"), b1 = nodeIn(d, "B1");
        const moved = b0.children.filter((n: any) => n.id === "R0_1" || n.id === "R0_2");
        b0.children = b0.children.filter((n: any) => !moved.includes(n));
        b1.children.push(...moved);
      });
      assert.equal((await node(file, "R0_1")).status, 200);
      held.release();
      await pw.flushWrites(file).catch(() => {});
    } finally {
      held.release();
      held.restore();
    }
    const d = disk(file);
    assert.deepEqual(nodeIn(d, "B0").children.map((n: any) => n.id), ["R0_0", "R0_3", "R0_4"], "no empty group left in B0");
    assert.deepEqual((await node(file, "B0")).body.node.children.map((n: any) => n.id), ["R0_0", "R0_3", "R0_4"], "nor in what Canvas shows");
    assert.ok(recoveries(file).length >= 1);
  });

  test("14. a merged nudge step whose newer part replays on an outside value: undo never jumps over that value", async () => {
    const file = make("mergednudge");
    await open(file);
    history.resetHistory(file);
    assert.equal((await call("POST", "/api/move", { file, id: "R5_0", dx: 1, merge: "nudge" })).status, 200);
    await pw.flushWrites(file);
    await slowWrites(async () => {
      assert.equal((await call("POST", "/api/move", { file, id: "R5_0", dx: 1, merge: "nudge" })).status, 200);
      outsideSave(file, (d) => (nodeIn(d, "R5_0").x = 100));
      assert.equal((await node(file, "R5_0")).body.node.x, 101);
    });
    await pw.flushWrites(file);
    assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R5_0").x, 100, "undo goes back to their value");
    const second = await call("POST", `/api/history/undo${q(file)}`);
    assert.equal(second.status, 409, "the older nudge (0 to 1) refuses instead of writing 0 over their 100");
    assert.equal(nodeIn(disk(file), "R5_0").x, 100);
  });

  test("15. a read that a write overtook is never applied under the old signature", async () => {
    const file = make("overtaken", docOf(2, 2));
    const write = (fill: string) => {
      const d = docOf(2, 2) as any;
      d.children[0].children[0].fill = fill;
      fs.writeFileSync(file + ".x", JSON.stringify(d, null, 2));
      fs.renameSync(file + ".x", file);
    };
    let n = 0;
    const c = new SnapshotCache({
      onChange() {},
      forcePoll: true,
      pollMs: 100000,
      loadAsync: async (f: string) => {
        const { loadDocAsync } = await import("../src/engine.ts");
        const l = await loadDocAsync(f);
        if (++n === 2) write("#CCCCCC"); // a save lands while this read is in flight
        return l;
      },
    });
    try {
      await c.ensure(file);
      write("#BBBBBB");
      const s = await c.ensure(file);
      assert.equal((s.doc.children[0] as any).children[0].fill, "#CCCCCC", "the bytes on disk, not the overtaken read");
    } finally {
      c.close();
    }
  });

  test("17. once quitting has begun, no edit is taken (none can slip past the last save)", async () => {
    const file = make("quitting");
    await open(file);
    await pw.finishWrites(500);
    try {
      const r = await update(file, "R0_0", { fill: "#999999" });
      assert.notEqual(r.status, 200);
      assert.equal(nodeIn(disk(file), "R0_0").fill, "#FF0000");
    } finally {
      pw.resumeWrites();
    }
  });

  test("18. when no recovery copy can be written, the edits stay in memory and quitting says so", async () => {
    const file = make("norecovery");
    await open(file);
    const open0 = fs.promises.open, openSync0 = fs.openSync;
    (fs.promises as any).open = async (p: any, ...rest: any[]) => {
      if (isTemp(file, p)) throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      return (open0 as any).call(fs.promises, p, ...rest);
    };
    (fs as any).openSync = (p: any, ...rest: any[]) => {
      if (typeof p === "string" && p.includes("norecovery.canvas.json.recovered-")) throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      return (openSync0 as any)(p, ...rest);
    };
    try {
      assert.equal((await update(file, "R3_3", { fill: "#ABABAB" })).status, 200);
      const r = await pw.finishWrites(800);
      assert.equal(r.kept, false, "nothing could keep the edit: the process must not exit");
      assert.ok(pw.hasPendingWrites(file));
    } finally {
      (fs.promises as any).open = open0;
      (fs as any).openSync = openSync0;
      pw.resumeWrites();
    }
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R3_3").fill, "#ABABAB");
  });

  test("19. a multi-move that no longer applies after an outside save (now auto layout) is reported, not silently dropped", async () => {
    const file = make("multimove");
    await open(file);
    await slowWrites(async () => {
      assert.equal((await call("POST", "/api/move", { file, items: [{ id: "R2_1", dx: 5 }, { id: "R2_2", dx: 5 }] })).status, 200);
      outsideSave(file, (d) => (nodeIn(d, "B2").layout = "vertical"));
      assert.equal((await node(file, "B2")).body.node.layout, "vertical");
    });
    await assert.rejects(pw.flushWrites(file), /could not be applied/);
    assert.ok(recoveries(file).length >= 1, "Canvas's version with the move is kept");
  });

  test("20. edits not yet on disk are journaled; a journal left by a crash comes back as a recovery copy", async () => {
    const file = make("journal");
    await open(file);
    const journalOf = () => fs.readdirSync(dir).find((f) => f.startsWith(".journal.canvas.json.canvas-journal-"));
    await slowWrites(async () => {
      assert.equal((await update(file, "R1_2", { fill: "#0A0A0A" })).status, 200);
      assert.match(fs.readFileSync(path.join(dir, journalOf()!), "utf8"), /#0A0A0A/, "the edit is on disk in the journal before the file is written");
    });
    await pw.flushWrites(file);
    assert.equal(journalOf(), undefined, "written: the journal is gone");
    // A server that crashed with an edit only in its journal, then a fresh start on that file.
    const crashed = make("crashed");
    const base = sha(fs.readFileSync(crashed, "utf8"));
    const op = { t: "node", id: "R2_2", props: { fill: { b: { v: "#FF0000" }, a: { v: "#0B0B0B" } } } };
    const dead = 2 ** 22 + 12345; // no such process
    fs.writeFileSync(path.join(dir, `.crashed.canvas.json.canvas-journal-${dead}`), `${JSON.stringify({ base })}\n${JSON.stringify({ edit: "x", ops: [op] })}\n`);
    await open(crashed);
    const rec = recoveries(crashed);
    assert.equal(rec.length, 1);
    assert.equal(nodeIn(JSON.parse(fs.readFileSync(path.join(dir, rec[0]), "utf8")), "R2_2").fill, "#0B0B0B");
    assert.equal(nodeIn(disk(crashed), "R2_2").fill, "#FF0000", "the document itself is left alone");
    assert.equal(fs.existsSync(path.join(dir, `.crashed.canvas.json.canvas-journal-${dead}`)), false);
  });

  test("21. the plain whole write (store.ts writeDoc) never puts a short file in place either", async () => {
    const file = make("plainshort", docOf(2, 2));
    const orig = fs.writeSync;
    (fs as any).writeSync = (fd: number, data: any, ...rest: any[]) => {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      const off = typeof rest[0] === "number" ? rest[0] : 0;
      const len = typeof rest[1] === "number" ? rest[1] : buf.length - off;
      return orig(fd, buf, off, Math.min(len, 7));
    };
    try {
      writeDoc(file, {}, (d) => void (nodeIn(d, "R0_1").fill = "#C0C0C0"));
    } finally {
      (fs as any).writeSync = orig;
    }
    assert.equal(nodeIn(disk(file), "R0_1").fill, "#C0C0C0");
  });
});

describe("writer data safety, third review", () => {
  /** Our writes get a whole-second mtime, so an outside edit can put the exact mtime back. */
  function wholeSecondWrites(file: string, t: Date) {
    const open0 = fs.promises.open;
    (fs.promises as any).open = async (p: any, ...rest: any[]) => {
      const fh = await (open0 as any).call(fs.promises, p, ...rest);
      if (isTemp(file, p)) {
        const sync = fh.sync.bind(fh);
        fh.sync = async () => {
          await fh.utimes(t, t);
          return sync();
        };
      }
      return fh;
    };
    return () => ((fs.promises as any).open = open0);
  }

  test("22. an edit in place that keeps size and mtime, landing between our checks and our rename, is kept", async () => {
    const file = make("crossedmtime");
    await open(file);
    const t = new Date(Math.floor(Date.now() / 1000) * 1000 - 180_000);
    const undo = wholeSecondWrites(file, t);
    const rename0 = fs.promises.rename;
    try {
      assert.equal((await update(file, "R2_0", { fill: "#111111" })).status, 200);
      await pw.flushWrites(file);
      let once = false;
      (fs.promises as any).rename = async (from: any, to: any) => {
        if (to === file && !once) {
          once = true;
          fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"#111111"', '"#222222"'));
          fs.utimesSync(file, t, t);
        }
        return (rename0 as any).call(fs.promises, from, to);
      };
      assert.equal((await update(file, "R2_1", { fill: "#333333" })).status, 200);
      await pw.flushWrites(file).catch(() => {});
      await pw.flushWrites(file);
    } finally {
      undo();
      (fs.promises as any).rename = rename0;
    }
    const d = disk(file);
    assert.equal(nodeIn(d, "R2_0").fill, "#222222", "their edit survived");
    assert.equal(nodeIn(d, "R2_1").fill, "#333333");
  });

  test("23. no write goes ahead without keeping the bytes it replaces; a volume without links gets a checked copy", async () => {
    const file = make("nolink");
    await open(file);
    const link0 = fs.promises.link;
    (fs.promises as any).link = async () => {
      throw Object.assign(new Error("EIO: i/o error, link"), { code: "EIO" });
    };
    try {
      assert.equal((await update(file, "R1_0", { fill: "#121212" })).status, 200);
      await assert.rejects(pw.flushWrites(file), /not saved/);
      assert.equal(nodeIn(disk(file), "R1_0").fill, "#FF0000", "nothing replaced unprotected");
      (fs.promises as any).link = async () => {
        throw Object.assign(new Error("ENOTSUP: operation not supported, link"), { code: "ENOTSUP" });
      };
      await pw.flushWrites(file);
      assert.equal(nodeIn(disk(file), "R1_0").fill, "#121212", "a volume without hard links still saves (through a checked copy)");
    } finally {
      (fs.promises as any).link = link0;
    }
  });

  test("24. an older version of ours put back by someone else is their change, and Canvas shows it", async () => {
    const file = make("restore");
    await open(file);
    assert.equal((await update(file, "R3_0", { fill: "#AAAAAA" })).status, 200);
    await pw.flushWrites(file);
    const keep = path.join(dir, "restore-a.keep");
    fs.linkSync(file, keep); // version A, the very inode
    assert.equal((await update(file, "R3_0", { fill: "#BBBBBB" })).status, 200);
    await pw.flushWrites(file);
    fs.renameSync(keep, file); // someone restores A
    assert.equal((await node(file, "R3_0")).body.node.fill, "#AAAAAA");
    assert.equal((await update(file, "R3_1", { fill: "#CCCCCC" })).status, 200);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R3_0").fill, "#AAAAAA");
  });

  test("25. an undo not yet on disk is in the crash journal as the ops it runs", async () => {
    const file = make("undojournal");
    await open(file);
    history.resetHistory(file);
    assert.equal((await call("POST", "/api/structure", { file, op: "delete", ids: ["R4_2"] })).status, 200);
    await pw.flushWrites(file);
    const held = holdAtSync(file);
    try {
      assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
      await held.hit;
      const j = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith(".undojournal.canvas.json.canvas-journal-"))!), "utf8");
      assert.match(j, /"kind":"insert"/);
      assert.match(j, /"R4_2"/);
    } finally {
      held.release();
      held.restore();
    }
    await pw.flushWrites(file);
  });

  test("26. a crash journal that cannot be written is reported", async () => {
    const file = make("journalfail");
    await open(file);
    const seen: string[] = [];
    const prev = pw.writerHooks.problem;
    pw.writerHooks.problem = (f, m) => {
      seen.push(m);
      prev?.(f, m);
    };
    const openSync0 = fs.openSync;
    (fs as any).openSync = (p: any, ...rest: any[]) => {
      if (typeof p === "string" && p.includes("journalfail.canvas.json.canvas-journal")) throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      return (openSync0 as any)(p, ...rest);
    };
    try {
      await slowWrites(async () => {
        assert.equal((await update(file, "R0_0", { fill: "#0C0C0C" })).status, 200);
      });
    } finally {
      (fs as any).openSync = openSync0;
      pw.writerHooks.problem = prev;
    }
    assert.ok(seen.some((m) => /crash journal/.test(m)), seen.join(" | "));
    await pw.flushWrites(file);
  });

  test("27. a journal entry that cannot be applied keeps the journal and says so", async () => {
    const file = make("journalbad");
    const dead = 2 ** 22 + 23456;
    const op = { t: "node", id: "Gone", props: { fill: { b: null, a: { v: "#010101" } } } };
    fs.writeFileSync(path.join(dir, `.journalbad.canvas.json.canvas-journal-${dead}`), `${JSON.stringify({ base: "x" })}\n${JSON.stringify({ edit: "y", ops: [op] })}\n`);
    await open(file);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("journalbad.canvas.json.journal-")), "the journal is kept next to the file");
  });

  test("28. another live server's journal is left alone", async () => {
    const file = make("journallive");
    const live = path.join(dir, `.journallive.canvas.json.canvas-journal-${process.ppid}`);
    fs.writeFileSync(live, `${JSON.stringify({ base: "x" })}\n`);
    await open(file);
    assert.ok(fs.existsSync(live));
  });

  test("29. a kept copy of replaced bytes left by a killed server is not deleted when it differs", async () => {
    const file = make("staleprev");
    const dead = 2 ** 22 + 34567;
    const prev = path.join(dir, `.staleprev.canvas.json.canvas-${dead}-abcd1234-prev.tmp`);
    fs.writeFileSync(prev, JSON.stringify(docOf(1), null, 2));
    await open(file);
    await update(file, "R0_0", { fill: "#020202" }); // the writer's state for this file starts: it cleans up
    await pw.flushWrites(file);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(prev), false);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("staleprev.canvas.json.conflict-")));
  });

  test("29b. a killed server's kept copy of the bytes it was replacing (their hash in its name) is removed, not taken for someone's save", async () => {
    const file = make("ownprev");
    const dead = 2 ** 22 + 34568;
    // An older version the dead server wrote itself: different from the document now, and exactly the bytes its
    // write was based on (the hash its name carries).
    const old = JSON.stringify(docOf(1), null, 2);
    const prev = path.join(dir, `.ownprev.canvas.json.canvas-${dead}-abcd1234-${sha(old).slice(0, 16)}-prev.tmp`);
    fs.writeFileSync(prev, old);
    await open(file);
    const f = await call("POST", "/api/flush", { file });
    assert.equal(f.status, 200);
    assert.equal(fs.existsSync(prev), false, "the copy is gone once the reopened file is flushed");
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith("ownprev.canvas.json.conflict-")), [], "no false conflict copy");
  });

  test("29c. a killed server's kept copy whose bytes are not the ones its name says is kept as a conflict copy", async () => {
    const file = make("otherprev");
    const dead = 2 ** 22 + 34569;
    const prev = path.join(dir, `.otherprev.canvas.json.canvas-${dead}-abcd1234-${sha("something else").slice(0, 16)}-prev.tmp`);
    fs.writeFileSync(prev, JSON.stringify(docOf(1), null, 2));
    await open(file);
    await call("POST", "/api/flush", { file });
    assert.equal(fs.existsSync(prev), false);
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("otherprev.canvas.json.conflict-")).length, 1);
  });

  test("29d. the copy a write keeps of the bytes it replaces carries their hash in its name", async () => {
    const file = make("prevname");
    await open(file);
    const before = sha(fs.readFileSync(file, "utf8"));
    const seen: string[] = [];
    const orig = fs.promises.link;
    (fs.promises as any).link = async (a: any, b: any) => {
      seen.push(path.basename(String(b)));
      return (orig as any).call(fs.promises, a, b);
    };
    try {
      await update(file, "R0_0", { fill: "#030303" });
      await pw.flushWrites(file);
    } finally {
      (fs.promises as any).link = orig;
    }
    assert.ok(seen.some((n) => n.endsWith(`-${before.slice(0, 16)}-prev.tmp`)), seen.join(", "));
  });

  test("30. /api/flush names the bytes of the state it returns, even with edits arriving during the write", async () => {
    const file = make("flushrace");
    await open(file);
    const held = holdAtSync(file);
    try {
      assert.equal((await update(file, "R5_0", { fill: "#050505" })).status, 200);
      await held.hit;
      const f = call("POST", "/api/flush", { file });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal((await update(file, "R5_1", { fill: "#060606" })).status, 200);
      held.release();
      const r = await f;
      assert.equal(r.status, 200);
      const raw = fs.readFileSync(file, "utf8");
      assert.equal(r.body.fileRevision, revisionOf(sha(raw)));
      assert.equal(nodeIn(JSON.parse(raw), "R5_1").fill, "#060606");
    } finally {
      held.release();
      held.restore();
    }
  });

  test("31. the plain whole write keeps a save that lands between its last check and its rename", async () => {
    const file = make("plaincross", docOf(2, 2));
    const rename0 = fs.renameSync;
    let once = false;
    (fs as any).renameSync = (from: any, to: any) => {
      if (to === file && !once && typeof from === "string" && !isTemp(file, from) && from.endsWith(".tmp")) {
        once = true;
        const d = disk(file);
        d.children.push({ type: "frame", id: "Theirs", name: "Theirs", x: 0, y: 2000, width: 10, height: 10, children: [] });
        fs.writeFileSync(file, JSON.stringify(d, null, 2));
      }
      return rename0(from, to);
    };
    try {
      writeDoc(file, {}, (d) => void (nodeIn(d, "R0_1").fill = "#C1C1C1"));
    } finally {
      (fs as any).renameSync = rename0;
    }
    assert.ok(once, "the save went through the plain write path");
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith("plaincross.canvas.json.conflict-"));
    assert.equal(kept.length, 1);
    assert.ok(nodeIn(JSON.parse(fs.readFileSync(path.join(dir, kept[0]), "utf8")), "Theirs"));
  });
});

describe("writer data safety, fourth review", () => {
  test("32. a save built on our new bytes, loaded while our rename lands, does not replay our edit twice", async () => {
    const file = make("twice");
    await open(file);
    const rename0 = fs.promises.rename;
    let once = false;
    (fs.promises as any).rename = async (from: any, to: any) => {
      await (rename0 as any).call(fs.promises, from, to);
      if (to === file && !once) {
        once = true;
        outsideSave(file, (d) => (nodeIn(d, "R7_4").fill = "#0000FF")); // they read our bytes and save
        await node(file, "R7_4"); // Canvas looks before our rename has returned
      }
    };
    try {
      assert.equal((await call("POST", "/api/move", { file, id: "R7_0", dx: 1, merge: "nudge" })).status, 200);
      await pw.flushWrites(file);
    } finally {
      (fs.promises as any).rename = rename0;
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await node(file, "R7_0")).body.node.x, 1, "the nudge applied once");
    assert.equal((await node(file, "R7_4")).body.node.fill, "#0000FF");
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R7_0").x, 1);
    assert.equal(nodeIn(disk(file), "R7_4").fill, "#0000FF");
  });

  test("33. an undo of a structure step keeps its ops in the journal when it replays on an outside save", async () => {
    const file = make("undoreplay");
    await open(file);
    history.resetHistory(file);
    assert.equal((await call("POST", "/api/structure", { file, op: "delete", ids: ["R6_3"] })).status, 200);
    await pw.flushWrites(file);
    const held = holdAtSync(file);
    try {
      assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
      await held.hit;
      outsideSave(file, (d) => (nodeIn(d, "R6_0").fill = "#00FF00"));
      assert.equal((await node(file, "R6_0")).body.node.fill, "#00FF00");
      const j = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith(".undoreplay.canvas.json.canvas-journal-"))!), "utf8");
      assert.match(j, /"kind":"insert"/, "the journal still holds the tree op");
    } finally {
      held.release();
      held.restore();
    }
    await pw.flushWrites(file);
    assert.ok(nodeIn(disk(file), "R6_3"));
  });

  test("34. the plain whole write does not save when it cannot keep the bytes it replaces", async () => {
    const file = make("plainlink", docOf(2, 2));
    const link0 = fs.linkSync;
    (fs as any).linkSync = (a: any, b: any) => {
      if (a === file) throw Object.assign(new Error("EIO: i/o error, link"), { code: "EIO" });
      return link0(a, b);
    };
    try {
      assert.throws(() => writeDoc(file, {}, (d) => void (nodeIn(d, "R0_0").fill = "#D0D0D0")), /EIO/);
    } finally {
      (fs as any).linkSync = link0;
    }
    assert.equal(nodeIn(disk(file), "R0_0").fill, "#FF0000");
  });

  test("35. replaced bytes that cannot be read back are kept, not deleted", async () => {
    const file = make("unreadable");
    await open(file);
    const read0 = fs.promises.readFile;
    (fs.promises as any).readFile = async (p: any, ...rest: any[]) => {
      if (typeof p === "string" && p.endsWith("-prev.tmp") && p.includes("unreadable.canvas.json")) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      return (read0 as any).call(fs.promises, p, ...rest);
    };
    try {
      assert.equal((await update(file, "R1_1", { fill: "#E0E0E0" })).status, 200);
      await pw.flushWrites(file);
    } finally {
      (fs.promises as any).readFile = read0;
    }
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("unreadable.canvas.json.conflict-")));
  });

  test("36. a journal from an earlier run with our pid (pid reuse) is recovered, not taken for ours", async () => {
    const file = make("pidreuse");
    const op = { t: "node", id: "R0_0", props: { fill: { b: { v: "#FF0000" }, a: { v: "#0D0D0D" } } } };
    fs.writeFileSync(path.join(dir, `.pidreuse.canvas.json.canvas-journal-${process.pid}-0123456789ab`), `${JSON.stringify({ base: "x", pid: process.pid, started: 1000 })}\n${JSON.stringify({ edit: "z", ops: [op] })}\n`);
    await open(file);
    const rec = recoveries(file);
    assert.equal(rec.length, 1);
    assert.equal(nodeIn(JSON.parse(fs.readFileSync(path.join(dir, rec[0]), "utf8")), "R0_0").fill, "#0D0D0D");
  });

  test("37. a folder that cannot be synced after the rename keeps the journal, and flush says so", async () => {
    const file = make("dirsync");
    await open(file);
    const openSync0 = fs.openSync, fsync0 = fs.fsyncSync;
    const dirFds = new Set<number>();
    (fs as any).openSync = (p: any, ...rest: any[]) => {
      const fd = (openSync0 as any)(p, ...rest);
      if (p === dir || p === fs.realpathSync(dir)) dirFds.add(fd);
      return fd;
    };
    (fs as any).fsyncSync = (fd: number) => {
      if (dirFds.has(fd) && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      return fsync0(fd);
    };
    // The writer also syncs the folder off the main thread (fs.fsync): the same failure there.
    const fsyncCb0 = fs.fsync;
    (fs as any).fsync = (fd: number, cb: (e: Error | null) => void) => {
      try {
        if (dirFds.has(fd) && fs.fstatSync(fd).isDirectory()) (fs as any).fsyncSync(fd);
      } catch (e) {
        return void process.nextTick(cb, e as Error);
      }
      return (fsyncCb0 as any)(fd, cb);
    };
    try {
      assert.equal((await update(file, "R2_2", { fill: "#F0F0F0" })).status, 200);
      await assert.rejects(pw.flushWrites(file), /could not be synced/);
      assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(".dirsync.canvas.json.canvas-journal-")), "the journal stays");
    } finally {
      (fs as any).openSync = openSync0;
      (fs as any).fsyncSync = fsync0;
      (fs as any).fsync = fsyncCb0;
    }
    assert.equal((await update(file, "R2_3", { fill: "#F1F1F1" })).status, 200);
    await pw.flushWrites(file);
    assert.equal(fs.readdirSync(dir).some((f) => f.startsWith(".dirsync.canvas.json.canvas-journal-")), false, "synced: the journal is retired");
  });
});

describe("writer data safety, fifth review", () => {
  function failDirSync() {
    const openSync0 = fs.openSync, fsync0 = fs.fsyncSync;
    const dirFds = new Set<number>();
    (fs as any).openSync = (p: any, ...rest: any[]) => {
      const fd = (openSync0 as any)(p, ...rest);
      if (p === dir || p === fs.realpathSync(dir)) dirFds.add(fd);
      return fd;
    };
    (fs as any).fsyncSync = (fd: number) => {
      if (dirFds.has(fd) && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      return fsync0(fd);
    };
    // The writer also syncs the folder off the main thread (fs.fsync): the same failure there.
    const fsyncCb0 = fs.fsync;
    (fs as any).fsync = (fd: number, cb: (e: Error | null) => void) => {
      try {
        if (dirFds.has(fd) && fs.fstatSync(fd).isDirectory()) (fs as any).fsyncSync(fd);
      } catch (e) {
        return void process.nextTick(cb, e as Error);
      }
      return (fsyncCb0 as any)(fd, cb);
    };
    return () => {
      (fs as any).openSync = openSync0;
      (fs as any).fsyncSync = fsync0;
      (fs as any).fsync = fsyncCb0;
    };
  }
  const journals = (name: string) => fs.readdirSync(dir).filter((f) => f.startsWith(`.${name}.canvas.json.canvas-journal-`));

  test("38. a small save whose folder cannot be synced keeps its journal, and flush keeps saying so until it can", async () => {
    const file = make("smallsync", docOf(2, 2));
    await open(file);
    pw.writeConfig.syncBytes = 1e9;
    const restore = failDirSync();
    try {
      assert.equal((await update(file, "R0_0", { fill: "#101010" })).status, 200);
      assert.equal(journals("smallsync").length, 1, "journaled");
      await assert.rejects(pw.flushWrites(file));
      await assert.rejects(pw.flushWrites(file), /not durable/);
    } finally {
      restore();
      pw.writeConfig.syncBytes = 0;
    }
    await pw.flushWrites(file);
    assert.equal(journals("smallsync").length, 0);
  });

  test("39. edits whose recovery copy could not be written stay in a kept journal", async () => {
    const file = make("keptjournal");
    await open(file);
    const openSync0 = fs.openSync;
    (fs as any).openSync = (p: any, ...rest: any[]) => {
      if (typeof p === "string" && p.includes("keptjournal.canvas.json.recovered-")) throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      return (openSync0 as any)(p, ...rest);
    };
    try {
      await slowWrites(async () => {
        assert.equal((await update(file, "R3_3", { fill: "#131313" })).status, 200);
        assert.equal((await update(file, "R4_4", { fill: "#141414" })).status, 200);
        outsideSave(file, (d) => nodeIn(d, "B3").children.splice(3, 1)); // R3_3 is gone
        await node(file, "R4_4");
      });
      const all = journals("keptjournal").map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
      assert.match(all, /#131313/, "the lost edit is still in a journal on disk");
    } finally {
      (fs as any).openSync = openSync0;
    }
    await pw.flushWrites(file).catch(() => {});
    const { kept } = await pw.finishWrites(1000);
    pw.resumeWrites();
    assert.equal(kept, true);
    assert.ok(recoveries(file).length >= 1);
  });

  test("40. an ungroup replayed after someone added a layer to the group refuses instead of deleting that layer", async () => {
    const file = make("ungroupnew");
    await open(file);
    const g = await call("POST", "/api/structure", { file, op: "group", ids: ["R5_1", "R5_2"] });
    assert.equal(g.status, 200);
    const gid = g.body.select[0];
    await pw.flushWrites(file);
    const held = holdAtSync(file);
    try {
      assert.equal((await call("POST", "/api/structure", { file, op: "ungroup", ids: [gid] })).status, 200);
      await held.hit;
      outsideSave(file, (d) => nodeIn(d, gid).children.push({ type: "rectangle", id: "NEW1", x: 0, y: 0, width: 5, height: 5, fill: "#000000" }));
      await node(file, "NEW1");
    } finally {
      held.release();
      held.restore();
    }
    await pw.flushWrites(file).catch(() => {});
    assert.ok(nodeIn(disk(file), "NEW1"), "their layer is still there");
    assert.equal((await node(file, "NEW1")).status, 200);
  });

  test("41. a duplicate of an instance whose component someone deleted is not written with a dangling reference", async () => {
    const doc: any = docOf(2, 2);
    doc.children.push({ type: "frame", id: "C1", name: "Comp", reusable: true, x: 0, y: 3000, width: 20, height: 20, children: [] });
    doc.children[0].children.push({ type: "ref", id: "I1", ref: "C1", x: 50, y: 50 });
    const file = make("dangling", doc);
    await open(file);
    const held = holdAtSync(file);
    let id = "";
    try {
      const d = await call("POST", "/api/structure", { file, op: "duplicate", ids: ["I1"] });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      id = d.body.select[0];
      await held.hit;
      outsideSave(file, (x) => {
        x.children = x.children.filter((n: any) => n.id !== "C1");
        x.children[0].children = x.children[0].children.filter((n: any) => n.id !== "I1");
      });
      await node(file, "B0");
    } finally {
      held.release();
      held.restore();
    }
    await pw.flushWrites(file).catch(() => {});
    const raw = fs.readFileSync(file, "utf8");
    assert.equal(nodeIn(JSON.parse(raw), id), undefined);
    assert.doesNotMatch(raw, /"ref": "C1"/);
  });

  test("42. a replay held to the effect first accepted, even after a replay that had nothing to change", async () => {
    const file = make("accepted");
    await open(file);
    await slowWrites(async () => {
      assert.equal((await call("POST", "/api/resize", { file, id: "B6", props: { width: 400 }, children: [{ id: "R6_1", x: 33 }] })).status, 200);
      outsideSave(file, (d) => (nodeIn(d, "R6_1").x = 33)); // already there: the replay changes nothing
      await node(file, "R6_1");
      outsideSave(file, (d) => {
        nodeIn(d, "B6").layout = "vertical";
        nodeIn(d, "R6_1").x = 99;
      });
      await node(file, "R6_1");
    });
    await assert.rejects(pw.flushWrites(file), /could not be applied/);
  });

  test("43. a recovery copy never removes a file someone else just created under the same name", async () => {
    const file = make("recname");
    await open(file);
    const openSync0 = fs.openSync;
    let theirs = "";
    (fs as any).openSync = (p: any, flags: any, ...rest: any[]) => {
      if (!theirs && typeof p === "string" && p.includes("recname.canvas.json.recovered-") && flags === "wx") {
        theirs = p;
        fs.writeFileSync(p, "theirs"); // another process got there first
      }
      return (openSync0 as any)(p, flags, ...rest);
    };
    const open0 = fs.promises.open;
    (fs.promises as any).open = async (p: any, ...rest: any[]) => {
      if (isTemp(file, p)) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return (open0 as any).call(fs.promises, p, ...rest);
    };
    try {
      assert.equal((await update(file, "R7_7".replace("7_7", "7_3"), { fill: "#171717" })).status, 200);
      await pw.finishWrites(800);
    } finally {
      (fs as any).openSync = openSync0;
      (fs.promises as any).open = open0;
      pw.resumeWrites();
    }
    assert.equal(fs.readFileSync(theirs, "utf8"), "theirs", "their file is untouched");
    assert.ok(recoveries(file).filter((f) => path.join(dir, f) !== theirs).length >= 1, "ours went under another name");
    await pw.flushWrites(file);
  });
});

describe("writer data safety, sixth review", () => {
  test("44. quitting keeps the journals of recovery copies that still could not be written", async () => {
    const file = make("keptquit");
    await open(file);
    const openSync0 = fs.openSync;
    let allow = 0;
    (fs as any).openSync = (p: any, ...rest: any[]) => {
      if (typeof p === "string" && p.includes("keptquit.canvas.json.recovered-")) {
        if (allow-- <= 0) throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      }
      return (openSync0 as any)(p, ...rest);
    };
    try {
      for (const [id, board] of [["R3_3", 3], ["R4_4", 4]] as const) {
        await slowWrites(async () => {
          assert.equal((await update(file, id, { fill: "#212121" })).status, 200);
          outsideSave(file, (d) => nodeIn(d, `B${board}`).children.splice(id === "R3_3" ? 3 : 4, 1));
          await node(file, "B0");
        });
      }
      await pw.flushWrites(file).catch(() => {});
      allow = 1; // the first copy saves, the second still cannot
      const r = await pw.finishWrites(800);
      pw.resumeWrites();
      assert.equal(r.kept, false);
      assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(".keptquit.canvas.json.canvas-journal-") && f.includes("-kept")), "the kept journal stays");
    } finally {
      (fs as any).openSync = openSync0;
      pw.resumeWrites();
    }
    await pw.finishWrites(800);
    pw.resumeWrites();
  });

  test("45. preserved copies never take an existing name", () => {
    const a = path.join(dir, "excl-src");
    const dest = path.join(dir, "excl-dest");
    fs.writeFileSync(a, "mine");
    fs.writeFileSync(dest, "earlier");
    const got = pw.moveExclusive(a, dest);
    assert.notEqual(got, dest);
    assert.equal(fs.readFileSync(dest, "utf8"), "earlier");
    assert.equal(fs.readFileSync(got, "utf8"), "mine");
    assert.equal(fs.existsSync(a), false);
  });

  test("46. undoing a delete refuses when the instance's component is gone", async () => {
    const doc: any = docOf(2, 2);
    doc.children.push({ type: "frame", id: "C2", name: "Comp", reusable: true, x: 0, y: 3000, width: 20, height: 20, children: [] });
    doc.children[0].children.push({ type: "ref", id: "I2", ref: "C2", x: 50, y: 50 });
    const file = make("undoref", doc);
    await open(file);
    history.resetHistory(file);
    assert.equal((await call("POST", "/api/structure", { file, op: "delete", ids: ["I2"] })).status, 200);
    await pw.flushWrites(file);
    outsideSave(file, (d) => (d.children = d.children.filter((n: any) => n.id !== "C2")));
    await node(file, "B0");
    const u = await call("POST", `/api/history/undo${q(file)}`);
    assert.equal(u.status, 409);
    await pw.flushWrites(file);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /"ref": "C2"/);
  });
});

describe("writer data safety, seventh review", () => {
  test("47. while a written file is not durable, a newer edit does not replace the journal that covers it", async () => {
    const file = make("undurable");
    await open(file);
    const openSync0 = fs.openSync, fsync0 = fs.fsyncSync;
    const dirFds = new Set<number>();
    (fs as any).openSync = (p: any, ...rest: any[]) => {
      const fd = (openSync0 as any)(p, ...rest);
      if (p === dir || p === fs.realpathSync(dir)) dirFds.add(fd);
      return fd;
    };
    (fs as any).fsyncSync = (fd: number) => {
      if (dirFds.has(fd) && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      return fsync0(fd);
    };
    // The writer also syncs the folder off the main thread (fs.fsync): the same failure there.
    const fsyncCb0 = fs.fsync;
    (fs as any).fsync = (fd: number, cb: (e: Error | null) => void) => {
      try {
        if (dirFds.has(fd) && fs.fstatSync(fd).isDirectory()) (fs as any).fsyncSync(fd);
      } catch (e) {
        return void process.nextTick(cb, e as Error);
      }
      return (fsyncCb0 as any)(fd, cb);
    };
    try {
      assert.equal((await update(file, "R1_1", { fill: "#474747" })).status, 200);
      await pw.flushWrites(file).catch(() => {});
      assert.equal((await update(file, "R1_2", { fill: "#484848" })).status, 200);
      const all = fs.readdirSync(dir).filter((f) => f.startsWith(".undurable.canvas.json.canvas-journal-")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
      assert.match(all, /#474747/, "the not-yet-durable edit is still journaled (the newer one cannot be: the folder will not sync, and that is reported)");
    } finally {
      (fs as any).openSync = openSync0;
      (fs as any).fsyncSync = fsync0;
      (fs as any).fsync = fsyncCb0;
    }
    await pw.flushWrites(file).catch(() => {});
    await pw.flushWrites(file);
    assert.equal(fs.readdirSync(dir).some((f) => f.startsWith(".undurable.canvas.json.canvas-journal-")), false);
  });

});

describe("writer data safety, eighth review", () => {
  test("49. an outside write to the replaced file through a handle it held open is not lost", async () => {
    const file = make("openhandle");
    await open(file);
    const rename0 = fs.promises.rename;
    let fd = -1;
    (fs.promises as any).rename = async (from: any, to: any) => {
      if (to === file && fd < 0) fd = fs.openSync(file, "r+"); // someone holds the old file open
      return (rename0 as any).call(fs.promises, from, to);
    };
    try {
      assert.equal((await update(file, "R2_4", { fill: "#494949" })).status, 200);
      await pw.flushWrites(file);
    } finally {
      (fs.promises as any).rename = rename0;
    }
    // A moment later they write through that handle (to bytes no longer at the document's name).
    const theirs = Buffer.from(JSON.stringify({ ...docOf(1), note: "theirs" }, null, 2));
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, theirs, 0, theirs.length, 0);
    fs.closeSync(fd);
    pw.settleLingering();
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith("openhandle.canvas.json.conflict-"));
    assert.equal(kept.length, 1, "their late write is kept");
    assert.match(fs.readFileSync(path.join(dir, kept[0]), "utf8"), /theirs/);
  });

  test("50. an agent step does not fold across an outside change: undo stops at the outside value", async () => {
    const file = make("agentgap");
    await open(file);
    history.resetHistory(file);
    const mcp = { "content-type": "application/json", "x-canvas": "1", "x-canvas-source": "mcp", "x-canvas-session": "s1" };
    const move = (body: unknown) => fetch(base + "/api/move", { method: "POST", headers: mcp, body: JSON.stringify(body) }).then((r) => r.status);
    assert.equal(await move({ file, id: "R0_2", dx: 1 }), 200);
    await pw.flushWrites(file);
    outsideSave(file, (d) => (nodeIn(d, "R0_2").x = 100));
    assert.equal((await node(file, "R0_2")).body.node.x, 100);
    assert.equal(await move({ file, id: "R0_2", dx: 1 }), 200);
    await pw.flushWrites(file);
    assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R0_2").x, 100, "undo went back to the outside value, not to 20");
  });
});

describe("writer data safety, ninth review", () => {
  test("51. an agent step with a structure change in between still stops at an outside value", async () => {
    const file = make("agentgroup");
    await open(file);
    history.resetHistory(file);
    const mcp = { "content-type": "application/json", "x-canvas": "1", "x-canvas-source": "mcp", "x-canvas-session": "s2" };
    const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: mcp, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
    assert.equal((await post("/api/move", { file, id: "R0_3", dx: 1 })).status, 200);
    assert.equal((await post("/api/structure", { file, op: "group", ids: ["R0_3"] })).status, 200);
    await pw.flushWrites(file);
    const local = nodeIn(disk(file), "R0_3").x;
    outsideSave(file, (d) => (nodeIn(d, "R0_3").x = local + 50));
    assert.equal((await node(file, "R0_3")).body.node.x, local + 50);
    assert.equal((await post("/api/move", { file, id: "R0_3", dx: 1 })).status, 200);
    await pw.flushWrites(file);
    assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R0_3").x, local + 50, "undo stopped at their value");
  });

  test("52. a folder sync refused for permissions is not taken as durable", async () => {
    const file = make("dirperm");
    await open(file);
    const openSync0 = fs.openSync, fsync0 = fs.fsyncSync;
    const dirFds = new Set<number>();
    (fs as any).openSync = (p: any, ...rest: any[]) => {
      const fd = (openSync0 as any)(p, ...rest);
      if (p === dir || p === fs.realpathSync(dir)) dirFds.add(fd);
      return fd;
    };
    (fs as any).fsyncSync = (fd: number) => {
      if (dirFds.has(fd) && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
      return fsync0(fd);
    };
    // The writer also syncs the folder off the main thread (fs.fsync): the same failure there.
    const fsyncCb0 = fs.fsync;
    (fs as any).fsync = (fd: number, cb: (e: Error | null) => void) => {
      try {
        if (dirFds.has(fd) && fs.fstatSync(fd).isDirectory()) (fs as any).fsyncSync(fd);
      } catch (e) {
        return void process.nextTick(cb, e as Error);
      }
      return (fsyncCb0 as any)(fd, cb);
    };
    try {
      assert.equal((await update(file, "R3_1", { fill: "#525252" })).status, 200);
      await assert.rejects(pw.flushWrites(file));
    } finally {
      (fs as any).openSync = openSync0;
      (fs as any).fsyncSync = fsync0;
      (fs as any).fsync = fsyncCb0;
    }
    await pw.flushWrites(file);
  });
});

describe("writer data safety, tenth review", () => {
  test("53. while saves are not durable, every journal generation is kept (none replaced)", async () => {
    const file = make("generations");
    await open(file);
    const openSync0 = fs.openSync, fsync0 = fs.fsyncSync;
    const dirFds = new Set<number>();
    (fs as any).openSync = (p: any, ...rest: any[]) => {
      const fd = (openSync0 as any)(p, ...rest);
      if (p === dir || p === fs.realpathSync(dir)) dirFds.add(fd);
      return fd;
    };
    let failing = true;
    (fs as any).fsyncSync = (fd: number) => {
      if (failing && dirFds.has(fd) && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      return fsync0(fd);
    };
    // The writer also syncs the folder off the main thread (fs.fsync): the same failure there.
    const fsyncCb0 = fs.fsync;
    (fs as any).fsync = (fd: number, cb: (e: Error | null) => void) => {
      try {
        if (dirFds.has(fd) && fs.fstatSync(fd).isDirectory()) (fs as any).fsyncSync(fd);
      } catch (e) {
        return void process.nextTick(cb, e as Error);
      }
      return (fsyncCb0 as any)(fd, cb);
    };
    try {
      for (const [id, fill] of [["R4_0", "#530000"], ["R4_1", "#530001"], ["R4_2", "#530002"]]) {
        assert.equal((await update(file, id, { fill })).status, 200);
        await pw.flushWrites(file).catch(() => {});
      }
      const all = fs.readdirSync(dir).filter((f) => f.startsWith(".generations.canvas.json.canvas-journal-")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
      for (const fill of ["#530000", "#530001"]) assert.match(all, new RegExp(fill), `${fill} is still journaled`);
    } finally {
      failing = false;
      (fs as any).openSync = openSync0;
      (fs as any).fsyncSync = fsync0;
      (fs as any).fsync = fsyncCb0;
    }
    await pw.flushWrites(file).catch(() => {});
    await pw.flushWrites(file);
    assert.equal(fs.readdirSync(dir).some((f) => f.startsWith(".generations.canvas.json.canvas-journal-")), false);
  });
});

describe("writer data safety, eleventh review", () => {
  test("54. an undo not yet on disk whose step a rebase splits refuses instead of writing over the outside value", async () => {
    const file = make("splitundo");
    await open(file);
    history.resetHistory(file);
    // One step of three edits to x (a scrub): the first on disk, the other two still in memory.
    assert.equal((await update(file, "R5_1", { x: 1 }, { gesture: "g54" })).status, 200);
    await pw.flushWrites(file);
    await slowWrites(async () => {
      assert.equal((await update(file, "R5_1", { x: 5 }, { gesture: "g54" })).status, 200);
      assert.equal((await update(file, "R5_1", { x: 1 }, { gesture: "g54" })).status, 200);
      assert.equal(history.entries(file).undo.length, 1, "one step");
      // Undo the whole step (back to x=10) while none of it after the first edit is on disk...
      assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
      // ...and someone saves x=100 before our writes land: the step splits at their value.
      outsideSave(file, (d) => (nodeIn(d, "R5_1").x = 100));
      await node(file, "R5_1");
    });
    await assert.rejects(pw.flushWrites(file), "the refused undo is reported");
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R5_1").x, 1, "the undo refused: it did not jump over their 100 back to the step's start (10)");
  });
});

describe("writer data safety, eleventh review (Save As)", () => {
  test("56. Save As copies edits not yet on disk, and refuses (copying nothing) when they cannot be saved", async () => {
    const file = make("saveas");
    await open(file);
    await slowWrites(async () => {
      assert.equal((await update(file, "R3_3", { fill: "#565656" })).status, 200);
      assert.equal(nodeIn(disk(file), "R3_3").fill, "#FF0000", "the edit is only in memory");
      const target = path.join(dir, "SaveAsCopy.canvas");
      const r = await call("POST", "/api/canvas/save-as", { file, target });
      assert.equal(r.status, 200, r.body.error);
      assert.equal(nodeIn(JSON.parse(fs.readFileSync(path.join(target, "document.json"), "utf8")), "R3_3").fill, "#565656", "the copy holds the edit");
    });
    const orig = fs.promises.open;
    (fs.promises as any).open = async (p: any, ...rest: any[]) => {
      if (isTemp(file, p)) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return (orig as any).call(fs.promises, p, ...rest);
    };
    const target2 = path.join(dir, "SaveAsFails.canvas");
    try {
      assert.equal((await update(file, "R3_4", { fill: "#575757" })).status, 200);
      const r = await call("POST", "/api/canvas/save-as", { file, target: target2 });
      assert.equal(r.status, 503);
      assert.match(r.body.error, /Save As/);
      assert.equal(fs.existsSync(target2), false, "nothing was copied");
    } finally {
      (fs.promises as any).open = orig;
    }
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R3_4").fill, "#575757");
  });
});

describe("writer data safety, eleventh review (Codex)", () => {
  test("58. an edit is answered only once its journal line is fsynced; a burst shares the fsyncs (group commit)", async () => {
    const file = make("groupcommit");
    await open(file);
    const journal = () => fs.readdirSync(dir).filter((f) => f.startsWith(".groupcommit.canvas.json.canvas-journal-")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = performance.now() + 10_000;
      while (!condition()) {
        assert.ok(performance.now() < deadline, message);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const fsync0 = fs.fsync;
    let held: (() => void)[] = [];
    let calls = 0;
    await slowWrites(async () => {
      // The first edit opens the journal (written and fsynced before it answers).
      assert.equal((await update(file, "R0_0", { fill: "#580000" })).status, 200);
      const journalInode = fs.statSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith(".groupcommit.canvas.json.canvas-journal-"))!)).ino;
      (fs as any).fsync = (fd: number, cb: (e: Error | null) => void) => {
        // Other background saves can sync the folder while this journal's round is held.
        if (fs.fstatSync(fd).ino !== journalInode) return (fsync0 as any)(fd, cb);
        calls++;
        held.push(() => (fsync0 as any)(fd, cb));
      };
      try {
        let answered = false;
        const pending = update(file, "R0_1", { fill: "#580001" }).then((r) => ((answered = true), r));
        await waitFor(() => held.length > 0, "the journal fsync was not asked for");
        assert.equal(held.length, 1, "the journal fsync was asked for");
        assert.match(journal(), /#580001/, "the line is in the journal before the fsync");
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(answered, false, "no answer while the fsync covering the edit has not finished");
        // A burst while that fsync is held: every line joins one next round.
        const fills = Array.from({ length: 20 }, (_, i) => `#5801${String(i).padStart(2, "0")}`);
        const burst = fills.map((fill, i) => update(file, `R${1 + (i % 9)}_${i % 5}`, { fill }));
        await waitFor(() => { const lines = journal(); return fills.every((fill) => lines.includes(fill)); }, "the burst did not reach the journal");
        assert.equal(calls, 1, "the burst waits for the round in flight, not one fsync each");
        let burstAnswered = 0;
        for (const b of burst) void b.then(() => burstAnswered++);
        held.shift()!();
        assert.equal((await pending).status, 200);
        await waitFor(() => held.length > 0, "the burst fsync was not asked for");
        assert.equal(calls, 2, "one more fsync covers the whole burst");
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(burstAnswered, 0, "no edit of the burst answers before the fsync that covers it");
        held.shift()!();
        for (const r of await Promise.all(burst)) assert.equal(r.status, 200);
        assert.match(journal(), /#580119/);
      } finally {
        (fs as any).fsync = fsync0;
        for (const h of held) h();
        held = [];
      }
    });
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R0_1").fill, "#580001");
  });

  test("59. nothing tells others about an edit before its journal fsync: a bridge wait answers only after it (Codex)", async () => {
    const file = make("groupnotify");
    await open(file);
    const fsync0 = fs.fsync;
    const held: (() => void)[] = [];
    await slowWrites(async () => {
      assert.equal((await update(file, "R0_0", { fill: "#590000" })).status, 200); // opens the journal
      const seq = (await call("GET", "/api/bridge/wait?timeoutMs=0")).body.seq;
      (fs as any).fsync = (fd: number, cb: (e: Error | null) => void) => void held.push(() => (fsync0 as any)(fd, cb));
      try {
        let edited = false, told = false;
        const edit = update(file, "R0_1", { fill: "#590001" }).then((r) => ((edited = true), r));
        const wait = call("GET", `/api/bridge/wait?since=${seq}&types=doc&timeoutMs=5000`).then((r) => ((told = true), r));
        for (let i = 0; i < 50 && !held.length; i++) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(edited, false);
        assert.equal(told, false, "the doc event waits for the fsync too");
        held.shift()!();
        assert.equal((await edit).status, 200);
        const w = await wait;
        assert.ok(w.body.events.some((e: any) => e.type === "doc"), JSON.stringify(w.body));
      } finally {
        (fs as any).fsync = fsync0;
        for (const h of held) h();
      }
    });
    await pw.flushWrites(file);
  });

  test("60. a stream through a held response pauses (backpressure) and arrives whole, in order (Codex)", async () => {
    const { gateOnJournal } = await import("../src/server.ts");
    const { PassThrough, Readable } = await import("node:stream");
    const file = make("groupstream");
    await open(file);
    const fsync0 = fs.fsync;
    const held: (() => void)[] = [];
    await slowWrites(async () => {
      assert.equal((await update(file, "R0_0", { fill: "#610000" })).status, 200);
      (fs as any).fsync = (fd: number, cb: (e: Error | null) => void) => void held.push(() => (fsync0 as any)(fd, cb));
      try {
        const edit = update(file, "R0_1", { fill: "#610001" });
        for (let i = 0; i < 50 && !held.length; i++) await new Promise((r) => setTimeout(r, 10));
        const out = new PassThrough({ highWaterMark: 1024 });
        gateOnJournal(out as any);
        let read = 0;
        const chunks = Array.from({ length: 16 }, (_, i) => Buffer.alloc(64 * 1024, i));
        const src = new Readable({ highWaterMark: 1024, read() { this.push(read < chunks.length ? chunks[read++] : null); } });
        const got: Buffer[] = [];
        out.on("data", (c: Buffer) => got.push(c));
        const done = new Promise((r) => out.on("end", r));
        src.pipe(out as any);
        await new Promise((r) => setTimeout(r, 100));
        assert.ok(read <= 3, `the source paused while held (read ${read} of 16 chunks)`);
        assert.equal(got.length, 0, "nothing left before the fsync");
        held.shift()!();
        assert.equal((await edit).status, 200);
        await done;
        assert.ok(Buffer.concat(got).equals(Buffer.concat(chunks)), "every byte, in order");
      } finally {
        (fs as any).fsync = fsync0;
        for (const h of held) h();
      }
    });
    await pw.flushWrites(file);
  });

  test("61. a journal fsync that fails is reported, the journal is written again from what is pending, and the edit stays (Codex)", async () => {
    const file = make("groupfail");
    await open(file);
    const journal = () => fs.readdirSync(dir).filter((f) => f.startsWith(".groupfail.canvas.json.canvas-journal-")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    const seen: string[] = [];
    const prev = pw.writerHooks.problem;
    pw.writerHooks.problem = (f, m) => {
      seen.push(m);
      prev?.(f, m);
    };
    const fsync0 = fs.fsync;
    try {
      await slowWrites(async () => {
        assert.equal((await update(file, "R0_0", { fill: "#600000" })).status, 200);
        (fs as any).fsync = (_fd: number, cb: (e: Error | null) => void) => setImmediate(() => cb(Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" })));
        assert.equal((await update(file, "R0_1", { fill: "#600001" })).status, 200);
        (fs as any).fsync = fsync0;
        assert.ok(seen.some((m) => /crash journal/.test(m)), seen.join(" | "));
        assert.match(journal(), /#600001/, "the rewritten journal holds the edit");
        assert.match(journal(), /#600000/);
        // The journal keeps working: the next edit appends and syncs as usual.
        assert.equal((await update(file, "R0_2", { fill: "#600002" })).status, 200);
        assert.match(journal(), /#600002/);
      });
    } finally {
      (fs as any).fsync = fsync0;
      pw.writerHooks.problem = prev;
    }
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R0_2").fill, "#600002");
  });
});
