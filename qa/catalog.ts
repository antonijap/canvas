// The feature catalog (qa/features.yaml): load, expand $sets, validate, and check scenario `covers` against it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./yaml.ts";

export const CATALOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "features.yaml");
export const DRIVERS = ["page", "native", "mcp"] as const;

export type Feature = { id: string; name: string; area: string; driven: string[]; cases: string[] };
export type Catalog = { dimensions: Record<string, string[]>; features: Feature[]; byId: Map<string, Feature>; dimensionOf: (c: string) => string };

const strs = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${what}: want a list of strings`);
  return v as string[];
};

export function parseCatalog(src: string): Catalog {
  const y = parseYaml(src) as any;
  if (!y || typeof y !== "object" || Array.isArray(y)) throw new Error("catalog: want a map at the top");
  const dimensions: Record<string, string[]> = {};
  const dimOf = new Map<string, string>();
  for (const [d, vs] of Object.entries(y.dimensions ?? {})) {
    dimensions[d] = strs(vs, `dimension ${d}`);
    for (const v of dimensions[d]) {
      if (dimOf.has(v)) throw new Error(`case ${v} is in two dimensions (${dimOf.get(v)}, ${d})`);
      dimOf.set(v, d);
    }
  }
  const sets: Record<string, string[]> = {};
  for (const [s, vs] of Object.entries(y.sets ?? {})) sets[s] = strs(vs, `set ${s}`);
  const features: Feature[] = [];
  const byId = new Map<string, Feature>();
  const errs: string[] = [];
  for (const f of (y.features ?? []) as any[]) {
    const id = String(f?.id ?? "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { errs.push(`feature id "${id}" must be lowercase words joined by -`); continue; }
    if (byId.has(id)) { errs.push(`duplicate feature ${id}`); continue; }
    for (const k of ["name", "area"]) if (typeof f[k] !== "string" || !f[k]) errs.push(`${id}: ${k} is required`);
    const driven = strs(f.driven, `${id} driven`);
    for (const d of driven) if (!(DRIVERS as readonly string[]).includes(d)) errs.push(`${id}: driven "${d}" is not one of ${DRIVERS.join(", ")}`);
    const cases: string[] = [];
    for (const c of strs(f.cases, `${id} cases`)) {
      if (c.startsWith("$")) {
        const s = sets[c.slice(1)];
        if (!s) { errs.push(`${id}: no set ${c}`); continue; }
        cases.push(...s);
      } else cases.push(c);
    }
    if (!cases.length) errs.push(`${id}: no cases`);
    const dup = cases.filter((c, i) => cases.indexOf(c) !== i);
    if (dup.length) errs.push(`${id}: case listed twice: ${[...new Set(dup)].join(", ")}`);
    for (const c of cases) if (!/^[a-z0-9_][a-z0-9_-]*$/.test(c)) errs.push(`${id}: bad case name "${c}"`);
    const feat: Feature = { id, name: f.name, area: f.area, driven, cases };
    features.push(feat);
    byId.set(id, feat);
  }
  if (errs.length) throw new Error(`catalog:\n  ${errs.join("\n  ")}`);
  return { dimensions, features, byId, dimensionOf: (c) => dimOf.get(c) ?? "own" };
}

let cached: Catalog | null = null;
export function loadCatalog(): Catalog {
  return (cached ??= parseCatalog(fs.readFileSync(CATALOG, "utf8")));
}

/** Problems with a scenario's covers list: unknown features or cases, malformed entries. */
export function checkCovers(cat: Catalog, covers: string[]): string[] {
  const errs: string[] = [];
  for (const c of covers) {
    const i = c.indexOf(":");
    if (i < 0) { errs.push(`"${c}" is not feature:case`); continue; }
    const f = cat.byId.get(c.slice(0, i));
    if (!f) { errs.push(`no feature "${c.slice(0, i)}"`); continue; }
    if (!f.cases.includes(c.slice(i + 1))) errs.push(`feature ${f.id} has no case "${c.slice(i + 1)}"`);
  }
  return errs;
}
