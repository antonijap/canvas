// The shell's end of the MCP bridge: one long-lived SSE connection to the server that receives
// commands (tabs, open, snapshot, ...), acks each one, and keeps the server told about the window.
// The connection belongs to the shell, not the page, so it survives page reloads.

import AppKit
import Combine
import WebKit
import UniformTypeIdentifiers
import ImageIO

@MainActor
final class BridgeClient {
  private let model: CanvasModel
  private let window: NSWindow
  private let base: URL
  private var loop: Task<Void, Never>?
  private var pending: Task<Void, Never>?
  private var observers: [NSObjectProtocol] = []
  private var cancellables = Set<AnyCancellable>()
  private var lastPosted: Data?
  private let clientId = "shell-" + UUID().uuidString
  private var seq = 0
  private var toastId: String?
  private var heartbeat: Timer?

  /// Long idle timeout: the server pings every 15 s, so 60 s of silence means a dead socket.
  private var stream = BridgeClient.makeStream()

  private static func makeStream() -> URLSession {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 60
    c.timeoutIntervalForResource = 24 * 3600
    return URLSession(configuration: c)
  }

  /// The server forgot this client: cancelling the stream ends the read loop, which reconnects.
  private func rebuildStream() { stream = BridgeClient.makeStream() }

  init(model: CanvasModel, window: NSWindow, base: URL) {
    self.model = model
    self.window = window
    self.base = base
  }

  var windowFocused: Bool { window.isKeyWindow && NSApp.isActive }
  var windowVisible: Bool { window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible) }

  func start() {
    guard loop == nil else { return }
    let names: [NSNotification.Name] = [
      NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
      NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification,
      NSWindow.didChangeOcclusionStateNotification,
    ]
    for n in names {
      observers.append(NotificationCenter.default.addObserver(forName: n, object: window, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.stateChanged() }
      })
    }
    for n in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.stateChanged() }
      })
    }
    model.$theme.dropFirst().sink { [weak self] _ in self?.stateChanged() }.store(in: &cancellables)
    // Settings > Agents (default harness, run cap) reach the server with the state.
    model.$prefs.dropFirst().sink { [weak self] _ in self?.stateChanged() }.store(in: &cancellables)
    model.$openFiles.dropFirst().sink { [weak self] _ in self?.stateChanged() }.store(in: &cancellables)
    model.$currentFile.dropFirst().sink { [weak self] _ in self?.stateChanged() }.store(in: &cancellables)
    heartbeat = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.postState(force: true) }
    }
    loop = Task { [weak self] in
      while !Task.isCancelled {
        await self?.connect()
        try? await Task.sleep(nanoseconds: 1_000_000_000)
      }
    }
  }

  // MARK: events

  private func connect() async {
    var comps = URLComponents(url: base.appendingPathComponent("api/bridge/events"), resolvingAgainstBaseURL: false)!
    comps.queryItems = [.init(name: "client", value: clientId), .init(name: "role", value: "shell"), .init(name: "host", value: "native")]
    var req = URLRequest(url: comps.url!)
    req.setValue("1", forHTTPHeaderField: "X-Canvas")
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    do {
      let (bytes, response) = try await stream.bytes(for: req)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
      for try await line in bytes.lines {
        if line.hasPrefix(":") || !line.hasPrefix("data:") { continue }
        var body = line.dropFirst(5)
        if body.hasPrefix(" ") { body = body.dropFirst() }
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = obj["type"] as? String else { continue }
        handle(event, obj)
      }
    } catch {
      // Server restarting or idle-exited; the loop reconnects after a second.
    }
  }

  private func handle(_ event: String, _ obj: [String: Any]) {
    switch event {
    case "hello":
      postState(force: true)
    case "cmd":
      guard let id = obj["id"] as? String, let op = obj["op"] as? String else { return }
      let args = obj["args"] as? [String: Any] ?? [:]
      Task { [weak self] in
        guard let self else { return }
        do {
          let result = try await self.run(op, args)
          await self.ack(id: id, ok: true, result: result, error: nil)
        } catch {
          let e = error as? BridgeError ?? BridgeError(code: "failed", message: "\(error)")
          await self.ack(id: id, ok: false, result: nil, error: ["code": e.code, "message": e.message])
        }
      }
    default:
      break
    }
  }

  // MARK: ops

  struct BridgeError: Error {
    let code: String; let message: String
    init(code: String = "failed", message: String) { self.code = code; self.message = message }
  }

  private var effectiveTheme: String {
    switch model.theme {
    case .light: return "light"
    case .dark: return "dark"
    case .system: return NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? "dark" : "light"
    }
  }
  private var themeInfo: [String: Any] { ["mode": model.theme.rawValue, "effective": effectiveTheme] }

  private func run(_ op: String, _ args: [String: Any]) async throws -> [String: Any] {
    switch op {
    case "ping":
      return ["pong": true, "t": Int(Date().timeIntervalSince1970 * 1000)]
    case "tabs":
      // live: the tab's page is kept (shown again at once); pid: its web content process.
      let tabs = model.openFiles.map { f -> [String: Any] in
        var t: [String: Any] = ["file": f, "name": model.name(of: f), "current": f == model.currentFile, "live": model.isLive(f)]
        if let pid = model.webContentPid(f) { t["pid"] = pid }
        return t
      }
      return ["tabs": tabs, "current": model.currentFile as Any? ?? NSNull()]
    case "open":
      guard let file = args["file"] as? String, !file.isEmpty else { throw BridgeError(code: "invalid", message: "open needs a file") }
      let wasOpen = model.openFiles.contains(file)
      model.open(file)
      if args["focus"] as? Bool == true { activate() }
      for _ in 0..<30 {
        if model.currentFile == file { break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      return ["file": file, "opened": !wasOpen, "current": model.currentFile as Any? ?? NSNull()]
    case "close":
      guard let file = (args["file"] as? String) ?? model.currentFile else { throw BridgeError(code: "not_found", message: "no file is open") }
      guard model.openFiles.contains(file) else { throw BridgeError(code: "not_found", message: "\(file) is not an open tab") }
      model.close(file)
      return ["closed": true, "file": file, "current": model.currentFile as Any? ?? NSNull()]
    case "theme.get":
      return themeInfo
    case "theme.set":
      guard let raw = args["mode"] as? String, let t = AppTheme(rawValue: raw) else { throw BridgeError(code: "invalid", message: "mode must be light, dark or system") }
      model.theme = t
      return themeInfo
    case "snapshot":
      return try await snapshot(args)
    case "fonts":
      return ["families": model.fonts.families]
    case "toast":
      let id = args["id"] as? String
      if args["clear"] as? Bool == true {
        if id == nil || id == toastId { model.clearToast(); toastId = nil }
        return ["shown": false]
      }
      let message = (args["message"] as? String) ?? ""
      guard !message.isEmpty else { throw BridgeError(code: "invalid", message: "toast needs a message") }
      let ms = (args["durationMs"] as? NSNumber)?.intValue ?? 4000
      toastId = ms <= 0 ? id : nil
      model.flash(String(message.prefix(200)), durationMs: ms, level: args["level"] as? String)
      return ["shown": true]
    case "update.state":
      // The updater (Updater.swift): this version, a verified update waiting, and the toast on screen.
      let u = Updater.shared
      return ["version": u.version, "ready": u.ready?.version as Any? ?? NSNull(), "busy": u.busy, "automatic": u.automatic,
              "localTest": u.localTest, "toast": model.toast as Any? ?? NSNull(), "actions": model.toastActions.map(\.label)]
    case "update.check", "update.restart":
      // Only the local end-to-end test drives these (scripts/update-e2e.sh); people use the Canvas menu and the toast.
      guard Updater.shared.localTest else { throw BridgeError(code: "forbidden", message: "\(op) is for the local update test only") }
      if op == "update.check" { Updater.shared.check(userInitiated: true); return ["checking": true] }
      guard Updater.shared.ready != nil else { throw BridgeError(code: "not_ready", message: "no update is ready") }
      // The answer goes out first; then the same path as Canvas > Restart to Update. A run loop timer, not a main queue
      // block: quitting waits in a nested run loop for main queue callbacks, which never run inside a main queue block.
      Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { _ in MainActor.assumeIsolated { Updater.shared.restartToUpdate() } }
      return ["restarting": true]
    case "activate":
      activate()
      return ["activated": true]
    case "sound":
      // Finish cue. Glass, else Hero; never fails the command when the sound is missing. Settings > Sounds can turn
      // it off or make it quieter.
      let want = (args["name"] as? String) ?? "Glass"
      guard model.prefs.finishSound else { return ["played": false, "name": want, "off": true] }
      return ["played": FinishSound.play(want, volume: model.prefs.soundVolume), "name": want]
    default:
      #if CANVAS_QA
      if op.hasPrefix("qa.") { return try await QA.run(op, args) }
      #endif
      throw BridgeError(code: "unsupported", message: "shell has no op \(op)")
    }
  }

  private func activate() {
    if window.isMiniaturized { window.deminiaturize(nil) }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func snapshot(_ args: [String: Any]) async throws -> [String: Any] {
    let maxSide = max(64, min(4096, (args["maxSide"] as? NSNumber)?.intValue ?? 1600))
    let format = (args["format"] as? String) == "jpeg" ? "jpeg" : "png"
    let quality = min(1, max(0.1, (args["quality"] as? NSNumber)?.doubleValue ?? 0.8))
    let webView = model.webView
    let image: NSImage = try await withCheckedThrowingContinuation { cont in
      webView.takeSnapshot(with: WKSnapshotConfiguration()) { image, error in
        if let image { cont.resume(returning: image) } else { cont.resume(throwing: BridgeError(message: error?.localizedDescription ?? "snapshot failed")) }
      }
    }
    var rect = NSRect(origin: .zero, size: image.size)
    guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { throw BridgeError(message: "snapshot had no pixels") }
    // Scaling and PNG encoding of a full-window capture take tens of ms: off the main thread, so the canvas and
    // the chrome keep drawing while an agent takes screenshots.
    let encoded = await Task.detached(priority: .userInitiated) { Self.encode(cg, maxSide: maxSide, jpeg: format == "jpeg", quality: quality) }.value
    guard let (data, w, h) = encoded else { throw BridgeError(message: "could not encode the snapshot") }
    return ["data": data.base64EncodedString(), "mime": format == "jpeg" ? "image/jpeg" : "image/png",
            "width": w, "height": h, "windowVisible": windowVisible]
  }

  /// Scales `cg` to fit `maxSide` and encodes it. Core Graphics and ImageIO only: safe off the main thread.
  nonisolated private static func encode(_ cg: CGImage, maxSide: Int, jpeg: Bool, quality: Double) -> (Data, Int, Int)? {
    let k = min(1, Double(maxSide) / Double(max(cg.width, cg.height)))
    let w = max(1, Int((Double(cg.width) * k).rounded())), h = max(1, Int((Double(cg.height) * k).rounded()))
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let scaled = ctx.makeImage() else { return nil }
    let out = NSMutableData()
    let type = (jpeg ? UTType.jpeg : UTType.png).identifier as CFString
    guard let dest = CGImageDestinationCreateWithData(out, type, 1, nil) else { return nil }
    let props: [CFString: Any] = jpeg ? [kCGImageDestinationLossyCompressionQuality: quality] : [:]
    CGImageDestinationAddImage(dest, scaled, props as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return (out as Data, w, h)
  }

  // MARK: shell -> server

  private func post(_ path: String, _ body: [String: Any]) async -> Bool { await postStatus(path, body) == 200 }

  private func postStatus(_ path: String, _ body: [String: Any]) async -> Int {
    var req = URLRequest(url: base.appendingPathComponent(path))
    req.httpMethod = "POST"
    req.timeoutInterval = 30
    req.setValue("1", forHTTPHeaderField: "X-Canvas")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    guard let (_, response) = try? await URLSession.shared.data(for: req) else { return 0 }
    return (response as? HTTPURLResponse)?.statusCode ?? 0
  }

  private func ack(id: String, ok: Bool, result: [String: Any]?, error: [String: Any]?) async {
    var body: [String: Any] = ["client": clientId, "id": id, "ok": ok]
    if let result { body["result"] = result }
    if let error { body["error"] = error }
    _ = await post("api/ack", body)
  }

  private func stateChanged() {
    pending?.cancel()
    pending = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 100_000_000)
      guard !Task.isCancelled else { return }
      self?.postState()
    }
  }

  private func postState(force: Bool = false) {
    var body: [String: Any] = [
      "client": clientId, "role": "shell", "host": "native", "windowFocused": windowFocused, "windowVisible": windowVisible,
      "theme": themeInfo, "openFiles": model.openFiles, "currentFile": model.currentFile as Any? ?? NSNull(),
      "settings": model.prefs.serverSettings,
      // Settings > Privacy and the facts only the app knows, for usage counts (src/usage-counts.ts).
      "usage": model.prefs.usageFacts(version: appVersion, commit: appCommit, os: ReleaseLinks.osString(ProcessInfo.processInfo.operatingSystemVersion), qa: isQABuild),
    ]
    guard let key = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]), force || key != lastPosted else { return }
    lastPosted = key
    seq += 1
    body["seq"] = seq
    Task { [weak self] in
      guard let self else { return }
      let status = await self.postStatus("api/state", body)
      if status == 404 { self.stream.invalidateAndCancel(); self.rebuildStream() }
      else if status != 200 { self.lastPosted = nil }
    }
  }
}

/// Usage counts (src/usage-counts.ts): one more of `name` today. Only the name goes; the server ignores names outside
/// its list, and everything while Settings > Privacy > Share usage counts is off.
enum UsageCount {
  static func send(_ name: String, to base: URL) {
    var req = URLRequest(url: base.appendingPathComponent("api/usage/count"))
    req.httpMethod = "POST"
    req.timeoutInterval = 5
    req.setValue("1", forHTTPHeaderField: "X-Canvas")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name])
    URLSession.shared.dataTask(with: req).resume()
  }
}
