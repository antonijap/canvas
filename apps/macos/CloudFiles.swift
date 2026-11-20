// Home's Cloud files are listed by the host, including files this Mac has never opened.
import AppKit
import SwiftUI

private struct CloudFileItem: Identifiable {
    let id: String
    let name: String
}

struct CloudFilesView: View {
    @ObservedObject var model: CanvasModel
    let entry: CloudEntry
    @State private var files: [CloudFileItem] = []
    @State private var role = "viewer"
    @State private var message: String?
    @State private var usage: String?
    @State private var tone = "normal"
    @State private var busy = false

    private func read(_ path: String) async -> [String: Any] {
        var c = URLComponents(url: model.base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "cloud", value: entry.url)]
        guard let url = c?.url, let (data, _) = try? await URLSession.shared.data(from: url) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
    private func refresh() async {
        let j = await read("api/cloud/files")
        if let rows = j["files"] as? [[String: Any]] {
            files = rows.compactMap { r in
                guard let id = r["id"] as? String, let name = r["name"] as? String else { return nil }
                return CloudFileItem(id: id, name: name)
            }
            role = j["role"] as? String ?? "viewer"
            message = nil
        } else { message = j["error"] as? String ?? "The Cloud is unavailable" }
        if role == "owner" {
            let u = await read("api/cloud/usage")
            if let bytes = u["storageBytes"] as? Int64, let free = u["freeDisk"] as? Int64 {
                usage = "\(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)) stored, \(ByteCountFormatter.string(fromByteCount: free, countStyle: .file)) free on disk. \(u["peopleConnected"] as? Int ?? 0) people connected. Stays within the limits you set."
                tone = u["tone"] as? String ?? "normal"
            }
        }
    }
    private func open(_ item: CloudFileItem) {
        busy = true
        Task {
            let (status, j) = await CloudAccount.post(model, "api/cloud/files/open", ["cloud": entry.url, "id": item.id])
            busy = false
            if status == 200, let file = j["file"] as? String {
                model.cloudFileNames[file] = item.name
                model.open(file)
            } else { model.flash(j["error"] as? String ?? "Could not open the Cloud file") }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text("Everyone in this Cloud can open its files").font(Typography.body).foregroundStyle(Palette.mutedFg)
                Spacer()
                FieldButton(title: "New file", symbol: "plus", prominent: true) {
                    busy = true
                    Task {
                        let (status, j) = await CloudAccount.post(model, "api/cloud/files/create", ["cloud": entry.url, "name": "Untitled"])
                        busy = false
                        if status == 201, let file = j["file"] as? String {
                            model.cloudFileNames[file] = "Untitled"
                            model.open(file)
                        } else { model.flash(j["error"] as? String ?? "Could not create the Cloud file") }
                    }
                }.disabled(busy || (role != "owner" && role != "editor")).qaID("cloud-files-new", label: "New file")
            }
            if let usage {
                Text(usage).font(Typography.micro).foregroundStyle(tone == "normal" ? Palette.mutedFg : CloudInk.warn)
                    .qaID("cloud-files-usage", label: usage)
            }
            if let message { Text(message).font(Typography.body).foregroundStyle(Palette.mutedFg) }
            if files.isEmpty && message == nil { Text("No files yet").font(Typography.body).foregroundStyle(Palette.mutedFg) }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: HomeMetric.cardMin, maximum: HomeMetric.cardMax), spacing: HomeMetric.gap)], alignment: .leading, spacing: 20) {
                ForEach(files) { item in
                    Button { open(item) } label: {
                        VStack(alignment: .leading, spacing: 16) {
                            Image(systemName: "doc").font(.system(size: 28)).foregroundStyle(Palette.mutedFg)
                            Text(item.name).font(Typography.body).foregroundStyle(Palette.fg).lineLimit(2)
                        }.frame(maxWidth: .infinity, minHeight: 140, alignment: .leading).padding(16)
                    }.buttonStyle(.plain).disabled(busy).qaID("cloud-file", label: item.name)
                }
            }
        }
        .task(id: entry.url) {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }
}
