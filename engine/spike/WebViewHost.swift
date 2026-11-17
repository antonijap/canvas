// Throwaway: loads the spike page in a real WKWebView and logs WebGPU availability.
// Build: swiftc -O WebViewHost.swift -o /path/WebViewHost ; run: WebViewHost [tag] [url]
import Cocoa
import WebKit

final class Del: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { print("[js]", m.body) }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
        print("didFinish")
        w.evaluateJavaScript("JSON.stringify({gpu: typeof navigator.gpu, ua: navigator.userAgent, dpr: devicePixelRatio, w: innerWidth, h: innerHeight})") { r, e in print("probe", r ?? "nil", e?.localizedDescription ?? "") }
    }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { print("fail", e) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { print("failprov", e) }
}

let tag = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "wk"
let extra = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let cfg = WKWebViewConfiguration()
let del = Del()
cfg.userContentController.add(del, name: "log")
// Optional: enable experimental features by key (comma separated in argv[3]).
if CommandLine.arguments.count > 3 {
    for key in CommandLine.arguments[3].split(separator: ",") {
        let sel = NSSelectorFromString("_setEnabled:forExperimentalFeature:")
        let feats = WKPreferences.perform(NSSelectorFromString("_experimentalFeatures"))?.takeUnretainedValue() as? [AnyObject] ?? []
        for f in feats where (f.value(forKey: "key") as? String) == String(key) {
            _ = cfg.preferences.perform(sel, with: true as NSNumber, with: f)
            print("enabled feature", key)
        }
    }
}
let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: cfg)
wv.navigationDelegate = del
if #available(macOS 13.3, *) { wv.isInspectable = true }
let win = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1440, height: 900), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
win.contentView = wv
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
wv.load(URLRequest(url: URL(string: "http://127.0.0.1:5185/?tag=\(tag)\(extra)")!))
app.run()
