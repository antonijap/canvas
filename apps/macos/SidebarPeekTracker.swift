import AppKit

/// Watches the pointer for SidebarPeek. It takes no clicks, so the edge strip never gets in the way of the canvas.
/// While the sidebar peeks, a timer checks where the pointer is and whether the sidebar is in use.
/// It knows nothing of the model: Shell.swift hands it the peek state and what else holds the sidebar.
final class SidebarPeekTrackerView: NSView {
    var peek: () -> SidebarPeek = { SidebarPeek() }
    var setPeek: (SidebarPeek) -> Void = { _ in }
    /// Something besides the pointer keeps the sidebar: its own menu, a resize, a QA hold.
    var heldElsewhere: () -> Bool = { false }
    var canPeek = false
    var panelWidth: CGFloat = 0
    /// The title bar's height: the edge strip starts below it.
    var top: CGFloat = 38
    /// The widest the pointer may wander while peeking, at least as far as the sidebar toggle in the title bar.
    var holdWidth: CGFloat = 0
    /// Where the pointer is, in window coordinates; tests set it.
    var pointer: (() -> NSPoint)?
    private var monitor: Any?
    private var timer: Timer?
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

    /// The pointer's moves come from a local event monitor, not a tracking area: the canvas web view under this view
    /// takes the window's mouse-moved events, so a tracking area here never saw one and the edge never peeked.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        removeMonitor()
        guard let window else { return }
        window.acceptsMouseMovedEvents = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            MainActor.assumeIsolated { self?.moved(event) }
            return event
        }
    }

    private func removeMonitor() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    private func moved(_ event: NSEvent) {
        // Only this window's pointer: the monitor sees the whole app's events.
        guard let window, event.window === window, !peek().shown else { return }
        let p = convert(event.locationInWindow, from: nil)
        var next = peek()
        next.moved(x: p.x, y: p.y, top: top,
                   allowed: canPeek && NSEvent.pressedMouseButtons == 0 && window.attachedSheet == nil)
        if next.shown { setPeek(next) }
    }

    /// Off for good: the view is leaving the window.
    func stop() {
        watch(false)
        removeMonitor()
    }

    func watch(_ on: Bool) {
        if !on {
            timer?.invalidate()
            timer = nil
            buttonWasDown = false
        } else if timer == nil {
            let t = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            // Common modes: it keeps counting while a menu or a drag runs its own loop.
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
    }

    func tick() {
        guard let window else { return }
        let p = convert(pointer?() ?? window.mouseLocationOutsideOfEventStream, from: nil)
        // The whole height counts, so the pointer can travel up to the toggle in the title bar.
        let inside = bounds.contains(p) && p.x <= max(panelWidth, holdWidth)
        // Only a press that began on the sidebar holds it; a drag on the canvas does not.
        let down = NSEvent.pressedMouseButtons != 0
        if down && !buttonWasDown { pressedInside = inside }
        buttonWasDown = down
        var held = menuOpen || window.attachedSheet != nil || heldElsewhere() || (down && pressedInside)
        // A name or search field being typed in on the sidebar.
        if let field = window.firstResponder as? NSTextView {
            let f = convert(field.visibleRect, from: field)
            if f.midX <= panelWidth && f.midY >= top { held = true }
        }
        var next = peek()
        next.tick(inside: inside, held: held, allowed: canPeek, now: ProcessInfo.processInfo.systemUptime)
        if next != peek() { setPeek(next) }
    }
}
