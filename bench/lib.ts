// Shared helpers: stats, file picking, synthetic-file generator, CDP client, Chrome launcher.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = path.join(ROOT, "bench", "out");
export const PORT = Number(process.env.BENCH_PORT ?? 5199);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const round = (n: number, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

export function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
export function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, min: round(s[0]), p50: round(pct(s, 50)), p95: round(pct(s, 95)), p99: round(pct(s, 99)), max: round(s[s.length - 1]), mean: round(sum / (s.length || 1)) };
}

// ---------------------------------------------------------------- files
export type BenchFile = { label: string; path: string; bytes: number; synthetic?: boolean };

/** 200 boards x 50 nodes, laid out on a 20-column grid. Helvetica (system font) so no network font fetch. */
export function writeSynthetic(file: string, boards = 200, nodesPerBoard = 50): void {
  const W = 390, H = 844, GAP = 120, COLS = 20;
  const text = (id: string, content: string, size = 16, weight = "400") => ({ type: "text", id, content, fontFamily: "Helvetica", fontSize: size, fontWeight: weight, fill: "$fg" });
  const children = [];
  for (let b = 0; b < boards; b++) {
    const k = (s: string) => `b${b}${s}`;
    const kids: unknown[] = [text(k("t"), `Board ${b}`, 28, "700")];
    kids.push({ type: "frame", id: k("h"), layout: "horizontal", gap: 8, width: "fill_container", children: [text(k("h1"), "Header", 14, "600"), { type: "rectangle", id: k("h2"), width: 24, height: 24, fill: "$accent", cornerRadius: 12 }] });
    let count = 1 + 1 + 3 + 2; // board, title, header(3), footer(2)
    let r = 0;
    while (count + 5 <= nodesPerBoard - 1) {
      kids.push({ type: "frame", id: k(`r${r}`), layout: "horizontal", gap: 12, padding: 8, alignItems: "center", cornerRadius: 8, fill: r % 2 ? "#FFFFFF" : "#F2F2F7", width: "fill_container", children: [
        { type: "rectangle", id: k(`r${r}a`), width: 40, height: 40, cornerRadius: 20, fill: "$accent" },
        { type: "frame", id: k(`r${r}c`), layout: "vertical", gap: 2, children: [text(k(`r${r}x`), `Row ${r} title`, 15, "600"), text(k(`r${r}y`), `Row ${r} subtitle text for board ${b}`, 12)] },
      ] });
      count += 5; r++;
    }
    // one component instance, then plain rectangles up to the node budget
    kids.push({ type: "ref", id: k("chip"), ref: "chip", descendants: { "chip-t": { content: `Chip ${b}` } } });
    count += 2;
    let e = 0;
    while (count < nodesPerBoard - 2) { kids.push({ type: "rectangle", id: k(`e${e++}`), width: 60, height: 6, fill: "#D1D1D6", cornerRadius: 3 }); count++; }
    kids.push({ type: "frame", id: k("f"), layout: "horizontal", justifyContent: "center", padding: 12, cornerRadius: 12, fill: "$accent", width: "fill_container", children: [text(k("ft"), "Continue", 16, "600")] });
    children.push({ type: "frame", id: `board${b}`, name: `Board ${b}`, x: (b % COLS) * (W + GAP), y: Math.floor(b / COLS) * (H + GAP), width: W, height: H, fill: "#FFFFFF", layout: "vertical", gap: 12, padding: 20, children: kids });
  }
  children.push({ type: "frame", id: "chip", reusable: true, name: "Chip", x: -600, y: 0, layout: "horizontal", padding: 6, cornerRadius: 10, fill: "#E5E5EA", children: [{ type: "text", id: "chip-t", content: "Chip", fontFamily: "Helvetica", fontSize: 12, fontWeight: "500", fill: "#000000" }] });
  const doc = { version: "2.21", themes: { mode: ["light", "dark"] }, variables: { accent: { type: "color", value: "#0766EB" }, fg: { type: "color", value: [{ value: "#18181B", theme: { mode: "light" } }, { value: "#FCFCFC", theme: { mode: "dark" } }] } }, children };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

export function countNodes(doc: { children: any[] }): number {
  let n = 0; const w = (x: any) => { n++; (x.children ?? []).forEach?.(w); }; doc.children.forEach(w); return n;
}

// ---------------------------------------------------------------- chrome + CDP
export function findChrome(): string {
  const cands = [
    process.env.BENCH_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ...fs.readdirSync(path.join(os.homedir(), "Library/Caches/ms-playwright")).filter((d) => d.startsWith("chromium-")).sort().reverse().map((d) => path.join(os.homedir(), "Library/Caches/ms-playwright", d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")),
  ].filter(Boolean) as string[];
  const hit = cands.find((c) => fs.existsSync(c));
  if (!hit) throw new Error("no Chrome found; set BENCH_CHROME");
  return hit;
}

export class Cdp {
  private id = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private handlers: ((m: any) => void)[] = [];
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!; this.pending.delete(m.id);
        m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result);
      } else for (const h of this.handlers) h(m);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", () => rej(new Error("ws error"))); });
    return new Cdp(ws);
  }
  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 90_000);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  on(h: (m: any) => void) { this.handlers.push(h); return () => { this.handlers = this.handlers.filter((x) => x !== h); }; }
  close() { this.ws.close(); }
}

export type Chrome = { proc: ChildProcess; cdp: Cdp; version: string; userAgent: string; exe: string; stop: () => Promise<void> };

export async function launchChrome(): Promise<Chrome> {
  const exe = findChrome();
  const port = 9333 + Math.floor(Math.random() * 500);
  const dir = fs.mkdtempSync(path.join(OUT, "chrome-profile-"));
  const proc = spawn(exe, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check",
    "--window-size=1440,900", "--hide-scrollbars", "--mute-audio", "--disable-extensions", "--disable-background-networking",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling",
    // WebGPU on, so the page picks the engine renderer (BENCH_QUERY="&renderer=dom" measures the DOM one).
    "--enable-unsafe-webgpu", "--use-angle=metal", "about:blank",
  ], { stdio: "ignore" });
  let info: any;
  for (let i = 0; i < 100; i++) {
    try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(100); }
  }
  if (!info) { proc.kill(); throw new Error("chrome did not start"); }
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl);
  return {
    proc, cdp, exe, version: info.Browser, userAgent: info["User-Agent"],
    stop: async () => { try { cdp.close(); } catch {} proc.kill("SIGTERM"); await sleep(300); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
