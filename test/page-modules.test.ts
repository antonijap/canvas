// Page modules (src/page/*.js) are served from disk on every request, including files added after the server
// started: a fixed allowlist once made a new import 404 and silently killed structure editing (QA item 1).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("pagemods");
process.env.CANVAS_ROOTS = dir;
const { startServer } = await import("../src/server.ts");
const { pageFileName } = await import("../src/widgets.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const PAGE_DIR = fileURLToPath(new URL("../src/page/", import.meta.url));

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("page file names stay inside src/page", () => {
  assert.equal(pageFileName("/page/structure.js"), "structure.js");
  assert.equal(pageFileName("/page/widgets.css"), "widgets.css");
  assert.equal(pageFileName("/page/note-doc2.js"), "note-doc2.js");
  for (const bad of ["/page/../server.ts", "/page/x/y.js", "/page/.hidden.js", "/page/a.ts", "/page/A.js", "/page/"]) assert.equal(pageFileName(bad), null, bad);
});

test("every module the page loads, and everything those import, is served", async () => {
  const html = await (await fetch(base + "/")).text();
  const todo = [...html.matchAll(/src="\/page\/([a-z0-9-]+\.js)"/g)].map((m) => m[1]);
  assert.ok(todo.includes("structure.js"));
  const seen = new Set<string>();
  while (todo.length) {
    const name = todo.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const r = await fetch(`${base}/page/${name}`);
    assert.equal(r.status, 200, name);
    const src = await r.text();
    for (const m of src.matchAll(/(?:import|from)\s*\(?\s*["'](?:\.\/|\/page\/)([a-z0-9-]+\.js)["']/g)) todo.push(m[1]);
  }
  assert.ok(seen.has("shortcuts-logic.js"), "follows imports");
});

test("a page file added after the server started is served", async () => {
  const name = `zz-added-${process.pid}.js`;
  const f = path.join(PAGE_DIR, name);
  assert.equal((await fetch(`${base}/page/${name}`)).status, 404);
  fs.writeFileSync(f, "export const x = 1;\n");
  try {
    const r = await fetch(`${base}/page/${name}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/javascript/);
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test("the page reports a module that failed to load", async () => {
  const html = await (await fetch(base + "/")).text();
  assert.match(html, /page module failed to load/);
  assert.match(html, /addEventListener\("error"/);
});

test("zoom reaches 25600%, the limit, in every clamp (QA item 13)", async () => {
  const html = await (await fetch(base + "/")).text();
  assert.match(html, /const MAX_ZOOM = 256;/);
  assert.doesNotMatch(html, /Math\.min\(8, Math\.max\(0\.02/);
  const bridge = fs.readFileSync(path.join(PAGE_DIR, "bridge.js"), "utf8");
  assert.match(bridge, /const MAX_ZOOM = 256;/);
  assert.doesNotMatch(bridge, /Math\.min\(8, /);
});
