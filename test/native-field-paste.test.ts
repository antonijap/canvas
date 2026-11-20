import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("native invite fields paste from the QA instance clipboard", { skip: process.platform !== "darwin" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-field-paste-"));
  try {
    const source = fs.readFileSync("apps/macos/QA.swift", "utf8");
    const helper = source.slice(source.indexOf("    private static func swizzle(_"), source.indexOf("    // MARK: ops"));
    const hook = source.split("\n").filter((line) => line.includes("swizzle(NSTextView.self,")).join("\n");
    const start = source.indexOf("extension NSTextView {");
    const extensionCode = start < 0 ? "" : source.slice(start, source.indexOf("\n}\n", start) + 3);
    const file = path.join(dir, "Paste.swift"), binary = path.join(dir, "paste");
    fs.writeFileSync(file, `import AppKit
import ObjectiveC
let canvasPasteboard = NSPasteboard.withUniqueName()
${extensionCode}
final class Observer: NSObject, NSTextViewDelegate {
    var changed = false
    func textDidChange(_ notification: Notification) { changed = true }
}
@main struct Check { @MainActor static func main() {
    defer { canvasPasteboard.releaseGlobally() }
    canvasPasteboard.setString("invite from this instance", forType: .string)
    // Never read the person's system clipboard. An empty original stands in for its unrelated contents.
    let empty: @convention(block) (AnyObject, AnyObject?) -> Void = { _, _ in }
    let selector = #selector(NSText.paste(_:))
    let original = class_getInstanceMethod(NSTextView.self, selector)!
    class_replaceMethod(NSTextView.self, selector, imp_implementationWithBlock(empty), method_getTypeEncoding(original))
    ${hook}
    let field = NSTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 60))
    let observer = Observer(); field.delegate = observer
    field.string = "before after"; field.setSelectedRange(NSRange(location: 7, length: 5))
    field.paste(nil)
    guard field.string == "before invite from this instance" else { print("FAIL: invite never reached the native field"); exit(1) }
    guard observer.changed else { print("FAIL: paste did not notify the field's binding"); exit(1) }
    print("ok: native field uses the instance clipboard")
}
${helper}
}
`);
    execFileSync("swiftc", ["-module-cache-path", "/tmp/canvas-swift-modules", "-parse-as-library", file, "-o", binary], { stdio: "pipe" });
    assert.match(execFileSync(binary, { encoding: "utf8" }), /ok: native field uses the instance clipboard/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
