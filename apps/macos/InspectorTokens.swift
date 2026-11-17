// Tokens and auto letter spacing in the properties panel.
// A property bound to a variable shows the token as a chip; clicking it opens a picker grouped like the
// tokens library (type, then name family), with theme swatches, search and keyboard control. Choosing a token
// rebinds the property, Detach writes the token's resolved value as a literal. Unbound properties get a small
// token button. Every change goes through CanvasModel.update, the same path as any inspector edit.
// TrackingField is letter spacing with Auto: the server computes the value (src/tracking.ts).

import SwiftUI

enum TokenKind {
    case color, number, string
    func accepts(_ type: String) -> Bool {
        switch self {
        case .color: type == "color"
        case .number: type == "number"
        case .string: type == "string"
        }
    }
    var noun: String {
        switch self {
        case .color: "colour"
        case .number: "number"
        case .string: "text"
        }
    }
}

/// "$name" to "name"; nil for a literal.
func tokenName(_ v: Any?) -> String? {
    guard let s = v as? String, s.hasPrefix("$"), s.count > 1 else { return nil }
    return String(s.dropFirst())
}

extension CanvasModel {
    /// The library rows a picker of this kind offers, in library order.
    func tokenItems(_ kind: TokenKind) -> [LibItem] {
        tokenSections.flatMap { $0.entries.flatMap(\.items) }.filter { kind.accepts($0.type) }
    }

    /// A variable's value as a plain literal, following chained references. For the selected node, the value the
    /// canvas draws it with (resolved by the server in the node's own theme); otherwise a themed variable gives the
    /// value of the theme matching the app's appearance (a theme named "dark" in dark mode), else its first value.
    func tokenLiteral(_ name: String) -> String? {
        if let v = selection?.tokens[name]?.trimmingCharacters(in: .whitespaces), !v.isEmpty, tokenName(v) == nil {
            return Self.fullHex(v) ?? v
        }
        var v = themedValue(name)
        var hops = 0
        while let s = v, let next = tokenName(s), hops < 8 { v = themedValue(next); hops += 1 }
        guard let out = v?.trimmingCharacters(in: .whitespaces), !out.isEmpty, tokenName(out) == nil else { return nil }
        return Self.fullHex(out) ?? out
    }

    private func themedValue(_ name: String) -> String? {
        let item = tokenSections.lazy.flatMap { $0.entries.flatMap(\.items) }.first { $0.key == name }
        if let values = item?.values.filter({ !$0.value.isEmpty }), !values.isEmpty {
            let dark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let want = dark ? "dark" : "light"
            return (values.first { $0.theme.lowercased().contains(want) } ?? values[0]).value
        }
        return variables.first { $0.id == name }?.value
    }

    /// "#000" and "#0008" as "#000000" and "#00000088", the forms every colour field reads.
    static func fullHex(_ s: String) -> String? {
        guard s.hasPrefix("#") else { return nil }
        let h = s.dropFirst()
        // Shorthands: one digit is a grey ("F" is #FFFFFF), two digits repeat ("AB" is #ABABAB).
        if let short = PaintLogic.shorthandHex(String(h)) { return short }
        guard h.count == 3 || h.count == 4, h.allSatisfy(\.isHexDigit) else { return h.count == 6 || h.count == 8 ? s.uppercased() : nil }
        return "#" + h.map { "\($0)\($0)" }.joined().uppercased()
    }
}

// MARK: chip and bind button

/// A bound token in a field's place: swatch or glyph, the token's name, a chevron. Click opens the picker.
struct TokenChip: View {
    @ObservedObject var model: CanvasModel
    let name: String
    let kind: TokenKind
    var symbol: String?
    /// What the capsule says instead of the token's name (a font family token shows the family it gives).
    var title: String? = nil
    var enabled = true
    let onPick: (String) -> Void
    let onDetach: () -> Void
    @State private var open = false
    @State private var hovering = false

    var body: some View {
        Button { open = true } label: {
            FieldBox(disabled: !enabled) {
                if let symbol { Image(systemName: symbol).glyph(11).foregroundStyle(Palette.mutedFg).frame(width: 14) }
                TokenBadge(model: model, name: name, kind: kind, hovering: hovering, title: title)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
        .help("\(name)\(model.tokenLiteral(name).map { ": \($0)" } ?? "")\nClick to change or detach")
        .popover(isPresented: $open, arrowEdge: .leading) {
            TokenPicker(model: model, kind: kind, current: name, pick: { onPick($0); open = false }, detach: { onDetach(); open = false }, close: { open = false })
        }
    }
}

/// The token's name on a quiet capsule, with its colour first when it is one.
struct TokenBadge: View {
    @ObservedObject var model: CanvasModel
    let name: String
    let kind: TokenKind
    var hovering = false
    var title: String? = nil

    var body: some View {
        HStack(spacing: 5) {
            if kind == .color { ColorChip(color: model.tokenLiteral(name).flatMap(parseColor) ?? .gray).scaleEffect(0.86) }
            Text(title ?? name).font(.system(size: 12)).foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.middle)
        }
        .padding(.leading, kind == .color ? 3 : 5).padding(.trailing, 5).frame(height: 20)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(hovering ? Palette.active.opacity(1.6) : Palette.active))
    }
}

/// The small button that binds an unbound field to a token. Hidden when the file has no token of the kind.
struct TokenBindButton: View {
    @ObservedObject var model: CanvasModel
    let kind: TokenKind
    var enabled = true
    /// Held by the owner when the button only shows on hover, so the open picker keeps its anchor.
    var open: Binding<Bool>?
    /// Inside a field (shown on hover) instead of beside it.
    var inField = false
    let onPick: (String) -> Void
    @State private var ownOpen = false

    var body: some View {
        let isOpen = open ?? $ownOpen
        // In a field (every numeric field shows it on hover) it is always offered: with no tokens of the
        // kind the picker says so. Beside a field it only shows when there is something to pick.
        if inField || !model.tokenItems(kind).isEmpty {
            MiniButton(symbol: "hexagon", help: "Use a \(kind.noun) token", enabled: enabled, inRow: !inField, inField: inField) { isOpen.wrappedValue = true }
                .popover(isPresented: isOpen, arrowEdge: .leading) {
                    TokenPicker(model: model, kind: kind, current: nil, pick: { onPick($0); isOpen.wrappedValue = false }, detach: nil, close: { isOpen.wrappedValue = false })
                }
        }
    }
}

/// A number field that can hold a token: the chip when bound, the number with a bind button (on hover) when not.
struct TokenNumberField: View {
    @ObservedObject var model: CanvasModel
    let symbol: String
    let raw: Any?
    var value: Double?
    var placeholder = ""
    var suffix = ""
    var enabled = true
    var minimum: Double?
    var maximum: Double?
    var onStep: ((Double) -> Void)? = nil
    var onRelative: ((String) -> Void)? = nil
    let onCommit: (Double) -> Void
    let onBind: (String) -> Void
    let onDetach: (String) -> Void
    @State private var hovering = false
    @State private var picking = false

    var body: some View {
        if let name = tokenName(raw) {
            TokenChip(model: model, name: name, kind: .number, symbol: symbol, enabled: enabled, onPick: onBind, onDetach: { onDetach(name) })
        } else {
            NumberField(prefix: "", symbol: symbol, value: value, placeholder: placeholder, suffix: suffix, enabled: enabled,
                        minimum: minimum, maximum: maximum, onStep: onStep, onRelative: onRelative, onCommit: onCommit)
                .modifier(BindOnHover(model: model, enabled: enabled, hovering: $hovering, picking: $picking, onBind: onBind))
        }
    }
}

/// The token bind button every numeric field shows at its trailing edge while hovered (or while its picker is
/// open). One modifier, so font size, line height, letter spacing, radius, stroke, opacity, gap and padding agree.
struct BindOnHover: ViewModifier {
    @ObservedObject var model: CanvasModel
    let enabled: Bool
    @Binding var hovering: Bool
    @Binding var picking: Bool
    /// Room left at the trailing edge for the field's own control (the Auto badge).
    var trailing: CGFloat = 5
    let onBind: (String) -> Void

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .trailing) {
                if enabled && (hovering || picking) {
                    TokenBindButton(model: model, kind: .number, open: $picking, inField: true, onPick: onBind)
                        .padding(.trailing, trailing)
                        .transition(.opacity)
                }
            }
            // The whole field counts, text and gaps included, not only what is drawn.
            .contentShape(Rectangle())
            .onHover { h in withAnimation(Motion.fast) { hovering = h } }
            // The bind button only shows on hover: VoiceOver and keyboard users reach it as an action instead.
            .accessibilityAction(named: "Use a number token") { if enabled { picking = true } }
    }
}

/// BindOnHover when there is something to bind to; nothing otherwise.
struct OptionalBind: ViewModifier {
    let model: CanvasModel?
    let enabled: Bool
    @Binding var hovering: Bool
    @Binding var picking: Bool
    let onBind: ((String) -> Void)?
    /// Room the hover button keeps clear at the field's end (the Auto chip, and "px" beside it when shown).
    var trailing: CGFloat = 44

    func body(content: Content) -> some View {
        if let model, let onBind {
            content.modifier(BindOnHover(model: model, enabled: enabled, hovering: $hovering, picking: $picking, trailing: trailing, onBind: onBind))
        } else {
            content
        }
    }
}

// MARK: the picker

/// Search, then the file's tokens of one kind grouped like the library. Arrows move, Return chooses, Esc closes.
struct TokenPicker: View {
    @ObservedObject var model: CanvasModel
    let kind: TokenKind
    let current: String?
    let pick: (String) -> Void
    var detach: (() -> Void)?
    let close: () -> Void
    @State private var query = ""
    @State private var cursor: String?
    @FocusState private var searchFocused: Bool

    private enum Line: Identifiable {
        case section(String), group(String, String), item(LibItem, Bool)
        var id: String {
            switch self {
            case .section(let s): "s:\(s)"
            case .group(let s, let g): "g:\(s):\(g)"
            case .item(let i, _): i.key
            }
        }
    }

    private var themed: Bool { kind == .color && model.themes.count > 1 }

    private func matches(_ i: LibItem, _ q: String) -> Bool {
        i.title.localizedCaseInsensitiveContains(q) || i.values.contains { $0.value.localizedCaseInsensitiveContains(q) }
    }

    /// The visible lines: section headers, family headers, items. A family whose name matches keeps all its items.
    private var lines: [Line] {
        let q = query.trimmingCharacters(in: .whitespaces)
        var out: [Line] = []
        for s in model.tokenSections {
            var body: [Line] = []
            for e in s.entries {
                let fits = e.items.filter { kind.accepts($0.type) }
                guard !fits.isEmpty else { continue }
                let shown = q.isEmpty || (e.isGroup && e.title.localizedCaseInsensitiveContains(q)) ? fits : fits.filter { matches($0, q) }
                guard !shown.isEmpty else { continue }
                if e.isGroup {
                    body.append(.group(s.id, e.title))
                    body += shown.map { .item($0, true) }
                } else {
                    body.append(.item(shown[0], false))
                }
            }
            if !body.isEmpty { out.append(.section(s.title)); out += body }
        }
        return out
    }

    private var items: [LibItem] { lines.compactMap { if case .item(let i, _) = $0 { i } else { nil } } }

    private func move(_ by: Int) {
        let list = items
        guard !list.isEmpty else { return }
        let at = cursor.flatMap { c in list.firstIndex { $0.key == c } } ?? (by > 0 ? -1 : list.count)
        cursor = list[max(0, min(list.count - 1, at + by))].key
    }

    private func choose() {
        let list = items
        if let c = cursor, list.contains(where: { $0.key == c }) { pick(c) } else if let first = list.first { pick(first.key) }
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").glyph(12).foregroundStyle(Palette.mutedFg)
                TextField("Search \(kind.noun) tokens", text: $query)
                    .textFieldStyle(.plain).font(Typography.body).focused($searchFocused)
                    .onSubmit(choose)
                    .onKeyPress(.downArrow) { move(1); return .handled }
                    .onKeyPress(.upArrow) { move(-1); return .handled }
                    .onKeyPress(.escape) { close(); return .handled }
            }
            .padding(.horizontal, 12).frame(height: Metric.control)
            .background(Capsule().fill(Palette.hover))
            if themed {
                HStack(spacing: 4) {
                    Spacer(minLength: 0)
                    ForEach(Array(model.themes.prefix(3)), id: \.self) { t in
                        Text(t.capitalized).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).fixedSize().frame(width: ThemeColumns.width)
                    }
                    Color.clear.frame(width: 18, height: 1)
                }
                .padding(.horizontal, 8)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(lines) { line in row(line) }
                        if items.isEmpty {
                            Text(query.isEmpty ? "No \(kind.noun) tokens in this file." : "Nothing matches \u{201C}\(query)\u{201D}.")
                                .font(Typography.body).foregroundStyle(Palette.mutedFg).padding(8)
                        }
                    }
                }
                .scrollIndicators(.automatic)
                .frame(maxHeight: .infinity)
                .onChange(of: cursor) { _, c in if let c { proxy.scrollTo(c) } }
                .onAppear { if let c = cursor { proxy.scrollTo(c, anchor: .center) } }
            }
            if let detach, let current {
                Rectangle().fill(Palette.stroke).frame(height: 1)
                Button(action: detach) {
                    HStack(spacing: 6) {
                        Image(systemName: "link").glyph(11).foregroundStyle(Palette.mutedFg).frame(width: 14)
                        Text("Detach").font(Typography.body).foregroundStyle(Palette.fg)
                        Spacer(minLength: 6)
                        if let v = model.tokenLiteral(current) {
                            if kind == .color, let c = parseColor(v) { ColorChip(color: c) }
                            Text(kind == .color ? v.uppercased() : v).font(Typography.mono).foregroundStyle(Palette.mutedFg).lineLimit(1)
                        }
                    }
                    .padding(.horizontal, 8).frame(height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Replace the token with its value")
            }
        }
        .padding(8).frame(width: 288, height: 380)
        .onAppear {
            cursor = current ?? items.first?.key
            DispatchQueue.main.async { searchFocused = true }
        }
        .onChange(of: query) { _, _ in
            if let c = cursor, items.contains(where: { $0.key == c }) { return }
            cursor = items.first?.key
        }
        .onExitCommand(perform: close)
    }

    @ViewBuilder private func row(_ line: Line) -> some View {
        switch line {
        case .section(let title):
            Text(title.uppercased()).font(Typography.section).tracking(0.6).foregroundStyle(Palette.mutedFg)
                .padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 2)
        case .group(_, let title):
            HStack(spacing: 6) {
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(Palette.mutedFg).frame(width: 10)
                Text(title).font(Typography.body).foregroundStyle(Palette.mutedFg).lineLimit(1)
            }
            .padding(.horizontal, 8).frame(height: 24)
        case .item(let item, let nested):
            TokenPickerRow(model: model, item: item, kind: kind, nested: nested, themed: themed,
                           isCurrent: item.key == current, isCursor: item.key == cursor,
                           hover: { cursor = item.key }, choose: { pick(item.key) })
                .id(item.key)
        }
    }
}

private struct TokenPickerRow: View {
    @ObservedObject var model: CanvasModel
    let item: LibItem
    let kind: TokenKind
    let nested: Bool
    let themed: Bool
    let isCurrent: Bool
    let isCursor: Bool
    let hover: () -> Void
    let choose: () -> Void

    var body: some View {
        Button(action: choose) {
            HStack(spacing: 6) {
                Text(nested ? item.leaf : item.title).font(Typography.body).fontWeight(isCurrent ? .semibold : nil)
                    .foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 6)
                values
                Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.sel)
                    .opacity(isCurrent ? 1 : 0).frame(width: 16)
            }
            .padding(.leading, nested ? 24 : 8).padding(.trailing, 8).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(isCursor ? Palette.active : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { if $0 { hover() } }
        .help(item.values.map { $0.theme.isEmpty ? $0.value : "\($0.theme): \($0.value)" }.joined(separator: "   "))
    }

    @ViewBuilder private var values: some View {
        if kind == .color {
            if themed {
                HStack(spacing: 4) {
                    ForEach(Array(model.themes.prefix(3).enumerated()), id: \.offset) { _, t in
                        let v = item.values.first { $0.theme == t }?.value ?? item.values.first?.value ?? ""
                        ColorChip(color: parseColor(v) ?? .gray).frame(width: ThemeColumns.width)
                    }
                }
            } else if let v = item.values.first?.value {
                ColorChip(color: parseColor(v) ?? .gray)
            }
        } else if let v = item.values.first?.value {
            Text(item.values.count > 1 ? item.values.map(\.value).joined(separator: " | ") : v).font(Typography.mono)
                .foregroundStyle(Palette.mutedFg).lineLimit(1).frame(maxWidth: 96, alignment: .trailing)
        }
    }
}

// MARK: letter spacing with Auto

/// The letter spacing column: a label, then the value in px with the one Auto control at its end. In auto the
/// field shows the computed value in blue and the Auto badge is filled; typing, scrubbing or an arrow key sets your
/// own value, which turns auto off. Clicking the badge flips auto: off keeps the computed value as your own.
struct TrackingField: View {
    let value: Double?
    let size: Double?
    let family: String
    let auto: Bool
    var enabled = true
    let onManual: (Double) -> Void
    let onAuto: (Bool) -> Void
    /// Binding a number token, like every other numeric field (shown on hover, left of the Auto badge).
    var model: CanvasModel? = nil
    var onBind: ((String) -> Void)? = nil
    @State private var hovering = false
    @State private var picking = false
    @Environment(\.editTarget) private var target
    @State private var text = ""
    @State private var draft = FieldDraft()
    @State private var scrub: ScrubSession?
    @FocusState private var focused: Bool

    private var pxText: String { NumberField.format(value ?? 0) }
    private var canTurnOn: Bool { size != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Letter spacing").font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).frame(height: 16).qaText("Letter spacing")
            FieldBox(disabled: !enabled) {
                ScrubHandle(enabled: enabled, begin: { scrub = ScrubSession(start: NumericInput.evaluate(text, current: value) ?? value ?? 0, min: nil, max: nil, write: onManual) },
                            move: { dx, step in if let s = scrub { text = NumberField.format(s.move(dx, step: step / 10)) } },
                            end: { scrub?.end(); scrub = nil }) {
                    Image(systemName: "textformat.characters.arrow.left.and.right").glyph(11).foregroundStyle(Palette.mutedFg)
                }
                .padding(.leading, -4).padding(.trailing, -2)
                TextField("0", text: $text)
                    .textFieldStyle(.plain).font(Typography.body).monospacedDigit()
                    .foregroundStyle(auto && !focused ? Palette.sel : Palette.fg)
                    .focused($focused).disabled(!enabled)
                    .onSubmit(commit)
                    // Letter spacing moves in tenths of a pixel: an arrow is 0.1, Shift 1, Option 0.01.
                    .onKeyPress(keys: [.upArrow, .downArrow]) { press in
                        let base = NumericInput.evaluate(text, current: value) ?? value ?? 0
                        let v = NumericInput.clean(base + NumericInput.step(press.modifiers) / 10 * (press.key == .upArrow ? 1 : -1))
                        text = NumberField.format(v)
                        if enabled { onManual(v) }
                        return .handled
                    }
                    .onKeyPress(.escape) { sync(); focused = false; return .handled }
                if !auto { Text("px").font(Typography.micro).foregroundStyle(Palette.mutedFg) }
                Button {
                    switch AutoTracking.click(on: auto, value: value, size: size, editable: enabled) {
                    case .turnOff: onAuto(false)
                    case .turnOn: onAuto(true)
                    case .none: break
                    }
                } label: {
                    Text("Auto").font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(auto ? Palette.sel : Palette.mutedFg)
                        .padding(.horizontal, 5).frame(height: 16)
                        .background(Capsule().fill(auto ? Palette.sel.opacity(0.14) : .clear))
                        .overlay(Capsule().stroke(auto ? .clear : Palette.stroke, lineWidth: 1))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!enabled || (!auto && !canTurnOn))
                .accessibilityLabel("Auto letter spacing")
                .accessibilityValue(auto ? "On" : "Off")
                .accessibilityAddTraits(.isToggle)
            }
            .help(helpText)
            // With "px" showing (Auto off) the hover button sits left of it, not over it.
            .modifier(OptionalBind(model: model, enabled: enabled, hovering: $hovering, picking: $picking, onBind: onBind, trailing: auto ? 44 : 62))
        }
        .onAppear(perform: sync)
        .onChange(of: value) { _, _ in if !focused && scrub == nil { sync() } }
        .onChange(of: target) { _, _ in if scrub == nil { sync() } }
        .onChange(of: focused) { _, f in if !f { commit() } }
    }

    private var helpText: String {
        let sizeText = size.map(NumberField.format) ?? "?"
        if auto {
            return "Auto: \(pxText) px (\(AutoTracking.percent(value ?? 0, size: size))) at \(sizeText) px, from \(AutoTracking.source(family)). Click Auto to keep this value as your own; type, drag or use the arrow keys to set another."
        }
        return canTurnOn ? "Click Auto for optical tracking at this font and size, from \(AutoTracking.source(family))." : "Set a font size to use Auto letter spacing."
    }

    private func sync() { text = pxText; draft.show(text, for: target) }

    private func commit() {
        guard draft.commits(text, target: target) else { sync(); return }
        // "-2%" is a percent of the font size, stored as px: -0.8 at 40.
        guard enabled, let raw = FieldMath.tracking(text, current: value, fontSize: size) else { sync(); return }
        let v = NumericInput.clean(raw)
        // In auto, only a changed number turns it off; leaving the field untouched keeps auto.
        if auto ? text != pxText : v != value { text = NumberField.format(v); draft.show(text, for: target); onManual(v) } else { sync() }
    }
}
