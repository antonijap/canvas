import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../qa/lib.ts";
import { compare, findMachine, METRICS, NATIVE_METRICS, parseBudgets, recordBudget, SAMPLE_COUNT, summarize, UNITS, WEB_METRICS, type Budgets, type Machine, type Metric } from "./perf-budgets.ts";
import { hasNativeBuild, measurements } from "./perf-measure.ts";

const FILE = path.join(ROOT, "bench", "budgets.json");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const number = (value: number) => value.toFixed(2);

function flags(args: string[]) {
  const update = args.includes("--update");
  const quick = args.includes("--quick");
  const keys: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--update" || args[i] === "--quick") continue;
    if (args[i] !== "--only" || keys.length) throw new Error(`Unknown argument: ${args[i]}`);
    while (args[i + 1] && !args[i + 1].startsWith("-")) keys.push(...args[++i].split(","));
    if (!keys.length) throw new Error("--only requires one or more metric IDs");
  }
  for (const id of keys) if (!Object.hasOwn(UNITS, id)) throw new Error(`Unknown metric ${id}. Choose from ${METRICS.join(", ")}.`);
  const available = quick ? WEB_METRICS : METRICS;
  for (const id of keys as Metric[]) {
    if (!available.includes(id)) throw new Error(`${id} is unavailable in --quick mode`);
  }
  return { update, ids: available.filter((id) => !keys.length || keys.includes(id)) };
}

function currentMachine(): Machine {
  let cpu = os.cpus()[0]?.model.trim() ?? "";
  if (process.platform === "darwin") {
    cpu = execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim();
  }
  return { cpu, cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30), os: process.platform, arch: process.arch };
}

function saveBudgets(original: string, budgets: Budgets) {
  const json = JSON.stringify(budgets, null, 2) + "\n";
  parseBudgets(json);
  const lock = `${FILE}.lock`;
  fs.mkdirSync(lock);
  try {
    if (fs.readFileSync(FILE, "utf8") !== original) throw new Error("Budgets changed during the measurement. Rerun the gate.");
    const pending = path.join(lock, "budgets.json");
    fs.writeFileSync(pending, json);
    fs.renameSync(pending, FILE);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

async function main() {
  // Measure the engine these sources build, never a stale engine/pkg.
  execFileSync("bash", [path.join(ROOT, "scripts/ensure-engine.sh")], { stdio: ["ignore", "ignore", "inherit"] });
  const { update, ids } = flags(process.argv.slice(2));
  const started = performance.now();
  const original = fs.readFileSync(FILE, "utf8");
  const budgets = parseBudgets(original);
  const machine = currentMachine();
  const existing = findMachine(budgets, machine);
  const entry = existing ?? { machine, metrics: {} };
  const commit = git("rev-parse", "HEAD");
  const date = new Date().toISOString().slice(0, 10);
  const changes: string[] = [];
  const native = hasNativeBuild();
  const machineName = `${machine.cpu}, ${machine.cores} cores, ${machine.memoryGiB} GiB, ${machine.os}/${machine.arch}`;
  let failed = false;
  let needs = false;
  console.log(`Machine: ${machineName}`);

  const active = ids.filter((id) => {
    if (native || !NATIVE_METRICS.includes(id)) return true;
    console.log(`SKIP ${id}: no native QA build at build/perf-native/Canvas QA.app`);
    return false;
  });
  const collected = new Map(active.map((id) => [id, [] as number[]]));
  for (let round = 1; round <= SAMPLE_COUNT && collected.size; round++) {
    console.log(`Measurement pass ${round}/${SAMPLE_COUNT} (one warm-up and one sample per metric)`);
    const runner = measurements();
    try {
      for (const [id, samples] of collected) {
        const gating = id !== "native-launch";
        try {
          console.log(`Measuring ${id}`);
          await runner.measure(id);
          samples.push(await runner.measure(id));
        } catch (err) {
          collected.delete(id);
          if (gating) failed = true;
          console.log(`${gating ? "FAIL" : "SKIP"} ${id}: ${(err as Error).message.split("\n")[0]}`);
        }
      }
    } finally {
      await runner.close();
    }
  }

  for (const [id, samples] of collected) {
    const budget = entry.metrics[id];
    const gating = id !== "native-launch";
    try {
      const result = summarize(samples);
      const report = `${number(result.median)} ${UNITS[id]} (spread ${number(result.spread * 100)}%, samples ${samples.map(number).join(", ")})`;
      const prev = budget ? `${number(budget.value)} ${UNITS[id]} (+${number(budget.tolerance * 100)}% tolerance)` : "none";
      const details = `${id}: measured ${report}, budget ${prev}`;
      if (!gating && !update) {
        console.log(`PASS ${details}. Report only.`);
        continue;
      }
      const outcome = compare(budget, result, update);
      if (outcome === "fail") {
        failed = true;
        let commits: string;
        try {
          commits = git("log", "--format=%h %s", `${budget!.commit}..${commit}`).replaceAll("\n", " | ") || "none since the recorded commit";
        } catch {
          commits = "history unavailable in this checkout";
        }
        console.log(`FAIL ${details}. Commits since ${budget!.commit.slice(0, 12)}: ${commits}`);
      } else if (outcome === "missing") {
        needs = true;
        console.log(`NEEDS-MAINTAINER ${details}. Use --update to record this budget.`);
      } else if (outcome === "update" || outcome === "ratchet") {
        entry.metrics[id] = recordBudget(result, { date, commit });
        changes.push(`PASS ${outcome === "ratchet" ? "Ratchet" : "Baseline update"} ${details}${gating ? "" : ". Report only."}`);
      } else {
        console.log(`PASS ${details}`);
      }
    } catch (err) {
      if (gating) failed = true;
      console.log(`${gating ? "FAIL" : "SKIP"} ${id}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  if (changes.length && !failed && !needs) {
    if (!existing) budgets.machines.push(entry);
    saveBudgets(original, budgets);
    for (const change of changes) console.log(change);
  }
  if (update && !changes.length && !failed) {
    needs = true;
    console.log("NEEDS-MAINTAINER No measurements were available to create a machine entry.");
  }
  console.log(`Performance gate finished in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
  process.exitCode = failed ? 1 : needs ? 2 : 0;
}

try {
  await main();
} catch (err) {
  console.log(`FAIL ${(err as Error).message.split("\n")[0]}`);
  process.exitCode = 1;
}
