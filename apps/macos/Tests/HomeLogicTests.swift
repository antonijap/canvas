// Tests for HomeLogic.swift: the recents list, comment summaries, card order, filter, search, empty lines, labels, thumbnail keys.
// Run from apps/macos:
//   swiftc -parse-as-library ShellLogic.swift SettingsLogic.swift HomeLogic.swift Tests/HomeLogicTests.swift -o /tmp/home-tests && /tmp/home-tests

import Foundation

@main
struct HomeLogicTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
        checks += 1
        if !ok { failures += 1; print("FAIL line \(line): \(what())") }
    }

    static func main() {
        recents(); comments(); servers(); cards(); empty(); labels(); thumbnails(); cloudFiles()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    static func cloudFiles() {
        for (code, text) in [
            "not_found": "This file was moved to the Trash",
            "read_only": "You can view this file but not edit it",
            "quota": "This Cloud is full",
            "removed": "You no longer have access to this Cloud"
        ] {
            check(CloudFilesText.problem(code: code, fallback: "Could not open the file") == text, "plain error for \(code)")
        }
        check(CloudFilesText.problem(code: "invalid", fallback: "Could not open the file") == "Could not open the file", "unknown errors use the action's fallback")
        check(CloudFilesText.warning(offline: false, usage: [:]) == nil, "missing usage stays silent")
        check(CloudFilesText.warning(offline: false, usage: ["tone": "amber"]) == nil, "tone alone needs no action")
        check(CloudFilesText.warning(offline: false, usage: ["restartsHour": 4]) == "This Cloud keeps restarting. Check the Mac that hosts it.", "restart warning")
        check(CloudFilesText.warning(offline: false, usage: ["freeDisk": Int64(4 * 1024 * 1024 * 1024)]) == "This Mac is almost full. New uploads are paused.", "disk warning")
        check(CloudFilesText.warning(offline: true, usage: [:]) == "This Cloud is offline.", "offline warning")
        check(CloudFilesText.hostUsage(["storageBytes": Int64(1024), "peopleConnected": 1])?.hasSuffix("1 person connected.") == true, "singular person")
        check(CloudFilesText.hostUsage(["storageBytes": Int64(1024), "peopleConnected": 2])?.hasSuffix("2 people connected.") == true, "plural people")
        check(CloudFilesText.hostUsage([:]) == nil, "no invented storage reading")
        check(CloudFilesText.edited("2026-11-20T10:00:00.000Z", now: Date(timeIntervalSince1970: 1795169100)) == "Edited 5 min ago", "timestamp subtitle")
        check(CloudFilesText.edited(nil) == "", "no invented author or edit time")
        check(CloudFilesText.canEdit("owner") && CloudFilesText.canEdit("editor") && !CloudFilesText.canEdit("viewer"), "only editors can create or move")
    }

    static func recents() {
        var l: [RecentEntry] = []
        l = Recents.touch(l, "/a/One.canvas", at: 10)
        l = Recents.touch(l, "/a/Two.canvas", at: 20)
        check(l.map(\.path) == ["/a/Two.canvas", "/a/One.canvas"], "newest first")
        l = Recents.touch(l, "/a/One.canvas", at: 30)
        check(l.map(\.path) == ["/a/One.canvas", "/a/Two.canvas"] && l.count == 2, "opening a file again moves it first and never lists it twice: \(l)")
        check(l[0].opened == 30, "with the new time")
        check(Recents.touch(l, "", at: 40) == l, "an empty path is ignored")
        var many: [RecentEntry] = []
        for i in 0..<80 { many = Recents.touch(many, "/f/\(i).canvas", at: Double(i)) }
        check(many.count == 50 && many[0].path == "/f/79.canvas" && many.last?.path == "/f/30.canvas", "at most 50, the oldest dropped")
        check(Recents.remove(l, "/a/Two.canvas").map(\.path) == ["/a/One.canvas"], "remove")
        check(Recents.remove(l, "/nope").count == 2, "removing a file that is not there changes nothing")
        let moved = Recents.replacing(l, "/a/Two.canvas", with: "/b/Two.canvas")
        check(moved.map(\.path) == ["/a/One.canvas", "/b/Two.canvas"], "Locate keeps the entry")
        let both = Recents.replacing([RecentEntry(path: "/x", opened: 1), RecentEntry(path: "/y", opened: 2)], "/x", with: "/y")
        check(both.count == 1, "a moved file that was already listed does not twice")
        let shuffled = [RecentEntry(path: "/a", opened: 1), RecentEntry(path: "/b", opened: 5), RecentEntry(path: "/a", opened: 9)]
        check(Recents.ordered(shuffled).map(\.path) == ["/a", "/b"] && Recents.ordered(shuffled)[0].opened == 9, "ordered: newest first, one per path")
        // Storage.
        let name = "canvas.home.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        check(Recents.load(d) == nil, "never stored is nil, so the app can seed it")
        Recents.save(l, d)
        check(Recents.load(d) == l, "round trip")
        d.set(Data("not json".utf8), forKey: Recents.key)
        check(Recents.load(d) == [], "a damaged list reads as empty")
        check(Recents.decode(nil).isEmpty, "no data, no list")
    }

    static func comments() {
        func s(_ json: String) -> CommentSummary { CommentsRead.summary(Data(json.utf8)) }
        check(CommentsRead.summary(nil) == CommentSummary(), "no file: nothing")
        check(s("{not json") == CommentSummary(), "damaged: nothing")
        check(s(#"{"format":2,"threads":[]}"#) == CommentSummary(), "another format: nothing")
        let local = s(#"{"format":1,"doc":"d","seq":0,"threads":[{"id":"t1","comments":[]},{"id":"t2","resolvedAt":"2026-01-01T00:00:00Z"},{"id":"t3","deletedAt":"x"},{"id":"t4"}],"outbox":[]}"#)
        check(local.open == 2 && local.server == nil && local.hasComments, "resolved and deleted threads do not count: \(local)")
        let shared = s(#"{"format":1,"doc":"d","seq":4,"server":{"url":"https://studio.workers.dev"},"threads":[{"id":"t1"}],"outbox":[{"op":{"kind":"thread.create","thread":"t9"}},{"op":{"kind":"comment.add","thread":"t1"}},{"op":{"kind":"thread.create","thread":"t1"}}]}"#)
        check(shared.open == 2 && shared.server == "https://studio.workers.dev", "a new thread in the outbox counts, a reply or a repeat does not: \(shared)")
        check(s(#"{"format":1,"doc":"d","seq":0,"threads":[],"outbox":[]}"#) == CommentSummary(open: 0, server: nil, hasComments: false), "an empty file")
        check(s(#"{"format":1,"doc":"d","seq":0,"server":{"url":""},"threads":[],"outbox":[]}"#).server == nil, "an empty server address is none")
    }

    static func servers() {
        check(ServerName.host("https://studio-canvas.workers.dev/") == "studio-canvas.workers.dev", "host")
        check(ServerName.host("http://localhost:8787") == "localhost:8787", "host with a port")
        check(ServerName.display("https://studio-canvas.workers.dev") == "studio-canvas", "workers.dev by its first label")
        check(ServerName.display("https://canvas.example.com") == "canvas.example.com", "any other host whole")
        check(ServerName.same("https://Canvas.Example.com", "https://canvas.example.com/x"), "the same server in another spelling")
        check(!ServerName.same("https://a.example.com", "https://b.example.com") && !ServerName.same("", ""), "different servers; nothing is not a server")
        // The name the person gave the server in Settings > Cloud, else its host.
        check(ServerName.label("https://studio-canvas.workers.dev", name: "Studio team") == "Studio team", "a given name wins")
        check(ServerName.label("https://studio-canvas.workers.dev", name: "  Studio  ") == "Studio", "spaces around a name go")
        check(ServerName.label("https://studio-canvas.workers.dev", name: "") == "studio-canvas", "no name: the host")
        check(ServerName.label("https://canvas.example.com", name: "   ") == "canvas.example.com", "a blank name is no name")
    }

    static func card(_ path: String, opened: Double, modified: Double? = nil, exists: Bool = true, open: Int = 0, server: String? = nil) -> HomeCard {
        HomeCard(path: path, opened: opened, modified: modified, exists: exists, openComments: open, server: server)
    }

    static func cards() {
        let a = card("/a/Pricing page.canvas", opened: 100, server: "https://studio.workers.dev")
        let b = card("/a/App onboarding.canvas", opened: 300)
        let c = card("/a/Brand refresh.canvas", opened: 200, modified: 500, server: "https://studio.workers.dev")
        let gone = card("/a/Gone.canvas", opened: 50, exists: false)
        let all = HomeLogic.ordered([a, b, c, gone])
        check(all.map(\.name) == ["Brand refresh", "App onboarding", "Pricing page", "Gone"], "newest first, an edit counts: \(all.map(\.name))")
        check(HomeLogic.filter(all, .all).count == 4, "All")
        check(HomeLogic.filter(all, .mac).map(\.name) == ["App onboarding", "Gone"], "On this Mac: files not shared")
        check(HomeLogic.filter(all, .servers).map(\.name) == ["Brand refresh", "Pricing page"], "Cloud")
        check(HomeLogic.search(all, "PRIC").map(\.name) == ["Pricing page"], "search by part of the name, any case")
        check(HomeLogic.search(all, "  ").count == 4 && HomeLogic.search(all, "").count == 4, "an empty search shows everything")
        check(HomeLogic.search(all, "brand zzz").isEmpty && HomeLogic.search(all, "refresh brand").map(\.name) == ["Brand refresh"], "every word must match, in any order")
        check(HomeLogic.search(all, "zzz").isEmpty, "no match")
        check(HomeLogic.onServer(all, "https://STUDIO.workers.dev/").count == 2 && HomeLogic.onServer(all, "https://other.example.com").isEmpty, "a server's files")
        // A Cloud's page compares canonical addresses, port included: two development servers on one host are two Clouds.
        let dev1 = card("/a/One.canvas", opened: 1, server: "http://localhost:8787"), dev2 = card("/a/Two.canvas", opened: 2, server: "http://localhost:8788")
        let unsafe = card("/a/Three.canvas", opened: 3, server: "http://localhost.example.com:8787")
        check(HomeLogic.onServer([dev1, dev2, unsafe], "http://localhost:8787").map(\.name) == ["One"], "one port, one Cloud; an unsafe address is on no Cloud's page")
        check(HomeLogic.onServer([dev1], "nonsense").isEmpty, "no page for an address Canvas cannot use")
        let hostedId = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b"
        let joined = card("/a/Four.canvas", opened: 4, server: "canvas-cloud://\(hostedId.uppercased())")
        check(HomeLogic.onServer([joined], "canvas-cloud://\(hostedId)").count == 1, "a hosted Cloud by its id, any case")
        check(gone.shared == false && a.shared, "shared follows the server")
    }

    static func empty() {
        check(HomeLogic.emptyLine(query: "", onServer: false, files: 0) == "Files you open show up here", "no files at all: a first launch")
        check(HomeLogic.emptyLine(query: "", onServer: false, files: 3) == "Nothing here yet", "a view whose files are all elsewhere")
        check(HomeLogic.emptyLine(query: "", onServer: true, files: 3) == "No files shared to this Cloud yet", "a Cloud with nothing shared")
        check(HomeLogic.emptyLine(query: "", onServer: true, files: 0) == "No files shared to this Cloud yet", "a Cloud, even before the first file")
        check(HomeLogic.emptyLine(query: "brand", onServer: true, files: 3) == "No files match \u{201C}brand\u{201D}", "a search that matched nothing wins")
        check(HomeLogic.emptyLine(query: "q", onServer: false, files: 0) == "No files match \u{201C}q\u{201D}", "a search with no files says so too")
        check(!HomeLogic.showsSearch(files: 0, query: ""), "no search field before the first file")
        check(HomeLogic.showsSearch(files: 1, query: ""), "search once there is a file")
        check(HomeLogic.showsSearch(files: 0, query: "old"), "words still typed keep the field, so they can be cleared")
    }

    static func labels() {
        check(HomeLogic.whereLabel(server: nil) == ("This Mac", "laptopcomputer"), "a local file")
        check(HomeLogic.whereLabel(server: "") == ("This Mac", "laptopcomputer"), "an empty address is local")
        check(HomeLogic.whereLabel(server: "https://studio-canvas.workers.dev") == ("studio-canvas", "cloud"), "a shared file names its server")
        let clouds = [CloudEntry(url: "https://studio-canvas.workers.dev", name: "Studio team", kind: .server), CloudEntry(url: "https://ben.workers.dev", name: "Ben's", kind: .server)]
        check(HomeLogic.whereLabel(server: "https://Studio-Canvas.workers.dev/", clouds: clouds) == ("Studio team", "cloud"), "a file on one of the Clouds takes its name")
        check(HomeLogic.whereLabel(server: "https://ben.workers.dev", clouds: clouds) == ("Ben's", "cloud"), "each Cloud its own name")
        check(HomeLogic.whereLabel(server: "https://other.workers.dev", clouds: clouds) == ("other", "cloud"), "a file on a Cloud not in the list keeps that address's host")
        check(HomeLogic.word(status: "connected") == nil && HomeLogic.word(status: nil) == nil, "a Cloud that works, or is not asked yet, says nothing: no green dots")
        check(HomeLogic.word(status: "signedOut")! == ("Sign in", .attention) && HomeLogic.word(status: "signInAgain")!.text == "Sign in", "Sign in, in amber")
        check(HomeLogic.word(status: "down")! == ("Down", .muted) && HomeLogic.word(status: "offline")!.tone == .muted, "Down and Offline, grey")
        check(HomeLogic.word(status: "removed")!.tone == .attention && HomeLogic.word(status: "forbidden")!.text == "No access", "the rest that needs the person")
        check(HomeLogic.rowSymbol(kind: .server) == "cloud" && HomeLogic.rowSymbol(kind: .joined) == "laptopcomputer" && HomeLogic.rowSymbol(kind: .hosted) == "laptopcomputer",
              "the glyph says where a Cloud lives: on a server, or on a Mac")
        check(HomeLogic.cloudName(CloudEntry(url: "https://studio-canvas.workers.dev", kind: .server)) == "studio-canvas", "no name: the host")
        let cal = Calendar(identifier: .gregorian)
        let now = DateComponents(calendar: cal, year: 2026, month: 11, day: 17, hour: 15).date!.timeIntervalSince1970
        func ago(_ s: Double) -> String { HomeLogic.ago(now - s, now: now, calendar: cal) }
        check(ago(10) == "just now" && ago(5 * 60) == "5 min ago" && ago(59 * 60) == "59 min ago", "minutes")
        check(ago(2 * 3600) == "2 h ago", "hours today")
        check(ago(20 * 3600) == "yesterday", "yesterday is the day before, however many hours: \(ago(20 * 3600))")
        check(ago(3 * 86400) == "3 days ago" && ago(8 * 86400) == "last week" && ago(15 * 86400) == "2 weeks ago", "days and weeks")
        check(ago(86400 * 120) == "20 Jul", "a long time ago is a date: \(ago(86400 * 120))")
        check(HomeLogic.whenLabel(opened: now - 3600, modified: now - 300, now: now) == "Edited 5 min ago", "edited after the open")
        check(HomeLogic.whenLabel(opened: now - 300, modified: now - 3600, now: now) == "Opened 5 min ago", "opened after the edit")
        check(HomeLogic.whenLabel(opened: now - 300, modified: now - 290, now: now) == "Opened 5 min ago", "a write within seconds of the open is not an edit")
        check(HomeLogic.whenLabel(opened: now - 300, modified: nil, now: now) == "Opened 5 min ago", "no modified time")
        check(HomeLogic.commentBadge(3) == "3" && HomeLogic.commentBadge(150) == "99+", "badge")
        check(HomeLogic.commentsLine(0) == "None open" && HomeLogic.commentsLine(1) == "1 open", "comments line")
        check(HomeLogic.initial("/a/pricing page.canvas") == "P" && HomeLogic.initial("/a/.canvas") == "C" && HomeLogic.initial("/a/3d.canvas") == "3", "initial")
        check(HomeLogic.connectedLine(email: "anna@studio.com", role: "owner") == "Connected as anna@studio.com, owner", "connected line")
        check(HomeLogic.connectedLine(email: "anna@studio.com", role: nil) == "Connected as anna@studio.com" && HomeLogic.connectedLine(email: nil, role: "owner") == nil, "connected line without a role or email")
        check(HomeLogic.dot(status: "connected", configured: true) == .connected, "green")
        check(HomeLogic.dot(status: "offline", configured: true) == .offline && HomeLogic.dot(status: "connected", configured: false) == .offline, "grey")
        check(HomeLogic.dot(status: "signInAgain", configured: true) == .attention && HomeLogic.dot(status: "signedOut", configured: true) == .attention, "amber")
        check(HomeLogic.dot(status: "down", configured: true) == .down && HomeLogic.dotWords(.down) == "Cloud down", "a hosted Cloud that does not answer reads Cloud down")
        check(ServerName.display("canvas-cloud://3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b") == "Cloud", "a hosted Cloud with no name is called Cloud, never by its id")
        check(HomeLogic.dotWords(.attention) == "Sign in again", "words")
    }

    static func thumbnails() {
        let k = Thumbnails.key("/Users/x/Pricing page.canvas")
        check(k.count == 32 && k.allSatisfy { $0.isHexDigit }, "a hex key: \(k)")
        check(k == Thumbnails.key("/Users/x/Pricing page.canvas") && k != Thumbnails.key("/Users/x/Pricing page 2.canvas"), "stable per path, different per path")
        check(!k.contains("Pricing"), "no file name in the key")
        let u = Thumbnails.url(state: "/state", path: "/Users/x/a.canvas")
        check(u.path == "/state/thumbnails/\(Thumbnails.key("/Users/x/a.canvas")).png" && !u.path.contains(".canvas/"), "in the state folder, not in the package")
    }
}
