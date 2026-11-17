// Keyboard selection: Option+Space puts
// a pink cursor on the canvas, the arrow keys move it (Shift: ten times as far), and Return selects what is under it
// by the click rule (host.pickSelectable). Command held with the arrows draws a selection box from where the cursor
// was and sizes it; the box selects what it touches, like a marquee from empty canvas (host.boxSelect,
// /page/structure.js). Esc, or Option+Space again, puts the cursor away. While it is out, the arrows, Return and Esc
// are its own: nothing nudges, resizes or walks the tree. The pure helpers at the top are node-tested.

import { PINK } from "./autolayout-logic.js";

/** Screen px per arrow press, and with Shift. */
export const STEP = 8, BIG = 80;

/**
 * What a key does to the keyboard cursor. `on`: the cursor is out. Returns {op: "toggle"} (Option+Space),
 * {op: "move", dx, dy, box} (arrows; box: Command held), {op: "pick"} (Return), {op: "close"} (Esc), or null.
 */
export function kbKey(e, on) {
  const cmd = !!(e.metaKey || e.ctrlKey);
  if (e.code === "Space" && e.altKey && !cmd && !e.shiftKey) return { op: "toggle" };
  if (!on) return null;
  if (e.key === "Escape") return { op: "close" };
  if (e.key === "Enter" && !cmd && !e.altKey) return { op: "pick" };
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!d || e.altKey) return null;
  const s = e.shiftKey ? BIG : STEP;
  return { op: "move", dx: d[0] * s, dy: d[1] * s, box: cmd };
}

/** The box between the anchor and the cursor (view px), never thinner than a pixel. */
export function boxRect(a, c) {
  const x = Math.min(a.x, c.x), y = Math.min(a.y, c.y);
  return { x, y, w: Math.max(1, Math.abs(c.x - a.x)), h: Math.max(1, Math.abs(c.y - a.y)) };
}

/** A view point kept inside the view (w x h) with a margin. */
export const clampTo = (p, w, h, m = 4) => ({ x: Math.min(Math.max(p.x, m), Math.max(m, w - m)), y: Math.min(Math.max(p.y, m), Math.max(m, h - m)) });

const host = typeof window !== "undefined" ? window.canvasHost : null;
if (host && host.file) start(host);

function start(host) {
  const { view } = host;
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || !!(t.closest && t.closest("[contenteditable]")));
  const cur = document.createElement("div");
  cur.id = "kbcursor";
  cur.setAttribute("aria-hidden", "true");
  cur.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:7;width:17px;height:17px;margin:-8px 0 0 -8px;` +
    `background:linear-gradient(${PINK},${PINK}) center/1.5px 100% no-repeat,linear-gradient(${PINK},${PINK}) center/100% 1.5px no-repeat`;
  const box = document.createElement("div");
  box.id = "kbbox";
  box.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:6;box-sizing:border-box;border:1px solid ${PINK};background:color-mix(in srgb,${PINK} 10%,transparent)`;
  view.append(box, cur);
  let kb = null; // {x, y, anchor: {x, y} | null, base: [...]}: view px

  function paint() {
    if (!kb) { cur.style.display = "none"; box.style.display = "none"; return; }
    cur.style.display = "block";
    cur.style.left = kb.x + "px"; cur.style.top = kb.y + "px";
    if (kb.anchor) {
      const r = boxRect(kb.anchor, kb);
      box.style.display = "block";
      box.style.left = r.x + "px"; box.style.top = r.y + "px"; box.style.width = r.w + "px"; box.style.height = r.h + "px";
    } else box.style.display = "none";
  }
  function open() { kb = { x: Math.round(view.clientWidth / 2), y: Math.round(view.clientHeight / 2), anchor: null, base: [] }; paint(); }
  function close() { kb = null; paint(); }
  function pick() {
    const vb = host.viewBox || { l: 0, t: 0 };
    const id = host.pickSelectable ? host.pickSelectable(kb.x + vb.l, kb.y + vb.t, false) : null;
    if (id) host.setSelection([id]); else host.clearSel();
  }
  function move(a) {
    if (a.box && !kb.anchor) { kb.anchor = { x: kb.x, y: kb.y }; kb.base = []; }
    if (!a.box) kb.anchor = null; // a plain arrow after a box: the box is done, the cursor moves on
    Object.assign(kb, clampTo({ x: kb.x + a.dx, y: kb.y + a.dy }, view.clientWidth, view.clientHeight));
    if (kb.anchor && host.boxSelect && host.cam) {
      const r = boxRect(kb.anchor, kb), c = host.cam;
      host.boxSelect({ x: (r.x - c.x) / c.z, y: (r.y - c.y) / c.z, w: r.w / c.z, h: r.h / c.z }, kb.base);
    }
    paint();
  }
  // Capture: the cursor's keys must reach it before the nudge, the resize keys and Enter's select children.
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || typing(e.target) || (host.textEdit && host.textEdit.active)) return;
    const a = kbKey(e, !!kb);
    if (!a) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (a.op === "toggle") kb ? close() : open();
    else if (a.op === "close") close();
    else if (a.op === "pick") pick();
    else move(a);
  }, true);
  // A click or a page switch puts the cursor away.
  view.addEventListener("pointerdown", () => { if (kb) close(); }, true);
  host.on("cmd", (c) => { if (c && c.cmd === "keybox") { kb ? close() : open(); } });
  host.keybox = { get active() { return !!kb; }, get at() { return kb ? { x: kb.x, y: kb.y, anchor: kb.anchor } : null } };
}
