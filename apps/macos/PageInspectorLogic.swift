import Foundation

struct PageStyles: Decodable {
    struct ColorRow: Decodable, Identifiable {
        let value: String
        let token: String?
        let count: Int
        let ids: [String]
        let editable: Bool

        var id: String { token.map { "$" + $0 } ?? value }
        var label: String { token ?? value }
    }

    struct TextRow: Decodable, Identifiable {
        let family: String
        let weight: Double
        let size: Double
        let lineHeight: Double?
        let count: Int
        let ids: [String]

        struct Key: Hashable {
            let family: String
            let weight: Double
            let size: Double
            let lineHeight: Double?
        }

        var id: Key { Key(family: family, weight: weight, size: size, lineHeight: lineHeight) }
        var label: String {
            let name = weight == 600 ? "Semibold" : FontWeights.title(weight)
            let base = "\(family) \(name) \(size.formatted(.number.grouping(.never)))"
            guard let lineHeight else { return base }
            return "\(base) / \(lineHeight.formatted(.percent))"
        }
    }

    let rev: String
    let colors: [ColorRow]
    let text: [TextRow]

    static let rowLimit = 8

    static func visibleRows<Row>(_ rows: [Row], expanded: Bool) -> ArraySlice<Row> {
        expanded ? rows[...] : rows.prefix(rowLimit)
    }
}

struct PageExportSettings {
    static let scales = ExportSettings.scales.filter { [1.0, 2, 3].contains($0) }
    static let formats = ExportSettings.formats.filter { ["png", "jpg", "svg", "pdf"].contains($0.id) }
    private static let key = "canvas.pageExportSettings"

    var format = "png"
    var scale = 1.0
    var isVector: Bool { ExportSettings.isVector(format) }
    var effectiveScale: Double { isVector ? 1 : scale }

    init() {}

    init(file: String, defaults: UserDefaults = .standard) {
        let saved = defaults.dictionary(forKey: Self.key)?[file] as? [String: Any]
        if let format = saved?["format"] as? String, Self.formats.contains(where: { $0.id == format }) { self.format = format }
        if let scale = saved?["scale"] as? Double, Self.scales.contains(scale) { self.scale = scale }
    }

    func save(file: String, defaults: UserDefaults = .standard) {
        var all = defaults.dictionary(forKey: Self.key) ?? [:]
        all[file] = ["format": format, "scale": scale]
        defaults.set(all, forKey: Self.key)
    }
}
