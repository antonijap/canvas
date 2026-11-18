// The Home widget's reading of GET /v1/usage (owners only). Pure: the app passes the JSON it got and
// the time, and shows `line` with `detail` under it. It never says "free" as a promise: a Cloudflare
// Cloud "Stays within the limits you set" (decision 13.6, review finding 26).

import { AMBER_AT, DAILY, isDaily, MONTHLY, RED_AT, STORED, type Daily, type Monthly, type Resource, type Stored } from "./usage.ts";

export type WidgetLevel = "ok" | "amber" | "red";
export type UsageWidget = { level: WidgetLevel; line: string; detail: string[] };

const DAY_MS = 24 * 60 * 60_000;
const GB = 1_000_000_000;

const labels: Record<Resource, string> = {
  requests: "Requests", durationGbS: "Awake time (estimated)", rowsWritten: "Rows written", rowsRead: "Rows read",
  blobClassA: "File writes this month", blobClassB: "File reads this month", storageBytes: "Design data", blobBytes: "Images and videos",
};

const number = (n: number) => Math.round(n).toLocaleString("en-US");
export function bytes(n: number): string {
  if (n >= GB) return `${trim(n / GB)} GB`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)} MB`;
  if (n >= 1_000) return `${trim(n / 1_000)} KB`;
  return `${Math.max(0, Math.round(n))} bytes`;
}
const trim = (n: number) => (n >= 10 ? Math.round(n).toString() : (Math.round(n * 10) / 10).toString());
function percent(used: number, of: number): string {
  if (of <= 0) return "100%";
  const p = (used / of) * 100;
  if (used > 0 && p < 1) return "under 1%";
  return `${Math.floor(p)}%`;
}
function since(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 2 * 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} days`;
}
const rank: Record<WidgetLevel, number> = { ok: 0, amber: 1, red: 2 };
const max = (a: WidgetLevel, b: WidgetLevel) => (rank[b] > rank[a] ? b : a);

type Metric = { used: number; reserved?: number; cap: number; free: number };
const isMetric = (m: unknown): m is Metric =>
  !!m && typeof m === "object" && ["used", "cap", "free"].every(k => typeof (m as Record<string, unknown>)[k] === "number");

export function usageWidget(json: unknown, now = Date.now()): UsageWidget {
  if (!json || typeof json !== "object") return { level: "amber", line: "Usage not available", detail: [] };
  const body = json as Record<string, unknown>;
  const updated = typeof body.updatedAt === "string" ? Date.parse(body.updatedAt) : NaN;
  const stale = !Number.isFinite(updated) || now - updated > DAY_MS;
  if (body.adapter === "mac") return macWidget(body, stale);
  if (body.adapter !== "cloudflare" || !body.metrics || typeof body.metrics !== "object") {
    return { level: "amber", line: "Usage not available", detail: [] };
  }
  const metrics = body.metrics as Record<string, unknown>;
  let level: WidgetLevel = stale ? "amber" : "ok";
  let top = { counted: 0, free: 0, share: -1 };
  const lines: string[] = [];
  const reached: string[] = [];
  const resets = `resets on 1 ${nextMonthName(typeof body.month === "string" ? body.month : new Date(now).toISOString().slice(0, 7))}`;
  // Reserved work counts: a room may already have spent what it holds.
  const counted = (m: Metric) => m.used + (typeof m.reserved === "number" ? m.reserved : 0);
  for (const r of [...DAILY, ...MONTHLY] as readonly (Daily | Monthly)[]) {
    const m = metrics[r];
    if (!isMetric(m)) continue;
    const n = counted(m);
    const ofCap = m.cap > 0 ? n / m.cap : 1;
    level = max(level, ofCap >= RED_AT ? "red" : ofCap >= AMBER_AT ? "amber" : "ok");
    if (ofCap >= 1) reached.push(`${labels[r]} limit reached, ${isDaily(r) ? "resets at 00:00 UTC" : resets}`);
    if (isDaily(r)) {
      const share = m.free > 0 ? n / m.free : 1;
      if (share > top.share) top = { counted: n, free: m.free, share };
    }
    lines.push(`${labels[r]}: ${number(n)} of ${number(m.cap)}`);
  }
  for (const r of STORED as readonly Stored[]) {
    const m = metrics[r];
    if (!isMetric(m)) continue;
    const n = counted(m);
    const ofCap = m.cap > 0 ? n / m.cap : 1;
    level = max(level, ofCap >= 0.9 ? "red" : ofCap >= 0.7 ? "amber" : "ok");
    if (ofCap >= 1) reached.push(`${labels[r]} full, frees up when files are removed`);
    lines.push(`${labels[r]}: ${bytes(n)} of ${bytes(m.cap)}`);
  }
  if (body.brake === "amber") level = max(level, "amber");
  if (body.brake === "red" || body.brake === "stop") level = "red";
  const detail = ["Stays within the limits you set", ...reached, ...lines];
  if (stale) detail.push("Last counted more than a day ago");
  return { level, line: `Today, ${percent(top.counted, top.free)} of free`, detail };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function nextMonthName(month: string): string {
  const m = Number(month.slice(5, 7));
  return MONTHS[Number.isInteger(m) && m >= 1 && m <= 12 ? m % 12 : 0];
}

function macWidget(body: Record<string, unknown>, stale: boolean): UsageWidget {
  const n = (k: string) => (typeof body[k] === "number" && Number.isFinite(body[k]) ? (body[k] as number) : undefined);
  const stored = n("storageBytes") ?? 0;
  const people = n("peopleConnected") ?? 0;
  const uptime = n("uptimeSeconds");
  const freeDisk = n("freeDiskBytes");
  const restarts = n("restartsLastHour");
  const messages = n("messages24h");
  let level: WidgetLevel = stale ? "amber" : "ok";
  if (stored > 20 * GB) level = max(level, "amber");
  if (freeDisk !== undefined) level = max(level, freeDisk < 5 * GB ? "red" : freeDisk < 20 * GB ? "amber" : "ok");
  if (restarts !== undefined && restarts > 3) level = "red";
  const detail = [
    `${bytes(stored)} stored`,
    people === 1 ? "1 person connected" : `${number(people)} people connected`,
  ];
  if (uptime !== undefined) detail.push(`Up ${since(uptime)}`);
  if (freeDisk !== undefined) detail.push(`${bytes(freeDisk)} free on this Mac`);
  if (messages !== undefined) detail.push(`${number(messages)} messages in 24 h`);
  if (freeDisk !== undefined && freeDisk < 5 * GB) detail.push("Uploads paused: this Mac is almost full");
  if (stale) detail.push("Last counted more than a day ago");
  return { level, line: "Hosted on this Mac, no daily limits", detail };
}
