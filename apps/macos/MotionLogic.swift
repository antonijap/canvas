import Foundation

struct MotionAnimation: Identifiable {
    let id: String
    let trigger: String
    let tracks: [String]

    private static func title(_ value: String) -> String {
        switch value {
        case "boardHover": "Board hover"
        case "translateX": "Move X"
        case "translateY": "Move Y"
        case "scaleX": "Scale X"
        case "scaleY": "Scale Y"
        case "easeIn": "Ease in"
        case "easeOut": "Ease out"
        case "easeInOut": "Ease in out"
        default: value.prefix(1).uppercased() + value.dropFirst()
        }
    }

    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, let on = value["on"] as? String,
              let tracks = value["tracks"] as? [[String: Any]] else { return nil }
        self.id = id
        trigger = Self.title(on)
        self.tracks = tracks.compactMap { track in
            guard let prop = track["prop"] as? String else { return nil }
            let spring = (track["ease"] as? [String: Any])?["spring"] as? [String: Any]
            let duration = (track["duration"] as? NSNumber) ?? (spring?["duration"] as? NSNumber)
            let time = duration.map { "\($0) ms" } ?? (spring == nil ? "300 ms" : "Until settled")
            let ease = spring != nil ? "Spring" : (track["ease"] is [Any] ? "Cubic bezier" : Self.title(track["ease"] as? String ?? "linear"))
            return [Self.title(prop), time, ease].joined(separator: ", ")
        }
    }
}
