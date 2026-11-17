// Canvas's component library, drawn in Liquid Glass.
//
// Rule: a component takes content and state, never a color or a size. Every value comes from
// Palette, Metric, Typography or Motion (generated from src/tokens.ts), so one token edit
// restyles the studio. Glass carries its own edge light, so nothing here draws a border.

import SwiftUI

// MARK: Glyphs

/// One look for every SF Symbol in the chrome: medium weight, hierarchical rendering, a size per context
/// (32 pt controls 15, list rows and segments 12, field prefixes 11, section titles 10).
enum GlyphSize {
    static let control: CGFloat = Metric.icon
    static let row: CGFloat = 12
    static let field: CGFloat = 11
    static let caption: CGFloat = 10
}

extension Image {
    func glyph(_ size: CGFloat) -> some View {
        symbolRenderingMode(.hierarchical).font(.system(size: size, weight: .medium))
    }

    /// The rail's look (IconButton): 15 pt, medium, one tone. Monochrome, because the rail's own symbols have one
    /// layer, while kinds like checklist or a chart's axes have two that .hierarchical draws in two shades.
    func railGlyph() -> some View {
        symbolRenderingMode(.monochrome).font(.system(size: Metric.icon, weight: .medium))
    }
}

// MARK: QA marks

extension View {
    /// Marks this view for pnpm qa:native: a QA build (QA.swift) lays an invisible AppKit view under it that the
    /// harness reads (qa.marks) for the view's frame and label, so scenarios find controls without text
    /// recognition. A normal build compiles this to the view itself.
    func qaID(_ id: String, label: String? = nil) -> some View {
        #if CANVAS_QA
        // Out of hit testing: a click on a marked button's label reaches the button, never the mark's host view.
        background(QAMark(id: id, label: label).allowsHitTesting(false))
        #else
        self
        #endif
    }
    /// A mark labelled with the text the view draws: qa:native finds it as it would find the text on screen.
    func qaText(_ text: String) -> some View { qaID("text", label: text) }
}

// MARK: Surfaces

/// A floating island: Liquid Glass over the canvas and a soft lift. No rim; the glass has its own edge.
struct GlassIsland<Content: View>: View {
    var radius: CGFloat = Metric.radiusIsland
    var padding: CGFloat = Metric.islandPad
    /// Panels full of small text (properties, lists) tint their glass with the sidebar color, so
    /// a loud board behind them cannot wash out the labels. Pills stay clear.
    var dense = false
    @ViewBuilder var content: () -> Content

    /// Liquid Glass turns flat grey when the window is not key (another window or monitor has focus).
    /// Under it, an inactive window gets the panel's own colour, so the sidebars keep their light look.
    @Environment(\.appearsActive) private var appearsActive

    var body: some View {
        content()
            .padding(padding)
            .background {
                if !appearsActive {
                    RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Palette.sidebar.opacity(dense ? 0.92 : 0.8))
                }
            }
            .glassEffect(dense ? .regular.tint(Palette.sidebar.opacity(0.82)) : .regular,
                         in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .shadow(color: .black.opacity(0.10), radius: 14, y: 4)
    }
}

/// A capsule island that wraps 32pt controls with 4pt around them: tab bar, rail, zoom.
struct GlassPill<Content: View>: View {
    var padding: CGFloat = Metric.pillPad
    @ViewBuilder var content: () -> Content

    var body: some View { GlassIsland(radius: 999, padding: padding, content: content) }
}

// MARK: Buttons

struct IconButton: View {
    let symbol: String
    var active = false
    var help: String = ""
    /// Bump to bounce the glyph (an add action just landed). Ignored under Reduce Motion.
    var bounce = 0
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .symbolRenderingMode(.hierarchical)
                .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                .symbolEffect(.bounce, value: reduceMotion ? 0 : bounce)
                .font(.system(size: Metric.icon, weight: .medium))
                .foregroundStyle(active ? Palette.fg : Palette.mutedFg)
                .frame(width: Metric.control, height: Metric.control)
                .background(Circle().fill(active ? Palette.active : (hovering ? Palette.hover : .clear)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .chromeHelp(help)
        .accessibilityLabel(help.isEmpty ? symbol : help)
        .accessibilityAddTraits(active ? .isSelected : [])
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

struct PillButton: View {
    enum Style { case primary, ghost, destructive }
    let title: String
    var style: Style = .ghost
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Typography.label)
                .foregroundStyle(style == .primary ? Palette.primaryFg : style == .destructive ? Palette.danger : Palette.fg)
                .padding(.horizontal, 14)
                .frame(height: Metric.control)
                .background(Capsule().fill(style == .primary ? Palette.primary.opacity(hovering ? 0.88 : 1)
                    : style == .destructive ? Palette.danger.opacity(hovering ? 0.18 : 0.1) : (hovering ? Palette.hover : .clear)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

// MARK: Tabs

struct TabChip: View {
    let title: String
    var active = false
    /// The file is gone from disk: a warning glyph, a struck-through name, and "File not found" on hover.
    var missing = false
    let onClose: () -> Void
    let action: () -> Void
    @State private var hovering = false
    @State private var hoveringClose = false

    var body: some View {
        HStack(spacing: 0) {
            Button(action: action) {
                HStack(spacing: 6) {
                    Image(systemName: missing ? "exclamationmark.triangle" : "doc").glyph(11)
                        .foregroundStyle(missing ? Color.orange : Palette.mutedFg)
                    Text(title).font(Typography.label).lineLimit(1).truncationMode(.middle)
                        .strikethrough(missing)
                        .foregroundStyle(active && !missing ? Palette.fg : Palette.mutedFg)
                }
                .padding(.leading, 12).padding(.trailing, 4)
                .frame(height: Metric.control)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .chromeHelp(missing ? "File not found. Click to locate it or close the tab." : title)
            .accessibilityAddTraits(active ? .isSelected : [])
            Button(action: onClose) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(hoveringClose || active ? Palette.fg : Palette.mutedFg)
                    .frame(width: Metric.control - 8, height: Metric.control - 8)
                    .background(Circle().fill(hoveringClose ? Palette.active : .clear))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain).chromeHelp("Close tab").accessibilityLabel("Close \(title)")
            .onHover { h in withAnimation(Motion.fast) { hoveringClose = h } }
            .padding(.trailing, 4)
        }
        .frame(maxWidth: Metric.tabMax)
        .background(Capsule().fill(active ? Palette.active : (hovering ? Palette.hover : .clear)))
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

/// A horizontal strip that hugs its content, then scrolls once the space runs out. A fade marks
/// each edge that has more behind it, and disappears at the end of the strip.
struct FadingScroller<Content: View>: View {
    var scrollTo: String?
    @ViewBuilder var content: () -> Content
    @State private var m = Metrics()

    struct Metrics: Equatable { var offset: CGFloat = 0; var content: CGFloat = 0; var container: CGFloat = 0 }
    private let fade: CGFloat = 28

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2, content: content)
            }
            .scrollIndicators(.never)
            .onScrollGeometryChange(for: Metrics.self) { g in
                Metrics(offset: g.contentOffset.x, content: g.contentSize.width, container: g.containerSize.width)
            } action: { _, new in m = new }
            .frame(maxWidth: m.content > 0 ? m.content : .infinity)
            .mask(HStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                    .frame(width: m.offset > 1 ? fade : 0)
                Rectangle()
                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: m.offset + m.container < m.content - 1 ? fade : 0)
            }.animation(Motion.fast, value: m))
            .onChange(of: scrollTo) { _, id in
                guard let id else { return }
                withAnimation(Motion.island) { proxy.scrollTo(id, anchor: .center) }
            }
        }
    }
}

// MARK: Rows and fields

struct SectionHeader: View {
    let title: String
    var body: some View {
        Text(title.uppercased()).qaText(title)
            .font(Typography.section).tracking(0.6)
            .foregroundStyle(Palette.mutedFg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 4)
    }
}

struct ColorChip: View {
    let color: Color
    var body: some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(color).frame(width: 14, height: 14)
            .shadow(color: .black.opacity(0.25), radius: 0.5)
    }
}

struct ListRow: View {
    let title: String
    var detail: String?
    var chip: Color?
    var symbol: String?
    /// The symbol's colour when it carries meaning (components are purple); muted otherwise.
    var tint: Color?
    var font: Font = Typography.body
    /// Bounce the symbol when tapped (add actions).
    var bounces = false
    /// Draw the symbol like the rail's icons (railGlyph) instead of the smaller two-tone row glyph.
    var railGlyph = false
    /// The current item (the page shown, the board the selection is on): filled like a pressed row.
    var active = false
    var action: (() -> Void)?
    @State private var hovering = false
    @State private var taps = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button { taps += 1; action?() } label: {
            HStack(spacing: 8) {
                if let chip { ColorChip(color: chip) }
                if let symbol, railGlyph {
                    Image(systemName: symbol).railGlyph()
                        .symbolEffect(.bounce, value: bounces && !reduceMotion ? taps : 0)
                        .foregroundStyle(tint ?? Palette.mutedFg).frame(width: 18)
                } else if let symbol {
                    Image(systemName: symbol).symbolRenderingMode(.hierarchical)
                        .symbolEffect(.bounce, value: bounces && !reduceMotion ? taps : 0)
                        .font(.system(size: GlyphSize.row, weight: .medium)).foregroundStyle(tint ?? Palette.mutedFg).frame(width: 16)
                }
                Text(title).font(font).fontWeight(active ? .semibold : nil).foregroundStyle(Palette.fg).lineLimit(1).qaText(title)
                Spacer(minLength: 8)
                if let detail {
                    Text(detail).font(Typography.micro).monospacedDigit().foregroundStyle(Palette.mutedFg).lineLimit(1)
                }
            }
            .padding(.horizontal, 12).frame(height: Metric.row)
            .background(RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).fill(active ? Palette.active : hovering ? Palette.hover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

struct KeyValueRow: View {
    let key: String
    let value: String
    var chip: Color?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(key).font(Typography.body).foregroundStyle(Palette.mutedFg).frame(width: 92, alignment: .leading)
            HStack(spacing: 6) {
                if let chip { ColorChip(color: chip) }
                Text(value).font(Typography.body).monospacedDigit().foregroundStyle(Palette.fg)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 4)
    }
}

// MARK: Compound islands

struct ZoomPill: View {
    let percent: Int
    let zoomOut: () -> Void
    let zoomIn: () -> Void
    let reset: () -> Void
    let fitPage: () -> Void
    let fitSelection: () -> Void
    /// A typed zoom (the zoom field): 1 is 100%.
    var zoomTo: (Double) -> Void = { _ in }
    /// The popover is open (CanvasModel.zoomFieldOpen, so QA can see it).
    @Binding var open: Bool

    var body: some View {
        GlassPill {
            HStack(spacing: 0) {
                IconButton(symbol: "minus", help: "Zoom out  \u{21E7}\u{2212}", action: zoomOut)
                // The percentage opens a zoom field (type 150 and Return) over the zoom choices.
                Button { open.toggle() } label: {
                    Text("\(percent)%").font(Typography.numeric).foregroundStyle(Palette.fg)
                        .frame(width: 52, height: Metric.control).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Zoom: type a percentage, or pick a zoom")
                .accessibilityLabel("Zoom \(percent) percent")
                .qaID("zoom-pill", label: "\(percent)%")
                .modifier(QAFrame(id: "zoom.percent"))
                .popover(isPresented: $open, arrowEdge: .top) {
                    ZoomField(percent: percent, zoomTo: { zoomTo($0); open = false },
                              choices: [("Zoom to Fit Page", "\u{21E7}1", fitPage), ("Zoom to Selection", "\u{21E7}2", fitSelection), ("Zoom to 100%", "\u{21E7}0", reset)],
                              close: { open = false })
                }
                IconButton(symbol: "plus", help: "Zoom in  \u{21E7}+", action: zoomIn)
            }
        }
    }
}

/// The zoom pill's popover: a field that takes a percentage (ZoomInput), focused with the current zoom selected,
/// then the zoom choices with their keys.
struct ZoomField: View {
    let percent: Int
    let zoomTo: (Double) -> Void
    let choices: [(title: String, key: String, run: () -> Void)]
    let close: () -> Void
    @State private var text = ""
    @State private var bad = false
    /// Nothing typed yet: the first keys replace the zoom the field opened with.
    @State private var pristine = true
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            FieldBox {
                TextField("Zoom", text: $text)
                    .textFieldStyle(.plain).font(Typography.body).monospacedDigit().foregroundStyle(bad ? Palette.danger : Palette.fg)
                    .focused($focused)
                    .onSubmit(commit)
                    .onKeyPress(.escape) { close(); return .handled }
                    .onChange(of: text) { old, new in
                        bad = false
                        // Typing over the zoom it opened with replaces it, as with the text selected (the selection
                        // can miss when the popover becomes key after the field took focus).
                        if old.isEmpty { return } // the field filling in on open
                        if pristine, old == String(percent), new.count > old.count, new.hasPrefix(old) { text = String(new.dropFirst(old.count)) }
                        pristine = false
                    }
                Text("%").font(Typography.body).foregroundStyle(Palette.mutedFg)
            }
            .accessibilityLabel("Zoom percentage")
            .padding(.bottom, 4)
            ForEach(Array(choices.enumerated()), id: \.offset) { _, c in
                ZoomChoiceRow(title: c.title, key: c.key) { c.run(); close() }
                    .modifier(QAFrame(id: "zoom.choice." + c.title))
            }
        }
        .padding(8).frame(width: 220)
        .onAppear {
            text = String(percent)
            DispatchQueue.main.async {
                focused = true
                // Selected, so typing replaces it.
                DispatchQueue.main.async { (NSApp.keyWindow?.firstResponder as? NSTextView)?.selectAll(nil) }
            }
        }
    }

    private func commit() {
        switch ZoomInput.parse(text) {
        case .zoom(let z): zoomTo(z)
        case .fit: choices.first?.run(); close()
        case .invalid: bad = true
        }
    }
}

private struct ZoomChoiceRow: View {
    let title: String
    let key: String
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).font(Typography.body).foregroundStyle(Palette.fg)
                Spacer(minLength: 8)
                Text(key).font(Typography.body).foregroundStyle(Palette.mutedFg)
            }
            .padding(.horizontal, 8).frame(height: Metric.field)
            .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(hovering ? Palette.hover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// Where the toast's text and buttons are drawn (window points, top left), for pnpm qa:native to click them without
/// reading the screen.
@MainActor
enum ToastFrames {
    static var rects: [String: CGRect] = [:]
    static func track(_ key: String) -> some View {
        GeometryReader { g in
            Color.clear
                .onAppear { rects[key] = g.frame(in: .global) }
                .onChange(of: g.frame(in: .global)) { _, r in rects[key] = r }
                .onDisappear { rects[key] = nil }
        }
    }
}

/// A button on a toast: Undo (from the page) or Ask agent (an error, when an agent is installed).
struct ToastAction: Identifiable {
    let id: String
    let label: String
    let symbol: String?
    let run: () -> Void
}

struct Toast: View {
    enum Kind { case plain, success, waiting, link }
    let text: String
    var kind: Kind = .plain
    var actions: [ToastAction] = []
    /// A click on the text copies (a path or an error, ToastLogic); nil: the text is not clickable.
    var onCopy: (() -> Void)?
    var onHover: (Bool) -> Void = { _ in }
    @State private var drawn = false
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GlassPill(padding: 0) {
            HStack(spacing: 8) {
                Button { onCopy?() } label: { label.contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .allowsHitTesting(onCopy != nil)
                    .chromeHelp(onCopy == nil ? "" : "Click to copy")
                    .accessibilityAddTraits(onCopy == nil ? [] : .isButton)
                    .accessibilityHint(onCopy == nil ? "" : "Copies it")
                    .background(ToastFrames.track("text"))
                ForEach(actions) { a in ToastButton(action: a).background(ToastFrames.track(a.label)) }
            }
            .padding(.leading, 16).padding(.trailing, actions.isEmpty ? 16 : Metric.pillPad)
            .frame(height: Metric.control + 2 * Metric.pillPad)
        }
        .onHover { h in hovering = h; onHover(h) }
    }

    private var label: some View {
            HStack(spacing: 8) {
                switch kind {
                case .success:
                    // A checkmark at the label's size in the text colour: a green one vanished on the light glass.
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.fg)
                        .symbolEffect(.drawOn, isActive: !drawn && !reduceMotion)
                        .onAppear { drawn = true }
                case .waiting:
                    Image(systemName: "hourglass").symbolRenderingMode(.hierarchical)
                        .font(.system(size: Metric.icon, weight: .medium)).foregroundStyle(Palette.mutedFg)
                        .symbolEffect(.pulse, isActive: !reduceMotion)
                case .link:
                    // Copy Link: the link symbol at the label's size, in the text colour.
                    Image(systemName: "link").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.fg)
                case .plain: EmptyView()
                }
                // One line: a long error is cut in the middle, and a click copies all of it.
                Text(text).font(Typography.label).foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.middle)
                if onCopy != nil {
                    // The copy glyph shows while the pointer is on a toast that copies.
                    Image(systemName: "doc.on.doc").font(.system(size: 11, weight: .medium)).foregroundStyle(Palette.fg)
                        .opacity(hovering ? 1 : 0).accessibilityHidden(true)
                }
            }
    }
}

/// Undo or Ask agent on a toast: grey, at the control height, concentric with the pill, text-colour label (agent controls are grey).
private struct ToastButton: View {
    let action: ToastAction
    @State private var hovering = false
    var body: some View {
        Button(action: action.run) {
            HStack(spacing: 5) {
                if let s = action.symbol { Image(systemName: s).font(.system(size: 12, weight: .semibold)) }
                Text(action.label).font(Typography.label.weight(.semibold)).lineLimit(1)
            }
            .foregroundStyle(Palette.fg)
            .padding(.horizontal, 12).frame(height: Metric.control)
            .background(Capsule().fill(hovering ? Palette.active : Palette.hover))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
        .accessibilityLabel(action.label)
    }
}

/// A family name drawn in its own face. Installed is the normal case and shows nothing; a font this Mac
/// lacks gets the orange Missing tag.
struct FontFamilyRow: View {
    let family: String
    let installed: Bool
    var body: some View {
        HStack(spacing: 8) {
            Text(family).font(installed ? .custom(family, size: 14) : Typography.body)
                .foregroundStyle(Palette.fg).lineLimit(1)
            Spacer(minLength: 0)
            if !installed { MissingTag() }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }
}

/// The orange tag on a font this Mac does not have.
struct MissingTag: View {
    var body: some View {
        Text("Missing").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.warn)
            .padding(.horizontal, 6).frame(height: 16)
            .background(Capsule().fill(Palette.warn.opacity(0.16)))
            .help("Not installed on this Mac. Canvas draws it with a fallback font.")
    }
}

struct SearchField: View {
    let prompt: String
    @Binding var text: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").glyph(12).foregroundStyle(Palette.mutedFg)
            TextField(prompt, text: $text).textFieldStyle(.plain).font(Typography.body).qaText(prompt)
        }
        .padding(.horizontal, 12).frame(height: Metric.control)
        .background(Capsule().fill(Palette.hover))
    }
}

// MARK: Inspector controls (the property panel's sections, rows and fields)

/// A panel section: hairline above, a title with an optional trailing control, then its fields.
struct InspectorSection<Trailing: View, Content: View>: View {
    let title: String
    /// A symbol before the title, tinted when the section means something (the Component section is purple).
    var symbol: String? = nil
    var tint: Color? = nil
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                if let symbol { Image(systemName: symbol).glyph(10).foregroundStyle(tint ?? Palette.mutedFg) }
                Text(title).font(Typography.label).foregroundStyle(tint ?? Palette.fg).qaText(title)
                Spacer(minLength: 0)
                trailing()
            }
            content()
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .overlay(alignment: .top) { Rectangle().fill(Palette.stroke).frame(height: 1).padding(.horizontal, 12) }
    }
}

extension InspectorSection where Trailing == EmptyView {
    init(title: String, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, trailing: { EmptyView() }, content: content)
    }
    init(title: String, symbol: String, tint: Color, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, symbol: symbol, tint: tint, trailing: { EmptyView() }, content: content)
    }
}

/// What the inspector's fields edit right now (file and selected node ids, or a widget). A field drops a draft
/// typed for another target (FieldDraft): its commit would otherwise go to whatever is selected now.
private struct EditTargetKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
    var editTarget: String? {
        get { self[EditTargetKey.self] }
        set { self[EditTargetKey.self] = newValue }
    }
}

/// Fixed field widths in the properties panel, sized so their longest value fits at the panel's width.
enum FieldWidth {
    /// "100" and "%" (a fill's, stroke's or shadow's opacity).
    static let percent: CGFloat = 60
}

/// The rounded well every field sits in.
struct FieldBox<Content: View>: View {
    var disabled = false
    @ViewBuilder var content: () -> Content
    var body: some View {
        HStack(spacing: 6, content: content)
            .padding(.horizontal, 8).frame(height: Metric.field)
            .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
            .opacity(disabled ? 0.5 : 1)
    }
}

/// A number with a prefix glyph or letter. The glyph scrubs (drag left and right), Up and Down step,
/// Return or leaving commits, Esc reverts, the text takes arithmetic (see NumericInput). A value the
/// file does not hold (auto size, layout-driven position) shows as a disabled placeholder.
struct NumberField: View {
    let prefix: String
    var symbol: String?
    var value: Double?
    /// What the field shows without a value: "Mixed", "Auto", or nothing (a value the file leaves to layout).
    var placeholder = ""
    var suffix = ""
    var enabled = true
    var minimum: Double?
    var maximum: Double?
    /// Up/Down while the field reads "Mixed": the step, for each layer to take from its own value.
    var onStep: ((Double) -> Void)? = nil
    /// "+10", "*2" or "/2" typed while the field reads "Mixed": each layer takes it from its own value.
    var onRelative: ((String) -> Void)? = nil
    /// Applied to a typed or stepped value before it is written (rotation normalises to -180...180).
    var normalize: ((Double) -> Double)? = nil
    let onCommit: (Double) -> Void
    @Environment(\.editTarget) private var target
    @State private var text = ""
    @State private var draft = FieldDraft()
    @State private var scrub: ScrubSession?
    @FocusState private var focused: Bool

    /// No value and no word for why: a value the file leaves to layout, nothing to type over.
    private var blank: Bool { value == nil && placeholder.isEmpty }
    private var live: Bool { enabled && !blank }
    /// No glyph and no letter (a fill's opacity): the suffix is the scrub handle, so the number keeps the room.
    private var bare: Bool { symbol == nil && prefix.isEmpty }

    var body: some View {
        FieldBox(disabled: !enabled || blank) {
            // A "Mixed" field has no value to scrub from.
            if !bare {
                ScrubHandle(enabled: live && value != nil, begin: beginScrub, move: { dx, step in if let s = scrub { text = Self.format(s.move(dx, step: step)) } },
                            end: { scrub?.end(); scrub = nil }) {
                    if let symbol { Image(systemName: symbol).glyph(11).foregroundStyle(Palette.mutedFg) }
                    else { Text(prefix).font(Typography.micro).foregroundStyle(Palette.mutedFg) }
                }
                .padding(.leading, -4).padding(.trailing, -2)
            }
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain).font(Typography.body).monospacedDigit()
                .focused($focused).disabled(!enabled)
                .onSubmit(commit)
                .modifier(NumericKeys(text: $text, current: { value }, min: minimum, max: maximum, step: enabled && value == nil ? onStep : nil,
                                      apply: { v in if live { onCommit(normalize?(v) ?? v) } }, revert: { sync(); focused = false }))
                .layoutPriority(1)
            if !suffix.isEmpty {
                if bare {
                    ScrubHandle(enabled: live && value != nil, width: 10, begin: beginScrub, move: { dx, step in if let s = scrub { text = Self.format(s.move(dx, step: step)) } },
                                end: { scrub?.end(); scrub = nil }) {
                        Text(suffix).font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    }
                } else {
                    Text(suffix).font(Typography.micro).foregroundStyle(Palette.mutedFg).fixedSize()
                }
            }
        }
        // Option over the label or the input, then drag: a scrub with speed by height (NumericInput.swift).
        .overlay { OptionScrub(enabled: live && value != nil, begin: beginScrub,
                               move: { dx, step, speed in if let s = scrub { text = Self.format(s.move(dx, step: step, speed: speed)) } },
                               end: { scrub?.end(); scrub = nil }) }
        .onAppear(perform: sync)
        // Untouched, the field follows the value even while focused (Undo with the field focused).
        .onChange(of: value) { _, _ in if (!focused || !draft.edited(text)) && scrub == nil { sync() } }
        // Another node selected while this field holds a draft: the draft was for the old one, drop it.
        .onChange(of: target) { _, _ in if scrub == nil { sync() } }
        .onChange(of: focused) { _, f in if !f { commit() } }
    }

    private func beginScrub() {
        guard live else { return }
        let start = NumericInput.evaluate(text, current: value) ?? value ?? 0
        scrub = ScrubSession(start: start, min: minimum, max: maximum, write: onCommit)
    }

    private func sync() { text = value.map(Self.format) ?? ""; draft.show(text, for: target) }
    private func commit() {
        // Untouched (the display rounds: 12.345 shows as 12.35) or typed for another selection: nothing to write.
        guard draft.commits(text, target: target) else { sync(); return }
        let text0 = text
        // "+10" on a Mixed field: every layer moves by 10 from where it is, not refused.
        if enabled, value == nil, FieldMath.isRelative(text), let each = onRelative { each(text); sync(); return }
        guard enabled, let raw = NumericInput.evaluate(text, current: value) else { sync(); return }
        let v = NumericInput.clean(NumericInput.clamp(normalize?(raw) ?? raw, minimum, maximum))
        guard v != value else { sync(); return }
        text = Self.format(v)
        draft.show(text, for: target)
        // "+10" on one layer: the write says it was a change, not a value (Edit > Repeat does the same change).
        EditGesture.relative = FieldMath.isRelative(text0) ? text0 : nil
        defer { EditGesture.relative = nil }
        onCommit(v)
    }
    static func format(_ v: Double) -> String {
        guard v.isFinite else { return "" }
        if v.rounded() == v { return abs(v) < 1e15 ? String(Int(v)) : String(format: "%.0f", v) }
        return String(format: "%.2f", v).replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression)
    }
}

/// A row of icon choices, one selected (alignment, resizing, layout direction).
struct SegmentedIcons<Tag: Hashable>: View {
    let items: [(symbol: String, tag: Tag, help: String)]
    let selection: Tag?
    var enabled = true
    let onSelect: (Tag) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items.indices, id: \.self) { i in
                let item = items[i]
                Button { onSelect(item.tag) } label: {
                    Image(systemName: item.symbol).glyph(12)
                        .foregroundStyle(selection == item.tag ? Palette.fg : Palette.mutedFg)
                        .frame(maxWidth: .infinity).frame(height: Metric.field - 4)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField - 2, style: .continuous)
                            .fill(selection == item.tag ? Palette.active : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).help(item.help)
                .accessibilityLabel(item.help)
                .accessibilityAddTraits(selection == item.tag ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
        .opacity(enabled ? 1 : 0.5).disabled(!enabled)
    }
}

/// A dropdown that looks like a field: the current choice and a chevron.
struct MenuField<Items: View>: View {
    let title: String
    var font: Font = Typography.body
    var symbol: String?
    @ViewBuilder var items: () -> Items

    var body: some View {
        Menu(content: items) {
            FieldBox {
                if let symbol { Image(systemName: symbol).glyph(11).foregroundStyle(Palette.mutedFg) }
                Text(title).font(font).foregroundStyle(Palette.fg).lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.mutedFg)
            }
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
    }
}

struct CheckField: View {
    let title: String
    let isOn: Bool
    var enabled = true
    let onToggle: (Bool) -> Void

    var body: some View {
        Button { onToggle(!isOn) } label: {
            HStack(spacing: 6) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(isOn ? Palette.sel : Palette.mutedFg)
                Text(title).font(Typography.micro).foregroundStyle(Palette.mutedFg).qaText(title)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).opacity(enabled ? 1 : 0.5).disabled(!enabled)
        .accessibilityLabel(title)
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
    }
}

/// A small icon action: eye, minus, plus.
struct MiniButton: View {
    let symbol: String
    var help = ""
    var enabled = true
    /// Sits next to a field: same height as the field and a rounded-square highlight, so the two line up.
    var inRow = false
    /// Sits inside a field's trailing edge: a small rounded square with its own inset.
    var inField = false
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let side: CGFloat = inField ? 22 : inRow ? Metric.field : 24
        let shape = RoundedRectangle(cornerRadius: inField ? 6 : inRow ? Metric.radiusField : side / 2, style: .continuous)
        Button(action: action) {
            Image(systemName: symbol).symbolRenderingMode(.hierarchical)
                .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(hovering ? Palette.fg : Palette.mutedFg)
                .frame(width: side, height: side)
                .background(shape.fill(hovering || inField ? (inRow || inField ? Palette.active : Palette.hover) : .clear))
                .contentShape(shape)
        }
        .buttonStyle(.plain).help(help).opacity(enabled ? 1 : 0.4).disabled(!enabled)
        .accessibilityLabel(help.isEmpty ? symbol : help)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

// MARK: Text inputs for widget settings

/// A single-line text well. Commits on Return or when focus leaves, only if the text changed.
struct TextInputField: View {
    var placeholder = ""
    let value: String
    var enabled = true
    var monospaced = false
    let onCommit: (String) -> Void
    /// The widget (or node) the text was typed for: a draft never goes to the card selected since (FieldDraft).
    @Environment(\.editTarget) private var target
    @State private var text = ""
    @State private var draft = FieldDraft()
    @FocusState private var focused: Bool

    var body: some View {
        FieldBox(disabled: !enabled) {
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain).font(monospaced ? Typography.mono : Typography.body)
                .focused($focused).disabled(!enabled)
                .onSubmit(commit)
        }
        .accessibilityLabel(placeholder)
        .onAppear(perform: sync)
        .onChange(of: value) { _, _ in if !focused || !draft.edited(text) { sync() } }
        .onChange(of: target) { _, _ in sync() }
        .onChange(of: focused) { _, f in if !f { commit() } }
    }

    private func sync() { text = value; draft.show(text, for: target) }

    private func commit() {
        guard enabled, draft.commits(text, target: target), text != value else { sync(); return }
        draft.show(text, for: target)
        onCommit(text)
    }
}

/// A multi-line text well. Return adds a line; focus leaving commits.
struct TextAreaField: View {
    var placeholder = ""
    let value: String
    var enabled = true
    var minHeight: CGFloat = Metric.field * 3
    /// Code: monospaced, no smart quotes or dashes.
    var monospaced = false
    let onCommit: (String) -> Void
    @Environment(\.editTarget) private var target
    @State private var text = ""
    @State private var draft = FieldDraft()
    @FocusState private var focused: Bool

    private func sync() { text = value; draft.show(text, for: target) }

    var body: some View {
        TextEditor(text: $text)
            .font(monospaced ? Typography.mono : Typography.body).scrollContentBackground(.hidden)
            // No always-on scroller thumb in a small well: it still scrolls with the trackpad.
            .scrollIndicators(.never)
            .autocorrectionDisabled(monospaced)
            .focused($focused).disabled(!enabled)
            .padding(.horizontal, 4).padding(.vertical, 4)
            .frame(minHeight: minHeight)
            .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
            .overlay(alignment: .topLeading) {
                if text.isEmpty && !placeholder.isEmpty {
                    Text(placeholder).font(Typography.body).foregroundStyle(Palette.mutedFg)
                        .padding(.horizontal, 9).padding(.vertical, 4).allowsHitTesting(false)
                }
            }
            .opacity(enabled ? 1 : 0.5)
            .accessibilityLabel(placeholder)
            .onAppear(perform: sync)
            .onChange(of: value) { _, _ in if !focused || !draft.edited(text) { sync() } }
            // Another card selected: the text typed for the old one is dropped, never written into the new one.
            .onChange(of: target) { _, _ in sync() }
            .onChange(of: focused) { _, f in
                guard !f else { return }
                guard enabled, draft.commits(text, target: target), text != value else { sync(); return }
                draft.show(text, for: target)
                onCommit(text)
            }
    }
}

/// A secret input. The value never leaves this view except through `onSave`, which clears it.
/// `present` is whether the Keychain holds the secret (nil while unknown).
struct SecretField: View {
    let present: Bool?
    var enabled = true
    let onSave: (String) -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldBox(disabled: !enabled) {
                SecureField(present == true ? "Replace secret" : "Paste secret", text: $text)
                    .textFieldStyle(.plain).font(Typography.body).disabled(!enabled)
                    .onSubmit(save)
            }
            HStack(spacing: 6) {
                Circle().fill(present == true ? Palette.ok : Palette.warn).frame(width: 6, height: 6)
                Text(problem ?? (present == true ? "Saved in Keychain" : (present == false ? "Not set" : "Checking"))).font(Typography.micro)
                    .foregroundStyle(problem == nil ? Palette.mutedFg : Palette.warn)
                Spacer(minLength: 0)
                if !text.isEmpty { PillButton(title: "Save", style: .primary, action: save) }
            }
        }
    }

    @State private var problem: String?

    private func save() {
        switch SecretInput.clean(text) {
        case .empty: return
        case .multiline:
            // `security` and the server's read take one line; a cut-short secret would fail upstream with no hint why.
            problem = "A secret must be one line. Check what was pasted."
        case .ok(let v):
            problem = nil
            text = ""
            onSave(v)
        }
    }
}
