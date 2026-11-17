// The widget kinds Canvas knows, and the one place a widget is checked before it is written.

import { note } from "./kinds/note.ts";
import { posthog } from "./kinds/posthog.ts";
import { shader } from "./kinds/shader.ts";
import { todo } from "./kinds/todo.ts";
import { video } from "./kinds/video.ts";
import { welcome } from "./kinds/welcome.ts";
import { isObject } from "./check.ts";
import { WidgetError, type Config, type Widget, type WidgetKind } from "./types.ts";

const kinds = new Map<string, WidgetKind>();
for (const k of [todo, note, posthog, shader, video, welcome]) kinds.set(k.id, k);

export const kindOf = (id: string): WidgetKind | undefined => kinds.get(id);
export const kindList = (): WidgetKind[] => [...kinds.values()];
/** Tests register fake kinds here. */
export function registerKind(k: WidgetKind): void {
  kinds.set(k.id, k);
}
export function unregisterKind(id: string): void {
  kinds.delete(id);
}

export const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const GEOMETRY_MAX = 1e7;

/** Deep merge for PATCH: plain objects merge, arrays and scalars replace, null deletes the key. */
export function mergeConfig(base: Config, patch: Config): Config {
  const out: Config = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (v === null) delete out[k];
    else if (isObject(v) && isObject(out[k])) out[k] = mergeConfig(out[k] as Config, v);
    else out[k] = v;
  }
  return out;
}

function coord(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new WidgetError(422, "invalid-widget", `${field} must be a number between ${min} and ${max}`);
  return v;
}

/** Check a widget about to be stored and return it in canonical shape (known kinds get a normalized config). */
export function validateWidget(w: Widget): Widget {
  if (typeof w.id !== "string" || !ID_RE.test(w.id)) throw new WidgetError(422, "invalid-widget", "id must be 1-40 letters, digits, - or _");
  if (typeof w.kind !== "string" || !w.kind) throw new WidgetError(422, "invalid-widget", "kind is required");
  if (typeof w.name !== "string" || w.name.length > 120) throw new WidgetError(422, "invalid-widget", "name must be text of at most 120 characters");
  if (typeof w.locked !== "boolean") throw new WidgetError(422, "invalid-widget", "locked must be true or false");
  if (!isObject(w.config)) throw new WidgetError(422, "invalid-widget", "config must be an object");
  if (w.page !== undefined && (typeof w.page !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(w.page))) throw new WidgetError(422, "invalid-widget", "page must be a page id (absent = the first page)");
  const k = kinds.get(w.kind);
  return {
    ...w,
    x: coord(w.x, "x", -GEOMETRY_MAX, GEOMETRY_MAX),
    y: coord(w.y, "y", -GEOMETRY_MAX, GEOMETRY_MAX),
    w: coord(w.w, "w", 1, 100_000),
    h: coord(w.h, "h", 1, 100_000),
    config: k ? k.validate(w.config) : w.config,
  };
}
