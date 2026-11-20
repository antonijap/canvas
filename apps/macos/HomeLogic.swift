// The Home tab's logic, without any view: the recents list, what a file's comments.json says (open comments and the
// team server it is shared to), the cards' order, filter and search, the labels, and where a thumbnail is kept.
// Tests/HomeLogicTests.swift runs all of it (built with SettingsLogic.swift, for the Cloud addresses). Home.swift draws it.

import CryptoKit
import Foundation

/// Copy shared by the Cloud file page, its actions and the host's settings.
enum CloudFilesText {
    static func canEdit(_ role: String) -> Bool { role == "owner" || role == "editor" }

    static func problem(code: String?, fallback: String) -> String {
        switch code {
        case "not_found": return "This file was moved to the Trash"
        case "read_only": return "You can view this file but not edit it"
        case "quota": return "This Cloud is full"
        case "removed": return "You no longer have access to this Cloud"
        default: return fallback
        }
    }

    static func warning(offline: Bool, usage: [String: Any]) -> String? {
        if offline { return "This Cloud is offline." }
        if usage["brake"] as? String == "storage" || (usage["freeDisk"] as? Int64).map({ $0 < 5 * 1024 * 1024 * 1024 }) == true {
            return "This Mac is almost full. New uploads are paused."
        }
        if (usage["restartsHour"] as? Int ?? 0) > 3 { return "This Cloud keeps restarting. Check the Mac that hosts it." }
        return nil
    }

    static func hostUsage(_ usage: [String: Any]) -> String? {
        guard let bytes = usage["storageBytes"] as? Int64, let people = usage["peopleConnected"] as? Int else { return nil }
        let stored = ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
        return "\(stored) of files. \(people) \(people == 1 ? "person" : "people") connected."
    }

    /// The host records edit time, but does not yet record the last editor's name.
    static func edited(_ timestamp: String?, now: Date = Date()) -> String {
        guard let timestamp else { return "" }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = iso.date(from: timestamp)
        if date == nil { iso.formatOptions = [.withInternetDateTime]; date = iso.date(from: timestamp) }
        guard let date else { return "" }
        return "Edited " + HomeLogic.ago(date.timeIntervalSince1970, now: now.timeIntervalSince1970)
    }
}

/// One file the person opened: its path and when (seconds since 1970).
struct RecentEntry: Codable, Equatable {
    var path: String
    var opened: Double
}

enum Recents {
    /// The most files the list keeps.
    static let cap = 50
    static let key = "canvas.recents"

    /// `path` opened at `at`: it goes first, and the file's older entry goes. Never more than `cap`.
    static func touch(_ list: [RecentEntry], _ path: String, at: Double, cap: Int = Recents.cap) -> [RecentEntry] {
        guard !path.isEmpty else { return list }
        let rest = list.filter { $0.path != path }
        return Array(([RecentEntry(path: path, opened: at)] + rest).prefix(cap))
    }

    /// Newest first, whatever order they were stored in; one entry per path (the newest).
    static func ordered(_ list: [RecentEntry]) -> [RecentEntry] {
        var seen = Set<String>()
        return list.sorted { $0.opened > $1.opened }.filter { seen.insert($0.path).inserted }
    }

    static func remove(_ list: [RecentEntry], _ path: String) -> [RecentEntry] { list.filter { $0.path != path } }

    /// A file moved by Locate: its entry follows it.
    static func replacing(_ list: [RecentEntry], _ old: String, with new: String) -> [RecentEntry] {
        var seen = Set<String>()
        return list.map { $0.path == old ? RecentEntry(path: new, opened: $0.opened) : $0 }.filter { seen.insert($0.path).inserted }
    }

    static func decode(_ data: Data?) -> [RecentEntry] {
        guard let data, let list = try? JSONDecoder().decode([RecentEntry].self, from: data) else { return [] }
        return Array(ordered(list).prefix(cap))
    }
    static func encode(_ list: [RecentEntry]) -> Data? { try? JSONEncoder().encode(Array(ordered(list).prefix(cap))) }

    static func load(_ d: UserDefaults = .standard) -> [RecentEntry]? {
        d.object(forKey: key) == nil ? nil : decode(d.data(forKey: key))
    }
    static func save(_ list: [RecentEntry], _ d: UserDefaults = .standard) { d.set(encode(list), forKey: key) }
}

/// What comments.json says about a file: the open threads (not resolved, not deleted, the ones still in the outbox
/// included) and the server it is shared to.
struct CommentSummary: Equatable {
    var open = 0
    var server: String?
    var hasComments = false
}

enum CommentsRead {
    /// The biggest comments.json Home reads for a card (the server's own limit is far above this; a bigger one shows no count).
    static let maxBytes = 8 * 1024 * 1024

    static func summary(_ data: Data?) -> CommentSummary {
        guard let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], (j["format"] as? Int) == 1,
              let threads = j["threads"] as? [[String: Any]] else { return CommentSummary() }
        var ids = Set<String>()
        var open = 0
        for t in threads {
            if let id = t["id"] as? String { ids.insert(id) }
            if t["resolvedAt"] == nil && t["deletedAt"] == nil { open += 1 }
        }
        // A thread made here and not yet sent lives in the outbox as a thread.create op.
        for e in j["outbox"] as? [[String: Any]] ?? [] {
            if let op = e["op"] as? [String: Any], op["kind"] as? String == "thread.create", let id = op["thread"] as? String, ids.insert(id).inserted { open += 1 }
        }
        let server = (j["server"] as? [String: Any])?["url"] as? String
        return CommentSummary(open: open, server: (server?.isEmpty ?? true) ? nil : server, hasComments: !threads.isEmpty || !ids.isEmpty)
    }
}

/// How a team server is named on screen.
enum ServerName {
    /// The host of an address, without a scheme or path: "studio-canvas.workers.dev". Anything unreadable stays as typed.
    static func host(_ url: String) -> String {
        guard let c = URLComponents(string: url.trimmingCharacters(in: .whitespaces)), let h = c.host, !h.isEmpty else { return url }
        return c.port.map { "\(h):\($0)" } ?? h
    }
    /// The short name in lists: a workers.dev address by its first label, a hosted Cloud as "Cloud", any other host whole.
    static func display(_ url: String) -> String {
        if url.lowercased().hasPrefix("canvas-cloud://") { return "Cloud" }
        let h = host(url)
        if h.hasSuffix(".workers.dev"), let first = h.split(separator: ".").first { return String(first) }
        return h
    }
    /// What the server is called on screen: the name given in Settings > Cloud, else its host as `display` gives it.
    static func label(_ url: String, name: String) -> String {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? display(url) : n
    }
    /// The same server, whatever the case, scheme or trailing slash.
    static func same(_ a: String, _ b: String) -> Bool { host(a).lowercased() == host(b).lowercased() && !host(a).isEmpty }
}

/// Which of the cards a view lists (the sidebar picks: Recents is all of them, On this Mac the files not shared).
enum HomeFilter: String, CaseIterable {
    case all, mac, servers
}

/// A file's card, everything the grid draws.
struct HomeCard: Identifiable, Equatable {
    var path: String
    var opened: Double
    var modified: Double?
    var exists: Bool
    var openComments: Int
    var server: String?
    var id: String { path }
    var name: String { HomeLogic.name(path) }
    var shared: Bool { server != nil }
}

enum HomeLogic {
    /// "Pricing page" for ".../Pricing page.canvas".
    static func name(_ path: String) -> String { URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent }

    /// Newest first. A file edited since it was last opened counts from its edit.
    static func ordered(_ cards: [HomeCard]) -> [HomeCard] {
        cards.sorted { max($0.opened, $0.modified ?? 0) > max($1.opened, $1.modified ?? 0) }
    }

    static func filter(_ cards: [HomeCard], _ f: HomeFilter) -> [HomeCard] {
        switch f {
        case .all: return cards
        case .mac: return cards.filter { !$0.shared }
        case .servers: return cards.filter { $0.shared }
        }
    }

    /// The cards whose name has every word of the query, any case.
    static func search(_ cards: [HomeCard], _ query: String) -> [HomeCard] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        if words.isEmpty { return cards }
        return cards.filter { c in words.allSatisfy { c.name.localizedCaseInsensitiveContains($0) } }
    }

    /// The one muted line where a view has no files to show: a search that matched nothing, a server with nothing
    /// shared yet, no files at all (a first launch), or a view whose files are all elsewhere.
    static func emptyLine(query: String, onServer: Bool, files: Int) -> String {
        if !query.isEmpty { return "No files match \u{201C}\(query)\u{201D}" }
        if onServer { return "No files shared to this Cloud yet" }
        return files == 0 ? "Files you open show up here" : "Nothing here yet"
    }

    /// The sidebar's search field: hidden while there is nothing to search, unless words are still typed in it.
    static func showsSearch(files: Int, query: String) -> Bool { files > 0 || !query.isEmpty }

    /// The cards of one Cloud: the files whose comments name exactly its address (canonical origin, port included;
    /// the same rule as the server's), never another Cloud on the same host.
    static func onServer(_ cards: [HomeCard], _ url: String) -> [HomeCard] {
        guard let want = CloudURL.clean(url) else { return [] }
        return cards.filter { $0.server.flatMap(CloudURL.clean) == want }
    }

    /// The place a card names: "This Mac", or the Cloud it is shared to, by the name given to it in Settings > Cloud.
    static func whereLabel(server: String?, clouds: [CloudEntry] = []) -> (text: String, symbol: String) {
        guard let server, !server.isEmpty else { return ("This Mac", "laptopcomputer") }
        let clean = CloudURL.clean(server)
        if let e = clouds.first(where: { $0.url == clean }) { return (cloudName(e), "cloud") }
        return (ServerName.display(server), "cloud")
    }

    /// A Cloud's name on screen: the name given to it, else its host (ServerName.label).
    static func cloudName(_ e: CloudEntry) -> String { ServerName.label(e.url, name: e.name) }

    /// The word a Cloud's row (and its page) shows only when it needs the person: "Sign in" in amber, "Down" or
    /// "Offline" in grey with the row dimmed. Nil when it is fine, or not asked yet: no green dots.
    enum Tone: Equatable { case live, muted, attention }
    static func word(status: String?) -> (text: String, tone: Tone)? {
        switch status {
        case "signedOut", "signInAgain": return ("Sign in", .attention)
        case "removed": return ("Removed", .attention)
        case "forbidden": return ("No access", .attention)
        case "tooOld", "tooNew": return ("Update needed", .attention)
        case "unavailable": return ("Unavailable", .attention)
        case "down": return ("Down", .muted)
        case "offline": return ("Offline", .muted)
        default: return nil
        }
    }

    /// The row's glyph says where a Cloud lives: a laptop for a Cloud on a Mac (hosted here or joined), a cloud for a
    /// server.
    static func rowSymbol(kind: CloudKind) -> String { kind == .server ? "cloud" : "laptopcomputer" }

    /// "Edited 5 min ago" or "Opened yesterday": an edit after the last open wins, by more than a few seconds
    /// (opening a file saves nothing, but a change the app makes on load should not read as an edit).
    static func whenLabel(opened: Double, modified: Double?, now: Double) -> String {
        if let m = modified, m > opened + 30 { return "Edited " + ago(m, now: now) }
        return "Opened " + ago(opened, now: now)
    }

    /// The relative time: "just now", "5 min ago", "1 h ago", "yesterday", "3 days ago", "last week", "2 weeks ago", then the date.
    static func ago(_ t: Double, now: Double, calendar: Calendar = .current) -> String {
        let s = max(0, now - t)
        if s < 60 { return "just now" }
        if s < 3600 { return "\(Int(s / 60)) min ago" }
        let d0 = calendar.startOfDay(for: Date(timeIntervalSince1970: t)), d1 = calendar.startOfDay(for: Date(timeIntervalSince1970: now))
        let days = calendar.dateComponents([.day], from: d0, to: d1).day ?? 0
        if days == 0 { return "\(Int(s / 3600)) h ago" }
        if days == 1 { return "yesterday" }
        if days < 7 { return "\(days) days ago" }
        if days < 14 { return "last week" }
        if days < 31 { return "\(days / 7) weeks ago" }
        let f = DateFormatter()
        f.dateFormat = calendar.isDate(Date(timeIntervalSince1970: t), equalTo: Date(timeIntervalSince1970: now), toGranularity: .year) ? "d MMM" : "d MMM yyyy"
        return f.string(from: Date(timeIntervalSince1970: t))
    }

    /// "3" or "12", and "99+" past 99.
    static func commentBadge(_ n: Int) -> String { n > 99 ? "99+" : String(n) }

    /// "3 open", "1 open", "None open".
    static func commentsLine(_ n: Int) -> String { n == 0 ? "None open" : "\(n) open" }

    /// The letter on a card with no picture yet.
    static func initial(_ path: String) -> String {
        name(path).first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "C"
    }

    /// "Connected as anna@studio.com, owner".
    static func connectedLine(email: String?, role: String?) -> String? {
        guard let email, !email.isEmpty else { return nil }
        return "Connected as \(email)" + ((role?.isEmpty ?? true) ? "" : ", \(role!)")
    }

    /// The sidebar dot for the server's status word: connected, offline, or the amber of "sign in again" and the rest.
    enum Dot: Equatable { case connected, offline, down, attention }
    static func dot(status: String, configured: Bool) -> Dot {
        if !configured { return .offline }
        switch status {
        case "connected": return .connected
        case "offline": return .offline
        case "down": return .down
        default: return .attention
        }
    }
    static func dotWords(_ d: Dot) -> String {
        switch d {
        case .connected: "Connected"
        case .offline: "Offline"
        case .down: "Cloud down"
        case .attention: "Sign in again"
        }
    }
}

enum Thumbnails {
    /// The picture's width in pixels (twice the card on a Retina screen, at the card's usual width).
    static let width = 480

    /// The file name of a path's thumbnail: a hash of the path, so no path or file name is on disk beside it.
    static func key(_ path: String) -> String {
        SHA256.hash(data: Data(path.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// <state folder>/thumbnails/<key>.png. Never inside the .canvas package.
    static func url(state: String, path: String) -> URL {
        URL(fileURLWithPath: state).appendingPathComponent("thumbnails", isDirectory: true).appendingPathComponent(key(path) + ".png")
    }
}
