// Layout guide in the properties panel: a frame's grid, columns and rows. "+" adds a 10 px grid,
// each row has its type, an eye and a "-", and its settings under it (size; count, type, width or margin, offset,
// gutter; colour). Saved in the frame's metadata (LayoutGuides in ShellLogic.swift); the page draws them over the
// canvas and snaps to them (src/page/navigate.js), shown and hidden with Control+G or View > Layout Guides.

import SwiftUI

extension InspectorBody {
    @ViewBuilder var layoutGuideSection: some View {
        // Frames only; one frame at a time.
        if n["type"] as? String == "frame", s.ids.count <= 1, !s.isPath {
            let list = LayoutGuides.list(n["metadata"])
            let write: ([[String: Any]]) -> Void = { l in
                if let m = LayoutGuides.metadata(n["metadata"], l) { model.update(["metadata": m]) } else { model.update([:], remove: ["metadata"]) }
            }
            InspectorSection(title: "Layout guide", trailing: {
                MiniButton(symbol: "plus", help: "Add layout guide", enabled: editable) { write(list + [LayoutGuides.make("grid")]) }
                    .accessibilityLabel("Add layout guide").modifier(QAFrame(id: "guides.plus"))
            }) {
                ForEach(0..<list.count, id: \.self) { i in
                    let g = list[i]
                    let set: ([String: Any]) -> Void = { v in var l = list; l[i] = v; write(l) }
                    layoutGuideRow(g, set: set, remove: { var l = list; l.remove(at: i); write(l) })
                }
            }
        }
    }

    @ViewBuilder private func layoutGuideRow(_ g: [String: Any], set: @escaping ([String: Any]) -> Void, remove: @escaping () -> Void) -> some View {
        let on = LayoutGuides.visible(g)
        let type = g["type"] as? String ?? "grid"
        let num: (String) -> Double? = { (g[$0] as? NSNumber)?.doubleValue }
        let field: (String, String, String, Double?, Double) -> AnyView = { key, prefix, help, value, minimum in
            // One letter is a prefix (W, H); anything longer names an SF Symbol: the panel is too narrow for words.
            AnyView(NumberField(prefix: prefix.count == 1 ? prefix : "", symbol: prefix.count == 1 ? nil : prefix, value: value, enabled: editable, minimum: minimum) { v in var o = g; o[key] = max(minimum, v); set(o) }
                .help(help).accessibilityLabel(help))
        }
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                MenuField(title: LayoutGuides.title(g), symbol: type == "grid" ? "grid" : type == "columns" ? "rectangle.split.3x1" : "rectangle.split.1x2") {
                    ForEach(LayoutGuides.types, id: \.tag) { t in Button(t.title) { set(LayoutGuides.withType(g, t.tag)) } }
                }
                .disabled(!editable).opacity(on ? 1 : 0.5).modifier(QAFrame(id: "guides.type.\(LayoutGuides.title(g))"))
                MiniButton(symbol: on ? "eye" : "eye.slash", help: on ? "Hide layout guide" : "Show layout guide", enabled: editable, inRow: true) {
                    set(LayoutGuides.withVisible(g, !on))
                }
                MiniButton(symbol: "minus", help: "Remove layout guide", enabled: editable, inRow: true, action: remove)
            }
            Group {
                if type == "grid" {
                    HStack(spacing: 8) {
                        field("size", "square.grid.3x3", "Grid size", num("size") ?? 10, 1)
                        guideColor(g, set: set)
                    }
                } else {
                    let align = g["align"] as? String ?? "stretch"
                    HStack(spacing: 8) {
                        field("count", "number", type == "rows" ? "Number of rows" : "Number of columns", num("count") ?? 5, 1)
                        MenuField(title: LayoutGuides.aligns(type).first { $0.tag == align }?.title ?? "Stretch") {
                            ForEach(LayoutGuides.aligns(type), id: \.tag) { a in Button(a.title) { set(LayoutGuides.withAlign(g, a.tag)) } }
                        }
                        .disabled(!editable).help("Type")
                    }
                    HStack(spacing: 8) {
                        if align == "stretch" {
                            field("margin", type == "rows" ? "arrow.up.and.down.square" : "arrow.left.and.right.square", "Margin", num("margin") ?? 0, 0)
                        } else {
                            field("width", type == "rows" ? "H" : "W", type == "rows" ? "Row height" : "Column width", num("width") ?? 60, 1)
                            if align != "center" { field("offset", "arrow.right.to.line", "Offset", num("offset") ?? 0, 0) }
                        }
                        field("gutter", type == "rows" ? "arrow.up.and.down" : "arrow.left.and.right", "Gutter", num("gutter") ?? 20, 0)
                    }
                    guideColor(g, set: set)
                }
            }
            .opacity(on ? 1 : 0.5)
        }
    }

    private func guideColor(_ g: [String: Any], set: @escaping ([String: Any]) -> Void) -> some View {
        let v = g["color"] as? String ?? LayoutGuides.defaultColor
        let write: (String) -> Void = { c in var o = g; o["color"] = c; set(o) }
        return FieldBox {
            ColorSwatchButton(value: v, enabled: editable, model: model, onChange: write, onCommit: write)
            HexField(value: v, enabled: editable, onCommit: write)
        }
        .help("Guide colour")
    }
}
