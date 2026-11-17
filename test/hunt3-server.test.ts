// Regression tests for Codex bug hunt round 3 (.planning/research/codex-hunt-3.md), the findings that need the
// server: new boards keep their page, concurrent Paper edits, concurrent video imports, proxies of a replaced
// linked file, answers held when the crash journal fails, scale (token positions, replacement instances, one
// known side), and page-script guards that only a browser runs (checked in the script's source).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import http from "node:http";
import { freePort, tmpDir } from "./helpers.ts";

const dir = tmpDir("hunt3");
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_STATE_DIR = path.join(dir, "state-home");
const pw = await import("../src/docwriter.ts");
const { copyIn, proxyConfig, variantFor } = await import("../src/videos.ts");
const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
proxyConfig.dir = path.join(dir, "proxies");

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const make = (name: string, doc: unknown) => {
  const p = path.join(dir, `${name}.canvas.json`);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  return fs.realpathSync(p);
};
const q = (file: string, extra = "") => `?file=${encodeURIComponent(file)}${extra}`;
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
const disk = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const nodeIn = (doc: any, id: string): any => {
  const seek = (ns: any[]): any => { for (const n of ns ?? []) { if (n.id === id) return n; const h = seek(n.children); if (h) return h; } };
  return seek(doc.children);
};
const boards = (n: number) => ({ version: "2.21", children: Array.from({ length: n }, (_, i) => ({ type: "frame", id: `B${i}`, name: `B${i}`, x: i * 500, y: 0, width: 400, height: 300, layout: "none", children: [{ type: "rectangle", id: `R${i}`, x: 10, y: 10, width: 40, height: 40 }] })) });
const pageOf = async (file: string, id: string) => ((await call("GET", `/api/pages${q(file)}`)).body.pages as any[]).find((p) => p.boards.includes(id))?.id;

describe("codex hunt 3: server", () => {
  test("b2 a board duplicated, grouped or pasted on page 2 stays on page 2", async () => {
    const file = make("pages", boards(3));
    await call("GET", `/api/doc${q(file)}`);
    assert.equal((await call("PUT", `/api/pages${q(file)}`, { pages: [{ id: "p1", name: "One", boards: ["B0"] }, { id: "p2", name: "Two", boards: ["B1", "B2"] }] })).status, 200);
    const dup = await call("POST", "/api/structure", { file, op: "duplicate", ids: ["B1"], page: "p2" });
    assert.equal(dup.status, 200);
    assert.equal(await pageOf(file, dup.body.select[0]), "p2", "the copy is on its original's page");
    const grp = await call("POST", "/api/structure", { file, op: "group", ids: ["B1", "B2"], page: "p2" });
    assert.equal(await pageOf(file, grp.body.select[0]), "p2", "a group of page-2 boards");
    const copy = await call("POST", "/api/structure", { file, op: "copy", ids: ["B0"] });
    const paste = await call("POST", "/api/structure", { file, op: "paste", payload: copy.body.payload, place: { parent: null }, page: "p2" });
    assert.equal(await pageOf(file, paste.body.select[0]), "p2", "pasted while page 2 shows");
    // A file without pages stays without them.
    const plain = make("nopages", boards(1));
    await call("GET", `/api/doc${q(plain)}`);
    await call("POST", "/api/structure", { file: plain, op: "duplicate", ids: ["B0"], page: "p2" });
    assert.equal((await call("GET", `/api/pages${q(plain)}`)).body.implicit, true);
  });

  test("c3 two Paper param changes at once both land", async () => {
    const file = make("paper", boards(1));
    const made = await call("POST", `/api/shaders${q(file)}`, { preset: "mesh-gradient", x: 0, y: 0, w: 400, h: 300 });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.widget.id;
    const [a, b] = await Promise.all([call("PUT", `/api/shaders/${id}${q(file)}`, { params: { distortion: 0.2 } }), call("PUT", `/api/shaders/${id}${q(file)}`, { params: { swirl: 0.7 } })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const w = (await call("GET", `/api/widgets/${id}${q(file)}`)).body.widget ?? (await call("GET", `/api/widgets/${id}${q(file)}`)).body;
    const params = w.config.paper.params;
    assert.equal(params.distortion, 0.2);
    assert.equal(params.swirl, 0.7);
  });

  test("c2 two clips with one name imported at once get two files", async () => {
    const docFile = make("clips", boards(1));
    fs.mkdirSync(path.join(dir, "a"));
    fs.mkdirSync(path.join(dir, "b"));
    fs.writeFileSync(path.join(dir, "a", "clip.mp4"), Buffer.alloc(200_000, 1));
    fs.writeFileSync(path.join(dir, "b", "clip.mp4"), Buffer.alloc(200_000, 2));
    const [x, y] = await Promise.all([copyIn(docFile, path.join(dir, "a", "clip.mp4")), copyIn(docFile, path.join(dir, "b", "clip.mp4"))]);
    assert.notEqual(x.dest, y.dest);
    assert.equal(fs.readFileSync(x.dest)[0], 1);
    assert.equal(fs.readFileSync(y.dest)[0], 2);
    assert.deepEqual(fs.readdirSync(path.dirname(x.dest)).filter((f) => f.endsWith(".tmp")), [], "no temp files left");
    // The same clip again: reused, not a third file.
    assert.equal((await copyIn(docFile, path.join(dir, "a", "clip.mp4"))).dest, x.dest);
  });

  test("c7 a linked file replaced at its path does not keep playing the old clip's proxy", async () => {
    const box = (type: string, body: Buffer) => { const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(b.length, 0); b.write(type, 4, "latin1"); body.copy(b, 8); return b; };
    const mp4 = (w: number, h: number, fill: number) => { const t = Buffer.alloc(84); t.writeUInt32BE(w * 65536, 76); t.writeUInt32BE(h * 65536, 80); return Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("mdat", Buffer.alloc(100, fill)), box("moov", box("trak", box("tkhd", t)))]); };
    const src = path.join(dir, "linked.mp4");
    fs.writeFileSync(src, mp4(3840, 2160, 1));
    const prev = { ...proxyConfig };
    let made = 0;
    proxyConfig.enabled = true;
    proxyConfig.convert = async (_s, out) => { made++; fs.writeFileSync(out, mp4(640, 360, 9)); };
    try {
      const hash = "aaaaaaaaaaaa";
      await variantFor(src, hash, 600);
      for (let i = 0; i < 50 && made < 1; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(await variantFor(src, hash, 600), { v: "640", tier: 640 });
      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(src + ".new", mp4(3840, 2160, 2));
      fs.renameSync(src + ".new", src); // another clip at the same path
      assert.deepEqual(await variantFor(src, hash, 600), { v: null, tier: 640 }, "the old proxy no longer counts");
      for (let i = 0; i < 50 && made < 2; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(made, 2, "made again from the new file");
    } finally {
      Object.assign(proxyConfig, prev);
    }
  });

  test("c1 with no durable journal an edit is answered only once the document itself is on disk", async () => {
    const file = make("nojournal", boards(2));
    await call("GET", `/api/doc${q(file)}`);
    const d = pw.writeConfig.debounceMs, m = pw.writeConfig.maxDelayMs, sb = pw.writeConfig.syncBytes;
    pw.writeConfig.syncBytes = 0; // no synchronous save of a small file: the background writer only
    pw.writeConfig.debounceMs = 60_000;
    pw.writeConfig.maxDelayMs = 60_000;
    const open0 = fs.openSync;
    (fs as any).openSync = (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).includes(".canvas-journal-")) throw Object.assign(new Error("EIO: i/o error, open"), { code: "EIO" });
      return (open0 as any)(p, ...rest);
    };
    try {
      const r = await call("POST", "/api/update", { file, id: "R0", props: { fill: "#123456" } });
      assert.equal(r.status, 200);
      assert.equal(nodeIn(disk(file), "R0").fill, "#123456", "on disk before the answer, not 60 s later");
    } finally {
      (fs as any).openSync = open0;
      pw.writeConfig.debounceMs = d;
      pw.writeConfig.maxDelayMs = m;
      pw.writeConfig.syncBytes = sb;
    }
    await pw.flushWrites(file);
  });

  test("d1 d5 scale keeps a token-bound position and needs only the side it scales to", async () => {
    const file = make("scale", {
      version: "2.21",
      variables: { bx: { type: "number", value: 50 } },
      children: [
        { type: "frame", id: "Tok", x: "$bx", y: 10, width: 100, height: 100, layout: "none", children: [] },
        { type: "frame", id: "Host", x: 400, y: 0, width: 400, height: 400, layout: "none", children: [
          { type: "text", id: "Txt", x: 10, y: 10, width: 100, content: "Hi", fontFamily: "Helvetica", fontSize: 10, textGrowth: "fixed-width" },
        ] },
      ],
    });
    const r = await call("POST", "/api/scale", { file, ids: ["Tok"], factor: 2, anchor: "center" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "Tok").x, "$bx", "the token stays");
    assert.ok(r.body.kept >= 1, "and is reported as kept");
    const w = await call("POST", "/api/scale", { file, ids: ["Txt"], width: 200 });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.body.factor, 2);
    await pw.flushWrites(file);
    assert.equal(nodeIn(disk(file), "Txt").fontSize, 20);
  });

  test("d2 scaling an instance scales the contents of a replacement instance inside it", async () => {
    const file = make("rep", {
      version: "2.21",
      children: [
        { type: "frame", id: "Lbl", reusable: true, x: 0, y: 0, width: 50, height: 20, layout: "none", children: [{ type: "text", id: "LTxt", x: 0, y: 0, content: "L", fontFamily: "Helvetica", fontSize: 10 }] },
        { type: "frame", id: "Card", reusable: true, x: 100, y: 0, width: 100, height: 60, layout: "none", children: [{ type: "frame", id: "Slot", x: 0, y: 0, width: 50, height: 20, children: [] }] },
        { type: "frame", id: "Board", x: 300, y: 0, width: 400, height: 300, layout: "none", children: [
          { type: "ref", id: "Outer", ref: "Card", x: 10, y: 10, descendants: { Slot: { type: "ref", id: "Rep", ref: "Lbl" } } },
        ] },
      ],
    });
    const r = await call("POST", "/api/scale", { file, ids: ["Outer"], factor: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await pw.flushWrites(file);
    const rep = nodeIn(disk(file), "Outer").descendants.Slot;
    assert.equal(rep.width, 100, "the replacement's box");
    assert.equal(rep.descendants?.LTxt?.fontSize, 20, "and the text inside it");
  });
});

describe("burst tail: page broadcasts coalesce", () => {
  test("30 edits at once reach an open page as a few diffs that still end on the newest revision", async () => {
    const { applyDocDiff } = await import("../src/docdiff.ts");
    const file = make("burst", boards(30));
    await call("GET", `/api/doc${q(file)}`);
    const events: { ev: string; data: any }[] = [];
    const req = http.get(`${base}/events${q(file)}`, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => {
        buf += d;
        let at: number;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev === "doc" || ev === "docdiff") events.push({ ev, data: JSON.parse(data!) });
        }
      });
    });
    try {
      for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 20));
      const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => call("POST", "/api/update", { file, id: `B${i}`, props: { name: `n${i}` } })));
      assert.ok(rs.every((r) => r.status === 200));
      const last = rs.map((r) => r.body.revision);
      const final = (await call("GET", `/api/doc${q(file)}`)).body.revision;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (events.at(-1)?.data.revision === final) break;
      }
      const changes = events.slice(1);
      assert.ok(changes.length >= 1 && changes.length <= 8, `${changes.length} events for 30 edits`);
      let doc: any = events[0].data;
      const trail: string[] = [`doc ${doc.revision}`];
      for (const e of changes) { trail.push(`${e.ev} ${e.data.base ?? ""}->${e.data.revision}`); doc = e.ev === "doc" ? e.data : applyDocDiff(doc, e.data); if (!doc) break; }
      if (!doc) console.error(trail.join("\n"));
      assert.ok(doc, "every diff applies to what the page had");
      assert.equal(doc.revision, final);
      assert.ok(last.includes(final));
      assert.deepEqual(doc.boards.map((b: any) => b.name), Array.from({ length: 30 }, (_, i) => `n${i}`));
    } finally {
      req.destroy();
    }
  });
});

describe("codex hunt 3: swift (server half)", () => {
  test("e6 a node's tokens resolve in its own theme, so Detach writes what the canvas draws", async () => {
    const file = make("themes", {
      version: "2.21",
      themes: { mode: ["light", "dark"] },
      variables: { ink: { type: "color", value: [{ value: "#000000", theme: { mode: "light" } }, { value: "#FFFFFF", theme: { mode: "dark" } }] }, alias: { type: "color", value: "$ink" } },
      children: [
        { type: "frame", id: "Dark", theme: { mode: "dark" }, x: 0, y: 0, width: 200, height: 200, children: [{ type: "rectangle", id: "In", width: 10, height: 10, fill: "$ink", stroke: "$alias" }] },
        { type: "frame", id: "Light", x: 300, y: 0, width: 200, height: 200, children: [{ type: "rectangle", id: "Out", width: 10, height: 10, fill: "$ink" }] },
      ],
    });
    const n = (id: string) => call("GET", `/api/node${q(file, `&id=${id}`)}`);
    assert.deepEqual((await n("In")).body.tokens, { ink: "#FFFFFF", alias: "#FFFFFF" });
    assert.deepEqual((await n("Out")).body.tokens, { ink: "#000000" });
    const page = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    assert.match(page, /ctx: n\.context \|\| null, tokens: n\.tokens \|\| null \} \}\);/, "the page hands them to the app");
  });
});

describe("codex hunt 3: mcp", () => {
  test("d3 a card placed next to a node on page 2 lands on page 2", async () => {
    const file = make("mcppages", boards(2));
    await call("GET", `/api/doc${q(file)}`);
    await call("PUT", `/api/pages${q(file)}`, { pages: [{ id: "p1", name: "One", boards: ["B0"] }, { id: "p2", name: "Two", boards: ["B1"] }] });
    const port0 = process.env.CANVAS_PORT;
    process.env.CANVAS_PORT = String((server.address() as { port: number }).port);
    try {
      const { pageOfNode } = await import("../mcp/tools/pageof.ts");
      assert.equal(await pageOfNode(file, "B1"), "p2", "a board");
      assert.equal(await pageOfNode(file, "R1"), "p2", "a layer inside it");
      assert.equal(await pageOfNode(file, "R0"), undefined, "the first page: no page needed");
      assert.equal(await pageOfNode(file, "nope"), undefined);
    } finally {
      if (port0 === undefined) delete process.env.CANVAS_PORT;
      else process.env.CANVAS_PORT = port0;
    }
  });

  test("d4 restartStale never reports a replacement while the old server still answers", { timeout: 20_000 }, async () => {
    const port = await freePort();
    const old = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/health" ? { ok: true, version: "old" } : { ok: true }));
    });
    await new Promise<void>((r) => old.listen(port, "127.0.0.1", r));
    const env0 = { ...process.env };
    Object.assign(process.env, { CANVAS_PORT: String(port), CANVAS_MCP_WANT_VERSION: "new", CANVAS_MCP_NO_APP: "1", CANVAS_MCP_NO_SPAWN: "1" });
    try {
      const { launchCanvas } = await import("../mcp/launch.ts");
      await assert.rejects(launchCanvas({ mode: "server", restartStale: true }), (e: any) => e.code === "stale_busy");
    } finally {
      for (const k of ["CANVAS_PORT", "CANVAS_MCP_WANT_VERSION", "CANVAS_MCP_NO_APP", "CANVAS_MCP_NO_SPAWN"]) {
        if (env0[k] === undefined) delete process.env[k];
        else process.env[k] = env0[k];
      }
      old.closeAllConnections();
      await new Promise<void>((r) => old.close(() => r()));
    }
  });
});

describe("codex hunt 3: page script guards (source)", () => {
  const page = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const read = (f: string) => fs.readFileSync(new URL(`../src/page/${f}`, import.meta.url), "utf8");
  test("b1 a group nudge burst moves the layers it started with, not a selection made meanwhile", () => {
    const flush = page.slice(page.indexOf("function flushGroupNudge(g)"), page.indexOf("function flushNudge(id)"));
    assert.match(flush, /const items = g\.items;/);
    assert.doesNotMatch(flush, /groupItems\(\)/);
  });
  test("b4 a document recovery fetch that a newer document overtook is dropped", () => {
    assert.match(page, /const g = \+\+docGen;\s*fetch\(api\("\/api\/doc"\)\)[^\n]*if \(g === docGen\) onDoc\(full\)/);
    assert.match(page, /es\.addEventListener\("doc", \(e\) => \{ docGen\+\+;/);
  });
  test("b3 a shader source fetched for a removed card never reaches the engine", () => {
    const s = read("shaders.js");
    assert.match(s, /const live = \(\) => seq === c\.seq && cards\.get\(c\.id\) === c;/);
    assert.doesNotMatch(s, /seq !== c\.seq/);
    assert.match(s, /if \(!ids\.has\(id\)\) \{ c\.seq\+\+;/);
  });
  test("d6 select_nodes reveal:false never fits a board", () => {
    const s = read("bridge.js");
    assert.match(s, /if \(!move\) return false;\s*const b = boards && boards\[id\];[\s\S]{0,80}await host\.fit\(b\)/);
    assert.equal((s.match(/ensureLoaded\([^)]*a\.reveal !== false\)/g) ?? []).length, 2);
  });
});
