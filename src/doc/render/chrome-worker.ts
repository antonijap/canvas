// Runs in a worker thread: owns one headless Chrome, talking over a pipe so no port is opened.
// The main thread waits with Atomics, which lets the synchronous script API ask for layout mid-snippet.
// Chrome quits after two idle minutes and its temporary profile is deleted.

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { type MessagePort, workerData } from "node:worker_threads";
import { chromePath } from "./chrome-path.ts";

const { flag, port, profileDir } = workerData as { flag: Int32Array; port: MessagePort; profileDir: string };
const IDLE_MS = 120_000;

let chrome: ChildProcess | null = null;
let pipeIn: Writable;
let session = "";
let nextId = 1;
let buffer = "";
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const events: { method: string; session?: string; resolve: () => void }[] = [];
let idle: NodeJS.Timeout | null = null;

function send(method: string, params: object = {}, sessionId?: string): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    pipeIn.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
}

function onData(chunk: Buffer) {
  buffer += chunk.toString("utf8");
  let i = buffer.indexOf("\0");
  while (i >= 0) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf("\0");
    if (msg.id && waiting.has(msg.id)) {
      const w = waiting.get(msg.id)!;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    } else if (msg.method) {
      const k = events.findIndex((e) => e.method === msg.method);
      if (k >= 0) events.splice(k, 1)[0].resolve();
    }
  }
}

const nextEvent = (method: string, timeout = 30_000) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Chrome did not report ${method} in time`)), timeout);
    events.push({ method, resolve: () => (clearTimeout(t), resolve()) });
  });

function cleanup() {
  chrome = null;
  session = "";
  buffer = "";
  for (const w of waiting.values()) w.reject(new Error("Chrome stopped"));
  waiting.clear();
  fs.rmSync(profileDir, { recursive: true, force: true });
}

async function ensureChrome() {
  if (chrome) return;
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(
    chromePath(),
    ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update", "--disable-features=Translate,MediaRouter,OptimizationHints", "--hide-scrollbars", "--enable-unsafe-webgpu", "--mute-audio", "--use-mock-keychain", "--password-store=basic", "--allow-file-access-from-files", "--force-color-profile=srgb", "--font-render-hinting=none", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  chrome = child;
  const gone = () => {
    if (chrome === child) cleanup();
  };
  child.on("exit", gone);
  child.on("error", gone);
  pipeIn = child.stdio[3] as Writable;
  (child.stdio[4] as Readable).on("data", onData);
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  session = sessionId;
  await send("Page.enable", {}, session);
  await send("Runtime.enable", {}, session);
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false }, session);
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, session);
}

function quit() {
  const child = chrome;
  if (!child) return;
  send("Browser.close").catch(() => {});
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 2000).unref();
}

async function load(html: string) {
  await ensureChrome();
  const file = path.join(profileDir, "page.html");
  fs.writeFileSync(file, html);
  const loaded = nextEvent("Page.loadEventFired");
  await send("Page.navigate", { url: pathToFileURL(file).href }, session);
  await loaded;
  const r = await send("Runtime.evaluate", { expression: "window.__layout()", awaitPromise: true, returnByValue: true }, session);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "layout failed");
  return r.result.value;
}

async function handle(req: any): Promise<any> {
  if (req.op === "warm") {
    await ensureChrome();
    return {};
  }
  if (req.op === "card") {
    await ensureChrome();
    // This renderer reads only the headless server. It never joins the person's page bridge.
    const script = await send("Page.addScriptToEvaluateOnNewDocument", { source: "const NativeEventSource = window.EventSource; window.EventSource = class { constructor(url, options) { if (String(url).startsWith('/api/bridge/events')) return { close() {}, addEventListener() {} }; return new NativeEventSource(url, options); } };" }, session);
    try {
      const loaded = nextEvent("Page.loadEventFired");
      await send("Page.navigate", { url: req.url }, session);
      await loaded;
      const expression = `(async () => {
        const end = Date.now() + 20000;
        while (!window.canvasHost?.[${JSON.stringify(req.kind)}] || window.__canvas?.renderer !== 'engine') {
          if (Date.now() > end) throw new Error('Headless media renderer did not load');
          await new Promise(r => setTimeout(r, 50));
        }
        if (${JSON.stringify(req.page ?? null)} && window.canvasHost.page !== ${JSON.stringify(req.page ?? null)}) await window.canvasHost.setPage(${JSON.stringify(req.page ?? null)});
        return window.canvasHost[${JSON.stringify(req.kind)}](${JSON.stringify(req.args)});
      })()`;
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "Media frame failed");
      return r.result.value;
    } finally {
      const cleared = nextEvent("Page.loadEventFired");
      await send("Page.navigate", { url: "about:blank" }, session);
      await cleared;
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script.identifier }, session);
    }
  }
  if (req.op === "layout") return { rects: await load(req.html) };
  if (req.op === "shot") {
    const out: string[] = [];
    const white = req.background === "white";
    const target = typeof req.target === "string" ? req.target : null;
    if (white) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 255, g: 255, b: 255, a: 1 } }, session);
    try {
      // Keep the target in its laid-out position while hiding the rest of the document.
      if (target !== null) await send("Runtime.evaluate", { expression: `{
        const style = document.createElement("style");
        style.id = "canvas-export-target";
        const id = CSS.escape(${JSON.stringify(target)});
        style.textContent = 'body { visibility: hidden } [data-id="' + id + '"] { visibility: visible }';
        document.head.append(style);
      }` }, session);
      for (const c of req.clips) {
        const r = await send("Page.captureScreenshot", { format: req.format ?? "png", ...(req.quality ? { quality: req.quality } : {}), captureBeyondViewport: true, clip: { x: c.x, y: c.y, width: Math.max(1, c.width), height: Math.max(1, c.height), scale: c.scale } }, session);
        out.push(r.data);
      }
    } finally {
      if (target !== null) await send("Runtime.evaluate", { expression: 'document.getElementById("canvas-export-target")?.remove()' }, session);
      if (white) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, session);
    }
    return { images: out };
  }
  if (req.op === "eval") {
    const r = await send("Runtime.evaluate", { expression: req.expression, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed");
    return { value: r.result.value };
  }
  if (req.op === "pdf") {
    const r = await send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true }, session);
    return { pdf: r.data };
  }
  if (req.op === "quit") {
    quit();
    return {};
  }
  throw new Error(`unknown op ${req.op}`);
}

port.on("message", async (req) => {
  if (idle) clearTimeout(idle);
  let res: any;
  try {
    res = { ok: await handle(req) };
  } catch (e) {
    res = { error: (e as Error).message };
  }
  port.postMessage(res);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  idle = setTimeout(quit, IDLE_MS);
  idle.unref();
});

// Tidy profiles left by a server that was killed before it could clean up.
for (const name of fs.readdirSync(os.tmpdir())) {
  const m = name.match(/^canvas-chrome-(\d+)$/);
  if (!m || Number(m[1]) === process.pid) continue;
  try {
    process.kill(Number(m[1]), 0);
  } catch {
    fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
}
