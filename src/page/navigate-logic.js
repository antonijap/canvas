// The pure half of /page/navigate.js (tested in test/navigate.test.ts): the zoom and view rules as numbers.

/** Canvas's zoom range: 2% to 25600% (server.ts MAX_ZOOM). */
export const MIN_ZOOM = 0.02, MAX_ZOOM = 256;
/** The pixel grid shows from 400% up. */
export const PIXEL_GRID_ZOOM = 4;
/** Arrow keys pan this many screen px with nothing selected; Shift pans further. */
export const PAN_STEP = 40, PAN_STEP_BIG = 200;
/** The rulers' thickness, px. */
export const RULER = 18;

/** The camera after zooming to `z` about a view point (px, py): that point stays put. */
export function zoomAbout(cam, z, px, py) {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  return { z: k, x: px - (px - cam.x) * (k / cam.z), y: py - (py - cam.y) * (k / cam.z) };
}

/**
 * What a key press means here, or null: "in" / "out" (Shift+= and Shift+-, the zoom keys; "+" typed any way
 * that is not Command, which the menu and server.ts own), "pan" with dx, dy (arrows with nothing selected),
 * "grid" (Cmd+' pixel grid), "rulers" (Shift+R), "layoutGuides" (Control+G, Shift+G).
 */
export function navKey(e, o = {}) {
  const cmd = e.metaKey || e.ctrlKey;
  if (!cmd && !e.altKey && (e.key === "+" || (e.shiftKey && e.code === "Equal"))) return { op: "in" };
  if (!cmd && !e.altKey && e.shiftKey && (e.key === "_" || e.code === "Minus")) return { op: "out" };
  if (cmd && !e.altKey && !e.shiftKey && (e.code === "Quote" || e.key === "'")) return { op: "grid" };
  if (!cmd && !e.altKey && e.shiftKey && e.code === "KeyR") return { op: "rulers" };
  // Layout guides: Control+G and Shift+G.
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyG") return { op: "layoutGuides" };
  if (!cmd && !e.altKey && e.shiftKey && e.code === "KeyG") return { op: "layoutGuides" };
  if (!cmd && !e.altKey && !o.selected && e.key && e.key.startsWith("Arrow")) {
    const s = e.shiftKey ? PAN_STEP_BIG : PAN_STEP;
    const dx = e.key === "ArrowLeft" ? s : e.key === "ArrowRight" ? -s : 0, dy = e.key === "ArrowUp" ? s : e.key === "ArrowDown" ? -s : 0;
    if (dx || dy) return { op: "pan", dx, dy };
  }
  return null;
}

/** View x (or y) of every whole world pixel boundary in [0, size), for the pixel grid; empty below 400%. */
export function gridLines(offset, z, size) {
  if (z < PIXEL_GRID_ZOOM) return [];
  const out = [];
  const first = Math.ceil(-offset / z);
  for (let w = first; ; w++) {
    const v = offset + w * z;
    if (v >= size) break;
    out.push(Math.round(v) + 0.5);
    if (out.length > 4000) break;
  }
  return out;
}

/** The ruler's tick step in world units: 1, 2, 5, 10, 20, 50... the smallest at least `minPx` apart on screen. */
export function rulerStep(z, minPx = 60) {
  for (let m = 1; m < 1e9; m *= 10) for (const k of [1, 2, 5]) if (k * m * z >= minPx) return k * m;
  return 1e9;
}

/** Ticks of a ruler: world values and view positions across [0, size). */
export function rulerTicks(offset, z, size, minPx = 60) {
  const step = rulerStep(z, minPx);
  const out = [];
  for (let w = Math.ceil(-offset / z / step) * step; ; w += step) {
    const v = offset + w * z;
    if (v >= size || out.length > 500) break;
    out.push({ value: Math.round(w * 100) / 100, at: v });
  }
  return { step, ticks: out };
}

/**
 * Where a guide dragged out of a ruler lands: the board under the drop point (topmost first) and the guide's offset
 * from the board's left (axis "x") or top (axis "y"), in whole px when pixel snapping is on. Null off every board.
 */
export function dropGuide(axis, world, boards, snap = true) {
  for (let i = boards.length - 1; i >= 0; i--) {
    const b = boards[i];
    if (world.x < b.x || world.x > b.x + b.w || world.y < b.y || world.y > b.y + b.h) continue;
    const raw = axis === "x" ? world.x - b.x : world.y - b.y;
    return { board: b.id, at: snap ? Math.round(raw) : Math.round(raw * 100) / 100 };
  }
  return null;
}

/** The guide under a view point (within `slop` px), from drawn guides [{board, index, axis, at (view px), from, to}]. */
export function guideAt(guides, px, py, slop = 4) {
  let best = null, bestD = slop + 1;
  for (const g of guides) {
    const along = g.axis === "x" ? py : px;
    if (along < g.from - slop || along > g.to + slop) continue;
    const d = Math.abs((g.axis === "x" ? px : py) - g.at);
    if (d <= slop && d < bestD) { best = g; bestD = d; }
  }
  return best;
}

/** A board's metadata with these guides (every other key kept); null when nothing would be left. */
export function withGuides(metadata, guides) {
  const m = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...metadata } : {};
  if (guides.length) {
    if (typeof m.type !== "string") m.type = "canvas";
    m.canvasGuides = guides.map((g) => ({ axis: g.axis, at: g.at }));
  } else delete m.canvasGuides;
  const keys = Object.keys(m);
  if (!keys.length || (keys.length === 1 && m.type === "canvas")) return null;
  return m;
}
