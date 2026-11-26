export const UNITS = {
  "open-2000": "ms",
  "launch-last-file": "ms",
  "open-recent": "ms",
  "open-images-2000": "ms",
  "open-images-10k": "ms",
  "open-first-7": "ms",
  "open-warm-7": "ms",
  "server-memory": "MiB",
  "drag-frames": "ms",
  "hover-motion-frames": "ms",
  "pan-zoom-frames": "ms",
  "edit-latency": "ms",
  "native-launch": "ms",
  "native-drag-frames": "ms",
} as const;

export type Metric = keyof typeof UNITS;
export const METRICS = Object.keys(UNITS) as Metric[];
export const NATIVE_METRICS: readonly Metric[] = ["native-launch", "native-drag-frames", "launch-last-file", "open-recent", "open-first-7", "open-warm-7", "open-images-2000", "open-images-10k"];
export const WEB_METRICS = METRICS.filter((id) => !NATIVE_METRICS.includes(id));
export const SAMPLE_COUNT = 5;
const MIN_TOLERANCE = 0.05;
const MAX_RATCHET_SPREAD = 0.05;

export type Machine = { cpu: string; cores: number; memoryGiB: number; os: string; arch: string };
export type Measurement = { median: number; spread: number };
type BudgetSource = { date: string; commit: string };
export type Budget = BudgetSource & { value: number; spread: number; tolerance: number };
export type Entry = { machine: Machine; metrics: Partial<Record<Metric, Budget>> };
export type Budgets = { version: 2; machines: Entry[] };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const validSpread = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isFinite(2 * value);
const toleranceFor = (spread: number) => Math.max(MIN_TOLERANCE, 2 * spread);
const date = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = new Date(value);
  return Number.isFinite(+time) && time.toISOString().slice(0, 10) === value;
};

export function findMachine(budgets: Budgets, machine: Machine): Entry | undefined {
  return budgets.machines.find(({ machine: other }) =>
    other.cpu === machine.cpu && other.cores === machine.cores && other.memoryGiB === machine.memoryGiB &&
    other.os === machine.os && other.arch === machine.arch);
}

export function parseBudgets(json: string): Budgets {
  const data: unknown = JSON.parse(json);
  if (!object(data) || !fields(data, ["version", "machines"]) || data.version !== 2 || !Array.isArray(data.machines)) {
    throw new Error("Invalid performance budgets file");
  }
  const parsed: Budgets = { version: 2, machines: [] };
  for (const entry of data.machines) {
    if (!object(entry) || !fields(entry, ["machine", "metrics"]) || !object(entry.machine) || !object(entry.metrics)) {
      throw new Error("Invalid machine entry in performance budgets");
    }
    const { cpu, cores, memoryGiB, os, arch } = entry.machine;
    if (!fields(entry.machine, ["cpu", "cores", "memoryGiB", "os", "arch"]) ||
        typeof cpu !== "string" || !/^[\w .()+@-]{1,100}$/.test(cpu) ||
        !positive(cores) || !Number.isInteger(cores) || !positive(memoryGiB) ||
        typeof os !== "string" || !/^[a-z0-9]+$/.test(os) ||
        typeof arch !== "string" || !/^[a-z0-9]+$/.test(arch)) {
      throw new Error("Invalid machine class in performance budgets");
    }
    const machine = { cpu, cores, memoryGiB, os, arch };
    if (findMachine(parsed, machine)) throw new Error("Duplicate machine class in performance budgets");
    const metrics: Entry["metrics"] = {};
    for (const [id, budget] of Object.entries(entry.metrics)) {
      if (!Object.hasOwn(UNITS, id) || !object(budget) || !fields(budget, ["value", "spread", "tolerance", "date", "commit"]) ||
          !positive(budget.value) || !validSpread(budget.spread) || budget.tolerance !== toleranceFor(budget.spread) ||
          typeof budget.date !== "string" || !date(budget.date) ||
          typeof budget.commit !== "string" || !/^[a-f0-9]{40}$/.test(budget.commit)) {
        throw new Error("Invalid metric in performance budgets");
      }
      metrics[id as Metric] = {
        value: budget.value, spread: budget.spread, tolerance: budget.tolerance, date: budget.date, commit: budget.commit,
      };
    }
    parsed.machines.push({ machine, metrics });
  }
  return parsed;
}

export function recordBudget({ median, spread }: Measurement, source: BudgetSource): Budget {
  return { value: median, spread, tolerance: toleranceFor(spread), ...source };
}

export function compare(budget: Budget | undefined, { median, spread }: Measurement, update = false) {
  if (!positive(median) || !validSpread(spread)) throw new Error("Expected a positive median and a finite spread");
  if (update) return "update";
  if (!budget) return "missing";
  if (median > budget.value * (1 + budget.tolerance)) return "fail";
  if (spread < MAX_RATCHET_SPREAD && median < budget.value * (1 - budget.tolerance)) return "ratchet";
  return "pass";
}

export function summarize(samples: number[]): Measurement {
  if (samples.length !== SAMPLE_COUNT || !samples.every(positive)) throw new Error("Expected five positive, finite measurements");
  const [min, , median, , max] = [...samples].sort((a, b) => a - b);
  return { median, spread: (max - min) / median };
}
