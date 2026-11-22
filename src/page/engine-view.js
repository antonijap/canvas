// The page's GPU board renderer: one <canvas> under the overlays, drawn by the WASM engine (engine/,
// API in engine/API.md). The page script keeps the camera, selection, titles, widgets and every
// overlay as DOM and asks this module for pixels, hit tests and node rectangles.
//
// createEngineView() resolves to the view object or throws; the page falls back to the DOM
// renderer on any throw, and calls onLost when the GPU device goes away later (the page then starts a new
// engine, and falls back to the DOM only when that keeps happening: engineRestartDelay below).
// The pure helpers at the bottom are imported by node tests too.

/** What an image is decoded at while boards show it large, but not larger than this on screen. */
export const MAX_IMAGE_SIDE = 2048;
/**
 * The largest decode: an image in view drawn at more than MAX_IMAGE_SIDE device px (a full-page screenshot at
 * 100%, a photo zoomed into) is decoded in steps (IMAGE_CAPS) up to its own pixels, at most FULL_IMAGE_PX of them
 * (128 MB decoded) and FULL_IMAGE_SIDE long. The engine draws it from tiles (engine/src/images.rs). Capped at
 * 2048 px on the long side, a 1200 x 8000 screenshot was drawn from 307 x 2048 px.
 */
export const FULL_IMAGE_SIDE = 16384;
export const FULL_IMAGE_PX = 32e6;
/**
 * The long sides an image is decoded at, smallest first (above 2048 each step holds twice the pixels of the last).
 * One step from 2048 straight to its own pixels gave every full-page screenshot on an overview (1920 device px
 * tall, 0.4 Mpx on screen) a 32 Mpx decode: 30 of them, 3.8 GB.
 */
export const IMAGE_CAPS = [64, 128, 256, 512, 2048, 2896, 4096, 5792, 8192, 11584, 16384];
/** Decoded bytes of all images together: past it, images out of view go small and the ones in view give way (planImageDecodes). */
export const IMAGE_BUDGET = 768 << 20;
/** What an image is decoded at while no board shows it large (the engine's 512 level). */
export const SMALL_IMAGE_SIDE = 512;

/**
 * Start the engine on a new canvas inserted as the first child of `view`.
 * opts: { view, api(path) -> url with ?file=, onChange() (a frame is wanted), onLost(reason), getCam() -> {x, y, z},
 *         waitForGpu: fence startup work before the first native frame,
 *         isIdle() -> false while the camera moves, posOf(id) -> {x, y} where the page has the board now,
 *         orderOf(id) -> its index in the document (paint order), onLayout() (boards were laid out again),
 *         rebase(id, scene, fetchedAt) -> true when it put live edits on a server scene (src/page/live.js) }
 */
export async function createEngineView({ view, api, sceneEnv = "", waitForGpu = false, onChange, onLost, getCam, isIdle = () => true, posOf = () => null, orderOf = () => 0, onLayout = () => {}, rebase = () => false }) {
  if (!navigator.gpu) throw new Error("no WebGPU");
  const canvas = document.createElement("canvas");
  canvas.id = "engine";
  canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block";
  let engine, device = null, late = false;
  const start = async () => {
    const started = await startEngine(canvas);
    device = started.device;
    if (late) { started.engine.free(); return null; }
    return started.engine;
  };
  try {
    engine = await withTimeout(start(), ENGINE_START_MS, "the engine did not start within " + ENGINE_START_MS / 1000 + " s");
  } catch (e) {
    late = true;
    canvas.remove();
    throw e;
  }
  let dead = false;
  let gpuReady = !waitForGpu || !device;
  if (!gpuReady) {
    // Vello submits its pipeline creation in the first task after Engine.create. Fence that work
    // before presenting so WebKit does not wait in the compositor while scenes and images arrive.
    const queue = device.queue;
    setTimeout(() => {
      if (dead) return;
      void queue.onSubmittedWorkDone().catch(() => {}).then(() => {
        gpuReady = true;
        if (!dead) onChange();
      });
    }, 0);
  }
  if (device) device.lost.then((info) => { if (!dead) onLost("GPU device lost: " + (info && (info.message || info.reason) || "unknown")); });

  // ---- size: CSS size x devicePixelRatio, from a ResizeObserver (no layout reads per frame)
  let dprQuery = null;
  let cssW = view.clientWidth, cssH = view.clientHeight;
  let presenting = false;
  // Resize immediately. After the first presentation, redraw in the same task to avoid a blank frame.
  const resize = () => {
    if (dead) return;
    cssW = view.clientWidth;
    cssH = view.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    try {
      if (presenting) resizeAndDraw(engine, cssW, cssH, dpr, getCam());
      else engine.resize(cssW, cssH, dpr);
    } catch { /* a lost engine fails again in the page's own frame, which handles it */ }
    onChange();
  };
  const watchDpr = () => {
    if (dprQuery) dprQuery.removeEventListener("change", onDpr);
    dprQuery = matchMedia("(resolution: " + (window.devicePixelRatio || 1) + "dppx)");
    dprQuery.addEventListener("change", onDpr);
  };
  function onDpr() { resize(); watchDpr(); }
  const ro = new ResizeObserver(resize);
  ro.observe(view);
  watchDpr();

  // ---- background follows the page's canvas colour (light and dark)
  let bg = "#f5f5f5";
  const syncBg = () => { const c = cssColorToHex(getComputedStyle(view).backgroundColor); if (c) { bg = c; engine.setBackground(c); onChange(); } };
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", syncBg);
  syncBg();

  // ---- fonts and images, fetched once per URL, lazily (only what a loaded board lists)
  const fontFetch = new Map(); // url -> Promise<{bytes, weight, style} | null>
  const fontDone = new Set();
  const fetchFont = (url) => {
    let p = fontFetch.get(url);
    if (!p) {
      p = fetch(url).then(async (r) => (r.ok ? { bytes: new Uint8Array(await r.arrayBuffer()), weight: Number(r.headers.get("x-font-weight")) || 0, style: r.headers.get("x-font-style") || "" } : null)).catch(() => null);
      fontFetch.set(url, p);
    }
    return p;
  };
  async function registerFonts(list) {
    const got = await Promise.all(list.map((f) => (fontDone.has(f.url) ? null : fetchFont(f.url))));
    // In scene order: tagged faces (Google subsets, platform fallbacks) chain in that order.
    let added = 0;
    list.forEach((f, i) => {
      const g = got[i];
      if (!g || fontDone.has(f.url) || dead) return;
      fontDone.add(f.url);
      try { added += engine.registerFont(f.family, g.weight, g.style, g.bytes) || 0; } catch (e) { console.warn("[canvas] font", f.family, e); }
      g.bytes = null; // the engine has its own copy
    });
    // A new face lays boards out again (an auto-sized board can grow): the cached rects follow.
    if (added) for (const [id, rec] of loaded) if (rec.rect) rec.rect = engine.nodeRectIn(id, id) || rec.rect;
    return added;
  }
  /**
   * Register the rest of the document's fonts ahead of need, one face per idle moment and never mid-gesture:
   * a face that arrives with a board later would lay out every loaded board using its family again (about
   * 100 ms on a big file), and that stall would land in the middle of a pan.
   */
  let warmed = false;
  async function warmFonts() {
    if (warmed || dead) return;
    warmed = true;
    let list = [];
    try { list = (await (await fetch(api("/api/scene/fonts"))).json()).fonts || []; } catch { return; }
    const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 150));
    const tried = new Set(); // a face whose fetch failed is not asked for again in a loop
    const next = () => {
      if (dead) return;
      const f = list.find((x) => !fontDone.has(x.url) && !tried.has(x.url));
      if (!f) return;
      if (!isIdle()) { setTimeout(() => idle(next), 300); return; }
      // The fetch can outlast the idle moment: check again before the face goes in, a gesture may have begun.
      fetchFont(f.url).then((g) => {
        if (dead) return;
        if (!g) { tried.add(f.url); idle(next); return; }
        if (!isIdle()) { setTimeout(() => idle(next), 300); return; }
        // A new face lays out every loaded board using its family again: draw, and re-place the overlays.
        registerFonts([f]).then((added) => { if (added && !dead && loaded.size) { onChange(); onLayout(); } idle(next); });
      });
    };
    idle(next);
  }

  // ---- images: decoded at the size the screen needs, in steps (IMAGE_CAPS). At fit zoom the decode may be just
  // 64 px long; when the image gets larger, it is decoded again at the next step above its size on screen,
  // up to its own pixels. Which image gets which size is one plan over all of them (planImageDecodes): each image
  // by its own rectangle against the view, and all decoded bytes together within IMAGE_BUDGET. The bitmap the
  // engine holds is never closed while registered; the one it replaces is the engine's to drop.
  // cap: the long side of the decode the engine holds (0: none yet). A failed decode keeps what was there and is
  // tried again later (bounded backoff), except a 4xx, which stays missing (gone).
  const images = new Map(); // url -> { cap, busy, uses:Map<board, rects it draws the image in, relative to the board>, boards:Set, bm (the engine's bitmap), bytes, nw, nh (its own size, once decoded), aspect, usedAt, fails, retryAt, gone }
  const imageOf = (url) => { let m = images.get(url); if (!m) images.set(url, (m = { cap: 0, busy: false, uses: new Map(), boards: new Set(), bm: null, bytes: 0, nw: 0, nh: 0, usedAt: 0, fails: 0, retryAt: 0, gone: false })); return m; };
  /** The view in world units, with half a view around it (what the engine counts as near). */
  function nearView() {
    const c = getCam();
    if (!c || !(c.z > 0)) return null;
    const w = (cssW || canvas.clientWidth) / c.z, h = (cssH || canvas.clientHeight) / c.z, x = -c.x / c.z, y = -c.y / c.z;
    return { x: x - w / 2, y: y - h / 2, w: w * 2, h: h * 2 };
  }
  /**
   * How an image shows now: the long side (device px) of its largest use in or near the view, 0 when none is,
   * -1 when a board in view lists it but where it draws it is not known (it gets the 2048 step, as before).
   */
  function imageUse(m, view, scale) {
    let side = 0, unmeasured = false, distance = Infinity;
    if (!view) return { px: 0, distance };
    for (const b of m.boards) {
      const rec = loaded.get(b), rects = m.uses.get(b);
      if (!rec?.rect) continue; // parked or not laid out
      const shown = rects?.length ? useInView(rects, rec.x, rec.y, view) : 0;
      if (!rects?.length && overlaps({ ...rec.rect, x: rec.x, y: rec.y }, view)) unmeasured = true;
      side = Math.max(side, shown);
      distance = Math.min(distance, (rec.x + rec.rect.w / 2 - view.x - view.w / 2) ** 2 +
        (rec.y + rec.rect.h / 2 - view.y - view.h / 2) ** 2);
    }
    return { px: side > 0 ? side * scale : unmeasured ? -1 : 0, distance };
  }
  /** The decodes to start now: [{ url, cap }] (see planImageDecodes). */
  function imagePlan() {
    const view = nearView(), scale = (getCam()?.z || 1) * (window.devicePixelRatio || 1), now = performance.now();
    const items = [];
    for (const [url, m] of images) {
      if (!m.boards.size) continue;
      const { px, distance } = imageUse(m, view, scale);
      if (px !== 0) m.usedAt = now;
      const want = px < 0 ? MAX_IMAGE_SIDE : px > 0 ? imageCapFor(px) : SMALL_IMAGE_SIDE;
      items.push({ url, cap: m.cap, bytes: m.bytes, nw: m.nw, nh: m.nh, aspect: m.aspect || 1, want,
        shown: px !== 0, busy: !mayDecode(m), at: m.usedAt, distance });
    }
    items.sort((a, b) => Number(b.shown) - Number(a.shown) || a.distance - b.distance);
    return planImageDecodes(items, IMAGE_BUDGET);
  }
  const mayDecode = (m) => !m.busy && performance.now() >= m.retryAt;
  let decoding = 0, planQueued = false, previewHits = 0;
  function requestImagePlan() {
    if (dead || planQueued || decoding >= DECODE_SLOTS) return;
    planQueued = true;
    queueMicrotask(() => {
      planQueued = false;
      if (dead) return;
      for (const { url, cap } of imagePlan()) {
        if (decoding >= DECODE_SLOTS) break;
        const m = images.get(url);
        if (m.cap && cap > m.cap && !isIdle()) continue;
        decoding++;
        void decode(url, cap).finally(() => { decoding--; requestImagePlan(); });
      }
    });
  }
  // A URL that answered 4xx is said once per page: a page switch makes a new record, which asks again (the file
  // may exist by then), and repeated warnings drowned the console in the soak.
  const toldGone = new Set();
  /**
   * An image fill with adjustments: its URL ends in `#adjust=` (src/scene.ts), the fetch ignores the fragment, and
   * the decoded pixels go through the colour matrix here (src/page/image-adjust.js) before the engine gets them.
   */
  async function adjusted(url, r) {
    const lib = await import("/page/image-adjust.js");
    const adj = lib.adjustFromUrl(url);
    if (!adj) return r;
    const { bm } = r;
    const c = new OffscreenCanvas(bm.width, bm.height);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bm, 0, 0);
    const px = g.getImageData(0, 0, bm.width, bm.height);
    lib.adjustPixels(px.data, lib.adjustMatrix(adj));
    g.putImageData(px, 0, 0);
    const out = await createImageBitmap(c);
    bm.close();
    return { ...r, bm: out };
  }
  function decode(url, cap) {
    const m = imageOf(url);
    m.busy = true;
    const onMain = async () => {
      const response = await fetch(url);
      if (!response.ok) throw Object.assign(new Error(String(response.status)), { status: response.status });
      const blob = await response.blob();
      const decoded = await bitmapFromBlob(blob, cap).catch((cause) => {
        throw Object.assign(new Error("invalid bitmap", { cause }), { invalidBitmap: true });
      });
      return { ...decoded, opaque: blob.type === "image/jpeg" ? true : undefined, etag: response.headers.get("etag") };
    };
    const viaWorker = decodeOffThread(url, cap);
    // A worker that could not decode (no ImageBitmap in workers, the worker died): this image on the main thread,
    // and when that works the worker is the problem (counted; a broken file fails both and counts nothing).
    return (viaWorker ? viaWorker.catch((e) => (e && e.status ? Promise.reject(e) : onMain().then((r) => { workerFailed(); return r; }))) : onMain()).then((r) => (url.includes("#adjust=") ? adjusted(url, r) : r)).then(({ bm, nw, nh, opaque, etag, cached }) => {
      m.busy = false;
      if (dead) { bm.close(); return; } // the engine is gone: nobody will ever draw it
      // The board that wanted it left (another page, a removal) while it decoded: never register it.
      if (images.get(url) !== m || !m.boards.size) { bm.close(); releaseImage(url, m); return; }
      m.cap = cap; m.fails = 0; m.retryAt = 0; m.gone = false;
      m.nw = nw || bm.width; m.nh = nh || bm.height;
      // `opaque` (no transparency, known for sure) saves the engine reading the pixels before it tiles the image.
      if (opaque === undefined) engine.registerImage(url, bm, bm.width, bm.height);
      else engine.registerImage(url, bm, bm.width, bm.height, opaque);
      // The engine let go of the smaller decode when it took this one: free it now, not at the next GC.
      if (m.bm && m.bm !== bm) m.bm.close();
      m.bm = bm;
      m.etag = etag;
      m.bytes = bm.width * bm.height * 4;
      if (cached) previewHits++;
      onChange();
    }).catch((e) => {
      m.busy = false;
      const gone = imageUnavailable(e);
      if (!gone || !toldGone.has(url)) console.warn("[canvas] image", url, e && e.message);
      if (gone) toldGone.add(url);
      if (dead) return;
      if (!m.boards.size) { releaseImage(url, m); return; }
      // A missing or unreadable file can appear later. Draw the available content while retrying.
      if (gone && !m.gone) { m.gone = true; onChange(); }
      const wait = imageRetryDelay(++m.fails);
      m.retryAt = performance.now() + wait;
      setTimeout(() => {
        if (dead || images.get(url) !== m || !m.boards.size) return;
        requestImagePlan();
      }, wait + 10);
    });
  }
  /** After the camera settles: decode again, bigger, the images now in view and shown large; keep within the budget. */
  function refineImages() {
    requestImagePlan();
  }
  /** Images a drawn board uses that have no decode yet (or one in flight): the canvas is not fully drawn until 0. */
  function imagesPending() {
    let n = 0;
    for (const m of images.values()) if (m.boards.size && !m.gone && (m.busy || !m.cap)) n++;
    return n;
  }
  /** Decoded bytes the engine holds, for stats and tests. */
  function imageStats() {
    let bytes = 0, big = 0, full = 0;
    for (const m of images.values()) {
      bytes += m.bytes;
      if (m.cap > MAX_IMAGE_SIDE) big++;
      if (m.bm?.width === m.nw && m.bm?.height === m.nh) full++;
    }
    return { decodedBytes: bytes, budget: IMAGE_BUDGET, images: images.size, big, full,
      active: decoding, slots: DECODE_SLOTS, workers: decoder ? DECODE_WORKERS : 0, previewHits };
  }
  /** An image no loaded board references any more: unregister it (frees its GPU levels) and only then close the bitmap. */
  function releaseImage(url, m) {
    if (m.boards.size || m.busy || images.get(url) !== m) return;
    if (m.cap) { try { engine.unregisterImage(url); } catch (e) { console.warn("[canvas] unregisterImage", url, e && e.message); } }
    if (m.bm) m.bm.close();
    images.delete(url);
  }
  function detachImages(id, urls) {
    for (const url of urls) {
      const m = images.get(url);
      if (m) { m.boards.delete(id); m.uses.delete(id); }
    }
  }
  /** Where a board draws each image, from the engine's own layout: rectangles relative to the board (at `at`). */
  function measureImages(board, uses, at) {
    for (const [id, url] of uses) {
      const r = engine.nodeRectIn(board, id), m = imageOf(url);
      m.boards.add(board);
      if (!r) continue;
      if (r.w > 0 && r.h > 0 && !(m.nw > 0)) m.aspect = Math.min(r.w, r.h) / Math.max(r.w, r.h);
      const list = m.uses.get(board) || [];
      list.push({ x: r.x - at.x, y: r.y - at.y, w: r.w, h: r.h });
      m.uses.set(board, list);
    }
  }

  // Decoding and shrinking happen in a worker, at most DECODE_CONCURRENCY at once: shrinking an 8k image on the
  // main thread blocked it 80 ms (a page switch on an 18 MB file spent 1.7 s there), and 200 large images decoding
  // at once took gigabytes and failed. Without workers (or if one cannot start) the main-thread path below runs.
  let decoder = null; // { worker, jobs: Map<id, {res, rej}>, seq } | false (unavailable)
  let workerFails = 0;
  /** Three decodes the worker failed and the main thread then did: decode on the main thread from now on. */
  function workerFailed() {
    if (++workerFails < 3 || decoder === false) return;
    if (decoder) { const d = decoder; d.worker.terminate(); for (const j of d.jobs.values()) j.rej(new Error("decoder off")); d.jobs.clear(); }
    decoder = false;
  }
  function decodeOffThread(url, cap) {
    if (decoder === false || typeof Worker === "undefined") return null;
    if (!decoder) {
      try {
        // Several workers: WebKit decodes a PNG on the worker's own thread, so one worker decoded the ASO page's 60
        // screenshots one after another (2.8 s in the app). DECODE_WORKERS x DECODE_CONCURRENCY at most at once.
        const src = URL.createObjectURL(new Blob([DECODER_SRC.replace("__MAX__", String(DECODE_CONCURRENCY))], { type: "text/javascript" }));
        const ws = [];
        try { for (let i = 0; i < DECODE_WORKERS; i++) ws.push(new Worker(src)); } finally { URL.revokeObjectURL(src); }
        if (!ws.length) throw new Error("no worker");
        let rr = 0;
        const worker = { postMessage: (m) => ws[rr++ % ws.length].postMessage(m), terminate: () => { for (const w of ws) w.terminate(); } };
        const d = { worker, jobs: new Map(), seq: 0 };
        const onmessage = (e) => {
          const j = d.jobs.get(e.data.id);
          if (!j) { if (e.data.bm) e.data.bm.close(); return; }
          d.jobs.delete(e.data.id);
          if (e.data.bm) { workerFails = 0; j.res(e.data); }
          else j.rej(Object.assign(new Error(e.data.error || "decode failed"), e.data.status ? { status: e.data.status } : {}));
        };
        // A worker that died (out of memory) fails what the pool held; the next decode starts a new pool.
        const onerror = (e) => { e.preventDefault(); worker.terminate(); if (decoder === d) decoder = null; for (const j of d.jobs.values()) j.rej(new Error("decoder stopped")); d.jobs.clear(); };
        for (const w of ws) { w.onmessage = onmessage; w.onerror = onerror; }
        d.fails = 0;
        decoder = d;
      } catch { decoder = false; return null; }
    }
    const d = decoder, id = ++d.seq;
    return new Promise((res, rej) => { d.jobs.set(id, { res, rej }); d.worker.postMessage({ id, url: new URL(url, location.href).href, cap }); });
  }

  // ---- boards
  const loaded = new Map(); // board id -> { seq, content, x, y, ids:Set }
  const nodeIndex = new Map(); // node id -> { board, radius }
  let opening = true;
  /**
   * Load boards in one batch: every scene is fetched first, then the fonts they need are registered once, then
   * each board is laid out. A font registered after a board exists lays that board out again (the system-ui
   * fallback chain touches every board), so registering a batch's fonts together saves whole relayouts.
   * Resolves to one result per meta: { key, root } | { stale: true } | null (no such board / error).
   */
  async function loadBoards(metas, onEach) {
    const firstLoad = opening;
    opening = false;
    const jobs = metas.map((meta) => {
      const rec = loaded.get(meta.id) || unpark(meta.id) || { seq: 0, content: null, x: NaN, y: NaN, ids: new Set() };
      loaded.set(meta.id, rec);
      const seq = ++rec.seq;
      const t = performance.now(); // live edits acknowledged before this are in the answer
      return { meta, rec, seq, t };
    });
    const out = new Array(jobs.length).fill(null);
    // Nearest the view first.
    const order = placeOrder(jobs.map((j) => posOf(j.meta.id) || j.meta), getCam(), canvas.clientWidth, canvas.clientHeight);
    const placeOne = (i, g) => {
      const j = jobs[i];
      let r = null;
      if (!g || g.scene.error) r = null;
      else if (dead || j.seq !== j.rec.seq || loaded.get(j.meta.id) !== j.rec) r = { stale: true };
      else { try { r = place(j.meta, j.rec, g.scene, g.text, j.t); } catch (e) { console.warn("[canvas] engine board " + j.meta.id, e); } }
      out[i] = r;
      if (onEach && !dead) onEach(i, r);
    };
    // Laying a board out costs 5 to 100 ms: a batch of hundreds (the overview of a big file, a page switch)
    // placed in one task froze the page for seconds. In slices of PLACE_SLICE_MS (at least one board each) that
    // start right after a frame, so a gesture keeps its frames.
    const slices = { budgetMs: () => (isIdle() ? PLACE_SLICE_IDLE_MS : PLACE_SLICE_MS), next: nextSlice };
    const fontsOf = (list) => {
      const fonts = [], seen = new Set();
      for (const g of list) for (const f of (g && !g.scene.error && g.scene.fonts) || []) if (!seen.has(f.url)) { seen.add(f.url); fonts.push(f); }
      return fonts;
    };
    if (metas.length >= BULK_MIN && await loadBulk(jobs, order, async (group) => {
      // Each arrival is placed as it comes (its fonts first): the nearest boards show while the far ones are built.
      await registerFonts(fontsOf(group.map((x) => x.g)));
      await inSlices(group, (x) => placeOne(x.i, x.g), slices);
    })) {
      if (restack && !dead) { restack = false; reorder(); }
      return out;
    }
    async function loadGroup(indices) {
      const got = await Promise.all(indices.map((i) => {
        const { meta } = jobs[i];
        return fetch(sceneUrl(api, meta.id, meta.key, sceneEnv)).then((r) => r.text())
          .then((text) => ({ text, scene: JSON.parse(text) })).catch(() => null);
      }));
      await registerFonts(fontsOf(got));
      const ready = new Map(indices.map((i, n) => [i, got[n]]));
      await inSlices(indices, (i) => placeOne(i, ready.get(i)), slices);
    }
    // The nearest board can start drawing without waiting for every scene in the opening batch.
    if (firstLoad && order.length > 1) await Promise.all([loadGroup(order.slice(0, 1)), loadGroup(order.slice(1))]);
    else await loadGroup(order);
    if (restack && !dead) { restack = false; reorder(); }
    return out;
  }
  /**
   * Many boards at once (an overview, a big page): one POST /api/scenes streams their scenes as the server builds
   * them, in `order`; `each(group)` places what has arrived, while more arrives. False when the answer could not be
   * read at all (the caller fetches the boards one by one); a board that did not come is left null (retried).
   */
  async function loadBulk(jobs, order, each) {
    const index = new Map(jobs.map((j, i) => [j.meta.id, i]));
    let r;
    try {
      r = await fetch(api("/api/scenes"), { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ ids: order.map((i) => jobs[i].meta.id) }) });
    } catch { return false; }
    if (!r.ok || !r.body) return false;
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", head = null;
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { break; }
      if (chunk.value) buf += chunk.value;
      const group = [];
      let at = 0;
      for (let nl = buf.indexOf("\n", at); nl >= 0; nl = buf.indexOf("\n", at)) {
        const line = buf.slice(at, nl);
        at = nl + 1;
        if (!head) {
          try { head = JSON.parse(line); } catch { head = null; continue; }
          if (head.error) { const i = index.get(head.id); if (i !== undefined) group.push({ i, g: null }); head = null; }
          continue;
        }
        const i = index.get(head.id);
        head = null;
        if (i === undefined) continue;
        let scene = null;
        try { scene = JSON.parse(line); } catch { /* a cut line: null, retried */ }
        group.push({ i, g: scene ? { scene, text: line } : null });
      }
      buf = buf.slice(at);
      if (group.length && !dead) await each(group);
      if (chunk.done || dead) break;
    }
    return true;
  }
  /**
   * The engine paints and hit-tests boards in the order they were first added (`paint` mirrors it), and boards
   * load lazily and can be rearranged. Whenever that order disagrees with the document's for two boards that
   * overlap, the fewest boards go to the top, in document order, so the stack matches the file. Boards rarely
   * overlap, so this is rarely more than nothing. Raising a board is only an order in the engine (raiseBoards):
   * no fetch, no layout, its textures stay (removing and adding it again laid it out and greyed it for a frame).
   */
  const paint = []; // loaded board ids in the engine's paint order, bottom first
  let restack = false; // a board placed in this batch overlaps another: restack once the batch is in
  function reorder() {
    if (dead) return;
    const ids = boardsToReorder(paint, orderOf, (id) => (loaded.get(id) || {}).rect || null).filter((id) => (loaded.get(id) || {}).content);
    if (!ids.length) return;
    engine.raiseBoards(ids);
    raiseInOrder(paint, ids);
    onChange();
    onLayout();
  }
  function place(meta, rec, scene, text, fetchedAt = 0) {
    keepScene(meta.id, text);
    // Edits the server does not have yet stay on top of what it sent (src/page/live.js).
    if (rebase(meta.id, scene, fetchedAt)) text = JSON.stringify(scene);
    const content = contentKey(scene);
    // Where the page has the board now: a move (docdiff) that landed while this scene was in flight wins.
    const at = posOf(meta.id) || scene;
    const fresh = !rec.content;
    // Back from the parking lot (a page shown again): the engine still holds it laid out, hidden.
    const wasParked = rec.parked;
    rec.parked = false;
    let root;
    if (content === rec.content) {
      // Same drawing somewhere else: a move needs no new layout.
      if (at.x !== rec.x || at.y !== rec.y) engine.moveBoard(meta.id, at.x, at.y);
      if (wasParked) engine.setBoardHidden(meta.id, false);
      root = engine.nodeRectIn(meta.id, meta.id);
    }
    if (content !== rec.content || wasParked) {
      if (content !== rec.content) root = engine.setBoard(meta.id, at.x, at.y, text).root;
      if (fresh) paint.push(meta.id);
      for (const id of rec.ids) if (nodeIndex.get(id) && nodeIndex.get(id).board === meta.id) nodeIndex.delete(id);
      const uses = [];
      rec.ids = indexScene(scene.root, meta.id, nodeIndex, uses);
      rec.content = content;
      const previousImages = rec.images || [];
      detachImages(meta.id, previousImages);
      measureImages(meta.id, uses, at);
      rec.images = scene.images || [];
      for (const url of rec.images) imageOf(url).boards.add(meta.id);
      for (const url of previousImages) { const m = images.get(url); if (m) releaseImage(url, m); }
    }
    rec.x = at.x; rec.y = at.y; rec.rect = root;
    if (rec.images?.length) requestImagePlan();
    // Only a board that overlaps another loaded one can be stacked wrong. Checked once per batch (loadBoards), by
    // reorder's sweep over cached rects (n log n): a check of each new board against every loaded one here was n²,
    // 330 ms of a 5,000-board open.
    if (fresh && root) restack = true;
    onChange();
    return { key: scene.key, root };
  }
  // ---- parking: a page switch hides the boards of the page left instead of removing them. Going back then
  // costs no layout (the engine keeps them), no image decode (their images stay registered) and, while the tile
  // cache still holds their textures, no render. Removing and adding them on every switch allocated and freed
  // hundreds of MB of GPU textures a minute, which Chrome's GPU process gave back only lazily (the stress soak's
  // sawtooth). Parked boards are bounded by node count, least recently parked out first.
  const parked = new Map(); // board id -> rec (as in `loaded`), oldest first
  let parkedNodes = 0;
  function park(id) {
    const rec = loaded.get(id);
    if (!rec) return;
    if (!rec.content || !engine.setBoardHidden(id, true)) return removeBoard(id);
    loaded.delete(id);
    rec.seq++; // a load in flight for it is stale now
    rec.parked = true;
    for (const n of rec.ids) if (nodeIndex.get(n) && nodeIndex.get(n).board === id) nodeIndex.delete(n);
    parked.set(id, rec);
    parkedNodes += rec.ids.size;
    for (const old of parkedToEvict(parked, parkedNodes, PARK_MAX_NODES, PARK_MAX_BOARDS)) dropParked(old);
    onChange();
  }
  function unpark(id) {
    const rec = parked.get(id);
    if (!rec) return null;
    parked.delete(id);
    parkedNodes -= rec.ids.size;
    return rec;
  }
  function dropParked(id) {
    const rec = unpark(id);
    if (!rec) return;
    loaded.set(id, rec);
    removeBoard(id);
  }
  /** Parked boards no longer in the document go for good. */
  function pruneParked(keep) {
    for (const id of [...parked.keys()]) if (!keep.has(id)) dropParked(id);
  }
  function removeBoard(id) {
    if (parked.has(id)) return dropParked(id);
    const rec = loaded.get(id);
    if (!rec) return;
    loaded.delete(id);
    const pi = paint.indexOf(id);
    if (pi >= 0) paint.splice(pi, 1);
    keepScene(id, null);
    for (const n of rec.ids) if (nodeIndex.get(n) && nodeIndex.get(n).board === id) nodeIndex.delete(n);
    detachImages(id, rec.images || []);
    engine.removeBoard(id);
    for (const url of rec.images || []) { const m = images.get(url); if (m) releaseImage(url, m); }
    onChange();
  }
  /** Move a loaded board now (the content reload that follows keeps it there unless it changed). */
  function moveBoard(id, x, y) {
    const rec = loaded.get(id);
    if (!rec || (rec.x === x && rec.y === y) || !rec.content) return;
    engine.moveBoard(id, x, y);
    if (rec.rect) rec.rect = { ...rec.rect, x: rec.rect.x + x - rec.x, y: rec.rect.y + y - rec.y };
    rec.x = x; rec.y = y;
    // hunt-5 (page agent): a board moved onto another must stack in document order too, not only a fresh one.
    if (rec.rect && paint.some((o) => { const r = o !== id && (loaded.get(o) || {}).rect; return r && overlaps(r, rec.rect); })) reorder();
    onChange();
  }

  // ---- live edits (src/page/live.js): the server's last scene text per board, so an edit can be drawn on it
  // in the next frame. Bounded by size, least recently used out first.
  const SCENE_BUDGET = 24 << 20; // UTF-16 bytes of scene text
  const scenes = new Map(); // board id -> text
  let sceneBytes = 0;
  function keepScene(id, text) {
    const old = scenes.get(id);
    if (old !== undefined) { sceneBytes -= old.length * 2; scenes.delete(id); }
    if (typeof text !== "string" || text.length * 2 > SCENE_BUDGET / 2) return;
    scenes.set(id, text);
    sceneBytes += text.length * 2;
    for (const [k, t] of scenes) { if (sceneBytes <= SCENE_BUDGET) break; scenes.delete(k); sceneBytes -= t.length * 2; }
  }
  /** The server's last scene for a loaded board (text), or null. */
  function sceneText(id) {
    const t = scenes.get(id);
    if (t === undefined) return null;
    scenes.delete(id); scenes.set(id, t); // most recently used
    return t;
  }
  /** Fetch a board's scene into the cache without drawing it (the first edit of a board the cache let go). */
  function fetchScene(id) {
    return fetch(api("/api/scene") + "&id=" + encodeURIComponent(id)).then((r) => r.text()).then((text) => {
      const s = JSON.parse(text);
      if (s.error || !loaded.has(id) || scenes.has(id)) return !s.error && loaded.has(id);
      keepScene(id, text);
      return true;
    }).catch(() => false);
  }
  /** Draw a loaded board from a scene the page patched. Returns its root rect, or null when it is not loaded. */
  function install(id, scene) {
    const rec = loaded.get(id);
    if (!rec || !rec.content || dead) return null;
    // The root is stringified once, for the content key and for the engine (a second whole stringify per frame of
    // a live edit was a millisecond on a 1,300-node board).
    const { text, content } = sceneTextAndKey(scene);
    if (content === rec.content) return engine.nodeRectIn(id, id);
    const at = posOf(id) || { x: rec.x, y: rec.y };
    const root = engine.setBoard(id, at.x, at.y, text).root;
    rec.rect = root;
    for (const n of rec.ids) if (nodeIndex.get(n) && nodeIndex.get(n).board === id) nodeIndex.delete(n);
    rec.ids = indexScene(scene.root, id, nodeIndex);
    rec.content = content;
    rec.x = at.x; rec.y = at.y;
    onChange();
    return root;
  }

  /**
   * Put a layer of a loaded board at (x, y) in its parent without laying the board out again (engine moveNode: a
   * frame with layout none and a fixed size). The engine's drawing then differs from any scene the page holds, so
   * the next install always sets the board. False when the engine needs a layout: install the scene instead.
   */
  function moveNode(board, id, x, y) {
    const rec = loaded.get(board);
    if (!rec || !rec.content || dead || !engine.moveNode) return false;
    let ok = false;
    try { ok = engine.moveNode(board, id, x, y); } catch { ok = false; }
    if (!ok) return false;
    rec.content = -1;
    onChange();
    return true;
  }

  /**
   * Replace a layer and its subtree (`node`: the scene's node object, children included) and lay out that subtree
   * alone (engine updateNode: its parent places it freely and has a fixed size). False when the engine needs the
   * whole board: install the scene instead.
   */
  function updateNode(board, id, node) {
    const rec = loaded.get(board);
    if (!rec || !rec.content || dead || !engine.updateNode) return false;
    let ok = false;
    try { ok = engine.updateNode(board, id, JSON.stringify(node)); } catch { ok = false; }
    if (!ok) return false;
    rec.content = -1;
    // The subtree's layers keep their ids (the engine checks): their index entries follow the new props.
    const parent = nodeIndex.get(id) ? nodeIndex.get(id).parent : null;
    indexScene(node, board, nodeIndex);
    if (nodeIndex.get(id)) nodeIndex.get(id).parent = parent;
    onChange();
    return true;
  }

  // ---- snapshot help: a 2D copy of the current frame over the GPU canvas
  let frozen = null;
  function freeze() {
    if (!presenting) return { frozen: false };
    thaw();
    const c2 = document.createElement("canvas");
    c2.width = canvas.width; c2.height = canvas.height;
    c2.style.cssText = canvas.style.cssText;
    // Draw a fresh frame and copy it in the same task, while the drawing buffer is surely current.
    engine.setBackground(bg);
    // Shader cards show their frame at t = 2 s: a snapshot is the same picture every time.
    if (engine.setShaderSnapshot) engine.setShaderSnapshot(true);
    // This frame runs outside the page's rAF loop: when it leaves tiles to draw, the loop must pick them up.
    if (engine.frame()) onChange();
    c2.getContext("2d").drawImage(canvas, 0, 0);
    canvas.after(c2);
    frozen = c2;
    // A thaw that never comes (the shell or server went away) must not leave a still picture over the canvas.
    clearTimeout(thawT);
    thawT = setTimeout(thaw, 3000);
    return { frozen: true, width: c2.width, height: c2.height };
  }
  let thawT = 0;
  /**
   * Pictures of parts of the canvas as drawn now (board snapshots, src/page/snapshots.js): the cached tiles are
   * composited once more and copied in the same task, while the drawing buffer is surely current. No tile renders.
   * `crops`: [{ sx, sy, sw, sh, w, h }] in canvas pixels; returns one 2D canvas of w x h each.
   */
  function capture(crops) {
    engine.setBackground(bg);
    if (engine.redraw()) onChange();
    return crops.map((c) => {
      const out = document.createElement("canvas");
      out.width = c.w; out.height = c.h;
      const g = out.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(canvas, c.sx, c.sy, c.sw, c.sh, 0, 0, c.w, c.h);
      return out;
    });
  }
  function thaw() {
    clearTimeout(thawT);
    if (frozen) { frozen.remove(); frozen = null; if (engine.setShaderSnapshot) { engine.setShaderSnapshot(false); onChange(); } }
    return { thawed: true };
  }

  return {
    engine, canvas,
    setCam: (c) => engine.setCamera(c.x, c.y, c.z),
    frame(show = true) {
      if (!presenting) {
        if (!show) return false;
        if (!gpuReady) return true;
        presenting = true;
        view.prepend(canvas);
      }
      return engine.frame();
    },
    pick: (x, y) => engine.hitTest(x, y) ?? null,
    // Every layer under a point, topmost first (right-click > Select layer).
    pickAll: (x, y) => (engine.hitTestAll ? engine.hitTestAll(x, y) : []),
    rect: (id) => { const n = nodeIndex.get(id), r = n ? engine.nodeRectIn(n.board, id) : engine.nodeRect(id); return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null; },
    /** A text layer's lines and list markers as drawn, world px (engine textLines): QA checks the editor against them. */
    textLines: (id) => (engine.textLines ? engine.textLines(id) : null),
    boardOf: (id) => (nodeIndex.get(id) || {}).board || null,
    parentOf: (id) => { const n = nodeIndex.get(id); return n && n.parent !== undefined ? n.parent : null; },
    /** A drawn layer's type, name and whether it is a component instance (drops, /page/drops.js; Select layer). */
    infoOf: (id) => { const n = nodeIndex.get(id); return n ? { type: n.type, name: n.name || "", instance: !!n.instance } : null; },
    radiusOf: (id, r) => { const n = nodeIndex.get(id); return n ? Math.min(n.radius, Math.min(r.w, r.h) / 2) : 0; },
    isLoaded: (id) => loaded.has(id),
    loadBoards, removeBoard, park, pruneParked, moveBoard, parkedCount: () => parked.size, isParked: (id) => parked.has(id), freeze, thaw, capture, syncBg, refineImages, imageStats, imagesPending, warmFonts, reorder,
    sceneText, fetchScene, install, moveNode, updateNode,
    stats: () => engine.stats(),
    /** { missing, blank, exact } of the last frame, without stats()'s walk over every board. */
    snapshotAssets(id) {
      const assets = new Map();
      for (const url of loaded.get(id)?.images ?? []) {
        if (url.startsWith("data:")) continue; // the bytes already contribute to the board key
        const etag = images.get(url)?.etag;
        if (!url.startsWith("/asset?") || !etag) return null;
        const asset = url.split("#", 1)[0];
        if (assets.has(asset) && assets.get(asset) !== etag) return null;
        assets.set(asset, etag);
      }
      return [...assets].sort();
    },
    pictureState() {
      const [missing, blank, exact, pixels] = engine.pictureState();
      const boardPixels = pixels === undefined ? blank === 0 && engine.boardsInView().length > 0 : pixels === 1;
      return { missing, blank, exact: exact === 1, boardPixels };
    },
    loseDevice: () => device && device.destroy(),
    destroy() {
      dead = true;
      ro.disconnect();
      scheme.removeEventListener("change", syncBg);
      if (dprQuery) dprQuery.removeEventListener("change", onDpr);
      thaw();
      canvas.remove();
      try { engine.free(); } catch {}
      // The engine is gone, so the bitmaps it held can be closed now.
      for (const m of images.values()) if (m.bm) { try { m.bm.close(); } catch {} m.bm = null; }
      images.clear();
      scenes.clear();
      if (decoder) { const d = decoder; d.worker.terminate(); for (const j of d.jobs.values()) j.rej(new Error("engine gone")); d.jobs.clear(); }
      decoder = false;
    },
  };
}

async function startEngine(canvas) {
  // A trapped wasm instance cannot start another engine.
  const mod = await import(engineModuleUrl(engineStarts++));
  await mod.default();
  let device;
  const proto = window.GPUAdapter?.prototype, requestDevice = proto?.requestDevice;
  if (requestDevice) proto.requestDevice = async function (...args) {
    device = await requestDevice.apply(this, args);
    return device;
  };
  try { return { engine: await mod.Engine.create(canvas), device }; }
  finally { if (requestDevice) proto.requestDevice = requestDevice; }
}

/** Compile and submit the stock tile and compositor pipelines before a document needs them. */
export async function warmEngine(canvas) {
  const { engine, device } = await startEngine(canvas);
  try {
    engine.resize(64, 64, 1);
    engine.setBoard("warm", 0, 0, JSON.stringify({ root: {
      id: "warm", type: "frame", width: 64, height: 64, fill: "#FFFFFF",
      children: [{ id: "shape", type: "ellipse", x: 8, y: 8, width: 32, height: 32, fill: "#204080" }],
    } }));
    // A detached WebView has no animation frames. Submit from a task once Vello is ready.
    const deadline = performance.now() + ENGINE_START_MS;
    do {
      engine.frame();
      if (engine.pictureState()[3] === 1) {
        await device.queue.onSubmittedWorkDone();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 16));
    } while (performance.now() < deadline);
    throw new Error("GPU warm-up drew no board");
  } finally {
    engine.free();
  }
}

// ---------------------------------------------------------------- pure helpers (node-tested)

/** Engines started in this page so far (engineModuleUrl). */
let engineStarts = 0;
/** How long an engine may take to start before the page draws with the DOM instead (it never stays pending). */
export const ENGINE_START_MS = 15_000;
/**
 * The engine's module URL for the `n`th engine started in this page (0 first): the first uses the plain URL, every
 * later one its own query, so the browser instantiates the wasm again instead of handing back the instance the lost
 * engine ran in (the server reads only the path).
 */
export const engineModuleUrl = (n) => "/engine/canvas_engine.js" + (n > 0 ? "?i=" + n : "");
/** `p`, or a rejection with `message` after `ms`. */
export function withTimeout(p, ms, message) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); })]).finally(() => clearTimeout(t));
}

/** Images decoding at once in the decoder worker (an 8k decode holds 256 MB until it is shrunk). */
/** Parked boards (pages not shown) kept in the engine: at most this many nodes and boards together. */
/**
 * A board's scene URL. With its content key and the server's scene environment (src/keyed.ts) the answer is
 * immutable and the browser keeps it; without them it is asked for fresh every time.
 */
export function sceneUrl(api, id, key, env) {
  return api("/api/scene") + "&id=" + encodeURIComponent(id) + (key && env ? "&key=" + encodeURIComponent(key) + "&v=" + encodeURIComponent(env) : "");
}
export const PARK_MAX_NODES = 60_000;
export const PARK_MAX_BOARDS = 300;
/** Which parked boards to remove for good (oldest first) so the rest fit both limits. `parked`: id -> { ids:Set } in parking order. */
export function parkedToEvict(parked, nodes, maxNodes = PARK_MAX_NODES, maxBoards = PARK_MAX_BOARDS) {
  const out = [];
  let n = nodes, count = parked.size;
  for (const [id, rec] of parked) {
    if (n <= maxNodes && count <= maxBoards) break;
    out.push(id);
    n -= rec.ids.size;
    count--;
  }
  return out;
}

export const DECODE_CONCURRENCY = 2;
/** Decoder workers (each runs DECODE_CONCURRENCY decodes at once). */
export const DECODE_WORKERS = 3;
const DECODE_SLOTS = DECODE_CONCURRENCY * DECODE_WORKERS;

// A preview is derived from one local asset at one size. Keep it on disk in the browser
// cache and ask /asset to revalidate its source ETag before reusing it.
function openThumbnailCache() {
  if (typeof caches === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  const limit = 2048;
  let ready, writes = 0;
  async function init() {
    const cache = await caches.open("canvas-image-previews-v1");
    const prune = async () => {
      const keys = await cache.keys();
      await Promise.all(keys.slice(0, Math.max(0, keys.length - limit)).map((key) => cache.delete(key)));
      return new Set(keys.slice(-limit).map((key) => key.url));
    };
    return { cache, existing: await prune(), prune };
  }
  return async (url, cap) => {
    if (cap > 128) return null;
    const key = new URL(url);
    if (key.origin !== self.location.origin || key.pathname !== "/asset") return null;
    key.hash = "";
    key.searchParams.set("preview", String(cap));
    const store = await (ready ||= init().catch(() => null));
    if (!store) return null;
    const { cache, existing, prune } = store;
    return {
      read: () => existing.has(key.href) ? cache.match(key.href).catch(() => null) : null,
      write(bm, nw, nh, etag, opaque) {
        if (!etag || Math.max(bm.width, bm.height) > cap || (nw === bm.width && nh === bm.height)) return;
        const canvas = new OffscreenCanvas(bm.width, bm.height);
        canvas.getContext("2d").drawImage(bm, 0, 0);
        void canvas.convertToBlob().then(async (blob) => {
          await cache.put(key.href, new Response(blob, { headers: { etag, width: String(nw), height: String(nh), opaque: opaque ? "1" : "0" } }));
          existing.add(key.href);
          if (++writes % 128 === 0) await prune();
        }).catch(() => {});
      },
    };
  };
}

async function bitmapFromBlob(blob, cap, px = cap > MAX_IMAGE_SIDE ? FULL_IMAGE_PX : 0) {
  const resize = (w, h) => {
    const k = Math.min(1, cap / Math.max(w, h), px ? Math.sqrt(px / (w * h)) : 1);
    if (k >= 1) return undefined;
    return { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: "high" };
  };
  let bm;
  // PNG's IHDR gives the dimensions without decoding the full bitmap. Some WebKit versions ignore
  // resize options, so verify the returned dimensions and keep the bitmap fallback.
  if (blob.type === "image/png" && blob.size >= 24) {
    const header = new DataView(await blob.slice(0, 24).arrayBuffer());
    if (header.getUint32(0) === 0x89504e47 && header.getUint32(4) === 0x0d0a1a0a && header.getUint32(12) === 0x49484452) {
      const nw = header.getUint32(16), nh = header.getUint32(20);
      const options = nw && nh && resize(nw, nh);
      if (options) {
        bm = await createImageBitmap(blob, options).catch(() => null);
        if (bm?.width === options.resizeWidth && bm?.height === options.resizeHeight) return { bm, nw, nh };
      }
    }
  }
  bm ||= await createImageBitmap(blob);
  const nw = bm.width, nh = bm.height, options = resize(nw, nh);
  if (options) {
    const small = await createImageBitmap(bm, options).catch(() => null);
    if (small) { bm.close(); bm = small; }
  }
  return { bm, nw, nh };
}

/** The decoder worker: fetch, decode, shrink to `cap` px on the long side (and `px` pixels, when given), hand the bitmap over; a queue in front. */
export const DECODER_SRC = `"use strict";
const MAX_IMAGE_SIDE = ${MAX_IMAGE_SIDE}, FULL_IMAGE_PX = ${FULL_IMAGE_PX};
${bitmapFromBlob.toString()}
${openThumbnailCache.toString()}
const thumbnailCache = openThumbnailCache();
const q = []; let busy = 0;
const pump = () => { while (busy < __MAX__ && q.length) { busy++; run(q.shift()).finally(() => { busy--; pump(); }); } };
async function run({ id, url, cap, px }) {
  let bm = null;
  try {
    const thumb = await thumbnailCache?.(url, cap);
    const cached = await thumb?.read();
    const etag = cached?.headers.get("etag");
    let r = await fetch(url, etag ? { cache: "no-store", headers: { "if-none-match": etag } } : undefined);
    if (r.status === 304 && cached) {
      bm = await cached.blob().then((blob) => createImageBitmap(blob)).catch(() => null);
      if (bm) {
        postMessage({ id, bm, nw: Number(cached.headers.get("width")), nh: Number(cached.headers.get("height")),
          opaque: cached.headers.get("opaque") === "1" || undefined, etag, cached: true }, [bm]);
        return;
      }
      r = await fetch(url, { cache: "reload" });
    }
    if (!r.ok) { postMessage({ id, status: r.status, error: String(r.status) }); return; }
    const blob = await r.blob();
    const decoded = await bitmapFromBlob(blob, cap, px);
    bm = decoded.bm;
    const { nw, nh } = decoded;
    const opaque = opaqueOf(bm, blob.type);
    const sourceTag = r.headers.get("etag");
    try { thumb?.write(bm, nw, nh, sourceTag, opaque); } catch { /* optional cache */ }
    postMessage({ id, bm, nw, nh, opaque, etag: sourceTag }, [bm]);
  } catch (e) {
    if (bm) bm.close(); // the full-size decode, when shrinking it failed
    postMessage({ id, error: String((e && e.message) || e) });
  }
}
// Has the bitmap no transparency: true or false when known for sure, undefined when not found out here (the
// engine then reads the pixels itself, on the main thread). A JPEG has none. Anything else large enough for the
// engine to draw from tiles (over 2048 x 2048 px) is read here, every pixel, in bands.
function opaqueOf(bm, type) {
  if (type === "image/jpeg") return true;
  if (bm.width * bm.height <= 4194304 || typeof OffscreenCanvas === "undefined") return undefined;
  try {
    const rows = Math.max(1, Math.min(bm.height, Math.floor(2097152 / bm.width)));
    const cx = new OffscreenCanvas(bm.width, rows).getContext("2d", { willReadFrequently: true });
    for (let y = 0; y < bm.height; y += rows) {
      const n = Math.min(rows, bm.height - y);
      cx.clearRect(0, 0, bm.width, rows);
      cx.drawImage(bm, 0, y, bm.width, n, 0, 0, bm.width, n);
      const px = new Uint32Array(cx.getImageData(0, 0, bm.width, n).data.buffer);
      for (let i = 0; i < px.length; i++) if (px[i] >>> 24 !== 255) return false;
    }
    return true;
  } catch { return undefined; }
}
self.onmessage = (e) => { q.push(e.data); pump(); };
`;

/** Move `ids` to the end of `order` (the top), in the order given: what engine.raiseBoards does to its boards. */
export function raiseInOrder(order, ids) {
  for (const id of ids) { const i = order.indexOf(id); if (i >= 0) { order.splice(i, 1); order.push(id); } }
  return order;
}

/** GPU device losses (or engine failures) restarted in a row before the page gives up and draws with the DOM. */
export const ENGINE_MAX_RESTARTS = 3;
/** A loss this long after the previous one starts the count again. */
export const ENGINE_RESTART_WINDOW_MS = 5 * 60_000;
/**
 * After the engine was lost at `now` (performance.now ms), with `losses` the times of earlier losses: how long to
 * wait before starting a new engine, or -1 for the DOM renderer (the device keeps going away). A driver reset, a
 * GPU switch or a sleep loses the device once; that must not cost the GPU renderer for the rest of the session.
 */
export function engineRestartDelay(losses, now) {
  const recent = losses.filter((t) => now - t < ENGINE_RESTART_WINDOW_MS).length;
  if (recent >= ENGINE_MAX_RESTARTS) return -1;
  return 250 * 2 ** recent;
}

/** Two world rects {x, y, w, h} share area. */
export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Boards loaded together from this many on come in one streamed POST /api/scenes instead of a GET each (whose
 * answers the browser caches by content key, which a few boards changed by an edit still use).
 */
export const BULK_MIN = 24;

/** Main-thread time one slice of board placement may take (always at least one board): during a gesture, */
export const PLACE_SLICE_MS = 8;
/** and while the camera is still (opening a file, a page switch: the view fills sooner, nothing moves). */
export const PLACE_SLICE_IDLE_MS = 20;
/** The next slice: right after the next frame (or a task, in a hidden page, where rAF does not run). */
const nextSlice = () => new Promise((r) => (typeof document !== "undefined" && !document.hidden ? requestAnimationFrame(() => setTimeout(r, 0)) : setTimeout(r, 0)));

/** Run fn(item) over items, yielding (await next()) whenever a slice has used budgetMs (a number, or a function
 * asked at each check); every slice runs at least one. */
export async function inSlices(items, fn, { budgetMs, next, now = () => performance.now() }) {
  const budget = typeof budgetMs === "function" ? budgetMs : () => budgetMs;
  let t0 = now(), ran = 0;
  for (const it of items) {
    if (ran > 0 && now() - t0 >= budget()) { await next(); t0 = now(); ran = 0; }
    fn(it);
    ran++;
  }
}

/** Indices of boards (world rects {x, y, width, height}) by distance of their centre to the view's centre. */
export function placeOrder(rects, cam, vw, vh) {
  const idx = rects.map((_, i) => i);
  if (!cam || !(cam.z > 0)) return idx;
  const cx = (vw / 2 - cam.x) / cam.z, cy = (vh / 2 - cam.y) / cam.z;
  const d = rects.map((r) => Math.hypot((r.x || 0) + (r.width || 0) / 2 - cx, (r.y || 0) + (r.height || 0) / 2 - cy));
  return idx.sort((a, b) => d[a] - d[b] || a - b);
}

/** "rgb(r, g, b)" / "rgba(r, g, b, a)" / "#rgb" / "#rrggbb(aa)" as #rrggbb or #rrggbbaa; null when unreadable. */
export function cssColorToHex(s) {
  if (typeof s !== "string") return null;
  s = s.trim();
  const h2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    const v = m[1];
    if (v.length === 3 || v.length === 4) return "#" + [...v].map((c) => c + c).join("").toLowerCase();
    if (v.length === 6 || v.length === 8) return "#" + v.toLowerCase();
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return null;
  let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  const hex = "#" + h2(+m[1]) + h2(+m[2]) + h2(+m[3]);
  return a >= 1 ? hex : hex + h2(a * 255);
}

/**
 * Every node id in a scene tree, recorded in `index` as { board, radius } (corner radius for overlays).
 * `uses`, when given, collects [node id, image url] for every image fill and stroke.
 */
export function indexScene(root, board, index, uses) {
  const ids = new Set();
  // `parent`: the layer it is drawn in (null for the root), so the page can walk up from a hit (the click rule).
  const walk = (n, parent) => {
    if (!n || typeof n !== "object") return;
    let me = parent;
    if (n.id !== undefined) {
      const id = String(n.id);
      ids.add(id);
      const cr = n.cornerRadius;
      const radius = n.type === "ellipse" ? 1e9 : typeof cr === "number" ? cr : Array.isArray(cr) && typeof cr[0] === "number" ? cr[0] : 0;
      index.set(id, { board, radius, parent, name: typeof n.name === "string" ? n.name : "", type: n.type, instance: typeof n.component === "string" });
      if (uses) for (const k of ["fill", "stroke"]) for (const p of [].concat(n[k] || [])) if (p && p.type === "image" && typeof p.url === "string") uses.push([id, p.url]);
      me = id;
    }
    if (Array.isArray(n.children)) n.children.forEach((c) => walk(c, me));
  };
  walk(root, null);
  if (board) { ids.add(board); if (!index.has(board)) index.set(board, { board, radius: 0, parent: null }); }
  return ids;
}

/** What a board draws, without where it sits: two scenes with the same key differ by a move only. */
export function contentKey(scene) {
  const root = scene && scene.root ? { ...scene.root } : {};
  delete root.x; delete root.y;
  return hash53(JSON.stringify([root, scene && scene.fonts, scene && scene.images]));
}

/**
 * JSON.stringify(scene) for the engine and contentKey(scene), stringifying the root once: the key's root (without
 * x and y) is the engine's root with x and y put back at its end (key order means nothing to the engine).
 */
export function sceneTextAndKey(scene) {
  if (!scene || !scene.root || typeof scene.root !== "object") return { text: JSON.stringify(scene), content: contentKey(scene) };
  const root = { ...scene.root };
  const { x, y } = root;
  delete root.x; delete root.y;
  const rootText = JSON.stringify(root);
  const content = hash53("[" + rootText + "," + (JSON.stringify(scene && scene.fonts) ?? "null") + "," + (JSON.stringify(scene && scene.images) ?? "null") + "]");
  let full = rootText;
  const extra = (x !== undefined ? ',"x":' + JSON.stringify(x) : "") + (y !== undefined ? ',"y":' + JSON.stringify(y) : "");
  if (extra) full = rootText === "{}" ? "{" + extra.slice(1) + "}" : rootText.slice(0, -1) + extra + "}";
  const rest = JSON.stringify({ ...scene, root: undefined });
  const text = rest === "{}" ? '{"root":' + full + "}" : rest.slice(0, -1) + ',"root":' + full + "}";
  return { text, content };
}

/** cyrb53: a 53-bit string hash, so a board keeps a number instead of a copy of its scene. */
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Which boards to add again on top of the engine's paint order (bottom first), and in which order, so that every
 * two boards that overlap stack as the document orders them (`orderOf`, higher on top). The fewest that fix it:
 * a board goes up when it must cover one it is under; whatever it then wrongly covers follows.
 */
export function boardsToReorder(paint, orderOf, rectOf) {
  const rect = new Map(paint.map((id) => [id, rectOf(id)]));
  const pos = new Map(paint.map((id, i) => [id, i]));
  // Overlapping pairs by a sweep along x (boards rarely overlap: about n log n, not n² on a 1,000-board file).
  const byX = paint.filter((id) => rect.get(id)).sort((a, b) => rect.get(a).x - rect.get(b).x);
  const pairs = [];
  for (let i = 0; i < byX.length; i++) {
    const ra = rect.get(byX[i]);
    for (let j = i + 1; j < byX.length; j++) {
      const rb = rect.get(byX[j]);
      if (rb.x >= ra.x + ra.w) break;
      if (overlaps(ra, rb) && orderOf(byX[i]) !== orderOf(byX[j])) pairs.push(pos.get(byX[i]) < pos.get(byX[j]) ? [byX[i], byX[j]] : [byX[j], byX[i]]);
    }
  }
  const up = new Set();
  // Where a board ends up: the ones going up sit above all the others, among themselves in document order.
  const above = (a, b) => (up.has(a) ? (up.has(b) ? orderOf(a) > orderOf(b) : true) : up.has(b) ? false : pos.get(a) > pos.get(b));
  for (let grew = true; grew;) {
    grew = false;
    for (const [a, b] of pairs) {
      const top = orderOf(a) > orderOf(b) ? a : b, under = top === a ? b : a;
      if (!above(top, under) && !up.has(top)) { up.add(top); grew = true; }
    }
  }
  return [...up].sort((a, b) => orderOf(a) - orderOf(b));
}

/**
 * Resize the engine's canvas and draw it again in the same task. Setting a canvas's size clears its drawing
 * buffer. The browser runs rAF callbacks, then ResizeObserver callbacks, then paints: a resize that left the draw
 * to the next rAF presented the cleared buffer, so the boards vanished for as long as the window edge was dragged
 * (8 of 8 compositor frames empty). Tiles are cached, so the draw is one composite. Returns frame()'s answer.
 */
export function resizeAndDraw(engine, cssWidth, cssHeight, dpr, cam) {
  engine.resize(cssWidth, cssHeight, dpr);
  if (cam) engine.setCamera(cam.x, cam.y, cam.z);
  // redraw(): a draw outside requestAnimationFrame. It composites what is cached and renders no tile (the display
  // frame it lands in has spent its tile budget already), and it stays out of the engine's frame clock: while a
  // window edge was dragged these draws, a few ms after each frame, read as a 240 Hz display.
  return engine.redraw ? engine.redraw() : engine.frame();
}

/**
 * The decode an image needs when its long side covers `devicePx` on screen: the first step of IMAGE_CAPS with a
 * little room above it (a tenth on the small steps; a twentieth on the large ones, where room is
 * megabytes).
 */
export function imageCapFor(devicePx) {
  for (const c of IMAGE_CAPS) if (devicePx <= c * (c <= MAX_IMAGE_SIDE ? 0.9 : 0.95)) return c;
  return FULL_IMAGE_SIDE;
}

/** The long side (world units) of the largest of `rects` (relative to a board at x, y) that meets `view` ({x, y, w, h}); 0 when none does. */
export function useInView(rects, x, y, view) {
  let side = 0;
  for (const r of rects) if (overlaps({ x: r.x + x, y: r.y + y, w: r.w, h: r.h }, view)) side = Math.max(side, r.w, r.h);
  return side;
}

/** Decoded bytes of an image at `cap`: from its own size when known (`nw` x `nh`), else from the shape it is drawn in (`aspect`: short side over long). */
export function decodedBytes(item, cap) {
  if (cap === item.cap && item.bytes) return item.bytes;
  if (item.nw > 0 && item.nh > 0) {
    const k = decodeScale(item.nw, item.nh, cap);
    return Math.max(1, Math.round(item.nw * k)) * Math.max(1, Math.round(item.nh * k)) * 4;
  }
  const long = cap, short = Math.max(1, cap * Math.min(1, item.aspect || 1));
  return Math.min(long * short, cap > MAX_IMAGE_SIDE ? FULL_IMAGE_PX : Infinity) * 4;
}

/**
 * Which images to decode now, and how large: [{ url, cap }].
 * items: { url, cap (held, 0: none), bytes (held), nw, nh (own size, 0: unknown), aspect, want (the step its size
 * on screen needs; the small one when it is not in view), shown, busy, at (last shown) }.
 * - An image in view gets the step it wants when that holds more pixels than what is held. One whose own pixels
 *   are all there is never decoded again (a 1600 px image held at "2048" has nothing more to give at "16384").
 * - Nothing shrinks while the total fits `budget`: zooming out and in again costs no decode.
 * - Over the budget, in this order until it fits: images out of view go small (least recently shown first), images
 *   in view held larger than they now need step down to it (largest first), and last the images in view take a
 *   smaller step than they want (largest first, never below the 2048 step).
 * The total is what the engine will hold once every decode in the plan has landed.
 */
export function planImageDecodes(items, budget) {
  const scaleAt = (it, cap) => (it.nw > 0 && it.nh > 0 ? decodeScale(it.nw, it.nh, cap) : cap);
  const plan = items.map((it) => {
    let target = it.cap;
    if (!it.cap) target = it.want;
    else if (it.shown && it.want > it.cap && scaleAt(it, it.want) > scaleAt(it, it.cap) * 1.0001) target = it.want;
    return { it, target };
  });
  const bytes = (p) => decodedBytes(p.it, p.target);
  let total = plan.reduce((n, p) => n + bytes(p), 0);
  const lower = (p, cap) => { total -= bytes(p); p.target = cap; total += bytes(p); };
  if (total > budget) {
    for (const p of plan.filter((p) => !p.it.shown && !p.it.busy && p.target > SMALL_IMAGE_SIDE).sort((a, b) => a.it.at - b.it.at)) {
      if (total <= budget) break;
      lower(p, SMALL_IMAGE_SIDE);
    }
    for (const p of plan.filter((p) => p.it.shown && !p.it.busy && p.target > p.it.want).sort((a, b) => bytes(b) - bytes(a))) {
      if (total <= budget) break;
      lower(p, p.it.want);
    }
    while (total > budget) {
      const p = plan.filter((p) => p.it.shown && !p.it.busy && p.target > MAX_IMAGE_SIDE).sort((a, b) => bytes(b) - bytes(a))[0];
      if (!p) break;
      lower(p, IMAGE_CAPS[IMAGE_CAPS.indexOf(p.target) - 1] || MAX_IMAGE_SIDE);
    }
  }
  return plan.filter((p) => p.target !== p.it.cap && !p.it.busy).map((p) => ({ url: p.it.url, cap: p.target }));
}

/** The factor a `w` x `h` decode is shrunk by for `cap` (long side); the full decode is also capped by area. Never above 1. */
export function decodeScale(w, h, cap) {
  return Math.min(1, cap / Math.max(w, h), cap > MAX_IMAGE_SIDE ? Math.sqrt(FULL_IMAGE_PX / (w * h)) : 1);
}

/** An asset that answered but cannot be drawn can settle while its retries continue. */
export const imageUnavailable = (error) => !!(error && (error.invalidBitmap || (error.status >= 400 && error.status < 500)));

/**
 * Bounded backoff for an image that could not be drawn: 1 s, 2 s, 4 s ... at most 30 s. That covers a missing file
 * too, because it may be written after the layer that uses it.
 */
export function imageRetryDelay(n) {
  return Math.min(30000, 1000 * Math.pow(2, Math.max(0, n - 1)));
}
