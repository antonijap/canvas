// Tests for LayersLogic.swift: rows for what is expanded (front-most first), Shift ranges, Cmd toggles, drop zones
// and where a drop lands as a place op.
// Run from apps/macos:
//   swiftc -parse-as-library LayersLogic.swift Tests/LayersLogicTests.swift -o /tmp/layers-tests && /tmp/layers-tests

import Foundation

@main
struct LayersLogicTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
        checks += 1
        if !ok { failures += 1; print("FAIL line \(line): \(what())") }
    }

    static func main() {
        parse(); rows(); ranges(); zones(); places(); openable(); locks(); batchRename(); tabRename()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    // board B: frame F (children a, b, c in file order), text t, hidden group G (child g1); board C empty
    static let F = LayerNode(id: "F", name: "Card", kind: "frameV", container: true, children: [
        LayerNode(id: "a", name: "A", kind: "text"), LayerNode(id: "b", name: "B", kind: "rect"), LayerNode(id: "c", name: "C", kind: "instance"),
    ])
    static let G = LayerNode(id: "G", name: "Group", kind: "group", hidden: true, container: true, children: [LayerNode(id: "g1", name: "G1", kind: "ellipse")])
    static let B = LayerNode(id: "B", name: "Board", kind: "frame", container: true, children: [F, LayerNode(id: "t", name: "Title", kind: "text"), G])
    static let boards = [LayerBoard(id: "B", name: "Home", tree: B), LayerBoard(id: "C", name: "Other", tree: nil)]

    static func parse() {
        let n = LayerNode(json: ["i": "x", "n": "X", "k": "frameH", "h": 1, "ct": 1, "ft": 1, "c": [["i": "y", "n": "Y", "k": "text"], ["n": "no id"]]])
        check(n?.id == "x" && n?.hidden == true && n?.container == true && n?.firstOnTop == true, "flags read")
        check(n?.children.map(\.id) == ["y"], "children without an id are skipped")
        check(LayerNode(json: ["n": "x"]) == nil, "no id, no node")
    }

    static func rows() {
        let closed = LayersLogic.rows(boards, expanded: [])
        check(closed.map(\.id) == ["B", "C"], "boards only when nothing is open")
        check(closed[0].name == "Home", "a board row takes the boards list's name")
        check(closed[1].hasChildren && !closed[1].expanded, "a board not loaded yet still has a triangle")
        let open = LayersLogic.rows(boards, expanded: ["B", "F", "G"])
        check(open.map(\.id) == ["B", "G", "g1", "t", "F", "c", "b", "a", "C"], "front-most first: last child on top, \(open.map(\.id))")
        check(open.first { $0.id == "a" }?.depth == 2 && open.first { $0.id == "a" }?.parent == "F", "depth and parent")
        check(open.first { $0.id == "g1" }?.dimmed == true && open.first { $0.id == "g1" }?.hidden == false, "children of a hidden layer dim")
        check(open.first { $0.id == "t" }?.dimmed == false, "siblings of a hidden layer do not")
        var first = F
        first = LayerNode(id: first.id, name: first.name, kind: first.kind, container: true, firstOnTop: true, children: first.children)
        let b2 = LayerNode(id: "B", name: "Board", kind: "frame", container: true, children: [first])
        check(LayersLogic.rows([LayerBoard(id: "B", name: "B", tree: b2)], expanded: ["B", "F"]).map(\.id) == ["B", "F", "a", "b", "c"], "first on top lists in file order")
        check(LayersLogic.rows(boards, expanded: ["F"]).map(\.id) == ["B", "C"], "an open layer under a closed board stays hidden")
        check(LayersLogic.rows(boards, expanded: ["B", "t"]).first { $0.id == "t" }?.expanded == false, "a leaf never shows open")
    }

    static func ranges() {
        let r = LayersLogic.rows(boards, expanded: ["B", "F", "G"])
        check(LayersLogic.range(r, from: "c", to: "a") == ["c", "b", "a"], "range down")
        check(LayersLogic.range(r, from: "a", to: "t") == ["t", "F", "c", "b", "a"], "range up, row order")
        check(LayersLogic.range(r, from: "zz", to: "a") == ["a"], "unknown anchor: just the row")
        check(LayersLogic.toggled(["a", "b"], "a") == ["b"] && LayersLogic.toggled(["a"], "c") == ["a", "c"], "Cmd toggles")
    }

    static func zones() {
        check(LayersLogic.zone(y: 2, height: 32, container: false) == .above && LayersLogic.zone(y: 20, height: 32, container: false) == .below, "leaf halves")
        check(LayersLogic.zone(y: 4, height: 32, container: true) == .above, "container top quarter")
        check(LayersLogic.zone(y: 16, height: 32, container: true) == .inside, "container middle")
        check(LayersLogic.zone(y: 30, height: 32, container: true) == .below, "container bottom quarter")
    }

    static func places() {
        let r = LayersLogic.rows(boards, expanded: ["B", "F", "G"])
        let row = { (id: String) in r.first { $0.id == id }! }
        var tree: [String: LayerNode] = [:]
        func walk(_ n: LayerNode) { tree[n.id] = n; n.children.forEach(walk) }
        walk(B)
        let parents: [String: String] = ["F": "B", "t": "B", "G": "B", "a": "F", "b": "F", "c": "F", "g1": "G"]
        func ancestors(_ id: String) -> [String] { var o: [String] = []; var c = parents[id]; while let p = c { o.insert(p, at: 0); c = parents[p] }; return o }
        func place(_ id: String, _ z: LayerDropZone, _ moving: Set<String>) -> LayerPlace? {
            LayersLogic.place(on: row(id), zone: z, moving: moving, firstOnTop: { tree[$0]?.firstOnTop ?? false },
                              siblings: { p in p.map { tree[$0]?.children.map(\.id) ?? [] } ?? ["B", "C"] }, ancestors: ancestors)
        }
        // F shows c, b, a (file a, b, c).
        check(place("c", .above, ["a"]) == LayerPlace(parent: "F", before: nil), "above the top row: the front (end of the file list)")
        check(place("b", .above, ["a"]) == LayerPlace(parent: "F", before: "c"), "between c and b: before c in the file")
        check(place("b", .below, ["c"]) == LayerPlace(parent: "F", before: "b"), "below b: before b")
        check(place("a", .below, ["c"]) == LayerPlace(parent: "F", before: "a"), "below the last row: the back")
        check(place("b", .below, ["b"]) == LayerPlace(parent: "F", before: "c"), "a layer dropped on itself skips itself as anchor")
        check(place("t", .inside, ["a"]) == nil, "a text holds nothing")
        check(place("c", .inside, ["a"]) == nil, "an instance holds nothing")
        check(place("G", .inside, ["a"]) == LayerPlace(parent: "G", before: nil), "into a group: its front")
        check(place("F", .below, ["t"]) == LayerPlace(parent: "F", before: nil), "just under an open frame: its top row")
        check(place("a", .above, ["F"]) == nil, "a frame cannot go inside itself")
        check(place("G", .inside, ["B"]) == nil, "a board cannot go inside its own layer")
        check(place("B", .above, ["t"]) == LayerPlace(parent: nil, before: "B"), "above a board: a new board before it")
        check(place("C", .below, ["B"]) == LayerPlace(parent: nil, before: nil), "below the last board: the end")
        check(place("B", .inside, ["a"]) == LayerPlace(parent: "B", before: nil), "into a board")
        check(place("a", .above, []) == nil, "nothing dragged")
    }

    static func openable() {
        check(LayersLogic.openable(B) == ["B", "F", "G"], "Option-click opens every layer with children")
        check(LayersLogic.find("g1", in: B)?.name == "G1" && LayersLogic.find("zz", in: B) == nil, "find")
    }

    static func locks() {
        // {l: 1} is a locked layer; a locked frame locks its children.
        let n = LayerNode(json: ["i": "L", "n": "Locked", "k": "frame", "l": 1, "ct": 1, "c": [["i": "k", "n": "Kid", "k": "rect"]]])!
        check(n.locked && !n.children[0].locked, "the outline's l flag")
        let b = LayerNode(id: "B", name: "Board", kind: "frame", container: true, children: [n, LayerNode(id: "u", name: "U", kind: "rect")])
        let rows = LayersLogic.rows([LayerBoard(id: "B", name: "Home", tree: b)], expanded: ["B", "L"])
        let r = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        check(r["L"]!.locked && !r["L"]!.lockedAbove, "the locked row")
        check(!r["k"]!.locked && r["k"]!.lockedAbove, "its child is locked by it")
        check(!r["u"]!.locked && !r["u"]!.lockedAbove, "a sibling is not")
        check(LayersLogic.accessibilityValue(r["L"]!).contains("locked"), "VoiceOver says locked")
        check(LayersLogic.accessibilityValue(r["k"]!).contains("locked"), "and for a child locked by its parent")
        // A drag across the lock column: every row it crosses, except those a parent locks and those inside an instance.
        // rows: B, u, L, k (front-most first)
        check(LayersLogic.lockSweep(rows, from: "B", to: "k") == ["B", "u", "L"], "the sweep skips a row its parent locks")
        check(LayersLogic.lockSweep(rows, from: "L", to: "u") == ["u", "L"], "upwards too")
        let inst = LayersLogic.rows([LayerBoard(id: "B", name: "Home", tree: LayerNode(id: "B", name: "B", kind: "frame", container: true, children: [
            LayerNode(id: "I", name: "I", kind: "instance", children: [LayerNode(id: "I/x", name: "X", kind: "rect")])]))], expanded: ["B", "I"])
        check(LayersLogic.lockSweep(inst, from: "I", to: "I/x") == ["I"], "a row inside an instance does not lock on its own")
    }

    static func batchRename() {
        let names = ["Card", "Card copy", "Button"]
        func r(_ to: String, match: String = "", start: Int? = nil, _ list: [String] = names) -> [String] { BatchRename.names(list, match: match, to: to, start: start) }
        check(r("Item") == ["Item", "Item", "Item"], "Rename to alone replaces the whole name")
        check(r("$& $n") == ["Card 1", "Card copy 2", "Button 3"], "current name and an ascending number")
        check(r("Row $nn") == ["Row 01", "Row 02", "Row 03"], "$nn pads to two digits")
        check(r("Row $nnn", start: 9) == ["Row 009", "Row 010", "Row 011"], "$nnn from a start value")
        check(r("Row $N") == ["Row 3", "Row 2", "Row 1"], "$N counts down to 1")
        check(r("Row $NN", start: 5) == ["Row 07", "Row 06", "Row 05"], "descending stops at the start value")
        check(r("Tile", match: "Card") == ["Tile", "Tile copy", "Button"], "Match replaces only the matched part; no match keeps the name")
        check(r("$2_$1", match: "([a-zA-Z]+)_(\\d+)", ["Icon_003", "Logo_12"]) == ["003_Icon", "12_Logo"], "regex groups")
        check(r("[$&]", match: "copy") == ["Card", "Card [copy]", "Button"], "$& is the matched text when Match is set")
        check(r("$`|$'", match: "r", ["Card"]) == ["CaCa|dd"], "before and after the match (JavaScript's replace)")
        check(r("x", match: "(", ["a(b"]) == ["axb"], "a Match that is not a valid pattern matches literally")
        check(r("") == names, "an empty result keeps the old name")
        check(r("$$n") == ["$n", "$n", "$n"], "$$ is a dollar sign")
        check(BatchRename.counts("$& $n") && BatchRename.counts("Row $NN") && BatchRename.counts("$$$n"), "a number token shows Start at")
        check(!BatchRename.counts("$&") && !BatchRename.counts("$$n") && !BatchRename.counts("Row n") && !BatchRename.counts("$"), "no number token: Start at stays hidden")
        check(BatchRename.preview(names, match: "", to: "$& $n", start: nil, limit: 2) == [("Card", "Card 1"), ("Card copy", "Card copy 2")].map { BatchRename.Change(old: $0.0, new: $0.1) }, "preview: the first rows")
    }

    static func tabRename() {
        let rows = LayersLogic.rows(boards, expanded: ["B", "F"])
        // rows: B, F, c, b, a, t, G, C
        check(LayersLogic.nextRename(rows, from: "F", back: false) == "c", "Tab: the next row's name")
        check(LayersLogic.nextRename(rows, from: "c", back: true) == "F", "Shift+Tab: the previous row")
        check(LayersLogic.nextRename(rows, from: "C", back: false) == nil, "past the last row: nowhere")
        let inst = LayersLogic.rows([LayerBoard(id: "B", name: "Home", tree: LayerNode(id: "B", name: "B", kind: "frame", container: true, children: [
            LayerNode(id: "y", name: "Y", kind: "rect"), LayerNode(id: "I", name: "I", kind: "instance", children: [LayerNode(id: "I/x", name: "X", kind: "rect")])]))], expanded: ["B", "I"])
        // rows: B, I, I/x, y
        check(LayersLogic.nextRename(inst, from: "I", back: false) == "y", "a row inside an instance is skipped (the component names it)")
    }
}
