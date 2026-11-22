import fs from "node:fs";
import path from "node:path";
import { encodePng } from "../../fidelity/png.ts";

export const IMAGE_BOARDS = 2000;
export const IMAGE_FILES = 250;

export function writeImageFixture(dir: string) {
  const media = path.join(dir, "media");
  fs.mkdirSync(media, { recursive: true });
  const width = 1170, height = 2532;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < IMAGE_FILES; i++) {
    for (let y = 0, p = 0; y < height; y++) {
      for (let x = 0; x < width; x++, p += 4) {
        const band = (y / 211 | 0) * 23;
        const detail = y < 760 ? ((x ^ y) * 17 + (x * y % 37)) & 31 : 0;
        data[p] = 32 + (i * 7 + band + (x >> 7)) % 160 + detail;
        data[p + 1] = 32 + (i * 13 + band * 2) % 157 + detail;
        data[p + 2] = 32 + (i * 19 + (x >> 3)) % 160 + detail;
        data[p + 3] = 255;
      }
    }
    fs.writeFileSync(path.join(media, `image-${i}.png`), encodePng({ width, height, data }));
  }
  const children = Array.from({ length: IMAGE_BOARDS }, (_, i) => ({
    id: `board-${i}`, type: "frame", name: `Image ${i + 1}`,
    x: i % 80 * 430, y: Math.floor(i / 80) * 884, width: 390, height: 844,
    fill: { type: "image", url: `media/image-${i % IMAGE_FILES}.png`, mode: "fill" },
  }));
  fs.writeFileSync(path.join(dir, "document.json"), JSON.stringify({ version: "2.21", children }));
  return dir;
}
