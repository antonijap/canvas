// Edits in memory, written in the background (src/docwriter.ts): bytes identical to JSON.stringify, rapid edits
// land at the last state with consistent revisions, a kill mid-write leaves the old or the new file, an outside edit
// during a pending write keeps both, and undo and redo still work.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("docwriter");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_STATE_DIR = path.join(dir, "state-home"); // backups land here, not in the home folder

const pw = await import("../src/docwriter.ts");
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const { loadDoc } = await import("../src/engine.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
// Every document here takes the background path, however small.
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
const make = (name: string, doc: unknown = docOf(20)) => {
  const p = path.join(dir, `${name}.canvas.json`);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  return fs.realpathSync(p);
};
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const update = (file: string, id: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) => call("POST", "/api/update", { file, id, props, ...extra });
const disk = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const nodeIn = (doc: any, id: string): any => {
  const seek = (ns: any[]): any => { for (const n of ns) { if (n.id === id) return n; const h = n.children && seek(n.children); if (h) return h; } };
  return seek(doc.children);
};

describe("serializing", () => {
  test("pieces add up to exactly JSON.stringify(doc, null, indent) + trailing, for any indent", async () => {
    const doc: any = { version: "2.21", children: docOf(6, 3).children, variables: { a: { type: "color", value: "#fff" } }, themes: {}, skip: undefined, empty: [] };
    for (const [indent, trailing] of [["  ", ""], ["\t", "\n"], ["", ""], ["    ", "\n\n"]] as const) {
      const bufs = await pw.serializeDoc(doc, { indent, trailing });
      assert.equal(Buffer.concat(bufs).toString("utf8"), JSON.stringify(doc, null, indent || undefined) + trailing, `indent ${JSON.stringify(indent)}`);
    }
    const none = await pw.serializeDoc({ children: [] } as any, { indent: "  ", trailing: "" });
    assert.equal(Buffer.concat(none).toString(), JSON.stringify({ children: [] }, null, 2));
  });

  test("copy on write shares untouched boards and leaves the old version as it was", () => {
    const doc: any = docOf(3, 2);
    const before = JSON.stringify(doc);
    const next: any = pw.cowDoc(doc, ["R1_1"]);
    next.children[1].children[1].fill = "#00FF00";
    assert.equal(JSON.stringify(doc), before, "the old version did not change");
    assert.equal(next.children[0], doc.children[0], "an untouched board is the same object");
    assert.notEqual(next.children[1], doc.children[1]);
    assert.equal(next.children[1].children[0], doc.children[1].children[0], "an untouched sibling is shared");
  });
});

describe("background writes", () => {
  test("100 rapid edits: every answer ok, revisions all different, the file ends at the server's last state", async () => {
    const file = make("rapid");
    await call("GET", `/api/doc?file=${encodeURIComponent(file)}`);
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => update(file, `R${i % 20}_${i % 5}`, { name: `n${i}` })));
    assert.ok(rs.every((r) => r.status === 200 && r.body.ok));
    assert.equal(new Set(rs.map((r) => r.body.revision)).size, 100);
    // Sequential ones too: the last one written wins.
    for (let i = 0; i < 50; i++) await update(file, "R3_3", { x: i });
    await pw.flushWrites(file);
    const d = disk(file);
    assert.equal(nodeIn(d, "R3_3").x, 49);
    for (let i = 0; i < 100; i++) if (i % 20 !== 3 || i % 5 !== 3) assert.ok(String(nodeIn(d, `R${i % 20}_${i % 5}`).name).startsWith("n"));
    const stats = pw.writerStats(file)!;
    assert.ok(stats.writes < 150, `edits share writes (${stats.writes} writes for 150 edits)`);
    assert.equal(stats.pending, 0);
    // The revision the server shows is what the next edit must name; an older one is refused.
    const now = (await call("GET", `/api/doc?file=${encodeURIComponent(file)}`)).body.revision;
    assert.equal(now, (await update(file, "R0_0", { x: 1 }, { expectedRevision: now })).status === 200 ? now : "x");
    const stale = await update(file, "R0_0", { x: 2 }, { expectedRevision: now });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "stale_revision");
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R0_0").x, 1);
    pw.settleLingering(); // copies of replaced bytes stay a moment (docwriter.ts laterRemove)
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  });

  test("an edit answers before the file is written, and the watcher does not take our write for someone else's", async () => {
    const file = make("own");
    await call("GET", `/api/doc?file=${encodeURIComponent(file)}`);
    const slow = pw.writeConfig.debounceMs;
    pw.writeConfig.debounceMs = 200;
    try {
      const r = await update(file, "R1_1", { fill: "#123456" });
      assert.equal(r.status, 200);
      assert.equal(nodeIn(disk(file), "R1_1").fill, "#FF0000", "not on disk yet");
      assert.equal((await call("GET", `/api/node?file=${encodeURIComponent(file)}&id=R1_1`)).body.node.fill, "#123456", "but served from memory");
      await pw.flushWrites(file);
      assert.equal(nodeIn(disk(file), "R1_1").fill, "#123456");
      await new Promise((res) => setTimeout(res, 400)); // the watcher sees the rename
      const doc = (await call("GET", `/api/doc?file=${encodeURIComponent(file)}`)).body;
      assert.equal(doc.revision, r.body.revision, "our own write did not reload as an outside change");
    } finally {
      pw.writeConfig.debounceMs = slow;
    }
  });

  test("an outside edit while ours waits to be written: both end up in the file", async () => {
    const file = make("outside");
    await call("GET", `/api/doc?file=${encodeURIComponent(file)}`);
    const slow = pw.writeConfig.debounceMs;
    pw.writeConfig.debounceMs = 300;
    try {
      assert.equal((await update(file, "R2_2", { fill: "#00FF00" })).status, 200);
      // Someone else saves the file the way most apps do (temp file, rename).
      const theirs = disk(file);
      nodeIn(theirs, "R5_0").fill = "#0000FF";
      theirs.children.push({ type: "frame", id: "Theirs", name: "Theirs", x: 0, y: 2000, width: 10, height: 10, children: [] });
      fs.writeFileSync(file + ".x", JSON.stringify(theirs, null, 2));
      fs.renameSync(file + ".x", file);
      await pw.flushWrites(file);
      const d = disk(file);
      assert.equal(nodeIn(d, "R2_2").fill, "#00FF00", "our edit was replayed on their bytes");
      assert.equal(nodeIn(d, "R5_0").fill, "#0000FF", "their edit is kept");
      assert.ok(nodeIn(d, "Theirs"));
    } finally {
      pw.writeConfig.debounceMs = slow;
    }
  });

  test("undo and redo go through the same path and land on disk", async () => {
    const file = make("undo");
    const q = `?file=${encodeURIComponent(file)}`;
    await call("GET", `/api/doc${q}`);
    history.resetHistory();
    await update(file, "R4_1", { fill: "#ABCDEF" });
    await update(file, "R4_1", { width: 99 });
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R4_1").width, 40);
    assert.equal(nodeIn(disk(file), "R4_1").fill, "#ABCDEF");
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    assert.equal((await call("POST", `/api/history/redo${q}`)).status, 200);
    assert.equal((await call("POST", `/api/history/redo${q}`)).status, 200);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R4_1").width, 99);
    // A structure step: delete a layer, undo brings it back in place.
    assert.equal((await call("POST", "/api/structure", { file, op: "delete", ids: ["R4_2"] })).status, 200);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R4_2"), undefined);
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "B4").children[2].id, "R4_2");
  });

  test("resize, structure and undo copy every node they change (the safety net finds nothing to fix)", async () => {
    const file = make("copies");
    const q = `?file=${encodeURIComponent(file)}`;
    await call("GET", `/api/doc${q}`);
    const before = JSON.stringify(pw.currentDoc(file).doc);
    const old = pw.currentDoc(file).doc;
    assert.equal((await call("POST", "/api/resize", { file, id: "B6", props: { width: 500 }, children: [{ id: "R6_0", x: 7 }, { id: "R6_1", y: 9 }] })).status, 200);
    assert.equal((await call("POST", "/api/structure", { file, op: "group", ids: ["R6_2", "R6_3"] })).status, 200);
    assert.equal((await call("POST", `/api/history/undo${q}`)).status, 200);
    assert.equal(JSON.stringify(old), before, "the version before the edits is untouched");
    await pw.flushWrites(file);
    assert.equal(await pw.verify(file), 0);
    assert.equal(nodeIn(disk(file), "R6_0").x, 7);
  });

  test("a board changed without being copied first is caught and written again", async () => {
    const file = make("verify");
    await call("GET", `/api/doc?file=${encodeURIComponent(file)}`);
    await update(file, "R0_0", { x: 5 });
    await pw.flushWrites(file);
    // Simulate a change that forgot to name what it touched: edit the live board object in place.
    const live = pw.currentDoc(file).doc as any;
    live.children[7].children[0].fill = "#777777";
    assert.equal(await pw.verify(file), 1);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "R7_0").fill, "#777777");
  });

  test("killed mid-write: the file is always the old bytes or the new ones, never a part", async () => {
    // A document big enough that a write takes a while (about 6 MB).
    const big = docOf(60, 400);
    const file = make("crash", big);
    const original = fs.readFileSync(file, "utf8");
    let wrote = 0;
    for (let round = 0; round < 4; round++) {
      const port = 5300 + Math.floor(Math.random() * 400);
      const env: NodeJS.ProcessEnv = { ...process.env, CANVAS_PORT: String(port), CANVAS_ROOTS: dir };
      delete env.NODE_TEST_CONTEXT; // a plain server, not a test runner child
      const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.ts")], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise((res) => child.once("exit", res));
      await new Promise<void>((res, rej) => {
        child.stdout!.on("data", (d) => String(d).includes("canvas:") && res());
        child.once("exit", () => rej(new Error("server exited")));
      });
      const b = `http://127.0.0.1:${port}`;
      await fetch(`${b}/api/doc?file=${encodeURIComponent(file)}`).then((r) => r.json());
      // Keep editing, and kill it at some point while writes are going on.
      let stop = false;
      const loop = (async () => {
        for (let i = 0; !stop; i++) {
          await fetch(`${b}/api/update`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id: `R${i % 60}_${i % 400}`, props: { name: `r${round}-${i}` } }) }).catch(() => (stop = true));
        }
      })();
      await new Promise((res) => setTimeout(res, 150 + Math.random() * 400));
      child.kill("SIGKILL");
      stop = true;
      await loop;
      await exited;
      const raw = fs.readFileSync(file, "utf8");
      const d = JSON.parse(raw); // throws on a partial file
      assert.equal(d.children.length, 60);
      assert.equal(raw.length > original.length * 0.9, true);
      // A document this big saves through its save log (src/doc/doclog.ts): what Canvas reads is whole too.
      const l = loadDoc(file);
      assert.equal(l.doc.children.length, 60);
      if (raw !== original || (l.log?.records ?? 0) > 0) wrote++;
    }
    assert.ok(wrote > 0, "the killed servers did write");
    // The temp files the killed servers left are cleaned by the next one that touches the document.
    await call("GET", `/api/doc?file=${encodeURIComponent(file)}`);
    await update(file, "R0_0", { x: 3 });
    await pw.flushWrites(file);
    await new Promise((res) => setTimeout(res, 100));
    pw.settleLingering();
    // Left: the save log, and this server's own journal (kept as its header after an append to the log).
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(".crash.canvas.json.canvas-") && f !== ".crash.canvas.json.canvas-log" && f !== ".crash.canvas.json.canvas-lock" && !f.startsWith(`.crash.canvas.json.canvas-journal-${process.pid}-`)), []);
  });
});

