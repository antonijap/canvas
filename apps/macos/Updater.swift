// Updates for a downloaded copy of Canvas. A release build (the server inside the app, never a QA build or a build
// run from a checkout) reads the website's release manifest at launch and every 6 hours. A newer release this Mac
// takes is downloaded to the caches folder and checked (AppUpdate.verdict in ShellLogic.swift); a verified one waits
// in Canvas > Restart to Update and a toast, and installs when the person restarts or quits. With Settings > General >
// Update automatically off, or where the app cannot replace itself, it only offers the download page (the old way).
// docs/developer-guide.md "Updates" has the whole flow and the local end-to-end test (scripts/update-e2e.sh).

import AppKit
import CryptoKit
import Security

@MainActor
final class Updater: ObservableObject {
  static let shared = Updater()

  /// A verified update: the new Canvas.app, unzipped in the caches folder.
  struct Ready: Equatable { let version: String; let app: URL }

  static let automaticKey = "canvas.updates.automatic"
  @Published private(set) var ready: Ready?
  @Published private(set) var busy = false
  @Published var automatic: Bool = UserDefaults.standard.object(forKey: Updater.automaticKey) as? Bool ?? true {
    didSet { UserDefaults.standard.set(automatic, forKey: Updater.automaticKey) }
  }

  let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
  private let env = ProcessInfo.processInfo.environment
  private lazy var source = AppUpdate.manifestSource(env: env)
  /// The local end-to-end test is on (CANVAS_UPDATE_MANIFEST on 127.0.0.1): the bridge may drive the updater.
  var localTest: Bool { source.localTest }
  private weak var model: CanvasModel?
  private var base = URL(string: "http://127.0.0.1")!
  /// A release build: only these check on their own and install.
  private var release = false
  private var restartRequested = false
  private var timer: Timer?

  private let d = UserDefaults.standard
  /// The version a quit is installing; the next launch says whether it took.
  private let installingKey = "canvas.updates.installing"

  private var cacheRoot: URL {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSHomeDirectory() + "/Library/Caches")
    return caches.appendingPathComponent(Bundle.main.bundleIdentifier ?? "cc.getcanvas.canvas", isDirectory: true)
  }
  private var staging: URL { cacheRoot.appendingPathComponent("Updates", isDirectory: true) }
  private var logFile: URL {
    let dir = env["CANVAS_LOG_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
      ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Canvas", isDirectory: true)
    return dir.appendingPathComponent("update.log")
  }

  /// The running app, for the checks: version, bundle id, Developer ID team (nil when ad-hoc or unsigned).
  private lazy var own = AppUpdate.Own(version: version, bundleID: Bundle.main.bundleIdentifier ?? "", teamID: Updater.ownTeamID())

  func setup(model: CanvasModel, base: URL, release: Bool) {
    self.model = model
    self.base = base
    self.release = release
  }

  /// At launch and every 6 hours, release builds only (CANVAS_NO_UPDATE_CHECK turns it off).
  func start() {
    guard release, env["CANVAS_NO_UPDATE_CHECK"] == nil else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in self?.check(userInitiated: false) }
    timer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { _ in
      MainActor.assumeIsolated { Updater.shared.check(userInitiated: false) }
    }
  }

  // MARK: Checking

  /// Canvas > Check for Updates... (userInitiated: always answers) and the scheduled checks (quiet: a toast only for
  /// something new, once per version).
  func check(userInitiated: Bool) {
    if let r = ready { if userInitiated { announceReady(r, force: true) }; return }
    guard !busy else { if userInitiated { model?.flash("Canvas is already checking for updates") }; return }
    guard release else {
      if userInitiated { model?.flash("This copy of Canvas was built from source, so it does not update itself.") }
      return
    }
    busy = true
    let url = source.url
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
    URLSession(configuration: .ephemeral).dataTask(with: req) { data, response, _ in
      let parsed = (response as? HTTPURLResponse)?.statusCode == 200 ? data.flatMap(AppUpdate.parse) : nil
      DispatchQueue.main.async { MainActor.assumeIsolated { Updater.shared.found(parsed, userInitiated: userInitiated) } }
    }.resume()
  }

  private func found(_ r: AppUpdate.Release?, userInitiated: Bool) {
    guard let r else {
      busy = false
      log("check: no manifest from \(source.url.absoluteString)")
      if userInitiated { model?.flash("Canvas could not reach getcanvas.cc to check for updates. Try again later.") }
      return
    }
    #if arch(arm64)
    let arch = "arm64"
    #else
    let arch = "x86_64"
    #endif
    guard AppUpdate.offers(r, current: version, os: ProcessInfo.processInfo.operatingSystemVersion, arch: arch) else {
      busy = false
      if userInitiated { model?.flash("Canvas is up to date", level: "success") }
      return
    }
    // The old way: a toast that points to the download page.
    guard automatic, own.teamID != nil else { busy = false; offerDownload(r.version, why: nil, userInitiated: userInitiated); return }
    if case .manual(let why) = installMode() { busy = false; offerDownload(r.version, why: why, userInitiated: userInitiated); return }
    if userInitiated { model?.flash("Downloading Canvas \(r.version)\u{2026}") }
    download(r, userInitiated: userInitiated)
  }

  private func installMode() -> AppUpdate.Install {
    let app = Bundle.main.bundlePath, fm = FileManager.default
    return AppUpdate.installMode(bundlePath: app, folderWritable: fm.isWritableFile(atPath: (app as NSString).deletingLastPathComponent),
                                 bundleWritable: fm.isWritableFile(atPath: app))
  }

  /// "Canvas 0.1.2 is out" with Download (the website), and why it does not install itself when there is a reason.
  /// Asked for (Check for Updates): the download page opens too.
  private func offerDownload(_ v: String, why: String?, userInitiated: Bool) {
    guard userInitiated || d.string(forKey: "canvas.updates.told") != v else { return }
    d.set(v, forKey: "canvas.updates.told")
    let text = why.map { "Canvas \(v) is out. \($0)" } ?? "Canvas \(v) is out"
    if userInitiated && why != nil { openDownloadPage() }
    model?.flash(text, durationMs: 12000, actions: [ToastAction(id: "download", label: "Download", symbol: nil) { [weak self] in
      self?.model?.clearToast(); self?.openDownloadPage()
    }])
    count("update.toast_shown")
  }

  func openDownloadPage() {
    NSWorkspace.shared.open(ReleaseLinks.download)
    count("update.download_clicked")
  }

  // MARK: Downloading and checking

  private func download(_ r: AppUpdate.Release, userInitiated: Bool) {
    guard let url = AppUpdate.downloadURL(manifest: source.url, file: r.file) else {
      busy = false; log("download: no URL for \(r.file)"); return
    }
    let dir = staging.appendingPathComponent(r.version, isDirectory: true)
    let zip = dir.appendingPathComponent(r.file)
    let own = self.own, localTest = source.localTest
    let finish: @Sendable (AppUpdate.Facts, URL?) -> Void = { facts, app in
      DispatchQueue.main.async { MainActor.assumeIsolated { Updater.shared.verified(r, facts: facts, app: app, userInitiated: userInitiated) } }
    }
    let verify: @Sendable () -> Void = {
      DispatchQueue.global(qos: .utility).async {
        let (facts, app) = Updater.verify(zip: zip, release: r, own: own, in: dir, localTest: localTest)
        finish(facts, app)
      }
    }
    // A download already here from an earlier run (the right size): checked again, not fetched again.
    if (try? FileManager.default.attributesOfItem(atPath: zip.path)[.size] as? Int) == r.size { verify(); return }
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    log("download: \(url.absoluteString)")
    URLSession(configuration: .ephemeral).downloadTask(with: URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)) { tmp, response, error in
      if let tmp, (response as? HTTPURLResponse)?.statusCode == 200 {
        try? FileManager.default.moveItem(at: tmp, to: zip)
      } else {
        Updater.appendLog("download failed: \(error?.localizedDescription ?? "HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")")
      }
      verify()
    }.resume()
  }

  /// Every check in AppUpdate.verdict's order; stops at the first failure (the facts after it stay nil).
  nonisolated static func verify(zip: URL, release r: AppUpdate.Release, own: AppUpdate.Own, in dir: URL, localTest: Bool) -> (AppUpdate.Facts, URL?) {
    var f = AppUpdate.Facts()
    let fm = FileManager.default
    func done() -> (AppUpdate.Facts, URL?) {
      let ok = AppUpdate.verdict(f, release: r, own: own, localTest: localTest) == .install
      return (f, ok ? dir.appendingPathComponent("app", isDirectory: true).appendingPathComponent("Canvas.app") : nil)
    }
    f.size = (try? fm.attributesOfItem(atPath: zip.path)[.size] as? Int) ?? nil
    guard f.size == r.size else { return done() }
    f.sha256 = sha256(zip)
    guard f.sha256 == r.sha256 else { return done() }
    // A fresh folder each time: nothing from an earlier unzip can be mistaken for this one.
    let out = dir.appendingPathComponent("app", isDirectory: true)
    try? fm.removeItem(at: out)
    try? fm.createDirectory(at: out, withIntermediateDirectories: true)
    f.unzipped = run("/usr/bin/ditto", ["-x", "-k", zip.path, out.path]) == 0
    guard f.unzipped else { return done() }
    let entries = ((try? fm.contentsOfDirectory(atPath: out.path)) ?? []).sorted()
    let app = out.appendingPathComponent("Canvas.app")
    let isLink = (try? fm.destinationOfSymbolicLink(atPath: app.path)) != nil
    f.apps = isLink ? ["Canvas.app (a link)"] : entries
    guard f.apps == ["Canvas.app"] else { return done() }
    let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
    f.bundleID = info?["CFBundleIdentifier"] as? String
    f.version = info?["CFBundleShortVersionString"] as? String
    guard f.bundleID == own.bundleID, f.version == r.version else { return done() }
    f.signatureValid = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path]) == 0
    guard f.signatureValid == true else { return done() }
    f.teamID = teamID(of: app)
    guard f.teamID != nil, f.teamID == own.teamID else { return done() }
    // spctl alone accepts a Developer ID app that is not notarized when it carries no quarantine flag (this download
    // has none: URLSession sets none), so the app must also meet the "notarized" code requirement.
    let spctl = run("/usr/sbin/spctl", ["--assess", "--type", "execute", app.path]) == 0, notarized = isNotarized(app)
    f.gatekeeper = spctl && notarized
    if localTest && f.gatekeeper != true {
      appendLog("local test: Gatekeeper check failed (spctl \(spctl ? "accepts" : "rejects"), notarized \(notarized ? "yes" : "no")) for \(app.path); skipped")
    }
    return done()
  }

  private func verified(_ r: AppUpdate.Release, facts: AppUpdate.Facts, app: URL?, userInitiated: Bool) {
    busy = false
    let verdict = AppUpdate.verdict(facts, release: r, own: own, localTest: source.localTest)
    guard verdict == .install, let app else {
      let why: String = { if case .refuse(let w) = verdict { return w }; return "it did not unzip" }()
      log("refused \(r.version): \(why)")
      try? FileManager.default.removeItem(at: staging.appendingPathComponent(r.version, isDirectory: true))
      count("update.failed")
      guard userInitiated || d.string(forKey: "canvas.updates.told") != r.version else { return }
      d.set(r.version, forKey: "canvas.updates.told")
      model?.flash("Canvas \(r.version) did not pass its checks (\(why)), so it was not installed", durationMs: 12000,
                   actions: [ToastAction(id: "download", label: "Download", symbol: nil) { [weak self] in self?.model?.clearToast(); self?.openDownloadPage() }])
      return
    }
    log("ready \(r.version): \(app.path)")
    let first = ready == nil
    ready = Ready(version: r.version, app: app)
    if first { count("update.ready") }
    announceReady(ready!, force: userInitiated)
  }

  /// "Canvas 0.1.2 is ready" with Restart to Update; once per version unless asked for.
  private func announceReady(_ r: Ready, force: Bool) {
    guard force || d.string(forKey: "canvas.updates.readyTold") != r.version else { return }
    d.set(r.version, forKey: "canvas.updates.readyTold")
    model?.flash("Canvas \(r.version) is ready", durationMs: 12000, actions: [ToastAction(id: "restart", label: "Restart to Update", symbol: nil) { [weak self] in
      self?.model?.clearToast(); self?.restartToUpdate()
    }])
  }

  // MARK: Installing

  /// Canvas > Restart to Update, and the toast's button: quit the usual way (every edit saved first), install, open.
  func restartToUpdate() {
    guard let r = ready else { return }
    log("restart to update to \(r.version)")
    restartRequested = true
    NSApp.terminate(nil)
  }

  /// The quit did not happen (an edit could not be saved): a later plain quit is not a restart.
  func quitCancelled() { restartRequested = false }

  /// Called by applicationShouldTerminate once every edit is saved. With an update ready (Restart to Update, or a
  /// plain quit while Update automatically is on): the server stops (it runs from inside the app being replaced),
  /// then the helper starts and waits for this process to exit. `done(false)` keeps the app open.
  func beforeQuit(_ done: @escaping (Bool) -> Void) {
    let restart = restartRequested
    restartRequested = false
    guard let r = ready, restart || automatic, FileManager.default.fileExists(atPath: r.app.path) else { done(true); return }
    log("quitting with \(r.version) ready: stopping the server")
    if case .manual(let why) = installMode() {
      log("not installing \(r.version): \(why)")
      if restart { openDownloadPage(); model?.flash("Canvas \(r.version) is out. \(why)"); done(false) } else { done(true) }
      return
    }
    stoppingServer = true
    let base = self.base
    DispatchQueue.global(qos: .userInitiated).async {
      let stopped = Updater.stopServer(base)
      DispatchQueue.main.async { MainActor.assumeIsolated {
        let u = Updater.shared
        guard stopped else {
          stoppingServer = false
          u.log("not installing \(r.version): the server did not stop")
          if restart { u.model?.flash("Canvas could not stop its server to update. Try again in a moment."); done(false) } else { done(true) }
          return
        }
        done(u.launchHelper(r, relaunch: restart))
      } }
    }
  }

  /// Writes the helper to the caches folder and starts it; true when it runs (or nothing could be done, so quit).
  private func launchHelper(_ r: Ready, relaunch: Bool) -> Bool {
    let pass = env.filter { $0.key.hasPrefix("CANVAS_") }.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    let script = AppUpdate.helperScript(pid: getpid(), app: Bundle.main.bundlePath, staged: r.app.path, stagingRoot: staging.path,
                                        log: logFile.path, relaunch: relaunch, env: pass)
    let file = cacheRoot.appendingPathComponent("update-helper.sh")
    do {
      try FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
      try script.write(to: file, atomically: true, encoding: .utf8)
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/bin/sh")
      p.arguments = [file.path]
      p.standardInput = FileHandle.nullDevice
      p.standardOutput = FileHandle.nullDevice
      p.standardError = FileHandle.nullDevice
      try p.run()
      d.set(r.version, forKey: installingKey)
      log("installing \(r.version) after quit (helper pid \(p.processIdentifier), relaunch \(relaunch))")
    } catch {
      log("not installing \(r.version): the helper did not start (\(error.localizedDescription))")
    }
    return true
  }

  /// After the server is up at launch: whether the last quit's install took.
  func launched() {
    guard let v = d.string(forKey: installingKey) else { return }
    d.removeObject(forKey: installingKey)
    if v == version {
      count("update.installed")
      model?.flash("Canvas is updated to \(v)", level: "success")
    } else {
      count("update.failed")
      model?.flash("Canvas could not install \(v). Details in ~/Library/Logs/Canvas/update.log.")
    }
  }

  // MARK: Helpers

  private func count(_ name: String) { UsageCount.send(name, to: base) }
  private func log(_ line: String) { Updater.appendLog(line) }

  nonisolated static func appendLog(_ line: String) {
    let dir = ProcessInfo.processInfo.environment["CANVAS_LOG_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
      ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Canvas", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let f = dir.appendingPathComponent("update.log")
    let text = ISO8601DateFormatter().string(from: Date()) + " " + line + "\n"
    if let h = try? FileHandle(forWritingTo: f) { h.seekToEndOfFile(); h.write(Data(text.utf8)); try? h.close() }
    else { try? Data(text.utf8).write(to: f) }
  }

  nonisolated static func sha256(_ file: URL) -> String? {
    guard let h = try? FileHandle(forReadingFrom: file) else { return nil }
    defer { try? h.close() }
    var hasher = SHA256()
    while let chunk = try? h.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  @discardableResult nonisolated static func run(_ tool: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tool)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
  }

  /// The team identifier of a bundle's signature (nil: ad-hoc, unsigned or unreadable).
  nonisolated static func teamID(of app: URL) -> String? {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else { return nil }
    return teamID(code)
  }

  /// Apple's notarization ticket is there (stapled, or found online): the "notarized" code requirement.
  nonisolated static func isNotarized(_ app: URL) -> Bool {
    var code: SecStaticCode?, req: SecRequirement?
    guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code,
          SecRequirementCreateWithString("notarized" as CFString, [], &req) == errSecSuccess, let req else { return false }
    return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), req) == errSecSuccess
  }

  nonisolated static func ownTeamID() -> String? {
    var me: SecCode?, code: SecStaticCode?
    guard SecCodeCopySelf([], &me) == errSecSuccess, let me, SecCodeCopyStaticCode(me, [], &code) == errSecSuccess, let code else { return nil }
    return teamID(code)
  }

  private nonisolated static func teamID(_ code: SecStaticCode) -> String? {
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let dict = info as? [String: Any], let team = dict[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty else { return nil }
    return team
  }

  /// POST /quit (the server finishes its writes first), then wait up to 10 s for it to stop answering.
  nonisolated static func stopServer(_ base: URL) -> Bool {
    var req = URLRequest(url: base.appendingPathComponent("quit"))
    req.httpMethod = "POST"
    req.timeoutInterval = 3
    req.setValue("1", forHTTPHeaderField: "x-canvas")
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { _, _, _ in sem.signal() }.resume()
    _ = sem.wait(timeout: .now() + 4)
    for _ in 0..<50 {
      if !serverUp() { return true }
      usleep(200_000)
    }
    return false
  }
}

/// True while a quit stops the server for an update: keepServerUp must not start it again.
var stoppingServer = false
