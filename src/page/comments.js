// Comments on the canvas (design: design/comments/comments.canvas). Press C (or the Comment button in the browser's
// bar) and click to pin a thread to the layer under the pointer; the layer under it lights up first. A pin is a small
// teardrop with the author's initial; it follows its layer when it moves or resizes and when the camera moves. A click
// on a pin opens the thread: replies, a Resolve check on the first comment, Delete thread in its right-click menu. A
// pin is moved by dragging it: on the drop it is pinned again to the layer under its tip (the author's or the Cloud
// owner's pins only, on a shared file). A thread whose layer was deleted sits at its board's corner and says so; Pin
// to a layer, or a drag, puts it on another layer by hand. Esc leaves comment mode.
//
// The threads live in comments.json inside the .canvas package (src/comments.ts, docs/cloud/protocol.md). This page
// reads them with GET /api/comments and changes them by sending ops to POST /api/comments/ops; the answer is the
// whole list, which is drawn. Other pages and agents that comment reach it as the "comments" event on the document's
// stream. Pure rules (anchors, where a pin goes, which threads show) are in /page/comments-logic.js (node-tested).
//
// Pins are plain DOM over the canvas. Their places are worked out in host.beforeFrame, so they cost nothing while the
// camera and the layers stand still.

import { installBottomOverlays } from "/page/bottom-overlays.js";
import { mentionQuery, mentionPeople, mentionTokens, mentionedYou } from "/page/mentions.js";
import * as L from "/page/comments-logic.js";
import * as D from "/page/dictation-logic.js";

const host = window.canvasHost;

const SHOW_KEY = "canvas:comments:showResolved";
const PIN = 28;
const svg = (body, w = 14) => `<svg width="${w}" height="${w}" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  check: svg('<path d="M2.5 7.4l3 3 6-6.4"/>'),
  trash: svg('<path d="M2.5 3.8h9M5.5 3.8V2.6h3v1.2M3.8 3.8l.5 7.6h5.4l.5-7.6M5.8 6v3.6M8.2 6v3.6"/>'),
  send: svg('<path d="M7 11.5v-9M3.2 6.2L7 2.4l3.8 3.8"/>'),
  bubble: svg('<path d="M7 1.8c3 0 5.2 2.1 5.2 4.7S10 11.2 7 11.2c-.7 0-1.3-.1-1.9-.3l-2.9 1.3.7-2.5C1.9 8.9 1.8 7.7 1.8 6.5 1.8 3.9 4 1.8 7 1.8z"/>'),
  layer: svg('<path d="M2 4.2V2.6A.6.6 0 012.6 2h1.6M9.8 2h1.6a.6.6 0 01.6.6v1.6M12 9.8v1.6a.6.6 0 01-.6.6H9.8M4.2 12H2.6a.6.6 0 01-.6-.6V9.8M5.4 5.4l3.9 1.6-1.6.7-.7 1.6z"/>', 12),
  ghost: svg('<path d="M2 4.2V2.6A.6.6 0 012.6 2h1.6M9.8 2h1.6a.6.6 0 01.6.6v1.6M12 9.8v1.6a.6.6 0 01-.6.6H9.8M4.2 12H2.6a.6.6 0 01-.6-.6V9.8"/>', 16),
  mic: svg('<rect x="5" y="1.8" width="4" height="6.8" rx="2"/><path d="M2.8 6.8a4.2 4.2 0 008.4 0M7 11v1.4"/>'),
  clock: svg('<circle cx="7" cy="7" r="5.4"/><path d="M7 4v3.2l2 1.2"/>', 11),
  alert: svg('<circle cx="7" cy="7" r="5.4"/><path d="M7 4.2v3.4M7 9.7v.1"/>', 11),
  sparkles: svg('<path fill="currentColor" stroke="none" d="M5.5 2l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1zM10.8 8.6l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z"/>', 12),
};
// The add pin: what the pointer is in comment mode, and the pin a click leaves while its comment is written. The same
// 28 pt teardrop as every pin (.cm-pin: radii 14 14 14 3, the popover's colour, --cm-pin's three shadows), with a
// small light plus where the avatar would be. The plus sits on the teardrop's centre of area, half a point toward its
// tip from the box's middle, so it looks centred in the shape rather than in the square around it.
const PLUS = '<path d="M13.5 10.5v8M9.5 14.5h8" stroke-width="1.5" stroke-linecap="round"/>';
const PIN_PATH = "M14 0A14 14 0 0 1 28 14A14 14 0 0 1 14 28H3A3 3 0 0 1 0 25V14A14 14 0 0 1 14 0Z";
/** --cm-pin's 0 4px 10px -2px shadow: the pin's shape inset by its -2 px spread. */
const PIN_INSET = "M14 2A12 12 0 0 1 26 14A12 12 0 0 1 14 26H3A1 1 0 0 1 2 25V14A12 12 0 0 1 14 2Z";
/** Room around the 28 pt pin in the cursor's image for its shadows (the deepest reaches 12 pt below it), and the hotspot: the tip. */
const ADD_PAD = { l: 9, t: 5, r: 9, b: 13 };
const ADD_HOT = { x: ADD_PAD.l, y: ADD_PAD.t + 28 };
const ADD_THEMES = {
  light: { fill: "#ffffff", plus: "#6e6e77", rim: 0.078, near: 0.122, far: 0.2 },
  dark: { fill: "#27272a", plus: "#a1a1aa", rim: 0.6, near: 0.4, far: 0.5 },
};
/** The add pin's cursor image as SVG, at `scale` (2 for Retina): CSS box-shadow blur B is a Gaussian of B / 2. */
function addPinSvg(theme, scale = 1) {
  const c = ADD_THEMES[theme] || ADD_THEMES.light;
  const w = ADD_PAD.l + 28 + ADD_PAD.r, hh = ADD_PAD.t + 28 + ADD_PAD.b;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${hh * scale}" viewBox="0 0 ${w} ${hh}">`
    + `<defs><filter id="n" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="1"/></filter><filter id="f" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="5"/></filter></defs>`
    + `<g transform="translate(${ADD_PAD.l} ${ADD_PAD.t})">`
    + `<path d="${PIN_INSET}" transform="translate(0 4)" fill="#000" fill-opacity="${c.far}" filter="url(#f)"/>`
    + `<path d="${PIN_PATH}" transform="translate(0 1)" fill="#000" fill-opacity="${c.near}" filter="url(#n)"/>`
    + `<path d="${PIN_PATH}" fill="none" stroke="#000" stroke-opacity="${c.rim}" stroke-width="1"/>`
    + `<path d="${PIN_PATH}" fill="${c.fill}"/>`
    + `<g fill="none" stroke="${c.plus}">${PLUS}</g></g></svg>`;
}
const svgUrl = (s) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
/** The comment-mode cursor: the 1x image for any browser, then a crisp 2x one where image sets work (the app's WebKit). */
const cursorCss = (theme) => `cursor:${svgUrl(addPinSvg(theme))} ${ADD_HOT.x} ${ADD_HOT.y},crosshair!important;cursor:-webkit-image-set(${svgUrl(addPinSvg(theme))} 1x,${svgUrl(addPinSvg(theme, 2))} 2x) ${ADD_HOT.x} ${ADD_HOT.y},crosshair!important`;

function start(host) {
  const { view, file } = host;
  installBottomOverlays(host);
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  /** A one-line label: its box trimmed to the capitals (an x for lowercase-only, cls "cm-t ex"), so a flex row centres the letters themselves. */
  const lbl = (text, cls = "cm-t") => h("span", cls, text);
  const txtBtn = (cls, text) => { const b = h("button", cls); b.type = "button"; b.append(lbl(text)); return b; };
  const btnEl = (cls, html, label) => { const b = h("button", cls); b.type = "button"; b.innerHTML = html; if (label) { b.setAttribute("aria-label", label); b.title = label; } return b; };
  const tell = (t) => { if (host.native) host.post({ toast: t }); else console.warn("[canvas] " + t); };
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  let showResolved = false;
  try { showResolved = localStorage.getItem(SHOW_KEY) === "1"; } catch {}

  const css = document.createElement("style");
  css.textContent = `
.cm-layer{position:absolute;left:0;top:0;width:100%;height:100%;z-index:14;pointer-events:none;overflow:hidden;font-family:var(--c-font-sans);-webkit-font-smoothing:antialiased;
  --cm-card:0 0 0 .5px #0000000f,0 1px 3px #00000014,0 12px 32px -6px #0000002e;--cm-pin:0 0 0 .5px #00000014,0 1px 2px #0000001f,0 4px 10px -2px #00000033;
  --cm-chip:var(--c-hover);--cm-line:var(--c-stroke);--cm-body:color-mix(in srgb,var(--c-fg) 80%,transparent);--cm-time:color-mix(in srgb,var(--c-muted-fg) 80%,transparent);
  --cm-unread-fill:#2165d9;--cm-unread-text:#1859c6}
.cm-layer *{box-sizing:border-box}
@media (prefers-color-scheme: dark){.cm-layer{--cm-card:0 0 0 .5px #00000099,0 1px 3px #00000066,0 12px 32px -6px #000000a6;--cm-pin:0 0 0 .5px #00000099,0 1px 2px #00000066,0 4px 10px -2px #00000080}}
@media (prefers-color-scheme: dark){.cm-layer{--cm-unread-text:#8cbaff}}
.cm-pin{position:absolute;left:0;top:0;width:${PIN}px;height:${PIN}px;border:0;padding:0;border-radius:14px 14px 14px 3px;background:var(--c-popover);color:var(--c-fg);font:600 12px/100% var(--c-font-sans);display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;box-shadow:var(--cm-pin);will-change:transform}
.cm-pin:hover .cm-av,.cm-pin:hover .cm-agent{scale:1.06}
.cm-pin.open{color:var(--c-fg)}
.cm-pin.resolved:not(.open,.unread){opacity:.6}
.cm-pin.unread{background:var(--cm-unread-fill);color:white;opacity:1}
.cm-pin.unread :is(.cm-av,.cm-agent){box-shadow:0 0 0 1px white}
.cm-pin.unread .cm-agent{background:var(--cm-unread-fill);color:white}
.cm-pin.unread::after{content:"";position:absolute;top:-2px;right:-2px;width:7px;height:7px;border-radius:50%;background:var(--cm-unread-fill);box-shadow:0 0 0 1.5px white}
.cm-av{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:11px;color:#fff;font:600 11px/100% var(--c-font-sans);flex:none;transition:scale .12s ease-out}
.cm-agent{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:var(--cm-chip);color:var(--c-fg);flex:none;transition:scale .12s ease-out}
.cm-ui{pointer-events:auto}
.cm-pop,.cm-comp{position:absolute;left:0;top:0;border-radius:16px;background:var(--c-popover);color:var(--c-fg);box-shadow:var(--cm-card);font-size:13px;line-height:18px;-webkit-user-select:text;user-select:text;cursor:default}
.cm-pop{z-index:1;width:340px;display:flex;flex-direction:column}.cm-comp{width:320px}
.cm-pop[hidden],.cm-comp[hidden]{display:none}
.cm-sidebar :is(h3,p){margin:0;padding-inline:calc(var(--c-sidebar-label-inset) - var(--c-sidebar-inset));color:var(--c-muted-fg)}
.cm-sidebar h3{margin-block-start:4px;font:600 var(--c-size-2xs)/20px var(--c-font-sans)}
.cm-thread-row span{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--c-muted-fg)}
.cm-thread-row[aria-current=true] span{color:var(--c-sidebar-fg)}
.cm-thread-row strong{font-weight:600}
.cm-thread-row.unread span::first-line{font-weight:600;color:var(--c-fg)}
.cm-new{color:var(--cm-unread-text);font-weight:600}
.cm-chip{display:inline-flex;align-items:center;gap:5px;height:22px;min-width:0;padding:0 7px 0 6px;border-radius:7px;background:var(--cm-chip);color:color-mix(in srgb,var(--c-fg) 75%,transparent);font:500 12px/100% var(--c-font-sans)}
.cm-chip svg{flex:none;color:var(--c-muted-fg)}
.cm-chip span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:3px 0;margin:-3px 0}
.cm-sp{flex:1;min-width:0;height:1px}
.cm-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:26px;min-width:26px;padding:0;border:0;border-radius:8px;background:var(--cm-chip);color:var(--c-fg);font:500 12px/100% var(--c-font-sans);cursor:pointer;white-space:nowrap}
.cm-btn.txt{padding:0 9px}
.cm-read-all{height:var(--c-sidebar-row);border-radius:var(--c-sidebar-radius);background:transparent;color:var(--c-muted-fg)}
.cm-read-all:hover{background:var(--c-hover);color:var(--c-fg)}
.cm-btn.txt:has(svg){padding-left:7.5px}
.cm-btn:hover{background:var(--c-active)}
.cm-btn.on{background:var(--c-fg);color:var(--c-popover)}
.cm-btn.dim{color:var(--c-muted-fg)}
.cm-sep{height:1px;background:var(--cm-line);width:100%}
.cm-list{display:flex;flex-direction:column;gap:14px;padding:14px;min-height:0;max-height:340px;overflow-y:auto}
.cm-pop>:not(.cm-list){flex:none}
.cm-item{display:flex;gap:10px;align-items:flex-start}
.cm-item .cm-av,.cm-item .cm-agent{margin-top:1px}
.cm-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-top:3px}
.cm-who{position:relative;display:flex;align-items:baseline;gap:6px;min-height:18px;line-height:100%;padding-top:4.5px}
.cm-who:has(.cm-btn){padding-right:26px}
.cm-who b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;padding:3px 0;margin:-3px 0}
.cm-who time{flex:none;color:var(--cm-time);font-size:12px}
.cm-who .cm-btn{position:absolute;right:0;top:-1px;opacity:0;height:20px;min-width:20px;background:transparent;color:var(--c-muted-fg)}
.cm-item:hover .cm-who .cm-btn,.cm-item:focus-within .cm-who .cm-btn{opacity:1}
.cm-who .cm-btn.cm-res{top:-2px;height:22px;min-width:22px;width:22px;border-radius:11px;opacity:1}
.cm-who .cm-btn.cm-res:hover{background:var(--cm-chip);color:var(--c-fg)}
.cm-who .cm-btn.cm-res.on{background:var(--c-fg);color:var(--c-popover)}
.cm-who.first:has(.cm-res){padding-right:28px}
.cm-text{color:var(--cm-body);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.385}
.cm-note{padding:10px 14px;color:var(--c-muted-fg);font-size:12px;line-height:100%}
.cm-row{display:flex;align-items:flex-end;gap:8px;padding:10px 10px 10px 14px}
.cm-row .cm-fieldwrap{flex:1;min-width:0;padding:5px 0}
.cm-field{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--c-fg);font:13px/18px var(--c-font-sans);padding:0;margin:0;height:18px;min-height:18px;max-height:120px;overflow-y:hidden}
.cm-fieldwrap{position:relative}
.cm-mentions{position:absolute;bottom:100%;left:0;z-index:5;min-width:160px;max-height:230px;overflow:auto;padding:4px;border-radius:10px;background:var(--c-popover);box-shadow:var(--cm-card)}
.cm-mentions[hidden]{display:none}
.cm-mentions button{display:block;width:100%;text-align:left;border:0;border-radius:6px;padding:9px 8px;background:transparent;color:var(--c-fg);font:13px/100% var(--c-font-sans)}
.cm-mentions button[aria-selected=true],.cm-mentions button:hover{background:var(--c-hover)}
.cm-mention{background:var(--c-hover);border-radius:4px;padding:2px 1px}
.cm-field::placeholder{color:var(--cm-time)}
.cm-field.scroll{overflow-y:auto}
.cm-send{flex:none;width:28px;height:28px;border-radius:14px;border:0;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;background:var(--cm-chip);color:var(--cm-time);transition:background-color .15s ease-out,color .15s ease-out}
.cm-send.ready{background:#18181b;color:#fff}
.cm-send:disabled{cursor:default}
.cm-compfield{display:flex;gap:10px;padding:14px 14px 10px}
.cm-compfield .cm-av{margin-top:1px}
.cm-compfield .cm-fieldwrap{flex:1;min-width:0;padding-top:3px}
.cm-foot{display:flex;align-items:center;gap:8px;padding:4px 12px 12px 14px}
.cm-key{display:inline-flex;align-items:center;justify-content:center;height:18px;min-width:18px;padding:0 5px;border-radius:4px;background:var(--cm-chip);color:var(--c-muted-fg);font:500 11px/100% var(--c-font-sans)}
.cm-menu{position:absolute;left:0;top:0;min-width:150px;padding:4px;border-radius:10px;background:var(--c-popover);box-shadow:var(--cm-card);z-index:2}
.cm-menu button{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--c-danger);font:500 12px/100% var(--c-font-sans);cursor:pointer;text-align:left}
.cm-menu button:hover{background:var(--c-hover)}
.cm-pin-menu{min-width:min(166px,var(--cm-pin-menu-width));max-width:var(--cm-pin-menu-width);z-index:4}
.cm-pin-menu button:not(.danger){color:var(--c-fg)}
.cm-pin-menu button:disabled{opacity:.45;cursor:default}
.cm-pin-menu p{margin:4px 8px;color:var(--c-muted-fg);font-size:12px}
.cm-gone{display:flex;flex-direction:column;gap:10px;padding:12px 10px 10px 14px;border-radius:16px 16px 0 0;background:#fff7ed;color:#c2410c}
.cm-gone .cm-top{display:flex;align-items:center;gap:10px;min-height:22px}
.cm-gone .cm-acts{display:flex;align-items:center;gap:6px}
.cm-gone .cm-ghost{flex:none;display:flex;margin-left:-1.5px;color:#ea580c}
.cm-gone .cm-gt{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;line-height:100%}
.cm-gone b{font-weight:600;color:#9a3412;font-size:13px;line-height:100%}
.cm-gone .cm-gl{font-size:12px;line-height:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:3px 0;margin:-3px 0}
.cm-gone .cm-btn{background:#ffedd5;color:#9a3412}
.cm-gone .cm-acts .cm-btn.txt:first-child{padding-left:8.5px}
.cm-gone .cm-btn:hover{background:#fed7aa}
@media (prefers-color-scheme: dark){.cm-gone{background:#fb923c24;color:#fdba74}.cm-gone .cm-ghost{color:#fb923c}.cm-gone b{color:#fed7aa}.cm-gone .cm-btn{background:#fb923c2e;color:#fed7aa}.cm-gone .cm-btn:hover{background:#fb923c47}}
.cm-bar,.cm-hint{position:absolute;left:50%;translate:-50% 0;display:none;align-items:center;gap:10px;white-space:nowrap;font-size:13px;line-height:100%;pointer-events:none}
.cm-bar{flex-wrap:wrap;justify-content:center;min-height:36px;padding:8px 5px 8px 11px;border-radius:12px;background:var(--c-popover);color:var(--c-fg);box-shadow:var(--cm-card);font-size:12px;font-weight:500;pointer-events:auto}
.cm-bar>*{flex:none;max-width:100%;overflow-wrap:anywhere}
.cm-bar .cm-btn{height:auto;min-height:26px;white-space:normal}
.cm-bar.on,.cm-hint.on{display:flex}
#view:has(:is(.whiteboard-flyout,.vote-sheet):not([hidden])) .cm-bar{display:none}
.cm-bar svg{color:var(--c-muted-fg)}
.cm-bar>span:first-child,.cm-hint>span:first-child{display:flex}
.cm-hint{flex-wrap:wrap;overflow-wrap:anywhere;min-height:36px;padding:8px 12px 8px 11px;border-radius:12px;background:#18181be6;color:#fff;-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);box-shadow:0 0 0 .5px #ffffff1f,0 8px 24px -6px #00000059}
.native .cm-hint .cm-soft{min-width:0;padding:3px 0;margin:-3px 0}
.native .cm-hint>b,.native .cm-hint>.cm-key,.native .cm-hint>span:first-child{flex-shrink:0}
.cm-hint b{font-weight:600}
.cm-hint .cm-soft{color:#ffffffa6}
.cm-hint .cm-key{background:#ffffff26;color:#ffffffcc}
.cm-shared{position:absolute;right:12px;top:12px;display:none;align-items:center;gap:10px;min-height:36px;padding:6px 8px;border-radius:18px;background:var(--c-popover);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);color:color-mix(in srgb,var(--c-fg) 75%,transparent);box-shadow:0 0 0 .5px #0000000f,0 8px 24px -6px #00000026;font:500 12px/100% var(--c-font-sans);white-space:nowrap}
.cm-shared.on{display:flex}
.cm-shared.toolbar{position:static;min-height:0;padding:0 6px 0 0;background:transparent;box-shadow:none;--cm-chip:var(--c-hover)}
.native .cm-shared{display:none!important}
.cm-people{display:flex;align-items:center}
.cm-people .cm-av{width:28px;height:28px;border-radius:14px;border:0;padding:0;cursor:pointer;box-shadow:0 0 0 2px var(--c-popover)}
.cm-people .cm-av+.cm-av{margin-left:-6px}.cm-people button:hover{translate:0 -2px}.cm-people button:focus-visible{outline:2px solid var(--c-fg);outline-offset:2px}
.cm-people .cm-more{background:var(--cm-chip);color:var(--c-muted-fg);font-size:10px}
.cm-server{display:flex;align-items:center;gap:6px}
.cm-state{display:inline-flex;align-items:center;gap:4px;min-width:0;color:var(--c-muted-fg);font-size:12px;line-height:100%}
.cm-state svg{flex:none}
.cm-state.wait{display:inline;white-space:nowrap}.cm-state.wait svg{vertical-align:calc(.5cap - 5.5px);margin-right:4px}
.cm-fail{display:flex;align-items:flex-start;gap:8px;color:var(--c-danger);font-size:12px;line-height:16px}
.cm-fail .cm-state{flex:1;align-items:flex-start;color:inherit;line-height:16px;white-space:normal;overflow-wrap:anywhere}
.cm-fail .cm-state svg{margin-top:2px}
.cm-fail .cm-btn{height:20px;min-width:20px;margin-top:-2px;padding:0 7px;font-size:12px}
.cm-failrow{padding:10px 14px 0}
.cm-hov{position:absolute;left:0;top:0;display:none;box-sizing:border-box;border:1px solid var(--c-sel);opacity:.55;pointer-events:none}
.cm-hov.cmp{border-color:var(--c-component)}
.cm-send.cm-mic{background:transparent;color:var(--c-muted-fg)}
.cm-send.cm-mic:hover{background:var(--cm-chip)}
.cm-send.cm-mic[aria-pressed=true]{background:var(--c-danger);color:#fff}
.cm-send.cm-mic.live{animation:cm-live 1.4s ease-in-out infinite}
@keyframes cm-live{50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--c-danger) 28%,transparent)}}
.cm-micnote{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:0 14px 10px;color:var(--c-muted-fg);font-size:12px;line-height:16px}
.cm-micnote[hidden]{display:none}
.cm-micnote button{border:0;padding:0;background:transparent;color:var(--c-fg);font:600 12px/16px var(--c-font-sans);text-decoration:underline;cursor:pointer}
.cm-pin.cm-add{color:var(--c-muted-fg);cursor:default}
.cm-pin.cm-add svg{position:absolute;left:0;top:0}
.cm-pin.drag{z-index:1;cursor:grabbing}
#view.cm-mode,#view.cm-mode *{${cursorCss("light")}}
@media (prefers-color-scheme: dark){#view.cm-mode,#view.cm-mode *{${cursorCss("dark")}}}
#view.cm-mode .cm-ui,#view.cm-mode .cm-ui *{cursor:default!important}
#view.cm-mode .cm-ui textarea{cursor:text!important}
#view.cm-mode .cm-ui button,#view.cm-mode .cm-pin,#view.cm-mode .cm-pin *{cursor:pointer!important}
#view.cm-mode .cm-pin.cm-add,#view.cm-mode .cm-pin.cm-add *{cursor:default!important}
.cm-layer.dragging,.cm-layer.dragging *,#view.cm-mode .cm-pin.drag,#view.cm-mode .cm-pin.drag *{cursor:grabbing!important}
.cm-t,.cm-bar>span,.cm-hint>b,.cm-hint>.cm-soft,.cm-chip span,.cm-who b,.cm-who time,.cm-gone b,.cm-gone .cm-gl{text-box:trim-both cap alphabetic}
.cm-t.ex{text-box-edge:ex alphabetic}
@media (prefers-reduced-motion: reduce){.cm-av,.cm-agent,.cm-send{transition:none}.cm-send.cm-mic.live{animation:none}.cm-pin:hover .cm-av,.cm-pin:hover .cm-agent{scale:1}}`;
  document.head.appendChild(css);

  const layer = h("div", "cm-layer");
  layer.setAttribute("data-comments", "");
  view.appendChild(layer);
  const hov = h("div", "cm-hov");
  const pop = h("div", "cm-pop cm-ui"); pop.hidden = true; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Comment thread");
  const comp = h("div", "cm-comp cm-ui"); comp.hidden = true; comp.setAttribute("role", "dialog"); comp.setAttribute("aria-label", "New comment");
  const hint = h("div", "cm-hint");
  const shared = h("div", "cm-shared cm-ui");
  const bar = h("div", "cm-bar cm-ui");
  const sidebar = h("aside", "cm-sidebar right-sidebar");
  sidebar.hidden = true;
  sidebar.setAttribute("aria-label", "Comments");
  layer.append(hov, pop, comp, hint, bar, shared);
  document.body.append(sidebar);
  bar.setAttribute("role", "button");
  bar.tabIndex = 0;
  bar.setAttribute("aria-label", "Open comments");
  bar.addEventListener("click", (e) => { if (!e.target.closest("button")) showList(true); });
  bar.addEventListener("keydown", (e) => {
    if (e.target === bar && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); showList(true); }
  });
  function showList(open, { restoreFocus = false } = {}) {
    sidebar.hidden = !open;
    document.body.classList.toggle("cm-sidebar-open", open);
    if (host.native) host.post({ commentsSidebar: open });
    if (open) {
      setMode(false);
      openThread(null);
      sidebar.querySelector(".cm-thread-row.unread")?.scrollIntoView({ block: "nearest" });
    } else if (restoreFocus) {
      bar.focus();
    } else if (bar.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    schedule();
  }
  function drawSidebar() {
    if (sidebar.hidden) return;
    sidebar.replaceChildren();
    const head = h("div", "cm-sidebar-head right-sidebar-header");
    const close = h("button", "right-sidebar-close");
    close.type = "button";
    close.title = "Close";
    close.onclick = () => showList(false, { restoreFocus: true });
    close.setAttribute("aria-label", "Close");
    const read = txtBtn("cm-btn txt cm-read-all", "Mark all as read");
    read.setAttribute("aria-label", "Mark all as read");
    read.onclick = () => setRead();
    head.append(h("strong", "", "Comments"));
    if (st.unread.size) head.append(read);
    head.append(close);
    sidebar.append(head);
    const threads = L.visibleThreads(st.threads, true);
    const unread = threads.filter(t => st.unread.has(t.id));
    const readThreads = threads.filter(t => !st.unread.has(t.id) && (showResolved || !t.resolvedAt));
    if (unread.length) sidebar.append(h("h3", "", "Unread"));
    for (const thread of unread) drawRow(thread, true);
    if (unread.length && readThreads.length) sidebar.append(h("h3", "", "Read"));
    for (const thread of readThreads) drawRow(thread, false);
    if (!threads.length) sidebar.append(h("p", "", "No comments yet"));
    function drawRow(thread, unread) {
      const first = L.liveComments(thread)[0];
      if (!first) return;
      const row = h("button", "cm-thread-row right-sidebar-row" + (unread ? " unread" : ""));
      row.type = "button";
      row.title = (unread ? "Unread comment from " : "Open comment from ") + (first.author?.name || "Someone");
      row.dataset.thread = thread.id;
      row.setAttribute("aria-current", String(st.open === thread.id));
      if (unread) row.setAttribute("aria-label", row.title + ": " + first.body);
      row.append(h("strong", "", first.author?.name || "Someone"), h("span", "", first.body));
      row.onclick = async () => {
        const page = L.pageOf(thread, (board) => host.pageOfBoard(board), firstPage());
        if (page && page !== pageNow()) await host.setPage(page);
        // Load an offscreen layer before asking for its pin's world point.
        if (thread.anchor?.nodeId && !host.worldRectOf(thread.anchor.nodeId) && window.canvasBridge) {
          try { await window.canvasBridge.ensureLoaded(thread.anchor.nodeId, thread.anchor.board ? { [thread.anchor.nodeId]: thread.anchor.board } : undefined); }
          catch (error) { if (error.code !== "not_found") { tell(error.message); return; } }
        }
        const spot = spotOf(thread, new Map());
        if (!spot) { tell("This comment's layer is not available yet"); return; }
        const v = view.getBoundingClientRect(), ins = host.insets || {};
        const right = Math.min(v.width - (ins.r || 0), sidebar.getBoundingClientRect().left - v.left);
        const z = Math.max(0.25, Math.min(1, host.cam.z));
        host.setCam({ z, x: ((ins.l || 0) + right) / 2 - spot.x * z,
          y: ((ins.t || 0) + v.height - (ins.b || 0)) / 2 - spot.y * z });
        if (thread.resolvedAt) showResolved = true;
        openThread(thread.id);
      };
      sidebar.append(row);
    }
  }
  if (!host.native) { const toolbar = document.querySelector("#bar .island:last-child"); if (toolbar) { toolbar.prepend(shared); shared.classList.add("toolbar"); } }

  /** doc: the file's comment identity (null until the first comment); threads: every thread, tombstones too. repin: a thread waiting for a new layer. */
  const st = { doc: null, threads: [], unread: new Set(), sync: null, me: "", mode: false, open: null, draft: null, repin: null, menu: false, people: [] };
  const pins = new Map(); // thread id (or "draft") -> {el, x, y, vis}
  const gone = new Map(); // node id -> {rev, at, gone} what the file said about a layer with no drawing now
  const asked = new Set();

  // ---------- the file ----------
  const sendOps = (ops, onAccepted) => fetch("/api/comments/ops?file=" + encodeURIComponent(file), { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ ops }) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }))
    .then((j) => {
      if (!j.rejected?.length) onAccepted?.();
      apply(j);
      for (const x of j.rejected || []) tell(`Comment not saved: ${x.message}`);
      return j;
    });
  function apply(j) {
    if (Array.isArray(j.people)) st.people = j.people;
    if (j.doc !== undefined) st.doc = j.doc;
    if (Array.isArray(j.threads)) { st.threads = j.threads; if (j.sync !== undefined) st.sync = j.sync || null; }
    if (Array.isArray(j.unread)) st.unread = new Set(j.unread);
    if (typeof j.me === "string") st.me = j.me;
    render();
  }
  let loading = 0;
  function load() {
    const n = ++loading;
    return fetch("/api/comments?file=" + encodeURIComponent(file)).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && n === loading) apply(j); }).catch(() => {});
  }
  let readQueue = Promise.resolve();
  function setRead(id, unread = false) {
    readQueue = readQueue.then(async () => {
      const r = await fetch("/api/comments/read?file=" + encodeURIComponent(file), {
        method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" },
        body: JSON.stringify({ thread: id, unread }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      ++loading;
      apply(j);
      void load();
    }).catch((e) => tell(e.message));
    return readQueue;
  }
  const env = (op) => ({ opId: crypto.randomUUID(), doc: st.doc || "00000000-0000-4000-8000-000000000000", at: new Date().toISOString(), op });
  const thread = (id) => st.threads.find((t) => t.id === id);

  // ---------- which threads show, and where ----------
  const pageNow = () => host.page || (host.pages && host.pages[0] && host.pages[0].id) || null;
  const firstPage = () => (host.pages && host.pages[0] && host.pages[0].id) || null;
  let list = [], listSig = "";
  const sigOf = () => `${pageNow()}|${(host.pages || []).map((p) => p.id + ":" + p.boards.length).join(",")}|${showResolved}|${st.threads.length}`;
  function refreshList() {
    listSig = sigOf();
    list = L.visibleThreads(st.threads, showResolved).filter((t) => L.pageOf(t, (b) => host.pageOfBoard(b), firstPage()) === pageNow());
  }

  /** Ask the file whether a layer with no drawing is deleted (a 404) or only not drawn yet (its board is off screen). */
  function askGone(id) {
    const rev = host.doc && host.doc.revision, now = Date.now();
    const c = gone.get(id);
    if (asked.has(id) || String(id).startsWith("widget:") || (c && (c.rev === rev || now - c.at < 2000))) return;
    asked.add(id);
    fetch(host.api("/api/node") + "&id=" + encodeURIComponent(id) + "&depth=0")
      .then((r) => { gone.set(id, { rev, at: Date.now(), gone: r.status === 404 }); asked.delete(id); render(); })
      .catch(() => asked.delete(id));
  }
  const isGoneNow = (t) => !!(t.anchor && t.anchor.nodeId && gone.get(t.anchor.nodeId) && gone.get(t.anchor.nodeId).gone && !host.worldRectOf(t.anchor.nodeId));

  /** The world point of a thread's pin, or null while it is not known (its layer's board is not drawn). */
  function spotOf(t, slots) {
    const a = t.anchor || {};
    if (!a.nodeId) return L.pinSpot(t, {});
    const r = host.worldRectOf(a.nodeId);
    if (r) { gone.delete(a.nodeId); return L.pinSpot(t, { layerRect: r }); }
    askGone(a.nodeId);
    const c = gone.get(a.nodeId);
    if (!(c && c.gone)) return null;
    const bb = a.board && host.boxOf(a.board);
    const slot = slots.get(a.board) || 0;
    slots.set(a.board, slot + 1);
    return L.pinSpot(t, { gone: true, boardRect: bb, slot });
  }

  // ---------- pins ----------
  function avatar(author, cls = "") {
    if (L.isAgent(author)) { const a = h("span", "cm-agent " + cls); a.innerHTML = ICON.sparkles; return a; }
    const a = h("span", "cm-av " + cls);
    a.append(lbl(L.initialOf(author && author.name)));
    a.style.background = L.colorOf(author && author.name);
    return a;
  }
  function pinEl(id) {
    let p = pins.get(id);
    if (p) return p;
    const el = h("button", "cm-pin");
    el.type = "button";
    el.dataset.thread = id;
    el.title = "Open comment";
    el.style.display = "none";
    el.addEventListener("click", (e) => { e.stopPropagation(); if (id === "draft" || dragged === id) return; openThread(st.open === id ? null : id); });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = thread(id);
      if (t && !drag?.moving) showPinMenu(t, e.clientX, e.clientY);
    });
    el.addEventListener("pointerdown", (e) => pressPin(e, id));
    el.addEventListener("pointermove", (e) => dragPin(e));
    el.addEventListener("pointerup", (e) => dropPin(e));
    el.addEventListener("pointercancel", () => cancelDrag());
    el.addEventListener("lostpointercapture", () => { if (drag && !drag.done) cancelDrag(); });
    layer.appendChild(el);
    p = { el, x: NaN, y: NaN, vis: false, key: "" };
    pins.set(id, p);
    return p;
  }
  function drawPin(p, t, author, open) {
    const live = t ? L.liveComments(t).length : 0;
    const key = `${open}|${live}|${author && author.name}`;
    if (p.key === key) return;
    p.key = key;
    p.el.textContent = "";
    if (open && t) p.el.append(lbl(String(live)));
    else p.el.append(avatar(author));
  }

  /** The list changed (a load, an op, Show resolved, a page): the pins and the open thread are rebuilt from it. */
  function render() {
    refreshList();
    const want = new Set(list.map((t) => t.id));
    if (st.draft) want.add("draft");
    for (const [id, p] of pins) if (!want.has(id)) { p.el.remove(); pins.delete(id); }
    for (const t of list) {
      const p = pinEl(t.id);
      const first = L.liveComments(t)[0];
      drawPin(p, t, first && first.author, st.open === t.id);
      p.el.classList.toggle("resolved", !!t.resolvedAt);
      p.el.classList.toggle("open", st.open === t.id);
      const unread = st.unread.has(t.id);
      p.el.classList.toggle("unread", unread);
      p.el.setAttribute("aria-label", `${unread ? "Unread comment" : "Comment"} from ${first && first.author ? first.author.name : "someone"}${first ? ": " + first.body.slice(0, 80) : ""}`);
    }
    if (st.draft) {
      // The add pin stays where the click left it while the comment is written: the cursor's own shape, set down.
      const p = pinEl("draft");
      if (p.key !== "add") { p.key = "add"; p.el.classList.add("cm-add"); p.el.title = ""; p.el.setAttribute("aria-label", "New comment here"); p.el.innerHTML = `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" aria-hidden="true">${PLUS}</svg>`; }
    }
    if (st.open && !L.stillOpen(st.open, list, true)) st.open = null;
    drawThread();
    drawBars();
    drawSidebar();
    schedule();
  }

  // ---------- moving a pin: press and drag it (a press that stays within L.DRAG_SLOP is a click) ----------
  // While it moves, the pin's tip keeps the offset it was grabbed at and the layer under the tip lights up. On the drop
  // the thread is anchored again at the tip by anchorAt, the rule a new comment there gets, and one thread.move op is
  // sent: it lands in comments.json, or in a shared file's outbox for the Cloud. Comments are not in undo, so neither
  // is a move. Esc while dragging puts the pin back.
  let drag = null, dragged = null;
  function pressPin(e, id) {
    if (id === "draft" || e.button !== 0 || host.hand || drag) return;
    const t = thread(id), p = pins.get(id);
    if (!t || !p || !p.vis || !L.mayMove(t, st.sync)) return;
    const vb = host.viewBox || { l: 0, t: 0 };
    const at = { x: e.clientX, y: e.clientY };
    drag = { id, pid: e.pointerId, from: at, grab: L.grabOffset(at, { x: vb.l + p.x, y: vb.t + p.y }), tip: null, moving: false, done: false, el: p.el };
    try { p.el.setPointerCapture(e.pointerId); } catch {}
  }
  function dragPin(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const at = { x: e.clientX, y: e.clientY };
    if (!drag.moving) {
      if (!L.isDrag(drag.from, at)) return;
      drag.moving = true;
      drag.el.classList.add("drag");
      layer.classList.add("dragging");
      if (st.menu) { st.menu = false; drawMenu(); }
    }
    drag.tip = L.tipAt(at, drag.grab);
    drag.meta = e.metaKey;
    hovId = targetAt(drag.tip.x, drag.tip.y, !!e.metaKey);
    paintHover();
    schedule();
  }
  function endDrag() {
    const d = drag;
    drag = null;
    if (!d) return null;
    d.done = true;
    try { d.el.releasePointerCapture(d.pid); } catch {}
    d.el.classList.remove("drag");
    layer.classList.remove("dragging");
    if (!st.mode) { hovId = null; hov.style.display = "none"; } else queueHover();
    if (d.moving) { dragged = d.id; setTimeout(() => { if (dragged === d.id) dragged = null; }, 0); }
    return d;
  }
  function cancelDrag() {
    if (endDrag()) { pins.forEach((p) => { p.x = NaN; }); schedule(); }
  }
  function dropPin(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = endDrag();
    if (!d.moving || !d.tip) return;
    e.stopPropagation();
    const t = thread(d.id);
    if (!t) return;
    const a = anchorAt({ clientX: d.tip.x, clientY: d.tip.y, metaKey: !!d.meta });
    if (L.sameAnchor(t.anchor, a)) { schedule(); return; }
    // Shown where it was dropped at once; the answer (the whole list) confirms it, a refusal puts it back.
    t.anchor = a;
    if (a.nodeId) gone.delete(a.nodeId);
    render();
    sendOps([env({ kind: "thread.move", thread: d.id, anchor: a })]).catch((err) => { tell(err.message); load(); });
  }

  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); };


  /** Where each pin and popover goes: run in every frame the canvas draws, and nowhere else. */
  function place() {
    const cam = host.cam;
    if (!cam) return;
    if (sigOf() !== listSig) { render(); return; }
    const vw = view.clientWidth, vh = view.clientHeight;
    const slots = new Map();
    const at = new Map(); // id -> screen {x, y}
    const put = (id, spot) => {
      const p = pins.get(id);
      if (!p) return;
      const held = drag && drag.moving && drag.tip && drag.id === id;
      if (!spot && !held) { if (p.vis) { p.el.style.display = "none"; p.vis = false; } return; }
      const vb = held ? host.viewBox || { l: 0, t: 0 } : null;
      const sx = held ? drag.tip.x - vb.l : cam.x + spot.x * cam.z, sy = held ? drag.tip.y - vb.t : cam.y + spot.y * cam.z;
      at.set(id, { x: sx, y: sy });
      const inside = sx > -PIN && sy > -PIN && sx < vw + PIN && sy < vh + PIN * 2;
      if (!inside) { if (p.vis) { p.el.style.display = "none"; p.vis = false; } return; }
      if (!p.vis) { p.el.style.display = ""; p.vis = true; }
      if (p.x !== sx || p.y !== sy) { p.x = sx; p.y = sy; p.el.style.transform = `translate(${Math.round(sx * 4) / 4}px,${Math.round((sy - PIN) * 4) / 4}px)`; }
      const gn = !held && spot.kind === "board";
      if (p.el.classList.contains("gone") !== gn) p.el.classList.toggle("gone", gn);
    };
    for (const t of list) put(t.id, spotOf(t, slots));
    if (st.draft) put("draft", st.draft.spot());
    const ins = host.insets || {};
    const placePopover = (el, pin, fitHeight = false) => {
      const left = ins.l || 0, width = vw - left - (ins.r || 0);
      const maxWidth = Math.max(0, width - 16) + "px";
      if (el.style.maxWidth !== maxWidth) {
        el.style.maxWidth = maxWidth;
        const field = el.querySelector(".cm-field");
        if (field) autoGrow(field);
      }
      const top = fitHeight ? ins.t || 0 : 0, bottom = fitHeight ? ins.b || 0 : 0;
      const height = vh - top - bottom;
      if (fitHeight) {
        const maxHeight = Math.max(0, height - 16) + "px";
        if (el.style.maxHeight !== maxHeight) el.style.maxHeight = maxHeight;
      }
      const localPin = { x: pin.x - left, y: pin.y - top };
      const { x, y } = L.popoverAt(localPin, { w: el.offsetWidth, h: el.offsetHeight }, width, height);
      el.style.transform = `translate(${left + x}px,${top + y}px)`;
    };
    if (st.open && !pop.hidden) {
      if (at.has(st.open)) placePopover(pop, at.get(st.open), true);
      else pop.style.transform = "translate(-9999px,0)";
    }
    if (st.draft && at.has("draft") && !comp.hidden) placePopover(comp, at.get("draft"));

    // In the app the shell's insets say what its islands cover; in the browser the bar sits under the page's own islands.
    let below = 0;
    if (!host.native) { const vt = view.getBoundingClientRect().top; for (const e of document.querySelectorAll(".island")) below = Math.max(below, e.getBoundingClientRect().bottom - vt - 4); }
    shared.style.top = (host.native ? 12 : below + 12) + "px";
    shared.style.right = (ins.r || 0) + 12 + "px";
    if (hovId) paintHover();
  }
  host.beforeFrame(() => { if (pins.size || st.draft || hovId) place(); });
  host.on("render", schedule);
  host.on("visible", schedule);
  host.on("page", () => { st.open = null; closePinMenu(); closeDraft(); render(); });
  host.on("draw-tool", () => {
    const focused = document.activeElement;
    if (typing(focused) && (comp.contains(focused) || pop.contains(focused))) focused.blur();
    setMode(false, { keepDraft: true });
  });
  host.on("cmd", (c) => {
    if (c && c.cmd === "insets") schedule();
    if (c && c.cmd === "comment") setMode(!st.mode);
    if (c && c.cmd === "commentsSidebar" && typeof c.open === "boolean" && c.open === sidebar.hidden) showList(c.open);
  });
  host.on("resync", () => { if (host.native) host.post({ commentsSidebar: !sidebar.hidden }); resyncPeople(); load(); });
  if (host.es) host.es.addEventListener("comments", () => load());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { resyncPeople(); load(); } });

  // ---------- fields ----------
  function autoGrow(ta) {
    ta.style.height = "18px";
    ta.style.height = Math.min(120, ta.scrollHeight) + "px";
    ta.classList.toggle("scroll", ta.scrollHeight > 120);
    schedule();
  }
  /** A field: Return posts, Shift+Return is a new line, Esc cancels. Keys never reach the canvas. */
  function field(placeholder, onPost, onCancel, onChange) {
    const ta = h("textarea", "cm-field");
    ta.rows = 1;
    ta.placeholder = placeholder;
    ta.setAttribute("aria-label", placeholder);
    ta.spellcheck = true;
    // No AutoFill (macOS offers one-time codes from Mail over the controls), autocorrect or writing suggestions.
    for (const [k, v] of [["autocomplete", "off"], ["autocorrect", "off"], ["autocapitalize", "off"], ["writingsuggestions", "false"]]) ta.setAttribute(k, v);
    const picked = [];
    ta.mentions = () => mentionTokens(ta.value.trim(), picked);
    ta.restoreMentions = people => picked.push(...people);
    const menu = h("div", "cm-mentions cm-ui"); menu.hidden = true; menu.setAttribute("role", "listbox");
    let choices = [], active = 0, trigger = null;
    const close = () => { menu.hidden = true; ta.setAttribute("aria-expanded", "false"); };
    ta.onDraft = onChange;
    ta.clearDraft = () => { ta.value = ""; picked.length = 0; close(); autoGrow(ta); onChange?.(false); };
    const choose = (p) => {
      if (!trigger) return;
      const text = "@" + p.name + " ";
      ta.setRangeText(text, trigger.start, trigger.end, "end");
      if (!picked.some(x => (x.email || x.id || x.name) === (p.email || p.id || p.name))) picked.push(p);
      close(); autoGrow(ta); if (onChange) onChange(true); ta.focus();
    };
    const update = () => {
      if (ta.isComposing) return;
      trigger = mentionQuery(ta.value, ta.selectionStart);
      const locals = st.threads.filter(t => !t.deletedAt).flatMap(t => t.comments.filter(c => !c.deletedAt).map(c => c.author));
      choices = trigger ? mentionPeople(st.sync || window.canvasCloudFile ? st.people : locals, trigger.query) : [];
      if (!choices.length) { close(); return; }
      active = Math.min(active, choices.length - 1); menu.replaceChildren();
      choices.forEach((p, i) => { const b = h("button", "", p.name); b.type = "button"; b.setAttribute("role", "option"); b.setAttribute("aria-selected", String(i === active)); b.onpointerdown = e => e.preventDefault(); b.onclick = () => choose(p); menu.append(b); });
      ta.parentElement?.append(menu); menu.hidden = false; ta.setAttribute("aria-expanded", "true");
    };
    ta.setAttribute("aria-autocomplete", "list");
    ta.addEventListener("click", update);
    // Typing takes over from dictation; what it wrote stays.
    ta.addEventListener("input", () => { if (dictation.active === ta) dictation.cancel(); update(); autoGrow(ta); if (onChange) onChange(ta.value.trim() !== ""); });
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (!menu.hidden && !e.isComposing) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length; update(); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(choices[active]); return; }
        if (e.key === "Escape") { e.preventDefault(); close(); return; }
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.isComposing) || e.key === "Escape") { if (dictation.active === ta) dictation.cancel(); }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); const v = ta.value.trim(); if (v) onPost(v, ta); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    });
    ta.addEventListener("keyup", (e) => e.stopPropagation());
    return ta;
  }
  const sendBtn = (label, onClick) => { const b = btnEl("cm-send", ICON.send, label); b.onclick = onClick; return b; };

  /** Focus a field now, and once more after the press that opened it has finished. */
  function focusSoon(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    setTimeout(() => { if (document.activeElement !== el && el.isConnected && !el.closest("[hidden]")) el.focus({ preventScroll: true }); }, 0);
  }

  // ---------- dictation (the app only: /page/dictation-logic.js and the shell's Dictation.swift) ----------
  const dictationPost = (m) => host.post({ dictation: m });
  const dictation = D.createDictation({
    start: (id) => dictationPost({ op: "start", id }),
    stop: (id) => dictationPost({ op: "stop", id }),
    cancel: (id) => dictationPost({ op: "cancel", id }),
  }, { onChange: () => drawMics() });
  const mics = new Set(); // { ta, button, note }
  function drawMics() {
    for (const m of mics) {
      if (!m.ta.isConnected) { mics.delete(m); continue; }
      const phase = dictation.phase(m.ta), on = phase !== "idle";
      m.button.setAttribute("aria-pressed", String(on));
      m.button.classList.toggle("live", phase === "listening");
      const label = on ? "Stop dictation" : "Dictate";
      m.button.setAttribute("aria-label", label);
      m.button.title = label + " (or hold Fn)";
      m.ta.placeholder = phase === "listening" ? "Listening\u2026" : m.ta.getAttribute("aria-label");
      const n = dictation.notice(m.ta), text = n ? n.text : "";
      if (m.note.dataset.text === text) continue;
      m.note.dataset.text = text;
      m.note.hidden = !n;
      m.note.replaceChildren();
      if (n) m.note.append(h("span", "", n.text));
      if (n?.which) {
        const open = h("button", "", "Open System Settings");
        open.type = "button";
        open.onclick = () => dictationPost({ settings: n.which });
        m.note.append(open);
      }
      schedule();
    }
  }
  /** A field's mic button and the line under it, or null outside the app. */
  function micFor(ta) {
    if (!host.native) return null;
    const button = btnEl("cm-send cm-mic", ICON.mic, "Dictate");
    const note = h("div", "cm-micnote");
    note.setAttribute("role", "status");
    note.hidden = true;
    note.dataset.text = "";
    ta.dictationField = {
      key: ta,
      read: () => ({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd }),
      write: (value, caret) => {
        // The card this field was in is gone (posted, closed or redrawn): stop listening.
        if (!ta.isConnected || ta.disabled) { dictation.cancel(); return; }
        ta.value = value;
        ta.setSelectionRange(caret, caret);
        autoGrow(ta);
        ta.onDraft?.(value.trim() !== "");
      },
    };
    // The press must not take the focus from the field.
    button.onpointerdown = (e) => e.preventDefault();
    button.onclick = () => { ta.focus(); dictation.toggle(ta.dictationField); };
    mics.add({ ta, button, note });
    queueMicrotask(drawMics);
    return { button, note };
  }
  /** Stop for good when the field that listens is no longer on screen. */
  function dropLostDictation() {
    const ta = dictation.active;
    if (ta && (!ta.isConnected || ta.closest("[hidden]"))) dictation.cancel();
  }
  let fnTimer = 0, fnHeld = false;
  function fnKey(down) {
    clearTimeout(fnTimer);
    if (!down) { if (fnHeld) { fnHeld = false; dictation.stop(); } return; }
    const ta = document.activeElement;
    if (!ta?.dictationField) return;
    fnTimer = setTimeout(() => {
      if (document.activeElement !== ta || dictation.active === ta) return;
      fnHeld = true;
      dictation.start(ta.dictationField);
    }, D.FN_HOLD_MS);
  }
  // Fn with another key (arrows, delete) is that key, not a hold.
  addEventListener("keydown", () => clearTimeout(fnTimer), true);
  host.on("cmd", (c) => {
    if (c?.cmd === "dictation") dictation.event(c);
    if (c?.cmd === "dictationKey") fnKey(!!c.down);
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) dictation.cancel(); });
  addEventListener("pagehide", () => dictation.cancel());

  // ---------- a shared file: what waits, what the server refused ----------
  const opsFor = (list, id) => (list || []).filter((o) => o.comment === id);
  const syncCall = (what, opId) => fetch(`/api/comments/${what}?file=` + encodeURIComponent(file), { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ opId }) })
    .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.statusText); apply(j); })).catch((e) => tell(e.message));
  /** The clock and "Sends when you're back online" (or "Sending" while connected) that stands where the time would be. */
  function pendingState() {
    // Inline, not a row: the meta row lines its baseline up with the name's, and the clock sits on the capitals' middle (cap units).
    const s = h("span", "cm-state wait");
    s.innerHTML = ICON.clock;
    s.append(lbl(st.sync?.canComment === false && st.sync.connected
      ? "Update Canvas on the host to send this comment"
      : st.sync?.connected ? "Sending" : "Sends when you're back online"));
    return s;
  }
  /** "Not sent: reason" with Retry and Discard. */
  function failRow(r) {
    const row = h("div", "cm-fail");
    const s = h("span", "cm-state");
    s.innerHTML = ICON.alert;
    s.append(document.createTextNode(`Not sent: ${L.refusalReason(r, st.sync)}`));
    const retry = txtBtn("cm-btn txt", "Retry"), drop = txtBtn("cm-btn txt dim", "Discard");
    retry.onclick = () => syncCall("retry", r.opId);
    drop.onclick = () => syncCall("discard", r.opId);
    row.append(s, retry, drop);
    return row;
  }
  const syncKey = () => (st.sync ? JSON.stringify([st.sync.connected, st.sync.role, st.sync.canComment, st.sync.pending.map((o) => o.opId), st.sync.rejected.map((o) => [o.opId, o.kind, o.code, o.message])]) : "");

  // ---------- the thread card ----------
  const chip = (name, page) => { const c = h("span", "cm-chip"); c.innerHTML = ICON.layer; c.append(h("span", "", name)); c.title = page ? "On the canvas" : name; return c; };
  function layerLabel(t) {
    const a = t.anchor || {};
    if (!a.nodeId) return { name: "Canvas", gone: false };
    const info = host.layerInfo && !isGoneNow(t) ? host.layerInfo(a.nodeId) : null;
    return { name: (info && info.name) || (a.preview && a.preview.name) || a.nodeId, gone: isGoneNow(t) };
  }
  let popFor = null, popKey = "";
  function resolveThread(t) {
    return sendOps([env({ kind: "thread.resolve", thread: t.id, resolved: !t.resolvedAt })]).catch((e) => tell(e.message));
  }
  function drawThread() {
    const t = st.open && thread(st.open);
    if (!t || !L.stillOpen(st.open, st.threads, showResolved)) {
      // A hidden field keeps the focus until the next frame: keys would go to it, not the canvas.
      if (!pop.hidden && pop.contains(document.activeElement)) document.activeElement.blur();
      pop.hidden = true; popFor = null; popKey = ""; dropLostDictation(); return;
    }
    const where = layerLabel(t);
    const live = L.liveComments(t);
    const key = JSON.stringify([t.id, t.resolvedAt || "", where, live.map((c) => [c.id, c.body, c.mentions, c.editedAt || ""]), st.me, st.sync?.me, syncKey()]);
    pop.hidden = false;
    if (popFor === t.id && popKey === key) return;
    const keep = popFor === t.id ? pop.querySelector(".cm-field") : null;
    const draftText = keep ? keep.value : "";
    const draftMentions = keep?.mentions?.() || [];
    const hadFocus = keep && document.activeElement === keep;
    popFor = t.id; popKey = key;
    pop.textContent = "";
    // Resolve is a check at the end of the first comment's name row; Delete thread is in the thread's right-click menu.
    const resolveBtn = () => {
      const b = btnEl("cm-btn cm-res" + (t.resolvedAt ? " on" : ""), ICON.check, t.resolvedAt ? "Reopen thread" : "Resolve thread");
      b.title = t.resolvedAt ? "Reopen" : "Resolve";
      b.onclick = () => resolveThread(t);
      return b;
    };
    if (where.gone) {
      const band = h("div", "cm-gone");
      const g = h("span", "cm-ghost"); g.innerHTML = ICON.ghost;
      const gt = h("div", "cm-gt");
      gt.append(h("b", "", "Layer deleted"), h("span", "cm-gl", L.previewLine(t.anchor && t.anchor.preview)));
      const re = txtBtn("cm-btn txt", "Pin to a layer");
      re.onclick = () => { st.repin = t.id; st.open = null; setMode(true); render(); };
      const top = h("div", "cm-top"), acts = h("div", "cm-acts");
      top.append(g, gt);
      acts.append(re);
      band.append(top, acts);
      pop.append(band, h("div", "cm-sep"));
    }
    const lst = h("div", "cm-list");
    live.forEach((c, i) => {
      const it = h("div", "cm-item");
      const body = h("div", "cm-body");
      const who = h("div", "cm-who");
      const waiting = opsFor(st.sync && st.sync.pending, c.id).length > 0;
      const tm = h("time", "", L.ago(c.createdAt));
      tm.title = c.createdAt;
      who.append(h("b", "", c.author && c.author.name ? c.author.name : "Someone"), waiting ? pendingState() : tm);
      if (i === 0) { who.classList.add("first"); who.append(resolveBtn()); }
      if (i > 0) {
        const x = btnEl("cm-btn", ICON.trash, "Delete comment");
        x.title = "Delete comment";
        x.onclick = () => sendOps([env({ kind: "comment.delete", comment: c.id })]).catch((e) => tell(e.message));
        who.append(x);
      }
      if (mentionedYou(c, st.sync?.me || { name: st.me })) who.append(h("span", "cm-state", "mentioned you"));
      const text = h("div", "cm-text"); let offset = 0;
      for (const m of c.mentions || []) {
        if (m.start < offset || c.body.slice(m.start, m.end) !== "@" + m.name) continue;
        text.append(document.createTextNode(c.body.slice(offset, m.start)), h("span", "cm-mention", c.body.slice(m.start, m.end))); offset = m.end;
      }
      text.append(document.createTextNode(c.body.slice(offset))); body.append(who, text);
      for (const r of opsFor(st.sync && st.sync.rejected, c.id)) body.append(failRow(r));
      it.append(avatar(c.author), body);
      lst.append(it);
    });
    pop.append(lst);
    const own = (st.sync ? st.sync.rejected : []).filter((r) => r.thread === t.id && !r.comment);
    if (own.length) { const box = h("div", "cm-failrow"); for (const r of own) box.append(failRow(r)); pop.append(box); }
    if (t.resolvedAt) pop.append(h("div", "cm-note", `Resolved by ${t.resolvedBy && t.resolvedBy.name ? t.resolvedBy.name : "someone"}`));
    pop.append(h("div", "cm-sep"));
    const row = h("div", "cm-row");
    const wrap = h("div", "cm-fieldwrap");
    const send = sendBtn("Send reply", () => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: false })));
    const ta = field("Reply", (v, el) => {
      el.disabled = true;
      sendOps([env({ kind: "comment.add", thread: t.id, comment: crypto.randomUUID(), body: v, mentions: el.mentions() })], () => el.clearDraft())
        .then((j) => {
          el.disabled = false;
          if (j.rejected?.length) return;
          setRead(t.id);
          if (st.open === t.id) pop.querySelector(".cm-field")?.focus();
        })
        .catch((e) => { el.disabled = false; tell(e.message); });
    }, () => openThread(null), (ready) => send.classList.toggle("ready", ready));
    ta.value = draftText;
    ta.restoreMentions(draftMentions);
    send.classList.toggle("ready", draftText.trim() !== "");
    wrap.append(ta);
    const mic = micFor(ta);
    row.append(wrap, ...(mic ? [mic.button] : []), send);
    pop.append(row);
    if (mic) pop.append(mic.note);
    dropLostDictation();
    drawMenu();
    autoGrow(ta);
    lst.scrollTop = lst.scrollHeight;
    if (hadFocus) ta.focus();
    schedule();
  }
  /** The open thread's right-click menu (Delete thread) at st.menu, a point in the card; removed when st.menu is false. */
  function drawMenu() {
    const old = pop.querySelector(".cm-menu");
    if (old) old.remove();
    const t = st.menu && st.open && thread(st.open);
    if (!t || pop.hidden) return;
    const m = h("div", "cm-menu");
    m.setAttribute("role", "menu");
    const del = h("button");
    del.type = "button";
    del.setAttribute("role", "menuitem");
    del.innerHTML = ICON.trash;
    del.append(lbl("Delete thread"));
    del.setAttribute("aria-label", "Delete thread");
    del.onclick = () => { st.menu = false; st.open = null; sendOps([env({ kind: "thread.delete", thread: t.id })]).catch((e) => tell(e.message)); render(); };
    m.append(del);
    pop.append(m);
    // At the pointer, kept inside the card.
    m.style.left = Math.max(4, Math.min(st.menu.x, pop.clientWidth - m.offsetWidth - 4)) + "px";
    m.style.top = Math.max(4, Math.min(st.menu.y, pop.clientHeight - m.offsetHeight - 4)) + "px";
  }
  function openThread(id) {
    closePinMenu();
    st.open = id;
    st.menu = false;
    closeDraft();
    render();
    if (id) { setRead(id); focusSoon(pop.querySelector(".cm-field")); }
  }

  let pinMenu = null;
  function closePinMenu() {
    pinMenu?.remove();
    pinMenu = null;
  }
  function showPinMenu(t, x, y, confirming = false) {
    closePinMenu();
    const menu = h("div", "cm-menu cm-pin-menu cm-ui");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Comment actions");
    const canComment = st.sync?.canComment !== false;
    const focusPin = () => pins.get(t.id)?.el.focus();
    const item = (label, action, { danger = false, disabled = false } = {}) => {
      const b = h("button", danger ? "danger" : "", label);
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.disabled = disabled;
      b.onclick = () => { closePinMenu(); focusPin(); action(); };
      menu.append(b);
    };
    if (confirming) {
      menu.append(h("p", "", "Delete this thread and its replies?"));
      item("Cancel", () => {});
      item("Delete Thread", () => sendOps([env({ kind: "thread.delete", thread: t.id })]).catch((e) => tell(e.message)), { danger: true });
    } else {
      item("Reply", () => openThread(t.id), { disabled: !canComment });
      item(t.resolvedAt ? "Reopen" : "Resolve", () => resolveThread(t), { disabled: !canComment });
      const unread = st.unread.has(t.id);
      item(unread ? "Mark as Read" : "Mark as Unread", () => setRead(t.id, !unread));
      item("Copy Text", async () => {
        const text = L.liveComments(t).map(c => c.body).join("\n\n");
        try {
          if (host.native) host.post({ clipboard: text });
          else await navigator.clipboard.writeText(text);
        } catch { tell("Could not copy comment text"); }
      });
      item("Delete Thread", () => showPinMenu(t, x, y, true), { danger: true, disabled: !canComment });
    }
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll("button:enabled")];
      const index = items.indexOf(document.activeElement);
      if (e.key === "Escape") { closePinMenu(); focusPin(); }
      else if (e.key === "ArrowDown") items[(index + 1) % items.length].focus();
      else if (e.key === "ArrowUp") items[(index + items.length - 1) % items.length].focus();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    const bounds = layer.getBoundingClientRect();
    const left = (host.insets?.l || 0) + 4, right = layer.clientWidth - (host.insets?.r || 0) - 4;
    menu.style.setProperty("--cm-pin-menu-width", Math.max(0, right - left) + "px");
    layer.append(menu);
    menu.style.left = Math.max(left, Math.min(x - bounds.left, right - menu.offsetWidth)) + "px";
    menu.style.top = Math.max(4, Math.min(y - bounds.top, layer.clientHeight - menu.offsetHeight - 4)) + "px";
    pinMenu = menu;
    menu.querySelector("button:enabled")?.focus();
  }

  // ---------- a new thread ----------
  function closeDraft() {
    if (!st.draft) return;
    st.draft = null;
    if (comp.contains(document.activeElement)) document.activeElement.blur();
    comp.hidden = true;
    comp.textContent = "";
    dropLostDictation();
    hovId = null;
    hov.style.display = "none";
    queueHover();
    const p = pins.get("draft");
    if (p) { p.el.remove(); pins.delete("draft"); }
  }
  /** The anchor a click at (cx, cy) makes: the layer under it and the point on it, else a point on the page. */
  function anchorAt(e) {
    const cx = e.clientX, cy = e.clientY, cam = host.cam, vb = host.viewBox;
    const world = { x: (cx - vb.l - cam.x) / cam.z, y: (cy - vb.t - cam.y) / cam.z };
    const id = targetAt(cx, cy, !!e.metaKey);
    const rect = id ? host.worldRectOf(id) : null;
    const chain = id && host.chainOf ? host.chainOf(id) : [];
    const board = chain.length ? chain[0] : null;
    const isCard = !!id && String(id).startsWith("widget:");
    const info = isCard ? { name: "Card", type: "widget" } : id && host.layerInfo ? host.layerInfo(id) : null;
    const nodeId = id && rect ? id : null;
    return L.anchorFor({ nodeId, rect, point: world, page: pageNow() || undefined, board: nodeId && board && !isCard ? board : undefined, info });
  }
  /** A click in comment mode: pin where it landed. Opens the composer there. */
  function startDraft(e) {
    const anchor = anchorAt(e);
    st.open = null;
    closeDraft();
    st.draft = { anchor, spot: () => { if (!anchor.nodeId) return { x: anchor.x, y: anchor.y, kind: "page" }; const r = host.worldRectOf(anchor.nodeId); return r ? L.pinSpot({ anchor }, { layerRect: r }) : null; } };
    comp.textContent = "";
    const fieldRow = h("div", "cm-compfield");
    const wrap = h("div", "cm-fieldwrap");
    const send = sendBtn("Post comment", () => post());
    const ta = field("Add a comment", () => post(), () => { closeDraft(); render(); }, (ready) => send.classList.toggle("ready", ready));
    function post() {
      const v = ta.value.trim();
      if (!v) return;
      ta.disabled = true;
      const a = st.draft && st.draft.anchor;
      sendOps([env({ kind: "thread.create", thread: crypto.randomUUID(), anchor: a, comment: crypto.randomUUID(), body: v, mentions: ta.mentions() })])
        .then((j) => { if (!(j.rejected && j.rejected.length)) closeDraft(); else ta.disabled = false; render(); })
        .catch((err) => { ta.disabled = false; tell(err.message); });
    }
    wrap.append(ta);
    fieldRow.append(avatar({ name: st.me }), wrap);
    const foot = h("div", "cm-foot");
    const mic = micFor(ta);
    foot.append(chip(anchor.preview ? anchor.preview.name || "Layer" : "Canvas", !anchor.nodeId), h("span", "cm-sp"), ...(mic ? [mic.button] : []), send);
    comp.append(fieldRow, foot);
    if (mic) fieldRow.after(mic.note);
    hovId = anchor.nodeId || null;
    paintHover();
    comp.hidden = false;
    render();
    place();
    focusSoon(ta);
  }

  // ---------- the layer under the pointer lights up ----------
  let hovId = null, hovRaf = 0, ptr = null;
  /** What a click or a hover at a window point is on: a board by its title, else the layer the select tool would take. */
  function targetAt(x, y, deep) {
    return host.titleAt?.(x, y) || (host.pickSelectable ? host.pickSelectable(x, y, deep) : host.pick(x, y)) || null;
  }
  function paintHover() {
    const r = hovId && host.worldRectOf(hovId);
    const cam = host.cam;
    if (!r || !cam) { hov.style.display = "none"; return; }
    hov.style.display = "block";
    hov.classList.toggle("cmp", !!host.isCmp?.(hovId));
    hov.style.transform = `translate(${cam.x + r.x * cam.z}px,${cam.y + r.y * cam.z}px)`;
    hov.style.width = r.w * cam.z + "px";
    hov.style.height = r.h * cam.z + "px";
  }
  function trackHover() {
    hovRaf = 0;
    if (drag?.moving) return; // the dragged pin's tip decides
    const over = ptr && !st.draft ? document.elementFromPoint(ptr.x, ptr.y) : null;
    hovId = L.hoverTarget({ mode: st.mode, draft: st.draft?.anchor, pointer: ptr, overUi: !!over?.closest?.(".cm-ui, .cm-pin"), hand: !!host.hand, find: targetAt });
    paintHover();
  }
  function queueHover() { if (!hovRaf) hovRaf = requestAnimationFrame(trackHover); }
  view.addEventListener("pointermove", (e) => { ptr = { x: e.clientX, y: e.clientY, meta: e.metaKey || !!host.cmdHeld?.() }; if (st.mode) queueHover(); });
  view.addEventListener("pointerleave", () => { ptr = null; if (st.mode) queueHover(); });
  // A still pointer gets the new layer too: the canvas moved under it, or Cmd went down or up.
  host.on("cam", () => { if (st.mode && ptr) queueHover(); });
  const cmdChanged = (down) => { if (st.mode && ptr && ptr.meta !== down) { ptr.meta = down; queueHover(); } };
  for (const n of ["keydown", "keyup"]) addEventListener(n, (e) => { if (e.key === "Meta") cmdChanged(n === "keydown"); }, true);
  host.on("cmd", (c) => { if (c?.cmd === "mods") cmdChanged(!!c.meta); });

  // ---------- the bars ----------
  function drawBars() {
    drawShared();
    hint.classList.toggle("on", st.mode);
    hint.innerHTML = "";
    if (st.mode) {
      const m = h("span"); m.innerHTML = ICON.bubble;
      const key = h("span", "cm-key");
      key.append(lbl("esc", "cm-t ex"));
      hint.append(m, h("b", "", st.repin ? "Pin to a layer" : "Comment mode"), h("span", "cm-soft", st.repin ? "Click the layer this comment is about" : "Click a layer to pin a comment"), key);
    }
    const n = L.counts(st.threads);
    const show = !st.mode && n.open + n.resolved > 0;
    bar.classList.toggle("on", show);
    bar.innerHTML = "";
    bar.style.paddingRight = "";
    if (show) {
      const m = h("span"); m.innerHTML = ICON.bubble; m.style.display = "flex";
      bar.append(m, h("span", "", `${n.open} ${n.open === 1 ? "comment" : "comments"}`));
      const unread = st.threads.filter(t => !t.deletedAt && st.unread.has(t.id)).length;
      bar.setAttribute("aria-label", unread ? `Open comments, ${unread} new` : "Open comments");
      if (unread) bar.append(h("span", "cm-new", `${unread} new`));
      if (n.resolved) {
        const b = txtBtn("cm-btn txt dim", showResolved ? `Hide ${n.resolved} resolved` : `Show ${n.resolved} resolved`);
        b.setAttribute("aria-pressed", String(showResolved));
        b.onclick = () => { showResolved = !showResolved; try { localStorage.setItem(SHOW_KEY, showResolved ? "1" : "0"); } catch {} render(); };
        bar.append(b);
      } else bar.style.paddingRight = "12px";
    }
  }

  /** People in this file now, using the cursor roster rather than comment history. */
  let peopleSig = null;
  function resyncPeople() { peopleSig = null; drawShared(); }
  function drawShared() {
    const fileState = window.canvasCloudFile, sync = st.sync;
    const state = fileState || sync;
    shared.classList.toggle("on", !!state);
    if (!state) { shared.replaceChildren(); if (host.native && peopleSig !== "") host.post({peopleStrip:{people:[],status:"connected"}}); peopleSig = ""; return; }
    const me = fileState?.author || sync?.me || { name: st.me || "Me" };
    const own = { by:me, name:me.name || st.me || "Me", role:state.role || "editor", color:L.colorOf(me.name || st.me), self:true };
    const seen = new Set([me.id || me.email || me.name]);
    const people = [own];
    for (const p of host.presence?.people || []) {
      const key = p.by?.id || p.by?.email || p.name;
      if (seen.has(key)) continue; seen.add(key); people.push(p);
    }
    const signature = JSON.stringify([state.status, people.map(p => [p.session, p.name, p.role, p.color])]);
    if (signature === peopleSig) return; peopleSig = signature; shared.replaceChildren();
    if (host.native) host.post({peopleStrip:{people:people.map(p => ({session:p.self ? "self" : p.session,name:p.name,role:p.role,color:p.color})),status:state.status}});
    const group = h("div", "cm-people");
    for (const p of people.slice(0, 4)) {
      const button = h("button", "cm-av"); button.type = "button";
      button.append(lbl(L.initialOf(p.name))); button.style.background = p.color;
      button.title = p.name + ", " + p.role; button.setAttribute("aria-label", button.title);
      button.onclick = () => focusPerson(p.self ? "self" : p.session);
      group.append(button);
    }
    if (people.length > 4) { const more = h("span", "cm-av cm-more", "+" + (people.length - 4)); more.title = people.slice(4).map(p => p.name + ", " + p.role).join("\n"); group.append(more); }
    shared.append(group);
    const status = state.status;
    shared.dataset.status = status; shared.setAttribute("aria-label", "People in this file");
    if (status !== "connected") {
      const text = h("span", "cm-server", ["offline", "down", "notAdded", "removed", "signedOut", "signInAgain", "forbidden"].includes(status) ? "Offline" : "Reconnecting");
      text.title = status === "removed" ? "Removed from this Cloud. Ask the host for a new invite" : status === "down" ? "Cloud down: its Mac isn't open right now. Comments are kept and sent when it is back" : text.textContent;
      shared.append(text);
    }
  }
  async function focusPerson(session) {
        if (session === "self") return;
        const current = host.presence?.people.find(person => person.session === session);
        if (!current) return;
        if (current.page && current.page !== host.page) await host.setPage(current.page);
        const r = (current.sel || []).map(id => host.worldRectOf(id)).find(Boolean);
        const cursor = current.cursor || current.lastCursor;
        if (r) host.fitRect(r, 80, host.cam.z);
        else if (cursor) host.fitRect({ x:cursor.x-20, y:cursor.y-20, w:40, h:40 }, 80, host.cam.z);
  }
  host.on("cmd", c => { if (c.cmd === "focusPerson") focusPerson(c.session); });
  host.on("presencechange", drawShared);

  // ---------- comment mode ----------
  function setMode(on, { keepDraft = false } = {}) {
    on = !!on;
    if (st.mode === on) return;
    st.mode = on;
    view.classList.toggle("cm-mode", on);
    if (btn) { btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", String(on)); }
    if (!on) {
      if (!keepDraft) closeDraft();
      st.repin = null;
      if (!st.draft) { hovId = null; hov.style.display = "none"; }
    } else queueHover();
    render();
    host.emit("commentmode", on);
  }

  // The browser's bar has a button; the app's shell takes the key and {cmd: "comment"}.
  let btn = null;
  if (!host.native) {
    const snap = document.querySelector(".island #snapBtn");
    if (snap) {
      btn = h("button", "", "Comment");
      btn.id = "commentBtn";
      btn.title = "Comment on the canvas  C";
      btn.setAttribute("aria-pressed", "false");
      btn.onclick = () => setMode(!st.mode);
      snap.parentNode.insertBefore(btn, snap);
    }
  }

  addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (pinMenu?.contains(e.target)) return;
    if (e.key === "Escape" && !typing(e.target)) {
      if (drag) { const moving = drag.moving; cancelDrag(); if (moving) { e.preventDefault(); e.stopPropagation(); return; } }
      if (st.menu && st.open) { st.menu = false; drawMenu(); e.preventDefault(); e.stopPropagation(); return; }
      if (st.draft) { closeDraft(); render(); e.preventDefault(); e.stopPropagation(); return; }
      if (st.open) { openThread(null); e.preventDefault(); e.stopPropagation(); return; }
      if (st.mode) { setMode(false); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.key !== "c" && e.key !== "C") return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || typing(e.target) || (e.target && e.target.closest && e.target.closest("[contenteditable]"))) return;
    if (host.textEdit && host.textEdit.active) return;
    e.preventDefault();
    setMode(!st.mode);
  }, true);

  // In comment mode a press on the canvas pins a comment instead of selecting, moving or panning. Space (hand) and the
  // other buttons keep working. Everything inside a comment card is the card's own.
  const inUi = (t) => !!(t && t.closest && t.closest(".cm-ui, .cm-pin"));
  let pressed = null;
  const mine = (e) => st.mode && !host.hand && e.button === 0 && view.contains(e.target) && !inUi(e.target);
  addEventListener("pointerdown", (e) => {
    if (pinMenu && !pinMenu.contains(e.target)) closePinMenu();
    if (!inUi(e.target) && (st.open || st.draft) && view.contains(e.target) && !st.mode) { st.menu = false; openThread(null); closeDraft(); render(); }
    if (!mine(e)) { pressed = null; return; }
    e.preventDefault(); e.stopImmediatePropagation();
    pressed = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }, true);
  addEventListener("pointerup", (e) => {
    if (!pressed || e.pointerId !== pressed.id) return;
    const p = pressed; pressed = null;
    e.preventDefault(); e.stopImmediatePropagation();
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) return;
    if (st.repin) {
      const id = st.repin, a = anchorAt(e);
      if (!a.nodeId) { tell("Click a layer to pin this comment to"); return; }
      st.repin = null;
      sendOps([env({ kind: "thread.move", thread: id, anchor: a })]).then(() => { setMode(false); openThread(id); }).catch((err) => tell(err.message));
      return;
    }
    startDraft(e);
  }, true);
  for (const n of ["mousedown", "mouseup", "click", "dblclick"]) {
    addEventListener(n, (e) => { if (st.mode && !host.hand && e.button === 0 && view.contains(e.target) && !inUi(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  }
  // Presses inside a card or on a pin must not start a canvas gesture either.
  for (const n of ["pointerdown", "pointerup", "mousedown", "dblclick"]) layer.addEventListener(n, (e) => { if (inUi(e.target)) e.stopPropagation(); }, false);
  // A right-click on the open thread shows its menu (Delete thread) at the pointer; the reply field keeps the system's
  // own (paste, spelling). Never the canvas's layer menu. A press anywhere else in the card closes it.
  pop.addEventListener("contextmenu", (e) => {
    e.stopPropagation();
    if (typing(e.target)) return;
    e.preventDefault();
    const r = pop.getBoundingClientRect(), z = pop.offsetWidth ? r.width / pop.offsetWidth : 1;
    st.menu = { x: Math.round((e.clientX - r.left) / z), y: Math.round((e.clientY - r.top) / z) };
    drawMenu();
  });
  pop.addEventListener("pointerdown", (e) => {
    if (!st.menu || e.button === 2 || (e.target.closest && e.target.closest(".cm-menu"))) return;
    st.menu = false; drawMenu();
  });

  host.comments = {
    get mode() { return st.mode; },
    get threads() { return st.threads; },
    get open() { return st.open; },
    get doc() { return st.doc; },
    get sync() { return st.sync; },
    setMode,
    reload: load,
    /** The add pin's cursor (QA draws it beside a pin to check that both are one shape): its SVG and its hotspot. */
    addPin: { svg: addPinSvg, hot: ADD_HOT },
  };
  load();
}

if (host && host.file && host.view) start(host);
