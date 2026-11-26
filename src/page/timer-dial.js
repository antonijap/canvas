import { button, el } from "./whiteboard.js";

const STEP = 30_000;
const MAX = 600_000;
const DEFAULT = 300_000;
const TURN = 2 * Math.PI;
const snap = (ms) => Math.max(STEP, Math.min(MAX, Math.round(ms / STEP) * STEP));
const point = (angle, radius) => [100 + radius * Math.sin(angle), 100 - radius * Math.cos(angle)];

export function timerDial(start) {
  const face = el("div", "timer-face");
  face.dataset.timerDial = "";
  face.tabIndex = 0;
  face.setAttribute("role", "slider");
  face.setAttribute("aria-label", "Timer duration in seconds");
  face.setAttribute("aria-valuemin", "30");
  face.setAttribute("aria-valuemax", "600");
  const marks = Array.from({ length: 40 }, (_, i) => {
    const angle = TURN * i / 40;
    return `M${point(angle, i % 4 ? 84 : 78).join(" ")}L${point(angle, 90).join(" ")}`;
  }).join("");
  face.innerHTML = `<svg viewBox="0 0 200 200" aria-hidden="true">
    <path class="timer-ticks" d="${marks}"/>
    <path class="timer-wedge"/>
    <path class="timer-arc"/>
    <circle cx="100" cy="100" r="6" fill="currentColor"/>
  </svg>`;
  const wedge = face.querySelector(".timer-wedge"), arc = face.querySelector(".timer-arc");
  const readout = el("span", "timer-dial-value");
  readout.setAttribute("aria-hidden", "true");
  face.append(readout);

  let ms = DEFAULT, drag, disabled = false;
  const presets = [3, 5, 10].map((minutes) => {
    const value = minutes * 60_000;
    const b = button(`Start ${minutes}-minute timer`, "timer-preset", () => start(value));
    b.textContent = minutes;
    b.dataset.standaloneDuration = value;
    const angle = TURN * value / MAX;
    b.style.left = (50 + 41.4 * Math.sin(angle)) + "%";
    b.style.top = (50 - 41.4 * Math.cos(angle)) + "%";
    return b;
  });

  function select(value) {
    ms = snap(value);
    readout.textContent = `${Math.floor(ms / 60_000)}:${String(ms / 1000 % 60).padStart(2, "0")}`;
    face.setAttribute("aria-valuenow", ms / 1000);
    face.setAttribute("aria-valuetext", readout.textContent);
    for (const b of presets) b.setAttribute("aria-pressed", String(Number(b.dataset.standaloneDuration) === ms));
    const edge = ms === MAX ? "M100 26a74 74 0 1 1 0 148a74 74 0 1 1 0 -148"
      : `M100 26A74 74 0 ${ms > MAX / 2 ? 1 : 0} 1 ${point(TURN * ms / MAX, 74).join(" ")}`;
    arc.setAttribute("d", edge);
    wedge.setAttribute("d", edge + "L100 100Z");
  }

  function atPointer(e) {
    const r = face.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(x, y) < 1) return;
    const angle = Math.atan2(x, -y);
    select((angle > 0 ? angle : TURN + angle) / TURN * MAX);
  }

  function cancel() {
    if (!drag) return;
    const { id, before } = drag;
    drag = null;
    if (face.hasPointerCapture(id)) face.releasePointerCapture(id);
    select(before);
  }

  face.addEventListener("pointerdown", (e) => {
    if (disabled || drag || e.button !== 0) return;
    drag = { id: e.pointerId, before: ms };
    face.setPointerCapture(e.pointerId);
    atPointer(e);
  });
  face.addEventListener("pointermove", (e) => { if (drag?.id === e.pointerId) atPointer(e); });
  face.addEventListener("pointerup", (e) => {
    if (drag?.id !== e.pointerId) return;
    atPointer(e);
    drag = null;
    start(ms);
  });
  face.addEventListener("lostpointercapture", (e) => { if (drag?.id === e.pointerId) cancel(); });
  face.addEventListener("keydown", (e) => {
    if (disabled || drag || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") select(ms - STEP);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") select(ms + STEP);
    else if (e.key === "Home") select(STEP);
    else if (e.key === "End") select(MAX);
    else if (e.key === "Enter" && !e.repeat) start(ms);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  return {
    face, presets, cancel,
    reset(value) { select(Number(value) || DEFAULT); face.focus({ preventScroll: true }); },
    setDisabled(value) {
      disabled = value;
      face.setAttribute("aria-disabled", String(value));
      for (const b of presets) b.disabled = value;
    },
  };
}
