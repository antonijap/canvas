// The studio chrome, composed from DesignSystem components: floating islands over a
// full-bleed WKWebView canvas. Nothing here sets a color, size or font of its own.

import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// Holds the shown tab's web view. A tab switch swaps the subview (CanvasModel.switchTo); a web view out of the
/// window is hidden to WebKit, so its page stops drawing (document.hidden) and keeps everything it had.
final class TabHostView: NSView {
    private(set) weak var shown: NSView?
    func show(_ v: NSView) {
        guard v !== shown else { return }
        shown?.removeFromSuperview()
        v.frame = bounds
        v.autoresizingMask = [.width, .height]
        addSubview(v)
        shown = v
    }
}

struct WebCanvas: NSViewRepresentable {
    let host: TabHostView
    func makeNSView(context: Context) -> TabHostView { host }
    func updateNSView(_ nsView: TabHostView, context: Context) {}
}

/// Lets a stretch of glass drag the window, since the web view covers the real titlebar.
struct WindowDragArea: NSViewRepresentable {
    final class V: NSView { override var mouseDownCanMoveWindow: Bool { true } }
    func makeNSView(context: Context) -> NSView { V() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

private let barY: CGFloat = Metric.inset
private let columnTop: CGFloat = Metric.inset + Metric.pill + Metric.islandGap

struct RootView: View {
    @ObservedObject var model: CanvasModel
    @State private var windowWidth: CGFloat = 0
    private var panelOpen: Bool { model.panelOpen && !model.uiHidden }
    private var inspectorShown: Bool { model.hasInspectable && model.inspectorOpen && !model.uiHidden }

    /// The panel's width in this window, or nil when the window is too narrow for it beside the inspector.
    private var panelWidth: CGFloat? {
        guard windowWidth > 0 else { return model.sidebarWidth }
        return ShellLayout.sidebarWidth(window: windowWidth, stored: model.sidebarWidth, inspector: inspectorShown,
                                        inset: Metric.inset, rail: Metric.railWidth, gap: Metric.islandGap, props: Metric.propsWidth, minWidth: Metric.sidebarMin)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            WebCanvas(host: model.tabHost).ignoresSafeArea()
                .background(GeometryReader { g in
                    Color.clear.onAppear { windowWidth = g.size.width }.onChange(of: g.size.width) { _, w in windowWidth = w }
                })

            // Talk to the selection: the spark and progress rings, glass over the canvas, under the islands (Spark.swift).
            if !model.uiHidden { SparkLayer(model: model) }

            GlassEffectContainer(spacing: Metric.islandGap) {
                ZStack(alignment: .topLeading) {
                    TopBar(model: model)
                    // View > Hide UI (Cmd+backslash): only the canvas and the tabs stay.
                    if !model.uiHidden { LeftColumn(model: model, panelOpen: $model.panelOpen, panelWidth: panelWidth) }
                    if inspectorShown { Inspector(model: model, fonts: model.fonts) }
                    if !model.uiHidden { ZoomCorner(model: model) }
                    if let t = model.toast {
                        Toast(text: t, kind: model.toastKind, actions: model.toastActions,
                              onCopy: model.toastCopy == nil ? nil : { model.copyToast() }, onHover: { model.toastHovered = $0 })
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                            .padding(.bottom, Metric.inset * 2).transition(.opacity)
                    }
                }
            }
            .transaction { if model.resizingSidebar { $0.animation = nil } }
            .animation(Motion.island, value: inspectorShown)
            .animation(Motion.island, value: model.uiHidden)
            .animation(Motion.island, value: panelOpen)
            .padding(Metric.inset)
            .ignoresSafeArea()

            // Rename Layers (Cmd+R with several layers): Layers.swift.
            BatchRenameLayer(model: model)
            // Quick actions (Cmd+K, Cmd+/): Palette.swift.
            CommandPaletteLayer(model: model)
        }
        .frame(minWidth: 720, minHeight: 420)
        .onChange(of: model.revealBoardId) { _, board in if board != nil { model.panelOpen = true } }
        .onChange(of: insets) { _, v in model.setInsets(l: v[0], t: v[1], r: v[2], b: v[3]) }
        .onAppear { model.setInsets(l: insets[0], t: insets[1], r: insets[2], b: insets[3]) }
    }

    /// The free rectangle the canvas should fit into, so boards never hide under an island.
    private var insets: [CGFloat] {
        let shown = panelOpen && model.section != nil ? panelWidth : nil
        let i = CanvasInsets.compute(panel: shown, inspector: inspectorShown, inset: Metric.inset,
                                     rail: Metric.railWidth, gap: Metric.islandGap, pill: Metric.pill, props: Metric.propsWidth)
        return [i.l, i.t, i.r, i.b]
    }
}

// MARK: Top

struct TopBar: View {
    @ObservedObject var model: CanvasModel

    var body: some View {
        HStack(alignment: .top, spacing: Metric.islandGap) {
            GlassPill {
                HStack(spacing: 0) {
                    Color.clear.frame(width: Metric.trafficLights, height: Metric.control) // the traffic lights live here
                    FadingScroller(scrollTo: model.currentFile) {
                        ForEach(model.openFiles, id: \.self) { f in
                            TabChip(title: model.name(of: f), active: f == model.currentFile, missing: model.isMissing(f),
                                    onClose: { model.close(f) }) { model.openTab(f) }.id(f)
                        }
                    }
                    Menu {
                        ForEach(model.allFiles) { f in Button(f.name) { model.open(f.file) } }
                    } label: {
                        Image(systemName: "plus").symbolRenderingMode(.hierarchical)
                            .symbolEffect(.bounce, value: model.openFiles.count)
                            .font(.system(size: Metric.icon, weight: .medium)).foregroundStyle(Palette.mutedFg)
                            .frame(width: Metric.control, height: Metric.control).contentShape(Circle())
                    }
                    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize().chromeHelp("Open a canvas")
                }
            }
            .background(WindowDragArea())
            .layoutPriority(1)
            WindowDragArea().frame(maxWidth: .infinity).frame(height: Metric.pill)

            GlassPill {
                HStack(spacing: 0) {
                    ResourceReadout(meter: ResourceMeter.shared, model: model)
                    IconButton(symbol: "magnifyingglass", help: "Quick actions  \u{2318}K") { PaletteController.shared.toggle() }
                    IconButton(symbol: "sidebar.right", active: model.inspectorOpen, help: model.inspectorOpen ? "Hide properties" : "Show properties") { model.inspectorOpen.toggle() }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        // This bar sits in the window's titlebar strip, where AppKit shows no tooltips: its controls draw their own.
        .environment(\.titlebarTips, true)
    }
}

// MARK: Left

struct LeftColumn: View {
    @ObservedObject var model: CanvasModel
    @Binding var panelOpen: Bool
    /// From RootView: the stored width clamped to the window; nil hides the panel (no room beside the inspector).
    let panelWidth: CGFloat?

    var body: some View {
        HStack(alignment: .top, spacing: Metric.islandGap) {
            // One rail: the panel toggle, then the sections (a section's own button also closes the panel). Zoom
            // lives in the zoom pill's menu, the shortcuts and the View menu.
            GlassPill {
                VStack(spacing: 0) {
                    IconButton(symbol: "sidebar.left", active: panelOpen, help: panelOpen ? "Hide panel" : "Show panel") { panelOpen.toggle() }
                    Capsule().fill(Palette.stroke).frame(width: 16, height: 1).padding(.vertical, 4)
                    ForEach(RailSection.allCases) { s in
                        IconButton(symbol: s.symbol, active: panelOpen && model.section == s, help: s.rawValue) {
                            if model.section == s { panelOpen.toggle() } else { model.section = s; panelOpen = true }
                        }
                    }
                }
            }
            .frame(width: Metric.railWidth)

            if panelOpen, let section = model.section, let width = panelWidth {
                GlassIsland(padding: Metric.islandPad, dense: true) { SidePanel(model: model, section: section) }
                    .frame(width: width)
                    .overlay(alignment: .trailing) { SidebarResizeHandle(model: model, shown: width) }
                    .frame(maxHeight: .infinity, alignment: .top)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        .padding(.top, columnTop - barY)
        .padding(.bottom, 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Invisible strip on the panel's right edge: resize cursor on hover, drag to set the width.
struct SidebarResizeHandle: View {
    @ObservedObject var model: CanvasModel
    /// The width on screen, which the window may have clamped below the stored one: a drag starts from here.
    let shown: CGFloat
    @State private var startWidth: CGFloat?
    /// Whether this handle pushed the resize cursor: every pop matches a push of its own, so it never pops a
    /// cursor someone else pushed, and a handle that vanishes while hovered still pops.
    @State private var pushed = false

    var body: some View {
        Color.clear
            .frame(width: Metric.resizeHit)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside, !pushed { NSCursor.resizeLeftRight.push(); pushed = true }
                else if !inside, pushed { NSCursor.pop(); pushed = false }
            }
            .onDisappear { if pushed { NSCursor.pop(); pushed = false } }
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { g in
                    let start = startWidth ?? shown
                    startWidth = start
                    model.resizingSidebar = true
                    model.sidebarWidth = min(max(start + g.translation.width, Metric.sidebarMin), Metric.sidebarMax)
                }
                .onEnded { _ in startWidth = nil; model.resizingSidebar = false })
    }
}

enum StylesTab: Hashable { case text, variables, fonts }

struct SidePanel: View {
    @ObservedObject var model: CanvasModel
    let section: RailSection
    @State private var stylesTab: StylesTab = .text

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    if section == .boards { PagesSection(model: model) }
                    // Layers draws its own header (Layers.swift).
                    if section != .boards { SectionHeader(title: section.rawValue) }
                    switch section {
                    case .boards:
                        LayersRows(model: model, store: LayersStore.of(model))
                    case .components:
                        ForEach(model.components) { c in
                            ListRow(title: (c.isText ? "T " : "") + c.name, detail: c.instances > 0 ? "\(c.instances) \u{00D7}" : c.type,
                                    symbol: "diamond.fill", tint: Palette.component, active: c.id == model.selection?.id) { model.reveal(c.id, board: c.board) }
                            // Drag onto the canvas: an instance where it lands; with Option onto an instance, a swap.
                            .onDrag { model.beginComponentDrag(c) } preview: { ComponentDragPreview(name: c.name) }
                        }
                    case .styles:
                        TextSegments(items: [("Text", StylesTab.text), ("Variables", .variables), ("Fonts", .fonts)], selection: stylesTab) { stylesTab = $0 }
                            .padding(.horizontal, 4).padding(.bottom, 6)
                        switch stylesTab {
                        case .text: TokenLibrary(model: model, styles: true)
                        case .variables: TokenLibrary(model: model, styles: false)
                        case .fonts: FontList(model: model, fonts: model.fonts)
                        }
                    case .widgets:
                        WidgetsPanel(model: model)
                    }
                }
            }
            .scrollIndicators(.never)
            .layersSync(model: model, proxy: proxy, active: section == .boards)
            // Also on appear: "Reveal in Boards list" may have just opened this section.
            .task(id: model.revealBoardId) {
                guard let board = model.revealBoardId else { return }
                try? await Task.sleep(nanoseconds: 80_000_000)
                withAnimation(Motion.island) { proxy.scrollTo(board, anchor: .center) }
                model.revealBoardId = nil
            }
        }
    }
}

/// Snapping and nudge settings, persisted in app settings (UserDefaults) and sent to the page.
struct SnapSettings: Equatable {
    var objects = true
    var pixel = true
    var guides = true
    var bigNudge = 10

    static var stored: SnapSettings {
        let d = UserDefaults.standard
        var s = SnapSettings()
        if d.object(forKey: "canvas.snap.objects") != nil { s.objects = d.bool(forKey: "canvas.snap.objects") }
        if d.object(forKey: "canvas.snap.pixel") != nil { s.pixel = d.bool(forKey: "canvas.snap.pixel") }
        if d.object(forKey: "canvas.snap.guides") != nil { s.guides = d.bool(forKey: "canvas.snap.guides") }
        let big = d.integer(forKey: "canvas.snap.bigNudge")
        if big == SnapLimits.bigNudge(big) { s.bigNudge = big }
        return s
    }
    func save() {
        let d = UserDefaults.standard
        d.set(objects, forKey: "canvas.snap.objects")
        d.set(pixel, forKey: "canvas.snap.pixel")
        d.set(guides, forKey: "canvas.snap.guides")
        d.set(bigNudge, forKey: "canvas.snap.bigNudge")
    }
}

/// The toolbar's magnet: a popover with the snapping switches and the big nudge amount.
struct FontList: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var fonts: FontCatalog
    @State private var query = ""

    var body: some View {
        let shown = query.isEmpty ? fonts.families : fonts.families.filter { $0.localizedCaseInsensitiveContains(query) }
        SearchField(prompt: "Search \(fonts.families.count) fonts", text: $query).padding(.horizontal, 4).padding(.bottom, 4)
        ForEach(shown, id: \.self) { family in
            ListRow(title: family, detail: "\(fonts.styleCount(of: family))", font: .custom(family, size: 14)) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(family, forType: .string)
                model.flash("Copied \(family)")
            }
        }
    }
}

// MARK: Right

// MARK: Bottom

struct ZoomCorner: View {
    @ObservedObject var model: CanvasModel
    var body: some View {
        ZoomPill(percent: model.zoom, zoomOut: { model.zoomBy(0.8) }, zoomIn: { model.zoomBy(1.25) },
                 reset: { model.zoomReset() }, fitPage: { model.fitPage() }, fitSelection: { model.fit() },
                 zoomTo: { model.zoomTo($0); model.focusCanvas() }, open: $model.zoomFieldOpen)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
    }
}
