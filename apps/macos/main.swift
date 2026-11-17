// Canvas.app: a thin native shell around the local studio server. The page is the app;
// the shell is the window, the dock icon and a server that is always up.

import AppKit
import WebKit
import SwiftUI
import Combine

let port = Int(ProcessInfo.processInfo.environment["CANVAS_PORT"] ?? "") ?? 5189
// CANVAS_SERVER, else the server inside the app (a release: Contents/Resources/server, see scripts/release-app.sh),
// else the checkout `pnpm app` built this app from (Info.plist CanvasRepo), else ~/Code/canvas.
let bundledServer = Bundle.main.resourceURL.map { $0.appendingPathComponent("server/src/server.ts").path }
  .flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil }
let serverScript = ProcessInfo.processInfo.environment["CANVAS_SERVER"]
  ?? bundledServer
  ?? (Bundle.main.object(forInfoDictionaryKey: "CanvasRepo") as? String).map { $0 + "/src/server.ts" }.flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil }
  ?? NSHomeDirectory() + "/Code/canvas/src/server.ts"
let base = URL(string: "http://127.0.0.1:\(port)")!

func serverUp() -> Bool {
  var req = URLRequest(url: base.appendingPathComponent("health"))
  req.timeoutInterval = 0.6
  var ok = false
  let sem = DispatchSemaphore(value: 0)
  URLSession.shared.dataTask(with: req) { _, response, _ in
    ok = (response as? HTTPURLResponse)?.statusCode == 200
    sem.signal()
  }.resume()
  sem.wait()
  return ok
}

let serverLock = NSLock()
var serverProc: Process?
/// Starts that did not bring the server up, in a row. After a few, the window says why instead of retrying silently.
var serverFailures = 0
var serverProblemShown = false
/// The server's output, for when it will not start (Finder launches have no terminal to print to).
let serverLog: URL = {
  let dir = ProcessInfo.processInfo.environment["CANVAS_LOG_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Canvas", isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir.appendingPathComponent("server.log")
}()

/// Says once, in the window, why the server is not up.
func reportServerProblem(_ text: String) {
  NSLog("canvas: \(text)")
  DispatchQueue.main.async {
    guard !serverProblemShown else { return }
    serverProblemShown = true
    MainActor.assumeIsolated { model.flash(text, durationMs: 15000) }
  }
}

func startServer() {
  serverLock.lock()
  defer { serverLock.unlock() }
  if let p = serverProc, p.isRunning { return }
  // Finder starts apps with PATH=/usr/bin:/bin, where `env node` finds nothing: look node up directly.
  let bundledNode = Bundle.main.resourceURL.map { $0.appendingPathComponent("node/bin/node").path }
  guard let node = NodeLocator.find(env: ProcessInfo.processInfo.environment, home: NSHomeDirectory(), bundled: bundledNode,
                                    isExecutable: { FileManager.default.isExecutableFile(atPath: $0) }) else {
    reportServerProblem("Canvas could not find Node to start its server. Install Node 24 with mise, or set CANVAS_NODE.")
    return
  }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: node)
  p.arguments = [serverScript]
  p.standardOutput = FileHandle.nullDevice
  if !FileManager.default.fileExists(atPath: serverLog.path) { FileManager.default.createFile(atPath: serverLog.path, contents: nil) }
  if let log = try? FileHandle(forWritingTo: serverLog) { log.seekToEndOfFile(); p.standardError = log } else { p.standardError = FileHandle.nullDevice }
  do {
    try p.run()
    serverProc = p
  } catch {
    reportServerProblem("Canvas could not start its server (\(node)): \(error.localizedDescription)")
  }
}

/// Starts the server when it is down, and counts the starts that did not take.
func keepServerUp() {
  if stoppingServer { return } // a quit is stopping it to install an update
  if serverUp() { serverFailures = 0; return }
  startServer()
  serverFailures += 1
  if serverFailures >= 3 { reportServerProblem("Canvas\u{2019}s server will not start. Details in ~/Library/Logs/Canvas/server.log.") }
}

/// The symbols the canvas page draws as masks (src/agent-run.ts serves them), drawn here from the Mac's own symbols
/// into <state dir>/symbols: the repo ships no Apple artwork. Black on transparent, 144 px, written when missing or
/// changed (a new macOS may draw a symbol differently).
let pageSymbols = ["arrow.down", "arrow.up", "checkmark", "chevron.down", "circle", "command", "return", "sparkles.2", "square.dashed", "stop", "terminal"]
func writeSymbols() {
  let state = ProcessInfo.processInfo.environment["CANVAS_STATE_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/Canvas"
  let dir = URL(fileURLWithPath: state).appendingPathComponent("symbols", isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let side = 144
  for name in pageSymbols {
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil),
          let img = base.withSymbolConfiguration(.init(pointSize: 96, weight: .medium)),
          let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
    rep.size = NSSize(width: side, height: side)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = img.size, k = min(CGFloat(side) / max(s.width, 1), CGFloat(side) / max(s.height, 1))
    let w = s.width * k, h = s.height * k
    img.draw(in: NSRect(x: (CGFloat(side) - w) / 2, y: (CGFloat(side) - h) / 2, width: w, height: h))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { continue }
    let url = dir.appendingPathComponent(name + ".png")
    if (try? Data(contentsOf: url)) != png { try? png.write(to: url, options: .atomic) }
  }
}
writeSymbols()

/// This build's version and commit (Info.plist; build.sh writes CanvasCommit from git).
let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
let appCommit = Bundle.main.object(forInfoDictionaryKey: "CanvasCommit") as? String
func reportURL() -> URL {
  #if arch(arm64)
  let arch = "arm64"
  #else
  let arch = "x86_64"
  #endif
  return ReleaseLinks.report(version: appVersion, build: appCommit, os: ProcessInfo.processInfo.operatingSystemVersion, arch: arch)
}

// QA builds and runs with CANVAS_NO_UPDATE_CHECK never ask.
#if CANVAS_QA
let isQABuild = true
#else
let isQABuild = false
#endif
/// A release build updates itself (Updater.swift): the server inside the app, not a QA build, not pointed at a checkout.
let isReleaseBuild = bundledServer != nil && serverScript == bundledServer && !isQABuild

// Keep the server up for as long as the window exists; it idles out after 30 quiet minutes.
Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
  DispatchQueue.global(qos: .utility).async { keepServerUp() }
}

let config = WKWebViewConfiguration()
config.websiteDataStore = .default() // the camera position per file lives in localStorage

let model = CanvasModel(configuration: config, base: base)
// Updates: the release manifest at launch and every 6 hours, release builds only (Updater.swift).
MainActor.assumeIsolated {
  Updater.shared.setup(model: model, base: base, release: isReleaseBuild)
  Updater.shared.start()
}

let window = NSWindow(
  contentRect: NSRect(x: 0, y: 0, width: 1560, height: 980),
  styleMask: [.titled, .closable, .miniaturizable, .resizable],
  backing: .buffered,
  defer: false
)
window.title = "Canvas"
// Closing the window hides it; the Dock icon and Window > Canvas bring the same one back.
window.isReleasedWhenClosed = false
window.titleVisibility = .hidden
window.titlebarAppearsTransparent = true
window.styleMask.insert(.fullSizeContentView)
// A unified (empty) toolbar makes the titlebar strip 52 pt tall instead of 32: the traffic lights sit on the top
// pill's midline, 30 pt down, which is below a 32 pt strip, so macOS kept them at its default spot over the pill.
window.toolbar = NSToolbar(identifier: "canvas.titlebar")
window.toolbarStyle = .unified
window.titleVisibility = .hidden
window.isMovableByWindowBackground = false
window.contentView = NSHostingView(rootView: RootView(model: model))
window.setFrameAutosaveName("CanvasMain")

// Finder double-clicks and drops on the Dock icon arrive here as file URLs. On a cold start the server is not up
// yet: the file waits in `pendingFinderFile` and opens once it is (instead of a refused load and a blank window).
var openedFromFinder = false
var serverReady = false
var pendingFinderFile: String?
class AppDelegate: NSObject, NSApplicationDelegate {
  func application(_ application: NSApplication, open urls: [URL]) {
    // A canvas:// link (Edit > Copy Link, pasted into an agent's chat and clicked): its file, page and nodes.
    if let url = urls.first(where: { $0.scheme?.lowercased() == "canvas" }) { openCanvasLink(url); return }
    guard let url = urls.first(where: { $0.isFileURL }) else { return }
    openedFromFinder = true
    if serverReady { model.open(url.path) } else { pendingFinderFile = url.path }
    window.makeKeyAndOrderFront(nil)
  }
  // A click on the Dock icon with the window closed brings it back.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { showMainWindow() }
    return true
  }
  // Quit waits for the text being typed on the canvas (the page writes it first) and the inspector's queued
  // writes: an edit that exists only in the page's editor or the shell's queue would be lost. A write that fails
  // (or a server that does not answer) keeps the app open, with the edit still on screen. With every edit saved and
  // an update ready, the updater stops the server and starts its helper before the app goes (Updater.beforeQuit).
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    // The shown file is photographed for its card on Home (a second at most), then the saves below.
    var photographed = false
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { if !photographed { photographed = true; self.finishQuit() } }
    model.snapshotShown { if !photographed { photographed = true; self.finishQuit() } }
    return .terminateLater
  }
  func finishQuit() {
    model.flushTextEdit { textOK in
      let finish = { (ok: Bool) in
        if !ok { model.flash("Canvas could not save the last change, so it stayed open. Try again, or quit once more to discard it.") }
        if ok {
          MainActor.assumeIsolated { Updater.shared.beforeQuit { go in NSApp.reply(toApplicationShouldTerminate: go) } }
        } else {
          if !quitAnyway { MainActor.assumeIsolated { Updater.shared.quitCancelled() } }
          NSApp.reply(toApplicationShouldTerminate: quitAnyway)
        }
        quitAnyway = !ok
      }
      if model.writesIdle { finish(textOK); return }
      model.drainWrites { ok in finish(ok && textOK) }
    }
  }
  // A normal quit clears the running marker (RunMarker): found set at the next launch, it counts one crash.
  func applicationWillTerminate(_ notification: Notification) { RunMarker.quit(.standard) }
}
/// A second Quit after a failed save quits without waiting again.
var quitAnyway = false
/// A link that arrived before the server was up: opened once it is, like a Finder file.
var pendingLink: CanvasLink?
func openCanvasLink(_ url: URL) {
  guard let link = CanvasLink.parse(url) else { model.flash("That Canvas link is not one Canvas can open"); return }
  guard FileManager.default.fileExists(atPath: link.file) else {
    model.flash("Canvas cannot find \(URL(fileURLWithPath: link.file).lastPathComponent): it was moved, renamed or deleted")
    return
  }
  openedFromFinder = true // the remembered file must not open over it
  if serverReady { model.openLink(link) } else { pendingLink = link }
  showMainWindow()
}
func showMainWindow() {
  if window.isMiniaturized { window.deminiaturize(nil) }
  window.makeKeyAndOrderFront(nil)
}
let appDelegate = AppDelegate()
/// Whether the last run ended without quitting (RunMarker): counted once the server is up.
let lastRunCrashed = RunMarker.launch(.standard)
let app = NSApplication.shared
app.delegate = appDelegate
app.setActivationPolicy(.regular)

class FileActions: NSObject, NSMenuItemValidation {
  @objc func reloadPage(_ s: Any?) { model.reloadPage() }
  @objc func newCanvas(_ s: Any?) { model.newCanvas() }
  @objc func openDocument(_ s: Any?) { model.openDocument() }
  @objc func saveAsCanvas(_ s: Any?) { model.saveAsCanvas() }
  /// File > Share Comments to Server...: the open file's comments go to the team server set in Settings > Cloud.
  @objc func shareComments(_ s: Any?) { MainActor.assumeIsolated { CloudAccount.shared.shareOpenFile(model) } }
  /// File > Export (Shift+Cmd+E): the selection, else every layer on the page with export settings (Library.swift).
  @objc func exportSettings(_ s: Any?) { model.exportSelectionWithSettings() }
  /// Cmd+W: closes the file's tab, not the window. With no tab open it closes the window.
  @objc func closeTab(_ s: Any?) {
    if keyWindowNow !== window { keyWindowNow.performClose(nil); return }
    // Home is pinned: Cmd+W with Home showing closes nothing (the file tabs under it stay as they are).
    if model.homeShown { if model.openFiles.isEmpty { window.performClose(nil) }; return }
    if let f = model.currentFile { model.close(f) } else { window.performClose(nil) }
  }
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(exportSettings(_:)) || item.action == #selector(shareComments(_:)) { return model.currentFile != nil }
    return true
  }
}
let fileActions = FileActions()

// Edit: Undo/Redo walk the document's history on the server (src/history.ts), named after the step
// ("Undo Fill Change"). A native text field with focus keeps its own undo; the page decides the same for its
// own text fields. Cut/Copy/Paste/Select All go down the responder chain as usual.
/// The window keys go to: a popover (colour picker, token search, snapping) when one is open, else the main window.
var keyWindowNow: NSWindow { NSApp.keyWindow ?? window }
/// The page has keyboard focus: the main window is key and its first responder sits in the web view.
var webHasFocus: Bool {
  keyWindowNow === window && ((window.firstResponder as? NSView)?.isDescendant(of: model.webView) ?? false)
}
/// The menu is being asked about a key press that holds Shift (AppKit also tries Shift chords on items without Shift).
var shiftedKey: Bool { NSApp.currentEvent.map { $0.type == .keyDown && $0.modifierFlags.contains(.shift) } ?? false }
final class EditActions: NSObject, NSMenuItemValidation {
  /// The editable native text view with focus (a field editor) in the key window, popovers included.
  private var textView: NSTextView? {
    guard let tv = keyWindowNow.firstResponder as? NSTextView, tv.isEditable else { return nil }
    return tv
  }
  /// The field's own undo, when it has a step that way; a field with nothing to undo lets the document's through.
  private func textUndo(_ undo: Bool) -> UndoManager? {
    guard let um = textView?.undoManager else { return nil }
    return UndoRouting.fieldTakes(hasField: true, canStep: undo ? um.canUndo : um.canRedo) ? um : nil
  }
  @objc func undo(_ s: Any?) { step("undo") }
  @objc func redo(_ s: Any?) { step("redo") }
  /// Edit > Repeat: the last property edit on the layers selected now (src/repeat.ts). Inspector writes on their way
  /// land first, so the repeat is of the edit just made. The "." key itself is the page's (src/page/shortcuts.js).
  @objc func repeatLast(_ s: Any?) {
    let gen = model.docGeneration, file = model.currentFile
    model.afterWrites {
      guard model.docGeneration == gen, model.currentFile == file else { return }
      model.run("{cmd:'shortcut',op:'repeat'}")
    }
  }
  /// Edit > Copy Link (Cmd+L): the page builds the canvas:// link (src/page/link.js) and posts it back as
  /// {clipboard, toast}. The key is the menu's in the app; the page handles Cmd+L itself only in a browser.
  @objc func copyLink(_ s: Any?) { model.run("{cmd:'copyLink'}") }
  /// Edit > Copy as PNG (Shift+Cmd+C): the selection as a 2x PNG on the pasteboard (Library.swift copyAs).
  @objc func copyPNG(_ s: Any?) {
    guard let sel = model.selection else { return }
    model.copyAs("png", ids: sel.ids.isEmpty ? [sel.id] : sel.ids)
  }
  /// Edit > Find and Replace (Cmd+F): the page's find bar (src/page/find-replace.js).
  @objc func findReplace(_ s: Any?) { model.run("{cmd:'findReplace'}") }
  private func step(_ dir: String) {
    if let um = textUndo(dir == "undo") { dir == "undo" ? um.undo() : um.redo(); return }
    let web = webHasFocus
    // An inspector write still on its way lands first: undo must not overtake the edit it should undo. If another
    // document opened meanwhile, the step belonged to the old one: it is dropped, never applied to the new one.
    let gen = model.docGeneration, file = model.currentFile
    model.afterWrites {
      guard model.docGeneration == gen, model.currentFile == file else { return }
      model.run("{cmd:'\(dir)',web:\(web)}")
    }
  }
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    // AppKit falls back to an item without Shift when the Shift chord's own item declines the key (Lock on
    // Shift+Cmd+L is the page's): Shift+Cmd+L must not copy a link.
    if item.action == #selector(copyLink(_:)) { return model.currentFile != nil && !shiftedKey }
    if item.action == #selector(copyPNG(_:)) { return model.selection != nil && !model.textEditing && !(keyWindowNow.firstResponder is NSText) }
    if item.action == #selector(findReplace(_:)) { return model.currentFile != nil && !shiftedKey }
    if item.action == #selector(repeatLast(_:)) {
      item.title = RepeatHint.title(model.repeatLabel)
      // "." typed anywhere is a key, not this item: the page handles it on the canvas, a text field types it.
      if NSApp.currentEvent?.type == .keyDown { return false }
      return model.repeatLabel != nil && model.selection != nil && !model.textEditing && !(keyWindowNow.firstResponder is NSText)
    }
    let isUndo = item.action == #selector(undo(_:))
    if let um = textUndo(isUndo) {
      item.title = isUndo ? um.undoMenuItemTitle : um.redoMenuItemTitle
      return true
    }
    // Text being edited on the canvas: the page steps through its typing (host.textEdit.step).
    if model.textEditing {
      item.title = isUndo ? "Undo Typing" : "Redo Typing"
      return true
    }
    let label = isUndo ? model.undoLabel : model.redoLabel
    item.title = (isUndo ? "Undo" : "Redo") + (label.map { " \($0)" } ?? "")
    // A page text field may have its own undo even when the document has none.
    return label != nil || webHasFocus
  }
}
let editActions = EditActions()
extension NSPasteboard.PasteboardType {
  /// Copied layers and cards as JSON (src/structure.ts payload). The plain text beside it holds only their names.
  static let canvasClipboard = NSPasteboard.PasteboardType("cc.getcanvas.canvas.clipboard")
}
/// What a paste hands the page: Canvas's own payload when the pasteboard has one, else its plain text.
/// (canvasPasteboard, Model.swift: the general pasteboard; a QA instance's own one, so QA never touches the person's.)
func canvasClipboardText() -> String {
  let pb = canvasPasteboard
  return pb.string(forType: .canvasClipboard) ?? pb.string(forType: .string) ?? ""
}
// Structure (src/page/structure.js): Cut/Copy/Paste/Select All act on the canvas selection, except while a text
// field is being typed in (a native one, or one on the page: the web view then does its own). Duplicate, Delete,
// Group and Arrange go to the page as {cmd: "structure"}; the page posts copied layers back as {clipboard}.
/// The page command that pastes the picture on the pasteboard (canvasPasteboard: the general one, a private one in a
/// QA instance) as an image layer, or nil when Cmd+V pastes
/// layers or text as before (`PasteImage.choose` decides). The bytes travel as base64; at most 50 MB.
func pastedImageCommand() -> String? {
  guard let img = pasteboardImage() else { return nil }
  return "{cmd:'pasteImage',type:\(jsString(img.type)),name:\(jsString(img.name)),data:'\(img.data.base64EncodedString())'}"
}

/// The picture on the pasteboard (an image file copied in Finder, a PNG or a TIFF), at most 50 MB, or nil.
func pasteboardImage() -> (data: Data, name: String, type: String)? {
  let pb = canvasPasteboard
  let urls = (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
  guard let src = PasteImage.choose(string: pb.string(forType: .string), fileURLs: urls, hasPNG: pb.data(forType: .png) != nil, hasTIFF: pb.data(forType: .tiff) != nil) else { return nil }
  var data: Data?
  var name = "Pasted image.png", type = "image/png"
  switch src {
  case .file(let u):
    data = try? Data(contentsOf: u)
    name = u.lastPathComponent
    type = PasteImage.mime(u.pathExtension)
  case .png:
    data = pb.data(forType: .png)
  case .tiff:
    data = pb.data(forType: .tiff).flatMap { NSBitmapImageRep(data: $0) }.flatMap { $0.representation(using: .png, properties: [:]) }
  }
  guard let d = data, !d.isEmpty, d.count <= 50 * 1024 * 1024 else { return nil }
  return (d, name, type)
}

/// QA builds: the files Place Image takes instead of showing the open panel (QA.swift qa.choose). Nil: the panel.
nonisolated(unsafe) var qaChosenFiles: [String]? = nil

/// The page command that places image files (Place Image): at most 20 images of at most 50 MB each, as base64.
func placeImagesCommand(_ urls: [URL]) -> String? {
  var parts: [String] = []
  for u in urls.prefix(20) where PasteImage.imageExtensions.contains(u.pathExtension.lowercased()) {
    guard let d = try? Data(contentsOf: u), !d.isEmpty, d.count <= 50 * 1024 * 1024 else { continue }
    parts.append("{name:\(jsString(u.lastPathComponent)),type:\(jsString(PasteImage.mime(u.pathExtension))),data:'\(d.base64EncodedString())'}")
  }
  return parts.isEmpty ? nil : "{cmd:'placeImages',files:[\(parts.joined(separator: ","))]}"
}

final class StructureActions: NSObject, NSMenuItemValidation {
  /// A native text field with focus in the key window: a popover's field (colour picker, token or font search,
  /// Big nudge) owns Cut/Copy/Paste/Select All while it is being typed in, not the canvas behind it.
  private var nativeText: NSText? { keyWindowNow.firstResponder as? NSText }
  private var webFocused: Bool { webHasFocus }
  /// Another window (a popover, a sheet) is key with no text field in it: the canvas is not what the user is in.
  private var otherWindowKey: Bool { keyWindowNow !== window }
  /// A fill, stroke or effect row picked in the inspector (InspectorPaint.swift) takes Cut, Copy and Paste while no
  /// text field is being typed in; with none picked they go to the canvas.
  private var paintRowTakes: Bool { model.paintRowNow != nil && nativeText == nil && !otherWindowKey && !model.textEditing }
  @objc func cut(_ s: Any?) {
    if paintRowTakes, model.copyPaintRow() { _ = model.deletePaintRow(); return }
    clip(#selector(NSText.cut(_:)), "cut")
  }
  @objc func copy(_ s: Any?) {
    if paintRowTakes, model.copyPaintRow() { return }
    clip(#selector(NSText.copy(_:)), "copy")
  }
  @objc func paste(_ s: Any?) {
    if paintRowTakes, model.pastePaintRow(image: { pasteboardImage().map { ($0.data, $0.name) } }) { return }
    clip(#selector(NSText.paste(_:)), "paste")
  }
  @objc func pasteInPlace(_ s: Any?) { clip(#selector(NSText.paste(_:)), "paste", inPlace: true) }
  /// Paste to replace (Shift+Cmd+R): the selected layers give way to Canvas's copied layers.
  @objc func pasteReplace(_ s: Any?) {
    if nativeText != nil || otherWindowKey || model.textEditing { NSSound.beep(); return }
    model.run("{cmd:'paste',replace:true,inPlace:false,text:\(jsString(canvasClipboardText()))}")
  }
  /// Place image (Shift+Cmd+K): the open panel for images; the page places them (src/page/drops.js).
  @objc func placeImage(_ s: Any?) {
    let urls: [URL]
    if let qa = qaChosenFiles {
      // A QA build's stand-in for the panel (qa.choose): the files the scenario named, once.
      qaChosenFiles = nil
      urls = qa.map { URL(fileURLWithPath: $0) }
    } else {
      let panel = NSOpenPanel()
      panel.title = "Place Image"
      panel.prompt = "Place"
      panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .svg]
      panel.allowsMultipleSelection = true
      panel.canChooseDirectories = false
      guard panel.runModal() == .OK else { return }
      urls = panel.urls
    }
    if let js = placeImagesCommand(urls) { model.run(js) }
  }
  /// The right-click menu's Paste here: the point it was opened at (page px) rides on the item.
  @objc func pasteHere(_ s: Any?) {
    guard let p = (s as? NSMenuItem)?.representedObject as? NSValue else { paste(s); return }
    let at = p.pointValue
    let text = jsString(canvasClipboardText())
    model.run("{cmd:'paste',inPlace:false,text:\(text),at:{x:\(at.x),y:\(at.y)}}")
  }
  @objc func selectAll(_ s: Any?) { clip(#selector(NSText.selectAll(_:)), "selectAll") }
  private func clip(_ action: Selector, _ cmd: String, inPlace: Bool = false) {
    if let t = nativeText { NSApp.sendAction(action, to: t, from: nil); return }
    if otherWindowKey { NSApp.sendAction(action, to: nil, from: nil); return }
    let send = {
      // A picture on the pasteboard (a screenshot): the page adds it as an image layer (/page/drops.js). Canvas's own
      // copy of layers and cards always wins over a picture.
      if cmd == "paste", !inPlace, canvasPasteboard.string(forType: .canvasClipboard) == nil, let js = pastedImageCommand() { model.run(js); return }
      // A copied fill, stroke or effect (no layers): onto the selected layers' list it came from.
      if cmd == "paste", canvasPasteboard.string(forType: .canvasClipboard) == nil, model.pasteCopiedPaint() { return }
      let text = cmd == "paste" ? jsString(canvasClipboardText()) : "''"
      model.run("{cmd:'\(cmd)',inPlace:\(inPlace),text:\(text)}")
    }
    // Text being edited on the canvas: its textarea cuts, copies, pastes (plain text) and selects all, natively.
    // After a click on one of the app's own controls the web view lost focus: give it back to the editor first.
    if model.textEditing {
      let webView = model.webView
      if webFocused { NSApp.sendAction(action, to: webView, from: nil); return }
      window.makeFirstResponder(webView)
      webView.evaluateJavaScript("!!(window.canvasHost && window.canvasHost.textEdit && window.canvasHost.textEdit.focus())") { r, _ in
        if (r as? Bool) == true { NSApp.sendAction(action, to: webView, from: nil) } else { send() }
      }
      return
    }
    guard webFocused else { send(); return }
    // A page text field with focus: the web view cuts, copies and pastes in it natively.
    let webView = model.webView
    webView.evaluateJavaScript("(() => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable); })()") { r, _ in
      if (r as? Bool) == true { NSApp.sendAction(action, to: webView, from: nil) } else { send() }
    }
  }
  private func op(_ name: String, _ dir: String? = nil) { model.run("{cmd:'structure',op:'\(name)'\(dir.map { ",dir:'\($0)'" } ?? "")}") }
  @objc func duplicate(_ s: Any?) { op("duplicate") }
  @objc func deleteSelection(_ s: Any?) { op("delete") }
  @objc func group(_ s: Any?) { op("group") }
  @objc func frameSelection(_ s: Any?) { op("frame") }
  @objc func ungroup(_ s: Any?) { op("ungroup") }
  @objc func bringForward(_ s: Any?) { op("reorder", "forward") }
  @objc func sendBackward(_ s: Any?) { op("reorder", "backward") }
  @objc func bringToFront(_ s: Any?) { op("reorder", "front") }
  @objc func sendToBack(_ s: Any?) { op("reorder", "back") }
  // Auto layout (InspectorLayout.swift): the page adds rects and posts /api/layout.
  // Flip, show/hide and align (src/page/shortcuts.js): the page does the work.
  private func shortcut(_ name: String) { model.run("{cmd:'shortcut',op:'\(name)'}") }
  @objc func flipHorizontal(_ s: Any?) { shortcut("flipH") }
  @objc func flipVertical(_ s: Any?) { shortcut("flipV") }
  @objc func toggleHidden(_ s: Any?) { shortcut("hide") }
  // Shift held while choosing an align item: the layers align to their parent frame, not their own box.
  private func align(_ name: String) { shortcut(NSApp.currentEvent?.modifierFlags.contains(.shift) == true && NSApp.currentEvent?.type != .keyDown ? name + ":parent" : name) }
  @objc func alignLeft(_ s: Any?) { align("align-left") }
  @objc func alignHCenter(_ s: Any?) { align("align-hcenter") }
  @objc func alignRight(_ s: Any?) { align("align-right") }
  @objc func alignTop(_ s: Any?) { align("align-top") }
  @objc func alignVCenter(_ s: Any?) { align("align-vcenter") }
  @objc func alignBottom(_ s: Any?) { align("align-bottom") }
  /// Menu items whose page op rides on the item (Create Component, Detach Instance, Copy and Paste Properties, Distribute).
  @objc func pageShortcut(_ item: NSMenuItem) { if let op = item.representedObject as? String { shortcut(op) } }
  @objc func addAutoLayout(_ s: Any?) { model.runLayout(["op": "add"]) }
  @objc func removeAutoLayout(_ s: Any?) { model.runLayout(["op": "remove"]) }
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(flipHorizontal(_:)), #selector(flipVertical(_:)), #selector(alignLeft(_:)), #selector(alignHCenter(_:)),
         #selector(alignRight(_:)), #selector(alignTop(_:)), #selector(alignVCenter(_:)), #selector(alignBottom(_:)):
      // Shift+H, Option+A and the rest typed anywhere are keys, not these items: the page handles them on the canvas
      // (and leaves them to text being typed); a menu click runs them here.
      if NSApp.currentEvent?.type == .keyDown { return false }
      guard nativeText == nil, !otherWindowKey, !model.textEditing, let sel = model.selection else { return false }
      // One layer aligns in its parent; several need two the canvas may move (ArrangeActions).
      if item.action != #selector(flipHorizontal(_:)), item.action != #selector(flipVertical(_:)), sel.ids.count > 1 {
        return ArrangeActions.enabled(ArrangeActions.align[0], count: sel.ids.count, free: sel.free)
      }
      return true
    case #selector(pageShortcut(_:)):
      // Option+Cmd+K and the rest typed on the canvas are the page's keys (src/page/shortcuts.js); typed in a text
      // field they belong to the field. A menu click runs them here.
      let op = item.representedObject as? String ?? ""
      // Lock and the selection commands keep their keys in the menu (Shift+Cmd chords the menu declines never reach
      // the page); a text field with focus keeps them.
      let menuKey = ["lock", "selectInverse", "selectMatching"].contains(op)
      if NSApp.currentEvent?.type == .keyDown && ((webFocused && !menuKey) || nativeText != nil) { return false }
      // Select inverse with nothing selected selects everything.
      if op == "selectInverse" { return nativeText == nil && !otherWindowKey && !model.textEditing }
      guard nativeText == nil, !otherWindowKey, !model.textEditing, let sel = model.selection else { return false }
      let type = sel.node["type"] as? String
      if op == "detach" { return type == "ref" || (sel.ids.count > 1 && type == nil) }
      if op == "component" { return sel.node["reusable"] as? Bool != true && !sel.isPath && !sel.inInstance }
      if let a = ArrangeActions.spread.first(where: { $0.op == op }) { return ArrangeActions.enabled(a, count: sel.ids.count, free: sel.free) }
      return true
    case #selector(ungroup(_:)):
      // Only groups and frames (and a multi-selection holding one) ungroup; a rectangle has nothing to let go.
      guard nativeText == nil, !otherWindowKey, !model.textEditing, let sel = model.selection else { return model.contextOnLayer }
      let type = sel.node["type"] as? String
      return type == "group" || type == "frame" || (sel.ids.count > 1 && type == nil)
    case #selector(addAutoLayout(_:)), #selector(removeAutoLayout(_:)):
      // Shift+A typed anywhere is a key, not this item: the page handles it on the canvas (and leaves it to text
      // being typed); a menu click or the right-click menu runs it here.
      if NSApp.currentEvent?.type == .keyDown { return false }
      guard nativeText == nil, !otherWindowKey, !model.textEditing, model.selection != nil || model.contextOnLayer else { return false }
      if item.action == #selector(removeAutoLayout(_:)), let n = model.selection?.node { return LayoutLogic.isAutoLayout(n) }
      return true
    case #selector(cut(_:)), #selector(copy(_:)):
      if let t = nativeText { return t.selectedRange.length > 0 }
      if otherWindowKey { return false }
      return model.selection != nil || model.contextOnLayer || webFocused
    case #selector(placeImage(_:)):
      return !otherWindowKey && model.currentFile != nil
    case #selector(pasteReplace(_:)):
      return nativeText == nil && !otherWindowKey && !model.textEditing && (model.selection != nil || model.contextOnLayer)
    case #selector(selectAll(_:)):
      // Shift+Cmd+A is Select Inverse (the page's key): AppKit's fallback must not make it Select All.
      if shiftedKey && nativeText == nil { return false }
      return nativeText != nil || !otherWindowKey
    case #selector(paste(_:)), #selector(pasteInPlace(_:)), #selector(pasteHere(_:)):
      return nativeText != nil || !otherWindowKey
    default: return nativeText == nil && !otherWindowKey && !model.textEditing && (model.selection != nil || model.contextOnLayer)
    }
  }
}
let structureActions = StructureActions()
model.editTarget = structureActions

// Canvas keys (1/2/0/F/Esc/Delete/Space) belong to the canvas whenever no text field is being typed in: a click
// in the rail, the inspector or the toolbar leaves SwiftUI holding keyboard focus, so the key would go nowhere.
// The first key there hands focus back to the web view and is delivered to it. Command keys go through the menus
// (and the web view's own key equivalents) wherever focus is; Tab keeps moving between fields.
NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
  guard e.window === window, window.attachedSheet == nil else { return e }
  let r = window.firstResponder
  if r is NSText || ((r as? NSView)?.isDescendant(of: model.webView) ?? false) { return e }
  if e.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command) || e.keyCode == 48 { return e }
  window.makeFirstResponder(model.webView)
  return e
}
// A paint row picked in the inspector (InspectorPaint.swift): Esc lets it go and Delete removes that paint, instead
// of the canvas deselecting or deleting the layer. Any click in the window lets it go; a click on a row's left area
// picks that row again once the click ends.
NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
  guard e.window === window, model.paintRowNow != nil, !model.textEditing, !(window.firstResponder is NSText) else { return e }
  if !e.modifierFlags.intersection([.command, .control, .option]).isEmpty { return e }
  switch e.keyCode {
  case 53: model.paintRow = nil; return nil
  case 51, 117: return model.deletePaintRow() ? nil : e
  default: return e
  }
}
NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { e in
  if model.paintRow != nil, e.window === window { model.paintRow = nil }
  return e
}
// Cmd+scroll zooms the canvas (src/pagelogic.ts wheelAction). The page reads the Command key off each wheel event,
// but a scroll utility that re-posts wheel events can drop their flags, and keys go to SwiftUI while it has focus:
// the shell tells the page whenever Command goes down or up.
var commandDown = false
/// Option, sent along with Command: a component row dropped with Option on an instance swaps it (/page/drops.js).
var optionDown = false
/// Command during a drag over the canvas (a shader tile, files from Finder): the page reads it to outline the layer
/// a Cmd-drop fills (/page/drops.js). WebKit's drag events take their modifier keys in the web content process, and
/// no flagsChanged reaches this app while Finder leads the drag, so the state comes along with every drag update.
func syncDragCommand() { sendMods(NSEvent.modifierFlags) }

/// Tell the page when Command or Option went down or up.
func sendMods(_ flags: NSEvent.ModifierFlags) {
  let cmd = flags.contains(.command), opt = flags.contains(.option)
  guard cmd != commandDown || opt != optionDown else { return }
  commandDown = cmd
  optionDown = opt
  model.run("{cmd:'mods',meta:\(cmd),alt:\(opt)}")
}

NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { e in
  sendMods(e.modifierFlags)
  return e
}
NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in
  if commandDown || optionDown { commandDown = false; optionDown = false; model.run("{cmd:'mods',meta:false,alt:false}") }
}
/// A drag from another app (Finder) ended: this app never sees Command go up while that app is in front, so the page
/// forgets it now (the drop already read it). A drag from the sidebar keeps it: the key monitor sees the release.
/// Later than the drop itself: WebKit hands the page its drop event after this call returns.
func endDragCommand() {
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
    if !NSApp.isActive, commandDown || optionDown { commandDown = false; optionDown = false; model.run("{cmd:'mods',meta:false,alt:false}") }
  }
}
// The rest of the menu bar's commands: zoom, the panels, Rename, Settings, About, the window.
final class MenuActions: NSObject, NSMenuItemValidation {
  /// Canvas > About Canvas: version, commit and build date, the website and Report a Bug (Settings.swift AboutWindow).
  @objc func about(_ s: Any?) {
    MainActor.assumeIsolated { AboutWindow.shared.show(website: URL(string: ReleaseLinks.site)!, report: { [weak self] in self?.reportBug(nil) }) }
  }
  /// Canvas > Settings: the settings window (Settings.swift).
  @objc func settings(_ s: Any?) { MainActor.assumeIsolated { SettingsWindow.shared.show(model) } }
  @objc func zoomIn(_ s: Any?) { model.zoomBy(1.25) }
  @objc func zoomOut(_ s: Any?) { model.zoomBy(0.8) }
  @objc func zoom100(_ s: Any?) { model.zoomReset() }
  @objc func zoomFit(_ s: Any?) { model.fitPage() }
  @objc func zoomSelection(_ s: Any?) { model.fit() }
  /// View > Pixel Grid (Cmd+') and Rulers (Shift+R, the page's key): src/page/navigate.js toggles and answers {view}.
  @objc func pixelGrid(_ s: Any?) { model.run("{cmd:'nav',op:'grid'}") }
  @objc func rulers(_ s: Any?) { model.run("{cmd:'nav',op:'rulers'}") }
  /// View > Layout Guides (Control+G, the page's key): frames' grids, columns and rows (src/page/navigate.js).
  @objc func layoutGuides(_ s: Any?) { model.run("{cmd:'nav',op:'layoutGuides'}") }
  @objc func toggleUI(_ s: Any?) { model.uiHidden.toggle() }
  @objc func toggleProperties(_ s: Any?) { model.inspectorOpen.toggle() }
  /// Cmd+R: the selected layer's name opens for editing in the Layers panel.
  @objc func rename(_ s: Any?) { model.renameSelection() }
  /// Option+L (collapse layers): every open row in the Layers panel closes.
  @objc func collapseLayers(_ s: Any?) { LayersStore.of(model).collapseAll() }
  @objc func showWindow(_ s: Any?) { showMainWindow() }
  /// Window > Home (Shift+Cmd+0): the pinned first tab.
  @objc func showHome(_ s: Any?) { model.showHome() }
  /// Help > Report a Bug: the website's form in the browser, with this build's version, commit, macOS and
  /// architecture filled in (ReleaseLinks.report). Nothing is sent until the person presses Send there.
  @objc func reportBug(_ s: Any?) { NSWorkspace.shared.open(reportURL()); UsageCount.send("bug.report_opened", to: base) }
  /// Help > Download Latest Version: the website's download page.
  @objc func downloadLatest(_ s: Any?) { NSWorkspace.shared.open(ReleaseLinks.download); UsageCount.send("update.download_clicked", to: base) }
  /// Canvas > Check for Updates: "Canvas is up to date", or the download starts (Updater.swift).
  @objc func checkForUpdates(_ s: Any?) { MainActor.assumeIsolated { Updater.shared.check(userInitiated: true) } }
  /// Canvas > Restart to Update: shown while a verified update is ready.
  @objc func restartToUpdate(_ s: Any?) { MainActor.assumeIsolated { Updater.shared.restartToUpdate() } }
  private var nativeText: Bool { keyWindowNow.firstResponder is NSText }
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    let key = NSApp.currentEvent?.type == .keyDown
    switch item.action {
    case #selector(zoom100(_:)), #selector(zoomFit(_:)), #selector(zoomSelection(_:)):
      // Shift+0/1/2 are the page's keys (zoomKey, src/page/shortcuts-logic.js), and a "!" typed in a field is text.
      return !(key && (webHasFocus || nativeText))
    case #selector(pixelGrid(_:)):
      item.state = model.pixelGrid ? .on : .off
      return model.currentFile != nil && !nativeText
    case #selector(layoutGuides(_:)):
      item.state = model.layoutGuides ? .on : .off
      // The menu owns Control+G: a Control+letter the menu declines never reaches the page (WebKit drops it).
      return model.currentFile != nil
    case #selector(rulers(_:)):
      item.state = model.rulers ? .on : .off
      // Shift+R is the page's key on the canvas, and an "R" typed in a field is text.
      return model.currentFile != nil && !(key && (webHasFocus || nativeText))
    case #selector(toggleProperties(_:)):
      item.title = model.inspectorOpen ? "Hide Properties" : "Show Properties"
      return true
    case #selector(toggleUI(_:)):
      item.title = model.uiHidden ? "Show UI" : "Hide UI"
      return true
    case #selector(rename(_:)):
      guard !nativeText, !model.textEditing, let sel = model.selection else { return false }
      // Several layers: Rename Layers (a batch rename) for the ones that have names of their own.
      if sel.ids.count > 1 { return sel.ids.filter { !$0.hasPrefix("widget:") && !LayersLogic.insideInstance($0) }.count > 1 }
      return !sel.isPath && !sel.inInstance && !sel.id.hasPrefix("widget:")
    case #selector(collapseLayers(_:)):
      // Option+L typed anywhere is the page's key (a text field types it); a menu click runs it here.
      return !(key && (webHasFocus || nativeText))
    case #selector(checkForUpdates(_:)):
      return MainActor.assumeIsolated { !Updater.shared.busy }
    case #selector(restartToUpdate(_:)):
      return MainActor.assumeIsolated { Updater.shared.ready != nil }
    default: return true
    }
  }
}
let menuActions = MenuActions()

class ThemePicker: NSObject {
  @objc func pick(_ item: NSMenuItem) {
    if let raw = item.representedObject as? String, let t = AppTheme(rawValue: raw) { model.theme = t }
  }
  func sync(_ menu: NSMenu) { menu.items.forEach { if $0.target === self { $0.state = ($0.representedObject as? String) == model.theme.rawValue ? .on : .off } } }
}
let themePicker = ThemePicker()

/// Each MenuSpec command's target and action. Items whose page op rides on them carry it as representedObject.
func menuTarget(_ command: String) -> (target: AnyObject?, action: Selector, op: String?)? {
  switch command {
  case "about": return (menuActions, #selector(MenuActions.about(_:)), nil)
  case "settings": return (menuActions, #selector(MenuActions.settings(_:)), nil)
  case "hide": return (nil, #selector(NSApplication.hide(_:)), nil)
  case "hideOthers": return (nil, #selector(NSApplication.hideOtherApplications(_:)), nil)
  case "showAll": return (nil, #selector(NSApplication.unhideAllApplications(_:)), nil)
  case "quit": return (nil, #selector(NSApplication.terminate(_:)), nil)
  case "new": return (fileActions, #selector(FileActions.newCanvas(_:)), nil)
  case "open": return (fileActions, #selector(FileActions.openDocument(_:)), nil)
  case "closeTab": return (fileActions, #selector(FileActions.closeTab(_:)), nil)
  case "saveAs": return (fileActions, #selector(FileActions.saveAsCanvas(_:)), nil)
  case "shareComments": return (fileActions, #selector(FileActions.shareComments(_:)), nil)
  case "reload": return (fileActions, #selector(FileActions.reloadPage(_:)), nil)
  case "undo": return (editActions, #selector(EditActions.undo(_:)), nil)
  case "redo": return (editActions, #selector(EditActions.redo(_:)), nil)
  case "repeat": return (editActions, #selector(EditActions.repeatLast(_:)), nil)
  case "copyLink": return (editActions, #selector(EditActions.copyLink(_:)), nil)
  case "copyPNG": return (editActions, #selector(EditActions.copyPNG(_:)), nil)
  case "exportSettings": return (fileActions, #selector(FileActions.exportSettings(_:)), nil)
  case "findReplace": return (editActions, #selector(EditActions.findReplace(_:)), nil)
  case "cut": return (structureActions, #selector(StructureActions.cut(_:)), nil)
  case "copy": return (structureActions, #selector(StructureActions.copy(_:)), nil)
  case "paste": return (structureActions, #selector(StructureActions.paste(_:)), nil)
  case "pasteInPlace": return (structureActions, #selector(StructureActions.pasteInPlace(_:)), nil)
  case "pasteReplace": return (structureActions, #selector(StructureActions.pasteReplace(_:)), nil)
  case "placeImage": return (structureActions, #selector(StructureActions.placeImage(_:)), nil)
  case "selectAll": return (structureActions, #selector(StructureActions.selectAll(_:)), nil)
  case "duplicate": return (structureActions, #selector(StructureActions.duplicate(_:)), nil)
  case "delete": return (structureActions, #selector(StructureActions.deleteSelection(_:)), nil)
  case "group": return (structureActions, #selector(StructureActions.group(_:)), nil)
  case "frame": return (structureActions, #selector(StructureActions.frameSelection(_:)), nil)
  case "ungroup": return (structureActions, #selector(StructureActions.ungroup(_:)), nil)
  case "addAutoLayout": return (structureActions, #selector(StructureActions.addAutoLayout(_:)), nil)
  case "removeAutoLayout": return (structureActions, #selector(StructureActions.removeAutoLayout(_:)), nil)
  case "front": return (structureActions, #selector(StructureActions.bringToFront(_:)), nil)
  case "forward": return (structureActions, #selector(StructureActions.bringForward(_:)), nil)
  case "backward": return (structureActions, #selector(StructureActions.sendBackward(_:)), nil)
  case "back": return (structureActions, #selector(StructureActions.sendToBack(_:)), nil)
  case "flipH": return (structureActions, #selector(StructureActions.flipHorizontal(_:)), nil)
  case "flipV": return (structureActions, #selector(StructureActions.flipVertical(_:)), nil)
  case "toggleHidden": return (structureActions, #selector(StructureActions.toggleHidden(_:)), nil)
  case "align-left": return (structureActions, #selector(StructureActions.alignLeft(_:)), nil)
  case "align-hcenter": return (structureActions, #selector(StructureActions.alignHCenter(_:)), nil)
  case "align-right": return (structureActions, #selector(StructureActions.alignRight(_:)), nil)
  case "align-top": return (structureActions, #selector(StructureActions.alignTop(_:)), nil)
  case "align-vcenter": return (structureActions, #selector(StructureActions.alignVCenter(_:)), nil)
  case "align-bottom": return (structureActions, #selector(StructureActions.alignBottom(_:)), nil)
  case "copyProps", "pasteProps", "component", "detach", "distribute-h", "distribute-v", "tidy", "lock", "selectInverse", "selectMatching",
       "selectSame:fill", "selectSame:stroke", "selectSame:effect", "selectSame:textStyle", "selectSame:font", "selectSame:instances":
    return (structureActions, #selector(StructureActions.pageShortcut(_:)), command)
  case "zoomIn": return (menuActions, #selector(MenuActions.zoomIn(_:)), nil)
  case "zoomOut": return (menuActions, #selector(MenuActions.zoomOut(_:)), nil)
  case "zoom100": return (menuActions, #selector(MenuActions.zoom100(_:)), nil)
  case "zoomFit": return (menuActions, #selector(MenuActions.zoomFit(_:)), nil)
  case "zoomSelection": return (menuActions, #selector(MenuActions.zoomSelection(_:)), nil)
  case "pixelGrid": return (menuActions, #selector(MenuActions.pixelGrid(_:)), nil)
  case "rulers": return (menuActions, #selector(MenuActions.rulers(_:)), nil)
  case "layoutGuides": return (menuActions, #selector(MenuActions.layoutGuides(_:)), nil)
  case "toggleUI": return (menuActions, #selector(MenuActions.toggleUI(_:)), nil)
  case "toggleProperties": return (menuActions, #selector(MenuActions.toggleProperties(_:)), nil)
  case "rename": return (menuActions, #selector(MenuActions.rename(_:)), nil)
  case "collapseLayers": return (menuActions, #selector(MenuActions.collapseLayers(_:)), nil)
  case "palette": return (paletteMenuTarget, #selector(PaletteMenuTarget.toggle(_:)), nil)
  case "reportBug": return (menuActions, #selector(MenuActions.reportBug(_:)), nil)
  case "downloadLatest": return (menuActions, #selector(MenuActions.downloadLatest(_:)), nil)
  case "checkForUpdates": return (menuActions, #selector(MenuActions.checkForUpdates(_:)), nil)
  case "restartToUpdate": return (menuActions, #selector(MenuActions.restartToUpdate(_:)), nil)
  case "home": return (menuActions, #selector(MenuActions.showHome(_:)), nil)
  case "minimize": return (nil, #selector(NSWindow.performMiniaturize(_:)), nil)
  case "zoomWindow": return (nil, #selector(NSWindow.performZoom(_:)), nil)
  default: return nil
  }
}

func buildMenu(_ title: String, _ entries: [MenuSpec.Entry]) -> NSMenu {
  let root = NSMenu(title: title)
  var stack = [root]
  for e in entries {
    guard let i = e else { stack.last!.addItem(.separator()); continue }
    if i.title == "<" { if stack.count > 1 { stack.removeLast() }; continue }
    if i.title.hasPrefix(">") {
      let sub = NSMenu(title: String(i.title.dropFirst()))
      let item = NSMenuItem(title: sub.title, action: nil, keyEquivalent: "")
      item.submenu = sub
      stack.last!.addItem(item)
      stack.append(sub)
      continue
    }
    guard let t = menuTarget(i.command) else { NSLog("canvas: no action for menu command \(i.command)"); continue }
    // A Shift chord on a letter is spelled in capitals (AppKit's own form): "l" with Shift never matches Shift+Cmd+L.
    let key = i.mods.contains(.shift) && i.key.count == 1 && i.key.first!.isLetter ? i.key.uppercased() : i.key
    let item = NSMenuItem(title: i.title, action: t.action, keyEquivalent: key)
    var mods: NSEvent.ModifierFlags = []
    if i.mods.contains(.command) { mods.insert(.command) }
    if i.mods.contains(.shift) { mods.insert(.shift) }
    if i.mods.contains(.option) { mods.insert(.option) }
    if i.mods.contains(.control) { mods.insert(.control) }
    item.keyEquivalentModifierMask = mods
    item.target = t.target
    item.representedObject = t.op
    stack.last!.addItem(item)
  }
  return root
}

let menubar = NSMenu()
for (title, entries) in MenuSpec.menus {
  let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
  top.submenu = buildMenu(title, entries)
  menubar.addItem(top)
}
// View: the themes under the zoom items.
let viewMenu = menubar.item(withTitle: "View")!.submenu!
for t in AppTheme.allCases {
  let item = NSMenuItem(title: t.title + " Theme", action: #selector(ThemePicker.pick(_:)), keyEquivalent: "")
  item.target = themePicker
  item.representedObject = t.rawValue
  viewMenu.addItem(item)
}
NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { _ in themePicker.sync(viewMenu) }
// Canvas > Restart to Update: in the menu only while a verified update is ready.
let restartItem = menubar.item(withTitle: "Canvas")?.submenu?.items.first { $0.action == #selector(MenuActions.restartToUpdate(_:)) }
let restartItemSync = MainActor.assumeIsolated {
  Updater.shared.$ready.receive(on: DispatchQueue.main).sink { r in restartItem?.isHidden = r == nil }
}

// Window: one entry for the window, named after the file it shows, and the way back after its close button
// (AppKit's own entry is off: it would list the window a second time and drop it once the window is closed).
let windowMenu = menubar.item(withTitle: "Window")!.submenu!
window.isExcludedFromWindowsMenu = true
let canvasWindowItem = NSMenuItem(title: "Canvas", action: #selector(MenuActions.showWindow(_:)), keyEquivalent: "")
canvasWindowItem.target = menuActions
windowMenu.addItem(canvasWindowItem)
let windowTitleSync = model.$fileName.receive(on: DispatchQueue.main).sink { name in
  let title = name.isEmpty ? "Canvas" : name
  canvasWindowItem.title = title
  window.title = title
}
app.windowsMenu = windowMenu
app.mainMenu = menubar

// The traffic lights sit in the top pill: centered on its midline, inset like the pill's own padding.
var placingTrafficLights = false
func placeTrafficLights() {
  let kinds: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
  let buttons = kinds.compactMap { window.standardWindowButton($0) }
  guard let first = buttons.first, let bar = first.superview, !placingTrafficLights else { return }
  placingTrafficLights = true
  defer { placingTrafficLights = false }
  let midY = bar.convert(NSPoint(x: 0, y: window.frame.height - (Metric.inset + Metric.pill / 2)), from: nil).y
  var x = Metric.inset + Metric.pillPad + 12
  for b in buttons {
    let want = NSPoint(x: x, y: (midY - b.frame.height / 2).rounded())
    if b.frame.origin != want { b.setFrameOrigin(want) }
    x += b.frame.width + 6
  }
}
// AppKit lays the titlebar out again on its own (a new window title on a tab switch, key and main changes, an
// appearance change) and puts the buttons back at its default spot, over the pill's corner. Watch their frames
// and put them back whenever that happens, not only on the window events below.
let trafficLightWatch: [NSKeyValueObservation] = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
  .compactMap { window.standardWindowButton($0) }
  .map { $0.observe(\.frame, options: [.new]) { _, _ in DispatchQueue.main.async { placeTrafficLights() } } }
// The frame watch above misses some resets (AppKit can rebuild the titlebar's container instead of moving the
// buttons), so also check after every window update: three frame comparisons, a move only when one is off.
NotificationCenter.default.addObserver(forName: NSWindow.didUpdateNotification, object: window, queue: .main) { _ in
  placeTrafficLights()
}
for name in [NSWindow.didResizeNotification, NSWindow.didEndLiveResizeNotification, NSWindow.didBecomeKeyNotification,
             NSWindow.didResignKeyNotification, NSWindow.didBecomeMainNotification, NSWindow.didResignMainNotification,
             NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification, NSWindow.didChangeScreenNotification] {
  NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { _ in
    placeTrafficLights()
    DispatchQueue.main.async { placeTrafficLights() }
  }
}

/// One per web view (each tab has its own): retries, generations and crashes belong to that tab's page.
class Nav: NSObject, WKNavigationDelegate {
  weak var view: WKWebView?
  /// Still the delegate of a live web view (a tab let go clears it).
  var isAttached: Bool { view?.navigationDelegate === self }
  private var attempts = 0
  // If the page fails because the server is between idle-exit and restart, try again shortly: only for those
  // errors, a bounded number of times, and never after another load started (a tab switch cancels the old load
  // with NSURLErrorCancelled, which used to reload in a loop).
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    let e = error as NSError
    guard NavRetry.shouldRetry(domain: e.domain, code: e.code, attempt: attempts) else { return }
    let delay = max(0.8, NavRetry.delay(attempt: attempts))
    attempts += 1
    let gen = generation
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      if self?.generation == gen { webView.reload() }
    }
  }
  // A refused connection fails before the page commits ("provisional"): there is no page to reload, so load the
  // same URL again, a bit later each time, while the server comes up.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    let e = error as NSError
    guard NavRetry.shouldRetry(domain: e.domain, code: e.code, attempt: attempts),
          let url = (e.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url else { return }
    let delay = NavRetry.delay(attempt: attempts)
    attempts += 1
    let gen = generation
    // Another load since (a tab switch) cancels this retry: it would bring the old page back.
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      if self?.generation == gen { webView.load(URLRequest(url: url)) }
    }
  }
  private var generation = 0
  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    generation += 1
    if webView === model.webView { model.textEditing = false } // the page that had an edit open is going: it never says the edit ended
  }
  // The page crashed: whatever it was editing is gone with it, and so is its "text editing" state. WebKit
  // reloads a crashed page only when this method is missing, so it reloads here (not again within 10 s: a page
  // that keeps crashing stays down instead of looping).
  private var lastCrash: Date?
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // A hidden tab's page loads again when it is shown (reloading it now would open its streams in the background).
    guard webView === model.webView else { model.hiddenPageGone(webView); return }
    model.textEditing = false
    let now = Date()
    defer { lastCrash = now }
    if let last = lastCrash, now.timeIntervalSince(last) < 10 { return }
    webView.reload()
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { attempts = 0 }
}
var navs: [ObjectIdentifier: Nav] = [:]
func attachNav(_ wv: WKWebView) {
  let n = Nav()
  n.view = wv
  navs[ObjectIdentifier(wv)] = n
  wv.navigationDelegate = n
}
attachNav(model.webView)
model.onNewWebView = { wv in
  // Views that were let go keep no delegate around.
  navs = navs.filter { $0.value.isAttached }
  attachNav(wv)
  #if CANVAS_QA
  MainActor.assumeIsolated { QA.keepPageAwake(wv) }
  #endif
}
#if CANVAS_QA
// A QA build (pnpm qa:native): bridge ops that post input into this window. Never in the normal app.
MainActor.assumeIsolated { QA.install(model: model, window: window) }
#endif

app.windows.forEach { _ in }
window.makeKeyAndOrderFront(nil)
// The palette's keys (Cmd+K, Cmd+/, and its arrows while open) from the first key press, not from whenever SwiftUI
// first shows its layer: Cmd+/ has no menu item to fall back on.
PaletteController.shared.install(model)
placeTrafficLights()
app.activate(ignoringOtherApps: true)

var loadAttempts = 0
func loadDesign() {
  if openedFromFinder { return }
  // The file the user had open last, else the most recently touched one. The list is scanned
  // in the background, so a fresh server may need a moment to hand it over.
  let defaults = UserDefaults.standard
  let last = defaults.string(forKey: "canvas.lastFile")
  // The file you had open is reopened straight away; waiting for the server's file scan would
  // leave a cold start on the empty page.
  if let last, FileManager.default.fileExists(atPath: last) {
    DispatchQueue.main.async { model.open(last) }
    return
  }
  // Asynchronous all the way: a slow /api/files answer never holds the main thread (retries run off main too).
  var req = URLRequest(url: base.appendingPathComponent("api/files"))
  req.timeoutInterval = 5
  URLSession.shared.dataTask(with: req) { data, response, _ in
    var target: String?
    if (response as? HTTPURLResponse)?.statusCode == 200, let data,
       let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], !list.isEmpty {
      if let last, list.contains(where: { ($0["file"] as? String) == last }) {
        target = last
      } else if let first = list.first?["file"] as? String {
        target = first
        defaults.set(first, forKey: "canvas.lastFile")
      }
    }
    if target != nil {
      DispatchQueue.main.async { if !openedFromFinder, let f = target { model.open(f) } }
    } else if loadAttempts < 25 {
      loadAttempts += 1
      DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.4) { loadDesign() }
    } else {
      DispatchQueue.main.async { if !openedFromFinder { model.showEmpty() } }
    }
  }.resume()
}

DispatchQueue.global(qos: .userInitiated).async {
  if !serverUp() { startServer() }
  for _ in 0..<200 { if serverUp() { break }; usleep(100_000) }
  // Usage counts (src/usage-counts.ts): this launch, and a crash when the last run never quit.
  if lastRunCrashed { UsageCount.send("crash", to: base) }
  UsageCount.send("app.open", to: base)
  DispatchQueue.main.async {
    serverReady = true
    // Whether the update the last quit installed took (a toast and a usage count).
    MainActor.assumeIsolated { Updater.shared.launched() }
    // A Finder open that arrived before the server was up goes first; otherwise the remembered file.
    model.refreshAgentReady()
    let defaults = UserDefaults.standard, env = ProcessInfo.processInfo.environment
    let last = defaults.string(forKey: "canvas.lastFile")
    if FirstRun.marksWelcomed(lastFile: last, openFiles: model.openFiles, env: env) { defaults.set(true, forKey: FirstRun.key) }
    if let l = pendingLink { pendingLink = nil; model.openLink(l) }
    else if let f = pendingFinderFile { pendingFinderFile = nil; model.open(f) }
    else if FirstRun.shouldWelcome(welcomed: defaults.bool(forKey: FirstRun.key), lastFile: last, openFiles: model.openFiles, env: env) { openWelcome() }
    else { DispatchQueue.global(qos: .userInitiated).async { loadDesign() } }
  }
}

/// The first launch: the Welcome file (a copy of the sample with the welcome card, src/onboarding.ts). If the server
/// cannot make it, the usual start (the most recent file, else the empty window).
func openWelcome() {
  var req = URLRequest(url: base.appendingPathComponent("api/welcome"))
  req.httpMethod = "POST"
  req.timeoutInterval = 10
  req.setValue("1", forHTTPHeaderField: "x-canvas")
  req.setValue("application/json", forHTTPHeaderField: "content-type")
  req.httpBody = Data("{}".utf8)
  URLSession.shared.dataTask(with: req) { data, response, _ in
    let file = (response as? HTTPURLResponse)?.statusCode == 200
      ? (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["file"] as? String : nil
    DispatchQueue.main.async {
      guard !openedFromFinder else { return }
      if let file {
        UserDefaults.standard.set(true, forKey: FirstRun.key)
        model.quietRecents.insert(file) // the app opened it, not the person: Home's first-launch cards stay
        model.open(file)
      } else {
        DispatchQueue.global(qos: .userInitiated).async { loadDesign() }
      }
    }
  }.resume()
}

// The page posts the file it shows to the "canvasFile" handler; the shell remembers it and
// reopens it on the next launch.
class Hook: NSObject, WKScriptMessageHandler {
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    if message.name == "canvasFile", message.webView === model.webView, let file = message.body as? String, !file.isEmpty {
      UserDefaults.standard.set(file, forKey: "canvas.lastFile")
    }
  }
}
let hook = Hook()
config.userContentController.add(hook, name: "canvasFile")

// The MCP bridge: commands from the server, window state back to it.
let bridge = MainActor.assumeIsolated { BridgeClient(model: model, window: window, base: base) }
MainActor.assumeIsolated { bridge.start() }

app.run()
