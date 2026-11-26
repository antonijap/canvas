import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const shell = fs.readFileSync("apps/macos/Shell.swift", "utf8");
const hosting = shell.slice(shell.indexOf("final class ControlHostingView<"), shell.indexOf("\nstruct RootView:"));
const moduleCache = path.join(os.tmpdir(), "canvas-swift-modules");

test("background QA hosting view accepts its first native click without window activation", { skip: process.platform !== "darwin" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-first-click-"));
  try {
    const file = path.join(dir, "Click.swift"), binary = path.join(dir, "click");
    fs.writeFileSync(file, `import SwiftUI\n${hosting}\n@main struct Check { @MainActor static func main() {
      let view = ControlHostingView(rootView: Text("Add Cloud"))
      guard view.acceptsFirstMouse(for: nil) else { print("FAIL: background click is consumed before the control receives it"); exit(1) }
      precondition(!view.mouseDownCanMoveWindow)
      print("ok: background native click accepted")
    } }`);
    execFileSync("swiftc", ["-module-cache-path", moduleCache, "-parse-as-library", "-D", "CANVAS_QA", file, "-o", binary], { stdio: "pipe" });
    assert.match(execFileSync(binary, { encoding: "utf8" }), /ok: background native click accepted/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Settings and Add Cloud hosting controllers deliver background clicks and keep their root view", { skip: process.platform !== "darwin" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-sheet-click-"));
  try {
    const settings = fs.readFileSync("apps/macos/Settings.swift", "utf8").match(/let host = (\w+)\(rootView: SettingsPane/)![1];
    const sheet = fs.readFileSync("apps/macos/CloudSettings.swift", "utf8").match(/let host = (\w+)\(rootView: AddCloudSheet/)![1];
    const file = path.join(dir, "Click.swift"), binary = path.join(dir, "click");
    fs.writeFileSync(file, `import SwiftUI
${hosting}
struct Probe: View { let title: String; var body: some View { Text(title) } }
@main struct Check { @MainActor static func main() {
    for host in [${settings}(rootView: Probe(title: "Settings")), ${sheet}(rootView: Probe(title: "Add Cloud"))] {
        guard host.view.acceptsFirstMouse(for: nil) else { print("FAIL: secondary window consumes its first click"); exit(1) }
        host.rootView = Probe(title: "Updated")
        guard let view = host.view as? NSHostingView<Probe>, view.rootView.title == "Updated" else { print("FAIL: root view stopped updating"); exit(1) }
    }
    print("ok: secondary window native click accepted")
} }
`);
    execFileSync("swiftc", ["-module-cache-path", moduleCache, "-parse-as-library", "-D", "CANVAS_QA", file, "-o", binary], { stdio: "pipe" });
    assert.match(execFileSync(binary, { encoding: "utf8" }), /ok: secondary window native click accepted/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
