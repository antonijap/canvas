// Dictation into a comment field (src/page/dictation-logic.js is the other half): the page posts
// {dictation: {op: "start" | "stop" | "cancel", id}} and hears {cmd: "dictation", id, event} back. Speech is
// recognized on the Mac when it can be. When Speech Recognition is not allowed or not available, macOS's own
// Dictation types into the focused field instead.
import AppKit
import AVFoundation
import Speech
import WebKit

final class Dictation {
    static let shared = Dictation()

    private var id: String?
    private weak var page: WKWebView?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// The utterances already closed by a pause: on the Mac the recognizer starts its text over after each.
    private var committed = ""

    private init() {
        NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.stop() }
    }

    func handle(_ message: [String: Any], from page: WKWebView) {
        if let pane = message["settings"] as? String { openSettings(pane); return }
        guard let op = message["op"] as? String, let id = message["id"] as? String, UUID(uuidString: id) != nil else { return }
        switch op {
        case "start": start(id, page)
        case "stop" where id == self.id: stop()
        case "cancel" where id == self.id: tearDown()
        default: break
        }
    }

    private func openSettings(_ pane: String) {
        let key = pane == "microphone" ? "Privacy_Microphone" : "Privacy_SpeechRecognition"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(key)") { NSWorkspace.shared.open(url) }
    }

    private func start(_ id: String, _ page: WKWebView) {
        tearDown()
        self.id = id
        self.page = page
        #if CANVAS_QA
        // A QA build never opens the microphone or asks for permission.
        finish("error", ["message": "Dictation is off in QA builds."])
        #else
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: askMicrophone(id)
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    guard self.id == id else { return }
                    if status == .authorized { self.askMicrophone(id) } else { self.useSystemDictation("denied", ["which": "speech"]) }
                }
            }
        default: useSystemDictation("denied", ["which": "speech"])
        }
        #endif
    }

    private func askMicrophone(_ id: String) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: listen(id)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async {
                    guard self.id == id else { return }
                    if granted { self.listen(id) } else { self.finish("denied", ["which": "microphone"]) }
                }
            }
        default: finish("denied", ["which": "microphone"])
        }
    }

    private func useSystemDictation(_ event: String, _ extra: [String: Any]) {
        guard let page else { tearDown(); return }
        page.window?.makeFirstResponder(page)
        let started = NSApp.sendAction(Selector(("startDictation:")), to: nil, from: nil)
        finish(event, extra.merging(["system": started]) { a, _ in a })
    }

    private func listen(_ id: String) {
        guard let recognizer = SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable else {
            useSystemDictation("system", [:])
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { finish("error", ["message": "No microphone found."]); return }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        self.engine = engine
        self.request = request
        committed = ""
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.id == id else { return }
                if let result {
                    let text = [self.committed, result.bestTranscription.formattedString].filter { !$0.isEmpty }.joined(separator: " ")
                    // An empty last result must not wipe what is in the field.
                    if !text.isEmpty { self.send("text", ["text": text]) }
                    if result.speechRecognitionMetadata != nil { self.committed = text }
                    if result.isFinal { self.finish("end") }
                } else if error != nil {
                    // After a stop an error only says there was nothing more to hear.
                    if self.engine == nil { self.finish("end") } else { self.finish("error", [:]) }
                }
            }
        }
        do {
            engine.prepare()
            try engine.start()
            send("listening")
        } catch {
            finish("error", ["message": "The microphone could not start."])
        }
    }

    /// The microphone goes off at once; the last words still arrive, then "end".
    func stop() {
        guard let id, engine != nil else { return }
        stopAudio()
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            if self?.id == id { self?.finish("end") }
        }
    }

    private func stopAudio() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
    }

    private func finish(_ event: String, _ extra: [String: Any] = [:]) {
        send(event, extra)
        tearDown()
    }

    private func tearDown() {
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
        id = nil
    }

    private func send(_ event: String, _ extra: [String: Any] = [:]) {
        guard let id else { return }
        var m = extra
        m["cmd"] = "dictation"
        m["id"] = id
        m["event"] = event
        guard let data = try? JSONSerialization.data(withJSONObject: m), let json = String(data: data, encoding: .utf8) else { return }
        page?.evaluateJavaScript("window.canvasCmd && window.canvasCmd(\(json))")
    }
}
