import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Home waits for newly added Clouds to reach the server before reading status", { skip: process.platform !== "darwin" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-cloud-refresh-"));
  try {
    const source = fs.readFileSync("apps/macos/CloudSettings.swift", "utf8");
    const methods = source.slice(source.indexOf("    func refresh(_ model:"), source.indexOf("    // MARK: Adding")).replaceAll("URLSession.shared", "testSession");
    const state = source.slice(source.indexOf("struct CloudState:"), source.indexOf("/// What GET /api/cloud/host"));
    fs.writeFileSync(path.join(dir, "Refresh.swift"), `
import Foundation
${state}
final class Transport: URLProtocol, @unchecked Sendable {
    static var listed = false
    static var probes = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let probe = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems?.contains { $0.name == "url" } == true
        if probe { Self.probes += 1; Self.listed = Self.probes > 1 }
        let body = probe ? "{}" : (Self.listed ? #"{"clouds":[{"url":"http://127.0.0.1:1234","status":"connected"}]}"# : #"{"clouds":[]}"#)
        client!.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: probe && !Self.listed ? 404 : 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client!.urlProtocol(self, didLoad: Data(body.utf8)); client!.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
let testSession: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [Transport.self]
    return URLSession(configuration: config)
}()
struct Prefs { var clouds = [CloudEntry(url: "http://127.0.0.1:1234", kind: .server)] }
final class CanvasModel { let base = URL(string: "http://127.0.0.1:9999")!; var prefs = Prefs() }
final class Account {
    var states: [String: CloudState] = [:]
${methods}
}
@main struct Check {
    static func main() async {
        let account = Account(); await account.refresh(CanvasModel(), fresh: true)
        guard account.states["http://127.0.0.1:1234"]?.status == "connected" else { print("FAIL: first Home refresh missed the new Cloud"); exit(1) }
        print("ok: new Cloud status read after the list arrived")
    }
}
`);
    const binary = path.join(dir, "refresh");
    execFileSync("swiftc", ["-module-cache-path", "/tmp/canvas-swift-modules", "-parse-as-library", "apps/macos/ShellLogic.swift", "apps/macos/SettingsLogic.swift", path.join(dir, "Refresh.swift"), "-o", binary], { stdio: "pipe" });
    assert.match(execFileSync(binary, { encoding: "utf8" }), /ok: new Cloud status/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
