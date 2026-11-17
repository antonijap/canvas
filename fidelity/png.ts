// Minimal PNG codec (8-bit, non-interlaced) on node:zlib. Enough for Chrome screenshots and our own output.
import zlib from "node:zlib";

export type Img = { width: number; height: number; data: Uint8Array }; // RGBA, row-major

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(buf: Uint8Array): Img {
  const b = Buffer.from(buf);
  if (!b.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, depth = 0, ctype = 0;
  const idat: Buffer[] = [];
  let plte: Buffer | null = null, trns: Buffer | null = null;
  while (pos < b.length) {
    const len = b.readUInt32BE(pos), type = b.toString("latin1", pos + 4, pos + 8), body = b.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; ctype = body[9];
      if (body[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "PLTE") plte = Buffer.from(body);
    else if (type === "tRNS") trns = Buffer.from(body);
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} not supported`);
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!ch) throw new Error(`PNG colour type ${ctype} not supported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= ch ? px[dst + i - ch] : 0;
      const up = y ? px[dst - stride + i] : 0;
      const c = i >= ch && y ? px[dst - stride + i - ch] : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + up; break;
        case 3: v = x + ((a + up) >> 1); break;
        case 4: { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); break; }
        default: throw new Error(`bad PNG filter ${f}`);
      }
      px[dst + i] = v & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (ctype === 6) { data[o] = px[i * 4]; data[o + 1] = px[i * 4 + 1]; data[o + 2] = px[i * 4 + 2]; data[o + 3] = px[i * 4 + 3]; }
    else if (ctype === 2) { data[o] = px[i * 3]; data[o + 1] = px[i * 3 + 1]; data[o + 2] = px[i * 3 + 2]; data[o + 3] = 255; }
    else if (ctype === 0) { data[o] = data[o + 1] = data[o + 2] = px[i]; data[o + 3] = 255; }
    else if (ctype === 4) { data[o] = data[o + 1] = data[o + 2] = px[i * 2]; data[o + 3] = px[i * 2 + 1]; }
    else { const k = px[i]; data[o] = plte![k * 3]; data[o + 1] = plte![k * 3 + 1]; data[o + 2] = plte![k * 3 + 2]; data[o + 3] = trns && k < trns.length ? trns[k] : 255; }
  }
  return { width, height, data };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, body: Buffer) => {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0); out.write(type, 4, "latin1"); body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
};

export function encodePng(img: Img): Buffer {
  const { width, height, data } = img;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 3 })), chunk("IEND", Buffer.alloc(0))]);
}
