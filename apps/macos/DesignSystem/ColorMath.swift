// Colour math for the colour picker, pure Foundation so it builds and tests without SwiftUI:
// hex and CSS parsing, HSV / HSL / OKLCH conversions, sRGB gamut mapping, WCAG 2 contrast ratio,
// APCA Lc (0.0.98G-4g), and the tints, shades and text colours the picker recommends.
// Tests: apps/macos/Tests/ColorMathTests.swift (its header has the run command).

import Foundation

/// An sRGB colour, channels 0...1, straight (not premultiplied) alpha.
struct RGBA: Equatable, Hashable {
    var r: Double, g: Double, b: Double, a: Double = 1

    init(r: Double, g: Double, b: Double, a: Double = 1) { self.r = r; self.g = g; self.b = b; self.a = a }

    static let white = RGBA(r: 1, g: 1, b: 1)
    static let black = RGBA(r: 0, g: 0, b: 0)

    var clamped: RGBA { RGBA(r: r.clamped01, g: g.clamped01, b: b.clamped01, a: a.clamped01) }
    var opaque: RGBA { RGBA(r: r, g: g, b: b, a: 1) }
    func with(alpha: Double) -> RGBA { RGBA(r: r, g: g, b: b, a: alpha.clamped01) }

    // MARK: hex

    /// "#RGB", "#RGBA", "#RRGGBB", "#RRGGBBAA", with or without "#".
    init?(hex: String) {
        var h = hex.trimmingCharacters(in: .whitespaces)
        if h.hasPrefix("#") { h.removeFirst() }
        guard [3, 4, 6, 8].contains(h.count), h.allSatisfy(\.isHexDigit), let v = UInt64(h, radix: 16) else { return nil }
        if h.count <= 4 {
            let n = h.count
            func nib(_ i: Int) -> Double { Double((v >> UInt64(4 * (n - 1 - i))) & 0xF) * 17 / 255 }
            self.init(r: nib(0), g: nib(1), b: nib(2), a: n == 4 ? nib(3) : 1)
        } else {
            let n = h.count / 2
            func byte(_ i: Int) -> Double { Double((v >> UInt64(8 * (n - 1 - i))) & 0xFF) / 255 }
            self.init(r: byte(0), g: byte(1), b: byte(2), a: n == 4 ? byte(3) : 1)
        }
    }

    /// "#RRGGBB", or "#RRGGBBAA" when not opaque. Uppercase, like the documents store it.
    var hex: String {
        let c = clamped
        func b(_ x: Double) -> Int { Int((x * 255).rounded()) }
        let rgb = String(format: "#%02X%02X%02X", b(c.r), b(c.g), b(c.b))
        return b(c.a) == 255 ? rgb : rgb + String(format: "%02X", b(c.a))
    }

    /// "RRGGBB" without the hash or alpha, for the hex field.
    var hex6: String { String(hex.dropFirst().prefix(6)) }

    /// This colour drawn over an opaque background.
    func over(_ bg: RGBA) -> RGBA {
        RGBA(r: r * a + bg.r * (1 - a), g: g * a + bg.g * (1 - a), b: b * a + bg.b * (1 - a), a: 1)
    }
}

extension Double {
    /// NaN becomes 0 (a typed "nan" must never reach Int(_:), which traps).
    var clamped01: Double { isNaN ? 0 : Swift.min(Swift.max(self, 0), 1) }
    /// Hue in [0, 360).
    var wrappedHue: Double { let h = truncatingRemainder(dividingBy: 360); return h < 0 ? h + 360 : h }
}

// MARK: HSV / HSL

struct HSV: Equatable { var h: Double, s: Double, v: Double }   // h 0..<360, s v 0...1
struct HSL: Equatable { var h: Double, s: Double, l: Double }   // h 0..<360, s l 0...1

extension RGBA {
    private static func hue(_ r: Double, _ g: Double, _ b: Double, _ mx: Double, _ d: Double) -> Double {
        guard d > 1e-12 else { return 0 }
        let h: Double
        if mx == r { h = (g - b) / d } else if mx == g { h = (b - r) / d + 2 } else { h = (r - g) / d + 4 }
        return (h * 60).wrappedHue
    }

    var hsv: HSV {
        let mx = max(r, g, b), mn = min(r, g, b), d = mx - mn
        return HSV(h: Self.hue(r, g, b, mx, d), s: mx == 0 ? 0 : d / mx, v: mx)
    }

    init(hsv: HSV, a: Double = 1) {
        let h = hsv.h.wrappedHue
        func f(_ n: Double) -> Double {
            let k = (n + h / 60).truncatingRemainder(dividingBy: 6)
            return hsv.v - hsv.v * hsv.s * max(0, min(k, 4 - k, 1))
        }
        self.init(r: f(5), g: f(3), b: f(1), a: a)
    }

    var hsl: HSL {
        let mx = max(r, g, b), mn = min(r, g, b), d = mx - mn, l = (mx + mn) / 2
        let s = d < 1e-12 ? 0 : d / (1 - abs(2 * l - 1))
        return HSL(h: Self.hue(r, g, b, mx, d), s: s, l: l)
    }

    init(hsl: HSL, a: Double = 1) {
        let h = hsl.h.wrappedHue, amp = hsl.s * min(hsl.l, 1 - hsl.l)
        func f(_ n: Double) -> Double {
            let k = (n + h / 30).truncatingRemainder(dividingBy: 12)
            return hsl.l - amp * max(-1, min(k - 3, 9 - k, 1))
        }
        self.init(r: f(0), g: f(8), b: f(4), a: a)
    }
}

// MARK: OKLab / OKLCH (Björn Ottosson, 2020)

struct OKLCH: Equatable { var l: Double, c: Double, h: Double }   // l 0...1, c 0...~0.4, h 0..<360

extension RGBA {
    static func toLinear(_ x: Double) -> Double { x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4) }
    static func toGamma(_ x: Double) -> Double { x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055 }

    var oklab: (l: Double, a: Double, b: Double) {
        let lr = Self.toLinear(r), lg = Self.toLinear(g), lb = Self.toLinear(b)
        let l = cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
        let m = cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
        let s = cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
        return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)
    }

    /// Unclamped: may fall outside sRGB. Use `init(oklch:)` for a displayable colour.
    static func fromOklab(_ L: Double, _ A: Double, _ B: Double, alpha: Double = 1) -> RGBA {
        let l = pow(L + 0.3963377774 * A + 0.2158037573 * B, 3)
        let m = pow(L - 0.1055613458 * A - 0.0638541728 * B, 3)
        let s = pow(L - 0.0894841775 * A - 1.2914855480 * B, 3)
        return RGBA(r: toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
                    g: toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
                    b: toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s), a: alpha)
    }

    var oklch: OKLCH {
        let (l, a, b) = oklab
        let c = (a * a + b * b).squareRoot()
        return OKLCH(l: l, c: c, h: c < 1e-6 ? 0 : (atan2(b, a) * 180 / .pi).wrappedHue)
    }

    static func fromOklchUnclamped(_ o: OKLCH, alpha: Double = 1) -> RGBA {
        let hr = o.h * .pi / 180
        return fromOklab(o.l, o.c * cos(hr), o.c * sin(hr), alpha: alpha)
    }

    var inGamut: Bool { [r, g, b].allSatisfy { $0 >= -1e-4 && $0 <= 1 + 1e-4 } }

    /// Euclidean distance in OKLab (CSS Color 4's deltaEOK).
    static func deltaEOK(_ x: RGBA, _ y: RGBA) -> Double {
        let p = x.oklab, q = y.oklab
        return ((p.l - q.l) * (p.l - q.l) + (p.a - q.a) * (p.a - q.a) + (p.b - q.b) * (p.b - q.b)).squareRoot()
    }

    /// The colour at this lightness and hue with the most chroma up to `c` that sRGB holds exactly (no clipping, so the hue never drifts).
    static func strictOklch(_ o: OKLCH, a: Double = 1) -> RGBA {
        var lo = 0.0, hi = max(0, o.c)
        if fromOklchUnclamped(o, alpha: a).inGamut { return fromOklchUnclamped(o, alpha: a).clamped }
        for _ in 0..<30 {
            let c = (lo + hi) / 2
            if fromOklchUnclamped(OKLCH(l: o.l, c: c, h: o.h), alpha: a).inGamut { lo = c } else { hi = c }
        }
        return fromOklchUnclamped(OKLCH(l: o.l, c: lo, h: o.h), alpha: a).clamped
    }

    /// OKLCH to sRGB with CSS Color 4's gamut mapping: keep lightness and hue, reduce chroma until clipping
    /// the colour changes it by less than a just noticeable difference (deltaEOK 0.02).
    init(oklch o: OKLCH, a: Double = 1) {
        let l = o.l
        if l >= 1 { self = RGBA(r: 1, g: 1, b: 1, a: a.clamped01); return }
        if l <= 0 { self = RGBA(r: 0, g: 0, b: 0, a: a.clamped01); return }
        let at = { (c: Double) in RGBA.fromOklchUnclamped(OKLCH(l: l, c: c, h: o.h), alpha: a) }
        let origin = at(max(0, o.c))
        if origin.inGamut { self = origin.clamped; return }
        let jnd = 0.02, eps = 0.0001
        var clipped = origin.clamped
        if RGBA.deltaEOK(clipped, origin) < jnd { self = clipped; return }
        var lo = 0.0, hi = max(0, o.c), loInGamut = true
        while hi - lo > eps {
            let c = (lo + hi) / 2, cur = at(c)
            if loInGamut && cur.inGamut { lo = c; continue }
            clipped = cur.clamped
            let e = RGBA.deltaEOK(clipped, cur)
            if e < jnd {
                if jnd - e < eps { break }
                loInGamut = false; lo = c
            } else {
                hi = c
            }
        }
        self = clipped
    }
}

// MARK: contrast

enum Contrast {
    /// WCAG 2 relative luminance of an opaque sRGB colour.
    static func luminance(_ c: RGBA) -> Double {
        0.2126 * RGBA.toLinear(c.r) + 0.7152 * RGBA.toLinear(c.g) + 0.0722 * RGBA.toLinear(c.b)
    }

    /// WCAG 2 contrast ratio, 1...21. A translucent text colour is first drawn over the background.
    static func wcag(_ text: RGBA, on bg: RGBA) -> Double {
        let t = text.over(bg.opaque), l1 = luminance(t), l2 = luminance(bg.opaque)
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    /// The WCAG level a ratio passes for normal text: "AAA", "AA", "AA Large" or "Fail".
    static func wcagLevel(_ ratio: Double) -> String {
        ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA Large" : "Fail"
    }

    /// APCA lightness contrast Lc (0.0.98G-4g constants). Positive for dark text on light, negative for light on dark.
    static func apca(_ text: RGBA, on bg: RGBA) -> Double {
        func y(_ c: RGBA) -> Double {
            let v = 0.2126729 * pow(c.r.clamped01, 2.4) + 0.7151522 * pow(c.g.clamped01, 2.4) + 0.0721750 * pow(c.b.clamped01, 2.4)
            return v > 0.022 ? v : v + pow(0.022 - v, 1.414)
        }
        let yt = y(text.over(bg.opaque)), yb = y(bg.opaque)
        guard abs(yb - yt) >= 0.0005 else { return 0 }
        if yb > yt {
            let sapc = (pow(yb, 0.56) - pow(yt, 0.57)) * 1.14
            return sapc < 0.1 ? 0 : (sapc - 0.027) * 100
        } else {
            let sapc = (pow(yb, 0.65) - pow(yt, 0.62)) * 1.14
            return sapc > -0.1 ? 0 : (sapc + 0.027) * 100
        }
    }
}

// MARK: recommendations

enum ColorRecipes {
    /// Lighter to darker steps of a colour in OKLCH: same hue, chroma eased toward the ends so tints stay clean.
    static func ramp(_ base: RGBA, lightness: [Double] = [0.96, 0.88, 0.76, 0.62, 0.48, 0.36, 0.26]) -> [RGBA] {
        let o = base.oklch
        return lightness.map { l in
            // Chroma peaks mid-ramp; near white or black a full chroma would leave the gamut and clip to grey anyway.
            let edge = min(l, 1 - l) / 0.5
            return RGBA.strictOklch(OKLCH(l: l, c: o.c * min(1, 0.35 + edge), h: o.h))
        }
    }

    struct TextOption: Equatable { let color: RGBA; let wcag: Double; let apca: Double }

    /// Text colours that read on `bg`: the most legible neutral, then the base hue at the lightness that
    /// first clears WCAG AA (4.5:1) on each side, then the AAA (7:1) version. Duplicates dropped.
    static func textColors(on bg: RGBA, hue base: RGBA?) -> [TextOption] {
        let bgO = bg.opaque
        let darkBg = Contrast.luminance(bgO) < 0.18
        var picks: [RGBA] = [darkBg ? .white : RGBA(hex: "#18181B")!, darkBg ? RGBA(hex: "#18181B")! : .white]
        if let base {
            let o = base.oklch
            for target in [4.5, 7.0] {
                if let c = firstPassing(hue: o.h, chroma: o.c, on: bgO, ratio: target, towardDark: !darkBg) { picks.append(c) }
            }
        }
        var seen = Set<String>()
        return picks.compactMap { c in
            guard seen.insert(c.hex).inserted else { return nil }
            return TextOption(color: c, wcag: Contrast.wcag(c, on: bgO), apca: Contrast.apca(c, on: bgO))
        }
        .filter { $0.wcag >= 3 }
        .sorted { $0.wcag > $1.wcag }
    }

    /// The lightness, walking from the background's lightness toward black (or white), at which this hue first reaches `ratio`.
    static func firstPassing(hue: Double, chroma: Double, on bg: RGBA, ratio: Double, towardDark: Bool) -> RGBA? {
        let start = bg.oklch.l
        var l = start
        for _ in 0..<100 {
            l += towardDark ? -0.01 : 0.01
            guard l >= 0, l <= 1 else { return nil }
            let c = RGBA.strictOklch(OKLCH(l: l, c: chroma, h: hue))
            if Contrast.wcag(c, on: bg) >= ratio { return c }
        }
        return nil
    }
}

// MARK: CSS parsing

enum CSSColor {
    /// Parses a CSS colour: hex (with or without #), rgb()/rgba(), hsl()/hsla(), oklch(), oklab(),
    /// hwb(), a named colour, or "transparent". Commas or spaces, "/ alpha", percentages and units are accepted.
    static func parse(_ input: String) -> RGBA? {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: ";")).lowercased()
        guard !s.isEmpty else { return nil }
        if s == "transparent" { return RGBA(r: 0, g: 0, b: 0, a: 0) }
        if let named = names[s] { return RGBA(hex: named) }
        if let c = RGBA(hex: s) { return c }
        guard let open = s.firstIndex(of: "("), s.hasSuffix(")") else { return nil }
        let fn = String(s[..<open]).trimmingCharacters(in: .whitespaces)
        let body = s[s.index(after: open)..<s.index(before: s.endIndex)]
        let parts = body.replacingOccurrences(of: ",", with: " ").replacingOccurrences(of: "/", with: " / ")
            .split(whereSeparator: { $0 == " " }).map(String.init)
        var comps: [String] = [], alphaPart: String?
        var i = 0
        while i < parts.count {
            if parts[i] == "/" { alphaPart = i + 1 < parts.count ? parts[i + 1] : nil; break }
            comps.append(parts[i]); i += 1
        }
        if alphaPart == nil, comps.count == 4 { alphaPart = comps.removeLast() }
        guard comps.count == 3 else { return nil }
        let alpha = alphaPart.flatMap { number($0, percentOf: 1) }?.clamped01 ?? 1
        switch fn {
        case "rgb", "rgba":
            guard let r = number(comps[0], percentOf: 255), let g = number(comps[1], percentOf: 255), let b = number(comps[2], percentOf: 255) else { return nil }
            return RGBA(r: r / 255, g: g / 255, b: b / 255, a: alpha).clamped
        case "hsl", "hsla":
            guard let h = angle(comps[0]), let sat = number(comps[1], percentOf: 100), let l = number(comps[2], percentOf: 100) else { return nil }
            return RGBA(hsl: HSL(h: h, s: (sat / 100).clamped01, l: (l / 100).clamped01), a: alpha)
        case "hwb":
            guard let h = angle(comps[0]), let w0 = number(comps[1], percentOf: 100), let b0 = number(comps[2], percentOf: 100) else { return nil }
            var w = w0 / 100, bl = b0 / 100
            if w + bl >= 1 { let g = w / (w + bl); return RGBA(r: g, g: g, b: g, a: alpha) }
            w = w.clamped01; bl = bl.clamped01
            let v = 1 - bl
            return RGBA(hsv: HSV(h: h, s: v == 0 ? 0 : 1 - w / v, v: v), a: alpha)
        case "oklch":
            guard let l = number(comps[0], percentOf: 1), let c = number(comps[1], percentOf: 0.4), let h = angle(comps[2]) else { return nil }
            return RGBA(oklch: OKLCH(l: l, c: c, h: h), a: alpha)
        case "oklab":
            guard let l = number(comps[0], percentOf: 1), let a = number(comps[1], percentOf: 0.4), let b = number(comps[2], percentOf: 0.4) else { return nil }
            let o = RGBA.fromOklab(l, a, b).oklch
            return RGBA(oklch: o, a: alpha)
        default:
            return nil
        }
    }

    /// "50%" -> 50% of `percentOf`; "0.5" -> 0.5; "none" -> 0.
    static func number(_ s: String, percentOf full: Double) -> Double? {
        if s == "none" { return 0 }
        if s.hasSuffix("%") { return Double(s.dropLast()).flatMap { $0.isFinite ? $0 / 100 * full : nil } }
        return Double(s).flatMap { $0.isFinite ? $0 : nil }
    }

    /// Degrees from "120", "120deg", "0.5turn", "3.14rad", "200grad".
    static func angle(_ s: String) -> Double? {
        if s == "none" { return 0 }
        for (unit, k) in [("deg", 1.0), ("turn", 360.0), ("grad", 0.9), ("rad", 180 / Double.pi)] where s.hasSuffix(unit) {
            return Double(s.dropLast(unit.count)).flatMap { $0.isFinite ? ($0 * k).wrappedHue : nil }
        }
        return Double(s).flatMap { $0.isFinite ? $0.wrappedHue : nil }
    }

    // MARK: formatting

    static func rgb(_ c: RGBA) -> String {
        let x = c.clamped
        let core = "\(Int((x.r * 255).rounded())) \(Int((x.g * 255).rounded())) \(Int((x.b * 255).rounded()))"
        return x.a < 1 ? "rgb(\(core) / \(fmt(x.a, 2)))" : "rgb(\(core))"
    }

    static func hsl(_ c: RGBA) -> String {
        let h = c.hsl
        let core = "\(fmt(h.h, 0)) \(fmt(h.s * 100, 0))% \(fmt(h.l * 100, 0))%"
        return c.a < 1 ? "hsl(\(core) / \(fmt(c.a, 2)))" : "hsl(\(core))"
    }

    static func oklch(_ c: RGBA) -> String {
        let o = c.oklch
        let core = "\(fmt(o.l * 100, 1))% \(fmt(o.c, 3)) \(fmt(o.h, 1))"
        return c.a < 1 ? "oklch(\(core) / \(fmt(c.a, 2)))" : "oklch(\(core))"
    }

    /// A number with at most `digits` decimals and no trailing zeros.
    static func fmt(_ v: Double, _ digits: Int) -> String {
        var s = String(format: "%.\(digits)f", v)
        if s.contains(".") { while s.hasSuffix("0") { s.removeLast() }; if s.hasSuffix(".") { s.removeLast() } }
        return s == "-0" ? "0" : s
    }

    /// The 148 CSS named colours.
    static let names: [String: String] = {
        let table = """
        aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 \
        blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 \
        chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b \
        darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b \
        darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a \
        darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 \
        darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff \
        firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 \
        goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 \
        indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 \
        lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 \
        lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa \
        lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 \
        linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 \
        mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc \
        mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead \
        navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 \
        palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 \
        peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 \
        rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 \
        seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 \
        snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 \
        turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32
        """
        let w = table.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init)
        var out: [String: String] = [:]
        for i in stride(from: 0, to: w.count - 1, by: 2) { out[w[i]] = w[i + 1] }
        return out
    }()
}

/// What the picker's number and hex fields do with text as it changes. A colour pasted into a field (several
/// characters at once, or a closed "rgb(…)" / "oklch(…)") replaces the whole colour at once; text typed key by
/// key ("tan" on the way to "tangerine", "#ab" on the way to "#abcdef") waits for Return, Tab or leaving the field,
/// so the other channels do not jump under the typing.
enum ColorFieldText {
    static func appliesLive(old: String, new: String) -> Bool {
        let t = new.trimmingCharacters(in: .whitespaces)
        if t.contains("("), t.hasSuffix(")") { return true }
        return new.count - old.count > 1
    }
}

/// Per-document recent colours keep the documents edited most recently: `touch` moves `key` to the front of the
/// most-recent-first order and says which keys fell past `limit` (their lists are dropped).
enum RecentKeys {
    static func touch(_ order: [String], _ key: String, limit: Int) -> (order: [String], evicted: [String]) {
        let all = [key] + order.filter { $0 != key }
        return (Array(all.prefix(limit)), Array(all.dropFirst(limit)))
    }
}
