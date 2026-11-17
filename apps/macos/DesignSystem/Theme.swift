// Hand-written half of the design system: type, motion, and the Color helper the generated
// tokens use. Everything here is a value a component reads; no component hard-codes one.

import SwiftUI
import AppKit

extension Color {
    /// A color that follows the system appearance, like a CSS `:root` palette with a dark media query.
    init(light: UInt32, _ lightAlpha: Double = 1, dark: UInt32, _ darkAlpha: Double = 1) {
        func ns(_ hex: UInt32, _ a: Double) -> NSColor {
            NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                    blue: CGFloat(hex & 0xFF) / 255, alpha: a)
        }
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? ns(dark, darkAlpha) : ns(light, lightAlpha)
        })
    }
}

/// Sized for comfortable reading at arm's length: 11 for captions, 12 for labels, 13 for rows.
enum Typography {
    static let micro = Font.system(size: 11, weight: .regular)
    static let label = Font.system(size: 12, weight: .medium)
    static let body = Font.system(size: 13)
    static let title = Font.system(size: 14, weight: .semibold)
    static let mono = Font.system(size: 11, design: .monospaced)
    static let numeric = Font.system(size: 12, weight: .medium, design: .monospaced)
    static let section = Font.system(size: 11, weight: .semibold)
    /// The command palette's search field: one step up from a row, so the query reads first.
    static let prompt = Font.system(size: 15)
    /// A screen's title (Home): one step above the panel titles.
    static let display = Font.system(size: 22, weight: .semibold)
    /// A card's title on Home's first-launch cards.
    static let cardTitle = Font.system(size: 15, weight: .semibold)
    /// The app's name in About Canvas.
    static let appName = Font.system(size: 26, weight: .semibold)
}

/// The app-wide theme. `system` follows macOS; light and dark override it for the whole app,
/// the web canvas included (WKWebView follows the app's appearance).
enum AppTheme: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var symbol: String {
        switch self {
        case .system: "circle.lefthalf.filled"
        case .light: "sun.max"
        case .dark: "moon"
        }
    }
    var appearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }
    static var stored: AppTheme { AppTheme(rawValue: UserDefaults.standard.string(forKey: "canvas.theme") ?? "") ?? .system }
}

enum Motion {
    /// The island ease of src/tokens.ts (MOTION.island), cubic-bezier(.22, 1, .36, 1).
    static let island = Animation.timingInterval(0.25, c1x: 0.22, c1y: 1, c2x: 0.36, c2y: 1)
    static let fast = Animation.easeOut(duration: 0.15)
}

extension Animation {
    static func timingInterval(_ d: Double, c1x: Double, c1y: Double, c2x: Double, c2y: Double) -> Animation {
        .timingCurve(c1x, c1y, c2x, c2y, duration: d)
    }
}
