// Styled ranges in a text layer (select a word while editing and change its weight, colour or size).
//
// The file format: a text node keeps `content` as one plain string and may add `spans`, a list of
// { start, end, ...style } over that string. Offsets count UTF-16 code units (JavaScript string indices), end is
// exclusive, spans are sorted and never overlap, and a span only says what differs from the layer: every key it
// leaves out is the layer's own. A file without `spans` reads exactly as before.
//
// Style keys a span may hold: fontFamily, fontSize, fontWeight, fontStyle, fill (a hex colour), underline,
// strikethrough, letterSpacing. Pure helpers, used by the page (the editor, the inspector bridge), the server
// (writes, find and replace, MCP) and the engine's scene reader (src/scene.ts passes them on).

export const SPAN_KEYS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fill", "underline", "strikethrough", "letterSpacing"];
const KEYSET = new Set(SPAN_KEYS);
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Is `v` a value span key `k` can hold (variables included, "$name")? */
export function validSpanValue(k, v) {
  if (typeof v === "string" && v.startsWith("$") && v.length > 1) return true;
  switch (k) {
    case "fontFamily": return typeof v === "string" && v.length > 0;
    case "fontWeight": return typeof v === "string" && v.length > 0;
    case "fontStyle": return v === "normal" || v === "italic";
    case "fill": return typeof v === "string" && HEX.test(v);
    case "underline": case "strikethrough": return typeof v === "boolean";
    case "fontSize": return typeof v === "number" && Number.isFinite(v) && v > 0;
    case "letterSpacing": return typeof v === "number" && Number.isFinite(v);
    default: return false;
  }
}

/** What is wrong with a `spans` value for a text `len` long, or [] (file validation, MCP, writes). */
export function spanErrors(spans, len) {
  if (!Array.isArray(spans)) return ["spans must be a list of { start, end, ...style }"];
  const errs = [];
  let last = 0;
  spans.forEach((s, i) => {
    const at = `spans[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) { errs.push(`${at} must be an object`); return; }
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start) { errs.push(`${at}: start and end must be whole numbers with start < end`); return; }
    if (typeof len === "number" && s.end > len) errs.push(`${at}: end ${s.end} is past the text's length ${len}`);
    if (s.start < last) errs.push(`${at}: spans must be sorted and must not overlap`);
    last = Math.max(last, s.end);
    for (const [k, v] of Object.entries(s)) {
      if (k === "start" || k === "end") continue;
      if (!KEYSET.has(k)) errs.push(`${at}: "${k}" is not a span style (${SPAN_KEYS.join(", ")})`);
      else if (!validSpanValue(k, v)) errs.push(`${at}: ${k} has a value it cannot take (${JSON.stringify(v)})`);
    }
  });
  return errs;
}

const styleOf = (s) => { const o = {}; for (const k of SPAN_KEYS) if (s[k] !== undefined) o[k] = s[k]; return o; };
const sameStyle = (a, b) => SPAN_KEYS.every((k) => a[k] === b[k]);

/**
 * Clean spans for a text `len` long: clamped, sorted, empty and style-less ones dropped, neighbours with the same
 * style merged, overlaps cut (a later span wins where two cover the same letters). Keys equal to `base` (the layer's
 * own style) are dropped too, so a range set back to the layer's value stops being a span.
 */
export function normalize(spans, len, base = null) {
  if (!Array.isArray(spans) || !spans.length) return [];
  const n = typeof len === "number" ? len : Infinity;
  // Paint each span over a per-character map of style ids: later spans win, then read runs back.
  const raw = spans.filter((s) => s && typeof s === "object" && Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s) => ({ start: Math.max(0, Math.min(n, Math.floor(s.start))), end: Math.max(0, Math.min(n, Math.floor(s.end))), style: styleOf(s) }))
    .filter((s) => s.end > s.start);
  if (!raw.length) return [];
  const cuts = [...new Set(raw.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    let style = null;
    for (const s of raw) if (s.start <= a && s.end >= b) style = { ...(style || {}), ...s.style };
    if (!style) continue;
    if (base) for (const k of Object.keys(style)) if (base[k] === style[k] || (base[k] === undefined && isDefault(k, style[k]))) delete style[k];
    for (const k of Object.keys(style)) if (style[k] === undefined || style[k] === null) delete style[k];
    if (!Object.keys(style).length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.end === a && sameStyle(prev, style)) prev.end = b;
    else out.push({ start: a, end: b, ...styleOf(style) }); // keys in SPAN_KEYS order: one spelling per style
  }
  return out;
}

/** A style value that is what a layer without the key draws anyway (no underline, upright, no tracking). */
function isDefault(k, v) {
  return (k === "underline" || k === "strikethrough") ? v === false : k === "fontStyle" ? v === "normal" : k === "letterSpacing" ? v === 0 : false;
}

/**
 * Spans after the text changed: `removed` code units at `at` were replaced by `inserted` new ones. New text takes
 * the style of the first letter it replaces, or when it replaces none, of the letter before it (as in every text
 * editor); text typed at the very start takes the first letter's.
 */
export function shift(spans, at, removed, inserted) {
  if (!Array.isArray(spans) || !spans.length) return [];
  const delta = inserted - removed, cut = at + removed;
  const from = removed > 0 || at === 0 ? at : at - 1; // the letter whose style the new text takes
  const out = [];
  for (const s of spans) {
    let start = s.start < at ? s.start : s.start >= cut ? s.start + delta : at + inserted;
    let end = s.end <= at ? s.end : s.end >= cut ? s.end + delta : at;
    if (inserted > 0 && s.start <= from && from < s.end) { start = Math.min(start, at); end = Math.max(end, at + inserted); }
    if (end > start) out.push({ ...s, start, end });
  }
  return out;
}

/** Where two strings differ: the edit that turns `a` into `b` as { at, removed, inserted }, or null when equal. */
export function diff(a, b) {
  if (a === b) return null;
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { at: p, removed: a.length - p - s, inserted: b.length - p - s };
}

/** Spans of `before` carried over to `after` (one edit between them, found by diff). */
export function follow(spans, before, after) {
  const d = diff(before, after);
  if (!d) return spans || [];
  return normalize(shift(spans, d.at, d.removed, d.inserted), after.length);
}

/**
 * Set `style` on [start, end): keys with a value set it there, keys set to null go back to the layer's own. `base`:
 * the layer's style (keys equal to it are not kept). Returns new spans.
 */
export function apply(spans, start, end, style, len, base = null) {
  if (!(end > start)) return normalize(spans, len, base);
  const out = [];
  for (const s of spans || []) {
    if (s.end <= start || s.start >= end) { out.push(s); continue; }
    if (s.start < start) out.push({ ...s, end: start });
    const mid = { ...s, start: Math.max(s.start, start), end: Math.min(s.end, end) };
    for (const [k, v] of Object.entries(style)) { if (v === null) delete mid[k]; else mid[k] = v; }
    out.push(mid);
    if (s.end > end) out.push({ ...s, start: end });
  }
  // Letters in the range no span covered yet.
  const set = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== null));
  if (Object.keys(set).length) {
    let at = start;
    const inside = (spans || []).filter((s) => s.end > start && s.start < end).sort((a, b) => a.start - b.start);
    for (const s of inside) { if (s.start > at) out.push({ start: at, end: Math.min(s.start, end), ...set }); at = Math.max(at, s.end); }
    if (at < end) out.push({ start: at, end, ...set });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return normalize(out, len, base);
}

/**
 * The value of each style key over [start, end) (a caret: the letter before it): the value, or "mixed" when the
 * letters differ. `base` gives what letters outside every span have.
 */
export function styleAt(spans, start, end, base, len) {
  let a = start, b = end;
  if (b <= a) { a = Math.max(0, start - 1); b = a + 1; if (typeof len === "number" && b > len) { a = 0; b = Math.min(1, len); } }
  const out = {};
  for (const k of SPAN_KEYS) {
    let val, first = true, mixed = false;
    let at = a;
    const visit = (v) => { if (first) { val = v; first = false; } else if (v !== val) mixed = true; };
    for (const s of (spans || []).filter((x) => x.end > a && x.start < b).sort((x, y) => x.start - y.start)) {
      if (s.start > at) visit(base ? base[k] : undefined);
      visit(s[k] !== undefined ? s[k] : base ? base[k] : undefined);
      at = Math.max(at, s.end);
    }
    if (at < b) visit(base ? base[k] : undefined);
    out[k] = mixed ? "mixed" : val;
  }
  return out;
}

/** The style keys a layer's spans set anywhere (what the inspector reads as Mixed for the whole layer). */
export function keysIn(spans) {
  const ks = new Set();
  for (const s of spans || []) for (const k of SPAN_KEYS) if (s[k] !== undefined) ks.add(k);
  return [...ks];
}

/** Spans with every key in `keys` removed (a whole-layer edit of those keys wins over the ranges). */
export function without(spans, keys, len) {
  if (!Array.isArray(spans) || !spans.length) return [];
  const drop = new Set(keys);
  return normalize(spans.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !drop.has(k)))), len);
}
