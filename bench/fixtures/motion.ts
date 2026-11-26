import fs from "node:fs";
import path from "node:path";
import type { DocNode, Json } from "../../src/engine.ts";

export const MOTION_HERO = "motion-hero";

export function motionFixture(dir: string, animated: boolean): string {
  const file = path.join(dir, animated ? "Motion.canvas" : "Rest.canvas");
  const colors = ["#84F0DA", "#818CFF", "#DC95FF", "#FFC880", "#81CCFF", "#AEE87C"];
  const children: DocNode[] = Array.from({ length: 50 }, (_, b) => {
    const id = b === 0 ? MOTION_HERO : `board-${b}`, columns = b === 0 ? 20 : 6;
    return {
      id, name: b === 0 ? "Hover motion" : `Motion study ${b}`, type: "frame", layout: "none", clip: true,
      x: (b % 10) * 1120, y: Math.floor(b / 10) * 780, width: b === 0 ? 1000 : 320, height: b === 0 ? 680 : 280,
      fill: "#182338", cornerRadius: 0,
      children: Array.from({ length: b === 0 ? 300 : 36 }, (_, i) => {
        const col = i % columns, row = Math.floor(i / columns);
        const prop = ["translateY", "scale", "opacity", "rotate"][i % 4];
        const to = [8, 1.42, 0.18, 74][i % 4];
        const eases: Json[] = [
          [0.22, 0.72, 0.24, 1], { spring: { stiffness: 95, damping: 15, mass: 1 } },
          "easeInOut", { spring: { duration: 1180, bounce: 0.25 } },
        ];
        const ease = eases[i % 4];
        const n: DocNode = {
          id: `${id}-tile-${i}`, type: i % 4 === 2 ? "ellipse" : "rectangle", name: `Tile ${i + 1}`,
          x: 21 + col * 48, y: 28 + row * 42, width: 19, height: 17,
          fill: colors[(row + Math.floor(col / 4)) % colors.length], ...(i % 4 === 3 ? { cornerRadius: 3 } : {}),
        };
        if (animated) n.motion = [{
          id: "hover", on: "boardHover",
          tracks: [{ prop, to, duration: 1450 + (i % 9) * 90, delay: (col + row) * 9, ease, repeat: "infinite", alternate: true }],
        }];
        return n;
      }),
    };
  });
  fs.mkdirSync(file, { recursive: true });
  fs.writeFileSync(path.join(file, "document.json"), JSON.stringify({ version: "2.23", children }));
  return file;
}
