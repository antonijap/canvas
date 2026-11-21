// Blueprint drawing. A frame drawn on empty canvas becomes a board.
const host = window.canvasHost;
if (host && host.file) {
  const view = document.getElementById("view");
  const preview = document.createElement("div");
  preview.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:4;box-shadow:inset 0 0 0 1px var(--c-sel)";
  view.append(preview);
  let tool = null, drag = null;

  function activate(type) {
    if (!host.doc || host.readOnly || !host.pages.find((p) => p.id === host.page)?.pattern) return;
    tool = type;
    view.style.cursor = "crosshair";
  }
  function reset() {
    if (!tool) return;
    tool = null;
    drag = null;
    preview.style.display = "none";
    view.style.cursor = "";
  }
  function world(x, y) {
    const c = host.cam, box = host.viewBox;
    return { x: (x - box.l - c.x) / c.z, y: (y - box.t - c.y) / c.z };
  }
  function drawRect(e) {
    const snap = host.blueprintEdge(e) || (host.snap().pixel ? Math.round : (v) => v);
    const p = world(e.clientX, e.clientY);
    const x0 = snap(drag.start.x), x1 = snap(p.x), y0 = snap(drag.start.y), y1 = snap(p.y);
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }

  host.on("page", reset);
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.target.closest?.("input,textarea,[contenteditable]") || host.textEdit?.active) return;
    if (e.key === "Escape" && tool) {
      e.preventDefault();
      e.stopImmediatePropagation();
      reset();
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (e.code === "KeyF") activate("frame");
      if (e.code === "KeyR") activate("rectangle");
    }
  }, true);
  addEventListener("pointerdown", (e) => {
    if (!tool || host.hand || !host.cam || e.button !== 0 || !view.contains(e.target)) return;
    if (e.target.closest("button,input,textarea,[contenteditable]")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const hit = host.pick(e.clientX, e.clientY);
    const parent = (hit ? host.chainOf(hit) : []).find((id) => host.boards.has(id));
    const parentBox = parent ? host.boxOf(parent) : null;
    if (tool === "rectangle" && !parentBox) { host.toast("Draw a rectangle inside a board"); return; }
    drag = { start: world(e.clientX, e.clientY), page: host.page, parent, parentBox, gen: host.selGen };
    view.setPointerCapture(e.pointerId);
  }, true);
  addEventListener("pointermove", (e) => {
    if (!drag) return;
    e.stopImmediatePropagation();
    const r = drawRect(e), c = host.cam;
    Object.assign(preview.style, {
      display: "block", left: r.x * c.z + c.x + "px", top: r.y * c.z + c.y + "px",
      width: r.w * c.z + "px", height: r.h * c.z + "px",
    });
  }, true);
  addEventListener("pointerup", (e) => {
    if (!drag) return;
    e.stopImmediatePropagation();
    const { parent, parentBox, page, gen } = drag;
    const r = drawRect(e), type = tool;
    reset();
    if (r.w < 1 || r.h < 1 || host.readOnly || host.page !== page) return;
    const node = {
      type, name: type === "rectangle" ? "Rectangle" : parent ? "Frame" : "Board",
      x: r.x - (parentBox?.x ?? 0), y: r.y - (parentBox?.y ?? 0), width: r.w, height: r.h,
      ...(type === "frame" ? { layout: "none", children: [], ...(parent ? {} : { fill: "#FFFFFF" }) } : { fill: "#BFBFC4" }),
      ...(parent ? { layoutPosition: "absolute" } : {}),
    };
    const write = fetch(host.api("/api/structure"), {
      method: "POST",
      headers: { "x-canvas": "1", "content-type": "application/json" },
      body: JSON.stringify({ file: host.file, page, op: "add", nodes: [node], place: { parent: parent ?? null } }),
    }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (host.page === page && host.selGen === gen) host.setSelection(result.select);
    }).catch((error) => host.toast("Could not draw layer: " + error.message));
    host.trackWrite(write);
  }, true);
  addEventListener("pointercancel", reset, true);
}
