// PostHog data on a card: an insight by short id, or a HogQL query, shown as one number or as a chart
// (display.chart). Bearer personal API key (scopes query:read and insight:read) from the Keychain.

import { bad, bool, extras, int, isObject, obj, oneOf, str } from "../check.ts";
import { deltaOf, formatValue, FORMAT_RE } from "../format.ts";
import { parseRef } from "../keychain.ts";
import { webOrigin } from "../trust.ts";
import { WidgetError, type ChartData, type ChartType, type Config, type SecretRef, type SourceData, type WidgetKind } from "../types.ts";

const KNOWN = ["host", "projectId", "source", "insight", "query", "secret", "display", "refreshSec"];
const CLOUD = { us: "https://us.posthog.com", eu: "https://eu.posthog.com" };

/** The origin API calls go to. CANVAS_POSTHOG_BASE replaces the cloud origins, for tests. */
export function baseOf(host: string): string {
  const over = process.env.CANVAS_POSTHOG_BASE;
  if (host === "us" || host === "eu") return (over || CLOUD[host]).replace(/\/+$/, "");
  return host;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function series(values: unknown[], display: Record<string, unknown>, fmt: string, total?: number): SourceData {
  const nums = values.map(num).filter((n): n is number => n !== undefined);
  if (!nums.length) throw new WidgetError(0, "no-data", "PostHog returned no numbers");
  const value = total ?? nums[nums.length - 1];
  const out: SourceData = { value, display: formatValue(value, fmt) };
  if (display.spark !== false && nums.length > 1) out.spark = nums.slice(-60);
  if (nums.length > 1) out.delta = deltaOf(nums[nums.length - 1], nums[nums.length - 2], fmt);
  return out;
}

/** HogQL rows: 1x1 is the value, n x 1 a series, n x 2 (label, value) rows where the last row is the value. */
function rows(rs: unknown[][], display: Record<string, unknown>, fmt: string): SourceData {
  if (!rs.length) throw new WidgetError(0, "no-data", "The query returned no rows");
  if (rs.length === 1 && rs[0].length === 1) {
    const v = rs[0][0];
    const n = num(v);
    return { value: n ?? String(v), display: formatValue(n ?? v, fmt) };
  }
  if (rs.every((r) => r.length === 2)) return series(rs.map((r) => r[1]), display, fmt);
  if (rs.every((r) => r.length === 1)) return series(rs.map((r) => r[0]), display, fmt);
  throw new WidgetError(0, "unsupported-result", "Use a query that returns one value, one column, or label and value columns");
}

function trends(list: unknown[], display: Record<string, unknown>, fmt: string): SourceData {
  const s = list[0];
  if (!isObj(s) || !Array.isArray(s.data)) throw new WidgetError(0, "unsupported-insight", "This insight is not a number or trend");
  const total = num(s.aggregated_value) ?? num(s.count);
  const out = series(s.data, display, fmt, total);
  if (display.compare === true && isObj(list[1]) && Array.isArray(list[1].data)) {
    const prev = num(list[1].aggregated_value) ?? num(list[1].count) ?? (list[1].data as unknown[]).map(num).reduce<number>((a, b) => a + (b ?? 0), 0);
    const cur = typeof out.value === "number" ? out.value : 0;
    out.delta = deltaOf(cur, prev, fmt);
  }
  return out;
}

// ---------- charts ----------
// A chart card gets labels plus named series instead of one number. HogQL shapes: one value; one
// column; (label, value); (x, series, value) pivoted into one series per distinct middle value; and
// (label, number, number, ...) with one series per column. Trends insights give one series per entry.

export const CHART_TYPES = ["number", "line", "area", "bar", "hbar", "stacked", "pie", "donut", "table", "funnel", "ring", "heatmap", "sparklines"] as const;
/** Categorical hues a chart may use; more series fold into "Other". */
export const MAX_SERIES = 8;
const MAX_POINTS = 400;
const MAX_ROWS = 100;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

type Grid = { labels: string[]; series: { name: string; values: number[] }[]; time: boolean };

function labelOf(v: unknown): string {
  if (v === null || v === undefined || v === "") return "Unknown";
  if (typeof v === "string") return v.trim().slice(0, 80) || "Unknown";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v).slice(0, 80);
}

/** ISO dates and times become "2026-11-03" or "2026-11-03T14:00"; anything else leaves the labels alone. */
function timeLabels(labels: string[]): string[] | undefined {
  if (!labels.length) return undefined;
  const out: string[] = [];
  for (const l of labels) {
    const m = DATE_RE.exec(l);
    if (!m) return undefined;
    out.push(m[2] && m[2] !== "00:00" ? `${m[1]}T${m[2]}` : m[1]);
  }
  return out;
}

function grid(labels: unknown[], series: { name: string; values: unknown[] }[]): Grid {
  let ls = labels.map(labelOf);
  const t = timeLabels(ls);
  if (t) ls = t;
  const g: Grid = { labels: ls, series: series.map((s) => ({ name: s.name.slice(0, 80) || "Value", values: s.values.map((v) => num(v) ?? 0) })), time: !!t };
  if (g.time) {
    // Pivoted rows list dates in the order they first appear; a time axis wants them in order.
    const order = g.labels.map((_, i) => i).sort((a, b) => (g.labels[a] < g.labels[b] ? -1 : g.labels[a] > g.labels[b] ? 1 : 0));
    if (order.some((v, i) => v !== i)) {
      g.labels = order.map((i) => g.labels[i]);
      for (const s of g.series) s.values = order.map((i) => s.values[i]);
    }
  }
  return g;
}

/** Keep the biggest series; the rest add up into one "Other" series. */
function capSeries(g: Grid, max = MAX_SERIES): Grid {
  if (g.series.length <= max) return g;
  const total = (s: Grid["series"][number]) => s.values.reduce((a, b) => a + b, 0);
  const sorted = [...g.series].sort((a, b) => total(b) - total(a));
  const keep = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1);
  const other = { name: "Other", values: g.labels.map((_, i) => rest.reduce((a, s) => a + s.values[i], 0)) };
  const kept = new Set(keep);
  return { ...g, series: [...g.series.filter((s) => kept.has(s)), other] };
}

/**
 * A query column named `total` carries the whole when it is not the sum of the groups: a person seen in two
 * groups is in both bars but once in the total (`count(DISTINCT person_id) OVER () AS total`). The column
 * comes off the rows, so the groups stay as the query gave them; the first row's value is the total.
 */
export function splitTotal(rs: unknown[][], columns: string[]): { rows: unknown[][]; columns: string[]; total?: number } {
  const at = columns.findIndex((c, i) => i > 0 && typeof c === "string" && c.toLowerCase() === "total");
  if (at < 1 || !rs.length || !rs.every((r) => r.length === columns.length)) return { rows: rs, columns };
  const total = rs.map((r) => num(r[at])).find((n) => n !== undefined);
  const keep = (_: unknown, i: number) => i !== at;
  return { rows: rs.map((r) => r.filter(keep)), columns: columns.filter(keep), ...(total !== undefined ? { total } : {}) };
}

function rowsGrid(rs: unknown[][], columns: string[]): Grid {
  const col = (i: number, def: string) => (typeof columns[i] === "string" && columns[i] ? columns[i] : def);
  if (rs.every((r) => r.length === 1)) {
    if (rs.length === 1) return grid([""], [{ name: col(0, "Value"), values: [rs[0][0]] }]);
    return grid(rs.map((_, i) => i + 1), [{ name: col(0, "Value"), values: rs.map((r) => r[0]) }]);
  }
  if (rs.every((r) => r.length === 2)) return grid(rs.map((r) => r[0]), [{ name: col(1, "Value"), values: rs.map((r) => r[1]) }]);
  const width = rs[0].length;
  if (width >= 3 && rs.every((r) => r.length === width)) {
    // (x, series, value): the middle column names the series when it is not a number.
    if (width === 3 && rs.every((r) => num(r[1]) === undefined)) {
      const xs: unknown[] = [];
      const xIndex = new Map<string, number>();
      const byName = new Map<string, number[]>();
      const totals = new Map<string, number>();
      for (const r of rs) {
        const xk = labelOf(r[0]);
        if (!xIndex.has(xk)) { xIndex.set(xk, xs.length); xs.push(r[0]); }
      }
      for (const r of rs) {
        const name = labelOf(r[1]);
        let vals = byName.get(name);
        if (!vals) byName.set(name, (vals = new Array(xs.length).fill(0)));
        const v = num(r[2]) ?? 0;
        vals[xIndex.get(labelOf(r[0]))!] += v;
        totals.set(name, (totals.get(name) ?? 0) + v);
      }
      // Biggest series first, so stacks have their largest part at the baseline and colours stay put
      // while the mix holds.
      // A catch-all series ("Other", or rows with no value) goes last, where the neutral colour is.
      const tail = (n: string) => (n === "Other" || n === "Unknown" ? 1 : 0);
      const names = [...byName.keys()].sort((a, b) => tail(a) - tail(b) || totals.get(b)! - totals.get(a)!);
      return capSeries(grid(xs, names.map((n) => ({ name: n, values: byName.get(n)! }))));
    }
    // (label, number, number, ...): one series per column.
    if (rs.every((r) => r.slice(1).every((v) => v === null || num(v) !== undefined))) {
      const series = Array.from({ length: width - 1 }, (_, i) => ({ name: col(i + 1, `Value ${i + 1}`), values: rs.map((r) => r[i + 1]) }));
      return capSeries(grid(rs.map((r) => r[0]), series));
    }
  }
  throw new WidgetError(0, "unsupported-result", "Use a query that returns one value, (label, value), (x, series, value) or (label, numbers...) rows");
}

function trendsGrid(list: unknown[]): Grid {
  const entries = list.filter((s): s is Record<string, unknown> => isObj(s) && s.compare_label !== "previous");
  if (!entries.length) throw new WidgetError(0, "unsupported-insight", "This insight has nothing to chart");
  // Funnels and totals: one number per entry, named.
  if (entries.every((s) => !Array.isArray(s.data))) {
    const vals = entries.map((s) => num(s.aggregated_value) ?? num(s.count));
    if (vals.every((v) => v === undefined)) throw new WidgetError(0, "unsupported-insight", "This insight has nothing to chart");
    return grid(entries.map((s, i) => s.name ?? s.label ?? s.custom_name ?? i + 1), [{ name: "Value", values: vals }]);
  }
  const withData = entries.filter((s) => Array.isArray(s.data));
  const first = withData[0];
  const labels = (Array.isArray(first.days) ? first.days : Array.isArray(first.labels) ? first.labels : (first.data as unknown[]).map((_, i) => i + 1)) as unknown[];
  const series = withData.map((s, i) => {
    const bv = Array.isArray(s.breakdown_value) ? s.breakdown_value.join(", ") : s.breakdown_value;
    const name = labelOf(bv ?? s.label ?? s.custom_name ?? `Series ${i + 1}`);
    return { name, values: labels.map((_, j) => (s.data as unknown[])[j]) };
  });
  return capSeries(grid(labels, series));
}

/** Sort descending, keep `top`, and add the rest up as "Other". One series. */
function ranked(labels: string[], values: number[], top: number, positiveOnly: boolean): { labels: string[]; values: number[]; other: boolean } {
  let pairs = labels.map((l, i) => ({ l, v: values[i] }));
  if (positiveOnly) pairs = pairs.filter((p) => p.v > 0);
  pairs.sort((a, b) => b.v - a.v);
  if (top > 0 && pairs.length > top + 1) {
    const rest = pairs.slice(top).reduce((a, p) => a + p.v, 0);
    pairs = [...pairs.slice(0, top), { l: "Other", v: rest }];
    return { labels: pairs.map((p) => p.l), values: pairs.map((p) => p.v), other: true };
  }
  return { labels: pairs.map((p) => p.l), values: pairs.map((p) => p.v), other: false };
}

/** The big number over a chart: auto is the average for a trend and the biggest part's share for parts of a whole. */
export const HEADLINES = ["auto", "last", "total", "average", "share", "none"] as const;

/** The accent a one-series chart wears: a slot of the categorical palette (src/page/charts.css). */
export const ACCENTS = ["auto", "blue", "orange", "aqua", "yellow", "magenta", "green", "violet", "red"] as const;

const DEFAULT_TOP: Partial<Record<ChartType, number>> = { pie: 6, donut: 6, hbar: 10 };

/** Shape a grid for one chart type. Exported for tests. */
export function shapeChart(g: Grid, type: ChartType, fmt: string, top = 0): ChartData {
  const n = top > 0 ? top : DEFAULT_TOP[type] ?? 0;
  if (type === "pie" || type === "donut" || type === "hbar") {
    // Several series (a breakdown over time): each series becomes one slice or bar, its total.
    const one = g.series.length === 1;
    const labels = one ? g.labels : g.series.map((s) => s.name);
    const values = one ? g.series[0].values : g.series.map((s) => s.values.reduce((a, b) => a + b, 0));
    const r = ranked(labels, values, n, type !== "hbar");
    return { type, labels: r.labels, series: [{ name: one ? g.series[0].name : "Total", values: r.values }], format: fmt, ...(r.other ? { other: true } : {}) };
  }
  if (type === "funnel") {
    // Steps in the order the query gives them; the first step is 100%.
    const s = g.series[0];
    return { type, labels: g.labels.slice(0, 12), series: [{ name: s.name, values: s.values.slice(0, 12) }], format: fmt };
  }
  if (type === "ring") {
    // One value is a ratio (0.42 fills 42%). Rows: the first row's share of all of them.
    const s = g.series[0];
    const total = s.values.reduce((a, b) => a + b, 0);
    if (s.values.length === 1) return { type, labels: [g.labels[0] || s.name], series: [{ name: s.name, values: [s.values[0]] }], format: fmt };
    const rest = s.values.length === 2 ? g.labels[1] : "Everything else";
    return { type, labels: [g.labels[0], rest], series: [{ name: s.name, values: [s.values[0], Math.max(0, total - s.values[0])] }], format: fmt };
  }
  if (type === "table") {
    const cut = Math.min(n || MAX_ROWS, MAX_ROWS);
    return { type, labels: g.labels.slice(0, cut), series: g.series.map((s) => ({ name: s.name, values: s.values.slice(0, cut) })), format: fmt, ...(g.time ? { time: true } : {}) };
  }
  const from = Math.max(0, g.labels.length - MAX_POINTS);
  return { type, labels: g.labels.slice(from), series: g.series.map((s) => ({ name: s.name, values: s.values.slice(from) })), format: fmt, ...(g.time ? { time: true } : {}) };
}

/** The value the inspector's Status shows for a chart: the total for parts of a whole, the latest point for a trend. */
function chartValue(c: ChartData, display: Record<string, unknown>): SourceData {
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  if (c.type === "ring") {
    const v = c.series[0].values;
    const ratio = v.length === 1 ? v[0] : v[0] / Math.max(1e-9, v[0] + v[1]);
    return { value: ratio, display: formatValue(ratio, v.length === 1 ? c.format : "percent"), chart: c };
  }
  if (c.type === "funnel") {
    const v = c.series[0].values;
    const conv = v.length > 1 && v[0] ? v[v.length - 1] / v[0] : 1;
    return { value: conv, display: formatValue(conv, "percent"), chart: c };
  }
  const parts = c.type === "pie" || c.type === "donut" || c.type === "hbar" || c.type === "table";
  const atLabel = (i: number) => sum(c.series.map((s) => s.values[i] ?? 0));
  const last = c.labels.length - 1;
  const value = parts ? c.total ?? sum(c.series[0]?.values ?? []) : atLabel(last);
  const out: SourceData = { value, display: formatValue(value, c.format), chart: c };
  if (!parts && last > 0) out.delta = deltaOf(atLabel(last), atLabel(last - 1), c.format);
  return out;
}

/** Turn a PostHog response into what the widget shows. Exported for tests. */
export function normalize(json: unknown, source: string, display: Record<string, unknown>): SourceData {
  const fmt = String(display.format ?? "auto");
  const type = (CHART_TYPES as readonly string[]).includes(String(display.chart)) ? (display.chart as ChartType) : "number";
  const results = isObj(json) ? json.results : undefined;
  if (type !== "number") {
    const top = typeof display.top === "number" ? display.top : 0;
    const columns = isObj(json) && Array.isArray(json.columns) ? (json.columns as unknown[]).map(String) : [];
    let g: Grid;
    let total: number | undefined;
    const rowsOf = (rs: unknown[][], cols: string[]) => {
      const sp = splitTotal(rs, cols);
      total = sp.total;
      return rowsGrid(sp.rows, sp.columns);
    };
    if (source === "insight") {
      const first = Array.isArray(results) ? results[0] : undefined;
      const result = isObj(first) ? first.result : undefined;
      const cols = isObj(first) && Array.isArray(first.columns) ? (first.columns as unknown[]).map(String) : columns;
      if (!Array.isArray(result) || !result.length) throw new WidgetError(0, "unsupported-insight", "PostHog sent no result for this insight");
      g = Array.isArray(result[0]) ? rowsOf(result as unknown[][], cols) : trendsGrid(result);
    } else {
      if (!Array.isArray(results)) throw new WidgetError(0, "unsupported-result", "PostHog sent no results");
      if (!results.length) throw new WidgetError(0, "no-data", "The query returned no rows");
      g = Array.isArray(results[0]) ? rowsOf(results as unknown[][], columns) : trendsGrid(results);
    }
    if (!g.labels.length) throw new WidgetError(0, "no-data", "The query returned no rows");
    const shaped = shapeChart(g, type, fmt, top);
    return chartValue(total !== undefined ? { ...shaped, total } : shaped, display);
  }
  let out: SourceData;
  let list: unknown[];
  if (source === "insight") {
    const first = Array.isArray(results) ? results[0] : undefined;
    const result = isObj(first) ? first.result : undefined;
    if (!Array.isArray(result) || !result.length) throw new WidgetError(0, "unsupported-insight", "PostHog sent no result for this insight");
    list = result;
    out = Array.isArray(result[0]) ? rows(result as unknown[][], display, fmt) : trends(result, display, fmt);
  } else {
    if (!Array.isArray(results)) throw new WidgetError(0, "unsupported-result", "PostHog sent no results");
    if (!results.length) throw new WidgetError(0, "no-data", "The query returned no rows");
    list = results;
    out = Array.isArray(results[0]) ? rows(results as unknown[][], display, fmt) : trends(results, display, fmt);
  }
  // The dates under a number's sparkline, so the card can say what the change is against ("vs yesterday")
  // and what span the line covers. Only for a dated series that matches the sparkline point for point.
  if (out.spark) {
    try {
      const g = Array.isArray(list[0]) ? rowsGrid(list as unknown[][], []) : trendsGrid(list);
      if (g.time && g.series.length === 1) {
        const n = out.spark.length;
        const values = g.series[0].values.slice(-n);
        if (values.length === n && values.every((v, i) => v === out.spark![i])) out.chart = { type: "number", labels: g.labels.slice(-n), series: [{ name: g.series[0].name, values }], format: fmt, time: true };
      }
    } catch {
      // No dates: the number shows without them.
    }
  }
  return out;
}

export const posthog: WidgetKind = {
  id: "posthog",
  picker: false,
  title: "PostHog",
  symbol: "chart.line.uptrend.xyaxis",
  defaultSize: { w: 220, h: 140 },
  minSize: { w: 140, h: 90 },
  defaults: () => ({
    host: "us",
    projectId: "",
    source: "insight",
    insight: { shortId: "" },
    query: { kind: "HogQLQuery", query: "" },
    display: { label: "", format: "auto", spark: true, compare: false, chart: "number", top: 0, headline: "auto", color: "auto" },
    refreshSec: 300,
    // One shared Keychain item, so every PostHog widget uses the key once it is saved.
    secret: { service: "canvas-widget", account: "posthog.personal" },
  }),
  validate(c: Config): Config {
    let host = str(c.host, "host", "us", 200);
    if (host !== "us" && host !== "eu") {
      let u: URL;
      try {
        u = new URL(host);
      } catch {
        throw bad("host", 'must be "us", "eu" or an https:// origin');
      }
      if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw bad("host", 'must be "us", "eu" or a plain https:// origin');
      host = u.origin;
    }
    const pid = c.projectId === undefined || c.projectId === null ? "" : String(c.projectId);
    if (pid && !/^\d{1,12}$/.test(pid)) throw bad("projectId", "must be the numeric project id");
    const source = oneOf(c.source, "source", "insight", ["insight", "query"] as const);
    const insight = obj(c.insight, "insight");
    const shortId = str(insight.shortId, "insight.shortId", "", 40);
    if (!/^[A-Za-z0-9_-]*$/.test(shortId)) throw bad("insight.shortId", "may only hold letters, digits, - and _");
    const query = obj(c.query, "query");
    const out: Config = {
      host,
      projectId: pid,
      source,
      insight: { shortId },
      query: { kind: oneOf(query.kind, "query.kind", "HogQLQuery", ["HogQLQuery"] as const), query: str(query.query, "query.query", "", 10_000) },
    };
    if (c.secret !== undefined && c.secret !== null) {
      const ref = parseRef(c.secret);
      if (!ref) throw bad("secret", "needs a service and an account of letters, digits and . _ @ : -");
      out.secret = ref;
    }
    const d = obj(c.display, "display");
    const format = str(d.format, "display.format", "auto", 20);
    if (!FORMAT_RE.test(format)) throw bad("display.format", "must be auto, integer, compact, percent, duration or currency:XXX");
    out.display = {
      label: str(d.label, "display.label", "", 120),
      format,
      spark: bool(d.spark, "display.spark", true),
      compare: bool(d.compare, "display.compare", false),
      chart: oneOf(d.chart, "display.chart", "number", CHART_TYPES),
      top: int(d.top, "display.top", 0, 0, 50),
      headline: oneOf(d.headline, "display.headline", "auto", HEADLINES),
      color: oneOf(d.color, "display.color", "auto", ACCENTS),
    };
    out.refreshSec = int(c.refreshSec, "refreshSec", 300, 60, 86_400);
    return { ...out, ...extras(c, KNOWN) };
  },
  fields: [
    { key: "host", label: "Region", type: "text", help: 'us, eu, or your https:// origin' },
    { key: "projectId", label: "Project ID", type: "text" },
    { key: "source", label: "Source", type: "select", options: [{ value: "insight", label: "Saved insight" }, { value: "query", label: "HogQL query" }] },
    { key: "insight.shortId", label: "Insight short ID", type: "text", help: "The code in the insight's URL" },
    { key: "query.query", label: "HogQL", type: "textarea", help: "A column named total is the whole when it is not the sum of the groups: count(DISTINCT person_id) OVER () AS total counts a person seen in two groups once; the groups stay per-group." },
    { key: "secret", label: "API key", type: "secret", help: "Personal API key with query:read and insight:read." },
    { key: "display.label", label: "Label", type: "text" },
    {
      key: "display.chart",
      label: "Chart",
      type: "select",
      options: [
        { value: "number", label: "Number" },
        { value: "line", label: "Line" },
        { value: "area", label: "Area" },
        { value: "bar", label: "Bars" },
        { value: "hbar", label: "Ranked bars" },
        { value: "stacked", label: "Stacked bars" },
        { value: "pie", label: "Pie" },
        { value: "donut", label: "Donut" },
        { value: "ring", label: "Ring (a ratio)" },
        { value: "funnel", label: "Funnel" },
        { value: "heatmap", label: "Calendar heatmap" },
        { value: "sparklines", label: "Small multiples" },
        { value: "table", label: "Table" },
      ],
      help: "Rows (label, value) or (x, series, value) for several series.",
    },
    {
      key: "display.headline",
      label: "Headline",
      type: "select",
      options: [
        { value: "auto", label: "Automatic" },
        { value: "last", label: "Latest value" },
        { value: "total", label: "Total" },
        { value: "average", label: "Average" },
        { value: "share", label: "Share of the biggest part" },
        { value: "none", label: "None" },
      ],
    },
    { key: "display.color", label: "Colour", type: "select", options: ACCENTS.map((v) => ({ value: v, label: v === "auto" ? "Automatic" : v[0].toUpperCase() + v.slice(1) })) },
    { key: "display.top", label: "Top", type: "number", help: "Pie, donut, ranked bars and tables: keep this many, add up the rest as Other. 0 picks for you." },
    { key: "display.format", label: "Format", type: "text", help: "auto, integer, compact, percent, duration or currency:USD" },
    { key: "display.spark", label: "Sparkline under the number", type: "bool" },
    { key: "display.compare", label: "Compare to previous period", type: "bool" },
    { key: "refreshSec", label: "Refresh (seconds)", type: "number" },
  ],
  source: {
    approval: {
      field: "host", verb: "load",
      target(c) {
        const query = c.source === "query";
        const settings = query ? c.query : c.insight;
        if (typeof c.host === "string" && c.projectId && isObject(settings) && settings[query ? "query" : "shortId"]) {
          return webOrigin(baseOf(c.host));
        }
      },
    },
    key: (c) => JSON.stringify([c.host, c.projectId, c.source, c.source === "insight" ? c.insight : c.query, c.secret, c.display]),
    minIntervalSec: 60,
    intervalSec: (c) => Number(c.refreshSec) || 300,
    secretUse(c) {
      const ref = c.secret as SecretRef | undefined;
      const origin = typeof c.host === "string" ? webOrigin(baseOf(c.host)) : undefined;
      return ref && origin ? { ref, origin } : undefined;
    },
    async fetch(ctx): Promise<SourceData> {
      const c = ctx.widget.config;
      const ref = c.secret as SecretRef | undefined;
      const insight = obj(c.insight, "insight");
      const query = obj(c.query, "query");
      const byInsight = c.source !== "query";
      if (!c.projectId || (byInsight ? !insight.shortId : !query.query)) throw new WidgetError(0, "not-configured", "Set the project and the insight or query");
      if (!ref) throw new WidgetError(0, "needs-secret", "Pick the Keychain item that holds your PostHog API key");
      const base = typeof c.host === "string" ? webOrigin(baseOf(c.host)) : undefined;
      if (!base) throw new WidgetError(0, "bad-url", "Set a valid analytics host");
      const project = `${base}/api/projects/${encodeURIComponent(String(c.projectId))}`;
      const refresh = ctx.force ? "force_blocking" : "blocking";
      const res = byInsight
        ? await ctx.request({ url: `${project}/insights/?short_id=${encodeURIComponent(String(insight.shortId))}&refresh=${refresh}`, secret: ref, maxBytes: 2_000_000, sameOrigin: true })
        : await ctx.request({
            url: `${project}/query/`,
            method: "POST",
            sameOrigin: true,
            body: { query: { kind: "HogQLQuery", query: query.query }, name: "canvas-widget", refresh },
            secret: ref,
            maxBytes: 2_000_000,
          });
      const display = obj(c.display, "display");
      const data = normalize(res.json, byInsight ? "insight" : "query", display);
      return { ...data, label: String(display.label || ctx.widget.name) };
    },
  },
};
