// Shared QA plumbing: a scratch Canvas server on a free port, and headless Chrome pages with real input.
// Chrome and the DevTools socket come from fidelity/cdp.ts (Node's built-in WebSocket, no extra deps).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Page, sleep } from "../fidelity/cdp.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export { sleep };

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

export type Scratch = { port: number; base: string; proc: ChildProcess; log: string[]; stop: () => Promise<void> };

/** `node src/server.ts` on a free port, reading and writing only under `dir`. */
export async function startServer(dir: string): Promise<Scratch> {
  const port = await freePort();
  const log: string[] = [];
  const proc = spawn(process.execPath, [path.join(ROOT, "src/server.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      CANVAS_PORT: String(port),
      CANVAS_ROOTS: dir,
      CANVAS_WEB_FONTS: "0",
      CANVAS_TRUST_FILE: path.join(dir, ".trust.json"),
      CANVAS_VIDEO_PROXIES: path.join(dir, ".video-proxies"),
      CANVAS_MCP_NO_SPAWN: "1",
      // Backups of every write go here, not into ~/Library/Application Support/Canvas (scratch runs had left thousands of folders there).
      CANVAS_STATE_DIR: path.join(dir, ".canvas-state"),
      // The agents' own config (whether canvas is registered, for the welcome card's Connect) is a scratch one: never
      // this Mac's, so a run reads the same on every machine and never writes the person's config.
      CLAUDE_CONFIG_DIR: path.join(dir, ".claude-config"),
      CODEX_HOME: path.join(dir, ".codex-home"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (d) => log.push(String(d)));
  proc.stderr!.on("data", (d) => log.push("stderr: " + String(d)));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (proc.exitCode !== null) throw new Error(`server exited: ${log.join("")}`);
    if (Date.now() - t0 > 30_000) { proc.kill("SIGKILL"); throw new Error(`server did not answer in 30 s: ${log.join("")}`); }
    await sleep(50);
  }
  return {
    port, base, proc, log,
    stop: async () => {
      if (proc.exitCode !== null) return;
      const gone = new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill("SIGTERM");
      await Promise.race([gone, sleep(6000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    },
  };
}

/** A tiny HTTP client for one scratch server and one document. */
export function api(base: string, file: string) {
  const q = (p: string) => `${base}${p}${p.includes("?") ? "&" : "?"}file=${encodeURIComponent(file)}`;
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(q(p), { method, headers: { "x-canvas": "1", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let j: any;
    try { j = JSON.parse(text); } catch { j = text; }
    if (!r.ok) throw Object.assign(new Error(`${method} ${p}: ${r.status} ${typeof j === "object" ? j.error ?? text : text}`), { status: r.status, body: j });
    return j;
  };
  return {
    get: (p: string) => call("GET", p),
    post: (p: string, b?: unknown, h?: Record<string, string>) => call("POST", p, b ?? {}, h),
    put: (p: string, b?: unknown) => call("PUT", p, b ?? {}),
    patch: (p: string, b?: unknown) => call("PATCH", p, b ?? {}),
    status: async (p: string) => (await fetch(q(p))).status,
    flush: () => fetch(`${base}/api/flush`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file }) }).then((r) => r.json()),
  };
}

export function copyDir(from: string, to: string) {
  fs.cpSync(from, to, { recursive: true, filter: (src) => !path.basename(src).startsWith(".") || src === from });
}

// ---------------------------------------------------------------- input on a CDP page

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
export type Mods = Partial<Record<keyof typeof MOD, boolean>>;
const modBits = (m: Mods = {}) => Object.entries(m).reduce((a, [k, v]) => a | (v ? MOD[k as keyof typeof MOD] : 0), 0);

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  End: { key: "End", code: "End", keyCode: 35 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
};

function keyInfo(k: string, shift: boolean) {
  if (KEYS[k]) return KEYS[k];
  if (k.length === 1) {
    const up = k.toUpperCase();
    const isLetter = /[a-z]/i.test(k);
    const isDigit = /[0-9]/.test(k);
    const code = isLetter ? `Key${up}` : isDigit ? `Digit${k}` : ({ "#": "Digit3", " ": "Space", "-": "Minus", "_": "Minus", "=": "Equal", "+": "Equal", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", ".": "Period", ",": "Comma", "/": "Slash", "\\": "Backslash" } as Record<string, string>)[k] ?? "";
    const keyCode = isLetter ? up.charCodeAt(0) : isDigit ? k.charCodeAt(0) : k === " " ? 32 : k === "-" || k === "_" ? 189 : k === "=" || k === "+" ? 187 : k === "'" ? 222 : 0;
    const key = isLetter && shift ? up : k;
    return { key, code, keyCode, text: key };
  }
  throw new Error(`unknown key ${k}`);
}

/** Real input on a page: mouse moves in steps, keys with modifiers. Coordinates are CSS px in the viewport. */
export class Input {
  x = 0;
  y = 0;
  mods: Mods = {};
  readonly page: Page;
  constructor(page: Page) { this.page = page; }
  private m(type: string, x: number, y: number, extra: object = {}) {
    return this.page.send("Input.dispatchMouseEvent", { type, x, y, modifiers: modBits(this.mods), ...extra });
  }
  async move(x: number, y: number, steps = 1, buttons = 0) {
    const x0 = this.x, y0 = this.y;
    for (let i = 1; i <= steps; i++) {
      const px = x0 + ((x - x0) * i) / steps, py = y0 + ((y - y0) * i) / steps;
      await this.m("mouseMoved", px, py, { button: buttons ? "left" : "none", buttons });
      if (steps > 1) await sleep(8);
    }
    this.x = x; this.y = y;
  }
  async down(clickCount = 1) { await this.m("mousePressed", this.x, this.y, { button: "left", buttons: 1, clickCount }); }
  async up(clickCount = 1) { await this.m("mouseReleased", this.x, this.y, { button: "left", buttons: 0, clickCount }); }
  async click(x: number, y: number, mods: Mods = {}) {
    await this.withMods(mods, async () => {
      await this.move(x, y);
      await this.down(1);
      await this.up(1);
    });
  }
  async dblclick(x: number, y: number, mods: Mods = {}) {
    await this.withMods(mods, async () => {
      await this.move(x, y);
      await this.down(1); await this.up(1);
      await this.down(2); await this.up(2);
    });
  }
  /** Press at (x0, y0), move in steps to (x1, y1), release. `during` runs before the release. */
  /** `mods` are held from before the press, `late` only once the drag has started (Cmd at the press is a marquee). */
  /** `keys` (e.g. "Space") go down with `late` and come up after the release, as a person holds them through the drop. */
  async drag(x0: number, y0: number, x1: number, y1: number, opts: { mods?: Mods; late?: Mods; keys?: string[]; steps?: number; during?: () => Promise<void>; hold?: number } = {}) {
    await this.withMods(opts.mods ?? {}, async () => {
      await this.move(x0, y0);
      await this.down();
      await sleep(opts.hold ?? 30);
      const steps = opts.steps ?? 12;
      // The first steps without the late keys, so the gesture is a drag before they go down.
      const k = Math.min(2, steps);
      await this.move(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps, k, 1);
      await this.withMods(opts.late ?? {}, async () => {
        for (const key of opts.keys ?? []) await this.keyDown(key);
        await this.move(x1, y1, steps - k || 1, 1);
        await sleep(60);
        if (opts.during) await opts.during();
        await this.up();
        await sleep(30);
        for (const key of opts.keys ?? []) await this.keyUp(key);
      });
    });
  }
  async withMods(mods: Mods, fn: () => Promise<void>) {
    const keys = (Object.keys(mods) as (keyof Mods)[]).filter((k) => mods[k]);
    const name = { alt: "Alt", shift: "Shift", meta: "Meta", ctrl: "Control" } as const;
    for (const k of keys) {
      this.mods = { ...this.mods, [k]: true };
      const info = k === "ctrl" ? { key: "Control", code: "ControlLeft", keyCode: 17 } : KEYS[name[k]];
      await this.page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers: modBits(this.mods) });
    }
    try {
      await fn();
    } finally {
      for (const k of keys.reverse()) {
        const info = k === "ctrl" ? { key: "Control", code: "ControlLeft", keyCode: 17 } : KEYS[name[k]];
        const rest = { ...this.mods, [k]: false };
        this.mods = rest;
        await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers: modBits(this.mods) });
      }
    }
  }
  /** A key held down (no character typed), until keyUp. */
  async keyDown(k: string) {
    const info = keyInfo(k, !!this.mods.shift);
    await this.page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers: modBits(this.mods) });
  }
  async keyUp(k: string) {
    const info = keyInfo(k, !!this.mods.shift);
    await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers: modBits(this.mods) });
  }
  /** One key press, with modifiers held around it. Printable keys without Cmd type their character. */
  async key(k: string, mods: Mods = {}) {
    await this.withMods(mods, async () => {
      const info = keyInfo(k, !!this.mods.shift);
      const typing = !!info.text && !this.mods.meta && !this.mods.ctrl;
      const bits = modBits(this.mods);
      // Cmd shortcuts go through the browser's command path in headless Chrome only when sent as rawKeyDown.
      await this.page.send("Input.dispatchKeyEvent", { type: typing ? "keyDown" : "rawKeyDown", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers: bits, ...(typing ? { text: info.text, unmodifiedText: info.text } : {}) });
      await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers: bits });
    });
  }
  /** Type text one key at a time (real keydown/keypress/input per character). */
  async type(s: string) {
    for (const ch of s) {
      if (ch === "\n") await this.key("Enter");
      else await this.key(ch, /[A-Z#]/.test(ch) ? { shift: true } : {});
    }
  }
}

/** A new tab on `port` (Chrome's DevTools port) and a close that really closes it, so its event streams end. */
export async function openTab(port: number): Promise<{ page: Page; close: () => Promise<void> }> {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const page = await Page.connect(t.webSocketDebuggerUrl);
  return {
    page,
    close: async () => {
      page.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {});
    },
  };
}

/** A w x h PNG: a diagonal two-colour gradient, so it is plainly visible and not one flat colour. */
export function gradientPng(w: number, h: number): Buffer {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const r = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) { const k = (x / w + y / h) / 2; r.set([Math.round(255 * (1 - k)), 40, Math.round(255 * k), 255], 1 + x * 4); }
    rows.push(r);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
