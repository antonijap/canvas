import Foundation

@main
struct PageInspectorLogicTests {
    static func main() {
        let rows = Array(0..<10).reversed()
        let ordered = Array(rows)
        precondition(Array(PageStyles.visibleRows(ordered, expanded: false)) == Array(rows.prefix(8)))
        precondition(Array(PageStyles.visibleRows(ordered, expanded: true)) == ordered)
        precondition(PageStyles.visibleRows([1, 2], expanded: false).count == 2)
        let style = PageStyles.TextRow(family: "Inter", weight: 600, size: 16, lineHeight: nil, count: 4, ids: ["title"])
        precondition(style.label == "Inter Semibold 16")
        let taller = PageStyles.TextRow(family: "Inter", weight: 600, size: 16, lineHeight: 1.25, count: 1, ids: ["body"])
        precondition(taller.id != style.id)
        precondition(taller.label.hasSuffix(1.25.formatted(.percent)))

        let suite = "canvas.page-inspector.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var settings = PageExportSettings()
        settings.scale = 3
        settings.format = "svg"
        settings.save(file: "Studio", defaults: defaults)
        var saved = PageExportSettings(file: "Studio", defaults: defaults)
        precondition(saved.format == "svg" && saved.scale == 3 && saved.effectiveScale == 1)
        saved.format = "jpg"
        precondition(saved.effectiveScale == 3)
        let fresh = PageExportSettings(file: "Draft", defaults: defaults)
        precondition(fresh.format == "png" && fresh.scale == 1)
        precondition(PageExportSettings.scales == [1, 2, 3])
        precondition(PageExportSettings.formats.map(\.id) == ["png", "jpg", "svg", "pdf"])
        print("ok: page inspector logic")
    }
}
