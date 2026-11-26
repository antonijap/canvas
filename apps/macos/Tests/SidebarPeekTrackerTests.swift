// Tests for SidebarPeekTracker.swift with real AppKit event delivery: synthesized mouse-moved events go through
// the app's own event queue (postEvent, nextEvent, sendEvent), the way the pointer's events do, into a window
// whose canvas is a web view under the tracker. Nothing moves the real pointer; the window sits off screen.
// Run from apps/macos:
//   swiftc -parse-as-library ShellLogic.swift SidebarPeekTracker.swift Tests/SidebarPeekTrackerTests.swift -o /tmp/peek-tests && /tmp/peek-tests

import AppKit
import WebKit

@main
struct SidebarPeekTrackerTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
        checks += 1
        if !ok { failures += 1; print("FAIL line \(line): \(what())") }
    }

    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        app.finishLaunching()
        edgePeeks()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    /// Runs the app's event loop for a moment, handing every queued event on the way the app does.
    @MainActor static func pump(_ seconds: Double = 0.05) {
        let until = Date(timeIntervalSinceNow: seconds)
        while let e = NSApp.nextEvent(matching: .any, until: until, inMode: .default, dequeue: true) { NSApp.sendEvent(e) }
    }

    /// A mouse-moved event at a point measured from the window's top left, as the pointer would make.
    @MainActor static func move(_ window: NSWindow, x: CGFloat, y: CGFloat) {
        let h = window.contentView!.bounds.height
        let e = NSEvent.mouseEvent(with: .mouseMoved, location: NSPoint(x: x, y: h - y), modifierFlags: [],
                                   timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                   context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
        NSApp.postEvent(e, atStart: false)
        pump()
    }

    @MainActor static func edgePeeks() {
        // Off every screen: nothing shows and nothing comes near the real pointer.
        let window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: 900, height: 600),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        window.contentView = root
        // The canvas: a web view filling the window, as in the app.
        let web = WKWebView(frame: root.bounds)
        web.autoresizingMask = [.width, .height]
        root.addSubview(web)
        let tracker = SidebarPeekTrackerView(frame: root.bounds)
        tracker.autoresizingMask = [.width, .height]
        root.addSubview(tracker)

        var peek = SidebarPeek()
        var pointer = NSPoint(x: 600, y: 300)
        tracker.peek = { peek }
        tracker.setPeek = { peek = $0 }
        tracker.canPeek = true
        tracker.panelWidth = 240
        tracker.top = 38
        tracker.holdWidth = 240
        tracker.pointer = { pointer }
        window.orderFrontRegardless()
        pump()

        move(window, x: 400, y: 300)
        check(!peek.shown, "the middle of the canvas does not peek")
        move(window, x: 4, y: 12)
        check(!peek.shown, "the title bar does not peek")
        move(window, x: 4, y: 300)
        check(peek.shown, "the pointer at the left edge below the top bar peeks")

        // Over the sidebar it stays.
        pointer = NSPoint(x: 120, y: 300)
        tracker.tick()
        pump(0.4)
        tracker.tick()
        check(peek.shown, "it stays while the pointer is over the sidebar")

        // Gone shortly after the pointer leaves.
        pointer = NSPoint(x: 600, y: 300)
        tracker.tick()
        pump(0.4)
        tracker.tick()
        check(!peek.shown, "it goes after the pointer leaves")

        // Pinned or hidden by Hide UI: the edge does nothing.
        tracker.canPeek = false
        move(window, x: 2, y: 300)
        check(!peek.shown, "no peek when it may not peek")

        // Another window's events never open it.
        tracker.canPeek = true
        let other = NSWindow(contentRect: NSRect(x: -32000, y: -30000, width: 400, height: 400),
                             styleMask: [.titled], backing: .buffered, defer: false)
        other.orderFrontRegardless()
        move(other, x: 2, y: 200)
        check(!peek.shown, "another window's pointer events do not peek")
        other.orderOut(nil)

        tracker.stop()
        move(window, x: 2, y: 300)
        check(!peek.shown, "a removed tracker does not peek")
        window.orderOut(nil)
    }
}
