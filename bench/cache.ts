// Load timings with and without the caches: headless Chrome over CDP against a real server
// on a clone of a document. Each run loads the page on one of the document's pages and reads the page's own
// timings (window.canvasHost.perf: look = every board in view shows its content or its snapshot, load = fully drawn,
// images included). Runs: a fresh profile (nothing cached), a reload (HTTP cache and snapshots warm), and a reload
// with the HTTP cache bypassed (snapshots only).
//
//   node bench/cache.ts <file.canvas.json | doc.canvas> [pageId] [rounds]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchChrome, sleep } from "../fidelity/cdp.ts";
import { ROOT } from "./lib.ts";

const src = process.argv[2];
const pageId = process.argv[3] ?? "";
const rounds = Number(process.argv[4] ?? 3);
if (!src) { console.error("usage: node bench/cache.ts <file> [pageId] [rounds]"); process.exit(2); }

// A clone (APFS copy-on-write: instant, no space) so nothing the page or server does can touch the original.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-cache-bench-"));
const copy = path.join(tmp, path.basename(src));
fs.cpSync(src, copy, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
const port = 5300 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [path.join(ROOT, "src/server.ts")], { env: { ...process.env, CANVAS_PORT: String(port), CANVAS_ROOTS: tmp }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await sleep(100); }

const chrome = await launchChrome();
const page = await chrome.newPage();
await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await page.send("Network.enable");
if (pageId) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem(${JSON.stringify("canvas:page:" + copy)}, ${JSON.stringify(JSON.stringify(pageId))}); } catch {}` });
const url = `${base}/?file=${encodeURIComponent(copy)}`;

async function measure(label: string) {
  const t0 = Date.now();
  await page.goto(url);
  let perf: any = null;
  for (let i = 0; i < 600; i++) {
    perf = await page.eval("window.canvasHost && window.canvasHost.perf ? JSON.parse(JSON.stringify(window.canvasHost.perf)) : null").catch(() => null);
    if (perf && perf.load !== null) break;
    await sleep(50);
  }
  const res = await page.eval(`(() => { const out = { scene: [0, 0, 0], asset: [0, 0, 0] }; for (const e of performance.getEntriesByType("resource")) { const k = e.name.includes("/api/scene?") ? "scene" : e.name.includes("/asset?") ? "asset" : null; if (!k) continue; out[k][0]++; if (e.transferSize === 0) out[k][1]++; out[k][2] = Math.max(out[k][2], Math.round(e.responseEnd)); } return out; })()`);
  const row = { run: label, look: perf?.look, load: perf?.load, doc: perf?.doc, engine: perf?.engine, landed: perf?.landed, snapshots: perf?.snapshots, scenes: `${res.scene[0]} (${res.scene[1]} cached)`, scenesDoneAt: res.scene[2], assets: `${res.asset[0]} (${res.asset[1]} cached)`, wallMs: Date.now() - t0 };
  console.log(JSON.stringify(row));
  // Snapshots are taken a moment after the canvas settles.
  await sleep(2500);
  return row;
}

try {
  await measure("fresh profile (nothing cached)");
  for (let i = 0; i < rounds; i++) await measure("reload (HTTP cache + snapshots)");
  await page.send("Network.setCacheDisabled", { cacheDisabled: true });
  for (let i = 0; i < rounds; i++) await measure("reload, HTTP cache off (snapshots only)");
  await page.send("Network.setCacheDisabled", { cacheDisabled: false });
  for (let i = 0; i < rounds; i++) {
    await page.send("Storage.clearDataForOrigin", { origin: base, storageTypes: "indexeddb" });
    await measure("reload, snapshots cleared (HTTP cache only)");
  }
  if (page.console.some((l) => l.startsWith("exception") || l.startsWith("error"))) console.log("console:", page.console.filter((l) => l.startsWith("exception") || l.startsWith("error")).slice(0, 10));
} finally {
  await chrome.stop();
  server.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}
