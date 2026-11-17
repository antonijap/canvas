// Loads the engine dev page in a real WKWebView (the Canvas app's web view), waits for the board,
// runs a JS expression (e.g. window.bench()) and prints its result, then quits.
// Build: swiftc -O engine/dev/WebViewHost.swift -o <out>/WebViewHost
// Run:   WebViewHost '<dev page url>' '<js expression returning a string or promise of one>'
import Cocoa
import WebKit

let url = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "http://127.0.0.1:5186/"
let expr = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "JSON.stringify(window.__summary)"
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let cfg = WKWebViewConfiguration()
let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1600, height: 1000), configuration: cfg)
let win = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 1600, height: 1000), styleMask: [.titled], backing: .buffered, defer: false)
win.contentView = wv
win.orderFrontRegardless()
wv.load(URLRequest(url: URL(string: url)!))

var tries = 0
func poll() {
    wv.evaluateJavaScript("window.__ready === true") { r, _ in
        if (r as? Bool) == true {
            wv.callAsyncJavaScript("return await (\(expr))", arguments: [:], in: nil, in: .page) { res in
                switch res {
                case .success(let v): print(v)
                case .failure(let e): print("error", e)
                }
                exit(0)
            }
        } else {
            tries += 1
            if tries > 600 { print("timeout"); exit(1) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: poll)
        }
    }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: poll)
app.run()
