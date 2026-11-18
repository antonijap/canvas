// Measures production chip views without opening a window. Run from apps/macos:
// swiftc -parse-as-library ShellLogic.swift SettingsLogic.swift HomeLogic.swift DesignSystem/{Theme,Tokens.generated,ViewMarks,Chips}.swift Tests/ChipLayoutTests.swift -o /tmp/chip-tests && /tmp/chip-tests
import AppKit
import SwiftUI

@main
struct ChipLayoutTests {
    static func main() {
        var failures = 0
        func check(_ condition: Bool, _ message: String) {
            if !condition { failures += 1; print("FAIL: \(message)") }
        }
        func size<V: View>(_ view: V) -> NSSize {
            NSHostingView(rootView: view).fittingSize
        }
        let alpha = size(Badge(text: "Alpha"))
        let plain = size(Text("Alpha").font(.system(size: 12, weight: .medium)))
        check(alpha.height == 22, "Alpha has the shared 22-point height, got \(alpha.height)")
        check(abs(alpha.width - plain.width - 16) < 1, "Alpha uses 12-point medium text and 8-point horizontal padding")
        for (text, tone) in [("Live", HomeLogic.Tone.live), ("Sign in", .attention), ("Checking", .muted)] {
            let pill = size(CloudPill(text: text, tone: tone))
            let label = size(Text(text).font(.system(size: 12, weight: .medium)))
            check(pill.height == alpha.height, "\(text) matches Alpha height")
            let dotWidth: CGFloat = tone == .muted ? 0 : 11
            check(abs(pill.width - label.width - 16 - dotWidth) < 1, "\(text) shares typography and padding, retaining its dot")
        }
        print(failures == 0 ? "ok: chip layout" : "\(failures) chip layout failures")
        exit(failures == 0 ? 0 : 1)
    }
}
