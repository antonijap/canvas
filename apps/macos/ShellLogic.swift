// Pure helpers for the native shell: no SwiftUI, no AppKit, so Tests/ShellLogicTests.swift can run them on
// their own (swiftc -parse-as-library ShellLogic.swift Tests/ShellLogicTests.swift).

import Foundation
import CoreGraphics

/// Page URLs the shell loads. Paths go in as query values, so `&`, `=`, `+` and `#` in a file name are encoded
/// (URLComponents leaves `+` alone, and the server reads `+` as a space).
enum DocURL {
    private static let valueChars: CharacterSet = {
        var s = CharacterSet.urlQueryAllowed
        s.remove(charactersIn: "&=+#?")
        return s
    }()

    static func encode(_ v: String) -> String { v.addingPercentEncoding(withAllowedCharacters: valueChars) ?? "" }

    /// The page for `file` inside the native shell; nil file is the empty page, still in the native shell.
    static func page(base: URL, file: String?) -> URL? {
        var q = [String]()
        if let file { q.append("file=" + encode(file)) }
        q.append("shell=native")
        return URL(string: "?" + q.joined(separator: "&"), relativeTo: base)
    }
}

extension URLComponents {
    /// The one way the shell builds a query: values go through DocURL.encode, so `+`, `&`, `=` and `#` in a file
    /// name or a search arrive as themselves (`queryItems` leaves `+` alone, and the server reads it as a space).
    mutating func setQuery(_ items: [URLQueryItem]) {
        percentEncodedQueryItems = items.map { URLQueryItem(name: DocURL.encode($0.name), value: $0.value.map(DocURL.encode)) }
    }
}

/// Finds the node binary without the login shell's PATH: Finder and launchd start apps with a bare
/// /usr/bin:/bin:/usr/sbin:/sbin. CANVAS_NODE wins, then the Node inside the app (a release carries its own), then
/// the usual install places, then PATH.
enum NodeLocator {
    static func candidates(env: [String: String], home: String, bundled: String? = nil) -> [String] {
        var out = [String]()
        if let n = env["CANVAS_NODE"], !n.isEmpty { out.append(n) }
        if let b = bundled { out.append(b) }
        out += [
            home + "/.local/share/mise/installs/node/24/bin/node",
            home + "/.local/share/mise/shims/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ]
        for dir in (env["PATH"] ?? "").split(separator: ":") where !dir.isEmpty { out.append(String(dir) + "/node") }
        return out
    }

    static func find(env: [String: String], home: String, bundled: String? = nil, isExecutable: (String) -> Bool) -> String? {
        candidates(env: env, home: home, bundled: bundled).first(where: isExecutable)
    }
}

/// A number typed into a widget setting, as it goes into JSON: whole numbers that fit an Int stay whole,
/// anything else (fractions, 1e20) stays a Double. Never traps on an out-of-range Int(v).
enum JSONNumber {
    static func value(_ v: Double) -> Any? {
        guard v.isFinite else { return nil }
        if v.rounded() == v, abs(v) <= 9_007_199_254_740_991 { return Int(v) }
        return v
    }
    /// Int(v) that cannot trap: nil for NaN, infinity or anything outside Int's range.
    static func int(_ v: Double) -> Int? {
        guard v.isFinite, v >= -9.2e18, v <= 9.2e18 else { return nil }
        return Int(v.rounded())
    }
}

/// The left panel's width against the window: rail, gaps, the inspector and a sliver of canvas must still fit.
/// nil means there is no room for the panel at all (it hides rather than overlapping the inspector).
enum ShellLayout {
    static let minCanvas: CGFloat = 120

    /// The widest the panel can be in this window.
    static func room(window: CGFloat, inspector: Bool, inset: CGFloat, rail: CGFloat, gap: CGFloat, props: CGFloat) -> CGFloat {
        var room = window - inset * 2 - rail - gap * 2 - minCanvas
        if inspector { room -= props + gap }
        return room
    }

    static func sidebarWidth(window: CGFloat, stored: CGFloat, inspector: Bool,
                             inset: CGFloat, rail: CGFloat, gap: CGFloat, props: CGFloat, minWidth: CGFloat) -> CGFloat? {
        let room = room(window: window, inspector: inspector, inset: inset, rail: rail, gap: gap, props: props)
        if room < minWidth { return nil }
        return min(max(stored, minWidth), room)
    }
}

/// Resizing a sidebar by its edge: the editor panel and the Home sidebar follow the same rules.
enum SidebarSize {
    /// The edge's grab strip: it straddles the edge, half over the sidebar and half over what lies beside it.
    static let hitWidth: CGFloat = 12

    /// The width a stored value means: the default when nothing sensible is stored, else clamped.
    static func restore(_ stored: Double, fallback: CGFloat, min lo: CGFloat, max hi: CGFloat) -> CGFloat {
        guard stored.isFinite, stored > 0 else { return fallback }
        return Swift.min(Swift.max(CGFloat(stored), lo), hi)
    }

    /// The width while dragging: where the drag started plus how far it went, in whole points, held between
    /// the minimum and the maximum (which the caller lowers to the room the window has left).
    static func drag(start: CGFloat, translation: CGFloat, min lo: CGFloat, max hi: CGFloat) -> CGFloat {
        let raw = start + translation
        guard raw.isFinite else { return lo }
        return Swift.min(Swift.max(raw.rounded(), lo), Swift.max(hi, lo))
    }

    /// The widest a sidebar may be in a window: a share of it, between the sidebar's own minimum and maximum.
    static func cap(window: CGFloat, share: CGFloat, min lo: CGFloat, max hi: CGFloat) -> CGFloat {
        Swift.min(Swift.max((window * share).rounded(), lo), hi)
    }
}

/// The open tabs list after "Locate…" found a moved file: the new path takes the old one's place, once.
enum TabList {
    static func replacing(_ files: [String], _ old: String, with new: String) -> [String] {
        var out = [String]()
        for f in files {
            let v = f == old ? new : f
            if !out.contains(v) { out.append(v) }
        }
        if !out.contains(new) { out.append(new) }
        return out
    }
}

/// Whether a failed page load should be tried again: the server is starting or restarting (connection refused,
/// dropped, timed out), and not forever.
enum NavRetry {
    static let transient: Set<Int> = [
        NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut,
        NSURLErrorCannotFindHost, NSURLErrorNotConnectedToInternet,
    ]
    static func shouldRetry(domain: String, code: Int, attempt: Int, limit: Int = 60) -> Bool {
        domain == NSURLErrorDomain && transient.contains(code) && attempt < limit
    }
    /// 0.3 s, then a little longer each time, at most 2 s.
    static func delay(attempt: Int) -> Double { min(2, 0.3 + Double(attempt) * 0.1) }
}

/// Canvas keeps auto mode in the node's metadata, the file's extension slot (see src/tracking.ts).
enum AutoTracking {
    static let key = "canvasLetterSpacing"
    static func isOn(_ node: [String: Any]) -> Bool { (node["metadata"] as? [String: Any])?[key] as? String == "auto" }
    /// The metadata with auto on or off, keeping anything else in it; nil when nothing would be left.
    static func metadata(_ current: Any?, on: Bool) -> [String: Any]? {
        var m = current as? [String: Any] ?? [:]
        if on {
            if !(m["type"] is String) { m["type"] = "canvas" }
            m[key] = "auto"
            return m
        }
        m.removeValue(forKey: key)
        if m.isEmpty || (m.count == 1 && m["type"] as? String == "canvas") { return nil }
        return m
    }
    /// Where the number comes from, for the tooltip. Mirrors trackingMethod in src/tracking.ts.
    static func source(_ family: String) -> String {
        let f = family.split(separator: ",").first.map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")).lowercased() } ?? ""
        if ["inter", "inter variable", "intervariable", "inter var"].contains(f) { return "Inter Dynamic Metrics" }
        if ["sf pro rounded", "ui-rounded", ".sf ns rounded"].contains(f) { return "Apple\u{2019}s SF Pro Rounded tracking table" }
        if f.hasPrefix("new york") || f == "ui-serif" { return "Apple\u{2019}s New York tracking table" }
        if ["sf pro", "sf pro text", "sf pro display", "san francisco", "system-ui", "-apple-system", "blinkmacsystemfont", ".sf ns", ".sf ns text", ".sf ns display", ".applesystemuifont"].contains(f) { return "Apple\u{2019}s SF Pro tracking table" }
        return "a curve fitted to the font\u{2019}s x-height"
    }
    /// −1.1% (a true minus), 0%, +0.4%.
    static func percent(_ px: Double, size: Double?) -> String {
        guard let size, size > 0 else { return "" }
        let p = (px / size * 1000).rounded() / 10
        if p == 0 { return "0%" }
        return (p < 0 ? "\u{2212}" : "+") + String(format: "%.1f%%", abs(p))
    }
    /// The one Auto control in the letter spacing field: what a click on it writes. On → off keeps the computed
    /// value as your own (the text does not jump); off → on needs a font size to compute from.
    enum Click: Equatable { case turnOff(keep: Double), turnOn, none }
    static func click(on: Bool, value: Double?, size: Double?, editable: Bool) -> Click {
        guard editable else { return .none }
        if on { return .turnOff(keep: value ?? 0) }
        return size == nil ? .none : .turnOn
    }
}

/// The inspector's writes (CanvasModel.update): one write per key (a node, or one multi-selection) in flight at a
/// time; what arrives meanwhile waits, merged into one, and goes when the write in flight answers. So a scrub's
/// older value never lands after a newer one, and Undo can wait until nothing is waiting or in flight.
/// Writes whose targets overlap (A+B selected, then A alone) also go in the order they were made: a write waits
/// while an earlier one touching any of its nodes is in flight or still waiting.
struct WriteQueue<W> {
    private struct Entry { let key: String; let nodes: Set<String>; var w: W }
    private var inFlight: [String: Set<String>] = [:]
    private var queued: [Entry] = []
    var isIdle: Bool { inFlight.isEmpty && queued.isEmpty }

    /// Queue `w` for `nodes`; returns what should be sent now.
    mutating func add(_ key: String, nodes: Set<String>, _ w: W, merge: (inout W, W) -> Void) -> [(key: String, w: W)] {
        // Merge into the waiting write of the same key, unless a later waiting write touches the same nodes
        // (merging would move this edit in front of it).
        if let i = queued.lastIndex(where: { $0.key == key }),
           !queued[(i + 1)...].contains(where: { !$0.nodes.isDisjoint(with: nodes) }) {
            merge(&queued[i].w, w)
        } else {
            queued.append(Entry(key: key, nodes: nodes, w: w))
        }
        return pump()
    }

    /// The write for `key` answered: what can go now.
    mutating func answered(_ key: String) -> [(key: String, w: W)] {
        inFlight.removeValue(forKey: key)
        return pump()
    }

    private mutating func pump() -> [(key: String, w: W)] {
        var out: [(key: String, w: W)] = []
        var blocked = Set<String>()
        for n in inFlight.values { blocked.formUnion(n) }
        var keep: [Entry] = []
        for e in queued {
            if inFlight[e.key] == nil, e.nodes.isDisjoint(with: blocked) {
                inFlight[e.key] = e.nodes
                out.append((e.key, e.w))
            } else {
                keep.append(e)
            }
            blocked.formUnion(e.nodes)
        }
        queued = keep
        return out
    }
}

/// A text field's draft: the target (file and selected node) it was shown for and the text it showed. A commit
/// goes through only when the text was edited and the target is still the one it was typed for, so leaving a
/// field untouched never rewrites a value through its rounded display ("12.345" shown as "12.35"), and a draft
/// typed for one node is never written to the node selected since.
struct FieldDraft: Equatable {
    private(set) var target: String?
    private(set) var shown = ""
    mutating func show(_ text: String, for target: String?) { shown = text; self.target = target }
    func commits(_ text: String, target now: String?) -> Bool { text != shown && target == now }
    /// The user typed since the field last showed a value: an outside change (undo, another editor) must not
    /// overwrite it. Untouched, the field follows the value even while focused.
    func edited(_ text: String) -> Bool { text != shown }
}

/// Font weights by name. A file may hold a CSS keyword ("normal", "bold"), a number (700) or a numeric
/// string ("600", the file's own form): the menu always shows the name, and a pick is written back in the file's form.
enum FontWeights {
    static let named: [(name: String, value: Int)] = [("Thin", 100), ("Extra Light", 200), ("Light", 300), ("Regular", 400),
                                                       ("Medium", 500), ("Semi Bold", 600), ("Bold", 700), ("Extra Bold", 800), ("Black", 900)]

    /// The numeric weight a stored value stands for, or nil when it is not a weight at all.
    static func numeric(_ v: Any?) -> Int? {
        switch v {
        case let n as NSNumber: return JSONNumber.int(n.doubleValue).flatMap { (1...1000).contains($0) ? $0 : nil }
        case let s as String:
            let t = s.trimmingCharacters(in: .whitespaces).lowercased()
            switch t {
            case "normal": return 400
            case "bold": return 700
            default:
                let squeezed = t.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "")
                if let hit = named.first(where: { $0.name.lowercased().replacingOccurrences(of: " ", with: "") == squeezed }) { return hit.value }
                guard let d = Double(t), let i = JSONNumber.int(d), (1...1000).contains(i) else { return nil }
                return i
            }
        default: return nil
        }
    }

    /// What the weight menu shows: the name for 100..900 and the keywords, else the number itself.
    static func title(_ v: Any?) -> String {
        guard let w = numeric(v) else { return (v as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Regular" }
        return named.first { $0.value == w }?.name ?? String(w)
    }

    /// The value to write for a picked weight, in the form the file already uses: a number stays a number,
    /// anything else (a numeric string, a keyword, nothing) becomes the file's numeric string.
    static func write(_ weight: Int, over current: Any?) -> Any {
        if current is NSNumber && !(current is Bool) { return weight }
        return String(weight)
    }

    /// NSFontManager's 0-15 weight as the CSS weight it stands for (5 is Regular 400, 9 Bold 700).
    static func css(appKit w: Int) -> Int {
        switch w {
        case ...2: return 100
        case 3: return 200
        case 4: return 300
        case 5: return 400
        case 6, 7: return 500
        case 8: return 600
        case 9: return 700
        case 10: return 800
        default: return 900
        }
    }

    /// The weight menu for a family: only the weights it has (all of them when the family is unknown), plus the
    /// node's current weight so the menu always shows what the file holds.
    static func available(appKit: [Int], current: Any?) -> [(name: String, value: Int)] {
        let have = Set(appKit.map(css))
        guard !have.isEmpty else { return named }
        let cur = numeric(current)
        return named.filter { have.contains($0.value) || $0.value == cur }
    }
}

/// Number fields' arithmetic (NumericInput in the panel): "12*2", "(8+4)/2", and "+8" / "*2" / "/2" relative to
/// the current value. A relative entry needs a current value: on a "Mixed" field it is refused, never applied
/// as an absolute number.
enum NumericExpr {
    /// Two decimals at most, so 0.1 steps never show 0.30000000000000004.
    static func clean(_ v: Double) -> Double { (v * 100).rounded() / 100 }

    static func clamp(_ v: Double, _ lo: Double?, _ hi: Double?) -> Double {
        var x = v
        if let lo { x = max(lo, x) }
        if let hi { x = min(hi, x) }
        return x
    }

    /// The number a field's text means. A leading +, * or / applies to `current`; anything else is an expression.
    static func evaluate(_ text: String, current: Double?) -> Double? {
        var s = text.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "\u{2212}", with: "-").replacingOccurrences(of: "×", with: "*")
            .replacingOccurrences(of: "÷", with: "/").replacingOccurrences(of: ",", with: ".")
        for unit in ["px", "%", "°"] where s.hasSuffix(unit) { s = String(s.dropLast(unit.count)).trimmingCharacters(in: .whitespaces) }
        guard !s.isEmpty else { return nil }
        if let first = s.first, "+*/^".contains(first) {
            guard let current else { return nil }
            var e = Expr(String(s.dropFirst()))
            guard let rest = e.parse() else { return nil }
            let v: Double
            switch first {
            case "+": v = current + rest
            case "*": v = current * rest
            case "^": v = pow(current, rest)
            default: return rest == 0 ? nil : current / rest
            }
            return v.isFinite ? v : nil
        }
        var e = Expr(s)
        return e.parse()
    }

    /// + - * / ^ and parentheses over decimals; nil for anything else. ^ binds tighter than * and /, right to left,
    /// and after a unary minus (-2^2 is -4), as in maths.
    private struct Expr {
        let c: [Character]
        var i = 0
        init(_ s: String) { c = Array(s.filter { !$0.isWhitespace }) }

        mutating func parse() -> Double? {
            guard let v = sum(), i == c.count, v.isFinite else { return nil }
            return v
        }
        private mutating func sum() -> Double? {
            guard var v = product() else { return nil }
            while i < c.count, c[i] == "+" || c[i] == "-" {
                let op = c[i]; i += 1
                guard let r = product() else { return nil }
                v = op == "+" ? v + r : v - r
            }
            return v
        }
        private mutating func product() -> Double? {
            guard var v = unary() else { return nil }
            while i < c.count, c[i] == "*" || c[i] == "/" {
                let op = c[i]; i += 1
                guard let r = unary() else { return nil }
                if op == "/" { guard r != 0 else { return nil }; v /= r } else { v *= r }
            }
            return v
        }
        private mutating func unary() -> Double? {
            if i < c.count, c[i] == "-" { i += 1; return unary().map { -$0 } }
            if i < c.count, c[i] == "+" { i += 1; return unary() }
            return power()
        }
        private mutating func power() -> Double? {
            guard let base = atom() else { return nil }
            guard i < c.count, c[i] == "^" else { return base }
            i += 1
            guard let exp = unary() else { return nil }
            let v = pow(base, exp)
            return v.isFinite ? v : nil
        }
        private mutating func atom() -> Double? {
            if i < c.count, c[i] == "(" {
                i += 1
                guard let v = sum(), i < c.count, c[i] == ")" else { return nil }
                i += 1
                return v
            }
            let start = i
            while i < c.count, c[i].isNumber || c[i] == "." { i += 1 }
            return i > start ? Double(String(c[start..<i])) : nil
        }
    }
}

/// Several layers selected: the page sends only the properties they share. Every other key one of them sets
/// differs between them, and its field shows "Mixed" (editable) instead of a default.
enum MixedKeys {
    static func of(_ nodes: [[String: Any]], shared: [String: Any]) -> Set<String> {
        var all = Set<String>()
        for n in nodes { all.formUnion(n.keys) }
        all.subtract(shared.keys)
        all.subtract(["id", "children", "descendants"])
        return all
    }
}

/// The snapping popover's Big nudge: 1 to 1000 px, whatever is typed.
enum SnapLimits {
    static func bigNudge(_ v: Int) -> Int { min(max(v, 1), 1000) }
}

/// A secret typed or pasted into a widget setting. `security -i` takes one line, and the server reads the item back
/// with `find-generic-password -w`, which prints a value with line breaks as hex: a multi-line secret is refused,
/// never stored cut short. Surrounding blanks (a pasted trailing newline) are dropped.
enum SecretInput {
    enum Result: Equatable { case ok(String), empty, multiline }
    static func clean(_ s: String) -> Result {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return .empty }
        if t.contains(where: { $0.isNewline || $0 == "\0" }) { return .multiline }
        return .ok(t)
    }
}

/// Cmd+Z with a text field focused: the field takes it only when it has a step of its own that way. A field with
/// nothing to undo (just focused, or back at its committed text) lets the document's Undo through.
enum UndoRouting {
    static func fieldTakes(hasField: Bool, canStep: Bool) -> Bool { hasField && canStep }
}

/// Leading and trailing throttle on a clock the caller passes in: the first value goes at once, then at most one
/// per interval, and a value offered meanwhile goes when the interval ends (the latest one wins).
struct LeadTrailThrottle {
    enum Action: Equatable { case sendNow, schedule(after: Double), wait }
    let interval: Double
    private(set) var lastSent = -Double.infinity
    private(set) var scheduled = false

    init(interval: Double) { self.interval = interval }

    mutating func offer(now: Double) -> Action {
        if scheduled { return .wait }
        let wait = interval - (now - lastSent)
        if wait <= 0 { lastSent = now; return .sendNow }
        scheduled = true
        return .schedule(after: wait)
    }

    /// A send happened (the scheduled one fired, or a commit went at once).
    mutating func sent(now: Double) { scheduled = false; lastSent = now }
}

/// The part of the window the shell's islands cover, as insets of the canvas view. The canvas fits into what is left.
enum CanvasInsets {
    static func compute(panel: CGFloat?, inspector: Bool, inset: CGFloat, rail: CGFloat, gap: CGFloat, pill: CGFloat, props: CGFloat) -> (l: CGFloat, t: CGFloat, r: CGFloat, b: CGFloat) {
        let left = inset + rail + gap + (panel.map { $0 + gap } ?? 0)
        let right = inset + (inspector ? props + gap : 0)
        let top = inset + pill + gap
        let bottom = inset + pill + gap
        return (left, top, right, bottom)
    }
}

/// A page with nothing on it yet: the canvas shows one line on how to start, and the zoom pill and the properties
/// toggle wait for content (nothing to zoom or inspect). Only once the page has reported its boards (`loaded`, the
/// doc message's revision), so a file still opening never flashes the hint.
enum EmptyPage {
    static let hint = "Ask your agent for a first board, or drop in a screenshot"

    static func isEmpty(fileOpen: Bool, home: Bool, loaded: Bool, boards: Int, cards: Int) -> Bool {
        fileOpen && !home && loaded && boards == 0 && cards == 0
    }
}

/// Where a tooltip window goes: below and to the right of the pointer like AppKit's own, kept on the screen
/// (above the pointer when there is no room below). Screen coordinates, origin bottom-left.
enum TipPlacement {
    static func origin(mouse: CGPoint, size: CGSize, screen: CGRect) -> CGPoint {
        var x = mouse.x + 4
        var y = mouse.y - 22 - size.height
        if y < screen.minY + 4 { y = mouse.y + 16 }
        x = min(max(x, screen.minX + 4), screen.maxX - size.width - 4)
        y = min(max(y, screen.minY + 4), screen.maxY - size.height - 4)
        return CGPoint(x: x, y: y)
    }
}

/// The right-click menu's edit commands, in order, with shortcuts. Each names a selector of the Edit menu's
/// target (StructureActions in main.swift), so the two menus run the same code; test/context-menu.test.ts
/// checks every selector exists there and that the Edit menu shows the same keys.
enum ContextMenuLayout {
    struct Entry: Equatable {
        let title: String
        let selector: String
        var key = ""
        var command = true
        var option = false
        var shift = false
    }

    static let backspace = "\u{8}"

    /// On a layer: clipboard and delete, grouping, arrange, select all.
    static let node: [[Entry]] = [
        [Entry(title: "Cut", selector: "cut:", key: "x"),
         Entry(title: "Copy", selector: "copy:", key: "c"),
         Entry(title: "Paste", selector: "paste:", key: "v"),
         Entry(title: "Paste here", selector: "pasteHere:", command: false),
         Entry(title: "Paste to replace", selector: "pasteReplace:", key: "r", shift: true),
         Entry(title: "Duplicate", selector: "duplicate:", key: "d"),
         Entry(title: "Delete", selector: "deleteSelection:", key: backspace, command: false)],
        [Entry(title: "Group selection", selector: "group:", key: "g"),
         Entry(title: "Frame selection", selector: "frameSelection:", key: "g", option: true),
         Entry(title: "Ungroup", selector: "ungroup:", key: "g", shift: true)],
        [Entry(title: "Add auto layout", selector: "addAutoLayout:", key: "a", command: false, shift: true),
         Entry(title: "Remove auto layout", selector: "removeAutoLayout:", key: "a", command: false, option: true, shift: true)],
        [Entry(title: "Bring to front", selector: "bringToFront:", key: "]", option: true),
         Entry(title: "Bring forward", selector: "bringForward:", key: "]"),
         Entry(title: "Send backward", selector: "sendBackward:", key: "["),
         Entry(title: "Send to back", selector: "sendToBack:", key: "[", option: true)],
        [Entry(title: "Select all", selector: "selectAll:", key: "a")],
    ]

    /// On empty canvas.
    static let canvas: [[Entry]] = [
        [Entry(title: "Paste here", selector: "pasteHere:", command: false)],
        [Entry(title: "Select all", selector: "selectAll:", key: "a")],
    ]
}

/// Align, distribute and tidy up for several selected layers or boards: the inspector's Arrange row and the
/// right-click Align submenu. Each runs the Arrange menu's own page op (src/page/shortcuts.js, smart.js) and shows
/// its key. An action needs `min` layers it works with: layers an auto layout frame places and ones inside an
/// instance stay put and do not count (a locked layer counts and stays where it is) (src/page/shortcuts-logic.js arrangePlan, ARRANGE_MIN).
enum ArrangeActions {
    struct Action: Equatable {
        let op: String
        let title: String
        let symbol: String
        var min = 2
    }
    static let align: [Action] = [
        Action(op: "align-left", title: "Align left", symbol: "align.horizontal.left"),
        Action(op: "align-hcenter", title: "Align horizontal centers", symbol: "align.horizontal.center"),
        Action(op: "align-right", title: "Align right", symbol: "align.horizontal.right"),
        Action(op: "align-top", title: "Align top", symbol: "align.vertical.top"),
        Action(op: "align-vcenter", title: "Align vertical centers", symbol: "align.vertical.center"),
        Action(op: "align-bottom", title: "Align bottom", symbol: "align.vertical.bottom"),
    ]
    static let spread: [Action] = [
        Action(op: "distribute-h", title: "Distribute horizontal spacing", symbol: "distribute.horizontal", min: 3),
        Action(op: "distribute-v", title: "Distribute vertical spacing", symbol: "distribute.vertical", min: 3),
        Action(op: "tidy", title: "Tidy up", symbol: "square.grid.2x2"),
    ]
    static var all: [Action] { align + spread }

    /// The Arrange menu's key for the action, as the menu draws it (Control, Option, Shift, Command, then the key).
    static func shortcut(_ a: Action) -> String {
        guard let k = menuKey(a) else { return "" }
        let glyphs: [(MenuSpec.Mod, String)] = [(.control, "\u{2303}"), (.option, "\u{2325}"), (.shift, "\u{21E7}"), (.command, "\u{2318}")]
        return glyphs.filter { k.mods.contains($0.0) }.map(\.1).joined() + k.key.uppercased()
    }
    /// The Arrange menu item's key and modifiers (the right-click submenu shows the same key).
    static func menuKey(_ a: Action) -> (key: String, mods: Set<MenuSpec.Mod>)? {
        guard let item = MenuSpec.arrange.compactMap({ $0 }).first(where: { $0.command == a.op }), !item.key.isEmpty else { return nil }
        return (item.key, item.mods)
    }
    static func help(_ a: Action) -> String {
        let k = shortcut(a)
        return k.isEmpty ? a.title : "\(a.title)  \(k)"
    }
    /// The row and the submenu are for two or more layers.
    static func shows(count: Int) -> Bool { count > 1 }
    /// `free`: how many of the selected layers the canvas may move (nil: not known yet, all of them).
    static func enabled(_ a: Action, count: Int, free: Int?) -> Bool { shows(count: count) && (free ?? count) >= a.min }
    /// Why the whole row is off: every layer but one (or all) sits where auto layout puts it.
    static func blockedNote(count: Int, free: Int?) -> String? {
        guard let free, shows(count: count), free < 2 else { return nil }
        return "Auto layout places these layers"
    }
}

/// Export as PNG / SVG from the right-click menu: the choices and the file name the save panel suggests, the same
/// names the server gives files exported into a folder (src/export.ts exportFileName).
enum ExportNaming {
    struct Choice: Equatable { let title: String; let scale: Double?; let preset: String?; let size: String? }
    static let png: [Choice] = [
        Choice(title: "1x", scale: 1, preset: nil, size: nil),
        Choice(title: "2x", scale: 2, preset: nil, size: nil),
        Choice(title: "3x", scale: 3, preset: nil, size: nil),
    ]
    static let presets: [Choice] = [
        Choice(title: "App Store 6.5\" (1242 \u{00D7} 2688)", scale: nil, preset: "app-store-6.5", size: "1242x2688"),
        Choice(title: "App Store 6.9\" (1290 \u{00D7} 2796)", scale: nil, preset: "app-store-6.9", size: "1290x2796"),
        Choice(title: "Google Play (1080 \u{00D7} 1920)", scale: nil, preset: "play", size: "1080x1920"),
    ]

    /// A layer name made safe for a file name: no slashes, colons or control characters, not empty, not too long.
    static func safeName(_ name: String) -> String {
        var s = String(name.unicodeScalars.map { c -> Character in
            c == "/" || c == "\\" || c == ":" || c.value < 0x20 || c.value == 0x7F ? "-" : Character(c)
        })
        while s.hasPrefix(".") { s.removeFirst() }
        s = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return s.isEmpty ? "Layer" : String(s.prefix(120))
    }

    static func fileName(_ name: String, format: String, choice: Choice?) -> String {
        let base = safeName(name)
        if format == "svg" || format == "pdf" { return "\(base).\(format)" }
        if let size = choice?.size { return "\(base) \(size).\(format)" }
        let s = choice?.scale ?? 1
        if s == 1 { return "\(base).\(format)" }
        return "\(base)@\(ExportSettings.scaleText(s))x.\(format)"
    }
}

/// Export settings, saved on the layer (metadata.canvasExports: [{format, scale, suffix}]): the inspector's
/// Export section edits them, File > Export (Shift+Cmd+E) and the section's Export button export with them
/// (src/export.ts takes them as `items`). A layer with none exports as one 1x PNG.
enum ExportSettings {
    struct Setting: Equatable {
        var format = "png"
        var scale = 1.0
        var suffix = ""
    }
    static let metaKey = "canvasExports"
    /// Formats in the menu's order, with the menu's names. WebP is Canvas's own.
    static let formats: [(id: String, title: String)] = [("png", "PNG"), ("jpg", "JPG"), ("webp", "WebP"), ("svg", "SVG"), ("pdf", "PDF")]
    static let scales: [Double] = [0.5, 0.75, 1, 1.5, 2, 3, 4]
    static func isVector(_ f: String) -> Bool { f == "svg" || f == "pdf" }
    static func title(_ f: String) -> String { formats.first { $0.id == f }?.title ?? f.uppercased() }
    /// "2", "1.5", "0.75": a scale without trailing zeros.
    static func scaleText(_ s: Double) -> String {
        let r = (s * 100).rounded() / 100
        return r == r.rounded() ? String(Int(r)) : String(r)
    }
    /// What a scale field takes: "2", "2x", "0.5X", " 3 x"; nil outside 0.1 to 4 (the server's range).
    static func parseScale(_ text: String) -> Double? {
        var t = text.trimmingCharacters(in: .whitespaces).lowercased()
        if t.hasSuffix("x") { t.removeLast() }
        guard let v = Double(t.trimmingCharacters(in: .whitespaces)), v.isFinite, v >= 0.1, v <= 4 else { return nil }
        return v
    }

    /// The settings a node carries, in order; unknown formats and bad scales are left out.
    static func read(_ node: [String: Any]) -> [Setting] {
        guard let list = (node["metadata"] as? [String: Any])?[metaKey] as? [[String: Any]] else { return [] }
        return list.compactMap { d in
            let f = d["format"] as? String ?? "png"
            guard formats.contains(where: { $0.id == f }) else { return nil }
            let s = (d["scale"] as? NSNumber)?.doubleValue ?? 1
            return Setting(format: f, scale: (0.1...4).contains(s) ? s : 1, suffix: d["suffix"] as? String ?? "")
        }
    }

    /// The node's metadata with these settings (every other key kept); nil when nothing would be left.
    static func metadata(_ current: Any?, _ list: [Setting]) -> [String: Any]? {
        var m = current as? [String: Any] ?? [:]
        if list.isEmpty { m.removeValue(forKey: metaKey) } else {
            if !(m["type"] is String) { m["type"] = "canvas" }
            m[metaKey] = list.map { s -> [String: Any] in
                var d: [String: Any] = ["format": s.format]
                if !isVector(s.format) { d["scale"] = s.scale }
                if !s.suffix.isEmpty { d["suffix"] = s.suffix }
                return d
            }
        }
        if m.isEmpty || (m.count == 1 && m["type"] as? String == "canvas") { return nil }
        return m
    }

    /// The setting "+" adds: the next scale up from the last one (1x, then 2x, 3x...), its format kept.
    static func next(after list: [Setting]) -> Setting {
        guard let last = list.last else { return Setting() }
        let up = scales.first { $0 > last.scale && $0 >= 1 } ?? last.scale
        return Setting(format: last.format, scale: isVector(last.format) ? 1 : up, suffix: isVector(last.format) || up == 1 ? "" : "@\(scaleText(up))x")
    }

    /// The export request's items for these layers: each layer's own settings, or one 1x PNG.
    static func items(_ layers: [(id: String, node: [String: Any])]) -> [[String: Any]] {
        layers.flatMap { l -> [[String: Any]] in
            let list = read(l.node)
            if list.isEmpty { return [["id": l.id, "format": "png", "scale": 1.0]] }
            return list.map { s in
                var d: [String: Any] = ["id": l.id, "format": s.format]
                if !isVector(s.format) { d["scale"] = s.scale }
                if !s.suffix.isEmpty { d["suffix"] = s.suffix }
                return d
            }
        }
    }
}

/// Copy as (right-click > Copy as, Edit > Copy as PNG): the formats, their titles and what the toast says.
enum CopyAs {
    static let formats: [(id: String, title: String)] = [("png", "Copy as PNG"), ("svg", "Copy as SVG"), ("css", "Copy as CSS"), ("swiftui", "Copy as SwiftUI"), ("text", "Copy as text")]
    static func toast(_ format: String, count: Int) -> String {
        let what = ["png": "PNG", "svg": "SVG", "css": "CSS", "swiftui": "SwiftUI", "text": "text"][format] ?? format
        return count > 1 && (format == "png" || format == "svg") ? "Copied \(count) layers as \(what)" : "Copied as \(what)"
    }
}

/// The zoom pill's typed zoom (the zoom field): "150", "150%", "1.5x" and "fit" are understood.
enum ZoomInput {
    enum Result: Equatable { case zoom(Double), fit, invalid }
    /// Canvas's zoom range: 2% to 25600% (src/server.ts MAX_ZOOM).
    static let range = 0.02...256.0
    static func parse(_ text: String) -> Result {
        var t = text.trimmingCharacters(in: .whitespaces).lowercased()
        if t == "fit" { return .fit }
        var factor = 0.01
        if t.hasSuffix("%") { t.removeLast() } else if t.hasSuffix("x") { t.removeLast(); factor = 1 }
        guard let v = Double(t.trimmingCharacters(in: .whitespaces)), v.isFinite, v > 0 else { return .invalid }
        return .zoom(min(range.upperBound, max(range.lowerBound, v * factor)))
    }
}

/// Dragging in the Pages list (Pages.swift): a page row onto another reorders, boards dragged from the Layers panel
/// onto a page move there. Payloads are plain text: "canvas-page:<id>" for a page, a board id for a board.
enum PageDrag {
    static let prefix = "canvas-page:"
    static func payload(page id: String) -> String { prefix + id }
    static func page(_ s: String) -> String? { s.hasPrefix(prefix) && s.count > prefix.count ? String(s.dropFirst(prefix.count)) : nil }

    /// The index to PATCH (the server removes the page, then inserts it there) when page `from` is dropped on row
    /// `onto`, in its upper half (`below` false) or lower half. Nil when nothing moves.
    static func index(from: Int, onto: Int, below: Bool, count: Int) -> Int? {
        guard (0..<count).contains(from), (0..<count).contains(onto) else { return nil }
        var to = onto + (below ? 1 : 0)
        if from < to { to -= 1 }
        return to == from ? nil : max(0, min(count - 1, to))
    }

    /// Board ids out of a drop: the Layers panel's own drag (several rows) when it has one, else the text; only
    /// top-level boards of the shown page (`boards`) count.
    static func boards(dragged: [String], text: String?, boards: [String]) -> [String] {
        let ids = dragged.isEmpty ? (text.map { [$0] } ?? []) : dragged
        return ids.filter { boards.contains($0) }
    }
}

/// The inspector's names for instance overrides (GET /api/node `overrides`), in panel order. "descendants" are
/// overrides on layers inside the instance.
enum OverrideLabels {
    static let order: [(key: String, title: String)] = [
        ("ref", "Swapped component"), ("enabled", "Visibility"), ("opacity", "Opacity"), ("cornerRadius", "Corner radius"), ("layout", "Auto layout"), ("gap", "Gap"),
        ("padding", "Padding"), ("fill", "Fill"), ("stroke", "Stroke"), ("strokeWidth", "Stroke"), ("effect", "Effects"),
        ("content", "Text"), ("fontFamily", "Font"), ("fontSize", "Font size"), ("fontWeight", "Font weight"),
        ("lineHeight", "Line height"), ("letterSpacing", "Letter spacing"), ("textAlign", "Text align"), ("descendants", "Layers inside"),
    ]

    /// Titles for the keys, without repeats; keys with no title of their own show as they are.
    static func titles(_ keys: [String]) -> [String] {
        var out: [String] = []
        let known = Set(order.map(\.key))
        for (k, t) in order where keys.contains(k) && !out.contains(t) { out.append(t) }
        for k in keys where !known.contains(k) && !out.contains(k) { out.append(k) }
        return out
    }

    /// The override list's rows: each title with the keys a reset of that row takes (Stroke is stroke and its width).
    static func groups(_ keys: [String]) -> [(title: String, keys: [String])] {
        var out: [(title: String, keys: [String])] = []
        let known = Set(order.map(\.key))
        for (k, t) in order where keys.contains(k) {
            if let i = out.firstIndex(where: { $0.title == t }) { out[i].keys.append(k) } else { out.append((t, [k])) }
        }
        for k in keys where !known.contains(k) && !out.contains(where: { $0.title == k }) { out.append((k, [k])) }
        return out
    }

    /// The inspector sections whose fields offer Reset on right-click when their property is overridden.
    enum Section { case fill, stroke, effects, appearance, typography }

    /// Right-click items for a section's fields: Fill, Stroke and Effects reset as one (a stroke with its width and
    /// position); Appearance and Typography one item per overridden property, in panel order.
    static func resetItems(_ section: Section, overrides: [String]) -> [(title: String, keys: [String])] {
        func one(_ title: String, _ keys: [String]) -> [(title: String, keys: [String])] {
            let k = keys.filter(overrides.contains)
            return k.isEmpty ? [] : [(title, k)]
        }
        func each(_ list: [(String, String)]) -> [(title: String, keys: [String])] {
            list.filter { overrides.contains($0.0) }.map { ("Reset \($0.1)", [$0.0]) }
        }
        switch section {
        case .fill: return one("Reset fill", ["fill"])
        case .stroke: return one("Reset stroke", ["stroke", "strokeWidth", "strokeAlignment"])
        case .effects: return one("Reset effects", ["effect"])
        case .appearance:
            return each([("opacity", "opacity"), ("cornerRadius", "corner radius"), ("cornerSmoothing", "corner smoothing"), ("blendMode", "blend mode"), ("enabled", "visibility")])
        case .typography:
            return each([("fontFamily", "font"), ("fontSize", "font size"), ("fontWeight", "font weight"), ("fontStyle", "font style"), ("lineHeight", "line height"),
                         ("letterSpacing", "letter spacing"), ("textAlign", "text align"), ("textAlignVertical", "vertical align"),
                         ("paragraphSpacing", "paragraph spacing"), ("paragraphIndent", "paragraph indent"), ("lists", "list style"),
                         ("textTruncation", "truncation"), ("maxLines", "max lines")])
        }
    }
}

/// Up/Down in a "Mixed" field (several layers whose values differ): each layer steps from its own value.
/// `nodes`: each layer's properties by id; a layer whose value is a token or a sizing word is left alone.
enum MixedStep {
    static func writes(nodes: [String: [String: Any]], ids: [String], key: String, delta: Double, fallback: Double, min lo: Double?, max hi: Double?) -> [(id: String, value: Double)] {
        ids.compactMap { id in
            guard let n = nodes[id] else { return nil }
            let raw = n[key]
            if raw is String { return nil }
            let cur = (raw as? NSNumber).flatMap { CFGetTypeID($0) == CFBooleanGetTypeID() ? nil : $0.doubleValue } ?? fallback
            return (id, NumericExpr.clean(NumericExpr.clamp(cur + delta, lo, hi)))
        }
    }

    /// One unit of a scrub per point dragged (1 per px), times the modifier's step.
    static func scrubUnits(_ dx: Double, step: Double) -> Double { dx * step }
}

// MARK: QA native round 2

/// Inspector numbers the panel normalises or reads with a unit.
enum FieldMath {
    /// Rotation as the panel shows it: (-180, 180]. 400 is 40, 270 is -90.
    static func angle(_ v: Double) -> Double {
        guard v.isFinite else { return 0 }
        var a = v.truncatingRemainder(dividingBy: 360)
        if a > 180 { a -= 360 }
        if a <= -180 { a += 360 }
        return NumericExpr.clean(a == 0 ? 0 : a)
    }

    /// Letter spacing typed into its field, in px. "-2%" is a percent of the font size, "1px" and "1" are px.
    static func tracking(_ text: String, current: Double?, fontSize: Double?) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces)
        if t.hasSuffix("%") {
            guard let size = fontSize, size > 0, let p = NumericExpr.evaluate(String(t.dropLast()), current: current.map { $0 / size * 100 }) else { return nil }
            return NumericExpr.clean(p * size / 100)
        }
        return NumericExpr.evaluate(t, current: current).map(NumericExpr.clean)
    }

    /// The smallest size: a typed 0 (or less) is 0.01, never an invisible layer.
    static let minSize = 0.01

    /// Typed text that applies to the current value ("+10", "*2", "/2"): on a Mixed field each layer takes it from its own.
    static func isRelative(_ text: String) -> Bool {
        guard let f = text.trimmingCharacters(in: .whitespaces).first else { return false }
        return "+*/^".contains(f)
    }
}

/// Option-scrub: the pointer's height from where the drag began sets the speed. Up (towards the top of the
/// screen) is 2x, near the start 1x, further down 1/2 and then 1/4. `dy` in points, down positive.
enum ScrubSpeed {
    static let band = 40.0, far = 120.0
    static func factor(dy: Double) -> Double {
        if dy < -band { return 2 }
        if dy <= band { return 1 }
        return dy <= far ? 0.5 : 0.25
    }
}

/// Lock aspect ratio beside W and H, kept per layer in metadata.canvasLockAspect (the file's extension slot;
/// the page reads it from the scene as lockAspect, src/scene.ts).
enum AspectLock {
    static let key = "canvasLockAspect"
    enum Axis { case width, height }
    static func isOn(_ node: [String: Any]) -> Bool { (node["metadata"] as? [String: Any])?[key] as? Bool == true }
    /// The metadata with the lock on or off, keeping anything else in it; nil when nothing would be left.
    static func metadata(_ current: Any?, on: Bool) -> [String: Any]? {
        var m = current as? [String: Any] ?? [:]
        if on {
            if !(m["type"] is String) { m["type"] = "canvas" }
            m[key] = true
            return m
        }
        m.removeValue(forKey: key)
        if m.isEmpty || (m.count == 1 && m["type"] as? String == "canvas") { return nil }
        return m
    }
    /// The other side's write when one side becomes `value` with the ratio locked; empty when there is no ratio.
    static func other(_ axis: Axis, _ value: Double, w: Double?, h: Double?) -> [String: Double] {
        guard let w, let h, w > 0, h > 0, value.isFinite else { return [:] }
        switch axis {
        case .width: return ["height": NumericExpr.clean(max(0.01, value * h / w))]
        case .height: return ["width": NumericExpr.clean(max(0.01, value * w / h))]
        }
    }
}

extension MixedStep {
    /// Each layer's new value for `key`, from its own: a number goes through `apply`; per-side stroke widths
    /// ({top, right, bottom, left}) keep their shape, each stroked side stepped and sides at 0 left at 0 (a Mixed
    /// weight step never turns a top-only stroke into all sides). Tokens and unknown layers are skipped.
    static func eachWrites(nodes: [String: [String: Any]], ids: [String], key: String, fallback: Double,
                           skip: (([String: Any]) -> Bool)? = nil, apply: (Double) -> Double?) -> [(id: String, value: Any)] {
        func number(_ v: Any?) -> Double? { (v as? NSNumber).flatMap { CFGetTypeID($0) == CFBooleanGetTypeID() ? nil : $0.doubleValue } }
        return ids.compactMap { id in
            guard let n = nodes[id], !(skip?(n) ?? false) else { return nil }
            let raw = n[key]
            if raw is String { return nil }
            if let d = raw as? [String: Any] {
                var out = d
                for (k, v) in d {
                    guard let x = number(v) else { continue }
                    if x == 0 { continue }
                    guard let y = apply(x) else { return nil }
                    out[k] = y
                }
                return (id, out)
            }
            guard let v = apply(number(raw) ?? fallback) else { return nil }
            return (id, v)
        }
    }

    /// "+10" (or "*2", "/2") typed in a Mixed field: every layer takes it from its own value. `scale` maps the file's
    /// value to the field's (opacity 0.5 shows 50); `skip` leaves a layer out.
    static func relativeWrites(nodes: [String: [String: Any]], ids: [String], key: String, text: String, scale: Double = 1,
                               fallback: Double, min lo: Double?, max hi: Double?, skip: (([String: Any]) -> Bool)? = nil) -> [(id: String, value: Any)] {
        guard FieldMath.isRelative(text) else { return [] }
        return eachWrites(nodes: nodes, ids: ids, key: key, fallback: fallback, skip: skip) { cur in
            NumericExpr.evaluate(text, current: cur * scale).map { NumericExpr.clean(NumericExpr.clamp($0 / scale, lo, hi)) }
        }
    }

    /// Up/Down on a Mixed field, structured values included (eachWrites).
    static func stepWrites(nodes: [String: [String: Any]], ids: [String], key: String, delta: Double, fallback: Double, min lo: Double?, max hi: Double?) -> [(id: String, value: Any)] {
        eachWrites(nodes: nodes, ids: ids, key: key, fallback: fallback) { NumericExpr.clean(NumericExpr.clamp($0 + delta, lo, hi)) }
    }
}

/// Edit > Repeat (src/repeat.ts on the server): the hint a write carries when its value was a change from the
/// layer's own ("+10", "*2", Up on a Mixed field), so a repeat does the same change, and the menu item's title.
enum RepeatHint {
    /// "+10" typed on one layer (or several sharing a value): the change in the file's units, from the value the layer
    /// had and the one written (a field may show the value scaled: opacity 50 for 0.5). nil when it was not relative.
    static func rel(_ text: String?, old: Double?, new: Double) -> [String: Any]? {
        guard let text, let f = text.trimmingCharacters(in: .whitespaces).first, "+*/".contains(f) else { return nil }
        if f == "+" { guard let old else { return nil }; return ["op": "+", "by": NumericExpr.clean(new - old)] }
        guard let factor = NumericExpr.evaluate(text, current: 1), factor.isFinite else { return nil }
        return ["op": "*", "by": factor]
    }
    /// The same for a one-key write to the selection: {key: {op, by}}, or nil.
    static func single(_ text: String?, props: [String: Any], node: [String: Any]) -> [String: Any]? {
        guard text != nil, props.count == 1, let (k, v) = props.first, !(v is Bool), let nv = (v as? NSNumber)?.doubleValue else { return nil }
        let ov = (node[k] as? NSNumber)?.doubleValue
        return rel(text, old: ov, new: nv).map { [k: $0] }
    }
    /// "+10" typed on a Mixed field: each layer takes it from its own value. `scale` maps the file's value to the field's.
    static func mixed(_ text: String, scale: Double = 1) -> [String: Any]? {
        guard let f = text.trimmingCharacters(in: .whitespaces).first, "+*/".contains(f) else { return nil }
        if f == "+" {
            guard let by = NumericExpr.evaluate(text, current: 0), scale != 0 else { return nil }
            return ["op": "+", "by": by / scale]
        }
        guard let factor = NumericExpr.evaluate(text, current: 1), factor.isFinite else { return nil }
        return ["op": "*", "by": factor]
    }
    /// Two queued writes merged: keys the later one sets plainly lose an earlier change; its own changes win.
    static func merge(_ a: [String: Any]?, _ b: [String: Any]?, keys: [String]) -> [String: Any]? {
        var r = a ?? [:]
        for k in keys { r.removeValue(forKey: k) }
        for (k, v) in b ?? [:] { r[k] = v }
        return r.isEmpty ? nil : r
    }
    /// The Edit menu's title: "Repeat Fill Change", or plain "Repeat" (disabled) with nothing to repeat.
    static func title(_ label: String?) -> String { label.map { "Repeat \($0)" } ?? "Repeat" }
}

/// The menu bar: what each menu holds, in order, with its key. main.swift wires each command to its action;
/// Tests/ShellLogicTests.swift checks the table (every expected item there, no key used twice).
enum MenuSpec {
    enum Mod: Hashable { case command, shift, option, control }
    struct Item: Equatable {
        let title: String
        let command: String
        var key = ""
        var mods: Set<Mod> = [.command]
        /// A key the page handles itself on the canvas: the item shows it but leaves the key press to the page.
        var pageKey = false
    }
    /// nil is a separator; a title starting with ">" opens a submenu that runs to the next "<".
    typealias Entry = Item?

    static func sub(_ title: String) -> Entry { Item(title: ">" + title, command: "", mods: []) }
    static let end: Entry = Item(title: "<", command: "", mods: [])

    static let app: [Entry] = [
        Item(title: "About Canvas", command: "about", mods: []),
        // Updates (Updater.swift): Restart to Update shows only while a verified update is waiting.
        Item(title: "Check for Updates\u{2026}", command: "checkForUpdates", mods: []),
        Item(title: "Restart to Update", command: "restartToUpdate", mods: []),
        nil,
        Item(title: "Settings\u{2026}", command: "settings", key: ","),
        nil,
        Item(title: "Hide Canvas", command: "hide", key: "h"),
        Item(title: "Hide Others", command: "hideOthers", key: "h", mods: [.command, .option]),
        Item(title: "Show All", command: "showAll", mods: []),
        nil,
        Item(title: "Quit Canvas", command: "quit", key: "q"),
    ]
    static let file: [Entry] = [
        Item(title: "New Canvas\u{2026}", command: "new", key: "n"),
        Item(title: "Open\u{2026}", command: "open", key: "o"),
        // Place image: a file picker for images, placed like a pasted image (src/page/drops.js).
        Item(title: "Place Image\u{2026}", command: "placeImage", key: "k", mods: [.command, .shift]),
        nil,
        Item(title: "Close Tab", command: "closeTab", key: "w"),
        nil,
        Item(title: "Save as Canvas\u{2026}", command: "saveAs", key: "s", mods: [.command, .shift]),
        // Shift+Cmd+E: the selection (else every layer on the page with export settings) with its settings.
        Item(title: "Export\u{2026}", command: "exportSettings", key: "e", mods: [.command, .shift]),
        // Sends the open file's comments to the team server set in Settings > Cloud (src/cloud.ts).
        Item(title: "Share Comments to Server\u{2026}", command: "shareComments", mods: []),
        nil,
        Item(title: "Reload Page", command: "reload", mods: []),
    ]
    static let edit: [Entry] = [
        Item(title: "Undo", command: "undo", key: "z"),
        Item(title: "Redo", command: "redo", key: "z", mods: [.command, .shift]),
        // "." like vim's repeat: one key, free in Canvas. The title names the edit (RepeatHint.title).
        Item(title: "Repeat", command: "repeat", key: ".", mods: [], pageKey: true),
        nil,
        Item(title: "Cut", command: "cut", key: "x"),
        Item(title: "Copy", command: "copy", key: "c"),
        // Cmd+L: a canvas:// link to the selection (or the board in view) for an agent's chat (src/page/link.js).
        Item(title: "Copy Link", command: "copyLink", key: "l"),
        // Shift+Cmd+C: a 2x PNG of the selection for other apps (Library.swift copyAs); the rest of Copy as
        // is in the right-click menu.
        Item(title: "Copy as PNG", command: "copyPNG", key: "c", mods: [.command, .shift]),
        Item(title: "Paste", command: "paste", key: "v"),
        Item(title: "Paste in Place", command: "pasteInPlace", key: "v", mods: [.command, .shift]),
        // Paste to replace: the selected layers give way to the clipboard's, in their place.
        Item(title: "Paste to Replace", command: "pasteReplace", key: "r", mods: [.command, .shift]),
        nil,
        Item(title: "Copy Properties", command: "copyProps", key: "c", mods: [.command, .option], pageKey: true),
        Item(title: "Paste Properties", command: "pasteProps", key: "v", mods: [.command, .option], pageKey: true),
        nil,
        Item(title: "Duplicate", command: "duplicate", key: "d"),
        // No key: Backspace and Delete reach the page (and native text fields) as plain keys.
        Item(title: "Delete", command: "delete", mods: []),
        nil,
        Item(title: "Select All", command: "selectAll", key: "a"),
        // Selection commands (src/page/shortcuts.js, src/search.ts matchActions). The menu owns their keys in
        // the app (a Shift+Cmd chord the menu declines never reaches the page); the page's in a browser.
        Item(title: "Select Inverse", command: "selectInverse", key: "a", mods: [.command, .shift]),
        Item(title: "Select Matching Layers", command: "selectMatching", key: "a", mods: [.command, .option]),
        sub("Select All with Same"),
        Item(title: "Fill", command: "selectSame:fill", mods: []),
        Item(title: "Stroke", command: "selectSame:stroke", mods: []),
        Item(title: "Effect", command: "selectSame:effect", mods: []),
        Item(title: "Text Properties", command: "selectSame:textStyle", mods: []),
        Item(title: "Font", command: "selectSame:font", mods: []),
        Item(title: "Instances", command: "selectSame:instances", mods: []),
        end,
        nil,
        // Find and replace: text on every page (src/page/find-replace.js).
        Item(title: "Find and Replace\u{2026}", command: "findReplace", key: "f"),
    ]
    static let view: [Entry] = [
        // Cmd+/ opens it too (the quick actions key); Palette.swift handles both keys before the menus.
        Item(title: "Quick Actions\u{2026}", command: "palette", key: "k"),
        nil,
        Item(title: "Zoom In", command: "zoomIn", key: "="),
        Item(title: "Zoom Out", command: "zoomOut", key: "-"),
        Item(title: "Zoom to 100%", command: "zoom100", key: "0", mods: [.shift], pageKey: true),
        Item(title: "Zoom to Fit", command: "zoomFit", key: "1", mods: [.shift], pageKey: true),
        Item(title: "Zoom to Selection", command: "zoomSelection", key: "2", mods: [.shift], pageKey: true),
        nil,
        // View toggles (src/page/navigate.js): the pixel grid from 400% up, rulers with guides.
        Item(title: "Pixel Grid", command: "pixelGrid", key: "'"),
        Item(title: "Rulers", command: "rulers", key: "r", mods: [.shift], pageKey: true),
        // Layout guides (layout grids): Control+G, owned by the menu; Shift+G works too, the page takes it.
        Item(title: "Layout Guides", command: "layoutGuides", key: "g", mods: [.control]),
        nil,
        Item(title: "Show/Hide UI", command: "toggleUI", key: "\\"),
        Item(title: "Show/Hide Properties", command: "toggleProperties", mods: []),
        nil,
    ]
    static let object: [Entry] = [
        Item(title: "Group Selection", command: "group", key: "g"),
        Item(title: "Frame Selection", command: "frame", key: "g", mods: [.command, .option]),
        Item(title: "Ungroup", command: "ungroup", key: "g", mods: [.command, .shift]),
        nil,
        Item(title: "Add Auto Layout", command: "addAutoLayout", key: "a", mods: [.shift], pageKey: true),
        Item(title: "Remove Auto Layout", command: "removeAutoLayout", key: "a", mods: [.option, .shift], pageKey: true),
        nil,
        Item(title: "Create Component", command: "component", key: "k", mods: [.command, .option], pageKey: true),
        Item(title: "Detach Instance", command: "detach", key: "b", mods: [.command, .option], pageKey: true),
        nil,
        Item(title: "Bring to Front", command: "front", key: "]", mods: [.command, .option]),
        Item(title: "Bring Forward", command: "forward", key: "]"),
        Item(title: "Send Backward", command: "backward", key: "["),
        Item(title: "Send to Back", command: "back", key: "[", mods: [.command, .option]),
        nil,
        Item(title: "Flip Horizontal", command: "flipH", key: "h", mods: [.shift], pageKey: true),
        Item(title: "Flip Vertical", command: "flipV", key: "v", mods: [.shift], pageKey: true),
        nil,
        Item(title: "Rename", command: "rename", key: "r"),
        Item(title: "Show/Hide Selection", command: "toggleHidden", key: "h", mods: [.command, .shift]),
        // Lock (src/page/shortcuts.js toggleLock); the menu owns the key in the app.
        Item(title: "Lock/Unlock Selection", command: "lock", key: "l", mods: [.command, .shift]),
        // Option+L is the page's key (it tells the shell); the item runs it from the menu.
        Item(title: "Collapse Layers", command: "collapseLayers", key: "l", mods: [.option], pageKey: true),
    ]
    static let arrange: [Entry] = [
        Item(title: "Align Left", command: "align-left", key: "a", mods: [.option], pageKey: true),
        Item(title: "Align Horizontal Centers", command: "align-hcenter", key: "h", mods: [.option], pageKey: true),
        Item(title: "Align Right", command: "align-right", key: "d", mods: [.option], pageKey: true),
        nil,
        Item(title: "Align Top", command: "align-top", key: "w", mods: [.option], pageKey: true),
        Item(title: "Align Vertical Centers", command: "align-vcenter", key: "v", mods: [.option], pageKey: true),
        Item(title: "Align Bottom", command: "align-bottom", key: "s", mods: [.option], pageKey: true),
        nil,
        Item(title: "Distribute Horizontal Spacing", command: "distribute-h", key: "h", mods: [.option, .shift], pageKey: true),
        Item(title: "Distribute Vertical Spacing", command: "distribute-v", key: "v", mods: [.option, .shift], pageKey: true),
        Item(title: "Tidy Up", command: "tidy", key: "t", mods: [.control, .option], pageKey: true),
    ]
    static let window: [Entry] = [
        // Home (Home.swift): the pinned first tab. Shift+Cmd+0 is free: the page's Shift+0 (zoom to 100%) has no Cmd.
        Item(title: "Home", command: "home", key: "0", mods: [.command, .shift]),
        nil,
        Item(title: "Minimize", command: "minimize", key: "m"),
        Item(title: "Zoom", command: "zoomWindow", mods: []),
        nil,
    ]

    static let help: [Entry] = [
        Item(title: "Report a Bug\u{2026}", command: "reportBug", mods: []),
        Item(title: "Download Latest Version\u{2026}", command: "downloadLatest", mods: []),
    ]

    static let menus: [(title: String, items: [Entry])] = [
        ("Canvas", app), ("File", file), ("Edit", edit), ("View", view), ("Object", object), ("Arrange", arrange), ("Window", window),
        ("Help", help),
    ]

    /// Key and modifiers, for finding a key bound twice.
    static func chord(_ i: Item) -> String? {
        guard !i.key.isEmpty else { return nil }
        let order: [Mod] = [.control, .option, .shift, .command]
        return order.filter { i.mods.contains($0) }.map { "\($0)" }.joined(separator: "+") + "+" + i.key
    }
}

/// Which file each tab showed in the left panel (Layers, Components, Widgets): a tab keeps its own.
enum PanelMemory {
    static func next<S>(_ saved: [String: S], leaving old: String?, current: S, opening new: String) -> (saved: [String: S], section: S?) {
        var s = saved
        if let old { s[old] = current }
        return (s, s[new])
    }
}

/// A hidden layer has no drawn box, so a size the file leaves to layout (Hug, Fill) would read empty: the panel keeps
/// the last size it saw drawn for that layer (W and H keep showing).
enum KnownSize {
    static func pick(drawn: Double?, known: Double?) -> Double? { drawn ?? known }
}

/// One web view per open tab (CanvasModel's tab pool): switching back to a tab shows its page as it was, engine,
/// laid-out boards and GPU tiles included, instead of loading it again. Hidden ones cost memory, so only the most
/// recently shown stay; the rest go back to "load when shown". `order` lists live tabs least recently shown first.
enum TabPool {
    /// How many web views stay alive, the shown one included.
    static let keep = 3

    /// The tabs to let go so at most `keep` stay: least recently shown first, never the shown one.
    static func evict(order: [String], active: String?, keep: Int = TabPool.keep) -> [String] {
        let hidden = order.filter { $0 != active }
        let room = max(0, keep - (active == nil ? 0 : 1))
        return hidden.count > room ? Array(hidden.prefix(hidden.count - room)) : []
    }

    /// macOS says memory is short: a warning lets go of the least recently shown hidden tab, a critical one of
    /// every hidden tab.
    static func onPressure(order: [String], active: String?, critical: Bool) -> [String] {
        let hidden = order.filter { $0 != active }
        return critical ? hidden : Array(hidden.prefix(1))
    }

    /// `order` after `key` was shown: it moves to the end (most recent).
    static func touch(_ order: [String], _ key: String) -> [String] { order.filter { $0 != key } + [key] }
}

/// What Cmd+V pastes when the pasteboard holds a picture (a screenshot, an image copied in another app, an image file
/// copied in Finder): Canvas's own copied layers win (their marker string), then an image file (Finder also puts the
/// file's icon on the pasteboard as TIFF, which is not the picture), then PNG, then TIFF. Nil: paste layers as before.
enum PasteImageSource: Equatable {
    case file(URL)
    case png
    case tiff
}

enum PasteImage {
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg"]

    static func choose(string: String?, fileURLs: [URL], hasPNG: Bool, hasTIFF: Bool) -> PasteImageSource? {
        if let s = string, s.hasPrefix("canvas-clipboard:") { return nil }
        if !fileURLs.isEmpty {
            // Files copied in Finder: an image file is the picture; other files are not Canvas's to paste.
            return fileURLs.first { imageExtensions.contains($0.pathExtension.lowercased()) }.map { .file($0) }
        }
        if hasPNG { return .png }
        if hasTIFF { return .tiff }
        return nil
    }

    /// The MIME type the page sends with the bytes.
    static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        default: return "image/png"
        }
    }
}

/// canvas:// links (Cmd+L, Edit > Copy Link): canvas://open?file=<path>&page=<id>&node=<id>,<id>. The page builds
/// them (src/page/link-logic.js, which documents the format); the shell opens them (AppDelegate in main.swift).
/// Values are percent-encoded, ids split on "," before decoding (an id's own "," is %2C), "+" is a plus.
struct CanvasLink: Equatable {
    let file: String
    let page: String?
    let nodes: [String]

    static func parse(_ url: URL) -> CanvasLink? { parse(url.absoluteString) }

    static func parse(_ text: String) -> CanvasLink? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = "canvas://open?"
        guard t.lowercased().hasPrefix(prefix) else { return nil }
        let query = t.dropFirst(prefix.count).split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        var file: String?, page: String?, nodes: [String] = []
        for part in query.split(separator: "&") {
            guard let eq = part.firstIndex(of: "=") else { continue }
            let k = String(part[..<eq]), v = String(part[part.index(after: eq)...])
            switch k {
            case "file": file = v.removingPercentEncoding
            case "page": page = v.removingPercentEncoding.flatMap { $0.isEmpty ? nil : $0 }
            case "node":
                var seen = Set<String>()
                nodes = []
                for raw in v.split(separator: ",") {
                    guard let id = String(raw).removingPercentEncoding else { return nil }
                    if !id.isEmpty, seen.insert(id).inserted { nodes.append(id) }
                }
            default: continue
            }
        }
        guard let f = file, f.hasPrefix("/"), !f.contains("\0") else { return nil }
        return CanvasLink(file: f, page: page, nodes: Array(nodes.prefix(200)))
    }

    /// The page command that shows it once the file's page is up (src/page/link.js openLink).
    var pageCommand: String {
        let ids = nodes.map { JSONText.string($0) }.joined(separator: ",")
        return "{cmd:'openLink',page:\(page.map { JSONText.string($0) } ?? "null"),ids:[\(ids)]}"
    }
}

/// A Swift string as a JavaScript string literal (JSON is valid JavaScript).
enum JSONText {
    static func string(_ s: String) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: [s]), let a = String(data: d, encoding: .utf8) else { return "\"\"" }
        return String(a.dropFirst().dropLast())
    }
}

/// Toasts you can act on (Model.flash, Toast in Components.swift): a click copies a toast's path or error, and an error
/// can go to the agent's composer. Plain news ("Link copied", "Exported 3 files") does neither.
enum ToastLogic {
    /// The first file path in the text: a quoted one whole (spaces kept), else one that starts with ~/ or names at least
    /// two folders, without the sentence's closing punctuation.
    static func path(in text: String) -> String? {
        let quoted = try! NSRegularExpression(pattern: "[\u{201C}\"']((?:~/|/)[^\u{201D}\"']+)[\u{201D}\"']")
        let bare = try! NSRegularExpression(pattern: "(?:^|[\\s(])((?:~/|/)[^\\s()\u{201C}\u{201D}\"']+)")
        let ns = text as NSString
        for re in [quoted, bare] {
            for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                var p = ns.substring(with: m.range(at: 1))
                while let last = p.last, ".,:;".contains(last) { p.removeLast() }
                if p.hasPrefix("~/") ? p.count > 2 : p.filter({ $0 == "/" }).count >= 2 { return p }
            }
        }
        return nil
    }

    private static let failure = try! NSRegularExpression(pattern: "\\b(could not|couldn\u{2019}t|couldn't|cannot|can\u{2019}t|can't|failed|will not start|did not (open|start|save|load|finish)|not found|error)\\b", options: [.caseInsensitive])

    /// Something went wrong (an error level, or words that say so). Success and link toasts never are.
    static func isError(_ text: String, level: String?) -> Bool {
        if level == "success" || level == "link" { return false }
        if level == "error" { return true }
        return failure.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
    }

    /// What a click on the toast copies: its path, else an error's text, else nothing (the toast is not clickable).
    static func copyText(_ text: String, level: String?) -> String? {
        if level == "success" || level == "link" { return nil }
        if let p = path(in: text) { return p }
        return isError(text, level: level) ? text : nil
    }

    /// What Ask agent puts in the composer: the toast quoted, on one line, for the person to send or edit.
    static func askPrompt(_ text: String) -> String {
        let one = text.components(separatedBy: .newlines).joined(separator: " ")
        return "Canvas showed this: \u{201C}\(one)\u{201D}. What does it mean, and can you fix it?"
    }
}

/// The first launch opens ~/Documents/Canvas/Welcome.canvas (POST /api/welcome, src/onboarding.ts) with the welcome
/// card: what Canvas is for and how to connect Claude Code or Codex. Only once, and never over someone's own files.
enum FirstRun {
    static let key = "canvas.welcomed"
    private static func qaSkips(_ env: [String: String]) -> Bool { env["CANVAS_QA"] == "1" && env["CANVAS_QA_FIRST_RUN"] != "1" }

    static func shouldWelcome(welcomed: Bool, lastFile: String?, openFiles: [String], env: [String: String]) -> Bool {
        !welcomed && lastFile == nil && openFiles.isEmpty && !qaSkips(env)
    }
    /// Someone who used Canvas before this version: never welcomed later, even after closing every tab.
    static func marksWelcomed(lastFile: String?, openFiles: [String], env: [String: String]) -> Bool {
        (lastFile != nil || !openFiles.isEmpty) && env["CANVAS_QA"] != "1"
    }
}

/// Styled ranges in a text layer (src/page/text-spans.js) as the inspector sees them. While a text is edited, the page
/// posts the selected letters and their style (src/page/text-edit.js postRange): the inspector shows that style
/// ("Mixed" where the letters differ) and a text style typed there goes to those letters. A layer with ranges, not
/// being edited, reads Mixed for every key its ranges set.
struct TextRangeState {
    let id: String
    let start: Int
    let end: Int
    let style: [String: Any]
    static let spanKeys: Set<String> = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fill", "underline", "strikethrough", "letterSpacing"]

    init?(_ d: [String: Any]) {
        guard let id = d["id"] as? String else { return nil }
        self.id = id
        start = (d["start"] as? NSNumber)?.intValue ?? 0
        end = (d["end"] as? NSNumber)?.intValue ?? start
        style = d["style"] as? [String: Any] ?? [:]
    }
    /// An inspector edit that only sets text styles: it goes to the selected letters.
    static func takes(_ props: [String: Any], remove: [String]) -> Bool {
        !props.isEmpty && remove.isEmpty && Set(props.keys).isSubset(of: spanKeys)
    }
    func mixed(_ key: String) -> Bool { (style[key] as? String) == "mixed" }
    /// The node as the inspector shows it with these letters selected: their values over the layer's.
    func overlay(_ node: [String: Any]) -> [String: Any] {
        var n = node
        for (k, v) in style where TextRangeState.spanKeys.contains(k) && !mixed(k) && !(v is NSNull) { n[k] = v }
        return n
    }
    /// The style keys a layer's ranges set anywhere.
    static func keysIn(_ spans: Any?) -> Set<String> {
        guard let list = spans as? [[String: Any]] else { return [] }
        return Set(list.flatMap { $0.keys }).intersection(spanKeys)
    }
}

/// Layout guides on a frame (layout grids): `metadata.canvasLayoutGuides`, a list of grid, columns and rows
/// guides. The page draws and snaps to them (src/page/layout-guides-logic.js holds the same rules and defaults).
enum LayoutGuides {
    static let key = "canvasLayoutGuides"
    /// The default: red at 10%.
    static let defaultColor = "#FF00001A"
    static let types: [(tag: String, title: String)] = [("grid", "Grid"), ("columns", "Columns"), ("rows", "Rows")]
    /// Columns: Left, Center, Right, Stretch; rows: Top, Center, Bottom, Stretch.
    static func aligns(_ type: String) -> [(tag: String, title: String)] {
        type == "rows" ? [("stretch", "Stretch"), ("start", "Top"), ("center", "Center"), ("end", "Bottom")]
                       : [("stretch", "Stretch"), ("start", "Left"), ("center", "Center"), ("end", "Right")]
    }

    static func list(_ metadata: Any?) -> [[String: Any]] {
        ((metadata as? [String: Any])?[key] as? [Any] ?? []).compactMap { $0 as? [String: Any] }.filter { types.map(\.tag).contains($0["type"] as? String ?? "") }
    }

    /// The metadata with this list, keeping anything else in it; nil when nothing would be left.
    static func metadata(_ current: Any?, _ list: [[String: Any]]) -> [String: Any]? {
        var m = current as? [String: Any] ?? [:]
        if list.isEmpty { m.removeValue(forKey: key) } else {
            if !(m["type"] is String) { m["type"] = "canvas" }
            m[key] = list
        }
        if m.isEmpty || (m.count == 1 && m["type"] as? String == "canvas") { return nil }
        return m
    }

    /// A new guide: a 10 px grid, or five stretched columns or rows with a 20 px gutter.
    static func make(_ type: String) -> [String: Any] {
        type == "grid" ? ["type": "grid", "size": 10, "color": defaultColor]
                       : ["type": type, "count": 5, "align": "stretch", "gutter": 20, "margin": 0, "color": defaultColor]
    }

    /// The guide as another type; its colour and visibility stay.
    static func withType(_ g: [String: Any], _ type: String) -> [String: Any] {
        var out = make(type)
        if let c = g["color"] { out["color"] = c }
        if let v = g["visible"] { out["visible"] = v }
        return out
    }

    /// Stretch takes a margin and no width; the others a width and (not centred) an offset from their edge.
    static func withAlign(_ g: [String: Any], _ align: String) -> [String: Any] {
        var out = g
        out["align"] = align
        if align == "stretch" {
            out.removeValue(forKey: "width"); out.removeValue(forKey: "offset")
            if out["margin"] == nil { out["margin"] = 0 }
        } else {
            out.removeValue(forKey: "margin")
            if out["width"] == nil { out["width"] = 60 }
            if align == "center" { out.removeValue(forKey: "offset") } else if out["offset"] == nil { out["offset"] = 0 }
        }
        return out
    }

    static func visible(_ g: [String: Any]) -> Bool { g["visible"] as? Bool != false }
    static func withVisible(_ g: [String: Any], _ on: Bool) -> [String: Any] {
        var out = g
        if on { out.removeValue(forKey: "visible") } else { out["visible"] = false }
        return out
    }

    /// What the row says: "Grid 10px", "5 columns", "3 rows".
    static func title(_ g: [String: Any]) -> String {
        let t = g["type"] as? String ?? "grid"
        if t == "grid" { let s = (g["size"] as? NSNumber)?.doubleValue ?? 10; return "Grid " + (s == s.rounded() ? String(Int(s)) : String(format: "%.1f", s)) + "px" }
        let n = (g["count"] as? NSNumber)?.intValue ?? 5
        return "\(n) \(t == "rows" ? (n == 1 ? "row" : "rows") : (n == 1 ? "column" : "columns"))"
    }
}

/// Lists on a text layer (src/page/text-paras.js): `lists`, one { p, type, level } per list paragraph. The inspector's
/// List style reads and writes the whole layer; while the text is edited the page applies it to the selected paragraphs.
enum TextLists {
    static func paragraphs(_ content: Any?) -> Int { ((content as? String) ?? "").components(separatedBy: "\n").count }
    /// "bullet" or "number" when every paragraph is that kind of list item, "none" when none is, nil when they differ.
    static func style(_ node: [String: Any]) -> String? {
        let items = (node["lists"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
        if items.isEmpty { return "none" }
        let types = Set(items.compactMap { $0["type"] as? String })
        return items.count == paragraphs(node["content"]) && types.count == 1 ? types.first : nil
    }
    /// Every paragraph a list item of `type` (keeping each item's level), or nil for none.
    static func lists(_ node: [String: Any], type: String) -> [[String: Any]]? {
        guard type == "bullet" || type == "number" else { return nil }
        let items = (node["lists"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
        return (0..<paragraphs(node["content"])).map { p in
            let level = (items.first { ($0["p"] as? NSNumber)?.intValue == p }?["level"] as? NSNumber)?.intValue ?? 1
            return ["p": p, "type": type, "level": level]
        }
    }
}

/// Letter case in Typography's Type details (`letterCase`, src/page/text-paras.js): the letters drawn in a case,
/// the file keeping them as typed: Uppercase, Lowercase, Capitalize (Title Case) and Small Caps.
enum LetterCase {
    static let options: [(value: String, title: String)] = [("original", "Original"), ("upper", "Uppercase"), ("lower", "Lowercase"), ("title", "Title case"), ("small-caps", "Small caps")]
    static func title(_ v: Any?) -> String { options.first { $0.value == (v as? String) }?.title ?? "Original" }
    /// What a pick writes: nil takes `letterCase` off (Original).
    static func write(_ value: String) -> String? { value == "original" || !options.contains { $0.value == value } ? nil : value }
}

/// OpenType features a font lists (Small caps needs `smcp`, offered only for fonts that have it).
enum OpenTypeFeatures {
    /// The feature tags in a GSUB table's feature list; none when the table is short or broken.
    static func gsub(_ t: Data) -> Set<String> {
        let b = [UInt8](t)
        func u16(_ i: Int) -> Int? { i + 1 < b.count ? Int(b[i]) << 8 | Int(b[i + 1]) : nil }
        guard let list = u16(6), let n = u16(list), list + 2 + n * 6 <= b.count else { return [] }
        var out = Set<String>()
        for k in 0..<n {
            let at = list + 2 + k * 6
            if let tag = String(bytes: b[at..<at + 4], encoding: .ascii) { out.insert(tag) }
        }
        return out
    }
    /// Text in this family is drawn with the system font (SF Pro).
    static func isSystem(_ family: String) -> Bool {
        let f = family.trimmingCharacters(in: .whitespaces).lowercased()
        return f.hasPrefix("sf pro") || f.hasPrefix("san francisco") || ["system-ui", "-apple-system", "blinkmacsystemfont", ".applesystemuifont"].contains(f)
    }
}

/// The website's pages for this build (getcanvas.cc): reporting a bug, the download page, and the release manifest the
/// app reads at launch and every 6 hours (AppUpdate, Updater.swift). The report link carries only the app's version
/// and commit, the macOS version and the architecture, each in the shape the page accepts (it ignores anything else):
/// nothing is sent until the person presses Send there. The manifest is a plain GET with no identifiers.
/// Canvas > About Canvas: "Version 0.1.0 (aede106)" and when this build was made (build.sh writes CanvasBuilt, UTC).
enum AboutInfo {
    static func versionLine(version: String, commit: String?) -> String {
        guard let c = commit, !c.isEmpty else { return "Version \(version)" }
        return "Version \(version) (\(c))"
    }

    /// The build time in the reader's own date and time format; nil without a readable time.
    static func builtLine(_ iso: String?, locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let iso, let d = ISO8601DateFormatter().date(from: iso) else { return nil }
        let f = DateFormatter()
        f.locale = locale; f.timeZone = timeZone
        f.dateStyle = .medium; f.timeStyle = .short
        return f.string(from: d)
    }
}

enum ReleaseLinks {
    static let site = "https://getcanvas.cc"
    static let download = URL(string: site + "/download")!
    static let manifest = URL(string: site + "/releases.json")!

    static func report(version: String, build: String?, os: OperatingSystemVersion, arch: String) -> URL {
        var c = URLComponents(string: site + "/report")!
        var q = [URLQueryItem(name: "from", value: "app")]
        if version.range(of: #"^[0-9A-Za-z.+-]{1,32}$"#, options: .regularExpression) != nil { q.append(URLQueryItem(name: "v", value: version)) }
        if let b = build, b.range(of: #"^[0-9a-f]{7,40}$"#, options: .regularExpression) != nil { q.append(URLQueryItem(name: "build", value: b)) }
        q.append(URLQueryItem(name: "os", value: osString(os)))
        if arch == "arm64" || arch == "x86_64" { q.append(URLQueryItem(name: "arch", value: arch)) }
        c.queryItems = q
        return c.url!
    }

    /// 15.2, or 15.2.1 when there is a patch version.
    static func osString(_ v: OperatingSystemVersion) -> String {
        v.patchVersion > 0 ? "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)" : "\(v.majorVersion).\(v.minorVersion)"
    }

    /// The manifest's latest version, when it is newer than `current`. Versions compare by their numeric parts
    /// (0.1.10 is newer than 0.1.9); a pre-release suffix ("-alpha.2") is older than the same version without one.
    static func newer(manifest: Data, than current: String) -> String? {
        guard let j = try? JSONSerialization.jsonObject(with: manifest) as? [String: Any],
              let latest = j["latest"] as? [String: Any], let v = latest["version"] as? String,
              v.range(of: #"^[0-9A-Za-z.+-]{1,32}$"#, options: .regularExpression) != nil else { return nil }
        return isNewer(v, than: current) ? v : nil
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        func parts(_ s: String) -> (nums: [Int], pre: String?) {
            let main = s.split(separator: "+", maxSplits: 1).first.map(String.init) ?? s
            let halves = main.split(separator: "-", maxSplits: 1).map(String.init)
            let nums = (halves.first ?? "").split(separator: ".").map { Int($0) ?? 0 }
            return (nums, halves.count > 1 ? halves[1] : nil)
        }
        let (x, y) = (parts(a), parts(b))
        for i in 0..<max(x.nums.count, y.nums.count) {
            let p = i < x.nums.count ? x.nums[i] : 0, q = i < y.nums.count ? y.nums[i] : 0
            if p != q { return p > q }
        }
        switch (x.pre, y.pre) {
        case (nil, nil): return false
        case (nil, _): return true
        case (_, nil): return false
        case let (p?, q?): return p.compare(q, options: .numeric) == .orderedDescending
        }
    }
}

// MARK: Updates

/// A downloaded copy of Canvas updates itself (Updater.swift does the network, the files and the processes; this is
/// the part the tests run). The manifest's latest release is downloaded from getcanvas.cc over https, checked
/// (`verdict`), and swapped in by a small /bin/sh helper after the app quits (`helperScript`).
enum AppUpdate {
    /// The manifest's `latest` entry (docs/developer-guide.md "Updates" lists the fields).
    struct Release: Equatable {
        let version: String
        let file: String
        let size: Int
        let sha256: String
        let minimumSystemVersion: String
        let arch: [String]
    }

    static let versionShape = #"^[0-9A-Za-z.+-]{1,32}$"#
    private static func matches(_ s: String, _ re: String) -> Bool { s.range(of: re, options: .regularExpression) != nil }

    /// Canvas-<anything plain>.zip: letters, digits and . _ + -, no folders, nothing that walks out of /download.
    static func isFileName(_ s: String) -> Bool {
        matches(s, #"^Canvas-[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}\.zip$"#) && !s.contains("..")
    }

    static func parse(_ data: Data) -> Release? {
        guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let l = j["latest"] as? [String: Any],
              let version = l["version"] as? String, matches(version, versionShape),
              let file = l["file"] as? String, isFileName(file),
              let n = l["size"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == n.doubleValue.rounded(),
              n.doubleValue > 0, n.doubleValue < 2_000_000_000,
              let sha = l["sha256"] as? String, matches(sha, #"^[0-9A-Fa-f]{64}$"#),
              let minOS = l["minimumSystemVersion"] as? String, matches(minOS, #"^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$"#) else { return nil }
        let arch = (l["arch"] as? [Any] ?? []).compactMap { $0 as? String }
        return Release(version: version, file: file, size: n.intValue, sha256: sha.lowercased(), minimumSystemVersion: minOS, arch: arch)
    }

    /// The website's manifest, or CANVAS_UPDATE_MANIFEST for the local end-to-end test (scripts/update-e2e.sh), only
    /// when it is plain http on 127.0.0.1: nothing else can point the app at another server.
    static func manifestSource(env: [String: String]) -> (url: URL, localTest: Bool) {
        if let s = env["CANVAS_UPDATE_MANIFEST"], let u = URL(string: s), isLocalTest(u) { return (u, true) }
        return (ReleaseLinks.manifest, false)
    }

    static func isLocalTest(_ u: URL) -> Bool {
        u.scheme == "http" && u.host == "127.0.0.1" && u.user == nil && u.password == nil
    }

    /// <site>/download/<file>: https://getcanvas.cc only, or the local test server the manifest came from.
    static func downloadURL(manifest: URL, file: String) -> URL? {
        guard isFileName(file), manifest.user == nil, manifest.password == nil else { return nil }
        if manifest.scheme == "https" && manifest.host == "getcanvas.cc" && manifest.port == nil {
            return URL(string: ReleaseLinks.site + "/download/" + file)
        }
        if isLocalTest(manifest) { return URL(string: "http://127.0.0.1" + (manifest.port.map { ":\($0)" } ?? "") + "/download/" + file) }
        return nil
    }

    /// The Mac's macOS is at least `minimum` ("26", "26.1", "27.0.1").
    static func meetsMinimum(_ minimum: String, os: OperatingSystemVersion) -> Bool {
        var m = minimum.split(separator: ".").map { Int($0) ?? 0 }
        while m.count < 3 { m.append(0) }
        let have = [os.majorVersion, os.minorVersion, os.patchVersion]
        for i in 0..<3 where have[i] != m[i] { return have[i] > m[i] }
        return true
    }

    /// A release this Mac takes: newer than the running version, a macOS it meets, its architecture (no list: any).
    static func offers(_ r: Release, current: String, os: OperatingSystemVersion, arch: String) -> Bool {
        ReleaseLinks.isNewer(r.version, than: current) && meetsMinimum(r.minimumSystemVersion, os: os) && (r.arch.isEmpty || r.arch.contains(arch))
    }

    /// The running app: its version, bundle id and the team identifier of its Developer ID signature (nil: ad-hoc or
    /// unsigned, which never updates itself).
    struct Own: Equatable {
        let version: String
        let bundleID: String
        let teamID: String?
    }

    /// What the checks found, in the order they run (nil: not run, which refuses like a failure).
    struct Facts: Equatable {
        var size: Int? = nil
        var sha256: String? = nil
        var unzipped = false
        var apps: [String] = []
        var bundleID: String? = nil
        var version: String? = nil
        var signatureValid: Bool? = nil
        var teamID: String? = nil
        var gatekeeper: Bool? = nil
    }

    enum Verdict: Equatable { case install, refuse(String) }

    /// Install only when every check passed; otherwise the first one that failed, in words. The local test
    /// (CANVAS_UPDATE_MANIFEST) skips Gatekeeper only: builds that are not notarized never pass it.
    static func verdict(_ f: Facts, release r: Release, own: Own, localTest: Bool) -> Verdict {
        guard let team = own.teamID, !team.isEmpty else { return .refuse("this copy of Canvas is not signed with a Developer ID, so it does not update itself") }
        guard f.size == r.size else { return .refuse("the download\u{2019}s size (\(f.size ?? 0) bytes) is not the release\u{2019}s (\(r.size) bytes)") }
        guard f.sha256?.lowercased() == r.sha256.lowercased() else { return .refuse("the download\u{2019}s SHA-256 is not the release\u{2019}s") }
        guard f.unzipped else { return .refuse("the download would not unzip") }
        guard f.apps == ["Canvas.app"] else { return .refuse("the download does not hold exactly one Canvas.app") }
        guard f.bundleID == own.bundleID else { return .refuse("the app in the download is not Canvas (\(f.bundleID ?? "no bundle id"))") }
        guard f.version == r.version else { return .refuse("the app in the download is version \(f.version ?? "unknown"), not \(r.version)") }
        guard ReleaseLinks.isNewer(r.version, than: own.version) else { return .refuse("the app in the download is not newer than this one (\(own.version))") }
        guard f.signatureValid == true else { return .refuse("the app\u{2019}s signature does not verify") }
        guard f.teamID == team else { return .refuse("the app is signed by a different developer") }
        guard localTest || f.gatekeeper == true else { return .refuse("macOS Gatekeeper does not accept the app as notarized") }
        return .install
    }

    enum Install: Equatable { case swap, manual(String) }

    /// Whether the app can replace itself where it is. Not when macOS runs it from a temporary copy (a quarantined
    /// app opened where it was downloaded) or when this account cannot change its folder: then the website.
    static func installMode(bundlePath: String, folderWritable: Bool, bundleWritable: Bool) -> Install {
        if bundlePath.contains("/AppTranslocation/") {
            return .manual("Move Canvas to the Applications folder to update it in place, or download it from the website.")
        }
        guard folderWritable && bundleWritable else {
            let folder = URL(fileURLWithPath: bundlePath).deletingLastPathComponent().lastPathComponent
            return .manual("This account doesn\u{2019}t have permission to change the \(folder) folder, so download it from the website.")
        }
        return .swap
    }

    /// One shell word: single quotes, an apostrophe closed, escaped and reopened.
    static func shQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: #"'\''"#) + "'" }

    /// The helper Canvas writes to its caches folder and runs, detached, as it quits: waits for `pid` to exit, copies
    /// the verified app next to the old one, moves the old one aside and the new one into its place (on failure the
    /// old one goes back), clears quarantine, deletes the download and the old copy, and opens the app again when
    /// `relaunch` (Restart to Update; a plain quit installs without opening). `env`: the CANVAS_* overrides the app
    /// was started with, so a relaunched test instance keeps its port and folders.
    static func helperScript(pid: Int32, app: String, staged: String, stagingRoot: String, log: String, relaunch: Bool, env: [(String, String)]) -> String {
        let dir = URL(fileURLWithPath: app).deletingLastPathComponent().path
        let name = URL(fileURLWithPath: app).lastPathComponent
        let open = (["/usr/bin/open"] + env.flatMap { ["--env", shQuote("\($0.0)=\($0.1)")] } + [#""$APP""#]).joined(separator: " ")
        return """
        #!/bin/sh
        # Canvas update helper, written by Canvas as it quit: waits for it to exit, puts the new version in its place
        # and opens it. On any failure the old app stays (or goes back) where it was.
        PID=\(pid)
        APP=\(shQuote(app))
        NEW=\(shQuote(staged))
        TMP=\(shQuote(dir + "/." + name + ".update-\(pid)"))
        BAK=\(shQuote(dir + "/." + name + ".previous-\(pid)"))
        STAGING=\(shQuote(stagingRoot))
        LOG=\(shQuote(log))
        RELAUNCH=\(relaunch ? 1 : 0)
        log() { printf '%s %s\\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null; }
        reopen() { if [ "$RELAUNCH" = 1 ]; then \(open); fi; }
        fail() { log "not installed: $*"; /bin/rm -rf "$TMP" 2>/dev/null; reopen; exit 1; }
        n=0
        while kill -0 "$PID" 2>/dev/null; do
          n=$((n + 1))
          if [ "$n" -gt 600 ]; then log "not installed: Canvas (pid $PID) was still running after a minute"; exit 1; fi
          /bin/sleep 0.1
        done
        /bin/rm -rf "$TMP" "$BAK" 2>/dev/null || fail "could not clear $TMP"
        /usr/bin/ditto "$NEW" "$TMP" || fail "could not copy the new version next to $APP"
        /bin/mv "$APP" "$BAK" || fail "could not move $APP aside"
        if ! /bin/mv "$TMP" "$APP"; then
          /bin/mv "$BAK" "$APP"
          fail "could not move the new version into $APP; the old one is back"
        fi
        /usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null
        /bin/rm -rf "$BAK"
        case "$STAGING" in */Updates) /bin/rm -rf "$STAGING" ;; esac
        log "installed $APP"
        reopen
        exit 0

        """
    }
}
