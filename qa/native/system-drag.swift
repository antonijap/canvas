// Runner-side window-server drag. Input points use AppKit screen coordinates, independent of backing scale.
import AppKit

struct Point: Decodable { let x: Double; let y: Double }
struct Drag: Decodable {
    let pid: Int32
    let from: Point
    let to: Point
    let mods: [String]
    let steps: Int
    let holdMs: Double
    let dwellMs: Double
}
struct Click: Decodable {
    let mode: String
    let pid: Int32
    let at: Point
    let count: Int
}
struct Hover: Decodable {
    let mode: String
    let pid: Int32
    let at: Point
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

// TCC assigns input permission to the responsible app in the runner's ancestry, usually its terminal or editor.
func runnerApp() -> String {
    var pid = getppid()
    var launcher = "runner process \(pid)"
    var seen = Set<Int32>()
    while pid > 1 && seen.insert(pid).inserted {
        let ps = Process(), pipe = Pipe()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-p", String(pid), "-o", "ppid=,comm="]
        ps.standardOutput = pipe
        do { try ps.run() } catch { break }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        ps.waitUntilExit()
        let row = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let fields = row.split(maxSplits: 1, whereSeparator: { $0.isWhitespace })
        guard fields.count == 2, let parent = Int32(fields[0]) else { break }
        let command = String(fields[1])
        if pid == getppid() { launcher = command }
        if let end = command.range(of: ".app/") {
            let app = String(command[..<end.lowerBound]) + ".app"
            return "\(URL(fileURLWithPath: app).lastPathComponent) (\(app))"
        }
        pid = parent
    }
    return launcher
}

guard CommandLine.arguments.count == 2 else { fail("Invalid system mouse input") }
let data = Data(CommandLine.arguments[1].utf8)
let click = try? JSONDecoder().decode(Click.self, from: data)
let drag = try? JSONDecoder().decode(Drag.self, from: data)
let hover = (try? JSONDecoder().decode(Hover.self, from: data)).flatMap { $0.mode == "hover" ? $0 : nil }
if let click {
    guard click.mode == "click", (1...2).contains(click.count), click.at.x.isFinite, click.at.y.isFinite else { fail("Invalid system click input") }
} else if let hover {
    guard hover.at.x.isFinite, hover.at.y.isFinite else { fail("Invalid system hover input") }
} else if let drag {
    guard drag.steps >= 2, drag.steps <= 1000,
          [drag.from.x, drag.from.y, drag.to.x, drag.to.y, drag.holdMs, drag.dwellMs].allSatisfy({ $0.isFinite }),
          drag.holdMs >= 0, drag.dwellMs >= 0, drag.holdMs + drag.dwellMs + Double(drag.steps) * 16 <= 25_000 else { fail("Invalid system drag input") }
} else {
    fail("Invalid system mouse input")
}
guard CGPreflightPostEventAccess() else {
    fail("System mouse input requires Accessibility for \(runnerApp()). Enable it in System Settings > Privacy & Security > Accessibility, then restart that app and rerun. No input was posted.", code: 77)
}
guard let pid = click?.pid ?? hover?.pid ?? drag?.pid,
      let app = NSRunningApplication(processIdentifier: pid) else { fail("The QA app is no longer running") }
let previousApp = NSWorkspace.shared.frontmostApplication
let previousPointer = CGEvent(source: nil)?.location
let source = CGEventSource(stateID: .hidSystemState)
let top = CGDisplayBounds(CGMainDisplayID()).maxY
let from = click?.at ?? hover?.at ?? drag!.from, to = click?.at ?? hover?.at ?? drag!.to
let start = CGPoint(x: from.x, y: top - from.y)
let end = CGPoint(x: to.x, y: top - to.y)
var flags: CGEventFlags = []
for mod in drag?.mods ?? [] {
    switch mod {
    case "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt": flags.insert(.maskAlternate)
    case "ctrl": flags.insert(.maskControl)
    default: fail("Unknown drag modifier: \(mod)")
    }
}
func send(_ type: CGEventType, _ point: CGPoint, clicks: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
        fail("Could not create system drag event")
    }
    event.flags = flags
    event.setIntegerValueField(.mouseEventClickState, value: clicks)
    event.post(tap: .cghidEventTap)
}
func pause(_ ms: Double) { Thread.sleep(forTimeInterval: ms / 1000) }
app.activate(options: [])
pause(150)
// A person's pointer arrives before it presses: hover handlers run first, as they do for a real hand.
send(.mouseMoved, start)
pause(250)
if hover != nil {
    FileHandle.standardOutput.write(Data("ready\n".utf8))
    // Closing stdin releases the pointer. Restore it even if the runner stalls.
    var input = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
    _ = poll(&input, 1, 20_000)
} else if let click {
    // Both halves carry the count. Keep the second press within the user's double-click interval.
    let interval = min(100, NSEvent.doubleClickInterval * 1000 / 3)
    for count in 1...click.count {
        send(.leftMouseDown, start, clicks: Int64(count))
        pause(min(30, interval / 2))
        send(.leftMouseUp, start, clicks: Int64(count))
        if count < click.count { pause(interval) }
    }
} else if let drag {
    send(.leftMouseDown, start)
    pause(drag.holdMs)
    for step in 1...drag.steps {
        let t = Double(step) / Double(drag.steps)
        send(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t))
        pause(16)
    }
    pause(drag.dwellMs)
    send(.leftMouseUp, end)
}
pause(150)
if let previousPointer { CGWarpMouseCursorPosition(previousPointer) }
previousApp?.activate(options: [])
