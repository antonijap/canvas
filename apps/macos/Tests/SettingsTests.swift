// Tests for SettingsLogic.swift: defaults, persistence in UserDefaults, limits, what the page and the server get,
// and the Shortcuts list built from the menus.
// Run from apps/macos:
//   swiftc -parse-as-library ShellLogic.swift SettingsLogic.swift Tests/SettingsTests.swift -o /tmp/settings-tests && /tmp/settings-tests

import Foundation

@main
struct SettingsTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
        checks += 1
        if !ok { failures += 1; print("FAIL line \(line): \(what())") }
    }

    static func fresh() -> UserDefaults {
        let name = "canvas.settings.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    static func main() {
        defaults(); roundTrip(); limits(); payloads(); shortcuts()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    static func defaults() {
        let s = AppSettings.load(fresh())
        check(s == AppSettings(), "nothing stored: the defaults")
        check(s.harness == .claude, "Claude Code by default")
        check(s.agentCursor, "the agent cursor is on by default")
        check(s.finishSound, "the finish sound is on by default")
        check(s.keptTabs == 3, "three tabs kept alive")
        check(s.snapshotMB == 200, "200 MB of snapshots")
        check(s.runCapMin == 10, "runs stop after 10 minutes")
        check(s.boardLabels && s.openView == .restore && !s.scrollZooms, "canvas defaults")
    }

    static func roundTrip() {
        let d = fresh()
        var s = AppSettings()
        s.openView = .fit; s.scrollZooms = true; s.boardLabels = false
        s.harness = .codex; s.agentCursor = false; s.cursorSpeed = .fast; s.runCapMin = 25
        s.finishSound = false; s.soundVolume = 0.3; s.keptTabs = 5; s.snapshotMB = 400
        s.save(d)
        check(AppSettings.load(d) == s, "every value comes back")
        // Off stays off: a stored false is not mistaken for "never set".
        var off = AppSettings(); off.agentCursor = false; off.finishSound = false; off.boardLabels = false
        off.save(d)
        let back = AppSettings.load(d)
        check(!back.agentCursor && !back.finishSound && !back.boardLabels, "stored false stays false")
        d.set("purple", forKey: AppSettings.prefix + "harness")
        check(AppSettings.load(d).harness == .claude, "an unknown harness falls back")
    }

    static func limits() {
        let d = fresh()
        d.set(0, forKey: AppSettings.prefix + "runCapMin")
        d.set(99, forKey: AppSettings.prefix + "keptTabs")
        d.set(5, forKey: AppSettings.prefix + "snapshotMB")
        d.set(7.0, forKey: AppSettings.prefix + "soundVolume")
        let s = AppSettings.load(d)
        check(s.runCapMin == 1, "run cap at least a minute")
        check(s.keptTabs == 8, "at most 8 tabs alive")
        check(s.snapshotMB == 50, "at least 50 MB")
        check(s.soundVolume == 1, "volume at most 1")
        var t = AppSettings(); t.runCapMin = 500; t.keptTabs = 0; t.soundVolume = .nan
        let c = t.clamped
        check(c.runCapMin == 60 && c.keptTabs == 1 && c.soundVolume == 0.8, "clamped: \(c)")
    }

    static func payloads() {
        var s = AppSettings(); s.cursorSpeed = .slow; s.boardLabels = false; s.harness = .codex; s.runCapMin = 4
        let p = s.pagePrefs
        check(p["boardLabels"] as? Bool == false, "labels")
        check(p["agentCursorSpeed"] as? Double == 0.7, "speed as a multiplier")
        check(p["openView"] as? String == "restore", "open view")
        let json = s.pagePrefsJSON
        check(json.hasPrefix("{") && json.contains("\"agentCursor\":true"), "page JSON: \(json)")
        check(s.serverSettings["harness"] as? String == "codex" && s.serverSettings["runCapMin"] as? Int == 4, "server gets harness and cap")
        check(CursorSpeed.fast.multiplier > CursorSpeed.normal.multiplier && CursorSpeed.normal.multiplier > CursorSpeed.slow.multiplier, "speeds order")
    }

    static func shortcuts() {
        check(ShortcutCatalog.caps(key: "z", mods: [.command, .shift]) == ["⇧", "⌘", "Z"], "Mac modifier order, one cap per key")
        check(ShortcutCatalog.caps(key: "g", mods: [.command, .option]) == ["⌥", "⌘", "G"], "option before command")
        let groups = ShortcutCatalog.menuGroups
        check(groups.first?.title == "Canvas", "menus in menu bar order")
        let all = groups.flatMap(\.rows)
        check(all.contains { $0.title == "Undo" && $0.keys == ["⌘", "Z"] }, "Undo listed")
        check(all.contains { $0.title == "Settings" && $0.keys == ["⌘", ","] }, "Settings listed without its ellipsis")
        check(!all.contains { $0.title == "Delete" }, "items without a key are left out")
        check(!all.contains { $0.title.hasPrefix(">") || $0.title == "<" }, "no submenu markers")
        for g in ShortcutCatalog.all { for r in g.rows { check(!r.keys.isEmpty && r.keys.allSatisfy { !$0.isEmpty }, "\(r.title) has caps") } }
        for sym in ShortcutCatalog.symbols.keys { check(sym.count == 1, "symbol caps are one glyph") }
        let ids = ShortcutCatalog.all.flatMap { g in g.rows.map { g.title + $0.id } }
        check(Set(ids).count == ids.count, "rows unique within their group")
    }
}
