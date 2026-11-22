import fs from "node:fs";
import path from "node:path";
import { fixture, scratchCopy } from "./gen.ts";
import { writeImageFixture, writeOverviewFixture } from "./images.ts";

export type OpenFixture = "seven" | "many" | "empty" | "images" | "images-10k";

export function openFixture(into: string, kind: OpenFixture, name = kind + ".canvas") {
  if (kind === "images") return writeImageFixture(path.join(into, name));
  if (kind === "images-10k") return writeOverviewFixture(path.join(into, name));
  if (kind === "many") {
    const { dir } = scratchCopy(fixture(2000), into, name);
    fs.writeFileSync(path.join(dir, "media", "img-0.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return dir;
  }

  const dir = path.join(into, name);
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  if (kind === "seven") {
    const media = path.join(fixture(7).dir, "media");
    for (const image of fs.readdirSync(media)) fs.copyFileSync(path.join(media, image), path.join(dir, "media", image));
  }
  const children = Array.from({ length: kind === "seven" ? 7 : 3 }, (_, i) => ({
    id: `board-${i}`, type: "frame", name: `Board ${i + 1}`, x: (i % 4) * 380, y: Math.floor(i / 4) * 480,
    width: kind === "empty" && i === 1 ? 0 : 320, height: 420, fill: "#EAECF4",
    children: kind === "empty" ? [] : [
      { id: `photo-${i}`, type: "rectangle", x: 16, y: 16, width: 288, height: 210, fill: { type: "image", url: `media/img-${i}.png`, mode: "fill" } },
      { id: `heading-${i}`, type: "text", x: 16, y: 248, content: `Specimen ${i + 1}`, fontFamily: "Georgia", fontSize: 28, fill: "#252760" },
      { id: `caption-${i}`, type: "text", x: 16, y: 296, content: "Colour and geometry", fontFamily: "Helvetica", fontSize: 16, fill: "#252760" },
    ],
  }));
  fs.writeFileSync(path.join(dir, "document.json"), JSON.stringify({ version: "2.21", children }));
  return dir;
}
