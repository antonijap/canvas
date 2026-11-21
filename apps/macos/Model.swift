// The studio's state as the native shell sees it. The page owns the canvas and posts a snapshot
// whenever something the chrome shows changes; the shell sends commands back.

import SwiftUI
import WebKit
import UniformTypeIdentifiers

struct Board: Identifiable {
    let id: String; var name: String; let width: Double?; let height: Double?
}
struct Component: Identifiable { let id: String; let name: String; let type: String; let isText: Bool; var board: String = ""; var instances = 0 }
struct TextStyle: Identifiable { let id = UUID(); let title: String; let count: Int; let color: Color? }
struct Variable: Identifiable { let id: String; let value: String; let isColor: Bool }
struct FileEntry: Identifiable, Equatable { var id: String { file }; let name: String; let file: String }
/// One of the document's pages (Canvas metadata; the file has none). `count` is how many boards it shows.
struct PageInfo: Identifiable, Equatable { let id: String; let name: String; let count: Int; var background: String? = nil }

/// The space between the layers of a smart selection (nil on an axis it does not run along).
struct SmartSpacing: Equatable {
    var x: Double?
    var y: Double?
    init(x: Double?, y: Double?) { self.x = x; self.y = y }
    init(_ d: [String: Any]) { x = (d["x"] as? NSNumber)?.doubleValue; y = (d["y"] as? NSNumber)?.doubleValue }
}

struct Selection {
    let id: String
    var node: [String: Any]
    let parentId: String?
    let isPath: Bool
    /// The size the canvas actually draws, for nodes whose width or height the file leaves to layout.
    var width: Double?
    var height: Double?
    /// An instance: the type its component draws as (a frame), so the panel shows the auto layout and Hug it inherits.
    var resolvedType: String? = nil
    /// A component, an instance, or a node inside one: the inspector and the selection paint purple.
    var isComponent = false
    /// What the server knows about the node: its main component, how many instances its component has.
    var context: ContextInfo?
    /// Every selected layer when there are several (`node` then holds the properties they share).
    var ids: [String] = []
    /// The variables the node's properties name, resolved in the node's own theme (as the canvas draws it).
    var tokens: [String: String] = [:]
    /// Several layers: the keys whose values differ between them ("Mixed" in the panel). Filled in once the
    /// layers have been read (CanvasModel.loadMixed); empty until then and for one layer.
    var mixed: Set<String> = []
    /// A layer inside a component instance: its look takes overrides (src/overrides.ts), its place comes from the component.
    var inInstance = false
    /// The node's props that are instance overrides ("descendants": overrides on layers inside it).
    var overrides: [String] = []
    /// Several layers: how many of them align, distribute and tidy up work with (not placed by auto layout, not
    /// inside an instance). Nil for one layer, or when the page did not say.
    var free: Int? = nil
}

enum RailSection: String, CaseIterable, Identifiable {
    // Text styles, variables and fonts share one Styles section (a switch at its top): fewer rail buttons, same lists.
    case boards = "Layers", components = "Components", styles = "Styles", widgets = "Widgets"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .boards: "square.3.layers.3d"
        case .components: "diamond"
        case .styles: "textformat"
        case .widgets: "square.grid.2x2"
        }
    }
}

func parseColor(_ s: String) -> Color? {
    guard s.hasPrefix("#") else { return nil }
    let h = String(s.dropFirst())
    guard h.count == 6 || h.count == 8, let v = UInt64(h, radix: 16) else { return nil }
    let hasAlpha = h.count == 8
    let r = Double((v >> (hasAlpha ? 24 : 16)) & 0xFF) / 255
    let g = Double((v >> (hasAlpha ? 16 : 8)) & 0xFF) / 255
    let b = Double((v >> (hasAlpha ? 8 : 0)) & 0xFF) / 255
    let a = hasAlpha ? Double(v & 0xFF) / 255 : 1
    return Color(.sRGB, red: r, green: g, blue: b, opacity: a)
}

/// The canvas's web view: every drag update over it tells the page whether Command is held (main.swift
/// syncDragCommand), so a Cmd-drop can fill the layer under the pointer.
final class CanvasWebView: WKWebView {
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { syncDragCommand(); return super.draggingEntered(sender) }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { syncDragCommand(); return super.draggingUpdated(sender) }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        syncDragCommand()
        let done = super.performDragOperation(sender)
        endDragCommand()
        return done
    }
    override func draggingExited(_ sender: NSDraggingInfo?) { super.draggingExited(sender); endDragCommand() }
}

final class CanvasModel: NSObject, ObservableObject, WKScriptMessageHandler {
    /// The shown tab's web view. Every command, key, snapshot and message goes to (or is taken from) this one;
    /// the other tabs' pages stay alive, hidden, in `live` (see "tabs" below).
    private(set) var webView: WKWebView
    /// Shared by every tab's web view: one set of script message handlers, one data store.
    let configuration: WKWebViewConfiguration
    /// main.swift gives each new web view its navigation delegate.
    var onNewWebView: ((WKWebView) -> Void)?
    /// The view the canvas sits in: it holds the shown tab's web view (Shell.swift).
    let tabHost = TabHostView()
    @Published var fileName = ""
    @Published var revision = ""
    @Published var boards: [Board] = []
    @Published var pages: [PageInfo] = []
    @Published var activePage: String?
    /// The board the selection is on: its row in the boards list shows as current.
    @Published var selectedBoard: String?
    @Published var components: [Component] = []
    @Published var styles: [TextStyle] = []
    @Published var variables: [Variable] = []
    /// The tokens library: variables by type then name family, text styles by family, with usage counts.
    @Published var tokenSections: [LibSection] = []
    @Published var styleEntries: [LibEntry] = []
    @Published var themes: [String] = []
    /// The library row whose usages are highlighted on the canvas and listed under it.
    @Published var activeUsage: String?
    @Published var usage: UsageState?
    /// Set by "Reveal in Boards list": the panel opens on Boards and scrolls to this board.
    @Published var revealBoardId: String?
    var usageLabel = ""
    @Published var zoom = 100
    /// Copy as: the latest request (an older answer that comes late is dropped) and whether it is still running.
    var copyToken = 0
    /// The zoom pill's field is open.
    @Published var zoomFieldOpen = false
    /// View > Pixel Grid and Rulers, as the page has them (src/page/navigate.js posts {view}).
    var pixelGrid = true
    var rulers = false
    /// View > Layout Guides (Control+G), as the page has it.
    var layoutGuides = true
    var copyBusy = false
    @Published var selection: Selection? {
        // A selected paint row belongs to the layers it was picked on (InspectorPaint.swift PaintRowSelection).
        didSet { if let p = paintRow, p.target != selectionKey { paintRow = nil } }
    }
    /// The fill, stroke or effect row picked in the inspector (the area left of its swatch): Cmd+C, Cmd+V,
    /// Delete and Esc go to it (PaintEditor.swift) until the canvas selection changes or a click lands elsewhere.
    @Published var paintRow: PaintRowSelection?
    /// Several evenly spaced layers selected (a smart selection, src/page/smart.js): the space between them across
    /// (x) and down (y); nil where it has none. The inspector's Spacing fields show it.
    @Published var smartSpacing: SmartSpacing?
    @Published var widgets: [WidgetInfo] = []
    @Published var widgetKinds: [WidgetKindInfo] = []
    /// The Paper Shaders library (PaperShaders.swift), fetched when the rail or a preset card first needs it.
    @Published var paperShaders: [PaperShaderInfo] = []
    @Published var selectedWidgetId: String?
    @Published var widgetStatus: WidgetStatus?
    @Published var section: RailSection? = .boards
    @Published var allFiles: [FileEntry] = []
    @Published var openFiles: [String] = UserDefaults.standard.stringArray(forKey: "canvas.openFiles") ?? []
    @Published var cloudFileNames: [String: String] = [:]
    @Published private(set) var isCloudFile = false
    @Published var cloudReadOnly = false
    @Published var currentFile: String?
    /// The Home tab is the shown one (Home.swift): the shown file's page stays alive underneath, hidden, and takes no keys.
    @Published var homeShown = false {
        didSet {
            guard homeShown != oldValue else { return }
            tabHost.isHidden = homeShown
            if homeShown { webView.window?.makeFirstResponder(nil) } else if let w = webView.window { w.makeFirstResponder(webView) }
        }
    }
    /// Files the app opens on its own (the first launch's course): not recents until the person opens them.
    var quietRecents = Set<String>()
    struct LivePerson: Identifiable { let id: String; let name: String; let role: String; let color: String }
    @Published var livePeople: [LivePerson] = []
    @Published var peopleStatus = "connected"
    @Published var bottomOverlay = CGRect.zero
    @Published var toast: String?
    @Published var toastKind: Toast.Kind = .plain
    /// The toast's buttons (Undo from the page, Ask agent on an error) and what a click on it copies (ToastLogic).
    @Published var toastActions: [ToastAction] = []
    @Published var toastCopy: String?
    /// The pointer is on the toast: it stays until the pointer leaves.
    var toastHovered = false { didSet { if !toastHovered && oldValue { scheduleToastEnd(after: 1500) } } }
    private var toastSeq = 0
    /// Claude Code or Codex is installed, so an error toast can offer Ask agent (/api/agent/harnesses).
    @Published var agentReady = false
    @Published var inspectorOpen = true
    @Published var commentsSidebarOpen = false
    /// The left panel is open (the rail's sidebar button; Rename opens it).
    @Published var panelOpen = true
    /// View > Hide UI: only the canvas and the tabs show.
    @Published var uiHidden = false
    /// The left panel's section per file: a tab keeps the one it showed (PanelMemory).
    private var sectionByFile: [String: RailSection?] = [:]
    /// The last drawn size of each layer, per file: a hidden Hug or Fill layer has no drawn box (KnownSize).
    private var knownSizes: [String: (Double?, Double?)] = [:]
    /// The document's next undo and redo steps ("Fill Change"), for the Edit menu. The page forwards the server's history.
    var undoLabel: String?
    var redoLabel: String?
    /// The last property edit Edit > Repeat can do again ("Fill Change", "Width +10"), from the server (src/repeat.ts).
    var repeatLabel: String?
    /// A text layer is being edited in place on the page (src/page/text-edit.js): Undo/Redo step through its typing,
    /// and the canvas commands (Duplicate, Group, Arrange, Delete) wait until the edit ends.
    var textEditing = false
    /// While a text layer is edited: the letters selected in it and their style ("mixed" where they differ), from the
    /// page (src/page/text-edit.js). The inspector shows that style and its text edits go to those letters.
    @Published var textRange: TextRangeState?
    /// Left panel width, dragged from its right edge and kept across launches.
    /// True while the edge is being dragged, so nothing animates the width.
    @Published var resizingSidebar = false
    @Published var sidebarWidth: CGFloat = SidebarSize.restore(UserDefaults.standard.double(forKey: "canvas.sidebarWidth"),
                                                               fallback: Metric.sidebarWidth, min: Metric.sidebarMin, max: Metric.sidebarMax) {
        didSet { UserDefaults.standard.set(Double(sidebarWidth), forKey: "canvas.sidebarWidth") }
    }
    /// The Home sidebar's width, dragged the same way and kept separately (Home.swift HomeMetric).
    @Published var homeSidebarWidth: CGFloat = SidebarSize.restore(UserDefaults.standard.double(forKey: "canvas.homeSidebarWidth"),
                                                                   fallback: HomeMetric.sidebar, min: HomeMetric.sidebarMin, max: HomeMetric.sidebarMax) {
        didSet { UserDefaults.standard.set(Double(homeSidebarWidth), forKey: "canvas.homeSidebarWidth") }
    }
    /// The board whose row in the boards list is being renamed.
    @Published var renamingBoard: String?
    /// Cmd+R with several layers: the Rename Layers sheet (Layers.swift BatchRenameLayer) for these ids, panel order.
    @Published var batchRename: [String]?
    /// Snapping and nudge settings (Settings > Canvas), kept in app settings and handed to the page.
    @Published var snap = SnapSettings.stored {
        didSet { snap.save(); pushSnap() }
    }
    /// Canvas > Settings (SettingsLogic.swift, Settings.swift): kept in UserDefaults, the page's part sent as
    /// {cmd: "prefs"} to every live tab, the server's part with the bridge state (Bridge.swift).
    @Published var prefs = AppSettings.load(.standard) {
        didSet {
            let c = prefs.clamped
            if c != prefs { prefs = c; return }
            guard prefs != oldValue else { return }
            // A changed list of Clouds is a newer revision: the server takes only the newest (src/cloud-config.ts).
            if prefs.clouds != oldValue.clouds && prefs.cloudsRev == oldValue.cloudsRev { prefs.cloudsRev += 1; return }
            prefs.save(.standard)
            pushPrefs(everywhere: true)
            if prefs.keptTabs != oldValue.keptTabs { evictTabs() }
        }
    }
    /// How much the board snapshots take (bytes), as the page last said; nil until asked (Settings > Performance).
    @Published var snapshotBytes: Int?
    @Published var theme = AppTheme.stored {
        didSet {
            UserDefaults.standard.set(theme.rawValue, forKey: "canvas.theme")
            NSApplication.shared.appearance = theme.appearance
        }
    }

    let base: URL
    let fonts = FontCatalog()
    /// The Edit menu's target (main.swift): the right-click menu sends its Cut/Copy/Paste/Group/Arrange items to it,
    /// so both menus run the same commands.
    var editTarget: NSObject?
    /// While the right-click menu on a layer is open: the page has just selected that layer, but its selection
    /// message may not have reached `selection` yet, and the edit items must not show disabled meanwhile.
    var contextOnLayer = false

    init(configuration: WKWebViewConfiguration, base: URL) {
        self.configuration = configuration
        self.webView = CanvasWebView(frame: .zero, configuration: configuration)
        self.base = base
        super.init()
        configuration.userContentController.add(self, name: "canvasState")
        NSApplication.shared.appearance = theme.appearance
        tabHost.show(webView)
        watchMemoryPressure()
    }

    // MARK: page -> shell

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the shown tab speaks for the window: a hidden one's selection, toasts or document are not on screen.
        guard message.webView === webView else { return }
        guard let text = message.body as? String, let data = text.data(using: .utf8),
              let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        DispatchQueue.main.async { self.apply(m) }
    }

    func apply(_ m: [String: Any]) {
        if let open = m["commentsSidebar"] as? Bool { commentsSidebarOpen = open }
        if m["cloudRemoved"] as? Bool == true, let file = currentFile { close(file); flash("Your access to this Cloud was removed"); return }
        if let file = m["file"] as? String, file != currentFile { noteOpened(file) }
        if m.keys.contains("cloudFile") {
            let cloud = m["cloudFile"] as? [String: Any]
            isCloudFile = cloud != nil
            cloudReadOnly = (cloud?["role"] as? String).map { $0 != "owner" && $0 != "editor" } ?? false
            if let file = currentFile, let name = cloud?["name"] as? String { cloudFileNames[file] = name }
        }
        if let z = m["zoom"] as? Double, let v = JSONNumber.int(z) { zoom = v }
        if m.keys.contains("selBoard") { selectedBoard = m["selBoard"] as? String }
        if let p = m["pages"] as? [String: Any] {
            pages = (p["list"] as? [[String: Any]] ?? []).compactMap { d in
                guard let id = d["id"] as? String else { return nil }
                return PageInfo(id: id, name: d["name"] as? String ?? id, count: (d["count"] as? NSNumber)?.intValue ?? 0, background: d["background"] as? String)
            }
            activePage = p["active"] as? String
        }
        // A toast may carry an icon (Copy Link's "link"), drawn in the text colour, and buttons (Undo) whose clicks go
        // back to the page as {cmd: "toastAction", id}.
        if let strip = m["peopleStrip"] as? [String: Any] {
            livePeople = (strip["people"] as? [[String: String]] ?? []).compactMap { p in
                guard let id = p["session"], let name = p["name"], let role = p["role"], let color = p["color"] else { return nil }
                return LivePerson(id: id, name: name, role: role, color: color)
            }
            peopleStatus = strip["status"] as? String ?? "connected"
        }
        if let p = m["bottomOverlay"] as? [String: Double], let x = p["x"], let y = p["y"], let width = p["width"] {
            bottomOverlay = CGRect(x: x - width / 2, y: y, width: width, height: 0)
        }
        if let msg = m["toast"] as? String {
            let acts = (m["toastActions"] as? [[String: Any]] ?? []).compactMap { a -> ToastAction? in
                guard let id = a["id"] as? String, let label = a["label"] as? String else { return nil }
                return ToastAction(id: id, label: label, symbol: nil) { [weak self] in self?.clearToast(); self?.run("{cmd:'toastAction',id:\(JSONText.string(id))}") }
            }
            flash(msg, durationMs: m["toastIcon"] as? String == "link" ? 2500 : 4000, level: m["toastIcon"] as? String, actions: acts)
        }
        // Copied layers and cards (src/page/structure.js, with clipText): their JSON under Canvas's own type, so another
        // tab, file or window can paste them, and their names as plain text, which is what another app (a chat, a
        // note) pastes. A link (src/page/link.js, no clipText) is plain text only.
        if let clip = m["clipboard"] as? String {
            let pb = canvasPasteboard
            pb.clearContents()
            if let names = m["clipText"] as? String {
                pb.declareTypes([.canvasClipboard, .string], owner: nil)
                pb.setString(clip, forType: .canvasClipboard)
                pb.setString(names, forType: .string)
            } else {
                pb.setString(clip, forType: .string)
            }
        }
        if m["snapHello"] != nil { pushSnap(); pushPrefs(); resendInsets() }
        if m["bottomOverlayReady"] != nil {
            setZoomCorner(frame: zoomCornerFrame)
            run("{cmd:'bottomToast',shown:\(toast != nil)}")
        }
        // The eyedropper key (I, src/page/shortcuts.js): sample the screen into the selection's fill (PaintEditor.swift).
        if m["eyedropper"] != nil { eyedropFill() }
        // Option+L on the canvas (src/page/shortcuts.js): the Layers panel closes every open row.
        if m["layers"] as? String == "collapseAll" { LayersStore.of(self).collapseAll() }
        if let n = m["snapshotBytes"] as? NSNumber { snapshotBytes = n.intValue }
        if let h = m["history"] as? [String: Any] { undoLabel = h["undo"] as? String; redoLabel = h["redo"] as? String; repeatLabel = h["repeat"] as? String }
        if let t = m["textEditing"] as? Bool { textEditing = t; if !t { textRange = nil } }
        if m.keys.contains("textRange") { textRange = (m["textRange"] as? [String: Any]).flatMap(TextRangeState.init) }
        if m.keys.contains("context"), let c = m["context"] as? [String: Any] {
            let at = CGPoint(x: (c["x"] as? NSNumber)?.doubleValue ?? 0, y: (c["y"] as? NSNumber)?.doubleValue ?? 0)
            if let t = (c["target"] as? [String: Any]).flatMap(ContextInfo.init) { showContextMenu(at: at, for: t, under: UnderLayer.list(c["under"])) }
            else if c["canvas"] as? Bool == true { showCanvasMenu(at: at) }
        }
        if m.keys.contains("usage") { applyUsage(m["usage"] as? [String: Any]) }
        if let v = m["view"] as? [String: Any] { pixelGrid = v["pixelGrid"] as? Bool ?? pixelGrid; rulers = v["rulers"] as? Bool ?? rulers; layoutGuides = v["layoutGuides"] as? Bool ?? layoutGuides }
        if let files = m["files"] as? [[String: Any]] {
            allFiles = files.compactMap { f in
                guard let n = f["name"] as? String, let p = f["file"] as? String else { return nil }
                return FileEntry(name: n, file: p)
            }
        }
        if let list = m["widgets"] as? [[String: Any]] {
            widgets = list.compactMap(WidgetInfo.init)
            if let id = selectedWidgetId, !widgets.contains(where: { $0.id == id }) { selectedWidgetId = nil; widgetStatus = nil }
        }
        if m.keys.contains("smart") { smartSpacing = (m["smart"] as? [String: Any]).map(SmartSpacing.init) }
        if m.keys.contains("selection") {
            if let s = m["selection"] as? [String: Any], let node = s["node"] as? [String: Any] {
                let ctx = (s["ctx"] as? [String: Any]).flatMap(ContextInfo.init)
                let ids = s["ids"] as? [String] ?? []
                // The same layers again (a property changed): keep what is known about which values differ.
                let keepMixed = ids.count > 1 && selection?.ids == ids ? selection?.mixed ?? [] : []
                let sid = s["id"] as? String ?? ""
                let sizeKey = (currentFile ?? "") + "\u{1F}" + sid
                var w = (s["w"] as? NSNumber)?.doubleValue, h = (s["h"] as? NSNumber)?.doubleValue
                if w != nil || h != nil { knownSizes[sizeKey] = (w, h) }
                else if let k = knownSizes[sizeKey] { w = KnownSize.pick(drawn: w, known: k.0); h = KnownSize.pick(drawn: h, known: k.1) }
                selection = Selection(id: sid, node: node, parentId: s["parentId"] as? String, isPath: s["path"] as? Bool ?? false,
                                      width: w, height: h, resolvedType: s["rtype"] as? String,
                                      isComponent: (s["cmp"] as? Bool ?? false) || (ctx?.purple ?? false), context: ctx,
                                      ids: ids, tokens: s["tokens"] as? [String: String] ?? [:], mixed: keepMixed,
                                      inInstance: s["inst"] as? Bool ?? false, overrides: s["overrides"] as? [String] ?? [],
                                      free: (s["free"] as? NSNumber)?.intValue)
                if ids.count > 1 { loadMixed(ids, shared: node) }
                selectedWidgetId = nil; widgetStatus = nil
            } else {
                selection = nil
                let id = (m["widget"] as? [String: Any])?["id"] as? String
                if id != selectedWidgetId { widgetStatus = nil }
                selectedWidgetId = id
            }
        }
        if m.keys.contains("widgetStatus") {
            if let st = m["widgetStatus"] as? [String: Any], let w = WidgetStatus(st), w.id == selectedWidgetId { widgetStatus = w }
            else if m["widgetStatus"] is NSNull { widgetStatus = nil }
        }
        guard let doc = m["doc"] as? [String: Any] else { return }
        fileName = doc["name"] as? String ?? fileName
        revision = doc["revision"] as? String ?? ""
        boards = (doc["boards"] as? [[String: Any]] ?? []).map {
            Board(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? ($0["id"] as? String ?? ""),
                  width: ($0["width"] as? NSNumber)?.doubleValue, height: ($0["height"] as? NSNumber)?.doubleValue)
        }
        components = (doc["components"] as? [[String: Any]] ?? []).map {
            Component(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? ($0["type"] as? String ?? ""),
                      type: $0["type"] as? String ?? "", isText: $0["isText"] as? Bool ?? false,
                      board: $0["board"] as? String ?? "", instances: ($0["instances"] as? NSNumber)?.intValue ?? 0)
        }
        if let t = doc["tokens"] as? [String: Any] { applyTokens(t) }
        styles = (doc["styles"] as? [[String: Any]] ?? []).prefix(14).map {
            let p = $0["props"] as? [String: Any] ?? [:]
            let title = "\(p["fontFamily"] ?? "") \(p["fontSize"] ?? "")/\(p["fontWeight"] ?? "")"
            return TextStyle(title: title, count: ($0["count"] as? NSNumber)?.intValue ?? 0, color: (p["fill"] as? String).flatMap(parseColor))
        }
        variables = (doc["variables"] as? [String: Any] ?? [:]).map { name, def in
            let d = def as? [String: Any]
            var value = d?["value"] ?? def
            // A themed variable holds one value per theme; the first stands in where a single swatch is shown.
            if let themed = value as? [[String: Any]], let first = themed.first?["value"] { value = first }
            return Variable(id: name, value: "\(value)", isColor: (d?["type"] as? String) == "color")
        }.sorted { $0.id < $1.id }
    }

    // MARK: files

    private func noteOpened(_ file: String) {
        // A file change the shell did not start (Finder, the bridge, the page itself) drops the old selection too;
        // a selection in this same message is applied after this.
        if currentFile != nil { clearDocumentState() }
        let m = PanelMemory.next(sectionByFile, leaving: currentFile, current: section, opening: file)
        sectionByFile = m.saved
        if let r = m.section { section = r }
        isCloudFile = false
        cloudReadOnly = false
        currentFile = file
        if widgetKinds.isEmpty { fetchKinds() }
        UserDefaults.standard.set(file, forKey: "canvas.lastFile")
        if !openFiles.contains(file) { openFiles.append(file) }
        if openFiles.count > 40 { openFiles.removeFirst(openFiles.count - 40) }
        UserDefaults.standard.set(openFiles, forKey: "canvas.openFiles")
        if quietRecents.remove(file) == nil { MainActor.assumeIsolated { HomeStore.shared.touch(file) } }
    }

    /// A tab dragged to a new place in the strip: the order is saved, and `list_tabs` reports it.
    func moveTab(_ file: String, to index: Int) {
        guard let i = openFiles.firstIndex(of: file) else { return }
        let moved = TabOrder.move(openFiles, from: i, to: index)
        guard moved != openFiles else { return }
        openFiles = moved
        UserDefaults.standard.set(openFiles, forKey: "canvas.openFiles")
    }

    /// Shift+Cmd+[ and ]: the previous or next tab in the strip's order, Home first.
    func stepTab(forward: Bool) {
        guard let to = TabOrder.step(openFiles, current: currentFile, homeShown: homeShown, forward: forward) else { return }
        if let f = to { openTab(f) } else { showHome() }
    }

    func name(of file: String) -> String {
        cloudFileNames[file] ?? allFiles.first { $0.file == file }?.name ?? URL(fileURLWithPath: file).deletingPathExtension().lastPathComponent
    }

    /// MCP quiet open adds a tab without changing the document, selection, Home or window focus.
    /// Hidden tabs have no connected bridge; live tools can report no_page until the person shows one.
    func openQuietly(_ file: String) {
        guard !openFiles.contains(file), DocURL.page(base: base, file: file) != nil else { return }
        openFiles.append(file)
        UserDefaults.standard.set(openFiles, forKey: "canvas.openFiles")
    }

    func open(_ file: String) {
        // Obsidian's JSON Canvas files share the extension; Canvas documents are folders.
        var isDir: ObjCBool = false
        if file.hasSuffix(".canvas"), FileManager.default.fileExists(atPath: file, isDirectory: &isDir), !isDir.boolValue {
            flash("\(URL(fileURLWithPath: file).lastPathComponent) is a plain file (Obsidian's), not a Canvas document.")
            return
        }
        guard let url = DocURL.page(base: base, file: file) else { return }
        homeShown = false
        // Opening a file on purpose (a card, Open, a tab) is "last opened", even when its tab already shows it.
        if !quietRecents.contains(file) { MainActor.assumeIsolated { HomeStore.shared.touch(file) } }
        let opening = !openFiles.contains(file)
        show(file, url: url)
        // Usage counts: a document opened in a tab (not a switch to one already open), and the Welcome course.
        if opening {
            UsageCount.send("file.open", to: base)
            if URL(fileURLWithPath: file).lastPathComponent == "Welcome.canvas" { UsageCount.send("course.opened", to: base) }
        }
    }

    // MARK: tabs

    /// One web view per open tab, by file ("" is the empty page). Switching back to a tab shows its page as it was
    /// (engine, laid-out boards, GPU tiles) instead of loading it again. At most TabPool.keep stay alive, fewer when
    /// macOS is short of memory; a tab let go loads again when it is shown. `liveOrder`: least recently shown first.
    private var live: [String: WKWebView] = [:]
    private var liveOrder: [String] = []
    /// The key of `webView` in `live`; nil until the first page is shown.
    private var activeKey: String?
    /// Web views whose page has to load again when shown (its web content process ended while hidden).
    private var staleViews = Set<ObjectIdentifier>()
    private var pressure: DispatchSourceMemoryPressure?

    /// How many tabs have a live page (the shown one included).
    var liveTabCount: Int { live.count }
    func isLive(_ file: String) -> Bool { live[file] != nil && !staleViews.contains(ObjectIdentifier(live[file]!)) }
    /// The web content process of a tab's live page (WKWebView's private `_webProcessIdentifier`), for the memory
    /// each kept tab costs (list_tabs).
    func webContentPid(_ file: String) -> Int? {
        guard let wv = live[file], wv.responds(to: NSSelectorFromString("_webProcessIdentifier")),
              let n = wv.value(forKey: "_webProcessIdentifier") as? NSNumber, n.int32Value > 0 else { return nil }
        return n.intValue
    }

    /// Shows a page in place of the current one, once the text being edited on the canvas is written: the page
    /// going away (or out of sight) must not hold typing that exists nowhere else. A text that could not be saved
    /// keeps the page shown with a message; the next try goes anyway (the typing is on the clipboard by then).
    private var loadToken = 0
    private var textSaveFailed = false
    func show(_ key: String, url: URL) {
        loadToken += 1
        let token = loadToken
        flushTextEdit { ok in
            guard token == self.loadToken else { return } // another load since: that one wins
            if !ok && !self.textSaveFailed {
                self.textSaveFailed = true
                self.flash("Canvas could not save the text you were typing, so this file stayed open. Try again to leave it anyway.")
                return
            }
            self.textSaveFailed = false
            self.switchTo(key, url: url)
        }
    }

    private func switchTo(_ key: String, url: URL) {
        let old = webView, oldKey = activeKey
        if key == oldKey, live[key] === old {
            // The shown tab: it loads only when it never did (or its page is gone).
            if old.url == nil || staleViews.contains(ObjectIdentifier(old)) { staleViews.remove(ObjectIdentifier(old)); old.load(URLRequest(url: url)) }
            return
        }
        // The page going out of sight is photographed for its card on Home (it must be in the window to be drawn).
        if let k = oldKey, !k.isEmpty, !homeShown, !boards.isEmpty { saveThumbnail(of: old, file: k) }
        // The inspector must never write the old document's selection into the new one (same node ids).
        clearDocumentState()
        // The panels show nothing (not the old tab's pages and layers) until the new tab's page reports its state.
        clearSidebarState()
        var wv = live[key]
        var fresh = wv == nil || staleViews.contains(ObjectIdentifier(wv!))
        if wv == nil {
            // The first page of the app (nothing loaded yet) takes the web view that is already in the window.
            if old.url == nil, oldKey == nil || live[oldKey!] === old {
                if let k = oldKey { live[k] = nil; liveOrder.removeAll { $0 == k } }
                wv = old
            } else {
                wv = CanvasWebView(frame: .zero, configuration: configuration)
                onNewWebView?(wv!)
            }
            live[key] = wv
            fresh = true
        }
        let next = wv!
        staleViews.remove(ObjectIdentifier(next))
        let hadFocus = (old.window?.firstResponder as? NSView)?.isDescendant(of: old) ?? false
        webView = next
        activeKey = key
        liveOrder = TabPool.touch(liveOrder, key)
        if old !== next {
            // The empty page and a closed tab are not worth keeping; any other leaves its page alive, its streams closed (the page
            // reopens them and catches up with the document when it is shown again).
            if let k = oldKey, k.isEmpty || !openFiles.contains(k) { drop(k) } else { tabActive(old, false) }
        }
        tabHost.show(next)
        if hadFocus || next.window?.firstResponder === next.window { next.window?.makeFirstResponder(next) }
        if fresh {
            next.load(URLRequest(url: url))
        } else {
            if !key.isEmpty { noteOpened(key) }
            tabActive(next, true)
            // The page tells the shell everything the chrome shows again: document, pages, selection, zoom, history.
            run("{cmd:'resync'}")
            resendInsets()
        }
        evictTabs()
        objectWillChange.send()
    }

    /// The page's streams follow whether its tab is shown (src/server.ts "tab"): a hidden tab holds no connection.
    private func tabActive(_ wv: WKWebView, _ on: Bool) {
        wv.evaluateJavaScript("window.canvasCmd && window.canvasCmd({cmd:'tab',active:\(on)})")
    }

    /// Lets go of a hidden tab's page: it loads again when the tab is shown.
    private func drop(_ key: String) {
        guard let wv = live[key], wv !== webView else { return }
        live[key] = nil
        liveOrder.removeAll { $0 == key }
        staleViews.remove(ObjectIdentifier(wv))
        wv.stopLoading()
        wv.navigationDelegate = nil
        wv.removeFromSuperview()
        // Blank first, so the page's scripts and GPU work end now rather than whenever WebKit frees the view.
        wv.loadHTMLString("", baseURL: nil)
    }

    private func evictTabs() {
        for k in TabPool.evict(order: liveOrder, active: activeKey, keep: prefs.keptTabs) { drop(k) }
    }

    /// A hidden tab's web content process ended (a crash, or WebKit reclaimed it): it loads again when shown.
    func hiddenPageGone(_ wv: WKWebView) {
        guard wv !== webView else { return }
        staleViews.insert(ObjectIdentifier(wv))
    }

    private func watchMemoryPressure() {
        let src = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        src.setEventHandler { [weak self, weak src] in
            guard let self, let src else { return }
            let critical = src.data.contains(.critical)
            for k in TabPool.onPressure(order: self.liveOrder, active: self.activeKey, critical: critical) { self.drop(k) }
        }
        src.resume()
        pressure = src
    }

    /// Reload Page (Cmd+R): the text being edited is written first, like any other way off the page.
    func reloadPage() {
        flushTextEdit { _ in self.webView.reload() }
    }

    /// Ends the text edit on the canvas (if one is open) and waits for every text write the page has out
    /// (src/page/text-edit.js flush). `done(true)` when they are saved or there is nothing to save; `done(false)`
    /// when one failed or the page did not answer within `timeout`.
    func flushTextEdit(timeout: TimeInterval = 5, _ done: @escaping (Bool) -> Void) {
        var answered = false
        let finish = { (ok: Bool) in
            guard !answered else { return }
            answered = true
            done(ok)
        }
        let js = "const t = window.canvasHost && window.canvasHost.textEdit; return t && t.flush ? await t.flush() : true;"
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let v): finish((v as? Bool) ?? (v as? NSNumber)?.boolValue ?? true)
                case .failure: finish(true) // no page, or a page without the editor: nothing is being typed
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(false) }
    }

    /// Everything that belongs to one document: dropped when another loads, so no edit can reach the wrong file.
    /// The lists the left panel shows, emptied: the shown tab's page fills them again (apply, or resync).
    func clearSidebarState() {
        commentsSidebarOpen = false
        boards = []; pages = []; activePage = nil; components = []; styles = []; variables = []; tokenSections = []; styleEntries = []; widgets = []; revision = ""
        selectedBoard = nil
    }

    func clearDocumentState() {
        selection = nil; selectedWidgetId = nil; widgetStatus = nil; selectedBoard = nil; renamingBoard = nil
        activeUsage = nil; usage = nil; gestureTarget = nil
        // A page that went away mid-edit never says the edit ended: Undo would stay "Undo Typing" and Delete,
        // Group and Arrange stay off.
        textEditing = false
        textRange = nil
        docGeneration += 1
    }

    /// Bumped whenever the shown document changes (or reloads into another): work started for one document
    /// (a deferred Undo) checks it before acting.
    private(set) var docGeneration = 0

    /// What the inspector edits right now, as one string (file and selected ids): a colour picker or eyedropper
    /// that finishes later compares it with the one it opened for.
    var selectionKey: String? {
        guard let f = currentFile else { return nil }
        if let w = selectedWidgetId { return f + "\u{1F}widget:" + w }
        guard let s = selection else { return nil }
        return ([f, s.id] + s.ids).joined(separator: "\u{1F}")
    }

    /// Several layers selected: reads each one (as the page's own "N selected" panel does) to learn which
    /// properties differ, so their fields show "Mixed" instead of a default.
    private func loadMixed(_ ids: [String], shared: [String: Any]) {
        guard let file = currentFile else { return }
        let list = Array(ids.filter { !$0.hasPrefix("widget:") }.prefix(200))
        let group = DispatchGroup()
        let lock = NSLock()
        var nodes: [[String: Any]] = []
        for id in list {
            guard var c = URLComponents(url: base.appendingPathComponent("api/node"), resolvingAgainstBaseURL: false) else { continue }
            c.setQuery([URLQueryItem(name: "file", value: file), URLQueryItem(name: "id", value: id), URLQueryItem(name: "depth", value: "0")])
            guard let url = c.url else { continue }
            group.enter()
            URLSession.shared.dataTask(with: url) { data, response, _ in
                if (response as? HTTPURLResponse)?.statusCode == 200,
                   let obj = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                   let n = obj["node"] as? [String: Any] {
                    lock.lock(); nodes.append(n); lock.unlock()
                }
                group.leave()
            }.resume()
        }
        group.notify(queue: .main) {
            guard self.currentFile == file, self.selection?.ids == ids else { return }
            self.selection?.mixed = MixedKeys.of(nodes, shared: shared)
            self.mixedNodes = Dictionary(nodes.compactMap { n in (n["id"] as? String).map { ($0, n) } }, uniquingKeysWith: { a, _ in a })
        }
    }

    /// A tab whose file no longer exists on disk (moved, renamed or deleted).
    func isMissing(_ file: String) -> Bool { !FileManager.default.fileExists(atPath: file) }

    /// A tab click. A missing file never loads a broken page: it says so and offers Locate… or Close Tab.
    func openTab(_ file: String) {
        guard isMissing(file) else { open(file); return }
        let alert = NSAlert()
        alert.messageText = "\u{201C}\(URL(fileURLWithPath: file).lastPathComponent)\u{201D} was not found"
        alert.informativeText = "It was moved, renamed or deleted:\n\(file)"
        alert.addButton(withTitle: "Locate\u{2026}")
        alert.addButton(withTitle: "Close Tab")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn: locate(file)
        case .alertSecondButtonReturn: close(file)
        default: break
        }
    }

    /// Points a missing tab at the file's new place and opens it there.
    func locate(_ file: String) {
        let panel = NSOpenPanel()
        panel.title = "Locate \(URL(fileURLWithPath: file).lastPathComponent)"
        panel.allowedContentTypes = [Self.canvasType]
        panel.directoryURL = URL(fileURLWithPath: file).deletingLastPathComponent()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        openFiles = TabList.replacing(openFiles, file, with: url.path)
        UserDefaults.standard.set(openFiles, forKey: "canvas.openFiles")
        MainActor.assumeIsolated { HomeStore.shared.replace(file, with: url.path) }
        open(url.path)
    }

    // MARK: documents (.canvas packages)

    static let canvasType = UTType("cc.getcanvas.canvas.document") ?? UTType(filenameExtension: "canvas") ?? .package

    private func post(_ path: String, _ body: [String: Any], done: @escaping (String?, String?) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok ? obj?["file"] as? String : nil, ok ? nil : (obj?["error"] as? String ?? "The server did not answer")) }
        }.resume()
    }

    private func savePanel(title: String, name: String) -> URL? {
        let panel = NSSavePanel()
        panel.title = title
        panel.allowedContentTypes = [Self.canvasType]
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        return panel.runModal() == .OK ? panel.url : nil
    }

    func newCanvas() {
        if homeShown, let entry = CloudAccount.shared.entry(self, id: HomeStore.shared.section.cloudId), entry.kind != .server {
            CloudAccount.shared.newFile(self, in: entry)
            return
        }
        guard let url = savePanel(title: "New Canvas", name: "Untitled.canvas") else { return }
        post("api/canvas/new", ["target": url.path]) { file, error in
            if let file { self.open(file) } else { self.flash(error ?? "Could not create the document") }
        }
    }

    func openDocument() {
        let panel = NSOpenPanel()
        panel.title = "Open"
        panel.allowedContentTypes = [Self.canvasType]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.treatsFilePackagesAsDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        open(url.path)
    }

    func renameFile(_ file: String, to raw: String) {
        guard let name = TabRename.name(raw) else { flash("Choose a name without slashes or a leading dot"); return }
        flushTextEdit { ok in
            guard ok else { return }
            self.afterWrites {
                self.post("api/canvas/rename", ["file": file, "name": name]) { renamed, error in
                    guard let renamed else { self.flash(error ?? "Could not rename the file"); return }
                    guard renamed != file else { return }
                    if self.openFiles.contains(file) {
                        self.openFiles = TabList.replacing(self.openFiles, file, with: renamed)
                        UserDefaults.standard.set(self.openFiles, forKey: "canvas.openFiles")
                    }
                    self.allFiles = self.allFiles.map { $0.file == file ? FileEntry(name: URL(fileURLWithPath: renamed).deletingPathExtension().lastPathComponent, file: renamed) : $0 }
                    self.sectionByFile[renamed] = self.sectionByFile.removeValue(forKey: file)
                    MainActor.assumeIsolated { HomeStore.shared.replace(file, with: renamed) }
                    if self.currentFile == file {
                        self.currentFile = renamed
                        self.fileName = URL(fileURLWithPath: renamed).deletingPathExtension().lastPathComponent
                        UserDefaults.standard.set(renamed, forKey: "canvas.lastFile")
                        self.live[renamed] = self.live.removeValue(forKey: file)
                        self.liveOrder = self.liveOrder.map { $0 == file ? renamed : $0 }
                        self.activeKey = renamed
                        if let url = DocURL.page(base: self.base, file: renamed) { self.webView.load(URLRequest(url: url)) }
                    } else { self.drop(file) }
                }
            }
        }
    }

    func duplicateFile(_ file: String) {
        let source = URL(fileURLWithPath: file)
        let stem = source.deletingPathExtension().lastPathComponent + " copy"
        var n = 1
        var target: URL
        repeat {
            target = source.deletingLastPathComponent().appendingPathComponent(stem + (n == 1 ? "" : " \(n)") + ".canvas")
            n += 1
        } while FileManager.default.fileExists(atPath: target.path)
        let path = target.path
        flushTextEdit { ok in
            guard ok else { return }
            self.afterWrites {
                self.post("api/canvas/save-as", ["file": file, "target": path]) { saved, error in
                    if let saved { self.open(saved) } else { self.flash(error ?? "Could not duplicate the file") }
                }
            }
        }
    }

    func closeOtherTabs(_ file: String) {
        for other in openFiles where other != file { close(other) }
        openTab(file)
    }

    func saveAsCanvas() {
        guard let file = currentFile else { flash("Open a design first."); return }
        guard let url = savePanel(title: "Save as Canvas", name: name(of: file) + ".canvas") else { return }
        // Inspector edits still waiting in the queue, and the text being typed on the canvas, are part of the
        // document: the copy waits for them.
        flushTextEdit { _ in self.afterWrites {
            self.post("api/canvas/save-as", ["file": file, "target": url.path]) { saved, error in
                if let saved { self.open(saved) } else { self.flash(error ?? "Could not save the document") }
            }
        } }
    }

    func close(_ file: String) {
        guard let i = openFiles.firstIndex(of: file) else { return }
        openFiles.remove(at: i)
        Task { _ = await CloudAccount.post(self, "api/cloud/files/close", ["file": file]) }
        UserDefaults.standard.set(openFiles, forKey: "canvas.openFiles")
        drop(file) // a hidden tab's page goes with it (the shown one goes once another is shown)
        guard file == currentFile else { return }
        // Closing a tab while Home is showing leaves Home showing.
        let wasHome = homeShown
        defer { if wasHome { homeShown = true } }
        // The next tab that still exists on disk; a missing one would load a broken page.
        let after = openFiles[min(i, openFiles.count)...] + openFiles[..<min(i, openFiles.count)].reversed()
        if let next = after.first(where: { !isMissing($0) }) {
            open(next)
        } else {
            snapshotShown()
            currentFile = nil
            UserDefaults.standard.removeObject(forKey: "canvas.lastFile")
            clearDocumentState()
            clearSidebarState()
            // The empty page stays inside the native shell (no browser sidebar under the SwiftUI chrome).
            showEmpty()
        }
    }

    /// The empty page (no file open). It stays inside the native shell (no browser sidebar under the SwiftUI chrome).
    func showEmpty() {
        homeShown = true // nothing is open: Home is the screen
        if let url = DocURL.page(base: base, file: nil) { show("", url: url) }
    }

    // MARK: manual edits

    /// Writes properties to the selected node through the server (the same path the MCP tools use). The canvas
    /// draws the edit in its next frame from its own copy of the board (src/page/live.js): the page gets the
    /// edit before the write goes out, and hears when the write answered. A scrub's in-between values are
    /// previews (EditGesture.previewOnly): drawn at display rate, not written; the throttled writes and the
    /// final value carry them. One write per node is in flight at a time and edits that arrive meanwhile merge
    /// into the next one: a big file takes a few hundred ms per write, and a 30 Hz scrub used to queue seconds.
    private var gestureTarget: (gesture: String, node: String)?
    /// `ids` set: one write to several selected layers (no page preview, so no editDone).
    /// `each`: a value per layer (a Mixed step); `drawn`: the page drew it first and waits for editDone; `failed`:
    /// what to undo locally when the write fails (the Layers panel's own copy).
    private struct PendingWrite {
        var file: String; var id: String; var ids: [String]? = nil; var props: [String: Any]; var remove: [String]; var gesture: String?; var op: Int
        var each: [String: [String: Any]]? = nil
        /// Keys changed from the layer's own value ({key: {op, by}}): Edit > Repeat does the same change (src/repeat.ts).
        var rel: [String: Any]? = nil
        var drawn = true
        var failed: [() -> Void] = []
    }
    private var editOp = 0
    private var writes = WriteQueue<PendingWrite>()
    private var afterWritesQueue: [() -> Void] = []
    /// A write failed while something waited for the queue to drain (Quit).
    private var drainFailed = false

    /// Each selected layer's own properties while several are selected (read by loadMixed).
    private var mixedNodes: [String: [String: Any]] = [:]

    /// Up/Down in a "Mixed" field: every selected layer steps `key` from its own value. One write per
    /// layer under one gesture id; `fallback` is the value a layer without the key has.
    func stepEach(_ key: String, by d: Double, fallback: Double = 0, min lo: Double? = nil, max hi: Double? = nil) {
        guard let s = selection, s.ids.count > 1, !s.isPath, let file = currentFile else { return }
        writeEach(file: file, key: key, MixedStep.stepWrites(nodes: mixedNodes, ids: s.ids, key: key, delta: d, fallback: fallback, min: lo, max: hi),
                  rel: [key: ["op": "+", "by": d]])
    }

    /// Each layer's own value for one key in one write and one undo step (/api/update `each`).
    private func writeEach(file: String, key: String, _ list: [(id: String, value: Any)], rel: [String: Any]? = nil) {
        guard !list.isEmpty else { return }
        var each: [String: [String: Any]] = [:]
        for w in list { mixedNodes[w.id]?[key] = w.value; each[w.id] = [key: w.value] }
        let ids = list.map(\.id)
        editOp += 1
        queueWrite(PendingWrite(file: file, id: ids.joined(separator: "\u{1E}"), ids: ids, props: [:], remove: [], gesture: nil, op: editOp, each: each, rel: rel))
    }

    func update(_ props: [String: Any], remove: [String] = []) {
        guard let s = selection, let file = currentFile else { return }
        // Letters selected in the text being edited: the text style goes to them, the page writes it with the edit.
        if textEditing, let r = textRange, r.id == s.id, TextRangeState.takes(props, remove: remove),
           let data = try? JSONSerialization.data(withJSONObject: ["cmd": "textStyle", "props": props]), let js = String(data: data, encoding: .utf8) {
            if !EditGesture.previewOnly { run(js) }
            return
        }
        if s.isPath { flash("This node lives inside a component instance; edit the component."); return }
        let rel = RepeatHint.single(EditGesture.relative, props: props, node: s.node)
        if s.ids.count > 1 { updateMany(s, file: file, props, remove, rel: rel); return }
        if let g = EditGesture.current {
            // A drag belongs to the node it started on: a late write after the selection moved is dropped.
            if gestureTarget?.gesture == g, gestureTarget?.node != s.id { return }
            if gestureTarget?.gesture != g { gestureTarget = (g, s.id) }
        }
        if EditGesture.previewOnly { pageEdit(s.id, props, remove, op: 0); return }
        var node = s.node
        for (k, v) in props { node[k] = v }
        for k in remove { node.removeValue(forKey: k) }
        selection?.node = node
        editOp += 1
        pageEdit(s.id, props, remove, op: editOp)
        queueWrite(PendingWrite(file: file, id: s.id, props: props, remove: remove, gesture: EditGesture.current, op: editOp, rel: rel))
    }

    /// Several layers selected ("N selected", src/page/structure.js): the same props on each, one write and one
    /// undo step on the server; the canvas redraws from the document event. Previews are not drawn. The write
    /// goes through the same queue as a single node's (one in flight per selection, later values merged in), so
    /// a scrub's older value never lands last and Undo (afterWrites) waits for it.
    private func updateMany(_ s: Selection, file: String, _ props: [String: Any], _ remove: [String], rel: [String: Any]? = nil) {
        if EditGesture.previewOnly { return }
        var node = s.node
        for (k, v) in props { node[k] = v }
        for k in remove { node.removeValue(forKey: k) }
        selection?.node = node
        editOp += 1
        queueWrite(PendingWrite(file: file, id: s.ids.joined(separator: "\u{1E}"), ids: s.ids, props: props, remove: remove, gesture: EditGesture.current, op: editOp, rel: rel))
    }

    /// The page draws an edit now (op 0: a preview no write carries yet).
    private func pageEdit(_ id: String, _ props: [String: Any], _ remove: [String], op: Int) {
        var msg: [String: Any] = ["cmd": "edit", "id": id, "props": props, "remove": remove]
        if op == 0 { msg["preview"] = true } else { msg["op"] = op }
        guard let data = try? JSONSerialization.data(withJSONObject: msg), let js = String(data: data, encoding: .utf8) else { return }
        run(js)
    }

    private func queueWrite(_ w: PendingWrite) {
        let key = w.file + "\u{1F}" + w.id
        // The nodes it touches: a write to A waits for an earlier one to A+B, and the other way round.
        let nodes = Set((w.ids ?? [w.id]).map { w.file + "\u{1F}" + $0 })
        for (k, now) in writes.add(key, nodes: nodes, w, merge: Self.merge) { sendWrite(k, now) }
    }

    /// Later values win per property; a property set again is no longer removed, and the other way round.
    private static func merge(_ q: inout PendingWrite, _ w: PendingWrite) {
        if let e = w.each { var all = q.each ?? [:]; for (id, p) in e { all[id, default: [:]].merge(p) { _, b in b } }; q.each = all }
        q.failed += w.failed
        for k in w.remove { q.props.removeValue(forKey: k) }
        q.remove = q.remove.filter { w.props[$0] == nil } + w.remove.filter { !q.remove.contains($0) }
        for (k, v) in w.props { q.props[k] = v }
        q.gesture = w.gesture ?? q.gesture
        q.rel = RepeatHint.merge(q.rel, w.rel, keys: Array(w.props.keys) + (w.each?.values.flatMap(\.keys) ?? []) + w.remove)
        q.op = w.op
    }

    private func sendWrite(_ key: String, _ w: PendingWrite) {
        var req = URLRequest(url: base.appendingPathComponent("api/update"))
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["file": w.file, "props": w.props, "remove": w.remove]
        if let ids = w.ids { body["ids"] = ids } else { body["id"] = w.id }
        if let e = w.each { body["each"] = e }
        if let r = w.rel, !r.isEmpty { body["rel"] = r }
        // A scrub's writes share a gesture id, so the server keeps the whole drag as one undo step.
        if let g = w.gesture { body["gesture"] = g }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let msg = ok ? nil : (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["error"] as? String
            DispatchQueue.main.async {
                // The page that drew the edit lets go of it (or takes it back, when the write failed).
                if self.currentFile == w.file, w.ids == nil, w.drawn { self.run("{cmd:'editDone',id:\(jsString(w.id)),op:\(w.op),ok:\(ok)}") }
                if !ok { self.flash(msg ?? "Could not save the change"); self.drainFailed = true; w.failed.forEach { $0() } }
                for (k, next) in self.writes.answered(key) { self.sendWrite(k, next) }
                if self.writes.isIdle { let f = self.afterWritesQueue; self.afterWritesQueue = []; f.forEach { $0() } }
            }
        }.resume()
    }

    /// A write to one layer that is not the selection (the Layers panel's rename and eye): it goes through the same
    /// queue, so Undo and Quit wait for it, and `failed` runs when it does not land.
    func writeNode(_ id: String, props: [String: Any], remove: [String] = [], failed: @escaping () -> Void) {
        guard let file = currentFile else { return }
        editOp += 1
        queueWrite(PendingWrite(file: file, id: id, props: props, remove: remove, gesture: nil, op: editOp, drawn: false, failed: [failed]))
    }

    /// Several layers in one write and one undo step that are not (only) the selection: the Layers panel's lock
    /// sweep (the same props on each) and Rename Layers (`each`: a name per layer). `failed` runs when it does not land.
    func writeNodes(_ ids: [String], props: [String: Any] = [:], remove: [String] = [], each: [String: [String: Any]]? = nil, failed: @escaping () -> Void) {
        guard let file = currentFile, !ids.isEmpty else { return }
        editOp += 1
        queueWrite(PendingWrite(file: file, id: ids.joined(separator: "\u{1E}"), ids: ids, props: props, remove: remove, gesture: nil, op: editOp,
                                each: each, drawn: false, failed: [failed]))
    }

    /// Run `f` once no inspector write is waiting or in flight (undo must not overtake the edit it should undo).
    func afterWrites(_ f: @escaping () -> Void) {
        if writes.isIdle { f() } else { afterWritesQueue.append(f) }
    }

    var writesIdle: Bool { writes.isIdle }

    /// Quit: waits for every queued inspector write. `done(true)` once all are written; `done(false)` when one
    /// failed or the server did not answer within `timeout` (the app then stays open, the edits not lost).
    func drainWrites(timeout: TimeInterval = 10, _ done: @escaping (Bool) -> Void) {
        if writes.isIdle { done(true); return }
        drainFailed = false
        var answered = false
        afterWrites {
            guard !answered else { return }
            answered = true
            done(!self.drainFailed)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            guard !answered else { return }
            answered = true
            done(false)
        }
    }

    // MARK: shell -> page

    func run(_ js: String) { webView.evaluateJavaScript("window.canvasCmd && window.canvasCmd(\(js))") }
    /// An auto layout op (add, remove, place, sizing) for the page, which adds the layers' world rects and posts
    /// /api/layout (src/page/autolayout.js). Waits for inspector writes in flight, like Undo.
    func runLayout(_ op: [String: Any]) {
        var msg = op
        msg["cmd"] = "layout"
        guard let data = try? JSONSerialization.data(withJSONObject: msg), let js = String(data: data, encoding: .utf8) else { return }
        let gen = docGeneration
        afterWrites { if self.docGeneration == gen { self.run(js) } }
    }
    func fit(_ id: String? = nil) { run("{cmd:'fit',id:\(id.map { "'\($0)'" } ?? "null")\(insetsArg)}") }
    /// The boards list: select the board and fly the camera to it.
    func fly(_ id: String) { run("{cmd:'fly',id:\(jsString(id))}"); focusCanvas() }
    func setPageBackground(_ color: String?, page: String) {
        guard !isCloudFile, let file = currentFile,
              let index = pages.firstIndex(where: { $0.id == page }) else { return }
        let background = color.flatMap { PaintLogic.withAlpha($0, percent: 100) }?.uppercased()
        guard color == nil || background?.range(of: "^#[0-9A-F]{6}$", options: .regularExpression) != nil else { return }
        guard pages[index].background != background else { return }
        guard var parts = URLComponents(url: base.appendingPathComponent("api/pages/" + page), resolvingAgainstBaseURL: false) else { return }
        parts.setQuery([URLQueryItem(name: "file", value: file)])
        guard let url = parts.url else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "PATCH"
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["background": background as Any? ?? NSNull()])
        URLSession.shared.dataTask(with: req) { _, response, _ in
            if (response as? HTTPURLResponse)?.statusCode != 200 {
                DispatchQueue.main.async { self.flash("Could not change the page background") }
            }
        }.resume()
    }

    func showPage(_ id: String) { run("{cmd:'page',id:\(jsString(id))}"); focusCanvas() }
    /// After a click in a list, keyboard shortcuts belong to the canvas again (unless a text field is being typed in).
    func focusCanvas() {
        guard let w = webView.window, !(w.firstResponder is NSText) else { return }
        DispatchQueue.main.async { if !(w.firstResponder is NSText) { w.makeFirstResponder(self.webView) } }
    }
    /// Every board on the page in view (Shift+1).
    func fitPage() { run("{cmd:'fitAll'\(insetsArg)}") }
    func zoomReset() { run("{cmd:'zoom',to:1\(insetsArg)}") }
    /// A typed zoom (the zoom pill's field): 1.5 is 150%, about the middle of the free area.
    func zoomTo(_ z: Double) { run("{cmd:'zoom',to:\(z)\(insetsArg)}") }
    func zoomBy(_ k: Double) { run("{cmd:'zoom',by:\(k)\(insetsArg)}") }
    /// The current free area, sent along with every fit and zoom so the page never fits into a stale one.
    private var insetsArg: String {
        guard let i = lastInsets else { return "" }
        return ",insets:{l:\(i.0),t:\(i.1),r:\(i.2),b:\(i.3)}"
    }
    func select(_ id: String) { run("{cmd:'select',id:'\(id.replacingOccurrences(of: "'", with: "\\'"))'}") }
    func deselect() { run("{cmd:'deselect'}") }
    /// Settings for the page: the shown tab, or (a setting just changed) every live tab, hidden ones too.
    func pushPrefs(everywhere: Bool = false) {
        let js = "window.canvasCmd && window.canvasCmd({cmd:'prefs',prefs:\(prefs.pagePrefsJSON)})"
        let views = everywhere ? Array(live.values) : []
        for wv in views { wv.evaluateJavaScript(js) }
        if !views.contains(where: { $0 === webView }) { webView.evaluateJavaScript(js) }
    }
    /// Settings > Performance: how much the snapshots take, or Clear them (the page answers with snapshotBytes).
    func snapshots(_ op: String) { run("{cmd:'snapshots',op:'\(op)'}") }
    func pushSnap() { run("{cmd:'snap',objects:\(snap.objects),pixel:\(snap.pixel),guides:\(snap.guides),bigNudge:\(snap.bigNudge)}") }

    /// Cmd+R: the selected layer's name opens for editing in the Layers panel (the panel opens on Layers).
    /// With several layers selected: the Rename Layers sheet (a batch rename).
    func renameSelection() {
        if let s = selection, s.ids.count > 1 {
            let ids = s.ids.filter { !$0.hasPrefix("widget:") && !LayersLogic.insideInstance($0) }
            guard ids.count > 1 else { return }
            batchRename = LayersStore.of(self).panelOrder(ids)
            return
        }
        guard let s = selection, s.ids.count <= 1, !s.isPath, !s.inInstance else { return }
        uiHidden = false
        panelOpen = true
        if section != .boards { section = .boards }
        if boards.contains(where: { $0.id == s.id }) { renamingBoard = s.id } else { LayersStore.of(self).startRename(s.id) }
    }

    /// "+10", "*2" or "/2" typed in a Mixed field: every selected layer takes it from its own value. `scale`
    /// maps the file's value to the field's (opacity 0.5 shows 50); `skip` leaves layers out. One undo step.
    func relativeEach(_ key: String, _ text: String, scale: Double = 1, fallback: Double = 0, min lo: Double? = nil, max hi: Double? = nil,
                      skip: (([String: Any]) -> Bool)? = nil) {
        guard let s = selection, s.ids.count > 1, !s.isPath, let file = currentFile else { return }
        writeEach(file: file, key: key, MixedStep.relativeWrites(nodes: mixedNodes, ids: s.ids, key: key, text: text, scale: scale, fallback: fallback, min: lo, max: hi, skip: skip),
                  rel: RepeatHint.mixed(text, scale: scale).map { [key: $0] })
    }

    /// The boards list's inline rename: one Name Change through the inspector's write path.
    func renameBoard(_ id: String, to name: String) {
        let v = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let file = currentFile, !v.isEmpty, let i = boards.firstIndex(where: { $0.id == id }), boards[i].name != v else { return }
        let was = boards[i].name
        boards[i].name = v
        var req = URLRequest(url: base.appendingPathComponent("api/update"))
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["file": file, "id": id, "props": ["name": v]] as [String: Any])
        URLSession.shared.dataTask(with: req) { data, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode != 200 else { return }
            let msg = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["error"] as? String
            DispatchQueue.main.async {
                if let j = self.boards.firstIndex(where: { $0.id == id }), self.boards[j].name == v { self.boards[j].name = was }
                self.flash(msg ?? "Could not rename the board")
            }
        }.resume()
    }
    /// The free rectangle last sent, so a freshly loaded page (tab switch, reload) gets it again: SwiftUI only
    /// sends insets when they change, and a new page starts with none.
    private var lastInsets: (CGFloat, CGFloat, CGFloat, CGFloat)?
    private var zoomCornerFrame: CGRect = .zero
    func setZoomCorner(frame: CGRect) {
        zoomCornerFrame = frame
        run("{cmd:'zoomCorner',left:\(frame.minX),bottom:\(frame.maxY),height:\(frame.height)}")
    }
    func setInsets(l: CGFloat, t: CGFloat, r: CGFloat, b: CGFloat) {
        lastInsets = (l, t, r, b)
        run("{cmd:'insets',l:\(l),t:\(t),r:\(r),b:\(b)}")
    }
    func resendInsets() {
        if let i = lastInsets { setInsets(l: i.0, t: i.1, r: i.2, b: i.3) }
        setZoomCorner(frame: zoomCornerFrame)
        run("{cmd:'bottomToast',shown:\(toast != nil)}")
    }

    /// Shows a toast. `durationMs` 0 keeps it until `clearToast()` (the bridge's wait prompts). A path or an error copies
    /// on click; an error gets Ask agent when an agent is installed; `actions` come from the page (Undo). A toast you
    /// can act on stays at least 6 s, and while the pointer is on it.
    func flash(_ text: String, durationMs: Int = 4000, level: String? = nil, actions: [ToastAction] = []) {
        toastSeq += 1
        toast = text
        run("{cmd:'bottomToast',shown:true}")
        toastKind = level == "success" ? .success : level == "link" ? .link : (durationMs <= 0 ? .waiting : .plain)
        toastCopy = durationMs > 0 ? ToastLogic.copyText(text, level: level) : nil
        var acts = actions
        if durationMs > 0, agentReady, ToastLogic.isError(text, level: level) {
            acts.append(ToastAction(id: "ask", label: "Ask agent", symbol: "sparkles") { [weak self] in self?.askAgent(about: text) })
        }
        toastActions = acts
        guard durationMs > 0 else { return }
        scheduleToastEnd(after: acts.isEmpty && toastCopy == nil ? durationMs : max(durationMs, 6000))
    }

    private func scheduleToastEnd(after ms: Int) {
        let seq = toastSeq
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(ms) / 1000) {
            guard self.toastSeq == seq, self.toast != nil, self.toastKind != .waiting else { return }
            if self.toastHovered { return } // leaving it schedules the end again
            self.clearToast()
        }
    }

    func clearToast() { run("{cmd:'bottomToast',shown:false}"); toast = nil; toastActions = []; toastCopy = nil; toastHovered = false }

    /// A click on a toast with a path or an error: its text on the pasteboard, and the toast says so.
    func copyToast() {
        guard let text = toastCopy else { return }
        canvasPasteboard.clearContents()
        canvasPasteboard.setString(text, forType: .string)
        flash("Copied", durationMs: 1500, level: "success")
    }

    /// Ask agent on an error toast: the composer (Cmd+Return) opens on the selection, or the board in view, with the
    /// toast quoted in its field; the person sends it (src/page/spark.js askPrefill).
    func askAgent(about text: String) {
        clearToast()
        run("{cmd:'askPrefill',text:\(JSONText.string(ToastLogic.askPrompt(text)))}")
    }

    /// Whether Claude Code or Codex is installed (Ask agent on error toasts). At launch and when Settings change.
    func refreshAgentReady() {
        var req = URLRequest(url: base.appendingPathComponent("api/agent/harnesses"))
        req.timeoutInterval = 5
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let list = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["harnesses"] as? [[String: Any]]
            DispatchQueue.main.async { self.agentReady = !(list ?? []).isEmpty }
        }.resume()
    }

    // MARK: canvas:// links

    /// Opens a canvas:// link (Edit > Copy Link made it): its file's tab, then, once that page is up, its page, its
    /// nodes selected and zoomed to (src/page/link.js openLink). A tab already open on the same file (another
    /// spelling of the path, a symlink) is reused.
    func openLink(_ link: CanvasLink) {
        let real = { (p: String) in URL(fileURLWithPath: p).resolvingSymlinksInPath().path }
        let want = real(link.file)
        let file = openFiles.first { real($0) == want } ?? link.file
        if currentFile != file { open(file) }
        linkToken += 1
        revealLink(link, file: file, token: linkToken, deadline: Date().addingTimeInterval(20))
    }
    private var linkToken = 0
    private func revealLink(_ link: CanvasLink, file: String, token: Int, deadline: Date) {
        guard token == linkToken else { return } // a newer link wins
        let ready = "!!(window.canvasHost && window.canvasHost.file === \(JSONText.string(file)) && window.canvasHost.doc && window.canvasBridge && window.canvasHost.copyLink)"
        webView.evaluateJavaScript(ready) { r, _ in
            if (r as? Bool) == true { self.run(link.pageCommand); return }
            guard Date() < deadline else { self.flash("Canvas could not show the link: \(URL(fileURLWithPath: file).lastPathComponent) did not open"); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.revealLink(link, file: file, token: token, deadline: deadline) }
        }
    }
}

/// The pasteboard Copy, Cut, Paste and Copy Link use. A QA build points it at a private one (QA.swift), so tests
/// never touch the clipboard of the person at the Mac.
nonisolated(unsafe) var canvasPasteboard = NSPasteboard.general
