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
    static func clamp(_ v: Int, _ r: ClosedRange<Int>) -> Int { min(max(v, r.lowerBound), r.upperBound) }
    static func volume(_ v: Double) -> Double { v.isFinite ? min(max(v, 0), 1) : 0.8 }
}

struct AppSettings: Equatable {
    // Canvas
    var openView = OpenView.restore
    var scrollZooms = false
    var boardLabels = true
    // Agents
    var harness = AgentHarness.claude
    var agentCursor = true
    var cursorSpeed = CursorSpeed.normal
    var runCapMin = 10
    // Sounds
    var finishSound = true
    var soundVolume = 0.8
    // Performance
    var keptTabs = 3
    var snapshotMB = 200

    static let prefix = "canvas.settings."

    static func load(_ d: UserDefaults) -> AppSettings {
        var s = AppSettings()
        let k = { (name: String) in prefix + name }
        let has = { (name: String) in d.object(forKey: k(name)) != nil }
        if let v = d.string(forKey: k("openView")).flatMap(OpenView.init) { s.openView = v }
        if has("scrollZooms") { s.scrollZooms = d.bool(forKey: k("scrollZooms")) }
        if has("boardLabels") { s.boardLabels = d.bool(forKey: k("boardLabels")) }
        if let v = d.string(forKey: k("harness")).flatMap(AgentHarness.init) { s.harness = v }
        if has("agentCursor") { s.agentCursor = d.bool(forKey: k("agentCursor")) }
        if let v = d.string(forKey: k("cursorSpeed")).flatMap(CursorSpeed.init) { s.cursorSpeed = v }
        if has("runCapMin") { s.runCapMin = SettingsLimits.clamp(d.integer(forKey: k("runCapMin")), SettingsLimits.runCap) }
        if has("finishSound") { s.finishSound = d.bool(forKey: k("finishSound")) }
        if has("soundVolume") { s.soundVolume = SettingsLimits.volume(d.double(forKey: k("soundVolume"))) }
        if has("keptTabs") { s.keptTabs = SettingsLimits.clamp(d.integer(forKey: k("keptTabs")), SettingsLimits.keptTabs) }
        if has("snapshotMB") { s.snapshotMB = SettingsLimits.clamp(d.integer(forKey: k("snapshotMB")), SettingsLimits.snapshotMB) }
        return s
    }

    func save(_ d: UserDefaults) {
        let k = { (name: String) in AppSettings.prefix + name }
        d.set(openView.rawValue, forKey: k("openView"))
        d.set(scrollZooms, forKey: k("scrollZooms"))
        d.set(boardLabels, forKey: k("boardLabels"))
        d.set(harness.rawValue, forKey: k("harness"))
        d.set(agentCursor, forKey: k("agentCursor"))
        d.set(cursorSpeed.rawValue, forKey: k("cursorSpeed"))
        d.set(runCapMin, forKey: k("runCapMin"))
        d.set(finishSound, forKey: k("finishSound"))
        d.set(soundVolume, forKey: k("soundVolume"))
        d.set(keptTabs, forKey: k("keptTabs"))
        d.set(snapshotMB, forKey: k("snapshotMB"))
    }

    /// Every value inside its limits (a typed 0 or 5000 never reaches the page, the server or the defaults).
    var clamped: AppSettings {
        var s = self
        s.runCapMin = SettingsLimits.clamp(runCapMin, SettingsLimits.runCap)
        s.keptTabs = SettingsLimits.clamp(keptTabs, SettingsLimits.keptTabs)
        s.snapshotMB = SettingsLimits.clamp(snapshotMB, SettingsLimits.snapshotMB)
        s.soundVolume = SettingsLimits.volume(soundVolume)
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
    var serverSettings: [String: Any] { ["harness": harness.rawValue, "runCapMin": runCapMin] }
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
