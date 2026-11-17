// Home: the pinned first tab. A native screen shown in place of the canvas web view (the file tabs' pages stay alive
// under it): the recent files as cards, the files on this Mac, the team server and what is shared to it, and the
// three ways in on a first launch. The logic (recents, summaries, order, labels) is HomeLogic.swift.
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

enum HomeSection: Hashable { case recents, mac, server }

@MainActor
final class HomeStore: ObservableObject {
    static let shared = HomeStore()

    @Published var query = ""
    @Published var section: HomeSection = .recents
    @Published var filter: HomeFilter = .all
    @Published private(set) var cards: [HomeCard] = []
    /// False until the first read of the files finished (so a first launch does not flash its empty state).
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
            self.snapshotShown()
            self.homeShown = true
        }
    }

    /// A snapshot of the shown page, for its card on Home. Only a page that has a document drawn.
    func snapshotShown(then done: (() -> Void)? = nil) {
        guard let file = currentFile, !boards.isEmpty, !homeShown else { done?(); return }
        saveThumbnail(of: webView, file: file, then: done)
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

/// Tints of the first-launch cards: a pale colour in light, the same hue dim in dark. The glyph is the hue's ink.
private enum HomeTint {
    static let course = (bg: Color(light: 0xDCFCE7, dark: 0x22C55E, 0.18), ink: Color(light: 0x15803D, dark: 0x4ADE80))
    static let file = (bg: Color(light: 0xE0E7FF, dark: 0x6366F1, 0.20), ink: Color(light: 0x4338CA, dark: 0xA5B4FC))
    static let team = (bg: Color(light: 0xE0F2FE, dark: 0x0EA5E9, 0.18), ink: Color(light: 0x0369A1, dark: 0x7DD3FC))
}

private extension View {
    /// Layered soft shadows instead of a border: a hairline of depth, a tight one and a wide one.
    func cardShadow(_ lift: Bool = false) -> some View {
        shadow(color: .black.opacity(0.05), radius: 0.5, y: 0.5)
            .shadow(color: .black.opacity(lift ? 0.10 : 0.06), radius: lift ? 5 : 3, y: lift ? 2 : 1)
            .shadow(color: .black.opacity(lift ? 0.10 : 0.05), radius: lift ? 18 : 12, y: lift ? 8 : 6)
    }
}

enum HomeMetric {
    static let sidebar: CGFloat = 232
    static let sidebarMin: CGFloat = 200
    static let sidebarMax: CGFloat = 360
    /// The most of the window the sidebar may take, so the file list keeps its room.
    static let sidebarShare: CGFloat = 0.4
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

    private var configured: Bool { CloudURL.clean(model.prefs.cloudUrl) != nil }
    private var serverUrl: String { CloudURL.clean(model.prefs.cloudUrl) ?? "" }

    @State private var windowWidth: CGFloat = 0

    /// The sidebar's width in this window: the stored one, held between the minimum and what the window allows.
    private var sidebarMax: CGFloat {
        windowWidth > 0 ? SidebarSize.cap(window: windowWidth, share: HomeMetric.sidebarShare, min: HomeMetric.sidebarMin, max: HomeMetric.sidebarMax) : HomeMetric.sidebarMax
    }
    private var sidebarShown: CGFloat { min(max(model.homeSidebarWidth, HomeMetric.sidebarMin), sidebarMax) }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            GlassIsland(radius: Metric.radiusIsland, padding: Metric.islandPad, dense: true) {
                HomeSidebar(model: model, store: store, account: account, configured: configured, serverUrl: serverUrl)
            }
            .frame(width: sidebarShown)
            .overlay(alignment: .trailing) {
                SidebarResizeHandle(model: model, shown: sidebarShown, minWidth: HomeMetric.sidebarMin, maxWidth: sidebarMax,
                                    defaultWidth: HomeMetric.sidebar) { model.homeSidebarWidth = $0 }
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .padding(.leading, Metric.inset)
            .padding(.top, Metric.inset + Metric.pill + Metric.islandGap)
            .padding(.bottom, Metric.inset)

            HomeMain(model: model, store: store, account: account, configured: configured, serverUrl: serverUrl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.canvasBg.ignoresSafeArea())
        .background(GeometryReader { g in
            Color.clear.onAppear { windowWidth = g.size.width }.onChange(of: g.size.width) { _, w in windowWidth = w }
        })
        .transaction { if model.resizingSidebar { $0.animation = nil } }
        .onAppear { store.reload() }
        .task {
            // The server's status: asked now, then every 30 s while Home is up (a connected answer is reused for a
            // minute, so the team's server hears from this Mac about once a minute at most), and again when Canvas
            // comes to the front.
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

private struct HomeSidebar: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var store: HomeStore
    @ObservedObject var account: CloudAccount
    let configured: Bool
    let serverUrl: String

    private var dot: HomeLogic.Dot { HomeLogic.dot(status: account.state.status, configured: account.state.configured) }

    var body: some View {
        VStack(spacing: 2) {
            FieldBox {
                Image(systemName: "magnifyingglass").glyph(GlyphSize.field).foregroundStyle(Palette.mutedFg)
                TextField("Search files", text: $store.query).textFieldStyle(.plain).font(Typography.body)
                    .qaText("Search files")
            }
            .qaID("home-search", label: "Search files")
            .padding(.bottom, 8)

            HomeRow(symbol: "clock", title: "Recents", selected: store.section == .recents) { store.section = .recents }
            HomeRow(symbol: "laptopcomputer", title: "On this Mac", selected: store.section == .mac) { store.section = .mac }
            HomeRow(symbol: "graduationcap", title: "Learn Canvas", selected: false) { model.openCourse() }

            Text("Cloud").font(Typography.section).foregroundStyle(Palette.mutedFg).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 6)
                .qaText("Cloud")
            if configured {
                HomeRow(symbol: "cloud", title: ServerName.label(serverUrl, name: model.prefs.cloudName), selected: store.section == .server, dot: dot) { store.section = .server }
            }
            HomeRow(symbol: "plus", title: "Add Cloud", selected: false, muted: true) {
                SettingsWindow.shared.show(model, tab: .cloud)
            }
        }
    }
}

/// A sidebar row: a glyph, a name, and for a server a dot. Selected is neutral grey with the glyph in the text colour.
private struct HomeRow: View {
    let symbol: String
    let title: String
    let selected: Bool
    var dot: HomeLogic.Dot?
    var muted = false
    let action: () -> Void
    @State private var hovering = false

    private func dotColor(_ d: HomeLogic.Dot) -> Color {
        switch d {
        case .connected: Palette.ok
        case .offline: Palette.mutedFg.opacity(0.5)
        case .attention: Palette.warn
        }
    }

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
                if let dot {
                    StatusDot(color: dotColor(dot), size: 7).help(HomeLogic.dotWords(dot))
                        .qaID("home-server-dot", label: HomeLogic.dotWords(dot))
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
    let configured: Bool
    let serverUrl: String

    private var visible: [HomeCard] {
        let base: [HomeCard]
        switch store.section {
        case .recents: base = HomeLogic.filter(store.cards, store.filter)
        case .mac: base = HomeLogic.filter(store.cards, .mac)
        case .server: base = HomeLogic.onServer(store.cards, serverUrl)
        }
        return HomeLogic.search(base, store.query)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if store.section == .server && configured {
                    HomeServerView(model: model, store: store, account: account, serverUrl: serverUrl, cards: visible)
                } else if store.loaded && store.cards.isEmpty && store.section != .server {
                    HomeFirstLaunch(model: model)
                } else {
                    HomeHeader(model: model, title: store.section == .mac ? "On this Mac" : "Recents")
                    if store.section == .recents {
                        HomeSegments(items: HomeFilter.allCases.map { ($0.title, $0) }, selection: store.filter) { store.filter = $0 }
                            .fixedSize().qaID("home-filter")
                    }
                    if visible.isEmpty {
                        HomeEmpty(text: store.query.isEmpty ? "Nothing here yet" : "No files match \u{201C}\(store.query)\u{201D}", detail: nil, symbol: "magnifyingglass")
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: HomeMetric.cardMin, maximum: HomeMetric.cardMax), spacing: HomeMetric.gap, alignment: .top)],
                                  alignment: .leading, spacing: 24) {
                            ForEach(visible) { c in HomeCardView(model: model, store: store, card: c) }
                        }
                    }
                }
            }
            .padding(.horizontal, HomeMetric.gutter)
            .padding(.top, Metric.inset + Metric.pill + Metric.islandGap)
            .padding(.bottom, HomeMetric.gutter)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollIndicators(.never)
    }
}

/// The title and the two actions, in one row of one height.
private struct HomeHeader: View {
    @ObservedObject var model: CanvasModel
    let title: String

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(Typography.display).lineLimit(1).foregroundStyle(Palette.fg).qaText(title)
            Spacer(minLength: 8)
            FieldButton(title: "Open", symbol: "folder") { model.openDocument() }.qaID("home-open", label: "Open")
            FieldButton(title: "New file", symbol: "plus", prominent: true) { model.newCanvas() }.qaID("home-new", label: "New file")
        }
        .frame(height: Metric.pill - 8)
    }
}

private struct HomeEmpty: View {
    let text: String
    let detail: String?
    let symbol: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).glyph(20).foregroundStyle(Palette.mutedFg).qaID("home-empty-glyph")
            Text(text).font(Typography.label).foregroundStyle(Palette.mutedFg).qaText(text)
            if let detail { Text(detail).font(Typography.micro).foregroundStyle(Palette.mutedFg).multilineTextAlignment(.center) }
        }
        .frame(maxWidth: .infinity).frame(height: 220)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.hover))
        .qaID("home-empty")
    }
}

/// Home's filter: text segments at field height, each as wide as its words plus room (the inspector's TextSegments
/// squeeze to equal widths, which is too tight for "On this Mac").
private struct HomeSegments<Tag: Hashable>: View {
    let items: [(title: String, tag: Tag)]
    let selection: Tag
    let onSelect: (Tag) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items.indices, id: \.self) { i in
                let item = items[i]
                Button { onSelect(item.tag) } label: {
                    Text(item.title).font(Typography.label).lineLimit(1).qaText(item.title)
                        .foregroundStyle(selection == item.tag ? Palette.fg : Palette.mutedFg)
                        .capCentered(12, weight: .medium)
                        .padding(.horizontal, 12).frame(height: Metric.field - 4)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusField - 2, style: .continuous)
                            .fill(selection == item.tag ? Palette.active : .clear))
                        .contentShape(Rectangle())
                        .qaID("home-segment", label: item.title)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == item.tag ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: Metric.radiusField, style: .continuous).fill(Palette.field))
    }
}

// MARK: Cards

private struct HomeCardView: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var store: HomeStore
    let card: HomeCard
    @State private var hovering = false

    var body: some View {
        let where_ = HomeLogic.whereLabel(server: card.server, current: model.prefs.cloudUrl, name: model.prefs.cloudName)
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
                    HStack(spacing: 8) {
                        HStack(spacing: 4) {
                            Image(systemName: where_.symbol).glyph(GlyphSize.row).foregroundStyle(Palette.mutedFg).qaID("home-card-where-glyph")
                            Text(where_.text).font(Typography.label).foregroundStyle(Palette.fg.opacity(0.8)).lineLimit(1).qaText(where_.text)
                        }
                        .layoutPriority(1)
                        Text(HomeLogic.whenLabel(opened: card.opened, modified: card.modified, now: Date().timeIntervalSince1970))
                            .font(Typography.label).fontWeight(.regular).foregroundStyle(Palette.mutedFg).lineLimit(1)
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
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: card.path)]) }.disabled(!card.exists)
            Divider()
            Button("Remove from recents") { store.remove(card.path) }
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
                Palette.muted.overlay {
                    Text(HomeLogic.initial(card.path)).font(.system(size: 34, weight: .semibold)).foregroundStyle(Palette.mutedFg.opacity(0.7))
                }
            }
        }
        .clipped()
        .saturation(card.exists ? 1 : 0)
    }
}

// MARK: First launch

private struct HomeFirstLaunch: View {
    @ObservedObject var model: CanvasModel

    var body: some View {
        Text("Welcome to Canvas").font(Typography.display).foregroundStyle(Palette.fg).lineLimit(1)
            .frame(height: Metric.pill - 8, alignment: .leading).qaText("Welcome to Canvas")
        HStack(alignment: .top, spacing: HomeMetric.gap) {
            HomeStart(symbol: "graduationcap", tint: HomeTint.course, title: "Learn Canvas",
                      text: "Eleven short lessons, each with something to try. About ten minutes.", button: "Start the course", prominent: true) { model.openCourse() }
            HomeStart(symbol: "doc.badge.plus", nudge: CGSize(width: 2, height: 0.5), tint: HomeTint.file, title: "New file",
                      text: "A blank canvas on this Mac. Ask your agent for a first board, or drop in a screenshot.", button: "New file", prominent: false) { model.newCanvas() }
            HomeStart(symbol: "cloud", nudge: CGSize(width: 0, height: -0.5), tint: HomeTint.team, title: "Work with your team",
                      text: "Connect a server your team runs on its own Cloudflare account. Comments sync live.", button: "Add Cloud", buttonTrailing: 11, prominent: false) {
                SettingsWindow.shared.show(model, tab: .cloud)
            }
        }
        HomeEmpty(text: "Files you open show up here", detail: "Or drop a .canvas file anywhere on this window", symbol: "clock")
    }
}

private struct HomeStart: View {
    let symbol: String
    /// Optical nudge: the symbol's drawing sits off its glyph box's middle (doc.badge.plus leans left, cloud sits low).
    var nudge: CGSize = .zero
    let tint: (bg: Color, ink: Color)
    let title: String
    let text: String
    let button: String
    /// The button's right padding, when its last letter needs its own (FieldButton.trailing).
    var buttonTrailing: CGFloat? = nil
    let prominent: Bool
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: symbol).glyph(18).foregroundStyle(tint.ink)
                .offset(nudge)
                .frame(width: 36, height: 36)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(tint.bg))
                .qaID("home-start-mark", label: title)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(Typography.cardTitle).foregroundStyle(Palette.fg).lineLimit(1).qaText(title)
                Text(text).font(Typography.body).foregroundStyle(Palette.mutedFg).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 54, alignment: .topLeading)
            }
            FieldButton(title: button, symbol: nil, prominent: prominent, trailing: buttonTrailing, action: action).qaID("home-start", label: button)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.popover))
        .cardShadow()
    }
}

// MARK: Team server

private struct HomeServerView: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var store: HomeStore
    @ObservedObject var account: CloudAccount
    let serverUrl: String
    let cards: [HomeCard]

    private var dot: HomeLogic.Dot { HomeLogic.dot(status: account.state.status, configured: account.state.configured) }
    private var connected: String? {
        account.state.status == "connected" ? HomeLogic.connectedLine(email: account.state.email, role: account.state.role) : nil
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(ServerName.label(serverUrl, name: model.prefs.cloudName)).font(Typography.display).lineLimit(1).foregroundStyle(Palette.fg).qaText(ServerName.label(serverUrl, name: model.prefs.cloudName))
            Spacer(minLength: 8)
            FieldButton(title: "Cloud settings", symbol: "gearshape") { SettingsWindow.shared.show(model, tab: .cloud) }.qaID("home-cloud-settings", label: "Cloud settings")
        }
        .frame(height: Metric.pill - 8)

        HStack(alignment: .firstTextBaseline, spacing: 6) {
            // On the status line's capitals, not between the two lines.
            Circle().fill(dot == .connected ? Palette.ok : dot == .attention ? Palette.warn : Palette.mutedFg.opacity(0.5)).frame(width: 7, height: 7)
                .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + HomeMetric.bodyCapHeight / 2 }
                .qaID("home-status-dot")
            VStack(alignment: .leading, spacing: 7) {
                Text(connected ?? CloudStatusText.line(account.state.status, configured: account.state.configured))
                    .font(Typography.body).fontWeight(.medium).foregroundStyle(Palette.fg).lineLimit(1).qaText(connected ?? "Server status")
                Text(ServerName.host(serverUrl)).font(Typography.label).fontWeight(.regular).foregroundStyle(Palette.mutedFg).lineLimit(1)
            }
            Spacer(minLength: 0)
            if account.state.status == "signInAgain" || account.state.status == "signedOut" {
                FieldButton(title: "Sign in", symbol: nil) { account.signIn(model) }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: HomeMetric.radiusCard, style: .continuous).fill(Palette.popover))
        .cardShadow()
        .qaID("home-server-card")

        if cards.isEmpty {
            HomeEmpty(text: store.query.isEmpty ? "No files shared to this server yet" : "No files match \u{201C}\(store.query)\u{201D}",
                      detail: store.query.isEmpty ? "Open a file, then File > Share Comments to Server" : nil, symbol: "cloud")
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Text("Name").frame(maxWidth: .infinity, alignment: .leading)
                    Text("Comments").frame(width: 90, alignment: .leading)
                    Text("Edited").frame(width: 120, alignment: .leading)
                }
                .font(Typography.label).fontWeight(.medium).foregroundStyle(Palette.mutedFg).lineLimit(1)
                .padding(.horizontal, 16).frame(height: 34)
                ForEach(cards) { c in
                    Rectangle().fill(Palette.line).frame(height: 1).frame(maxWidth: .infinity)
                    HomeServerRow(model: model, store: store, card: c)
                }
            }
            .background(RoundedRectangle(cornerRadius: HomeMetric.radiusCard, style: .continuous).fill(Palette.popover))
            .clipShape(RoundedRectangle(cornerRadius: HomeMetric.radiusCard, style: .continuous))
            .cardShadow()
        }
    }
}

private struct HomeServerRow: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var store: HomeStore
    let card: HomeCard
    @State private var hovering = false

    var body: some View {
        Button { if card.exists, NSApp.currentEvent?.type != .rightMouseUp { model.open(card.path) } } label: {
            HStack(spacing: 12) {
                HStack(spacing: 12) {
                    HomeThumbnail(store: store, card: card).frame(width: 52, height: 34)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    Text(card.name).font(Typography.body).fontWeight(.medium).foregroundStyle(Palette.fg).lineLimit(1).qaText(card.name)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 4) {
                    Image(systemName: "bubble.left").glyph(GlyphSize.row).foregroundStyle(Palette.mutedFg)
                    Text(card.exists ? HomeLogic.commentsLine(card.openComments) : "Moved or deleted").font(Typography.label).fontWeight(.regular)
                        .foregroundStyle(card.openComments > 0 ? Palette.fg.opacity(0.8) : Palette.mutedFg).lineLimit(1)
                }
                .frame(width: 90, alignment: .leading)
                Text(HomeLogic.ago(max(card.opened, card.modified ?? 0), now: Date().timeIntervalSince1970))
                    .font(Typography.label).fontWeight(.regular).foregroundStyle(Palette.mutedFg).lineLimit(1)
                    .frame(width: 120, alignment: .leading)
            }
            .padding(.horizontal, 16).frame(height: 56)
            .background(hovering ? Palette.hover : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .qaID("home-server-file", label: card.name)
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
        .contextMenu {
            Button("Open") { model.open(card.path) }.disabled(!card.exists)
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: card.path)]) }.disabled(!card.exists)
            Divider()
            Button("Remove from recents") { store.remove(card.path) }
        }
    }
}
