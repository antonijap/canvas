// The live resource meter in the top-right pill: memory and CPU of the whole app, added up the way Activity
// Monitor would. Canvas is several processes: this shell, WebKit's WebContent (the page), GPU and Networking
// helpers that serve this app, and the Node server. Every 2 s a background queue reads each one's
// phys_footprint and CPU time with proc_pid_rusage (no ps, no top); nothing is read while the window is hidden.
// Formatting, thresholds and the report text live in ResourceMeterLogic.swift.

import AppKit
import SwiftUI
import WebKit

// MARK: Sampling

/// One reading of every process. Built on the sampler's queue, published on the main thread.
struct ResourceSample {
    var time: Date
    /// Seconds on the monotonic clock: the CPU readings' interval.
    var start: Double
    var end: Double
    var rows: [RoleUsage]
    var totalMemory: UInt64
    var totalCPU: Double?
}

/// Finds the processes and reads their counters. Only ever used on `ResourceMeter.queue`.
final class ResourceSampler: @unchecked Sendable {
    private typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t

    private let me = getpid()
    private let port: Int
    /// Private libsystem call that names the app a helper works for (WebKit's XPC processes run under launchd,
    /// so parent pids do not say). Looked up at run time; without it only the page and the server are found.
    private let responsible: ResponsibleFn? = {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil } // RTLD_DEFAULT
        return unsafeBitCast(sym, to: ResponsibleFn.self)
    }()
    private let timebase: mach_timebase_info_data_t = { var t = mach_timebase_info_data_t(); mach_timebase_info(&t); return t }()

    /// Helper pids found by the last discovery pass.
    private var helpers: [ProcessRole: [pid_t]] = [:]
    /// Each watched pid's process start time: a pid reused by another process within the rediscovery window is dropped.
    private var starts = PidStarts()
    private var server: pid_t?
    private var discoveredAt: UInt64 = 0
    private var needsDiscovery = true
    private var prevTicks: [pid_t: UInt64] = [:]
    private var prevWall: UInt64 = 0

    static let interval: Double = 2
    /// Helpers come and go (a crashed page relaunches, WebKit prewarms one): look again this often.
    private static let rediscoverNanos: UInt64 = 10_000_000_000

    init(port: Int) { self.port = port }

    func sample(webContent: pid_t?) -> ResourceSample {
        let wall = DispatchTime.now().uptimeNanoseconds
        // After a pause (window hidden, Mac asleep) the old counters would average over the whole gap: start over.
        if prevWall > 0, Double(wall - prevWall) > Self.interval * 3 * 1e9 { prevTicks = [:] }
        if let wc = webContent, !(helpers[.page] ?? []).contains(wc) { needsDiscovery = true }
        if needsDiscovery || wall - discoveredAt > Self.rediscoverNanos { discover(webContent: webContent); discoveredAt = wall }

        var groups: [ProcessRole: [pid_t]] = helpers
        groups[.app] = [me]
        groups[.server] = server.map { [$0] } ?? []
        if let wc = webContent, !(groups[.page] ?? []).contains(wc) { groups[.page, default: []].append(wc) }
        // What the server runs right now (avconvert converting a video at several hundred percent, the font
        // tool): read every sample, a conversion is often over before the next discovery pass.
        if let s = server {
            for kid in Self.children(of: s) where !(groups[.tools] ?? []).contains(kid) {
                groups[.tools, default: []].append(kid)
            }
        }

        let wallNanos = prevWall > 0 ? wall - prevWall : 0
        var ticks: [pid_t: UInt64] = [:]
        var rows: [RoleUsage] = []
        for role in ProcessRole.allCases {
            var usage = RoleUsage(role: role, pids: [], memory: 0, cpu: nil)
            for pid in groups[role] ?? [] {
                guard let ri = Self.rusage(pid) else { needsDiscovery = true; continue } // gone: look again next time
                // Another process under a pid we watched: not ours. Its counters are dropped and discovery runs again.
                guard starts.same(pid, start: ri.ri_proc_start_abstime) else { needsDiscovery = true; prevTicks[pid] = nil; continue }
                let busy = ri.ri_user_time + ri.ri_system_time
                ticks[pid] = busy
                usage.pids.append(pid)
                usage.memory += ri.ri_phys_footprint
                if let prev = prevTicks[pid],
                   let pct = CPUMath.percent(prev: prev, now: busy, wallNanos: wallNanos, numer: timebase.numer, denom: timebase.denom) {
                    usage.cpu = (usage.cpu ?? 0) + pct
                }
            }
            rows.append(usage)
        }
        let start = Double(prevWall) / 1e9
        prevTicks = ticks
        prevWall = wall
        let cpus = rows.compactMap(\.cpu)
        return ResourceSample(time: Date(), start: start, end: Double(wall) / 1e9, rows: rows,
                              totalMemory: rows.reduce(0) { $0 + $1.memory }, totalCPU: cpus.isEmpty ? nil : cpus.reduce(0, +))
    }

    // MARK: Finding the processes

    private func discover(webContent: pid_t?) {
        needsDiscovery = false
        var found: [ProcessRole: [pid_t]] = [:]
        var nodes: [pid_t] = [], others: [pid_t] = []
        if let responsible {
            for pid in Self.allPids() where pid != me && responsible(pid) == me {
                let name = Self.name(pid)
                if let role = ProcessRole.webKit(name: name) { found[role, default: []].append(pid) }
                else if name == "node" { nodes.append(pid) }
                else { others.append(pid) } // a tool the server or the app runs (avconvert, the font tool)
            }
        }
        let still = server.flatMap { s in Self.name(s) == "node" ? Self.rusage(s) : nil }.map { starts.same(server!, start: $0.ri_proc_start_abstime) } ?? false
        if !still { server = Self.children(of: me).first { Self.name($0) == "node" } ?? nodes.first ?? listener(on: port) }
        others += nodes.filter { $0 != server }
        if !others.isEmpty { found[.tools] = others }
        helpers = found
        // This pass picked its pids just now, so their start times are recorded afresh on the next read.
        starts = PidStarts()
    }

    /// The server was already running when Canvas started (not our child): find the node listening on our port.
    private func listener(on port: Int) -> pid_t? {
        Self.allPids().first { pid in Self.name(pid) == "node" && Self.listens(pid, port: port) }
    }

    private static func allPids() -> [pid_t] {
        let n = proc_listallpids(nil, 0)
        guard n > 0 else { return [] }
        var pids = [pid_t](repeating: 0, count: Int(n) + 32)
        let got = pids.withUnsafeMutableBufferPointer { proc_listallpids($0.baseAddress, Int32($0.count * MemoryLayout<pid_t>.size)) }
        return got > 0 ? pids.prefix(Int(got)).filter { $0 > 0 } : []
    }

    private static func children(of pid: pid_t) -> [pid_t] {
        var kids = [pid_t](repeating: 0, count: 64)
        let n = kids.withUnsafeMutableBufferPointer { proc_listchildpids(pid, $0.baseAddress, Int32($0.count * MemoryLayout<pid_t>.size)) }
        return n > 0 ? kids.prefix(Int(n)).filter { $0 > 0 } : []
    }

    private static func name(_ pid: pid_t) -> String {
        var buf = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &buf, UInt32(buf.count)) > 0 else { return "" }
        return String(cString: buf)
    }

    private static func rusage(_ pid: pid_t) -> rusage_info_v4? {
        var ri = rusage_info_v4()
        let rc = withUnsafeMutablePointer(to: &ri) {
            $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        }
        return rc == 0 ? ri : nil
    }

    private static func listens(_ pid: pid_t, port: Int) -> Bool {
        let size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard size > 0 else { return false }
        var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(size) / MemoryLayout<proc_fdinfo>.stride + 8)
        let got = fds.withUnsafeMutableBytes { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, $0.baseAddress, Int32($0.count)) }
        guard got > 0 else { return false }
        for fd in fds.prefix(Int(got) / MemoryLayout<proc_fdinfo>.stride) where fd.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
            var si = socket_fdinfo()
            let n = proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &si, Int32(MemoryLayout<socket_fdinfo>.size))
            guard n == Int32(MemoryLayout<socket_fdinfo>.size), si.psi.soi_kind == SOCKINFO_TCP else { continue }
            let tcp = si.psi.soi_proto.pri_tcp
            if tcp.tcpsi_state == 1 /* TSI_S_LISTEN */, Int(UInt16(bigEndian: UInt16(truncatingIfNeeded: tcp.tcpsi_ini.insi_lport))) == port { return true }
        }
        return false
    }
}

// MARK: Model

@MainActor final class ResourceMeter: ObservableObject {
    static let shared = ResourceMeter()

    @Published private(set) var rows: [RoleUsage] = []
    @Published private(set) var totalMemory: UInt64 = 0
    @Published private(set) var totalCPU: Double?
    @Published private(set) var level: MeterLevel = .normal
    @Published private(set) var memoryHistory = SampleRing(capacity: 60) // 2 minutes at 2 s, in GB
    @Published private(set) var cpuHistory = SampleRing(capacity: 60)
    @Published private(set) var memoryPeak = Peak()
    @Published private(set) var cpuPeak = Peak()
    @Published private(set) var lastSample: Date?
    /// The popover under the readout: its button, or Quick actions > Resources (Palette.swift).
    @Published var popoverOpen = false

    private let started = Date()
    private var readings: [CPUReading] = []
    private var timer: Timer?
    private var busy = false
    private let queue = DispatchQueue(label: "canvas.resource-meter", qos: .utility)
    private let sampler = ResourceSampler(port: port)
    private weak var model: CanvasModel?

    func start(model: CanvasModel) {
        self.model = model
        guard timer == nil else { return }
        tick()
        let t = Timer(timeInterval: ResourceSampler.interval, repeats: true) { _ in MainActor.assumeIsolated { ResourceMeter.shared.tick() } }
        t.tolerance = 0.4
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// Some window of ours is on screen: not minimised, not hidden, not fully covered.
    private var onScreen: Bool {
        NSApp.windows.contains { $0.styleMask.contains(.titled) && $0.isVisible && !$0.isMiniaturized && $0.occlusionState.contains(.visible) }
    }

    private func tick() {
        guard !busy, onScreen else { return }
        busy = true
        let wc = webContentPid()
        let sampler = self.sampler
        queue.async {
            let s = sampler.sample(webContent: wc)
            DispatchQueue.main.async { MainActor.assumeIsolated { ResourceMeter.shared.apply(s) } }
        }
    }

    /// WKWebView's private `_webProcessIdentifier`, read only when it answers to it (KVC on a missing key throws).
    private func webContentPid() -> pid_t? {
        guard let webView = model?.webView, webView.responds(to: NSSelectorFromString("_webProcessIdentifier")),
              let n = webView.value(forKey: "_webProcessIdentifier") as? NSNumber, n.int32Value > 0 else { return nil }
        return n.int32Value
    }

    private func apply(_ s: ResourceSample) {
        busy = false
        rows = s.rows
        totalMemory = s.totalMemory
        totalCPU = s.totalCPU
        lastSample = s.time
        memoryHistory.append(Double(s.totalMemory) / ResourceFormat.gib)
        memoryPeak.note(Double(s.totalMemory), at: s.time)
        if let cpu = s.totalCPU {
            cpuHistory.append(cpu)
            cpuPeak.note(cpu, at: s.time)
            readings.append(CPUReading(start: s.start, end: s.end, percent: cpu))
            readings.removeAll { s.end - $0.end > 30 }
        } else {
            readings.removeAll() // a pause or the first sample: the sustained count starts over
        }
        level = MeterThresholds.level(memory: s.totalMemory, cpu: readings)
    }

    // MARK: Report

    func report(file: String?) -> String {
        ResourceReport.text(time: lastSample ?? Date(), rows: rows, totalMemory: totalMemory, totalCPU: totalCPU,
                            memoryPeak: memoryPeak, cpuPeak: cpuPeak, file: file,
                            os: ProcessInfo.processInfo.operatingSystemVersionString, machine: Self.machine,
                            commit: Self.commit, uptime: Date().timeIntervalSince(started))
    }

    private static func sysctl(_ key: String) -> String? {
        var size = 0
        guard sysctlbyname(key, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buf = [CChar](repeating: 0, count: size)
        guard sysctlbyname(key, &buf, &size, nil, 0) == 0 else { return nil }
        return String(cString: buf)
    }

    private static let machine: String = {
        let p = ProcessInfo.processInfo
        let ram = Int((Double(p.physicalMemory) / ResourceFormat.gib).rounded())
        let chip = sysctl("machdep.cpu.brand_string") ?? "unknown chip"
        let model = sysctl("hw.model").map { ", \($0)" } ?? ""
        return "\(chip)\(model), \(ram) GB RAM, \(p.activeProcessorCount) cores"
    }()

    /// The checkout's HEAD (the server runs from it) and when this binary was built.
    private static let commit: String? = {
        let repo = URL(fileURLWithPath: serverScript).deletingLastPathComponent().deletingLastPathComponent()
        let head = GitHead.read(repo: repo)
        let built = (Bundle.main.executableURL).flatMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        switch (head, built) {
        case let (h?, b?): return "\(h) (checkout HEAD), app built \(f.string(from: b))"
        case let (h?, nil): return "\(h) (checkout HEAD)"
        case let (nil, b?): return "unknown, app built \(f.string(from: b))"
        default: return nil
        }
    }()
}

// MARK: Views

extension MeterLevel {
    var tint: Color {
        switch self {
        case .normal: Palette.mutedFg
        case .elevated: Palette.warn
        case .high: Palette.danger
        }
    }
}

/// Memory and CPU in the toolbar pill, each after an SF Symbol (memorychip, cpu). Fixed width, so the buttons beside it never move as the numbers change.
/// Shown only in the warn state (amber or red) or while its popover is open; otherwise it takes no room. The view
/// itself always stays in the pill: it starts the sampler and anchors the popover.
struct ResourceReadout: View {
    @ObservedObject var meter: ResourceMeter
    @ObservedObject var model: CanvasModel
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var open: Bool { meter.popoverOpen }
    private var ready: Bool { meter.lastSample != nil }
    private var memory: String { ready ? ResourceFormat.memory(meter.totalMemory) : "\u{2026}" }
    private var cpu: String { meter.totalCPU.map(ResourceFormat.cpuShort) ?? "\u{2026}" }

    var body: some View {
        ZStack {
            Color.clear.frame(width: 0, height: Metric.control)
            if MeterThresholds.readoutShown(level: meter.level, popoverOpen: open) { readout }
        }
        .onAppear { meter.start(model: model) }
        .popover(isPresented: $meter.popoverOpen, arrowEdge: .bottom) { ResourcePopover(meter: meter, model: model) }
    }

    private var readout: some View {
        Button { meter.popoverOpen.toggle() } label: {
            // Two values, each after its own glyph; spacing separates them. Hidden templates reserve the widest
            // value each side can show.
            HStack(spacing: 9) {
                HStack(spacing: 4) {
                    Image(systemName: "memorychip").glyph(GlyphSize.field).opacity(0.8)
                    ZStack(alignment: .trailing) {
                        Text("000 MB").hidden()
                        Text("00.0 GB").hidden()
                        Text(memory).contentTransition(reduceMotion ? .identity : .numericText())
                    }
                }
                HStack(spacing: 4) {
                    Image(systemName: "cpu").glyph(GlyphSize.field).opacity(0.8)
                    ZStack(alignment: .trailing) {
                        Text("000%").hidden()
                        Text("999%+").hidden()
                        Text(cpu).contentTransition(reduceMotion ? .identity : .numericText())
                    }
                }
            }
            .font(Typography.label.monospacedDigit())
            .foregroundStyle(open ? Palette.fg : meter.level.tint)
            .animation(reduceMotion ? nil : Motion.fast, value: memory + cpu)
            .animation(Motion.island, value: meter.level)
            .lineLimit(1)
            .padding(.horizontal, 10)
            .frame(height: Metric.control)
            .background(Capsule().fill(open ? Palette.active : (hovering ? Palette.hover : .clear)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .chromeHelp("Memory and CPU used by Canvas")
        .accessibilityLabel("Memory and CPU used by Canvas")
        .accessibilityValue(ready ? "\(ResourceFormat.memorySpoken(meter.totalMemory)), \(meter.totalCPU.map(ResourceFormat.cpuSpoken) ?? "CPU measuring")"
                                  : "Measuring")
        .accessibilityHint("Shows memory and CPU per process")
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

/// Two numbers, each over its last 2 minutes, in the text colour. The copy icon puts the plain-text report
/// (per-process table, peaks, the Mac and the commit) on the clipboard.
struct ResourcePopover: View {
    @ObservedObject var meter: ResourceMeter
    @ObservedObject var model: CanvasModel

    private var memory: String { meter.lastSample == nil ? "\u{2026}" : ResourceFormat.memory(meter.totalMemory) }
    private var cpu: String { meter.totalCPU.map(ResourceFormat.cpu) ?? "\u{2026}" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("\(memory) memory").font(Typography.title.monospacedDigit()).foregroundStyle(Palette.fg).lineLimit(1)
                Spacer(minLength: 8)
                CopyReportButton { copyReport() }
            }
            Sparkline(values: meter.memoryHistory.normalized(floor: 1), capacity: meter.memoryHistory.capacity, tint: Palette.fg)
                .frame(height: 34)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Memory, last 2 minutes")
                .accessibilityValue(ResourceFormat.memorySpoken(meter.totalMemory))
            Text("\(cpu) CPU").font(Typography.title.monospacedDigit()).foregroundStyle(Palette.fg).lineLimit(1)
            Sparkline(values: meter.cpuHistory.normalized(floor: 100), capacity: meter.cpuHistory.capacity, tint: Palette.fg)
                .frame(height: 34)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("CPU, last 2 minutes, 100% is one core")
                .accessibilityValue(meter.totalCPU.map(ResourceFormat.cpuSpoken) ?? "Measuring")
        }
        .padding(14)
        .frame(width: 280)
    }

    private func copyReport() {
        let text = meter.report(file: model.currentFile.map { model.name(of: $0) })
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        model.flash("Copied the resource report", level: "success")
    }
}

/// The popover's 28 pt copy icon (top right), grey like the other chrome icons.
private struct CopyReportButton: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "doc.on.doc")
                .font(.system(size: Metric.icon, weight: .medium))
                .foregroundStyle(hovering ? Palette.fg : Palette.mutedFg)
                .frame(width: 28, height: 28)
                .background(Circle().fill(hovering ? Palette.hover : .clear))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .chromeHelp("Copy report")
        .accessibilityLabel("Copy report")
        .accessibilityHint("Copies a plain-text snapshot to paste into a chat")
        .onHover { h in withAnimation(Motion.fast) { hovering = h } }
    }
}

/// Values in 0...1, newest at the right edge, so a short history grows in from the right. Drawn in `tint` at low
/// opacity: an area with a slightly stronger top line.
struct Sparkline: View {
    let values: [Double]
    let capacity: Int
    let tint: Color

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height, inset: CGFloat = 1.5
            let step = capacity > 1 ? w / CGFloat(capacity - 1) : w
            let pts = values.enumerated().map { i, v in
                CGPoint(x: w - CGFloat(values.count - 1 - i) * step, y: inset + (h - inset * 2) * (1 - CGFloat(v)))
            }
            if pts.count > 1 {
                ZStack {
                    Path { p in
                        p.move(to: CGPoint(x: pts[0].x, y: h))
                        pts.forEach { p.addLine(to: $0) }
                        p.addLine(to: CGPoint(x: pts[pts.count - 1].x, y: h))
                        p.closeSubpath()
                    }
                    .fill(tint.opacity(0.12))
                    Path { p in p.addLines(pts) }
                        .stroke(tint.opacity(0.3), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                }
            }
        }
    }
}
