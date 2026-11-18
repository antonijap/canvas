// Run the shell's startup method with a small transport double and real settings migration.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("launch discovers and resumes legacy hosting before Settings opens", { skip: process.platform !== "darwin" }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-startup-"));
  try {
    const source = fs.readFileSync("apps/macos/CloudSettings.swift", "utf8");
    const method = source.slice(source.indexOf("    func resumeHosting("), source.indexOf("    /// Stop hosting one Cloud:")).replaceAll("UserDefaults.standard", "testDefaults");
    const blocked = source.slice(source.indexOf("    private var hostBlocked:"), source.indexOf("    private var pick:"));
    fs.writeFileSync(path.join(tmp, "Startup.swift"), `
import Foundation
let testSuite = "canvas.startup.tests." + UUID().uuidString
let testDefaults = UserDefaults(suiteName: testSuite)!
@MainActor final class CanvasModel { var prefs: AppSettings; init(_ prefs: AppSettings) { self.prefs = prefs } }
@MainActor final class CloudAccount {
    var started: [String] = []
    var discoveries = 0
    var hosts: [String: Int] = [:]
    var hostAvailable = true
    var hostMax = CloudList.maxHosted
    let id = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b"
    func names(_ model: CanvasModel, name: String) -> [String: Any] { ["name": name] }
    static var active: CloudAccount!
    static func post(_ model: CanvasModel, _ route: String, _ body: [String: Any]) async -> (Int, [String: Any]) {
        active.started.append(body["hostId"] as! String); return (200, [:])
    }
    func refreshHost(_ model: CanvasModel) async {
        discoveries += 1
        let key = AppSettings.prefix + CloudList.legacyHostingKey
        guard testDefaults.bool(forKey: key) else { return }
        model.prefs.clouds = CloudList.reconcile(model.prefs.clouds, hosted: [HostedInfo(hostId: id, name: "Team", hosting: false, legacy: true)], legacyHosting: true)
        testDefaults.removeObject(forKey: key)
        resumeHosting(model)
    }
${method}
}
@MainActor struct HostingSheet {
    let model: CanvasModel
    let account: CloudAccount
${blocked}
    var problem: String? { hostBlocked }
}
@main struct StartupTests {
    @MainActor static func main() async {
        defer { testDefaults.removePersistentDomain(forName: testSuite) }
        let account = CloudAccount(); CloudAccount.active = account
        let d = testDefaults, prefix = AppSettings.prefix
        d.set("canvas-cloud://" + account.id, forKey: prefix + "cloudUrl")
        d.set(true, forKey: prefix + "cloudHosting")
        let model = CanvasModel(AppSettings.load(d))
        precondition(model.prefs.clouds.first?.kind == .joined)
        account.resumeHosting(model)
        for _ in 0..<100 { if !account.started.isEmpty { break }; try? await Task.sleep(nanoseconds: 10_000_000) }
        guard account.started == [account.id], model.prefs.clouds.first?.kind == .hosted else {
            print("FAIL: launch did not discover and resume the legacy hosted Cloud"); exit(1)
        }
        // Seven distinct ids leave room for the eighth; a duplicate known id consumes no extra slot.
        model.prefs.clouds = (0..<7).map { i in
            CloudEntry(url: String(format: "canvas-cloud://%08x-0000-4000-8000-000000000000", i), kind: .hosted)
        }
        account.hosts = [model.prefs.clouds[0].hostId!: 0]
        let sheet = HostingSheet(model: model, account: account)
        precondition(sheet.problem == nil, "the eighth Cloud is allowed")
        account.hosts["ffffffff-0000-4000-8000-000000000000"] = 0
        precondition(sheet.problem == "This Mac hosts 8 Clouds, the most it can. Delete one first", "the ninth attempt explains the cap")
        print("ok: legacy hosting resumed at launch; shell cap checked at seven and eight ids")
    }
}
`);
    const binary = path.join(tmp, "startup");
    execFileSync("swiftc", ["-module-cache-path", path.join(tmp, "modules"), "-parse-as-library", "apps/macos/ShellLogic.swift", "apps/macos/SettingsLogic.swift", path.join(tmp, "Startup.swift"), "-o", binary], { stdio: "pipe" });
    assert.match(execFileSync(binary, { encoding: "utf8" }), /ok: legacy hosting resumed/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
