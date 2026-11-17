// Auto layout in the properties panel, the pure half: how file values map to the panel's controls and back.
// The flow of a frame (no `layout` key is horizontal, the default), Hug / Fill / Fixed per axis, the 3x3
// alignment box against `justifyContent` and `alignItems`, Auto gap modes, padding forms, and the Canvas-only
// extras kept in `metadata.canvasLayout` (wrap, cross gap, evenly, baseline, stacking, min/max), merged the
// way AutoTracking keeps its key. InspectorLayout.swift draws the controls; Tests/LayoutLogicTests.swift checks
// this file on its own. See .planning/research/auto-layout.md sections 1 and 2.

import Foundation

enum LayoutLogic {
    // MARK: flow

    enum Flow: String { case none, horizontal, vertical }

    static func str(_ v: Any?) -> String? { v as? String }
    static func num(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    }

    static func isFrame(_ n: [String: Any]) -> Bool { str(n["type"]) == "frame" }

    /// A frame lays out its children unless it says `layout: "none"`; no key means horizontal (the default).
    /// Groups, shapes and text never do.
    static func flow(_ n: [String: Any]) -> Flow {
        guard isFrame(n) else { return .none }
        return Flow(rawValue: str(n["layout"]) ?? "horizontal") ?? .horizontal
    }

    static func isAutoLayout(_ n: [String: Any]) -> Bool { flow(n) != .none }

    /// A layer the parent places: the parent is an auto layout frame and the layer does not ignore it.
    static func inFlow(_ child: [String: Any], parent: [String: Any]?) -> Bool {
        guard let parent, isAutoLayout(parent) else { return false }
        return !ignoresLayout(child)
    }

    static func ignoresLayout(_ n: [String: Any]) -> Bool { str(n["layoutPosition"]) == "absolute" }

    // MARK: metadata.canvasLayout

    static let metaKey = "canvasLayout"

    /// The Canvas-only layout keys of a node (empty when it has none).
    static func extras(_ n: [String: Any]) -> [String: Any] {
        (n["metadata"] as? [String: Any])?[metaKey] as? [String: Any] ?? [:]
    }

    /// The node's metadata with these canvasLayout keys set (nil value: removed). Keeps `type` and every key
    /// someone else put there; drops canvasLayout when it is empty, and returns nil when nothing would be left
    /// (the caller then removes `metadata`), as AutoTracking does.
    static func metadata(_ current: Any?, setting changes: [String: Any?]) -> [String: Any]? {
        var m = current as? [String: Any] ?? [:]
        var cl = m[metaKey] as? [String: Any] ?? [:]
        for (k, v) in changes {
            if let v { cl[k] = v } else { cl.removeValue(forKey: k) }
        }
        if cl.isEmpty { m.removeValue(forKey: metaKey) } else {
            if !(m["type"] is String) { m["type"] = "canvas" }
            m[metaKey] = cl
        }
        if m.isEmpty || (m.count == 1 && m["type"] as? String == "canvas") { return nil }
        return m
    }

    /// One inspector write: props to set and keys to remove.
    struct Write {
        var props: [String: Any] = [:]
        var remove: [String] = []
    }

    /// Props plus canvasLayout changes as one inspector write. Only for a native change that must drop a Canvas
    /// key in the same undo step (a cell click ends baseline, a typed gap ends Evenly); settings on their own go to
    /// the server's `settings` op (settingsPatch).
    static func write(_ n: [String: Any], props: [String: Any] = [:], remove: [String] = [], meta: [String: Any?]) -> Write {
        var w = Write(props: props, remove: remove)
        if meta.isEmpty { return w }
        if let m = metadata(n["metadata"], setting: meta) { w.props["metadata"] = m }
        else if n["metadata"] != nil { w.remove.append("metadata") }
        return w
    }

    /// A `settings` op's `layout` patch for /api/layout (src/autolayout.ts): nil removes a key (JSON null). The
    /// server writes canvasLayout and the native fallbacks (evenly: space_around, baseline: alignItems end).
    static func settingsPatch(_ p: [String: Any?]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in p { out[k] = v ?? NSNull() }
        return out
    }

    // MARK: wrap, stacking, baseline, strokes

    static func wraps(_ n: [String: Any]) -> Bool { extras(n)["wrap"] as? Bool == true }
    static func crossGap(_ n: [String: Any]) -> Double { num(extras(n)["crossGap"]) ?? 0 }
    static func crossAuto(_ n: [String: Any]) -> Bool { extras(n)["crossAuto"] as? Bool == true }
    static func firstOnTop(_ n: [String: Any]) -> Bool { str(extras(n)["stacking"]) == "first" }
    static func baseline(_ n: [String: Any]) -> Bool { flow(n) == .horizontal && extras(n)["baseline"] as? Bool == true }
    static func strokesIncluded(_ n: [String: Any]) -> Bool { n["layoutIncludeStroke"] as? Bool == true }

    /// Switching flow keeps children, gap and padding; baseline only exists in a horizontal flow. Leaving it also
    /// drops its native fallback (`alignItems: "end"`), which in a vertical flow would push every child right.
    static func setFlow(_ n: [String: Any], _ f: Flow) -> Write {
        let leaves = f == .vertical && extras(n)["baseline"] != nil
        let remove = leaves && str(n["alignItems"]) == "end" ? ["alignItems"] : []
        return write(n, props: ["layout": f.rawValue], remove: remove, meta: leaves ? ["baseline": nil] : [:])
    }

    /// Ignore auto layout on: the layer leaves the flow where it is drawn (x, y inside the frame). A Fill axis
    /// becomes Fixed at the size drawn, since an absolute layer has nothing to fill (it would collapse).
    static func ignoreLayout(_ n: [String: Any], x: Double, y: Double, w: Double?, h: Double?) -> Write {
        var props: [String: Any] = ["layoutPosition": "absolute", "x": x, "y": y]
        if sizing(n, .width) == .fill, let w { props["width"] = w }
        if sizing(n, .height) == .fill, let h { props["height"] = h }
        return Write(props: props)
    }

    // MARK: alignment box and Auto gap

    enum Align: Int, CaseIterable { case start = 0, center, end
        var fileValue: String { ["start", "center", "end"][rawValue] }
        init(file: Any?) {
            switch file as? String {
            case "center": self = .center
            case "end", "flex-end": self = .end
            default: self = .start
            }
        }
    }

    enum GapMode: String, CaseIterable { case between, around, evenly
        var title: String { ["Space between", "Space around", "Space evenly"][Self.allCases.firstIndex(of: self)!] }
    }

    /// Auto gap: Between is `space_between`, Around `space_around`, Evenly `space_around` plus metadata (the file format has no
    /// space-evenly, so it draws Around). nil: a number gap.
    static func gapMode(_ n: [String: Any]) -> GapMode? {
        switch str(n["justifyContent"]) {
        case "space_between": return .between
        case "space_around": return str(extras(n)["gapMode"]) == "evenly" ? .evenly : .around
        default: return nil
        }
    }

    static func setGapMode(_ n: [String: Any], _ mode: GapMode?) -> Write {
        switch mode {
        case .none: return write(n, props: ["justifyContent": "start"], meta: ["gapMode": nil])
        case .between?: return write(n, props: ["justifyContent": "space_between"], meta: ["gapMode": nil])
        case .around?: return write(n, props: ["justifyContent": "space_around"], meta: ["gapMode": nil])
        case .evenly?: return write(n, props: ["justifyContent": "space_around"], meta: ["gapMode": "evenly"])
        }
    }

    /// The box's active cell, row and column 0...2 (top-left first). With Auto gap the main axis has no cell (nil).
    static func cell(_ n: [String: Any]) -> (row: Int?, col: Int?) {
        cell(justify: n["justifyContent"], align: n["alignItems"], flow: flow(n))
    }

    static func cell(justify: Any?, align: Any?, flow: Flow) -> (row: Int?, col: Int?) {
        let auto = ["space_between", "space_around"].contains(justify as? String ?? "")
        let main: Int? = auto ? nil : Align(file: justify).rawValue
        let cross = Align(file: align).rawValue
        return flow == .vertical ? (main, cross) : (cross, main)
    }

    /// What clicking a cell writes. With Auto gap only the cross axis changes (justifyContent keeps its space_*).
    /// Picking a cell ends baseline alignment.
    static func setCell(_ n: [String: Any], row: Int, col: Int) -> Write {
        let f = flow(n)
        let main = f == .vertical ? row : col, cross = f == .vertical ? col : row
        var props: [String: Any] = ["alignItems": Align(rawValue: cross)!.fileValue]
        if gapMode(n) == nil { props["justifyContent"] = Align(rawValue: main)!.fileValue }
        return write(n, props: props, meta: extras(n)["baseline"] != nil ? ["baseline": nil] : [:])
    }

    /// The alignment box's keys: arrows move one cell, W/A/S/D go to an edge. With Auto gap only the cross axis
    /// moves. nil: nothing to do.
    static func moveCell(_ n: [String: Any], key: Character) -> (row: Int, col: Int)? {
        let f = flow(n)
        let c = cell(n)
        var row = c.row ?? 1, col = c.col ?? 1
        switch key {
        case "↑": row -= 1
        case "↓": row += 1
        case "←": col -= 1
        case "→": col += 1
        case "w": row = 0
        case "s": row = 2
        case "a": col = 0
        case "d": col = 2
        default: return nil
        }
        row = max(0, min(2, row)); col = max(0, min(2, col))
        if gapMode(n) != nil {
            // Only the cross axis: in a horizontal flow that is the row, in a vertical one the column.
            if f == .vertical { if col == c.col { return nil }; row = 1 } else { if row == c.row { return nil }; col = 1 }
        } else if row == c.row && col == c.col { return nil }
        return (row, col)
    }

    // MARK: resizing

    enum Axis: String { case width, height }
    enum Sizing: String { case fixed, hug, fill
        func title(_ axis: Axis) -> String {
            switch self {
            case .fixed: axis == .width ? "Fixed width" : "Fixed height"
            case .hug: "Hug contents"
            case .fill: "Fill container"
            }
        }
        var short: String { ["Fixed", "Hug", "Fill"][[Sizing.fixed, .hug, .fill].firstIndex(of: self)!] }
    }

    /// Fixed, Hug or Fill as the file says it. Text reads its `textGrowth` (auto width hugs both axes, auto height
    /// hugs the height); a frame without a size hugs; anything else without one is fixed.
    static func sizing(_ n: [String: Any], _ axis: Axis) -> Sizing {
        let raw = n[axis.rawValue]
        if let s = raw as? String {
            if s.hasPrefix("fill_container") { return .fill }
            if s.hasPrefix("fit_content") { return .hug }
            return .fixed // a $variable
        }
        if raw != nil { return .fixed }
        switch str(n["type"]) {
        case "text":
            let g = str(n["textGrowth"]) ?? "auto"
            if axis == .width { return g == "auto" ? .hug : .fixed }
            return g == "fixed-width-height" ? .fixed : .hug
        case "frame", "group": return .hug
        default: return .fixed
        }
    }

    /// Hug contents is for auto layout frames and text.
    static func canHug(_ n: [String: Any]) -> Bool { isAutoLayout(n) || str(n["type"]) == "text" }

    /// Hug + a Fill child is impossible: a frame hugs no axis a layer inside fills. Returns that layer's name.
    static func fillingChild(_ n: [String: Any], _ axis: Axis) -> String? {
        guard isAutoLayout(n), let kids = n["children"] as? [[String: Any]] else { return nil }
        let hit = kids.first { k in
            k["enabled"] as? Bool != false && !ignoresLayout(k) && sizing(k, axis) == .fill
        }
        return hit.map { str($0["name"]) ?? str($0["type"]) ?? "A layer" }
    }

    /// Why a mode is not offered here, or nil when it is.
    static func unavailable(_ mode: Sizing, _ n: [String: Any], _ axis: Axis, inFlow: Bool) -> String? {
        switch mode {
        case .fixed: return nil
        case .hug:
            if !canHug(n) { return "Hug works on auto layout frames and text" }
            if let child = fillingChild(n, axis) { return "\(child) fills this \(axis.rawValue), so the frame cannot hug it" }
            return nil
        case .fill: return inFlow ? nil : "Fill works on layers inside auto layout"
        }
    }

    /// A text layer's size mode as `textGrowth` (and width/height). Auto width hugs both axes, auto height hugs
    /// the height at a set width, fixed size holds both. `w`/`h`: the size it is drawn at now.
    static func textSizing(_ n: [String: Any], _ axis: Axis, _ mode: Sizing, w: Double?, h: Double?) -> Write {
        let growth = str(n["textGrowth"]) ?? "auto"
        func round(_ v: Double?) -> Any { (v ?? 100).rounded() }
        var props: [String: Any] = [:], remove: [String] = []
        if axis == .width {
            switch mode {
            case .hug:
                props["textGrowth"] = "auto"; remove = ["width", "height"]
            case .fixed, .fill:
                props["width"] = mode == .fill ? "fill_container" : round(w)
                if growth == "auto" { props["textGrowth"] = "fixed-width" }
            }
        } else {
            switch mode {
            case .hug:
                if growth != "auto" { props["textGrowth"] = "fixed-width" }
                if n["height"] != nil { remove = ["height"] }
                if props.isEmpty && remove.isEmpty { props["textGrowth"] = growth }
            case .fixed, .fill:
                props["height"] = mode == .fill ? "fill_container" : round(h)
                props["textGrowth"] = "fixed-width-height"
                if growth == "auto" { props["width"] = round(w) }
            }
        }
        return Write(props: props, remove: remove)
    }

    /// A size typed into W or H is Fixed; text that grew on its own stops growing on that axis.
    static func typedSize(_ n: [String: Any], _ axis: Axis, _ v: Double, w: Double?, h: Double?) -> Write {
        guard str(n["type"]) == "text" else { return Write(props: [axis.rawValue: v]) }
        var wr = textSizing(n, axis, .fixed, w: w, h: h)
        wr.props[axis.rawValue] = v
        return wr
    }

    // MARK: min and max

    static func limitKey(_ axis: Axis, max: Bool) -> String { (max ? "max" : "min") + (axis == .width ? "Width" : "Height") }

    static func limit(_ n: [String: Any], _ axis: Axis, max: Bool) -> Double? { num(extras(n)[limitKey(axis, max: max)]) }

    static func hasLimits(_ n: [String: Any]) -> Bool {
        [Axis.width, .height].contains { limit(n, $0, max: false) != nil || limit(n, $0, max: true) != nil }
    }

    // MARK: padding

    enum PadValue: Equatable {
        case num(Double), token(String)
        init(_ v: Any?) {
            if let s = v as? String, s.hasPrefix("$") { self = .token(s) }
            else { self = .num(LayoutLogic.num(v) ?? Double((v as? String) ?? "") ?? 0) }
        }
        var json: Any {
            switch self {
            case .num(let d): d
            case .token(let t): t
            }
        }
        var number: Double? { if case .num(let d) = self { d } else { nil } }
    }

    enum PadForm: Int { case one = 1, pair = 2, four = 4 }
    enum Side: Int, CaseIterable { case top, right, bottom, left }

    struct Padding: Equatable {
        var sides: [PadValue] // top, right, bottom, left
        var form: PadForm
        subscript(_ s: Side) -> PadValue {
            get { sides[s.rawValue] }
            set { sides[s.rawValue] = newValue }
        }
        /// Left and right when they agree; nil reads "Mixed".
        var horizontal: PadValue? { sides[3] == sides[1] ? sides[1] : nil }
        var vertical: PadValue? { sides[0] == sides[2] ? sides[0] : nil }
        /// Four fields needed to show it (top ≠ bottom or left ≠ right).
        var uneven: Bool { horizontal == nil || vertical == nil }
    }

    /// `padding` as four sides: a number is all four, `[v, h]` vertical and horizontal, `[t, r, b, l]` each.
    static func padding(_ raw: Any?) -> Padding {
        if let a = raw as? [Any] {
            if a.count == 2 { let v = PadValue(a[0]), h = PadValue(a[1]); return Padding(sides: [v, h, v, h], form: .pair) }
            if a.count >= 4 { return Padding(sides: a.prefix(4).map { PadValue($0) }, form: .four) }
            if a.count == 3 { let t = PadValue(a[0]), h = PadValue(a[1]), b = PadValue(a[2]); return Padding(sides: [t, h, b, h], form: .four) }
            let one = PadValue(a.first)
            return Padding(sides: [one, one, one, one], form: .one)
        }
        let one = PadValue(raw)
        return Padding(sides: [one, one, one, one], form: .one)
    }

    /// The value to write: the file's form when the change still fits it (one value stays one value while all
    /// sides agree, a pair stays a pair while top = bottom and left = right), the next wider form otherwise.
    static func value(_ p: Padding) -> Any {
        let s = p.sides
        let allSame = s.allSatisfy { $0 == s[0] }
        let symmetric = s[0] == s[2] && s[1] == s[3]
        switch p.form {
        case .one where allSame: return s[0].json
        case .one, .pair: if symmetric { return [s[0].json, s[1].json] }
        case .four: break
        }
        return s.map(\.json)
    }

    /// Sets some sides; one undo step whatever the form.
    static func setPadding(_ raw: Any?, _ sides: [Side], to v: PadValue) -> Any {
        var p = padding(raw)
        for side in sides { p[side] = v }
        return value(p)
    }

    /// "1,2,3,4" (or spaces): top, right, bottom, left; 1, 2 or 3 numbers expand like CSS.
    static func paddingList(_ text: String) -> [Double]? {
        let parts = text.split(whereSeparator: { $0 == "," || $0 == " " }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard text.contains(",") || parts.count > 1, (1...4).contains(parts.count) else { return nil }
        let vals = parts.compactMap(Double.init)
        guard vals.count == parts.count, vals.allSatisfy({ $0 >= 0 && $0.isFinite }) else { return nil }
        switch vals.count {
        case 1: return [vals[0], vals[0], vals[0], vals[0]]
        case 2: return [vals[0], vals[1], vals[0], vals[1]]
        case 3: return [vals[0], vals[1], vals[2], vals[1]]
        default: return vals
        }
    }

    /// Four typed sides into the file's form (widened when needed).
    static func setPaddingList(_ raw: Any?, _ vals: [Double]) -> Any {
        var p = padding(raw)
        p.sides = vals.map { PadValue.num($0) }
        return value(p)
    }
}
