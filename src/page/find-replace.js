// Find and replace: Cmd+F (Edit > Find and Replace in the app, also in Cmd+K) opens a small bar over
// the canvas. It finds text in every text layer of the file, on every page (GET /api/search/text, src/search.ts),
// literally, with Match case and Whole words. Return goes to the next match (Shift+Return the previous one): its
// page shows, its layer is selected and in view. Replace changes the match shown, Replace all every match on every
// page (POST /api/replace, src/textedit.ts): one undo step each. Esc closes the bar.
//
// The pure helpers at the top are node-tested (test/find-replace.test.ts).

/** The match index after a step of `dir` (+1 next, -1 previous) among `n`, wrapping; -1 when there are none. */
export function stepIndex(i, n, dir) {
  if (!n) return -1;
  if (i < 0) return dir < 0 ? n - 1 : 0;
  return (i + dir + n) % n;
}

/** What the count reads: "3 of 12", "12" before a match is shown, "No results" for none, "" for no query. */
export function countLabel(q, i, total) {
  if (!q) return "";
  if (!total) return "No results";
  return i >= 0 ? `${i + 1} of ${total}` : String(total);
}

/** The match to show after the list changed: the one at the same layer and place, else the one now in its slot. */
export function keepIndex(prev, matches, oldIndex) {
  if (!matches.length) return -1;
  if (prev) {
    const same = matches.findIndex((m) => m.id === prev.id && m.start === prev.start);
    if (same >= 0) return same;
  }
  return oldIndex < 0 ? -1 : Math.min(oldIndex, matches.length - 1);
}

// ---------------------------------------------------------------- the page

const ICON = {
  up: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 6 4.5l3 3"/></svg>',
  down: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5l3-3"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/></svg>',
};

export function attach(host) {
  if (!host || !host.file || host.findReplace) return;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const tell = (t) => { if (host.native) host.post({ toast: t }); else { const m = document.getElementById("msg"); if (m) { m.textContent = t; m.style.display = "block"; setTimeout(() => { m.style.display = "none"; }, 4000); } } };

  const css = document.createElement("style");
  css.textContent = `
#findBar{position:fixed;z-index:25;display:none;flex-direction:column;gap:6px;width:360px;padding:8px;box-sizing:border-box;border-radius:12px;background:var(--c-sidebar);color:var(--c-fg);font-family:var(--c-font-sans);-webkit-font-smoothing:antialiased;
  box-shadow:0 0 0 .5px #0000000f,0 1px 3px #00000014,0 8px 24px -6px #00000029}
@media (prefers-color-scheme: dark){#findBar{box-shadow:0 0 0 .5px #00000099,0 1px 3px #00000066,0 8px 24px -6px #0000008c}}
#findBar.open{display:flex}
#findBar .r{display:flex;align-items:center;gap:4px;height:24px}
#findBar input{flex:1;min-width:0;height:24px;box-sizing:border-box;border:0;outline:0;border-radius:6px;padding:0 8px;background:#0000000f;color:var(--c-fg);font:13px/1 var(--c-font-sans)}
@media (prefers-color-scheme: dark){#findBar input{background:#ffffff14}}
#findBar input::placeholder{color:var(--c-muted-fg)}
#findBar input:focus{background:#0000001a}
@media (prefers-color-scheme: dark){#findBar input:focus{background:#ffffff24}}
#findBar button{flex:none;display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--c-fg);font:500 12px/1 var(--c-font-sans);cursor:pointer;white-space:nowrap}
#findBar button.ic{padding:0;width:24px}
#findBar button:hover:not(:disabled){background:#0000000f}
@media (prefers-color-scheme: dark){#findBar button:hover:not(:disabled){background:#ffffff14}}
#findBar button.on{background:#0000001a}
@media (prefers-color-scheme: dark){#findBar button.on{background:#ffffff26}}
#findBar button.fill{background:#0000000f}
@media (prefers-color-scheme: dark){#findBar button.fill{background:#ffffff14}}
#findBar button:disabled{color:var(--c-muted-fg);cursor:default}
#findBar .n{flex:none;min-width:56px;text-align:right;color:var(--c-muted-fg);font-size:12px;line-height:1;font-variant-numeric:tabular-nums}
#findBar .sn{height:16px;line-height:16px;padding:0 8px;font-size:12px;color:var(--c-muted-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#findBar .sn b{color:var(--c-fg);font-weight:600}
#findBar .sn:empty{display:none}
`;
  document.head.appendChild(css);

  const bar = document.createElement("div");
  bar.id = "findBar";
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", "Find and replace");
  bar.innerHTML = `<div class="r"><input class="q" type="text" placeholder="Find" spellcheck="false" autocomplete="off" aria-label="Find"><span class="n"></span>`
    + `<button class="ic prev" title="Previous match (Shift+Return)" aria-label="Previous match">${ICON.up}</button><button class="ic next" title="Next match (Return)" aria-label="Next match">${ICON.down}</button>`
    + `<button class="case" title="Match case" aria-pressed="false">Aa</button><button class="word" title="Whole words" aria-pressed="false">W</button>`
    + `<button class="ic close" title="Close (Esc)" aria-label="Close">${ICON.close}</button></div>`
    + `<div class="r"><input class="rep" type="text" placeholder="Replace with" spellcheck="false" autocomplete="off" aria-label="Replace with">`
    + `<button class="fill one" title="Replace this match (Return in this field)">Replace</button><button class="fill all" title="Replace every match on every page">Replace all</button></div>`
    + `<div class="sn"></div>`;
  document.body.appendChild(bar);
  const $ = (s) => bar.querySelector(s);
  const qIn = $(".q"), repIn = $(".rep"), count = $(".n"), snip = $(".sn");
  for (const ev of ["keydown", "keyup", "pointerdown", "mousedown", "click", "dblclick", "wheel", "copy", "cut", "paste"]) bar.addEventListener(ev, (e) => e.stopPropagation());

  const st = { open: false, matches: [], total: 0, layers: 0, i: -1, matchCase: false, wholeWord: false, busy: false, ask: 0 };

  function place() {
    const v = host.view || document.getElementById("view");
    const r = v ? v.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth };
    const ins = host.insets || { l: 0, t: 0, r: 0, b: 0 };
    const w = bar.offsetWidth || 360;
    const left = r.left + ins.l + Math.max(0, (r.width - ins.l - ins.r - w) / 2);
    bar.style.left = Math.round(left) + "px";
    bar.style.top = Math.round(r.top + ins.t + (host.native ? 10 : 70)) + "px";
  }

  function render() {
    count.textContent = countLabel(qIn.value, st.i, st.total);
    const none = !st.total;
    $(".prev").disabled = none; $(".next").disabled = none;
    $(".all").disabled = none || st.busy; $(".one").disabled = none || st.busy;
    $(".case").classList.toggle("on", st.matchCase); $(".case").setAttribute("aria-pressed", String(st.matchCase));
    $(".word").classList.toggle("on", st.wholeWord); $(".word").setAttribute("aria-pressed", String(st.wholeWord));
    const m = st.matches[st.i];
    if (!m) { snip.textContent = ""; return; }
    let html = "", at = 0;
    for (const [s, l] of m.ranges) { html += esc(m.title.slice(at, s)) + "<b>" + esc(m.title.slice(s, s + l)) + "</b>"; at = s + l; }
    snip.innerHTML = html + esc(m.title.slice(at));
  }

  let timer = 0;
  async function search(keep) {
    const q = qIn.value;
    const ask = ++st.ask;
    if (!q) { st.matches = []; st.total = 0; st.i = -1; render(); return; }
    const prev = keep ? st.matches[st.i] : null, old = st.i;
    const u = host.api("/api/search/text") + "&q=" + encodeURIComponent(q) + (st.matchCase ? "&case=1" : "") + (st.wholeWord ? "&word=1" : "") + (host.page ? "&page=" + encodeURIComponent(host.page) : "");
    let j;
    try { j = await (await fetch(u)).json(); } catch { return; }
    if (ask !== st.ask) return;
    st.matches = Array.isArray(j.matches) ? j.matches : [];
    st.total = st.matches.length;
    st.layers = j.layers || 0;
    st.i = keep ? keepIndex(prev, st.matches, old) : -1;
    render();
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { timer = 0; search(false); }, 80); };

  /** Show match i: its page, its layer selected and in view. */
  function show(i) {
    st.i = i;
    render();
    const m = st.matches[i];
    if (!m) return;
    host.emit("cmd", { cmd: "paletteSelect", ids: [m.id], boards: { [m.id]: m.board } });
  }
  const step = (dir) => { if (st.total) show(stepIndex(st.i, st.total, dir)); };

  async function replace(all) {
    if (st.busy || !st.total || !qIn.value) return;
    const m = st.matches[st.i < 0 ? 0 : st.i];
    if (!all && st.i < 0) { show(0); return; } // the first Replace shows the match it will change
    st.busy = true; render();
    const body = { file: host.file, query: qIn.value, replacement: repIn.value, matchCase: st.matchCase, wholeWord: st.wholeWord, ...(all ? {} : { only: { id: m.id, start: m.start } }) };
    const p = fetch("/api/replace", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }));
    if (host.trackWrite) host.trackWrite(p);
    try {
      const j = await p;
      if (all) tell(j.replaced === 1 ? "Replaced 1 match" : `Replaced ${j.replaced} matches in ${j.layers} ${j.layers === 1 ? "layer" : "layers"}`);
    } catch (err) { tell("Could not replace: " + err.message); }
    st.busy = false;
    await search(true);
    if (!all && st.total) show(Math.min(st.i < 0 ? 0 : st.i, st.total - 1));
  }

  function open() {
    if (host.textEdit && host.textEdit.active) host.textEdit.commit();
    st.open = true;
    bar.classList.add("open");
    place();
    qIn.focus({ preventScroll: true });
    qIn.select();
    if (qIn.value) search(true);
    else render();
  }
  function close() {
    if (!st.open) return;
    st.open = false;
    bar.classList.remove("open");
    if (bar.contains(document.activeElement)) document.activeElement.blur();
  }

  qIn.addEventListener("input", later);
  qIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      // Typed and pressed Return before the search went out: search first, then show the first match.
      const pending = timer !== 0;
      clearTimeout(timer); timer = 0;
      (pending ? search(false) : Promise.resolve()).then(() => step(e.shiftKey ? -1 : 1));
    }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  repIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); replace(e.metaKey || e.ctrlKey); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  $(".prev").addEventListener("click", () => step(-1));
  $(".next").addEventListener("click", () => step(1));
  $(".case").addEventListener("click", () => { st.matchCase = !st.matchCase; search(false); });
  $(".word").addEventListener("click", () => { st.wholeWord = !st.wholeWord; search(false); });
  $(".close").addEventListener("click", close);
  $(".one").addEventListener("click", () => replace(false));
  $(".all").addEventListener("click", () => replace(true));
  addEventListener("resize", () => { if (st.open) place(); });

  // Cmd+F on the canvas (the app's Edit menu sends {cmd: "findReplace"} instead). Not while typing in a field.
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.code !== "KeyF") return;
    const t = e.target;
    if (t && t !== document.body && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && !bar.contains(t)) return;
    e.preventDefault();
    open();
  });
  host.on("cmd", (c) => { if (c && c.cmd === "findReplace") open(); });
  // Another file or a reload: the list belongs to the file this page has.
  host.on("page", () => { if (st.open && qIn.value) search(true); });

  host.findReplace = { open, close, get isOpen() { return st.open; }, get state() { return { q: qIn.value, i: st.i, total: st.total, matches: st.matches.slice(0, 50) }; } };
}

if (typeof window !== "undefined" && window.canvasHost) attach(window.canvasHost);
