import { drawRect } from "./draw-logic.js";
import { BADGE, SPARK, sparkAt, visibleArea } from "./spark-logic.js";
import { STICKY_COLORS, STICKY_SIZE, STICKY_GAP, STICKERS, STICKER_SIZE, stackStickers, stickerGlyph,
  isStickyColor, isStickerKind, whiteboardPerson, WHITEBOARD_PAINT } from "./whiteboard-model.js";

const field = "input,textarea,select,[contenteditable]";
const insideChrome = "button,#rulerTop,#rulerLeft,#rulerCorner,[data-whiteboard-ui]," + field;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n) => Math.round(n * 1000) / 1000;
const get = (key) => { try { return localStorage.getItem("canvas:whiteboard:" + key); } catch { return null; } };
function remember(key, value) { try { localStorage.setItem("canvas:whiteboard:" + key, value); } catch { /* private browsing */ } }
export const icon = (path) => `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;

export function el(tag, cls, text) {
  const item = document.createElement(tag);
  if (cls) item.className = cls;
  if (text) item.textContent = text;
  return item;
}

export function button(label, cls, action) {
  const b = el("button", cls);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", action);
  return b;
}

function start(host) {
  const { view } = host;
  const layer = el("div", "whiteboard-layer");
  layer.style.setProperty("--wb-seal-size", STICKER_SIZE + "px");
  for (const [key, paint] of Object.entries(WHITEBOARD_PAINT)) layer.style.setProperty("--wb-" + key, paint);
  view.append(layer);
  // The canvas takes pointer capture for a pan. Controls need the matching release to receive a click.
  layer.addEventListener("pointerdown", (e) => e.stopPropagation());
  const ghost = el("div", "sticky-ghost");
  ghost.dataset.stickyGhost = "";
  ghost.hidden = true;
  const hint = el("div", "whiteboard-hint", "Click to place, drag to size");
  hint.hidden = true;
  const stickerGhost = el("div", "sticker-seal sticker-ghost");
  stickerGhost.hidden = true;
  const colors = el("div", "whiteboard-panel whiteboard-flyout");
  colors.dataset.whiteboardUi = "";
  colors.setAttribute("aria-label", "Sticky colours");
  colors.hidden = true;
  const tray = el("div", "whiteboard-panel whiteboard-flyout sticker-tray");
  tray.dataset.stickerTray = "";
  tray.dataset.whiteboardUi = "";
  tray.hidden = true;
  tray.append(el("div", "sticker-tray-title", "Stickers"));
  const grid = el("div", "sticker-tray-grid");
  tray.append(grid);
  const controls = el("div", "whiteboard-panel sticky-controls");
  controls.dataset.stickyControls = "";
  controls.dataset.whiteboardUi = "";
  controls.hidden = true;
  controls.addEventListener("pointerdown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  const sealLayer = el("div", "sticker-seals");
  const popover = el("div", "whiteboard-panel sticker-popover");
  popover.dataset.whiteboardUi = "";
  popover.hidden = true;
  layer.append(ghost, hint, stickerGhost, sealLayer, colors, tray, controls, popover);

  let tool = null, drag = null, point = null, pendingEdit = null;
  let color = get("color"), kind = get("sticker");
  if (!isStickyColor(color)) color = "yellow";
  if (!isStickerKind(kind)) kind = "agree";
  let byId = new Map(), stacks = new Map(), rendered = new Map();
  let open = null, pinned = false, popTimer = 0;
  let parentId = null;

  const scope = () => ({ page: host.page, gen: host.selGen });
  const current = ({ page, gen }) => host.page === page && host.selGen === gen;
  function author() {
    const name = host.prefs().whiteboardName?.trim();
    if (!name) return null;
    let id = get("person");
    if (!id) { id = crypto.randomUUID(); remember("person", id); }
    return whiteboardPerson({ name, id });
  }

  function swatches(onPick) {
    return Object.entries(STICKY_COLORS).map(([key, paint]) => {
      const b = button(key[0].toUpperCase() + key.slice(1), "sticky-swatch", () => onPick(key));
      b.style.setProperty("--wb-swatch", paint);
      b.dataset.color = key;
      return b;
    });
  }
  function mark(items, key, attr) {
    for (const item of items) item.setAttribute("aria-pressed", String(item.dataset[attr] === key));
  }
  const flyout = swatches((key) => {
    color = key;
    remember("color", key);
    mark(flyout, color, "color");
    preview();
  });
  const shortcut = el("kbd", "whiteboard-key", "S");
  colors.append(...flyout, shortcut);

  function choose(kindKey) {
    kind = kindKey;
    remember("sticker", kind);
    mark(choices, kind, "kind");
    stickerGhost.style.setProperty("--wb-sticker", STICKERS[kind].color);
    stickerGhost.innerHTML = stickerGlyph(kind);
    preview();
  }
  const choices = Object.entries(STICKERS).map(([key, art]) => {
    const b = button(art.label + " (" + art.key.toUpperCase() + ")", "sticker-choice", () => choose(key));
    b.dataset.kind = key;
    const seal = el("span", "sticker-seal");
    seal.style.setProperty("--wb-sticker", art.color);
    seal.innerHTML = stickerGlyph(key);
    b.append(seal);
    return b;
  });
  grid.append(...choices);

  function request(path, body) {
    return fetch(host.api(path), { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" },
      body: JSON.stringify({ file: host.file, ...body }) }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    });
  }

  function enterPending() {
    if (!pendingEdit) return;
    const { id, page, gen } = pendingEdit;
    if (!current({ page, gen }) || host.renderer !== "engine") { pendingEdit = null; return; }
    if (!host.engineView?.boardOf(id) || !host.worldRectOf(id) || !host.textEdit) return;
    pendingEdit = null;
    host.textEdit.enter(id, { all: true });
  }

  function add(node, parent, place = scope()) {
    const writing = request("/api/structure", { page: place.page, op: "add", nodes: [node], place: { parent }, allowOverlap: true })
      .then((data) => {
        if (!current(place)) return;
        host.setSelection(data.select);
        if (node.type === "sticky") {
          pendingEdit = { id: data.select[0], ...scope() };
          enterPending();
        }
      }).catch((error) => host.toast("Could not place " + node.type + ". " + error.message));
    host.trackWrite(writing);
    return writing;
  }

  function sceneNode(id) {
    const board = host.engineView?.boardOf(id), scene = board && host.live?.sceneOf(board);
    const find = (n) => n.id === id ? n : n.children?.map(find).find(Boolean);
    return scene?.root ? find(scene.root) : null;
  }

  function updateSticky(props) {
    const id = host.sel;
    if (host.readOnly || !id || !sceneNode(id)) return;
    const op = host.live.nextOp();
    host.live.override(id, props, op);
    const writing = request("/api/update", { id, props }).then(() => {
      host.live.ack(id, op, true);
      syncSticky();
    }).catch((error) => {
      host.live.ack(id, op, false);
      syncSticky();
      host.toast("Could not update sticky. " + error.message);
    });
    host.trackWrite(writing);
    host.textEdit?.focus();
  }

  const editSwatches = swatches((key) => updateSticky({ color: key }));
  const sizes = el("select", "sticky-size");
  sizes.title = "Text size";
  sizes.setAttribute("aria-label", "Sticky text size");
  sizes.addEventListener("change", () => updateSticky({ fontSize: Number(sizes.value) }));
  sizes.addEventListener("blur", () => { if (host.textEdit?.id === host.sel) host.textEdit.focus(); });
  const sizeOptions = [12, 15, 18, 24, 32];
  for (const size of sizeOptions) { const o = el("option", "", String(size)); o.value = String(size); sizes.append(o); }
  const showAuthor = button("Show author", "sticky-author", () => {
    const show = showAuthor.getAttribute("aria-pressed") !== "true";
    showAuthor.setAttribute("aria-pressed", String(show));
    updateSticky({ showAuthor: show });
  });
  showAuthor.innerHTML = icon("M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m12-13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z");
  controls.append(...editSwatches, sizes, showAuthor);
  const plus = (dir, label) => {
    const b = button(label, "sticky-next sticky-next-" + dir, () => next(host.sel, dir));
    b.dataset.stickyControls = "";
    b.dataset.whiteboardUi = "";
    b.innerHTML = icon("M12 5v14M5 12h14");
    b.hidden = true;
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    layer.append(b);
    return b;
  };
  const right = plus("right", "Next sticky to the right (Tab)");
  const below = plus("below", "Next sticky below");

  const screen = (x, y) => ({ x: host.cam.x + x * host.cam.z, y: host.cam.y + y * host.cam.z });
  const local = (e) => ({ x: e.clientX - host.viewBox.l, y: e.clientY - host.viewBox.t });
  const world = (p) => ({ x: (p.x - host.cam.x) / host.cam.z, y: (p.y - host.cam.y) / host.cam.z });
  const at = (item, x, y) => {
    const transform = `translate(${x}px,${y}px)`;
    if (item.style.transform !== transform) item.style.transform = transform;
  };
  function stickyBox(p) {
    const r = world(p);
    return { x: Math.round(r.x - STICKY_SIZE / 2), y: Math.round(r.y - STICKY_SIZE / 2), w: STICKY_SIZE, h: STICKY_SIZE };
  }
  function dragBox(d, p, square) {
    return drawRect(d.start, world(p), { square, snap: Math.round });
  }
  function placeSticky(r, parent, place, style = {}) {
    const box = parent && host.worldRectOf(parent);
    const me = author();
    return add({ type: "sticky", name: "Sticky", content: "", color, autoHeight: true,
      x: r.x - (box?.x ?? 0), y: r.y - (box?.y ?? 0), width: r.w, height: r.h, showAuthor: !!me,
      ...(me ? { author: me } : {}), ...(parent ? { layoutPosition: "absolute" } : {}), ...style }, parent, place);
  }

  async function next(id, dir) {
    if (host.readOnly || host.sel !== id || !host.cam) return;
    const n = sceneNode(id), r = host.worldRectOf(id);
    if (n?.type !== "sticky" || !r) return;
    const place = scope();
    const p = host.engineView?.parentOf(id) ?? null;
    if (host.textEdit?.id === id && !(await host.textEdit.flush())) return;
    if (!current(place)) return;
    const w = typeof n.width === "number" ? n.width : STICKY_SIZE;
    const h = typeof n.height === "number" ? n.height : w;
    const at = host.worldRectOf(id) ?? r;
    await placeSticky({ x: at.x + (dir === "right" ? at.w + STICKY_GAP : 0), y: at.y + (dir === "below" ? at.h + STICKY_GAP : 0), w, h }, p, place,
      { color: n.color ?? "yellow", ...(n.fontSize ? { fontSize: n.fontSize } : {}) });
  }

  function syncSticky() {
    parentId = null;
    const id = host.sel;
    const n = id && host.layerInfo(id)?.type === "sticky" && host.selection().length === 1 && !host.readOnly && sceneNode(id);
    if (n?.type === "sticky") {
      parentId = id;
      mark(editSwatches, n.color ?? "yellow", "color");
      const size = Number(n.fontSize) || 15;
      if (!sizeOptions.includes(size)) {
        if (sizes.lastElementChild?.dataset.custom) sizes.lastElementChild.remove();
        const option = el("option", "", String(size));
        option.dataset.custom = "";
        sizes.append(option);
      }
      sizes.value = String(size);
      showAuthor.disabled = !n.author;
      showAuthor.setAttribute("aria-pressed", String(!!n.author && n.showAuthor !== false));
    }
    positionSticky();
  }

  function positionSticky() {
    const r = !tool && !host.votes?.capturing() && parentId && !host.hand && !host.live?.busy && host.cam && host.worldRectOf(parentId);
    controls.hidden = right.hidden = below.hidden = !r;
    if (!r) return;
    const top = screen(r.x, r.y), bottom = screen(r.x + r.w, r.y + r.h);
    const width = controls.offsetWidth;
    at(controls, clamp((top.x + bottom.x - width) / 2, 4, Math.max(4, view.clientWidth - width - 4)), top.y > 52 ? top.y - 48 : top.y + 4);
    const box = { ...top, w: bottom.x - top.x, h: bottom.y - top.y };
    const spark = sparkAt(box, visibleArea({ w: view.clientWidth, h: view.clientHeight }, host.insets));
    at(right, bottom.x + 8, Math.max(spark ? spark.y + SPARK + 6 : top.y, (top.y + bottom.y) / 2 - 12));
    at(below, (top.x + bottom.x) / 2 - 12, bottom.y + BADGE + 4);
  }

  function preview() {
    ghost.hidden = hint.hidden = stickerGhost.hidden = true;
    if (!tool || !point || !host.cam || host.hand) return;
    if (tool === "sticker") {
      stickerGhost.hidden = false;
      at(stickerGhost, point.x - STICKER_SIZE / 2, point.y - STICKER_SIZE / 2);
      return;
    }
    const moved = drag?.moved;
    const r = moved ? dragBox(drag, point, drag.square) : stickyBox(drag?.point ?? point);
    const s = screen(r.x, r.y);
    ghost.hidden = false;
    ghost.style.setProperty("--wb-swatch", STICKY_COLORS[color]);
    ghost.style.width = r.w * host.cam.z + "px";
    ghost.style.height = r.h * host.cam.z + "px";
    ghost.style.transform = `translate(${s.x}px,${s.y}px) rotate(${moved ? 0 : 2}deg)`;
    hint.hidden = false;
    at(hint, s.x, s.y + r.h * host.cam.z + 10);
  }

  function reset() {
    if (!tool) return;
    const pointer = drag?.pointer;
    drag = null;
    tool = null;
    point = null;
    ghost.hidden = hint.hidden = stickerGhost.hidden = colors.hidden = tray.hidden = true;
    view.style.cursor = "";
    delete layer.dataset.placing;
    if (pointer !== undefined && view.hasPointerCapture(pointer)) view.releasePointerCapture(pointer);
    positionSticky();
    if (host.native) host.post({ drawTool: null });
  }

  function activate(type) {
    if (!host.doc || host.readOnly || host.textEdit?.active) return;
    reset();
    closePopover();
    host.emit("draw-tool", type);
    tool = type;
    layer.dataset.placing = "";
    view.style.cursor = "crosshair";
    if (type === "sticky") { mark(flyout, color, "color"); colors.hidden = false; }
    else { tray.hidden = false; choose(kind); }
    positionSticky();
    if (host.native) host.post({ drawTool: type });
  }

  function anchorTarget(e) {
    const id = host.pick(e.clientX, e.clientY);
    if (!id || byId.has(id) || id.startsWith("widget:")) return null;
    const rect = host.worldRectOf(id);
    if (!rect?.w || !rect.h) return null;
    return { id, rect, chain: host.chainOf(id) };
  }

  function placeSticker(e) {
    const target = anchorTarget(e);
    if (!target) { host.toast("Click a layer to place a sticker"); return; }
    const { id, rect, chain } = target;
    const p = world(local(e));
    const parent = chain.slice(0, -1).reverse().find((layer) => ["frame", "group"].includes(host.layerInfo(layer)?.type)) ?? null;
    const pr = parent && host.worldRectOf(parent);
    const me = author(), art = STICKERS[kind];
    add({ type: "sticker", name: art.label, kind, x: p.x - (pr?.x ?? 0) - STICKER_SIZE / 2, y: p.y - (pr?.y ?? 0) - STICKER_SIZE / 2, layoutPosition: "absolute",
      on: { layer: id, x: round(clamp((p.x - rect.x) / rect.w, 0, 1)), y: round(clamp((p.y - rect.y) / rect.h, 0, 1)) },
      ...(me ? { by: me } : {}) }, parent);
    reset();
  }

  function positionOf(sticker) {
    if (sticker.missingTarget) {
      const board = host.engineView?.boardOf(sticker.id) ?? host.chainOf(sticker.id)[0];
      if (!host.boards.has(board) || host.boards.get(board)?.gone || host.engineView?.isParked(board)) return null;
      const parent = sticker.parent && host.worldRectOf(sticker.parent);
      return { x: (parent?.x ?? 0) + sticker.x + STICKER_SIZE / 2, y: (parent?.y ?? 0) + sticker.y + STICKER_SIZE / 2 };
    }
    const id = sticker.on.layer;
    if (byId.has(id)) return null;
    const board = host.engineView?.boardOf(id) ?? host.chainOf(id)[0];
    if (!host.boards.has(board) || host.boards.get(board)?.gone || host.engineView?.isParked(board)) return null;
    const box = host.worldRectOf(id);
    if (!box) return null;
    return { x: box.x + box.w * sticker.on.x, y: box.y + box.h * sticker.on.y };
  }

  function rect(id) {
    const entry = byId.get(id);
    if (!entry || !host.cam) return null;
    const p = positionOf(entry);
    const size = STICKER_SIZE / host.cam.z;
    return p ? { x: p.x - size / 2, y: p.y - size / 2, w: size, h: size } : null;
  }

  function closePopover() {
    clearTimeout(popTimer);
    rendered.get(open)?.setAttribute("aria-expanded", "false");
    open = null;
    pinned = false;
    popover.hidden = true;
  }
  function laterClose() {
    clearTimeout(popTimer);
    if (!pinned) popTimer = setTimeout(closePopover, 100);
  }
  function showPopover(key) {
    clearTimeout(popTimer);
    const group = stacks.get(key);
    if (!group) return;
    rendered.get(open)?.setAttribute("aria-expanded", "false");
    open = key;
    rendered.get(key)?.setAttribute("aria-expanded", "true");
    const title = el("div", "sticker-popover-title", STICKERS[group[0].kind].label + " · " + group.length);
    const list = group.map((sticker) => {
      const row = el("div", "sticker-by");
      const name = sticker.by?.name ?? "Anonymous";
      row.append(el("span", "sticker-avatar", sticker.by ? Array.from(name)[0].toUpperCase() : ""), el("span", "", name));
      return row;
    });
    popover.replaceChildren(title, ...list);
    popover.hidden = false;
    positionSeals();
  }
  popover.addEventListener("pointerenter", () => clearTimeout(popTimer));
  popover.addEventListener("pointerleave", laterClose);

  function syncSeals(d) {
    const all = d?.boards?.flatMap((board) => board.stickers ?? []) ?? [];
    if (!all.length && !byId.size) return;
    stacks = stackStickers(all);
    byId = new Map([...stacks.values()].flatMap((group) => group.map((s) => [s.id, group[0]])));
    for (const [key, b] of rendered) if (!stacks.has(key)) { b.remove(); rendered.delete(key); }
    for (const [key, group] of stacks) {
      const [first] = group;
      const art = STICKERS[first.kind];
      let b = rendered.get(key);
      const title = art.label + (group.length > 1 ? " (" + group.length + ")" : "");
      if (!b) {
        b = button(title, "sticker-seal sticker-placed", () => {
          if (tool || host.votes?.active()) return;
          const items = stacks.get(key);
          if (!items) return;
          const pick = [...items].reverse().find((item) => !item.locked);
          if (pick) host.selectId(pick.id);
          if (open === key && pinned) closePopover();
          else { pinned = true; showPopover(key); }
        });
        b.dataset.stickerSeal = "";
        b.dataset.whiteboardUi = "";
        b.setAttribute("aria-expanded", "false");
        b.style.setProperty("--wb-sticker", art.color);
        b.innerHTML = stickerGlyph(first.kind);
        b.addEventListener("pointerenter", () => { if (!tool && !host.votes?.active() && (!pinned || open === key)) showPopover(key); });
        b.addEventListener("pointerleave", laterClose);
        b.addEventListener("focus", () => { if (!tool && !pinned) showPopover(key); });
        b.addEventListener("blur", laterClose);
        rendered.set(key, b);
        sealLayer.append(b);
      }
      b.dataset.stickerLayer = first.id;
      b.title = title;
      b.setAttribute("aria-label", title);
      let count = b.querySelector("[data-sticker-count]");
      if (group.length > 1) {
        if (!count) { count = el("span", "sticker-count"); count.dataset.stickerCount = ""; b.append(count); }
        count.textContent = String(group.length);
      } else count?.remove();
    }
    if (open && stacks.has(open)) showPopover(open);
    else if (open) closePopover();
    positionSeals();
  }

  function positionSeals() {
    if (!host.cam || !rendered.size) return;
    for (const [key, b] of rendered) {
      const r = positionOf(stacks.get(key)[0]);
      b.hidden = !r;
      if (!r) { if (open === key) closePopover(); continue; }
      const p = screen(r.x, r.y);
      at(b, p.x - STICKER_SIZE / 2, p.y - STICKER_SIZE / 2);
      if (open === key) {
        const width = popover.offsetWidth, height = popover.offsetHeight;
        at(popover, clamp(p.x + 22, 4, Math.max(4, view.clientWidth - width - 4)), clamp(p.y - 16, 4, Math.max(4, view.clientHeight - height - 4)));
      }
    }
  }

  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.(field) || host.textEdit?.active) return;
    const key = e.key.toLowerCase();
    if (host.votes?.capturing() && key !== "escape") return;
    if (key === "escape" && (tool || open)) { reset(); closePopover(); }
    else if (key === "s" && e.shiftKey) activate("sticker");
    else if (tool === "sticker" && !e.shiftKey) {
      const choice = Object.keys(STICKERS).find((k) => STICKERS[k].key === key);
      if (!choice) return;
      choose(choice);
    } else if (key === "s" && !e.shiftKey) activate("sticky");
    else if (key === "tab" && !e.shiftKey && parentId && !tool && !e.target.closest?.("[data-whiteboard-ui]")) next(parentId, "right");
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  addEventListener("pointerdown", (e) => {
    if (open && !popover.contains(e.target) && !e.target.closest?.("[data-sticker-seal]")) closePopover();
    if (!tool || drag || host.hand || host.readOnly || host.votes?.active() || !host.cam || e.button !== 0 || !view.contains(e.target) || e.target.closest(insideChrome)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (tool === "sticker") { placeSticker(e); return; }
    point = local(e);
    const hit = host.pick(e.clientX, e.clientY);
    const parent = (hit ? host.chainOf(hit) : []).reverse().find((id) => ["frame", "group"].includes(host.layerInfo(id)?.type)) ?? null;
    drag = { pointer: e.pointerId, point, start: world(point), parent, place: scope(), moved: false, square: e.shiftKey };
    view.setPointerCapture(e.pointerId);
    preview();
  }, true);

  function follow(e) {
    point = local(e);
    if (!drag) return;
    drag.moved ||= Math.hypot(point.x - drag.point.x, point.y - drag.point.y) >= 3;
    drag.square = e.shiftKey;
  }

  addEventListener("pointermove", (e) => {
    if (!tool || !host.cam || (drag && drag.pointer !== e.pointerId)) return;
    if (!drag && (!view.contains(e.target) || e.target.closest(insideChrome))) {
      point = null;
    } else follow(e);
    preview();
    if (drag) e.stopImmediatePropagation();
  }, true);

  addEventListener("pointerup", (e) => {
    if (drag?.pointer !== e.pointerId) return;
    e.stopImmediatePropagation();
    follow(e);
    const { parent, place, moved, square } = drag;
    const r = moved ? dragBox(drag, point, square) : stickyBox(point);
    reset();
    if (current(place) && !host.readOnly) placeSticky({ ...r, w: Math.max(48, r.w), h: Math.max(48, r.h) }, parent, place);
  }, true);
  const cancelled = (e) => { if (drag?.pointer === e.pointerId) reset(); };
  view.addEventListener("lostpointercapture", cancelled);
  addEventListener("pointercancel", cancelled, true);
  addEventListener("blur", () => { if (drag) reset(); });

  host.on("cmd", (c) => {
    if (c.cmd === "draw" && (c.type === "sticky" || c.type === "sticker")) activate(c.type);
    if (c.cmd === "cancelDraw") reset();
  });
  addEventListener("pagehide", reset);
  host.on("draw-tool", reset);
  host.on("document", syncSeals);
  host.on("page", () => { reset(); closePopover(); pendingEdit = null; syncSticky(); });
  host.on("tab", (shown) => { if (!shown) { reset(); closePopover(); pendingEdit = null; } });
  host.on("select", syncSticky);
  host.on("deselect", syncSticky);
  host.on("render", () => { enterPending(); syncSticky(); positionSeals(); });
  host.on("cam", preview);
  host.beforeFrame(() => { positionSticky(); positionSeals(); });
  host.whiteboard = { activate, next, rect, isSticker: (id) => byId.has(id) };
  syncSeals(host.doc);
}

const host = window.canvasHost;
if (host?.file) start(host);
