// Talk to the selection, the native half: the spark as real Liquid Glass (the talk-to-selection design, boards 1-6).
// The page (src/page/spark.js) works out where the spark and any progress rings go, in the same frame as the camera,
// and posts them on the "canvasSpark" handler only when they change; this draws them over the web view with the
// system glass. A click goes back to the page ({cmd: "sparkClick", id}), which opens the composer (drawn by the page)
// or flies to a run's layer. Hover shows the tooltip: "Ask about this ⌘↩", or the step under way ("Softening the
// shadow  3 of 4") on a ring.

import SwiftUI
import AppKit
import WebKit

/// One glass button the page asked for: the spark on the selection, or a run's progress ring.
struct SparkItem: Identifiable, Equatable {
    let id: String
    /// Top-left in window points (the page's CSS px; the web view fills the window).
    let x: CGFloat
    let y: CGFloat
    /// "spark" or "ring".
    let kind: String
    /// The composer is open on it: accent glass, white glyph.
    let active: Bool
    /// The layer has a thread.
    let dot: Bool
    /// The ring's arc in degrees; nil spins (no plan, so no count).
    let sweep: Double?
    let tip: String
    let count: String

    init?(_ d: [String: Any]) {
        guard let id = d["id"] as? String, let x = (d["x"] as? NSNumber)?.doubleValue, let y = (d["y"] as? NSNumber)?.doubleValue else { return nil }
        self.id = id
        self.x = x
        self.y = y
        kind = d["kind"] as? String == "ring" ? "ring" : "spark"
        active = d["active"] as? Bool ?? false
        dot = d["dot"] as? Bool ?? false
        sweep = (d["sweep"] as? NSNumber)?.doubleValue
        tip = d["tip"] as? String ?? ""
        count = d["count"] as? String ?? ""
    }
}

final class SparkController: NSObject, ObservableObject, WKScriptMessageHandler {
    static let shared = SparkController()
    @Published private(set) var items: [SparkItem] = []
    /// The web view the items came from: another tab's sparks are never shown.
    private(set) weak var source: WKWebView?
    private(set) weak var model: CanvasModel?
    private var installed = false

    func install(_ model: CanvasModel) {
        guard !installed else { return }
        installed = true
        self.model = model
        // macOS draws its input source badge at the caret of a focused text field (a white box with the input source's
        // glyph): over the composer's field it covered the first letters and the spark. Canvas's own fields don't want it.
        UserDefaults.standard.set(false, forKey: "TSMLanguageIndicatorEnabled")
        model.webView.configuration.userContentController.add(self, name: "canvasSpark")
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === model?.webView, let text = message.body as? String, let data = text.data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        source = message.webView
        let next = list.compactMap(SparkItem.init)
        if next != items { items = next }
    }

    func click(_ id: String) {
        model?.run("{cmd:'sparkClick',id:\(jsString(id))}")
    }
}

/// Over the whole window, above the canvas: hit-testable only where a spark is.
struct SparkLayer: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject private var spark = SparkController.shared

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear.allowsHitTesting(false)
            if spark.source === model.webView {
                ForEach(spark.items) { item in
                    SparkButton(item: item) { spark.click(item.id) }
                        .offset(x: item.x, y: item.y)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .ignoresSafeArea()
        .onAppear { spark.install(model) }
    }
}

/// The 28 pt glass circle: sparkles.2 in the accent (white on accent glass when its composer is open), a dot when the
/// layer has a thread, the progress ring drawn on the glass while a run goes.
struct SparkButton: View {
    let item: SparkItem
    let action: () -> Void
    @State private var spin = false
    @Environment(\.appearsActive) private var appearsActive

    private static let size: CGFloat = 28

    /// Grey magic: the glyph in the text colour; blue stays for the canvas selection and Keep. A rounded square, 8 pt.
    private static let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)

    var body: some View {
        Button(action: action) {
            ZStack {
                Image(systemName: "sparkles.2")
                    .font(.system(size: item.kind == "ring" ? 13 : 15, weight: .medium))
                    .foregroundStyle(Palette.fg)
                if item.kind == "ring" { ring }
            }
            .frame(width: Self.size, height: Self.size)
            .contentShape(Self.shape)
        }
        .buttonStyle(.plain)
        .sparkTip(item.active ? nil : item)
        // Active (its composer open): a slightly stronger, pressed glass, not a colour.
        .background { if item.active { Self.shape.fill(Palette.fg.opacity(appearsActive ? 0.08 : 0.12)) } }
        .glassEffect(.regular.interactive(), in: Self.shape)
        // Clear glass on a white canvas needs a lift to read: layered shadows (contact, short, ambient), never a border.
        .shadow(color: .black.opacity(item.active ? 0 : 0.10), radius: 0.5)
        .shadow(color: .black.opacity(item.active ? 0.10 : 0.12), radius: 2, y: 1)
        .shadow(color: .black.opacity(0.16), radius: 12, y: 6)
        .overlay(alignment: .topTrailing) {
            if item.dot && !item.active {
                Circle().fill(Palette.fg).frame(width: 8, height: 8)
                    .overlay(Circle().strokeBorder(Color.white, lineWidth: 1.5).padding(-1.5))
                    .offset(x: 1, y: -1)
                    .allowsHitTesting(false)
            }
        }
        .accessibilityLabel(item.kind == "ring" ? "\(item.tip) \(item.count)" : "Ask about this")
        .qaID("canvas-spark-" + item.id)
    }

    /// Track and arc, 2.5 pt, just inside the glass edge. No plan: a quarter arc going round.
    private var ring: some View {
        ZStack {
            Circle().stroke(Palette.line, lineWidth: 2.5)
            Circle().trim(from: 0, to: CGFloat((item.sweep ?? 90) / 360))
                .stroke(Palette.fg.opacity(0.6), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(item.sweep == nil && spin ? 270 : -90))
                .animation(item.sweep == nil ? .linear(duration: 1.2).repeatForever(autoreverses: false) : .easeOut(duration: 0.3), value: spin)
                .animation(.easeOut(duration: 0.3), value: item.sweep)
        }
        .padding(1.25)
        .onAppear { spin = true }
    }

}

/// The spark's tooltip, the design's (dark, single-line labels, keycaps), not the system one: "Ask about this ⌘↩", or
/// on a ring the step under way and its count. Shown while the pointer is over the button; nil shows nothing.
private struct SparkTip: ViewModifier {
    let tipItem: SparkItem?
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topLeading) {
                if hovering, let t = tipItem, !t.tip.isEmpty { tooltip(t).offset(x: 28 + 8, y: 2).fixedSize().allowsHitTesting(false) }
            }
            .onHover { hovering = $0 }
    }

    /// The design's dark tooltip: single-line labels, keycaps for the shortcut (Symbols centred in their caps).
    private func tooltip(_ tipItem: SparkItem) -> some View {
        HStack(spacing: 8) {
            Text(tipItem.tip).font(.system(size: 12, weight: .medium)).foregroundStyle(.white).lineLimit(1)
            if tipItem.kind == "ring" {
                if !tipItem.count.isEmpty { Text(tipItem.count).font(.system(size: 12)).foregroundStyle(Color.white.opacity(0.65)).lineLimit(1) }
            } else {
                HStack(spacing: 2) {
                    keycap("command")
                    keycap("return")
                }
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Palette.tooltip))
    }

    private func keycap(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 9, weight: .medium)).foregroundStyle(Color.white.opacity(0.85))
            .frame(width: 18, height: 18)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Color.white.opacity(0.15)))
    }
}

extension View {
    func sparkTip(_ item: SparkItem?) -> some View { modifier(SparkTip(tipItem: item)) }
}
