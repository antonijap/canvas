// The lower half of the colour picker: the document's colour tokens (grouped like the token library),
// recent colours (this file and all files), the colours this document uses most (counted by the server,
// /api/colors in src/colors.ts), and recommendations: tints and shades of the colour and of the brand
// tokens, and text colours that read on the node's background with their WCAG ratio and APCA Lc.

import SwiftUI

// MARK: recent colours

/// The last 16 committed colours, globally and per document, in UserDefaults.
enum ColorRecents {
    static let limit = 16
    static let globalKey = "canvas.colorPicker.recent"
    static let fileKey = "canvas.colorPicker.recentByFile"
    /// The documents in `fileKey`, most recently edited first.
    static let orderKey = "canvas.colorPicker.recentFileOrder"
    static var defaults = UserDefaults.standard

    static func list(file: String?) -> [String] {
        if let file { return (defaults.dictionary(forKey: fileKey) as? [String: [String]])?[file] ?? [] }
        return defaults.stringArray(forKey: globalKey) ?? []
    }

    static func add(_ hex: String, file: String?) {
        func push(_ l: [String]) -> [String] { Array(([hex] + l.filter { $0 != hex }).prefix(limit)) }
        defaults.set(push(list(file: nil)), forKey: globalKey)
        guard let file else { return }
        var all = defaults.dictionary(forKey: fileKey) as? [String: [String]] ?? [:]
        all[file] = push(all[file] ?? [])
        // Keep the 40 most recently edited documents' lists. Lists from before the order was kept count as oldest.
        var order = defaults.stringArray(forKey: orderKey) ?? []
        order += all.keys.filter { $0 != file && !order.contains($0) }.sorted()
        let next = RecentKeys.touch(order.filter { all[$0] != nil || $0 == file }, file, limit: 40)
        for k in next.evicted { all.removeValue(forKey: k) }
        defaults.set(all, forKey: fileKey)
        defaults.set(next.order, forKey: orderKey)
    }
}

// MARK: document colours from the server

struct DocColorStat: Identifiable, Equatable {
    var id: String { variable.map { "$" + $0 } ?? hex }
    let hex: String
    let count: Int
    let variable: String?
}

final class ColorPickerDocData: ObservableObject {
    @Published var colors: [DocColorStat] = []
    @Published var background: RGBA?

    func load(_ ctx: ColorPickerContext) {
        guard let base = ctx.base, let file = ctx.file,
              var c = URLComponents(url: base.appendingPathComponent("api/colors"), resolvingAgainstBaseURL: false) else { return }
        c.queryItems = [URLQueryItem(name: "file", value: file), URLQueryItem(name: "limit", value: "24")]
            + (ctx.nodeId.map { [URLQueryItem(name: "id", value: $0)] } ?? [])
        guard let url = c.url else { return }
        URLSession.shared.dataTask(with: url) { data, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let obj = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) else { return }
            let list = (obj["colors"] as? [[String: Any]] ?? []).compactMap { d -> DocColorStat? in
                guard let hex = d["hex"] as? String else { return nil }
                return DocColorStat(hex: hex, count: (d["count"] as? NSNumber)?.intValue ?? 0, variable: d["variable"] as? String)
            }
            let bg = (obj["background"] as? String).flatMap(CSSColor.parse)
            DispatchQueue.main.async { self.colors = list; self.background = bg }
        }.resume()
    }
}

// MARK: tokens

/// A colour token as the picker shows it: its full name, the name inside its group, and its value for this appearance.
struct ColorToken: Identifiable {
    var id: String { name }
    let name: String
    let leaf: String
    let color: RGBA
}

enum ColorTokens {
    /// The colour section of the library as (group title, tokens); singles come first under an empty title.
    static func groups(_ sections: [LibSection], dark: Bool) -> [(title: String, tokens: [ColorToken])] {
        guard let colors = sections.first(where: { $0.id == "colors" }) else { return [] }
        var values: [String: [TokenValue]] = [:]
        for e in colors.entries { for i in e.items { values[i.key] = i.values } }
        func resolve(_ name: String, depth: Int = 0) -> RGBA? {
            guard depth < 6, let vs = values[name], let v = pick(vs, dark: dark) else { return nil }
            return v.hasPrefix("$") ? resolve(String(v.dropFirst()), depth: depth + 1) : CSSColor.parse(v)
        }
        var singles: [ColorToken] = []
        var out: [(String, [ColorToken])] = []
        for e in colors.entries {
            let toks = e.items.compactMap { i in resolve(i.key).map { ColorToken(name: i.key, leaf: i.leaf, color: $0) } }
            if e.isGroup { if !toks.isEmpty { out.append((e.title, toks)) } } else { singles += toks }
        }
        return (singles.isEmpty ? [] : [("", singles)]) + out
    }

    /// A themed token's value for the app's appearance: a theme named like "dark" in dark mode, else the first other one.
    static func pick(_ vs: [TokenValue], dark: Bool) -> String? {
        guard vs.count > 1 else { return vs.first?.value }
        let isDark = { (v: TokenValue) in v.theme.lowercased().contains("dark") }
        return (dark ? vs.first(where: isDark) : vs.first(where: { !isDark($0) }))?.value ?? vs.first?.value
    }

    /// Brand-ish tokens to build ramps from: names with brand, accent or primary in them.
    static func brand(_ groups: [(title: String, tokens: [ColorToken])]) -> [ColorToken] {
        let all = groups.flatMap(\.tokens)
        let hits = all.filter { $0.name.range(of: #"brand|accent|primary"#, options: [.regularExpression, .caseInsensitive]) != nil }
        // Prefer one per family: "accent" over "accent-lip".
        var seen = Set<String>(), out: [ColorToken] = []
        for t in hits.sorted(by: { $0.name.count < $1.name.count }) {
            let fam = String(t.name.split(whereSeparator: { "-/.".contains($0) }).first ?? "")
            if seen.insert(fam).inserted, t.color.oklch.c > 0.02 { out.append(t) }
        }
        return Array(out.prefix(2))
    }
}

// MARK: the sections

struct ColorPickerSections: View {
    let color: RGBA
    let current: String
    let tokens: [LibSection]
    let context: ColorPickerContext
    let docColors: [DocColorStat]
    let background: RGBA?
    let onPickColor: (RGBA) -> Void
    let onPickToken: (String) -> Void
    @Environment(\.colorScheme) private var scheme
    @AppStorage("canvas.colorPicker.recentScope") private var recentAll = false
    @State private var query = ""

    var body: some View {
        let groups = ColorTokens.groups(tokens, dark: scheme == .dark)
        let tokenCount = groups.reduce(0) { $0 + $1.tokens.count }
        let recents = ColorRecents.list(file: recentAll || context.file == nil ? nil : context.file)
        VStack(alignment: .leading, spacing: 4) {
            if tokenCount > 0 {
                PickerSectionTitle(title: "Document tokens", detail: "\(tokenCount)")
                if tokenCount > 16 {
                    SearchField(prompt: "Search tokens", text: $query).padding(.bottom, 4)
                }
                let q = query.trimmingCharacters(in: .whitespaces).lowercased()
                ForEach(groups.indices, id: \.self) { gi in
                    let g = groups[gi]
                    let toks = q.isEmpty ? g.tokens : g.tokens.filter { $0.name.lowercased().contains(q) }
                    if !toks.isEmpty {
                        if !g.title.isEmpty { Text(g.title).font(Typography.micro).foregroundStyle(Palette.mutedFg).padding(.top, 2) }
                        SwatchGrid(items: toks.map { t in
                            SwatchItem(id: t.name, color: t.color, help: "$\(t.name)  \(t.color.hex)",
                                       selected: context.boundToken == t.name) { onPickToken(t.name) }
                        })
                    }
                }
            }

            PickerSectionTitle(title: "Recent") {
                if context.file != nil {
                    Button(recentAll ? "All files" : "This file") { recentAll.toggle() }
                        .buttonStyle(.plain).font(Typography.micro).foregroundStyle(Palette.mutedFg)
                        .help("Show recent colours from this file or from all files")
                }
            }
            if recents.isEmpty {
                Text("Colours you pick show up here.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
            } else {
                SwatchGrid(items: recents.compactMap { h in
                    CSSColor.parse(h).map { c in SwatchItem(id: h, color: c, help: h, selected: h == current) { onPickColor(c) } }
                })
            }

            if !docColors.isEmpty {
                PickerSectionTitle(title: "Most used", detail: "in this document")
                SwatchGrid(items: docColors.compactMap { d in
                    guard let c = CSSColor.parse(d.hex) else { return nil }
                    let uses = "\(d.count) use\(d.count == 1 ? "" : "s")"
                    if let v = d.variable {
                        return SwatchItem(id: d.id, color: c, help: "$\(v), \(d.hex), \(uses)", selected: context.boundToken == v, linked: true) { onPickToken(v) }
                    }
                    return SwatchItem(id: d.id, color: c, help: "\(d.hex), \(uses)", selected: d.hex == current) { onPickColor(c) }
                })
            }

            PickerSectionTitle(title: "Recommended")
            RampRow(title: "Tints and shades", base: color.opaque, current: current, onPick: onPickColor)
            ForEach(ColorTokens.brand(groups)) { t in
                RampRow(title: "$\(t.name)", base: t.color.opaque, current: current, onPick: onPickColor)
            }
            if let bg = background {
                Text("Text on \(bg.opaque.hex)").font(Typography.micro).foregroundStyle(Palette.mutedFg).padding(.top, 4)
                ForEach(ColorRecipes.textColors(on: bg, hue: color.opaque), id: \.color.hex) { o in
                    TextColorRow(option: o, background: bg) { onPickColor(o.color) }
                }
            }
        }
        .padding(.horizontal, 12).padding(.bottom, 4)
    }
}

struct PickerSectionTitle<Trailing: View>: View {
    let title: String
    var detail: String?
    @ViewBuilder var trailing: () -> Trailing
    var body: some View {
        HStack(spacing: 6) {
            Text(title.uppercased()).font(Typography.section).tracking(0.6).foregroundStyle(Palette.mutedFg).lineLimit(1)
            if let detail { Text(detail).font(Typography.micro).monospacedDigit().foregroundStyle(Palette.mutedFg.opacity(0.7)).lineLimit(1) }
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.top, 10).padding(.bottom, 2)
    }
}

extension PickerSectionTitle where Trailing == EmptyView {
    init(title: String, detail: String? = nil) { self.init(title: title, detail: detail, trailing: { EmptyView() }) }
}

struct SwatchItem: Identifiable {
    let id: String
    let color: RGBA
    let help: String
    var selected = false
    /// A token (or a colour that comes from one): marked with a dot, picking it binds.
    var linked = false
    let action: () -> Void
}

/// Eight swatches a row, square, filling the width.
struct SwatchGrid: View {
    let items: [SwatchItem]
    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 8), spacing: 6) {
            ForEach(items) { PickerSwatch(item: $0) }
        }
    }
}

struct PickerSwatch: View {
    let item: SwatchItem
    @State private var hovering = false
    var body: some View {
        Button(action: item.action) {
            ZStack {
                Checkerboard(cell: 3)
                item.color.color
                if item.linked {
                    Circle().fill(item.color.oklch.l > 0.6 ? Color.black.opacity(0.55) : Color.white.opacity(0.85))
                        .frame(width: 4, height: 4)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing).padding(3)
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .shadow(color: .black.opacity(0.22), radius: 0.5)
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(item.selected ? Palette.sel : (hovering ? Palette.ring : .clear), lineWidth: 2).padding(-3))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).help(item.help)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
        .accessibilityLabel(item.help)
    }
}

/// Seven steps from light to dark of one colour, under a small title.
private struct RampRow: View {
    let title: String
    let base: RGBA
    let current: String
    let onPick: (RGBA) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).truncationMode(.middle)
            HStack(spacing: 0) {
                ForEach(ColorRecipes.ramp(base), id: \.hex) { c in
                    Button { onPick(c) } label: {
                        Rectangle().fill(c.color).frame(height: 20)
                            .overlay(c.hex == current ? RoundedRectangle(cornerRadius: 2).strokeBorder(.white, lineWidth: 1.5).padding(2) : nil)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help(c.hex)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .shadow(color: .black.opacity(0.22), radius: 0.5)
        }
        .padding(.top, 2)
    }
}

/// A text colour that reads on the background: a sample, its hex, and both contrast scores.
private struct TextColorRow: View {
    let option: ColorRecipes.TextOption
    let background: RGBA
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text("Aa").font(.system(size: 12, weight: .semibold)).foregroundStyle(option.color.color)
                    .frame(width: 26, height: 20)
                    .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(background.opaque.color))
                    .shadow(color: .black.opacity(0.2), radius: 0.5)
                Text(option.color.hex).font(Typography.numeric).foregroundStyle(Palette.fg)
                Spacer(minLength: 0)
                ContrastBadge(text: "\(CSSColor.fmt(option.wcag, 1)):1 \(Contrast.wcagLevel(option.wcag))", pass: option.wcag >= 4.5)
                ContrastBadge(text: "Lc \(Int(option.apca.rounded()))", pass: abs(option.apca) >= 60)
            }
            .padding(.horizontal, 4).frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(hovering ? Palette.hover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).padding(.horizontal, -4)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}
