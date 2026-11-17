// Starting the server and the app, and telling a stale server from a current one.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { api, BASE, cmd, health, PORT, REPO, spawnServer, status, ToolError, waitHealthy, wantVersion } from "./client.ts";

/** The app to open: CANVAS_APP, else a built one (the repo commits none): installed, `pnpm app`'s, `apps/macos/build.sh`'s. */
export const APP_PATH = () => process.env.CANVAS_APP ?? ["/Applications/Canvas.app", path.join(REPO, "build", "Canvas.app"), path.join(REPO, "apps/macos/Canvas.app")].find((p) => fs.existsSync(p)) ?? path.join(REPO, "build", "Canvas.app");
export const appInstalled = () => fs.existsSync(APP_PATH());

export type LaunchOpts = { file?: string; mode?: "auto" | "app" | "server"; foreground?: boolean; restartStale?: boolean; waitMs?: number };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function launchCanvas(o: LaunchOpts) {
  const want = wantVersion();
  const waitMs = o.waitMs ?? 10_000;
  const mode = o.mode ?? "auto";
  const mustApp = mode === "app";
  if (mustApp && !appInstalled()) throw new ToolError("no_app", `Canvas.app is not at ${APP_PATH()}`, "Build it with apps/macos/build.sh, or set CANVAS_APP.");
  const useApp = mode === "app" || (mode === "auto" && appInstalled() && process.env.CANVAS_MCP_NO_APP !== "1");

  let h = await health();
  let started = false;
  let replaced = false;
  const stale = Boolean(h && h.version !== want);
  if (h && stale && o.restartStale) {
    await fetch(`${BASE()}/quit`, { method: "POST", headers: { "x-canvas": "1" }, signal: AbortSignal.timeout(1500) }).catch(() => {});
    // The old server lands its pending writes before it exits (up to 5 s): wait for that, and never start a
    // second one beside it (it could not bind the port, and the old one would answer as if replaced).
    const end = Date.now() + 8000;
    while ((await health(300)) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    if (await health(300)) throw new ToolError("stale_busy", `The old Canvas server on port ${PORT()} did not stop within 8 s (it may still be saving)`, "Try launch_canvas again in a moment, or quit Canvas.");
    h = undefined;
    replaced = true;
  }
  if (!h) {
    if (process.env.CANVAS_MCP_NO_SPAWN === "1") throw new ToolError("no_server", "CANVAS_MCP_NO_SPAWN is set, so the server is not started");
    spawnServer(o.file);
    started = true;
    // A replacement counts only once the current version answers (not whatever holds the port).
    h = await waitHealthy(8000, replaced ? want : undefined);
    if (!h) throw new ToolError("no_server", replaced ? `The new Canvas server (version ${want}) did not answer on port ${PORT()}` : `The Canvas server did not start on port ${PORT()}`, "Run pnpm start in the canvas repo to see the error.");
  }

  let appLaunched = false;
  let shellConnected = false;
  if (useApp) {
    const s0 = await status();
    if (!s0.shell) {
      const args = ["-a", APP_PATH()];
      if (!o.foreground) args.unshift("-g");
      spawn("open", args, { detached: true, stdio: "ignore" }).unref();
      appLaunched = true;
      shellConnected = Boolean(await waitFor(async () => ((await status()).shell ? true : undefined), waitMs));
    } else {
      shellConnected = true;
      if (o.foreground) await cmd({ op: "activate" }).catch(() => {});
    }
    if (shellConnected && o.file) await cmd({ op: "open", args: { file: o.file, focus: o.foreground === true } });
  }

  const url = `${BASE()}/${o.file ? `?file=${encodeURIComponent(o.file)}` : ""}`;
  if (!useApp && o.foreground) spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  return {
    mode: useApp ? "app" : "server",
    server: { port: PORT(), url, started, replaced, version: h.version, stale: h.version !== want },
    app: useApp ? { path: APP_PATH(), launched: appLaunched, shellConnected } : null,
    file: o.file ?? null,
    note: useApp && !shellConnected ? `The app did not connect within ${waitMs} ms; call canvas_status to check again.` : stale && !o.restartStale ? "The running server is older than the code on disk; pass restartStale:true to replace it." : undefined,
  };
}
