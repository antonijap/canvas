// The command palette's pure half (Palette.swift is the view): fuzzy matching with the same scoring as the server's
// (src/search.ts), so commands and found layers rank on one scale, shortcut labels from the menu spec, recents and
// cursor steps. Plain Foundation, so Tests/PaletteLogicTests.swift runs it without the app.

import Foundation

enum PaletteFuzzy {
    struct Match: Equatable {
        var score: Double
        /// UTF-16 offset and length of each matched run (JavaScript's string indices, which the server sends too).
        var ranges: [[Int]]
    }

    private static func lower(_ s: String) -> [UInt16] {
        s.utf16.map { $0 >= 65 && $0 <= 90 ? $0 + 32 : $0 }
    }
    private static func isWord(_ c: UInt16) -> Bool { (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127 }
    private static func boundary(_ t: [UInt16], _ i: Int) -> Bool {
        if i == 0 { return true }
        let p = t[i - 1], c = t[i]
        if !isWord(p) { return true }
        return p >= 97 && p <= 122 && c >= 65 && c <= 90
    }
    private static func index(of w: [UInt16], in t: [UInt16], from: Int) -> Int? {
        guard !w.isEmpty, w.count <= t.count, from <= t.count - w.count else { return nil }
        var i = max(from, 0)
        while i <= t.count - w.count {
            if t[i] == w[0] {
                var k = 1
                while k < w.count && t[i + k] == w[k] { k += 1 }
                if k == w.count { return i }
            }
            i += 1
        }
        return nil
    }
    private static func index(of c: UInt16, in t: [UInt16], from: Int) -> Int? {
        var i = max(from, 0)
        while i < t.count { if t[i] == c { return i }; i += 1 }
        return nil
    }

    private static func word(_ w: [UInt16], _ t: [UInt16], _ tl: [UInt16], fuzzy: Bool) -> Match? {
        var best: Match?
        var at = index(of: w, in: tl, from: 0), n = 0
        while let i = at, n < 6 {
            let s = 100 + Double(w.count) * 12 + (i == 0 ? 40 : boundary(t, i) ? 25 : 0) - Double(min(i, 30)) * 0.5
            if best == nil || s > best!.score { best = Match(score: s, ranges: [[i, w.count]]) }
            if i == 0 { break }
            at = index(of: w, in: tl, from: i + 1); n += 1
        }
        if best != nil || !fuzzy || w.count < 2 { return best }
        let maxSpan = max(w.count * 3, w.count + 10)
        var start = index(of: w[0], in: tl, from: 0), tries = 0
        while let s0 = start, tries < 8 {
            var ranges = [[s0, 1]]
            var s = 10.0 + (boundary(t, s0) ? 14 : 0) + (s0 == 0 ? 10 : 0), last = s0, ok = true
            for k in 1..<w.count {
                guard let j = index(of: w[k], in: tl, from: last + 1), j - s0 < maxSpan else { ok = false; break }
                if j == last + 1 { s += 18; ranges[ranges.count - 1][1] += 1 }
                else { s += 8 + (boundary(t, j) ? 12 : 0) - Double(min(j - last - 1, 8)); ranges.append([j, 1]) }
                last = j
            }
            if ok && (best == nil || s > best!.score) { best = Match(score: s, ranges: ranges) }
            start = index(of: w[0], in: tl, from: s0 + 1); tries += 1
        }
        return best
    }

    /// How well `query` matches `text`, or nil. Several words must each match, in any order. `fuzzy` false: only
    /// contiguous runs count (text content). The same numbers as fuzzyMatch in src/search.ts.
    static func match(_ query: String, _ text: String, fuzzy: Bool = true) -> Match? {
        let q = query.trimmingCharacters(in: .whitespaces).split(whereSeparator: { $0 == " " }).joined(separator: " ")
        guard !q.isEmpty else { return nil }
        let ql = lower(q), t = Array(text.utf16), tl = lower(text)
        if var whole = word(ql, t, tl, fuzzy: false) {
            if whole.ranges[0][0] == 0 && ql.count == tl.count { whole.score += 60 }
            whole.score -= Double(min(tl.count - ql.count, 60)) * 0.3
            return whole
        }
        let words = q.split(separator: " ").map { lower(String($0)) }
        if words.count == 1 && !fuzzy { return nil }
        var score = 0.0
        var ranges: [[Int]] = []
        for w in words {
            guard let m = word(w, t, tl, fuzzy: fuzzy) else { return nil }
            score += m.score * 0.8
            ranges += m.ranges
        }
        ranges.sort { $0[0] < $1[0] }
        var merged: [[Int]] = []
        for r in ranges {
            if let last = merged.last, r[0] <= last[0] + last[1] {
                merged[merged.count - 1][1] = max(last[1], r[0] + r[1] - last[0])
            } else { merged.append(r) }
        }
        return Match(score: score - Double(min(tl.count, 60)) * 0.3, ranges: merged)
    }
}

enum PaletteKeys {
    /// A menu item's shortcut as the menu draws it: modifiers in Apple's order (control, option, shift, command), then the key.
    static func label(_ i: MenuSpec.Item) -> String {
        guard !i.key.isEmpty else { return "" }
        var s = ""
        if i.mods.contains(.control) { s += "\u{2303}" }
        if i.mods.contains(.option) { s += "\u{2325}" }
        if i.mods.contains(.shift) { s += "\u{21E7}" }
        if i.mods.contains(.command) { s += "\u{2318}" }
        return s + key(i.key)
    }
    static func key(_ k: String) -> String {
        switch k {
        case "\r": return "\u{21A9}"
        case "\u{1B}": return "\u{238B}"
        default: return k.uppercased()
        }
    }
}

enum PaletteList {
    /// The recents list after running `key`: it goes first, once, and the list keeps `limit` entries.
    static func bump(_ list: [String], _ key: String, limit: Int = 8) -> [String] {
        Array(([key] + list.filter { $0 != key }).prefix(limit))
    }
    /// The cursor after an arrow press: wraps at both ends, stays at 0 for an empty list.
    static func step(_ cursor: Int, by d: Int, count: Int) -> Int {
        guard count > 0 else { return 0 }
        return ((cursor + d) % count + count) % count
    }
    /// When an ask was, short (src/page/spark-logic.js relDay): "18:40" today, "Yesterday", "Mon" within the week, "12 Nov".
    static func relDay(_ at: Date, now: Date, calendar: Calendar = .current) -> String {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: at), to: calendar.startOfDay(for: now)).day ?? 0
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        if days <= 0 { f.dateFormat = "HH:mm" }
        else if days == 1 { return "Yesterday" }
        else if days < 7 { f.dateFormat = "EEE" }
        else { f.dateFormat = "d MMM" }
        return f.string(from: at).replacingOccurrences(of: "Sept", with: "Sep")
    }

    /// Group order by each group's best score, ties in the given order.
    static func order(_ groups: [(id: String, best: Double)]) -> [String] {
        groups.enumerated().sorted { a, b in a.element.best != b.element.best ? a.element.best > b.element.best : a.offset < b.offset }.map(\.element.id)
    }
}
