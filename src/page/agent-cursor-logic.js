// The agent cursor's pure parts (src/page/agent-cursor.js draws it): the queue, how fast each edit plays, where the
// cursor is at a moment of an edit, and where a moved or resized layer was. Node-tested (test/agent-cursor.test.ts).
//
// An edit plays in two parts: a glide to the layer (eased, GLIDE_MS) and the act itself (ACT_MS): a click pulse, a
// drag along a move or a resize, a caret for text, a box drawn in for a new layer. Edits that arrive while one plays
// wait in a queue; when the queue would take longer than MAX_LAG_MS to play, every edit plays faster (down to
// MIN_SCALE of its time), and past that the oldest are dropped, so the cursor is never more than about a second
// behind the canvas. IDLE_MS after the last edit the cursor fades out.

export const GLIDE_MS = 320;
export const ACT_MS = 280;
export const MAX_LAG_MS = 1000;
export const MIN_SCALE = 0.22;
export const IDLE_MS = 2000;
export const FADE_MS = 300;
/** Speed setting (Settings > Agents) to a multiplier. */
export const SPEEDS = { slow: 0.7, normal: 1, fast: 1.5 };
export const speedOf = (s) => (typeof s === "number" && s > 0 ? Math.min(3, Math.max(0.25, s)) : SPEEDS[s] || 1);

/** Ease in and out (cubic), 0..1 to 0..1. */
export const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
export const lerpPt = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

/**
 * Consecutive edits of the same layer and kind play as one: a burst of nudges is one drag (their changes added up),
 * a run of property changes one click. Returns a new list.
 */
export function coalesce(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.id === it.id && last.kind === it.kind && last.agent === it.agent && it.kind !== "add" && it.kind !== "delete") {
      const m = { ...last, at: it.at };
      if (it.kind === "move" || it.kind === "resize") {
        for (const k of ["dx", "dy", "dw", "dh"]) if (typeof it[k] === "number") m[k] = (last[k] || 0) + it[k];
      }
      out[out.length - 1] = m;
    } else out.push(it);
  }
  return out;
}

/** The most items that can play within the lag budget at the fastest tempo; older ones beyond it are dropped. */
export function trimQueue(items, speed = 1, maxLag = MAX_LAG_MS) {
  const fastest = ((GLIDE_MS + ACT_MS) * MIN_SCALE) / speedOf(speed);
  const room = Math.max(1, Math.floor(maxLag / fastest));
  return items.length > room ? items.slice(items.length - room) : items;
}

/**
 * The glide and act times of the next edit, `pending` edits waiting including it. `budget`: the ms left until the
 * cursor must have caught up (the newest edit's arrival plus MAX_LAG_MS, less now); the backlog shares it evenly,
 * so the tempo holds while the queue drains instead of slowing down at the end. One edit with time to spare plays
 * at its full time (divided by the speed setting); never faster than MIN_SCALE. Reduce motion: no glide.
 */
export function timing(pending, speed = 1, reduced = false, budget = MAX_LAG_MS) {
  const k = speedOf(speed);
  const glide = GLIDE_MS / k, act = ACT_MS / k;
  const n = Math.max(1, pending);
  const scale = Math.max(MIN_SCALE, Math.min(1, Math.max(0, budget) / (n * (glide + act))));
  return { glide: reduced ? 0 : glide * scale, act: act * scale };
}

/**
 * An edit already playing when a backlog builds up plays faster too: from where it is (the same fraction of the
 * way through), at the backlog's tempo. Returns the new { start, glide, act }; slower is never applied.
 */
export function retime(play, now, t) {
  const old = play.glide + play.act, next = t.glide + t.act;
  if (!(next < old) || old <= 0) return { start: play.start, glide: play.glide, act: play.act };
  const frac = Math.min(1, Math.max(0, (now - play.start) / old));
  return { start: now - frac * next, glide: t.glide, act: t.act };
}

const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * Where a moved (or resized) layer was and is, from its box when the edit arrived (`r0`, read before the canvas
 * caught up, if it had not yet) and its box now (`r1`). The edit's change (`d`: dx, dy, dw, dh) tells which of the
 * two the canvas showed when: whichever reading of r0 lands nearer to r1 wins. Either may be null.
 */
export function spanOf(r0, r1, d) {
  const dx = d.dx || 0, dy = d.dy || 0, dw = d.dw || 0, dh = d.dh || 0;
  const back = (r) => ({ x: r.x - dx, y: r.y - dy, w: r.w - dw, h: r.h - dh });
  const fwd = (r) => ({ x: r.x + dx, y: r.y + dy, w: r.w + dw, h: r.h + dh });
  if (!r1 && !r0) return null;
  if (!r1) return { from: r0, to: fwd(r0) };
  if (!r0) return { from: back(r1), to: r1 };
  const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h);
  // r0 was the old box when moving it forward lands on r1; otherwise the canvas had already changed.
  return dist(fwd(r0), r1) < dist(r0, r1) ? { from: r0, to: r1 } : { from: back(r1), to: r1 };
}

/**
 * The points an edit's act runs between, in world coordinates: `anchor` (where the glide ends and the press is)
 * and `end` (where a drag or a drawn box ends; the anchor for the others). `rect`: the layer's box; `span`: a move
 * or resize's {from, to}.
 */
export function actPoints(kind, rect, span) {
  if ((kind === "move" || kind === "resize") && span) {
    if (kind === "move") return { anchor: center(span.from), end: center(span.to) };
    return { anchor: { x: span.from.x + span.from.w, y: span.from.y + span.from.h }, end: { x: span.to.x + span.to.w, y: span.to.y + span.to.h } };
  }
  if (!rect) return null;
  if (kind === "add") return { anchor: { x: rect.x, y: rect.y }, end: { x: rect.x + rect.w, y: rect.y + rect.h } };
  if (kind === "text") { const p = { x: rect.x + rect.w, y: rect.y + rect.h / 2 }; return { anchor: p, end: p }; }
  const c = center(rect);
  return { anchor: c, end: c };
}

/**
 * The cursor at `t` ms into an edit that starts at `from` (world point), glides to `pts.anchor` for `glide` ms, then
 * acts for `act` ms. Returns { x, y, phase: "glide" | "act" | "done", p } where p is the act's progress 0..1.
 * Drags and drawn boxes carry the cursor from the anchor to the end; a click or a caret holds it at the anchor.
 */
export function frameAt(kind, from, pts, glide, act, t) {
  if (t < glide) {
    const p = ease(t / glide);
    return { ...lerpPt(from, pts.anchor, p), phase: "glide", p: 0 };
  }
  if (t < glide + act) {
    const p = act > 0 ? (t - glide) / act : 1;
    const moves = kind === "move" || kind === "resize" || kind === "add";
    return { ...(moves ? lerpPt(pts.anchor, pts.end, ease(p)) : pts.anchor), phase: "act", p };
  }
  return { ...pts.end, phase: "done", p: 1 };
}

/** The box a drag or a drawn box shows at act progress p: a move slides, a resize grows, a new layer draws in. */
export function ghostAt(kind, span, rect, p) {
  const e = ease(p);
  if ((kind === "move" || kind === "resize") && span) {
    const a = span.from, b = span.to;
    return { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), w: lerp(a.w, b.w, e), h: lerp(a.h, b.h, e) };
  }
  if (kind === "add" && rect) return { x: rect.x, y: rect.y, w: rect.w * e, h: rect.h * e };
  return null;
}

/** Opacity of an idle cursor `since` ms after its last edit ended: full, then a fade over FADE_MS after IDLE_MS. */
export function idleOpacity(since) {
  if (since <= IDLE_MS) return 1;
  return Math.max(0, 1 - (since - IDLE_MS) / FADE_MS);
}

/** World to screen (CSS px in the view). */
export const toScreen = (p, cam) => ({ x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y });
