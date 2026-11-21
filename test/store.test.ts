// The sidecar store: the .canvas.json never changes, writes are atomic and serialized, strangers round-trip.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir, writeDoc } from "./helpers.ts";
import { json } from "./fixtures/json-kind.ts";
import { registerKind } from "../src/widgets/registry.ts";

registerKind(json); // a test-only kind with headers and auth (test/fixtures/json-kind.ts)

const dir = tmpDir("store");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_TRUST_FILE = path.join(dir, "trust.json");

const w = await import("../src/widgets.ts");
const { storeFor, sidecarPath, storeTestHooks } = await import("../src/widgets/store.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const fresh = (name: string) => writeDoc(dir, name);
const waitFor = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("widget store", () => {
  test("the sidecar appears on first add and the .canvas.json bytes never change", async () => {
    const docFile = fresh("bytes");
    const before = fs.readFileSync(docFile);
    assert.equal(fs.existsSync(sidecarPath(docFile)), false);
    const { widget } = await w.addWidget(docFile, { kind: "todo" });
    await w.updateWidget(docFile, widget.id, { name: "Tasks", x: 10 });
    await w.runWidgetAction(docFile, widget.id, "addItem", { text: "one" });
    await w.removeWidget(docFile, widget.id);
    assert.ok(fs.existsSync(sidecarPath(docFile)));
    assert.deepEqual(fs.readFileSync(docFile), before);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  });

  test("output is deterministic: 2-space JSON, trailing newline, fixed key order", async () => {
    const docFile = fresh("determinism");
    await w.addWidget(docFile, { kind: "note", id: "w_aaaaaaaa", x: 5, y: 6, name: "N", config: { text: "hi" } });
    const raw = fs.readFileSync(sidecarPath(docFile), "utf8");
    assert.ok(raw.endsWith("}\n"));
    assert.match(raw, /^\{\n  "version": 1,\n  "widgets": \[\n    \{\n      "id": "w_aaaaaaaa",\n      "kind": "note",\n      "name": "hi",\n      "x": 5,\n      "y": 6,\n      "w": 480,\n      "h": 80,\n      "locked": false,\n      "config": \{\n        "text": "hi",\n        "tone": "plain"\n/);
    // A no-op patch leaves the bytes alone.
    await w.updateWidget(docFile, "w_aaaaaaaa", { x: 5 });
    assert.equal(fs.readFileSync(sidecarPath(docFile), "utf8"), raw);
  });

  test("unknown kinds and unknown keys survive an edit of a neighbour", async () => {
    const docFile = fresh("strangers");
    const original = {
      version: 1,
      futureTop: { a: 1 },
      widgets: [
        { id: "w_future01", kind: "hologram", name: "H", x: 1, y: 2, w: 3, h: 4, locked: false, config: { beams: [1, 2], nested: { z: 1 } }, wiggle: "yes" },
        { id: "w_note0001", kind: "note", name: "N", x: 0, y: 0, w: 240, h: 200, locked: false, config: { text: "a", tone: "plain", sticker: "star" } },
      ],
    };
    fs.writeFileSync(sidecarPath(docFile), JSON.stringify(original));
    await w.updateWidget(docFile, "w_note0001", { config: { text: "b" } });
    const after_ = JSON.parse(fs.readFileSync(sidecarPath(docFile), "utf8"));
    assert.deepEqual(after_.futureTop, { a: 1 });
    assert.deepEqual(after_.widgets[0], original.widgets[0]);
    assert.equal(after_.widgets[1].config.sticker, "star");
    assert.equal(after_.widgets[1].config.text, "b");
    // Unknown kinds are still listed, and cannot run actions.
    assert.equal(w.listWidgets(docFile).widgets.length, 2);
    await assert.rejects(w.runWidgetAction(docFile, "w_future01", "go", {}), /no action/);
  });

  test("25 concurrent changes all land, the file is whole after each", async () => {
    const docFile = fresh("concurrent");
    const { widget } = await w.addWidget(docFile, { kind: "todo" });
    await Promise.all(Array.from({ length: 25 }, (_, i) => w.runWidgetAction(docFile, widget.id, "addItem", { text: `item ${i}` })));
    const got = w.getWidget(docFile, widget.id).widget.config.items as { text: string }[];
    assert.equal(got.length, 25);
    assert.equal(new Set(got.map((i) => i.text)).size, 25);
    const patches = await Promise.all(Array.from({ length: 25 }, (_, i) => w.updateWidget(docFile, widget.id, { x: i })));
    assert.equal(patches.length, 25);
    JSON.parse(fs.readFileSync(sidecarPath(docFile), "utf8"));
  });

  test("If-Match: a stale rev is refused with 409", async () => {
    const docFile = fresh("ifmatch");
    const { rev, widget } = await w.addWidget(docFile, { kind: "note" });
    const next = await w.updateWidget(docFile, widget.id, { name: "A" }, { ifMatch: rev });
    assert.notEqual(next.rev, rev);
    await assert.rejects(w.updateWidget(docFile, widget.id, { name: "B" }, { ifMatch: rev }), (e: any) => e.status === 409 && e.code === "rev-mismatch");
    assert.equal(w.getWidget(docFile, widget.id).widget.name, "A");
  });

  test("an external edit is picked up (watcher) and announced once; our own writes are not echoed", async () => {
    const docFile = fresh("external");
    const { widget } = await w.addWidget(docFile, { kind: "note", config: { text: "mine" } });
    const s = storeFor(docFile);
    const seen: string[] = [];
    const off = s.onChange((st) => seen.push(st.rev));
    const release = s.retain();
    await w.updateWidget(docFile, widget.id, { name: "Self" });
    const afterSelf = seen.length;
    assert.equal(afterSelf, 1);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(seen.length, afterSelf, "own write echoed back from the watcher");
    const edited = JSON.parse(fs.readFileSync(sidecarPath(docFile), "utf8"));
    edited.widgets[0].config.text = "from outside";
    fs.writeFileSync(sidecarPath(docFile), JSON.stringify(edited, null, 2));
    await waitFor(() => seen.length > afterSelf);
    assert.equal((s.peek().widgets[0].config as any).text, "from outside");
    // Deleting the file empties the list.
    fs.rmSync(sidecarPath(docFile));
    await waitFor(() => s.peek().widgets.length === 0);
    release();
    off();
  });

  test("a sidecar missing for a moment (another process's rename-over save) never reads as an empty list", async () => {
    const docFile = fresh("vanish");
    await w.addWidget(docFile, { kind: "note", config: { text: "stay" } });
    const s = storeFor(docFile);
    const counts: number[] = [];
    const off = s.onChange((st) => counts.push(st.widgets.length));
    const file = sidecarPath(docFile);
    const aside = file + ".aside";
    fs.renameSync(file, aside);
    assert.equal(s.refresh(), false, "the gap is not announced");
    await new Promise((r) => setTimeout(r, 25));
    fs.renameSync(aside, file);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(s.peek().widgets.length, 1);
    assert.ok(!counts.includes(0), `never emitted an empty list (${counts})`);
    // Gone for good: after a few looks it is empty.
    fs.rmSync(file);
    s.refresh();
    await waitFor(() => s.peek().widgets.length === 0);
    off();
  });

  test("invalid JSON keeps the last good state, warns, and refuses writes with 409", async () => {
    const docFile = fresh("invalid");
    const { widget } = await w.addWidget(docFile, { kind: "note", config: { text: "keep" } });
    const s = storeFor(docFile);
    const release = s.retain();
    fs.writeFileSync(sidecarPath(docFile), "{ not json");
    await waitFor(() => s.peek().invalid);
    const listed = w.listWidgets(docFile);
    assert.match(listed.warning ?? "", /cannot be read/);
    assert.equal(listed.widgets.length, 1);
    await assert.rejects(w.updateWidget(docFile, widget.id, { name: "x" }), (e: any) => e.status === 409 && e.code === "sidecar-invalid");
    assert.equal(fs.readFileSync(sidecarPath(docFile), "utf8"), "{ not json", "the bad file was not overwritten");
    // Fixing the file brings writes back.
    fs.writeFileSync(sidecarPath(docFile), JSON.stringify({ version: 1, widgets: [] }));
    await waitFor(() => !s.peek().invalid);
    await w.addWidget(docFile, { kind: "note" });
    release();
  });

  test("a change made on disk between reads is the base for the next write (rebase)", async () => {
    const docFile = fresh("rebase");
    const { widget } = await w.addWidget(docFile, { kind: "todo" });
    // Nobody is watching: edit the file behind the store's back, then mutate.
    const raw = JSON.parse(fs.readFileSync(sidecarPath(docFile), "utf8"));
    raw.widgets.push({ id: "w_outside1", kind: "note", name: "Out", x: 0, y: 0, w: 240, h: 200, locked: false, config: { text: "x", tone: "plain" } });
    fs.writeFileSync(sidecarPath(docFile), JSON.stringify(raw));
    await w.runWidgetAction(docFile, widget.id, "addItem", { text: "later" });
    const ids = w.listWidgets(docFile).widgets.map((x) => x.id);
    assert.deepEqual(ids, [widget.id, "w_outside1"]);
  });

  test("validation: bad config, bad geometry, duplicate id, locked geometry", async () => {
    const docFile = fresh("validation");
    await assert.rejects(w.addWidget(docFile, { kind: "nope" }), (e: any) => e.status === 422 && e.code === "unknown-kind");
    await assert.rejects(w.addWidget(docFile, { kind: "note", config: { tone: "chartreuse" } }), (e: any) => e.status === 422);
    await assert.rejects(w.addWidget(docFile, { kind: "note", w: -5 }), (e: any) => e.status === 422);
    const { widget } = await w.addWidget(docFile, { kind: "note", id: "w_dupe0001", locked: true });
    await assert.rejects(w.addWidget(docFile, { kind: "note", id: "w_dupe0001" }), (e: any) => e.status === 409 && e.code === "id-exists");
    await assert.rejects(w.updateWidget(docFile, widget.id, { x: 99 }), (e: any) => e.status === 409 && e.code === "locked");
    await w.updateWidget(docFile, widget.id, { name: "fine on a locked widget" });
    const moved = await w.updateWidget(docFile, widget.id, { locked: false, x: 99 });
    assert.equal(moved.widget.x, 99);
    await assert.rejects(w.updateWidget(docFile, "w_missing1", { x: 1 }), (e: any) => e.status === 404);
  });

  test("auto-place goes right of the boards and stacks down; index and restore by id work", async () => {
    const docFile = fresh("place");
    const a = await w.addWidget(docFile, { kind: "note" });
    const b = await w.addWidget(docFile, { kind: "todo" });
    // Boards end at x=1100 (500+600); 80px gap.
    assert.equal(a.widget.x, 1180);
    assert.equal(a.widget.y, 0);
    assert.equal(b.widget.x, 1180);
    assert.equal(b.widget.y, a.widget.y + a.widget.h + 24);
    const removed = await w.removeWidget(docFile, a.widget.id);
    assert.equal(removed.index, 0);
    const back = await w.addWidget(docFile, { ...a.widget, index: removed.index });
    assert.deepEqual(w.listWidgets(docFile).widgets.map((x) => x.id), [a.widget.id, b.widget.id]);
    assert.equal(back.widget.x, a.widget.x);
  });

  test("PATCH merges config deeply, null deletes, arrays replace", async () => {
    const docFile = fresh("merge");
    const { widget } = await w.addWidget(docFile, { kind: "json", config: { url: "http://127.0.0.1:1/x", headers: { "x-a": "1", "x-b": "2" } } });
    const r = await w.updateWidget(docFile, widget.id, { config: { auth: { type: "bearer", secret: { service: "svc", account: "acct" } }, headers: { "x-a": null } as any } });
    const c = r.widget.config as any;
    assert.deepEqual(c.headers, { "x-b": "2" });
    assert.equal(c.auth.type, "bearer");
    assert.deepEqual(c.auth.secret, { service: "svc", account: "acct" });
    const r2 = await w.updateWidget(docFile, widget.id, { config: { auth: { secret: null } } });
    assert.equal((r2.widget.config as any).auth.secret, undefined);
    assert.equal((r2.widget.config as any).auth.type, "bearer");
  });
  test("hunt-1 #2: a writer that slips in between the last check and the swap is kept, our change lands on top", async () => {
    const docFile = fresh("cas");
    const { widget } = await w.addWidget(docFile, { kind: "note", id: "w_casnote1", config: { text: "original" } });
    const file = sidecarPath(docFile);
    let fired = false;
    storeTestHooks.beforeCommit = (f) => {
      if (fired || f !== file) return;
      fired = true;
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      j.widgets[0].config.text = "external edit";
      fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    };
    try {
      await w.updateWidget(docFile, widget.id, { x: 77 });
    } finally {
      storeTestHooks.beforeCommit = undefined;
    }
    assert.ok(fired);
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(j.widgets[0].config.text, "external edit");
    assert.equal(j.widgets[0].x, 77);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp") || f.endsWith(".prev")), []);
  });

  test("hunt-1 #3: an unreadable sidecar is not an empty one: writes are refused and the file survives", { skip: process.getuid?.() === 0 }, async () => {
    const docFile = fresh("eacces");
    await w.addWidget(docFile, { kind: "note", id: "w_keepme01" });
    const file = sidecarPath(docFile);
    const bytes = fs.readFileSync(file, "utf8");
    fs.chmodSync(file, 0o000);
    try {
      await assert.rejects(() => w.addWidget(docFile, { kind: "todo" }), (e: any) => e.code === "sidecar-invalid");
      assert.equal(storeFor(docFile).peek().widgets.length, 1, "the last good list stays");
    } finally {
      fs.chmodSync(file, 0o644);
    }
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  });
});
