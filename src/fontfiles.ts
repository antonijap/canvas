// Font file bytes for the GPU engine. The engine shapes text itself (parley), so it needs the same
// font files the browser would pick for a board: the document's own @font-face files first, then
// Google Fonts (what html.ts links for any family that is not a system font), then fonts installed
// on this Mac. Everything is handed out as plain sfnt (TrueType/OpenType): WOFF and WOFF2 are
// unpacked here, and one face is cut out of a .ttc collection, because the engine's font reader
// only understands sfnt.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { FONT_DIRS, fontDirStamp } from "./keyed.ts";

export const FONT_EXTS = new Set([".ttf", ".otf", ".ttc", ".woff", ".woff2"]);

/** What the browser falls back to for `"Family",system-ui,sans-serif` on macOS. */
export const SYSTEM_UI = "system-ui";
const SYSTEM_UI_FILES = { normal: "/System/Library/Fonts/SFNS.ttf", italic: "/System/Library/Fonts/SFNSItalic.ttf" };

/** Families html.ts never fetches from Google Fonts (it trusts the system to have them). */
const SYSTEM_FONT = /^(SF Pro|San Francisco|Helvetica|Arial|Times|Georgia|Courier|Menlo|system-ui)/i;

export type Face = { file: string; index: number; family: string; families: string[]; weight: number; wMin: number; wMax: number; italic: boolean };
export type FontHit = { bytes: Buffer; family: string; weight: number; italic: boolean; source: "document" | "google" | "installed" | "system-ui"; file?: string };

// ---------------------------------------------------------------- sfnt reading

const tag = (b: Buffer, at: number) => b.toString("latin1", at, at + 4);

type TableRec = { tag: string; offset: number; length: number };

function readSync(fd: number, at: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, b, got, len - got, at + got);
    if (n <= 0) break;
    got += n;
  }
  return b.subarray(0, got);
}

function tableDir(read: (at: number, len: number) => Buffer, faceOffset: number): TableRec[] {
  const head = read(faceOffset, 12);
  if (head.length < 12) return [];
  const n = head.readUInt16BE(4);
  const dir = read(faceOffset + 12, n * 16);
  const out: TableRec[] = [];
  for (let i = 0; i < n && (i + 1) * 16 <= dir.length; i++) out.push({ tag: tag(dir, i * 16), offset: dir.readUInt32BE(i * 16 + 8), length: dir.readUInt32BE(i * 16 + 12) });
  return out;
}

function faceOffsets(read: (at: number, len: number) => Buffer): number[] {
  const h = read(0, 12);
  if (h.length < 12) return [];
  if (tag(h, 0) === "ttcf") {
    const n = Math.min(h.readUInt32BE(8), 256);
    const offs = read(12, n * 4);
    return Array.from({ length: n }, (_, i) => offs.readUInt32BE(i * 4));
  }
  return [0];
}

function decodeName(b: Buffer, platform: number): string {
  if (platform === 0 || platform === 3) {
    let s = "";
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
    return s;
  }
  return b.toString("latin1");
}

/** name IDs 1, 2, 16, 17 (English Windows names first, then Mac Roman). */
function names(t: Buffer): Map<number, string> {
  const out = new Map<number, string>();
  if (t.length < 6) return out;
  const count = t.readUInt16BE(2);
  const strings = t.readUInt16BE(4);
  // English first: some system fonts (Geeza Pro) only have localized Windows names, English ones on the Mac platform.
  const rank = (p: number, e: number, l: number) => (p === 3 && (e === 1 || e === 10) && l === 0x409 ? 4 : p === 1 && e === 0 && l === 0 ? 3 : p === 3 && (e === 1 || e === 10) ? 2 : p === 0 ? 1 : 0);
  const best = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > t.length) break;
    const [p, e, l, id, len, off] = [t.readUInt16BE(r), t.readUInt16BE(r + 2), t.readUInt16BE(r + 4), t.readUInt16BE(r + 6), t.readUInt16BE(r + 8), t.readUInt16BE(r + 10)];
    if (![1, 2, 4, 16, 17].includes(id)) continue;
    const k = rank(p, e, l);
    if (k === 0 || k <= (best.get(id) ?? 0)) continue;
    const s = strings + off;
    if (s + len > t.length) continue;
    best.set(id, k);
    out.set(id, decodeName(t.subarray(s, s + len), p));
  }
  return out;
}

/** Weight range from the fvar `wght` axis, if the font is variable. */
function wghtRange(t: Buffer | undefined): [number, number] | undefined {
  if (!t || t.length < 16) return undefined;
  const axesAt = t.readUInt16BE(4);
  const count = t.readUInt16BE(8);
  const size = t.readUInt16BE(10);
  for (let i = 0; i < count; i++) {
    const a = axesAt + i * size;
    if (a + 20 > t.length) break;
    if (tag(t, a) === "wght") return [t.readInt32BE(a + 4) / 65536, t.readInt32BE(a + 12) / 65536];
  }
  return undefined;
}

function faceInfo(read: (at: number, len: number) => Buffer, file: string, index: number, offset: number): Face | undefined {
  const dir = tableDir(read, offset);
  const get = (t: string) => {
    const r = dir.find((d) => d.tag === t);
    return r ? read(r.offset, Math.min(r.length, 1 << 20)) : undefined;
  };
  const nm = get("name");
  if (!nm) return undefined;
  const n = names(nm);
  const family = n.get(16) ?? n.get(1);
  if (!family) return undefined;
  const os2 = get("OS/2");
  const weight = os2 && os2.length >= 6 ? os2.readUInt16BE(4) : 400;
  const fsSel = os2 && os2.length >= 64 ? os2.readUInt16BE(62) : 0;
  const sub = `${n.get(17) ?? n.get(2) ?? ""}`;
  const italic = (fsSel & 0x201) !== 0 || /italic|oblique/i.test(sub);
  const range = wghtRange(get("fvar"));
  const families = [...new Set([family, n.get(1), n.get(4)].filter((x): x is string => !!x))];
  return { file, index, family, families, weight, wMin: range?.[0] ?? weight, wMax: range?.[1] ?? weight, italic };
}

/** Every face in a font file on disk. */
export function facesOfFile(file: string): Face[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const f = fd;
    const read = (at: number, len: number) => readSync(f, at, len);
    return faceOffsets(read)
      .map((off, i) => faceInfo(read, file, i, off))
      .filter((x): x is Face => !!x);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- sfnt writing

function checksum(b: Buffer): number {
  let sum = 0;
  const padded = b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/** A standalone sfnt from tables. */
export function buildSfnt(flavor: number, tables: { tag: string; data: Buffer }[]): Buffer {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const n = sorted.length;
  let pow = 1;
  let log = 0;
  while (pow * 2 <= n) {
    pow *= 2;
    log++;
  }
  const head = Buffer.alloc(12 + n * 16);
  head.writeUInt32BE(flavor >>> 0, 0);
  head.writeUInt16BE(n, 4);
  head.writeUInt16BE(pow * 16, 6);
  head.writeUInt16BE(log, 8);
  head.writeUInt16BE(n * 16 - pow * 16, 10);
  const parts: Buffer[] = [head];
  let off = head.length;
  sorted.forEach((t, i) => {
    const r = 12 + i * 16;
    head.write(t.tag.padEnd(4, " "), r, "latin1");
    head.writeUInt32BE(checksum(t.data), r + 4);
    head.writeUInt32BE(off, r + 8);
    head.writeUInt32BE(t.data.length, r + 12);
    const pad = (4 - (t.data.length % 4)) % 4;
    parts.push(t.data, Buffer.alloc(pad));
    off += t.data.length + pad;
  });
  return Buffer.concat(parts);
}

/** One face of a .ttc as its own sfnt. */
export function extractFace(ttc: Buffer, index: number): Buffer {
  const read = (at: number, len: number) => ttc.subarray(at, at + len);
  const offs = faceOffsets(read);
  const off = offs[index] ?? offs[0];
  const flavor = ttc.readUInt32BE(off);
  return buildSfnt(flavor, tableDir(read, off).map((t) => ({ tag: t.tag, data: Buffer.from(ttc.subarray(t.offset, t.offset + t.length)) })));
}

// ---------------------------------------------------------------- WOFF / WOFF2

/** Upper bound on a decoded font (the largest CJK faces are ~30 MB): a hostile WOFF/WOFF2 can not inflate past it. */
export const MAX_DECODED_FONT = 64 * 1024 * 1024;

export function decodeWoff(b: Buffer): Buffer {
  const flavor = b.readUInt32BE(4);
  const n = b.readUInt16BE(12);
  const tables: { tag: string; data: Buffer }[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = 44 + i * 20;
    const [t, off, comp, orig] = [tag(b, r), b.readUInt32BE(r + 4), b.readUInt32BE(r + 8), b.readUInt32BE(r + 12)];
    total += orig;
    if (total > MAX_DECODED_FONT) throw new Error("woff: decoded font is too large");
    const raw = b.subarray(off, off + comp);
    // Each table inflates to exactly its declared size; zlib stops (throws) at the limit instead of running on.
    const data = comp < orig ? zlib.inflateSync(raw, { maxOutputLength: Math.max(orig, 1) }) : Buffer.from(raw);
    if (data.length !== orig && comp < orig) throw new Error(`woff: table ${t} is not the declared size`);
    tables.push({ tag: t, data });
  }
  return buildSfnt(flavor, tables);
}

const KNOWN_TAGS = "cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill".split(" ").map((t) => t.replace("_", " "));

class Reader {
  b: Buffer;
  at: number;
  constructor(b: Buffer, at = 0) {
    this.b = b;
    this.at = at;
  }
  u8() {
    return this.b[this.at++];
  }
  u16() {
    const v = this.b.readUInt16BE(this.at);
    this.at += 2;
    return v;
  }
  i16() {
    const v = this.b.readInt16BE(this.at);
    this.at += 2;
    return v;
  }
  u32() {
    const v = this.b.readUInt32BE(this.at);
    this.at += 4;
    return v;
  }
  base128() {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const c = this.u8();
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Error("woff2: bad UIntBase128");
  }
  u255() {
    const c = this.u8();
    if (c === 253) return this.u16();
    if (c === 255) return this.u8() + 253;
    if (c === 254) return this.u8() + 506;
    return c;
  }
  take(n: number) {
    const s = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return s;
  }
}

const withSign = (flag: number, v: number) => (flag & 1 ? v : -v);

/** Undo the WOFF2 glyf transform: returns glyf, loca and every glyph's xMin (for hmtx). */
function untransformGlyf(data: Buffer): { glyf: Buffer; loca: Buffer; xMins: number[]; indexFormat: number } {
  const h = new Reader(data);
  h.u16();
  const options = h.u16();
  const numGlyphs = h.u16();
  const indexFormat = h.u16();
  const sizes = Array.from({ length: 7 }, () => h.u32());
  let at = h.at;
  const streams = sizes.map((s) => {
    const r = new Reader(data, at);
    at += s;
    return r;
  });
  const [nContour, nPoints, flags, glyphs, composite, bboxStream, instr] = streams;
  const bboxBitmapLen = ((numGlyphs + 31) >> 5) << 2;
  const bboxBits = bboxStream.take(bboxBitmapLen);
  void options;
  const out: Buffer[] = [];
  const offsets: number[] = [0];
  const xMins: number[] = [];
  let total = 0;
  for (let g = 0; g < numGlyphs; g++) {
    const nc = nContour.i16();
    const hasBbox = (bboxBits[g >> 3] & (0x80 >> (g & 7))) !== 0;
    let glyph: Buffer;
    if (nc === 0) {
      glyph = Buffer.alloc(0);
      xMins.push(0);
    } else if (nc > 0) {
      const ends: number[] = [];
      let pts = 0;
      for (let c = 0; c < nc; c++) {
        pts += nPoints.u255();
        ends.push(pts - 1);
      }
      const xs: number[] = [];
      const ys: number[] = [];
      const on: boolean[] = [];
      let x = 0;
      let y = 0;
      for (let p = 0; p < pts; p++) {
        let flag = flags.u8();
        on.push(!(flag >> 7));
        flag &= 0x7f;
        const d = glyphs;
        let dx: number;
        let dy: number;
        if (flag < 10) {
          dx = 0;
          dy = withSign(flag, ((flag & 14) << 7) + d.u8());
        } else if (flag < 20) {
          dx = withSign(flag, (((flag - 10) & 14) << 7) + d.u8());
          dy = 0;
        } else if (flag < 84) {
          const b0 = flag - 20;
          const b1 = d.u8();
          dx = withSign(flag, 1 + (b0 & 0x30) + (b1 >> 4));
          dy = withSign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
        } else if (flag < 120) {
          const b0 = flag - 84;
          dx = withSign(flag, 1 + (Math.floor(b0 / 12) << 8) + d.u8());
          dy = withSign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + d.u8());
        } else if (flag < 124) {
          const a = d.u8();
          const b2 = d.u8();
          const c2 = d.u8();
          dx = withSign(flag, (a << 4) + (b2 >> 4));
          dy = withSign(flag >> 1, ((b2 & 0x0f) << 8) + c2);
        } else {
          const a = d.u8();
          const b2 = d.u8();
          const c2 = d.u8();
          const d2 = d.u8();
          dx = withSign(flag, (a << 8) + b2);
          dy = withSign(flag >> 1, (c2 << 8) + d2);
        }
        x += dx;
        y += dy;
        xs.push(x);
        ys.push(y);
      }
      const ilen = glyphs.u255();
      const ins = instr.take(ilen);
      let bb: number[];
      if (hasBbox) bb = [bboxStream.i16(), bboxStream.i16(), bboxStream.i16(), bboxStream.i16()];
      else bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      xMins.push(bb[0]);
      const g2 = Buffer.alloc(10 + nc * 2 + 2 + ilen + pts + pts * 4);
      let o = 0;
      g2.writeInt16BE(nc, o);
      o += 2;
      for (const v of bb) {
        g2.writeInt16BE(v, o);
        o += 2;
      }
      for (const e of ends) {
        g2.writeUInt16BE(e, o);
        o += 2;
      }
      g2.writeUInt16BE(ilen, o);
      o += 2;
      ins.copy(g2, o);
      o += ilen;
      for (let p = 0; p < pts; p++) g2[o++] = on[p] ? 1 : 0;
      let px = 0;
      for (let p = 0; p < pts; p++) {
        g2.writeInt16BE(xs[p] - px, o);
        px = xs[p];
        o += 2;
      }
      let py = 0;
      for (let p = 0; p < pts; p++) {
        g2.writeInt16BE(ys[p] - py, o);
        py = ys[p];
        o += 2;
      }
      glyph = g2.subarray(0, o);
    } else {
      // Composite: component records come verbatim from the composite stream.
      const start = composite.at;
      let more = true;
      let haveInstr = false;
      while (more) {
        const f = composite.u16();
        composite.u16();
        composite.at += f & 1 ? 4 : 2;
        if (f & 0x8) composite.at += 2;
        else if (f & 0x40) composite.at += 4;
        else if (f & 0x80) composite.at += 8;
        if (f & 0x100) haveInstr = true;
        more = (f & 0x20) !== 0;
      }
      const comp = composite.b.subarray(start, composite.at);
      const bb = [bboxStream.i16(), bboxStream.i16(), bboxStream.i16(), bboxStream.i16()];
      xMins.push(bb[0]);
      const parts: Buffer[] = [];
      const hd = Buffer.alloc(10);
      hd.writeInt16BE(-1, 0);
      bb.forEach((v, i) => hd.writeInt16BE(v, 2 + i * 2));
      parts.push(hd, comp);
      if (haveInstr) {
        const ilen = glyphs.u255();
        const l = Buffer.alloc(2);
        l.writeUInt16BE(ilen);
        parts.push(l, instr.take(ilen));
      }
      glyph = Buffer.concat(parts);
    }
    const pad = (4 - (glyph.length % 4)) % 4;
    out.push(glyph, Buffer.alloc(pad));
    total += glyph.length + pad;
    offsets.push(total);
  }
  // The glyphs are re-encoded less compactly than the source (no flag repeats, 16-bit deltas), so a
  // short loca can overflow: switch to long offsets when it does.
  const format = indexFormat || total > 0x1fffe ? 1 : 0;
  const loca = Buffer.alloc(offsets.length * (format ? 4 : 2));
  offsets.forEach((v, i) => (format ? loca.writeUInt32BE(v, i * 4) : loca.writeUInt16BE(v >> 1, i * 2)));
  return { glyf: Buffer.concat(out), loca, xMins, indexFormat: format };
}

function untransformHmtx(data: Buffer, numGlyphs: number, numHMetrics: number, xMins: number[]): Buffer {
  const r = new Reader(data);
  const flags = r.u8();
  const adv = Array.from({ length: numHMetrics }, () => r.u16());
  const lsb = flags & 1 ? adv.map((_, i) => xMins[i] ?? 0) : adv.map(() => r.i16());
  const rest = Array.from({ length: numGlyphs - numHMetrics }, (_, i) => (flags & 2 ? (xMins[numHMetrics + i] ?? 0) : r.i16()));
  const out = Buffer.alloc(numHMetrics * 4 + rest.length * 2);
  adv.forEach((a, i) => {
    out.writeUInt16BE(a, i * 4);
    out.writeInt16BE(lsb[i], i * 4 + 2);
  });
  rest.forEach((v, i) => out.writeInt16BE(v, numHMetrics * 4 + i * 2));
  return out;
}

export function decodeWoff2(b: Buffer): Buffer {
  const h = woff2Header(b);
  return woff2Build(h, zlib.brotliDecompressSync(h.packed, { maxOutputLength: Math.max(h.want, 1) }));
}

const brotli = (buf: Buffer, opts: zlib.BrotliOptions) => new Promise<Buffer>((res, rej) => zlib.brotliDecompress(buf, opts, (e, out) => (e ? rej(e) : res(out))));

/** decodeWoff2 with the Brotli step off the main thread (a document font decoded while edits wait: 400 ms). */
export async function decodeWoff2Async(b: Buffer): Promise<Buffer> {
  const h = woff2Header(b);
  return woff2Build(h, await brotli(h.packed, { maxOutputLength: Math.max(h.want, 1) }));
}

type Woff2Header = { flavor: number; dir: { tag: string; orig: number; len: number; transformed: boolean }[]; want: number; packed: Buffer };

function woff2Header(b: Buffer): Woff2Header {
  const r = new Reader(b, 4);
  const flavor = r.u32();
  r.u32();
  const numTables = r.u16();
  r.u16();
  r.u32();
  const compressedSize = r.u32();
  r.at = 48;
  const dir: { tag: string; orig: number; len: number; transformed: boolean }[] = [];
  for (let i = 0; i < numTables; i++) {
    const f = r.u8();
    const t = (f & 0x3f) === 63 ? tag(r.take(4), 0) : KNOWN_TAGS[f & 0x3f];
    const version = f >> 6;
    const orig = r.base128();
    const transformed = t === "glyf" || t === "loca" ? version === 0 : version !== 0;
    const len = transformed ? r.base128() : orig;
    dir.push({ tag: t, orig, len, transformed });
  }
  if (flavor === 0x74746366) throw new Error("woff2 collections are not supported");
  const want = dir.reduce((n, d) => n + d.len, 0);
  if (want > MAX_DECODED_FONT || dir.reduce((n, d) => n + d.orig, 0) > MAX_DECODED_FONT) throw new Error("woff2: decoded font is too large");
  return { flavor, dir, want, packed: b.subarray(r.at, r.at + compressedSize) };
}

function woff2Build({ flavor, dir }: Woff2Header, data: Buffer): Buffer {
  const raw = new Map<string, Buffer>();
  let at = 0;
  for (const d of dir) {
    raw.set(d.tag, data.subarray(at, at + d.len));
    at += d.len;
  }
  const tables: { tag: string; data: Buffer }[] = [];
  let xMins: number[] = [];
  const glyfDir = dir.find((d) => d.tag === "glyf");
  if (glyfDir?.transformed) {
    const g = untransformGlyf(raw.get("glyf") as Buffer);
    xMins = g.xMins;
    tables.push({ tag: "glyf", data: g.glyf }, { tag: "loca", data: g.loca });
    const head = raw.get("head");
    if (head) {
      const h = Buffer.from(head);
      h.writeInt16BE(g.indexFormat, 50);
      raw.set("head", h);
    }
  }
  for (const d of dir) {
    if (glyfDir?.transformed && (d.tag === "glyf" || d.tag === "loca")) continue;
    let t = raw.get(d.tag) as Buffer;
    if (d.tag === "hmtx" && d.transformed) {
      const numGlyphs = (raw.get("maxp") as Buffer).readUInt16BE(4);
      const numHMetrics = (raw.get("hhea") as Buffer).readUInt16BE(34);
      t = untransformHmtx(t, numGlyphs, numHMetrics, xMins);
    }
    tables.push({ tag: d.tag, data: Buffer.from(t) });
  }
  return buildSfnt(flavor, tables);
}

/** toSfnt without blocking: the file read and a WOFF2's Brotli step run off the main thread. */
export async function toSfntFile(file: string, index = 0): Promise<Buffer> {
  const bytes = await fs.promises.readFile(file);
  return bytes.toString("latin1", 0, 4) === "wOF2" ? decodeWoff2Async(bytes) : toSfnt(bytes, index);
}

/** Any supported font file as one sfnt face. */
export function toSfnt(bytes: Buffer, index = 0): Buffer {
  const sig = bytes.toString("latin1", 0, 4);
  if (sig === "wOF2") return decodeWoff2(bytes);
  if (sig === "wOFF") return decodeWoff(bytes);
  if (sig === "ttcf") return extractFace(bytes, index);
  return bytes;
}

// ---------------------------------------------------------------- matching

/** CSS Fonts 4 font matching: style first, then the weight rules. */
export function pickFace<T extends { weight: number; wMin?: number; wMax?: number; italic: boolean }>(faces: T[], weight: number, italic: boolean): T | undefined {
  if (!faces.length) return undefined;
  const sameStyle = faces.filter((f) => f.italic === italic);
  const pool = sameStyle.length ? sameStyle : faces;
  const covers = pool.find((f) => (f.wMin ?? f.weight) <= weight && weight <= (f.wMax ?? f.weight));
  if (covers) return covers;
  const w = (f: T) => f.weight;
  const asc = (xs: T[]) => [...xs].sort((a, b) => w(a) - w(b));
  const desc = (xs: T[]) => [...xs].sort((a, b) => w(b) - w(a));
  let order: T[];
  if (weight >= 400 && weight <= 500) order = [...asc(pool.filter((f) => w(f) >= weight && w(f) <= 500)), ...desc(pool.filter((f) => w(f) < weight)), ...asc(pool.filter((f) => w(f) > 500))];
  else if (weight < 400) order = [...desc(pool.filter((f) => w(f) <= weight)), ...asc(pool.filter((f) => w(f) > weight))];
  else order = [...asc(pool.filter((f) => w(f) >= weight)), ...desc(pool.filter((f) => w(f) < weight))];
  return order[0];
}

export const weightOf = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "400").trim().toLowerCase();
  if (s === "normal" || s === "regular" || s === "") return 400;
  if (s === "bold") return 700;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 400;
};

// ---------------------------------------------------------------- sources

let installed: { stamp: string; faces: Promise<Face[]> } | undefined;

/** Installed fonts on this Mac (system, local, user), read from the files' own name tables. */
export function installedFaces(dirs = FONT_DIRS): Promise<Face[]> {
  const stamp = fontDirStamp(dirs);
  if (installed?.stamp === stamp) return installed.faces;
  const faces = (async () => {
    const files: string[] = [];
    const walk = async (d: string, depth: number) => {
      let es: fs.Dirent[];
      try {
        es = await fs.promises.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth > 0 && !e.name.startsWith(".")) await walk(p, depth - 1);
        else if (e.isFile() && FONT_EXTS.has(path.extname(e.name).toLowerCase()) && !e.name.endsWith(".woff2") && !e.name.endsWith(".woff")) files.push(p);
      }
    };
    for (const d of dirs) await walk(d, 2);
    const faces: Face[] = [];
    for (const f of [...new Set(files)]) {
      faces.push(...facesOfFile(f));
      await new Promise<void>((r) => setImmediate(r));
    }
    return faces;
  })();
  installed = { stamp, faces };
  return faces;
}

type DocFont = { name: string; url: string; weight?: number | string; style?: string };

/** A document's file reference as a path: `file:` URLs are decoded (%20 is a space), anything else resolves against `baseDir`. */
export function localPath(url: string, baseDir: string): string {
  if (url.startsWith("file:")) {
    try {
      return fileURLToPath(url);
    } catch {
      return path.resolve(baseDir, decodeURIComponent(new URL(url).pathname));
    }
  }
  return path.resolve(baseDir, url);
}

/** The document's own font files (doc.fonts), the ones html.ts turns into @font-face rules. */
function docFont(fonts: DocFont[] | undefined, baseDir: string, family: string, weight: number, italic: boolean): { file: string; weight: number; italic: boolean } | undefined {
  const faces = (fonts ?? [])
    .filter((f) => String(f.name).toLowerCase() === family.toLowerCase() && typeof f.url === "string")
    .map((f) => ({ file: localPath(f.url, baseDir), weight: weightOf(f.weight ?? 400), italic: /italic|oblique/i.test(String(f.style ?? "")) }))
    .filter((f) => FONT_EXTS.has(path.extname(f.file).toLowerCase()) && fs.existsSync(f.file));
  return pickFace(faces, weight, italic);
}

// ---------------------------------------------------------------- cmap coverage

/** Which code points a face maps to a real glyph: sorted, merged [first, last] ranges. */
export class Coverage {
  readonly ranges: [number, number][];
  constructor(ranges: [number, number][]) {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    }
    this.ranges = out;
  }
  has(cp: number): boolean {
    let lo = 0;
    let hi = this.ranges.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const [a, b] = this.ranges[m];
      if (cp < a) hi = m - 1;
      else if (cp > b) lo = m + 1;
      else return true;
    }
    return false;
  }
}

/** The cmap of an sfnt face (format 12 preferred, else format 4). */
export function coverageOf(sfnt: Buffer): Coverage {
  const read = (at: number, len: number) => sfnt.subarray(at, at + len);
  const rec = tableDir(read, 0).find((t) => t.tag === "cmap");
  if (!rec) return new Coverage([]);
  const t = sfnt.subarray(rec.offset, rec.offset + rec.length);
  const n = t.readUInt16BE(2);
  let best: { rank: number; off: number } | undefined;
  for (let i = 0; i < n; i++) {
    const [p, e, off] = [t.readUInt16BE(4 + i * 8), t.readUInt16BE(6 + i * 8), t.readUInt32BE(8 + i * 8)];
    if (off + 2 > t.length) continue;
    const fmt = t.readUInt16BE(off);
    const unicode = p === 0 || (p === 3 && (e === 1 || e === 10));
    if (!unicode || (fmt !== 4 && fmt !== 12)) continue;
    const rank = fmt === 12 ? 2 : 1;
    if (!best || rank > best.rank) best = { rank, off };
  }
  if (!best) return new Coverage([]);
  const o = best.off;
  const ranges: [number, number][] = [];
  if (t.readUInt16BE(o) === 12) {
    const groups = t.readUInt32BE(o + 12);
    for (let g = 0; g < groups; g++) {
      const r = o + 16 + g * 12;
      if (r + 12 > t.length) break;
      const [a, b, gid] = [t.readUInt32BE(r), t.readUInt32BE(r + 4), t.readUInt32BE(r + 8)];
      if (gid === 0) {
        if (b > a) ranges.push([a + 1, b]);
      } else ranges.push([a, b]);
    }
  } else {
    const segs = t.readUInt16BE(o + 6) / 2;
    const ends = o + 14;
    const starts = ends + segs * 2 + 2;
    const deltas = starts + segs * 2;
    const offs = deltas + segs * 2;
    for (let s = 0; s < segs; s++) {
      const end = t.readUInt16BE(ends + s * 2);
      const start = t.readUInt16BE(starts + s * 2);
      const delta = t.readInt16BE(deltas + s * 2);
      const ro = t.readUInt16BE(offs + s * 2);
      if (start === 0xffff) continue;
      let runStart = -1;
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        let gid: number;
        if (ro === 0) gid = (cp + delta) & 0xffff;
        else {
          const at = offs + s * 2 + ro + (cp - start) * 2;
          gid = at + 2 <= t.length ? t.readUInt16BE(at) : 0;
          if (gid) gid = (gid + delta) & 0xffff;
        }
        if (gid && runStart < 0) runStart = cp;
        if (!gid && runStart >= 0) {
          ranges.push([runStart, cp - 1]);
          runStart = -1;
        }
      }
      if (runStart >= 0) ranges.push([runStart, Math.min(end, 0xfffe)]);
    }
  }
  return new Coverage(ranges);
}

const fileCoverage = new Map<string, Coverage>();

/** Coverage of one face of a font file on disk (cached). */
export function coverageOfFile(file: string, index = 0): Coverage {
  const key = `${file}#${index}`;
  let c = fileCoverage.get(key);
  if (!c) {
    try {
      c = coverageOf(toSfnt(fs.readFileSync(file), index));
    } catch {
      c = new Coverage([]);
    }
    fileCoverage.set(key, c);
  }
  return c;
}

/** CSS `unicode-range` → ranges. */
export function parseUnicodeRange(s: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of s.split(",")) {
    const m = /U\+([0-9A-F?]+)(?:-([0-9A-F]+))?/i.exec(part.trim());
    if (!m) continue;
    if (m[1].includes("?")) out.push([Number.parseInt(m[1].replace(/\?/g, "0"), 16), Number.parseInt(m[1].replace(/\?/g, "F"), 16)]);
    else out.push([Number.parseInt(m[1], 16), Number.parseInt(m[2] ?? m[1], 16)]);
  }
  return out;
}

// ---------------------------------------------------------------- Google Fonts, as the browser gets them

/** A desktop Chrome on macOS: Google answers it with the same variable WOFF2 subsets the page loads. */
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

/** The stylesheets html.ts links for a web family (keep in step with fontAssets in src/doc/render/html.ts). */
export function googleLinks(family: string): string[] {
  const q = encodeURIComponent(family).replace(/%20/g, "+");
  return [`https://fonts.googleapis.com/css2?family=${q}:ital,wght@0,100..900;1,100..900&display=block`, `https://fonts.googleapis.com/css2?family=${q}:wght@400;500;600;700&display=block`];
}

/** One `@font-face` of a Google stylesheet: one unicode-range subset of one face. */
export type GFace = { family: string; italic: boolean; wMin: number; wMax: number; subset: string; ranges: [number, number][]; url: string; order: number };

export function parseGoogleCss(css: string, order0 = 0): GFace[] {
  const out: GFace[] = [];
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  let n = order0;
  for (const m of css.matchAll(re)) {
    const body = m[2];
    const get = (k: string) => new RegExp(`${k}\\s*:\\s*([^;]+);?`, "i").exec(body)?.[1].trim();
    const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/.exec(body)?.[1];
    if (!url) continue;
    const w = (get("font-weight") ?? "400").split(/\s+/).map(Number).filter(Number.isFinite);
    const range = get("unicode-range");
    out.push({
      family: (get("font-family") ?? "").replace(/^['"]|['"]$/g, ""),
      italic: /italic|oblique/i.test(get("font-style") ?? ""),
      wMin: w[0] ?? 400,
      wMax: w[1] ?? w[0] ?? 400,
      subset: m[1] ?? `s${n}`,
      ranges: range ? parseUnicodeRange(range) : [[0, 0x10ffff]],
      url,
      order: n++,
    });
  }
  return out;
}

const gcss = new Map<string, Promise<GFace[]>>();
/** Families whose last Google Fonts lookup failed on the network (offline, timeout): the answer may change soon. */
const gfailed = new Set<string>();
export const googleFailed = (family: string): boolean => gfailed.has(family.toLowerCase());

/** Every @font-face the page's Google stylesheets declare for `family` (cached; [] when offline). */
export function googleFaces(family: string, fetcher: typeof fetch = fetch): Promise<GFace[]> {
  const key = family.toLowerCase();
  let p = gcss.get(key);
  if (!p) {
    p = (async () => {
      const all: GFace[] = [];
      let failed = false;
      for (const link of googleLinks(family)) {
        try {
          const r = await fetcher(link, { headers: { "user-agent": CHROME_UA }, signal: AbortSignal.timeout(6000) });
          if (r.ok) all.push(...parseGoogleCss(await r.text(), all.length));
        } catch {
          failed = true; // offline or blocked
        }
      }
      if (failed && !all.length) gfailed.add(key);
      else gfailed.delete(key);
      if (!all.length) gcss.delete(key); // try again next time
      return all;
    })();
    gcss.set(key, p);
  }
  return p;
}

/**
 * CSS font matching over the stylesheets' faces: the face set (same style and weight descriptor)
 * the browser uses for this weight and style, its subsets in the order the browser checks them
 * (the last rule defined first).
 */
export function pickGoogle(faces: GFace[], weight: number, italic: boolean): GFace[] {
  const sets = new Map<string, GFace[]>();
  for (const f of faces) {
    const k = `${f.italic}|${f.wMin}|${f.wMax}`;
    if (!sets.has(k)) sets.set(k, []);
    sets.get(k)!.push(f);
  }
  const descs = [...sets.entries()].map(([k, fs]) => ({ k, italic: fs[0].italic, wMin: fs[0].wMin, wMax: fs[0].wMax, weight: Math.min(fs[0].wMax, Math.max(fs[0].wMin, weight)) }));
  const best = pickFace(descs, weight, italic);
  return best ? [...sets.get(best.k)!].sort((a, b) => b.order - a.order) : [];
}

const gfiles = new Map<string, Promise<Buffer | undefined>>();

function googleFile(url: string, fetcher: typeof fetch): Promise<Buffer | undefined> {
  let p = gfiles.get(url);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetcher(url, { headers: { "user-agent": CHROME_UA }, signal: AbortSignal.timeout(15000) });
        return r.ok ? toSfnt(Buffer.from(await r.arrayBuffer())) : undefined;
      } catch {
        return undefined;
      }
    })();
    gfiles.set(url, p);
    void p.then((b) => b || gfiles.delete(url));
  }
  return p;
}

// ---------------------------------------------------------------- platform fallback (what CoreText picks in Chrome)

/** Code points with emoji presentation by default (drawn from Apple Color Emoji). */
export function isEmoji(cp: number): boolean {
  if (cp >= 0x1f000 && cp <= 0x1faff) return true;
  return [0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55].includes(cp) || (cp >= 0x2648 && cp <= 0x2653);
}

const inRanges = (cp: number, rs: [number, number][]) => rs.some(([a, b]) => cp >= a && cp <= b);

/**
 * Installed families Chrome on macOS falls back to for a character none of the CSS families has
 * (measured with CSS.getPlatformFontsForNode for `"Inter",system-ui,sans-serif`), most likely first.
 */
export function fallbackFamilies(cp: number): string[] {
  if (isEmoji(cp)) return ["Apple Color Emoji"];
  if (inRanges(cp, [[0x0590, 0x05ff], [0xfb1d, 0xfb4f]])) return ["Lucida Grande", "Arial Hebrew"];
  if (inRanges(cp, [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]])) return ["Geeza Pro"];
  if (inRanges(cp, [[0x0e00, 0x0e7f]])) return ["Thonburi", ".ThonburiUI"];
  if (inRanges(cp, [[0x0900, 0x097f]])) return ["Kohinoor Devanagari"];
  if (inRanges(cp, [[0xac00, 0xd7af], [0x1100, 0x11ff], [0x3130, 0x318f]])) return ["Apple SD Gothic Neo"];
  if (inRanges(cp, [[0x3040, 0x30ff]])) return ["Hiragino Sans", "Hiragino Sans GB"];
  if (inRanges(cp, [[0x2e80, 0x9fff], [0xf900, 0xfaff], [0xff00, 0xffef], [0x20000, 0x2ffff]])) return ["PingFang SC", "Hiragino Sans GB", ".CJK Symbols Fallback SC"];
  return ["Helvetica", "Lucida Grande", "PingFang SC", "Hiragino Sans GB", "Apple Symbols", ".CJK Symbols Fallback SC", "Arial Unicode MS"];
}

/** Every fallback family, in the order a text's family chain lists them. */
export const FALLBACK_ORDER = ["Helvetica", "Lucida Grande", "Arial Hebrew", "Geeza Pro", "Thonburi", ".ThonburiUI", "Kohinoor Devanagari", "Apple SD Gothic Neo", "Hiragino Sans", "PingFang SC", "Hiragino Sans GB", "Apple Symbols", ".CJK Symbols Fallback SC", "Arial Unicode MS", "Apple Color Emoji"];

/** Fallback faces bigger than this are skipped for the next candidate (every byte sits in WASM memory). */
export const FALLBACK_MAX_BYTES = 12 * 1024 * 1024;
/** CJK has no small fallback: up to this much for a board that needs it. */
export const FALLBACK_MAX_BYTES_CJK = 40 * 1024 * 1024;

/** The installed face for a fallback family at a weight and style, with its coverage and size. */
export async function fallbackFace(family: string, weight: number, italic: boolean, faces: () => Promise<Face[]> = installedFaces): Promise<{ face: Face; coverage: Coverage; bytes: number } | undefined> {
  const lower = family.toLowerCase();
  const f = pickFace((await faces()).filter((x) => x.families.some((n) => n.toLowerCase() === lower)), weight, italic);
  if (!f) return undefined;
  const bytes = faceBytes(f.file, f.index);
  if (!bytes) return undefined;
  return { face: f, coverage: coverageOfFile(f.file, f.index), bytes };
}

/** The size one face of a font file has once cut out (its tables). */
function faceBytes(file: string, index: number): number {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const f = fd;
    const read = (at: number, len: number) => readSync(f, at, len);
    const off = faceOffsets(read)[index] ?? 0;
    return tableDir(read, off).reduce((n, t) => n + t.length, 0);
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- bitmap emoji subset

/**
 * A small sbix font holding only `cps` from Apple Color Emoji (one strike, the largest at or
 * under `ppem`): the whole file is ~190 MB, the engine needs a handful of glyphs.
 */
export function emojiSubset(sfnt: Buffer, cps: number[], ppem = 160): Buffer | undefined {
  const read = (at: number, len: number) => sfnt.subarray(at, at + len);
  const dir = tableDir(read, 0);
  const tab = (t: string) => {
    const r = dir.find((d) => d.tag === t);
    return r ? sfnt.subarray(r.offset, r.offset + r.length) : undefined;
  };
  const [head, hhea, maxp, hmtx, sbix, cmapT] = ["head", "hhea", "maxp", "hmtx", "sbix", "cmap"].map(tab);
  if (!head || !hhea || !maxp || !hmtx || !sbix || !cmapT) return undefined;
  const numGlyphs = maxp.readUInt16BE(4);
  const numHM = hhea.readUInt16BE(34);
  // code point → glyph through the format 12 / 4 subtable
  const gidOf = glyphLookup(cmapT);
  const keep: { cp: number; gid: number }[] = [];
  for (const cp of [...new Set(cps)].sort((a, b) => a - b)) {
    const gid = gidOf(cp);
    if (gid > 0 && gid < numGlyphs) keep.push({ cp, gid });
  }
  if (!keep.length) return undefined;
  const advOf = (g: number) => hmtx.readUInt16BE(Math.min(g, numHM - 1) * 4);
  const lsbOf = (g: number) => (g < numHM ? hmtx.readInt16BE(g * 4 + 2) : hmtx.readInt16BE(numHM * 4 + (g - numHM) * 2));
  // strike
  const nStrikes = sbix.readUInt32BE(4);
  let strike = -1;
  let bestPpem = 0;
  for (let s = 0; s < nStrikes; s++) {
    const off = sbix.readUInt32BE(8 + s * 4);
    const p = sbix.readUInt16BE(off);
    if ((p <= ppem && p > bestPpem) || strike < 0) {
      strike = off;
      bestPpem = p;
    }
  }
  const glyphs = [0, ...keep.map((k) => k.gid)];
  const n = glyphs.length;
  const dataOf = (g: number) => {
    const a = sbix.readUInt32BE(strike + 4 + g * 4);
    const b = sbix.readUInt32BE(strike + 4 + (g + 1) * 4);
    return sbix.subarray(strike + a, strike + b);
  };
  const datas = glyphs.map(dataOf);
  const strikeHead = Buffer.alloc(4 + (n + 1) * 4);
  strikeHead.writeUInt16BE(bestPpem, 0);
  strikeHead.writeUInt16BE(sbix.readUInt16BE(strike + 2), 2);
  let at = strikeHead.length;
  datas.forEach((d, i) => {
    strikeHead.writeUInt32BE(at, 4 + i * 4);
    at += d.length;
  });
  strikeHead.writeUInt32BE(at, 4 + n * 4);
  const sbixHead = Buffer.alloc(12);
  sbixHead.writeUInt16BE(1, 0);
  sbixHead.writeUInt16BE(sbix.readUInt16BE(2), 2);
  sbixHead.writeUInt32BE(1, 4);
  sbixHead.writeUInt32BE(12, 8);
  const newSbix = Buffer.concat([sbixHead, strikeHead, ...datas]);
  const newHmtx = Buffer.alloc(n * 4);
  glyphs.forEach((g, i) => {
    newHmtx.writeUInt16BE(advOf(g), i * 4);
    newHmtx.writeInt16BE(lsbOf(g), i * 4 + 2);
  });
  const newHhea = Buffer.from(hhea);
  newHhea.writeUInt16BE(n, 34);
  const newMaxp = Buffer.alloc(6);
  newMaxp.writeUInt32BE(0x00005000, 0);
  newMaxp.writeUInt16BE(n, 4);
  // cmap format 12, (3,10)
  const groups = keep.map((k, i) => [k.cp, k.cp, i + 1]);
  const cmap = Buffer.alloc(12 + 16 + groups.length * 12);
  cmap.writeUInt16BE(0, 0);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(10, 6);
  cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(12, 12);
  cmap.writeUInt32BE(16 + groups.length * 12, 16);
  cmap.writeUInt32BE(groups.length, 24);
  groups.forEach((g, i) => g.forEach((v, j) => cmap.writeUInt32BE(v, 28 + i * 12 + j * 4)));
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);
  const keepTabs = ["name", "OS/2", "head"].map((t) => ({ tag: t, data: tab(t) })).filter((t): t is { tag: string; data: Buffer } => !!t.data);
  return buildSfnt(0x00010000, [...keepTabs, { tag: "hhea", data: newHhea }, { tag: "maxp", data: newMaxp }, { tag: "hmtx", data: newHmtx }, { tag: "cmap", data: cmap }, { tag: "sbix", data: newSbix }, { tag: "post", data: post }]);
}

function glyphLookup(t: Buffer): (cp: number) => number {
  const n = t.readUInt16BE(2);
  let f12 = -1;
  let f4 = -1;
  for (let i = 0; i < n; i++) {
    const off = t.readUInt32BE(8 + i * 8);
    const fmt = t.readUInt16BE(off);
    if (fmt === 12 && f12 < 0) f12 = off;
    if (fmt === 4 && f4 < 0) f4 = off;
  }
  return (cp: number) => {
    if (f12 >= 0) {
      const groups = t.readUInt32BE(f12 + 12);
      for (let g = 0; g < groups; g++) {
        const r = f12 + 16 + g * 12;
        const [a, b, gid] = [t.readUInt32BE(r), t.readUInt32BE(r + 4), t.readUInt32BE(r + 8)];
        if (cp >= a && cp <= b) return gid + (cp - a);
      }
      return 0;
    }
    if (f4 >= 0 && cp <= 0xffff) {
      const segs = t.readUInt16BE(f4 + 6) / 2;
      const ends = f4 + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const offs = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        if (cp > t.readUInt16BE(ends + s * 2)) continue;
        const start = t.readUInt16BE(starts + s * 2);
        if (cp < start) return 0;
        const delta = t.readInt16BE(deltas + s * 2);
        const ro = t.readUInt16BE(offs + s * 2);
        if (!ro) return (cp + delta) & 0xffff;
        const g = t.readUInt16BE(offs + s * 2 + ro + (cp - start) * 2);
        return g ? (g + delta) & 0xffff : 0;
      }
    }
    return 0;
  };
}

const google = new Map<string, Promise<Buffer | undefined>>();

/** Google Fonts as plain TrueType: the css2 API answers a client it does not recognise with .ttf URLs. */
function googleFont(family: string, weight: number, italic: boolean, fetcher: typeof fetch): Promise<Buffer | undefined> {
  const w = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  const key = `${family}|${w}|${italic}`;
  let p = google.get(key);
  if (!p) {
    p = (async () => {
      const q = encodeURIComponent(family).replace(/%20/g, "+");
      for (const spec of [`ital,wght@${italic ? 1 : 0},${w}`, `ital,wght@${italic ? 1 : 0},400`, ""]) {
        try {
          const css = await fetcher(`https://fonts.googleapis.com/css2?family=${q}${spec ? `:${spec}` : ""}`, { headers: { "user-agent": "canvas-engine" }, signal: AbortSignal.timeout(6000) });
          if (!css.ok) continue;
          const m = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(await css.text());
          if (!m) continue;
          const f = await fetcher(m[1], { signal: AbortSignal.timeout(15000) });
          if (!f.ok) continue;
          return toSfnt(Buffer.from(await f.arrayBuffer()));
        } catch {
          // offline or blocked: fall through to installed fonts
        }
      }
      return undefined;
    })();
    google.set(key, p);
  }
  return p;
}

export type FontQuery = {
  family: string;
  weight: number;
  italic: boolean;
  doc?: { fonts?: DocFont[]; baseDir: string };
  /** A Google Fonts unicode-range subset by its stylesheet name (`latin`, `cyrillic`, ...). */
  subset?: string;
  /** Only these code points (bitmap emoji are cut out of a ~190 MB file). */
  text?: number[];
};
export type FontOptions = { web?: boolean; fetcher?: typeof fetch; faces?: () => Promise<Face[]> };

export const webFontsOn = (o: FontOptions = {}) => o.web ?? process.env.CANVAS_WEB_FONTS !== "0";
export const isSystemFamily = (family: string) => SYSTEM_FONT.test(family);

/**
 * The font file the browser would use for this family, weight and style, as sfnt bytes.
 * `weight` in the answer is the face's weight descriptor, 0 for a variable face (its own `wght`
 * axis covers every weight).
 */
export async function findFont(q: FontQuery, o: FontOptions = {}): Promise<FontHit | undefined> {
  const { family, weight, italic } = q;
  if (family.toLowerCase() === SYSTEM_UI) {
    const file = italic ? SYSTEM_UI_FILES.italic : SYSTEM_UI_FILES.normal;
    if (fs.existsSync(file)) return { bytes: fs.readFileSync(file), family, weight, italic, source: "system-ui", file };
  }
  if (q.doc) {
    const d = docFont(q.doc.fonts, q.doc.baseDir, family, weight, italic);
    if (d) return { bytes: await toSfntFile(d.file), family, weight: d.weight, italic: d.italic, source: "document", file: d.file };
  }
  if (webFontsOn(o) && !SYSTEM_FONT.test(family)) {
    // The exact WOFF2 the page's Google stylesheet points the browser at, for this subset.
    const set = pickGoogle(await googleFaces(family, o.fetcher ?? fetch), weight, italic);
    const g = q.subset ? set.find((f) => f.subset === q.subset) : (set.find((f) => f.subset === "latin") ?? set[set.length - 1]);
    if (g) {
      const b = await googleFile(g.url, o.fetcher ?? fetch);
      if (b) return { bytes: b, family, weight: g.wMin === g.wMax && !hasWghtAxis(b) ? g.wMin : 0, italic: g.italic, source: "google" };
    }
    if (!q.subset) {
      const s = await googleFont(family, weight, italic, o.fetcher ?? fetch);
      if (s) return { bytes: s, family, weight, italic, source: "google" };
    }
  }
  const all = await (o.faces ?? installedFaces)();
  const lower = family.toLowerCase();
  const mine = all.filter((f) => f.families.some((n) => n.toLowerCase() === lower));
  const f = pickFace(mine, weight, italic);
  if (!f) return undefined;
  if (q.text?.length && f.file.endsWith("Apple Color Emoji.ttc")) {
    const sub = emojiSubset(toSfnt(fs.readFileSync(f.file), f.index), q.text);
    if (!sub) return undefined;
    return { bytes: sub, family, weight: f.weight, italic: f.italic, source: "installed", file: f.file };
  }
  return { bytes: await toSfntFile(f.file, f.index), family, weight: f.wMin !== f.wMax ? 0 : f.weight, italic: f.italic, source: "installed", file: f.file };
}

function hasWghtAxis(sfnt: Buffer): boolean {
  const read = (at: number, len: number) => sfnt.subarray(at, at + len);
  const r = tableDir(read, 0).find((t) => t.tag === "fvar");
  return !!r && !!wghtRange(sfnt.subarray(r.offset, r.offset + r.length));
}
