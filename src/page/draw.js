import { drawRect } from "./draw-logic.js";
import { bypassSnap, guidesFor, nearestLine, SNAP_PX } from "./snap.js";

const tools = { KeyF: "frame", KeyR: "rectangle", KeyO: "ellipse", KeyT: "text" };
const names = { frame: "Frame", rectangle: "Rectangle", ellipse: "Ellipse", text: "Text" };
const field = "input,textarea,select,[contenteditable]";
const host = window.canvasHost;

if (host?.file) {
  const view = document.getElementById("view");
  const preview = document.createElement("div");
  preview.id = "draw-preview";
  const size = document.createElement("span");
  size.id = "draw-size";
  preview.append(size);
  view.append(preview);

  let tool = null, drag = null, textToEdit = null;

  function reset() {
    if (!tool) return;
    const pointer = drag?.pointer;
    tool = null;
    drag = null;
    preview.style.display = "none";
    view.style.cursor = "";
    host.clearGuides();
    if (pointer !== undefined && view.hasPointerCapture(pointer)) view.releasePointerCapture(pointer);
  }

  function activate(type, target) {
    if (!Object.hasOwn(names, type) || !host.doc || host.readOnly || host.textEdit?.active || target?.closest?.(field)) return false;
    reset();
    textToEdit = null;
    tool = type;
    view.style.cursor = "crosshair";
    return true;
  }

  function world(x, y) {
    const c = host.cam, box = host.viewBox;
    return { x: (x - box.l - c.x) / c.z, y: (y - box.t - c.y) / c.z };
  }

  function geometry(e, click = false) {
    const config = host.snap();
    const grid = host.blueprintEdge(e);
    const index = !grid && config.objects && !bypassSnap(e) ? drag.index : null;
    const snap = grid || ((v, axis) => {
      const lines = index?.[axis].v;
      const n = lines ? nearestLine(lines, v, SNAP_PX / host.cam.z) : -1;
      const value = n < 0 ? v : lines[n];
      return config.pixel ? Math.round(value) : value;
    });
    const end = click ? drag.start : world(e.clientX, e.clientY);
    const r = drawRect(drag.start, end, { square: e.shiftKey, centered: e.altKey, click: click && tool !== "text", snap });
    return { r, guides: index && config.guides ? guidesFor(index, r) : [] };
  }

  function paint(e) {
    const { r, guides } = geometry(e);
    const c = host.cam;
    Object.assign(preview.style, {
      display: "block", left: r.x * c.z + "px", top: r.y * c.z + "px",
      width: r.w * c.z + "px", height: r.h * c.z + "px",
      borderRadius: tool === "ellipse" ? "50%" : "",
    });
    size.textContent = host.dimText(r);
    host.paintGuides(guides);
  }

  // The write can return before the changed board has landed from the document stream.
  function editNewText() {
    if (!textToEdit) return;
    const { id, page, gen } = textToEdit;
    if (host.page !== page || host.selGen !== gen || host.renderer !== "engine" || document.activeElement?.closest(field)) { textToEdit = null; return; }
    if (!host.engineView?.isLoaded(host.engineView.boardOf(id))) return;
    textToEdit = null;
    host.textEdit?.enter(id, { all: true });
  }

  host.on("page", () => { reset(); textToEdit = null; });
  host.on("tab", (shown) => { if (!shown) { reset(); textToEdit = null; } });
  host.on("render", editNewText);
  host.on("cmd", (c) => { if (c.cmd === "draw") activate(c.type, document.activeElement); });
  addEventListener("blur", () => { if (drag) reset(); });

  function modifier(e) {
    if (drag?.moved && (e.key === "Shift" || e.key === "Alt" || e.key === "Control" || e.key === "Meta")) {
      paint({ clientX: drag.x, clientY: drag.y, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
    }
  }
  addEventListener("keyup", modifier, true);
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.target.closest?.(field) || host.textEdit?.active || e.isComposing) return;
    modifier(e);
    if (e.key === "Escape" && tool) {
      reset();
    } else if (drag || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !activate(tools[e.code], e.target)) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  addEventListener("pointerdown", (e) => {
    if (!tool || drag || host.hand || host.readOnly || host.textEdit?.active || !host.cam || e.button !== 0 || !view.contains(e.target)) return;
    if (e.target.closest("button,#rulerTop,#rulerLeft,#rulerCorner," + field)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const hit = host.pick(e.clientX, e.clientY);
    const parent = hit && host.chainOf(hit).find((id) => {
      const type = host.boards.get(id)?.meta.type;
      return type === "frame" || type === "group";
    });
    if (tool === "rectangle" && !parent) { host.toast("Draw a rectangle inside a board"); return; }
    drag = {
      start: world(e.clientX, e.clientY), originX: e.clientX, originY: e.clientY,
      page: host.page, parent, parentBox: host.boxOf(parent), gen: host.selGen,
      index: host.drawSnapIndex(parent), pointer: e.pointerId, moved: false,
    };
    view.setPointerCapture(e.pointerId);
  }, true);

  function follow(e) {
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.moved ||= Math.hypot(drag.x - drag.originX, drag.y - drag.originY) >= 3;
  }

  addEventListener("pointermove", (e) => {
    if (e.pointerId !== drag?.pointer) return;
    e.stopImmediatePropagation();
    follow(e);
    if (drag.moved) paint(e);
  }, true);

  addEventListener("pointerup", (e) => {
    if (e.pointerId !== drag?.pointer) return;
    e.stopImmediatePropagation();
    follow(e);
    const { parent, parentBox, page, gen, moved } = drag;
    const type = tool, isText = type === "text", isFrame = type === "frame", isBoard = isFrame && !parent;
    const { r } = geometry(e, !moved);
    reset();
    if (host.readOnly || host.page !== page || (moved && (r.w < 1 || (!isText && r.h < 1)))) return;
    const textStyle = isText ? {
      content: "Text", fontFamily: "system-ui", fontSize: 16,
      fill: parent ? "#18181B" : getComputedStyle(view).getPropertyValue("--c-fg").trim(),
      textGrowth: moved ? "fixed-width" : "auto",
      ...(moved ? { width: r.w } : {}),
    } : null;
    const node = {
      type,
      name: isBoard ? "Board" : names[type],
      x: r.x - (parentBox?.x ?? 0), y: r.y - (parentBox?.y ?? 0),
      ...(textStyle ?? { width: r.w, height: r.h }),
      ...(isFrame ? { layout: "none", children: [], ...(isBoard ? { fill: "#FFFFFF" } : {}) } : !isText ? { fill: "#BFBFC4" } : {}),
      ...(parent ? { layoutPosition: "absolute" } : {}),
    };
    const write = fetch(host.api("/api/structure"), {
      method: "POST",
      headers: { "x-canvas": "1", "content-type": "application/json" },
      body: JSON.stringify({ file: host.file, page, op: "add", nodes: [node], place: { parent: parent || null } }),
    }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (host.page !== page || host.selGen !== gen) return;
      host.setSelection(result.select);
      if (isText && !tool) {
        textToEdit = { id: result.select[0], page, gen: host.selGen };
        editNewText();
      }
    }).catch((error) => host.toast("Could not draw layer: " + error.message));
    host.trackWrite(write);
  }, true);

  const cancel = (e) => { if (e.pointerId === drag?.pointer) reset(); };
  view.addEventListener("lostpointercapture", cancel);
  addEventListener("pointercancel", cancel, true);
}
