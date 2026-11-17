// Tests for LayoutLogic.swift: the auto layout controls against document values (alignment cells, Auto gap,
// resizing, padding forms, canvasLayout metadata).
// Run from apps/macos:
//   swiftc -parse-as-library LayoutLogic.swift Tests/LayoutLogicTests.swift -o /tmp/layout-tests && /tmp/layout-tests

import Foundation

@main
struct LayoutLogicTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
        checks += 1
        if !ok { failures += 1; print("FAIL line \(line): \(what())") }
    }

    static func main() {
        flow(); cells(); gap(); keys(); sizing(); text(); limits(); padding(); metadata(); extras()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    typealias L = LayoutLogic

    static func flow() {
        check(L.flow(["type": "frame"]) == .horizontal, "a frame without layout is horizontal (the file default)")
        check(L.flow(["type": "frame", "layout": "none"]) == .none, "layout none is freeform")
        check(L.flow(["type": "frame", "layout": "vertical"]) == .vertical, "vertical")
        check(L.flow(["type": "group"]) == .none && L.flow(["type": "text"]) == .none, "groups and text never lay out")
        let parent: [String: Any] = ["type": "frame"]
        check(L.inFlow(["type": "rectangle"], parent: parent), "child of a default frame is in the flow")
        check(!L.inFlow(["type": "rectangle", "layoutPosition": "absolute"], parent: parent), "absolute child is not")
        check(!L.inFlow(["type": "rectangle"], parent: ["type": "frame", "layout": "none"]), "child of a freeform frame is not")
        check(!L.inFlow(["type": "rectangle"], parent: nil), "a board is not")
        let w = L.setFlow(["type": "frame", "metadata": ["type": "canvas", "canvasLayout": ["baseline": true]]], .vertical)
        check(w.props["layout"] as? String == "vertical" && w.remove == ["metadata"], "vertical drops baseline and empty metadata: \(w)")
        // Hunt 6 #5: baseline's fallback alignItems "end" would right-align every child in a vertical flow.
        let b = L.setFlow(["type": "frame", "alignItems": "end", "metadata": ["type": "canvas", "canvasLayout": ["baseline": true]]], .vertical)
        check(b.remove.contains("alignItems") && b.remove.contains("metadata"), "vertical drops baseline's alignItems end: \(b)")
        let e = L.setFlow(["type": "frame", "alignItems": "end"], .vertical)
        check(e.remove.isEmpty, "a chosen end alignment without baseline stays: \(e)")
        // Hunt 6 #4: Ignore auto layout on a Fill child keeps the size drawn instead of collapsing.
        let ig = L.ignoreLayout(["type": "rectangle", "width": "fill_container", "height": 40], x: 10, y: 8, w: 180, h: 40)
        check(ig.props["layoutPosition"] as? String == "absolute" && ig.props["x"] as? Double == 10 && ig.props["width"] as? Double == 180 && ig.props["height"] == nil, "ignore on Fill writes the drawn width: \(ig)")
        let ig2 = L.ignoreLayout(["type": "frame", "width": 100, "height": "fill_container"], x: 0, y: 0, w: 100, h: 64)
        check(ig2.props["width"] == nil && ig2.props["height"] as? Double == 64, "only Fill axes become Fixed: \(ig2)")
    }

    // Acceptance: every 3x3 cell round trips for both flows.
    static func cells() {
        for flow in [L.Flow.horizontal, .vertical] {
            for row in 0...2 {
                for col in 0...2 {
                    let n: [String: Any] = ["type": "frame", "layout": flow.rawValue]
                    let w = L.setCell(n, row: row, col: col)
                    let back = L.cell(justify: w.props["justifyContent"], align: w.props["alignItems"], flow: flow)
                    check(back.row == row && back.col == col, "\(flow) cell \(row),\(col) round trips: \(w.props)")
                }
            }
        }
        let h = L.setCell(["type": "frame"], row: 0, col: 2)
        check(h.props["justifyContent"] as? String == "end" && h.props["alignItems"] as? String == "start", "horizontal: column is main axis")
        let v = L.setCell(["type": "frame", "layout": "vertical"], row: 2, col: 1)
        check(v.props["justifyContent"] as? String == "end" && v.props["alignItems"] as? String == "center", "vertical: row is main axis")
        let d = L.cell(["type": "frame"])
        check(d.row == 0 && d.col == 0, "defaults top left")
        // Auto gap: only the cross axis.
        let auto: [String: Any] = ["type": "frame", "justifyContent": "space_between", "alignItems": "center"]
        check(L.cell(auto).col == nil && L.cell(auto).row == 1, "auto gap has no main cell")
        let a = L.setCell(auto, row: 2, col: 0)
        check(a.props["justifyContent"] == nil && a.props["alignItems"] as? String == "end", "a cell in auto keeps space_between")
        // A cell ends baseline.
        let base: [String: Any] = ["type": "frame", "alignItems": "end", "metadata": ["type": "canvas", "canvasLayout": ["baseline": true]]]
        check(L.setCell(base, row: 0, col: 0).remove == ["metadata"], "picking a cell ends baseline")
    }

    // Acceptance: Auto gap is space_between; evenly is metadata plus space_around.
    static func gap() {
        let n: [String: Any] = ["type": "frame"]
        check(L.gapMode(n) == nil, "number gap")
        let between = L.setGapMode(n, .between)
        check(between.props["justifyContent"] as? String == "space_between" && L.gapMode(between.props.merging(n) { a, _ in a }) == .between, "Auto is space_between")
        let evenly = L.setGapMode(n, .evenly)
        check(evenly.props["justifyContent"] as? String == "space_around", "evenly falls back to space_around")
        let em = evenly.props["metadata"] as? [String: Any]
        check((em?["canvasLayout"] as? [String: Any])?["gapMode"] as? String == "evenly" && em?["type"] as? String == "canvas", "evenly in canvasLayout")
        check(L.gapMode(["justifyContent": "space_around", "metadata": em as Any]) == .evenly, "evenly read back")
        check(L.gapMode(["justifyContent": "space_around"]) == .around, "space_around alone is around")
        let off = L.setGapMode(["type": "frame", "justifyContent": "space_around", "metadata": em as Any], nil)
        check(off.props["justifyContent"] as? String == "start" && off.remove == ["metadata"], "Auto off drops gapMode")
        let around = L.setGapMode(["metadata": em as Any], .around)
        check(around.remove == ["metadata"] && around.props["justifyContent"] as? String == "space_around", "around drops evenly")
    }

    static func keys() {
        let n: [String: Any] = ["type": "frame", "justifyContent": "center", "alignItems": "center"]
        check(L.moveCell(n, key: "→").map { $0 == (1, 2) } == true, "right arrow")
        check(L.moveCell(n, key: "w").map { $0 == (0, 1) } == true, "W goes to the top edge")
        check(L.moveCell(["type": "frame"], key: "↑") == nil, "top edge stops")
        check(L.moveCell(n, key: "q") == nil, "other keys do nothing")
        let auto: [String: Any] = ["type": "frame", "justifyContent": "space_between"]
        check(L.moveCell(auto, key: "→") == nil, "auto: main axis keys do nothing")
        check(L.moveCell(auto, key: "s").map { $0.row == 2 } == true, "auto: cross axis moves")
    }

    // Acceptance: the resizing menu's modes and when Hug is refused.
    static func sizing() {
        let frame: [String: Any] = ["type": "frame", "width": 200, "height": "fit_content"]
        check(L.sizing(frame, .width) == .fixed && L.sizing(frame, .height) == .hug, "number fixed, fit_content hug")
        check(L.sizing(["type": "frame"], .width) == .hug, "no size on a frame hugs")
        check(L.sizing(["type": "rectangle", "width": "fill_container(320)"], .width) == .fill, "fill with fallback")
        check(L.sizing(["type": "rectangle", "width": "$w"], .width) == .fixed, "a token is fixed")
        let parent: [String: Any] = ["type": "frame", "children": [["type": "rectangle", "name": "Bar", "width": "fill_container"], ["type": "rectangle", "width": 10]]]
        check(L.unavailable(.hug, parent, .width, inFlow: false)?.contains("Bar") == true, "Hug refused with the filling child named")
        check(L.unavailable(.hug, parent, .height, inFlow: false) == nil, "the other axis can hug")
        let absolute: [String: Any] = ["type": "frame", "children": [["type": "rectangle", "width": "fill_container", "layoutPosition": "absolute"]]]
        check(L.unavailable(.hug, absolute, .width, inFlow: false) == nil, "an absolute child does not count")
        check(L.unavailable(.hug, ["type": "rectangle"], .width, inFlow: true) != nil, "a rectangle cannot hug")
        check(L.unavailable(.fill, ["type": "rectangle"], .width, inFlow: false) != nil, "fill needs auto layout around")
        check(L.unavailable(.fill, ["type": "rectangle"], .width, inFlow: true) == nil, "fill in a flow")
    }

    static func text() {
        let auto: [String: Any] = ["type": "text"]
        check(L.sizing(auto, .width) == .hug && L.sizing(auto, .height) == .hug, "auto width hugs both")
        let fw: [String: Any] = ["type": "text", "textGrowth": "fixed-width", "width": 120]
        check(L.sizing(fw, .width) == .fixed && L.sizing(fw, .height) == .hug, "auto height")
        let fill = L.textSizing(auto, .width, .fill, w: 80, h: 20)
        check(fill.props["width"] as? String == "fill_container" && fill.props["textGrowth"] as? String == "fixed-width", "fill width: fixed-width growth")
        let hug = L.textSizing(fw, .width, .hug, w: 80, h: 20)
        check(hug.props["textGrowth"] as? String == "auto" && hug.remove.contains("width"), "hug width is auto width")
        let fixedH = L.textSizing(auto, .height, .fixed, w: 80.4, h: 20)
        check(fixedH.props["textGrowth"] as? String == "fixed-width-height" && fixedH.props["width"] as? Double == 80 && fixedH.props["height"] as? Double == 20, "fixed height holds both: \(fixedH.props)")
        let typed = L.typedSize(auto, .width, 150, w: 80, h: 20)
        check(typed.props["width"] as? Double == 150 && typed.props["textGrowth"] as? String == "fixed-width", "typing a width stops auto width")
        check(L.typedSize(["type": "frame"], .height, 40, w: nil, h: nil).props["height"] as? Double == 40, "frames just take the number")
    }

    // Acceptance: min/max and the other Canvas-only settings go out as a settings patch (the server merges
    // canvasLayout, keeping foreign metadata); read back from canvasLayout here.
    static func limits() {
        let patch = L.settingsPatch([L.limitKey(.width, max: false): 120.0, L.limitKey(.height, max: true): nil])
        check(patch["minWidth"] as? Double == 120 && patch["maxHeight"] is NSNull, "nil is JSON null: \(patch)")
        check(JSONSerialization.isValidJSONObject(["layout": patch]), "patch serializes")
        let n: [String: Any] = ["type": "frame", "metadata": ["type": "other-plugin", "canvasLayout": ["minWidth": 120, "maxHeight": 300]]]
        check(L.limit(n, .width, max: false) == 120 && L.limit(n, .height, max: true) == 300 && L.hasLimits(n), "read back")
        check(!L.hasLimits(["type": "frame"]), "none")
    }

    // Acceptance: padding switches keep values; one value stays one value; Cmd+click all sides; "1,2,3,4".
    static func padding() {
        let one = L.padding(8)
        check(one.form == .one && one.horizontal == .num(8) && one.vertical == .num(8), "one value")
        check(L.value(one) as? Double == 8, "one value written back as one value")
        check(L.setPadding(8, [.left, .right], to: .num(8)) as? Double == 8, "unchanged stays one value")
        let pair = L.setPadding(8, [.left, .right], to: .num(16)) as? [Any]
        check(pair?.count == 2 && pair?[0] as? Double == 8 && pair?[1] as? Double == 16, "horizontal on one value widens to a pair")
        let keepPair = L.setPadding([4, 4], [.top, .bottom], to: .num(4)) as? [Any]
        check(keepPair?.count == 2, "a pair stays a pair even when equal")
        let four = L.setPadding([8, 16], [.top], to: .num(2)) as? [Any]
        check(four?.count == 4 && four?[0] as? Double == 2 && four?[1] as? Double == 16 && four?[2] as? Double == 8, "one side widens to four")
        let sides = L.padding([1, 2, 3, 4])
        check(sides.form == .four && sides.uneven && sides.horizontal == nil, "four uneven sides")
        check(L.setPadding([1, 2, 3, 4], L.Side.allCases, to: .num(6)) as? [Any] != nil, "all sides on a four form stays four")
        check(L.setPadding(nil, L.Side.allCases, to: .num(6)) as? Double == 6, "Cmd+click writes all sides as one value")
        let tok = L.padding(["$space.m", 12])
        check(tok.vertical == .token("$space.m") && tok.horizontal == .num(12), "tokens per side")
        check(L.paddingList("1,2,3,4") == [1, 2, 3, 4], "t, r, b, l")
        check(L.paddingList("8, 16") == [8, 16, 8, 16], "two values: v, h")
        check(L.paddingList("1 2 3") == [1, 2, 3, 2], "three values")
        check(L.paddingList("12") == nil && L.paddingList("1,x") == nil && L.paddingList("1,2,3,4,5") == nil, "not a list")
        check(L.setPaddingList(10, [1, 2, 3, 4]) as? [Any] != nil, "list widens")
        check(L.setPaddingList(10, [5, 5, 5, 5]) as? Double == 5, "equal list keeps one value")
    }

    static func metadata() {
        check(L.metadata(nil, setting: ["wrap": nil]) == nil, "nothing to keep")
        let m = L.metadata(["type": "canvas", "canvasLetterSpacing": "auto"], setting: ["wrap": true])
        check(m?["canvasLetterSpacing"] as? String == "auto" && (m?["canvasLayout"] as? [String: Any])?["wrap"] as? Bool == true, "auto tracking kept")
        let back = L.metadata(m, setting: ["wrap": nil])
        check(back?["canvasLayout"] == nil && back?["canvasLetterSpacing"] as? String == "auto", "removing the last layout key keeps the rest")
    }

    static func extras() {
        let n: [String: Any] = ["type": "frame", "metadata": ["type": "canvas", "canvasLayout": ["wrap": true, "crossGap": 12, "crossAuto": true, "stacking": "first"]]]
        check(L.wraps(n) && L.crossGap(n) == 12 && L.crossAuto(n) && L.firstOnTop(n), "frame settings read back")
        check(!L.wraps(["type": "frame"]) && !L.firstOnTop(["type": "frame"]), "absent is the default")
        check(!L.baseline(["type": "frame", "layout": "vertical", "metadata": ["canvasLayout": ["baseline": true]]]), "baseline only horizontal")
        check(L.baseline(["type": "frame", "metadata": ["canvasLayout": ["baseline": true]]]), "baseline horizontal")
        check(!L.strokesIncluded(["layoutIncludeStroke": false]) && L.strokesIncluded(["layoutIncludeStroke": true]), "strokes")
    }
}
