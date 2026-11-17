// The page half of the layers panel (apps/macos/Layers.swift): a row click selects (several with Shift or Cmd),
// and the row under the pointer outlines its layer on the canvas, like a hover on the canvas does.
//   {cmd: "layers", op: "select", ids: [...]}   select these layers (none: deselect)
//   {cmd: "layers", op: "hover", id: "..." | null}
// Everything else (rename, hide, reorder) goes through the server's write paths from the shell.

const host = window.canvasHost;
if (host) {
  const view = host.view;
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;display:none;pointer-events:none;box-sizing:border-box;border:1px solid var(--c-sel)";
  view.insertBefore(box, document.getElementById("sel"));
  let hoverId = null;

  function place() {
    const cam = host.cam;
    const r = hoverId && cam ? host.worldRectOf(hoverId) : null;
    if (!r) { box.style.display = "none"; return; }
    box.style.borderColor = host.isCmp(hoverId) ? "var(--c-component)" : "var(--c-sel)";
    box.style.display = "block";
    box.style.left = r.x * cam.z + cam.x + "px";
    box.style.top = r.y * cam.z + cam.y + "px";
    box.style.width = r.w * cam.z + "px";
    box.style.height = r.h * cam.z + "px";
  }

  host.on("cam", () => { if (hoverId) place(); });
  host.on("cmd", (c) => {
    if (c.cmd !== "layers") return;
    if (c.op === "hover") {
      hoverId = typeof c.id === "string" && c.id ? c.id : null;
      place();
    } else if (c.op === "select") {
      const ids = Array.isArray(c.ids) ? c.ids.filter((x) => typeof x === "string" && x) : [];
      if (ids.length === 1) host.selectId(ids[0]);
      else host.setSelection(ids);
      if (hoverId && ids.includes(hoverId)) { hoverId = null; place(); }
    }
  });
}
