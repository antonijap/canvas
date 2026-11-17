// The encrypted tunnel a hosted Cloud is reached through (docs/cloud/hosting.md). Canvas does not speak the tunnel
// itself: a small helper, `canvas-tunnel` (cloud/tunnel, built from the tailcat library: WireGuard, NAT traversal,
// and relays of last resort), runs as Canvas's child. Same Wi-Fi or not, every byte between two Macs goes through it.
//
// The helper takes one order as a JSON line on stdin and answers with JSON lines on stdout. Nothing secret is ever on
// its command line (other users on a Mac can read command lines): keys and tunnel addresses go over stdin only. Its
// stderr is dropped, never logged. It exits when its stdin closes, so it cannot outlive Canvas.
//
//   {"op":"genkey","kind":"server"|"client"}               -> {"event":"key","key":{...},"public":"nodekey:..","addr"?:"tc.."}
//   {"op":"serve","key":{...},"port":5190,"allow":[...]|null} -> {"event":"ready","addr":"tc.."}   (allow null: anyone)
//   {"op":"forward","key":{...},"addr":"tc..","port":5190}     -> {"event":"ready","port":<local port on 127.0.0.1>}
//   any failure                                                -> {"event":"error","message":".."} and exit
//
// The serve side is always port 5190, never anything else. A forward's local port is checked before any token goes
// to it: the listening socket must belong to the helper Canvas started (ownsPort), not to some other program.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOST_PORT } from "../cloud/node/host.ts";

/** The helper's path: CANVAS_TUNNEL_BIN (the app sets it to its bundled copy), else none and Anywhere is unavailable. */
export function helperPath(): string | null {
  const p = process.env.CANVAS_TUNNEL_BIN;
  if (!p) return null;
  try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { return null; }
}

/** A tunnel address: `tc` and base64url, nothing else. Never logged, never shown. */
export const isTunnelAddr = (s: unknown): s is string => typeof s === "string" && /^tc[A-Za-z0-9_-]{20,4000}$/.test(s);

export interface HelperEvent { event: string; [k: string]: unknown }

/** One running helper: its process, the first answer, and what happens when it ends. */
export class Helper {
  readonly child: ChildProcess;
  private buf = "";
  private readonly waiters: ((e: HelperEvent) => void)[] = [];
  private exited = false;
  onExit: (code: number | null) => void = () => {};

  constructor(bin: string, order: Record<string, unknown>) {
    // stdin stays open for the helper's life: its end is the helper's signal to quit.
    // A small environment: nothing of Canvas's own leaks into the helper (the fake one in tests reads its CANVAS_FAKE_TUNNEL_*).
    const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/" };
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith("CANVAS_FAKE_TUNNEL_") && v) env[k] = v;
    this.child = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"], env });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => {
      this.buf += d;
      if (this.buf.length > 64 * 1024) { this.stop(); return; }
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let e: HelperEvent;
        try { e = JSON.parse(line); } catch { continue; }
        if (e && typeof e.event === "string") for (const w of this.waiters.splice(0)) w(e);
      }
    });
    this.child.stdin!.on("error", () => {});
    this.child.on("error", () => this.end(null));
    this.child.on("exit", (code) => this.end(code));
    this.child.stdin!.write(JSON.stringify(order) + "\n");
  }

  private end(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    for (const w of this.waiters.splice(0)) w({ event: "error", message: "The tunnel helper stopped" });
    this.onExit(code);
  }

  get alive(): boolean { return !this.exited; }

  /** The next event, or an error event after `ms`. */
  next(ms = 30_000): Promise<HelperEvent> {
    if (this.exited) return Promise.resolve({ event: "error", message: "The tunnel helper stopped" });
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ event: "error", message: "The tunnel helper did not answer in time" }), ms);
      t.unref?.();
      this.waiters.push((e) => { clearTimeout(t); resolve(e); });
    });
  }

  /** Ends the helper: its stdin closes (it quits), and a kill follows if it lingers. */
  stop(): void {
    if (this.exited) return;
    try { this.child.stdin!.end(); } catch { /* closed */ }
    const pid = this.child.pid;
    setTimeout(() => { if (!this.exited && pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }, 1500).unref?.();
    try { this.child.kill("SIGTERM"); } catch { /* gone */ }
  }
}

const live = new Set<Helper>();
process.once("exit", () => { for (const h of live) { try { h.child.kill("SIGKILL"); } catch { /* gone */ } } });

function run(bin: string, order: Record<string, unknown>): Helper {
  const h = new Helper(bin, order);
  live.add(h);
  const prev = h.onExit;
  h.onExit = (c) => { live.delete(h); prev(c); };
  return h;
}

/** Every helper Canvas is running now (QA checks there are none left after a stop). */
export const runningHelpers = (): number[] => [...live].filter((h) => h.alive).map((h) => h.child.pid!).filter(Boolean);

/** A new key: the private part (kept in the Keychain), its public key, and for a server its tunnel address. */
export async function genkey(bin: string, kind: "server" | "client"): Promise<{ key: unknown; public: string; addr?: string }> {
  const h = run(bin, { op: "genkey", kind });
  const e = await h.next();
  h.stop();
  if (e.event !== "key" || !e.key || typeof e.public !== "string") throw new Error(String(e.message ?? "Could not make a tunnel key"));
  return { key: e.key, public: e.public, ...(isTunnelAddr(e.addr) ? { addr: e.addr } : {}) };
}

/** Serves 127.0.0.1:5190 through the tunnel. `allow`: the device keys let in, or null for anyone (enrolment only). */
export async function serve(bin: string, key: unknown, allow: string[] | null, port = HOST_PORT): Promise<{ helper: Helper; addr: string }> {
  const h = run(bin, { op: "serve", key, port, allow });
  const e = await h.next();
  if (e.event !== "ready" || !isTunnelAddr(e.addr)) { h.stop(); throw new Error(String(e.message ?? "The tunnel did not start")); }
  return { helper: h, addr: e.addr };
}

/** Forwards a local port on 127.0.0.1 to a Cloud's tunnel address. Checked: the port is the helper's own. */
export async function forward(bin: string, key: unknown, addr: string, port = HOST_PORT): Promise<{ helper: Helper; origin: string }> {
  if (!isTunnelAddr(addr)) throw new Error("That is not a tunnel address");
  const h = run(bin, { op: "forward", key, addr, port });
  const e = await h.next();
  const local = Number(e.port);
  if (e.event !== "ready" || !Number.isInteger(local) || local < 1024 || local > 65535) { h.stop(); throw new Error(String(e.message ?? "The tunnel did not start")); }
  if (!(await ownsPort(h.child.pid!, local))) { h.stop(); throw new Error("Another program answered on the tunnel's port"); }
  return { helper: h, origin: `http://127.0.0.1:${local}` };
}

/** Whether `pid` is the process listening on 127.0.0.1:`port` (lsof; false when it cannot tell). */
export function ownsPort(pid: number, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 4000 }, (err, out) => {
      resolve(!err && String(out).trim().split(/\s+/).includes(String(pid)));
    });
  });
}

/** A short fingerprint of a tunnel address, for a person to compare by eye: "3F9A-C21B". */
export async function fingerprint(addr: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update(addr).digest("hex").slice(0, 8).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

/** The fake helper tests and QA use (test/fixtures/fake-tunnel.ts): same orders, a local TCP relay in place of WireGuard. */
export const FAKE_HELPER = path.join(import.meta.dirname, "..", "test", "fixtures", "fake-tunnel.sh");

/** Stops every helper (Canvas quitting, or a test ending). */
export function stopHelpers(): void { for (const h of [...live]) h.stop(); }
