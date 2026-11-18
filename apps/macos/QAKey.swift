// Key events shared by qa.key and qa.type. No application or window is needed to construct them.
import AppKit

enum QAKey {
    /// Virtual key codes for named keys (US layout); letters and digits come from the layout table below.
    static let named: [String: (UInt16, String)] = [
        "Return": (36, "\r"), "Enter": (36, "\r"), "Tab": (48, "\t"), "Space": (49, " "), "Delete": (51, "\u{7F}"),
        "Backspace": (51, "\u{7F}"), "Escape": (53, "\u{1B}"), "ForwardDelete": (117, "\u{F728}"),
        "Left": (123, "\u{F702}"), "Right": (124, "\u{F703}"), "Down": (125, "\u{F701}"), "Up": (126, "\u{F700}"),
        "ArrowLeft": (123, "\u{F702}"), "ArrowRight": (124, "\u{F703}"), "ArrowDown": (125, "\u{F701}"), "ArrowUp": (126, "\u{F700}"),
        "Home": (115, "\u{F729}"), "End": (119, "\u{F72B}"), "PageUp": (116, "\u{F72C}"), "PageDown": (121, "\u{F72D}"),
    ]
    static let layout: [Character: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
        "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
        "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
        "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
    ]
    static let shifted: [Character: Character] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=",
        "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
    ]

    static func events(_ name: String, _ f: NSEvent.ModifierFlags = [], windowNumber: Int = 0, location: NSPoint = .zero) -> [NSEvent] {
        var code: UInt16 = 0, chars = name, plain = name, f = f
        // Named commands accept any case; single-character input keeps its original case and Shift.
        if let (c, s) = named.first(where: { $0.key.lowercased() == name.lowercased() })?.value { code = c; chars = s; plain = s }
        else if let ch = name.first, name.count == 1 {
            var base = Character(ch.lowercased())
            if let s = shifted[ch] { base = s; f.insert(.shift) } else if ch.isUppercase { f.insert(.shift) }
            code = layout[base] ?? 0
            // As the hardware does: Shift still shapes the characters under Command (Shift+Cmd+L reads "L"), so the menus
            // match a Shift chord the way they do for a person.
            plain = f.contains(.shift) && base.isLetter ? base.uppercased() : String(base)
            // Shift+[ and Shift+] read "{" and "}" on the hardware, so they never match Cmd+[ and Cmd+] (Bring Forward).
            if f.contains(.shift), base == "[" || base == "]" { plain = base == "[" ? "{" : "}" }
            chars = f.contains(.command) || f.contains(.control) ? plain : String(ch)
        }
        if [123, 124, 125, 126].contains(code) { f.insert([.numericPad, .function]) }
        if [115, 116, 117, 119, 121].contains(code) { f.insert(.function) }
        let t = ProcessInfo.processInfo.systemUptime
        let make = { (type: NSEvent.EventType) in
            NSEvent.keyEvent(with: type, location: location, modifierFlags: f, timestamp: t, windowNumber: windowNumber, context: nil,
                             characters: chars, charactersIgnoringModifiers: plain, isARepeat: false, keyCode: code)
        }
        return [make(.keyDown), make(.keyUp)].compactMap { $0 }
    }

}
