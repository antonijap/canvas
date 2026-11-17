// The note widget's document model. Pure functions, no DOM: the page's editor (note-editor.js) and the tests use it.
//
// Stored format: Markdown, one line per block, so a note written before rich text reads the same (an empty line is an
// empty block). Blocks: paragraph, "# " heading 1, "## " heading 2, "### " heading 3, "- " bullet, "1. " numbered, "- [ ] " checkbox,
// "> " quote, "---" divider. Lists nest with 4 spaces per level. Inline: **bold**, *italic* (or _italic_), ~~strike~~,
// `code`, [text](https://link).
//
// Doc = Block[]; Block = { type: "p" | "h1" | "h2" | "h3" | "ul" | "ol" | "todo" | "quote" | "hr", indent, checked?, runs };
// Run = { text, b?, i?, s?, c?, href? }. A caret is { b: block index, o: text offset in the block }.

export const LIST = new Set(["ul", "ol", "todo"]);
export const MAX_INDENT = 6;
/** The most characters a note's stored text may have (src/widgets/kinds/note.ts refuses more). */
export const NOTE_MAX = 50_000;
const MARKS = ["b", "i", "s", "c"];
const INDENT = "    ";

// ---------- runs ----------
export const textOf = (runs) => runs.map((r) => r.text).join("");
export const blockLen = (blk) => textOf(blk.runs).length;
function clean(r) {
  const o = { text: r.text };
  for (const m of MARKS) if (r[m]) o[m] = true;
  if (r.href) o.href = r.href;
  return o;
}
const sameMarks = (a, b) => MARKS.every((m) => !!a[m] === !!b[m]) && (a.href || "") === (b.href || "");
/** Adjacent runs with the same marks merged, empty runs dropped. */
export function norm(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const l = out[out.length - 1];
    if (l && sameMarks(l, r)) l.text += r.text;
    else out.push(clean(r));
  }
  return out;
}
/** The runs between two text offsets. */
export function sliceRuns(runs, from, to = Infinity) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const s = pos, e = pos + r.text.length;
    pos = e;
    const a = Math.max(from, s), z = Math.min(to, e);
    if (z > a) out.push({ ...clean(r), text: r.text.slice(a - s, z - s) });
  }
  return out;
}
export const block = (type, runs = [], extra = {}) => ({ type, indent: 0, runs: norm(runs), ...extra });
const copyBlock = (b) => ({ ...b, runs: b.runs.map(clean) });
const copyDoc = (doc) => doc.map(copyBlock);

/** Only links that open a web page or a mail draft; anything else (javascript:, data:, file:) stays plain text. */
export function safeHref(u) {
  const s = String(u || "").trim();
  return /^(https?:\/\/|mailto:)[^\s<>"]+$/i.test(s) ? s : null;
}

// ---------- inline Markdown ----------
const ESC = "\\`*_[]~";
const isWord = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch) => !ch || /\s/.test(ch);

/** **bold**, *italic*, _italic_, ~~strike~~, `code`, [text](url), backslash escapes. */
export function parseInline(src) {
  const out = [];
  const st = { b: false, i: false, s: false };
  let italicCh = "";
  let buf = "";
  const marks = () => {
    const m = {};
    if (st.b) m.b = true;
    if (st.i) m.i = true;
    if (st.s) m.s = true;
    return m;
  };
  const flush = () => { if (buf) { out.push({ text: buf, ...marks() }); buf = ""; } };
  for (let k = 0; k < src.length;) {
    const ch = src[k];
    if (ch === "\\" && k + 1 < src.length && ESC.includes(src[k + 1])) { buf += src[k + 1]; k += 2; continue; }
    if (ch === "`") {
      const end = src.indexOf("`", k + 1);
      if (end > k + 1) { flush(); out.push({ text: src.slice(k + 1, end), ...marks(), c: true }); k = end + 1; continue; }
    }
    if (ch === "[") {
      const link = linkAt(src, k);
      if (link) {
        flush();
        const href = safeHref(link.url);
        for (const r of parseInline(link.inner)) {
          const o = { ...r };
          if (st.b) o.b = true;
          if (st.i) o.i = true;
          if (st.s) o.s = true;
          if (href) o.href = href;
          out.push(o);
        }
        k = link.end;
        continue;
      }
    }
    if (src.startsWith("**", k) || src.startsWith("~~", k)) {
      const key = ch === "*" ? "b" : "s", tok = src.slice(k, k + 2);
      if (st[key] && !isSpace(src[k - 1])) { flush(); st[key] = false; k += 2; continue; }
      if (!st[key] && !isSpace(src[k + 2]) && src.indexOf(tok, k + 3) > k + 2) { flush(); st[key] = true; k += 2; continue; }
    }
    if (ch === "*" || ch === "_") {
      if (st.i && ch === italicCh && !isSpace(src[k - 1]) && (ch === "*" || !isWord(src[k + 1]))) { flush(); st.i = false; k++; continue; }
      if (!st.i && !isSpace(src[k + 1]) && (ch === "*" || !isWord(src[k - 1])) && src.indexOf(ch, k + 2) > k + 1) {
        flush(); st.i = true; italicCh = ch; k++; continue;
      }
    }
    buf += ch;
    k++;
  }
  flush();
  return norm(out);
}
function linkAt(src, k) {
  let depth = 0, j = k;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") { j++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) break;
  }
  if (j >= src.length || src[j + 1] !== "(") return null;
  let close = -1;
  for (let k = j + 2, d = 1; k < src.length; k++) {
    if (src[k] === "(") d++;
    else if (src[k] === ")" && --d === 0) { close = k; break; }
  }
  if (close === -1) return null;
  const url = src.slice(j + 2, close);
  if (/\s/.test(url.trim()) || !url.trim()) return null;
  return { inner: src.slice(k + 1, j), url: url.trim(), end: close + 1 };
}

function escapeText(t, inLink) {
  let o = "";
  for (let k = 0; k < t.length; k++) {
    const ch = t[k], prev = t[k - 1], next = t[k + 1];
    if (ch === "\\") o += "\\\\"; // always doubled: a lone one before a closing "**" would escape it
    else if (ch === "`" || ch === "*" || ch === "[") o += "\\" + ch;
    else if (ch === "]") o += inLink ? "\\]" : "]";
    else if (ch === "_") o += !isWord(prev) || !isWord(next) ? "\\_" : "_";
    else if (ch === "~") o += prev === "~" || next === "~" ? "\\~" : "~";
    else o += ch;
  }
  return o;
}
// Marked text keeps its outer spaces outside the markers ("** a**" would not parse back).
function splitSpaces(runs) {
  const out = [];
  for (const r of runs) {
    if (!(r.b || r.i || r.s || r.c) || !r.text.trim()) { out.push(r); continue; }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text);
    const plain = r.href ? { href: r.href } : {};
    if (m[1]) out.push({ text: m[1], ...plain });
    out.push({ ...r, text: m[2] });
    if (m[3]) out.push({ text: m[3], ...plain });
  }
  return out;
}
const OPEN = { b: "**", i: "*", s: "~~" };
/** Runs back to inline Markdown; parseInline(inlineToMd(runs)) gives the same runs. */
export function inlineToMd(runs) {
  let out = "";
  const open = [];
  const closeOne = () => {
    const m = open.pop();
    out += m.startsWith("a:") ? "](" + m.slice(2) + ")" : OPEN[m];
  };
  for (const r of splitSpaces(norm(runs))) {
    const want = [];
    if (r.href) want.push("a:" + r.href);
    for (const m of ["b", "i", "s"]) if (r[m]) want.push(m);
    let p = 0;
    while (p < open.length && p < want.length && open[p] === want[p]) p++;
    while (open.length > p) closeOne();
    for (const m of want.slice(p)) { out += m.startsWith("a:") ? "[" : OPEN[m]; open.push(m); }
    if (r.c && !r.text.includes("`")) out += "`" + r.text + "`";
    else out += escapeText(r.text, !!r.href);
  }
  while (open.length) closeOne();
  return out;
}

// ---------- block Markdown ----------
const RE = {
  todo: /^[-*+][ \t]+\[([ xX])\](?:[ \t]+(.*)|[ \t]*)$/,
  ul: /^[-*+][ \t]+(.*)$/,
  ol: /^(\d{1,9})[.)][ \t]+(.*)$/,
  hr: /^(?:-{3,}|\*{3,}|_{3,})[ \t]*$/,
  h: /^(#{1,6})[ \t]+(.*)$/,
  quote: /^>[ \t]?(.*)$/,
};
/** One line to a block. `lists` is the stack of list indents seen so far (relative nesting, any indent width). */
function parseLine(line, lists, trimText) {
  const lead = /^[ \t]*/.exec(line)[0];
  const width = lead.replace(/\t/g, INDENT).length;
  const rest = line.slice(lead.length);
  let m;
  const listBlock = (type, text, extra) => {
    while (lists.length && lists[lists.length - 1] > width) lists.pop();
    if (!lists.length || lists[lists.length - 1] < width) lists.push(width);
    return { type, indent: Math.min(lists.length - 1, MAX_INDENT), runs: parseInline(text || ""), ...extra };
  };
  if ((m = RE.todo.exec(rest))) return listBlock("todo", m[2], { checked: m[1] !== " " });
  if (width <= 3 && RE.hr.test(rest)) { lists.length = 0; return { type: "hr", indent: 0, runs: [] }; }
  if ((m = RE.ul.exec(rest))) return listBlock("ul", m[1]);
  if ((m = RE.ol.exec(rest))) return listBlock("ol", m[2]);
  lists.length = 0;
  if (width <= 3 && (m = RE.h.exec(rest))) {
    const text = m[2].replace(/[ \t]+#+[ \t]*$/, "");
    if (m[1].length <= 3) return { type: "h" + m[1].length, indent: 0, runs: parseInline(text) };
    return { type: "p", indent: 0, runs: parseInline(text).map((r) => ({ ...r, b: true })) }; // smaller headings: bold text
  }
  if (width <= 3 && (m = RE.quote.exec(rest))) return { type: "quote", indent: 0, runs: parseInline(m[1]) };
  let text = trimText ? rest.trim() : line;
  text = text.replace(/^([ \t]*)\\(?=[#\-+>0-9])/, "$1");
  return { type: "p", indent: 0, runs: parseInline(text) };
}

/** Stored note text to blocks. Every line is a block; an empty line is an empty paragraph. */
export function parse(md) {
  const lists = [];
  const doc = String(md ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => parseLine(l, lists, false));
  return doc.length ? doc : [block("p")];
}

/** Ordinal shown for each numbered block (0 for others). A paragraph or a bullet at the same level restarts it. */
export function numbers(doc) {
  const n = new Array(doc.length).fill(0);
  let cnt = [];
  doc.forEach((b, k) => {
    if (!LIST.has(b.type)) { cnt = []; return; }
    cnt.length = Math.min(cnt.length, b.indent + 1);
    if (b.type === "ol") n[k] = cnt[b.indent] = (cnt[b.indent] || 0) + 1;
    else cnt[b.indent] = 0;
  });
  return n;
}
const ROMAN = [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
/** "1.", "a.", "i." by nesting level, like Notion. */
export function label(n, indent) {
  const lvl = indent % 3;
  if (lvl === 0) return n + ".";
  if (lvl === 1) {
    let s = "", x = n;
    while (x > 0) { x--; s = String.fromCharCode(97 + (x % 26)) + s; x = Math.floor(x / 26); }
    return s + ".";
  }
  let s = "", x = n;
  if (x > 39) return n + ".";
  for (const [v, r] of ROMAN) while (x >= v) { s += r; x -= v; }
  return s + ".";
}

// A heading's own text that ends in " #" would read as Markdown's optional closing hashes: a closing " #" of its own
// keeps it (parseLine strips one closing sequence).
const headingMd = (md) => (/[ \t]#+[ \t]*$/.test(md) ? md + " #" : md);
/** Blocks to stored Markdown (one line each). parse(serialize(doc)) gives the same blocks. */
export function serialize(doc) {
  const nums = numbers(doc);
  return doc.map((b, k) => {
    const md = inlineToMd(b.runs);
    const pad = INDENT.repeat(b.indent || 0);
    switch (b.type) {
      case "h1": return "# " + headingMd(md);
      case "h2": return "## " + headingMd(md);
      case "h3": return "### " + headingMd(md);
      case "ul": return pad + "- " + md;
      case "ol": return pad + nums[k] + ". " + md;
      case "todo": return pad + "- [" + (b.checked ? "x" : " ") + "] " + md;
      case "quote": return "> " + md;
      case "hr": return "---";
      default: return /^\s*(#{1,6}[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>|-{3,}[ \t]*$)/.test(md) ? md.replace(/^\s*/, (ws) => ws + "\\") : md;
    }
  }).join("\n");
}

// ---------- editing ----------
const cmp = (a, z) => a.b - z.b || a.o - z.o;
export const ordered = (a, z) => (cmp(a, z) <= 0 ? [a, z] : [z, a]);

/** Deletes the text between two carets (blocks between them go; the first block's type stays). */
export function deleteRange(doc0, a0, z0) {
  const [a, z] = ordered(a0, z0);
  const doc = copyDoc(doc0);
  const first = doc[a.b], last = doc[z.b];
  const merged = { ...first, runs: norm([...sliceRuns(first.runs, 0, a.o), ...sliceRuns(last.runs, z.o)]) };
  if (merged.type === "hr") Object.assign(merged, { type: "p", indent: 0 });
  doc.splice(a.b, z.b - a.b + 1, merged);
  return { doc, caret: { b: a.b, o: a.o } };
}

/** Enter: split the block; lists continue, an empty item steps out (nested: one level, top: to a paragraph). */
export function enter(doc0, c) {
  const doc = copyDoc(doc0);
  const blk = doc[c.b];
  if (blk.type === "hr") { doc.splice(c.b + 1, 0, block("p")); return { doc, caret: { b: c.b + 1, o: 0 } }; }
  const len = blockLen(blk);
  const listy = LIST.has(blk.type) || blk.type === "quote";
  if (listy && len === 0) {
    if (LIST.has(blk.type) && blk.indent > 0) blk.indent--;
    else doc[c.b] = block("p");
    return { doc, caret: { b: c.b, o: 0 } };
  }
  const nextType = listy ? blk.type : "p";
  const extra = LIST.has(nextType) ? { indent: blk.indent, ...(nextType === "todo" ? { checked: false } : {}) } : {};
  if (c.o === 0 && len > 0) {
    doc.splice(c.b, 0, block(nextType, [], extra));
    return { doc, caret: { b: c.b + 1, o: 0 } };
  }
  const head = sliceRuns(blk.runs, 0, c.o), tail = sliceRuns(blk.runs, c.o);
  doc[c.b] = { ...blk, runs: norm(head) };
  doc.splice(c.b + 1, 0, block(nextType, tail, extra));
  return { doc, caret: { b: c.b + 1, o: 0 } };
}

/** Backspace with the caret at the start of a block: a heading, list item or quote becomes a paragraph; a paragraph joins the block above. */
export function backspace(doc0, c) {
  const doc = copyDoc(doc0);
  const blk = doc[c.b];
  if (blk.type !== "p") { doc[c.b] = block("p", blk.runs); return { doc, caret: { b: c.b, o: 0 } }; }
  if (c.b === 0) return null;
  const prev = doc[c.b - 1];
  if (prev.type === "hr") { doc.splice(c.b - 1, 1); return { doc, caret: { b: c.b - 1, o: 0 } }; }
  const at = blockLen(prev);
  doc.splice(c.b - 1, 2, { ...prev, runs: norm([...prev.runs, ...blk.runs]) });
  return { doc, caret: { b: c.b - 1, o: at } };
}

/** Forward Delete with the caret at the end of a block: the next block joins it. */
export function forwardDelete(doc0, c) {
  const doc = copyDoc(doc0);
  const blk = doc[c.b], next = doc[c.b + 1];
  if (!next) return null;
  if (next.type === "hr") doc.splice(c.b + 1, 1);
  else doc.splice(c.b, 2, { ...blk, runs: norm([...blk.runs, ...next.runs]) });
  return { doc, caret: { b: c.b, o: c.o } };
}

/** Tab / Shift+Tab on list items between two blocks. A single item takes its nested items along. */
export function indent(doc0, fromB, toB, dir) {
  const doc = copyDoc(doc0);
  let changed = false;
  const one = fromB === toB;
  for (let k = fromB; k <= toB; k++) {
    const blk = doc[k];
    if (!LIST.has(blk.type)) continue;
    const prev = doc[k - 1];
    const max = Math.min(MAX_INDENT, prev && LIST.has(prev.type) ? prev.indent + 1 : 0);
    const want = Math.max(0, Math.min(max, blk.indent + dir));
    const delta = want - blk.indent;
    if (!delta) continue;
    if (one) for (let j = k + 1; j < doc.length && LIST.has(doc[j].type) && doc[j].indent > blk.indent; j++) doc[j].indent = Math.max(0, Math.min(MAX_INDENT, doc[j].indent + delta));
    blk.indent = want;
    changed = true;
  }
  return changed ? { doc } : null;
}

/**
 * Markdown typed at the start of a paragraph, with the caret just after it: "# ", "## ", "### ", "- ", "* ", "1. ",
 * "[] ", "> ", "---". In a bullet, "[] " makes it a checkbox. Returns null when nothing matches.
 */
export function shortcut(doc0, c) {
  const blk = doc0[c.b];
  const text = textOf(blk.runs), pre = text.slice(0, c.o);
  let type = null, extra = {};
  if (blk.type === "p") {
    if (pre === "---" && text === "---") {
      const doc = copyDoc(doc0);
      doc.splice(c.b, 1, block("hr"), block("p"));
      return { doc, caret: { b: c.b + 1, o: 0 } };
    }
    if (pre === "# ") type = "h1";
    else if (pre === "## ") type = "h2";
    else if (pre === "### ") type = "h3";
    else if (/^[-*+] $/.test(pre)) type = "ul";
    else if (/^\d{1,9}[.)] $/.test(pre)) type = "ol";
    else if (/^\[[ xX]?\] $/.test(pre)) { type = "todo"; extra = { checked: /x/i.test(pre) }; }
    else if (pre === "> ") type = "quote";
  } else if (blk.type === "ul" && /^\[[ xX]?\] $/.test(pre)) { type = "todo"; extra = { checked: /x/i.test(pre), indent: blk.indent }; }
  if (!type) return null;
  const doc = copyDoc(doc0);
  doc[c.b] = block(type, sliceRuns(blk.runs, pre.length), extra);
  return { doc, caret: { b: c.b, o: 0 } };
}

export function toggleChecked(doc0, b) {
  const doc = copyDoc(doc0);
  if (doc[b] && doc[b].type === "todo") doc[b].checked = !doc[b].checked;
  return { doc };
}

function eachSpan(doc, a, z, fn) {
  for (let k = a.b; k <= z.b; k++) {
    const blk = doc[k];
    const from = k === a.b ? a.o : 0, to = k === z.b ? z.o : blockLen(blk);
    if (to > from) fn(blk, from, to);
  }
}
/** Cmd+B, Cmd+I, Cmd+Shift+X, Cmd+E over a selection: on when any of it lacks the mark, off when all of it has it. */
export function toggleMark(doc0, a0, z0, mark) {
  const [a, z] = ordered(a0, z0);
  if (!cmp(a, z)) return null;
  const doc = copyDoc(doc0);
  let all = true, any = false;
  eachSpan(doc, a, z, (blk, from, to) => { for (const r of sliceRuns(blk.runs, from, to)) { any = true; if (!r[mark]) all = false; } });
  if (!any) return null;
  eachSpan(doc, a, z, (blk, from, to) => {
    const mid = sliceRuns(blk.runs, from, to).map((r) => { const o = { ...r }; if (all) delete o[mark]; else o[mark] = true; return o; });
    blk.runs = norm([...sliceRuns(blk.runs, 0, from), ...mid, ...sliceRuns(blk.runs, to)]);
  });
  return { doc };
}
/** Pasting a link over selected text links it. */
export function setLink(doc0, a0, z0, href) {
  const [a, z] = ordered(a0, z0);
  const safe = safeHref(href);
  if (!safe || !cmp(a, z)) return null;
  const doc = copyDoc(doc0);
  eachSpan(doc, a, z, (blk, from, to) => {
    blk.runs = norm([...sliceRuns(blk.runs, 0, from), ...sliceRuns(blk.runs, from, to).map((r) => ({ ...r, href: safe })), ...sliceRuns(blk.runs, to)]);
  });
  return { doc };
}

/** The blocks between two carets (for Copy). Part of one block copies as a paragraph. */
export function sliceDoc(doc, a0, z0) {
  const [a, z] = ordered(a0, z0);
  if (a.b === z.b) return [block("p", sliceRuns(doc[a.b].runs, a.o, z.o))];
  const out = [];
  for (let k = a.b; k <= z.b; k++) {
    const blk = copyBlock(doc[k]);
    if (k === a.b) blk.runs = sliceRuns(blk.runs, a.o);
    if (k === z.b) blk.runs = sliceRuns(blk.runs, 0, z.o);
    out.push(blk);
  }
  return out;
}

/**
 * Pasted blocks at a caret (the selection is already deleted). One pasted paragraph goes inline. Into an empty
 * paragraph the first block keeps its own type; otherwise the first block's text joins the caret's block and the
 * text after the caret joins the last pasted block.
 */
export function insertDoc(doc0, c, pasted) {
  if (!pasted.length) return null;
  const doc = copyDoc(doc0);
  const blk = doc[c.b];
  const head = sliceRuns(blk.runs, 0, c.o), tail = sliceRuns(blk.runs, c.o);
  const emptyP = blk.type === "p" && !blockLen(blk);
  const first = pasted[0];
  if (pasted.length === 1 && (first.type === "p" || !emptyP)) {
    doc[c.b] = { ...blk, runs: norm([...head, ...first.runs, ...tail]) };
    return { doc, caret: { b: c.b, o: c.o + blockLen(first) } };
  }
  const out = pasted.map(copyBlock);
  const len = blockLen(blk);
  // At the very end or start of a line with text, the pasted blocks go after or before it, whole.
  if (len && (c.o === len || c.o === 0)) {
    const after = c.o === len;
    if (out[out.length - 1].type === "hr" && after) out.push(block("p"));
    doc.splice(after ? c.b + 1 : c.b, 0, ...out);
    const lastIdx = (after ? c.b + 1 : c.b) + out.length - 1;
    return { doc, caret: { b: lastIdx, o: blockLen(doc[lastIdx]) } };
  }
  if (emptyP) out[0] = { ...out[0] };
  else out[0] = { ...blk, runs: norm([...head, ...first.runs]) };
  const last = out[out.length - 1];
  const at = blockLen(last);
  if (last.type === "hr") out.push(block("p", tail));
  else last.runs = norm([...last.runs, ...tail]);
  doc.splice(c.b, 1, ...out);
  const lastIdx = c.b + out.length - 1;
  return { doc, caret: last.type === "hr" ? { b: lastIdx, o: 0 } : { b: lastIdx, o: at } };
}

// ---------- paste: Markdown and plain text ----------
/** Pasted Markdown (Claude, a .md file, Notion's plain text). Blank lines separate blocks and are dropped; fenced code keeps its lines. */
export function markdownToDoc(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const out = [], lists = [];
  let fence = null;
  for (const line of lines) {
    const f = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && line.trim().startsWith(fence)) { fence = null; continue; }
      if (line.trim()) out.push(block("p", [{ text: line.replace(/\t/g, INDENT), c: true }]));
      continue;
    }
    if (f) { fence = f[1]; lists.length = 0; continue; }
    if (!line.trim()) continue;
    out.push(parseLine(line.replace(/[ \t]+$/, ""), lists, true));
  }
  return clampIndents(out);
}
/** Cmd+Shift+V: text exactly as it is, one paragraph per line. */
export function plainToDoc(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  return lines.map((l) => block("p", [{ text: l.replace(/\t/g, INDENT) }]));
}
function clampIndents(doc) {
  let prev = null;
  for (const b of doc) {
    if (LIST.has(b.type)) b.indent = Math.min(b.indent, prev && LIST.has(prev.type) ? prev.indent + 1 : 0, MAX_INDENT);
    else b.indent = 0;
    prev = b;
  }
  return doc;
}

// ---------- paste: HTML ----------
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
const SKIP = new Set("script style template noscript title head svg math iframe object select textarea button canvas video audio".split(" "));
const NAMED = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", copy: "©", reg: "®", trade: "™", times: "×", rarr: "→", larr: "←", zwj: "", zwnj: "", shy: "" };
export function decodeEntities(s) {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n === 160 ? 32 : n) : "";
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}
function parseAttrs(raw) {
  const out = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}
/** A forgiving HTML reader for clipboard fragments: a tree of { tag, attrs, kids } and strings. Nothing is executed or loaded. */
export function parseHTML(src) {
  const root = { tag: "#root", attrs: {}, kids: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const text = (t) => { if (t) top().kids.push(decodeEntities(t)); };
  const closeUpTo = (tags, stops) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stops.includes(stack[k].tag)) return;
      if (tags.includes(stack[k].tag)) { stack.length = k; return; }
    }
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) { text(src.slice(i)); break; }
    if (lt > i) text(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); i = e === -1 ? src.length : e + 3; continue; }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") { const e = src.indexOf(">", lt); i = e === -1 ? src.length : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(lt, lt + 80));
    if (!m) { text("<"); i = lt + 1; continue; }
    let j = lt + m[0].length, q = "";
    for (; j < src.length; j++) {
      const ch = src[j];
      if (q) { if (ch === q) q = ""; } else if (ch === "\"" || ch === "'") q = ch;
      else if (ch === ">") break;
    }
    const raw = src.slice(lt + m[0].length, j);
    i = j + 1;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { stack.length = k; break; }
      continue;
    }
    const selfClose = /\/\s*$/.test(raw);
    if (SKIP.has(tag)) {
      if (selfClose) continue;
      const rest = new RegExp("</" + tag + "\\s*>", "i").exec(src.slice(i));
      i = rest ? i + rest.index + rest[0].length : src.length;
      continue;
    }
    if (tag === "li") closeUpTo(["li"], ["ul", "ol"]);
    else if (tag === "p") closeUpTo(["p"], ["div", "li", "td", "th", "blockquote", "body"]);
    else if (tag === "tr") closeUpTo(["tr"], ["table"]);
    else if (tag === "td" || tag === "th") closeUpTo(["td", "th"], ["tr", "table"]);
    const node = { tag, attrs: parseAttrs(raw), kids: [] };
    top().kids.push(node);
    if (!VOID.has(tag) && !selfClose) stack.push(node);
  }
  return root;
}

const BLOCKISH = new Set("p div section article header footer main aside nav figure figcaption address dd dt dl center details summary form fieldset body html table thead tbody tfoot caption tr".split(" "));
function styleMarks(n, marks) {
  let m = marks;
  const style = (n.attrs.style || "").toLowerCase();
  const set = (k, v) => { if (!!m[k] !== v) { m = { ...m }; if (v) m[k] = true; else delete m[k]; } };
  const fw = /font-weight\s*:\s*([a-z0-9]+)/.exec(style);
  if (fw) set("b", fw[1] === "bold" || fw[1] === "bolder" || +fw[1] >= 600);
  const fs = /font-style\s*:\s*([a-z]+)/.exec(style);
  if (fs) set("i", fs[1] === "italic" || fs[1] === "oblique");
  if (/text-decoration[a-z-]*\s*:[^;]*line-through/.test(style)) set("s", true);
  if (/font-family\s*:[^;]*(mono|courier|consolas|menlo)/.test(style)) set("c", true);
  return m;
}
function hasCheckbox(n) {
  const cls = n.attrs.class || "";
  if (/checkbox-on|checked/.test(cls)) return { on: true };
  if (/checkbox-off|task-list-item|to-do/.test(cls)) return { on: false };
  for (const k of n.kids) {
    if (typeof k === "string") { if (k.trim()) return null; continue; }
    if (k.tag === "input" && (k.attrs.type || "").toLowerCase() === "checkbox") return { on: "checked" in k.attrs };
    if (k.tag === "ul" || k.tag === "ol") return null;
    const deep = hasCheckbox(k);
    if (deep) return deep;
  }
  return null;
}

/** Clipboard HTML (Notion, Google Docs, web pages, Claude) to blocks. Unknown tags pass their text through. */
export function htmlToDoc(html) {
  const out = [];
  const st = { lists: [], quote: 0, pre: 0 };
  let cur = null;
  const hasText = () => !!cur && !!textOf(cur.runs).trim();
  const finish = () => {
    if (!cur) return;
    const b = cur;
    cur = null;
    if (!st.pre) {
      if (b.runs.length) b.runs[0].text = b.runs[0].text.replace(/^\s+/, "");
      if (b.runs.length) b.runs[b.runs.length - 1].text = b.runs[b.runs.length - 1].text.replace(/\s+$/, "");
    }
    b.runs = norm(b.runs);
    const explicit = b.explicit;
    delete b.explicit;
    // An empty <p> (a blank line copied from a note, Docs or Notion) is a blank paragraph; whitespace between tags is nothing.
    if (!textOf(b.runs).trim()) { if (!explicit || b.type !== "p") return; b.runs = []; }
    if (b.type === "ul") {
      const m = /^\[([ xX]?)\]\s+/.exec(textOf(b.runs));
      if (m) { b.type = "todo"; b.checked = /x/i.test(m[1]); b.runs = sliceRuns(b.runs, m[0].length); }
    }
    out.push(b);
  };
  const brk = () => { if (hasText()) finish(); };
  const append = (t, marks) => {
    if (st.pre) {
      const lines = t.split("\n");
      lines.forEach((line, k) => {
        if (k > 0) { finish(); cur = block("p"); }
        if (!cur) cur = block("p");
        if (line) cur.runs.push({ text: line.replace(/\t/g, INDENT), ...marks });
      });
      return;
    }
    t = t.replace(/[\t\n\r\f ]+/g, " ").replace(/ /g, " ");
    if (!cur) { if (!t.trim()) return; cur = block(st.quote ? "quote" : "p"); }
    const prev = textOf(cur.runs);
    if (!prev || prev.endsWith(" ")) t = t.replace(/^ /, "");
    if (t) cur.runs.push({ text: t, ...marks });
  };
  const walk = (n, marks) => { for (const k of n.kids) typeof k === "string" ? append(k, marks) : elem(k, marks); };
  const elem = (n, marks0) => {
    const t = n.tag;
    const marks = styleMarks(n, marks0);
    if (t === "h1" || t === "h2" || t === "h3") { finish(); cur = block(t); walk(n, marks); finish(); return; }
    if (/^h[4-6]$/.test(t)) { finish(); cur = block(st.quote ? "quote" : "p"); walk(n, { ...marks, b: true }); finish(); return; }
    if (t === "ul" || t === "ol") {
      if (cur && !hasText() && LIST.has(cur.type)) cur = null; else finish();
      st.lists.push(t); walk(n, marks); st.lists.pop(); finish(); return;
    }
    if (t === "li") {
      finish();
      const depth = Math.max(0, st.lists.length - 1);
      const aria = parseInt(n.attrs["aria-level"], 10);
      const box = hasCheckbox(n);
      const type = box ? "todo" : st.lists[st.lists.length - 1] === "ol" ? "ol" : "ul";
      cur = block(type, [], { indent: Math.min(MAX_INDENT, aria > 0 ? aria - 1 : depth), ...(box ? { checked: box.on } : {}) });
      walk(n, marks);
      finish();
      return;
    }
    // A paragraph inside a list item or a quote is that item's text; on its own it is a block, kept even when empty.
    if (t === "p" && !st.pre) {
      if (hasText()) finish();
      if (!cur) cur = Object.assign(block(st.quote ? "quote" : "p"), { explicit: true });
      walk(n, marks);
      finish();
      return;
    }
    if (t === "blockquote") { finish(); st.quote++; walk(n, marks); finish(); st.quote--; return; }
    if (t === "pre") { finish(); st.pre++; cur = block("p"); walk(n, { ...marks, c: true }); finish(); st.pre--; return; }
    if (t === "br") { if (st.pre) append("\n", marks); else finish(); return; }
    if (t === "hr") { finish(); out.push(block("hr")); return; }
    if (t === "img" || t === "input") return;
    if (t === "td" || t === "th") { if (hasText()) append(" | ", {}); walk(n, t === "th" ? { ...marks, b: true } : marks); return; }
    if (BLOCKISH.has(t)) { brk(); walk(n, marks); brk(); return; }
    if (t === "a") { const href = safeHref(n.attrs.href); walk(n, href ? { ...marks, href } : marks); return; }
    if (t === "strong" || t === "b") { walk(n, /font-weight\s*:\s*(normal|400|lighter)/i.test(n.attrs.style || "") ? marks : { ...marks, b: true }); return; }
    if (t === "em" || t === "i" || t === "cite" || t === "dfn" || t === "var") { walk(n, /font-style\s*:\s*normal/i.test(n.attrs.style || "") ? marks : { ...marks, i: true }); return; }
    if (t === "s" || t === "strike" || t === "del") { walk(n, { ...marks, s: true }); return; }
    if (t === "code" || t === "kbd" || t === "samp" || t === "tt") { walk(n, { ...marks, c: true }); return; }
    walk(n, marks);
  };
  walk(parseHTML(String(html)), {});
  finish();
  return clampIndents(out);
}

const RICH = /<(h[1-6]|ul|ol|li|blockquote|pre|strong|em|b|i|code|table|del|s)\b/i;
const MD_BLOCK = /^(#{1,6}[ \t]|[ \t]*[-*+][ \t]|[ \t]*\d{1,9}[.)][ \t]|>|```)/m;
/**
 * What a paste becomes. Rich HTML wins; plain text is read as Markdown. HTML that only wraps text (a code editor's
 * colored spans, a chat app's paragraphs around Markdown) defers to the plain text. `plain` (Cmd+Shift+V) keeps the text as is.
 */
export function pasteDoc({ html = "", text = "", plain = false, inline = false }) {
  if (plain) return plainToDoc(text);
  const editorCopy = /white-space\s*:\s*pre/i.test(html) && !/<(h[1-6]|ul|ol|li|p)\b/i.test(html);
  const useHtml = !!html && !editorCopy && (RICH.test(html) || (!MD_BLOCK.test(text) && /<(p|div|br)\b/i.test(html)));
  if (useHtml) {
    const d = htmlToDoc(html);
    if (d.length || !text) return d;
  }
  const one = text.replace(/\r?\n$/, "");
  if (inline && !one.includes("\n")) {
    const url = safeHref(one.trim());
    return [block("p", url ? [{ text: one.trim(), href: url }] : parseInline(one))];
  }
  return markdownToDoc(text);
}

// ---------- copy: HTML ----------
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function runsToHtml(runs) {
  return norm(runs).map((r) => {
    let s = escHtml(r.text);
    if (r.c) s = "<code>" + s + "</code>";
    if (r.s) s = "<s>" + s + "</s>";
    if (r.i) s = "<em>" + s + "</em>";
    if (r.b) s = "<strong>" + s + "</strong>";
    if (r.href) s = "<a href=\"" + escHtml(r.href) + "\">" + s + "</a>";
    return s;
  }).join("");
}
/** Blocks as semantic HTML, so a copy pastes formatted into Notion, Docs or mail. */
export function docToHtml(doc) {
  let html = "";
  const open = [];
  const closeTo = (d) => { while (open.length > d) html += "</li></" + open.pop() + ">"; };
  for (const b of doc) {
    const inner = runsToHtml(b.runs);
    if (LIST.has(b.type)) {
      const tag = b.type === "ol" ? "ol" : "ul", d = b.indent + 1;
      if (open.length >= d) {
        closeTo(d);
        if (open[d - 1] !== tag) html += "</li></" + open.pop() + ">";
        else html += "</li>";
      }
      while (open.length < d) { html += "<" + tag + ">"; open.push(tag); }
      html += "<li>" + (b.type === "todo" ? (b.checked ? "[x] " : "[ ] ") : "") + inner;
      continue;
    }
    closeTo(0);
    if (b.type === "h1" || b.type === "h2" || b.type === "h3") html += "<" + b.type + ">" + inner + "</" + b.type + ">";
    else if (b.type === "quote") html += "<blockquote>" + inner + "</blockquote>";
    else if (b.type === "hr") html += "<hr>";
    else html += "<p>" + (inner || "<br>") + "</p>";
  }
  closeTo(0);
  return html;
}
