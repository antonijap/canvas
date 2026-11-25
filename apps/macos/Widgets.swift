// Widgets in the shell: the types the page and server speak, the model calls that edit them,
// the rail panel (add, list) and the inspector generated from each kind's field list.

import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

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
    let description: String
    let cardSubtitle: String
    let isLocal: Bool
    let previewHTML: String?
    let inPicker: Bool
    let live: Bool
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
        description = m["description"] as? String ?? ""
        cardSubtitle = m["cardSubtitle"] as? String ?? description
        isLocal = m["local"] as? Bool ?? false
        previewHTML = m["previewHTML"] as? String
        inPicker = m["picker"] as? Bool ?? true
        live = m["live"] as? Bool ?? false
        minSize = size(m["minSize"])
        fields = (m["fields"] as? [[String: Any]] ?? []).compactMap(WidgetFieldInfo.init)
        defaults = m["defaults"] as? [String: Any] ?? [:]
    }
}

struct WidgetStatus {
    let id: String
    let state: String
    let error: String?
    let approvalTarget: String?
    let display: String?
    let updatedAt: Date?

    init?(_ m: [String: Any]) {
        guard let id = m["id"] as? String else { return nil }
        self.id = id
        state = m["state"] as? String ?? "loading"
        if let e = m["error"] as? String { error = e }
        else if let e = m["error"] as? [String: Any] { error = e["message"] as? String ?? e["code"] as? String }
        else { error = nil }
        approvalTarget = m["approvalTarget"] as? String
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
        guard let url = widgetURL("api/widgets/kinds", query: [URLQueryItem(name: "view", value: "picker")], file: false) else { return }
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

    func trustWidget(_ id: String, target: String?) {
        widgetCall("POST", "api/widgets/\(id)/trust", body: target.map { ["target": $0] } ?? [:]) { [weak self] r in
            guard let self else { return }
            switch r {
            case .success(let j):
                self.flash("Allowed \(j["target"] as? String ?? j["origin"] as? String ?? "source")")
                if target == nil { self.refreshWidget(id, quiet: true) }
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

struct WidgetPickerTile: View {
    let kind: WidgetKindInfo
    var active = false
    var sidebar = false
    let action: () -> Void
    @State private var hovering = false

    private var fullPreview: Bool { sidebar && !kind.isLocal }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: fullPreview ? 2 : 3) {
                Group {
                    if let html = kind.previewHTML {
                        LocalWidgetPreview(html: html).allowsHitTesting(false)
                    } else {
                        WidgetThumbnail(kind: kind.id)
                    }
                }
                    .frame(height: fullPreview ? 72 : 40)
                    .qaID("widget-preview-" + kind.id)
                    .accessibilityHidden(true)
                Text(kind.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.fg)
                    .lineLimit(1).padding(.top, fullPreview ? 2 : 0).qaText(kind.title)
                Text(fullPreview ? kind.cardSubtitle : kind.description)
                    .font(.system(size: fullPreview ? 11 : 12)).foregroundStyle(Palette.mutedFg)
                    .lineLimit(fullPreview ? 1 : 2).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .frame(height: fullPreview ? nil : 90, alignment: .topLeading)
            .padding(fullPreview ? 0 : 6)
            .background(fullPreview ? .clear : active ? Palette.active : hovering ? Palette.hover : Palette.field,
                        in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(kind.description)
        .qaID("widget-tile-" + kind.id)
        .accessibilityLabel(kind.title)
        .accessibilityHint(kind.description)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

struct WidgetThumbnail: View {
    let kind: String

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width / 112, size.height / 72)
            var context = context
            context.translateBy(x: (size.width - 112 * scale) / 2, y: (size.height - 72 * scale) / 2)
            context.scaleBy(x: scale, y: scale)
            WidgetArtwork(context: context).draw(kind)
        }
        .background {
            if kind != "shader" && kind != "video" {
                LinearGradient(colors: [.white.opacity(0.07), .white.opacity(0.02)],
                               startPoint: .top, endPoint: .bottom)
                    .background(Color.black.opacity(0.18))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .shadow(color: kind == "shader" ? .clear : .black.opacity(0.28), radius: 3, y: 2)
    }
}

private struct WidgetArtwork {
    let context: GraphicsContext

    private let amber = Color(light: 0xF2B84B, dark: 0xF2B84B)
    private let green = Color(light: 0x4CC38A, dark: 0x4CC38A)
    private let red = Color(light: 0xF2555A, dark: 0xF2555A)
    private let panel = Color(light: 0x2C2C31, dark: 0x2C2C31)
    private let ink = Color.white.opacity(0.96)
    private let muted = Color.white.opacity(0.55)
    private let faint = Color.white.opacity(0.25)
    private let paper = Color(light: 0xECECEE, dark: 0xECECEE)
    private let blackInk = Color(light: 0x18181B, dark: 0x18181B)
    private var dataInk: Color { context.environment.colorScheme == .dark ? ink : blackInk }
    private var dataLabel: Color { context.environment.colorScheme == .dark ? muted : hex(0x52525B) }
    private var dataTrack: Color { context.environment.colorScheme == .dark ? .white.opacity(0.10) : .black.opacity(0.10) }

    func draw(_ kind: String) {
        switch kind {
        case "todo": todo()
        case "note": note()
        case "shader": shader()
        case "video": video()
        case "git-status": git()
        case "ci": ci()
        case "claude-usage": usage()
        case "metric": metric()
        case "page-preview": pagePreview()
        case "disk-space": disk()
        default:
            box(16, 15, 80, 42, panel, radius: 5)
            box(23, 23, 34, 4, muted, radius: 1)
            box(23, 33, 64, 13, faint, radius: 2)
        }
    }

    private func todo() {
        miniPanel(10, 9, 92, 58)
        for (index, title) in ["Ship the sidebar", "Review cards", "Plan next steps"].enumerated() {
            let y = CGFloat(22 + 16 * index)
            if index == 0 {
                circle(22, y, 4, amber)
                line([CGPoint(x: 20, y: y), CGPoint(x: 21.5, y: y + 1.5), CGPoint(x: 24, y: y - 1.5)], blackInk, width: 0.65)
            } else {
                context.stroke(Path(ellipseIn: CGRect(x: 17.5, y: y - 4.5, width: 9, height: 9)), with: .color(faint), lineWidth: 1)
            }
            text(title, 32, y, size: 7, color: index == 0 ? faint : ink, crossedOut: index == 0)
        }
    }

    private func note() {
        box(24, 10, 64, 68, paper, radius: 5, shadow: true)
        text("Field notes", 31, 22, size: 8, color: blackInk, weight: .bold)
        rules(31, 31, color: .black.opacity(0.2), widths: [48, 42, 46])
        gradient(31, 48, 50, 20, [0xF7C475, 0xDB8057, 0x523056], radius: 2)
    }

    private func shader() {
        box(0, 0, 112, 72, hex(0x171425))
        for (x, y, radius, color) in [(31.0, 25.0, 41.0, amber), (69, 10, 30, hex(0xBA64B9)), (87, 54, 41, hex(0x378C92))] {
            context.fill(Path(CGRect(x: 0, y: 0, width: 112, height: 72)),
                         with: .radialGradient(Gradient(colors: [color.opacity(0.83), color.opacity(0)]),
                                               center: CGPoint(x: x, y: y), startRadius: 0, endRadius: radius))
        }
        box(6, 52, 45, 14, .black.opacity(0.46), radius: 4)
        text("fn shade", 11, 59, size: 7, color: ink, mono: true)
    }

    private func video() {
        gradient(0, 0, 112, 72, [0x2E3A55, 0x734A5B, 0x473134])
        circle(56, 34, 12, .white.opacity(0.23))
        var play = context.resolve(Image(systemName: "play.fill").symbolRenderingMode(.monochrome))
        play.shading = .color(ink)
        context.draw(play, in: CGRect(x: 52, y: 30, width: 8, height: 8))
        text("1:36", 88, 55, size: 6.5, color: .white.opacity(0.76))
        box(8, 62, 96, 2, faint, radius: 1)
        box(8, 62, 38, 2, .white, radius: 1)
    }

    private func git() {
        miniPanel(8, 6, 96, 60)
        text("main", 26, 18, size: 8, color: ink, weight: .bold)
        branch(16, 18)
        text("+12", 70, 18, size: 7, color: green, mono: true)
        text("\u{2212}3", 86, 18, size: 7, color: red, mono: true)
        for (index, entry) in [("M", "Sidebar.swift", amber), ("A", "cards.ts", green), ("D", "old-rail.ts", red)].enumerated() {
            let y = CGFloat(34 + index * 12)
            text(entry.0, 15, y, size: 7, color: entry.2, mono: true)
            text(entry.1, 26, y, size: 7, color: index == 2 ? faint : ink)
        }
    }

    private func ci() {
        miniPanel(8, 8, 96, 56)
        ring(11, 20, 3.4, from: 0, to: 360, color: green, width: 0.65)
        line([CGPoint(x: 9.5, y: 20), CGPoint(x: 10.6, y: 21), CGPoint(x: 12.6, y: 18.8)], green, width: 0.65)
        ring(11, 36, 3.4, from: 0, to: 280, color: amber, width: 0.65)
        text("Build", 19, 21, size: 7, color: ink)
        text("Tests", 19, 37, size: 7, color: ink)
        text("2m", 80, 21, size: 7, color: faint)
        text("run", 78, 37, size: 7, color: faint)
        box(15, 46, 82, 0.5, faint)
        branch(11, 56)
        text("Slim sidebar", 19, 56, size: 7, color: ink)
        text("#128", 76, 56, size: 7, color: faint)
    }

    private func usage() {
        ring(34, 36, 20, from: 0, to: 360, color: dataTrack, width: 4)
        ring(34, 36, 20, from: -62, to: 90, color: amber, width: 4)
        text("42%", 22, 37, size: 10, color: dataInk, weight: .bold)
        text("Session", 66, 25, size: 7, color: dataLabel)
        text("Resets 3h", 66, 36, size: 7, color: dataInk)
        box(66, 46, 36, 3, dataTrack, radius: 1.5)
        box(66, 46, 7, 3, dataLabel, radius: 1.5)
    }

    private func metric() {
        text("12.4k", 10, 17, size: 15, color: dataInk, weight: .bold)
        text("+8.2%", 58, 17, size: 7, color: Color(light: 0x166534, dark: 0x4CC38A), mono: true)
        text("Visitors, 7 days", 10, 32, size: 6.5, color: dataLabel)
        let points = [66, 62, 64, 56, 58, 50, 53, 46, 48].enumerated().map {
            CGPoint(x: $0.offset * 14, y: $0.element)
        }
        var area = trace(points)
        area.addLine(to: CGPoint(x: 112, y: 72))
        area.addLine(to: CGPoint(x: 0, y: 72))
        area.closeSubpath()
        context.fill(area, with: .color(amber.opacity(0.24)))
        line(points, amber, width: 1.2)
        circle(98, 46, 5, amber.opacity(0.26))
        circle(98, 46, 3, amber)
    }

    private func pagePreview() {
        let page = Path(roundedRect: CGRect(x: 10, y: 9, width: 92, height: 63), cornerRadius: 5)
        box(10, 9, 92, 63, hex(0xF8F8F8), radius: 5, shadow: true)
        var clipped = context
        clipped.clip(to: page)
        let detail = WidgetArtwork(context: clipped)
        detail.box(10, 9, 92, 11, hex(0xE2E2E5))
        detail.circle(16, 14.5, 1.4, red)
        detail.circle(21, 14.5, 1.4, amber)
        detail.circle(26, 14.5, 1.4, green)
        detail.box(39, 11, 42, 7, .white, radius: 4)
        detail.text("example.com", 38, 15, size: 6, color: .black.opacity(0.64), mono: true)
        detail.text("Plans for studios", 18, 30, size: 7, color: blackInk, weight: .bold)
        detail.rules(18, 37, color: .black.opacity(0.19), widths: [56, 44])
        detail.box(18, 50, 26, 8, blackInk, radius: 4)
        for x in [18.0, 44, 70] { detail.box(x, 63, 24, 15, x == 44 ? hex(0xFFF5E2) : .white, radius: 2, shadow: true) }
    }

    private func disk() {
        text("214 GB", 10, 19, size: 14, color: dataInk, weight: .bold)
        text("free of 1 TB", 10, 34, size: 7, color: dataLabel)
        let track = Path(roundedRect: CGRect(x: 10, y: 44, width: 92, height: 6), cornerRadius: 3)
        context.fill(track, with: .color(dataTrack))
        var clipped = context
        clipped.clip(to: track)
        let bars = WidgetArtwork(context: clipped)
        bars.box(10, 44, 26, 6, amber)
        bars.box(37, 44, 18, 6, dataLabel)
        bars.box(56, 44, 24, 6, dataLabel.opacity(0.45))
        text("Apps", 10, 59, size: 6, color: dataLabel)
        text("Docs", 34, 59, size: 6, color: dataLabel)
        text("System", 56, 59, size: 6, color: dataLabel)
    }

    private func hex(_ value: UInt32) -> Color { Color(light: value, dark: value) }

    private func text(_ value: String, _ x: CGFloat, _ y: CGFloat, size: CGFloat, color: Color,
                      weight: Font.Weight = .semibold, mono: Bool = false, crossedOut: Bool = false) {
        let glyphs = Text(value).font(.system(size: size, weight: weight, design: mono ? .monospaced : .default))
            .tracking(0.35).foregroundColor(color).strikethrough(crossedOut)
        context.draw(glyphs, at: CGPoint(x: x, y: y), anchor: .leading)
    }

    private func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ color: Color,
                     radius: CGFloat = 0, shadow: Bool = false) {
        let shape = Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: radius)
        var ctx = context
        if shadow { ctx.addFilter(.shadow(color: .black.opacity(0.28), radius: 3, y: 2)) }
        ctx.fill(shape, with: .color(color))
    }

    private func miniPanel(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) {
        box(x, y, w, h, panel, radius: 5, shadow: true)
    }

    private func gradient(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ colors: [UInt32], radius: CGFloat = 0) {
        let shape = Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: radius)
        context.fill(shape, with: .linearGradient(Gradient(colors: colors.map(hex)),
                                                  startPoint: CGPoint(x: x, y: y), endPoint: CGPoint(x: x, y: y + h)))
    }

    private func circle(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat, _ color: Color) {
        context.fill(Path(ellipseIn: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)), with: .color(color))
    }

    private func ring(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat, from: Double, to: Double, color: Color, width: CGFloat) {
        var path = Path()
        path.addArc(center: CGPoint(x: x, y: y), radius: radius, startAngle: .degrees(from), endAngle: .degrees(to), clockwise: false)
        context.stroke(path, with: .color(color), lineWidth: width)
    }

    private func trace(_ points: [CGPoint]) -> Path {
        Path { path in
            path.move(to: points[0])
            path.addLines(Array(points.dropFirst()))
        }
    }

    private func line(_ points: [CGPoint], _ color: Color, width: CGFloat) {
        context.stroke(trace(points), with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
    }

    private func rules(_ x: CGFloat, _ y: CGFloat, color: Color, widths: [CGFloat]) {
        for (i, width) in widths.enumerated() { box(x, y + CGFloat(i * 5), width, 2, color, radius: 1) }
    }

    private func branch(_ x: CGFloat, _ y: CGFloat) {
        line([CGPoint(x: x, y: y + 2), CGPoint(x: x, y: y - 2), CGPoint(x: x + 4, y: y - 3)], muted, width: 0.75)
        for (dx, dy) in [(0.0, 2.0), (0, -2), (4, -3)] { circle(x + dx, y + dy, 1, muted) }
    }
}

private struct LocalWidgetPreview: NSViewRepresentable {
    let html: String

    final class Coordinator: NSObject, WKNavigationDelegate {
        var html: String?
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(action.targetFrame?.isMainFrame == true && action.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        guard context.coordinator.html != html else { return }
        context.coordinator.html = html
        view.loadHTMLString("""
            <!doctype html><meta charset="utf-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
            <meta name="color-scheme" content="light dark">
            <style>body{margin:0;padding:4px 8px;font:12px system-ui;overflow:hidden}</style>
            \(html)
            """, baseURL: nil)
    }
}

// MARK: Rail panel

struct WidgetsPanel: View {
    @ObservedObject var model: CanvasModel

    static let columns = [GridItem(.flexible(), spacing: Metric.sidebarInset, alignment: .top), GridItem(.flexible(), alignment: .top)]

    private func grid(_ kinds: [WidgetKindInfo], builtIn: Bool = false) -> some View {
        LazyVGrid(columns: Self.columns, alignment: .leading, spacing: builtIn ? 14 : 8) {
            ForEach(kinds) { kind in
                WidgetPickerTile(kind: kind, sidebar: builtIn) { model.addWidget(kind.id) }
                    .onDrag { model.beginWidgetDrag(WidgetDrag(kind: kind.id)) } preview: {
                        WidgetThumbnail(kind: kind.id).frame(width: builtIn ? 112 : 110, height: builtIn ? 72 : 68)
                    }
            }
        }
        .padding(.horizontal, Metric.sidebarInset)
        .padding(.bottom, 8)
    }

    var body: some View {
        SidebarGroupLabel(title: "Add", inset: Metric.sidebarInset)
        grid(model.widgetKinds.filter { $0.inPicker && !$0.isLocal }, builtIn: true)
        let local = model.widgetKinds.filter { $0.inPicker && $0.isLocal }
        if !local.isEmpty {
            SectionHeader(title: "Mine").padding(.horizontal, 8)
            grid(local).padding(.horizontal, 8)
        }
        if model.widgetKinds.isEmpty {
            Text("Open a canvas to add widgets.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 6)
        }
        PaperShadersGrid(model: model)
        SectionHeader(title: "On this canvas")
        ForEach(model.widgets) { w in
            let kind = model.widgetKinds.first { $0.id == w.kind }
            ListRow(title: w.name.isEmpty ? (kind?.title ?? w.kind) : w.name, detail: kind?.title ?? w.kind, symbol: kind?.symbol ?? "square", sidebar: true) {
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
                            if g.first && w.kind != "note" { nameField(w) }
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
        }
    }

    private func header(_ w: WidgetInfo, _ kind: WidgetKindInfo?) -> some View {
        HStack(spacing: 8) {
            Image(systemName: kind?.symbol ?? "square").railGlyph().foregroundStyle(Palette.mutedFg)
            Text(w.name.isEmpty ? (kind?.title ?? w.kind) : w.name).font(SidebarStyle.title).foregroundStyle(Palette.fg).lineLimit(1)
            Spacer(minLength: 0)
        }
        .sidebarHeader()
        .qaID("right-sidebar-header")
    }

    private func position(_ w: WidgetInfo, _ kind: WidgetKindInfo?) -> some View {
        let minW = Double(kind?.minSize.width ?? 0), minH = Double(kind?.minSize.height ?? 0)
        let hasVideo = w.kind == "video" && (configValue(w.config, "src") as? String)?.isEmpty == false
        let fitsHeight = w.kind == "note" || hasVideo
        return InspectorSection(title: "Position") {
            HStack(spacing: 8) {
                NumberField(prefix: "X", value: w.x, enabled: !w.locked) { model.updateWidget(w.id, ["x": $0]) }
                NumberField(prefix: "Y", value: w.y, enabled: !w.locked) { model.updateWidget(w.id, ["y": $0]) }
            }
            HStack(spacing: 8) {
                NumberField(prefix: "W", value: w.w, enabled: !w.locked) { model.updateWidget(w.id, ["w": max($0, minW)]) }
                NumberField(prefix: "H", value: w.h, enabled: !w.locked && !fitsHeight) { model.updateWidget(w.id, ["h": max($0, minH)]) }
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
    private var isLive: Bool { kind?.live ?? false }
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
                if s.state == "needs-approval", let target = s.approvalTarget ?? approvalOrigin {
                    PillButton(title: "Allow", style: .primary) { model.trustWidget(widget.id, target: s.approvalTarget) }
                        .accessibilityLabel("Allow \(target)")
                        .qaID("widget-allow-source")
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
