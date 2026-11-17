// Engine dev page: one real board drawn by the engine (left) and by the DOM renderer the main page
// uses today (right), same camera on both. Wheel pans, Cmd/Ctrl+wheel zooms, hover shows the node
// each side hits. URL: ?file=<document>&board=<id>[&z=<zoom>&wx=<world x>&wy=<world y>][&debug=1|2|3]
import init, { Engine } from '/pkg/canvas_engine.js';

const q = new URLSearchParams(location.search);
const file = q.get('file');
const api = (p, extra = '') => `${p}?file=${encodeURIComponent(file)}${extra}`;
const $ = (id) => document.getElementById(id);
const canvas = $('engine');
const world = $('world');
const left = $('left');
const right = $('right');
const info = (s) => ($('info').textContent = s);
const wait = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

// html.ts FIT_SCRIPT (the main page inlines it): fit vector viewBoxes, size groups and fit frames.
window.__fit = function (root, k) {
  k = k || 1;
  for (const svg of root.querySelectorAll('svg[data-tight]')) { const b = svg.firstElementChild.getBBox(); if (b.width || b.height) svg.setAttribute('viewBox', [b.x, b.y, b.width || 1, b.height || 1].join(' ')); }
  const fits = [...root.querySelectorAll('[data-fit]')].reverse();
  for (const el of fits) {
    const f = el.dataset.fit; const r = el.getBoundingClientRect(); let maxX = 0, maxY = 0;
    for (const c of el.children) { const qq = c.getBoundingClientRect(); maxX = Math.max(maxX, qq.right - r.left); maxY = Math.max(maxY, qq.bottom - r.top); }
    if (f.includes('w')) el.style.width = maxX / k + 'px'; if (f.includes('h')) el.style.height = maxY / k + 'px';
  }
};

let engine;
let cam = { x: 0, y: 0, z: 1 };
let doc;
let current;
let raf = 0;
const fontsSeen = new Map();

function kick() {
  if (raf) return;
  raf = requestAnimationFrame(function tick() {
    raf = 0;
    const more = engine.frame();
    const s = engine.stats();
    if (window.__firstFrameMs === undefined && s.tilesRendered > 0) window.__firstFrameMs = +(performance.now() - window.__t0).toFixed(1);
    info(`${s.adapter} · z ${(cam.z * 100).toFixed(0)}% · frame ${s.frameCpuMs.toFixed(1)} ms cpu, gpu ${s.gpuDoneMs.toFixed(1)} ms · tiles ${s.tileCount} (${(s.tileBytes / 1048576).toFixed(0)} MB) +${s.tilesRendered} in ${s.tileRenderMs.toFixed(1)} ms · ${s.nodes} nodes, layout ${s.layoutMs.toFixed(0)} ms, paint ${s.paintMs.toFixed(0)} ms${s.errors.length ? ' · ' + s.errors[0] : ''}`);
    if (more) kick();
    else settled();
  });
}

let settleWaiters = [];
function settled() { for (const r of settleWaiters.splice(0)) r(); }
const whenSettled = () => new Promise((r) => { settleWaiters.push(r); kick(); });

function applyCam() {
  world.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.z})`;
  engine.setCamera(cam.x, cam.y, cam.z);
  kick();
}

async function registerFonts(scene) {
  // In scene order: tagged faces (Google subsets, platform fallbacks) chain in that order.
  for (const f of scene.fonts) {
    if (fontsSeen.has(f.url)) continue;
    fontsSeen.set(f.url, 'loading');
    const r = await fetch(f.url);
    if (!r.ok) { fontsSeen.set(f.url, 'missing'); continue; }
    const bytes = new Uint8Array(await r.arrayBuffer());
    // Register with the face's own descriptors (what an @font-face rule would declare).
    engine.registerFont(f.family, Number(r.headers.get('x-font-weight')) || 0, r.headers.get('x-font-style') || '', bytes);
    fontsSeen.set(f.url, r.headers.get('x-font-source') || 'ok');
  }
}

const bitmaps = new Map();
async function registerImages(scene) {
  // Full-size bitmaps stay on the JS side; the engine decodes the level each board needs.
  await Promise.all(scene.images.map(async (url) => {
    try {
      let bm = bitmaps.get(url);
      if (!bm) { bm = await createImageBitmap(await (await fetch(url)).blob()); bitmaps.set(url, bm); }
      engine.registerImage(url, bm, bm.width, bm.height);
    } catch (e) { console.warn('image', url, e); }
  }));
}

async function loadDom(meta) {
  const d = await (await fetch(api('/api/board', `&id=${encodeURIComponent(meta.id)}`))).json();
  for (const href of d.links || []) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }
  if (d.faces) { const s = document.createElement('style'); s.textContent = d.faces; document.head.appendChild(s); }
  world.textContent = '';
  const b = document.createElement('div');
  b.className = 'board';
  b.style.left = meta.x + 'px';
  b.style.top = meta.y + 'px';
  b.innerHTML = d.html;
  world.appendChild(b);
  await wait(document.fonts.ready, 6000);
  await wait(Promise.all([...b.querySelectorAll('img')].map((i) => i.decode().catch(() => {}))), 8000);
  world.style.transform = 'none';
  window.__fit(b, 1);
}

function fitCam(r) {
  const W = left.clientWidth, H = left.clientHeight, pad = 24;
  const z = Number(q.get('z')) || Math.min(4, (W - pad * 2) / r.w, (H - pad * 2) / r.h);
  const wx = q.get('wx') !== null ? Number(q.get('wx')) : r.x + r.w / 2;
  const wy = q.get('wy') !== null ? Number(q.get('wy')) : r.y + r.h / 2;
  cam = { z, x: W / 2 - wx * z, y: H / 2 - wy * z };
  applyCam();
}

async function show(id) {
  window.__ready = false;
  const meta = doc.boards.find((b) => b.id === id) || doc.boards[0];
  current = meta;
  $('boards').value = meta.id;
  const t0 = performance.now();
  const scene = await (await fetch(api('/api/scene', `&id=${encodeURIComponent(meta.id)}`))).json();
  const tScene = performance.now();
  await registerFonts(scene);
  const tFonts = performance.now();
  for (const b of engine.boardsInView()) engine.removeBoard(b);
  const summary = engine.setBoard(meta.id, meta.x, meta.y, JSON.stringify(scene));
  const tSet = performance.now();
  const imgs = registerImages(scene);
  await loadDom(meta);
  await imgs;
  fitCam(summary.root);
  await whenSettled();
  await new Promise((r) => setTimeout(r, 200));
  await whenSettled();
  window.__summary = { ...summary, sceneMs: tScene - t0, fontsMs: tFonts - tScene, setBoardMs: tSet - tFonts, fonts: Object.fromEntries(fontsSeen), stats: engine.stats() };
  console.log('board', window.__summary);
  window.__ready = true;
}

// ---------------------------------------------------------------- interaction

function onWheel(e) {
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  if (e.ctrlKey || e.metaKey) {
    const z = Math.min(16, Math.max(0.02, cam.z * Math.exp(-e.deltaY * 0.01)));
    cam = { z, x: px - (px - cam.x) * (z / cam.z), y: py - (py - cam.y) * (z / cam.z) };
  } else cam = { ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY };
  applyCam();
}
left.addEventListener('wheel', onWheel, { passive: false });
right.addEventListener('wheel', onWheel, { passive: false });

function box(el, r) {
  if (!r) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.style.left = r.x * cam.z + cam.x + 'px';
  el.style.top = r.y * cam.z + cam.y + 'px';
  el.style.width = r.w * cam.z + 'px';
  el.style.height = r.h * cam.z + 'px';
}
function onMove(e) {
  const pane = e.currentTarget.getBoundingClientRect();
  const px = e.clientX - pane.left, py = e.clientY - pane.top;
  const idE = engine.hitTest(px, py);
  const t = document.elementFromPoint(right.getBoundingClientRect().left + px, pane.top + py);
  const hitD = t && t.closest && t.closest('#world [data-id]');
  const idD = hitD ? hitD.getAttribute('data-id') : null;
  box($('hlE'), idE && engine.nodeRect(idE));
  if (hitD) {
    const r = hitD.getBoundingClientRect(), v = right.getBoundingClientRect();
    box($('hlD'), { x: (r.left - v.left - cam.x) / cam.z, y: (r.top - v.top - cam.y) / cam.z, w: r.width / cam.z, h: r.height / cam.z });
  } else box($('hlD'), null);
  $('hover').textContent = `engine: ${idE ?? '–'}  dom: ${idD ?? '–'}${idE === idD ? '' : '  ≠'}`;
}
left.addEventListener('pointermove', onMove);
right.addEventListener('pointermove', onMove);

/** Compare engine node rects with the DOM's for every node of the current board. */
window.compareRects = function () {
  const v = right.getBoundingClientRect();
  const out = [];
  for (const el of world.querySelectorAll('[data-id]')) {
    const id = el.dataset.id;
    const e = engine.nodeRect(id);
    if (!e) continue;
    const r = el.getBoundingClientRect();
    const d = { x: (r.left - v.left - cam.x) / cam.z, y: (r.top - v.top - cam.y) / cam.z, w: r.width / cam.z, h: r.height / cam.z };
    const err = Math.max(Math.abs(d.x - e.x), Math.abs(d.y - e.y), Math.abs(d.w - e.w), Math.abs(d.h - e.h));
    out.push({ id, type: el.dataset.t, err, dom: d, engine: e });
  }
  out.sort((a, b) => b.err - a.err);
  return { count: out.length, over1px: out.filter((o) => o.err > 1).length, over4px: out.filter((o) => o.err > 4).length, worst: out.slice(0, 15) };
};

// ---------------------------------------------------------------- start

(async () => {
  if (!file) { info('add ?file=<path to a .canvas.json>'); return; }
  if (!navigator.gpu) { info('no WebGPU in this browser'); return; }
  // The engine starts while the document loads: its GPU setup overlaps the fetch.
  const tCreate = performance.now();
  window.__t0 = tCreate;
  const docP = fetch(api('/api/doc')).then((r) => r.json());
  await init();
  engine = await Engine.create(canvas);
  window.__createMs = performance.now() - tCreate;
  engine.setBackground('#f6f6f6');
  if (q.get('debug')) engine.setDebug(Number(q.get('debug')));
  new ResizeObserver(() => { engine.resize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio); kick(); }).observe(canvas);
  window.engine = engine;
  window.setCam = (x, y, z) => { cam = { x, y, z }; applyCam(); return whenSettled(); };
  window.getCam = () => cam;
  doc = await docP;
  const sel = $('boards');
  for (const b of doc.boards) { const o = document.createElement('option'); o.value = b.id; o.textContent = `${b.name} (${b.id})`; sel.append(o); }
  sel.onchange = () => { const u = new URL(location.href); u.searchParams.set('board', sel.value); history.replaceState(null, '', u); show(sel.value); };
  await show(q.get('board') || doc.boards[0].id);
})().catch((e) => { info('error: ' + e); console.error(e); });

/** Zoom in 8x and back out around the board centre over `ms`, then pan; frame timings per phase. */
window.bench = async function (ms = 3000, { dom = true } = {}) {
  // dom: false hides the DOM pane, whose compositing otherwise shares the GPU (and the
  // onSubmittedWorkDone timings) with the engine.
  right.style.display = dom ? '' : 'none';
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(2); };
  const run = async (camAt) => {
    const cpu = [], tile = [], gpu = [], dt = [];
    const t0 = performance.now();
    let prev = t0;
    for (;;) {
      const now = await new Promise((r) => requestAnimationFrame(r));
      const t = (now - t0) / ms;
      if (t >= 1) break;
      const c = camAt(t);
      cam = c;
      if (dom) world.style.transform = `translate(${c.x}px,${c.y}px) scale(${c.z})`;
      engine.setCamera(c.x, c.y, c.z);
      engine.frame();
      const s = engine.stats();
      cpu.push(s.frameCpuMs); tile.push(s.tileRenderMs); gpu.push(s.gpuDoneMs); dt.push(now - prev); prev = now;
    }
    const tSettle = performance.now();
    await whenSettled();
    return { frames: cpu.length, rafP50: pct(dt, 0.5), rafP95: pct(dt, 0.95), cpuP50: pct(cpu, 0.5), cpuP95: pct(cpu, 0.95), tileP95: pct(tile, 0.95), gpuP50: pct(gpu, 0.5), gpuP95: pct(gpu, 0.95), settleMs: +(performance.now() - tSettle).toFixed(1), tiles: engine.stats().tileCount, MB: +(engine.stats().tileBytes / 1048576).toFixed(1) };
  };
  const base = { ...cam };
  const W = left.clientWidth, H = left.clientHeight;
  const wx = (W / 2 - base.x) / base.z, wy = (H / 2 - base.y) / base.z;
  const zoom = await run((t) => { const z = base.z * Math.pow(8, 1 - Math.abs(2 * t - 1)); return { z, x: W / 2 - wx * z, y: H / 2 - wy * z }; });
  const pan = await run((t) => ({ z: base.z * 2, x: W / 2 - wx * base.z * 2 + Math.sin(t * Math.PI * 2) * W * 0.6, y: H / 2 - wy * base.z * 2 + Math.cos(t * Math.PI * 2) * H * 0.4 }));
  return { zoom, pan };
};

/** Engine only: load every board of the file, fit them all, report load costs (DOM pane unused). */
window.loadAll = async function () {
  window.__ready = false;
  world.textContent = '';
  const t0 = performance.now();
  let sceneMs = 0, setMs = 0, nodes = 0;
  const imgs = [];
  for (const meta of doc.boards) {
    const a = performance.now();
    const scene = await (await fetch(api('/api/scene', `&id=${encodeURIComponent(meta.id)}`))).json();
    if (scene.error) continue;
    sceneMs += performance.now() - a;
    await registerFonts(scene);
    const b = performance.now();
    nodes += engine.setBoard(meta.id, meta.x, meta.y, JSON.stringify(scene)).nodes;
    setMs += performance.now() - b;
    imgs.push(registerImages(scene));
  }
  const tBoards = performance.now();
  await Promise.all(imgs);
  const tImages = performance.now();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const meta of doc.boards) { const r = engine.nodeRect(meta.id); if (!r) continue; x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  const W = left.clientWidth, H = left.clientHeight;
  const z = Math.min((W - 40) / (x1 - x0), (H - 40) / (y1 - y0));
  cam = { z, x: W / 2 - ((x0 + x1) / 2) * z, y: H / 2 - ((y0 + y1) / 2) * z };
  applyCam();
  const tf = performance.now();
  await whenSettled();
  const firstAll = performance.now() - tf;
  window.__ready = true;
  const s = engine.stats();
  return { boards: doc.boards.length, nodes, totalMs: +(tBoards - t0).toFixed(0), sceneFetchMs: +sceneMs.toFixed(0), setBoardMs: +setMs.toFixed(0), imagesMs: +(tImages - tBoards).toFixed(0), fitAllSettleMs: +firstAll.toFixed(0), zoom: +z.toFixed(4), wasmMB: +(s.wasmBytes / 1048576).toFixed(1), imageMB: +(s.imageBytes / 1048576).toFixed(1), tileMB: +(s.tileBytes / 1048576).toFixed(1), effectMB: +(s.effectBytes / 1048576).toFixed(1), stats: s };
};
