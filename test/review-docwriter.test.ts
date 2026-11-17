// Codex review c2 (docs/evidence/review-fixes.md): the recovery after a write that turned out not to be ours read
// the file, then took its signature. A save in between paired the old bytes with the new signature, and the
// next edit could overwrite that save unseen. readStable takes the signature before and after the read.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("review-docwriter");
process.env.CANVAS_ROOTS = dir;
const pw = await import("../src/docwriter.ts");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const docNamed = (name: string) => ({ version: "2.21", children: [{ type: "frame", id: "B", name, x: 0, y: 0, width: 10, height: 10, layout: "none", children: [] }] });
/** Someone else's save: a temp file renamed over the document. */
const save = (file: string, name: string) => {
  fs.writeFileSync(file + ".x", JSON.stringify(docNamed(name), null, 2));
  fs.renameSync(file + ".x", file);
};

test("c2: a save between the read and the signature is read again, never paired with the older bytes", async () => {
  const file = path.join(dir, "race.canvas.json");
  save(file, "A");
  let saves = 0;
  // Fault injection: their save B lands right after our read of A.
  pw.writerHooks.afterStableRead = () => { if (saves++ === 0) save(file, "B"); };
  try {
    const r = await pw.readStable(file);
    assert.ok(r, "the file held still on the second read");
    const name = (r.loaded.doc as any).children[0].name;
    pw.writerHooks.afterStableRead = undefined;
    const now = await pw.readStable(file);
    assert.equal(r.sig, now!.sig, "the signature is the file's as it is now");
    assert.equal(name, "B", "and the bytes are the ones under that signature (not A's)");
  } finally {
    pw.writerHooks.afterStableRead = undefined;
  }
});

test("c2: a file that never holds still answers null (the caller reads it again later)", async () => {
  const file = path.join(dir, "busy.canvas.json");
  save(file, "A");
  let n = 0;
  pw.writerHooks.afterStableRead = () => save(file, `N${n++}`);
  try {
    assert.equal(await pw.readStable(file), null);
  } finally {
    pw.writerHooks.afterStableRead = undefined;
  }
});
