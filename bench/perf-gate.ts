import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../qa/lib.ts";
import { compare, findMachine, MAX_SPREAD, METRICS, NATIVE_METRICS, parseBudgets, summarize, UNITS, type Budgets, type Machine, type Metric } from "./perf-budgets.ts";
import { hasNativeBuild, measurements } from "./perf-measure.ts";

const FILE = path.join(ROOT, "bench", "budgets.json");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const number = (value: number) => value.toFixed(2);

function flags(args: string[]) {
  const update = args.includes("--update");
  const keys: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--update") continue;
    if (args[i] !== "--only" || keys.length) throw new Error(`Unknown argument: ${args[i]}`);
    while (args[i + 1] && !args[i + 1].startsWith("-")) keys.push(...args[++i].split(","));
    if (!keys.length) throw new Error("--only requires one or more metric IDs");
  }
  for (const id of keys) if (!Object.hasOwn(UNITS, id)) throw new Error(`Unknown metric ${id}. Choose from ${METRICS.join(", ")}.`);
  return { update, ids: keys.length ? [...new Set(keys as Metric[])] : METRICS };
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
  const { update, ids } = flags(process.argv.slice(2));
  const started = performance.now();
  const original = fs.readFileSync(FILE, "utf8");
  const budgets = parseBudgets(original);
  const machine = currentMachine();
  const existing = findMachine(budgets, machine);
  const entry = existing ?? { machine, metrics: {} };
  const commit = git("rev-parse", "HEAD");
  const date = new Date().toISOString().slice(0, 10);
  const runner = measurements();
  const changes: string[] = [];
  const native = hasNativeBuild();
  const machineName = `${machine.cpu}, ${machine.cores} cores, ${machine.memoryGiB} GiB, ${machine.os}/${machine.arch}`;
  let failed = false;
  let needs = !existing && !update;
  if (needs) console.log(`NEEDS-MAINTAINER No budgets for ${machineName}. Use --update to add a separate machine entry.`);
  else console.log(`Machine: ${machineName}`);

  try {
    for (const id of ids) {
      if (NATIVE_METRICS.includes(id) && !native) {
        console.log(`SKIP ${id}: no native QA build at build/perf-native/Canvas QA.app`);
        continue;
      }
      const budget = entry.metrics[id];
      try {
        console.log(`Measuring ${id} (one warm-up, three samples)`);
        await runner.measure(id);
        const batch = async () => {
          const samples = [await runner.measure(id), await runner.measure(id), await runner.measure(id)];
          const { median, spread } = summarize(samples);
          const report = `${number(median)} ${UNITS[id]} (spread ${number(spread * 100)}%, samples ${samples.map(number).join(", ")})`;
          return { median, spread, report };
        };
        let result = await batch();
        if (result.spread > MAX_SPREAD) {
          console.log(`Retrying ${id}: ${result.report}`);
          result = await batch();
        }
        const noisy = result.spread > MAX_SPREAD;
        const outcome = compare(budget, result.median, update);
        const prev = budget ? `${number(budget.value)} ${UNITS[id]}` : "no budget";
        const details = `${id}: measured ${result.report}, budget ${prev}`;
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
        } else if (outcome === "update" || (outcome === "ratchet" && !noisy)) {
          entry.metrics[id] = { value: result.median, date, commit };
          changes.push(`PASS ${outcome === "ratchet" ? "Ratchet" : "Baseline update"} ${details}`);
        } else {
          console.log(`PASS ${details}${noisy ? ". Spread still exceeds 5% after retry." : ""}`);
        }
      } catch (err) {
        failed = true;
        console.log(`FAIL ${id}: ${(err as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    await runner.close();
  }
  if (changes.length) {
    if (!existing) budgets.machines.push(entry);
    saveBudgets(original, budgets);
    for (const change of changes) console.log(change);
  }
  if (!existing && !changes.length && !needs) {
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
