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

function fakeApp(dir: string): string {
  const app = path.join(dir, "Fake.app");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(path.join(app, "Contents", "Info.plist"), plist("Fake"));
  cpSync("/bin/sleep", path.join(app, "Contents", "MacOS", "Fake"));
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
    renameSync(app, path.join(dir, "Old.app"));
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
