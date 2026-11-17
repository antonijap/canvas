// The command palette (Cmd+K, Cmd+/): one Liquid Glass panel near the top of the window with a search field and a
// list. It finds boards, layers, text, components, pages and cards across the document (GET /api/search on the
// server, src/search.ts), offers "select matching" for the selection (GET /api/search/match), and runs the menu
// commands by name with their shortcuts. Keys are handled here before the menus: Cmd+K inside a to-do item stays
// the to-do's (it completes the item; the page says when one has focus, src/page/palette.js).

import SwiftUI
import AppKit
import WebKit

struct PaletteItem: Identifiable {
    let id: String
    let title: String
    var ranges: [[Int]] = []
    var detail: String?
    var symbol: String
    var tint: Color?
    var shortcut = ""
    var score = 0.0
    /// For filtering again locally while the server's answer for a longer query is on its way.
    var fuzzy = true
    /// Recents remember this key (commands and select-matching actions).
    var recentKey: String?
    /// What Cmd+Return (or Tab) does, and the footer's word for it.
    var secondaryLabel: String?
    var secondary: (() -> Void)?
    /// A two-line row (Recent asks): the line under the title, 4 pt below it.
    var subtitle: String?
    /// Small text on the right (Recent asks: when).
    var trailing: String?
    let run: () -> Void
}

struct PaletteGroup: Identifiable {
    let id: String
    let title: String
    var items: [PaletteItem]
}

/// One command the palette can run: a menu item (by its MenuSpec command) or one of the palette's own.
private struct PaletteCommand {
    let key: String
    let title: String
    let symbol: String
    var shortcut = ""
    var keywords = ""
    var tint: Color? = nil
    let applies: (CanvasModel) -> Bool
    let run: (CanvasModel) -> Void
}

final class PaletteController: NSObject, ObservableObject, WKScriptMessageHandler {
    static let shared = PaletteController()

    @Published private(set) var isOpen = false
    @Published var query = "" { didSet { if query != oldValue { queryChanged() } } }
    @Published private(set) var groups: [PaletteGroup] = []
    @Published var cursor = 0
    /// Bumped on open, so the field takes focus again.
    @Published private(set) var focusToken = 0
    @Published private(set) var searching = false

    private(set) weak var model: CanvasModel?
    /// A to-do item's text field has focus on the page: Cmd+K there completes the item.
    private var todoFocus = false
    var todoKeyIsPage: Bool { todoFocus && webHasFocus }
    private var found: [PaletteGroup] = []
    private var matching: [PaletteItem] = []
    /// Talk to the selection: every thread in the file, newest first (GET /api/agent/recent, src/agent-run.ts).
    private var asks: [PaletteItem] = []
    private var gen = 0
    /// Bumped on every open: an answer for an earlier opening is dropped.
    private var session = 0
    private var debounce: DispatchWorkItem?
    private var installed = false
    fileprivate var lastToggle: (code: UInt16, at: TimeInterval) = (0, -1)
    private var recents: [String] = UserDefaults.standard.stringArray(forKey: "canvas.palette.recent") ?? []

    var flat: [PaletteItem] { groups.flatMap(\.items) }
    var current: PaletteItem? { let f = flat; return f.indices.contains(cursor) ? f[cursor] : nil }

    // MARK: setup and keys

    func install(_ model: CanvasModel) {
        guard !installed else { return }
        installed = true
        self.model = model
        model.webView.configuration.userContentController.add(self, name: "canvasPalette")
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in self?.key(e) ?? e }
        // Installed at launch, maybe before the web view is in its window: match the window on each note instead of
        // registering for one (object nil would mean every window, and any popover resigning closed the palette).
        NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: nil, queue: .main) { [weak self] note in
            guard let w = note.object as? NSWindow, w === self?.model?.webView.window else { return }
            // Clicking another app or window closes it, like Spotlight. A popover the palette itself opened has none.
            if self?.isOpen == true { self?.close(refocus: false) }
        }
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === model?.webView else { return } // a hidden tab's page has no say
        guard let text = message.body as? String, let data = text.data(using: .utf8),
              let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let t = m["todoFocus"] as? Bool { DispatchQueue.main.async { self.todoFocus = t } }
    }

    /// Cmd+K, Cmd+/ and, while open, the arrows, Return, Tab and Escape. Returns nil for a key it used.
    private func key(_ e: NSEvent) -> NSEvent? {
        guard let model, let win = model.webView.window, e.window === win, win.attachedSheet == nil else { return e }
        let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
        let ch = e.charactersIgnoringModifiers?.lowercased() ?? ""
        // Cmd+/ by the character, or by the key in the slash spot (keyCode 44) on layouts where it types
        // something else (Croatian, German): the quick actions key is a position as much as a character.
        if mods == .command && (ch == "k" || ch == "/" || e.keyCode == 44) {
            // One press can reach this monitor twice (the web view hands a key it did not use back to the app), and
            // toggling on both opened and closed the palette at once. Nobody toggles it twice within 0.2 s on purpose.
            let now = ProcessInfo.processInfo.systemUptime
            if now - lastToggle.at < 0.2 { return nil }
            lastToggle = (e.keyCode, now)
            if isOpen { close(); return nil }
            // A to-do item being typed in: its Cmd+K completes it (src/page/widget-kinds.js).
            if ch == "k" && todoKeyIsPage { return e }
            open()
            return nil
        }
        guard isOpen else { return e }
        switch e.keyCode {
        case 53: close(); return nil                                    // Escape
        case 125: move(1); return nil                                   // Down
        case 126: move(-1); return nil                                  // Up
        case 36, 76: activate(secondary: mods.contains(.command)); return nil // Return, Enter
        case 48: if current?.secondary != nil { activate(secondary: true) }; return nil // Tab
        default:
            if mods == .control && (ch == "n" || ch == "p") { move(ch == "n" ? 1 : -1); return nil }
            return e
        }
    }

    // MARK: open, close, run

    func toggle() { isOpen ? close() : open() }
    /// View > Quick Actions. The key that opened the palette can reach the menu's key equivalent right after the
    /// monitor took it (logged: the monitor opened it, the menu closed it 0.13 s later): a menu toggle that close
    /// to a key toggle is that same press.
    func toggleFromMenu() {
        if ProcessInfo.processInfo.systemUptime - lastToggle.at < 0.3 { return }
        lastToggle = (0, ProcessInfo.processInfo.systemUptime)
        toggle()
    }

    func open() {
        guard let model else { return }
        gen += 1
        session += 1
        found = []
        matching = []
        asks = []
        query = ""
        cursor = 0
        isOpen = true
        focusToken += 1
        rebuild()
        fetchMatching(model)
        fetchAsks(model)
        // An empty query builds the server's index for this document, so the first letter typed is quick.
        fetchSearch("", gen: gen)
    }

    func close(refocus: Bool = true) {
        guard isOpen else { return }
        isOpen = false
        gen += 1
        debounce?.cancel()
        searching = false
        guard refocus, let model else { return }
        DispatchQueue.main.async { model.webView.window?.makeFirstResponder(model.webView) }
    }

    func move(_ d: Int) { cursor = PaletteList.step(cursor, by: d, count: flat.count) }

    func activate(secondary: Bool = false) {
        guard let item = current else { return }
        perform(item, secondary: secondary)
    }

    func perform(_ item: PaletteItem, secondary: Bool = false) {
        if let k = item.recentKey {
            recents = PaletteList.bump(recents, k)
            UserDefaults.standard.set(recents, forKey: "canvas.palette.recent")
        }
        let action = secondary ? (item.secondary ?? item.run) : item.run
        close()
        // After the canvas has keyboard focus again: menu actions check where focus is (src/page/structure.js keys).
        DispatchQueue.main.async { DispatchQueue.main.async(execute: action) }
    }

    // MARK: querying

    private func queryChanged() {
        cursor = 0
        debounce?.cancel()
        gen += 1
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { found = []; searching = false; rebuild(); return }
        let g = gen
        let work = DispatchWorkItem { [weak self] in self?.fetchSearch(q, gen: g) }
        debounce = work
        // Before the rebuild: it then filters the last answer by the new query instead of listing it whole.
        searching = true
        rebuild()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.04, execute: work)
    }

    private func url(_ path: String, _ items: [URLQueryItem]) -> URL? {
        guard let model, let file = model.currentFile else { return nil }
        var c = URLComponents(url: model.base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        c?.setQuery([URLQueryItem(name: "file", value: file), URLQueryItem(name: "page", value: model.activePage ?? "")] + items)
        return c?.url
    }

    private func getJSON(_ url: URL, _ done: @escaping ([String: Any]) -> Void) {
        var req = URLRequest(url: url)
        req.timeoutInterval = 4
        URLSession.shared.dataTask(with: req) { data, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            DispatchQueue.main.async { done(j) }
        }.resume()
    }

    private func fetchSearch(_ q: String, gen g: Int) {
        guard let u = url("api/search", [URLQueryItem(name: "q", value: q)]) else { searching = false; return }
        getJSON(u) { [weak self] j in
            guard let self, self.isOpen, g == self.gen, !q.isEmpty else { return }
            self.found = (j["groups"] as? [[String: Any]] ?? []).compactMap { self.group($0, query: q) }
            self.searching = false
            self.rebuild()
        }
    }

    private func fetchMatching(_ model: CanvasModel) {
        let ids = model.selection.map { $0.ids.isEmpty ? [$0.id] : $0.ids } ?? []
        guard let u = url("api/search/match", [URLQueryItem(name: "ids", value: ids.prefix(200).joined(separator: ","))]) else { return }
        let s = session
        getJSON(u) { [weak self] j in
            guard let self, self.isOpen, s == self.session else { return }
            self.matching = (j["actions"] as? [[String: Any]] ?? []).compactMap { self.matchItem($0) }
            self.rebuild()
        }
    }

    private func fetchAsks(_ model: CanvasModel) {
        guard let u = url("api/agent/recent", []) else { return }
        let s = session
        getJSON(u) { [weak self] j in
            guard let self, self.isOpen, s == self.session else { return }
            self.asks = (j["asks"] as? [[String: Any]] ?? []).compactMap { self.askItem($0) }
            self.rebuild()
        }
    }

    /// A Recent ask: its prompt, "Layer on Page", when. Return flies to the layer (its page first) and reopens the thread.
    private func askItem(_ a: [String: Any]) -> PaletteItem? {
        guard let model, let key = a["key"] as? String, let prompt = a["prompt"] as? String else { return nil }
        let ids = a["ids"] as? [String] ?? [key]
        let at = Date(timeIntervalSince1970: ((a["at"] as? NSNumber)?.doubleValue ?? 0) / 1000)
        let msg: [String: Any] = ["cmd": "askOpen", "key": key, "ids": ids, "board": a["board"] as? String ?? NSNull(), "page": a["page"] as? String ?? NSNull()]
        let where_ = PaletteList.askWhere(layer: a["name"] as? String ?? key, page: a["pageName"] as? String)
        return PaletteItem(id: "ask:\(key)", title: prompt, symbol: "sparkles.2", fuzzy: false, subtitle: where_, trailing: PaletteList.relDay(at, now: Date())) {
            guard let data = try? JSONSerialization.data(withJSONObject: msg), let js = String(data: data, encoding: .utf8) else { return }
            model.run(js)
        }
    }

    // MARK: building the list

    private static let groupTitles = ["board": "Boards", "page": "Pages", "component": "Components", "card": "Cards", "layer": "Layers", "text": "Text"]

    private func group(_ d: [String: Any], query q: String) -> PaletteGroup? {
        guard let kind = d["kind"] as? String, let title = Self.groupTitles[kind] else { return nil }
        let total = (d["total"] as? NSNumber)?.intValue ?? 0
        let items: [PaletteItem] = (d["items"] as? [[String: Any]] ?? []).compactMap { h in
            guard let id = h["id"] as? String else { return nil }
            return foundItem(kind: kind, id: id, h: h, total: total, query: q)
        }
        return items.isEmpty ? nil : PaletteGroup(id: "find:" + kind, title: total > items.count ? "\(title)  \(total)" : title, items: items)
    }

    private func foundItem(kind group: String, id: String, h: [String: Any], total: Int, query q: String) -> PaletteItem? {
        guard let model else { return nil }
        let title = h["title"] as? String ?? id
        let board = h["board"] as? String
        let kind = h["kind"] as? String ?? ""
        let detail = (h["detail"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        var symbol = "square", tint: Color?
        var run: () -> Void = { model.reveal(id, board: board) }
        switch group {
        case "board": symbol = "number"
        case "page": symbol = "doc"; run = { model.showPage(id) }
        case "component": symbol = "diamond.fill"; tint = Palette.component
        case "card":
            symbol = model.widgetKinds.first { "card:" + $0.id == kind }?.symbol ?? "square.grid.2x2"
            run = { model.revealWidget(String(id.dropFirst(7))) }
        case "text": symbol = "textformat"
        default:
            symbol = LayerIcon.symbol(kind) ?? "textformat"
            if LayerIcon.purple(kind) { tint = Palette.component }
        }
        var item = PaletteItem(id: "find:\(group):\(id)", title: title, ranges: h["ranges"] as? [[Int]] ?? [], detail: detail, symbol: symbol, tint: tint,
                               score: (h["score"] as? NSNumber)?.doubleValue ?? 0, fuzzy: group != "text", run: run)
        // Cmd+Return: every match of this kind on the page becomes the selection (Find, Select all).
        if (group == "layer" || group == "text"), total > 1 {
            item.secondaryLabel = "Select all matches on this page"
            item.secondary = { [weak self] in self?.selectAll(kind: group, query: q) }
        }
        if group == "component" {
            item.secondaryLabel = "Select all instances"
            item.secondary = { model.highlightInstances(of: ContextInfo.Family(id: id, name: title, instances: 0)) }
        }
        return item
    }

    private func selectAll(kind: String, query q: String) {
        guard let model, let u = url("api/search", [URLQueryItem(name: "q", value: q), URLQueryItem(name: "all", value: kind)]) else { return }
        getJSON(u) { j in
            let ids = j["ids"] as? [String] ?? []
            guard !ids.isEmpty else { model.flash("Nothing on this page matches \u{201C}\(q)\u{201D}"); return }
            Self.select(model, ids: ids, boards: j["boards"] as? [String: String] ?? [:])
            model.flash("Selected \(ids.count) \(kind == "text" ? "text layers" : "layers") matching \u{201C}\(q)\u{201D}")
        }
    }

    static func select(_ model: CanvasModel, ids: [String], boards: [String: String]) {
        let msg: [String: Any] = ["cmd": "paletteSelect", "ids": ids, "boards": boards]
        guard let data = try? JSONSerialization.data(withJSONObject: msg), let js = String(data: data, encoding: .utf8) else { return }
        model.run(js)
    }

    private func matchItem(_ a: [String: Any]) -> PaletteItem? {
        guard let model, let key = a["key"] as? String, let title = a["title"] as? String, let ids = a["ids"] as? [String] else { return nil }
        let detail = a["detail"] as? String ?? ""
        let boards = a["boards"] as? [String: String] ?? [:]
        let symbol: String
        switch key {
        case "textStyle", "font": symbol = "textformat"
        case "fill": symbol = "paintbrush"
        case "instances": symbol = "diamond"
        case "boardText": symbol = "text.alignleft"
        case "hidden": symbol = "eye.slash"
        default: symbol = "hexagon"
        }
        return PaletteItem(id: "match:" + key, title: title, detail: detail, symbol: symbol, tint: key == "instances" ? Palette.component : nil,
                           recentKey: nil) {
            Self.select(model, ids: ids, boards: boards)
            model.flash("Selected \(detail)")
        }
    }

    private func commandItems(_ model: CanvasModel) -> [PaletteItem] {
        Self.commands(model).filter { $0.applies(model) }.map { c in
            PaletteItem(id: "cmd:" + c.key, title: c.title, symbol: c.symbol, tint: c.tint,
                        shortcut: c.shortcut, recentKey: "cmd:" + c.key) { c.run(model) }
        }
    }

    /// Re-scores an item against the query, locally (commands always; found items while a newer answer is on its way).
    private func rescore(_ item: PaletteItem, _ q: String, keywords: String = "") -> PaletteItem? {
        if let m = PaletteFuzzy.match(q, item.title, fuzzy: item.fuzzy) {
            var i = item
            i.ranges = m.ranges
            i.score = m.score
            return i
        }
        if !keywords.isEmpty, let m = PaletteFuzzy.match(q, keywords) {
            var i = item
            i.ranges = []
            i.score = m.score - 30
            return i
        }
        return nil
    }

    private func rebuild() {
        guard let model else { groups = []; return }
        let q = query.trimmingCharacters(in: .whitespaces)
        let cmds = commandItems(model)
        var out: [PaletteGroup] = []
        if q.isEmpty {
            let byKey = Dictionary(cmds.map { ($0.recentKey ?? $0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let recent = recents.compactMap { byKey[$0] }.prefix(5)
            let recentIds = Set(recent.map(\.id))
            if !asks.isEmpty { out.append(PaletteGroup(id: "asks", title: "Recent asks", items: Array(asks.prefix(5)))) }
            if !recent.isEmpty { out.append(PaletteGroup(id: "recent", title: "Recent", items: Array(recent))) }
            if !matching.isEmpty { out.append(PaletteGroup(id: "match", title: "Select matching", items: matching)) }
            out.append(PaletteGroup(id: "cmd", title: "Commands", items: cmds.filter { !recentIds.contains($0.id) }))
        } else {
            let keywords = Dictionary(Self.commands(model).map { ("cmd:" + $0.key, $0.keywords) }, uniquingKeysWith: { a, _ in a })
            let c = cmds.compactMap { rescore($0, q, keywords: keywords[$0.id] ?? "") }.sorted { $0.score > $1.score }.prefix(8)
            let m = matching.compactMap { rescore($0, q) }.sorted { $0.score > $1.score }
            var groups = found
            if searching {
                // The server's answer for the longer query is on its way: keep what still matches, scored here.
                groups = groups.compactMap { g in
                    // Cmd+Return would select the matches of the older query these rows came from: no secondary until the answer lands.
                    let items = g.items.compactMap { rescore($0, q) }.map { item -> PaletteItem in
                        var i = item
                        i.secondary = nil
                        i.secondaryLabel = nil
                        return i
                    }
                    return items.isEmpty ? nil : PaletteGroup(id: g.id, title: g.title.components(separatedBy: "  ").first ?? g.title, items: items)
                }
            }
            if !c.isEmpty { groups.append(PaletteGroup(id: "cmd", title: "Commands", items: Array(c))) }
            if !m.isEmpty { groups.append(PaletteGroup(id: "match", title: "Select matching", items: m)) }
            // Asks by what was asked, or all of them for "recent" / "ask".
            let a = asks.compactMap { rescore($0, q, keywords: "recent asks ask agent") }.sorted { $0.score > $1.score }.prefix(8)
            if !a.isEmpty { groups.append(PaletteGroup(id: "asks", title: "Recent asks", items: Array(a))) }
            let order = PaletteList.order(groups.map { ($0.id, $0.items.first?.score ?? 0) })
            let byId = Dictionary(groups.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            out = order.compactMap { byId[$0] }
        }
        groups = out
        if cursor >= flat.count { cursor = max(0, flat.count - 1) }
    }

    // MARK: the commands

    /// Runs a menu bar command through its own target and action (main.swift), as a click on the item would.
    private static func menu(_ command: String) {
        guard let t = menuTarget(command) else { return }
        let item = NSMenuItem()
        item.representedObject = t.op
        NSApp.sendAction(t.action, to: t.target, from: item)
    }

    private static let symbols: [String: String] = [
        "copyProps": "doc.on.doc", "pasteProps": "doc.on.clipboard", "duplicate": "plus.square.on.square", "delete": "trash",
        "selectAll": "square.dashed.inset.filled", "zoomIn": "plus.magnifyingglass", "zoomOut": "minus.magnifyingglass",
        "zoom100": "1.magnifyingglass", "zoomFit": "arrow.up.left.and.down.right.magnifyingglass", "zoomSelection": "viewfinder",
        "toggleUI": "macwindow", "toggleProperties": "sidebar.right", "group": "square.dashed", "frame": "number",
        "ungroup": "square.on.square.dashed", "addAutoLayout": "rectangle.split.1x2", "removeAutoLayout": "rectangle",
        "component": "diamond", "detach": "scissors", "front": "square.3.layers.3d.top.filled", "forward": "square.2.layers.3d.top.filled",
        "backward": "square.2.layers.3d.bottom.filled", "back": "square.3.layers.3d.bottom.filled",
        "flipH": "arrow.left.and.right.righttriangle.left.righttriangle.right", "flipV": "arrow.up.and.down.righttriangle.up.righttriangle.down",
        "rename": "character.cursor.ibeam", "toggleHidden": "eye.slash", "align-left": "align.horizontal.left",
        "align-hcenter": "align.horizontal.center", "align-right": "align.horizontal.right", "align-top": "align.vertical.top",
        "align-vcenter": "align.vertical.center", "align-bottom": "align.vertical.bottom", "distribute-h": "distribute.horizontal",
        "distribute-v": "distribute.vertical", "new": "doc.badge.plus", "open": "folder", "closeTab": "xmark", "saveAs": "square.and.arrow.down",
        "settings": "ruler", "repeat": "repeat", "copyLink": "link",
        "lock": "lock", "selectInverse": "rectangle.dashed", "selectMatching": "square.stack.3d.down.right", "collapseLayers": "chevron.up.chevron.down",
    ]
    private static let keywords: [String: String] = [
        "addAutoLayout": "flex stack hug", "removeAutoLayout": "flex stack", "frame": "wrap container", "group": "wrap",
        "toggleHidden": "visibility show hide eye", "toggleUI": "panels chrome focus", "zoomFit": "fit all overview",
        "detach": "unlink instance", "component": "make reusable symbol", "flipH": "mirror", "flipV": "mirror",
        "front": "order z arrange", "back": "order z arrange", "forward": "order z arrange", "backward": "order z arrange",
        "settings": "preferences snapping nudge theme agents sounds shortcuts", "copyProps": "style", "pasteProps": "style",
        "repeat": "again last edit same apply", "copyLink": "url share agent claude codex chat paste",
        "lock": "unlock freeze protect", "selectInverse": "invert everything else", "selectMatching": "same name other boards", "collapseLayers": "close fold layers panel",
    ]

    private static func commands(_ model: CanvasModel) -> [PaletteCommand] {
        let sel = model.selection
        let hasSel = sel != nil
        let anySel = sel != nil || model.selectedWidgetId != nil
        let type = sel?.node["type"] as? String
        let many = (sel?.ids.count ?? 0) > 1
        let editable = hasSel && !(sel?.isPath ?? false) && !(sel?.inInstance ?? false)
        func applies(_ cmd: String) -> Bool {
            switch cmd {
            case "new", "open", "settings", "zoomIn", "zoomOut", "zoom100", "zoomFit", "zoomSelection", "toggleUI", "toggleProperties", "selectAll", "selectInverse", "collapseLayers": return true
            case "closeTab", "copyLink": return model.currentFile != nil
            case "duplicate", "delete", "front", "forward", "backward", "back": return anySel
            case "ungroup": return type == "group" || type == "frame" || (many && type == nil)
            case "removeAutoLayout": return sel.map { LayoutLogic.isAutoLayout($0.node) } ?? false
            case "detach": return type == "ref" || (many && type == nil)
            case "component": return editable && sel?.node["reusable"] as? Bool != true
            case "distribute-h", "distribute-v": return (sel?.ids.count ?? 0) > 2
            case "rename": return editable
            case "repeat": return hasSel && model.repeatLabel != nil
            default: return hasSel
            }
        }
        var out: [PaletteCommand] = []
        // The menu bar's commands, the ones about the selection first; the file and app ones go last (below).
        let wanted: Set<String> = ["new", "open", "closeTab", "saveAs", "settings"]
        func fromMenus(_ titles: [String]) {
            for (title, entries) in MenuSpec.menus where titles.contains(title) {
                for e in entries {
                    guard let i = e, !i.command.isEmpty, i.command != "palette", let symbol = symbols[i.command] else { continue }
                    if ["Canvas", "File"].contains(title) && !wanted.contains(i.command) { continue }
                    let cmd = i.command
                    // Repeat names the edit it does again ("Repeat Fill Change"), like its menu item.
                    let title = cmd == "repeat" ? RepeatHint.title(model.repeatLabel) : i.title.replacingOccurrences(of: "\u{2026}", with: "")
                    out.append(PaletteCommand(key: cmd, title: title, symbol: symbol, shortcut: PaletteKeys.label(i),
                                              keywords: keywords[cmd] ?? "", applies: { _ in applies(cmd) }, run: { _ in menu(cmd) }))
                }
            }
        }
        fromMenus(["Object", "Arrange", "Edit", "View"])
        // The palette's own: page keys without a menu item, pages, panels, themes, cards.
        let shortcut = { (op: String) in { (m: CanvasModel) in m.run("{cmd:'shortcut',op:'\(op)'}") } }
        // Variations (src/page/variations.js): three directions side by side, and the brief they follow.
        out.append(PaletteCommand(key: "variations", title: "Make 3 Variations", symbol: "square.on.square.dashed", shortcut: "\u{21E7}\u{2318}\u{21A9}", keywords: "agent ai alternatives options directions explore",
                                  applies: { _ in hasSel }, run: { $0.run("{cmd:'variations',op:'make'}") }))
        out.append(PaletteCommand(key: "brief", title: "Edit Product Brief", symbol: "doc.text", keywords: "agent product brief tone platform audience variations",
                                  applies: { $0.currentFile != nil }, run: { $0.run("{cmd:'variations',op:'brief'}") }))
        out.append(PaletteCommand(key: "nextBoard", title: "Next Board", symbol: "arrow.right.square", shortcut: "N", keywords: "go board", applies: { _ in true }, run: shortcut("nextBoard")))
        out.append(PaletteCommand(key: "prevBoard", title: "Previous Board", symbol: "arrow.left.square", shortcut: "\u{21E7}N", keywords: "go board", applies: { _ in true }, run: shortcut("prevBoard")))
        out.append(PaletteCommand(key: "newPage", title: "New Page", symbol: "plus.rectangle.on.rectangle", keywords: "add page", applies: { $0.currentFile != nil }, run: { $0.addPage() }))
        let pages = model.pages, at = pages.firstIndex { $0.id == model.activePage }
        if let at, pages.count > 1 {
            let next = pages[(at + 1) % pages.count], prev = pages[(at - 1 + pages.count) % pages.count]
            out.append(PaletteCommand(key: "nextPage", title: "Next Page: \(next.name)", symbol: "chevron.down.square", keywords: "switch go page", applies: { _ in true }, run: { $0.showPage(next.id) }))
            out.append(PaletteCommand(key: "prevPage", title: "Previous Page: \(prev.name)", symbol: "chevron.up.square", keywords: "switch go page", applies: { _ in true }, run: { $0.showPage(prev.id) }))
            for p in pages where p.id != model.activePage {
                out.append(PaletteCommand(key: "page:" + p.id, title: "Go to Page: \(p.name)", symbol: "doc", keywords: "switch page", applies: { _ in true }, run: { $0.showPage(p.id) }))
            }
        }
        out.append(PaletteCommand(key: "panel", title: model.panelOpen ? "Hide Left Panel" : "Show Left Panel", symbol: "sidebar.left", keywords: "toggle sidebar layers", applies: { _ in true },
                                  run: { m in m.uiHidden = false; m.panelOpen.toggle() }))
        for s in RailSection.allCases {
            out.append(PaletteCommand(key: "section:" + s.rawValue, title: "Show \(s.rawValue)", symbol: s.symbol, keywords: "panel sidebar open", applies: { _ in true },
                                      run: { m in m.uiHidden = false; m.section = s; m.panelOpen = true }))
        }
        let dark = model.webView.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        out.append(PaletteCommand(key: "theme", title: dark ? "Switch to Light Theme" : "Switch to Dark Theme", symbol: dark ? "sun.max" : "moon", keywords: "toggle theme appearance mode dark light", applies: { _ in true },
                                  run: { m in m.theme = dark ? .light : .dark }))
        for t in AppTheme.allCases where t != model.theme {
            out.append(PaletteCommand(key: "theme:" + t.rawValue, title: "\(t.title) Theme", symbol: t.symbol, keywords: "appearance mode", applies: { _ in true }, run: { m in m.theme = t }))
        }
        for k in model.widgetKinds {
            out.append(PaletteCommand(key: "card:" + k.id, title: "Add \(k.title) Card", symbol: k.symbol, keywords: "widget new insert", applies: { $0.currentFile != nil }, run: { $0.addWidget(k.id) }))
        }
        fromMenus(["File", "Canvas"])
        return out
    }
}

/// View > Quick Actions in the menu bar (main.swift menuTarget). The keys never reach it: PaletteController takes them first.
final class PaletteMenuTarget: NSObject, NSMenuItemValidation {
    @objc func toggle(_ s: Any?) { PaletteController.shared.toggleFromMenu() }
    /// Cmd+K typed in a to-do item is the item's (it completes it), should the key ever reach the menu.
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        !(NSApp.currentEvent?.type == .keyDown && PaletteController.shared.todoKeyIsPage)
    }
}
let paletteMenuTarget = PaletteMenuTarget()

// MARK: Views

/// Sits over the whole window (RootView): a click outside the panel closes it.
struct CommandPaletteLayer: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject private var palette = PaletteController.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .top) {
            if palette.isOpen {
                Color.clear.contentShape(Rectangle()).onTapGesture { palette.close() }
                PalettePanel(palette: palette)
                    .padding(.top, Metric.inset + Metric.pill + Metric.islandGap * 4)
                    .padding(.horizontal, Metric.inset * 4)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .allowsHitTesting(palette.isOpen)
        .animation(reduceMotion ? nil : Motion.fast, value: palette.isOpen)
        .ignoresSafeArea()
        .onAppear { palette.install(model) }
    }
}

private struct PalettePanel: View {
    @ObservedObject var palette: PaletteController
    @FocusState private var focused: Bool

    /// The list's height: rows, headers and the gaps between them, up to a cap (then it scrolls).
    private var listHeight: CGFloat {
        let rows = CGFloat(palette.groups.reduce(0) { $0 + $1.items.filter { $0.subtitle == nil }.count })
        let tall = CGFloat(palette.groups.reduce(0) { $0 + $1.items.filter { $0.subtitle != nil }.count })
        let heads = CGFloat(palette.groups.count)
        return min(rows * (Metric.row + 2) + tall * (PaletteList.askRowHeight + 2) + heads * 31 + 4, 420)
    }

    var body: some View {
        GlassIsland(padding: Metric.islandPad, dense: true) {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").railGlyph().foregroundStyle(Palette.mutedFg).frame(width: 18)
                    TextField("Find layers, text, boards, or run a command", text: $palette.query)
                        .textFieldStyle(.plain).font(Typography.prompt).focused($focused)
                        .accessibilityLabel("Quick actions search")
                }
                .padding(.horizontal, 12).frame(height: Metric.control + 8)
                Capsule().fill(Palette.stroke).frame(height: 1).padding(.horizontal, 4).padding(.bottom, 2)
                if palette.groups.isEmpty {
                    Text(palette.searching ? " " : "No matches").font(Typography.body).foregroundStyle(Palette.mutedFg)
                        .frame(maxWidth: .infinity).frame(height: Metric.row * 2)
                } else {
                    results
                }
                footer
            }
        }
        .frame(maxWidth: 600)
        .onAppear { focused = true }
        .onChange(of: palette.focusToken) { _, _ in focused = true }
    }

    private var results: some View {
        var offsets: [Int] = [], n = 0
        for g in palette.groups { offsets.append(n); n += g.items.count }
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(palette.groups.enumerated()), id: \.element.id) { gi, g in
                        SectionHeader(title: g.title)
                        ForEach(Array(g.items.enumerated()), id: \.element.id) { ii, item in
                            PaletteRow(item: item, active: offsets[gi] + ii == palette.cursor) { palette.perform(item) }
                                .id(item.id)
                        }
                    }
                }
            }
            .scrollIndicators(.never)
            .frame(height: listHeight)
            .onChange(of: palette.cursor) { _, _ in
                if let id = palette.current?.id { proxy.scrollTo(id) }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 14) {
            hint("\u{2191}\u{2193}", "Move")
            hint("\u{21A9}", "Open")
            if let s = palette.current?.secondaryLabel { hint("\u{2318}\u{21A9}", s) }
            Spacer(minLength: 8)
            hint("esc", "Close")
        }
        .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 2)
    }

    private func hint(_ key: String, _ label: String) -> some View {
        HStack(spacing: 4) {
            Text(key).font(Typography.label).foregroundStyle(Palette.fg.opacity(0.7))
            Text(label).font(Typography.micro).foregroundStyle(Palette.mutedFg)
        }
    }
}

/// ListRow's look (DesignSystem/Components.swift), with the matched letters in bold and a shortcut on the right.
private struct PaletteRow: View {
    let item: PaletteItem
    let active: Bool
    let action: () -> Void
    @State private var hovering = false

    private var title: AttributedString {
        var a = AttributedString(item.title)
        for r in item.ranges where r.count == 2 {
            if let range = Range(NSRange(location: r[0], length: r[1]), in: a) { a[range].font = Typography.body.weight(.semibold) }
        }
        return a
    }

    var body: some View {
        if item.subtitle != nil { askRow } else { plainRow }
    }

    /// Recent asks (the talk-to-selection design, board 7): sparkles.2, the prompt over "Layer on Page" 4 pt below it, when.
    /// Selected: neutral grey, the icon in the text colour; secondary text stays muted grey (never grey on a tint).
    private var askRow: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: item.symbol).font(.system(size: 14, weight: .medium)).foregroundStyle(active ? Palette.fg : Palette.mutedFg).frame(width: 18)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.tail).fixedSize(horizontal: false, vertical: true)
                    if let s = item.subtitle { Text(s).font(.system(size: 12)).foregroundStyle(Palette.mutedFg).lineLimit(1).truncationMode(.middle).fixedSize(horizontal: false, vertical: true) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let t = item.trailing { Text(t).font(.system(size: 12)).monospacedDigit().foregroundStyle(Palette.mutedFg).lineLimit(1).fixedSize() }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(active ? Palette.rowSelected : hovering ? Palette.hover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
        .onHover { h in hovering = h }
    }

    private var plainRow: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: item.symbol).railGlyph().foregroundStyle(item.tint ?? Palette.mutedFg).frame(width: 18)
                Text(title).font(Typography.body).foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 8)
                if let d = item.detail, !d.isEmpty {
                    // Where it is stays readable: the title gives way first, the place only past a third of the row.
                    Text(d).font(Typography.micro).monospacedDigit().foregroundStyle(Palette.mutedFg).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: 220, alignment: .trailing).fixedSize(horizontal: d.count < 34, vertical: false).layoutPriority(1)
                }
                if !item.shortcut.isEmpty {
                    Text(item.shortcut).font(Typography.label).foregroundStyle(Palette.mutedFg).lineLimit(1).fixedSize()
                }
            }
            .padding(.horizontal, 12).frame(height: Metric.row)
            .background(RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).fill(active ? Palette.active : hovering ? Palette.hover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
        .onHover { h in hovering = h }
    }
}


