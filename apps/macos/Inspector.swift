// The properties panel: type and name, the component block (what an instance is of, its
// overrides, Go to main component), position, layout, appearance, fill, typography, stroke, effects. Every
// control writes through CanvasModel.update.

import SwiftUI

struct Inspector: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var fonts: FontCatalog

    var body: some View {
        if model.currentFile != nil {
            HStack {
                Spacer(minLength: 0)
                GlassIsland(padding: 0, dense: true) {
                    ScrollView {
                        if let id = model.selectedWidgetId {
                            WidgetInspector(model: model, widgetId: id)
                                .environment(\.editTarget, (model.currentFile ?? "") + "\u{1F}widget:" + id)
                        } else if let s = model.selection {
                            InspectorBody(model: model, fonts: fonts, s: s)
                                .environment(\.editTarget, ([model.currentFile ?? "", s.id] + s.ids).joined(separator: "\u{1F}"))
                        } else if let page = model.pages.first(where: { $0.id == model.activePage }) {
                            PageInspector(model: model, page: page)
                                .environment(\.editTarget, (model.currentFile ?? "") + "\u{1F}page:" + page.id)
                                .id((model.currentFile ?? "") + page.id)
                        }
                    }
                    .scrollIndicators(.never)
                }
                .frame(width: Metric.propsWidth)
            }
            .padding(.top, Metric.inset + Metric.pill + Metric.islandGap)
            .padding(.bottom, Metric.pill + Metric.islandGap)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
    }
}

private struct PageInspector: View {
    @ObservedObject var model: CanvasModel
    let page: PageInfo
    @Environment(\.colorScheme) private var scheme
    @State private var opacityDraft: Double?

    private var color: String { page.background ?? (scheme == .dark ? "#18181B" : "#F6F6F6") }
    private let cloudHint = "Page colours stay on local files for now"
    private func write(_ color: String) { model.setPageBackground(color, page: page.id) }

    private var autoLineColor: String {
        guard let rgb = UInt32(color.dropFirst(), radix: 16) else { return "#000000" }
        let r = Double((rgb >> 16) & 255), g = Double((rgb >> 8) & 255), b = Double(rgb & 255)
        return r * 0.2126 + g * 0.7152 + b * 0.0722 > 140 ? "#000000" : "#FFFFFF"
    }

    private func editPattern(_ change: (inout BlueprintPattern) -> Void) {
        guard var pattern = model.pages.first(where: { $0.id == page.id })?.pattern else { return }
        change(&pattern)
        model.setPagePattern(pattern, page: page.id)
    }

    private func modeButton(_ label: String, blueprint: Bool) -> some View {
        let selected = (page.pattern != nil) == blueprint
        return Button {
            guard !selected else { return }
            model.setPagePattern(blueprint ? BlueprintPattern() : nil, page: page.id)
        } label: {
            Text(label).font(Typography.label).frame(maxWidth: .infinity).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: Metric.radiusField).fill(selected ? Palette.active : .clear))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .qaID(blueprint ? "page-blueprint" : "page-color")
    }

    private func gridNumber(_ label: String, key: WritableKeyPath<BlueprintPattern, Int>, value: Int, min: Double, max: Double) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(Typography.label).foregroundStyle(Palette.mutedFg).qaText(label)
            NumberField(prefix: "", value: Double(value), minimum: min, maximum: max) { number in
                editPattern { $0[keyPath: key] = Int(number.rounded()) }
            }
        }
    }

    private func gridControls(_ pattern: BlueprintPattern) -> some View {
        let lineColor = pattern.lineColor ?? autoLineColor
        let writeLineColor: (String) -> Void = { hex in
            guard let value = PaintLogic.withAlpha(hex, percent: 100),
                  value.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil else { return }
            editPattern { $0.lineColor = value.uppercased() }
        }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                gridNumber("Spacing", key: \.spacing, value: pattern.spacing, min: 4, max: 256)
                gridNumber("Major every", key: \.major, value: pattern.major, min: 1, max: 32)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Line visibility")
                    Spacer()
                    Text("\(Int(opacityDraft ?? Double(pattern.opacity)))%").monospacedDigit()
                }
                .font(Typography.label).foregroundStyle(Palette.mutedFg)
                Slider(value: Binding(get: { opacityDraft ?? Double(pattern.opacity) }, set: { opacityDraft = $0 }),
                       in: 0...100, step: 1) { editing in
                    if !editing, let value = opacityDraft {
                        editPattern { $0.opacity = Int(value) }
                        opacityDraft = nil
                    }
                }
                .accessibilityLabel("Line visibility")
                .qaID("page-blueprint-opacity")
            }
            Text("Line color").font(Typography.label).foregroundStyle(Palette.mutedFg).qaText("Line color")
            HStack(spacing: 4) {
                ColorAlphaField(model: model, value: lineColor, enabled: !model.isCloudFile,
                                swatch: AnyView(ColorSwatchButton(value: lineColor, enabled: !model.isCloudFile,
                                                                 onChange: { _ in }, onCommit: writeLineColor)),
                                showsOpacity: false, allowsTokens: false, write: writeLineColor)
                MiniButton(symbol: "arrow.uturn.backward", help: "Reset line color") {
                    editPattern { $0.lineColor = nil }
                }
                .disabled(pattern.lineColor == nil || model.isCloudFile)
            }
        }
    }

    var body: some View {
        InspectorSection(title: "Page") {
            VStack(alignment: .leading, spacing: 6) {
                Text("Background").font(Typography.label).foregroundStyle(Palette.mutedFg).qaText("Background")
                HStack(spacing: 4) {
                    ColorAlphaField(model: model, value: color, enabled: !model.isCloudFile,
                                    swatch: AnyView(ColorSwatchButton(value: color, enabled: !model.isCloudFile,
                                                                     onChange: { _ in }, onCommit: write)),
                                    showsOpacity: false, allowsTokens: false, write: write)
                    MiniButton(symbol: "arrow.uturn.backward", help: "Reset background to default") {
                        model.setPageBackground(nil, page: page.id)
                    }
                    .disabled(page.background == nil || model.isCloudFile)
                    .qaID("page-background-reset")
                }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 2) {
                        modeButton("Color", blueprint: false)
                        modeButton("Blueprint", blueprint: true)
                    }
                    .padding(2)
                    .background(RoundedRectangle(cornerRadius: Metric.radiusField).fill(Palette.field))
                    if let pattern = page.pattern { gridControls(pattern) }
                }
                .disabled(model.isCloudFile)
                if model.isCloudFile {
                    Text(cloudHint).font(Typography.label).foregroundStyle(Palette.mutedFg).qaText(cloudHint)
                }
            }
        }
    }
}

private func str(_ v: Any?) -> String? {
    switch v {
    case let s as String: return s.isEmpty ? nil : s
    case let n as NSNumber: return NumberField.format(n.doubleValue)
    default: return nil
    }
}

private func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

func typeSymbol(_ t: String?) -> String {
    switch t {
    case "text": "textformat"
    case "frame": "number"
    case "rectangle": "rectangle"
    case "ellipse": "circle"
    case "ref": "diamond"
    case "path": "scribble"
    case "group": "square.on.square.dashed"
    case "icon": "star"
    default: "square"
    }
}

struct InspectorBody: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var fonts: FontCatalog
    let s: Selection
    @State private var pickingFont = false
    /// The parent and drawn position the auto layout controls need (InspectorLayout.swift).
    @StateObject private var probe = LayoutProbe()
    /// The selection whose four corners show although the file has one radius (Independent corners, InspectorPaint.swift).
    @State var cornersOpenFor: String?
    /// The selection whose stroke sides show as Custom although its four widths are equal (InspectorPaint.swift).
    @State var strokeSidesOpenFor: String?

    /// Letters selected in this text while it is edited: the fields show their style (TextRangeState).
    private var range: TextRangeState? { model.textEditing ? model.textRange.flatMap { $0.id == s.id ? $0 : nil } : nil }
    var n: [String: Any] { range?.overlay(s.node) ?? s.node }
    var editable: Bool { !s.isPath || range != nil }
    /// Several layers selected, and the keys whose values differ between them: those fields read "Mixed" and stay
    /// editable (a value typed there goes to every layer). Styled ranges in a text read Mixed the same
    /// way: the selected letters differ, or (no edit open) the layer's ranges set the key.
    private var multi: Bool { s.ids.count > 1 }
    func mixed(_ key: String) -> Bool {
        if multi && s.mixed.contains(key) { return true }
        if let r = range { return r.mixed(key) }
        return TextRangeState.keysIn(s.node["spans"]).contains(key)
    }
    private func placeholder(_ key: String) -> String { mixed(key) ? "Mixed" : "" }

    /// An instance shows the layout its component draws with: the panel reads it as the component's type,
    /// so a frame's auto layout and Hug show; edits still go to the instance.
    private var layoutSelection: Selection {
        guard str(n["type"]) == "ref", let t = s.resolvedType, t != "ref" else { return s }
        var shown = s
        shown.node["type"] = t
        return shown
    }

    /// Where the layer sits and how big it is: its component decides that for a layer inside an instance, whose
    /// look (fill, stroke, opacity, radius, text) still takes overrides.
    private var structural: Bool { editable && !s.inInstance }

    /// A `$name` reference follows the document's variables to the value it stands for.
    private func resolved(_ v: String) -> String {
        guard v.hasPrefix("$") else { return v }
        return model.variables.first { $0.id == String(v.dropFirst()) || $0.id == v }?.value ?? v
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if !editable {
                Text("Inside a component instance: read only.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.bottom, 8)
            }
            // Several layers: align, distribute and tidy up first (ArrangeActions).
            if ArrangeActions.shows(count: s.ids.count) { ArrangeSection(model: model, s: s) }
            // The instance and component block sit right under the layer's name.
            component
            position
            layout
            AutoLayoutSection(model: model, s: layoutSelection, editable: structural)
            appearance.modifier(resetMenu(.appearance))
            fillSection
            if str(n["type"]) == "text" { typography.modifier(resetMenu(.typography)) }
            strokeSection
            effectsSection
            selectionColorsSection
            layoutGuideSection
            exportSection
        }
        .padding(.bottom, 8)
        .modifier(LayoutProbeRefresh(probe: probe, model: model, s: s))
    }

    // MARK: header

    /// A main component is a filled diamond, an instance an outline one, anything else its type.
    private var headerSymbol: String {
        if n["reusable"] as? Bool == true { return "diamond.fill" }
        if str(n["type"]) == "ref" { return "diamond" }
        return typeSymbol(str(n["type"]))
    }

    /// The layer's name; an unnamed text shows its first line, anything else its type, capitalised.
    private var layerTitle: String {
        if let name = str(n["name"]), !name.isEmpty { return name }
        if str(n["type"]) == "text", let c = str(n["content"]) {
            let line = c.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
            if !line.isEmpty { return line }
        }
        if let t = str(n["type"]), !t.isEmpty { return t.prefix(1).uppercased() + t.dropFirst() }
        return s.id
    }
    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: headerSymbol).glyph(12).foregroundStyle(s.isComponent ? Palette.component : Palette.mutedFg)
            Text(layerTitle).font(Typography.title).foregroundStyle(Palette.fg).lineLimit(1)
            Spacer(minLength: 0)
            if ContextMenuLayout.canCreateComponent(type: str(n["type"]), reusable: n["reusable"] as? Bool == true, path: s.isPath, inInstance: s.inInstance), !s.id.hasPrefix("widget:") {
                IconButton(symbol: "diamond", help: "Create Component") { model.run("{cmd:'shortcut',op:'component'}") }
                    .qaID("create-component", label: "Create Component").disabled(model.cloudReadOnly)
            }
            Menu { nodeMenu } label: {
                Image(systemName: "ellipsis").glyph(GlyphSize.row).foregroundStyle(Palette.mutedFg)
                    .frame(width: 24, height: 24).contentShape(Circle())
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize().help("More actions")
        }
        .padding(.leading, 12).padding(.trailing, 8).padding(.top, 12).padding(.bottom, 10)
        .contextMenu { nodeMenu }
    }

    /// Ids are for agents and debugging, so they live here and nowhere in the panel itself.
    @ViewBuilder private var nodeMenu: some View {
        Button("Copy ID") { copy(s.id) }
        if let ref = str(n["ref"]) { Button("Copy Main Component ID") { copy(ref) } }
        if editable, s.context?.media ?? (!s.isComponent && (str(n["type"]) == "frame" || str(n["type"]) == "rectangle")) {
            Divider()
            Button("Embed Video Here") { model.embedVideo(over: s.id, hint: s.context?.videoHint) }
        }
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// A token's value for Detach; says so instead of doing nothing when the token has none.
    private func literal(_ name: String) -> String? {
        if let v = model.tokenLiteral(name) { return v }
        model.flash("\(name) has no value to detach to")
        return nil
    }

    private func number(_ name: String) -> Double? {
        guard let v = literal(name) else { return nil }
        if let d = Double(v.trimmingCharacters(in: CharacterSet(charactersIn: " px%"))) { return d }
        model.flash("\(name) is \(v), not a number")
        return nil
    }

    // MARK: position and layout

    private var position: some View {
        InspectorSection(title: "Position") {
            // X/Y, greyed while auto layout places the layer, and Ignore auto layout (InspectorLayout.swift).
            LayoutPositionFields(model: model, probe: probe, s: s, editable: structural)
            HStack(spacing: 8) {
                // Rotation shows in -180...180: 400 is 40.
                NumberField(prefix: "", symbol: "angle", value: mixed("rotation") ? nil : num(n["rotation"]).map(FieldMath.angle) ?? 0, placeholder: "Mixed", suffix: "°", enabled: structural,
                            onStep: { model.stepEach("rotation", by: $0) },
                            onRelative: { model.relativeEach("rotation", $0) },
                            normalize: FieldMath.angle, defaultValue: 0) { model.update(["rotation": $0]) }
                    .help("Rotation").qaID("rotation-value")
                ToggleIcons(items: [("arrow.left.and.right.righttriangle.left.righttriangle.right", n["flipX"] as? Bool == true, "Flip horizontal"),
                                    ("arrow.up.and.down.righttriangle.up.righttriangle.down", n["flipY"] as? Bool == true, "Flip vertical")],
                            enabled: structural) { i, on in
                    let key = i == 0 ? "flipX" : "flipY"
                    if on { model.update([key: true]) } else { model.update([:], remove: [key]) }
                }
            }
        }
    }

    private var layout: some View {
        let isText = str(n["type"]) == "text"
        let isFrame = str(n["type"]) == "frame"
        return InspectorSection(title: "Layout") {
            HStack(spacing: 4) {
                Text("Dimensions").font(Typography.micro).foregroundStyle(Palette.mutedFg).qaText("Dimensions")
                Spacer(minLength: 0)
                if isFrame || isText {
                    // Resize to fit: the canvas measures the content and writes one step (src/page/live.js).
                    MiniButton(symbol: "arrow.down.right.and.arrow.up.left", help: "Resize to fit content  \u{2325}\u{2318}\u{21E7}R", enabled: structural) {
                        model.run("{cmd:'fitContent'}")
                    }
                }
                AspectLockButton(model: model, s: s, editable: structural)
            }
            // W and H, each with Fixed / Hug / Fill and min/max (InspectorLayout.swift).
            LayoutSizeFields(model: model, probe: probe, s: layoutSelection, editable: structural)
            // Evenly spaced layers (a smart selection): the space between them, two fields (src/page/smart.js).
            if multi, let sp = model.smartSpacing { smartSpacingFields(sp) }
            // Scale: the layer and everything inside it by a percent, one step (src/page/live.js scaleBy; K on the canvas).
            ScaleField(enabled: structural) { f in model.run("{cmd:'scale',factor:\(f)}") }
                .help("Scale layer and contents  K")
            if isText {
                Text("Resizing").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                SegmentedIcons(items: [("arrow.left.and.right.square", "auto", "Auto width"), ("arrow.up.and.down.square", "fixed-width", "Auto height (fixed width)"), ("rectangle.dashed", "fixed-width-height", "Fixed size")],
                               selection: str(n["textGrowth"]) ?? "auto", enabled: editable) { model.update(["textGrowth": $0]) }
            }
        }
    }

    /// Horizontal and vertical space between the layers of a smart selection; one write moves them all.
    private func smartSpacingFields(_ sp: SmartSpacing) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Spacing").font(Typography.micro).foregroundStyle(Palette.mutedFg).qaText("Spacing")
            HStack(spacing: 8) {
                NumberField(prefix: "", symbol: "arrow.left.and.right", value: sp.x, placeholder: "", enabled: sp.x != nil) { v in
                    model.run("{cmd:'smartGap',x:\(v)}")
                }
                .help("Horizontal space between")
                .accessibilityLabel("Horizontal space between")
                NumberField(prefix: "", symbol: "arrow.up.and.down", value: sp.y, placeholder: "", enabled: sp.y != nil) { v in
                    model.run("{cmd:'smartGap',y:\(v)}")
                }
                .help("Vertical space between")
                .accessibilityLabel("Vertical space between")
            }
        }
    }

    // MARK: tokens on number fields

    /// Writes a token or a number to one property; Detach writes the token's value.
    /// `empty`: what the field says when the file leaves the value out ("Auto" for line height).
    func numberToken(_ key: String, symbol: String, scale: Double = 1, suffix: String = "", fallback: Double? = nil, minimum: Double? = nil, empty: String = "") -> some View {
        TokenNumberField(model: model, symbol: symbol, raw: n[key], value: mixed(key) ? nil : num(n[key]).map { $0 * scale } ?? fallback,
                         placeholder: mixed(key) ? "Mixed" : empty, suffix: n[key] == nil && fallback == nil && !mixed(key) ? "" : suffix, enabled: editable,
                         minimum: minimum.map { $0 * scale }, defaultValue: fallback,
                         onStep: { d in model.stepEach(key, by: d / scale, fallback: fallback.map { $0 / scale } ?? 0, min: minimum) },
                         onRelative: { t in model.relativeEach(key, t, scale: scale, fallback: fallback.map { $0 / scale } ?? 0, min: minimum) },
                         onCommit: { v in model.update([key: minimum.map { max($0, v / scale) } ?? v / scale]) },
                         onBind: { model.update([key: "$" + $0]) },
                         onDetach: { name in if let d = number(name) { model.update([key: d]) } })
    }

    /// Appearance: opacity beside corner radius, visibility in the header. A node without corners (text,
    /// ellipse, path) pairs opacity with the visibility switch instead, so the row is never half empty.
    private var appearance: some View {
        let hidden = n["enabled"] as? Bool == false
        // Several layers of different types share no type: they keep the corner radius slot (it writes to the
        // layers that have corners), so the row does not change shape between one layer and several.
        let rounded = ["frame", "rectangle", "polygon"].contains(str(n["type"]) ?? "") || (multi && str(n["type"]) == nil)
        let toggleHidden = { if hidden { model.update([:], remove: ["enabled"]) } else { model.update(["enabled": false]) } }
        return InspectorSection(title: "Appearance", trailing: {
            layerBlendMenu
            if rounded { MiniButton(symbol: hidden ? "eye.slash" : "eye", help: hidden ? "Show layer" : "Hide layer", enabled: editable, action: toggleHidden) }
        }) {
            HStack(spacing: 8) {
                TokenNumberField(model: model, symbol: "drop.halffull", raw: n["opacity"], value: mixed("opacity") ? nil : (num(n["opacity"]) ?? 1) * 100,
                                 placeholder: "Mixed", suffix: "%", enabled: editable,
                                 minimum: 0, maximum: 100, defaultValue: 100,
                                 onStep: { model.stepEach("opacity", by: $0 / 100, fallback: 1, min: 0, max: 1) },
                                 onRelative: { model.relativeEach("opacity", $0, scale: 100, fallback: 1, min: 0, max: 1) },
                                 onCommit: { model.update(["opacity": max(0, min(100, $0)) / 100]) },
                                 onBind: { model.update(["opacity": "$" + $0]) },
                                 onDetach: { name in if let d = number(name) { model.update(["opacity": d]) } })
                    .help("Opacity")
                if rounded {
                    cornerRadiusField
                } else {
                    Button(action: toggleHidden) {
                        FieldBox(disabled: !editable) {
                            Image(systemName: hidden ? "eye.slash" : "eye").glyph(11).foregroundStyle(Palette.mutedFg)
                            Text(hidden ? "Hidden" : "Visible").font(Typography.body).foregroundStyle(Palette.fg).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!editable)
                    .help(hidden ? "Show layer" : "Hide layer")
                }
            }
            if rounded { cornerFields }
        }
    }

    // MARK: fill and stroke

    /// A colour that can be a literal (swatch and editable hex) or a token (chip). Detach writes the token's
    /// value for the current theme, so the same row turns into that swatch and hex at once.
    @ViewBuilder func colorField(_ v: String, enabled: Bool, write: @escaping (String) -> Void) -> some View {
        if let name = tokenName(v) {
            TokenChip(model: model, name: name, kind: .color, enabled: enabled, onPick: { write("$" + $0) },
                      onDetach: { if let lit = literal(name) { write(lit) } })
        } else {
            HStack(spacing: 4) {
                FieldBox {
                    ColorSwatchButton(value: v, enabled: enabled, model: model, onChange: write, onCommit: write)
                    HexField(value: v, enabled: enabled, onCommit: write)
                }
                TokenBindButton(model: model, kind: .color, enabled: enabled) { write("$" + $0) }
            }
        }
    }

    // MARK: typography

    private var fontSize: Double? { num(n["fontSize"]) ?? model.tokenLiteral(tokenName(n["fontSize"]) ?? "").flatMap(Double.init) }

    /// Your own letter spacing: writes the value and turns auto off.
    private func manualTracking(_ v: Double) {
        if let meta = AutoTracking.metadata(n["metadata"], on: false) { model.update(["letterSpacing": v, "metadata": meta]) }
        else { model.update(["letterSpacing": v], remove: n["metadata"] == nil ? [] : ["metadata"]) }
    }

    private var typography: some View {
        let rawFamily = str(n["fontFamily"]) ?? "Inter"
        let family = resolved(rawFamily)
        // Until the font list has loaded, nothing counts as missing.
        let installed = fonts.families.isEmpty || fonts.has(family)
        // Not on this Mac but drawn on the canvas anyway (a web font): not missing. Unknown yet: not missing either.
        let missing = !installed && fonts.drawable[family.lowercased()] == false
        let auto = AutoTracking.isOn(n)
        return InspectorSection(title: "Typography") {
            if let token = tokenName(rawFamily) {
                // The panel names the family the variable gives (SF Pro Rounded), not the variable; the chip's tooltip names it.
                TokenChip(model: model, name: token, kind: .string, symbol: "textformat", title: family != rawFamily ? family : nil, enabled: editable,
                          onPick: { model.update(["fontFamily": "$" + $0]) },
                          onDetach: { if let lit = literal(token) { model.update(["fontFamily": lit]) } })
            } else {
                HStack(spacing: 4) {
                    Button { pickingFont = true } label: {
                        FieldBox {
                            Text(family).font(installed ? .custom(family, size: 13) : Typography.body).foregroundStyle(Palette.fg).lineLimit(1)
                            Spacer(minLength: 0)
                            if missing { MissingTag() }
                            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.mutedFg)
                        }
                    }
                    .buttonStyle(.plain).disabled(!editable)
                    .task(id: family) { if !installed { fonts.checkDrawable(family, base: model.base, file: model.currentFile) } }
                    .popover(isPresented: $pickingFont, arrowEdge: .leading) {
                        FontPicker(fonts: fonts, current: family, pick: { model.update(["fontFamily": $0]); pickingFont = false },
                                   close: { pickingFont = false })
                    }
                    TokenBindButton(model: model, kind: .string, enabled: editable) { model.update(["fontFamily": "$" + $0]) }
                }
            }
            HStack(spacing: 8) {
                // Names whatever the file holds ("normal", 700, "600"); a pick keeps the file's form.
                MenuField(title: mixed("fontWeight") ? "Mixed" : FontWeights.title(n["fontWeight"])) {
                    // Only the weights this family has (all of them for a family this Mac lacks).
                    ForEach(FontWeights.available(appKit: installed ? fonts.appKitWeights(of: family) : [], current: n["fontWeight"]), id: \.value) { w in
                        Button(w.name) { model.update(["fontWeight": FontWeights.write(w.value, over: n["fontWeight"])]) }
                    }
                }.disabled(!editable)
                numberToken("fontSize", symbol: "textformat.size", minimum: 1).help("Font size")
            }
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Line height").font(Typography.micro).foregroundStyle(Palette.mutedFg).frame(height: 16).qaText("Line height")
                    numberToken("lineHeight", symbol: "arrow.up.and.down.text.horizontal", scale: 100, suffix: "%", minimum: 0, empty: "Auto").help("Line height")
                }
                if tokenName(n["letterSpacing"]) != nil {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Letter spacing").font(Typography.micro).foregroundStyle(Palette.mutedFg).frame(height: 16).qaText("Letter spacing")
                        numberToken("letterSpacing", symbol: "textformat.characters.arrow.left.and.right", suffix: "px").help("Letter spacing")
                    }
                } else {
                    TrackingField(value: num(n["letterSpacing"]), size: fontSize,
                                  family: family, auto: auto, enabled: editable, onManual: manualTracking, onAuto: { on in
                        // Off keeps the computed value as your own, so the text does not jump.
                        if on { model.update(["metadata": AutoTracking.metadata(n["metadata"], on: true) ?? [:]]) } else { manualTracking(num(n["letterSpacing"]) ?? 0) }
                    }, model: model, onBind: { name in
                        // A token is your own value: auto goes off with it.
                        if let meta = AutoTracking.metadata(n["metadata"], on: false) { model.update(["letterSpacing": "$" + name, "metadata": meta]) }
                        else { model.update(["letterSpacing": "$" + name], remove: n["metadata"] == nil ? [] : ["metadata"]) }
                    })
                }
            }
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Horizontal").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    SegmentedIcons(items: [("text.alignleft", "left", "Left"), ("text.aligncenter", "center", "Center"), ("text.alignright", "right", "Right"), ("text.justify", "justify", "Justify")],
                                   selection: str(n["textAlign"]) ?? "left", enabled: editable) { model.update(["textAlign": $0]) }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Vertical").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    SegmentedIcons(items: [("align.vertical.top", "top", "Top"), ("align.vertical.center", "middle", "Middle"), ("align.vertical.bottom", "bottom", "Bottom")],
                                   selection: str(n["textAlignVertical"]) ?? "top", enabled: editable) { model.update(["textAlignVertical": $0]) }
                }
            }
            // Type details: paragraph spacing and indent (px), and the list style (src/page/text-paras.js).
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Paragraph spacing").font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).frame(height: 16)
                    numberToken("paragraphSpacing", symbol: "arrow.up.and.down", suffix: "px", fallback: 0, minimum: 0).help("Paragraph spacing").modifier(QAFrame(id: "type.paragraphSpacing"))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Paragraph indent").font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).frame(height: 16)
                    numberToken("paragraphIndent", symbol: "increase.indent", suffix: "px", fallback: 0, minimum: 0).help("Paragraph indent (left-aligned text)").modifier(QAFrame(id: "type.paragraphIndent"))
                }
            }
            // Letter case (the letters drawn in a case, kept as typed) and List spacing (px between list items).
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Letter case").font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).frame(height: 16)
                    // Small caps are the font's own (smcp): offered only when the font has them.
                    let smallCaps = fonts.smallCaps(of: family) ?? true
                    MenuField(title: mixed("letterCase") ? "Mixed" : LetterCase.title(n["letterCase"]), symbol: "textformat") {
                        ForEach(LetterCase.options, id: \.value) { o in
                            Button(o.title) {
                                if let v = LetterCase.write(o.value) { model.update(["letterCase": v]) } else { model.update([:], remove: ["letterCase"]) }
                            }
                            .disabled(o.value == "small-caps" && !smallCaps)
                        }
                    }
                    .disabled(!editable)
                    .help(smallCaps ? "Letter case" : "Letter case (\(family) has no small caps)")
                    .modifier(QAFrame(id: "type.letterCase"))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("List spacing").font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).frame(height: 16)
                    numberToken("listSpacing", symbol: "list.bullet.indent", suffix: "px", fallback: 0, minimum: 0).help("List spacing (between list items)").modifier(QAFrame(id: "type.listSpacing"))
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("List style").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                SegmentedIcons(items: [("minus", "none", "No list"), ("list.bullet", "bullet", "Bulleted list  \u{21E7}\u{2318}8"), ("list.number", "number", "Numbered list  \u{21E7}\u{2318}7")],
                               selection: multi ? nil : TextLists.style(n), enabled: editable && !multi) { type in
                    if model.textEditing, range != nil {
                        // While editing: the selected paragraphs (the page toggles them; "none" takes the current kind off).
                        let cur = TextLists.style(n) ?? "bullet"
                        if type != "none" { model.run("{cmd:'textList',type:'\(type)'}") } else if cur != "none" { model.run("{cmd:'textList',type:'\(cur)'}") }
                    } else if let l = TextLists.lists(n, type: type) {
                        model.update(["lists": l])
                    } else {
                        model.update([:], remove: ["lists"])
                    }
                }
                .modifier(QAFrame(id: "type.listStyle"))
            }
            // Hanging punctuation (opening quotes outside the box) and Hanging lists (markers outside the box).
            VStack(alignment: .leading, spacing: 8) {
                CheckField(title: "Hanging punctuation", isOn: n["hangingPunctuation"] as? Bool == true, enabled: editable) { v in
                    if v { model.update(["hangingPunctuation": true]) } else { model.update([:], remove: ["hangingPunctuation"]) }
                }
                .help("Opening quotes that start a paragraph sit outside the text box")
                .modifier(QAFrame(id: "type.hangingPunctuation"))
                CheckField(title: "Hanging lists", isOn: n["hangingList"] as? Bool == true, enabled: editable) { v in
                    if v { model.update(["hangingList": true]) } else { model.update([:], remove: ["hangingList"]) }
                }
                .help("List markers sit outside the text box")
                .modifier(QAFrame(id: "type.hangingList"))
            }
            // Truncate text: what does not fit ends with an ellipsis; Max lines only with it on.
            let truncated = str(n["textTruncation"]) == "ending"
            HStack(spacing: 8) {
                CheckField(title: "Truncate text", isOn: truncated, enabled: editable) { v in
                    if v { model.update(["textTruncation": "ending"]) } else { model.update([:], remove: ["textTruncation", "maxLines"]) }
                }
                if truncated {
                    numberToken("maxLines", symbol: "line.3.horizontal", minimum: 1, empty: "Max lines").help("Max lines")
                }
            }
        }
    }

    // MARK: what other apps do not show

    /// Only for components, instances and what sits inside an instance: what it is, and the one action that
    /// goes with it. Ids are in the header's menu.
    @ViewBuilder private var component: some View {
        let ctx = s.context
        // A nested instance (one inside another instance) is drawn, not stored: it names what it draws in `__ref`.
        let ref = str(n["ref"]) ?? (ctx?.kind == "instance" ? str(n["__ref"]) : nil)
        let mainName = ctx?.main?.name ?? ref.flatMap { r in model.components.first { $0.id == r }?.name }
        let rows = OverrideLabels.groups(s.overrides)
        // Any instance swaps, a nested one too (several selected swap together); a top-level one also pushes.
        let topInstance = ref != nil && !s.id.contains("/") && !s.inInstance
        let swappable = ref != nil && (topInstance || ctx?.kind == "instance")
        if ref != nil || ctx?.kind == "component" || ctx?.kind == "inside-instance" || n["reusable"] as? Bool == true {
            InspectorSection(title: "Component", symbol: "diamond.fill", tint: Palette.component) {
                if ref != nil || ctx?.kind == "inside-instance" {
                    HStack(spacing: 6) {
                        Text(ref != nil ? "Instance of" : "Inside").font(Typography.body).foregroundStyle(Palette.mutedFg).fixedSize()
                        if swappable {
                            SwapPicker(current: mainName ?? "a component", targets: model.swapTargets(excluding: ref)) { c in
                                model.swapInstances(multi ? s.ids : [s.id], to: c.id)
                            }
                        } else {
                            Text(mainName ?? "a component").font(Typography.body).fontWeight(.medium).foregroundStyle(Palette.component).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                    }
                    // Overridden properties are marked; each is a row: right-click it, or its arrow, resets that one.
                    if !rows.isEmpty && !multi {
                        VStack(spacing: 2) {
                            ForEach(rows, id: \.title) { row in
                                OverrideRow(title: row.title) { model.resetOverrides(s.id, keys: row.keys) }
                            }
                        }
                    }
                    if let ctx, ctx.canGoToMain {
                        ComponentButton(symbol: "diamond.fill", title: "Go to main component") { model.goToMain(ctx) }
                    }
                    if !rows.isEmpty && !multi {
                        if topInstance {
                            ComponentButton(symbol: "arrow.up.to.line", title: "Push changes to main") { model.pushOverrides(s.id) }
                        }
                        ComponentButton(symbol: "arrow.uturn.backward", title: "Reset all changes") { model.resetOverrides(s.id) }
                    }
                } else {
                    let count = ctx?.family?.instances ?? 0
                    HStack(spacing: 6) {
                        Text("Main component").font(Typography.body).fontWeight(.medium).foregroundStyle(Palette.component)
                        Text("\(count == 1 ? "1 instance" : "\(count) instances")").font(Typography.body).monospacedDigit().foregroundStyle(Palette.mutedFg)
                        Spacer(minLength: 0)
                    }
                    if let f = ctx?.family, count > 0 {
                        ComponentButton(symbol: "diamond", title: "Select all instances") { model.highlightInstances(of: f) }
                    }
                }
            }
        }
    }
}

/// A full-width purple action in the Component section.
struct ComponentButton: View {
    let symbol: String
    let title: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: symbol).glyph(10)
                Text(title).font(Typography.label)
            }
            .foregroundStyle(Palette.component)
            .padding(.horizontal, 10).frame(height: Metric.field)
            .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(hovering ? Palette.componentSoft.opacity(1.6) : Palette.componentSoft))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
        .frame(maxWidth: .infinity, alignment: .leading) // hugs its label, starts at the section's edge
    }
}

/// The instance swap menu: the main component's name, purple, with a chevron; the menu lists every other
/// component in the file. Picking one swaps the instance (text overrides carry over where layer names match).
struct SwapPicker: View {
    let current: String
    let targets: [Component]
    let pick: (Component) -> Void
    @State private var hovering = false

    var body: some View {
        Menu {
            Section("Swap instance") {
                ForEach(targets) { c in Button(c.name) { pick(c) } }
            }
        } label: {
            HStack(spacing: 4) {
                // A long name truncates in the middle (Button/…/Primary) so the chevron stays inside the panel.
                Text(current).font(Typography.body).fontWeight(.medium).foregroundStyle(Palette.component).lineLimit(1)
                    .truncationMode(.middle).frame(maxWidth: 170, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.component)
            }
            .padding(.horizontal, 6).frame(height: Metric.field)
            .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(hovering ? Palette.componentSoft : .clear))
            .contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .padding(.leading, -6)
        .disabled(targets.isEmpty)
        .help(targets.isEmpty ? "No other component to swap to" : "Swap instance")
        .accessibilityLabel("Swap instance: \(current)")
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

/// One overridden property of an instance (or a layer inside one): its name, and an arrow that resets only it.
/// Right-click offers the same, as a property menu.
struct OverrideRow: View {
    let title: String
    let reset: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Palette.component).frame(width: 5, height: 5)
            Text(title).font(Typography.body).foregroundStyle(Palette.component).lineLimit(1)
            Spacer(minLength: 0)
            Button(action: reset) {
                Image(systemName: "arrow.uturn.backward").font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Palette.component)
                    .frame(width: 20, height: 20).contentShape(Rectangle())
            }
            .buttonStyle(.plain).opacity(hovering ? 1 : 0.55)
            .help("Reset \(title.lowercased())")
            .accessibilityLabel("Reset \(title)")
        }
        .padding(.leading, 8).padding(.trailing, 2).frame(height: 24)
        .background(RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).fill(hovering ? Palette.componentSoft : .clear))
        .contentShape(Rectangle())
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
        .contextMenu { Button("Reset \(title.lowercased())", action: reset) }
    }
}

/// All installed families, searchable, each drawn in its own face. Rows build lazily. The search field has focus;
/// Up and Down move, Return picks, Esc closes; it opens scrolled to the current family.
struct FontPicker: View {
    @ObservedObject var fonts: FontCatalog
    let current: String
    let pick: (String) -> Void
    var close: () -> Void = {}
    @State private var query = ""
    @State private var cursor: String?
    @FocusState private var searchFocused: Bool

    private var shown: [String] { query.isEmpty ? fonts.families : fonts.families.filter { $0.localizedCaseInsensitiveContains(query) } }

    private func move(_ by: Int) {
        let list = shown
        guard !list.isEmpty else { return }
        let at = cursor.flatMap { c in list.firstIndex(of: c) } ?? (by > 0 ? -1 : list.count)
        cursor = list[max(0, min(list.count - 1, at + by))]
    }

    private func choose() {
        let list = shown
        if let c = cursor, list.contains(c) { pick(c) } else if let first = list.first { pick(first) }
    }

    var body: some View {
        let list = shown
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").glyph(12).foregroundStyle(Palette.mutedFg)
                TextField("Search \(fonts.families.count) fonts", text: $query)
                    .textFieldStyle(.plain).font(Typography.body).focused($searchFocused)
                    .onSubmit(choose)
                    .onKeyPress(.downArrow) { move(1); return .handled }
                    .onKeyPress(.upArrow) { move(-1); return .handled }
                    .onKeyPress(.escape) { close(); return .handled }
            }
            .padding(.horizontal, 12).frame(height: Metric.control)
            .background(Capsule().fill(Palette.hover))
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(list, id: \.self) { family in
                            Button { pick(family) } label: {
                                HStack {
                                    Text(family).font(.custom(family, size: 14)).foregroundStyle(Palette.fg).lineLimit(1)
                                    Spacer()
                                    if family == current { Image(systemName: "checkmark").glyph(10).foregroundStyle(Palette.sel) }
                                }
                                .padding(.horizontal, 10).frame(height: Metric.row)
                                .background(RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).fill(family == cursor ? Palette.hover : .clear))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(family == current ? .isSelected : [])
                            .id(family)
                        }
                    }
                }
                .onChange(of: cursor) { _, c in if let c { proxy.scrollTo(c) } }
                .onChange(of: fonts.families) { _, _ in if cursor == current { proxy.scrollTo(current, anchor: .center) } }
                .onAppear {
                    cursor = fonts.families.contains(current) ? current : list.first
                    if let c = cursor { DispatchQueue.main.async { proxy.scrollTo(c, anchor: .center) } }
                    DispatchQueue.main.async { searchFocused = true }
                }
            }
        }
        .onChange(of: query) { _, _ in
            if let c = cursor, shown.contains(c) { return }
            cursor = shown.first
        }
        .padding(8).frame(width: 260, height: 360)
    }
}

func hexString(_ c: Color) -> String? {
    guard let ns = NSColor(c).usingColorSpace(.sRGB) else { return nil }
    let r = Int((ns.redComponent * 255).rounded()), g = Int((ns.greenComponent * 255).rounded()), b = Int((ns.blueComponent * 255).rounded())
    let a = Int((ns.alphaComponent * 255).rounded())
    return a == 255 ? String(format: "#%02X%02X%02X", r, g, b) : String(format: "#%02X%02X%02X%02X", r, g, b, a)
}

// MARK: colour swatch (the one place a colour picker plugs in)

/// The swatch in front of every literal colour in the panel (fill, stroke, fills in a list). Clicking it opens
/// a colour picker. `onChange` streams values while the picker is dragged; `onCommit` is the final value.
/// The picker is ColorPickerPopover (DesignSystem/ColorPicker.swift); picking a token commits "$name".
struct ColorSwatchButton: View {
    let value: String
    var enabled = true
    /// Tokens, recents per file, most used colours and the node's background come from here.
    var model: CanvasModel? = nil
    let onChange: (String) -> Void
    let onCommit: (String) -> Void
    @Environment(\.editTarget) private var target
    @State private var open = false
    /// The selection the picker was opened for (CanvasModel.selectionKey). A value that arrives after the selection
    /// moved (an eyedropper pick, a throttled drag value flushed on close) is dropped, not written to the new one.
    @State private var openedFor: String?

    /// Still editing what the picker was opened for. Without a model (no selection to move) always true.
    private var current: Bool { model.map { $0.selectionKey == openedFor } ?? true }

    var body: some View {
        Button { openedFor = model?.selectionKey; open.toggle() } label: {
            ColorChip(color: parseColor(value) ?? .gray).frame(width: 16, height: 16).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).help("Pick a colour").accessibilityLabel("Colour \(value)")
        .onChange(of: target) { _, _ in open = false }
        .popover(isPresented: $open, arrowEdge: .leading) {
            ColorPickerPopover(value: value, tokens: model?.tokenSections ?? [],
                               context: ColorPickerContext(base: model?.base, file: model?.currentFile, nodeId: model?.selection?.id, themes: model?.themes ?? []),
                               onChange: { if current { onChange($0) } }, onCommit: { if current { onCommit($0) } },
                               onPickToken: { open = false; if current { onCommit("$" + $0) } })
        }
    }
}

/// The hex next to a swatch, without its "#", editable: Return or leaving writes it, Esc reverts. Takes
/// "fff", "#FFF", "00000080".
struct HexField: View {
    let value: String
    var enabled = true
    /// Up / Down while the field has focus (up?, Shift held?): the colour gets lighter or darker.
    var onStep: ((Bool, Bool) -> Void)? = nil
    var defaultValue: String? = nil
    var copyValue: String? = nil
    let onCommit: (String) -> Void
    @Environment(\.editTarget) private var target
    @State private var text = ""
    @State private var draft = FieldDraft()
    @FocusState private var focused: Bool

    /// The hex shows without its "#", so six digits fit beside the swatch at the panel's width.
    static func shown(_ v: String) -> String { v.hasPrefix("#") ? String(v.dropFirst()).uppercased() : v.uppercased() }
    private func sync() { text = Self.shown(value); draft.show(text, for: target) }

    var body: some View {
        TextField("", text: $text)
            .textFieldStyle(.plain).font(Typography.body).monospacedDigit().foregroundStyle(Palette.fg)
            .focused($focused).disabled(!enabled)
            .onSubmit(commit)
            .qaID("hex-value")
            .modifier(FieldValueMenu(value: copyValue ?? value, enabled: enabled, defaultValue: defaultValue,
                                     format: { $0 }, parse: Self.hex) { apply($0) })
            .onKeyPress(.escape) { sync(); focused = false; return .handled }
            .onKeyPress(keys: [.upArrow, .downArrow]) { press in
                guard let onStep, enabled else { return .ignored }
                onStep(press.key == .upArrow, press.modifiers.contains(.shift))
                return .handled
            }
            .onAppear(perform: sync)
            .onChange(of: value) { _, _ in if !focused || !draft.edited(text) { sync() } }
            .onChange(of: target) { _, _ in sync() }
            .onChange(of: focused) { _, f in if !f { commit() } }
    }

    private static func hex(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let hex = CanvasModel.fullHex(text.hasPrefix("#") ? text : "#" + text), parseColor(hex) != nil else { return nil }
        return hex
    }

    private func commit() {
        guard draft.commits(text, target: target), let hex = Self.hex(text) else { sync(); return }
        apply(hex)
    }

    private func apply(_ hex: String) {
        text = Self.shown(hex)
        draft.show(text, for: target)
        if hex.uppercased() != (copyValue ?? value).uppercased() { onCommit(hex) }
    }
}

/// Independent on/off icons in one well (flip horizontal, flip vertical).
struct ToggleIcons: View {
    let items: [(symbol: String, on: Bool, help: String)]
    var enabled = true
    let onToggle: (Int, Bool) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items.indices, id: \.self) { i in
                let item = items[i]
                Button { onToggle(i, !item.on) } label: {
                    Image(systemName: item.symbol).glyph(12)
                        .foregroundStyle(item.on ? Palette.fg : Palette.mutedFg)
                        .frame(maxWidth: .infinity).frame(height: Metric.field - 4)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField - 2, style: .continuous).fill(item.on ? Palette.active : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).help(item.help)
                .accessibilityLabel(item.help)
                .accessibilityValue(item.on ? "On" : "Off")
                .accessibilityAddTraits(item.on ? [.isToggle, .isSelected] : .isToggle)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
        .opacity(enabled ? 1 : 0.5).disabled(!enabled)
    }
}

/// A percent applied once to the selection and everything inside it, then back to 100%. No scrubbing: each
/// change would scale again on top of the last.
private struct ScaleField: View {
    let enabled: Bool
    let apply: (Double) -> Void
    @State private var text = "100"
    @FocusState private var focused: Bool

    var body: some View {
        FieldBox(disabled: !enabled) {
            Image(systemName: "arrow.up.left.and.arrow.down.right").glyph(11).foregroundStyle(Palette.mutedFg)
            TextField("100", text: $text)
                .textFieldStyle(.plain).font(Typography.body).monospacedDigit()
                .focused($focused).disabled(!enabled)
                .onSubmit(commit)
            Text("%").font(Typography.micro).foregroundStyle(Palette.mutedFg)
        }
        .modifier(FieldValueMenu.number(100, enabled: enabled, suffix: "%") { raw in
            let v = NumericInput.clean(NumericInput.clamp(raw, 1, 10000))
            if v != 100 { apply(v / 100) }
        })
        .onChange(of: focused) { _, f in if !f { text = "100" } }
    }

    private func commit() {
        defer { text = "100" }
        guard enabled, let raw = NumericInput.evaluate(text.replacingOccurrences(of: "%", with: ""), current: 100) else { return }
        let v = NumericInput.clean(NumericInput.clamp(raw, 1, 10000))
        if v != 100 { apply(v / 100) }
    }
}

// MARK: arrange

/// Two or more layers or boards: align (six ways), distribute and tidy up, as two rows of icon buttons in a field
/// well. Each runs the Arrange menu's page op, so it is one undo step (src/page/shortcuts.js, smart.js); Shift+click
/// on an align button aligns to the parent frame, as Shift on the menu item does. Buttons stay off when too few of
/// the layers may move (auto layout places them).
struct ArrangeSection: View {
    @ObservedObject var model: CanvasModel
    let s: Selection

    var body: some View {
        InspectorSection(title: "Arrange") {
            HStack(spacing: 8) {
                ArrangeButtons(actions: ArrangeActions.align, s: s, run: run)
                    .frame(width: (Metric.propsWidth - 24 - 8) * 2 / 3)
                ArrangeButtons(actions: ArrangeActions.spread, s: s, run: run)
            }
            if let note = ArrangeActions.blockedNote(count: s.ids.count, free: s.free) {
                Text(note).font(Typography.micro).foregroundStyle(Palette.mutedFg).qaText(note)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func run(_ a: ArrangeActions.Action) {
        let toParent = a.op.hasPrefix("align-") && NSEvent.modifierFlags.contains(.shift)
        model.run("{cmd:'shortcut',op:'\(a.op)\(toParent ? ":parent" : "")'}")
    }
}

private struct ArrangeButtons: View {
    let actions: [ArrangeActions.Action]
    let s: Selection
    let run: (ArrangeActions.Action) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(actions, id: \.op) { a in
                ArrangeButton(action: a, enabled: ArrangeActions.enabled(a, count: s.ids.count, free: s.free)) { run(a) }
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
    }
}

private struct ArrangeButton: View {
    let action: ArrangeActions.Action
    let enabled: Bool
    let tap: () -> Void
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Metric.radiusField - 2, style: .continuous)
        Button(action: tap) {
            Image(systemName: action.symbol).glyph(12)
                .foregroundStyle(hovering && enabled ? Palette.fg : Palette.mutedFg)
                .frame(maxWidth: .infinity).frame(height: Metric.field - 4)
                .background(shape.fill(hovering && enabled ? Palette.active : .clear))
                .contentShape(shape)
        }
        .buttonStyle(.plain).help(ArrangeActions.help(action))
        .opacity(enabled ? 1 : 0.4).disabled(!enabled)
        .accessibilityLabel(action.title)
        .qaID("arrange", label: action.op)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}
