// The paint editor: "+" in Fill or Stroke asks for the type (Solid, Gradient, Image, Shader), and a
// paint row's swatch opens a popover whose tabs switch the type of that paint and edit it: the colour picker for a
// solid, stops and angle for a gradient, mode, crop, tile scale, rotation and adjustments for an image, the preset
// and its parameters for a shader, and every paint's blend mode. Also the inspector's Selection colors, the layer's
// blend mode, corner smoothing, and the eyedropper (I). The value mapping is PaintLogic.swift.

import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// What a QA build answers instead of a system panel (set by QA.swift): the next image file the picker returns and
/// the next colour the eyedropper samples. Nil in the app.
enum PaintHooks {
    static var nextImage: URL?
    static var nextSample: String?
    /// Fault injection (QA): seconds an image upload's and a Selection colors write's answer is held, as a slow
    /// server would. 0 in the app.
    static var answerDelay: Double = 0
}

/// One paint or effect on the clipboard (a row's Copy Fill / Paste Fill): Canvas's own type, and the colour (or the
/// JSON) as text for other apps.
enum PaintClipboard {
    static let paintType = NSPasteboard.PasteboardType("cc.getcanvas.paint")
    static let effectType = NSPasteboard.PasteboardType("cc.getcanvas.effect")

    /// This run's seal key (PaintLogic.clipboardText): a paint Canvas copied pastes with its image; another app's
    /// (or one from before a relaunch) pastes without the files it names.
    private static let key = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    /// File references the last paste left out (another app's paint).
    private(set) static var dropped = 0

    /// The list a paint was copied from (fill, stroke, effect): a Cmd+V with no row selected puts it back on that list.
    static let listType = NSPasteboard.PasteboardType("cc.getcanvas.paint.list")

    static func copy(_ p: Any, effect: Bool = false, from list: String? = nil) {
        let json = PaintLogic.clipboardText(p, key: key)
        guard !json.isEmpty else { return }
        let pb = canvasPasteboard
        let t = effect ? effectType : paintType
        pb.declareTypes([t, listType, .string], owner: nil)
        pb.setString(json, forType: t)
        pb.setString(list ?? (effect ? "effect" : "fill"), forType: listType)
        let plain = (try? JSONSerialization.data(withJSONObject: p, options: [.fragmentsAllowed])).flatMap { String(data: $0, encoding: .utf8) }
        pb.setString(PaintLogic.color(p) ?? plain ?? json, forType: .string)
    }

    static func paste(effect: Bool = false) -> Any? {
        dropped = 0
        guard let s = canvasPasteboard.string(forType: effect ? effectType : paintType) else { return nil }
        let r = PaintLogic.readClipboard(s, key: key)
        dropped = r.dropped
        return r.value
    }

    /// What a paste says when it left files out (nil: it did not), and when nothing was left to paste.
    /// What is on the clipboard: Canvas's paint, its effect, and the list it came from.
    static var hasPaint: Bool { canvasPasteboard.string(forType: paintType) != nil }
    static var hasEffect: Bool { canvasPasteboard.string(forType: effectType) != nil }
    static var copiedList: String { PaintLogic.copiedList(canvasPasteboard.string(forType: listType)) }

    static var droppedNotice: String? { dropped == 0 ? nil : "Pasted without \(dropped == 1 ? "1 file" : "\(dropped) files"): the clipboard did not come from Canvas" }
    static func emptyNotice(_ otherwise: String) -> String { dropped == 0 ? otherwise : "Nothing pasted: the clipboard's image did not come from Canvas" }
}

// MARK: model: images, eyedropper, selection colours

extension CanvasModel {
    /// The folder an image fill's relative URL is read from: the package, or a loose file's folder.
    func imageFileURL(_ url: String) -> URL? {
        if url.hasPrefix("http:") || url.hasPrefix("https:") || url.hasPrefix("data:") { return nil }
        if url.hasPrefix("/") { return URL(fileURLWithPath: url) }
        if url.hasPrefix("file://") { return URL(string: url) }
        guard let f = currentFile else { return nil }
        let doc = URL(fileURLWithPath: f)
        let dir = doc.pathExtension == "canvas" ? doc : doc.deletingLastPathComponent()
        return dir.appendingPathComponent(url)
    }

    /// An image's own size in px, read from its header.
    func imagePixelSize(_ url: String) -> CGSize? {
        guard let file = imageFileURL(url), let src = CGImageSourceCreateWithURL(file as CFURL, nil),
              let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = (p[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue, let h = (p[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue else { return nil }
        return CGSize(width: w, height: h)
    }

    /// Asks for an image file and copies it into the document (POST /api/images); `done` gets the fill's URL.
    func chooseImage(done: @escaping (String) -> Void) {
        let file: URL
        if let next = PaintHooks.nextImage {
            PaintHooks.nextImage = nil
            file = next
        } else {
            let panel = NSOpenPanel()
            panel.title = "Choose an image"
            panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .svg]
            panel.allowsMultipleSelection = false
            panel.canChooseDirectories = false
            guard panel.runModal() == .OK, let url = panel.url else { return }
            file = url
        }
        guard let bytes = try? Data(contentsOf: file) else { flash("Could not read the image"); return }
        uploadImage(bytes, name: file.lastPathComponent, done: done)
    }

    /// Copies image bytes into the document (POST /api/images); `done` gets the fill's URL, only while the same
    /// document and selection are there.
    func uploadImage(_ bytes: Data, name: String, done: @escaping (String) -> Void) {
        guard let doc = currentFile, !bytes.isEmpty,
              var c = URLComponents(url: base.appendingPathComponent("api/images"), resolvingAgainstBaseURL: false) else { flash("Could not read the image"); return }
        c.setQuery([URLQueryItem(name: "file", value: doc), URLQueryItem(name: "name", value: name)])
        guard let url = c.url else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        req.httpBody = bytes
        // The fill goes on the layers it was chosen for: the URL is relative to this document's package, and `done`
        // writes the paint list it read from that selection. Another document or selection by the time the upload
        // answers takes nothing.
        let key = selectionKey
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let j = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let ok = (response as? HTTPURLResponse)?.statusCode == 201
            DispatchQueue.main.asyncAfter(deadline: .now() + PaintHooks.answerDelay) {
                guard ok, let u = j["url"] as? String else { self.flash(j["error"] as? String ?? "Could not add the image"); return }
                guard self.currentFile == doc, self.selectionKey == key else { self.flash("The image was not added: the selection changed while it loaded"); return }
                done(u)
            }
        }.resume()
    }

    /// The eyedropper (I, or Control+C): a colour sampled from the screen becomes the selection's fill.
    func eyedropFill() {
        guard selection != nil, let key = selectionKey else { return }
        let apply: (String) -> Void = { hex in
            guard self.selectionKey == key else { return }
            self.update(["fill": hex])
        }
        if let next = PaintHooks.nextSample { PaintHooks.nextSample = nil; apply(next); return }
        let s = NSColorSampler()
        Self.sampler = s
        s.show { picked in
            Self.sampler = nil
            guard let ns = picked?.usingColorSpace(.sRGB) else { return }
            apply(PaintLogic.hex([Double(ns.redComponent), Double(ns.greenComponent), Double(ns.blueComponent), Double(ns.alphaComponent)]))
        }
    }
    private static var sampler: NSColorSampler?
}

// MARK: a selected paint row (click the area left of a fill's swatch)

/// The fill, stroke or effect row picked in the inspector, for the layers it was picked on (`target`:
/// CanvasModel.selectionKey then).
struct PaintRowSelection: Equatable {
    let key: String
    let row: Int
    let target: String
}

extension CanvasModel {
    /// The picked row, while the layers it was picked on are still the selection.
    var paintRowNow: PaintRowSelection? { paintRow.flatMap { $0.target == selectionKey ? $0 : nil } }

    func selectPaintRow(_ key: String, _ row: Int) {
        guard let t = selectionKey else { return }
        // A field being typed in ends (its value commits), so Cmd+C and Cmd+V reach the row, not the field.
        if let w = webView.window, w.firstResponder is NSText { w.makeFirstResponder(webView) }
        paintRow = PaintRowSelection(key: key, row: row, target: t)
    }

    private func rowList(_ key: String) -> [Any] {
        guard let n = selection?.node else { return [] }
        return key == "effect" ? PaintLogic.effects(n["effect"]) : PaintLogic.list(n[key])
    }

    /// Writes a paint or effect list; an empty one clears it (an instance keeps an empty override, so its
    /// component's paints do not come back), as the rows' own buttons do (InspectorPaint.swift writeList).
    func writePaintList(_ key: String, _ l: [Any]) {
        let value = key == "effect" ? PaintLogic.effectValue(l.compactMap { $0 as? [String: Any] }) : PaintLogic.value(l)
        if let value { update([key: value]); return }
        guard let s = selection else { return }
        if s.node["type"] as? String == "ref" || s.inInstance { update([key: [Any]()]); return }
        let also = key == "stroke" ? ["strokeWidth", "strokeAlignment"].filter { s.node[$0] != nil } : []
        update([:], remove: [key] + also)
    }

    /// Cmd+C with a row picked: that paint or effect on the clipboard. False: no row, the canvas copies.
    func copyPaintRow() -> Bool {
        guard let r = paintRowNow else { return false }
        guard let p = PaintLogic.rowValue(rowList(r.key), row: r.row) else { paintRow = nil; return false }
        PaintClipboard.copy(p, effect: r.key == "effect", from: r.key)
        return true
    }

    /// Delete with a row picked: that paint goes. False: no row.
    func deletePaintRow() -> Bool {
        guard let r = paintRowNow else { return false }
        let l = rowList(r.key)
        guard PaintLogic.rowValue(l, row: r.row) != nil else { paintRow = nil; return false }
        paintRow = nil
        writePaintList(r.key, PaintLogic.removed(l, row: r.row))
        return true
    }

    /// Cmd+V with a row picked: a copied paint (or effect) replaces it; a picture replaces an image fill's picture
    /// and keeps its mode, crop and adjustments (a colour row becomes an image fill). `image`: the picture on the
    /// clipboard (main.swift pasteboardImage). False: no row, the canvas pastes.
    func pastePaintRow(image: () -> (data: Data, name: String)?) -> Bool {
        guard let r = paintRowNow else { return false }
        let img = r.key == "fill" && !PaintClipboard.hasPaint ? image() : nil
        switch PaintLogic.rowPasteSource(key: r.key, paint: PaintClipboard.hasPaint, effect: PaintClipboard.hasEffect, image: img != nil) {
        case .paint?, .effect?:
            let effect = r.key == "effect"
            guard let p = PaintClipboard.paste(effect: effect) else { flash(PaintClipboard.emptyNotice("Copy a fill or stroke first")); return true }
            writePaintList(r.key, PaintLogic.pasting(p, into: rowList(r.key), row: r.row))
            if let n = PaintClipboard.droppedNotice { flash(n) }
        case .image?:
            guard let img else { return true }
            let row = r.row
            uploadImage(img.data, name: img.name) { url in
                self.writePaintList("fill", PaintLogic.imagePasted(url: url, into: self.rowList("fill"), row: row))
            }
        case nil:
            flash(r.key == "effect" ? "Copy an effect first" : r.key == "stroke" ? "Copy a fill or stroke first" : "Copy a fill, a stroke or an image first")
        }
        return true
    }

    /// Cmd+V on the canvas with only a copied paint or effect on the clipboard (no layers): it goes on top of the
    /// selected layers' list it came from (copy the property, select the layer, paste). With the list Mixed
    /// it replaces every layer's, as "+" does. False: nothing of the kind, the canvas pastes as before.
    func pasteCopiedPaint() -> Bool {
        guard let s = selection, !s.isPath else { return false }
        let key = PaintClipboard.copiedList
        let effect = key == "effect"
        guard effect ? PaintClipboard.hasEffect : PaintClipboard.hasPaint else { return false }
        guard let p = PaintClipboard.paste(effect: effect) else { flash(PaintClipboard.emptyNotice(effect ? "Copy an effect first" : "Copy a fill or stroke first")); return true }
        let mixed = s.mixed.contains(key)
        let list = rowList(key)
        let l = mixed ? [p] : PaintLogic.pasting(p, into: list, row: nil)
        // The first stroke is 1 px: one write, one undo step.
        if key == "stroke", mixed || list.isEmpty, s.node["strokeWidth"] == nil, let v = PaintLogic.value(l) { update(["stroke": v, "strokeWidth": 1]) }
        else { writePaintList(key, l) }
        if let n = PaintClipboard.droppedNotice { flash(n) }
        return true
    }
}

// MARK: "+" with a type

/// Fill's and Stroke's "+": a menu of paint types (a type picker). Strokes take solid and gradient paints.
struct AddPaintMenu: View {
    @ObservedObject var model: CanvasModel
    let noun: String
    var enabled = true
    var strokes = false
    /// The colour a new solid or gradient starts from (#D9D9D9 fills, black strokes).
    var base = "#D9D9D9"
    let add: (Any) -> Void
    @State private var hovering = false

    var body: some View {
        Menu {
            Button("Solid") { if let p = PaintLogic.newPaint(.solid, base: base) { add(p) } }
            // The gradient types one item each (one click, like Solid).
            ForEach([PaintLogic.PaintKind.linear, .radial, .angular], id: \.self) { k in
                Button("\(k.title) gradient") { if let p = PaintLogic.newPaint(k, base: base) { add(p) } }
            }
            if !strokes {
                Button("Image\u{2026}") { model.chooseImage { url in if let p = PaintLogic.newPaint(.image, image: url) { add(p) } } }
                Menu("Shader") {
                    if model.paperShaders.isEmpty { Text("Loading\u{2026}") }
                    ForEach(model.paperShaders) { s in
                        Button(s.name) { if let p = PaintLogic.newPaint(.shader, shader: s.id) { add(p) } }
                    }
                }
            }
        } label: {
            Image(systemName: "plus").font(.system(size: 11, weight: .medium))
                .foregroundStyle(hovering ? Palette.fg : Palette.mutedFg)
                .frame(width: 24, height: 24)
                .background(Circle().fill(hovering ? Palette.hover : .clear))
                .contentShape(Circle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .disabled(!enabled).opacity(enabled ? 1 : 0.4)
        .help("Add \(noun)").accessibilityLabel("Add \(noun)")
        .qaID("add-paint", label: noun)
        .onHover { hovering = $0 }
        .task { model.fetchPaperShaders() }
    }
}

// MARK: swatch and popover

/// A paint at a glance: its colour, its gradient, its image or its shader's picture.
struct PaintChip: View {
    @ObservedObject var model: CanvasModel
    let paint: Any
    var size: CGFloat = 14

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 4, style: .continuous)
        ZStack {
            Checkerboard(cell: 3)
            fill
        }
        .frame(width: size, height: size).clipShape(shape)
        .shadow(color: .black.opacity(0.25), radius: 0.5)
    }

    @ViewBuilder private var fill: some View {
        let kind = PaintLogic.paintKind(paint)
        switch kind {
        case .solid:
            let c = PaintLogic.color(paint) ?? "#D9D9D9"
            (parseColor(c.hasPrefix("$") ? model.tokenLiteral(String(c.dropFirst())) ?? "" : c) ?? .gray)
        case .linear, .radial, .angular:
            GradientPreview(paint: paint)
        case .image:
            if let url = (paint as? [String: Any])?["url"] as? String, let file = model.imageFileURL(url), let img = ImageThumbs.shared.image(file) {
                Image(nsImage: img).resizable().aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "photo").glyph(9).foregroundStyle(Palette.mutedFg).frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.field)
            }
        case .shader:
            let d = paint as? [String: Any] ?? [:]
            if let id = d["shader"] as? String, let url = model.paperThumbURL(id, preset: d["preset"] as? String ?? "Default") {
                AsyncImage(url: url) { $0.resizable().aspectRatio(contentMode: .fill) } placeholder: { Palette.field }
            } else {
                Image(systemName: "sparkles").glyph(9).foregroundStyle(Palette.mutedFg)
            }
        }
    }
}

/// Small thumbnails of image files, cached by path.
final class ImageThumbs {
    static let shared = ImageThumbs()
    private var cache: [URL: NSImage] = [:]
    func image(_ url: URL) -> NSImage? {
        if let i = cache[url] { return i }
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 256, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
        let i = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
        if cache.count > 64 { cache.removeAll() }
        cache[url] = i
        return i
    }
}

/// A gradient drawn as the canvas draws it (file degrees: 0 points up, counter-clockwise; CSS turns the other way).
struct GradientPreview: View {
    let paint: Any
    var body: some View {
        let d = paint as? [String: Any] ?? [:]
        let stops = PaintLogic.gradientStops(paint).sorted { $0.position < $1.position }.map { Gradient.Stop(color: parseColor($0.color) ?? .gray, location: $0.position) }
        let g = Gradient(stops: stops.isEmpty ? [.init(color: .gray, location: 0)] : stops)
        let rot = -(PaintLogic.num(d["rotation"]) ?? 0)
        switch PaintLogic.paintKind(paint) {
        case .radial:
            GeometryReader { geo in RadialGradient(gradient: g, center: .center, startRadius: 0, endRadius: max(geo.size.width, geo.size.height) / 2) }
        case .angular:
            AngularGradient(gradient: g, center: .center, angle: .degrees(rot - 90))
        default:
            // CSS: "Ndeg" runs from the bottom up at 0, turning clockwise.
            let a = Angle.degrees(rot).radians
            let dx = sin(a) / 2, dy = -cos(a) / 2
            LinearGradient(gradient: g, startPoint: UnitPoint(x: 0.5 - dx, y: 0.5 - dy), endPoint: UnitPoint(x: 0.5 + dx, y: 0.5 + dy))
        }
    }
}

/// The swatch in front of a paint row: a click opens the paint popover, where the tabs switch the type.
struct PaintSwatchButton: View {
    @ObservedObject var model: CanvasModel
    let paint: Any
    var enabled = true
    var strokes = false
    let write: (Any) -> Void
    @Environment(\.editTarget) private var target
    @State private var open = false
    @State private var openedFor: String?

    var body: some View {
        Button { openedFor = model.selectionKey; open.toggle() } label: {
            PaintChip(model: model, paint: paint, size: 16).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled)
        .help("Edit \(PaintLogic.paintKind(paint).title.lowercased()) paint").accessibilityLabel("Paint \(PaintLogic.paintKind(paint).title)")
        .onChange(of: target) { _, _ in open = false }
        .popover(isPresented: $open, arrowEdge: .leading) {
            PaintPopover(model: model, paint: paint, strokes: strokes) { v in if model.selectionKey == openedFor { write(v) } }
        }
    }
}

/// The tabs (paint type) and the blend mode on top, the editor for the type under them.
struct PaintPopover: View {
    @ObservedObject var model: CanvasModel
    let paint: Any
    var strokes = false
    let write: (Any) -> Void

    private enum Tab: String, CaseIterable { case solid = "Solid", gradient = "Gradient", image = "Image", shader = "Shader" }

    private var kind: PaintLogic.PaintKind { PaintLogic.paintKind(paint) }
    private var tab: Tab {
        switch kind {
        case .solid: .solid
        case .linear, .radial, .angular: .gradient
        case .image: .image
        case .shader: .shader
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                tabs
                blendMenu
            }
            .padding(.horizontal, 12).padding(.top, 12).padding(.bottom, tab == .solid ? 0 : 10)
            switch tab {
            case .solid:
                ColorPickerPopover(value: PaintLogic.color(paint) ?? "#D9D9D9", tokens: model.tokenSections,
                                   context: ColorPickerContext(base: model.base, file: model.currentFile, nodeId: model.selection?.id, themes: model.themes),
                                   onChange: { write(PaintLogic.withColor(paint, $0)) }, onCommit: { write(PaintLogic.withColor(paint, $0)) },
                                   onPickToken: { write(PaintLogic.withColor(paint, "$" + $0)) })
            case .gradient:
                GradientEditor(model: model, paint: paint, write: write)
            case .image:
                ImageFillEditor(model: model, paint: paint, write: write)
            case .shader:
                ShaderFillEditor(model: model, paint: paint, write: write)
            }
        }
        .frame(width: ColorPickerPopover.width)
        .task { model.fetchPaperShaders() }
    }

    private var tabs: some View {
        let list: [Tab] = strokes ? [.solid, .gradient] : Tab.allCases
        return HStack(spacing: 2) {
            ForEach(list, id: \.self) { t in
                Button { switchTo(t) } label: {
                    Text(t.rawValue).font(Typography.micro).fontWeight(tab == t ? .semibold : .regular)
                        .foregroundStyle(tab == t ? Palette.fg : Palette.mutedFg)
                        // Each word whole ("Gradient" is the longest), the room left shared out.
                        .lineLimit(1).fixedSize().padding(.horizontal, 4)
                        .frame(maxWidth: .infinity).frame(height: 20)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField - 2, style: .continuous).fill(tab == t ? Palette.active : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel(t.rawValue).accessibilityAddTraits(tab == t ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
    }

    private var blendMenu: some View {
        let cur = (paint as? [String: Any])?["blendMode"] as? String
        return BlendMenu(current: cur, help: "Blend mode of this paint") { write(PaintLogic.withBlend(paint, $0)) }
    }

    private func switchTo(_ t: Tab) {
        guard t != tab else { return }
        switch t {
        case .solid: if let v = PaintLogic.converted(paint, to: .solid) { write(v) }
        case .gradient: if let v = PaintLogic.converted(paint, to: .linear) { write(v) }
        case .image: model.chooseImage { url in if let v = PaintLogic.converted(paint, to: .image, image: url) { write(v) } }
        case .shader: if let v = PaintLogic.converted(paint, to: .shader, shader: model.paperShaders.first?.id ?? "mesh-gradient") { write(v) }
        }
    }
}

/// The blend menu as a small icon button; the current mode is checked.
struct BlendMenu: View {
    let current: String?
    var help = "Blend mode"
    var enabled = true
    let pick: (String) -> Void

    var body: some View {
        let on = (current ?? "normal") != "normal"
        Menu {
            ForEach(Array(PaintLogic.blendModes.enumerated()), id: \.offset) { _, m in
                if let m {
                    Button { pick(m.id) } label: {
                        if m.id == (current ?? "normal") { Label(m.title, systemImage: "checkmark") } else { Text(m.title) }
                    }
                } else {
                    Divider()
                }
            }
        } label: {
            Image(systemName: "circle.lefthalf.filled").glyph(11).foregroundStyle(on ? Palette.fg : Palette.mutedFg)
                .frame(width: Metric.field - 4, height: Metric.field - 4)
                .background(RoundedRectangle(cornerRadius: Metric.radiusField - 2, style: .continuous).fill(on ? Palette.active : .clear))
                .contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .disabled(!enabled).help(on ? "\(help): \(PaintLogic.blendTitle(current))" : help).accessibilityLabel(help)
    }
}

// MARK: gradient

/// Stops on a bar (click to add one, drag to move, select to edit its colour below), the type, the angle, flip and
/// rotate. The handles live in the panel; the canvas shows the result.
struct GradientEditor: View {
    @ObservedObject var model: CanvasModel
    let paint: Any
    let write: (Any) -> Void
    @State private var selected = 0
    /// A stop being dragged: its index and position, drawn before the write.
    @State private var dragging: (Int, Double)?

    private var stops: [PaintLogic.Stop] {
        var s = PaintLogic.gradientStops(paint)
        if let (i, p) = dragging, s.indices.contains(i) { s[i].position = p }
        return s
    }
    private var d: [String: Any] { paint as? [String: Any] ?? [:] }

    var body: some View {
        let s = stops
        let sel = min(selected, max(0, s.count - 1))
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                MenuField(title: PaintLogic.paintKind(paint).title) {
                    ForEach([PaintLogic.PaintKind.linear, .radial, .angular], id: \.self) { k in
                        Button(k.title) { if let v = PaintLogic.converted(paint, to: k) { write(v) } }
                    }
                }
                MiniButton(symbol: "arrow.left.arrow.right", help: "Flip gradient", inRow: true) { write(PaintLogic.withStops(paint, PaintLogic.flipped(PaintLogic.gradientStops(paint)))) }
                MiniButton(symbol: "rotate.right", help: "Rotate 90\u{B0}", inRow: true) {
                    var v = d; v["rotation"] = ((PaintLogic.num(d["rotation"]) ?? 0) - 90).truncatingRemainder(dividingBy: 360); write(v)
                }
            }
            stopBar(s, sel)
            HStack(spacing: 6) {
                NumberField(prefix: "", symbol: "arrow.left.and.right", value: s.indices.contains(sel) ? (s[sel].position * 100).rounded() : nil, suffix: "%", minimum: 0, maximum: 100) { p in
                    var all = PaintLogic.gradientStops(paint)
                    guard all.indices.contains(sel) else { return }
                    all[sel].position = min(100, max(0, p)) / 100
                    write(PaintLogic.withStops(paint, all))
                }
                .help("Stop position")
                if PaintLogic.paintKind(paint) != .radial {
                    // The file's degrees run counter-clockwise; the field reads clockwise.
                    NumberField(prefix: "", symbol: "angle", value: ((-(PaintLogic.num(d["rotation"]) ?? 0) + 180).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360), suffix: "\u{B0}") { a in
                        var v = d; v["rotation"] = 180 - a; write(v)
                    }
                    .help("Angle")
                }
                MiniButton(symbol: "minus", help: "Remove stop", enabled: s.count > 2, inRow: true) {
                    write(PaintLogic.withStops(paint, PaintLogic.removingStop(PaintLogic.gradientStops(paint), sel)))
                    selected = max(0, sel - 1)
                }
            }
            NumberField(prefix: "", symbol: "drop.halffull", value: PaintLogic.paintOpacity(paint), suffix: "%", minimum: 0, maximum: 100) { write(PaintLogic.withPaintOpacity(paint, percent: $0)) }
                .help("Gradient opacity")
        }
        .padding(.horizontal, 12)
        if s.indices.contains(sel) {
            Rectangle().fill(Palette.stroke).frame(height: 1).padding(.top, 10)
            ColorPickerPopover(value: s[sel].color, tokens: model.tokenSections,
                               context: ColorPickerContext(base: model.base, file: model.currentFile, nodeId: model.selection?.id, themes: model.themes),
                               onChange: { setColor(sel, $0) }, onCommit: { setColor(sel, $0) },
                               onPickToken: { name in setColor(sel, model.tokenLiteral(name) ?? "#000000") }, listHeight: 120)
        }
    }

    private func setColor(_ i: Int, _ c: String) {
        var all = PaintLogic.gradientStops(paint)
        guard all.indices.contains(i) else { return }
        all[i].color = c
        write(PaintLogic.withStops(paint, all))
    }

    private func stopBar(_ s: [PaintLogic.Stop], _ sel: Int) -> some View {
        GeometryReader { geo in
            let w = geo.size.width
            ZStack(alignment: .topLeading) {
                ZStack { Checkerboard(cell: 4); GradientPreview(paint: PaintLogic.withStops(["type": "gradient", "rotation": -90], s)) }
                    .frame(height: 16).clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                    .shadow(color: .black.opacity(0.25), radius: 0.5)
                    .padding(.top, 6)
                ForEach(Array(s.enumerated()), id: \.offset) { i, stop in
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(parseColor(stop.color) ?? .gray)
                        .frame(width: 12, height: 22)
                        .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(i == sel ? Palette.fg : Color.white, lineWidth: i == sel ? 2 : 1.5))
                        .shadow(color: .black.opacity(0.3), radius: 1)
                        .offset(x: CGFloat(stop.position) * w - 6, y: 3)
                        .allowsHitTesting(false)
                }
                // The mouse: an AppKit view over the bar (it takes the first click, so the popover needs no
                // activating click first): a press on a stop selects it and drags it, anywhere else adds one there.
                StopBarMouse(stops: s.map(\.position), width: w,
                             add: { t in
                                 let (list, i) = PaintLogic.addingStop(PaintLogic.gradientStops(paint), at: t)
                                 selected = i
                                 write(PaintLogic.withStops(paint, list))
                             },
                             drag: { i, t in selected = i; dragging = (i, t) },
                             drop: { i, t in
                                 dragging = nil
                                 var all = PaintLogic.gradientStops(paint)
                                 if all.indices.contains(i), all[i].position != t { all[i].position = t; write(PaintLogic.withStops(paint, all)) }
                             })
                    .accessibilityLabel("Gradient stops: click to add a stop, drag a stop to move it")
            }
        }
        .frame(height: 28)
    }
}

/// The gradient stop bar's mouse handling (GradientEditor): positions are 0...1 along `width`.
struct StopBarMouse: NSViewRepresentable {
    let stops: [Double]
    let width: CGFloat
    let add: (Double) -> Void
    let drag: (Int, Double) -> Void
    let drop: (Int, Double) -> Void

    final class View: NSView {
        var owner: StopBarMouse?
        private var held: Int?
        private var downX: CGFloat = 0
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override var isFlipped: Bool { true }
        private func t(_ e: NSEvent) -> Double {
            let x = convert(e.locationInWindow, from: nil).x
            return Double(min(max(0, x / max(1, bounds.width)), 1))
        }
        override func mouseDown(with e: NSEvent) {
            guard let o = owner else { return }
            let x = convert(e.locationInWindow, from: nil).x
            downX = x
            // The nearest stop within 7 pt takes the press.
            let near = o.stops.enumerated().map { ($0.offset, abs(CGFloat($0.element) * bounds.width - x)) }.filter { $0.1 <= 7 }.min { $0.1 < $1.1 }
            held = near?.0
            if let i = held { o.drag(i, o.stops[i]) }
        }
        override func mouseDragged(with e: NSEvent) {
            guard let o = owner, let i = held else { return }
            o.drag(i, t(e))
        }
        override func mouseUp(with e: NSEvent) {
            guard let o = owner else { return }
            if let i = held { o.drop(i, t(e)) } else if abs(convert(e.locationInWindow, from: nil).x - downX) < 4 { o.add(t(e)) }
            held = nil
        }
    }

    func makeNSView(context: Context) -> View { let v = View(); v.owner = self; return v }
    func updateNSView(_ v: View, context: Context) { v.owner = self }
}

// MARK: image

/// Mode (Fill, Fit, Crop, Tile), Choose image, Rotate 90°, the tile scale, and the adjustments.
struct ImageFillEditor: View {
    @ObservedObject var model: CanvasModel
    let paint: Any
    let write: (Any) -> Void
    /// Slider values while dragging, written on release (each write decodes the image again).
    @State private var draft: [String: Double] = [:]

    private var d: [String: Any] { paint as? [String: Any] ?? [:] }
    private var url: String { d["url"] as? String ?? "" }

    var body: some View {
        let mode = PaintLogic.imageMode(paint)
        VStack(alignment: .leading, spacing: 10) {
            ZStack {
                Checkerboard(cell: 6)
                if let file = model.imageFileURL(url), let img = ImageThumbs.shared.image(file) {
                    Image(nsImage: img).resizable().aspectRatio(contentMode: .fit)
                        .rotationEffect(.degrees(PaintLogic.num(d["rotation"]) ?? 0))
                } else {
                    Image(systemName: "photo").glyph(18).foregroundStyle(Palette.mutedFg)
                }
            }
            .frame(height: 110).frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .shadow(color: .black.opacity(0.2), radius: 0.5)
            HStack(spacing: 6) {
                MenuField(title: mode.title) {
                    ForEach(PaintLogic.ImageMode.allCases.filter { $0 != .stretch || mode == .stretch }, id: \.self) { m in
                        Button(m.title) { write(PaintLogic.withImageMode(paint, m, box: box, image: imageSize)) }
                    }
                }
                .help("Image mode")
                MiniButton(symbol: "rotate.right", help: "Rotate 90\u{B0}", inRow: true) { write(PaintLogic.rotatedImage(paint)) }
            }
            if mode == .tile {
                NumberField(prefix: "", symbol: "square.grid.2x2", value: ((PaintLogic.num(d["scale"]) ?? 1) * 100).rounded(), suffix: "%", minimum: 1, maximum: 10000) { p in
                    var v = d; v["scale"] = max(1, p) / 100; write(v)
                }
                .help("Tile size")
            }
            if mode == .crop {
                Text("Double-click the image on the canvas to crop it").font(Typography.micro).foregroundStyle(Palette.mutedFg).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    FieldWellButton(title: "Crop on canvas") {
                        guard let id = model.selection?.id, let data = try? JSONSerialization.data(withJSONObject: ["cmd": "cropImage", "id": id]),
                              let js = String(data: data, encoding: .utf8) else { return }
                        model.afterWrites { model.run(js) }
                    }
                    Spacer(minLength: 0)
                    FieldWellButton(title: "Reset") {
                        var v = d; v.removeValue(forKey: "crop"); write(PaintLogic.withImageMode(v, .crop, box: box, image: imageSize))
                    }
                }
            }
            HStack(spacing: 6) {
                FieldWellButton(title: "Choose image\u{2026}") { model.chooseImage { u in var v = d; v["url"] = u; v.removeValue(forKey: "crop"); write(v) } }
                Spacer(minLength: 0)
                NumberField(prefix: "", symbol: "drop.halffull", value: PaintLogic.paintOpacity(paint), suffix: "%", minimum: 0, maximum: 100) { write(PaintLogic.withPaintOpacity(paint, percent: $0)) }
                    .frame(width: 84).help("Image opacity")
            }
            Rectangle().fill(Palette.stroke).frame(height: 1).padding(.horizontal, -12)
            ForEach(PaintLogic.adjustKeys, id: \.self) { k in adjustRow(k) }
        }
        .padding([.horizontal, .bottom], 12)
    }

    private var box: (Double, Double)? {
        guard let w = model.selection?.width ?? PaintLogic.num(model.selection?.node["width"]), let h = model.selection?.height ?? PaintLogic.num(model.selection?.node["height"]) else { return nil }
        return (w, h)
    }
    private var imageSize: (Double, Double)? { model.imagePixelSize(url).map { (Double($0.width), Double($0.height)) } }

    private func adjustRow(_ k: String) -> some View {
        let v = draft[k] ?? PaintLogic.adjustment(paint, k)
        return HStack(spacing: 8) {
            Text(k.prefix(1).uppercased() + k.dropFirst()).font(Typography.micro).foregroundStyle(Palette.mutedFg).frame(width: 74, alignment: .leading)
            Slider(value: Binding(get: { v }, set: { draft[k] = $0.rounded() }), in: -100...100) { editing in
                if !editing, let x = draft[k] { write(PaintLogic.withAdjustment(paint, k, percent: x)); draft[k] = nil }
            }
            .controlSize(.mini).accessibilityLabel(k)
            NumberField(prefix: "", value: v, minimum: -100, maximum: 100) { write(PaintLogic.withAdjustment(paint, k, percent: $0)) }
                .frame(width: 52).help(k.prefix(1).uppercased() + k.dropFirst())
        }
    }
}

// MARK: shader

/// The Paper shader and preset of a shader fill, and its parameters (Paper's ranges); a change writes `params`.
struct ShaderFillEditor: View {
    @ObservedObject var model: CanvasModel
    let paint: Any
    let write: (Any) -> Void
    /// The chosen preset's full params (GET api/shaders/presets/<id>), the base the fill's own params override.
    @State private var presetParams: [String: Any] = [:]
    @State private var loadedFor = ""
    @State private var draft: [String: Any] = [:]

    private var d: [String: Any] { paint as? [String: Any] ?? [:] }
    private var shaderId: String { d["shader"] as? String ?? "" }
    private var preset: String { d["preset"] as? String ?? "Default" }
    private var info: PaperShaderInfo? { model.paperShaders.first { $0.id == shaderId } }
    private var values: [String: Any] { presetParams.merging(d["params"] as? [String: Any] ?? [:]) { $1 }.merging(draft) { $1 } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if d["source"] is String && d["shader"] == nil {
                Text("A hand-written shader: agents edit its WGSL with set_node_props.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
            } else {
                HStack(spacing: 6) {
                    MenuField(title: info?.name ?? shaderId, symbol: "sparkles") {
                        ForEach(model.paperShaders) { s in Button(s.name) { var v = d; v["shader"] = s.id; v["preset"] = "Default"; v.removeValue(forKey: "params"); write(v) } }
                    }
                    .layoutPriority(1)
                    MenuField(title: preset) {
                        ForEach(info?.presets ?? [], id: \.self) { p in Button(p) { var v = d; v["preset"] = p; v.removeValue(forKey: "params"); draft = [:]; write(v) } }
                    }
                }
                NumberField(prefix: "", symbol: "drop.halffull", value: PaintLogic.paintOpacity(paint), suffix: "%", minimum: 0, maximum: 100) { write(PaintLogic.withPaintOpacity(paint, percent: $0)) }
                    .help("Shader opacity")
                if let info {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(info.params.filter { !["frame", "fit", "originX", "originY", "worldWidth", "worldHeight"].contains($0.name) }, id: \.name) { p in row(p) }
                        }
                    }
                    .frame(maxHeight: 300).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding([.horizontal, .bottom], 12)
        .task(id: shaderId + "/" + preset) { await loadPreset() }
    }

    private func loadPreset() async {
        let key = shaderId + "/" + preset
        guard !shaderId.isEmpty, loadedFor != key, let url = model.widgetURL("api/shaders/presets/\(shaderId)", file: false),
              let (data, _) = try? await URLSession.shared.data(from: url),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = j["presets"] as? [[String: Any]] else { return }
        let p = list.first { ($0["name"] as? String)?.lowercased() == preset.lowercased() } ?? list.first
        presetParams = p?["params"] as? [String: Any] ?? [:]
        loadedFor = key
        draft = [:]
    }

    private func set(_ name: String, _ v: Any, now: Bool) {
        draft[name] = v
        guard now else { return }
        var out = d
        var params = d["params"] as? [String: Any] ?? [:]
        for (k, x) in draft { params[k] = x }
        out["params"] = params
        draft = [:]
        write(out)
    }

    @ViewBuilder private func row(_ p: PaperParam) -> some View {
        let v = values[p.name]
        VStack(alignment: .leading, spacing: 4) {
            Text(label(p.name)).font(Typography.micro).foregroundStyle(Palette.mutedFg).help(p.description)
            switch p.type {
            case "color":
                HStack(spacing: 6) {
                    ColorSwatchButton(value: v as? String ?? "#000000", model: model, onChange: { set(p.name, $0, now: false) }, onCommit: { set(p.name, $0, now: true) })
                    HexField(value: v as? String ?? "#000000") { set(p.name, $0, now: true) }
                }
            case "colors":
                let list = v as? [String] ?? []
                ForEach(Array(list.enumerated()), id: \.offset) { i, c in
                    HStack(spacing: 6) {
                        ColorSwatchButton(value: c, model: model, onChange: { var l = list; l[i] = $0; set(p.name, l, now: false) }, onCommit: { var l = list; l[i] = $0; set(p.name, l, now: true) })
                        HexField(value: c) { var l = list; l[i] = $0; set(p.name, l, now: true) }
                    }
                }
            case "enum":
                MenuField(title: label(v as? String ?? "")) {
                    ForEach(p.options, id: \.self) { o in Button(label(o)) { set(p.name, o, now: true) } }
                }
            case "boolean":
                CheckField(title: label(p.name), isOn: v as? Bool ?? false) { set(p.name, $0, now: true) }
            default:
                let x = (v as? NSNumber)?.doubleValue ?? 0
                HStack(spacing: 8) {
                    if let lo = p.min, let hi = p.max, hi > lo {
                        Slider(value: Binding(get: { x }, set: { set(p.name, $0, now: false) }), in: lo...hi) { editing in
                            if !editing, let y = draft[p.name] { set(p.name, y, now: true) }
                        }
                        .controlSize(.mini)
                        NumberField(prefix: "", value: x, minimum: lo, maximum: hi) { set(p.name, $0, now: true) }.frame(width: 60)
                    } else {
                        NumberField(prefix: "", value: x) { set(p.name, $0, now: true) }
                    }
                }
            }
        }
    }

    private func label(_ name: String) -> String {
        let spaced = name.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
        return spaced.prefix(1).uppercased() + spaced.dropFirst().lowercased()
    }
}

// MARK: selection colours

/// The colours a selection uses (src/selection-colors.ts) and the serial writes that change one everywhere.
final class SelectionColorsStore: ObservableObject {
    @Published var colors: [(color: String, count: Int)] = []
    private var key = ""
    /// Writes waiting their turn, each with the document and layers it was made for (taken when it was queued: a
    /// tab switched meanwhile must not get it).
    private var queue: [(file: String, ids: [String], from: String, to: String, gesture: String)] = []
    private var busy = false
    /// The gesture a picker drag writes under (one undo step), per row, and when it last wrote: writes within a
    /// second of each other (a drag in the picker) are one step.
    private var gestures: [Int: (id: String, at: Date)] = [:]

    func load(_ model: CanvasModel, ids: [String], force: Bool = false) {
        guard let file = model.currentFile else { return }
        let k = file + "\u{1F}" + ids.joined(separator: ",") + "\u{1F}" + model.revision
        guard force || k != key, !busy, queue.isEmpty else { return }
        key = k
        guard let url = model.widgetURL("api/selection-colors", query: [URLQueryItem(name: "ids", value: ids.joined(separator: ","))]) else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            let list = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["colors"] as? [[String: Any]] ?? [])
                .compactMap { d -> (String, Int)? in (d["color"] as? String).map { ($0, (d["count"] as? NSNumber)?.intValue ?? 1) } }
            DispatchQueue.main.async { self.colors = list.map { (color: $0.0, count: $0.1) } }
        }.resume()
    }

    /// Row `i` becomes `to` everywhere in the selection. Writes go one at a time, each from the colour the last made.
    func replace(_ model: CanvasModel, ids: [String], row i: Int, to: String) {
        guard colors.indices.contains(i), colors[i].color != to, !EditGesture.previewOnly, let file = model.currentFile else { return }
        let from = colors[i].color
        let now = Date()
        let g = gestures[i].flatMap { now.timeIntervalSince($0.at) < 1 ? $0.id : nil } ?? "selcolor-\(UUID().uuidString.prefix(8))"
        gestures[i] = (g, now)
        colors[i].color = to
        queue.append((file, ids, from, to, g))
        pump(model)
    }

    private func pump(_ model: CanvasModel) {
        guard !busy, !queue.isEmpty else { return }
        // Drags: only the newest value of a run with the same gesture is worth writing; chain its `from`.
        var w = queue.removeFirst()
        while let next = queue.first, next.gesture == w.gesture, next.file == w.file, next.ids == w.ids { w.to = next.to; queue.removeFirst() }
        busy = true
        var req = URLRequest(url: model.base.appendingPathComponent("api/selection-colors"))
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["file": w.file, "ids": w.ids, "from": w.from, "to": w.to, "gesture": w.gesture])
        URLSession.shared.dataTask(with: req) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.asyncAfter(deadline: .now() + PaintHooks.answerDelay) {
                self.busy = false
                if !ok { model.flash("Could not change the colour") }
                if self.queue.isEmpty { self.key = "" } else { self.pump(model) }
            }
        }.resume()
    }
}

extension InspectorBody {
    /// Selection colors: several layers, or a frame or group, list each colour they use once; editing one
    /// changes it in every layer that uses it, in one undo step.
    @ViewBuilder var selectionColorsSection: some View {
        let type = n["type"] as? String
        if editable, s.ids.count > 1 || type == "frame" || type == "group" {
            SelectionColorsSection(model: model, ids: s.ids.isEmpty ? [s.id] : s.ids)
        }
    }

    /// The layer's blend mode (the Layer section), beside its opacity.
    var layerBlendMenu: some View {
        BlendMenu(current: mixed("blendMode") ? nil : n["blendMode"] as? String, help: "Layer blend mode", enabled: editable) { id in
            if id == "normal" { model.update([:], remove: ["blendMode"]) } else { model.update(["blendMode": id]) }
        }
        .qaID("layer-blend-mode")
    }

    /// Corner smoothing (a slider; 60% is iOS), for frames and rectangles with a radius.
    @ViewBuilder var cornerSmoothingField: some View {
        let type = n["type"] as? String ?? ""
        let v = PaintLogic.num(n["cornerSmoothing"]) ?? 0
        if ["frame", "rectangle"].contains(type), cornersIndependent || v > 0 {
            HStack(spacing: 8) {
                NumberField(prefix: "", symbol: "app", value: mixed("cornerSmoothing") ? nil : (v * 100).rounded(), placeholder: "Mixed", suffix: "%", enabled: editable, minimum: 0, maximum: 100) { p in
                    let x = min(100, max(0, p)) / 100
                    if x == 0 { model.update([:], remove: ["cornerSmoothing"]) } else { model.update(["cornerSmoothing": x]) }
                }
                .help("Corner smoothing")
                FieldWellButton(title: "iOS") { model.update(["cornerSmoothing": 0.6]) }.help("Corner smoothing 60%, as iOS draws its corners").disabled(!editable)
                    .qaID("corner-smoothing-preset")
            }
        }
    }
}

struct SelectionColorsSection: View {
    @ObservedObject var model: CanvasModel
    let ids: [String]
    @StateObject private var store = SelectionColorsStore()
    @State private var showAll = false

    var body: some View {
        let list = store.colors
        // A stack that is there while the list is empty too: an empty Group never appears, so it would never load.
        VStack(spacing: 0) {
            Color.clear.frame(height: 0)
            if !list.isEmpty {
                InspectorSection(title: "Selection colors") {
                    let shown = showAll ? list.count : min(list.count, 8)
                    ForEach(0..<shown, id: \.self) { i in
                        let c = list[i].color
                        HStack(spacing: 4) {
                            if let name = tokenName(c) {
                                TokenChip(model: model, name: name, kind: .color, enabled: true, onPick: { store.replace(model, ids: ids, row: i, to: "$" + $0) },
                                          onDetach: { if let lit = model.tokenLiteral(name) { store.replace(model, ids: ids, row: i, to: lit) } })
                            } else {
                                ColorAlphaField(model: model, value: c) { store.replace(model, ids: ids, row: i, to: $0) }
                            }
                        }
                        .help("Used \(list[i].count) \(list[i].count == 1 ? "time" : "times")")
                    }
                    if list.count > 8 {
                        Button(showAll ? "Show fewer" : "See all \(list.count) colors") { showAll.toggle() }
                            .buttonStyle(.plain).font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    }
                }
            }
        }
        .onAppear { store.load(model, ids: ids) }
        .onChange(of: ids) { _, v in store.load(model, ids: v) }
        .onChange(of: model.revision) { _, _ in store.load(model, ids: ids) }
    }
}

/// A button the height of a field, in a field's well: it sits in a row of fields (Choose image, Reset, iOS).
struct FieldWellButton: View {
    let title: String
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            Text(title).font(Typography.body).foregroundStyle(Palette.fg).lineLimit(1).fixedSize()
                .padding(.horizontal, 10).frame(height: Metric.field)
                .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(hovering ? Palette.active : Palette.field))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
