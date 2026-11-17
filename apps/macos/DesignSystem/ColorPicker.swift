// The colour picker: a popover for every colour swatch. Saturation/brightness square, hue and
// alpha sliders, Hex / RGB / HSL / OKLCH fields (arrow keys step, Shift steps ×10, Return or Tab commits,
// any CSS colour can be pasted into any field), the system eyedropper, and below them the document's colour
// tokens, recent colours, the colours this document uses most, and recommendations (ColorPickerSections.swift).
//
// Writes: while a drag runs, `onChange` fires at most 30 times a second with the live colour; the release
// fires `onCommit` once. The server folds same-field edits within 500 ms into one undo step (src/history.ts),
// so a drag is one step. Every value is "#RRGGBB" or "#RRGGBBAA". Colour math lives in ColorMath.swift.

import SwiftUI
import AppKit

/// What the picker knows about where it was opened. Everything is optional; sections without data hide.
struct ColorPickerContext {
    /// The server, for /api/colors (most used colours, the background behind the node).
    var base: URL?
    /// The open document's path: recents are kept per file as well as globally.
    var file: String?
    /// The node being edited: the server answers with the solid colour behind it.
    var nodeId: String?
    /// The background to rate contrast against, when the caller knows it better than the server.
    var background: String?
    /// The token the field is bound to now, shown selected in the tokens grid.
    var boundToken: String?
    /// The document's theme names; a themed token shows the value of the theme matching the app's appearance.
    var themes: [String] = []
}

struct ColorPickerPopover: View {
    let value: String
    var tokens: [LibSection] = []
    var context = ColorPickerContext()
    let onChange: (String) -> Void
    let onCommit: (String) -> Void
    let onPickToken: (String) -> Void
    /// The tallest the tokens / recent / recommended list grows before it scrolls.
    var listHeight: CGFloat = 300

    static let width: CGFloat = 240

    @State private var hsv = HSV(h: 0, s: 0, v: 0)
    @State private var alpha = 1.0
    /// The colour the sections recommend from: updated on commit, not on every drag frame.
    @State private var settled = RGBA.black
    @State private var original = RGBA.black
    @State private var dragging = false
    @State private var throttle = ColorThrottle()
    @State private var sampler: NSColorSampler?
    /// Bumped when the picker closes or its node changes: an eyedropper still open for the old target finishes
    /// into nothing instead of colouring whatever is selected by then.
    @State private var sampleGen = 0
    @AppStorage("canvas.colorPicker.mode") private var mode: ColorInputMode = .hex

    private var rgba: RGBA { RGBA(hsv: hsv, a: alpha) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SaturationBrightnessSquare(hsv: $hsv, onDrag: dragged, onEnd: released)
                .frame(height: 164)
            HStack(spacing: 8) {
                MiniButton(symbol: "eyedropper", help: "Pick a colour from the screen", action: sample)
                VStack(spacing: 8) {
                    HueSlider(hue: $hsv.h, onDrag: dragged, onEnd: released)
                    AlphaSlider(alpha: $alpha, color: rgba.opaque, onDrag: dragged, onEnd: released)
                }
                BeforeAfterSwatch(before: original, after: rgba) { set(original, commit: true) }
            }
            ColorModeTabs(mode: $mode)
            ColorInputs(mode: mode, color: rgba, hsv: hsv) { c, keepHue in set(c, commit: true, keepHue: keepHue) }
            if let bg = background { ContrastLine(color: rgba, background: bg) }
            Rectangle().fill(Palette.stroke).frame(height: 1).padding(.horizontal, -12)
            ScrollView(.vertical) {
                ColorPickerSections(color: settled, current: rgba.hex, tokens: tokens, context: context,
                                    docColors: docData.colors, background: background,
                                    onPickColor: { set($0, commit: true) }, onPickToken: pickToken)
            }
            .scrollIndicators(.automatic)
            .frame(maxHeight: listHeight)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, -12)
        }
        .padding(12)
        .frame(width: Self.width)
        .onAppear {
            let c = CSSColor.parse(value) ?? .black
            load(c); original = c
            docData.load(context)
        }
        .onChange(of: value) { _, v in
            // An echo of our own write keeps the hue we were dragging; anything else (undo, another editor) resyncs.
            guard !dragging, let c = CSSColor.parse(v), c.hex != rgba.hex else { return }
            load(c)
        }
        .onDisappear { sampleGen += 1; sampler = nil; throttle.flush() }
        .onChange(of: context.nodeId) { _, _ in sampleGen += 1 }
        .onChange(of: context.file) { _, _ in sampleGen += 1 }
    }

    @StateObject private var docData = ColorPickerDocData()

    private var background: RGBA? {
        (context.background.flatMap(CSSColor.parse)) ?? docData.background
    }

    private func load(_ c: RGBA) {
        let h = c.hsv
        // A grey has no hue: keep the one the square shows so the square does not jump to red.
        hsv = HSV(h: h.s < 1e-6 || h.v < 1e-6 ? hsv.h : h.h, s: h.s, v: h.v)
        alpha = c.a
        settled = c
    }

    private func set(_ c: RGBA, commit: Bool, keepHue: Bool = false) {
        let h = c.hsv
        hsv = HSV(h: keepHue || h.s < 1e-6 || h.v < 1e-6 ? hsv.h : h.h, s: h.s, v: h.v)
        alpha = c.a
        if commit { finish() }
    }

    private func dragged() {
        dragging = true
        throttle.send(rgba.hex, onChange)
    }

    private func released() {
        dragging = false
        finish()
    }

    private func finish() {
        throttle.cancel()
        let hex = rgba.hex
        settled = rgba
        ColorRecents.add(hex, file: context.file)
        onCommit(hex)
    }

    private func pickToken(_ name: String) {
        throttle.cancel()
        onPickToken(name)
    }

    private func sample() {
        let s = NSColorSampler()
        sampler = s
        sampleGen += 1
        let gen = sampleGen
        s.show { picked in
            guard gen == sampleGen else { return }
            sampler = nil
            guard let ns = picked?.usingColorSpace(.sRGB) else { return }
            set(RGBA(r: Double(ns.redComponent), g: Double(ns.greenComponent), b: Double(ns.blueComponent), a: alpha), commit: true)
        }
    }
}

extension RGBA {
    var color: Color { Color(.sRGB, red: r, green: g, blue: b, opacity: a) }
}

// MARK: write throttling

/// Leading and trailing throttle: the first change goes out at once, then at most one per interval,
/// and the last one is never lost. `cancel` drops a pending one (a commit is about to carry the final value).
final class ColorThrottle {
    var interval: TimeInterval = 1.0 / 30
    private var last = Date.distantPast
    private var pending: DispatchWorkItem?
    private var pendingValue: (String, (String) -> Void)?

    func send(_ v: String, _ out: @escaping (String) -> Void) {
        let now = Date()
        pendingValue = (v, out)
        if now.timeIntervalSince(last) >= interval, pending == nil {
            last = now; pendingValue = nil; out(v); return
        }
        // Drawn on the canvas now (src/page/live.js); written when the throttle lets it through.
        EditGesture.previewOnly = true
        out(v)
        EditGesture.previewOnly = false
        guard pending == nil else { return }
        let w = DispatchWorkItem { [weak self] in self?.fire() }
        pending = w
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, interval - now.timeIntervalSince(last)), execute: w)
    }

    private func fire() {
        pending = nil
        guard let (v, out) = pendingValue else { return }
        pendingValue = nil; last = Date(); out(v)
    }

    func flush() { pending?.cancel(); pending = nil; fire() }
    func cancel() { pending?.cancel(); pending = nil; pendingValue = nil }
}

// MARK: square and sliders

struct SaturationBrightnessSquare: View {
    @Binding var hsv: HSV
    let onDrag: () -> Void
    let onEnd: () -> Void

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            ZStack(alignment: .topLeading) {
                // Three gradient layers: hue, white from the left, black from the bottom. The GPU draws them at any scale.
                Rectangle().fill(RGBA(hsv: HSV(h: hsv.h, s: 1, v: 1)).color)
                LinearGradient(colors: [.white, .white.opacity(0)], startPoint: .leading, endPoint: .trailing)
                LinearGradient(colors: [.black.opacity(0), .black], startPoint: .top, endPoint: .bottom)
                Thumb(color: RGBA(hsv: hsv).color, size: 14)
                    .position(x: hsv.s * w, y: (1 - hsv.v) * h)
            }
            .clipShape(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous))
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { d in
                    var t = Transaction(); t.disablesAnimations = true
                    withTransaction(t) {
                        hsv.s = (d.location.x / max(w, 1)).clamped01
                        hsv.v = 1 - (d.location.y / max(h, 1)).clamped01
                    }
                    onDrag()
                }
                .onEnded { _ in onEnd() })
        }
        .accessibilityElement()
        .accessibilityLabel("Saturation and brightness")
        .accessibilityValue("Saturation \(Int(hsv.s * 100)) percent, brightness \(Int(hsv.v * 100)) percent")
        .accessibilityAdjustableAction { dir in
            hsv.v = (hsv.v + (dir == .increment ? 0.01 : -0.01)).clamped01; onEnd()
        }
    }
}

private struct Thumb: View {
    let color: Color
    var size: CGFloat = 14
    var body: some View {
        Circle().fill(color)
            .overlay(Circle().strokeBorder(.white, lineWidth: 2))
            .frame(width: size, height: size)
            .shadow(color: .black.opacity(0.35), radius: 1.5, y: 0.5)
            .allowsHitTesting(false)
    }
}

/// A 12 pt track with a thumb, dragged anywhere along it.
private struct SliderTrack<Track: View>: View {
    let fraction: Double
    let thumb: Color
    let onFraction: (Double) -> Void
    let onEnd: () -> Void
    @ViewBuilder var track: () -> Track

    var body: some View {
        GeometryReader { g in
            let r: CGFloat = 6, w = g.size.width
            ZStack(alignment: .leading) {
                track().clipShape(Capsule())
                Thumb(color: thumb, size: 14)
                    .position(x: r + fraction * (w - 2 * r), y: g.size.height / 2)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { d in
                    var t = Transaction(); t.disablesAnimations = true
                    withTransaction(t) { onFraction(((d.location.x - r) / max(w - 2 * r, 1)).clamped01) }
                }
                .onEnded { _ in onEnd() })
        }
        .frame(height: 12)
    }
}

struct HueSlider: View {
    @Binding var hue: Double
    let onDrag: () -> Void
    let onEnd: () -> Void
    private static let stops = stride(from: 0.0, through: 360, by: 30).map { RGBA(hsv: HSV(h: $0, s: 1, v: 1)).color }

    var body: some View {
        SliderTrack(fraction: hue / 360, thumb: RGBA(hsv: HSV(h: hue, s: 1, v: 1)).color,
                    onFraction: { hue = min($0 * 360, 359.999); onDrag() }, onEnd: onEnd) {
            LinearGradient(colors: Self.stops, startPoint: .leading, endPoint: .trailing)
        }
        .accessibilityElement()
        .accessibilityLabel("Hue")
        .accessibilityValue("\(Int(hue)) degrees")
        .accessibilityAdjustableAction { dir in hue = (hue + (dir == .increment ? 1 : -1)).wrappedHue; onEnd() }
    }
}

struct AlphaSlider: View {
    @Binding var alpha: Double
    let color: RGBA
    let onDrag: () -> Void
    let onEnd: () -> Void

    var body: some View {
        SliderTrack(fraction: alpha, thumb: color.with(alpha: alpha).over(.white).color,
                    onFraction: { alpha = ($0 * 100).rounded() / 100; onDrag() }, onEnd: onEnd) {
            ZStack {
                Checkerboard()
                LinearGradient(colors: [color.with(alpha: 0).color, color.color], startPoint: .leading, endPoint: .trailing)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Opacity")
        .accessibilityValue("\(Int((alpha * 100).rounded())) percent")
        .accessibilityAdjustableAction { dir in alpha = (alpha + (dir == .increment ? 0.01 : -0.01)).clamped01; onEnd() }
    }
}

/// The transparency grid under translucent colours. Drawn once per size; it takes no inputs, so it never redraws during a drag.
struct Checkerboard: View {
    var cell: CGFloat = 4
    var body: some View {
        Canvas { ctx, size in
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
            var p = Path()
            let cols = Int(ceil(size.width / cell)), rows = Int(ceil(size.height / cell))
            for y in 0..<rows { for x in 0..<cols where (x + y) % 2 == 1 { p.addRect(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)) } }
            ctx.fill(p, with: .color(Color(white: 0.82)))
        }
    }
}

/// The colour the popover opened with beside the one it holds now. Click the left half to go back.
private struct BeforeAfterSwatch: View {
    let before: RGBA
    let after: RGBA
    let revert: () -> Void
    var body: some View {
        HStack(spacing: 0) {
            Button(action: revert) { ZStack { Checkerboard(); before.color } }
                .buttonStyle(.plain).help("Back to \(before.hex)")
            ZStack { Checkerboard(); after.color }.allowsHitTesting(false)
        }
        .frame(width: 32, height: 32)
        .clipShape(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous))
        .shadow(color: .black.opacity(0.25), radius: 0.5)
    }
}

// MARK: inputs

enum ColorInputMode: String, CaseIterable, Identifiable {
    case hex = "Hex", rgb = "RGB", hsl = "HSL", oklch = "OKLCH"
    var id: String { rawValue }
}

private struct ColorModeTabs: View {
    @Binding var mode: ColorInputMode
    var body: some View {
        HStack(spacing: 2) {
            ForEach(ColorInputMode.allCases) { m in
                Button { mode = m } label: {
                    Text(m.rawValue).font(Typography.micro).fontWeight(mode == m ? .semibold : .regular)
                        .foregroundStyle(mode == m ? Palette.fg : Palette.mutedFg)
                        .frame(maxWidth: .infinity).frame(height: 20)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField - 2, style: .continuous).fill(mode == m ? Palette.active : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
    }
}

/// The fields for one mode. `set(color, keepHue)` applies a new colour; keepHue is true when the edit did not touch hue.
private struct ColorInputs: View {
    let mode: ColorInputMode
    let color: RGBA
    let hsv: HSV
    let set: (RGBA, Bool) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            switch mode {
            case .hex:
                PickerHexField(color: color) { set($0, false) }
            case .rgb:
                channel("R", color.r * 255, 0...255) { set(RGBA(r: $0 / 255, g: color.g, b: color.b, a: color.a), false) }
                channel("G", color.g * 255, 0...255) { set(RGBA(r: color.r, g: $0 / 255, b: color.b, a: color.a), false) }
                channel("B", color.b * 255, 0...255) { set(RGBA(r: color.r, g: color.g, b: $0 / 255, a: color.a), false) }
            case .hsl:
                let h = color.hsl
                // HSL of a grey has no hue; show the square's hue so stepping S brings it back.
                let hue = h.s < 1e-6 ? hsv.h : h.h
                channel("H", hue, 0...360, wraps: true) { set(RGBA(hsl: HSL(h: $0, s: h.s, l: h.l), a: color.a), false) }
                channel("S", h.s * 100, 0...100) { set(RGBA(hsl: HSL(h: hue, s: $0 / 100, l: h.l), a: color.a), true) }
                channel("L", h.l * 100, 0...100) { set(RGBA(hsl: HSL(h: hue, s: h.s, l: $0 / 100), a: color.a), true) }
            case .oklch:
                let o = color.oklch
                let hue = o.c < 1e-4 ? hsv.h : o.h
                channel("L", o.l * 100, 0...100, digits: 1) { set(RGBA(oklch: OKLCH(l: $0 / 100, c: o.c, h: hue), a: color.a), false) }
                channel("C", o.c, 0...0.4, digits: 3, step: 0.005) { set(RGBA(oklch: OKLCH(l: o.l, c: $0, h: hue), a: color.a), false) }
                channel("H", hue, 0...360, digits: 1, wraps: true) { set(RGBA(oklch: OKLCH(l: o.l, c: o.c, h: $0), a: color.a), false) }
            }
            channel("A", color.a * 100, 0...100, suffix: "%") { set(color.with(alpha: $0 / 100), true) }
                .frame(width: mode == .hex ? 56 : nil)
        }
    }

    private func channel(_ label: String, _ v: Double, _ range: ClosedRange<Double>, digits: Int = 0, step: Double = 1,
                         wraps: Bool = false, suffix: String = "", apply: @escaping (Double) -> Void) -> some View {
        ChannelField(label: label, value: v, range: range, digits: digits, step: step, wraps: wraps, suffix: suffix,
                     onSet: apply, onPaste: { set($0, false) })
    }
}

/// Steps a number field with the arrow keys: Up/Down by `step`, with Shift by ten steps.
private struct ArrowStepping: ViewModifier {
    let step: (Double) -> Void
    func body(content: Content) -> some View {
        content.onKeyPress(keys: [.upArrow, .downArrow], phases: [.down, .repeat]) { press in
            let k = press.modifiers.contains(.shift) ? 10.0 : 1.0
            step(press.key == .upArrow ? k : -k)
            return .handled
        }
    }
}

/// One number: commits on Return, Tab or focus loss; a pasted CSS colour replaces the whole colour.
private struct ChannelField: View {
    let label: String
    let value: Double
    let range: ClosedRange<Double>
    var digits = 0
    var step = 1.0
    var wraps = false
    var suffix = ""
    let onSet: (Double) -> Void
    let onPaste: (RGBA) -> Void
    @State private var text = ""
    /// The text the field last showed for a value: until the user types, it follows the colour even while focused,
    /// and leaving it untouched commits nothing (a stale text never writes the old colour back).
    @State private var shown = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 2) {
            FieldBox {
                TextField("", text: $text)
                    .textFieldStyle(.plain).font(Typography.numeric).multilineTextAlignment(.center)
                    .focused($focused)
                    .onSubmit(commit)
                    .modifier(ArrowStepping { n in
                        let base = Double(text.trimmingCharacters(in: CharacterSet(charactersIn: " %°"))).flatMap { $0.isFinite ? $0 : nil } ?? value
                        apply(base + n * step)
                    })
            }
            Text(label).font(.system(size: 9, weight: .medium)).foregroundStyle(Palette.mutedFg)
        }
        .frame(maxWidth: .infinity)
        .help(label == "A" ? "Opacity" : label)
        .onAppear(perform: sync)
        .onChange(of: value) { _, _ in if !focused || text == shown { sync() } }
        .onChange(of: focused) { _, f in if !f { commit() } }
        .onChange(of: text) { old, t in
            // A pasted colour ("rgb(…)", "#…", "oklch(…)", "tomato") goes straight in; typed text waits for Return.
            guard t != shown, ColorFieldText.appliesLive(old: old, new: t),
                  Double(t.trimmingCharacters(in: CharacterSet(charactersIn: " %°"))) == nil, let c = CSSColor.parse(t) else { return }
            // Shows the old value until the new colour arrives, then follows it (text == shown).
            sync()
            onPaste(c)
        }
    }

    private func format(_ v: Double) -> String { CSSColor.fmt(v, digits) + suffix }
    private func sync() { text = format(value); shown = text }

    private func apply(_ v: Double) {
        // Hue wraps around (359 + 1 = 0); everything else stops at its ends.
        let x = wraps ? v.wrappedHue : min(max(v, range.lowerBound), range.upperBound)
        text = format(x)
        shown = text
        onSet(x)
    }

    private func commit() {
        if text == shown { return }
        let t = text.trimmingCharacters(in: CharacterSet(charactersIn: " %°"))
        // "nan" and "inf" parse as Doubles: not a channel value.
        guard let v = Double(t), v.isFinite else {
            if let c = CSSColor.parse(text) { onPaste(c) }
            sync(); return
        }
        if abs(v - value) < pow(10, -Double(digits)) / 2 { sync(); return }
        apply(v)
    }
}

/// The hex field: six hex digits (three, four or eight work too) or any CSS colour.
private struct PickerHexField: View {
    let color: RGBA
    let set: (RGBA) -> Void
    @State private var text = ""
    /// The text last shown for a colour (see ChannelField.shown).
    @State private var shown = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 2) {
            FieldBox {
                Text("#").font(Typography.numeric).foregroundStyle(Palette.mutedFg)
                TextField("", text: $text)
                    .textFieldStyle(.plain).font(Typography.numeric)
                    .focused($focused)
                    .onSubmit(commit)
                    .modifier(ArrowStepping { n in
                        // Step brightness as well; useful, harmless.
                        var h = color.hsv; h.v = (h.v + n / 100).clamped01
                        apply(RGBA(hsv: h, a: color.a))
                    })
            }
            Text("Hex").font(.system(size: 9, weight: .medium)).foregroundStyle(Palette.mutedFg)
        }
        .frame(maxWidth: .infinity)
        .onAppear(perform: sync)
        .onChange(of: color) { _, _ in if !focused || text == shown { sync() } }
        .onChange(of: focused) { _, f in if !f { commit() } }
        .onChange(of: text) { old, t in
            guard t != shown, ColorFieldText.appliesLive(old: old, new: t), let c = CSSColor.parse(t) else { return }
            if t.contains("(") { apply(c) } else { commit() }
        }
    }

    private func sync() { text = color.hex6; shown = text }

    /// Shows the colour just applied, not `color`, which still holds the old one until the picker redraws:
    /// syncing from it put the old hex back in the field, and leaving the field then wrote the old colour again.
    private func apply(_ c: RGBA) {
        set(c)
        text = c.hex6
        shown = text
    }

    private func commit() {
        if text == shown { return }
        let t = text.trimmingCharacters(in: .whitespaces)
        guard t.uppercased() != color.hex6, var c = CSSColor.parse(t) else { sync(); return }
        // Six digits keep the current opacity; eight set it.
        let digits = t.hasPrefix("#") ? t.count - 1 : t.count
        if RGBA(hex: t) != nil, digits == 6 || digits == 3 { c.a = color.a }
        apply(c)
    }
}

// MARK: contrast line

/// The current colour as text on the node's background: WCAG ratio and level, APCA Lc.
struct ContrastLine: View {
    let color: RGBA
    let background: RGBA
    var body: some View {
        let ratio = Contrast.wcag(color, on: background), lc = Contrast.apca(color, on: background)
        HStack(spacing: 6) {
            Text("Aa").font(.system(size: 12, weight: .semibold)).foregroundStyle(color.color)
                .frame(width: 26, height: 20)
                .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(background.color))
                .shadow(color: .black.opacity(0.2), radius: 0.5)
            Spacer(minLength: 0)
            ContrastBadge(text: "\(CSSColor.fmt(ratio, 1)):1 \(Contrast.wcagLevel(ratio))", pass: ratio >= 4.5)
            ContrastBadge(text: "Lc \(Int(lc.rounded()))", pass: abs(lc) >= 60)
        }
        .help("This colour as text on \(background.hex), the background behind the node: WCAG 2 ratio and APCA Lc")
    }
}

struct ContrastBadge: View {
    let text: String
    let pass: Bool
    var body: some View {
        Text(text).font(.system(size: 10, weight: .semibold)).monospacedDigit()
            .foregroundStyle(pass ? Palette.ok : Palette.warn)
            .padding(.horizontal, 5).frame(height: 16)
            .background(Capsule().fill((pass ? Palette.ok : Palette.warn).opacity(0.14)))
            .lineLimit(1).fixedSize()
    }
}
