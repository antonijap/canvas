// Tests for ShellLogic.swift: page URLs, finding node without PATH, numbers that must not trap, the panel width
// against the window, tab relocation, load retries and the one Auto letter spacing control.
// Run from apps/macos:
//   swiftc -parse-as-library ShellLogic.swift Tests/ShellLogicTests.swift -o /tmp/shell-tests && /tmp/shell-tests

import Foundation

@main
struct ShellLogicTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
        checks += 1
        if !ok { failures += 1; print("FAIL line \(line): \(what())") }
    }

    static func main() {
        docURL(); nodeLocator(); numbers(); layout(); tabs(); retries(); autoTracking(); writeQueue(); fieldDraft(); fontWeights(); canvasInsets(); emptyPage(); serverCode(); tipPlacement(); contextMenu()
        numericExpr(); mixedKeys(); snapLimits(); secrets(); undoRouting(); throttle(); availableWeights(); overrideLabels(); pageDrag()
        fieldMath(); mixedEach(); menuSpec(); drawToolPalette(); panelMemory(); tabPool(); sidebarPeek(); repeatHint(); exportNaming(); pasteImage(); canvasLink(); toastActions(); firstRun(); exportSettings(); copyAsAndZoom()
        sidebarResize(); powerScrubAspect(); layoutGuides(); typeDetails(); fieldResets(); aboutInfo(); arrangeActions()
        updateManifest(); updateVerdict(); updateInstall(); updateHelper(); tabOrder(); fileTabs(); tabSizing(); tabPress(); tabRenameFocus(); recentlyClosedTabs()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    static func sidebarPeek() {
        var peek = SidebarPeek()
        peek.moved(x: 20, y: 300, top: 38, allowed: true)
        check(!peek.shown, "away from the edge stays hidden")
        peek.moved(x: 3, y: 10, top: 38, allowed: true)
        check(!peek.shown, "the title bar does not peek")
        peek.moved(x: 3, y: 300, top: 38, allowed: false)
        check(!peek.shown, "no peek while dragging, pinned or with the UI hidden")
        peek.moved(x: 8, y: 300, top: 38, allowed: true)
        check(peek.shown, "the edge strip peeks")
        peek.tick(inside: true, held: false, allowed: true, now: 1)
        peek.tick(inside: false, held: false, allowed: true, now: 2)
        peek.tick(inside: false, held: false, allowed: true, now: 2.2)
        check(peek.shown, "it waits after the pointer leaves")
        peek.tick(inside: true, held: false, allowed: true, now: 2.25)
        peek.tick(inside: false, held: false, allowed: true, now: 2.4)
        check(peek.shown, "coming back restarts the wait")
        peek.tick(inside: false, held: true, allowed: true, now: 5)
        peek.tick(inside: false, held: false, allowed: true, now: 5.1)
        check(peek.shown, "a menu or name field holds it")
        peek.tick(inside: false, held: false, allowed: true, now: 5.41)
        check(!peek.shown, "peeking goes back to hidden")
        peek.open()
        peek.tick(inside: true, held: true, allowed: false, now: 6)
        check(!peek.shown, "pinning ends the peek at once")
    }

    static func recentlyClosedTabs() {
        var history = RecentlyClosedTabs()
        history.record("Onboarding")
        history.record("Pricing")
        check(history.files == ["Pricing", "Onboarding"], "the latest closure comes first")
        history.record("Onboarding")
        check(history.files == ["Onboarding", "Pricing"], "closing the same file puts it first without a duplicate")
        history.remove("Onboarding")
        check(history.files == ["Pricing"], "reopened files leave the list")
        for n in 1...12 { history.record("File \(n)") }
        check(history.files == (3...12).reversed().map { "File \($0)" }, "only the ten latest closures are kept")
    }

    static func tabRenameFocus() {
        var session = TabRenameSession()
        check(!session.finish(attached: false, editing: false), "detaching a rename field must not commit its session")
        check(!session.finish(attached: true, editing: true), "restored field focus must not commit a queued blur")
        check(session.finish(attached: true, editing: false), "a live field commits on settled focus loss")
        check(!session.finish(attached: true, editing: false), "rename finishes only once")
        var retired = TabRenameSession()
        retired.retire()
        check(!retired.finish(attached: true, editing: false), "a replaced field must not finish the active rename")

        var rename = TabRename()
        let file = "/documents/tab-actions.canvas"
        let action = { rename.begin(file) }
        check(rename.file == nil, "presenting a menu does not start rename")
        action()
        check(rename.file == file, "menu action sets the rename overlay state without a mouse event or run loop")
        check(rename.draft == "tab-actions", "menu action prepares the selected tab name immediately")

        var focus = TabRenameFocus()
        var attempts = 0
        var selections = 0
        func attempt(attached: Bool, accepted: Bool) {
            focus.attempt(attached: attached, makeFirstResponder: {
                attempts += 1
                return accepted
            }, selectAll: { selections += 1 })
        }
        attempt(attached: false, accepted: true)
        check(attempts == 0 && selections == 0, "rename waits for window attachment")
        attempt(attached: true, accepted: false)
        check(attempts == 1 && selections == 0, "rejected focus must not select text")
        attempt(attached: true, accepted: true)
        check(attempts == 2 && selections == 1, "retry focus and select the full name")
        attempt(attached: true, accepted: true)
        check(attempts == 2 && selections == 1, "updates must not reset the selection")
        focus.detached()
        attempt(attached: true, accepted: true)
        check(attempts == 3 && selections == 2, "a reattached field must recover its editor after layout removes it")
    }

    static func tabPress() {
        var press = TabPress()
        check(press.down(button: 0, clicks: 1) == .none, "first press keeps its view alive")
        check(press.up() == .click, "single click switches immediately on release")
        check(press.down(button: 0, clicks: 2) == .none, "second press must not insert the editor under a held mouse")
        check(!press.drag(20), "second click cannot start reorder")
        check(press.up() == .rename, "rename after the second release, ready to select all")
        check(press.up() == .none, "a release is handled only once")
        _ = press.down(button: 0, clicks: 1)
        check(!press.drag(3), "small movement stays a click")
        check(press.drag(12), "single press drags past threshold")
        check(press.up() == .drop, "drag drops instead of opening or renaming")
        _ = press.down(button: 0, clicks: 1)
        press.cancel()
        check(press.up() == .none, "context menu cancels the press")
        check(press.down(button: 1, clicks: 2) == .none && press.up() == .none, "secondary double click never renames")
    }

    static func tabSizing() {
        let full: [CGFloat] = [240, 200, 120]
        check(TabSizing.widths(natural: full, available: 300, minimum: 96, maximum: 240) == full, "crowded tabs keep their natural widths")
        check(TabSizing.widths(natural: [600], available: 800, minimum: 96, maximum: 240) == [240], "an extremely long name caps at 240")
        check(TabSizing.widths(natural: [200, 600], available: 150, minimum: 96, maximum: 240) == [150, 150], "each tab fits within the available strip")
        check(TabSizing.widths(natural: [40, 200], available: 500, minimum: 96, maximum: 240) == [96, 200], "minimum leaves room for controls")
        check(TabSizing.widths(natural: [40, 200], available: 60, minimum: 96, maximum: 240) == [60, 60], "strip width takes priority over minimum")
        check(TabSizing.widths(natural: [], available: 100, minimum: 96, maximum: 240).isEmpty, "no tabs")
        check(TabSizing.widths(natural: [200], available: 0, minimum: 96, maximum: 240) == [0], "no strip room")
    }

    static func fileTabs() {
        let contextTitles = ContextMenuLayout.fileTab(cloud: true).flatMap { $0 }
            + ContextMenuLayout.fileTab(cloud: false).flatMap { $0 }
            + (ContextMenuLayout.node + ContextMenuLayout.canvas).flatMap { $0.map(\.title) }
        for title in contextTitles {
            check(!title.contains("...") && !title.contains("…"), "no ellipsis in context menu title: \(title)")
        }
        check(ContextMenuLayout.fileTab(cloud: false).flatMap { $0 } == ["Duplicate", "Rename", "Copy Link", "Reveal in Home", "Show in Finder", "Close", "Close Other Tabs"], "local tab menu order")
        check(ContextMenuLayout.fileTab(cloud: true) == [["Duplicate", "Rename", "Copy Link", "Reveal in Home", "Show in Finder", "Move to Cloud"], ["Close", "Close Other Tabs"]], "cloud action and separator")
        for name in ["", " ", ".hidden", "../Other", "a/b", "a\0b", ".canvas"] {
            check(TabRename.name(name) == nil, "invalid package name")
        }
        check(TabRename.name("  Board  ") == "Board.canvas", "trim and add extension")
        check(TabRename.name("Board.canvas") == "Board.canvas", "extension stays once")
        check(TabRename.name("Plan + #1") == "Plan + #1.canvas", "ordinary punctuation")
        check(TabOrder.canDrag(button: 0, clicks: 1, editing: false), "single left press can drag")
        check(!TabOrder.canDrag(button: 1, clicks: 1, editing: false), "right press never drags")
        check(!TabOrder.canDrag(button: 0, clicks: 2, editing: false), "double press never drags")
        check(!TabOrder.canDrag(button: 0, clicks: 1, editing: true), "rename never drags")
    }

    // Dragging file tabs into a new order: Home stays outside the list, a short move is a click.
    static func tabOrder() {
        typealias T = TabOrder
        let f = ["/a", "/b", "/c", "/d"]
        check(T.move(f, from: 0, to: 2) == ["/b", "/c", "/a", "/d"], "move right")
        check(T.move(f, from: 3, to: 0) == ["/d", "/a", "/b", "/c"], "move left to the very first file tab")
        check(T.move(f, from: 1, to: 1) == f, "same place")
        check(T.move(f, from: 1, to: -5) == ["/b", "/a", "/c", "/d"], "never before the first file (Home stays ahead)")
        check(T.move(f, from: 1, to: 99) == ["/a", "/c", "/d", "/b"], "never past the last")
        check(T.move(f, from: 9, to: 0) == f, "unknown index changes nothing")
        check(Set(T.move(f, from: 0, to: 3)) == Set(f), "no tab lost or doubled")

        check(!T.isDrag(0) && !T.isDrag(3.9) && !T.isDrag(-3.9), "under a few points is a click")
        check(T.isDrag(4) && T.isDrag(-12), "past the threshold is a drag")
        check(!T.isDrag(.nan), "NaN is no drag")

        let w: [CGFloat] = [100, 80, 120], gap: CGFloat = 2
        check(T.start(0, widths: w, gap: gap) == 0 && T.start(2, widths: w, gap: gap) == 184, "tab starts")
        check(T.target(from: 0, offset: 0, widths: w, gap: gap) == 0, "no move, no change")
        check(T.target(from: 0, offset: 30, widths: w, gap: gap) == 0, "not yet past the neighbour's middle")
        check(T.target(from: 0, offset: 60, widths: w, gap: gap) == 1, "past the middle of the next")
        check(T.target(from: 0, offset: 400, widths: w, gap: gap) == 2, "far right: last")
        check(T.target(from: 2, offset: -400, widths: w, gap: gap) == 0, "far left: first")
        check(T.target(from: 2, offset: -60, widths: w, gap: gap) == 1, "one left")
        check(T.target(from: 2, offset: -30, widths: w, gap: gap) == 2, "not yet past the neighbour on the left")
        let u: [CGFloat] = [200, 60, 60]
        check(T.target(from: 0, offset: T.clamp(999, index: 0, widths: u, gap: gap), widths: u, gap: gap) == 2, "a wide tab dragged to the far end reaches the last slot")
        check(T.target(from: 2, offset: T.clamp(-999, index: 2, widths: u, gap: gap), widths: u, gap: gap) == 0, "and the far start")
        check(T.slide(1, dragged: 0, target: 2, width: 100, gap: gap) == -102, "passed tabs slide back by the dragged width")
        check(T.slide(2, dragged: 0, target: 2, width: 100, gap: gap) == -102, "the target slot slides too")
        check(T.slide(2, dragged: 0, target: 1, width: 100, gap: gap) == 0, "tabs beyond the target stay")
        check(T.slide(0, dragged: 2, target: 0, width: 120, gap: gap) == 122, "dragging left pushes the others right")
        check(T.slide(1, dragged: 1, target: 1, width: 80, gap: gap) == 0, "the dragged tab itself is not slid")
        check(T.clamp(-50, index: 0, widths: w, gap: gap) == 0, "cannot drag left of the strip")
        check(T.clamp(900, index: 0, widths: w, gap: gap) == 204, "cannot drag right of the strip")
        check(T.clamp(30, index: 1, widths: w, gap: gap) == 30, "inside the strip it follows the pointer")

        typealias S = TabOrder
        check(S.step(f, current: "/b", homeShown: false, forward: true) == .some("/c"), "next tab")
        check(S.step(f, current: "/b", homeShown: false, forward: false) == .some("/a"), "previous tab")
        check(S.step(f, current: "/d", homeShown: false, forward: true) == .some(nil), "next after the last wraps to Home")
        check(S.step(f, current: "/a", homeShown: false, forward: false) == .some(nil), "previous before the first is Home")
        check(S.step(f, current: "/a", homeShown: true, forward: true) == .some("/a"), "from Home, next is the first file")
        check(S.step(f, current: "/c", homeShown: true, forward: false) == .some("/d"), "from Home, previous wraps to the last")
        check(S.step([], current: nil, homeShown: true, forward: true) == nil, "no files, no move")
        let moved = T.move(f, from: 0, to: 2)
        check(S.step(moved, current: "/b", homeShown: false, forward: true) == .some("/c") && S.step(moved, current: "/a", homeShown: false, forward: false) == .some("/c"), "stepping follows the new order")
        check(MenuSpec.window.compactMap { $0 }.contains { $0.command == "nextTab" && $0.key == "}" && $0.mods == [.command, .shift] }, "Window > Next Tab is Shift+Cmd+]")
        check(MenuSpec.window.compactMap { $0 }.contains { $0.command == "previousTab" && $0.key == "{" && $0.mods == [.command, .shift] }, "Window > Previous Tab is Shift+Cmd+[")
    }

    // Align, distribute and tidy up for several layers: the inspector's Arrange row and right-click > Align.
    static func arrangeActions() {
        typealias A = ArrangeActions
        check(A.align.map(\.op) == ["align-left", "align-hcenter", "align-right", "align-top", "align-vcenter", "align-bottom"], "six aligns in menu order")
        check(A.spread.map(\.op) == ["distribute-h", "distribute-v", "tidy"], "distribute both ways, then tidy up")
        // Every action is an Arrange menu item, so the row, the submenu and the menu bar run one op with one key.
        for a in A.all { check(MenuSpec.arrange.contains { $0?.command == a.op }, "\(a.op) is in the Arrange menu") }
        check(A.shortcut(A.align[0]) == "\u{2325}A", "Align left shows Option+A")
        check(A.shortcut(A.spread[0]) == "\u{2325}\u{21E7}H", "Distribute horizontal shows Option+Shift+H")
        check(A.shortcut(A.spread[2]) == "\u{2303}\u{2325}T", "Tidy up shows Control+Option+T")
        check(A.help(A.align[1]) == "Align horizontal centers  \u{2325}H", "the tooltip names the action and its key")
        // The row shows for two or more; an action needs enough layers the canvas may move.
        check(!A.shows(count: 1) && A.shows(count: 2), "the row needs two or more")
        let left = A.align[0], dist = A.spread[0], tidy = A.spread[2]
        check(A.enabled(left, count: 2, free: nil) && !A.enabled(dist, count: 2, free: nil) && A.enabled(dist, count: 3, free: nil), "align takes two, distribute three")
        check(A.enabled(tidy, count: 2, free: 2), "tidy up takes two")
        // Layers auto layout places do not count: all in one auto layout frame, nothing is on.
        check(!A.enabled(left, count: 4, free: 0) && !A.enabled(tidy, count: 4, free: 1), "placed layers do not move")
        check(A.enabled(left, count: 4, free: 2) && !A.enabled(dist, count: 4, free: 2), "two free of four: align yes, distribute no")
        check(A.blockedNote(count: 3, free: 0) == "Auto layout places these layers", "the row says why it is off")
        check(A.blockedNote(count: 3, free: 3) == nil && A.blockedNote(count: 3, free: nil) == nil, "nothing to say when they move")
    }

    // Canvas > About Canvas: the version with its commit, and when the build was made, in the reader's own format.
    static func aboutInfo() {
        check(AboutInfo.versionLine(version: "0.1.0", commit: "aede106") == "Version 0.1.0 (aede106)", "version and commit")
        check(AboutInfo.versionLine(version: "0.1.0", commit: nil) == "Version 0.1.0", "no commit, no brackets")
        check(AboutInfo.versionLine(version: "0.1.0", commit: "") == "Version 0.1.0", "an empty commit, no brackets")
        let us = Locale(identifier: "en_US"), utc = TimeZone(identifier: "UTC")!
        check(AboutInfo.builtLine("2026-11-17T14:46:00Z", locale: us, timeZone: utc) == "Nov 17, 2026 at 2:46\u{202F}PM"
              || AboutInfo.builtLine("2026-11-17T14:46:00Z", locale: us, timeZone: utc) == "Nov 17, 2026, 2:46\u{202F}PM"
              || AboutInfo.builtLine("2026-11-17T14:46:00Z", locale: us, timeZone: utc) == "Nov 17, 2026, 2:46 PM",
              "build date: \(AboutInfo.builtLine("2026-11-17T14:46:00Z", locale: us, timeZone: utc) ?? "nil")")
        check(AboutInfo.builtLine(nil) == nil && AboutInfo.builtLine("yesterday") == nil, "no date, no line")
    }

    // Typography's Type details: Letter case (the cases, Small caps only for fonts with smcp), and the features a
    // font's GSUB table lists.
    static func typeDetails() {
        check(LetterCase.options.map(\.title) == ["Original", "Uppercase", "Lowercase", "Title case", "Small caps"], "letter cases, in order")
        check(LetterCase.title(nil) == "Original" && LetterCase.title("upper") == "Uppercase" && LetterCase.title("small-caps") == "Small caps" && LetterCase.title("bogus") == "Original", "the menu's title")
        check(LetterCase.write("original") == nil && LetterCase.write("title") == "title", "Original takes the key off")
        // A GSUB table: version 1.0, script list at 10, feature list at 10: two features, liga and smcp.
        var g = Data([0, 1, 0, 0, 0, 10, 0, 10, 0, 0])
        g += Data([0, 2]) + Data("liga".utf8) + Data([0, 0]) + Data("smcp".utf8) + Data([0, 0])
        check(OpenTypeFeatures.gsub(g) == ["liga", "smcp"], "the feature tags of a GSUB table")
        check(OpenTypeFeatures.gsub(Data([0, 1])).isEmpty && OpenTypeFeatures.gsub(Data([0, 1, 0, 0, 0, 10, 0, 200, 0, 0])).isEmpty, "a short or broken table has none")
        check(OpenTypeFeatures.isSystem("SF Pro") && OpenTypeFeatures.isSystem("system-ui") && !OpenTypeFeatures.isSystem("Inter"), "the system font")
    }

    // View > Layout Guides on Control+G, and the frame metadata the inspector's Layout guide section writes.
    static func layoutGuides() {
        check(MenuSpec.view.contains { $0?.title == "Layout Guides" && $0?.key == "g" && $0?.mods == [.control] && $0?.pageKey == false }, "View > Layout Guides on Control+G, the menu's key")
        let grid = LayoutGuides.make("grid")
        check(grid["size"] as? Int == 10 && grid["color"] as? String == "#FF00001A", "a new guide is a 10 px grid, red at 10%")
        let m = LayoutGuides.metadata(["type": "canvas", "canvasGuides": [["axis": "x", "at": 4]]], [grid])
        check(LayoutGuides.list(m).count == 1 && m?["canvasGuides"] != nil, "saved next to the ruler guides")
        check(LayoutGuides.metadata(["type": "canvas", "canvasLayoutGuides": [grid]], []) == nil, "the last one removed leaves no metadata")
        let cols = LayoutGuides.withType(LayoutGuides.withVisible(grid, false), "columns")
        check(cols["count"] as? Int == 5 && cols["visible"] as? Bool == false && LayoutGuides.title(cols) == "5 columns", "type change keeps visibility")
        let left = LayoutGuides.withAlign(cols, "start")
        check(left["width"] != nil && left["offset"] != nil && left["margin"] == nil, "left columns take a width and an offset")
        check(LayoutGuides.withAlign(left, "center")["offset"] == nil && LayoutGuides.withAlign(left, "stretch")["width"] == nil, "centre has no offset, stretch no width")
        check(LayoutGuides.title(grid) == "Grid 10px" && LayoutGuides.aligns("rows").map(\.title) == ["Stretch", "Top", "Center", "Bottom"], "titles")
    }

    // Cmd+V of a screenshot pastes an image layer; Canvas's own copied layers still paste as layers.
    static func pasteImage() {
        let png = URL(fileURLWithPath: "/tmp/Shot.PNG"), doc = URL(fileURLWithPath: "/tmp/notes.txt")
        check(PasteImage.choose(string: "canvas-clipboard:v1:123", fileURLs: [], hasPNG: true, hasTIFF: true) == nil, "Canvas layers win over a picture")
        check(PasteImage.choose(string: nil, fileURLs: [], hasPNG: true, hasTIFF: true) == .png, "PNG before TIFF")
        check(PasteImage.choose(string: "https://x", fileURLs: [], hasPNG: false, hasTIFF: true) == .tiff, "TIFF from an app that only offers it")
        check(PasteImage.choose(string: nil, fileURLs: [doc, png], hasPNG: false, hasTIFF: true) == .file(png), "an image file, not the file icon")
        check(PasteImage.choose(string: nil, fileURLs: [doc], hasPNG: false, hasTIFF: true) == nil, "a copied text file is no picture")
        check(PasteImage.choose(string: "hello", fileURLs: [], hasPNG: false, hasTIFF: false) == nil, "plain text pastes as before")
        check(PasteImage.mime("JPG") == "image/jpeg" && PasteImage.mime("svg") == "image/svg+xml" && PasteImage.mime("png") == "image/png", "mime types")
    }

    // Codex round 3 e4: multi-selection writes went out independently, so an older scrub value could land last,
    // and Undo (afterWrites) did not wait for them. They now share the single-node queue.
    static func writeQueue() {
        typealias Q = WriteQueue<[String: Int]>
        let merge: (inout [String: Int], [String: Int]) -> Void = { a, b in for (k, v) in b { a[k] = v } }
        func vals(_ out: [(key: String, w: [String: Int])]) -> [[String: Int]] { out.map(\.w) }
        var q = Q()
        let ab = "f\u{1F}A\u{1E}B"
        let nAB: Set<String> = ["f\u{1F}A", "f\u{1F}B"]
        check(vals(q.add(ab, nodes: nAB, ["opacity": 10], merge: merge)) == [["opacity": 10]], "first write goes at once")
        check(!q.isIdle, "a write in flight: undo waits")
        check(q.add(ab, nodes: nAB, ["opacity": 20], merge: merge).isEmpty, "second waits for the first")
        check(q.add(ab, nodes: nAB, ["opacity": 30], merge: merge).isEmpty, "third merges into the waiting one")
        check(vals(q.add("f\u{1F}C", nodes: ["f\u{1F}C"], ["x": 1], merge: merge)) == [["x": 1]], "another node is independent")
        check(vals(q.answered(ab)) == [["opacity": 30]], "after the first answers, only the latest value goes")
        check(q.answered(ab).isEmpty, "nothing more for that key")
        check(!q.isIdle, "C still in flight")
        check(q.answered("f\u{1F}C").isEmpty && q.isIdle, "idle once everything answered")

        // Round 5 (Codex 3): A+B write in flight, A+B 40% queued, then A alone 80%. A's write must go last.
        var o = Q()
        _ = o.add(ab, nodes: nAB, ["opacity": 10], merge: merge)
        check(o.add(ab, nodes: nAB, ["opacity": 40], merge: merge).isEmpty, "A+B 40% waits")
        check(o.add("f\u{1F}A", nodes: ["f\u{1F}A"], ["opacity": 80], merge: merge).isEmpty, "A alone waits behind A+B")
        check(vals(o.answered(ab)) == [["opacity": 40]], "the older A+B write goes first")
        check(vals(o.answered(ab)) == [["opacity": 80]], "then A's newer value")
        check(o.answered("f\u{1F}A").isEmpty && o.isIdle, "drained")

        // A merge never jumps an overlapping write: A, then A+B, then A again stays three steps in order.
        var m = Q()
        _ = m.add("f\u{1F}Z", nodes: ["f\u{1F}A"], ["x": 0], merge: merge) // something on A in flight
        _ = m.add("f\u{1F}A", nodes: ["f\u{1F}A"], ["x": 1], merge: merge)
        _ = m.add(ab, nodes: nAB, ["x": 2], merge: merge)
        _ = m.add("f\u{1F}A", nodes: ["f\u{1F}A"], ["x": 3], merge: merge)
        check(vals(m.answered("f\u{1F}Z")) == [["x": 1]], "A 1 first")
        check(vals(m.answered("f\u{1F}A")) == [["x": 2]], "then A+B 2")
        check(vals(m.answered(ab)) == [["x": 3]], "then A 3, not merged into A 1")
    }

    // Round 5: Mixed fields refuse relative entries instead of writing them as absolute numbers.
    static func numericExpr() {
        check(NumericExpr.evaluate("12*2", current: nil) == 24, "plain arithmetic")
        check(NumericExpr.evaluate("+8", current: 10) == 18 && NumericExpr.evaluate("*2", current: 10) == 20 && NumericExpr.evaluate("/4", current: 10) == 2.5, "relative to the value")
        check(NumericExpr.evaluate("+8", current: nil) == nil, "+8 on Mixed is refused, not 8")
        check(NumericExpr.evaluate("*2", current: nil) == nil && NumericExpr.evaluate("/2", current: nil) == nil, "* and / on Mixed refused")
        check(NumericExpr.evaluate("-4", current: nil) == -4, "a negative number is not relative")
        check(NumericExpr.evaluate("50%", current: nil) == 50 && NumericExpr.evaluate("\u{2212}3px", current: nil) == -3, "units and true minus")
        check(NumericExpr.evaluate("1/0", current: nil) == nil && NumericExpr.evaluate("abc", current: 1) == nil, "junk refused")
        check(NumericExpr.clean(0.1 + 0.2) == 0.3 && NumericExpr.clamp(5, 0, 3) == 3, "clean and clamp")
    }

    // Round 5: which keys read "Mixed" for several layers.
    static func mixedKeys() {
        let nodes: [[String: Any]] = [["id": "a", "x": 1, "opacity": 0.5, "children": []], ["id": "b", "x": 2, "opacity": 0.5, "rotation": 15]]
        let shared: [String: Any] = ["opacity": 0.5, "name": "2 selected"]
        check(MixedKeys.of(nodes, shared: shared) == ["x", "rotation"], "differing and partly-set keys are mixed: \(MixedKeys.of(nodes, shared: shared))")
        check(MixedKeys.of([], shared: shared).isEmpty, "nothing read yet: nothing mixed")
    }

    // Round 5: the Big nudge field saved 0 and 5000.
    static func snapLimits() {
        check(SnapLimits.bigNudge(0) == 1 && SnapLimits.bigNudge(-3) == 1, "at least 1")
        check(SnapLimits.bigNudge(5000) == 1000 && SnapLimits.bigNudge(25) == 25, "at most 1000")
    }

    // Round 5: a multi-line secret was stored with its line breaks dropped.
    static func secrets() {
        check(SecretInput.clean("sk-123\n") == .ok("sk-123"), "a pasted trailing newline is dropped")
        check(SecretInput.clean("  tok  ") == .ok("tok"), "surrounding blanks dropped")
        check(SecretInput.clean("line1\nline2") == .multiline && SecretInput.clean("a\r\nb") == .multiline, "line breaks inside refused")
        check(SecretInput.clean("a\u{0}b") == .multiline, "NUL refused")
        check(SecretInput.clean(" \n ") == .empty, "blank is empty")
    }

    // Round 5: a focused field with nothing to undo swallowed Cmd+Z.
    static func undoRouting() {
        check(UndoRouting.fieldTakes(hasField: true, canStep: true), "field with typing undoes its typing")
        check(!UndoRouting.fieldTakes(hasField: true, canStep: false), "field with nothing to undo lets the document undo")
        check(!UndoRouting.fieldTakes(hasField: false, canStep: true), "no field: the document")
    }

    // Round 5: the Paper shader slider sent nothing until the drag paused.
    static func throttle() {
        var t = LeadTrailThrottle(interval: 0.05)
        check(t.offer(now: 10) == .sendNow, "first value goes at once")
        if case .schedule(let after) = t.offer(now: 10.01) { check(abs(after - 0.04) < 1e-9, "next one waits out the interval: \(after)") }
        else { check(false, "second value is scheduled") }
        check(t.offer(now: 10.02) == .wait && t.offer(now: 10.03) == .wait, "values meanwhile ride on the scheduled send")
        t.sent(now: 10.05)
        check(t.offer(now: 10.2) == .sendNow, "after a quiet interval, at once again")
        var u = LeadTrailThrottle(interval: 0.05)
        var sends = 0
        var fireAt: Double?
        for i in 0..<60 { // a 1 s drag at 60 Hz
            let now = Double(i) / 60
            if let f = fireAt, f <= now { sends += 1; u.sent(now: f); fireAt = nil } // the scheduled send fires
            switch u.offer(now: now) {
            case .sendNow: sends += 1
            case .schedule(let after): fireAt = now + after
            case .wait: break
            }
        }
        if fireAt != nil { sends += 1 } // the trailing value is never lost
        check(sends >= 15 && sends <= 21, "about 20 writes a second while dragging, not 0 and not 60: \(sends)")
    }

    // Round 5: the weight menu offered weights the family does not have.
    static func availableWeights() {
        check(FontWeights.css(appKit: 5) == 400 && FontWeights.css(appKit: 9) == 700 && FontWeights.css(appKit: 3) == 200 && FontWeights.css(appKit: 11) == 900, "AppKit weights")
        let rb = FontWeights.available(appKit: [5, 9], current: "400").map(\.name)
        check(rb == ["Regular", "Bold"], "Regular and Bold only: \(rb)")
        let withCurrent = FontWeights.available(appKit: [5, 9], current: NSNumber(value: 300)).map(\.value)
        check(withCurrent == [300, 400, 700], "the file's own weight stays listed: \(withCurrent)")
        check(FontWeights.available(appKit: [], current: nil).count == 9, "unknown family: the whole scale")
    }

    // Sweep S4: a text node with fontWeight "normal" showed the CSS keyword in the weight menu.
    static func fontWeights() {
        check(FontWeights.title("normal") == "Regular", "normal is Regular")
        check(FontWeights.title("bold") == "Bold", "bold is Bold")
        check(FontWeights.title("400") == "Regular" && FontWeights.title(NSNumber(value: 700)) == "Bold", "numbers by name")
        check(FontWeights.title("600") == "Semi Bold" && FontWeights.title("100") == "Thin" && FontWeights.title("900") == "Black", "the whole scale")
        check(FontWeights.title("semibold") == "Semi Bold" && FontWeights.title("Extra-Bold") == "Extra Bold", "style names are read too")
        check(FontWeights.title("450") == "450", "an off-scale number shows as itself")
        check(FontWeights.title(nil) == "Regular", "no weight is Regular")
        check(FontWeights.write(700, over: NSNumber(value: 400)) as? Int == 700, "a number stays a number")
        check(FontWeights.write(700, over: "normal") as? String == "700", "a keyword becomes the file's numeric string")
        check(FontWeights.write(300, over: "500") as? String == "300", "a numeric string stays a string")
        check(FontWeights.write(500, over: nil) as? String == "500", "nothing becomes a numeric string")
    }

    // Sweep S3: the fit must keep clear of the rail and panel, the inspector, the toolbar and the zoom pill.
    static func emptyPage() {
        check(EmptyPage.isEmpty(fileOpen: true, home: false, loaded: true, boards: 0, cards: 0), "a loaded page with nothing on it is empty")
        check(!EmptyPage.isEmpty(fileOpen: true, home: false, loaded: true, boards: 1, cards: 0), "one board: not empty")
        check(!EmptyPage.isEmpty(fileOpen: true, home: false, loaded: true, boards: 0, cards: 2), "cards only: not empty")
        check(!EmptyPage.isEmpty(fileOpen: true, home: false, loaded: false, boards: 0, cards: 0), "still opening: no hint yet")
        check(!EmptyPage.isEmpty(fileOpen: true, home: true, loaded: true, boards: 0, cards: 0), "Home shown: no hint")
        check(!EmptyPage.isEmpty(fileOpen: false, home: false, loaded: true, boards: 0, cards: 0), "no file: no hint")
        check(!EmptyPage.hint.contains("\u{2014}") && !EmptyPage.hint.contains("\u{00B7}"), "no em dash or middot in the hint")
    }

    // A server an older Canvas left running answers on the port: the app replaces it instead of running old code.
    static func serverCode() {
        typealias S = ServerCode
        let own = S.Health(version: "aaaaaaaaaaaa", root: "dddddddddddd")
        check(S.choice(answered: false, running: nil, own: own) == .start, "nothing answers: start ours")
        check(S.choice(answered: true, running: own, own: own) == .reuse, "our own code: reuse it")
        check(S.choice(answered: true, running: .init(version: "bbbbbbbbbbbb", root: own.root), own: own) == .replace, "our installation, other code (an update): replace")
        check(S.choice(answered: true, running: .init(version: own.version, root: "eeeeeeeeeeee"), own: own) == .otherCopy, "another copy's server, same code: never stopped")
        check(S.choice(answered: true, running: .init(version: "bbbbbbbbbbbb", root: "eeeeeeeeeeee"), own: own) == .otherCopy, "another copy (a checkout, another account) with other code: never stopped")
        check(S.choice(answered: true, running: nil, own: own) == .notCanvas, "something else answers: never stopped")
        check(S.choice(answered: true, running: .init(version: "bbbbbbbbbbbb", root: own.root), own: nil) == .reuse, "our own code unreadable: keep what runs")
        let h = S.health(Data(#"{"ok":true,"app":"canvas","version":"0123456789ab","root":"ba9876543210"}"#.utf8))
        check(h == S.Health(version: "0123456789ab", root: "ba9876543210"), "a Canvas /health is read")
        check(S.health(Data(#"{"ok":true,"version":"0123456789ab","root":"ba9876543210"}"#.utf8)) == h, "a Canvas server from before app was in /health: its exact answer")
        for (body, why) in [(#"{"ok":true}"#, "ok alone"), (#"{"ok":true,"version":"0123456789ab"}"#, "no root"),
                            (#"{"ok":true,"version":"old","root":"ba9876543210"}"#, "a version that is not a code hash"),
                            (#"{"ok":true,"version":"0123456789ab","root":"ba9876543210","status":"up"}"#, "another service's extra fields, no app"),
                            (#"{"ok":true,"app":"other","version":"0123456789ab","root":"ba9876543210"}"#, "another app"),
                            (#"{"ok":false,"app":"canvas","version":"0123456789ab","root":"ba9876543210"}"#, "not ok"), ("not json", "not json")] {
            check(S.health(Data(body.utf8)) == nil, "not positively Canvas (\(why)): never stopped")
        }

        // The hashes match src/version.ts exactly: a folder with nesting, hidden files, a symlink, sort-order traps and
        // a non-ASCII name, reached through a symlinked path, then the repo's own src folder.
        let fm = FileManager.default
        let tmp = (NSTemporaryDirectory() as NSString).appendingPathComponent("canvas-servercode-\(getpid())")
        try? fm.removeItem(atPath: tmp)
        let src = tmp + "/real/src"
        try? fm.createDirectory(atPath: src + "/a/b", withIntermediateDirectories: true)
        try? fm.createDirectory(atPath: src + "/.hidden", withIntermediateDirectories: true)
        for (f, s) in [("a.ts", "one"), ("a/b.ts", "two"), ("a/b/c.ts", "three"), ("a-b.ts", "four"), ("A.ts", "five"), (".DS_Store", "six"), (".hidden/x.js", "seven"), ("caf\u{e9}.ts", "eight"), ("empty.ts", "")] {
            fm.createFile(atPath: src + "/" + f, contents: Data(s.utf8))
        }
        try? fm.createSymbolicLink(atPath: src + "/link.ts", withDestinationPath: src + "/a.ts")
        try? fm.createSymbolicLink(atPath: src + "/linkdir", withDestinationPath: src + "/a")
        try? fm.createSymbolicLink(atPath: tmp + "/alias", withDestinationPath: tmp + "/real")
        defer { try? fm.removeItem(atPath: tmp) }
        let repoSrc = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../src").standardized.path
        guard let node = NodeLocator.find(env: ProcessInfo.processInfo.environment, home: NSHomeDirectory(), isExecutable: { fm.isExecutableFile(atPath: $0) }) else {
            check(false, "node is needed to check the hashes against src/version.ts"); return
        }
        func nodeSays(_ dir: String) -> String {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            let mod = repoSrc + "/version.ts"
            // version() hashes the folder its module is in, so the module is copied next to the files for the folder test.
            p.arguments = ["--input-type=module", "-e", """
              import fs from "node:fs"; import path from "node:path"; import url from "node:url";
              const dir = process.argv[1]; let m = \(String(reflecting: mod));
              if (dir !== path.dirname(m)) { fs.copyFileSync(m, path.join(dir, "zz-version.ts")); m = path.join(dir, "zz-version.ts"); }
              const v = await import(url.pathToFileURL(m).href);
              console.log(v.version() + " " + v.codeRootId());
              """, dir]
            let out = Pipe()
            p.standardOutput = out
            do { try p.run() } catch { return "" }
            p.waitUntilExit()
            return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let viaAlias = tmp + "/alias/src"
        let n = nodeSays(viaAlias)
        let sw = "\(S.version(srcDir: viaAlias) ?? "nil") \(S.rootId(srcDir: viaAlias))"
        check(n.count == 25 && n == sw, "the folder's version and root as src/version.ts says: node \(n), swift \(sw)")
        let nr = nodeSays(repoSrc)
        let swr = "\(S.version(srcDir: repoSrc) ?? "nil") \(S.rootId(srcDir: repoSrc))"
        check(nr.count == 25 && nr == swr, "the repo's own src as its server says: node \(nr), swift \(swr)")
        check(S.version(srcDir: tmp + "/missing") == nil, "an unreadable folder has no version")
    }

    static func canvasInsets() {
        let a = CanvasInsets.compute(panel: 244, rightSidebar: true, inset: 10, gap: 10, pill: 40, props: 284)
        check(a.l == 244 + 10 && a.r == 284 + 10 && a.t == 60 && a.b == 60, "panel and inspector open: \(a)")
        let b = CanvasInsets.compute(panel: nil, rightSidebar: false, inset: 10, gap: 10, pill: 40, props: 284)
        check(b.l == 0 && b.r == 10 && b.t == 60 && b.b == 60, "panel and inspector closed: \(b)")
        let tools = CanvasInsets.compute(panel: 226, rightSidebar: true, inset: 10, gap: 10,
                                         pill: 40, props: 284, bottomClearance: 72)
        check(tools.b == 72 && tools.t == 60, "fit clears the tool palette")
    }

    // Sweep S1: the titlebar's own tooltips never show, so the toolbar draws its own; it must stay on screen.
    static func tipPlacement() {
        let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
        let size = CGSize(width: 120, height: 22)
        let o = TipPlacement.origin(mouse: CGPoint(x: 100, y: 700), size: size, screen: screen)
        check(o.y + size.height < 700 && o.x >= 100, "below and right of the pointer")
        let edge = TipPlacement.origin(mouse: CGPoint(x: 990, y: 10), size: size, screen: screen)
        check(edge.x + size.width <= 996 && edge.y >= 4 && edge.y > 10, "kept on screen, above the pointer at the bottom edge")
    }

    // Sweep S2: the core items on a layer, the short menu on empty canvas.
    static func contextMenu() {
        check(ContextMenuLayout.canCreateComponent(type: "rectangle", reusable: false, path: false, inInstance: false), "ordinary node creates component")
        check(!ContextMenuLayout.canCreateComponent(type: "ref", reusable: false, path: false, inInstance: false), "instance cannot create component")
        check(!ContextMenuLayout.canCreateComponent(type: "frame", reusable: true, path: false, inInstance: false), "component cannot create component")
        check(!ContextMenuLayout.canCreateComponent(type: "text", reusable: false, path: true, inInstance: true), "instance descendants cannot create component")
        check(ContextMenuLayout.canCreateComponent(type: nil, reusable: false, path: false, inInstance: false), "mixed selection can create components")
        check(!ContextMenuLayout.canCreateComponent(type: "text", reusable: false, path: true, inInstance: false), "path cannot create component")
        let titles = ContextMenuLayout.node.map { $0.map(\.title) }
        check(titles == [["Cut", "Copy", "Paste", "Paste here", "Paste to replace", "Duplicate"], ["Group selection", "Frame selection", "Ungroup"],
                         ["Add auto layout", "Remove auto layout"], ["Bring to front", "Bring forward", "Send backward", "Send to back"], ["Select all"]], "layer menu groups: \(titles)")
        check(ContextMenuLayout.canvas.flatMap { $0 }.map(\.title) == ["Paste here", "Select all"], "canvas menu")
        let frame = ContextMenuLayout.node[1][1]
        check(frame.key == "g" && frame.command && frame.option && !frame.shift, "Frame selection is Opt+Cmd+G")
        let ungroup = ContextMenuLayout.node[1][2]
        check(ungroup.key == "g" && ungroup.shift && !ungroup.option, "Ungroup is Shift+Cmd+G")
        let del = ContextMenuLayout.delete
        check(del.key == ContextMenuLayout.backspace && !del.command, "Delete shows the bare Backspace key")
        let add = ContextMenuLayout.node[2][0], remove = ContextMenuLayout.node[2][1]
        check(add.key == "a" && add.shift && !add.command && !add.option, "Add auto layout is Shift+A")
        check(remove.key == "a" && remove.shift && remove.option && !remove.command, "Remove auto layout is Option+Shift+A")
    }

    // Codex round 3 e1 and e8: a focused field's draft was written to a node selected since, and an untouched
    // field rewrote 12.345 as its display 12.35.
    static func fieldDraft() {
        var d = FieldDraft()
        d.show("12.35", for: "f\u{1F}A")
        check(!d.commits("12.35", target: "f\u{1F}A"), "untouched field writes nothing")
        check(d.commits("40", target: "f\u{1F}A"), "edited field commits to its own node")
        check(!d.commits("40", target: "f\u{1F}B"), "draft typed for A is not written to B")
        d.show("7", for: "f\u{1F}B")
        check(d.commits("8", target: "f\u{1F}B"), "after the field shows B, edits go to B")
        // Round 5: widget text fields wrote card A's text into card B; an untouched focused field follows Undo.
        var w = FieldDraft()
        w.show("Revenue", for: "f\u{1F}widget:A")
        check(!w.commits("Revenue typed", target: "f\u{1F}widget:B"), "card A's text never goes to card B")
        check(!w.edited("Revenue") && w.edited("Revenue!"), "edited only once typed in")
    }

    /// The server reads ?file= with URLSearchParams: what it decodes must be the exact path.
    static func serverReads(_ url: URL, _ key: String) -> String? {
        guard let q = URLComponents(url: url, resolvingAgainstBaseURL: true)?.percentEncodedQuery else { return nil }
        for pair in q.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            guard kv.first == key else { continue }
            return (kv.count > 1 ? kv[1] : "").replacingOccurrences(of: "+", with: " ").removingPercentEncoding
        }
        return nil
    }

    // Finding swift-6 (ampersands) and swift-11 (closing the last tab drops shell=native).
    static func docURL() {
        let base = URL(string: "http://127.0.0.1:5189")!
        for path in ["/tmp/A&B.canvas", "/tmp/a=b+c #1?.canvas", "/Users/x/My Design 100%.canvas", "/tmp/plain.canvas", "/tmp/ü ñ.canvas"] {
            let u = DocURL.page(base: base, file: path)!
            check(serverReads(u, "file") == path, "file round trip \(path): \(u.absoluteString)")
            check(serverReads(u, "shell") == "native", "shell=native kept for \(path)")
        }
        // Every other call site builds its query through setQuery: a "+" in a search or a path stays a plus.
        for v in ["a+b", "C++ & more=1 #x", "/tmp/a=b+c.canvas", "plain", "ü ñ"] {
            var c = URLComponents(url: base.appendingPathComponent("api/search"), resolvingAgainstBaseURL: false)!
            c.setQuery([URLQueryItem(name: "file", value: v), URLQueryItem(name: "q", value: v)])
            let u = c.url!
            check(serverReads(u, "q") == v, "setQuery round trip \(v): \(u.absoluteString)")
            check(serverReads(u, "file") == v, "setQuery file round trip \(v)")
        }
        let empty = DocURL.page(base: base, file: nil)!
        check(serverReads(empty, "shell") == "native", "empty page keeps shell=native")
        check(serverReads(empty, "file") == nil, "empty page has no file")
    }

    // Finding swift-3: Finder's PATH has no node.
    static func nodeLocator() {
        let home = "/Users/t"
        let mise = home + "/.local/share/mise/installs/node/24/bin/node"
        let finderEnv = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        check(NodeLocator.find(env: finderEnv, home: home, isExecutable: { $0 == mise }) == mise, "mise node found without PATH")
        check(NodeLocator.find(env: finderEnv, home: home, isExecutable: { $0 == "/opt/homebrew/bin/node" }) == "/opt/homebrew/bin/node", "homebrew node")
        check(NodeLocator.find(env: ["CANVAS_NODE": "/x/node", "PATH": ""], home: home, isExecutable: { _ in true }) == "/x/node", "CANVAS_NODE wins")
        check(NodeLocator.find(env: ["PATH": "/a:/b"], home: home, isExecutable: { $0 == "/b/node" }) == "/b/node", "PATH is the last resort")
        check(NodeLocator.find(env: finderEnv, home: home, isExecutable: { _ in false }) == nil, "none found is nil, not /usr/bin/env")
        // The website's report link and the release manifest (getcanvas.cc).
        let os = OperatingSystemVersion(majorVersion: 15, minorVersion: 2, patchVersion: 0)
        let r = ReleaseLinks.report(version: "0.1.0", build: "716e9a5", os: os, arch: "arm64").absoluteString
        check(r == "https://getcanvas.cc/report?from=app&v=0.1.0&build=716e9a5&os=15.2&arch=arm64", "the report link: \(r)")
        let r2 = ReleaseLinks.report(version: "0.1.0 beta", build: "/Users/x", os: OperatingSystemVersion(majorVersion: 26, minorVersion: 1, patchVersion: 3), arch: "ppc").absoluteString
        check(r2 == "https://getcanvas.cc/report?from=app&os=26.1.3", "malformed values are left out, nothing else is sent: \(r2)")
        check(ReleaseLinks.isNewer("0.1.10", than: "0.1.9") && !ReleaseLinks.isNewer("0.1.0", than: "0.1.0"), "numeric version order")
        check(ReleaseLinks.isNewer("0.1.0", than: "0.1.0-alpha.2") && ReleaseLinks.isNewer("0.1.0-alpha.3", than: "0.1.0-alpha.2") && !ReleaseLinks.isNewer("0.1.0-alpha.1", than: "0.1.0"), "pre-releases")
        let m = #"{"latest":{"version":"0.2.0","file":"Canvas-0.2.0.zip"},"releases":[]}"#.data(using: .utf8)!
        check(ReleaseLinks.newer(manifest: m, than: "0.1.0") == "0.2.0" && ReleaseLinks.newer(manifest: m, than: "0.2.0") == nil, "the manifest's newer version")
        check(ReleaseLinks.newer(manifest: #"{"latest":null}"#.data(using: .utf8)!, than: "0.1.0") == nil && ReleaseLinks.newer(manifest: Data("x".utf8), than: "0.1.0") == nil, "no release, or garbage: nothing")
        let inApp = "/Applications/Canvas.app/Contents/Resources/node/bin/node"
        check(NodeLocator.find(env: finderEnv, home: home, bundled: inApp, isExecutable: { _ in true }) == inApp, "a release's own Node comes before any install")
        check(NodeLocator.find(env: ["CANVAS_NODE": "/x/node"], home: home, bundled: inApp, isExecutable: { _ in true }) == "/x/node", "CANVAS_NODE still wins over the app's Node")
    }

    // Finding swift-2: 1e20 in a widget number field trapped in Int(v).
    static func numbers() {
        check(JSONNumber.value(1e20) as? Double == 1e20, "1e20 stays a Double")
        check(JSONNumber.value(-1e300) as? Double == -1e300, "huge negative stays a Double")
        check(JSONNumber.value(60) as? Int == 60, "whole number is an Int")
        check(JSONNumber.value(2.5) as? Double == 2.5, "fraction stays a Double")
        check(JSONNumber.value(.infinity) == nil && JSONNumber.value(.nan) == nil, "non-finite rejected")
        check(JSONNumber.int(1e20) == nil && JSONNumber.int(.nan) == nil && JSONNumber.int(-.infinity) == nil, "int() refuses out of range")
        check(JSONNumber.int(99.6) == 100, "int() rounds")
    }

    // Finding swift-10: a 420 pt panel in a 720 pt window overlapped the inspector.
    static func layout() {
        func w(_ win: Double, _ stored: Double, _ insp: Bool) -> Double? {
            ShellLayout.sidebarWidth(window: win, stored: stored, rightSidebar: insp, inset: 10, gap: 10, props: 284, minWidth: 232).map(Double.init)
        }
        check(w(1560, 420, true) == 420, "wide window keeps the stored width")
        check(w(1560, 100, false) == 232, "never below the minimum")
        check(w(720, 420, true) == 296, "720 pt: sidebar and inspector leave the minimum canvas")
        check(w(520, 420, false) == 380, "narrow window without inspector: clamped to the room left")
        check(w(600, 420, true) == nil, "no room at all hides the panel")
        let withTools = ShellLayout.sidebarWidth(window: 720, stored: 420, rightSidebar: true,
                                                 inset: 10, gap: 10, props: 284, minWidth: 224, minimumCanvas: 170)
        check(withTools == 246, "720 pt: two sidebars leave room for the tool palette")
    }

    static func drawToolPalette() {
        let groups = DrawTool.paletteGroups
        check(groups == [[.frame, .rectangle, .ellipse, .text], [.sticky, .sticker]], "draw tools precede whiteboard tools")
        check(groups.flatMap { $0 }.map(\.keycap) == ["F", "R", "O", "T", "S", "\u{21E7}S"], "palette keycaps match tool shortcuts")
        check(DrawTool.timer.keycap == "\u{21E7}T", "the Timer control shows its Shift shortcut")
        check(DrawTool.vote.keycap == "\u{21E7}D", "the Vote control shows its Shift shortcut")
    }

    // Sidebar resize: the editor panel and the Home sidebar share one set of rules.
    static func sidebarResize() {
        let lo: CGFloat = 200, hi: CGFloat = 420
        check(SidebarSize.drag(start: 244, translation: 30, min: lo, max: hi) == 274, "drag right widens")
        check(SidebarSize.drag(start: 244, translation: -500, min: lo, max: hi) == lo, "drag stops at the minimum")
        check(SidebarSize.drag(start: 244, translation: 900, min: lo, max: hi) == hi, "drag stops at the maximum")
        check(SidebarSize.drag(start: 244, translation: 10.4, min: lo, max: hi) == 254, "whole points, so edges stay sharp")
        check(SidebarSize.drag(start: 244, translation: 10.6, min: lo, max: hi) == 255, "whole points round to nearest")
        // A window with less room than the maximum: the drag stops where the panel stops, no dead travel after it.
        check(SidebarSize.drag(start: 300, translation: 200, min: lo, max: 340) == 340, "drag stops at the room left")
        check(SidebarSize.drag(start: .nan, translation: 5, min: lo, max: hi) == lo, "a NaN start cannot poison the width")
        check(SidebarSize.restore(0, fallback: 244, min: lo, max: hi) == 244, "nothing stored: the default")
        check(SidebarSize.restore(-5, fallback: 244, min: lo, max: hi) == 244, "negative stored: the default")
        check(SidebarSize.restore(.nan, fallback: 244, min: lo, max: hi) == 244, "NaN stored: the default")
        check(SidebarSize.restore(.infinity, fallback: 244, min: lo, max: hi) == 244, "infinite stored: the default")
        check(SidebarSize.restore(90, fallback: 244, min: lo, max: hi) == lo, "stored below the minimum: the minimum")
        check(SidebarSize.restore(900, fallback: 244, min: lo, max: hi) == hi, "stored above the maximum: the maximum")
        check(SidebarSize.restore(300, fallback: 244, min: lo, max: hi) == 300, "stored in range: kept")
        // A share of the window caps the Home sidebar, between its own minimum and maximum.
        check(SidebarSize.cap(window: 1400, share: 0.4, min: 200, max: 360) == 360, "wide window: the maximum")
        check(SidebarSize.cap(window: 700, share: 0.4, min: 200, max: 360) == 280, "mid window: a share of it")
        check(SidebarSize.cap(window: 300, share: 0.4, min: 200, max: 360) == 200, "tiny window: never under the minimum")
        // The editor panel's room is the same figure sidebarWidth clamps to.
        check(ShellLayout.room(window: 1560, rightSidebar: true, inset: 10, gap: 10, props: 284) == 1560 - 10 - 120 - 294,
              "room beside the inspector")
        check(ShellLayout.room(window: 1560, rightSidebar: false, inset: 10, gap: 10, props: 284) == 1560 - 10 - 10 - 120,
              "room without the inspector")
        // The edge's hit strip is wide enough to grab and its centre sits on the edge.
        check(SidebarSize.hitWidth >= 12, "hit strip at least 12 pt")
    }

    // Backlog: Locate… for a tab whose file moved.
    static func tabs() {
        check(TabList.replacing(["/a", "/b", "/c"], "/b", with: "/n") == ["/a", "/n", "/c"], "new path takes the old place")
        check(TabList.replacing(["/a", "/b", "/n"], "/b", with: "/n") == ["/a", "/n"], "no duplicate tab")
        check(TabList.replacing(["/a"], "/zz", with: "/n") == ["/a", "/n"], "missing old appends")
    }

    // Finding swift-4: a refused connection before the server is up must be retried, not left blank.
    static func retries() {
        check(NavRetry.shouldRetry(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost, attempt: 0), "refused is retried")
        check(!NavRetry.shouldRetry(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost, attempt: 60), "not forever")
        check(!NavRetry.shouldRetry(domain: NSURLErrorDomain, code: NSURLErrorCancelled, attempt: 0), "a cancelled load (new navigation) is not")
        check(!NavRetry.shouldRetry(domain: "WebKitErrorDomain", code: 102, attempt: 0), "WebKit's own errors are not")
        // Round 5: didFail reloaded on every error, NSURLErrorCancelled from a tab switch included, forever.
        check(!NavRetry.shouldRetry(domain: NSURLErrorDomain, code: NSURLErrorCancelled, attempt: 3), "a committed page cancelled by a tab switch is not reloaded")
        check(NavRetry.shouldRetry(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost, attempt: 3), "a dropped server is")
        check(NavRetry.delay(attempt: 0) > 0 && NavRetry.delay(attempt: 100) <= 2, "backoff bounded")
    }

    // Backlog: one Auto control, its state read from the node, its click a clear on/off.
    static func autoTracking() {
        let on: [String: Any] = ["metadata": ["type": "canvas", AutoTracking.key: "auto"]]
        check(AutoTracking.isOn(on), "auto read from metadata")
        check(!AutoTracking.isOn(["letterSpacing": -0.2]), "plain value is not auto")
        check(AutoTracking.click(on: true, value: -0.31, size: 16, editable: true) == .turnOff(keep: -0.31), "off keeps the value")
        check(AutoTracking.click(on: false, value: 0, size: 16, editable: true) == .turnOn, "on with a size")
        check(AutoTracking.click(on: false, value: 0, size: nil, editable: true) == .none, "no size, no auto")
        check(AutoTracking.click(on: true, value: 0, size: 16, editable: false) == .none, "read-only does nothing")
        check(AutoTracking.metadata(on["metadata"], on: false) == nil, "turning off leaves no empty metadata")
        let kept = AutoTracking.metadata(["type": "x", "other": 1], on: true)
        check(kept?["other"] as? Int == 1 && kept?["type"] as? String == "x", "other metadata kept")
    }

    // QA item 10: pages reorder by drag, boards dragged from Layers move to a page.
    static func pageDrag() {
        check(PageDrag.index(from: 2, y: 1, height: 24, count: 3) == 0, "gap above row one accepts page three")
        check(PageDrag.index(from: 0, y: 75, height: 24, count: 3) == 2, "gap below the final row accepts page one")
        check(PageDrag.index(from: 2, y: 26, height: 24, count: 3) == 1, "the second row starts one row height down")
        check(PageDrag.index(from: 0, y: 77, height: 24, count: 3) == nil, "below the list does not move")
        check(PageDrag.index(from: 2, y: -1, height: 24, count: 3) == nil, "above the list does not move")
        check(PageDrag.step(from: 1, by: -1, count: 3) == 0 && PageDrag.step(from: 1, by: 1, count: 3) == 2, "step from the middle")
        check(PageDrag.step(from: 0, by: -1, count: 3) == nil && PageDrag.step(from: 2, by: 1, count: 3) == nil, "step stays in bounds")
        check((0..<4).map { PageDrag.shift(row: $0, from: 2, to: 0) } == [1, 1, 0, 0], "rows shift down to make room")
        check((0..<4).map { PageDrag.shift(row: $0, from: 0, to: 2) } == [0, -1, -1, 0], "rows shift up to make room")
        check(PageDrag.index(from: 0, onto: 2, below: false, count: 3) == 1, "first page dropped on the top half of the third: before it")
        check(PageDrag.index(from: 0, onto: 2, below: true, count: 3) == 2, "below the last: last")
        check(PageDrag.index(from: 2, onto: 0, below: false, count: 3) == 0, "last to the top")
        check(PageDrag.index(from: 1, onto: 1, below: true, count: 3) == nil && PageDrag.index(from: 1, onto: 2, below: false, count: 3) == nil, "no move")
        check(PageDrag.index(from: 5, onto: 0, below: false, count: 3) == nil, "out of range")
        check(PageDrag.boards(dragged: ["B1", "L1", "B2"], text: "B1", boards: ["B1", "B2"]) == ["B1", "B2"], "only boards from the layers drag")
        check(PageDrag.boards(dragged: [], text: "B3", boards: ["B3"]) == ["B3"] && PageDrag.boards(dragged: [], text: "x", boards: ["B3"]).isEmpty, "plain text")
    }

    // QA components P2: the instance inspector lists overridden properties by name.
    static func overrideLabels() {
        check(OverrideLabels.titles(["fill", "cornerRadius", "descendants"]) == ["Corner radius", "Fill", "Layers inside"], "panel order")
        check(OverrideLabels.titles(["stroke", "strokeWidth"]) == ["Stroke"], "one title for the stroke keys")
        check(OverrideLabels.titles(["clip"]) == ["clip"] && OverrideLabels.titles([]).isEmpty, "unknown keys as they are; none")
        // Reset one override: each row resets every key its title stands for.
        let g = OverrideLabels.groups(["strokeWidth", "fill", "stroke", "clip"])
        check(g.map(\.title) == ["Fill", "Stroke", "clip"], "rows in panel order, unknown last")
        check(g[1].keys == ["stroke", "strokeWidth"] && g[0].keys == ["fill"] && g[2].keys == ["clip"], "a row's keys")
        // A swapped nested instance: the swap is its own row, first; its reset takes `ref`.
        let s = OverrideLabels.groups(["fill", "ref"])
        check(s.map(\.title) == ["Swapped component", "Fill"] && s[0].keys == ["ref"], "the swap's row")
    }

    // Math in fields: ^ is a power, "^2" raises the current value; Option-scrub speed by height;
    // Lock aspect ratio keeps W:H.
    static func powerScrubAspect() {
        check(NumericExpr.evaluate("2^3", current: nil) == 8, "2^3")
        check(NumericExpr.evaluate("^2", current: 12) == 144, "^2 raises the current value")
        check(NumericExpr.evaluate("^2", current: nil) == nil, "^2 on Mixed is refused")
        check(NumericExpr.evaluate("2^3^2", current: nil) == 512, "right to left, like maths")
        check(NumericExpr.evaluate("2*3^2", current: nil) == 18 && NumericExpr.evaluate("(1+1)^3", current: nil) == 8, "before * and after parentheses")
        check(NumericExpr.evaluate("-2^2", current: nil) == -4 && NumericExpr.evaluate("4^-1", current: nil) == 0.25, "unary minus")
        check(NumericExpr.evaluate("10^400", current: nil) == nil, "an infinite result is refused")
        check(FieldMath.isRelative("^2"), "^2 is relative")
        check(ScrubSpeed.factor(dy: 0) == 1 && ScrubSpeed.factor(dy: -39) == 1 && ScrubSpeed.factor(dy: 39) == 1, "near the start: 1x")
        check(ScrubSpeed.factor(dy: -41) == 2 && ScrubSpeed.factor(dy: -400) == 2, "up: 2x")
        check(ScrubSpeed.factor(dy: 41) == 0.5 && ScrubSpeed.factor(dy: 119) == 0.5 && ScrubSpeed.factor(dy: 121) == 0.25, "down: 1/2, then 1/4")
        check(AspectLock.isOn(["metadata": ["type": "canvas", "canvasLockAspect": true]]) && !AspectLock.isOn([:]), "the lock lives in metadata")
        let on = AspectLock.metadata(["type": "canvas", "canvasLayout": ["wrap": true]], on: true)
        check(on?["canvasLockAspect"] as? Bool == true && on?["canvasLayout"] != nil, "on keeps the rest of metadata")
        check(AspectLock.metadata(["type": "canvas", "canvasLockAspect": true], on: false) == nil, "off with nothing left removes metadata")
        check(AspectLock.other(.width, 200, w: 100, h: 50) == ["height": 100], "W 200 of 100x50: H 100")
        check(AspectLock.other(.height, 25, w: 100, h: 50) == ["width": 50], "H 25 of 100x50: W 50")
        check(AspectLock.other(.width, 200, w: 100, h: nil).isEmpty && AspectLock.other(.width, 200, w: 0, h: 50).isEmpty, "no ratio: only the typed axis")
        check(AspectLock.other(.width, 101, w: 3, h: 1) == ["height": 33.67], "rounded to two decimals")
    }

    // QA items 14 and 15: scrub at 1 per point; Up/Down in a Mixed field steps each layer from its own value.
    static func mixedStep() {
        check(MixedStep.scrubUnits(5, step: 1) == 5 && MixedStep.scrubUnits(3, step: 10) == 30, "1 unit per point")
        let nodes: [String: [String: Any]] = ["a": ["x": 10], "b": ["x": 25.5], "c": ["x": "$pos"], "d": [:], "e": ["opacity": 0.95]]
        let w = MixedStep.writes(nodes: nodes, ids: ["a", "b", "c", "d", "missing"], key: "x", delta: 1, fallback: 0, min: nil, max: nil)
        check(w.map(\.id) == ["a", "b", "d"] && w.map(\.value) == [11, 26.5, 1], "each from its own value; tokens and unknown ids skipped")
        let o = MixedStep.writes(nodes: nodes, ids: ["e", "d"], key: "opacity", delta: 0.1, fallback: 1, min: 0, max: 1)
        check(o.map(\.value) == [1, 1], "clamped, absent opacity is 1")
    }

    // QA native round 2, P2-3 and P3-11/12: letter spacing in %, rotation normalised, the smallest size.
    static func fieldMath() {
        check(FieldMath.tracking("-2%", current: 0, fontSize: 40) == -0.8, "-2% of 40 px is -0.8 px")
        check(FieldMath.tracking("1.5", current: 0, fontSize: 40) == 1.5 && FieldMath.tracking("2px", current: 0, fontSize: 40) == 2, "plain and px numbers are px")
        check(FieldMath.tracking("5%", current: 0, fontSize: nil) == nil, "% without a font size is refused")
        check(FieldMath.angle(400) == 40 && FieldMath.angle(270) == -90 && FieldMath.angle(-190) == 170 && FieldMath.angle(180) == 180 && FieldMath.angle(-180) == 180, "rotation in (-180, 180]")
        check(FieldMath.angle(360) == 0 && FieldMath.angle(45.5) == 45.5, "a full turn is 0")
        check(NumericExpr.clamp(0, FieldMath.minSize, nil) == 0.01, "W 0 is 0.01")
        check(FieldMath.isRelative("+10") && FieldMath.isRelative(" *2") && !FieldMath.isRelative("-10") && !FieldMath.isRelative("50"), "relative text")
    }

    // QA native round 2, P2-2 and Codex 9: "+10" on a Mixed field, and per-side stroke widths keep their shape.
    static func mixedEach() {
        let nodes: [String: [String: Any]] = ["a": ["x": 10], "b": ["x": 25], "c": ["x": "$pos"], "d": [:],
                                              "s": ["strokeWidth": ["top": 2, "right": 0, "bottom": 0, "left": 0]], "o": ["opacity": 0.5]]
        let r = MixedStep.relativeWrites(nodes: nodes, ids: ["a", "b", "c", "d"], key: "x", text: "+10", fallback: 0, min: nil, max: nil)
        check(r.map(\.id) == ["a", "b", "d"] && r.compactMap { $0.value as? Double } == [20, 35, 10], "each layer moves from its own value")
        check(MixedStep.relativeWrites(nodes: nodes, ids: ["a"], key: "x", text: "50", fallback: 0, min: nil, max: nil).isEmpty, "a plain number is not relative")
        let o = MixedStep.relativeWrites(nodes: nodes, ids: ["o", "d"], key: "opacity", text: "*2", scale: 100, fallback: 1, min: 0, max: 1)
        check(o.compactMap { $0.value as? Double } == [1, 1], "opacity through the field's percent, clamped")
        let st = MixedStep.stepWrites(nodes: nodes, ids: ["s"], key: "strokeWidth", delta: 1, fallback: 1, min: 0, max: nil)
        let sides = st.first?.value as? [String: Any]
        check((sides?["top"] as? Double) == 3 && (sides?["right"] as? NSNumber)?.doubleValue == 0, "a top-only stroke stays top-only: \(String(describing: sides))")
        let w = MixedStep.writes(nodes: nodes, ids: ["a"], key: "x", delta: 1, fallback: 0, min: nil, max: nil)
        check(w.map(\.value) == [11], "plain steps unchanged")
    }

    // QA native round 2, P2-8/9: the menu bar.
    static func menuSpec() {
        let items = MenuSpec.menus.flatMap { m in m.items.compactMap { $0 }.map { (m.title, $0) } }
        func has(_ menu: String, _ title: String, _ key: String, _ mods: Set<MenuSpec.Mod>) -> Bool {
            items.contains { $0.0 == menu && $0.1.title == title && $0.1.key == key && $0.1.mods == mods }
        }
        check(has("Canvas", "About Canvas", "", []) && has("Canvas", "Settings\u{2026}", ",", [.command]) && has("Canvas", "Hide Canvas", "h", [.command]) && has("Canvas", "Quit Canvas", "q", [.command]), "app menu")
        check(has("File", "Close Tab", "w", [.command]), "Cmd+W closes the tab")
        check(has("Window", "Home", "0", [.command, .shift]) && MenuSpec.window.first??.title == "Home", "Window > Home on Shift+Cmd+0, first in the menu")
        check(items.contains { $0.0 == "Edit" && $0.1.command == "repeat" && $0.1.key == "." && $0.1.mods.isEmpty && $0.1.pageKey }, "Edit > Repeat on the page's . key")
        check(has("View", "Draw Sticky", "s", []) && has("View", "Place Sticker", "s", [.shift]), "whiteboard tools have distinct shortcuts")
        check(has("View", "Start a Vote", "d", [.shift]), "start a vote from the View menu or Shift+D")
        check(has("View", "Start a Timer", "t", [.shift]), "start a timer from the View menu or Shift+T")
        check(has("View", "Zoom to 100%", "0", [.shift]) && has("View", "Zoom to Fit", "1", [.shift]) && has("View", "Zoom to Selection", "2", [.shift]), "zoom keys")
        check(has("View", "Zoom In", "=", [.command]) && has("View", "Zoom Out", "-", [.command]), "zoom in and out")
        check(has("Object", "Create Component", "k", [.command, .option]) && has("Object", "Detach Instance", "b", [.command, .option]), "components")
        check(has("Object", "Rename", "r", [.command]) && !items.contains { $0.1.title == "Reload Page" && $0.1.key == "r" }, "Cmd+R renames, never reloads")
        check(has("Object", "Group Selection", "g", [.command]) && has("Object", "Frame Selection", "g", [.command, .option]) && has("Object", "Bring Forward", "]", [.command]), "object items")
        check(has("Arrange", "Align Left", "a", [.option]) && has("Arrange", "Distribute Horizontal Spacing", "h", [.option, .shift]), "arrange")
        check(has("Edit", "Copy Link", "l", [.command]) && !items.contains { $0.1.command == "copyLink" && $0.1.pageKey }, "Edit > Copy Link on Cmd+L, the menu's key")
        check(has("Edit", "Copy as PNG", "c", [.command, .shift]) && has("File", "Export\u{2026}", "e", [.command, .shift]), "Shift+Cmd+C and Shift+Cmd+E")
        check(has("View", "Pixel Grid", "'", [.command]) && has("View", "Rulers", "r", [.shift]), "Cmd+' and Shift+R")
        check(has("Edit", "Paste to Replace", "r", [.command, .shift]), "Paste to replace, Shift+Cmd+R")
        check(has("File", "Place Image\u{2026}", "k", [.command, .shift]), "Place image, Shift+Cmd+K")
        check(ContextMenuLayout.node.flatMap { $0 }.contains { $0.selector == "pasteReplace:" && $0.key == "r" && $0.shift }, "right-click > Paste to replace")
        check(has("Edit", "Find and Replace\u{2026}", "f", [.command]), "Edit > Find and Replace on Cmd+F")
        // Styled ranges in a text (TextRangeState): the selected letters' style over the layer's, Mixed, what goes to them.
        let tr = TextRangeState(["id": "T", "start": 2, "end": 5, "style": ["fontSize": 22, "fontWeight": "mixed", "fill": "#E5484D"]])!
        check(tr.mixed("fontWeight") && !tr.mixed("fontSize"), "a mixed key")
        let shown = tr.overlay(["fontSize": 16, "fontWeight": "400", "x": 3])
        check((shown["fontSize"] as? Int) == 22 && (shown["fontWeight"] as? String) == "400" && (shown["fill"] as? String) == "#E5484D", "the letters' values over the layer's, Mixed keeps the layer's")
        check(TextRangeState.takes(["fontSize": 30], remove: []) && !TextRangeState.takes(["fontSize": 30, "x": 1], remove: []) && !TextRangeState.takes(["fill": "#000"], remove: ["fill"]), "only text styles go to the letters")
        check(TextRangeState.keysIn([["start": 0, "end": 2, "fontWeight": "700"], ["start": 3, "end": 4, "fill": "#fff"]]) == ["fontWeight", "fill"], "the keys a layer's ranges set")
        check(TextRangeState(["start": 1]) == nil, "a range needs its layer")
        check(has("Object", "Lock/Unlock Selection", "l", [.command, .shift]) && has("Object", "Collapse Layers", "l", [.option]), "lock and collapse keys")
        check(has("Edit", "Select Inverse", "a", [.command, .shift]) && has("Edit", "Select Matching Layers", "a", [.command, .option]), "select inverse and select matching layers")
        check(["fill", "stroke", "effect", "textStyle", "font", "instances"].allSatisfy { k in items.contains { $0.0 == "Edit" && $0.1.command == "selectSame:" + k } }, "Edit > Select All with Same")
        let chords = items.compactMap { MenuSpec.chord($0.1) }
        check(Set(chords).count == chords.count, "no key bound twice: \(chords.filter { c in chords.filter { $0 == c }.count > 1 })")
        let commands = items.map(\.1.command).filter { !$0.isEmpty } // submenu markers have none
        check(Set(commands).count == commands.count, "each command once")
        check(!items.contains { $0.1.title.contains("\u{2014}") || $0.1.title.contains("\u{00B7}") }, "no em dashes or middle dots")
    }

    // QA native round 2, P3-26: each tab keeps its own left panel section.
    static func panelMemory() {
        var saved: [String: String] = [:]
        var r = PanelMemory.next(saved, leaving: "a", current: "Widgets", opening: "b")
        check(r.section == nil && r.saved["a"] == "Widgets", "a new tab keeps what is shown")
        saved = r.saved
        r = PanelMemory.next(saved, leaving: "b", current: "Layers", opening: "a")
        check(r.section == "Widgets", "back to a: its Widgets")
        check(KnownSize.pick(drawn: nil, known: 120) == 120 && KnownSize.pick(drawn: 80, known: 120) == 80, "a hidden layer keeps its last size")
    }

    // Caching: one web view per tab, bounded (TabPool).
    static func tabPool() {
        check(TabPool.evict(order: ["a", "b", "c"], active: "c", keep: 4).isEmpty, "under the limit: nothing goes")
        check(TabPool.evict(order: ["a", "b", "c", "d", "e"], active: "e", keep: 4) == ["a"], "the least recent hidden one goes")
        check(TabPool.evict(order: ["a", "b", "c", "d", "e"], active: "a", keep: 4) == ["b"], "never the shown one, even when least recent")
        check(TabPool.evict(order: ["a", "b", "c"], active: nil, keep: 2) == ["a"], "no shown tab: the limit counts them all")
        check(TabPool.evict(order: ["a", "b"], active: "b", keep: 1) == ["a"], "keep 1: only the shown one")
        check(TabPool.onPressure(order: ["a", "b", "c"], active: "c", critical: false) == ["a"], "warning: one hidden tab")
        check(TabPool.onPressure(order: ["a", "b", "c"], active: "b", critical: true) == ["a", "c"], "critical: every hidden tab")
        check(TabPool.onPressure(order: ["a"], active: "a", critical: true).isEmpty, "the shown tab stays")
        check(TabPool.touch(["a", "b", "c"], "a") == ["b", "c", "a"] && TabPool.touch(["a"], "z") == ["a", "z"], "shown moves last")
    }

    // Edit > Repeat: the change a relative entry made, in the file's units, and the menu title.
    static func repeatHint() {
        func num(_ d: [String: Any]?, _ k: String) -> Double? { (d?[k] as? NSNumber)?.doubleValue ?? d?[k] as? Double }
        let plus = RepeatHint.rel("+10", old: 100, new: 110)
        check(plus?["op"] as? String == "+" && num(plus, "by") == 10, "+10 is a change of +10")
        let opacity = RepeatHint.rel("+10", old: 0.5, new: 0.6)
        check(num(opacity, "by") == 0.1, "opacity +10 in the field is +0.1 in the file")
        let times = RepeatHint.rel("*2", old: 4, new: 8)
        check(times?["op"] as? String == "*" && num(times, "by") == 2, "*2 multiplies")
        check(num(RepeatHint.rel("/4", old: 8, new: 2), "by") == 0.25, "/4 is x0.25")
        check(RepeatHint.rel("24", old: 8, new: 24) == nil, "a plain number is a value, not a change")
        check(RepeatHint.rel("-5", old: 8, new: -5) == nil, "a leading minus is a negative number")
        check(RepeatHint.rel(nil, old: 8, new: 9) == nil, "no text: not relative")
        let one = RepeatHint.single("+10", props: ["width": 110], node: ["width": 100])
        check(num(one?["width"] as? [String: Any], "by") == 10, "one key: {width: +10}")
        check(RepeatHint.single("+10", props: ["width": 110, "height": 5], node: [:]) == nil, "several keys: no hint")
        check(RepeatHint.single("+1", props: ["clip": true], node: ["clip": false]) == nil, "booleans are not numbers")
        check(num(RepeatHint.mixed("+10", scale: 100), "by") == 0.1, "Mixed opacity +10")
        check(num(RepeatHint.mixed("/2"), "by") == 0.5, "Mixed /2")
        check(RepeatHint.mixed("12") == nil, "Mixed plain number: no hint")
        let merged = RepeatHint.merge(["width": ["op": "+", "by": 1]], nil, keys: ["width"])
        check(merged == nil, "a later plain value of the same key ends the change")
        let kept = RepeatHint.merge(["width": ["op": "+", "by": 1]], ["height": ["op": "+", "by": 2]], keys: ["height"])
        check(kept?.keys.sorted() == ["height", "width"], "other keys' changes stay")
        check(RepeatHint.title("Fill Change") == "Repeat Fill Change" && RepeatHint.title(nil) == "Repeat", "menu title")
    }

    // Export as PNG / SVG: the save panel's name matches what the server names files in a folder (src/export.ts).
    // Cmd+L links: the shell reads what src/page/link-logic.js writes (test/link.test.ts has the page's side).
    static func canvasLink() {
        let a = CanvasLink.parse("canvas://open?file=/Users/me/My%20Designs/D%C3%A9sir%C3%A9e%20%E2%9C%A8.canvas&page=page-2&node=Scr01,Ins01/Lbl01,a%2Cb,c%2Bd,widget:abc")
        check(a == CanvasLink(file: "/Users/me/My Designs/Désirée ✨.canvas", page: "page-2", nodes: ["Scr01", "Ins01/Lbl01", "a,b", "c+d", "widget:abc"]), "spaces, unicode, instance paths, an id's own comma: \(String(describing: a))")
        let b = CanvasLink.parse(URL(string: "canvas://open?file=/tmp/a%2Bb%26c.canvas")!)
        check(b == CanvasLink(file: "/tmp/a+b&c.canvas", page: nil, nodes: []), "a page link, + and & in the path")
        check(CanvasLink.parse("  canvas://open?file=/f.canvas&node=A,A,B&later=1\n")?.nodes == ["A", "B"], "whitespace, repeats and unknown keys")
        check(CanvasLink.parse("canvas://open?node=A") == nil && CanvasLink.parse("canvas://open?file=rel.canvas") == nil && CanvasLink.parse("https://x/?file=/f") == nil, "no file, a relative file, another scheme")
        check(CanvasLink.parse("canvas://open?file=/f.canvas&node=%E0%A4%A") == nil, "broken encoding")
        let cmd = CanvasLink(file: "/f", page: "p'1", nodes: ["a\"b", "c"]).pageCommand
        check(cmd == "{cmd:'openLink',page:\"p'1\",ids:[\"a\\\"b\",\"c\"]}", "the page command quotes its strings: \(cmd)")
        check(CanvasLink(file: "/f", page: nil, nodes: []).pageCommand == "{cmd:'openLink',page:null,ids:[]}", "no page, no nodes")
    }

    static func exportNaming() {
        let two = ExportNaming.png[1], play = ExportNaming.presets[2]
        check(ExportNaming.fileName("Home", format: "png", choice: ExportNaming.png[0]) == "Home.png", "1x")
        check(ExportNaming.fileName("Home", format: "png", choice: two) == "Home@2x.png", "2x")
        check(ExportNaming.fileName("Home", format: "png", choice: play) == "Home 1080x1920.png", "preset size")
        check(ExportNaming.fileName("Home", format: "svg", choice: nil) == "Home.svg", "svg")
        check(ExportNaming.safeName("a/b:c") == "a-b-c" && ExportNaming.safeName("  ") == "Layer" && ExportNaming.safeName("..x") == "x", "safe names")
        check(ExportNaming.presets.map(\.preset) == ["app-store-6.5", "app-store-6.9", "play"], "presets the server knows")
    }

    // Export settings (the inspector's Export section, Shift+Cmd+E): what is saved on a layer and what the server gets.
    static func exportSettings() {
        typealias S = ExportSettings.Setting
        check(ExportSettings.parseScale("2x") == 2 && ExportSettings.parseScale(" 0.5X ") == 0.5 && ExportSettings.parseScale("9") == nil && ExportSettings.parseScale("x") == nil, "scales typed")
        check(ExportSettings.scaleText(1.5) == "1.5" && ExportSettings.scaleText(2) == "2", "scale text")
        let m = ExportSettings.metadata(["type": "canvas", "canvasLayout": ["wrap": true]], [S(format: "png", scale: 2, suffix: "@2x"), S(format: "svg", scale: 3, suffix: "")])
        let list = (m?["canvasExports"] as? [[String: Any]]) ?? []
        check(m?["canvasLayout"] != nil && list.count == 2, "settings beside the other metadata")
        check(list[1]["scale"] == nil && list[1]["suffix"] == nil, "SVG keeps no scale, an empty suffix is left out")
        let back = ExportSettings.read(["metadata": m as Any])
        check(back == [S(format: "png", scale: 2, suffix: "@2x"), S(format: "svg", scale: 1, suffix: "")], "read back: \(back)")
        check(ExportSettings.metadata(["type": "canvas", "canvasExports": [["format": "png"]]], []) == nil, "the last one removed takes metadata with it")
        check(ExportSettings.read(["metadata": ["canvasExports": [["format": "gif"], ["format": "jpg", "scale": 99]]]]) == [S(format: "jpg", scale: 1, suffix: "")], "unknown formats out, a bad scale is 1x")
        check(ExportSettings.next(after: []) == S() && ExportSettings.next(after: [S()]) == S(format: "png", scale: 1.5, suffix: "@1.5x") && ExportSettings.next(after: [S(format: "png", scale: 2, suffix: "")]) == S(format: "png", scale: 3, suffix: "@3x"), "+ adds the next scale up with its suffix")
        let items = ExportSettings.items([("A", [:]), ("B", ["metadata": m as Any])])
        check(items.count == 3 && items[0]["format"] as? String == "png" && items[0]["scale"] as? Double == 1 && items[2]["format"] as? String == "svg", "a layer without settings exports one 1x PNG")
        check(ExportNaming.fileName("Home", format: "jpg", choice: ExportNaming.png[1]) == "Home@2x.jpg" && ExportNaming.fileName("Home", format: "pdf", choice: nil) == "Home.pdf", "other formats' names")
    }

    static func copyAsAndZoom() {
        check(CopyAs.formats.map(\.id) == ["png", "svg", "css", "swiftui", "text"], "Copy as formats")
        check(CopyAs.toast("png", count: 1) == "Copied as PNG" && CopyAs.toast("png", count: 3) == "Copied 3 layers as PNG" && CopyAs.toast("css", count: 3) == "Copied as CSS", "toasts")
        check(ZoomInput.parse("150") == .zoom(1.5) && ZoomInput.parse("150%") == .zoom(1.5) && ZoomInput.parse(" 2x ") == .zoom(2), "typed zoom")
        check(ZoomInput.parse("fit") == .fit && ZoomInput.parse("abc") == .invalid && ZoomInput.parse("0") == .invalid, "fit and bad input")
        check(ZoomInput.parse("100000") == .zoom(256) && ZoomInput.parse("1") == .zoom(0.02), "clamped to 2% and 25600%")
    }

    // Toasts you can act on: a path or an error copies on click; an error can go to the agent; plain news does neither.
    static func toastActions() {
        let log = "Canvas\u{2019}s server will not start. Details in ~/Library/Logs/Canvas/server.log."
        check(ToastLogic.path(in: log) == "~/Library/Logs/Canvas/server.log", "a ~ path, the sentence's full stop left out: \(String(describing: ToastLogic.path(in: log)))")
        check(ToastLogic.path(in: "Canvas could not start its server (/opt/homebrew/bin/node): permission denied") == "/opt/homebrew/bin/node", "a path in brackets")
        check(ToastLogic.path(in: "Opened \u{201C}/Users/me/My Designs/A.canvas\u{201D}") == "/Users/me/My Designs/A.canvas", "a quoted path keeps its spaces")
        check(ToastLogic.path(in: "Highlighted 3 of 5 instances") == nil && ToastLogic.path(in: "Opacity 1/2") == nil && ToastLogic.path(in: "Use / to search") == nil, "no path in plain news")
        check(ToastLogic.isError(log, level: nil), "will not start is an error")
        check(ToastLogic.isError("Could not save the change", level: nil) && ToastLogic.isError("Canvas could not show the link: a.canvas did not open", level: nil), "could not")
        check(ToastLogic.isError("anything", level: "error"), "an error level")
        check(!ToastLogic.isError("Link copied", level: "link") && !ToastLogic.isError("Exported 3 files", level: "success") && !ToastLogic.isError("Selected 4 layers matching \u{201C}x\u{201D}", level: nil), "news is not an error")
        check(!ToastLogic.isError("Could not save", level: "success"), "a success level wins")
        check(ToastLogic.copyText(log, level: nil) == "~/Library/Logs/Canvas/server.log", "a path copies the path")
        check(ToastLogic.copyText("Could not save the change", level: nil) == "Could not save the change", "an error copies its text")
        check(ToastLogic.copyText("Link copied", level: "link") == nil && ToastLogic.copyText("Copied", level: "success") == nil, "news copies nothing")
        let ask = ToastLogic.askPrompt("Could not save the change")
        check(ask.contains("\u{201C}Could not save the change\u{201D}") && !ask.contains("\n"), "the ask quotes the toast on one line: \(ask)")
    }

    // First launch opens the Welcome file; anyone who has opened a file before, or was welcomed, never sees it again.
    static func firstRun() {
        let env: [String: String] = [:]
        check(FirstRun.shouldWelcome(welcomed: false, lastFile: nil, openFiles: [], env: env), "a fresh install")
        check(!FirstRun.shouldWelcome(welcomed: true, lastFile: nil, openFiles: [], env: env), "welcomed once")
        check(!FirstRun.shouldWelcome(welcomed: false, lastFile: "/a.canvas", openFiles: [], env: env), "has opened a file")
        check(!FirstRun.shouldWelcome(welcomed: false, lastFile: nil, openFiles: ["/a.canvas"], env: env), "has tabs")
        check(!FirstRun.shouldWelcome(welcomed: false, lastFile: nil, openFiles: [], env: ["CANVAS_QA": "1"]), "QA instances start empty")
        check(FirstRun.shouldWelcome(welcomed: false, lastFile: nil, openFiles: [], env: ["CANVAS_QA": "1", "CANVAS_QA_FIRST_RUN": "1"]), "unless a scenario asks for the first launch")
        check(FirstRun.marksWelcomed(lastFile: "/a.canvas", openFiles: [], env: env) && !FirstRun.marksWelcomed(lastFile: nil, openFiles: [], env: ["CANVAS_QA": "1"]), "an existing user is marked welcomed; a QA instance is not")
    }

    // Right-click an overridden property in the panel (Fill, Stroke, Opacity, the text fields) and Reset it.
    static func fieldResets() {
        typealias O = OverrideLabels
        func items(_ s: O.Section, _ k: [String]) -> String { O.resetItems(s, overrides: k).map { "\($0.title)=\($0.keys.joined(separator: "+"))" }.joined(separator: ", ") }
        check(items(.fill, ["fill", "opacity"]) == "Reset fill=fill", items(.fill, ["fill", "opacity"]))
        check(items(.fill, ["opacity", "descendants"]) == "", "no fill override, no item")
        check(items(.stroke, ["strokeWidth", "stroke", "strokeAlignment"]) == "Reset stroke=stroke+strokeWidth+strokeAlignment", items(.stroke, ["strokeWidth", "stroke", "strokeAlignment"]))
        check(items(.stroke, ["strokeWidth"]) == "Reset stroke=strokeWidth", "a width alone is the stroke's")
        check(items(.effects, ["effect"]) == "Reset effects=effect", "effects")
        check(items(.appearance, ["fill", "cornerRadius", "opacity"]) == "Reset opacity=opacity, Reset corner radius=cornerRadius", items(.appearance, ["fill", "cornerRadius", "opacity"]))
        check(items(.appearance, []) == "", "nothing overridden")
        check(items(.typography, ["content", "fontWeight", "fontSize", "letterSpacing"]) == "Reset font size=fontSize, Reset font weight=fontWeight, Reset letter spacing=letterSpacing", items(.typography, ["content", "fontWeight", "fontSize", "letterSpacing"]))
        check(items(.typography, ["fontFamily", "lineHeight", "textAlign"]) == "Reset font=fontFamily, Reset line height=lineHeight, Reset text align=textAlign", items(.typography, ["fontFamily", "lineHeight", "textAlign"]))
    }

    // Updates (AppUpdate): the manifest, where the zip may come from, which release this Mac takes.
    static func updateManifest() {
        let good = #"{"latest":{"version":"0.1.2","file":"Canvas-0.1.2-2c4b1469.zip","size":53617915,"sha256":"2c4b1469e6f8098037c6445984c117099f2f9907103a3c4abc99161367825ca7","minimumSystemVersion":"26.0","arch":["arm64"]}}"#
        let r = AppUpdate.parse(Data(good.utf8))
        check(r == AppUpdate.Release(version: "0.1.2", file: "Canvas-0.1.2-2c4b1469.zip", size: 53617915, sha256: "2c4b1469e6f8098037c6445984c117099f2f9907103a3c4abc99161367825ca7", minimumSystemVersion: "26.0", arch: ["arm64"]), "the manifest's latest release: \(String(describing: r))")
        func with(_ key: String, _ value: String) -> AppUpdate.Release? {
            var j = try! JSONSerialization.jsonObject(with: Data(good.utf8)) as! [String: Any]
            var l = j["latest"] as! [String: Any]
            l[key] = value == "<none>" ? nil : (try? JSONSerialization.jsonObject(with: Data(value.utf8), options: .fragmentsAllowed))
            j["latest"] = l
            return AppUpdate.parse(try! JSONSerialization.data(withJSONObject: j))
        }
        for f in [#""../Canvas-0.1.2.zip""#, #""Canvas-0.1.2.zip/../x.zip""#, #""dl/Canvas-0.1.2.zip""#, #""Canvas-0.1.2.dmg""#, #""Other-0.1.2.zip""#, #""Canvas-0.1.2%2F.zip""#, #""Canvas-0.1.2 .zip""#, #""Canvas-..zip""#, "7", "<none>"] {
            check(with("file", f) == nil, "a file name outside the pattern is refused: \(f)")
        }
        check(with("sha256", #""2C4B""#) == nil && with("sha256", #""zz4b1469e6f8098037c6445984c117099f2f9907103a3c4abc99161367825ca7""#) == nil && with("sha256", "<none>") == nil, "a SHA-256 is 64 hex digits")
        check(with("size", "0") == nil && with("size", "-5") == nil && with("size", #""53617915""#) == nil && with("size", "3000000000") == nil, "a size is a positive number under 2 GB")
        check(with("version", #""0.1.2; rm -rf""#) == nil && with("minimumSystemVersion", #""twenty-six""#) == nil, "version and minimum macOS in their shapes")
        check(with("arch", "<none>")?.arch == [], "no arch list: any Mac")
        check(AppUpdate.parse(Data("{}".utf8)) == nil && AppUpdate.parse(Data("nope".utf8)) == nil, "no release, or garbage")

        // Where it comes from: the website over https, or a local test server only when the override says so.
        let site = AppUpdate.manifestSource(env: [:])
        check(site.url.absoluteString == "https://getcanvas.cc/releases.json" && !site.localTest, "the website by default")
        let local = AppUpdate.manifestSource(env: ["CANVAS_UPDATE_MANIFEST": "http://127.0.0.1:8765/releases.json"])
        check(local.url.absoluteString == "http://127.0.0.1:8765/releases.json" && local.localTest, "a local test manifest")
        for bad in ["https://evil.example/releases.json", "http://localhost:8765/releases.json", "http://127.0.0.1.evil.example/r.json", "https://127.0.0.1:8765/r.json",
                    "file:///tmp/r.json", "http://user@127.0.0.1:8765/r.json", "http://10.0.0.1/r.json", "http://127.0.0.1:8765@evil.example/r.json"] {
            let s = AppUpdate.manifestSource(env: ["CANVAS_UPDATE_MANIFEST": bad])
            check(s.url.absoluteString == "https://getcanvas.cc/releases.json" && !s.localTest, "an override that is not http://127.0.0.1 is ignored: \(bad)")
        }
        check(AppUpdate.downloadURL(manifest: site.url, file: "Canvas-0.1.2-2c4b1469.zip")?.absoluteString == "https://getcanvas.cc/download/Canvas-0.1.2-2c4b1469.zip", "the zip on the website")
        check(AppUpdate.downloadURL(manifest: local.url, file: "Canvas-0.1.2.zip")?.absoluteString == "http://127.0.0.1:8765/download/Canvas-0.1.2.zip", "the zip on the local test server")
        check(AppUpdate.downloadURL(manifest: URL(string: "http://getcanvas.cc/releases.json")!, file: "Canvas-0.1.2.zip") == nil, "never over http from the website")
        check(AppUpdate.downloadURL(manifest: URL(string: "https://getcanvas.cc.evil.example/releases.json")!, file: "Canvas-0.1.2.zip") == nil, "never another host")
        check(AppUpdate.downloadURL(manifest: URL(string: "http://localhost:8765/releases.json")!, file: "Canvas-0.1.2.zip") == nil, "never another local name")
        check(AppUpdate.downloadURL(manifest: site.url, file: "../Canvas-0.1.2.zip") == nil, "never a path out of /download")

        // Which release this Mac takes: newer, a macOS it meets, its architecture.
        let os26 = OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0)
        let os27 = OperatingSystemVersion(majorVersion: 27, minorVersion: 0, patchVersion: 1)
        check(AppUpdate.meetsMinimum("26.0", os: os26) && AppUpdate.meetsMinimum("26", os: os27) && AppUpdate.meetsMinimum("27.0.1", os: os27), "the minimum met")
        check(!AppUpdate.meetsMinimum("26.1", os: os26) && !AppUpdate.meetsMinimum("27.0.2", os: os27) && !AppUpdate.meetsMinimum("28.0", os: os27), "the minimum not met")
        let rel = r!
        check(AppUpdate.offers(rel, current: "0.1.1", os: os26, arch: "arm64"), "0.1.2 over 0.1.1 on macOS 26, Apple silicon")
        check(!AppUpdate.offers(rel, current: "0.1.2", os: os26, arch: "arm64") && !AppUpdate.offers(rel, current: "0.2.0", os: os26, arch: "arm64"), "not the same or an older version")
        check(!AppUpdate.offers(rel, current: "0.1.1", os: os26, arch: "x86_64"), "not another architecture")
        let later = AppUpdate.Release(version: "0.1.2", file: rel.file, size: rel.size, sha256: rel.sha256, minimumSystemVersion: "28.0", arch: [])
        check(!AppUpdate.offers(later, current: "0.1.1", os: os27, arch: "arm64"), "not a release that needs a newer macOS")
        check(AppUpdate.offers(AppUpdate.Release(version: "0.1.2", file: rel.file, size: rel.size, sha256: rel.sha256, minimumSystemVersion: "26.0", arch: []), current: "0.1.1", os: os26, arch: "x86_64"), "no arch list: any Mac")

        // The Canvas menu: Check for Updates always, Restart to Update (shown while one is ready).
        let app = MenuSpec.app.compactMap { $0 }
        check(app.contains { $0.title == "Check for Updates\u{2026}" && $0.command == "checkForUpdates" } && app.contains { $0.title == "Restart to Update" && $0.command == "restartToUpdate" }, "Canvas menu items")
    }

    // The checks before anything is replaced: each failure refuses with its own reason, the first one that failed.
    static func updateVerdict() {
        let rel = AppUpdate.Release(version: "0.1.2", file: "Canvas-0.1.2.zip", size: 100, sha256: String(repeating: "a", count: 64), minimumSystemVersion: "26.0", arch: ["arm64"])
        let own = AppUpdate.Own(version: "0.1.1", bundleID: "cc.getcanvas.canvas", teamID: "TEAM123456")
        let ok = AppUpdate.Facts(size: 100, sha256: String(repeating: "a", count: 64), unzipped: true, apps: ["Canvas.app"], bundleID: "cc.getcanvas.canvas",
                                 version: "0.1.2", signatureValid: true, teamID: "TEAM123456", gatekeeper: true)
        func v(_ change: (inout AppUpdate.Facts) -> Void, own o: AppUpdate.Own = own, local: Bool = false) -> AppUpdate.Verdict {
            var f = ok; change(&f); return AppUpdate.verdict(f, release: rel, own: o, localTest: local)
        }
        func refused(_ verdict: AppUpdate.Verdict, _ words: String) -> Bool {
            if case .refuse(let why) = verdict { return why.contains(words) }
            return false
        }
        check(v { _ in } == .install, "every check passed: install")
        check(refused(v({ _ in }, own: AppUpdate.Own(version: "0.1.1", bundleID: "cc.getcanvas.canvas", teamID: nil)), "Developer ID"), "an ad-hoc or unsigned running app never updates itself")
        check(refused(v { $0.size = 99 }, "size"), "size differs")
        check(refused(v { $0.size = nil }, "size"), "nothing downloaded")
        check(refused(v { $0.sha256 = String(repeating: "b", count: 64) }, "SHA-256"), "checksum differs")
        check(v { $0.sha256 = String(repeating: "A", count: 64) } == .install, "the checksum compares without case")
        check(refused(v { $0.unzipped = false }, "unzip"), "would not unzip")
        check(refused(v { $0.apps = [] }, "one Canvas.app"), "no app in the zip")
        check(refused(v { $0.apps = ["Canvas.app", "Other.app"] }, "one Canvas.app"), "two apps in the zip")
        check(refused(v { $0.apps = ["Evil.app"] }, "one Canvas.app"), "another app's name")
        check(refused(v { $0.bundleID = "com.example.other" }, "not Canvas"), "another bundle id")
        check(refused(v { $0.bundleID = nil }, "not Canvas"), "no bundle id")
        check(refused(v { $0.version = "0.1.3" }, "0.1.3"), "a version other than the manifest's")
        check(refused(v({ _ in }, own: AppUpdate.Own(version: "0.1.2", bundleID: own.bundleID, teamID: own.teamID)), "not newer"), "not newer than this app")
        check(refused(v { $0.signatureValid = false }, "signature"), "a signature that does not verify")
        check(refused(v { $0.signatureValid = nil }, "signature"), "a signature not checked")
        check(refused(v { $0.teamID = "OTHER12345" }, "different developer"), "another team")
        check(refused(v { $0.teamID = nil }, "different developer"), "no team (ad-hoc)")
        check(refused(v { $0.gatekeeper = false }, "Gatekeeper"), "Gatekeeper rejects it")
        check(refused(v { $0.gatekeeper = nil }, "Gatekeeper"), "Gatekeeper not asked")
        check(v({ $0.gatekeeper = false }, local: true) == .install, "the local test skips only Gatekeeper")
        check(refused(v({ $0.teamID = "OTHER12345" }, local: true), "different developer") && refused(v({ $0.sha256 = String(repeating: "b", count: 64) }, local: true), "SHA-256"), "the local test still checks everything else")
        check(refused(v { $0.size = 99; $0.teamID = nil }, "size"), "the first failure is the reason")
    }

    // Where the app can replace itself, and where it opens the download page instead.
    static func updateInstall() {
        check(AppUpdate.installMode(bundlePath: "/Applications/Canvas.app", folderWritable: true, bundleWritable: true) == .swap, "Applications, writable: swap")
        if case .manual(let why) = AppUpdate.installMode(bundlePath: "/Applications/Canvas.app", folderWritable: false, bundleWritable: true) {
            check(why.contains("Applications"), "names the folder: \(why)")
        } else { check(false, "a folder this account cannot change: the download page") }
        check(AppUpdate.installMode(bundlePath: "/Applications/Canvas.app", folderWritable: true, bundleWritable: false) != .swap, "an app this account cannot change: the download page")
        if case .manual(let why) = AppUpdate.installMode(bundlePath: "/private/var/folders/x/T/AppTranslocation/ABC/d/Canvas.app", folderWritable: true, bundleWritable: true) {
            check(why.contains("Applications"), "translocated: move it to Applications: \(why)")
        } else { check(false, "a translocated app cannot replace itself") }
    }

    // The helper that swaps the app after it quits: quoted paths, the rollback, the relaunch.
    static func updateHelper() {
        check(AppUpdate.shQuote("/a b/it's") == #"'/a b/it'\''s'"#, "single quotes, an apostrophe closed and reopened")
        let s = AppUpdate.helperScript(pid: 4242, app: "/Users/x/My Apps/Canvas.app", staged: "/Users/x/Library/Caches/c/Updates/0.1.2/u 1/Canvas.app",
                                       stagingRoot: "/Users/x/Library/Caches/c/Updates", log: "/Users/x/Library/Logs/Canvas/update.log",
                                       relaunch: true, env: [("CANVAS_PORT", "5300"), ("CANVAS_STATE_DIR", "/tmp/s t")])
        check(s.hasPrefix("#!/bin/sh\n"), "a /bin/sh script")
        check(s.contains("PID=4242\n"), "waits for this pid")
        check(s.contains(#"APP='/Users/x/My Apps/Canvas.app'"#) && s.contains(#"NEW='/Users/x/Library/Caches/c/Updates/0.1.2/u 1/Canvas.app'"#), "paths with spaces quoted")
        check(s.contains(#"TMP='/Users/x/My Apps/.Canvas.app.update-4242'"#) && s.contains(#"BAK='/Users/x/My Apps/.Canvas.app.previous-4242'"#), "the new app is copied next to the old one first, the old one moves aside there")
        check(s.contains(#"while kill -0 "$PID""#), "waits for the old app to exit")
        check(s.contains(#"/usr/bin/ditto "$NEW" "$TMP""#), "copies with ditto (keeps the signature)")
        check(s.contains(#"/bin/mv "$APP" "$BAK""#) && s.contains(#"/bin/mv "$TMP" "$APP""#), "old aside, new in")
        check(s.contains(#"/bin/mv "$BAK" "$APP""#), "a failed move puts the old app back")
        check(s.contains(#"/usr/bin/xattr -dr com.apple.quarantine "$APP""#), "clears quarantine")
        check(s.contains(#"/usr/bin/open --env 'CANVAS_PORT=5300' --env 'CANVAS_STATE_DIR=/tmp/s t' "$APP""#), "relaunches with the app's own overrides: \(s)")
        let noRelaunch = AppUpdate.helperScript(pid: 1, app: "/Applications/Canvas.app", staged: "/c/Canvas.app", stagingRoot: "/c", log: "/l", relaunch: false, env: [])
        check(noRelaunch.contains("RELAUNCH=0") && s.contains("RELAUNCH=1"), "install on quit does not relaunch")
        // The script itself: run it against folders with spaces, a pid that has exited, and a copy that fails.
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("canvas-helper-test \(getpid())")
        try? fm.removeItem(at: root)
        let apps = root.appendingPathComponent("My Apps"), staging = root.appendingPathComponent("Caches dir/Updates")
        func makeApp(_ dir: URL, _ marker: String) {
            try? fm.createDirectory(at: dir.appendingPathComponent("Canvas.app/Contents"), withIntermediateDirectories: true)
            try? marker.write(to: dir.appendingPathComponent("Canvas.app/Contents/marker"), atomically: true, encoding: .utf8)
        }
        makeApp(apps, "old"); makeApp(staging.appendingPathComponent("0.1.2/u 1"), "new")
        let log = root.appendingPathComponent("update.log")
        func run(_ script: String) -> Int32 {
            let f = root.appendingPathComponent("helper.sh")
            try? script.write(to: f, atomically: true, encoding: .utf8)
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh"); p.arguments = [f.path]
            p.standardError = FileHandle.nullDevice
            try? p.run(); p.waitUntilExit(); return p.terminationStatus
        }
        func marker() -> String? { try? String(contentsOf: apps.appendingPathComponent("Canvas.app/Contents/marker"), encoding: .utf8) }
        func beside() -> [String] { ((try? fm.contentsOfDirectory(atPath: apps.path)) ?? []).sorted() }
        let app = apps.appendingPathComponent("Canvas.app").path
        // A staged app that is not there: the copy fails, the old app stays where it was.
        let broken = AppUpdate.helperScript(pid: 999_999, app: app, staged: staging.appendingPathComponent("missing/Canvas.app").path, stagingRoot: staging.path, log: log.path, relaunch: false, env: [])
        check(run(broken) != 0 && marker() == "old", "a failed copy keeps the old app")
        check(beside() == ["Canvas.app"], "and leaves nothing beside it: \(beside())")
        // The new app cannot move in (a file is in the way of the copy's name): the old one goes back.
        let blocker = apps.appendingPathComponent(".Canvas.app.update-999999")
        let staged = staging.appendingPathComponent("0.1.2/u 1/Canvas.app").path
        try? fm.createDirectory(at: blocker, withIntermediateDirectories: true)
        try? "x".write(to: blocker.appendingPathComponent("locked"), atomically: true, encoding: .utf8)
        _ = chmod(blocker.path, 0o500)
        check(run(AppUpdate.helperScript(pid: 999_999, app: app, staged: staged, stagingRoot: staging.path, log: log.path, relaunch: false, env: [])) != 0 && marker() == "old", "a copy that cannot be made keeps the old app")
        _ = chmod(blocker.path, 0o700); try? fm.removeItem(at: blocker)
        let good = AppUpdate.helperScript(pid: 999_999, app: app, staged: staged, stagingRoot: staging.path, log: log.path, relaunch: false, env: [])
        check(run(good) == 0 && marker() == "new", "the new app in the old one's place")
        check(beside() == ["Canvas.app"], "no copy or backup left beside it: \(beside())")
        check(!fm.fileExists(atPath: staging.path), "the staged download is gone")
        check(((try? String(contentsOf: log, encoding: .utf8)) ?? "").contains("installed"), "the log says so")
        try? fm.removeItem(at: root)
    }
}
