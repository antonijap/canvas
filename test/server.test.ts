// The studio server: pages, documents, boards, node lookup (including instance paths), live changes.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-test-"));
process.env.CANVAS_ROOTS = tmp;

const FIXTURE = {
  version: "2.21",
  children: [
    {
      type: "frame",
      id: "Cmp01",
      name: "Button",
      reusable: true,
      layout: "horizontal",
      padding: [8, 16],
      fill: "$accent",
      children: [{ type: "text", id: "Lbl01", name: "Label", content: "Go", fontFamily: "Inter", fontSize: 16, fontWeight: "600", fill: "#FFFFFF" }],
    },
    {
      type: "frame",
      id: "Scr01",
      name: "Screen",
      x: 0,
      y: 200,
      width: 390,
      height: 844,
      layout: "vertical",
      children: [
        { type: "ref", id: "Ins01", ref: "Cmp01", descendants: { Lbl01: { content: "Start" } } },
        { type: "rectangle", id: "Rec01", width: 100, height: 40, fill: "#EEEEEE" },
        { type: "text", id: "Txt01", name: "Title", content: "Hello", fontFamily: "Inter", fontSize: 24, fontWeight: "700", fill: "$accent" },
      ],
    },
  ],
  variables: { accent: { type: "color", value: "#0766EB" } },
};

const p = path.join(tmp, "demo.canvas.json");
fs.writeFileSync(p, JSON.stringify(FIXTURE, null, 2));
const real = fs.realpathSync(p);

const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

type DocPayload = {
  name: string;
  revision: string;
  boards: { id: string; name: string; width?: number; height?: number }[];
  components: { id: string; name: string; type: string; isText: boolean }[];
  styles: { props: Record<string, unknown>; count: number }[];
  variables: Record<string, { type: string; value: unknown }>;
};
const get = <T,>(pathname: string): Promise<T> => fetch(`${base}${pathname}`).then((r) => r.json() as Promise<T>);
const q = (s: string) => `?file=${encodeURIComponent(real)}${s}`;

after(() => {
  fs.unwatchFile(real);
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("canvas server", () => {
  test("health and page", async () => {
    const health = await get<{ ok: boolean; version: string; root: string }>("/health");
    assert.deepEqual(health, { ok: true, version: (await import("../src/server.ts")).version(), root: (await import("../src/version.ts")).codeRootId() });
    const page = await fetch(`${base}/`).then((r) => r.text());
    assert.match(page, /<b>Canvas<\/b>/);
    assert.match(page, /api\/node/);
  });

  test("the inspector's update endpoint edits one node and refuses strangers", async () => {
    const post = (body: unknown, headers: Record<string, string> = { "x-canvas": "1" }) =>
      fetch(`${base}/api/update`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ file: real, id: "Rec01", props: { opacity: 0.5 } }, {})).status, 403);
    // A layer inside an instance takes overrides now (src/overrides.ts); what it is cannot change.
    assert.equal((await post({ file: real, id: "Ins01/Lbl01", props: { type: "rectangle" } })).status, 422);
    assert.equal((await post({ file: real, id: "Rec01", props: { type: "text" } })).status, 422);
    const ok = await post({ file: real, id: "Rec01", props: { opacity: 0.5 } });
    assert.equal(ok.status, 200);
    const n = await get<{ node: { opacity: number } }>(`/api/node${q("")}&id=Rec01`);
    assert.equal(n.node.opacity, 0.5);
    assert.equal((await post({ file: real, id: "Rec01", props: {}, remove: ["opacity"] })).status, 200);
  });

  test("files list includes a .canvas package and leaves single .canvas.json files out", async () => {
    const pkg = path.join(tmp, "Listed.canvas");
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "document.json"), JSON.stringify(FIXTURE, null, 2));
    const pkgReal = fs.realpathSync(pkg);
    // The scan runs in the background; near-root files surface within moments.
    let files: { file: string }[] = [];
    for (let i = 0; i < 40 && !files.some((f) => f.file === pkgReal); i++) {
      files = await get<{ file: string }[]>("/api/files");
      if (!files.some((f) => f.file === pkgReal)) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(files.some((f) => f.file === pkgReal), JSON.stringify(files).slice(0, 200));
    assert.ok(!files.some((f) => f.file === real), "a single .canvas.json is not listed");
  });

  test("the document payload carries boards, components, variables and text styles", async () => {
    const d = await get<DocPayload>(`/api/doc${q("")}`);
    assert.equal(d.name, "demo");
    // Components sit on the canvas like any top-level object; the rail lists them separately too.
    assert.deepEqual(d.boards.map((b) => b.id), ["Cmp01", "Scr01"]);
    assert.deepEqual(d.components.map((c) => c.id), ["Cmp01"]);
    assert.equal(d.components[0].isText, false);
    assert.equal(d.variables.accent.value, "#0766EB");
    assert.ok(d.styles.length >= 2, "two distinct text styles");
  });

  test("a board renders with node identities for hit-testing", async () => {
    const b = await get<{ html: string }>(`/api/board${q("&id=Scr01")}`);
    assert.match(b.html, /data-id="Rec01"/);
    assert.match(b.html, /data-id="Ins01\/Lbl01"/);
  });

  test("node lookup works for stored ids and instance paths", async () => {
    const plain = await get<{ node: Record<string, unknown>; parentId: string; path: boolean }>(`/api/node${q("&id=Rec01")}`);
    assert.equal(plain.node.width, 100);
    assert.equal(plain.parentId, "Scr01");
    assert.equal(plain.path, false);
    const inst = await get<{ node: Record<string, unknown>; path: boolean }>(`/api/node${q("&id=Ins01/Lbl01")}`);
    assert.equal(inst.node.content, "Start");
    assert.equal(inst.path, true);
    const missing = await get<{ error: string }>(`/api/node${q("&id=Nope01")}`);
    assert.match(missing.error, /no node/);
  });

  test("the properties payload refreshes when the file changes on disk", async () => {
    const before = await get<DocPayload>(`/api/doc${q("")}`);
    const next = JSON.parse(JSON.stringify(FIXTURE)) as typeof FIXTURE;
    (next.children[1].children[1] as Record<string, unknown>).fill = "#16A34A";
    fs.writeFileSync(p, JSON.stringify(next, null, 2));
    let after_: DocPayload | undefined;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after_ = await get<DocPayload>(`/api/doc${q("")}`);
      if (after_.revision !== before.revision) break;
    }
    assert.ok(after_, "the document never answered again");
    assert.notEqual(after_.revision, before.revision);
    const node = await get<{ node: Record<string, unknown> }>(`/api/node${q("&id=Rec01")}`);
    assert.equal(node.node.fill, "#16A34A");
  });

  test("only localhost by name", async () => {
    const status = await new Promise<number>((resolve) => {
      const req = http.request(`${base}/api/files`, { headers: { host: "evil.example" } } as http.RequestOptions, (r) => {
        r.resume();
        resolve(r.statusCode as number);
      });
      req.end();
    });
    assert.equal(status, 403);
  });
});
