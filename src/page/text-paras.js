// Paragraphs in a text layer: paragraph spacing, paragraph indent and lists (Type details).
//
// The file format: a paragraph is a run of `content` between newlines ("a\nb" is two paragraphs). A text node may set
//   paragraphSpacing: px between paragraphs (none before the first),
//   paragraphIndent: px the first line of each paragraph starts in (left-aligned text only; list items take
//     their own indent instead),
//   lists: [{ p, type: "bullet" | "number", level: 1..5 }], sorted by p, at most one per paragraph p (0-based). A list
//     paragraph's lines all start at level * listStep(fontSize) (a hanging indent); its marker sits one step to the
//     left, on its first line. Bullets are "•" at every level; numbers count each run of numbered items at a
//     level, and their style turns 1. a. i. with each level (numbers, letters, roman numerals). Type "none" is
//     an item whose marker Backspace took away: it keeps its indent and its level's count.
//     A marker takes the colour of its item's first letter.
//   listSpacing: px between two list items next to each other (List spacing), in place of paragraphSpacing,
//   hangingList: true puts the markers outside the box: every item's text a level step further left
//     (Hanging lists),
//   hangingPunctuation: true hangs an opening quotation mark that starts a paragraph outside the box, its own width
//     left of where the paragraph's first line starts (Hanging punctuation, also
//     called hanging quotes); left-aligned and justified text.
//     Only a paragraph's first line: a quote that lands at the start of a wrapped line stays in the box.
//   letterCase: "upper" | "lower" | "title" | "small-caps" (Letter case; absent or "original" as typed). The
//     letters are drawn in that case and the file keeps them as typed: CSS text-transform uppercase / lowercase (full
//     Unicode case maps), title case the first letter of each word (`wordStarts`, each in a span of its own drawn in
//     upper case: CSS capitalize reads words differently in Chrome and WebKit), and the font's own small capitals
//     (`smcp`; a font without them draws the letters as they are, no synthesized capitals).
// A file without them reads exactly as before. The engine (engine/src/text.rs), the DOM renderer
// (src/doc/render/html.ts), SVG export and the editor (src/page/text-edit.js) all lay paragraphs out by these rules.

export const LIST_TYPES = ["bullet", "number", "none"];
export const MAX_LEVEL = 5;
export const PARA_KEYS = ["paragraphSpacing", "paragraphIndent", "lists", "listSpacing", "hangingList", "hangingPunctuation"];
export const LETTER_CASES = ["original", "upper", "lower", "title", "small-caps"];

/** The CSS that draws a layer's letter case: { textTransform, fontFeatureSettings } (title case is `wordStarts`). */
export function caseCss(n) {
  const c = n && n.letterCase;
  return {
    textTransform: c === "upper" ? "uppercase" : c === "lower" ? "lowercase" : "none",
    fontFeatureSettings: c === "small-caps" ? '"smcp" 1' : "normal",
  };
}

const ALNUM = /[\p{L}\p{N}]/u, MARK = /[\p{M}‍]/u;
/**
 * Title case: the UTF-16 offsets of each word's first letter (engine/src/scene.rs starts_word): a letter or digit after
 * no letter, digit, mark or "_", and not after an apostrophe that follows a letter or digit ("don't" is one word;
 * "-" and "." end a word).
 */
export function wordStarts(s) {
  const out = [];
  const t = String(s ?? "");
  let p1 = "", p2 = "";
  for (let i = 0; i < t.length;) {
    const ch = String.fromCodePoint(t.codePointAt(i));
    if (ALNUM.test(ch) && !(ALNUM.test(p1) || p1 === "_" || MARK.test(p1)) && !((p1 === "'" || p1 === "’") && ALNUM.test(p2))) out.push(i);
    p2 = p1; p1 = ch;
    i += ch.length;
  }
  return out;
}

/** The opening quotation marks that hang (engine/src/text.rs is_open_quote). */
export const OPEN_QUOTES = "\"'“‘„‚«‹»›‟‛";

/** The colour of a list item's marker: its first letter's own colour (a styled range's fill), or null for the layer's. */
export function markerColor(n, content, at) {
  const sp = Array.isArray(n && n.spans) ? n.spans.find((s) => s && s.start <= at && at < s.end) : null;
  return sp && typeof sp.fill === "string" && /^#[0-9a-f]{3,8}$/i.test(sp.fill) ? sp.fill : null;
}

/** How far each list level indents, px: one and a half times the font size, whole px. */
export const listStep = (size) => Math.round((size > 0 ? size : 13) * 1.5);

/** The offset each paragraph of `content` starts at. */
export function paragraphStarts(content) {
  const s = String(content ?? "");
  const out = [0];
  for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

/** How many paragraphs `content` has. */
export const paragraphCount = (content) => paragraphStarts(content).length;

/** The paragraph the offset `i` is in. */
export function paraAt(content, i) {
  const st = paragraphStarts(content);
  let p = 0;
  while (p + 1 < st.length && st[p + 1] <= i) p++;
  return p;
}

/** What is wrong with a `lists` value for a text with `count` paragraphs, or []. */
export function listErrors(lists, count) {
  if (!Array.isArray(lists)) return ["lists must be a list of { p, type, level }"];
  const errs = [];
  let last = -1;
  lists.forEach((l, i) => {
    const at = `lists[${i}]`;
    if (!l || typeof l !== "object" || Array.isArray(l)) { errs.push(`${at} must be an object`); return; }
    if (!Number.isInteger(l.p) || l.p < 0) { errs.push(`${at}: p must be a paragraph number (0 is the first)`); return; }
    if (typeof count === "number" && l.p >= count) errs.push(`${at}: p ${l.p} is past the text's ${count} paragraphs`);
    if (l.p <= last) errs.push(`${at}: lists must be sorted by p, one per paragraph`);
    last = Math.max(last, l.p);
    if (!LIST_TYPES.includes(l.type)) errs.push(`${at}: type must be "bullet", "number" or "none"`);
    if (l.level !== undefined && !(Number.isInteger(l.level) && l.level >= 1 && l.level <= MAX_LEVEL)) errs.push(`${at}: level must be 1 to ${MAX_LEVEL}`);
    for (const k of Object.keys(l)) if (!["p", "type", "level"].includes(k)) errs.push(`${at}: "${k}" is not a list key (p, type, level)`);
  });
  return errs;
}

/** Clean lists for `count` paragraphs: sorted, one per paragraph (the last wins), bad ones dropped, level 1 written out. */
export function normalizeLists(lists, count) {
  if (!Array.isArray(lists)) return [];
  const by = new Map();
  for (const l of lists) {
    if (!l || typeof l !== "object" || !Number.isInteger(l.p) || l.p < 0 || !LIST_TYPES.includes(l.type)) continue;
    if (typeof count === "number" && l.p >= count) continue;
    const level = Number.isInteger(l.level) ? Math.max(1, Math.min(MAX_LEVEL, l.level)) : 1;
    by.set(l.p, { p: l.p, type: l.type, level });
  }
  return [...by.values()].sort((a, b) => a.p - b.p);
}

/**
 * Lists after `removed` code units at `at` of `before` were replaced by `inserted` (a string). The paragraph the edit
 * starts in keeps its list; paragraphs whose start the edit took away go; new paragraphs (typed newlines) take the
 * list of the paragraph they were split from (Return in a list item makes the next item).
 */
export function shiftLists(lists, before, at, removed, inserted) {
  if (!Array.isArray(lists) || !lists.length) return [];
  const pa = paraAt(before, at), pb = paraAt(before, at + removed);
  const added = (String(inserted).match(/\n/g) || []).length;
  const delta = added - (pb - pa);
  const own = lists.find((l) => l.p === pa);
  const out = [];
  for (const l of lists) {
    if (l.p < pa) out.push(l);
    else if (l.p === pa) out.push(l);
    else if (l.p > pb) out.push({ ...l, p: l.p + delta });
  }
  if (own) for (let k = 1; k <= added; k++) out.push({ ...own, p: pa + k });
  return normalizeLists(out, paragraphCount(before.slice(0, at) + inserted + before.slice(at + removed)));
}

/** Where two strings differ: { at, removed, inserted (count) }, or null. */
function diff(a, b) {
  if (a === b) return null;
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { at: p, removed: a.length - p - s, inserted: b.length - p - s };
}

/** Lists of `before` carried over to `after` (one edit between them). */
export function followLists(lists, before, after) {
  const d = diff(String(before ?? ""), String(after ?? ""));
  if (!d) return normalizeLists(lists, paragraphCount(after));
  return shiftLists(lists, String(before ?? ""), d.at, d.removed, String(after).slice(d.at, d.at + d.inserted));
}

const ROMAN = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
function roman(n) { let s = ""; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; }
function letters(n) { let s = ""; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }

/** A marker's text: "•", or the item's count as 1. a. i. by level. */
export function markerText(type, level, n) {
  if (type !== "number") return "•";
  const k = (level - 1) % 3;
  return (k === 0 ? String(n) : k === 1 ? letters(n) : roman(n)) + ".";
}

/**
 * Each paragraph's marker text, or null: numbers count consecutive numbered items at a level; a paragraph that is no
 * list item ends every count, a shallower item ends the deeper counts, a bullet at a level ends that level's count.
 */
export function markers(lists, count) {
  const out = new Array(count).fill(null);
  const by = new Map((lists || []).map((l) => [l.p, l]));
  const counts = new Array(MAX_LEVEL + 2).fill(0);
  for (let p = 0; p < count; p++) {
    const l = by.get(p);
    if (!l) { counts.fill(0); continue; }
    const lv = l.level || 1;
    for (let k = lv + 1; k < counts.length; k++) counts[k] = 0;
    if (l.type === "number") { counts[lv]++; out[p] = markerText("number", lv, counts[lv]); }
    else if (l.type === "bullet") { counts[lv] = 0; out[p] = markerText("bullet", lv, 0); }
    // "none": no marker; its level's count goes on (a second paragraph of an item).
  }
  return out;
}

/** Does this text node use paragraph layout (spacing, indent, lists or hanging quotes)? */
export function hasParagraphs(n) {
  return !!n && ((typeof n.paragraphSpacing === "number" && n.paragraphSpacing > 0) || (typeof n.paragraphIndent === "number" && n.paragraphIndent > 0) || (Array.isArray(n.lists) && n.lists.length > 0) || n.hangingPunctuation === true);
}

/**
 * How each paragraph lays out (px): { before (space above it), first (where its first line starts), rest (where its
 * other lines start), marker (text or null), markerX, hang (true: its opening quote hangs left of `first`) }. `size`:
 * the layer's font size.
 */
export function paragraphPlan(n, content, size) {
  const text = String(content ?? "");
  const count = paragraphCount(text);
  const starts = paragraphStarts(text);
  const lists = normalizeLists(n.lists, count);
  const marks = markers(lists, count);
  const by = new Map(lists.map((l) => [l.p, l]));
  const spacing = typeof n.paragraphSpacing === "number" && n.paragraphSpacing > 0 ? n.paragraphSpacing : 0;
  const between = typeof n.listSpacing === "number" && n.listSpacing > 0 ? n.listSpacing : 0;
  const left = n.textAlign === undefined || n.textAlign === "left";
  const indent = left && typeof n.paragraphIndent === "number" && n.paragraphIndent > 0 ? n.paragraphIndent : 0;
  const hangs = n.hangingPunctuation === true && (left || n.textAlign === "justify");
  const step = listStep(size);
  const lift = n.hangingList === true ? step : 0;
  const out = [];
  for (let p = 0; p < count; p++) {
    const l = by.get(p);
    // List spacing between two list items; paragraph spacing everywhere else.
    const before = !p ? 0 : l && by.has(p - 1) ? between : spacing;
    const o = l
      ? { before, first: l.level * step - lift, rest: l.level * step - lift, marker: marks[p], markerX: (l.level - 1) * step - lift }
      : { before, first: indent, rest: 0, marker: null, markerX: 0 };
    if (hangs && OPEN_QUOTES.includes(text[starts[p]] ?? "\n")) o.hang = true;
    out.push(o);
  }
  return out;
}

/**
 * Backspace at the start of list item p: a
 * marked item loses its marker and keeps its level; an item without one goes a level out, and off the list at level 1.
 */
export function unmark(lists, p) {
  const out = [];
  for (const l of Array.isArray(lists) ? lists : []) {
    if (!l || l.p !== p) { if (l) out.push(l); continue; }
    if (l.type !== "none") out.push({ p, type: "none", level: l.level || 1 });
    else if ((l.level || 1) > 1) out.push({ p, type: "none", level: l.level - 1 });
  }
  return out;
}

/** The paragraphs [a, b] the letters [start, end) touch. */
export function parasIn(content, start, end) {
  return [paraAt(content, start), paraAt(content, Math.max(start, end))];
}

/** Lists with the paragraphs touched by [start, end) made `type` lists, or no lists when every one of them already is. */
export function toggleList(lists, content, start, end, type) {
  const count = paragraphCount(content);
  const [a, b] = parasIn(content, start, end);
  const cur = normalizeLists(lists, count);
  const by = new Map(cur.map((l) => [l.p, l]));
  const all = (() => { for (let p = a; p <= b; p++) if (by.get(p)?.type !== type) return false; return true; })();
  for (let p = a; p <= b; p++) {
    if (all) by.delete(p);
    else by.set(p, { p, type, level: by.get(p)?.level ?? 1 });
  }
  return normalizeLists([...by.values()], count);
}

/** Lists with the list items among the paragraphs touched by [start, end) one level deeper (+1) or shallower (-1). */
export function nestList(lists, content, start, end, delta) {
  const count = paragraphCount(content);
  const [a, b] = parasIn(content, start, end);
  const out = [];
  for (const l of normalizeLists(lists, count)) {
    if (l.p < a || l.p > b) { out.push(l); continue; }
    const level = l.level + delta;
    if (level >= 1) out.push({ ...l, level: Math.min(MAX_LEVEL, level) });
  }
  return normalizeLists(out, count);
}

/** The list item of paragraph p, or null. */
export const listAt = (lists, p) => (Array.isArray(lists) ? lists.find((l) => l && l.p === p) || null : null);

/**
 * Typed list starts: "- " or "* " at the start of a paragraph makes it a bullet item, "1. " or "1) " a
 * numbered one. `value` is the text after a space was typed at `caret`. Returns { value, caret, lists } with the
 * typed marker taken out, or null.
 */
export function autoList(lists, value, caret) {
  const p = paraAt(value, caret);
  const start = paragraphStarts(value)[p];
  const head = value.slice(start, caret);
  const type = head === "- " || head === "* " ? "bullet" : head === "1. " || head === "1) " ? "number" : null;
  const own = listAt(lists, p);
  // An item without its marker takes one at its level; an item with one stays as it is.
  if (!type || (own && own.type !== "none")) return null;
  const next = value.slice(0, start) + value.slice(caret);
  const shifted = shiftLists(lists, value, start, caret - start, "");
  return { value: next, caret: start, lists: normalizeLists([...shifted, { p, type, level: own ? own.level : 1 }], paragraphCount(next)) };
}
