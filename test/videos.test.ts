// Video cards on disk: add (copied into the package, or linked), the stream with HTTP Range support and
// its security checks, posters per file hash, replacing the file, and the "Embed video here" hint.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, describe, test } from "node:test";
import { mediaSlot } from "../src/usage.ts";
import { parseRange, proxyConfig, PROXY_TIERS, tierFor, variantFor, videoSize } from "../src/videos.ts";
import { FIXTURE_DOC, tmpDir, writeDoc } from "./helpers.ts";

const dir = tmpDir("videos");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_VIDEO_PROXIES = path.join(dir, "proxies");
const docFile = writeDoc(dir);
const pkg = path.join(dir, "Promo.canvas");
fs.mkdirSync(pkg);
fs.writeFileSync(path.join(pkg, "document.json"), JSON.stringify(FIXTURE_DOC));
// Not a real video: the server never decodes, it only copies, hashes and streams bytes.
const clip = path.join(dir, "outside", "teachers-promo.mp4");
fs.mkdirSync(path.dirname(clip));
const bytes = Buffer.alloc(100_000);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
fs.writeFileSync(clip, bytes);

// Proxies of these fake movies go to the temp folder, never ~/Library/Caches.
proxyConfig.dir = path.join(dir, "proxies");
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
after(() => {
  fs.unwatchFile(docFile);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const q = (file: string, extra = "") => `?file=${encodeURIComponent(file)}${extra}`;
async function j(method: string, p: string, body?: unknown, headers: Record<string, string> = { "x-canvas": "1" }) {
  const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("parseRange", () => {
  test("open, closed, suffix and bad ranges", () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.deepEqual(parseRange("bytes=0-", 100), { start: 0, end: 99 });
    assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
    assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
    for (const bad of ["bytes=100-", "bytes=20-10", "bytes=0-1,5-6", "items=0-1", "bytes=-", "bytes=-0"]) assert.equal(parseRange(bad, 100), "bad", bad);
  });
});

describe("video cards", () => {
  let id = "";
  let hash = "";
  test("add copies the file into the package's media folder and names it by its file", async () => {
    const r = await j("POST", "/api/videos" + q(pkg), { path: clip, x: 10, y: 20, w: 600, h: 600, link: "Scr02" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const w = r.body.widget;
    id = w.id;
    hash = w.config.hash;
    assert.equal(w.kind, "video");
    assert.equal(w.name, "teachers-promo");
    assert.equal(w.config.src, "media/teachers-promo.mp4");
    assert.match(hash, /^[0-9a-f]{12}$/);
    assert.deepEqual([w.config.loop, w.config.autoplay, w.config.muted, w.config.posterTime, w.config.link], [true, true, true, 1, "Scr02"]);
    assert.deepEqual(fs.readFileSync(path.join(pkg, "media", "teachers-promo.mp4")), bytes);
    // The same file again reuses the copy; another file with that name gets a numbered name.
    const again = await j("POST", "/api/videos" + q(pkg), { path: clip });
    assert.equal(again.body.widget.config.src, "media/teachers-promo.mp4");
    const other = path.join(dir, "teachers-promo.mp4");
    fs.writeFileSync(other, Buffer.from("different"));
    const third = await j("POST", "/api/videos" + q(pkg), { path: other });
    assert.equal(third.body.widget.config.src, "media/teachers-promo-2.mp4");
    const list = await j("GET", "/api/videos" + q(pkg));
    assert.equal(list.body.videos.length, 3);
    assert.ok(list.body.videos.every((v: any) => v.exists));
    for (const w2 of [again.body.widget, third.body.widget]) await j("DELETE", "/api/widgets/" + w2.id + q(pkg));
  });

  test("stream: whole file, ranges (206), unsatisfiable (416), HEAD", async () => {
    const url = base + "/api/videos/" + id + "/stream" + q(pkg);
    const all = await fetch(url);
    assert.equal(all.status, 200);
    assert.equal(all.headers.get("accept-ranges"), "bytes");
    assert.equal(all.headers.get("content-type"), "video/mp4");
    assert.equal(Buffer.from(await all.arrayBuffer()).length, bytes.length);
    const part = await fetch(url, { headers: { range: "bytes=1000-1999" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 1000-1999/${bytes.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(1000, 2000));
    const tail = await fetch(url, { headers: { range: "bytes=-10" } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(bytes.length - 10));
    const bad = await fetch(url, { headers: { range: `bytes=${bytes.length}-` } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), `bytes */${bytes.length}`);
    await bad.arrayBuffer();
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
  });

  test("stream security: only a video card's own file; no escaping the package; other hosts refused", async () => {
    // A relative src that leaves the package is not served.
    await j("PATCH", "/api/widgets/" + id + q(pkg), { config: { src: "../outside/teachers-promo.mp4" } });
    assert.equal((await fetch(base + "/api/videos/" + id + "/stream" + q(pkg))).status, 404);
    // A non-video file is refused at the widget write.
    const r = await j("PATCH", "/api/widgets/" + id + q(pkg), { config: { src: "/etc/passwd" } });
    assert.equal(r.status, 422);
    await j("PATCH", "/api/widgets/" + id + q(pkg), { config: { src: "media/teachers-promo.mp4" } });
    // Not a video widget.
    const note = await j("POST", "/api/widgets" + q(pkg), { kind: "note" });
    assert.equal((await fetch(base + "/api/videos/" + note.body.widget.id + "/stream" + q(pkg))).status, 404);
    // DNS rebinding: a foreign Host gets nothing.
    const foreign = await new Promise<number>((res, rej) => http.get({ host: "127.0.0.1", port, path: "/api/videos/" + id + "/stream" + q(pkg), headers: { host: "evil.example" } }, (r) => { r.resume(); res(r.statusCode ?? 0); }).on("error", rej));
    assert.equal(foreign, 403);
    // Writes need the header.
    assert.equal((await j("POST", "/api/videos" + q(pkg), { path: clip }, {})).status, 403);
    // Only known types, absolute paths, existing files.
    assert.equal((await j("POST", "/api/videos" + q(pkg), { path: path.join(dir, "demo.canvas.json") })).status, 422);
    assert.equal((await j("POST", "/api/videos" + q(pkg), { path: "relative/clip.mp4" })).status, 422);
    assert.equal((await j("POST", "/api/videos" + q(pkg), { path: path.join(dir, "nope.mp4") })).status, 404);
  });

  test("posters are stored per file hash and poster time, only for the card's file", async () => {
    const p = (h: string, ms: number) => "/api/videos/" + id + "/poster" + q(pkg, `&hash=${h}&ms=${ms}`);
    assert.equal((await fetch(base + p(hash, 1000))).status, 404);
    const put = await fetch(base + p(hash, 1000), { method: "PUT", headers: { "x-canvas": "1", "content-type": "image/png" }, body: PNG });
    assert.equal(put.status, 200);
    assert.ok(fs.existsSync(path.join(pkg, "media", "posters", `${hash}-1000.png`)));
    const got = await fetch(base + p(hash, 1000));
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
    assert.equal((await fetch(base + p("aaaaaaaaaaaa", 1000))).status, 409);
    const notPng = await fetch(base + p(hash, 2000), { method: "PUT", headers: { "x-canvas": "1" }, body: "hello" });
    assert.equal(notPng.status, 400);
  });

  test("replace: a new file is copied in and the hash follows it; link to a plain .canvas.json's sidecar folder", async () => {
    const other = path.join(dir, "outside", "intro.mov");
    fs.writeFileSync(other, Buffer.from("another clip"));
    const r = await j("PUT", "/api/videos/" + id + q(pkg), { path: other, loop: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.widget.config.src, "media/intro.mov");
    assert.equal(r.body.widget.config.loop, false);
    assert.notEqual(r.body.widget.config.hash, hash);
    // Linked, not copied: the absolute path.
    const linked = await j("POST", "/api/videos" + q(docFile), { path: clip, copy: false });
    assert.equal(linked.body.widget.config.src, clip);
    // Copied beside a plain .canvas.json: demo.media/
    const copied = await j("POST", "/api/videos" + q(docFile), { path: clip });
    assert.equal(copied.body.widget.config.src, "demo.media/teachers-promo.mp4");
    assert.ok(fs.existsSync(path.join(dir, "demo.media", "teachers-promo.mp4")));
    assert.equal((await fetch(base + "/api/videos/" + copied.body.widget.id + "/stream" + q(docFile), { headers: { range: "bytes=0-9" } })).status, 206);
  });
});

describe("embed video here", () => {
  const doc = {
    version: "2.21",
    children: [{
      type: "frame", id: "B1", name: "Board", children: [
        { type: "frame", id: "Row", children: [
          { type: "frame", id: "Video", layout: "vertical", children: [
            { type: "frame", id: "Poster", fill: { type: "image", url: "poster.png" }, children: [{ type: "frame", id: "Play" }] },
            { type: "text", id: "Cap", content: "20-second video. File: Desktop/assets/teachers/teachers-promo.mp4" },
          ] },
          { type: "text", id: "Other", content: "No file here" },
        ] },
      ],
    }],
  };
  test("a frame or rectangle takes a video; a caption nearby names the file", () => {
    assert.deepEqual(mediaSlot(doc as any, "Poster"), { media: true, videoHint: "Desktop/assets/teachers/teachers-promo.mp4" });
    assert.deepEqual(mediaSlot(doc as any, "Cap"), { media: false });
    assert.deepEqual(mediaSlot(doc as any, "Inst/Child"), { media: false });
  });
});

describe("video elements kept (stress: every card near the view held a decoder; the engine plays four)", () => {
  test("the largest on screen up to four, plus forced and hovered; off-screen cards none", async () => {
    // @ts-expect-error: a browser module without types
    const { pickVideoElements, VIDEO_ELEMENTS } = await import("../src/page/videos.js");
    assert.equal(VIDEO_ELEMENTS, 4);
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `v${i}`, area: (i + 1) * 1000, forced: false, hovered: false, has: false }));
    items.push({ id: "off", area: 0, forced: false, hovered: false, has: true });
    assert.deepEqual([...pickVideoElements(items)].sort(), ["v4", "v5", "v6", "v7"]);
    items[0].forced = true;
    items[1].hovered = true;
    assert.deepEqual([...pickVideoElements(items)].sort(), ["v0", "v1", "v6", "v7"]);
  });
  test("cards that play on their own come before paused or no-autoplay ones (Codex: four paused cards starved a fifth)", async () => {
    // @ts-expect-error: a browser module without types
    const { pickVideoElements } = await import("../src/page/videos.js");
    const big = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, area: 9000, forced: false, hovered: false, has: true, plays: false }));
    const small = { id: "auto", area: 100, forced: false, hovered: false, has: false, plays: true };
    assert.ok(pickVideoElements([...big, small]).has("auto"));
  });
  test("a card that has an element keeps it against one slightly larger (no trading as the camera moves)", async () => {
    // @ts-expect-error: a browser module without types
    const { pickVideoElements } = await import("../src/page/videos.js");
    const a = { id: "a", area: 1000, forced: false, hovered: false, has: true }, b = { id: "b", area: 1100, forced: false, hovered: false, has: false };
    assert.deepEqual([...pickVideoElements([a, b], 1)], ["a"]);
    assert.deepEqual([...pickVideoElements([a, { ...b, area: 1400 }], 1)], ["b"]);
  });
});

/** A minimal MP4: ftyp, then moov > trak > tkhd with the frame size (version 0), then mdat. */
function fakeMp4(w: number, h: number, extra = 0): Buffer {
  const box = (type: string, body: Buffer) => { const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(b.length, 0); b.write(type, 4, "latin1"); body.copy(b, 8); return b; };
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(w * 65536, 76);
  tkhd.writeUInt32BE(h * 65536, 80);
  const audio = box("trak", box("tkhd", Buffer.alloc(84)));
  return Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("mdat", Buffer.alloc(extra)), box("moov", Buffer.concat([audio, box("trak", box("tkhd", tkhd))]))]);
}

describe("video proxies (WKWebView: 8 cards of a 4K clip took +1.8 GB)", () => {
  test("frame size from the track headers (moov after mdat, audio track ignored); not a movie: null", async () => {
    const f = path.join(dir, "size.mp4");
    fs.writeFileSync(f, fakeMp4(3840, 2160, 5000));
    assert.deepEqual(await videoSize(f), { w: 3840, h: 2160 });
    assert.equal(await videoSize(clip), null);
  });
  test("tiers: the smallest that covers the card within a 25% stretch, the largest beyond", async () => {
    assert.deepEqual(PROXY_TIERS.map((t) => t.px), [640, 960, 1280, 1920]);
    assert.equal(tierFor(300), 640);
    assert.equal(tierFor(800), 640);
    assert.equal(tierFor(801), 960);
    assert.equal(tierFor(5000), 1920);
    // @ts-expect-error: a browser module without types
    const { PROXY_TIERS: pageTiers, proxyTier } = await import("../src/page/videos.js");
    assert.deepEqual(pageTiers, PROXY_TIERS.map((t) => t.px), "the page picks the same tiers");
    for (const px of [1, 640, 800, 801, 1200, 1600, 1601, 2400, 9000]) assert.equal(proxyTier(px), tierFor(px), String(px));
  });
  test("a large file streams a proxy once it is made; a small one, or no avconvert, streams the file", async () => {
    const big = path.join(dir, "outside", "big.mp4");
    fs.writeFileSync(big, fakeMp4(3840, 2160, 1000));
    const made: string[] = [];
    const prev = { ...proxyConfig };
    proxyConfig.enabled = true;
    proxyConfig.convert = async (_src, out, preset) => { made.push(preset); fs.writeFileSync(out, fakeMp4(640, 360, 10)); };
    try {
      const r = await j("POST", "/api/videos" + q(pkg), { path: big });
      assert.equal(r.status, 201);
      const id = r.body.widget.id, h = r.body.widget.config.hash;
      const variant = (px: number) => j("GET", `/api/videos/${id}/variant` + q(pkg, `&px=${px}`));
      // The import already started the smallest tier; wait for it.
      for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, "proxies", `${h}-640.mp4`)); i++) await new Promise((res) => setTimeout(res, 20));
      assert.deepEqual((await variant(600)).body, { v: "640", tier: 640 });
      // A larger card: its tier is made; meanwhile the ready smaller one stands in.
      assert.deepEqual((await variant(1300)).body, { v: "640", tier: 1280 });
      for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, "proxies", `${h}-1280.mp4`)); i++) await new Promise((res) => setTimeout(res, 20));
      assert.deepEqual((await variant(1300)).body, { v: "1280", tier: 1280 });
      assert.deepEqual(made, ["Preset640x480", "Preset1280x720"]);
      // The proxy URL serves the proxy's bytes; without v, the card's own file.
      const proxied = Buffer.from(await (await fetch(base + `/api/videos/${id}/stream` + q(pkg, `&h=${h}&v=640`))).arrayBuffer());
      assert.equal(proxied.length, fakeMp4(640, 360, 10).length);
      const own = Buffer.from(await (await fetch(base + `/api/videos/${id}/stream` + q(pkg, `&h=${h}`))).arrayBuffer());
      assert.equal(own.length, fs.statSync(big).size);
      assert.equal((await fetch(base + `/api/videos/${id}/stream` + q(pkg, `&h=${h}&v=../../x`))).status, 200, "an unknown tier is the file itself");
      assert.equal((await variant(-1)).status, 400);
      // No larger than the card: the file itself. No avconvert: the file itself.
      assert.deepEqual((await variant(5000)).body, { v: "1280", tier: 1920 }, "the largest tier, never the 4K file");
      assert.deepEqual(await variantFor(clip, "abcdefabcdef", 600), { v: "orig", tier: "orig" }, "not a movie we can read: as it is");
      proxyConfig.enabled = false;
      assert.deepEqual((await variant(600)).body, { v: "orig", tier: "orig" });
    } finally {
      Object.assign(proxyConfig, prev);
    }
  });
  test("a proxy that fails is not asked for again: the file itself plays", async () => {
    const odd = path.join(dir, "outside", "odd.mp4");
    fs.writeFileSync(odd, fakeMp4(2000, 1000, 77));
    const prev = { ...proxyConfig };
    proxyConfig.enabled = true;
    let calls = 0;
    proxyConfig.convert = async () => { calls++; throw new Error("cannot export"); };
    try {
      const r = await j("POST", "/api/videos" + q(pkg), { path: odd });
      const id = r.body.widget.id;
      for (let i = 0; i < 50 && calls < 1; i++) await new Promise((res) => setTimeout(res, 20));
      await new Promise((res) => setTimeout(res, 50));
      assert.deepEqual((await j("GET", `/api/videos/${id}/variant` + q(pkg, "&px=600"))).body, { v: "orig", tier: 640 });
      assert.equal(calls, 1);
    } finally {
      Object.assign(proxyConfig, prev);
    }
  });
});
