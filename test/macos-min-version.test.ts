// The macOS the app opens on: apps/macos/build.sh compiles for the minimum Info.plist states, never for the Mac that
// builds it (0.1.0 was stamped macOS 27 while Info.plist said 13, so it would not open one version back).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const MAC = path.resolve(import.meta.dirname, "../apps/macos");
const plistMin = () => /<key>LSMinimumSystemVersion<\/key><string>([\d.]+)<\/string>/.exec(fs.readFileSync(path.join(MAC, "Info.plist"), "utf8"))?.[1];

test("Info.plist states macOS 26 or later: the window glass and WebGPU in WKWebView need it", () => {
  const min = plistMin();
  assert.ok(min, "LSMinimumSystemVersion is set");
  assert.ok(Number(min!.split(".")[0]) >= 26, `minimum ${min}`);
});

test("build.sh compiles the app for Info.plist's minimum", () => {
  const sh = fs.readFileSync(path.join(MAC, "build.sh"), "utf8");
  const swiftc = sh.split("\n").find((l) => l.startsWith("swiftc "));
  assert.ok(swiftc, "build.sh has a swiftc line");
  assert.match(swiftc!, /-target "\$\(uname -m\)-apple-macos\$MINOS"/, "swiftc gets a -target");
  assert.match(sh, /MINOS="\$\(\/usr\/libexec\/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info\.plist\)"/, "the target comes from Info.plist");
});

test("the Swift sources compile for that minimum without newer APIs", { skip: process.platform !== "darwin" }, () => {
  const sh = fs.readFileSync(path.join(MAC, "build.sh"), "utf8");
  const files = sh.split("\n").find((l) => l.startsWith("swiftc "))!.split(/\s+/).filter((w) => w.endsWith(".swift") && !w.includes("*"));
  const ds = fs.readdirSync(path.join(MAC, "DesignSystem")).filter((f) => f.endsWith(".swift")).map((f) => "DesignSystem/" + f);
  execFileSync("swiftc", ["-typecheck", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos${plistMin()}`, ...files, ...ds], { cwd: MAC, stdio: "pipe" });
});
