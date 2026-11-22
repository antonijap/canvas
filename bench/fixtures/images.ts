import { execFileSync } from "node:child_process";
import os from "node:os";
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

export const OVERVIEW_BOARDS = 2000;
export const SCREENS_PER_BOARD = 5;
export const OVERVIEW_FILES = OVERVIEW_BOARDS * SCREENS_PER_BOARD;

export function writeOverviewFixture(dir: string) {
  const media = path.join(dir, "media");
  fs.mkdirSync(media, { recursive: true });
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-image-fixture-"));
  try {
    const generator = path.join(tools, "jpeg-screens");
    execFileSync("swiftc", ["-O", "-module-cache-path", tools, path.join(import.meta.dirname, "jpeg-screens.swift"), "-o", generator]);
    execFileSync(generator, [media, String(OVERVIEW_FILES)]);
  } finally {
    fs.rmSync(tools, { recursive: true, force: true });
  }
  writeOverviewDocument(dir);
  return dir;
}

export function writeOverviewDocument(dir: string) {
  const children = Array.from({ length: OVERVIEW_BOARDS }, (_, i) => ({
    id: `board-${i}`, type: "frame", name: `Board ${i + 1}`,
    x: i % 50 * 1480, y: Math.floor(i / 50) * 700, width: 1430, height: 650,
    clip: true, cornerRadius: 20, fill: "#FFFFFF",
    children: Array.from({ length: SCREENS_PER_BOARD }, (_, j) => {
      const n = i * SCREENS_PER_BOARD + j;
      return {
        id: `screen-${n}`, type: "rectangle", x: 23 + j * 280, y: 25, width: 264, height: 600,
        fill: [{ type: "image", url: `media/screen-${n}.jpg`, mode: "fill" }],
      };
    }),
  }));
  fs.writeFileSync(path.join(dir, "document.json"), JSON.stringify({ version: "2.21", children }));
}
