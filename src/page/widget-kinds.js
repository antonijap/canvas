// Renderers for each widget kind. A renderer is `(ctx) => { el, update(widget, reading), dblclick?() }`.
// `el` is built once; `update` only writes textContent, attributes and classes. Remote data never
// goes through innerHTML.
//
// ctx: { widget() -> current widget, act(name, args) -> Promise<{result}>, patch(config) -> Promise, trust() -> Promise }

import { fitRows } from "./geometry.js";
import { liveCard, widgetButton, widgetSkeleton } from "./widget-live.js";
import { pageName, pageWidth, PAGE_PADDING } from "./widget-page.js";
import { noteEditor } from "./note-editor.js";
import { NOTE_MAX } from "./note-doc.js";
import { chartCard } from "./charts.js";

const SVG = "http://www.w3.org/2000/svg";
export const ROW_H = 32;
export const TODO_CHROME = 104; // Padding, title, gap and add row.
/** How long a checked to-do stays in place before it moves down to the done ones (Things waits about as long). */
const SETTLE_MS = 900;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const nodrag = (e) => { e.setAttribute("data-nodrag", ""); return e; };
const setText = (e, t) => { if (e.textContent !== t) e.textContent = t; };

/** Calls `fn` once `ms` after the last call; `flush()` runs it now if one is waiting. */
function debounce(fn, ms) {
  let t = 0, args = null;
  const run = () => { t = 0; const a = args; args = null; if (a) fn(...a); };
  const d = (...a) => { args = a; clearTimeout(t); t = setTimeout(run, ms); };
  d.flush = () => { if (t) { clearTimeout(t); run(); } };
  d.pending = () => !!t;
  return d;
}

// ---------- to-do ----------
// Laid out like a Things list. One control column (16px wide) on the card's 16px edge holds the progress ring, every
// checkbox and the add glyph; every text starts 8px after it. Open items come first, done ones after, each in stored
// order. A checked item stays where it is for a moment, then slides down to the done ones (the stored order never
// changes for that; Cmd+Up/Down moves an item for real). Interactive parts carry data-nodrag, so a press on them
// never starts a card move.
const CHECK_LEN = 11; // length of the check mark path below, for the draw-on stroke
function checkbox() {
  const b = nodrag(h("button", "cb"));
  b.type = "button";
  b.setAttribute("role", "checkbox");
  b.title = "Mark as done";
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 14 14");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", "M3.5 7.25l2.25 2.25 4.75-5");
  s.append(p);
  b.append(s);
  return b;
}
/** Things' project glyph: a ring with a pie inside that fills as items get done. */
function progressRing() {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("class", "td-ring");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  const o = document.createElementNS(SVG, "circle");
  o.setAttribute("class", "td-ring-o");
  o.setAttribute("cx", "8"); o.setAttribute("cy", "8"); o.setAttribute("r", "6.75");
  const pie = document.createElementNS(SVG, "circle");
  pie.setAttribute("class", "td-ring-p");
  pie.setAttribute("cx", "8"); pie.setAttribute("cy", "8"); pie.setAttribute("r", "2.5");
  pie.setAttribute("transform", "rotate(-90 8 8)"); // the pie fills clockwise from 12 o'clock
  s.append(o, pie);
  const C = 2 * Math.PI * 2.5;
  let shown = -1;
  return {
    el: s,
    set(frac) {
      const f = Math.round(Math.max(0, Math.min(1, frac)) * 100) / 100;
      if (f === shown) return;
      shown = f;
      pie.style.strokeDasharray = (f * C).toFixed(2) + " " + C.toFixed(2); // a style, so it transitions
    },
  };
}

function todo(ctx) {
  const root = h("div", "td");
  const head = h("div", "wd-head");
  const title = h("div", "wd-title");
  const ring = progressRing();
  head.append(ring.el, title);
  const rows = h("div", "td-rows");
  const more = h("div", "td-more");
  const add = nodrag(h("div", "td-row td-add"));
  const addInput = h("input");
  addInput.placeholder = "New to-do";
  addInput.setAttribute("aria-label", "New to-do");
  const plus = h("span", "td-plus");
  const ps = document.createElementNS(SVG, "svg");
  ps.setAttribute("viewBox", "0 0 14 14");
  ps.setAttribute("aria-hidden", "true");
  const pp = document.createElementNS(SVG, "path");
  pp.setAttribute("d", "M7 2.5v9M2.5 7h9");
  ps.append(pp);
  plus.append(ps);
  add.append(plus, addInput);
  plus.onclick = () => addInput.focus();
  // A field that loses focus leaves no selection behind.
  const clearSel = () => { const s = getSelection(); if (s && s.rangeCount && root.contains(s.anchorNode)) s.removeAllRanges(); };
  addInput.addEventListener("blur", clearSel);
  root.append(head, rows, add);
  const map = new Map(); // item id -> { row, cb, input, text, save }
  const settling = new Map(); // item id -> { done: the state its place still follows, timer }
  let pendingFocus = null;
  let lastList = [];

  const itemsOf = () => {
    const c = ctx.widget().config || {};
    return Array.isArray(c.items) ? c.items : [];
  };
  const placedDone = (i) => (settling.has(i.id) ? settling.get(i.id).done : !!i.done);
  const visible = () => {
    const c = ctx.widget().config || {};
    const list = itemsOf().filter((i) => !(c.hideDone && placedDone(i)));
    return [...list.filter((i) => !placedDone(i)), ...list.filter((i) => placedDone(i))];
  };
  const storedIndex = (id) => itemsOf().findIndex((i) => i.id === id);
  const focusRow = (id, end = true) => {
    const r = map.get(id);
    if (!r) return false;
    r.input.focus();
    if (end) r.input.setSelectionRange(r.input.value.length, r.input.value.length);
    return true;
  };
  const paint = (r, done) => {
    if (r.cb.getAttribute("aria-checked") !== String(done)) {
      r.cb.setAttribute("aria-checked", String(done));
      r.cb.title = done ? "Mark as not done" : "Mark as done";
    }
    r.row.classList.toggle("done", done);
  };
  const toggle = (id, r) => {
    const done = r.cb.getAttribute("aria-checked") !== "true";
    paint(r, done);
    if (done && !reducedMotion()) r.cb.classList.add("pop");
    const s = settling.get(id);
    if (s) { clearTimeout(s.timer); settling.delete(id); } // undone before it moved: it stays where it is
    else settling.set(id, { done: !done, timer: setTimeout(() => { settling.delete(id); reorder(); }, SETTLE_MS) });
    ctx.act("toggleItem", { id, done }).catch(() => {});
  };
  /** Re-renders after items changed places, sliding the rows that moved from where they were (FLIP). */
  function reorder() {
    if (!root.isConnected) return;
    const anim = !reducedMotion();
    const before = new Map();
    if (anim) for (const [id, r] of map) before.set(id, r.row.offsetTop);
    update(ctx.widget());
    if (!anim) return;
    const moved = [];
    for (const [id, r] of map) {
      const was = before.get(id);
      const dy = was === undefined ? 0 : was - r.row.offsetTop;
      if (!dy) continue;
      r.row.style.transition = "none";
      r.row.style.transform = "translateY(" + dy + "px)";
      moved.push(r.row);
    }
    if (moved.length) requestAnimationFrame(() => requestAnimationFrame(() => { for (const row of moved) { row.style.transition = ""; row.style.transform = ""; } }));
  }
  // A write of the whole list carries what the rows show: an edit or a check still on its way to the server must not
  // be written over with the older stored value.
  const itemsAsShown = () => itemsOf().map((i) => {
    const r = map.get(i.id);
    return r ? { ...i, text: r.input.value, done: r.cb.getAttribute("aria-checked") === "true" } : { ...i };
  });
  /**
   * Adds an item (at a stored index, or at the end) and resolves to its id. When every item fits and one more would
   * not, the card grows by a row in the same write, so one Undo takes back both.
   */
  // One at a time: a second add starts from the card as the first one left it, not from the stale list the first one wrote over.
  let adding = Promise.resolve();
  function addItem(text, index) {
    const run = () => addItemNow(text, index);
    const p = adding.then(run, run);
    adding = p.catch(() => {});
    return p;
  }
  function addItemNow(text, index) {
    const w = ctx.widget();
    const n = visible().length;
    const fitsNow = fitRows(w.h, ROW_H, TODO_CHROME, n).more === 0;
    const need = TODO_CHROME + (n + 1) * ROW_H - w.h;
    const h = fitsNow && need > 0 && ctx.grownHeight ? ctx.grownHeight(need) : null;
    if (!h) return ctx.act("addItem", index === undefined ? { text } : { text, index }).then((r) => r.result && r.result.id);
    const list = itemsAsShown();
    const known = new Set(list.map((i) => i.id));
    list.splice(index === undefined ? list.length : index, 0, { text, done: false });
    return ctx.patch({ items: list }, { h }).then((r) => {
      const got = (r.widget && r.widget.config && r.widget.config.items) || [];
      const it = got.find((i) => !known.has(i.id));
      return it && it.id;
    });
  }
  /** Removes an item. A card exactly as tall as its items (one that grew as they were added) shrinks back by a row. */
  function removeItem(id) {
    const w = ctx.widget();
    const n = visible().length;
    const fitted = !w.locked && n > 1 && w.h === TODO_CHROME + n * ROW_H;
    if (!fitted) return ctx.act("removeItem", { id });
    const list = itemsAsShown().filter((i) => i.id !== id);
    return ctx.patch({ items: list }, { h: w.h - ROW_H });
  }
  function moveBy(id, dir) {
    const at = lastList.findIndex((i) => i.id === id);
    const me = lastList[at], nb = lastList[at + dir];
    if (!me || !nb || placedDone(me) !== placedDone(nb)) return; // open and done items stay in their own group
    ctx.act("moveItem", { id, index: storedIndex(nb.id) }).then(() => focusRow(id)).catch(() => {});
  }

  function makeRow(id) {
    const row = h("div", "td-row"), cb = checkbox(), input = nodrag(h("input"));
    input.setAttribute("aria-label", "To-do");
    input.maxLength = 500;
    row.append(cb, input);
    const r = { row, cb, input, text: "" };
    r.save = debounce(() => { r.text = input.value; ctx.act("updateItem", { id, text: input.value }).catch(() => {}); }, 300);
    cb.onclick = () => toggle(id, r);
    cb.addEventListener("animationend", (e) => { if (e.target === cb) cb.classList.remove("pop"); });
    input.addEventListener("input", () => r.save());
    input.addEventListener("blur", () => { r.save.flush(); clearSel(); });
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      const list = lastList, at = list.findIndex((i) => i.id === id);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopPropagation(); r.save.flush(); toggle(id, r); }
      else if (mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); e.stopPropagation(); r.save.flush(); moveBy(id, e.key === "ArrowUp" ? -1 : 1); }
      else if (e.key === "Enter" && !mod) {
        e.preventDefault();
        r.save.flush();
        addItem("", storedIndex(id) + 1).then((nid) => { pendingFocus = nid; if (nid && focusRow(nid)) pendingFocus = null; }).catch(() => {});
      } else if (e.key === "Backspace" && input.value === "" && !mod) {
        e.preventDefault();
        r.save.flush();
        const prev = list[at - 1] || list[at + 1];
        if (prev) focusRow(prev.id);
        else addInput.focus();
        removeItem(id).catch(() => {});
      } else if (e.key === "ArrowUp" && list[at - 1]) { e.preventDefault(); focusRow(list[at - 1].id); }
      else if (e.key === "ArrowDown") { e.preventDefault(); if (list[at + 1]) focusRow(list[at + 1].id); else addInput.focus(); }
      else if (e.key === "Escape") input.blur();
    });
    return r;
  }

  addInput.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const text = addInput.value.trim();
      if (!text) return;
      addInput.value = "";
      addItem(text).catch(() => { addInput.value = text; });
    } else if (e.key === "ArrowUp" && lastList.length) { e.preventDefault(); focusRow(lastList[lastList.length - 1].id); }
    else if (e.key === "Backspace" && addInput.value === "" && lastList.length) { e.preventDefault(); focusRow(lastList[lastList.length - 1].id); }
    else if (e.key === "Escape") addInput.blur();
  });

  function update(w) {
    const c = w.config || {};
    setText(title, c.title || w.name || "To-do");
    const all = itemsOf();
    ring.set(all.length ? all.filter((i) => i.done).length / all.length : 0);
    const list = visible();
    const active = document.activeElement;
    let focusIdx = -1;
    for (let i = 0; i < list.length; i++) { const r = map.get(list[i].id); if (r && r.input === active) focusIdx = i; }
    const fit = fitRows(w.h, ROW_H, TODO_CHROME, list.length);
    const shown = Math.max(fit.shown, focusIdx + 1);
    const slice = list.slice(0, shown);
    lastList = slice;
    const keep = new Set(slice.map((i) => i.id));
    for (const [id, r] of map) if (!keep.has(id)) { r.save.flush(); r.row.remove(); map.delete(id); }
    let prev = null;
    for (const item of slice) {
      let r = map.get(item.id);
      if (!r) { r = makeRow(item.id); map.set(item.id, r); }
      paint(r, !!item.done);
      // Never overwrite what someone is typing: skip the focused input and any with an unsent edit.
      if (r.input !== document.activeElement && !r.save.pending() && r.input.value !== item.text) r.input.value = item.text;
      const want = prev ? prev.nextSibling : rows.firstChild;
      if (want !== r.row) rows.insertBefore(r.row, want);
      prev = r.row;
    }
    const rest = list.slice(slice.length);
    if (rest.length) {
      setText(more, rest.every((i) => i.done) ? rest.length + " done" : "+" + rest.length + " more");
      if (more.parentNode !== rows || more.nextSibling) rows.append(more);
    } else if (more.parentNode) more.remove();
    root.classList.toggle("empty", list.length === 0);
    if (pendingFocus && focusRow(pendingFocus)) pendingFocus = null;
  }
  return { el: root, update };
}

// ---------- note ----------
/**
 * A note's text the server has not taken (longer than the server's limit, or the write failed) stays on the card,
 * with a line saying it is not saved, until a save goes through; it survives a reload in this browser too. Wraps
 * ctx.patch (refused at once past the limit). view(serverText) is the text to show.
 */
function keepUnsaved(ctx, root) {
  const msg = h("div", "nt-err");
  msg.setAttribute("role", "alert");
  msg.hidden = true;
  root.append(msg);
  const key = () => "canvas.note.unsaved:" + ctx.widget().id;
  const stash = (t) => { try { if (t === null) localStorage.removeItem(key()); else localStorage.setItem(key(), t); } catch {} };
  const say = (t) => { if (msg.textContent !== t) msg.textContent = t; msg.hidden = !t; };
  const n = (v) => v.toLocaleString("en-US");
  const tooLong = (t) => "Not saved: " + n(t.length) + " characters, the most is " + n(NOTE_MAX) + ". Shorten the note to save it.";
  let unsaved = null, mounted = false;
  const patch = (config, extra) => {
    const t = config.text;
    unsaved = t;
    stash(t);
    if (t.length > NOTE_MAX) { say(tooLong(t)); return Promise.reject(new Error("the note is too long")); }
    return ctx.patch(config, extra).then((r) => { if (unsaved === t) { unsaved = null; stash(null); say(""); } return r; }, (e) => {
      if (unsaved === t) say("Not saved: " + e.message + ". Your text stays here; edit the note to try again.");
      throw e;
    });
  };
  const view = (server) => {
    if (!mounted) {
      mounted = true;
      let kept = null;
      try { kept = localStorage.getItem(key()); } catch {}
      if (kept !== null && kept !== server) { unsaved = kept; say(kept.length > NOTE_MAX ? tooLong(kept) : "Not saved: changes from before a reload. Edit the note to save them."); }
      else if (kept !== null) stash(null);
    }
    if (unsaved === null) return server;
    if (unsaved !== server) return unsaved;
    unsaved = null; stash(null); say("");
    return server;
  };
  return { ctx: { ...ctx, patch }, view };
}
// Rich text stored as Markdown (src/page/note-doc.js); the same element shows and edits it (src/page/note-editor.js).
function note(ctx0) {
  const root = h("div", "nt");
  const kept = keepUnsaved(ctx0, root);
  const ctx = kept.ctx;
  function measure(manual) {
    const el = ed.el;
    const { width, bottom, whiteSpace, paddingInline } = el.style;
    el.style.bottom = "auto";
    let intrinsic = 0;
    if (!Number.isFinite(manual)) {
      el.style.width = "max-content";
      el.style.whiteSpace = "pre";
      el.style.paddingInline = PAGE_PADDING + "px";
      intrinsic = el.offsetWidth - PAGE_PADDING * 2;
    }
    const w = pageWidth(intrinsic, manual);
    el.style.width = w + "px";
    el.style.whiteSpace = whiteSpace;
    el.style.paddingInline = "";
    const size = { w, h: Math.max(80, el.offsetHeight) };
    Object.assign(el.style, { width, bottom, whiteSpace, paddingInline });
    return size;
  }
  const save = debounce((t) => {
    const w = ctx.widget();
    const size = measure(w.config.pageWidth);
    const name = pageName(t);
    ctx.fit(size, name);
    ctx.patch({ text: t }, w.locked ? undefined : size).catch(() => {});
  }, 300);
  const ed = noteEditor({ save, flush: () => save.flush() });
  root.append(ed.el);
  const textOf = (w) => (w.config && typeof w.config.text === "string" ? w.config.text : "");
  // The press before a double-click says where the caret goes.
  let press = null;
  root.addEventListener("pointerdown", (e) => { press = { x: e.clientX, y: e.clientY }; }, true);
  return {
    el: root,
    update(w) {
      const text = kept.view(textOf(w));
      if (!ed.editing()) {
        ed.show(text);
        ctx.fit(measure(w.config.pageWidth), pageName(text));
      }
    },
    measure,
    dblclick() { ed.begin(press && press.x, press && press.y, true); }, // the word under the pointer is selected
  };
}

// ---------- shader ----------
// The engine draws the shader under this card (src/page/shaders.js); the card itself is transparent
// once a picture is there, and shows only what needs words: compiling, compile errors with their
// line numbers, the quarantine after a GPU reset, or a still poster when there is no WebGPU.
function shaderCard(ctx) {
  const root = h("div", "sh");
  const box = h("div", "sh-msg");
  const title = h("div", "sh-title");
  const list = h("ol", "sh-errors");
  const btn = nodrag(h("button", "st-btn", "Run"));
  btn.type = "button";
  const img = h("img", "sh-poster");
  img.alt = "";
  img.hidden = true;
  const skeleton = widgetSkeleton();
  const retry = widgetButton("Retry", () => S()?.retry(ctx.widget().id));
  box.append(title, list, skeleton, btn, retry);
  root.append(img, box);
  btn.onclick = () => { btn.disabled = true; ctx.patch({ quarantined: false }).catch(() => {}).finally(() => { btn.disabled = false; }); };
  const S = () => window.canvasShaders;
  const local = (ev) => {
    const r = root.getBoundingClientRect(), w = ctx.widget();
    const k = r.width ? w.w / r.width : 1;
    return [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k];
  };
  let pressed = false;
  root.addEventListener("pointermove", (ev) => { const [x, y] = local(ev); if (S()) S().hover(ctx.widget().id, x, y, pressed); });
  root.addEventListener("pointerdown", (ev) => { pressed = true; const [x, y] = local(ev); if (S()) S().hover(ctx.widget().id, x, y, true); });
  root.addEventListener("pointerup", (ev) => { pressed = false; const [x, y] = local(ev); if (S()) S().hover(ctx.widget().id, x, y, false); });
  root.addEventListener("pointerleave", () => { pressed = false; if (S()) S().hover("", 0, 0, false); });
  function update(w, r) {
    const st = (r && r.state) || "loading";
    root.dataset.state = st;
    root.classList.toggle("live", !!(r && r.frame));
    let t = "";
    if (st === "error") t = "! Shader error";
    else if (st === "quarantined") t = "! Stopped after a GPU reset";
    else if (st === "loading" && !(r && r.frame)) t = "◷ Compiling";
    else if (st === "no-gpu" && !(r && r.poster)) t = "Shaders need WebGPU";
    setText(title, t);
    skeleton.hidden = st !== "loading";
    retry.hidden = st !== "error";
    box.hidden = !t;
    btn.hidden = st !== "quarantined";
    list.textContent = "";
    const errs = r?.errors || (st === "error" && r?.error?.message ? [r.error] : []);
    for (const e of errs.slice(0, 6)) list.append(h("li", "", (e.line ? "Line " + e.line + (e.col ? ":" + e.col : "") + "  " : "") + e.message));
    if (errs.length > 6) list.append(h("li", "", "+" + (errs.length - 6) + " more"));
    list.hidden = !errs.length;
    // No engine (the DOM renderer): the cached poster as an image, quarantined or not.
    const poster = !(r && r.frame) && r && r.poster;
    img.hidden = !poster;
    if (poster && img.getAttribute("src") !== r.poster) img.src = r.poster;
  }
  return { el: root, update };
}

// ---------- video ----------
// The engine draws the video under this card (src/page/videos.js), like a shader card. The card shows words
// only when it needs them (no file, cannot play, no WebGPU) and, when selected, native-feeling controls:
// play/pause, a scrub bar, the time and a mute toggle. Hover plays a still card from the start, silently.
const VIDEO_ICONS = {
  play: ["M5 3.5v9l7.5-4.5z"],
  pause: ["M4.5 3.5h2.5v9H4.5z", "M9 3.5h2.5v9H9z"],
  sound: ["M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z", "M11 5.5a3.5 3.5 0 010 5", "M12.8 3.8a6 6 0 010 8.4"],
  muted: ["M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z", "M11 6l3.5 4", "M14.5 6L11 10"],
};
function icon(name) {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  for (const d of VIDEO_ICONS[name]) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    s.append(p);
  }
  return s;
}
const clock = (t) => { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
function videoCard(ctx) {
  const root = h("div", "vd");
  const img = h("img", "vd-poster");
  img.alt = "";
  img.hidden = true;
  const msg = h("div", "sh-msg vd-msg");
  const title = h("div", "sh-title");
  const sub = h("div", "vd-sub");
  const skeleton = widgetSkeleton();
  const retry = widgetButton("Retry", () => V()?.retry(id()));
  msg.append(title, sub, skeleton, retry);
  const bar = nodrag(h("div", "vd-ctl"));
  const playBtn = h("button", "vd-btn");
  playBtn.type = "button";
  playBtn.title = "Play";
  const time = h("span", "vd-time", "0:00");
  const scrub = h("input", "vd-scrub");
  scrub.type = "range"; scrub.min = "0"; scrub.max = "1000"; scrub.step = "1"; scrub.value = "0";
  scrub.setAttribute("aria-label", "Position");
  scrub.title = "Position";
  const muteBtn = h("button", "vd-btn");
  muteBtn.type = "button";
  muteBtn.title = "Mute";
  bar.append(playBtn, time, scrub, muteBtn);
  root.append(img, msg, bar);
  const V = () => window.canvasVideos;
  const id = () => ctx.widget().id;
  let shownIcon = "", shownMute = "", scrubbing = false, loop = 0;
  playBtn.onclick = (e) => { e.stopPropagation(); if (V()) V().toggle(id()); paint(); };
  muteBtn.onclick = (e) => { e.stopPropagation(); const st = V() && V().state(id()); if (st) V().mute(id(), !st.muted); paint(); };
  scrub.addEventListener("pointerdown", (e) => { e.stopPropagation(); scrubbing = true; });
  scrub.addEventListener("input", () => { const st = V() && V().state(id()); if (st && st.duration) { V().seek(id(), (Number(scrub.value) / 1000) * st.duration); setText(time, clock((Number(scrub.value) / 1000) * st.duration) + " / " + clock(st.duration)); } });
  scrub.addEventListener("change", () => { scrubbing = false; });
  scrub.addEventListener("pointerup", () => { scrubbing = false; });
  root.addEventListener("pointerenter", () => { if (V()) V().hover(id(), 0, 0); });
  root.addEventListener("pointerleave", () => { if (V()) V().hover("", 0, 0); });
  function paint() {
    const st = V() && V().state(id());
    if (!st) return;
    const ic = st.playing ? "pause" : "play";
    if (ic !== shownIcon) { shownIcon = ic; playBtn.textContent = ""; playBtn.append(icon(ic)); playBtn.setAttribute("aria-label", st.playing ? "Pause" : "Play"); playBtn.title = st.playing ? "Pause" : "Play"; }
    const mu = st.muted ? "muted" : "sound";
    if (mu !== shownMute) { shownMute = mu; muteBtn.textContent = ""; muteBtn.append(icon(mu)); muteBtn.setAttribute("aria-label", st.muted ? "Unmute" : "Mute"); muteBtn.title = st.muted ? "Unmute" : "Mute"; }
    if (!scrubbing) {
      setText(time, clock(st.time) + " / " + clock(st.duration));
      const v = st.duration ? String(Math.round((st.time / st.duration) * 1000)) : "0";
      if (scrub.value !== v) scrub.value = v;
    }
  }
  // While the controls show (the card is selected), follow the playhead.
  function tick() { loop = 0; if (!root.isConnected || !root.closest(".vfocus")) return; paint(); loop = requestAnimationFrame(tick); }
  function update(w, r) {
    const st = (r && r.state) || "loading";
    root.dataset.state = st;
    root.classList.toggle("live", !!(r && r.frame));
    let t = "", s = "";
    if (st === "empty") { t = "○ No video file"; s = "Choose one in the inspector."; }
    else if (st === "error") { t = "! Cannot play this video"; s = (r.error && r.error.message) || ""; }
    else if (st === "loading" && !(r && r.frame)) t = "◷ Loading";
    else if (st === "no-gpu" && !(r && r.poster)) t = "Videos need WebGPU";
    setText(title, t);
    setText(sub, s);
    skeleton.hidden = st !== "loading";
    retry.hidden = st !== "error";
    sub.hidden = !s;
    msg.hidden = !t;
    bar.hidden = st === "empty" || st === "error";
    const poster = !(r && r.frame) && r && r.poster;
    img.hidden = !poster;
    if (poster && img.getAttribute("src") !== r.poster) img.src = r.poster;
    paint();
    if (!loop && root.closest(".vfocus")) loop = requestAnimationFrame(tick);
  }
  // Selection toggles .vfocus on the card: start following the playhead then. Only the card's own element is
  // watched: an observer on the whole widget layer kept every removed card alive (stress: 64 dead cards after
  // eight visits to a page with eight videos, each still called on every class change).
  const mo = new MutationObserver(() => { if (!loop && root.closest(".vfocus")) loop = requestAnimationFrame(tick); });
  let watched = null;
  function watch() {
    const card = root.closest(".wd");
    if (!card || card === watched) return;
    mo.disconnect();
    mo.observe(card, { attributes: true, attributeFilter: ["class"] });
    watched = card;
  }
  const update0 = update;
  return { el: root, update: (w, r) => { watch(); update0(w, r); } };
}

// ---------- welcome ----------
// The card on the Welcome file a first launch opens (src/onboarding.ts): "Connect an agent", one row per agent
// (Claude Code, Codex) with Connect (POST /api/mcp/connect runs the register command for the person,
// src/mcp-connect.ts) or a green dot and Connected, and a ... menu whose Copy command copies that command for Terminal.
// GET /api/mcp/setup is asked every 2 s while the card is on the page. Settings > Agents connects the same way
// (apps/macos/Settings.swift, ConnectAgentCard).
export const WELCOME_TITLE = "Connect an agent";
export const WELCOME_HINT = "Then select a layer and ask for a change. ⌘Z undoes its work.";
/** TEMPORARY_SERVER in src/mcp-connect.ts (test/welcome-card.test.ts keeps them the same): Connect refuses there. */
export const WELCOME_TEMPORARY = "This Canvas runs from a temporary worktree; connect from the installed app or the main checkout.";
const AGENT_LABEL = { claude: "Claude Code", codex: "Codex" };
const AGENT_CLIENT = { claude: "Claude", codex: "Codex" };

/**
 * What an agent's row shows, from GET /api/mcp/setup (`s`) and whether its Connect is running. connected: the green
 * dot and Connected (canvas is registered with it, or it is the client talking now). button: "Connect",
 * "Connecting…", or "Copy command" when Connect cannot run here (the agent's CLI was not found, or this server runs
 * from a temporary worktree: `temporary`); null with connected.
 */
export function welcomeRow(s, key, busy = false) {
  s = s || {};
  const connected = !busy && (!!(s.registered && s.registered[key]) || (s.connected === true && s.client === AGENT_CLIENT[key]));
  if (connected) return { connected: true, button: null };
  if (busy) return { connected: false, button: "Connecting…" };
  return { connected: false, button: s.installed && s.installed[key] && !s.temporary ? "Connect" : "Copy command" };
}

/** An MCP from before an update is talking (src/onboarding.ts `outdated`): its agent session must restart. */
export const WELCOME_OUTDATED = "Connected (older version, restart your agent session)";
/** addedMessage in src/mcp-connect.ts: Connect worked, and sessions already open must restart to use it. */
export const welcomeAdded = (label) => "Added. New " + label + " sessions use it; restart any that are open.";

/** Only an MCP of another copy of Canvas talks (src/onboarding.ts `otherCopy`): not older, so no restart advice. */
export const WELCOME_OTHER_COPY = "Connected (an agent runs another copy of Canvas)";

/**
 * The footer line with no Connect answer to report: an older MCP talking (restart that session), another copy's MCP,
 * why Connect is missing on a temporary worktree, else the next step.
 */
export const welcomeHint = (s) => (s && s.outdated ? WELCOME_OUTDATED : s && s.otherCopy ? WELCOME_OTHER_COPY : s && s.temporary ? WELCOME_TEMPORARY : WELCOME_HINT);

function welcomeCard(ctx) {
  const root = h("div", "wc");
  const title = h("div", "wc-title", WELCOME_TITLE);
  root.append(title);
  const rows = {};
  const hint = h("div", "wc-hint", WELCOME_HINT);
  let last = {};
  /** What the footer says after a Connect: the next step, or the error. Null: the default. */
  let note = null;
  let menu = null;
  for (const [key, label] of Object.entries(AGENT_LABEL)) {
    const row = h("div", "wc-row");
    row.dataset.agent = key;
    const btn = nodrag(h("button", "wc-btn", "Connect"));
    btn.type = "button";
    const on = h("span", "wc-on");
    on.append(h("span", "wc-dot"), h("span", "wc-on-t", "Connected"));
    const more = nodrag(h("button", "wc-more"));
    more.type = "button";
    more.setAttribute("aria-label", "More for " + label);
    more.setAttribute("aria-haspopup", "menu");
    more.title = "More";
    more.append(h("i"), h("i"), h("i"));
    row.append(h("span", "wc-name", label), h("span", "wc-sp"), btn, on, more);
    btn.onclick = () => { if (rows[key].button === "Copy command") copyCommand(key); else connectAgent(key); };
    more.onclick = (e) => { e.stopPropagation(); if (menu && menu.key === key) closeMenu(); else openMenu(key, more); };
    rows[key] = { btn, on, text: "", busy: false, button: "Connect" };
    root.append(row, h("div", "wc-line"));
  }
  root.append(hint);

  function copyCommand(key) { if (rows[key].text) ctx.copy(rows[key].text); }
  function closeMenu() {
    if (!menu) return;
    menu.el.remove();
    menu.anchor.setAttribute("aria-expanded", "false");
    removeEventListener("pointerdown", menu.away, true);
    menu = null;
  }
  function openMenu(key, anchor) {
    closeMenu();
    const el = nodrag(h("div", "wc-menu"));
    el.setAttribute("role", "menu");
    const item = nodrag(h("button", "", "Copy command"));
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.setAttribute("aria-label", "Copy the " + AGENT_LABEL[key] + " command");
    item.disabled = !rows[key].text;
    item.onclick = (e) => { e.stopPropagation(); closeMenu(); copyCommand(key); };
    el.append(item);
    root.append(el);
    // Under the button, its right edges lined up; above it when the card ends first. The card scales with the
    // camera, so offsets come from layout boxes (offsetTop/Left), not the screen.
    const top = anchor.offsetTop + anchor.offsetHeight + 4;
    el.style.right = root.clientWidth - (anchor.offsetLeft + anchor.offsetWidth) + "px";
    el.style.top = (top + el.offsetHeight > root.clientHeight ? anchor.offsetTop - el.offsetHeight - 4 : top) + "px";
    const away = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
    addEventListener("pointerdown", away, true);
    anchor.setAttribute("aria-expanded", "true");
    menu = { key, el, away, anchor };
  }

  async function connectAgent(key) {
    const r = rows[key];
    if (r.busy || welcomeRow(last, key).connected) return;
    r.busy = true;
    note = null;
    show(last);
    let j;
    try {
      const res = await fetch("/api/mcp/connect", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ agent: key }) });
      j = await res.json();
    } catch (e) {
      j = { ok: false, error: "Canvas did not answer: " + ((e && e.message) || e) };
    }
    r.busy = false;
    if (j && j.ok) {
      note = { text: j.message || welcomeAdded(AGENT_LABEL[key]), err: false };
      last = { ...last, registered: { ...(last.registered || {}), [key]: true } };
    } else {
      const e = String((j && j.error) || "Something went wrong.");
      note = { text: e.startsWith(AGENT_LABEL[key]) ? e : AGENT_LABEL[key] + ": " + e, err: true };
    }
    show(last);
  }

  let timer = 0;
  /** Until the first answer the rows show Connect, greyed: no flash of Copy command while Canvas looks. */
  let loaded = false;
  function show(j) {
    last = j || {};
    for (const key of Object.keys(AGENT_LABEL)) {
      const r = rows[key];
      r.text = typeof last[key] === "string" ? last[key] : "";
      const s = loaded ? welcomeRow(last, key, r.busy) : { connected: false, button: "Connect" };
      r.button = s.button;
      r.on.hidden = !s.connected;
      r.btn.hidden = !s.button;
      if (s.button) {
        setText(r.btn, s.button);
        r.btn.disabled = !loaded || r.busy || (s.button === "Copy command" && !r.text);
        r.btn.setAttribute("aria-label", s.button === "Copy command" ? "Copy the " + AGENT_LABEL[key] + " command" : s.button === "Connect" ? "Connect " + AGENT_LABEL[key] + " to Canvas" : s.button);
      }
    }
    root.classList.toggle("on", last.connected === true);
    hint.classList.toggle("err", !!(note && note.err));
    // Two lines at most for the longer ones: an error, Connect's next step, why Connect is missing here.
    hint.classList.toggle("long", note ? !note.err : !!last.temporary && !last.outdated && !last.otherCopy);
    setText(hint, note ? note.text : welcomeHint(last));
    hint.title = note && note.err ? note.text : "";
  }
  async function poll() {
    timer = 0;
    if (!root.isConnected) { closeMenu(); return; } // off the page: update() starts it again when the card is mounted again
    try { const j = await (await fetch("/api/mcp/setup")).json(); loaded = true; show(j); } catch {}
    if (root.isConnected && !timer) timer = setTimeout(poll, 2000);
  }
  show(last);
  return { el: root, update() { if (!timer) timer = setTimeout(poll, 0); } };
}

function unsupported(ctx) {
  const root = h("div", "un");
  root.append(h("div", "un-title", "Unsupported widget"), h("div", "un-kind"));
  return { el: root, update(w) { setText(root.lastChild, String(w.kind)); } };
}

export const KINDS = { todo, note, posthog: chartCard, "git-status": liveCard, ci: liveCard, "claude-usage": liveCard, metric: liveCard, "page-preview": liveCard, "disk-space": liveCard, shader: shaderCard, video: videoCard, welcome: welcomeCard };
export const rendererFor = (kind) => (Object.hasOwn(KINDS, kind) ? KINDS[kind] : unsupported);
