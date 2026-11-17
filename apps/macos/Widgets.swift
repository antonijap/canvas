// Widgets in the shell: the types the page and server speak, the model calls that edit them,
// the rail panel (add, list) and the inspector generated from each kind's field list.

import AppKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: Types

struct WidgetInfo: Identifiable {
    let id: String
    var kind: String
    var name: String
    var x: Double, y: Double, w: Double, h: Double
    var locked: Bool
    var config: [String: Any]

    init?(_ m: [String: Any]) {
        guard let id = m["id"] as? String, let kind = m["kind"] as? String else { return nil }
        func d(_ k: String) -> Double { (m[k] as? NSNumber)?.doubleValue ?? 0 }
        self.id = id; self.kind = kind
        name = m["name"] as? String ?? ""
        x = d("x"); y = d("y"); w = d("w"); h = d("h")
        locked = m["locked"] as? Bool ?? false
        config = m["config"] as? [String: Any] ?? [:]
    }
}

struct WidgetFieldInfo: Identifiable {
    enum Kind: String { case text, textarea, number, select, bool, secret, url }
    var id: String { key }
    let key: String
    let label: String
    let type: Kind
    let options: [(value: String, label: String)]
    let help: String?

    init?(_ m: [String: Any]) {
        guard let key = m["key"] as? String else { return nil }
        self.key = key
        label = m["label"] as? String ?? key
        type = Kind(rawValue: m["type"] as? String ?? "text") ?? .text
        help = (m["help"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        options = (m["options"] as? [Any] ?? []).compactMap { o in
            if let s = o as? String { return (s, s) }
            if let d = o as? [String: Any], let v = d["value"] {
                return ("\(v)", d["label"] as? String ?? "\(v)")
            }
            return nil
        }
    }
}

struct WidgetKindInfo: Identifiable {
    let id: String
    let title: String
    let symbol: String
    let minSize: CGSize
    let fields: [WidgetFieldInfo]
    let defaults: [String: Any]

    init?(_ m: [String: Any]) {
        guard let id = m["id"] as? String else { return nil }
        func size(_ v: Any?) -> CGSize {
            if let d = v as? [String: Any] { return CGSize(width: (d["w"] as? NSNumber)?.doubleValue ?? 0, height: (d["h"] as? NSNumber)?.doubleValue ?? 0) }
            if let a = v as? [NSNumber], a.count == 2 { return CGSize(width: a[0].doubleValue, height: a[1].doubleValue) }
            return .zero
        }
        self.id = id
        title = m["title"] as? String ?? id
        symbol = m["symbol"] as? String ?? "square"
        minSize = size(m["minSize"])
        fields = (m["fields"] as? [[String: Any]] ?? []).compactMap(WidgetFieldInfo.init)
        defaults = m["defaults"] as? [String: Any] ?? [:]
    }
}

struct WidgetStatus {
    let id: String
    let state: String
    let error: String?
    let display: String?
    let updatedAt: Date?

    init?(_ m: [String: Any]) {
        guard let id = m["id"] as? String else { return nil }
        self.id = id
        state = m["state"] as? String ?? "loading"
        if let e = m["error"] as? String { error = e }
        else if let e = m["error"] as? [String: Any] { error = e["message"] as? String ?? e["code"] as? String }
        else { error = nil }
        display = m["display"] as? String
        updatedAt = (m["updatedAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
    }
}

// MARK: Config paths

/// "auth.type" + value becomes ["auth": ["type": value]].
func nestedPatch(_ key: String, _ value: Any) -> [String: Any] {
    key.split(separator: ".").reversed().reduce(value) { [String($1): $0] } as? [String: Any] ?? [:]
}

/// Objects merge, everything else replaces, NSNull deletes. Same rule as the server's PATCH.
func deepMerge(_ base: [String: Any], _ patch: [String: Any]) -> [String: Any] {
    var out = base
    for (k, v) in patch {
        if v is NSNull { out.removeValue(forKey: k) }
        else if let pv = v as? [String: Any], let bv = out[k] as? [String: Any] { out[k] = deepMerge(bv, pv) }
        else { out[k] = v }
    }
    return out
}

func configValue(_ config: [String: Any], _ key: String) -> Any? {
    var cur: Any? = config
    for part in key.split(separator: ".") { cur = (cur as? [String: Any])?[String(part)] }
    return cur is NSNull ? nil : cur
}

func jsString(_ s: String) -> String {
    (try? JSONSerialization.data(withJSONObject: [s], options: []))
        .flatMap { String(data: $0, encoding: .utf8) }
        .map { String($0.dropFirst().dropLast()) } ?? "''"
}

// MARK: Model

extension CanvasModel {
    func widgetURL(_ path: String, query: [URLQueryItem] = [], file: Bool = true) -> URL? {
        var c = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        var items = query
        if file { guard let f = currentFile else { return nil }; items.append(URLQueryItem(name: "file", value: f)) }
        c?.setQuery(items)
        return c?.url
    }

    /// Sends one request with the CSRF header. `done` runs on main with the decoded body or the server's error text.
    func widgetCall(_ method: String, _ path: String, body: [String: Any]? = nil, file: Bool = true,
                            done: @escaping (Result<[String: Any], WidgetCallError>) -> Void) {
        guard let url = widgetURL(path, file: file) else { done(.failure(WidgetCallError(message: "No file is open", status: 0))); return }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        URLSession.shared.dataTask(with: req) { data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            DispatchQueue.main.async {
                if (200..<300).contains(status) { done(.success(json)) }
                else { done(.failure(WidgetCallError(message: json["error"] as? String ?? error?.localizedDescription ?? "Request failed", status: status))) }
            }
        }.resume()
    }

    func fetchKinds() {
        guard let url = widgetURL("api/widgets/kinds", file: false) else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data, let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
            let kinds = list.compactMap(WidgetKindInfo.init)
            DispatchQueue.main.async { if !kinds.isEmpty { self.widgetKinds = kinds } }
        }.resume()
    }

    func addWidget(_ kind: String) { run("{cmd:'addWidget',kind:\(jsString(kind))}") }

    /// A Widgets panel row or shader tile dropped on the canvas at `at` (web view points): the page centres the
    /// card there, in world space, as one undo step. Returns false for anything that is not one of ours.
    /// A Widgets panel row or shader tile dropped on the canvas at `at` (web view points). Returns false for
    /// anything that is not one of ours.
    func dropWidget(_ providers: [NSItemProvider], at: CGPoint) -> Bool {
        let type = UTType.canvasWidgetDrag.identifier
        guard let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(type) }) else { return false }
        let gen = docGeneration
        p.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
            guard let data else { return }
            DispatchQueue.main.async {
                // Another document opened while the payload loaded: it was not dropped on that one.
                guard self.docGeneration == gen else { return }
                _ = self.dropWidget(data, at: at)
            }
        }
        return true
    }

    /// A Widgets panel row or shader tile starts a drag: the page learns which one, because WebKit hands the
    /// page a drag from the shell as "Files" without its data. The page drops it where the pointer lets go.
    func beginWidgetDrag(_ d: WidgetDrag) -> NSItemProvider {
        let what = d.preset.map { "preset:\(jsString($0))" } ?? "kind:\(jsString(d.kind ?? ""))"
        run("{cmd:'widgetDrag',\(what)}")
        return d.provider()
    }

    /// The page centres the card at `at`, in world space, as one undo step.
    func dropWidget(_ data: Data, at: CGPoint) -> Bool {
        // A component row's drag is the page's to drop (it knows the component from beginComponentDrag).
        guard let d = try? JSONDecoder().decode(WidgetDrag.self, from: data), d.component == nil else { return false }
        let what = d.preset.map { "preset:\(jsString($0))" } ?? "kind:\(jsString(d.kind ?? ""))"
        run("{cmd:'dropWidget',\(what),x:\(Double(at.x)),y:\(Double(at.y))}")
        return true
    }

    /// A shader card's WGSL (the file beside the widgets; the template for a card never saved).
    func loadShaderSource(_ id: String, done: @escaping (String?) -> Void) {
        // (ShaderSection keys each load by file, card and revision and drops an answer for another one.)
        guard let url = widgetURL("api/shaders/\(id)/source") else { done(nil); return }
        URLSession.shared.dataTask(with: url) { data, response, _ in
            let ok = ((response as? HTTPURLResponse)?.statusCode ?? 0) == 200
            let text = ok ? data.flatMap { String(data: $0, encoding: .utf8) } : nil
            DispatchQueue.main.async { done(text) }
        }.resume()
    }

    /// Saves a shader card's source (or other shader fields). The page compiles the new revision; its
    /// errors arrive through the widget status.
    func updateShader(_ id: String, _ patch: [String: Any]) {
        if EditGesture.previewOnly { return } // a scrub's in-between values only preview canvas nodes
        let file = currentFile
        widgetCall("PUT", "api/shaders/\(id)", body: patch) { [weak self] r in
            guard let self else { return }
            switch r {
            case .success(let j):
                // Another document may be open by now, with a widget of the same id: its list is not this one's.
                guard self.currentFile == file else { return }
                if let w = (j["widget"] as? [String: Any]).flatMap(WidgetInfo.init), let i = self.widgets.firstIndex(where: { $0.id == id }) { self.widgets[i] = w }
            case .failure(let e): self.flash(e.message)
            }
        }
    }
    func revealWidget(_ id: String) { run("{cmd:'revealWidget',id:\(jsString(id))}") }

    // MARK: video cards

    /// Asks for a video file, starting where `hint` points (a path a caption names, "Desktop/..." is under home).
    func pickVideo(hint: String?, done: @escaping (URL) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose a video. It is copied into the canvas."
        panel.prompt = "Embed"
        var types: [UTType] = [.mpeg4Movie, .quickTimeMovie, .movie]
        if let webm = UTType(filenameExtension: "webm") { types.append(webm) }
        panel.allowedContentTypes = types
        if let h = hint, !h.isEmpty {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let url = h.hasPrefix("/") ? URL(fileURLWithPath: h) : h.hasPrefix("~/") ? home.appendingPathComponent(String(h.dropFirst(2))) : home.appendingPathComponent(h)
            panel.directoryURL = url.deletingLastPathComponent()
            if FileManager.default.fileExists(atPath: url.path) { panel.nameFieldStringValue = url.lastPathComponent }
        }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        done(url)
    }

    /// "Embed video here": a video card exactly over the node, linked so it moves with the board.
    func embedVideo(over node: String, hint: String?) {
        pickVideo(hint: hint) { url in
            self.run("{cmd:'embedVideo',node:\(jsString(node)),path:\(jsString(url.path))}")
        }
    }

    /// Plays another file on a video card (copied in like a new one).
    func replaceVideo(_ id: String, hint: String?) {
        pickVideo(hint: hint) { [weak self] url in
            let file = self?.currentFile
            self?.widgetCall("PUT", "api/videos/\(id)", body: ["path": url.path]) { [weak self] r in
                guard let self else { return }
                switch r {
                case .success(let j):
                    guard self.currentFile == file else { return }
                    if let w = (j["widget"] as? [String: Any]).flatMap(WidgetInfo.init), let i = self.widgets.firstIndex(where: { $0.id == id }) { self.widgets[i] = w }
                case .failure(let e): self.flash(e.message)
                }
            }
        }
    }

    /// The file a video card plays: a relative src lives in the package (or beside a loose file).
    func videoURL(_ src: String) -> URL? {
        guard !src.isEmpty else { return nil }
        if src.hasPrefix("/") { return URL(fileURLWithPath: src) }
        guard let f = currentFile else { return nil }
        let doc = URL(fileURLWithPath: f)
        let base = doc.pathExtension == "canvas" ? doc : doc.deletingLastPathComponent()
        return base.appendingPathComponent(src).standardizedFileURL
    }

    /// Shows the change at once, sends it, and puts the old value back with a toast if the server refuses.
    func updateWidget(_ id: String, _ patch: [String: Any]) {
        if EditGesture.previewOnly { return } // a scrub's in-between values only preview canvas nodes
        guard let i = widgets.firstIndex(where: { $0.id == id }) else { return }
        let old = widgets[i]
        var w = old
        if let v = patch["name"] as? String { w.name = v }
        if let v = (patch["x"] as? NSNumber)?.doubleValue { w.x = v }
        if let v = (patch["y"] as? NSNumber)?.doubleValue { w.y = v }
        if let v = (patch["w"] as? NSNumber)?.doubleValue { w.w = v }
        if let v = (patch["h"] as? NSNumber)?.doubleValue { w.h = v }
        if let v = patch["locked"] as? Bool { w.locked = v }
        if let c = patch["config"] as? [String: Any] { w.config = deepMerge(w.config, c) }
        widgets[i] = w
        let file = currentFile
        widgetCall("PATCH", "api/widgets/\(id)", body: patch) { [weak self] r in
            guard let self, case .failure(let e) = r else { return }
            if self.currentFile == file, let j = self.widgets.firstIndex(where: { $0.id == id }) { self.widgets[j] = old }
            self.flash(e.message)
        }
    }

    func deleteWidget(_ id: String) {
        let file = currentFile
        widgetCall("DELETE", "api/widgets/\(id)") { [weak self] r in
            guard let self else { return }
            switch r {
            case .success:
                guard self.currentFile == file else { return }
                self.widgets.removeAll { $0.id == id }
                if self.selectedWidgetId == id { self.selectedWidgetId = nil; self.widgetStatus = nil; self.deselect() }
            case .failure(let e): self.flash(e.message)
            }
        }
    }

    func refreshWidget(_ id: String, quiet: Bool = false) {
        widgetCall("POST", "api/widgets/\(id)/refresh", body: [:]) { [weak self] r in
            guard let self, case .failure(let e) = r, !quiet else { return }
            self.flash(e.status == 429 ? "Refreshed a moment ago, try again in a few seconds" : e.message)
        }
    }

    func trustWidget(_ id: String) {
        widgetCall("POST", "api/widgets/\(id)/trust", body: [:]) { [weak self] r in
            guard let self else { return }
            switch r {
            case .success(let j):
                self.flash("Allowed \(j["origin"] as? String ?? "origin")")
                self.refreshWidget(id, quiet: true)
            case .failure(let e): self.flash(e.message)
            }
        }
    }

    func secretPresent(service: String, account: String) async -> Bool? {
        var c = URLComponents(url: base.appendingPathComponent("api/widgets/secret-status"), resolvingAgainstBaseURL: false)
        c?.setQuery([URLQueryItem(name: "service", value: service), URLQueryItem(name: "account", value: account)])
        guard let url = c?.url, let (data, _) = try? await URLSession.shared.data(from: url),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return j["present"] as? Bool
    }

    /// Writes to the Keychain off the main thread. Calls back with whether it landed.
    func saveSecret(service: String, account: String, secret: String, done: @escaping (Bool) -> Void) {
        Task.detached {
            let ok = KeychainStore.set(service: service, account: account, secret: secret)
            // The server caches a secret it has read; a replaced one must be read again, not the old value.
            if ok { await self.forgetCachedSecret(service: service, account: account) }
            await MainActor.run { if !ok { self.flash("Could not save to the Keychain") }; done(ok) }
        }
    }

    /// Tells the server the Keychain item changed, so its cached copy is dropped. Sends only the item's name.
    func forgetCachedSecret(service: String, account: String) async {
        var req = URLRequest(url: base.appendingPathComponent("api/widgets/secret-changed"))
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["service": service, "account": account])
        _ = try? await URLSession.shared.data(for: req)
    }
}

struct WidgetCallError: Error { let message: String; let status: Int }

// MARK: Drag to the canvas

/// What a Widgets panel row (a kind) or a shader tile (a Paper preset) carries in a drag. The web view under the
/// pointer takes the drop: CanvasModel.beginWidgetDrag tells the page which card it is, since WebKit shows the page
/// this drag as "Files" without its data. Visibility .all: an .ownProcess representation never reaches the drag
/// pasteboard, so the drag carried nothing a view could accept.
struct WidgetDrag: Codable {
    var kind: String?
    var preset: String?
    /// A Components panel row: the component an instance of which the page drops (src/page/drops.js).
    var component: String?

    func provider() -> NSItemProvider {
        let p = NSItemProvider()
        let data = (try? JSONEncoder().encode(self)) ?? Data()
        p.registerDataRepresentation(forTypeIdentifier: UTType.canvasWidgetDrag.identifier, visibility: .all) { done in
            done(data, nil); return nil
        }
        return p
    }
}

extension UTType {
    static let canvasWidgetDrag = UTType(exportedAs: "cc.getcanvas.canvas.widget-drag")
}

/// The drag image: the row's icon and title on a card-like chip, centred under the pointer where the card lands.
struct WidgetDragPreview: View {
    let title: String
    let symbol: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).railGlyph().foregroundStyle(Palette.mutedFg)
            Text(title).font(Typography.body).foregroundStyle(Palette.fg)
        }
        .padding(.horizontal, 12).frame(height: Metric.row)
        .background(RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).fill(Palette.popover))
        .overlay(RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).stroke(Palette.stroke, lineWidth: 1))
    }
}

// MARK: Rail panel

struct WidgetsPanel: View {
    @ObservedObject var model: CanvasModel

    var body: some View {
        SectionHeader(title: "Add")
        ForEach(model.widgetKinds) { k in
            // Click: the card goes in the middle of the view. Drag: it goes where it is dropped.
            ListRow(title: k.title, symbol: k.symbol, bounces: true, railGlyph: true) { model.addWidget(k.id) }
                .onDrag { model.beginWidgetDrag(WidgetDrag(kind: k.id)) } preview: { WidgetDragPreview(title: k.title, symbol: k.symbol) }
        }
        if model.widgetKinds.isEmpty {
            Text("Open a canvas to add widgets.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 6)
        }
        PaperShadersGrid(model: model)
        SectionHeader(title: "On this canvas")
        ForEach(model.widgets) { w in
            let kind = model.widgetKinds.first { $0.id == w.kind }
            ListRow(title: w.name.isEmpty ? (kind?.title ?? w.kind) : w.name, detail: kind?.title ?? w.kind, symbol: kind?.symbol ?? "square", railGlyph: true) {
                model.revealWidget(w.id)
            }
        }
        if model.widgets.isEmpty {
            Text("No widgets yet.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 6)
        }
    }
}

// MARK: Inspector

struct WidgetInspector: View {
    @ObservedObject var model: CanvasModel
    let widgetId: String

    private var widget: WidgetInfo? { model.widgets.first { $0.id == widgetId } }

    var body: some View {
        if let w = widget {
            let kind = model.widgetKinds.first { $0.id == w.kind }
            VStack(spacing: 0) {
                header(w, kind)
                position(w, kind)
                if let kind {
                    ForEach(groups(kind), id: \.title) { g in
                        InspectorSection(title: g.title) {
                            if g.first { nameField(w) }
                            ForEach(g.fields.filter { visible($0, w) }) { f in
                                WidgetFieldRow(model: model, widget: w, field: f, kind: kind)
                            }
                        }
                    }
                } else {
                    InspectorSection(title: "Widget") { nameField(w) }
                }
                if w.kind == "shader" { ShaderSection(model: model, widget: w) }
                if w.kind == "video" { VideoSection(model: model, widget: w) }
                WidgetStatusSection(model: model, widget: w, kind: kind)
            }
            .padding(.bottom, 8)
        }
    }

    private func header(_ w: WidgetInfo, _ kind: WidgetKindInfo?) -> some View {
        HStack(spacing: 8) {
            Image(systemName: kind?.symbol ?? "square").railGlyph().foregroundStyle(Palette.mutedFg)
            Text(w.name.isEmpty ? (kind?.title ?? w.kind) : w.name).font(Typography.title).foregroundStyle(Palette.fg).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 10)
    }

    private func position(_ w: WidgetInfo, _ kind: WidgetKindInfo?) -> some View {
        let minW = Double(kind?.minSize.width ?? 0), minH = Double(kind?.minSize.height ?? 0)
        return InspectorSection(title: "Position") {
            HStack(spacing: 8) {
                NumberField(prefix: "X", value: w.x, enabled: !w.locked) { model.updateWidget(w.id, ["x": $0]) }
                NumberField(prefix: "Y", value: w.y, enabled: !w.locked) { model.updateWidget(w.id, ["y": $0]) }
            }
            HStack(spacing: 8) {
                NumberField(prefix: "W", value: w.w, enabled: !w.locked) { model.updateWidget(w.id, ["w": max($0, minW)]) }
                NumberField(prefix: "H", value: w.h, enabled: !w.locked) { model.updateWidget(w.id, ["h": max($0, minH)]) }
            }
            CheckField(title: "Lock position and size", isOn: w.locked) { model.updateWidget(w.id, ["locked": $0]) }
        }
    }

    private func nameField(_ w: WidgetInfo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Name").font(Typography.micro).foregroundStyle(Palette.mutedFg)
            TextInputField(placeholder: "Name", value: w.name) { model.updateWidget(w.id, ["name": $0]) }
        }
    }

    struct Group { let title: String; let first: Bool; let fields: [WidgetFieldInfo] }

    /// Undotted fields share the kind's own section (with the name); each dotted prefix gets one of its own.
    private func groups(_ kind: WidgetKindInfo) -> [Group] {
        var order: [String] = [], map: [String: [WidgetFieldInfo]] = [:]
        for f in kind.fields {
            let g = f.key.contains(".") ? humanize(String(f.key.split(separator: ".")[0])) : kind.title
            if map[g] == nil { order.append(g) }
            map[g, default: []].append(f)
        }
        if map[kind.title] == nil { order.insert(kind.title, at: 0); map[kind.title] = [] }
        else { order.removeAll { $0 == kind.title }; order.insert(kind.title, at: 0) }
        return order.map { Group(title: $0, first: $0 == kind.title, fields: map[$0] ?? []) }
    }

    /// Hides fields that do not apply to the current choice (auth header, insight versus query).
    private func visible(_ f: WidgetFieldInfo, _ w: WidgetInfo) -> Bool {
        let c = w.config
        let authType = configValue(c, "auth.type") as? String
        switch f.key {
        case "auth.header": return authType == "header"
        case "auth.secret": return authType != nil && authType != "none"
        case let k where k.hasPrefix("insight."): return (configValue(c, "source") as? String ?? "insight") == "insight"
        case let k where k.hasPrefix("query."): return (configValue(c, "source") as? String) == "query"
        default: return true
        }
    }
}

private func humanize(_ s: String) -> String {
    var out = ""
    for ch in s { if ch.isUppercase && !out.isEmpty { out += " " }; out.append(ch) }
    return out.prefix(1).uppercased() + out.dropFirst().lowercased()
}

/// One generated control for one field.
struct WidgetFieldRow: View {
    @ObservedObject var model: CanvasModel
    let widget: WidgetInfo
    let field: WidgetFieldInfo
    let kind: WidgetKindInfo

    private var raw: Any? { configValue(widget.config, field.key) ?? configValue(kind.defaults, field.key) }
    private func set(_ v: Any) { model.updateWidget(widget.id, ["config": nestedPatch(field.key, v)]) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if field.type != .bool { Text(field.label).font(Typography.micro).foregroundStyle(Palette.mutedFg) }
            control
            if let h = field.help {
                Text(h).font(Typography.micro).foregroundStyle(Palette.mutedFg).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private var control: some View {
        switch field.type {
        case .text, .url:
            TextInputField(placeholder: field.label, value: raw as? String ?? "", monospaced: field.type == .url) { set($0) }
        case .textarea:
            TextAreaField(placeholder: field.label, value: raw as? String ?? "") { set($0) }
        case .number:
            NumberField(prefix: "#", value: (raw as? NSNumber)?.doubleValue) { v in
                // 1e20 is whole but no Int: JSONNumber keeps it a Double instead of trapping.
                if let j = JSONNumber.value(v) { set(j) }
            }
        case .select:
            let current = raw.map { "\($0)" } ?? ""
            MenuField(title: field.options.first { $0.value == current }?.label ?? (current.isEmpty ? "Choose" : current)) {
                ForEach(field.options, id: \.value) { o in Button(o.label) { set(o.value) } }
            }
        case .bool:
            CheckField(title: field.label, isOn: raw as? Bool ?? false) { set($0) }
        case .secret:
            WidgetSecretRow(model: model, widget: widget, field: field)
        }
    }
}

/// A secret setting. The config holds only the Keychain item's name; the value goes straight to the Keychain.
struct WidgetSecretRow: View {
    @ObservedObject var model: CanvasModel
    let widget: WidgetInfo
    let field: WidgetFieldInfo
    @State private var present: Bool?

    private var ref: (service: String, account: String) {
        if let d = configValue(widget.config, field.key) as? [String: Any],
           let s = d["service"] as? String, let a = d["account"] as? String { return (s, a) }
        return ("canvas-widget", "\(widget.id).\(field.key)")
    }

    var body: some View {
        let r = ref
        SecretField(present: present) { secret in
            model.saveSecret(service: r.service, account: r.account, secret: secret) { ok in
                guard ok else { return }
                present = true
                if configValue(widget.config, field.key) as? [String: Any] == nil {
                    model.updateWidget(widget.id, ["config": nestedPatch(field.key, ["service": r.service, "account": r.account])])
                }
                model.refreshWidget(widget.id, quiet: true)
            }
        }
        .task(id: "\(r.service)/\(r.account)") { present = await model.secretPresent(service: r.service, account: r.account) }
    }
}

struct WidgetStatusSection: View {
    @ObservedObject var model: CanvasModel
    let widget: WidgetInfo
    let kind: WidgetKindInfo?

    private var status: WidgetStatus? { model.widgetStatus?.id == widget.id ? model.widgetStatus : nil }
    private var isLive: Bool { widget.kind != "todo" && widget.kind != "note" && widget.kind != "shader" && widget.kind != "video" }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    // The poller has no "refreshing" state: a manual refresh spins until a newer reading arrives (10 s cap).
    @State private var refreshPressed: Date?
    private var refreshing: Bool {
        if status?.state == "loading" { return true }
        guard let p = refreshPressed, Date().timeIntervalSince(p) < 10 else { return false }
        return (status?.updatedAt ?? .distantPast) < p
    }

    var body: some View {
        // Notes, to-dos, shaders and videos have no live reading: no Status block (its "State Ok" read as debug
        // output), only Delete.
        if isLive { live } else {
            HStack {
                PillButton(title: "Delete", style: .destructive) { model.deleteWidget(widget.id) }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .overlay(alignment: .top) { Rectangle().fill(Palette.stroke).frame(height: 1).padding(.horizontal, 12) }
        }
    }

    private var live: some View {
        InspectorSection(title: "Status") {
            if let s = status {
                KeyValueRow(key: "State", value: humanize(s.state.replacingOccurrences(of: "-", with: " ")))
                if let d = s.display, !d.isEmpty { KeyValueRow(key: "Value", value: d) }
                if let t = s.updatedAt {
                    TimelineView(.periodic(from: .now, by: 5)) { ctx in
                        KeyValueRow(key: "Updated", value: Self.ago(ctx.date.timeIntervalSince(t)))
                    }
                }
                if let e = s.error, !e.isEmpty {
                    Text(e).font(Typography.micro).foregroundStyle(Palette.danger)
                        .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if s.state == "needs-approval", let origin = approvalOrigin {
                    PillButton(title: "Allow \(origin)", style: .primary) { model.trustWidget(widget.id) }
                }
            } else {
                Text("No data yet.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
            }
            HStack(spacing: 8) {
                if isLive {
                    HStack(spacing: 4) {
                        PillButton(title: "Refresh now") {
                            refreshPressed = Date()
                            model.refreshWidget(widget.id)
                            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { refreshPressed = nil }
                        }
                        if refreshing {
                            Image(systemName: "arrow.clockwise").symbolRenderingMode(.hierarchical)
                                .symbolEffect(.rotate, isActive: !reduceMotion)
                                .font(.system(size: 11, weight: .medium)).foregroundStyle(Palette.mutedFg)
                        }
                    }
                }
                PillButton(title: "Delete", style: .destructive) { model.deleteWidget(widget.id) }
            }
        }
    }

    static func ago(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s)s ago" }
        if s < 3600 { return "\(s / 60)m ago" }
        return "\(s / 3600)h ago"
    }

    /// The origin the secret would be sent to: the app's URL origin, or PostHog's host.
    private var approvalOrigin: String? {
        let c = widget.config
        if let u = configValue(c, "url") as? String, let url = URL(string: u), let h = url.host, let sch = url.scheme {
            return "\(sch)://\(h)\(url.port.map { ":\($0)" } ?? "")"
        }
        if let h = configValue(c, "host") as? String {
            switch h {
            case "us": return "https://us.posthog.com"
            case "eu": return "https://eu.posthog.com"
            default: return h
            }
        }
        return nil
    }
}

// MARK: Shader cards

/// The source editor (monospaced; saved when it loses focus), play and pause, and Run after a GPU reset.
/// Compile errors with their line numbers show in the Status section below.
struct ShaderSection: View {
    @ObservedObject var model: CanvasModel
    let widget: WidgetInfo
    /// The source loaded for one file, card and revision (`sourceKey`). An answer for any other key is dropped:
    /// this view outlives a selection change, and a late load must never land in (and be saved into) another card.
    @State private var loaded: (key: String, source: ShaderSource)?

    private var autoplay: Bool { configValue(widget.config, "autoplay") as? Bool ?? true }
    private var quarantined: Bool { configValue(widget.config, "quarantined") as? Bool ?? false }
    private var rev: String { configValue(widget.config, "rev") as? String ?? "" }

    @State private var showSource = false
    private var paper: [String: Any]? { configValue(widget.config, "paper") as? [String: Any] }

    private var sourceKey: String { "\(model.currentFile ?? "")\u{1F}\(widget.id)\u{1F}\(rev)" }
    private var source: ShaderSource { loaded.flatMap { $0.key == sourceKey ? $0.source : nil } ?? .loading }

    var body: some View {
        if let paper { PaperSection(model: model, widget: widget, paper: paper) }
        InspectorSection(title: "Shader") {
            HStack(spacing: 8) {
                PillButton(title: autoplay ? "Pause" : "Play") { model.updateWidget(widget.id, ["config": ["autoplay": !autoplay]]) }
                if quarantined {
                    PillButton(title: "Run", style: .primary) { model.updateWidget(widget.id, ["config": ["quarantined": false]]) }
                }
                Spacer(minLength: 0)
            }
            if quarantined {
                Text("Stopped: it was running when the GPU reset. Run tries it again.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if paper != nil && !showSource {
                // Generated from Paper's GLSL: editing it turns the card into plain WGSL.
                PillButton(title: "Edit as WGSL") { showSource = true }
            } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(paper != nil ? "WGSL (generated; saving it detaches the preset)" : "WGSL: fn shade(p: vec2<f32>) -> vec4<f32>").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                switch source {
                case .loaded(let text):
                    let key = sourceKey, id = widget.id
                    TextAreaField(placeholder: "fn shade(p: vec2<f32>) -> vec4<f32> { ... }", value: text, minHeight: Metric.field * 12, monospaced: true) { text in
                        if loaded?.key == key { loaded = (key, .loaded(text)) }
                        model.updateShader(id, ["source": text])
                    }
                    // A fresh field per card: a draft typed for one card is never committed into the next.
                    .id(key)
                case .failed:
                    // Not an empty editor: saving it would replace the card's real source with what was typed.
                    HStack(spacing: 8) {
                        Text("Could not load the source.").font(Typography.micro).foregroundStyle(Palette.danger)
                        Spacer(minLength: 0)
                        PillButton(title: "Retry") { load() }
                    }
                case .loading:
                    Text("Loading…").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                }
            }
            }
        }
        .task(id: sourceKey) { load() }
    }

    private func load() {
        let key = sourceKey
        loaded = (key, .loading)
        model.loadShaderSource(widget.id) { text in
            guard loaded?.key == key else { return }
            loaded = (key, text.map(ShaderSource.loaded) ?? .failed)
        }
    }
}

/// A shader card's source in the inspector: still loading, failed (nothing to edit), or loaded.
enum ShaderSource: Equatable { case loading, failed, loaded(String) }

// MARK: Video cards

/// The file (name, where it lives, Reveal in Finder, Choose another) and the node it follows. Loop, autoplay,
/// muted and poster time are the kind's own fields above; playing state shows in the Status section.
struct VideoSection: View {
    @ObservedObject var model: CanvasModel
    let widget: WidgetInfo

    private var src: String { configValue(widget.config, "src") as? String ?? "" }
    private var link: String? { configValue(widget.config, "link") as? String }

    var body: some View {
        let url = model.videoURL(src)
        let exists = url.map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        InspectorSection(title: "File") {
            if let url {
                KeyValueRow(key: "File", value: url.lastPathComponent)
                Text(src.hasPrefix("/") ? "Linked: \(url.path)" : "In this canvas: \(src)")
                    .font(Typography.micro).foregroundStyle(exists ? Palette.mutedFg : Palette.danger)
                    .lineLimit(2).truncationMode(.middle).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !exists {
                    Text("The file is missing.").font(Typography.micro).foregroundStyle(Palette.danger)
                }
            } else {
                Text("No video file yet.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
            }
            HStack(spacing: 8) {
                PillButton(title: url == nil ? "Choose File…" : "Replace…", style: url == nil ? .primary : .ghost) { model.replaceVideo(widget.id, hint: url?.path) }
                if let url, exists {
                    PillButton(title: "Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                }
                Spacer(minLength: 0)
            }
            if let link {
                HStack(spacing: 8) {
                    Text("Follows node \(link)").font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1)
                    Spacer(minLength: 0)
                    PillButton(title: "Unlink") { model.updateWidget(widget.id, ["config": ["link": NSNull()]]) }
                }
            }
        }
    }
}
