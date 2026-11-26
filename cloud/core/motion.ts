import { motionProps, withKeyframeFallback, type MotionKey } from "../../src/page/motion-logic.js";
import type { DocNode, Json } from "./schema.ts";

export const UPDATE_MOTION_HOST = "The Cloud host runs an older Canvas and must be updated to save motion.";

const props = new Set<string>(motionProps);
const animationKeys = new Set(["id", "on", "leave", "origin", "tracks"]);
const trackKeys = new Set(["prop", "from", "to", "duration", "delay", "ease", "repeat", "alternate", "keys"]);
const keyFields = new Set(["t", "v", "ease"]);
const triggers = new Set(["boardHover", "hover", "press", "appear"]);
const eases = new Set(["linear", "ease", "easeIn", "easeOut", "easeInOut"]);
const leaves = new Set(["reverse", "reset", "hold"]);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const number = (v: unknown, min = -Infinity, max = Infinity): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const validTrackValue = (prop: unknown, value: unknown) => prop === "opacity" ? number(value, 0, 1) : number(value);

function validEase(v: unknown): boolean {
  if (typeof v === "string") return !!v.trim();
  if (Array.isArray(v)) return v.length === 4 && number(v[0], 0, 1) && number(v[1]) && number(v[2], 0, 1) && number(v[3]);
  if (!object(v) || Object.keys(v).length !== 1 || !object(v.spring)) return false;
  const s = v.spring, n = Object.keys(s).length;
  return (n === 3 && number(s.stiffness, Number.MIN_VALUE) && number(s.damping, 0) && number(s.mass, Number.MIN_VALUE))
    || (n === 2 && number(s.duration, Number.MIN_VALUE, 60000) && number(s.bounce, -1, 1))
    || (n === 2 && number(s.response, Number.MIN_VALUE) && number(s.dampingFraction, 0));
}

function checkEase(ease: unknown, loc: string, errors: string[], warnings?: string[]) {
  if (ease === undefined) return;
  if (!validEase(ease)) errors.push(`${loc}: ease must be a named ease, a cubic bezier or a spring`);
  else if (typeof ease === "string" && !eases.has(ease)) warnings?.push(`${loc}: unknown ease "${ease}", kept as it is`);
}

function checkKeys(keys: unknown, prop: unknown, loc: string, errors: string[], warnings?: string[]): keys is MotionKey[] {
  if (!Array.isArray(keys) || keys.length < 2 || keys.length > 16) {
    errors.push(`${loc}: keys must contain 2 to 16 keyframes`);
    return false;
  }
  const before = errors.length;
  let last = -Infinity;
  for (const [i, key] of keys.entries()) {
    const at = `${loc}.keys[${i}]`;
    if (!object(key)) { errors.push(`${at}: expected a keyframe object`); continue; }
    if (!number(key.t, 0, 60000) || key.t <= last) errors.push(`${at}: t must be 0 to 60000 ms and strictly increasing`);
    else last = key.t;
    if (!validTrackValue(prop, key.v)) errors.push(`${at}: v must be a finite number (opacity 0 to 1)`);
    checkEase(key.ease, at, errors, warnings);
    if (warnings) for (const k of Object.keys(key)) if (!keyFields.has(k)) warnings.push(`${at}: unknown field "${k}", kept as it is`);
  }
  return errors.length === before;
}

function matchingEase(a: unknown = "linear", b: unknown = "linear"): boolean {
  if (!validEase(a)) return false;
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.every((v, i) => v === b[i]);
  if (!object(a) || !object(b) || !object(a.spring) || !object(b.spring)) return false;
  const right = b.spring;
  return Object.keys(a.spring).length === Object.keys(right).length && Object.entries(a.spring).every(([k, v]) => right[k] === v);
}

const hasFallback = (t: Record<string, unknown>) => [t.from, t.to, t.duration, t.delay, t.ease].some(v => v !== undefined);

function matchingFallback(track: Record<string, unknown>, fallback: ReturnType<typeof withKeyframeFallback>) {
  const { from, to, delay, duration, ease } = fallback;
  return track.from === from && track.to === to && track.delay === delay && number(track.duration, Number.MIN_VALUE, 60000) &&
    Math.abs(track.duration - duration) <= Number.EPSILON * (delay + duration) && matchingEase(track.ease, ease);
}

export function normalizeMotionFallbacks(value: Json, repairOnly = false): Json {
  if (!Array.isArray(value)) return value;
  const animations = value.map(a => {
    if (!object(a) || !Array.isArray(a.tracks)) return a;
    const tracks = a.tracks.map(t => {
      if (!object(t) || t.keys === undefined || (repairOnly && !hasFallback(t)) || !checkKeys(t.keys, t.prop, "", [])) return t;
      const fallback = withKeyframeFallback(t, t.keys);
      return matchingFallback(t, fallback) ? t : fallback as Json;
    });
    return tracks.some((track, i) => track !== (a.tracks as Json[])[i]) ? { ...a, tracks } : a;
  });
  return animations.some((animation, i) => animation !== value[i]) ? animations : value;
}

// History can restore motion directly or inside an instance's stored override.
export function repairMotionFallbacks(key: string, value: Json): Json {
  if (key === "motion") return normalizeMotionFallbacks(value, true);
  if (key === "descendants" && object(value)) {
    const entries = Object.entries(value).map(([id, props]) => [id, repairOverrideFallbacks(props)] as const);
    return entries.some(([id, props]) => props !== value[id]) ? Object.fromEntries(entries) : value;
  }
  if (key.startsWith("descendants/")) return repairOverrideFallbacks(value);
  return value;
}

export function repairMotionSubtree(node: DocNode): DocNode {
  return repairOverrideFallbacks(node) as DocNode;
}

function repairOverrideFallbacks(props: Json): Json {
  if (!object(props)) return props;
  const { motion, descendants, children } = props;
  const repaired = motion === undefined ? motion : repairMotionFallbacks("motion", motion);
  const overrides = descendants === undefined ? descendants : repairMotionFallbacks("descendants", descendants);
  const kids = Array.isArray(children) ? children.map(repairOverrideFallbacks) : children;
  const changedKids = Array.isArray(children) && Array.isArray(kids) && kids.some((child, i) => child !== children[i]);
  if (repaired === motion && overrides === descendants && !changedKids) return props;
  return { ...props, ...(repaired !== motion && { motion: repaired }), ...(overrides !== descendants && { descendants: overrides }), ...(changedKids && { children: kids }) };
}

export function checkMotion(value: unknown, where: string, errors: string[], warnings?: string[]) {
  if (!Array.isArray(value) || value.length > 4) {
    errors.push(`${where}: motion must contain up to 4 animations`);
    return;
  }
  const ids = new Set<string>();
  for (const [i, a] of value.entries()) {
    const entry = `${where}.motion[${i}]`;
    if (!object(a)) { errors.push(`${entry}: expected an animation object`); continue; }
    const at = typeof a.id === "string" ? `${entry} (${JSON.stringify(a.id)})` : entry;
    if (typeof a.id !== "string" || !a.id.trim() || a.id.includes("/") || ids.has(a.id)) errors.push(`${at}: id must be unique, non-empty and contain no "/"`);
    else ids.add(a.id);
    if (typeof a.on !== "string" || !a.on.trim()) errors.push(`${at}: on must be a trigger name`);
    else if (!triggers.has(a.on)) warnings?.push(`${at}: unknown trigger "${a.on}", kept as it is`);
    if (a.leave !== undefined) {
      if (typeof a.leave !== "string" || !a.leave.trim()) errors.push(`${at}: leave must be a name`);
      else if (!leaves.has(a.leave)) warnings?.push(`${at}: unknown leave "${a.leave}", kept as it is`);
    }
    if (a.origin !== undefined && !(Array.isArray(a.origin) && a.origin.length === 2 && a.origin.every(v => number(v, 0, 1)))) errors.push(`${at}: origin must be two fractions from 0 to 1`);
    if (warnings) for (const k of Object.keys(a)) if (!animationKeys.has(k)) warnings.push(`${at}: unknown field "${k}", kept as it is`);
    if (!Array.isArray(a.tracks) || !a.tracks.length || a.tracks.length > 8) { errors.push(`${at}: tracks must contain 1 to 8 tracks`); continue; }
    const used = new Set<string>();
    for (const [j, t] of a.tracks.entries()) {
      const loc = `${at}.tracks[${j}]`;
      if (!object(t)) { errors.push(`${loc}: expected a track object`); continue; }
      if (typeof t.prop !== "string" || !t.prop.trim()) errors.push(`${loc}: prop must be a property name`);
      else if (!props.has(t.prop)) warnings?.push(`${loc}: unknown prop "${t.prop}", kept as it is`);
      else if (used.has(t.prop)) errors.push(`${loc}: use each supported prop at most once (${motionProps.join(", ")})`);
      else used.add(t.prop);
      if (t.keys !== undefined) {
        if (checkKeys(t.keys, t.prop, loc, errors, warnings) && hasFallback(t) && !matchingFallback(t, withKeyframeFallback({}, t.keys))) {
          errors.push(`${loc}: from, to, duration, delay and ease must match the keyframe fallback`);
        }
      } else {
        if ((t.to !== undefined && !validTrackValue(t.prop, t.to)) || (t.from !== undefined && !validTrackValue(t.prop, t.from))) errors.push(`${loc}: to and from must be finite numbers (opacity 0 to 1)`);
        if (t.duration !== undefined && !number(t.duration, 0, 60000)) errors.push(`${loc}: duration must be 0 to 60000 ms`);
        if (t.delay !== undefined && !number(t.delay, 0, 10000)) errors.push(`${loc}: delay must be 0 to 10000 ms`);
        checkEase(t.ease, loc, errors, warnings);
      }
      if (t.repeat !== undefined && t.repeat !== "infinite" && !(Number.isSafeInteger(t.repeat) && number(t.repeat, 0))) errors.push(`${loc}: repeat must be a non-negative integer or "infinite"`);
      if (t.alternate !== undefined && typeof t.alternate !== "boolean") errors.push(`${loc}: alternate must be boolean`);
      if (warnings) for (const k of Object.keys(t)) if (!trackKeys.has(k)) warnings.push(`${loc}: unknown field "${k}", kept as it is`);
    }
  }
}

export function checkMotionOverrides(descendants: unknown, where: string, errors: string[], warnings?: string[]) {
  if (!object(descendants)) return;
  for (const [id, props] of Object.entries(descendants)) checkMotionOverride(props, `${where}.descendants/${id}`, errors, warnings);
}

export function checkMotionOverride(props: unknown, where: string, errors: string[], warnings?: string[]) {
  if (!object(props)) return;
  if (props.motion !== undefined) checkMotion(props.motion, where, errors, warnings);
  checkMotionOverrides(props.descendants, where, errors, warnings);
  if (Array.isArray(props.children)) {
    props.children.forEach((child, i) => checkMotionOverride(child, `${where}.children[${i}]`, errors, warnings));
  }
}
