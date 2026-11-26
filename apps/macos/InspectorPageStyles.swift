import SwiftUI

struct PageInspectorStyles: View {
    @ObservedObject var model: CanvasModel
    let page: String
    let styles: PageStyles?

    var body: some View {
        PageStyleList(title: "Colors", rows: styles?.colors, empty: "No colors in use") { row in
            PageStyleRow(label: row.label, count: row.count, ids: row.ids, select: select) {
                ColorSwatchButton(value: row.value, enabled: row.editable && !model.cloudReadOnly && styles?.rev == model.revision,
                                  model: model, onChange: { _ in }) { to in
                    if let rev = styles?.rev {
                        model.replacePageColor(page: page, rev: rev, row: row, to: to)
                    }
                }
            }
        }
        PageStyleList(title: "Text", rows: styles?.text, empty: "No text styles in use") { row in
            PageStyleRow(label: row.label, count: row.count, ids: row.ids, select: select) { EmptyView() }
        }
    }

    private func select(_ ids: [String]) {
        LayersStore.of(model).select(ids)
    }
}

private struct PageStyleList<Row: Identifiable, Content: View>: View {
    let title: String
    let rows: [Row]?
    let empty: String
    @ViewBuilder var row: (Row) -> Content
    @State private var expanded = false

    var body: some View {
        InspectorSection(title: title) {
            if let rows {
                VStack(alignment: .leading, spacing: 4) {
                    if rows.isEmpty {
                        Text(empty).font(Typography.label).foregroundStyle(Palette.mutedFg)
                            .frame(height: Metric.field)
                    }
                    ForEach(PageStyles.visibleRows(rows, expanded: expanded), content: row)
                    if rows.count > PageStyles.rowLimit {
                        Button(expanded ? "Show less" : "Show all (\(rows.count))") { expanded.toggle() }
                            .buttonStyle(.plain).font(Typography.label).foregroundStyle(Palette.mutedFg)
                            .frame(height: Metric.field)
                    }
                }
            }
        }
    }
}

private struct PageStyleRow<Leading: View>: View {
    let label: String
    let count: Int
    let ids: [String]
    let select: ([String]) -> Void
    @ViewBuilder var leading: () -> Leading
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 4) {
            leading()
            Button { select(ids) } label: {
                HStack(spacing: 4) {
                    Text(label).foregroundStyle(Palette.fg).lineLimit(1).layoutPriority(1)
                    Spacer(minLength: 0)
                    Text("\(count)").foregroundStyle(Palette.mutedFg).monospacedDigit()
                }
                .font(Typography.label)
                .frame(height: Metric.field)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(ids.isEmpty)
            .accessibilityLabel(label)
            .accessibilityValue(count == 1 ? "1 layer" : "\(count) layers")
            .help(label)
        }
        .padding(.horizontal, 4)
        .background {
            if hovering {
                RoundedRectangle(cornerRadius: Metric.sidebarRadius)
                    .fill(scheme == .dark ? Color.white.opacity(20.0 / 255) : Color.black.opacity(15.0 / 255))
            }
        }
        .onHover { hovering = $0 }
    }
}

struct PageInspectorExport: View {
    let model: CanvasModel
    @State private var settings: PageExportSettings
    private let file: String

    init(model: CanvasModel, file: String) {
        self.model = model
        self.file = file
        _settings = State(initialValue: PageExportSettings(file: file))
    }

    var body: some View {
        let count = model.boards.count
        InspectorSection(title: "Export") {
            VStack(spacing: 4) {
                HStack(spacing: 4) {
                    MenuField(title: "\(ExportSettings.scaleText(settings.effectiveScale))x") {
                        ForEach(PageExportSettings.scales, id: \.self) { scale in
                            Button("\(ExportSettings.scaleText(scale))x") {
                                settings.scale = scale
                                settings.save(file: file)
                            }
                        }
                    }
                    .disabled(settings.isVector)
                    .help(settings.isVector ? "\(ExportSettings.title(settings.format)) exports at 1x" : "Scale")
                    MenuField(title: ExportSettings.title(settings.format)) {
                        ForEach(PageExportSettings.formats, id: \.id) { format in
                            Button(format.title) {
                                settings.format = format.id
                                settings.save(file: file)
                            }
                        }
                    }
                    .help("Format")
                }
                Button { model.exportPageBoards(settings) } label: {
                    Text(count == 1 ? "Export 1 board" : "Export \(count) boards")
                        .font(Typography.label).foregroundStyle(Palette.fg).lineLimit(1)
                        .frame(maxWidth: .infinity).frame(height: Metric.field)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField).fill(Palette.sidebarField))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}
