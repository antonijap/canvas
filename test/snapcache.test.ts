// Stat-based snapshot cache and the docdiff event.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, test } from "node:test";
import type { Snapshot } from "../src/boards.ts";
import { applyDocDiff, docDiff, docPayload } from "../src/docdiff.ts";
import { SnapshotCache } from "../src/snapcache.ts";
import { FIXTURE_DOC, tmpDir } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(5); } };
const write = (p: string, doc: unknown, pad = "") => fs.writeFileSync(p, JSON.stringify(doc, null, 2) + pad);
const swap = (p: string, doc: unknown, pad = "") => { const t = `${p}.tmp`; write(t, doc, pad); fs.renameSync(t, p); };
const clone = () => JSON.parse(JSON.stringify(FIXTURE_DOC));

describe("snapshot cache", () => {
  test("a repeat request stats the file but does not read it again", () => {
    const dir = tmpDir("sc1");
    const p = path.join(dir, "a.canvas.json"); write(p, FIXTURE_DOC);
    const c = new SnapshotCache({ onChange() {}, forcePoll: true });
    try {
      const a = c.get(p);
      for (let i = 0; i < 20; i++) assert.equal(c.get(p), a);
      assert.equal(c.loads, 1);
    } finally { c.close(); }
  });

  test("a request sees an edit at once, with no watcher event needed", () => {
    const dir = tmpDir("sc2");
    const p = path.join(dir, "a.canvas.json"); write(p, FIXTURE_DOC);
    const seen: string[] = [];
    const c = new SnapshotCache({ onChange: (f) => seen.push(f.revision), debounceMs: 10_000, forcePoll: true, pollMs: 100000 });
    try {
      const a = c.get(p);
      const d = clone(); d.children[0].x = 5; write(p, d);
      const b = c.get(p);
      assert.notEqual(b.revision, a.revision);
      assert.equal(b.boards[0].x, 5);
      assert.deepEqual(seen, [b.revision]); // announced by the request path, once
      assert.equal(c.get(p), b);
      assert.equal(c.loads, 2);
    } finally { c.close(); }
  });

  test("a new file renamed over the old one is picked up (inode changes, directory watch fires)", async () => {
    const dir = tmpDir("sc3");
    const p = path.join(dir, "a.canvas.json"); write(p, FIXTURE_DOC);
    const seen: Snapshot[] = [];
    const c = new SnapshotCache({ onChange: (f) => seen.push(f), debounceMs: 20 });
    try {
      const a = c.get(p);
      const ino = fs.statSync(p).ino;
      const d = clone(); d.children[1].name = "Renamed"; swap(p, d);
      assert.notEqual(fs.statSync(p).ino, ino);
      await until(() => seen.length === 1);
      assert.equal(seen[0].boards[1].name, "Renamed");
      assert.notEqual(seen[0].revision, a.revision);
      assert.equal(c.get(p), seen[0]);
      assert.equal(c.loads, 2);
    } finally { c.close(); }
  });

  test("same size, same mtime edits still change the signature through ino or ctime; touch alone announces nothing", async () => {
    const dir = tmpDir("sc4");
    const p = path.join(dir, "a.canvas.json"); write(p, FIXTURE_DOC);
    const seen: string[] = [];
    const c = new SnapshotCache({ onChange: (f) => seen.push(f.revision), debounceMs: 10, forcePoll: true, pollMs: 50 });
    try {
      const a = c.get(p);
      const later = new Date(Date.now() + 5000); fs.utimesSync(p, later, later);
      assert.equal(c.get(p), a); // reloaded, identical bytes: same snapshot kept
      assert.equal(c.loads, 2);
      await sleep(150);
      assert.deepEqual(seen, []);
    } finally { c.close(); }
  });

  test("polling fallback notices a rename-over too", async () => {
    const dir = tmpDir("sc5");
    const p = path.join(dir, "a.canvas.json"); write(p, FIXTURE_DOC);
    const seen: string[] = [];
    const c = new SnapshotCache({ onChange: (f) => seen.push(f.revision), debounceMs: 10, forcePoll: true, pollMs: 50 });
    try {
      c.get(p);
      const d = clone(); d.children[0].y = 9; swap(p, d);
      await until(() => seen.length === 1, 4000);
    } finally { c.close(); }
  });

  test("a half-written file keeps the last good snapshot until it parses", async () => {
    const dir = tmpDir("sc6");
    const p = path.join(dir, "a.canvas.json"); write(p, FIXTURE_DOC);
    const seen: Snapshot[] = [];
    const c = new SnapshotCache({ onChange: (f) => seen.push(f), debounceMs: 10 });
    try {
      c.get(p);
      fs.writeFileSync(p, '{"children": [');
      await sleep(100);
      assert.equal(seen.length, 0);
      const d = clone(); d.children[0].x = 1; write(p, d);
      await until(() => seen.length === 1);
    } finally { c.close(); }
  });

  test("idle documents are dropped, pinned ones are not", async () => {
    const dir = tmpDir("sc7");
    const p = path.join(dir, "a.canvas.json"); write(p, FIXTURE_DOC);
    const q = path.join(dir, "b.canvas.json"); write(q, FIXTURE_DOC);
    const c = new SnapshotCache({ onChange() {}, idleMs: 40, pinned: (f) => f === q, forcePoll: true });
    try {
      c.get(p); c.get(q);
      await until(() => !c.has(p), 4000);
      assert.equal(c.has(q), true);
    } finally { c.close(); }
  });

  test("the most recently used documents stay parsed however long they are idle (hidden tabs hold no stream)", async () => {
    const dir = tmpDir("sc8");
    const files = ["a", "b", "c", "d"].map((n) => { const f = path.join(dir, n + ".canvas.json"); write(f, FIXTURE_DOC); return f; });
    const c = new SnapshotCache({ onChange() {}, idleMs: 30 * 60_000, keepRecent: 3, forcePoll: true });
    try {
      for (const f of files) { c.get(f); await sleep(5); }
      c.sweepAt(Date.now() + 10 * 60_000);
      assert.deepEqual(files.map((f) => c.has(f)), [true, true, true, true], "nothing idle long enough yet");
      c.sweepAt(Date.now() + 24 * 3600_000);
      assert.deepEqual(files.map((f) => c.has(f)), [false, true, true, true], "the oldest goes, the last three stay");
      c.get(files[1]);
      c.sweepAt(Date.now() + 48 * 3600_000);
      assert.deepEqual(files.map((f) => c.has(f)), [false, true, true, true]);
    } finally { c.close(); }
  });
});

describe("docdiff", () => {
  const snapOf = (doc: any) => {
    const dir = tmpDir("dd"); const p = path.join(dir, "d.canvas.json"); write(p, doc);
    const c = new SnapshotCache({ onChange() {}, forcePoll: true });
    try { return c.get(p); } finally { c.close(); }
  };
  const board = (id: string, x: number) => ({ type: "frame", id, name: id, x, y: 0, width: 100, height: 100, children: [] });

  test("only the changed board, plus components/variables only when they changed", () => {
    const a = clone(); const b = clone(); b.children[1].x = 700;
    const pa = docPayload(snapOf(a)), pb = docPayload(snapOf(b));
    const d = docDiff(pa, pb);
    assert.equal(d.base, pa.revision);
    assert.deepEqual(d.changed.map((x) => x.id), ["Scr02"]);
    assert.deepEqual([d.added, d.removed], [[], []]);
    for (const k of ["components", "styles", "variables", "themes", "order", "name"]) assert.equal(k in d, false, k);
    assert.deepEqual(applyDocDiff(pa, d), pb);
  });

  test("added, removed, reordered boards and changed variables round-trip", () => {
    const a = { version: "2.21", children: [board("A", 0), board("B", 200), board("C", 400)], variables: { c: { type: "color", value: "#fff" } } };
    const b = { version: "2.21", children: [board("C", 400), board("N", 600), board("A", 0)], variables: { c: { type: "color", value: "#000" } } };
    const pa = docPayload(snapOf(a)), pb = docPayload(snapOf(b));
    const d = docDiff(pa, pb);
    assert.deepEqual(d.removed, ["B"]);
    assert.deepEqual(d.added.map((x) => x.id), ["N"]);
    assert.ok(d.variables && d.order);
    assert.equal("components" in d, false);
    assert.deepEqual(applyDocDiff(pa, d), pb);
  });

  test("a diff against another revision is refused", () => {
    const pa = docPayload(snapOf(clone()));
    const d = docDiff(pa, docPayload(snapOf({ ...clone(), children: [board("Z", 0)] })));
    assert.equal(applyDocDiff({ ...pa, revision: "other" }, d), null);
  });

  test("the page embeds the same applyDocDiff the server uses", async () => {
    const { startServer } = await import("../src/server.ts");
    const s = await startServer(0);
    try {
      const port = (s.address() as { port: number }).port;
      const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
      const src = html.match(/const applyDocDiff = (function[\s\S]*?\n\});/)?.[1];
      assert.ok(src, "applyDocDiff in page");
      const fn = new Function(`return ${src}`)();
      const pa = docPayload(snapOf(clone())); const b = clone(); b.children[0].x = 3;
      const pb = docPayload(snapOf(b));
      assert.deepEqual(fn(pa, docDiff(pa, pb)), pb);
    } finally { s.close(); }
  });

  test("SSE: connect sends the full doc, an edit sends a docdiff with only the changed board", async () => {
    const dir = tmpDir("sse"); const p = fs.realpathSync(dir) + "/s.canvas.json"; write(p, FIXTURE_DOC);
    const { startServer } = await import("../src/server.ts");
    const s = await startServer(0);
    const port = (s.address() as { port: number }).port;
    const events: { event: string; data: any }[] = [];
    const req = http.get(`http://127.0.0.1:${port}/events?file=${encodeURIComponent(p)}`, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = chunk.match(/^event: (.+)$/m)?.[1]; const data = chunk.match(/^data: (.+)$/m)?.[1];
          if ((ev === "doc" || ev === "docdiff") && data) events.push({ event: ev, data: JSON.parse(data) });
        }
      });
    });
    try {
      await until(() => events.length === 1);
      assert.equal(events[0].event, "doc");
      const d = clone(); d.children[0].width = 411; swap(p, d);
      await until(() => events.length === 2).catch(() => { throw new Error(JSON.stringify(events).slice(0, 300)); });
      assert.equal(events[1].event, "docdiff");
      assert.deepEqual(events[1].data.changed.map((b: any) => b.id), ["Scr01"]);
      assert.equal(events[1].data.base, events[0].data.revision);
      assert.deepEqual(applyDocDiff(events[0].data, events[1].data).boards[0].width, 411);
    } finally { req.destroy(); s.closeAllConnections(); s.close(); }
  });
});
