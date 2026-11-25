// The studio chrome, composed from DesignSystem components: floating islands over a
// full-bleed WKWebView canvas. Nothing here sets a color, size or font of its own.

import SwiftUI
import ObjectiveC
import UniformTypeIdentifiers
import WebKit

/// Holds the shown tab's web view. A tab switch swaps the subview (CanvasModel.switchTo); a web view out of the
/// window is hidden to WebKit, so its page stops drawing (document.hidden) and keeps everything it had.
final class TabHostView: NSView {
    private(set) weak var shown: NSView?
    private let picture = NSImageView()
    private var pictureSize = NSSize.zero
    private var pictureScale: CGFloat = 1
    private var pictureAppearance: NSAppearance.Name?

    func showPicture(_ image: NSImage, size: NSSize, scale: CGFloat) -> Bool {
        clearPicture()
        guard bounds.size == size, window?.backingScaleFactor == scale else { return false }
        picture.frame = bounds
        picture.imageScaling = .scaleAxesIndependently
        picture.image = image
        pictureSize = size
        pictureScale = scale
        pictureAppearance = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])
        addSubview(picture, positioned: .above, relativeTo: shown)
        return true
    }

    func clearPicture() {
        picture.removeFromSuperview()
        picture.image = nil
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        if picture.superview != nil, pictureAppearance != effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) {
            clearPicture()
        }
    }

    override func layout() {
        super.layout()
        if picture.superview != nil, bounds.size != pictureSize || window?.backingScaleFactor != pictureScale {
            clearPicture()
        }
    }

    func show(_ v: NSView) {
        guard v !== shown else { return }
        shown?.removeFromSuperview()
        v.frame = bounds
        v.autoresizingMask = [.width, .height]
        addSubview(v, positioned: .below, relativeTo: picture.superview == self ? picture : nil)
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

/// The top bar sits where the hidden titlebar is, so on mouse down the window server starts a window drag before any
/// SwiftUI gesture sees the press (a background NSView cannot change that: SwiftUI hit-tests its own content). While the
/// pointer is over a control, the window stays still. The empty stretch of the bar still drags the window.
struct KeepsWindowStill: ViewModifier {
    func body(content: Content) -> some View {
        content.onHover { inside in
            let at = NSEvent.mouseLocation
            guard let w = NSApp.windows.first(where: { $0.isVisible && $0.frame.contains(at) }) ?? NSApp.mainWindow else { return }
            w.isMovable = !inside
        }
    }
}
extension View { func keepsWindowStill() -> some View { modifier(KeepsWindowStill()) } }

/// SwiftUI controls in the hidden titlebar must not inherit window dragging.
final class ControlHostingView<Content: View>: NSHostingView<Content> {
    override var mouseDownCanMoveWindow: Bool { false }
    #if CANVAS_QA
    // QA stays in the background; its first native click must reach the control, as its page clicks do.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    #endif
}

/// Keeps the controller's sizing and root-view updates while accepting QA's background clicks in secondary windows.
final class ControlHostingController<Content: View>: NSHostingController<Content> {
    override init(rootView: Content) {
        super.init(rootView: rootView)
        #if CANVAS_QA
        let selector = #selector(NSView.acceptsFirstMouse(for:))
        let accept: @convention(block) (AnyObject, NSEvent?) -> Bool = { _, _ in true }
        if let method = class_getInstanceMethod(type(of: view), selector) {
            class_replaceMethod(type(of: view), selector, imp_implementationWithBlock(accept), method_getTypeEncoding(method))
        }
        #endif
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("Use init(rootView:)") }
}

private let barY: CGFloat = Metric.inset
private let columnTop: CGFloat = Metric.inset + Metric.pill + Metric.islandGap

struct RootView: View {
    @ObservedObject var model: CanvasModel
    @State private var windowWidth: CGFloat = 0
    private var panelOpen: Bool { model.panelOpen && !model.uiHidden && !model.homeShown }
    private var inspectorShown: Bool { model.inspectorOpen && !model.commentsSidebarOpen && !model.conversationsSidebarOpen && !model.uiHidden && !model.homeShown }

    private var rightSidebarShown: Bool { inspectorShown || ((model.commentsSidebarOpen || model.conversationsSidebarOpen) && !model.uiHidden && !model.homeShown) }

    /// The panel's width in this window, or nil when the window is too narrow for it beside the inspector.
    private var panelWidth: CGFloat? {
        guard windowWidth > 0 else { return model.sidebarWidth }
        return ShellLayout.sidebarWidth(window: windowWidth, stored: model.sidebarWidth, inspector: rightSidebarShown,
                                        inset: Metric.inset, gap: Metric.islandGap, props: Metric.propsWidth, minWidth: Metric.sidebarMin)
    }

    /// The widest the panel may be dragged in this window: the maximum, or the room the window leaves.
    private var panelMax: CGFloat {
        guard windowWidth > 0 else { return Metric.sidebarMax }
        let room = ShellLayout.room(window: windowWidth, inspector: rightSidebarShown, inset: Metric.inset,
                                    gap: Metric.islandGap, props: Metric.propsWidth)
        return min(Metric.sidebarMax, room)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            WebCanvas(host: model.tabHost).ignoresSafeArea()
                .background(GeometryReader { g in
                    Color.clear.onAppear { windowWidth = g.size.width }.onChange(of: g.size.width) { _, w in windowWidth = w }
                })

            // The Home tab: a native screen over the (hidden, still alive) canvas page (Home.swift).
            if model.homeShown { HomeView(model: model).ignoresSafeArea() }

            // Talk to the selection: the spark and progress rings, glass over the canvas, under the islands (Spark.swift).
            if !model.uiHidden && !model.homeShown { SparkLayer(model: model) }

            // An empty page: one line on how to start, centred in the free canvas. Clicks and drops pass through.
            ZStack {
                if model.pageEmpty {
                    Text(EmptyPage.hint).font(Typography.body).foregroundStyle(Palette.mutedFg).multilineTextAlignment(.center)
                        .padding(.leading, insets[0]).padding(.top, insets[1]).padding(.trailing, insets[2]).padding(.bottom, insets[3])
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .allowsHitTesting(false)
            .animation(Motion.fast, value: model.pageEmpty)
            .ignoresSafeArea()

            GlassEffectContainer(spacing: Metric.islandGap) {
                ZStack(alignment: .topLeading) {
                    // View > Hide UI (Cmd+backslash): only the canvas and the tabs stay.
                    LeftColumn(model: model, panelOpen: $model.panelOpen, panelWidth: panelWidth, panelMax: panelMax)
                    if inspectorShown { Inspector(model: model, fonts: model.fonts).disabled(model.cloudReadOnly) }
                    // Nothing to zoom on an empty page: the pill comes back with the first board.
                    if !model.uiHidden && !model.homeShown && !model.pageEmpty { ZoomCorner(model: model) }
                    if let t = model.toast {
                        Toast(text: t, kind: model.toastKind, actions: model.toastActions,
                              onCopy: model.toastCopy == nil ? nil : { model.copyToast() }, onHover: { model.toastHovered = $0 })
                            .frame(maxWidth: model.bottomOverlay.width > 0 ? model.bottomOverlay.width : 300)
                            .position(x: model.bottomOverlay.midX - Metric.inset, y: model.bottomOverlay.midY - Metric.inset)
                            .transition(.opacity)
                    }
                }
            }
            .transaction { if model.resizingSidebar { $0.animation = nil } }
            .animation(Motion.island, value: inspectorShown)
            .animation(Motion.island, value: model.uiHidden)
            .animation(Motion.island, value: panelOpen)
            .padding(Metric.inset)
            .ignoresSafeArea()

            TopBar(model: model).ignoresSafeArea(edges: .top)

            // Rename Layers (Cmd+R with several layers): Layers.swift.
            BatchRenameLayer(model: model)
            // Quick actions (Cmd+K, Cmd+/): Palette.swift.
            CommandPaletteLayer(model: model)
        }
        .coordinateSpace(name: "canvas")
        .frame(minWidth: 720, minHeight: 420)
        .ignoresSafeArea()
        .onChange(of: model.revealBoardId) { _, board in if board != nil { model.panelOpen = true } }
        .onChange(of: insets) { _, v in model.setInsets(l: v[0], t: v[1], r: v[2], b: v[3]) }
        .onAppear { model.setInsets(l: insets[0], t: insets[1], r: insets[2], b: insets[3]) }
    }

    /// The free rectangle the canvas should fit into, so boards never hide under an island.
    private var insets: [CGFloat] {
        let shown = panelOpen ? panelWidth : nil
        let i = CanvasInsets.compute(panel: shown, inspector: rightSidebarShown, inset: Metric.inset,
                                     gap: Metric.islandGap, pill: Metric.pill, props: Metric.propsWidth)
        return [i.l, i.t, i.r, i.b]
    }
}

// MARK: Top

/// Each file tab's width, so a drag knows where the others sit.
private struct TabWidthKey: PreferenceKey {
    static var defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) { value.merge(nextValue()) { $1 } }
}

struct TopBar: View {
    @ObservedObject var model: CanvasModel
    @State private var tabWidths: [String: CGFloat] = [:]
    @State private var barWidth: CGFloat = 0
    @State private var actionsWidth: CGFloat = 0
    @State private var hoveredTab: String?

    private var tabRoom: CGFloat {
        max(0, barWidth - actionsWidth - Metric.trafficLights - 2 * Metric.control)
    }
    private var fittedWidths: [CGFloat] {
        let font = NSFont.systemFont(ofSize: 12, weight: .medium)
        // Leading/trailing padding, document glyph, gap and close target, matching TabChip.
        let chromeWidth: CGFloat = 35 + TabChip.closeSlot
        let natural: [CGFloat] = model.openFiles.map { file in
            let titleWidth = (model.name(of: file) as NSString).size(withAttributes: [.font: font]).width
            return ceil(titleWidth) + chromeWidth
        }
        return TabSizing.widths(natural: natural, available: tabRoom, minimum: Metric.tabMin, maximum: Metric.tabMax)
    }
    private var stripWidth: CGFloat {
        min(tabRoom, fittedWidths.reduce(0, +))
    }
    /// The file tab being dragged and how far it is from its place (clamped inside the strip).
    @State private var dragging: String?
    @State private var dragX: CGFloat = 0

    @State private var rename = TabRename()

    private func beginRename(_ file: String) {
        rename.begin(file)
        if CloudFilePath(file) != nil { rename.draft = model.name(of: file) }
        traceTabRename("begin", file)
    }

    private func finishRename(_ save: Bool) {
        guard let file = rename.file else { return }
        traceTabRename(save ? "commit" : "cancel", file)
        rename.file = nil
        if save { model.renameFile(file, to: rename.draft) }
    }

    private func tabMenu(_ file: String, view: NSView, at: CGPoint) {
        let menu = ContextMenuBuilder(model: model, at: at)
        for (i, group) in ContextMenuLayout.fileTab(cloud: !model.prefs.clouds.isEmpty).enumerated() {
            if i > 0 { menu.separator() }
            for title in group {
                menu.action(title) {
                    switch title {
                    case "Rename": beginRename(file)
                    case "Show in Finder": NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: file)])
                    case "Duplicate": model.duplicateFile(file)
                    case "Move to Cloud": CloudAccount.shared.moveOpenFile(model, file: file)
                    case "Copy Link": model.copyFileLink(file)
                    case "Reveal in Home": model.revealInHome(file)
                    case "Close": model.close(file)
                    case "Close Other Tabs": model.closeOtherTabs(file)
                    default: break
                    }
                }
            }
        }
        menu.pop(in: view)
    }

    private var widths: [CGFloat] { model.openFiles.map { tabWidths[$0] ?? 0 } }
    private var dragTarget: Int? {
        guard let d = dragging, let i = model.openFiles.firstIndex(of: d) else { return nil }
        return TabOrder.target(from: i, offset: dragX, widths: widths, gap: 0)
    }

    private func fileSymbol(_ file: String, missing: Bool) -> String {
        if missing { return "exclamationmark.triangle" }
        return CloudFilePath(file) == nil ? "doc" : "cloud"
    }

    private func isActive(_ file: String) -> Bool { file == model.currentFile && !model.homeShown }

    /// One file tab. Press and drag sideways: it follows the pointer, the others slide aside, and the drop saves the
    /// order. A click or a move under TabOrder.dragThreshold stays a click.
    private func draggableTab(_ f: String, index i: Int) -> some View {
        let isDragged = dragging == f
        var off: CGFloat = 0
        if isDragged { off = dragX }
        else if let d = dragging, let di = model.openFiles.firstIndex(of: d), let t = dragTarget {
            off = TabOrder.slide(i, dragged: di, target: t, width: tabWidths[d] ?? 0, gap: 0)
        }
        let missing = model.isMissing(f)
        let active = isActive(f)
        let hovering = hoveredTab == f
        return TabChip(title: model.name(of: f), symbol: fileSymbol(f, missing: missing), active: active,
                       width: fittedWidths[i], hovering: hovering, missing: missing,
                       onClose: { model.close(f) }) { model.openTab(f) }
            .background(GeometryReader { g in Color.clear.preference(key: TabWidthKey.self, value: [f: g.size.width]) })
            .overlay {
                if rename.file == f {
                    TabNameField(text: $rename.draft, finish: finishRename)
                        .frame(height: 20)
                        .padding(.leading, 10).padding(.trailing, 30)
                        .qaID("tab-rename", label: "Rename file")
                        .onAppear { traceTabRename("overlay-appear", f) }
                        .onDisappear { traceTabRename("overlay-disappear", f) }
                } else {
                    TabPointer(closeVisible: active || hovering, onClick: { model.openTab(f) }, onRename: { beginRename(f) },
                               onMenu: { view, at in tabMenu(f, view: view, at: at) },
                               onDrag: { dx in
                        guard let at = model.openFiles.firstIndex(of: f) else { return }
                        dragging = f
                        dragX = TabOrder.clamp(dx, index: at, widths: widths, gap: 0)
                    }, onDrop: {
                        let to = dragTarget
                        withAnimation(Motion.island) {
                            if let to { model.moveTab(f, to: to) }
                            dragging = nil
                            dragX = 0
                        }
                    })
                }
            }
            .overlay(alignment: .leading) { if i > 0 { separator } }
            .onHover { inside in
                if inside { hoveredTab = f }
                else if hoveredTab == f { hoveredTab = nil }
            }
            .offset(x: off)
            .animation(isDragged ? nil : Motion.island, value: off)
            .zIndex(isDragged ? 1 : 0)
            .qaID("file-tab", label: model.name(of: f))
            .id(f)
    }

    private var separator: some View {
        Rectangle().fill(Palette.stroke).frame(width: 1).allowsHitTesting(false)
    }

    private var tabs: some View {
        HStack(spacing: 0) {
            PinnedTab(symbol: "house", title: "Home", compact: !model.openFiles.isEmpty, active: model.homeShown,
                      help: "Home  \u{21E7}\u{2318}0") { model.showHome() }
                .qaID("home-tab", label: "Home")
                .overlay(alignment: .trailing) { if !model.openFiles.isEmpty { separator } }
                .animation(Motion.island, value: model.openFiles.isEmpty)
            FadingScroller(scrollTo: model.currentFile) {
                ForEach(Array(model.openFiles.enumerated()), id: \.element) { i, file in
                    draggableTab(file, index: i)
                }
            }
            .frame(width: stripWidth, height: Metric.topBar)
            .onPreferenceChange(TabWidthKey.self) { tabWidths = $0 }
            IconButton(symbol: "plus", help: "New file", shortcut: "\u{2318}N", inBar: true) { model.newCanvas() }
                .qaID("tab-new", label: "New file")
                .overlay(alignment: .leading) { separator }
        }
        .contentShape(Rectangle())
        .keepsWindowStill()
        .qaID("tab-controls")
    }

    private var tabMenu: some View {
        Menu {
            Section("Open tabs") {
                ForEach(model.openFiles, id: \.self) { file in
                    Toggle(isOn: Binding(get: { isActive(file) }, set: { _ in model.openTab(file) })) {
                        Label(model.name(of: file), systemImage: fileSymbol(file, missing: model.isMissing(file)))
                    }
                }
            }
            if !model.recentlyClosedTabs.files.isEmpty {
                Section("Recently closed") {
                    ForEach(model.recentlyClosedTabs.files, id: \.self) { file in
                        Button { model.reopenTab(file) } label: {
                            Label(model.name(of: file), systemImage: fileSymbol(file, missing: model.isMissing(file)))
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "chevron.down").glyph(12)
                .foregroundStyle(Palette.mutedFg)
                .frame(width: Metric.control, height: Metric.topBar)
                .contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
        .fixedSize().chromeHelp("Show tabs")
        .accessibilityLabel("Show tabs")
        .qaID("tab-list", label: "Show tabs")
    }

    private var actions: some View {
        HStack(spacing: 0) {
            if model.currentFile != nil && !model.homeShown && !model.cloudReadOnly {
                HStack(spacing: 0) {
                    ForEach(DrawTool.allCases, id: \.self) { tool in
                        IconButton(symbol: tool.symbol, help: tool.title, shortcut: tool.key.uppercased(), inBar: true) { model.draw(tool) }
                            .qaID("draw-tool", label: tool.title)
                    }
                }
                .disabled(!model.canDraw)
            }
            LivePeopleStrip(model: model)
            ResourceReadout(meter: ResourceMeter.shared, model: model)
            IconButton(symbol: "magnifyingglass", help: "Quick actions", shortcut: "\u{2318}K", inBar: true) { PaletteController.shared.toggle() }
            if model.currentFile != nil && !model.homeShown {
                IconButton(symbol: "sparkles.2", active: model.conversationsSidebarOpen, help: "Conversations", inBar: true) { model.run("{cmd:\"conversations\"}") }
                    .qaID("conversations-toggle")
            }
            IconButton(symbol: "sidebar.right", active: model.inspectorOpen, help: model.inspectorOpen ? "Hide properties" : "Show properties", inBar: true) { model.inspectorOpen.toggle() }
                .qaID("properties-toggle")
            tabMenu
        }
        .contentShape(Rectangle())
        .keepsWindowStill()
        .padding(.trailing, Metric.pillPad)
        .fixedSize(horizontal: true, vertical: false)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { actionsWidth = $0 }
    }

    var body: some View {
        GeometryReader { _ in
            HStack(spacing: 0) {
                WindowDragArea().frame(width: Metric.trafficLights)
                tabs
                WindowDragArea().frame(maxWidth: .infinity)
                actions
            }
            .frame(height: Metric.topBar)
            .glassBar()
        }
        .frame(height: Metric.topBar)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barWidth = $0 }
        // This bar sits in the window's titlebar strip, where AppKit shows no tooltips: its controls draw their own.
        .environment(\.titlebarTips, true)
        .onAppear {
            #if CANVAS_QA
            QA.tabRenameFile = { rename.file }
            #endif
        }
    }
}

// MARK: Left

struct LeftColumn: View {
    @ObservedObject var model: CanvasModel
    @Binding var panelOpen: Bool
    /// From RootView: the stored width clamped to the window; nil hides the panel (no room beside the inspector).
    let panelWidth: CGFloat?
    /// The widest a drag may make the panel in this window.
    let panelMax: CGFloat
    @State private var scrollOffsets: [SidebarSection: CGFloat] = [:]
    @State private var tokenTab: TokenTab = .text

    var body: some View {
        // Keep the section offsets and token tab when Hide UI removes the panel.
        if !model.uiHidden && !model.homeShown { column }
    }

    private var column: some View {
        let section = model.section
        let shown = panelOpen ? panelWidth : nil
        return GlassIsland(radius: shown == nil ? 999 : Metric.radiusIsland, padding: 0, dense: shown != nil) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: Metric.islandPad) {
                    toggle(shown: shown != nil)
                    if shown != nil {
                        ForEach(SidebarSection.allCases) { item in
                            IconButton(symbol: item.symbol, active: section == item, help: item.rawValue, filled: true) {
                                model.section = item
                            }
                            .qaID("sidebar-section", label: item.rawValue)
                        }
                    }
                }
                .padding([.top, .leading], Metric.pillPad)
                .padding(.trailing, shown == nil ? Metric.pillPad : Metric.islandPad)
                if let width = shown {
                    SidePanel(model: model, section: section, tokenTab: $tokenTab, offset: Binding(
                        get: { scrollOffsets[section] }, set: { scrollOffsets[section] = $0 }
                    ))
                    .id(section)
                    .padding([.horizontal, .bottom], Metric.islandPad)
                    .overlay(alignment: .trailing) {
                        SidebarResizeHandle(model: model, shown: width, minWidth: Metric.sidebarMin, maxWidth: panelMax,
                                            defaultWidth: Metric.sidebarWidth) { model.sidebarWidth = $0 }
                    }
                }
            }
            .padding(.bottom, shown == nil ? Metric.pillPad : 0)
        }
        .frame(width: shown ?? Metric.pill)
        .padding(.top, columnTop - barY)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func toggle(shown: Bool) -> some View {
        IconButton(symbol: "sidebar.left", help: shown ? "Hide panel" : "Show panel", filled: shown) {
            panelOpen.toggle()
        }
        .qaID("sidebar-toggle", label: shown ? "Hide panel" : "Show panel")
    }
}

/// Invisible strip, SidebarSize.hitWidth wide, along a sidebar's right edge, inside it: resize cursor over it, drag to
/// set the width, double-click to put it back to its default. Used by the editor panel and the Home sidebar.
/// An AppKit view, not a SwiftUI gesture: the cursor comes from a cursor rect (no push and pop to get out of step),
/// and what lies beside the sidebar (the canvas page, the file list's scroll view) takes the mouse before anything
/// drawn over it, so the strip stays inside the sidebar.
struct SidebarResizeHandle: View {
    @ObservedObject var model: CanvasModel
    let shown: CGFloat
    let minWidth: CGFloat
    let maxWidth: CGFloat
    let defaultWidth: CGFloat
    let set: (CGFloat) -> Void
    var body: some View {
        EdgeHandle(model: model, shown: shown, minWidth: minWidth, maxWidth: maxWidth, defaultWidth: defaultWidth, set: set)
            .frame(width: SidebarSize.hitWidth)
            .qaID("sidebar-resize", label: "Resize sidebar")
    }
}

private struct EdgeHandle: NSViewRepresentable {
    @ObservedObject var model: CanvasModel
    /// The width on screen, which the window may have clamped below the stored one: a drag starts from here.
    let shown: CGFloat
    let minWidth: CGFloat
    /// The widest this drag may go: the maximum, or less where the window has no more room.
    let maxWidth: CGFloat
    let defaultWidth: CGFloat
    let set: (CGFloat) -> Void

    func makeNSView(context: Context) -> EdgeView { EdgeView() }
    func updateNSView(_ v: EdgeView, context: Context) {
        v.shown = shown; v.minWidth = minWidth; v.maxWidth = maxWidth; v.defaultWidth = defaultWidth; v.set = set
        v.dragging = { [weak model] on in model?.resizingSidebar = on }
    }
    final class EdgeView: NSView {
        var shown: CGFloat = 0, minWidth: CGFloat = 0, maxWidth: CGFloat = 0, defaultWidth: CGFloat = 0
        var set: (CGFloat) -> Void = { _ in }
        var dragging: (Bool) -> Void = { _ in }
        private var startX: CGFloat = 0
        private var startWidth: CGFloat = 0

        override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override var mouseDownCanMoveWindow: Bool { false }

        override func mouseDown(with event: NSEvent) {
            if event.clickCount == 2 { set(defaultWidth); return }
            startX = event.locationInWindow.x
            startWidth = shown
            dragging(true)
        }
        override func mouseDragged(with event: NSEvent) {
            if event.clickCount >= 2 { return }
            set(SidebarSize.drag(start: startWidth, translation: event.locationInWindow.x - startX, min: minWidth, max: maxWidth))
        }
        override func mouseUp(with event: NSEvent) { dragging(false) }
    }
}

private enum TokenTab: Hashable { case text, variables, fonts }

private struct SidePanel: View {
    @ObservedObject var model: CanvasModel
    let section: SidebarSection
    @Binding var tokenTab: TokenTab
    @Binding var offset: CGFloat?
    @State private var scroll: ScrollPosition

    init(model: CanvasModel, section: SidebarSection, tokenTab: Binding<TokenTab>, offset: Binding<CGFloat?>) {
        self.model = model
        self.section = section
        _tokenTab = tokenTab
        _offset = offset
        _scroll = State(initialValue: ScrollPosition(y: offset.wrappedValue ?? 0))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    switch section {
                    case .layers:
                        PagesSection(model: model).padding(.bottom, 4)
                        LayersRows(model: model, store: LayersStore.of(model))
                    case .assets:
                        ForEach(model.components) { c in
                            ListRow(title: (c.isText ? "T " : "") + c.name, detail: c.instances > 0 ? "\(c.instances) \u{00D7}" : c.type,
                                    symbol: "diamond.fill", tint: Palette.component, active: c.id == model.selection?.id) { model.reveal(c.id, board: c.board) }
                            // Drag onto the canvas: an instance where it lands; with Option onto an instance, a swap.
                            .onDrag { model.beginComponentDrag(c) } preview: { ComponentDragPreview(name: c.name) }
                            .contextMenu {
                                Button("Go to Main Component") { model.reveal(c.id, board: c.board) }
                                Button("Select All Instances") { model.highlightInstances(of: ContextInfo.Family(id: c.id, name: c.name, instances: c.instances)) }
                                    .disabled(c.instances == 0)
                            }
                        }
                    case .tokens:
                        TextSegments(items: [("Text", TokenTab.text), ("Variables", .variables), ("Fonts", .fonts)],
                                     selection: tokenTab, showsTrack: false) { tokenTab = $0 }
                            .padding(.horizontal, 4).padding(.bottom, 6)
                        switch tokenTab {
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
            .scrollPosition($scroll)
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                max(0, geometry.contentOffset.y + geometry.contentInsets.top)
            } action: { _, y in
                offset = y
            }
            .layersSync(model: model, proxy: proxy, active: section == .layers, restoring: offset != nil)
            // Also on appear: "Reveal in Boards list" may have just opened this section.
            .task(id: model.revealBoardId) {
                guard section == .layers, let board = model.revealBoardId else { return }
                try? await Task.sleep(nanoseconds: 80_000_000)
                guard !Task.isCancelled, model.revealBoardId == board else { return }
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
    var blueprint = true
    var guides = true
    var bigNudge = 10

    static var stored: SnapSettings {
        let d = UserDefaults.standard
        var s = SnapSettings()
        if d.object(forKey: "canvas.snap.objects") != nil { s.objects = d.bool(forKey: "canvas.snap.objects") }
        if d.object(forKey: "canvas.snap.pixel") != nil { s.pixel = d.bool(forKey: "canvas.snap.pixel") }
        if d.object(forKey: "canvas.snap.blueprint") != nil { s.blueprint = d.bool(forKey: "canvas.snap.blueprint") }
        if d.object(forKey: "canvas.snap.guides") != nil { s.guides = d.bool(forKey: "canvas.snap.guides") }
        let big = d.integer(forKey: "canvas.snap.bigNudge")
        if big == SnapLimits.bigNudge(big) { s.bigNudge = big }
        return s
    }
    func save() {
        let d = UserDefaults.standard
        d.set(objects, forKey: "canvas.snap.objects")
        d.set(pixel, forKey: "canvas.snap.pixel")
        d.set(blueprint, forKey: "canvas.snap.blueprint")
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

extension CanvasModel {
    /// The shown page has no boards and no cards (EmptyPage, ShellLogic.swift). From the page's own state messages
    /// (doc.boards and widgets are the active page's), so no extra polling.
    var pageEmpty: Bool {
        EmptyPage.isEmpty(fileOpen: currentFile != nil, home: homeShown, loaded: !revision.isEmpty, boards: boards.count, cards: widgets.count)
    }
}

// MARK: Bottom

struct ZoomCorner: View {
    @ObservedObject var model: CanvasModel
    var body: some View {
        ZoomPill(percent: model.zoom, zoomOut: { model.zoomBy(0.8) }, zoomIn: { model.zoomBy(1.25) },
                 reset: { model.zoomReset() }, fitPage: { model.fitPage() }, fitSelection: { model.fit() },
                 zoomTo: { model.zoomTo($0); model.focusCanvas() }, open: $model.zoomFieldOpen)
            .qaID("zoom-island")
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("canvas")) } action: { model.setZoomCorner(frame: $0) }
            .onDisappear { model.setZoomCorner(frame: .zero) }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
    }
}




/// Handles tab presses explicitly so double and secondary clicks cannot become reorder drags.
private struct TabPointer: NSViewRepresentable {
    let closeVisible: Bool
    let onClick: () -> Void
    let onRename: () -> Void
    let onMenu: (NSView, CGPoint) -> Void
    let onDrag: (CGFloat) -> Void
    let onDrop: () -> Void
    func makeNSView(context: Context) -> Pointer { Pointer() }
    func updateNSView(_ v: Pointer, context: Context) {
        v.closeVisible = closeVisible
        v.click = onClick; v.rename = onRename; v.menuAction = onMenu; v.drag = onDrag; v.drop = onDrop
    }
    final class Pointer: NSView {
        var closeVisible = false
        var click: () -> Void = {}, rename: () -> Void = {}, drop: () -> Void = {}
        var menuAction: (NSView, CGPoint) -> Void = { _, _ in }
        var drag: (CGFloat) -> Void = { _ in }
        private var start: CGFloat = 0
        private var press = TabPress()
        override var mouseDownCanMoveWindow: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? {
            guard let hit = super.hitTest(point) else { return nil }
            let local = convert(point, from: superview)
            let event = NSApp.currentEvent
            let secondary = event?.type == .rightMouseDown || event?.modifierFlags.contains(.control) == true
            if closeVisible && local.x >= bounds.width - TabChip.closeSlot && !secondary { return nil }
            return hit
        }
        override func mouseDown(with event: NSEvent) {
            if event.modifierFlags.contains(.control) { rightMouseDown(with: event); return }
            start = event.locationInWindow.x
            perform(press.down(button: event.buttonNumber, clicks: event.clickCount))
        }
        override func mouseDragged(with event: NSEvent) {
            let dx = event.locationInWindow.x - start
            if press.drag(dx) { drag(dx) }
        }
        override func mouseUp(with event: NSEvent) {
            perform(press.up())
        }
        private func perform(_ action: TabPress.Action) {
            switch action {
            case .none: break
            case .click: click()
            case .rename: rename()
            case .drop: drop()
            }
        }
        override func rightMouseDown(with event: NSEvent) {
            press.cancel()
            menuAction(self, convert(event.locationInWindow, from: nil))
        }
    }
}

@MainActor private func traceTabRename(_ event: String, _ detail: String = "") {
    #if CANVAS_QA
    QA.recordTabRename(event, detail)
    #endif
}

/// The field editor commits on focus loss and Return; Escape leaves the package untouched.
private struct TabNameField: NSViewRepresentable {
    @Binding var text: String
    let finish: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> Field {
        let field = Field(string: text)
        traceTabRename("create", String(describing: ObjectIdentifier(field)))
        field.delegate = context.coordinator
        context.coordinator.field = field
        context.coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak coordinator = context.coordinator] event in
            if let field = coordinator?.field, event.window === field.window,
               !field.bounds.contains(field.convert(event.locationInWindow, from: nil)) {
                coordinator?.end(true, reason: "outside-click")
            }
            return event
        }
        field.font = .systemFont(ofSize: 12, weight: .medium)
        field.drawsBackground = true
        field.isBordered = false
        field.focusRingType = .default
        return field
    }
    func updateNSView(_ field: Field, context: Context) {
        context.coordinator.owner = self
        field.requestFocus()
    }
    static func dismantleNSView(_ field: Field, coordinator: Coordinator) {
        // SwiftUI may replace the overlay during layout. Its old delegate and monitor no longer own the rename.
        coordinator.retire()
        field.retired = true
        field.delegate = nil
        traceTabRename("dismantle", String(describing: ObjectIdentifier(field)))
    }
    final class Field: NSTextField {
        private var focus = TabRenameFocus()
        var retired = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            traceTabRename(window == nil ? "detach" : "attach", String(describing: ObjectIdentifier(self)))
            if window == nil { focus.detached() }
            requestFocus()
        }

        func requestFocus() {
            guard let window else { return }
            DispatchQueue.main.async { [weak self, weak window] in
                guard let self, !self.retired, let window, self.window === window else { return }
                self.focus.attempt(attached: true, makeFirstResponder: {
                    let accepted = window.makeFirstResponder(self)
                    traceTabRename("focus", "\(ObjectIdentifier(self)) accepted=\(accepted)")
                    return accepted
                }, selectAll: { self.selectText(nil) })
            }
        }
    }
    @MainActor final class Coordinator: NSObject, NSTextFieldDelegate {
        var owner: TabNameField
        weak var field: NSTextField?
        var monitor: Any?
        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
        private var session = TabRenameSession()
        init(_ owner: TabNameField) { self.owner = owner }
        func retire() {
            session.retire()
            if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        }
        func end(_ save: Bool, reason: String, onlyIfBlurred: Bool = false) {
            let accepted = session.finish(attached: field?.window != nil,
                                          editing: onlyIfBlurred && field?.currentEditor() != nil)
            traceTabRename("finish-\(reason)", "accepted=\(accepted) attached=\(field?.window != nil) editing=\(field?.currentEditor() != nil)")
            guard accepted else { return }
            owner.finish(save)
        }
        func controlTextDidChange(_ notification: Notification) {
            if let field = notification.object as? NSTextField { owner.text = field.stringValue }
        }
        func controlTextDidEndEditing(_ notification: Notification) {
            let responder = (field?.window?.firstResponder).map { String(describing: type(of: $0)) } ?? "nil"
            traceTabRename("end-editing", "responder=\(responder) info=\(notification.userInfo ?? [:])")
            // Menu restoration and view removal also end editing. Commit only if this instance is still live
            // and still blurred after AppKit and SwiftUI finish their responder and layout changes.
            DispatchQueue.main.async { [weak self] in self?.end(true, reason: "focus-loss", onlyIfBlurred: true) }
        }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            if selector == #selector(NSResponder.cancelOperation(_:)) { end(false, reason: "escape"); return true }
            if selector == #selector(NSResponder.insertNewline(_:)) { end(true, reason: "return"); return true }
            return false
        }
    }
}

/// People currently in the file, beside the toolbar actions.
struct LivePeopleStrip: View {
    @ObservedObject var model: CanvasModel
    var body: some View {
        if !model.livePeople.isEmpty && !model.homeShown {
            HStack(spacing: 8) {
                HStack(spacing: -6) {
                    ForEach(Array(model.livePeople.prefix(4))) { person in
                        Button {
                            model.run("{cmd:'focusPerson',session:" + JSONText.string(person.id) + "}")
                        } label: {
                            Text(String(person.name.prefix(1)).uppercased()).font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.white).frame(width: 28, height: 28)
                                .background(Circle().fill(Color(light: UInt32(person.color.dropFirst(), radix: 16) ?? 0x71717A, dark: UInt32(person.color.dropFirst(), radix: 16) ?? 0x71717A)))
                                .shadow(color: .black.opacity(0.15), radius: 1, y: 1)
                        }
                        .buttonStyle(.plain).help(person.name + ", " + person.role)
                        .qaID("live-person-" + person.id, label: person.name + ", " + person.role)
                    }
                    if model.livePeople.count > 4 {
                        Text("+" + String(model.livePeople.count - 4)).font(Typography.micro)
                            .frame(width: 28, height: 28).background(Circle().fill(Palette.field))
                            .help(model.livePeople.dropFirst(4).map { $0.name + ", " + $0.role }.joined(separator: "\n"))
                    }
                }
                if model.peopleStatus != "connected" {
                    Text(["offline", "down", "removed", "signedOut", "signInAgain", "forbidden", "notAdded"].contains(model.peopleStatus) ? "Offline" : "Reconnecting")
                        .font(Typography.label).foregroundStyle(Palette.mutedFg)
                }
            }.fixedSize()
        }
    }
}
