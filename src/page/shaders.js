// Shader cards on the page. The widget layer (widgets.js) owns the cards' DOM; this module feeds the GPU
// engine: each card's rect, its WGSL (fetched when its revision changes), hover, the window's visibility
// and Reduce Motion. The engine decides which cards play (engine/src/shaders.rs). Compiles run one at a
// time; a cached poster (the frame at t = 2 s, a PNG in the package) shows until a card plays, and is made
// here when it is missing.
//
// Safety: a shader is untrusted GPU code. A card is in a "risk window" from the moment its source goes to
// the GPU until its first frames are through; the ids in that window are written to localStorage
// synchronously before the compile starts. If the GPU device is lost, the cards that were in the window or
// drawing are quarantined (config.quarantined, written to the package) before anything else runs; if the
// page died instead, the next load finds the ids still in localStorage and quarantines them before it
// compiles anything. A quarantined card never compiles until someone presses Run (or its source changes).

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const q = (p, extra = "") => p + "?file=" + encodeURIComponent(host.file) + extra;
  // One key per page session, with a heartbeat: another window on the same file has its own key, so its
  // compiles never look like a crash here. A key whose heartbeat stopped belongs to a page that died.
  const RISK_PREFIX = "canvas:shader-risk:" + host.file + ":";
  const RISK_KEY = RISK_PREFIX + Math.random().toString(36).slice(2, 10);
  const RADIUS = 12;
  const cards = new Map(); // id -> card state (below)
  let eng = null;          // the engine while the page draws with it
  let latest = [];         // the shader widgets on this page, in z-order
  let zOf = new Map();     // widget id -> its place among ALL the page's cards (videos too): the engine's paint order
  let lastStats = null, lastStatsAt = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (code, message) => Object.assign(new Error(message), { code });

  // ---------- risk window (localStorage, synchronous) ----------
  /** Ids in the risk windows of pages that stopped beating (crashed, killed, lost their GPU). Adopted here. */
  const readRisk = () => {
    const out = [];
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(RISK_PREFIX) || k === RISK_KEY) continue;
        const v = JSON.parse(localStorage.getItem(k) || "null");
        if (v && Date.now() - (v.beat || 0) < 5000) continue; // a live window
        if (v && Array.isArray(v.ids)) out.push(...v.ids.filter((x) => typeof x === "string"));
        localStorage.removeItem(k);
      }
    } catch {}
    return [...new Set(out)];
  };
  // id -> time it entered the window; 0 = a suspect that must be quarantined before it runs (it was in a
  // window when the last session ended, or when the device was lost).
  const risk = new Map(readRisk().map((id) => [id, 0]));
  const saveRisk = (gone = false) => { try { if (risk.size) localStorage.setItem(RISK_KEY, JSON.stringify({ ids: [...risk.keys()], beat: gone ? 0 : Date.now() })); else localStorage.removeItem(RISK_KEY); } catch {} };
  setInterval(() => { if (risk.size) saveRisk(); adoptStale(); }, 1000);
  // A normal unload: what was merely starting did not take the page down; suspects (0) stay for the next load.
  addEventListener("pagehide", () => { for (const [id, at] of risk) if (at) risk.delete(id); saveRisk(true); });
  const riskBase = new Map(); // id -> renders the engine had counted when the window opened
  const enterRisk = (id) => {
    const s = lastStats && lastStats.byId.get(id);
    riskBase.set(id, s ? s.renders : 0);
    risk.set(id, performance.now());
    saveRisk();
  };
  /** Another live window is in a risk window with this card right now. */
  const othersHave = (id) => {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(RISK_PREFIX) || k === RISK_KEY) continue;
        const v = JSON.parse(localStorage.getItem(k) || "null");
        if (v && Date.now() - (v.beat || 0) < 5000 && Array.isArray(v.ids) && v.ids.includes(id)) return true;
      }
    } catch {}
    return false;
  };
  /** Windows that stopped beating since: their cards become suspects here. */
  function adoptStale() {
    let added = false;
    for (const id of readRisk()) if (!risk.has(id)) { risk.set(id, 0); added = true; }
    if (added) { saveRisk(); sync(); }
  }
  const leaveRisk = (id) => { if (risk.delete(id)) saveRisk(); };
  saveRisk();
  if (risk.size) console.warn("[canvas] shaders that were running when the last session ended:", [...risk.keys()].join(", "));

  const put = (id, body) => fetch(q("/api/shaders/" + encodeURIComponent(id)), { method: "PUT", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.ok);
  async function quarantine(ids, why) {
    if (!ids.length) return;
    console.warn("[canvas] shader quarantine (" + why + "):", ids.join(", "));
    // Written down first: if this page dies before the server answers, the next load finishes the job.
    for (const id of ids) risk.set(id, 0);
    saveRisk();
    await Promise.all(ids.map((id) => put(id, { quarantined: true }).then((ok) => { if (ok) leaveRisk(id); }).catch(() => {})));
  }

  // ---------- readings (what the card and the inspector show) ----------
  function setReading(c, r) {
    const key = JSON.stringify(r);
    if (key === c.readingKey) return;
    c.readingKey = key;
    if (host.widgetReading) host.widgetReading(c.id, r);
  }
  function reading(c) {
    const st = lastStats && lastStats.byId.get(c.id);
    const frame = !!(st && st.texture && st.shows);
    if (!eng && host.renderer === "pending") return { state: "loading", frame: false };
    if (!eng) return { state: c.quarantined ? "quarantined" : "no-gpu", poster: c.posterUrl || null, display: c.quarantined ? "Stopped after a GPU reset" : "No WebGPU: still image" };
    if (c.quarantined) return { state: "quarantined", frame, display: "Stopped after a GPU reset", error: { code: "quarantined", message: "This shader was running when the GPU reset. Press Run to try it again." } };
    if (c.errors && c.errors.length) {
      const first = c.errors[0];
      return { state: "error", frame, errors: c.errors, error: { code: "compile", message: c.errors.map((e) => (e.line ? "Line " + e.line + (e.col ? ":" + e.col : "") + ": " : "") + e.message).join("\n") }, display: first.line ? "Error on line " + first.line : "Error" };
    }
    if (c.loadError) return { state: "error", frame, error: { code: "source", message: c.loadError }, display: "Could not load the source" };
    if (!c.done) return { state: "loading", frame };
    const display = !st ? "" : st.playing ? "Playing" : c.w.config.autoplay === false ? "Still (plays on hover)" : st.msPerMpx === 0 ? "Measuring" : "Still";
    return { state: "ok", frame, display, updatedAt: c.doneAt };
  }
  const refresh = () => { for (const c of cards.values()) setReading(c, reading(c)); };

  // ---------- one compile at a time ----------
  let chain = Promise.resolve();
  const queue = (fn) => { chain = chain.then(fn, fn).then(() => new Promise((r) => requestAnimationFrame(() => r()))); return chain; };

  async function load(c) {
    const seq = ++c.seq;
    // A card removed meanwhile (its page left, the widget deleted) is not the one the engine now shows under its
    // id: a new record took the id, and an old fetch must not hand the engine the old source.
    const live = () => seq === c.seq && cards.get(c.id) === c;
    c.done = false;
    c.errors = [];
    let src, rev;
    try {
      const r = await fetch(q("/api/shaders/" + encodeURIComponent(c.id) + "/source"));
      if (!r.ok) throw new Error("HTTP " + r.status);
      src = await r.text();
      rev = r.headers.get("x-shader-rev") || "";
    } catch (e) {
      console.warn("[canvas] shader source", c.id, e && e.message);
      if (!live()) return;
      // Said on the card (not "Compiling" for good), and tried again a few times, further apart each time; after
      // that the next change to the card tries again.
      c.loadError = "Could not load the shader's source (" + ((e && e.message) || "network error") + ")";
      c.tries = (c.tries || 0) + 1;
      setReading(c, reading(c));
      if (c.tries <= 5) setTimeout(() => { if (live()) load(c); }, Math.min(8000, 500 * 2 ** (c.tries - 1)));
      else c.rev = null;
      return;
    }
    c.loadError = null;
    c.tries = 0;
    if (!live() || !eng) return;
    c.srcRev = rev;
    showPoster(c, rev);
    await queue(async () => {
      if (!live() || !eng || c.quarantined) return;
      // A window that is starting this card right now, or that just died with it: wait until it is through
      // its risk window, or until its heartbeat stops and the card becomes a suspect here.
      if (othersHave(c.id)) {
        await waitFor(() => !othersHave(c.id), 6000);
        adoptStale();
        if (!live() || risk.get(c.id) === 0) return;
      }
      enterRisk(c.id);
      let res;
      try { res = await eng.setShaderSource(c.id, src); } catch (e) { res = { ok: false, errors: [{ line: 0, col: 0, message: String(e && e.message || e) }] }; }
      if (!live() || res.stale) return;
      c.errors = res.errors || [];
      c.done = true;
      c.doneAt = Date.now();
      // A source that did not compile never ran: nothing to watch.
      if (!res.ok) leaveRisk(c.id);
      setReading(c, reading(c));
      host.requestFrame();
      if (res.ok && !c.posterCached) makePoster(c, rev);
    });
  }

  async function showPoster(c, rev) {
    if (!rev || c.posterRev === rev) return;
    c.posterRev = rev;
    c.posterCached = false;
    const url = q("/api/shaders/" + encodeURIComponent(c.id) + "/poster", "&rev=" + rev);
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const blob = await r.blob();
      c.posterCached = true;
      c.posterUrl = url;
      if (!eng) { setReading(c, reading(c)); return; }
      const bm = await createImageBitmap(blob);
      if (eng && c.posterRev === rev && cards.get(c.id) === c) { eng.setShaderPoster(c.id, bm); host.requestFrame(); }
      bm.close();
    } catch {}
  }

  /** The frame at t = 2 s as a PNG beside the source, for still cards, the DOM fallback and agents. */
  function makePoster(c, rev) {
    queue(async () => {
      if (!eng || c.srcRev !== rev || c.posterCached || cards.get(c.id) !== c) return;
      await waitFor(() => !eng || lastCard(c.id, (s) => s.msPerMpx > 0), 4000);
      if (!eng || c.srcRev !== rev || cards.get(c.id) !== c) return;
      try {
        const f = await eng.renderShaderFrame(c.id, 2.0, 512, true);
        const png = await encodePng(f.width, f.height, f.pixels);
        const r = await fetch(q("/api/shaders/" + encodeURIComponent(c.id) + "/poster", "&rev=" + rev), { method: "PUT", headers: { "x-canvas": "1", "content-type": "image/png" }, body: png });
        if (r.ok) { c.posterCached = true; c.posterUrl = q("/api/shaders/" + encodeURIComponent(c.id) + "/poster", "&rev=" + rev); }
      } catch (e) { console.warn("[canvas] shader poster", c.id, e && e.message); }
    });
  }

  async function waitFor(pred, ms) {
    const end = performance.now() + ms;
    while (!pred()) { if (performance.now() > end) return false; await sleep(50); }
    return true;
  }
  function lastCard(id, f) { pollStats(); const s = lastStats && lastStats.byId.get(id); return !!(s && f(s)); }

  // ---------- keep the engine's cards in line with the widgets ----------
  function sync() {
    const ids = new Set(latest.map((w) => w.id));
    for (const [id, c] of cards) if (!ids.has(id)) { c.seq++; if (eng) eng.removeShader(id); cards.delete(id); leaveRisk(id); }
    latest.forEach((w, i) => {
      let c = cards.get(w.id);
      if (!c) { c = { id: w.id, w, seq: 0, rev: null, srcRev: "", done: false, errors: [], quarantined: false, posterRev: "", posterCached: false, posterUrl: "", readingKey: "" }; cards.set(w.id, c); }
      c.w = w;
      const cfg = w.config || {};
      const wasQ = c.quarantined;
      const suspect = risk.get(w.id) === 0 && cfg.quarantined !== true;
      if (suspect && !c.asked) { c.asked = true; quarantine([w.id], "it was running when the last session ended or the GPU reset"); }
      if (!suspect) c.asked = false;
      c.quarantined = cfg.quarantined === true || suspect;
      if (!eng) {
        if (host.renderer === "pending") return;
        // DOM renderer: the poster as an image, nothing runs.
        if (cfg.rev && c.posterRev !== cfg.rev) showPoster(c, cfg.rev);
        setReading(c, reading(c));
        return;
      }
      if (c.quarantined && !wasQ) {
        // Drop whatever this card had compiled: it must not run again until Run.
        eng.removeShader(w.id);
        c.paramsKey = null;
        c.seq++;
        c.rev = null;
        c.done = false;
      }
      eng.setShaderCard(w.id, w.x, w.y, w.w, w.h, zOf.get(w.id) ?? i, cfg.autoplay !== false, RADIUS);
      // u.params: a Paper preset card's packed uniforms (src/paper.ts); a slider moves without a compile.
      const pk = Array.isArray(cfg.uniforms) ? cfg.uniforms.join(",") : "";
      if (pk !== c.paramsKey && eng.setShaderParams) { eng.setShaderParams(w.id, new Float32Array(Array.isArray(cfg.uniforms) ? cfg.uniforms : [])); c.paramsKey = pk; }
      if (c.quarantined) { if (cfg.rev) showPoster(c, cfg.rev); }
      else if (c.rev !== (cfg.rev || "") || (wasQ && !c.quarantined)) { c.rev = cfg.rev || ""; load(c); }
      setReading(c, reading(c));
    });
    if (eng) host.requestFrame();
  }

  function onWidgets(list) {
    zOf = new Map((list || []).map((w, i) => [w.id, i]));
    latest = (list || []).filter((w) => w.kind === "shader");
    sync();
  }

  // ---------- engine on, engine gone ----------
  function attach() {
    const v = host.engineView;
    const next = v ? v.engine : null;
    if (next === eng) return;
    const lost = eng && !next && /lost/i.test(host.rendererNote || "");
    if (lost) {
      // Whatever was compiling, starting or drawing when the device went away.
      const now = performance.now();
      const drawing = lastStats ? lastStats.cards.filter((s) => s.lastRenderAt && now - s.lastRenderAt < 3000).map((s) => s.id) : [];
      const ids = [...new Set([...risk.keys(), ...drawing])].filter((id) => cards.has(id) && !cards.get(id).quarantined);
      for (const id of ids) { const c = cards.get(id); c.quarantined = true; c.asked = true; }
      quarantine(ids, "GPU device lost");
    }
    eng = next;
    for (const c of cards.values()) { c.seq++; c.rev = null; c.done = false; c.posterRev = ""; c.paramsKey = null; }
    if (eng) running();
    sync();
  }
  function running() { if (eng) { eng.setShadersRunning(!document.hidden, !reduce.matches); host.requestFrame(); } }
  document.addEventListener("visibilitychange", running);
  reduce.addEventListener("change", running);

  // ---------- stats: playing state, risk windows closing ----------
  function pollStats() {
    if (!eng) return;
    const now = performance.now();
    if (now - lastStatsAt < 100) return;
    lastStatsAt = now;
    try {
      const s = eng.shaderStats();
      s.byId = new Map(s.cards.map((x) => [x.id, x]));
      lastStats = s;
    } catch {}
  }
  setInterval(() => {
    if (!eng || !cards.size) return;
    pollStats();
    if (!lastStats) return;
    const now = performance.now();
    for (const [id, at] of risk) {
      const s = lastStats.byId.get(id);
      // The cost probe (three frames) or three live frames through, and a second gone by: the risky part
      // (first compile, first frames) is over.
      if (at && s && s.status === "ready" && (s.renders >= (riskBase.get(id) || 0) + 3 || (s.msPerMpx > 0 && now - at > 1500)) && now - at > 1000) leaveRisk(id);
      else if (at && s && s.status === "error") leaveRisk(id);
    }
    refresh();
  }, 500);

  // ---------- hover, live moves ----------
  window.canvasShaders = {
    hover(id, x, y, pressed) { if (eng) { eng.setShaderHover(id || "", x, y, !!pressed); host.requestFrame(); } },
    retry(id) {
      const c = cards.get(id);
      if (!c) return;
      c.loadError = null;
      c.tries = 0;
      return load(c);
    },
    stats: () => (eng ? eng.shaderStats() : null),
    get risk() { return [...risk.keys()]; },
    cards: () => [...cards.values()].map((c) => ({ id: c.id, rev: c.rev, srcRev: c.srcRev, seq: c.seq, done: c.done, quarantined: c.quarantined, errors: c.errors.length })),
  };
  host.on("widgets", onWidgets);
  host.on("widgetMove", ({ id, rect }) => {
    const i = latest.findIndex((w) => w.id === id);
    if (!eng || i < 0) return;
    const w = latest[i];
    eng.setShaderCard(id, rect.x, rect.y, rect.w, rect.h, zOf.get(id) ?? i, (w.config || {}).autoplay !== false, RADIUS);
    host.requestFrame();
  });
  host.on("renderer", attach);
  if (host.widgetsShown) onWidgets(host.widgetsShown());
  attach();

  // ---------- agents: one frame at time t, the compile result and the cost ----------
  host.shaderFrame = async (a) => {
    const end = performance.now() + (a.waitMs ?? 8000);
    for (;;) {
      const c = cards.get(a.id);
      if (c && c.quarantined) return { ok: false, quarantined: true, errors: [], note: "Quarantined after a GPU reset: it will not run until someone presses Run or its source changes." };
      if (c && c.done && (!a.rev || c.srcRev === a.rev)) break;
      if (!eng && c) return { ok: false, errors: [], note: "This page has no WebGPU, so nothing was compiled." };
      if (performance.now() > end) throw fail("timeout", c ? "The shader did not finish compiling in time" : 'No shader card "' + a.id + '" on this page');
      await sleep(40);
    }
    const c = cards.get(a.id);
    if (c.errors.length) return { ok: false, errors: c.errors };
    const f = await eng.renderShaderFrame(a.id, a.t ?? 2, a.maxSide ?? 512, true);
    const png = await encodePng(f.width, f.height, f.pixels);
    pollStats();
    const s = lastStats && lastStats.byId.get(a.id);
    const dpr = window.devicePixelRatio || 1;
    const side = Math.max(c.w.w, c.w.h) * dpr, k = Math.min(1, 1024 / side);
    const mpx = (c.w.w * dpr * k) * (c.w.h * dpr * k) / 1e6;
    const predicted = 0.05 + f.msPerMpx * mpx;
    return {
      ok: true, errors: [], t: a.t ?? 2, width: f.width, height: f.height, image: await toBase64(png),
      cost: { msPerFrame: round(f.msPerFrame), msPerMpx: round(f.msPerMpx), predictedMsAtCardSize: round(predicted), budgetMs: 4, autoplayFits: predicted <= 4, timing: f.timing },
      playing: !!(s && s.playing),
    };
  };
}

const round = (x) => Math.round(x * 1000) / 1000;

async function encodePng(w, h, pixels) {
  const oc = new OffscreenCanvas(w, h);
  oc.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), w, h), 0, 0);
  return oc.convertToBlob({ type: "image/png" });
}

async function toBase64(blob) {
  const b = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
