import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { jpegPreviews, packPreviews, unpackPreviews } from "../src/image-previews.ts";

test("reads ordered native previews and keeps missing entries", () => {
  const image = Buffer.alloc(20, 255);
  for (const [i, value] of [1170, 2532, 1, 1].entries()) image.writeUInt32LE(value, i * 4);
  assert.deepEqual(unpackPreviews(Buffer.concat([Buffer.alloc(16), image]), 2), [null, image]);
});

test("rejects incomplete preview batches and invalid dimensions", () => {
  const image = Buffer.alloc(16);
  assert.throws(() => unpackPreviews(image, 2), /preview batch/);
  assert.throws(() => unpackPreviews(Buffer.alloc(17), 1), /preview batch/);
  image.writeUInt32LE(33, 8);
  assert.throws(() => unpackPreviews(image, 1), /preview batch/);
});

test("reuses previews only while the asset tag matches", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canvas-preview-test-"));
  const previousState = process.env.CANVAS_STATE_DIR;
  process.env.CANVAS_STATE_DIR = dir;
  try {
    const file = path.join(dir, "screen.jpg"), helper = path.join(dir, "preview");
    const image = Buffer.alloc(20, 255);
    [1170, 2532, 1, 1].forEach((value, i) => image.writeUInt32LE(value, i * 4));
    writeFileSync(helper, `#!/bin/sh\ncat >/dev/null\nprintf '${[...image].map((n) => "\\" + n.toString(8).padStart(3, "0")).join("")}'\n`, { mode: 0o700 });
    writeFileSync(file, "first");
    const [first] = await jpegPreviews(helper, [file]);
    assert.equal(first?.cached, false);
    assert.deepEqual(first?.pixels, image);
    const [warm] = await jpegPreviews(helper, [file]);
    assert.equal(warm?.cached, true);
    assert.equal(warm.etag, first?.etag);
    writeFileSync(file, "second");
    const [next] = await jpegPreviews(helper, [file]);
    assert.equal(next?.cached, false);
    assert.notEqual(next?.etag, first?.etag);
  } finally {
    if (previousState === undefined) delete process.env.CANVAS_STATE_DIR;
    else process.env.CANVAS_STATE_DIR = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packs native pixels, asset tags and cache hits in request order", () => {
  const pixels = Buffer.alloc(20);
  const data = packPreviews([null, { etag: '"tag"', pixels, cached: true }]);
  assert.deepEqual(data.subarray(0, 4), Buffer.alloc(4));
  assert.equal(data.readUInt16LE(4), pixels.length);
  assert.equal(data[6], 5);
  assert.equal(data[7], 1);
  assert.equal(data.subarray(8, 13).toString(), '"tag"');
  assert.deepEqual(data.subarray(13), pixels);
});
