// Inline text editing. Double-click a text layer (or press Enter with one selected) to edit it in
// place: the caret goes where you clicked (a double-click selects the word, Enter selects all the text), then
// every text key works: arrows, Option/Cmd word and line moves, Shift selections, Cmd+A (the text, not the
// canvas), Cmd+C/X/V (plain text only), Cmd+Z / Shift+Cmd+Z inside the edit, Enter for a new line, Tab for a tab.
// Esc, Cmd+Enter or a click outside ends the edit: one write (POST /api/text, src/textedit.ts), one undo step in
// Canvas's history. Empty text deletes the layer. Text inside a component instance is written as an
// override on the instance (the component stays as it is).
//
// How it looks the same as the canvas at any zoom: the canvas itself keeps drawing the text. The engine gets the
// content being typed as a pinned override on the board's scene (src/page/live.js pin), so it lays the text out
// and draws it with its own fonts, tracking, wrapping, colour and rotation, auto-width text grows and auto layout
// around it moves, frame by frame. Over it sits a textarea with the same font metrics and transparent text: it
// owns the caret, the selection highlight and the keys. Nothing is drawn twice, so there is nothing to hide.
//
// The canvas keys (V, K, arrows, Backspace, 1/2/0, Space...) never see a key typed here: every handler on the page
// returns for a focused textarea. In Canvas.app the Edit menu sends Cut/Copy/Paste/Select All to the focused
// textarea natively (apps/macos/main.swift) and Undo/Redo as {cmd: "undo" | "redo"}, which the page hands to the
// editor's own history (host.textEdit.step) while an edit is open.
//
// Paragraph spacing, paragraph indent and lists (src/page/text-paras.js): the field is then one block per paragraph
// laid out by the same rules as the engine (space above, first-line indent, a list item's hanging indent), so the caret
// stays where the canvas draws each line. In a list item Tab and Shift+Tab nest it, Return on an empty item ends it
// a level at a time, Backspace at its start takes its marker off and keeps its indent (again: a level out), and "- ",
// "* ", "1. " typed at a paragraph's start make a list. Shift+Cmd+8 / Shift+Cmd+7 make the selected
// paragraphs bulleted / numbered. A hanging opening quote is its own span, the paragraph's text-indent moved left by
// its measured width. Letter case is the field's CSS text-transform / font-feature-settings, as the canvas draws it.
//
// The pure helpers at the top are node-tested (test/text-edit.test.ts).

import { dblClickEdits } from "./geometry.js";
import * as SP from "./text-spans.js";
import * as PA from "./text-paras.js";
import { typeStep } from "./shortcuts-logic.js";
import { patchField } from "./text-patch.js";

export const DEFAULT_SIZE = 13; // the engine's default for text without fontSize (engine/src/text.rs)
export const DEFAULT_LINE_HEIGHT = 1.45; // and without lineHeight
export const FAMILY_SEP = "\u001f"; // src/scene.ts: a tagged face of a family ("Inter\u001f2:cyrillic")
export const MAX_TEXT = 500_000; // src/textedit.ts: the longest text a write takes

/** A CSS font weight from a file value (engine weight_of). */
export function weightOf(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "" || s === "normal" || s === "regular") return 400;
    if (s === "bold") return 700;
    const n = Number.parseFloat(s);
    if (n > 0) return n;
  }
  return 400;
}

/** The macOS system font: the browser draws it as system-ui (engine is_system_family). */
export function isSystemFamily(family) {
  const f = String(family || "").split(FAMILY_SEP)[0].trim().toLowerCase();
  return f === "system-ui" || f === "-apple-system" || f === "blinkmacsystemfont" || f.startsWith("sf pro") || f.startsWith("san francisco");
}

/** How a text layer sizes itself: "auto" (grows both ways), "fixed-width" (wraps, grows down) or "fixed-width-height". */
export const growthOf = (n) => (n && (n.textGrowth === "fixed-width" || n.textGrowth === "fixed-width-height") ? n.textGrowth : "auto");

const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

/**
 * The faces to register and the CSS font-family list that pick the same files the engine draws with, from a
 * board scene's `fonts` (src/scene.ts FontRef). Faces of the node's family come first (plain, then its tagged
 * subsets in tag order), then system-ui and sans-serif, like the engine's fallback chain.
 * Returns { faces: [{ name, url, weight, style }], stack }.
 */
export function fontPlan(fonts, family) {
  const fam = String(family || "Inter");
  if (isSystemFamily(fam)) return { faces: [], stack: "system-ui,sans-serif" };
  const base = fam.toLowerCase();
  const groups = new Map(); // full family name -> refs
  for (const f of Array.isArray(fonts) ? fonts : []) {
    if (!f || typeof f.family !== "string" || typeof f.url !== "string") continue;
    if (f.family.split(FAMILY_SEP)[0].toLowerCase() !== base) continue;
    if (!groups.has(f.family)) groups.set(f.family, []);
    groups.get(f.family).push(f);
  }
  const tagOf = (name) => {
    const t = name.split(FAMILY_SEP)[1];
    if (t === undefined) return -1;
    const n = Number.parseInt(t.split(":")[0], 10);
    return Number.isFinite(n) ? n : 1000;
  };
  const names = [...groups.keys()].sort((a, b) => tagOf(a) - tagOf(b));
  const faces = [];
  const stack = [];
  for (const full of names) {
    const refs = groups.get(full);
    const name = "cvt-" + hash(full);
    stack.push(JSON.stringify(name));
    // One file for the family: a variable face (or the only weight the board uses), so it takes every weight.
    const one = new Set(refs.map((r) => r.url)).size === 1;
    const seen = new Set();
    for (const r of refs) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      faces.push({ name, url: r.url, weight: one ? "1 1000" : String(r.weight || 400), style: r.style === "italic" ? "italic" : "normal" });
    }
  }
  // Not listed (no scene yet, or a family the server could not find): the browser's own match by name.
  if (!stack.length) stack.push(JSON.stringify(fam));
  stack.push("system-ui", "sans-serif");
  return { faces, stack: stack.join(",") };
}

/** The CSS text properties that lay a scene text node out like the engine does. */
export function textCss(n, stack) {
  const growth = growthOf(n);
  const size = typeof n.fontSize === "number" && n.fontSize > 0 ? n.fontSize : DEFAULT_SIZE;
  const lh = typeof n.lineHeight === "number" && n.lineHeight > 0 ? n.lineHeight : DEFAULT_LINE_HEIGHT;
  const align = n.textAlign === "center" || n.textAlign === "right" || n.textAlign === "justify" ? n.textAlign : "left";
  return {
    fontFamily: stack,
    fontSize: size + "px",
    fontWeight: String(weightOf(n.fontWeight)),
    fontStyle: typeof n.fontStyle === "string" && /italic/i.test(n.fontStyle) ? "italic" : "normal",
    letterSpacing: (typeof n.letterSpacing === "number" ? n.letterSpacing : 0) + "px",
    lineHeight: String(lh),
    textAlign: align,
    whiteSpace: growth === "auto" ? "pre" : "pre-wrap",
    overflowWrap: growth === "auto" ? "normal" : "break-word",
    // Letter case: the field's letters in the case the canvas draws (the typed letters stay as typed).
    ...PA.caseCss(n),
  };
}

/** The caret colour: the text's own solid colour when it has one. */
export function caretOf(n) {
  const f = Array.isArray(n && n.fill) ? n.fill.find((p) => p && (typeof p === "string" || (p.type === "color" && p.enabled !== false))) : n && n.fill;
  const c = typeof f === "string" ? f : f && typeof f.color === "string" ? f.color : null;
  return c && /^#[0-9a-f]{3,8}$/i.test(c) ? c.slice(0, 7) : "#000000";
}

/** The scene nodes from the root down to `id` (inclusive), or null. */
export function pathTo(root, id) {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n !== "object") return false;
    out.push(n);
    if (String(n.id) === id) return true;
    for (const c of Array.isArray(n.children) ? n.children : []) if (visit(c)) return true;
    out.pop();
    return false;
  };
  return visit(root) ? out : null;
}

/** The rotation a node is drawn at, in degrees (its own and its ancestors': the file turns counter-clockwise). */
export const rotationOf = (path) => (path || []).reduce((s, n) => s + (Number(n && n.rotation) || 0), 0);

/**
 * Where a box of w x h turned by `deg` (CSS rotate(-deg) about its top-left, as the format defines it) has its top-left,
 * given the axis-aligned bounds of the turned box.
 */
export function originFromBounds(bounds, w, h, deg) {
  if (!deg) return { x: bounds.x, y: bounds.y };
  const t = (-deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const xs = [0, w * c, -h * s, w * c - h * s], ys = [0, w * s, h * c, w * s + h * c];
  return { x: bounds.x - Math.min(...xs), y: bounds.y - Math.min(...ys) };
}

/**
 * The unturned size of a box from the axis-aligned bounds of it turned by `deg`, or null near 45 degrees, where
 * the bounds no longer say (W = w|cos| + h|sin|, H = w|sin| + h|cos|).
 */
export function sizeFromBounds(bounds, deg) {
  if (!deg) return { w: bounds.w, h: bounds.h };
  const t = (deg * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  const d = c * c - s * s;
  if (Math.abs(d) < 0.1) return null;
  const w = (bounds.w * c - bounds.h * s) / d, h = (bounds.h * c - bounds.w * s) / d;
  return w > 0 && h >= 0 ? { w, h } : null;
}

/** The word (or the run of spaces or punctuation) around offset i: [start, end). */
export function wordRange(text, i) {
  const s = String(text);
  if (!s) return [0, 0];
  i = Math.max(0, Math.min(i, s.length));
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segs = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(s)];
    let hit = segs.find((g) => i >= g.index && i < g.index + g.segment.length);
    // At the end of a word (a click past its last letter): that word.
    if ((!hit || !hit.isWordLike) && i > 0) { const prev = segs.find((g) => i - 1 >= g.index && i - 1 < g.index + g.segment.length); if (prev && prev.isWordLike) hit = prev; }
    if (hit) return [hit.index, hit.index + hit.segment.length];
    return [i, i];
  }
  const word = /[\p{L}\p{N}_'’]/u;
  const at = i < s.length && word.test(s[i]) ? i : i > 0 && word.test(s[i - 1]) ? i - 1 : -1;
  if (at < 0) return [i, i];
  let a = at, b = at;
  while (a > 0 && word.test(s[a - 1])) a--;
  while (b < s.length && word.test(s[b])) b++;
  return [a, b];
}

/**
 * What ending an edit writes: nothing, a delete (empty text on a layer of the tree), or the new content, with its
 * styled ranges (src/page/text-spans.js) when the layer had any or has any now.
 */
export function commitPlan(original, value, id, origSpans = [], spans = [], origLists = [], lists = []) {
  const v = String(value).replace(/\r\n?/g, "\n");
  const a = origSpans || [], b = spans || [];
  const la = origLists || [], lb = lists || [];
  const sameSpans = JSON.stringify(a) === JSON.stringify(b);
  const sameLists = JSON.stringify(la) === JSON.stringify(lb);
  if (v === String(original ?? "") && sameSpans && sameLists) return { kind: "none" };
  if (v === "" && !String(id).includes("/")) return { kind: "delete" };
  const out = { kind: "write", content: v };
  if (a.length || b.length) out.spans = b;
  if (la.length || lb.length) out.lists = lb;
  return out;
}

const heavy = (w) => weightOf(w) >= 600;
/**
 * A text style key on the letters [start, end) while editing (select a word and press Cmd+B): the spans after
 * it. Toggles (bold, italic, underline, strike) turn on unless every letter has it, then off; steps (bigger, smaller,
 * tracking+-, weight+-) move each stretch from its own value. `base`: the layer's own style.
 */
export function styleStep(spans, start, end, base, len, what) {
  if (!(end > start)) return SP.normalize(spans, len, base);
  const cuts = new Set([start, end]);
  for (const s of spans || []) for (const p of [s.start, s.end]) if (p > start && p < end) cuts.add(p);
  const at = [...cuts].sort((x, y) => x - y);
  const segs = [];
  for (let i = 0; i + 1 < at.length; i++) {
    const own = (spans || []).find((s) => s.start <= at[i] && s.end >= at[i + 1]) || {};
    segs.push({ start: at[i], end: at[i + 1], style: { ...base, ...Object.fromEntries(Object.entries(own).filter(([k]) => SP.SPAN_KEYS.includes(k))) } });
  }
  const toggle = (key, on, isOn, off) => {
    const all = segs.every((g) => isOn(g.style[key]));
    const baseOn = isOn(base[key]);
    return SP.apply(spans, start, end, { [key]: all ? (baseOn ? off : null) : (baseOn ? null : on) }, len, base);
  };
  if (what === "bold") return toggle("fontWeight", "700", heavy, "400");
  if (what === "italic") return toggle("fontStyle", "italic", (v) => v === "italic", "normal");
  if (what === "underline") return toggle("underline", true, (v) => v === true, false);
  if (what === "strike") return toggle("strikethrough", true, (v) => v === true, false);
  let out = spans || [];
  for (const g of segs) {
    let p = null;
    if (what === "bigger" || what === "smaller") {
      const fs = typeof g.style.fontSize === "number" ? g.style.fontSize : DEFAULT_SIZE;
      p = { fontSize: Math.max(1, fs + (what === "bigger" ? 1 : -1)) };
    } else if (what.startsWith("tracking") || what.startsWith("weight")) p = typeStep(g.style, what);
    if (p) out = SP.apply(out, g.start, g.end, p, len, base);
  }
  return SP.normalize(out, len, base);
}

/** What a key in the editor does, or null for the textarea's own handling. `native`: the app's Edit menu owns Cmd+Z. */
export function keyIntent(e, native = false) {
  const cmd = e.metaKey || e.ctrlKey;
  // An IME composition (Japanese, Chinese, Korean) owns Esc, Enter and Tab until it ends: never commit half of it.
  if (e.isComposing || e.keyCode === 229) return "compose";
  if (e.key === "Escape") return "commit";
  if (e.key === "Enter" && cmd) return "commit";
  if (e.key === "Tab" && !cmd && !e.altKey && !e.shiftKey) return "tab";
  // Shift+Tab would move focus out of the editor (and the next key would only bring it back).
  if (e.key === "Tab" && e.shiftKey) return "swallow";
  // Select All is the text's (the app's Edit menu would select the canvas layers when focus is elsewhere).
  if (cmd && !e.altKey && !e.shiftKey && (e.code === "KeyA" || (e.key || "").toLowerCase() === "a")) return "selectAll";
  if (!native && cmd && !e.altKey && (e.code === "KeyZ" || (e.key || "").toLowerCase() === "z")) return e.shiftKey ? "redo" : "undo";
  if (!native && e.ctrlKey && !e.metaKey && (e.code === "KeyY" || e.key === "y")) return "redo";
  // Text style keys (src/page/shortcuts.js has them for whole layers): on the selected letters while editing.
  const c = e.code;
  if (cmd && !e.altKey && !e.shiftKey) { const s = { KeyB: "bold", KeyI: "italic", KeyU: "underline" }[c]; if (s) return "style:" + s; }
  if (cmd && !e.altKey && e.shiftKey) { const s = { KeyX: "strike", Period: "bigger", Comma: "smaller" }[c]; if (s) return "style:" + s; }
  // Lists: Shift+Cmd+8 bulleted, Shift+Cmd+7 numbered.
  if (cmd && !e.altKey && e.shiftKey && (c === "Digit8" || c === "Digit7")) return c === "Digit8" ? "list:bullet" : "list:number";
  if (e.altKey && (c === "Period" || c === "Comma")) {
    const dir = c === "Period" ? "+" : "-";
    if (!cmd && !e.shiftKey) return "style:tracking" + dir;
    if (!cmd && e.shiftKey) return "style:leading" + dir;
    if (cmd && !e.shiftKey) return "style:weight" + dir;
  }
  return null;
}

/**
 * While a text layer is being edited, a plain click on another text layer edits that one, with the caret
 * where the click was. The layer to edit next, or null when the click only ends the edit (not text, the same
 * layer, a modifier, a right-click, hand mode, a card).
 */
export function nextEdit({ editing, leaf, isText, button, shift, meta, alt, hand }) {
  if (!editing || !leaf || leaf === editing || String(leaf).startsWith("widget:")) return null;
  if (!isText || button !== 0 || shift || meta || alt || hand) return null;
  return leaf;
}

/** What the mirror (the block that sizes the editor) shows: an empty last line still takes a line, like the caret does. */
export const mirrorText = (v) => (v === "" || v.endsWith("\n") ? v + "​" : v);

/**
 * The editor's own undo history (the browser's is per textarea and unreachable from the app's Edit menu).
 * States are { value, start, end }. Typing (or deleting) in one run within MERGE_MS is one step, like a text field.
 */
export class TextHistory {
  static MERGE_MS = 1000;
  static MAX = 500;
  /** Characters kept over all states: each state is a full copy, and 500 copies of a 500 000-character text are 500 MB. */
  static MAX_CHARS = 4_000_000;
  constructor() { this.undos = []; this.redos = []; this.after = null; this.kind = ""; this.at = 0; this.chars = 0; }
  /** Before an input of `kind` ("insert", "delete", "compose", or anything else: its own step) changes `before`. */
  begin(before, kind, now) {
    // A composition (IME) is one step however long it takes; typing and deleting merge within MERGE_MS.
    const run = kind === "compose" ? this.kind === "compose" : (kind === "insert" || kind === "delete") && kind === this.kind && now - this.at < TextHistory.MERGE_MS;
    const same = this.after && this.after.value === before.value && this.after.start === before.start && this.after.end === before.end;
    if (!(run && same)) this.push(this.undos, before);
    this.dropRedos();
    this.kind = kind;
    this.at = now;
  }
  /** A composition ended: the next one is a step of its own. */
  endComposition() { if (this.kind === "compose") this.kind = ""; }
  /** The state the input left. */
  end(after) { this.after = { ...after }; }
  undo(cur) {
    const s = this.undos.pop();
    if (!s) return null;
    this.chars -= s.value.length;
    this.push(this.redos, cur);
    this.kind = ""; this.after = { ...s };
    return s;
  }
  redo(cur) {
    const s = this.redos.pop();
    if (!s) return null;
    this.chars -= s.value.length;
    this.push(this.undos, cur);
    this.kind = ""; this.after = { ...s };
    return s;
  }
  push(list, st) {
    list.push({ ...st });
    this.chars += String(st.value).length;
    // Over either budget: the oldest undo states go first (never the newest one, so the last step always undoes).
    while ((this.undos.length > TextHistory.MAX || this.chars > TextHistory.MAX_CHARS) && this.undos.length > 1) this.chars -= this.undos.shift().value.length;
    while (this.chars > TextHistory.MAX_CHARS && this.redos.length > 1) this.chars -= this.redos.shift().value.length;
  }
  dropRedos() {
    for (const r of this.redos) this.chars -= r.value.length;
    this.redos.length = 0;
  }
}

// Grapheme clusters (what a reader calls one character): Backspace and Delete with no range from the browser take
// one whole. Without Intl.Segmenter, a surrogate pair at least.
const graphemes = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
/** Where the character that ends at `i` starts. */
export function clusterBefore(s, i) {
  if (i <= 0) return 0;
  if (graphemes) { for (const g of graphemes.segment(s)) if (g.index + g.segment.length >= i) return g.index; return Math.max(0, i - 1); }
  return Math.max(0, i - (i >= 2 && /[\udc00-\udfff]/.test(s[i - 1]) ? 2 : 1));
}
/** Where the character that starts at `i` ends. */
export function clusterAfter(s, i) {
  if (i >= s.length) return s.length;
  if (graphemes) { for (const g of graphemes.segment(s)) if (g.index + g.segment.length > i) return g.index + g.segment.length; return s.length; }
  return Math.min(s.length, i + (/[\ud800-\udbff]/.test(s[i] || "") ? 2 : 1));
}

/** An input event's kind for the history: runs of typing and of deleting merge, the rest are steps of their own. */
export const inputKind = (t) => (t === "insertText" ? "insert" : t === "insertCompositionText" ? "compose" : typeof t === "string" && t.startsWith("delete") && t !== "deleteByCut" ? "delete" : t || "other");

// ---------------------------------------------------------------- the page

const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || !!(t.closest && t.closest("[contenteditable]")));

export function attach(host) {
  if (!host || host.textEdit) return;
  // A reload or another file in the middle of an edit leaves none open (also on the empty page, which has no file).
  if (host.native && host.post) host.post({ textEditing: false });
  if (!host.file) return;
  const { view, file } = host;
  const selBox = document.getElementById("sel");
  const tell = (t) => { if (host.native) host.post({ toast: t }); else { const m = document.getElementById("msg"); if (m) { m.textContent = t; m.style.display = "block"; setTimeout(() => { m.style.display = "none"; }, 4000); } else console.warn("[canvas] " + t); } };
  const ev = () => host.engineView;
  const live = () => host.live;
  /** Typing that could not be saved goes on the clipboard, so it is not lost with the editor. Resolves whether it did. */
  const keep = (text) => {
    if (host.native) { host.post({ clipboard: text }); return Promise.resolve(true); }
    try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false); } catch {}
    return Promise.resolve(false);
  };
  /** Says why the typing could not be saved, and that it is on the clipboard when it is. */
  const lose = (why, typed) => {
    if (!typed) { tell(why); return; }
    keep(typed).then((ok) => tell(why + (ok ? "; what you typed is on the clipboard" : "")));
  };

  const st = document.createElement("style");
  st.textContent = [
    "#textEdit{position:fixed;left:0;top:0;transform-origin:0 0;z-index:3;display:flex;flex-direction:column;box-sizing:border-box;margin:0;padding:0;pointer-events:auto;cursor:text}",
    "#textEdit.loading{opacity:0;pointer-events:none}",
    "#textEdit .tb{position:relative;flex:none}",
    "#textEdit .f{display:block;margin:0;padding:0;border:0;outline:0;background:transparent;color:transparent;-webkit-text-fill-color:transparent;min-width:1px;box-sizing:border-box;font-kerning:auto;font-optical-sizing:auto;cursor:text;-webkit-user-modify:read-write-plaintext-only}",
    "#textEdit .f span{font-optical-sizing:auto}",
    "#textEdit .f>div{position:relative}",
    "#textEdit .f::selection,#textEdit .f *::selection{background:rgba(13,153,255,.32);color:transparent;-webkit-text-fill-color:transparent}",
    "#sel.editing i,#sel.editing #seldim{display:none}",
  ].join("");
  document.head.appendChild(st);

  // ---------- fonts: the files the engine draws with, under names of their own ----------
  const faces = new Map(); // name|url -> FontFace
  function useFonts(plan) {
    const loads = [];
    for (const f of plan.faces) {
      const k = f.name + "|" + f.url + "|" + f.weight + "|" + f.style;
      let face = faces.get(k);
      if (!face) {
        try {
          face = new FontFace(f.name, "url(" + JSON.stringify(f.url) + ")", { weight: f.weight, style: f.style });
          document.fonts.add(face);
          faces.set(k, face);
        } catch { continue; }
      }
      if (face.status === "unloaded") loads.push(face.load().catch(() => {}));
      else if (face.status === "loading") loads.push(face.loaded.catch(() => {}));
    }
    return loads.length ? Promise.all(loads) : null;
  }

  /** A text node as the canvas draws it now, with what the editor needs, or null. */
  function nodeInfo(id) {
    const L = live(), v = ev();
    if (!L || !v || typeof id !== "string" || id.startsWith("widget:")) return null;
    const board = L.boardOf(id);
    if (!board || !host.boards.has(board) || !v.isLoaded(board)) return null;
    const scene = L.sceneOf(board);
    if (!scene) return { board, pending: true };
    const path = pathTo(scene.root, id);
    if (!path) return null;
    const node = path[path.length - 1];
    if (node.type !== "text") return null;
    return { board, scene, node, rot: rotationOf(path) };
  }
  // Warm the fonts of a selected text layer, so a double-click lands the caret right the first time.
  host.on("select", (id) => {
    if (te && id !== te.id) { commit("select"); return; }
    const inf = nodeInfo(id);
    if (inf && inf.node) useFonts(fontPlan(inf.scene.fonts, inf.node.fontFamily));
  });
  host.on("deselect", () => { if (te) commit("deselect"); });
  host.on("page", () => { if (te) commit("page"); });

  // ---------- the editor ----------
  let te = null; // the edit in progress
  let raf = 0;
  const inflight = new Set(); // text writes not answered yet: Promise<boolean>

  // ---------- the field: a contenteditable block, one <span> per stretch of the text ----------
  // A textarea has one font for all its letters; styled ranges (bold words, a bigger heading word) need the caret
  // and the selection to sit where each letter is drawn, so the field is a plain-text contenteditable whose spans
  // carry each range's metrics (size, weight, style, family, tracking). Its letters are transparent: the canvas
  // draws them. Every edit goes through the model (te.value, te.spans) and the field is drawn again from it, except
  // an IME composition, which the browser runs and the model reads back when it ends.

  /** The text a DOM fragment holds: a <br> is a line break, the end marker nothing, a block starts a line. */
  function textOfDom(root) {
    if (te && te.paraMode) return parasOfDom(root);
    let s = "";
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.data;
        else if (c.nodeName === "BR") { if (!(c.dataset && "end" in c.dataset)) s += "\n"; }
        else if (c.nodeType === 1) {
          if ((c.nodeName === "DIV" || c.nodeName === "P") && s.length && !s.endsWith("\n")) s += "\n";
          walk(c);
        }
      }
    };
    walk(root);
    return s;
  }
  /** Paragraph mode: each top-level block is a paragraph; their letters joined by newlines. */
  function parasOfDom(root) {
    const flat = (n) => { let s = ""; for (const c of n.childNodes) { if (c.nodeType === 3) s += c.data; else if (c.nodeName === "BR") { if (!(c.dataset && "end" in c.dataset)) s += "\n"; } else if (c.nodeType === 1) s += flat(c); } return s; };
    const parts = [];
    for (const c of root.childNodes) {
      if (c.nodeType === 1 && (c.nodeName === "DIV" || c.nodeName === "P")) parts.push(flat(c));
      else { if (!parts.length) parts.push(""); parts[parts.length - 1] += c.nodeType === 3 ? c.data : c.nodeType === 1 ? flat(c) : ""; }
    }
    return parts.join("\n");
  }
  /** The text offset of a DOM point inside the field. */
  function offsetAt(node, off) {
    const f = te.ta;
    if (!f.contains(node)) return node.compareDocumentPosition && f.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? 0 : te.value.length;
    const r = document.createRange();
    r.setStart(f, 0);
    try { r.setEnd(node, off); } catch { return te.value.length; }
    return Math.min(textOfDom(r.cloneContents()).length, te.value.length);
  }
  /** The DOM point of a text offset in the field as rendered. */
  function pointAt(i) {
    const f = te.ta;
    if (te.paraMode) {
      const p = PA.paraAt(te.value, i), k = i - PA.paragraphStarts(te.value)[p];
      const div = f.children[p];
      if (!div) return [f, f.childNodes.length];
      const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      let n = 0, t, last = null;
      while ((t = w.nextNode())) { last = t; if (k <= n + t.length) return [t, k - n]; n += t.length; }
      return last ? [last, last.length] : [div, 0];
    }
    const end = f.querySelector("br[data-end]");
    if (end && i >= te.value.length) return [f, Array.prototype.indexOf.call(f.childNodes, end)];
    const w = document.createTreeWalker(f, NodeFilter.SHOW_TEXT);
    let n = 0, t, last = null;
    while ((t = w.nextNode())) {
      last = t;
      if (i <= n + t.length) return [t, i - n];
      n += t.length;
    }
    return last ? [last, last.length] : [f, 0];
  }
  /** The selection as text offsets: { start, end, back } (back: the focus is before the anchor). */
  function selOf() {
    const s = getSelection();
    if (!te || !s || !s.rangeCount || !te.ta.contains(s.anchorNode) || !te.ta.contains(s.focusNode)) return te ? te.lastSel : { start: 0, end: 0, back: false };
    const a = offsetAt(s.anchorNode, s.anchorOffset), b = offsetAt(s.focusNode, s.focusOffset);
    return (te.lastSel = { start: Math.min(a, b), end: Math.max(a, b), back: b < a });
  }
  function select(a, b = a, back = false) {
    a = Math.max(0, Math.min(a, te.value.length)); b = Math.max(a, Math.min(b, te.value.length));
    te.lastSel = { start: a, end: b, back };
    const s = getSelection();
    if (!s) return;
    const [an, ao] = pointAt(back ? b : a), [fn, fo] = pointAt(back ? a : b);
    try { s.setBaseAndExtent(an, ao, fn, fo); } catch {}
  }
  /** The CSS of a styled range's own metrics (what the canvas draws differently from the layer). */
  function spanCss(s) {
    const o = [];
    if (s.fontFamily) { const p = fontPlan(te.fonts, s.fontFamily); useFonts(p); o.push("font-family:" + p.stack); }
    if (typeof s.fontSize === "number") o.push("font-size:" + s.fontSize + "px");
    if (s.fontWeight !== undefined) o.push("font-weight:" + weightOf(s.fontWeight));
    if (s.fontStyle) o.push("font-style:" + (/italic/i.test(s.fontStyle) ? "italic" : "normal"));
    if (typeof s.letterSpacing === "number") o.push("letter-spacing:" + s.letterSpacing + "px");
    return o.join(";");
  }
  /** Draw the field from the model (keeps nothing of what was in it). */
  function render() {
    if (te.paraMode) { renderParas(); return; }
    const f = te.ta, v = te.value;
    const frag = document.createDocumentFragment();
    const cuts = new Set([0, v.length]);
    for (const s of te.spans) { cuts.add(Math.min(s.start, v.length)); cuts.add(Math.min(s.end, v.length)); }
    const title = titleCuts(v, 0, v.length, cuts);
    const at = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i + 1 < at.length; i++) {
      if (at[i + 1] <= at[i]) continue;
      const el = document.createElement("span");
      const s = te.spans.find((x) => x.start <= at[i] && x.end >= at[i + 1]);
      el.style.cssText = (s ? spanCss(s) : "") + (title.has(at[i]) ? ";text-transform:uppercase" : "");
      el.textContent = v.slice(at[i], at[i + 1]);
      frag.appendChild(el);
    }
    // An empty text, or one ending in a new line, still takes its last line (as the caret does).
    if (v === "" || v.endsWith("\n")) { const br = document.createElement("br"); br.dataset.end = ""; frag.appendChild(br); }
    f.replaceChildren(frag);
  }
  /** The letters [a, b) as spans with their ranges' metrics. */
  function runsInto(parent, v, a, b) {
    const cuts = new Set([a, b]);
    for (const s of te.spans) { if (s.start > a && s.start < b) cuts.add(s.start); if (s.end > a && s.end < b) cuts.add(s.end); }
    const title = titleCuts(v, a, b, cuts);
    const at = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i + 1 < at.length; i++) {
      if (at[i + 1] <= at[i]) continue;
      const el = document.createElement("span");
      const s = te.spans.find((x) => x.start <= at[i] && x.end >= at[i + 1]);
      el.style.cssText = (s ? spanCss(s) : "") + (title.has(at[i]) ? ";text-transform:uppercase" : "");
      el.textContent = v.slice(at[i], at[i + 1]);
      parent.appendChild(el);
    }
  }
  /**
   * Letter case in the field. Title case: each word's first letter in [a, b) gets a span of its own drawn in upper
   * case (the engine's word rule, src/page/text-paras.js wordStarts; CSS capitalize reads words differently in Chrome
   * and WebKit). Upper and lower case: a letter whose other case is longer ("ß" is "SS") gets a span of its own, as
   * WebKit maps the offsets after such a letter in the same text node a letter off (the caret and selection drift).
   * Adds the edges to `cuts`; returns the title-case starts.
   */
  function titleCuts(v, a, b, cuts) {
    const lc = te.para.letterCase;
    if (lc !== "title" && lc !== "upper" && lc !== "lower") return new Set();
    if (te.caseOf !== v + "\u0000" + lc) {
      te.caseOf = v + "\u0000" + lc;
      if (lc === "title") te.caseAt = PA.wordStarts(v);
      else {
        te.caseAt = [];
        for (let i = 0; i < v.length;) {
          const ch = String.fromCodePoint(v.codePointAt(i));
          if ((lc === "upper" ? ch.toUpperCase() : ch.toLowerCase()).length !== ch.length) te.caseAt.push(i);
          i += ch.length;
        }
      }
    }
    const out = new Set();
    for (const w of te.caseAt) {
      if (w < a || w >= b) continue;
      const end = Math.min(b, w + (v.codePointAt(w) > 0xffff ? 2 : 1));
      cuts.add(w); cuts.add(end);
      if (lc === "title") out.add(w);
    }
    return out;
  }
  /** Paragraph mode: a block per paragraph, laid out by the engine's rules (src/page/text-paras.js paragraphPlan). */
  function renderParas() {
    const f = te.ta, v = te.value;
    const plan = PA.paragraphPlan({ ...te.para, lists: te.lists }, v, te.para.size);
    const starts = PA.paragraphStarts(v);
    const frag = document.createDocumentFragment();
    starts.forEach((a, p) => {
      const b = p + 1 < starts.length ? starts[p + 1] - 1 : v.length;
      const pl = plan[p];
      const div = document.createElement("div");
      div.style.cssText = "margin-top:" + pl.before + "px;padding-left:" + pl.rest + "px;text-indent:" + (pl.first - pl.rest) + "px";
      if (b > a && pl.hang) {
        // A hanging opening quote: its own span, measured once the field is drawn; the line starts its width further left.
        runsInto(div, v, a, a + 1);
        div.dataset.hang = String(pl.first - pl.rest);
        runsInto(div, v, a + 1, b);
      } else if (b > a) runsInto(div, v, a, b);
      else { const br = document.createElement("br"); br.dataset.end = ""; div.appendChild(br); }
      frag.appendChild(div);
    });
    f.replaceChildren(frag);
    fixHangs();
  }
  /** Each hanging quote's paragraph starts the quote's width further left: measured once the field is laid out in its
   *  fonts (render, and every frame while it changes: a font that loads later changes the width). */
  function fixHangs() {
    if (!te || !te.paraMode) return;
    for (const div of te.ta.querySelectorAll("div[data-hang]")) {
      const w = quoteWidth(div.firstChild);
      if (!(w > 0)) continue;
      const v = Number(div.dataset.hang) - w + "px";
      if (div.dataset.ti !== v) { div.dataset.ti = v; div.style.textIndent = v; }
    }
  }
  /** How wide a hanging quote's span is drawn, in the field's own px (the field is scaled and turned with the camera). */
  function quoteWidth(span) {
    if (!span) return 0;
    // Unturned: the quote as the field draws it, divided by the camera's zoom (the field is scaled with it).
    const z = host.cam && host.cam.z;
    if (!te.rot && z > 0) return span.getBoundingClientRect().width / z;
    // Turned: a copy in the same font, off the canvas.
    const cs = getComputedStyle(span);
    const m = document.createElement("span");
    m.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden;white-space:pre";
    for (const k of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "fontFeatureSettings", "textTransform", "fontKerning", "fontVariationSettings", "fontOpticalSizing"]) m.style[k] = cs[k];
    m.textContent = span.textContent;
    document.body.appendChild(m);
    const w = m.getBoundingClientRect().width;
    m.remove();
    return w;
  }
  /** Paragraph mode is on when the layer has paragraph settings or lists (and stays on for the rest of the edit). */
  function syncParaMode() {
    const on = te.paraMode || PA.hasParagraphs({ ...te.para, lists: te.lists });
    if (on === te.paraMode) return false;
    te.paraMode = on;
    return true;
  }
  /** New lists (Tab, Shift+Tab, Shift+Cmd+7/8, Return on an empty item): one step, the field drawn again. */
  function setLists(next, sel = selOf()) {
    if (JSON.stringify(next) === JSON.stringify(te.lists)) return;
    te.hist.begin(stateOf(), "lists", performance.now());
    te.lists = next;
    syncParaMode();
    render();
    select(sel.start, sel.end, sel.back);
    te.touched = true;
    te.hist.end(stateOf());
    changed();
  }
  /** Replace the letters [a, b) with `text`: one model edit (styled ranges follow), the field drawn again. */
  function edit(a, b, text, kind) {
    const before = stateOf();
    te.hist.begin(before, kind, performance.now());
    const old = te.value;
    te.value = te.value.slice(0, a) + text + te.value.slice(b);
    te.spans = SP.normalize(SP.shift(te.spans, a, b - a, text.length), te.value.length, te.base);
    if (te.lists.length) te.lists = PA.shiftLists(te.lists, old, a, b - a, text);
    if (!patchField(te, old, a, b, text)) render(); // a plain field takes the change in place (text-patch.js)
    select(a + text.length);
    te.touched = true;
    te.hist.end(stateOf());
    // Typed list starts: "- ", "* ", "1. " at a paragraph's start; its own step, so Cmd+Z gives the letters back.
    if (text === " " && kind === "insert") {
      const auto = PA.autoList(te.lists, te.value, a + 1);
      if (auto) {
        te.hist.begin(stateOf(), "lists", performance.now());
        const cut = a + 1 - auto.caret;
        te.spans = SP.normalize(SP.shift(te.spans, auto.caret, cut, 0), auto.value.length, te.base);
        te.value = auto.value;
        te.lists = auto.lists;
        syncParaMode();
        render();
        select(auto.caret);
        te.hist.end(stateOf());
      }
    }
    changed();
  }
  /** A text style on the selected letters (all of them with only a caret): the style keys and the inspector. */
  function restyle(fn) {
    if (!te) return;
    const sel = selOf();
    const [a, b] = sel.start === sel.end ? [0, te.value.length] : [sel.start, sel.end];
    const before = stateOf();
    const next = fn(a, b);
    if (JSON.stringify(next) === JSON.stringify(te.spans)) return;
    te.hist.begin(before, "style", performance.now());
    te.spans = next;
    render();
    select(sel.start, sel.end, sel.back);
    te.touched = true;
    te.hist.end(stateOf());
    changed();
  }
  function styleKey(what) {
    if (what.startsWith("leading")) {
      // Line height is the layer's (one per paragraph in Canvas): written now, its own undo step.
      const p = typeStep(te.base, what);
      if (p && !te.id.includes("/")) {
        const w = fetch("/api/update", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file, id: te.id, props: p }) });
        if (host.trackWrite) host.trackWrite(w);
      }
      return;
    }
    restyle((a, b) => styleStep(te.spans, a, b, te.base, te.value.length, what));
  }
  /** The inspector's edit while letters are selected (Model.swift sends {cmd: "textStyle", props}). */
  function styleProps(props) {
    const set = {};
    for (const [k, v] of Object.entries(props || {})) {
      if (!SP.SPAN_KEYS.includes(k)) continue;
      // The inspector writes a fill as a colour or a list of paints: a range takes its first solid colour.
      if (k === "fill") set.fill = typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v) ? v : caretOf({ fill: v });
      else set[k] = v;
    }
    if (Object.keys(set).length) restyle((a, b) => SP.apply(te.spans, a, b, set, te.value.length, te.base));
  }
  // The selected letters' style, for the inspector (Mixed where they differ).
  let rangeTimer = 0;
  function postRange() {
    if (!host.native || !te) return;
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(() => {
      if (!te) return;
      const s = te.lastSel;
      host.post({ textRange: { id: te.id, start: s.start, end: s.end, style: SP.styleAt(te.spans, s.start, s.end, te.base, te.value.length) } });
    }, 30);
  }

  function styleFrom(node, scene) {
    const plan = fontPlan(scene.fonts, node.fontFamily);
    const loading = useFonts(plan);
    const css = textCss(node, plan.stack);
    te.fonts = scene.fonts;
    const base = { fontFamily: node.fontFamily || "Inter", fontSize: typeof node.fontSize === "number" ? node.fontSize : DEFAULT_SIZE, fontWeight: node.fontWeight === undefined ? "400" : String(node.fontWeight), fontStyle: /italic/i.test(String(node.fontStyle || "")) ? "italic" : "normal", fill: caretOf(node), underline: node.underline === true, strikethrough: node.strikethrough === true, letterSpacing: typeof node.letterSpacing === "number" ? node.letterSpacing : 0, lineHeight: typeof node.lineHeight === "number" ? node.lineHeight : undefined };
    const changedBase = JSON.stringify(base) !== JSON.stringify(te.base);
    te.base = base;
    // Paragraph settings are the layer's (the inspector writes them while the edit is open): the blocks follow.
    const para = { paragraphSpacing: node.paragraphSpacing, paragraphIndent: node.paragraphIndent, listSpacing: node.listSpacing, hangingList: node.hangingList, hangingPunctuation: node.hangingPunctuation, textAlign: node.textAlign, size: base.fontSize, letterCase: node.letterCase };
    const changedPara = JSON.stringify(para) !== JSON.stringify(te.para);
    te.para = para;
    if ((syncParaMode() || changedPara) && te.ready) { const s = te.lastSel; render(); select(s.start, s.end, s.back); }
    Object.assign(te.ta.style, css, { caretColor: caretOf(node) });
    if (changedBase && te.spans.length && te.ready) { const s = te.lastSel; render(); select(s.start, s.end, s.back); }
    const growth = growthOf(node);
    te.growth = growth;
    te.fixedW = growth === "auto" ? null : typeof node.width === "number" ? node.width : null;
    te.fixedH = growth === "fixed-width-height" && typeof node.height === "number" ? node.height : null;
    te.valign = node.textAlignVertical === "middle" ? "center" : node.textAlignVertical === "bottom" ? "flex-end" : "flex-start";
    te.wrap.style.justifyContent = growth === "fixed-width-height" ? te.valign : "flex-start";
    return loading;
  }

  /** Put the editor over the node: its box from the engine, the camera's zoom, the node's rotation. */
  function place() {
    if (!te) return;
    fixHangs();
    const v = ev(), c = host.cam;
    const r = v && v.rect(te.id);
    if (!r || !c) { te.wrap.style.visibility = "hidden"; return; }
    te.wrap.style.visibility = "";
    // The box the text lays out in (world px): a fixed width wraps there; fill_container takes what layout gave it.
    // Turned text: the engine's bounds are the turned box's, so its own size is worked back from them (the DOM's
    // width is max-content until the first reflow, and wrapped differently from the engine).
    const rot = te.rot;
    const own = rot ? sizeFromBounds(r, rot) : null;
    let w = te.fixedW, h = te.fixedH;
    if (te.growth !== "auto" && w === null) w = rot ? (own ? own.w : te.wrap.offsetWidth || r.w) : r.w;
    if (te.growth === "fixed-width-height" && h === null) h = rot ? (own ? own.h : te.wrap.offsetHeight || r.h) : r.h;
    te.wrap.style.width = w === null ? "max-content" : w + "px";
    te.wrap.style.height = h === null ? "auto" : h + "px";
    te.tb.style.width = w === null ? "auto" : "100%";
    const ow = w === null ? te.wrap.offsetWidth : w, oh = h === null ? te.wrap.offsetHeight : h;
    const o = originFromBounds(r, ow, oh, rot);
    const vb = host.viewBox || { l: 0, t: 0 };
    const sx = vb.l + c.x + o.x * c.z, sy = vb.t + c.y + o.y * c.z;
    te.wrap.style.transform = "translate(" + sx + "px," + sy + "px) scale(" + c.z + ")" + (rot ? " rotate(" + -rot + "deg)" : "");
    const key = r.x + "," + r.y + "," + r.w + "," + r.h;
    if (key !== te.rectKey) { te.rectKey = key; host.syncSel(); }
  }
  function loop() {
    raf = 0;
    if (!te) return;
    place();
    raf = requestAnimationFrame(loop);
  }

  const stateOf = () => { const s = selOf(); return { value: te.value, start: s.start, end: s.end, spans: te.spans, lists: te.lists }; };
  /** What the canvas draws while typing (and the write sends): content, and ranges and lists when there are any. */
  /** What another layer of a multi-edit shows: the typed text with its own ranges and lists, followed as the server does (src/textedit.ts editMany). */
  function otherTyped(t, id) {
    const w = t.alsoWas && t.alsoWas.get(id);
    if (!w) return { content: t.value };
    const o = { content: t.value };
    if (w.spans.length) o.spans = SP.follow(w.spans, w.content, t.value);
    if (w.lists.length) o.lists = PA.followLists(w.lists, w.content, t.value);
    return o;
  }
  function typedOf(t) {
    const o = { content: t.value };
    if (t.spans.length || t.origSpans.length) o.spans = t.spans;
    if (t.lists.length || t.origLists.length) o.lists = t.lists;
    return o;
  }
  function changed() {
    if (!te) return;
    host.emit('presence', {editing:{id:te.id,text:te.value.slice(0,512)}});
    const typed = typedOf(te);
    // Truncated text shows whole while it is edited; the ellipsis comes back when the edit ends.
    live().pin(te.id, te.truncated ? { ...typed, textTruncation: "disabled" } : typed);
    // Multi-edit: the other selected text layers show the same text as it is typed.
    for (const id of te.also) live().pin(id, te.touched ? otherTyped(te, id) : {});
    place();
    postRange();
  }
  function step(dir) {
    if (!te) return false;
    const s = dir === "redo" ? te.hist.redo(stateOf()) : te.hist.undo(stateOf());
    if (!s) return true;
    te.value = s.value;
    te.spans = s.spans || [];
    te.lists = s.lists || [];
    syncParaMode();
    render();
    select(s.start, s.end);
    // Typed or styled while there is still a step to undo: undone back to where the edit began, the other
    // layers of a multi-edit keep their own text.
    te.touched = te.hist.undos.length > 0;
    changed();
    return true;
  }

  /**
   * Start editing text layer `id`. o: { at: {x, y} (window px: the caret goes there), word (select the word there),
   * all (select all the text) }.
   */
  async function enter(id, o = {}) {
    if (host.readOnly) return false;
    if (te) { if (te.id === id) return true; commit("switch"); }
    if (host.renderer !== "engine") { tell("Editing text in place needs the GPU renderer"); return false; }
    let inf = nodeInfo(id);
    if (inf && inf.pending) { await ev().fetchScene(inf.board); inf = nodeInfo(id); }
    if (!inf || !inf.node) return false;
    // Text bound to a string variable: typing over it would replace the binding with plain text.
    if (typeof inf.node.contentVar === "string") { tell("This text comes from the variable " + inf.node.contentVar + "; edit the variable to change it"); return false; }
    const also = Array.isArray(o.also) ? o.also.filter((x) => x !== id && nodeInfo(x) && nodeInfo(x).node) : [];
    if (!also.length && (host.sel !== id || (host.selection && host.selection().length > 1))) host.selectId(id);
    if (te) return false;
    const { board, scene, node } = inf;
    const original = typeof node.content === "string" ? node.content : node.content === undefined || node.content === null ? "" : String(node.content);
    const origSpans = SP.normalize(Array.isArray(node.spans) ? node.spans : [], original.length);
    const origLists = PA.normalizeLists(node.lists, PA.paragraphCount(original));
    const wrap = document.createElement("div");
    wrap.id = "textEdit";
    wrap.className = "loading";
    const tb = document.createElement("div");
    tb.className = "tb";
    wrap.appendChild(tb);
    const ta = document.createElement("div");
    ta.className = "f";
    for (const [k, v] of Object.entries({ contenteditable: "plaintext-only", spellcheck: "false", autocomplete: "off", autocorrect: "off", autocapitalize: "off", role: "textbox", "aria-multiline": "true", "aria-label": "Text" })) ta.setAttribute(k, v);
    tb.appendChild(ta);
    // The field holds the text and has focus from the start: an edit ended (Esc, a click away, another file)
    // while the fonts still load ends with the text as it was, never empty (which deleted the layer), and keys
    // typed meanwhile land in it.
    te = { id, also, board, original, origSpans, origLists, lists: origLists, para: {}, paraMode: false, value: original, spans: origSpans, base: null, fonts: [], lastSel: { start: original.length, end: original.length, back: false }, wrap, tb, ta, rot: inf.rot, hist: new TextHistory(), growth: "auto", fixedW: null, fixedH: null, rectKey: "", ready: false, touched: false };
    // Multi-edit: each other layer as it was, so it shows (and keeps) its own styling mapped to the typed text.
    te.alsoWas = new Map(also.map((x) => { const n = nodeInfo(x).node; return [x, { content: typeof n.content === "string" ? n.content : "", spans: Array.isArray(n.spans) ? n.spans : [], lists: Array.isArray(n.lists) ? n.lists : [] }]; }));
    const loading = styleFrom(node, scene);
    render();
    document.body.appendChild(wrap);
    hook(ta);
    ta.focus({ preventScroll: true });
    select(o.all ? 0 : original.length, original.length);
    te.hist.end(stateOf());
    te.truncated = node.textTruncation === "ending";
    changed();
    if (selBox) selBox.classList.add("editing");
    if (host.native) host.post({ textEditing: true });
    if (loading) await Promise.race([loading, new Promise((r) => setTimeout(r, 400))]);
    if (!te || te.wrap !== wrap) return false;
    te.ready = true;
    wrap.classList.remove("loading");
    place();
    // Where the click was, in the text (the field lays its letters out where the canvas draws them). Not when keys
    // typed meanwhile already moved the caret.
    if (o.at && !te.touched) {
      const hit = document.caretRangeFromPoint ? document.caretRangeFromPoint(o.at.x, o.at.y) : null;
      const pos = !hit && document.caretPositionFromPoint ? document.caretPositionFromPoint(o.at.x, o.at.y) : null;
      const nodeHit = hit ? hit.startContainer : pos ? pos.offsetNode : null, off = hit ? hit.startOffset : pos ? pos.offset : -1;
      if (nodeHit && ta.contains(nodeHit)) {
        const at = offsetAt(nodeHit, off);
        if (o.word) { const [a, b] = wordRange(te.value, at); select(a, b); }
        else select(at);
        te.hist.end(stateOf());
      }
    }
    if (document.activeElement !== ta) { ta.focus({ preventScroll: true }); select(te.lastSel.start, te.lastSel.end, te.lastSel.back); }
    postRange();
    if (!raf) raf = requestAnimationFrame(loop);
    return true;
  }

  function hook(ta) {
    // An IME composition runs in the field as the browser does it; the model reads it back when it ends.
    let composing = null; // the state before the composition
    const mine = () => te && te.ta === ta;
    const rangeOffsets = (r) => [offsetAt(r.startContainer, r.startOffset), offsetAt(r.endContainer, r.endOffset)];
    ta.addEventListener("beforeinput", (e) => {
      if (!mine()) return;
      const t = e.inputType;
      if (t === "historyUndo" || t === "historyRedo") { e.preventDefault(); step(t === "historyRedo" ? "redo" : "undo"); return; }
      if (t === "insertCompositionText" || e.isComposing || composing) {
        if (!composing) { composing = stateOf(); te.hist.begin(composing, "compose", performance.now()); }
        return;
      }
      const sel = selOf();
      let a = sel.start, b = sel.end, text = "";
      // A list item: Return on an empty one takes it a level out (off the list at the first level); Backspace at its
      // start takes its marker off.
      if (te.lists.length && a === b && (t === "insertParagraph" || t === "insertLineBreak" || t === "deleteContentBackward")) {
        const p = PA.paraAt(te.value, a), st = PA.paragraphStarts(te.value)[p], item = PA.listAt(te.lists, p);
        const end = p + 1 < PA.paragraphCount(te.value) ? PA.paragraphStarts(te.value)[p + 1] - 1 : te.value.length;
        if (item && a === st && (t === "deleteContentBackward" || end === st)) {
          e.preventDefault();
          // Backspace: the marker goes and the indent stays; again, a level out at a time.
          setLists(t === "deleteContentBackward" ? PA.unmark(te.lists, p) : PA.nestList(te.lists, te.value, a, a, -1), sel);
          return;
        }
      }
      const rs = e.getTargetRanges ? e.getTargetRanges() : [];
      if (t === "insertText") text = e.data ?? "";
      else if (t === "insertReplacementText" || t === "insertFromPaste" || t === "insertFromDrop" || t === "insertFromYank") {
        text = (e.dataTransfer && e.dataTransfer.getData("text/plain")) || e.data || "";
        if (rs.length) [a, b] = rangeOffsets(rs[0]);
      } else if (t === "insertParagraph" || t === "insertLineBreak") text = "\n";
      else if (t.startsWith("delete")) {
        if (rs.length) [a, b] = rangeOffsets(rs[0]);
        // No range from the browser: one whole character as people see it (a flag, a ZWJ family, a skin tone).
        else if (a === b && t === "deleteContentBackward") a = clusterBefore(te.value, a);
        else if (a === b && t === "deleteContentForward") b = clusterAfter(te.value, b);
        if (a === b && !rs.length) { e.preventDefault(); return; }
      } else { e.preventDefault(); return; } // formatting and the like: plain text only
      e.preventDefault();
      edit(Math.min(a, b), Math.max(a, b), text.replace(/\r\n?/g, "\n"), inputKind(t));
    });
    ta.addEventListener("input", (e) => {
      if (!mine()) return;
      // During a composition: what it has so far shows on the canvas; the field stays the browser's.
      // The styled ranges follow it from where the composition began, so a commit before it ends (a click away)
      // writes ranges that fit the text.
      if (composing || e.isComposing) {
        const now = textOfDom(ta), from = composing || { value: te.value, spans: te.spans };
        te.spans = SP.normalize(SP.follow(from.spans || [], from.value, now), now.length, te.base);
        te.value = now;
        te.touched = true;
        changed();
        return;
      }
      // The field changed with no beforeinput this handled (an engine without it, a spelling fix): read it back.
      const now = textOfDom(ta);
      if (now === te.value) return;
      const before = { value: te.value, start: te.lastSel.start, end: te.lastSel.end, spans: te.spans };
      te.hist.begin(before, "other", performance.now());
      const sel = selOf();
      te.spans = SP.normalize(SP.follow(te.spans, te.value, now), now.length, te.base);
      if (te.lists.length) te.lists = PA.followLists(te.lists, te.value, now);
      te.value = now;
      render();
      select(sel.start, sel.end);
      te.touched = true;
      te.hist.end(stateOf());
      changed();
    });
    ta.addEventListener("compositionend", () => {
      if (!mine() || !composing) return;
      const before = composing;
      composing = null;
      const now = textOfDom(ta);
      const sel = selOf();
      te.value = now;
      te.spans = SP.normalize(SP.follow(before.spans || [], before.value, now), now.length, te.base);
      te.lists = PA.followLists(before.lists || [], before.value, now);
      render();
      select(sel.start, sel.end);
      te.touched = true;
      te.hist.end(stateOf());
      te.hist.endComposition();
      changed();
    });
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation(); // no canvas key handler hears a key typed here
      const k = keyIntent(e, host.native);
      if (!k || k === "compose") return; // the field's own, or the IME's while it composes
      e.preventDefault();
      if (k === "commit") commit("key");
      else if (k === "tab" || k === "swallow") {
        // In a list item Tab nests it a level deeper and Shift+Tab a level out.
        const s = selOf();
        const [pa, pb] = PA.parasIn(te.value, s.start, s.end);
        if (te.lists.some((l) => l.p >= pa && l.p <= pb)) setLists(PA.nestList(te.lists, te.value, s.start, s.end, k === "tab" ? 1 : -1), s);
        else if (k === "tab") edit(s.start, s.end, "\t", "other");
      }
      else if (k.startsWith("list:")) { const s = selOf(); setLists(PA.toggleList(te.lists, te.value, s.start, s.end, k.slice(5)), s); }
      else if (k === "selectAll") select(0, te.value.length);
      else if (k.startsWith("style:")) styleKey(k.slice(6));
      else step(k);
    });
    ta.addEventListener("keyup", (e) => e.stopPropagation());
    // Plain text only, whatever the clipboard holds.
    ta.addEventListener("paste", (e) => {
      const t = e.clipboardData && e.clipboardData.getData("text/plain");
      e.stopPropagation();
      e.preventDefault();
      // No text (only an image, say): nothing to paste, and the selected letters stay.
      if (typeof t !== "string" || !t || !mine()) return;
      const s = selOf();
      edit(s.start, s.end, t.replace(/\r\n?/g, "\n"), "other");
    });
    // Copy and cut: the plain letters (a cut's delete comes as beforeinput deleteByCut).
    ta.addEventListener("copy", (e) => {
      e.stopPropagation();
      if (!mine() || !e.clipboardData) return;
      const s = selOf();
      e.preventDefault();
      e.clipboardData.setData("text/plain", te.value.slice(s.start, s.end));
    });
    ta.addEventListener("cut", (e) => {
      e.stopPropagation();
      if (!mine() || !e.clipboardData) return;
      const s = selOf();
      e.preventDefault();
      e.clipboardData.setData("text/plain", te.value.slice(s.start, s.end));
      if (s.end > s.start) edit(s.start, s.end, "", "other");
    });
    for (const n of ["pointerdown", "pointerup", "mousedown", "click", "dblclick", "contextmenu"]) ta.addEventListener(n, (e) => e.stopPropagation());
    // The wheel still pans and zooms the canvas under the editor.
    te.wrap.addEventListener("wheel", (e) => {
      e.preventDefault();
      view.dispatchEvent(new WheelEvent("wheel", { deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true }));
    }, { passive: false });
  }

  function teardown() {
    if(te) host.emit('presence', {editing:null});
    const t = te;
    te = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!t) return null;
    if (selBox) selBox.classList.remove("editing");
    const focused = document.activeElement === t.ta;
    t.wrap.remove();
    if (focused && document.body) { try { document.body.focus({ preventScroll: true }); } catch {} }
    if (host.native) host.post({ textEditing: false, textRange: null });
    return t;
  }
  /** Leave without writing. `gone`: the layer went away under the edit (deleted, by an agent say): say so. */
  function cancel(gone) {
    const t = teardown();
    if (!t) return;
    live().unpin(t.id);
    for (const id of t.also) live().unpin(id);
    if (gone) lose(t.value !== t.original ? "The text was deleted while you typed" : "The text was deleted", t.value !== t.original ? t.value : "");
  }
  /**
   * End the edit: one write, one undo step (or none when nothing changed). False when the text cannot be saved
   * (too long): the editor stays open with a message. o.keepalive: the page is going away (pagehide).
   */
  function commit(why, o = {}) {
    if (!te) return true;
    const value = te.value;
    if (value.length > MAX_TEXT) {
      tell("This text is too long to save (" + value.length.toLocaleString("en-US") + " characters, the most is " + MAX_TEXT.toLocaleString("en-US") + "); shorten it, or press Cmd+Z");
      return false;
    }
    const L = live();
    // What the canvas showed under the typing: an agent may have written this text since the edit began.
    const under = L.underPin ? L.underPin(te.id) : null;
    const t = teardown();
    const plan = commitPlan(t.original, value, t.id, t.origSpans, t.spans, t.origLists, t.lists);
    // Multi-edit: the others take the text only when something was typed or styled.
    const also = t.touched ? t.also : [];
    if (plan.kind === "none" && !also.length) { L.unpin(t.id); for (const id of t.also) L.unpin(id); host.syncSel(); return true; }
    const agentMoved = !!under && typeof under.content === "string" && under.content !== t.original;
    const op = L.nextOp();
    // The canvas keeps what was typed (an override settled by the write's answer) from the next frame on.
    const typed = typedOf(t);
    for (const id of [t.id, ...also]) L.override(id, plan.kind === "delete" ? { enabled: false } : id === t.id ? typed : otherTyped(t, id), op);
    L.unpin(t.id);
    for (const id of t.also) L.unpin(id);
    if (plan.kind === "delete" && host.sel === t.id) host.clearSel();
    else host.syncSel();
    const body = JSON.stringify(plan.kind === "delete" ? { file, id: t.id, content: "", ...(also.length ? { also } : {}) } : { file, id: t.id, ...typed, ...(also.length ? { also } : {}) });
    // keepalive lets the write outlive the page (a reload, a closed tab); browsers take only 64 KB that way.
    const keepalive = !!o.keepalive && body.length < 60_000;
    const p = fetch("/api/text", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body, keepalive })
      .then((r) => r.json().then((j) => { if (!r.ok) { const e = new Error(j.error || r.statusText); e.code = j.code; throw e; } return j; }))
      .then((j) => {
        for (const id of [t.id, ...also]) L.ack(id, op, true);
        // A layer the server kept (a replacement inside an instance takes an empty override, never a delete).
        if (plan.kind === "delete" && !j.deleted && !host.sel) host.selectId(t.id);
        if (agentMoved) tell("An agent changed this text while you typed; your text replaced theirs (Undo brings theirs back)");
        return true;
      })
      .catch((err) => {
        for (const id of [t.id, ...also]) L.ack(id, op, false);
        const typed = plan.kind === "write" ? plan.content : "";
        if (err.code === "not_found") lose(typed ? "The text was deleted while you typed" : "The text was deleted", typed);
        else lose((/component|variable/.test(err.message) ? "" : "Could not save the text: ") + err.message, typed);
        if (plan.kind === "delete" && !host.sel && err.code !== "not_found") host.selectId(t.id);
        return false;
      });
    inflight.add(p);
    p.then(() => inflight.delete(p));
    // Undo and Redo wait for it (src/server.ts trackWrite): an Undo pressed right after Esc must undo this edit.
    if (host.trackWrite) host.trackWrite(p);
    void why;
    return true;
  }
  /** End the edit if one is open and wait for every text write: true once all are saved. The app calls it before
   * it loads another page or quits (apps/macos/Model.swift flushTextEdit). */
  function flush() {
    if (te && commit("flush") === false) return Promise.resolve(false);
    return Promise.all([...inflight]).then((rs) => rs.every(Boolean));
  }

  /** Focus back on the field, with the letters that were selected in it. */
  function refocus() {
    if (!te) return false;
    if (document.activeElement !== te.ta) { const s = te.lastSel; te.ta.focus({ preventScroll: true }); select(s.start, s.end, s.back); }
    return true;
  }
  // The selection the inspector shows the style of; also kept for when focus goes elsewhere.
  document.addEventListener("selectionchange", () => { if (te && document.activeElement === te.ta) { selOf(); postRange(); } });
  host.on("cmd", (c) => { if (c && c.cmd === "textStyle" && te) styleProps(c.props); });
  host.on("cmd", (c) => { if (c && c.cmd === "textList" && te && (c.type === "bullet" || c.type === "number")) { const s = te.lastSel; setLists(PA.toggleList(te.lists, te.value, s.start, s.end, c.type), s); } });

  // The scene the canvas draws changed (a server redraw, an inspector edit): the editor follows its style.
  live().onScene((board, scene) => {
    if (!te || board !== te.board) return;
    const path = pathTo(scene.root, te.id);
    const node = path && path[path.length - 1];
    if (!node || node.type !== "text") { setTimeout(() => { if (te && !nodeInfo(te.id)) cancel(true); }, 0); return; }
    te.rot = rotationOf(path);
    styleFrom(node, scene);
  });

  // ---------- ways in ----------
  // Double-click a text layer: edit it with the word under the pointer selected.
  view.addEventListener("dblclick", (e) => {
    if (e.defaultPrevented || host.hand) return;
    const id = host.pick(e.clientX, e.clientY);
    if (!id || (host.live && host.live.busy)) return;
    // A double-click goes one level in (its two clicks did that); it edits the text once that reached it.
    if (host.pickSelectable && host.sel !== id) return;
    // A double-click that drilled down to this text layer only selects it; the next double-click edits it.
    if (!dblClickEdits(id, host.dblSel === undefined ? null : host.dblSel)) return;
    const inf = nodeInfo(id);
    if (!inf || (!inf.node && !inf.pending)) return;
    e.preventDefault();
    enter(id, { at: { x: e.clientX, y: e.clientY }, word: true });
  });
  addEventListener("keydown", (e) => {
    if (te) {
      // Focus left the editor (a click in the app's inspector, say): canvas keys stay off until the edit ends.
      // The key itself goes on to the editor, which takes focus now (it is not swallowed).
      if (e.target !== te.ta && !typing(e.target) && !e.metaKey && !e.ctrlKey) {
        e.stopImmediatePropagation();
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape") { e.preventDefault(); commit("key"); return; }
        if (e.key === "Tab") e.preventDefault();
        refocus();
      }
      return;
    }
    // Enter on a selected text layer: edit it, all its text selected.
    if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || typing(e.target)) return;
    const ids = host.selection ? host.selection() : [];
    // Several text layers (multi-edit): the one selected first is edited, the rest take what is typed.
    const main = ids.includes(host.sel) ? host.sel : ids[0];
    if (!main || ids.length > 500 || (ids.length === 1 && ids[0] !== host.sel)) return;
    const infos = ids.map((id) => nodeInfo(id));
    if (!infos.every((inf) => inf && inf.node)) return;
    if (ids.length > 1 && infos.some((inf) => typeof inf.node.contentVar === "string")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    enter(main, { all: true, also: ids.filter((id) => id !== main) });
  }, true);
  // A press anywhere else ends the edit; the press then does what it does (select, pan, deselect). A plain press on
  // another text layer edits that one at once, the caret where it was pressed, and goes no further.
  addEventListener("pointerdown", (e) => {
    if (!te || te.wrap.contains(e.target)) return;
    const onCanvas = e.target === view || view.contains(e.target);
    const leaf = onCanvas && host.pick ? host.pick(e.clientX, e.clientY) : null;
    const inf = leaf && leaf !== te.id ? nodeInfo(leaf) : null;
    const next = nextEdit({ editing: te.id, leaf, isText: !!(inf && inf.node && typeof inf.node.contentVar !== "string"), button: e.button, shift: e.shiftKey, meta: e.metaKey || e.ctrlKey, alt: e.altKey, hand: !!host.hand });
    if (commit("outside") === false || !next) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    enter(next, { at: { x: e.clientX, y: e.clientY } });
  }, true);
  // The page goes away (reload, another file, a closed tab): the typing is written on the way out.
  addEventListener("pagehide", () => { if (te) commit("pagehide", { keepalive: true }); });
  host.on("cmd", (c) => { if (c.cmd === "editText" && typeof c.id === "string") enter(c.id, { all: true }); });

  host.textEdit = {
    get active() { return !!te; },
    get id() { return te ? te.id : null; },
    step, enter, commit: () => commit("api"), cancel: () => cancel(false), flush,
    /** Focus back on the editor (the app's Edit menu after a click on one of its own controls). */
    focus: refocus,
    get value() { return te ? te.value : null; },
    /** The styled ranges as they are now, and the letters selected (tests, the app's inspector). */
    get spans() { return te ? te.spans : null; },
    /** The paragraphs' list items as they are now (tests, the app's inspector). */
    get lists() { return te ? te.lists : null; },
    /** Bulleted or numbered on the selected paragraphs (the inspector's List style while editing). */
    list: (type) => { if (te) { const s = selOf(); setLists(PA.toggleList(te.lists, te.value, s.start, s.end, type), s); } },
    get selection() { return te ? { ...te.lastSel } : null; },
    select: (a, b) => { if (te) { refocus(); select(a, b); } },
    style: (what) => { if (te) styleKey(what); },
    setStyle: (props) => { if (te) styleProps(props); },
  };
}

if (typeof window !== "undefined" && window.canvasHost) attach(window.canvasHost);
