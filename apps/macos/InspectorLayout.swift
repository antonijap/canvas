// Auto layout in the properties panel: the section header ("+" to add, "−" and settings when
// on), Vertical / Horizontal flow and Wrap, the 3x3 alignment box with its keys, gap with Auto, padding
// horizontal / vertical or per side, Clip content, the settings popover (strokes, canvas stacking, text
// baseline, Auto gap spacing); W and H with Fixed / Hug / Fill and min/max; X and Y of a layer the flow places,
// with Ignore auto layout. Properties go through CanvasModel.update (one undo step each); add, remove and
// sizing go to the page as {cmd: 'layout', op} (CanvasModel.runLayout), which adds world rects and posts
// /api/layout. The value mapping lives in LayoutLogic.swift.

import SwiftUI
import AppKit

private typealias L = LayoutLogic

private func num(_ v: Any?) -> Double? { LayoutLogic.num(v) }
private func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

// MARK: what the panel needs to know beyond the node

/// The selected layer's parent (is it an auto layout frame, does it hug) and where the flow drew the layer
/// (for greyed X/Y and Ignore auto layout). The parent comes from /api/node; the position from the page's
/// world rects (window.canvasHost.worldRectOf), read only.
@MainActor final class LayoutProbe: ObservableObject {
    @Published private(set) var parent: [String: Any]?
    @Published private(set) var offset: CGPoint?
    private var target = ""
    private var revision = ""
    private var pending: DispatchWorkItem?

    func refresh(_ model: CanvasModel, _ s: Selection) {
        let t = [model.currentFile ?? "", s.id, s.parentId ?? "", s.ids.joined(separator: ",")].joined(separator: "\u{1F}")
        let sameTarget = t == target
        if sameTarget && revision == model.revision { return }
        target = t
        revision = model.revision
        pending?.cancel()
        guard let file = model.currentFile, s.ids.count <= 1, !s.isPath, !s.inInstance, let pid = s.parentId, pid != "document" else {
            parent = nil; offset = nil; return
        }
        if !sameTarget { parent = nil; offset = nil }
        // A new selection reads at once; edits to the same one (a scrub writes many revisions) settle first.
        let work = DispatchWorkItem { [weak self, weak model] in
            guard let self, let model else { return }
            self.load(model, file: file, id: s.id, parent: pid, target: t)
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (sameTarget ? 0.25 : 0), execute: work)
    }

    private func load(_ model: CanvasModel, file: String, id: String, parent pid: String, target t: String) {
        guard var c = URLComponents(url: model.base.appendingPathComponent("api/node"), resolvingAgainstBaseURL: false) else { return }
        c.setQuery([URLQueryItem(name: "file", value: file), URLQueryItem(name: "id", value: pid), URLQueryItem(name: "depth", value: "1")])
        guard let url = c.url else { return }
        URLSession.shared.dataTask(with: url) { data, response, _ in
            let node = (response as? HTTPURLResponse)?.statusCode == 200
                ? (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["node"] as? [String: Any] : nil
            DispatchQueue.main.async {
                guard self.target == t else { return }
                self.parent = node
                if let node, L.isAutoLayout(node) { self.measure(model, id: id, parent: pid, target: t) } else { self.offset = nil }
            }
        }.resume()
    }

    /// The layer's top-left inside its parent, as drawn now.
    private func measure(_ model: CanvasModel, id: String, parent pid: String, target t: String) {
        let js = "(() => { const h = window.canvasHost; if (!h || !h.worldRectOf) return null; const a = h.worldRectOf(\(jsString(id))), p = h.worldRectOf(\(jsString(pid))); return a && p ? [a.x - p.x, a.y - p.y] : null; })()"
        model.webView.evaluateJavaScript(js) { [weak self] r, _ in
            guard let self, self.target == t else { return }
            if let a = r as? [NSNumber], a.count == 2 { self.offset = CGPoint(x: round2(a[0].doubleValue), y: round2(a[1].doubleValue)) }
            else { self.offset = nil }
        }
    }
}

/// Keeps a LayoutProbe on the shown selection and document revision.
struct LayoutProbeRefresh: ViewModifier {
    @ObservedObject var probe: LayoutProbe
    @ObservedObject var model: CanvasModel
    let s: Selection

    func body(content: Content) -> some View {
        let key = [s.id, s.parentId ?? "", s.ids.joined(separator: ","), model.revision].joined(separator: "\u{1F}")
        content
            .onAppear { probe.refresh(model, s) }
            .onChange(of: key) { _, _ in probe.refresh(model, s) }
    }
}

// MARK: shared bits

/// Canvas draws this; other apps do not (the value lives in metadata.canvasLayout).
struct CanvasOnlyTag: View {
    let what: String
    var body: some View {
        Text("Canvas only").font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.mutedFg)
            .padding(.horizontal, 6).frame(height: 16)
            .background(Capsule().fill(Palette.hover))
            .fixedSize()
            .help("other apps draw this without \(what)")
            .accessibilityLabel("Canvas only: other apps draw this without \(what)")
    }
}

/// A row of text choices, one selected (SegmentedIcons with words).
struct TextSegments<Tag: Hashable>: View {
    let items: [(title: String, tag: Tag)]
    let selection: Tag?
    var enabled = true
    let onSelect: (Tag) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items.indices, id: \.self) { i in
                let item = items[i]
                Button { onSelect(item.tag) } label: {
                    Text(item.title).font(Typography.micro).lineLimit(1).minimumScaleFactor(0.85).qaText(item.title)
                        .foregroundStyle(selection == item.tag ? Palette.fg : Palette.mutedFg)
                        .frame(maxWidth: .infinity).frame(height: Metric.field - 4)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField - 2, style: .continuous)
                            .fill(selection == item.tag ? Palette.active : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == item.tag ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
        .opacity(enabled ? 1 : 0.5).disabled(!enabled)
    }
}

/// A chevron that opens a field's menu, the height of a field.
private struct FieldMenu<Items: View>: View {
    var help = ""
    var enabled = true
    @ViewBuilder var items: () -> Items
    @State private var hovering = false

    var body: some View {
        Menu(content: items) {
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                .foregroundStyle(hovering ? Palette.fg : Palette.mutedFg)
                .frame(width: 18, height: Metric.field)
                .contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .help(help).disabled(!enabled).opacity(enabled ? 1 : 0.4)
        .onHover { hovering = $0 }
    }
}

/// A writer for one selection: applies a LayoutLogic.Write through the inspector's write path.
private extension CanvasModel {
    func apply(_ w: LayoutLogic.Write) {
        if w.props.isEmpty && w.remove.isEmpty { return }
        update(w.props, remove: w.remove)
    }

    /// Canvas-only settings (wrap, line gap, Auto gap modes, baseline, stacking, min/max) through the server's
    /// `settings` op, which writes metadata.canvasLayout and the file's fallbacks in one undo step for every layer.
    func layoutSettings(_ s: Selection, _ patch: [String: Any?]) {
        if s.isPath || s.inInstance { flash("Its component sets the layout of a layer inside an instance; edit the component."); return }
        runLayout(["op": "settings", "ids": s.ids.count > 1 ? s.ids : [s.id], "layout": LayoutLogic.settingsPatch(patch)])
    }
}

// MARK: Position: X, Y and Ignore auto layout

/// X and Y. A layer the flow places shows where it was drawn, greyed (the parent decides); beside them the
/// Ignore auto layout toggle takes it out of the flow where it stands, or puts it back.
struct LayoutPositionFields: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var probe: LayoutProbe
    let s: Selection
    let editable: Bool

    var body: some View {
        let n = s.node
        let multi = s.ids.count > 1
        let parentFlows = !multi && probe.parent.map(L.isAutoLayout) == true
        let placed = parentFlows && !L.ignoresLayout(n)
        HStack(spacing: 8) {
            coordinate("x", placed ? probe.offset.map { Double($0.x) } : num(n["x"]), placed: placed, flip: placed || multi ? 0 : flipShift("flipX", "width"))
            coordinate("y", placed ? probe.offset.map { Double($0.y) } : num(n["y"]), placed: placed, flip: placed || multi ? 0 : flipShift("flipY", "height"))
            if parentFlows {
                ToggleIcons(items: [("pin", !placed, placed ? "Ignore auto layout" : "Ignore auto layout (on): placed by X and Y")],
                            enabled: editable && (!placed || probe.offset != nil)) { _, on in
                    if on, let o = probe.offset {
                        // Leaves the flow where it is drawn now: its x/y inside the frame.
                        model.apply(L.ignoreLayout(n, x: Double(o.x), y: Double(o.y), w: s.width, h: s.height))
                    } else if !on {
                        model.update([:], remove: ["layoutPosition", "x", "y"])
                    }
                }
                .frame(width: Metric.field + 8)
            }
        }
    }

    /// A flipped layer's stored x (y) is its right (bottom) edge: a flip mirrors about the layer's corner. The
    /// field shows the box's left (top) edge and writes the stored edge back.
    private func flipShift(_ flag: String, _ size: String) -> Double {
        guard s.node[flag] as? Bool == true else { return 0 }
        return num(s.node[size]) ?? (size == "width" ? s.width : s.height) ?? 0
    }

    private func coordinate(_ key: String, _ value: Double?, placed: Bool, flip: Double = 0) -> some View {
        let mixed = s.ids.count > 1 && s.mixed.contains(key)
        // Several layers: the server leaves out the ones auto layout places (src/autolayout.ts withoutPlacedXY).
        return NumberField(prefix: key.uppercased(), value: mixed ? nil : value.map { $0 - flip }, placeholder: mixed ? "Mixed" : "",
                           enabled: editable && !placed, onStep: { model.stepEach(key, by: $0) },
                           onRelative: { model.relativeEach(key, $0) }) { model.update([key: $0 + flip]) }
            .help(placed ? "Auto layout places this layer. Turn on Ignore auto layout to set its position." : "")
    }
}

// MARK: Lock aspect ratio

/// Lock aspect ratio, in the Dimensions caption row right above W and H (the fields keep their full width):
/// on, W and H keep their ratio when typed, scrubbed, dragged by a handle or changed by Cmd+arrows; Control frees one
/// handle drag. Kept per layer in metadata.canvasLockAspect (AspectLock in ShellLogic.swift).
struct AspectLockButton: View {
    @ObservedObject var model: CanvasModel
    let s: Selection
    let editable: Bool
    @State private var hovering = false

    var body: some View {
        let on = s.ids.count <= 1 && AspectLock.isOn(s.node)
        let enabled = editable && s.ids.count <= 1
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        Button {
            if let m = AspectLock.metadata(s.node["metadata"], on: !on) { model.update(["metadata": m]) }
            else { model.update([:], remove: ["metadata"]) }
        } label: {
            Image(systemName: on ? "lock" : "lock.open").font(.system(size: 11, weight: .medium))
                .foregroundStyle(on || hovering ? Palette.fg : Palette.mutedFg)
                .frame(width: 24, height: 24)
                .background(shape.fill(on ? Palette.active : hovering ? Palette.hover : .clear))
                .contentShape(shape)
        }
        .buttonStyle(.plain).disabled(!enabled).opacity(enabled ? 1 : 0.4)
        .help(on ? "Unlock aspect ratio" : "Lock aspect ratio")
        .accessibilityLabel("Lock aspect ratio")
        .accessibilityValue(on ? "On" : "Off")
        .accessibilityAddTraits(on ? [.isToggle, .isSelected] : .isToggle)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

// MARK: W and H with Fixed / Hug / Fill and min/max

struct LayoutSizeFields: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var probe: LayoutProbe
    let s: Selection
    let editable: Bool

    private var n: [String: Any] { s.node }
    private var multi: Bool { s.ids.count > 1 }
    private func mixed(_ key: String) -> Bool { multi && s.mixed.contains(key) }
    private var isText: Bool { n["type"] as? String == "text" }
    /// Lock aspect ratio, kept per layer (metadata.canvasLockAspect; AspectLock in ShellLogic.swift).
    private var locked: Bool { !multi && AspectLock.isOn(n) }
    /// Several layers: their parents are not known here, so Fill is offered and the server decides.
    private var inFlow: Bool { multi || L.inFlow(n, parent: probe.parent) }
    private func drawn(_ axis: L.Axis) -> Double? { multi ? nil : axis == .width ? s.width : s.height }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                column(.width)
                column(.height)
            }
            if L.hasLimits(n) {
                HStack(spacing: 6) {
                    CanvasOnlyTag(what: "min and max sizes")
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private func column(_ axis: L.Axis) -> some View {
        VStack(spacing: 8) {
            sizeField(axis)
            ForEach([false, true], id: \.self) { max in
                if let v = L.limit(n, axis, max: max) { limitField(axis, max: max, v) }
            }
        }
    }

    private func sizeField(_ axis: L.Axis) -> some View {
        let key = axis.rawValue
        let mode = L.sizing(n, axis)
        let modeMixed = mixed(key)
        // The smallest size is 0.01: a typed 0 never makes the layer vanish.
        return NumberField(prefix: axis == .width ? "W" : "H", value: num(n[key]) ?? drawn(axis),
                           placeholder: mixed(key) ? "Mixed" : "", enabled: editable, minimum: FieldMath.minSize,
                           onStep: { model.stepEach(key, by: $0, min: 1) },
                           onRelative: { model.relativeEach(key, $0, min: FieldMath.minSize) }) { v in
            // A typed size is Fixed; text that grew on its own stops growing on that axis.
            var w = L.typedSize(n, axis, v, w: drawn(.width), h: drawn(.height))
            // Lock aspect ratio: the other side follows, when it is a fixed size too.
            let other = axis == .width ? "height" : "width"
            if locked && !multi && num(n[other]) != nil {
                for (k, x) in AspectLock.other(axis == .width ? .width : .height, v, w: num(n["width"]) ?? drawn(.width), h: num(n["height"]) ?? drawn(.height)) { w.props[k] = x }
            }
            model.apply(w)
        }
        .overlay(alignment: .trailing) {
            HStack(spacing: 0) {
                if !modeMixed && mode != .fixed {
                    Text(mode.short).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).fixedSize()
                }
                FieldMenu(help: "\(axis == .width ? "Width" : "Height") resizing", enabled: editable) { menu(axis, current: modeMixed ? nil : mode) }
            }
            .padding(.trailing, 2)
        }
    }

    @ViewBuilder private func menu(_ axis: L.Axis, current: L.Sizing?) -> some View {
        ForEach([L.Sizing.fixed, .hug, .fill], id: \.self) { mode in
            let why = L.unavailable(mode, n, axis, inFlow: inFlow)
            Toggle(mode.title(axis), isOn: Binding(get: { current == mode }, set: { _ in if current != mode { apply(mode, axis) } }))
                .disabled(why != nil)
            if let why { Text(why) }
        }
        Divider()
        let noun = axis == .width ? "width" : "height"
        if L.limit(n, axis, max: false) == nil {
            Button("Add min \(noun)\u{2026}") { model.layoutSettings(s, [L.limitKey(axis, max: false): (drawn(axis) ?? num(n[axis.rawValue]) ?? 0).rounded()]) }
        }
        if L.limit(n, axis, max: true) == nil {
            Button("Add max \(noun)\u{2026}") { model.layoutSettings(s, [L.limitKey(axis, max: true): (drawn(axis) ?? num(n[axis.rawValue]) ?? 0).rounded()]) }
        }
        if L.limit(n, axis, max: false) != nil || L.limit(n, axis, max: true) != nil {
            Button("Remove min and max") { model.layoutSettings(s, [L.limitKey(axis, max: false): nil, L.limitKey(axis, max: true): nil]) }
        }
    }

    /// Text maps to its own resizing (textGrowth); anything else asks the server, which writes the size from the
    /// drawn rect and keeps the rule (Fill under a hugging parent makes the parent Fixed, in the same step).
    private func apply(_ mode: L.Sizing, _ axis: L.Axis) {
        let parentHugs = probe.parent.map { L.sizing($0, axis) == .hug } ?? false
        if isText && !multi && !(mode == .fill && parentHugs) {
            model.apply(L.textSizing(n, axis, mode, w: drawn(.width), h: drawn(.height)))
            return
        }
        var op: [String: Any] = ["op": "sizing", "id": s.id, "axis": axis.rawValue, "mode": mode.rawValue]
        if multi { op["ids"] = s.ids }
        model.runLayout(op)
    }

    private func limitField(_ axis: L.Axis, max: Bool, _ v: Double) -> some View {
        NumberField(prefix: max ? "Max" : "Min", value: v, enabled: editable, minimum: 0) { model.layoutSettings(s, [L.limitKey(axis, max: max): $0]) }
            .help("\(max ? "Maximum" : "Minimum") \(axis == .width ? "width" : "height")")
    }
}

// MARK: the Auto layout section

struct AutoLayoutSection: View {
    @ObservedObject var model: CanvasModel
    let s: Selection
    let editable: Bool
    @State private var individual = false
    /// Cmd+click on a padding field: the next value goes to every side.
    @State private var allSides = false
    @State private var settingsOpen = false

    private var n: [String: Any] { s.node }
    private var multi: Bool { s.ids.count > 1 }
    private func mixed(_ key: String) -> Bool { multi && s.mixed.contains(key) }
    private var on: Bool { L.isAutoLayout(n) && !mixed("layout") || (mixed("layout") && L.isFrame(n)) }
    private var flow: L.Flow { L.flow(n) }

    var body: some View {
        InspectorSection(title: "Auto layout", trailing: { header }) {
            if on {
                flowRow
                alignRow
                paddingRows
                let only = canvasOnly
                if !only.isEmpty {
                    HStack(spacing: 6) {
                        CanvasOnlyTag(what: only.joined(separator: ", ").lowercased())
                        Text(only.joined(separator: ", ")).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                }
            }
            if L.isFrame(n) {
                CheckField(title: "Clip content", isOn: n["clip"] as? Bool == true, enabled: editable) { v in
                    if v { model.update(["clip": true]) } else { model.update([:], remove: ["clip"]) }
                }
            }
        }
        .onChange(of: s.id) { _, _ in allSides = false; individual = false }
    }

    /// The Canvas-only values this frame uses (other apps draw it without them).
    private var canvasOnly: [String] {
        var out: [String] = []
        if L.wraps(n) { out.append("Wrap") }
        if L.gapMode(n) == .evenly { out.append("Space evenly") }
        if L.baseline(n) { out.append("Text baseline") }
        if L.firstOnTop(n) { out.append("First on top") }
        return out
    }

    // MARK: header

    @ViewBuilder private var header: some View {
        HStack(spacing: 2) {
            if on {
                MiniButton(symbol: "slider.horizontal.3", help: "Auto layout settings", enabled: editable) { settingsOpen = true }
                    .popover(isPresented: $settingsOpen, arrowEdge: .leading) { settings }
                MiniButton(symbol: "minus", help: "Remove auto layout  \u{2325}\u{21E7}A", enabled: editable) { model.runLayout(["op": "remove"]) }
            } else {
                MiniButton(symbol: "plus", help: "Add auto layout  \u{21E7}A", enabled: editable) { model.runLayout(["op": "add"]) }
            }
        }
    }

    // MARK: flow

    private var flowRow: some View {
        HStack(spacing: 8) {
            SegmentedIcons(items: [("arrow.down", L.Flow.vertical, "Vertical layout"), ("arrow.right", L.Flow.horizontal, "Horizontal layout")],
                           selection: mixed("layout") ? nil : flow, enabled: editable) { f in
                if f != flow || mixed("layout") { model.apply(L.setFlow(n, f)) }
            }
            ToggleIcons(items: [("arrow.turn.down.left", L.wraps(n), "Wrap")], enabled: editable) { _, v in model.layoutSettings(s, v ? ["wrap": true] : ["wrap": nil, "crossGap": nil, "crossAuto": nil]) }
                .frame(width: Metric.field + 16)
        }
    }

    // MARK: alignment and gap

    private var alignRow: some View {
        let c = L.cell(n)
        return HStack(alignment: .top, spacing: 8) {
            AlignmentBox(row: mixed("alignItems") ? nil : c.row, col: mixed("justifyContent") ? nil : c.col, flow: flow, auto: L.gapMode(n) != nil,
                         enabled: editable,
                         onCell: { r, col in model.apply(L.setCell(n, row: r, col: col)) },
                         onKey: key)
                .frame(width: 112, height: Metric.field * 2 + 8)
            VStack(spacing: 8) {
                gapField
                if L.wraps(n) { crossGapField }
            }
        }
    }

    /// The alignment box's keys: arrows and W/A/S/D move, X toggles Auto gap, B text baseline (horizontal).
    private func key(_ k: Character) -> Bool {
        guard editable else { return false }
        switch k {
        case "x":
            model.layoutSettings(s, ["gapMode": L.gapMode(n) == nil ? "between" : nil])
            return true
        case "b":
            guard flow == .horizontal, editable else { return false }
            model.layoutSettings(s, ["baseline": !L.baseline(n)])
            return true
        default:
            guard let to = L.moveCell(n, key: k) else { return true }
            model.apply(L.setCell(n, row: to.row, col: to.col))
            return true
        }
    }

    private var gapSymbol: String { flow == .vertical ? "arrow.up.and.line.horizontal.and.arrow.down" : "arrow.left.and.line.vertical.and.arrow.right" }
    private var crossSymbol: String { flow == .vertical ? "arrow.left.and.line.vertical.and.arrow.right" : "arrow.up.and.line.horizontal.and.arrow.down" }

    private var gapField: some View {
        let mode = L.gapMode(n)
        return HStack(spacing: 2) {
            if mode != nil {
                // Typing a number leaves Auto.
                NumberField(prefix: "", symbol: gapSymbol, value: nil, placeholder: "Auto", enabled: editable) { v in
                    var w = L.setGapMode(n, nil)
                    w.props["gap"] = v
                    model.apply(w)
                }
                .help("Gap between items: Auto (\(mode!.title.lowercased()))")
            } else {
                TokenNumberField(model: model, symbol: gapSymbol, raw: n["gap"], value: mixed("gap") ? nil : num(n["gap"]) ?? 0,
                                 placeholder: mixed("gap") ? "Mixed" : "", enabled: editable,
                                 onCommit: { model.update(["gap": $0]) },
                                 onBind: { model.update(["gap": "$" + $0]) },
                                 onDetach: { name in if let d = tokenNumber(name) { model.update(["gap": d]) } })
                    .help("Gap between items")
            }
            FieldMenu(help: "Gap options", enabled: editable) {
                Toggle("Auto", isOn: Binding(get: { mode != nil }, set: { v in model.layoutSettings(s, ["gapMode": v ? "between" : nil]) }))
                if mode != nil {
                    Divider()
                    ForEach(L.GapMode.allCases, id: \.self) { m in
                        Toggle(m.title + (m == .evenly ? " (Canvas only)" : ""), isOn: Binding(get: { mode == m }, set: { _ in model.layoutSettings(s, ["gapMode": m.rawValue]) }))
                    }
                }
            }
        }
    }

    /// Wrap: the gap between lines, with its own Auto (lines spread).
    private var crossGapField: some View {
        let auto = L.crossAuto(n)
        return HStack(spacing: 2) {
            NumberField(prefix: "", symbol: crossSymbol, value: auto ? nil : L.crossGap(n), placeholder: auto ? "Auto" : "",
                        enabled: editable, minimum: 0) { v in
                model.layoutSettings(s, ["crossGap": v, "crossAuto": nil])
            }
            .help("Gap between lines")
            FieldMenu(help: "Line gap options", enabled: editable) {
                Toggle("Auto", isOn: Binding(get: { auto }, set: { v in model.layoutSettings(s, ["crossAuto": v ? true : nil]) }))
            }
        }
    }

    // MARK: padding

    @ViewBuilder private var paddingRows: some View {
        let p = L.padding(mixed("padding") ? nil : n["padding"])
        let four = individual || (p.uneven && !mixed("padding"))
        if four {
            HStack(spacing: 8) {
                padField([.left], p[.left], symbol: "inset.filled.leftthird.square", help: "Left padding")
                padField([.top], p[.top], symbol: "inset.filled.topthird.square", help: "Top padding")
                individualToggle(on: true, p)
            }
            HStack(spacing: 8) {
                padField([.right], p[.right], symbol: "inset.filled.rightthird.square", help: "Right padding")
                padField([.bottom], p[.bottom], symbol: "inset.filled.bottomthird.square", help: "Bottom padding")
                Color.clear.frame(width: Metric.field, height: 1)
            }
        } else {
            HStack(spacing: 8) {
                padField([.left, .right], mixed("padding") ? nil : p.horizontal, symbol: "arrow.left.and.right", help: "Horizontal padding")
                padField([.top, .bottom], mixed("padding") ? nil : p.vertical, symbol: "arrow.up.and.down", help: "Vertical padding")
                individualToggle(on: false, p)
            }
        }
    }

    private func individualToggle(on: Bool, _ p: L.Padding) -> some View {
        MiniButton(symbol: on ? "square.dashed.inset.filled" : "square.dashed", help: on ? "Horizontal and vertical padding" : "Individual padding",
                   enabled: editable, inRow: true) {
            if on && p.uneven {
                // Back to two fields: left stands for horizontal, top for vertical.
                model.update(["padding": L.value(L.Padding(sides: [p[.top], p[.left], p[.top], p[.left]], form: .pair))])
            }
            individual = !on
        }
        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(on ? Palette.active : .clear))
    }

    @ViewBuilder private func padField(_ sides: [L.Side], _ v: L.PadValue?, symbol: String, help: String) -> some View {
        let targets = allSides ? L.Side.allCases : sides
        let write: (L.PadValue) -> Void = { value in
            model.update(["padding": L.setPadding(n["padding"], targets, to: value)])
            allSides = false
        }
        if case .token(let t)? = v, let name = tokenName(t) {
            TokenChip(model: model, name: name, kind: .number, symbol: symbol, enabled: editable,
                      onPick: { write(.token("$" + $0)) },
                      onDetach: { if let d = tokenNumber(name) { write(.num(d)) } })
                .help(help)
        } else {
            PadNumberField(model: model, symbol: symbol, value: v?.number, placeholder: v == nil ? "Mixed" : "",
                           enabled: editable, highlighted: allSides,
                           onCommit: { write(.num($0)) },
                           onList: { vals in model.update(["padding": L.setPaddingList(n["padding"], vals)]); allSides = false },
                           onBind: { write(.token("$" + $0)) },
                           onCmdClick: { allSides = true })
                .help(help + ". Cmd+click for all sides; type 1,2,3,4 for top, right, bottom, left.")
        }
    }

    /// A token's value for Detach, or a toast saying why there is none.
    private func tokenNumber(_ name: String) -> Double? {
        guard let v = model.tokenLiteral(name) else { model.flash("\(name) has no value to detach to"); return nil }
        if let d = Double(v.trimmingCharacters(in: CharacterSet(charactersIn: " px%"))) { return d }
        model.flash("\(name) is \(v), not a number")
        return nil
    }

    // MARK: settings popover

    private var settings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Auto layout settings").font(Typography.label).foregroundStyle(Palette.fg)
            settingRow("Strokes") {
                TextSegments(items: [("Included", true), ("Excluded", false)], selection: mixed("layoutIncludeStroke") ? nil : L.strokesIncluded(n), enabled: editable) { v in
                    if v { model.update(["layoutIncludeStroke": true]) } else { model.update([:], remove: ["layoutIncludeStroke"]) }
                }
            }
            settingRow("Canvas stacking", tag: L.firstOnTop(n) ? "first on top stacking" : nil) {
                TextSegments(items: [("First on top", true), ("Last on top", false)], selection: L.firstOnTop(n), enabled: editable) { v in
                    model.layoutSettings(s, ["stacking": v ? "first" : nil])
                }
            }
            if flow == .horizontal {
                HStack(spacing: 6) {
                    CheckField(title: "Align text baseline", isOn: L.baseline(n), enabled: editable) { v in model.layoutSettings(s, ["baseline": v ? true : nil]) }
                    if L.baseline(n) { CanvasOnlyTag(what: "text baseline alignment") }
                }
            }
            settingRow("Auto gap spacing", tag: L.gapMode(n) == .evenly ? "space evenly" : nil) {
                TextSegments(items: L.GapMode.allCases.map { ($0.title.replacingOccurrences(of: "Space ", with: "").capitalized, $0) },
                             selection: L.gapMode(n), enabled: editable && L.gapMode(n) != nil) { m in
                    model.layoutSettings(s, ["gapMode": m.rawValue])
                }
            }
            if L.gapMode(n) == nil {
                Text("Turn on Auto gap (X in the alignment box) to spread items.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14).frame(width: 260)
    }

    private func settingRow<C: View>(_ title: String, tag: String? = nil, @ViewBuilder _ control: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(title).font(Typography.micro).foregroundStyle(Palette.mutedFg)
                Spacer(minLength: 0)
                if let tag { CanvasOnlyTag(what: tag) }
            }
            control()
        }
    }
}

// MARK: the 3x3 alignment box

/// Nine cells; the active one draws the children's arrangement as bars in the flow direction (with Auto gap the
/// whole cross line shows them spread). Click a cell to align. With the box focused: arrows move, W/A/S/D go to an
/// edge, X toggles Auto gap, B text baseline.
private struct AlignmentBox: View {
    let row: Int?
    let col: Int?
    let flow: LayoutLogic.Flow
    let auto: Bool
    let enabled: Bool
    let onCell: (Int, Int) -> Void
    let onKey: (Character) -> Bool
    @FocusState private var focused: Bool
    @State private var hover: Int?

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<3, id: \.self) { r in
                HStack(spacing: 0) {
                    ForEach(0..<3, id: \.self) { c in cell(r, c) }
                }
            }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
        .overlay(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).stroke(Palette.sel, lineWidth: focused ? 1.5 : 0))
        .opacity(enabled ? 1 : 0.5)
        .focusable(enabled)
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(keys: [.upArrow, .downArrow, .leftArrow, .rightArrow]) { p in
            let k: Character = p.key == .upArrow ? "↑" : p.key == .downArrow ? "↓" : p.key == .leftArrow ? "←" : "→"
            return onKey(k) ? .handled : .ignored
        }
        .onKeyPress(characters: CharacterSet(charactersIn: "wasdxbWASDXB")) { p in
            guard let ch = p.characters.lowercased().first, p.modifiers.subtracting(.shift).isEmpty else { return .ignored }
            return onKey(ch) ? .handled : .ignored
        }
        .help("Alignment. With the box selected: arrow keys move, W A S D align to an edge, X turns Auto gap on or off, B aligns text baselines.")
    }

    private static let names = [["Top left", "Top center", "Top right"], ["Middle left", "Center", "Middle right"], ["Bottom left", "Bottom center", "Bottom right"]]

    private func isActive(_ r: Int, _ c: Int) -> Bool {
        if auto { return flow == .vertical ? c == col : r == row }
        return r == row && c == col
    }

    private func cell(_ r: Int, _ c: Int) -> some View {
        let active = isActive(r, c)
        let hovered = hover == r * 3 + c && enabled
        return Button {
            focused = true
            if !active { onCell(r, c) }
        } label: {
            ZStack {
                if active { bars(r, c, color: Palette.sel) }
                else if hovered { bars(r, c, color: Palette.mutedFg.opacity(0.7)) }
                else { Circle().fill(Palette.mutedFg.opacity(0.55)).frame(width: 3, height: 3) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled)
        .help("Align \(Self.names[r][c].lowercased())")
        .onHover { h in if h { hover = r * 3 + c } else if hover == r * 3 + c { hover = nil } }
        .accessibilityLabel("Align \(Self.names[r][c].lowercased())")
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    /// Three bars along the flow, aligned on the cross axis as the cell says. With Auto gap each cell of the line
    /// shows one bar, so the line reads as items spread.
    @ViewBuilder private func bars(_ r: Int, _ c: Int, color: Color) -> some View {
        let lengths: [CGFloat] = auto ? [10] : [7, 11, 5]
        if flow == .vertical {
            let align: HorizontalAlignment = c == 0 ? .leading : c == 1 ? .center : .trailing
            VStack(alignment: align, spacing: 2) {
                ForEach(lengths.indices, id: \.self) { i in Capsule().fill(color).frame(width: lengths[i], height: 2.5) }
            }
            .frame(width: 12, height: 12, alignment: Alignment(horizontal: align, vertical: .center))
        } else {
            let align: VerticalAlignment = r == 0 ? .top : r == 1 ? .center : .bottom
            HStack(alignment: align, spacing: 2) {
                ForEach(lengths.indices, id: \.self) { i in Capsule().fill(color).frame(width: 2.5, height: lengths[i]) }
            }
            .frame(width: 12, height: 12, alignment: Alignment(horizontal: .center, vertical: align))
        }
    }
}

// MARK: padding field

/// A padding number: scrubs, steps and takes arithmetic like every number field, plus "1,2,3,4" (top, right,
/// bottom, left) and Cmd+click to edit every side at once. Binds a token on hover.
private struct PadNumberField: View {
    @ObservedObject var model: CanvasModel
    let symbol: String
    let value: Double?
    var placeholder = ""
    let enabled: Bool
    let highlighted: Bool
    let onCommit: (Double) -> Void
    let onList: ([Double]) -> Void
    let onBind: (String) -> Void
    let onCmdClick: () -> Void
    @Environment(\.editTarget) private var target
    @State private var text = ""
    @State private var draft = FieldDraft()
    @State private var scrub: ScrubSession?
    @State private var hovering = false
    @State private var picking = false
    @FocusState private var focused: Bool

    var body: some View {
        FieldBox(disabled: !enabled) {
            ScrubHandle(enabled: enabled && value != nil, begin: {
                scrub = ScrubSession(start: NumericInput.evaluate(text, current: value) ?? value ?? 0, min: 0, max: nil, write: onCommit)
            }, move: { dx, step in if let s = scrub { text = NumberField.format(s.move(dx, step: step)) } },
               end: { scrub?.end(); scrub = nil }) {
                Image(systemName: symbol).glyph(11).foregroundStyle(highlighted ? Palette.sel : Palette.mutedFg)
            }
            .padding(.leading, -4).padding(.trailing, -2)
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain).font(Typography.body).monospacedDigit()
                .focused($focused).disabled(!enabled)
                .onSubmit(commit)
                .modifier(NumericKeys(text: $text, current: { value }, min: 0, max: nil,
                                      apply: { v in if enabled { onCommit(v) } }, revert: { sync(); focused = false }))
        }
        .overlay(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).stroke(Palette.sel, lineWidth: highlighted ? 1 : 0))
        .overlay { OptionScrub(enabled: enabled && value != nil, begin: {
            scrub = ScrubSession(start: NumericInput.evaluate(text, current: value) ?? value ?? 0, min: 0, max: nil, write: onCommit)
        }, move: { dx, step, speed in if let s = scrub { text = NumberField.format(s.move(dx, step: step, speed: speed)) } },
           end: { scrub?.end(); scrub = nil }) }
        .simultaneousGesture(TapGesture().onEnded { if NSEvent.modifierFlags.contains(.command) { onCmdClick() } })
        .modifier(BindOnHover(model: model, enabled: enabled, hovering: $hovering, picking: $picking, onBind: onBind))
        .modifier(FieldValueMenu.number(value, enabled: enabled, defaultValue: 0) { raw in
            let v = NumericInput.clean(max(0, raw))
            text = NumberField.format(v)
            draft.show(text, for: target)
            if v != value || highlighted { onCommit(v) }
        })
        .onAppear(perform: sync)
        .onChange(of: value) { _, _ in if (!focused || !draft.edited(text)) && scrub == nil { sync() } }
        .onChange(of: target) { _, _ in if scrub == nil { sync() } }
        .onChange(of: focused) { _, f in if !f { commit() } }
    }

    private func sync() { text = value.map(NumberField.format) ?? ""; draft.show(text, for: target) }

    private func commit() {
        guard draft.commits(text, target: target) else { sync(); return }
        guard enabled else { sync(); return }
        if let list = LayoutLogic.paddingList(text) { onList(list); return }
        guard let raw = NumericInput.evaluate(text, current: value) else { sync(); return }
        let v = NumericInput.clean(max(0, raw))
        // The same number with every side picked still writes: the other sides take it.
        guard v != value || highlighted else { sync(); return }
        text = NumberField.format(v)
        draft.show(text, for: target)
        onCommit(v)
    }
}
