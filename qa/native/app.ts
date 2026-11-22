// A QA instance of the Canvas app for pnpm qa:native, next to (and never touching) the Canvas the maintainer runs:
//
// - its own build (QA=1 apps/macos/build.sh, written to a temp folder, never apps/macos/Canvas.app), copied per
//   shard under its own bundle id, so preferences, WebKit storage and window state are its own;
// - its own server on a free port, with HOME, documents, logs, trust file and video cache in a temp folder;
// - started directly (not through LaunchServices), so it gets no Dock activation and its pid is ours to stop.
//   The QA build never activates itself: input goes in through the bridge, not the system.
//
// Everything lives under one temp folder that stop() removes, along with the bundle id's preferences and caches.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, freePort, sleep } from "../lib.ts";

export const BUNDLE_BASE = "cc.getcanvas.canvas.qa";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** Builds the QA app into `dir` (once per run). */
export function buildQaApp(dir: string): string {
  const app = path.join(dir, "Canvas QA.app");
  execFileSync("bash", [path.join(ROOT, "scripts/ensure-engine.sh")], { stdio: ["ignore", "ignore", "pipe"] });
  execFileSync("bash", [path.join(ROOT, "apps/macos/build.sh")], { env: { ...process.env, QA: "1", CANVAS_APP_OUT: app }, stdio: ["ignore", "ignore", "pipe"] });
  if (!fs.existsSync(path.join(app, "Contents/MacOS/Canvas"))) throw new Error("the QA build produced no app");
  return app;
}

type Cmd = { op: string; args?: Record<string, unknown>; timeoutMs?: number };

export class QaApp {
  readonly shard: number;
  readonly dir: string;
  readonly home: string;
  readonly docs: string;
  readonly logs: string;
  readonly bundleId: string;
  port = 0;
  base = "";
  app = "";
  server?: ChildProcess;
  /** The app's pid (from qa.ping): it is LaunchServices' child, not ours. */
  pid = 0;
  serverLog: string[] = [];

  constructor(root: string, shard: number) {
    this.shard = shard;
    this.dir = path.join(root, `s${shard}`);
    this.home = path.join(this.dir, "home");
    this.docs = path.join(this.dir, "docs");
    this.logs = path.join(this.dir, "logs");
    // Unique per run as well as per shard: two qa:native runs at once (agents in parallel) would otherwise share
    // s1's preferences and caches, and each run's clean-up would delete the other's WebKit storage under it.
    this.bundleId = `${BUNDLE_BASE}.r${process.pid}s${shard}`;
  }

  /** Env both the server and the app get: everything they could write points into this instance's folder. */
  private env(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      CANVAS_PORT: String(this.port),
      CANVAS_ROOTS: this.docs,
      CANVAS_QA: "1",
      CANVAS_STATE_DIR: path.join(this.dir, "state"),
      CANVAS_LOG_DIR: this.logs,
      CANVAS_WIDGETS_DIR: path.join(this.dir, "local-widgets"),
      CANVAS_TRUST_FILE: path.join(this.dir, "widget-trust.json"),
      CANVAS_VIDEO_PROXIES: path.join(this.dir, "video-proxies"),
      CANVAS_AGENT_LOG: path.join(this.logs, "agent-runs.log"),
      CANVAS_WEB_FONTS: "0",
      CANVAS_MCP_NO_SPAWN: "1",
      // The agents' config lives in this instance's scratch HOME: Connect may register a worktree's server here.
      CANVAS_CONNECT_TEMPORARY: "1",
      CANVAS_SERVER: path.join(ROOT, "src/server.ts"),
      CANVAS_NODE: process.execPath,
      // Host a Cloud: the fake tunnel helper (test/fixtures/fake-tunnel.ts), the Cloud on a free port (never the
      // Mac's own 5190), secrets in this instance's folder instead of the Keychain.
      CANVAS_TUNNEL_BIN: path.join(ROOT, "test", "fixtures", "fake-tunnel.sh"),
      CANVAS_FAKE_TUNNEL_DIR: path.join(this.dir, "tunnels"),
      CANVAS_FAKE_TUNNEL_NODE: process.execPath,
      CANVAS_FAKE_TUNNEL_ANY_PORT: "1",
      CANVAS_CLOUD_HOST_PORT: "0",
      CANVAS_CLOUD_SECRETS_FILE: path.join(this.dir, "cloud-secrets.json"),
      ...(process.env.CANVAS_ENGINE_PKG ? { CANVAS_ENGINE_PKG: process.env.CANVAS_ENGINE_PKG } : {}),
      // Debug switches for the QA build (CANVAS_QA_TRACE=1 logs the drag machinery).
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CANVAS_QA_"))),
    };
  }

  async start(builtApp: string, onLaunch?: () => void) {
    for (const d of [this.home, this.docs, this.logs, path.join(this.dir, "tunnels")]) fs.mkdirSync(d, { recursive: true });
    // Fonts the maintainer installed are read (never written) so text measures as it does in her app.
    const fonts = path.join(os.homedir(), "Library", "Fonts");
    fs.mkdirSync(path.join(this.home, "Library"), { recursive: true });
    if (fs.existsSync(fonts)) fs.symlinkSync(fonts, path.join(this.home, "Library", "Fonts"));
    this.port = await freePort();
    this.base = `http://127.0.0.1:${this.port}`;
    this.clearDomain();

    // The app bundle: a copy with this shard's bundle id, no document types (so Finder never picks it for .canvas)
    // and no canvas:// scheme (so a link the person clicks never opens here; qa.openurl delivers them in-process).
    this.app = path.join(this.dir, `Canvas QA ${this.shard}.app`);
    fs.cpSync(builtApp, this.app, { recursive: true, verbatimSymlinks: true });
    const plist = path.join(this.app, "Contents/Info.plist");
    const pb = (c: string) => { try { execFileSync("/usr/libexec/PlistBuddy", ["-c", c, plist], { stdio: "ignore" }); } catch {} };
    pb(`Set :CFBundleIdentifier ${this.bundleId}`);
    pb(`Set :CFBundleName Canvas QA ${this.shard}`);
    pb(`Set :CFBundleDisplayName Canvas QA ${this.shard}`);
    pb("Delete :CFBundleDocumentTypes");
    pb("Delete :CFBundleURLTypes");
    pb("Delete :UTExportedTypeDeclarations");
    pb("Delete :UTImportedTypeDeclarations");
    pb("Add :LSUIElement bool true"); // no Dock icon
    execFileSync("codesign", ["--force", "--sign", "-", this.app], { stdio: "ignore" });

    await this.startServer();
    await this.launch(onLaunch);
  }

  private async startServer() {
    const previewHelper = path.join(this.app, "Contents/Resources/canvas-image-previews");
    this.server = spawn(process.execPath, [path.join(ROOT, "src/server.ts")], { cwd: ROOT, env: {
      ...this.env(), HOME: this.home,
      ...(fs.existsSync(previewHelper) ? { CANVAS_IMAGE_PREVIEWS_BIN: previewHelper } : {}),
    }, stdio: ["ignore", "pipe", "pipe"] });
    this.server.stdout!.on("data", (d) => this.serverLog.push(String(d)));
    this.server.stderr!.on("data", (d) => this.serverLog.push(String(d)));
    await this.waitHealth();
  }

  async relaunch({ restartServer = false, env = {}, onLaunch }: {
    restartServer?: boolean; env?: Record<string, string>; onLaunch?: () => void;
  } = {}) {
    const pid = this.pid;
    await this.cmd({ op: "qa.quit" });
    for (let i = 0; i < 80; i++) {
      try { process.kill(pid, 0); } catch {
        if (restartServer) {
          await this.stopServer();
          await this.startServer();
        }
        await this.launch(onLaunch, env);
        return;
      }
      await sleep(100);
    }
    throw new Error("QA app did not quit before relaunch");
  }

  private async launch(onLaunch?: () => void, extraEnv: Record<string, string> = {}) {
    // `open -g -n`: a new instance, launched in the background. Started any other way (a child of a frontmost
    // terminal or app), macOS brings it to the front and it takes the keyboard from whoever is typing.
    // -ApplePersistenceIgnoreState: no "reopen windows?" alert after the last run's kill (it blocks all input).
    const env = Object.entries({ ...this.env(), ...extraEnv }).filter(([, v]) => v !== undefined).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    onLaunch?.();
    execFileSync("open", ["-g", "-n", "-a", this.app, "--stdout", this.appLogFile, "--stderr", this.appLogFile, ...env,
      "--args", "-ApplePersistenceIgnoreState", "YES", "-NSQuitAlwaysKeepsWindows", "NO"], { stdio: "ignore" });
    const t0 = Date.now();
    for (;;) {
      try {
        const { pid } = await this.cmd<{ pid: number }>({ op: "qa.ping", timeoutMs: 2000 });
        if (pid !== this.pid) { this.pid = pid; break; }
      } catch {}
      if (Date.now() - t0 > 40_000) throw new Error(`QA app did not connect in 40 s: ${this.log().slice(-2000)}`);
      await sleep(onLaunch ? 25 : 250);
    }
  }

  get appLogFile() { return path.join(this.logs, "app.log"); }
  /** The app's own output (its stderr and stdout), without the system's input-method chatter. */
  log(): string {
    try { return fs.readFileSync(this.appLogFile, "utf8").split("\n").filter((l) => !/IMKClient|IMKInputSession|TSM|NSTextInputContext|ViewBridge/.test(l)).join("\n"); } catch { return ""; }
  }

  private async waitHealth() {
    const t0 = Date.now();
    for (;;) {
      try { if ((await fetch(`${this.base}/health`)).ok) return; } catch {}
      if (this.server!.exitCode !== null) throw new Error(`QA server exited: ${this.serverLog.join("")}`);
      if (Date.now() - t0 > 30_000) throw new Error(`QA server did not answer in 30 s: ${this.serverLog.join("")}`);
      await sleep(50);
    }
  }

  /** One bridge op on this instance's shell. */
  /** Show the scenario's tab. QA suppresses application activation, while quiet open only adds a background tab. */
  openShown(file: string) {
    return this.cmd({ op: "open", args: { file, focus: true }, timeoutMs: 15_000 });
  }

  async cmd<R = any>(c: Cmd): Promise<R> {
    const timeoutMs = c.timeoutMs ?? 20_000;
    const r = await fetch(`${this.base}/api/bridge/cmd`, {
      method: "POST",
      headers: { "x-canvas": "1", "content-type": "application/json" },
      body: JSON.stringify({ op: c.op, args: c.args ?? {}, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5000),
    });
    const j = (await r.json().catch(() => ({}))) as { result?: R; error?: string; code?: string };
    if (!r.ok) throw new Error(`${c.op}: ${r.status} ${JSON.stringify(j.error ?? j)}`);
    return j.result as R;
  }

  /** Preferences and caches the bundle id leaves behind; only ever this QA bundle id's. */
  private clearDomain() {
    if (!this.bundleId.startsWith(`${BUNDLE_BASE}.`)) throw new Error(`refusing to clear ${this.bundleId}`);
    try { execFileSync("defaults", ["delete", this.bundleId], { stdio: "ignore" }); } catch {}
    const lib = path.join(os.homedir(), "Library");
    for (const p of [
      path.join(lib, "WebKit", this.bundleId), path.join(lib, "Caches", this.bundleId), path.join(lib, "HTTPStorages", this.bundleId),
      path.join(lib, "HTTPStorages", `${this.bundleId}.binarycookies`), path.join(lib, "Saved Application State", `${this.bundleId}.savedState`),
      path.join(lib, "Preferences", `${this.bundleId}.plist`),
    ]) {
      // The app may still be writing its caches as it goes: a folder that refills while it is removed is tried again.
      for (let i = 0; i < 3; i++) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); break; } catch {} }
    }
  }

  private async stopServer() {
    const server = this.server;
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise<void>(resolve => server.once("exit", () => resolve()));
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 6000);
    try { await exited; } finally { clearTimeout(timeout); }
  }

  async stop() {
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    if (this.pid && alive(this.pid)) {
      // Only ever this instance's own pid, checked against its bundle path first.
      let cmd = "";
      try { cmd = execFileSync("ps", ["-o", "command=", "-p", String(this.pid)], { encoding: "utf8" }); } catch {}
      if (cmd.includes(this.app)) {
        process.kill(this.pid, "SIGKILL");
        for (let i = 0; i < 30 && alive(this.pid); i++) await sleep(100);
      }
    }
    await this.stopServer();
    try { if (this.app) execFileSync(LSREGISTER, ["-u", this.app], { stdio: "ignore" }); } catch {}
    this.clearDomain();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
