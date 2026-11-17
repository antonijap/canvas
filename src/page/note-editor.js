// The note widget's writing surface: one contenteditable element that shows the note's blocks (note-doc.js) the
// same way whether it is being edited or not, so double-clicking never moves a line. Native editing handles typing
// and the caret inside a block; everything that changes structure (Enter, Backspace at a block's start, Tab,
// Markdown shortcuts, paste, marks, undo) goes through the pure functions in note-doc.js and a re-render.
// Nothing from the clipboard or the stored text ever goes through innerHTML.

import * as D from "./note-doc.js";

const MAX_UNDO = 200;
const EMPTY_HINT = "Double-click to write";
const BLOCK_HINT = { p: "Type # for a heading or - for a list", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", ul: "List", ol: "List", todo: "To-do", quote: "Quote" };
const INLINE_TAGS = new Set(["STRONG", "B", "EM", "I", "S", "STRIKE", "DEL", "CODE", "A", "BR"]);

/**
 * opts: { save(markdown) (debounced by the caller), flush() (sends a pending save now), onEditEnd() }.
 * Returns { el, show(markdown), begin(clientX, clientY), end(), editing() }.
 */
export function noteEditor(opts) {
  const root = document.createElement("div");
  root.className = "nd";
  root.setAttribute("aria-label", "Note text");
  root.setAttribute("role", "textbox");
  root.setAttribute("aria-multiline", "true");
  let editing = false;
  let shownMd = null;
  let undo = [], redo = [];
  let lastTypeAt = 0, lastTypeKind = "";
  let plainNext = 0;

  // ---------- render ----------
  function inlineNode(r) {
    let n = document.createTextNode(r.text);
    const wrap = (tag) => { const e = document.createElement(tag); e.append(n); n = e; };
    if (r.c) wrap("code");
    if (r.s) wrap("s");
    if (r.i) wrap("em");
    if (r.b) wrap("strong");
    if (r.href) { wrap("a"); n.setAttribute("href", r.href); n.title = r.href; n.rel = "noopener noreferrer"; }
    return n;
  }
  function blockEl(b, n) {
    const el = document.createElement("div");
    el.className = "nb";
    el.dataset.t = b.type;
    if (D.LIST.has(b.type)) {
      el.style.setProperty("--in", String(b.indent || 0));
      el.dataset.lvl = String((b.indent || 0) % 3);
    }
    if (b.type === "ol") el.dataset.n = D.label(n, b.indent || 0);
    if (b.type === "todo") el.dataset.checked = b.checked ? "true" : "false";
    if (b.type === "hr") { el.contentEditable = "false"; return el; }
    const runs = D.norm(b.runs);
    // A paragraph that is all code (a pasted code fence, one line per block) shows as a code block.
    if (b.type === "p" && runs.length && runs.every((r) => r.c)) el.dataset.code = "";
    for (const r of runs) el.append(inlineNode(r));
    if (!el.firstChild) el.append(document.createElement("br"));
    return el;
  }
  function render(doc) {
    const nums = D.numbers(doc);
    root.replaceChildren(...doc.map((b, k) => blockEl(b, nums[k])));
    decorate();
  }
  /** Placeholder and overflow state; cheap, runs after every change. */
  function decorate() {
    const kids = root.children;
    const onlyEmpty = kids.length === 1 && kids[0].dataset.t === "p" && !kids[0].textContent;
    root.classList.toggle("empty", onlyEmpty);
    root.dataset.ph = onlyEmpty && !editing ? EMPTY_HINT : "";
    const at = editing ? caretBlock() : -1;
    for (let k = 0; k < kids.length; k++) {
      const el = kids[k];
      const t = el.dataset.t;
      const hint = t !== "hr" && !el.textContent && (k === at || (!editing && onlyEmpty)) ? (editing ? BLOCK_HINT[t] || "" : EMPTY_HINT) : "";
      if ((el.dataset.ph || "") !== hint) { if (hint) el.dataset.ph = hint; else delete el.dataset.ph; }
    }
    root.classList.toggle("over", !editing && root.scrollHeight > root.clientHeight + 1);
  }
  function renumber() {
    const doc = readDoc();
    const nums = D.numbers(doc);
    [...root.children].forEach((el, k) => { if (el.dataset.t === "ol") { const l = D.label(nums[k], doc[k].indent); if (el.dataset.n !== l) el.dataset.n = l; } });
  }

  // ---------- read the DOM back ----------
  function readRuns(el) {
    const runs = [];
    const walk = (node, m) => {
      for (const k of node.childNodes) {
        if (k.nodeType === 3) { runs.push({ text: k.data.replace(/ /g, " ").replace(/\n/g, " "), ...m }); continue; }
        if (k.nodeType !== 1) continue;
        const t = k.tagName;
        const mm = { ...m };
        if (t === "STRONG" || t === "B") mm.b = true;
        else if (t === "EM" || t === "I") mm.i = true;
        else if (t === "S" || t === "STRIKE" || t === "DEL") mm.s = true;
        else if (t === "CODE") mm.c = true;
        else if (t === "A") { const h = D.safeHref(k.getAttribute("href")); if (h) mm.href = h; }
        const st = k.style;
        if (st) {
          if (st.fontWeight) mm.b = st.fontWeight === "bold" || +st.fontWeight >= 600 || undefined;
          if (st.fontStyle) mm.i = st.fontStyle === "italic" || undefined;
          if ((st.textDecorationLine || st.textDecoration || "").includes("line-through")) mm.s = true;
        }
        walk(k, mm);
      }
    };
    walk(el, {});
    return D.norm(runs);
  }
  function readDoc() {
    const doc = [];
    const take = (el) => {
      if (el.nodeType === 3) { if (el.data.trim()) doc.push(D.block("p", [{ text: el.data }])); return; }
      if (el.nodeType !== 1) return;
      const t = el.dataset && el.dataset.t;
      if (!t && [...el.children].some((c) => c.classList && c.classList.contains("nb"))) { for (const c of el.childNodes) take(c); return; }
      const type = t && ["p", "h1", "h2", "h3", "ul", "ol", "todo", "quote", "hr"].includes(t) ? t : "p";
      const b = D.block(type, type === "hr" ? [] : readRuns(el));
      if (D.LIST.has(type)) b.indent = Math.max(0, Math.min(D.MAX_INDENT, parseInt(el.style.getPropertyValue("--in"), 10) || 0));
      if (type === "todo") b.checked = el.dataset.checked === "true";
      doc.push(b);
    };
    for (const c of root.childNodes) take(c);
    return doc.length ? doc : [D.block("p")];
  }
  /** True when the DOM is only what render() makes (plus the <b>/<i> native bold and italic leave behind). */
  function canonical() {
    for (const el of root.childNodes) {
      if (el.nodeType !== 1 || el.tagName !== "DIV" || !el.classList.contains("nb") || !el.dataset.t) return false;
      const bad = el.querySelector("*:not(strong):not(b):not(em):not(i):not(s):not(strike):not(del):not(code):not(a):not(br)");
      if (bad) return false;
      for (const x of el.querySelectorAll("[style]")) if (INLINE_TAGS.has(x.tagName)) return false;
    }
    return root.childNodes.length > 0;
  }

  // ---------- caret ----------
  function blockIndexOf(node) {
    let n = node;
    while (n && n.parentNode !== root) n = n.parentNode;
    return n ? Array.prototype.indexOf.call(root.childNodes, n) : -1;
  }
  function pointOf(node, offset) {
    if (node === root) {
      const b = Math.min(offset, root.childNodes.length - 1);
      return offset >= root.childNodes.length ? { b, o: (root.childNodes[b] && root.childNodes[b].textContent.length) || 0 } : { b, o: 0 };
    }
    const b = blockIndexOf(node);
    if (b < 0) return null;
    const r = document.createRange();
    r.setStart(root.childNodes[b], 0);
    try { r.setEnd(node, offset); } catch { return { b, o: 0 }; }
    return { b, o: r.toString().length };
  }
  function getSel() {
    const s = getSelection();
    if (!s || !s.rangeCount || !root.contains(s.anchorNode)) return null;
    const a = pointOf(s.anchorNode, s.anchorOffset), f = pointOf(s.focusNode, s.focusOffset);
    return a && f ? { a, f } : null;
  }
  function caretBlock() { const s = getSel(); return s ? s.f.b : -1; }
  function domPoint(p) {
    const el = root.childNodes[Math.max(0, Math.min(p.b, root.childNodes.length - 1))];
    if (!el) return { node: root, offset: 0 };
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = p.o, n, last = null;
    while ((n = w.nextNode())) {
      if (left <= n.data.length) return { node: n, offset: left };
      left -= n.data.length;
      last = n;
    }
    return last ? { node: last, offset: last.data.length } : { node: el, offset: 0 };
  }
  function setSel(a, f = a) {
    const s = getSelection();
    if (!s) return;
    const x = domPoint(a), y = domPoint(f);
    try { s.setBaseAndExtent(x.node, x.offset, y.node, y.offset); } catch {}
  }

  // ---------- changes ----------
  const snapshot = () => ({ md: D.serialize(readDoc()), sel: getSel() });
  function pushUndo() {
    const s = snapshot();
    const top = undo[undo.length - 1];
    if (top && top.md === s.md) return;
    undo.push(s);
    if (undo.length > MAX_UNDO) undo.shift();
    redo = [];
  }
  function restore(s) {
    render(D.parse(s.md));
    if (s.sel) setSel(s.sel.a, s.sel.f);
    changed();
  }
  function step(dir) {
    const from = dir === "undo" ? undo : redo, to = dir === "undo" ? redo : undo;
    if (!from.length) return;
    to.push(snapshot());
    restore(from.pop());
    lastTypeAt = 0;
  }
  function changed() {
    decorate();
    const md = D.serialize(readDoc());
    if (md !== shownMd) { shownMd = md; opts.save(md); }
  }
  /** Applies a structural edit: { doc, caret? , sel? }. */
  function apply(r, keepSel) {
    if (!r) return;
    const sel = keepSel ? getSel() : null;
    render(r.doc);
    if (r.caret) setSel(r.caret);
    else if (sel) setSel(sel.a, sel.f);
    lastTypeAt = 0;
    changed();
  }
  const collapsed = (s) => s.a.b === s.f.b && s.a.o === s.f.o;
  /** The selection deleted first, when there is one: { doc, caret }. */
  function base() {
    const s = getSel();
    const doc = readDoc();
    if (!s) return { doc, caret: { b: doc.length - 1, o: D.blockLen(doc[doc.length - 1]) } };
    if (collapsed(s)) return { doc, caret: s.f };
    return D.deleteRange(doc, s.a, s.f);
  }

  // ---------- keys ----------
  root.addEventListener("keydown", (e) => {
    if (!editing || e.isComposing || e.keyCode === 229) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && key === "z") { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? "redo" : "undo"); return; }
    if (mod && key === "y") { e.preventDefault(); e.stopPropagation(); step("redo"); return; }
    if (mod && e.shiftKey && key === "v") { plainNext = Date.now(); return; } // the paste event follows (native menu or browser)
    if (mod && !e.altKey && (key === "b" || key === "i" || key === "e" || (e.shiftKey && key === "x"))) {
      e.preventDefault();
      e.stopPropagation();
      const mark = key === "b" ? "b" : key === "i" ? "i" : key === "e" ? "c" : "s";
      const s = getSel();
      if (!s) return;
      if (collapsed(s)) { if (mark === "b" || mark === "i") document.execCommand(mark === "b" ? "bold" : "italic"); return; }
      pushUndo();
      apply(D.toggleMark(readDoc(), s.a, s.f, mark), true);
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === "Escape") { e.preventDefault(); root.blur(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      pushUndo();
      const r = base();
      apply(D.enter(r.doc, r.caret));
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const s = getSel();
      if (!s) return;
      const [a, f] = D.ordered(s.a, s.f);
      const doc = readDoc();
      const r = D.indent(doc, a.b, f.b, e.shiftKey ? -1 : 1);
      if (r) { pushUndo(); apply(r, true); }
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      const s = getSel();
      if (!s || !collapsed(s)) { pushUndo(); lastTypeAt = 0; return; } // native deletes the selection; input normalizes
      const doc = readDoc();
      const blk = doc[s.f.b];
      if (!blk) return;
      if (e.key === "Backspace" && s.f.o === 0) {
        e.preventDefault();
        const r = D.backspace(doc, s.f);
        if (r) { pushUndo(); apply(r); }
      } else if (e.key === "Delete" && s.f.o >= D.blockLen(blk)) {
        e.preventDefault();
        const r = D.forwardDelete(doc, s.f);
        if (r) { pushUndo(); apply(r); }
      }
    }
  });

  root.addEventListener("beforeinput", (e) => {
    if (!editing) return;
    const t = e.inputType || "";
    if (t === "historyUndo" || t === "historyRedo") { e.preventDefault(); step(t === "historyUndo" ? "undo" : "redo"); return; }
    if (t === "insertParagraph" || t === "insertLineBreak") {
      e.preventDefault();
      pushUndo();
      const r = base();
      apply(D.enter(r.doc, r.caret));
      return;
    }
    if (t === "formatBold" || t === "formatItalic") {
      const s = getSel();
      if (s && !collapsed(s)) { e.preventDefault(); pushUndo(); apply(D.toggleMark(readDoc(), s.a, s.f, t === "formatBold" ? "b" : "i"), true); }
      return;
    }
    if (t === "insertFromDrop" || t === "insertFromPaste") return; // handled by the paste and drop listeners
    // Typing: one undo step per burst (a pause or a switch between typing and deleting starts a new one).
    const kind = t.startsWith("delete") ? "del" : "ins";
    const now = Date.now();
    if (now - lastTypeAt > 1000 || kind !== lastTypeKind) pushUndo();
    lastTypeAt = now;
    lastTypeKind = kind;
  });

  root.addEventListener("input", (e) => {
    if (!editing || e.isComposing) return;
    if (!canonical()) {
      const s = getSel();
      render(readDoc());
      if (s) setSel(s.a, s.f);
    }
    if (e.inputType === "insertText" && (e.data === " " || e.data === "-")) {
      const s = getSel();
      if (s && collapsed(s)) {
        const r = D.shortcut(readDoc(), s.f);
        if (r) {
          // Undo goes back to the typed characters ("# "), like Notion.
          undo.push(snapshot());
          redo = [];
          apply(r);
          return;
        }
      }
    }
    renumber();
    changed();
  });

  // ---------- clipboard ----------
  root.addEventListener("paste", (e) => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    const cd = e.clipboardData;
    if (!cd) return;
    const html = cd.getData("text/html"), text = cd.getData("text/plain");
    const plain = Date.now() - plainNext < 2000;
    plainNext = 0;
    if (!html && !text) return;
    pushUndo();
    const s = getSel();
    // A link pasted over selected text links that text.
    if (s && !collapsed(s) && !plain && D.safeHref(text.trim()) && !text.trim().includes("\n")) {
      apply(D.setLink(readDoc(), s.a, s.f, text.trim()), true);
      return;
    }
    const r = base();
    const blk = r.doc[r.caret.b];
    const inline = !(blk.type === "p" && !D.blockLen(blk));
    const pasted = D.pasteDoc({ html, text, plain, inline });
    if (!pasted.length) return;
    // Pasted list items inside a list item nest under it.
    if (D.LIST.has(blk.type) && blk.indent) for (const p of pasted) if (D.LIST.has(p.type)) p.indent = Math.min(D.MAX_INDENT, p.indent + blk.indent);
    apply(D.insertDoc(r.doc, r.caret, pasted));
  });
  function copySel(e) {
    const s = getSel();
    if (!s || collapsed(s)) return null;
    const part = D.sliceDoc(readDoc(), s.a, s.f);
    e.clipboardData.setData("text/plain", D.serialize(part));
    e.clipboardData.setData("text/html", D.docToHtml(part));
    e.preventDefault();
    e.stopPropagation();
    return s;
  }
  root.addEventListener("copy", (e) => { if (root.contains(e.target) || e.target === root) copySel(e); });
  root.addEventListener("cut", (e) => {
    if (!editing) return;
    const s = copySel(e);
    if (!s) return;
    pushUndo();
    apply(D.deleteRange(readDoc(), s.a, s.f));
  });
  root.addEventListener("dragover", (e) => { if (editing) e.preventDefault(); });
  root.addEventListener("drop", (e) => { if (editing) { e.preventDefault(); e.stopPropagation(); } });

  // ---------- pointer ----------
  // A checkbox toggles from its box in the left gutter, editing or not.
  root.addEventListener("pointerdown", (e) => {
    const el = e.target.closest && e.target.closest(".nb[data-t=todo]");
    if (!el || e.button !== 0 || el.parentNode !== root) return;
    const rect = el.getBoundingClientRect();
    const scale = rect.width / (el.offsetWidth || 1);
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    const x = (e.clientX - rect.left) / scale;
    if (x >= pad || x < pad - 28) return;
    e.preventDefault();
    e.stopPropagation();
    const b = Array.prototype.indexOf.call(root.childNodes, el);
    if (editing) { pushUndo(); apply(D.toggleChecked(readDoc(), b), true); return; }
    const doc = D.toggleChecked(readDoc(), b).doc;
    render(doc);
    shownMd = D.serialize(doc);
    opts.save(shownMd);
    opts.flush();
  });
  root.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a");
    if (!a) return;
    e.preventDefault(); // never navigate the canvas page itself
    if (!editing && (e.metaKey || e.ctrlKey)) { const h = D.safeHref(a.getAttribute("href")); if (h) window.open(h, "_blank", "noopener"); }
  });
  // While editing, a note taller than its card scrolls under the pointer instead of panning the canvas.
  root.addEventListener("wheel", (e) => {
    if (!editing || e.ctrlKey || e.metaKey || root.scrollHeight <= root.clientHeight) return;
    e.stopPropagation();
  }, { passive: true });
  const onSelChange = () => { if (editing) decorate(); };
  root.addEventListener("blur", () => { if (editing) end(); });

  // ---------- edit mode ----------
  /** The word around offset o in block b (letters, digits, apostrophes), or null on a space or mark. */
  function wordAt(b, o) {
    const blk = root.childNodes[b];
    if (!blk) return null;
    const r = document.createRange();
    r.selectNodeContents(blk);
    const t = r.toString();
    const w = /[\p{L}\p{N}_'\u2019]/u;
    let s = o, e = o;
    while (s > 0 && w.test(t[s - 1])) s--;
    while (e < t.length && w.test(t[e])) e++;
    return e > s ? { s, e } : null;
  }
  /** Start editing; with a point, the caret goes there (word: the word under it is selected, like a text layer). */
  function begin(x, y, word = false) {
    if (editing) return;
    editing = true;
    undo = [];
    redo = [];
    lastTypeAt = 0;
    root.contentEditable = "true";
    root.spellcheck = true;
    root.setAttribute("data-nodrag", "");
    root.classList.add("editing");
    root.focus({ preventScroll: true });
    let placed = false;
    if (typeof x === "number" && document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r && root.contains(r.startContainer)) {
        const p = pointOf(r.startContainer, r.startOffset);
        if (p) {
          const wd = word ? wordAt(p.b, p.o) : null;
          if (wd) setSel({ b: p.b, o: wd.s }, { b: p.b, o: wd.e }); else setSel(p);
          placed = true;
        }
      }
    }
    if (!placed) { const doc = readDoc(); setSel({ b: doc.length - 1, o: D.blockLen(doc[doc.length - 1]) }); }
    document.addEventListener("selectionchange", onSelChange);
    decorate();
  }
  function end() {
    if (!editing) return;
    const doc = readDoc();
    editing = false;
    document.removeEventListener("selectionchange", onSelChange);
    const md = D.serialize(doc);
    if (md !== shownMd) { shownMd = md; opts.save(md); }
    opts.flush();
    root.contentEditable = "false";
    root.removeAttribute("data-nodrag");
    root.classList.remove("editing");
    const s = getSelection();
    if (s && root.contains(s.anchorNode)) s.removeAllRanges();
    render(doc);
    undo = [];
    redo = [];
    if (opts.onEditEnd) opts.onEditEnd();
  }
  function show(stored) {
    if (editing) return;
    const text = typeof stored === "string" ? stored : "";
    const doc = D.parse(text);
    const md = D.serialize(doc); // compared normalized, so opening and closing an old note never rewrites it
    if (md === shownMd && root.childNodes.length) { decorate(); return; }
    shownMd = md;
    render(doc);
  }
  return { el: root, show, begin, end, editing: () => editing };
}
