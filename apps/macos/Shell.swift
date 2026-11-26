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

private struct TopBarChipBounds: PreferenceKey {
    struct Region {
        let bounds: Anchor<CGRect>
        var clip: Anchor<CGRect>?
    }
    static var defaultValue: [Region] { [] }
    static func reduce(value: inout [Region], nextValue: () -> [Region]) { value.append(contentsOf: nextValue()) }
}

extension View {
    func topBarChip() -> some View {
        anchorPreference(key: TopBarChipBounds.self, value: .bounds) { [.init(bounds: $0)] }
    }
}

/// Receives presses only on the custom title bar's empty space, including the gaps in the scroll view.
private struct WindowDragArea: NSViewRepresentable {
    let chips: [CGRect]

    func makeNSView(context: Context) -> DragView { DragView() }
    func updateNSView(_ view: DragView, context: Context) {
        view.chips = chips
        if let window = view.window { view.updateMovable(at: window.mouseLocationOutsideOfEventStream) }
    }

    final class DragView: NSView {
        var chips: [CGRect] = []
        private var tracking: NSTrackingArea?

        override var isFlipped: Bool { true }
        override var mouseDownCanMoveWindow: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        private func isOnChip(_ point: NSPoint) -> Bool { chips.contains { $0.contains(point) } }

        override func hitTest(_ point: NSPoint) -> NSView? {
            isOnChip(convert(point, from: superview)) ? nil : super.hitTest(point)
        }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let tracking { removeTrackingArea(tracking) }
            let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                      owner: self, userInfo: nil)
            addTrackingArea(area)
            tracking = area
        }

        // AppKit can start a title bar drag before a chip sees the mouse down.
        func updateMovable(at point: NSPoint) {
            let movable = !isOnChip(convert(point, from: nil))
            if let window, movable != window.isMovable { window.isMovable = movable }
        }
        override func mouseEntered(with event: NSEvent) { updateMovable(at: event.locationInWindow) }
        override func mouseMoved(with event: NSEvent) { updateMovable(at: event.locationInWindow) }
        override func mouseExited(with event: NSEvent) { window?.isMovable = true }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            window.isMovable = true
            if event.clickCount == 1 {
                window.performDrag(with: event)
            } else if event.clickCount == 2 {
                let defaults = UserDefaults.standard
                switch defaults.string(forKey: "AppleActionOnDoubleClick") {
                case "None": break
                case "Minimize": window.performMiniaturize(nil)
                case nil where defaults.bool(forKey: "AppleMiniaturizeOnDoubleClick"): window.performMiniaturize(nil)
                default: window.performZoom(nil)
                }
            }
        }
    }
}

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

struct RootView: View {
    @ObservedObject var model: CanvasModel
    @State private var windowWidth: CGFloat = 0
    private var panelOpen: Bool { model.panelOpen && !model.uiHidden && !model.homeShown }
    private var inspectorShown: Bool { model.propertiesShown }
    private var toolPaletteShown: Bool { model.currentFile != nil && !model.homeShown && !model.cloudReadOnly && !model.uiHidden }
    private var zoomShown: Bool { !model.uiHidden && !model.homeShown && !model.pageEmpty }

    private var rightSidebarShown: Bool { inspectorShown || ((model.commentsSidebarOpen || model.conversationsSidebarOpen) && !model.uiHidden && !model.homeShown) }
    private var minimumCanvasWidth: CGFloat {
        toolPaletteShown ? max(ShellLayout.minCanvas, ToolPalette.width(compact: true) + Metric.pillPad) : ShellLayout.minCanvas
    }

    /// The panel's width in this window, or nil when the window is too narrow for it beside the inspector.
    private var panelWidth: CGFloat? {
        guard windowWidth > 0 else { return model.sidebarWidth }
        return ShellLayout.sidebarWidth(window: windowWidth, stored: model.sidebarWidth, rightSidebar: rightSidebarShown,
                                        inset: Metric.inset, gap: Metric.islandGap, props: Metric.propsWidth, minWidth: Metric.sidebarMin,
                                        minimumCanvas: minimumCanvasWidth)
    }

    /// The widest the panel may be dragged in this window: the maximum, or the room the window leaves.
    private var panelMax: CGFloat {
        guard windowWidth > 0 else { return Metric.sidebarMax }
        let room = ShellLayout.room(window: windowWidth, rightSidebar: rightSidebarShown, inset: Metric.inset,
                                    gap: Metric.islandGap, props: Metric.propsWidth, minimumCanvas: minimumCanvasWidth)
        return min(Metric.sidebarMax, room)
    }

    private var zoomAboveTools: Bool {
        guard toolPaletteShown, zoomShown, windowWidth > 0 else { return false }
        let i = canvasInsets()
        let toolsRight = (windowWidth + i.l - i.r + ToolPalette.width(compact: compactTools)) / 2
        return toolsRight + Metric.islandGap > windowWidth - i.r - ZoomPill.width
    }

    /// Full size, or compact when the room between the sidebars is too narrow for every group.
    private var compactTools: Bool {
        let i = canvasInsets()
        return windowWidth > 0 && windowWidth - i.l - i.r < ToolPalette.width(compact: false) + 8
    }

    private var toolClearance: CGFloat { ToolPalette.clearance(compact: compactTools) }

    private var bottomClearance: CGFloat {
        guard toolPaletteShown else { return 0 }
        return toolClearance + (zoomAboveTools ? ZoomPill.height + Metric.islandGap : 0)
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
                        .padding(.leading, insets.l).padding(.top, insets.t).padding(.trailing, insets.r).padding(.bottom, insets.b)
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .allowsHitTesting(false)
            .animation(Motion.fast, value: model.pageEmpty)
            .ignoresSafeArea()

            LeftColumn(model: model, panelWidth: panelOpen ? panelWidth : nil, panelMax: panelMax)

            if inspectorShown { Inspector(model: model, fonts: model.fonts).disabled(model.cloudReadOnly) }

            GlassEffectContainer(spacing: Metric.islandGap) {
                ZStack(alignment: .topLeading) {
                    // Nothing to zoom on an empty page: the pill comes back with the first board.
                    if zoomShown {
                        ZoomCorner(model: model)
                            .padding(.trailing, rightSidebarShown ? Metric.propsWidth : 0)
                            .padding(.bottom, zoomAboveTools ? toolClearance - Metric.inset : 0)
                    }
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
            .animation(Motion.island, value: model.uiHidden)
            .padding(Metric.inset)
            .ignoresSafeArea()

            if toolPaletteShown {
                // An overlay never sizes its parent: the palette cannot widen the window.
                Color.clear.allowsHitTesting(false)
                    .overlay(alignment: .bottom) {
                        ToolPalette(model: model, compact: compactTools, tooltipClearance: zoomAboveTools ? bottomClearance : 0)
                            .fixedSize()
                            .offset(x: (insets.l - insets.r) / 2, y: -ToolPalette.bottomMargin)
                    }
                    .ignoresSafeArea()
            }

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
        .onChange(of: insets, initial: true) { _, v in
            model.setInsets(l: v.l, t: v.t, r: v.r, b: v.b, bottomClearance: v.bottomClearance)
        }
    }

    private func canvasInsets(bottomClearance: CGFloat = 0) -> (l: CGFloat, t: CGFloat, r: CGFloat, b: CGFloat) {
        CanvasInsets.compute(panel: panelOpen ? panelWidth : nil, rightSidebar: rightSidebarShown, inset: Metric.inset,
                             gap: Metric.islandGap, pill: Metric.pill, props: Metric.propsWidth, bottomClearance: bottomClearance)
    }

    private struct Insets: Equatable {
        let l, t, r, b, bottomClearance: CGFloat
    }

    /// The free rectangle the canvas should fit into, so boards never hide under an island.
    private var insets: Insets {
        let clearance = bottomClearance
        let i = canvasInsets(bottomClearance: clearance)
        return Insets(l: i.l, t: i.t, r: i.r, b: i.b, bottomClearance: clearance)
    }
}

// MARK: Top

/// Each file tab's width, so a drag knows where the others sit.
private struct TabWidthKey: PreferenceKey {
    static var defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) { value.merge(nextValue()) { $1 } }
}

struct TopBar: View {
    private static let minimumDragWidth: CGFloat = 24
    private static let leadingWidth = Metric.trafficLights + 16
    private let gap = ToolbarButtonStyle.chipGap
    @ObservedObject var model: CanvasModel
    @State private var tabWidths: [String: CGFloat] = [:]
    @State private var barWidth: CGFloat = 0
    @State private var actionsWidth: CGFloat = 0
    @State private var hoveredTab: String?
    @State private var pressedTab: String?

    private var showsSidebarToggle: Bool { !model.homeShown && !model.uiHidden }

    private var tabRoom: CGFloat {
        let controls: CGFloat = showsSidebarToggle ? 3 : 2
        let fixedWidth = controls * (Metric.toolbarControl + gap)
        return max(0, barWidth - actionsWidth - Self.leadingWidth - fixedWidth - Self.minimumDragWidth)
    }
    private func fittedWidths(for files: [String]) -> [CGFloat] {
        let font = NSFont.systemFont(ofSize: 12, weight: .medium)
        let natural: [CGFloat] = files.map { file in
            let titleWidth = (model.name(of: file) as NSString).size(withAttributes: [.font: font]).width
            return ceil(titleWidth) + TabChip.chromeWidth
        }
        return TabSizing.widths(natural: natural, available: tabRoom, minimum: Metric.tabMin, maximum: Metric.tabMax)
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
        return TabOrder.target(from: i, offset: dragX, widths: widths, gap: gap)
    }

    private func fileSymbol(_ file: String, missing: Bool) -> String {
        if missing { return "exclamationmark.triangle" }
        return CloudFilePath(file) == nil ? "doc" : "cloud"
    }

    private func isActive(_ file: String) -> Bool { file == model.currentFile && !model.homeShown }

    /// One file tab. Press and drag sideways: it follows the pointer, the others slide aside, and the drop saves the
    /// order. A click or a move under TabOrder.dragThreshold stays a click.
    private func draggableTab(_ f: String, index i: Int, width: CGFloat) -> some View {
        let isDragged = dragging == f
        var off: CGFloat = 0
        if isDragged { off = dragX }
        else if let d = dragging, let di = model.openFiles.firstIndex(of: d), let t = dragTarget {
            off = TabOrder.slide(i, dragged: di, target: t, width: tabWidths[d] ?? 0, gap: gap)
        }
        let missing = model.isMissing(f)
        let active = isActive(f)
        let hovering = hoveredTab == f
        return TabChip(title: model.name(of: f), symbol: fileSymbol(f, missing: missing), active: active,
                       width: width, hovering: hovering, pressed: pressedTab == f, missing: missing,
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
                    TabPointer(closeVisible: active || hovering, onPress: { pressed in
                        if pressed { pressedTab = f }
                        else if pressedTab == f { pressedTab = nil }
                    }, onClick: { model.openTab(f) }, onRename: { beginRename(f) },
                               onMenu: { view, at in tabMenu(f, view: view, at: at) },
                               onDrag: { dx in
                        guard let at = model.openFiles.firstIndex(of: f) else { return }
                        dragging = f
                        dragX = TabOrder.clamp(dx, index: at, widths: widths, gap: gap)
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
            .onHover { inside in
                if inside { hoveredTab = f }
                else if hoveredTab == f { hoveredTab = nil }
            }
            .offset(x: off)
            .animation(isDragged ? nil : Motion.island, value: off)
            .zIndex(isDragged ? 1 : 0)
            .qaID("file-tab", label: model.name(of: f))
            .topBarChip()
            .id(f)
    }

    private var tabs: some View {
        let files = model.openFiles
        let fitted = fittedWidths(for: files)
        let stripWidth = min(tabRoom, fitted.reduce(0, +) + CGFloat(max(0, files.count - 1)) * gap)
        return HStack(spacing: gap) {
            if showsSidebarToggle {
                SidebarToggleButton(model: model)
            }
            TopBarIconButton(symbol: "house", active: model.homeShown, help: "Home", shortcut: "\u{21E7}\u{2318}0") {
                model.showHome()
            }
            .qaID("home-tab", label: "Home")
            if !files.isEmpty {
                FadingScroller(scrollTo: model.currentFile, spacing: gap) {
                    ForEach(Array(files.enumerated()), id: \.element) { i, file in
                        draggableTab(file, index: i, width: fitted[i])
                    }
                }
                .frame(width: stripWidth, height: Metric.toolbarControl)
                .transformAnchorPreference(key: TopBarChipBounds.self, value: .bounds) { regions, clip in
                    for i in regions.indices { regions[i].clip = clip }
                }
                .onPreferenceChange(TabWidthKey.self) { tabWidths = $0 }
            }
            TopBarIconButton(symbol: "plus", help: "New file", shortcut: "\u{2318}N") { model.newCanvas() }
                .qaID("tab-new", label: "New file")
        }
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
        }
        .menuStyle(.button).buttonStyle(ToolbarButtonStyle(topBarSymbol: "chevron.down")).menuIndicator(.hidden)
        .fixedSize().chromeHelp("Show tabs")
        .accessibilityLabel("Show tabs")
        .qaID("tab-list", label: "Show tabs")
        .topBarChip()
    }

    private var actions: some View {
        HStack(spacing: 0) {
            LivePeopleStrip(model: model)
            ResourceReadout(meter: ResourceMeter.shared, model: model)
            HStack(spacing: gap) {
                TopBarIconButton(symbol: "magnifyingglass", help: "Quick actions", shortcut: "\u{2318}K") { PaletteController.shared.toggle() }
                if model.currentFile != nil && !model.homeShown {
                    TopBarIconButton(symbol: "sparkles.2", active: model.conversationsSidebarOpen, help: "Conversations") { model.run("{cmd:\"conversations\"}") }
                        .qaID("conversations-toggle")
                }
                if model.editorChromeShown {
                    TopBarIconButton(symbol: "sidebar.right", active: model.propertiesShown,
                                     help: model.propertiesShown ? "Hide properties" : "Show properties") {
                        model.toggleProperties()
                    }
                    .qaID("properties-toggle")
                }
                tabMenu
            }
        }
        .padding(.trailing, Metric.pillPad)
        .fixedSize(horizontal: true, vertical: false)
        .qaID("top-bar-actions")
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { actionsWidth = $0 }
    }

    var body: some View {
        GeometryReader { _ in
            HStack(spacing: 0) {
                Color.clear.frame(width: Self.leadingWidth)
                tabs
                Spacer(minLength: Self.minimumDragWidth)
                actions
            }
            .frame(height: Metric.topBar)
            .topBarSurface()
            .overlayPreferenceValue(TopBarChipBounds.self) { regions in
                GeometryReader { geometry in
                    WindowDragArea(chips: regions.map { region in
                        let bounds = geometry[region.bounds]
                        return region.clip.map { bounds.intersection(geometry[$0]) } ?? bounds
                    })
                }
            }
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

private struct SidebarToggleButton: View {
    @ObservedObject var model: CanvasModel

    var body: some View {
        let label = model.panelOpen ? "Hide panel" : "Show panel"
        TopBarIconButton(symbol: "sidebar.left", active: model.panelOpen, help: label) { model.panelOpen.toggle() }
            .qaID("sidebar-toggle", label: label)
    }
}

enum SidebarStyle {
    static let row = Metric.sidebarRow
    static let radius = Metric.sidebarRadius
    static let selection = Palette.sidebarSelected
    static let title = Font.system(size: 13, weight: .semibold)
    static let text = Font.system(size: 12)
}

struct SidebarGroupLabel: View {
    let title: String
    var inset: CGFloat = 6

    var body: some View {
        Text(title).font(Typography.section).foregroundStyle(Palette.mutedFg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, inset)
            .frame(height: 20)
            .qaText(title)
    }
}

struct LeftColumn: View {
    private static let headerHeight = Metric.control
    private static let titlePadding: CGFloat = 4
    @ObservedObject var model: CanvasModel
    /// From RootView: the stored width clamped to the window; nil hides the panel.
    let panelWidth: CGFloat?
    let panelMax: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private struct ScrollKey: Hashable {
        let file: String?
        let section: SidebarSection
    }

    @State private var scrollOffsets: [ScrollKey: CGFloat] = [:]
    @State private var tokenTab: TokenTab = .text
    @State private var searchOpen = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        ZStack(alignment: .topLeading) {
            if model.sidebarMenuOpen {
                Color.clear.contentShape(Rectangle())
                    .onTapGesture { dismissMenu() }
            }
            if let width = panelWidth {
                column(width: width)
                    .transition(reduceMotion ? .identity : .offset(x: -width - 32))
            }
        }
        .padding(.top, Metric.topBar)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: panelWidth != nil)
        .onChange(of: panelWidth != nil) { _, shown in
            if !shown { model.sidebarMenuOpen = false; closeSearch() }
        }
        .onChange(of: model.currentFile) { _, _ in model.sidebarMenuOpen = false }
        .onChange(of: model.section) { _, _ in closeSearch() }
        .onChange(of: tokenTab) { _, _ in closeSearch() }
    }

    private var searchPrompt: String {
        switch tokenTab {
        case .text: "Search text styles"
        case .variables: "Search variables"
        case .fonts: "Search fonts"
        }
    }

    private func closeSearch() {
        searchOpen = false
        query = ""
        searchFocused = false
    }

    private func dismissMenu() {
        model.sidebarMenuOpen = false
        model.focusCanvas()
    }

    private func listLoaded(_ section: SidebarSection) -> Bool {
        !model.revision.isEmpty && (section != .widgets || (model.sidebarWidgetsLoaded && !model.widgetKinds.isEmpty))
    }

    private func column(width: CGFloat) -> some View {
        let section = model.section
        let scrollKey = ScrollKey(file: model.currentFile, section: section)
        let loaded = listLoaded(section)
        return VStack(spacing: 0) {
            HStack(spacing: 4) {
                Button {
                    if model.sidebarMenuOpen { dismissMenu() }
                    else { searchFocused = false; model.sidebarMenuOpen = true }
                } label: {
                    HStack(spacing: 6) {
                        Text(section.rawValue).font(SidebarStyle.title)
                            .foregroundStyle(Palette.fg)
                            .qaID("sidebar-section-title", label: section.rawValue)
                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Palette.mutedFg)
                    }
                    .padding(.horizontal, Self.titlePadding)
                }
                .buttonStyle(ToolbarButtonStyle(active: model.sidebarMenuOpen, width: nil))
                .help("Choose a sidebar section")
                .accessibilityLabel(section.rawValue)
                .accessibilityHint("Choose a sidebar section")
                .qaID("sidebar-section-menu", label: section.rawValue)
                Spacer(minLength: 0)
                if section == .tokens {
                    Button {
                        model.sidebarMenuOpen = false
                        searchOpen = true
                        searchFocused = true
                    } label: {
                        Image(systemName: "magnifyingglass").glyph(GlyphSize.row)
                    }
                    .buttonStyle(ToolbarButtonStyle(active: searchOpen))
                    .help(searchPrompt)
                    .accessibilityLabel(searchPrompt)
                    .qaID("sidebar-search")
                }
            }
            .frame(height: Self.headerHeight)
            .padding(.leading, Metric.sidebarLabelInset - Self.titlePadding)
            .padding(.trailing, SidebarSize.hitWidth)

            VStack(spacing: 0) {
                if section == .tokens && searchOpen {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Palette.mutedFg)
                        TextField(searchPrompt, text: $query).textFieldStyle(.plain)
                            .font(SidebarStyle.text).focused($searchFocused).qaText(searchPrompt)
                            .onAppear { searchFocused = true }
                            .onExitCommand { closeSearch(); model.focusCanvas() }
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 24)
                    .background(Palette.hover, in: RoundedRectangle(cornerRadius: 6))
                    .padding(.horizontal, 8).padding(.bottom, 4)
                }
                // The opening preview can show saved rows before the live list arrives.
                SidePanel(model: model, section: section, tokenTab: $tokenTab, query: query, offset: Binding(
                    get: { loaded ? scrollOffsets[scrollKey] : nil },
                    set: {
                        guard loaded, model.currentFile == scrollKey.file, model.section == section, listLoaded(section) else { return }
                        scrollOffsets[scrollKey] = $0
                    }
                ))
                .id(loaded)
                .id(scrollKey)
            }
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .sidebarSurface(canvasEdge: .trailing)
        .overlay(alignment: .trailing) {
            SidebarResizeHandle(model: model, shown: width, minWidth: Metric.sidebarMin, maxWidth: panelMax,
                                defaultWidth: Metric.sidebarWidth) { model.sidebarWidth = $0 }
        }
        .task(id: section) { if section == .widgets { model.fetchKinds() } }
        .overlay(alignment: .topLeading) {
            if model.sidebarMenuOpen {
                ZStack(alignment: .topLeading) {
                    Color.clear.contentShape(Rectangle())
                        .onTapGesture { dismissMenu() }
                        .padding(.top, Self.headerHeight)
                    SidebarSectionMenu(selection: section) {
                        model.section = $0
                        dismissMenu()
                    }
                    .qaID("sidebar-section-popup")
                    .padding(.leading, Metric.sidebarLabelInset)
                    .padding(.top, Self.headerHeight)
                }
            }
        }
        .qaID("sidebar-panel")
    }
}

private struct SidebarSectionMenu: View {
    let selection: SidebarSection
    let select: (SidebarSection) -> Void
    @State private var hovered: SidebarSection?
    @State private var keyboardItem: SidebarSection?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ForEach(SidebarSection.allCases) { item in
                Button { select(item) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold))
                            .frame(width: 12).opacity(selection == item ? 1 : 0).accessibilityHidden(true)
                        Text(item.rawValue).font(SidebarStyle.text)
                        Spacer(minLength: 12)
                        keycap("\u{2325}")
                        keycap(item.shortcut)
                    }
                    .padding(.horizontal, 6)
                    .frame(height: 24)
                    .background(RoundedRectangle(cornerRadius: 5)
                        .fill((hovered ?? keyboardItem ?? selection) == item ? SidebarStyle.selection : .clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { hovered = $0 ? item : nil }
                .accessibilityLabel(item.rawValue)
                .accessibilityHint("Option " + item.shortcut)
                .accessibilityAddTraits(selection == item ? .isSelected : [])
                .qaID("sidebar-section", label: item.rawValue)
            }
        }
        .padding(4)
        .frame(width: 184)
        .background(Palette.popover, in: RoundedRectangle(cornerRadius: 8))
        .shadow(color: .black.opacity(0.33), radius: 9, y: 4)
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onAppear { focused = true }
        .onKeyPress(.upArrow) { move(-1); return .handled }
        .onKeyPress(.downArrow) { move(1); return .handled }
        .onKeyPress(.return) { select(keyboardItem ?? selection); return .handled }
    }

    private func move(_ step: Int) {
        let items = SidebarSection.allCases
        let index = items.firstIndex(of: keyboardItem ?? selection)!
        keyboardItem = items[(index + step + items.count) % items.count]
        hovered = nil
    }

    private func keycap(_ key: String) -> some View {
        Text(key).font(.system(size: 11, weight: .medium))
            .frame(width: 16, height: 16)
            .background(SidebarStyle.selection, in: RoundedRectangle(cornerRadius: 4))
            .accessibilityHidden(true)
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
    let query: String
    @Binding var offset: CGFloat?
    @State private var scroll: ScrollPosition

    init(model: CanvasModel, section: SidebarSection, tokenTab: Binding<TokenTab>, query: String, offset: Binding<CGFloat?>) {
        self.model = model
        self.section = section
        _tokenTab = tokenTab
        self.query = query
        _offset = offset
        _scroll = State(initialValue: ScrollPosition(y: offset.wrappedValue ?? 0))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    switch section {
                    case .layers:
                        PagesSection(model: model).padding(.bottom, 10)
                        SidebarGroupLabel(title: "Layers")
                        LayersRows(model: model, store: LayersStore.of(model))
                    case .assets:
                        ForEach(model.components) { c in
                            ListRow(title: (c.isText ? "T " : "") + c.name, detail: c.instances > 0 ? "\(c.instances) \u{00D7}" : c.type,
                                    symbol: "diamond.fill", sidebar: true, active: c.id == model.selection?.id) { model.reveal(c.id, board: c.board) }
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
                        case .text: TokenLibrary(model: model, styles: true, query: query)
                        case .variables: TokenLibrary(model: model, styles: false, query: query)
                        case .fonts: FontList(model: model, fonts: model.fonts, query: query)
                        }
                    case .widgets:
                        WidgetsPanel(model: model)
                    }
                }
                .padding(.horizontal, section == .widgets ? 0 : Metric.sidebarInset)
                .padding(.bottom, 8)
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
    let query: String

    var body: some View {
        let shown = query.isEmpty ? fonts.families : fonts.families.filter { $0.localizedCaseInsensitiveContains(query) }
        ForEach(shown, id: \.self) { family in
            ListRow(title: family, detail: "\(fonts.styleCount(of: family))", font: .custom(family, size: 12), sidebar: true) {
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

private struct ToolPalette: View {
    @ObservedObject var model: CanvasModel
    let compact: Bool
    let tooltipClearance: CGFloat
    #if CANVAS_QA
    @AppStorage(QA.hoveredToolKey) private var qaHoveredTool = ""
    #else
    private let qaHoveredTool = ""
    #endif

    private static let padding: CGFloat = 4
    private static let gap: CGFloat = 4
    private static let divider: CGFloat = 1
    private static let rowSpacing = Metric.toolbarControl + gap

    static func width(compact: Bool) -> CGFloat {
        let widths = groups.map { CGFloat($0.count) * Metric.toolbarControl + CGFloat($0.count - 1) * gap }
        let content = compact ? widths.max() ?? 0 : widths.reduce(0, +) + CGFloat(widths.count - 1) * (2 * gap + divider)
        return content + 2 * padding
    }

    private struct Item: Identifiable {
        let tool: DrawTool
        var id: String { tool.rawValue }
        var mark: String {
            switch tool {
            case .vote: return "vote-tool"
            case .timer: return "timer-tool"
            default: return "draw-tool"
            }
        }
        @MainActor func selected(in model: CanvasModel) -> Bool {
            switch tool {
            case .vote: return model.voteToolActive
            case .timer: return model.timerToolActive
            default: return model.activeDrawTool == tool
            }
        }
        var icon: WhiteboardToolIcon? {
            switch tool {
            case .sticky: return .sticky
            case .sticker: return .sticker
            case .vote: return .vote
            case .timer: return .timer
            default: return nil
            }
        }
    }

    private static let groups: [[Item]] = {
        var groups = DrawTool.paletteGroups.map { $0.map { Item(tool: $0) } }
        groups[groups.count - 1].append(contentsOf: [Item(tool: .vote), Item(tool: .timer)])
        return groups
    }()

    static let bottomMargin: CGFloat = 14
    static func clearance(compact: Bool) -> CGFloat {
        bottomMargin + Metric.toolbarControl + (compact ? CGFloat(groups.count - 1) * rowSpacing : 0)
            + 2 * padding + Metric.islandGap
    }

    private func tooltipOffset(for index: Int) -> CGFloat {
        let rowsAbove = compact ? CGFloat(index) * Self.rowSpacing : 0
        let rowsBelow = compact ? CGFloat(Self.groups.count - index - 1) * Self.rowSpacing : 0
        return max(Metric.toolbarControl + 8 + rowsAbove, tooltipClearance - Self.bottomMargin - Self.padding - rowsBelow)
    }

    var body: some View {
        let shape = ToolbarButtonStyle.shape(outset: Self.padding)
        let layout = compact ? AnyLayout(VStackLayout(alignment: .leading, spacing: Self.gap))
                             : AnyLayout(HStackLayout(spacing: Self.gap))
        layout {
            ForEach(Self.groups.indices, id: \.self) { index in
                HStack(spacing: Self.gap) {
                    if !compact && index > 0 {
                        Rectangle().fill(Palette.fg.opacity(0.08))
                            .frame(width: Self.divider, height: 20)
                            .accessibilityHidden(true)
                    }
                    ForEach(Self.groups[index]) { item in
                        ToolButton(item: item, tooltipOffset: tooltipOffset(for: index),
                                   selected: item.selected(in: model),
                                   qaHovered: qaHoveredTool == item.id) {
                            model.draw(item.tool)
                        }
                    }
                }
            }
        }
        .padding(Self.padding)
        .contentShape(shape)
        .onTapGesture {}
        .glassBar(in: shape)
        .disabled(!model.canDraw)
        .qaID("tool-palette")
    }

    private struct ToolButton: View {
        let item: Item
        let tooltipOffset: CGFloat
        let selected: Bool
        let qaHovered: Bool
        let action: () -> Void
        @State private var hovering = false
        private var showsTooltip: Bool { hovering || qaHovered }

        var body: some View {
            let glyph: CGFloat = 16
            Button(action: action) {
                Group {
                    if let icon = item.icon {
                        icon.stroke(style: StrokeStyle(lineWidth: glyph / 12, lineCap: .round, lineJoin: .round))
                            .frame(width: glyph, height: glyph)
                    } else if item.tool == .text {
                        Text("T").font(.system(size: glyph, weight: .light))
                    } else {
                        Image(systemName: item.tool.symbol).font(.system(size: glyph, weight: .medium))
                    }
                }
            }
            .buttonStyle(ToolbarButtonStyle(active: selected, selectedMark: (item.mark + "-selected", item.tool.title),
                                            forceHover: qaHovered))
            .onHover { hovering = $0 }
            .overlay(alignment: .bottom) {
                if showsTooltip {
                    HStack(spacing: 6) {
                        Text(item.tool.title)
                        Text(item.tool.keycap)
                            .padding(.horizontal, 3)
                            .frame(minWidth: 18, minHeight: 18, maxHeight: 18)
                            .background(Palette.fg.opacity(0.08), in: RoundedRectangle(cornerRadius: 4))
                    }
                    .font(Typography.label)
                    .foregroundStyle(Palette.fg)
                    .padding(.horizontal, 7)
                    .frame(height: 28)
                    .fixedSize()
                    .background(Palette.popover, in: RoundedRectangle(cornerRadius: 8))
                    .qaID("tool-tooltip", label: item.tool.title)
                    .offset(y: -tooltipOffset)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
            }
            .accessibilityLabel(item.tool.title)
            .accessibilityHint("Shortcut \(item.tool.keycap)")
            .accessibilityAddTraits(selected ? .isSelected : [])
            .qaID(item.mark, label: item.tool.title)
        }
    }
}

private enum WhiteboardToolIcon: Shape {
    case sticky, sticker, vote, timer

    func path(in rect: CGRect) -> Path {
        var path = Path()
        switch self {
        case .sticky, .sticker:
            path.move(to: CGPoint(x: 21, y: 9))
            path.addLines([CGPoint(x: 21, y: 9), CGPoint(x: 15, y: 3), CGPoint(x: 5, y: 3)])
            path.addQuadCurve(to: CGPoint(x: 3, y: 5), control: CGPoint(x: 3, y: 3))
            path.addLine(to: CGPoint(x: 3, y: 19))
            path.addQuadCurve(to: CGPoint(x: 5, y: 21), control: CGPoint(x: 3, y: 21))
            path.addLine(to: CGPoint(x: 19, y: 21))
            path.addQuadCurve(to: CGPoint(x: 21, y: 19), control: CGPoint(x: 21, y: 21))
            path.closeSubpath()
            path.move(to: CGPoint(x: 15, y: 3))
            path.addLine(to: CGPoint(x: 15, y: 8))
            path.addQuadCurve(to: CGPoint(x: 16, y: 9), control: CGPoint(x: 15, y: 9))
            path.addLine(to: CGPoint(x: 21, y: 9))
            if self == .sticker {
                for x in [8.0, 16.0] {
                    path.addLines([CGPoint(x: x, y: 13), CGPoint(x: x + 0.01, y: 13)])
                }
                path.move(to: CGPoint(x: 10, y: 16))
                path.addQuadCurve(to: CGPoint(x: 14, y: 16), control: CGPoint(x: 12, y: 18))
            }
        case .vote:
            path.addRoundedRect(in: CGRect(x: 5, y: 5, width: 14, height: 14), cornerSize: CGSize(width: 2, height: 2), style: .circular)
            path.addLines([CGPoint(x: 2, y: 19), CGPoint(x: 22, y: 19)])
            path.addLines([CGPoint(x: 9, y: 12), CGPoint(x: 11, y: 14), CGPoint(x: 15, y: 10)])
        case .timer:
            path.addEllipse(in: CGRect(x: 4, y: 6, width: 16, height: 16))
            path.addLines([CGPoint(x: 10, y: 2), CGPoint(x: 14, y: 2)])
            path.addLines([CGPoint(x: 12, y: 14), CGPoint(x: 15, y: 11)])
        }
        let transform = CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: rect.width / 24, y: rect.height / 24)
        return path.applying(transform)
    }
}

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
    let onPress: (Bool) -> Void
    let onClick: () -> Void
    let onRename: () -> Void
    let onMenu: (NSView, CGPoint) -> Void
    let onDrag: (CGFloat) -> Void
    let onDrop: () -> Void
    func makeNSView(context: Context) -> Pointer { Pointer() }
    func updateNSView(_ v: Pointer, context: Context) {
        v.closeVisible = closeVisible
        v.pressed = onPress
        v.click = onClick; v.rename = onRename; v.menuAction = onMenu; v.drag = onDrag; v.drop = onDrop
    }
    final class Pointer: NSView {
        var closeVisible = false
        var click: () -> Void = {}, rename: () -> Void = {}, drop: () -> Void = {}
        var menuAction: (NSView, CGPoint) -> Void = { _, _ in }
        var drag: (CGFloat) -> Void = { _ in }
        var pressed: (Bool) -> Void = { _ in }
        private var start: CGFloat = 0
        private var press = TabPress()
        override var mouseDownCanMoveWindow: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? {
            guard let hit = super.hitTest(point) else { return nil }
            let local = convert(point, from: superview)
            let event = NSApp.currentEvent
            let secondary = event?.type == .rightMouseDown || event?.modifierFlags.contains(.control) == true
            if closeVisible && TabChip.closeFrame(in: bounds).contains(local) && !secondary { return nil }
            return hit
        }
        override func mouseDown(with event: NSEvent) {
            if event.modifierFlags.contains(.control) { rightMouseDown(with: event); return }
            if event.clickCount == 1 { pressed(true) }
            start = event.locationInWindow.x
            perform(press.down(button: event.buttonNumber, clicks: event.clickCount))
        }
        override func mouseDragged(with event: NSEvent) {
            let dx = event.locationInWindow.x - start
            if press.drag(dx) { drag(dx) }
        }
        override func mouseUp(with event: NSEvent) {
            pressed(false)
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
            pressed(false)
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
    private let gap = ToolbarButtonStyle.chipGap

    var body: some View {
        if !model.livePeople.isEmpty && !model.homeShown {
            HStack(spacing: gap) {
                ForEach(Array(model.livePeople.prefix(4))) { person in
                    let rgb = UInt32(person.color.dropFirst(), radix: 16) ?? 0x71717A
                    Button {
                        model.run("{cmd:'focusPerson',session:" + JSONText.string(person.id) + "}")
                    } label: {
                        Text(String(person.name.prefix(1)).uppercased()).font(.system(size: 11, weight: .semibold))
                    }
                    .buttonStyle(ToolbarButtonStyle(tint: Color(light: rgb, dark: rgb)))
                    .chromeHelp(person.name + ", " + person.role)
                    .accessibilityLabel(person.name + ", " + person.role)
                    .qaID("live-person-" + person.id, label: person.name + ", " + person.role)
                    .topBarChip()
                }
                if model.livePeople.count > 4 {
                    Text("+" + String(model.livePeople.count - 4)).font(Typography.micro)
                        .frame(width: Metric.toolbarControl, height: Metric.toolbarControl)
                        .chromeHelp(model.livePeople.dropFirst(4).map { $0.name + ", " + $0.role }.joined(separator: "\n"))
                        .topBarChip()
                }
                if model.peopleStatus != "connected" {
                    Text(["offline", "down", "removed", "signedOut", "signInAgain", "forbidden", "notAdded"].contains(model.peopleStatus) ? "Offline" : "Reconnecting")
                        .font(Typography.label).foregroundStyle(Palette.mutedFg)
                        .frame(height: Metric.toolbarControl)
                }
            }
            .padding(.trailing, gap)
            .fixedSize()
        }
    }
}
