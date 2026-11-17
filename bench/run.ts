// pnpm bench:baseline: server + page baseline. Writes bench/out/results.json and prints a summary table.
// Files: the generated 200- and 2,000-board stress files (bench/fixtures/gen.ts) and the 200 x 50 synthetic file;
// BENCH_FILE adds a real .canvas package or .canvas.json of your own (copied first; the original is never opened).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OUT, PORT, round, writeSynthetic, type BenchFile } from "./lib.ts";
import { fixture } from "./fixtures/gen.ts";
import { pageBench, SCENARIOS, type ScenarioName } from "./page.ts";
import { serverBench, startHost } from "./server.ts";

const log = (s: string) => console.error(`[bench] ${s}`);
const args = new Set(process.argv.slice(2));
fs.mkdirSync(OUT, { recursive: true });

const sh = (cmd: string, a: string[]) => { try { return execFileSync(cmd, a, { encoding: "utf8" }).trim(); } catch { return ""; } };
const env = {
  date: new Date().toISOString(), machine: sh("sysctl", ["-n", "machdep.cpu.brand_string"]), cores: os.cpus().length, memGb: round(os.totalmem() / 2 ** 30, 0),
  os: `${os.type()} ${os.release()}`, macos: sh("sw_vers", ["-productVersion"]), node: process.version, load1: round(os.loadavg()[0], 2),
};

// Every file is measured as a copy in bench/out/copies; an original is never opened by the server.
const copyDir = path.join(OUT, "copies");
fs.mkdirSync(copyDir, { recursive: true });
const copyAs = (label: string, src: string): BenchFile => {
  const dest = path.join(copyDir, `${label}.canvas.json`);
  fs.copyFileSync(src, dest);
  return { label, path: fs.realpathSync(dest), bytes: fs.statSync(dest).size };
};
const real: BenchFile[] = [200, 2000].map((n) => copyAs(`stress-${n}`, fixture(n).file));
if (process.env.BENCH_FILE) {
  const src = process.env.BENCH_FILE.endsWith(".canvas") ? path.join(process.env.BENCH_FILE, "document.json") : process.env.BENCH_FILE;
  real.unshift(copyAs("real", src));
}
const synthPath = path.join(OUT, "synthetic-200x50.canvas.json");
writeSynthetic(synthPath);
const files: BenchFile[] = [...real, { label: "synthetic-200x50", path: synthPath, bytes: fs.statSync(synthPath).size, synthetic: true }];
const pick = process.env.BENCH_FILES?.split(",");
const use = pick ? files.filter((f) => pick.includes(f.label)) : files;
log(`files: ${use.map((f) => `${f.label} ${(f.bytes / 1048576).toFixed(1)}MB`).join(", ")}`);

const results: any = { env, files: use.map((f) => ({ label: f.label, path: f.path, bytes: f.bytes, synthetic: !!f.synthetic })) };

// --quick: server HTTP + SSE + memory only (no per-function inproc runs, no /api/files scan), about 1 minute.
const quick = args.has("--quick");
if (!args.has("--page-only")) results.server = await serverBench(use, log, { inproc: !quick, scan: !quick });
if (!args.has("--server-only") && !quick) {
  // page runs talk to a fresh server instance on PORT
  const host = await startHost();
  try {
    const sc = process.env.BENCH_SCENARIOS?.split(",") as ScenarioName[] | undefined;
    results.page = await pageBench(use, log, host.stats, { scenarios: sc ?? SCENARIOS });
    results.pageServerAfter = await host.stats(true);
  } finally { host.stop(); }
  env.chrome = results.page.chrome.version;
}
results.env = env;
fs.writeFileSync(path.join(OUT, process.env.BENCH_RESULTS ?? "results.json"), JSON.stringify(results, null, 1));

// ---------------------------------------------------------------- summary
// one run per (file, scenario): the one with the median settle time
const medianRuns = (rs: any[]) => {
  const g = new Map<string, any[]>();
  for (const r of rs) g.set(`${r.file}|${r.scenario}`, [...(g.get(`${r.file}|${r.scenario}`) ?? []), r]);
  return [...g.values()].map((v) => v.sort((a, b) => (a.load.settledMs ?? 1e9) - (b.load.settledMs ?? 1e9))[Math.floor((v.length - 1) / 2)]);
};
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const rpad = (s: unknown, n: number) => String(s).padStart(n);
const table = (title: string, head: string[], rows: unknown[][]) => {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  console.log(`\n${title}`);
  console.log(head.map((h, i) => (i ? rpad(h, w[i]) : pad(h, w[i]))).join("  "));
  for (const r of rows) console.log(r.map((c, i) => (i ? rpad(c, w[i]) : pad(c, w[i]))).join("  "));
};
console.log(`\nEnv: ${env.machine}, ${env.cores} cores, ${env.memGb} GB, macOS ${env.macos}, Node ${env.node}${env.chrome ? `, ${env.chrome}` : ""}`);
if (results.server) {
  const F = Object.entries<any>(results.server.files);
  if (!quick) table("Server: in-process (ms)", ["file", "MB", "cold load", "cold snap", "warm load p50", "warm snap p50", "boardHtml p50", "boardHtml max"],
    F.map(([k, v]) => [k, round(v.bytes / 1048576, 1), round(v.inproc.cold.loadDocMs, 0), round(v.inproc.cold.snapshotOfMs, 0), v.inproc.warm.loadDoc.p50, v.inproc.warm.snapshotOf.p50, v.inproc.boardHtml.warm.p50, v.inproc.boardHtml.warm.max]));
  table("Server: HTTP (ms)", ["file", "doc cold", "doc p50", "doc p95", "board p50", "board p95", "board max", "node p50", "burst12 wall", "sse p50", "sse max", "sse KB", "edit sse p50", "edit sse KB"],
    F.map(([k, v]) => [k, v.http.docFirstMs, v.http.docWarm.p50, v.http.docWarm.p95, v.http.board.latency.p50, v.http.board.latency.p95, v.http.board.latency.max, v.http.node?.latency.p50 ?? "-", v.http.burst12.wallMs.p50, v.sse.latency.p50, v.sse.latency.max, round(v.sse.payloadBytes / 1024, 1), v.sse.editLatency.p50, round(v.sse.editPayloadBytes / 1024, 1)]));
  table("Server: payload + memory", ["file", "doc KB", "doc gz KB", "board avg KB", "board gz KB", "all boards MB", "heap after load MB", "heap growth MB", "RSS growth MB", "cpu ms/board req"],
    F.map(([k, v]) => [k, round(v.http.docRawBytes / 1024, 0), round(v.http.docGzipBytes / 1024, 0), round(v.http.board.rawBytes.mean / 1024, 1), round(v.http.board.gzipBytes.mean / 1024, 1), round(v.http.board.totalRawBytes / 1048576, 1), v.http.heapAfterLoadMb, v.http.afterStorm.heapGrowthMb, v.http.afterStorm.rssGrowthMb, v.http.board.cpuMsPerReq]));
  if (results.server.filesScan) console.log(`\n/api/files scan: first result ${results.server.filesScan.firstNonEmptyMs} ms, settled ${results.server.filesScan.settledMs} ms, ${results.server.filesScan.listSize} files, warm p50 ${results.server.filesScan.warmRequest.p50} ms`);
}
if (results.page) {
  const runs = results.page.runs.filter((r: any) => !r.traced);
  const loads = runs.filter((r: any) => (r.scenario.startsWith("load")));
  table("Page: load (median of reps, ms)", ["file", "scenario", "FCP", "1st board painted", "all viewport swapped", "swaps", "DOM nodes", "loaded boards", "JS heap MB", "layouts", "recalcs", "script ms", "long tasks", "long total ms"],
    medianRuns(loads).map((r: any) => [r.file, r.scenario, r.load.firstContentfulPaintMs, r.load.firstBoardPaintedMs, r.load.settledMs, r.load.swaps, r.dom.nodes, r.dom.loadedBoards, r.metrics.jsHeapUsedMb, r.metrics.LayoutCount, r.metrics.RecalcStyleCount, round(r.metrics.ScriptDuration * 1000, 0), r.load.longTasks, r.load.longTaskTotalMs]));
  const enters = medianRuns(runs.filter((r: any) => r.scenario.startsWith("enter")).map((r: any) => ({ ...r, load: { settledMs: r.enter.settleMs } })));
  table("Page: zoom out from fit to the overview (camera jump, ms)", ["file", "scenario", "settle", "board reqs", "board KB", "loaded before", "loaded after", "DOM nodes +", "layouts", "recalcs", "task ms"],
    enters.map((r: any) => [r.file, r.scenario, r.enter.settleMs, r.enter.boardRequests, r.enter.boardKB, r.enter.boardsLoadedBefore, r.enter.boardsLoadedAfter, r.enter.domNodesGrowth, r.enter.LayoutCount, r.enter.RecalcStyleCount, round(r.enter.TaskDuration * 1000, 0)]));
  const inter = runs.filter((r: any) => r.interaction);
  table("Page: interaction (5 s, wheel events)", ["file", "scenario", "renderer", "fps", "frame p50", "p95", "p99", "max", ">16.7", ">25", "input rtt p95", "long tasks", "layouts/frame", "recalcs/frame", "main thread busy ms", "board reqs", "idle req/s"],
    inter.map((r: any) => { const f = r.interaction.frames; return [r.file, r.scenario, String(r.renderer ?? "dom").split(" ")[0], f.fps, f.delta.p50, f.delta.p95, f.delta.p99, f.delta.max, f.over16_7, f.over25, r.interaction.inputRtt.p95, f.longTasks, r.interaction.perFrame.layouts, r.interaction.perFrame.recalcs, round(r.interaction.TaskDuration * 1000, 0), r.interaction.boardRequests, r.idle.boardRequestsPerSec]; }));
}
console.log(`\nresults: ${path.join(OUT, process.env.BENCH_RESULTS ?? "results.json")}`);
process.exit(0);
