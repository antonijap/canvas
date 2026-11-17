// Server-side structure ops and flush, in process, on a generated stress file: per-op timings and (PROF=1) a CPU
// profile summary of where the time goes. Used to drive and check the incremental structure work.
//
//   node bench/structure-prof.ts [boards=2000] [rounds=20]      PROF=1 for the profile
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "node:inspector/promises";
import { fixture, scratchCopy } from "./fixtures/gen.ts";

const boards = Number(process.argv[2] ?? 2000), rounds = Number(process.argv[3] ?? 20);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-sprof-"));
const f = scratchCopy(fixture(boards), tmp, `s${boards}.canvas`);
process.env.CANVAS_ROOTS = tmp;
process.env.CANVAS_WEB_FONTS = "0";
process.env.CANVAS_MCP_NO_SPAWN = "1";
process.env.CANVAS_TRUST_FILE = path.join(tmp, ".trust.json");
process.env.CANVAS_SECURITY_BIN = "/usr/bin/false";
const port = 5400 + Math.floor(Math.random() * 400);
const { startServer } = await import("../src/server.ts");
const pw = await import("../src/docwriter.ts");
const phases: Record<string, number[]> = {};
const server = await startServer(port);
const base = `http://127.0.0.1:${port}`;
const post = async (p: string, b: unknown) => {
  const r = await fetch(base + p, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(b) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10; };
// Warm: load the document.
await fetch(`${base}/api/doc?file=${encodeURIComponent(f.dir)}`).then((r) => r.text());
await post("/api/update", { file: f.dir, id: `${f.heroBoards[0]}-sq1`, props: { opacity: 0.95 } });
await post("/api/flush", { file: f.dir });

const prof = process.env.PROF === "1" ? new Session() : null;
if (prof) { prof.connect(); await prof.post("Profiler.enable"); await prof.post("Profiler.setSamplingInterval", { interval: 100 }); await prof.post("Profiler.start"); }
const by: Record<string, number[]> = { duplicate: [], reorder: [], group: [], ungroup: [], delete: [], update: [], flush: [] };
for (let k = 0; k < rounds; k++) {
  const h = f.heroBoards[(k * 7) % f.heroBoards.length];
  const t = async (op: string, body: Record<string, unknown>) => { const t0 = performance.now(); const r = await post("/api/structure", { file: f.dir, op, ...body }); by[op].push(performance.now() - t0); return r; };
  const dup = await t("duplicate", { ids: [`${h}-sq1`] });
  const copy = dup.select[0];
  await t("reorder", { ids: [copy], dir: "back" });
  const g = await t("group", { ids: [copy, `${h}-dot1`] });
  await t("ungroup", { ids: [g.select[0]] });
  await t("delete", { ids: [copy] });
  let t0 = performance.now();
  await post("/api/update", { file: f.dir, id: `${h}-sq1`, props: { opacity: k % 2 ? 1 : 0.9 } });
  by.update.push(performance.now() - t0);
  t0 = performance.now();
  await post("/api/flush", { file: f.dir });
  by.flush.push(performance.now() - t0);
  // The write that flush waited for: its phases (docwriter writerStats).
  const lw = pw.writerStats(fs.realpathSync(f.file))?.lastWrite as Record<string, number> | undefined;
  if (lw) for (const [k, v] of Object.entries(lw)) if (k !== "bytes") (phases[k] ??= []).push(v);
}
if (prof) {
  const { profile } = await prof.post("Profiler.stop");
  const self = new Map<string, number>();
  const dt = profile.timeDeltas ?? [];
  const byId = new Map(profile.nodes.map((n: any) => [n.id, n]));
  (profile.samples ?? []).forEach((id: number, i: number) => {
    const n: any = byId.get(id);
    const key = `${n.callFrame.functionName || "(anon)"} ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log(`profile: ${Math.round(total)} ms sampled`);
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP ?? 30))) console.log(`  ${v.toFixed(1).padStart(8)} ms  ${k}`);
  fs.writeFileSync(path.join(tmp, "structure.cpuprofile"), JSON.stringify(profile));
}
console.log(`${boards} boards, ${f.nodes} nodes, ${(f.bytes / 1048576).toFixed(1)} MB, ${rounds} rounds`);
for (const [op, xs] of Object.entries(by)) console.log(`  ${op.padEnd(10)} p50 ${String(pct(xs, 50)).padStart(6)}  p95 ${String(pct(xs, 95)).padStart(6)}  max ${String(pct(xs, 100)).padStart(6)} ms`);
if (Object.keys(phases).length) console.log("  write phases (p50 / p95 ms): " + Object.entries(phases).map(([k, xs]) => `${k} ${pct(xs, 50)} / ${pct(xs, 95)}`).join(", "));
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
