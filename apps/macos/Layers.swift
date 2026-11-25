// The layers panel: under Pages in the left panel, the boards of the page shown, each with its layers
// nested (front-most first), type icons, disclosure triangles (Option-click opens every layer inside), selection
// both ways (Shift-click a range, Cmd-click toggles), a hover outline on the canvas, double-click to rename, the eye
// to hide or show, and drag to reorder or move into another frame. The outline comes from GET /api/layers
// (src/layers.ts), only for boards that are open, and only again when a board's change key moves. Renames and the
// eye go through /api/update like the inspector (one undo step); drops go through the page's auto layout place op
// (/api/layout `before`, src/page/autolayout.js), which adds the layers' rects. The pure half is LayersLogic.swift.
// Lock: a padlock beside the eye (shown on hover, kept while locked); a drag down the padlocks locks or
// unlocks every row it crosses in one undo step; a locked frame locks its rows (they cannot unlock on their own).
// Tab and Shift+Tab while renaming move to the next and previous name; Option+L (the page's key) closes every row.
// Cmd+R with several layers opens Rename Layers (BatchRenameLayer, a batch rename; logic in BatchRename).

import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct LayerDropMark: Equatable { let id: String; let zone: LayerDropZone; let depth: Int }

final class LayersStore: ObservableObject {
    private static var stores: [ObjectIdentifier: LayersStore] = [:]
    /// One store per window model: the open triangles survive switching the panel to another section.
    static func of(_ model: CanvasModel) -> LayersStore {
        if let s = stores[ObjectIdentifier(model)] { return s }
        let s = LayersStore(model)
        stores[ObjectIdentifier(model)] = s
        return s
    }

    private weak var model: CanvasModel?
    @Published private(set) var rows: [LayerRow] = []
    /// The row whose name is being edited.
    @Published var renaming: String?
    @Published var dropMark: LayerDropMark?
    /// A drag down the padlocks: from the row it started on to the row under the pointer, locking or unlocking.
    @Published private(set) var lockDrag: (from: String, to: String, lock: Bool)?
    /// The row to bring into view, with a counter so the same row can be asked for twice.
    @Published private(set) var scrollTarget: (id: String, n: Int)?
    private var scrollN = 0

    private var trees: [String: (key: String, node: LayerNode)] = [:]
    private var parentOf: [String: String] = [:]
    private var nodeOf: [String: LayerNode] = [:]
    private(set) var expanded: Set<String> = []
    private var file: String?
    private var anchorId: String?
    /// The ids being dragged from this panel.
    var dragging: [String] = []
    /// The selection this panel asked for last: when it comes back from the page, the list does not scroll.
    private var askedFor: [String]?
    private var pendingReveal: [String] = []
    private var inFlight = false
    private var again = false
    private var lastSelection: [String] = []

    private init(_ model: CanvasModel) { self.model = model }

    // MARK: document

    /// The document changed (or the panel appeared): forget another file's state, reload open boards that moved.
    func documentChanged() {
        guard let model else { return }
        if model.currentFile != file {
            file = model.currentFile
            trees = [:]; parentOf = [:]; nodeOf = [:]; expanded = []; anchorId = nil; askedFor = nil; pendingReveal = []; renaming = nil; dropMark = nil
            lastSelection = []
        }
        rebuild()
        fetch()
    }

    private func rebuild() {
        guard let model else { return }
        let boards = model.boards.map { LayerBoard(id: $0.id, name: $0.name, tree: trees[$0.id]?.node) }
        let next = LayersLogic.rows(boards, expanded: expanded)
        if next != rows { rows = next }
    }

    private func reindex() {
        parentOf = [:]; nodeOf = [:]
        func walk(_ n: LayerNode, parent: String?) {
            nodeOf[n.id] = n
            if let parent { parentOf[n.id] = parent }
            for c in n.children { walk(c, parent: n.id) }
        }
        for (_, t) in trees { walk(t.node, parent: nil) }
    }

    /// The chain above a layer, board first (empty for a board or an unknown layer).
    func ancestors(_ id: String) -> [String] {
        var out: [String] = []
        var cur = parentOf[id]
        while let p = cur { out.insert(p, at: 0); cur = parentOf[p] }
        return out
    }

    /// One /api/layers request for the open boards (and the boards of layers to reveal); one in flight at a time.
    private func fetch() {
        guard let model, let file = model.currentFile else { return }
        if inFlight { again = true; return }
        let shown = model.boards.map(\.id)
        let wanted = shown.filter { expanded.contains($0) }
        let reveal = pendingReveal
        guard !wanted.isEmpty || !reveal.isEmpty else { return }
        pendingReveal = []
        guard var c = URLComponents(url: model.base.appendingPathComponent("api/layers"), resolvingAgainstBaseURL: false) else { return }
        c.setQuery([URLQueryItem(name: "file", value: file),
                        URLQueryItem(name: "boards", value: wanted.joined(separator: ",")),
                        URLQueryItem(name: "keys", value: wanted.map { trees[$0]?.key ?? "" }.joined(separator: ",")),
                        URLQueryItem(name: "reveal", value: reveal.joined(separator: ","))])
        guard let url = c.url else { return }
        inFlight = true
        URLSession.shared.dataTask(with: url) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                self.inFlight = false
                guard self.file == file, let json else { if self.again { self.again = false; self.fetch() }; return }
                self.apply(json, revealed: reveal)
                if self.again { self.again = false; self.fetch() }
            }
        }.resume()
    }

    private func apply(_ json: [String: Any], revealed: [String]) {
        var changed = false
        for b in json["boards"] as? [[String: Any]] ?? [] {
            guard let id = b["id"] as? String else { continue }
            let key = b["key"] as? String ?? ""
            if let t = b["tree"] as? [String: Any], let node = LayerNode(json: t) { trees[id] = (key, node); changed = true }
        }
        if changed { reindex() }
        for id in openAllOnLoad { if let t = trees[id] { expanded.formUnion(LayersLogic.openable(t.node)); openAllOnLoad.remove(id) } }
        if let r = json["reveal"] as? [String: Any], !revealed.isEmpty {
            for id in revealed { if let p = (r[id] as? [String: Any])?["path"] as? [String] { expanded.formUnion(p) } }
            rebuild()
            if let last = revealed.last { scroll(to: last) }
            fetchIfNeeded()
        } else {
            rebuild()
        }
    }

    /// Boards opened by a reveal whose tree is not here yet.
    private func fetchIfNeeded() {
        guard let model else { return }
        if model.boards.contains(where: { expanded.contains($0.id) && trees[$0.id] == nil }) { fetch() }
    }

    private func scroll(to id: String) { scrollN += 1; scrollTarget = (id, scrollN) }

    // MARK: selection

    /// The layers selected on the canvas, as row ids. A layer inside an instance has its own row under the
    /// instance (path id "instance/child", src/layers.ts).
    var selectedIds: [String] {
        guard let s = model?.selection else { return [] }
        let ids = s.ids.isEmpty ? [s.id] : s.ids
        return ids.filter { !$0.hasPrefix("widget:") && !$0.isEmpty }
    }

    /// The canvas selection changed: open the parents of the selected layers and bring the last one into view,
    /// unless the panel itself asked for this selection.
    func selectionChanged() {
        let ids = selectedIds
        guard ids != lastSelection else { return }
        lastSelection = ids
        if let a = askedFor, a == ids { askedFor = nil; return }
        askedFor = nil
        guard !ids.isEmpty else { return }
        reveal(ids)
    }

    private func reveal(_ ids: [String]) {
        var missing: [String] = []
        for id in ids {
            if model?.boards.contains(where: { $0.id == id }) == true { continue }
            if nodeOf[id] != nil { expanded.formUnion(ancestors(id)) } else { missing.append(id) }
        }
        rebuild()
        if missing.isEmpty { if let last = ids.last { scroll(to: last) } }
        else { pendingReveal = missing; fetch() }
    }

    /// A row click: select it (Shift: the range from the last clicked row, Cmd: toggle it). A board alone also
    /// flies the camera to it, as the boards list did.
    func click(_ row: LayerRow) {
        guard let model else { return }
        let flags = NSEvent.modifierFlags
        var ids: [String]
        if flags.contains(.shift), let a = anchorId, rows.contains(where: { $0.id == a }) {
            ids = LayersLogic.range(rows, from: a, to: row.id)
        } else if flags.contains(.command) {
            ids = LayersLogic.toggled(selectedIds, row.id)
            anchorId = row.id
        } else {
            ids = [row.id]
            anchorId = row.id
        }
        askedFor = ids
        if ids == [row.id], row.isBoard, !flags.contains(.command) { model.fly(row.id); return }
        select(ids)
    }

    func select(_ ids: [String]) {
        guard let model, let data = try? JSONSerialization.data(withJSONObject: ids), let list = String(data: data, encoding: .utf8) else { return }
        model.run("{cmd:'layers',op:'select',ids:\(list)}")
        model.focusCanvas()
    }

    func hover(_ id: String?) {
        model?.run("{cmd:'layers',op:'hover',id:\(id.map(jsString) ?? "null")}")
    }

    // MARK: expand

    /// The triangle: open or close; with Option, every layer inside opens or closes with it.
    func toggle(_ row: LayerRow) {
        let all = NSEvent.modifierFlags.contains(.option)
        if row.expanded {
            if all, let n = nodeOf[row.id] { expanded.subtract(LayersLogic.openable(n)) } else { expanded.remove(row.id) }
        } else {
            expanded.insert(row.id)
            if all, let n = nodeOf[row.id] { expanded.formUnion(LayersLogic.openable(n)) }
            else if all, row.isBoard { openAllOnLoad.insert(row.id) }
        }
        rebuild()
        if row.isBoard && !row.expanded { fetch() }
    }
    /// Option-click on a board not loaded yet: open everything once its tree arrives.
    private var openAllOnLoad: Set<String> = []

    // MARK: edits

    /// Through the inspector's write queue (CanvasModel.writeNode): Undo and Quit wait for it. The model says why a
    /// write failed; `failed` puts the panel's copy back.
    private func post(_ id: String, props: [String: Any], remove: [String] = [], failed: @escaping () -> Void) {
        model?.writeNode(id, props: props, remove: remove, failed: failed)
    }

    /// Changes a layer in the local trees (the answer to the write brings the server's version).
    private func edit(_ id: String, _ f: (inout LayerNode) -> Void) {
        guard let board = (ancestors(id).first ?? (trees[id] != nil ? id : nil)), var t = trees[board] else { return }
        func go(_ n: inout LayerNode) -> Bool {
            if n.id == id { f(&n); return true }
            for i in n.children.indices where go(&n.children[i]) { return true }
            return false
        }
        guard go(&t.node) else { return }
        trees[board] = t
        if var n = nodeOf[id] { f(&n); nodeOf[id] = n }
        rebuild()
    }

    /// Cmd+R (Object > Rename): the layer's row opens for editing, its parents opened and the row scrolled to.
    func startRename(_ id: String) {
        guard model?.cloudReadOnly != true, !LayersLogic.insideInstance(id) else { return }
        reveal([id])
        renaming = id
    }

    func rename(_ row: LayerRow, to name: String) {
        let v = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let model, !v.isEmpty, v != row.name else { return }
        if row.isBoard { model.renameBoard(row.id, to: v); return }
        let was = row.name
        edit(row.id) { $0.name = v }
        post(row.id, props: ["name": v]) { self.edit(row.id) { $0.name = was } }
    }

    // MARK: lock

    /// The padlock a row shows while a lock drag is on its way (nil: the row's own state).
    func lockPreview(_ row: LayerRow) -> Bool? {
        guard let d = lockDrag, LayersLogic.lockSweep(rows, from: d.from, to: d.to).contains(row.id) else { return nil }
        return d.lock
    }

    /// The padlock pressed (`dy` 0) or dragged `dy` points down the column: the rows it crosses take the pressed row's new state.
    func lockDragged(_ row: LayerRow, dy: CGFloat) {
        guard !row.lockedAbove, !LayersLogic.insideInstance(row.id), let i = rows.firstIndex(where: { $0.id == row.id }) else { return }
        let j = max(0, min(rows.count - 1, i + Int((dy / (Metric.row + 2)).rounded())))
        let lock = lockDrag?.lock ?? !row.locked
        lockDrag = (row.id, rows[j].id, lock)
        hover(nil)
    }

    /// The press ends: one write locks (or unlocks) every row the drag crossed that is not that way already.
    func lockDragEnded() {
        guard let d = lockDrag else { return }
        lockDrag = nil
        let ids = LayersLogic.lockSweep(rows, from: d.from, to: d.to).filter { (nodeOf[$0]?.locked ?? false) != d.lock }
        setLocked(ids, d.lock)
    }

    /// Lock or unlock these layers: the panel shows it at once, the server takes it in one write and one undo step.
    func setLocked(_ ids: [String], _ lock: Bool) {
        guard let model, !model.cloudReadOnly, !ids.isEmpty else { return }
        for id in ids { edit(id) { $0.locked = lock } }
        let fail = { for id in ids { self.edit(id) { $0.locked = !lock } } }
        if lock { model.writeNodes(ids, props: ["locked": true], failed: fail) } else { model.writeNodes(ids, remove: ["locked"], failed: fail) }
    }

    // MARK: rows

    /// Option+L (Collapse layers): every open row closes.
    func collapseAll() {
        guard !expanded.isEmpty else { return }
        expanded = []
        rebuild()
    }

    /// Tab (Shift+Tab) while renaming: the next (previous) row's name opens for editing.
    func renameNext(from row: LayerRow, back: Bool) {
        guard let model, let id = LayersLogic.nextRename(rows, from: row.id, back: back) else { return }
        if rows.first(where: { $0.id == id })?.isBoard == true { renaming = nil; model.renamingBoard = id } else { renaming = id }
        scroll(to: id)
    }

    /// Ids in the order the panel lists them (top first), the ones it does not show after them in the order given.
    func panelOrder(_ ids: [String]) -> [String] {
        let at = Dictionary(rows.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ids.enumerated().sorted { (at[$0.element] ?? Int.max, $0.offset) < (at[$1.element] ?? Int.max, $1.offset) }.map(\.element)
    }

    /// A layer's name as the panel shows it (a board's from the boards list).
    func name(of id: String) -> String {
        if let b = model?.boards.first(where: { $0.id == id }) { return b.name }
        return nodeOf[id]?.name ?? id
    }

    /// Rename Layers: each layer takes its new name in one write and one undo step.
    func renameMany(_ ids: [String], to names: [String]) {
        guard let model, ids.count == names.count else { return }
        var each: [String: [String: Any]] = [:]
        var changed: [(String, String, String)] = []
        for (id, n) in zip(ids, names) {
            let was = name(of: id)
            guard n != was else { continue }
            each[id] = ["name": n]
            changed.append((id, was, n))
        }
        guard !changed.isEmpty else { return }
        for c in changed { edit(c.0) { $0.name = c.2 } }
        model.writeNodes(changed.map(\.0), each: each) { for c in changed { self.edit(c.0) { $0.name = c.1 } } }
    }

    func setHidden(_ row: LayerRow, _ hidden: Bool) {
        guard model != nil, model?.cloudReadOnly != true, !row.isBoard else { return }
        edit(row.id) { $0.hidden = hidden }
        let fail = { self.edit(row.id) { $0.hidden = !hidden } }
        if hidden { post(row.id, props: ["enabled": false], failed: fail) } else { post(row.id, props: [:], remove: ["enabled"], failed: fail) }
    }

    // MARK: drag and drop

    /// What a drag from this row carries: the whole selection when the row is in it.
    func beginDrag(_ row: LayerRow) {
        let sel = selectedIds
        dragging = sel.contains(row.id) ? sel : [row.id]
        // A layer inside an instance has its place from the component: it does not move.
        if dragging.contains(where: LayersLogic.insideInstance) { dragging = [] }
        hover(nil)
    }

    func place(on row: LayerRow, zone: LayerDropZone) -> LayerPlace? {
        guard let model, !LayersLogic.insideInstance(row.id) else { return nil }
        let boards = model.boards.map(\.id)
        return LayersLogic.place(on: row, zone: zone, moving: Set(dragging),
                                 firstOnTop: { self.nodeOf[$0]?.firstOnTop ?? false },
                                 siblings: { p in p.map { self.nodeOf[$0]?.children.map(\.id) ?? [] } ?? boards },
                                 ancestors: { self.ancestors($0) })
    }

    func drop(on row: LayerRow, zone: LayerDropZone) -> Bool {
        defer { dragging = []; dropMark = nil }
        guard let model, !model.cloudReadOnly, !dragging.isEmpty, let p = place(on: row, zone: zone) else { return false }
        // The layers land at the front of a frame they go into: it opens.
        if let parent = p.parent, zone == .inside { expanded.insert(parent); rebuild() }
        askedFor = nil
        model.runLayout(["op": "place", "ids": dragging, "parent": p.parent ?? NSNull(), "before": p.before ?? NSNull()])
        return true
    }
}

// MARK: views

/// The rows, for the panel's lazy stack (Shell.swift SidePanel).
struct LayersRows: View {
    @ObservedObject var model: CanvasModel
    @ObservedObject var store: LayersStore

    var body: some View {
        let selected = Set(store.selectedIds)
        if model.revision.isEmpty {
            ForEach(model.openingSidebar?.boards ?? []) { board in
                HStack(spacing: 6) {
                    Image(systemName: "number").symbolRenderingMode(.hierarchical)
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.mutedFg).frame(width: 16)
                    Text(board.name).font(SidebarStyle.text).foregroundStyle(Palette.fg).lineLimit(1)
                }
                .padding(.leading, 18).padding(.trailing, 6)
                .frame(maxWidth: .infinity, alignment: .leading).frame(height: SidebarStyle.row)
                .qaID("layer-row", label: board.id)
                .allowsHitTesting(false)
            }
        } else if model.boards.isEmpty {
            Text("No boards on this page").font(Typography.micro).foregroundStyle(Palette.mutedFg)
                .qaText("No boards on this page")
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).frame(height: SidebarStyle.row)
        } else {
            ForEach(store.rows) { row in
                LayerRowView(model: model, store: store, row: row, selected: selected.contains(row.id),
                             lockShown: store.lockPreview(row) ?? row.locked,
                             mark: store.dropMark?.id == row.id ? store.dropMark : nil,
                             editing: store.renaming == row.id || (row.isBoard && model.renamingBoard == row.id))
                    .equatable()
                    .id(row.id)
            }
        }
    }
}

/// Keeps the store in step with the document and the selection, and scrolls the panel to revealed rows.
struct LayersSync: ViewModifier {
    @ObservedObject var model: CanvasModel
    @ObservedObject var store: LayersStore
    let proxy: ScrollViewProxy
    let active: Bool
    let restoring: Bool

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard active else { return }
                store.documentChanged()
                store.selectionChanged()
                if let id = model.renamingBoard ?? store.renaming ?? (restoring ? nil : store.selectedIds.last) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { proxy.scrollTo(id) }
                }
            }
            .onChange(of: model.revision) { _, _ in if active { store.documentChanged() } }
            .onChange(of: model.currentFile) { _, _ in if active { store.documentChanged() } }
            .onChange(of: model.boards.map(\.id)) { _, _ in if active { store.documentChanged() } }
            .onChange(of: store.selectedIds) { _, _ in if active { store.selectionChanged() } }
            .onChange(of: store.scrollTarget?.n) { _, _ in
                guard active, let id = store.scrollTarget?.id else { return }
                withAnimation(Motion.fast) { proxy.scrollTo(id) }
            }
    }
}

extension View {
    func layersSync(model: CanvasModel, proxy: ScrollViewProxy, active: Bool, restoring: Bool) -> some View {
        modifier(LayersSync(model: model, store: LayersStore.of(model), proxy: proxy, active: active, restoring: restoring))
    }
}

enum LayerIcon {
    static func symbol(_ kind: String) -> String? {
        switch kind {
        case "frame": "number"
        case "frameH": "rectangle.split.3x1"
        case "frameV": "rectangle.split.1x2"
        case "group": "square.dashed"
        case "rect": "rectangle"
        case "ellipse": "circle"
        case "image": "photo"
        case "component": "diamond.fill"
        case "instance": "diamond"
        case "vector": "point.topleft.down.to.point.bottomright.curvepath"
        case "line": "line.diagonal"
        case "polygon": "triangle"
        case "icon": "star"
        case "note": "note.text"
        case "text": nil
        default: "square"
        }
    }
    static func purple(_ kind: String) -> Bool { kind == "component" || kind == "instance" }
}

struct LayerRowView: View, Equatable {
    let model: CanvasModel
    let store: LayersStore
    let row: LayerRow
    let selected: Bool
    /// The padlock shows closed: the row is locked, or a lock drag is about to lock it.
    let lockShown: Bool
    /// The drop indicator on this row, if any.
    let mark: LayerDropMark?
    /// The name is being edited in place.
    let editing: Bool
    @State private var hovering = false
    @State private var lockPressed = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    static func == (a: LayerRowView, b: LayerRowView) -> Bool {
        a.row == b.row && a.selected == b.selected && a.lockShown == b.lockShown && a.mark == b.mark && a.editing == b.editing
    }

    private static let indent: CGFloat = 12

    var body: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: CGFloat(row.depth) * Self.indent)
            disclosure
            icon.frame(width: 16).padding(.trailing, 6)
            if editing {
                TextField("Layer name", text: $draft)
                    .textFieldStyle(.plain).font(SidebarStyle.text).foregroundStyle(Palette.fg)
                    .focused($focused)
                    .onAppear { draft = row.name; DispatchQueue.main.async { focused = true } }
                    .onSubmit { finish(save: true) }
                    .onExitCommand { finish(save: false) }
                    // Tab / Shift+Tab: save this name and edit the next (previous) row's.
                    .onKeyPress(keys: [.tab]) { press in
                        finish(save: true, refocus: false)
                        store.renameNext(from: row, back: press.modifiers.contains(.shift))
                        return .handled
                    }
                    .onChange(of: focused) { _, f in if !f && editing { finish(save: true) } }
            } else {
                Text(row.name).font(SidebarStyle.text).foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 4)
            // The padlock's spot always takes a press (it shows on hover or while locked), so the press that locks
            // never lands on the row; the eye keeps its slot, so the padlock does not jump when the eye shows.
            if !editing && !LayersLogic.insideInstance(row.id) { lock.opacity(hovering || lockShown || lockPressed ? 1 : 0.001).allowsHitTesting(!model.cloudReadOnly) }
            if !row.isBoard && !editing { if hovering || row.hidden { eye.allowsHitTesting(!model.cloudReadOnly) } else { Color.clear.frame(width: 22) } }
        }
        .padding(.leading, 2).padding(.trailing, 6)
        .frame(height: SidebarStyle.row)
        .opacity(row.dimmed ? 0.45 : 1)
        .background(RoundedRectangle(cornerRadius: SidebarStyle.radius, style: .continuous).fill(fill))
        .overlay(alignment: .top) { mark(.above) }
        .overlay(alignment: .bottom) { mark(.below) }
        .overlay { if mark?.zone == .inside {
            RoundedRectangle(cornerRadius: SidebarStyle.radius, style: .continuous).stroke(Palette.sel, lineWidth: 1.5)
        } }
        .contentShape(Rectangle())
        .onTapGesture { if !editing { store.click(row) } }
        .simultaneousGesture(TapGesture(count: 2).onEnded { startRename() })
        .onHover { h in
            hovering = h
            store.hover(h ? row.id : nil)
        }
        .onDrag {
            guard !model.cloudReadOnly else { return NSItemProvider() }
            store.beginDrag(row)
            return NSItemProvider(object: row.id as NSString)
        }
        .onDrop(of: [.text], delegate: LayerDrop(store: store, row: row))
        .contextMenu {
            Button("Reveal on Canvas") { model.reveal(row.id, board: row.board) }
            Button("Select Children") {
                model.run("{cmd:'layers',op:'select',ids:[\(jsString(row.id))]}")
                model.run("{cmd:'structure',op:'children'}")
            }.keyboardShortcut(.return, modifiers: []).disabled(!row.hasChildren)
            if row.kind != "component" && row.kind != "instance" && !LayersLogic.insideInstance(row.id) {
                Button("Create Component") { rowCommand("{cmd:'shortcut',op:'component'}") }
                    .keyboardShortcut("k", modifiers: [.command, .option]).disabled(model.cloudReadOnly)
            }
            Button("Duplicate") { rowCommand("{cmd:'structure',op:'duplicate'}") }
                .keyboardShortcut("d", modifiers: .command).disabled(model.cloudReadOnly || LayersLogic.insideInstance(row.id))
            Button("Group") { rowCommand("{cmd:'structure',op:'group'}") }
                .keyboardShortcut("g", modifiers: .command).disabled(model.cloudReadOnly || LayersLogic.insideInstance(row.id))
            Button("Rename") { startRename() }.disabled(model.cloudReadOnly || LayersLogic.insideInstance(row.id))
            Button(row.locked ? "Unlock" : "Lock") { store.setLocked([row.id], !row.locked) }
                .keyboardShortcut("l", modifiers: [.command, .shift])
                .disabled(model.cloudReadOnly || row.lockedAbove || LayersLogic.insideInstance(row.id))
            if !row.isBoard {
                Button(row.hidden ? "Show" : "Hide") { store.setHidden(row, !row.hidden) }
                    .keyboardShortcut("h", modifiers: [.command, .shift]).disabled(model.cloudReadOnly)
            }
            Button("Copy Link to Layer") { model.copyLayerLink(row.id, page: model.activePage) }
                .keyboardShortcut("l", modifiers: .command)
            if row.isBoard { MoveToPageMenu(model: model, board: row.id).disabled(model.cloudReadOnly) }
            Divider()
            Button("Delete", role: .destructive) { rowCommand("{cmd:'structure',op:'delete'}") }
                .keyboardShortcut(.delete, modifiers: [])
                .disabled(model.cloudReadOnly || row.locked || row.lockedAbove || LayersLogic.insideInstance(row.id))
        }
        // VoiceOver: a row is a button that selects, with expand, rename and hide as its actions.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.name)
        .accessibilityValue(LayersLogic.accessibilityValue(row))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { store.click(row) }
        .accessibilityAction(named: row.expanded ? "Collapse" : "Expand") { if row.hasChildren { store.toggle(row) } }
        .accessibilityAction(named: "Rename") { startRename() }
        .accessibilityAction(named: row.hidden ? "Show" : "Hide") { if !row.isBoard { store.setHidden(row, !row.hidden) } }
        .accessibilityAction(named: row.locked ? "Unlock" : "Lock") { if !row.lockedAbove { store.setLocked([row.id], !row.locked) } }
    }

    private func rowCommand(_ command: String) {
        let ids = store.selectedIds.contains(row.id) ? store.selectedIds : [row.id]
        model.run("{cmd:'layers',op:'select',ids:[\(ids.map(jsString).joined(separator: ","))]}")
        model.run(command)
    }

    private var fill: Color {
        if selected { return SidebarStyle.selection }
        return hovering ? Palette.hover : .clear
    }

    @ViewBuilder private var disclosure: some View {
        if row.hasChildren {
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.mutedFg)
                .rotationEffect(.degrees(row.expanded ? 90 : 0))
                .frame(width: 16, height: SidebarStyle.row).contentShape(Rectangle())
                .highPriorityGesture(TapGesture().onEnded { store.toggle(row) })
                .chromeHelp(row.expanded ? "Collapse (Option: all inside)" : "Expand (Option: all inside)")
        } else {
            Color.clear.frame(width: 16)
        }
    }

    @ViewBuilder private var icon: some View {
        let tint = Palette.mutedFg
        if let s = LayerIcon.symbol(row.kind) {
            Image(systemName: s)
                .font(.system(size: 12, weight: .medium)).foregroundStyle(tint)
        } else {
            Text("T").font(.system(size: 12)).foregroundStyle(tint)
        }
    }

    private var eye: some View {
        Image(systemName: row.hidden ? "eye.slash" : "eye")
            .font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.mutedFg)
            .frame(width: 22, height: SidebarStyle.row).contentShape(Rectangle())
            .highPriorityGesture(TapGesture().onEnded { store.setHidden(row, !row.hidden) })
            .chromeHelp(row.hidden ? "Show" : "Hide")
            .accessibilityLabel(row.hidden ? "Show layer" : "Hide layer")
    }

    /// The padlock: open on hover, closed while locked. Press it to lock or unlock; drag down (or up) the column
    /// to do the same to every row the drag crosses. A row its parent locks shows a faint padlock and does nothing.
    private var lock: some View {
        Image(systemName: lockShown || row.lockedAbove ? "lock.fill" : "lock.open")
            .font(.system(size: GlyphSize.row - 1, weight: .medium)).foregroundStyle(Palette.mutedFg)
            .opacity(row.lockedAbove && !row.locked ? 0.45 : 1)
            .frame(width: 22, height: SidebarStyle.row).contentShape(Rectangle())
            .highPriorityGesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { v in lockPressed = true; store.lockDragged(row, dy: v.translation.height) }
                .onEnded { _ in lockPressed = false; store.lockDragEnded() })
            .chromeHelp(row.lockedAbove ? "Locked by its parent" : lockShown ? "Unlock" : "Lock")
            .accessibilityLabel(row.locked ? "Unlock layer" : "Lock layer")
    }

    @ViewBuilder private func mark(_ zone: LayerDropZone) -> some View {
        if let m = mark, m.zone == zone {
            Rectangle().fill(Palette.sel).frame(height: 2)
                .padding(.leading, CGFloat(m.depth) * Self.indent + 18)
                .offset(y: zone == .above ? -1 : 1)
        }
    }

    private func startRename() {
        guard !model.cloudReadOnly else { return }
        // Inside an instance the component names the layer.
        if LayersLogic.insideInstance(row.id) { return }
        if row.isBoard { model.renamingBoard = row.id } else { store.renaming = row.id }
    }

    private func finish(save: Bool, refocus: Bool = true) {
        guard editing else { return }
        store.renaming = nil
        if row.isBoard { model.renamingBoard = nil }
        if save { store.rename(row, to: draft) }
        if refocus { model.focusCanvas() }
    }
}

/// Where a dragged row would land on this one: an insertion line above or below, or a ring for inside.
struct LayerDrop: DropDelegate {
    let store: LayersStore
    let row: LayerRow

    private func zone(_ info: DropInfo) -> LayerDropZone {
        LayersLogic.zone(y: info.location.y, height: SidebarStyle.row, container: row.container)
    }

    func validateDrop(info: DropInfo) -> Bool { !store.dragging.isEmpty }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        let z = zone(info)
        guard store.place(on: row, zone: z) != nil else {
            if store.dropMark?.id == row.id { store.dropMark = nil }
            return DropProposal(operation: .forbidden)
        }
        // The line shows at the depth the layers land at.
        let inside = z == .inside || (z == .below && row.expanded && row.container)
        let mark = LayerDropMark(id: row.id, zone: inside && z == .below ? .below : z, depth: inside ? row.depth + 1 : row.depth)
        if store.dropMark != mark { store.dropMark = mark }
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) { if store.dropMark?.id == row.id { store.dropMark = nil } }

    func performDrop(info: DropInfo) -> Bool { store.drop(on: row, zone: zone(info)) }
}

// MARK: Rename Layers

/// Rename Layers (Cmd+R with several layers selected): above the canvas, the Rename to field beside Rename, buttons
/// that insert the current name and a number counting up or down, the number to start from (once a number is in the
/// name), Match (optional, a regular expression or plain text; shown on request) and a preview of the first names.
/// Return renames them all in one undo step, Esc closes.
struct BatchRenameLayer: View {
    @ObservedObject var model: CanvasModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .top) {
            if let ids = model.batchRename {
                Color.clear.contentShape(Rectangle()).onTapGesture { close() }
                BatchRenamePanel(model: model, ids: ids, names: ids.map { LayersStore.of(model).name(of: $0) })
                    .id(ids)
                    .padding(.top, Metric.inset + Metric.pill + Metric.islandGap * 4)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .allowsHitTesting(model.batchRename != nil)
        .animation(reduceMotion ? nil : Motion.fast, value: model.batchRename)
        .ignoresSafeArea()
    }

    private func close() { model.batchRename = nil; model.focusCanvas() }
}

private struct BatchRenamePanel: View {
    let model: CanvasModel
    let ids: [String]
    let names: [String]
    @State private var match = ""
    @State private var to = "$&"
    @State private var start = ""
    /// Match is out of the way until asked for; hiding it again clears it, so nothing unseen changes the result.
    @State private var showMatch = false
    @FocusState private var focus: Field?
    enum Field: Hashable { case match, to, start }

    private var startValue: Int? { Int(start.trimmingCharacters(in: .whitespaces)) }
    private var preview: [BatchRename.Change] { BatchRename.preview(names, match: match, to: to, start: startValue, limit: 5) }

    var body: some View {
        GlassIsland(padding: Metric.islandPad, dense: true) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    field("New name", $to, .to, label: "Rename to")
                    FieldButton(title: "Rename", symbol: nil, prominent: true, action: apply).fixedSize()
                }
                if showMatch { field("Match: text or a pattern", $match, .match, label: "Match") }
                HStack(spacing: 6) {
                    InsertPill(title: "Current name") { insert("$&") }
                    InsertPill(title: "Number \u{2191}") { insert("$n") }
                    InsertPill(title: "Number \u{2193}") { insert("$N") }
                    Spacer(minLength: 8)
                    if BatchRename.counts(to) {
                        Text(to.contains("$N") ? "Stop at" : "Start at").font(Typography.label).foregroundStyle(Palette.mutedFg)
                            .lineLimit(1).fixedSize()
                        TextField("1", text: $start).textFieldStyle(.plain).font(Typography.label).focused($focus, equals: .start)
                            .onSubmit(apply).onExitCommand { close() }.accessibilityLabel("Number to start from")
                            .padding(.horizontal, 8).frame(width: 48, height: Self.pill)
                            .background(RoundedRectangle(cornerRadius: Self.pill / 2, style: .continuous).fill(Palette.field))
                    }
                    Button { toggleMatch() } label: {
                        Text(showMatch ? "Hide match" : "Match\u{2026}").font(Typography.label).foregroundStyle(Palette.mutedFg)
                            .lineLimit(1).padding(.horizontal, 8).frame(height: Self.pill).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).fixedSize()
                    .accessibilityLabel(showMatch ? "Hide the Match field" : "Match part of each name")
                }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(preview.enumerated()), id: \.offset) { _, c in
                        HStack(spacing: 10) {
                            Text(c.old).foregroundStyle(Palette.mutedFg).lineLimit(1).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "arrow.right").font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.mutedFg)
                            Text(c.new).font(Typography.label).foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .font(.system(size: 12)).frame(height: 22)
                    }
                    if ids.count > preview.count {
                        Text("and \(ids.count - preview.count) more").font(Typography.micro).foregroundStyle(Palette.mutedFg).frame(height: 18)
                    }
                }
                .padding(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(8)
        }
        .frame(width: 480)
        .onAppear { DispatchQueue.main.async { focus = .to } }
        .onExitCommand { close() }
    }

    /// The inserts' and Match's height: one row, one height.
    private static let pill: CGFloat = 24

    private func field(_ hint: String, _ text: Binding<String>, _ f: Field, label: String) -> some View {
        FieldBox {
            TextField(hint, text: text).textFieldStyle(.plain).font(Typography.body).focused($focus, equals: f)
                .onSubmit(apply).onExitCommand { close() }.accessibilityLabel(label)
        }
    }

    private func insert(_ token: String) {
        to += token
        focus = .to
    }

    private func toggleMatch() {
        showMatch.toggle()
        if showMatch { DispatchQueue.main.async { focus = .match } } else { match = ""; focus = .to }
    }

    private func close() { model.batchRename = nil; model.focusCanvas() }

    private func apply() {
        let next = BatchRename.names(names, match: match, to: to, start: startValue)
        LayersStore.of(model).renameMany(ids, to: next)
        close()
    }
}

/// A token button under Rename to: a small grey capsule.
private struct InsertPill: View {
    let title: String
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            Text(title).font(Typography.label).foregroundStyle(Palette.fg).lineLimit(1)
                .padding(.horizontal, 10).frame(height: 24)
                .background(Capsule().fill(hovering ? Palette.field : Palette.active))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain).fixedSize()
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}
