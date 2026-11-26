import { compileMotion, poseAffine } from "./motion-logic.js";

export const MAX_SPRITES = 256;
const kids = n => n.children ?? [];
const parts = a => [].concat(a || []);
const right = r => r.x + r.w, bottom = r => r.y + r.h;
const points = r => [[r.x, r.y], [right(r), r.y], [r.x, bottom(r)], [right(r), bottom(r)]];
const positive = r => r && r.w > 0 && r.h > 0;
const contains = (a, b) => b.x >= a.x && b.y >= a.y && right(b) <= right(a) && bottom(b) <= bottom(a);
function union(a, b) {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(bottom(a), bottom(b)) - y };
}
function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(right(a), right(b)) - x), h: Math.max(0, Math.min(bottom(a), bottom(b)) - y) };
}

function dependent(n) {
  return n.mask || (n.blendMode && n.blendMode !== "normal")
    || parts(n.effect).some(e => e?.type === "background_blur" && e.enabled !== false)
    || [n.fill, n.stroke].some(p => parts(p).some(f => f?.enabled !== false && (f?.type === "shader" || (f?.blendMode && f.blendMode !== "normal"))))
    || n.type === "browser" || n.type === "script";
}

function insideRounded(bounds, clip, radius) {
  const caps = parts(radius);
  if (!caps.some(r => r > 0)) return true;
  if (!contains(clip, bounds)) return false;
  const [tl, tr, br, bl] = Array.from({ length: 4 }, (_, i) => Math.max(0, caps[i] ?? caps[0]));
  const ratio = Math.min(1, clip.w / (tl + tr), clip.w / (bl + br), clip.h / (tl + bl), clip.h / (tr + br));
  const corners = [[tl, clip.x, clip.y, 1, 1], [tr, right(clip), clip.y, -1, 1],
    [br, right(clip), bottom(clip), -1, -1], [bl, clip.x, bottom(clip), 1, -1]];
  return points(bounds).every(([x, y]) => corners.every(([radius, cx, cy, sx, sy]) => {
    const r = radius * ratio;
    const dx = Math.max(0, r - (x - cx) * sx), dy = Math.max(0, r - (y - cy) * sy);
    return dx * dx + dy * dy <= r * r;
  }));
}

// Sample each track independently. Combining the ranges also covers tracks with different delays or periods.
export function motionEnvelope(compiled, pivot, ink) {
  const ranges = {}, low = {}, high = {};
  for (const { prop, from, to, rest, ease } of compiled.tracks) {
    if (prop === "opacity") continue;
    let lo = Math.min(from, to, rest), hi = Math.max(from, to, rest);
    for (let i = 1; i < 64; i++) {
      const t = ease(i / 64);
      for (const [a, b] of [[from, to], [rest, to]]) {
        const n = a + (b - a) * t;
        lo = Math.min(lo, n); hi = Math.max(hi, n);
      }
    }
    ranges[prop] = [lo, hi]; low[prop] = lo; high[prop] = hi;
  }
  const tx = low.translateX ?? 0, ty = low.translateY ?? 0;
  const dx = (high.translateX ?? 0) - tx, dy = (high.translateY ?? 0) - ty;
  const scales = ["scale", "scaleX", "scaleY"].filter(k => ranges[k]);
  if (!ranges.rotate && !scales.length) return { x: ink.x + tx, y: ink.y + ty, w: ink.w + dx, h: ink.h + dy };
  let bounds;
  const add = p => {
    const [a, b, c, d, e, f] = poseAffine(p, pivot, compiled.origins);
    const xy = points(ink).map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
    const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    bounds = union(bounds, { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
  };
  const angles = ranges.rotate ?? [0, 0];
  const steps = Math.min(72, Math.ceil((angles[1] - angles[0]) / 5));
  for (let mask = 0; mask < 2 ** scales.length; mask++) {
    const p = Object.fromEntries(scales.map((k, i) => [k, ranges[k][(mask >> i) & 1]]));
    for (let n = 0; n <= steps; n++) add({ ...p, rotate: angles[0] + Math.min(360, angles[1] - angles[0]) * n / (steps || 1) });
  }
  return { x: bounds.x + tx, y: bounds.y + ty, w: bounds.w + dx, h: bounds.h + dy };
}

export function planMotion(root, geometry, { scale = 1, budget = Infinity } = {}) {
  const sprites = [], skipped = [];
  const hasMotion = n => parts(n.motion).some(a => a?.on === "boardHover");
  const inTree = n => hasMotion(n) || kids(n).some(inTree);
  if (!inTree(root)) return { sprites, skipped };
  let bytes = 0;
  const boxes = new Map();
  const rect = n => {
    if (!boxes.has(n)) boxes.set(n, geometry(n));
    return boxes.get(n);
  };
  const hasComplexPaint = n => dependent(n) || kids(n).some(hasComplexPaint);
  const walk = (n, ancestors, later, parentMask, lifted) => {
    const compiled = hasMotion(n) ? compileMotion(n.motion, n.opacity) : null;
    let promoted = null;
    if (compiled?.tracks.length) {
      const { box, ink, placement = box } = rect(n) ?? {};
      let reason = null, clip = null;
      const scaled = r => Math.ceil(r * scale) + 8;
      const size = positive(ink ?? box) ? scaled((ink ?? box).w) * scaled((ink ?? box).h) * 4 : 0;
      if (!positive(box) || !positive(placement)) reason = "no layout box";
      else if (sprites.length >= MAX_SPRITES || bytes + size > budget) reason = "sprite budget";
      else if (parentMask || hasComplexPaint(n) || ancestors.some(dependent)) reason = "depends on surrounding paint";
      else if (ancestors.some(a => a.rotation || a.flipX || a.flipY || (a.opacity ?? 1) !== 1
        || parts(a.effect).some(e => e?.type === "blur" || e?.type === "layer_blur"))) reason = "ancestor transform, opacity or blur";
      else if (lifted?.animateOpacity) reason = "ancestor animates opacity as a group";
      else if (lifted && ancestors.slice(lifted.depth).some(a => a.clip)) reason = "clip inside an animated subtree";
      else {
        const paint = positive(ink) ? ink : box;
        const envelope = motionEnvelope(compiled, box, paint);
        if (lifted && !contains(lifted.ink, envelope)) reason = "extends past animated ancestor paint";
        else if (![envelope.x, envelope.y, envelope.w, envelope.h].every(Number.isFinite)) reason = "motion bounds exceed the renderer range";
        else if (later.some(sibling => {
          const r = rect(sibling)?.ink;
          return positive(r) && positive(intersect(r, envelope));
        })) reason = "overlaps later paint";
        else for (const a of ancestors) {
          if (!a.clip) continue;
          const r = rect(a)?.box;
          if (!r || !insideRounded(envelope, r, a.cornerRadius)) { reason = "crosses a rounded clip"; break; }
          clip = clip ? intersect(clip, r) : r;
        }
      }
      if (reason) skipped.push({ id: n.id, reason });
      else {
        promoted = {
          node: n, compiled, pivot: box, placement, clip, ink: positive(ink) ? ink : box,
          animateOpacity: compiled.tracks.some(t => t.prop === "opacity"), parent: lifted, depth: ancestors.length,
        };
        sprites.push(promoted);
        bytes += size;
      }
    }
    const children = n.canvasLayout?.stacking === "first" ? kids(n).slice().reverse() : kids(n);
    let masked = parentMask;
    children.forEach((k, i) => {
      walk(k, [...ancestors, n], [...children.slice(i + 1), ...later], masked, lifted || promoted);
      masked ||= !!k.mask;
    });
  };
  walk(root, [], [], false, null);
  return { sprites, skipped };
}

export function hideMotionRoots(n, ids) {
  if (ids.has(n.id)) return { ...n, opacity: 0 };
  return n.children?.length ? { ...n, children: n.children.map(k => hideMotionRoots(k, ids)) } : n;
}
