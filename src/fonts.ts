// Fonts installed on this Mac. The app's shell answers this directly; with no app we read it from
// NSFontManager (via osascript), cached, never blocking the event loop.

import { execFile } from "node:child_process";
import { fontDirStamp } from "./keyed.ts";
import type { FontUse } from "./summary.ts";

let cache: { stamp: string; expires: number; families: Promise<Set<string>> } | undefined;
const TTL_MS = 10 * 60_000;

const JXA = "ObjC.import('AppKit'); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))";

function run(cmd: string, args: string[], timeout: number, maxBuffer: number): Promise<string | undefined> {
  return new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer }, (err, out) => resolve(err ? undefined : out)));
}

/** NSFontManager through osascript answers in a fraction of a second (the same list the app's shell gives); system_profiler is the slow fallback. */
export function systemFonts(): Promise<Set<string>> {
  const stamp = fontDirStamp();
  if (cache?.stamp === stamp && Date.now() < cache.expires) return cache.families;
  const entry = { stamp, expires: Infinity, families: readSystemFonts() };
  cache = entry;
  void entry.families.then((families) => {
    entry.expires = families.size ? Date.now() + TTL_MS : 0;
  }, () => { entry.expires = 0; });
  return entry.families;
}

async function readSystemFonts(): Promise<Set<string>> {
  const families = new Set<string>();
  const fast = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", JXA], 10_000, 8 * 1024 * 1024);
  try {
    for (const f of JSON.parse(fast ?? "[]") as string[]) families.add(f);
  } catch {
    // Fall through to the slow path.
  }
  if (!families.size) {
    const out = await run("/usr/sbin/system_profiler", ["SPFontsDataType", "-json"], 20_000, 256 * 1024 * 1024);
    try {
      const j = JSON.parse(out ?? "{}") as { SPFontsDataType?: { typefaces?: { family?: string }[] }[] };
      for (const f of j.SPFontsDataType ?? []) for (const t of f.typefaces ?? []) if (t.family) families.add(t.family);
    } catch {
      // An unreadable answer leaves the set empty; the caller reports an unknown source.
    }
  }
  return families;
}

export type FontStatus = FontUse & { status: "installed" | "embedded" | "web" | "missing" };

/** installed: on this Mac. embedded: the file ships the font. web: not installed, drawn from Google Fonts. missing: embedded file is gone. */
export function fontStatuses(used: FontUse[], installed: Set<string>): FontStatus[] {
  return used.map((u) => {
    const status = u.source === "embedded" ? (u.embeddedFile?.exists === false ? "missing" : "embedded") : u.source === "system" || installed.has(u.family) ? "installed" : "web";
    return { ...u, status };
  });
}
