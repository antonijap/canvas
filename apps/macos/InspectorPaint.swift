// Fill, Stroke, Effects and independent corners in the properties panel: "+" stacks paints and
// effects, each row has an eye and a "-", rows reorder by dragging the grip (or the row's context menu), a colour
// shows its hex and opacity apart, strokes have position, weight and sides, effects are drop shadow, inner
// shadow, layer blur and background blur. PaintLogic.swift holds the value mapping.

import SwiftUI
import UniformTypeIdentifiers

/// Node types whose sides can be stroked one by one: rectangles and frames.
private let SIDED = ["frame", "rectangle"]
/// Node types that carry `effect` in the Canvas schema.
private let EFFECTED = ["frame", "group", "rectangle", "ellipse", "polygon", "path", "text", "icon", "ref"]

extension InspectorBody {
    private var nodeType: String { n["type"] as? String ?? "" }

    /// An instance (or a layer inside one) draws its component's paints unless it overrides them: removing its last
    /// fill, stroke or effect writes an empty list, so the component's do not come back.
    private var inheritsPaint: Bool { nodeType == "ref" || s.inInstance }

    /// Right-click Reset on a changed property: an instance's (or a layer inside one's) overridden fill,
    /// stroke, effects, opacity or text properties, one layer at a time. Empty elsewhere.
    func overrideResets(_ section: OverrideLabels.Section) -> [(title: String, keys: [String])] {
        guard inheritsPaint, s.ids.count <= 1 else { return [] }
        return OverrideLabels.resetItems(section, overrides: s.overrides)
    }

    /// A section's right-click menu with those Reset items (rows with a menu of their own add them there).
    func resetMenu(_ section: OverrideLabels.Section) -> OverrideResetMenu {
        OverrideResetMenu(on: inheritsPaint && s.ids.count <= 1, items: overrideResets(section)) { [model, s] keys in model.resetOverrides(s.id, keys: keys) }
    }

    /// Writes a paint or effect list, or clears it: an empty override on an instance, the key removed elsewhere.
    private func writeList(_ key: String, _ value: Any?, alsoRemove: [String] = []) {
        if let value { model.update([key: value]); return }
        if inheritsPaint { model.update([key: [Any]()]) } else { model.update([:], remove: [key] + alsoRemove.filter { n[$0] != nil }) }
    }

    // MARK: paint lists (fill, stroke)

    var fillSection: some View {
        let list = PaintLogic.list(n["fill"])
        let isMixed = mixed("fill")
        return InspectorSection(title: "Fill", trailing: {
            // "+" asks for the type (Solid, Gradient, Image, Shader). Mixed fills: the new one replaces every
            // layer's.
            AddPaintMenu(model: model, noun: "fill", enabled: editable) { p in
                model.update(["fill": PaintLogic.value(isMixed ? [p] : list + [p])!])
            }
        }) {
            if isMixed {
                MixedNote(text: "Click + to replace mixed content")
            } else {
                paintRows(key: "fill", list: list, noun: "fill") { l in writeList("fill", PaintLogic.value(l)) }
            }
        }
        .modifier(resetMenu(.fill))
    }

    var strokeSection: some View {
        let list = PaintLogic.list(n["stroke"])
        let isMixed = mixed("stroke")
        let raw = n["strokeWidth"]
        return InspectorSection(title: "Stroke", trailing: {
            AddPaintMenu(model: model, noun: "stroke", enabled: editable, strokes: true, base: "#000000") { p in
                if isMixed || list.isEmpty {
                    // The first stroke: 1 px black inside (it is drawn inner when the file leaves it out).
                    model.update(["stroke": PaintLogic.value([p])!, "strokeWidth": isMixed ? (PaintLogic.num(raw) ?? 1) : 1])
                } else {
                    model.update(["stroke": PaintLogic.value(list + [p])!])
                }
            }
        }) {
            if isMixed {
                MixedNote(text: "Click + to replace mixed content")
            } else if !list.isEmpty {
                paintRows(key: "stroke", list: list, noun: "stroke") { l in writeList("stroke", PaintLogic.value(l), alsoRemove: ["strokeWidth", "strokeAlignment"]) }
                strokeSettings(raw: raw)
            }
        }
        .modifier(resetMenu(.stroke))
    }

    @ViewBuilder private func strokeSettings(raw: Any?) -> some View {
        // Custom with four equal widths reads as All in the file: the panel remembers it chose Custom, so the four
        // side fields open.
        let mode = strokeSidesOpenFor == s.id && PaintLogic.sides(raw) != nil ? .custom : PaintLogic.sidesMode(raw)
        HStack(spacing: 8) {
            MenuField(title: mixed("strokeAlignment") ? "Mixed" : alignTitle(n["strokeAlignment"] as? String)) {
                Button("Inside") { model.update(["strokeAlignment": "inner"]) }
                Button("Center") { model.update(["strokeAlignment": "center"]) }
                Button("Outside") { model.update(["strokeAlignment": "outer"]) }
            }
            .disabled(!editable).help("Stroke position")
            if PaintLogic.sides(raw) != nil {
                NumberField(prefix: "", symbol: "lineweight", value: mode == .custom ? nil : PaintLogic.weight(raw), placeholder: "Mixed", enabled: editable, minimum: 0) { v in
                    model.update(["strokeWidth": PaintLogic.strokeWidth(weight: v, current: raw)])
                }
                .help("Stroke weight")
            } else {
                numberToken("strokeWidth", symbol: "lineweight", fallback: 1, minimum: 0).help("Stroke weight")
            }
            if SIDED.contains(nodeType) {
                Menu {
                    ForEach(PaintLogic.Sides.allCases, id: \.self) { m in
                        Button {
                            strokeSidesOpenFor = m == .custom ? s.id : nil
                            model.update(["strokeWidth": PaintLogic.strokeWidth(for: m, current: raw)])
                        } label: {
                            if m == mode { Label(sideTitle(m), systemImage: "checkmark") } else { Text(sideTitle(m)) }
                        }
                    }
                } label: {
                    Image(systemName: sideSymbol(mode)).glyph(12).foregroundStyle(Palette.mutedFg)
                        .frame(width: Metric.field, height: Metric.field)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
                        .contentShape(Rectangle())
                }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                .disabled(!editable || tokenName(raw) != nil).help("Stroke sides")
            }
        }
        if mode == .custom, let s = PaintLogic.sides(raw) {
            let names = ["Top", "Right", "Bottom", "Left"]
            let symbols = ["arrow.up.to.line", "arrow.right.to.line", "arrow.down.to.line", "arrow.left.to.line"]
            Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                ForEach([0, 2], id: \.self) { r in
                    GridRow {
                        ForEach([r, r + 1], id: \.self) { i in
                            NumberField(prefix: "", symbol: symbols[i], value: s[i], enabled: editable, minimum: 0) { v in
                                model.update(["strokeWidth": PaintLogic.strokeWidth(side: i, value: v, current: raw)])
                            }
                            .help("\(names[i]) stroke weight")
                        }
                    }
                }
            }
        }
    }

    private func alignTitle(_ v: String?) -> String {
        switch v {
        case "center": "Center"
        case "outer": "Outside"
        default: "Inside"
        }
    }

    private func sideTitle(_ m: PaintLogic.Sides) -> String {
        switch m {
        case .all: "All"
        case .top: "Top"
        case .bottom: "Bottom"
        case .left: "Left"
        case .right: "Right"
        case .custom: "Custom"
        }
    }

    private func sideSymbol(_ m: PaintLogic.Sides) -> String {
        switch m {
        case .all: "square"
        case .top: "square.topthird.inset.filled"
        case .bottom: "square.bottomthird.inset.filled"
        case .left: "square.leftthird.inset.filled"
        case .right: "square.rightthird.inset.filled"
        case .custom: "square.dashed"
        }
    }

    /// The rows of a paint list, top first. `write` gets the new file-order list.
    @ViewBuilder private func paintRows(key: String, list: [Any], noun: String, write: @escaping ([Any]) -> Void) -> some View {
        let count = list.count
        ForEach(0..<count, id: \.self) { row in
            let i = PaintLogic.fileIndex(row: row, count: count)
            let e = list[i]
            let on = PaintLogic.enabled(e)
            ReorderRow(group: key, row: row, count: count, enabled: editable, move: { from, to in write(PaintLogic.move(list, fromRow: from, toRow: to)) },
                       copy: { PaintClipboard.copy(e, from: key) }, paste: { if let p = PaintClipboard.paste(effect: false) { write(PaintLogic.pasting(p, into: list, row: row)); if let n = PaintClipboard.droppedNotice { model.flash(n) } } else { model.flash(PaintClipboard.emptyNotice("Copy a fill or stroke first")) } },
                       noun: noun, selected: model.paintRowNow?.key == key && model.paintRowNow?.row == row,
                       select: editable ? { model.selectPaintRow(key, row) } : nil,
                       resets: overrideResets(key == "stroke" ? .stroke : .fill), reset: { [model, s] k in model.resetOverrides(s.id, keys: k) }) {
                HStack(spacing: 4) {
                    paintField(e, enabled: editable, strokes: key == "stroke") { v in var l = list; l[i] = v; write(l) }
                        .opacity(on ? 1 : 0.5)
                    MiniButton(symbol: on ? "eye" : "eye.slash", help: on ? "Hide \(noun)" : "Show \(noun)", enabled: editable, inRow: true) {
                        var l = list; l[i] = PaintLogic.withEnabled(e, !on); write(l)
                    }
                    MiniButton(symbol: "minus", help: "Remove \(noun)", enabled: editable, inRow: true) { write(PaintLogic.removed(list, row: row)) }
                }
            }
        }
    }

    /// One paint: a token chip, a colour (swatch, hex, opacity), or the kind of a gradient, image or shader.
    /// The swatch opens the paint popover (its tabs switch the type); a gradient, image or shader shows its kind
    /// (or its shader's name) and its opacity.
    @ViewBuilder private func paintField(_ e: Any, enabled: Bool, strokes: Bool, write: @escaping (Any) -> Void) -> some View {
        if let c = PaintLogic.color(e) {
            if tokenName(c) != nil {
                colorField(c, enabled: enabled) { write(PaintLogic.withColor(e, $0)) }
            } else {
                ColorAlphaField(model: model, value: c, enabled: enabled, defaultValue: strokes ? "#000000" : "#D9D9D9", swatch: AnyView(PaintSwatchButton(model: model, paint: e, enabled: enabled, strokes: strokes, write: write))) { write(PaintLogic.withColor(e, $0)) }
            }
        } else {
            HStack(spacing: 4) {
                FieldBox {
                    PaintSwatchButton(model: model, paint: e, enabled: enabled, strokes: strokes, write: write)
                    Text(paintTitle(e)).font(Typography.body).foregroundStyle(Palette.fg).lineLimit(1)
                    Spacer(minLength: 0)
                }
                NumberField(prefix: "", value: PaintLogic.paintOpacity(e), suffix: "%", enabled: enabled, minimum: 0, maximum: 100) { write(PaintLogic.withPaintOpacity(e, percent: $0)) }
                    .frame(width: FieldWidth.percent).help("Opacity")
            }
        }
    }

    private func paintTitle(_ e: Any) -> String {
        let d = e as? [String: Any] ?? [:]
        switch PaintLogic.paintKind(e) {
        case .shader:
            if let id = d["shader"] as? String { return model.paperShaders.first { $0.id == id }?.name ?? id }
            return "Shader"
        case .image: return "Image"
        case let k: return k.title
        }
    }

    // MARK: effects

    @ViewBuilder var effectsSection: some View {
        // Several layers of different types share no type: they get Effects too, and the layers that can
        // carry an effect take it.
        if EFFECTED.contains(nodeType) || (s.ids.count > 1 && n["type"] == nil) {
            let list = PaintLogic.effects(n["effect"])
            let isMixed = mixed("effect")
            let write: ([[String: Any]]) -> Void = { l in writeList("effect", PaintLogic.effectValue(l)) }
            InspectorSection(title: "Effects", trailing: {
                MiniButton(symbol: "plus", help: "Add effect", enabled: editable) {
                    let e = PaintLogic.newEffect(.dropShadow)
                    write(isMixed ? [e] : list + [e])
                }
            }) {
                if isMixed {
                    MixedNote(text: "Click + to replace mixed content")
                } else {
                    let count = list.count
                    ForEach(0..<count, id: \.self) { row in
                        let i = PaintLogic.fileIndex(row: row, count: count)
                        let e = list[i]
                        let set: ([String: Any]) -> Void = { v in var l = list; l[i] = v; write(l) }
                        ReorderRow(group: "effect", row: row, count: count, enabled: editable, move: { from, to in
                            write(PaintLogic.move(list, fromRow: from, toRow: to).compactMap { $0 as? [String: Any] })
                        }, copy: { PaintClipboard.copy(e, effect: true) }, paste: { if let p = PaintClipboard.paste(effect: true) as? [String: Any] { set(p); if let n = PaintClipboard.droppedNotice { model.flash(n) } } else { model.flash(PaintClipboard.emptyNotice("Copy an effect first")) } }, noun: "effect",
                           selected: model.paintRowNow?.key == "effect" && model.paintRowNow?.row == row,
                           select: editable ? { model.selectPaintRow("effect", row) } : nil,
                           resets: overrideResets(.effects), reset: { [model, s] k in model.resetOverrides(s.id, keys: k) }) {
                            effectRow(e, set: set, remove: { var l = list; l.remove(at: i); write(l) })
                        }
                    }
                }
            }
            .modifier(resetMenu(.effects))
        }
    }

    @ViewBuilder private func effectRow(_ e: [String: Any], set: @escaping ([String: Any]) -> Void, remove: @escaping () -> Void) -> some View {
        let on = PaintLogic.enabled(e)
        let kind = PaintLogic.kind(e)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                MenuField(title: kind?.title ?? "Effect", symbol: kind.map(effectSymbol)) {
                    ForEach(PaintLogic.EffectKind.allCases, id: \.self) { k in
                        Button(k.title) { set(PaintLogic.withKind(e, k)) }
                    }
                }
                .disabled(!editable).opacity(on ? 1 : 0.5)
                MiniButton(symbol: on ? "eye" : "eye.slash", help: on ? "Hide effect" : "Show effect", enabled: editable, inRow: true) {
                    set(PaintLogic.withEnabled(e, !on) as? [String: Any] ?? e)
                }
                MiniButton(symbol: "minus", help: "Remove effect", enabled: editable, inRow: true, action: remove)
            }
            // A hidden effect dims as a whole, its values too.
            effectFields(e, kind: kind, set: set).opacity(on ? 1 : 0.5)
        }
    }

    @ViewBuilder private func effectFields(_ e: [String: Any], kind: PaintLogic.EffectKind?, set: @escaping ([String: Any]) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            switch kind {
            case .dropShadow?, .innerShadow?:
                let o = PaintLogic.offset(e)
                HStack(spacing: 8) {
                    NumberField(prefix: "X", value: o.x, enabled: editable) { set(PaintLogic.withOffset(e, x: $0)) }.help("Shadow X offset")
                    NumberField(prefix: "Y", value: o.y, enabled: editable) { set(PaintLogic.withOffset(e, y: $0)) }.help("Shadow Y offset")
                }
                HStack(spacing: 8) {
                    NumberField(prefix: "", symbol: "circle.dotted", value: PaintLogic.num(e["blur"]) ?? 0, enabled: editable, minimum: 0) { var v = e; v["blur"] = $0; set(v) }.help("Blur")
                    NumberField(prefix: "", symbol: "arrow.up.left.and.arrow.down.right", value: PaintLogic.num(e["spread"]) ?? 0, enabled: editable) { var v = e; v["spread"] = $0; set(v) }.help("Spread")
                }
                let c = e["color"] as? String ?? "#00000040"
                if tokenName(c) != nil {
                    colorField(c, enabled: editable) { var v = e; v["color"] = $0; set(v) }
                } else {
                    ColorAlphaField(model: model, value: c, enabled: editable) { var v = e; v["color"] = $0; set(v) }
                }
            case .layerBlur?, .backgroundBlur?:
                NumberField(prefix: "", symbol: "circle.dotted", value: PaintLogic.num(e["radius"]) ?? 0, enabled: editable, minimum: 0) { var v = e; v["radius"] = $0; set(v) }.help("Blur")
            case nil:
                EmptyView()
            }
        }
    }

    private func effectSymbol(_ k: PaintLogic.EffectKind) -> String {
        switch k {
        case .dropShadow: "square.fill.on.square"
        case .innerShadow: "square.inset.filled"
        case .layerBlur: "drop.halffull"
        case .backgroundBlur: "square.stack.3d.down.forward"
        }
    }

    // MARK: corners

    /// The corner radius field and, beside it, the Independent corners toggle; the four corners show under the
    /// row (InspectorBody.appearance) while it is on or the file has four different radii.
    var cornersIndependent: Bool { n["cornerRadius"] is [Any] || cornersOpenFor == s.id }

    @ViewBuilder var cornerRadiusField: some View {
        let raw = n["cornerRadius"]
        HStack(spacing: 4) {
            if let c = PaintLogic.corners(raw), raw is [Any] {
                // Four radii: one value typed here sets them all; the four fields below set one each.
                NumberField(prefix: "", symbol: "rectangle.roundedtop", value: Set(c).count == 1 ? c[0] : nil, placeholder: "Mixed", enabled: editable, minimum: 0) {
                    model.update(["cornerRadius": max(0, $0)])
                }
                .help("Corner radius")
            } else if raw is [Any] {
                NumberField(prefix: "", symbol: "rectangle.roundedtop", value: nil, placeholder: "Mixed", enabled: editable, minimum: 0) {
                    model.update(["cornerRadius": max(0, $0)])
                }
                .help("Corner radius")
            } else {
                numberToken("cornerRadius", symbol: "rectangle.roundedtop", fallback: 0, minimum: 0).help("Corner radius")
            }
            MiniButton(symbol: "square.dashed", help: "Independent corners", enabled: editable && !mixed("cornerRadius") && tokenName(raw) == nil, inRow: true) {
                cornersOpenFor = cornersIndependent ? nil : s.id
            }
            .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(cornersIndependent ? Palette.active : .clear))
        }
    }

    @ViewBuilder var cornerFields: some View {
        let raw = n["cornerRadius"]
        if cornersIndependent, !mixed("cornerRadius"), let c = PaintLogic.corners(raw) {
            let names = ["Top left", "Top right", "Bottom right", "Bottom left"]
            let symbols = ["arrow.up.left", "arrow.up.right", "arrow.down.right", "arrow.down.left"]
            Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                // Order on screen: top left, top right / bottom left, bottom right.
                ForEach([[0, 1], [3, 2]], id: \.self) { pair in
                    GridRow {
                        ForEach(pair, id: \.self) { i in
                            NumberField(prefix: "", symbol: symbols[i], value: c[i], enabled: editable, minimum: 0) { v in
                                model.update(["cornerRadius": PaintLogic.cornerRadius(corner: i, value: v, current: raw)])
                            }
                            .help("\(names[i]) radius")
                        }
                    }
                }
            }
        }
        cornerSmoothingField
    }
}

/// Right-click Reset items on a section of an instance's properties; the section has no menu when nothing in it can be
/// overridden (`on` false), so it never swallows a right-click elsewhere.
struct OverrideResetMenu: ViewModifier {
    let on: Bool
    let items: [(title: String, keys: [String])]
    let reset: ([String]) -> Void

    func body(content: Content) -> some View {
        if on {
            content.contentShape(Rectangle()).contextMenu {
                ForEach(items, id: \.title) { i in Button(i.title) { reset(i.keys) } }
            }
        } else {
            content
        }
    }
}

/// The line for a property the selected layers do not share.
struct MixedNote: View {
    let text: String
    var body: some View {
        Text(text).font(Typography.micro).foregroundStyle(Palette.mutedFg).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A colour as the panel shows it: swatch and six-digit hex, then the opacity in percent. Typing a hex keeps the
/// opacity; typing an opacity keeps the colour.
struct ColorAlphaField: View {
    @ObservedObject var model: CanvasModel
    let value: String
    var enabled = true
    var defaultValue: String? = nil
    /// A paint row's swatch (PaintSwatchButton: the type tabs and the picker) instead of the plain colour swatch.
    var swatch: AnyView? = nil
    var showsOpacity = true
    var allowsTokens = true
    let write: (String) -> Void

    @State private var hovering = false
    @State private var picking = false

    var body: some View {
        let alpha = PaintLogic.alphaPercent(value)
        let rgb = PaintLogic.withAlpha(value, percent: 100) ?? value
        HStack(spacing: 4) {
            FieldBox {
                if let swatch { swatch } else { ColorSwatchButton(value: value, enabled: enabled, model: model, onChange: write, onCommit: write) }
                // Shift+Up / Shift+Down: lighter or darker, the opacity kept.
                HexField(value: rgb, enabled: enabled, onStep: { up, big in
                    if let h = PaintLogic.lighter(value, by: (up ? 1 : -1) * (big ? 0.1 : 0.01)) { write(h) }
                }, defaultValue: defaultValue.map { $0 + "FF" }, copyValue: value) { hex in
                    // A six-digit hex keeps the opacity the colour had; eight digits say their own.
                    let h = hex.dropFirst().count == 6 && (alpha ?? 100) < 100 ? (PaintLogic.withAlpha(hex, percent: alpha ?? 100) ?? hex) : hex
                    write(h)
                }
                .layoutPriority(1)
                // The colour token button shows on hover, like every number field's, so the hex keeps its room.
                if allowsTokens && enabled && (hovering || picking) && !model.tokenItems(.color).isEmpty {
                    TokenBindButton(model: model, kind: .color, open: $picking, inField: true) { write("$" + $0) }
                        .padding(.trailing, -4)
                }
            }
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            // "100" and the % fit at the panel's width (no glyph: the % is the scrub handle).
            if showsOpacity {
                NumberField(prefix: "", value: alpha, suffix: "%", enabled: enabled && alpha != nil, minimum: 0, maximum: 100, defaultValue: 100) { p in
                    if let h = PaintLogic.withAlpha(value, percent: p) { write(h) }
                }
                .frame(width: FieldWidth.percent).help("Opacity")
            }
        }
    }
}

/// A list row that reorders by dragging its grip onto another row of the same list (or Move Up / Move Down in its
/// context menu). `group` keeps fills from dropping on strokes.
struct ReorderRow<Content: View>: View {
    let group: String
    let row: Int
    let count: Int
    var enabled = true
    let move: (Int, Int) -> Void
    /// Copy and paste one paint (a fill, stroke or effect row's Cmd+C, Cmd+V on another layer's row).
    var copy: (() -> Void)? = nil
    var paste: (() -> Void)? = nil
    var noun = "paint"
    /// Row selection: a click on the area left of the swatch picks the row (grey, like a list's selected
    /// row); Cmd+C, Cmd+V, Delete and Esc then go to it (CanvasModel.paintRow).
    var selected = false
    var select: (() -> Void)? = nil
    /// Reset items for an overridden paint on an instance (right-click Reset on a changed property).
    var resets: [(title: String, keys: [String])] = []
    var reset: ([String]) -> Void = { _ in }
    @ViewBuilder var content: () -> Content
    @State private var targeted = false
    /// How far the pick area reaches left of the row, into the section's margin.
    static var lead: CGFloat { 10 }

    var body: some View {
        rowBody
            .padding(.leading, select == nil ? 0 : Self.lead)
            .background {
                if let select {
                    RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous)
                        .fill(selected ? Palette.rowSelected : Color.clear)
                        .padding(.vertical, -3).padding(.trailing, -4)
                }
            }
            .overlay(alignment: .leading) {
                if let select {
                    Button(action: select) { Color.clear.frame(width: Self.lead).frame(maxHeight: .infinity).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .help("Select \(noun)")
                        .qaID("paint-row:\(group):\(row)", label: selected ? "selected" : nil)
                }
            }
            .padding(.leading, select == nil ? 0 : -Self.lead)
    }

    private var rowBody: some View {
        HStack(spacing: 2) {
            if count > 1 {
                Image(systemName: "line.3.horizontal").font(.system(size: 9, weight: .medium)).foregroundStyle(Palette.mutedFg)
                    .frame(width: 10, height: Metric.field).contentShape(Rectangle())
                    .draggable("canvas-reorder:\(group):\(row)") {
                        Image(systemName: "line.3.horizontal").padding(4)
                    }
                    .help("Drag to reorder")
                    .disabled(!enabled)
            }
            content()
        }
        .overlay(alignment: .top) {
            if targeted { Rectangle().fill(Palette.sel).frame(height: 2).offset(y: -5) }
        }
        .dropDestination(for: String.self) { items, _ in
            guard enabled, let s = items.first, let from = Self.row(s, group: group), from != row else { return false }
            move(from, row)
            return true
        } isTargeted: { targeted = $0 }
        .contextMenu {
            ForEach(resets, id: \.title) { r in Button(r.title) { reset(r.keys) } }
            if !resets.isEmpty { Divider() }
            if let copy { Button("Copy \(noun.prefix(1).uppercased() + noun.dropFirst())", action: copy) }
            if let paste { Button("Paste \(noun.prefix(1).uppercased() + noun.dropFirst())", action: paste).disabled(!enabled) }
            if count > 1 {
                if copy != nil { Divider() }
                Button("Move Up") { move(row, row - 1) }.disabled(row == 0 || !enabled)
                Button("Move Down") { move(row, row + 1) }.disabled(row == count - 1 || !enabled)
            }
        }
    }

    static func row(_ s: String, group: String) -> Int? {
        let p = s.split(separator: ":")
        guard p.count == 3, p[0] == "canvas-reorder", p[1] == group else { return nil }
        return Int(p[2])
    }
}
