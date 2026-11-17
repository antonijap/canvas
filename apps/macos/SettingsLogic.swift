// Canvas > Settings (Settings.swift draws it): the values, their limits and defaults, how they persist in
// UserDefaults, and what the page and the server get. No SwiftUI or AppKit here, so Tests/SettingsTests.swift runs it
// on its own (swiftc -parse-as-library ShellLogic.swift SettingsLogic.swift Tests/SettingsTests.swift).
// Snapping and the big nudge are SnapSettings (Shell.swift): Settings > Canvas
// edit the same values.

import Foundation

/// Where a file's view starts when it opens.
enum OpenView: String, CaseIterable, Identifiable {
    case restore, fit
    var id: String { rawValue }
    var title: String { self == .restore ? "Where you left it" : "Fit the page" }
}

/// Which local agent talk-to-the-selection runs first (src/agent-run.ts); the other is the backup.
enum AgentHarness: String, CaseIterable, Identifiable {
    case claude, codex
    var id: String { rawValue }
    var title: String { self == .claude ? "Claude Code" : "Codex" }
}

/// How fast the agent cursor plays an edit (src/page/agent-cursor-logic.js speedOf).
enum CursorSpeed: String, CaseIterable, Identifiable {
    case slow, normal, fast
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var multiplier: Double {
        switch self {
        case .slow: 0.7
        case .normal: 1
        case .fast: 1.5
        }
    }
}

enum SettingsLimits {
    static let runCap = 1...60
    static let keptTabs = 1...8
    static let snapshotMB = 50...1000
    static let snapshotStep = 50
    /// The longest name a team server takes (Settings > Cloud).
    static let serverName = 60
    static func clamp(_ v: Int, _ r: ClosedRange<Int>) -> Int { min(max(v, r.lowerBound), r.upperBound) }
    static func volume(_ v: Double) -> Double { v.isFinite ? min(max(v, 0), 1) : 0.8 }
}

struct AppSettings: Equatable {
    // Canvas
    var openView = OpenView.restore
    var scrollZooms = false
    var boardLabels = true
    /// The name on the comments made here (Settings > General). Starts as the Mac's full user name; empty: the server says "Me".
    var commentName = ""
    /// Settings > Cloud: the team's own Canvas server (https, or http on this Mac for development) and, for a local
    /// development server only, the email its DEV mode takes in place of a sign-in. The sign-in token is never a setting.
    var cloudUrl = ""
    var cloudDevEmail = ""
    /// What the team server is called in Home; empty: its host.
    var cloudName = ""
    // Agents
    var harness = AgentHarness.claude
    var agentCursor = true
    var cursorSpeed = CursorSpeed.normal
    var runCapMin = 10
    /// The model and reasoning level each agent runs with ("" = the agent's own default; src/settings.ts checks them).
    var claudeModel = ""
    var claudeEffort = ""
    var codexModel = ""
    var codexEffort = ""
    // Sounds
    var finishSound = true
    var soundVolume = 0.8
    // Performance
    var keptTabs = 3
    var snapshotMB = 200
    // Privacy: anonymous usage counts (src/usage-counts.ts). Sharing is on by default, without an install id.
    var shareUsage = true
    var improveCanvas = false

    static let prefix = "canvas.settings."

    static func load(_ d: UserDefaults) -> AppSettings {
        var s = AppSettings()
        let k = { (name: String) in prefix + name }
        let has = { (name: String) in d.object(forKey: k(name)) != nil }
        if let v = d.string(forKey: k("openView")).flatMap(OpenView.init) { s.openView = v }
        if has("scrollZooms") { s.scrollZooms = d.bool(forKey: k("scrollZooms")) }
        if has("boardLabels") { s.boardLabels = d.bool(forKey: k("boardLabels")) }
        s.commentName = d.string(forKey: k("commentName")) ?? NSFullUserName()
        s.cloudUrl = d.string(forKey: k("cloudUrl")) ?? ""
        s.cloudDevEmail = d.string(forKey: k("cloudDevEmail")) ?? ""
        s.cloudName = d.string(forKey: k("cloudName")) ?? ""
        if let v = d.string(forKey: k("harness")).flatMap(AgentHarness.init) { s.harness = v }
        if has("agentCursor") { s.agentCursor = d.bool(forKey: k("agentCursor")) }
        if let v = d.string(forKey: k("cursorSpeed")).flatMap(CursorSpeed.init) { s.cursorSpeed = v }
        if has("runCapMin") { s.runCapMin = SettingsLimits.clamp(d.integer(forKey: k("runCapMin")), SettingsLimits.runCap) }
        s.claudeModel = d.string(forKey: k("claudeModel")) ?? ""
        s.claudeEffort = d.string(forKey: k("claudeEffort")) ?? ""
        s.codexModel = d.string(forKey: k("codexModel")) ?? ""
        s.codexEffort = d.string(forKey: k("codexEffort")) ?? ""
        if has("finishSound") { s.finishSound = d.bool(forKey: k("finishSound")) }
        if has("soundVolume") { s.soundVolume = SettingsLimits.volume(d.double(forKey: k("soundVolume"))) }
        if has("keptTabs") { s.keptTabs = SettingsLimits.clamp(d.integer(forKey: k("keptTabs")), SettingsLimits.keptTabs) }
        if has("snapshotMB") { s.snapshotMB = SettingsLimits.clamp(d.integer(forKey: k("snapshotMB")), SettingsLimits.snapshotMB) }
        if has("shareUsage") { s.shareUsage = d.bool(forKey: k("shareUsage")) }
        if has("improveCanvas") { s.improveCanvas = d.bool(forKey: k("improveCanvas")) }
        return s
    }

    func save(_ d: UserDefaults) {
        let k = { (name: String) in AppSettings.prefix + name }
        d.set(openView.rawValue, forKey: k("openView"))
        d.set(scrollZooms, forKey: k("scrollZooms"))
        d.set(boardLabels, forKey: k("boardLabels"))
        d.set(commentName, forKey: k("commentName"))
        d.set(cloudUrl, forKey: k("cloudUrl"))
        d.set(cloudDevEmail, forKey: k("cloudDevEmail"))
        d.set(cloudName, forKey: k("cloudName"))
        d.set(harness.rawValue, forKey: k("harness"))
        d.set(agentCursor, forKey: k("agentCursor"))
        d.set(cursorSpeed.rawValue, forKey: k("cursorSpeed"))
        d.set(runCapMin, forKey: k("runCapMin"))
        d.set(claudeModel, forKey: k("claudeModel"))
        d.set(claudeEffort, forKey: k("claudeEffort"))
        d.set(codexModel, forKey: k("codexModel"))
        d.set(codexEffort, forKey: k("codexEffort"))
        d.set(finishSound, forKey: k("finishSound"))
        d.set(soundVolume, forKey: k("soundVolume"))
        d.set(keptTabs, forKey: k("keptTabs"))
        d.set(snapshotMB, forKey: k("snapshotMB"))
        d.set(shareUsage, forKey: k("shareUsage"))
        d.set(improveCanvas, forKey: k("improveCanvas"))
    }

    /// Every value inside its limits (a typed 0 or 5000 never reaches the page, the server or the defaults).
    var clamped: AppSettings {
        var s = self
        s.runCapMin = SettingsLimits.clamp(runCapMin, SettingsLimits.runCap)
        s.keptTabs = SettingsLimits.clamp(keptTabs, SettingsLimits.keptTabs)
        s.snapshotMB = SettingsLimits.clamp(snapshotMB, SettingsLimits.snapshotMB)
        s.soundVolume = SettingsLimits.volume(soundVolume)
        s.cloudName = String(cloudName.prefix(SettingsLimits.serverName))
        return s
    }

    /// What the page reads (`prefs` in the page script, src/server.ts), as a JS object literal for {cmd: "prefs"}.
    var pagePrefs: [String: Any] {
        ["boardLabels": boardLabels, "openView": openView.rawValue, "scrollZooms": scrollZooms,
         "agentCursor": agentCursor, "agentCursorSpeed": cursorSpeed.multiplier, "snapshotMB": snapshotMB]
    }
    var pagePrefsJSON: String {
        guard let d = try? JSONSerialization.data(withJSONObject: pagePrefs, options: [.sortedKeys]),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    /// What the server reads (src/settings.ts), sent with the shell's state.
    var serverSettings: [String: Any] {
        ["harness": harness.rawValue, "runCapMin": runCapMin, "commentName": commentName,
         "cloudUrl": CloudURL.clean(cloudUrl) ?? "", "cloudDevEmail": CloudURL.isLocal(cloudUrl) ? cloudDevEmail : "",
         "claude": ["model": claudeModel, "effort": claudeEffort], "codex": ["model": codexModel, "effort": codexEffort]]
    }

    func model(_ h: AgentHarness) -> String { h == .claude ? claudeModel : codexModel }
    func effort(_ h: AgentHarness) -> String { h == .claude ? claudeEffort : codexEffort }
    mutating func setModel(_ h: AgentHarness, _ v: String) { if h == .claude { claudeModel = v } else { codexModel = v } }
    mutating func setEffort(_ h: AgentHarness, _ v: String) { if h == .claude { claudeEffort = v } else { codexEffort = v } }

    /// Help improve Canvas only counts while sharing is on (its switch is off and greyed out then).
    var improveEffective: Bool { shareUsage && improveCanvas }

    /// What the server's usage counts read (src/usage-counts.ts cleanFacts), sent with the shell's state: the two
    /// switches and the facts only the app knows. A QA build says so, and its server never sends.
    func usageFacts(version: String, commit: String?, os: String, qa: Bool) -> [String: Any] {
        var d: [String: Any] = ["share": shareUsage, "improve": improveEffective, "version": version, "os": os, "qa": qa]
        if let commit { d["commit"] = commit }
        return d
    }
}

/// Settings > Privacy's link: what the usage counts are, on the website.
enum UsageLinks {
    static let privacy = URL(string: "https://getcanvas.cc/privacy#usage")!
}

/// Connect in Settings > Agents (POST /api/mcp/connect, src/mcp-connect.ts): the same words as the welcome card
/// (src/page/widget-kinds.js) and the course's Connect your agent board (demos/build-learn.ts).
enum ConnectCopy {
    /// The line under the Agents card: where to read about connecting any other app.
    static let otherApps = "Other apps: getcanvas.cc/download#connect"
    static let otherAppsURL = URL(string: "https://getcanvas.cc/download#connect")!
    static func added(_ agent: String) -> String { "Added. Start a new \(agent) session." }
    /// The button's title; "Added" reads as Connected in Settings; nil hides it (the agent's CLI is not installed:
    /// Copy command in the row's menu is all there is).
    static func button(installed: Bool, registered: Bool, busy: Bool) -> String? {
        if busy { return "Connecting\u{2026}" }
        if !installed { return nil }
        return registered ? "Added" : "Connect"
    }
}

/// A crash, for usage counts: a marker set at launch and cleared on a normal quit. Found set at the next launch, the
/// last run ended without quitting (a crash, or a force quit).
enum RunMarker {
    static let key = "canvas.running"
    /// At launch: whether the last run ended without quitting. Sets the marker for this run.
    static func launch(_ d: UserDefaults) -> Bool {
        let crashed = d.bool(forKey: key)
        d.set(true, forKey: key)
        return crashed
    }
    /// On a normal quit.
    static func quit(_ d: UserDefaults) { d.set(false, forKey: key) }
}

/// Settings > Shortcuts: every menu command with a key (from MenuSpec, so the list never drifts from the menus) and
/// the canvas's own keys. Each key is one cap; modifier and arrow caps are SF Symbols.
enum ShortcutCatalog {
    struct Row: Equatable, Identifiable { let title: String; let keys: [String]; var id: String { title + keys.joined() } }
    struct Group: Equatable, Identifiable { let title: String; let rows: [Row]; var id: String { title } }

    /// SF Symbols for the caps that have one.
    static let symbols: [String: String] = [
        "⌘": "command", "⇧": "shift", "⌥": "option", "⌃": "control", "↩": "return", "⌫": "delete.left",
        "↑": "arrow.up", "↓": "arrow.down", "←": "arrow.left", "→": "arrow.right", "⇥": "arrow.right.to.line",
    ]

    /// The caps for a menu key: modifiers in the Mac's order (⌃ ⌥ ⇧ ⌘), then the key itself.
    static func caps(key: String, mods: Set<MenuSpec.Mod>) -> [String] {
        var out = [String]()
        if mods.contains(.control) { out.append("⌃") }
        if mods.contains(.option) { out.append("⌥") }
        if mods.contains(.shift) { out.append("⇧") }
        if mods.contains(.command) { out.append("⌘") }
        out.append(key == "\r" ? "↩" : key.uppercased())
        return out
    }

    /// The menus' commands that have a key, menu by menu; submenu markers and separators skipped.
    static var menuGroups: [Group] {
        MenuSpec.menus.compactMap { title, entries in
            let rows = entries.compactMap { $0 }.filter { !$0.key.isEmpty && !$0.title.hasPrefix(">") && $0.title != "<" }
                .map { Row(title: $0.title.replacingOccurrences(of: "\u{2026}", with: ""), keys: caps(key: $0.key, mods: $0.mods)) }
            return rows.isEmpty ? nil : Group(title: title, rows: rows)
        }
    }

    /// Keys the canvas handles itself (src/page/shortcuts.js), not in any menu.
    static let canvas = Group(title: "On the canvas", rows: [
        Row(title: "Ask about the selection", keys: ["⌘", "↩"]),
        Row(title: "Make 3 variations", keys: ["⇧", "⌘", "↩"]),
        Row(title: "Nudge", keys: ["↑", "↓", "←", "→"]),
        Row(title: "Big nudge", keys: ["⇧", "↑"]),
        Row(title: "Resize", keys: ["⌘", "↑"]),
        Row(title: "Select children", keys: ["↩"]),
        Row(title: "Select parent", keys: ["⇧", "↩"]),
        Row(title: "Select parent", keys: ["\\"]),
        Row(title: "Keyboard selection", keys: ["⌥", "Space"]),
        Row(title: "Next sibling", keys: ["⇥"]),
        Row(title: "Next board", keys: ["N"]),
        Row(title: "Scale tool", keys: ["K"]),
        Row(title: "Comment on the canvas", keys: ["C"]),
        Row(title: "Opacity 10%", keys: ["1"]),
        Row(title: "Opacity 100%", keys: ["0"]),
        Row(title: "Delete", keys: ["⌫"]),
        Row(title: "Resize board to fit", keys: ["⌥", "⇧", "⌘", "R"]),
        Row(title: "Bold", keys: ["⌘", "B"]),
        Row(title: "Italic", keys: ["⌘", "I"]),
        Row(title: "Font size up", keys: ["⇧", "⌘", "."]),
        Row(title: "Font size down", keys: ["⇧", "⌘", ","]),
        Row(title: "Quick actions", keys: ["⌘", "/"]),
        // Zoom and view (src/page/navigate.js).
        Row(title: "Zoom in", keys: ["⇧", "+"]),
        Row(title: "Zoom out", keys: ["⇧", "-"]),
        Row(title: "Pan (nothing selected)", keys: ["↑", "↓", "←", "→"]),
        Row(title: "Zoom tool (hold, click; ⌥ out)", keys: ["Z"]),
    ])

    static var all: [Group] { [canvas] + menuGroups }
}

/// Settings > Cloud: the server address and the words for where sign-in stands. The same rules as src/cloud-config.ts.
enum CloudURL {
    /// The origin of an address: https with a dotted host, or http on this Mac. Nil for anything else; a path is dropped.
    static func clean(_ raw: String) -> String? {
        guard let u = URLComponents(string: raw.trimmingCharacters(in: .whitespaces)), let scheme = u.scheme?.lowercased(),
              let host = u.host?.lowercased(), !host.isEmpty, u.user == nil, u.password == nil else { return nil }
        let port = u.port.map { ":\($0)" } ?? ""
        if scheme == "https" && host.contains(".") { return "https://\(host)\(u.port == 443 ? "" : port)" }
        if scheme == "http" && (host == "localhost" || host == "127.0.0.1") { return "http://\(host)\(u.port == 80 ? "" : port)" }
        return nil
    }
    /// http://localhost or http://127.0.0.1: where a server run with DEV=1 takes an email in place of Access.
    static func isLocal(_ raw: String) -> Bool { clean(raw)?.hasPrefix("http://") ?? false }
    /// The host (and port) of a cleaned address, as the Keychain item's account.
    static func host(_ raw: String) -> String {
        guard let c = clean(raw), let u = URL(string: c), let h = u.host else { return "" }
        return u.port.map { "\(h):\($0)" } ?? h
    }
}

/// Settings > Cloud before an address is saved: one field and Sign in (CloudSettings.swift).
enum CloudSetup {
    enum Next: Equatable { case signIn, askEmail }
    /// A String, not a string literal: SwiftUI reads a literal title as Markdown and draws an address as a blue link.
    static let placeholder = "https://your-team.workers.dev"
    /// The short layout shows while no address is saved.
    static func compact(_ saved: String) -> Bool { saved.trimmingCharacters(in: .whitespaces).isEmpty }
    /// The line under the field: only while the typed text is not an address Canvas can use.
    static func hint(_ typed: String) -> String? {
        typed.trimmingCharacters(in: .whitespaces).isEmpty || CloudURL.clean(typed) != nil ? nil : "Use an https address, like https://studio.workers.dev"
    }
    /// What Sign in does with the typed address: nil (not an address, the button is off), sign in at once, or first ask
    /// for the development email a local server in DEV mode takes.
    static func next(_ typed: String, devEmail: String) -> Next? {
        guard CloudURL.clean(typed) != nil else { return nil }
        return CloudURL.isLocal(typed) && devEmail.trimmingCharacters(in: .whitespaces).isEmpty ? .askEmail : .signIn
    }
}

/// What src/cloud.ts says about the server (GET /api/cloud/status): the status word and the line Settings shows for it.
enum CloudStatusText {
    static func line(_ status: String, configured: Bool) -> String {
        if !configured { return "No server" }
        switch status {
        case "connected": return "Connected"
        case "offline": return "Offline"
        case "signedOut": return "Signed out"
        case "signInAgain": return "Sign in again"
        case "forbidden": return "No access to this team"
        case "tooOld": return "The server is too old"
        case "tooNew": return "The server is newer than this Canvas"
        default: return "Offline"
        }
    }
    /// "Signed in as anna@studio.com, owner".
    static func account(email: String?, role: String?) -> String? {
        guard let email, !email.isEmpty else { return nil }
        return "Signed in as \(email)" + ((role?.isEmpty ?? true) ? "" : ", \(role!)")
    }
}
