// Board data asked for by content key. A board's key (src/boards.ts) changes whenever anything drawn in it could:
// its own content, the components it uses, the variables, themes and fonts of the document. So the answer to
// "board B at key K" never changes, and the browser may keep it for good: WKWebView's disk cache then serves an
// unchanged board across reloads, tab switches and launches without asking. What else shapes the answer (the
// server's code, the fonts installed on this Mac, whether web fonts are on) goes in `v`, the scene environment.
//
// Never cached as K: a request whose key is not the board's current one (the page is behind; it gets today's data,
// whose own key it compares and loads again), one without a key, one for another environment, and an answer built
// while a web font could not be fetched (it may lack faces that the next try finds).

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IMMUTABLE = "public, max-age=31536000, immutable";

export type KeyedAnswer = {
  /** True when the answer may be kept by the browser as this key. */
  cacheable: boolean;
  /** The request already holds this exact answer (If-None-Match): 304. */
  notModified: boolean;
  headers: Record<string, string>;
};

/**
 * How to answer a keyed request. `asked`: the key and environment the page sent (null when it sent none);
 * `current`: the board's key now (undefined: no such board); `env`: this server's scene environment.
 * `transient`: the answer is known to be incomplete for now (decided after building it; pass false before).
 */
export function keyedAnswer(asked: { key: string | null; v: string | null }, current: string | undefined, env: string, ifNoneMatch: string | string[] | undefined, transient = false): KeyedAnswer {
  const cacheable = !!asked.key && !!current && asked.key === current && asked.v === env && !transient;
  if (!cacheable) return { cacheable: false, notModified: false, headers: { "cache-control": "no-store" } };
  const etag = `"${current}-${env}"`;
  const inm = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : (ifNoneMatch ?? "");
  const notModified = inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
  return { cacheable, notModified, headers: { "cache-control": IMMUTABLE, etag } };
}

const FONT_DIRS = [path.join(os.homedir(), "Library/Fonts"), "/Library/Fonts", "/System/Library/Fonts", "/System/Library/Fonts/Supplemental"];

/**
 * The scene environment: everything besides the board's key that shapes a scene. The code version (any change
 * under src/), the scene format, whether web fonts are on, and the font folders (a font added or removed changes
 * the folder's modification time). Worked out once per server: the server reads installed fonts once too.
 */
export function sceneEnvOf(codeVersion: string, sceneVersion: number, webFonts: boolean, dirs = FONT_DIRS): string {
  const h = createHash("sha1").update(`${codeVersion}|${sceneVersion}|${webFonts ? 1 : 0}`);
  for (const d of dirs) {
    try {
      const st = fs.statSync(d);
      h.update(`|${d}:${Math.floor(st.mtimeMs)}`);
    } catch {
      h.update(`|${d}:-`);
    }
  }
  return h.digest("hex").slice(0, 12);
}
