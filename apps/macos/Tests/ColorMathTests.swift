// Tests for DesignSystem/ColorMath.swift: hex, HSV/HSL, sRGB <-> OKLCH round trips and reference values,
// gamut mapping, CSS parsing, WCAG 2 ratios and APCA Lc against the published reference pairs.
// Run from apps/macos:
//   swiftc -parse-as-library DesignSystem/ColorMath.swift Tests/ColorMathTests.swift -o /tmp/colormath-tests && /tmp/colormath-tests

import Foundation

@main
struct ColorMathTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
        checks += 1
        if !ok { failures += 1; print("FAIL line \(line): \(what())") }
    }
    static func near(_ a: Double, _ b: Double, _ tol: Double, _ what: String, line: Int = #line) {
        check(abs(a - b) <= tol, "\(what): \(a) vs \(b) (±\(tol))", line: line)
    }

    static func main() {
        hex(); hsvHsl(); oklch(); gamut(); css(); wcag(); apca(); recipes(); nonFinite(); fieldText(); recents()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    static func hex() {
        check(RGBA(hex: "#0766EB")?.hex == "#0766EB", "6-digit round trip")
        check(RGBA(hex: "abc")?.hex == "#AABBCC", "3-digit expands")
        check(RGBA(hex: "#AABBCC80")?.hex == "#AABBCC80", "8-digit keeps alpha")
        check(RGBA(hex: "#AABBCCFF")?.hex == "#AABBCC", "opaque alpha dropped")
        check(RGBA(hex: "#abcd")?.hex == "#AABBCCDD", "4-digit")
        check(RGBA(hex: "#12345") == nil && RGBA(hex: "#GGGGGG") == nil, "bad hex rejected")
        // Every 8-bit value survives hex -> RGBA -> hex.
        for v in stride(from: 0, through: 255, by: 1) {
            let h = String(format: "#%02X%02X%02X", v, 255 - v, (v * 7) % 256)
            if RGBA(hex: h)?.hex != h { check(false, "hex round trip \(h)"); break }
        }
    }

    static func hsvHsl() {
        let samples = ["#FF0000", "#00FF00", "#0000FF", "#0766EB", "#F59E0B", "#808080", "#000000", "#FFFFFF", "#9747FF", "#123456"]
        for h in samples {
            let c = RGBA(hex: h)!
            check(RGBA(hsv: c.hsv).hex == h, "HSV round trip \(h)")
            check(RGBA(hsl: c.hsl).hex == h, "HSL round trip \(h)")
        }
        let red = RGBA(hex: "#FF0000")!.hsl
        near(red.h, 0, 1e-9, "red hue"); near(red.s, 1, 1e-9, "red sat"); near(red.l, 0.5, 1e-9, "red light")
        let blue = RGBA(hex: "#0000FF")!.hsv
        near(blue.h, 240, 1e-9, "blue hue")
        check(RGBA(hsl: HSL(h: 120, s: 1, l: 0.25)).hex == "#008000", "hsl(120 100% 25%) is CSS green")
        check(RGBA(hsv: HSV(h: 360, s: 1, v: 1)).hex == "#FF0000", "hue 360 wraps to red")
    }

    static func oklch() {
        // Reference values from Björn Ottosson's OKLab and the CSS Color 4 sample code.
        let red = RGBA(hex: "#FF0000")!.oklch
        near(red.l, 0.62796, 5e-4, "red L"); near(red.c, 0.25768, 5e-4, "red C"); near(red.h, 29.23, 0.05, "red h")
        let blue = RGBA(hex: "#0000FF")!.oklch
        near(blue.l, 0.45201, 5e-4, "blue L"); near(blue.c, 0.31321, 5e-4, "blue C"); near(blue.h, 264.05, 0.05, "blue h")
        let white = RGBA.white.oklch
        near(white.l, 1, 1e-4, "white L"); near(white.c, 0, 1e-4, "white C")
        near(RGBA.black.oklch.l, 0, 1e-6, "black L")
        // Round trips: every sRGB colour on a 17-step grid comes back to the same 8-bit hex.
        var worst = 0.0
        for r in stride(from: 0.0, through: 1, by: 1.0 / 16) {
            for g in stride(from: 0.0, through: 1, by: 1.0 / 16) {
                for b in stride(from: 0.0, through: 1, by: 1.0 / 16) {
                    let c = RGBA(r: r, g: g, b: b)
                    let back = RGBA(oklch: c.oklch)
                    worst = max(worst, abs(back.r - r), abs(back.g - g), abs(back.b - b))
                }
            }
        }
        near(worst, 0, 1e-5, "sRGB -> OKLCH -> sRGB worst channel error")
        check(RGBA(oklch: RGBA(hex: "#0766EB")!.oklch).hex == "#0766EB", "accent round trip")
    }

    static func gamut() {
        // oklch(70% 0.4 150) is far outside sRGB: chroma comes down, lightness and hue stay.
        let c = RGBA(oklch: OKLCH(l: 0.7, c: 0.4, h: 150))
        check(c.inGamut, "mapped colour is in gamut")
        let o = c.oklch
        near(o.l, 0.7, 0.01, "lightness kept"); near(o.h, 150, 4, "hue kept (clip within one JND)")
        check(o.c < 0.4, "chroma reduced")
        check(RGBA.fromOklchUnclamped(OKLCH(l: 0.7, c: 0.4, h: 150)).inGamut == false, "raw conversion was out of gamut")
    }

    /// Codex round 3 e3: a typed "nan" in a channel reached RGBA.hex and trapped in Int(_:).
    static func nonFinite() {
        check(RGBA(r: .nan, g: 0.5, b: 1, a: .nan).hex == "#0080FF00", "NaN channels format instead of trapping")
        check(RGBA(r: .infinity, g: -.infinity, b: 0, a: 1).hex == "#FF0000", "infinite channels clamp")
        check(CSSColor.parse("rgb(nan 0 0)") == nil, "rgb(nan …) rejected")
        check(CSSColor.parse("hsl(inf 50% 50%)") == nil, "hsl(inf …) rejected")
    }

    static func css() {
        let cases: [(String, String)] = [
            ("#0766eb", "#0766EB"), ("0766EB", "#0766EB"), ("tomato", "#FF6347"), ("RebeccaPurple", "#663399"),
            ("rgb(7, 102, 235)", "#0766EB"), ("rgb(7 102 235 / 50%)", "#0766EB80"), ("rgba(255,0,0,0.5)", "#FF000080"),
            ("rgb(100% 0% 0%)", "#FF0000"), ("hsl(120 100% 25%)", "#008000"), ("hsla(0, 100%, 50%, .25)", "#FF000040"),
            ("hsl(0.5turn 100% 50%)", "#00FFFF"), ("hwb(0 0% 0%)", "#FF0000"), ("hwb(0 50% 50%)", "#808080"),
            ("oklch(62.796% 0.25768 29.23)", "#FF0000"), ("oklch(0.45201 0.31321 264.05)", "#0000FF"),
            ("oklch(100% 0 0)", "#FFFFFF"), ("oklab(0.62796 0.22486 0.12585)", "#FF0000"),
            ("transparent", "#00000000"), ("  #fff;  ", "#FFFFFF"),
        ]
        for (input, want) in cases {
            let got = CSSColor.parse(input)?.hex
            check(got == want, "parse \(input) -> \(got ?? "nil"), want \(want)")
        }
        for bad in ["", "rgb(1 2)", "notacolour", "hsl(a b c)", "#12"] { check(CSSColor.parse(bad) == nil, "rejects \(bad)") }
        check(CSSColor.oklch(RGBA(hex: "#FF0000")!) == "oklch(62.8% 0.258 29.2)", "format oklch: \(CSSColor.oklch(RGBA(hex: "#FF0000")!))")
        check(CSSColor.rgb(RGBA(hex: "#0766EB80")!) == "rgb(7 102 235 / 0.5)", "format rgb: \(CSSColor.rgb(RGBA(hex: "#0766EB80")!))")
    }

    static func wcag() {
        // Published WCAG 2 values (WebAIM's checker).
        near(Contrast.wcag(.black, on: .white), 21, 1e-9, "black on white")
        near(Contrast.wcag(.white, on: .white), 1, 1e-9, "white on white")
        near(Contrast.wcag(RGBA(hex: "#767676")!, on: .white), 4.54, 0.005, "#767676 on white")
        near(Contrast.wcag(RGBA(hex: "#777777")!, on: .white), 4.48, 0.005, "#777777 on white")
        near(Contrast.wcag(RGBA(hex: "#0766EB")!, on: .white), 5.11, 0.01, "#0766EB on white")
        near(Contrast.wcag(.white, on: RGBA(hex: "#0766EB")!), Contrast.wcag(RGBA(hex: "#0766EB")!, on: .white), 1e-12, "symmetric")
        // 50% black over white is #808080 (to 8-bit): about 3.9.
        near(Contrast.wcag(RGBA(r: 0, g: 0, b: 0, a: 0.5), on: .white), Contrast.wcag(RGBA(r: 0.5, g: 0.5, b: 0.5), on: .white), 1e-9, "alpha composited")
        check(Contrast.wcagLevel(7.1) == "AAA" && Contrast.wcagLevel(4.6) == "AA" && Contrast.wcagLevel(3.2) == "AA Large" && Contrast.wcagLevel(2) == "Fail", "levels")
    }

    static func apca() {
        // The APCA 0.0.98G-4g reference pairs (text / background -> Lc), from the apca-w3 test suite.
        let pairs: [(String, String, Double)] = [
            ("#888888", "#FFFFFF", 63.056469930209424),
            ("#FFFFFF", "#888888", -68.54146436644962),
            ("#000000", "#AAAAAA", 58.146262578561334),
            ("#AAAAAA", "#000000", -56.24113336839742),
            ("#112233", "#DDEEFF", 91.66830811481631),
            ("#DDEEFF", "#112233", -93.06770049484275),
        ]
        for (t, b, lc) in pairs {
            near(Contrast.apca(RGBA(hex: t)!, on: RGBA(hex: b)!), lc, 0.01, "APCA \(t) on \(b)")
        }
        near(Contrast.apca(.black, on: .white), 106.04, 0.05, "black on white")
        near(Contrast.apca(.white, on: .black), -107.88, 0.05, "white on black")
        near(Contrast.apca(RGBA(hex: "#777777")!, on: RGBA(hex: "#787878")!), 0, 1e-9, "near-identical is 0")
    }

    static func recipes() {
        let accent = RGBA(hex: "#0766EB")!
        let ramp = ColorRecipes.ramp(accent)
        check(ramp.count == 7, "ramp has 7 steps")
        check(zip(ramp, ramp.dropFirst()).allSatisfy { $0.oklch.l > $1.oklch.l }, "ramp goes light to dark")
        check(ramp.allSatisfy { abs($0.oklch.h - accent.oklch.h) < 6 || $0.oklch.c < 0.04 }, "ramp keeps the hue")
        let white = ColorRecipes.textColors(on: .white, hue: accent)
        check(!white.isEmpty && white.allSatisfy { $0.wcag >= 3 }, "text options on white all readable")
        check(white.contains { abs($0.wcag - 4.5) < 0.3 && $0.color.oklch.c > 0.05 }, "an accent-hued option just past AA")
        check(white.contains { $0.wcag >= 7 && $0.color.oklch.c > 0.03 }, "an accent-hued AAA option")
        check(zip(white, white.dropFirst()).allSatisfy { $0.wcag >= $1.wcag }, "sorted by contrast")
        let dark = ColorRecipes.textColors(on: RGBA(hex: "#18181B")!, hue: accent)
        check(dark.first?.color.hex == "#FFFFFF", "white leads on a dark background")
        check(dark.allSatisfy { $0.apca < 0 }, "light text on dark has negative Lc")
    }

    // Round 5: channel fields jumped while a colour name or hex was typed key by key.
    static func fieldText() {
        check(!ColorFieldText.appliesLive(old: "ta", new: "tan"), "typing \"tan\" (on the way to tangerine) waits")
        check(!ColorFieldText.appliesLive(old: "#ab", new: "#abc"), "typing a hex waits")
        check(ColorFieldText.appliesLive(old: "", new: "tomato"), "a pasted name goes at once")
        check(ColorFieldText.appliesLive(old: "rgb(1,2,3", new: "rgb(1,2,3)"), "a closed rgb() goes at once")
        check(!ColorFieldText.appliesLive(old: "rgb(1,2", new: "rgb(1,2,"), "an open rgb( waits")
    }

    // Round 5: per-document recents were pruned alphabetically.
    static func recents() {
        let r = RecentKeys.touch(["/b", "/a", "/c"], "/z", limit: 3)
        check(r.order == ["/z", "/b", "/a"] && r.evicted == ["/c"], "the least recently edited goes: \(r)")
        let again = RecentKeys.touch(["/b", "/a", "/c"], "/c", limit: 3)
        check(again.order == ["/c", "/b", "/a"] && again.evicted.isEmpty, "editing one moves it to the front")
    }
}
