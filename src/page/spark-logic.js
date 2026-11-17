// Talk to the selection, the pure half (src/page/spark.js draws): where the spark and the composer go on screen,
// and the words for times and progress. Node-tested (test/spark-logic.test.ts).
//
// The design (design/chat-to-selection): the spark (28 px) sits 8 px right of the selection box's top-right corner,
// top-aligned with the box (the box is drawn 1 px outside the layer). The composer (360 px wide) opens 8 px right of
// the spark, top-aligned, and never over the selection: with no room on the right it flips to the left of the
// selection, then below it (clear of the size badge), then above it.

export const SPARK = 28;
export const GAP = 8;
/** The selection box is drawn 1 px outside the layer. */
export const BOX_OUT = 1;
/** The size badge under a selection (18 px tall, 8 px below the box). */
export const BADGE = 8 + 18;
/** Room kept between the composer and the edges of the visible canvas. */
export const MARGIN = 8;

/** The union of world rects ({x, y, w, h}); null for none. */
export function unionRects(rs) {
  const list = (rs || []).filter((r) => r && Number.isFinite(r.x) && Number.isFinite(r.w));
  if (!list.length) return null;
  const x = Math.min(...list.map((r) => r.x)), y = Math.min(...list.map((r) => r.y));
  return { x, y, w: Math.max(...list.map((r) => r.x + r.w)) - x, h: Math.max(...list.map((r) => r.y + r.h)) - y };
}

/** A world rect on screen (view px) under camera {x, y, z}. */
export function toScreen(r, cam) {
  return { x: r.x * cam.z + cam.x, y: r.y * cam.z + cam.y, w: r.w * cam.z, h: r.h * cam.z };
}

/** The visible part of the view: its size less the shell's islands (insets). */
export function visibleArea(view, ins) {
  const i = ins || { l: 0, t: 0, r: 0, b: 0 };
  return { x: i.l, y: i.t, w: Math.max(0, view.w - i.l - i.r), h: Math.max(0, view.h - i.t - i.b) };
}

const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * The spark's top-left for a selection on screen, or null when the selection is off screen. It keeps to the
 * selection's corner; only when that corner is outside the visible area does it slide back in along the edge
 * (so a selection taller than the window still has its spark).
 */
export function sparkAt(sel, area) {
  if (!sel || !overlaps(sel, area)) return null;
  let x = sel.x + sel.w + BOX_OUT + GAP;
  let y = sel.y - BOX_OUT;
  x = Math.min(x, area.x + area.w - SPARK - 4);
  y = Math.max(y, area.y + 4);
  y = Math.min(y, sel.y + sel.h - SPARK);
  return { x, y };
}

/**
 * Where the composer goes: {x, y, side}. side is "right" (the design), "left", "below", "above", or "over" when the
 * selection fills the view and nothing else fits (then it hugs the right edge of the view).
 */
export function composerAt(sel, spark, size, area) {
  const right = area.x + area.w - MARGIN, bottom = area.y + area.h - MARGIN, left = area.x + MARGIN, top = area.y + MARGIN;
  const clampY = (y) => Math.max(top, Math.min(y, bottom - size.h));
  const clampX = (x) => Math.max(left, Math.min(x, right - size.w));
  const y0 = spark ? spark.y : sel.y - BOX_OUT;
  const rx = (spark ? spark.x + SPARK : sel.x + sel.w + BOX_OUT) + GAP;
  if (rx + size.w <= right) return { x: rx, y: clampY(y0), side: "right" };
  const lx = sel.x - BOX_OUT - GAP - size.w;
  if (lx >= left) return { x: lx, y: clampY(y0), side: "left" };
  const by = sel.y + sel.h + BOX_OUT + BADGE + GAP;
  if (by + size.h <= bottom) return { x: clampX(sel.x), y: by, side: "below" };
  const ay = sel.y - BOX_OUT - GAP - size.h;
  if (ay >= top) return { x: clampX(sel.x), y: ay, side: "above" };
  return { x: Math.max(left, right - size.w), y: clampY(y0), side: "over" };
}

/** The ring's sweep in degrees for step `index` (1-based) of `total`: half way through the step under way. */
export function ringSweep(now) {
  if (!now || !now.total) return 90;
  return Math.round(Math.min(1, Math.max(0, (now.index - 0.5) / now.total)) * 360);
}

/** The ring's tooltip: the step under way, and "3 of 4" when the agent gave a plan. */
export function ringTip(now) {
  if (!now) return { label: "Working", count: "" };
  return { label: now.label, count: now.total > 1 ? `${now.index} of ${now.total}` : "" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** When something happened, short: "18:40" today, "Yesterday", "Mon" this week, "12 Nov" before. */
export function relDay(at, now = Date.now()) {
  const d = new Date(at), n = new Date(now);
  const days = Math.round((dayStart(n) - dayStart(d)) / 86400000);
  if (days <= 0) return hm(d);
  if (days === 1) return "Yesterday";
  if (days < 7) return DAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The earlier exchange's time: "Today, 18:40", "Yesterday, 18:40", "Mon, 18:40", "12 Nov, 18:40". */
export function whenLong(at, now = Date.now()) {
  const r = relDay(at, now);
  return `${/^\d/.test(r) && r.includes(":") ? "Today" : r}, ${hm(new Date(at))}`;
}

/** What the person did with a run, for the earlier exchange's row. */
export function outcomeWord(run) {
  if (!run) return "";
  if (run.outcome === "undone") return "Undone";
  if (run.status === "stopped") return "Stopped";
  if (run.status === "failed") return "Failed";
  if (run.status === "running") return "Working";
  return "Kept";
}

/** The chip's count: "1 layer", "9 layers". */
export const layersWord = (n) => `${n} ${n === 1 ? "layer" : "layers"}`;
