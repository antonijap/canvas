// Font data for the GPU engine: Google stylesheets as the browser gets them, cmap coverage, and
// the platform fallback CoreText picks. No network: Google answers come from a fake fetch.

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { coverageOf, emojiSubset, fallbackFamilies, findFont, googleFaces, isEmoji, parseGoogleCss, parseUnicodeRange, pickGoogle, toSfnt } from "../src/fontfiles.ts";

const ARIAL = "/System/Library/Fonts/Supplemental/Arial.ttf";

const CSS_RANGE = `/* cyrillic */
@font-face {
  font-family: 'Testa';
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url(https://fonts.gstatic.com/s/testa/v1/cyr.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F, U+0490-0491;
}
/* latin */
@font-face {
  font-family: 'Testa';
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url(https://fonts.gstatic.com/s/testa/v1/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+2000-206F;
}
/* latin */
@font-face {
  font-family: 'Testa';
  font-style: italic;
  font-weight: 100 900;
  src: url(https://fonts.gstatic.com/s/testa/v1/latin-i.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}`;

describe("Google stylesheets", () => {
  test("@font-face rules parse into subsets with weight ranges and unicode ranges", () => {
    const f = parseGoogleCss(CSS_RANGE);
    assert.equal(f.length, 3);
    assert.deepEqual([f[0].subset, f[0].wMin, f[0].wMax, f[0].italic], ["cyrillic", 100, 900, false]);
    assert.deepEqual(f[0].ranges, [[0x301, 0x301], [0x400, 0x45f], [0x490, 0x491]]);
    assert.equal(f[2].italic, true);
    assert.deepEqual(parseUnicodeRange("U+4??"), [[0x400, 0x4ff]]);
  });

  test("matching picks the face set for the style, subsets in the order the browser checks them", () => {
    const set = pickGoogle(parseGoogleCss(CSS_RANGE), 600, false);
    assert.deepEqual(set.map((x) => x.subset), ["latin", "cyrillic"], "last defined is checked first");
    assert.deepEqual(pickGoogle(parseGoogleCss(CSS_RANGE), 400, true).map((x) => x.subset), ["latin"]);
  });

  test("the font is the exact WOFF2 the stylesheet names, decoded; a variable face reports weight 0", async () => {
    const woff2 = fs.readFileSync(ARIAL); // any sfnt: toSfnt passes it through
    const urls: string[] = [];
    const fetcher = (async (u: string | URL) => {
      urls.push(String(u));
      if (String(u).includes("googleapis")) return new Response(String(u).includes("ital") ? CSS_RANGE : "", { status: 200 });
      return new Response(woff2, { status: 200 });
    }) as typeof fetch;
    const faces = await googleFaces("Testa", fetcher);
    assert.equal(faces.length, 3);
    const hit = await findFont({ family: "Testa", weight: 500, italic: false, subset: "cyrillic" }, { web: true, fetcher, faces: async () => [] });
    assert.equal(hit?.source, "google");
    assert.equal(hit?.weight, 0, "a 100-900 face: the engine uses the file's own weight and axes");
    assert.ok(urls.some((u) => u.endsWith("/cyr.woff2")));
    assert.ok(urls.every((u) => !u.includes("googleapis") || u.includes("display=block")), "the same stylesheet URLs html.ts links");
  });
});

describe("coverage and fallback", () => {
  test("cmap coverage reads the font's own table", () => {
    const c = coverageOf(toSfnt(fs.readFileSync(ARIAL)));
    assert.ok(c.has(0x41) && c.has(0x416), "Latin and Cyrillic");
    assert.ok(!c.has(0x4e2d), "no CJK in Arial");
  });

  test("CoreText's picks per script, emoji by presentation", () => {
    assert.deepEqual(fallbackFamilies(0x5d0).slice(0, 1), ["Lucida Grande"]);
    assert.deepEqual(fallbackFamilies(0x644), ["Geeza Pro"]);
    assert.equal(fallbackFamilies(0x1f525)[0], "Apple Color Emoji");
    assert.ok(isEmoji(0x1f600) && !isEmoji(0x263a), "☺ has text presentation");
  });

  test("bitmap emoji are cut down to the requested glyphs", { skip: !fs.existsSync("/System/Library/Fonts/Apple Color Emoji.ttc") }, () => {
    const full = toSfnt(fs.readFileSync("/System/Library/Fonts/Apple Color Emoji.ttc"), 0);
    const sub = emojiSubset(full, [0x1f525, 0x1f600]);
    assert.ok(sub && sub.length < 400_000, `small: ${sub?.length}`);
    const c = coverageOf(sub!);
    assert.ok(c.has(0x1f525) && c.has(0x1f600) && !c.has(0x1f601));
  });
});

describe("hunt-1 #10/#11: file URLs and hostile compressed fonts", () => {
  test("#10 file: URLs decode percent escapes (a space in the name)", async () => {
    const { localPath } = await import("../src/fontfiles.ts");
    assert.equal(localPath("file:///tmp/My%20Logo.png", "/x"), "/tmp/My Logo.png");
    assert.equal(localPath("file:///tmp/My%20Font.ttf", "/x"), "/tmp/My Font.ttf");
    assert.equal(localPath("img/a b.png", "/base"), "/base/img/a b.png");
  });

  test("#11 a WOFF whose table inflates past its declared size, or past the cap, is refused without inflating it all", async () => {
    const zlib = await import("node:zlib");
    const { decodeWoff, MAX_DECODED_FONT } = await import("../src/fontfiles.ts");
    const woff = (comp: Buffer, orig: number) => {
      const head = Buffer.alloc(44 + 20);
      head.write("wOFF", 0, "latin1");
      head.writeUInt32BE(0x00010000, 4);
      head.writeUInt16BE(1, 12);
      head.write("glyf", 44, "latin1");
      head.writeUInt32BE(64, 48);
      head.writeUInt32BE(comp.length, 52);
      head.writeUInt32BE(orig, 56);
      return Buffer.concat([head, comp]);
    };
    const bomb = zlib.deflateSync(Buffer.alloc(16 * 1024 * 1024));
    // Inflation stops at the declared size: either a refusal or a small result, never 16 MB.
    let out: Buffer | undefined;
    try {
      out = decodeWoff(woff(bomb, 1000));
    } catch {}
    assert.ok(!out || out.length < 100_000, `decoded ${out?.length} bytes`);
    assert.throws(() => decodeWoff(woff(bomb, MAX_DECODED_FONT + 1)), /too large/);
  });
});
