import SwiftUI

/// One line box and one silhouette for labels that appear together.
struct ChipLabel: View {
    let text: String
    let fill: Color
    let ink: Color
    var dot: Color? = nil

    var body: some View {
        HStack(spacing: ChipMetric.dotGap) {
            if let dot { Circle().fill(dot).frame(width: ChipMetric.dotSize, height: ChipMetric.dotSize) }
            Text(text).font(Typography.chip).foregroundStyle(ink).lineLimit(1)
                // A single line occupies 100% of the font size; the chip supplies the outer spacing.
                .frame(height: ChipMetric.fontSize)
        }
        .padding(.horizontal, ChipMetric.horizontalPadding)
        .frame(height: ChipMetric.height)
        .background(RoundedRectangle(cornerRadius: ChipMetric.cornerRadius).fill(fill))
        .fixedSize()
    }
}

/// A compact, noninteractive maturity label.
struct Badge: View {
    let text: String
    var body: some View {
        ChipLabel(text: text, fill: BadgeInk.amberFill, ink: BadgeInk.amber).qaText(text)
    }
}

/// Status text follows the hue of its own tinted background.
enum CloudInk {
    static let live = Color(light: 0x15803D, dark: 0x86EFAC)
    static let warn = Color(light: 0xB45309, dark: 0xFCD34D)
}

/// A status chip retains its tone and optional action while sharing maturity-label geometry.
struct CloudPill: View {
    let text: String
    let tone: HomeLogic.Tone
    var action: () -> Void = {}

    var body: some View {
        let (fill, ink): (Color, Color) = switch tone {
        case .live: (Palette.ok.opacity(0.16), CloudInk.live)
        case .attention: (Palette.warn.opacity(0.18), CloudInk.warn)
        case .muted: (Palette.active, Palette.mutedFg)
        }
        Button(action: action) {
            ChipLabel(text: text, fill: fill, ink: ink,
                      dot: tone == .muted ? nil : (tone == .live ? Palette.ok : Palette.warn))
                .contentShape(RoundedRectangle(cornerRadius: ChipMetric.cornerRadius))
        }
        .buttonStyle(.plain)
        .qaID("home-cloud-pill", label: text)
    }
}
