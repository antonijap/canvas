// Regression tests for Codex bug hunt round 1 (.planning/research/codex-hunt-1.md), server findings that need a
// running server: asset sandboxing, /quit from foreign pages, unreadable assets, and fresh revisions after outside saves.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir, writeDoc } from "./helpers.ts";

const dir = tmpDir("hunt1");
process.env.CANVAS_ROOTS = dir;
const docFile = writeDoc(dir);
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(() => {
  fs.unwatchFile(docFile);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("codex hunt 1: server", () => {
  test("#1 an SVG asset is served with a sandbox CSP: no script, opaque origin", async () => {
    const svg = path.join(dir, "evil.svg");
    fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('/api/files')</script></svg>`);
    const r = await fetch(`${base}/asset?p=${encodeURIComponent(svg)}`);
    assert.equal(r.status, 200);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(csp, /\bsandbox\b/);
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    await r.text();
  });

  test("#5 /quit refuses a cross-site form post and a request without the header", async () => {
    const exit = process.exit;
    let exited = false;
    process.exit = (() => void (exited = true)) as typeof process.exit;
    try {
      const noHeader = await fetch(`${base}/quit`, { method: "POST" });
      assert.equal(noHeader.status, 403);
      const crossSite = await fetch(`${base}/quit`, { method: "POST", headers: { "x-canvas": "1", origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
      assert.equal(crossSite.status, 403);
      await sleep(120);
      assert.equal(exited, false);
    } finally {
      process.exit = exit;
    }
  });

  test("#6 an unreadable asset answers an error and the server keeps serving", { skip: process.getuid?.() === 0 }, async () => {
    const png = path.join(dir, "locked.png");
    fs.writeFileSync(png, "PNGDATA");
    fs.chmodSync(png, 0o000);
    try {
      await fetch(`${base}/asset?p=${encodeURIComponent(png)}`).then((r) => r.arrayBuffer()).catch(() => undefined);
    } finally {
      fs.chmodSync(png, 0o644);
    }
    const health = await fetch(`${base}/health`).then((r) => r.json() as Promise<{ ok: boolean }>);
    assert.equal(health.ok, true);
  });

  test("#7 after an outside save, an edit carrying the fresh revision from /api/doc is accepted the first time", async () => {
    const q = `?file=${encodeURIComponent(docFile)}`;
    const update = (body: Record<string, unknown>) =>
      fetch(`${base}/api/update`, { method: "POST", headers: { "content-type": "application/json", "x-canvas": "1" }, body: JSON.stringify({ file: docFile, ...body }) });
    const first = await update({ id: "Scr01", props: { opacity: 0.5 } });
    assert.equal(first.status, 200, await first.clone().text());
    const was = ((await first.json()) as { revision: string }).revision;
    // Another app or tool saves the file.
    const doc = JSON.parse(fs.readFileSync(docFile, "utf8"));
    doc.children[1].name = "Saved elsewhere";
    fs.writeFileSync(docFile, JSON.stringify(doc, null, 2));
    let fresh = was;
    for (let i = 0; i < 60 && fresh === was; i++) {
      fresh = ((await fetch(`${base}/api/doc${q}`).then((r) => r.json())) as { revision: string }).revision;
      if (fresh === was) await sleep(50);
    }
    assert.notEqual(fresh, was, "the server saw the outside save");
    const second = await update({ id: "Scr01", props: { opacity: 0.25 }, expectedRevision: fresh });
    assert.equal(second.status, 200, await second.clone().text());
    const saved = JSON.parse(fs.readFileSync(docFile, "utf8"));
    assert.equal(saved.children[0].opacity, 0.25);
    assert.equal(saved.children[1].name, "Saved elsewhere", "the outside edit is kept");
  });
});
