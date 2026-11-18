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

guard CommandLine.arguments.count == 2,
      let drag = try? JSONDecoder().decode(Drag.self, from: Data(CommandLine.arguments[1].utf8)),
      drag.steps >= 2, drag.steps <= 1000,
      [drag.from.x, drag.from.y, drag.to.x, drag.to.y, drag.holdMs, drag.dwellMs].allSatisfy({ $0.isFinite }),
      drag.holdMs >= 0, drag.dwellMs >= 0, drag.holdMs + drag.dwellMs + Double(drag.steps) * 16 <= 25_000 else {
    fail("Invalid system drag input")
}
guard CGPreflightPostEventAccess() else {
    fail("System drag requires Accessibility for \(runnerApp()). Enable it in System Settings > Privacy & Security > Accessibility, then restart that app and rerun. No input was posted.", code: 77)
}
guard let app = NSRunningApplication(processIdentifier: drag.pid) else { fail("The QA app is no longer running") }
let previousApp = NSWorkspace.shared.frontmostApplication
let previousPointer = CGEvent(source: nil)?.location
let source = CGEventSource(stateID: .hidSystemState)
let top = CGDisplayBounds(CGMainDisplayID()).maxY
let start = CGPoint(x: drag.from.x, y: top - drag.from.y)
let end = CGPoint(x: drag.to.x, y: top - drag.to.y)
var flags: CGEventFlags = []
for mod in drag.mods {
    switch mod {
    case "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt": flags.insert(.maskAlternate)
    case "ctrl": flags.insert(.maskControl)
    default: fail("Unknown drag modifier: \(mod)")
    }
}
func send(_ type: CGEventType, _ point: CGPoint) {
    guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
        fail("Could not create system drag event")
    }
    event.flags = flags
    event.setIntegerValueField(.mouseEventClickState, value: 1)
    event.post(tap: .cghidEventTap)
}
func pause(_ ms: Double) { Thread.sleep(forTimeInterval: ms / 1000) }
app.activate(options: [])
pause(150)
send(.mouseMoved, start)
send(.leftMouseDown, start)
pause(drag.holdMs)
for step in 1...drag.steps {
    let t = Double(step) / Double(drag.steps)
    send(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t))
    pause(16)
}
pause(drag.dwellMs)
send(.leftMouseUp, end)
pause(150)
if let previousPointer { CGWarpMouseCursorPosition(previousPointer) }
previousApp?.activate(options: [])
