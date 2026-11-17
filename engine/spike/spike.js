import init, * as eng from '/pkg/canvas_engine.js';

const q = new URLSearchParams(location.search);
const tag = q.get('tag') || 'run';
const sceneKind = q.get('scene') || 'both';
const sceneCount = Number(q.get('count') || 20000);
const hud = document.getElementById('hud');
const canvas = document.getElementById('c');
const T = { t0: performance.now() };
const post = (path, body) => fetch(path, { method: 'POST', body }).catch(() => {});
const log = (...a) => { const s = a.join(' '); hud.textContent = s; post('/log', `${tag}: ${s}`); };
window.addEventListener('error', (e) => post('/log', `${tag}: ERROR ${e.message}`));
window.addEventListener('unhandledrejection', (e) => post('/log', `${tag}: REJECT ${e.reason}`));

const raf = () => new Promise((r) => requestAnimationFrame(r));
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const summ = (a) => ({ n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), max: a.length ? +Math.max(...a).toFixed(2) : null });

const report = { tag, ua: navigator.userAgent, dpr: devicePixelRatio, css: [innerWidth, innerHeight], hasGpu: !!navigator.gpu, runs: {} };

async function main() {
  report.hasGpu = !!navigator.gpu;
  log('navigator.gpu =', !!navigator.gpu);
  if (!navigator.gpu) { report.error = 'navigator.gpu missing'; await post(`/result?tag=${tag}`, JSON.stringify(report)); return; }
  try {
    const ad = await navigator.gpu.requestAdapter();
    if (ad) {
      const info = ad.info || (ad.requestAdapterInfo && await ad.requestAdapterInfo());
      report.jsAdapter = info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : 'no info';
      report.jsFeatures = [...ad.features];
    } else report.jsAdapter = 'null adapter';
  } catch (e) { report.jsAdapter = 'error ' + e; }
  log('js adapter', JSON.stringify(report.jsAdapter));

  const dpr = devicePixelRatio;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  const tWasm0 = performance.now();
  const exports = await init();
  report.wasmLoadMs = +(performance.now() - tWasm0).toFixed(1);
  const tDev0 = performance.now();
  report.engine = JSON.parse(await eng.init(canvas, dpr));
  report.deviceInitMs = +(performance.now() - tDev0).toFixed(1);
  log('engine up', JSON.stringify(report.engine));
  const fontBytes = new Uint8Array(await (await fetch('/font/arial.ttf')).arrayBuffer());
  report.fontFamily = eng.load_font(fontBytes);
  const tS = performance.now();
  report.scene = JSON.parse(eng.set_scene(sceneKind, sceneCount));
  report.sceneBuildMs = +(performance.now() - tS).toFixed(1);
  log('scene', JSON.stringify(report.scene));
  const tFirst = performance.now();
  eng.set_strategy(1); eng.set_camera(7600, 3400, 0.25); eng.render();
  await raf();
  report.firstFrameMs = +(performance.now() - tFirst).toFixed(1);
  report.startupMs = +(performance.now() - T.t0).toFixed(1);
  report.wasmMemoryMB = +(exports.memory.buffer.byteLength / 1048576).toFixed(1);

  const CX = 7600, CY = 3400;
  const zoomAt = (t) => 0.05 * Math.pow(80, 1 - Math.abs(2 * t - 1));
  const camZoom = (t) => [CX, CY, zoomAt(t)];
  const camPan = (t) => [600 + t * 12400, CY + 1500 * Math.sin(t * Math.PI * 2), 0.25];

  async function run(name, strategy, camFn, ms) {
    eng.set_strategy(strategy);
    if (strategy === 2) eng.free_tiles();
    // warm up shader/pipeline paths
    for (let i = 0; i < 5; i++) { const c = camFn(i / 100); eng.set_camera(...c); eng.render(); await raf(); }
    if (strategy === 2) eng.free_tiles();
    eng.reset_stats();
    const deltas = [];
    let prev = null;
    const heap0 = performance.memory ? performance.memory.usedJSHeapSize : null;
    const start = await raf();
    prev = start;
    for (;;) {
      const now = await raf();
      deltas.push(now - prev); prev = now;
      const t = (now - start) / ms;
      if (t >= 1) break;
      eng.set_camera(...camFn(t));
      eng.render();
    }
    const fr = eng.drain_frames(), gpu = eng.drain_gpu(), st = eng.stride();
    const cpu = [], enc = [], vel = [], vis = [], rer = [];
    for (let i = 0; i < fr.length; i += st) { cpu.push(fr[i]); enc.push(fr[i + 1]); vel.push(fr[i + 2]); vis.push(fr[i + 3]); rer.push(fr[i + 4]); }
    const g = [...gpu].filter((x) => !Number.isNaN(x));
    const r = {
      strategy, ms,
      rafDelta: summ(deltas),
      over8_3: deltas.filter((d) => d > 8.5).length,
      over16_7: deltas.filter((d) => d > 17.2).length,
      deltaCount: deltas.length,
      fps: +(1000 * deltas.length / deltas.reduce((a, b) => a + b, 0)).toFixed(1),
      renderCallMs: summ(cpu), encodeMs: summ(enc), velloMs: summ(vel),
      submitToGpuDoneMs: summ(g),
      visibleBoardsAvg: +(vis.reduce((a, b) => a + b, 0) / Math.max(1, vis.length)).toFixed(1),
      tilesRerenderedTotal: rer.reduce((a, b) => a + b, 0),
      jsHeapDeltaMB: heap0 == null ? null : +((performance.memory.usedJSHeapSize - heap0) / 1048576).toFixed(2),
    };
    // settle: crisp re-render at the final camera with the full strategy
    eng.set_strategy(1);
    const ts = performance.now(); eng.render(); await raf(); r.settleMs = +(performance.now() - ts).toFixed(1);
    report.runs[name] = r;
    log(name, JSON.stringify(r.rafDelta), 'cpu', JSON.stringify(r.renderCallMs));
  }

  async function steady(name, strategy, zoom) {
    eng.set_strategy(strategy);
    eng.set_camera(CX, CY, zoom);
    if (strategy === 2) eng.free_tiles();
    for (let i = 0; i < 20; i++) { eng.render(); await raf(); }
    eng.reset_stats();
    for (let i = 0; i < 60; i++) { eng.render(); await raf(); }
    const fr = eng.drain_frames(), gpu = eng.drain_gpu(), st = eng.stride();
    const cpu = [], vis = [];
    for (let i = 0; i < fr.length; i += st) { cpu.push(fr[i]); vis.push(fr[i + 3]); }
    report.runs[name] = { strategy, zoom, visibleBoards: vis[0], renderCallMs: summ(cpu), submitToGpuDoneMs: summ([...gpu].filter((x) => !Number.isNaN(x))) };
    log(name, JSON.stringify(report.runs[name].renderCallMs));
  }

  const names = { 1: 'append', 0: 'rebuild', 2: 'tiles' };
  for (const s of [1, 0, 2]) {
    await run(`zoom_${names[s]}`, s, camZoom, 5000);
    await run(`pan_${names[s]}`, s, camPan, 5000);
  }
  for (const s of [1, 0, 2]) for (const z of [0.05, 0.25, 1, 4]) await steady(`static_${names[s]}_z${z}`, s, z);

  // screenshots for text quality
  async function shot(name, zoom, cx, cy) {
    eng.set_strategy(1); eng.set_camera(cx, cy, zoom); eng.render();
    // toBlob in the same task as render so the WebGPU canvas content is still valid
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (blob) await post(`/shot?name=${tag}-${name}`, blob);
    report.shots = (report.shots || []).concat(name + (blob ? '' : ' (null blob)'));
    await raf();
  }
  const bx = 5 * 1400 + 600, by = 3 * 1000 + 400;
  await shot('z100', 1.0, bx, by);
  await shot('z300', 3.0, bx - 200, by - 150);

  report.jsHeapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
  await post(`/result?tag=${tag}`, JSON.stringify(report, null, 1));
  log('DONE');
}
main().catch(async (e) => { report.error = String(e && e.stack || e); await post(`/result?tag=${tag}`, JSON.stringify(report, null, 1)); log('FAILED', String(e)); });
