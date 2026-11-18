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

/// Control backing excludes these rectangles from the titlebar's native drag region.
struct WindowControlArea: NSViewRepresentable {
    final class ControlView: NSView { override var mouseDownCanMoveWindow: Bool { false } }
    func makeNSView(context: Context) -> NSView { ControlView() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// SwiftUI controls in the hidden titlebar must not inherit window dragging.
final class ControlHostingView<Content: View>: NSHostingView<Content> {
    override var mouseDownCanMoveWindow: Bool { false }
}

private let barY: CGFloat = Metric.inset
private let columnTop: CGFloat = Metric.inset + Metric.pill + Metric.islandGap

struct RootView: View {
    @ObservedObject var model: CanvasModel
    @State private var windowWidth: CGFloat = 0
    private var panelOpen: Bool { model.panelOpen && !model.uiHidden && !model.homeShown }
    private var inspectorShown: Bool { model.hasInspectable && model.inspectorOpen && !model.uiHidden && !model.homeShown }

    /// The panel's width in this window, or nil when the window is too narrow for it beside the inspector.
    private var panelWidth: CGFloat? {
        guard windowWidth > 0 else { return model.sidebarWidth }
        return ShellLayout.sidebarWidth(window: windowWidth, stored: model.sidebarWidth, inspector: inspectorShown,
                                        inset: Metric.inset, rail: Metric.railWidth, gap: Metric.islandGap, props: Metric.propsWidth, minWidth: Metric.sidebarMin)
    }

    /// The widest the panel may be dragged in this window: the maximum, or the room the window leaves.
    private var panelMax: CGFloat {
        guard windowWidth > 0 else { return Metric.sidebarMax }
        let room = ShellLayout.room(window: windowWidth, inspector: inspectorShown, inset: Metric.inset, rail: Metric.railWidth,
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
                    TopBar(model: model)
                    // View > Hide UI (Cmd+backslash): only the canvas and the tabs stay.
                    if !model.uiHidden && !model.homeShown { LeftColumn(model: model, panelOpen: $model.panelOpen, panelWidth: panelWidth, panelMax: panelMax) }
                    if inspectorShown { Inspector(model: model, fonts: model.fonts) }
                    // Nothing to zoom on an empty page: the pill comes back with the first board.
                    if !model.uiHidden && !model.homeShown && !model.pageEmpty { ZoomCorner(model: model) }
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

    private var tabRoom: CGFloat {
        max(0, barWidth - actionsWidth - 2 * Metric.islandGap - 2 * Metric.pillPad
            - Metric.trafficLights - 2 * Metric.control - 2)
    }
    private var fittedWidths: [CGFloat] {
        let font = NSFont.systemFont(ofSize: 12, weight: .medium)
        // Leading/trailing padding, document glyph, gap and close target, matching TabChip.
        let chromeWidth: CGFloat = Metric.control + 29
        let natural: [CGFloat] = model.openFiles.map { file in
            let titleWidth = (model.name(of: file) as NSString).size(withAttributes: [.font: font]).width
            return ceil(titleWidth) + chromeWidth
        }
        return TabSizing.widths(natural: natural, available: tabRoom, minimum: Metric.tabMin)
    }
    private var stripWidth: CGFloat {
        min(tabRoom, fittedWidths.reduce(0, +) + CGFloat(max(0, model.openFiles.count - 1)) * 2)
    }
    /// The file tab being dragged and how far it is from its place (clamped inside the strip).
    @State private var dragging: String?
    @State private var dragX: CGFloat = 0

    @State private var renaming: String?
    @State private var renameDraft = ""

    private func beginRename(_ file: String) {
        renaming = file
        renameDraft = URL(fileURLWithPath: file).deletingPathExtension().lastPathComponent
    }

    private func finishRename(_ save: Bool) {
        guard let file = renaming else { return }
        renaming = nil
        if save { model.renameFile(file, to: renameDraft) }
    }

    private func tabMenu(_ file: String, view: NSView, at: CGPoint) {
        let menu = ContextMenuBuilder(model: model, at: at)
        for (i, group) in ContextMenuLayout.fileTab(cloud: CloudURL.clean(model.prefs.cloudUrl) != nil).enumerated() {
            if i > 0 { menu.separator() }
            for title in group {
                menu.action(title) {
                    switch title {
                    case "Rename...": beginRename(file)
                    case "Show in Finder": NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: file)])
                    case "Duplicate": model.duplicateFile(file)
                    case "Move to Cloud...": CloudAccount.shared.shareOpenFile(model, file: file)
                    case "Copy Link":
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString("canvas://open?file=" + DocURL.encode(file), forType: .string)
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
        return TabOrder.target(from: i, offset: dragX, widths: widths, gap: 2)
    }

    /// One file tab. Press and drag sideways: it follows the pointer, the others slide aside, and the drop saves the
    /// order. A click or a move under TabOrder.dragThreshold stays a click.
    private func draggableTab(_ f: String, index i: Int) -> some View {
        let isDragged = dragging == f
        var off: CGFloat = 0
        if isDragged { off = dragX }
        else if let d = dragging, let di = model.openFiles.firstIndex(of: d), let t = dragTarget {
            off = TabOrder.slide(i, dragged: di, target: t, width: tabWidths[d] ?? 0, gap: 2)
        }
        return TabChip(title: model.name(of: f), active: f == model.currentFile && !model.homeShown, width: fittedWidths[i], missing: model.isMissing(f),
                       onClose: { model.close(f) }) { model.openTab(f) }
            .background(WindowControlArea())
            .background(GeometryReader { g in Color.clear.preference(key: TabWidthKey.self, value: [f: g.size.width]) })
            .overlay {
                if renaming == f {
                    TabNameField(text: $renameDraft, finish: finishRename)
                        .frame(height: 20)
                        .padding(.leading, 10).padding(.trailing, 30)
                        .qaID("tab-rename", label: "Rename file")
                } else {
                    TabPointer(onClick: { model.openTab(f) }, onRename: { beginRename(f) },
                               onMenu: { view, at in tabMenu(f, view: view, at: at) },
                               onDrag: { dx in
                        guard let at = model.openFiles.firstIndex(of: f) else { return }
                        dragging = f
                        dragX = TabOrder.clamp(dx, index: at, widths: widths, gap: 2)
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
            .offset(x: off)
            .animation(isDragged ? nil : Motion.island, value: off)
            .zIndex(isDragged ? 1 : 0)
            .qaID("file-tab", label: model.name(of: f))
            .id(f)
    }

    var body: some View {
        HStack(alignment: .top, spacing: Metric.islandGap) {
            GlassPill {
                HStack(spacing: 0) {
                    Color.clear.frame(width: Metric.trafficLights, height: Metric.control) // the traffic lights live here
                    // Home: always first, never closed. Its name shows while no file is open; the glyph alone after.
                    PinnedTab(symbol: "house", title: "Home", compact: !model.openFiles.isEmpty, active: model.homeShown,
                              help: "Home  \u{21E7}\u{2318}0") { model.showHome() }
                        .background(WindowControlArea())
                        .qaID("home-tab", label: "Home")
                        .padding(.trailing, model.openFiles.isEmpty ? 0 : 2)
                        .animation(Motion.island, value: model.openFiles.isEmpty)
                    FadingScroller(scrollTo: model.currentFile) {
                        ForEach(Array(model.openFiles.enumerated()), id: \.element) { i, f in
                            draggableTab(f, index: i)
                        }
                    }
                    .frame(width: stripWidth)
                    .onPreferenceChange(TabWidthKey.self) { tabWidths = $0 }
                    Menu {
                        ForEach(model.allFiles) { f in Button(f.name) { model.open(f.file) } }
                    } label: {
                        Image(systemName: "plus").symbolRenderingMode(.hierarchical)
                            .symbolEffect(.bounce, value: model.openFiles.count)
                            .font(.system(size: Metric.icon, weight: .medium)).foregroundStyle(Palette.mutedFg)
                            .frame(width: Metric.control, height: Metric.control).contentShape(Circle())
                    }
                    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize().chromeHelp("Open a canvas")
                    .background(WindowControlArea())
                        .qaID("tab-open", label: "Open a canvas")
                }
            }
            .background(WindowDragArea())
            .layoutPriority(1)
            WindowDragArea().frame(maxWidth: .infinity).frame(height: Metric.pill)

            GlassPill {
                HStack(spacing: 0) {
                    ResourceReadout(meter: ResourceMeter.shared, model: model)
                    IconButton(symbol: "magnifyingglass", help: "Quick actions  \u{2318}K") { PaletteController.shared.toggle() }
                    // Nothing to inspect on an empty page.
                    if !model.pageEmpty {
                        IconButton(symbol: "sidebar.right", active: model.inspectorOpen, help: model.inspectorOpen ? "Hide properties" : "Show properties") { model.inspectorOpen.toggle() }
                    }
                }
            }
            .fixedSize(horizontal: true, vertical: false)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { actionsWidth = $0 }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { barWidth = $0 }
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
    /// The widest a drag may make the panel in this window.
    let panelMax: CGFloat

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
                    .overlay(alignment: .trailing) {
                        SidebarResizeHandle(model: model, shown: width, minWidth: Metric.sidebarMin, maxWidth: panelMax, defaultWidth: Metric.sidebarWidth) { model.sidebarWidth = $0 }
                    }
                    .frame(maxHeight: .infinity, alignment: .top)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        .padding(.top, columnTop - barY)
        .padding(.bottom, 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
    }
}




/// Handles tab presses explicitly so double and secondary clicks cannot become reorder drags.
private struct TabPointer: NSViewRepresentable {
    let onClick: () -> Void
    let onRename: () -> Void
    let onMenu: (NSView, CGPoint) -> Void
    let onDrag: (CGFloat) -> Void
    let onDrop: () -> Void
    func makeNSView(context: Context) -> Pointer { Pointer() }
    func updateNSView(_ v: Pointer, context: Context) {
        v.click = onClick; v.rename = onRename; v.menuAction = onMenu; v.drag = onDrag; v.drop = onDrop
    }
    final class Pointer: NSView {
        var click: () -> Void = {}, rename: () -> Void = {}, drop: () -> Void = {}
        var menuAction: (NSView, CGPoint) -> Void = { _, _ in }
        var drag: (CGFloat) -> Void = { _ in }
        private var start: CGFloat = 0
        private var allowed = false
        private var moved = false
        override var mouseDownCanMoveWindow: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? {
            guard let hit = super.hitTest(point) else { return nil }
            let local = convert(point, from: superview)
            let event = NSApp.currentEvent
            let secondary = event?.type == .rightMouseDown || event?.modifierFlags.contains(.control) == true
            if local.x >= bounds.width - 28 && !secondary { return nil }
            return hit
        }
        override func mouseDown(with event: NSEvent) {
            if event.modifierFlags.contains(.control) { rightMouseDown(with: event); return }
            start = event.locationInWindow.x; moved = false
            allowed = TabOrder.canDrag(button: event.buttonNumber, clicks: event.clickCount, editing: false)
            if event.clickCount == 2 { rename() }
        }
        override func mouseDragged(with event: NSEvent) {
            guard allowed else { return }
            let dx = event.locationInWindow.x - start
            if moved || TabOrder.isDrag(dx) { moved = true; drag(dx) }
        }
        override func mouseUp(with event: NSEvent) {
            guard allowed else { return }
            allowed = false
            if moved { drop() } else { click() }
        }
        override func rightMouseDown(with event: NSEvent) {
            allowed = false; moved = false
            menuAction(self, convert(event.locationInWindow, from: nil))
        }
    }
}

/// The field editor commits on focus loss and Return; Escape leaves the package untouched.
private struct TabNameField: NSViewRepresentable {
    @Binding var text: String
    let finish: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(string: text)
        field.delegate = context.coordinator
        context.coordinator.field = field
        context.coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak coordinator = context.coordinator] event in
            if let field = coordinator?.field, event.window === field.window,
               !field.bounds.contains(field.convert(event.locationInWindow, from: nil)) {
                coordinator?.end(true)
            }
            return event
        }
        field.font = .systemFont(ofSize: 12, weight: .medium)
        field.drawsBackground = true
        field.isBordered = false
        field.focusRingType = .default
        DispatchQueue.main.async { field.window?.makeFirstResponder(field); field.selectText(nil) }
        return field
    }
    func updateNSView(_ field: NSTextField, context: Context) { context.coordinator.owner = self }
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var owner: TabNameField
        weak var field: NSTextField?
        var monitor: Any?
        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
        private var finished = false
        init(_ owner: TabNameField) { self.owner = owner }
        func end(_ save: Bool) {
            guard !finished else { return }
            finished = true
            owner.finish(save)
        }
        func controlTextDidChange(_ notification: Notification) {
            if let field = notification.object as? NSTextField { owner.text = field.stringValue }
        }
        func controlTextDidEndEditing(_ notification: Notification) { end(true) }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            if selector == #selector(NSResponder.cancelOperation(_:)) { end(false); return true }
            if selector == #selector(NSResponder.insertNewline(_:)) { end(true); return true }
            return false
        }
    }
}
