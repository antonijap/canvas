import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("background QA hosting view accepts its first native click without window activation", { skip: process.platform !== "darwin" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-first-click-"));
  try {
    const source = fs.readFileSync("apps/macos/Shell.swift", "utf8");
    const view = source.slice(source.indexOf("final class ControlHostingView<"), source.indexOf("private let barY"));
    const file = path.join(dir, "Click.swift"), binary = path.join(dir, "click");
    fs.writeFileSync(file, `import SwiftUI\n${view}\n@main struct Check { @MainActor static func main() {
      let view = ControlHostingView(rootView: Text("Add Cloud"))
      guard view.acceptsFirstMouse(for: nil) else { print("FAIL: background click is consumed before the control receives it"); exit(1) }
      precondition(!view.mouseDownCanMoveWindow)
      print("ok: background native click accepted")
    } }`);
    execFileSync("swiftc", ["-module-cache-path", "/tmp/canvas-swift-modules", "-parse-as-library", "-D", "CANVAS_QA", file, "-o", binary], { stdio: "pipe" });
    assert.match(execFileSync(binary, { encoding: "utf8" }), /ok: background native click accepted/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
