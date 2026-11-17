// pnpm bench: the speed suite (docs/qa-plan.md section 6), Canvas only. One scratch server, one headless Chrome
// (WebGPU engine), generated stress files (bench/fixtures/gen.ts: 200, 2,000 and 5,000 boards) cloned into a temp
// folder that is removed at the end. Never opens a file of yours; BENCH_FILE adds a real .canvas package (cloned)
// to the server-side lines.
//
//   open     cold open to the first complete picture (canvasHost.perf.picture: navigation start until every board in
//            view is drawn and its images are in); first open of each file, then warm opens
//   frame    pan and zoom frame time p50/p95 (main thread, 120 Hz wheel events): at the overview and at 50 %
//   input    input to pixel: drag a layer, resize from a handle, type, select in a dense board (bench/latency.ts)
//   write    structure ops (duplicate, reorder, group, ungroup, delete) and flush (edit 200 to bytes on disk), HTTP
//   memory   after a scripted edit session worth about 10 minutes of work (60 rounds of drag, resize, inspector
//            edits, typing, duplicate and delete, undo and redo, pan, zoom, select), compressed: footprint of the
//            server, the page's renderer and Chrome's GPU process (what Activity Monitor shows), JS heap, engine
//   export   50 boards to PNG at 1x (POST /api/export, the right-click menu's path), wall time
//   mcp      an agent's edit to pixel: set_node_props through the real MCP server (stdio) until the page shows it
//
// Prints a table, writes bench/out/speed-<time>.json and bench/out/speed-latest.json (machine, versions, date,
// load average, every sample), exits 1 when a line fails its budget (budgets: docs/perf/latency.md).
//
//   pnpm bench                       everything (about 4 minutes)
//   pnpm bench open frame            some groups (open frame input write memory export mcp)
//   BENCH_SIZES=200,2000 pnpm bench  some fixture sizes (default 200,2000,5000)
//   BENCH_ROUNDS=20 pnpm bench memory   a shorter edit session
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { launchChrome, type Chrome } from "../fidelity/cdp.ts";
import { ROOT, api, openTab, sleep, startServer, type Scratch } from "../qa/lib.ts";
import { fixture, scratchCopy, type Fixture } from "./fixtures/gen.ts";
import { Tab, addLine, lines, moveScenario, resizeScenario, selectScenario, textScenario, wheelFrames, type Line } from "./latency.ts";

const OUT = path.join(ROOT, "bench", "out");
const W = 1440, H = 900;
const GROUPS = new Set(process.argv.slice(2).filter((a) => !a.startsWith("-")));
const want = (g: string) => !GROUPS.size || GROUPS.has(g);
const SIZES = (process.env.BENCH_SIZES || "200,2000,5000").split(",").map(Number).filter((n) => n > 0);
const ROUNDS = Number(process.env.BENCH_ROUNDS || 60);
/** How long an open may take to reach its complete picture before the line fails and the file's page lines are skipped. */
const OPEN_MS = Number(process.env.BENCH_OPEN_MS || 60_000);
const REAL = process.env.BENCH_FILE || "";
const log = (s: string) => console.log(s);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Budgets of the lines this suite adds (the frame, input and write lines keep bench/latency.ts's). */
export const SPEED_BUDGET = {
  open200: 1500, open2000: 3000, open5000: 6000,
  frame: 1000 / 60,
  input: 1000 / 60,
  structure: 100, flush: 100,
  export50: 15_000,
  mcp: 100,
  memoryGrowthMb: 400,
};

// ---------------------------------------------------------------- environment

const sh = (cmd: string, a: string[]) => { try { return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
function environment() {
  const wasm = path.join(ROOT, "engine", "pkg", "canvas_engine_bg.wasm");
  return {
    date: new Date().toISOString(),
    machine: sh("sysctl", ["-n", "machdep.cpu.brand_string"]) || os.cpus()[0]?.model,
    model: sh("sysctl", ["-n", "hw.model"]),
    cores: os.cpus().length,
    memGb: Math.round(os.totalmem() / 2 ** 30),
    macos: sh("sw_vers", ["-productVersion"]),
    node: process.version,
    canvas: sh("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]) + (sh("git", ["-C", ROOT, "status", "--porcelain", "--untracked-files=no"]) ? "+dirty" : ""),
    engineWasmBytes: fs.existsSync(wasm) ? fs.statSync(wasm).size : null,
    load1Before: r1(os.loadavg()[0]),
  };
}

// ---------------------------------------------------------------- memory

type Proc = { pid: number; ppid: number; rssKb: number; cmd: string };
function procs(): Proc[] {
  return sh("ps", ["-A", "-o", "pid=,ppid=,rss=,command="]).split("\n").map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m ? { pid: +m[1], ppid: +m[2], rssKb: +m[3], cmd: m[4] } : null;
  }).filter((p): p is Proc => !!p);
}
function tree(root: number, all: Proc[]): Proc[] {
  const out: Proc[] = [], q = [root];
  while (q.length) { const p = q.shift()!; const me = all.find((x) => x.pid === p); if (me) out.push(me); for (const c of all) if (c.ppid === p) q.push(c.pid); }
  return out;
}
/** Physical footprint in MB (Activity Monitor's Memory column), from footprint(1); RSS when it is not there. */
function footprintMb(pid: number, rssKb: number): number {
  const s = sh("footprint", ["-p", String(pid)]);
  const m = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(s);
  if (!m) return r1(rssKb / 1024);
  return r1(Number(m[1]) * (m[2] === "GB" ? 1024 : m[2] === "KB" ? 1 / 1024 : 1));
}
async function memory(chrome: Chrome, srv: Scratch, tab: Tab) {
  await tab.page.send("HeapProfiler.collectGarbage").catch(() => {});
  await sleep(300);
  const all = procs();
  const kids = tree(chrome.proc.pid!, all);
  const by = (re: RegExp) => kids.filter((p) => re.test(p.cmd));
  const sum = (ps: Proc[]) => r1(ps.reduce((a, p) => a + footprintMb(p.pid, p.rssKb), 0));
  const server = all.find((p) => p.pid === srv.proc.pid);
  const heap = await tab.page.send("Runtime.getHeapUsage").catch(() => null) as { usedSize: number; totalSize: number } | null;
  const eng = await tab.ev<any>("(() => { const s = window.__canvas.stats(); return s && { tileBytes: s.tileBytes, imageBytes: s.imageBytes, wasmBytes: s.wasmBytes, effectBytes: s.effectBytes, boards: s.boards, nodes: s.nodes, atlasLayers: s.atlasLayers, atlasCells: s.atlasCells }; })()").catch(() => null);
  const renderer = sum(by(/--type=renderer/)), gpu = sum(by(/--type=gpu-process/)), other = sum(kids.filter((p) => !/--type=(renderer|gpu-process)/.test(p.cmd)));
  const serverMb = server ? footprintMb(server.pid, server.rssKb) : NaN;
  return { serverMb, rendererMb: renderer, gpuMb: gpu, browserOtherMb: other, totalMb: r1(serverMb + renderer + gpu + other), jsHeapMb: heap ? r1(heap.usedSize / 1048576) : null, engine: eng };
}

// ---------------------------------------------------------------- page helpers

const WATCH = `window.__watch = (probe, ms = 5000) => new Promise((res) => {
  const base = JSON.stringify(probe()), t0 = performance.now();
  const step = () => window.__lat.afterPaint((b, e) => { let v; try { v = JSON.stringify(probe()); } catch (err) { v = "x"; } if (v !== base) res(performance.timeOrigin + e); else if (performance.now() - t0 > ms) res(null); else step(); });
  step();
});`;

/** Open a file in a new tab; `complete` is false when it did not reach its complete picture within OPEN_MS. */
async function openFile(chrome: Chrome, srv: Scratch, f: Fixture): Promise<{ tab: Tab; perf: any; complete: boolean }> {
  const tab = new Tab(await openTab(chrome.port));
  const t0 = Date.now();
  let complete = true;
  try {
    await tab.open(srv.base, f.dir, undefined, 0);
    await tab.waitFor("(() => { const p = window.canvasHost.perf; return 'picture' in p ? p.picture !== null : p.load !== null; })()", "the first complete picture", Math.max(1000, OPEN_MS - (Date.now() - t0)));
  } catch (e) {
    if (!/timed out waiting for (the engine to settle|the first complete picture)/.test((e as Error).message)) { await tab.close(); throw e; }
    complete = false;
  }
  const perf = await tab.ev("JSON.parse(JSON.stringify(window.canvasHost.perf))");
  await tab.ev(WATCH);
  return { tab, perf, complete };
}

// ---------------------------------------------------------------- scenarios

async function openScenario(chrome: Chrome, srv: Scratch, f: Fixture) {
  const label = `${f.boards}`;
  const xs: number[] = [], docs: number[] = [], firsts: number[] = [], loads: (number | null)[] = [];
  let incomplete = 0;
  for (let k = 0; k < 3; k++) {
    const { tab, perf, complete } = await openFile(chrome, srv, f);
    if (!complete) incomplete++;
    xs.push(complete ? (perf.picture ?? perf.load) : OPEN_MS); docs.push(perf.doc); firsts.push(perf.landed);
    // load: the engine idle too (base textures and tiles ahead of the view drawn); null when the open moved on first.
    if (complete && perf.load === null) await tab.waitFor("window.canvasHost.perf.load !== null", "the engine idle", 30_000).catch(() => null);
    loads.push(complete ? await tab.ev<number | null>("window.canvasHost.perf.load").catch(() => null) : null);
    await tab.close();
    if (!complete) break; // one open that never completes is the answer; the rest would take as long
  }
  const budget = (SPEED_BUDGET as Record<string, number>)[`open${f.boards}`] ?? null;
  // The first open is the cold one (server and Chrome have not seen the file); the line's budget is held to it.
  addLine("open", label, "cold open to complete picture (1st)", [xs[0]], `${incomplete ? `NOT complete after ${OPEN_MS / 1000} s; ` : ""}doc ${docs[0]} ms, first board ${firsts[0]} ms, engine idle ${loads[0] ?? "-"} ms; ${(f.bytes / 1048576).toFixed(0)} MB, ${f.nodes} nodes`, undefined, { budget });
  addLine("open", label, "warm open to complete picture", xs.slice(1), `doc p50 ${docs.slice(1).sort((a, b) => a - b)[0]} ms`, undefined, { budget: null });
}

async function frameLines(tab: Tab, f: Fixture) {
  const label = `${f.boards}`;
  // A file that is still drawing is measured as it is: the waits are bounded, and the note says so.
  let unsettled = 0;
  const settle = () => tab.settle(20_000).catch(() => void unsettled++);
  const gesture = async (kind: "pan" | "zoom", where: string) => {
    unsettled = 0;
    await wheelFrames(tab, kind, 600);
    await settle();
    const fr = await wheelFrames(tab, kind, 3000);
    await settle();
    const work = fr.map((x) => x.e - x.b);
    const deltas = fr.slice(1).map((x, i) => x.b - fr[i].b);
    const dropped = deltas.filter((d) => d > 25).length;
    const gpu = fr.map((x) => x.gpu).filter((g): g is number => typeof g === "number" && g > 0).sort((a, b) => a - b);
    const over = work.filter((w) => w > 1000 / 120).length;
    addLine("frame", label, `${kind} ${where}`, work, `${over}/${work.length} over 8.3; ${dropped} dropped; gpu p95 ${r1(gpu[Math.ceil(gpu.length * 0.95) - 1] ?? NaN)}${unsettled ? "; still drawing" : ""}`, { dropped, over120: over, unsettled }, { budget: SPEED_BUDGET.frame });
  };
  const fit = async () => { await tab.fitPage().catch(() => void unsettled++); };
  await fit();
  await gesture("pan", "overview");
  await fit();
  await gesture("zoom", "overview");
  // Working zoom: 50 %, in the middle of the boards.
  const r = await tab.ev<{ x: number; y: number }>("(() => { const h = window.canvasHost, c = h.cam; return { x: (720 - c.x) / c.z, y: (450 - c.y) / c.z }; })()");
  await tab.ev(`window.canvasHost.setCam(${JSON.stringify({ z: 0.5, x: W / 2 - r.x * 0.5, y: H / 2 - r.y * 0.5 })})`);
  await settle();
  await gesture("pan", "at 50%");
  await gesture("zoom", "at 50%");
}

async function inputLines(tab: Tab, f: Fixture) {
  const h = f.heroBoards[0], d = f.denseBoards[0];
  const tg = { page: "page-1", move: `${h}-card`, other: `${h}-sq1`, spacing: null, text: `${h}-cap`, todo: null, card: null, cardsPage: null };
  const label = `${f.boards}`;
  if (f.boards === 200) {
    await moveScenario(tab, label, tg);
    await resizeScenario(tab, label, tg);
    await textScenario(tab, label, tg);
  }
  // Select in a dense board: 600 layers in 12 clusters; alternate between two clusters.
  await selectScenario(tab, label, { ...tg, move: `${d}-d4`, other: `${d}-d7` });
  const last = lines.at(-1);
  if (last && last.name === "select by click") last.name = "select in a dense board (600 layers)";
}

async function structureLines(srv: Scratch, f: Fixture, label = `${f.boards}`) {
  const a = api(srv.base, f.dir);
  const by: Record<string, number[]> = { duplicate: [], reorder: [], group: [], ungroup: [], delete: [] };
  const time = async (op: string, body: Record<string, unknown>) => {
    const t0 = performance.now();
    const r = await a.post("/api/structure", { file: f.dir, op, ...body });
    by[op].push(performance.now() - t0);
    return r;
  };
  for (let k = 0; k < 20; k++) {
    const h = f.heroBoards[(k * 7) % f.heroBoards.length];
    const dup = await time("duplicate", { ids: [`${h}-sq1`] });
    const copy = dup.select[0];
    await time("reorder", { ids: [copy], dir: "back" });
    const g = await time("group", { ids: [copy, `${h}-dot1`] });
    await time("ungroup", { ids: [g.select[0]] });
    await time("delete", { ids: [copy] });
  }
  for (const [op, xs] of Object.entries(by)) addLine("write", label, `structure: ${op} (HTTP)`, xs, "", undefined, { budget: SPEED_BUDGET.structure });
  // From an edit's 200 to the same state on disk.
  const up: number[] = [], fl: number[] = [];
  const id = `${f.heroBoards[1] ?? f.heroBoards[0]}-sq1`;
  for (let k = 0; k < 12; k++) {
    const t0 = performance.now();
    await a.post("/api/update", { file: f.dir, id, props: { opacity: k % 2 ? 1 : 0.9 } });
    const t1 = performance.now();
    await a.flush();
    fl.push(performance.now() - t1); up.push(t1 - t0);
    await sleep(100);
  }
  addLine("write", label, "set props (HTTP)", up, "", undefined, { budget: SPEED_BUDGET.structure });
  addLine("write", label, `flush to disk (${(f.bytes / 1048576).toFixed(0)} MB)`, fl, "", undefined, { budget: SPEED_BUDGET.flush });
}

async function exportLines(srv: Scratch, f: Fixture, tmp: string) {
  const a = api(srv.base, f.dir);
  const ids = Array.from({ length: 50 }, (_, i) => `b${i}`);
  const xs: number[] = [];
  for (let k = 0; k < 2; k++) {
    const dir = path.join(tmp, `export-${k}`);
    fs.mkdirSync(dir, { recursive: true });
    const t0 = performance.now();
    const r = await a.post("/api/export", { file: f.dir, ids, format: "png", scale: 1, dir });
    xs.push(performance.now() - t0);
    if ((r.files ?? []).length !== 50) throw new Error(`export wrote ${(r.files ?? []).length} files, not 50`);
  }
  addLine("export", `${f.boards}`, "export 50 boards to PNG (1st, 2nd)", xs, "", undefined, { budget: SPEED_BUDGET.export50 });
}

async function mcpLines(srv: Scratch, tab: Tab, f: Fixture) {
  const version = (await (await fetch(`${srv.base}/health`)).json()).version;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "mcp", "server.ts")],
    env: { ...(process.env as Record<string, string>), CANVAS_PORT: String(srv.port), CANVAS_MCP_NO_SPAWN: "1", CANVAS_MCP_NO_APP: "1", CANVAS_MCP_WANT_VERSION: version },
    stderr: "ignore",
  });
  const c = new Client({ name: "bench", version: "0" });
  await c.connect(transport);
  try {
    const h = f.heroBoards[2] ?? f.heroBoards[0], id = `${h}-sq1`;
    const r = await tab.rect(id);
    if (!r) { addLine("mcp", `${f.boards}`, "MCP set_node_props to pixel", [], "layer not drawn"); return; }
    await tab.show({ x: r.x - 300, y: r.y - 300, w: r.w + 600, h: r.h + 600 }, 1);
    const xs: number[] = [], calls: number[] = [];
    let missed = 0;
    // One call first, not measured: the MCP server's first request warms its connection and file lookup.
    await c.callTool({ name: "set_node_props", arguments: { file: f.dir, id, props: { x: 200 } } });
    await tab.settle();
    for (let k = 0; k < 12; k++) {
      await tab.ev(`window.__w = window.__watch(() => { const r = window.canvasHost.worldRectOf(${JSON.stringify(id)}); return r && Math.round(r.x * 4); }); 1`);
      const t0 = performance.timeOrigin + performance.now();
      const res: any = await c.callTool({ name: "set_node_props", arguments: { file: f.dir, id, props: { x: 200 + (k % 2 ? 0 : 24) } } });
      const t1 = performance.timeOrigin + performance.now();
      const shown = await tab.ev<number | null>("window.__w");
      if (res.isError || shown === null) { missed++; continue; }
      xs.push(shown - t0); calls.push(t1 - t0);
      await sleep(150);
    }
    const cs = [...calls].sort((a, b) => a - b);
    addLine("mcp", `${f.boards}`, "MCP set_node_props to pixel", xs, `tool call alone p50 ${r1(cs[Math.floor(cs.length / 2)])} ms`, undefined, { budget: SPEED_BUDGET.mcp, missed });
  } finally {
    await c.close().catch(() => {});
  }
}

/** About 10 minutes of a person's editing, compressed: ROUNDS rounds over different boards. */
async function memoryLines(chrome: Chrome, srv: Scratch, f: Fixture) {
  const { tab } = await openFile(chrome, srv, f);
  try {
    const a = api(srv.base, f.dir);
    const before = await memory(chrome, srv, tab);
    const t0 = Date.now();
    let edits = 0;
    for (let k = 0; k < ROUNDS; k++) {
      const h = f.heroBoards[(k * 13) % f.heroBoards.length];
      const card = `${h}-card`, text = `${h}-cap`;
      const r = await tab.rect(card);
      if (!r) continue;
      await tab.show({ x: r.x - 200, y: r.y - 200, w: r.w + 400, h: r.h + 400 }, 1);
      // select + drag-move
      const s = (await tab.screenRect(card))!;
      const c = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
      await tab.move(c); await tab.down(c);
      for (let i = 1; i <= 8; i++) await tab.move({ x: c.x + i * 3 * (k % 2 ? -1 : 1), y: c.y + i }, true);
      await tab.up({ x: c.x + 24 * (k % 2 ? -1 : 1), y: c.y + 8 });
      edits++;
      // resize from the corner
      const s2 = (await tab.screenRect(card))!;
      const q = { x: s2.x + s2.w - 1, y: s2.y + s2.h - 1 };
      await tab.move(q); await tab.down(q);
      for (let i = 1; i <= 6; i++) await tab.move({ x: q.x + i * 2 * (k % 2 ? -1 : 1), y: q.y + i }, true);
      await tab.up({ x: q.x + 12 * (k % 2 ? -1 : 1), y: q.y + 6 });
      edits++;
      // inspector edits
      await a.post("/api/update", { file: f.dir, id: `${h}-sq1`, props: { opacity: 0.5 + (k % 5) / 10 } });
      await a.post("/api/update", { file: f.dir, id: `${h}-dot1`, props: { fill: k % 2 ? "#0766EB33" : "#FF950033" } });
      edits += 2;
      // type into the caption and leave
      const ts = await tab.screenRect(text);
      if (ts) {
        const p = { x: ts.x + Math.min(ts.w - 4, 10), y: ts.y + ts.h / 2 };
        await tab.move(p); await tab.down(p, 1); await tab.up(p, 1); await tab.down(p, 2); await tab.up(p, 2);
        await tab.waitFor("window.canvasHost.textEdit && window.canvasHost.textEdit.active", "text editing", 3000).catch(() => null);
        await tab.key("End", "End", 35);
        for (const ch of " edit") await tab.char(ch);
        await tab.key("Escape", "Escape", 27);
        edits += 5;
      }
      // duplicate and delete, undo and redo
      await tab.ev(`window.canvasHost.setSelection(${JSON.stringify([`${h}-sq1`])})`);
      await tab.ev("window.canvasCmd({ cmd: 'structure', op: 'duplicate' })");
      await sleep(60);
      await tab.key("Backspace", "Backspace", 8);
      await sleep(60);
      await tab.key("z", "KeyZ", 90, undefined, 4);
      await sleep(60);
      await tab.key("z", "KeyZ", 90, undefined, 4 | 8);
      edits += 4;
      // look around: a short pan and a zoom
      await wheelFrames(tab, k % 2 ? "zoom" : "pan", 300);
      await sleep(50);
    }
    await a.flush();
    await tab.settle(120_000).catch(() => {});
    await sleep(2500); // idle timers (snapshot capture, verify, eviction) run
    const after = await memory(chrome, srv, tab);
    const secs = Math.round((Date.now() - t0) / 1000);
    const note = (m: typeof before) => `server ${m.serverMb}, renderer ${m.rendererMb}, GPU ${m.gpuMb}, other ${m.browserOtherMb}, JS heap ${m.jsHeapMb}, tiles ${Math.round((m.engine?.tileBytes ?? 0) / 1048576)} MB${m.engine?.atlasLayers ? `, atlas ${m.engine.atlasLayers} layers (${m.engine.atlasCells} cells)` : ""}`;
    addLine("memory", `${f.boards}`, "footprint MB after open", [before.totalMb], note(before), { before }, { budget: null });
    addLine("memory", `${f.boards}`, `footprint MB after ${edits} edits (${ROUNDS} rounds)`, [after.totalMb], `${note(after)}; ran ${secs} s`, { after }, { budget: null });
    addLine("memory", `${f.boards}`, "growth MB over the session", [r1(after.totalMb - before.totalMb)], "", undefined, { budget: SPEED_BUDGET.memoryGrowthMb });
  } finally {
    await tab.close();
  }
}

// ---------------------------------------------------------------- main

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const env = environment();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-speed-"));
  process.env.CANVAS_SECURITY_BIN = "/usr/bin/false";
  process.env.CANVAS_POSTHOG_BASE = "http://127.0.0.1:9";
  let srv: Scratch | undefined, chrome: Chrome | undefined;
  const t0 = Date.now();
  const stop = async () => { await chrome?.stop().catch(() => {}); chrome = undefined; await srv?.stop().catch(() => {}); srv = undefined; fs.rmSync(tmp, { recursive: true, force: true }); };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, async () => { await stop(); process.exit(130); });
  const errors: string[] = [];
  const fixtures: Record<number, Fixture> = {};
  try {
    for (const n of SIZES) {
      const g0 = Date.now();
      fixtures[n] = scratchCopy(fixture(n), tmp, `stress-${n}.canvas`);
      log(`fixture ${n}: ${fixtures[n].nodes} nodes, ${(fixtures[n].bytes / 1048576).toFixed(1)} MB (${Date.now() - g0} ms)`);
    }
    // A second copy of each for the edit session and the server lines, so the open and frame lines see the file as generated.
    const edited: Record<number, Fixture> = {};
    for (const n of SIZES) edited[n] = scratchCopy(fixtures[n], tmp, `edit-${n}.canvas`);
    srv = await startServer(tmp);
    chrome = await launchChrome(["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", "--disable-component-update", "--disable-sync"]);
    (env as any).chrome = chrome.version;
    log(`server ${srv.base}, ${chrome.version}, load ${env.load1Before}`);
    const step = async (name: string, fn: () => Promise<void>) => {
      const s0 = Date.now();
      try { await fn(); } catch (e) { log(`  ${name} failed: ${(e as Error).stack?.split("\n").slice(0, 3).join(" | ")}`); errors.push(`${name}: ${(e as Error).message}`); }
      log(`  (${name}: ${Math.round((Date.now() - s0) / 1000)} s)`);
    };
    for (const n of SIZES) {
      const f = fixtures[n];
      log(`\n${n} boards`);
      if (want("open")) await step(`open ${n}`, () => openScenario(chrome!, srv!, f));
      if (want("frame") || want("input")) {
        const { tab, complete } = await openFile(chrome!, srv!, f);
        if (!complete) log(`  ${n} boards: no complete picture after ${OPEN_MS / 1000} s; frames measured while it draws`);
        try {
          if (want("frame")) await step(`frames ${n}`, () => frameLines(tab, f));
          if (want("input")) await step(`input ${n}`, () => inputLines(tab, f));
          if (want("mcp") && n === SIZES[0]) await step("mcp", () => mcpLines(srv!, tab, f));
          errors.push(...tab.page.console.filter((l) => l.startsWith("exception")).slice(0, 5));
        } finally { await tab.close(); }
      } else if (want("mcp") && n === SIZES[0]) {
        const { tab } = await openFile(chrome!, srv!, f);
        try { await step("mcp", () => mcpLines(srv!, tab, f)); } finally { await tab.close(); }
      }
      if (want("write") && n !== 5000) await step(`structure ${n}`, () => structureLines(srv!, edited[n]));
      if (want("export") && n === 2000) await step("export", () => exportLines(srv!, edited[n], tmp));
      if (want("memory") && n === 2000) await step("memory", () => memoryLines(chrome!, srv!, edited[n]));
    }
    if (REAL && want("write") && fs.existsSync(path.join(REAL, "document.json"))) {
      // Only the server-side lines, on a clone; targets: the largest freely placed board's first two layers.
      const copy = path.join(tmp, "real.canvas");
      fs.cpSync(REAL, copy, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, filter: (s) => !path.basename(s).startsWith(".canvas-") });
      log("\nreal file (BENCH_FILE)");
      await step("structure real", () => realStructure(srv!, copy));
    }
  } finally {
    await stop();
  }
  (env as any).load1After = r1(os.loadavg()[0]);
  report(env, fixtures, errors, t0);
}

async function realStructure(srv: Scratch, dir: string) {
  type N = { id: string; type: string; layout?: string; x?: number; children?: N[] };
  const doc = JSON.parse(fs.readFileSync(path.join(dir, "document.json"), "utf8")) as { children: N[] };
  const count = (n: N): number => 1 + (n.children ?? []).reduce((a, c) => a + count(c), 0);
  const free = doc.children.filter((b) => b.type === "frame" && b.layout === "none" && (b.children ?? []).filter((c) => typeof c.x === "number").length >= 2).sort((a, b) => count(b) - count(a));
  if (!free.length) throw new Error("no freely placed board with two layers");
  const bytes = fs.statSync(path.join(dir, "document.json")).size;
  const kids = free.map((b) => (b.children ?? []).filter((c) => typeof c.x === "number"));
  // A fixture-shaped view of the real file: heroBoards whose "-sq1" and "-dot1" are its first two layers.
  const ids = new Map<string, [string, string]>();
  free.slice(0, 20).forEach((b, i) => ids.set(`real${i}`, [kids[i][0].id, kids[i][1].id]));
  const a = api(srv.base, dir);
  const by: Record<string, number[]> = { duplicate: [], reorder: [], group: [], ungroup: [], delete: [] };
  const time = async (op: string, body: Record<string, unknown>) => { const t0 = performance.now(); const r = await a.post("/api/structure", { file: dir, op, ...body }); by[op].push(performance.now() - t0); return r; };
  const pairs = [...ids.values()];
  for (let k = 0; k < 20; k++) {
    const [one, two] = pairs[k % pairs.length];
    const dup = await time("duplicate", { ids: [one] });
    const copy = dup.select[0];
    await time("reorder", { ids: [copy], dir: "back" });
    const g = await time("group", { ids: [copy, two] });
    await time("ungroup", { ids: [g.select[0]] });
    await time("delete", { ids: [copy] });
  }
  const label = "real";
  for (const [op, xs] of Object.entries(by)) addLine("write", label, `structure: ${op} (HTTP)`, xs, "", undefined, { budget: SPEED_BUDGET.structure });
  const fl: number[] = [];
  for (let k = 0; k < 12; k++) {
    await a.post("/api/update", { file: dir, id: pairs[0][1], props: { opacity: k % 2 ? 1 : 0.9 } });
    const t1 = performance.now();
    await a.flush();
    fl.push(performance.now() - t1);
    await sleep(100);
  }
  addLine("write", label, `flush to disk (${(bytes / 1048576).toFixed(0)} MB)`, fl, "", undefined, { budget: SPEED_BUDGET.flush });
}

function report(env: Record<string, unknown>, fixtures: Record<number, Fixture>, errors: string[], t0: number) {
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1).padStart(8) : "       -");
  console.log(`\n${env.machine}, ${env.cores} cores, ${env.memGb} GB, macOS ${env.macos}, Node ${env.node}, ${env.chrome ?? ""}, canvas ${env.canvas}; load ${env.load1Before} -> ${env.load1After}`);
  console.log(`${"GROUP".padEnd(7)}${"FILE".padEnd(7)}${"WHAT".padEnd(46)}${"N".padStart(4)}${"P50".padStart(8)}${"P95".padStart(8)}${"MAX".padStart(8)}${"BUDGET".padStart(9)}  RESULT`);
  for (const l of lines) console.log(`${l.group.padEnd(7)}${l.file.padEnd(7)}${l.name.slice(0, 45).padEnd(46)}${String(l.n).padStart(4)}${fmt(l.p50)}${fmt(l.p95)}${fmt(l.max)}${(l.budget === null ? "-" : l.budget.toFixed(1)).padStart(9)}  ${l.status}${l.note ? "  " + l.note : ""}`);
  const fails = lines.filter((l: Line) => l.status === "FAIL");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = { env, budget: SPEED_BUDGET, fixtures: Object.values(fixtures).map((f) => ({ boards: f.boards, nodes: f.nodes, bytes: f.bytes })), seconds: Math.round((Date.now() - t0) / 1000), errors, lines };
  const name = process.env.BENCH_OUT || `speed-${stamp}.json`;
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(OUT, "speed-latest.json"), JSON.stringify(out, null, 1));
  if (errors.length) console.log(`\nerrors:\n  ${errors.join("\n  ")}`);
  console.log(`\n${lines.length - fails.length} of ${lines.length} lines within budget or info, ${fails.length} fail; ${out.seconds} s; bench/out/${name}`);
  process.exitCode = fails.length || errors.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
