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
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func make(_ model: CanvasModel) -> NSWindow {
        // Read first: adding the first tab selects it, which saves it as the last tab.
        let saved = UserDefaults.standard.string(forKey: "canvas.settings.tab").flatMap(Tab.init) ?? .general
        let tabs = SettingsTabs()
        tabs.tabStyle = .toolbar
        for t in Tab.allCases {
            let host = NSHostingController(rootView: SettingsPane(model: model, tab: t))
            host.sizingOptions = [.preferredContentSize]
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

/// Toolbar tabs whose window takes each pane's own height, top edge kept, like the system's settings windows.
final class SettingsTabs: NSTabViewController {
    override func tabView(_ tabView: NSTabView, didSelect item: NSTabViewItem?) {
        super.tabView(tabView, didSelect: item)
        if let id = item?.identifier as? String { UserDefaults.standard.set(id, forKey: "canvas.settings.tab") }
        fit(animated: view.window?.isVisible ?? false)
    }

    func fit(animated: Bool) {
        guard let vc = tabViewItems[safe: selectedTabViewItemIndex]?.viewController else { return }
        let size = vc.view.fittingSize
        guard let w = view.window ?? NSApp.windows.first(where: { $0.contentViewController === self }), size.height > 0 else { return }
        let content = NSRect(origin: .zero, size: NSSize(width: SettingsPane.width, height: size.height))
        var frame = w.frameRect(forContentRect: content)
        frame.origin = NSPoint(x: w.frame.minX, y: w.frame.maxY - frame.height)
        w.setFrame(frame, display: true, animate: animated)
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

    var body: some View {
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

struct AgentSettings: View {
    @ObservedObject var model: CanvasModel
    @State private var installed: Set<String>?
    /// Per installed agent: the models it offers (id, label, the reasoning levels each takes) and its levels.
    @State private var offers: [String: AgentOffer] = [:]

    var body: some View {
        SettingsStack {
            ConnectAgentCard(model: model)
            SettingsCard(title: "Ask about the selection") {
                SettingsRow("Default agent") {
                    SettingsSegments(items: AgentHarness.allCases.map { ($0.title, $0) }, selection: model.prefs.harness) { model.prefs.harness = $0 }.frame(width: 220)
                }
                ForEach(AgentHarness.allCases) { h in
                    SettingsDivider()
                    SettingsRow(h.title, detail: h == model.prefs.harness ? "Runs first" : "Runs when the other is missing") {
                        InstallState(installed: installed.map { $0.contains(h.rawValue) })
                    }
                }
                SettingsDivider()
                SettingsRow("Stop a run after") {
                    StepperField(value: model.prefs.runCapMin, range: SettingsLimits.runCap, step: 1, unit: "min", label: "Run time cap in minutes") { model.prefs.runCapMin = $0 }
                }
            }
            SettingsCard(title: "Model and reasoning") {
                ForEach(Array(AgentHarness.allCases.enumerated()), id: \.element) { i, h in
                    if i > 0 { SettingsDivider() }
                    SettingsRow(h.title, detail: offers[h.rawValue] == nil ? "Not installed" : "For asks and variations") {
                        HStack(spacing: 6) {
                            MenuField(title: modelTitle(h)) {
                                Button("Default") { model.prefs.setModel(h, "") }
                                ForEach(offers[h.rawValue]?.models ?? [], id: \.id) { m in
                                    Button(m.label) {
                                        model.prefs.setModel(h, m.id)
                                        if !efforts(h, model: m.id).contains(model.prefs.effort(h)) { model.prefs.setEffort(h, "") }
                                    }
                                }
                            }
                            .frame(width: 150).qaID("model-\(h.rawValue)")
                            MenuField(title: model.prefs.effort(h).isEmpty ? "Default" : AgentOffer.effortTitle(model.prefs.effort(h))) {
                                Button("Default") { model.prefs.setEffort(h, "") }
                                ForEach(efforts(h, model: model.prefs.model(h)), id: \.self) { e in
                                    Button(AgentOffer.effortTitle(e)) { model.prefs.setEffort(h, e) }
                                }
                            }
                            .frame(width: 110).qaID("effort-\(h.rawValue)")
                        }
                        .disabled(offers[h.rawValue] == nil).opacity(offers[h.rawValue] == nil ? 0.5 : 1)
                    }
                }
            }
            SettingsCard(title: "Agent cursor") {
                SettingsRow("Show the agent\u{2019}s cursor", detail: "Follows each edit an agent makes on the canvas") { SettingsSwitch(isOn: $model.prefs.agentCursor) }
                SettingsDivider()
                SettingsRow("Speed") {
                    SettingsSegments(items: CursorSpeed.allCases.map { ($0.title, $0) }, selection: model.prefs.cursorSpeed) { model.prefs.cursorSpeed = $0 }
                        .frame(width: 220).disabled(!model.prefs.agentCursor).opacity(model.prefs.agentCursor ? 1 : 0.5)
                }
            }
        }
        .task { await loadInstalled() }
    }

    private func modelTitle(_ h: AgentHarness) -> String {
        let id = model.prefs.model(h)
        if id.isEmpty { return "Default" }
        return offers[h.rawValue]?.models.first(where: { $0.id == id })?.label ?? id
    }

    /// The reasoning levels for an agent's chosen model (Codex lists them per model), else the agent's own.
    private func efforts(_ h: AgentHarness, model id: String) -> [String] {
        guard let o = offers[h.rawValue] else { return [] }
        if let m = o.models.first(where: { $0.id == id }), !m.efforts.isEmpty { return m.efforts }
        return o.efforts
    }

    private func loadInstalled() async {
        var req = URLRequest(url: model.base.appendingPathComponent("api/agent/harnesses"))
        req.timeoutInterval = 5
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = j["harnesses"] as? [[String: Any]] else { installed = []; return }
        installed = Set(list.compactMap { $0["id"] as? String })
        var o: [String: AgentOffer] = [:]
        for h in list { if let id = h["id"] as? String { o[id] = AgentOffer(h) } }
        offers = o
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

/// The commands that register Canvas MCP (as "canvas") with Claude Code and Codex, each with Connect (the app runs the
/// command: POST /api/mcp/connect, src/mcp-connect.ts) and Copy, and whether an agent is talking to Canvas now. The
/// Welcome card shows the same, in the same words (GET /api/mcp/setup, src/onboarding.ts; ConnectCopy).
struct ConnectAgentCard: View {
    @ObservedObject var model: CanvasModel
    @State private var setup: [String: Any] = [:]
    @State private var copied: String?
    /// Agents whose Connect is running.
    @State private var busy: Set<String> = []
    /// A Connect's error, per agent, shown under its command until the next Connect.
    @State private var errors: [String: String] = [:]
    /// The next step after a Connect worked.
    @State private var note: String?

    var body: some View {
        SettingsCard(title: "Connect an agent") {
            ForEach([("Claude Code", "claude"), ("Codex", "codex")], id: \.1) { title, key in
                if key != "claude" { SettingsDivider() }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Text(title).font(Typography.body).foregroundStyle(Palette.fg).lineLimit(1)
                        Spacer(minLength: 12)
                        if let b = ConnectCopy.button(installed: flag("installed", key), registered: flag("registered", key), busy: busy.contains(key)) {
                            FieldButton(title: b, symbol: b == "Added" ? "checkmark" : nil) { connect(key, title) }
                                .disabled(b != "Connect").opacity(b == "Connect" ? 1 : 0.6)
                                .qaID("connect-\(key)", label: b)
                        }
                        FieldButton(title: copied == key ? "Copied" : "Copy", symbol: copied == key ? "checkmark" : "doc.on.doc") { copy(key) }
                            .disabled(setup[key] == nil)
                    }
                    Text(setup[key] as? String ?? "Asking Canvas\u{2026}")
                        .font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.fg)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 10).padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field.opacity(0.6)))
                    if let e = errors[key] {
                        Text(e).font(Typography.micro).foregroundStyle(Palette.danger)
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            .qaID("connect-error-\(key)", label: e)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
            }
            SettingsDivider()
            SettingsRow("Status") {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    StatusDot(color: connected ? Palette.ok : Palette.mutedFg.opacity(0.5)).qaID("status-dot")
                    Text(connected ? "Connected\((setup["client"] as? String).map { ": \($0)" } ?? "")" : "Not connected")
                        .font(Typography.body).foregroundStyle(connected ? Palette.fg : Palette.mutedFg).lineLimit(1)
                        .qaID("status-text", label: connected ? "Connected" : "Not connected")
                }
                .capCentered(13)
                .frame(height: Metric.field)
            }
            VStack(alignment: .leading, spacing: 4) {
                if !connected || note != nil {
                    Text(note ?? ConnectCopy.hint).font(Typography.micro).foregroundStyle(Palette.mutedFg)
                        .fixedSize(horizontal: false, vertical: true)
                        .qaID("connect-hint", label: note ?? ConnectCopy.hint)
                }
                Button { NSWorkspace.shared.open(ConnectCopy.elsewhereURL) } label: {
                    Text(ConnectCopy.elsewhere).font(Typography.micro).foregroundStyle(Palette.mutedFg)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.bottom, 12)
        }
        // While the pane shows: the status follows the agent within a couple of seconds.
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private var connected: Bool { setup["connected"] as? Bool == true }

    /// installed.claude, registered.codex and so on, from the setup answer.
    private func flag(_ group: String, _ key: String) -> Bool { (setup[group] as? [String: Any])?[key] as? Bool == true }

    /// Runs the agent's own `mcp add` through the server, then shows the next step or the CLI's error.
    private func connect(_ key: String, _ title: String) {
        guard !busy.contains(key) else { return }
        busy.insert(key)
        errors[key] = nil
        note = nil
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
                note = answer?["message"] as? String ?? ConnectCopy.added(title)
                var reg = setup["registered"] as? [String: Any] ?? [:]
                reg[key] = true
                setup["registered"] = reg
            } else {
                errors[key] = answer?["error"] as? String ?? "Canvas did not answer. Copy the command into Terminal instead."
            }
            await load()
        }
    }

    private func load() async {
        var req = URLRequest(url: model.base.appendingPathComponent("api/mcp/setup"))
        req.timeoutInterval = 4
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        setup = j
    }

    private func copy(_ key: String) {
        guard let text = setup[key] as? String else { return }
        canvasPasteboard.clearContents()
        canvasPasteboard.setString(text, forType: .string)
        copied = key
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if copied == key { copied = nil } }
    }
}

/// Installed or not, neutral: a check for installed, plain text for missing.
private struct InstallState: View {
    let installed: Bool?
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if installed == true { Image(systemName: "checkmark.circle.fill").glyph(GlyphSize.row).foregroundStyle(Palette.fg).qaID("install-glyph") }
            Text(installed == nil ? "Checking" : installed! ? "Installed" : "Not installed")
                .font(Typography.body).foregroundStyle(installed == true ? Palette.fg : Palette.mutedFg).lineLimit(1)
                .qaID("install-text", label: installed == nil ? "Checking" : installed! ? "Installed" : "Not installed")
        }
        .capCentered(13)
        .frame(height: Metric.field)
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

/// A titled surface: no border, a layered shadow lifts it off the window.
struct SettingsCard<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Typography.section).foregroundStyle(Palette.mutedFg).lineLimit(1).padding(.leading, 14)
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
                if let detail { Text(detail).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1) }
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
            .padding(.leading, symbol == nil ? 12 : 11.5).padding(.trailing, title.hasSuffix("\u{2026}") ? 11 : 12)
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

    var body: some View {
        VStack(spacing: 0) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 96, height: 96)
                .accessibilityHidden(true).qaID("about-icon")
            Text("Canvas").font(Typography.appName).foregroundStyle(Palette.fg).qaText("Canvas").padding(.top, 14)
            // Optical padding: the A starts at its own edge, the a ends inside its advance.
            Text("Alpha").font(Typography.section).foregroundStyle(Palette.mutedFg)
                .padding(.leading, 7.5).padding(.trailing, 6.5).padding(.vertical, 2)
                .background(Capsule().fill(Palette.active))
                .qaID("about-alpha")
                .padding(.top, 6)
            Text(AboutInfo.versionLine(version: version, commit: commit))
                .font(Typography.body).foregroundStyle(Palette.mutedFg).textSelection(.enabled).padding(.top, 14)
                .qaID("about-version", label: AboutInfo.versionLine(version: version, commit: commit))
            if let b = AboutInfo.builtLine(built) {
                Text(b).font(Typography.body).foregroundStyle(Palette.mutedFg).padding(.top, 4).qaID("about-built", label: b)
            }
            VStack(spacing: 10) {
                FieldButton(title: "Website", symbol: nil, wide: true) { NSWorkspace.shared.open(website) }.qaID("about-button", label: "Website")
                FieldButton(title: "Report a Bug", symbol: nil, wide: true, action: report).qaID("about-button", label: "Report a Bug")
            }
            .padding(.top, 24)
        }
        .padding(.horizontal, 48).padding(.top, 40).padding(.bottom, 36)
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
