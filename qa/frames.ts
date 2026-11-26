// Every frame the engine draws during a gesture, recorded in the page and checked there: an end-state picture
// cannot see a frame that flickered, and the maintainer's auto layout drags "glitched all over the canvas" while the
// result was right.
//
// The recorder wraps the engine's frame(): right after each frame composites, in the same task (the drawing buffer is
// surely current), it copies a region of the engine's canvas with the pointer the frame was drawn for. The page's
// DOM layers (selection box, hover outline, the blue insertion line) are not in it: only what the engine drew. The
// analysis runs in the page too (a few hundred frames of the view are hundreds of MB, too much for DevTools).
import fs from "node:fs";
import path from "node:path";
import { encodePng } from "../fidelity/png.ts";
import { Fail, type Rect, type T } from "./harness.ts";
import { sleep, type Mods } from "./lib.ts";

/** Installs window.__frames in the page (idempotent). Regions and rects are in canvas device px. */
export const RECORDER_JS = String.raw`(() => {
  if (window.__frames) return true;
  const h = window.canvasHost, ev = h && h.engineView;
  if (!ev || !ev.engine || !ev.canvas) return false;
  const e = ev.engine, canvas = ev.canvas, own = e.frame;
  let rec = null, px = 0, py = 0;
  addEventListener("pointermove", (m) => { px = m.clientX; py = m.clientY; }, true);
  const grab = (r) => {
    const c = grab.c || (grab.c = document.createElement("canvas"));
    if (c.width !== r.w || c.height !== r.h) { c.width = r.w; c.height = r.h; }
    const g = c.getContext("2d", { willReadFrequently: true });
    g.clearRect(0, 0, r.w, r.h);
    g.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return g.getImageData(0, 0, r.w, r.h).data;
  };
  e.frame = function () {
    const more = own.call(e);
    if (rec && rec.frames.length < rec.max && rec.seen++ % rec.every === 0) {
      if (!rec.region) { rec.frames.push({ t: performance.now() }); return more; }
      // Where the drag drew its layer (autolayout.js state.drawn) and where the pointer was, in world units.
      const st = h.autolayout && h.autolayout.state, c = h.cam, vr = h.view.getBoundingClientRect();
      rec.frames.push({ t: performance.now(), px, py, wx: (px - vr.left - c.x) / c.z, wy: (py - vr.top - c.y) / c.z, drawn: st && st.drawn ? { x: st.drawn.x, y: st.drawn.y } : null, data: grab(rec.region) });
    }
    return more;
  };
  window.__frames = {
    dpr: () => canvas.width / Math.max(1, canvas.clientWidth),
    start(region = null, max = 900, every = 1) { rec = { region, frames: [], max, every, seen: 0 }; return true; },
    stop() { const r = rec; rec = null; return r; },
    // The pictures the frames are checked against: before the gesture (A) and after it settled (B). Composited once
    // more and copied in the same task (engine-view's capture): outside a frame the drawing buffer may be cleared.
    ref(name, region) { const c = ev.capture([{ sx: region.x, sy: region.y, sw: region.w, sh: region.h, w: region.w, h: region.h }])[0]; this[name] = c.getContext("2d").getImageData(0, 0, region.w, region.h).data; return true; },
    last: null,
  };
  return true;
})()`;

/** Measure engine frame spacing without copying pixels. */
export async function recordFrameGaps(
  ev: <R>(js: string) => Promise<R>,
  gesture: () => Promise<unknown>,
): Promise<number[]> {
  if (!(await ev<boolean>(RECORDER_JS))) throw new Fail("no engine to record");
  await ev("window.__frames.start()");
  let times: number[];
  try {
    await gesture();
  } finally {
    times = await ev<number[]>("window.__frames.stop().frames.map((f) => f.t)");
  }
  if (times.length < 10) throw new Fail(`only ${times.length} engine frames during the gesture`);
  return times.slice(1).map((time, i) => time - times[i]);
}

/**
 * Checks the recorded frames of a drag in auto layout (FRAME_CHECK_JS(spec)), every frame against A (before the
 * drag) and B (after the drop settled), in canvas px:
 *   outside  everything outside the auto layout frames the drag changes (`areas`) and outside the dragged layer's
 *            box at the pointer is A, pixel for pixel: nothing else on the canvas moves, flickers or greys out
 *   kids     each other child of those frames is drawn where it was (A) or where it lands (B), or (sliding, without
 *            Reduce Motion) its picture on the line between: never elsewhere, never missing, never half drawn, never
 *            with its images gone (pixels under the dragged layer left out)
 *   lag      the dragged layer is drawn at the pointer of the frame (spec.lag: how far behind it may be, world px)
 */
export const FRAME_CHECK_JS = String.raw`((spec) => {
  const rec = window.__frames.stop();
  const { A, B } = window.__frames;
  const { areas, ghost0, p0, kids, tol, dpr } = spec;
  const R = rec.region, W = R.w, H = R.h;
  const off = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > tol.px;
  const inR = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
  const grow = (r, k) => ({ x: r.x - k, y: r.y - k, w: r.w + 2 * k, h: r.h + 2 * k });
  const zones = areas.map((r) => grow(r, 2));
  let prev = null;
  const bad = [];
  rec.frames.forEach((f, n) => {
    // The dragged layer's box at this frame's pointer (and the last frame's: the frame of a drop draws the layer
    // where the last move left it).
    const g = grow({ x: ghost0.x + (f.px - p0.x) * dpr, y: ghost0.y + (f.py - p0.y) * dpr, w: ghost0.w, h: ghost0.h }, 3);
    const gs = prev ? [g, prev] : [g];
    prev = g;
    const free = (x, y) => !gs.some((r) => inR(r, x, y));
    const D = f.data;
    const probs = [];
    let n0 = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const X = x + R.x, Y = y + R.y;
      if (zones.some((z) => inR(z, X, Y)) || !free(X, Y)) continue;
      if (off(D, A, (y * W + x) * 4)) { n0++; if (X < x0) x0 = X; if (Y < y0) y0 = Y; if (X > x1) x1 = X; if (Y > y1) y1 = Y; }
    }
    if (n0 > tol.outside) probs.push(n0 + " px outside the auto layout frame changed (" + x0 + "," + y0 + " to " + x1 + "," + y1 + ")");
    for (const k of kids) {
      const score = (ref, at) => {
        let seen = 0, diff = 0;
        for (let y = Math.max(at.y, R.y); y < Math.min(at.y + at.h, R.y + H); y++) for (let x = Math.max(at.x, R.x); x < Math.min(at.x + at.w, R.x + W); x++) {
          if (!free(x, y)) continue;
          seen++;
          if (off(D, ref, ((y - R.y) * W + (x - R.x)) * 4)) diff++;
        }
        return seen ? diff / seen : 0;
      };
      const a = score(A, k.a), b = score(B, k.b);
      if (a <= tol.kid || b <= tol.kid) continue;
      // Without Reduce Motion the siblings slide (autolayout.js): on the way, a child is its picture from A moved
      // somewhere along the line to where it lands (at a fraction of a pixel: antialiasing differs more).
      let best = 1;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(k.b.x - k.a.x), Math.abs(k.b.y - k.a.y))));
      for (let s = 0; s <= steps && best > tol.slide; s++) {
        const dx = Math.round(((k.b.x - k.a.x) * s) / steps), dy = Math.round(((k.b.y - k.a.y) * s) / steps);
        let seen = 0, diff = 0;
        for (let y = 0; y < k.a.h; y += 2) for (let x = 0; x < k.a.w; x += 2) {
          const ax = k.a.x + x, ay = k.a.y + y, fx = ax + dx, fy = ay + dy;
          if (!free(fx, fy) || ax < R.x || ay < R.y || fx < R.x || fy < R.y || ax >= R.x + W || ay >= R.y + H || fx >= R.x + W || fy >= R.y + H) continue;
          seen++;
          const i = ((fy - R.y) * W + (fx - R.x)) * 4, j = ((ay - R.y) * W + (ax - R.x)) * 4;
          if (Math.abs(D[i] - A[j]) + Math.abs(D[i + 1] - A[j + 1]) + Math.abs(D[i + 2] - A[j + 2]) > tol.px) diff++;
        }
        if (seen) best = Math.min(best, diff / seen);
      }
      if (best > tol.slide) probs.push(k.id + " is neither where it was, where it lands, nor on its way (" + Math.round(a * 100) + "%, " + Math.round(b * 100) + "% and " + Math.round(best * 100) + "% of its px differ)");
    }
    if (spec.lag !== undefined && f.drawn) {
      const behind = Math.hypot(f.wx - f.drawn.x, f.wy - f.drawn.y);
      if (behind > spec.lag) probs.push("the layer is drawn " + Math.round(behind * 10) / 10 + " px behind the pointer");
    }
    if (probs.length) bad.push({ n, probs });
  });
  window.__frames.last = rec;
  // Frame timing while the layer was being dragged (frames that drew it).
  const ts = rec.frames.filter((f) => f.drawn).map((f) => f.t), gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  return { frames: rec.frames.length, bad, gapP50: gaps.length ? gaps[gaps.length >> 1] : 0, gapP95: gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] : 0, gapMax: gaps.length ? gaps[gaps.length - 1] : 0 };
})`;

/** Writes frames n of the last recording (-1: the picture before, -2: after) as PNGs into dir; returns the paths. */
export async function saveFrames(ev: <R>(js: string) => Promise<R>, ns: number[], dir: string, prefix: string): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const outs: string[] = [];
  for (const n of ns) {
    const f = await ev<{ w: number; h: number; b64: string } | null>(`(() => { const r = window.__frames.last, f = r && (${n} < 0 ? { data: window.__frames[${n} === -1 ? "A" : "B"] } : r.frames[${n}]); if (!f || !f.data) return null; let s = ""; const d = f.data; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000)); return { w: r.region.w, h: r.region.h, b64: btoa(s) }; })()`);
    if (!f) continue;
    const p = path.join(dir, n < 0 ? `${prefix}-${n === -1 ? "before" : "after"}.png` : `${prefix}-f${String(n).padStart(3, "0")}.png`);
    fs.writeFileSync(p, encodePng({ width: f.w, height: f.h, data: new Uint8Array(Buffer.from(f.b64, "base64")) } as any));
    outs.push(p);
  }
  return outs;
}

/** engine setDebug(32): the tile budget admits one render a frame, as on a GPU other apps keep busy. */
export const BUSY_GPU = 32;

type Pt = { x: number; y: number };
/** What a drag check needs from a page: headless Chrome (pageDriver) or the app's web view (qa/native). Points in the page's client CSS px. */
export type Driver = {
  ev<R = any>(js: string): Promise<R>;
  select(ids: string[]): Promise<void>;
  settle(): Promise<void>;
  drag(from: Pt, to: Pt, steps: number, keys?: string[], late?: Mods): Promise<void>;
};
export function pageDriver(t: T): Driver {
  return {
    ev: (js) => t.ev(js),
    select: (ids) => t.select(ids),
    settle: async () => { await t.flush(); await t.settle(); },
    drag: (a, b, steps, keys, late) => t.io.drag(a.x, a.y, b.x, b.y, { steps, keys, late }),
  };
}
/** Layers' drawn rects in client CSS px (the page's own numbers, as qa/harness.ts T.rect). */
export async function clientRects(d: Driver, ids: string[]): Promise<Record<string, Rect>> {
  const out = await d.ev<Record<string, Rect | null>>(`(() => { const h = window.canvasHost, c = h.cam, o = {}; for (const id of ${JSON.stringify(ids)}) { const r = h.worldRectOf(id); o[id] = r ? { x: h.viewBox.l + r.x * c.z + c.x, y: h.viewBox.t + r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z } : null; } return o; })()`);
  for (const id of ids) if (!out[id]) throw new Fail(`${id} is not drawn`);
  return out as Record<string, Rect>;
}
export const centerOf = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export type DragCheck = {
  /** The layer to drag (selected first: a press on a selected flow child starts a reorder drag). */
  id: string;
  /** Where to drop it, client px. */
  to: Pt;
  /** The auto layout frames the drag changes: their rects before and after are left out of the outside check. */
  areas: string[];
  /** Their other children: each must show where it was or where it lands. */
  kids: string[];
  /** Run on a GPU that renders one tile a frame (BUSY_GPU). */
  busy?: boolean;
  /** Share of a child's px that may differ (antialiasing, text that runs under a neighbour). Default 0.05. */
  kidTol?: number;
  steps?: number;
  /** Keys held through the drag once it has started (e.g. "Space": the layer keeps its parent). */
  keys?: string[];
  /** Modifiers held once the drag has started (e.g. Cmd: no snapping, so the layer stays at the pointer). */
  late?: Mods;
  /** Layers to select before the drag (default: just `id`). */
  select?: string[];
  /** Where to write the frames of a failure (and the before and after pictures). */
  evidence: string;
};

/**
 * Drags `id` to `to` with real input while recording every frame, then checks the frames (FRAME_CHECK_JS).
 * Returns the problems (empty when every frame was right) and the frame timing while the layer was dragged.
 */
export async function checkDragFrames(d: Driver, c: DragCheck): Promise<{ problems: string[]; frames: number; gapP50: number; gapP95: number; gapMax: number }> {
  if (!(await d.ev<boolean>(RECORDER_JS))) throw new Fail("no engine to record");
  const vr = await d.ev<Rect & { dpr: number }>("(() => { const r = window.canvasHost.view.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, dpr: window.__frames.dpr() }; })()");
  const cpx = (r: Rect): Rect => ({ x: Math.round((r.x - vr.x) * vr.dpr), y: Math.round((r.y - vr.y) * vr.dpr), w: Math.round(r.w * vr.dpr), h: Math.round(r.h * vr.dpr) });
  const region = { x: 0, y: 0, w: Math.round(vr.w * vr.dpr), h: Math.round(vr.h * vr.dpr) };
  await d.select(c.select ?? [c.id]);
  await d.settle();
  const ids = [...c.areas, ...c.kids];
  const a = await clientRects(d, [c.id, ...ids]);
  const from = centerOf(a[c.id]);
  if (c.busy) await d.ev(`window.canvasHost.engineView.engine.setDebug(${BUSY_GPU})`);
  try {
    await d.ev(`window.__frames.ref("A", ${JSON.stringify(region)})`);
    await d.ev(`window.__frames.start(${JSON.stringify(region)})`);
    await d.drag(from, c.to, c.steps ?? 24, c.keys, c.late);
    await d.settle();
    await sleep(150);
  } finally {
    if (c.busy) await d.ev("window.canvasHost.engineView.engine.setDebug(0)");
  }
  await d.ev(`window.__frames.ref("B", ${JSON.stringify(region)})`);
  const b = await clientRects(d, ids);
  const spec = {
    areas: c.areas.flatMap((id) => [cpx(a[id]), cpx(b[id])]), ghost0: cpx(a[c.id]), p0: from, dpr: vr.dpr, lag: 0.5,
    kids: c.kids.map((id) => ({ id, a: cpx(a[id]), b: cpx(b[id]) })), tol: { px: 30, outside: 0, kid: c.kidTol ?? 0.05, slide: 0.3 },
  };
  const r = await d.ev<{ frames: number; bad: { n: number; probs: string[] }[]; gapP50: number; gapP95: number; gapMax: number }>(`${FRAME_CHECK_JS}(${JSON.stringify(spec)})`);
  // QA_FRAMES_KEEP=1: every drag's frames are written (six spread over it, and before and after), pass or fail.
  if (process.env.QA_FRAMES_KEEP) {
    const ns = [0, 1, 2, 3, 4, 5].map((k) => Math.min(r.frames - 1, Math.round((k * (r.frames - 1)) / 5)));
    await saveFrames((js) => d.ev(js), [-1, -2, ...new Set(ns)], path.join(c.evidence, "kept"), c.id.replace(/[^a-z0-9]+/gi, "-") + (c.busy ? "-busy" : ""));
  }
  const problems: string[] = [];
  if (r.frames < 5) problems.push(`only ${r.frames} frames were drawn during the drag`);
  if (r.bad.length) {
    const first = r.bad.slice(0, 3);
    const tag = c.id.replace(/[^a-z0-9]+/gi, "-");
    const saved = await saveFrames((js) => d.ev(js), [-1, -2, ...first.map((x) => x.n)], c.evidence, tag).catch(() => [] as string[]);
    problems.push(`${r.bad.length} of ${r.frames} frames dragging ${c.id}${c.busy ? " (busy GPU)" : ""} are wrong; frame ${first.map((x) => `${x.n}: ${x.probs.join("; ")}`).join(" | frame ")}${saved.length ? ` (frames in ${c.evidence})` : ""}`);
  }
  return { problems, frames: r.frames, gapP50: r.gapP50, gapP95: r.gapP95, gapMax: r.gapMax };
}

// ---------------------------------------------------------------- the fixture

const IMG = { type: "image", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAG0lEQVR4XmP4Oo/7P9/Sl/9hNAMyByTIQFAFAIGHKcG3a15jAAAAAElFTkSuQmCC", mode: "fill" };
const inter = (size: number, weight = "500") => ({ fontFamily: "Inter", fontSize: size, fontWeight: weight, lineHeight: 1 });
/**
 * A board of nested auto layout at world (0, 700), for the Style page (a board added on the first page is listed
 * on no page: src/structure.ts keepOnPage): a column (qd_list) of rows (qd_r0..3: an image avatar, a label, a
 * chip), and a tray (qd_tray) to drop into.
 */
export function dragBoard(): Record<string, unknown> {
  const row = (i: number) => ({
    type: "frame", id: `qd_r${i}`, name: `Row ${i}`, layout: "horizontal", gap: 10, padding: [8, 10], alignItems: "center", width: "fill_container", fill: i % 2 ? "#FFFFFF" : "#E2E8F0", cornerRadius: 8,
    children: [
      { type: "ellipse", id: `qd_r${i}a`, name: "Avatar", width: 32, height: 32, fill: IMG },
      { type: "text", id: `qd_r${i}t`, name: "Label", content: `Row ${i}`, fill: "#0F172A", ...inter(14), width: 120, textGrowth: "fixed-width" },
      { type: "rectangle", id: `qd_r${i}c`, name: "Chip", width: 44, height: 18, cornerRadius: 9, fill: ["#F43F5E", "#F59E0B", "#22C55E", "#3B82F6"][i] },
    ],
  });
  return {
    type: "frame", id: "qa_drag", name: "Drag in auto layout", x: 0, y: 700, width: 640, height: 400, fill: "#FFFFFF", cornerRadius: 12, clip: true, layout: "none",
    children: [
      { type: "frame", id: "qd_list", name: "List", x: 24, y: 40, width: 320, layout: "vertical", gap: 8, padding: 12, fill: "#F8FAFC", cornerRadius: 10, children: [0, 1, 2, 3].map(row) },
      { type: "frame", id: "qd_tray", name: "Tray", x: 380, y: 40, layout: "horizontal", gap: 8, padding: 10, fill: "#ECFDF5", cornerRadius: 10, children: [0, 1, 2].map((i) => ({ type: "rectangle", id: `qd_t${i}`, name: `Tray ${i}`, width: 40, height: 40, cornerRadius: 6, fill: ["#0EA5E9", "#6366F1", "#A855F7"][i] })) },
    ],
  };
}
