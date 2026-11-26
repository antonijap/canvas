import { compileMotion, motionPose, motionProps, motionTrackKeys } from "./motion-logic.js";

export const axisInset = 24;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const keyValue = (prop, v) => prop === "opacity" ? clamp(v, 0, 1) : v;
const rowId = (layer, animation, prop) => JSON.stringify([layer, animation, prop]);
const endValues = new Map([["translateX", 8], ["translateY", 8], ["scale", 1.05], ["rotate", 5], ["opacity", 0.5]]);
export const timelineProperties = [...endValues.keys()];

const hoverAnimation = motion => motion.find(a => a?.on === "boardHover" && Array.isArray(a.tracks) && a.tracks.length < 8);

export function availableTimelineProperties(motion) {
  if (motion.length >= 4 && !hoverAnimation(motion)) return [];
  const used = new Set(motion.filter(a => a?.on === "boardHover").flatMap(a => (a.tracks ?? []).map(t => t.prop)));
  return timelineProperties.filter(prop => !used.has(prop));
}

export function addTimelineProperty(layer, prop, id) {
  if (!availableTimelineProperties(layer.motion).includes(prop)) return null;
  const from = keyValue(prop, motionTrackKeys({ prop }, layer.opacity)[0].v);
  const track = { prop, keys: [{ t: 0, v: from }, { t: 300, v: endValues.get(prop) }] };
  const hover = hoverAnimation(layer.motion);
  const animation = hover ? { ...hover, tracks: [...hover.tracks, track] } : { id, on: "boardHover", leave: "reverse", tracks: [track] };
  const motion = hover ? layer.motion.map(a => a === hover ? animation : a) : [...layer.motion, animation];
  return { motion, rowId: rowId(layer.id, animation.id, prop) };
}

function compileTrack(track, opacity) {
  return compileMotion([{ on: "boardHover", tracks: [track] }], opacity);
}

export function timelineLayers(root, selected) {
  const layers = [];
  let emptyLayer;
  function collect(node) {
    const rows = [];
    const motion = Array.isArray(node.motion) ? node.motion : [];
    for (const animation of motion) for (const track of Array.isArray(animation?.tracks) ? animation.tracks : []) {
      if (!motionProps.includes(track?.prop)) continue;
      const compiled = compileTrack(track, node.opacity);
      if (!compiled.tracks.length) continue;
      const keys = motionTrackKeys(track, node.opacity);
      compiled.tracks[0].cycles = 1;
      rows.push({ id: rowId(node.id, animation.id, track.prop), animation, track, keys, compiled });
    }
    if (rows.length || node.id && node.id === selected) {
      const start = rows.length ? Math.min(...rows.map(row => row.keys[0].t)) : 0;
      const end = Math.max(0, ...rows.map(row => row.keys.at(-1).t));
      const layer = { id: node.id, name: node.name || node.type || node.id, opacity: node.opacity, motion, rows, start, end };
      for (const row of rows) row.layer = layer;
      if (rows.length) layers.push(layer);
      else emptyLayer = layer;
    }
    for (const child of node.children ?? []) collect(child);
  }
  if (root) collect(root);
  if (emptyLayer) layers.push(emptyLayer);
  return layers;
}

export function trackValue(compiled, time) {
  const prop = compiled.tracks[0]?.prop;
  return motionPose(compiled, time).values[prop];
}

export function editTrack(track, before, keys) {
  if (Array.isArray(track.keys) || keys.length > 2) {
    const { from, to, duration, delay, ease, ...other } = track;
    return { ...other, keys };
  }
  const next = { ...track };
  if (keys[0].v !== before[0].v) next.from = keys[0].v;
  if (keys[1].v !== before[1].v) next.to = keys[1].v;
  if (keys[0].t !== before[0].t) next.delay = keys[0].t;
  if (keys[1].t - keys[0].t !== before[1].t - before[0].t) next.duration = keys[1].t - keys[0].t;
  if (keys[1].ease !== before[1].ease) {
    next.ease = keys[1].ease;
    // The legacy default is derived from the easing. Keep the visible end key in place.
    if (track.duration === undefined) next.duration = keys[1].t - keys[0].t;
  }
  return Object.keys(next).every(k => next[k] === track[k]) ? track : next;
}

export function moveKeys(keys, indices, time, { legacy = false, snap = false } = {}) {
  const first = indices[0], last = indices.at(-1), start = keys[first].t, end = keys[last].t;
  let min = -start, max = (legacy ? 70000 : 60000) - end;
  if (legacy) {
    const duration = keys[1].t - keys[0].t;
    if (first === 0) max = Math.min(max, 10000 - start);
    if (first === last) {
      if (first === 0) {
        min = Math.max(min, duration - 60000);
        max = Math.min(max, duration);
      } else {
        min = Math.max(min, -duration);
        max = Math.min(max, 60000 - duration);
      }
    }
  } else {
    if (first > 0) {
      const gap = start - keys[first - 1].t;
      min = Math.min(1, gap / 2) - gap;
    }
    if (last < keys.length - 1) {
      const gap = keys[last + 1].t - end;
      max = gap - Math.min(1, gap / 2);
    }
  }
  if (snap) {
    const firstTick = Math.ceil((start + min) / 10) * 10, lastTick = Math.floor((start + max) / 10) * 10;
    time = firstTick <= lastTick ? clamp(Math.round(time / 10) * 10, firstTick, lastTick) : start;
  }
  const delta = clamp(time - start, min, max);
  return delta ? keys.map((key, i) => indices.includes(i) ? { ...key, t: key.t + delta } : key) : keys;
}

export function addKey(track, keys, time, opacity) {
  if (!Number.isFinite(time) || time < 0 || time > 60000 || keys.length >= 16 || keys.at(-1).t > 60000 ||
      keys.some((key, i) => key.t === time || (i && key.t === keys[i - 1].t))) return keys;
  const compiled = compileTrack(track, opacity);
  const ease = keys.find(key => key.t > time)?.ease;
  const v = keyValue(track.prop, trackValue(compiled, time));
  return [...keys, { t: time, v, ...(ease !== undefined && { ease }) }].sort((a, b) => a.t - b.t);
}

export function removeKey(keys, index) {
  if (keys.length <= 2 || index < 0 || index >= keys.length) return keys;
  return keys.filter((_, i) => i !== index);
}

export function rulerStep(scale) {
  const goal = 90 / scale, unit = 10 ** Math.floor(Math.log10(goal));
  return unit * ([1, 2, 5, 10].find(n => n * unit >= goal) ?? 10);
}

export function zoomAtTime({ scale, scroll, offset, factor }) {
  const next = clamp(scale * factor, 0.025, 24);
  const time = (scroll + offset - axisInset) / scale;
  return { scale: next, scroll: Math.max(0, time * next + axisInset - offset) };
}
