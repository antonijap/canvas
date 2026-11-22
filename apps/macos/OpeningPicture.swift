import AppKit
import CryptoKit
import WebKit

/// The last settled view of a local document. The image and the conditions under which it can be
/// shown are replaced together so an interrupted write cannot pair old pixels with a new document.
struct OpeningPicture: Codable {
    private static let writes = DispatchQueue(label: "canvas.opening-pictures", qos: .utility)
    let signature: String
    let appearance: String
    let labels: Bool
    let width: CGFloat
    let height: CGFloat
    let scale: CGFloat
    let view: ViewState
    let png: Data

    struct ViewState: Codable, Equatable {
        let revision: String
        let dark: Bool
        let page: String
        let x: Double
        let y: Double
        let z: Double

        var camera: [String: Any] { ["page": page, "x": x, "y": y, "z": z] }
    }

    static func url(_ file: String) -> URL {
        URL(fileURLWithPath: StateFolder.path).appendingPathComponent("opening-pictures", isDirectory: true)
            .appendingPathComponent(Thumbnails.key(file) + ".plist")
    }

    /// Include the edit journal, page and widget state, and assets replaced at the same path.
    /// Large or linked packages take the normal live path.
    static func signature(_ file: String) -> String? {
        guard file.hasSuffix(".canvas"), CloudFilePath(file) == nil else { return nil }
        let root = URL(fileURLWithPath: file, isDirectory: true)
        let keys: Set<URLResourceKey> = [.isSymbolicLinkKey, .isRegularFileKey, .isDirectoryKey]
        guard (try? root.resourceValues(forKeys: keys).isSymbolicLink) == false else { return nil }
        var failed = false
        guard let entries = FileManager.default.enumerator(at: root, includingPropertiesForKeys: Array(keys),
            errorHandler: { _, _ in failed = true; return false }) else { return nil }
        var rows: [String] = []
        var hasDocument = false
        for case let url as URL in entries {
            guard rows.count < 1024, let meta = try? url.resourceValues(forKeys: keys),
                  meta.isSymbolicLink == false else { return nil }
            if meta.isDirectory == true { continue }
            var st = stat()
            guard meta.isRegularFile == true, lstat(url.path, &st) == 0 else { return nil }
            let stamp = st.st_ctimespec
            let name = String(url.path.dropFirst(root.path.count + 1))
            hasDocument = hasDocument || name == "document.json"
            rows.append("\(name.utf8.count):\(name):\(st.st_size):\(stamp.tv_sec):\(stamp.tv_nsec):\(st.st_dev):\(st.st_ino)")
        }
        guard hasDocument, !failed else { return nil }
        return SHA256.hash(data: Data(rows.sorted().joined(separator: "\n").utf8))
            .map { String(format: "%02x", $0) }.joined()
    }

    static func read(_ file: String) -> OpeningPicture? {
        guard let bytes = try? Data(contentsOf: url(file)),
              let saved = try? PropertyListDecoder().decode(Self.self, from: bytes),
              signature(file) == saved.signature else { return nil }
        return saved
    }

    func write(_ file: String) -> Bool {
        let target = Self.url(file)
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        guard png.count <= 12 << 20, let bytes = try? encoder.encode(self) else { return false }
        return Self.writes.sync {
            let folder = target.deletingLastPathComponent()
            let fm = FileManager.default
            try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
            guard (try? bytes.write(to: target, options: .atomic)) != nil else { return false }
            let files = (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            let sorted = files.filter { $0.pathExtension == "plist" }.sorted {
                ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) >
                ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
            }
            for old in sorted.dropFirst(32) { try? fm.removeItem(at: old) }
            return true
        }
    }
}

extension CanvasModel {
    private func openingCaptureStatus(_ status: String) {
        #if CANVAS_QA
        openingTimings["capture"] = status
        #endif
    }

    func snapshotOpeningPicture(then done: (() -> Void)? = nil) {
        guard let file = currentFile, !homeShown else { done?(); return }
        saveOpeningPicture(of: webView, file: file, then: done)
    }

    func saveOpeningPicture(of web: WKWebView, file: String, then done: (() -> Void)? = nil) {
        guard writesIdle, !textEditing, !web.isLoading, web.window != nil,
              web.bounds.width > 100, web.bounds.height > 100, prefs.openView == .restore,
              let signature = OpeningPicture.signature(file) else { openingCaptureStatus("file or view unavailable"); done?(); return }
        let size = web.bounds.size
        let scale = web.window?.backingScaleFactor ?? 1
        let appearance = openingAppearance
        let labels = prefs.boardLabels
        web.evaluateJavaScript("window.canvasHost?.openingSnapshot?.() ?? null") { result, _ in
            guard let raw = result as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: raw),
                  let state = try? JSONDecoder().decode(OpeningPicture.ViewState.self, from: data)
            else { self.openingCaptureStatus("page unsettled"); done?(); return }
            guard state.dark == (appearance == NSAppearance.Name.darkAqua.rawValue)
            else {
                web.evaluateJavaScript("window.canvasHost?.finishOpeningSnapshot?.()")
                self.openingCaptureStatus("appearance mismatch")
                done?()
                return
            }
            web.takeSnapshot(with: nil) { image, _ in
                web.evaluateJavaScript("window.canvasHost?.finishOpeningSnapshot?.() ?? null") { result, _ in
                    guard let raw = result as? [String: Any],
                          let end = try? JSONSerialization.data(withJSONObject: raw),
                          (try? JSONDecoder().decode(OpeningPicture.ViewState.self, from: end)) == state,
                          let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
                          size == web.bounds.size, appearance == self.openingAppearance, labels == self.prefs.boardLabels
                    else { self.openingCaptureStatus("frame changed during capture"); done?(); return }
                    self.persistOpeningPicture(file, signature: signature, view: state, size: size,
                                               scale: scale, appearance: appearance, labels: labels, image: cg, then: done)
                }
            }
        }
    }

    private func persistOpeningPicture(_ file: String, signature: String, view: OpeningPicture.ViewState,
                                       size: NSSize, scale: CGFloat, appearance: String, labels: Bool,
                                       image: CGImage, then done: (() -> Void)?) {
        var request = URLRequest(url: base.appendingPathComponent("api/flush"))
        request.timeoutInterval = 1
        request.httpMethod = "POST"
        request.setValue("1", forHTTPHeaderField: "x-canvas")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["file": file])
        URLSession.shared.dataTask(with: request) { data, response, _ in
            var status = "revision or signature changed"
            defer {
                let result = status
                DispatchQueue.main.async { self.openingCaptureStatus(result); done?() }
            }
            guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
                  let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  result["revision"] as? String == view.revision,
                  OpeningPicture.signature(file) == signature,
                  let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return }
            let saved = OpeningPicture(signature: signature, appearance: appearance, labels: labels, width: size.width,
                                       height: size.height, scale: scale, view: view, png: png)
            status = saved.write(file) ? "saved" : "cache write failed"
        }.resume()
    }
}
