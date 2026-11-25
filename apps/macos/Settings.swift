// Canvas > Settings (Cmd+,): a macOS settings window with toolbar tabs, General, Canvas, Agents, Sounds, Performance,
// Privacy and Shortcuts, drawn with the design system. The values live in CanvasModel.prefs (SettingsLogic.swift) and
// CanvasModel.snap (snapping) and theme; changing one saves it and sends it
// where it is read (the page, the server) at once.

import AppKit
import SwiftUI

// MARK: Window

@MainActor
final class SettingsWindow {
    static let shared = SettingsWindow()
    private var window: NSWindow?

    enum Tab: String, CaseIterable {
        case general, canvas, agents, cloud, sounds, performance, privacy, shortcuts
        var title: String { rawValue.capitalized }
        var symbol: String {
            switch self {
            case .general: "gearshape"
            case .canvas: "square.on.square.dashed"
            case .agents: "sparkles"
            case .cloud: "cloud"
            case .sounds: "speaker.wave.2"
            case .performance: "gauge.with.dots.needle.67percent"
            case .privacy: "hand.raised"
            case .shortcuts: "keyboard"
            }
        }
    }

    func show(_ model: CanvasModel, tab: Tab? = nil) {
        if window == nil { window = make(model) }
        guard let window else { return }
        if let tab, let tabs = window.contentViewController as? SettingsTabs, let i = Tab.allCases.firstIndex(of: tab) { tabs.selectedTabViewItemIndex = i }
        if !window.isVisible {
            // The pane reports its height on its first layout: size the window to it before it shows.
            window.layoutIfNeeded()
            (window.contentViewController as? SettingsTabs)?.fit(animated: false)
            window.center()
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() { window?.orderOut(nil) }

    #if CANVAS_QA
    /// Discard pane-local state, including the Cloud filter, between scenarios.
    func resetForQA() { window?.close(); window = nil }
    #endif

    /// The window while it shows (a sheet opened from Settings > Cloud attaches to it).
    var nsWindow: NSWindow? { window?.isVisible == true ? window : nil }

    private func make(_ model: CanvasModel) -> NSWindow {
        // Read first: adding the first tab selects it, which saves it as the last tab.
        let saved = UserDefaults.standard.string(forKey: "canvas.settings.tab").flatMap(Tab.init) ?? .general
        let tabs = SettingsTabs()
        tabs.tabStyle = .toolbar
        for t in Tab.allCases {
            let host = ControlHostingController(rootView: SettingsPane(model: model, tab: t) { [weak tabs] h in tabs?.paneHeight(t.rawValue, h) })
            // The window follows the pane's reported height (SettingsTabs), nothing else sizes it.
            host.sizingOptions = []
            host.title = t.title
            let item = NSTabViewItem(viewController: host)
            item.label = t.title
            item.image = NSImage(systemSymbolName: t.symbol, accessibilityDescription: t.title)
            item.identifier = t.rawValue
            tabs.addTabViewItem(item)
        }
        let w = NSWindow(contentViewController: tabs)
        w.styleMask = [.titled, .closable]
        w.toolbarStyle = .preference
        w.isReleasedWhenClosed = false
        w.setFrameAutosaveName("CanvasSettings")
        tabs.selectedTabViewItemIndex = Tab.allCases.firstIndex(of: saved) ?? 0
        tabs.fit(animated: false)
        return w
    }
}

/// Toolbar tabs whose window takes the selected pane's own height, top edge kept, like the system's settings windows.
/// The one sizing path: every pane reports its content height (SettingsPane), on every change, and the window follows
/// the selected one's. Panes never resize the window themselves.
final class SettingsTabs: NSTabViewController {
    private var heights: [String: CGFloat] = [:]
    private var pending = false

    override func tabView(_ tabView: NSTabView, didSelect item: NSTabViewItem?) {
        super.tabView(tabView, didSelect: item)
        if let id = item?.identifier as? String { UserDefaults.standard.set(id, forKey: "canvas.settings.tab") }
        // Lay the new pane out now, so its height is reported before the window moves (one resize, not two).
        item?.viewController?.view.layoutSubtreeIfNeeded()
        fit(animated: view.window?.isVisible ?? false)
    }

    /// A pane's content height changed. Applied on the next turn of the run loop, outside SwiftUI's layout pass.
    func paneHeight(_ id: String, _ height: CGFloat) {
        guard height > 0, heights[id] != height else { return }
        heights[id] = height
        guard id == selectedID, !pending else { return }
        pending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pending = false
            // Only a tab switch animates. A height that arrives later (a pane's first layout, a status line) is applied
            // at once, so the window never moves under the pointer after the pane has drawn.
            self.fit(animated: false)
        }
    }

    private var selectedID: String? { tabViewItems[safe: selectedTabViewItemIndex]?.identifier as? String }

    func fit(animated: Bool) {
        guard let id = selectedID, let content = heights[id],
              let w = view.window ?? NSApp.windows.first(where: { $0.contentViewController === self }) else { return }
        let inner = w.contentRect(forFrameRect: w.frame)
        let frame = SettingsWindowFit.frame(current: w.frame, chrome: w.frame.height - inner.height, content: content,
                                            width: SettingsPane.width + w.frame.width - inner.width, visible: (w.screen ?? NSScreen.main)?.visibleFrame)
        guard frame != w.frame else { return }
        w.setFrame(frame, display: true, animate: animated && w.isVisible)
    }
}

private extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

// MARK: Panes

struct SettingsPane: View {
    static let width: CGFloat = 560
    @ObservedObject var model: CanvasModel
    let tab: SettingsWindow.Tab
    /// The pane's content height, on its first layout and on every change after: the window follows it.
    var onHeight: (CGFloat) -> Void = { _ in }
    @State private var contentHeight: CGFloat = 0

    /// Taller than this, the screen caps the window and the pane scrolls (the title bar and toolbar take the rest).
    private var capped: Bool { contentHeight > (NSScreen.main?.visibleFrame.height ?? 800) - 100 }

    var body: some View {
        // The content keeps its own height; the window takes it, up to the screen, and the pane scrolls past that.
        // The scroller shows only then: while the window catches up with a taller pane, a scroller would take width
        // and shift every control sideways for a moment.
        ScrollView(.vertical) {
            content
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0; onHeight($0) }
        }
        .scrollIndicators(capped ? .automatic : .never)
        .scrollBounceBehavior(.basedOnSize)
        .frame(width: SettingsPane.width)
        .background(Palette.canvasBg)
    }

    private var content: some View {
        Group {
            switch tab {
            case .general: GeneralSettings(model: model)
            case .canvas: CanvasSettings(model: model)
            case .agents: AgentSettings(model: model)
            case .cloud: CloudSettings(model: model)
            case .sounds: SoundSettings(model: model)
            case .performance: PerformanceSettings(model: model)
            case .privacy: PrivacySettings(model: model)
            case .shortcuts: ShortcutSettings()
            }
        }
        .frame(width: SettingsPane.width)
        .background(Palette.canvasBg)
    }
}

struct GeneralSettings: View {
    @ObservedObject var model: CanvasModel
    var body: some View {
        SettingsStack {
            SettingsCard(title: "Appearance") {
                SettingsRow("Theme") {
                    SettingsSegments(items: AppTheme.allCases.map { ($0.title, $0) }, selection: model.theme) { model.theme = $0 }.frame(width: 240)
                }
            }
            SettingsCard(title: "Zoom") {
                SettingsRow("Open files at") {
                    SettingsSegments(items: OpenView.allCases.map { ($0.title, $0) }, selection: model.prefs.openView) { model.prefs.openView = $0 }.frame(width: 280)
                }
                SettingsDivider()
                SettingsRow("Scroll to zoom", detail: "Scrolling zooms; \u{2318} and scroll pans") {
                    SettingsSwitch(isOn: $model.prefs.scrollZooms)
                }
            }
            SettingsCard(title: "Comments") {
                SettingsRow("Your name in comments", detail: "Shown on the comments you write") {
                    FieldBox {
                        TextField("Name", text: Binding(get: { model.prefs.commentName }, set: { model.prefs.commentName = String($0.prefix(60)) }))
                            .textFieldStyle(.plain).font(Typography.body)
                            .accessibilityLabel("Your name in comments").qaID("comment-name")
                    }
                    .frame(width: 200)
                }
                SettingsDivider()
                SettingsRow("Show my name on stickies and votes", detail: "Controls the name shown and stored on stickies, stickers and votes. Cloud history still records who edited.") {
                    SettingsSwitch(isOn: $model.prefs.showWhiteboardName).qaID("whiteboard-show-name")
                }
            }
            UpdateSettings()
        }
    }
}

struct CanvasSettings: View {
    @ObservedObject var model: CanvasModel
    var body: some View {
        SettingsStack {
            SettingsCard(title: "Snapping") {
                SettingsRow("Snap to objects", detail: "Hold \u{2318} while dragging to skip it") { SettingsSwitch(isOn: $model.snap.objects) }
                SettingsDivider()
                SettingsRow("Snap to pixel grid") { SettingsSwitch(isOn: $model.snap.pixel) }
                SettingsDivider()
                SettingsRow("Snap to blueprint") {
                    SettingsSwitch(isOn: $model.snap.blueprint).qaID("snap-to-blueprint")
                }
                SettingsDivider()
                SettingsRow("Show smart guides") { SettingsSwitch(isOn: $model.snap.guides) }
            }
            SettingsCard(title: "Nudge") {
                SettingsRow("Big nudge", detail: "Shift and an arrow key") {
                    StepperField(value: model.snap.bigNudge, range: 1...1000, step: 1, unit: "px", label: "Big nudge") { model.snap.bigNudge = SnapLimits.bigNudge($0) }
                }
            }
            SettingsCard(title: "Boards") {
                SettingsRow("Show board names") { SettingsSwitch(isOn: $model.prefs.boardLabels) }
            }
        }
    }
}

/// One card: a row per agent (Connect, or Connected, and a menu with its command, model and reasoning), the default
/// agent, the agent's cursor and the run cap. Connect runs the agent's own `mcp add` (POST /api/mcp/connect,
/// src/mcp-connect.ts); the commands are the Welcome card's (GET /api/mcp/setup, src/onboarding.ts).
struct AgentSettings: View {
    @ObservedObject var model: CanvasModel
    /// Per installed agent: the models it offers (id, label, the reasoning levels each takes) and its levels.
    @State private var offers: [String: AgentOffer] = [:]
    /// GET /api/mcp/setup: each agent's command, whether its CLI is installed and has Canvas added, and who talks now.
    @State private var setup: [String: Any] = [:]
    /// The agent whose command was just copied.
    @State private var copied: String?
    /// Agents whose Connect is running.
    @State private var busy: Set<String> = []
    /// A Connect's error, per agent, shown under its row until the next Connect.
    @State private var errors: [String: String] = [:]
    /// The next step after a Connect worked, per agent.
    @State private var notes: [String: String] = [:]
    @State private var hoveredMenu: String?

    var body: some View {
        SettingsStack {
            SettingsCard {
                ForEach(AgentHarness.allCases) { h in
                    agentRow(h)
                    SettingsDivider()
                }
                SettingsRow("Default agent") {
                    SettingsSegments(items: AgentHarness.allCases.map { ($0.title, $0) }, selection: model.prefs.harness) { model.prefs.harness = $0 }.frame(width: 200)
                }
                SettingsDivider()
                SettingsRow("Show the agent\u{2019}s cursor") { SettingsSwitch(isOn: $model.prefs.agentCursor) }
                SettingsDivider()
                SettingsRow("Cursor speed") {
                    SettingsSegments(items: CursorSpeed.allCases.map { ($0.title, $0) }, selection: model.prefs.cursorSpeed) { model.prefs.cursorSpeed = $0 }
                        .frame(width: 200).disabled(!model.prefs.agentCursor).opacity(model.prefs.agentCursor ? 1 : 0.5)
                }
                SettingsDivider()
                SettingsRow("Stop a run after") {
                    StepperField(value: model.prefs.runCapMin, range: SettingsLimits.runCap, step: 1, unit: "min", label: "Run time cap in minutes") { model.prefs.runCapMin = $0 }
                }
            }
            // Only an older MCP of this copy talks to Canvas (its agent session must restart), or only another copy's.
            if let line = ConnectCopy.status(setup) {
                Text(line).font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .qaID("connect-status", label: line)
            }
            Button { NSWorkspace.shared.open(ConnectCopy.otherAppsURL) } label: {
                Text(ConnectCopy.otherApps).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1)
                    .qaID("connect-other-apps", label: ConnectCopy.otherApps)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 14)
        }
        .task { await loadOffers() }
        // While the pane shows: each row follows its agent within a couple of seconds.
        .task {
            while !Task.isCancelled {
                await loadSetup()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    /// The agent's name, where it stands, and its menu; a Connect's error or next step under it.
    private func agentRow(_ h: AgentHarness) -> some View {
        let key = h.rawValue
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(h.title).font(Typography.body).foregroundStyle(Palette.fg).lineLimit(1).qaText(h.title)
                Spacer(minLength: 12)
                agentState(h)
                agentMenu(h)
            }
            .padding(.leading, 14).padding(.trailing, 8)
            .frame(height: 48)
            if let e = errors[key] {
                Text(e).font(Typography.micro).foregroundStyle(Palette.danger)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14).padding(.bottom, 12)
                    .qaID("connect-error-\(key)", label: e)
            } else if let n = notes[key] {
                Text(n).font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14).padding(.bottom, 12)
                    .qaID("connect-hint", label: n)
            }
        }
    }

    /// Connect (or Connecting...), a green dot and Connected once Canvas is added, Not installed, or Copied for a moment.
    @ViewBuilder private func agentState(_ h: AgentHarness) -> some View {
        let key = h.rawValue
        let b = ConnectCopy.button(installed: flag("installed", key), registered: flag("registered", key), busy: busy.contains(key))
        if copied == key {
            stateText("Copied", dot: nil).qaID("agent-copied-\(key)", label: "Copied")
        } else if b == "Added" {
            stateText("Connected", dot: Palette.ok)
                .help(talking(h) ? "\(h.title) is talking to Canvas now" : "Canvas is added to \(h.title)")
                .qaID("connect-\(key)", label: "Connected")
        } else if let b {
            FieldButton(title: b, symbol: nil) { connect(key, h.title) }
                .disabled(b != "Connect").opacity(b == "Connect" ? 1 : 0.6)
                .qaID("connect-\(key)", label: b)
        } else if !setup.isEmpty {
            stateText("Not installed", dot: nil).qaID("connect-\(key)", label: "Not installed")
        }
    }

    private func stateText(_ text: String, dot: Color?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let dot { StatusDot(color: dot, size: 7).qaID("status-dot") }
            Text(text).font(Typography.body).foregroundStyle(Palette.mutedFg).lineLimit(1).qaID("status-text", label: text)
        }
        .capCentered(13)
    }

    /// The row's menu: the command to paste into Terminal, then the model and reasoning level this agent runs with.
    private func agentMenu(_ h: AgentHarness) -> some View {
        let key = h.rawValue
        let offer = offers[key]
        return Menu {
            Button("Copy command") { copy(key) }.disabled(setup[key] == nil)
            Divider()
            Menu("Model") {
                pick("Default", model.prefs.model(h).isEmpty) { model.prefs.setModel(h, "") }
                ForEach(offer?.models ?? [], id: \.id) { m in
                    pick(m.label, model.prefs.model(h) == m.id) {
                        model.prefs.setModel(h, m.id)
                        if !efforts(h, model: m.id).contains(model.prefs.effort(h)) { model.prefs.setEffort(h, "") }
                    }
                }
            }
            .disabled(offer == nil)
            Menu("Reasoning") {
                pick("Default", model.prefs.effort(h).isEmpty) { model.prefs.setEffort(h, "") }
                ForEach(efforts(h, model: model.prefs.model(h)), id: \.self) { e in
                    pick(AgentOffer.effortTitle(e), model.prefs.effort(h) == e) { model.prefs.setEffort(h, e) }
                }
            }
            .disabled(offer == nil)
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 13, weight: .medium))
                .foregroundStyle(hoveredMenu == key ? Palette.fg : Palette.mutedFg)
                .frame(width: Metric.field, height: Metric.field)
                .background(Circle().fill(hoveredMenu == key ? Palette.hover : .clear))
                .contentShape(Circle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .onHover { on in withAnimation(Motion.fast) { hoveredMenu = on ? key : (hoveredMenu == key ? nil : hoveredMenu) } }
        .help("\(h.title): command, model and reasoning")
        .accessibilityLabel("\(h.title) options")
        .qaID("agent-menu-\(key)", label: h.title)
    }

    /// A menu item with a checkmark on the current choice.
    private func pick(_ title: String, _ on: Bool, _ action: @escaping () -> Void) -> some View {
        Toggle(title, isOn: Binding(get: { on }, set: { _ in action() }))
    }

    private func talking(_ h: AgentHarness) -> Bool {
        setup["connected"] as? Bool == true && ((setup["client"] as? String)?.lowercased().contains(h.rawValue) ?? false)
    }

    /// installed.claude, registered.codex and so on, from the setup answer.
    private func flag(_ group: String, _ key: String) -> Bool { (setup[group] as? [String: Any])?[key] as? Bool == true }

    /// The reasoning levels for an agent's chosen model (Codex lists them per model), else the agent's own.
    private func efforts(_ h: AgentHarness, model id: String) -> [String] {
        guard let o = offers[h.rawValue] else { return [] }
        if let m = o.models.first(where: { $0.id == id }), !m.efforts.isEmpty { return m.efforts }
        return o.efforts
    }

    private func loadOffers() async {
        var req = URLRequest(url: model.base.appendingPathComponent("api/agent/harnesses"))
        req.timeoutInterval = 5
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = j["harnesses"] as? [[String: Any]] else { return }
        var o: [String: AgentOffer] = [:]
        for h in list { if let id = h["id"] as? String { o[id] = AgentOffer(h) } }
        offers = o
    }

    private func loadSetup() async {
        var req = URLRequest(url: model.base.appendingPathComponent("api/mcp/setup"))
        req.timeoutInterval = 4
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              var j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        #if CANVAS_QA
        // qa.agents: an agent shown as installed with Canvas added, whatever this Mac has (QA.swift).
        for (group, on) in [("installed", AgentsQA.added), ("registered", AgentsQA.added)] {
            var g = j[group] as? [String: Any] ?? [:]
            for key in on { g[key] = true }
            j[group] = g
        }
        #endif
        setup = j
    }

    /// Runs the agent's own `mcp add` through the server, then shows the next step or the CLI's error.
    private func connect(_ key: String, _ title: String) {
        guard !busy.contains(key) else { return }
        busy.insert(key)
        errors[key] = nil
        notes[key] = nil
        Task {
            var req = URLRequest(url: model.base.appendingPathComponent("api/mcp/connect"))
            req.httpMethod = "POST"
            req.timeoutInterval = 30
            req.setValue("1", forHTTPHeaderField: "X-Canvas")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["agent": key])
            var answer: [String: Any]?
            if let (data, _) = try? await URLSession.shared.data(for: req) { answer = try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
            busy.remove(key)
            if answer?["ok"] as? Bool == true {
                notes[key] = answer?["message"] as? String ?? ConnectCopy.added(title)
                var reg = setup["registered"] as? [String: Any] ?? [:]
                reg[key] = true
                setup["registered"] = reg
            } else {
                errors[key] = answer?["error"] as? String ?? "Canvas did not answer. Copy the command from the \u{2026} menu into Terminal instead."
            }
            await loadSetup()
        }
    }

    private func copy(_ key: String) {
        guard let text = setup[key] as? String else { return }
        canvasPasteboard.clearContents()
        canvasPasteboard.setString(text, forType: .string)
        copied = key
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if copied == key { copied = nil } }
    }
}

/// What an installed agent offers in Settings > Agents (GET /api/agent/harnesses).
struct AgentOffer {
    struct Model { let id: String; let label: String; let efforts: [String] }
    var models: [Model]
    var efforts: [String]
    init(_ j: [String: Any]) {
        models = (j["models"] as? [[String: Any]] ?? []).compactMap { m in
            guard let id = m["id"] as? String, let label = m["label"] as? String else { return nil }
            return Model(id: id, label: label, efforts: m["efforts"] as? [String] ?? [])
        }
        efforts = j["efforts"] as? [String] ?? []
    }
    /// "xhigh" reads as "Extra high"; the rest are capitalised.
    static func effortTitle(_ e: String) -> String {
        switch e {
        case "xhigh": "Extra high"
        default: e.prefix(1).uppercased() + e.dropFirst()
        }
    }
}

struct SoundSettings: View {
    @ObservedObject var model: CanvasModel
    var body: some View {
        SettingsStack {
            SettingsCard(title: "When an agent finishes") {
                SettingsRow("Play a sound") { SettingsSwitch(isOn: $model.prefs.finishSound) }
                SettingsDivider()
                SettingsRow("Volume") {
                    HStack(spacing: 8) {
                        Slider(value: $model.prefs.soundVolume, in: 0...1).controlSize(.small).frame(width: 160, height: Metric.field)
                            .accessibilityLabel("Volume")
                        FieldButton(title: "Preview", symbol: "play.fill") { _ = FinishSound.play("Glass", volume: model.prefs.soundVolume) }
                    }
                    .disabled(!model.prefs.finishSound).opacity(model.prefs.finishSound ? 1 : 0.5)
                }
            }
        }
    }
}

struct PerformanceSettings: View {
    @ObservedObject var model: CanvasModel
    var body: some View {
        SettingsStack {
            SettingsCard(title: "Tabs") {
                SettingsRow("Tabs kept open", detail: "Switch back instantly; each one uses memory") {
                    StepperField(value: model.prefs.keptTabs, range: SettingsLimits.keptTabs, step: 1, unit: nil, label: "Tabs kept open") { model.prefs.keptTabs = $0 }
                }
            }
            SettingsCard(title: "Board snapshots") {
                SettingsRow("Cache size", detail: used) {
                    HStack(spacing: 8) {
                        StepperField(value: model.prefs.snapshotMB, range: SettingsLimits.snapshotMB, step: SettingsLimits.snapshotStep, unit: "MB", label: "Snapshot cache size in megabytes") { model.prefs.snapshotMB = $0 }
                        FieldButton(title: "Clear", symbol: nil) { model.snapshots("clear") }
                    }
                }
            }
        }
        .onAppear { model.snapshots("usage") }
    }

    private var used: String? {
        guard let b = model.snapshotBytes else { return nil }
        return b == 0 ? "Empty" : ByteCountFormatter.string(fromByteCount: Int64(b), countStyle: .file) + " used"
    }
}

/// Anonymous usage counts (src/usage-counts.ts): whether they are shared, whether a monthly random id goes with them,
/// what the website says about them, and the exact JSON for today (GET /api/usage/preview).
struct PrivacySettings: View {
    @ObservedObject var model: CanvasModel
    @State private var showing = false

    var body: some View {
        SettingsStack {
            VStack(alignment: .leading, spacing: 8) {
                SettingsCard(title: "Usage counts") {
                    SettingsRow("Share usage counts", detail: "How often each feature is used, sent once a day") { SettingsSwitch(isOn: $model.prefs.shareUsage) }
                    SettingsDivider()
                    SettingsRow("Help improve Canvas", detail: "Adds a random ID that changes every month") {
                        SettingsSwitch(isOn: Binding(get: { model.prefs.improveEffective }, set: { model.prefs.improveCanvas = $0 }))
                            .disabled(!model.prefs.shareUsage).opacity(model.prefs.shareUsage ? 1 : 0.5)
                    }
                    SettingsDivider()
                    SettingsRow("Today") {
                        HStack(spacing: 8) {
                            FieldButton(title: "What Canvas collects", symbol: "arrow.up.right") { NSWorkspace.shared.open(UsageLinks.privacy) }
                            FieldButton(title: "Show what\u{2019}s sent", symbol: nil) { showing = true }
                                .qaID("usage-show", label: "Show what\u{2019}s sent")
                                .popover(isPresented: $showing, arrowEdge: .bottom) { UsagePreview(base: model.base) }
                        }
                    }
                }
                Text("Counts only, like how many files you opened. Never file names, contents, prompts or anything about you.")
                    .font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
            }
        }
    }
}

/// Show what's sent: the body the next send would carry for today, exactly as the server builds it.
private struct UsagePreview: View {
    let base: URL
    @State private var json: String?
    @State private var note = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Today\u{2019}s counts").font(Typography.section).foregroundStyle(Palette.mutedFg).lineLimit(1)
            ScrollView {
                Text(json ?? "Asking Canvas\u{2026}")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.fg)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .qaID("usage-json", label: json)
            }
            .frame(height: 260)
            .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field.opacity(0.6)))
            if !note.isEmpty {
                Text(note).font(Typography.micro).foregroundStyle(Palette.mutedFg).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(width: 420)
        // Opaque, in the app's theme: the JSON reads the same over any window behind the popover.
        .background(Palette.popover)
        .task { await load() }
    }

    private func load() async {
        var req = URLRequest(url: base.appendingPathComponent("api/usage/preview"))
        req.timeoutInterval = 4
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { json = "Canvas did not answer"; return }
        guard j["share"] as? Bool == true, let text = j["json"] as? String else {
            json = "Nothing. Share usage counts is off."
            return
        }
        json = text
        note = j["sends"] as? Bool == true
            ? "Sent once the day ends (UTC), at the next launch or the next day."
            : "This build never sends. Only release builds do."
    }
}

struct ShortcutSettings: View {
    var body: some View {
        ScrollView {
            SettingsStack {
                ForEach(ShortcutCatalog.all) { g in
                    SettingsCard(title: g.title) {
                        ForEach(Array(g.rows.enumerated()), id: \.element.id) { i, r in
                            if i > 0 { SettingsDivider() }
                            SettingsRow(r.title, compact: true) { Keycaps(keys: r.keys) }
                        }
                    }
                }
            }
        }
        .scrollIndicators(.automatic)
        .frame(height: 560)
    }
}

// MARK: Pieces

/// The pane's column: cards 20 pt apart, 24 pt from the window's edges.
struct SettingsStack<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 20, content: content)
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A surface, titled or not: no border, a layered shadow lifts it off the window.
struct SettingsCard<Content: View>: View {
    var title: String? = nil
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { Text(title).font(Typography.section).foregroundStyle(Palette.mutedFg).lineLimit(1).padding(.leading, 14) }
            VStack(spacing: 0, content: content)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.popover))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .shadow(color: .black.opacity(0.05), radius: 0.5, y: 0.5)
                .shadow(color: .black.opacity(0.06), radius: 3, y: 1)
                .shadow(color: .black.opacity(0.05), radius: 12, y: 6)
        }
    }
}

/// Edge to edge: the rows carry the padding, the line runs the card's full width.
struct SettingsDivider: View {
    var body: some View { Rectangle().fill(Palette.line).frame(height: 1).frame(maxWidth: .infinity) }
}

struct SettingsRow<Control: View>: View {
    let title: String
    var detail: String?
    var compact = false
    @ViewBuilder var control: () -> Control

    init(_ title: String, detail: String? = nil, compact: Bool = false, @ViewBuilder control: @escaping () -> Control) {
        self.title = title; self.detail = detail; self.compact = compact; self.control = control
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(Typography.body).foregroundStyle(Palette.fg).lineLimit(1).qaText(title)
                if let detail { Text(detail).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).qaText(detail) }
            }
            Spacer(minLength: 12)
            control()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, compact ? 6 : 10)
        .frame(minHeight: compact ? 40 : 48)
    }
}

struct SettingsSwitch: View {
    static let on = Color(light: 0x3F3F46, dark: 0x8E8E93)
    @Binding var isOn: Bool
    var body: some View {
        // Neutral when on: blue belongs to the canvas selection.
        Toggle("", isOn: $isOn).labelsHidden().toggleStyle(.switch).controlSize(.small).tint(SettingsSwitch.on).frame(height: Metric.field)
    }
}

/// Text segments in one field-height well; the chosen one is neutral grey (never the accent).
struct SettingsSegments<Tag: Hashable>: View {
    let items: [(String, Tag)]
    let selection: Tag
    let onSelect: (Tag) -> Void
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items.indices, id: \.self) { i in
                let (title, tag) = items[i]
                Button { onSelect(tag) } label: {
                    Text(title).font(Typography.label).lineLimit(1).qaText(title)
                        .foregroundStyle(selection == tag ? Palette.fg : Palette.mutedFg)
                        .capCentered(12, weight: .medium)
                        .frame(maxWidth: .infinity).frame(height: Metric.field - 4)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField - 2, style: .continuous)
                            .fill(selection == tag ? Palette.popover : .clear)
                            .shadow(color: .black.opacity(selection == tag ? 0.12 : 0), radius: 1, y: 0.5))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(title)
                .accessibilityAddTraits(selection == tag ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field.opacity(0.6)))
    }
}

/// A number you can type or step: the field and its minus and plus share the field height.
struct StepperField: View {
    let value: Int
    let range: ClosedRange<Int>
    let step: Int
    let unit: String?
    let label: String
    let onChange: (Int) -> Void

    var body: some View {
        HStack(spacing: 4) {
            MiniButton(symbol: "minus", help: "Less", enabled: value > range.lowerBound, inRow: true) { onChange(max(range.lowerBound, value - step)) }
            FieldBox {
                TextField("", value: Binding(get: { value }, set: { onChange(SettingsLimits.clamp($0, range)) }), format: .number)
                    .textFieldStyle(.plain).font(Typography.body).monospacedDigit().multilineTextAlignment(.trailing)
                    .accessibilityLabel(label)
                if let unit { Text(unit).font(Typography.body).foregroundStyle(Palette.mutedFg).lineLimit(1) }
            }
            .frame(width: unit == nil ? 56 : 84)
            MiniButton(symbol: "plus", help: "More", enabled: value < range.upperBound, inRow: true) { onChange(min(range.upperBound, value + step)) }
        }
    }
}

/// A plain action at field height, so it lines up with the fields beside it.
struct FieldButton: View {
    let title: String
    let symbol: String?
    /// The one main action of a screen: the primary colours.
    var prominent = false
    /// As wide as its column and a control tall (About Canvas).
    var wide = false
    /// The right padding when the title's last letter needs its own (a closing d ends a point inside its advance).
    var trailing: CGFloat? = nil
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let symbol { Image(systemName: symbol).glyph(GlyphSize.field).qaID("field-button-glyph", label: title) }
                Text(title).font(Typography.label).lineLimit(1).qaID("field-button-text", label: title)
            }
            .capCentered(12, weight: .medium)
            .foregroundStyle(prominent ? Palette.primaryFg : Palette.fg)
            // Optical padding: a glyph's own side bearing adds about a point on its side, and a closing ellipsis
            // ends inside its advance, so those sides take a little less (measured: qa/native/scenarios-alignment.ts).
            .padding(.leading, symbol == nil ? 12 : 11.5).padding(.trailing, trailing ?? (title.hasSuffix("\u{2026}") ? 11 : 12))
            .frame(maxWidth: wide ? .infinity : nil).frame(height: wide ? Metric.control : Metric.field)
            .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous)
                .fill(prominent ? Palette.primary.opacity(hovering ? 0.88 : 1) : (hovering ? Palette.active : Palette.field.opacity(0.6))))
            .qaID("field-button", label: title)
            .contentShape(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

/// A shortcut as tight keycaps: one cap per key, SF Symbols for modifiers, Return and arrows.
struct Keycaps: View {
    let keys: [String]
    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(keys.enumerated()), id: \.offset) { _, k in
                Group {
                    if let s = ShortcutCatalog.symbols[k] {
                        Image(systemName: s).font(.system(size: 10, weight: .semibold))
                    } else {
                        Text(k).font(.system(size: 11, weight: .semibold)).lineLimit(1)
                    }
                }
                .foregroundStyle(Palette.fg)
                .frame(minWidth: 20, minHeight: 20)
                .padding(.horizontal, k.count > 1 ? 5 : 0)
                .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Palette.active))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(keys.joined(separator: " "))
    }
}

/// The finish cue (finish_work, Bridge.swift "sound") and its preview in Settings > Sounds.
enum FinishSound {
    @discardableResult
    static func play(_ name: String, volume: Double) -> Bool {
        guard let sound = (NSSound(named: NSSound.Name(name)) ?? NSSound(named: NSSound.Name("Hero")))?.copy() as? NSSound else { return false }
        sound.volume = Float(SettingsLimits.volume(volume))
        return sound.play()
    }
}

// MARK: About

/// Canvas > About Canvas: the icon, the name, the version with its commit, when this build was made, and the two
/// places to go from here (the website, a bug report with this build's details filled in).
@MainActor
final class AboutWindow {
    static let shared = AboutWindow()
    private var window: NSWindow?

    func show(website: URL, report: @escaping () -> Void) {
        if window == nil {
            let host = NSHostingController(rootView: AboutView(website: website, report: report))
            host.sizingOptions = [.preferredContentSize]
            let w = NSWindow(contentViewController: host)
            w.styleMask = [.titled, .closable, .fullSizeContentView]
            w.titlebarAppearsTransparent = true
            w.titleVisibility = .hidden
            w.title = "About Canvas"
            w.isMovableByWindowBackground = true
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct AboutView: View {
    let website: URL
    let report: () -> Void
    private let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    private let commit = Bundle.main.object(forInfoDictionaryKey: "CanvasCommit") as? String
    private let built = Bundle.main.object(forInfoDictionaryKey: "CanvasBuilt") as? String

    /// "Version 0.1.2 alpha": the commit and the build date sit in its tooltip and its menu.
    private var versionText: String { "Version \(version) alpha" }
    private var builtText: String? { AboutInfo.builtLine(built) }
    /// "Version 0.1.2 alpha (aede106), built Nov 17, 2026 at 2:46 PM": what Copy Version copies.
    private var details: String {
        var s = AboutInfo.versionLine(version: version, commit: commit).replacingOccurrences(of: "Version \(version)", with: versionText)
        if let b = builtText { s += ", built \(b)" }
        return s
    }

    var body: some View {
        VStack(spacing: 0) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 64, height: 64)
                .accessibilityHidden(true).qaID("about-icon")
            Text("Canvas").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.fg).lineLimit(1).qaText("Canvas").padding(.top, 22)
            Text(versionText)
                .font(Typography.body).foregroundStyle(Palette.mutedFg).lineLimit(1).padding(.top, 10)
                .help(details)
                .contextMenu {
                    Button("Copy Version") {
                        canvasPasteboard.clearContents()
                        canvasPasteboard.setString(details, forType: .string)
                    }
                    Divider()
                    if let commit, !commit.isEmpty { Text("Commit \(commit)") }
                    if let b = builtText { Text("Built \(b)") }
                }
                .qaID("about-version", label: versionText)
                // The commit and the build date: this line's tooltip (and its menu), read by qa:native as the line's details.
                .qaID("about-details", label: details)
            HStack(spacing: 8) {
                FieldButton(title: "Website", symbol: nil) { NSWorkspace.shared.open(website) }.qaID("about-button", label: "Website")
                FieldButton(title: "Report a Bug", symbol: nil, action: report).qaID("about-button", label: "Report a Bug")
            }
            .padding(.top, 28)
        }
        .padding(.horizontal, 40).padding(.top, 48).padding(.bottom, 32)
        .frame(width: 320)
    }
}

// MARK: Updates

/// Settings > General > Updates: Update automatically (Updater.swift; off, a newer version only offers its download)
/// and the version this is, with Check for Updates (or Restart to Update while one is ready).
struct UpdateSettings: View {
    @ObservedObject private var updater = Updater.shared
    var body: some View {
        SettingsCard(title: "Updates") {
            SettingsRow("Update automatically", detail: "Downloads new versions and installs them when Canvas restarts") {
                SettingsSwitch(isOn: $updater.automatic)
            }
            SettingsDivider()
            SettingsRow("Version \(updater.version)", detail: updater.ready.map { "Canvas \($0.version) is ready" } ?? (updater.busy ? "Checking\u{2026}" : nil)) {
                if updater.ready != nil {
                    FieldButton(title: "Restart to Update", symbol: nil) { updater.restartToUpdate() }
                } else {
                    FieldButton(title: "Check for Updates", symbol: nil) { updater.check(userInitiated: true) }
                        .disabled(updater.busy)
                }
            }
        }
    }
}
