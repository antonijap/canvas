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
        defaults(); roundTrip(); limits(); payloads(); privacy(); shortcuts(); connect(); cloud(); migration(); reviewFixes(); hostingKept(); adapters(); windowFit()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    static func windowFit() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 875)
        let w = CGRect(x: 400, y: 300, width: 560, height: 400)
        let grown = SettingsWindowFit.frame(current: w, chrome: 80, content: 500, visible: screen)
        check(grown.height == 580 && grown.maxY == w.maxY && grown.minX == w.minX, "a taller pane grows the window down, top edge kept")
        let shrunk = SettingsWindowFit.frame(current: w, chrome: 80, content: 200, visible: screen)
        check(shrunk.height == 280 && shrunk.maxY == w.maxY, "a shorter pane shrinks it, top edge kept")
        let tall = SettingsWindowFit.frame(current: w, chrome: 80, content: 3000, visible: screen)
        check(tall.height == 875 && tall.minY == 0 && tall.maxY == 875, "never taller than the screen: the pane scrolls")
        let low = SettingsWindowFit.frame(current: CGRect(x: 0, y: 50, width: 560, height: 200), chrome: 80, content: 500, visible: screen)
        check(low.minY == 0 && low.height == 580, "near the bottom it moves up to stay on screen")
        check(SettingsWindowFit.frame(current: w, chrome: 80, content: 500, visible: nil).height == 580, "no screen: no cap")
        let narrow = CGRect(x: 400, y: 300, width: 500, height: 400)
        check(SettingsWindowFit.frame(current: narrow, chrome: 80, content: 500, width: 560, visible: screen).width == 560, "the window takes the pane's width, whatever width it had")
    }

    static func adapters() {
        let id = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b"
        let server = CloudEntry(url: "https://team.example.com", kind: .server)
        let local = CloudEntry(url: "http://localhost:8787", kind: .server)
        let hosted = CloudEntry(url: "canvas-cloud://\(id)", kind: .hosted)
        let joined = CloudEntry(url: hosted.url, kind: .joined)
        check(server.adapterAlpha && local.adapterAlpha, "Cloudflare servers, including local development, get Alpha")
        check(!hosted.adapterAlpha && !joined.adapterAlpha, "Mac hosted and joined Clouds get no badge")
        check(server.adapterTooltip == "Cloudflare adapter, Alpha", "the sidebar explains the adapter")
        check(hosted.adapterTooltip.isEmpty && joined.adapterTooltip.isEmpty, "Mac Clouds have no Alpha tooltip")
        check(CloudList.hostLimit(99) == 8 && CloudList.hostLimit(0) == 1 && CloudList.hostLimit(nil) == 8, "the server limit is clamped to one through eight")
        check(CloudList.hostedIds([hosted, hosted], known: [id]).count == 1, "the hosting limit counts host ids once")
        let other = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
        check(CloudList.hostedIds([hosted], known: [other]).count == 2, "shell and server hosting ids are combined")
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
        var anonymous = AppSettings()
        anonymous.commentName = "Anna"
        anonymous.showWhiteboardName = false
        anonymous.save(d)
        let restored = AppSettings.load(d)
        check(restored.pagePrefs["whiteboardName"] as? String == "", "the canvas receives no name when the whiteboard setting is off")
        check(restored.commentName == "Anna" && !restored.showWhiteboardName, "the setting leaves the comment name in place")
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
        clouds()
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
        check(ConnectCopy.added("Codex") == "Added. New Codex sessions use it; restart any that are open.", "the next step, and that sessions already open must restart")
        check(ConnectCopy.outdated == "Connected (older version, restart your agent session)", "an MCP from before an update")
        check(ConnectCopy.status(["outdated": true]) == ConnectCopy.outdated, "an older MCP of this copy: restart")
        check(ConnectCopy.status(["otherCopy": true]) == "Connected (an agent runs another copy of Canvas)", "another copy's MCP: no restart advice")
        check(ConnectCopy.status(["connected": true]) == nil && ConnectCopy.status([:]) == nil, "a current MCP or none: no line")
        check(!ConnectCopy.outdated.contains("\u{2014}") && !ConnectCopy.added("Codex").contains("\u{2014}"), "no em dash")
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
        check(CloudInvite.parse(link(good).replacingOccurrences(of: "Studio%20Cloud", with: "Studio+Cloud"))?.name == "Studio Cloud", "form-encoded spaces in invite names")
        check(CloudInvite.parse(link(good.merging(["name": "Studio+Review"]) { $1 }).replacingOccurrences(of: "Studio+Review", with: "Studio%2BReview"))?.name == "Studio+Review", "escaped plus in invite names")
        check(i?.fingerprint == "3956-A61F", "the fingerprint is the one the server shows (src/cloud-tunnel.ts)")
        check(CloudInvite.parse(link(good.merging(["name": ""]) { $1 }))?.name == "Cloud", "no name: Cloud")
        check(i!.fingerprintLine.contains("3956-A61F"), "the fingerprint to compare is said before joining")
        let server = CloudEntry(url: "https://studio.workers.dev", kind: .server)
        check(CloudInvite.check(i!, list: [server]) == .ok, "joining adds a Cloud: the others stay")
        let joined = CloudEntry(id: "j1", url: "canvas-cloud://\(id)", kind: .joined)
        check(CloudInvite.check(i!, list: [server, joined]) == .already(id: "j1"), "never the same Cloud twice")
        check(CloudInvite.check(i!, list: [CloudEntry(url: "canvas-cloud://\(id)", kind: .hosted)]) == .hostsIt, "never a Cloud this Mac hosts")
        check(CloudInvite.check(i!, list: [], hostedIds: [id]) == .hostsIt, "nor one it hosts that is not in the list")
        check(CloudInvite.parse(link(good.merging(["v": "2"]) { $1 })) == nil, "another version")
        check(CloudInvite.parse(link(good.merging(["host": "studio-mac"]) { $1 })) == nil, "a host that is not an id")
        check(CloudInvite.parse(link(good.merging(["tc": "http://192.168.1.20"]) { $1 })) == nil, "an address that is not a tunnel")
        check(CloudInvite.parse(link(good.merging(["code": "ccd_0123456789abcdef." + String(repeating: "b", count: 43)]) { $1 })) == nil, "a device token is not a join code")
        check(CloudInvite.parse(link(good).replacingOccurrences(of: "canvas://cloud/join", with: "canvas://open")) == nil, "only canvas://cloud/join")
        check(CloudStatusText.line("down", configured: true) == "Cloud down" && CloudStatusText.detail("down", name: "Studio Cloud") == "Studio Cloud isn\u{2019}t open right now", "Cloud down, in one plain line")
        check(CloudDisclosure.lines.count == 4 && CloudDisclosure.lines.allSatisfy { !$0.contains("\u{2014}") && !$0.contains("\u{00B7}") }, "the disclosure, plain")
        check(CloudDisclosure.lines.joined(separator: " ").contains("Everyone in this Cloud can open its files"), "joining discloses file visibility")
        var s = AppSettings()
        s.clouds = [CloudEntry(url: "canvas-cloud://\(id)", name: "Studio", devEmail: "anna@studio.test", kind: .hosted, hosting: true)]
        let sent = s.serverSettings["clouds"] as? [[String: String]]
        check(sent == [["url": "canvas-cloud://\(id)", "devEmail": ""]], "the server gets the hosted Cloud's id and no development email: \(String(describing: sent))")
        let d = fresh()
        s.save(d)
        check(AppSettings.load(d).clouds.first?.hosting == true, "hosting is remembered per Cloud")
    }
}

extension SettingsTests {
    /// The list of Clouds: what the server gets, limits, storage, and many of each kind (one per client, one per team).
    static func clouds() {
        var s = AppSettings()
        s.clouds = [CloudEntry(url: "https://studio.workers.dev/x", devEmail: "anna@studio.test", kind: .server),
                    CloudEntry(url: "http://localhost:8787", devEmail: "anna@studio.test", kind: .server),
                    CloudEntry(url: "nonsense", kind: .server)]
        s.cloudsRev = 7
        let sent = s.serverSettings["clouds"] as? [[String: String]]
        check(sent == [["url": "https://studio.workers.dev", "devEmail": ""], ["url": "http://localhost:8787", "devEmail": "anna@studio.test"]],
              "the server gets cleaned addresses, an email only for a local server, nothing for a bad address: \(String(describing: sent))")
        check(s.serverSettings["cloudsRev"] as? Int == 7, "with the list's revision")
        check(s.serverSettings["cloudUrl"] == nil && s.serverSettings["cloudDevEmail"] == nil, "and none of the single-Cloud keys")
        let d = fresh()
        s.save(d)
        let back = AppSettings.load(d)
        check(back.clouds.map(\.url) == ["https://studio.workers.dev", "http://localhost:8787"] && back.cloudsRev == 7, "the list and its revision are stored")
        check(back.clouds.map(\.id) == s.clouds.prefix(2).map(\.id), "ids survive a restart")
        check(AppSettings().clouds.isEmpty && AppSettings.load(fresh()).clouds.isEmpty, "no Clouds until one is added")
        // Many of each kind: 35 servers and several hosted Clouds at once.
        var many = (0..<35).map { CloudEntry(url: "https://client\($0).example.com", kind: .server) }
        let ids = ["3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b", "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e"]
        many += ids.map { CloudEntry(url: "canvas-cloud://\($0)", name: "Team", kind: .hosted, hosting: true) }
        let clean = CloudList.clean(many)
        check(clean.count == 38 && CloudList.hosted(clean).count == 3 && CloudList.hosted(clean).allSatisfy(\.hosting), "35 servers and 3 hosted Clouds, all kept: \(clean.count)")
        check(CloudList.clean((0..<250).map { CloudEntry(url: "https://t\($0).example.com", kind: .server) }).count == SettingsLimits.clouds, "at most \(SettingsLimits.clouds)")
        check(CloudList.clean([CloudEntry(url: "https://a.example.com", kind: .server), CloudEntry(url: "https://A.example.com/x", kind: .server)]).count == 1, "one entry per address")
        let fixed = CloudList.clean([CloudEntry(url: "https://a.example.com", name: String(repeating: "a", count: 200), devEmail: "anna@studio.test", kind: .hosted, hosting: true)])
        check(fixed[0].name.count == SettingsLimits.serverName && fixed[0].devEmail == "" && fixed[0].kind == .server && !fixed[0].hosting, "names cut, no email or hosting for an https server")
        check(CloudList.clean([CloudEntry(url: "canvas-cloud://\(ids[0])", kind: .server)])[0].kind == .joined, "a hosted address is never a server")
        check(clean.first { $0.kind == .hosted }?.hostId == ids[0], "a hosted Cloud's id")
        // Adding.
        guard let (one, e) = CloudList.add([], url: "https://Studio.workers.dev/", name: "  Studio  ", kind: .server) else { check(false, "add"); return }
        check(one.count == 1 && e.url == "https://studio.workers.dev" && e.name == "Studio", "added, cleaned")
        let again = CloudList.add(one, url: "https://studio.workers.dev", name: "Studio team", kind: .server)
        check(again?.list.count == 1 && again?.entry.id == e.id && again?.entry.name == "Studio team", "the same address finds the entry and takes the new name")
        check(CloudList.add(one, url: "http://studio.example.com", kind: .server) == nil, "no plain http to another host")
        check(CloudList.add((0..<SettingsLimits.clouds).map { CloudEntry(url: "https://t\($0).example.com", kind: .server) }, url: "https://new.example.com", kind: .server) == nil, "a full list takes no more")
        let hosted = CloudList.add(one, url: "canvas-cloud://\(ids[0])", kind: .hosted)
        let hosted2 = hosted.flatMap { CloudList.add($0.list, url: "canvas-cloud://\(ids[1])", kind: .hosted) }
        check(hosted2.map { CloudList.hosted($0.list).count } == 2, "a second hosted Cloud is its own entry")
        check(CloudList.remove(one, id: e.id).isEmpty, "removed by id")
        // Lists by name, filtered.
        let named = [CloudEntry(url: "https://b.example.com", name: "birch", kind: .server), CloudEntry(url: "https://a.example.com", name: "Acme", kind: .server), CloudEntry(url: "https://c.example.com", name: "Cobalt labs", kind: .server)]
        check(CloudList.filtered(named, query: "", name: { $0.name }).map(\.name) == ["Acme", "birch", "Cobalt labs"], "by name, any case")
        check(CloudList.filtered(named, query: "LABS co", name: { $0.name }).map(\.name) == ["Cobalt labs"], "every word, any order")
        let clients = (1...35).map { CloudEntry(url: "https://client\($0).example.com", name: String(format: "Client %02d", $0), kind: .server) }
        check(CloudList.filtered(clients, query: "client 3", name: { $0.name }).map(\.name) == ["Client 03", "Client 13", "Client 23", "Client 30", "Client 31", "Client 32", "Client 33", "Client 34", "Client 35"], "each query word is a substring, including digits inside a name")
        // Sharing: only Clouds that are connected with an owner or editor role can take a file.
        let st: [String: (status: String, role: String?)] = ["https://b.example.com": ("connected", "editor"), "https://a.example.com": ("connected", "commenter"), "https://c.example.com": ("signedOut", nil)]
        check(CloudShare.candidates(named, status: st).map(\.name) == ["birch"], "who can take a file")
    }

    /// The single Cloud of an older version moves into the list once, written before the old keys go.
    static func migration() {
        let id = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b"
        let k = { (n: String) in AppSettings.prefix + n }
        let d = fresh()
        d.set("https://Studio.workers.dev/x", forKey: k("cloudUrl")); d.set("Studio team", forKey: k("cloudName")); d.set("anna@studio.test", forKey: k("cloudDevEmail"))
        let s = AppSettings.load(d)
        check(s.clouds.count == 1 && s.clouds[0].url == "https://studio.workers.dev" && s.clouds[0].name == "Studio team" && s.clouds[0].kind == .server, "the old Cloud is in the list, its name kept")
        check(s.clouds[0].devEmail == "", "a dev email only for a local address")
        check(d.object(forKey: k("clouds")) != nil, "the list is written at once")
        check(CloudList.legacyKeys.allSatisfy { d.object(forKey: k($0)) == nil }, "and only then the old keys go")
        let restart = AppSettings.load(d)
        check(restart.clouds == s.clouds, "a restart reads the same list, same id, nothing moved twice")
        // An empty list is a list: the old keys coming back (an older version run in between) move nothing.
        var none = restart
        none.clouds = []
        none.save(d)
        d.set("https://other.example.com", forKey: k("cloudUrl"))
        check(AppSettings.load(d).clouds.isEmpty, "removing every Cloud stays removed")
        // A local server keeps its email; a hosted Cloud moves as hosted while hosting was on, else as joined.
        let l = fresh()
        l.set("http://localhost:8787", forKey: k("cloudUrl")); l.set("anna@studio.test", forKey: k("cloudDevEmail"))
        check(AppSettings.load(l).clouds.first?.devEmail == "anna@studio.test", "a local server's email moves with it")
        let h = fresh()
        h.set("canvas-cloud://\(id)", forKey: k("cloudUrl")); h.set(true, forKey: k("cloudHosting"))
        let hs = AppSettings.load(h).clouds
        check(hs.first?.kind == .joined && hs.first?.hosting == false && hs.first?.hostId == id, "an old address waits for the server to identify which Cloud this Mac hosted")
        let j = fresh()
        j.set("canvas-cloud://\(id)", forKey: k("cloudUrl"))
        check(AppSettings.load(j).clouds.first?.kind == .joined, "a hosted address without hosting was joined")
        check(AppSettings.load(fresh()).clouds.isEmpty, "nothing to move: no Clouds")
    }
}

extension SettingsTests {
    /// Fixes from the review of many Clouds: a hosted Cloud an older version left is never lost, the share question
    /// never picks a Cloud that was not chosen, Delete says when it failed, and a share reports where things stand.
    static func reviewFixes() {
        let mine = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b", theirs = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
        let k = { (n: String) in AppSettings.prefix + n }
        // An older version hosted a Cloud and then joined another: the address named the joined one, hosting stayed on.
        let d = fresh()
        d.set("canvas-cloud://\(theirs)", forKey: k("cloudUrl")); d.set(true, forKey: k("cloudHosting"))
        let moved = AppSettings.load(d).clouds
        check(d.bool(forKey: k(CloudList.legacyHostingKey)), "hosting being on is remembered until the server says which Cloud it was")
        let fixed = CloudList.reconcile(moved, hosted: [HostedInfo(hostId: mine, name: "Studio", hosting: false, legacy: true)], legacyHosting: true)
        check(fixed.first { $0.hostId == theirs }?.kind == .joined, "the joined Cloud stays joined")
        let own = fixed.first { $0.hostId == mine }
        check(own?.kind == .hosted && own?.name == "Studio" && own?.hosting == true, "the Cloud this Mac hosted is added, and starts again: \(String(describing: own))")
        // A stopped hosted Cloud (an older Stop cleared the address but kept its data): listed, added, not started.
        let stopped = CloudList.reconcile([], hosted: [HostedInfo(hostId: mine, name: "", hosting: false, legacy: true)], legacyHosting: false)
        check(stopped.count == 1 && stopped[0].kind == .hosted && !stopped[0].hosting && stopped[0].name == "Cloud", "a stopped hosted Cloud gets its entry, off")
        check(CloudList.reconcile(stopped, hosted: [HostedInfo(hostId: mine, name: "", hosting: false, legacy: true)], legacyHosting: false) == stopped, "and only once")
        let server = CloudEntry(url: "https://studio.workers.dev", kind: .server)
        check(CloudList.reconcile([server], hosted: [], legacyHosting: false) == [server], "servers are left alone")
        // The share question: two Clouds called "Cloud" are two items, each the Cloud it names.
        let two = [CloudEntry(url: "canvas-cloud://\(mine)", kind: .hosted), CloudEntry(url: "canvas-cloud://\(theirs)", kind: .joined), server]
        let titles = CloudShare.titles(two, name: { _ in "Cloud" }, detail: { $0.hostId.map { String($0.prefix(4)) } ?? "server" })
        check(Set(titles).count == 3, "never two items alike: \(titles)")
        check(titles == ["Cloud (3f2b)", "Cloud (9a8b)", "Cloud (server)"], "a repeated name gets where it lives: \(titles)")
        check(CloudShare.titles(two, name: { _ in "Same" }, detail: { _ in "x" }) == ["Same (x)", "Same (x) 2", "Same (x) 3"], "and a number when that repeats too")
        // Delete or Remove: a failure keeps the Cloud and says why.
        check(CloudRemoval.problem(wipe: (200, nil), remove: (200, nil)) == nil, "both worked")
        check(CloudRemoval.problem(wipe: nil, remove: (200, nil)) == nil, "nothing to delete, removed")
        check(CloudRemoval.problem(wipe: (400, "Could not delete the Cloud's data on this Mac"), remove: (200, nil)) == "Could not delete the Cloud's data on this Mac", "a failed delete says so")
        check(CloudRemoval.problem(wipe: (200, nil), remove: (0, nil)) == "Could not remove the Cloud", "no answer is a failure too")
        // A share's toast: an already shared file says where its Cloud stands.
        check(CloudShare.message(already: false, name: "Studio", status: "connected") == ("Comments shared to Studio", true), "shared")
        check(CloudShare.message(already: true, name: "Studio", status: "connected") == ("Already shared. Connected to Studio", true), "already, connected")
        check(CloudShare.message(already: true, name: "Studio", status: "signInAgain") == ("Already shared to Studio. Sign in again", false), "already, but signed out: no claim it connected")
        check(CloudShare.message(already: true, name: "Studio", status: "down").text == "Already shared to Studio. Cloud down", "already, down")
    }
}

extension SettingsTests {
    /// A Cloud hosted on this Mac starts again with Canvas: the saved entry has to learn that it is running.
    static func hostingKept() {
        let id = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b"
        let saved = CloudEntry(url: "canvas-cloud://\(id)", name: "Studio", kind: .hosted, hosting: false)
        let running = CloudList.reconcile([saved], hosted: [HostedInfo(hostId: id, name: "Studio", hosting: true, legacy: true)], legacyHosting: false)
        check(running.count == 1 && running[0].id == saved.id && running[0].hosting, "a hosted entry the server runs is saved as hosting: \(running)")
        let off = HostedInfo(hostId: id, name: "Studio", hosting: false, legacy: true)
        check(CloudList.reconcile([saved], hosted: [off], legacyHosting: false) == [saved], "a stopped Cloud stays stopped")
        // Quit and relaunch: the server's Cloud is down then, which must not clear what was saved.
        check(CloudList.reconcile(running, hosted: [off], legacyHosting: false) == running, "a Cloud that was hosting is still saved as hosting")
    }
}
