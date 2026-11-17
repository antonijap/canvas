// The self-update end to end, on this Mac (docs/developer-guide.md "Updates"): `node scripts/update-e2e.ts`.
//
// Builds two release apps from this checkout with scripts/release-app.sh (CANVAS_NOTARY_PROFILE=none, signed with the
// keychain's Developer ID), 0.1.1 and 0.1.2, under a test bundle id with no document types and no canvas:// scheme, so
// neither is ever mistaken for the real app. The version edits to apps/macos/Info.plist and package.json are put back
// when the script ends, however it ends. A local server plays getcanvas.cc (the manifest and /download/<file>); the
// 0.1.1 app, installed in a scratch folder with a space in its name (never /Applications), reads it through
// CANVAS_UPDATE_MANIFEST, which the app honours only for http://127.0.0.1. It runs on its own port, state, logs and
// documents, never the person's Canvas on 5189.
//
// Refused first, each with its reason: a zip with one byte changed (SHA-256), an app with one byte changed inside and
// a manifest that matches the zip (signature), the app re-signed ad-hoc (team), a manifest that names another version.
// Then the real 0.1.2: downloaded, verified, an edit made to the open document, Restart to Update, and the app comes
// back as 0.1.2 at the same path with the document and the edit intact. Gatekeeper rejects builds that are not
// notarized, so under this override (and only there) the app skips that one check and logs it.
//
// Everything it made is deleted at the end: the builds, the scratch folder, the test bundle id's preferences, caches
// and WebKit data. UPDATE_E2E_KEEP=1 keeps the scratch folder for a look.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID = "cc.getcanvas.canvas.updatetest";
const WORK = path.join(ROOT, "qa/out/update-e2e");
const APPS = path.join(WORK, "Test Apps");
const APP = path.join(APPS, "Canvas.app");
const DOCS = path.join(WORK, "docs");
const DOC = path.join(DOCS, "Update Test.canvas");
const LOGS = path.join(WORK, "logs");
const LIB = os.homedir() + "/Library";
const PLIST = path.join(ROOT, "apps/macos/Info.plist");
const PKG = path.join(ROOT, "package.json");
const plistBefore = fs.readFileSync(PLIST);
const pkgBefore = fs.readFileSync(PKG);

let failures = 0;
const say = (s: string) => console.log(s);
function check(ok: boolean, what: string) {
  say(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).toString();

function restoreSources() {
  fs.writeFileSync(PLIST, plistBefore);
  fs.writeFileSync(PKG, pkgBefore);
}
process.on("SIGINT", () => { restoreSources(); process.exit(130); });

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A release build of `version` under the test bundle id, moved to WORK/builds/<version>. */
function build(version: string): { app: string; zip: string } {
  const kept = path.join(WORK, "builds", version);
  // UPDATE_E2E_REUSE=1 with builds kept from a run with UPDATE_E2E_KEEP=1: no rebuild.
  if (process.env.UPDATE_E2E_REUSE === "1" && fs.existsSync(path.join(kept, "Canvas.app"))) {
    say(`reusing the ${version} build`);
    return { app: path.join(kept, "Canvas.app"), zip: path.join(kept, `Canvas-${version}.zip`) };
  }
  say(`building ${version} (release-app.sh, Developer ID, not notarized)`);
  restoreSources();
  const pb = (c: string) => spawnSync("/usr/libexec/PlistBuddy", ["-c", c, PLIST], { stdio: "ignore" });
  pb(`Set :CFBundleShortVersionString ${version}`);
  pb(`Set :CFBundleIdentifier ${ID}`);
  for (const k of ["CFBundleDocumentTypes", "CFBundleURLTypes", "UTExportedTypeDeclarations", "UTImportedTypeDeclarations"]) pb(`Delete :${k}`);
  fs.writeFileSync(PKG, pkgBefore.toString().replace(/"version": "[^"]+"/, `"version": "${version}"`));
  try {
    run(path.join(ROOT, "scripts/release-app.sh"), [], { env: { ...process.env, CANVAS_NOTARY_PROFILE: "none" } });
  } finally {
    restoreSources();
  }
  const out = path.join(WORK, "builds", version);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run("/usr/bin/ditto", [path.join(ROOT, "qa/out/release", version), out]);
  fs.rmSync(path.join(ROOT, "qa/out/release", version), { recursive: true, force: true });
  return { app: path.join(out, "Canvas.app"), zip: path.join(out, `Canvas-${version}.zip`) };
}

/** A copy of the 0.1.2 app changed by `change`, zipped the way the release is. */
function variant(goodZip: string, name: string, change: (app: string) => void): string {
  const dir = path.join(WORK, "variants", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  run("/usr/bin/ditto", ["-x", "-k", goodZip, dir]);
  change(path.join(dir, "Canvas.app"));
  const zip = path.join(WORK, "variants", `${name}.zip`);
  run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path.join(dir, "Canvas.app"), zip]);
  return zip;
}

// ---- the stand-in website ----
const site = { manifest: "{}", files: new Map<string, string>() };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/releases.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(site.manifest); return; }
  const m = url.pathname.match(/^\/download\/([^/]+)$/);
  const file = m && site.files.get(decodeURIComponent(m[1]));
  if (file) { res.writeHead(200, { "content-type": "application/zip", "content-length": fs.statSync(file).size }); fs.createReadStream(file).pipe(res); return; }
  if (url.pathname === "/api/usage") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
function publish(version: string, name: string, zip: string, over: Record<string, unknown> = {}) {
  site.files.set(name, zip);
  site.manifest = JSON.stringify({ latest: { version, file: name, size: fs.statSync(zip).size, sha256: sha256(zip), date: "2026-11-17", minimumSystemVersion: "26.0", arch: ["arm64"], notes: [], ...over } });
}

// ---- talking to the test app through its server's bridge ----
let appPort = 0;
async function cmd(op: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${appPort}/api/bridge/cmd`, {
    method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ op, args, timeoutMs }),
  });
  const j = await r.json() as any;
  if (!j.ok) throw new Error(`${op}: ${JSON.stringify(j.error ?? j)}`);
  return j.result;
}
async function until<T>(what: string, f: () => Promise<T | undefined | null | false>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  for (;;) {
    try { const v = await f(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
    await sleep(300);
  }
}
const pidsOf = () => {
  const r = spawnSync("/usr/bin/pgrep", ["-f", `${APP}/Contents/MacOS/Canvas`]);
  return r.stdout.toString().split("\n").filter(Boolean).map(Number);
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function cleanUp() {
  // The test app, its server (node from inside the app) and a helper still waiting: everything running from WORK.
  const ours = () => spawnSync("/usr/bin/pgrep", ["-f", WORK]).stdout.toString().split("\n").filter(Boolean).map(Number).filter((p) => p !== process.pid);
  for (const pid of ours()) { try { process.kill(pid); } catch {} }
  for (let i = 0; i < 50 && ours().length; i++) await sleep(200);
  for (const pid of ours()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  for (const a of [APP, path.join(WORK, "builds/0.1.1/Canvas.app"), path.join(WORK, "builds/0.1.2/Canvas.app")]) spawnSync(lsregister, ["-u", a], { stdio: "ignore" });
  spawnSync("/usr/bin/defaults", ["delete", ID], { stdio: "ignore" });
  for (const p of [`${LIB}/Caches/${ID}`, `${LIB}/WebKit/${ID}`, `${LIB}/HTTPStorages/${ID}`, `${LIB}/HTTPStorages/${ID}.binarycookies`,
    `${LIB}/Saved Application State/${ID}.savedState`, `${LIB}/Preferences/${ID}.plist`]) fs.rmSync(p, { recursive: true, force: true });
  if (process.env.UPDATE_E2E_KEEP !== "1") fs.rmSync(WORK, { recursive: true, force: true });
  try { fs.rmdirSync(path.join(ROOT, "qa/out/release")); } catch {} // only when the builds left it empty
  restoreSources();
}

async function main() {
  const builds = path.join(WORK, "builds");
  if (process.env.UPDATE_E2E_REUSE === "1" && fs.existsSync(builds)) {
    const keep = path.join(ROOT, "qa/out/update-e2e-builds");
    fs.rmSync(keep, { recursive: true, force: true });
    fs.renameSync(builds, keep);
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.renameSync(keep, builds);
  } else fs.rmSync(WORK, { recursive: true, force: true });
  for (const d of [APPS, DOCS, LOGS, path.join(WORK, "state"), path.join(WORK, "welcome")]) fs.mkdirSync(d, { recursive: true });

  const old = build("0.1.1");
  const neu = build("0.1.2");
  const team = (app: string) => run("/usr/bin/codesign", ["-dvv", app]).match(/TeamIdentifier=(\S+)/)?.[1]
    ?? spawnSync("/usr/bin/codesign", ["-dvv", app]).stderr.toString().match(/TeamIdentifier=(\S+)/)?.[1];
  say(`built 0.1.1 and 0.1.2, team ${team(neu.app)}`);

  // Refused variants of 0.1.2.
  const byte = path.join(WORK, "variants", "byte.zip");
  fs.mkdirSync(path.dirname(byte), { recursive: true });
  fs.copyFileSync(neu.zip, byte);
  const buf = fs.readFileSync(byte);
  buf[buf.length >> 1] ^= 0xff;
  fs.writeFileSync(byte, buf);
  const inside = variant(neu.zip, "inside", (app) => fs.appendFileSync(path.join(app, "Contents/Resources/server/package.json"), " "));
  const adhoc = variant(neu.zip, "adhoc", (app) => run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]));

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const sitePort = (server.address() as net.AddressInfo).port;
  appPort = await freePort();

  // The 0.1.1 app in the scratch folder, its own port and folders, the document open.
  run("/usr/bin/ditto", [old.app, APP]);
  // A .canvas package: a folder with the design and its widgets.
  fs.mkdirSync(DOC, { recursive: true });
  fs.writeFileSync(path.join(DOC, "document.json"), JSON.stringify({ version: "2.21", children: [
    { type: "frame", id: "Scr01", name: "Screen", x: 0, y: 0, width: 390, height: 844, children: [] },
  ] }, null, 2));
  fs.writeFileSync(path.join(DOC, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }));
  for (const [k, t, v] of [["canvas.welcomed", "-bool", "true"], ["canvas.settings.shareUsage", "-bool", "true"]]) run("/usr/bin/defaults", ["write", ID, k, t, v]);
  const env: Record<string, string> = {
    CANVAS_PORT: String(appPort), CANVAS_ROOTS: DOCS, CANVAS_LOG_DIR: LOGS, CANVAS_STATE_DIR: path.join(WORK, "state"),
    CANVAS_WELCOME_DIR: path.join(WORK, "welcome"), CANVAS_TRUST_FILE: path.join(WORK, "trust.json"),
    CANVAS_VIDEO_PROXIES: path.join(WORK, "video-proxies"), CANVAS_AGENT_LOG: path.join(LOGS, "agent-runs.log"),
    CANVAS_WEB_FONTS: "0", CANVAS_MCP_NO_SPAWN: "1",
    CANVAS_UPDATE_MANIFEST: `http://127.0.0.1:${sitePort}/releases.json`, CANVAS_USAGE_URL: `http://127.0.0.1:${sitePort}/api/usage`,
  };
  site.manifest = JSON.stringify({ latest: null });
  run("/usr/bin/open", ["-g", "-n", "-a", APP, ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    "--args", "-ApplePersistenceIgnoreState", "YES"]);
  await until("the 0.1.1 app", () => cmd("ping", {}, 2000), 60_000);
  const st0 = await cmd("update.state");
  check(st0.version === "0.1.1" && st0.localTest === true && st0.ready === null, `0.1.1 is running with the local test manifest (${JSON.stringify(st0)})`);
  await cmd("open", { file: DOC });
  await until("the document's tab", async () => (await cmd("tabs")).current === fs.realpathSync(DOC));

  async function attempt(label: string, expect: RegExp) {
    await cmd("update.check");
    const st = await until(`${label} to finish`, async () => { const s = await cmd("update.state"); return !s.busy && s.toast && expect.test(s.toast) ? s : null; }, 120_000)
      .catch(async (e) => {
    say(`  state: ${JSON.stringify(await cmd("update.state").catch(() => null))}`);
    throw e;
  });
    check(st.ready === null, `${label}: refused, toast "${st.toast}"`);
    const left = fs.existsSync(`${LIB}/Caches/${ID}/Updates`) ? fs.readdirSync(`${LIB}/Caches/${ID}/Updates`) : [];
    check(left.length === 0, `${label}: the download is deleted (${JSON.stringify(left)})`);
  }
  // Nothing newer: up to date.
  publish("0.1.1", "Canvas-0.1.1.zip", old.zip);
  await cmd("update.check");
  const same = await until("up to date", async () => { const s = await cmd("update.state"); return !s.busy && s.toast === "Canvas is up to date" ? s : null; });
  check(same.ready === null, `same version: "${same.toast}"`);

  publish("0.1.2", "Canvas-0.1.2-byte.zip", byte, { size: fs.statSync(neu.zip).size, sha256: sha256(neu.zip) });
  await attempt("one byte changed in the zip", /SHA-256/);
  publish("0.1.2", "Canvas-0.1.2-inside.zip", inside);
  await attempt("one byte changed inside the app, manifest matching", /signature does not verify/);
  publish("0.1.2", "Canvas-0.1.2-adhoc.zip", adhoc);
  await attempt("re-signed ad-hoc, manifest matching", /different developer/);
  publish("0.1.3", "Canvas-0.1.3-real.zip", neu.zip);
  await attempt("a manifest that names another version", /version 0\.1\.2, not 0\.1\.3/);

  // The real one.
  const goodName = `Canvas-0.1.2-${sha256(neu.zip).slice(0, 8)}.zip`;
  publish("0.1.2", goodName, neu.zip);
  await cmd("update.check");
  const ready = await until("0.1.2 ready", async () => { const s = await cmd("update.state"); return s.ready === "0.1.2" ? s : null; }, 180_000);
  check(ready.toast === "Canvas 0.1.2 is ready" && JSON.stringify(ready.actions) === '["Restart to Update"]', `ready: toast "${ready.toast}" with ${JSON.stringify(ready.actions)}`);
  check(fs.existsSync(`${LIB}/Caches/${ID}/Updates/0.1.2/app/Canvas.app`), "the verified app waits in the caches folder");
  const log1 = fs.readFileSync(path.join(LOGS, "update.log"), "utf8");
  check(/Gatekeeper check failed \(spctl \w+, notarized no\).* skipped/.test(log1), "the Gatekeeper step ran, found the build not notarized, and only the local test skipped it");

  // An edit the quit must save, then Restart to Update.
  const edit = await fetch(`http://127.0.0.1:${appPort}/api/update`, {
    method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" },
    body: JSON.stringify({ file: fs.realpathSync(DOC), id: "Scr01", props: { name: "Edited before the update" } }),
  });
  check(edit.ok, `an edit to the open document (${edit.status})`);
  const [oldPid] = pidsOf();
  // Restart to Update is clicked in the frontmost app: a page in a window that never came forward may not answer the
  // quit's save in time, and then the app rightly stays open.
  await cmd("activate");
  await cmd("update.restart");
  await until("0.1.1 to quit", async () => !alive(oldPid), 60_000).catch(async (e) => {
    say(`  state: ${JSON.stringify(await cmd("update.state").catch(() => null))}`);
    spawnSync("/usr/bin/sample", [String(oldPid), "1", "-file", path.join(LOGS, "sample.txt")], { stdio: "ignore" });
    throw e;
  });
  say(`0.1.1 (pid ${oldPid}) quit`);
  const newPid = await until("the relaunched app", async () => pidsOf().find((p) => p !== oldPid), 60_000);
  await until("the relaunched app's bridge", () => cmd("ping", {}, 2000), 90_000);
  const st1 = await until("0.1.2's state", async () => { const s = await cmd("update.state"); return s.version === "0.1.2" && s.toast ? s : null; }, 30_000);
  check(st1.version === "0.1.2", `relaunched as 0.1.2 (pid ${newPid}), toast "${st1.toast}"`);
  check(st1.toast === "Canvas is updated to 0.1.2", "it says it updated");
  const onDisk = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(APP, "Contents/Info.plist")]).trim();
  check(onDisk === "0.1.2", `the app at ${APP} is 0.1.2 on disk`);
  check(spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", APP]).status === 0 && team(APP) === team(old.app), "its signature verifies, same team");
  check(JSON.stringify(fs.readdirSync(APPS)) === '["Canvas.app"]', `nothing left beside it (${JSON.stringify(fs.readdirSync(APPS))})`);
  check(!fs.existsSync(`${LIB}/Caches/${ID}/Updates`), "the download is gone from the caches folder");
  check(spawnSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", APP]).status !== 0, "no quarantine flag");
  const tabs = await until("the document reopened", async () => { const t = await cmd("tabs"); return t.current === fs.realpathSync(DOC) ? t : null; }, 30_000);
  check(tabs.current === fs.realpathSync(DOC), "the document is open again");
  const doc = JSON.parse(fs.readFileSync(path.join(DOC, "document.json"), "utf8"));
  check(doc.children?.[0]?.name === "Edited before the update", "the document is intact, with the edit made before the restart");
  const log2 = fs.readFileSync(path.join(LOGS, "update.log"), "utf8");
  say("update.log:\n" + log2.trim().split("\n").map((l) => "  " + l).join("\n"));
  check(/installed /.test(log2), "the helper logged the install");
  await sleep(3000);
  const usage = fs.readFileSync(path.join(WORK, "state", "usage.json"), "utf8");
  check(["update.ready", "update.installed", "update.failed"].every((n) => usage.includes(`"${n}"`)), "usage counts: update.ready, update.installed, update.failed");
}

let code = 0;
try {
  await main();
} catch (e) {
  say(`FAIL ${(e as Error).message}`);
  failures++;
} finally {
  if (failures) {
    for (const f of ["update.log", "server.log"]) {
      try { say(`${f}:\n` + fs.readFileSync(path.join(LOGS, f), "utf8").trim().split("\n").slice(-40).map((l) => "  " + l).join("\n")); } catch {}
    }
    say(`running: ${spawnSync("/usr/bin/pgrep", ["-fl", WORK]).stdout.toString().trim()}`);
  }
  server.close();
  await cleanUp();
  say(failures ? `update-e2e: ${failures} failed` : "update-e2e: all passed");
  code = failures ? 1 : 0;
}
process.exit(code);
