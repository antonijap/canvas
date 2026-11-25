// Drops on the canvas (the rules are in /page/drop-logic.js):
// - A shader tile from the Widgets panel: over a frame, rectangle or ellipse it outlines that layer, and the drop
//   makes the shader its fill. Over empty canvas, or with Option held, the drop adds a shader card (/page/widgets.js).
// - A shader card already on the canvas, dragged with Cmd held: the same outline, and the drop makes the card's
//   shader (its Paper preset, or its WGSL) that layer's fill; the card goes back where it was. Without Cmd the card
//   just moves, and a tip at the pointer says Cmd fills the layer under it.
// - Image files from Finder (PNG, JPEG, GIF, WebP, SVG): a plain drop adds image layers where they land, side by
//   side, inside the frame under the pointer. A Cmd-drop onto a layer makes the first image its fill (cover).
// - Cmd+V of an image on the pasteboard (a screenshot): an image layer in the middle of the view, in the selected
//   frame when one is selected. The app sends it as {cmd: "pasteImage"}; a browser's paste event carries the file.
// - Place Image (Shift+Cmd+K): a file picker for images; they go side by side where a pasted image goes. The app's
//   File menu runs the system's open panel and sends {cmd: "placeImages"}; a browser tab opens its own picker.
// - A row of the shell's Components panel: an instance of that component where it lands (its middle under the
//   pointer), inside the frame under the pointer (an auto layout frame: at the slot under the pointer). Holding Option
//   over an instance outlines it, and the drop swaps that instance (a nested one too) to the component.
// - Space held ("keep the parent when adding"): a drop, a pasted or placed image does not go into a frame.
// Every drop is one write, so one undo step. Image bytes go into the document's media folder first (src/images.ts).
import { cardFill, centredAt, dropParent, fillTarget, flowIndex, imageFill, imageLayerSize, isImageFile, shaderFill, sideBySide, swapTarget, tileTarget, withFill } from "./drop-logic.js";

const host = window.canvasHost;
if (host) {
  const view = host.view;
  const box = document.createElement("div");
  box.id = "droptarget";
  // The canvas selection blue, thin, the layer's own bounds; it never takes the pointer.
  box.style.cssText = "position:absolute;display:none;pointer-events:none;border:2px solid var(--c-sel);box-sizing:border-box;z-index:4";
  view.appendChild(box);
  // A shader card moved without Cmd over a layer it could fill: a tip at the pointer says how (the Spark's tip look).
  const tip = document.createElement("div");
  tip.id = "drophint";
  tip.className = "sk-tip";
  tip.style.cssText = "position:fixed;display:none;z-index:40";
  tip.innerHTML = '<span>Hold</span><span class="sk-keys dark"><span class="sk-cap one"><b>⌘</b></span></span><span>to fill</span>';
  document.body.appendChild(tip);
  const showTip = (cx, cy) => { tip.style.left = cx + 14 + "px"; tip.style.top = cy + 18 + "px"; tip.style.display = "flex"; };
  const hideTip = () => { tip.style.display = "none"; };
  let shown = null, hideT = 0;

  const ev = () => host.engineView;
  const infoOf = (id) => (ev() && ev().infoOf ? ev().infoOf(id) : null);
  const typeOf = (id) => (infoOf(id) || {}).type || null;
  const cmdOf = (e) => !!((e && e.metaKey) || (host.cmdHeld && host.cmdHeld()));
  const altOf = (e) => !!((e && e.altKey) || (host.altHeld && host.altHeld()));
  const toast = (text) => { if (host.native) host.post({ toast: text }); else console.warn("[canvas] " + text); };
  const toWorld = (cx, cy) => {
    const vb = host.viewBox || { l: 0, t: 0 }, c = host.cam;
    return { x: (cx - vb.l - c.x) / c.z, y: (cy - vb.t - c.y) / c.z };
  };
  const chainAt = (cx, cy) => {
    const leaf = host.pick ? host.pick(cx, cy) : null;
    if (!leaf || leaf.startsWith("widget:")) return [];
    return host.chainOf ? host.chainOf(leaf) : [leaf];
  };
  /** The layer a Cmd-drop at (cx, cy) window px fills, or null. */
  const targetAt = (cx, cy) => fillTarget(chainAt(cx, cy), typeOf, host.sel);
  /** targetAt with element `el` (a dragged card) looked through. */
  const targetUnder = (cx, cy, el) => {
    if (!el) return targetAt(cx, cy);
    const was = el.style.pointerEvents;
    el.style.pointerEvents = "none";
    try { return targetAt(cx, cy); } finally { el.style.pointerEvents = was; }
  };

  function show(id) {
    clearTimeout(hideT);
    // A drag that leaves the window sends no more events: the outline goes after a moment without one.
    hideT = setTimeout(hide, 400);
    if (id === shown) return place();
    shown = id;
    place();
  }
  function place() {
    const r = shown && host.cam ? host.worldRectOf(shown) : null;
    if (!r) { box.style.display = "none"; return; }
    const c = host.cam;
    box.style.display = "block";
    box.style.left = r.x * c.z + c.x + "px";
    box.style.top = r.y * c.z + c.y + "px";
    box.style.width = r.w * c.z + "px";
    box.style.height = r.h * c.z + "px";
  }
  function hide() { clearTimeout(hideT); shown = null; box.style.display = "none"; hideTip(); }
  host.on("cam", () => { if (shown) place(); });

  async function json(r) {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { code: j.code });
    return j;
  }
  const post = (path, body) => fetch(path, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) }).then(json);
  const track = (p) => (host.trackWrite ? host.trackWrite(p) : p);

  /** Put `fill` on top of layer `id`'s fills (one write: an override inside an instance). */
  function applyFill(id, fill) {
    return track((async () => {
      const n = await fetch(host.api("/api/node") + "&id=" + encodeURIComponent(id) + "&depth=0").then(json);
      const cur = n.node && n.node.fill !== undefined ? n.node.fill : n.resolved ? n.resolved.fill : undefined;
      await post("/api/update", { file: host.file, id, props: { fill: withFill(cur, fill) }, ...(n.revision ? { expectedRevision: n.revision } : {}) });
      host.selectId(id);
    })()).catch((err) => toast("Could not fill: " + err.message));
  }

  /** Copy image files into the document; their urls and sizes, in order. Files that are not images are left out. */
  async function upload(files) {
    const out = [];
    for (const f of files) {
      if (!isImageFile(f)) continue;
      const r = await fetch(host.api("/api/images") + "&name=" + encodeURIComponent(f.name || "image.png"), { method: "POST", headers: { "x-canvas": "1", "content-type": f.type || "application/octet-stream" }, body: f }).then(json);
      out.push({ ...r, name: (f.name || "Image").replace(/\.[A-Za-z0-9]{1,5}$/, "") || "Image" });
    }
    return out;
  }

  /** Image layers for `imgs` around world point `at`, in frame `parent` (null: the canvas). One write. */
  async function addImageLayers(imgs, at, parent) {
    const spots = sideBySide(imgs.map((m) => imageLayerSize(m.width, m.height)), at);
    const pr = parent ? host.worldRectOf(parent) : null;
    const nodes = imgs.map((m, i) => ({
      type: "rectangle", name: m.name, x: spots[i].x - (pr ? pr.x : 0), y: spots[i].y - (pr ? pr.y : 0), width: spots[i].w, height: spots[i].h, fill: imageFill(m.url),
    }));
    const r = await post("/api/structure", { file: host.file, page: host.page || undefined, op: "add", nodes, place: { parent: parent || null } });
    if (Array.isArray(r.select) && r.select.length) host.setSelection(r.select);
    return r;
  }

  async function dropFiles(files, cx, cy, cmd) {
    const images = files.filter(isImageFile);
    if (!images.length) { toast(files.length ? "Only images (PNG, JPEG, GIF, WebP, SVG) can be dropped on the canvas" : "Nothing to drop"); return; }
    const target = cmd ? targetAt(cx, cy) : null;
    const chain = target ? null : chainAt(cx, cy);
    const at = toWorld(cx, cy);
    return track((async () => {
      const imgs = await upload(target ? images.slice(0, 1) : images);
      if (!imgs.length) return;
      if (target) {
        await applyFill(target, imageFill(imgs[0].url));
        return;
      }
      await addImageLayers(imgs, at, dropParent(chain, infoOf, !!host.hand));
    })()).catch((err) => toast("Could not add the image: " + err.message));
  }

  /**
   * Images added without a pointer (Cmd+V of a picture, Place Image): image layers side by side in the middle of the
   * view, or in the selected frame. Space held: "keep the parent when adding", not in the frame.
   */
  async function placeImages(files, what) {
    const c = host.cam;
    if (!c) return;
    const vb = host.viewBox || { l: 0, t: 0 };
    const mid = toWorld(vb.l + view.clientWidth / 2, vb.t + view.clientHeight / 2);
    const sel = !host.hand && host.sel && !host.sel.startsWith("widget:") && !host.sel.includes("/") ? host.sel : null;
    const info = sel ? infoOf(sel) : null;
    const parent = info && info.type === "frame" && !info.instance ? sel : null;
    const pr = parent ? host.worldRectOf(parent) : null;
    const at = pr ? { x: pr.x + pr.w / 2, y: pr.y + pr.h / 2 } : mid;
    return track((async () => {
      const imgs = await upload(files);
      if (!imgs.length) { toast(files.length ? "Only images (PNG, JPEG, GIF, WebP, SVG) can be placed" : "Nothing to place"); return; }
      await addImageLayers(imgs, at, parent);
    })()).catch((err) => toast(`Could not ${what} the image: ` + err.message));
  }
  /** A pasted image (bytes, its type): one image layer in the middle of the view, in the selected frame if any. */
  const pasteImage = (blob, name, at) => {
    const files = [new File([blob], name || "Pasted image.png", { type: blob.type || "image/png" })];
    return at ? dropFiles(files, at.x, at.y, false) : placeImages(files, "paste");
  };

  // ---------- shader tiles (called by /page/widgets.js, which owns the tile drag) ----------
  host.drops = {
    /** A shader tile dragged over the canvas: outline the layer it would fill (none with Option held). */
    overTile(e) {
      const id = tileTarget(chainAt(e.clientX, e.clientY), typeOf, host.sel, altOf(e));
      if (id) show(id); else hide();
    },
    /** A shader tile dropped: true when it became a layer's fill (the caller adds no card). */
    dropTile(e, d) {
      const id = d && d.preset ? tileTarget(chainAt(e.clientX, e.clientY), typeOf, host.sel, altOf(e)) : null;
      hide();
      if (!id) return false;
      applyFill(id, shaderFill(d.preset));
      return true;
    },
    /**
     * A shader card on the canvas moved with Cmd held (/page/widgets.js owns the card drag): the layer under the
     * pointer it would fill, outlined, or null (the outline goes). The card itself is under the pointer, so it is
     * looked through while picking.
     */
    overCard(e, el) {
      const under = targetUnder(e.clientX, e.clientY, el);
      const id = cmdOf(e) ? under : null;
      if (id) { show(id); hideTip(); return id; }
      hide();
      if (under) showTip(e.clientX, e.clientY);
      return null;
    },
    /** A shader card let go over layer `id` with Cmd: its shader becomes the layer's fill (one write); the card stays. */
    async dropCard(w, id) {
      hide();
      return track((async () => {
        const c = (w && w.config) || {};
        const source = c.paper ? null : await fetch(host.api("/api/shaders/" + encodeURIComponent(w.id) + "/source")).then((r) => (r.ok ? r.text() : null));
        const fill = cardFill(c, source);
        if (!fill) throw new Error("the card has no shader yet");
        await applyFill(id, fill);
      })()).catch((err) => toast("Could not fill: " + err.message));
    },
    hide,
    targetAt,
    dropFiles,
    pasteImage,
    placeImages,
    choose: () => choose(),
  };

  // ---------- Place Image (Shift+Cmd+K): a file picker for images ----------
  // The app's File > Place Image runs the system's open panel and sends the files as {cmd: "placeImages"}; a browser
  // tab opens its own file picker.
  const picker = document.createElement("input");
  picker.type = "file";
  picker.id = "placeimage";
  picker.multiple = true;
  picker.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.png,.jpg,.jpeg,.gif,.webp,.svg";
  picker.style.display = "none";
  document.body.appendChild(picker);
  picker.addEventListener("change", () => {
    const files = [...(picker.files || [])];
    picker.value = "";
    if (files.length) placeImages(files, "place");
  });
  function choose() { picker.click(); }
  addEventListener("keydown", (e) => {
    const t = e.target;
    if (host.native || !(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || (e.code !== "KeyK" && e.key !== "K" && e.key !== "k")) return;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    choose();
  });

  // ---------- a component from the Components panel ----------
  // WebKit shows the page a drag from the shell as "Files" without its data, so the shell says which component it is
  // when the drag starts ({cmd: "componentDrag", id, name}); the page drops it where the pointer lets go. A drag that
  // ends elsewhere is forgotten at the next press or after a minute. Option held over an instance: that instance
  // swaps to the component (outlined while the pointer is over it).
  let pendingComp = null;
  const compLive = () => !!pendingComp && Date.now() - pendingComp.t < 60000;
  /** The instance an Option-drop at (cx, cy) window px swaps, or null. */
  const swapAt = (cx, cy) => swapTarget(chainAt(cx, cy), infoOf);
  /** A frame as drawn (its scene node, children included), for the flow slot a drop takes in it. */
  const drawnFrame = (id) => {
    const L = host.live;
    if (!L || !L.sceneOf || !L.boardOf) return null;
    const b = L.boardOf(id), sc = b ? L.sceneOf(b) : null;
    let hit = null;
    const seek = (n) => {
      if (hit || !n || typeof n !== "object") return;
      if (String(n.id) === id) { hit = n; return; }
      for (const c of Array.isArray(n.children) ? n.children : []) seek(c);
    };
    seek(sc && sc.root);
    return hit;
  };
  /** The component's size as drawn (its main on a loaded board), else its numeric width and height from the file. */
  async function sizeOf(id) {
    const r = host.worldRectOf(id);
    if (r) return { w: r.w, h: r.h };
    const n = await fetch(host.api("/api/node") + "&id=" + encodeURIComponent(id) + "&depth=0").then(json).catch(() => null);
    const w = n && n.node && n.node.width, h = n && n.node && n.node.height;
    return typeof w === "number" && typeof h === "number" ? { w, h } : null;
  }

  /** A component dropped at (cx, cy) window px: an instance there (one write), or with Option a swap of the instance. */
  function dropComponent(comp, cx, cy, alt) {
    const target = alt ? swapAt(cx, cy) : null;
    if (target) {
      return track(post("/api/overrides/swap", { file: host.file, ids: [target], component: comp.id }).then((j) => {
        if (!j.changed) return;
        if (j.dropped && j.dropped.length) toast(`Swapped. Not carried over: ${j.dropped.slice(0, 3).join(", ")}${j.dropped.length > 3 ? ` and ${j.dropped.length - 3} more` : ""}`);
        host.selectId(target);
      })).catch((err) => toast("Could not swap: " + err.message));
    }
    // Over the shell's panels the instance would land hidden under them: a cancelled drag.
    const box = view.getBoundingClientRect(), ins = host.insets || { l: 0, r: 0 };
    const vx = cx - box.left, vy = cy - box.top;
    if (vx < ins.l || vx > view.clientWidth - ins.r || vy < 0 || vy > view.clientHeight) return;
    const at = toWorld(cx, cy);
    const parent = dropParent(chainAt(cx, cy), infoOf, !!host.hand);
    return track((async () => {
      const frame = parent ? drawnFrame(parent) : null;
      const index = frame ? flowIndex(frame, (id) => host.worldRectOf(id), at) : null;
      const node = { type: "ref", ref: comp.id };
      if (index === null) {
        const spot = centredAt(at, await sizeOf(comp.id));
        const pr = parent ? host.worldRectOf(parent) : null;
        node.x = spot.x - (pr ? Math.round(pr.x) : 0);
        node.y = spot.y - (pr ? Math.round(pr.y) : 0);
      }
      const r = await post("/api/structure", { file: host.file, page: host.page || undefined, op: "add", nodes: [node], place: { parent: parent || null, ...(index !== null ? { index } : {}) } });
      if (Array.isArray(r.select) && r.select.length) host.setSelection(r.select);
    })()).catch((err) => toast("Could not add the instance: " + err.message));
  }
  host.on("cmd", (c) => {
    if (c.cmd === "componentDrag" && typeof c.id === "string") pendingComp = { id: c.id, name: c.name || "", t: Date.now() };
    else if (c.cmd === "widgetDrag") pendingComp = null;
  });
  addEventListener("pointerdown", () => { pendingComp = null; }, true);
  addEventListener("dragover", (e) => {
    if (!compLive()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const id = altOf(e) ? swapAt(e.clientX, e.clientY) : null;
    if (id) show(id); else hide();
  }, true);
  addEventListener("drop", (e) => {
    if (!compLive()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    hide();
    const c = pendingComp;
    pendingComp = null;
    dropComponent(c, e.clientX, e.clientY, altOf(e));
  }, true);

  // ---------- files from Finder ----------
  const tileDrag = (e) => !!host.tileDragLive?.(e);
  const hasFiles = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"));
  addEventListener("dragover", (e) => {
    if (tileDrag(e) || !hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const id = cmdOf(e) ? targetAt(e.clientX, e.clientY) : null;
    if (id) show(id); else hide();
  });
  addEventListener("dragleave", (e) => { if (!e.relatedTarget) hide(); });
  addEventListener("drop", (e) => {
    // A sidebar tile's drop (its promised file reads as "Files" too) was taken by /page/widgets.js already.
    if (e.defaultPrevented || tileDrag(e) || !hasFiles(e)) return;
    e.preventDefault();
    hide();
    const files = [...(e.dataTransfer.files || [])];
    dropFiles(files, e.clientX, e.clientY, cmdOf(e));
  });
  addEventListener("pointerdown", hide, true);

  // ---------- paste (a browser's paste event; the app sends {cmd: "pasteImage"}) ----------
  const b64bytes = (data) => { const bin = atob(data), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return bytes; };
  addEventListener("paste", (e) => {
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
    const d = e.clipboardData;
    if (!d) return;
    const text = d.getData("text/plain") || "";
    // Canvas's own layers and cards (/page/structure.js: a marker in the HTML part, or the older marker text) win.
    if (text.startsWith("canvas-clipboard:") || (d.getData("text/html") || "").includes("data-canvas-clipboard")) return;
    const img = [...(d.files || [])].find(isImageFile);
    if (!img) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    pasteImage(img, img.name);
  }, true);
  host.on("cmd", (c) => {
    if (c.cmd === "placeImages" && Array.isArray(c.files)) {
      try {
        placeImages(c.files.filter((f) => f && typeof f.data === "string").map((f) => new File([b64bytes(f.data)], f.name || "Image.png", { type: f.type || "image/png" })), "place");
      } catch (err) { toast("Could not place the image: " + err.message); }
      return;
    }
    if (c.cmd !== "pasteImage" || typeof c.data !== "string") return;
    try {
      const bin = atob(c.data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      pasteImage(new Blob([bytes], { type: c.type || "image/png" }), c.name || "Pasted image.png", c.at);
    } catch (err) { toast("Could not paste the image: " + err.message); }
  });
}
