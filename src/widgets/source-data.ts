import { isObject } from "./check.ts";
import { pick } from "./jsonpath.ts";
import { WidgetError } from "./types.ts";

export function gitData(status: string, log: string) {
  const records = status.split("\0");
  let branch = "HEAD", changed = 0, ahead: number | null = null, behind: number | null = null;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.startsWith("# branch.head ")) branch = row.slice(14);
    else if (row.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(row);
      if (match) [ahead, behind] = [Number(match[1]), Number(match[2])];
    } else if (/^[12u?] /.test(row)) {
      changed++;
      if (row.startsWith("2 ")) i++; // A rename includes a second NUL-terminated path.
    }
  }
  const commits = log.trimEnd().split("\n").filter(Boolean).slice(0, 5).map((row) => {
    const tab = row.indexOf("\t");
    return { id: row.slice(0, tab), title: row.slice(tab + 1, tab + 301) };
  });
  return { branch: branch === "(detached)" ? "Detached HEAD" : branch, changed, ahead, behind, commits };
}

const records = (data: unknown) => Array.isArray(data) ? data.filter(isObject) : [];
const label = (v: unknown) => typeof v === "string" ? v.slice(0, 300) : "";
const githubLink = (v: unknown) => {
  const url = label(v);
  return /^https:\/\/github\.com\//.test(url) ? url : "";
};

export function ciData(runs: unknown, pulls: unknown, jobs: unknown[]) {
  return {
    runs: records(runs).slice(0, 5).map((row, i) => ({
      name: label(row.name), result: label(row.conclusion || row.status), url: githubLink(row.url),
      failed: records(jobs[i]).filter((j) => ["failure", "timed_out", "action_required", "startup_failure"].includes(String(j.conclusion))).map((j) => label(j.name)),
    })),
    pulls: records(pulls).slice(0, 15).map((row) => ({ number: Number(row.number), title: label(row.title), url: githubLink(row.url) })),
  };
}

const TOKENS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0;

export function usageCollector(now: number) {
  const samples = new Map<string, { stamp: number; tokens: number; model: string }>();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  return { add: (line: string) => addUsage(samples, line, +start, now), result: () => sumUsage(samples, start), start: +start };
}

export function usageData(lines: Iterable<string>, now: number) {
  const usage = usageCollector(now);
  for (const line of lines) usage.add(line);
  return usage.result();
}

function addUsage(samples: Map<string, { stamp: number; tokens: number; model: string }>, line: string, start: number, now: number) {
  let row;
  try { row = JSON.parse(line); } catch { return; }
  if (row?.type !== "assistant") return;
  const stamp = Date.parse(row.timestamp);
  const msg = row.message;
  if (!Number.isFinite(stamp) || stamp < start || stamp > now || typeof msg?.id !== "string" || !isObject(msg.usage)) return;
  const tokens = TOKENS.reduce((sum, field) => sum + count(msg.usage[field]), 0);
  const prev = samples.get(msg.id);
  if (!prev || (stamp >= prev.stamp && tokens >= prev.tokens)) samples.set(msg.id, { stamp, tokens, model: label(msg.model) || "Unknown model" });
}

function sumUsage(samples: Map<string, { stamp: number; tokens: number; model: string }>, start: Date) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start);
    day.setDate(day.getDate() + i);
    return { start: +day, label: day.toLocaleDateString("en", { weekday: "short" }), tokens: 0 };
  });
  const models = new Map<string, number>();
  for (const { stamp, tokens, model } of samples.values()) {
    const day = days.findLast((d) => stamp >= d.start);
    if (day) day.tokens += tokens;
    if (tokens) models.set(model, (models.get(model) ?? 0) + tokens);
  }
  return { days, models: [...models].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens) };
}

export function metricData(json: unknown, path: string, sparkPath: string) {
  const value = pick(json, path);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new WidgetError(0, "bad-value", "The value path must return a number.");
  const samples = sparkPath ? pick(json, sparkPath, { wildcard: true }) : undefined;
  const spark = Array.isArray(samples) ? samples.filter((n): n is number => typeof n === "number" && Number.isFinite(n)).slice(-60) : undefined;
  return { value, display: new Intl.NumberFormat(undefined, { maximumSignificantDigits: 8 }).format(value), ...(spark?.length ? { spark } : {}) };
}

export function previewData(png: Buffer) {
  if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || png.length > 1_000_000) {
    throw new WidgetError(0, "bad-image", "Could not capture a preview image.");
  }
  return "data:image/png;base64," + png.toString("base64");
}

export function diskData(stat: { blocks: number; bsize: number; bavail: number }) {
  const total = stat.blocks * stat.bsize;
  const free = stat.bavail * stat.bsize;
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0 || free < 0 || free > total) throw new WidgetError(0, "bad-disk", "Could not read the disk size.");
  return { total, free };
}
