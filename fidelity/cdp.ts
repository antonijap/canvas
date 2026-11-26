// A small headless Chrome driver over the DevTools protocol (global WebSocket, no deps). Chrome comes from
// The renderer's finder (src/doc/render/chrome-path.ts: an installed Chrome, else Playwright's Chrome for Testing in ~/Library/Caches/ms-playwright).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromePath } from "../src/doc/render/chrome-path.ts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Page {
  private id = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  readonly console: string[] = [];
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result);
      } else if (m.method === "Runtime.consoleAPICalled") this.console.push(`${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ")}`);
      else if (m.method === "Runtime.exceptionThrown") this.console.push(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
      if (m.method) for (const f of this.listeners.get(m.method) ?? []) f(m.params);
    });
  }
  private listeners = new Map<string, ((params: any) => void)[]>();
  /** Every event `method` (Fetch.requestPaused, ...) from now on. */
  on(method: string, f: (params: any) => void) { this.listeners.set(method, [...(this.listeners.get(method) ?? []), f]); }
  static async connect(url: string): Promise<Page> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", () => rej(new Error("DevTools socket error"))); });
    const p = new Page(ws);
    await p.send("Page.enable");
    await p.send("Runtime.enable");
    return p;
  }
  send<T = any>(method: string, params: object = {}, timeout = 90_000): Promise<T> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`DevTools timeout: ${method}`)); }, timeout);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T = any>(expression: string, timeout = 60_000): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async goto(url: string) {
    const loaded = new Promise<void>((res) => {
      const h = (ev: MessageEvent) => { if (JSON.parse(String(ev.data)).method === "Page.loadEventFired") { this.ws.removeEventListener("message", h); res(); } };
      this.ws.addEventListener("message", h);
    });
    await this.send("Page.navigate", { url });
    await Promise.race([loaded, sleep(20_000)]);
  }
  /** PNG of the top-left W x H CSS px at device scale `scale`. */
  async shot(W: number, H: number, scale: number): Promise<Buffer> {
    await this.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: scale, mobile: false });
    await this.eval("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const r = await this.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 }, fromSurface: true });
    return Buffer.from(r.data, "base64");
  }
  close() { try { this.ws.close(); } catch {} }
}

export type Chrome = { proc: ChildProcess; port: number; exe: string; version: string; newPage: () => Promise<Page>; stop: () => Promise<void> };

// Every Chrome this process started. A run that throws past its finally, or is stopped by a signal, still ends
// them: an orphaned test browser stays alive and shows an icon in the menu bar.
const live = new Set<ChildProcess>();
const killAll = () => { for (const p of live) { try { p.kill("SIGKILL"); } catch {} } live.clear(); };
process.once("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => { killAll(); if (process.listenerCount(sig) === 0) process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1)); });

/** Launch headless Chrome with WebGPU on (needed for the engine page, harmless for the DOM truth). `extra`: more flags. */
export async function launchChrome(extra: string[] = []): Promise<Chrome> {
  const exe = chromePath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-fidelity-chrome-"));
  const proc = spawn(exe, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--mute-audio", "--disable-extensions", "--disable-background-networking", "--force-color-profile=srgb",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling",
    "--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=Vulkan", ...extra, "about:blank",
  ], { stdio: "ignore" });
  live.add(proc);
  proc.once("exit", () => live.delete(proc));
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    try { port = Number(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { await sleep(100); }
  }
  if (!port) { proc.kill(); throw new Error("Chrome did not start"); }
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser as string;
  const pages: Page[] = [];
  return {
    proc, port, exe, version,
    newPage: async () => {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
      const p = await Page.connect(t.webSocketDebuggerUrl);
      pages.push(p);
      return p;
    },
    stop: async () => {
      for (const p of pages) p.close();
      proc.kill("SIGTERM");
      await sleep(300);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      live.delete(proc);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
