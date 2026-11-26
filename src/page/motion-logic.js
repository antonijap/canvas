// Shared by the canvas and headless filmstrips. Times are milliseconds, angles are degrees.
export const motionProps = ["translateX", "translateY", "scale", "scaleX", "scaleY", "rotate", "opacity"];
const beziers = { ease: [0.25, 0.1, 0.25, 1], easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1] };
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const mix = (a, b, t) => a + (b - a) * t;
const finite = (n, fallback) => Number.isFinite(n) ? n : fallback;

export function easeCurve(ease) {
  const points = Array.isArray(ease) ? ease : Object.hasOwn(beziers, ease) ? beziers[ease] : null;
  if (!points) return x => x;
  const [x1, y1, x2, y2] = points;
  const ax = 1 - 3 * x2 + 3 * x1, bx = 3 * x2 - 6 * x1, cx = 3 * x1;
  const ay = 1 - 3 * y2 + 3 * y1, by = 3 * y2 - 6 * y1, cy = 3 * y1;
  const xAt = t => ((ax * t + bx) * t + cx) * t;
  const yAt = t => ((ay * t + by) * t + cy) * t;
  return x => {
    if (x <= 0 || x >= 1) return clamp(x);
    let t = x;
    for (let i = 0; i < 5; i++) {
      const error = xAt(t) - x;
      if (Math.abs(error) < 1e-8) return yAt(t);
      const slope = (3 * ax * t + 2 * bx) * t + cx;
      if (slope < 1e-7) break;
      t -= error / slope;
      if (t <= 0 || t >= 1) break;
    }
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      t = (lo + hi) / 2;
      if (xAt(t) < x) lo = t;
      else hi = t;
    }
    return yAt(t);
  };
}

export function springCurve(spring) {
  const { stiffness, damping, mass, response, dampingFraction, duration, bounce } = spring;
  const omega = duration !== undefined ? 2 * Math.PI : response !== undefined ? 2 * Math.PI / response : Math.sqrt(stiffness) / Math.sqrt(mass);
  const ratio = duration !== undefined ? (bounce >= 0 ? 1 - bounce : 1 / Math.max(0.001, 1 + bounce))
    : response !== undefined ? dampingFraction : damping / (2 * mass * omega);
  if (!(omega > 0) || !Number.isFinite(omega) || !Number.isFinite(ratio) || ratio < 0) {
    return { duration: duration ?? 300, sample: t => clamp(t / (duration ?? 300)) };
  }
  const decay = omega * ratio;
  let displacement, envelope;
  if (ratio < 1 - 1e-6) {
    const wd = omega * Math.sqrt(1 - ratio * ratio);
    const k = decay / wd;
    displacement = t => Math.exp(-decay * t) * (Math.cos(wd * t) + k * Math.sin(wd * t));
    envelope = t => Math.exp(-decay * t) * Math.hypot(1, k);
  } else if (ratio > 1 + 1e-6) {
    const root = Math.sqrt(ratio * ratio - 1);
    const slow = -omega / (ratio + root), fast = -omega * (ratio + root);
    const a = fast / (fast - slow), b = 1 - a;
    displacement = t => a * Math.exp(slow * t) + b * Math.exp(fast * t);
    envelope = displacement;
  } else {
    displacement = t => (1 + omega * t) * Math.exp(-omega * t);
    envelope = displacement;
  }
  let lo = 0, hi = 10;
  for (let i = 0; i < 36; i++) {
    const mid = (lo + hi) / 2;
    if (envelope(mid) < 0.001) hi = mid;
    else lo = mid;
  }
  const ms = duration ?? hi * 1000;
  return { duration: ms, sample: t => t >= ms ? 1 : 1 - displacement(duration === undefined ? t / 1000 : t / ms * hi) };
}

const springEase = ease => ease?.spring && typeof ease.spring === "object" ? springCurve(ease.spring) : null;
export function segmentEase(ease, curve = springEase(ease)) {
  return curve ? p => curve.sample(p * curve.duration) : easeCurve(ease);
}

const restValue = (prop, opacity) => prop === "opacity" ? finite(opacity, 1) : prop.startsWith("scale") ? 1 : 0;
const trackDelay = track => clamp(finite(track.delay, 0), 0, 10000);
const trackDuration = (track, spring) => clamp(finite(track.duration, spring?.duration ?? 300), 0, 60000);

export function motionTrackKeys(track, opacity = 1) {
  if (Array.isArray(track.keys)) return track.keys;
  const rest = restValue(track.prop, opacity), delay = trackDelay(track);
  return [{ t: delay, v: finite(track.from, rest) }, {
    t: delay + trackDuration(track, springEase(track.ease)), v: finite(track.to, rest), ease: track.ease,
  }];
}

function compileKeys(keys) {
  if (!Array.isArray(keys) || keys.length < 2 || keys.length > 16 ||
      keys.some((k, i) => !Number.isFinite(k?.t) || !Number.isFinite(k?.v) || k.t < 0 || k.t > 60000 || (i && k.t <= keys[i - 1].t))) return null;
  const delay = keys[0].t, duration = keys.at(-1).t - delay;
  const segments = keys.slice(1).map((key, i) => ({
    from: keys[i].v, to: key.v, start: (keys[i].t - delay) / duration,
    end: (key.t - delay) / duration, ease: segmentEase(key.ease),
  }));
  return { delay, duration, segments };
}

function sampleKeys(segments, q) {
  const segment = segments.find(s => q <= s.end) ?? segments.at(-1);
  return mix(segment.from, segment.to, segment.ease(clamp((q - segment.start) / (segment.end - segment.start))));
}

export function compileMotion(animations, opacity = 1) {
  // Later declarations of the same property win. Each animation can set its own pivot.
  const tracks = new Map();
  const origins = {};
  for (const animation of Array.isArray(animations) ? animations.slice(0, 4) : []) {
    if (animation?.on !== "boardHover" || !Array.isArray(animation.tracks)) continue;
    for (const track of animation.tracks.slice(0, 8)) {
      if (!motionProps.includes(track?.prop) || (track.to !== undefined && !Number.isFinite(track.to))) continue;
      const { prop, ease } = track;
      const keyed = compileKeys(track.keys);
      if (track.keys !== undefined && !keyed) continue;
      const rest = restValue(prop, opacity), spring = springEase(ease);
      tracks.set(prop, {
        prop, rest, from: keyed ? track.keys[0].v : finite(track.from, rest), to: keyed ? track.keys.at(-1).v : finite(track.to, rest),
        duration: keyed?.duration ?? trackDuration(track, spring), delay: keyed?.delay ?? trackDelay(track),
        ease: segmentEase(ease, spring), ...(keyed && { segments: keyed.segments }),
        cycles: track.repeat === "infinite" ? Infinity : 1 + Math.max(0, finite(track.repeat, 0)),
        alternate: track.alternate === true, leave: animation.leave ?? "reverse",
      });
      if (prop !== "opacity" && prop !== "translateX" && prop !== "translateY") {
        origins[prop] = Array.isArray(animation.origin) && animation.origin.length === 2 ? animation.origin : [0.5, 0.5];
      }
    }
  }
  return { tracks: [...tracks.values()], origins };
}

export function hasHoverMotion(node) {
  return (Array.isArray(node?.motion) && compileMotion(node.motion, node.opacity).tracks.length > 0)
    || (Array.isArray(node?.children) && node.children.some(hasHoverMotion));
}

export function motionPose(motion, elapsed, { leave, enter, end } = {}) {
  const values = {}, progress = {};
  let done = true, held = false;
  for (const track of motion.tracks) {
    const { prop, rest, from, to, duration, delay, cycles, ease, alternate, segments } = track;
    if (end) {
      values[prop] = to;
      progress[prop] = 1;
    } else if (leave) {
      const start = leave.values[prop] ?? rest;
      const displayedProgress = segments ? leave.progress[prop] ?? 0 : leave.progress[prop] || 1;
      const time = segments
        ? (displayedProgress || start !== rest ? Math.max(1, duration * (displayedProgress || segments[0].end)) : 0)
        : (start === rest ? 0 : Math.max(1, duration * displayedProgress));
      const p = time > 0 ? clamp(elapsed / time) : 1;
      const q = displayedProgress * (1 - p);
      if (track.leave === "hold") {
        values[prop] = start;
        held ||= start !== rest;
      } else if (track.leave === "reset") values[prop] = rest;
      else {
        if (segments && p < 1) {
          const correction = start - sampleKeys(segments, displayedProgress);
          const restOffset = (rest - from) * (1 - clamp(q / segments[0].end));
          values[prop] = sampleKeys(segments, q) + correction * (1 - p) + restOffset * p;
        } else values[prop] = segments ? rest : mix(rest, start, ease(1 - p));
        done &&= p === 1 || (!segments && start === rest);
      }
      progress[prop] = segments ? q : 1 - p;
    } else {
      const time = elapsed - (enter ? 0 : delay);
      const full = time >= 0 && (duration === 0 || time >= cycles * duration);
      const cycle = full ? (Number.isFinite(cycles) ? cycles - 1 : 0) : time > 0 ? Math.floor(time / duration) : 0;
      const p = full ? 1 : time > 0 ? time / duration - cycle : 0;
      const q = alternate && cycle % 2 === 1 ? 1 - p : p;
      const start = cycle === 0 ? (enter?.values[prop] ?? from) : from;
      values[prop] = segments
        ? sampleKeys(segments, q) + (start - from) * (1 - clamp(q / segments[0].end))
        : mix(start, to, ease(q));
      progress[prop] = q;
      done &&= full;
    }
  }
  return { values, progress, done, held };
}

export function poseAffine(values, rect, origins = [0.5, 0.5]) {
  const { translateX = 0, translateY = 0, rotate = 0, scale = 1, scaleX = 1, scaleY = 1, opacity = 1 } = values;
  const { x, y, w, h } = rect;
  const origin = prop => Array.isArray(origins) ? origins : origins[prop] ?? [0.5, 0.5];
  const rot = origin("rotate"), all = origin("scale"), hor = origin("scaleX"), vert = origin("scaleY");
  const rx = x + w * rot[0], ry = y + h * rot[1];
  const ex = (x + w * all[0]) * (1 - scale) + scale * (x + w * hor[0]) * (1 - scaleX);
  const ey = (y + h * all[1]) * (1 - scale) + scale * (y + h * vert[1]) * (1 - scaleY);
  const angle = (rotate % 360) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const sx = scale * scaleX, sy = scale * scaleY;
  const a = c * sx, b = s * sx, cc = -s * sy, d = c * sy;
  return [a, b, cc, d, (1 - c) * rx + s * ry + c * ex - s * ey + translateX, (1 - c) * ry - s * rx + s * ex + c * ey + translateY, clamp(opacity)];
}


export function composeAffine(parent, child) {
  const [a, b, c, d, e, f, alpha] = parent, [g, h, i, j, k, l, opacity] = child;
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f, alpha * opacity];
}
