// Settings > Cloud: every Cloud this Canvas talks to (any number of servers and joined Clouds, and at most eight this Mac
// hosts), who is signed in at each, and sharing a file's comments to one (File > Share Comments). The list lives in
// AppSettings.clouds (SettingsLogic.swift CloudList) and goes to the server with the shell's state, versioned; the
// server refuses any address that is not in it (src/cloud-config.ts). Home's sidebar has a row per Cloud; Add Cloud
// opens the sheet in AddCloud.swift's place below (AddCloudPanel).
//
// Signing in to a server: a small window shows the server's own Cloudflare Access login (a one-time email code), and
// when it lands on the server's /v1/me the `CF_Authorization` cookie is read from that window's cookie store. The token
// goes to the Keychain (Keychain.swift) and to the local server's memory (POST /api/cloud/token, src/cloud.ts), which
// sends it to that one server as `cf-access-token`. It is never a setting, never in a file or UserDefaults, and never
// logged. For a server on this Mac (http://localhost) the server's DEV mode needs no sign-in: the "Development email"
// stands in for Access, for local tests only.
//
// Host on this Mac (docs/cloud/hosting.md): the local server runs a Cloud as its own process and reaches other Macs
// through an encrypted tunnel only (src/cloud-host.ts). Joining is an invite link: Canvas always shows the Cloud's name,
// a short fingerprint and what being in a Cloud means before the person says Join, and the link is never shown. While
// hosting, the Mac does not sleep when idle; a closed lid still sleeps, and then the Cloud is down until it opens again.

import AppKit
import IOKit.pwr_mgt
import SwiftUI
import WebKit

/// What GET /api/cloud/status said about one Cloud.
struct CloudState: Equatable {
    var known = false
    var status = "offline"
    var email: String?
    var role: String?
    var host = ""
    var hosted = false
    var hostedHere = false

    init() {}
    init(_ j: [String: Any]) {
        known = true
        status = j["status"] as? String ?? "offline"
        email = j["email"] as? String
        role = j["role"] as? String
        host = j["host"] as? String ?? ""
        hosted = j["hosted"] as? Bool ?? false
        hostedHere = j["hostedHere"] as? Bool ?? false
    }
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
    var tunnelError: String?
    var people: [Person] = []
    var name = ""
    /// The first slot, where the single hosted Cloud of older versions lives.
    var legacy = false

    init() {}
    init(_ j: [String: Any]) {
        name = j["name"] as? String ?? ""
        legacy = j["legacy"] as? Bool ?? false
        available = j["available"] as? Bool ?? false
        hosting = j["hosting"] as? Bool ?? false
        hostId = j["hostId"] as? String
        fingerprint = j["fingerprint"] as? String
        tunnel = j["tunnel"] as? String ?? "off"
        tunnelError = j["tunnelError"] as? String
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
    /// The Keychain service of a server's token (src/cloud.ts keychainService); its account is the server's host.
    nonisolated static let service = "cc.getcanvas.canvas.cloud"

    /// Each Cloud's last answer, by its address. Only Clouds still in the list are kept.
    @Published private(set) var states: [String: CloudState] = [:]
    /// The Clouds this Mac hosts, by host id, and whether this build can host at all (the tunnel helper).
    @Published private(set) var hosts: [String: HostState] = [:]
    @Published private(set) var hostAvailable = false
    /// The most Clouds this Mac hosts (src/cloud-host.ts MAX_HOSTED).
    @Published private(set) var hostMax = CloudList.maxHosted
    /// Clouds with work under way (joining, signing in, removing), by address.
    @Published var busy: Set<String> = []
    /// Hosted Clouds starting, by host id ("new" for one being made).
    @Published private var startAttempts: [String: UUID] = [:]
    var starting: Set<String> { Set(startAttempts.keys) }
    /// The Cloud Settings > Cloud has open (an entry id); nil shows the list.
    @Published var selected: String?
    private var signIns: [String: CloudSignInWindow] = [:]
    private var hostRefreshGeneration = 0
    private var stoppingOrDeleting: Set<String> = []
    private var stoppedDuringCreation: Set<String> = []
    private var resumeTasks: [String: Task<Void, Never>] = [:]
    /// While hosting: no idle sleep (a closed lid still sleeps).
    private var awake: IOPMAssertionID = 0

    func state(_ e: CloudEntry) -> CloudState { states[e.url] ?? CloudState() }
    func entry(_ model: CanvasModel, id: String?) -> CloudEntry? { id.flatMap { id in model.prefs.clouds.first { $0.id == id } } }
    func entry(_ model: CanvasModel, url: String) -> CloudEntry? { model.prefs.clouds.first { $0.url == url } }

    /// Every Cloud's status in one ask. `fresh` asks the Clouds again once their answers are 3 s old (on open and when
    /// Canvas comes to the front); otherwise a connected answer is reused for a minute (src/cloud.ts STATUS_REUSE_MS).
    /// An answer for a Cloud removed meanwhile is dropped.
    func refresh(_ model: CanvasModel, fresh: Bool = false) async {
        // The shell posts list edits asynchronously. Home must not cache the old, empty list for 30 seconds.
        if let last = model.prefs.clouds.last {
            guard await waitListed(model, last.url), !Task.isCancelled else { return }
        }
        var c = URLComponents(url: model.base.appendingPathComponent("api/cloud/status"), resolvingAgainstBaseURL: false)!
        if fresh { c.queryItems = [URLQueryItem(name: "fresh", value: "1")] }
        var req = URLRequest(url: c.url!)
        req.timeoutInterval = 15
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let list = j["clouds"] as? [[String: Any]] else { return }
        let now = Set(model.prefs.clouds.map(\.url))
        var next: [String: CloudState] = [:]
        for c in list { if let url = c["url"] as? String, now.contains(url) { next[url] = CloudState(c) } }
        // A Cloud the server does not list yet (just added, its state not posted) keeps its last answer.
        for (url, s) in states where now.contains(url) && next[url] == nil { next[url] = s }
        if next != states { states = next }
    }

    /// Waits (up to 3 s) until the server has the shell's list with `url` in it (Bridge.swift posts the state 100 ms
    /// after a change). False if it never does.
    func waitListed(_ model: CanvasModel, _ url: String) async -> Bool {
        for _ in 0..<30 {
            var c = URLComponents(url: model.base.appendingPathComponent("api/cloud/status"), resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "url", value: url)]
            var req = URLRequest(url: c.url!)
            req.timeoutInterval = 5
            if let (_, r) = try? await URLSession.shared.data(for: req), (r as? HTTPURLResponse)?.statusCode == 200 { return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return false
    }

    // MARK: Adding

    /// Connect a server: the entry is added, then signed in (a local development server needs no window).
    @discardableResult
    func connectServer(_ model: CanvasModel, url: String, name: String, devEmail: String) -> CloudEntry? {
        guard let (list, e) = CloudList.add(model.prefs.clouds, url: url, name: name, devEmail: devEmail, kind: .server) else {
            model.flash(model.prefs.clouds.count >= SettingsLimits.clouds ? "Canvas keeps \(SettingsLimits.clouds) Clouds at most. Remove one first." : "That is not an address Canvas can use")
            return nil
        }
        model.prefs.clouds = list
        signIn(model, e)
        return e
    }

    /// Join with an invite: the person said Join in the sheet, after its name, fingerprint and what it means. The
    /// server checks the Cloud it reaches is the one the invite names; the entry is added once it answers. Nil when
    /// it worked, else why not.
    func join(_ model: CanvasModel, _ invite: CloudInvite) async -> String? {
        switch CloudInvite.check(invite, list: model.prefs.clouds, hostedIds: hostedIds(model)) {
        case .already: return "This Mac is already in that Cloud."
        case .hostsIt: return "This Mac hosts that Cloud."
        case .ok: break
        }
        busy.insert(invite.url)
        defer { busy.remove(invite.url) }
        let device = Host.current().localizedName ?? "A Mac"
        let (status, j) = await CloudAccount.post(model, "api/cloud/join", ["link": invite.link, "device": device])
        guard status == 200, let url = j["url"] as? String else { return j["error"] as? String ?? "Could not join that Cloud" }
        guard let (list, e) = CloudList.add(model.prefs.clouds, url: url, name: j["name"] as? String ?? invite.name, kind: .joined) else { return "Canvas keeps \(SettingsLimits.clouds) Clouds at most. Remove one first." }
        model.prefs.clouds = list
        _ = await waitListed(model, e.url)
        await refresh(model, fresh: true)
        announce(model, e)
        return nil
    }

    // MARK: Hosting

    /// What this Mac hosts: every hosted Cloud's state, by host id (GET /api/cloud/host).
    func refreshHost(_ model: CanvasModel) async {
        guard stoppingOrDeleting.isEmpty else { return }
        let generation = hostRefreshGeneration
        var req = URLRequest(url: model.base.appendingPathComponent("api/cloud/host"))
        req.timeoutInterval = 15
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              generation == hostRefreshGeneration, (response as? HTTPURLResponse)?.statusCode == 200,
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let clouds = j["clouds"] as? [[String: Any]] else { return }
        var next: [String: HostState] = [:]
        for c in clouds { let h = HostState(c); if let id = h.hostId { next[id] = h } }
        let available = j["available"] as? Bool ?? false
        if next != hosts { hosts = next }
        if available != hostAvailable { hostAvailable = available }
        let limit = CloudList.hostLimit(j["max"] as? Int)
        if limit != hostMax { hostMax = limit }
        keepAwake(next.values.contains { $0.hosting })
        reconcile(model)
    }

    /// The list agrees with what this Mac hosts (CloudList.reconcile): a Cloud an older version hosted, running or
    /// stopped, gets its entry; one it hosted when it quit starts again.
    private func reconcile(_ model: CanvasModel) {
        let d = UserDefaults.standard, key = AppSettings.prefix + CloudList.legacyHostingKey
        let legacy = d.bool(forKey: key)
        let infos = hosts.values.compactMap { h in h.hostId.map { HostedInfo(hostId: $0, name: h.name, hosting: h.hosting, legacy: h.legacy) } }
        let next = CloudList.reconcile(model.prefs.clouds, hosted: infos, legacyHosting: legacy)
        if next != model.prefs.clouds { model.prefs.clouds = next }
        guard legacy else { return }
        d.removeObject(forKey: key)
        resumeHosting(model)
    }

    /// A hosted Cloud's state (people, fingerprint, tunnel), by its entry.
    func host(_ e: CloudEntry) -> HostState { e.hostId.flatMap { hosts[$0] } ?? HostState() }
    /// Whether this Mac runs that hosted Cloud now.
    func isHosting(_ e: CloudEntry) -> Bool { e.kind == .hosted && host(e).hosting }
    func isResuming(_ e: CloudEntry) -> Bool { e.hostId.map { resumeTasks[$0] != nil } ?? false }
    /// The ids of the Clouds this Mac hosts (running or not): an invite to one of them is not joined.
    func hostedIds(_ model: CanvasModel) -> Set<String> { Set(hosts.keys).union(CloudList.hosted(model.prefs.clouds).compactMap(\.hostId)) }

    /// The Mac stays awake while it hosts (idle sleep only: closing the lid still sleeps it, and the Clouds are down then).
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

    /// The name others see for a hosted Cloud, and for its host.
    private func names(_ model: CanvasModel, name: String) -> [String: Any] {
        let cloud = name.trimmingCharacters(in: .whitespaces)
        let me = model.prefs.commentName.trimmingCharacters(in: .whitespaces)
        return ["name": cloud.isEmpty ? "Cloud" : cloud, "label": me.isEmpty ? "Host" : me]
    }

    private func setHosting(_ model: CanvasModel, _ id: String, _ on: Bool) {
        if let i = model.prefs.clouds.firstIndex(where: { $0.id == id }) { model.prefs.clouds[i].hosting = on }
    }

    /// Host on this Mac: with an entry, that Cloud again; without one, a new Cloud (this Mac hosts up to eight, one per
    /// team). This Canvas is each one's first member (the owner, on loopback). Nil when it worked, else why not.
    func startHosting(_ model: CanvasModel, entry: CloudEntry? = nil, name: String) async -> String? {
        let creating = entry == nil
        let key = entry?.hostId ?? "new"
        guard !stoppingOrDeleting.contains(key) else { return "Stop or Delete is already in progress." }
        guard startAttempts[key] == nil else { return "Hosting is already starting." }
        if creating {
            stoppedDuringCreation.removeAll()
            lastStarted = nil
        }
        let attemptID = UUID()
        startAttempts[key] = attemptID
        var body = names(model, name: name)
        if let id = entry?.hostId { body["hostId"] = id }
        let (status, j) = await CloudAccount.post(model, "api/cloud/host/start", body)
        guard startAttempts[key] == attemptID else { return nil }
        startAttempts[key] = nil
        guard status == 200, let url = j["url"] as? String else {
            await refreshHost(model)
            return j["error"] as? String ?? "Could not start hosting"
        }
        if creating, stoppedDuringCreation.contains(CloudURL.host(url)) { return nil }
        let given = name.trimmingCharacters(in: .whitespaces)
        if let (list, e) = CloudList.add(model.prefs.clouds, url: url, name: given.isEmpty && entry == nil ? "Cloud" : given, kind: .hosted) {
            model.prefs.clouds = list
            setHosting(model, e.id, true)
            if creating { lastStarted = e.id }
        }
        await refreshHost(model)
        _ = await waitListed(model, url)
        await refresh(model, fresh: true)
        return nil
    }
    /// The entry the Add Cloud sheet just created.
    private(set) var lastStarted: String?

    /// Resume the Clouds that were hosting at quit. The Keychain may still be locked at login.
    func resumeHosting(_ model: CanvasModel) {
        // Migration cannot identify the old hosted Cloud from its saved address. Discover it at launch first.
        if UserDefaults.standard.bool(forKey: AppSettings.prefix + CloudList.legacyHostingKey) {
            Task { await refreshHost(model) }
            return
        }
        let hosted = CloudList.hosted(model.prefs.clouds)
        guard !hosted.isEmpty else { return }
        for e in hosted where e.hosting {
            guard let id = e.hostId, startAttempts[id] == nil, !stoppingOrDeleting.contains(id) else { continue }
            let attemptID = UUID()
            startAttempts[id] = attemptID
            resumeTasks[id] = Task {
                defer {
                    if startAttempts[id] == attemptID {
                        resumeTasks[id] = nil
                        startAttempts[id] = nil
                    }
                }
                var body = names(model, name: e.name)
                body["hostId"] = id
                for attempt in 1...2 {
                    guard !Task.isCancelled, !stoppingOrDeleting.contains(id),
                          model.prefs.clouds.contains(where: { $0.id == e.id && $0.kind == .hosted && $0.hosting }) else { return }
                    let (status, response) = await CloudAccount.post(model, "api/cloud/host/start", body)
                    guard !Task.isCancelled else { return }
                    if status == 200 { break }
                    if attempt == 1 {
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                    } else {
                        model.flash(response["error"] as? String ?? "Could not start hosting", level: "error")
                    }
                }
                await refreshHost(model)
            }
        }
        if resumeTasks.isEmpty { Task { await refreshHost(model) } }
    }

    /// Drop polls already in flight. The last Stop or Delete to finish refreshes the list again.
    private func beginStoppingOrDeleting(_ model: CanvasModel, _ id: String) -> Bool {
        guard stoppingOrDeleting.insert(id).inserted else {
            model.flash("Stop or Delete is already in progress.")
            return false
        }
        hostRefreshGeneration += 1
        // A poll can list a new Cloud before Start's reply tells the Add Cloud sheet its ID.
        if startAttempts["new"] != nil { stoppedDuringCreation.insert(id) }
        resumeTasks.removeValue(forKey: id)?.cancel()
        startAttempts[id] = nil
        return true
    }

    /// Stop hosting one Cloud: everyone in it loses access (they need a new invite), its tunnel stops. It stays in the list.
    func stopHosting(_ model: CanvasModel, _ e: CloudEntry) {
        guard let id = e.hostId else { return }
        let a = NSAlert()
        a.messageText = "Stop hosting \(HomeLogic.cloudName(e))?"
        a.informativeText = isHosting(e)
            ? "Everyone in it loses access now, and needs a new invite if you host it again. The comments stay on this Mac until you delete the Cloud."
            : "This turns off automatic hosting for this Cloud."
        a.addButton(withTitle: "Stop Hosting")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn, beginStoppingOrDeleting(model, id) else { return }
        let wasHosting = model.prefs.clouds.first(where: { $0.id == e.id })?.hosting == true
        setHosting(model, e.id, false)
        Task {
            let (status, j) = await CloudAccount.post(model, "api/cloud/host/stop", ["hostId": id])
            if status != 200 {
                if status != 0, wasHosting { setHosting(model, e.id, true) }
                model.flash(j["error"] as? String ?? "Could not stop hosting")
            }
            stoppingOrDeleting.remove(id)
            await refreshHost(model)
            await refresh(model)
        }
    }

    /// Add person: a single-use invite (48 hours) to that hosted Cloud goes to the clipboard. Never shown on screen.
    func invite(_ model: CanvasModel, _ e: CloudEntry, label: String) {
        let who = label.trimmingCharacters(in: .whitespaces)
        guard !who.isEmpty, let id = e.hostId else { return }
        Task {
            // No role: a new person is an editor, someone already here keeps theirs.
            let (status, j) = await CloudAccount.post(model, "api/cloud/host/invite", ["label": who, "hostId": id])
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

    func remove(_ model: CanvasModel, _ e: CloudEntry, _ person: HostState.Person) {
        guard let id = e.hostId else { return }
        let a = NSAlert()
        a.messageText = "Remove \(person.label)?"
        a.informativeText = "Their Macs lose access to \(HomeLogic.cloudName(e)) now. Comments they already have stay on their Macs."
        a.addButton(withTitle: "Remove")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        Task {
            let (status, j) = await CloudAccount.post(model, "api/cloud/host/remove", ["personId": person.id, "hostId": id])
            if status != 200 { model.flash(j["error"] as? String ?? "Could not remove them") }
            await refreshHost(model)
        }
    }

    // MARK: Removing

    /// Settings and the sidebar edit the same local display name.
    func setCloudName(_ model: CanvasModel, _ e: CloudEntry, _ value: String) {
        guard let i = model.prefs.clouds.firstIndex(where: { $0.id == e.id }) else { return }
        model.prefs.clouds[i].name = String(value.prefix(SettingsLimits.serverName))
    }

    func renameCloud(_ model: CanvasModel, _ e: CloudEntry) {
        let alert = NSAlert()
        alert.messageText = "Rename Cloud"
        let field = NSTextField(string: HomeLogic.cloudName(e))
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        field.setAccessibilityLabel("Cloud name")
        alert.accessoryView = field
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        field.selectText(nil)
        guard alert.runModal() == .alertFirstButtonReturn, let name = HomeLogic.cloudRename(field.stringValue) else { return }
        setCloudName(model, e, name)
    }

    func copyInvite(_ model: CanvasModel, _ e: CloudEntry) {
        let alert = NSAlert()
        alert.messageText = "Copy Invite"
        alert.informativeText = "Enter the name or email of the person joining this Cloud."
        let field = NSTextField(string: "")
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        field.setAccessibilityLabel("Name or email")
        alert.accessoryView = field
        alert.addButton(withTitle: "Copy Invite")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        invite(model, e, label: String(field.stringValue.prefix(120)))
    }

    /// What Remove (or Delete, for a Cloud this Mac hosts) says before it happens: what stops, what stays, and where.
    static func removeText(_ e: CloudEntry, name: String, hosting: Bool) -> String {
        switch e.kind {
        case .hosted:
            return (hosting ? "Hosting stops and everyone in \(name) loses access. " : "")
                + "The comments, people and history stored on this Mac for \(name) are deleted. This cannot be undone. Files shared there keep their comments on this Mac, and copies others keep stay theirs."
        case .joined:
            return "This Mac leaves \(name): its invite is deleted, and joining again needs a new one. Files shared there keep their comments on this Mac. What was said there stays in the Cloud\u{2019}s history."
        case .server:
            return "Canvas stops syncing with \(name) and signs out. Files shared there keep their comments on this Mac. What was said there stays on the server."
        }
    }

    /// Remove a Cloud (Delete, for one this Mac hosts): asked first, then nothing more goes to it (the server tears
    /// down its sockets, tunnel and token), its sign-in is deleted from the Keychain, a hosted Cloud's data on this Mac
    /// is deleted, and its entry goes. Files shared there keep their comments here.
    func removeCloud(_ model: CanvasModel, _ e: CloudEntry, leaving: Bool = false) {
        let name = HomeLogic.cloudName(e)
        let a = NSAlert()
        a.messageText = e.kind == .hosted ? "Delete \(name)?" : leaving ? "Leave \(name)?" : "Remove \(name)?"
        a.informativeText = CloudAccount.removeText(e, name: name, hosting: isHosting(e))
        if e.kind == .hosted { a.alertStyle = .warning }
        a.addButton(withTitle: e.kind == .hosted ? "Delete" : leaving ? "Leave" : "Remove")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let hostId = e.kind == .hosted ? e.hostId : nil
        if let hostId, !beginStoppingOrDeleting(model, hostId) { return }
        busy.insert(e.url)
        signIns.removeValue(forKey: e.url)?.close()
        Task {
            var wipe: (status: Int, error: String?)?
            if let hostId {
                // Stops it if it runs (every token revoked), then deletes its folder on this Mac.
                let (st, j) = await CloudAccount.post(model, "api/cloud/host/wipe", ["hostId": hostId])
                wipe = (st, j["error"] as? String)
            }
            if wipe?.status == 200 || wipe == nil {
                if e.kind == .server && !CloudURL.isLocal(e.url) {
                    let account = CloudURL.host(e.url)
                    _ = await Task.detached { KeychainStore.delete(service: CloudAccount.service, account: account) }.value
                }
            }
            var removed: (Int, [String: Any]) = (0, [:])
            if wipe == nil || wipe?.status == 200 { removed = await CloudAccount.post(model, "api/cloud/remove", ["url": e.url]) }
            if let hostId { stoppingOrDeleting.remove(hostId) }
            // Something failed: the Cloud stays in the list, with its controls, and the toast says what.
            if let why = CloudRemoval.problem(wipe: wipe, remove: (removed.0, removed.1["error"] as? String)) {
                busy.remove(e.url)
                await refreshHost(model)
                model.flash(why)
                return
            }
            model.prefs.clouds = CloudList.remove(model.prefs.clouds, id: e.id)
            states.removeValue(forKey: e.url)
            busy.remove(e.url)
            if selected == e.id { selected = nil }
            if HomeStore.shared.section == .cloud(e.id) { HomeStore.shared.section = .recents }
            await refreshHost(model)
            model.flash(e.kind == .hosted ? "\(name) deleted" : "\(name) removed", level: "success")
        }
    }

    // MARK: Signing in

    /// A local development server needs no window: its DEV mode takes the email in Settings. Any other server shows its login.
    func signIn(_ model: CanvasModel, _ e: CloudEntry) {
        guard e.kind == .server else { return }
        if CloudURL.isLocal(e.url) {
            Task {
                _ = await waitListed(model, e.url)
                await refresh(model, fresh: true)
                announce(model, e)
            }
            return
        }
        signIns.removeValue(forKey: e.url)?.close()
        let id = e.id, url = e.url
        let w = CloudSignInWindow(origin: url) { [weak self] token in
            guard let self else { return }
            self.signIns.removeValue(forKey: url)
            // The sign-in finished late: the Cloud was removed (or replaced) meanwhile, so the token goes nowhere.
            guard let now = self.entry(model, id: id), now.url == url else { return }
            self.store(token: token, entry: now, model: model)
        }
        signIns[url] = w
        w.show()
    }

    /// The Keychain first (it outlives this run), then the server's memory.
    private func store(token: String, entry e: CloudEntry, model: CanvasModel) {
        let account = CloudURL.host(e.url), url = e.url
        busy.insert(url)
        Task {
            let saved = await Task.detached { KeychainStore.set(service: CloudAccount.service, account: account, secret: token) }.value
            _ = await waitListed(model, url)
            _ = await CloudAccount.post(model, "api/cloud/token", ["url": url, "token": token])
            if !saved { model.flash("Signed in. Canvas couldn't remember it, so you'll sign in again next time.") }
            busy.remove(url)
            await refresh(model, fresh: true)
            if let now = entry(model, url: url) { announce(model, now) }
        }
    }

    /// After a sign-in or a join: Home opens on that Cloud and a toast says it worked, or says why it did not.
    func announce(_ model: CanvasModel, _ e: CloudEntry) {
        let name = HomeLogic.cloudName(e)
        let s = state(e)
        guard s.status == "connected" else {
            model.flash(CloudStatusText.line(s.status, configured: true))
            return
        }
        SettingsWindow.shared.close()
        if let w = model.webView.window {
            if w.isMiniaturized { w.deminiaturize(nil) }
            w.makeKeyAndOrderFront(nil)
        }
        HomeStore.shared.section = .cloud(e.id)
        model.showHome()
        model.flash("You\u{2019}re connected to \(name)", level: "success")
    }

    func signOut(_ model: CanvasModel, _ e: CloudEntry) {
        // A development server has no token: signing out forgets the development email.
        if CloudURL.isLocal(e.url) {
            if let i = model.prefs.clouds.firstIndex(where: { $0.id == e.id }) { model.prefs.clouds[i].devEmail = "" }
            return
        }
        let account = CloudURL.host(e.url), url = e.url
        Task {
            // The Keychain item goes first, then the server forgets its copy and stops reading the Keychain for it.
            _ = await Task.detached { KeychainStore.delete(service: CloudAccount.service, account: account) }.value
            _ = await CloudAccount.post(model, "api/cloud/signout", ["url": url])
            await refresh(model)
        }
    }

    // MARK: Sharing

    /// Both the file page and Command N create in the Cloud being browsed.
    func newFile(_ model: CanvasModel, in entry: CloudEntry) {
        guard !busy.contains(entry.url) else { return }
        busy.insert(entry.url)
        Task {
            defer { busy.remove(entry.url) }
            guard await waitListed(model, entry.url) else { model.flash("This Cloud is offline."); return }
            let (status, j) = await Self.post(model, "api/cloud/files/create", ["cloud": entry.url, "name": "Untitled"])
            if status == 201, let file = j["file"] as? String {
                model.setCloudFileName(j["name"] as? String, for: file)
                model.open(file)
            } else { model.flash(CloudFilesText.problem(code: j["code"] as? String, fallback: "Could not create the Cloud file. Try again.")) }
        }
    }

    /// A verified move waits for typing and inspector writes before uploading the package.
    func moveOpenFile(_ model: CanvasModel, file selectedFile: String? = nil, to target: CloudEntry? = nil) {
        guard let file = selectedFile ?? model.currentFile else { model.flash("Open a Canvas file first"); return }
        model.flushTextEdit { ok in
            guard ok else { model.flash("Finish saving the text before moving this file"); return }
            model.afterWrites { Task {
            await self.refresh(model, fresh: true)
            let can = CloudShare.candidates(model.prefs.clouds, status: self.states.mapValues { ($0.status, $0.role) }).filter { $0.kind != .server }
            let chosen: CloudEntry?
            if let target { chosen = can.first { $0.id == target.id } }
            else { chosen = can.count == 1 ? can.first : await CloudAccount.pickOutsideTask(can, move: true) }
            guard let chosen else { model.flash("Add a Mac Cloud with editor access first"); return }
            guard !self.busy.contains(chosen.url) else { return }
            self.busy.insert(chosen.url)
            defer { self.busy.remove(chosen.url) }
            if target != nil {
                let confirmed = await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
                    RunLoop.main.perform { MainActor.assumeIsolated {
                        let alert = NSAlert()
                        alert.messageText = "Move \(HomeLogic.name(file)) to \(HomeLogic.cloudName(chosen))?"
                        alert.informativeText = "Everyone in this Cloud can open its files. The verified local package goes to the Trash."
                        alert.addButton(withTitle: "Move")
                        alert.addButton(withTitle: "Cancel")
                        done.resume(returning: alert.runModal() == .alertFirstButtonReturn)
                    } }
                }
                guard confirmed else { return }
            }
            let (movedStatus, moved) = await CloudAccount.post(model, "api/cloud/files/move", ["cloud": chosen.url], query: [URLQueryItem(name: "file", value: file)])
            if movedStatus == 200, let destination = moved["file"] as? String {
                model.setCloudFileName(moved["name"] as? String, for: destination)
                model.close(file)
                HomeStore.shared.remove(file)
                model.open(destination)
                model.flash("Moved to \(HomeLogic.cloudName(chosen))", level: "success")
            } else { model.flash(CloudFilesText.problem(code: moved["code"] as? String, fallback: "Could not move the file. Your local copy is kept.")) }

            } }
        }
    }

    func shareOpenFile(_ model: CanvasModel, file selectedFile: String? = nil) {
        guard let file = selectedFile ?? model.currentFile else { model.flash("Open a Canvas file first"); return }
        Task {
            await refresh(model, fresh: true)
            let summary = CommentsRead.summary(try? Data(contentsOf: URL(fileURLWithPath: file + "/comments.json")))
            var to: CloudEntry?
            if let server = summary.server, entry(model, url: CloudURL.clean(server) ?? server) == nil {
                // Shared to a Cloud this Canvas no longer has: it stays there (a file keeps its Cloud) and does not sync.
                model.flash("This file is shared to a Cloud that is not in your list. Add that Cloud again to sync it.")
                return
            }
            if summary.server == nil {
                let can = CloudShare.candidates(model.prefs.clouds, status: states.mapValues { ($0.status, $0.role) })
                if can.isEmpty {
                    model.flash(model.prefs.clouds.isEmpty ? "Add a Cloud first" : "None of your Clouds can take this file now. Sign in, or ask for editor access.")
                    if model.prefs.clouds.isEmpty { model.showHome(); AddCloudPanel.shared.show(model) } else { SettingsWindow.shared.show(model, tab: .cloud) }
                    return
                }
                guard let pick = can.count == 1 ? can[0] : await CloudAccount.pickOutsideTask(can) else { return }
                to = pick
            }
            var query = [URLQueryItem(name: "file", value: file)]
            if let to { query.append(URLQueryItem(name: "url", value: to.url)) }
            let (status, j) = await CloudAccount.post(model, "api/cloud/share", [:], query: query)
            if status == 200 {
                // The answer names the Cloud the file is on, which for a file already shared is not the one picked.
                let url = j["url"] as? String ?? to?.url ?? ""
                let name = entry(model, url: url).map(HomeLogic.cloudName) ?? HomeLogic.whereLabel(server: url).text
                // A file already shared says whether its Cloud is reachable now, not that it connected.
                await refresh(model, fresh: true)
                let m = CloudShare.message(already: j["already"] as? Bool == true, name: name, status: states[url]?.status)
                model.flash(m.text, level: m.ok ? "success" : nil)
                model.reloadPage()
            } else {
                model.flash(j["error"] as? String ?? "Could not share the comments")
                if status == 401 { SettingsWindow.shared.show(model, tab: .cloud) }
            }
            await refresh(model)
        }
    }

    /// Which Cloud: a short question with the Clouds in a menu (the first one chosen). Nil when cancelled.
    /// The question from inside a Task. Its modal loop runs from the run loop, not from this Task's main-actor job:
    /// run from the job, the main actor stays busy until the question closes and every other main-actor job (the
    /// bridge, the page, QA) waits, so the app stops answering.
    static func pickOutsideTask(_ clouds: [CloudEntry], move: Bool = false) async -> CloudEntry? {
        await withCheckedContinuation { (done: CheckedContinuation<CloudEntry?, Never>) in
            RunLoop.main.perform { MainActor.assumeIsolated { done.resume(returning: pick(clouds, move: move)) } }
        }
    }

    static func pick(_ clouds: [CloudEntry], move: Bool = false) -> CloudEntry? {
        let a = NSAlert()
        a.messageText = move ? "Move file to which Cloud?" : "Share comments to which Cloud?"
        a.informativeText = move ? "Everyone in this Cloud can open its files. The verified local package goes to the Trash." : "Everyone in that Cloud can read the comments on this file."
        let menu = CloudSharePicker.make(clouds, name: HomeLogic.cloudName, detail: { $0.kind == .server ? ServerName.host($0.url) : "on a Mac, \($0.hostId?.prefix(4) ?? "")" })
        a.accessoryView = menu
        a.addButton(withTitle: move ? "Move" : "Share")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return nil }
        return CloudSharePicker.selected(menu, in: clouds)
    }

    nonisolated static func get(_ model: CanvasModel, _ path: String, query: [URLQueryItem]) async -> [String: Any] {
        var c = URLComponents(url: model.base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        c?.queryItems = query
        guard let url = c?.url else { return [:] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        guard let (data, _) = try? await URLSession.shared.data(for: request) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
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
        #if CANVAS_QA
        if path == "api/cloud/host/start" { await QA.holdCloudStartReply() }
        #endif
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

/// Settings > Cloud (design boards "Many Clouds: Settings list" and "one Cloud in Settings"): the Clouds by name with a
/// filter once there are many, and Add Cloud; a click opens one Cloud's page, which shows only what its kind needs.
struct CloudSettings: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject private var account = CloudAccount.shared
    @State private var filter = ""

    /// The list gets a filter field past this many Clouds.
    static let filterFrom = 8
    /// Rows shown before the list scrolls.
    static let visibleRows = 9

    var body: some View {
        Group {
            if let e = account.entry(model, id: account.selected) { CloudPage(model: model, entry: e) } else { list }
        }
        // While this pane shows (rarely, and briefly): the Clouds are asked every few seconds, so a fix or an outage
        // shows at once. Home asks far less often.
        .task(id: model.prefs.clouds.map { $0.url + "|" + $0.devEmail }.joined(separator: ",")) {
            try? await Task.sleep(nanoseconds: 600_000_000)
            while !Task.isCancelled {
                await account.refresh(model, fresh: true)
                await account.refreshHost(model)
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    private var list: some View {
        let all = model.prefs.clouds
        let shown = CloudList.filtered(all, query: filter, name: HomeLogic.cloudName)
        return SettingsStack {
            HStack(spacing: 8) {
                if all.count > CloudSettings.filterFrom {
                    FieldBox {
                        Image(systemName: "magnifyingglass").glyph(GlyphSize.field).foregroundStyle(Palette.mutedFg)
                        TextField("Filter \(all.count) Clouds", text: $filter).textFieldStyle(.plain).font(Typography.body)
                            .accessibilityLabel("Filter Clouds").qaID("cloud-filter")
                    }
                } else {
                    Text(all.isEmpty ? "No Clouds yet" : all.count == 1 ? "1 Cloud" : "\(all.count) Clouds")
                        .font(Typography.body).foregroundStyle(Palette.mutedFg).qaText(all.isEmpty ? "No Clouds yet" : "Clouds")
                    Spacer(minLength: 8)
                }
                FieldButton(title: "Add Cloud", symbol: "plus", prominent: true) { AddCloudPanel.shared.show(model, on: SettingsWindow.shared.nsWindow) }
                    .qaID("cloud-add", label: "Add Cloud")
                    .fixedSize()
            }
            if !all.isEmpty {
                SettingsCard {
                    let rows = VStack(spacing: 0) {
                        ForEach(Array(shown.enumerated()), id: \.element.id) { i, e in
                            if i > 0 { SettingsDivider() }
                            CloudListRow(entry: e, state: account.state(e), hosting: account.isHosting(e)) { account.selected = e.id }
                        }
                    }
                    if shown.count > CloudSettings.visibleRows {
                        ScrollView { rows }.frame(height: CGFloat(CloudSettings.visibleRows) * 46).scrollIndicators(.automatic)
                        SettingsDivider()
                        Text("\(shown.count - CloudSettings.visibleRows) more, scroll or filter").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 10)
                    } else if shown.isEmpty {
                        Text("No Clouds match \u{201C}\(filter)\u{201D}").font(Typography.body).foregroundStyle(Palette.mutedFg)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(14).qaText("No Clouds match")
                    } else {
                        rows
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(CloudDisclosure.lines, id: \.self) { line in
                    Text(line).font(Typography.micro).foregroundStyle(Palette.mutedFg).fixedSize(horizontal: false, vertical: true).qaText(line)
                    }
                }
                .padding(.horizontal, 14)
                .qaID("cloud-disclosure")
            }
        }
    }
}

/// One Cloud in Settings > Cloud's list: where it lives (laptop or cloud), its name, a word only when it needs the
/// person ("Sign in", "Down") or "Hosting" for one this Mac runs, and a chevron.
struct CloudListRow: View {
    let entry: CloudEntry
    let state: CloudState
    let hosting: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        let name = HomeLogic.cloudName(entry)
        let word = HomeLogic.word(status: state.known ? state.status : nil)
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: HomeLogic.rowSymbol(kind: entry.kind)).glyph(GlyphSize.row + 1)
                    .foregroundStyle(Palette.fg).frame(width: 16)
                Text(name).font(Typography.body).fontWeight(.medium).foregroundStyle(word?.tone == .muted ? Palette.mutedFg : Palette.fg).lineLimit(1).qaText(name)
                if entry.adapterAlpha { Badge(text: "Alpha").qaID("cloud-alpha-badge", label: "Alpha") }
                Spacer(minLength: 8)
                if let word {
                    Text(word.text).font(Typography.label).foregroundStyle(word.tone == .attention ? CloudInk.warn : Palette.mutedFg).lineLimit(1)
                        .qaID("cloud-row-word", label: word.text)
                } else if hosting {
                    Text("Hosting").font(Typography.label).fontWeight(.regular).foregroundStyle(Palette.mutedFg).lineLimit(1)
                        .qaID("cloud-row-word", label: "Hosting")
                }
                Image(systemName: "chevron.right").glyph(GlyphSize.caption).foregroundStyle(Palette.mutedFg)
            }
            .padding(.horizontal, 14).frame(height: 46)
            .background(hovering ? Palette.hover : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .qaID("cloud-row", label: name)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

/// One Cloud opened in Settings > Cloud: a back arrow, its name and a status pill, then what its kind needs. A Cloud on
/// a Mac shows its fingerprint, people and invites (hosted here) or that it was joined; a server its address and
/// account. Stop or Start hosting, and Remove (Delete, for a Cloud this Mac hosts), at the bottom.
struct CloudPage: View {
    @ObservedObject var model: CanvasModel
    let entry: CloudEntry
    @ObservedObject private var account = CloudAccount.shared
    /// Add person: the name or email of the next invite.
    @State private var invitee = ""
    @State private var hostUsage: String?

    var body: some View {
        let e = entry
        let s = account.state(e)
        let h = account.host(e)
        let name = HomeLogic.cloudName(e)
        SettingsStack {
            HStack(spacing: 10) {
                MiniButton(symbol: "chevron.left", help: "All Clouds") { account.selected = nil }.qaID("cloud-back", label: "All Clouds")
                Text(name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.fg).lineLimit(1).qaText(name)
                if e.adapterAlpha { Badge(text: "Alpha").qaID("cloud-alpha-badge", label: "Alpha") }
                let pill = pill(e, s)
                CloudPill(text: pill.text, tone: pill.tone).help(CloudStatusText.detail(s.status, name: name) ?? "")
                Spacer(minLength: 0)
            }
            .padding(.leading, -4)
            SettingsCard {
                SettingsRow("Name") {
                    FieldBox {
                        TextField(ServerName.display(e.url), text: Binding(get: { entry.name }, set: { v in
                            account.setCloudName(model, entry, v)
                        }))
                        .textFieldStyle(.plain).font(Typography.body)
                        .accessibilityLabel("Cloud name").qaID("cloud-name")
                    }
                    .frame(width: 244)
                }
                switch e.kind {
                case .server: serverRows(e, s)
                case .hosted:
                    SettingsDivider()
                    SettingsRow("Check code", detail: "People joining see the same one") {
                        Text(h.fingerprint ?? "\u{2013}").font(Typography.body).monospacedDigit().foregroundStyle(Palette.mutedFg).lineLimit(1)
                            .qaID("cloud-fingerprint", label: h.fingerprint ?? "")
                    }
                    if let hostUsage {
                        SettingsDivider()
                        SettingsRow("Host on this Mac") {
                            Text(hostUsage).font(Typography.body).foregroundStyle(Palette.mutedFg).lineLimit(1)
                                .qaID("cloud-host-usage", label: hostUsage)
                        }
                    }
                case .joined:
                    SettingsDivider()
                    SettingsRow("Where", detail: CloudStatusText.account(email: s.email, role: s.role)) {
                        Text("Hosted on a Mac").font(Typography.body).foregroundStyle(Palette.mutedFg).lineLimit(1).qaID("cloud-address", label: "Hosted on a Mac")
                    }
                }
            }
            if e.kind == .hosted && h.hosting { people(e, h) }
            if e.kind == .hosted, !account.isResuming(e), let error = h.tunnelError {
                Text(error).font(Typography.body).foregroundStyle(Palette.danger).fixedSize(horizontal: false, vertical: true)
                    .qaID("cloud-tunnel-error", label: error)
            }
            HStack(spacing: 8) {
                if e.kind == .hosted {
                    if h.hosting || e.hosting {
                        FieldButton(title: "Stop hosting", symbol: nil) { account.stopHosting(model, e) }.qaID("cloud-stop-hosting", label: "Stop hosting")
                    }
                    if !h.hosting {
                        let busy = account.starting.contains(e.hostId ?? "")
                        FieldButton(title: busy ? "Starting\u{2026}" : "Start hosting", symbol: nil) {
                            Task { if let why = await account.startHosting(model, entry: e, name: e.name) { model.flash(why) } }
                        }
                        .disabled(!account.hostAvailable || busy).opacity(account.hostAvailable ? 1 : 0.5)
                        .qaID("cloud-host", label: "Start hosting")
                    }
                }
                Spacer(minLength: 8)
                RemoveButton(title: e.kind == .hosted ? "Delete Cloud\u{2026}" : "Remove Cloud\u{2026}") { account.removeCloud(model, e) }
                    .disabled(account.busy.contains(e.url))
                    .qaID("cloud-remove-cloud", label: e.kind == .hosted ? "Delete \(name)" : "Remove \(name)")
            }
            if e.kind != .server {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(CloudDisclosure.lines, id: \.self) { line in
                        Text(line).font(Typography.micro).foregroundStyle(Palette.mutedFg).fixedSize(horizontal: false, vertical: true)
                    }
                    if e.kind == .hosted && h.hosting {
                        Text("Closing this Mac\u{2019}s lid takes \(name) down until it opens again.").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    }
                }
                .padding(.horizontal, 14)
                .qaID("cloud-disclosure")
            }
        }
        .task(id: entry.url + entry.kind.rawValue) {
            hostUsage = nil
            guard entry.kind == .hosted else { return }
            while !Task.isCancelled {
                let usage = await CloudFilesView.read(model, entry: entry, path: "api/cloud/usage")
                guard !Task.isCancelled else { return }
                hostUsage = CloudFilesText.hostUsage(usage)
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    private func pill(_ e: CloudEntry, _ s: CloudState) -> (text: String, tone: HomeLogic.Tone) {
        if e.kind == .hosted {
            if account.starting.contains(e.hostId ?? "") { return ("Starting", .muted) }
            return account.isHosting(e) ? ("Hosting on this Mac", .live) : ("Not hosting", .muted)
        }
        if let w = HomeLogic.word(status: s.known ? s.status : nil) { return w }
        return s.known ? ("Live", .live) : ("Checking", .muted)
    }

    @ViewBuilder private func serverRows(_ e: CloudEntry, _ s: CloudState) -> some View {
        let local = CloudURL.isLocal(e.url)
        let signedIn = CloudStatusText.account(email: s.email, role: s.role) != nil && s.status != "signInAgain" && s.status != "signedOut"
        SettingsDivider()
        SettingsRow("Address") {
            Text(ServerName.host(e.url)).font(Typography.body).foregroundStyle(Palette.mutedFg).lineLimit(1).truncationMode(.middle)
                .qaID("cloud-address", label: ServerName.host(e.url))
        }
        if local {
            SettingsDivider()
            SettingsRow("Development email", detail: "For a local server in DEV mode") {
                FieldBox {
                    TextField(String("anna@studio.test"), text: Binding(get: { entry.devEmail }, set: { v in
                        if let i = model.prefs.clouds.firstIndex(where: { $0.id == entry.id }) { model.prefs.clouds[i].devEmail = String(v.prefix(120)) }
                    }))
                    .textFieldStyle(.plain).font(Typography.body)
                    .accessibilityLabel("Development email").qaID("cloud-dev-email")
                }
                .frame(width: 244)
            }
        }
        SettingsDivider()
        SettingsRow("Account", detail: signedIn ? CloudStatusText.account(email: s.email, role: s.role) : "Not signed in") {
            if signedIn {
                FieldButton(title: "Sign out", symbol: nil) { account.signOut(model, e) }.qaID("cloud-sign-out", label: "Sign out")
            } else {
                FieldButton(title: s.status == "signInAgain" ? "Sign in again" : "Sign in", symbol: nil) { account.signIn(model, e) }
                    .disabled(local && e.devEmail.trimmingCharacters(in: .whitespaces).isEmpty || account.busy.contains(e.url))
                    .qaID("cloud-sign-in", label: "Sign in")
            }
        }
        SettingsDivider()
        SettingsRow("Status") {
            Text(CloudStatusText.line(s.known ? s.status : "offline", configured: true))
                .font(Typography.body).foregroundStyle(s.status == "connected" ? Palette.fg : Palette.mutedFg).lineLimit(1)
                .qaID("cloud-status", label: CloudStatusText.line(s.known ? s.status : "offline", configured: true))
        }
    }

    /// The people in a Cloud this Mac hosts, each with Remove, and the invite field.
    @ViewBuilder private func people(_ e: CloudEntry, _ h: HostState) -> some View {
        SettingsCard {
            ForEach(Array(h.people.enumerated()), id: \.element.id) { i, p in
                if i > 0 { SettingsDivider() }
                HStack(spacing: 8) {
                    Text(p.label).font(Typography.body).fontWeight(.medium).foregroundStyle(Palette.fg).lineLimit(1).qaText(p.label)
                    Text(personDetail(p)).font(Typography.label).fontWeight(.regular).foregroundStyle(Palette.mutedFg).lineLimit(1).qaText(personDetail(p))
                    Spacer(minLength: 8)
                    if p.role != "owner" {
                        FieldButton(title: "Remove", symbol: nil) { account.remove(model, e, p) }.qaID("cloud-remove", label: "Remove \(p.label)")
                    }
                }
                .padding(.horizontal, 14).frame(minHeight: 48)
            }
            SettingsDivider()
            HStack(spacing: 8) {
                FieldBox {
                    TextField("Name or email", text: Binding(get: { invitee }, set: { invitee = String($0.prefix(120)) }))
                        .textFieldStyle(.plain).font(Typography.body)
                        .onSubmit { account.invite(model, e, label: invitee); invitee = "" }
                        .accessibilityLabel("Name or email").qaID("cloud-invitee")
                }
                FieldButton(title: "Copy Invite", symbol: "doc.on.doc") { account.invite(model, e, label: invitee); invitee = "" }
                    .disabled(invitee.trimmingCharacters(in: .whitespaces).isEmpty)
                    .qaID("cloud-invite", label: "Copy Invite")
                    .fixedSize()
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
        }
    }

    private func personDetail(_ p: HostState.Person) -> String {
        if p.role == "owner" { return "You, the host" }
        if !p.devices.isEmpty { return "Joined from " + p.devices.joined(separator: ", ") }
        return p.invited ? "Invite waiting" : (p.role.isEmpty ? "No Mac joined" : p.role.capitalized)
    }
}

/// Remove or Delete a Cloud: a field-height button whose label is in the danger colour.
private struct RemoveButton: View {
    let title: String
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            Text(title).font(Typography.label).foregroundStyle(Palette.danger).lineLimit(1)
                .capCentered(12, weight: .medium)
                .padding(.leading, 12).padding(.trailing, 11).frame(height: Metric.field)
                .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(hovering ? Palette.active : Palette.field.opacity(0.6)))
                .contentShape(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

// MARK: Add Cloud

/// The steps of the Add Cloud sheet (design boards ac-pick, ac-join, ac-host): pick a kind, then join with an
/// invite, host on this Mac, or connect a server.
enum AddCloudStep: Equatable {
    case pick
    /// Join; with an invite opened from a link, that invite (the link itself is never put on screen).
    case join(CloudInvite?)
    case host
    case server
}

/// The Add Cloud sheet, on the window it was asked from (Home's, or Settings'). One at a time.
@MainActor
final class AddCloudPanel {
    static let shared = AddCloudPanel()
    static let title = "Add Cloud"
    private var sheet: NSWindow?
    private weak var parent: NSWindow?
    /// Bumped to send an open sheet to another step (a link opened while it shows).
    final class Route: ObservableObject { @Published var step: AddCloudStep = .pick }
    private let route = Route()

    var isOpen: Bool { sheet != nil }

    func show(_ model: CanvasModel, on window: NSWindow? = nil, step: AddCloudStep = .pick) {
        route.step = step
        if sheet != nil { return }
        guard let parent = window ?? model.webView.window else { return }
        let host = ControlHostingController(rootView: AddCloudSheet(model: model, route: route) { [weak self] in self?.close() })
        host.sizingOptions = [.preferredContentSize]
        let w = NSWindow(contentViewController: host)
        w.styleMask = [.titled]
        w.title = AddCloudPanel.title
        w.isReleasedWhenClosed = false
        sheet = w
        self.parent = parent
        Task { await CloudAccount.shared.refreshHost(model) }
        parent.beginSheet(w)
    }

    func close() {
        guard let w = sheet else { return }
        sheet = nil
        if let p = parent { p.endSheet(w) } else { w.close() }
    }
}

struct AddCloudSheet: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var route: AddCloudPanel.Route
    let close: () -> Void
    @ObservedObject private var account = CloudAccount.shared

    @State private var link = ""
    @State private var cloudName = ""
    @State private var address = ""
    @State private var devEmail = ""
    @State private var working = false
    @State private var problem: String?

    static let width: CGFloat = 412

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch route.step {
            case .pick: pick
            case .join(let fromLink): join(fromLink)
            case .host: hostStep
            case .server: server
            }
        }
        .padding(20)
        .frame(width: AddCloudSheet.width, alignment: .leading)
        .background(Palette.popover)
        .onChange(of: route.step) { problem = nil; working = false }
        .onExitCommand { close() }
    }

    // MARK: Pick

    /// Why Host on this Mac is off, or nil when it is on. Hosting one Cloud never stops another: one per team.
    private var hostBlocked: String? {
        if !account.hostAvailable { return "Needs the tunnel helper, which this build does not have" }
        if CloudList.hostedIds(model.prefs.clouds, known: Set(account.hosts.keys)).count >= account.hostMax { return "This Mac hosts \(account.hostMax) Clouds, the most it can. Delete one first" }
        if model.prefs.clouds.count >= SettingsLimits.clouds { return "Canvas keeps \(SettingsLimits.clouds) Clouds at most" }
        return nil
    }

    private var pick: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Add a Cloud").font(Typography.title).foregroundStyle(Palette.fg).qaText("Add a Cloud")
                Text("Everyone in this Cloud can open its files.").font(Typography.label).fontWeight(.regular).foregroundStyle(Palette.mutedFg)
            }
            VStack(alignment: .leading, spacing: 4) {
                AddCloudOption(symbol: "link", title: "Join with an invite", detail: "Paste the link a teammate sent you", id: "add-cloud-join") { route.step = .join(nil) }
                Text("Run your own Cloud on").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                    .padding(.leading, 10).padding(.top, 10).padding(.bottom, 2).qaText("Run your own Cloud on")
                AddCloudOption(symbol: "laptopcomputer", title: "This Mac", detail: hostBlocked ?? "Free, no account. Live while this Mac is awake", id: "add-cloud-host", enabled: hostBlocked == nil) {
                    cloudName = ""; route.step = .host
                }
                AddCloudOption(symbol: "cloud", title: "Cloudflare", detail: "Always on, on your Cloudflare account", id: "add-cloud-server", alpha: true) { route.step = .server }
            }
            HStack { Spacer(); FieldButton(title: "Cancel", symbol: nil) { close() }.qaID("add-cloud-cancel", label: "Cancel") }
        }
    }

    private func header(_ title: String) -> some View {
        HStack(spacing: 8) {
            MiniButton(symbol: "chevron.left", help: "Back") { route.step = .pick }.qaID("add-cloud-back", label: "Back")
            Text(title).font(Typography.title).foregroundStyle(Palette.fg).lineLimit(1).qaText(title)
        }
        .padding(.leading, -4)
    }

    private func buttons(_ primary: String, enabled: Bool, id: String, action: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Spacer()
            FieldButton(title: "Cancel", symbol: nil) { close() }.qaID("add-cloud-cancel", label: "Cancel")
            FieldButton(title: working ? "\(primary)\u{2026}" : primary, symbol: nil, prominent: true) { if enabled && !working { action() } }
                .disabled(!enabled || working).opacity(enabled ? 1 : 0.5)
                .qaID(id, label: primary)
        }
    }

    private func problemLine() -> some View {
        Group {
            if let problem { Text(problem).font(Typography.micro).foregroundStyle(Palette.danger).fixedSize(horizontal: false, vertical: true).qaText(problem) }
        }
    }

    // MARK: Join

    @ViewBuilder private func join(_ fromLink: CloudInvite?) -> some View {
        let invite = fromLink ?? CloudInvite.parse(link)
        let check = invite.map { CloudInvite.check($0, list: model.prefs.clouds, hostedIds: account.hostedIds(model)) }
        header("Join with an invite")
        FieldBox {
            Image(systemName: "link").glyph(GlyphSize.field).foregroundStyle(Palette.mutedFg)
            if fromLink != nil || invite != nil {
                // An invite opened from a link: the link is a secret, so the field only says where it came from.
                Text(fromLink != nil ? "Invite from a link" : "Invite ready").font(Typography.body).foregroundStyle(Palette.mutedFg).lineLimit(1)
                if fromLink == nil { Spacer(); MiniButton(symbol: "xmark", help: "Use another invite") { link = "" } }
            } else {
                TextField("Paste an invite link", text: Binding(get: { link }, set: { link = String($0.prefix(8192)); problem = nil }))
                    .textFieldStyle(.plain).font(Typography.body)
                    .accessibilityLabel("Invite link").qaID("add-cloud-link")
            }
        }
        if let invite {
            HStack(spacing: 12) {
                AddCloudGlyph(symbol: "laptopcomputer")
                VStack(alignment: .leading, spacing: 3) {
                    Text(invite.name).font(Typography.body).fontWeight(.semibold).foregroundStyle(Palette.fg).lineLimit(1).qaText(invite.name)
                    Text("Hosted on a Mac. Check code \(invite.fingerprint)").font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1)
                        .qaID("add-cloud-fingerprint", label: invite.fingerprint)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.muted))
            VStack(alignment: .leading, spacing: 4) {
                switch check {
                case .already(let id)?:
                    Text("This Mac is already in \(account.entry(model, id: id).map(HomeLogic.cloudName) ?? invite.name).").font(Typography.micro).foregroundStyle(Palette.fg).qaText("Already in this Cloud")
                case .hostsIt?:
                    Text("This Mac hosts this Cloud.").font(Typography.micro).foregroundStyle(Palette.fg).qaText("This Mac hosts this Cloud")
                default:
                    Text("Ask the host to read the check code from Settings > Cloud. The codes should match.").font(Typography.micro).foregroundStyle(Palette.mutedFg).fixedSize(horizontal: false, vertical: true)
                        .qaText("Ask the host to read the check code from Settings > Cloud. The codes should match.")
                }
                ForEach(CloudDisclosure.lines, id: \.self) { line in
                    Text(line).font(Typography.micro).foregroundStyle(Palette.mutedFg).fixedSize(horizontal: false, vertical: true).qaText(line)
                }
            }
            .qaID("add-cloud-disclosure")
        } else if !link.trimmingCharacters(in: .whitespaces).isEmpty {
            Text("That is not a Canvas invite link").font(Typography.micro).foregroundStyle(Palette.mutedFg).qaText("That is not a Canvas invite link")
        }
        problemLine()
        buttons(invite.map { "Join \($0.name)" } ?? "Join", enabled: invite != nil && check == .ok, id: "add-cloud-join-go") {
            guard let invite else { return }
            working = true
            Task {
                let why = await account.join(model, invite)
                working = false
                if let why { problem = why } else { link = ""; close() }
            }
        }
    }

    // MARK: Host

    @ViewBuilder private var hostStep: some View {
        header("Host on this Mac")
        VStack(alignment: .leading, spacing: 6) {
            Text("Name").font(Typography.label).foregroundStyle(Palette.mutedFg)
            FieldBox {
                TextField("Studio", text: Binding(get: { cloudName }, set: { cloudName = String($0.prefix(SettingsLimits.serverName)) }))
                    .textFieldStyle(.plain).font(Typography.body)
                    .accessibilityLabel("Cloud name").qaID("add-cloud-name")
            }
        }
        VStack(alignment: .leading, spacing: 6) {
            fact("lock", "Only people you invite can join")
            fact("moon", "When this Mac sleeps, teammates see Cloud down")
            fact("tray", "Comments stay on this Mac")
        }
        if let why = hostBlocked { Text(why).font(Typography.micro).foregroundStyle(Palette.fg).qaText(why) }
        problemLine()
        buttons("Start hosting", enabled: hostBlocked == nil, id: "add-cloud-host-go") {
            working = true
            let name = cloudName.trimmingCharacters(in: .whitespaces)
            Task {
                let why = await account.startHosting(model, name: name.isEmpty ? "Cloud" : name)
                working = false
                if let why { problem = why; return }
                close()
                if let e = account.entry(model, id: account.lastStarted) {
                    HomeStore.shared.section = .cloud(e.id)
                    model.showHome()
                    model.flash("\(HomeLogic.cloudName(e)) is live. Invite people from its settings.", level: "success")
                }
            }
        }
    }

    private func fact(_ symbol: String, _ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).glyph(GlyphSize.field).foregroundStyle(Palette.mutedFg).frame(width: 14)
            Text(text).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).qaText(text)
        }
    }

    // MARK: Server

    @ViewBuilder private var server: some View {
        let next = CloudSetup.next(address, devEmail: devEmail)
        let local = CloudURL.isLocal(address)
        let exists = CloudURL.clean(address).flatMap { u in model.prefs.clouds.first { $0.url == u } }
        header("Cloudflare")
        VStack(alignment: .leading, spacing: 6) {
            Text("Address").font(Typography.label).foregroundStyle(Palette.mutedFg)
            FieldBox {
                TextField(CloudSetup.placeholder, text: Binding(get: { address }, set: { address = String($0.prefix(200)); problem = nil }))
                    .textFieldStyle(.plain).font(Typography.body)
                    .accessibilityLabel("Server address").qaID("cloud-url")
            }
            if let hint = CloudSetup.hint(address) { Text(hint).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).qaText(hint) }
            if let exists { Text("Already added as \(HomeLogic.cloudName(exists))").font(Typography.micro).foregroundStyle(Palette.fg).qaText("Already added") }
        }
        VStack(alignment: .leading, spacing: 6) {
            Text("Name").font(Typography.label).foregroundStyle(Palette.mutedFg)
            FieldBox {
                TextField("Optional", text: Binding(get: { cloudName }, set: { cloudName = String($0.prefix(SettingsLimits.serverName)) }))
                    .textFieldStyle(.plain).font(Typography.body)
                    .accessibilityLabel("Cloud name").qaID("add-cloud-server-name")
            }
        }
        if local {
            VStack(alignment: .leading, spacing: 6) {
                Text("Development email").font(Typography.label).foregroundStyle(Palette.mutedFg)
                FieldBox {
                    TextField(String("anna@studio.test"), text: Binding(get: { devEmail }, set: { devEmail = String($0.prefix(120)) }))
                        .textFieldStyle(.plain).font(Typography.body)
                        .accessibilityLabel("Development email").qaID("add-cloud-dev-email")
                }
                Text("For a local server in DEV mode").font(Typography.micro).foregroundStyle(Palette.mutedFg)
            }
        }
        problemLine()
        buttons("Connect", enabled: next == .signIn && exists == nil, id: "add-cloud-server-go") {
            let name = cloudName, url = address, email = devEmail
            close()
            account.connectServer(model, url: url, name: name, devEmail: email)
        }
    }
}

/// A kind of Cloud to add: a glyph in a rounded square, a title, a line, a chevron.
private struct AddCloudOption: View {
    let symbol: String
    let title: String
    let detail: String
    let id: String
    var enabled = true
    var alpha = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: { if enabled { action() } }) {
            HStack(spacing: 12) {
                AddCloudGlyph(symbol: symbol)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(title).font(Typography.body).fontWeight(.semibold).foregroundStyle(Palette.fg).lineLimit(1).qaText(title)
                        if alpha { Badge(text: "Alpha").qaID("add-cloud-alpha", label: "Alpha") }
                    }
                    Text(detail).font(Typography.micro).foregroundStyle(Palette.mutedFg).lineLimit(1).qaText(detail)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").glyph(GlyphSize.caption).foregroundStyle(Palette.mutedFg)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hovering && enabled ? Palette.hover : .clear))
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .opacity(enabled ? 1 : 0.5)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(title)
        .qaID(id, label: title)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

private struct AddCloudGlyph: View {
    let symbol: String
    var body: some View {
        Image(systemName: symbol).glyph(GlyphSize.row).foregroundStyle(Palette.fg)
            .frame(width: 30, height: 30)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.active))
    }
}
