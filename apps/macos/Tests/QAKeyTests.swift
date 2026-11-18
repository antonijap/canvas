// Run: swiftc -parse-as-library QAKey.swift Tests/QAKeyTests.swift -o /tmp/qa-key-tests && /tmp/qa-key-tests
import AppKit

@main
struct QAKeyTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ message: String) {
        checks += 1
        if !ok { failures += 1; print("FAIL: \(message)") }
    }

    static func main() {
        let enter = QAKey.events("return").first
        check(enter?.keyCode == 36, "lowercase return uses the Return hardware code")
        check(enter?.characters == "\r" && enter?.charactersIgnoringModifiers == "\r", "lowercase return sends a newline command")
        check(enter?.modifierFlags.isEmpty == true, "plain Return adds no modifiers")
        for (name, (code, characters)) in QAKey.named {
            for spelling in [name, name.lowercased(), name.uppercased()] {
                let events = QAKey.events(spelling, [.command], windowNumber: 7, location: NSPoint(x: 3, y: 4))
                check(events.count == 2, "\(spelling) produces down and up")
                for (event, type) in zip(events, [NSEvent.EventType.keyDown, .keyUp]) {
                    check(event.type == type, "\(spelling) event type")
                    check(event.keyCode == code, "\(spelling) key code: expected \(code), got \(event.keyCode)")
                    check(event.characters == characters, "\(spelling) characters")
                    check(event.charactersIgnoringModifiers == characters, "\(spelling) characters ignoring modifiers")
                    check(event.modifierFlags.contains(.command), "\(spelling) keeps modifiers")
                    check(event.windowNumber == 7 && event.locationInWindow == NSPoint(x: 3, y: 4), "\(spelling) keeps its target")
                }
            }
        }
        check(QAKey.events("a").first?.keyCode == 0, "a keeps its hardware code")
        check(QAKey.events("A").first?.characters == "A", "uppercase text stays uppercase")
        check(QAKey.events("A").first?.modifierFlags.contains(.shift) == true, "uppercase text keeps Shift")
        check(QAKey.events("!").first?.keyCode == 18, "shifted punctuation keeps its hardware code")
        check(QAKey.events("!", [.command]).first?.characters == "1", "command chord keeps the base character")
        print("\(failures) failures in \(checks) checks")
        exit(failures == 0 ? 0 : 1)
    }
}
