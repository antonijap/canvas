// The properties panel's Export section: "+" adds an export setting (scale, suffix, format) saved on the
// layer (metadata.canvasExports, ExportSettings in ShellLogic.swift), "-" removes one, and the button under them
// exports the layer with every setting into a folder. File > Export (Shift+Cmd+E) uses the same settings.

import SwiftUI

extension InspectorBody {
    private var exportSettings: [ExportSettings.Setting] { ExportSettings.read(n) }

    private func writeExports(_ list: [ExportSettings.Setting]) {
        if let m = ExportSettings.metadata(n["metadata"], list) { model.update(["metadata": m]) }
        else if n["metadata"] != nil { model.update([:], remove: ["metadata"]) }
    }

    @ViewBuilder var exportSection: some View {
        let multi = s.ids.count > 1
        let list = multi ? [] : exportSettings
        let canEdit = editable && !multi && !s.id.hasPrefix("widget:")
        InspectorSection(title: "Export", trailing: {
            if canEdit {
                MiniButton(symbol: "plus", help: "Add export setting") { writeExports(list + [ExportSettings.next(after: list)]) }
                    .modifier(QAFrame(id: "export.plus"))
            }
        }) {
            ForEach(Array(list.enumerated()), id: \.offset) { i, e in
                exportRow(e, set: { v in var l = list; l[i] = v; writeExports(l) }, remove: { var l = list; l.remove(at: i); writeExports(l) }, enabled: canEdit)
            }
            if !s.id.hasPrefix("widget:") {
                let ids = multi ? s.ids.filter { !$0.hasPrefix("widget:") } : [s.id]
                let name = multi ? "\(ids.count) layers" : (n["name"] as? String ?? s.id)
                Button { model.exportWithSettings(ids) } label: {
                    Text("Export \(name)").font(Typography.label).foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity).frame(height: Metric.field)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(list.isEmpty && !multi ? "Export as a 1x PNG; add settings with +" : "Export with these settings (\u{21E7}\u{2318}E)")
            }
        }
    }

    @ViewBuilder private func exportRow(_ e: ExportSettings.Setting, set: @escaping (ExportSettings.Setting) -> Void, remove: @escaping () -> Void, enabled: Bool) -> some View {
        let vector = ExportSettings.isVector(e.format)
        HStack(spacing: 4) {
            MenuField(title: vector ? "1x" : "\(ExportSettings.scaleText(e.scale))x") {
                ForEach(ExportSettings.scales, id: \.self) { sc in
                    Button("\(ExportSettings.scaleText(sc))x") { var v = e; v.scale = sc; set(v) }
                }
            }
            .frame(width: 64).disabled(!enabled || vector).help(vector ? "\(ExportSettings.title(e.format)) exports at 1x" : "Scale")
            TextInputField(placeholder: "Suffix", value: e.suffix, enabled: enabled) { t in var v = e; v.suffix = t; set(v) }
                .help("Added to the file name as typed")
            MenuField(title: ExportSettings.title(e.format)) {
                ForEach(ExportSettings.formats, id: \.id) { f in
                    Button(f.title) { var v = e; v.format = f.id; set(v) }
                }
            }
            .frame(width: 76).disabled(!enabled).help("Format")
            MiniButton(symbol: "minus", help: "Remove export setting", enabled: enabled, inRow: true, action: remove)
        }
    }
}

/// Where a control sits in its window (top-left origin), for a QA build's `qa.state` `frames`: SwiftUI shows its own
/// process no view tree, and text recognition is not always there to find it. A no-op in the app.
struct QAFrame: ViewModifier {
    let id: String
    func body(content: Content) -> some View {
        #if CANVAS_QA
        content.background(GeometryReader { g in
            Color.clear
                .onAppear { QAFrames.all[id] = g.frame(in: .global) }
                .onChange(of: g.frame(in: .global)) { _, f in QAFrames.all[id] = f }
        })
        #else
        content
        #endif
    }
}

#if CANVAS_QA
@MainActor enum QAFrames { static var all: [String: CGRect] = [:] }
#endif
