// Bundled icon artwork, loaded on first use of each set.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type IconSet = { icons: Record<string, { body: string }>; aliases?: Record<string, { parent: string }>; width?: number; height?: number };
const sets = new Map<string, IconSet>();

function load(pkg: string): IconSet {
  let s = sets.get(pkg);
  if (!s) {
    s = require(`@iconify-json/${pkg}/icons.json`) as IconSet;
    sets.set(pkg, s);
  }
  return s;
}

const libraries = new Map<string, { pkg: string; suffix?: string }>([
  ["lucide", { pkg: "lucide" }],
  ["feather", { pkg: "feather" }],
  ["phosphor", { pkg: "ph" }],
  ["Material Symbols Outlined", { pkg: "material-symbols", suffix: "-outline" }],
  ["Material Symbols Rounded", { pkg: "material-symbols", suffix: "-rounded" }],
  ["Material Symbols Sharp", { pkg: "material-symbols", suffix: "-sharp" }],
]);

export type IconArt = { kind: "svg"; body: string; size: number } | null;

function findIcon(set: IconSet, name: string) {
  const key = set.aliases?.[name]?.parent ?? name;
  return Object.hasOwn(set.icons, key) ? set.icons[key] : undefined;
}

export function iconArt(library: string, name: string): IconArt {
  const lib = libraries.get(library);
  if (!lib) return null;
  const set = load(lib.pkg);
  const base = lib.suffix ? name.replaceAll("_", "-") : name;
  const variant = lib.suffix ? findIcon(set, base + lib.suffix) : undefined;
  const icon = variant ?? findIcon(set, base);
  return icon ? { kind: "svg", body: icon.body, size: set.width ?? 24 } : null;
}
