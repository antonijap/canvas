import { segmentEase } from "./motion-logic.js";
import { addKey, addTimelineProperty, availableTimelineProperties, axisInset, editTrack, keyValue, moveKeys, removeKey, rulerStep, timelineLayers, timelineProperties, trackValue, zoomAtTime } from "./timeline-logic.js";

const paths = {
  play: "M3 2.3c0-.6.7-.9 1.2-.6l7.3 4.7c.4.3.4.9 0 1.2l-7.3 4.7c-.5.3-1.2 0-1.2-.6z",
  pause: "M4.5 2v10m5-10v10",
  chevron: "m3.5 5.5 3.5 3 3.5-3",
  loop: "M10 1l2.5 2.5L10 6m2.5-2.5H4.7a3 3 0 0 0-3 3M4 13l-2.5-2.5L4 8m-2.5 2.5h7.8a3 3 0 0 0 3-3",
  close: "m3.5 3.5 7 7m0-7-7 7",
};
const props = { translateX: "Translate X", translateY: "Translate Y", scale: "Scale", scaleX: "Scale X", scaleY: "Scale Y", rotate: "Rotate", opacity: "Opacity" };
const easings = { linear: "Linear", ease: "Ease", easeIn: "Ease in", easeOut: "Ease out", easeInOut: "In out" };
const modes = [["easeOut", "Ease out"], ["easeInOut", "In out"], ["spring", "Spring"], ["curve", "Curve"]];
const defaultCurve = [0.25, 0.1, 0.25, 1];
const defaultSpring = { stiffness: 320, damping: 18, mass: 1 };
const triggers = [["boardHover", "On board hover"], ["hover", "On layer hover", true], ["press", "On press", true], ["appear", "On appear", true]];
const leaves = ["reverse", "reset", "hold"].map(value => [value, "On leave: " + value]);
const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
const digits = (v, places = 3) => Number(v.toFixed(places)).toString();
const display = v => v.replace(/^-/, "−");
const seconds = t => (t / 1000).toFixed(2) + " s";
const svg = (tag, attrs) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
function element(tag, cls, content) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (content !== undefined) el.textContent = content;
  return el;
}
function button(cls, text, label) {
  const el = element("button", cls, text);
  el.type = "button";
  if (label) { el.setAttribute("aria-label", label); el.title = label; }
  return el;
}
function icon(name) {
  const el = svg("svg", { class: "mt-icon", viewBox: "0 0 14 14", "aria-hidden": true });
  el.append(svg("path", { d: paths[name], fill: "none", stroke: "currentColor", "stroke-width": 1.1, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  return el;
}
function picker(label, options) {
  const box = element("label", "mt-picker"), select = element("select");
  select.setAttribute("aria-label", label);
  for (const [value, label, disabled] of options) {
    const option = element("option", "", label);
    option.value = value;
    option.disabled = !!disabled;
    select.append(option);
  }
  box.append(select, icon("chevron"));
  return { box, select };
}
function pickValue(select, value, options) {
  select.querySelector("[data-unknown]")?.remove();
  if (!options.some(option => option[0] === value)) {
    const option = element("option", "", value);
    option.value = value;
    option.disabled = true;
    option.dataset.unknown = "";
    select.append(option);
  }
  select.value = value;
}
function easeMode(ease) {
  if (ease?.spring) return "spring";
  if (Array.isArray(ease)) return "curve";
  return ease;
}
function easeName(ease) {
  const spring = ease?.spring;
  if (spring?.stiffness !== undefined) return "Spring " + digits(spring.stiffness) + ", " + digits(spring.damping);
  if (spring) return "Spring";
  if (Array.isArray(ease)) return "Curve";
  return Object.hasOwn(easings, ease) ? easings[ease] : (ease || "Linear");
}
function springSettings(spring) {
  if (spring.stiffness !== undefined) return spring;
  const omega = 2 * Math.PI / (spring.response ?? 1);
  const ratio = spring.dampingFraction ?? (spring.bounce >= 0 ? 1 - spring.bounce : 1 / Math.max(0.001, 1 + spring.bounce));
  return { stiffness: omega ** 2, damping: 2 * omega * ratio, mass: 1 };
}
function curveGraph(ease) {
  const graph = svg("svg", { class: "mt-curve", viewBox: "0 0 256 92", preserveAspectRatio: "none", role: "img", "aria-label": "Easing curve" });
  const samples = Array.from({ length: 97 }, (_, i) => i / 96).map(segmentEase(ease));
  const points = Array.isArray(ease) ? ease : [];
  const low = Math.min(0, ...samples, points[1] ?? 0, points[3] ?? 0);
  const high = Math.max(1, ...samples, points[1] ?? 1, points[3] ?? 1);
  const x = p => 8 + 240 * p, y = p => 82 - 72 * ((p - low) / (high - low));
  graph.append(svg("path", { d: `M8 ${y(1)}H248`, fill: "none", stroke: "#ffffff1a" }));
  for (let i = 0; i < points.length; i += 2) {
    graph.append(svg("path", { d: `M${x(i / 2)} ${y(i / 2)}L${x(points[i])} ${y(points[i + 1])}`, stroke: "#a1a1aa", fill: "none" }));
  }
  graph.append(svg("polyline", {
    points: samples.map((v, i) => `${digits(x(i / 96))},${digits(y(v))}`).join(" "),
    fill: "none", stroke: "currentColor", "stroke-width": 1.25, "vector-effect": "non-scaling-stroke",
  }));
  for (let i = 0; i < points.length; i += 2) {
    graph.append(svg("circle", { cx: x(points[i]), cy: y(points[i + 1]), r: 4, fill: "#a1a1aa", stroke: "#232326", class: "mt-handle", "data-handle": i }));
  }
  return { graph, low, high };
}
function numberField(label, value, commit, disabled, suffix = "") {
  const field = element("label", "mt-field", label), input = element("input");
  const reset = v => { input.value = display(digits(v, 6)) + suffix; };
  input.inputMode = "decimal";
  input.disabled = disabled;
  reset(value);
  input.onfocus = () => input.select();
  input.onchange = () => {
    const raw = input.value.replace(/−/g, "-").trim().replace(/\s*ms$/i, "");
    const next = raw && Number(raw);
    reset(Number.isFinite(next) ? commit(next) : value);
  };
  input.onkeydown = e => {
    if (e.code === "Enter" || e.code === "Escape") {
      const panel = input.closest(".motion-timeline");
      if (e.code === "Escape") reset(value);
      e.preventDefault(); e.stopPropagation();
      input.blur(); panel?.focus({ preventScroll: true });
    }
  };
  field.append(input);
  return field;
}

function installTimeline(host) {
  const panel = element("section", "motion-timeline");
  panel.setAttribute("aria-label", "Motion timeline");
  panel.tabIndex = -1;
  panel.inert = true;
  const header = element("div", "mt-header");
  const play = button("mt-play", "", "Play timeline"), loop = button("mt-loop", "", "Loop preview"), close = button("mt-close", "", "Close timeline");
  play.append(icon("play")); loop.append(icon("loop")); close.append(icon("close"));
  loop.setAttribute("aria-pressed", "false");
  const timeText = element("span", "mt-time"), now = element("span"), total = element("span", "mt-total");
  timeText.append(now, total);
  const trigger = picker("Trigger", triggers), leave = picker("On leave", leaves);
  header.append(play, timeText, trigger.box, leave.box, element("div", "mt-spacer"), loop, close);
  const body = element("div", "mt-body"), trackArea = element("div", "mt-track-area");
  const tracks = element("div", "mt-tracks"), sheet = element("div", "mt-sheet");
  const rulerLine = element("div", "mt-line mt-ruler-line"), label = element("div", "mt-label"), ruler = element("div", "mt-axis mt-ruler");
  const handle = button("mt-head", "", "Playhead");
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-valuemin", "0");
  rulerLine.append(label, ruler);
  ruler.append(handle);
  const rows = element("div"), playhead = element("div", "mt-playhead"), inspector = element("div", "mt-inspector");
  sheet.append(rulerLine, rows, playhead);
  tracks.append(sheet); trackArea.append(tracks); body.append(trackArea, inspector); panel.append(header, body);

  let open = false, shown = !document.hidden, selected = null, dismissed = false, manual = false, model = null, request = null, unwatch = null;
  let layers = [], byId = new Map(), rowId, keyIndex = 0, collapsed = new Set(), readouts = [];
  let scale = 1, length = 0, time = 0, loopPreview = false, frame = 0, started = 0, drag = null, pinchScale = 1;
  let controls = null, resize = null, curl = null;
  const axisX = t => axisInset + t * scale;
  const selectedRow = () => byId.get(rowId);
  const seek = t => { time = clamp(t, 0, length); updateTime(); if (model) host.motion?.seek(model.board, time); };
  const writable = () => !host.readOnly && !!model && !model.failed;

  function place() {
    const rect = host.view.getBoundingClientRect(), { l, r } = host.insets;
    const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--c-inset")) || 10;
    panel.style.left = rect.left + (host.native ? l || 0 : 0) + "px";
    panel.style.right = innerWidth - rect.right + (host.native && r > inset ? r : 0) + "px";
    drawRuler();
  }
  function show(on) {
    if (open === on) return;
    open = on;
    if (on) {
      if (!panel.isConnected) document.body.append(panel);
      place();
      controls = new AbortController();
      const { signal } = controls;
      addEventListener("resize", place, { signal });
      document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); }, { signal });
      resize = new ResizeObserver(place);
      resize.observe(host.view);
    } else {
      pause();
      host.motion?.clearSeek();
      if (drag && panel.hasPointerCapture(drag.pointer)) panel.releasePointerCapture(drag.pointer);
      drag = null;
      controls?.abort(); controls = null;
      resize?.disconnect(); resize = null;
    }
    panel.inert = !on;
    panel.toggleAttribute("data-open", on);
    const height = on ? panel.offsetHeight : 0;
    host.emit("timeline", height);
    if (host.native) host.post({ timelineHeight: height });
  }

  function watch(on) {
    if (!on) { unwatch?.(); unwatch = null; return; }
    unwatch ??= host.on("document", () => refresh());
  }
  function selection(id) {
    if (id?.startsWith("widget:")) id = host.selection().findLast(id => !id.startsWith("widget:")) ?? null;
    if (id === selected) return;
    selected = id;
    dismissed = manual = false;
    request?.abort(); request = null;
    show(false);
    model = null; rowId = undefined; keyIndex = 0; collapsed = new Set(); time = 0; scale = 1;
    tracks.scrollLeft = tracks.scrollTop = 0;
    watch(!!id && shown);
    refresh();
  }
  function dismiss() {
    dismissed = true;
    manual = false;
    watch(false);
    request?.abort(); request = null;
    show(false);
  }
  function toggle() {
    if (open || manual) dismiss();
    else openSelected(selected);
  }
  function openSelected(id) {
    if (!id || id !== selected) return;
    manual = true;
    dismissed = false;
    watch(shown);
    if (open) {
      const layer = layers.find(layer => layer.id === id);
      const row = layer?.rows[0];
      rowId = row?.id;
      keyIndex = row ? row.keys.length - 1 : 0;
      collapsed.delete(id);
      rebuild();
      focusLayer();
    } else refresh(true, true);
  }
  function focusLayer() {
    panel.focus({ preventScroll: true });
    Array.from(rows.children).find(line => line.dataset.layerId === selected)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  async function refresh(force = false, focus = false) {
    if (!selected || dismissed || !shown || model?.pending || drag) return;
    const key = model?.board ? host.boards.get(model.board)?.meta.key : undefined;
    if (!force && (request || (model && key === model.key))) return;
    request?.abort();
    const controller = new AbortController();
    const requestedRevision = host.doc?.revision;
    let overtaken = false;
    request = controller;
    try {
      const response = await fetch(host.api("/api/motion-timeline") + "&id=" + encodeURIComponent(selected), { signal: controller.signal });
      if (!response.ok) throw new Error("Could not read motion");
      const next = await response.json();
      if (controller.signal.aborted) return;
      const currentKey = next.board ? host.boards.get(next.board)?.meta.key : undefined;
      overtaken = next.key !== currentKey && host.doc?.revision !== requestedRevision;
      model = { ...next, pending: 0 };
      rebuild();
      if (focus && open) focusLayer();
    } catch (err) {
      if (!controller.signal.aborted && open) host.toast(err.message);
    } finally {
      if (request === controller) request = null;
      if (overtaken) refresh();
    }
  }
  function rebuild() {
    layers = timelineLayers(model?.root, selected);
    byId = new Map(layers.flatMap(layer => layer.rows.map(row => [row.id, row])));
    const row = selectedRow() ?? layers.find(l => l.id === selected)?.rows[0] ?? (manual ? undefined : byId.values().next().value);
    if (row?.id !== rowId) { rowId = row?.id; keyIndex = row ? row.keys.length - 1 : 0; }
    if (row) keyIndex = Math.min(keyIndex, row.keys.length - 1);
    length = Math.max(0, ...layers.map(layer => layer.end));
    time = Math.min(time, length);
    if (!byId.size && !(manual && layers.length)) { show(false); return; }
    show(true);
    draw();
  }
  function drawRuler() {
    const labelWidth = label.getBoundingClientRect().width;
    const width = Math.max(tracks.clientWidth - labelWidth, axisX(length) + 24);
    sheet.style.setProperty("--mt-axis-width", width + "px");
    drawTicks();
  }
  function drawTicks() {
    const width = ruler.clientWidth, step = rulerStep(scale), spacing = step * scale;
    const count = Math.max(0, Math.floor((width - axisInset - 24) / spacing));
    const first = Math.max(0, Math.floor(tracks.scrollLeft / spacing) - 1);
    const viewportWidth = tracks.clientWidth - label.clientWidth;
    const lastVisible = Math.min(count, Math.floor((tracks.scrollLeft + viewportWidth - axisInset - 24) / spacing));
    const last = Math.min(count, lastVisible + 1);
    const ticks = [];
    for (let i = first; i <= last; i++) {
      const tick = element("span", "mt-tick", digits(i * step));
      if (i === lastVisible) tick.dataset.unit = " ms";
      tick.style.left = axisX(i * step) + "px";
      ticks.push(tick);
    }
    ruler.querySelectorAll(".mt-tick").forEach(tick => tick.remove());
    ruler.append(...ticks);
  }
  function bar(el, first, last) {
    el.style.left = axisX(first) + "px";
    el.style.width = (last - first) * scale + "px";
  }
  function propertyPicker(layer) {
    const available = availableTimelineProperties(layer.motion);
    const { box, select } = picker("Add property", [
      ["", "Add property", true],
      ...timelineProperties.map(prop => [prop, props[prop], !available.includes(prop)]),
    ]);
    box.classList.add("mt-add-property");
    select.value = "";
    select.disabled = !writable() || !available.length;
    select.onchange = () => {
      const added = addTimelineProperty(layer, select.value, crypto.randomUUID());
      select.value = "";
      if (!added || !writable()) return;
      rowId = added.rowId;
      keyIndex = 1;
      collapsed.delete(layer.id);
      saveMotion(layer, added.motion, crypto.randomUUID());
      rows.querySelector(".mt-key[data-selected]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    return box;
  }
  function drawTracks() {
    readouts = [];
    const lines = [];
    for (const layer of layers) {
      const group = element("div", "mt-line"), cell = element("div", "mt-label"), axis = element("div", "mt-axis");
      group.dataset.layerId = layer.id;
      const disclosure = layer.rows.length ? button("mt-group-label", "", layer.name) : element("span", "mt-group-label");
      const name = element("span", "mt-row-name", layer.name);
      if (layer.rows.length) {
        disclosure.dataset.layer = layer.id;
        disclosure.setAttribute("aria-expanded", String(!collapsed.has(layer.id)));
        disclosure.append(icon("chevron"));
        const range = element("span", "mt-range");
        bar(range, layer.start, layer.end);
        axis.append(range);
      }
      disclosure.append(name);
      cell.append(disclosure, propertyPicker(layer)); group.append(cell, axis); lines.push(group);
      if (collapsed.has(layer.id)) continue;
      for (const row of layer.rows) {
        const line = element("div", "mt-line"), cell = element("div", "mt-label"), axis = element("div", "mt-axis");
        axis.dataset.row = row.id;
        const duplicate = layer.rows.some(other => row !== other && other.track.prop === row.track.prop);
        const name = props[row.track.prop] + (duplicate ? " (" + row.animation.id + ")" : "");
        const select = button("mt-row-label", "", name);
        select.dataset.row = row.id;
        const value = element("span", "mt-row-value");
        select.append(element("span", "mt-row-name", name), value);
        readouts.push({ row, value });
        cell.append(select); line.append(cell, axis); lines.push(line);
        row.keys.forEach((key, i) => {
          if (i) {
            const ease = easeName(key.ease), previous = row.keys[i - 1];
            const segment = button("mt-segment", "", ease + " segment");
            segment.dataset.segment = i;
            segment.setAttribute("aria-disabled", String(!writable()));
            const text = element("span", "", ease);
            segment.append(text);
            bar(segment, previous.t, key.t);
            segment.toggleAttribute("data-short", (key.t - previous.t) * scale < ease.length * 5.5 + 24);
            axis.append(segment);
          }
          const dot = button("mt-key", "", name + " keyframe " + (i + 1) + ", " + digits(key.t, 6) + " ms");
          dot.dataset.key = i;
          dot.setAttribute("aria-disabled", String(!writable()));
          dot.style.left = axisX(key.t) + "px";
          axis.append(dot);
        });
      }
    }
    if (rows.contains(document.activeElement)) panel.focus({ preventScroll: true });
    rows.replaceChildren(...lines);
    drawSelection();
  }
  function drawSelection() {
    for (const group of rows.querySelectorAll("[data-layer-id]")) {
      group.toggleAttribute("data-selected", !rowId && group.dataset.layerId === selected);
    }
    for (const axis of rows.querySelectorAll(".mt-axis[data-row]")) {
      const selected = axis.dataset.row === rowId;
      axis.toggleAttribute("data-selected", selected);
      axis.parentElement.toggleAttribute("data-selected", selected);
      for (const dot of axis.querySelectorAll(".mt-key")) {
        const on = selected && Number(dot.dataset.key) === keyIndex;
        dot.toggleAttribute("data-selected", on);
        dot.setAttribute("aria-pressed", String(on));
      }
    }
  }
  function updateTime() {
    now.textContent = seconds(time);
    total.textContent = " / " + seconds(length);
    sheet.style.setProperty("--mt-position", axisX(time) + "px");
    handle.setAttribute("aria-valuenow", digits(time, 2));
    handle.setAttribute("aria-valuemax", digits(length, 2));
    handle.setAttribute("aria-valuetext", digits(time, 2) + " ms");
    for (const { row, value } of readouts) value.textContent = display(digits(trackValue(row.compiled, time), row.track.prop.startsWith("scale") ? 3 : 2));
  }

  function drawInspector() {
    const row = selectedRow(), index = keyIndex, key = row?.keys[index];
    curl = null;
    if (!key) { inspector.replaceChildren(element("div", "mt-empty", "No keyframes")); return; }
    const title = element("div", "mt-inspector-heading");
    title.append(element("strong", "", props[row.track.prop]), element("span", "", `Keyframe ${index + 1} of ${row.keys.length}`));
    const disabled = !writable(), fields = element("div", "mt-fields");
    const updateKey = changes => changeKeys(row, row.keys.map((k, i) => i === index ? { ...k, ...changes } : k), index);
    const updateEase = ease => updateKey({ ease });
    fields.append(
      numberField("Value", key.v, v => { v = keyValue(row.track.prop, v); updateKey({ v }); return v; }, disabled),
      numberField("Time", key.t, t => { const keys = moveKeys(row.keys, [index], t, { legacy: !row.track.keys }); changeKeys(row, keys, index); return keys[index].t; }, disabled, " ms"),
    );
    const mode = easeMode(key.ease), segments = element("div", "mt-segmented");
    for (const [value, label] of modes) {
      const choice = button("", label);
      choice.disabled = disabled || index === 0;
      choice.setAttribute("aria-pressed", String(value === mode));
      choice.onclick = () => {
        if (value === mode) return;
        updateEase(value === "curve" ? defaultCurve : value === "spring" ? { spring: defaultSpring } : value);
      };
      segments.append(choice);
    }
    const current = curveGraph(key.ease);
    curl = { ...current, row };
    const parameters = element("div", "mt-fields");
    if (mode === "spring") {
      const s = springSettings(key.ease.spring);
      for (const [label, prop, min] of [["Stiffness", "stiffness", Number.MIN_VALUE], ["Damping", "damping", 0]]) parameters.append(numberField(label, s[prop], v => {
        v = Math.max(min, v); updateEase({ spring: { ...s, [prop]: v } }); return v;
      }, disabled || !index));
    } else if (mode === "curve") {
      ["X1", "Y1", "X2", "Y2"].forEach((label, i) => parameters.append(numberField(label, key.ease[i], v => {
        if (i % 2 === 0) v = clamp(v, 0, 1);
        updateEase(key.ease.map((n, j) => i === j ? v : n));
        return v;
      }, disabled || !index)));
    }
    inspector.replaceChildren(title, fields, segments, current.graph, parameters);
  }

  function drawPickers() {
    const row = selectedRow();
    pickValue(trigger.select, row?.animation.on ?? "boardHover", triggers);
    pickValue(leave.select, row?.animation.leave ?? "reverse", leaves);
    trigger.select.disabled = leave.select.disabled = !row || !writable();
    play.disabled = loop.disabled = handle.disabled = !length;
  }
  function draw() {
    drawPickers(); drawRuler(); drawTracks(); drawInspector(); updateTime();
  }
  function choose(row, i = row.keys.length - 1) {
    if (row.id === rowId && i === keyIndex) return;
    rowId = row.id; keyIndex = i;
    drawSelection(); drawPickers(); drawInspector();
  }
  function editAnimation(row, animation, gesture) {
    const motion = row.layer.motion.map(a => a === row.animation ? animation : a);
    saveMotion(row.layer, motion, gesture);
  }
  function saveMotion(layer, motion, gesture) {
    const target = model;
    const node = target?.root?.children.find(node => node.id === layer.id && node.motion === layer.motion);
    if (!node || !writable()) return;
    node.motion = motion;
    target.pending++;
    // Each edit uses the prior write's revision. A concurrent external edit refuses the queue instead of being overwritten.
    target.queue = (target.queue ?? Promise.resolve()).then(async () => {
      if (target.failed) return;
      const response = await fetch("/api/update", {
        method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" },
        body: JSON.stringify({ file: host.file, id: node.id, props: { motion }, expectedRevision: target.revision, gesture }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save motion");
      target.revision = result.revision;
    }).catch(err => {
      target.failed = true;
      host.toast(err.message);
    }).finally(() => {
      target.pending--;
      if (target === model && !target.pending) refresh(true);
    });
    rebuild();
  }
  function changeKeys(row, keys, index, gesture = crypto.randomUUID()) {
    if (!writable() || keys === row.keys || keys.every((key, i) => key === row.keys[i]) && keys.length === row.keys.length) return;
    const track = editTrack(row.track, row.keys, keys);
    rowId = row.id; keyIndex = index;
    if (track !== row.track) editAnimation(row, { ...row.animation, tracks: row.animation.tracks.map(t => t === row.track ? track : t) }, gesture);
  }

  function activePlayback() {
    play.setAttribute("aria-label", frame ? "Pause timeline" : "Play timeline");
    play.title = play.getAttribute("aria-label");
    play.replaceChildren(icon(frame ? "pause" : "play"));
  }
  function pause() {
    if (!frame) return;
    cancelAnimationFrame(frame); frame = 0; activePlayback();
  }
  function advance(ms) {
    const elapsed = Math.max(0, ms - started);
    if (!open || !shown || document.hidden || !length) { pause(); return; }
    if (elapsed >= length && !loopPreview) { seek(length); pause(); return; }
    seek(elapsed % length);
    frame = requestAnimationFrame(advance);
  }
  function playPause() {
    if (frame) { pause(); return; }
    if (!length) return;
    if (time >= length) time = 0;
    started = performance.now() - time;
    seek(time);
    frame = requestAnimationFrame(advance);
    activePlayback();
  }
  function timeAt(x) {
    return (x - ruler.getBoundingClientRect().left - axisInset) / scale;
  }
  function begin(e, state) {
    if (drag) return;
    pause();
    drag = { ...state, x: e.clientX, y: e.clientY, pointer: e.pointerId };
    if (state.kind !== "keys") capture(e);
  }
  function capture(e) {
    panel.focus({ preventScroll: true });
    panel.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function previewKeys(row, keys) {
    drag.keys = keys;
    // Keep the stored track and the selection stable during capture. The release writes once.
    row.keys = keys;
    drawTracks(); updateTime();
    const field = inspector.querySelector(".mt-fields .mt-field:nth-child(2) input");
    if (field) field.value = digits(keys[keyIndex].t, 6) + " ms";
    row.keys = drag.original;
  }

  play.onclick = playPause;
  close.onclick = dismiss;
  loop.onclick = () => { loopPreview = !loopPreview; loop.setAttribute("aria-pressed", String(loopPreview)); };
  trigger.select.onchange = () => {
    const row = selectedRow();
    if (row && trigger.select.value === "boardHover") editAnimation(row, { ...row.animation, on: "boardHover" }, crypto.randomUUID());
  };
  leave.select.onchange = () => {
    const row = selectedRow();
    if (row) editAnimation(row, { ...row.animation, leave: leave.select.value }, crypto.randomUUID());
  };
  panel.addEventListener("click", e => {
    const layer = e.target.closest("[data-layer]");
    if (layer) {
      const id = layer.dataset.layer;
      if (!collapsed.delete(id)) collapsed.add(id);
      drawTracks(); updateTime();
      rows.querySelectorAll("[data-layer]").forEach(el => { if (el.dataset.layer === id) el.focus({ preventScroll: true }); });
      return;
    }
    const axis = e.target.closest(".mt-axis[data-row]");
    const row = byId.get(axis?.dataset.row ?? e.target.closest(".mt-row-label")?.dataset.row);
    if (row) {
      const key = e.target.closest("[data-key]")?.dataset.key ?? e.target.closest("[data-segment]")?.dataset.segment;
      choose(row, key === undefined ? undefined : Number(key));
    }
  });
  panel.addEventListener("pointerdown", e => {
    if (e.button !== 0 || drag) return;
    if (length && e.target.closest(".mt-ruler")) {
      begin(e, { kind: "playhead" });
      if (drag) seek(e.target === handle ? time : timeAt(e.clientX));
      return;
    }
    const curveHandle = e.target.closest("[data-handle]");
    if (curveHandle && curl && keyIndex && writable()) {
      const { row, graph, low, high } = curl;
      begin(e, { kind: "curve", row, index: keyIndex, handle: Number(curveHandle.dataset.handle), rect: graph.getBoundingClientRect(), low, high, original: row.keys, gesture: crypto.randomUUID() });
      return;
    }
    const key = e.target.closest("[data-key]"), segment = e.target.closest("[data-segment]");
    if (!key && !segment) return;
    const row = byId.get(e.target.closest(".mt-axis")?.dataset.row), i = Number(key?.dataset.key ?? segment.dataset.segment);
    if (!row || !writable()) return;
    begin(e, { kind: "keys", row, indices: key ? [i] : [i - 1, i], original: row.keys, gesture: crypto.randomUUID() });
  });
  panel.addEventListener("pointermove", e => {
    if (drag?.pointer !== e.pointerId) return;
    if (drag.kind === "playhead") { seek(timeAt(e.clientX)); return; }
    if (!drag.keys && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 2) return;
    if (drag.kind === "curve") {
      const { rect, low, high, original, index, handle } = drag;
      const x = clamp(((e.clientX - rect.left) / rect.width * 256 - 8) / 240, 0, 1);
      const y = low + (high - low) * clamp((82 - (e.clientY - rect.top) / rect.height * 92) / 72, 0, 1);
      const ease = original[index].ease.map((v, i) => i === handle ? Number(digits(x)) : i === handle + 1 ? Number(digits(y)) : v);
      drag.keys = original.map((key, i) => i === index ? { ...key, ease } : key);
      inspector.querySelector(".mt-curve").replaceWith(curveGraph(ease).graph);
      return;
    }
    const { row, original, indices } = drag;
    if (!panel.hasPointerCapture(e.pointerId)) { capture(e); choose(row, indices.at(-1)); }
    const t = original[indices[0]].t + Math.round((e.clientX - drag.x) / scale);
    previewKeys(row, moveKeys(original, indices, t, { legacy: !row.track.keys, snap: e.shiftKey }));
  });
  function finishDrag(e) {
    if (drag?.pointer !== e.pointerId) return;
    const last = drag; drag = null;
    if (last.keys) {
      if (e.type === "pointerup") changeKeys(last.row, last.keys, keyIndex, last.gesture);
      draw();
    }
    refresh();
  }
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) panel.addEventListener(type, finishDrag);
  panel.addEventListener("pointerleave", e => {
    if (drag?.pointer === e.pointerId && !panel.hasPointerCapture(e.pointerId)) finishDrag(e);
  });
  panel.addEventListener("dblclick", e => {
    const point = document.elementFromPoint(e.clientX, e.clientY);
    const row = byId.get(point?.closest(".mt-axis[data-row]")?.dataset.row);
    if (!row || !writable() || point.closest(".mt-key")) return;
    const t = Math.round(timeAt(e.clientX));
    const keys = addKey(row.track, row.keys, t, row.layer.opacity);
    if (keys !== row.keys) {
      panel.focus({ preventScroll: true });
      changeKeys(row, keys, keys.findIndex(k => k.t === t));
    }
  });
  function zoom(clientX, factor) {
    if (drag) return;
    const offset = clientX - tracks.getBoundingClientRect().left - label.getBoundingClientRect().width;
    const next = zoomAtTime({ scale, scroll: tracks.scrollLeft, offset, factor });
    scale = next.scale;
    drawRuler(); drawTracks(); updateTime();
    tracks.scrollLeft = next.scroll;
  }
  tracks.addEventListener("wheel", e => {
    if (!(e.metaKey || e.ctrlKey || host.cmdHeld?.())) return;
    e.preventDefault();
    zoom(e.clientX, Math.exp(-(e.deltaY || e.deltaX) * 0.008));
  }, { passive: false });
  tracks.addEventListener("scroll", () => { if (open) drawTicks(); });
  tracks.addEventListener("gesturestart", e => { e.preventDefault(); pinchScale = 1; });
  tracks.addEventListener("gesturechange", e => {
    e.preventDefault();
    const { left, right } = tracks.getBoundingClientRect();
    zoom(Number.isFinite(e.clientX) ? e.clientX : (left + right + label.clientWidth) / 2, e.scale / pinchScale);
    pinchScale = e.scale;
  });

  panel.addEventListener("keydown", e => {
    if (e.target.closest("input,select") || e.metaKey || e.ctrlKey || e.altKey) return;
    const row = selectedRow();
    const direction = e.code === "ArrowLeft" || e.code === "ArrowDown" ? -1 : e.code === "ArrowRight" || e.code === "ArrowUp" ? 1 : 0;
    if (e.code === "Space") { if (!e.repeat) playPause(); }
    else if (e.target === handle && direction) { pause(); seek(time + direction * (e.shiftKey ? 10 : 1)); }
    else if (["Delete", "Backspace"].includes(e.code)) {
      if (row && writable()) {
        const keys = removeKey(row.keys, keyIndex);
        changeKeys(row, keys, Math.min(keyIndex, keys.length - 1));
      }
    } else if (direction) {
      if (row && writable()) {
        const t = row.keys[keyIndex].t + direction * (e.shiftKey ? 10 : 1);
        changeKeys(row, moveKeys(row.keys, [keyIndex], t, { legacy: !row.track.keys }), keyIndex);
      }
    } else return;
    e.preventDefault(); e.stopPropagation();
  });
  addEventListener("keydown", e => {
    if (e.code !== "KeyT" || !e.metaKey || !e.altKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat) toggle();
  }, true);
  host.on("select", selection);
  host.on("deselect", () => selection(null));
  host.on("page", () => selection(host.sel));
  host.on("tab", active => {
    shown = active;
    if (!active) {
      watch(false);
      request?.abort(); request = null;
      show(false);
    } else {
      watch(!!selected && !dismissed);
      refresh(true);
    }
  });
  host.on("cmd", c => {
    if (c.cmd === "motionTimeline") c.id ? openSelected(c.id) : toggle();
    if (open && c.cmd === "insets") place();
  });
  host.on("readOnly", () => { if (open) draw(); });
  selection(host.sel);
}

const host = window.canvasHost;
if (host?.file) installTimeline(host);
