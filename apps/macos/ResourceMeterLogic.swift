// Pure logic behind the resource meter (ResourceMeter.swift): number formatting, CPU percent from rusage
// counters, the amber/red thresholds, the sparkline ring and the plain-text report. Foundation only, so
// Tests/ResourceMeterTests.swift can run it without AppKit.

import Foundation

/// The processes that together make up Canvas, as Activity Monitor would add them up.
enum ProcessRole: String, CaseIterable {
    case app = "App", page = "Page", gpu = "GPU", network = "Network", server = "Server", tools = "Tools"

    /// What the row is, for the popover's help text and VoiceOver.
    var detail: String {
        switch self {
        case .app: "The Canvas window and its controls"
        case .page: "The web page that draws the canvas"
        case .gpu: "WebKit\u{2019}s graphics process"
        case .network: "WebKit\u{2019}s network process"
        case .server: "The local Node server"
        case .tools: "Tools the server runs: video conversion, font lookups"
        }
    }

    /// WebKit's XPC helpers by process name (proc_name truncates to 32 bytes, so match on prefixes).
    static func webKit(name: String) -> ProcessRole? {
        if name.hasPrefix("com.apple.WebKit.WebContent") { return .page }
        if name.hasPrefix("com.apple.WebKit.GPU") { return .gpu }
        if name.hasPrefix("com.apple.WebKit.Networking") { return .network }
        return nil
    }
}

enum ResourceFormat {
    static let gib: Double = 1024 * 1024 * 1024
    static let mib: Double = 1024 * 1024

    /// Activity Monitor's units (powers of 1024): "860 MB", "1.4 GB", "12.3 GB". Never wider than "999 MB" / "99.9 GB".
    static func memory(_ bytes: UInt64) -> String {
        let b = Double(bytes)
        if b < 999.5 * mib { return "\(Int((b / mib).rounded())) MB" }
        let g = b / gib
        if g < 99.95 { return String(format: "%.1f GB", g) }
        return "\(Int(g.rounded())) GB"
    }

    /// "6%", "143%". 100% is one core, as in Activity Monitor. Under half a percent reads "0%".
    static func cpu(_ percent: Double) -> String {
        guard percent.isFinite, percent > 0 else { return "0%" }
        return "\(Int(percent.rounded()))%"
    }

    /// The toolbar pill's CPU: never wider than "999%+" (its hidden template), however many cores are busy.
    static func cpuShort(_ percent: Double) -> String {
        guard percent.isFinite, percent < 999.5 else { return percent.isFinite ? "999%+" : "0%" }
        return cpu(percent)
    }

    /// For VoiceOver: "1.4 gigabytes", "860 megabytes".
    static func memorySpoken(_ bytes: UInt64) -> String {
        memory(bytes).replacingOccurrences(of: " GB", with: " gigabytes").replacingOccurrences(of: " MB", with: " megabytes")
    }

    static func cpuSpoken(_ percent: Double) -> String { cpu(percent).replacingOccurrences(of: "%", with: " percent") + " CPU" }
}

enum CPUMath {
    /// CPU percent of one process over a sampling interval. `prev`/`now` are ri_user_time + ri_system_time,
    /// which are mach absolute-time ticks (on Apple silicon one tick is 125/3 ns); `wallNanos` is the interval.
    /// Nil when the counter went backwards (the pid was reused by a new process) or the interval is empty.
    static func percent(prev: UInt64, now: UInt64, wallNanos: UInt64, numer: UInt32, denom: UInt32) -> Double? {
        guard now >= prev, wallNanos > 0, denom > 0 else { return nil }
        let busyNanos = Double(now - prev) * Double(numer) / Double(denom)
        return busyNanos / Double(wallNanos) * 100
    }
}

/// Which process each pid was when it was found (its start time): a pid the system handed to an unrelated process
/// since then is not ours any more, and must not be added up as Canvas.
struct PidStarts {
    private(set) var starts: [Int32: UInt64] = [:]
    /// True when `pid` (started at `start`) is the process first seen under that pid; the first sighting records it.
    mutating func same(_ pid: Int32, start: UInt64) -> Bool {
        if let s = starts[pid] { return s == start }
        starts[pid] = start
        return true
    }
}

/// How loud the readout is.
enum MeterLevel: Int, Comparable {
    case normal, elevated, high
    static func < (a: MeterLevel, b: MeterLevel) -> Bool { a.rawValue < b.rawValue }
}

/// One CPU reading: the total percent averaged over [start, end] (seconds on any monotonic clock).
struct CPUReading: Equatable {
    var start: Double
    var end: Double
    var percent: Double
}

enum MeterThresholds {
    static let memoryElevated: UInt64 = 3 * 1024 * 1024 * 1024
    static let memoryHigh: UInt64 = 5 * 1024 * 1024 * 1024
    static let cpuElevated: Double = 150
    static let cpuHigh: Double = 300
    /// CPU must stay above a threshold this long before the readout changes colour: a busy second is normal.
    static let sustain: Double = 10

    /// How long the newest run of readings above `threshold` covers, back to back (a gap or a dip breaks it).
    static func sustained(_ readings: [CPUReading], above threshold: Double) -> Double {
        guard var first = readings.last, first.percent > threshold else { return 0 }
        let end = first.end
        for r in readings.dropLast().reversed() {
            guard r.percent > threshold, first.start - r.end < 0.5 else { break }
            first = r
        }
        return end - first.start
    }

    static func level(memory: UInt64, cpu readings: [CPUReading]) -> MeterLevel {
        let mem: MeterLevel = memory > memoryHigh ? .high : (memory > memoryElevated ? .elevated : .normal)
        let cpu: MeterLevel = sustained(readings, above: cpuHigh) >= sustain ? .high
            : (sustained(readings, above: cpuElevated) >= sustain ? .elevated : .normal)
        return max(mem, cpu)
    }

    /// The toolbar readout shows only when memory or CPU is in the warn state, or while its popover is open
    /// (Quick actions > Resources opens it any time).
    static func readoutShown(level: MeterLevel, popoverOpen: Bool) -> Bool {
        level != .normal || popoverOpen
    }
}

/// A fixed-size history for the sparklines: the newest `capacity` values, oldest first.
struct SampleRing: Equatable {
    let capacity: Int
    private(set) var values: [Double] = []

    init(capacity: Int) { self.capacity = max(1, capacity) }

    mutating func append(_ v: Double) {
        values.append(v)
        if values.count > capacity { values.removeFirst(values.count - capacity) }
    }

    /// Each value as a fraction of the chart's top: the larger of `floor` and the history's maximum, so a flat
    /// idle line sits low instead of filling the chart.
    func normalized(floor: Double) -> [Double] {
        let top = max(floor, values.max() ?? 0)
        guard top > 0 else { return values.map { _ in 0 } }
        return values.map { min(max($0 / top, 0), 1) }
    }
}

/// The highest value seen and when.
struct Peak: Equatable {
    var value: Double = 0
    var at: Date?
    mutating func note(_ v: Double, at time: Date) {
        if at == nil || v > value { value = v; at = time }
    }
}

/// One process role's reading. `cpu` is nil on the first sample (no interval yet) or when it could not be read.
struct RoleUsage: Equatable {
    var role: ProcessRole
    var pids: [Int32]
    var memory: UInt64
    var cpu: Double?
}

enum ResourceReport {
    /// The plain-text snapshot "Copy report" puts on the clipboard, for pasting to Claude.
    static func text(time: Date, rows: [RoleUsage], totalMemory: UInt64, totalCPU: Double?, memoryPeak: Peak, cpuPeak: Peak,
                     file: String?, os: String, machine: String, commit: String?, uptime: TimeInterval, timeZone: TimeZone = .current) -> String {
        let iso = ISO8601DateFormatter()
        iso.timeZone = timeZone
        iso.formatOptions = [.withInternetDateTime]
        let clock = DateFormatter()
        clock.timeZone = timeZone
        clock.dateFormat = "HH:mm:ss"
        func cpu(_ v: Double?) -> String { v.map(ResourceFormat.cpu) ?? "n/a" }
        func pad(_ s: String, _ n: Int) -> String { s.count >= n ? s : s + String(repeating: " ", count: n - s.count) }

        var lines = ["Canvas resource report", "Time: \(iso.string(from: time))"]
        lines.append("Total: \(ResourceFormat.memory(totalMemory)) memory, \(cpu(totalCPU)) CPU (100% = one core)")
        lines.append("")
        for r in rows {
            let pids = r.pids.isEmpty ? "not found" : "pid " + r.pids.map(String.init).joined(separator: ", ")
            let mem = r.pids.isEmpty ? "-" : ResourceFormat.memory(r.memory)
            lines.append(pad(r.role.rawValue, 9) + pad(mem, 9) + pad(r.pids.isEmpty ? "-" : cpu(r.cpu), 7) + pids)
        }
        lines.append("")
        func peak(_ p: Peak, _ s: String) -> String { p.at.map { "\(s) at \(clock.string(from: $0))" } ?? "n/a" }
        lines.append("Peak memory: " + peak(memoryPeak, ResourceFormat.memory(UInt64(max(0, memoryPeak.value)))))
        lines.append("Peak CPU: " + peak(cpuPeak, ResourceFormat.cpu(cpuPeak.value)))
        lines.append("Measured for: \(uptimeText(uptime))")
        lines.append("")
        lines.append("File: \(file ?? "none open")")
        lines.append("macOS: \(os)")
        lines.append("Mac: \(machine)")
        lines.append("Commit: \(commit ?? "unknown")")
        return lines.joined(separator: "\n")
    }

    static func uptimeText(_ t: TimeInterval) -> String {
        let s = max(0, Int(t))
        if s < 60 { return "\(s) s" }
        if s < 3600 { return "\(s / 60) min" }
        return "\(s / 3600) h \(s % 3600 / 60) min"
    }
}

/// The commit a checkout is on, read from its .git directory (no git process). A worktree checkout's `.git` is a
/// file ("gitdir: <repo>/.git/worktrees/<name>"): HEAD is read there, branches from the main repository's .git.
enum GitHead {
    static func read(repo: URL, file: (URL) -> String? = { try? String(contentsOf: $0, encoding: .utf8) }) -> String? {
        var git = repo.appendingPathComponent(".git")
        var common = git
        if let link = file(git)?.trimmingCharacters(in: .whitespacesAndNewlines), link.hasPrefix("gitdir:") {
            let p = link.dropFirst(7).trimmingCharacters(in: .whitespaces)
            git = p.hasPrefix("/") ? URL(fileURLWithPath: p) : repo.appendingPathComponent(p)
            git = git.standardizedFileURL
            common = git
            if let c = file(git.appendingPathComponent("commondir"))?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty {
                common = (c.hasPrefix("/") ? URL(fileURLWithPath: c) : git.appendingPathComponent(c)).standardizedFileURL
            }
        }
        guard let head = file(git.appendingPathComponent("HEAD"))?.trimmingCharacters(in: .whitespacesAndNewlines), !head.isEmpty else { return nil }
        guard head.hasPrefix("ref: ") else { return short(head) }
        let ref = String(head.dropFirst(5))
        for dir in git == common ? [git] : [git, common] {
            if let loose = file(dir.appendingPathComponent(ref))?.trimmingCharacters(in: .whitespacesAndNewlines), !loose.isEmpty {
                return short(loose)
            }
        }
        // A ref that only lives in packed-refs: "<sha> refs/heads/main".
        for line in (file(common.appendingPathComponent("packed-refs")) ?? "").split(separator: "\n") {
            let parts = line.split(separator: " ")
            if parts.count == 2, parts[1] == ref { return short(String(parts[0])) }
        }
        return nil
    }

    private static func short(_ sha: String) -> String? {
        let hex = sha.prefix(40)
        guard hex.count >= 7, hex.allSatisfy(\.isHexDigit) else { return nil }
        return String(hex.prefix(7))
    }
}
