// Stress files for the speed suite: N boards with a realistic mix of auto layout, free placement, text, image
// fills, component instances with overrides, groups and rotated layers. Generated on demand into os.tmpdir()
// (they run to hundreds of MB), deterministic for a given (boards, version), and reused while they exist.
//
//   node bench/fixtures/gen.ts 200 2000 5000      prints the package paths
//
// Each board is a 390 x 844 phone screen. Kinds, in a fixed rotation:
//   list   vertical auto layout: a header row, 8 to 14 rows (avatar image, title, subtitle, chip instance), a button
//   hero   free placement: a cover image, a title, a wrapped paragraph, two button instances, a rotated badge
//          group, a few shapes
//   grid   vertical auto layout of horizontal rows, each with two cards (image, caption)
//   form   vertical auto layout: labels, input frames with placeholder text, a toggle row, a button instance
//   dense  every 25th board: free placement, 600 small layers (rects, ellipses, labels) in 12 groups
// Fonts are Helvetica and Georgia (system fonts: no network). Images are 8 PNGs in the package's media folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodePng } from "../../fidelity/png.ts";

export const GEN_VERSION = 1;
export const BOARD_W = 390, BOARD_H = 844, GAP = 120;

type Node = Record<string, unknown> & { id: string; type: string; children?: Node[] };

/** mulberry32: a small seeded PRNG, so a file is the same on every machine. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "design canvas layout frame board token spacing colour type scale motion review ship invite share comment export layer group auto grid stack align fill stroke radius shadow blur image icon button chip card list form input toggle label header footer screen flow".split(" ");
const IMAGES = 8;

export type Fixture = { boards: number; dir: string; file: string; bytes: number; nodes: number; denseBoards: string[]; heroBoards: string[]; listBoards: string[] };

export function columnsFor(n: number): number {
  return Math.max(10, Math.ceil(Math.sqrt(n * 2.2)));
}

/** Writes `<dir>/document.json`, `widgets.json` and `media/*.png`. Returns what the bench needs to know. */
export function writeFixture(dir: string, boards: number): Fixture {
  const r = rng(0x5eed + boards);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  let nodes = 0;
  const N = (n: Node): Node => { nodes++; return n; };
  const text = (id: string, content: string, size = 15, weight = "400", extra: Record<string, unknown> = {}) =>
    N({ type: "text", id, content, fontFamily: extra.serif ? "Georgia" : "Helvetica", fontSize: size, fontWeight: weight, fill: "$fg", lineHeight: 1.3, ...extra, serif: undefined });
  const img = (k: number) => ({ type: "image", url: `media/img-${k % IMAGES}.png`, mode: "fill" });

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  for (let k = 0; k < IMAGES; k++) fs.writeFileSync(path.join(dir, "media", `img-${k}.png`), pngOf(k));

  // Components: a button, a chip and an avatar card, on a strip left of the boards.
  const comps: Node[] = [
    N({ type: "frame", id: "cmp-button", name: "Button", reusable: true, x: -1400, y: 0, layout: "horizontal", justifyContent: "center", alignItems: "center", padding: [12, 20], cornerRadius: 12, fill: "$accent", children: [text("cmp-button-t", "Continue", 16, "600", { fill: "#FFFFFF" })] }),
    N({ type: "frame", id: "cmp-chip", name: "Chip", reusable: true, x: -1400, y: 120, layout: "horizontal", gap: 4, alignItems: "center", padding: [4, 10], cornerRadius: 10, fill: "#E5E5EA", children: [N({ type: "ellipse", id: "cmp-chip-dot", width: 8, height: 8, fill: "$accent" }), text("cmp-chip-t", "Chip", 12, "500")] }),
    N({ type: "frame", id: "cmp-card", name: "Card", reusable: true, x: -1400, y: 240, width: 160, layout: "vertical", gap: 6, padding: 8, cornerRadius: 14, fill: "#FFFFFF", stroke: "#E5E5EA", strokeWidth: 1, strokeAlignment: "inner", children: [N({ type: "rectangle", id: "cmp-card-img", width: "fill_container", height: 100, cornerRadius: 8, fill: img(0) }), text("cmp-card-t", "Card title", 13, "600")] }),
  ];

  const cols = columnsFor(boards);
  const dense: string[] = [], hero: string[] = [], list: string[] = [];
  const out: Node[] = [];
  for (let b = 0; b < boards; b++) {
    const id = `b${b}`;
    const k = (s: string) => `${id}-${s}`;
    const x = (b % cols) * (BOARD_W + GAP), y = Math.floor(b / cols) * (BOARD_H + GAP);
    const kind = b % 25 === 7 ? "dense" : (["list", "hero", "grid", "form"] as const)[b % 4];
    let board: Node;
    if (kind === "list") {
      list.push(id);
      const rows: Node[] = [];
      const n = 8 + Math.floor(r() * 7);
      for (let i = 0; i < n; i++) {
        rows.push(N({ type: "frame", id: k(`r${i}`), name: "Row", layout: "horizontal", gap: 12, padding: [10, 12], alignItems: "center", cornerRadius: 12, fill: i % 2 ? "#FFFFFF" : "#F2F2F7", width: "fill_container", children: [
          N({ type: "ellipse", id: k(`r${i}a`), width: 40, height: 40, fill: img(b + i) }),
          N({ type: "frame", id: k(`r${i}c`), layout: "vertical", gap: 2, width: "fill_container", children: [text(k(`r${i}t`), cap(words(2 + (i % 3))), 15, "600"), text(k(`r${i}s`), words(5 + (i % 4)), 12, "400", { fill: "#71717A" })] }),
          N({ type: "ref", id: k(`r${i}chip`), ref: "cmp-chip", descendants: { "cmp-chip-t": { content: cap(pick(WORDS)) } } }),
        ] }));
      }
      board = { type: "frame", id, name: `List ${b}`, x, y, width: BOARD_W, height: BOARD_H, fill: "#FFFFFF", layout: "vertical", gap: 8, padding: [24, 16], clip: true, children: [
        N({ type: "frame", id: k("h"), layout: "horizontal", gap: 8, alignItems: "center", width: "fill_container", children: [text(k("ht"), cap(words(2)), 28, "700", { serif: true }), N({ type: "rectangle", id: k("hi"), width: 28, height: 28, cornerRadius: 14, fill: "$accent" })] }),
        ...rows,
        N({ type: "ref", id: k("cta"), ref: "cmp-button", width: "fill_container", descendants: { "cmp-button-t": { content: cap(words(2)) } } }),
      ] };
    } else if (kind === "hero") {
      hero.push(id);
      board = { type: "frame", id, name: `Hero ${b}`, x, y, width: BOARD_W, height: BOARD_H, fill: "#FFFFFF", layout: "none", clip: true, children: [
        N({ type: "rectangle", id: k("cover"), name: "Cover", x: 0, y: 0, width: BOARD_W, height: 360, fill: img(b) }),
        N({ type: "rectangle", id: k("card"), name: "Card", x: 24, y: 300, width: 342, height: 220, cornerRadius: 20, fill: "#FFFFFF", effect: [{ type: "shadow", offset: { x: 0, y: 8 }, blur: 24, spread: 0, color: "#00000022" }] }),
        text(k("title"), cap(words(3)), 30, "700", { x: 40, y: 324, serif: true }),
        text(k("body"), cap(words(28)) + ".", 15, "400", { x: 40, y: 372, width: 310, textGrowth: "fixed-width", fill: "#3F3F46" }),
        N({ type: "ref", id: k("b1"), ref: "cmp-button", x: 24, y: 700, width: 342, descendants: { "cmp-button-t": { content: "Get started" } } }),
        N({ type: "ref", id: k("b2"), ref: "cmp-button", x: 24, y: 764, width: 342, descendants: { "cmp-button-t": { content: "Sign in" } } }),
        N({ type: "group", id: k("badge"), name: "Badge", x: 280, y: 40, rotation: -12, children: [
          N({ type: "rectangle", id: k("badge-bg"), x: 0, y: 0, width: 84, height: 32, cornerRadius: 16, fill: "#FF3B30" }),
          text(k("badge-t"), "NEW", 13, "700", { x: 26, y: 8, fill: "#FFFFFF" }),
        ] }),
        N({ type: "ellipse", id: k("dot1"), x: 40, y: 560, width: 120, height: 120, fill: "#0766EB33" }),
        N({ type: "rectangle", id: k("sq1"), name: "Square", x: 200, y: 560, width: 120, height: 120, cornerRadius: 24, fill: "#34C75933" }),
        text(k("cap"), cap(words(4)), 13, "500", { x: 40, y: 540, fill: "#71717A" }),
      ] };
    } else if (kind === "grid") {
      const rows: Node[] = [];
      for (let i = 0; i < 3; i++) {
        rows.push(N({ type: "frame", id: k(`g${i}`), layout: "horizontal", gap: 14, width: "fill_container", children: [0, 1].map((j) => N({ type: "ref", id: k(`g${i}${j}`), ref: "cmp-card", width: "fill_container", descendants: { "cmp-card-img": { fill: img(b + i * 2 + j) }, "cmp-card-t": { content: cap(words(2)) } } })) }));
      }
      board = { type: "frame", id, name: `Grid ${b}`, x, y, width: BOARD_W, height: BOARD_H, fill: "#F2F2F7", layout: "vertical", gap: 14, padding: [24, 16], clip: true, children: [text(k("t"), cap(words(2)), 26, "700", { serif: true }), text(k("s"), cap(words(9)), 14, "400", { width: "fill_container", textGrowth: "fixed-width", fill: "#71717A" }), ...rows] };
    } else if (kind === "form") {
      const fields: Node[] = [];
      for (let i = 0; i < 5; i++) {
        fields.push(N({ type: "frame", id: k(`f${i}`), layout: "vertical", gap: 6, width: "fill_container", children: [
          text(k(`f${i}l`), cap(words(2)), 13, "600"),
          N({ type: "frame", id: k(`f${i}i`), layout: "horizontal", alignItems: "center", padding: [12, 14], cornerRadius: 10, fill: "#FFFFFF", stroke: "#D1D1D6", strokeWidth: 1, strokeAlignment: "inner", width: "fill_container", children: [text(k(`f${i}p`), words(3), 15, "400", { fill: "#A1A1AA" })] }),
        ] }));
      }
      board = { type: "frame", id, name: `Form ${b}`, x, y, width: BOARD_W, height: BOARD_H, fill: "#FFFFFF", layout: "vertical", gap: 16, padding: [32, 20], clip: true, children: [
        text(k("t"), cap(words(3)), 26, "700"),
        ...fields,
        N({ type: "frame", id: k("tg"), layout: "horizontal", justifyContent: "space_between", alignItems: "center", width: "fill_container", children: [text(k("tgl"), cap(words(3)), 15), N({ type: "frame", id: k("tgs"), width: 51, height: 31, cornerRadius: 16, fill: "#34C759", layout: "none", children: [N({ type: "ellipse", id: k("tgk"), x: 22, y: 2, width: 27, height: 27, fill: "#FFFFFF" })] })] }),
        N({ type: "ref", id: k("submit"), ref: "cmp-button", width: "fill_container", descendants: { "cmp-button-t": { content: "Submit" } } }),
      ] };
    } else {
      dense.push(id);
      const groups: Node[] = [];
      for (let g = 0; g < 12; g++) {
        const gx = 12 + (g % 3) * 124, gy = 12 + Math.floor(g / 3) * 206;
        const kids: Node[] = [];
        for (let i = 0; i < 50; i++) {
          const cx = gx + (i % 5) * 23, cy = gy + Math.floor(i / 5) * 20;
          if (i % 7 === 3) kids.push(text(k(`d${g}t${i}`), String(i), 9, "500", { x: cx, y: cy }));
          else if (i % 3 === 0) kids.push(N({ type: "ellipse", id: k(`d${g}e${i}`), x: cx, y: cy, width: 16, height: 16, fill: `#${((g * 37 + i * 11) % 200 + 40).toString(16)}66CC` }));
          else kids.push(N({ type: "rectangle", id: k(`d${g}r${i}`), x: cx, y: cy, width: 18, height: 14, cornerRadius: 3, fill: `#${((g * 53 + i * 7) % 200 + 40).toString(16)}AA66` }));
        }
        groups.push(N({ type: "group", id: k(`d${g}`), name: `Cluster ${g}`, x: 0, y: 0, children: kids }));
      }
      board = { type: "frame", id, name: `Dense ${b}`, x, y, width: BOARD_W, height: BOARD_H, fill: "#FFFFFF", layout: "none", clip: true, children: groups };
    }
    out.push(N(board));
  }
  const doc = {
    version: "2.21",
    themes: { mode: ["light", "dark"] },
    variables: { accent: { type: "color", value: "#0766EB" }, fg: { type: "color", value: [{ value: "#18181B", theme: { mode: "light" } }, { value: "#FCFCFC", theme: { mode: "dark" } }] } },
    children: [...out, ...comps],
  };
  const file = path.join(dir, "document.json");
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  fs.writeFileSync(path.join(dir, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }, null, 2));
  const meta: Fixture = { boards, dir, file, bytes: fs.statSync(file).size, nodes, denseBoards: dense, heroBoards: hero, listBoards: list };
  fs.writeFileSync(path.join(dir, ".fixture.json"), JSON.stringify({ version: GEN_VERSION, ...meta }));
  return meta;
}

/** A 512 x 512 PNG: a two-colour gradient with soft circles, different per k. */
function pngOf(k: number): Buffer {
  const S = 512, data = new Uint8Array(S * S * 4);
  const hue = (k * 47) % 360;
  const rgb = (h: number, l: number) => {
    const a = 0.6 * Math.min(l, 1 - l), f = (n: number) => { const q = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(q - 3, 9 - q, 1)); };
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  };
  const c0 = rgb(hue, 0.45), c1 = rgb((hue + 60) % 360, 0.7);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const t = (x + y) / (2 * S);
    const d = Math.hypot(x - 180 - k * 20, y - 260) / 512;
    const glow = Math.max(0, 0.35 - d) * 1.6;
    const i = (y * S + x) * 4;
    for (let c = 0; c < 3; c++) data[i + c] = Math.min(255, c0[c] * (1 - t) + c1[c] * t + glow * 255);
    data[i + 3] = 255;
  }
  return encodePng({ width: S, height: S, data });
}

/** The fixture package for `boards`, generated once into os.tmpdir() and reused while its version matches. */
export function fixture(boards: number): Fixture {
  const dir = path.join(os.tmpdir(), "canvas-bench-fixtures", `stress-${boards}.canvas`);
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, ".fixture.json"), "utf8"));
    if (m.version === GEN_VERSION && fs.existsSync(m.file)) return m;
  } catch {}
  return writeFixture(dir, boards);
}

/** A disposable copy of a fixture (APFS clone where it can) in `into`, for a run that edits it. */
export function scratchCopy(f: Fixture, into: string, name = path.basename(f.dir)): Fixture {
  const dest = path.join(into, name);
  fs.cpSync(f.dir, dest, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  return { ...f, dir: dest, file: path.join(dest, "document.json") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const a of process.argv.slice(2).map(Number).filter((n) => n > 0)) {
    const t0 = performance.now();
    const f = fixture(a);
    console.log(`${f.dir}  ${f.boards} boards, ${f.nodes} nodes, ${(f.bytes / 1048576).toFixed(1)} MB, ${Math.round(performance.now() - t0)} ms`);
  }
}
