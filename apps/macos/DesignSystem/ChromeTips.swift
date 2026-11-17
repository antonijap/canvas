// Tooltips for the controls in the window's titlebar strip (the tab bar and the toolbar pill on the right).
//
// The window has a full-size content view under a transparent titlebar, and the top bar is drawn in that strip.
// AppKit's tooltip manager never shows a tooltip for a point inside the titlebar container (NSTitlebarContainerView
// sits above the content there), so `.help` on those controls stays silent however long the pointer rests, while
// the same `.help` on the left rail (below the strip) works. Hover itself still reaches the controls, so these
// views draw their own tip: after the system's delay, a small borderless panel at the pointer that never takes
// the mouse or the keyboard. Everywhere else `.chromeHelp` is plain `.help`.

import AppKit
import SwiftUI

private struct TitlebarTipsKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// True inside the titlebar strip: `.chromeHelp` draws its own tip there instead of `.help`.
    var titlebarTips: Bool {
        get { self[TitlebarTipsKey.self] }
        set { self[TitlebarTipsKey.self] = newValue }
    }
}

extension View {
    /// `.help(text)`, except in the titlebar strip, where AppKit shows no tooltips: there, the same text in a tip of ours.
    func chromeHelp(_ text: String) -> some View { modifier(ChromeHelp(text: text)) }
}

private struct ChromeHelp: ViewModifier {
    let text: String
    @Environment(\.titlebarTips) private var own
    @State private var token = UUID()

    func body(content: Content) -> some View {
        if own && !text.isEmpty {
            content
                .accessibilityHint(text)
                .onHover { inside in
                    if inside { ChromeTip.shared.hover(text, owner: token) } else { ChromeTip.shared.leave(owner: token) }
                }
                .onDisappear { ChromeTip.shared.leave(owner: token) }
        } else {
            content.help(text)
        }
    }
}

/// The one tip panel. Rest on a control for the system's tooltip delay and it shows; moving straight on to the
/// next control (within half a second) shows that one at once, as AppKit's own tooltips do. Any click, key,
/// scroll or the app going to the background hides it.
@MainActor final class ChromeTip {
    static let shared = ChromeTip()

    private var panel: NSPanel?
    private var host: NSHostingView<TipLabel>?
    private var owner: UUID?
    private var pending: DispatchWorkItem?
    private var hiddenAt = Date.distantPast
    private var monitor: Any?

    private var delay: TimeInterval {
        let ms = UserDefaults.standard.integer(forKey: "NSInitialToolTipDelay")
        return ms > 0 ? Double(ms) / 1000 : 0.75
    }

    func hover(_ text: String, owner id: UUID) {
        installMonitor()
        owner = id
        pending?.cancel()
        let quick = panel?.isVisible == true || Date().timeIntervalSince(hiddenAt) < 0.5
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.owner == id, NSApp.isActive else { return }
            self.show(text)
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (quick ? 0.05 : delay), execute: work)
    }

    func leave(owner id: UUID) {
        guard owner == id else { return }
        owner = nil
        hide()
    }

    func hide() {
        pending?.cancel()
        pending = nil
        if panel?.isVisible == true { hiddenAt = Date(); panel?.orderOut(nil) }
    }

    private func show(_ text: String) {
        let panel = self.panel ?? makePanel()
        host?.rootView = TipLabel(text: text)
        guard let host else { return }
        let size = host.fittingSize
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) }?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let origin = TipPlacement.origin(mouse: mouse, size: size, screen: screen)
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
        panel.orderFrontRegardless()
    }

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.ignoresMouseEvents = true
        p.level = .popUpMenu
        p.isReleasedWhenClosed = false
        p.hidesOnDeactivate = true
        p.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary, .canJoinAllSpaces]
        let h = NSHostingView(rootView: TipLabel(text: ""))
        p.contentView = h
        panel = p
        host = h
        return p
    }

    private func installMonitor() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel]) { e in
            MainActor.assumeIsolated { ChromeTip.shared.hide() }
            return e
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ChromeTip.shared.hide() }
        }
    }
}

/// The tip itself: AppKit's tooltip look, in the shell's palette.
struct TipLabel: View {
    let text: String
    var body: some View {
        Text(text)
            .font(Typography.micro)
            .foregroundStyle(Palette.fg)
            .lineLimit(4)
            .frame(maxWidth: 280, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 7).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Palette.popover))
            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(Palette.stroke, lineWidth: 1))
    }
}
