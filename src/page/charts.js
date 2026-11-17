// Chart cards for PostHog widgets: one renderer for every display.chart type (number, line, area, bar,
// hbar, stacked, pie, donut, ring, funnel, heatmap, sparklines, table). Marks are SVG in card pixels, so they
// stay sharp at any canvas zoom; text that lists things (ranked rows, legends, tables) is HTML.
//
// Every card shares one frame, so a page of cards lines up: 20 px padding, a title row, a headline row
// (big number, caption, change), then the plot. Positions are computed here, not left to CSS flow, so the
// plot of every card starts at the same offset. Remote labels go through textContent only.
//
// Colour: categorical slots from the dataviz reference palette (validated for the card surfaces, light and
// dark, in charts.css). A single-series chart wears one accent (display.color); "Other" is neutral.

import { ageLabel, ageSec, originOf } from "./geometry.js";

const SVG = "http://www.w3.org/2000/svg";

// ---------- frame ----------
export const PAD = 20;
const TITLE_H = 16;
const HL_GAP = 4;
const HL_H = 34;
const PLOT_GAP = 16;
const LEGEND_H = 16;
const LEGEND_GAP = 14;
const AXIS_FS = 11;
const XAXIS_H = 20;
const TICK_GAP = 8;

export const COLORS = ["blue", "orange", "aqua", "yellow", "magenta", "green", "violet", "red"];

// ---------- numbers ----------
const nf = (o) => new Intl.NumberFormat("en-US", o);
const GROUP = nf({ maximumFractionDigits: 0 });
const COMPACT = nf({ notation: "compact", maximumFractionDigits: 1 });
const DEC = nf({ maximumFractionDigits: 2 });
const DEC1 = nf({ maximumFractionDigits: 1 });
const PCT = nf({ style: "percent", maximumFractionDigits: 1 });
const PCT0 = nf({ style: "percent", maximumFractionDigits: 0 });

function duration(sec) {
  const neg = sec < 0;
  let s = Math.abs(sec);
  if (s < 60) return (neg ? "-" : "") + Number(s.toFixed(s < 10 ? 1 : 0)) + "s";
  s = Math.round(s);
  const parts = [];
  for (const [n, u] of [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]]) {
    if (s >= n) { parts.push(Math.floor(s / n) + u); s %= n; }
    if (parts.length === 2) break;
  }
  return (neg ? "-" : "") + parts.join(" ");
}

/** The server's formatValue (src/widgets/format.ts), so a chart prints the numbers the stat card does. */
export function fmt(n, format = "auto") {
  if (typeof n !== "number" || !Number.isFinite(n)) return "–";
  if (format === "integer") return GROUP.format(n);
  if (format === "compact") return COMPACT.format(n);
  if (format === "percent") return PCT.format(n);
  if (format === "duration") return duration(n);
  if (format.startsWith("currency:")) {
    try { return nf({ style: "currency", currency: format.slice(9), maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n); } catch { return DEC.format(n); }
  }
  if (Math.abs(n) >= 10_000) return COMPACT.format(n);
  return Math.abs(n) >= 100 ? GROUP.format(n) : Math.abs(n) >= 10 ? DEC1.format(n) : DEC.format(n);
}

/** Axis tick text: one style per axis, compact once the axis reaches 10,000. */
export function tickText(n, top, format = "auto") {
  if (format === "percent") return PCT0.format(n);
  if (format === "duration") return duration(n);
  if (format.startsWith("currency:")) {
    try { return nf({ style: "currency", currency: format.slice(9), notation: top >= 10_000 ? "compact" : "standard", maximumFractionDigits: top >= 10_000 ? 1 : 0 }).format(n); } catch { /* fall through */ }
  }
  return top >= 10_000 ? COMPACT.format(n) : Number.isInteger(n) ? GROUP.format(n) : DEC.format(n);
}

/** Clean axis ticks from lo to hi: steps of 1, 2, 2.5 or 5 times a power of ten, zero included. */
export function niceTicks(lo, hi, count = 4, integer = true) {
  lo = Math.min(0, lo);
  hi = Math.max(0, hi);
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  if (integer && step < 1) step = 1;
  if (integer && step === 2.5) step = mag >= 1 ? 2 * mag : 2;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "2026-11-03" or "2026-11-03T14:00" as a local Date, or null. */
export function parseDay(label) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(label || "");
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
}
const hourly = (labels) => labels.some((l) => /T\d{2}:\d{2}/.test(l));
/** Axis text for a time label: "Nov 3", or "14:00" for hourly data. */
export function dateTick(label, isHourly) {
  const d = parseDay(label);
  if (!d) return label;
  if (isHourly) return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  return MONTHS[d.getMonth()] + " " + d.getDate();
}
/** Tooltip text for a time label: "Mon, Nov 3", or "Nov 3, 14:00". */
export function dateLong(label, isHourly) {
  const d = parseDay(label);
  if (!d) return label;
  const day = MONTHS[d.getMonth()] + " " + d.getDate();
  return isHourly ? day + ", " + dateTick(label, true) : DAYS[d.getDay()] + ", " + day;
}

// ---------- text measuring ----------
let measureCtx = null;
let fontFamily = "";
function textWidth(text, size, weight = 400) {
  if (typeof document === "undefined") return text.length * size * 0.56;
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
    fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--c-font-sans").trim() || "-apple-system, system-ui, sans-serif";
  }
  if (!measureCtx) return text.length * size * 0.56;
  measureCtx.font = `${weight} ${size}px ${fontFamily}`;
  return measureCtx.measureText(text).width;
}

// ---------- headline ----------
const localDay = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
/** What a number's change is measured against: "vs yesterday" when the last point is today. */
export function versus(chart, now = new Date()) {
  if (!chart || !chart.time || chart.labels.length < 2) return "vs previous";
  if (hourly(chart.labels)) return "vs the hour before";
  const last = chart.labels[chart.labels.length - 1];
  return last === localDay(now) ? "vs yesterday" : "vs the day before";
}
/** The span a sparkline covers: "Last 15 days". */
export function periodOf(chart) {
  if (!chart || !chart.time || chart.labels.length < 2) return "";
  const n = chart.labels.length;
  return hourly(chart.labels) ? `Last ${n} hours` : `Last ${n} days`;
}
const PARTS = new Set(["pie", "donut", "hbar", "table"]);
const TIME_FORMS = new Set(["line", "area", "bar", "stacked", "heatmap", "sparklines"]);

/** The big number over a chart, its caption, and the change to show beside it. */
export function headlineOf(chart, display, reading) {
  const mode = (display && display.headline) || "auto";
  const format = (display && display.format) || chart?.format || "auto";
  if (!chart || chart.type === "number") {
    const r = reading || {};
    return { text: r.display || "–", caption: "", delta: r.delta || null, vs: r.delta ? versus(chart) : "" };
  }
  if (mode === "none") return null;
  const n = chart.labels.length;
  const totals = chart.labels.map((_, i) => chart.series.reduce((a, s) => a + (s.values[i] || 0), 0));
  // A query that sends its own total (distinct people, seen in two groups) is the whole; the groups' sum would count them twice.
  const sum = totals.reduce((a, b) => a + b, 0);
  const whole = Number.isFinite(chart.total) ? chart.total : sum;
  const per = chart.time ? (hourly(chart.labels) ? "per hour" : "per day") : "";
  // A ring carries its value in its middle (Fitness, Screen Time): the header keeps only the title.
  if (chart.type === "ring" && mode === "auto") return null;
  if (chart.type === "ring") {
    const v = chart.series[0].values;
    const ratio = v.length === 1 ? v[0] : v[0] / Math.max(1e-9, v[0] + v[1]);
    return { text: PCT.format(ratio), caption: v.length > 1 ? chart.labels[0] : "", delta: null };
  }
  if (chart.type === "funnel" && mode === "auto") {
    const v = chart.series[0].values;
    const conv = v.length > 1 && v[0] ? v[v.length - 1] / v[0] : 1;
    return { text: PCT.format(conv), caption: "convert end to end", delta: null };
  }
  let m = mode;
  if (m === "auto") m = TIME_FORMS.has(chart.type) ? (chart.type === "sparklines" ? "none" : "average") : "share";
  if (m === "none") return null;
  if (m === "share") {
    // Parts of a whole lead with the biggest part: "53% Android".
    const first = chart.series[0].values;
    const all = Number.isFinite(chart.total) ? chart.total : first.reduce((a, b) => a + Math.max(0, b), 0);
    // The biggest named part: a catch-all ("Other") can be bigger, but it says nothing on its own.
    let i = -1;
    first.forEach((v, j) => { if (!isRest(chart.labels[j]) && (i < 0 || v > first[i])) i = j; });
    if (i < 0) i = 0;
    return { text: PCT0.format(all ? Math.max(0, first[i]) / all : 0), caption: chart.labels[i] || "", delta: null };
  }
  if (m === "total") return { text: fmt(whole, format), caption: "total", delta: null };
  if (m === "average") return { text: fmt(n ? sum / n : 0, format), caption: per ? "average " + per : "average", delta: null };
  // last
  const last = totals[n - 1] ?? 0;
  const caption = chart.time ? dateLong(chart.labels[n - 1], hourly(chart.labels)) : chart.labels[n - 1] || "latest";
  let delta = null;
  if (display && display.compare && n > 1) {
    const prev = totals[n - 2];
    const v = last - prev;
    const pct = prev !== 0 ? v / Math.abs(prev) : undefined;
    delta = { value: v, pct, display: pct !== undefined ? (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(pct * 100).toFixed(Math.abs(pct) < 0.1 ? 1 : 0) + "%" : (v > 0 ? "+" : "") + fmt(v, format) };
  }
  return { text: fmt(last, format), caption, delta };
}

// ---------- DOM helpers ----------
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function s(tag, attrs, parent) {
  const e = document.createElementNS(SVG, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.append(e);
  return e;
}
const setText = (e, t) => { if (e.textContent !== t) e.textContent = t; };
const r1 = (v) => Math.round(v * 10) / 10;
/** A hairline on the pixel grid at 100% zoom. */
const crisp = (v) => Math.round(v) + 0.5;
const slot = (i) => `var(--ch-${COLORS[i % COLORS.length]})`;
let gradSeq = 0;

/** A bar from the baseline up, its data end rounded and the baseline end square. */
function barPath(x, y, w, hgt, r, down = false) {
  if (hgt <= 0 || w <= 0) return "";
  const rr = Math.min(r, w / 2, hgt);
  if (!down) {
    const b = y + hgt;
    return `M${r1(x)},${r1(b)}V${r1(y + rr)}Q${r1(x)},${r1(y)} ${r1(x + rr)},${r1(y)}H${r1(x + w - rr)}Q${r1(x + w)},${r1(y)} ${r1(x + w)},${r1(y + rr)}V${r1(b)}Z`;
  }
  const b = y + hgt;
  return `M${r1(x)},${r1(y)}V${r1(b - rr)}Q${r1(x)},${r1(b)} ${r1(x + rr)},${r1(b)}H${r1(x + w - rr)}Q${r1(x + w)},${r1(b)} ${r1(x + w)},${r1(b - rr)}V${r1(y)}Z`;
}
/** A horizontal bar from the left, its right end rounded. */
function hbarPath(x, y, w, hgt, r) {
  if (w <= 0) return "";
  const rr = Math.min(r, hgt / 2, w);
  return `M${r1(x)},${r1(y)}H${r1(x + w - rr)}Q${r1(x + w)},${r1(y)} ${r1(x + w)},${r1(y + rr)}V${r1(y + hgt - rr)}Q${r1(x + w)},${r1(y + hgt)} ${r1(x + w - rr)},${r1(y + hgt)}H${r1(x)}Z`;
}
function arcPath(cx, cy, R, r, a0, a1) {
  const p = (rad, a) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
  const big = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(R, a0), [x1, y1] = p(R, a1);
  if (r <= 0) return `M${r1(cx)},${r1(cy)}L${r1(x0)},${r1(y0)}A${R},${R} 0 ${big} 1 ${r1(x1)},${r1(y1)}Z`;
  const [x2, y2] = p(r, a1), [x3, y3] = p(r, a0);
  return `M${r1(x0)},${r1(y0)}A${R},${R} 0 ${big} 1 ${r1(x1)},${r1(y1)}L${r1(x2)},${r1(y2)}A${r},${r} 0 ${big} 0 ${r1(x3)},${r1(y3)}Z`;
}

// ---------- the card ----------
/**
 * A chart card renderer, the same contract as the other kinds: `{ el, update(widget, reading) }`.
 * ctx: { widget(), trust() } as in widget-kinds.js.
 */
export function chartCard(ctx) {
  const root = h("div", "ch");
  root.dataset.state = "loading";
  const title = h("div", "ch-title");
  const meta = h("div", "ch-meta");
  const hl = h("div", "ch-hl");
  const hlVal = h("span", "ch-val");
  const hlCap = h("span", "ch-cap");
  const hlDelta = h("span", "ch-delta");
  const hlVs = h("span", "ch-vs");
  hl.append(hlVal, hlCap, hlDelta, hlVs);
  const plot = h("div", "ch-plot");
  const legend = h("div", "ch-legend");
  const msg = h("div", "ch-msg");
  const msgTitle = h("div", "ch-msg-title");
  const msgText = h("div", "ch-msg-text");
  const btn = h("button", "ch-btn", "Allow");
  btn.type = "button";
  btn.setAttribute("data-nodrag", "");
  btn.onclick = () => {
    btn.disabled = true;
    Promise.resolve(ctx.trust && ctx.trust()).catch(() => {}).finally(() => { btn.disabled = false; });
  };
  msg.append(msgTitle, msgText, btn);
  const tip = h("div", "ch-tip");
  const tipVal = h("div", "ch-tip-val");
  const tipRows = h("div", "ch-tip-rows");
  const tipLabel = h("div", "ch-tip-label");
  tip.append(tipVal, tipRows, tipLabel);
  tip.hidden = true;
  root.append(title, meta, hl, plot, legend, msg, tip);

  let key = "";
  let hover = null; // { move(x, y), leave() } for the drawn chart
  let size = { W: 0, H: 0 };

  // Pointer position in card pixels, whatever the canvas zoom.
  const local = (ev) => {
    const b = root.getBoundingClientRect();
    const k = b.width / (size.W || 1);
    return { x: (ev.clientX - b.left) / k, y: (ev.clientY - b.top) / k };
  };
  root.addEventListener("pointermove", (ev) => { if (hover && ev.buttons === 0) { const p = local(ev); hover.move(p.x, p.y); } });
  root.addEventListener("pointerleave", () => { if (hover) hover.leave(); hideTip(); });
  root.addEventListener("pointerdown", () => { if (hover) hover.leave(); hideTip(); });

  function hideTip() { tip.hidden = true; }
  /** The floating value label: value first, then the rows (several series), then the label. Kept inside the card. */
  function showTip(x, y, value, label, rows) {
    setText(tipVal, value || "");
    tipVal.hidden = !value;
    tipRows.textContent = "";
    for (const r of rows || []) {
      const row = h("div", "ch-tip-row");
      const key = h("i", "ch-key" + (r.line ? " line" : ""));
      key.style.background = r.color;
      row.append(key, h("span", "ch-tip-name", r.name), h("b", "", r.value));
      tipRows.append(row);
    }
    tipRows.hidden = !(rows && rows.length);
    setText(tipLabel, label || "");
    tipLabel.hidden = !label;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x - tw / 2;
    left = Math.max(8, Math.min(size.W - tw - 8, left));
    let top = y - th - 12;
    if (top < 8) top = Math.min(size.H - th - 8, y + 16);
    tip.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  }

  // The card's size can change without an update (a width-only edit): follow the box itself.
  let last = null;
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (!last || !root.isConnected) return;
      const W = root.clientWidth, H = root.clientHeight;
      if (W && H && (W !== size.W || H !== size.H)) update({ ...last.w, w: W + 2, h: H + 2 }, last.r);
    }).observe(root);
  }

  function update(w, r) {
    last = { w, r };
    const c = (w && w.config) || {};
    const display = c.display || {};
    const state = r ? r.state : "loading";
    const W = Math.max(0, Math.round((w.w || 0) - 2));
    const H = Math.max(0, Math.round((w.h || 0) - 2));
    const chart = r && r.chart && (display.chart || "number") === r.chart.type ? r.chart : null;
    const type = display.chart || "number";
    root.dataset.state = state;
    root.dataset.type = type;
    root.style.setProperty("--ch-accent", `var(--ch-${COLORS.includes(display.color) ? display.color : "blue"})`);
    setText(title, display.label || (r && r.label) || w.name || "PostHog");
    // Meta: only when something needs saying (stale data).
    let m = "";
    if (state === "stale") { const a = ageLabel(ageSec(r.updatedAt)); m = a ? "Updated " + a + " ago" : "Not current"; }
    setText(meta, m);
    meta.hidden = !m;

    const k = JSON.stringify([W, H, state === "stale" ? "ok" : state, type, display, chart, type === "number" && r ? [r.display, r.spark, r.delta] : 0, r && r.error && r.error.message]);
    if (k === key) return;
    key = k;
    size = { W, H };
    hover = null;
    hideTip();

    // Messages: loading, errors, the key and the trust prompt.
    let mt = "", mx = "";
    btn.hidden = state !== "needs-approval";
    const hasData = type === "number" ? !!(r && r.display) : !!chart;
    if (state === "error" && !(r.error && r.error.code === "no-data")) { mt = "Couldn’t load"; mx = (r.error && r.error.message) || ""; }
    else if (state === "error") { mt = "No data yet"; mx = "The query returned no rows."; }
    else if (state === "needs-secret") { mt = "Needs an API key"; mx = "Add your PostHog personal API key in the inspector."; }
    else if (state === "needs-approval") { mt = "Allow PostHog?"; mx = "Send your key to " + (originOf("posthog", c) || "this server") + "."; }
    else if (!hasData) { mt = "Loading"; mx = ""; }
    msg.hidden = !mt;
    setText(msgTitle, mt);
    setText(msgText, mx);
    msgText.hidden = !mx;
    root.classList.toggle("ch-empty", !!mt);

    // Header.
    const head = mt ? null : headlineOf(chart, display, r);
    hl.hidden = !head;
    if (head) {
      setText(hlVal, head.text);
      setText(hlCap, head.caption || "");
      hlCap.hidden = !head.caption;
      const d = head.delta;
      hlDelta.hidden = !d;
      setText(hlVs, (d && head.vs) || "");
      hlVs.hidden = !(d && head.vs);
      if (d) {
        const sign = d.value > 0 ? 1 : d.value < 0 ? -1 : 0;
        setText(hlDelta, (sign > 0 ? "▲ " : sign < 0 ? "▼ " : "") + d.display.replace(/^[+-]/, ""));
        hlDelta.className = "ch-delta" + (sign > 0 ? " up" : sign < 0 ? " down" : "");
        hlDelta.title = (sign > 0 ? "Up " : sign < 0 ? "Down " : "No change ") + d.display.replace(/^[+-]/, "") + " from the previous point";
      }
    }
    hl.style.top = PAD + TITLE_H + HL_GAP + "px";

    // Plot box.
    plot.textContent = "";
    legend.textContent = "";
    const multi = chart && chart.series.length > 1 && ["line", "area", "bar", "stacked"].includes(type);
    legend.hidden = !multi;
    // Small multiples have no card headline: each tile has its own, on the headline row of its neighbours.
    const top = type === "sparklines" ? PAD + TITLE_H + HL_GAP + 15 : PAD + TITLE_H + (head ? HL_GAP + HL_H : 0) + PLOT_GAP;
    const bottom = H - PAD - (multi ? LEGEND_H + LEGEND_GAP : 0);
    const box = { x: PAD, y: top, w: Math.max(0, W - PAD * 2), h: Math.max(0, bottom - top) };
    plot.style.cssText = `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`;
    msg.style.top = (PAD + TITLE_H) + "px";
    if (mt || box.h < 24 || box.w < 40) return;
    if (multi) drawLegend(chart, type);
    const draw = DRAW[type] || DRAW.line;
    const data = type === "number" ? { type: "number", labels: chart && chart.labels.length === (r.spark || []).length ? chart.labels : (r.spark || []).map((_, i) => String(i)), time: !!(chart && chart.time && chart.labels.length === (r.spark || []).length), series: [{ name: "", values: r.spark || [] }], format: display.format || "auto" } : chart;
    hover = draw(plot, box, data, { display, showTip: (x, y, v, l, rows) => showTip(x + box.x, y + box.y, v, l, rows), hideTip, h, W, H }) || null;
    if (hover) {
      const move = hover.move;
      hover = { move: (x, y) => move(x - box.x, y - box.y), leave: hover.leave };
    }
  }

  function drawLegend(chart, type) {
    legend.style.cssText = `left:${PAD}px;bottom:${PAD}px;right:${PAD}px`;
    chart.series.forEach((se, i) => {
      const item = h("span", "ch-leg");
      const key = h("i", "ch-key" + (type === "line" ? " line" : ""));
      key.style.background = colorOf(chart, i);
      item.append(key, h("span", "", se.name));
      legend.append(item);
    });
  }

  return { el: root, update };
}

// ---------- chart forms ----------
const isRest = (name) => name === "Other" || name === "Unknown";
const colorOf = (chart, i) => (chart.series.length > 1 && isRest(chart.series[i].name) && i === chart.series.length - 1 ? "var(--ch-other)" : chart.series.length === 1 ? "var(--ch-accent)" : slot(i));

/** Y axis on the trailing edge (Swift Charts' default), hairline grid, ticks that read as round numbers. */
function axes(svg, box, lo, hi, format, opts = {}) {
  const plotH = box.h - (opts.noX ? 0 : XAXIS_H);
  const count = Math.max(2, Math.min(4, Math.floor(plotH / 34)));
  const integer = !(format === "percent") && opts.integer !== false;
  const ticks = niceTicks(lo, hi, count, integer);
  const tLo = ticks[0], tHi = ticks[ticks.length - 1];
  const texts = ticks.map((t) => tickText(t, Math.max(Math.abs(tLo), Math.abs(tHi)), format));
  const labelW = Math.ceil(Math.max(...texts.map((t) => textWidth(t, AXIS_FS)))) ;
  const plotW = Math.max(10, box.w - labelW - TICK_GAP);
  const top = 6;
  const y = (v) => top + (1 - (v - tLo) / (tHi - tLo || 1)) * (plotH - top);
  const g = s("g", { class: "ch-axis" }, svg);
  ticks.forEach((t, i) => {
    const yy = crisp(y(t));
    s("line", { x1: 0, x2: plotW, y1: yy, y2: yy, class: t === 0 ? "ch-base" : "ch-grid" }, g);
    const tx = s("text", { x: plotW + TICK_GAP, y: r1(y(t)), "dominant-baseline": "central", class: "ch-tick" }, g);
    tx.textContent = texts[i];
  });
  return { y, plotW, plotH, lo: tLo, hi: tHi };
}

/** Time or category labels under the plot: as many as fit without touching, the ends pinned. */
function xLabels(svg, chart, xs, plotW, baseY, centered) {
  const n = chart.labels.length;
  const isH = chart.time && hourly(chart.labels);
  const text = (i) => (chart.time ? dateTick(chart.labels[i], isH) : chart.labels[i]);
  const widest = Math.max(...chart.labels.map((_, i) => textWidth(text(i), AXIS_FS)));
  const fit = Math.max(1, Math.floor(plotW / (widest + 18)));
  // Ticks start at the first point and step evenly from there: a week at a time for daily data (Apple
  // Health), 6 hours for hourly data, else the smallest step that keeps labels apart.
  const need = n <= fit ? 1 : Math.ceil((n - 1) / Math.max(1, fit - 1));
  const daily = chart.time && !isH;
  const ladder = daily ? [1, 2, 7, 14, 28, 56, 91] : isH ? [1, 2, 3, 6, 12, 24, 48] : [];
  const step = ladder.find((v) => v >= need) || need;
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  const g = s("g", { class: "ch-axis" }, svg);
  for (const i of [...new Set(idx)]) {
    const t = text(i);
    const w = textWidth(t, AXIS_FS);
    let anchor = "middle";
    let x = xs(i);
    if (x - w / 2 < 0) { anchor = "start"; x = Math.max(0, x - (centered ? w / 2 : 0)); if (!centered) x = 0; }
    else if (x + w / 2 > plotW) { anchor = "end"; x = centered ? Math.min(plotW, x + w / 2) : plotW; }
    const tx = s("text", { x: r1(x), y: baseY + 15, "text-anchor": anchor, class: "ch-tick" }, g);
    tx.textContent = t;
  }
}

function svgIn(plot, box, label) {
  const svg = s("svg", { width: box.w, height: box.h, viewBox: `0 0 ${box.w} ${box.h}`, class: "ch-svg", role: "img" });
  if (label) svg.setAttribute("aria-label", label);
  plot.append(svg);
  return svg;
}

function tipRowsAt(chart, i, format) {
  return chart.series.map((se, j) => ({ name: se.name, value: fmt(se.values[i], format), color: colorOf(chart, j), line: chart.type === "line" }));
}
const labelText = (chart, i) => (chart.time ? dateLong(chart.labels[i], hourly(chart.labels)) : chart.labels[i]);

function lineLike(area) {
  return (plot, box, chart, o) => {
    const svg = svgIn(plot, box);
    const fmtS = o.display.format || chart.format;
    const all = chart.series.flatMap((se) => se.values);
    const n = chart.labels.length;
    let ax;
    if (o.spark) {
      // A sparkline under a number: no axes, its own range, 4 px clear of the dot at either end, and the
      // span it covers in one muted line under it.
      const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
      const period = periodOf(chart);
      const plotH = period ? box.h - 18 : box.h;
      if (period) {
        const t = s("text", { x: 0, y: box.h - 2, class: "ch-tick" }, svg);
        t.textContent = period;
      }
      ax = { plotW: box.w - 5, plotH, lo, hi, y: (v) => 5 + (1 - (v - lo) / span) * (plotH - 10) };
    } else ax = axes(svg, box, Math.min(...all), Math.max(...all), fmtS);
    const xs = (i) => (n === 1 ? ax.plotW / 2 : (i / (n - 1)) * ax.plotW);
    if (!o.spark) xLabels(svg, chart, xs, ax.plotW, ax.plotH, false);
    const base = o.spark ? ax.plotH : ax.y(Math.max(ax.lo, 0));
    const marks = s("g", {}, svg);
    chart.series.forEach((se, si) => {
      const color = colorOf(chart, si);
      const pts = se.values.map((v, i) => [r1(xs(i)), r1(ax.y(v))]);
      const d = "M" + pts.map((p) => p.join(",")).join("L");
      if (area) {
        const id = "chg" + ++gradSeq;
        const defs = s("defs", {}, svg);
        const lg = s("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        const a = s("stop", { offset: "0%" }, lg); a.style.stopColor = color; a.style.stopOpacity = chart.series.length > 1 ? "0.14" : "0.22";
        const b = s("stop", { offset: "100%" }, lg); b.style.stopColor = color; b.style.stopOpacity = "0.02";
        const fill = s("path", { d: `${d}L${pts[pts.length - 1][0]},${r1(base)}L${pts[0][0]},${r1(base)}Z`, class: "ch-area" }, marks);
        fill.style.fill = `url(#${id})`;
      }
      const line = s("path", { d, class: "ch-line" }, marks);
      line.style.stroke = color;
    });
    // End markers: the latest value of each series, ringed in the surface colour.
    chart.series.forEach((se, si) => {
      const c = s("circle", { cx: r1(xs(n - 1)), cy: r1(ax.y(se.values[n - 1])), r: 4, class: "ch-dot" }, marks);
      c.style.fill = colorOf(chart, si);
    });
    // Hover: a crosshair snapped to the nearest point, a dot per series, one tooltip with every series.
    const cross = s("line", { y1: 0, y2: ax.plotH, class: "ch-cross" }, svg);
    const dots = chart.series.map((_, si) => { const c = s("circle", { r: 4, class: "ch-dot ch-hov" }, svg); c.style.fill = colorOf(chart, si); return c; });
    const hideHover = () => { cross.style.display = "none"; dots.forEach((d) => (d.style.display = "none")); };
    hideHover();
    return {
      move(x, y) {
        if (x < -4 || x > ax.plotW + 4 || y < 0 || y > box.h) { hideHover(); o.hideTip(); return; }
        const i = Math.max(0, Math.min(n - 1, Math.round((x / (ax.plotW || 1)) * (n - 1))));
        const cx = crisp(xs(i));
        cross.setAttribute("x1", cx); cross.setAttribute("x2", cx);
        cross.style.display = "";
        let topY = ax.plotH;
        chart.series.forEach((se, si) => {
          const cy = ax.y(se.values[i]);
          topY = Math.min(topY, cy);
          dots[si].setAttribute("cx", r1(xs(i))); dots[si].setAttribute("cy", r1(cy)); dots[si].style.display = "";
        });
        if (o.spark) o.showTip(xs(i), topY, fmt(chart.series[0].values[i], fmtS), chart.time ? labelText(chart, i) : "");
        else if (chart.series.length === 1) o.showTip(xs(i), topY, fmt(chart.series[0].values[i], fmtS), labelText(chart, i));
        else o.showTip(xs(i), topY, "", labelText(chart, i), tipRowsAt(chart, i, fmtS));
      },
      leave() { hideHover(); o.hideTip(); },
    };
  };
}

/** Column sizes for a band: a gap between segments or grouped bars, and every grouped bar at least 1 px wide. */
export function barSizes(band, n, groups, stacked) {
  let gap = band >= 6 ? 2 : band >= 3 ? 1 : 0;
  // Thin columns that never fill the slot: at most 24 px, about 60% of the band.
  const barW = Math.max(1, Math.min(24 * (stacked ? 1 : Math.min(groups, 3)), band * (n > 40 ? 0.7 : 0.6)));
  if (!stacked && groups > 1) gap = Math.min(gap, Math.max(0, (barW - groups) / (groups - 1)));
  const subW = !stacked && groups > 1 ? Math.max(1, (barW - gap * (groups - 1)) / groups) : barW;
  return { gap, barW, subW };
}

function bars(stacked) {
  return (plot, box, chart, o) => {
    const svg = svgIn(plot, box);
    const fmtS = o.display.format || chart.format;
    const n = chart.labels.length;
    const totals = chart.labels.map((_, i) => chart.series.reduce((a, se) => a + Math.max(0, se.values[i] || 0), 0));
    const all = stacked ? totals : chart.series.flatMap((se) => se.values);
    const ax = axes(svg, box, Math.min(0, ...all), Math.max(...all), fmtS);
    const band = ax.plotW / n;
    const groups = stacked ? 1 : chart.series.length;
    const { gap, barW, subW } = barSizes(band, n, groups, stacked);
    const xs = (i) => i * band + band / 2;
    xLabels(svg, chart, xs, ax.plotW, ax.plotH, true);
    const base = ax.y(0);
    const cols = [];
    const radius = Math.min(4, subW / 2);
    for (let i = 0; i < n; i++) {
      const g = s("g", { class: "ch-col" }, svg);
      cols.push(g);
      const x0 = xs(i) - barW / 2;
      if (stacked) {
        let acc = 0;
        const parts = chart.series.map((se, si) => ({ v: Math.max(0, se.values[i] || 0), si })).filter((p) => p.v > 0);
        parts.forEach((p, k) => {
          const yTop = ax.y(acc + p.v), yBot = ax.y(acc);
          acc += p.v;
          const isTop = k === parts.length - 1;
          // A 2 px surface gap between segments: each segment gives up the top 2 px it shares.
          const hgt = yBot - yTop - (isTop ? 0 : gap);
          if (hgt <= 0.3) return;
          const d = isTop ? barPath(x0, yTop, barW, hgt, radius) : `M${r1(x0)},${r1(yTop + gap)}h${r1(barW)}v${r1(hgt)}h${r1(-barW)}Z`;
          const path = s("path", { d, class: "ch-bar" }, g);
          path.style.fill = colorOf(chart, p.si);
        });
      } else {
        chart.series.forEach((se, si) => {
          const v = se.values[i] || 0;
          const x = x0 + si * (subW + gap);
          const neg = v < 0;
          const yTop = neg ? base : ax.y(v);
          const hgt = Math.abs(ax.y(v) - base);
          if (hgt < 0.5) return;
          const path = s("path", { d: barPath(x, yTop, subW, hgt, radius, neg), class: "ch-bar" }, g);
          path.style.fill = colorOf(chart, si);
        });
      }
      // The hit target is the whole band, not the painted bar.
      s("rect", { x: i * band, y: 0, width: band, height: ax.plotH, class: "ch-hit" }, g);
    }
    let on = -1;
    const set = (i) => {
      if (i === on) return;
      on = i;
      svg.classList.toggle("ch-focus", i >= 0);
      cols.forEach((g, j) => g.classList.toggle("on", j === i));
    };
    return {
      move(x, y) {
        if (x < 0 || x > ax.plotW || y < 0 || y > ax.plotH + XAXIS_H) { set(-1); o.hideTip(); return; }
        const i = Math.max(0, Math.min(n - 1, Math.floor(x / band)));
        set(i);
        const topY = ax.y(stacked ? totals[i] : Math.max(0, ...chart.series.map((se) => se.values[i] || 0)));
        if (chart.series.length === 1) o.showTip(xs(i), topY, fmt(chart.series[0].values[i], fmtS), labelText(chart, i));
        else o.showTip(xs(i), topY, stacked ? fmt(totals[i], fmtS) : "", labelText(chart, i), tipRowsAt(chart, i, fmtS).filter((r, j) => (chart.series[j].values[i] || 0) !== 0 || !stacked).reverse());
      },
      leave() { set(-1); o.hideTip(); },
    };
  };
}

/** Ranked rows in the Screen Time manner: name and value on one line, a thin bar under them. */
function rankedRows(plot, box, chart, o, opts = {}) {
  const fmtS = o.display.format || chart.format;
  const se = chart.series[0];
  const n = chart.labels.length;
  // One rhythm for every ranked card: 36 px rows, 8 px bars. A funnel's few steps spread out to 48.
  const BAR = 8;
  const fit = Math.max(1, Math.floor((box.h + 8) / 36));
  const shown = Math.min(n, fit);
  const ROW = opts.funnel ? Math.max(36, Math.min(48, Math.floor((box.h + 8) / Math.max(1, shown)))) : 36;
  const max = opts.funnel ? se.values[0] || 1 : Math.max(...se.values.slice(0, shown).filter((_, i) => chart.labels[i] !== "Other" || shown === 1), 1e-9);
  const total = se.values.reduce((a, b) => a + b, 0);
  const list = h("div", "ch-rows");
  const rows = [];
  for (let i = 0; i < shown; i++) {
    const v = se.values[i];
    const other = chart.other && i === n - 1;
    const row = h("div", "ch-row" + (other ? " other" : ""));
    row.style.height = ROW + "px";
    const line = h("div", "ch-row-line");
    const name = h("span", "ch-row-name", chart.labels[i]);
    const val = h("span", "ch-row-val", fmt(v, fmtS));
    line.append(name);
    if (opts.funnel && i > 0) line.append(h("span", "ch-row-pct", PCT0.format(se.values[0] ? v / se.values[0] : 0)));
    line.append(val);
    const track = h("div", "ch-row-track");
    const bar = h("div", "ch-row-bar");
    bar.style.width = Math.max(0.5, Math.min(100, (Math.max(0, v) / max) * 100)) + "%";
    bar.style.height = BAR + "px";
    if (!other) bar.style.background = "var(--ch-accent)";
    track.append(bar);
    row.append(line, track);
    list.append(row);
    rows.push(row);
  }
  if (shown < n) {
    const more = h("div", "ch-more", `${n - shown} more`);
    list.append(more);
  }
  plot.append(list);
  let on = -1;
  return {
    move(x, y) {
      const i = Math.floor((y + 4) / ROW);
      if (x < 0 || x > box.w || i < 0 || i >= shown) { if (on >= 0) rows[on].classList.remove("on"); on = -1; list.classList.remove("ch-focus"); o.hideTip(); return; }
      if (on !== i) { if (on >= 0) rows[on].classList.remove("on"); rows[i].classList.add("on"); on = i; list.classList.add("ch-focus"); }
      const v = se.values[i];
      const share = opts.funnel ? (i === 0 ? "First step" : PCT.format(v / (se.values[i - 1] || 1)) + " of the step before") : PCT.format(total ? v / total : 0) + " of the total";
      const barEnd = (Math.max(0, v) / max) * box.w;
      o.showTip(Math.min(barEnd, box.w - 20), i * ROW + 12, fmt(v, fmtS), chart.labels[i] + ", " + share);
    },
    leave() { if (on >= 0) rows[on].classList.remove("on"); on = -1; list.classList.remove("ch-focus"); o.hideTip(); },
  };
}

/** Pie or donut on the left, a legend with values and shares on the right. */
function pieLike(donut) {
  return (plot, box, chart, o) => {
    const fmtS = o.display.format || chart.format;
    const se = chart.series[0];
    const vals = se.values.map((v) => Math.max(0, v));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const D = Math.max(40, Math.min(box.h, box.w * 0.46));
    const svg = s("svg", { width: D, height: D, viewBox: `0 0 ${D} ${D}`, class: "ch-svg ch-pie", role: "img" });
    const cy = D / 2, cx = D / 2, R = D / 2 - 1, r = donut ? R * 0.62 : 0;
    const wrap = h("div", "ch-pie-wrap");
    wrap.style.height = box.h + "px";
    const fig = h("div", "ch-pie-fig");
    fig.style.width = D + "px";
    fig.style.height = D + "px";
    fig.append(svg);
    let a = 0;
    const slices = [];
    const color = (i) => (chart.other && i === vals.length - 1 ? "var(--ch-other)" : slot(i));
    vals.forEach((v, i) => {
      const a1 = a + (v / total) * Math.PI * 2;
      const path = vals.filter((x) => x > 0).length === 1 && v > 0
        ? s("circle", { cx, cy, r: r ? (R + r) / 2 : R, class: "ch-slice" + (r ? " ring" : "") }, svg)
        : s("path", { d: arcPath(cx, cy, R, r, a, a1), class: "ch-slice" }, svg);
      if (path.tagName === "circle" && r) { path.style.stroke = color(i); path.style.strokeWidth = String(R - r); path.style.fill = "none"; }
      else path.style.fill = color(i);
      slices.push({ el: path, a0: a, a1 });
      a = a1;
    });
    if (donut) {
      // The centre holds the whole the parts add up to.
      const center = h("div", "ch-pie-center");
      const big = h("div", "ch-pie-big", fmt(Number.isFinite(chart.total) ? chart.total : vals.reduce((a, b) => a + b, 0), fmtS));
      const what = h("div", "ch-pie-what", "total");
      what.style.maxWidth = Math.floor(r * 1.5) + "px";
      center.append(big, what);
      fig.append(center);
    }
    const leg = h("div", "ch-pie-legend");
    const rows = [];
    vals.forEach((v, i) => {
      const row = h("div", "ch-pie-row");
      const key = h("i", "ch-key");
      key.style.background = color(i);
      row.append(key, h("span", "ch-pie-name", chart.labels[i]), h("span", "ch-pie-val", fmt(se.values[i], fmtS)), h("span", "ch-pie-pct", PCT0.format(v / total)));
      leg.append(row);
      rows.push(row);
    });
    wrap.append(fig, leg);
    plot.append(wrap);
    let on = -1;
    const set = (i) => {
      if (on === i) return;
      on = i;
      wrap.classList.toggle("ch-focus", i >= 0);
      slices.forEach((sl, j) => sl.el.classList.toggle("on", j === i));
      rows.forEach((row, j) => row.classList.toggle("on", j === i));
    };
    const figLeft = 0, figTop = (box.h - D) / 2;
    return {
      move(x, y) {
        let i = -1;
        const dx = x - figLeft - cx, dy = y - figTop - cy, dist = Math.hypot(dx, dy);
        if (dist <= R && dist >= r - 2) {
          let ang = Math.atan2(dx, -dy);
          if (ang < 0) ang += Math.PI * 2;
          i = slices.findIndex((sl) => ang >= sl.a0 && ang < sl.a1);
        } else if (x > D + 8) {
          const lr = leg.getBoundingClientRect(), pr = plot.getBoundingClientRect();
          const k = pr.height / (box.h || 1);
          const ly = y - (lr.top - pr.top) / k;
          const ri = Math.floor(ly / 24);
          if (ri >= 0 && ri < rows.length) i = ri;
        }
        set(i);
        if (i < 0) { o.hideTip(); return; }
        const mid = (slices[i].a0 + slices[i].a1) / 2;
        const tx = figLeft + cx + Math.sin(mid) * (R + r) / 2, ty = figTop + cy - Math.cos(mid) * (R + r) / 2;
        o.showTip(tx, ty, fmt(se.values[i], fmtS), chart.labels[i] + ", " + PCT.format(vals[i] / total));
      },
      leave() { set(-1); o.hideTip(); },
    };
  };
}

/** A Fitness ring: one ratio, round caps, the track a wash of the same hue. */
function ring(plot, box, chart, o) {
  const fmtS = o.display.format || chart.format;
  const v = chart.series[0].values;
  const ratio = Math.max(0, Math.min(1, v.length === 1 ? v[0] : v[0] / Math.max(1e-9, v[0] + v[1])));
  const D = Math.max(40, Math.min(box.h, box.w * 0.46));
  const sw = Math.max(8, Math.round(D * 0.13));
  const R = (D - sw) / 2;
  const wrap = h("div", "ch-pie-wrap");
  wrap.style.height = box.h + "px";
  const fig = h("div", "ch-pie-fig");
  fig.style.width = D + "px";
  fig.style.height = D + "px";
  const svg = s("svg", { width: D, height: D, viewBox: `0 0 ${D} ${D}`, class: "ch-svg", role: "img" }, fig);
  s("circle", { cx: D / 2, cy: D / 2, r: R, class: "ch-ring-track", "stroke-width": sw }, svg);
  const C = 2 * Math.PI * R;
  const arc = s("circle", { cx: D / 2, cy: D / 2, r: R, class: "ch-ring", "stroke-width": sw, "stroke-dasharray": `${r1(C * ratio)} ${r1(C)}`, transform: `rotate(-90 ${D / 2} ${D / 2})` }, svg);
  if (ratio <= 0) arc.style.display = "none";
  const center = h("div", "ch-pie-center");
  center.append(h("div", "ch-ring-big", PCT.format(ratio)));
  if (v.length > 1) center.append(h("div", "ch-pie-what", chart.labels[0]));
  center.lastChild.style.maxWidth = Math.floor((R - sw / 2) * 1.6) + "px";
  fig.append(center);
  const leg = h("div", "ch-pie-legend");
  if (v.length > 1) {
    [[chart.labels[0], v[0], "var(--ch-accent)"], [chart.labels[1] || "Rest", v[1], "var(--ch-other)"]].forEach(([name, val, col]) => {
      const row = h("div", "ch-pie-row");
      const key = h("i", "ch-key");
      key.style.background = col;
      row.append(key, h("span", "ch-pie-name", name), h("span", "ch-pie-val", fmt(val, fmtS)));
      leg.append(row);
    });
  }
  wrap.append(fig, leg);
  plot.append(wrap);
  return null;
}

/** A calendar of days: weeks as columns, weekdays as rows, one sequential hue. */
function heatmap(plot, box, chart, o) {
  const fmtS = o.display.format || chart.format;
  const days = chart.labels.map((l, i) => ({ d: parseDay(l), v: chart.series.reduce((a, se) => a + (se.values[i] || 0), 0), i })).filter((x) => x.d);
  if (!days.length) return null;
  const first = days[0].d;
  const mondayIdx = (d) => (d.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - mondayIdx(first));
  const weekOf = (d) => Math.floor((Math.round((d - start) / 86400000)) / 7);
  const weeks = weekOf(days[days.length - 1].d) + 1;
  const LABEL_W = Math.ceil(textWidth("Wed", AXIS_FS)) + 8;
  const MONTH_H = 18, LEG_H = 22;
  const GAP = 3;
  const cell = Math.max(4, Math.min(22, Math.floor((box.w - LABEL_W - GAP * (weeks - 1)) / weeks), Math.floor((box.h - MONTH_H - LEG_H - GAP * 6) / 7)));
  const svg = svgIn(plot, box);
  const gx = LABEL_W, gy = MONTH_H;
  // Four steps at the quartiles of the active days, so a single spike does not wash every other day out.
  const nz = days.map((x) => x.v).filter((v) => v > 0).sort((a, b) => a - b);
  const q = [0.25, 0.5, 0.75].map((p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] ?? 0);
  const level = (v) => (v <= 0 ? 0 : v <= q[0] ? 1 : v <= q[1] ? 2 : v <= q[2] ? 3 : 4);
  const g = s("g", {}, svg);
  const cells = [];
  for (const x of days) {
    const col = weekOf(x.d), row = mondayIdx(x.d);
    const rect = s("rect", { x: gx + col * (cell + GAP), y: gy + row * (cell + GAP), width: cell, height: cell, rx: Math.min(4, cell / 4), class: "ch-cell l" + level(x.v) }, g);
    cells.push({ rect, x, col, row });
  }
  const ax = s("g", { class: "ch-axis" }, svg);
  [["Mon", 0], ["Wed", 2], ["Fri", 4]].forEach(([t, row]) => {
    const tx = s("text", { x: 0, y: r1(gy + row * (cell + GAP) + cell / 2), "dominant-baseline": "central", class: "ch-tick" }, ax);
    tx.textContent = t;
  });
  let lastMonth = -1, lastX = -99;
  for (const x of days) {
    const m = x.d.getMonth();
    if (m === lastMonth) continue;
    lastMonth = m;
    const col = weekOf(x.d) + (mondayIdx(x.d) > 3 ? 1 : 0);
    const px = gx + col * (cell + GAP);
    if (px - lastX < 30 || px > box.w - 20) continue;
    lastX = px;
    const tx = s("text", { x: px, y: 11, class: "ch-tick" }, ax);
    tx.textContent = MONTHS[m];
  }
  // Scale key: Less, five steps, More.
  const ky = gy + 7 * (cell + GAP) + 8;
  const kc = 10;
  const more = textWidth("More", AXIS_FS);
  let kx = gx + weeks * (cell + GAP) - GAP - more;
  const tm = s("text", { x: r1(kx), y: ky + kc / 2, "dominant-baseline": "central", class: "ch-tick" }, ax);
  tm.textContent = "More";
  kx -= 6 + 5 * (kc + 3) - 3;
  for (let l = 0; l < 5; l++) s("rect", { x: kx + l * (kc + 3), y: ky, width: kc, height: kc, rx: 2, class: "ch-cell l" + l }, ax);
  const less = s("text", { x: r1(kx - 6), y: ky + kc / 2, "dominant-baseline": "central", "text-anchor": "end", class: "ch-tick" }, ax);
  less.textContent = "Less";
  let on = null;
  return {
    move(px, py) {
      const col = Math.floor((px - gx) / (cell + GAP)), row = Math.floor((py - gy) / (cell + GAP));
      const hit = cells.find((c) => c.col === col && c.row === row);
      if (on && on !== hit) on.rect.classList.remove("on");
      on = hit || null;
      if (!hit) { o.hideTip(); return; }
      hit.rect.classList.add("on");
      o.showTip(gx + col * (cell + GAP) + cell / 2, gy + row * (cell + GAP), fmt(hit.x.v, fmtS), dateLong(chart.labels[hit.x.i], false));
    },
    leave() { if (on) on.rect.classList.remove("on"); on = null; o.hideTip(); },
  };
}

/** Small multiples: one tile per series, the same x range, each with its own scale and its average. */
function sparklines(plot, box, chart, o) {
  const fmtS = o.display.format || chart.format;
  const k = chart.series.length;
  const cols = Math.max(1, Math.min(k, Math.round(Math.sqrt((k * box.w) / Math.max(1, box.h) / 1.6)) || 1));
  const rowsN = Math.ceil(k / cols);
  const GX = 20, GY = 16;
  const cw = (box.w - GX * (cols - 1)) / cols, chh = (box.h - GY * (rowsN - 1)) / rowsN;
  const grid = h("div", "ch-sm");
  const n = chart.labels.length;
  const tiles = [];
  chart.series.forEach((se, si) => {
    const tile = h("div", "ch-sm-tile");
    const col = si % cols, row = Math.floor(si / cols);
    tile.style.cssText = `left:${r1(col * (cw + GX))}px;top:${r1(row * (chh + GY))}px;width:${r1(cw)}px;height:${r1(chh)}px`;
    const avg = se.values.reduce((a, b) => a + b, 0) / Math.max(1, n);
    const head = h("div", "ch-sm-head");
    head.append(h("span", "ch-sm-name", se.name), h("span", "ch-sm-val", fmt(avg, fmtS)), h("span", "ch-sm-cap", chart.time ? "avg/day" : "avg"));
    tile.append(head);
    const sh = Math.max(10, chh - 24);
    const svg = s("svg", { width: r1(cw), height: r1(sh), viewBox: `0 0 ${r1(cw)} ${r1(sh)}`, class: "ch-svg" }, tile);
    const lo = Math.min(0, ...se.values), hi = Math.max(...se.values, lo + 1);
    const y = (v) => 3 + (1 - (v - lo) / (hi - lo)) * (sh - 6);
    const x = (i) => (n === 1 ? cw / 2 : (i / (n - 1)) * (cw - 4) + 2);
    s("line", { x1: 0, x2: cw, y1: crisp(y(lo)), y2: crisp(y(lo)), class: "ch-base" }, svg);
    const pts = se.values.map((v, i) => r1(x(i)) + "," + r1(y(v)));
    const id = "chg" + ++gradSeq;
    const lg = s("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, s("defs", {}, svg));
    const color = se.name === "Other" ? "var(--ch-other)" : slot(si);
    const a = s("stop", { offset: "0%" }, lg); a.style.stopColor = color; a.style.stopOpacity = "0.2";
    const b = s("stop", { offset: "100%" }, lg); b.style.stopColor = color; b.style.stopOpacity = "0.02";
    const area = s("path", { d: `M${pts.join("L")}L${r1(x(n - 1))},${r1(y(lo))}L${r1(x(0))},${r1(y(lo))}Z` }, svg);
    area.style.fill = `url(#${id})`;
    const line = s("path", { d: "M" + pts.join("L"), class: "ch-line thin" }, svg);
    line.style.stroke = color;
    const cross = s("line", { y1: 0, y2: sh, class: "ch-cross" }, svg);
    cross.style.display = "none";
    const dot = s("circle", { r: 3, class: "ch-dot ch-hov" }, svg);
    dot.style.fill = color;
    dot.style.display = "none";
    tiles.push({ col, row, x, y, cross, dot, se, top: row * (chh + GY) + 24, left: col * (cw + GX) });
    grid.append(tile);
  });
  plot.append(grid);
  const clear = () => tiles.forEach((t) => { t.cross.style.display = "none"; t.dot.style.display = "none"; });
  return {
    move(px, py) {
      const col = Math.floor(px / (cw + GX)), row = Math.floor(py / (chh + GY));
      const t = tiles.find((q) => q.col === col && q.row === row);
      clear();
      if (!t) { o.hideTip(); return; }
      const lx = px - t.left;
      const i = Math.max(0, Math.min(n - 1, Math.round(((lx - 2) / (cw - 4)) * (n - 1))));
      const cx = crisp(t.x(i));
      t.cross.setAttribute("x1", cx); t.cross.setAttribute("x2", cx); t.cross.style.display = "";
      t.dot.setAttribute("cx", r1(t.x(i))); t.dot.setAttribute("cy", r1(t.y(t.se.values[i]))); t.dot.style.display = "";
      o.showTip(t.left + t.x(i), t.top + t.y(t.se.values[i]), fmt(t.se.values[i], fmtS), t.se.name + ", " + labelText(chart, i));
    },
    leave() { clear(); o.hideTip(); },
  };
}

/** Rows and columns: the label column left, numbers right-aligned in tabular figures, hairline rules. */
function table(plot, box, chart, o) {
  const fmtS = o.display.format || chart.format;
  const ROW = 30;
  const tbl = h("div", "ch-table");
  const head = h("div", "ch-tr ch-th");
  head.append(h("span", "ch-td", ""));
  for (const se of chart.series) head.append(h("span", "ch-td num", se.name));
  tbl.append(head);
  const fit = Math.max(1, Math.floor((box.h - 24) / ROW));
  const n = chart.labels.length;
  const shown = n > fit ? fit - 1 : n;
  for (let i = 0; i < shown; i++) {
    const tr = h("div", "ch-tr");
    tr.append(h("span", "ch-td", labelText(chart, i)));
    for (const se of chart.series) tr.append(h("span", "ch-td num", fmt(se.values[i], fmtS)));
    tbl.append(tr);
  }
  if (shown < n) tbl.append(h("div", "ch-more", `${n - shown} more`));
  plot.append(tbl);
  return null;
}

const DRAW = {
  number: (plot, box, chart, o) => (chart.series[0].values.length > 1 ? lineLike(true)(plot, box, { ...chart, type: "area" }, { ...o, spark: true }) : null),
  line: lineLike(false),
  area: lineLike(true),
  bar: bars(false),
  stacked: bars(true),
  hbar: (plot, box, chart, o) => rankedRows(plot, box, chart, o),
  funnel: (plot, box, chart, o) => rankedRows(plot, box, chart, o, { funnel: true }),
  pie: pieLike(false),
  donut: pieLike(true),
  ring,
  heatmap,
  sparklines,
  table,
};
