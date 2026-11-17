// Text in images, for the release scrub (qa/release.ts): `xcrun swift qa/ocr.swift a.png b.png ...` prints one JSON
// line per image, {"file", "text"} or {"file", "error"}. macOS Vision, on this Mac, nothing leaves it.
import AppKit
import Vision

for file in CommandLine.arguments.dropFirst() {
    var out: [String: String] = ["file": file]
    if let img = NSImage(contentsOfFile: file), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = false
        do {
            try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
            out["text"] = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        } catch { out["error"] = String(describing: error) }
    } else { out["error"] = "not an image" }
    if let d = try? JSONSerialization.data(withJSONObject: out), let s = String(data: d, encoding: .utf8) { print(s) }
}
