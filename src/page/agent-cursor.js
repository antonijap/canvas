// The agent cursor: while an agent edits the document through Canvas MCP (a talk-to-the-selection run, or any agent
// session), a second cursor on the canvas shows where: an arrow with the agent's name ("Claude", "Codex"), neutral
// (text-coloured: dark with white type in the light theme, light with dark type in the dark; blue is only the
// canvas selection's; the press, the dragged box and the caret are near-black with a white halo, so they read
// on light and dark boards alike), glides to the layer an edit targets, presses (a pulse), and for a move or a resize drags along the
// change; a text edit shows a caret, a new layer is drawn in as a box. It lives in world coordinates, so it follows
// pan and zoom. It never moves the person's pointer and never takes input (pointer-events: none on all of it).
//
// The server tells the page what each MCP edit did (the "agentedit" event on the document's stream, src/agent-cursor.ts),
// usually just before the change itself arrives. Edits queue so each stays legible; a burst plays faster so the
// cursor is never more than about a second behind the canvas (/page/agent-cursor-logic.js). Two seconds after the
// last edit it fades out. Reduce motion: it jumps instead of gliding. Settings > Agents turns it off or sets its speed.

import * as L from "/page/agent-cursor-logic.js";

const host = window.canvasHost;
if (host && host.file && host.es) start(host);

/** How long after an edit arrives it starts to play: the change reaches the canvas in the meantime (a diff, a layout). */
const SETTLE_MS = 120;
/** How long a new layer may take to appear on the canvas before its edit is skipped. */
const ADD_WAIT_MS = 1000;

function start(host) {
  const { view } = host;
  const prefs = () => (host.prefs ? host.prefs() : {});
  const enabled = () => prefs().agentCursor !== false;
  const speed = () => L.speedOf(prefs().agentCursorSpeed);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => motion.matches;

  const css = document.createElement("style");
  css.textContent = `
.ac-layer{position:absolute;left:0;top:0;width:0;height:0;z-index:13;pointer-events:none;font-family:var(--c-font-sans);-webkit-font-smoothing:antialiased;display:none}
.ac-layer *{pointer-events:none;box-sizing:border-box}
.ac-cur{position:absolute;left:0;top:0;will-change:transform}
.ac-cur svg{display:block;overflow:visible;filter:drop-shadow(0 1px 1px #00000040) drop-shadow(0 3px 8px #00000026)}
.ac-tag{position:absolute;left:13px;top:18px;padding:4px 7px;border-radius:7px;background:var(--c-primary);color:var(--c-primary-fg);font-size:11px;line-height:1;font-weight:600;white-space:nowrap;box-shadow:0 0 0 .5px #0000001a,0 1px 2px #00000029,0 6px 14px -4px #00000040}
.ac-ring{position:absolute;left:0;top:0;width:30px;height:30px;border-radius:50%;background:#18181b2e;box-shadow:0 0 0 1px #ffffffb3;display:none}
.ac-box{position:absolute;left:0;top:0;outline:1.5px solid #18181bb3;outline-offset:0;box-shadow:0 0 0 3px #ffffffa6;background:#18181b0d;display:none}
.ac-caret{position:absolute;left:0;top:0;width:2px;border-radius:1px;background:#18181b;box-shadow:0 0 0 1px #ffffffcc;display:none}`;
  document.head.appendChild(css);
  const layer = document.createElement("div");
  layer.className = "ac-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.innerHTML = `<div class="ac-box"></div><div class="ac-ring"></div><div class="ac-caret"></div>`
    + `<div class="ac-cur"><svg width="17" height="21" viewBox="0 0 17 21"><path d="M1.5 1.2v15.9c0 .5.6.7.9.4l3.7-3.5 2.6 5.9c.2.4.6.5 1 .4l2-.9c.4-.2.5-.6.4-1l-2.6-5.8h5.1c.5 0 .7-.6.4-.9L2.4.8C2-.1 1.5.6 1.5 1.2z" fill="var(--c-primary)" stroke="var(--c-primary-fg)" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="ac-tag"></span></div>`;
  view.appendChild(layer);
  const boxEl = layer.querySelector(".ac-box"), ringEl = layer.querySelector(".ac-ring"), caretEl = layer.querySelector(".ac-caret");
  const curEl = layer.querySelector(".ac-cur"), tagEl = layer.querySelector(".ac-tag");

  let queue = [];
  /** The edit playing: { it, start, glide, act, from, pts, rect, span, waitFrom } */
  let cur = null;
  /** The cursor, in world coordinates; null while it has not shown since it last faded. */
  let pos = null;
  let lastEnd = -Infinity, raf = 0;
  /** When the newest edit arrived: the cursor has until a second after it to catch up. */
  let newest = -Infinity;
  const budget = (now) => newest + L.MAX_LAG_MS - now;

  host.es.addEventListener("agentedit", (e) => {
    if (!enabled() || document.hidden) return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    const now = performance.now();
    const agent = String(m.agent || "Agent").slice(0, 24);
    newest = now;
    for (const a of Array.isArray(m.actions) ? m.actions : []) {
      if (!a || typeof a.id !== "string" || !a.kind) continue;
      // Where the layer is now: before the change, unless the canvas caught up first (spanOf sorts it out).
      queue.push({ ...a, agent, at: now, r0: host.worldRectOf(a.id) });
    }
    queue = L.trimQueue(L.coalesce(queue), speed());
    // A backlog: the edit playing now speeds up as well, so the cursor stays within a second of the canvas.
    if (cur && cur.from) Object.assign(cur, L.retime(cur, now, L.timing(queue.length + 1, speed(), reduced(), budget(now))));
    kick();
  });

  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  function clear() {
    queue = [];
    cur = null;
    pos = null;
    lastEnd = -Infinity;
    layer.style.display = "none";
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) clear(); });
  host.on("prefs", () => { if (!enabled()) clear(); });
  host.on("page", () => clear());

  /** Fill in where an edit happens. Returns false to skip it (its layer is not on this page, or never appeared). */
  function resolve(c, now) {
    const it = c.it;
    const r = host.worldRectOf(it.id);
    if (it.kind === "move" || it.kind === "resize") {
      c.span = L.spanOf(it.r0, r, it);
      if (!c.span) return false;
      c.pts = L.actPoints(it.kind, null, c.span);
    } else if (it.kind === "add") {
      // A new board on another page is not drawn here: its box is no place on this page.
      const owner = !r && it.parent == null && host.pageOfBoard ? host.pageOfBoard(it.id) : null;
      if (owner && owner !== host.page) return false;
      const box = r || (it.parent == null && it.box) || null;
      if (!box) {
        if (c.waitFrom == null) c.waitFrom = now;
        return now - c.waitFrom < ADD_WAIT_MS ? null : false;
      }
      c.rect = box;
      c.pts = L.actPoints("add", box, null);
    } else {
      c.rect = it.kind === "delete" ? it.r0 || r : r || it.r0;
      if (!c.rect) return false;
      c.pts = L.actPoints(it.kind, c.rect, null);
    }
    return !!c.pts;
  }

  function next(now) {
    while (queue.length) {
      if (now < queue[0].at + SETTLE_MS) return false;
      const it = queue.shift();
      const t = L.timing(queue.length + 1, speed(), reduced(), budget(now));
      cur = { it, start: now, glide: t.glide, act: t.act, from: null, pts: null, rect: null, span: null, waitFrom: null };
      const ok = resolve(cur, now);
      if (ok === null) return true; // a new layer not drawn yet: wait for it
      if (ok) { begin(cur, now); return true; }
      cur = null;
    }
    return false;
  }
  function begin(c, now) {
    c.start = now;
    const cam = host.cam;
    // From where the cursor is, or (when it is not showing) from a little up and left of the target.
    c.from = pos && L.idleOpacity(now - lastEnd) > 0 ? pos : { x: c.pts.anchor.x - 70 / cam.z, y: c.pts.anchor.y - 50 / cam.z };
    tagEl.textContent = c.it.agent;
  }

  function frame() {
    raf = 0;
    const cam = host.cam;
    if (!cam || !enabled() || document.hidden) { clear(); return; }
    const now = performance.now();
    if (cur && !cur.from) {
      // Waiting for a new layer to show up.
      const ok = resolve(cur, now);
      if (ok) begin(cur, now);
      else if (ok === false) cur = null;
    }
    if (!cur) next(now);
    let showRing = false, showBox = false, showCaret = false;
    if (cur && cur.from) {
      const c = cur, red = reduced();
      const f = L.frameAt(c.it.kind, c.from, c.pts, c.glide, c.act, now - c.start);
      const at = red && f.phase === "act" ? c.pts.end : f;
      pos = { x: at.x, y: at.y };
      if (f.phase === "act") {
        const p = red ? 1 : f.p;
        // The press: a pulse where the glide ended, growing and fading over the first part of the act.
        const pp = Math.min(1, f.p / 0.7);
        if (pp < 1) {
          const s = L.toScreen(c.pts.anchor, cam), k = red ? 1 : 0.5 + pp;
          ringEl.style.transform = `translate(${s.x - 15}px,${s.y - 15}px) scale(${k})`;
          ringEl.style.opacity = String(1 - pp);
          showRing = true;
        }
        const g = L.ghostAt(c.it.kind, c.span, c.rect, p);
        if (g) {
          const s = L.toScreen(g, cam);
          Object.assign(boxEl.style, { transform: `translate(${s.x}px,${s.y}px)`, width: `${Math.max(0, g.w * cam.z)}px`, height: `${Math.max(0, g.h * cam.z)}px` });
          showBox = true;
        }
        if (c.it.kind === "text") {
          const s = L.toScreen(c.pts.anchor, cam), h = Math.max(10, Math.min(28, (c.rect ? c.rect.h : 16) * cam.z * 0.8));
          Object.assign(caretEl.style, { transform: `translate(${s.x + 2}px,${s.y - h / 2}px)`, height: `${h}px`, opacity: red || Math.floor(f.p * 4) % 2 === 0 ? "1" : "0" });
          showCaret = true;
        }
      }
      if (f.phase === "done") { lastEnd = now; cur = null; if (queue.length) next(now); }
    }
    ringEl.style.display = showRing ? "block" : "none";
    boxEl.style.display = showBox ? "block" : "none";
    caretEl.style.display = showCaret ? "block" : "none";
    const op = cur && cur.from ? 1 : pos ? L.idleOpacity(now - lastEnd) : 0;
    if (pos && op > 0) {
      const s = L.toScreen(pos, cam);
      curEl.style.transform = `translate(${s.x - 1.5}px,${s.y - 1}px)`;
      layer.style.opacity = String(op);
      layer.style.display = "block";
    } else {
      layer.style.display = "none";
      if (!cur) pos = null;
    }
    if (cur || queue.length || (pos && op > 0)) raf = requestAnimationFrame(frame);
  }
}
