import AppKit
import SwiftUI

// Paper Shaders (github.com/paper-design/shaders, Apache-2.0) as shader card presets: the rail's Shaders
// grid, the preset card inspector (params with Paper's ranges, colour swatches with our picker and tokens,
// presets, Copy as React / HTML). The server owns the library (src/paper.ts); a card keeps its params in
// config.paper and the page plays them without a recompile.

struct PaperParam {
    let name: String
    let type: String
    let description: String
    let min: Double?
    let max: Double?
    let step: Double?
    let options: [String]
    let maxCount: Int?

    init?(_ m: [String: Any]) {
        guard let name = m["name"] as? String, let type = m["type"] as? String else { return nil }
        self.name = name; self.type = type
        description = m["description"] as? String ?? ""
        min = (m["min"] as? NSNumber)?.doubleValue
        max = (m["max"] as? NSNumber)?.doubleValue
        step = (m["step"] as? NSNumber)?.doubleValue
        options = m["options"] as? [String] ?? []
        maxCount = (m["maxCount"] as? NSNumber)?.intValue
    }
}

struct PaperShaderInfo: Identifiable {
    let id: String
    let name: String
    let description: String
    let animated: Bool
    let params: [PaperParam]
    let presets: [String]

    init?(_ m: [String: Any]) {
        guard let id = m["id"] as? String, let name = m["name"] as? String else { return nil }
        self.id = id; self.name = name
        description = m["description"] as? String ?? ""
        animated = m["animated"] as? Bool ?? false
        params = (m["params"] as? [[String: Any]] ?? []).compactMap(PaperParam.init)
        presets = m["presets"] as? [String] ?? []
    }
}

extension CanvasModel {
    func fetchPaperShaders() {
        guard paperShaders.isEmpty, let url = widgetURL("api/shaders/presets", file: false) else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let list = j["shaders"] as? [[String: Any]] else { return }
            let shaders = list.compactMap(PaperShaderInfo.init)
            DispatchQueue.main.async { if !shaders.isEmpty { self.paperShaders = shaders } }
        }.resume()
    }

    func paperThumbURL(_ shader: String, preset: String = "Default") -> URL? {
        widgetURL("api/shaders/presets/\(shader)/thumb", query: [URLQueryItem(name: "preset", value: preset)], file: false)
    }

    /// A new preset card, placed by the server to the right of the boards, then shown.
    func addPaperShader(_ shader: String, preset: String? = nil) {
        var body: [String: Any] = ["preset": shader]
        if let preset { body["variant"] = preset }
        widgetCall("POST", "api/shaders", body: body) { [weak self] r in
            switch r {
            case .success(let j):
                if let w = (j["widget"] as? [String: Any]).flatMap(WidgetInfo.init) { self?.revealWidget(w.id) }
            case .failure(let e): self?.flash(e.message)
            }
        }
    }

    /// The card as code for a web page, on the clipboard.
    func copyShaderExport(_ id: String, format: String) {
        guard let url = widgetURL("api/shaders/\(id)/export", query: [URLQueryItem(name: "format", value: format)]) else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
            let ok = ((response as? HTTPURLResponse)?.statusCode ?? 0) == 200
            let j = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            DispatchQueue.main.async {
                guard ok, let code = j["code"] as? String else { self?.flash(j["error"] as? String ?? "Could not export"); return }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
                self?.flash(format == "react" ? "Copied as React" : "Copied as HTML")
            }
        }.resume()
    }
}

// MARK: Rail

/// The Shaders grid in the widget rail: one tile per Paper shader (its Default preset as a still).
struct PaperShadersGrid: View {
    @ObservedObject var model: CanvasModel
    var body: some View {
        SectionHeader(title: "Shaders", inset: Metric.sidebarInset)
        LazyVGrid(columns: WidgetsPanel.columns, spacing: 8) {
            ForEach(model.paperShaders) { s in
                PaperTile(model: model, shader: s)
            }
        }
        .padding(.horizontal, Metric.sidebarInset).padding(.bottom, 6)
        .task { model.fetchPaperShaders() }
        if !model.paperShaders.isEmpty {
            Text("Paper Shaders, Apache-2.0").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.bottom, 6)
        }
    }
}

private struct PaperTile: View {
    @ObservedObject var model: CanvasModel
    let shader: PaperShaderInfo
    @State private var hovering = false
    /// The thumbnail once loaded, for the drag image (a drag preview cannot wait for a download).
    @State private var thumb: Image?

    var body: some View {
        Button { model.addPaperShader(shader.id) } label: {
            VStack(alignment: .leading, spacing: 4) {
                AsyncImage(url: model.paperThumbURL(shader.id)) { img in
                    img.resizable().aspectRatio(contentMode: .fill).onAppear { thumb = img }
                } placeholder: { Palette.hover }
                .frame(height: 52).frame(maxWidth: .infinity).clipped()
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(hovering ? Palette.sel : Palette.stroke, lineWidth: 1))
                .qaID("shader-preset-preview", label: shader.id)
                Text(shader.name).font(Typography.micro).foregroundStyle(Palette.fg).lineLimit(1).qaText(shader.name)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(shader.description)
        .onHover { hovering = $0 }
        // Click: the card goes to the right of the boards. Drag: it goes where it is dropped.
        .onDrag { model.beginWidgetDrag(WidgetDrag(preset: shader.id)) } preview: {
            Group { if let thumb { thumb.resizable().aspectRatio(contentMode: .fill) } else { Palette.hover } }
                .frame(width: 120, height: 72).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }
}

// MARK: Inspector

/// A Paper preset card: shader and preset menus, every param with Paper's range, export, and the way out to
/// hand-written WGSL. Edits go to the server (PUT params); the page applies them in the next frame.
struct PaperSection: View {
    @ObservedObject var model: CanvasModel
    let widget: WidgetInfo
    let paper: [String: Any]
    /// Values being dragged, shown before the server answers.
    @State private var draft: [String: Any] = [:]
    @State private var pending: DispatchWorkItem?
    /// Slider drags and picker drags: the first value goes at once, then one write per 50 ms, and the last one
    /// always (a trailing-only debounce sent nothing until the drag paused, so the card did not follow it).
    @State private var throttle = LeadTrailThrottle(interval: 0.05)

    private var shaderId: String { paper["shader"] as? String ?? "" }
    private var preset: String { paper["preset"] as? String ?? "" }
    private var params: [String: Any] { (paper["params"] as? [String: Any] ?? [:]).merging(draft) { $1 } }
    private var info: PaperShaderInfo? { model.paperShaders.first { $0.id == shaderId } }

    private static let motion: Set<String> = ["speed", "frame"]
    private static let sizing: Set<String> = ["scale", "rotation", "offsetX", "offsetY", "fit", "originX", "originY", "worldWidth", "worldHeight"]

    var body: some View {
        let info = info
        InspectorSection(title: info?.name ?? "Paper Shader") {
            HStack(spacing: 8) {
                MenuField(title: info?.name ?? shaderId, symbol: "sparkles") {
                    ForEach(model.paperShaders) { s in Button(s.name) { send(["preset": s.id]) } }
                }
                MenuField(title: preset.isEmpty ? "Preset" : preset) {
                    ForEach(info?.presets ?? [], id: \.self) { p in Button(p) { draft = [:]; send(["variant": p]) } }
                }
            }
            if let d = info?.description, !d.isEmpty {
                Text(d).font(Typography.micro).foregroundStyle(Palette.mutedFg).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                PillButton(title: "Copy as React") { model.copyShaderExport(widget.id, format: "react") }
                PillButton(title: "Copy as HTML") { model.copyShaderExport(widget.id, format: "html") }
                Spacer(minLength: 0)
            }
        }
        .task { model.fetchPaperShaders() }
        .onChange(of: widget.config["rev"] as? String) { _, _ in if pending == nil { draft = [:] } }
        if let info {
            let own = info.params.filter { !Self.motion.contains($0.name) && !Self.sizing.contains($0.name) }
            if !own.isEmpty { group("Parameters", own) }
            let motion = info.params.filter { Self.motion.contains($0.name) }
            if !motion.isEmpty { group("Motion", motion) }
            let sizing = info.params.filter { Self.sizing.contains($0.name) }
            if !sizing.isEmpty { group("Position", sizing) }
        }
    }

    private func group(_ title: String, _ list: [PaperParam]) -> some View {
        InspectorSection(title: title) {
            ForEach(list, id: \.name) { p in row(p) }
        }
    }

    @ViewBuilder private func row(_ p: PaperParam) -> some View {
        let v = params[p.name]
        VStack(alignment: .leading, spacing: 4) {
            Text(label(p.name)).font(Typography.micro).foregroundStyle(Palette.mutedFg).help(p.description)
            switch p.type {
            case "color":
                colorRow(v as? String ?? "#000000") { set(p.name, $0, now: $1) }
            case "colors":
                let list = v as? [String] ?? []
                ForEach(Array(list.enumerated()), id: \.offset) { i, c in
                    HStack(spacing: 6) {
                        colorRow(c) { hex, now in var l = list; l[i] = hex; set(p.name, l, now: now) }
                        if list.count > 1 {
                            Button { var l = list; l.remove(at: i); set(p.name, l, now: true) } label: {
                                Image(systemName: "minus").glyph(10).foregroundStyle(Palette.mutedFg)
                            }.buttonStyle(.plain).help("Remove this colour")
                        }
                    }
                }
                if list.count < (p.maxCount ?? 10) {
                    Button { set(p.name, list + [list.last ?? "#ffffff"], now: true) } label: {
                        Label("Add colour", systemImage: "plus").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    }.buttonStyle(.plain)
                }
            case "enum":
                let cur = v as? String ?? ""
                MenuField(title: label(cur)) {
                    ForEach(p.options, id: \.self) { o in Button(label(o)) { set(p.name, o, now: true) } }
                }
            case "boolean":
                CheckField(title: label(p.name), isOn: v as? Bool ?? false) { set(p.name, $0, now: true) }
            default:
                numberRow(p, (v as? NSNumber)?.doubleValue ?? 0)
            }
        }
    }

    private func colorRow(_ value: String, _ commit: @escaping (String, Bool) -> Void) -> some View {
        HStack(spacing: 6) {
            ColorSwatchButton(value: value, model: model, onChange: { commit($0, false) }, onCommit: { commit(resolve($0), true) })
            HexField(value: value) { commit($0, true) }
        }
    }

    private func numberRow(_ p: PaperParam, _ value: Double) -> some View {
        HStack(spacing: 8) {
            if let lo = p.min, let hi = p.max, hi > lo {
                Slider(value: Binding(get: { value }, set: { set(p.name, round($0, p), now: false) }), in: lo...hi) { editing in
                    if !editing { flush() }
                }
                .controlSize(.small)
                NumberField(prefix: "", value: value, minimum: lo, maximum: hi) { set(p.name, $0, now: true) }.frame(width: 64)
            } else {
                NumberField(prefix: p.name == "frame" ? "ms" : "", value: value, minimum: p.name == "frame" ? 0 : nil) { set(p.name, $0, now: true) }
            }
        }
    }

    private func round(_ v: Double, _ p: PaperParam) -> Double {
        let step = p.step ?? ((p.max ?? 1) - (p.min ?? 0) > 20 ? 1 : 0.01)
        return (v / step).rounded() * step
    }

    /// A token pick ("$name") becomes its colour: Paper params are literal colours.
    private func resolve(_ v: String) -> String {
        if v.hasPrefix("$") { return model.tokenLiteral(String(v.dropFirst())) ?? v }
        return v
    }

    private func label(_ name: String) -> String {
        let spaced = name.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
        return spaced.prefix(1).uppercased() + spaced.dropFirst().lowercased()
    }

    /// Show at once; send at most every 50 ms while dragging (first and last value included), at once on commit.
    private func set(_ name: String, _ value: Any, now: Bool) {
        draft[name] = value
        // A number scrub's in-between frames (EditGesture.previewOnly) only update the field: the scrub's own
        // throttled writes and its final value carry it, so a scrub is not one PUT per drawn frame.
        if EditGesture.previewOnly { return }
        if now { flush(); return }
        switch throttle.offer(now: Date().timeIntervalSinceReferenceDate) {
        case .sendNow: send(["params": draft])
        case .schedule(let after):
            let work = DispatchWorkItem { flush() }
            pending = work
            DispatchQueue.main.asyncAfter(deadline: .now() + after, execute: work)
        case .wait: break
        }
    }

    private func flush() {
        pending?.cancel()
        pending = nil
        throttle.sent(now: Date().timeIntervalSinceReferenceDate)
        guard !draft.isEmpty else { return }
        send(["params": draft])
    }

    private func send(_ patch: [String: Any]) {
        model.updateShader(widget.id, patch)
    }
}
