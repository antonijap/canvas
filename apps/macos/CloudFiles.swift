// The host lists every live file, including files this Mac has never opened.
import AppKit
import SwiftUI
import UniformTypeIdentifiers

private struct CloudFileItem: Identifiable {
    let id: String
    let name: String
    let updated: String?
}

struct CloudFilesView: View {
    @ObservedObject var model: CanvasModel
    let entry: CloudEntry
    @ObservedObject private var account = CloudAccount.shared
    @State private var files: [CloudFileItem] = []
    @State private var role = "viewer"
    @State private var warning: String?
    @State private var loaded = false
    @State private var offline = false
    @State private var query = ""
    @State private var opening = false
    @State private var targeted = false

    private var canEdit: Bool { loaded && !offline && CloudFilesText.canEdit(role) }
    private var busy: Bool { opening || account.busy.contains(entry.url) }
    private var visible: [CloudFileItem] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        return files.filter { item in words.allSatisfy { item.name.localizedCaseInsensitiveContains($0) } }
    }

    static func read(_ model: CanvasModel, entry: CloudEntry, path: String) async -> [String: Any] {
        #if CANVAS_QA
        if path == "api/cloud/usage", let meter = QA.cloudUsage { return meter }
        #endif
        var c = URLComponents(url: model.base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "cloud", value: entry.url)]
        guard let url = c?.url else { return [:] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        guard let (data, _) = try? await URLSession.shared.data(for: request) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private func refresh() async {
        let j = await Self.read(model, entry: entry, path: "api/cloud/files")
        guard !Task.isCancelled else { return }
        offline = j["files"] == nil
        if let rows = j["files"] as? [[String: Any]] {
            files = rows.compactMap { r in
                guard let id = r["id"] as? String, let name = r["name"] as? String else { return nil }
                return CloudFileItem(id: id, name: name, updated: r["updated_at"] as? String)
            }
            role = j["role"] as? String ?? "viewer"
        }
        loaded = true
        let usage = role == "owner" && !offline ? await Self.read(model, entry: entry, path: "api/cloud/usage") : [:]
        guard !Task.isCancelled else { return }
        warning = CloudFilesText.warning(offline: offline, usage: usage)
    }

    private func settings() {
        account.selected = entry.id
        SettingsWindow.shared.show(model, tab: .cloud)
    }

    private func open(_ item: CloudFileItem) {
        opening = true
        Task {
            let (status, j) = await CloudAccount.post(model, "api/cloud/files/open", ["cloud": entry.url, "id": item.id])
            opening = false
            if status == 200, let file = j["file"] as? String {
                model.cloudFileNames[file] = item.name
                model.open(file)
            } else { model.flash(CloudFilesText.problem(code: j["code"] as? String, fallback: "Could not open the Cloud file. Try again.")) }
        }
    }

    private func move(_ url: URL) {
        guard canEdit, !busy, url.isFileURL, url.pathExtension.lowercased() == "canvas" else { return }
        account.moveOpenFile(model, file: url.path, to: entry)
    }

    private func pickFile() {
        let panel = NSOpenPanel()
        panel.title = "Move a file here"
        panel.prompt = "Move"
        panel.allowedContentTypes = [CanvasModel.canvasType]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.treatsFilePackagesAsDirectories = false
        if panel.runModal() == .OK, let url = panel.url { move(url) }
    }

    private func drop(_ providers: [NSItemProvider]) -> Bool {
        guard canEdit, !busy, providers.count == 1, let provider = providers.first else { return false }
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
            let url: URL?
            if let data = item as? Data { url = URL(dataRepresentation: data, relativeTo: nil) }
            else if let value = item as? URL { url = value }
            else if let value = item as? String { url = URL(string: value) }
            else { url = nil }
            guard let url else { return }
            Task { @MainActor in move(url) }
        }
        return true
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(HomeLogic.cloudName(entry)).font(Typography.display).lineLimit(1).frame(height: 22).foregroundStyle(Palette.fg).qaText(HomeLogic.cloudName(entry))
            Spacer(minLength: 8)
            if !files.isEmpty {
                FieldBox {
                    Image(systemName: "magnifyingglass").glyph(GlyphSize.field).foregroundStyle(Palette.mutedFg)
                    TextField("Search files", text: $query).textFieldStyle(.plain).font(Typography.label).lineLimit(1)
                        .accessibilityLabel("Search Cloud files")
                }.frame(width: 180, height: Metric.field).qaID("cloud-files-search", label: "Search files")
            }
            if canEdit {
                FieldButton(title: "New file", symbol: "plus", prominent: true) { account.newFile(model, in: entry) }
                    .disabled(busy).qaID("cloud-files-new", label: "New file")
            }
        }.frame(height: Metric.field)
    }

    private var empty: some View {
        VStack(spacing: 14) {
            let title = CloudFilesText.canEdit(role) ? "No files in \(HomeLogic.cloudName(entry)) yet" : "No files yet"
            Text(title).font(Typography.display).foregroundStyle(Palette.fg).lineLimit(1).frame(height: 22).qaID("cloud-files-empty", label: title)
            let line = CloudFilesText.canEdit(role) ? "Files here open for everyone in this Cloud." : "Files show up here when an editor adds them."
            Text(line).font(Typography.body).foregroundStyle(Palette.mutedFg).lineLimit(1).frame(height: 13).qaText(line)
            if canEdit {
                HStack(spacing: 8) {
                    FieldButton(title: "New file", symbol: "plus", prominent: true) { account.newFile(model, in: entry) }
                        .disabled(busy).qaID("cloud-files-empty-new", label: "New file")
                    FieldButton(title: "Move a file here\u{2026}", symbol: "folder") { pickFile() }
                        .disabled(busy).qaID("cloud-files-move", label: "Move a file here")
                }.padding(.top, 6)
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header
            if let warning {
                HStack(spacing: 12) {
                    Text(warning).font(Typography.label).foregroundStyle(CloudInk.warn).lineLimit(1).frame(height: 12)
                        .qaID("cloud-files-warning", label: warning)
                    Spacer(minLength: 0)
                    FieldButton(title: "Open Settings", symbol: nil) { settings() }
                        .qaID("cloud-files-settings", label: "Open Settings")
                }
            }
            if !loaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if files.isEmpty && !offline {
                empty
            } else if !files.isEmpty {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: HomeMetric.cardMin, maximum: HomeMetric.cardMax), spacing: HomeMetric.gap, alignment: .top)], alignment: .leading, spacing: 24) {
                        ForEach(visible) { item in
                            CloudFileCard(name: item.name, subtitle: CloudFilesText.edited(item.updated)) { open(item) }
                                .disabled(busy).qaID("cloud-file", label: item.name)
                                .contextMenu { Button("Open") { open(item) }.disabled(busy || offline) }
                        }
                    }.padding(.bottom, HomeMetric.gutter)
                    if visible.isEmpty { Text("No files match your search").font(Typography.body).foregroundStyle(Palette.mutedFg).qaText("No files match your search") }
                }.scrollIndicators(.never)
            }
            if offline { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(targeted && canEdit ? Palette.hover : Color.clear)
        .contentShape(Rectangle())
        .onDrop(of: [UTType.fileURL.identifier], isTargeted: $targeted, perform: drop)
        .task(id: entry.url) {
            loaded = false; files = []; role = "viewer"; warning = nil; query = ""
            guard await account.waitListed(model, entry.url) else { loaded = true; offline = true; warning = "This Cloud is offline."; return }
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }
}

private struct CloudFileCard: View {
    let name: String
    let subtitle: String
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: open) {
                HomeFilePlaceholder(name: name)
                    .aspectRatio(HomeMetric.thumbRatio, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: HomeMetric.radiusCard, style: .continuous))
                    .cardShadow(hovering)
                    .contentShape(RoundedRectangle(cornerRadius: HomeMetric.radiusCard, style: .continuous))
            }.buttonStyle(.plain).accessibilityLabel(name).help("Open \(name)")
            VStack(alignment: .leading, spacing: 7) {
                Text(name).font(Typography.body).fontWeight(.semibold).foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.middle).frame(height: 13).qaText(name)
                Text(subtitle).font(Typography.label).fontWeight(.regular).foregroundStyle(Palette.mutedFg).lineLimit(1).frame(height: 12).qaText(subtitle)
            }
        }.onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}
