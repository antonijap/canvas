// Side-by-side screenshots of the dev page in headless Chrome (WebGPU on), via the DevTools
// protocol. No dependencies (Node's own WebSocket).
//
//   CHROME=<chrome binary> OUT=<dir> node engine/dev/shoot.mjs <file.canvas.json> <name>=<boardId>[@z,wx,wy] ...
//
// Writes <OUT>/<name>.png (both panes) and <OUT>/<name>.json (board summary, stats, rect diff).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PAGE = process.env.PAGE ?? 'http://127.0.0.1:5186/';
const OUT = process.env.OUT ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
const CHROME = process.env.CHROME ?? (() => {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dir = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  return path.join(base, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
})();
const W = Number(process.env.W ?? 1600);
const H = Number(process.env.H ?? 1000);
const [file, ...shots] = process.argv.slice(2);
if (!file || !shots.length) {
  console.error('usage: node shoot.mjs <file.canvas.json> name=boardId[@z,wx,wy] ...');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-shoot-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--force-device-scale-factor=2', `--window-size=${W},${H}`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
const cleanup = () => {
  try { ws?.close(); } catch {}
  chrome.kill('SIGTERM');
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
};
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch {}
}
if (!target) throw new Error('chrome did not start');
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    const { res, rej } = pending.get(d.id);
    pending.delete(d.id);
    d.error ? rej(new Error(d.error.message)) : res(d.result);
  } else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') console.log('[page error]', d.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (d.method === 'Runtime.exceptionThrown') console.log('[page exception]', d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
});
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

await cdp('Runtime.enable');
await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

for (const spec of shots) {
  const [name, rest] = spec.split('=');
  const [board, view] = rest.split('@');
  const [z, wx, wy] = (view ?? '').split(',');
  const u = new URL(PAGE);
  u.searchParams.set('file', file);
  u.searchParams.set('board', board);
  if (z) u.searchParams.set('z', z);
  if (wx) u.searchParams.set('wx', wx);
  if (wy) u.searchParams.set('wy', wy);
  const t0 = Date.now();
  await cdp('Page.navigate', { url: u.href });
  let ready = false;
  for (let i = 0; i < 600 && !ready; i++) {
    await sleep(100);
    ready = await evaluate('window.__ready === true').catch(() => false);
  }
  if (!ready) {
    console.log(name, 'not ready after 60 s:', await evaluate('document.getElementById("info").textContent'));
    continue;
  }
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
  const meta = await evaluate('({ summary: window.__summary, createMs: window.__createMs, rects: window.compareRects(), info: document.getElementById("info").textContent })');
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(meta, null, 1));
  if (process.env.EVAL) console.log(await evaluate(process.env.EVAL));
  console.log(`${name}: ${board} in ${Date.now() - t0} ms · nodes ${meta.summary?.nodes} · rects >1px ${meta.rects.over1px}/${meta.rects.count}, >4px ${meta.rects.over4px} · ${meta.info}`);
}
cleanup();
process.exit(0);
