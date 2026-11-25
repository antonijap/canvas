// Pages in the shell: the list at the top of the Boards panel (show, add and name at once, rename inline, delete
// with its boards, confirmed when it has any, drag to reorder, drop boards from the Layers panel onto a page) and "Move to page" on board rows. The server owns the pages (/api/pages); the page reports the
// list and which one it shows, and switches when asked.

import SwiftUI

extension CanvasModel {
    /// One /api/pages request with the CSRF header; failures become a toast. The page hears the change over SSE.
    private func pagesCall(_ method: String, _ path: String, _ body: [String: Any]? = nil, file: String? = nil, done: (([String: Any]) -> Void)? = nil) {
        guard let file = file ?? currentFile else { return }
        var c = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        c?.setQuery([URLQueryItem(name: "file", value: file)])
        guard let url = c?.url else { return }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("1", forHTTPHeaderField: "X-Canvas")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            DispatchQueue.main.async {
                if (200..<300).contains(status) { done?(json) } else { self.flash(json["error"] as? String ?? "Could not change the pages") }
            }
        }.resume()
    }

    /// A new page after the others; the canvas shows it right away. `created` gets its id and name (the list
    /// opens it for renaming).
    func addPage(created: ((String, String) -> Void)? = nil) {
        pagesCall("POST", "api/pages", [:]) { j in
            if let list = j["pages"] as? [[String: Any]], let id = list.last?["id"] as? String {
                self.showPage(id)
                created?(id, list.last?["name"] as? String ?? "")
            }
        }
    }
    /// `file` is the document the rename was typed in: after a tab switch it is not the one shown, and the name
    /// must not land on a page of the same id there.
    func renamePage(_ id: String, to name: String, in file: String?) {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let file, file == currentFile, !n.isEmpty, pages.first(where: { $0.id == id })?.name != n else { return }
        pagesCall("PATCH", "api/pages/\(id)", ["name": n], file: file)
    }
    /// Deleted, then a toast with Undo (while "Delete Page" is still the step Undo would take: the page checks).
    func deletePage(_ id: String) {
        let name = pages.first { $0.id == id }?.name ?? "page"
        pagesCall("DELETE", "api/pages/\(id)") { [weak self] _ in
            self?.flash("Deleted page \(name)", actions: [ToastAction(id: "undo", label: "Undo", symbol: nil) { [weak self] in
                self?.clearToast()
                self?.run("{cmd:'undoIf',label:'Delete Page'}")
            }])
        }
    }
    func moveBoard(_ board: String, toPage page: String) { moveBoards([board], toPage: page) }
    func moveBoards(_ boards: [String], toPage page: String) { pagesCall("POST", "api/pages/move", ["boards": boards, "to": page]) }
    /// Puts a page at `index` in the list (one undo step on the server).
    func reorderPage(_ id: String, to index: Int) { pagesCall("PATCH", "api/pages/\(id)", ["index": index]) }
    func pageMoveIndex(_ id: String, by step: Int) -> Int? {
        guard !cloudReadOnly, let from = pages.firstIndex(where: { $0.id == id }) else { return nil }
        return PageDrag.step(from: from, by: step, count: pages.count)
    }
    func movePage(_ id: String, by step: Int) {
        if let to = pageMoveIndex(id, by: step) { reorderPage(id, to: to) }
    }
    func duplicatePage(_ id: String) {
        pagesCall("POST", "api/pages/\(id)/duplicate")
    }
    func selectPageRow(_ id: String) {
        pageShortcutTarget = currentFile.map { ($0, id) }
        showPage(id)
    }
}

/// The Pages list: the shown page is filled; double-click or "Rename" edits the name in place.
struct PagesSection: View {
    @ObservedObject var model: CanvasModel
    @State private var editing: String?
    /// The document the rename started in.
    @State private var editingFile: String?
    @State private var draft = ""
    @State private var confirmDelete: PageInfo?
    @State private var dragging: String?
    @State private var dropTarget: PageDropTarget?
    @State private var dropWatch: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                SidebarGroupLabel(title: "Pages")
                Button {
                    model.addPage { id, name in startRename(PageInfo(id: id, name: name, count: 0)) }
                } label: {
                    Image(systemName: "plus").font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Palette.mutedFg).frame(width: 24, height: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain).chromeHelp("Add page").accessibilityLabel("Add page")
                .qaID("page-add", label: "Add page").disabled(model.cloudReadOnly || model.revision.isEmpty)
            }
            if model.revision.isEmpty {
                if let sidebar = model.openingSidebar {
                    VStack(spacing: PageDrag.spacing) {
                        ForEach(sidebar.pages) { page in
                            ListRow(title: page.name, symbol: "rectangle.portrait", sidebar: true, active: page.id == sidebar.activePage)
                                .disabled(true)
                                .qaID("page-row", label: page.id)
                        }
                    }
                    .padding(.vertical, PageDrag.spacing)
                    .allowsHitTesting(false)
                }
            } else {
                VStack(spacing: PageDrag.spacing) {
                    ForEach(Array(model.pages.enumerated()), id: \.element.id) { i, page in
                        pageRow(page, at: i)
                    }
                }
                // The list owns the hit area, including the gaps and the insertion boundary above the first row.
                .padding(.vertical, PageDrag.spacing)
                .contentShape(Rectangle())
                .onDrop(of: [.text], delegate: PageDrop(model: model, dragging: $dragging, target: $dropTarget, watch: watchDrop))
            }
        }
        .onChange(of: model.currentFile) { _, _ in
            editing = nil
            editingFile = nil
            confirmDelete = nil
            clearDrop()
        }
        .onChange(of: model.pages.map(\.id)) { _, _ in clearDrop() }
        .onDisappear { clearDrop() }
        .confirmationDialog(confirmDelete.map { "Delete page and its \($0.count) board\($0.count == 1 ? "" : "s")?" } ?? "", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            if let p = confirmDelete {
                Button("Delete", role: .destructive) { model.deletePage(p.id); confirmDelete = nil }
            }
        } message: {
            if let p = confirmDelete {
                Text("\"\(p.name)\" and everything on it will be deleted. Undo brings it back.")
            }
        }
    }

    @ViewBuilder private func pageRow(_ p: PageInfo, at i: Int) -> some View {
        Group {
            if editing == p.id {
                HStack(spacing: 8) {
                    Image(systemName: "doc").symbolRenderingMode(.hierarchical)
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.mutedFg).frame(width: 16)
                    TextField("Page name", text: $draft)
                        .textFieldStyle(.plain).font(SidebarStyle.text).foregroundStyle(Palette.fg)
                        .focused($focused)
                }
                .padding(.horizontal, 6).frame(height: SidebarStyle.row)
                .background(RoundedRectangle(cornerRadius: SidebarStyle.radius).fill(SidebarStyle.selection))
                .onSubmit { commit(p.id) }
                .onExitCommand { editing = nil }
                .onChange(of: focused) { _, f in if !f { commit(p.id) } }
            } else {
                let row = ListRow(title: p.name, symbol: "doc", sidebar: true, active: p.id == model.activePage) { model.selectPageRow(p.id) }
                    .simultaneousGesture(TapGesture(count: 2).onEnded { startRename(p) })
                if model.cloudReadOnly {
                    row
                } else {
                    row.onDrag {
                        LayersStore.of(model).dragging = []
                        dragging = p.id
                        watchDrop()
                        return NSItemProvider(object: PageDrag.payload(page: p.id) as NSString)
                    } preview: {
                        ListRow(title: p.name, symbol: "rectangle.portrait", sidebar: true, active: p.id == model.activePage)
                            .fixedSize(horizontal: true, vertical: false)
                            .background(Palette.popover, in: RoundedRectangle(cornerRadius: Metric.radiusRow))
                            .shadow(color: .black.opacity(0.25), radius: 5, y: 3)
                            .padding(8)
                    }
                }
            }
        }
        .overlay {
            if dropTarget == .boards(p.id) {
                RoundedRectangle(cornerRadius: Metric.radiusRow).stroke(Palette.sel, lineWidth: 1.5).allowsHitTesting(false)
            }
        }
        .opacity(dragging == p.id ? 0 : 1)
        .offset(y: rowOffset(i))
        .animation(reduceMotion ? nil : Motion.fast, value: dropTarget)
        .overlay(alignment: .top) {
            if dropTarget == .reorder(i) {
                Rectangle().fill(Palette.sel).frame(height: 2).padding(.horizontal, 4).offset(y: -1)
                    .allowsHitTesting(false)
                    .qaID("page-insertion")
            }
        }
        .qaID("page-row", label: p.id)
        .contextMenu {
            Button("Rename") { startRename(p) }.disabled(model.cloudReadOnly)
            Button("Duplicate Page") { model.duplicatePage(p.id) }.disabled(model.cloudReadOnly)
            Divider()
            Button("Move Up") { model.movePage(p.id, by: -1) }
                .keyboardShortcut(.upArrow, modifiers: [.option, .command])
                .disabled(model.pageMoveIndex(p.id, by: -1) == nil)
            Button("Move Down") { model.movePage(p.id, by: 1) }
                .keyboardShortcut(.downArrow, modifiers: [.option, .command])
                .disabled(model.pageMoveIndex(p.id, by: 1) == nil)
            Divider()
            Button("Delete", role: .destructive) {
                if p.count > 0 { confirmDelete = p } else { model.deletePage(p.id) }
            }.disabled(model.cloudReadOnly || model.pages.count < 2)
        }
    }

    private func rowOffset(_ i: Int) -> CGFloat {
        guard let dragging, let from = model.pages.firstIndex(where: { $0.id == dragging }), case let .reorder(to) = dropTarget else { return 0 }
        let stride = SidebarStyle.row + PageDrag.spacing
        return CGFloat(PageDrag.shift(row: i, from: from, to: to)) * stride
    }

    private func watchDrop() {
        guard dropWatch == nil else { return }
        dropWatch = Task { @MainActor in
            repeat {
                try? await Task.sleep(for: .milliseconds(200))
                if Task.isCancelled { return }
            } while NSEvent.pressedMouseButtons & 1 != 0
            clearDrop()
        }
    }

    private func clearDrop() {
        dragging = nil
        dropTarget = nil
        dropWatch?.cancel()
        dropWatch = nil
    }

    private func startRename(_ p: PageInfo) { guard !model.cloudReadOnly else { return }; draft = p.name; editing = p.id; editingFile = model.currentFile; DispatchQueue.main.async { focused = true } }
    private func commit(_ id: String) {
        guard editing == id else { return }
        editing = nil
        model.renamePage(id, to: draft, in: editingFile)
    }
}

private enum PageDropTarget: Equatable {
    case reorder(Int)
    case boards(String)
}

/// Page drags cross the whole list. Board drags still land on a specific row.
private struct PageDrop: DropDelegate {
    let model: CanvasModel
    @Binding var dragging: String?
    @Binding var target: PageDropTarget?
    let watch: () -> Void

    private var draggedBoards: [String] {
        PageDrag.boards(dragged: LayersStore.of(model).dragging, text: nil, boards: model.boards.map(\.id))
    }

    func validateDrop(info: DropInfo) -> Bool { !model.cloudReadOnly && info.hasItemsConforming(to: [.text]) }

    private func boardPage(at y: CGFloat) -> String? {
        guard let index = PageDrag.row(at: y, height: SidebarStyle.row, count: model.pages.count) else { return nil }
        let id = model.pages[index].id
        return id == model.activePage ? nil : id
    }

    private func destination(_ id: String, at y: CGFloat) -> Int? {
        guard let from = model.pages.firstIndex(where: { $0.id == id }) else { return nil }
        return PageDrag.index(from: from, y: y, height: SidebarStyle.row, count: model.pages.count)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        watch()
        if let dragging {
            target = destination(dragging, at: info.location.y).map(PageDropTarget.reorder)
        } else {
            target = boardPage(at: info.location.y).map(PageDropTarget.boards)
        }
        return DropProposal(operation: target == nil ? .forbidden : .move)
    }

    func dropExited(info: DropInfo) { target = nil }

    func performDrop(info: DropInfo) -> Bool {
        defer { dragging = nil; target = nil }
        guard !model.cloudReadOnly else { return false }
        if let dragging {
            guard let index = destination(dragging, at: info.location.y) else { return false }
            model.reorderPage(dragging, to: index)
            return true
        }
        guard let page = boardPage(at: info.location.y) else { return false }
        let boards = draggedBoards
        if !boards.isEmpty {
            LayersStore.of(model).dragging = []
            model.moveBoards(boards, toPage: page)
            return true
        }
        guard let item = info.itemProviders(for: [.text]).first else { return false }
        let file = model.currentFile
        _ = item.loadObject(ofClass: NSString.self) { obj, _ in
            guard let text = obj as? String else { return }
            DispatchQueue.main.async {
                guard file == model.currentFile else { return }
                let ids = PageDrag.boards(dragged: [], text: text, boards: model.boards.map(\.id))
                if !ids.isEmpty { model.moveBoards(ids, toPage: page) }
            }
        }
        return true
    }
}

/// "Move to page" for a board row: every page but the one it is on.
struct MoveToPageMenu: View {
    @ObservedObject var model: CanvasModel
    let board: String
    var body: some View {
        Menu("Move to page") {
            ForEach(model.pages.filter { $0.id != model.activePage }) { p in
                Button(p.name) { model.moveBoard(board, toPage: p.id) }
            }
        }
        .disabled(model.pages.count < 2)
    }
}
