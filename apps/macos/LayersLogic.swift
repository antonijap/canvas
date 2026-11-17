// The layers panel, the pure half: the outline the server sends (src/layers.ts), the rows the panel shows for
// what is expanded, Shift-click ranges, and where a dragged row lands as a place op (/api/layout `parent` and
// `before`). The order: in a frame the front-most layer is the top row, so a frame's children show last
// child first (a frame set to "first on top" shows them in file order). Boards keep the boards list's order.
// Layers.swift draws it; Tests/LayersLogicTests.swift checks this file on its own.

import Foundation

struct LayerNode: Equatable {
    let id: String
    var name: String
    let kind: String
    var hidden: Bool
    /// Locked: the canvas does not pick it or anything inside it.
    var locked: Bool
    /// A frame or a group: layers can be dropped inside it.
    let container: Bool
    /// The frame stacks its first child on top (metadata.canvasLayout.stacking "first").
    let firstOnTop: Bool
    var children: [LayerNode]

    init(id: String, name: String, kind: String, hidden: Bool = false, locked: Bool = false, container: Bool = false, firstOnTop: Bool = false, children: [LayerNode] = []) {
        self.id = id; self.name = name; self.kind = kind; self.hidden = hidden; self.locked = locked; self.container = container; self.firstOnTop = firstOnTop; self.children = children
    }

    /// The compact form /api/layers sends: {i, n, k, h?, l?, ct?, ft?, c?}.
    init?(json: [String: Any]) {
        guard let id = json["i"] as? String else { return nil }
        self.id = id
        name = json["n"] as? String ?? id
        kind = json["k"] as? String ?? "other"
        hidden = (json["h"] as? NSNumber)?.boolValue ?? false
        locked = (json["l"] as? NSNumber)?.boolValue ?? false
        container = (json["ct"] as? NSNumber)?.boolValue ?? false
        firstOnTop = (json["ft"] as? NSNumber)?.boolValue ?? false
        children = (json["c"] as? [[String: Any]] ?? []).compactMap(LayerNode.init(json:))
    }

    /// The children in the order the panel lists them (front-most first).
    var shownChildren: [LayerNode] { firstOnTop ? children : children.reversed() }
}

/// One line of the panel.
struct LayerRow: Identifiable, Equatable {
    let id: String
    let name: String
    let kind: String
    let depth: Int
    /// nil for a board.
    let parent: String?
    let board: String
    let hidden: Bool
    /// The layer or one of its parents is hidden: the row dims.
    let dimmed: Bool
    /// The layer itself is locked: its padlock shows closed and stays visible.
    var locked = false
    /// A parent is locked, so this layer is too (it cannot be unlocked on its own).
    var lockedAbove = false
    let container: Bool
    let hasChildren: Bool
    let expanded: Bool
    var isBoard: Bool { parent == nil }
}

/// A board on the page: its name from the boards list, its outline once loaded.
struct LayerBoard {
    let id: String
    let name: String
    let tree: LayerNode?
}

enum LayerDropZone: Equatable { case above, inside, below }

/// Where dropped layers go: `parent` nil is the document (they become boards), `before` nil is the end of the
/// parent's list in the file (the front).
struct LayerPlace: Equatable {
    let parent: String?
    let before: String?
}

enum LayersLogic {
    /// A row inside a component instance (path id "instance/child"): the component places and names it.
    static func insideInstance(_ id: String) -> Bool { id.contains("/") }

    /// What VoiceOver says after the name: the kind, and whether it is hidden or open.
    static func accessibilityValue(_ row: LayerRow) -> String {
        var parts: [String] = [kindName(row.kind)]
        if row.hidden { parts.append("hidden") }
        if row.locked || row.lockedAbove { parts.append("locked") }
        if row.hasChildren { parts.append(row.expanded ? "expanded" : "collapsed") }
        return parts.joined(separator: ", ")
    }

    static func kindName(_ kind: String) -> String {
        switch kind {
        case "frame", "frameH", "frameV": "frame"
        case "rect": "rectangle"
        case "vector": "vector"
        case "component": "main component"
        case "instance": "instance"
        default: kind
        }
    }

    /// The rows for what is expanded: every board, and the children of each expanded layer.
    static func rows(_ boards: [LayerBoard], expanded: Set<String>) -> [LayerRow] {
        var out: [LayerRow] = []
        func add(_ n: LayerNode, depth: Int, parent: String?, board: String, dimmed: Bool, lockedAbove: Bool, name: String? = nil) {
            let open = expanded.contains(n.id) && !n.children.isEmpty
            out.append(LayerRow(id: n.id, name: name ?? n.name, kind: n.kind, depth: depth, parent: parent, board: board, hidden: n.hidden,
                                dimmed: dimmed || n.hidden, locked: n.locked, lockedAbove: lockedAbove,
                                container: n.container, hasChildren: !n.children.isEmpty, expanded: open))
            guard open else { return }
            for c in n.shownChildren { add(c, depth: depth + 1, parent: n.id, board: board, dimmed: dimmed || n.hidden, lockedAbove: lockedAbove || n.locked) }
        }
        for b in boards {
            if let t = b.tree { add(t, depth: 0, parent: nil, board: b.id, dimmed: false, lockedAbove: false, name: b.name) }
            else {
                // Not loaded yet: the row shows, with a triangle that loads it.
                out.append(LayerRow(id: b.id, name: b.name, kind: "frame", depth: 0, parent: nil, board: b.id, hidden: false, dimmed: false,
                                    container: true, hasChildren: true, expanded: false))
            }
        }
        return out
    }

    /// Every layer under `n` that has children (Option-click on a triangle opens them all), `n` included.
    static func openable(_ n: LayerNode) -> [String] {
        guard !n.children.isEmpty else { return [] }
        return [n.id] + n.children.flatMap(openable)
    }

    /// Finds a layer in a tree.
    static func find(_ id: String, in n: LayerNode) -> LayerNode? {
        if n.id == id { return n }
        for c in n.children { if let f = find(id, in: c) { return f } }
        return nil
    }

    /// A drag down (or up) the lock column (lock many): the rows from `from` to `to` that lock on their own.
    /// A row a parent locks stays as it is (unlock the parent first), and a row inside an instance has no lock of its own.
    static func lockSweep(_ rows: [LayerRow], from: String, to: String) -> [String] {
        let byId = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return range(rows, from: from, to: to).filter { id in
            guard let r = byId[id] else { return false }
            return !r.lockedAbove && !insideInstance(id)
        }
    }

    /// Tab (Shift+Tab) while a name is being edited: the next (previous) row whose name can be edited, or nil.
    static func nextRename(_ rows: [LayerRow], from id: String, back: Bool) -> String? {
        guard let i = rows.firstIndex(where: { $0.id == id }) else { return nil }
        let order = back ? Array(rows[..<i].reversed()) : Array(rows[(i + 1)...])
        return order.first { !insideInstance($0.id) }?.id
    }

    /// The ids from `from` to `to` in the rows as shown (Shift-click), both included, in row order.
    static func range(_ rows: [LayerRow], from: String, to: String) -> [String] {
        guard let a = rows.firstIndex(where: { $0.id == from }), let b = rows.firstIndex(where: { $0.id == to }) else { return [to] }
        return rows[min(a, b)...max(a, b)].map(\.id)
    }

    /// Cmd-click: the id joins the selection, or leaves it.
    static func toggled(_ selection: [String], _ id: String) -> [String] {
        selection.contains(id) ? selection.filter { $0 != id } : selection + [id]
    }

    /// The zone of a row the pointer is in: a container's middle half drops inside it.
    static func zone(y: CGFloat, height: CGFloat, container: Bool) -> LayerDropZone {
        guard height > 0 else { return .below }
        let f = y / height
        if container { return f < 0.25 ? .above : f > 0.75 ? .below : .inside }
        return f < 0.5 ? .above : .below
    }

    /// The first sibling from `i` on (file order) that is not being moved: the layer the drop lands before.
    private static func anchor(_ siblings: [String], from i: Int, moving: Set<String>) -> String? {
        guard i < siblings.count else { return nil }
        return siblings[max(i, 0)...].first { !moving.contains($0) }
    }

    /// Where a drop on `row` in `zone` puts the moving layers, or nil when it cannot go there (into itself, into
    /// a layer inside it, into an instance or a leaf). `siblings(parent)` is the file order of a parent's children
    /// (nil: the boards, in the order the panel lists them); `ancestors(id)` the chain above a layer, board first.
    static func place(on row: LayerRow, zone: LayerDropZone, moving: Set<String>, firstOnTop: (String) -> Bool,
                      siblings: (String?) -> [String], ancestors: (String) -> [String]) -> LayerPlace? {
        guard !moving.isEmpty else { return nil }
        var parent: String?
        var listed: Bool // the parent lists its children in file order (boards, first on top frames)
        var result: LayerPlace?
        // Into the row itself: a drop on its middle, or just under an open container (its top row).
        if zone == .inside || (zone == .below && row.expanded && row.container) {
            guard row.container else { return nil }
            parent = row.id
            listed = firstOnTop(row.id)
            let kids = siblings(row.id)
            result = LayerPlace(parent: row.id, before: listed ? anchor(kids, from: 0, moving: moving) : nil)
        } else {
            parent = row.parent
            listed = row.parent.map(firstOnTop) ?? true
            let kids = siblings(row.parent)
            guard let i = kids.firstIndex(of: row.id) else { return nil }
            // Shown in file order: above the row is before it. Shown reversed: above the row is after it in the file.
            let from = listed ? (zone == .above ? i : i + 1) : (zone == .above ? i + 1 : i)
            result = LayerPlace(parent: row.parent, before: anchor(kids, from: from, moving: moving))
        }
        if let p = parent {
            if moving.contains(p) { return nil }
            if ancestors(p).contains(where: moving.contains) { return nil }
        }
        return result
    }
}

/// Rename Layers (Cmd+R with several layers): Match picks the part of each name to change (a regular
/// expression, or the text itself when it is not a valid one; empty: the whole name), Rename to is what goes there.
/// Tokens in Rename to: $& the current name (the matched text when Match is set), $` and $' the text before and after
/// the match, $1 to $9 the match's groups, $n / $nn / $nnn a number counting up from the start value (padded to that
/// many digits), $N / $NN / $NNN counting down to it, $$ a dollar sign. Numbers follow the order given (the Layers
/// panel's, top first). A name that would come out empty keeps the old one.
enum BatchRename {
    struct Change: Equatable { let old: String; let new: String }

    static func names(_ current: [String], match: String, to: String, start: Int?) -> [String] {
        let first = start ?? 1
        let regex: NSRegularExpression? = match.isEmpty ? nil
            : (try? NSRegularExpression(pattern: match)) ?? (try? NSRegularExpression(pattern: NSRegularExpression.escapedPattern(for: match)))
        return current.enumerated().map { i, name in
            let up = first + i, down = first + current.count - 1 - i
            let ns = name as NSString
            var out: String
            if match.isEmpty {
                out = expand(to, whole: name, groups: [], before: "", after: "", up: up, down: down)
            } else if let re = regex, let m = re.firstMatch(in: name, range: NSRange(location: 0, length: ns.length)) {
                let groups = (0..<m.numberOfRanges).map { k -> String in
                    let r = m.range(at: k)
                    return r.location == NSNotFound ? "" : ns.substring(with: r)
                }
                let before = ns.substring(to: m.range.location), after = ns.substring(from: m.range.location + m.range.length)
                out = before + expand(to, whole: groups[0], groups: groups, before: before, after: after, up: up, down: down) + after
            } else {
                out = name
            }
            return out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? name : out
        }
    }

    /// Whether Rename to has a number in it ($n or $N, not $$n): the sheet shows Start at only then.
    static func counts(_ to: String) -> Bool {
        let c = Array(to)
        var i = 0
        while i + 1 < c.count {
            if c[i] == "$" {
                if c[i + 1] == "$" { i += 2; continue }
                if c[i + 1] == "n" || c[i + 1] == "N" { return true }
            }
            i += 1
        }
        return false
    }

    /// The first `limit` names with what they become, for the sheet's preview.
    static func preview(_ current: [String], match: String, to: String, start: Int?, limit: Int = 6) -> [Change] {
        let next = names(current, match: match, to: to, start: start)
        return zip(current, next).prefix(limit).map { Change(old: $0.0, new: $0.1) }
    }

    private static func expand(_ to: String, whole: String, groups: [String], before: String, after: String, up: Int, down: Int) -> String {
        let c = Array(to)
        var out = ""
        var i = 0
        func pad(_ v: Int, _ w: Int) -> String { let s = String(v); return s.count >= w ? s : String(repeating: "0", count: w - s.count) + s }
        while i < c.count {
            guard c[i] == "$", i + 1 < c.count else { out.append(c[i]); i += 1; continue }
            let t = c[i + 1]
            switch t {
            case "$": out.append("$"); i += 2
            case "&": out += whole; i += 2
            case "`": out += before; i += 2
            case "'", "\u{2019}": out += after; i += 2
            case "n", "N":
                var w = 0
                while i + 1 + w < c.count && c[i + 1 + w] == t { w += 1 }
                out += pad(t == "n" ? up : down, w); i += 1 + w
            case "1"..."9":
                let k = Int(String(t))!
                out += k < groups.count ? groups[k] : ""; i += 2
            default: out.append("$"); i += 1
            }
        }
        return out
    }
}
