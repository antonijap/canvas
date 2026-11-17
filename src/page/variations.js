// Variations in one keystroke, on the canvas (the server half is src/variations.ts). Runs on window.canvasHost.
//
// Shift+Cmd+Return (or Cmd+K > Make 3 Variations) on a board or a layer: the server copies the board three times
// beside the original and the person's agent builds one direction in each. While it works, one line under the
// original: "Making 3 variations", then the count ("2/3"), and a stop button. Then each copy gets a caption under it
// (its direction, the apps it follows) with Keep: the other copies go in one undo step. Esc, or Discard on the line,
// removes all three in one undo step. Cmd+K > Edit Product Brief opens the file's brief in a small sheet.
// Its own module and styles (vx-), apart from the composer's: magic is grey, single-line labels at line height 100%.

import { captionLayout, lineText, visibleSets } from "/page/variations-logic.js";

/** World units between copies (GAP in src/variations.ts). */
const GAP = 80;
const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, file } = host;
  const api = (p, body) => fetch(p, body === undefined ? {} : { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { code: j.code }); return j; }));
  const q = (o) => new URLSearchParams(o).toString();
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || !!(t.closest && t.closest("[contenteditable]")));

  const css = document.createElement("style");
  css.textContent = `
.vx-layer{position:absolute;left:0;top:0;width:0;height:0;z-index:12;font-family:var(--c-font-sans);-webkit-font-smoothing:antialiased;--vx-lift:0 0 0 .5px #0000000f,0 1px 3px #00000014,0 8px 24px -6px #00000029}
@media (prefers-color-scheme: dark){.vx-layer{--vx-lift:0 0 0 .5px #00000099,0 1px 3px #00000066,0 8px 24px -6px #0000008c}}
.vx-layer *{box-sizing:border-box}
.vx-line{position:absolute;display:flex;align-items:center;gap:8px;height:28px;padding:0 4px 0 10px;border-radius:10px;background:var(--c-sidebar);color:var(--c-fg);box-shadow:var(--vx-lift);font-size:12px;line-height:1;font-weight:500;white-space:nowrap;pointer-events:auto}
.vx-line .n{color:var(--c-muted-fg);font-weight:400;font-variant-numeric:tabular-nums}
.vx-line .err{color:var(--c-danger);font-weight:400;max-width:320px;overflow:hidden;text-overflow:ellipsis;padding:3px 0;margin:-3px 0}
.vx-spin{width:12px;height:12px;flex:none;color:var(--c-muted-fg);animation:vx-spin 1s steps(8) infinite}
@keyframes vx-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.vx-spin{animation:none}}
.vx-btn{flex:none;display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border:0;border-radius:6px;background:#0000000f;color:var(--c-fg);font:500 12px/1 var(--c-font-sans);cursor:pointer;white-space:nowrap}
.vx-btn:hover{background:#0000001a}
@media (prefers-color-scheme: dark){.vx-btn{background:#ffffff1a}.vx-btn:hover{background:#ffffff26}}
.vx-x{flex:none;width:20px;height:20px;border:0;border-radius:6px;padding:0;display:flex;align-items:center;justify-content:center;background:transparent;color:var(--c-muted-fg);cursor:pointer}
.vx-x:hover{background:#0000000f;color:var(--c-fg)}
@media (prefers-color-scheme: dark){.vx-x:hover{background:#ffffff1a}}
.vx-cap{display:inline-flex;align-items:center;justify-content:center;height:16px;min-width:16px;padding:0 4px;border-radius:4px;background:#0000000f;color:var(--c-muted-fg);font:500 10px/1 var(--c-font-sans)}
@media (prefers-color-scheme: dark){.vx-cap{background:#ffffff1a}}
.vx-caption{position:absolute;display:flex;align-items:center;gap:8px;min-height:40px;padding:8px 8px 8px 10px;border-radius:10px;background:var(--c-sidebar);color:var(--c-fg);box-shadow:var(--vx-lift);pointer-events:auto}
.vx-caption .t{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.vx-caption .d,.vx-caption .r{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:3px 0;margin:-3px 0;line-height:1}
.vx-caption .d{font-size:12px;font-weight:600}
.vx-caption .r{font-size:11px;color:var(--c-muted-fg)}
.vx-caption.wait .d{color:var(--c-muted-fg);font-weight:500}
.vx-caption[data-size=short] .r{display:none}
.vx-caption[data-size=short]{min-height:32px;padding:6px 6px 6px 8px}
.vx-caption[data-size=keep] .t{display:none}
.vx-caption[data-size=keep]{min-height:0;padding:4px;justify-content:center}
.vx-sheet-bg{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:#00000014}
.vx-sheet{width:380px;padding:12px;border-radius:var(--c-radius-island);background:var(--c-sidebar);color:var(--c-fg);box-shadow:var(--vx-lift);display:flex;flex-direction:column;gap:10px;font-family:var(--c-font-sans)}
.vx-sheet .h{display:flex;align-items:center;gap:8px;font-size:13px;line-height:1;font-weight:600}
.vx-sheet .h .n{font-weight:400;font-size:12px;color:var(--c-muted-fg)}
.vx-sheet textarea{width:100%;height:132px;resize:none;border:0;outline:0;border-radius:var(--c-radius-field);background:#0000001f;color:var(--c-fg);font:13px/18px var(--c-font-sans);padding:6px 8px}
@media (prefers-color-scheme: dark){.vx-sheet textarea{background:#ffffff17}}
.vx-sheet textarea::placeholder{color:var(--c-muted-fg)}
.vx-sheet .f{display:flex;align-items:center;justify-content:flex-end;gap:6px}
`;
  document.head.appendChild(css);
  const spinner = `<svg class="vx-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => `<line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(${a} 12 12)" opacity="${0.25 + (i / 7) * 0.75}"/>`).join("")}</svg>`;
  const xmark = `<svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 2l6 6M8 2l-6 6"/></svg>`;

  const layer = document.createElement("div");
  layer.className = "vx-layer";
  view.appendChild(layer);
  for (const t of ["pointerdown", "pointermove", "pointerup", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) layer.addEventListener(t, (e) => e.stopPropagation(), { passive: true });

  // ---------- state ----------
  let sets = new Map();
  let es = null;
  const connect = () => {
    if (es || document.hidden) return;
    es = new EventSource(`/api/variations/events?${q({ file })}`);
    es.onmessage = (m) => {
      let j;
      try { j = JSON.parse(m.data); } catch { return; }
      if (j.type === "hello") sets = new Map((j.sets || []).map((s) => [s.id, s]));
      else if (j.type === "set" && j.set) sets.set(j.set.id, j.set);
      render();
    };
  };
  const disconnect = () => { if (es) { es.close(); es = null; } };
  document.addEventListener("visibilitychange", () => (document.hidden ? disconnect() : connect()));
  connect();

  const exists = (id) => !!host.worldRectOf(id);
  const shown = () => visibleSets([...sets.values()], exists);
  const ids = () => (host.selection ? host.selection() : host.sel ? [host.sel] : []).filter((id) => id && !id.startsWith("widget:"));

  // ---------- actions ----------
  let starting = false;
  async function make() {
    const sel = ids();
    if (!sel.length) return tell("Select a board or a layer first");
    if (starting || [...sets.values()].some((s) => s.status === "making")) return;
    starting = true;
    // The boards' drawn sizes: a board that hugs its content has no width in the file.
    const rects = {};
    let n = 0;
    for (const id of host.boards ? host.boards.keys() : []) { if (n++ > 300) break; const r = host.boxOf(id); if (r) rects[id] = { x: r.x, y: r.y, w: r.w, h: r.h }; }
    try {
      const j = await api(`/api/variations/make`, { file, ids: sel, rects });
      sets.set(j.set.id, j.set);
      render();
      // Bring the row into view: the original and its three copies, once the page has the new boards.
      const all = [j.set.original, ...j.set.copies.map((c) => c.id)];
      const rectsOf = () => all.map((id) => host.worldRectOf(id) || host.boxOf(id)).filter(Boolean);
      for (let i = 0; i < 30 && rectsOf().length < all.length; i++) await new Promise((r) => setTimeout(r, 50));
      const rs = rectsOf();
      if (rs.length) {
        const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
        host.fitRect({ x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y + 80 }, 80, 1);
      }
    } catch (e) {
      tell(e.message);
    } finally {
      starting = false;
    }
  }
  const keep = (s, id) => api(`/api/variations/keep`, { file, set: s.id, id }).then((j) => { sets.set(j.set.id, j.set); render(); host.setSelection && host.setSelection([id]); }).catch((e) => tell(e.message));
  const discard = (s) => api(`/api/variations/discard`, { file, set: s.id }).then((j) => { sets.set(j.set.id, j.set); render(); }).catch((e) => tell(e.message));
  const stop = (s) => api(`/api/variations/stop`, { set: s.id }).catch((e) => tell(e.message));

  // ---------- drawing ----------
  const line = document.createElement("div");
  line.className = "vx-line";
  line.style.display = "none";
  layer.appendChild(line);
  const captions = new Map(); // copy id -> element
  let lineKey = "";

  function render() {
    const list = shown();
    const s = list[list.length - 1] || null;
    const t = s && lineText(s);
    const key = s ? `${s.id}:${s.status}:${t.label}:${t.count}:${t.error || ""}` : "";
    if (key !== lineKey) {
      lineKey = key;
      if (!s) line.innerHTML = "";
      else if (s.status === "making") line.innerHTML = `${spinner}<span>${esc(t.label)}</span>${t.count ? `<span class="n">${esc(t.count)}</span>` : ""}<button class="vx-x" aria-label="Stop" title="Stop (what is made so far stays)">${xmark}</button>`;
      else line.innerHTML = `${t.error ? `<span class="err" title="${esc(t.error)}">${esc(t.error)}</span>` : `<span>${esc(t.label)}</span>`}<button class="vx-btn vx-discard">Discard<span class="vx-cap">esc</span></button>`;
      const x = line.querySelector(".vx-x"), d = line.querySelector(".vx-discard");
      if (x) x.addEventListener("click", () => stop(s));
      if (d) d.addEventListener("click", () => discard(s));
    }
    const want = new Set();
    for (const set of list) {
      set.copies.forEach((c, i) => {
        if (!exists(c.id)) return;
        want.add(c.id);
        let el = captions.get(c.id);
        if (!el) {
          el = document.createElement("div");
          el.className = "vx-caption";
          layer.appendChild(el);
          captions.set(c.id, el);
        }
        const dir = c.direction || (set.directions && set.directions[i] && set.directions[i].name) || "";
        const why = (c.refs && c.refs.length ? `Like ${c.refs.slice(0, 3).join(", ")}` : "") || c.why || (set.directions && set.directions[i] && set.directions[i].why) || "";
        const ck = `${set.status}:${dir}:${why}:${c.done}`;
        if (el.dataset.k !== ck) {
          el.dataset.k = ck;
          const waiting = set.status === "making" && !c.done;
          el.classList.toggle("wait", waiting);
          el.innerHTML = `<div class="t"><span class="d">${esc(dir || (waiting ? `Variation ${i + 1}` : `Variation ${i + 1}`))}</span>${why ? `<span class="r" title="${esc(why)}">${esc(why)}</span>` : ""}</div>${set.status === "review" ? `<button class="vx-btn vx-keep">Keep</button>` : ""}`;
          const k = el.querySelector(".vx-keep");
          if (k) k.addEventListener("click", () => keep(set, c.id));
        }
      });
    }
    for (const [id, el] of captions) if (!want.has(id)) { el.remove(); captions.delete(id); }
    place();
  }

  function place() {
    const cam = host.cam;
    if (!cam) return;
    const list = shown();
    const s = list[list.length - 1] || null;
    const busy = host.moving && host.moving();
    const o = s && host.worldRectOf(s.original);
    if (o && !busy) {
      line.style.display = "flex";
      line.style.transform = `translate(${Math.round(o.x * cam.z + cam.x)}px,${Math.round((o.y + o.h) * cam.z + cam.y + 12)}px)`;
    } else line.style.display = "none";
    for (const set of list) {
    // Captions never cover each other or the status line: each stops 8 px short of the next one on its row.
    const boxes = set.copies.map((c) => ({ id: c.id, r: host.worldRectOf(c.id) })).filter((b) => b.r).map((b) => ({ id: b.id, p: captionLayout(b.r, cam, GAP) }));
    if (o && !busy) boxes.push({ id: "", p: { x: Math.round(o.x * cam.z + cam.x), y: Math.round((o.y + o.h) * cam.z + cam.y + 12), w: line.offsetWidth || 0 } });
    const room = (id) => {
      const me = boxes.find((b) => b.id === id);
      if (!me) return Infinity;
      const next = boxes.filter((b) => b !== me && b.p.x > me.p.x && Math.abs(b.p.y - me.p.y) < 48).map((b) => b.p.x);
      return next.length ? Math.min(...next) - me.p.x - 8 : Infinity;
    };
    for (const c of set.copies) {
      const el = captions.get(c.id), r = host.worldRectOf(c.id);
      if (!el) continue;
      if (!r || busy) { el.style.display = "none"; continue; }
      const p0 = captionLayout(r, cam, GAP), fit = Math.min(p0.w, room(c.id));
      const p = fit < p0.w ? { ...p0, w: fit, size: fit >= 160 ? "full" : fit >= 110 ? "short" : "keep" } : p0;
      // Small on screen: the references go, then the direction; with no Keep to show, nothing.
      if (p.size === "keep" && !el.querySelector(".vx-keep")) { el.style.display = "none"; continue; }
      if (el.dataset.size !== p.size) el.dataset.size = p.size;
      el.style.display = "flex";
      el.style.transform = `translate(${p.x}px,${p.y}px)`;
      el.style.width = `${p.w}px`;
    }
    }
  }
  host.on("cam", place);
  host.on("render", () => { if (sets.size) render(); });
  host.on("page", () => render());
  // Boards that moved or came back with an undo: a light check while something is up for review.
  setInterval(() => { if (shown().length || captions.size) render(); }, 500);

  // ---------- keys and commands ----------
  addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.repeat || e.defaultPrevented) return;
    if (typing(e.target) || (host.textEdit && host.textEdit.active)) return;
    e.preventDefault();
    make();
  });
  // Esc discards the set up for review (or stops and discards one being made), before Esc's select-parent.
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || typing(e.target) || sheet) return;
    if ((host.textEdit && host.textEdit.active) || (host.moving && host.moving())) return;
    const list = shown();
    const s = list[list.length - 1];
    if (!s) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    discard(s);
  }, true);
  host.on("cmd", (c) => {
    if (!c || c.cmd !== "variations") return;
    if (c.op === "make") make();
    else if (c.op === "brief") openBrief();
  });

  // ---------- the product brief ----------
  let sheet = null;
  async function openBrief() {
    if (sheet) return;
    let brief = null;
    try { brief = (await api(`/api/variations/brief?${q({ file })}`)).brief; } catch (e) { return tell(e.message); }
    const bg = document.createElement("div");
    bg.className = "vx-sheet-bg";
    bg.innerHTML = `<div class="vx-sheet" role="dialog" aria-label="Product brief"><div class="h">Product brief${brief && brief.drafted ? `<span class="n">Drafted by the agent</span>` : ""}</div><textarea placeholder="Product: what it is\nFor: who uses it\nPlatform: iOS, web\nTone: calm, playful"></textarea><div class="f"><button class="vx-btn vx-cancel">Cancel</button><button class="vx-btn vx-save">Save</button></div></div>`;
    for (const t of ["pointerdown", "pointermove", "pointerup", "mousedown", "click", "dblclick", "wheel", "contextmenu", "keydown"]) bg.addEventListener(t, (e) => e.stopPropagation());
    view.appendChild(bg);
    sheet = bg;
    const ta = bg.querySelector("textarea");
    ta.value = brief ? brief.text : "";
    const close = () => { bg.remove(); sheet = null; };
    const save = () => api(`/api/variations/brief`, { file, text: ta.value }).then(() => { close(); tell("Product brief saved"); }).catch((e) => tell(e.message));
    bg.querySelector(".vx-cancel").addEventListener("click", close);
    bg.querySelector(".vx-save").addEventListener("click", save);
    bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    });
    requestAnimationFrame(() => ta.focus());
  }

  host.variations = { make, openBrief, get sets() { return [...sets.values()]; }, keep: (setId, id) => keep(sets.get(setId), id), discard: (setId) => discard(sets.get(setId)) };
}
