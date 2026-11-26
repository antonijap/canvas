import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dirname, "..", "scripts", "install-app.sh");
const plist = (exe: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${exe}</string>
<key>CFBundleIdentifier</key><string>test.install-app</string></dict></plist>`;

// A bundle layout without the .app name, so LaunchServices and Gatekeeper never take it for an app (a copied
// /bin/sleep in a Fake.app made macOS show a "damaged" dialog). The binary is ad-hoc signed, with no extended
// attributes, and only ever spawned directly: nothing here calls `open`, and --verify never opens anything.
function fakeApp(dir: string): string {
  const app = path.join(dir, "Fake.bundle");
  const bin = path.join(app, "Contents", "MacOS", "Fake");
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(path.join(app, "Contents", "Info.plist"), plist("Fake"));
  cpSync("/bin/sleep", bin);
  spawnSync("xattr", ["-cr", app]);
  spawnSync("codesign", ["--force", "--sign", "-", bin]);
  return app;
}
const verify = (pid: number, app: string) => spawnSync("bash", [script, "--verify", String(pid), app], { encoding: "utf8" });

// The installed app said the new commit while the process on screen still ran the old binary from the Trash.
test("verify tells a process on the installed binary from one left on a replaced bundle", { skip: process.platform !== "darwin" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "install-app-"));
  const app = fakeApp(dir);
  const old = spawn(path.join(app, "Contents", "MacOS", "Fake"), ["30"]);
  try {
    spawnSync("sleep", ["0.3"]);
    assert.equal(verify(old.pid!, app).status, 0, "the process runs the installed binary");
    // The install: the old bundle moves aside, the new one takes its place, the old process keeps running.
    renameSync(app, path.join(dir, "Old.bundle"));
    fakeApp(dir);
    const stale = verify(old.pid!, app);
    assert.notEqual(stale.status, 0, "a process left on the old binary is not the installed build");
    assert.match(stale.stderr, /stale/);
    const fresh = spawn(path.join(app, "Contents", "MacOS", "Fake"), ["30"]);
    try {
      spawnSync("sleep", ["0.3"]);
      assert.equal(verify(fresh.pid!, app).status, 0, "a process started after the swap is");
    } finally { fresh.kill(); }
  } finally {
    old.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A bundled server outlived the app it belonged to; the reinstalled app talked to it and its engine failed to import.
test("stop-helpers ends a process left running from the bundle's Resources", { skip: process.platform !== "darwin" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "install-app-"));
  const app = fakeApp(dir);
  const helper = path.join(app, "Contents", "Resources", "node", "helper");
  mkdirSync(path.dirname(helper), { recursive: true });
  cpSync(path.join(app, "Contents", "MacOS", "Fake"), helper);
  const proc = spawn(helper, ["30"]);
  const running = () => spawnSync("pgrep", ["-f", `^${path.join(app, "Contents", "Resources")}/`], { encoding: "utf8" }).stdout.trim();
  try {
    spawnSync("sleep", ["0.3"]);
    assert.equal(running(), String(proc.pid), "the helper runs from the bundle");
    const r = spawnSync("bash", [script, "--stop-helpers", app], { encoding: "utf8", env: { ...process.env, CANVAS_INSTALL_PORT: "none" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(running(), "", "the helper is gone");
  } finally {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
