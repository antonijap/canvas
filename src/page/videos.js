// Video cards on the page. The widget layer (widgets.js) owns the cards' DOM; this module feeds the GPU
// engine, which decides what plays with the same scheduler as shader cards (engine/src/shaders.rs: at most
// four shader and video cards at once, largest on screen first, inside one GPU budget; paused while the
// window is hidden; under Reduce Motion only on hover or when the person presses play).
//
// Per card: one <video> element while the card is near the view (dropped after it has been far away for a
// while, which frees its decoder), handed to the engine (setVideoElement), which calls play() and pause()
// and copies a frame only when the video's time moved. Until a card plays, its poster shows: a PNG of the
// frame at config.posterTime, cached in the package per file hash (made here from a separate, short-lived
// element when it is missing). A card linked to a node (config.link, "Embed video here") sits exactly over
// that node wherever its board goes. An element plays a proxy about the card's size on screen (src/videos.ts:
// /variant picks the tier; a 4K file never decodes at 4K for a card), swapped for another tier when a zoom
// changes the size the card needs.

const host = typeof window !== "undefined" ? window.canvasHost : null;

/** Video elements kept at once for cards in view (the engine plays at most four cards: engine/src/shaders.rs MAX_PLAYING). */
export const VIDEO_ELEMENTS = 4;
/** The card the engine hears the pointer over: none for a card the person paused, or hover would play it again. */
export const engineHover = (id, card) => (id && card && card.userPaused ? "" : id || "");
/**
 * Does a card play with sound: only when the person pressed play (autoplay and hover are silent), and then their
 * Mute / Unmute wins over the card's `muted` setting (unmuted null: they pressed neither).
 */
export const soundOn = (forced, unmuted, cfgMuted) => !!forced && (unmuted !== null && unmuted !== undefined ? !!unmuted : cfgMuted === false);
/**
 * Which cards keep a <video> element (each one holds a decoder and its frames): every forced or hovered card,
 * then the largest on screen up to `max`, cards that play on their own (autoplay, not paused) before the rest.
 * A card that has one keeps its place against a slightly larger one (25%), so cards of about the same size do
 * not trade elements as the camera moves.
 * items: [{ id, area (on-screen px², 0 when off screen), forced, hovered, has, plays }] -> Set of ids.
 */
export function pickVideoElements(items, max = VIDEO_ELEMENTS) {
  const out = new Set(items.filter((i) => i.forced || i.hovered).map((i) => i.id));
  const rest = items.filter((i) => !out.has(i.id) && i.area > 0).sort((a, b) => (b.plays !== false) - (a.plays !== false) || b.area * (b.has ? 1.25 : 1) - a.area * (a.has ? 1.25 : 1));
  for (const i of rest.slice(0, Math.max(0, max - out.size))) out.add(i.id);
  return out;
}

/** Proxy tiers (long side, px) the server makes (src/videos.ts PROXY_TIERS). */
export const PROXY_TIERS = [640, 960, 1280, 1920];
/** The tier a card `px` device px long on screen streams: the smallest that covers it, stretched at most 25% (src/videos.ts tierFor). */
export const proxyTier = (px) => PROXY_TIERS.find((t) => t * 1.25 >= px) ?? PROXY_TIERS[PROXY_TIERS.length - 1];

// After the constants above: start() reads them at once (the page's widgets are already known).
if (host && host.file) start(host);

function start(host) {
  const q = (p, extra = "") => p + "?file=" + encodeURIComponent(host.file) + extra;
  const RADIUS = 12;
  const NEAR = 1.0;          // keep an element for cards within one screen of the view
  const DROP_MS = 15000;     // and drop it after it has been far away this long
  const SPARE_MS = 3000;     // an element in view beyond the VIDEO_ELEMENTS largest cards goes after this long
  const cards = new Map();   // id -> card state
  let eng = null;
  let latest = [];           // video widgets on this page, in z-order
  let zOf = new Map();       // widget id -> its place among ALL the page's cards (shaders too): the engine's paint order
  let selected = null;
  let lastStats = null, lastStatsAt = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const fail = (code, message) => Object.assign(new Error(message), { code });

  // Elements live in the DOM (WebKit pauses detached media more eagerly), out of sight and out of the way.
  const shelf = document.createElement("div");
  shelf.setAttribute("aria-hidden", "true");
  shelf.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1";
  document.body.append(shelf);

  const streamUrl = (c, v) => q("/api/videos/" + encodeURIComponent(c.id) + "/stream", "&h=" + encodeURIComponent(c.hash || "") + (v && v !== "orig" ? "&v=" + encodeURIComponent(v) : ""));
  const posterUrl = (c) => q("/api/videos/" + encodeURIComponent(c.id) + "/poster", "&hash=" + c.hash + "&ms=" + c.posterMs);

  // ---------- geometry: a linked card follows its node ----------
  /** Where a video card shows: over its linked node when that node is drawn, else its own rect. */
  function displayRect(w) {
    const link = w && w.kind === "video" && w.config && w.config.link;
    if (link && host.worldRectOf) {
      const r = host.worldRectOf(link);
      if (r && r.w > 0 && r.h > 0) return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    const c = w?.kind === "video" && cards.get(w.id);
    if (c?.aspect && c.src === w.config?.src) return { x: w.x, y: w.y, w: w.w, h: Math.max(1, Math.round(w.w / c.aspect)) };
    return null;
  }
  host.widgetDisplayRect = displayRect;
  let relinkT = 0;
  function relink() {
    clearTimeout(relinkT);
    relinkT = setTimeout(() => {
      let moved = false;
      for (const c of cards.values()) {
        const r = displayRect(c.w);
        const key = r ? [r.x, r.y, r.w, r.h].join(",") : "";
        if (key !== c.linkKey) { c.linkKey = key; moved = true; }
      }
      if (moved) { if (host.widgetsRelayout) host.widgetsRelayout(); sync(); }
    }, 30);
  }
  host.on("render", relink);
  host.on("visible", relink);

  function setAspect(c, width, height) {
    if (width > 0 && height > 0 && c.aspect !== width / height) {
      c.aspect = width / height;
      host.widgetsRelayout?.();
      sync();
    }
  }
  function rectOf(c) { return c.dragRect || displayRect(c.w) || c.w; }
  /** Corner radius: a linked card takes its node's (the placeholder's rounded corners), else the card's. */
  function radiusOf(c, r) {
    const link = !c.dragRect && c.w.config && c.w.config.link;
    const nr = link && host.radiusOf ? host.radiusOf(link, r) : null;
    return typeof nr === "number" && nr > 0 ? nr : RADIUS;
  }
  /** On-screen area of a world rect, in CSS px² (0 off screen). */
  function screenArea(r) {
    const c = host.cam;
    if (!c) return 0;
    const x0 = Math.max(0, r.x * c.z + c.x), y0 = Math.max(0, r.y * c.z + c.y);
    const x1 = Math.min(host.view.clientWidth, (r.x + r.w) * c.z + c.x), y1 = Math.min(host.view.clientHeight, (r.y + r.h) * c.z + c.y);
    return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  }
  function nearView(r) {
    if (!host.cam) return false;
    const z = host.cam.z, vw = host.view.clientWidth / z, vh = host.view.clientHeight / z;
    const x0 = -host.cam.x / z - vw * NEAR, y0 = -host.cam.y / z - vh * NEAR;
    return r.x < x0 + vw * (1 + 2 * NEAR) && r.x + r.w > x0 && r.y < y0 + vh * (1 + 2 * NEAR) && r.y + r.h > y0;
  }

  // ---------- readings ----------
  function setReading(c, r) {
    const key = JSON.stringify(r);
    if (key === c.readingKey) return;
    c.readingKey = key;
    if (host.widgetReading) host.widgetReading(c.id, r);
  }
  function stat(id) { pollStats(); return lastStats && lastStats.byId.get(id); }
  function reading(c) {
    if (!c.src) return { state: "empty", display: "No file", frame: false };
    if (c.error) return { state: "error", error: { code: "media", message: c.error }, display: "Cannot play", frame: !!c.frame, poster: c.posterUrl || null };
    if (!eng && host.renderer === "pending") return { state: "loading", frame: false };
    if (!eng) return { state: "no-gpu", poster: c.posterUrl || null, display: "No WebGPU: still image", frame: false };
    const s = stat(c.id);
    const frame = !!(s && s.texture && (s.shows === "live" || s.shows === "frame" || s.shows === "bitmap"));
    c.frame = frame;
    const el = c.el;
    const t = el ? el.currentTime : 0, d = el && Number.isFinite(el.duration) ? el.duration : c.duration || 0;
    const playing = !!(s && s.playing);
    const display = playing ? "Playing" : c.userPaused ? "Paused" : c.w.config.autoplay === false ? "Still (plays on hover)" : "Still";
    return { state: "ok", frame, display, playing, time: Math.round(t * 10) / 10, duration: Math.round(d * 10) / 10 };
  }
  const refresh = () => { for (const c of cards.values()) setReading(c, reading(c)); };

  // ---------- elements ----------
  function makeEl(c, at = 0) {
    const el = document.createElement("video");
    el.muted = true;
    el.defaultMuted = true;
    el.playsInline = true;
    el.setAttribute("playsinline", "");
    el.setAttribute("muted", "");
    el.loop = c.w.config.loop !== false;
    el.preload = "metadata";
    el.disablePictureInPicture = true;
    el.addEventListener("loadedmetadata", () => { c.duration = el.duration; if (c.el === el) setAspect(c, el.videoWidth, el.videoHeight); host.requestFrame(); });
    el.addEventListener("loadeddata", () => host.requestFrame());
    el.addEventListener("seeked", () => { if (eng) eng.wantVideoFrame(c.id); host.requestFrame(); });
    el.addEventListener("ended", () => { if (c.forced) { c.forced = false; if (eng) eng.setVideoForced(c.id, false); } setReading(c, reading(c)); });
    el.addEventListener("error", () => { if (!el.getAttribute("src")) return; c.error = el.error ? mediaError(el.error.code) : "The file could not be played"; setReading(c, reading(c)); });
    if (at > 0) el.addEventListener("loadedmetadata", () => { try { el.currentTime = Math.min(at, Math.max(0, (el.duration || at) - 0.05)); } catch {} }, { once: true });
    shelf.append(el);
    c.tier = proxyTier(devicePx(c));
    c.variant = "";
    pickVariant(c, el);
    return el;
  }
  /** The card's long side on screen in device px (what its proxy tier is chosen by). */
  function devicePx(c) {
    const r = rectOf(c), z = host.cam ? host.cam.z : 1;
    return Math.round(Math.max(r.w, r.h) * z * (window.devicePixelRatio || 1));
  }
  /**
   * Ask the server which file `el` plays (a proxy about the card's size on screen, or the file itself) and set
   * its src. While the proxy it needs is being made the element has no src (the poster shows) and asks again;
   * a stand-in tier it got meanwhile is swapped for the right one once that is ready.
   */
  function pickVariant(c, el) {
    clearTimeout(c.variantT);
    fetch(q("/api/videos/" + encodeURIComponent(c.id) + "/variant", "&px=" + devicePx(c)))
      .then((r) => (r.ok ? r.json() : { v: "orig", tier: "orig" }))
      .catch(() => ({ v: "orig", tier: "orig" }))
      .then((a) => {
        if (c.el !== el) return;
        const v = a.v == null ? null : String(a.v);
        if (v && !c.variant) { c.variant = v; el.src = streamUrl(c, v); }
        else if (v && v !== c.variant) { swapEl(c); return; }
        if (!v || String(a.tier) !== v) c.variantT = setTimeout(() => { if (c.el === el) pickVariant(c, el); }, 1500);
      });
  }
  /** A new element for the card (another proxy tier), from the same time. */
  function swapEl(c) {
    const t = c.el ? c.el.currentTime : 0;
    dropEl(c);
    c.el = makeEl(c, t);
    if (eng) { eng.setVideoElement(c.id, c.el); eng.setVideoForced(c.id, c.forced); c.handed = c.el; }
  }
  function dropEl(c) {
    clearTimeout(c.variantT);
    if (!c.el) return;
    const el = c.el;
    c.el = null;
    if (eng) eng.setVideoElement(c.id, null);
    c.handed = null;
    try { el.pause(); } catch {}
    el.removeAttribute("src");
    try { el.load(); } catch {}
    el.remove();
  }
  const mediaError = (code) => ["", "Playback was stopped", "The file could not be read", "The video could not be decoded", "This file type cannot be played"][code] || "The file could not be played";

  // ---------- posters ----------
  let grabChain = Promise.resolve();
  /** One still frame from the card's file at time t, from a short-lived element (never the playing one). */
  function grab(url, t, maxSide) {
    const run = () => new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto";
      let done = false;
      const end = (f, x) => { if (done) return; done = true; clearTimeout(timer); v.removeAttribute("src"); try { v.load(); } catch {} v.remove(); f(x); };
      const timer = setTimeout(() => end(reject, fail("timeout", "The video did not load in time")), 15000);
      v.addEventListener("error", () => end(reject, fail("media", v.error ? mediaError(v.error.code) : "The file could not be played")));
      v.addEventListener("loadedmetadata", () => { v.currentTime = Math.max(0, Math.min(t, (v.duration || 0) - 0.05)); });
      v.addEventListener("seeked", async () => {
        try {
          const k = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
          const w = Math.max(1, Math.round(v.videoWidth * k)), h = Math.max(1, Math.round(v.videoHeight * k));
          const oc = new OffscreenCanvas(w, h);
          const g = oc.getContext("2d");
          g.imageSmoothingQuality = "high";
          g.drawImage(v, 0, 0, w, h);
          const blob = await oc.convertToBlob({ type: "image/png" });
          end(resolve, { blob, width: w, height: h, t: v.currentTime, duration: v.duration, native: [v.videoWidth, v.videoHeight] });
        } catch (e) { end(reject, e); }
      }, { once: true });
      v.src = url;
      shelf.append(v);
    });
    const p = grabChain.then(run, run);
    grabChain = p.catch(() => {});
    return p;
  }

  async function showPoster(c) {
    const key = c.hash + ":" + c.posterMs;
    if (!c.hash || c.posterKey === key) return;
    c.posterKey = key;
    const url = posterUrl(c);
    try {
      let r = await fetch(url);
      if (r.status === 404) {
        // None yet: make it (the frame at posterTime, at most 1024 px) and store it for every later load.
        const g = await grab(streamUrl(c), c.posterMs / 1000, 1024);
        if (c.posterKey !== key) return;
        await fetch(url, { method: "PUT", headers: { "x-canvas": "1", "content-type": "image/png" }, body: g.blob });
        r = new Response(g.blob);
      } else if (!r.ok) return;
      const blob = await r.blob();
      if (c.posterKey !== key || cards.get(c.id) !== c) return;
      c.posterUrl = url;
      const bm = await createImageBitmap(blob);
      if (c.posterKey !== key || cards.get(c.id) !== c) { bm.close(); return; }
      if (!c.aspect) setAspect(c, bm.width, bm.height);
      if (eng) {
        // A frame of the video itself (it played, or a seek) is newer than the poster.
        const s = stat(c.id);
        if (eng && cards.get(c.id) === c && !(s && (s.shows === "live" || s.shows === "frame"))) { eng.setShaderPoster(c.id, bm); host.requestFrame(); }
      }
      bm.close();
      setReading(c, reading(c));
    } catch (e) {
      if (c.posterKey === key) c.posterKey = "";
      console.warn("[canvas] video poster", c.id, e && e.message);
    }
  }

  // ---------- keep the engine's cards in line with the widgets ----------
  function sync() {
    const ids = new Set(latest.map((w) => w.id));
    for (const [id, c] of cards) if (!ids.has(id)) { dropEl(c); if (eng) eng.removeShader(id); cards.delete(id); }
    const now = performance.now();
    // First the records (a card added just now included), then which cards get an element.
    for (const w of latest) {
      let c = cards.get(w.id);
      if (!c) { c = { id: w.id, w, el: null, src: "", hash: "", posterMs: 1000, posterKey: "", posterUrl: "", readingKey: "", linkKey: "", dropAt: 0, forced: false, userPaused: false, unmuted: null, error: "", duration: 0, frame: false, dragRect: null }; cards.set(w.id, c); }
      c.w = w;
      const cfg = w.config || {};
      const src = cfg.src || "";
      if (src !== c.src || (cfg.hash || "") !== c.hash) {
        dropEl(c);
        c.src = src; c.aspect = 0; c.hash = cfg.hash || ""; c.error = ""; c.posterKey = ""; c.posterUrl = "";
        if (src && !c.hash) fetch(q("/api/videos/" + encodeURIComponent(c.id) + "/hash"), { method: "POST", headers: { "x-canvas": "1" } }).then((r) => r.arrayBuffer()).catch(() => {});
      }
      const pms = Math.round((cfg.posterTime ?? 1) * 1000);
      if (pms !== c.posterMs) { c.posterMs = pms; c.posterKey = ""; }
    }
    // Elements only for the cards that can play: the largest in view, and any the person pressed play on or hovers.
    const keep = pickVideoElements(latest.map((w) => cards.get(w.id)).filter((c) => c.src && !c.error).map((c) => ({ id: c.id, area: screenArea(rectOf(c)), forced: c.forced, hovered: !!c.hoverId, has: !!c.el, plays: (c.w.config || {}).autoplay !== false && !c.userPaused })));
    latest.forEach((w, i) => {
      const c = cards.get(w.id), cfg = w.config || {};
      const r = rectOf(c);
      // The element: made when the card is one of those that can play, dropped a while after it no longer is
      // (soon when it is in view behind larger cards, later when it went far away: the camera may come back).
      if (c.src && !c.error && keep.has(c.id)) {
        c.dropAt = 0;
        if (!c.el) c.el = makeEl(c);
        // Zoomed to another proxy tier: the element plays the file for the new size (sharper, or lighter).
        else if (c.variant && c.variant !== "orig" && proxyTier(devicePx(c)) !== c.tier) swapEl(c);
      } else if (c.el && !c.forced) {
        const at = now + (nearView(r) ? SPARE_MS : DROP_MS);
        if (!c.dropAt || c.dropAt > at) c.dropAt = at;
        // Its still goes back to the poster (the engine forgets the element's frame with the element).
        if (now >= c.dropAt) { dropEl(c); c.dropAt = 0; c.posterKey = ""; lastStatsAt = 0; }
      }
      if (c.el) {
        c.el.loop = cfg.loop !== false;
        // Sound only when the person pressed play and the card is not muted (autoplay and hover are silent).
        const sound = soundOn(c.forced, c.unmuted, cfg.muted);
        if (c.el.muted === sound) c.el.muted = !sound;
      }
      if (eng) {
        eng.setVideoCard(w.id, r.x, r.y, r.w, r.h, zOf.get(w.id) ?? i, cfg.autoplay !== false && !c.userPaused, radiusOf(c, r));
        // Handing an element over resets the engine's frame bookkeeping: only when it changed.
        if (c.handed !== c.el) { eng.setVideoElement(w.id, c.el || null); eng.setVideoForced(w.id, c.forced); c.handed = c.el; }
      }
      if (c.src) showPoster(c);
      setReading(c, reading(c));
    });
    if (eng) host.requestFrame();
    // A far card's element goes DROP_MS after it left, also when nothing else calls sync by then (the camera stopped).
    clearTimeout(dropT);
    let due = Infinity;
    for (const c of cards.values()) if (c.el && c.dropAt && !c.forced) due = Math.min(due, c.dropAt - now);
    if (due < Infinity) dropT = setTimeout(sync, Math.max(0, due) + 50);
  }
  let dropT = 0;
  function onWidgets(list) {
    zOf = new Map((list || []).map((w, i) => [w.id, i]));
    latest = (list || []).filter((w) => w.kind === "video");
    for (const c of cards.values()) c.dragRect = null;
    sync();
  }

  // ---------- engine on, engine gone ----------
  function attach() {
    const v = host.engineView;
    const next = v ? v.engine : null;
    if (next === eng) return;
    eng = next;
    for (const c of cards.values()) { c.posterKey = ""; c.handed = undefined; }
    if (eng) running();
    sync();
  }
  function running() { if (eng) { eng.setShadersRunning(!document.hidden, !reduce.matches); host.requestFrame(); } }
  document.addEventListener("visibilitychange", () => { running(); sync(); });
  reduce.addEventListener("change", running);
  host.on("cam", () => { clearTimeout(camT); camT = setTimeout(sync, 200); });
  let camT = 0;

  function pollStats() {
    if (!eng) return;
    const now = performance.now();
    if (now - lastStatsAt < 100) return;
    lastStatsAt = now;
    try { const s = eng.shaderStats(); s.byId = new Map(s.cards.map((x) => [x.id, x])); lastStats = s; } catch {}
  }
  setInterval(() => { if (cards.size) refresh(); }, 500);

  // ---------- the person: hover, controls, Space ----------
  const api = {
    /** Pointer over card `id` (empty: none). Hover plays a still card from the start, silent. */
    hover(id, x, y) {
      if (!eng) return;
      const c = id && cards.get(id);
      if (c && c.el && !(stat(id) || {}).playing && !c.forced && !c.userPaused && c.hoverId !== id) { try { c.el.currentTime = 0; } catch {} }
      const fresh = c && c.hoverId !== id;
      for (const o of cards.values()) o.hoverId = o === c ? id : "";
      // A card without an element (beyond the largest few) gets one for the hover.
      if (fresh && !c.el && c.src) sync();
      eng.setShaderHover(engineHover(id, c), x || 0, y || 0, false);
      host.requestFrame();
    },
    state(id) {
      const c = cards.get(id);
      if (!c) return null;
      const s = stat(id), el = c.el;
      return { playing: !!(s && s.playing), forced: c.forced, paused: c.userPaused, time: el ? el.currentTime : 0, duration: el && Number.isFinite(el.duration) ? el.duration : c.duration || 0, muted: el ? el.muted : true, ready: !!(el && el.readyState >= 1), error: c.error };
    },
    toggle(id) {
      const c = cards.get(id);
      if (!c || !eng) return;
      const playing = !!(stat(id) || {}).playing;
      if (playing) { c.forced = false; c.userPaused = true; }
      else {
        c.forced = true; c.userPaused = false;
        if (c.el && c.el.ended) { try { c.el.currentTime = 0; } catch {} }
      }
      if (!c.el && c.src) c.el = makeEl(c);
      eng.setVideoForced(id, c.forced);
      // The pointer is still over it: Pause takes the hover away from the engine (Play gives it back).
      if (c.hoverId === id) eng.setShaderHover(engineHover(id, c), 0, 0, false);
      lastStatsAt = 0;
      sync();
    },
    seek(id, t) {
      const c = cards.get(id);
      if (!c || !c.el) return;
      try { c.el.currentTime = Math.max(0, t); } catch {}
    },
    mute(id, muted) {
      const c = cards.get(id);
      if (!c) return;
      c.unmuted = !muted;
      if (!muted && !c.forced) { api.toggle(id); return; }
      sync();
    },
    retry(id) {
      const c = cards.get(id);
      if (!c?.src) return;
      c.error = "";
      c.posterKey = "";
      dropEl(c);
      c.el = makeEl(c);
      setReading(c, { state: "loading", frame: false });
      sync();
    },
    stats: () => (eng ? eng.shaderStats() : null),
    cards: () => [...cards.values()].map((c) => ({ id: c.id, src: c.src, hash: c.hash, el: !!c.el, readyState: c.el ? c.el.readyState : -1, forced: c.forced, error: c.error, poster: !!c.posterUrl })),
  };
  window.canvasVideos = api;

  // Only a card selected on its own takes Space: with several selected, Space is the hand tool (like a layer's).
  host.on("select", (id) => { const many = host.selection && host.selection().length > 1; selected = !many && typeof id === "string" && id.startsWith("widget:") ? id.slice(7) : null; mark(); });
  host.on("deselect", () => { selected = null; mark(); });
  function mark() {
    for (const el of document.querySelectorAll(".wd.vfocus")) el.classList.remove("vfocus");
    if (selected && cards.has(selected)) { const el = document.querySelector('.wd[data-id="widget:' + CSS.escape(selected) + '"]'); if (el) el.classList.add("vfocus"); }
  }
  // Space plays or pauses the selected video card (instead of the hand tool).
  addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey || !selected || !cards.has(selected)) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) api.toggle(selected);
  }, true);
  addEventListener("keyup", (e) => { if (e.code === "Space" && selected && cards.has(selected)) e.stopImmediatePropagation(); }, true);

  // "Embed video here" (the shell's right-click menu or inspector): a card exactly over the node, linked to it.
  host.on("cmd", async (c) => {
    if (c.cmd !== "embedVideo") return;
    const r = host.worldRectOf(c.node);
    if (!r) { host.post({ toast: "That node is not drawn on the canvas." }); return; }
    try {
      const first = host.pages && host.pages[0] && host.pages[0].id;
      const res = await fetch(q("/api/videos"), { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ path: c.path, copy: c.copy !== false, x: r.x, y: r.y, w: r.w, h: r.h, link: c.node, ...(host.page && host.page !== first ? { page: host.page } : {}) }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || res.statusText);
      host.post({ toast: "Video embedded" });
      setTimeout(() => host.selectId("widget:" + j.widget.id), 50);
    } catch (e) { host.post({ toast: "Could not embed the video: " + e.message }); }
  });
  host.on("widgets", onWidgets);
  host.on("widgetMove", ({ id, rect }) => {
    const c = cards.get(id);
    if (!c) return;
    c.dragRect = rect && !(rect.x === c.w.x && rect.y === c.w.y && rect.w === c.w.w && rect.h === c.w.h) ? rect : null;
    if (!eng) return;
    const r = rectOf(c), i = latest.findIndex((w) => w.id === id);
    eng.setVideoCard(id, r.x, r.y, r.w, r.h, zOf.get(id) ?? i, (c.w.config || {}).autoplay !== false && !c.userPaused, radiusOf(c, r));
    host.requestFrame();
  });
  host.on("renderer", attach);
  if (host.widgetsShown) onWidgets(host.widgetsShown());
  attach();

  // ---------- agents: one frame at time t ----------
  host.videoFrame = async (a) => {
    const c = cards.get(a.id);
    const w = c ? c.w : null;
    if (!c && !(host.widgetsShown ? host.widgetsShown() : []).some((x) => x.id === a.id)) throw fail("not_found", 'No video card "' + a.id + '" on this page');
    if (w && !(w.config || {}).src) return { ok: false, note: "This video card has no file." };
    const g = await grab(q("/api/videos/" + encodeURIComponent(a.id) + "/stream"), a.t ?? 1, a.maxSide ?? 768);
    const s = stat(a.id);
    return { ok: true, t: Math.round(g.t * 1000) / 1000, duration: g.duration, width: g.width, height: g.height, native: g.native, image: await toBase64(g.blob), playing: !!(s && s.playing) };
  };
}

async function toBase64(blob) {
  const b = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
