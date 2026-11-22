// One document the OS will not hand over (macOS holds open() on a protected folder until the privacy prompt is
// answered) must not stop the server. A FIFO behaves the same way: open() waits until a writer shows up.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { FIXTURE_DOC, tmpDir } from "./helpers.ts";

const dir = tmpDir("blocked");
process.env.CANVAS_ROOTS = dir;
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const within = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} did not answer within ${ms} ms`)), ms))]);

test("a document whose read blocks does not stop other routes; it loads once the read is released", async () => {
  const fifo = path.join(dir, "stuck.canvas.json");
  execFileSync("mkfifo", [fifo]);
  const stuck = fetch(`${base}/api/doc?file=${encodeURIComponent(fifo)}`).then((r) => r.json() as Promise<any>);
  await new Promise((r) => setTimeout(r, 150)); // the request is in, the read is waiting

  try {
    for (const route of ["/", `/?file=${encodeURIComponent(fifo)}&shell=native`, "/api/bridge/status", "/health", "/api/files"]) {
      const r = await within(fetch(base + route), 2000, route);
      assert.equal(r.status, 200, route);
      await r.arrayBuffer();
    }
  } finally {
    // Release it even if the page waited for the read and timed out.
    const fd = fs.openSync(fifo, "w");
    fs.writeSync(fd, JSON.stringify(FIXTURE_DOC));
    fs.closeSync(fd);
  }
  const doc = await within(stuck, 5000, "the blocked document");
  assert.ok(Array.isArray(doc.boards) && doc.boards.length === 2, JSON.stringify(doc).slice(0, 200));
});
