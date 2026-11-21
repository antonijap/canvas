// The host lists every live file, including files this Mac has never opened.
import AppKit
import SwiftUI
import UniformTypeIdentifiers

private struct CloudFileItem: Identifiable {
    let id: String
    let name: String
    let updated: String?
    let canDelete: Bool?
}

struct CloudFilesView: View {
    @ObservedObject var model: CanvasModel
    let entry: CloudEntry
    @ObservedObject private var account = CloudAccount.shared
    @State private var files: [CloudFileItem] = []
    @ObservedObject private var home = HomeStore.shared
    @State private var key = ""
    @State private var deleteItem: CloudFileItem?
    @State private var refreshVersion = 0
    @State private var role = "viewer"
    @State private var warning: String?
    @State private var loaded = false
    @State private var offline = false
    @State private var query = ""
    @State private var opening = false
    @State private var targeted = false

    private var canEdit: Bool { loaded && !offline && CloudFilesText.canEdit(role) }
    private func canDelete(_ item: CloudFileItem) -> Bool {
        canEdit && (item.canDelete ?? (role == "owner"))
    }
    private var busy: Bool { opening || account.busy.contains(entry.url) }
    private var visible: [CloudFileItem] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        return files.filter { item in words.allSatisfy { item.name.localizedCaseInsensitiveContains($0) } }
    }

    static func read(_ model: CanvasModel, entry: CloudEntry, path: String) async -> [String: Any] {
        #if CANVAS_QA
        if path == "api/cloud/usage", let meter = QA.cloudUsage { return meter }
        #endif
        return await CloudAccount.get(model, path, query: [URLQueryItem(name: "cloud", value: entry.url)])
    }

    private func refresh() async {
        refreshVersion += 1
        let version = refreshVersion
        let j = await Self.read(model, entry: entry, path: "api/cloud/files")
        guard !Task.isCancelled, version == refreshVersion else { return }
        offline = j["files"] == nil
        if let rows = j["files"] as? [[String: Any]] {
            files = rows.compactMap { r in
                guard let id = r["id"] as? String, let name = r["name"] as? String else { return nil }
                return CloudFileItem(id: id, name: name, updated: r["updated_at"] as? String, canDelete: r["can_delete"] as? Bool)
            }
            role = j["role"] as? String ?? "viewer"
            key = j["key"] as? String ?? ""
        }
        loaded = true
        let usage = role == "owner" && !offline ? await Self.read(model, entry: entry, path: "api/cloud/usage") : [:]
        guard !Task.isCancelled, version == refreshVersion else { return }
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
                model.setCloudFileName(j["name"] as? String, for: file)
                model.open(file)
            } else { model.flash(CloudFilesText.problem(code: j["code"] as? String, fallback: "Could not open the Cloud file. Try again.")) }
        }
    }

    private func rename(_ item: CloudFileItem) {
        let alert = NSAlert()
        alert.messageText = "Rename file"
        let field = NSTextField(string: item.name)
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        field.setAccessibilityLabel("File name")
        alert.accessoryView = field
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        perform("rename", item: item, with: ["name": name])
    }

    private func perform(_ action: String, item: CloudFileItem, with values: [String: Any] = [:]) {
        guard !busy, !offline, action == "download" || canEdit else { return }
        if action == "delete" {
            guard let current = files.first(where: { $0.id == item.id }), canDelete(current) else { return }
        }
        opening = true
        Task {
            defer { opening = false }
            var body = values
            body["cloud"] = entry.url
            body["id"] = item.id
            let (status, j) = await CloudAccount.post(model, "api/cloud/files/" + action, body)
            guard (200..<300).contains(status) else {
                model.flash(CloudFilesText.problem(code: j["code"] as? String, fallback: "Could not complete the Cloud file action. Try again."))
                return
            }
            if action == "download" {
                model.flash("Local copy saved", level: "success")
                return
            }
            let cached = (model.openFiles + home.recents.map(\.path)).filter {
                guard let location = CloudFilePath($0) else { return false }
                return location.key == key && location.id == item.id
            }
            if action == "delete" {
                for file in Set(cached) { model.close(file); home.remove(file) }
            } else if action == "rename", let name = j["name"] as? String {
                for file in Set(cached) { model.setCloudFileName(name, for: file) }
            }
            await refresh()
        }
    }

    @ViewBuilder private func fileMenu(_ item: CloudFileItem) -> some View {
        Button("Open") { open(item) }.disabled(busy || offline)
        Button("Duplicate") { perform("duplicate", item: item) }.disabled(busy || !canEdit)
        Button("Rename") {
            RunLoop.main.perform { MainActor.assumeIsolated { rename(item) } }
        }.disabled(busy || !canEdit)
        Button("Copy Link") { model.copyDocumentLink(CanvasLink.cloudURL(key: key, id: item.id)) }.disabled(key.isEmpty)
        Button("Download a Local Copy") {
            let name = TabRename.name(item.name) ?? "Download.canvas"
            if let url = model.savePanel(title: "Download a Local Copy", name: name) {
                perform("download", item: item, with: ["target": url.path])
            }
        }.disabled(busy || offline)
        Divider()
        Button("Delete", role: .destructive) { deleteItem = item }.disabled(busy || !canDelete(item))
    }

    private var revealedID: String? {
        guard let path = home.revealPath, let location = CloudFilePath(path),
              location.key == key, visible.contains(where: { $0.id == location.id }) else { return nil }
        return location.id
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
                ScrollViewReader { scroll in
                    ScrollView {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: HomeMetric.cardMin, maximum: HomeMetric.cardMax), spacing: HomeMetric.gap, alignment: .top)], alignment: .leading, spacing: 24) {
                            ForEach(visible) { item in
                                CloudFileCard(name: item.name, subtitle: CloudFilesText.edited(item.updated)) { open(item) }
                                    .disabled(busy).qaID("cloud-file", label: item.name)
                                    .contextMenu { fileMenu(item) }
                                    .id(item.id)
                            }
                        }.padding(.bottom, HomeMetric.gutter)
                        if visible.isEmpty { Text("No files match your search").font(Typography.body).foregroundStyle(Palette.mutedFg).qaText("No files match your search") }
                    }.scrollIndicators(.never)
                    .task(id: revealedID) {
                        guard let id = revealedID else { return }
                        scroll.scrollTo(id, anchor: .center)
                        home.revealPath = nil
                    }
                }
            }
            if offline { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(targeted && canEdit ? Palette.hover : Color.clear)
        .contentShape(Rectangle())
        .onDrop(of: [UTType.fileURL.identifier], isTargeted: $targeted, perform: drop)
        .alert("Delete Cloud File", isPresented: Binding(get: { deleteItem != nil }, set: { if !$0 { deleteItem = nil } }), presenting: deleteItem) { item in
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { perform("delete", item: item) }
        } message: { item in
            Text("Delete \(item.name) from this Cloud for everyone?")
        }
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
            Button {
                guard NSApp.currentEvent?.type != .rightMouseDown, NSApp.currentEvent?.type != .rightMouseUp else { return }
                open()
            } label: {
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
