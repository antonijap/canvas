// Components and tokens in the shell: the right-click menu on canvas nodes (a native NSMenu the page asks
// for), "Go to main component", and the tokens library (Variables and Styles) with its hierarchy, theme
// columns, usage counts, search, and click-to-highlight. The server builds the groups (src/usage.ts);
// this file draws them.

import SwiftUI
import AppKit
import UniformTypeIdentifiers

// MARK: model types

struct TokenValue: Hashable { let theme: String; let value: String }

/// One row of the library: a variable or a text style.
struct LibItem: Identifiable {
    let id: String
    /// "variable" or "style": the kind the server's /api/usage takes.
    let kind: String
    /// The variable name or the style key.
    let key: String
    let title: String
    let leaf: String
    let type: String
    let values: [TokenValue]
    let count: Int
    /// A style's text colour, when it is a literal.
    let swatch: String?
}

/// A layer under the pointer, for the right-click menu's Select layer (src/page/context.js layersAt).
struct UnderLayer: Equatable {
    let id: String
    let name: String
    let type: String
    static func list(_ v: Any?) -> [UnderLayer] {
        (v as? [[String: Any]] ?? []).compactMap { d in
            guard let id = d["id"] as? String else { return nil }
            let n = d["name"] as? String ?? ""
            return UnderLayer(id: id, name: n.isEmpty ? id : n, type: d["type"] as? String ?? "")
        }
    }
    /// The inspector's symbol for a type.
    static func symbol(_ type: String) -> String { typeSymbol(type) }
}

/// A group of two or more items sharing a name family, or a single item at the top level.
struct LibEntry: Identifiable {
    let id: String
    let title: String
    let items: [LibItem]
    let isGroup: Bool
}

struct LibSection: Identifiable {
    let id: String
    let title: String
    let entries: [LibEntry]
    var itemCount: Int { entries.reduce(0) { $0 + $1.items.count } }
}

struct UsageItem: Identifiable { let id: String; let name: String; let type: String; let board: String; let boardName: String }
struct UsageState { let kind: String; let key: String; let total: Int; let items: [UsageItem]; let onPage: Int; let drawn: Int }

/// What the server says about a node: whether it is part of a component, where its main component is.
struct ContextInfo {
    struct Main { let id: String; let name: String; let board: String; let boardName: String; let focus: String }
    struct Family { let id: String; let name: String; let instances: Int }
    let id: String
    let name: String
    let type: String
    /// component, instance, inside-instance, inside-component or node
    let kind: String
    let board: String
    let boardName: String
    let purple: Bool
    let main: Main?
    let family: Family?
    /// A frame or rectangle a video card can be placed over ("Embed video here").
    let media: Bool
    /// A video path a caption near the node names, to start the file picker there.
    let videoHint: String?

    init?(_ d: [String: Any]) {
        guard let id = d["id"] as? String else { return nil }
        self.id = id
        name = d["name"] as? String ?? id
        type = d["type"] as? String ?? ""
        kind = d["kind"] as? String ?? "node"
        board = d["board"] as? String ?? ""
        boardName = d["boardName"] as? String ?? board
        purple = d["purple"] as? Bool ?? false
        media = d["media"] as? Bool ?? false
        videoHint = d["videoHint"] as? String
        main = (d["main"] as? [String: Any]).flatMap { m in
            guard let mid = m["id"] as? String else { return nil }
            return Main(id: mid, name: m["name"] as? String ?? mid, board: m["board"] as? String ?? "", boardName: m["boardName"] as? String ?? "",
                        focus: m["focus"] as? String ?? mid)
        }
        family = (d["family"] as? [String: Any]).flatMap { f in
            guard let fid = f["id"] as? String else { return nil }
            return Family(id: fid, name: f["name"] as? String ?? fid, instances: (f["instances"] as? NSNumber)?.intValue ?? 0)
        }
    }

    /// Instances and nodes inside them can jump to their component.
    var canGoToMain: Bool { main != nil && (kind == "instance" || kind == "inside-instance") }
}

/// The symbol for a node that is a component (filled), an instance (inset) or neither.
func componentSymbol(_ type: String?, kind: String?) -> String? {
    if kind == "component" { return "diamond.fill" }
    if kind == "instance" || type == "ref" { return "diamond.inset.filled" }
    return nil
}

// MARK: parsing

extension CanvasModel {
    func applyTokens(_ t: [String: Any]) {
        themes = t["themes"] as? [String] ?? []
        func item(_ d: [String: Any], kind: String) -> LibItem {
            let key = (kind == "style" ? d["key"] : d["name"]) as? String ?? ""
            let values = (d["values"] as? [[String: Any]] ?? []).map { TokenValue(theme: $0["theme"] as? String ?? "", value: $0["value"] as? String ?? "") }
            return LibItem(id: "\(kind):\(key)", kind: kind, key: key, title: (kind == "style" ? d["title"] : d["name"]) as? String ?? key,
                           leaf: d["leaf"] as? String ?? key, type: d["type"] as? String ?? "", values: values,
                           count: (d["count"] as? NSNumber)?.intValue ?? 0, swatch: d["color"] as? String)
        }
        func entries(_ list: [[String: Any]], kind: String) -> [LibEntry] {
            list.map { e in
                if let items = e["items"] as? [[String: Any]] {
                    let title = e["title"] as? String ?? ""
                    return LibEntry(id: "\(kind)-group:\(title)", title: title, items: items.map { item($0, kind: kind) }, isGroup: true)
                }
                let it = item(e, kind: kind)
                return LibEntry(id: it.id, title: it.title, items: [it], isGroup: false)
            }
        }
        tokenSections = (t["variables"] as? [[String: Any]] ?? []).map { s in
            let id = s["id"] as? String ?? ""
            return LibSection(id: id, title: s["title"] as? String ?? id, entries: entries(s["entries"] as? [[String: Any]] ?? [], kind: "variable"))
        }
        styleEntries = entries(t["styles"] as? [[String: Any]] ?? [], kind: "style")
    }

    func applyUsage(_ u: [String: Any]?) {
        guard let u, let kind = u["kind"] as? String, let key = u["key"] as? String else { usage = nil; return }
        let items = (u["items"] as? [[String: Any]] ?? []).map {
            UsageItem(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "", type: $0["type"] as? String ?? "",
                      board: $0["board"] as? String ?? "", boardName: $0["boardName"] as? String ?? "")
        }
        let total = (u["total"] as? NSNumber)?.intValue ?? items.count
        let drawn = (u["drawn"] as? NSNumber)?.intValue ?? 0
        let onPage = (u["onPage"] as? NSNumber)?.intValue ?? 0
        if kind == "component" {
            // From the right-click menu: a toast instead of a list.
            let noun = total == 1 ? "instance" : "instances"
            if total == 0 { flash("No instances of \(usageLabel)") }
            else if onPage < total { flash("Highlighted \(drawn) of \(total) \(noun) of \(usageLabel) (\(total - onPage) on other pages)") }
            else { flash("Highlighted \(total) \(noun) of \(usageLabel)") }
            return
        }
        guard activeUsage == "\(kind):\(key)" else { return }
        usage = UsageState(kind: kind, key: key, total: total, items: items, onPage: onPage, drawn: drawn)
    }

    // MARK: commands to the page

    /// Fly to a node (switching page and loading its board if needed) and select it.
    func reveal(_ id: String, board: String?) {
        run("{cmd:'reveal',id:\(jsString(id)),board:\(board.map(jsString) ?? "null")}")
    }

    func goToMain(_ c: ContextInfo) {
        guard let m = c.main else { return }
        reveal(m.focus, board: m.board)
    }

    /// Click a library row: highlight everything that uses it, or clear when it was already open.
    func toggleUsage(_ item: LibItem) {
        if activeUsage == item.id { clearUsage(); return }
        activeUsage = item.id
        usage = nil
        run("{cmd:'usage',kind:\(jsString(item.kind)),key:\(jsString(item.key))}")
    }

    func clearUsage() {
        guard activeUsage != nil || usage != nil else { return }
        activeUsage = nil
        usage = nil
        run("{cmd:'clearUsage'}")
    }

    /// "Select all instances": there is no multi-select, so the instances are highlighted and counted.
    /// "Select all instances": the instances on this page become the selection (the page goes to them).
    func highlightInstances(of family: ContextInfo.Family) {
        usageLabel = family.name
        activeUsage = nil
        run("{cmd:'usage',kind:'component',key:\(jsString(family.id)),fly:true,select:true}")
    }

    /// "Reset all changes": an instance's overrides, or those of a layer inside one (src/overrides.ts).
    /// With `keys`, only those properties (a reset of one property; "descendants": every layer inside).
    func resetOverrides(_ id: String, keys: [String] = []) {
        let list = keys.map(jsString).joined(separator: ",")
        run("{cmd:'resetOverrides',id:\(jsString(id))\(keys.isEmpty ? "" : ",keys:[\(list)]")}")
    }

    /// Instance swap: the instances point at `component`; text overrides carry over where layer names match.
    func swapInstances(_ ids: [String], to component: String) {
        run("{cmd:'swapInstance',ids:[\(ids.map(jsString).joined(separator: ","))],component:\(jsString(component))}")
    }

    /// "Push changes to main component": the instance's overrides become its main's own values.
    func pushOverrides(_ id: String) {
        run("{cmd:'pushOverrides',id:\(jsString(id))}")
    }

    /// A Components panel row starts a drag: the page learns which component, since WebKit
    /// shows it a drag from the shell as "Files" without its data, and drops an instance where the pointer lets go;
    /// with Option held over an instance, it swaps that instance (src/page/drops.js).
    func beginComponentDrag(_ c: Component) -> NSItemProvider {
        run("{cmd:'componentDrag',id:\(jsString(c.id)),name:\(jsString(c.name))}")
        return WidgetDrag(component: c.id).provider()
    }

    /// The components an instance can swap to: every other component in the file, by name.
    func swapTargets(excluding current: String?) -> [Component] {
        components.filter { $0.id != current && !$0.id.isEmpty }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func revealInBoards(_ board: String) {
        section = .boards
        revealBoardId = board
    }

    // MARK: the right-click menu

    /// The canvas menu on a layer: its own items (component, video) first, then the Edit menu's commands with
    /// their shortcuts, then the ones only this menu has. The edit items go to the Edit menu's target (one path).
    func showContextMenu(at point: CGPoint, for c: ContextInfo, under: [UnderLayer] = []) {
        let menu = ContextMenuBuilder(model: self, at: point)
        var head = false
        // Select layer: every layer under the pointer, topmost first; picking one selects it.
        if under.count > 1 {
            menu.submenu("Select layer") { m in
                for l in under {
                    m.action(l.name, symbol: UnderLayer.symbol(l.type), on: self.selection.map { s in (s.ids.isEmpty ? [s.id] : s.ids).contains(l.id) } ?? false) {
                        self.run("{cmd:'selectLayer',id:\(jsString(l.id))}")
                    }
                }
            }
            head = true
        }
        if c.canGoToMain {
            menu.action("Go to main component") { self.goToMain(c) }
            head = true
        }
        if let f = c.family {
            menu.action(f.instances > 0 ? "Select all instances (\(f.instances))" : "Select all instances", enabled: f.instances > 0) { self.highlightInstances(of: f) }
            head = true
        }
        if c.kind == "instance" || c.kind == "inside-instance" {
            menu.action("Reset all changes") { self.resetOverrides(c.id) }
            head = true
        }
        if c.kind == "instance" {
            let targets = swapTargets(excluding: c.main?.id)
            if !targets.isEmpty {
                menu.submenu("Swap instance") { m in
                    for t in targets { m.action(t.name) { self.swapInstances([c.id], to: t.id) } }
                }
            }
            // A nested instance swaps (an override in its outer instance) but pushes from the outer one.
            if !c.id.contains("/") { menu.action("Push changes to main component") { self.pushOverrides(c.id) } }
        }
        if c.media {
            menu.action("Embed video here…") { self.embedVideo(over: c.id, hint: c.videoHint) }
            head = true
        }
        if head { menu.separator() }
        let targets = exportTargets(c)
        for (k, group) in ContextMenuLayout.node.enumerated() {
            for e in group { menu.edit(e) }
            // Copy/Paste as, after the clipboard items: the layer (or the selection it is in) as a picture,
            // vector or code on the clipboard, and its link.
            if k == 0 {
                menu.submenu("Copy as") { m in
                    for f in CopyAs.formats {
                        if f.id == "png" { m.action(f.title, key: "c", mods: [.command, .shift]) { self.copyAs("png", ids: targets) } }
                        else { m.action(f.title) { self.copyAs(f.id, ids: targets) } }
                        if f.id == "svg" { m.separator() }
                    }
                    m.separator()
                    m.action("Copy link", key: "l", mods: .command) { self.run("{cmd:'copyLink'}") }
                }
            }
            // Several layers or boards, the click inside them: Align, distribute and tidy up (ArrangeActions).
            if k == 3, let sel = selection, ArrangeActions.shows(count: sel.ids.count), sel.ids.contains(c.id) {
                menu.submenu("Align") { m in
                    for group in [ArrangeActions.align, ArrangeActions.spread] {
                        for a in group {
                            let key = ArrangeActions.menuKey(a)
                            var mods: NSEvent.ModifierFlags = []
                            for mod in key?.mods ?? [] {
                                switch mod { case .command: mods.insert(.command); case .option: mods.insert(.option); case .shift: mods.insert(.shift); case .control: mods.insert(.control) }
                            }
                            m.action(a.title, enabled: ArrangeActions.enabled(a, count: sel.ids.count, free: sel.free), key: key?.key ?? "", mods: mods, symbol: a.symbol) {
                                // Shift held on an align item: align to the parent frame, as the Arrange menu does.
                                let toParent = a.op.hasPrefix("align-") && NSEvent.modifierFlags.contains(.shift)
                                self.run("{cmd:'shortcut',op:'\(a.op)\(toParent ? ":parent" : "")'}")
                            }
                        }
                        m.separator()
                    }
                }
            }
            menu.separator()
        }
        // Export the layer, or the whole selection when the click was inside it (src/export.ts).
        menu.submenu("Export as PNG") { m in
            for ch in ExportNaming.png { m.action(ch.title) { self.exportLayers(targets, name: c.name, format: "png", choice: ch) } }
            m.separator()
            for ch in ExportNaming.presets { m.action(ch.title) { self.exportLayers(targets, name: c.name, format: "png", choice: ch) } }
        }
        menu.submenu("Export as") { m in
            m.action("SVG") { self.exportLayers(targets, name: c.name, format: "svg", choice: nil) }
            m.action("PDF") { self.exportLayers(targets, name: c.name, format: "pdf", choice: nil) }
            m.separator()
            for f in ["jpg", "webp"] {
                for ch in ExportNaming.png { m.action("\(ExportSettings.title(f)) \(ch.title)") { self.exportLayers(targets, name: c.name, format: f, choice: ch) } }
                m.separator()
            }
        }
        menu.action("Export with settings\u{2026}", key: "e", mods: [.command, .shift]) { self.exportWithSettings(targets) }
        menu.separator()
        menu.action("Copy ID") { self.copy(c.id, "ID") }
        menu.action("Copy name") { self.copy(c.name, "name") }
        menu.separator()
        menu.action("Zoom to fit selection", key: "2", mods: .shift) { self.run("{cmd:'zoomSel'}") }
        if c.type == "frame" || c.type == "text", !c.id.contains("/") {
            // Resize to fit (Opt+Cmd+Shift+R on the canvas); src/page/live.js.
            menu.action("Resize to fit content", key: "r", mods: [.command, .option, .shift]) { self.run("{cmd:'fitContent'}") }
        }
        menu.action("Reveal in Boards list") { self.revealInBoards(c.board) }
        contextOnLayer = true
        menu.pop(in: webView)
        contextOnLayer = false
    }

    /// Right-click on empty canvas: Paste here, Select all, Zoom to fit (the page).
    func showCanvasMenu(at point: CGPoint) {
        let menu = ContextMenuBuilder(model: self, at: point)
        for group in ContextMenuLayout.canvas {
            for e in group { menu.edit(e) }
            menu.separator()
        }
        menu.action("Zoom to fit", key: "1", mods: .shift) { self.fitPage() }
        menu.pop(in: webView)
    }

    /// The layers a right-click on `c` exports: the selection when the click was inside a multi-selection, else that layer. Cards do not export.
    func exportTargets(_ c: ContextInfo) -> [String] {
        if let s = selection, s.ids.count > 1, s.ids.contains(c.id) { return s.ids.filter { !$0.hasPrefix("widget:") } }
        return [c.id]
    }

    /// Export as PNG or SVG: one layer asks where to save it (named after it), several ask for a folder. The last folder is remembered.
    func exportLayers(_ ids: [String], name: String, format: String, choice: ExportNaming.Choice?) {
        guard let file = currentFile, !ids.isEmpty else { return }
        let key = "canvas.exportFolder"
        let last = UserDefaults.standard.string(forKey: key).map { URL(fileURLWithPath: $0, isDirectory: true) }
        var body: [String: Any] = ["file": file, "ids": ids, "format": format]
        if let s = choice?.scale { body["scale"] = s }
        if let p = choice?.preset { body["preset"] = p }
        if ids.count == 1 {
            let panel = NSSavePanel()
            panel.title = "Export as \(ExportSettings.title(format))"
            panel.nameFieldStringValue = ExportNaming.fileName(name, format: format, choice: choice)
            panel.allowedContentTypes = [UTType(filenameExtension: format) ?? .data]
            panel.canCreateDirectories = true
            if let last, FileManager.default.fileExists(atPath: last.path) { panel.directoryURL = last }
            guard panel.runModal() == .OK, let url = panel.url else { return }
            UserDefaults.standard.set(url.deletingLastPathComponent().path, forKey: key)
            body["path"] = url.path
        } else {
            let panel = NSOpenPanel()
            panel.title = "Export as \(ExportSettings.title(format))"
            panel.message = "Choose a folder for \(ids.count) files, named after the layers."
            panel.prompt = "Export"
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            if let last, FileManager.default.fileExists(atPath: last.path) { panel.directoryURL = last }
            guard panel.runModal() == .OK, let url = panel.url else { return }
            UserDefaults.standard.set(url.path, forKey: key)
            body["dir"] = url.path
        }
        postExport(body)
    }

    /// The export request: a toast while it runs, then what was written or why not.
    private func postExport(_ body: [String: Any]) {
        flash("Exporting\u{2026}", durationMs: 0)
        var req = URLRequest(url: base.appendingPathComponent("api/export"))
        req.httpMethod = "POST"
        req.timeoutInterval = 180
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            DispatchQueue.main.async {
                guard (200..<300).contains(status), let files = json["files"] as? [[String: Any]], let first = files.first?["path"] as? String else {
                    self.flash(json["error"] as? String ?? "Could not export")
                    return
                }
                self.flash(files.count == 1 ? "Exported \(URL(fileURLWithPath: first).lastPathComponent)" : "Exported \(files.count) files", level: "success")
            }
        }.resume()
    }

    /// Shift+Cmd+E (File > Export, a bulk export): the selected layers, or with nothing selected every layer
    /// on the page that has export settings, each exported with its settings (one 1x PNG without) into a folder.
    func exportSelectionWithSettings() {
        if let s = selection {
            exportWithSettings((s.ids.isEmpty ? [s.id] : s.ids).filter { !$0.hasPrefix("widget:") })
            return
        }
        guard let file = currentFile else { return }
        Task { @MainActor in
            let ids = await self.layersWithSettings(file: file)
            if ids.isEmpty { self.flash("Nothing to export: select layers, or add export settings to layers in the Export section"); return }
            self.exportWithSettings(ids)
        }
    }

    /// Layers on the shown page whose metadata has export settings (GET /api/export-settings).
    private func layersWithSettings(file: String) async -> [String] {
        var c = URLComponents(url: base.appendingPathComponent("api/export-settings"), resolvingAgainstBaseURL: false)!
        c.setQuery([URLQueryItem(name: "file", value: file), URLQueryItem(name: "boards", value: boards.map(\.id).joined(separator: ","))])
        guard let url = c.url, let (data, _) = try? await URLSession.shared.data(from: url),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        return j["ids"] as? [String] ?? []
    }

    /// Export these layers with their saved settings into a folder (one file per setting, named with its suffix).
    func exportWithSettings(_ ids: [String]) {
        guard let file = currentFile, !ids.isEmpty else { return }
        Task { @MainActor in
            let nodes = await self.nodes(file: file, ids: ids)
            let items = ExportSettings.items(ids.map { id in (id, nodes[id] ?? [:]) })
            let panel = NSOpenPanel()
            panel.title = "Export"
            panel.message = items.count == 1 ? "Choose a folder for 1 file." : "Choose a folder for \(items.count) files, named after the layers."
            panel.prompt = "Export"
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            let key = "canvas.exportFolder"
            if let last = UserDefaults.standard.string(forKey: key), FileManager.default.fileExists(atPath: last) { panel.directoryURL = URL(fileURLWithPath: last, isDirectory: true) }
            #if CANVAS_QA
            if let dir = QA.exportFolder { self.postExport(["file": file, "items": items, "dir": dir]); return }
            #endif
            guard panel.runModal() == .OK, let url = panel.url else { return }
            UserDefaults.standard.set(url.path, forKey: key)
            self.postExport(["file": file, "items": items, "dir": url.path])
        }
    }

    /// The file's own props of some layers (GET /api/node per id), for their export settings.
    func nodes(file: String, ids: [String]) async -> [String: [String: Any]] {
        var out: [String: [String: Any]] = [:]
        for id in ids {
            if let s = selection, s.id == id, s.ids.count <= 1 { out[id] = s.node; continue }
            var c = URLComponents(url: base.appendingPathComponent("api/node"), resolvingAgainstBaseURL: false)!
            c.setQuery([URLQueryItem(name: "file", value: file), URLQueryItem(name: "id", value: id), URLQueryItem(name: "depth", value: "0")])
            guard let url = c.url, let (data, _) = try? await URLSession.shared.data(from: url),
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            out[id] = j["node"] as? [String: Any] ?? [:]
        }
        return out
    }

    /// Copy as (Copy/Paste as): the layers as a 2x PNG, SVG, CSS, SwiftUI or text on the pasteboard
    /// (POST /api/copy-as, src/copy-as.ts). A PNG goes on as PNG and TIFF, so every app takes it; SVG as text and
    /// as an SVG image.
    func copyAs(_ format: String, ids: [String]) {
        guard let file = currentFile else { return }
        let layers = ids.filter { !$0.hasPrefix("widget:") }
        guard !layers.isEmpty else { flash(ids.isEmpty ? "Select a layer or board to copy" : "Cards cannot be copied as an image or code"); return }
        var req = URLRequest(url: base.appendingPathComponent("api/copy-as"))
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["file": file, "ids": layers, "format": format, "scale": 2])
        copyToken += 1
        let token = copyToken
        // A big selection takes a moment: say so if it is not done quickly.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { if self.copyToken == token, self.copyBusy { self.flash("Copying\u{2026}", durationMs: 0) } }
        copyBusy = true
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            DispatchQueue.main.async {
                guard token == self.copyToken else { return }
                self.copyBusy = false
                guard (200..<300).contains(status) else { self.flash(json["error"] as? String ?? "Could not copy"); return }
                let pb = canvasPasteboard
                pb.clearContents()
                if let b64 = json["data"] as? String, let png = Data(base64Encoded: b64) {
                    pb.declareTypes([.png, .tiff], owner: nil)
                    pb.setData(png, forType: .png)
                    if let rep = NSBitmapImageRep(data: png), let tiff = rep.tiffRepresentation { pb.setData(tiff, forType: .tiff) }
                } else if let text = json["text"] as? String {
                    if format == "svg" {
                        pb.declareTypes([.string, NSPasteboard.PasteboardType(UTType.svg.identifier)], owner: nil)
                        pb.setData(Data(text.utf8), forType: NSPasteboard.PasteboardType(UTType.svg.identifier))
                    }
                    pb.setString(text, forType: .string)
                } else { self.flash("Could not copy"); return }
                self.flash(CopyAs.toast(format, count: layers.count), durationMs: 2500, level: "success")
            }
        }.resume()
    }

    private func copy(_ text: String, _ what: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        flash("Copied \(what)")
    }
}

final class MenuAction: NSObject, NSMenuItemValidation {
    let run: () -> Void
    let enabled: Bool
    init(_ run: @escaping () -> Void, enabled: Bool = true) { self.run = run; self.enabled = enabled }
    @objc func fire() { run() }
    func validateMenuItem(_ item: NSMenuItem) -> Bool { enabled }
}

/// Builds one right-click menu. Edit items carry the Edit menu's selectors and target, so the Edit menu's
/// validation enables them and the same code runs whichever menu was used.
@MainActor final class ContextMenuBuilder {
    let menu = NSMenu()
    private let model: CanvasModel
    private let at: CGPoint
    private var keep: [MenuAction] = []

    init(model: CanvasModel, at: CGPoint) {
        self.model = model
        self.at = at
        menu.autoenablesItems = true
    }

    func action(_ title: String, enabled: Bool = true, key: String = "", mods: NSEvent.ModifierFlags = [], symbol: String? = nil, on: Bool = false, _ run: @escaping () -> Void) {
        let a = MenuAction(run, enabled: enabled)
        keep.append(a)
        let item = NSMenuItem(title: title, action: #selector(MenuAction.fire), keyEquivalent: key)
        item.keyEquivalentModifierMask = mods
        if let symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
        if on { item.state = .on }
        item.target = a
        item.representedObject = a
        menu.addItem(item)
    }

    func edit(_ e: ContextMenuLayout.Entry) {
        let item = NSMenuItem(title: e.title, action: NSSelectorFromString(e.selector), keyEquivalent: e.key)
        var mods: NSEvent.ModifierFlags = []
        if e.command { mods.insert(.command) }
        if e.option { mods.insert(.option) }
        if e.shift { mods.insert(.shift) }
        item.keyEquivalentModifierMask = mods
        item.target = model.editTarget
        if e.selector == "pasteHere:" { item.representedObject = NSValue(point: at) }
        menu.addItem(item)
    }

    /// An item that opens a submenu built by `build`.
    func submenu(_ title: String, _ build: (ContextMenuBuilder) -> Void) {
        let sub = ContextMenuBuilder(model: model, at: at)
        build(sub)
        while sub.menu.items.last?.isSeparatorItem == true { sub.menu.removeItem(at: sub.menu.items.count - 1) }
        keep.append(contentsOf: sub.keep)
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = sub.menu
        menu.addItem(item)
    }

    /// A separator, never two in a row and never first.
    func separator() {
        guard let last = menu.items.last, !last.isSeparatorItem else { return }
        menu.addItem(.separator())
    }

    func pop(in view: NSView) {
        while menu.items.last?.isSeparatorItem == true { menu.removeItem(at: menu.items.count - 1) }
        menu.popUp(positioning: nil, at: at, in: view)
        withExtendedLifetime(keep) {}
    }
}

// MARK: the library

/// Variables or Styles: a search field, then entries grouped by type and name family.
struct TokenLibrary: View {
    @ObservedObject var model: CanvasModel
    let styles: Bool
    @State private var query = ""
    @State private var open: Set<String> = []
    @State private var closedSections: Set<String> = []

    private var themed: Bool { model.themes.count > 1 }

    var body: some View {
        let q = query.trimmingCharacters(in: .whitespaces)
        SearchField(prompt: styles ? "Search text styles" : "Search variables", text: $query).padding(.horizontal, 4).padding(.bottom, 4)
        if styles {
            let list = filter(model.styleEntries, q)
            if list.isEmpty { empty(q) }
            ForEach(list) { e in entryView(e, searching: !q.isEmpty) }
        } else {
            if themed { themeHeader }
            let sections = model.tokenSections.map { s in LibSection(id: s.id, title: s.title, entries: filter(s.entries, q)) }.filter { !$0.entries.isEmpty }
            if sections.isEmpty { empty(q) }
            ForEach(sections) { s in
                let folded = closedSections.contains(s.id) && q.isEmpty
                Button { withAnimation(Motion.fast) { toggle(&closedSections, s.id) } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(folded ? 0 : 90))
                            .foregroundStyle(Palette.mutedFg).frame(width: 10)
                        Text(s.title.uppercased()).font(Typography.section).tracking(0.6).foregroundStyle(Palette.mutedFg).qaText(s.title)
                        Spacer(minLength: 0)
                        Text("\(s.itemCount)").font(Typography.micro).monospacedDigit().foregroundStyle(Palette.mutedFg)
                    }
                    .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 2).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if !folded { ForEach(s.entries) { e in entryView(e, searching: !q.isEmpty) } }
            }
        }
    }

    private func empty(_ q: String) -> some View {
        Text(q.isEmpty ? (styles ? "No text in this file." : "No variables in this file.") : "Nothing matches \u{201C}\(q)\u{201D}.")
            .font(Typography.body).foregroundStyle(Palette.mutedFg).frame(maxWidth: .infinity, alignment: .leading).padding(12)
    }

    /// Light and dark labels above the swatch columns.
    private var themeHeader: some View {
        HStack(spacing: 4) {
            Spacer(minLength: 0)
            ForEach(Array(model.themes.prefix(3)), id: \.self) { t in
                Text(t.capitalized).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).fixedSize().frame(width: ThemeColumns.width, alignment: .center)
            }
            Color.clear.frame(width: ThemeColumns.countWidth)
        }
        .padding(.horizontal, 12).padding(.top, 2)
    }

    private func toggle(_ set: inout Set<String>, _ id: String) { if set.contains(id) { set.remove(id) } else { set.insert(id) } }

    private func matches(_ i: LibItem, _ q: String) -> Bool {
        i.title.localizedCaseInsensitiveContains(q) || i.values.contains { $0.value.localizedCaseInsensitiveContains(q) }
    }

    /// Search keeps the items that match; a group whose own name matches keeps all its items.
    private func filter(_ entries: [LibEntry], _ q: String) -> [LibEntry] {
        guard !q.isEmpty else { return entries }
        return entries.compactMap { e in
            if e.isGroup && e.title.localizedCaseInsensitiveContains(q) { return e }
            let items = e.items.filter { matches($0, q) }
            return items.isEmpty ? nil : LibEntry(id: e.id, title: e.title, items: items, isGroup: e.isGroup)
        }
    }

    @ViewBuilder private func entryView(_ e: LibEntry, searching: Bool) -> some View {
        if e.isGroup {
            let isOpen = open.contains(e.id) || searching
            Button { withAnimation(Motion.fast) { toggle(&open, e.id) } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(isOpen ? 90 : 0))
                        .foregroundStyle(Palette.mutedFg).frame(width: 10)
                    Text(e.title).font(Typography.body).foregroundStyle(Palette.fg).lineLimit(1)
                    Spacer(minLength: 8)
                    Text("\(e.items.count)").font(Typography.micro).monospacedDigit().foregroundStyle(Palette.mutedFg)
                }
                .padding(.horizontal, 12).frame(height: Metric.row).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isOpen { ForEach(e.items) { i in LibRow(model: model, item: i, indent: 16, themed: themed && !styles) } }
        } else {
            LibRow(model: model, item: e.items[0], indent: 0, themed: themed && !styles, top: true)
        }
    }
}

enum ThemeColumns {
    static let width: CGFloat = 26
    static let countWidth: CGFloat = 30
    /// 999, 1.2k, 12k: counts stay on one line in the narrow column.
    static func compact(_ n: Int) -> String {
        if n < 1000 { return "\(n)" }
        if n < 10_000 { let k = (Double(n) / 100).rounded() / 10; return k == k.rounded() ? "\(Int(k))k" : "\(k)k" }
        return "\(n / 1000)k"
    }
}

/// One variable or style. Click highlights its usages on the canvas and lists them below.
struct LibRow: View {
    @ObservedObject var model: CanvasModel
    let item: LibItem
    let indent: CGFloat
    let themed: Bool
    var top = false
    @State private var hovering = false

    private var active: Bool { model.activeUsage == item.id }

    var body: some View {
        VStack(spacing: 0) {
            Button { model.toggleUsage(item) } label: {
                HStack(spacing: 6) {
                    if item.kind == "style" {
                        if let c = item.swatch.flatMap(parseColor) { ColorChip(color: c) } else { Image(systemName: "textformat").glyph(11).foregroundStyle(Palette.mutedFg).frame(width: 14) }
                    }
                    Text(top || item.kind == "style" && indent == 0 ? item.title : item.leaf).font(Typography.body).fontWeight(active ? .semibold : nil)
                        .foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.middle).qaText(top || item.kind == "style" && indent == 0 ? item.title : item.leaf)
                    Spacer(minLength: 6)
                    values
                    Text(ThemeColumns.compact(item.count)).lineLimit(1).font(Typography.micro).monospacedDigit().foregroundStyle(item.count == 0 ? Palette.mutedFg.opacity(0.5) : Palette.mutedFg)
                        .frame(width: ThemeColumns.countWidth, alignment: .trailing)
                }
                .padding(.leading, 12 + indent).padding(.trailing, 12).frame(height: Metric.row)
                .background(RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).fill(active ? Palette.active : hovering ? Palette.hover : .clear))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(helpText)
            .onHover { h in withAnimation(Motion.fast) { hovering = h } }
            if active { UsageList(model: model) }
        }
    }

    private var helpText: String {
        let v = item.values.map { $0.theme.isEmpty ? $0.value : "\($0.theme): \($0.value)" }.joined(separator: "   ")
        return item.kind == "style" ? "\(item.title)\nUsed by \(item.count)" : "\(item.title)\n\(v)\nUsed by \(item.count)"
    }

    /// Swatches side by side for colours (one per theme), the value for anything else.
    @ViewBuilder private var values: some View {
        if item.kind == "variable" {
            if item.type == "color" {
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
                    .foregroundStyle(Palette.mutedFg).lineLimit(1).truncationMode(.tail).frame(maxWidth: 90, alignment: .trailing)
            }
        }
    }
}

/// Where a library row is used: what the canvas highlights, each one a link that flies to it.
struct UsageList: View {
    @ObservedObject var model: CanvasModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let u = model.usage {
                Text(caption(u)).font(Typography.micro).foregroundStyle(Palette.mutedFg).padding(.horizontal, 12).padding(.vertical, 4)
                ForEach(u.items.prefix(30)) { i in
                    Button { model.reveal(i.id, board: i.board) } label: {
                        HStack(spacing: 6) {
                            Text(i.name).font(Typography.body).foregroundStyle(Palette.fg).lineLimit(1)
                            Spacer(minLength: 6)
                            Text(i.boardName).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1)
                        }
                        .padding(.horizontal, 12).frame(height: 24).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if u.items.count > 30 { Text("and \(u.total - 30) more").font(Typography.micro).foregroundStyle(Palette.mutedFg).padding(.horizontal, 12).padding(.vertical, 4) }
            } else {
                Text("Looking\u{2026}").font(Typography.micro).foregroundStyle(Palette.mutedFg).padding(.horizontal, 12).padding(.vertical, 4)
            }
        }
        .padding(.leading, 12).padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func caption(_ u: UsageState) -> String {
        if u.total == 0 { return "Not used" }
        let uses = u.total == 1 ? "1 use" : "\(u.total) uses"
        if u.onPage < u.total { return "\(uses), \(u.onPage) on this page, highlighted on the canvas" }
        return "\(uses), highlighted on the canvas"
    }
}

/// The drag image of a Components panel row: the purple diamond and the component's name on a card, lifted by
/// shadows, centred under the pointer where the instance's middle lands.
struct ComponentDragPreview: View {
    let name: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "diamond.fill").font(.system(size: GlyphSize.row, weight: .medium)).foregroundStyle(Palette.component)
            Text(name).font(Typography.body).foregroundStyle(Palette.fg).lineLimit(1)
        }
        .padding(.horizontal, 12).frame(height: Metric.row)
        .background(RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).fill(Palette.popover)
            .shadow(color: .black.opacity(0.08), radius: 0.5, y: 0.5)
            .shadow(color: .black.opacity(0.12), radius: 6, y: 3))
    }
}
