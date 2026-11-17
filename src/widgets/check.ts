// Small config checks shared by the widget kinds. Each throws a 422 that names the field.

import { WidgetError, type Config } from "./types.ts";

const bad = (field: string, why: string) => new WidgetError(422, "invalid-config", `${field} ${why}`);

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function str(v: unknown, field: string, def: string, max: number): string {
  if (v === undefined || v === null) return def;
  if (typeof v !== "string") throw bad(field, "must be text");
  if (v.length > max) throw bad(field, `must be at most ${max} characters`);
  return v;
}

export function bool(v: unknown, field: string, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") throw bad(field, "must be true or false");
  return v;
}

export function int(v: unknown, field: string, def: number, min: number, max: number): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) throw bad(field, "must be a number");
  if (v < min || v > max) throw bad(field, `must be between ${min} and ${max}`);
  return Math.round(v);
}

export function oneOf<T extends string>(v: unknown, field: string, def: T, allowed: readonly T[]): T {
  if (v === undefined || v === null) return def;
  if (typeof v !== "string" || !allowed.includes(v as T)) throw bad(field, `must be one of ${allowed.join(", ")}`);
  return v as T;
}

/** Config keys this kind does not know: kept, so a newer file round-trips through an older server. */
export function extras(c: Config, known: readonly string[]): Config {
  const out: Config = {};
  for (const k of Object.keys(c).sort()) if (!known.includes(k)) out[k] = c[k];
  return out;
}

export function obj(v: unknown, field: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw bad(field, "must be an object");
  return v;
}

export { bad };
