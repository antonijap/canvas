// Home: the pinned first tab. A native screen shown in place of the canvas web view (the file tabs' pages stay alive
// under it): the recent files as cards, the files on this Mac, the Cloud server and what is shared to it, and one
// muted line where there are no files yet. Each Cloud in Settings > Cloud has its own row and page (its files as the
// same cards, under its name, a status pill and a gear for its settings); Add Cloud opens the sheet (CloudSettings.swift). The logic (recents, summaries, order, labels) is HomeLogic.swift.
//
// The recents list is the app's own, in UserDefaults ("canvas.recents": path and last opened time, at most 50). Each
// card's open comment count and server come from the file's comments.json, read here. A card's picture is a snapshot
// of the canvas taken when its tab is closed or hidden and when the app quits, a small PNG in the state folder
// (<state>/thumbnails/<hash of the path>.png), never inside the .canvas package.

import AppKit
import SwiftUI
import WebKit

enum StateFolder {
    /// CANVAS_STATE_DIR, else ~/Library/Application Support/Canvas (the same folder the server's backups use).
    static var path: String {
        ProcessInfo.processInfo.environment["CANVAS_STATE_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/Canvas"
    }
}

enum HomeSection: Hashable, CustomStringConvertible {
    case recents, mac
    /// One Cloud's page, by its entry id (AppSettings.clouds).
    case cloud(String)
    /// What QA reads (QA.swift state "homeSection"): recents, mac or cloud.
    var description: String {
        switch self {
        case .recents: "recents"
        case .mac: "mac"
        case .cloud: "cloud"
        }
    }
    var cloudId: String? { if case .cloud(let id) = self { id } else { nil } }
}

@MainActor
final class HomeStore: ObservableObject {
    static let shared = HomeStore()

    @Published var query = ""
    @Published var revealPath: String?
    @Published var section: HomeSection = .recents
    @Published private(set) var cards: [HomeCard] = []
    /// False until the first read of the files finished (so a view with files does not flash its empty line).
    @Published private(set) var loaded = false
    /// Bumped when a thumbnail was written: the cards read their picture again.
    @Published private(set) var thumbVersion = 0
    private(set) var recents: [RecentEntry]
    private var images: [String: (stamp: Date, image: NSImage)] = [:]
    private var reading = 0

    init() {
        if let stored = Recents.load() {
            recents = stored
        } else {
            // An install from before Home: the open tabs are the recents, by when each file last changed.
            let open = UserDefaults.standard.stringArray(forKey: "canvas.openFiles") ?? []
            recents = Recents.ordered(open.compactMap { p in
                guard FileManager.default.fileExists(atPath: p) else { return nil }
                return RecentEntry(path: p, opened: Self.modified(p) ?? Date().timeIntervalSince1970)
            })
            Recents.save(recents)
        }
    }

    /// A file was opened (or shown again).
    func touch(_ path: String) {
        recents = Recents.touch(recents, path, at: Date().timeIntervalSince1970)
        Recents.save(recents)
        reload()
    }

    func remove(_ path: String) {
        recents = Recents.remove(recents, path)
        Recents.save(recents)
        reload()
    }

    func replace(_ old: String, with new: String) {
        recents = Recents.replacing(recents, old, with: new)
        Recents.save(recents)
        reload()
    }

    nonisolated static func modified(_ path: String) -> Double? {
        let fm = FileManager.default
        for p in [path + "/document.json", path] {
            if let d = (try? fm.attributesOfItem(atPath: p))?[.modificationDate] as? Date { return d.timeIntervalSince1970 }
        }
        return nil
    }

    /// Reads each file's disk state and comments off the main thread, then publishes the cards.
    func reload() {
        reading += 1
        let token = reading
        let list = recents
        DispatchQueue.global(qos: .userInitiated).async {
            let fm = FileManager.default
            let cards = list.map { e -> HomeCard in
                var isDir: ObjCBool = false
                let exists = fm.fileExists(atPath: e.path, isDirectory: &isDir) && isDir.boolValue
                var summary = CommentSummary()
                if exists {
                    let c = e.path + "/comments.json"
                    let size = ((try? fm.attributesOfItem(atPath: c))?[.size] as? NSNumber)?.intValue ?? 0
                    if size > 0 && size <= CommentsRead.maxBytes { summary = CommentsRead.summary(try? Data(contentsOf: URL(fileURLWithPath: c))) }
                }
                return HomeCard(path: e.path, opened: e.opened, modified: exists ? Self.modified(e.path) : nil, exists: exists,
                                openComments: summary.open, server: summary.server)
            }
            DispatchQueue.main.async {
                guard token == self.reading else { return }
                self.cards = HomeLogic.ordered(cards)
                self.loaded = true
            }
        }
    }

    /// The picture of a file, if a snapshot was taken. Read from disk again when the PNG changed.
    func thumbnail(_ path: String) -> NSImage? {
        let url = Thumbnails.url(state: StateFolder.path, path: path)
        guard let stamp = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date else { return nil }
        if let hit = images[path], hit.stamp == stamp { return hit.image }
        guard let img = NSImage(contentsOf: url) else { return nil }
        images[path] = (stamp, img)
        return img
    }

    func thumbnailWritten() { thumbVersion += 1 }
}

// MARK: Model: showing Home, thumbnails

extension CanvasModel {
    /// Home takes the window: the canvas page stays alive underneath, hidden. The text being typed is written first,
    /// and the canvas is photographed for its card.
    func showHome() {
        guard !homeShown else { return }
        flushTextEdit { _ in
            let view = self.webView
            let file = self.currentFile
            var moved = false
            let show = {
                guard !moved, self.webView === view, self.currentFile == file else { return }
                moved = true
                self.homeShown = true
            }
            // Take the picture while WebKit still has a window to draw into.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: show)
            self.snapshotShown(then: show)
        }
    }

    @MainActor func revealInHome(_ file: String) {
        let store = HomeStore.shared
        store.query = ""
        if let location = CloudFilePath(file),
           let cloud = prefs.clouds.first(where: { CloudFilePath.key(for: $0.url) == location.key }) {
            store.section = .cloud(cloud.id)
        } else {
            store.section = .recents
            if !store.recents.contains(where: { $0.path == file }) { store.touch(file) }
        }
        store.revealPath = file
        showHome()
    }

    @MainActor func moveToTrash(_ file: String) {
        flushTextEdit { ok in
            guard ok else { return }
            self.afterWrites {
                do {
                    try FileManager.default.trashItem(at: URL(fileURLWithPath: file), resultingItemURL: nil)
                    self.close(file)
                    HomeStore.shared.remove(file)
                } catch {
                    self.flash("Could not move the file to the Trash")
                }
            }
        }
    }

    /// Save both sizes while the page is shown. A caller can wait for the writes before quitting.
    func snapshotShown(then done: (() -> Void)? = nil) {
        guard let file = currentFile, !boards.isEmpty, !homeShown else { done?(); return }
        let snapshots = DispatchGroup()
        snapshots.enter()
        saveThumbnail(of: webView, file: file) { snapshots.leave() }
        snapshots.enter()
        snapshotOpeningPicture { snapshots.leave() }
        if let done { snapshots.notify(queue: .main, execute: done) }
    }

    /// Writes a 480 px wide PNG of the page to the state folder. Nothing when the page is not up, or draws nothing.
    func saveThumbnail(of wv: WKWebView, file: String, then done: (() -> Void)? = nil) {
        guard !file.isEmpty, wv.url != nil, !wv.isLoading, wv.bounds.width > 100, wv.bounds.height > 100,
              FileManager.default.fileExists(atPath: file) else { done?(); return }
        let cfg = WKSnapshotConfiguration()
        let scale = max(wv.window?.backingScaleFactor ?? 2, 1)
        cfg.snapshotWidth = NSNumber(value: Double(Thumbnails.width) / Double(scale))
        let url = Thumbnails.url(state: StateFolder.path, path: file)
        wv.takeSnapshot(with: cfg) { image, _ in
            guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { done?(); return }
            DispatchQueue.global(qos: .utility).async {
                try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? png.write(to: url, options: .atomic)
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { HomeStore.shared.thumbnailWritten() }
                    done?()
                }
            }
        }
    }

    /// Learn Canvas: the course file (src/onboarding.ts makes the copy in Documents/Canvas).
    func openCourse() {
        var req = URLRequest(url: base.appendingPathComponent("api/welcome"))
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        req.setValue("1", forHTTPHeaderField: "x-canvas")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = Data("{}".utf8)
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let file = (response as? HTTPURLResponse)?.statusCode == 200
                ? (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["file"] as? String : nil
            DispatchQueue.main.async {
                if let file { self.open(file) } else { self.flash("Canvas could not open the course") }
            }
        }.resume()
    }
}

// MARK: Views

extension View {
    /// Layered soft shadows instead of a border: a hairline of depth, a tight one and a wide one.
    func cardShadow(_ lift: Bool = false) -> some View {
        shadow(color: .black.opacity(0.05), radius: 0.5, y: 0.5)
            .shadow(color: .black.opacity(lift ? 0.10 : 0.06), radius: lift ? 5 : 3, y: lift ? 2 : 1)
            .shadow(color: .black.opacity(lift ? 0.10 : 0.05), radius: lift ? 18 : 12, y: lift ? 8 : 6)
    }
}

enum HomeMetric {
    static let gutter: CGFloat = 28
    static let cardMin: CGFloat = 220
    static let cardMax: CGFloat = 340
    static let gap: CGFloat = 20
    static let thumbRatio: CGFloat = 1.6
    static let radiusCard: CGFloat = 12
    /// The status line's cap height (13 pt medium): a dot beside it sits on its capitals' middle.
    static let bodyCapHeight = NSFont.systemFont(ofSize: 13, weight: .medium).capHeight
}

struct HomeView: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject private var store = HomeStore.shared
    @ObservedObject private var account = CloudAccount.shared

    /// The room the left sidebar (Shell.swift LeftColumn, drawn over this view) takes; 0 while it is hidden.
    let sidebarReserve: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            HomeMain(model: model, store: store, account: account)
                .padding(.leading, sidebarReserve)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: sidebarReserve > 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.canvasBg.ignoresSafeArea())
        .transaction { if model.resizingSidebar { $0.animation = nil } }
        .onAppear { store.reload() }
        // A Cloud's page whose Cloud was removed (here, or in Settings) goes back to Recents.
        .onChange(of: model.prefs.clouds.map(\.id)) { _, ids in
            if let id = store.section.cloudId, !ids.contains(id) { store.section = .recents }
        }
        .task(id: model.prefs.clouds.map { $0.url + "|" + $0.devEmail }.joined(separator: ",")) {
            // Every Cloud's status: asked now, then every 30 s while Home is up (a connected answer is reused for a
            // minute, so each Cloud hears from this Mac about once a minute at most), and again when Canvas comes to
            // the front.
            var first = true
            while !Task.isCancelled {
                await account.refresh(model, fresh: first)
                first = false
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await account.refresh(model, fresh: true) }
        }
        .environment(\.titlebarTips, false)
    }
}

// MARK: Sidebar

struct HomeSidebar: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject private var store = HomeStore.shared
    @ObservedObject private var account = CloudAccount.shared

    var body: some View {
        VStack(spacing: 2) {
            // Nothing to search before the first file: Recents is the first row, level with the main view's title.
            if HomeLogic.showsSearch(files: store.recents.count + model.prefs.clouds.count, query: store.query) {
                FieldBox {
                    Image(systemName: "magnifyingglass").glyph(GlyphSize.field).foregroundStyle(Palette.mutedFg)
                    TextField(model.prefs.clouds.isEmpty ? "Search files" : "Search files and Clouds", text: $store.query).textFieldStyle(.plain).font(Typography.body)
                        .qaText("Search files")
                }
                .qaID("home-search", label: "Search files")
                .padding(.bottom, 8)
            }

            HomeRow(symbol: "clock", title: "Recents", selected: store.section == .recents) { store.section = .recents }
            HomeRow(symbol: "laptopcomputer", title: "On this Mac", selected: store.section == .mac) { store.section = .mac }
            HomeRow(symbol: "graduationcap", title: "Learn Canvas", selected: false) { model.openCourse() }

            // The Clouds under one quiet label with a + for Add Cloud; sorted by name, filtered by the search, and
            // scrolling when there are many (one per client is normal).
            HStack(spacing: 6) {
                Text("Clouds").font(Typography.section).foregroundStyle(Palette.mutedFg).lineLimit(1).qaText("Clouds")
                Spacer(minLength: 8)
                MiniButton(symbol: "plus", help: "Add Cloud") { AddCloudPanel.shared.show(model) }
                    .qaID("home-add-cloud", label: "Add Cloud")
            }
            .padding(.leading, 12).padding(.trailing, 6).frame(height: 24)
            .padding(.top, 14)
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(CloudList.filtered(model.prefs.clouds, query: store.query, name: HomeLogic.cloudName)) { e in
                        let s = account.state(e)
                        let word = HomeLogic.word(status: s.known ? s.status : nil)
                        HomeRow(symbol: HomeLogic.rowSymbol(kind: e.kind), title: HomeLogic.cloudName(e), selected: store.section == .cloud(e.id),
                                word: word, muted: word?.tone == .muted) {
                            store.section = .cloud(e.id)
                        }
                        .help(e.adapterTooltip)
                        .contextMenu {
                            Button("Rename") { RunLoop.main.perform { MainActor.assumeIsolated { account.renameCloud(model, e) } } }
                            Button("Settings") {
                                account.selected = e.id
                                SettingsWindow.shared.show(model, tab: .cloud)
                            }
                            if account.isHosting(e) {
                                Button("Copy Invite") { RunLoop.main.perform { MainActor.assumeIsolated { account.copyInvite(model, e) } } }
                            }
                            Divider()
                            Button(HomeLogic.cloudRemovalTitle(kind: e.kind), role: .destructive) {
                                RunLoop.main.perform { MainActor.assumeIsolated { account.removeCloud(model, e, leaving: true) } }
                            }
                        }
                        .disabled(account.busy.contains(e.url))
                    }
                }
            }
            .scrollIndicators(.automatic)
            .qaID("home-clouds")
        }
        .environment(\.titlebarTips, false)
    }
}

/// A sidebar row: a glyph, a name, and for a Cloud that needs the person a word ("Sign in", "Down"). Selected is
/// neutral grey with the glyph in the text colour.
private struct HomeRow: View {
    let symbol: String
    let title: String
    let selected: Bool
    var word: (text: String, tone: HomeLogic.Tone)?
    /// Dimmed: a Cloud that is down or offline.
    var muted = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: symbol).glyph(GlyphSize.row + 1)
                    .foregroundStyle(selected ? Palette.fg : (muted ? Palette.mutedFg : Palette.fg.opacity(0.75)))
                    // Taller than the name's line: the row centres on the line the name's capitals and the glyph share.
                    .frame(width: 16, height: 20).qaID("home-row-glyph", label: title)
                Text(title).font(Typography.body).fontWeight(selected ? .medium : nil).lineLimit(1).capCentered(13)
                    .foregroundStyle(muted && !selected ? Palette.mutedFg : Palette.fg).qaText(title)
                Spacer(minLength: 8)
                if let word {
                    Text(word.text).font(Typography.micro).fontWeight(.medium).lineLimit(1).capCentered(11)
                        .foregroundStyle(word.tone == .attention ? CloudInk.warn : Palette.mutedFg)
                        .qaID("home-cloud-word", label: word.text)
                }
            }
            .padding(.horizontal, 12).frame(height: Metric.row)
            .background(RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).fill(selected ? Palette.active : hovering ? Palette.hover : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .qaID("home-row", label: title)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

// MARK: Main

private struct HomeMain: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var store: HomeStore
    @ObservedObject var account: CloudAccount

    /// The Cloud whose page shows, if the section is one and it is still in the list.
    private var cloud: CloudEntry? { account.entry(model, id: store.section.cloudId) }

    private var visible: [HomeCard] {
        let base: [HomeCard]
        switch store.section {
        case .recents: base = store.cards
        case .mac: base = HomeLogic.filter(store.cards, .mac)
        case .cloud: base = cloud.map { HomeLogic.onServer(store.cards, $0.url) } ?? []
        }
        let named = base.map { card in
            var card = card
            if CloudFilePath(card.path) != nil { card.cloudName = model.name(of: card.path) }
            return card
        }
        return HomeLogic.search(named, store.query)
    }

    private var onServer: Bool { cloud != nil }

    /// The one muted line in place of the files, or nil when there are files to show. With no recents at all it
    /// shows at once; otherwise only after the first read, so a view with files does not flash it.
    private var emptyLine: String? {
        guard store.loaded || store.recents.isEmpty, visible.isEmpty else { return nil }
        return HomeLogic.emptyLine(query: store.query, onServer: onServer, files: store.cards.count)
    }

    /// The header sits level with the sidebar's first control: the search field, or Recents' row before the first file.
    private var headerHeight: CGFloat { HomeLogic.showsSearch(files: store.recents.count, query: store.query) ? Metric.field : Metric.row }
    /// The sidebar panel's top plus its padding: the header's top is its first control's top.
    private var topInset: CGFloat { Metric.topBar + 2 * Metric.sidebarGap }

    @ViewBuilder private var top: some View {
        if let cloud {
            HomeCloudHeader(model: model, account: account, entry: cloud, height: headerHeight)
        } else {
            HomeHeader(model: model, title: store.section == .mac ? "On this Mac" : "Recents", height: headerHeight)
        }
    }

    var body: some View {
        if let cloud, cloud.kind != .server {
            CloudFilesView(model: model, entry: cloud).id(cloud.id)
                .padding(.horizontal, HomeMetric.gutter).padding(.top, topInset)
                .padding(.bottom, HomeMetric.gutter)
        } else if let emptyLine {
            // Nothing to scroll: the header on top, the line in the middle of the space left under it.
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 20) { top }
                HomeEmpty(text: emptyLine)
            }
            .padding(.horizontal, HomeMetric.gutter)
            .padding(.top, topInset)
            .padding(.bottom, HomeMetric.gutter)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        top
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: HomeMetric.cardMin, maximum: HomeMetric.cardMax), spacing: HomeMetric.gap, alignment: .top)],
                                  alignment: .leading, spacing: 24) {
                            ForEach(visible) { c in
                                HomeCardView(model: model, store: store, card: c, showWhere: !onServer)
                                    .id(c.path)
                            }
                        }
                    }
                    .padding(.horizontal, HomeMetric.gutter)
                    .padding(.top, topInset)
                    .padding(.bottom, HomeMetric.gutter)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }
                .scrollIndicators(.never)
                .task(id: visible.first(where: { $0.path == store.revealPath })?.path) {
                    guard let file = store.revealPath, visible.contains(where: { $0.path == file }) else { return }
                    scroll.scrollTo(file, anchor: .center)
                    store.revealPath = nil
                }
            }
        }
    }
}

/// The title and the two actions, in one row of one height: the sidebar's first control's, so the two sit level.
private struct HomeHeader: View {
    @ObservedObject var model: CanvasModel
    let title: String
    let height: CGFloat

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(Typography.display).lineLimit(1).foregroundStyle(Palette.fg).qaText(title)
            Spacer(minLength: 8)
            FieldButton(title: "Open", symbol: "folder") { model.openDocument() }.qaID("home-open", label: "Open")
            FieldButton(title: "New file", symbol: "plus", prominent: true) { model.newCanvas() }.qaID("home-new", label: "New file")
        }
        .frame(height: height)
    }
}

/// The one muted line where files would be: no box, no glyph, centred in the space it is given.
private struct HomeEmpty: View {
    let text: String

    var body: some View {
        Text(text).font(Typography.body).foregroundStyle(Palette.mutedFg).lineLimit(1).truncationMode(.middle).qaText(text)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .qaID("home-empty", label: text)
    }
}

// MARK: Cards

private struct HomeCardView: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var store: HomeStore
    let card: HomeCard
    /// A shared file's cloud before its time (off on a Cloud's own page, where every file is that Cloud's).
    var showWhere = true
    @State private var hovering = false
    @State private var renaming = false
    @State private var draft = ""

    private var local: Bool { CloudFilePath(card.path) == nil }

    var body: some View {
        let where_ = HomeLogic.whereLabel(server: card.server, clouds: model.prefs.clouds)
        VStack(alignment: .leading, spacing: 10) {
            Button { if card.exists, NSApp.currentEvent?.type != .rightMouseUp { model.open(card.path) } } label: {
                HomeThumbnail(store: store, card: card)
                    .aspectRatio(HomeMetric.thumbRatio, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: HomeMetric.radiusCard, style: .continuous))
                    .cardShadow(hovering && card.exists)
                    .contentShape(RoundedRectangle(cornerRadius: HomeMetric.radiusCard, style: .continuous))
            }
            .buttonStyle(.plain)
            .help(card.exists ? "Open \(card.name)" : "\(card.name) was moved or deleted")
            .accessibilityLabel(card.name)
            .qaID("home-card", label: card.name)

            VStack(alignment: .leading, spacing: 7) {
                Text(card.name).font(Typography.body).fontWeight(.semibold).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(Palette.fg).qaText(card.name)
                if card.exists {
                    let when = HomeLogic.whenLabel(opened: card.opened, modified: card.modified, now: Date().timeIntervalSince1970)
                    HStack(spacing: 8) {
                        // The time alone; a file on a Cloud server gets a cloud before it, and names the server in its tooltip.
                        HStack(spacing: 4) {
                            if card.shared && showWhere {
                                Image(systemName: where_.symbol).glyph(GlyphSize.row).foregroundStyle(Palette.mutedFg).qaID("home-card-where-glyph", label: where_.text)
                            }
                            Text(when).font(Typography.label).fontWeight(.regular).foregroundStyle(Palette.mutedFg).lineLimit(1).qaText(when)
                        }
                        .help(card.shared ? "On \(where_.text)" : "")
                        .layoutPriority(1)
                        Spacer(minLength: 0)
                        if card.openComments > 0 {
                            HStack(spacing: 3) {
                                Image(systemName: "bubble.left").glyph(GlyphSize.row).foregroundStyle(Palette.mutedFg).qaID("home-card-comments-glyph")
                                Text(HomeLogic.commentBadge(card.openComments)).font(Typography.label).monospacedDigit().foregroundStyle(Palette.fg.opacity(0.8))
                                    .qaID("home-card-count", label: HomeLogic.commentBadge(card.openComments))
                            }
                            .help("\(card.openComments) open comments")
                            .qaID("home-comments", label: HomeLogic.commentBadge(card.openComments))
                        }
                    }
                    .frame(height: 16)
                } else {
                    Text("Moved or deleted").font(Typography.label).foregroundStyle(Palette.mutedFg).lineLimit(1).qaText("Moved or deleted")
                    FieldButton(title: "Remove from recents", symbol: nil) { store.remove(card.path) }
                        .qaID("home-remove", label: "Remove from recents")
                }
            }
        }
        .opacity(card.exists ? 1 : 0.55)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
        .contextMenu {
            Button("Open") { model.open(card.path) }.disabled(!card.exists)
            if local {
                Button("Duplicate") { model.duplicateFile(card.path) }.disabled(!card.exists)
                Button("Rename") { draft = card.name; renaming = true }.disabled(!card.exists)
            }
            Button("Copy Link") { model.copyFileLink(card.path) }.disabled(!card.exists)
            if local {
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: card.path)]) }.disabled(!card.exists)
                Button("Move to Cloud") { CloudAccount.shared.moveOpenFile(model, file: card.path) }.disabled(!card.exists)
            }
            Button("Remove from recents") { store.remove(card.path) }
            if local {
                Divider()
                Button("Move to Trash", role: .destructive) { model.moveToTrash(card.path) }.disabled(!card.exists)
            }
        }
        .alert("Rename File", isPresented: $renaming) {
            TextField("Name", text: $draft)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { model.renameFile(card.path, to: draft) }
        }
    }
}

/// The card's picture, or a neutral tile with the file's initial.
private struct HomeThumbnail: View {
    @ObservedObject var store: HomeStore
    let card: HomeCard

    var body: some View {
        Color.clear.overlay {
            if card.exists, store.thumbVersion >= 0, let img = store.thumbnail(card.path) {
                Image(nsImage: img).resizable().scaledToFill()
            } else {
                HomeFilePlaceholder(name: card.name)
            }
        }
        .clipped()
        .saturation(card.exists ? 1 : 0)
    }
}

/// Home and Cloud files share the same tile until a thumbnail is available.
struct HomeFilePlaceholder: View {
    let name: String
    var body: some View {
        Palette.muted.overlay {
            Text(HomeLogic.initial(name + ".canvas")).font(.system(size: 34, weight: .semibold)).foregroundStyle(Palette.mutedFg.opacity(0.7))
        }
    }
}

// MARK: A Cloud's page

/// A Cloud's name, a pill for where it stands (Live, Down, Sign in) and a gear for its settings, level with the
/// sidebar's first control. Email and host stay in Settings.
private struct HomeCloudHeader: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var account: CloudAccount
    let entry: CloudEntry
    let height: CGFloat

    var body: some View {
        let name = HomeLogic.cloudName(entry)
        let s = account.state(entry)
        let word = HomeLogic.word(status: s.known ? s.status : nil)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text(name).font(Typography.display).lineLimit(1).foregroundStyle(Palette.fg).qaText(name)
                if entry.adapterAlpha { Badge(text: "Alpha").qaID("cloud-alpha-badge", label: "Alpha") }
                // A pill only when the Cloud needs the person (Sign in, Down): a Cloud that works says nothing.
                if let word {
                    CloudPill(text: word.text, tone: word.tone) {
                        if s.status == "signedOut" || s.status == "signInAgain", entry.kind == .server { account.signIn(model, entry) }
                    }
                    .help(CloudStatusText.detail(s.status, name: name) ?? CloudStatusText.line(s.status, configured: true))
                }
                Spacer(minLength: 8)
                MiniButton(symbol: "gearshape", help: "Cloud settings", inRow: true) {
                    account.selected = entry.id
                    SettingsWindow.shared.show(model, tab: .cloud)
                }
                .qaID("home-cloud-settings", label: "Cloud settings")
            }
            .frame(height: height)
            if entry.adapterAlpha {
                Text(CloudEntry.alphaNotice).font(Typography.micro).foregroundStyle(CloudInk.warn)
                    .fixedSize(horizontal: false, vertical: true).qaID("cloud-alpha-notice", label: CloudEntry.alphaNotice)
            }
        }
    }
}
