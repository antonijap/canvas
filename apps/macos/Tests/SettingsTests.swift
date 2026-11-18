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
        defaults(); roundTrip(); limits(); payloads(); privacy(); shortcuts(); connect(); cloud()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    static func defaults() {
        let s = AppSettings.load(fresh())
        var expected = AppSettings()
        expected.commentName = NSFullUserName()
        check(s == expected, "nothing stored: the defaults, with the Mac's full name as the comment name")
        check(s.serverSettings["commentName"] as? String == NSFullUserName(), "the server gets the name")
        check(s.harness == .claude, "Claude Code by default")
        check(s.agentCursor, "the agent cursor is on by default")
        check(s.finishSound, "the finish sound is on by default")
        check(s.keptTabs == 3, "three tabs kept alive")
        check(s.snapshotMB == 200, "200 MB of snapshots")
        check(s.runCapMin == 10, "runs stop after 10 minutes")
        check(s.claudeModel.isEmpty && s.claudeEffort.isEmpty && s.codexModel.isEmpty && s.codexEffort.isEmpty, "each agent runs its own default model")
        check(s.boardLabels && s.openView == .restore && !s.scrollZooms, "canvas defaults")
    }

    static func roundTrip() {
        let d = fresh()
        var s = AppSettings()
        s.openView = .fit; s.scrollZooms = true; s.boardLabels = false
        s.harness = .codex; s.agentCursor = false; s.cursorSpeed = .fast; s.runCapMin = 25
        s.setModel(.claude, "opus"); s.setEffort(.claude, "high"); s.setModel(.codex, "gpt-a"); s.setEffort(.codex, "xhigh")
        s.finishSound = false; s.soundVolume = 0.3; s.keptTabs = 5; s.snapshotMB = 400; s.commentName = "Ana Test"
        s.save(d)
        check(AppSettings.load(d) == s, "every value comes back")
        let sent = s.serverSettings
        check((sent["claude"] as? [String: String]) == ["model": "opus", "effort": "high"] && (sent["codex"] as? [String: String]) == ["model": "gpt-a", "effort": "xhigh"], "the server gets each agent's model and reasoning")
        // Off stays off: a stored false is not mistaken for "never set".
        var cleared = AppSettings(); cleared.commentName = ""
        cleared.save(d)
        check(AppSettings.load(d).commentName.isEmpty, "a cleared name stays cleared: it is not refilled with the Mac's name")
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

    static func privacy() {
        let s0 = AppSettings.load(fresh())
        check(s0.shareUsage, "Share usage counts is on by default")
        check(!s0.improveCanvas, "Help improve Canvas is off by default")
        let f = s0.usageFacts(version: "0.1.0", commit: "ed205ff", os: "15.2", qa: false)
        check(f["share"] as? Bool == true && f["improve"] as? Bool == false, "default facts: share, no install id")
        check(f["version"] as? String == "0.1.0" && f["commit"] as? String == "ed205ff" && f["os"] as? String == "15.2" && f["qa"] as? Bool == false, "facts: \(f)")
        check(s0.usageFacts(version: "0", commit: nil, os: "15.2", qa: true)["commit"] == nil, "no commit, no key")
        check(s0.usageFacts(version: "0", commit: nil, os: "15.2", qa: true)["qa"] as? Bool == true, "a QA build says so")
        // Off stays off, and improve without share never reaches the server.
        let d = fresh()
        var s = AppSettings(); s.shareUsage = false; s.improveCanvas = true
        s.save(d)
        let back = AppSettings.load(d)
        check(!back.shareUsage && back.improveCanvas, "both stored")
        check(!back.improveEffective, "improve needs share")
        check(back.usageFacts(version: "0", commit: nil, os: "15.2", qa: false)["improve"] as? Bool == false, "the server is told improve off while sharing is off")
        var on = back; on.shareUsage = true
        check(on.usageFacts(version: "0", commit: nil, os: "15.2", qa: false)["improve"] as? Bool == true, "both on: install id")
        check(UsageLinks.privacy.absoluteString == "https://getcanvas.cc/privacy#usage", "the privacy page")
        // The crash marker: set at launch, cleared on quit; still set at the next launch means the last run did not quit.
        let m = fresh()
        check(!RunMarker.launch(m), "first launch: no crash")
        RunMarker.quit(m)
        check(!RunMarker.launch(m), "after a normal quit: no crash")
        check(RunMarker.launch(m), "launched again without quitting: one crash")
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

    static func cloud() {
        check(CloudURL.clean("https://studio-canvas.workers.dev/some/path") == "https://studio-canvas.workers.dev", "an https address keeps only its origin")
        check(CloudURL.clean("  https://Studio.workers.dev  ") == "https://studio.workers.dev", "spaces and case are cleaned")
        check(CloudURL.clean("http://localhost:8787") == "http://localhost:8787", "http on this Mac is allowed, for development")
        check(CloudURL.clean("http://127.0.0.1:8787/x") == "http://127.0.0.1:8787", "127.0.0.1 too")
        check(CloudURL.clean("http://studio.example.com") == nil, "http on another host is refused")
        check(CloudURL.clean("https://user:pw@studio.example.com") == nil, "no credentials in an address")
        check(CloudURL.clean("studio") == nil && CloudURL.clean("") == nil && CloudURL.clean("file:///etc/passwd") == nil, "not an address")
        check(CloudURL.isLocal("http://localhost:8787") && !CloudURL.isLocal("https://studio.workers.dev"), "local means http on this Mac")
        check(CloudURL.host("https://studio.workers.dev/x") == "studio.workers.dev" && CloudURL.host("http://localhost:8787") == "localhost:8787", "the host is the Keychain account")
        check(CloudSetup.compact("") && CloudSetup.compact("  ") && !CloudSetup.compact("https://studio.workers.dev"), "the short Cloud pane shows only while no address is saved")
        hosted()
        check(CloudSetup.hint("") == nil && CloudSetup.hint("https://studio.workers.dev") == nil, "no hint while the field is empty or valid")
        check(CloudSetup.hint("studio") == "Use an https address, like https://studio.workers.dev", "an invalid address says what to type")
        check(CloudSetup.next("studio", devEmail: "") == nil, "Sign in is off until the address is valid")
        check(CloudSetup.next("https://studio.workers.dev", devEmail: "") == .signIn, "a team server signs in at once")
        check(CloudSetup.next("http://localhost:8787", devEmail: "") == .askEmail, "a local server asks for the development email first")
        check(CloudSetup.next("http://localhost:8787", devEmail: "anna@studio.test") == .signIn, "a local server with an email signs in")
        var s = AppSettings()
        s.cloudUrl = "https://studio.workers.dev/x"; s.cloudDevEmail = "anna@studio.test"
        check(s.serverSettings["cloudUrl"] as? String == "https://studio.workers.dev", "the server gets the cleaned address")
        check(s.serverSettings["cloudDevEmail"] as? String == "", "and no development email for a real server")
        s.cloudUrl = "http://localhost:8787"
        check(s.serverSettings["cloudDevEmail"] as? String == "anna@studio.test", "a local server gets it")
        s.cloudUrl = "nonsense"
        check(s.serverSettings["cloudUrl"] as? String == "", "a bad address is not sent")
        let d = fresh()
        s.cloudUrl = "https://studio.workers.dev"; s.save(d)
        check(AppSettings.load(d).cloudUrl == "https://studio.workers.dev", "the address is stored")
        check(AppSettings().cloudName == "" && AppSettings.load(fresh()).cloudName == "", "a server has no name until one is given")
        s.cloudName = "Studio team"; s.save(d)
        check(AppSettings.load(d).cloudName == "Studio team", "the server's name is stored with its address")
        s.cloudName = String(repeating: "a", count: 200)
        check(s.clamped.cloudName.count == SettingsLimits.serverName, "a long name is cut to \(SettingsLimits.serverName) characters")
        check(CloudStatusText.line("connected", configured: true) == "Connected" && CloudStatusText.line("offline", configured: true) == "Offline", "status lines")
        check(CloudStatusText.line("signedOut", configured: true) == "Signed out" && CloudStatusText.line("signInAgain", configured: true) == "Sign in again", "signed out and sign in again")
        check(CloudStatusText.line("tooOld", configured: true) == "The server is too old", "a server too old")
        check(CloudStatusText.account(email: "anna@studio.com", role: "owner") == "Signed in as anna@studio.com, owner", "who is signed in")
        check(CloudStatusText.account(email: nil, role: nil) == nil, "nobody")
    }

    static func connect() {
        check(ConnectCopy.button(installed: true, registered: false, busy: false) == "Connect", "installed, not added: Connect")
        check(ConnectCopy.button(installed: true, registered: false, busy: true) == "Connecting\u{2026}", "while the CLI runs")
        check(ConnectCopy.button(installed: true, registered: true, busy: false) == "Added", "registered for this app: Added")
        check(ConnectCopy.button(installed: false, registered: false, busy: false) == nil, "not installed: no button, Copy only")
        check(ConnectCopy.otherApps == "Other apps: getcanvas.cc/download#connect", "the line under the Agents card")
        check(ConnectCopy.otherAppsURL.absoluteString == "https://getcanvas.cc/download#connect", "the download page's connect section")
        check(ConnectCopy.added("Codex") == "Added. Start a new Codex session.", "the next step")
    }
}

extension SettingsTests {
    /// A Cloud hosted on a Mac: known by its id, never an http address to another host; invites parsed strictly.
    static func hosted() {
        let id = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b"
        check(CloudURL.clean("canvas-cloud://\(id)") == "canvas-cloud://\(id)", "a hosted Cloud by its id")
        check(CloudURL.clean("CANVAS-CLOUD://\(id.uppercased())") == "canvas-cloud://\(id)", "any case")
        check(CloudURL.clean("canvas-cloud://studio-mac.local") == nil && CloudURL.clean("canvas-cloud://\(id):5190") == nil, "only an id")
        check(CloudURL.isHosted("canvas-cloud://\(id)") && !CloudURL.isHosted("https://studio.workers.dev") && !CloudURL.isLocal("canvas-cloud://\(id)"), "hosted is its own kind, never local development")
        for lan in ["http://192.168.1.20:5190", "http://studio-mac.local:5190", "http://100.101.102.103:5190", "http://studio-mac.tail1234.ts.net:5190", "http://10.0.0.5", "http://0.0.0.0:5190"] {
            check(CloudURL.clean(lan) == nil, "no plain http to another host: \(lan)")
        }
        let tc = "tc" + String(repeating: "A", count: 60), code = "ccj_0123456789abcdef." + String(repeating: "b", count: 43)
        func link(_ q: [String: String]) -> String {
            var c = URLComponents(string: "canvas://cloud/join")!
            c.queryItems = q.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
            return c.string!
        }
        let good = ["v": "1", "name": "Studio Cloud", "host": id, "tc": tc, "code": code]
        let i = CloudInvite.parse(link(good))
        check(i?.name == "Studio Cloud" && i?.hostId == id && i?.addr == tc && i?.code == code, "an invite link is read")
        check(i?.fingerprint == "3956-A61F", "the fingerprint is the one the server shows (src/cloud-tunnel.ts)")
        check(CloudInvite.parse(link(good.merging(["name": ""]) { $1 }))?.name == "Cloud", "no name: Cloud")
        let other = CloudInvite.confirmText(i!, current: "https://studio.workers.dev", currentName: "Studio team")
        check(other.contains("This replaces Studio team as this Mac\u{2019}s Cloud.") && other.contains("3956-A61F"), "the question says plainly when an invite replaces this Mac's Cloud")
        check(!CloudInvite.confirmText(i!, current: nil, currentName: "").contains("replaces"), "and says nothing of it when there is none")
        check(CloudInvite.confirmText(i!, current: "canvas-cloud://\(id)", currentName: "Studio Cloud").contains("already in this Cloud"), "joining the same Cloud again says so")
        check(CloudInvite.parse(link(good.merging(["v": "2"]) { $1 })) == nil, "another version")
        check(CloudInvite.parse(link(good.merging(["host": "studio-mac"]) { $1 })) == nil, "a host that is not an id")
        check(CloudInvite.parse(link(good.merging(["tc": "http://192.168.1.20"]) { $1 })) == nil, "an address that is not a tunnel")
        check(CloudInvite.parse(link(good.merging(["code": "ccd_0123456789abcdef." + String(repeating: "b", count: 43)]) { $1 })) == nil, "a device token is not a join code")
        check(CloudInvite.parse(link(good).replacingOccurrences(of: "canvas://cloud/join", with: "canvas://open")) == nil, "only canvas://cloud/join")
        check(CloudStatusText.line("down", configured: true) == "Cloud down" && CloudStatusText.detail("down", name: "Studio Cloud") == "Studio Cloud isn\u{2019}t open right now", "Cloud down, in one plain line")
        check(CloudDisclosure.lines.count == 4 && CloudDisclosure.lines.allSatisfy { !$0.contains("\u{2014}") && !$0.contains("\u{00B7}") }, "the disclosure, plain")
        var s = AppSettings()
        let d = fresh()
        s.cloudHosting = true; s.save(d)
        check(AppSettings.load(d).cloudHosting && !AppSettings.load(fresh()).cloudHosting, "hosting is remembered, off by default")
        s.cloudUrl = "canvas-cloud://\(id)"
        check(s.serverSettings["cloudUrl"] as? String == "canvas-cloud://\(id)" && s.serverSettings["cloudDevEmail"] as? String == "", "the server gets the hosted Cloud's id and no development email")
    }
}
