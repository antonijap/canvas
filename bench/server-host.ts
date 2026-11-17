// Runs Canvas's real server (src/server.ts, unchanged) in its own process so CPU and memory are
// attributable to it, and answers { stats } over IPC.
import { startServer } from "../src/server.ts";

process.env.CANVAS_ROOTS ??= "";
await startServer(Number(process.env.CANVAS_PORT ?? 5199));
const snap = (gc: boolean) => {
  if (gc) (globalThis as any).gc?.();
  const m = process.memoryUsage();
  const c = process.cpuUsage();
  return { heapUsed: m.heapUsed, rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers, cpuUserMs: c.user / 1000, cpuSystemMs: c.system / 1000 };
};
process.on("message", (m: any) => process.send?.({ id: m.id, stats: snap(!!m.gc) }));
// BENCH_SERVER_PROF=<file>: a CPU profile of the whole run, written when the host is stopped.
if (process.env.BENCH_SERVER_PROF) {
  const { Session } = await import("node:inspector/promises");
  const fs = await import("node:fs");
  const s = new Session();
  s.connect();
  await s.post("Profiler.enable");
  await s.post("Profiler.setSamplingInterval", { interval: 200 });
  await s.post("Profiler.start");
  process.prependOnceListener("SIGTERM", async () => {
    const { profile } = await s.post("Profiler.stop");
    fs.writeFileSync(process.env.BENCH_SERVER_PROF!, JSON.stringify(profile));
    process.exit(0);
  });
}
process.send?.({ ready: true });
