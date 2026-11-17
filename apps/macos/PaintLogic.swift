// Fills, strokes, effects and corner radii in the properties panel, the pure half: how file values map to
// the panel's lists and back. A paint (`fill`, `stroke`) is a colour string, a fill object or a list of them; the
// engine paints a list in order, so the last entry is on top and the panel lists them top first.
// A hidden paint or effect is an object with `enabled: false` (the engine skips it). `strokeWidth` is a number
// or {top, right, bottom, left}; `effect` is one object or a list; `cornerRadius` a number or four numbers
// (top left, top right, bottom right, bottom left). InspectorPaint.swift draws the controls;
// Tests/PaintLogicTests.swift checks this file on its own.

import CryptoKit
import Foundation

enum PaintLogic {
    static func num(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    }

    // MARK: paint lists

    /// Any paint value as a list, bottom first (file order).
    static func list(_ raw: Any?) -> [Any] {
        switch raw {
        case nil: return []
        case let l as [Any]: return l
        default: return [raw!]
        }
    }

    /// What to write for a list: nothing (remove the key) when empty, a lone visible colour string as itself (the
    /// form the file had), anything else as the list.
    static func value(_ l: [Any]) -> Any? {
        if l.isEmpty { return nil }
        if l.count == 1, l[0] is String { return l[0] }
        return l
    }

    /// The colour of a paint entry: a string, or a colour fill object's `color` (a stroke object's `fill`).
    static func color(_ e: Any) -> String? {
        if let s = e as? String { return s }
        guard let d = e as? [String: Any] else { return nil }
        if (d["type"] as? String ?? "color") == "color", let c = d["color"] as? String { return c }
        return d["fill"] as? String
    }

    static func withColor(_ e: Any, _ c: String) -> Any {
        guard var d = e as? [String: Any] else { return c }
        if d["color"] != nil || d["fill"] == nil { d["color"] = c } else { d["fill"] = c }
        return d
    }

    static func enabled(_ e: Any) -> Bool { (e as? [String: Any])?["enabled"] as? Bool != false }

    /// Hide or show an entry. A hidden colour string becomes a colour fill object, the only form that can say so.
    static func withEnabled(_ e: Any, _ on: Bool) -> Any {
        if var d = e as? [String: Any] {
            if on { d.removeValue(forKey: "enabled") } else { d["enabled"] = false }
            if on, d.count == 2, d["type"] as? String == "color", let c = d["color"] as? String { return c }
            return d
        }
        if let s = e as? String, !on { return ["type": "color", "color": s, "enabled": false] as [String: Any] }
        return e
    }

    /// Panel row `row` (top first) to its index in the file's list.
    static func fileIndex(row: Int, count: Int) -> Int { count - 1 - row }

    /// Moves the entry at panel row `from` to panel row `to` (both top first).
    static func move(_ l: [Any], fromRow: Int, toRow: Int) -> [Any] {
        let n = l.count
        guard fromRow != toRow, (0..<n).contains(fromRow), (0..<n).contains(toRow) else { return l }
        var rows = Array(l.reversed())
        let e = rows.remove(at: fromRow)
        rows.insert(e, at: toRow)
        return Array(rows.reversed())
    }

    /// "+": a new paint on top.
    static func added(_ l: [Any], _ c: String = "#D9D9D9") -> [Any] { l + [c] }

    static func removed(_ l: [Any], row: Int) -> [Any] {
        let i = fileIndex(row: row, count: l.count)
        guard l.indices.contains(i) else { return l }
        var out = l
        out.remove(at: i)
        return out
    }

    // MARK: colour alpha

    /// The opacity in percent a hex colour carries (#RRGGBBAA, #RGBA), 100 for opaque forms, nil for a token.
    static func alphaPercent(_ hex: String) -> Double? {
        guard hex.hasPrefix("#") else { return nil }
        let h = Array(hex.dropFirst())
        guard h.allSatisfy(\.isHexDigit) else { return nil }
        switch h.count {
        case 3, 6: return 100
        case 4: return (Double(Int(String([h[3], h[3]]), radix: 16) ?? 255) / 255 * 100).rounded()
        case 8: return (Double(Int(String(h[6...7]), radix: 16) ?? 255) / 255 * 100).rounded()
        default: return nil
        }
    }

    /// The colour with that opacity; 100% drops the alpha digits (#RRGGBB).
    static func withAlpha(_ hex: String, percent: Double) -> String? {
        guard hex.hasPrefix("#") else { return nil }
        var h = Array(hex.dropFirst())
        guard h.allSatisfy(\.isHexDigit) else { return nil }
        if h.count == 3 || h.count == 4 { h = h.prefix(3).flatMap { [$0, $0] } }
        guard h.count == 6 || h.count == 8 else { return nil }
        let rgb = String(h.prefix(6)).uppercased()
        let p = max(0, min(100, percent))
        if p >= 100 { return "#" + rgb }
        return "#" + rgb + String(format: "%02X", Int((p / 100 * 255).rounded()))
    }

    /// Hex shorthands: one digit is a grey ("F" is #FFFFFF), two digits repeat ("AB" is #ABABAB).
    static func shorthandHex(_ h: String) -> String? {
        guard h.count == 1 || h.count == 2, h.allSatisfy(\.isHexDigit) else { return nil }
        return "#" + String(repeating: h, count: 6 / h.count).uppercased()
    }

    // MARK: stroke

    enum Sides: String, CaseIterable { case all, top, bottom, left, right, custom }

    /// [top, right, bottom, left] for a sides object, nil for a uniform width.
    static func sides(_ raw: Any?) -> [Double]? {
        guard let d = raw as? [String: Any] else { return nil }
        return ["top", "right", "bottom", "left"].map { num(d[$0]) ?? 0 }
    }

    static func sidesMode(_ raw: Any?) -> Sides {
        guard let s = sides(raw) else { return .all }
        let on = s.map { $0 > 0 }
        if on == [true, false, false, false] { return .top }
        if on == [false, false, true, false] { return .bottom }
        if on == [false, false, false, true] { return .left }
        if on == [false, true, false, false] { return .right }
        if Set(s).count == 1 { return .all }
        return .custom
    }

    /// The width a uniform field shows: the number, or the widest side.
    static func weight(_ raw: Any?) -> Double {
        if let s = sides(raw) { return s.max() ?? 0 }
        return num(raw) ?? 1
    }

    /// The strokeWidth for a side choice, keeping the current weight.
    static func strokeWidth(for mode: Sides, current raw: Any?) -> Any {
        let w = weight(raw)
        func obj(_ t: Double, _ r: Double, _ b: Double, _ l: Double) -> [String: Any] { ["top": t, "right": r, "bottom": b, "left": l] }
        switch mode {
        case .all: return w
        case .top: return obj(w, 0, 0, 0)
        case .bottom: return obj(0, 0, w, 0)
        case .left: return obj(0, 0, 0, w)
        case .right: return obj(0, w, 0, 0)
        case .custom: let s = sides(raw) ?? [w, w, w, w]; return obj(s[0], s[1], s[2], s[3])
        }
    }

    /// A new weight typed into the uniform field: every side that has a stroke takes it.
    static func strokeWidth(weight w: Double, current raw: Any?) -> Any {
        guard let s = sides(raw) else { return w }
        let k = ["top", "right", "bottom", "left"]
        var d: [String: Any] = [:]
        for i in 0..<4 { d[k[i]] = s[i] > 0 ? w : 0 }
        return d
    }

    static func strokeWidth(side i: Int, value v: Double, current raw: Any?) -> Any {
        var s = sides(raw) ?? Array(repeating: weight(raw), count: 4)
        s[i] = max(0, v)
        return ["top": s[0], "right": s[1], "bottom": s[2], "left": s[3]] as [String: Any]
    }

    // MARK: effects

    enum EffectKind: String, CaseIterable { case dropShadow, innerShadow, layerBlur, backgroundBlur
        var title: String {
            switch self {
            case .dropShadow: "Drop shadow"
            case .innerShadow: "Inner shadow"
            case .layerBlur: "Layer blur"
            case .backgroundBlur: "Background blur"
            }
        }
    }

    static func effects(_ raw: Any?) -> [[String: Any]] { list(raw).compactMap { $0 as? [String: Any] } }

    /// One effect writes as an object (the form files use), several as a list, none removes the key.
    static func effectValue(_ l: [[String: Any]]) -> Any? {
        if l.isEmpty { return nil }
        return l.count == 1 ? l[0] as Any : l as Any
    }

    static func kind(_ e: [String: Any]) -> EffectKind? {
        switch e["type"] as? String {
        case "shadow": return e["shadowType"] as? String == "inner" ? .innerShadow : .dropShadow
        case "blur": return .layerBlur
        case "background_blur": return .backgroundBlur
        default: return nil
        }
    }

    /// Defaults for a new effect.
    static func newEffect(_ k: EffectKind) -> [String: Any] {
        switch k {
        case .dropShadow, .innerShadow:
            return ["type": "shadow", "shadowType": k == .innerShadow ? "inner" : "outer", "offset": ["x": 0, "y": 4] as [String: Any], "blur": 4, "spread": 0, "color": "#00000040"]
        case .layerBlur: return ["type": "blur", "radius": 4]
        case .backgroundBlur: return ["type": "background_blur", "radius": 4]
        }
    }

    /// Switch an effect's kind, keeping what carries over (shadow fields between shadows, radius between blurs).
    static func withKind(_ e: [String: Any], _ k: EffectKind) -> [String: Any] {
        guard kind(e) != k else { return e }
        var out = newEffect(k)
        let wasShadow = e["type"] as? String == "shadow"
        let isShadow = k == .dropShadow || k == .innerShadow
        if wasShadow && isShadow { out = e; out["shadowType"] = k == .innerShadow ? "inner" : "outer" }
        if !wasShadow && !isShadow, let r = e["radius"] { out["radius"] = r }
        if e["enabled"] as? Bool == false { out["enabled"] = false }
        return out
    }

    static func offset(_ e: [String: Any]) -> (x: Double, y: Double) {
        let o = e["offset"] as? [String: Any]
        return (num(o?["x"]) ?? 0, num(o?["y"]) ?? 0)
    }

    static func withOffset(_ e: [String: Any], x: Double? = nil, y: Double? = nil) -> [String: Any] {
        var out = e
        let o = offset(e)
        out["offset"] = ["x": x ?? o.x, "y": y ?? o.y] as [String: Any]
        return out
    }

    // MARK: corners

    /// The four radii [top left, top right, bottom right, bottom left] (CSS forms of 1 to 3 values expanded), nil
    /// when a corner is a token.
    static func corners(_ raw: Any?) -> [Double]? {
        if let v = num(raw) { return [v, v, v, v] }
        if raw == nil { return [0, 0, 0, 0] }
        guard let a = raw as? [Any] else { return nil }
        let x = a.map { num($0) }
        guard !x.isEmpty, x.allSatisfy({ $0 != nil }) else { return nil }
        let v = x.map { $0! }
        switch v.count {
        case 1: return [v[0], v[0], v[0], v[0]]
        case 2: return [v[0], v[1], v[0], v[1]]
        case 3: return [v[0], v[1], v[2], v[1]]
        default: return Array(v.prefix(4))
        }
    }

    /// One corner set to `v`; four equal radii collapse to one number.
    static func cornerRadius(corner i: Int, value v: Double, current raw: Any?) -> Any {
        var c = corners(raw) ?? [0, 0, 0, 0]
        c[i] = max(0, v)
        return Set(c).count == 1 ? c[0] : c
    }

    // MARK: paint types (solid, gradient, image, shader)

    enum PaintKind: String, CaseIterable {
        case solid, linear, radial, angular, image, shader
        var title: String {
            switch self {
            case .solid: "Solid"
            case .linear: "Linear"
            case .radial: "Radial"
            case .angular: "Angular"
            case .image: "Image"
            case .shader: "Shader"
            }
        }
        var isGradient: Bool { self == .linear || self == .radial || self == .angular }
    }

    static func paintKind(_ e: Any) -> PaintKind {
        if e is String { return .solid }
        guard let d = e as? [String: Any] else { return .solid }
        switch d["type"] as? String {
        case "gradient":
            switch d["gradientType"] as? String {
            case "radial": return .radial
            case "angular": return .angular
            default: return .linear
            }
        case "mesh_gradient": return .linear
        case "image": return .image
        case "shader": return .shader
        default: return .solid
        }
    }

    /// The colour a paint shows as one swatch: its colour, or a gradient's first stop.
    static func leadColor(_ e: Any) -> String? {
        if let c = color(e) { return c }
        return gradientStops(e).first?.color
    }

    /// Switch a paint to another type: a colour becomes a gradient from it to itself transparent, a
    /// gradient keeps its stops between linear, radial and angular and gives its first stop back as a colour.
    /// Image and shader need more than the paint knows (a file, a preset): `image` and `shader` say which.
    static func converted(_ e: Any, to k: PaintKind, image: String? = nil, shader: String? = nil) -> Any? {
        let old = e as? [String: Any] ?? [:]
        var keep: [String: Any] = [:]
        if old["enabled"] as? Bool == false { keep["enabled"] = false }
        if let b = old["blendMode"] { keep["blendMode"] = b }
        switch k {
        case .solid:
            let c = leadColor(e) ?? "#D9D9D9"
            if keep.isEmpty { return c }
            return keep.merging(["type": "color", "color": c]) { $1 }
        case .linear, .radial, .angular:
            var stops = gradientStops(e)
            if stops.isEmpty {
                let c = withAlpha(leadColor(e) ?? "#D9D9D9", percent: 100) ?? "#D9D9D9"
                stops = [(c, 0), (withAlpha(c, percent: 0) ?? c, 1)]
            }
            var g = keep.merging(["type": "gradient", "gradientType": k.rawValue, "colors": stopsValue(stops)]) { $1 }
            // File degrees, CSS rotated: 180 runs top to bottom (the default first gradient).
            g["rotation"] = old["type"] as? String == "gradient" ? (old["rotation"] ?? 180) : 180
            for key in ["opacity", "center", "size"] where old["type"] as? String == "gradient" { if let v = old[key] { g[key] = v } }
            return g
        case .image:
            guard let image else { return nil }
            return keep.merging(["type": "image", "url": image, "mode": "fill"]) { $1 }
        case .shader:
            guard let shader else { return nil }
            return keep.merging(["type": "shader", "shader": shader, "preset": "Default"]) { $1 }
        }
    }

    /// A new paint of that type for "+": on top of the list.
    static func newPaint(_ k: PaintKind, base: String = "#D9D9D9", image: String? = nil, shader: String? = nil) -> Any? {
        converted(base, to: k, image: image, shader: shader)
    }

    // MARK: gradient stops

    typealias Stop = (color: String, position: Double)

    static func gradientStops(_ e: Any) -> [Stop] {
        guard let d = e as? [String: Any], d["type"] as? String == "gradient" || d["type"] as? String == "mesh_gradient" else { return [] }
        if d["type"] as? String == "mesh_gradient" {
            let cs = d["colors"] as? [String] ?? []
            return cs.enumerated().map { ($0.element, cs.count > 1 ? Double($0.offset) / Double(cs.count - 1) : 0) }
        }
        return (d["colors"] as? [[String: Any]] ?? []).compactMap { s in
            guard let c = s["color"] as? String else { return nil }
            return (c, num(s["position"]) ?? 0)
        }
    }

    static func stopsValue(_ s: [Stop]) -> [[String: Any]] {
        s.map { ["color": $0.color, "position": (($0.position * 1000).rounded() / 1000)] as [String: Any] }
    }

    static func withStops(_ e: Any, _ s: [Stop]) -> Any {
        guard var d = e as? [String: Any] else { return e }
        if d["type"] as? String == "mesh_gradient" { d = ["type": "gradient", "gradientType": "linear", "rotation": 135] }
        d["colors"] = stopsValue(s)
        return d
    }

    /// The colour a gradient has at `t` (stops in any order), straight RGBA interpolation like CSS.
    static func colorAt(_ s: [Stop], _ t: Double) -> String {
        let sorted = s.sorted { $0.position < $1.position }
        guard let first = sorted.first, let last = sorted.last else { return "#D9D9D9" }
        if t <= first.position { return first.color }
        if t >= last.position { return last.color }
        for i in 1..<sorted.count where t <= sorted[i].position {
            let a = sorted[i - 1], b = sorted[i]
            let k = b.position > a.position ? (t - a.position) / (b.position - a.position) : 0
            guard let ca = rgba(a.color), let cb = rgba(b.color) else { return a.color }
            let mix = (0..<4).map { ca[$0] + (cb[$0] - ca[$0]) * k }
            return hex(mix)
        }
        return last.color
    }

    /// A stop added at `t` with the colour the gradient has there; answers the new list and the new stop's index.
    static func addingStop(_ s: [Stop], at t: Double) -> ([Stop], Int) {
        let p = min(1, max(0, t))
        var out = s
        out.append((colorAt(s, p), p))
        return (out, out.count - 1)
    }

    /// A gradient keeps at least two stops.
    static func removingStop(_ s: [Stop], _ i: Int) -> [Stop] {
        guard s.count > 2, s.indices.contains(i) else { return s }
        var out = s
        out.remove(at: i)
        return out
    }

    /// Flip: every stop to 1 - position.
    static func flipped(_ s: [Stop]) -> [Stop] { s.map { ($0.color, 1 - $0.position) } }

    static func rgba(_ hexString: String) -> [Double]? {
        guard hexString.hasPrefix("#") else { return nil }
        var h = Array(hexString.dropFirst())
        if h.count == 3 || h.count == 4 { h = h.flatMap { [$0, $0] } }
        guard h.count == 6 || h.count == 8, h.allSatisfy(\.isHexDigit) else { return nil }
        let v = stride(from: 0, to: h.count, by: 2).map { Double(Int(String(h[$0...$0 + 1]), radix: 16) ?? 0) / 255 }
        return v.count == 4 ? v : v + [1]
    }

    static func hex(_ c: [Double]) -> String {
        let b = c.map { Int((min(1, max(0, $0)) * 255).rounded()) }
        let rgb = String(format: "#%02X%02X%02X", b[0], b[1], b[2])
        return b.count > 3 && b[3] < 255 ? rgb + String(format: "%02X", b[3]) : rgb
    }

    // MARK: image fills

    enum ImageMode: String, CaseIterable {
        case fill, fit, crop, tile, stretch
        var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
    }

    static func imageMode(_ e: Any) -> ImageMode {
        switch (e as? [String: Any])?["mode"] as? String {
        case "fit", "contain": return .fit
        case "crop": return .crop
        case "tile": return .tile
        case "stretch": return .stretch
        default: return .fill
        }
    }

    /// Where Fill puts an image of `iw` x `ih` in a `w` x `h` box, as Crop's fractions of the box: switching to Crop
    /// starts from what was shown.
    static func coverCrop(w: Double, h: Double, iw: Double, ih: Double, rotation: Double = 0) -> [String: Double] {
        let odd = Int((rotation / 90).rounded()) % 2 != 0
        let (rw, rh) = odd ? (ih, iw) : (iw, ih)
        guard w > 0, h > 0, rw > 0, rh > 0 else { return ["x": 0, "y": 0, "width": 1, "height": 1] }
        let s = max(w / rw, h / rh)
        let (dw, dh) = (rw * s, rh * s)
        func r(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }
        return ["x": r((w - dw) / 2 / w), "y": r((h - dh) / 2 / h), "width": r(dw / w), "height": r(dh / h)]
    }

    static func withImageMode(_ e: Any, _ m: ImageMode, box: (Double, Double)? = nil, image: (Double, Double)? = nil) -> Any {
        guard var d = e as? [String: Any] else { return e }
        d["mode"] = m.rawValue
        if m == .crop, d["crop"] == nil {
            if let box, let image { d["crop"] = coverCrop(w: box.0, h: box.1, iw: image.0, ih: image.1, rotation: num(d["rotation"]) ?? 0) }
            else { d["crop"] = ["x": 0, "y": 0, "width": 1, "height": 1] }
        }
        if m == .tile, d["scale"] == nil { d["scale"] = 1 }
        return d
    }

    /// Rotate 90°: a quarter turn clockwise; a full turn drops the key.
    static func rotatedImage(_ e: Any) -> Any {
        guard var d = e as? [String: Any] else { return e }
        let r = (Int(((num(d["rotation"]) ?? 0) / 90).rounded()) + 1) % 4
        if r == 0 { d.removeValue(forKey: "rotation") } else { d["rotation"] = r * 90 }
        return d
    }

    static let adjustKeys = ["exposure", "contrast", "saturation", "temperature", "tint"]

    /// An adjustment in percent (-100...100).
    static func adjustment(_ e: Any, _ key: String) -> Double {
        ((num(((e as? [String: Any])?["adjust"] as? [String: Any])?[key]) ?? 0) * 100).rounded()
    }

    /// One adjustment set (percent); all zero drops `adjust`.
    static func withAdjustment(_ e: Any, _ key: String, percent: Double) -> Any {
        guard var d = e as? [String: Any] else { return e }
        var a = d["adjust"] as? [String: Any] ?? [:]
        let v = (min(100, max(-100, percent))).rounded() / 100
        if v == 0 { a.removeValue(forKey: key) } else { a[key] = v }
        if a.isEmpty { d.removeValue(forKey: "adjust") } else { d["adjust"] = a }
        return d
    }

    // MARK: blend modes and opacity

    /// The blend menu, in its groups (nil is a divider). The ids are the names stored in the file.
    static let blendModes: [(id: String, title: String)?] = [
        ("normal", "Normal"), nil,
        ("darken", "Darken"), ("multiply", "Multiply"), ("colorBurn", "Color burn"), nil,
        ("light", "Lighten"), ("screen", "Screen"), ("colorDodge", "Color dodge"), nil,
        ("overlay", "Overlay"), ("softLight", "Soft light"), ("hardLight", "Hard light"), nil,
        ("difference", "Difference"), ("exclusion", "Exclusion"), nil,
        ("hue", "Hue"), ("saturation", "Saturation"), ("color", "Color"), ("luminosity", "Luminosity"),
    ]

    static func blendTitle(_ id: String?) -> String {
        blendModes.compactMap { $0 }.first { $0.id == (id ?? "normal") }?.title ?? "Normal"
    }

    /// A paint's blend mode; a colour string becomes a colour fill object to say it. Normal drops the key.
    static func withBlend(_ e: Any, _ id: String) -> Any {
        var d: [String: Any]
        if let s = e as? String { d = ["type": "color", "color": s] } else if let o = e as? [String: Any] { d = o } else { return e }
        if id == "normal" { d.removeValue(forKey: "blendMode") } else { d["blendMode"] = id }
        if d.count == 2, d["type"] as? String == "color", let c = d["color"] as? String { return c }
        return d
    }

    /// A gradient's, image's or shader's own opacity in percent (a colour's is in its hex).
    static func paintOpacity(_ e: Any) -> Double { ((num((e as? [String: Any])?["opacity"]) ?? 1) * 100).rounded() }

    static func withPaintOpacity(_ e: Any, percent p: Double) -> Any {
        guard var d = e as? [String: Any] else { return e }
        let v = min(100, max(0, p))
        if v >= 100 { d.removeValue(forKey: "opacity") } else { d["opacity"] = (v * 10).rounded() / 1000 }
        return d
    }

    // MARK: hex lighter / darker

    /// Shift+Up / Shift+Down in a hex field: lightness up or down by `step` (0...1) in HSL, alpha kept.
    static func lighter(_ hexString: String, by step: Double) -> String? {
        guard let c = rgba(hexString) else { return nil }
        let (r, g, b) = (c[0], c[1], c[2])
        let mx = max(r, g, b), mn = min(r, g, b)
        var l = (mx + mn) / 2
        let d = mx - mn
        var h = 0.0, s = 0.0
        if d > 0 {
            s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
            if mx == r { h = (g - b) / d + (g < b ? 6 : 0) } else if mx == g { h = (b - r) / d + 2 } else { h = (r - g) / d + 4 }
            h /= 6
        }
        l = min(1, max(0, l + step))
        func f(_ t0: Double, _ p: Double, _ q: Double) -> Double {
            var t = t0
            if t < 0 { t += 1 }
            if t > 1 { t -= 1 }
            if t < 1.0 / 6 { return p + (q - p) * 6 * t }
            if t < 0.5 { return q }
            if t < 2.0 / 3 { return p + (q - p) * (2.0 / 3 - t) * 6 }
            return p
        }
        let out: [Double]
        if s == 0 { out = [l, l, l] } else {
            let q = l < 0.5 ? l * (1 + s) : l + s - l * s
            let p = 2 * l - q
            out = [f(h + 1.0 / 3, p, q), f(h, p, q), f(h - 1.0 / 3, p, q)]
        }
        return hex(out + [c[3]])
    }

    // MARK: one paint on the clipboard (select a fill row, Cmd+C, Cmd+V on another layer's row)

    /// Pasting a copied paint onto a list: it replaces the row's paint (`row` set) or goes on top.
    static func pasting(_ p: Any, into l: [Any], row: Int?) -> [Any] {
        guard let row else { return l + [p] }
        let i = fileIndex(row: row, count: l.count)
        guard l.indices.contains(i) else { return l + [p] }
        var out = l
        out[i] = p
        return out
    }

    // A selected paint row (click the area left of the swatch). Cmd+C copies its paint, Cmd+V replaces it;
    // with no row selected a copied paint goes on top of the list it came from. A picture on the clipboard replaces
    // an image fill's picture and keeps its mode, crop, rotation, adjustments and opacity.

    /// What a Cmd+V on a selected row of `key` (fill, stroke, effect) takes from the clipboard.
    enum RowPaste: Equatable { case paint, effect, image }
    static func rowPasteSource(key: String, paint: Bool, effect: Bool, image: Bool) -> RowPaste? {
        switch key {
        case "effect": return effect ? .effect : nil
        case "fill": return paint ? .paint : image ? .image : nil
        default: return paint ? .paint : nil
        }
    }

    /// The paint a row shows (row 0 is the top one), nil when the row is gone.
    static func rowValue(_ l: [Any], row: Int) -> Any? {
        let i = fileIndex(row: row, count: l.count)
        return l.indices.contains(i) ? l[i] : nil
    }

    /// An image paint with a new picture: the url only; anything else becomes a plain image fill.
    static func withImageURL(_ p: Any, url: String) -> Any {
        guard var d = p as? [String: Any], d["type"] as? String == "image" else { return ["type": "image", "url": url, "mode": "fill"] }
        d["url"] = url
        return d
    }

    /// A pasted picture: into the selected row (an image keeps its settings), or on top with no row.
    static func imagePasted(url: String, into l: [Any], row: Int?) -> [Any] {
        guard let row, let cur = rowValue(l, row: row) else { return l + [withImageURL("", url: url)] }
        return pasting(withImageURL(cur, url: url), into: l, row: row)
    }

    /// The list a copied paint goes back to on a Cmd+V with no row selected (Copy Fill on a stroke row says stroke).
    static func copiedList(_ s: String?) -> String { s == "stroke" || s == "effect" ? s! : "fill" }

    // Any app on the Mac can write Canvas's paint type, and an image paint names a file: pasted, Save As would copy
    // that file into the package. So Copy Fill seals what it writes (HMAC-SHA256 under a key this run of the app
    // made), and Paste Fill keeps the file references of a sealed paint only. Anything else (another app's, an older
    // build's, one changed after Canvas wrote it) pastes without them, the way the server screens pasted layers
    // (src/structure.ts screenPayload).

    /// What Copy Fill writes under cc.getcanvas.paint: {"j": the paint's JSON, "sig": its seal under `key`}.
    static func clipboardText(_ p: Any, key: Data?) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: p, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes]),
              let j = String(data: d, encoding: .utf8) else { return "" }
        var o: [String: Any] = ["j": j]
        if let key { o["sig"] = seal(j, key: key) }
        let out = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes])).flatMap { String(data: $0, encoding: .utf8) }
        return out ?? ""
    }

    /// The paint on the clipboard, and how many file references it lost (another app's paint: every one).
    static func readClipboard(_ s: String, key: Data) -> (value: Any?, dropped: Int) {
        guard let o = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] else { return (nil, 0) }
        var v: Any?
        var sealed = false
        if let j = o["j"] as? String {
            v = try? JSONSerialization.jsonObject(with: Data(j.utf8), options: [.fragmentsAllowed])
            sealed = (o["sig"] as? String).map { $0 == seal(j, key: key) } ?? false
        } else {
            v = o["v"] // an older build's copy: never sealed
        }
        guard let v, !(v is NSNull) else { return (nil, 0) }
        if sealed { return (v, 0) }
        var dropped = 0
        return (withoutFiles(v, dropped: &dropped), dropped)
    }

    private static func seal(_ j: String, key: Data) -> String {
        HMAC<SHA256>.authenticationCode(for: Data(j.utf8), using: SymmetricKey(data: key)).map { String(format: "%02x", $0) }.joined()
    }

    /// A reference to a file on this Mac: a path (relative or not) or a file: URL; a web or data URL is not.
    static func isLocalFile(_ ref: String) -> Bool {
        if ref.isEmpty || ref.hasPrefix("//") { return false }
        if ref.lowercased().hasPrefix("file:") { return true }
        return ref.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) == nil
    }

    /// `v` without the file references the server copies (src/docpath.ts visitRefs): an image paint's url, an
    /// `image` field, a font's url. Each one dropped is counted; the paint or field holding it goes.
    static func withoutFiles(_ v: Any, fonts: Bool = false, dropped: inout Int) -> Any? {
        if let a = v as? [Any] {
            var out: [Any] = []
            for x in a { if let y = withoutFiles(x, fonts: fonts, dropped: &dropped) { out.append(y) } }
            return out
        }
        guard let o = v as? [String: Any] else { return v }
        if let u = o["url"] as? String, fonts || o["type"] as? String == "image", isLocalFile(u) { dropped += 1; return nil }
        var out: [String: Any] = [:]
        for (k, x) in o {
            if k == "image", let s = x as? String, isLocalFile(s) { dropped += 1; continue }
            if let y = withoutFiles(x, fonts: fonts || k == "fonts", dropped: &dropped) { out[k] = y }
        }
        return out
    }
}
