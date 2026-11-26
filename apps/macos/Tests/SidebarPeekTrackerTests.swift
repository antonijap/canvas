// Tests for SidebarPeekTracker.swift: the poll reads an injected pointer and window lookup, in a real window whose
// canvas is a web view under the tracker. No mouse events are sent and nothing moves the real pointer; the window
// sits off screen.
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
        polls()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    @MainActor static func polls() {
        // Off every screen: nothing shows and nothing comes near the real pointer.
        let window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: 900, height: 600),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        window.contentView = root
        let web = WKWebView(frame: root.bounds)
        web.autoresizingMask = [.width, .height]
        root.addSubview(web)
        let tracker = SidebarPeekTrackerView(frame: root.bounds)
        tracker.autoresizingMask = [.width, .height]

        var peek = SidebarPeek()
        // The pointer in window points from the top left; the tracker gets it as a screen point.
        var pointer = NSPoint(x: 600, y: 300)
        var topWindow = 0
        var buttons = 0
        var toggleHover = false
        tracker.peek = { peek }
        tracker.setPeek = { peek = $0 }
        tracker.canPeek = true
        tracker.pinned = false
        tracker.panelWidth = 240
        tracker.holdWidth = 240
        tracker.toggleFrame = { CGRect(x: 100, y: 8, width: 28, height: 28) }
        tracker.toggleHovered = { toggleHover }
        tracker.screenPointer = { NSPoint(x: window.frame.minX + pointer.x, y: window.frame.maxY - pointer.y) }
        tracker.windowNumberAt = { _ in topWindow }
        tracker.mouseButtons = { buttons }

        check(tracker.timer == nil, "no poll outside a window")
        root.addSubview(tracker)
        check(tracker.timer == nil, "no poll while the window is not shown")
        window.orderFrontRegardless()
        tracker.update()
        check(tracker.timer != nil, "polls once the window shows")
        topWindow = window.windowNumber

        var now = 100.0
        func at(_ x: CGFloat, _ y: CGFloat, wait: Double = 0.05) { pointer = NSPoint(x: x, y: y); now += wait; tracker.poll(now: now) }

        at(400, 300)
        check(!peek.shown, "the middle of the canvas does not peek")
        at(4, 300)
        check(peek.shown, "the left edge peeks")
        at(120, 300); at(120, 300, wait: 0.5)
        check(peek.shown, "it stays while the pointer is over the sidebar")
        at(600, 300); at(600, 300, wait: 0.4)
        check(!peek.shown, "it goes after the pointer leaves")

        at(2, 12)
        check(peek.shown, "the title bar part of the edge peeks")
        at(600, 300); at(600, 300, wait: 0.4)
        at(-3, 300)
        check(peek.shown, "just left of the window peeks, for a window at the screen edge")
        at(600, 300); at(600, 300, wait: 0.4)

        topWindow = 12345
        at(4, 300)
        check(!peek.shown, "another window on top there does not peek")
        topWindow = window.windowNumber
        at(600, 300)

        buttons = 1
        at(4, 300)
        check(!peek.shown, "no peek with a button down")
        buttons = 0
        at(600, 300)

        tracker.canPeek = false
        at(2, 300)
        check(!peek.shown, "no peek when it may not peek")
        tracker.canPeek = true
        at(600, 300)

        // The toggle: by its frame (the poll) or its hover, after a short rest.
        at(110, 20)
        check(!peek.shown, "a moment on the toggle does not peek")
        at(110, 20, wait: 0.2)
        check(peek.shown, "resting on the toggle peeks")
        at(600, 300); at(600, 300, wait: 0.4)
        check(!peek.shown, "gone after leaving the toggle")
        toggleHover = true
        at(600, 300); at(600, 300, wait: 0.2)
        check(peek.shown, "the toggle's hover peeks too")
        toggleHover = false
        at(600, 300); at(600, 300, wait: 0.4)

        // Pinned: the poll stops; hidden again, it starts.
        tracker.pinned = true
        tracker.update()
        check(tracker.timer == nil, "pinned stops the poll")
        tracker.pinned = false
        tracker.update()
        check(tracker.timer != nil, "hidden again, it polls")

        // The real timer samples the pointer on its own.
        pointer = NSPoint(x: 3, y: 300)
        let until = Date(timeIntervalSinceNow: 0.2)
        while Date() < until { RunLoop.main.run(mode: .default, before: until) }
        check(peek.shown, "the timer finds the pointer at the edge without any event")

        window.orderOut(nil)
        tracker.update()
        check(tracker.timer == nil, "a hidden window stops the poll")
        tracker.stop()
    }
}
