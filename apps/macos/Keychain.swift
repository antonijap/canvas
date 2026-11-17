// Writes secrets to the login Keychain through /usr/bin/security. The secret goes to the tool's
// stdin, never argv (argv shows in `ps`), and nothing here logs it. The server reads the same
// item with `security find-generic-password -w`; only the shell ever writes.

import Foundation

enum KeychainStore {
    private static let tool = URL(fileURLWithPath: "/usr/bin/security")

    /// Quotes one argument for `security -i`: single quotes, with backslash before backslash and quote.
    /// Line breaks are dropped, since they would end the command.
    static func quote(_ s: String) -> String {
        let clean = s.filter { $0 != "\n" && $0 != "\r" && $0 != "\0" }
        let esc = clean.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        return "'\(esc)'"
    }

    /// True when the item was written (checked by reading it back without its value).
    @discardableResult
    static func set(service: String, account: String, secret: String) -> Bool {
        // One line only (SecretInput): quote() would otherwise drop the line breaks and store a different secret.
        guard case .ok(let secret) = SecretInput.clean(secret) else { return false }
        let p = Process()
        p.executableURL = tool
        p.arguments = ["-i"]
        let stdin = Pipe()
        p.standardInput = stdin
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        let line = "add-generic-password -U -s \(quote(service)) -a \(quote(account)) -w \(quote(secret))\n"
        stdin.fileHandleForWriting.write(Data(line.utf8))
        try? stdin.fileHandleForWriting.close()
        p.waitUntilExit()
        return p.terminationStatus == 0 && exists(service: service, account: account)
    }

    static func exists(service: String, account: String) -> Bool {
        run(["find-generic-password", "-s", service, "-a", account])
    }

    @discardableResult
    static func delete(service: String, account: String) -> Bool {
        run(["delete-generic-password", "-s", service, "-a", account])
    }

    private static func run(_ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = tool
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}
