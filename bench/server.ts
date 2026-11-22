// Server benchmark: in-process cost of the pure functions, HTTP latency, payload sizes, CPU/RSS, SSE latency.
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { OUT, PORT, ROOT, round, sleep, stats, type BenchFile } from "./lib.ts";

type Stat = { heapUsed: number; rss: number; external: number; arrayBuffers: number; cpuUserMs: number; cpuSystemMs: number };

export async function startHost(options: { port?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ proc: ChildProcess; stats: (gc?: boolean) => Promise<Stat>; stop: () => void }> {
  const proc = fork(path.join(ROOT, "bench/server-host.ts"), [], { env: { ...process.env, CANVAS_ROOTS: "", ...options.env, CANVAS_PORT: String(options.port ?? PORT) }, execArgv: ["--expose-gc"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => { proc.kill("SIGKILL"); rej(new Error("server host startup timed out")); }, 30_000);
    proc.once("message", (m: any) => { clearTimeout(timer); if (m.ready) res(); else { proc.kill(); rej(new Error("bad ready")); } });
    proc.once("error", (e) => { clearTimeout(timer); rej(e); });
    proc.once("exit", (c) => { clearTimeout(timer); rej(new Error(`server host exited ${c}`)); });
  });
  let id = 0;
  const get = (gc = false) => new Promise<Stat>((res, rej) => {
    const my = ++id;
    const cleanup = () => { clearTimeout(timer); proc.off("message", reply); };
    const reply = (m: any) => { if (m.id === my) { cleanup(); res(m.stats); } };
    const timer = setTimeout(() => { cleanup(); rej(new Error("server host stats timed out")); }, 10_000);
    proc.on("message", reply);
    proc.send({ id: my, gc }, (error) => { if (error) { cleanup(); rej(error); } });
  });
  return { proc, stats: get, stop: () => proc.kill("SIGTERM") };
}

const base = `http://127.0.0.1:${PORT}`;
async function timed(url: string) {
  const t0 = performance.now();
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  return { ms: performance.now() - t0, status: r.status, raw: buf.length, buf };
}
const mb = (n: number) => round(n / 1048576, 1);

export async function serverBench(files: BenchFile[], log: (s: string) => void, opts: { inproc?: boolean; scan?: boolean } = {}) {
  const { inproc = true, scan = true } = opts;
  const result: any = { files: {} };

  // ---- A. in-process, fresh process per file
  for (const f of files) {
    if (!inproc) { result.files[f.label] = { file: f.path, bytes: f.bytes, synthetic: !!f.synthetic }; continue; }
    log(`inproc ${f.label}`);
    const out = execFileSync(process.execPath, ["--expose-gc", path.join(ROOT, "bench/inproc.ts"), f.path], { maxBuffer: 1 << 28, encoding: "utf8", env: { ...process.env, BENCH_INPROC_N: f.bytes > 1e7 ? "8" : "12" } });
    result.files[f.label] = { file: f.path, bytes: f.bytes, synthetic: !!f.synthetic, inproc: JSON.parse(out.trim().split("\n").pop()!) };
  }

  // ---- B. HTTP against the real server in its own process
  const host = await startHost();
  try {
    const base0 = await host.stats(true);
    result.serverBaseline = { heapMb: mb(base0.heapUsed), rssMb: mb(base0.rss) };

    // /api/files: background scan over the roots in BENCH_SCAN_ROOTS (default: the bench's own copies folder), time to first non-empty and stable list
    // (the host runs with CANVAS_ROOTS="" so scan is a no-op there; measure it with a one-off server instance below)

    for (const f of files) {
      log(`http ${f.label}`);
      const file = encodeURIComponent(f.path);
      const R: any = result.files[f.label];
      const before = await host.stats(true);

      // doc: first request is cold (loadDoc + snapshotOf + stringify), rest hit filesSeen but still call loadDoc
      const first = await timed(`${base}/api/doc?file=${file}`);
      const docInfo = JSON.parse(first.buf.toString());
      const afterLoad = await host.stats(true);
      const N_DOC = f.bytes > 1e7 ? 15 : 30;
      const c0 = await host.stats();
      const docMs: number[] = [];
      for (let i = 0; i < N_DOC; i++) docMs.push((await timed(`${base}/api/doc?file=${file}`)).ms);
      const c1 = await host.stats();
      R.http = {
        docFirstMs: round(first.ms), docRawBytes: first.raw, docGzipBytes: gzipSync(first.buf).length, docWarm: stats(docMs),
        docCpuMsPerReq: round((c1.cpuUserMs + c1.cpuSystemMs - c0.cpuUserMs - c0.cpuSystemMs) / N_DOC),
        boards: docInfo.boards.length,
        heapAfterLoadMb: mb(afterLoad.heapUsed - before.heapUsed), rssAfterLoadMb: mb(afterLoad.rss - before.rss),
      };

      // board: every board, REPS repeats; per-board p50/p95/max rolled up
      const REPS = docInfo.boards.length > 100 ? 3 : 5;
      const perBoard: { id: string; ms: number[]; raw: number; gz: number; html: number }[] = [];
      const b0 = await host.stats();
      for (const b of docInfo.boards as { id: string }[]) {
        const ms: number[] = []; let raw = 0, gz = 0;
        for (let i = 0; i < REPS; i++) {
          const r = await timed(`${base}/api/board?file=${file}&id=${encodeURIComponent(b.id)}`);
          ms.push(r.ms); raw = r.raw; if (i === 0) gz = gzipSync(r.buf).length;
        }
        perBoard.push({ id: b.id, ms, raw, gz, html: raw });
      }
      const b1 = await host.stats();
      const all = perBoard.flatMap((p) => p.ms);
      const medians = perBoard.map((p) => stats(p.ms).p50);
      R.http.board = {
        reps: REPS, requests: all.length, latency: stats(all), perBoardP50: stats(medians),
        cpuMsPerReq: round((b1.cpuUserMs + b1.cpuSystemMs - b0.cpuUserMs - b0.cpuSystemMs) / all.length),
        rawBytes: stats(perBoard.map((p) => p.raw)), gzipBytes: stats(perBoard.map((p) => p.gz)),
        totalRawBytes: perBoard.reduce((a, p) => a + p.raw, 0), totalGzipBytes: perBoard.reduce((a, p) => a + p.gz, 0),
        slowest: perBoard.map((p) => ({ id: p.id, p50: stats(p.ms).p50, max: stats(p.ms).max, rawBytes: p.raw })).sort((a, b) => b.p50 - a.p50).slice(0, 3),
      };

      // concurrency: what the page does when it enters an overview: up to 12 board fetches at once
      const ids = (docInfo.boards as { id: string }[]).slice(0, 12).map((b) => b.id);
      const burst: number[] = [];
      for (let k = 0; k < 3; k++) { const t0 = performance.now(); await Promise.all(ids.map((id) => timed(`${base}/api/board?file=${file}&id=${encodeURIComponent(id)}`))); burst.push(performance.now() - t0); }
      R.http.burst12 = { wallMs: stats(burst), sequentialEstimateMs: round((R.http.board.perBoardP50.p50 || 0) * ids.length) };

      // node: inspector fetch. Use a deep-ish child of the first 20 boards
      const nodeIds: string[] = [];
      try {
        const raw = JSON.parse(fs.readFileSync(f.path, "utf8"));
        for (const b of raw.children.slice(0, 20)) { let n = b; for (let d = 0; d < 3 && n.children?.length; d++) n = n.children[0]; nodeIds.push(String(n.id)); }
      } catch {}
      const nodeMs: number[] = []; let nodeRaw = 0;
      for (const id of nodeIds) for (let i = 0; i < 3; i++) { const r = await timed(`${base}/api/node?file=${file}&id=${encodeURIComponent(id)}`); if (r.status === 200) { nodeMs.push(r.ms); nodeRaw = r.raw; } }
      R.http.node = nodeMs.length ? { latency: stats(nodeMs), lastRawBytes: nodeRaw } : null;

      // memory growth after the storm
      const end = await host.stats(true);
      R.http.afterStorm = { heapUsedMb: mb(end.heapUsed), rssMb: mb(end.rss), heapGrowthMb: mb(end.heapUsed - before.heapUsed), rssGrowthMb: mb(end.rss - before.rss) };
      R.http.totalCpuMs = round(end.cpuUserMs + end.cpuSystemMs - before.cpuUserMs - before.cpuSystemMs);
    }

    // ---- C. file change -> SSE broadcast latency, on copies in bench/out
    for (const f of files) {
      log(`sse ${f.label}`);
      const copy = path.join(OUT, `sse-${f.label}.canvas.json`);
      fs.copyFileSync(f.path, copy);
      const real = fs.realpathSync(copy);
      const raw0 = fs.readFileSync(copy, "utf8");
      const ctl = new AbortController();
      const r = await fetch(`${base}/events?file=${encodeURIComponent(real)}`, { signal: ctl.signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "", docEvents = 0, lastBytes = 0, lastKind = "doc";
      const waiters: ((bytes: number) => void)[] = [];
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
              if (/^event: doc(diff)?$/m.test(chunk)) { docEvents++; lastBytes = chunk.length; lastKind = chunk.startsWith("event: docdiff") ? "docdiff" : "doc"; waiters.shift()?.(chunk.length); }
            }
          }
        } catch {}
      })();
      const nextDoc = () => new Promise<number>((res) => waiters.push(res));
      const initial = nextDoc(); await initial;
      const lat: number[] = [];
      const s0 = await host.stats();
      for (let i = 0; i < 6; i++) {
        await sleep(400); // let the watcher settle between edits
        const tmp = copy + ".tmp";
        fs.writeFileSync(tmp, raw0 + " ".repeat(i + 1)); // same JSON, new bytes -> new revision
        const wait = nextDoc();
        const t0 = performance.now();
        fs.renameSync(tmp, copy); // an outside save renames over the old file
        await Promise.race([wait, sleep(5000)]);
        lat.push(performance.now() - t0);
      }
      const spaceBytes = lastBytes, spaceKind = lastKind;
      // three real edits: move the first board, so one board changes
      const editLat: number[] = [];
      const edited = JSON.parse(raw0);
      for (let i = 0; i < 3; i++) {
        await sleep(400);
        edited.children[0].x = (edited.children[0].x ?? 0) + 7;
        const tmp = copy + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(edited, null, 2));
        const wait = nextDoc();
        const t0 = performance.now();
        fs.renameSync(tmp, copy);
        await Promise.race([wait, sleep(5000)]);
        editLat.push(performance.now() - t0);
      }
      const s1 = await host.stats();
      ctl.abort();
      result.files[f.label].sse = { latency: stats(lat), samples: lat.map((x) => round(x)), payloadBytes: spaceBytes, payloadKind: spaceKind, editLatency: stats(editLat), editPayloadBytes: lastBytes, editPayloadKind: lastKind, cpuMsPerChange: round((s1.cpuUserMs + s1.cpuSystemMs - s0.cpuUserMs - s0.cpuSystemMs) / (lat.length + editLat.length)), heapGrowthMb: mb(s1.heapUsed - s0.heapUsed) };
      fs.rmSync(copy, { force: true });
      await sleep(300);
    }
    const fin = await host.stats(true);
    result.serverFinal = { heapMb: mb(fin.heapUsed), rssMb: mb(fin.rss), cpuMsTotal: round(fin.cpuUserMs + fin.cpuSystemMs) };
  } finally {
    host.stop();
  }

  // ---- D. /api/files scan, own throwaway instance on PORT+1: the bench's copies folder, or BENCH_SCAN_ROOTS (path list)
  if (!scan) return result;
  log("files scan");
  const p2 = fork(path.join(ROOT, "bench/server-host.ts"), [], { env: { ...process.env, CANVAS_PORT: String(PORT + 1), CANVAS_ROOTS: process.env.BENCH_SCAN_ROOTS || path.join(ROOT, "bench", "out", "copies") }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  await new Promise<void>((res) => p2.once("message", () => res()));
  try {
    const t0 = performance.now();
    let first = 0, count = 0, last = 0, stableSince = 0;
    for (;;) {
      const r = await (await fetch(`http://127.0.0.1:${PORT + 1}/api/files`)).json() as unknown[];
      const now = performance.now() - t0;
      if (r.length && !first) first = now;
      if (r.length !== last) { last = r.length; stableSince = now; }
      count = r.length;
      if ((first && now - stableSince > 3000) || now > 20000) break;
      await sleep(100);
    }
    const warm: number[] = [];
    for (let i = 0; i < 20; i++) warm.push((await timed(`http://127.0.0.1:${PORT + 1}/api/files`)).ms);
    result.filesScan = { firstNonEmptyMs: round(first), listSize: count, settledMs: round(stableSince), warmRequest: stats(warm) };
  } finally { p2.kill("SIGTERM"); }
  return result;
}
