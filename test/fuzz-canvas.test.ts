// Release checklist (docs/qa-plan.md section 8): malformed and hostile .canvas packages never crash the server or
// make it write outside the package. Every case is built from a seed, so a failure replays exactly:
//
//   node --test test/fuzz-canvas.test.ts                       the fixed hostile cases and FUZZ_N (default 24) random ones
//   FUZZ_N=500 node --test test/fuzz-canvas.test.ts            more
//   FUZZ_SEED=1234 FUZZ_N=1 node --test test/fuzz-canvas.test.ts   one random case again (the seed a failure printed)
//
// Each package is opened through the server's API (document, pages, widgets, a board's scene, an edit, a flush) on
// a scratch server. Each request must answer (any status, never a hang), the server must stay up, and nothing
// outside the package may change.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type Scratch } from "../qa/lib.ts";

const N = Number(process.env.FUZZ_N ?? 24);
const SEED = Number(process.env.FUZZ_SEED ?? 20261116);
const BIG = 50 * 1024 * 1024;

/** mulberry32: small, fast, and the same sequence for a seed everywhere. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
  return { next, int, pick };
}
type R = ReturnType<typeof rng>;

// ---------------------------------------------------------------- generators

const NODE_TYPES = ["frame", "group", "rectangle", "ellipse", "text", "ref", "path", "line", "polygon", "icon_font", "note", "image", "nonsense", 7, null] as const;
const WEIRD: unknown[] = [null, true, -1, 0, 1e308, -1e308, 1e21, 2 ** 53 + 1, -0, 0.000001, "", "NaN", "Infinity", "1e400", "../../etc/passwd", "/etc/passwd", "~/.ssh/id_rsa", "\u0000", "\ud800", "<script>alert(1)</script>", "$--x", [], {}, [1, [2, [3]]], { $ref: "#" }];
const KEYS = ["x", "y", "width", "height", "rotation", "opacity", "fill", "stroke", "effect", "layout", "gap", "padding", "cornerRadius", "content", "fontSize", "fontFamily", "lineHeight", "letterSpacing", "ref", "descendants", "children", "reusable", "enabled", "clip", "theme", "metadata", "url", "image", "name", "id", "type"];

function value(r: R, depth = 0): unknown {
  const k = r.int(depth > 2 ? 4 : 8);
  if (k === 0) return r.pick(WEIRD);
  if (k === 1) return r.next() * 2000 - 1000;
  if (k === 2) return r.pick(["#ff0000", "#zzz", "#12345678", "rgba(1,2,3)", "var(--x)", "$color.primary", "fill_container", "fit_content(10)", "fit_content", ""]);
  if (k === 3) return r.int(3) ? r.int(1000) : -r.int(1e9);
  if (k === 4) return Array.from({ length: r.int(4) }, () => value(r, depth + 1));
  if (k === 5) return Object.fromEntries(Array.from({ length: r.int(4) }, () => [r.pick(KEYS), value(r, depth + 1)]));
  if (k === 6) return { type: r.pick(["color", "image", "gradient", "shadow", "blur", "mesh", "weird"]), color: value(r, depth + 1), url: r.pick(["../../../etc/hosts", "/etc/hosts", "a.png", "http://127.0.0.1:1/x.png", "data:image/png;base64,xx"]) };
  return String(value(r, depth + 1));
}

function node(r: R, ids: string[], depth: number): Record<string, unknown> {
  const id = r.int(10) === 0 && ids.length ? r.pick(ids) : r.int(12) === 0 ? r.pick(["../../evil", "/abs/id", "a/b", "", "widget:x", "__proto__", "constructor"]) : `n${ids.length}`;
  ids.push(id);
  const n: Record<string, unknown> = { type: r.pick(NODE_TYPES), id, name: r.int(5) ? `Layer ${ids.length}` : value(r) };
  for (let i = r.int(6); i > 0; i--) n[r.pick(KEYS)] = value(r);
  if (n.type === "ref" || r.int(8) === 0) n.ref = r.int(2) && ids.length ? r.pick(ids) : id; // often itself or an ancestor: a cycle
  if (depth < 6 && r.int(3) === 0) n.children = Array.from({ length: r.int(4) }, () => node(r, ids, depth + 1));
  else if (r.int(15) === 0) n.children = value(r);
  return n;
}

function randomDoc(r: R): unknown {
  const ids: string[] = [];
  const doc: Record<string, unknown> = { version: r.pick(["2.21", "1.0", "", 3, null, "99.9"]), children: Array.from({ length: 1 + r.int(5) }, () => node(r, ids, 0)) };
  if (r.int(3) === 0) doc.variables = Object.fromEntries(Array.from({ length: r.int(4) }, (_, i) => [`v${i}`, r.int(2) ? { type: r.pick(["color", "number", "string", "x"]), value: value(r) } : value(r)]));
  if (r.int(4) === 0) doc.themes = value(r);
  if (r.int(6) === 0) doc.children = value(r);
  return doc;
}

function randomWidgets(r: R): unknown {
  const kinds = ["note", "todo", "shader", "video", "posthog", "unknown", 5];
  const w = () => ({
    id: r.int(6) ? `w${r.int(1000)}` : r.pick(["../../evil", "/abs", "a/b", "", "x".repeat(300)]),
    kind: r.pick(kinds), x: value(r), y: value(r), w: value(r), h: value(r),
    config: r.int(2) ? { src: r.pick(["../../../../etc/hosts", "/etc/hosts", "media/a.mp4", ""]), rev: r.pick(["abc", "../x", ""]), source: value(r) } : value(r),
  });
  const env: Record<string, unknown> = { version: r.pick([1, 2, "1", null]), widgets: r.int(8) ? Array.from({ length: r.int(5) }, w) : value(r) };
  if (r.int(2)) env.pages = r.int(5) ? Array.from({ length: r.int(4) }, (_, i) => ({ id: r.int(5) ? `p${i}` : value(r), name: value(r), boards: value(r) })) : value(r);
  return env;
}

/** Text that is JSON, cut short or broken in some way. */
function mangle(r: R, text: string): string {
  switch (r.int(6)) {
    case 0: return text.slice(0, r.int(text.length));
    case 1: return "﻿" + text;
    case 2: { const i = r.int(text.length); return text.slice(0, i) + r.pick(["}", "]", "\"", ",", "\u0000", "\\", "{{{"]) + text.slice(i); }
    case 3: return Buffer.from(Array.from({ length: 200 }, () => r.int(256))).toString("latin1");
    default: return text;
  }
}

type Case = { name: string; build(pkg: string, outside: string): void };

/** A frame in a frame in a frame, `depth` deep, as JSON text (JSON.stringify itself gives up on a tree this deep). */
const deep = (depth: number, inner: unknown) => {
  let open = "", close = "";
  for (let i = 0; i < depth; i++) {
    open += `{"type":"frame","id":"d${i}","width":10,"height":10,"children":[`;
    close += "]}";
  }
  return `{"version":"2.21","children":[${open}${JSON.stringify(inner)}${close}]}`;
};
const write = (pkg: string, name: string, v: unknown) => fs.writeFileSync(path.join(pkg, name), typeof v === "string" ? v : JSON.stringify(v));
const okDoc = { version: "2.21", children: [{ type: "frame", id: "B1", name: "Board", x: 0, y: 0, width: 100, height: 100, children: [{ type: "rectangle", id: "R1", name: "Rect", width: 10, height: 10 }] }] };

const FIXED: Case[] = [
  { name: "missing document.json", build: () => {} },
  { name: "empty document.json", build: (p) => write(p, "document.json", "") },
  { name: "document.json is a folder", build: (p) => fs.mkdirSync(path.join(p, "document.json")) },
  { name: "truncated JSON", build: (p) => write(p, "document.json", JSON.stringify(okDoc).slice(0, 40)) },
  { name: "top level is an array", build: (p) => write(p, "document.json", "[1,2,3]") },
  { name: "top level is a number", build: (p) => write(p, "document.json", "42") },
  { name: "children is a string", build: (p) => write(p, "document.json", { version: "2.21", children: "x" }) },
  { name: "children holds numbers, nulls and arrays", build: (p) => write(p, "document.json", { version: "2.21", children: [1, null, [], "x", { id: 5 }] }) },
  { name: "huge and infinite numbers", build: (p) => write(p, "document.json", `{"version":"2.21","children":[{"type":"frame","id":"B1","x":1e309,"y":-1e309,"width":1e308,"height":1e21,"rotation":1e300,"children":[{"type":"text","id":"T","content":"x","fontSize":1e308,"letterSpacing":-1e308}]}]}`) },
  { name: "deep nesting (3,000 frames)", build: (p) => write(p, "document.json", deep(3000, { type: "rectangle", id: "leaf" })) },
  { name: "deep nesting (50,000 frames)", build: (p) => write(p, "document.json", deep(50_000, { type: "rectangle", id: "leaf" })) },
  { name: "deep nesting (100,000 arrays)", build: (p) => write(p, "document.json", `{"version":"2.21","children":[{"type":"frame","id":"B1","fill":${"[".repeat(100_000)}${"]".repeat(100_000)}}]}`) },
  { name: "a ref to itself", build: (p) => write(p, "document.json", { version: "2.21", children: [{ type: "frame", id: "C", reusable: true, children: [{ type: "ref", id: "I", ref: "C" }] }, { type: "ref", id: "S", ref: "S" }] }) },
  { name: "refs in a ring", build: (p) => write(p, "document.json", { version: "2.21", children: [{ type: "frame", id: "A", reusable: true, children: [{ type: "ref", id: "a1", ref: "B" }] }, { type: "frame", id: "B", reusable: true, children: [{ type: "ref", id: "b1", ref: "A" }] }, { type: "ref", id: "top", ref: "A" }] }) },
  { name: "duplicate ids everywhere", build: (p) => write(p, "document.json", { version: "2.21", children: [{ type: "frame", id: "D", children: [{ type: "frame", id: "D", children: [{ type: "rectangle", id: "D" }] }] }, { type: "frame", id: "D" }] }) },
  { name: "ids that look like paths", build: (p) => write(p, "document.json", { version: "2.21", children: [{ type: "frame", id: "../../../../tmp/evil", name: "../x", children: [{ type: "rectangle", id: "/etc/passwd" }, { type: "rectangle", id: "__proto__" }] }] }) },
  { name: "wrong types on every property", build: (p) => write(p, "document.json", { version: 3, children: [{ type: 5, id: {}, name: [], x: "a", y: null, width: {}, height: [], fill: 7, stroke: "x", effect: "y", layout: 9, children: [{ type: "text", id: "t", content: { a: 1 }, fontSize: "big" }] }] }) },
  { name: "a 50 MB string", build: (p) => fs.writeFileSync(path.join(p, "document.json"), `{"version":"2.21","children":[{"type":"frame","id":"B1","x":0,"y":0,"width":100,"height":100,"children":[{"type":"text","id":"T","content":"${"x".repeat(BIG)}"}]}]}`) },
  { name: "image fills pointing out of the package", build: (p) => write(p, "document.json", { version: "2.21", children: [{ type: "frame", id: "B1", width: 10, height: 10, fill: { type: "image", url: "../../../../../etc/hosts" }, children: [{ type: "rectangle", id: "R", fill: { type: "image", url: "/etc/passwd" } }] }] }) },
  { name: "document.json is a symlink out", build: (p, out) => { write(out, "victim.json", okDoc); fs.symlinkSync(path.join(out, "victim.json"), path.join(p, "document.json")); } },
  { name: "document.json is a dangling symlink out", build: (p, out) => fs.symlinkSync(path.join(out, "made-by-canvas.json"), path.join(p, "document.json")) },
  { name: "widgets.json is a symlink out", build: (p, out) => { write(p, "document.json", okDoc); write(out, "victim-widgets.json", { version: 1, widgets: [] }); fs.symlinkSync(path.join(out, "victim-widgets.json"), path.join(p, "widgets.json")); } },
  { name: "shaders/ and media/ are symlinks out", build: (p, out) => { write(p, "document.json", okDoc); fs.symlinkSync(out, path.join(p, "shaders")); fs.symlinkSync(out, path.join(p, "media")); write(p, "widgets.json", { version: 1, widgets: [{ id: "sh1", kind: "shader", x: 0, y: 0, w: 10, h: 10, config: { rev: "abc" } }, { id: "v1", kind: "video", x: 0, y: 0, w: 10, h: 10, config: { src: "media/x.mp4" } }] }); } },
  { name: "widgets with ../ ids and sources", build: (p) => { write(p, "document.json", okDoc); write(p, "widgets.json", { version: 1, widgets: [{ id: "../../evil", kind: "shader", config: { rev: "../../x" } }, { id: "v", kind: "video", config: { src: "../../../../etc/hosts" } }, { id: "/abs", kind: "note", config: {} }] }); } },
  { name: "widgets.json is garbage", build: (p) => { write(p, "document.json", okDoc); write(p, "widgets.json", "\u0000\u0001not json{{{"); } },
  { name: "a stale journal of garbage beside the document", build: (p) => { write(p, "document.json", okDoc); write(p, ".document.json.canvas-journal-1-abc", "garbage\n{\"ops\":7}\n"); } },
];

// ---------------------------------------------------------------- the run

let dir: string;
let srv: Scratch;
before(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-fuzz-")));
  srv = await startServer(dir);
});
after(async () => {
  await srv?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every entry (bytes, or a link's target) under a folder. */
function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out.set(path.relative(root, p), `link:${fs.readlinkSync(p)}`);
      else if (e.isDirectory()) walk(p);
      else out.set(path.relative(root, p), `${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`);
    }
  };
  walk(root);
  return out;
}

async function call(method: string, p: string, body?: unknown): Promise<number> {
  const r = await fetch(`${srv.base}${p}`, { method, headers: method === "GET" ? {} : { "x-canvas": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  await r.arrayBuffer();
  return r.status;
}

let k = 0;
async function open(c: Case): Promise<void> {
  const box = path.join(dir, `case-${++k}`);
  const out = path.join(box, "outside");
  const pkg = path.join(box, "Fuzz.canvas");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(pkg);
  write(out, "sentinel.txt", "untouched");
  c.build(pkg, out);
  const before = tree(out);
  const q = `file=${encodeURIComponent(pkg)}`;
  const statuses: Record<string, number> = {};
  let first = "B1";
  try {
    const raw = fs.readFileSync(path.join(pkg, "document.json"), "utf8");
    if (raw.length < 1e6) first = String((JSON.parse(raw) as { children?: { id?: unknown }[] }).children?.[0]?.id ?? "B1");
  } catch {}
  for (const [what, method, p, body] of [
    ["doc", "GET", `/api/doc?${q}`],
    ["pages", "GET", `/api/pages?${q}`],
    ["widgets", "GET", `/api/widgets?${q}`],
    ["scene", "GET", `/api/scene?${q}&id=${encodeURIComponent(first)}`],
    ["board", "GET", `/api/board?${q}&id=${encodeURIComponent(first)}`],
    ["search", "GET", `/api/search?${q}&q=a`],
    ["update", "POST", "/api/update", { file: pkg, id: first, props: { name: "fuzzed", x: 1 } }],
    ["structure", "POST", "/api/structure", { file: pkg, op: "duplicate", ids: [first] }],
    ["page", "POST", `/api/pages?${q}`, { name: "Fuzz page" }],
    ["undo", "POST", `/api/history/undo?${q}`, {}],
    ["flush", "POST", "/api/flush", { file: pkg }],
  ] as [string, string, string, unknown?][]) {
    statuses[what] = await call(method, p, body);
    assert.ok(statuses[what] >= 200 && statuses[what] < 600, `${what}: ${statuses[what]}`);
    assert.equal(srv.proc.exitCode, null, `the server died on ${what}: ${srv.log.join("").slice(-2000)}`);
  }
  assert.equal(await call("GET", "/health"), 200, "the server still answers");
  assert.deepEqual(tree(out), before, "nothing outside the package changed");
  assert.deepEqual(fs.readdirSync(box).sort(), ["Fuzz.canvas", "outside"], "nothing appeared beside the package");
  fs.rmSync(box, { recursive: true, force: true });
}

describe("hostile .canvas packages", () => {
  for (const c of FIXED) test(c.name, { timeout: 120_000 }, () => open(c));
});

describe(`random .canvas packages (seed ${SEED}, ${N} cases)`, () => {
  for (let i = 0; i < N; i++) {
    const seed = SEED + i;
    test(`seed ${seed}`, { timeout: 120_000 }, () => {
      const r = rng(seed);
      return open({
        name: `seed ${seed}`,
        build: (pkg) => {
          const shape = r.int(10);
          if (shape === 0) return; // no design at all
          const text = JSON.stringify(randomDoc(r), null, r.int(2) ? 2 : undefined);
          write(pkg, "document.json", r.int(4) === 0 ? mangle(r, text) : text);
          if (r.int(2)) write(pkg, "widgets.json", r.int(5) === 0 ? mangle(r, JSON.stringify(randomWidgets(r))) : randomWidgets(r));
        },
      });
    });
  }
});
