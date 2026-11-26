import AppKit
import os

/// What the peek did and why it did not, for `log show --predicate 'subsystem == "cc.getcanvas.app" && category == "peek"'`.
let peekLog = Logger(subsystem: "cc.getcanvas.app", category: "peek")

/// Watches the pointer for SidebarPeek. It takes no clicks and needs no mouse events: while the sidebar is hidden and
/// the window shows, a timer reads where the pointer is on screen about 30 times a second. Mouse-moved events were
/// not enough: the canvas web view takes them, the window's resize border eats the first points of the edge, and an
/// app that is not active gets none.
/// It knows nothing of the model: Shell.swift hands it the peek state and what else holds the sidebar.
final class SidebarPeekTrackerView: NSView {
    var peek: () -> SidebarPeek = { SidebarPeek() }
    var setPeek: (SidebarPeek) -> Void = { _ in }
    /// Something besides the pointer keeps the sidebar: its own menu, a resize, a QA hold.
    var heldElsewhere: () -> Bool = { false }
    /// The sidebar is hidden by the toggle and has room.
    var canPeek = false
    /// The sidebar is shown the normal way: nothing to poll for.
    var pinned = true
    var panelWidth: CGFloat = 0
    /// The widest the pointer may wander while peeking, at least as far as the sidebar toggle in the title bar.
    var holdWidth: CGFloat = 0
    /// The sidebar toggle in window points from the top left, and whether its own hover saw the pointer.
    var toggleFrame: () -> CGRect = { .zero }
    var toggleHovered: () -> Bool = { false }

    // What the poll reads; tests replace them.
    /// The pointer in screen coordinates.
    var screenPointer: () -> NSPoint = { NSEvent.mouseLocation }
    /// The frontmost window at a screen point, of any app.
    var windowNumberAt: (NSPoint) -> Int = { NSWindow.windowNumber(at: $0, belowWindowWithWindowNumber: 0) }
    var mouseButtons: () -> Int = { NSEvent.pressedMouseButtons }

    private(set) var timer: Timer?
    private var observers: [NSObjectProtocol] = []
    private var menuOpen = false
    private var buttonWasDown = false
    private var pressedInside = false

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override init(frame: NSRect) {
        super.init(frame: frame)
        NotificationCenter.default.addObserver(self, selector: #selector(menuBegan), name: NSMenu.didBeginTrackingNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(menuEnded), name: NSMenu.didEndTrackingNotification, object: nil)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    @objc private func menuBegan() { menuOpen = true }
    @objc private func menuEnded() { menuOpen = false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        peekLog.notice("tracker window=\(self.window != nil, privacy: .public) pinned=\(self.pinned, privacy: .public) canPeek=\(self.canPeek, privacy: .public)")
        removeObservers()
        if let window {
            let nc = NotificationCenter.default
            let names: [(Notification.Name, AnyObject?)] = [
                (NSWindow.didMiniaturizeNotification, window), (NSWindow.didDeminiaturizeNotification, window),
                (NSWindow.didChangeOcclusionStateNotification, window), (NSWindow.willCloseNotification, window),
                (NSApplication.didHideNotification, nil), (NSApplication.didUnhideNotification, nil),
            ]
            for (name, object) in names {
                observers.append(nc.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.update() }
                })
            }
        }
        update()
    }

    private func removeObservers() {
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
    }

    /// Whether the pointer can peek the sidebar at all: hidden by the toggle, in a window that shows.
    var shouldPoll: Bool {
        guard let window, !pinned else { return false }
        return window.isVisible && !window.isMiniaturized
    }

    /// Starts or stops the poll to match `shouldPoll`. Shell.swift calls it on every change; window events too.
    func update() {
        if shouldPoll {
            guard timer == nil else { return }
            var next = peek()
            next.begin(toggle: toggleHovered())
            if next != peek() { setPeek(next) }
            let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.poll() }
            }
            // Common modes: it keeps counting while a menu or a drag runs its own loop.
            RunLoop.main.add(t, forMode: .common)
            timer = t
            peekLog.notice("poll on canPeek=\(self.canPeek, privacy: .public)")
        } else if let t = timer {
            t.invalidate()
            timer = nil
            buttonWasDown = false
            let why = pinned ? "pinned" : window == nil ? "no window" : window!.isMiniaturized ? "minimized" : "window hidden"
            peekLog.notice("poll off: \(why, privacy: .public)")
            if peek().shown { var next = peek(); next.close(); setPeek(next) }
        }
    }

    /// Off for good: the view is leaving the window.
    func stop() {
        removeObservers()
        timer?.invalidate()
        timer = nil
    }

    /// One pointer sample; the timer calls it, tests call it with their own clock.
    func poll(now: Double = ProcessInfo.processInfo.systemUptime) {
        guard let window else { return }
        let frame = window.frame
        let screen = screenPointer()
        let p = SidebarPeek.windowPoint(screen: screen, frame: frame)
        let inEdge = SidebarPeek.inEdge(screen: screen, frame: frame)
        let toggleRect = toggleFrame()
        let overToggle = toggleHovered() || (!toggleRect.isEmpty && toggleRect.contains(p))
        // This window is the one on top there. Just left of the window counts as its edge, so look a point inside.
        var onTop = true
        if inEdge || overToggle {
            let probe = NSPoint(x: max(screen.x, frame.minX + 1), y: screen.y)
            onTop = windowNumberAt(probe) == window.windowNumber
        }
        // The whole height counts, so the pointer can travel up to the toggle in the title bar.
        let inside = p.x >= 0 && p.x <= max(panelWidth, holdWidth) && p.y >= 0 && p.y <= frame.height
        // Only a press that began on the sidebar holds it; a drag on the canvas does not.
        let down = mouseButtons() != 0
        if down && !buttonWasDown { pressedInside = inside }
        buttonWasDown = down
        var held = menuOpen || window.attachedSheet != nil || heldElsewhere() || (down && pressedInside)
        // A name or search field being typed in on the sidebar.
        if let field = window.firstResponder as? NSTextView {
            let f = convert(field.visibleRect, from: field)
            if f.midX <= panelWidth && f.midY >= 0 { held = true }
        }
        let block: String? = down ? "button down" : window.attachedSheet != nil ? "sheet"
            : !onTop ? "another window on top" : nil
        var next = peek()
        let event = next.poll(edge: inEdge, toggle: overToggle, inside: inside, held: held, canPeek: canPeek,
                              block: block, now: now)
        if next != peek() { setPeek(next) }
        guard let event else { return }
        let x = Int(p.x.rounded()), y = Int(p.y.rounded())
        switch event {
        case .opened(let t): peekLog.notice("open by \(t.rawValue, privacy: .public) x=\(x, privacy: .public) y=\(y, privacy: .public)")
        case .closed: peekLog.notice("close x=\(x, privacy: .public) y=\(y, privacy: .public)")
        case .blocked(let t, let why):
            peekLog.notice("blocked \(t.rawValue, privacy: .public): \(why, privacy: .public) x=\(x, privacy: .public) y=\(y, privacy: .public)")
        }
    }
}
