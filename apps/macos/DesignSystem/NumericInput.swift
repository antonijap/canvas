// What every numeric field in the properties panel shares:
// - the leading glyph or letter is a scrub handle: hover shows the left-right resize cursor, a horizontal drag
//   changes the value (one unit per point, 1 per px; Shift ×10, Option ×0.1) with the pointer held in place;
// - Option over the label or the input, then a drag, scrubs too (OptionScrub); the pointer's height sets the speed:
//   up 2x, near 1x, down 1/2 then 1/4;
// - Up and Down step the value (same modifiers) and write at once; Return commits, Esc reverts;
// - a field takes arithmetic: "12*2", "(8+4)/2", "2^3", and "+8" / "*2" / "/2" / "^2" relative to the current value.
// A drag streams its values at most 30 times a second under one gesture id, so the server keeps the whole
// drag as one undo step (src/history.ts); the last value is always written on mouse up. Every value in between
// is drawn on the canvas at once as a preview (EditGesture.previewOnly, src/page/live.js).

import SwiftUI
import AppKit

/// The edit gesture in progress, sent with every write it makes (CanvasModel.update reads it).
enum EditGesture {
    static var current: String?
    /// True while a scrub hands CanvasModel.update a value only to draw (the canvas follows the drag at display
    /// rate); the throttled writes and the final one persist it.
    static var previewOnly = false
    /// The text a field committed when it was relative ("+10", "*2"): CanvasModel.update tells the server the change,
    /// so Edit > Repeat does the same change on another layer (src/repeat.ts). Set only around the commit.
    static var relative: String?
}

enum NumericInput {
    /// The step for one arrow press or one scrub unit under the held modifiers.
    static func step(_ flags: NSEvent.ModifierFlags) -> Double {
        if flags.contains(.shift) { return 10 }
        if flags.contains(.option) { return 0.1 }
        return 1
    }

    static func step(_ m: EventModifiers) -> Double {
        if m.contains(.shift) { return 10 }
        if m.contains(.option) { return 0.1 }
        return 1
    }

    /// The pure parts live in ShellLogic.swift (NumericExpr), where Tests/ShellLogicTests.swift checks them.
    static func clean(_ v: Double) -> Double { NumericExpr.clean(v) }
    static func clamp(_ v: Double, _ lo: Double?, _ hi: Double?) -> Double { NumericExpr.clamp(v, lo, hi) }
    /// A leading +, * or / applies to `current` (refused when there is none: a "Mixed" field); anything else is an expression.
    static func evaluate(_ text: String, current: Double?) -> Double? { NumericExpr.evaluate(text, current: current) }
}

/// Holds a drag's running value and sends it at most 30 times a second, then once more on release.
final class ScrubSession {
    let start: Double
    private(set) var value: Double
    private var units = 0.0
    private var lastSent: Double?
    private var lastSentAt = Date.distantPast
    private var pending: DispatchWorkItem?
    private let lo: Double?, hi: Double?
    private let write: (Double) -> Void
    let gesture = UUID().uuidString

    init(start: Double, min lo: Double?, max hi: Double?, write: @escaping (Double) -> Void) {
        self.start = start; value = start; self.lo = lo; self.hi = hi; self.write = write
    }

    /// `dx` in points; one point is one step. `speed`: Option-scrub's factor by height (ScrubSpeed): 2x moves
    /// two steps a point, 1/2 and 1/4 land on halves and quarters of the step.
    func move(_ dx: Double, step: Double, speed: Double = 1) -> Double {
        units += MixedStep.scrubUnits(dx, step: step) * speed
        // Snap to the step in use, so Shift lands on tens and Option on tenths.
        let snap = step * min(1, speed)
        let raw = start + units
        value = NumericInput.clean(NumericInput.clamp((raw / snap).rounded() * snap, lo, hi))
        preview()
        schedule()
        return value
    }

    /// Every new value is drawn on the canvas at once; writes stay throttled.
    private var lastPreview: Double?
    private func preview() {
        guard value != lastPreview else { return }
        lastPreview = value
        EditGesture.current = gesture
        EditGesture.previewOnly = true
        write(value)
        EditGesture.previewOnly = false
        EditGesture.current = nil
    }

    private func schedule() {
        let wait = 1.0 / 30 - Date().timeIntervalSince(lastSentAt)
        if wait <= 0 { send() } else if pending == nil {
            let w = DispatchWorkItem { [weak self] in self?.pending = nil; self?.schedule() }
            pending = w
            DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: w)
        }
    }

    private func send() {
        pending?.cancel(); pending = nil
        guard value != lastSent else { return }
        lastSent = value; lastSentAt = Date()
        EditGesture.current = gesture
        write(value)
        EditGesture.current = nil
    }

    /// The final write: whatever the throttle has not sent yet.
    func end() {
        pending?.cancel(); pending = nil
        if value != start || lastSent != nil { send() }
    }
}

/// The scrub handle: a glyph or letter that shows the resize cursor and turns horizontal drags into deltas.
struct ScrubHandle<Label: View>: View {
    var enabled = true
    var width: CGFloat = 18
    let begin: () -> Void
    let move: (_ dx: Double, _ step: Double) -> Void
    let end: () -> Void
    @ViewBuilder var label: () -> Label

    var body: some View {
        label()
            .frame(width: width, height: Metric.field)
            .contentShape(Rectangle())
            .overlay { if enabled { ScrubSurface(begin: begin, move: move, end: end) } }
    }
}

private struct ScrubSurface: NSViewRepresentable {
    let begin: () -> Void
    let move: (Double, Double) -> Void
    let end: () -> Void

    func makeNSView(context: Context) -> ScrubView { let v = ScrubView(); v.handlers = (begin, move, end); return v }
    func updateNSView(_ v: ScrubView, context: Context) { v.handlers = (begin, move, end) }

    final class ScrubView: NSView {
        var handlers: (() -> Void, (Double, Double) -> Void, () -> Void)?
        private var dragging = false
        private var locked = false

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            trackingAreas.forEach(removeTrackingArea)
            addTrackingArea(NSTrackingArea(rect: .zero, options: [.cursorUpdate, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
        }
        override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }
        override func cursorUpdate(with event: NSEvent) { NSCursor.resizeLeftRight.set() }
        override func mouseEntered(with event: NSEvent) { NSCursor.resizeLeftRight.set() }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func mouseDown(with event: NSEvent) {
            // The field loses focus first, so a typed but uncommitted value commits before the drag starts.
            window?.makeFirstResponder(nil)
            dragging = false
        }

        override func mouseDragged(with event: NSEvent) {
            if !dragging {
                dragging = true
                handlers?.0()
                // Hold the pointer still and hidden while the value moves.
                if CGAssociateMouseAndMouseCursorPosition(0) == .success { locked = true; NSCursor.hide() }
            }
            if event.deltaX != 0 { handlers?.1(Double(event.deltaX), NumericInput.step(event.modifierFlags)) }
        }

        override func mouseUp(with event: NSEvent) { finish() }

        private func finish() {
            if locked { CGAssociateMouseAndMouseCursorPosition(1); NSCursor.unhide(); locked = false }
            if dragging { dragging = false; handlers?.2() }
            NSCursor.resizeLeftRight.set()
        }

        override func viewWillMove(toWindow newWindow: NSWindow?) {
            // A field that vanishes mid-drag (selection changed) must give the pointer back.
            if newWindow == nil, locked || dragging { finish() }
            NotificationCenter.default.removeObserver(self)
            super.viewWillMove(toWindow: newWindow)
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window else { return }
            // A drag whose mouse-up never arrives (app switch, window closes) still ends and gives the pointer back.
            let nc = NotificationCenter.default
            nc.addObserver(self, selector: #selector(interrupted), name: NSApplication.didResignActiveNotification, object: nil)
            nc.addObserver(self, selector: #selector(interrupted), name: NSWindow.didResignKeyNotification, object: window)
        }

        @objc private func interrupted() { if locked || dragging { finish() } }
    }
}

/// Option-scrub: hold Option over a field's label or input, press and drag; left and right change the value,
/// the pointer's height from the press sets the speed (up 2x, near 1x, down 1/2 then 1/4: ScrubSpeed). Shift x10.
/// The view lies over the whole field but never takes a click itself (hitTest is nil): a local event monitor takes
/// only an Option press inside it, so typing and plain clicks reach the text field as before.
struct OptionScrub: NSViewRepresentable {
    var enabled: Bool
    let begin: () -> Void
    let move: (_ dx: Double, _ step: Double, _ speed: Double) -> Void
    let end: () -> Void

    func makeNSView(context: Context) -> OptionScrubView { let v = OptionScrubView(); v.enabled = enabled; v.handlers = (begin, move, end); return v }
    func updateNSView(_ v: OptionScrubView, context: Context) { v.enabled = enabled; v.handlers = (begin, move, end) }
    static func dismantleNSView(_ v: OptionScrubView, coordinator: ()) { v.stop() }

    final class OptionScrubView: NSView {
        var enabled = true
        var handlers: (() -> Void, (Double, Double, Double) -> Void, () -> Void)?
        private var monitor: Any?
        private var pressed = false, dragging = false, locked = false
        private var dy = 0.0
        private var last: NSPoint?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil { stop(); return }
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp, .mouseMoved, .flagsChanged]) { [weak self] e in
                self?.handle(e) ?? e
            }
        }

        func stop() {
            if pressed || dragging { finish() }
            if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
        }

        private func inside(_ e: NSEvent) -> Bool {
            guard let window, e.window === window || e.windowNumber == window.windowNumber, !isHiddenOrHasHiddenAncestor else { return false }
            let p = convert(e.type == .flagsChanged ? window.mouseLocationOutsideOfEventStream : e.locationInWindow, from: nil)
            return bounds.contains(p)
        }

        private func handle(_ e: NSEvent) -> NSEvent? {
            switch e.type {
            case .leftMouseDown:
                guard enabled, e.modifierFlags.contains(.option), inside(e) else { return e }
                // The field loses focus first, so a typed but uncommitted value commits before the drag starts.
                window?.makeFirstResponder(nil)
                pressed = true; dragging = false; dy = 0; last = e.locationInWindow
                return nil
            case .leftMouseDragged:
                guard pressed else { return e }
                // A locked pointer reports deltas and stays put; posted events (QA) carry only locations.
                var dx = Double(e.deltaX), ddy = Double(e.deltaY)
                if dx == 0 && ddy == 0, let l = last { dx = e.locationInWindow.x - l.x; ddy = -(e.locationInWindow.y - l.y) }
                last = e.locationInWindow
                if !dragging {
                    dragging = true
                    handlers?.0()
                    #if !CANVAS_QA
                    if CGAssociateMouseAndMouseCursorPosition(0) == .success { locked = true; NSCursor.hide() }
                    #endif
                }
                dy += ddy
                if dx != 0 { handlers?.1(dx, e.modifierFlags.contains(.shift) ? 10 : 1, ScrubSpeed.factor(dy: dy)) }
                return nil
            case .leftMouseUp:
                guard pressed else { return e }
                finish()
                return nil
            case .mouseMoved, .flagsChanged:
                if enabled, e.modifierFlags.contains(.option), inside(e) { NSCursor.resizeLeftRight.set() }
                return e
            default:
                return e
            }
        }

        private func finish() {
            if locked { CGAssociateMouseAndMouseCursorPosition(1); NSCursor.unhide(); locked = false }
            if dragging { handlers?.2() }
            pressed = false; dragging = false; last = nil
        }
    }
}

/// The arrow keys, Esc and the value math every numeric text field takes. `apply` writes a value at once.
struct NumericKeys: ViewModifier {
    @Binding var text: String
    let current: () -> Double?
    var min: Double?
    var max: Double?
    /// A "Mixed" field: steps each layer from its own value (CanvasModel.stepEach) instead of doing nothing.
    var step: ((Double) -> Void)? = nil
    let apply: (Double) -> Void
    let revert: () -> Void

    func body(content: Content) -> some View {
        content
            .onKeyPress(keys: [.upArrow, .downArrow]) { press in
                let d = NumericInput.step(press.modifiers) * (press.key == .upArrow ? 1 : -1)
                // A "Mixed" field has no value to step from: each layer steps from its own.
                guard let base = NumericInput.evaluate(text, current: current()) ?? current() else { step?(d); return .handled }
                let v = NumericInput.clean(NumericInput.clamp(base + d, min, max))
                text = NumberField.format(v)
                apply(v)
                return .handled
            }
            .onKeyPress(.escape) { revert(); return .handled }
    }
}
