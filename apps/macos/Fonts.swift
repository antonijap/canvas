// Every font installed on this Mac, read off the main thread and cached. Weights and the
// "is this family installed" check are lazy and O(1) after that, so a document with hundreds of
// text nodes and a font list of a thousand families both stay cheap.

import AppKit
import CoreText
import SwiftUI

final class FontCatalog: ObservableObject {
    @Published private(set) var families: [String] = []
    @Published private(set) var generation = 0
    var onRefresh: ((Bool) -> Void)?
    private var lowered = Set<String>()
    private var styleCache: [String: [(name: String, weight: Int)]] = [:]
    private let queue = DispatchQueue(label: "canvas.font-catalog", qos: .userInitiated)
    private var observers: [NSObjectProtocol] = []
    private var registryObserver: NSObjectProtocol?

    init() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: NSFont.fontSetChangedNotification, object: nil, queue: .main) { [weak self] _ in
                self?.refresh(force: true)
            },
            center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.refresh()
            },
        ]
        registryObserver = DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name(kCTFontManagerRegisteredFontsChangedNotification as String), object: nil, queue: .main
        ) { [weak self] _ in self?.refresh(force: true) }
        refresh(notify: false)
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        if let registryObserver { DistributedNotificationCenter.default().removeObserver(registryObserver) }
    }

    private func refresh(force: Bool = false, notify: Bool = true) {
        queue.async { [weak self] in
            let all = NSFontManager.shared.availableFontFamilies
                .filter { !$0.hasPrefix(".") }
                .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
            let set = Set(all.map { $0.lowercased() })
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let changed = self.families != all
                self.lowered = set
                self.styleCache.removeAll()
                self.smcpCache.removeAll()
                self.asking.removeAll()
                self.drawable.removeAll()
                self.generation += 1
                if changed { self.families = all }
                if notify { self.onRefresh?(force || changed) }
            }
        }
    }

    func has(_ family: String) -> Bool { lowered.contains(family.lowercased()) }

    /// Families this Mac lacks that the canvas still draws (a document font or a Google web font the server
    /// fetches): true or false once asked, nil until then. The inspector's "Missing" tag waits for the answer.
    @Published private(set) var drawable: [String: Bool] = [:]
    private var asking = Set<String>()

    /// Asks the server once per family whether it can serve the font (src/scene.ts /api/fonts/file).
    func checkDrawable(_ family: String, base: URL, file: String?) {
        let key = family.lowercased()
        guard !has(family), drawable[key] == nil, !asking.contains(key),
              var c = URLComponents(url: base.appendingPathComponent("api/fonts/file"), resolvingAgainstBaseURL: false) else { return }
        c.setQuery([URLQueryItem(name: "family", value: family), URLQueryItem(name: "weight", value: "400")] + (file.map { [URLQueryItem(name: "file", value: $0)] } ?? []))
        guard let url = c.url else { return }
        asking.insert(key)
        let generation = self.generation
        URLSession.shared.dataTask(with: url) { [weak self] _, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == generation else { return }
                self.asking.remove(key)
                // No answer (server busy, offline): ask again next time rather than calling it missing for good.
                if status == 200 { self.drawable[key] = true } else if status == 404 { self.drawable[key] = false }
            }
        }.resume()
    }

    /// The style a CSS weight (100-900) lands on: the member whose weight is nearest.
    private func members(of family: String) -> [(name: String, weight: Int)] {
        if let hit = styleCache[family] { return hit }
        let members: [(name: String, weight: Int)] = (NSFontManager.shared.availableMembers(ofFontFamily: family) ?? []).compactMap { m in
            guard m.count > 2, let name = m[1] as? String, let w = (m[2] as? NSNumber)?.intValue else { return nil }
            return (name, w)
        }
        styleCache[family] = members
        return members
    }

    /// The AppKit weights (0-15) the family's members have; the weight menu shows only these (FontWeights.available).
    func appKitWeights(of family: String) -> [Int] { members(of: family).map(\.weight) }

    func style(of family: String, cssWeight: Int) -> String? {
        let members = members(of: family)
        let target = [100: 2, 200: 3, 300: 4, 400: 5, 500: 6, 600: 8, 700: 9, 800: 10, 900: 11][cssWeight] ?? 5
        return members.min { abs($0.weight - target) < abs($1.weight - target) }?.name
    }

    func styleCount(of family: String) -> Int { NSFontManager.shared.availableMembers(ofFontFamily: family)?.count ?? 0 }

    private var smcpCache: [String: Bool?] = [:]
    /// Does the family have small capitals (`smcp` in its GSUB table)? nil when this Mac does not have the font (a web
    /// font the canvas draws): Typography's Small caps stays on offer then. Small caps are offered only where the font
    /// has them; Canvas draws the font's own and never synthesizes them.
    func smallCaps(of family: String) -> Bool? {
        if let hit = smcpCache[family] { return hit }
        let font: NSFont? = has(family) ? NSFontManager.shared.font(withFamily: family, traits: [], weight: 5, size: 13)
            : OpenTypeFeatures.isSystem(family) ? NSFont.systemFont(ofSize: 13) : nil
        let answer = font.map { f -> Bool in
            guard let t = CTFontCopyTable(f as CTFont, CTFontTableTag(kCTFontTableGSUB), []) else { return false }
            return OpenTypeFeatures.gsub(t as Data).contains("smcp")
        }
        smcpCache[family] = answer
        return answer
    }
}
