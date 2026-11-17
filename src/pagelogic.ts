/**
 * Pure helpers of the canvas page script (src/server.ts embeds each function's source, like resolvePages and
 * loadBox), so node tests can run them. Each one is plain JS under its annotations and refers to nothing outside
 * itself.
 */

type Cam = { x: number; y: number; z: number };
type Rect = { x: number; y: number; w: number; h: number };

/** The camera zoomed to `z` about a point of the view (view px, not window px): that point stays put. */
export function zoomAt(cam: Cam, ax: number, ay: number, z: number): Cam {
  return { z, x: ax - (ax - cam.x) * (z / cam.z), y: ay - (ay - cam.y) * (z / cam.z) };
}

/**
 * What a wheel event does to the camera: Cmd+scroll and a pinch (which WebKit sends as Ctrl+wheel)
 * zoom about the pointer; plain scroll pans; Shift+scroll pans sideways (a mouse wheel's vertical turn goes
 * horizontal; a trackpad's own horizontal motion is kept). `cmdHeld`: the Command key is down as far as the page
 * and the shell know, for wheel events whose own flags lost it (scroll utilities re-post events without them).
 */
export function wheelAction(
  e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  cmdHeld = false,
  /** Settings > Canvas > "Scroll to zoom": a plain scroll zooms and Cmd+scroll pans (pinch always zooms). */
  scrollZooms = false,
): { zoom: number } | { dx: number; dy: number } {
  const line = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; // lines and pages in px
  const cmd = e.metaKey || cmdHeld;
  if (e.ctrlKey || (scrollZooms ? !cmd && !e.shiftKey : cmd)) {
    // Line-mode wheels (a mouse) step harder per event than pixel trackpads.
    const k = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01));
    return { zoom: Number.isFinite(k) ? k : 1 };
  }
  const dx = e.deltaX * line, dy = e.deltaY * line;
  if (e.shiftKey && dx === 0) return { dx: dy, dy: 0 };
  return { dx, dy };
}

/**
 * The camera that fits a world rect into the free part of the view (inside the shell's islands: rail and panel,
 * inspector, toolbar, zoom pill), padded and centered, zoom at most maxZ. The padding shrinks before the fit
 * would leave the free area, so a narrow window still keeps everything clear of the islands.
 */
export function fitCam(
  r: Rect,
  viewW: number,
  viewH: number,
  insets: { l: number; t: number; r: number; b: number },
  pad = 70,
  maxZ = 4,
): Cam {
  const fw = Math.max(1, viewW - insets.l - insets.r), fh = Math.max(1, viewH - insets.t - insets.b);
  const p = Math.max(0, Math.min(pad, (fw - 1) / 4, (fh - 1) / 4));
  const w = Math.max(r.w, 1e-6), h = Math.max(r.h, 1e-6);
  const z = Math.min(maxZ, Math.max(0.02, Math.min((fw - p * 2) / w, (fh - p * 2) / h)));
  return { z, x: insets.l + (fw - r.w * z) / 2 - r.x * z, y: insets.t + (fh - r.h * z) / 2 - r.y * z };
}

/**
 * Which page shows, and which page the viewer still waits for. `list`: the page ids the document has now; `active`:
 * the page shown; `want`: a page this viewer wants back (the remembered one, or one that went missing from the list
 * for a moment, e.g. while another process rewrites the sidecar). A page missing from the list never replaces the
 * wanted one: the first page stands in until it returns.
 */
export function pickPage(list: string[], active: string | null, want: string | null): { page: string; want: string | null } {
  if (want && want !== active && list.includes(want)) return { page: want, want: null };
  if (active && list.includes(active)) return { page: active, want: want === active ? null : want };
  return { page: list[0], want: want || active || null };
}

/** Bounded backoff for a retry after a transient failure: 1 s, 2 s, 4 s ... at most 30 s. */
export function retryDelay(n: number): number {
  return Math.min(30000, 1000 * Math.pow(2, Math.max(0, n - 1)));
}

/**
 * Board title collisions in one pass: `cands` in priority order, each {x, y, w, g} (screen px; g the clearance it
 * needs), all `h` tall. Returns which to keep: a title is kept unless it comes within its clearance of one kept
 * before it. Kept titles go into screen-space buckets, so each one only meets its neighbours (linear, not
 * quadratic, in the number of titles).
 */
export function keepLabels(cands: { x: number; y: number; w: number; g: number }[], h: number, cell = 256): boolean[] {
  const grid = new Map<string, { x: number; y: number; w: number }[]>();
  const out: boolean[] = [];
  for (const r of cands) {
    const g = r.g;
    const x0 = Math.floor((r.x - g) / cell), x1 = Math.floor((r.x + r.w + g) / cell);
    const y0 = Math.floor((r.y - g) / cell), y1 = Math.floor((r.y + h + g) / cell);
    let ok = true;
    for (let cx = x0; ok && cx <= x1; cx++) {
      for (let cy = y0; ok && cy <= y1; cy++) {
        for (const k of grid.get(cx + ":" + cy) || []) {
          if (r.x < k.x + k.w + g && k.x < r.x + r.w + g && r.y < k.y + h + g && k.y < r.y + h + g) { ok = false; break; }
        }
      }
    }
    out.push(ok);
    if (!ok) continue;
    const k = { x: r.x, y: r.y, w: r.w };
    for (let cx = Math.floor(r.x / cell); cx <= Math.floor((r.x + r.w) / cell); cx++) {
      for (let cy = Math.floor(r.y / cell); cy <= Math.floor((r.y + h) / cell); cy++) {
        const key = cx + ":" + cy;
        let b = grid.get(key);
        if (!b) grid.set(key, (b = []));
        b.push(k);
      }
    }
  }
  return out;
}

/** The smallest rect around every rect given (nulls skipped), or null. */
export function unionRect(rs: (Rect | null | undefined)[]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) {
    if (!r) continue;
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A node's properties with edits on top that the server does not have yet (undo/redo drawn ahead, a resize, a
 * nudge): what the inspector shows now instead of the stale file. `edits`: [{props, remove}] oldest first.
 */
export function overlayNode(node: Record<string, unknown>, edits: { props?: Record<string, unknown>; remove?: string[] }[]): Record<string, unknown> {
  const out: Record<string, unknown> = Object.assign({}, node);
  for (const e of edits) {
    for (const k of e.remove || []) delete out[k];
    for (const [k, v] of Object.entries(e.props || {})) out[k] = v;
  }
  return out;
}
