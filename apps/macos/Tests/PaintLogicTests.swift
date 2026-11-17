// Tests for PaintLogic.swift: fill and stroke lists, hide/show, reorder, alpha, stroke sides, effects, corners.
// Run from apps/macos:
//   swiftc -parse-as-library PaintLogic.swift Tests/PaintLogicTests.swift -o /tmp/paint-tests && /tmp/paint-tests

import Foundation

@main
struct PaintLogicTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
        checks += 1
        if !ok { failures += 1; print("FAIL line \(line): \(what())") }
    }

    static func main() {
        lists(); hide(); order(); alpha(); stroke(); effects(); corners(); kinds(); stops(); images(); blends(); hexSteps(); clipboardScreen(); rowSelection()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    typealias P = PaintLogic
    static func json(_ v: Any?) -> String {
        guard let v else { return "nil" }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])
        return d.flatMap { String(data: $0, encoding: .utf8) } ?? "?"
    }

    static func lists() {
        check(P.list(nil).isEmpty, "no fill is an empty list")
        check(json(P.list("#FF0000")) == ##"["#FF0000"]"##, "a string is a one-entry list")
        check(P.list(["#A", "#B"]).count == 2, "a list stays")
        check(P.value([]) == nil, "empty removes the key")
        check(json(P.value(["#FF0000"])) == "#FF0000", "a lone colour writes as a string")
        let two = P.added(["#FF0000"])
        check(json(two) == ##"["#FF0000","#D9D9D9"]"##, "+ adds on top (the end of the file list)")
        check(json(P.removed(two, row: 0)) == ##"["#FF0000"]"##, "row 0 is the top fill")
        check(json(P.removed(two, row: 1)) == ##"["#D9D9D9"]"##, "row 1 is the bottom fill")
        check(P.color(["type": "color", "color": "#123456"]) == "#123456", "colour fill object")
        check(P.color(["type": "gradient"]) == nil, "a gradient has no single colour")
        check(json(P.withColor(["type": "color", "color": "#000000", "enabled": false], "#FFFFFF")) == ##"{"color":"#FFFFFF","enabled":false,"type":"color"}"##, "colour keeps the rest")
        check(P.color(["thickness": 2, "fill": "#000000"]) == "#000000", "a stroke object's fill")
    }

    static func hide() {
        let off = P.withEnabled("#FF0000", false)
        check(json(off) == ##"{"color":"#FF0000","enabled":false,"type":"color"}"##, "hiding a string makes an object")
        check(!P.enabled(off) && P.enabled("#FF0000"), "enabled reads it")
        check(json(P.withEnabled(off, true)) == "#FF0000", "showing it again gives the string back")
        let g: [String: Any] = ["type": "gradient", "enabled": false]
        check(json(P.withEnabled(g, true)) == ##"{"type":"gradient"}"##, "a gradient keeps its object")
    }

    static func order() {
        let l: [Any] = ["#1", "#2", "#3"] // panel rows: #3, #2, #1
        check(json(P.move(l, fromRow: 0, toRow: 2)) == ##"["#3","#1","#2"]"##, "top to bottom")
        check(json(P.move(l, fromRow: 2, toRow: 0)) == ##"["#2","#3","#1"]"##, "bottom to top")
        check(json(P.move(l, fromRow: 1, toRow: 1)) == ##"["#1","#2","#3"]"##, "no move")
        check(json(P.move(l, fromRow: 5, toRow: 0)) == ##"["#1","#2","#3"]"##, "out of range")
    }

    static func alpha() {
        check(P.alphaPercent("#FF0000") == 100, "opaque")
        check(P.alphaPercent("#FF000080") == 50, "50%")
        check(P.alphaPercent("#F008") == 53, "short form")
        check(P.alphaPercent("$brand") == nil, "token")
        check(P.withAlpha("#ff0000", percent: 50) == "#FF000080", "set 50%")
        check(P.withAlpha("#FF000080", percent: 100) == "#FF0000", "100% drops alpha")
        check(P.withAlpha("#F00", percent: 0) == "#FF000000", "short form expands")
        check(P.withAlpha("$x", percent: 50) == nil, "token has no alpha here")
        check(P.shorthandHex("F") == "#FFFFFF" && P.shorthandHex("ab") == "#ABABAB", "hex shorthands")
        check(P.shorthandHex("FFF") == nil && P.shorthandHex("G") == nil, "only one or two hex digits")
    }

    static func stroke() {
        check(P.sidesMode(2) == .all && P.weight(2) == 2 && P.weight(nil) == 1, "uniform")
        let top = P.strokeWidth(for: .top, current: 3)
        check(json(top) == ##"{"bottom":0,"left":0,"right":0,"top":3}"##, "top only keeps the weight")
        check(P.sidesMode(top) == .top, "reads back as top")
        check(json(P.strokeWidth(for: .all, current: top)) == "3", "back to all")
        check(json(P.strokeWidth(weight: 5, current: top)) == ##"{"bottom":0,"left":0,"right":0,"top":5}"##, "new weight on the stroked sides")
        let custom = P.strokeWidth(side: 1, value: 4, current: 2)
        check(json(custom) == ##"{"bottom":2,"left":2,"right":4,"top":2}"##, "one side")
        check(P.sidesMode(custom) == .custom, "custom")
        check(P.sidesMode(["top": 1, "right": 1, "bottom": 1, "left": 1]) == .all, "equal sides are all")
    }

    static func effects() {
        let d = P.newEffect(.dropShadow)
        check(P.kind(d) == .dropShadow && P.kind(P.newEffect(.innerShadow)) == .innerShadow, "kinds")
        check(P.kind(P.newEffect(.layerBlur)) == .layerBlur && P.kind(P.newEffect(.backgroundBlur)) == .backgroundBlur, "blurs")
        check(P.kind(["type": "shadow"]) == .dropShadow, "no shadowType is a drop shadow (engine default)")
        check(P.effects(["type": "blur", "radius": 2]).count == 1, "one object")
        check(P.effectValue([]) == nil, "none removes")
        check(P.effectValue([d]) is [String: Any], "one writes as an object")
        check(P.effectValue([d, d]) is [Any], "two as a list")
        var s = P.withOffset(d, y: 10)
        check(P.offset(s).x == 0 && P.offset(s).y == 10, "offset")
        s["blur"] = 12
        let inner = P.withKind(s, .innerShadow)
        check(P.kind(inner) == .innerShadow && P.num(inner["blur"]) == 12, "shadow to shadow keeps the fields")
        let blur = P.withKind(["type": "blur", "radius": 9, "enabled": false], .backgroundBlur)
        check(P.kind(blur) == .backgroundBlur && P.num(blur["radius"]) == 9 && blur["enabled"] as? Bool == false, "blur to blur keeps radius and hidden")
        check(P.kind(P.withKind(s, .layerBlur)) == .layerBlur, "shadow to blur")
    }

    static func corners() {
        check(P.corners(8) == [8, 8, 8, 8] && P.corners(nil) == [0, 0, 0, 0], "uniform")
        check(P.corners([4, 8, 0, 0]) == [4, 8, 0, 0], "four")
        check(P.corners([4, 8]) == [4, 8, 4, 8], "CSS two")
        check(P.corners("$r") == nil && P.corners([4, "$r", 0, 0]) == nil, "tokens")
        check(json(P.cornerRadius(corner: 1, value: 12, current: [4, 8, 0, 0])) == "[4,12,0,0]", "one corner")
        check(json(P.cornerRadius(corner: 0, value: 6, current: 6.0)) == "6", "equal collapses")
        check(json(P.cornerRadius(corner: 2, value: 3, current: 6)) == "[6,6,3,6]", "from a number")
    }

    static func kinds() {
        check(P.paintKind("#FF0000") == .solid, "a string is solid")
        check(P.paintKind(["type": "gradient", "gradientType": "radial"]) == .radial, "radial")
        check(P.paintKind(["type": "gradient"]) == .linear, "linear by default")
        check(P.paintKind(["type": "image", "url": "a.png"]) == .image && P.paintKind(["type": "shader"]) == .shader, "image, shader")
        // Solid to gradient: the colour to itself transparent, top to bottom.
        let g = P.converted("#FF0000", to: .linear)!
        check(json(g) == ##"{"colors":[{"color":"#FF0000","position":0},{"color":"#FF000000","position":1}],"gradientType":"linear","rotation":180,"type":"gradient"}"##, json(g))
        // Gradient to radial keeps stops and rotation; back to solid gives the first stop.
        let r = P.converted(["type": "gradient", "gradientType": "linear", "rotation": 45, "colors": [["color": "#00FF00", "position": 0], ["color": "#0000FF", "position": 1]]], to: .radial)!
        check(P.paintKind(r) == .radial && P.gradientStops(r).count == 2 && P.num((r as! [String: Any])["rotation"]) == 45, json(r))
        check(json(P.converted(r, to: .solid)) == "#00FF00", "to solid: the first stop")
        // Hidden and blend survive a switch.
        let hidden = P.converted(["type": "color", "color": "#123456", "enabled": false, "blendMode": "multiply"], to: .linear) as! [String: Any]
        check(hidden["enabled"] as? Bool == false && hidden["blendMode"] as? String == "multiply", "hidden and blend kept")
        check(P.converted("#FF0000", to: .image) == nil, "image needs a file")
        check(json(P.newPaint(.image, image: "media/a.png")) == ##"{"mode":"fill","type":"image","url":"media\/a.png"}"##, json(P.newPaint(.image, image: "media/a.png")))
        check(json(P.newPaint(.shader, shader: "mesh-gradient")) == ##"{"preset":"Default","shader":"mesh-gradient","type":"shader"}"##, "shader")
        check(json(P.newPaint(.solid)) == "#D9D9D9", "solid")
    }

    static func stops() {
        let s: [P.Stop] = [("#000000", 0), ("#FFFFFF", 1)]
        check(P.colorAt(s, 0.5) == "#808080", P.colorAt(s, 0.5))
        let (added, i) = P.addingStop(s, at: 0.25)
        check(added.count == 3 && i == 2 && added[2].color == "#404040" && added[2].position == 0.25, "added at 25%")
        check(P.removingStop(added, 2).count == 2, "remove")
        check(P.removingStop(s, 0).count == 2, "never fewer than two")
        check(P.flipped(s).map(\.position) == [1, 0], "flip")
        check(P.colorAt([("#FF000000", 0), ("#FF0000", 1)], 0.5) == "#FF000080", P.colorAt([("#FF000000", 0), ("#FF0000", 1)], 0.5))
        let g = P.withStops(["type": "gradient", "colors": []], [("#ABCDEF", 0.33333)])
        check(P.gradientStops(g).first?.position == 0.333 && P.gradientStops(g).first?.color == "#ABCDEF", json(g))
    }

    static func images() {
        let img: [String: Any] = ["type": "image", "url": "a.png", "mode": "fill"]
        check(P.imageMode(img) == .fill && P.imageMode(["type": "image", "mode": "contain"]) == .fit, "modes")
        // 200 x 100 image in a 100 x 100 box: Fill shows its middle half, as Crop that is x -0.5, width 2.
        let c = P.coverCrop(w: 100, h: 100, iw: 200, ih: 100)
        check(c["x"] == -0.5 && c["width"] == 2 && c["y"] == 0 && c["height"] == 1, "\(c)")
        let crop = P.withImageMode(img, .crop, box: (100, 100), image: (200, 100)) as! [String: Any]
        check(crop["mode"] as? String == "crop" && (crop["crop"] as? [String: Double])?["x"] == -0.5, json(crop))
        let tile = P.withImageMode(img, .tile) as! [String: Any]
        check(P.num(tile["scale"]) == 1, "tile scale 1")
        var r: Any = img
        for want in [90, 180, 270] { r = P.rotatedImage(r); check(P.num((r as! [String: Any])["rotation"]) == Double(want), "rotate \(want)") }
        r = P.rotatedImage(r)
        check((r as! [String: Any])["rotation"] == nil, "a full turn drops the key")
        let a = P.withAdjustment(img, "exposure", percent: 40)
        check(P.adjustment(a, "exposure") == 40 && P.adjustment(a, "contrast") == 0, "adjust")
        check((P.withAdjustment(a, "exposure", percent: 0) as! [String: Any])["adjust"] == nil, "all zero drops adjust")
    }

    static func blends() {
        check(json(P.withBlend("#FF0000", "multiply")) == ##"{"blendMode":"multiply","color":"#FF0000","type":"color"}"##, "a colour string grows an object")
        check(json(P.withBlend(["type": "color", "color": "#FF0000", "blendMode": "multiply"], "normal")) == "#FF0000", "normal collapses back")
        check(P.blendTitle("colorDodge") == "Color dodge" && P.blendTitle(nil) == "Normal", "titles")
        check(P.paintOpacity(["type": "gradient", "opacity": 0.5]) == 50 && P.paintOpacity(["type": "image"]) == 100, "opacity")
        check((P.withPaintOpacity(["type": "image", "opacity": 0.5], percent: 100) as! [String: Any])["opacity"] == nil, "100% drops it")
        check(json(P.pasting("#00FF00", into: ["#FF0000", "#0000FF"], row: 0)) == ##"["#FF0000","#00FF00"]"##, "paste onto the top row")
        check(json(P.pasting("#00FF00", into: ["#FF0000"], row: nil)) == ##"["#FF0000","#00FF00"]"##, "paste on top")
    }

    static func hexSteps() {
        check(P.lighter("#808080", by: 0.1) == "#9A9A9A", P.lighter("#808080", by: 0.1) ?? "nil")
        check(P.lighter("#FF0000", by: -0.1) == "#CC0000", P.lighter("#FF0000", by: -0.1) ?? "nil")
        check(P.lighter("#FFFFFF", by: 0.1) == "#FFFFFF", "clamped")
        check(P.lighter("#FF000080", by: 0.1) == "#FF333380", P.lighter("#FF000080", by: 0.1) ?? "nil")
        check(P.lighter("$brand", by: 0.1) == nil, "tokens")
    }

    // Codex review c1 (docs/evidence/review-fixes.md): Paste Fill took any app's cc.getcanvas.paint JSON, so an
    // image url like ../../.ssh/id_rsa went into the file and Save As copied the key into the package.
    static func clipboardScreen() {
        let key = Data(repeating: 7, count: 32)
        let evil: [String: Any] = ["type": "image", "url": "../../.ssh/id_rsa", "mode": "fill"]
        // Another app's paint (no seal): every local file reference goes; a colour or a web image stays.
        let forged = P.clipboardText(evil, key: nil)
        let r = P.readClipboard(forged, key: key)
        check(r.value == nil && r.dropped == 1, "a forged image paint is dropped: \(json(r.value)) \(r.dropped)")
        for url in ["/Users/x/passport.png", "file:///etc/passwd", "media/a.png", "~/.ssh/id_rsa"] {
            let o = P.readClipboard(P.clipboardText(["type": "image", "url": url], key: nil), key: key)
            check(o.value == nil && o.dropped == 1, "unsealed \(url) dropped")
        }
        let web = P.readClipboard(P.clipboardText(["type": "image", "url": "https://example.com/a.png"], key: nil), key: key)
        check(web.dropped == 0 && (web.value as? [String: Any])?["url"] as? String == "https://example.com/a.png", "a web image is no local file")
        check(P.readClipboard(P.clipboardText("#FF0000", key: nil), key: key).value as? String == "#FF0000", "a colour pastes")
        // Legacy {"v": ...} from an older build: unsealed, screened the same way.
        let legacy = P.readClipboard("{\"v\":{\"type\":\"image\",\"url\":\"../x.png\"}}", key: key)
        check(legacy.value == nil && legacy.dropped == 1, "legacy unsealed dropped")
        // Canvas's own copy (sealed with this run's key) keeps its image.
        let own = P.readClipboard(P.clipboardText(["type": "image", "url": "media/a.png"], key: key), key: key)
        check(own.dropped == 0 && (own.value as? [String: Any])?["url"] as? String == "media/a.png", "a sealed copy pastes as it is")
        // A sealed copy changed afterwards, or sealed by another run (another key), counts as another app's.
        let other = P.readClipboard(P.clipboardText(evil, key: Data(repeating: 9, count: 32)), key: key)
        check(other.value == nil && other.dropped == 1, "another key: unsealed")
        let tampered = P.clipboardText(["type": "image", "url": "media/a.png"], key: key).replacingOccurrences(of: "media/a.png", with: "../../.ssh/id_rsa")
        let t = P.readClipboard(tampered, key: key)
        check(t.value == nil, "tampered: dropped (\(tampered))")
        // Inside lists and nested objects too (an effect, a gradient list).
        let nested = P.readClipboard(P.clipboardText(["#000000", ["type": "image", "url": "../a.png"]] as [Any], key: nil), key: key)
        check(json(nested.value) == "[\"#000000\"]" && nested.dropped == 1, json(nested.value))
    }

    // A selected paint row: Cmd+C copies that row's paint, Cmd+V replaces it (or adds on top with no row),
    // an image on the clipboard replaces an image fill's picture and keeps the rest.
    static func rowSelection() {
        let img: [String: Any] = ["type": "image", "url": "media/a.png", "mode": "crop", "crop": ["x": 0.1, "y": 0, "width": 2, "height": 1], "adjust": ["exposure": 0.4], "rotation": 90, "opacity": 0.5]
        let swapped = P.withImageURL(img, url: "media/b.png") as! [String: Any]
        var want = img; want["url"] = "media/b.png"
        check(json(swapped) == json(want), "only the url changes: \(json(swapped))")
        let fromColor = P.withImageURL("#FF0000", url: "media/b.png") as? [String: Any]
        check(fromColor?["type"] as? String == "image" && fromColor?["url"] as? String == "media/b.png" && fromColor?["mode"] as? String == "fill", "a colour becomes an image paint: \(json(fromColor))")
        // Row 0 is the top paint (the end of the file list).
        let l: [Any] = ["#FF0000", img]
        let r0 = P.imagePasted(url: "media/b.png", into: l, row: 0)
        check(r0.count == 2 && json(r0[0]) == "#FF0000" && json(r0[1]) == json(want), "the selected image row keeps its mode, crop, adjust: \(json(r0))")
        let r1 = P.imagePasted(url: "media/b.png", into: l, row: 1)
        check(r1.count == 2 && (r1[0] as? [String: Any])?["url"] as? String == "media/b.png" && (r1[0] as? [String: Any])?["mode"] as? String == "fill" && json(r1[1]) == json(img), "a colour row becomes an image fill: \(json(r1))")
        let rn = P.imagePasted(url: "media/b.png", into: ["#FF0000"], row: nil)
        check(rn.count == 2 && (rn[1] as? [String: Any])?["type"] as? String == "image", "no row: on top")
        // Which clipboard content a Cmd+V on a row takes.
        check(P.rowPasteSource(key: "fill", paint: true, effect: false, image: true) == .paint, "a paint before a picture")
        check(P.rowPasteSource(key: "fill", paint: false, effect: false, image: true) == .image, "a picture on a fill row")
        check(P.rowPasteSource(key: "stroke", paint: false, effect: false, image: true) == nil, "strokes take no picture")
        check(P.rowPasteSource(key: "stroke", paint: true, effect: true, image: false) == .paint, "a stroke row takes a paint")
        check(P.rowPasteSource(key: "effect", paint: false, effect: true, image: false) == .effect, "an effect row takes an effect")
        check(P.rowPasteSource(key: "effect", paint: true, effect: false, image: true) == nil, "an effect row takes no paint")
        check(P.rowPasteSource(key: "fill", paint: false, effect: true, image: false) == nil, "a fill row takes no effect")
        // The paint a row shows, for Cmd+C.
        check(json(P.rowValue(["#A", "#B"], row: 0)) == "#B" && json(P.rowValue(["#A", "#B"], row: 1)) == "#A", "row to paint")
        check(P.rowValue(["#A"], row: 3) == nil && P.rowValue([], row: 0) == nil, "a row that is gone")
        // Cmd+V on the canvas with only a copied paint on the clipboard: it goes on top of the list it came from.
        check(P.copiedList("stroke") == "stroke" && P.copiedList("effect") == "effect" && P.copiedList(nil) == "fill" && P.copiedList("x") == "fill", "the list a copied paint goes back to")
    }

}
