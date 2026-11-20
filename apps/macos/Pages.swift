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
}

/// The Pages list: the shown page is filled; double-click or "Rename" edits the name in place.
struct PagesSection: View {
    @ObservedObject var model: CanvasModel
    @State private var editing: String?
    /// The document the rename started in.
    @State private var editingFile: String?
    @State private var draft = ""
    @State private var confirmDelete: PageInfo?
    /// Where a drag over the list would land.
    @State private var dropTarget: PageDropTarget?
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 0) {
            SectionHeader(title: "Pages")
            IconButton(symbol: "plus", help: "Add page", bounce: model.pages.count) {
                model.addPage { id, name in startRename(PageInfo(id: id, name: name, count: 0)) }
            }.qaID("page-add",label:"Add page").disabled(model.cloudReadOnly)
        }
        ForEach(model.pages) { p in
            Group {
                if editing == p.id {
                    // The page icon stays while the name is edited, so the name does not jump left.
                    HStack(spacing: 8) {
                        Image(systemName: "rectangle.portrait").symbolRenderingMode(.hierarchical)
                            .font(.system(size: GlyphSize.row, weight: .medium)).foregroundStyle(Palette.mutedFg).frame(width: 16)
                        TextField("Page name", text: $draft)
                            .textFieldStyle(.plain).font(Typography.body).foregroundStyle(Palette.fg)
                            .focused($focused)
                    }
                        .padding(.horizontal, 12).frame(height: Metric.row)
                        .background(RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).fill(Palette.active))
                        .onSubmit { commit(p.id) }
                        .onExitCommand { editing = nil }
                        .onChange(of: focused) { _, f in if !f { commit(p.id) } }
                } else {
                    ListRow(title: p.name, symbol: "rectangle.portrait",
                            active: p.id == model.activePage) { model.showPage(p.id) }
                        .simultaneousGesture(TapGesture(count: 2).onEnded { startRename(p) })
                }
            }
            // Drag a page onto another to reorder; drop boards dragged from the Layers panel to move them here.
            .onDrag {
                guard !model.cloudReadOnly else { return NSItemProvider() }
                LayersStore.of(model).dragging = [] // a layer drag that ended elsewhere must not pass for this one
                return NSItemProvider(object: PageDrag.payload(page: p.id) as NSString)
            }
            .onDrop(of: [.text], delegate: PageDrop(model: model, page: p, target: $dropTarget))
            // A reorder that landed: no line may stay behind (SwiftUI can update the target once more after the drop).
            .onChange(of: model.pages.map(\.id)) { _, _ in dropTarget = nil }
            .overlay(alignment: .top) { if dropTarget == PageDropTarget(page: p.id, zone: .above) { Rectangle().fill(Palette.sel).frame(height: 2) } }
            .overlay(alignment: .bottom) { if dropTarget == PageDropTarget(page: p.id, zone: .below) { Rectangle().fill(Palette.sel).frame(height: 2) } }
            .overlay { if dropTarget == PageDropTarget(page: p.id, zone: .onto) {
                RoundedRectangle(cornerRadius: Metric.radiusRow, style: .continuous).stroke(Palette.sel, lineWidth: 1.5)
            } }
            .contextMenu {
                Button("Rename") { startRename(p) }.disabled(model.cloudReadOnly)
                // Deleting a page deletes its boards; an empty page goes without asking. One undo brings it all back.
                Button(p.count > 0 ? "Delete…" : "Delete", role: .destructive) {
                    if p.count > 0 { confirmDelete = p } else { model.deletePage(p.id) }
                }.disabled(model.cloudReadOnly || model.pages.count < 2)
            }
        }
        // Another document shown: a rename in progress belonged to the old one and is dropped.
        .onChange(of: model.currentFile) { _, _ in editing = nil; editingFile = nil; confirmDelete = nil }
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

    private func startRename(_ p: PageInfo) { guard !model.cloudReadOnly else { return }; draft = p.name; editing = p.id; editingFile = model.currentFile; DispatchQueue.main.async { focused = true } }
    private func commit(_ id: String) {
        guard editing == id else { return }
        editing = nil
        model.renamePage(id, to: draft, in: editingFile)
    }
}

struct PageDropTarget: Equatable {
    enum Zone { case above, below, onto }
    let page: String
    let zone: Zone
}

/// A drop on a page row: another page reorders (line above or below), boards from the Layers panel move onto it.
struct PageDrop: DropDelegate {
    let model: CanvasModel
    let page: PageInfo
    @Binding var target: PageDropTarget?

    private var draggedBoards: [String] {
        PageDrag.boards(dragged: LayersStore.of(model).dragging, text: nil, boards: model.boards.map(\.id))
    }

    func validateDrop(info: DropInfo) -> Bool { !model.cloudReadOnly && info.hasItemsConforming(to: [.text]) }

    /// Bumped by every update: a line whose drag has ended (no update for a moment and no button held) goes away,
    /// whatever order SwiftUI sent the drop, exit and update in. Without it a line could stay after the drop.
    private static var updates = 0
    private func clearWhenIdle() {
        Self.updates += 1
        let mine = Self.updates, clear = $target
        func check() {
            guard Self.updates == mine else { return }
            if NSEvent.pressedMouseButtons & 1 == 0 { clear.wrappedValue = nil }
            else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { check() } }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { check() }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        clearWhenIdle()
        // Boards (the Layers panel's drag) land on the page; anything else is a page being reordered.
        let boards = draggedBoards
        if !boards.isEmpty {
            guard page.id != model.activePage else { target = nil; return DropProposal(operation: .forbidden) }
            target = PageDropTarget(page: page.id, zone: .onto)
            return DropProposal(operation: .move)
        }
        target = PageDropTarget(page: page.id, zone: info.location.y > Metric.row / 2 ? .below : .above)
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) { if target?.page == page.id { target = nil } }

    func performDrop(info: DropInfo) -> Bool {
        guard !model.cloudReadOnly else { return false }
        let zone = target?.zone
        target = nil
        let boards = draggedBoards
        if !boards.isEmpty {
            guard page.id != model.activePage else { return false }
            LayersStore.of(model).dragging = []
            model.moveBoards(boards, toPage: page.id)
            return true
        }
        guard let item = info.itemProviders(for: [.text]).first else { return false }
        let pages = model.pages
        _ = item.loadObject(ofClass: NSString.self) { obj, _ in
            guard let s = obj as? String else { return }
            DispatchQueue.main.async {
                if let id = PageDrag.page(s) {
                    guard let from = pages.firstIndex(where: { $0.id == id }), let onto = pages.firstIndex(where: { $0.id == page.id }),
                          let to = PageDrag.index(from: from, onto: onto, below: zone == .below, count: pages.count) else { return }
                    model.reorderPage(id, to: to)
                } else {
                    // A board id dragged as text (another source than the Layers panel's own drag).
                    let ids = PageDrag.boards(dragged: [], text: s, boards: model.boards.map(\.id))
                    if !ids.isEmpty, page.id != model.activePage { model.moveBoards(ids, toPage: page.id) }
                }
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
