// Copy as PNG in a browser (Shift+Cmd+C): the selection as a 2x PNG on the clipboard, from POST
// /api/copy-as (src/copy-as.ts). In Canvas.app the Edit menu owns the key and the shell writes the pasteboard
// (apps/macos Library.swift copyAs), with the rest of Copy as in the right-click menu.
// host.lastCopy: the last copy, {format, width, height, bytes, written}: the QA runner reads it (headless Chrome's
// clipboard is not the Mac's to read).

const host = window.canvasHost;
if (host && host.file && !host.native) start(host);

function start(host) {
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  const editingText = () => !!(host.textEdit && host.textEdit.active);
  function say(text) {
    const m = document.getElementById("msg");
    if (!m) { console.warn("[canvas] " + text); return; }
    m.textContent = text;
    m.style.display = "block";
    clearTimeout(say.t);
    say.t = setTimeout(() => { m.style.display = "none"; }, 2500);
  }

  async function copyAs(format) {
    const ids = (host.selection ? host.selection() : host.sel ? [host.sel] : []).filter((id) => !id.startsWith("widget:"));
    if (!ids.length) { say("Select a layer or board to copy as PNG"); return; }
    host.lastCopy = { format, written: false, pending: true };
    const r = await fetch("/api/copy-as", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file: host.file, ids, format, scale: 2 }) });
    const j = await r.json();
    if (!r.ok) { host.lastCopy = { format, written: false, error: j.error }; say(j.error || "Could not copy"); return; }
    let written = false;
    try {
      if (j.data) {
        const bin = Uint8Array.from(atob(j.data), (ch) => ch.charCodeAt(0));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bin], { type: "image/png" }) })]);
      } else await navigator.clipboard.writeText(j.text);
      written = true;
    } catch {}
    host.lastCopy = { format, width: j.width, height: j.height, bytes: j.data ? Math.floor((j.data.length * 3) / 4) : (j.text || "").length, written, count: j.count };
    say(written ? (ids.length > 1 ? `Copied ${ids.length} layers as PNG` : "Copied as PNG") : "The browser did not allow the copy");
  }
  host.copyAs = copyAs;

  // Before structure.js's Cmd+C (which copies layers): Shift+Cmd+C is this key alone.
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || typing(e.target) || editingText()) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey || !e.shiftKey || e.code !== "KeyC" || e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    copyAs("png").catch((err) => say("Could not copy: " + err.message));
  }, true);
}
