// Canvas > Settings (Settings.swift draws it): the values, their limits and defaults, how they persist in
// UserDefaults, and what the page and the server get. No SwiftUI or AppKit here, so Tests/SettingsTests.swift runs it
// on its own (swiftc -parse-as-library ShellLogic.swift SettingsLogic.swift Tests/SettingsTests.swift).
// Snapping and the big nudge are SnapSettings (Shell.swift): Settings > Canvas
// edit the same values.

import CryptoKit
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
    /// The longest name a Cloud takes (Settings > Cloud), and the most Clouds one Canvas keeps (src/cloud-config.ts
    /// CLOUD_LIMITS says the same).
    static let serverName = 60
    static let clouds = 200
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
    var showWhiteboardName = true
    /// Settings > Cloud: every Cloud this Canvas talks to (CloudList below). The sign-in token is never a setting.
    var clouds: [CloudEntry] = []
    /// Bumped whenever `clouds` changes (Model.swift), so the server takes the newest list only (src/cloud-config.ts).
    var cloudsRev = 0
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
        if has("showWhiteboardName") { s.showWhiteboardName = d.bool(forKey: k("showWhiteboardName")) }
        s.clouds = CloudList.load(d)
        s.cloudsRev = d.integer(forKey: k("cloudsRev"))
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
        d.set(showWhiteboardName, forKey: k("showWhiteboardName"))
        d.set(CloudList.encode(clouds), forKey: k(CloudList.key))
        d.set(cloudsRev, forKey: k("cloudsRev"))
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
        s.clouds = CloudList.clean(clouds)
        return s
    }

    /// What the page reads (`prefs` in the page script, src/server.ts), as a JS object literal for {cmd: "prefs"}.
    var pagePrefs: [String: Any] {
        ["boardLabels": boardLabels, "openView": openView.rawValue, "scrollZooms": scrollZooms,
         "agentCursor": agentCursor, "agentCursorSpeed": cursorSpeed.multiplier, "snapshotMB": snapshotMB,
         "whiteboardName": showWhiteboardName ? commentName : ""]
    }
    var pagePrefsJSON: String {
        guard let d = try? JSONSerialization.data(withJSONObject: pagePrefs, options: [.sortedKeys]),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    /// What the server reads (src/settings.ts), sent with the shell's state.
    var serverSettings: [String: Any] {
        ["harness": harness.rawValue, "runCapMin": runCapMin, "commentName": commentName,
         "clouds": CloudList.forServer(clouds), "cloudsRev": cloudsRev,
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
    /// Connect worked. Sessions already open keep the MCP they started with until they restart (src/mcp-connect.ts addedMessage).
    static func added(_ agent: String) -> String { "Added. New \(agent) sessions use it; restart any that are open." }
    /// An MCP from before an update is talking to Canvas (GET /api/mcp/setup `outdated`): its agent session must restart.
    static let outdated = "Connected (older version, restart your agent session)"
    /// Only an MCP of another copy of Canvas talks (`otherCopy`): not older, so no restart advice.
    static let otherCopy = "Connected (an agent runs another copy of Canvas)"
    /// The line under the Agents card for a GET /api/mcp/setup answer, nil when there is nothing to say.
    static func status(_ setup: [String: Any]) -> String? {
        if setup["outdated"] as? Bool == true { return outdated }
        if setup["otherCopy"] as? Bool == true { return otherCopy }
        return nil
    }
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
    /// The origin of an address: https with a dotted host, a hosted Cloud by its id (canvas-cloud://<id>), or http on
    /// this Mac. Nil for anything else (http to another host never: a hosted Cloud is reached through its tunnel).
    static func clean(_ raw: String) -> String? {
        guard let u = URLComponents(string: raw.trimmingCharacters(in: .whitespaces)), let scheme = u.scheme?.lowercased(),
              let host = u.host?.lowercased(), !host.isEmpty, u.user == nil, u.password == nil else { return nil }
        if scheme == "canvas-cloud" { return UUID(uuidString: host) != nil && u.port == nil ? "canvas-cloud://\(host)" : nil }
        let port = u.port.map { ":\($0)" } ?? ""
        if scheme == "https" && host.contains(".") { return "https://\(host)\(u.port == 443 ? "" : port)" }
        if scheme == "http" && (host == "localhost" || host == "127.0.0.1") { return "http://\(host)\(u.port == 80 ? "" : port)" }
        return nil
    }
    /// http://localhost or http://127.0.0.1: where a server run with DEV=1 takes an email in place of Access.
    static func isLocal(_ raw: String) -> Bool { clean(raw)?.hasPrefix("http://") ?? false }
    /// A Cloud hosted on a Mac (canvas-cloud://<id>): joined with an invite, left rather than signed out of.
    static func isHosted(_ raw: String) -> Bool { clean(raw)?.hasPrefix("canvas-cloud://") ?? false }
    /// The host (and port) of a cleaned address, as the Keychain item's account.
    static func host(_ raw: String) -> String {
        guard let c = clean(raw), let u = URL(string: c), let h = u.host else { return "" }
        return u.port.map { "\(h):\($0)" } ?? h
    }
}

/// What kind of Cloud an entry is: a server (Cloudflare, or a local development one), a Cloud joined with an invite,
/// or one this Mac hosts (any number, one per team).
enum CloudKind: String, Codable, Equatable {
    case server, joined, hosted
}

/// One Cloud in Settings > Cloud and in Home's sidebar. `id` is stable for the entry's life (Home's selection, the
/// Settings detail); `url` is its canonical address (CloudURL.clean), the one the server and comments.json use.
struct CloudEntry: Codable, Equatable, Identifiable {
    var id: String
    var url: String
    var name: String
    /// A local development server only: the email its DEV mode takes in place of a sign-in.
    var devEmail: String
    var kind: CloudKind
    /// A Cloud this Mac hosts: whether hosting is on, so it starts again with Canvas.
    var hosting: Bool

    init(id: String = UUID().uuidString, url: String, name: String = "", devEmail: String = "", kind: CloudKind, hosting: Bool = false) {
        self.id = id; self.url = url; self.name = name; self.devEmail = devEmail; self.kind = kind; self.hosting = hosting
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        url = try c.decode(String.self, forKey: .url)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        devEmail = try c.decodeIfPresent(String.self, forKey: .devEmail) ?? ""
        kind = (try? c.decode(CloudKind.self, forKey: .kind)) ?? .server
        hosting = try c.decodeIfPresent(Bool.self, forKey: .hosting) ?? false
    }

    /// The server adapter is in Alpha, including its local development mode.
    var adapterAlpha: Bool { kind == .server && !CloudURL.isHosted(url) }
    var adapterTooltip: String { adapterAlpha ? "Cloudflare adapter, Alpha" : "" }
    static let alphaNotice = "The Cloudflare adapter is in Alpha: it works, but it is not yet well tested. Keep your own copies of important files."

    /// A hosted Cloud's id (canvas-cloud://<id>), else nil.
    var hostId: String? { url.hasPrefix("canvas-cloud://") ? String(url.dropFirst("canvas-cloud://".count)) : nil }
}

/// The list of Clouds: limits, cleaning, storage and the one-time move from the single Cloud of older versions.
enum CloudList {
    static let key = "clouds"
    /// The settings of a version with one Cloud. Read once, moved into the list, then removed.
    static let legacyKeys = ["cloudUrl", "cloudName", "cloudDevEmail", "cloudHosting"]

    /// Every entry made safe: a canonical address (else dropped), one entry per address, at most 200, names at most
    /// 60 characters, an email only for a local development address, hosting only for a Cloud this Mac hosts.
    static func clean(_ list: [CloudEntry]) -> [CloudEntry] {
        var out: [CloudEntry] = []
        var seen = Set<String>(), ids = Set<String>()
        for var e in list {
            guard out.count < SettingsLimits.clouds, let url = CloudURL.clean(e.url), !seen.contains(url) else { continue }
            e.url = url
            if e.id.isEmpty || ids.contains(e.id) { e.id = UUID().uuidString }
            e.name = String(e.name.prefix(SettingsLimits.serverName))
            if !CloudURL.isLocal(url) { e.devEmail = "" } else { e.devEmail = String(e.devEmail.prefix(120)) }
            if !CloudURL.isHosted(url) { e.kind = .server } else if e.kind == .server { e.kind = .joined }
            if e.kind != .hosted { e.hosting = false }
            seen.insert(url); ids.insert(e.id)
            out.append(e)
        }
        return out
    }

    /// Adds a Cloud, or finds the one already at that address (a name given now names it). Nil for an address Canvas
    /// cannot use, or a full list.
    static func add(_ list: [CloudEntry], url raw: String, name: String = "", devEmail: String = "", kind: CloudKind) -> (list: [CloudEntry], entry: CloudEntry)? {
        guard let url = CloudURL.clean(raw) else { return nil }
        let trimmed = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(SettingsLimits.serverName))
        var list = clean(list)
        if let i = list.firstIndex(where: { $0.url == url }) {
            if !trimmed.isEmpty { list[i].name = trimmed }
            if kind == .hosted { list[i].kind = .hosted }
            return (list, list[i])
        }
        guard list.count < SettingsLimits.clouds else { return nil }
        let k: CloudKind = CloudURL.isHosted(url) ? (kind == .server ? .joined : kind) : .server
        let e = CloudEntry(url: url, name: trimmed, devEmail: CloudURL.isLocal(url) ? devEmail.trimmingCharacters(in: .whitespaces) : "", kind: k)
        list.append(e)
        return (clean(list), e)
    }

    static func remove(_ list: [CloudEntry], id: String) -> [CloudEntry] { list.filter { $0.id != id } }

    /// The Clouds this Mac hosts.
    static func hosted(_ list: [CloudEntry]) -> [CloudEntry] { list.filter { $0.kind == .hosted } }

    /// Sorted by name for the lists (Home's sidebar, Settings > Cloud), and those whose name has every word of `query`.
    static func filtered(_ list: [CloudEntry], query: String, name: (CloudEntry) -> String) -> [CloudEntry] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        return list.filter { e in words.allSatisfy { name(e).localizedCaseInsensitiveContains($0) } }
            .sorted { name($0).localizedStandardCompare(name($1)) == .orderedAscending }
    }

    /// What the server gets (src/cloud-config.ts cleanCloudList): addresses, and emails for local development only.
    static func forServer(_ list: [CloudEntry]) -> [[String: String]] {
        clean(list).map { ["url": $0.url, "devEmail": CloudURL.isLocal($0.url) ? $0.devEmail.trimmingCharacters(in: .whitespaces) : ""] }
    }

    static func encode(_ list: [CloudEntry]) -> Data { (try? JSONEncoder().encode(list)) ?? Data("[]".utf8) }
    static func decode(_ data: Data?) -> [CloudEntry] {
        guard let data, let list = try? JSONDecoder().decode([CloudEntry].self, from: data) else { return [] }
        return clean(list)
    }

    /// The old address moves as joined until the server identifies which Cloud this Mac hosted. The old hosting
    /// flag alone cannot identify it: older versions could host one Cloud while joined to another.
    static func migrate(url: String, name: String, devEmail: String, hosting: Bool) -> [CloudEntry] {
        guard let clean = CloudURL.clean(url) else { return [] }
        let kind: CloudKind = CloudURL.isHosted(clean) ? .joined : .server
        return self.clean([CloudEntry(url: clean, name: name, devEmail: devEmail, kind: kind, hosting: kind == .hosted)])
    }

    /// The stored list. With none stored yet (a missing key, which is not an empty list), the older single Cloud is
    /// moved into it: the list is written first, and only then are the old keys removed, so a quit in between loses
    /// nothing and a restart never moves it twice.
    static func load(_ d: UserDefaults) -> [CloudEntry] {
        let k = { (name: String) in AppSettings.prefix + name }
        if d.object(forKey: k(key)) != nil { return decode(d.data(forKey: k(key))) }
        let list = migrate(url: d.string(forKey: k("cloudUrl")) ?? "", name: d.string(forKey: k("cloudName")) ?? "",
                           devEmail: d.string(forKey: k("cloudDevEmail")) ?? "", hosting: d.bool(forKey: k("cloudHosting")))
        d.set(encode(list), forKey: k(key))
        // Hosting was on: the Cloud this Mac hosted may not be the address above (an older version kept hosting while
        // the address named a Cloud it joined). Remembered until reconcile learns which Cloud it is from the server.
        if d.bool(forKey: k("cloudHosting")) { d.set(true, forKey: k(legacyHostingKey)) }
        if d.object(forKey: k(key)) != nil { for old in legacyKeys { d.removeObject(forKey: k(old)) } }
        return list
    }
}

/// A Cloud this Mac hosts, as GET /api/cloud/host lists it.
struct HostedInfo: Equatable {
    let hostId: String
    let name: String
    let hosting: Bool
    /// The first slot, where the single hosted Cloud of older versions lives.
    let legacy: Bool
}

extension CloudList {
    /// The most Clouds one Mac hosts (src/cloud-host.ts MAX_HOSTED).
    static let maxHosted = 8
    static func hostLimit(_ reported: Int?) -> Int { min(max(reported ?? maxHosted, 1), maxHosted) }
    static func hostedIds(_ list: [CloudEntry], known: Set<String>) -> Set<String> {
        known.union(hosted(list).compactMap(\.hostId))
    }
    /// Set by the move from an older version when hosting was on: the Cloud this Mac hosted then starts again once the
    /// server has said which one it is (reconcile).
    static let legacyHostingKey = "cloudsLegacyHosting"

    /// The list made to agree with what this Mac hosts: a hosted Cloud the list does not have is added (a Cloud an
    /// older version hosted, running or stopped, is never lost), an entry this Mac hosts is a hosted one, and a
    /// "hosted" entry this Mac does not host is one it joined. `legacyHosting`: the older version had hosting on.
    static func reconcile(_ list: [CloudEntry], hosted: [HostedInfo], legacyHosting: Bool) -> [CloudEntry] {
        var out = list
        for i in out.indices where out[i].kind != .server {
            guard let id = out[i].hostId else { continue }
            if let h = hosted.first(where: { $0.hostId == id }) {
                if out[i].kind != .hosted {
                    out[i].kind = .hosted
                    out[i].hosting = h.hosting || (h.legacy && legacyHosting)
                } else if h.hosting {
                    out[i].hosting = true
                }
            } else if out[i].kind == .hosted {
                out[i].kind = .joined
                out[i].hosting = false
            }
        }
        for h in hosted where !out.contains(where: { $0.hostId == h.hostId }) {
            let name = h.name.trimmingCharacters(in: .whitespaces)
            out.append(CloudEntry(url: "canvas-cloud://\(h.hostId)", name: name.isEmpty ? "Cloud" : name, kind: .hosted, hosting: h.hosting || (h.legacy && legacyHosting)))
        }
        return clean(out)
    }
}

/// Remove or Delete a Cloud: what went wrong, from the answers of the server's routes, or nil when it all worked.
enum CloudRemoval {
    /// `wipe`: the answer to deleting a hosted Cloud's data (nil when there was none to delete); `remove`: to removing it.
    static func problem(wipe: (status: Int, error: String?)?, remove: (status: Int, error: String?)) -> String? {
        if let wipe, wipe.status != 200 { return wipe.error ?? "Could not delete the Cloud\u{2019}s data on this Mac" }
        if remove.status != 200 { return remove.error ?? "Could not remove the Cloud" }
        return nil
    }
}

/// File > Share Comments: which Clouds can take the open file now.
enum CloudShare {
    /// The titles of the Clouds in the question, one per Cloud and never two alike (a menu keeps only one of each
    /// title): a repeated name gets its address, then a number.
    static func titles(_ list: [CloudEntry], name: (CloudEntry) -> String, detail: (CloudEntry) -> String) -> [String] {
        let names = list.map(name)
        var out: [String] = []
        for (i, e) in list.enumerated() {
            var t = names[i]
            if names.filter({ $0 == t }).count > 1 { t = "\(t) (\(detail(e)))" }
            var n = 2
            let base = t
            while out.contains(t) { t = "\(base) \(n)"; n += 1 }
            out.append(t)
        }
        return out
    }

    /// What the toast says after a share: where the comments went, and for a file that was already shared, whether
    /// that Cloud is reachable now. `ok` is false when the person has something to do.
    static func message(already: Bool, name: String, status: String?) -> (text: String, ok: Bool) {
        if !already { return ("Comments shared to \(name)", true) }
        if status == "connected" { return ("Already shared. Connected to \(name)", true) }
        return ("Already shared to \(name). \(CloudStatusText.line(status ?? "offline", configured: true))", false)
    }

    /// Connected, as an owner or an editor (a viewer or commenter cannot register a file).
    static func candidates(_ list: [CloudEntry], status: [String: (status: String, role: String?)]) -> [CloudEntry] {
        list.filter { e in
            guard let s = status[e.url], s.status == "connected" else { return false }
            return s.role == "owner" || s.role == "editor"
        }
    }
}

enum CloudMove {
    static func destinations(_ list: [CloudEntry], targetID: String?) -> [CloudEntry] {
        list.filter { $0.kind != .server && (targetID == nil || $0.id == targetID) }
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
        case "down": return "Cloud down"
        case "removed": return "Removed from this Cloud"
        case "unavailable": return "Not available in this build"
        default: return "Offline"
        }
    }
    /// The one plain line under a status that needs it: "Studio Cloud isn't open right now".
    static func detail(_ status: String, name: String) -> String? {
        switch status {
        case "down": return "\(name) isn\u{2019}t open right now"
        case "removed": return "Ask the host for a new invite"
        default: return nil
        }
    }
    /// "Signed in as anna@studio.com, owner".
    static func account(email: String?, role: String?) -> String? {
        guard let email, !email.isEmpty else { return nil }
        return "Signed in as \(email)" + ((role?.isEmpty ?? true) ? "" : ", \(role!)")
    }
}

/// An invite to a Cloud hosted on a Mac: canvas://cloud/join?v=1&name=&host=&tc=&code=. The same rules as
/// src/cloud-config.ts parseInvite. The link is a secret (its code lets one Mac in): Canvas copies it, never shows it.
struct CloudInvite: Equatable {
    let name: String
    let hostId: String
    let addr: String
    let code: String
    let link: String

    static func parse(_ raw: String) -> CloudInvite? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count <= 8192, var u = URLComponents(string: t), u.scheme?.lowercased() == "canvas", u.host == "cloud", u.path == "/join" else { return nil }
        // The host uses form encoding. Decode spaces before queryItems so an escaped literal plus stays a plus.
        u.percentEncodedQuery = u.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%20")
        func q(_ k: String) -> String { u.queryItems?.first { $0.name == k }?.value ?? "" }
        let host = q("host").lowercased(), addr = q("tc"), code = q("code")
        guard q("v") == "1", UUID(uuidString: host) != nil, host.count == 36,
              addr.range(of: "^tc[A-Za-z0-9_-]{20,4000}$", options: .regularExpression) != nil,
              code.range(of: "^ccj_[0-9a-f]{16}\\.[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { return nil }
        let name = q("name").components(separatedBy: .controlCharacters).joined(separator: " ")
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return CloudInvite(name: name.isEmpty ? "Cloud" : String(name.prefix(60)), hostId: host, addr: addr, code: code, link: t)
    }

    /// The Cloud's address once joined.
    var url: String { "canvas-cloud://\(hostId)" }

    /// Whether this Mac can join: not into a Cloud it is already in, and not into the one it hosts.
    enum Check: Equatable { case ok, already(id: String), hostsIt }
    static func check(_ invite: CloudInvite, list: [CloudEntry], hostedIds: Set<String> = []) -> Check {
        if hostedIds.contains(invite.hostId) { return .hostsIt }
        if let e = list.first(where: { $0.url == invite.url }) { return e.kind == .hosted ? .hostsIt : .already(id: e.id) }
        return .ok
    }

    /// The line to compare by eye before joining.
    var fingerprintLine: String { "Fingerprint \(fingerprint). Ask the host to read theirs from Settings > Cloud: they should match." }

    /// A short fingerprint of the tunnel address to compare with the host's by eye: "3F9A-C21B" (src/cloud-tunnel.ts).
    var fingerprint: String { CloudInvite.fingerprint(addr) }
    static func fingerprint(_ addr: String) -> String {
        let h = SHA256.hash(data: Data(addr.utf8)).prefix(4).map { String(format: "%02X", $0) }.joined()
        return "\(h.prefix(4))-\(h.suffix(4))"
    }
}

/// The plain words Settings > Cloud shows before someone hosts or joins (docs/cloud/hosting.md says the same).
enum CloudDisclosure {
    static let lines = [
        "Everyone in this Cloud can open its files. Exported copies and backups stay with whoever made them.",
        "A deleted comment\u{2019}s text stays in the Cloud\u{2019}s history, and each person keeps their own copy.",
        "When two Macs can\u{2019}t connect directly, traffic goes through a relay that sees who connects and when, not what is said.",
        "Invite tokens are kept in the macOS Keychain, where apps running as you can read them.",
    ]
}

/// The Settings window's frame for its pane's height: the top edge stays where it is, the window never grows past the
/// screen's visible area (the pane scrolls past that), and it stays on that screen.
enum SettingsWindowFit {
    /// `chrome`: the window's frame height minus its content height (title bar and toolbar).
    /// `width`: the window's frame width for the pane's width.
    static func frame(current: CGRect, chrome: CGFloat, content: CGFloat, width: CGFloat? = nil, visible: CGRect?) -> CGRect {
        var height = max(1, content) + max(0, chrome)
        if let visible { height = min(height, visible.height) }
        var top = current.maxY
        if let visible { top = min(top, visible.maxY) }
        var y = top - height
        if let visible, y < visible.minY { y = visible.minY }
        return CGRect(x: current.minX, y: y, width: width ?? current.width, height: height)
    }
}
