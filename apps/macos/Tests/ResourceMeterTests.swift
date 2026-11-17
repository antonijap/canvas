// Tests for ResourceMeterLogic.swift: memory and CPU formatting, CPU percent from rusage ticks, the amber/red
// thresholds (CPU must stay high for 10 s), the sparkline ring, peaks, the copied report and reading git HEAD.
// Run from apps/macos:
//   swiftc -parse-as-library ResourceMeterLogic.swift Tests/ResourceMeterTests.swift -o /tmp/meter-tests && /tmp/meter-tests

import Foundation

@main
struct ResourceMeterTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
        checks += 1
        if !ok { failures += 1; print("FAIL line \(line): \(what())") }
    }

    static func main() {
        formatting(); cpuMath(); thresholds(); ring(); peaks(); roles(); report(); gitHead(); pillWidth(); pidReuse(); worktree()
        print(failures == 0 ? "ok: \(checks) checks" : "\(failures) of \(checks) checks failed")
        exit(failures == 0 ? 0 : 1)
    }

    static let mib: UInt64 = 1024 * 1024
    static let gib: UInt64 = 1024 * 1024 * 1024

    static func formatting() {
        check(ResourceFormat.memory(0) == "0 MB", "zero")
        check(ResourceFormat.memory(860 * mib) == "860 MB", "MB under a gigabyte")
        check(ResourceFormat.memory(999 * mib) == "999 MB", "999 MB stays MB")
        check(ResourceFormat.memory(1000 * mib) == "1.0 GB", "never four-digit MB: \(ResourceFormat.memory(1000 * mib))")
        check(ResourceFormat.memory(gib + 400 * mib) == "1.4 GB", "1.4 GB: \(ResourceFormat.memory(gib + 400 * mib))")
        check(ResourceFormat.memory(12 * gib + 300 * mib) == "12.3 GB", "two-digit GB")
        check(ResourceFormat.memory(120 * gib) == "120 GB", "huge drops the decimal")
        check(ResourceFormat.cpu(6.4) == "6%", "rounds")
        check(ResourceFormat.cpu(0.3) == "0%", "tiny")
        check(ResourceFormat.cpu(-1) == "0%", "negative never shows")
        check(ResourceFormat.cpu(.nan) == "0%", "nan never shows")
        check(ResourceFormat.cpu(143.6) == "144%", "multi-core")
        check(ResourceFormat.memorySpoken(gib + 400 * mib) == "1.4 gigabytes", "spoken GB")
        check(ResourceFormat.cpuSpoken(6) == "6 percent CPU", "spoken CPU")
        // Maintainer rule: no middle dots anywhere in the interface.
        check(!ResourceFormat.memory(gib).contains("\u{00B7}") && !ResourceFormat.cpu(5).contains("\u{00B7}"), "no middle dots")
    }

    static func cpuMath() {
        // Apple silicon: one tick is 125/3 ns. 2 s of wall time, 24_000_000 ticks = 1 s of CPU = 50%.
        let p = CPUMath.percent(prev: 1_000, now: 1_000 + 24_000_000, wallNanos: 2_000_000_000, numer: 125, denom: 3)
        check(p.map { abs($0 - 50) < 1e-9 } == true, "50%: \(String(describing: p))")
        // Intel-style timebase 1/1: ticks are ns. 3 s CPU over 2 s = 150% (more than one core).
        check(CPUMath.percent(prev: 0, now: 3_000_000_000, wallNanos: 2_000_000_000, numer: 1, denom: 1) == 150, "150%")
        check(CPUMath.percent(prev: 10, now: 10, wallNanos: 2_000_000_000, numer: 1, denom: 1) == 0, "idle")
        check(CPUMath.percent(prev: 100, now: 50, wallNanos: 2_000_000_000, numer: 1, denom: 1) == nil, "pid reused: counter went back")
        check(CPUMath.percent(prev: 0, now: 50, wallNanos: 0, numer: 1, denom: 1) == nil, "empty interval")
        check(CPUMath.percent(prev: 0, now: 50, wallNanos: 1, numer: 1, denom: 0) == nil, "bad timebase")
    }

    static func readings(_ pcts: [Double], step: Double = 2) -> [CPUReading] {
        pcts.enumerated().map { i, p in CPUReading(start: Double(i) * step, end: Double(i + 1) * step, percent: p) }
    }

    static func thresholds() {
        check(MeterThresholds.level(memory: gib, cpu: []) == .normal, "quiet")
        check(MeterThresholds.level(memory: 3 * gib, cpu: []) == .normal, "exactly 3 GB is fine")
        check(MeterThresholds.level(memory: 3 * gib + 1, cpu: []) == .elevated, "over 3 GB: amber")
        check(MeterThresholds.level(memory: 5 * gib + 1, cpu: []) == .high, "over 5 GB: red")

        check(MeterThresholds.level(memory: gib, cpu: readings([400, 400])) == .normal, "a 4 s spike is normal")
        check(MeterThresholds.level(memory: gib, cpu: readings([10, 200, 200, 200, 200])) == .normal, "8 s above 150: not yet")
        check(MeterThresholds.level(memory: gib, cpu: readings([10, 200, 200, 200, 200, 200])) == .elevated, "10 s above 150: amber")
        check(MeterThresholds.level(memory: gib, cpu: readings([350, 350, 350, 350, 350])) == .high, "10 s above 300: red")
        check(MeterThresholds.level(memory: gib, cpu: readings([350, 350, 200, 350, 350])) == .elevated, "a dip under 300 resets red, amber holds")
        check(MeterThresholds.level(memory: gib, cpu: readings([200, 200, 200, 200, 200, 20])) == .normal, "newest under: back to normal")
        check(MeterThresholds.level(memory: 6 * gib, cpu: readings([200, 200, 200, 200, 200])) == .high, "worst of the two wins")
        // A gap (window hidden) breaks the run: two 6 s runs 60 s apart are not 12 s sustained.
        var gap = readings([200, 200, 200])
        gap += readings([200, 200, 200]).map { CPUReading(start: $0.start + 60, end: $0.end + 60, percent: $0.percent) }
        check(MeterThresholds.sustained(gap, above: 150) == 6, "gap breaks the run: \(MeterThresholds.sustained(gap, above: 150))")
        check(MeterThresholds.sustained([], above: 150) == 0, "empty")
    }

    static func ring() {
        var r = SampleRing(capacity: 3)
        check(r.normalized(floor: 100).isEmpty, "empty ring")
        r.append(1); r.append(2); r.append(3); r.append(4)
        check(r.values == [2, 3, 4], "keeps the newest: \(r.values)")
        check(r.normalized(floor: 1) == [0.5, 0.75, 1], "scaled to the max")
        check(r.normalized(floor: 8) == [0.25, 0.375, 0.5], "floor keeps an idle line low")
        var z = SampleRing(capacity: 2)
        z.append(0)
        check(z.normalized(floor: 0) == [0], "all zero never divides by zero")
        var neg = SampleRing(capacity: 2)
        neg.append(-5)
        check(neg.normalized(floor: 1) == [0], "clamped at 0")
        check(SampleRing(capacity: 0).capacity == 1, "capacity at least 1")
    }

    static func peaks() {
        var p = Peak()
        let t0 = Date(timeIntervalSince1970: 0), t1 = Date(timeIntervalSince1970: 10)
        p.note(0, at: t0)
        check(p.at == t0, "the first value counts even at zero")
        p.note(5, at: t1)
        p.note(3, at: Date(timeIntervalSince1970: 20))
        check(p.value == 5 && p.at == t1, "keeps the highest and when")
    }

    static func roles() {
        check(ProcessRole.webKit(name: "com.apple.WebKit.WebContent") == .page, "page")
        check(ProcessRole.webKit(name: "com.apple.WebKit.GPU") == .gpu, "gpu")
        check(ProcessRole.webKit(name: "com.apple.WebKit.Networking") == .network, "network")
        check(ProcessRole.webKit(name: "com.apple.WebKit.WebContent.Captive") == .page, "variant names still map")
        check(ProcessRole.webKit(name: "MTLCompilerService") == nil, "other helpers are not WebKit")
        check(ProcessRole.allCases.map(\.rawValue) == ["App", "Page", "GPU", "Network", "Server", "Tools"], "row order (Tools: avconvert, the font tool)")
        check(!ProcessRole.tools.detail.isEmpty, "the tools row says what it is")
    }

    static func report() {
        let utc = TimeZone(identifier: "UTC")!
        let rows = [
            RoleUsage(role: .app, pids: [10], memory: 85 * mib, cpu: 2),
            RoleUsage(role: .page, pids: [11, 12], memory: gib + 400 * mib, cpu: 30.4),
            RoleUsage(role: .server, pids: [], memory: 0, cpu: nil),
        ]
        let text = ResourceReport.text(time: Date(timeIntervalSince1970: 0), rows: rows, totalMemory: gib + 485 * mib, totalCPU: 32.4,
                                       memoryPeak: Peak(value: Double(2 * gib), at: Date(timeIntervalSince1970: 3600)),
                                       cpuPeak: Peak(value: 240, at: Date(timeIntervalSince1970: 7200)),
                                       file: "Home.canvas", os: "Version 27.0", machine: "Apple M4 Pro, 64 GB RAM, 14 cores",
                                       commit: "8c15b1d", uptime: 3725, timeZone: utc)
        check(text.contains("Time: 1970-01-01T00:00:00Z"), "timestamp")
        check(text.contains("Total: 1.5 GB memory, 32% CPU"), "totals: \(text)")
        check(text.contains("Page     1.4 GB   30%    pid 11, 12"), "per-process row")
        check(text.contains("Server   -        -      not found"), "missing process is honest")
        check(text.contains("Peak memory: 2.0 GB at 01:00:00"), "memory peak")
        check(text.contains("Peak CPU: 240% at 02:00:00"), "cpu peak")
        check(text.contains("Measured for: 1 h 2 min"), "uptime")
        check(text.contains("File: Home.canvas") && text.contains("macOS: Version 27.0") && text.contains("Commit: 8c15b1d"), "context lines")
        check(!text.contains("\u{00B7}"), "no middle dots in the report")
        let empty = ResourceReport.text(time: Date(), rows: [], totalMemory: 0, totalCPU: nil, memoryPeak: Peak(), cpuPeak: Peak(),
                                        file: nil, os: "", machine: "", commit: nil, uptime: 5)
        check(empty.contains("n/a CPU") && empty.contains("File: none open") && empty.contains("Commit: unknown") && empty.contains("Peak CPU: n/a"),
              "first moments before a sample")
        check(ResourceReport.uptimeText(59) == "59 s" && ResourceReport.uptimeText(600) == "10 min", "uptime text")
    }

    static func gitHead() {
        let repo = URL(fileURLWithPath: "/r")
        let sha = "8c15b1d0123456789abcdef0123456789abcdef0"
        func files(_ m: [String: String]) -> (URL) -> String? { { m[$0.path] } }
        check(GitHead.read(repo: repo, file: files(["/r/.git/HEAD": "ref: refs/heads/main\n", "/r/.git/refs/heads/main": sha + "\n"])) == "8c15b1d", "loose ref")
        check(GitHead.read(repo: repo, file: files(["/r/.git/HEAD": "ref: refs/heads/main\n",
                                                    "/r/.git/packed-refs": "# pack-refs\n\(sha) refs/heads/main\n"])) == "8c15b1d", "packed ref")
        check(GitHead.read(repo: repo, file: files(["/r/.git/HEAD": sha])) == "8c15b1d", "detached HEAD")
        check(GitHead.read(repo: repo, file: files([:])) == nil, "no repo")
        check(GitHead.read(repo: repo, file: files(["/r/.git/HEAD": "garbage"])) == nil, "not a sha")
    }

    // Hunt 6, finding 17: 10+ busy cores read "1043%", wider than the pill's hidden template, and the toolbar shifted.
    static func pillWidth() {
        check(ResourceFormat.cpuShort(143.6) == "144%", "under 1000 reads as before")
        check(ResourceFormat.cpuShort(999.4) == "999%", "999 still fits")
        check(ResourceFormat.cpuShort(1043) == "999%+", "capped at the template's width: \(ResourceFormat.cpuShort(1043))")
        check(ResourceFormat.cpuShort(.infinity) == "0%" && ResourceFormat.cpuShort(.nan) == "0%", "never a junk value")
        check(ResourceFormat.cpuShort(1e9).count <= "999%+".count, "never wider than the template")
    }

    // Hunt 6, finding 18: a helper's pid reused by an unrelated process within the rediscovery window.
    static func pidReuse() {
        var s = PidStarts()
        check(s.same(42, start: 1000), "first sighting records the start")
        check(s.same(42, start: 1000), "the same process")
        check(!s.same(42, start: 2000), "a new process under the old pid is not ours")
        check(s.same(43, start: 5), "other pids are their own")
    }

    // Hunt 6, finding 19: in a worktree checkout .git is a file pointing at the real git dir.
    static func worktree() {
        let repo = URL(fileURLWithPath: "/w")
        let sha = "1234567aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        func files(_ m: [String: String]) -> (URL) -> String? { { m[$0.path] } }
        let wt = files(["/w/.git": "gitdir: /r/.git/worktrees/w\n", "/r/.git/worktrees/w/HEAD": "ref: refs/heads/feature\n",
                        "/r/.git/worktrees/w/commondir": "../..\n", "/r/.git/refs/heads/feature": sha + "\n"])
        check(GitHead.read(repo: repo, file: wt) == "1234567", "worktree: HEAD in the gitdir, the branch in the main repo: \(String(describing: GitHead.read(repo: repo, file: wt)))")
        let packed = files(["/w/.git": "gitdir: /r/.git/worktrees/w", "/r/.git/worktrees/w/HEAD": "ref: refs/heads/feature",
                            "/r/.git/worktrees/w/commondir": "../..", "/r/.git/packed-refs": "\(sha) refs/heads/feature\n"])
        check(GitHead.read(repo: repo, file: packed) == "1234567", "worktree with a packed branch")
        let detached = files(["/w/.git": "gitdir: ../r/.git/worktrees/w", "/r/.git/worktrees/w/HEAD": sha])
        check(GitHead.read(repo: repo, file: detached) == "1234567", "relative gitdir, detached HEAD")
    }
}
