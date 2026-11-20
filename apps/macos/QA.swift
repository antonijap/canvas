// Native QA input (pnpm qa:native). Compiled only into a QA build (`QA=1 apps/macos/build.sh` adds -D CANVAS_QA);
// the normal app has none of this. The server forwards `qa.*` bridge ops to the shell only when it runs with
// CANVAS_QA=1, and the shell answers them here.
//
// Input normally uses NSEvents in this app's queue. qa.drag with system:true posts HID events through the
// window server instead. In-app events pass through local monitors, menu key equivalents and window dispatch
// without moving the system cursor. System mode needs input-posting permission and briefly fronts its window.
//
// Three things would reach outside the app, so a QA build keeps them in:
// - System drag and drop (SwiftUI .onDrag) hands the drag to the window server, which follows the real cursor and
//   drops on whatever window is under it. Here the drag manager's entry point starts a virtual session instead
//   (VirtualDrag): the posted mouse moves drive it, and the view under the point gets draggingEntered/Updated/
//   perform with a private, uniquely named pasteboard.
// - A shown menu takes the whole screen's mouse and floats over every app. Here menus are held, not drawn
//   (virtualMenus): the click that opens one is real, qa.menu runs the item's own action.
// - Activation takes the keyboard from whoever is typing. The app never activates itself (it is an accessory app,
//   launched in the background); posted events reach it without being active.
// NSEvent.pressedMouseButtons, mouseLocation and modifierFlags answer the posted input, not the person's hardware.
//
// Coordinates are window points with the origin at the window's top left (y down), like the screenshots.
#if CANVAS_QA
import AppKit
import ObjectiveC
import SwiftUI
import WebKit
import UniformTypeIdentifiers
import ImageIO
import Vision
import CoreML

typealias QAError = BridgeClient.BridgeError

@MainActor
enum QA {
    static var cloudUsage: [String: Any]?
    static var model: CanvasModel!
    static var window: NSWindow!
    static var tabRenameFile: () -> String? = { nil }
    private static var tabRenameEvents: [[String: Any]] = []
    static func recordTabRename(_ event: String, _ detail: String) {
        tabRenameEvents.append(["event": event, "detail": detail, "time": Date.timeIntervalSinceReferenceDate])
        if tabRenameEvents.count > 40 { tabRenameEvents.removeFirst(tabRenameEvents.count - 40) }
    }
    private static var eventNumber = 1000
    /// The modifier keys "held" by the last key op, so mouse events carry them too.
    private static var heldMods: NSEvent.ModifierFlags = []
    private static var last = NSPoint.zero
    private static var installed = false

    /// Called once at launch: no self-activation, no App Nap, the page keeps drawing when the window is covered.
    static func install(model: CanvasModel, window: NSWindow) {
        self.model = model
        self.window = window
        // Copy, Paste and Copy Link go to this instance's own pasteboard, never the person's clipboard (qa.pasteboard).
        canvasPasteboard = NSPasteboard(name: NSPasteboard.Name("cc.getcanvas.canvas.qa.\(ProcessInfo.processInfo.processIdentifier)"))
        // No Dock icon, no menu bar of its own, never activated at launch: the person keeps their focus.
        NSApp.setActivationPolicy(.accessory)
        guard !installed else { return }
        installed = true
        swizzle(NSApplication.self, #selector(NSApplication.activate(ignoringOtherApps:)), #selector(NSApplication.qa_activate(ignoringOtherApps:)))
        swizzle(NSApplication.self, NSSelectorFromString("activate"), #selector(NSApplication.qa_activateCooperatively))
        swizzle(NSView.self, #selector(NSView.beginDraggingSession(with:event:source:)), #selector(NSView.qa_beginDraggingSession(with:event:source:)))
        // A save or open panel is the system's own window: it would come to the front and wait for the person. A QA
        // instance notes its title (qa.state panels) and answers Cancel.
        swizzle(NSSavePanel.self, #selector(NSSavePanel.runModal), #selector(NSSavePanel.qa_runModal))
        // Hide Canvas (Cmd+H) and Hide Others: counted (qa.state hides), never done. An accessory app cannot hide,
        // and Hide Others would hide the person's apps.
        swizzle(NSApplication.self, #selector(NSApplication.hide(_:)), #selector(NSApplication.qa_hide(_:)))
        swizzle(NSApplication.self, #selector(NSApplication.hideOtherApplications(_:)), #selector(NSApplication.qa_hideOthers(_:)))
        // An accessory app's Hide items are disabled; the real app's are not, so a QA instance enables them too.
        if class_getInstanceMethod(NSApplication.self, NSSelectorFromString("validateMenuItem:")) != nil {
            swizzle(NSApplication.self, NSSelectorFromString("validateMenuItem:"), #selector(NSApplication.qa_validateMenuItem(_:)))
        }
        if class_getInstanceMethod(NSApplication.self, NSSelectorFromString("validateUserInterfaceItem:")) != nil {
            swizzle(NSApplication.self, NSSelectorFromString("validateUserInterfaceItem:"), #selector(NSApplication.qa_validateUserInterfaceItem(_:)))
        }
        // The window of a QA instance is never key (it never activates), and WKWebView takes a first click in a window
        // that is not key as the click that focuses it: the page never saw the canvas's own presses and drags.
        swizzle(WKWebView.self, #selector(NSView.acceptsFirstMouse(for:)), #selector(NSView.qa_acceptsFirstMouse(for:)))
        // Native fields must use this instance's clipboard too, including invite links pasted into a sheet.
        swizzle(NSTextView.self, #selector(NSText.paste(_:)), #selector(NSTextView.qa_paste(_:)))
        // SwiftUI's .onDrag goes straight to the drag manager (gesture-driven), not through NSView: that entry
        // point, on every manager class that has it, starts the virtual session too.
        typealias Begin = @convention(block) (AnyObject, NSArray, NSWindow?, NSRect, NSEvent?, AnyObject?, AnyObject) -> AnyObject
        let begin: Begin = { _, items, win, _, _, gesture, source in
            MainActor.assumeIsolated {
                let w: NSWindow = win ?? QA.window
                let v = VirtualDrag(items: items.compactMap { $0 as? NSDraggingItem }, source: source as! NSDraggingSource, view: w.contentView!)
                v.gesture = gesture as? NSGestureRecognizer
                VirtualDrag.current = v
                return v.session
            }
        }
        for name in ["NSCoreDragManager", "_NSDragManager"] {
            if let cls = NSClassFromString(name), let m = class_getInstanceMethod(cls, NSSelectorFromString("beginDraggingSessionWithItems:fromWindow:withClipRect:event:gesture:source:")) {
                method_setImplementation(m, imp_implementationWithBlock(begin))
            }
        }
        // The person's real mouse and keys never reach a QA instance's checks: the posted ones do.
        QAPointer.location = window.convertPoint(toScreen: NSPoint(x: window.frame.width / 2, y: window.frame.height / 2))
        swizzleClass(NSEvent.self, #selector(getter: NSEvent.pressedMouseButtons), #selector(getter: NSEvent.qa_pressedMouseButtons))
        swizzleClass(NSEvent.self, #selector(getter: NSEvent.mouseLocation), #selector(getter: NSEvent.qa_mouseLocation))
        swizzleClass(NSEvent.self, #selector(getter: NSEvent.modifierFlags), #selector(getter: NSEvent.qa_modifierFlags))
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical, .idleSystemSleepDisabled], reason: "Canvas QA")
        UserDefaults.standard.set(true, forKey: "NSAppSleepDisabled")
        keepPageAwake(model.webView)
        watchMenus()
        virtualMenus()
    }
    private static var activity: NSObjectProtocol?
    /// Save and open panels asked for since the last qa.reset, by title (none is shown: NSSavePanel.qa_runModal).
    static var panels: [String] = []
    /// Hide Canvas ("app") and Hide Others ("others") asked for since the last qa.reset (NSApplication.qa_hide).
    static var hides: [String] = []
    /// The menu being tracked (a pop-up, a context menu, a SwiftUI Menu), from NSMenu's own notifications.
    static var openMenu: NSMenu?
    /// The folder export-with-settings writes to in a QA run (qa.exportdir), instead of asking.
    static var exportFolder: String?

    /// A shown menu takes the whole screen's mouse (a click anywhere, in any app, only closes it) and floats above
    /// every window. A QA instance must not do that to the person at the Mac, so its pop-up and context menus are
    /// not drawn: the menu a click opened is held open here, its items listed by qa.state and picked by qa.menu,
    /// which runs the item's own action, as a click on it would.
    static func virtualMenus() {
        typealias Present = @convention(c) (AnyObject, Selector, AnyObject?, AnyObject?, AnyObject?, Bool, Bool, AnyObject?) -> Void
        let sel = NSSelectorFromString("presentPopup:fromView:withContext:animated:async:completionBlock:")
        guard let cls = NSClassFromString("NSContextMenuImpl"), let meta = object_getClass(cls), let m = class_getInstanceMethod(meta, sel) else {
            NSLog("canvas qa: no NSContextMenuImpl presentPopup; menus will be shown")
            return
        }
        let orig = unsafeBitCast(method_getImplementation(m), to: Present.self)
        let block: @convention(block) (AnyObject, AnyObject?, AnyObject?, AnyObject?, Bool, Bool, AnyObject?) -> Void = { me, popup, view, ctx, anim, async, done in
            guard let menu = (popup as? NSObject)?.value(forKey: "_menu") as? NSMenu else {
                orig(me, sel, popup, view, ctx, anim, async, done)
                return
            }
            MainActor.assumeIsolated {
                if let old = openMenu, old !== menu { closeMenu(old) }
                openMenu = menu
                menuCompletion = done
                menu.delegate?.menuWillOpen?(menu)
                menu.update()
            }
        }
        method_setImplementation(m, imp_implementationWithBlock(block))
    }
    private static var menuCompletion: AnyObject?

    static func closeMenu(_ m: NSMenu) {
        if openMenu === m { openMenu = nil }
        m.delegate?.menuDidClose?(m)
        if let done = menuCompletion {
            menuCompletion = nil
            typealias Done = @convention(block) () -> Void
            unsafeBitCast(done, to: Done.self)()
        }
        m.cancelTracking()
    }

    /// {pick?: an item's title (or the start of it)} picks it; {cancel: true} closes the menu. Answers the items.
    private static func menuOp(_ a: [String: Any]) throws -> [String: Any] {
        guard let m = openMenu else { throw QAError(code: "not_found", message: "no menu is open") }
        let items = m.items.filter { !$0.isSeparatorItem && !$0.isHidden }
        let list = items.map { ["title": $0.title, "enabled": $0.isEnabled, "on": $0.state == .on] as [String: Any] }
        if a["cancel"] as? Bool == true { closeMenu(m); return ["items": list, "closed": true] }
        // {sub: "Copy as"}: that submenu's items. {pick: "Copy as > Copy as SVG"}: an item in a submenu.
        if let sub = a["sub"] as? String {
            guard let s = items.first(where: { $0.title == sub })?.submenu else { throw QAError(code: "not_found", message: "the menu has no submenu \(sub)") }
            s.update()
            return ["items": s.items.filter { !$0.isSeparatorItem && !$0.isHidden }.map { ["title": $0.title, "enabled": $0.isEnabled, "on": $0.state == .on, "key": $0.keyEquivalent] as [String: Any] }]
        }
        guard let want = a["pick"] as? String else { return ["items": list] }
        var path = want.components(separatedBy: " > ")
        var menu = m
        var pool = items
        while path.count > 1 {
            let head = path.removeFirst()
            guard let s = pool.first(where: { $0.title == head })?.submenu else { throw QAError(code: "not_found", message: "the menu has no submenu \(head)") }
            s.update()
            menu = s
            pool = s.items.filter { !$0.isSeparatorItem && !$0.isHidden }
        }
        let leaf = path[0]
        guard let item = pool.first(where: { $0.title == leaf }) ?? pool.first(where: { $0.title.hasPrefix(leaf) }) else {
            throw QAError(code: "not_found", message: "the menu has no \(want) (\(pool.map(\.title).joined(separator: ", ")))")
        }
        guard item.isEnabled else { throw QAError(code: "invalid", message: "\(item.title) is disabled") }
        let i = menu.index(of: item)
        closeMenu(m)
        menu.performActionForItem(at: i)
        return ["items": list, "picked": item.title]
    }
    private static var menuObservers: [NSObjectProtocol] = []
    static func watchMenus() {
        menuObservers.append(NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { n in
            MainActor.assumeIsolated { if let m = n.object as? NSMenu, m.supermenu == nil || openMenu == nil { openMenu = m } }
        })
        menuObservers.append(NotificationCenter.default.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { n in
            MainActor.assumeIsolated { if (n.object as? NSMenu) === openMenu { openMenu = nil } }
        })
    }

    /// WebKit stops drawing a page whose window is covered; a QA window often is.
    static func keepPageAwake(_ wv: WKWebView) {
        let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if wv.responds(to: sel) { wv.perform(sel, with: false) }
    }

    private static func swizzleClass(_ cls: AnyClass, _ a: Selector, _ b: Selector) {
        guard let m1 = class_getClassMethod(cls, a), let m2 = class_getClassMethod(cls, b) else { NSLog("canvas qa: no class method \(a)"); return }
        method_exchangeImplementations(m1, m2)
    }
    private static func swizzle(_ cls: AnyClass, _ a: Selector, _ b: Selector) {
        guard let m1 = class_getInstanceMethod(cls, a), let m2 = class_getInstanceMethod(cls, b) else { NSLog("canvas qa: no method \(a)"); return }
        method_exchangeImplementations(m1, m2)
    }

    // MARK: ops

    static func run(_ op: String, _ a: [String: Any]) async throws -> [String: Any] {
        switch op {
        case "qa.ping": return ["qa": true, "pid": Int(ProcessInfo.processInfo.processIdentifier)]
        case "qa.window": return try windowOp(a)
        case "qa.mouse": return try await mouse(a)
        case "qa.drag": return try await drag(a)
        case "qa.files": return try await dragFiles(a)
        case "qa.scroll": return try await scroll(a)
        case "qa.key": return try await key(a)
        case "qa.type": return try await typeText(a)
        case "qa.state": return state()
        case "qa.views": return try views(a)
        case "qa.marks": return try marks(a)
        case "qa.find": return try await find(a)
        case "qa.shot": return try await shot(a)
        case "qa.js": return try await js(a)
        case "qa.pixels": return try await pixels(a)
        case "qa.menu": return try menuOp(a)
        case "qa.paint":
            // What the next image picker and eyedropper answer (PaintEditor.swift PaintHooks): {image?: path, sample?: "#RRGGBB"}.
            if let p = a["image"] as? String { PaintHooks.nextImage = URL(fileURLWithPath: p) }
            if let c = a["sample"] as? String { PaintHooks.nextSample = c }
            // {delay: seconds}: an image upload's and a Selection colors write's answer is held that long (fault injection).
            if let d = (a["delay"] as? NSNumber)?.doubleValue { PaintHooks.answerDelay = max(0, min(d, 30)) }
            return ["image": PaintHooks.nextImage?.path ?? NSNull(), "sample": PaintHooks.nextSample ?? NSNull(), "delay": PaintHooks.answerDelay]
        case "qa.choose":
            // {files: [absolute paths]}: what the next open panel for Place Image picks (the panel is not shown).
            qaChosenFiles = (a["files"] as? [String]) ?? []
            return ["files": qaChosenFiles ?? []]
        case "qa.pasteboard":
            // The text on this instance's pasteboard (Copy, Copy Link, Copy as); {set} puts text there first. types and
            // strings: every type on it and its text (a Canvas copy holds its JSON under cc.getcanvas.canvas.clipboard).
            // Copy as PNG: pngInfo, the PNG's pixel size, and {pngTo: path} writes the PNG out for a look.
            if let s = a["set"] as? String { canvasPasteboard.clearContents(); canvasPasteboard.setString(s, forType: .string) }
            // {canvas: json}: a payload under Canvas's own type, as any app on the Mac could write one.
            if let s = a["canvas"] as? String { canvasPasteboard.clearContents(); canvasPasteboard.setString(s, forType: .canvasClipboard); canvasPasteboard.setString("From another app", forType: .string) }
            // {paint: json}: a paint under Canvas's paint type, as any app on the Mac could write one (Paste Fill reads it).
            if let s = a["paint"] as? String { canvasPasteboard.clearContents(); canvasPasteboard.setString(s, forType: PaintClipboard.paintType); canvasPasteboard.setString("From another app", forType: .string) }
            // {png: base64}: a picture for Cmd+V (a screenshot) instead.
            if let s = a["png"] as? String, let d = Data(base64Encoded: s) { canvasPasteboard.clearContents(); canvasPasteboard.setData(d, forType: .png) }
            var strings: [String: Any] = [:]
            for t in canvasPasteboard.types ?? [] { strings[t.rawValue] = canvasPasteboard.string(forType: t) ?? NSNull() }
            var out: [String: Any] = ["text": canvasPasteboard.string(forType: .string) ?? NSNull(), "types": (canvasPasteboard.types ?? []).map(\.rawValue), "strings": strings]
            if let png = canvasPasteboard.data(forType: .png), let rep = NSBitmapImageRep(data: png) {
                out["pngInfo"] = ["width": rep.pixelsWide, "height": rep.pixelsHigh, "bytes": png.count]
                if let p = a["pngTo"] as? String { try png.write(to: URL(fileURLWithPath: p)) }
            }
            return out
        case "qa.mainmenu":
            // A menu bar item by title: whether it is enabled now, its key, and with {perform: true} its action run.
            guard let title = a["title"] as? String else { throw QAError(code: "invalid", message: "qa.mainmenu needs title") }
            func find(_ m: NSMenu) -> (NSMenu, NSMenuItem)? {
                m.update()
                for i in m.items {
                    if i.title == title { return (m, i) }
                    if let s = i.submenu, let hit = find(s) { return hit }
                }
                return nil
            }
            guard let main = NSApp.mainMenu, let (menu, item) = find(main) else { throw QAError(code: "not_found", message: "no menu item \(title)") }
            let on = item.isEnabled
            if a["perform"] as? Bool == true, on { menu.performActionForItem(at: menu.index(of: item)) }
            return ["enabled": on, "key": item.keyEquivalent, "mods": item.keyEquivalentModifierMask.rawValue, "state": item.state == .on]
        case "qa.theme":
            // {theme: "light" | "dark" | "system"}: the app theme, as Settings > General sets it.
            if let t = (a["theme"] as? String).flatMap(AppTheme.init(rawValue:)) { model.theme = t }
            return ["theme": model.theme.rawValue]
        case "qa.agents":
            // {added: ["claude"]}: Settings > Agents shows these agents installed with Canvas added (Connected), as the
            // pane reads them from GET /api/mcp/setup; [] goes back to what this Mac has. No config file is touched.
            AgentsQA.added = Set((a["added"] as? [String] ?? []).filter { $0 == "claude" || $0 == "codex" })
            return ["added": AgentsQA.added.sorted()]
        case "qa.cloud":
            if a.keys.contains("usage") { cloudUsage = a["usage"] as? [String: Any] }
            // The Clouds, as Add Cloud and Settings > Cloud leave them:
            //   {clouds: [{url, name?, devEmail?, kind?}]}  the whole list ([] for none)
            //   {url, devEmail?, name?}                     one server Cloud as the only one ("" for none)
            //   {hosting}, {commentName}                    Host on this Mac's switch, the host's name (a placeholder)
            //   {select: id | null}                        the Cloud Settings > Cloud shows; {home: id} Home's page for it
            if let list = a["clouds"] as? [[String: Any]] {
                model.prefs.clouds = CloudList.clean(list.compactMap { c in
                    guard let u = c["url"] as? String else { return nil }
                    return CloudEntry(id: c["id"] as? String ?? UUID().uuidString, url: u, name: c["name"] as? String ?? "", devEmail: c["devEmail"] as? String ?? "",
                                      kind: (c["kind"] as? String).flatMap(CloudKind.init(rawValue:)) ?? .server, hosting: c["hosting"] as? Bool ?? false)
                })
            } else if let u = a["url"] as? String {
                model.prefs.clouds = u.isEmpty ? [] : CloudList.clean([CloudEntry(url: u, name: a["name"] as? String ?? "", devEmail: a["devEmail"] as? String ?? "", kind: .server)])
            } else if let n = a["name"] as? String, !model.prefs.clouds.isEmpty {
                model.prefs.clouds[0].name = n
            }
            if let h = a["hosting"] as? Bool { for i in model.prefs.clouds.indices where model.prefs.clouds[i].kind == .hosted { model.prefs.clouds[i].hosting = h } }
            // The name the host is shown by: a placeholder in QA, never the Mac's user name.
            if let c = a["commentName"] as? String { model.prefs.commentName = c }
            if a.keys.contains("select") { let id = a["select"] as? String; await MainActor.run { CloudAccount.shared.selected = id } }
            if let h = a["home"] as? String { await MainActor.run { HomeStore.shared.section = .cloud(h) } }
            let clouds = model.prefs.clouds.map { ["id": $0.id, "url": $0.url, "name": $0.name, "devEmail": $0.devEmail, "kind": $0.kind.rawValue] }
            return ["clouds": clouds, "url": model.prefs.clouds.first?.url ?? "", "rev": model.prefs.cloudsRev,
                    "states": await MainActor.run { CloudAccount.shared.states.mapValues { ["status": $0.status, "email": $0.email ?? ""] } }]
        case "qa.exportdir":
            // Shift+Cmd+E's folder: a QA instance never shows the open panel (it would be modal), it exports here.
            exportFolder = a["dir"] as? String
            return ["dir": exportFolder ?? NSNull()]
        case "qa.openurl":
            // A URL delivered to this instance in-process, as Launch Services would deliver a click on it. A QA build
            // has no URL schemes, so nothing outside the test can open one here, and the test never reaches the
            // person's Canvas.
            guard let s = a["url"] as? String, let url = URL(string: s) else { throw QAError(code: "invalid", message: "qa.openurl needs url") }
            NSApp.delegate?.application?(NSApp, open: [url])
            return ["opened": s]
        case "qa.reset":
            // Between scenarios: nothing left open or held from the last one.
            VirtualDrag.current = nil
            PaintHooks.answerDelay = 0
            AgentsQA.added = []
            UserDefaults.standard.set(false, forKey: BindQA.key)
            panels = []
            hides = []
            heldMods = []
            QAPointer.buttons = 0
            QAPointer.mods = []; syncDragCommand()
            if let m = openMenu { closeMenu(m) }
            if PaletteController.shared.isOpen { PaletteController.shared.close(refocus: false) }
            model.zoomFieldOpen = false
            await MainActor.run { AddCloudPanel.shared.close() }
            // A comment name a scenario typed (a placeholder) goes back to the default: the Mac's full name.
            UserDefaults.standard.removeObject(forKey: AppSettings.prefix + "commentName")
            model.prefs.commentName = NSFullUserName()
            model.batchRename = nil
            LayersStore.of(model).renaming = nil
            // A sign-in opens Home on the team server; the next scenario starts on Recents again.
            HomeStore.shared.section = .recents
            HomeStore.shared.query = ""
            CloudAccount.shared.selected = nil
            SettingsWindow.shared.resetForQA()
            for w in NSApp.windows where w !== window && w.isVisible {
                if w.contentViewController is SettingsTabs || w.isSheet || w is NSPanel || w.title == "About Canvas" { w.orderOut(nil) }
            }
            window.makeFirstResponder(model.webView)
            try await sleep(100)
            return ["reset": true]
        case "qa.hoverbind":
            // Every numeric field shows its token button as if hovered (InspectorTokens.swift BindQA).
            UserDefaults.standard.set(a["on"] as? Bool ?? true, forKey: BindQA.key)
            try await sleep(150)
            return ["on": UserDefaults.standard.bool(forKey: BindQA.key)]
        case "qa.idle": try await idle(a); return ["idle": true]
        default: throw QAError(code: "unsupported", message: "no QA op \(op)")
        }
    }

    /// Which window an op aims at: "main" (default), "settings", or the key window ("key").
    private static func target(_ a: [String: Any]) throws -> NSWindow {
        switch a["window"] as? String ?? "main" {
        case "main": return window
        case "key": return NSApp.keyWindow ?? window
        case "modal":
            guard let w = NSApp.modalWindow else { throw QAError(code: "not_found", message: "no modal window") }
            return w
        case "popover":
            // A popover the inspector opened (the paint editor, the colour picker): its own window.
            guard let w = NSApp.windows.first(where: { $0.isVisible && String(describing: Swift.type(of: $0)).contains("Popover") }) else { throw QAError(code: "not_found", message: "no popover is open") }
            return w
        case "about":
            guard let w = NSApp.windows.first(where: { $0.isVisible && $0.title == "About Canvas" }) else { throw QAError(code: "not_found", message: "the About window is not open") }
            return w
        case "settings":
            guard let w = NSApp.windows.first(where: { $0.isVisible && $0.contentViewController is SettingsTabs }) else { throw QAError(code: "not_found", message: "the Settings window is not open") }
            return w
        case "popover":
            // An open popover (the zoom pill's field): made key inside this app, so its field takes the keys, as
            // a click on it does when the app is in front. The app itself still never activates.
            guard let w = NSApp.windows.first(where: { $0.isVisible && String(describing: Swift.type(of: $0)).contains("Popover") }) else { throw QAError(code: "not_found", message: "no popover is open") }
            if !w.isKeyWindow { w.makeKey() }
            return w
        case let other:
            guard let w = NSApp.windows.first(where: { $0.isVisible && $0.title == other }) else { throw QAError(code: "not_found", message: "no visible window titled \(other)") }
            return w
        }
    }

    private static func windowOp(_ a: [String: Any]) throws -> [String: Any] {
        if let w = a["width"] as? NSNumber, let h = a["height"] as? NSNumber {
            var f = window.frame
            let top = f.maxY
            f.size = NSSize(width: w.doubleValue, height: h.doubleValue)
            f.origin.y = top - f.height
            window.setFrame(f, display: true)
        }
        if a["key"] as? Bool == true { window.makeKeyAndOrderFront(nil) }
        return windowInfo(window)
    }

    private static func windowInfo(_ w: NSWindow) -> [String: Any] {
        ["x": w.frame.origin.x, "y": w.frame.origin.y, "width": w.frame.width, "height": w.frame.height, "scale": w.backingScaleFactor, "key": w.isKeyWindow,
         "keyWindow": NSApp.keyWindow?.title ?? NSNull(), "active": NSApp.isActive, "number": w.windowNumber,
         "firstResponder": w.firstResponder.map { String(describing: type(of: $0)) } ?? NSNull()]
    }

    // MARK: mouse

    private static func flags(_ a: [String: Any]) -> NSEvent.ModifierFlags {
        var f: NSEvent.ModifierFlags = heldMods
        let mods = (a["mods"] as? [String]) ?? []
        for m in mods {
            switch m {
            case "cmd", "meta": f.insert(.command)
            case "shift": f.insert(.shift)
            case "alt", "option": f.insert(.option)
            case "ctrl", "control": f.insert(.control)
            default: break
            }
        }
        return f
    }

    /// Top-left window points to AppKit window coordinates.
    private static func base(_ w: NSWindow, _ x: Double, _ y: Double) -> NSPoint { NSPoint(x: x, y: w.frame.height - y) }

    private static func point(_ a: [String: Any], _ k: String = "") -> (Double, Double)? {
        guard let x = a[k.isEmpty ? "x" : "\(k)X"] as? NSNumber ?? (a[k] as? [Any])?.first as? NSNumber,
              let y = a[k.isEmpty ? "y" : "\(k)Y"] as? NSNumber ?? (a[k] as? [Any])?.last as? NSNumber else { return nil }
        return (x.doubleValue, y.doubleValue)
    }

    private static func post(_ e: NSEvent?) {
        guard let e else { return }
        // The virtual pointer and keyboard follow what was posted (see QAPointer).
        if let w = e.window ?? NSApp.window(withWindowNumber: e.windowNumber) {
            switch e.type {
            case .leftMouseDown: QAPointer.buttons |= 1
            case .leftMouseUp: QAPointer.buttons &= ~1
            case .rightMouseDown: QAPointer.buttons |= 2
            case .rightMouseUp: QAPointer.buttons &= ~2
            default: break
            }
            if [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .mouseMoved].contains(e.type) {
                QAPointer.location = w.convertPoint(toScreen: e.locationInWindow)
            }
        }
        QAPointer.mods = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        NSApp.postEvent(e, atStart: false)
    }

    private static func mouseEvent(_ type: NSEvent.EventType, _ w: NSWindow, _ p: NSPoint, _ f: NSEvent.ModifierFlags, clicks: Int = 1, pressure: Float = 1) -> NSEvent? {
        eventNumber += 1
        return NSEvent.mouseEvent(with: type, location: p, modifierFlags: f, timestamp: ProcessInfo.processInfo.systemUptime,
                                  windowNumber: w.windowNumber, context: nil, eventNumber: eventNumber, clickCount: clicks, pressure: pressure)
    }

    static func sleep(_ ms: Double) async throws { try await Task.sleep(nanoseconds: UInt64(max(0, ms) * 1_000_000)) }

    /// {action: move|down|up|click|doubleClick|rightClick, x, y, mods?, clicks?, button?: left|right}
    private static func mouse(_ a: [String: Any]) async throws -> [String: Any] {
        let w = try target(a)
        guard let (x, y) = point(a) else { throw QAError(code: "invalid", message: "mouse needs x and y") }
        let p = base(w, x, y)
        let f = flags(a)
        let right = (a["button"] as? String) == "right"
        let action = a["action"] as? String ?? "click"
        let gap = (a["gapMs"] as? NSNumber)?.doubleValue ?? 40
        let down: NSEvent.EventType = right ? .rightMouseDown : .leftMouseDown
        let up: NSEvent.EventType = right ? .rightMouseUp : .leftMouseUp
        switch action {
        case "move":
            if let v = VirtualDrag.current { try await v.move(to: p, in: w) }
            else { post(mouseEvent(.mouseMoved, w, p, f, clicks: 0, pressure: 0)) }
        case "down":
            post(mouseEvent(down, w, p, f, clicks: (a["clicks"] as? NSNumber)?.intValue ?? 1))
        case "up":
            if let v = VirtualDrag.current { try await v.drop(at: p, in: w) }
            do { post(mouseEvent(up, w, p, f, clicks: (a["clicks"] as? NSNumber)?.intValue ?? 1, pressure: 0)) }
        case "click", "rightClick":
            let r = action == "rightClick" || right
            post(mouseEvent(.mouseMoved, w, p, f, clicks: 0, pressure: 0))
            post(mouseEvent(r ? .rightMouseDown : .leftMouseDown, w, p, f, clicks: 1))
            try await sleep(gap)
            post(mouseEvent(r ? .rightMouseUp : .leftMouseUp, w, p, f, clicks: 1, pressure: 0))
        case "doubleClick":
            post(mouseEvent(.mouseMoved, w, p, f, clicks: 0, pressure: 0))
            for c in 1...2 {
                post(mouseEvent(.leftMouseDown, w, p, f, clicks: c))
                try await sleep(30)
                post(mouseEvent(.leftMouseUp, w, p, f, clicks: c, pressure: 0))
                if c == 1 { try await sleep(60) }
            }
        default: throw QAError(code: "invalid", message: "mouse action \(action)?")
        }
        last = p
        try await sleep((a["settleMs"] as? NSNumber)?.doubleValue ?? 60)
        return ["virtualDrag": VirtualDrag.current != nil]
    }

    /// A press, a path of drags and a release: {from:[x,y], to:[x,y], steps?, holdMs?, mods?, via?: [[x,y]...], system?}.
    /// A drag that starts system drag and drop is carried by a virtual session; the answer says so.
    private static func drag(_ a: [String: Any]) async throws -> [String: Any] {
        let w = try target(a)
        guard let (fx, fy) = point(a, "from"), let (tx, ty) = point(a, "to") else { throw QAError(code: "invalid", message: "drag needs from and to") }
        let f = flags(a)
        let steps = max(2, (a["steps"] as? NSNumber)?.intValue ?? 12)
        let stepMs = (a["stepMs"] as? NSNumber)?.doubleValue ?? 16
        var path: [(Double, Double)] = [(fx, fy)]
        for v in (a["via"] as? [[NSNumber]]) ?? [] where v.count == 2 { path.append((v[0].doubleValue, v[1].doubleValue)) }
        path.append((tx, ty))
        if a["system"] as? Bool == true {
            return try await systemDrag(a, window: w, path: path, steps: steps, stepMs: stepMs, flags: f)
        }
        VirtualDrag.current = nil
        var started = false
        let p0 = base(w, fx, fy)
        post(mouseEvent(.mouseMoved, w, p0, f, clicks: 0, pressure: 0))
        post(mouseEvent(.leftMouseDown, w, p0, f))
        try await sleep((a["holdMs"] as? NSNumber)?.doubleValue ?? 60)
        for seg in 1..<path.count {
            let (ax, ay) = path[seg - 1], (bx, by) = path[seg]
            for i in 1...steps {
                let t = Double(i) / Double(steps)
                let p = base(w, ax + (bx - ax) * t, ay + (by - ay) * t)
                if let v = VirtualDrag.current { started = true; try await v.move(to: p, in: w) }
                else { post(mouseEvent(.leftMouseDragged, w, p, f)) }
                try await sleep(stepMs)
            }
        }
        let pt = base(w, tx, ty)
        try await sleep((a["dwellMs"] as? NSNumber)?.doubleValue ?? 120)
        var dropped: [String: Any] = [:]
        if let v = VirtualDrag.current {
            started = true
            try await v.move(to: pt, in: w)
            try await sleep(60)
            dropped = try await v.drop(at: pt, in: w)
        }
        // The release: after a virtual drop it ends the gesture that lifted the drag, as the window server's would.
        post(mouseEvent(.leftMouseUp, w, pt, f, pressure: 0))
        last = pt
        try await sleep((a["settleMs"] as? NSNumber)?.doubleValue ?? 150)
        return ["systemDrag": started, "drop": dropped]
    }

    /// Window-server input. Freeze the screen path before pressing so a window move cannot hide itself.
    private static func systemDrag(_ a: [String: Any], window w: NSWindow, path: [(Double, Double)],
                                   steps: Int, stepMs: Double, flags: NSEvent.ModifierFlags) async throws -> [String: Any] {
        guard CGPreflightPostEventAccess() else {
            throw QAError(code: "permission", message: "System drag requires permission to post input events")
        }
        let previousApp = NSWorkspace.shared.frontmostApplication
        let previousPointer = CGEvent(source: nil)?.location
        let source = CGEventSource(stateID: .hidSystemState)
        let top = CGDisplayBounds(CGMainDisplayID()).maxY
        let screenPath = path.map { x, y -> CGPoint in
            let p = w.convertPoint(toScreen: base(w, x, y))
            return CGPoint(x: p.x, y: top - p.y)
        }
        func send(_ type: CGEventType, _ p: CGPoint) {
            QAPointer.location = NSPoint(x: p.x, y: top - p.y)
            QAPointer.buttons = type == .leftMouseDown || type == .leftMouseDragged ? 1 : 0
            QAPointer.mods = flags
            let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
            event.flags = CGEventFlags(rawValue: UInt64(flags.rawValue))
            event.setIntegerValueField(.mouseEventClickState, value: 1)
            event.post(tap: .cghidEventTap)
        }
        w.orderFrontRegardless()
        NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps])
        try await sleep(150)
        send(.mouseMoved, screenPath[0])
        send(.leftMouseDown, screenPath[0])
        var released = false
        defer {
            if !released { send(.leftMouseUp, screenPath.last!) }
            QAPointer.buttons = 0
            QAPointer.mods = heldMods
            if let previousPointer {
                CGWarpMouseCursorPosition(previousPointer)
                QAPointer.location = NSPoint(x: previousPointer.x, y: top - previousPointer.y)
            }
            previousApp?.activate(options: [.activateIgnoringOtherApps])
        }
        try await sleep((a["holdMs"] as? NSNumber)?.doubleValue ?? 60)
        for seg in 1..<screenPath.count {
            let start = screenPath[seg - 1], end = screenPath[seg]
            for i in 1...steps {
                let t = CGFloat(i) / CGFloat(steps)
                send(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t))
                try await sleep(stepMs)
            }
        }
        try await sleep((a["dwellMs"] as? NSNumber)?.doubleValue ?? 120)
        send(.leftMouseUp, screenPath.last!)
        released = true
        try await sleep((a["settleMs"] as? NSNumber)?.doubleValue ?? 150)
        return ["system": true]
    }

    /// {files: [absolute paths], from, to, mods?, steps?}: files dragged in from outside the app (Finder's drag): a
    /// virtual session with one file URL per item, moved by the QA pointer and dropped on what is under `to`.
    private static func dragFiles(_ a: [String: Any]) async throws -> [String: Any] {
        let w = try target(a)
        let files = (a["files"] as? [String]) ?? []
        guard !files.isEmpty, let (fx, fy) = point(a, "from"), let (tx, ty) = point(a, "to") else { throw QAError(code: "invalid", message: "qa.files needs files, from and to") }
        let f = flags(a)
        let steps = max(2, (a["steps"] as? NSNumber)?.intValue ?? 12)
        // Plain items carrying only a file URL (an NSURL also offers legacy types the virtual session reads as promises).
        let items = files.map { p -> NSDraggingItem in
            let it = NSPasteboardItem()
            it.setString(URL(fileURLWithPath: p).absoluteString, forType: .fileURL)
            let d = NSDraggingItem(pasteboardWriter: it)
            d.draggingFrame = NSRect(x: 0, y: 0, width: 32, height: 32)
            return d
        }
        let v = VirtualDrag(items: items, source: QAFileDragSource(), view: w.contentView!)
        VirtualDrag.current = v
        QAPointer.mods = f
        defer { QAPointer.mods = heldMods; VirtualDrag.current = nil }
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let p = base(w, fx + (tx - fx) * t, fy + (ty - fy) * t)
            QAPointer.location = w.convertPoint(toScreen: p)
            try await v.move(to: p, in: w)
            try await sleep(16)
        }
        try await sleep((a["dwellMs"] as? NSNumber)?.doubleValue ?? 120)
        let dropped = try await v.drop(at: base(w, tx, ty), in: w)
        try await sleep((a["settleMs"] as? NSNumber)?.doubleValue ?? 150)
        return ["drop": dropped]
    }

    /// {x, y, dx, dy, mods?, precise? (trackpad deltas, default true)}
    private static func scroll(_ a: [String: Any]) async throws -> [String: Any] {
        let w = try target(a)
        guard let (x, y) = point(a) else { throw QAError(code: "invalid", message: "scroll needs x and y") }
        let p = base(w, x, y)
        let dx = (a["dx"] as? NSNumber)?.doubleValue ?? 0, dy = (a["dy"] as? NSNumber)?.doubleValue ?? 0
        let precise = a["precise"] as? Bool ?? true
        guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: precise ? .pixel : .line, wheelCount: 2,
                               wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0) else { throw QAError(message: "no scroll event") }
        // The event's location is in global (top-left) screen coordinates; it is only posted to this app.
        let screen = w.convertPoint(toScreen: p)
        let h = NSScreen.screens.first?.frame.height ?? 0
        cg.location = CGPoint(x: screen.x, y: h - screen.y)
        cg.flags = CGEventFlags(rawValue: UInt64(flags(a).rawValue))
        if precise { cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1) }
        guard let e = NSEvent(cgEvent: cg) else { throw QAError(message: "no scroll event") }
        // NSApp.postEvent drops scroll events without a window; the window takes them straight.
        w.sendEvent(e)
        try await sleep((a["settleMs"] as? NSNumber)?.doubleValue ?? 80)
        return [:]
    }

    // MARK: keys

    /// Modifier key changes, so code that reads NSEvent.modifierFlags from flagsChanged sees them.
    private static func flagsChanged(_ f: NSEvent.ModifierFlags, _ w: NSWindow) -> NSEvent? {
        let code: UInt16 = f.contains(.command) ? 55 : f.contains(.option) ? 58 : f.contains(.shift) ? 56 : f.contains(.control) ? 59 : 55
        guard let cg = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) else { return nil }
        cg.type = .flagsChanged
        cg.flags = CGEventFlags(rawValue: UInt64(f.rawValue))
        guard let e = NSEvent(cgEvent: cg) else { return nil }
        return NSEvent.keyEvent(with: .flagsChanged, location: last, modifierFlags: f, timestamp: ProcessInfo.processInfo.systemUptime,
                                windowNumber: w.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: e.keyCode)
    }

    /// {key: "k" | "Return" | ..., mods?: ["cmd", ...], hold?: true (keep the modifiers for the next mouse ops), release?: true}
    private static func key(_ a: [String: Any]) async throws -> [String: Any] {
        let w = try target(a)
        if w !== NSApp.modalWindow && !w.isKeyWindow { w.makeKey() }
        let f = flags(a)
        if a["release"] as? Bool == true {
            heldMods = []
            post(flagsChanged([], w))
            try await sleep(30)
            return [:]
        }
        if a["hold"] as? Bool == true {
            heldMods = f
            post(flagsChanged(f, w))
            try await sleep(30)
            return ["held": true]
        }
        guard let k = a["key"] as? String, !k.isEmpty else { throw QAError(code: "invalid", message: "key needs key") }
        // Background field editors do not publish SwiftUI changes for a synthetic clipboard insertion.
        // Deliver the private clipboard through the same native input path as qa.type, without interleaved modifiers.
        if f.contains(.command), k.lowercased() == "v", let field = w.firstResponder as? NSTextView, field.isFieldEditor,
           let text = canvasPasteboard.string(forType: .string), !text.contains("\n") {
            return try await typeText(["text": text, "window": a["window"] ?? "main"])
        }
        let repeatN = max(1, (a["repeat"] as? NSNumber)?.intValue ?? 1)
        for _ in 0..<repeatN {
            let evs = QAKey.events(k, f, windowNumber: w.windowNumber, location: last)
            if !f.isEmpty { post(flagsChanged(f, w)) }
            post(evs.first)
            try await sleep(20)
            post(evs.last)
            if !f.isEmpty { post(flagsChanged(heldMods, w)) }
            try await sleep(20)
        }
        try await sleep((a["settleMs"] as? NSNumber)?.doubleValue ?? 80)
        return [:]
    }

    /// {text}: one key press per character, as typed.
    private static func typeText(_ a: [String: Any]) async throws -> [String: Any] {
        let w = try target(a)
        if w !== NSApp.modalWindow && !w.isKeyWindow { w.makeKey() }
        guard let text = a["text"] as? String else { throw QAError(code: "invalid", message: "type needs text") }
        for ch in text {
            let evs = QAKey.events(ch == "\n" ? "Return" : String(ch), heldMods, windowNumber: w.windowNumber, location: last)
            if evs.isEmpty || (QAKey.layout[Character(ch.lowercased())] == nil && QAKey.shifted[ch] == nil && ch != "\n") {
                // Outside the US layout table: a key event that carries the character itself.
                let t = ProcessInfo.processInfo.systemUptime
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    post(NSEvent.keyEvent(with: type, location: last, modifierFlags: [], timestamp: t, windowNumber: w.windowNumber, context: nil,
                                          characters: String(ch), charactersIgnoringModifiers: String(ch), isARepeat: false, keyCode: 0))
                }
            } else {
                post(evs.first); post(evs.last)
            }
            try await sleep((a["charMs"] as? NSNumber)?.doubleValue ?? 12)
        }
        try await sleep((a["settleMs"] as? NSNumber)?.doubleValue ?? 80)
        return [:]
    }

    /// Waits until the event queue has been worked through and SwiftUI has had a frame or two.
    private static func idle(_ a: [String: Any]) async throws {
        try await sleep((a["ms"] as? NSNumber)?.doubleValue ?? 100)
    }

    // MARK: state

    private static func json(_ v: Any?) -> Any {
        guard let v else { return NSNull() }
        if JSONSerialization.isValidJSONObject([v]) { return v }
        return String(describing: v)
    }

    static func state() -> [String: Any] {
        let m = model!
        var sel: Any = NSNull()
        if let s = m.selection {
            sel = ["id": s.id, "ids": s.ids, "parentId": s.parentId ?? NSNull(), "type": s.node["type"] as? String ?? NSNull(),
                   "resolvedType": s.resolvedType ?? NSNull(), "width": s.width ?? NSNull(), "height": s.height ?? NSNull(),
                   "isComponent": s.isComponent, "inInstance": s.inInstance, "overrides": s.overrides, "node": json(s.node), "free": s.free ?? NSNull(),
                   "paintRow": m.paintRowNow.map { ["key": $0.key, "row": $0.row] as [String: Any] } ?? NSNull()]
        }
        let layers = LayersStore.of(m)
        let palette = PaletteController.shared
        let windows: [[String: Any]] = NSApp.windows.filter { $0.isVisible }.map {
            ["title": $0.title, "settings": $0.contentViewController is SettingsTabs, "key": $0.isKeyWindow, "main": $0 === window,
             "width": $0.frame.width, "height": $0.frame.height, "class": String(describing: type(of: $0)), "number": $0.windowNumber,
             "x": $0.frame.minX, "y": $0.frame.minY, "alpha": $0.alphaValue, "onScreen": $0.isOnActiveSpace]
        }
        return [
            "file": m.currentFile ?? NSNull(), "openFiles": m.openFiles, "homeShown": m.homeShown, "recents": MainActor.assumeIsolated { HomeStore.shared.recents.map(\.path) }, "homeSection": MainActor.assumeIsolated { String(describing: HomeStore.shared.section) }, "homeCloud": MainActor.assumeIsolated { HomeStore.shared.section.cloudId ?? "" }, "addCloud": MainActor.assumeIsolated { AddCloudPanel.shared.isOpen }, "stateDir": StateFolder.path, "revision": m.revision, "zoom": m.zoom,
            "tabRename": ["file": tabRenameFile() as Any? ?? NSNull(), "events": tabRenameEvents],
            "section": m.section?.rawValue ?? NSNull(), "panelOpen": m.panelOpen, "sidebarWidth": Double(m.sidebarWidth), "homeSidebarWidth": Double(m.homeSidebarWidth), "inspectorOpen": m.inspectorOpen, "uiHidden": m.uiHidden,
            "pages": m.pages.map { ["id": $0.id, "name": $0.name, "count": $0.count] }, "activePage": m.activePage ?? NSNull(),
            "cloudReadOnly": m.cloudReadOnly, "boards": m.boards.map(\.id), "selection": sel, "selectedWidget": m.selectedWidgetId ?? NSNull(),
            "widgets": m.widgets.map { ["id": $0.id, "kind": $0.kind] },
            "widgetKinds": m.widgetKinds.map { ["id": $0.id, "title": $0.title] },
            "paperShaders": m.paperShaders.map { ["id": $0.id, "name": $0.name] },
            "layers": layers.rows.map { (r: LayerRow) -> [String: Any] in ["id": r.id, "name": r.name, "depth": r.depth, "parent": r.parent ?? NSNull(), "board": r.board, "locked": r.locked, "lockedAbove": r.lockedAbove, "expanded": r.expanded] },
            "batchRename": m.batchRename ?? NSNull(), "renamingBoard": m.renamingBoard ?? NSNull(),
            "layerRenaming": layers.renaming ?? NSNull(), "layerDropMark": layers.dropMark.map { (d: LayerDropMark) -> String in "\(d.id):\(d.zone)" } ?? NSNull(),
            "palette": ["open": palette.isOpen, "query": palette.query, "cursor": palette.cursor,
                        "items": palette.groups.flatMap { g in g.items.map { "\(g.title): \($0.title)" } }],
            "toast": m.toast ?? NSNull(), "toastKind": String(describing: m.toastKind), "zoomFieldOpen": m.zoomFieldOpen, "popoverShown": NSApp.windows.contains { $0.isVisible && String(describing: Swift.type(of: $0)).contains("Popover") }, "pixelGrid": m.pixelGrid, "rulers": m.rulers, "layoutGuides": m.layoutGuides, "frames": QAFrames.all.mapValues { ["x": $0.minX, "y": $0.minY, "w": $0.width, "h": $0.height] }, "toastCopy": m.toastCopy ?? NSNull(), "toastActions": m.toastActions.map(\.label), "toastFrames": ToastFrames.rects.mapValues { ["x": $0.minX, "y": $0.minY, "w": $0.width, "h": $0.height] }, "agentReady": m.agentReady, "theme": m.theme.rawValue, "textEditing": m.textEditing,
            "prefs": Dictionary(uniqueKeysWithValues: Mirror(reflecting: m.prefs).children.compactMap { c in c.label.map { ($0, String(describing: c.value)) } }),
            "windows": windows, "window": windowInfo(window), "panels": panels, "hides": hides,
            "menu": openMenu.map { m -> [String: Any] in
                ["items": m.items.filter { !$0.isSeparatorItem && !$0.isHidden }.map { $0.title }, "highlighted": m.highlightedItem?.title ?? NSNull()]
            } ?? NSNull(),
            "modal": NSApp.modalWindow.map { ["title": $0.title, "class": String(describing: Swift.type(of: $0))] as [String: Any] } ?? NSNull(),
            "webFrame": rectTL(model.webView, in: window),
        ]
    }

    /// A view's frame in its window, top-left origin.
    private static func rectTL(_ v: NSView, in w: NSWindow) -> [String: Double] {
        let r = v.convert(v.bounds, to: nil)
        return ["x": r.minX, "y": w.frame.height - r.maxY, "w": r.width, "h": r.height]
    }

    // MARK: views

    /// The window's AppKit views that hold state or take input: text fields (the inspector's), buttons and
    /// switches, segmented controls, pop-ups, sliders, scroll views. SwiftUI draws rows and icon buttons without
    /// views of their own; qa.find reads those off the window by their text. The web view is not entered.
    /// {window?, all?: every view}
    private static func views(_ a: [String: Any]) throws -> [String: Any] {
        let w = try target(a)
        let all = a["all"] as? Bool == true
        var out: [[String: Any]] = []
        func walk(_ v: NSView, _ depth: Int) {
            if v.isHiddenOrHasHiddenAncestor { return }
            var n: [String: Any] = rectTL(v, in: w)
            n["class"] = String(describing: Swift.type(of: v))
            n["depth"] = depth
            var keep = all
            if let ax = v.accessibilityLabel(), !ax.isEmpty { n["label"] = ax }
            if !v.registeredDraggedTypes.isEmpty { n["dropTypes"] = v.registeredDraggedTypes.map(\.rawValue); keep = true }
            if !v.accessibilityIdentifier().isEmpty { n["id"] = v.accessibilityIdentifier() }
            if let f = v as? NSTextField {
                keep = true
                n["kind"] = "text"; n["value"] = f.stringValue; n["placeholder"] = f.placeholderString ?? ""
                n["editable"] = f.isEditable; n["editing"] = f.currentEditor() != nil
                if let editor = f.currentEditor() as? NSTextView {
                    let range = editor.selectedRange()
                    n["selection"] = ["location": range.location, "length": range.length]
                }
            } else if let s = v as? NSSegmentedControl {
                keep = true
                n["kind"] = "segmented"; n["selected"] = s.selectedSegment
                var x = 0.0
                n["segments"] = (0..<s.segmentCount).map { i -> [String: Any] in
                    let wd = s.width(forSegment: i) > 0 ? Double(s.width(forSegment: i)) : Double(s.bounds.width) / Double(s.segmentCount)
                    defer { x += wd }
                    return ["label": s.label(forSegment: i) ?? s.toolTip(forSegment: i) ?? "", "x": x, "w": wd]
                }
            } else if let p = v as? NSPopUpButton {
                keep = true
                n["kind"] = "popup"; n["value"] = p.titleOfSelectedItem ?? ""; n["items"] = p.itemTitles
            } else if let b = v as? NSButton {
                keep = true
                n["kind"] = "button"; n["title"] = b.title; n["state"] = b.state.rawValue; n["enabled"] = b.isEnabled
            } else if let s = v as? NSSlider {
                keep = true
                n["kind"] = "slider"; n["value"] = s.doubleValue
            } else if let s = v as? NSSwitch {
                keep = true
                n["kind"] = "switch"; n["state"] = s.state.rawValue
            } else if v is NSScrollView {
                keep = true
                n["kind"] = "scroll"
            }
            if keep { out.append(n) }
            if v is WKWebView { return }
            for s in v.subviews { walk(s, depth + 1) }
        }
        if let root = w.contentView?.superview ?? w.contentView { walk(root, 0) }
        return ["views": out, "firstResponder": w.firstResponder.map { String(describing: Swift.type(of: $0)) } ?? NSNull()]
    }

    // MARK: marks

    /// The views marked with .qaID / .qaText (Components.swift) that show in the window now: {window?, id?, label?
    /// (case-insensitive substring)} -> {marks: [{id, label, x, y, w, h}]} in window points, the part a scroll view
    /// clips away left out. What scenarios use to find controls; text recognition is the fallback.
    private static func marks(_ a: [String: Any]) throws -> [String: Any] {
        let w = try target(a)
        let wantID = a["id"] as? String
        let wantLabel = (a["label"] as? String).flatMap { $0.isEmpty ? nil : $0.lowercased() }
        var out: [[String: Any]] = []
        func walk(_ v: NSView) {
            if v.isHidden || v.alphaValue < 0.01 { return }
            if let m = v as? QAMarkView, wantID == nil || m.qaID == wantID, wantLabel == nil || (m.qaLabel?.lowercased().contains(wantLabel!) ?? false) {
                // The part no scroll view clips away and inside the window: what a click can reach.
                var r = m.convert(m.bounds, to: nil)
                var a = m.superview
                while let s = a {
                    if s is NSClipView { r = r.intersection(s.convert(s.bounds, to: nil)) }
                    a = s.superview
                }
                r = r.intersection(NSRect(origin: .zero, size: w.frame.size))
                if !r.isEmpty, r.width >= 1, r.height >= 1 {
                    var n: [String: Any] = ["x": r.minX, "y": w.frame.height - r.maxY, "w": r.width, "h": r.height, "full": rectTL(m, in: w)]
                    n["id"] = m.qaID
                    n["label"] = m.qaLabel ?? NSNull()
                    n["windowFrame"] = ["x": w.frame.minX, "y": w.frame.minY, "w": w.frame.width, "h": w.frame.height]
                    out.append(n)
                }
            }
            if v is WKWebView { return }
            for s in v.subviews { walk(s) }
        }
        if let root = w.contentView?.superview ?? w.contentView { walk(root) }
        return ["marks": out]
    }

    // MARK: pixels

    /// How many pixels in `region` (window points) are within `tol` (0-255 per channel) of the colours in `colors`
    /// ("#RRGGBB"): {region, colors, tol?} -> {count, total}. For marks that leave no state behind (a drop line).
    private static func pixels(_ a: [String: Any]) async throws -> [String: Any] {
        let w = try target(a)
        let cg = try await capture(w)
        guard let r = a["region"] as? [String: Any], let rx = (r["x"] as? NSNumber)?.doubleValue, let ry = (r["y"] as? NSNumber)?.doubleValue,
              let rw = (r["w"] as? NSNumber)?.doubleValue, let rh = (r["h"] as? NSNumber)?.doubleValue else { throw QAError(code: "invalid", message: "pixels needs region") }
        let k = Double(cg.width) / Double(w.frame.width)
        guard let crop = cg.cropping(to: CGRect(x: rx * k, y: ry * k, width: rw * k, height: rh * k)) else { throw QAError(message: "region outside the window") }
        let pw = crop.width, ph = crop.height
        var buf = [UInt8](repeating: 0, count: pw * ph * 4)
        guard let ctx = CGContext(data: &buf, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: pw * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw QAError(message: "no context") }
        ctx.draw(crop, in: CGRect(x: 0, y: 0, width: pw, height: ph))
        let tol = (a["tol"] as? NSNumber)?.intValue ?? 24
        let colors: [(Int, Int, Int)] = ((a["colors"] as? [String]) ?? []).compactMap { s in
            guard s.hasPrefix("#"), let v = Int(s.dropFirst(), radix: 16) else { return nil }
            return ((v >> 16) & 255, (v >> 8) & 255, v & 255)
        }
        var count = 0
        for i in stride(from: 0, to: buf.count, by: 4) {
            let (r0, g0, b0) = (Int(buf[i]), Int(buf[i + 1]), Int(buf[i + 2]))
            if colors.contains(where: { abs($0.0 - r0) <= tol && abs($0.1 - g0) <= tol && abs($0.2 - b0) <= tol }) { count += 1 }
        }
        return ["count": count, "total": pw * ph]
    }

    // MARK: text on screen

    /// Finds text drawn in the window (Vision text recognition on the window's own capture): rows, labels, pills,
    /// menus. {text?: substring to look for (case-insensitive), window?} -> {matches: [{text, x, y, w, h}]} in
    /// window points; without text, every line.
    private static func find(_ a: [String: Any]) async throws -> [String: Any] {
        let w = try target(a)
        let t0 = Date()
        var cg = try await capture(w)
        let want = (a["text"] as? String).flatMap { $0.isEmpty ? nil : $0.lowercased() }
        // A region (window points) reads only that part: much quicker than the whole window.
        var ox = 0.0, oy = 0.0, W = Double(w.frame.width), H = Double(w.frame.height)
        if let r = a["region"] as? [String: Any], let rx = (r["x"] as? NSNumber)?.doubleValue, let ry = (r["y"] as? NSNumber)?.doubleValue,
           let rw = (r["w"] as? NSNumber)?.doubleValue, let rh = (r["h"] as? NSNumber)?.doubleValue {
            let k = Double(cg.width) / W
            if let c = cg.cropping(to: CGRect(x: rx * k, y: ry * k, width: rw * k, height: rh * k)) { cg = c; ox = rx; oy = ry; W = rw; H = rh }
        }
        let fast = (a["level"] as? String) == "fast"
        let read = try await QAReader.shared.read(cg, fast: fast, want: want)
        let lines: [[String: Any]] = read.lines.map { l in
            ["text": l.text, "x": ox + l.box.minX * W, "y": oy + (1 - l.box.maxY) * H, "w": l.box.width * W, "h": l.box.height * H, "confidence": l.confidence]
        }
        return ["matches": lines, "ms": Int(Date().timeIntervalSince(t0) * 1000), "device": read.device, "tries": read.tries]
    }

    // MARK: screenshot

    /// The window as drawn, chrome and canvas together: {window?, path?: write the PNG there, maxSide?}.
    /// Answers the PNG (base64) unless a path is given.
    private static func shot(_ a: [String: Any]) async throws -> [String: Any] {
        let w = try target(a)
        let cg = try await capture(w)
        let maxSide = (a["maxSide"] as? NSNumber)?.intValue ?? 4096
        let k = min(1, Double(maxSide) / Double(max(cg.width, cg.height)))
        let img = k < 1 ? scaled(cg, k) ?? cg : cg
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { throw QAError(message: "no PNG encoder") }
        CGImageDestinationAddImage(dest, img, nil)
        guard CGImageDestinationFinalize(dest) else { throw QAError(message: "PNG encode failed") }
        var r: [String: Any] = ["width": img.width, "height": img.height, "method": lastCaptureMethod]
        if let p = a["path"] as? String, !p.isEmpty {
            try (out as Data).write(to: URL(fileURLWithPath: p))
            r["path"] = p
        } else {
            r["data"] = (out as Data).base64EncodedString()
        }
        return r
    }
    private static var lastCaptureMethod = ""

    private static func scaled(_ cg: CGImage, _ k: Double) -> CGImage? {
        let w = max(1, Int(Double(cg.width) * k)), h = max(1, Int(Double(cg.height) * k))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    private typealias WindowImageFn = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

    /// This app's own window from the window server (what is on screen, glass included). Looked up at run time:
    /// the SDK marks CGWindowListCreateImage unavailable, the system still has it. Falls back to drawing the
    /// window's views (the web view's snapshot under the SwiftUI chrome).
    private static func capture(_ w: NSWindow) async throws -> CGImage {
        if let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") {
            let fn = unsafeBitCast(sym, to: WindowImageFn.self)
            // .optionIncludingWindow = 1 << 3, .boundsIgnoreFraming = 1 << 0, .bestResolution = 1 << 3
            if let img = fn(.null, 1 << 3, UInt32(w.windowNumber), (1 << 0) | (1 << 3))?.takeRetainedValue(), img.width > 4, !blank(img) {
                lastCaptureMethod = "windowServer"
                return img
            }
        }
        lastCaptureMethod = "views"
        return try await drawViews(w)
    }

    /// An all-transparent capture means the window server would not give the pixels.
    private static func blank(_ img: CGImage) -> Bool {
        guard let ctx = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 32, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: 8, height: 8))
        guard let d = ctx.data else { return false }
        let p = d.bindMemory(to: UInt8.self, capacity: 256)
        return (0..<64).allSatisfy { p[$0 * 4 + 3] == 0 }
    }

    private static func drawViews(_ w: NSWindow) async throws -> CGImage {
        guard let content = w.contentView else { throw QAError(message: "window has no content") }
        let scale = w.backingScaleFactor
        let size = content.bounds.size
        let pw = Int(size.width * scale), ph = Int(size.height * scale)
        guard let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw QAError(message: "no context") }
        ctx.setFillColor(w.backgroundColor.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: pw, height: ph))
        if w === window {
            let wv = model.webView
            let img: NSImage? = await withCheckedContinuation { c in wv.takeSnapshot(with: nil) { i, _ in c.resume(returning: i) } }
            if let img, var r = Optional(NSRect(origin: .zero, size: img.size)), let cg = img.cgImage(forProposedRect: &r, context: nil, hints: nil) {
                let f = wv.convert(wv.bounds, to: nil)
                ctx.draw(cg, in: CGRect(x: f.minX * scale, y: f.minY * scale, width: f.width * scale, height: f.height * scale))
            }
        }
        guard let rep = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { throw QAError(message: "no bitmap") }
        content.cacheDisplay(in: content.bounds, to: rep)
        if let cg = rep.cgImage { ctx.draw(cg, in: CGRect(x: 0, y: 0, width: pw, height: ph)) }
        guard let out = ctx.makeImage() else { throw QAError(message: "no image") }
        return out
    }

    // MARK: page

    /// Runs `body` (an async function body: use return) in the shown page; answers its JSON-able result.
    private static func js(_ a: [String: Any]) async throws -> [String: Any] {
        guard let body = a["body"] as? String else { throw QAError(code: "invalid", message: "js needs body") }
        let wrapped = "const __r = await (async () => { \(body) })(); return JSON.stringify(__r === undefined ? null : __r);"
        do {
            let r = try await model.webView.callAsyncJavaScript(wrapped, arguments: [:], in: nil, contentWorld: .page)
            guard let s = r as? String, let d = s.data(using: .utf8) else { return ["value": NSNull()] }
            return ["value": (try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])) ?? NSNull()]
        } catch {
            throw QAError(code: "failed", message: "page: \((error as NSError).userInfo["WKJavaScriptExceptionMessage"] ?? error.localizedDescription)")
        }
    }
}

// MARK: - marks

/// The invisible view .qaID lays under a SwiftUI view (Components.swift): its frame is the view's, qa.marks reads
/// it. It takes no clicks, draws nothing and is not in the accessibility tree.
struct QAMark: NSViewRepresentable {
    let id: String
    let label: String?
    func makeNSView(context: Context) -> QAMarkView {
        let v = QAMarkView()
        v.qaID = id
        v.qaLabel = label
        return v
    }
    func updateNSView(_ v: QAMarkView, context: Context) {
        v.qaID = id
        v.qaLabel = label
    }
}

final class QAMarkView: NSView {
    var qaID = ""
    var qaLabel: String?
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }
    override var acceptsFirstResponder: Bool { false }
}

// MARK: - text recognition

/// Text recognition, one read at a time per instance (several at once in one process starve each other under load).
/// Vision's Neural Engine path fails now and then on a loaded Mac (e5rt errors): the read is tried again on the CPU.
actor QAReader {
    static let shared = QAReader()
    struct Line: Sendable { let text: String; let box: CGRect; let confidence: Double }
    struct Read: Sendable { let lines: [Line]; let device: String; let tries: Int }
    /// After the Neural Engine failed once, this instance reads on the CPU from then on.
    private var cpuOnly = false

    func read(_ image: CGImage, fast: Bool, want: String?) throws -> Read {
        var tries = 0
        var lastError: Error?
        for attempt in 0..<3 {
            tries += 1
            let cpu = cpuOnly || attempt > 0
            do {
                return Read(lines: try Self.recognize(image, fast: fast, want: want, cpu: cpu), device: cpu ? "cpu" : "default", tries: tries)
            } catch {
                lastError = error
                NSLog("canvas qa: text recognition failed (\(cpu ? "cpu" : "default")): \(error)")
                if !cpu { cpuOnly = true }
            }
        }
        throw lastError ?? QAError(message: "text recognition failed")
    }

    private static func recognize(_ image: CGImage, fast: Bool, want: String?, cpu: Bool) throws -> [Line] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = fast ? .fast : .accurate
        req.usesLanguageCorrection = false
        if cpu, let devices = try? req.supportedComputeStageDevices, let main = devices[.main],
           let c = main.first(where: { if case .cpu = $0 { return true } else { return false } }) {
            req.setComputeDevice(c, for: .main)
        }
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
        var out: [Line] = []
        for o in req.results ?? [] {
            guard let c = o.topCandidates(1).first else { continue }
            let s = c.string
            var box = o.boundingBox
            if let want, let r = s.lowercased().range(of: want) {
                let lo = s.index(s.startIndex, offsetBy: s.lowercased().distance(from: s.lowercased().startIndex, to: r.lowerBound))
                let hi = s.index(lo, offsetBy: want.count, limitedBy: s.endIndex) ?? s.endIndex
                if let sub = try? c.boundingBox(for: lo..<hi) { box = sub.boundingBox }
            } else if want != nil { continue }
            out.append(Line(text: s, box: box, confidence: Double(c.confidence)))
        }
        return out
    }
}

// MARK: - virtual drag and drop

/// Stands in for the window server's drag session: the QA mouse moves drive it, the destination under the point
/// gets the NSDraggingDestination calls a real drag would make.
@MainActor
final class VirtualDrag: NSObject, @preconcurrency NSDraggingInfo {
    static var current: VirtualDrag?
    private static var seq = 0

    let items: [NSDraggingItem]
    weak var sourceView: NSView?
    let source: NSDraggingSource
    let session: NSDraggingSession
    let pasteboard: NSPasteboard
    private var dest: NSView?
    private var op: NSDragOperation = []
    private var loc = NSPoint.zero
    private var win: NSWindow?
    let sequence: Int
    private var promised: [QAPromiseReceiver] = []

    /// The gesture that lifted the drag (SwiftUI's): it ends with the drop.
    weak var gesture: NSGestureRecognizer?

    init(items: [NSDraggingItem], source: NSDraggingSource, view: NSView) {
        Self.seq += 1
        sequence = 9000 + Self.seq
        self.items = items
        self.source = source
        self.sourceView = view
        session = (NSDraggingSession.self as NSObject.Type).init() as! NSDraggingSession
        pasteboard = NSPasteboard(name: NSPasteboard.Name("cc.getcanvas.canvas.qa.drag.\(UUID().uuidString)"))
        pasteboard.clearContents()
        // The items go onto the private pasteboard as they are, except a file promise (a sidebar card promises its
        // payload as a file): that one is presented the way the drag manager presents it, the legacy promise list
        // on the pasteboard and a receiver that writes the promised file when the destination asks
        // (QAPromiseReceiver), since the drag server that carries promised files between processes is not involved.
        var out: [NSPasteboardWriting] = []
        var promised: [QAPromiseReceiver] = []
        for it in items {
            guard let w = it.item as? NSPasteboardWriting else { continue }
            let all = w.writableTypes(for: pasteboard)
            guard all.contains(where: Self.isPromise) else { out.append(w); continue }
            let item = NSPasteboardItem()
            var plain: [(NSPasteboard.PasteboardType, Any)] = []
            for t in all where !Self.isPromise(t) {
                guard let v = w.pasteboardPropertyList(forType: t) else { continue }
                plain.append((t, v))
                if let d = v as? Data { item.setData(d, forType: t) }
                else if let str = v as? String { item.setString(str, forType: t) }
                else { item.setPropertyList(v, forType: t) }
            }
            let types = plain.isEmpty ? ["public.data"] : plain.map(\.0.rawValue)
            let data = plain.first.map { ($0.1 as? Data) ?? ($0.1 as? String)?.data(using: .utf8) ?? Data() } ?? Data()
            promised.append(QAPromiseReceiver(types: types, data: data))
            if !item.types.isEmpty { out.append(item) }
        }
        if !out.isEmpty { pasteboard.writeObjects(out) }
        if !promised.isEmpty {
            // The legacy promise list is not a UTI, so it goes on through the legacy calls (onto the first item).
            let promise = NSPasteboard.PasteboardType("Apple files promise pasteboard type")
            pasteboard.addTypes([promise], owner: nil)
            pasteboard.setPropertyList(promised.flatMap(\.fileTypes), forType: promise)
        }
        self.promised = promised
        super.init()
    }

    static func isPromise(_ t: NSPasteboard.PasteboardType) -> Bool {
        let r = t.rawValue
        return r.contains("promise") || r.contains("Promise") || r == "com.apple.NSFilePromiseItemMetaData" || r.hasPrefix("dyn.")
    }

    /// A view registered for `registered` takes a drag carrying `offered`: the same type, or one that conforms.
    static func takes(_ registered: [NSPasteboard.PasteboardType], _ offered: Set<NSPasteboard.PasteboardType>) -> Bool {
        if !Set(registered).isDisjoint(with: offered) { return true }
        let regs = registered.compactMap { UTType($0.rawValue) }
        return offered.contains { o in UTType(o.rawValue).map { t in regs.contains { t.conforms(to: $0) } } ?? false }
    }

    /// SwiftUI's drop targets are views of their own laid over the content (not in the hit-test chain), so every
    /// visible view that takes a dragged type and holds the point is a candidate: the deepest, then the frontmost.
    private func destination(at p: NSPoint, in w: NSWindow) -> NSView? {
        guard let root = w.contentView?.superview ?? w.contentView else { return nil }
        let types = Set(pasteboard.types ?? [])
        var best: (view: NSView, depth: Int)?
        func walk(_ v: NSView, _ depth: Int) {
            if v.isHidden { return }
            if v.convert(v.bounds, to: nil).contains(p), Self.takes(v.registeredDraggedTypes, types), depth >= (best?.depth ?? -1) {
                best = (v, depth)
            }
            for s in v.subviews { walk(s, depth + 1) }
        }
        walk(root, 0)
        return best?.view
    }

    func move(to p: NSPoint, in w: NSWindow) async throws {
        win = w
        loc = p
        let next = destination(at: p, in: w)
        if next !== dest {
            if let d = dest { d.draggingExited(self) }
            dest = next
            op = next?.draggingEntered(self) ?? []
        } else if let d = dest {
            op = d.draggingUpdated(self)
        }
        source.draggingSession?(session, movedTo: w.convertPoint(toScreen: p))
    }

    @discardableResult
    func drop(at p: NSPoint, in w: NSWindow) async throws -> [String: Any] {
        try await move(to: p, in: w)
        // WebKit answers draggingUpdated from the page's last reply: give the page a moment and ask again.
        try await QA.sleep(80)
        if let d = dest { op = d.draggingUpdated(self) }
        var performed = false, prepared = false
        if let d = dest, !op.isEmpty {
            prepared = d.prepareForDragOperation(self)
            if prepared {
                performed = d.performDragOperation(self)
                d.concludeDragOperation(self)
            }
        } else if let d = dest {
            d.draggingExited(self)
        }
        source.draggingSession?(session, endedAt: w.convertPoint(toScreen: p), operation: performed ? op : [])
        let target = dest.map { String(describing: type(of: $0)) } ?? "none"
        Self.current = nil
        // The pasteboard is only this drag's: let it go once the page has read it.
        let pb = pasteboard
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { pb.releaseGlobally() }
        return ["performed": performed, "prepared": prepared, "operation": Int(op.rawValue), "target": target, "types": (pasteboard.types ?? []).map(\.rawValue)]
    }

    // NSDraggingInfo
    var draggingDestinationWindow: NSWindow? { win }
    var draggingSourceOperationMask: NSDragOperation {
        source.draggingSession(session, sourceOperationMaskFor: .withinApplication)
    }
    var draggingLocation: NSPoint { loc }
    var draggedImageLocation: NSPoint { loc }
    var draggedImage: NSImage? { nil }
    var draggingPasteboard: NSPasteboard { pasteboard }
    var draggingSource: Any? { source }
    var draggingSequenceNumber: Int { sequence }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    var draggingFormation: NSDraggingFormation = .none
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass],
                                searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
                                using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {
        // Like the system's: the pasteboard's items read as the classes asked for (WebKit asks for
        // NSFilePromiseReceiver to take the file a sidebar card promises), each in a dragging item.
        var stop: ObjCBool = false
        let wantsPromises = classArray.contains { $0 == NSFilePromiseReceiver.self }
        guard wantsPromises else {
            for (i, it) in items.enumerated() { block(it, i, &stop); if stop.boolValue { break } }
            return
        }
        for (i, obj) in promised.enumerated() {
            guard let alloc = (NSDraggingItem.self as AnyObject).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue(),
                  let made = (alloc as AnyObject).perform(NSSelectorFromString("initWithPasteboardWriter:"), with: obj)?.takeUnretainedValue() as? NSDraggingItem else { continue }
            if let v = view {
                made.draggingFrame = NSRect(origin: v.convert(loc, from: nil), size: NSSize(width: 1, height: 1))
            }
            block(made, i, &stop)
            if stop.boolValue { break }
        }
    }
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}

/// The QA instance's pointer and keyboard: what NSEvent.pressedMouseButtons, mouseLocation and modifierFlags answer.
enum QAPointer {
    nonisolated(unsafe) static var buttons = 0
    nonisolated(unsafe) static var location = NSPoint.zero
    nonisolated(unsafe) static var mods: NSEvent.ModifierFlags = []
}

extension NSEvent {
    @objc class var qa_pressedMouseButtons: Int { QAPointer.buttons }
    @objc class var qa_mouseLocation: NSPoint { QAPointer.location }
    @objc class var qa_modifierFlags: NSEvent.ModifierFlags { QAPointer.mods }
}

/// The source of a file drag from outside the app (qa.files): it offers a copy, as Finder does.
final class QAFileDragSource: NSObject, NSDraggingSource {
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
}

/// A promised file, fulfilled in place: writes the payload the source promised into the destination folder.
final class QAPromiseReceiver: NSFilePromiseReceiver {
    private let types: [String]
    private let data: Data
    init(types: [String], data: Data) { self.types = types; self.data = data; super.init() }
    required init?(pasteboardPropertyList propertyList: Any, ofType type: NSPasteboard.PasteboardType) { return nil }
    override var fileTypes: [String] { types }
    override var fileNames: [String] { ["promised"] }
    override func receivePromisedFiles(atDestination destinationDir: URL, options: [AnyHashable: Any] = [:], operationQueue: OperationQueue,
                                       reader: @escaping (URL, (any Error)?) -> Void) {
        let url = destinationDir.appendingPathComponent("promised")
        let data = self.data
        operationQueue.addOperation {
            do { try data.write(to: url); reader(url, nil) } catch { reader(url, error) }
        }
    }
}

extension NSApplication {
    /// A QA instance never takes focus from the person using the Mac.
    @objc func qa_activate(ignoringOtherApps flag: Bool) {}
    @objc func qa_activateCooperatively() {}
    @objc func qa_hide(_ sender: Any?) { MainActor.assumeIsolated { QA.hides.append("app") } }
    @objc func qa_hideOthers(_ sender: Any?) { MainActor.assumeIsolated { QA.hides.append("others") } }
    /// Swapped in for validateMenuItem: calling qa_validateMenuItem runs the original.
    @objc func qa_validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(NSApplication.hide(_:)) || item.action == #selector(NSApplication.hideOtherApplications(_:)) { return true }
        return qa_validateMenuItem(item)
    }
    @objc func qa_validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(NSApplication.hide(_:)) || item.action == #selector(NSApplication.hideOtherApplications(_:)) { return true }
        return qa_validateUserInterfaceItem(item)
    }
}

extension NSSavePanel {
    /// Swapped in for runModal (see QA.install): the panel is noted, never shown, and cancelled.
    @objc func qa_runModal() -> NSApplication.ModalResponse {
        let title = self.title ?? ""
        MainActor.assumeIsolated { QA.panels.append(title) }
        return .cancel
    }
}

extension NSView {
    /// Swapped in for WKWebView's own (see QA.install): every posted press reaches the page.
    @objc func qa_acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    /// System drag and drop stays inside the app: a virtual session the QA mouse drives.
    @objc func qa_beginDraggingSession(with items: [NSDraggingItem], event: NSEvent, source: NSDraggingSource) -> NSDraggingSession {
        let v = MainActor.assumeIsolated { () -> VirtualDrag in
            let v = VirtualDrag(items: items, source: source, view: self)
            VirtualDrag.current = v
            return v
        }
        return MainActor.assumeIsolated { v.session }
    }
}

extension NSTextView {
    @objc func qa_paste(_ sender: Any?) {
        if let text = canvasPasteboard.string(forType: .string) { insertText(text, replacementRange: selectedRange()) }
    }
}

/// qa.agents: the agents Settings > Agents shows as added, over what GET /api/mcp/setup says (Settings.swift loadSetup).
@MainActor
enum AgentsQA {
    static var added: Set<String> = []
}
#endif
