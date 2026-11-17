// Builds demos/playground.canvas: one document holding every Canvas feature, each on a labelled board, over four
// pages (Layout, Components, Style, Cards). The design is written as plain document JSON (checked with src/doc/schema.ts);
// pages, cards, the shader and the video go through a scratch server's own HTTP write paths, so the package is
// exactly what Canvas itself writes. Run: node qa/playground.ts   (rewrites demos/playground.canvas)
//
// Ids are fixed and readable (qa/run.ts addresses layers by them). Every board's first child is a caption saying
// what the board tests.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateNode, validateVariable, type Json, type DocNode } from "../src/doc/schema.ts";
import { interTrackingEm } from "../src/tracking.ts";
import { ROOT, api, startServer } from "./lib.ts";

export const PLAYGROUND = path.join(ROOT, "demos", "playground.canvas");

// ---------------------------------------------------------------- helpers

/** Inter with Dynamic Metrics tracking and a size-based line height (the inter-typography rule). */
function inter(size: number, weight = "400"): Record<string, Json> {
  const lh = size <= 12 ? 1.5 : size <= 16 ? 1.45 : size <= 20 ? 1.35 : size <= 32 ? 1.2 : 1.1;
  return { fontFamily: "Inter", fontSize: size, fontWeight: weight, letterSpacing: Math.round(interTrackingEm(size) * size * 100) / 100, lineHeight: lh, metadata: { type: "canvas", canvasLetterSpacing: "auto" } };
}
const text = (id: string, content: string, x: number, y: number, size = 14, extra: Record<string, Json> = {}): DocNode => ({ type: "text", id, name: extra.name as string ?? content.slice(0, 32), x, y, content, fill: "#18181B", ...inter(size, (extra.fontWeight as string) ?? "400"), ...extra });
const caption = (id: string, s: string) => text(id, s, 24, 20, 13, { name: "Caption", fill: "#71717A", fontWeight: "500" });
const rect = (id: string, x: number, y: number, w: number, h: number, fill: string, extra: Record<string, Json> = {}): DocNode => ({ type: "rectangle", id, name: extra.name as string ?? id, x, y, width: w, height: h, fill, ...extra });
const board = (id: string, name: string, x: number, y: number, w: number, h: number, cap: string, children: DocNode[], extra: Record<string, Json> = {}): DocNode => ({
  type: "frame", id, name, x, y, width: w, height: h, fill: "#FFFFFF", cornerRadius: 12, clip: true, ...extra, children: [caption(`${id}_cap`, cap), ...children],
});

// ---------------------------------------------------------------- page 1: Layout

const layout: DocNode[] = [
  board("lay_nest", "Frames and groups", 0, 0, 560, 420, "Frames in frames, a group, a group holding a 45 degree layer at 0,0, a nested group", [
    { type: "frame", id: "fr_outer", name: "Outer frame", x: 24, y: 60, width: 220, height: 170, fill: "#EEF2FF", cornerRadius: 8, children: [
      { type: "frame", id: "fr_inner", name: "Inner frame", x: 24, y: 24, width: 130, height: 90, fill: "#C7D2FE", cornerRadius: 6, children: [rect("r_inner", 16, 16, 40, 40, "#4F46E5", { name: "Inner rect" })] },
    ] },
    { type: "group", id: "g_pair", name: "Group", x: 290, y: 60, children: [rect("r_g1", 0, 0, 60, 60, "#F59E0B", { name: "Group A" }), rect("r_g2", 76, 0, 60, 60, "#10B981", { name: "Group B" })] },
    { type: "group", id: "g_rot", name: "Rotated group", x: 340, y: 190, children: [rect("r_rot45", 0, 0, 60, 60, "#EF4444", { name: "Rotated 45", rotation: 45 })] },
    { type: "group", id: "g_outer", name: "Nested group", x: 24, y: 270, children: [
      { type: "group", id: "g_inner", name: "Inner group", x: 0, y: 0, children: [rect("r_n1", 0, 0, 50, 50, "#0EA5E9", { name: "Nested A" }), rect("r_n2", 64, 0, 50, 50, "#6366F1", { name: "Nested B" })] },
      rect("r_n3", 0, 64, 114, 30, "#A855F7", { name: "Nested C" }),
    ] },
    rect("r_free", 300, 300, 70, 50, "#14B8A6", { name: "Free rect", cornerRadius: 6 }),
  ]),
  board("lay_auto", "Auto layout", 640, 0, 620, 460, "Rows and columns: gap, padding, hug, fill, an absolute child; a plain frame to add auto layout to", [
    { type: "frame", id: "al_row", name: "Row (hug)", x: 24, y: 60, width: "fit_content", height: "fit_content", layout: "horizontal", gap: 12, padding: 16, fill: "#F1F5F9", cornerRadius: 8, children: [
      rect("al_a", 0, 0, 60, 60, "#F43F5E", { name: "Row A" }), rect("al_b", 0, 0, 60, 60, "#F59E0B", { name: "Row B" }), rect("al_c", 0, 0, 60, 60, "#22C55E", { name: "Row C" }),
    ] },
    { type: "frame", id: "al_col", name: "Column", x: 24, y: 180, width: 220, height: "fit_content", layout: "vertical", gap: 8, padding: [12, 16, 12, 16], fill: "#F1F5F9", cornerRadius: 8, children: [
      rect("al_fill1", 0, 0, "fill_container" as any, 32, "#93C5FD", { name: "Fill 1" }),
      text("al_txt", "Hug text in a column", 0, 0, 13, { name: "Column text" }),
      rect("al_fill2", 0, 0, "fill_container" as any, 32, "#60A5FA", { name: "Fill 2" }),
      rect("al_abs", 170, -10, 24, 24, "#1D4ED8", { name: "Absolute", layoutPosition: "absolute", cornerRadius: 12 }),
    ] },
    { type: "frame", id: "al_fillrow", name: "Fill row", x: 300, y: 60, width: 290, height: "fit_content", layout: "horizontal", gap: 8, padding: 8, fill: "#ECFDF5", cornerRadius: 8, children: [
      rect("al_f1", 0, 0, "fill_container" as any, 40, "#34D399", { name: "Fill" }), rect("al_f2", 0, 0, 60, 40, "#059669", { name: "Fixed" }),
    ] },
    { type: "frame", id: "fr_plain", name: "Plain frame", x: 300, y: 180, width: 240, height: 150, fill: "#FEF3C7", cornerRadius: 8, children: [
      rect("fp_a", 20, 20, 50, 50, "#D97706", { name: "Plain A" }), rect("fp_b", 100, 40, 50, 50, "#B45309", { name: "Plain B" }),
    ] },
  ]),
  board("lay_clip", "Clip", 1340, 0, 440, 260, "Clip on (left) cuts the circle, clip off (right) lets it spill", [
    { type: "frame", id: "clip_on", name: "Clip on", x: 24, y: 70, width: 160, height: 120, fill: "#E0E7FF", clip: true, children: [{ type: "ellipse", id: "clip_on_dot", name: "Spill", x: 100, y: 60, width: 100, height: 100, fill: "#4F46E5" }] },
    { type: "frame", id: "clip_off", name: "Clip off", x: 230, y: 70, width: 160, height: 120, fill: "#E0E7FF", clip: false, children: [{ type: "ellipse", id: "clip_off_dot", name: "Spill", x: 100, y: 60, width: 100, height: 100, fill: "#4F46E5" }] },
  ], { clip: false }),
  board("lay_text", "Text", 0, 520, 560, 380, "Long text, auto width, auto height, fixed size", [
    text("tx_long", "Canvas is a design tool built for language models and the people who work with them. This paragraph is long on purpose: it wraps inside a fixed width and grows downwards as you type, so resizing its width reflows every line.", 24, 56, 14, { name: "Long text", textGrowth: "fixed-width", width: 300 }),
    text("tx_auto", "Auto width grows sideways", 24, 230, 16, { name: "Auto width", textGrowth: "auto" }),
    text("tx_height", "Auto height: fixed width, height follows the lines", 24, 270, 14, { name: "Auto height", textGrowth: "fixed-width", width: 200 }),
    text("tx_fixed", "Fixed size box", 360, 56, 14, { name: "Fixed size", textGrowth: "fixed-width-height", width: 160, height: 40, fill: "#18181B" }),
  ]),
  board("lay_xform", "Transforms", 640, 540, 520, 300, "Rotated and flipped layers", [
    rect("xf_rot", 40, 80, 80, 50, "#F97316", { name: "Rotated 30", rotation: 30 }),
    { type: "rectangle", id: "xf_flipx", name: "Flipped X", x: 200, y: 80, width: 100, height: 60, flipX: true, fill: { type: "gradient", gradientType: "linear", rotation: 90, colors: [{ color: "#0EA5E9", position: 0 }, { color: "#F43F5E", position: 1 }] } },
    text("xf_flipy", "Flipped Y", 330, 90, 20, { name: "Flipped Y", flipY: true, fontWeight: "700" }),
    { type: "ellipse", id: "xf_ell", name: "Rotated ellipse", x: 60, y: 190, width: 120, height: 50, rotation: -20, fill: "#8B5CF6" },
  ]),
  board("lay_resize", "Resize targets", 1240, 540, 640, 440, "Handles on a rectangle, a frame, a text, a group, and a group holding a 45 degree layer", [
    rect("rz_rect", 60, 70, 100, 80, "#38BDF8", { name: "Resize rect" }),
    { type: "frame", id: "rz_frame", name: "Resize frame", x: 260, y: 70, width: 120, height: 90, fill: "#FDE68A", children: [rect("rz_frame_kid", 20, 20, 40, 40, "#D97706", { name: "Frame child" })] },
    text("rz_text", "Resize text", 460, 80, 16, { name: "Resize text", textGrowth: "fixed-width-height", width: 120, height: 40 }),
    { type: "group", id: "rz_group", name: "Resize group", x: 60, y: 250, children: [rect("rz_ga", 0, 0, 60, 60, "#A3E635", { name: "RG A" }), rect("rz_gb", 80, 20, 60, 60, "#65A30D", { name: "RG B" })] },
    { type: "ellipse", id: "rz_ell", name: "Resize ellipse", x: 420, y: 160, width: 110, height: 70, fill: "#C084FC" },
    { type: "rectangle", id: "rz_img", name: "Resize image", x: 60, y: 350, width: 100, height: 70, fill: { type: "image", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAG0lEQVR4XmP4Oo/7P9/Sl/9hNAMyByTIQFAFAIGHKcG3a15jAAAAAElFTkSuQmCC", mode: "fill" } },
    { type: "ref", id: "rz_inst", name: "Resize instance", ref: "cmp_button", x: 200, y: 350 },
    rect("rz_rot", 330, 350, 90, 50, "#F97316", { name: "Resize rotated", rotation: 30 }),
    { type: "group", id: "rz_grot", name: "Group with rotated layer", x: 330, y: 260, children: [rect("rz_grot_a", 0, 0, 60, 60, "#FB7185", { name: "RR rotated", rotation: 45 }), rect("rz_grot_b", 60, 0, 60, 60, "#BE123C", { name: "RR plain" })] },
  ]),
  // Top-level layers that are not boards: no name label above them.
  { type: "ref", id: "top_inst", name: "Top-level instance", ref: "cmp_button", x: 0, y: 960 },
  text("top_text", "A top-level text has no label", 240, 964, 16, { name: "Top-level text", fill: "#A1A1AA" }),
];

// ---------------------------------------------------------------- page 2: Components

const button = (id: string, name: string, fill: string, label: string, color: string): DocNode => ({
  type: "frame", id, name, reusable: true, x: 0, y: 0, width: "fit_content", height: "fit_content", layout: "horizontal", padding: [10, 20], gap: 8, alignItems: "center", fill, cornerRadius: 8,
  children: [text(`${id}_label`, label, 0, 0, 14, { name: "Label", fill: color, fontWeight: "600" })],
});
const components: DocNode[] = [
  board("cmp_main", "Main components", 0, 0, 520, 240, "Button: a main component with two variants (text and fill)", [
    { ...button("cmp_button", "Button/Primary", "#111827", "Button", "#FFFFFF"), x: 24, y: 70 },
    { ...button("cmp_button_sec", "Button/Secondary", "#E5E7EB", "Cancel", "#111827"), x: 180, y: 70 },
  ]),
  board("cmp_inst", "Instances", 600, 0, 620, 400, "Instances with fill, text and font overrides; a detached copy; instances in auto layout", [
    { type: "ref", id: "inst_plain", name: "Button/Primary", ref: "cmp_button", x: 24, y: 64 },
    { type: "ref", id: "inst_fill", name: "Button/Primary", ref: "cmp_button", x: 24, y: 124, fill: "#DC2626" },
    { type: "ref", id: "inst_text", name: "Button/Primary", ref: "cmp_button", x: 24, y: 184, descendants: { cmp_button_label: { content: "Text override" } } },
    { type: "ref", id: "inst_font", name: "Button/Primary", ref: "cmp_button", x: 24, y: 244, descendants: { cmp_button_label: { fontWeight: "400", fontSize: 18 } } },
    { type: "frame", id: "det_button", name: "Button (detached)", x: 300, y: 64, width: "fit_content", height: "fit_content", layout: "horizontal", padding: [10, 20], gap: 8, alignItems: "center", fill: "#7C3AED", cornerRadius: 8,
      children: [text("det_label", "Detached", 0, 0, 14, { name: "Label", fill: "#FFFFFF", fontWeight: "600" })] },
    { type: "frame", id: "inst_row", name: "Instances row", x: 300, y: 160, width: "fit_content", height: "fit_content", layout: "horizontal", gap: 8, padding: 12, fill: "#F3F4F6", cornerRadius: 10, children: [
      { type: "ref", id: "inst_r1", name: "Button/Primary", ref: "cmp_button" },
      { type: "ref", id: "inst_r2", name: "Button/Secondary", ref: "cmp_button_sec" },
    ] },
  ]),
];

// ---------------------------------------------------------------- page 3: Style

const style: DocNode[] = [
  board("sty_vars", "Variables", 0, 0, 520, 280, "Colour and number variables; the right frame uses the dark theme", [
    rect("var_rect", 24, 70, 120, 80, "$brand", { name: "Brand ($brand)", cornerRadius: "$radius" as any }),
    { type: "frame", id: "var_dark", name: "Dark theme", x: 200, y: 60, width: 280, height: 180, fill: "$surface", theme: { mode: "dark" }, layout: "vertical", gap: "$space" as any, padding: "$space" as any, cornerRadius: 12, children: [
      rect("var_rect_dark", 0, 0, 120, 60, "$brand", { name: "Brand dark", cornerRadius: "$radius" as any }),
      text("var_txt_dark", "Dark surface", 0, 0, 14, { name: "Dark text", fill: "$ink" }),
    ] },
  ]),
  board("sty_type", "Text styles", 600, 0, 560, 360, "Repeated styles become text styles; tight tracking at -2%", [
    text("ts_h1a", "Heading one", 24, 56, 32, { name: "H1", fontWeight: "700" }),
    text("ts_h1b", "Another heading", 24, 104, 32, { name: "H1", fontWeight: "700" }),
    text("ts_body_a", "Body text at sixteen", 24, 160, 16, { name: "Body" }),
    text("ts_body_b", "More body text", 24, 188, 16, { name: "Body" }),
    text("ts_cap_a", "CAPTION", 24, 224, 12, { name: "Caption", fontWeight: "600", fill: "#71717A" }),
    { type: "text", id: "ts_tight", name: "Tight -2%", x: 24, y: 260, content: "Tight -2%", fill: "#18181B", fontFamily: "Inter", fontSize: 40, fontWeight: "700", letterSpacing: -0.8, lineHeight: 1.1 },
  ]),
  board("sty_paint", "Paint", 0, 420, 760, 200, "Fills, strokes, shadow, blur, per-corner radius, opacity", [
    rect("pt_solid", 24, 70, 80, 80, "#2563EB", { name: "Solid" }),
    rect("pt_grad", 124, 70, 80, 80, { type: "gradient", gradientType: "linear", rotation: 135, colors: [{ color: "#F59E0B", position: 0 }, { color: "#EC4899", position: 1 }] } as any, { name: "Gradient" }),
    rect("pt_stroke", 224, 70, 80, 80, "#FFFFFF", { name: "Stroke", stroke: "#0F172A", strokeWidth: 3, strokeAlignment: "inner" }),
    rect("pt_shadow", 324, 70, 80, 80, "#FFFFFF", { name: "Shadow", cornerRadius: 10, effect: [{ type: "shadow", offset: { x: 0, y: 8 }, blur: 24, spread: 0, color: "#0F172A40" }] }),
    rect("pt_blur", 424, 70, 80, 80, "#10B981", { name: "Blur", effect: [{ type: "blur", radius: 8 }] }),
    rect("pt_corners", 524, 70, 80, 80, "#6366F1", { name: "Per-corner radius", cornerRadius: [0, 12, 24, 40] }),
    rect("pt_opacity", 624, 70, 80, 80, "#EF4444", { name: "Opacity 50%", opacity: 0.5 }),
  ]),
];

// ---------------------------------------------------------------- page 4: Cards (one board as the page's title)

const cards: DocNode[] = [
  board("crd_board", "Cards", 0, 0, 1180, 90, "Every widget kind sits below this board: to-do, note, PostHog (unconfigured), shader, video", []),
];

export const PAGES = [
  { id: "layout", name: "Layout", boards: layout.map((n) => n.id!) },
  { id: "components", name: "Components", boards: components.map((n) => n.id!) },
  { id: "style", name: "Style", boards: style.map((n) => n.id!) },
  { id: "cards", name: "Cards", boards: cards.map((n) => n.id!) },
];

const variables: Record<string, Json> = {
  brand: { type: "color", value: [{ value: "#4F46E5", theme: { mode: "light" } }, { value: "#A5B4FC", theme: { mode: "dark" } }] },
  surface: { type: "color", value: [{ value: "#FFFFFF", theme: { mode: "light" } }, { value: "#111827", theme: { mode: "dark" } }] },
  ink: { type: "color", value: [{ value: "#111827", theme: { mode: "light" } }, { value: "#F9FAFB", theme: { mode: "dark" } }] },
  radius: { type: "number", value: 12 },
  space: { type: "number", value: 16 },
};

/** Frames lay out their children in a row unless they say otherwise: free-form frames here say "none". */
function freeForm(n: DocNode): DocNode {
  const out: DocNode = { ...n };
  if (out.type === "frame" && out.layout === undefined) out.layout = "none";
  if (out.children) out.children = out.children.map(freeForm);
  return out;
}

export function playgroundDoc() {
  return { version: "2.21", themes: { mode: ["light", "dark"] }, variables, children: [...layout, ...components, ...style, ...cards].map(freeForm) };
}

/** Schema problems in the design (empty when valid), plus duplicate ids. */
export function checkDoc(docFile: ReturnType<typeof playgroundDoc>): string[] {
  const errs: string[] = [];
  for (const n of docFile.children) errs.push(...validateNode(n));
  for (const [k, v] of Object.entries(docFile.variables)) errs.push(...validateVariable(k, v).map((e) => `variable ${k}: ${e}`));
  const seen = new Set<string>();
  const walk = (n: DocNode) => { if (n.id) { if (seen.has(n.id)) errs.push(`duplicate id ${n.id}`); seen.add(n.id); } (n.children ?? []).forEach(walk); };
  docFile.children.forEach(walk);
  return errs;
}

// ---------------------------------------------------------------- build

async function build() {
  const docFile = playgroundDoc();
  const errs = checkDoc(docFile);
  if (errs.length) throw new Error(`schema:\n${errs.join("\n")}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-playground-"));
  const pkg = path.join(tmp, "Playground.canvas");
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "document.json"), JSON.stringify(docFile, null, 2) + "\n");
  // A one-second 160 x 90 test pattern (about 10 KB), made here so the repo needs no binary download.
  const mp4 = path.join(tmp, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryslow", "-crf", "36", "-movflags", "+faststart", "-an", mp4]);
  const srv = await startServer(tmp);
  try {
    const a = api(srv.base, pkg);
    const d = await a.get("/api/doc");
    for (const b of d.boards) {
      const r = await a.get(`/api/board?id=${encodeURIComponent(b.id)}`);
      if (r.warnings?.length) throw new Error(`board ${b.id}: ${r.warnings.join("; ")}`);
    }
    await a.put("/api/pages", { pages: PAGES });
    const y0 = 140;
    await a.post("/api/widgets", { kind: "todo", name: "To-do", x: 0, y: y0, w: 300, h: 340, page: "cards", config: { title: "Playground to-dos", items: [
      { text: "Drag me by the body", done: false }, { text: "Resize from every edge", done: false }, { text: "Check this one off", done: false },
      { text: "Already done", done: true }, { text: "Also done", done: true },
    ] } });
    await a.post("/api/widgets", { kind: "note", name: "Note", x: 340, y: y0, w: 340, h: 500, page: "cards", config: { tone: "yellow", text: [
      "# Rich note", "## Second level", "Plain paragraph with **bold** and *italic*.", "- Bullet one", "- Bullet two", "1. First", "2. Second",
      "- [ ] An open to-do block", "- [x] A done to-do block", "> A quote line", "---", "Inline `code` and ~~strike~~ and a [link](https://example.com).",
    ].join("\n") } });
    await a.post("/api/widgets", { kind: "note", name: "Scratch note", x: 1060, y: y0, w: 300, h: 200, page: "cards", config: { tone: "plain", text: "Write here" } });
    await a.post("/api/widgets", { kind: "posthog", name: "PostHog (not set up)", x: 720, y: y0, w: 300, h: 180, page: "cards" });
    await a.post("/api/shaders", { preset: "mesh-gradient", name: "Mesh gradient", x: 720, y: y0 + 220, w: 300, h: 180, page: "cards" });
    await a.post("/api/videos", { path: mp4, name: "Test pattern", x: 0, y: y0 + 380, w: 320, h: 180, page: "cards", loop: true, muted: true, autoplay: false });
    const f = await a.flush();
    if (!f.ok) throw new Error(`flush: ${JSON.stringify(f)}`);
  } finally {
    await srv.stop();
  }
  // Only the document's own files: no journals, temp files or caches.
  fs.rmSync(PLAYGROUND, { recursive: true, force: true });
  fs.mkdirSync(PLAYGROUND, { recursive: true });
  for (const e of fs.readdirSync(pkg, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    fs.cpSync(path.join(pkg, e.name), path.join(PLAYGROUND, e.name), { recursive: true, filter: (s) => !path.basename(s).startsWith(".") });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  const size = (p: string): number => fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((s, n) => s + size(path.join(p, n)), 0) : fs.statSync(p).size;
  console.log(`wrote ${path.relative(ROOT, PLAYGROUND)} (${(size(PLAYGROUND) / 1024).toFixed(1)} KB): ${fs.readdirSync(PLAYGROUND).join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await build();
