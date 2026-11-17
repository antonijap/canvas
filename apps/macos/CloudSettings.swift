// Settings > Cloud: the team's own Canvas server (cloud/cloudflare), who is signed in there, and sharing a file's
// comments to it (File > Share Comments to Server). The shell only signs in: a small window shows the server's own
// Cloudflare Access login (a one-time email code), and when it lands on the server's /v1/me the `CF_Authorization`
// cookie is read from that window's cookie store. The token goes to the Keychain (Keychain.swift) and to the local
// server's memory (POST /api/cloud/token, src/cloud.ts), which sends it to that one server as `cf-access-token`. It is
// never a setting, never in a file or UserDefaults, and never logged. For a server on this Mac (http://localhost) the
// server's DEV mode needs no sign-in: the "Development email" below stands in for Access, for local tests only.
//
// Host on this Mac (docs/cloud/hosting.md): the local server runs a Cloud as its own process and reaches other Macs
// through an encrypted tunnel only (src/cloud-host.ts). Joining is an invite link: Canvas always asks first (the
// Cloud's name and a short fingerprint), and the link is copied, never shown. While hosting, the Mac does not sleep
// when idle; a closed lid still sleeps, and then the Cloud is down for everyone until it opens again.

import AppKit
import IOKit.pwr_mgt
import SwiftUI
import WebKit

/// What GET /api/cloud/status said.
struct CloudState: Equatable {
    var configured = false
    var status = "signedOut"
    var email: String?
    var role: String?
    var host = ""
    var hosted = false
}

/// What GET /api/cloud/host said: whether this Mac can host, whether it does, and who is in its Cloud.
struct HostState: Equatable {
    struct Person: Equatable, Identifiable {
        let id: String
        let label: String
        let role: String
        let devices: [String]
        let invited: Bool
    }
    var available = false
    var hosting = false
    var hostId: String?
    var fingerprint: String?
    var tunnel = "off"
    var people: [Person] = []

    init() {}
    init(_ j: [String: Any]) {
        available = j["available"] as? Bool ?? false
        hosting = j["hosting"] as? Bool ?? false
        hostId = j["hostId"] as? String
        fingerprint = j["fingerprint"] as? String
        tunnel = j["tunnel"] as? String ?? "off"
        people = (j["people"] as? [[String: Any]] ?? []).compactMap { p in
            guard let id = p["id"] as? String, let label = p["label"] as? String else { return nil }
            // "Ben's MacBook on 18 Nov": which Mac joined, and when.
            let devices = (p["devices"] as? [[String: Any]] ?? []).compactMap { d -> String? in
                guard let name = d["name"] as? String else { return nil }
                let iso = ISO8601DateFormatter()
                iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                guard let at = (d["joinedAt"] as? String).flatMap({ iso.date(from: $0) }) else { return name }
                return "\(name) on \(at.formatted(.dateTime.day().month(.abbreviated)))"
            }
            return Person(id: id, label: label, role: p["role"] as? String ?? "", devices: devices, invited: p["invite"] is [String: Any])
        }
    }
}

@MainActor
final class CloudAccount: ObservableObject {
    static let shared = CloudAccount()
    /// The Keychain service of the token (src/cloud.ts keychainService); its account is the server's host.
    static let service = "cc.getcanvas.canvas.cloud"

    @Published var state = CloudState()
    @Published var host = HostState()
    @Published var busy = false
    private var signIn: CloudSignInWindow?
    /// While hosting: no idle sleep (a closed lid still sleeps).
    private var awake: IOPMAssertionID = 0

    /// `fresh` asks the team's server again once its answer is 3 s old (on open and when Canvas comes to the front);
    /// otherwise a connected answer is reused for a minute (src/cloud.ts STATUS_REUSE_MS), so polling here stays local.
    func refresh(_ model: CanvasModel, fresh: Bool = false) async {
        var c = URLComponents(url: model.base.appendingPathComponent("api/cloud/status"), resolvingAgainstBaseURL: false)!
        if fresh { c.queryItems = [URLQueryItem(name: "fresh", value: "1")] }
        var req = URLRequest(url: c.url!)
        req.timeoutInterval = 15
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let next = CloudState(configured: j["configured"] as? Bool ?? false, status: j["status"] as? String ?? "offline",
                              email: j["email"] as? String, role: j["role"] as? String, host: j["host"] as? String ?? "",
                              hosted: j["hosted"] as? Bool ?? false)
        if next != state { state = next }
    }

    // MARK: Hosting

    func refreshHost(_ model: CanvasModel) async {
        var req = URLRequest(url: model.base.appendingPathComponent("api/cloud/host"))
        req.timeoutInterval = 15
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let next = HostState(j)
        if next != host { host = next }
        keepAwake(next.hosting)
    }

    /// The Mac stays awake while it hosts (idle sleep only: closing the lid still sleeps it, and the Cloud is down then).
    private func keepAwake(_ on: Bool) {
        if on, awake == 0 {
            var id: IOPMAssertionID = 0
            if IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                           "Canvas is hosting a Cloud" as CFString, &id) == kIOReturnSuccess { awake = id }
        } else if !on, awake != 0 {
            IOPMAssertionRelease(awake)
            awake = 0
        }
    }

    /// The name others see for this Mac's Cloud, and for its host.
    private func names(_ model: CanvasModel) -> [String: Any] {
        let cloud = model.prefs.cloudName.trimmingCharacters(in: .whitespaces)
        let me = model.prefs.commentName.trimmingCharacters(in: .whitespaces)
        return ["name": cloud.isEmpty ? "Cloud" : cloud, "label": me.isEmpty ? "Host" : me]
    }

    /// Host on this Mac, on: the Cloud starts, and this Canvas is its first member (as the owner, on loopback).
    func startHosting(_ model: CanvasModel) {
        busy = true
        Task {
            let (status, j) = await CloudAccount.post(model, "api/cloud/host/start", names(model))
            busy = false
            if status == 200, let id = j["hostId"] as? String {
                model.prefs.cloudHosting = true
                model.prefs.cloudUrl = "canvas-cloud://\(id)"
                if model.prefs.cloudName.trimmingCharacters(in: .whitespaces).isEmpty { model.prefs.cloudName = "Cloud" }
            } else {
                model.prefs.cloudHosting = false
                model.flash(j["error"] as? String ?? "Could not start hosting")
            }
            await refreshHost(model)
            await refresh(model, fresh: true)
        }
    }

    /// Canvas started with hosting on: start it again, quietly.
    func resumeHosting(_ model: CanvasModel) {
        guard model.prefs.cloudHosting else { return }
        Task {
            _ = await CloudAccount.post(model, "api/cloud/host/start", names(model))
            await refreshHost(model)
        }
    }

    /// Stop hosting: every member's access ends (they need a new invite), the tunnel stops.
    func stopHosting(_ model: CanvasModel) {
        let a = NSAlert()
        a.messageText = "Stop hosting this Cloud?"
        a.informativeText = "Everyone loses access now, and needs a new invite if you host again. The comments stay on this Mac until you delete them."
        a.addButton(withTitle: "Stop Hosting")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        Task {
            _ = await CloudAccount.post(model, "api/cloud/host/stop", [:])
            model.prefs.cloudHosting = false
            if CloudURL.isHosted(model.prefs.cloudUrl) { model.prefs.cloudUrl = "" }
            await refreshHost(model)
            await refresh(model)
        }
    }

    /// Delete hosted data: the Cloud's comments, people and history on this Mac. Copies others keep stay theirs.
    func deleteHostedData(_ model: CanvasModel) {
        let a = NSAlert()
        a.messageText = "Delete this Cloud\u{2019}s data?"
        a.informativeText = "The comments, people and history stored on this Mac for this Cloud are deleted. This cannot be undone. Copies that others keep, and Time Machine backups, are not touched."
        a.alertStyle = .warning
        a.addButton(withTitle: "Delete")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        Task {
            _ = await CloudAccount.post(model, "api/cloud/host/wipe", [:])
            model.prefs.cloudHosting = false
            if CloudURL.isHosted(model.prefs.cloudUrl) { model.prefs.cloudUrl = "" }
            await refreshHost(model)
            await refresh(model)
        }
    }

    /// Add person: a single-use invite (48 hours) goes to the clipboard. Its text is never shown on screen.
    func invite(_ model: CanvasModel, label: String) {
        let who = label.trimmingCharacters(in: .whitespaces)
        guard !who.isEmpty else { return }
        Task {
            let (status, j) = await CloudAccount.post(model, "api/cloud/host/invite", ["label": who, "role": "editor"])
            if status == 200, let link = j["link"] as? String {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(link, forType: .string)
                model.flash("Invite for \(who) copied. It works once, within 48 hours.", level: "success")
            } else {
                model.flash(j["error"] as? String ?? "Could not make an invite")
            }
            await refreshHost(model)
        }
    }

    func remove(_ model: CanvasModel, _ person: HostState.Person) {
        let a = NSAlert()
        a.messageText = "Remove \(person.label)?"
        a.informativeText = "Their Macs lose access now. Comments they already have stay on their Macs."
        a.addButton(withTitle: "Remove")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        Task {
            let (status, j) = await CloudAccount.post(model, "api/cloud/host/remove", ["personId": person.id])
            if status != 200 { model.flash(j["error"] as? String ?? "Could not remove them") }
            await refreshHost(model)
        }
    }

    // MARK: Joining

    /// Joining always asks first: the Cloud's name and the fingerprint to compare with the host's. Never on its own.
    func confirmJoin(_ model: CanvasModel, _ invite: CloudInvite) {
        let a = NSAlert()
        a.messageText = "Join \(invite.name)?"
        a.informativeText = "Fingerprint \(invite.fingerprint). Ask the host to read theirs from Settings > Cloud: they should match.\n\n" + CloudDisclosure.lines.joined(separator: " ")
        a.addButton(withTitle: "Join")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        busy = true
        Task {
            let device = Host.current().localizedName ?? "A Mac"
            let (status, j) = await CloudAccount.post(model, "api/cloud/join", ["link": invite.link, "device": device])
            busy = false
            if status == 200, let url = j["url"] as? String {
                model.prefs.cloudUrl = url
                model.prefs.cloudName = String((j["name"] as? String ?? invite.name).prefix(SettingsLimits.serverName))
                await refresh(model, fresh: true)
                announce(model)
            } else {
                model.flash(j["error"] as? String ?? "Could not join that Cloud")
            }
        }
    }

    /// Leaves a hosted Cloud: its invite is deleted from the Keychain and the tunnel stops.
    func leave(_ model: CanvasModel) {
        guard let url = CloudURL.clean(model.prefs.cloudUrl), CloudURL.isHosted(url) else { return }
        Task {
            _ = await CloudAccount.post(model, "api/cloud/leave", ["url": url])
            model.prefs.cloudUrl = ""
            await refresh(model)
        }
    }

    /// A local development server needs no window: its DEV mode takes the email in Settings. Any other server shows its login.
    func signIn(_ model: CanvasModel) {
        let url = model.prefs.cloudUrl
        guard let clean = CloudURL.clean(url) else { return }
        if CloudURL.isLocal(clean) { Task { await refresh(model, fresh: true); announce(model) }; return }
        signIn?.close()
        let w = CloudSignInWindow(origin: clean) { [weak self] token in
            guard let self else { return }
            self.signIn = nil
            self.store(token: token, origin: clean, model: model)
        }
        signIn = w
        w.show()
    }

    /// The Keychain first (it outlives this run), then the server's memory.
    private func store(token: String, origin: String, model: CanvasModel) {
        let host = CloudURL.host(origin)
        busy = true
        Task.detached {
            let saved = KeychainStore.set(service: CloudAccount.service, account: host, secret: token)
            _ = await CloudAccount.post(model, "api/cloud/token", ["url": origin, "token": token])
            await MainActor.run {
                if !saved { model.flash("Signed in, but the token could not be saved to the Keychain. You will sign in again after a restart.") }
                self.busy = false
            }
            await self.refresh(model, fresh: true)
            await self.announce(model)
        }
    }

    /// After a sign-in: Home opens on the team server and a toast says it worked, or says why it did not.
    func announce(_ model: CanvasModel) {
        let host = ServerName.host(model.prefs.cloudUrl)
        guard state.status == "connected" else {
            model.flash("Signed in, but \(host) says: \(CloudStatusText.line(state.status, configured: state.configured))")
            return
        }
        SettingsWindow.shared.close()
        if let w = model.webView.window {
            if w.isMiniaturized { w.deminiaturize(nil) }
            w.makeKeyAndOrderFront(nil)
        }
        HomeStore.shared.section = .server
        model.showHome()
        model.flash("You\u{2019}re connected to \(host)", level: "success")
    }

    func signOut(_ model: CanvasModel) {
        guard let origin = CloudURL.clean(model.prefs.cloudUrl) else { return }
        // A development server has no token: signing out forgets the development email.
        if CloudURL.isLocal(origin) { model.prefs.cloudDevEmail = ""; return }
        let host = CloudURL.host(origin)
        Task.detached {
            KeychainStore.delete(service: CloudAccount.service, account: host)
            _ = await CloudAccount.post(model, "api/cloud/signout", ["url": origin])
            await self.refresh(model)
        }
    }

    /// File > Share Comments to Server...: the open file's comments go to the configured server.
    func shareOpenFile(_ model: CanvasModel) {
        guard let file = model.currentFile else { model.flash("Open a Canvas file first"); return }
        guard CloudURL.clean(model.prefs.cloudUrl) != nil else {
            model.flash("Set your team's server address in Settings > Cloud first")
            SettingsWindow.shared.show(model, tab: .cloud)
            return
        }
        Task {
            let (status, j) = await CloudAccount.post(model, "api/cloud/share", [:], query: [URLQueryItem(name: "file", value: file)])
            if status == 200 {
                let host = CloudURL.host(model.prefs.cloudUrl)
                model.flash((j["already"] as? Bool == true) ? "Already shared. Connected to \(host)" : "Comments shared to \(host)", level: "success")
                model.reloadPage()
            } else {
                model.flash(j["error"] as? String ?? "Could not share the comments")
                if status == 401 { SettingsWindow.shared.show(model, tab: .cloud) }
            }
            await refresh(model)
        }
    }

    nonisolated static func post(_ model: CanvasModel, _ path: String, _ body: [String: Any], query: [URLQueryItem] = []) async -> (Int, [String: Any]) {
        var c = URLComponents(url: model.base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { c?.queryItems = query }
        guard let url = c?.url else { return (0, [:]) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, resp) = try? await URLSession.shared.data(for: req) else { return (0, [:]) }
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, j)
    }
}

// MARK: Sign-in window

/// A small window on the server's /v1/me: Cloudflare Access shows its own login, and once /v1/me answers with the
/// person's email the Access cookie of this window is the token. The window keeps nothing (a non-persistent store).
@MainActor
final class CloudSignInWindow: NSObject, WKNavigationDelegate, NSWindowDelegate {
    private let origin: String
    private let done: (String) -> Void
    private let web: WKWebView
    private let window: NSWindow
    private var finished = false

    init(origin: String, done: @escaping (String) -> Void) {
        self.origin = origin
        self.done = done
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 460, height: 620), configuration: cfg)
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Sign in to \(CloudURL.host(origin))"
        window.contentView = web
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        web.navigationDelegate = self
        if let u = URL(string: origin + "/v1/me") { web.load(URLRequest(url: u)) }
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func close() { finished = true; window.close() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !finished, webView.url?.path == "/v1/me", webView.url.map({ "\($0.scheme ?? "")://\($0.host ?? "")" + ($0.port.map { ":\($0)" } ?? "") }) == origin else { return }
        // The Access login also ends here once it lets the person through; only a JSON answer with an email counts.
        webView.evaluateJavaScript("document.body ? document.body.innerText : ''") { [weak self] result, _ in
            guard let self, let text = result as? String, let d = text.data(using: .utf8),
                  let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], (j["email"] as? String)?.isEmpty == false else { return }
            let host = webView.url?.host ?? ""
            webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
                let c = cookies.first { $0.name == "CF_Authorization" && host.hasSuffix($0.domain.hasPrefix(".") ? String($0.domain.dropFirst()) : $0.domain) }
                guard let token = c?.value, !token.isEmpty else { return }
                DispatchQueue.main.async {
                    guard let self, !self.finished else { return }
                    self.finished = true
                    self.window.close()
                    self.done(token)
                }
            }
        }
    }

    func windowWillClose(_ notification: Notification) { finished = true }
}

// MARK: The pane

struct CloudSettings: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject private var account = CloudAccount.shared

    private var urlText: String { model.prefs.cloudUrl.trimmingCharacters(in: .whitespaces) }
    private var valid: Bool { CloudURL.clean(urlText) != nil }
    private var local: Bool { CloudURL.isLocal(urlText) }
    private var signedIn: Bool { CloudStatusText.account(email: account.state.email, role: account.state.role) != nil && account.state.status != "signInAgain" && account.state.status != "signedOut" }
    private var tone: Color {
        switch account.state.status {
        case "connected": Palette.ok
        case "offline": Palette.mutedFg.opacity(0.5)
        default: account.state.configured ? Palette.warn : Palette.mutedFg.opacity(0.5)
        }
    }

    /// The address typed while none is saved; Sign in saves it.
    @State private var draft = ""
    /// Add person: the name or email of the next invite.
    @State private var invitee = ""

    var body: some View {
        Group {
            if CloudSetup.compact(model.prefs.cloudUrl) { setup } else { full }
        }
        // While this pane shows (rarely, and briefly): the server is asked every few seconds, so a fix or an outage shows
        // at once. Home asks far less often.
        .task(id: model.prefs.cloudUrl + "|" + model.prefs.cloudDevEmail) {
            try? await Task.sleep(nanoseconds: 600_000_000)
            while !Task.isCancelled {
                await account.refresh(model, fresh: true)
                await account.refreshHost(model)
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
        // The window takes the pane's height: the short card grows into the full one once an address is saved.
        .onChange(of: CloudSetup.compact(model.prefs.cloudUrl)) { SettingsWindow.shared.refit() }
    }

    /// No address saved: one field and Sign in. Account, status and sharing come once there is a server to talk to.
    private var setup: some View {
        let invite = CloudInvite.parse(draft)
        let hint = invite == nil ? CloudSetup.hint(draft) : nil
        return SettingsStack {
            SettingsCard {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        FieldBox {
                            TextField(CloudSetup.placeholder, text: Binding(get: { draft }, set: { draft = String($0.prefix(200)) }))
                                .textFieldStyle(.plain).font(Typography.body)
                                .onSubmit { saveAndSignIn() }
                                .accessibilityLabel("Server address").qaID("cloud-url")
                        }
                        .frame(maxWidth: .infinity)
                        if let invite {
                            FieldButton(title: "Join\u{2026}", symbol: nil, prominent: true) { draft = ""; account.confirmJoin(model, invite) }
                                .qaID("cloud-join", label: "Join")
                        } else {
                            FieldButton(title: "Sign in", symbol: nil, prominent: true) { saveAndSignIn() }
                                // Off, the system dims it by half: no extra opacity, or the label fades into the fill.
                                .disabled(CloudSetup.next(draft, devEmail: model.prefs.cloudDevEmail) == nil)
                                .qaID("cloud-sign-in", label: "Sign in")
                        }
                    }
                    if let hint {
                        Text(hint).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).qaText(hint)
                    }
                }
                .padding(14)
            }
            hostCard
        }
    }

    // MARK: Host on this Mac

    @ViewBuilder private var hostCard: some View {
        SettingsCard(title: "Host on this Mac") {
            SettingsRow("Host a Cloud", detail: account.host.available ? "Others join with an invite while this Mac is open" : "Needs the tunnel helper, which this build does not have") {
                SettingsSwitch(isOn: Binding(get: { account.host.hosting || (account.busy && model.prefs.cloudHosting) }, set: { on in
                    if on { account.startHosting(model) } else { account.stopHosting(model) }
                }))
                .disabled(!account.host.available || account.busy)
                .qaID("cloud-host", label: "Host a Cloud")
            }
            if account.host.hosting {
                SettingsDivider()
                SettingsRow("Fingerprint", detail: "People joining see the same one") {
                    Text(account.host.fingerprint ?? "\u{2013}").font(Typography.body).monospacedDigit().foregroundStyle(Palette.fg).lineLimit(1)
                        .qaID("cloud-fingerprint", label: account.host.fingerprint ?? "")
                }
                ForEach(account.host.people) { p in
                    SettingsDivider()
                    SettingsRow(p.label, detail: personDetail(p)) {
                        if p.role != "owner" {
                            FieldButton(title: "Remove", symbol: nil) { account.remove(model, p) }.qaID("cloud-remove", label: "Remove \(p.label)")
                        }
                    }
                }
                SettingsDivider()
                SettingsRow("Add person", detail: "Copies a link that works once, within 48 hours") {
                    HStack(spacing: 8) {
                        FieldBox {
                            TextField(String("ben@studio.test"), text: Binding(get: { invitee }, set: { invitee = String($0.prefix(120)) }))
                                .textFieldStyle(.plain).font(Typography.body)
                                .onSubmit { account.invite(model, label: invitee); invitee = "" }
                                .accessibilityLabel("Name or email").qaID("cloud-invitee")
                        }
                        .frame(width: 180)
                        FieldButton(title: "Copy Invite", symbol: "doc.on.doc") { account.invite(model, label: invitee); invitee = "" }
                            .disabled(invitee.trimmingCharacters(in: .whitespaces).isEmpty)
                            .qaID("cloud-invite", label: "Copy Invite")
                    }
                }
                SettingsDivider()
                SettingsRow("Hosted data", detail: "Comments and people stored on this Mac") {
                    FieldButton(title: "Delete\u{2026}", symbol: nil) { account.deleteHostedData(model) }.qaID("cloud-wipe", label: "Delete hosted data")
                }
            }
        }
        VStack(alignment: .leading, spacing: 4) {
            ForEach(CloudDisclosure.lines, id: \.self) { line in
                Text(line).font(Typography.micro).foregroundStyle(Palette.mutedFg).fixedSize(horizontal: false, vertical: true)
            }
            if account.host.hosting {
                Text("Closing this Mac\u{2019}s lid takes the Cloud down until it opens again.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
            }
        }
        .padding(.horizontal, 14)
        .qaID("cloud-disclosure")
    }

    private func personDetail(_ p: HostState.Person) -> String {
        if p.role == "owner" { return "You, the host" }
        if !p.devices.isEmpty { return "Joined from " + p.devices.joined(separator: ", ") }
        return p.invited ? "Invite waiting" : "No Mac joined"
    }

    /// Saves the typed address. A local server in DEV mode asks for the development email first (the full layout shows
    /// its field); any other server signs in at once, once the local server has the address (the shell's state goes
    /// out 100 ms after a change, Bridge.swift stateChanged).
    private func saveAndSignIn() {
        guard let next = CloudSetup.next(draft, devEmail: model.prefs.cloudDevEmail) else { return }
        model.prefs.cloudUrl = draft.trimmingCharacters(in: .whitespaces)
        draft = ""
        guard next == .signIn else { return }
        Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            account.signIn(model)
        }
    }

    private var full: some View {
        SettingsStack {
            SettingsCard(title: "Cloud") {
                    if !CloudURL.isHosted(urlText) {
                    SettingsRow("Server address", detail: CloudSetup.hint(urlText) ?? "Your team\u{2019}s own Canvas server") {
                        FieldBox {
                            TextField(CloudSetup.placeholder, text: Binding(get: { model.prefs.cloudUrl }, set: { model.prefs.cloudUrl = String($0.prefix(200)) }))
                                .textFieldStyle(.plain).font(Typography.body)
                                .accessibilityLabel("Server address").qaID("cloud-url")
                        }
                        .frame(width: 260)
                }
                    SettingsDivider()
                }
                SettingsRow("Name", detail: "What Home calls this server") {
                    FieldBox {
                        TextField(valid ? ServerName.display(urlText) : "Studio", text: Binding(get: { model.prefs.cloudName }, set: { model.prefs.cloudName = String($0.prefix(SettingsLimits.serverName)) }))
                            .textFieldStyle(.plain).font(Typography.body)
                            .accessibilityLabel("Server name").qaID("cloud-name")
                    }
                    .frame(width: 260)
                }
                if local && !CloudURL.isHosted(urlText) {
                    SettingsDivider()
                    SettingsRow("Development email", detail: "For a local server in DEV mode") {
                        FieldBox {
                            TextField(String("anna@studio.test"), text: Binding(get: { model.prefs.cloudDevEmail }, set: { model.prefs.cloudDevEmail = String($0.prefix(120)) }))
                                .textFieldStyle(.plain).font(Typography.body)
                                .accessibilityLabel("Development email").qaID("cloud-dev-email")
                        }
                        .frame(width: 260)
                    }
                }
                SettingsDivider()
                SettingsRow("Account", detail: CloudStatusText.account(email: account.state.email, role: account.state.role).flatMap { signedIn ? $0 : nil } ?? "Not signed in") {
                    if CloudURL.isHosted(urlText) {
                        if !account.host.hosting { FieldButton(title: "Leave", symbol: nil) { account.leave(model) }.qaID("cloud-leave", label: "Leave") }
                    } else if signedIn {
                        FieldButton(title: "Sign out", symbol: nil) { account.signOut(model) }.qaID("cloud-sign-out", label: "Sign out")
                    } else {
                        FieldButton(title: account.state.status == "signInAgain" ? "Sign in again" : "Sign in", symbol: nil) { account.signIn(model) }
                            .disabled(!valid || (local && model.prefs.cloudDevEmail.isEmpty)).opacity(!valid ? 0.5 : 1)
                            .qaID("cloud-sign-in", label: "Sign in")
                    }
                }
                SettingsDivider()
                SettingsRow("Status") {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        StatusDot(color: tone).qaID("status-dot")
                        Text(CloudStatusText.line(account.state.status, configured: account.state.configured))
                            .font(Typography.body).foregroundStyle(account.state.status == "connected" ? Palette.fg : Palette.mutedFg).lineLimit(1)
                            .qaID("cloud-status", label: CloudStatusText.line(account.state.status, configured: account.state.configured))
                            .help(CloudStatusText.detail(account.state.status, name: ServerName.label(urlText, name: model.prefs.cloudName)) ?? "")
                    }
                    .capCentered(13)
                }
            }
            hostCard
            SettingsCard(title: "Comments") {
                SettingsRow("Share the open file", detail: "Sends its comments to your server and keeps them in sync") {
                    FieldButton(title: "Share Comments\u{2026}", symbol: nil) { account.shareOpenFile(model) }
                        .disabled(model.currentFile == nil || account.state.status != "connected").opacity(model.currentFile == nil || account.state.status != "connected" ? 0.5 : 1)
                        .qaID("cloud-share", label: "Share Comments")
                }
            }
        }
    }
}
