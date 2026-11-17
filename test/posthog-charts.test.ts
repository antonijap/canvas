// PostHog chart cards: how query rows and insight results become labels plus named series for each
// display.chart type, the config checks for the chart options, and the page's axis and headline maths.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalize, shapeChart, MAX_SERIES, posthog } from "../src/widgets/kinds/posthog.ts";
// @ts-expect-error: a page module (plain JS, no types)
import { niceTicks, fmt, tickText, headlineOf, dateTick, dateLong, versus, periodOf } from "../src/page/charts.js";

const q = (columns: string[], results: unknown[][]) => ({ columns, results });
const chartOf = (json: unknown, display: Record<string, unknown>, source = "query") => normalize(json, source, display).chart!;

describe("posthog charts: a total that is not the sum of the groups", () => {
  // Two people are in both groups: 3 + 3 per group, but 4 distinct people.
  const rows = q(["os", "n", "total"], [["iOS", 3, 4], ["Android", 3, 4]]);

  test("a `total` column is the whole; the groups stay per-group", () => {
    const r = normalize(rows, "query", { chart: "donut" });
    assert.deepEqual(r.chart!.labels, ["iOS", "Android"]);
    assert.deepEqual(r.chart!.series, [{ name: "n", values: [3, 3] }]);
    assert.equal(r.chart!.total, 4);
    assert.equal(r.value, 4, "the card's number is the distinct total, not 6");
  });

  test("the Total headline and the share use it; without the column the sum stands", () => {
    const c = normalize(rows, "query", { chart: "donut" }).chart!;
    assert.equal(headlineOf(c, { headline: "total" }).text, "4");
    assert.equal(headlineOf(c, { headline: "share" }).text, "75%");
    const plain = normalize(q(["os", "n"], [["iOS", 3], ["Android", 3]]), "query", { chart: "donut" });
    assert.equal(plain.value, 6);
    assert.equal(headlineOf(plain.chart, { headline: "total" }).text, "6");
  });

  test("a total column is read in (x, series, value, total) rows too", () => {
    const c = normalize(q(["day", "os", "n", "total"], [["2026-11-01", "iOS", 3, 4], ["2026-11-01", "Android", 3, 4]]), "query", { chart: "stacked" }).chart!;
    assert.deepEqual(c.series.map((s) => s.name), ["iOS", "Android"]);
    assert.equal(c.total, 4);
  });
});

describe("posthog charts: rows to series", () => {
  test("(label, value) rows: one series named after the value column; dates are a time axis", () => {
    const c = chartOf(q(["day", "learners"], [["2026-11-02T00:00:00Z", 3], ["2026-11-01T00:00:00Z", 5], ["2026-11-03", 4]]), { chart: "line" });
    assert.equal(c.type, "line");
    assert.equal(c.time, true);
    assert.deepEqual(c.labels, ["2026-11-01", "2026-11-02", "2026-11-03"], "sorted, midnight dropped");
    assert.deepEqual(c.series, [{ name: "learners", values: [5, 3, 4] }]);
  });

  test("hourly labels keep their time; plain labels are not a time axis", () => {
    assert.deepEqual(chartOf(q(["h", "n"], [["2026-11-01T14:00:00Z", 1], ["2026-11-01T15:00:00Z", 2]]), { chart: "bar" }).labels, ["2026-11-01T14:00", "2026-11-01T15:00"]);
    const c = chartOf(q(["os", "n"], [["iOS", 1], [null, 2]]), { chart: "bar" });
    assert.equal(c.time, undefined);
    assert.deepEqual(c.labels, ["iOS", "Unknown"]);
  });

  test("(x, series, value) rows pivot into one series per name: biggest first, Other last, gaps are zero", () => {
    const rows = [
      ["2026-11-01", "iOS", 5],
      ["2026-11-01", "Other", 50],
      ["2026-11-01", "Android", 9],
      ["2026-11-02", "Android", 7],
    ];
    const c = chartOf(q(["day", "os", "n"], rows), { chart: "stacked" });
    assert.deepEqual(c.labels, ["2026-11-01", "2026-11-02"]);
    assert.deepEqual(c.series.map((s) => s.name), ["Android", "iOS", "Other"]);
    assert.deepEqual(c.series.map((s) => s.values), [[9, 7], [5, 0], [50, 0]]);
  });

  test("more than eight series fold the smallest into Other", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ["d", `s${i}`, i + 1]);
    const c = chartOf(q(["x", "s", "n"], rows), { chart: "line" });
    assert.equal(c.series.length, MAX_SERIES);
    assert.equal(c.series.at(-1)!.name, "Other");
    assert.deepEqual(c.series.at(-1)!.values, [1 + 2 + 3 + 4 + 5]);
  });

  test("(label, number, number) rows: one series per column, named by the columns", () => {
    const c = chartOf(q(["day", "Started", "Finished"], [["2026-11-01", 10, 6], ["2026-11-02", 12, 8]]), { chart: "line" });
    assert.deepEqual(c.series, [{ name: "Started", values: [10, 12] }, { name: "Finished", values: [6, 8] }]);
  });

  test("one value and one column still chart", () => {
    assert.deepEqual(chartOf(q(["n"], [[7]]), { chart: "bar" }).series, [{ name: "n", values: [7] }]);
    const col = chartOf(q(["n"], [[1], [2], [3]]), { chart: "line" });
    assert.deepEqual(col.labels, ["1", "2", "3"]);
  });

  test("shapes no chart can use say so", () => {
    assert.throws(() => normalize(q(["a", "b"], [["x", 1, 2], ["y"]]), "query", { chart: "bar" }), /Use a query that returns/);
    assert.throws(() => normalize(q(["a"], []), "query", { chart: "bar" }), /no rows/);
  });
});

describe("posthog charts: shaping per type", () => {
  const parts = q(["os", "n"], [["iOS", 20], ["Android", 50], ["Web", 0], ["Linux", 5], ["Mac", 10], ["Win", 3]]);

  test("pie and donut: sorted, empty parts dropped, the tail folded into Other after top N", () => {
    const c = chartOf(parts, { chart: "donut", top: 2 });
    assert.deepEqual(c.labels, ["Android", "iOS", "Other"]);
    assert.deepEqual(c.series[0].values, [50, 20, 18]);
    assert.equal(c.other, true);
    // A tail of one is shown as itself, not as "Other".
    const all = chartOf(parts, { chart: "pie", top: 4 });
    assert.deepEqual(all.labels, ["Android", "iOS", "Mac", "Linux", "Win"]);
    assert.equal(all.other, undefined);
  });

  test("hbar ranks every row and defaults to the top 10", () => {
    const many = q(["c", "n"], Array.from({ length: 14 }, (_, i) => [`c${i}`, i]));
    const c = chartOf(many, { chart: "hbar" });
    assert.equal(c.labels.length, 11);
    assert.equal(c.labels[0], "c13");
    assert.equal(c.labels.at(-1), "Other");
    assert.equal(c.series[0].values.at(-1), 0 + 1 + 2 + 3);
  });

  test("a breakdown over time charted as parts: each series becomes one part, its total", () => {
    const c = chartOf(q(["d", "os", "n"], [["2026-11-01", "iOS", 2], ["2026-11-02", "iOS", 3], ["2026-11-01", "Android", 9]]), { chart: "pie" });
    assert.deepEqual(c.labels, ["Android", "iOS"]);
    assert.deepEqual(c.series[0].values, [9, 5]);
  });

  test("ring: one value is the ratio; two rows keep both names; more rows are the first against the rest", () => {
    const one = normalize(q(["r"], [[0.42]]), "query", { chart: "ring", format: "percent" });
    assert.equal(one.value, 0.42);
    assert.equal(one.display, "42%");
    const two = normalize(q(["r", "n"], [["Correct", 3], ["Wrong", 1]]), "query", { chart: "ring" });
    assert.deepEqual(two.chart!.labels, ["Correct", "Wrong"]);
    assert.equal(two.value, 0.75);
    const many = chartOf(q(["v", "n"], [["4.14", 6], ["4.13", 3], ["4.12", 1]]), { chart: "ring" });
    assert.deepEqual(many.labels, ["4.14", "Everything else"]);
    assert.deepEqual(many.series[0].values, [6, 4]);
  });

  test("funnel keeps the query's order; the reading's value is the end-to-end conversion", () => {
    const r = normalize(q(["step", "n"], [["Opened", 100], ["Started", 60], ["Finished", 25]]), "query", { chart: "funnel" });
    assert.deepEqual(r.chart!.labels, ["Opened", "Started", "Finished"]);
    assert.equal(r.value, 0.25);
  });

  test("table keeps rows in order, capped by top", () => {
    const c = chartOf(q(["lang", "Sessions", "Learners"], [["fi", 10, 3], ["fr", 5, 2], ["sv", 1, 1]]), { chart: "table", top: 2 });
    assert.deepEqual(c.labels, ["fi", "fr"]);
    assert.deepEqual(c.series.map((s) => s.name), ["Sessions", "Learners"]);
  });

  test("trend charts: the reading's value is the latest point, its delta against the one before", () => {
    const r = normalize(q(["d", "n"], [["2026-11-01", 10], ["2026-11-02", 15]]), "query", { chart: "area" });
    assert.equal(r.value, 15);
    assert.equal(r.delta?.display, "+50%");
    assert.equal(r.spark, undefined, "a chart card sends no sparkline");
  });

  test("long series keep their latest 400 points", () => {
    const g = { labels: Array.from({ length: 500 }, (_, i) => String(i)), series: [{ name: "n", values: Array.from({ length: 500 }, (_, i) => i) }], time: false };
    const c = shapeChart(g, "line", "auto");
    assert.equal(c.labels.length, 400);
    assert.equal(c.labels[0], "100");
  });
});

describe("posthog charts: insights", () => {
  test("a trends breakdown: one series per entry, named by its breakdown; the previous period is left out", () => {
    const json = {
      results: [
        {
          result: [
            { label: "Pageview", breakdown_value: "iOS", data: [1, 2], days: ["2026-11-01", "2026-11-02"] },
            { label: "Pageview", breakdown_value: "Android", data: [3, 4], days: ["2026-11-01", "2026-11-02"] },
            { label: "Pageview", data: [9, 9], days: ["2026-10-30", "2026-10-31"], compare_label: "previous" },
          ],
        },
      ],
    };
    const c = chartOf(json, { chart: "stacked" }, "insight");
    assert.equal(c.time, true);
    assert.deepEqual(c.series, [{ name: "iOS", values: [1, 2] }, { name: "Android", values: [3, 4] }]);
  });

  test("a funnel-shaped insight (name and count per step) charts as a funnel", () => {
    const json = { results: [{ result: [{ name: "Signed up", count: 10 }, { name: "Paid", count: 4 }] }] };
    const c = chartOf(json, { chart: "funnel" }, "insight");
    assert.deepEqual(c.labels, ["Signed up", "Paid"]);
    assert.deepEqual(c.series[0].values, [10, 4]);
  });

  test("the plain number keeps its old answers", () => {
    const r = normalize(q(["d", "n"], [["a", 1], ["b", 2]]), "query", { chart: "number" });
    assert.equal(r.value, 2);
    assert.deepEqual(r.spark, [1, 2]);
    assert.equal(r.chart, undefined, "no dates, no chart");
    const dated = normalize(q(["d", "n"], [["2026-11-01", 4], ["2026-11-02", 6]]), "query", { chart: "number" });
    assert.deepEqual(dated.chart, { type: "number", labels: ["2026-11-01", "2026-11-02"], series: [{ name: "Value", values: [4, 6] }], format: "auto", time: true });
    assert.throws(() => normalize(q(["a", "b", "c"], [[1, 2, 3]]), "query", {}), /one value, one column/);
  });
});

describe("posthog charts: config", () => {
  test("chart options are checked and kept; defaults fill the gaps", () => {
    const c = posthog.validate({ display: { chart: "donut", top: 5, headline: "share", color: "green" } });
    assert.deepEqual(c.display, { label: "", format: "auto", spark: true, compare: false, chart: "donut", top: 5, headline: "share", color: "green" });
    assert.equal((posthog.validate({}).display as Record<string, unknown>).chart, "number");
    for (const bad of [{ chart: "radar" }, { top: 51 }, { top: -1 }, { headline: "max" }, { color: "#fff" }]) {
      assert.throws(() => posthog.validate({ display: bad }), (e: any) => e.status === 422, JSON.stringify(bad));
    }
  });

  test("the inspector offers every chart type", () => {
    const f = posthog.fields.find((x) => x.key === "display.chart")!;
    assert.deepEqual(f.options!.map((o) => o.value), ["number", "line", "area", "bar", "hbar", "stacked", "pie", "donut", "ring", "funnel", "heatmap", "sparklines", "table"]);
  });
});

describe("chart page maths", () => {
  test("axis ticks are round steps from zero", () => {
    assert.deepEqual(niceTicks(0, 715, 4), [0, 200, 400, 600, 800]);
    assert.deepEqual(niceTicks(0, 92, 4), [0, 25, 50, 75, 100]);
    assert.deepEqual(niceTicks(0, 3, 3), [0, 1, 2, 3]);
    assert.deepEqual(niceTicks(0, 0.42, 4, false), [0, 0.2, 0.4, 0.6]);
    assert.deepEqual(niceTicks(-5, 10, 3), [-5, 0, 5, 10]);
    for (const t of niceTicks(0, 13_000, 4)) assert.equal(t % 1, 0);
  });

  test("numbers print like the server's stat card; ticks go compact once the axis reaches 10,000", () => {
    assert.equal(fmt(12345), "12.3K");
    assert.equal(fmt(1234, "integer"), "1,234");
    assert.equal(fmt(0.734, "percent"), "73.4%");
    assert.equal(tickText(5000, 15000), "5K");
    assert.equal(tickText(5000, 8000), "5,000");
  });

  test("dates on the axis and in the tooltip", () => {
    assert.equal(dateTick("2026-11-03", false), "Nov 3");
    assert.equal(dateTick("2026-11-03T14:00", true), "14:00");
    assert.equal(dateLong("2026-11-03", false), "Tue, Nov 3");
    assert.equal(dateTick("iOS", false), "iOS");
  });

  test("headlines: average for trends, the biggest named part's share for parts, conversion for funnels", () => {
    const trend = { type: "area", labels: ["2026-11-01", "2026-11-02"], series: [{ name: "n", values: [10, 20] }], format: "auto", time: true };
    assert.deepEqual(headlineOf(trend, {}, {}), { text: "15", caption: "average per day", delta: null });
    const last = headlineOf(trend, { headline: "last", compare: true }, {});
    assert.equal(last.text, "20");
    assert.equal(last.caption, "Mon, Nov 2");
    assert.equal(last.delta.display, "+100%");
    const parts = { type: "hbar", labels: ["Finland", "US", "Other"], series: [{ name: "n", values: [30, 10, 60] }], format: "auto", other: true };
    assert.deepEqual(headlineOf(parts, {}, {}), { text: "30%", caption: "Finland", delta: null });
    assert.equal(headlineOf(parts, { headline: "total" }, {}).text, "100");
    assert.equal(headlineOf(parts, { headline: "none" }, {}), null);
    const funnel = { type: "funnel", labels: ["a", "b"], series: [{ name: "n", values: [100, 45] }], format: "auto" };
    assert.equal(headlineOf(funnel, {}, {}).text, "45%");
    assert.equal(headlineOf(null, { chart: "number" }, { display: "1,234", delta: { value: 1, display: "+5%" } }).text, "1,234");
    const ring = { type: "ring", labels: ["Correct", "Wrong"], series: [{ name: "n", values: [3, 1] }], format: "auto" };
    assert.equal(headlineOf(ring, {}, {}), null, "a ring holds its value in its middle");
  });

  test("a number's change says what it is against, its sparkline what span it covers", () => {
    const days = { type: "number", labels: ["2026-11-14", "2026-11-15"], series: [{ name: "n", values: [1, 2] }], format: "auto", time: true };
    assert.equal(versus(days, new Date(2026, 10, 15, 12)), "vs yesterday");
    assert.equal(versus(days, new Date(2026, 10, 20)), "vs the day before");
    assert.equal(versus({ ...days, labels: ["2026-11-15T10:00", "2026-11-15T11:00"] }), "vs the hour before");
    assert.equal(versus(null), "vs previous");
    assert.equal(periodOf(days), "Last 2 days");
    assert.equal(periodOf(null), "");
  });
});
