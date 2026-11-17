// The GPU engine's server inputs: /api/scene (a resolved board tree) and /api/fonts/file (font bytes).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("scene");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_WEB_FONTS = "0"; // no network in tests: Google Fonts is skipped
// A stand-in wasm build, so the /engine/* route is tested without engine/build.sh having run.
const pkgDir = path.join(dir, "pkg");
fs.mkdirSync(pkgDir);
fs.writeFileSync(path.join(pkgDir, "canvas_engine.js"), "export default async function init() {}\n");
fs.writeFileSync(path.join(pkgDir, "canvas_engine_bg.wasm"), Buffer.from("0061736d01000000", "hex"));
fs.writeFileSync(path.join(pkgDir, "secret.txt"), "no");
process.env.CANVAS_ENGINE_PKG = pkgDir;

const ARIAL = "/System/Library/Fonts/Supplemental/Arial.ttf";
fs.copyFileSync(ARIAL, path.join(dir, "mine.ttf"));
fs.writeFileSync(path.join(dir, "pic.png"), Buffer.from("89504e470d0a1a0a", "hex"));

const FIXTURE = {
  version: "2.21",
  themes: { mode: ["light", "dark"] },
  variables: {
    accent: { type: "color", value: [{ value: "#111111", theme: { mode: "light" } }, { value: "#EEEEEE", theme: { mode: "dark" } }] },
    gap: { type: "number", value: 12 },
    face: { type: "string", value: "My Font" },
  },
  fonts: [{ name: "My Font", url: "mine.ttf" }],
  children: [
    {
      type: "frame",
      id: "Btn",
      reusable: true,
      layout: "horizontal",
      padding: [8, 16],
      fill: "$accent",
      children: [{ type: "text", id: "Lbl", content: "Go", fontFamily: "$face", fontSize: 16, fontWeight: "600", fill: "#FFFFFF" }],
    },
    {
      type: "frame",
      id: "B1",
      name: "Board",
      x: 40,
      y: 60,
      width: 390,
      height: 300,
      layout: "vertical",
      gap: "$gap",
      fill: "$accent",
      children: [
        { type: "ref", id: "I1", ref: "Btn", descendants: { Lbl: { content: "Start" } } },
        { type: "frame", id: "Dark", theme: { mode: "dark" }, width: 50, height: 50, fill: "$accent", children: [] },
        { type: "rectangle", id: "Off", enabled: false, width: 10, height: 10 },
        { type: "rectangle", id: "Pic", width: 100, height: 80, fill: [{ type: "image", url: "pic.png", mode: "cover" }, "#FF000080"] },
        { type: "icon", id: "Ic", library: "lucide", icon: "house", width: 24, height: 24, fill: "#333333" },
        { type: "text", id: "T2", content: "Hi", fontFamily: "Arial", fontWeight: "bold", fontStyle: "italic", fill: "#000000" },
        {
          type: "frame",
          id: "AL",
          metadata: { type: "other-tool", note: "kept in the file", canvasLayout: { wrap: true, crossGap: "$gap", gapMode: "evenly", stacking: "first", baseline: "yes", minWidth: 120, maxWidth: "$nope", bogus: 1 } },
          children: [],
        },
        { type: "frame", id: "NoAL", metadata: { type: "canvas", canvasLetterSpacing: "auto" }, children: [] },
        { type: "rectangle", id: "Locked", width: 40, height: 20, metadata: { type: "canvas", canvasLockAspect: true } },
      ],
    },
  ],
};

const docFile = path.join(dir, "scene.canvas.json");
fs.writeFileSync(docFile, JSON.stringify(FIXTURE, null, 2));
const real = fs.realpathSync(docFile);

const { startServer } = await import("../src/server.ts");
const { decodeWoff, decodeWoff2, pickFace, svgShapesOk } = await (async () => {
  const ff = await import("../src/fontfiles.ts");
  const sc = await import("../src/scene.ts");
  return { ...ff, svgShapesOk: sc.svgShapes };
})();
const server = await startServer(0); // a free port of its own: fixed ones clash with other suites
// Synchronous font compression can outlast an idle socket. Use a fresh connection for each request.
server.maxRequestsPerSocket = 1;
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const q = (s: string) => `?file=${encodeURIComponent(real)}${s}`;

after(() => {
  fs.unwatchFile(real);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Node = Record<string, any> & { id: string; type: string; children?: Node[] };
const find = (n: Node, id: string): Node | undefined => (n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean));

describe("/api/scene", () => {
  test("a board comes back resolved: instances expanded, variables and themes applied, disabled nodes gone", async () => {
    const r = await fetch(`${base}/api/scene${q("&id=B1")}`);
    assert.equal(r.status, 200);
    const s = (await r.json()) as { version: number; id: string; x: number; y: number; root: Node; fonts: any[]; images: string[]; key: string };
    assert.equal(s.version, 2);
    assert.deepEqual([s.x, s.y], [40, 60]);
    assert.equal(s.root.fill, "#111111");
    assert.equal(s.root.gap, 12);
    assert.equal(find(s.root, "Dark")?.fill, "#EEEEEE", "a node's theme narrows its subtree");
    assert.equal(find(s.root, "Off"), undefined);
    const lbl = find(s.root, "I1/Lbl");
    assert.equal(lbl?.content, "Start");
    assert.equal(lbl?.fontFamily, "My Font");
    assert.equal(find(s.root, "I1")?.type, "frame");
    assert.equal(find(s.root, "I1")?.reusable, undefined);
    assert.ok(s.key, "carries the board key so callers can tell when it changed");
  });

  test("metadata.canvasLayout reaches the engine resolved and checked; the rest of metadata stays behind", async () => {
    const s = await (await fetch(`${base}/api/scene${q("&id=B1")}`)).json();
    const al = find(s.root, "AL") as Node;
    assert.equal(al.metadata, undefined);
    assert.deepEqual(al.canvasLayout, { wrap: true, crossGap: 12, minWidth: 120, gapMode: "evenly", stacking: "first" }, "variables resolve, wrong types and unknown keys drop");
    assert.ok(s.warnings.some((w: string) => w.includes("AL: unknown variable $nope")));
    const plain = find(s.root, "NoAL") as Node;
    assert.equal("canvasLayout" in plain, false, "no canvasLayout key when the node has none");
    assert.equal(plain.metadata, undefined);
    // Lock aspect ratio reaches the page as lockAspect (its resize handles keep the ratio).
    assert.equal((find(s.root, "Locked") as Node).lockAspect, true);
    assert.equal("lockAspect" in plain, false);
  });

  test("image URLs point at /asset with an absolute path, and are listed", async () => {
    const s = await (await fetch(`${base}/api/scene${q("&id=B1")}`)).json();
    const pic = find(s.root, "Pic") as Node;
    const url = pic.fill[0].url as string;
    assert.ok(url.startsWith("/asset?p="));
    assert.equal(decodeURIComponent(url.slice("/asset?p=".length)), path.join(path.dirname(real), "pic.png"));
    assert.deepEqual(s.images, [url]);
    assert.equal(pic.fill[1], "#FF000080");
    const img = await fetch(`${base}${url}`);
    assert.equal(img.status, 200);
  });

  test("icons arrive as path data with paint", async () => {
    const s = await (await fetch(`${base}/api/scene${q("&id=B1")}`)).json();
    const ic = find(s.root, "Ic") as Node;
    assert.equal(ic.iconMode, "svg");
    assert.equal(ic.iconSize, 24);
    assert.ok(ic.iconShapes.length >= 2);
    assert.deepEqual(
      { fill: ic.iconShapes[0].fill, stroke: ic.iconShapes[0].stroke, w: ic.iconShapes[0].strokeWidth, cap: ic.iconShapes[0].cap },
      { fill: "none", stroke: "current", w: 2, cap: "round" },
    );
  });

  test("every font face the text needs is listed with its URL, plus the system-ui fallback", async () => {
    const s = await (await fetch(`${base}/api/scene${q("&id=B1")}`)).json();
    const keys = s.fonts.map((f: any) => `${f.family}|${f.weight}|${f.style}${f.fallback ? "|fb" : ""}`).sort();
    assert.deepEqual(keys, ["Arial|700|italic", "My Font|600|normal", "system-ui|400|italic|fb", "system-ui|400|normal|fb"]);
    for (const f of s.fonts) assert.ok(f.url.startsWith("/api/fonts/file?family="));
  });

  test("errors: no file, unknown board", async () => {
    assert.equal((await fetch(`${base}/api/scene`)).status, 400);
    assert.equal((await fetch(`${base}/api/scene${q("&id=nope")}`)).status, 404);
  });

  test("svg shapes: circles, rects with radius, lines and polylines become paths", () => {
    const shapes = svgShapesOk(`<g fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><rect x="2" y="2" width="8" height="6" rx="2"/><line x1="0" y1="0" x2="4" y2="4"/><polyline points="1 1 2 2 3 1"/></g><path fill="#FF0000" d="M0 0h4v4z"/>`);
    assert.equal(shapes.length, 5);
    assert.ok(shapes[0].d.startsWith("M2 12A10 10"));
    assert.ok(shapes[1].d.includes("A2 2"));
    assert.equal(shapes[2].d, "M0 0L4 4");
    assert.equal(shapes[3].d, "M1 1L2 2L3 1");
    assert.deepEqual([shapes[4].fill, shapes[4].stroke], ["#FF0000", "none"]);
  });
});

describe("/api/scene/fonts", () => {
  test("every font file the document's boards need, once each, in board order", async () => {
    const r = await fetch(`${base}/api/scene/fonts${q("")}`);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { revision: string; fonts: { family: string; url: string }[] };
    assert.ok(j.revision);
    const one = (await (await fetch(`${base}/api/scene${q("&id=B1")}`)).json()).fonts.map((f: any) => f.url);
    for (const u of one) assert.ok(j.fonts.some((f) => f.url === u), `has ${u}`);
    assert.equal(new Set(j.fonts.map((f) => f.url)).size, j.fonts.length, "no duplicates");
    assert.equal((await fetch(`${base}/api/scene/fonts`)).status, 400);
  });
});

describe("/engine/* (the wasm build the page draws with)", () => {
  test("serves the module and the wasm with their types and an ETag; 304 on a match", async () => {
    const js = await fetch(`${base}/engine/canvas_engine.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    await js.text();
    const wasm = await fetch(`${base}/engine/canvas_engine_bg.wasm`);
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers.get("content-type"), "application/wasm");
    const etag = wasm.headers.get("etag")!;
    assert.ok(etag);
    assert.equal((await wasm.arrayBuffer()).byteLength, 8);
    const again = await fetch(`${base}/engine/canvas_engine_bg.wasm`, { headers: { "if-none-match": etag } });
    assert.equal(again.status, 304);
  });

  test("only the two build files; a missing build is 404 (the page then uses the DOM renderer)", async () => {
    assert.equal((await fetch(`${base}/engine/secret.txt`)).status, 404);
    assert.notEqual((await fetch(`${base}/engine/..%2Fscene.canvas.json`)).status, 200);
    const keep = process.env.CANVAS_ENGINE_PKG;
    process.env.CANVAS_ENGINE_PKG = path.join(dir, "nowhere");
    try {
      assert.equal((await fetch(`${base}/engine/canvas_engine.js`)).status, 404);
    } finally {
      process.env.CANVAS_ENGINE_PKG = keep;
    }
  });
});

describe("/api/fonts/file", () => {
  test("a document font is served from the file's own fonts", async () => {
    const r = await fetch(`${base}/api/fonts/file?family=${encodeURIComponent("My Font")}&weight=600&style=normal&file=${encodeURIComponent(real)}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-font-source"), "document");
    assert.equal(r.headers.get("content-type"), "font/ttf");
    assert.match(r.headers.get("cache-control") ?? "", /max-age=\d+/);
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(Buffer.compare(b, fs.readFileSync(ARIAL)), 0);
  });

  test("an installed font is picked by CSS weight and style matching", async () => {
    const r = await fetch(`${base}/api/fonts/file?family=Arial&weight=700&style=italic`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-font-source"), "installed");
    assert.equal(r.headers.get("x-font-weight"), "700");
    assert.equal(r.headers.get("x-font-style"), "italic");
    assert.equal(Buffer.from(await r.arrayBuffer()).readUInt32BE(0), 0x00010000);
  });

  test("system-ui is the browser's fallback face", async () => {
    const r = await fetch(`${base}/api/fonts/file?family=system-ui&weight=400&style=normal`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-font-source"), "system-ui");
  });

  test("unknown families are a 404, a missing family a 400", async () => {
    assert.equal((await fetch(`${base}/api/fonts/file?family=No%20Such%20Font%20Xyz`)).status, 404);
    assert.equal((await fetch(`${base}/api/fonts/file`)).status, 400);
  });

  test("only font files: a document entry pointing at something else is ignored", async () => {
    const bad = { ...FIXTURE, fonts: [{ name: "Sneaky", url: "scene.canvas.json" }] };
    const p2 = path.join(dir, "bad.canvas.json");
    fs.writeFileSync(p2, JSON.stringify(bad));
    const r = await fetch(`${base}/api/fonts/file?family=Sneaky&file=${encodeURIComponent(fs.realpathSync(p2))}`);
    assert.equal(r.status, 404);
    fs.unwatchFile(fs.realpathSync(p2));
  });
});

// Encoders used only to round-trip the decoders.
function tablesOf(sfnt: Buffer): { tag: string; data: Buffer }[] {
  const n = sfnt.readUInt16BE(4);
  return Array.from({ length: n }, (_, i) => {
    const r = 12 + i * 16;
    const off = sfnt.readUInt32BE(r + 8);
    return { tag: sfnt.toString("latin1", r, r + 4), data: sfnt.subarray(off, off + sfnt.readUInt32BE(r + 12)) };
  });
}

function encodeWoff(sfnt: Buffer): Buffer {
  const ts = tablesOf(sfnt);
  const head = Buffer.alloc(44 + ts.length * 20);
  head.write("wOFF", 0, "latin1");
  head.writeUInt32BE(sfnt.readUInt32BE(0), 4);
  head.writeUInt16BE(ts.length, 12);
  const body: Buffer[] = [];
  let off = head.length;
  ts.forEach((t, i) => {
    const z = zlib.deflateSync(t.data);
    const use = z.length < t.data.length ? z : t.data;
    const r = 44 + i * 20;
    head.write(t.tag, r, "latin1");
    head.writeUInt32BE(off, r + 4);
    head.writeUInt32BE(use.length, r + 8);
    head.writeUInt32BE(t.data.length, r + 12);
    const pad = (4 - (use.length % 4)) % 4;
    body.push(use, Buffer.alloc(pad));
    off += use.length + pad;
  });
  return Buffer.concat([head, ...body]);
}

/** WOFF2 with null transforms only (glyf/loca version 3), which is still a valid WOFF2. */
function encodeWoff2(sfnt: Buffer): Buffer {
  const ts = tablesOf(sfnt);
  const dir: number[] = [];
  const base128 = (v: number) => {
    const out: number[] = [];
    do {
      out.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v);
    return out.map((b, i) => (i < out.length - 1 ? b | 0x80 : b));
  };
  for (const t of ts) {
    const flags = (t.tag === "glyf" || t.tag === "loca" ? 3 << 6 : 0) | 63;
    dir.push(flags, ...Buffer.from(t.tag, "latin1"), ...base128(t.data.length));
  }
  const comp = zlib.brotliCompressSync(Buffer.concat(ts.map((t) => t.data)));
  const head = Buffer.alloc(48);
  head.write("wOF2", 0, "latin1");
  head.writeUInt32BE(sfnt.readUInt32BE(0), 4);
  head.writeUInt16BE(ts.length, 12);
  head.writeUInt32BE(comp.length, 20);
  return Buffer.concat([head, Buffer.from(dir), comp]);
}

describe("font containers", () => {
  const arial = fs.readFileSync(ARIAL);
  const same = (a: Buffer, b: Buffer) => {
    const ta = new Map(tablesOf(a).map((t) => [t.tag, t.data]));
    const tb = tablesOf(b);
    assert.equal(tb.length, ta.size);
    for (const t of tb) assert.equal(Buffer.compare(t.data, ta.get(t.tag) as Buffer), 0, t.tag);
  };
  test("WOFF unpacks to the same tables", () => same(arial, decodeWoff(encodeWoff(arial))));
  test("WOFF2 unpacks to the same tables", () => same(arial, decodeWoff2(encodeWoff2(arial))));
  test("CSS weight matching", () => {
    const faces = [300, 400, 600, 700].map((weight) => ({ weight, italic: false }));
    assert.equal(pickFace(faces, 500, false)?.weight, 400, "500 looks down to 400 before going above 500");
    assert.equal(pickFace(faces, 450, false)?.weight, 400);
    assert.equal(pickFace(faces, 800, false)?.weight, 700);
    assert.equal(pickFace(faces, 200, false)?.weight, 300);
    assert.equal(pickFace([{ weight: 400, wMin: 100, wMax: 900, italic: false }], 650, false)?.weight, 400, "a variable face covers the range");
    assert.equal(pickFace([{ weight: 400, italic: false }, { weight: 400, italic: true }], 400, true)?.italic, true);
  });
});

describe("a text set in Apple Color Emoji (stress: the whole 183 MB face went to the engine, once per weight)", () => {
  test("one small subset of the glyphs used, whatever the weights", { skip: !fs.existsSync("/System/Library/Fonts/Apple Color Emoji.ttc") }, async () => {
    const emo = path.join(dir, "emoji.canvas.json");
    const t = (id: string, w: string) => ({ type: "text", id, content: "👍 🇭🇷 ok", fontFamily: "Apple Color Emoji", fontSize: 20, fontWeight: w, fill: "#000000" });
    fs.writeFileSync(emo, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "E", x: 0, y: 0, width: 300, height: 200, layout: "vertical", children: [t("a", "400"), t("b", "700"), t("c", "300")] }] }));
    const s = await (await fetch(`${base}/api/scene?file=${encodeURIComponent(fs.realpathSync(emo))}&id=E`)).json();
    const emoji = s.fonts.filter((f: any) => f.family === "Apple Color Emoji");
    assert.equal(emoji.length, 1, JSON.stringify(s.fonts.map((f: any) => f.url)));
    assert.match(emoji[0].url, /&text=[0-9a-f,]+$/);
    const bytes = (await (await fetch(base + emoji[0].url)).arrayBuffer()).byteLength;
    assert.ok(bytes > 0 && bytes < 2 * 1024 * 1024, `${bytes} bytes`);
    // "ok" is not an emoji: it falls back like any other missing character
    assert.ok(s.fonts.some((f: any) => f.fallback));
    // Codex: a character neither the emoji face nor SF has (界) still gets its platform fallback
    fs.writeFileSync(emo, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "E", x: 0, y: 0, width: 300, height: 200, layout: "vertical", children: [{ ...t("a", "400"), content: "👍界" }] }] }));
    await new Promise((r) => setTimeout(r, 300));
    const s2 = await (await fetch(`${base}/api/scene?file=${encodeURIComponent(fs.realpathSync(emo))}&id=E`)).json();
    assert.ok(s2.fonts.some((f: any) => f.fallback && /PingFang|Hiragino|CJK/.test(f.family)), JSON.stringify(s2.fonts.map((f: any) => f.family)));
    assert.match(s2.fonts.find((f: any) => f.family === "Apple Color Emoji").url, /&text=1f44d$/);
  });
});
