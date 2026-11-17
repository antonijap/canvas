// Video cards: a local video file the GPU engine plays on a free-standing card (src/page/videos.js), with
// the same live-media budget as shader cards. The file is copied into the package (media/<name>) when it
// is added, or stays where it is when the person picks "link" (an absolute path). src/videos.ts serves it
// with HTTP Range support and holds the add/replace logic.

import { bad, bool, extras, str } from "../check.ts";
import type { Config, WidgetKind } from "../types.ts";

const KNOWN = ["src", "hash", "loop", "autoplay", "muted", "posterTime", "link"];

/** File types a video card plays (WKWebView and Chrome both decode these). */
export const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

function seconds(v: unknown, field: string, def: number): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) throw bad(field, "must be a number of seconds");
  if (v < 0 || v > 86_400) throw bad(field, "must be between 0 and 86400");
  return Math.round(v * 1000) / 1000;
}

export const video: WidgetKind = {
  id: "video",
  title: "Video",
  symbol: "play.rectangle",
  defaultSize: { w: 480, h: 270 },
  minSize: { w: 64, h: 40 },
  defaults: () => ({ src: "", hash: "", loop: true, autoplay: true, muted: true, posterTime: 1, link: null }),
  validate(c: Config): Config {
    const src = str(c.src, "src", "", 4096);
    if (src.includes("\0")) throw bad("src", "must be a file path");
    if (src && !Object.hasOwn(VIDEO_TYPES, src.slice(src.lastIndexOf(".")).toLowerCase())) throw bad("src", `must be a ${Object.keys(VIDEO_TYPES).join(", ")} file`);
    const hash = str(c.hash, "hash", "", 40);
    if (!/^[0-9a-f]*$/.test(hash)) throw bad("hash", "must be a hex hash");
    const link = c.link === undefined || c.link === null ? null : str(c.link, "link", "", 200) || null;
    return {
      src, hash,
      loop: bool(c.loop, "loop", true),
      autoplay: bool(c.autoplay, "autoplay", true),
      muted: bool(c.muted, "muted", true),
      posterTime: seconds(c.posterTime, "posterTime", 1),
      link,
      ...extras(c, KNOWN),
    };
  },
  fields: [
    { key: "autoplay", label: "Play on its own", type: "bool", help: "Muted, while it is on screen and there is room in the playback budget. Off: a still frame that plays on hover." },
    { key: "loop", label: "Loop", type: "bool" },
    { key: "muted", label: "Muted", type: "bool", help: "Autoplay and hover are always silent; this is the sound when you press play." },
    { key: "posterTime", label: "Poster time (s)", type: "number", help: "The still frame shown before it plays." },
  ],
};
