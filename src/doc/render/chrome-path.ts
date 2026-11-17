// Finds a Chromium-family browser for the headless renderer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Playwright's and Puppeteer's downloaded browsers, newest build first. Sessions without an installed Chrome often have one of these. */
function downloadedChromes(): string[] {
  const home = os.homedir();
  const out: string[] = [];
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, "Library", "Caches", "ms-playwright"), path.join(home, ".cache", "ms-playwright"), path.join(home, ".cache", "puppeteer")];
  for (const cache of caches) {
    if (!cache) continue;
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(cache);
    } catch {
      continue;
    }
    const build = (d: string) => Number(d.match(/(\d+)$/)?.[1] ?? 0);
    // A full Chromium before the headless shell: both draw the same, the full one also has every font fallback.
    const rank = (d: string) => (d.startsWith("chromium_headless_shell") || d.startsWith("chrome-headless-shell") ? 1 : d.startsWith("chromium") || d.startsWith("chrome") ? 0 : 2);
    for (const d of dirs.filter((x) => rank(x) < 2).sort((a, b) => rank(a) - rank(b) || build(b) - build(a))) {
      const dir = path.join(cache, d);
      const found: string[] = [];
      const look = (p: string, depth: number) => {
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(p, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const f = path.join(p, e.name);
          if (e.isDirectory() && e.name.endsWith(".app")) {
            const bin = path.join(f, "Contents", "MacOS", e.name.slice(0, -4));
            if (fs.existsSync(bin)) found.push(bin);
          } else if (e.isDirectory() && depth > 0) look(f, depth - 1);
          else if (e.isFile() && /^(chrome|chromium|chrome-headless-shell|headless_shell)$/.test(e.name)) found.push(f);
        }
      };
      look(dir, 3);
      out.push(...found);
    }
  }
  return out;
}

/** Any Chromium-family browser: an override, an installed Chrome, one a test tool downloaded, then an everyday browser. */
export function chromeCandidates(): string[] {
  const appDirs = ["/Applications", path.join(os.homedir(), "Applications")];
  const app = (names: string[]) => appDirs.flatMap((d) => names.map((a) => path.join(d, `${a}.app`, "Contents", "MacOS", a)));
  return [
    process.env.CANVAS_CHROME,
    ...app(["Google Chrome", "Chromium", "Google Chrome Canary", "Google Chrome for Testing", "Microsoft Edge", "Brave Browser", "Vivaldi"]),
    ...downloadedChromes(),
    // Everyday browsers last: a headless copy of the one someone is browsing in is the least quiet choice.
    ...app(["Arc", "Dia"]),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((c): c is string => !!c);
}

export function chromePath(): string {
  for (const c of chromeCandidates()) if (fs.existsSync(c)) return c;
  throw new Error("Canvas needs a Chromium-family browser to draw (Chrome, Chromium, Edge, Brave, Dia, or Playwright's download). Install one or set CANVAS_CHROME.");
}
