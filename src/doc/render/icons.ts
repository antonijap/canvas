// Icon artwork for `icon` nodes. Lucide and Feather ship with this server; other libraries come from Iconify's public API.

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

const LOCAL: Record<string, string> = { lucide: "lucide", feather: "feather" };
const REMOTE: Record<string, (n: string) => string> = {
  phosphor: (n) => `ph/${n}`,
  "Material Symbols Outlined": (n) => `material-symbols/${n.replaceAll("_", "-")}-outline`,
  "Material Symbols Rounded": (n) => `material-symbols/${n.replaceAll("_", "-")}-rounded`,
  "Material Symbols Sharp": (n) => `material-symbols/${n.replaceAll("_", "-")}-sharp`,
};

export type IconArt = { kind: "svg"; body: string; size: number } | { kind: "url"; url: string } | null;

export function iconArt(library: string, name: string): IconArt {
  const pkg = LOCAL[library];
  if (pkg) {
    const set = load(pkg);
    const key = set.aliases?.[name]?.parent ?? name;
    const icon = set.icons[key];
    return icon ? { kind: "svg", body: icon.body, size: set.width ?? 24 } : null;
  }
  const remote = REMOTE[library];
  return remote ? { kind: "url", url: `https://api.iconify.design/${remote(name)}.svg` } : null;
}
