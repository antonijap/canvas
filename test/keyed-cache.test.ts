// Board data by content key (src/keyed.ts): /api/scene and /api/board asked for with the board's current key and
// the server's scene environment are immutable (the browser keeps them for good); anything else is never cached as
// that key. An edit changes the key, so a kept answer can never show stale content.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
import { IMMUTABLE, keyedAnswer, sceneEnvOf } from "../src/keyed.ts";
// @ts-ignore: a plain ES module the page imports too
import { sceneUrl } from "../src/page/engine-view.js";

describe("keyedAnswer", () => {
  test("the current key in the current environment is immutable, with an ETag", () => {
    const a = keyedAnswer({ key: "k1", v: "e1" }, "k1", "e1", undefined);
    assert.equal(a.cacheable, true);
    assert.equal(a.notModified, false);
    assert.equal(a.headers["cache-control"], IMMUTABLE);
    assert.equal(a.headers.etag, '"k1-e1"');
  });
  test("an old key, a missing key, another environment or a transient answer are never cached", () => {
    for (const a of [
      keyedAnswer({ key: "old", v: "e1" }, "k1", "e1", undefined),
      keyedAnswer({ key: null, v: null }, "k1", "e1", undefined),
      keyedAnswer({ key: "k1", v: "e0" }, "k1", "e1", undefined),
      keyedAnswer({ key: "k1", v: "e1" }, undefined, "e1", undefined),
      keyedAnswer({ key: "k1", v: "e1" }, "k1", "e1", undefined, true),
    ]) {
      assert.equal(a.cacheable, false);
      assert.equal(a.headers["cache-control"], "no-store");
      assert.equal(a.headers.etag, undefined);
      assert.equal(a.notModified, false);
    }
  });
  test("If-None-Match with the same answer is a 304, also weak or in a list; another is not", () => {
    assert.equal(keyedAnswer({ key: "k1", v: "e1" }, "k1", "e1", '"k1-e1"').notModified, true);
    assert.equal(keyedAnswer({ key: "k1", v: "e1" }, "k1", "e1", 'W/"k1-e1"').notModified, true);
    assert.equal(keyedAnswer({ key: "k1", v: "e1" }, "k1", "e1", '"x", "k1-e1"').notModified, true);
    assert.equal(keyedAnswer({ key: "k1", v: "e1" }, "k1", "e1", '"k0-e1"').notModified, false);
    assert.equal(keyedAnswer({ key: "k0", v: "e1" }, "k1", "e1", '"k0-e1"').notModified, false, "an old key's tag never revalidates");
  });
  test("the scene environment follows the code, the scene format, web fonts and the font folders", () => {
    const dir = tmpDir("keyed-env");
    const a = sceneEnvOf("c1", 2, true, [dir]);
    assert.equal(sceneEnvOf("c1", 2, true, [dir]), a);
    assert.notEqual(sceneEnvOf("c2", 2, true, [dir]), a);
    assert.notEqual(sceneEnvOf("c1", 3, true, [dir]), a);
    assert.notEqual(sceneEnvOf("c1", 2, false, [dir]), a);
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(dir, t, t); // a font added to the folder
    assert.notEqual(sceneEnvOf("c1", 2, true, [dir]), a);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test("a web font lookup that failed on the network marks the answer transient until one works", async () => {
    const { googleFaces, googleFailed } = await import("../src/fontfiles.ts");
    const fam = "Keyed Test Family " + Date.now();
    await googleFaces(fam, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    assert.equal(googleFailed(fam), true);
    await googleFaces(fam, (async () => new Response("", { status: 400 })) as unknown as typeof fetch);
    assert.equal(googleFailed(fam), false, "an answer (even no such family) is not a network failure");
  });
  test("the page asks with key and environment only when it has both", () => {
    const api = (p: string) => p + "?file=f";
    assert.equal(sceneUrl(api, "B 1", "k1", "e1"), "/api/scene?file=f&id=B%201&key=k1&v=e1");
    assert.equal(sceneUrl(api, "B1", undefined, "e1"), "/api/scene?file=f&id=B1");
    assert.equal(sceneUrl(api, "B1", "k1", ""), "/api/scene?file=f&id=B1");
  });
});

// ---------------------------------------------------------------- against a real server

const dir = tmpDir("keyed");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_WEB_FONTS = "0";
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "B1", name: "One", x: 0, y: 0, width: 200, height: 100, fill: "#FF0000", children: [{ type: "rectangle", id: "R1", width: 20, height: 20, fill: "#00FF00" }] },
    { type: "frame", id: "B2", name: "Two", x: 300, y: 0, width: 200, height: 100, fill: "#0000FF", children: [] },
  ],
};
const file = path.join(dir, "k.canvas.json");
fs.writeFileSync(file, JSON.stringify(DOC));
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  fs.unwatchFile(file);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const q = `?file=${encodeURIComponent(file)}`;
const env = async () => /data-env="([0-9a-f]+)"/.exec(await (await fetch(`${base}/${q}`)).text())![1];
const keyOf = async (id: string) => ((await (await fetch(`${base}/api/doc${q}`)).json()).boards as { id: string; key: string }[]).find((b) => b.id === id)!.key;
const update = (id: string, props: object) =>
  fetch(`${base}/api/update`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id, props }) }).then((r) => r.json());

describe("keyed board routes", () => {
  test("the page carries the scene environment", async () => {
    assert.match(await env(), /^[0-9a-f]{12}$/);
  });

  for (const route of ["/api/scene", "/api/board"]) {
    test(`${route}: the current key is immutable and revalidates to a 304`, async () => {
      const v = await env(), key = await keyOf("B1");
      const r = await fetch(`${base}${route}${q}&id=B1&key=${key}&v=${v}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), IMMUTABLE);
      const etag = r.headers.get("etag")!;
      assert.equal(etag, `"${key}-${v}"`);
      const body = await r.json();
      assert.equal(body.key, key);
      assert.equal(body.revision, undefined, "a kept answer holds nothing that moves with other edits");
      const again = await fetch(`${base}${route}${q}&id=B1&key=${key}&v=${v}`, { headers: { "if-none-match": etag } });
      assert.equal(again.status, 304);
    });

    test(`${route}: unkeyed, old-key and other-environment requests are no-store and answer today's board`, async () => {
      const v = await env(), key = await keyOf("B1");
      const plain = await fetch(`${base}${route}${q}&id=B1`);
      assert.equal(plain.headers.get("cache-control"), "no-store");
      assert.equal((await plain.json()).key, key);
      const old = await fetch(`${base}${route}${q}&id=B1&key=0000000000000000&v=${v}`);
      assert.equal(old.headers.get("cache-control"), "no-store");
      assert.equal(old.headers.get("etag"), null);
      assert.equal((await old.json()).key, key, "the current key comes back: the page sees it is behind");
      const otherEnv = await fetch(`${base}${route}${q}&id=B1&key=${key}&v=000000000000`);
      assert.equal(otherEnv.headers.get("cache-control"), "no-store");
      const tag = await fetch(`${base}${route}${q}&id=B1&key=0000000000000000&v=${v}`, { headers: { "if-none-match": `"0000000000000000-${v}"` } });
      assert.equal(tag.status, 200, "an old key's tag never answers 304");
    });
  }

  test("an edit changes the key: the old key is never served as cacheable again, the new one shows the edit", async () => {
    const v = await env();
    const k1 = await keyOf("B1"), k2 = await keyOf("B2");
    const before = await (await fetch(`${base}/api/scene${q}&id=B1&key=${k1}&v=${v}`)).json();
    assert.equal(before.root.children[0].fill, "#00FF00");
    const w = await update("R1", { fill: "#123456" });
    assert.equal(w.ok, true);
    const n1 = await keyOf("B1");
    assert.notEqual(n1, k1, "the edited board has a new key");
    assert.equal(await keyOf("B2"), k2, "an untouched board keeps its key (and its cached scene)");
    const stale = await fetch(`${base}/api/scene${q}&id=B1&key=${k1}&v=${v}`);
    assert.equal(stale.headers.get("cache-control"), "no-store");
    const s = await stale.json();
    assert.equal(s.key, n1);
    assert.equal(s.root.children[0].fill, "#123456", "an old key gets today's content, never the old one");
    const fresh = await fetch(`${base}/api/scene${q}&id=B1&key=${n1}&v=${v}`);
    assert.equal(fresh.headers.get("cache-control"), IMMUTABLE);
    assert.equal((await fresh.json()).root.children[0].fill, "#123456");
  });

  test("an edit on disk by another app changes the key too", async () => {
    const v = await env();
    const k = await keyOf("B2");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.children[1].fill = "#ABCDEF";
    fs.writeFileSync(file, JSON.stringify(doc));
    let n = k;
    for (let i = 0; i < 100 && n === k; i++) { await new Promise((r) => setTimeout(r, 50)); n = await keyOf("B2"); }
    assert.notEqual(n, k);
    const r = await fetch(`${base}/api/scene${q}&id=B2&key=${k}&v=${v}`);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal((await r.json()).root.fill, "#ABCDEF");
  });

  test("assets revalidate by size and modification time", async () => {
    const img = path.join(dir, "a.png");
    fs.writeFileSync(img, Buffer.from("89504e470d0a1a0a", "hex"));
    const url = `${base}/asset?p=${encodeURIComponent(img)}`;
    const r = await fetch(url);
    const etag = r.headers.get("etag");
    assert.ok(etag);
    await r.arrayBuffer();
    assert.equal((await fetch(url, { headers: { "if-none-match": etag! } })).status, 304);
    fs.writeFileSync(img, Buffer.from("89504e470d0a1a0a00", "hex"));
    assert.equal((await fetch(url, { headers: { "if-none-match": etag! } })).status, 200, "a replaced file is sent again");
  });

  test("the document stream skips the whole document when the page already has its revision", async () => {
    const rev = (await (await fetch(`${base}/api/doc${q}`)).json()).revision;
    const read = async (extra: string) => {
      const ac = new AbortController();
      const r = await fetch(`${base}/events${q}${extra}`, { signal: ac.signal });
      const reader = r.body!.getReader();
      const { value } = await reader.read();
      ac.abort();
      return new TextDecoder().decode(value);
    };
    assert.match(await read(`&since=${rev}`), /event: docsame/);
    assert.match(await read(`&since=000000000000`), /event: doc\n/);
    assert.match(await read(""), /event: doc\n/);
  });
});
