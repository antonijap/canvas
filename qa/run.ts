// pnpm qa: drives demos/playground.canvas in headless Chrome (engine renderer, WebGPU) with real mouse and key
// events, and checks the file on disk and the page's state after each scenario, then the shared checks every
// scenario ends with (qa/runner.ts, docs/qa-plan.md section 2).
//
// The scenarios are shared out over worker processes (QA_SHARDS, default half the cores, at most 12). Each worker
// has its own scratch server (CANVAS_ROOTS on its own temp folder) and its own Chrome; each scenario gets a fresh
// copy of the playground and its own tab, so nothing one scenario does reaches another. Workers take the next
// scenario when they finish one, longest first (qa/out/timings.json). A failing scenario saves a screenshot into
// qa/out/. Exit code 1 when anything fails. Nothing here is scheduled: it runs when invoked.
//
//   pnpm qa                          every scripted scenario (qa/scenarios.ts)
//   pnpm qa resize card              only scenarios whose area or name contains one of the words
//   pnpm qa --update-baselines       write the end-state pictures as the new qa/baselines
//   pnpm qa:matrix                   the generated scenarios (qa/matrix.ts); QA_SEED replays the random sequences
//   QA_SHARDS=1 pnpm qa              one worker, in order
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchChrome, type Chrome } from "../fidelity/cdp.ts";
import { scenarios, slug, type Scenario } from "./harness.ts";
import { ROOT, startServer, type Scratch } from "./lib.ts";
import { PLAYGROUND } from "./playground.ts";
import { BUDGET, type LatencyKind } from "./checks.ts";
import { BASELINES, OUT, runScenario, type Result } from "./runner.ts";

const TIMINGS = path.join(OUT, "timings.json");

type Opts = { matrix: boolean; update: boolean; words: string[] };
function parseArgs(argv: string[]): Opts {
  return { matrix: argv.includes("--matrix"), update: argv.includes("--update-baselines"), words: argv.filter((a) => !a.startsWith("--")).map((s) => s.toLowerCase()) };
}

/** The scenarios this run covers, in a fixed order every process agrees on. */
export async function selected(o: Opts): Promise<Scenario[]> {
  await import("./scenarios.ts");
  if (o.matrix) await import("./matrix.ts");
  const kind = o.matrix ? "matrix" : "scripted";
  return scenarios.filter((s) => s.kind === kind && (!o.words.length || o.words.some((w) => `${s.area} ${s.name}`.toLowerCase().includes(w))));
}

// ---------------------------------------------------------------- worker

async function worker(o: Opts) {
  const list = await selected(o);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-"));
  let srv: Scratch | undefined, chrome: Chrome | undefined;
  const stop = async () => { await chrome?.stop().catch(() => {}); await srv?.stop().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); };
  for (const sig of ["SIGINT", "SIGTERM", "disconnect"] as const) process.once(sig as any, async () => { await stop(); process.exit(130); });
  try {
    srv = await startServer(tmp);
    process.env.CANVAS_WIDGETS_DIR = srv.widgetsDir;
    chrome = await launchChrome();
    process.send!({ type: "ready", chrome: chrome.version });
    for (;;) {
      const m = await new Promise<any>((r) => process.once("message", r));
      if (m.type !== "run") break;
      const r = await runScenario({ chrome, srv, tmp, update: o.update }, list[m.index]);
      process.send!({ type: "result", index: m.index, result: r });
    }
  } catch (e) {
    process.send!({ type: "error", message: (e as Error).stack ?? String(e) });
  } finally {
    await stop();
  }
  process.exit(0);
}

// ---------------------------------------------------------------- parent

export function shardCount(n: number): number {
  const env = Number(process.env.QA_SHARDS);
  const want = Number.isInteger(env) && env > 0 ? env : Math.min(12, Math.max(1, Math.floor(os.cpus().length / 2)));
  return Math.max(1, Math.min(want, n));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(PLAYGROUND, "document.json"))) throw new Error(`${PLAYGROUND} is missing: run node qa/playground.ts`);
  if (!fs.existsSync(path.join(ROOT, "engine", "pkg", "canvas_engine_bg.wasm"))) throw new Error("engine/pkg is missing: run engine/build.sh (the page needs the engine)");
  // The random sequences' base seed: printed, and handed to every worker so they all build the same list.
  if (o.matrix && !process.env.QA_SEED) process.env.QA_SEED = String(1 + Math.floor(Math.random() * 999_999));
  const list = await selected(o);
  if (!list.length) { console.log("no scenarios match"); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const timings: Record<string, number> = fs.existsSync(TIMINGS) ? JSON.parse(fs.readFileSync(TIMINGS, "utf8")) : {};
  // Longest first, so the last scenarios to start are short ones and the workers finish together.
  const queue = list.map((s, i) => ({ i, ms: timings[slug(s)] ?? 5000 })).sort((a, b) => b.ms - a.ms).map((x) => x.i);
  const n = shardCount(list.length);
  const label = o.matrix ? `matrix${process.env.QA_SEED ? ` (QA_SEED=${process.env.QA_SEED})` : ""}` : "scenarios";
  console.log(`${list.length} ${label} on ${n} worker${n === 1 ? "" : "s"}${o.update ? ", updating baselines" : ""}`);
  const t0 = Date.now();
  const results: (Result | null)[] = list.map(() => null);
  const kids: ChildProcess[] = [];
  let chromeVersion = "";
  const stopAll = () => { for (const k of kids) if (k.exitCode === null) k.kill("SIGTERM"); };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { stopAll(); process.exit(130); });
  await Promise.all(Array.from({ length: n }, (_, w) => new Promise<void>((done) => {
    const kid = fork(process.argv[1], process.argv.slice(2), { env: { ...process.env, QA_WORKER: String(w + 1), QA_WORKERS: String(n) }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    kids.push(kid);
    let current = -1;
    const next = () => {
      const i = queue.shift();
      if (i === undefined) { current = -1; kid.send({ type: "done" }); return; }
      current = i;
      kid.send({ type: "run", index: i });
    };
    kid.on("message", (m: any) => {
      if (m.type === "ready") { chromeVersion = m.chrome; next(); }
      else if (m.type === "result") {
        const r: Result = { ...m.result, worker: w + 1 };
        results[m.index] = r;
        print(r);
        next();
      } else if (m.type === "error") console.log(`worker ${w + 1} failed: ${m.message}`);
    });
    kid.on("exit", (code) => {
      if (current >= 0 && !results[current]) {
        const s = list[current];
        results[current] = failed(s, `worker ${w + 1} exited (${code}) during this scenario`);
        print(results[current]!);
      }
      done();
    });
  })));
  // Scenarios no worker took (every worker died): failures, not silence.
  list.forEach((s, i) => { if (!results[i]) results[i] = failed(s, "never ran: no worker was left"); });
  const rs = results as Result[];
  const wall = Date.now() - t0;
  report(rs, wall, n);
  for (const r of rs) if (r.status !== "FAIL") timings[r.slug] = r.ms;
  fs.writeFileSync(TIMINGS, JSON.stringify(timings, null, 1) + "\n");
  const out = path.join(OUT, o.matrix ? "matrix-last.json" : "last-run.json");
  // A filtered run updates its own scenarios' results and keeps the others' (qa:coverage reads the latest of each).
  const when = new Date().toISOString();
  let kept: Result[] = [];
  if (o.words.length) try { kept = JSON.parse(fs.readFileSync(out, "utf8")).results.filter((r: Result) => !rs.some((x) => x.slug === r.slug)); } catch {}
  fs.writeFileSync(out, JSON.stringify({ when, chrome: chromeVersion, shards: n, wallMs: wall, seed: process.env.QA_SEED ?? null, filtered: o.words.length > 0, results: [...kept, ...rs.map((r) => ({ ...r, when }))] }, null, 1) + "\n");
  if (o.update && !o.words.length) pruneBaselines(rs, o.matrix);
  // The run fails on a failed scenario; and on a latency p95 over its budget when it ran on one or two workers (with
  // more, the workers load the machine and the numbers are not the ones docs/perf/latency.md budgets: reported only).
  process.exitCode = rs.some((r) => r.status === "FAIL") || (n <= 2 && runLatency(rs).some((l) => l.n >= 5 && l.p95 > l.budget)) ? 1 : 0;
}

function failed(s: Scenario, msg: string): Result {
  return { slug: slug(s), area: s.area, name: s.name, kind: s.kind, covers: s.covers, status: "FAIL", ms: 0, msg, problems: [msg], checks: {} as Result["checks"], lat: [] };
}

function print(r: Result) {
  console.log(`${r.status} ${r.area} / ${r.name} (${r.ms} ms, w${r.worker ?? "?"})${r.msg ? `\n  ${r.msg}` : ""}`);
}

function report(rs: Result[], wall: number, n: number) {
  const pad = (s: string, k: number) => (s.length >= k ? s : s + " ".repeat(k - s.length));
  const wa = Math.max(...rs.map((r) => r.area.length), 4), wn = Math.min(90, Math.max(...rs.map((r) => r.name.length), 8));
  console.log(`\n${pad("AREA", wa)}  ${pad("SCENARIO", wn)}  RESULT`);
  for (const r of rs) console.log(`${pad(r.area, wa)}  ${pad(r.name.slice(0, wn), wn)}  ${r.status}${r.status !== "PASS" ? `  ${r.msg.split("\n")[0].slice(0, 140)}` : ""}`);
  const count = (st: string) => rs.filter((r) => r.status === st).length;
  const checks = new Map<string, number>();
  for (const r of rs) for (const [c, v] of Object.entries(r.checks ?? {})) if (v === "fail") checks.set(c, (checks.get(c) ?? 0) + 1);
  const sum = rs.reduce((a, r) => a + r.ms, 0);
  console.log(`\n${count("PASS")} pass, ${count("FAIL")} fail, ${count("SKIP")} skip in ${(wall / 1000).toFixed(0)} s on ${n} workers (${(sum / 1000).toFixed(0)} s of scenario time)`);
  if (checks.size) console.log(`failed checks: ${[...checks].map(([c, k]) => `${c} ${k}`).join(", ")}`);
  // Every latency sample of the run, per kind, against docs/perf/latency.md's p95 budgets.
  const lat = runLatency(rs);
  if (lat.length) console.log(`latency: ${lat.map((l) => `${l.kind} p95 ${l.p95.toFixed(0)} ms (n = ${l.n}, budget ${l.budget})${l.p95 > l.budget ? " OVER" : ""}`).join("; ")}${n > 2 ? ` (${n} workers share the machine: reported, not enforced; QA_SHARDS=1 enforces it)` : ""}`);
}

export function runLatency(rs: Result[]) {
  const by = new Map<string, number[]>();
  for (const r of rs) for (const s of r.lat ?? []) by.set(s.kind, [...(by.get(s.kind) ?? []), s.ms]);
  return [...by].map(([kind, xs]) => {
    const sorted = xs.sort((a, b) => a - b);
    return { kind, n: xs.length, p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)], budget: BUDGET[kind as LatencyKind] };
  });
}

/** After a full --update-baselines run: baselines of scenarios that no longer exist go. */
function pruneBaselines(rs: Result[], matrix: boolean) {
  const dir = matrix ? path.join(BASELINES, "matrix") : BASELINES;
  if (!fs.existsSync(dir)) return;
  const keep = new Set(rs.map((r) => `${r.slug}.png`));
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".png") && !keep.has(f)) { fs.rmSync(path.join(dir, f)); console.log(`removed stale baseline ${path.relative(ROOT, path.join(dir, f))}`); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.QA_WORKER) await worker(parseArgs(process.argv.slice(2)));
  else await main();
}
