// Tests for PaletteLogic.swift: fuzzy scores and ranges (the same as src/search.ts), shortcut labels, recents, cursor.
// Run from apps/macos:
//   swiftc -parse-as-library ShellLogic.swift PaletteLogic.swift Tests/PaletteLogicTests.swift -o /tmp/palette-tests && /tmp/palette-tests

import Foundation

@main
struct PaletteLogicTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
        checks += 1
        if !ok { failures += 1; print("FAIL line \(line): \(what())") }
    }

    static func main() {
        fuzzy(); keys(); lists(); asks()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    static func fuzzy() {
        let start = PaletteFuzzy.match("but", "Primary Button")!
        let inside = PaletteFuzzy.match("but", "Rebuttal")!
        let exact = PaletteFuzzy.match("button", "Button")!
        check(start.score > inside.score, "word start beats inside a word")
        check(exact.score > start.score, "exact beats a run")
        check(start.ranges == [[8, 3]], "range \(start.ranges)")
        let spread = PaletteFuzzy.match("grp", "Group Selection")
        check(spread != nil && spread!.ranges.first == [0, 2], "letters in order: \(String(describing: spread?.ranges))")
        check(PaletteFuzzy.match("pbtn", "Primary Button", fuzzy: false) == nil, "text content needs whole runs")
        check(PaletteFuzzy.match("auto add", "Add Auto Layout") != nil, "words in any order")
        check(PaletteFuzzy.match("auto remove", "Add Auto Layout") == nil, "a missing word fails")
        check(PaletteFuzzy.match("", "x") == nil, "empty query")
        // The server's numbers for the same inputs (node -e with fuzzyMatch from src/search.ts).
        check(abs(start.score - 153.7) < 0.01, "same score as the server: \(start.score)")
        let uni = PaletteFuzzy.match("caf", "Le café")!
        check(uni.ranges == [[3, 3]], "UTF-16 offsets: \(uni.ranges)")
    }

    static func keys() {
        check(PaletteKeys.label(MenuSpec.Item(title: "Frame", command: "frame", key: "g", mods: [.command, .option])) == "\u{2325}\u{2318}G", "option command G")
        check(PaletteKeys.label(MenuSpec.Item(title: "Fit", command: "zoomFit", key: "1", mods: [.shift])) == "\u{21E7}1", "shift 1")
        check(PaletteKeys.label(MenuSpec.Item(title: "Delete", command: "delete", mods: [])) == "", "no key, no label")
        check(MenuSpec.view.contains { $0?.command == "palette" && $0?.key == "k" }, "Quick Actions is in the View menu on Cmd+K")
    }

    static func lists() {
        check(PaletteList.bump(["a", "b", "c"], "b") == ["b", "a", "c"], "bump moves to the front")
        check(PaletteList.bump(Array("abcdefgh").map(String.init), "z", limit: 8).count == 8, "bump keeps the limit")
        check(PaletteList.step(0, by: -1, count: 5) == 4 && PaletteList.step(4, by: 1, count: 5) == 0, "wraps")
        check(PaletteList.step(3, by: 1, count: 0) == 0, "empty list")
        check(PaletteList.order([("a", 10), ("b", 30), ("c", 30)]) == ["b", "c", "a"], "best first, ties keep order")
    }

    /// Recent asks (talk to the selection): when, on the right of the one-line row.
    static func asks() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Helsinki")!
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 16, hour: 12, minute: 0))!
        let at = { (d: Int, h: Int, m: Int) in cal.date(from: DateComponents(year: 2026, month: 11, day: d, hour: h, minute: m))! }
        check(PaletteList.relDay(at(16, 18, 40), now: now, calendar: cal) == "18:40", "today: \(PaletteList.relDay(at(16, 18, 40), now: now, calendar: cal))")
        check(PaletteList.relDay(at(15, 23, 59), now: now, calendar: cal) == "Yesterday", "yesterday")
        check(PaletteList.relDay(at(10, 9, 0), now: now, calendar: cal) == "Tue", "this week: \(PaletteList.relDay(at(10, 9, 0), now: now, calendar: cal))")
        check(PaletteList.relDay(at(9, 9, 0), now: now, calendar: cal) == "9 Nov", "older: \(PaletteList.relDay(at(9, 9, 0), now: now, calendar: cal))")
    }
}
