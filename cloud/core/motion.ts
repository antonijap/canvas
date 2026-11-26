import { motionProps } from "../../src/page/motion-logic.js";

const props = new Set<string>(motionProps);
const trackKeys = new Set(["prop", "from", "to", "duration", "delay", "ease", "repeat", "alternate"]);
const triggers = new Set(["boardHover", "hover", "press", "appear"]);
const eases = new Set(["linear", "ease", "easeIn", "easeOut", "easeInOut"]);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const number = (v: unknown, min = -Infinity, max = Infinity): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

function validEase(v: unknown): boolean {
  if (typeof v === "string") return eases.has(v);
  if (Array.isArray(v)) return v.length === 4 && number(v[0], 0, 1) && number(v[1]) && number(v[2], 0, 1) && number(v[3]);
  if (!object(v) || Object.keys(v).length !== 1 || !object(v.spring)) return false;
  const s = v.spring, n = Object.keys(s).length;
  return (n === 3 && number(s.stiffness, Number.MIN_VALUE) && number(s.damping, 0) && number(s.mass, Number.MIN_VALUE))
    || (n === 2 && number(s.duration, Number.MIN_VALUE, 60000) && number(s.bounce, -1, 1))
    || (n === 2 && number(s.response, Number.MIN_VALUE) && number(s.dampingFraction, 0));
}

export function checkMotion(value: unknown, where: string, errors: string[], warnings?: string[]) {
  if (!Array.isArray(value) || value.length > 4) {
    errors.push(`${where}: motion must contain up to 4 animations`);
    return;
  }
  const ids = new Set<string>();
  for (const [i, a] of value.entries()) {
    const at = `${where}.motion[${i}]`;
    if (!object(a)) { errors.push(`${at}: expected an animation object`); continue; }
    if (typeof a.id !== "string" || !a.id.trim() || a.id.includes("/") || ids.has(a.id)) errors.push(`${at}: id must be unique, non-empty and contain no "/"`);
    else ids.add(a.id);
    if (typeof a.on !== "string" || !a.on.trim()) errors.push(`${at}: on must be a trigger name`);
    else if (!triggers.has(a.on)) warnings?.push(`${at}: unknown trigger "${a.on}", kept as it is`);
    if (a.leave !== undefined && a.leave !== "reverse" && a.leave !== "reset" && a.leave !== "hold") errors.push(`${at}: leave must be reverse, reset or hold`);
    if (a.origin !== undefined && !(Array.isArray(a.origin) && a.origin.length === 2 && a.origin.every(v => number(v, 0, 1)))) errors.push(`${at}: origin must be two fractions from 0 to 1`);
    if (!Array.isArray(a.tracks) || !a.tracks.length || a.tracks.length > 8) { errors.push(`${at}: tracks must contain 1 to 8 tracks`); continue; }
    const used = new Set<string>();
    for (const [j, t] of a.tracks.entries()) {
      const loc = `${at}.tracks[${j}]`;
      if (!object(t)) { errors.push(`${loc}: expected a track object`); continue; }
      if (typeof t.prop !== "string" || !props.has(t.prop) || used.has(t.prop)) errors.push(`${loc}: use each supported prop at most once (${motionProps.join(", ")})`);
      else used.add(t.prop);
      const valueOK = (v: unknown) => t.prop === "opacity" ? number(v, 0, 1) : number(v);
      if ((t.to !== undefined && !valueOK(t.to)) || (t.from !== undefined && !valueOK(t.from))) errors.push(`${loc}: to and from must be finite numbers (opacity 0 to 1)`);
      if (t.duration !== undefined && !number(t.duration, 0, 60000)) errors.push(`${loc}: duration must be 0 to 60000 ms`);
      if (t.delay !== undefined && !number(t.delay, 0, 10000)) errors.push(`${loc}: delay must be 0 to 10000 ms`);
      if (t.repeat !== undefined && t.repeat !== "infinite" && !(Number.isSafeInteger(t.repeat) && number(t.repeat, 0))) errors.push(`${loc}: repeat must be a non-negative integer or "infinite"`);
      if (t.alternate !== undefined && typeof t.alternate !== "boolean") errors.push(`${loc}: alternate must be boolean`);
      if (t.ease !== undefined && !validEase(t.ease)) errors.push(`${loc}: ease must be a named ease, a cubic bezier or a spring`);
      if (warnings) for (const k of Object.keys(t)) if (!trackKeys.has(k)) warnings.push(`${loc}: unknown field "${k}", kept as it is`);
    }
  }
}

export function checkMotionOverrides(descendants: unknown, where: string, errors: string[], warnings?: string[]) {
  if (!object(descendants)) return;
  for (const [id, props] of Object.entries(descendants)) {
    if (object(props) && props.motion !== undefined) checkMotion(props.motion, `${where}.descendants/${id}`, errors, warnings);
  }
}
