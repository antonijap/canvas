// The widget layer: live blocks (to-do, note, PostHog, shader, video) that sit on the canvas beside the
// boards. The page's inline script exposes `window.canvasHost`; this module adds one #wlayer to the
// world and keeps one .wd card per widget. Pan and zoom never touch widget DOM beyond one class
// toggle and lazy mounting; the camera transform on #world moves everything.

import { CARD_RADIUS, LEASE_MARGIN, MOUNT_MARGIN, NudgeQueue, camToReveal, idsInView, lodCrossing, moveRect, placeCentered, rectsIntersect, resizeRect, resizeZone, sameSet, viewToWorld, visibleWorldRect, ZONE_CURSOR } from "./geometry.js";
import { pageName } from "./widget-page.js";
import { updateWidgetAges } from "./widget-live.js";
import { localCard } from "./widget-local.js";
import { KINDS, rendererFor } from "./widget-kinds.js";

const host = window.canvasHost;
if (host && host.file) start(host);

function start(host) {
  const { view, world } = host;
  const selBox = document.getElementById("sel");
  const propsBody = document.getElementById("propsBody");
  const PREFIX = "widget:";
  const isW = (id) => typeof id === "string" && id.startsWith(PREFIX);
  const bare = (id) => (isW(id) ? id.slice(PREFIX.length) : id);

  const layer = document.createElement("div");
  layer.id = "wlayer";
  world.prepend(layer);

  let list = [];               // widgets in z-order, as the server sent them
  const entries = new Map();   // id -> { id, w, el, lod, body, impl, geom, key }
  const readings = new Map();  // id -> Reading
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");
  const kinds = new Map();     // kind id -> { defaultSize, minSize, title }
  let latestKinds = 0;
  let selId = null;            // bare id of the selected widget
  let clientId = null;
  let low = false;             // level-of-detail state
  let act = null;              // the move or resize in progress

  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  // ---------- network ----------
  async function call(method, path, body, headers) {
    const [route, query] = path.split("?");
    const r = await fetch(host.api(route) + (query ? "&" + query : ""), { method, headers: { "x-canvas": "1", "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, code: j.code });
    return j;
  }
  const fail = (what) => (e) => { toast(what + ": " + e.message); throw e; };

  // ---------- toast ----------
  const toastEl = h("div");
  toastEl.id = "wtoast";
  document.body.append(toastEl);
  let toastTimer = 0;
  function toast(text, undo, ms = 4000) {
    // In the app the shell's toast shows it (one look for every toast); Undo comes back through host.toast.
    if (host.native && host.toast) { host.toast(text, undo ? { actions: [{ label: "Undo", run: undo }] } : {}); return; }
    toastEl.textContent = "";
    toastEl.append(h("span", "", text));
    if (undo) {
      const b = h("button", "", "Undo");
      b.onclick = () => { hideToast(); undo(); };
      toastEl.append(b);
    }
    toastEl.style.display = "flex";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, undo ? 10000 : ms);
  }
  function hideToast() { clearTimeout(toastTimer); toastEl.style.display = "none"; }

  // ---------- entries ----------
  // A card linked to a node (a video placed with "Embed video here") shows over that node (src/page/videos.js).
  const shownRect = (w) => {
    const fit = w.kind === "note" && entries.get(w.id)?.fit;
    return host.widgetDisplayRect?.(w) || (fit ? { ...w, w: fit.w, h: fit.h } : w);
  };
  const setGeom = (e, w0) => {
    const w = shownRect(w0);
    const g = w.x + "," + w.y + "," + w.w + "," + w.h;
    if (e.geom === g) return;
    e.geom = g;
    e.el.style.left = w.x + "px";
    e.el.style.top = w.y + "px";
    e.el.style.width = w.w + "px";
    e.el.style.height = w.h + "px";
  };
  const skin = (e, w) => {
    e.el.dataset.kind = w.kind;
    e.el.dataset.tone = (w.config && w.config.tone) || "";
    e.el.classList.toggle("locked", !!w.locked);
    const name = w.kind === "note" ? pageName(w.config?.text || "") : w.name || w.kind;
    e.el.setAttribute("aria-label", name);
    if (e.lod.textContent !== name) e.lod.textContent = name;
  };

  // Each write the page makes to a card gets a number: an answer that comes back after a newer write to the same card
  // started is older than what the card shows (and what the server holds): it must not be drawn over it.
  const writeSeq = new Map(); // bare id -> number of the newest write
  const stampWrite = (id) => { const n = (writeSeq.get(id) || 0) + 1; writeSeq.set(id, n); return (w) => { if (writeSeq.get(id) === n) merge(w); }; };
  // Writes still out (drags, group moves): Undo waits for them, or it would run before them (src/server.ts).
  let writesOut = 0;
  const track = (p) => { writesOut++; const done = () => { writesOut--; if (host.writesSettled) host.writesSettled(); }; p.then(done, done); return p; };
  host.widgetWritesPending = () => writesOut > 0 || nudges.busy();
  function ctxFor(e) {
    return {
      widget: () => e.w,
      act: (name, args) => { const land = stampWrite(e.id); return call("POST", "/api/widgets/" + e.id + "/actions/" + name, args).then((r) => { land(r.widget); return r; }, fail("Could not save")); },
      // extra: geometry that goes in the same write (a note's growth), so it is one undo step with the change.
      patch: (config, extra) => { const land = stampWrite(e.id); return track(call("PATCH", "/api/widgets/" + e.id, { config, ...(extra || {}) }).then((r) => { land(r.widget); return r; }, fail("Could not save"))); },
      fit: (size, name) => {
        if (act?.entry === e || !size) return;
        e.fit = size;
        setGeom(e, e.w);
        e.lod.textContent = name;
        e.el.setAttribute("aria-label", name);
        if (e.id === selId) host.syncSel();
      },
      refresh: () => call("POST", "/api/widgets/" + e.id + "/refresh", {}).then(
        (r) => { if (r.data) host.widgetReading(e.id, r.data); }, fail("Could not refresh")),
      trust: (bundle, target) => call("POST", "/api/widgets/" + e.id + "/trust", { bundle, target }).then(() => bundle && loadKinds()).catch(fail("Could not allow")),
      renderer: (kind) => call("GET", "/api/widgets/local-renderer/" + encodeURIComponent(kind.id) + "?bundle=" + kind.bundle),
      native: host.native,
      theme: () => colorScheme.matches ? "dark" : "light",
      openLink: (value) => {
        if (typeof value !== "string") return;
        try {
          const url = new URL(value);
          if (url.protocol === "https:" || url.protocol === "http:") host.post({ widgetExternalURL: url.href });
        } catch {}
      },
      /** Text on the clipboard (the app's pasteboard in Canvas.app), and a "Copied" toast. */
      copy: (text) => {
        if (host.native) { host.post({ clipboard: text, toast: "Copied", toastIcon: "success" }); return; }
        const done = () => toast("Copied", null, 1500);
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast("Could not copy: select the command and copy it"));
      },
    };
  }

  setInterval(() => { if (!document.hidden) updateWidgetAges(); }, 5000);

  function unmount(e) {
    e.impl?.dispose?.();
    e.impl = null;
    e.mounted = false;
    e.body.replaceChildren();
  }
  function mount(e) {
    e.mounted = true;
    const kind = kinds.get(e.w.kind);
    const ctx = ctxFor(e);
    e.impl = kind?.local ? localCard(ctx, kind) : rendererFor(e.w.kind)(ctx);
    e.body.append(e.impl.el);
    e.key = keyOf(e.w);
    e.impl.update(e.w, readings.get(e.id));
  }
  const keyOf = (w) => JSON.stringify([w.name, w.w, w.h, w.config]);

  function createEntry(w) {
    const el = h("div", "wd");
    el.dataset.id = PREFIX + w.id;
    const lod = h("div", "wd-lod");
    const body = h("div", "wd-body");
    const handles = h("div", "wd-handles");
    for (const corner of ["tl", "tr", "bl", "br"]) handles.append(h("i", "wd-" + corner));
    const badge = h("div", "wd-size");
    badge.hidden = true;
    el.append(lod, body, handles, badge);
    const e = { id: w.id, w, el, lod, body, badge, impl: null, mounted: false, geom: "", key: "" };
    setGeom(e, w);
    skin(e, w);
    el.addEventListener("pointerdown", (ev) => onWidgetDown(ev, e));
    el.addEventListener("pointerup", (ev) => ev.stopPropagation());
    el.addEventListener("dblclick", () => e.impl && e.impl.dblclick && e.impl.dblclick());
    return e;
  }

  function updateEntry(e, w) {
    const prev = e.w;
    e.w = w;
    if (prev.kind !== w.kind) unmount(e);
    if (!(act && act.entry === e)) setGeom(e, w);
    skin(e, w);
    if (e.mounted) {
      const k = keyOf(w);
      if (k !== e.key) { e.key = k; e.impl.update(w, readings.get(e.id)); }
    }
  }

  // keep: the card only left the page shown; its reading stays, since the server sends a reading again only when it changes.
  function removeEntry(e, keep) {
    if (act && act.entry === e) endAct(true);
    unmount(e);
    e.el.remove();
    entries.delete(e.id);
    if (!keep) readings.delete(e.id);
    if (selId === e.id) host.clearSel();
  }

  /** Diff the server list against the DOM by id. Order of the list is the z-order. */
  // Widgets on another page are not drawn (absent page = the first page).
  const onPage = (w) => !host.widgetOnPage || host.widgetOnPage(w);
  const shown = () => list.filter(onPage);
  const shellWidgets = (widgets = shown()) => widgets.map((w) =>
    w.kind === "note" ? { ...w, ...shownRect(w), name: pageName(w.config?.text || "") } : w);
  host.widgetPageOf = (id) => { const w = list.find((x) => x.id === id); if (!w) return null; return host.pages && host.pages.some((p) => p.id === w.page) ? w.page : host.pages ? host.pages[0].id : null; };
  function render() {
    const here = shown();
    const seen = new Set(here.map((w) => w.id));
    for (const e of [...entries.values()]) if (!seen.has(e.id)) removeEntry(e, list.some((w) => w.id === e.id));
    here.forEach((w, i) => {
      let e = entries.get(w.id);
      if (!e) { e = createEntry(w); entries.set(w.id, e); } else updateEntry(e, w);
      if (layer.children[i] !== e.el) layer.insertBefore(e.el, layer.children[i] || null);
    });
    mountVisible();
    afterChange();
    host.emit("widgets", here);
  }
  function merge(w) {
    if (!w) return;
    const i = list.findIndex((x) => x.id === w.id);
    if (i < 0) list.push(w); else list[i] = w;
    render();
  }

  function mountVisible() {
    if (!host.cam) return;
    const area = visibleWorldRect(host.cam, view.clientWidth, view.clientHeight, MOUNT_MARGIN);
    // A linked card shows over its node, wherever its own x/y are: that is the rect that must be in view.
    for (const e of entries.values()) if (!e.mounted && rectsIntersect(area, shownRect(e.w))) mount(e);
  }
  let mountFrame = 0;
  const scheduleMount = () => { if (!mountFrame) mountFrame = requestAnimationFrame(() => { mountFrame = 0; mountVisible(); }); };

  /** A reading the page makes itself (shader cards: compile errors, playing, quarantined). */
  host.widgetReading = (id, r) => {
    readings.set(id, r);
    const e = entries.get(id);
    if (e && e.mounted && !(act && act.entry === e)) { setGeom(e, e.w); e.impl.update(e.w, r); }
    if (selId === id) { renderProps(); postStatus(); }
  };
  host.widgetsShown = () => shown();

  // ---------- selection ----------
  host.widgetRect = (id) => {
    const e = entries.get(bare(id));
    if (!e) return null;
    if (act && act.entry === e && act.rect) return act.rect;
    const r = shownRect(e.w);
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  };
  /** Linked cards moved with their node: place every card again. */
  host.widgetsRelayout = () => {
    for (const e of entries.values()) { if (act && act.entry === e) continue; setGeom(e, e.w); }
    host.syncSel();
  };
  let lastStatus = "";
  function postStatus() {
    if (!selId) return;
    const e = entries.get(selId), r = readings.get(selId);
    const live = e && (kinds.get(e.w.kind)?.live || e.w.kind === "shader" || e.w.kind === "video");
    const s = { id: selId, state: r ? r.state : live ? "loading" : "ok", error: r?.error, approvalTarget: r?.approvalTarget,
      display: r?.display, updatedAt: r?.updatedAt };
    const key = JSON.stringify(s);
    if (key === lastStatus) return;
    lastStatus = key;
    host.post({ widgetStatus: s });
  }
  function renderProps() {
    const e = selId && entries.get(selId);
    if (!e) return;
    propsBody.textContent = "";
    const r = readings.get(selId), w = { ...e.w, ...shownRect(e.w) };
    propsBody.append(h("h2", "", w.name || w.kind), h("div", "tid", w.kind + ", " + w.id + (w.locked ? ", locked" : "")));
    const sec = (title, rows) => { const d = h("div"); d.append(h("h4", "", title)); for (const [k, v] of rows) { if (v === undefined || v === null || v === "") continue; const row = h("div", "kv"); row.append(h("span", "k", k), h("span", "v", String(v))); d.append(row); } propsBody.append(d); };
    sec("Position & size", [["x", w.x], ["y", w.y], ["width", w.w], ["height", w.h]]);
    if (r) sec("Reading", [["state", r.state], ["value", r.display], ["error", r.error && r.error.message]]);
  }
  function afterChange() {
    const e = selId && entries.get(selId);
    selBox.classList.toggle("wsel", !!e);
    selBox.classList.toggle("lock", !!(e && e.w.locked));
    if (e) { host.syncSel(); renderProps(); postStatus(); }
    scheduleVis();
  }
  host.on("select", (id) => {
    // Several selected (cards among layers or boards): no single card owns the inspector or the Delete key.
    const many = host.selection && host.selection().length > 1;
    selId = isW(id) && !many ? bare(id) : null;
    lastStatus = "";
    afterChange();
  });
  host.on("deselect", () => { selId = null; afterChange(); });

  // ---------- move + resize ----------
  const minOf = (kind) => (kinds.get(kind) && kinds.get(kind).minSize) || { w: 100, h: 60 };
  function startAct(ev, a) {
    const s0 = shownRect(a.entry.w);
    act = { ...a, cx: ev.clientX, cy: ev.clientY, r0: { x: s0.x, y: s0.y, w: s0.w, h: s0.h }, rect: null, moved: false, frame: 0 };
    // The resize cursor stays for the whole drag, wherever the pointer goes.
    if (a.type === "resize") document.documentElement.style.cursor = ZONE_CURSOR[a.handle];
    window.addEventListener("pointermove", onActMove, true);
    window.addEventListener("pointerup", onActUp, true);
    window.addEventListener("pointercancel", onActCancel, true);
  }
  function onWidgetDown(ev, e) {
    if (ev.button !== 0 || host.hand) return; // Space held: the press pans, it does not pick or drag a card
    ev.stopPropagation();
    const wid = PREFIX + e.id;
    if (ev.shiftKey && host.toggleSel) {
      // Shift adds or removes it, like a layer; one just added drags with the rest of the selection.
      const had = host.selection ? host.selection().includes(wid) : false;
      host.toggleSel(wid);
      if (!had && host.selection && host.selection().length > 1 && host.beginGroupMove) host.beginGroupMove(ev);
      return;
    }
    const many = host.selection ? host.selection() : [];
    if (many.length > 1 && many.includes(wid)) { if (host.beginGroupMove) host.beginGroupMove(ev); return; }
    if (selId !== e.id) host.selectId(wid);
    if (e.w.locked) return;
    // The card's edges and corners resize it, selected or not: there are no handles to find first.
    const zone = zoneAt(e, ev);
    if (zone) { ev.preventDefault(); startAct(ev, { type: "resize", entry: e, handle: zone }); return; }
    if (ev.target.closest("[data-nodrag]")) return;
    startAct(ev, { type: "move", entry: e });
  }
  // A card's corners are rounded (CARD_RADIUS in world px, widgets.css .wd): a press outside the curve is not on the card.
  const zoneAt = (e, ev) => { const b = e.el.getBoundingClientRect(); return resizeZone(ev.clientX - b.left, ev.clientY - b.top, b.width, b.height, 6, CARD_RADIUS * host.cam.z); };
  // The resize cursor over a card's edges and corners (and nothing else of the card's changes).
  let cursorEl = null;
  const setCursor = (el, c) => { if (cursorEl && cursorEl !== el) cursorEl.style.cursor = ""; cursorEl = el; if (el) el.style.cursor = c; };
  layer.addEventListener("pointermove", (ev) => {
    if (act || ev.buttons || host.hand) return;
    const el = ev.target.closest && ev.target.closest(".wd");
    const e = el && entries.get(bare(el.dataset.id));
    const zone = e && !e.w.locked ? zoneAt(e, ev) : null;
    if (zone) setCursor(el, ZONE_CURSOR[zone]); else if (cursorEl) setCursor(null, "");
  });
  layer.addEventListener("pointerleave", () => { if (cursorEl && !act) setCursor(null, ""); });
  const HANDLES = ["tl", "tr", "bl", "br"];
  [...selBox.querySelectorAll("i")].forEach((i, n) => {
    i.addEventListener("pointerdown", (ev) => {
      const e = selId && entries.get(selId);
      if (!e || e.w.locked || ev.button !== 0 || host.hand) return;
      ev.stopPropagation();
      ev.preventDefault();
      startAct(ev, { type: "resize", entry: e, handle: HANDLES[n] });
    });
    i.addEventListener("pointerup", (ev) => ev.stopPropagation());
  });
  function onActMove(ev) {
    if (!act) return;
    let dxp = ev.clientX - act.cx, dyp = ev.clientY - act.cy;
    if (!act.moved && Math.hypot(dxp, dyp) < 3) return;
    // Shift on a move keeps the dominant axis only.
    const lock = act.type === "move" && ev.shiftKey ? (Math.abs(dxp) >= Math.abs(dyp) ? "y" : "x") : null;
    if (lock === "y") dyp = 0; else if (lock === "x") dxp = 0;
    act.moved = true;
    if (act.type === "move") act.dup = ev.altKey; // Option: drag a copy, the card stays
    const z = host.cam.z;
    act.rect = act.type === "move" ? moveRect(act.r0, dxp / z, dyp / z) : resizeRect(act.r0, act.handle, dxp / z, dyp / z, minOf(act.entry.w.kind), (act.entry.w.kind === "video" && !!act.entry.w.config?.src) || ev.shiftKey, ev.altKey, host.blueprintEdge(ev));
    if (act.type === "resize" && act.entry.w.kind === "note" && act.entry.impl?.measure) {
      const size = act.entry.impl.measure(act.rect.w);
      const dy = act.rect.h - size.h;
      if (ev.altKey) act.rect.y += Math.round(dy / 2);
      else if (act.handle.includes("t")) act.rect.y += dy;
      act.rect.h = size.h;
    }
    // A moved card snaps to boards and other cards like a board does (the page's snapping, src/page/snap.js).
    if (act.type === "move" && host.snapRect) {
      act.rect = host.snapRect(act.snap || (act.snap = host.snapBegin(PREFIX + act.entry.id)), act.rect, ev);
      if (lock === "y") act.rect.y = act.r0.y; else if (lock === "x") act.rect.x = act.r0.x;
    }
    // A shader card moved with Cmd held outlines the layer under the pointer: let go there and its shader is that
    // layer's fill (/page/drops.js), like a shader tile's Cmd-drop.
    if (shaderMove(act)) host.drops.overCard(ev, act.entry.el);
    if (!act.frame) act.frame = requestAnimationFrame(paintAct);
  }
  const shaderMove = (a) => !!(a && a.type === "move" && a.entry.w.kind === "shader" && host.drops && host.drops.overCard);
  function paintAct() {
    if (!act) return;
    act.frame = 0;
    const { entry, rect, r0 } = act;
    if (!rect) return;
    if (act.type === "move" && act.dup) { entry.el.style.transform = ""; ghostCards([entry.id], rect.x - r0.x, rect.y - r0.y); }
    else if (act.type === "move") { clearGhosts(); entry.el.style.transform = "translate(" + (rect.x - r0.x) + "px," + (rect.y - r0.y) + "px)"; }
    else {
      entry.badge.hidden = false;
      entry.badge.textContent = rect.w + " × " + rect.h;
      entry.el.classList.add("resizing");
      setGeom(entry, rect);
      if (entry.mounted && entry.w.kind !== "note") entry.impl.update({ ...entry.w, ...rect }, readings.get(entry.id));
    }
    host.emit("widgetMove", { id: entry.id, rect: { ...entry.w, ...rect } });
    host.syncSel();
  }
  function stopListening() {
    document.documentElement.style.cursor = "";
    window.removeEventListener("pointermove", onActMove, true);
    window.removeEventListener("pointerup", onActUp, true);
    window.removeEventListener("pointercancel", onActCancel, true);
  }
  /** Ends the gesture. `revert` puts the card back where it started. */
  function endAct(revert) {
    if (!act) return null;
    const a = act;
    act = null;
    stopListening();
    if (host.snapEnd) host.snapEnd();
    if (shaderMove(a)) host.drops.hide();
    cancelAnimationFrame(a.frame);
    clearGhosts();
    a.entry.el.style.transform = "";
    a.entry.badge.hidden = true;
    a.entry.el.classList.remove("resizing");
    if (revert || !a.rect) {
      a.entry.geom = "";
      setGeom(a.entry, a.entry.w);
      host.emit("widgetMove", { id: a.entry.id, rect: a.entry.w });
      if (a.entry.mounted) a.entry.impl.update(a.entry.w, readings.get(a.entry.id));
      host.syncSel();
      return null;
    }
    return a;
  }
  function onActUp(ev) {
    // Cmd over a layer: the card's shader becomes its fill and the card goes back where it was (one write).
    const to = act && act.moved && shaderMove(act) ? host.drops.overCard(ev, act.entry.el) : null;
    if (to) {
      const w = act.entry.w;
      endAct(true);
      host.drops.dropCard(w, to);
      return;
    }
    const a = endAct(false);
    if (!a) return;
    const e = a.entry, r = a.rect;
    if (a.type === "move" && a.dup) {
      // Option-drag: a copy lands where it was dropped, the card stays; the copy is selected.
      e.geom = "";
      setGeom(e, e.w);
      host.emit("widgetMove", { id: e.id, rect: e.w });
      host.syncSel();
      duplicateCards([PREFIX + e.id], r.x - a.r0.x, r.y - a.r0.y).then((made) => { if (made.length) host.selectId(made[0]); });
      return;
    }
    // A linked card that is dragged lets go of its node and keeps the rect it was dropped at.
    const linked = !!(e.w.config && e.w.config.link);
    const patch = a.type === "move" && !linked ? { x: r.x, y: r.y } : { x: r.x, y: r.y, w: r.w, h: r.h, ...(linked ? { config: { link: null } } : e.w.kind === "note" ? { config: { pageWidth: r.w } } : {}) };
    const was = e.w;
    e.w = { ...e.w, ...patch, ...(patch.config ? { config: { ...e.w.config, ...patch.config } } : {}) };
    e.geom = "";
    setGeom(e, e.w);
    e.key = keyOf(e.w);
    if (e.mounted) e.impl.update(e.w, readings.get(e.id));
    host.emit("widgetMove", { id: e.id, rect: e.w });
    host.syncSel();
    renderProps();
    scheduleVis();
    const land = stampWrite(e.id);
    track(call("PATCH", "/api/widgets/" + e.id, patch).then((res) => land(res.widget), (err) => {
      e.w = was;
      e.geom = "";
      setGeom(e, was);
      host.emit("widgetMove", { id: e.id, rect: was });
      if (e.mounted) e.impl.update(was, readings.get(e.id));
      host.syncSel();
      toast("Could not " + (a.type === "move" ? "move" : "resize") + ": " + err.message);
    }));
  }
  function onActCancel() { endAct(true); }
  // Pressing or letting go of Option mid-drag switches between moving the card and dragging a copy.
  const altFlip = (ev) => {
    if (ev.key !== "Alt" || !act || act.type !== "move" || !act.moved || act.dup === ev.altKey) return;
    act.dup = ev.altKey;
    if (!act.frame) act.frame = requestAnimationFrame(paintAct);
  };
  addEventListener("keydown", altFlip, true);
  addEventListener("keyup", altFlip, true);

  // ---------- Option-drag copies ----------
  // While a card is Option-dragged, a clone of it follows the pointer and the card stays (a copy drag).
  const ghosts = new Map(); // bare id -> clone element
  function ghostCards(ids, dx, dy) {
    for (const id of ids) {
      const e = entries.get(bare(id));
      if (!e) continue;
      let g = ghosts.get(e.id);
      if (!g) {
        g = e.el.cloneNode(true);
        g.removeAttribute("id");
        g.style.pointerEvents = "none";
        g.dataset.ghost = "1";
        // A canvas clones blank: copy what it shows now.
        const src = e.el.querySelectorAll("canvas"), dst = g.querySelectorAll("canvas");
        src.forEach((c, i) => { try { const d = dst[i]; d.width = c.width; d.height = c.height; d.getContext("2d").drawImage(c, 0, 0); } catch {} });
        layer.append(g);
        ghosts.set(e.id, g);
      }
      g.style.transform = "translate(" + dx + "px," + dy + "px)";
    }
  }
  function clearGhosts() { for (const g of ghosts.values()) g.remove(); ghosts.clear(); }
  /** Copies of cards moved by (dx, dy), one POST each. mergeKey ("group:...") joins them to the layers' duplicate: one undo step. Resolves to the copies' ids. */
  function duplicateCards(ids, dx, dy, mergeKey) {
    const pixel = !host.snap || host.snap().pixel;
    const headers = { "x-canvas-copy": "1", ...(mergeKey ? { "x-canvas-merge": mergeKey } : {}) };
    return track(Promise.all(ids.map((id) => {
      const e = entries.get(bare(id));
      if (!e) return null;
      const r = shownRect(e.w);
      let x = r.x + dx, y = r.y + dy;
      if (pixel) { x = Math.round(x); y = Math.round(y); }
      const config = Object.assign({}, e.w.config || {});
      if ("link" in config) config.link = null; // a copy of a linked video card is a free card where it was dropped
      const body = { kind: e.w.kind, name: e.w.name, x, y, w: r.w, h: r.h, config, ...(e.w.page ? { page: e.w.page } : {}) };
      // A shader card's source is a file named by its id: the server copies it (a plain POST would give the copy the template).
      const made = e.w.kind === "shader" ? call("POST", "/api/shaders", { copyFrom: e.id, name: e.w.name, x, y, w: r.w, h: r.h, ...(e.w.page ? { page: e.w.page } : {}) }, headers) : call("POST", "/api/widgets", body, headers);
      return made.then((j) => { merge(j.widget); return PREFIX + j.widget.id; }, (err) => { toast("Could not duplicate: " + err.message); return null; });
    }))).then((made) => { host.post({ widgets: shellWidgets() }); return made.filter(Boolean); });
  }

  // ---------- delete + undo ----------
  const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  async function removeSelected() {
    const e = entries.get(selId);
    if (!e) return;
    const snapshot = JSON.parse(JSON.stringify(e.w));
    let res;
    try { res = await call("DELETE", "/api/widgets/" + e.id); } catch (err) { toast("Could not delete: " + err.message); return; }
    list = list.filter((w) => w.id !== e.id);
    render();
    host.post({ widgets: shellWidgets() });
    toast("Widget deleted", async () => {
      try {
        const r = await call("POST", "/api/widgets", { ...snapshot, index: res.index }, { "x-canvas-copy": "1" });
        merge(r.widget);
        host.selectId(PREFIX + snapshot.id);
      } catch (err) { toast("Could not undo: " + err.message); }
    });
  }
  addEventListener("keydown", (ev) => {
    if (!selId || (ev.key !== "Delete" && ev.key !== "Backspace")) return;
    if (typing(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    removeSelected();
  });

  // ---------- add + reveal (native commands) ----------
  const sizeOf = (kind) => { const k = kinds.get(kind); return (k && k.defaultSize) || { w: 240, h: 200 }; };
  const pageField = () => { const first = host.pages && host.pages[0] && host.pages[0].id; return host.page && host.page !== first ? { page: host.page } : {}; };
  async function addWidget(kind, at = placeCentered(host.cam, view.clientWidth, view.clientHeight, host.insets, sizeOf(kind))) {
    try {
      const r = await call("POST", "/api/widgets", { kind, x: at.x, y: at.y, ...pageField() });
      merge(r.widget);
      host.selectId(PREFIX + r.widget.id);
    } catch (err) { toast("Could not add: " + err.message); }
  }
  /**
   * A row or shader tile dragged out of the shell's Widgets panel and dropped at (x, y), web view points: the
   * card's middle lands under the pointer, where the drag preview was. One
   * POST, so one undo step; the card is selected, the camera stays.
   */
  async function dropWidget(c) {
    const box = view.getBoundingClientRect(), vx = c.x - box.left, vy = c.y - box.top;
    // Over the shell's panels the card would land hidden under them: treat it as a cancelled drag.
    const ins = host.insets;
    if (vx < ins.l || vx > view.clientWidth - ins.r || vy < 0 || vy > view.clientHeight) return;
    const size = sizeOf(c.preset ? "shader" : c.kind), p = viewToWorld(host.cam, { x: vx, y: vy });
    const at = { x: Math.round(p.x - size.w / 2), y: Math.round(p.y - size.h / 2) };
    if (!c.preset) return addWidget(c.kind, at);
    try {
      const r = await call("POST", "/api/shaders", { preset: c.preset, x: at.x, y: at.y, ...pageField() });
      merge(r.widget);
      host.selectId(PREFIX + r.widget.id);
    } catch (err) { toast("Could not add: " + err.message); }
  }
  function reveal(id) {
    const e = entries.get(bare(id));
    if (!e) return;
    host.setCam(camToReveal(shownRect(e.w), view.clientWidth, view.clientHeight, host.insets, { maxZ: 1 }));
    host.selectId(PREFIX + e.id);
  }
  host.on("page", () => { render(); host.post({ widgets: shellWidgets() }); scheduleVis(); });
  host.on("resync", () => host.post({ widgets: shellWidgets() }));
  // The widget list can arrive before the page list decides which page shows (nothing matched yet): draw
  // again once boards are placed, when what this page shows differs from the cards on screen.
  host.on("visible", () => { const here = shown(); if (here.length !== entries.size || here.some((w) => !entries.has(w.id))) { render(); host.post({ widgets: shellWidgets(here) }); } });
  // ---------- nudge (arrow keys, sent by the page) ----------
  // The card moves now; the write follows, one at a time, the latest spot each time. The server folds a burst
  // into one undo step (x-canvas-merge: nudge).
  // Per card: a burst on one card and a press on another each get their own writes (geometry.js NudgeQueue).
  const patchAt = (id, at, mergeKey) => fetch(host.api("/api/widgets/" + id), { method: "PATCH", headers: { "x-canvas": "1", "x-canvas-merge": mergeKey, "content-type": "application/json" }, body: JSON.stringify({ x: at.x, y: at.y, ...(at.extra || {}) }) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }));
  const nudgeDone = () => { if (host.writesSettled) host.writesSettled(); };
  const nudges = new NudgeQueue((id, at) => patchAt(id, at, at.merge || "nudge"), (id, j) => { const land = nudgeLand.get(id); nudgeLand.delete(id); if (land) land(j.widget); nudgeDone(); },
    (id, err) => { toast("Could not move: " + err.message); call("GET", "/api/widgets/" + id).then((j) => merge(j.widget || j), () => {}); nudgeDone(); });
  nudges.busy = () => nudges.q.size > 0;
  const nudgeLand = new Map(); // id -> the newest press's stamp: its answer lands unless another write started since
  const sendNudge = (e, mergeKey, extra) => (nudgeLand.set(e.id, stampWrite(e.id)), nudges.push(e.id, { x: e.w.x, y: e.w.y, ...(mergeKey ? { merge: mergeKey } : {}), ...(extra ? { extra } : {}) }));
  host.on("nudge", ({ id, dx, dy, merge: mergeKey }) => {
    const e = entries.get(bare(id));
    if (!e || e.w.locked || act) return;
    const snap = host.snap ? host.snap() : { pixel: true };
    // A linked video card shows over its node: the arrows move what is shown, and the card lets go of its node
    // (like a drag), or the write would move its hidden x/y while it stays over the node.
    const linked = !!(e.w.config && e.w.config.link);
    const r = shownRect(e.w);
    let x = r.x + dx, y = r.y + dy;
    if (snap.pixel) { x = Math.round(x); y = Math.round(y); }
    const extra = linked ? { w: r.w, h: r.h, config: { link: null } } : null;
    e.w = linked ? { ...e.w, x, y, w: r.w, h: r.h, config: { ...e.w.config, link: null } } : { ...e.w, x, y };
    const i = list.findIndex((w) => w.id === e.id);
    if (i >= 0) list[i] = e.w;
    e.geom = "";
    setGeom(e, e.w);
    host.emit("widgetMove", { id: e.id, rect: e.w });
    host.syncSel();
    renderProps();
    sendNudge(e, mergeKey, extra);
  });

  // ---------- several selected, moved together (the page's drag, src/server.ts) ----------
  const movable = (id) => { const e = entries.get(bare(id)); return e && !e.w.locked ? e : null; };
  host.widgetGroup = {
    /** Show the cards moved by (dx, dy) world units, nothing written. (0, 0) puts them back. */
    preview(ids, dx, dy) {
      for (const id of ids) {
        const e = movable(id);
        if (!e) continue;
        const r = shownRect(e.w);
        e.el.style.transform = dx || dy ? "translate(" + dx + "px," + dy + "px)" : "";
        host.emit("widgetMove", { id: e.id, rect: { ...e.w, x: r.x + dx, y: r.y + dy, w: r.w, h: r.h } });
      }
    },
    /** Where the cards show now (a linked one over its node). */
    rects: (ids) => ids.map((id) => { const e = entries.get(bare(id)); return e ? { ...shownRect(e.w) } : null; }),
    /**
     * Write the move. mergeKey ("group:...") folds every write of the gesture (the layers' and boards' one too)
     * into one undo step. Each card shows at its new place now and goes back if its write fails.
     */
    commit(ids, dx, dy, mergeKey) {
      const pixel = !host.snap || host.snap().pixel;
      return track(Promise.all(ids.map((id) => {
        const e = movable(id);
        if (!e) return null;
        e.el.style.transform = "";
        const r = shownRect(e.w);
        let x = r.x + dx, y = r.y + dy;
        if (pixel) { x = Math.round(x); y = Math.round(y); }
        // A linked card that is dragged lets go of its node and keeps the rect it was dropped at (like onActUp).
        const linked = !!(e.w.config && e.w.config.link);
        const patch = linked ? { x, y, w: r.w, h: r.h, config: { link: null } } : { x, y };
        const was = e.w;
        e.w = { ...e.w, ...patch, ...(linked ? { config: { ...e.w.config, link: null } } : {}) };
        const i = list.findIndex((w) => w.id === e.id);
        if (i >= 0) list[i] = e.w;
        e.geom = "";
        setGeom(e, e.w);
        host.emit("widgetMove", { id: e.id, rect: e.w });
        const land = stampWrite(e.id);
        return fetch(host.api("/api/widgets/" + e.id), { method: "PATCH", headers: { "x-canvas": "1", "x-canvas-merge": mergeKey, "content-type": "application/json" }, body: JSON.stringify(patch) })
          .then((res) => res.json().then((j) => { if (!res.ok) throw new Error(j.error || res.statusText); land(j.widget); }))
          .catch((err) => {
            e.w = was;
            const k = list.findIndex((w) => w.id === e.id);
            if (k >= 0) list[k] = was;
            e.geom = "";
            setGeom(e, was);
            host.emit("widgetMove", { id: e.id, rect: was });
            toast("Could not move: " + err.message);
          });
      })));
    },
    /** Option-drag: clones of the cards moved by (dx, dy) while the cards stay; clear() takes them away. */
    ghost: (ids, dx, dy) => ghostCards(ids, dx, dy),
    clearGhost: () => clearGhosts(),
    duplicate: (ids, dx, dy, mergeKey) => duplicateCards(ids, dx, dy, mergeKey),
    /** Cards a paste just made (src/page/structure.js): shown now, before their widgets event arrives. */
    adopt(ws) { for (const w of ws) merge(w); host.post({ widgets: shellWidgets() }); },
    /** Delete cards (a multi-selection that holds some): one write each; mergeKey ("group:...") joins them to the layers' delete, one undo step. */
    remove(ids, mergeKey) {
      const headers = mergeKey ? { "x-canvas-merge": mergeKey } : undefined;
      return track(Promise.all(ids.map((id) => call("DELETE", "/api/widgets/" + bare(id), undefined, headers).then(() => { list = list.filter((w) => w.id !== bare(id)); }, (err) => toast("Could not delete: " + err.message))))
        .then(() => { render(); host.post({ widgets: shellWidgets() }); }));
    },
  };

  host.on("cmd", (c) => {
    if (c.cmd === "addWidget") addWidget(c.kind);
    else if (c.cmd === "dropWidget") dropWidget(c);
    else if (c.cmd === "widgetDrag") pendingDrag = { kind: c.kind, preset: c.preset, t: Date.now() };
    else if (c.cmd === "componentDrag") pendingDrag = null; // a component row's drag (/page/drops.js), not a card
    else if (c.cmd === "revealWidget") reveal(c.id);
  });

  // A Widgets panel row or shader tile dragged from the shell: WebKit shows the page the drag as "Files" with no
  // data, so the shell says which card it is when the drag starts (cmd widgetDrag) and the page drops it where the
  // pointer lets go. A drag that ends elsewhere is forgotten at the next press or after a minute.
  let pendingDrag = null;
  const dragLive = () => pendingDrag && Date.now() - pendingDrag.t < 60000;
  addEventListener("pointerdown", () => { pendingDrag = null; }, true);
  // Cmd held over a layer: a shader tile becomes that layer's fill instead of a card (/page/drops.js).
  host.tileDragLive = dragLive;
  addEventListener("dragover", (e) => { if (dragLive()) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; if (host.drops && pendingDrag.preset) host.drops.overTile(e); } });
  addEventListener("drop", (e) => {
    if (!dragLive()) return;
    e.preventDefault();
    const d = pendingDrag; pendingDrag = null;
    if (host.drops && host.drops.dropTile(e, d)) return;
    dropWidget({ kind: d.kind, preset: d.preset, x: e.clientX, y: e.clientY });
  });

  // ---------- camera: level of detail + lazy mount ----------
  host.on("cam", () => {
    const next = lodCrossing(low, host.cam.z);
    if (next !== null) { low = next; layer.classList.toggle("lod", low); }
    scheduleMount();
  });
  low = host.cam ? host.cam.z < 0.25 : false;
  layer.classList.toggle("lod", low);

  // ---------- visibility lease ----------
  let visTimer = 0, lastIds = null;
  const wantIds = () => (document.hidden || !host.cam ? [] : idsInView(shown().map((w) => ({ ...shownRect(w), id: w.id })), host.cam, view.clientWidth, view.clientHeight, LEASE_MARGIN));
  function postVis(force) {
    if (!clientId) return;
    const ids = wantIds();
    if (!force && lastIds && sameSet(ids, lastIds)) return;
    lastIds = ids;
    fetch(host.api("/api/widgets/visibility"), { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ clientId, ids }) }).then((r) => r.arrayBuffer()).catch(() => {});
  }
  function scheduleVis() { clearTimeout(visTimer); visTimer = setTimeout(() => postVis(false), 300); }
  host.on("visible", scheduleVis);
  setInterval(() => { if (!document.hidden) postVis(true); }, 45000);
  document.addEventListener("visibilitychange", () => { clearTimeout(visTimer); postVis(false); });

  // ---------- server events ----------
  let lastWarning = "";
  function onEvent(name, data) {
    let d;
    try { d = JSON.parse(data); } catch { return; }
    if (name === "hello") {
      clientId = d.clientId;
      lastIds = null;
      postVis(true);
    } else if (name === "widgets") {
      list = Array.isArray(d.widgets) ? d.widgets.slice() : [];
      if (list.some((w) => !Object.hasOwn(KINDS, w.kind) && !kinds.has(w.kind))) void loadKinds();
      // A nudge still being written: the card stays where the arrow keys put it.
      list = list.map((w) => { const at = nudges.held(w.id); return at ? { ...w, x: at.x, y: at.y } : w; });
      render();
      host.post({ widgets: shellWidgets() });
      if (d.warning && d.warning !== lastWarning) toast(d.warning, null, 8000);
      lastWarning = d.warning || "";
    } else if (name === "wdata") {
      for (const [id, r] of Object.entries(d)) {
        readings.set(id, r);
        const e = entries.get(id);
        if (e && e.mounted && !(act && act.entry === e)) e.impl.update(e.w, r);
      }
      if (selId && d[selId]) { renderProps(); postStatus(); }
    }
  }
  const early = host.early || [];
  host.early = null;
  for (const [n, data] of early) onEvent(n, data);
  for (const n of ["hello", "widgets", "wdata"]) host.es.addEventListener(n, (e) => onEvent(n, e.data));

  async function loadKinds() {
    const seq = ++latestKinds;
    try {
      const next = await call("GET", "/api/widgets/kinds?view=picker");
      if (seq !== latestKinds) return;
      const old = new Map(kinds);
      kinds.clear();
      for (const k of next) kinds.set(k.id, k);
      for (const e of entries.values()) {
        const before = old.get(e.w.kind);
        const after = kinds.get(e.w.kind);
        if (before?.bundle !== after?.bundle) readings.delete(e.id);
        if (before?.bundle !== after?.bundle || before?.approved !== after?.approved) unmount(e);
      }
      mountVisible();
    } catch {}
  }
  setInterval(() => {
    if (!document.hidden && list.some((w) => !Object.hasOwn(KINDS, w.kind))) void loadKinds();
  }, 5000);
  colorScheme.addEventListener("change", () => {
    for (const e of entries.values()) {
      if (e.mounted && kinds.get(e.w.kind)?.local) e.impl.update(e.w, readings.get(e.id));
    }
  });
  void loadKinds();
}
