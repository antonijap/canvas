// The save log (src/doc/doclog.ts, src/docwriter.ts appendLog): a save of a big document appends the boards that
// changed instead of rewriting the file; loading applies the log; document.json stays a whole document an older
// build can read; a crash mid-append, a stale log and someone else's whole save are all handled.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("doclog");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_STATE_DIR = path.join(dir, "state-home");

const pw = await import("../src/docwriter.ts");
const { startServer } = await import("../src/server.ts");
const { loadDoc, revisionOf, stateHashOf, sha } = await import("../src/engine.ts");
const L = await import("../src/doc/doclog.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
// Every document here saves through the log, however small; compaction only when a test asks for it.
pw.writeConfig.syncBytes = 0;
pw.writeConfig.logMinBytes = 0;
pw.writeConfig.compactAfterMs = 0;

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
  variables: { accent: { type: "color", value: "#0766EB" } },
});
const make = (name: string, doc: unknown = docOf(12)) => {
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
const update = (file: string, id: string, props: Record<string, unknown>) => call("POST", "/api/update", { file, id, props });
const flush = (file: string) => call("POST", "/api/flush", { file });
const memory = (file: string) => JSON.stringify(pw.currentDoc(file).doc);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the log format", () => {
  test("records apply in order: changed boards by id, a new order of ids, the top-level keys", () => {
    const doc: any = docOf(3, 1);
    const b1 = { ...doc.children[1], name: "Renamed" };
    const b3 = { type: "frame", id: "B3", children: [] };
    const r1 = L.encodeRecord(1, [Buffer.from(JSON.stringify(b1))]);
    const r2 = L.encodeRecord(2, [Buffer.from(JSON.stringify(b3, null, 2))], ["B3", "B0", "B1"], [["version", "2.22"], ["children", null], ["variables", {}]]);
    const raw = Buffer.concat([L.headerOf("H0"), r1.bytes, r2.bytes]);
    const p = L.parseLog(raw, "H0");
    assert.ok(p && "records" in p);
    assert.equal(p.records.length, 2);
    assert.equal(p.info.size, raw.length);
    assert.equal(p.info.chain, L.chainOf(L.chainOf("H0", r1.hash), r2.hash), "the chain covers every record");
    assert.equal(L.applyRecords(doc, p.records), 2);
    assert.deepEqual(doc.children.map((c: any) => c.id), ["B3", "B0", "B1"], "B2 left, B3 came first");
    assert.equal(doc.children[2].name, "Renamed");
    assert.deepEqual(Object.keys(doc), ["version", "children", "variables"]);
    assert.equal(doc.version, "2.22");
  });

  test("a layer deep in a board is replaced by its path of ids; a path that does not fit changes nothing", () => {
    const doc: any = docOf(2, 2);
    doc.children[1].children[1] = { type: "group", id: "G", children: [{ type: "rectangle", id: "R", fill: "#000" }] };
    const ok = L.encodeRecord(1, [], undefined, undefined, [{ p: ["B1", "G", "R"], v: { type: "rectangle", id: "R", fill: "#FFF" } as any }]);
    const bad = L.encodeRecord(2, [], undefined, undefined, [{ p: ["B0", "R0_0"], v: { type: "rectangle", id: "R0_0", fill: "#0F0" } as any }, { p: ["B1", "nope"], v: { type: "rectangle", id: "nope" } as any }]);
    const p = L.parseLog(Buffer.concat([L.headerOf("H"), ok.bytes, bad.bytes]), "H") as any;
    assert.equal(p.records.length, 2);
    assert.equal(L.applyRecords(doc, p.records), 1, "the second record names a layer that is not there");
    assert.equal(doc.children[1].children[1].children[0].fill, "#FFF");
    assert.equal(doc.children[0].children[0].fill, "#FF0000", "nothing of the record that did not fit was applied");
  });

  test("a record cut short by a crash, or not matching its hash, ends the log there", () => {
    const r1 = L.encodeRecord(1, [Buffer.from(JSON.stringify({ type: "frame", id: "B0", name: "one" }))]);
    const r2 = L.encodeRecord(2, [Buffer.from(JSON.stringify({ type: "frame", id: "B0", name: "two" }))]);
    const whole = Buffer.concat([L.headerOf("H"), r1.bytes, r2.bytes]);
    for (let cut = whole.length - 1; cut > whole.length - r2.bytes.length; cut -= 7) {
      const p = L.parseLog(whole.subarray(0, cut), "H") as any;
      assert.equal(p.records.length, 1, `cut at ${cut}`);
      assert.equal(p.info.size, L.headerOf("H").length + r1.bytes.length);
    }
    const bad = Buffer.from(whole);
    bad[bad.length - 5] ^= 1; // a flipped byte in the second payload
    assert.equal((L.parseLog(bad, "H") as any).records.length, 1);
    // Zeros where the second record should be (a file extended but its data never written).
    const zeros = Buffer.concat([L.headerOf("H"), r1.bytes, Buffer.alloc(r2.bytes.length)]);
    assert.equal((L.parseLog(zeros, "H") as any).records.length, 1);
  });

  test("a log for other bytes is stale, and a cut header is no log", () => {
    const raw = Buffer.concat([L.headerOf("H1"), L.encodeRecord(1, [Buffer.from("{}")]).bytes]);
    assert.equal((L.parseLog(raw, "H2") as any).stale, "H1");
    assert.equal(L.parseLog(Buffer.from("CANVASLOG 1 H"), "H"), null);
    const doc: any = docOf(1, 1);
    const before = JSON.stringify(doc);
    const r = L.withLog("x.canvas.json", "H2", doc, raw);
    assert.equal(r.stale, true);
    assert.equal(JSON.stringify(r.doc), before);
  });
});

describe("saving through the log", () => {
  test("a flush appends the changed board: document.json keeps its bytes, a load sees the edit", async () => {
    const file = make("append");
    const orig = fs.readFileSync(file);
    await open(file);
    assert.equal((await update(file, "R3_1", { fill: "#00FF00" })).status, 200);
    const f = await flush(file);
    assert.equal(f.status, 200);
    assert.ok(fs.readFileSync(file).equals(orig), "document.json was not rewritten");
    const log = fs.readFileSync(L.logPathOf(file));
    assert.ok(log.length < orig.length / 4, `the log holds about one board (${log.length} of ${orig.length} bytes)`);
    const l = loadDoc(file);
    assert.equal(l.hash, sha(orig.toString()), "hash: document.json's own bytes");
    assert.equal(l.log?.records, 1);
    assert.equal(JSON.stringify(l.doc), memory(file), "the load is what Canvas shows");
    assert.equal(f.body.fileRevision, revisionOf(stateHashOf(l)), "flush names the state's revision (the log's chain)");
    assert.notEqual(f.body.fileRevision, revisionOf(l.hash));
  });

  test("a property of one layer in a board of thousands: the record holds that layer, not the board", async () => {
    const file = make("bigboard", docOf(3, 3000));
    await open(file);
    const before = fs.existsSync(L.logPathOf(file)) ? fs.statSync(L.logPathOf(file)).size : 0;
    await update(file, "R1_2500", { fill: "#00FF00" });
    await flush(file);
    const grew = fs.statSync(L.logPathOf(file)).size - before;
    const board = JSON.stringify(pw.currentDoc(file).doc.children[1], null, 2).length;
    assert.ok(grew < 1000, `the log grew ${grew} bytes for one layer (the board is ${board})`);
    assert.equal(JSON.stringify(loadDoc(file).doc), memory(file));
  });

  test("structure edits, a board deleted, reordered and the variables changed: the load matches memory", async () => {
    const file = make("structure");
    await open(file);
    const dup = await call("POST", "/api/structure", { file, op: "duplicate", ids: ["R2_0"] });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    assert.equal((await call("POST", "/api/structure", { file, op: "delete", ids: ["B5"] })).status, 200);
    assert.equal((await call("POST", "/api/structure", { file, op: "reorder", ids: ["B7"], dir: "front" })).status, 200);
    assert.equal((await call("POST", "/api/structure", { file, op: "group", ids: ["R1_1", "R1_2"] })).status, 200);
    await flush(file);
    const l = loadDoc(file);
    assert.ok((l.log?.records ?? 0) >= 1, "saved through the log");
    assert.equal(JSON.stringify(l.doc), memory(file));
    assert.ok(!l.doc.children.some((c: any) => c.id === "B5"));
    // Compaction writes it whole, byte for byte what a whole write makes, and the log goes.
    await pw.compactWrites(file);
    assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(pw.currentDoc(file).doc, null, 2));
    assert.equal(fs.existsSync(L.logPathOf(file)), false);
    assert.equal(loadDoc(file).log, undefined);
  });

  test("a server that starts on a file with a log takes the log, and keeps appending to it", async () => {
    const file = make("reopen");
    await open(file);
    await update(file, "R0_0", { name: "first" });
    await flush(file);
    // Another process (an export, a new server) reads the file the same way.
    const l1 = loadDoc(file);
    assert.equal(l1.log?.records, 1);
    await update(file, "R1_0", { name: "second" });
    await flush(file);
    const l2 = loadDoc(file);
    assert.equal(l2.log?.records, 2, "appended to the same log");
    assert.equal(JSON.stringify(l2.doc), memory(file));
  });

  test("someone saves document.json whole: the log is stale, and its edits go back on top of theirs", async () => {
    const file = make("outside");
    await open(file);
    await update(file, "R4_0", { name: "logged" });
    await flush(file);
    assert.ok(fs.existsSync(L.logPathOf(file)));
    // Another app or an older build: reads document.json alone, changes something, saves it whole.
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    d.children[6].name = "Theirs";
    const tmp = file + ".x";
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, file);
    for (let i = 0; i < 100 && JSON.parse(memory(file)).children[6].name !== "Theirs"; i++) await sleep(20);
    const mem = JSON.parse(memory(file));
    assert.equal(mem.children[6].name, "Theirs", "their save is shown");
    assert.equal(mem.children[4].children[0].name, "logged", "the logged edit is not in their bytes: it is put back on top");
    await flush(file);
    const l = loadDoc(file);
    assert.equal(l.hash, sha(fs.readFileSync(file, "utf8")));
    assert.equal(l.doc.children[6].name, "Theirs");
    assert.equal((l.doc.children[4] as any).children[0].name, "logged", "on disk too");
    assert.ok(!l.log || l.log.base === l.hash, "the stale log was retired: any log now is for their bytes");
    // Saving goes on, through a new log for their bytes.
    await update(file, "R7_0", { name: "after" });
    await flush(file);
    assert.equal(JSON.stringify(loadDoc(file).doc), memory(file));
  });

  test("a crash mid-append (a cut record at the end): the records before hold, and saving goes on", async () => {
    const file = make("torn");
    await open(file);
    await update(file, "R2_2", { name: "kept" });
    await flush(file);
    // The tail of a record that never finished: what a crash leaves.
    fs.appendFileSync(L.logPathOf(file), "R 999 " + "0".repeat(64) + "\n{\"s\":2,\"b\":[{\"id\"");
    const l = loadDoc(file);
    assert.equal(l.log?.records, 1);
    assert.equal((l.doc as any).children[2].children[2].name, "kept");
    // The next save goes where the last valid record ends (a new run that loaded the log saves whole instead: the
    // kill -9 check in qa/release-crash.ts covers that).
    await update(file, "R3_3", { name: "next" });
    await flush(file);
    assert.equal(JSON.stringify(loadDoc(file).doc), memory(file));
  });

  test("the log grows past its share of the document: the save is whole", async () => {
    const file = make("grow", docOf(8, 30));
    await open(file);
    const keep = pw.writeConfig.logMaxBytes, share = pw.writeConfig.logMaxShare;
    pw.writeConfig.logMaxBytes = 0;
    pw.writeConfig.logMaxShare = 0.004; // a couple of small records
    try {
      let whole = false;
      for (let i = 0; i < 12 && !whole; i++) {
        await update(file, `R${i % 8}_1`, { name: `n${i}` });
        await flush(file);
        whole = !fs.existsSync(L.logPathOf(file));
      }
      assert.ok(whole, "a save past the share wrote the file whole");
      assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(pw.currentDoc(file).doc, null, 2));
    } finally {
      pw.writeConfig.logMaxBytes = keep;
      pw.writeConfig.logMaxShare = share;
    }
  });

  test("edits pause: the log is folded into document.json (an older build sees them)", async () => {
    const file = make("compact");
    await open(file);
    // Establish the log before enabling compaction: under load it can fold before a flush response arrives.
    await update(file, "R9_4", { name: "in the log" });
    await flush(file);
    assert.ok(fs.existsSync(L.logPathOf(file)));
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).children[9].children[4].name, undefined);
    pw.writeConfig.compactAfterMs = 60;
    try {
      await update(file, "R9_4", { name: "soon on disk" });
      await flush(file);
      // Wait for the folded state, even if it was reached before flush answered. The deadline only bounds a hang.
      const deadline = performance.now() + 10_000;
      while (fs.existsSync(L.logPathOf(file)) || JSON.parse(fs.readFileSync(file, "utf8")).children[9].children[4].name !== "soon on disk") {
        assert.ok(performance.now() < deadline, `the log did not fold: ${JSON.stringify(pw.writerStats(file))}`);
        await sleep(20);
      }
      assert.equal(fs.existsSync(L.logPathOf(file)), false);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).children[9].children[4].name, "soon on disk");
    } finally {
      pw.writeConfig.compactAfterMs = 0;
    }
  });

  test("an undo after a logged save is logged too, and the revision a flush names is accepted for an edit", async () => {
    const file = make("undo");
    await open(file);
    await update(file, "R1_1", { fill: "#123456" });
    const f = await flush(file);
    assert.equal((await call("POST", `/api/history/undo${q(file)}`)).status, 200);
    await flush(file);
    assert.equal((loadDoc(file).doc as any).children[1].children[1].fill, "#FF0000");
    // A client holding the revision of the flushed state (before the undo) is refused; the current one is taken.
    const stale = await call("POST", "/api/update", { file, id: "R1_1", props: { name: "x" }, expectedRevision: f.body.fileRevision });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const now = await flush(file);
    const ok = await call("POST", "/api/update", { file, id: "R1_1", props: { name: "x" }, expectedRevision: now.body.fileRevision });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await flush(file);
  });
});

describe("the crash journal beside the log", () => {
  test("after an append the journal is cut back to its header, and the next edit is one line in it", async () => {
    const file = make("journalcut");
    await open(file);
    const journals = () => fs.readdirSync(dir).filter((f) => f.startsWith(".journalcut.canvas.json.canvas-journal-"));
    await update(file, "R0_0", { name: "a" });
    await flush(file);
    assert.equal(journals().length, 1, "kept, not removed");
    const j = path.join(dir, journals()[0]);
    assert.equal(fs.readFileSync(j, "utf8").split("\n").filter(Boolean).length, 1, "only its header");
    await update(file, "R0_1", { name: "b" });
    const lines = fs.readFileSync(j, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /"name"/);
    await flush(file);
  });

  test("a {saved} line in a dead server's journal: the edits it names are not applied again", async () => {
    const crashed = make("savedmark");
    const base = sha(fs.readFileSync(crashed, "utf8"));
    const op = (id: string, v: string) => ({ t: "node", id, props: { name: { b: null, a: { v } } } });
    const dead = 2 ** 22 + 23456; // no such process
    const lines = [{ base }, { edit: "e1", ops: [op("R1_0", "one")] }, { edit: "e2", ops: [op("R1_1", "two")] }, { saved: "e1" }, { edit: "e3", ops: [op("R1_2", "three")] }];
    fs.writeFileSync(path.join(dir, `.savedmark.canvas.json.canvas-journal-${dead}`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await open(crashed);
    const rec = fs.readdirSync(dir).filter((f) => f.startsWith("savedmark.canvas.json.recovered-"));
    assert.equal(rec.length, 1);
    const d = JSON.parse(fs.readFileSync(path.join(dir, rec[0]), "utf8"));
    assert.equal(d.children[1].children[0].name, undefined, "e1 was saved: not applied again");
    assert.equal(d.children[1].children[1].name, "two");
    assert.equal(d.children[1].children[2].name, "three");
  });
});
