// Writes the golden fixtures: one small .canvas.json per rendering concern, the test images they use, and
// views.json (which zooms and device scales each fixture is shot at). Run after changing this file:
//   node test/golden/make-fixtures.ts
// The fixtures are checked in; the runner (run.ts) only reads them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng, type Img } from "../../fidelity/png.ts";
import { autoTracking } from "../../src/tracking.ts";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
fs.mkdirSync(path.join(DIR, "assets"), { recursive: true });

type N = Record<string, any>;
export type View = { name: string; zoom: number; dpr: number; x?: number; y?: number; w?: number; h?: number; tiles?: boolean };
const views: Record<string, View[]> = {};
const notes: Record<string, string> = {};
const DEFAULT_VIEWS: View[] = [{ name: "1x", zoom: 1, dpr: 1 }, { name: "1x@2", zoom: 1, dpr: 2 }];

let seq = 0;
const id = (p: string) => `${p}${++seq}`;
const rect = (x: number, y: number, w: number, h: number, o: N = {}): N => ({ type: "rectangle", id: id("r"), x, y, width: w, height: h, ...o });
const ell = (x: number, y: number, w: number, h: number, o: N = {}): N => ({ type: "ellipse", id: id("e"), x, y, width: w, height: h, ...o });
const frame = (x: number, y: number, w: number | string | undefined, h: number | string | undefined, children: N[], o: N = {}): N => ({ type: "frame", id: id("f"), x, y, ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}), layout: "none", ...o, children });
const text = (x: number, y: number, content: string, o: N = {}): N => ({ type: "text", id: id("t"), x, y, content, fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#18181B", ...o });
const grad = (gradientType: string, colors: [string, number][], o: N = {}): N => ({ type: "gradient", gradientType, colors: colors.map(([color, position]) => ({ color, position })), ...o });
const shadow = (x: number, y: number, blur: number, color: string, o: N = {}): N => ({ type: "shadow", shadowType: "outer", offset: { x, y }, blur, color, ...o });

function fixture(name: string, w: number, h: number, children: N[], o: { fill?: string; extra?: N[]; doc?: N; views?: View[]; note?: string } = {}) {
  seq = 0;
  const doc = { version: "2.22", ...(o.doc ?? {}), children: [{ type: "frame", id: "B", name, x: 0, y: 0, width: w, height: h, fill: o.fill ?? "#FFFFFF", layout: "none", clip: true, children }, ...(o.extra ?? [])] };
  fs.writeFileSync(path.join(DIR, `${name}.canvas.json`), JSON.stringify(doc, null, 1) + "\n");
  views[name] = o.views ?? DEFAULT_VIEWS;
  if (o.note) notes[name] = o.note;
}

// ---------------------------------------------------------------- test images

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Img {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
const PALETTE: [number, number, number][] = [[239, 68, 68], [34, 197, 94], [59, 130, 246], [250, 204, 21], [168, 85, 247], [20, 184, 166], [249, 115, 22], [24, 24, 27]];
/** 256 x 192: colour blocks, a white disc, a diagonal, a 4 px frame. Flat colours, so an aspect or crop error moves hard edges. */
const pattern = image(256, 192, (x, y) => {
  if (x < 4 || y < 4 || x >= 252 || y >= 188) return [24, 24, 27, 255];
  if ((x - 128) ** 2 + (y - 96) ** 2 < 40 ** 2) return [255, 255, 255, 255];
  if (Math.abs(x - y * (256 / 192)) < 3) return [255, 255, 255, 255];
  const c = PALETTE[(Math.floor(x / 64) + Math.floor(y / 64) * 4) % 8];
  return [c[0], c[1], c[2], 255];
});
/** 200 x 200 with a transparent background: an opaque ring and a half-transparent disc (premultiplied filtering shows at the edges). */
const alpha = image(200, 200, (x, y) => {
  const d = Math.hypot(x - 100, y - 100);
  if (d > 70 && d < 92) return [220, 38, 38, 255];
  if (d < 50) return [37, 99, 235, 128];
  return [0, 0, 0, 0];
});
/** 1600 x 1200: 1 px black/white stripes, a 2 px checker, a zone plate and flat blocks. Minification without area filtering shows moire. */
const fine = image(1600, 1200, (x, y) => {
  const q = (x < 800 ? 0 : 1) + (y < 600 ? 0 : 2);
  if (q === 0) return x % 2 ? [0, 0, 0, 255] : [255, 255, 255, 255];
  if (q === 1) return (Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? [20, 20, 20, 255] : [240, 240, 240, 255];
  if (q === 2) { const r2 = (x - 400) ** 2 + (y - 900) ** 2; return Math.sin(r2 / 900) > 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]; }
  const c = PALETTE[(Math.floor((x - 800) / 100) + Math.floor((y - 600) / 100) * 3) % 8];
  return [c[0], c[1], c[2], 255];
});
fs.writeFileSync(path.join(DIR, "assets", "pattern.png"), encodePng(pattern));
fs.writeFileSync(path.join(DIR, "assets", "alpha.png"), encodePng(alpha));
fs.writeFileSync(path.join(DIR, "assets", "fine.png"), encodePng(fine));
const img = (file: string, mode?: string, o: N = {}): N => ({ type: "image", url: `assets/${file}`, ...(mode ? { mode } : {}), ...o });

// ---------------------------------------------------------------- fills and gradients

fixture("fill-solid", 480, 240, [
  rect(20, 20, 100, 80, { fill: "#EF4444" }),
  rect(130, 20, 100, 80, { fill: "#22C55E80" }),
  rect(180, 60, 100, 80, { fill: "#3B82F6CC" }),
  rect(300, 20, 100, 80, { fill: [{ type: "color", color: "#FACC15" }, { type: "color", color: "#A855F766" }] }),
  ell(20, 130, 120, 80, { fill: "#14B8A6" }),
  ell(100.5, 140.5, 80.25, 60.75, { fill: "#F9731699" }),
  rect(300, 130, 0.5, 80, { fill: "#000000" }),
  rect(310, 130, 1, 80, { fill: "#000000" }),
  rect(320.5, 130, 1, 80, { fill: "#000000" }),
  rect(330, 130.5, 60, 1, { fill: "#000000" }),
  rect(330, 140, 60, 0.5, { fill: "#000000" }),
  rect(400, 130, 60, 80, { fill: "#F00" }),
]);

const RAINBOW: [string, number][] = [["#EF4444", 0], ["#FACC15", 0.33], ["#22C55E", 0.66], ["#3B82F6", 1]];
fixture("gradient-linear", 520, 330, [
  ...[0, 45, 90, 135, 180, 270].map((r, i) => rect(20 + (i % 3) * 165, 20 + Math.floor(i / 3) * 100, 150, 85, { fill: grad("linear", RAINBOW, { rotation: r }) })),
  rect(20, 225, 150, 85, { fill: grad("linear", [["#000000", 0], ["#00000000", 1]], { rotation: 90 }) }),
  rect(185, 225, 150, 85, { fill: grad("linear", [["#18181B", 0], ["#18181B", 0.5], ["#F4F4F5", 0.5], ["#F4F4F5", 1]], { rotation: 30 }) }),
  rect(350, 225, 150, 85, { cornerRadius: 20, fill: grad("linear", [["#7C3AED", 0.2], ["#EC4899", 0.8]], { rotation: 60, opacity: 0.5 }) }),
]);
fixture("gradient-radial", 520, 230, [
  rect(20, 20, 150, 90, { fill: grad("radial", RAINBOW) }),
  rect(185, 20, 150, 90, { fill: grad("radial", [["#FFFFFF", 0], ["#18181B", 1]], { center: { x: 0.25, y: 0.3 } }) }),
  rect(350, 20, 150, 90, { fill: grad("radial", [["#F97316", 0], ["#F9731600", 1]], { size: { width: 0.6, height: 1.4 } }) }),
  ell(20, 125, 150, 90, { fill: grad("radial", [["#FDE68A", 0], ["#B45309", 0.7], ["#451A03", 1]]) }),
  rect(185, 125, 150, 90, { fill: grad("radial", [["#2563EB", 0], ["#2563EB", 0.5], ["#DBEAFE", 0.5], ["#DBEAFE", 1]], { center: { x: 0.5, y: 0.5 }, size: { width: 0.8, height: 0.8 } }) }),
  rect(350, 125, 150, 90, { cornerRadius: 24, fill: grad("radial", [["#EC4899", 0], ["#8B5CF6", 1]], { center: { x: 1, y: 1 }, size: { width: 2, height: 2 } }) }),
]);
fixture("gradient-angular", 520, 230, [
  rect(20, 20, 150, 90, { fill: grad("angular", RAINBOW) }),
  rect(185, 20, 150, 90, { fill: grad("angular", RAINBOW, { rotation: 90 }) }),
  rect(350, 20, 150, 90, { fill: grad("angular", [["#18181B", 0], ["#18181B", 0.25], ["#F4F4F5", 0.25], ["#F4F4F5", 0.5], ["#EF4444", 0.5], ["#EF4444", 1]]) }),
  ell(20, 125, 90, 90, { fill: grad("angular", [["#22C55E", 0], ["#22C55E00", 1]], { rotation: -45 }) }),
  rect(185, 125, 150, 90, { fill: grad("angular", [["#3B82F6", 0], ["#FACC15", 0.5], ["#3B82F6", 1]], { center: { x: 0.3, y: 0.7 } }) }),
  rect(350, 125, 150, 90, { cornerRadius: 45, fill: grad("angular", RAINBOW, { rotation: 200, opacity: 0.6 }) }),
]);

// ---------------------------------------------------------------- strokes and radii

fixture("stroke-align", 520, 330, [
  ...(["inner", "center", "outer"] as const).flatMap((a, row) => [
    rect(24, 24 + row * 100, 90, 70, { fill: "#DBEAFE", stroke: "#1D4ED8", strokeWidth: 1, strokeAlignment: a }),
    rect(134, 24 + row * 100, 90, 70, { fill: "#DBEAFE", stroke: "#1D4ED8", strokeWidth: 6, strokeAlignment: a }),
    rect(244, 24 + row * 100, 90, 70, { fill: "#DBEAFE", stroke: "#1D4ED880", strokeWidth: 8, strokeAlignment: a, cornerRadius: 18 }),
    ell(354, 24 + row * 100, 70, 70, { fill: "#FEE2E2", stroke: "#B91C1C", strokeWidth: 5, strokeAlignment: a }),
    rect(444.5, 24.5 + row * 100, 50, 70, { stroke: "#18181B", strokeWidth: 1.5, strokeAlignment: a, cornerRadius: 6 }),
  ]),
]);
fixture("stroke-sides", 520, 230, [
  rect(24, 24, 140, 80, { fill: "#F4F4F5", stroke: "#18181B", strokeWidth: { top: 1, right: 4, bottom: 8, left: 2 }, strokeAlignment: "inner" }),
  rect(190, 24, 140, 80, { fill: "#F4F4F5", stroke: "#DC2626", strokeWidth: { top: 0, right: 0, bottom: 3, left: 0 }, strokeAlignment: "inner" }),
  rect(356, 24, 140, 80, { fill: "#F4F4F5", stroke: "#2563EB", strokeWidth: { top: 6, right: 2, bottom: 6, left: 2 }, strokeAlignment: "outer", cornerRadius: 16 }),
  rect(24, 130, 140, 80, { fill: "#FFFFFF", stroke: grad("linear", RAINBOW, { rotation: 90 }), strokeWidth: 6, strokeAlignment: "inner", cornerRadius: 20 }),
  rect(190, 130, 140, 80, { fill: "#FFFFFF", stroke: grad("linear", [["#7C3AED", 0], ["#EC4899", 1]], { rotation: 45 }), strokeWidth: 4, strokeAlignment: "center", cornerRadius: [30, 4, 30, 4] }),
  ell(356, 130, 140, 80, { fill: "#FFFFFF", stroke: grad("angular", RAINBOW), strokeWidth: 8, strokeAlignment: "outer" }),
]);
fixture("stroke-vector", 520, 230, [
  { type: "path", id: "p1", x: 24, y: 24, width: 120, height: 70, geometry: "M0 60 L30 0 L60 60 L90 0 L120 60", viewBox: [0, 0, 120, 70], stroke: "#18181B", strokeWidth: 6, strokeLinecap: "butt", strokeLinejoin: "miter" },
  { type: "path", id: "p2", x: 174, y: 24, width: 120, height: 70, geometry: "M0 60 L30 0 L60 60 L90 0 L120 60", viewBox: [0, 0, 120, 70], stroke: "#DC2626", strokeWidth: 6, strokeLinecap: "round", strokeLinejoin: "round" },
  { type: "path", id: "p3", x: 324, y: 24, width: 120, height: 70, geometry: "M0 60 L30 0 L60 60 L90 0 L120 60", viewBox: [0, 0, 120, 70], stroke: "#2563EB", strokeWidth: 6, strokeLinecap: "square", strokeLinejoin: "bevel" },
  { type: "path", id: "p4", x: 24, y: 130, width: 120, height: 80, geometry: "M10 40 C10 0 110 0 110 40 S10 80 10 40 Z M40 40 A20 12 0 1 0 80 40 A20 12 0 1 0 40 40 Z", viewBox: [0, 0, 120, 80], fill: "#FDE68A", fillRule: "evenodd", stroke: "#92400E", strokeWidth: 2 },
  { type: "polygon", id: "g1", x: 174, y: 130, width: 80, height: 80, polygonCount: 3, fill: "#BBF7D0", stroke: "#15803D", strokeWidth: 3 },
  { type: "polygon", id: "g2", x: 274, y: 130, width: 80, height: 80, polygonCount: 6, fill: "#BFDBFE", stroke: "#1D4ED8", strokeWidth: 3 },
  { type: "polygon", id: "g3", x: 374, y: 130, width: 120, height: 80, polygonCount: 5, fill: grad("linear", RAINBOW, { rotation: 90 }) },
]);
fixture("radius-uniform", 520, 230, [
  ...[0, 2, 4, 8, 16, 40].map((r, i) => rect(20 + i * 82, 20, 70, 70, { fill: "#18181B", cornerRadius: r })),
  rect(20, 110, 200, 44, { fill: "#2563EB", cornerRadius: 999 }),
  rect(240, 110, 44, 100, { fill: "#DC2626", cornerRadius: 999 }),
  rect(304, 110, 90, 50, { fill: "#16A34A", cornerRadius: 30 }),
  rect(410, 110, 90.5, 50.5, { fill: "#F4F4F5", cornerRadius: 12.5, stroke: "#18181B", strokeWidth: 1, strokeAlignment: "inner" }),
  rect(20, 170, 200, 40, { fill: grad("linear", RAINBOW, { rotation: 90 }), cornerRadius: 10 }),
]);
fixture("radius-per-corner", 520, 230, [
  rect(20, 20, 110, 80, { fill: "#18181B", cornerRadius: [24, 0, 0, 0] }),
  rect(145, 20, 110, 80, { fill: "#18181B", cornerRadius: [0, 24, 0, 24] }),
  rect(270, 20, 110, 80, { fill: "#18181B", cornerRadius: [40, 8, 40, 8] }),
  rect(395, 20, 110, 80, { fill: "#18181B", cornerRadius: [80, 80, 0, 0] }),
  rect(20, 120, 110, 80, { fill: "#DBEAFE", stroke: "#1D4ED8", strokeWidth: 4, strokeAlignment: "inner", cornerRadius: [30, 2, 16, 8] }),
  rect(145, 120, 110, 80, { fill: "#DBEAFE", stroke: "#1D4ED8", strokeWidth: 4, strokeAlignment: "outer", cornerRadius: [30, 2, 16, 8] }),
  rect(270, 120, 110, 80, { fill: "#FFFFFF", cornerRadius: [30, 2, 16, 8], effect: [shadow(0, 6, 14, "#00000055")] }),
  frame(395, 120, 110, 80, [rect(-10, -10, 70, 60, { fill: "#EF4444" }), ell(50, 30, 80, 70, { fill: "#3B82F6" })], { fill: "#FDE68A", clip: true, cornerRadius: [36, 0, 36, 0] }),
]);

// ---------------------------------------------------------------- clipping, opacity, blend

fixture("clip", 520, 230, [
  frame(20, 20, 140, 90, [rect(-20, -20, 80, 70, { fill: "#EF4444" }), rect(90, 50, 80, 70, { fill: "#3B82F6" }), text(10, 34, "Clipped text runs out", { fontSize: 20, fontWeight: "700" })], { fill: "#F4F4F5", clip: true }),
  frame(180, 20, 140, 90, [rect(-20, -20, 80, 70, { fill: "#EF4444" }), rect(90, 50, 80, 70, { fill: "#3B82F6" }), ell(40, 20, 120, 120, { fill: "#22C55E99" })], { fill: "#F4F4F5", clip: true, cornerRadius: 28 }),
  frame(340, 20, 140, 90, [rect(-20, -20, 80, 70, { fill: "#EF4444" }), rect(90, 50, 80, 70, { fill: "#3B82F6" })], { fill: "#F4F4F5", clip: false }),
  frame(20, 125, 200, 90, [frame(30, -20, 120, 90, [rect(-30, 20, 200, 30, { fill: "#A855F7" }), ell(60, 40, 90, 90, { fill: "#FACC15" })], { fill: "#BBF7D0", clip: true, cornerRadius: 20 })], { fill: "#E4E4E7", clip: true, cornerRadius: 12 }),
  frame(260, 125, 110, 90, [rect(30, -10, 60, 120, { fill: "#F97316", rotation: -20 })], { fill: "#F4F4F5", clip: true, cornerRadius: 45 }),
  frame(390, 125, 110, 90, [rect(10, 10, 140, 120, { fill: img("pattern.png", "cover") })], { fill: "#F4F4F5", clip: true, cornerRadius: [0, 40, 0, 40], stroke: "#18181B", strokeWidth: 2, strokeAlignment: "inner" }),
]);
fixture("opacity", 520, 230, [
  rect(20, 20, 100, 80, { fill: "#2563EB", opacity: 0.5 }),
  rect(70, 50, 100, 80, { fill: "#DC2626", opacity: 0.5 }),
  // Group opacity: the overlap must not darken (the group is flattened first).
  frame(200, 20, 150, 110, [rect(0, 0, 100, 80, { fill: "#2563EB" }), rect(50, 30, 100, 80, { fill: "#DC2626" })], { opacity: 0.5 }),
  { type: "group", id: "grp", x: 370, y: 20, opacity: 0.4, children: [ell(0, 0, 80, 80, { fill: "#16A34A" }), ell(40, 30, 80, 80, { fill: "#18181B" })] },
  frame(20, 145, 220, 70, [text(12, 10, "Text at 60%", { fontSize: 22, fontWeight: "600" }), rect(150, 10, 50, 50, { fill: "#FACC15", stroke: "#18181B", strokeWidth: 4, strokeAlignment: "center" })], { fill: "#E0E7FF", opacity: 0.6, cornerRadius: 12 }),
  frame(260, 145, 240, 70, [frame(10, 10, 220, 50, [rect(10, 10, 200, 30, { fill: "#18181B", opacity: 0.5 })], { fill: "#EF4444", opacity: 0.5 })], { fill: "#FFFFFF", opacity: 0.8, stroke: "#18181B", strokeWidth: 1 }),
  rect(410, 100, 90, 40, { fill: grad("linear", RAINBOW, { rotation: 90 }), opacity: 0.35 }),
]);
fixture("blend-fill", 400, 140, [
  rect(20, 20, 110, 100, { fill: ["#FACC15", { type: "color", color: "#2563EB", blendMode: "multiply" }] }),
  rect(145, 20, 110, 100, { fill: ["#7C3AED", { type: "color", color: "#22C55E", blendMode: "screen" }] }),
  rect(270, 20, 110, 100, { fill: [grad("linear", RAINBOW, { rotation: 90 }), { type: "gradient", gradientType: "linear", rotation: 0, blendMode: "overlay", colors: [{ color: "#000000", position: 0 }, { color: "#FFFFFF", position: 1 }] }] }),
], { note: "A blend mode per fill: the engine mixes each paint in its own layer, the DOM renderer with background-blend-mode (which only blends with the paints of the same box, so the two may differ where the box is translucent)." });

// Fills: image modes, a blended layer, corner smoothing and a mask (docs/evidence/fills.md).
fixture("fill-modes", 560, 160, [
  rect(20, 20, 100, 120, { fill: img("pattern.png", "crop", { crop: { x: -0.5, y: -0.25, width: 2, height: 1.5 } }) }),
  rect(140, 20, 100, 120, { fill: img("pattern.png", "tile", { scale: 0.25 }) }),
  rect(260, 20, 120, 100, { fill: img("pattern.png", "fill", { rotation: 90 }) }),
  rect(400, 20, 140, 120, { fill: "#2563EB", cornerRadius: 40, cornerSmoothing: 0.6 }),
], { note: "Crop, Tile and Rotate 90 in the engine and the DOM renderer; corner smoothing is engine-only (the DOM draws a circular corner)." });
fixture("mask", 400, 160, [
  rect(0, 0, 400, 160, { fill: "#E4E4E7" }),
  ell(20, 20, 160, 120, { fill: "#000000", mask: true }),
  rect(0, 0, 400, 160, { fill: grad("linear", RAINBOW, { rotation: 90 }) }),
  rect(220, 20, 160, 120, { fill: "#18181B", cornerRadius: 24, blendMode: "multiply" }),
], { note: "Use as mask: the ellipse cuts the layers above it; the grey under it shows outside." });

// ---------------------------------------------------------------- shadows and blur

fixture("shadow-drop", 560, 280, [
  rect(30, 30, 100, 70, { fill: "#FFFFFF", effect: [shadow(0, 2, 4, "#00000040")] }),
  rect(160, 30, 100, 70, { fill: "#FFFFFF", cornerRadius: 12, effect: [shadow(0, 10, 30, "#00000059")] }),
  rect(290, 30, 100, 70, { fill: "#FFFFFF", cornerRadius: 12, effect: [shadow(8, 8, 0, "#2563EB")] }),
  rect(420, 30, 100, 70, { fill: "#FFFFFF", cornerRadius: 12, effect: [shadow(0, 0, 12, "#DC2626CC", { spread: 6 })] }),
  ell(30, 160, 90, 90, { fill: "#FDE68A", effect: [shadow(0, 12, 24, "#92400E80")] }),
  rect(160, 160, 100, 70, { fill: "#FFFFFF", cornerRadius: [30, 4, 30, 4], effect: [shadow(0, 8, 20, "#00000066")] }),
  rect(290, 160, 100, 70, { fill: "#FFFFFF", cornerRadius: 35, effect: [shadow(0, 1, 2, "#0000004D"), shadow(0, 12, 32, "#7C3AED80", { spread: -4 })] }),
  rect(420, 160, 100, 70, { fill: "#18181B80", cornerRadius: 8, effect: [shadow(-10, 10, 6, "#16A34A")] }),
], { fill: "#F4F4F5" });
const inner = (x: number, y: number, blur: number, color: string, o: N = {}) => shadow(x, y, blur, color, { shadowType: "inner", ...o });
fixture("shadow-inner", 560, 150, [
  rect(30, 30, 100, 90, { fill: "#FFFFFF", effect: [inner(0, 2, 6, "#00000066")] }),
  rect(160, 30, 100, 90, { fill: "#DBEAFE", cornerRadius: 20, effect: [inner(6, 6, 0, "#1D4ED8")] }),
  rect(290, 30, 100, 90, { fill: "#FDE68A", cornerRadius: 45, effect: [inner(0, 0, 16, "#92400ECC", { spread: 4 })] }),
  ell(420, 30, 90, 90, { fill: "#FFFFFF", effect: [inner(0, -8, 12, "#00000080"), shadow(0, 4, 10, "#00000040")] }),
], { fill: "#F4F4F5" });
fixture("shadow-text-vector", 560, 150, [
  text(24, 24, "Shadow", { fontSize: 44, fontWeight: "800", fill: "#18181B", effect: [shadow(0, 4, 8, "#2563EBB3")] }),
  text(24, 90, "Hard offset", { fontSize: 24, fontWeight: "600", fill: "#FFFFFF", effect: [shadow(2, 2, 0, "#18181B")] }),
  { type: "icon", id: "ic1", x: 260, y: 30, width: 72, height: 72, library: "lucide", icon: "heart", fill: "#DC2626", effect: [shadow(0, 6, 10, "#DC262680")] },
  { type: "path", id: "ps", x: 360, y: 30, width: 80, height: 80, geometry: "M40 0 L50 30 L80 30 L56 48 L66 80 L40 60 L14 80 L24 48 L0 30 L30 30 Z", viewBox: [0, 0, 80, 80], fill: "#FACC15", effect: [shadow(0, 6, 12, "#00000073")] },
  { type: "polygon", id: "pg", x: 460, y: 30, width: 80, height: 80, polygonCount: 6, fill: "#22C55E", effect: [shadow(6, 6, 0, "#14532D")] },
], { fill: "#F4F4F5" });
fixture("blur-layer", 560, 260, [
  rect(30, 30, 90, 70, { fill: "#2563EB", effect: [{ type: "blur", radius: 4 }] }),
  rect(160, 30, 90, 70, { fill: "#2563EB", effect: [{ type: "blur", radius: 12 }] }),
  rect(290, 30, 90, 70, { fill: "#2563EB", cornerRadius: 20, effect: [{ type: "blur", radius: 24 }] }),
  ell(420, 30, 90, 70, { fill: grad("linear", RAINBOW, { rotation: 90 }), effect: [{ type: "blur", radius: 16 }] }),
  text(30, 150, "Blurred text", { fontSize: 36, fontWeight: "700", effect: [{ type: "blur", radius: 6 }] }),
  frame(300, 140, 220, 90, [rect(10, 10, 60, 70, { fill: "#EF4444" }), rect(80, 10, 60, 70, { fill: "#22C55E" }), text(150, 30, "Aa", { fontSize: 32, fontWeight: "700" })], { fill: "#FDE68A", cornerRadius: 12, effect: [{ type: "blur", radius: 8 }] }),
]);
fixture("blur-background", 560, 220, [
  ...[0, 1, 2, 3, 4, 5, 6].map((i) => rect(i * 80, 0, 80, 220, { fill: ["#EF4444", "#FACC15", "#22C55E", "#14B8A6", "#3B82F6", "#A855F7", "#18181B"][i] })),
  text(20, 86, "Sharp text under the glass panels", { fontSize: 30, fontWeight: "800", fill: "#FFFFFF" }),
  frame(40, 30, 140, 160, [], { fill: "#FFFFFF33", cornerRadius: 20, effect: [{ type: "background_blur", radius: 8 }] }),
  frame(210, 30, 140, 160, [text(16, 16, "Glass", { fontSize: 20, fontWeight: "700", fill: "#FFFFFF" })], { fill: "#FFFFFF4D", cornerRadius: 20, stroke: "#FFFFFF99", strokeWidth: 1, strokeAlignment: "inner", effect: [{ type: "background_blur", radius: 24 }] }),
  frame(380, 30, 140, 160, [], { fill: "#00000033", cornerRadius: [60, 8, 60, 8], effect: [{ type: "background_blur", radius: 48 }, shadow(0, 8, 24, "#00000066")] }),
]);

// ---------------------------------------------------------------- images

fixture("image-fit", 600, 380, [
  ...(["cover", "contain", "stretch"] as const).flatMap((m, i) => [
    rect(20 + i * 195, 20, 170, 80, { fill: ["#E4E4E7", img("pattern.png", m)] }),
    rect(20 + i * 195, 115, 70, 130, { fill: ["#E4E4E7", img("pattern.png", m)] }),
    rect(105 + i * 195, 115, 85, 130, { fill: ["#E4E4E7", img("pattern.png", m)], cornerRadius: 24 }),
  ]),
  ell(20, 265, 100, 100, { fill: img("pattern.png", "cover") }),
  rect(140, 265, 150, 100, { fill: ["#FDE68A", img("alpha.png", "contain")] }),
  rect(310, 265, 130, 100, { fill: ["#18181B", img("alpha.png", "cover", { opacity: 0.5 })], cornerRadius: 12 }),
  rect(460, 265, 120, 100, { fill: img("pattern.png"), stroke: "#18181B", strokeWidth: 3, strokeAlignment: "inner", cornerRadius: 16 }),
], { note: "The format has no tile mode (cover, contain, stretch only), so tiling has no fixture." });
fixture("image-minify", 640, 330, [
  rect(20, 20, 400, 300, { fill: img("fine.png", "cover") }),
  rect(440, 20, 180, 135, { fill: img("fine.png", "cover") }),
  rect(440, 175, 90, 67.5, { fill: img("fine.png", "cover") }),
  rect(540, 175, 48, 36, { fill: img("fine.png", "cover") }),
  rect(540, 220, 24, 18, { fill: img("fine.png", "cover") }),
  rect(440, 260, 180, 60, { fill: img("pattern.png", "cover") }),
], { views: [{ name: "1x", zoom: 1, dpr: 1 }, { name: "0.33x@2", zoom: 0.33, dpr: 2 }, { name: "3x", zoom: 3, dpr: 1, x: 420, y: 160, w: 480, h: 360 }] });

// ---------------------------------------------------------------- text

const PANGRAM = "Sphinx of black quartz, judge my vow 0123456789";
const SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 32, 48, 64, 96];
function sizeLadder(family: string): N[] {
  const out: N[] = [];
  let y = 16;
  for (const s of SIZES) {
    out.push(text(20, y, s >= 48 ? "Hamburgefonstiv 96" : PANGRAM, { fontFamily: family, fontSize: s }));
    y += Math.ceil(s * 1.3) + 6;
  }
  return out;
}
const TEXT_VIEWS: View[] = [{ name: "1x", zoom: 1, dpr: 1 }, { name: "1x@2", zoom: 1, dpr: 2 }];
// Fixtures about where lines break and sit, not how glyphs look: one device scale is enough (baselines stay under 5 MB).
const LAYOUT_VIEWS: View[] = [{ name: "1x", zoom: 1, dpr: 1 }];
fixture("text-inter-sizes", 940, 560, sizeLadder("Inter"), { views: TEXT_VIEWS });
fixture("text-sf-sizes", 940, 560, sizeLadder("SF Pro"), { views: TEXT_VIEWS });
fixture("text-weights", 760, 420, [
  ...["100", "200", "300", "400", "500", "600", "700", "800", "900"].flatMap((w, i) => [
    text(20, 16 + i * 30, `Inter ${w} Handgloves`, { fontSize: 20, fontWeight: w }),
    text(270, 16 + i * 30, `SF Pro ${w} Handgloves`, { fontFamily: "SF Pro", fontSize: 20, fontWeight: w }),
    text(540, 20 + i * 30, `Small ${w} text 11px`, { fontSize: 11, fontWeight: w }),
  ]),
  text(20, 300, "Inter italic 400, the quick brown fox", { fontSize: 20, fontStyle: "italic" }),
  text(20, 332, "Inter italic 700, the quick brown fox", { fontSize: 20, fontStyle: "italic", fontWeight: "700" }),
  text(20, 364, "SF Pro italic 500, the quick brown fox", { fontFamily: "SF Pro", fontSize: 20, fontStyle: "italic", fontWeight: "500" }),
  text(420, 300, "bold keyword", { fontSize: 20, fontWeight: "bold" }),
  text(420, 332, "Dark on colour", { fontSize: 20, fontWeight: "600", fill: "#FFFFFF" }),
], { views: TEXT_VIEWS });
const auto = (family: string, size: number) => Math.round(autoTracking(family, size).px * 1000) / 1000;
fixture("text-letter-spacing", 760, 470, [
  ...[-1.5, -0.5, 0, 0.5, 2, 6].map((ls, i) => text(20, 16 + i * 30, `Letter spacing ${ls}px AVATAR Toy`, { fontSize: 18, letterSpacing: ls })),
  ...[9, 11, 13, 16, 20, 28, 40].map((s, i) => text(20, 206 + [0, 16, 34, 54, 78, 106, 142][i], `Inter auto ${s}px (${auto("Inter", s)})`, { fontSize: s, letterSpacing: auto("Inter", s) })),
  ...[9, 11, 13, 17, 20, 28, 40].map((s, i) => text(400, 206 + [0, 16, 34, 54, 78, 106, 142][i], `SF auto ${s}px (${auto("SF Pro", s)})`, { fontFamily: "SF Pro", fontSize: s, letterSpacing: auto("SF Pro", s) })),
  text(400, 16, "Wrapped text with wide tracking keeps its line breaks where Chrome puts them", { fontSize: 16, letterSpacing: 3, textGrowth: "fixed-width", width: 330 }),
  text(400, 110, "Centered tracked", { fontSize: 16, letterSpacing: 4, textGrowth: "fixed-width", width: 330, textAlign: "center" }),
  text(400, 140, "Right tracked", { fontSize: 16, letterSpacing: 4, textGrowth: "fixed-width", width: 330, textAlign: "right" }),
], { views: TEXT_VIEWS, note: "Auto tracking is stored as a plain letterSpacing number; the values here come from src/tracking.ts autoTracking()." });
const LOREM = "Design tools draw the same paragraph a thousand times a day. Line height decides where every baseline sits, so a rounding slip moves the whole block.";
fixture("text-line-height", 760, 400, [
  ...[1, 1.2, 1.5, 2].map((lh, i) => frame(20 + i * 185, 16, 170, undefined, [text(0, 0, LOREM, { fontSize: 13, lineHeight: lh, textGrowth: "fixed-width", width: "fill_container" })], { layout: "vertical", fill: "#F4F4F5" })),
  text(20, 330, "No line height, 13px", { fontSize: 13 }),
  text(200, 318, "No line height, 28px", { fontSize: 28 }),
  rect(520, 322, 220, 24, { fill: "#2563EB" }),
  text(520, 322, "lineHeight 1, 24px", { fontSize: 24, lineHeight: 1, fill: "#FFFFFF" }),
  text(520, 356, "SF lineHeight 1.25", { fontFamily: "SF Pro", fontSize: 17, lineHeight: 1.25 }),
], { views: LAYOUT_VIEWS });
fixture("text-align", 760, 330, [
  ...(["left", "center", "right", "justify"] as const).map((a, i) => text(20 + i * 185, 16, LOREM, { fontSize: 12, lineHeight: 1.4, textAlign: a, textGrowth: "fixed-width", width: 170 })),
  ...(["top", "middle", "bottom"] as const).flatMap((v, i) => [
    rect(20 + i * 245, 200, 230, 110, { fill: "#F4F4F5" }),
    text(20 + i * 245, 200, `Vertical ${v}\nsecond line`, { fontSize: 16, textAlign: (["left", "center", "right"] as const)[i], textAlignVertical: v, textGrowth: "fixed-width-height", width: 230, height: 110 }),
  ]),
], { views: LAYOUT_VIEWS });
fixture("text-wrap", 760, 330, [
  rect(20, 16, 160, 300, { fill: "#F4F4F5" }),
  text(20, 16, "Wrapping breaks at spaces, hyphen-ated words and aVeryLongUnbreakableIdentifierThatMustBreakAnywhere when it has to.", { fontSize: 15, textGrowth: "fixed-width", width: 160 }),
  rect(200, 16, 160, 300, { fill: "#F4F4F5" }),
  text(200, 16, "Explicit\nnew lines\n\nand a blank line, then   several   spaces   kept.", { fontSize: 15, textGrowth: "fixed-width", width: 160 }),
  rect(380, 16, 160, 80, { fill: "#F4F4F5" }),
  text(380, 16, "Fixed height box: this paragraph is longer than its 80px box, so the lines below the edge overflow it.", { fontSize: 15, textGrowth: "fixed-width-height", width: 160, height: 80 }),
  rect(560, 16, 180, 300, { fill: "#F4F4F5" }),
  text(560, 16, "Auto width never wraps", { fontSize: 15 }),
  text(560, 50, "Größe naïve café Ærø Łódź São Paulo 東京 emoji-free", { fontSize: 15, textGrowth: "fixed-width", width: 180 }),
  text(560, 130, "fi fl ffi ligatures, 1/2 3/4, “quotes” – dashes… 10×20", { fontSize: 15, textGrowth: "fixed-width", width: 180 }),
  text(560, 220, "SF wraps too: the system font measures words with its own metrics and optical sizes.", { fontFamily: "SF Pro", fontSize: 15, textGrowth: "fixed-width", width: 180 }),
], { views: LAYOUT_VIEWS, note: "The format has no truncation or ellipsis property; a fixed-width-height box overflows in both renderers." });
fixture("text-decoration", 760, 200, [
  text(20, 16, "Underlined text with descenders gjpqy", { fontSize: 22, underline: true }),
  text(20, 52, "Struck through text", { fontSize: 22, strikethrough: true }),
  text(20, 88, "Both at once, 13px", { fontSize: 13, underline: true, strikethrough: true }),
  text(20, 120, "Gradient text", { fontSize: 44, fontWeight: "800", fill: grad("linear", RAINBOW, { rotation: 90 }) }),
  text(400, 16, "Outlined", { fontSize: 56, fontWeight: "800", fill: "#FDE68A", stroke: "#18181B", strokeWidth: 2 }),
  text(400, 100, "Half opaque", { fontSize: 36, fontWeight: "700", fill: "#2563EB80" }),
  text(400, 150, "SF underlined", { fontFamily: "SF Pro", fontSize: 24, underline: true }),
], { views: TEXT_VIEWS });

// ---------------------------------------------------------------- layout, nesting, components

const chip = (label: string, o: N = {}) => frame(0, 0, undefined, undefined, [text(0, 0, label, { fontSize: 12, fontWeight: "600", fill: "#1E3A8A" })], { layout: "horizontal", padding: [4, 10], fill: "#DBEAFE", cornerRadius: 999, ...o });
const box = (w: number | string, h: number | string, fill: string, o: N = {}) => ({ type: "rectangle", id: id("r"), width: w, height: h, fill, ...o });
fixture("layout-auto", 760, 420, [
  ...(["start", "center", "end", "space_between", "space_around"] as const).map((j, i) => frame(20, 16 + i * 50, 340, 40, [box(40, 20, "#EF4444"), box(60, 28, "#22C55E"), box(30, 12, "#3B82F6")], { layout: "horizontal", gap: 8, padding: 6, justifyContent: j, alignItems: (["start", "center", "end", "center", "start"] as const)[i], fill: "#F4F4F5" })),
  frame(380, 16, 110, 240, [box(40, 30, "#EF4444"), box("fill_container", 30, "#22C55E"), box(60, "fill_container", "#3B82F6"), box(20, 20, "#18181B")], { layout: "vertical", gap: 10, padding: [12, 8], alignItems: "center", fill: "#F4F4F5" }),
  frame(510, 16, 230, 60, [box(40, "fill_container", "#EF4444"), box("fill_container", "fill_container", "#22C55E"), box("fill_container", 20, "#3B82F6")], { layout: "horizontal", gap: 6, padding: [6, 12, 18, 24], fill: "#F4F4F5" }),
  frame(510, 90, undefined, undefined, [chip("Fit"), chip("content"), chip("hugs its chips")], { layout: "horizontal", gap: 6, padding: 8, fill: "#F4F4F5", cornerRadius: 12 }),
  frame(510, 150, 230, undefined, [text(0, 0, "A vertical stack with wrapped text takes the height its lines need.", { fontSize: 13, textGrowth: "fixed-width", width: "fill_container" }), chip("Chip below"), box("fill_container", 1, "#A1A1AA")], { layout: "vertical", gap: 8, padding: 12, fill: "#F4F4F5", cornerRadius: 12 }),
  frame(20, 280, 340, 120, [box(60, 60, "#A855F7"), { ...box(40, 40, "#18181B"), layoutPosition: "absolute", x: 280, y: 60 }, box(60, 60, "#F97316"), frame(0, 0, "fill_container", "fill_container", [box(20, 20, "#FFFFFF")], { layout: "vertical", justifyContent: "end", alignItems: "end", padding: 6, fill: "#14B8A6" })], { layout: "horizontal", gap: 12, padding: 16, alignItems: "end", fill: "#F4F4F5", stroke: "#18181B", strokeWidth: 1, strokeAlignment: "inner" }),
  frame(380, 280, 360, 120, [text(0, 0, "Left", { fontSize: 20 }), text(0, 0, "Middle grows", { fontSize: 14, textGrowth: "fixed-width", width: "fill_container", textAlign: "center" }), text(0, 0, "Right", { fontSize: 28, fontWeight: "700" })], { layout: "horizontal", gap: 12, padding: 16, alignItems: "center", fill: "#FEF3C7" }),
]);
// Canvas-only auto layout: keys in metadata.canvasLayout (and layoutIncludeStroke, negative gap) that html.ts ignores.
const cl = (canvasLayout: N): N => ({ metadata: { type: "canvas", canvasLayout } });
const flow = (x: number, y: number, w: number | string | undefined, h: number | string | undefined, children: N[], o: N = {}) => frame(x, y, w, h, children, { layout: "horizontal", fill: "#F4F4F5", ...o });
fixture("layout-extras", 760, 470, [
  flow(20, 20, undefined, undefined, [box(50, 30, "#EF4444")], { padding: 8, ...cl({ minWidth: 200 }) }),
  flow(20, 80, 300, 46, [box("fill_container", 30, "#EF4444", cl({ maxWidth: 100 })), box("fill_container", 30, "#22C55E")], { padding: 8 }),
  flow(20, 146, 330, undefined, Array.from({ length: 6 }, (_, i) => box(100, 40, ["#EF4444", "#22C55E", "#3B82F6", "#FACC15", "#A855F7", "#14B8A6"][i])), { gap: 10, ...cl({ wrap: true, crossGap: 20 }) }),
  flow(20, 270, 220, 160, Array.from({ length: 4 }, (_, i) => box(100, 40, ["#EF4444", "#22C55E", "#3B82F6", "#FACC15"][i])), { gap: 10, padding: 0, ...cl({ wrap: true, crossGap: 20, crossAuto: true }) }),
  flow(260, 270, 80, 110, Array.from({ length: 3 }, (_, i) => box(30, 50, ["#EF4444", "#22C55E", "#3B82F6"][i])), { layout: "vertical", gap: 5, ...cl({ wrap: true, crossGap: 8 }) }),
  flow(380, 20, 300, 50, [box(50, 30, "#EF4444"), box(50, 30, "#22C55E")], { justifyContent: "space_around", alignItems: "center", ...cl({ gapMode: "evenly" }) }),
  flow(380, 90, undefined, undefined, [text(0, 0, "Small 12", { fontSize: 12 }), text(0, 0, "Big 32", { fontSize: 32, fontWeight: "700" }), box(10, 10, "#3B82F6"), text(0, 0, "Mid 18", { fontSize: 18 })], { gap: 8, padding: 8, alignItems: "end", ...cl({ baseline: true }) }),
  flow(380, 170, undefined, undefined, [ell(0, 0, 60, 60, { fill: "#EF4444" }), ell(0, 0, 60, 60, { fill: "#22C55E" }), ell(0, 0, 60, 60, { fill: "#3B82F6" })], { gap: -20, padding: 8, ...cl({ stacking: "first" }) }),
  flow(560, 170, undefined, undefined, [ell(0, 0, 60, 60, { fill: "#EF4444" }), ell(0, 0, 60, 60, { fill: "#22C55E" }), ell(0, 0, 60, 60, { fill: "#3B82F6" })], { gap: -20, padding: 8 }),
  flow(380, 260, undefined, undefined, [box(40, 40, "#A855F7")], { padding: 10, stroke: "#18181B", strokeWidth: 4, strokeAlignment: "inner", layoutIncludeStroke: true }),
  flow(460, 260, undefined, undefined, [box(40, 40, "#A855F7")], { padding: 10, stroke: "#18181B", strokeWidth: 4, strokeAlignment: "inner" }),
  flow(540, 260, undefined, undefined, [frame(0, 0, "fill_container", "fill_container", [box(60, 30, "#F97316")], { layout: "horizontal", fill: "#FED7AA" }), box(30, 50, "#18181B")], { gap: 10, padding: 8 }),
], { note: "Canvas-only auto layout (wrap, min/max, evenly, baseline, first on top, negative gap, included stroke, hug with a fill child): html.ts draws without these, so fidelity is a known gap and the regression baseline is the check." });
const card = (x: number, y: number, title: string, o: N = {}) => frame(x, y, 220, undefined, [
  frame(0, 0, "fill_container", 72, [ell(0, 0, 40, 40, { fill: grad("linear", [["#7C3AED", 0], ["#EC4899", 1]], { rotation: 45 }) })], { layout: "horizontal", padding: 16, alignItems: "center", fill: img("pattern.png", "cover"), clip: true }),
  frame(0, 0, "fill_container", undefined, [
    text(0, 0, title, { fontSize: 16, fontWeight: "700" }),
    text(0, 0, "Nested frames inside nested frames, each with its own padding and gap.", { fontSize: 12, lineHeight: 1.4, fill: "#52525B", textGrowth: "fixed-width", width: "fill_container" }),
    frame(0, 0, "fill_container", undefined, [chip("One"), chip("Two"), frame(0, 0, "fill_container", 1, [], {}), { type: "icon", id: id("i"), library: "lucide", icon: "arrow-right", width: 16, height: 16, fill: "#18181B" }], { layout: "horizontal", gap: 6, alignItems: "center" }),
  ], { layout: "vertical", gap: 8, padding: 16 }),
], { layout: "vertical", fill: "#FFFFFF", cornerRadius: 16, clip: true, effect: [shadow(0, 6, 20, "#00000026")], ...o });
fixture("nested-frames", 760, 300, [
  card(24, 24, "Card title"),
  card(270, 24, "Rotated card", { rotation: 4 }),
  frame(520, 24, 216, 250, [frame(12, 12, 190, 220, [frame(12, 12, 160, 190, [frame(12, 12, 130, 160, [frame(12, 12, 100, 130, [text(10, 10, "Depth 5", { fontSize: 14, fontWeight: "600", fill: "#FFFFFF" })], { fill: "#1E3A8A", cornerRadius: 6, clip: true })], { fill: "#1D4ED8", cornerRadius: 10, opacity: 0.9 })], { fill: "#3B82F6", cornerRadius: 14, clip: true })], { fill: "#93C5FD", cornerRadius: 18 })], { fill: "#DBEAFE", cornerRadius: 22, clip: true }),
], { fill: "#F4F4F5" });
fixture("components", 760, 240, [
  { type: "ref", id: "i1", ref: "Btn", x: 24, y: 24 },
  { type: "ref", id: "i2", ref: "Btn", x: 24, y: 80, fill: "#DC2626", descendants: { BtnLabel: { content: "Delete forever" } } },
  { type: "ref", id: "i3", ref: "Btn", x: 24, y: 136, cornerRadius: 4, fill: "#FFFFFF", stroke: "#18181B", strokeWidth: 1, descendants: { BtnLabel: { content: "Outline", fill: "#18181B" }, BtnIcon: { icon: "check", fill: "#18181B" } } },
  { type: "ref", id: "r1", ref: "Row", x: 240, y: 24 },
  { type: "ref", id: "r2", ref: "Row", x: 240, y: 96, width: 480, descendants: { RowTitle: { content: "A wider instance with an overridden title" }, "RowBtn/BtnLabel": { content: "Nested override" }, RowDot: { fill: "#22C55E" } } },
  { type: "ref", id: "r3", ref: "Row", x: 240, y: 168, opacity: 0.5, descendants: { RowBtn: { enabled: false } } },
], {
  fill: "#F4F4F5",
  extra: [{ type: "frame", id: "Lib", name: "Library", x: 900, y: 0, width: 500, height: 200, layout: "none", children: [
    { type: "frame", id: "Btn", reusable: true, x: 20, y: 20, layout: "horizontal", gap: 8, padding: [10, 16], alignItems: "center", fill: "#2563EB", cornerRadius: 10, children: [
      { type: "icon", id: "BtnIcon", library: "lucide", icon: "plus", width: 16, height: 16, fill: "#FFFFFF" },
      { type: "text", id: "BtnLabel", content: "Add item", fontFamily: "Inter", fontSize: 14, fontWeight: "600", fill: "#FFFFFF" }] },
    { type: "frame", id: "Row", reusable: true, x: 20, y: 100, width: 380, layout: "horizontal", gap: 12, padding: 12, alignItems: "center", fill: "#FFFFFF", cornerRadius: 12, effect: [shadow(0, 2, 8, "#0000001F")], children: [
      { type: "ellipse", id: "RowDot", width: 12, height: 12, fill: "#F97316" },
      { type: "text", id: "RowTitle", content: "Row component", fontFamily: "Inter", fontSize: 14, fontWeight: "500", fill: "#18181B", textGrowth: "fixed-width", width: "fill_container" },
      { type: "ref", id: "RowBtn", ref: "Btn" }] }] }],
});
fixture("variables-theme", 520, 150, [
  frame(20, 20, 230, 110, [text(16, 16, "Light theme", { fontSize: 20, fontWeight: "700", fill: "$fg" }), rect(16, 60, "$w" as any, 30, { fill: "$accent", cornerRadius: "$radius" })], { fill: "$bg", cornerRadius: "$radius", stroke: "$fg", strokeWidth: 1 }),
  frame(270, 20, 230, 110, [text(16, 16, "Dark theme", { fontSize: 20, fontWeight: "700", fill: "$fg" }), rect(16, 60, "$w" as any, 30, { fill: "$accent", cornerRadius: "$radius" })], { theme: { mode: "dark" }, fill: "$bg", cornerRadius: "$radius", stroke: "$fg", strokeWidth: 1 }),
], { doc: { themes: { mode: ["light", "dark"] }, variables: {
  bg: { type: "color", value: [{ value: "#FFFFFF" }, { value: "#18181B", theme: { mode: "dark" } }] },
  fg: { type: "color", value: [{ value: "#18181B" }, { value: "#FAFAFA", theme: { mode: "dark" } }] },
  accent: { type: "color", value: [{ value: "#2563EB" }, { value: "#FACC15", theme: { mode: "dark" } }] },
  radius: { type: "number", value: 14 }, w: { type: "number", value: [{ value: 120 }, { value: 180, theme: { mode: "dark" } }] } } } });
fixture("shapes", 600, 260, [
  ell(20, 20, 100, 100, { fill: "#2563EB", innerRadius: 0.6 }),
  ell(140, 20, 100, 100, { fill: "#DC2626", startAngle: 0, sweepAngle: 270 }),
  ell(260, 20, 100, 100, { fill: "#16A34A", innerRadius: 0.5, startAngle: 90, sweepAngle: 200, stroke: "#14532D", strokeWidth: 2 }),
  ell(380, 20, 140, 100, { fill: "#FACC15", startAngle: -30, sweepAngle: -120 }),
  ...["heart", "star", "settings", "arrow-up-right", "cloud", "search"].map((ic, i) => ({ type: "icon", id: `ic${i}`, x: 20 + i * 60, y: 150, width: 16 + i * 6, height: 16 + i * 6, library: "lucide", icon: ic, fill: ["#18181B", "#DC2626", "#2563EB", "#16A34A", "#7C3AED", "#F97316"][i] })),
  { type: "icon", id: "icw", x: 400, y: 150, width: 48, height: 48, library: "lucide", icon: "star", fill: "#18181B", weight: 100 },
  { type: "icon", id: "icw2", x: 460, y: 150, width: 48, height: 48, library: "lucide", icon: "star", fill: "#18181B", weight: 700 },
  rect(530, 150, 50, 50, { fill: "#A855F7", rotation: 30 }),
  rect(540, 30, 40, 60, { fill: img("pattern.png", "cover"), flipX: true }),
  { type: "path", id: "tight", x: 20, y: 215, width: 200, height: 30, geometry: "M100 200 C150 100 250 100 300 200 S450 300 500 200", stroke: "#18181B", strokeWidth: 3 },
]);

// ---------------------------------------------------------------- zoom and tiles

const zoomScene: N[] = [
  rect(0, 0, 1200, 160, { fill: grad("linear", [["#1E3A8A", 0], ["#7C3AED", 0.5], ["#EC4899", 1]], { rotation: 90 }) }),
  text(40, 36, "Zoom ladder", { fontSize: 72, fontWeight: "800", fill: "#FFFFFF", letterSpacing: -2 }),
  text(700, 60, "0.1x 0.33x 1x 2x 8x 32x", { fontFamily: "SF Pro", fontSize: 28, fontWeight: "500", fill: "#FFFFFFCC" }),
  ...Array.from({ length: 12 }, (_, i) => card(40 + (i % 4) * 285, 200 + Math.floor(i / 4) * 195, `Card ${i + 1}`, { width: 260 })),
  ...Array.from({ length: 40 }, (_, i) => rect(40 + i * 28, 790, 14, 1, { fill: "#18181B" })),
  ...Array.from({ length: 30 }, (_, i) => rect(40 + i * 6, 760, 1, 20, { fill: "#18181B" })),
  text(240, 758, "Hairlines and 9px text survive zooming out: Sphinx of black quartz", { fontSize: 9 }),
  ell(1040, 30, 100, 100, { fill: "#FACC15", stroke: "#FFFFFF", strokeWidth: 3, strokeAlignment: "outer", effect: [shadow(0, 8, 20, "#00000066")] }),
];
fixture("zoom-ladder", 1200, 800, zoomScene, { fill: "#F4F4F5", views: [
  { name: "0.1x", zoom: 0.1, dpr: 1 }, { name: "0.1x@2", zoom: 0.1, dpr: 2 }, { name: "0.33x", zoom: 0.33, dpr: 1 }, { name: "0.33x@2", zoom: 0.33, dpr: 2 },
  { name: "1x", zoom: 1, dpr: 1 }, { name: "2x", zoom: 2, dpr: 1, x: 20, y: 180, w: 640, h: 440 }, { name: "8x", zoom: 8, dpr: 1, x: 40, y: 200, w: 640, h: 440 },
  { name: "8x@2", zoom: 8, dpr: 2, x: 56, y: 216, w: 400, h: 300 }, { name: "32x", zoom: 32, dpr: 1, x: 56, y: 278, w: 640, h: 440 }, { name: "32x-edge", zoom: 32, dpr: 1, x: 1076, y: 24, w: 640, h: 440 },
] });

// A board big enough to be cut into 1024 px tiles (over 2400 device px a side). Diagonals, gradients, text and
// hairlines cross every tile edge, so a seam shows as a line of mismatches at multiples of 1024 device px.
const seam: N[] = [
  rect(0, 0, 2800, 1900, { fill: grad("linear", [["#EFF6FF", 0], ["#FDF2F8", 1]], { rotation: 60 }) }),
  ...Array.from({ length: 28 }, (_, i) => rect(i * 100 + 50, -200, 2, 2600, { fill: "#1D4ED8", rotation: 20, opacity: 0.8 })),
  ...Array.from({ length: 19 }, (_, i) => rect(0, i * 100 + 33.3, 2800, 1, { fill: "#18181B66" })),
  ...Array.from({ length: 70 }, (_, i) => text(30 + (i % 7) * 400, 60 + Math.floor(i / 7) * 190, `Tile seam ${i + 1} Hamburg`, { fontSize: 44, fontWeight: "700", fill: "#18181B" })),
  ...Array.from({ length: 24 }, (_, i) => ell(120 + (i % 6) * 460, 130 + Math.floor(i / 6) * 470, 300, 300, { fill: grad("radial", [["#FACC1599", 0], ["#DC262600", 1]]), stroke: "#DC2626", strokeWidth: 1.5 })),
  ...Array.from({ length: 12 }, (_, i) => rect(200 + (i % 4) * 700, 350 + Math.floor(i / 4) * 600, 420, 160, { fill: "#FFFFFFCC", cornerRadius: 30, effect: [shadow(0, 20, 60, "#00000059")] })),
];
// Each view is centred on a tile corner: tile edges sit at multiples of 1024 device px from the board's origin.
const corner = (name: string, zoom: number, dpr: number, tx: number, ty: number, w = 640, h = 440): View => ({ name, zoom, dpr, x: Math.round(((tx * 1024) / (zoom * dpr) - w / 2 / zoom) * 100) / 100, y: Math.round(((ty * 1024) / (zoom * dpr) - h / 2 / zoom) * 100) / 100, w, h, tiles: true });
const SEAM_VIEWS = [
  corner("1.37x", 1.37, 1, 1, 1), corner("1.37x-b", 1.37, 1, 3, 2), corner("0.77x@2", 0.77, 2, 2, 1, 360, 260), corner("2.613x", 2.613, 1, 2, 2), corner("2.613x-b", 2.613, 1, 5, 3),
  corner("0.9x", 0.9, 1, 1, 1), corner("1.5x@2", 1.5, 2, 4, 3, 360, 260), corner("7.3x", 7.3, 1, 9, 6),
];
fixture("tile-seams", 2800, 1900, seam, { views: SEAM_VIEWS.filter((v) => v.name !== "1.37x-b" && v.name !== "2.613x"), note: "Hairlines and text differ from Chrome everywhere at these zooms (see findings), so this fixture is judged on the seam check: mismatches within 2 px of a tile edge against the rest of the view." });
// The same board without hairlines and text: only shapes whose edges both renderers anti-alias the same way,
// plus blurs and translucent overlaps that cross tile edges. Anything left over is a seam.
const smooth: N[] = [
  rect(0, 0, 2800, 1900, { fill: grad("linear", [["#DBEAFE", 0], ["#FCE7F3", 0.5], ["#FEF3C7", 1]], { rotation: 60 }) }),
  ...Array.from({ length: 14 }, (_, i) => rect(i * 220 + 60, -300, 46, 2800, { fill: "#1D4ED859", rotation: 17 })),
  ...Array.from({ length: 10 }, (_, i) => rect(-300, i * 230 + 40, 3600, 38, { fill: "#DC262640", rotation: -8 })),
  ...Array.from({ length: 24 }, (_, i) => ell(90 + (i % 6) * 460, 100 + Math.floor(i / 6) * 470, 340, 340, { fill: grad("radial", [["#FACC15CC", 0], ["#F9731633", 1]]) })),
  ...Array.from({ length: 12 }, (_, i) => rect(180 + (i % 4) * 700, 330 + Math.floor(i / 4) * 600, 440, 180, { fill: "#FFFFFFB3", cornerRadius: 40, rotation: 5, effect: [shadow(0, 24, 70, "#00000066")] })),
  ...Array.from({ length: 6 }, (_, i) => ell(420 + (i % 3) * 900, 560 + Math.floor(i / 3) * 760, 260, 260, { fill: "#7C3AED", effect: [{ type: "blur", radius: 60 }] })),
  ...Array.from({ length: 6 }, (_, i) => frame(700 + (i % 3) * 760, 250 + Math.floor(i / 3) * 800, 300, 300, [], { fill: "#FFFFFF40", cornerRadius: 150, effect: [{ type: "background_blur", radius: 40 }] })),
];
fixture("tile-seams-smooth", 2800, 1900, smooth, { views: SEAM_VIEWS.filter((v) => ["1.37x", "0.77x@2", "2.613x-b", "7.3x"].includes(v.name)) });

fs.writeFileSync(path.join(DIR, "views.json"), JSON.stringify({ views, notes }, null, 1) + "\n");
console.log(`${Object.keys(views).length} fixtures, ${Object.values(views).reduce((s, v) => s + v.length, 0)} views -> ${DIR}`);
