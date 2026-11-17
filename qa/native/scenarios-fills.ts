// Native scenarios for fills (apps/macos/PaintEditor.swift, InspectorPaint.swift): "+" asks for the paint type, a
// paint's swatch opens the popover whose tabs switch the type, the gradient, image and shader editors, Selection
// colors, the layer's blend mode, corner smoothing, the eyedropper key, hex lighter/darker, Copy Fill / Paste Fill,
// and the contrast line for text. Real NSEvents in a QA instance; the image picker and the eyedropper answer through
// qa.paint (a QA build cannot drive the system's open panel or colour sampler).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { center, NT, sc, type Pt } from "./harness.ts";
import { ROOT, copyDir, gradientPng, sleep } from "../lib.ts";

const OUT = path.join(ROOT, "qa", "out", "native");
type R = { x: number; y: number; w: number; h: number };

/** The inspector's area of the window. */
async function inspector(t: NT): Promise<R> {
  const st = await t.state();
  return { x: st.window.width - 320, y: 60, w: 320, h: st.window.height - 60 };
}
/** Where text `label` is drawn in the inspector, matched whole (OCR). */
async function labelIn(t: NT, label: string, region?: R, window: "main" | "popover" = "main"): Promise<R> {
  const reg = region ?? (await inspector(t));
  const t0 = Date.now();
  for (;;) {
    const m = (await t.findText(label, reg, window).catch(() => [])).filter((x) => { const s = x.text.trim().toLowerCase(), l = label.toLowerCase(); return s === l || s.replace(/[^a-z0-9. ]+$/, "").trim() === l || s.startsWith(l + " "); });
    if (m.length) return m.sort((a, b) => a.y - b.y)[0];
    if (Date.now() - t0 > 25000) throw new Error(`no "${label}" in the ${window === "popover" ? "popover" : "inspector"}`);
    await sleep(500);
  }
}
/** The right edge of the inspector's content (the opacity fields end there). */
async function rightEdge(t: NT) { return Math.max(...(await t.fields()).map((f) => f.x + f.w)); }
/** A section's "+" (Fill, Stroke): at the content's right edge on the title's line. */
async function plusOf(t: NT, section: string): Promise<Pt> {
  // Fill with a colour row: the "+" sits on the title line right above the first hex field (text recognition
  // misses the short word "Fill" now and then while other instances use it).
  if (section === "Fill") {
    const hex = (await t.fields()).find((f) => /^[0-9A-F]{6}$/i.test(f.value));
    if (hex) return { x: (await rightEdge(t)) - 12, y: hex.y + hex.h / 2 - 14 - 8 - 12 };
  }
  const l = await labelIn(t, section);
  return { x: (await rightEdge(t)) - 12, y: l.y + l.h / 2 };
}
/** The swatch of the top paint row (a gradient, image or shader has no hex) over a colour row: the colour row's
 * swatch column, the top row's opacity field line. */
async function topRowSwatch(t: NT): Promise<Pt> {
  const fs = await t.fields();
  const hex = fs.find((f) => /^[0-9A-F]{6}$/i.test(f.value))!;
  const op = fs.filter((f) => f.value === "100" && f.x > hex.x + hex.w && f.y < hex.y - 4).sort((a, b) => b.y - a.y)[0];
  return { x: hex.x - 14, y: op.y + op.h / 2 };
}
/** A point in the paint popover: where text recognition finds `label`, else where the layout puts it. */
async function popPoint(t: NT, label: string, fallback: Pt): Promise<Pt> {
  const m = (await t.findText(label, undefined, "popover").catch(() => [])).filter((x) => x.text.trim().toLowerCase().startsWith(label.toLowerCase()));
  return m.length ? center(m[0]) : fallback;
}
/** The paint popover's layout (PaintPopover): a 13 pt frame, 12 pt padding, the tabs row, then the editor. */
const POP = { x0: 25, w: 216, tabsY: 37, top: 59 };
async function popoverOpen(t: NT) {
  return t.waitFor(async () => (await t.cmd("qa.views", { window: "popover", all: true }).catch(() => null))?.views?.[0] ?? null, "the paint popover to open", 6000);
}
async function closePopover(t: NT) { await t.key("Escape", [], { window: "popover" }).catch(() => {}); await sleep(300); }
/** The popover's text fields, top to bottom. */
async function popoverFields(t: NT) {
  return (await t.views("popover")).filter((v) => v.kind === "text" && v.editable).sort((a, b) => a.y - b.y || a.x - b.x);
}
async function typeInto(t: NT, f: R, text: string, window: "main" | "popover" = "popover") {
  await t.click(center(f), { window });
  await sleep(150);
  await t.key("a", ["cmd"], { window });
  await t.type(text, { window });
  await t.key("Return", [], { window });
  await sleep(250);
}
function tmpImage(name: string, w: number, h: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-fills-"));
  const f = path.join(dir, name);
  fs.writeFileSync(f, gradientPng(w, h));
  return f;
}
const list = (v: unknown): any[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

sc("inspector", "Fill + asks for the type: Linear gradient goes on top; the swatch's Solid tab turns it back", { covers: ["paint-type:rectangle", "paint-type:mouse", "paint-type:gradient", "paint-type:solid", "gradient-edit:rectangle", "gradient-edit:mouse", "gradient-edit:stops", "gradient-edit:angle", "gradient-edit:keyboard"] }, async (t: NT) => {
  await t.showPage("style");
  await t.selectIds(["pt_solid"]);
  await t.click(await plusOf(t, "Fill"));
  const open = await t.waitState((s) => s.menu, "the type menu");
  for (const want of ["Solid", "Linear gradient", "Radial gradient", "Angular gradient", "Image…", "Shader"]) t.ok(open.menu.items.includes(want), `the + menu has ${want} (${open.menu.items.join(", ")})`);
  await t.pickMenu("Linear gradient");
  const g = await t.waitDisk(() => { const f = list(t.node("pt_solid")?.fill); return f.length === 2 && f[1]?.type === "gradient" && f; }, "a gradient on top");
  t.eq(g[1].colors.map((c: any) => c.color), ["#D9D9D9", "#D9D9D900"], "from #D9D9D9 to itself transparent");
  // The gradient row: its swatch opens the popover with the stops.
  await t.click(await topRowSwatch(t));
  const root = await popoverOpen(t);
  // The stop bar sits right above the position and angle fields (GradientEditor): a click on it adds a stop.
  const fields = await popoverFields(t);
  const row = fields.filter((f) => Math.abs(f.y - fields[0].y) < 2).sort((a, b) => a.x - b.x);
  t.ok(row.length >= 2, `the position and angle fields (${fields.map((f) => f.value).join(", ")})`);
  await t.click({ x: root.w / 2, y: row[0].y + row[0].h / 2 - 44 }, { window: "popover" });
  await t.waitDisk(() => list(t.node("pt_solid")?.fill)[1]?.colors?.length === 3, "a third stop");
  // The angle field: 45 degrees.
  const angle = (await popoverFields(t)).filter((f) => Math.abs(f.y - row[0].y) < 2).sort((a, b) => a.x - b.x)[1];
  await typeInto(t, angle, "45");
  await t.waitDisk(() => list(t.node("pt_solid")?.fill)[1]?.rotation === 135, "rotation 135 (file degrees for the field's 45)");
  await t.shot(path.join(OUT, "fills-gradient-popover.png"), "popover");
  // The Solid tab: the gradient becomes its first stop's colour.
  await t.click(await popPoint(t, "Solid", { x: POP.x0 + 25, y: POP.tabsY }), { window: "popover" });
  await t.waitDisk(() => list(t.node("pt_solid")?.fill)[1] === "#D9D9D9", "the paint back to a colour");
  await closePopover(t);
});

sc("inspector", "Fill + Image... adds the picked file; Tile, Rotate 90 and Saturation in its popover", { covers: ["paint-type:image", "image-fill:rectangle", "image-fill:mouse", "image-fill:tile", "image-fill:rotate", "image-fill:adjust", "image-fill:fit", "image-fill:fill"] }, async (t: NT) => {
  await t.showPage("style");
  await t.selectIds(["pt_solid"]);
  await t.cmd("qa.paint", { image: tmpImage("Fill photo.png", 120, 80) });
  await t.click(await plusOf(t, "Fill"));
  await t.waitState((s) => s.menu, "the type menu");
  await t.pickMenu("Image…");
  const img = await t.waitDisk(() => { const f = list(t.node("pt_solid")?.fill); return f[1]?.type === "image" && f[1]; }, "an image fill on top");
  t.ok(/^media\/fill-photo-[0-9a-f]{10}\.png$/.test(img.url) && img.mode === "fill", `the image fill: ${JSON.stringify(img)}`);
  t.ok(fs.existsSync(path.join(t.file, img.url)), "the image is copied into the package");
  await t.click(await topRowSwatch(t));
  await popoverOpen(t);
  // The mode menu under the 110 pt preview; Rotate 90 at the right end of its row.
  const modeY = POP.top + 110 + 10 + 14;
  await t.click({ x: POP.x0 + 90, y: modeY }, { window: "popover" });
  await t.waitState((s) => s.menu, "the mode menu");
  await t.pickMenu("Tile");
  await t.waitDisk(() => list(t.node("pt_solid")?.fill)[1]?.mode === "tile", "Tile");
  // Rotate 90: the button at the right end of the mode row.
  await t.click({ x: POP.x0 + POP.w - 14, y: modeY }, { window: "popover" });
  await t.waitDisk(() => list(t.node("pt_solid")?.fill)[1]?.rotation === 90, "turned 90");
  // Saturation -100: the third adjustment's field.
  const fields = await popoverFields(t);
  const adj = fields.slice(-5);
  t.eq(adj.length, 5, "five adjustment fields");
  await typeInto(t, adj[2], "-100");
  await t.waitDisk(() => list(t.node("pt_solid")?.fill)[1]?.adjust?.saturation === -1, "saturation -1");
  await t.shot(path.join(OUT, "fills-image-popover.png"), "popover");
  await closePopover(t);
});

sc("inspector", "Fill + Shader adds a Paper preset; its popover switches the preset", { covers: ["paint-type:shader", "shader-fill-edit:rectangle", "shader-fill-edit:mouse"] }, async (t: NT) => {
  await t.showPage("style");
  await t.selectIds(["pt_corners"]);

  await t.click(await plusOf(t, "Fill"));
  const open = await t.waitState((s) => s.menu, "the type menu");
  t.ok(open.menu.items.includes("Shader"), "a Shader item");
  const shaders = (await t.a.get("/api/shaders/presets")).shaders as { id: string; name: string; presets: string[] }[];
  const s = shaders.find((x) => x.presets.length > 1)!;
  await t.pickMenu(`Shader > ${s.name}`);
  await t.waitDisk(() => list(t.node("pt_corners")?.fill).at(-1)?.shader === s.id, `a ${s.id} fill`);

  await t.click(await topRowSwatch(t));
  await popoverOpen(t);
  // The shader and preset menus side by side on the editor's first row (the preset at its right end).
  await t.click(await popPoint(t, "Default", { x: POP.x0 + POP.w - 30, y: POP.top + 14 }), { window: "popover" });
  await t.waitState((x) => x.menu, "the preset menu");
  await t.pickMenu(s.presets[1]);
  await t.waitDisk(() => list(t.node("pt_corners")?.fill).at(-1)?.preset === s.presets[1], `preset ${s.presets[1]}`);
  await t.shot(path.join(OUT, "fills-shader-popover.png"), "popover");
  await closePopover(t);
});

sc("inspector", "Selection colors: a colour two layers share is listed once; one edit changes both, one undo", { covers: ["selection-colors:many", "selection-colors:mouse"] }, async (t: NT) => {
  await t.showPage("style");
  await t.a.post("/api/update", { file: t.file, id: "pt_stroke", props: { stroke: "#2563EB" } });
  await t.selectIds(["pt_solid", "pt_stroke"]);
  // Fills and strokes differ (Mixed, no hex of their own): the hex fields are the Selection colors rows.
  const f = await t.waitFor(async () => (await t.fields()).find((x) => /^[0-9A-F]{6}$/i.test(x.value)) ?? null, "the Selection colors rows", 8000);
  t.eq(f.value.toUpperCase(), "2563EB", "the most used colour first");
  await t.setField(f, "16A34A");
  await t.waitDisk(() => t.node("pt_solid")?.fill === "#16A34A" && t.node("pt_stroke")?.stroke === "#16A34A", "both layers' blue is green");
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => t.node("pt_solid")?.fill === "#2563EB" && t.node("pt_stroke")?.stroke === "#2563EB", "one undo brings both back");
});

sc("inspector", "I samples a colour into the selection's fill; Control+C too", { covers: ["eyedropper:rectangle", "eyedropper:keyboard", "eyedropper:many"] }, async (t: NT) => {
  await t.showPage("style");
  await t.selectIds(["pt_solid"]);
  await t.cmd("qa.paint", { sample: "#22C55E" });
  await t.click(await t.rect("pt_solid").then(center));
  await t.key("i");
  await t.waitDisk(() => t.node("pt_solid")?.fill === "#22C55E", "the sampled green");
  await t.js(`window.canvasHost.setSelection(["pt_solid", "pt_grad"]);`);
  await t.waitState((s) => s.selection?.ids?.length === 2, "two selected");
  await t.cmd("qa.paint", { sample: "#F43F5E" });
  await t.key("c", ["ctrl"]);
  await t.waitDisk(() => t.node("pt_solid")?.fill === "#F43F5E" && t.node("pt_grad")?.fill === "#F43F5E", "both layers take it");
});

sc("inspector", "Shift+Up in the hex field lightens; the layer blend menu; iOS corner smoothing", { covers: ["paint-keys:keyboard", "blend-mode:layer", "blend-mode:rectangle", "corner-smoothing:rectangle", "corner-smoothing:keyboard"] }, async (t: NT) => {
  await t.showPage("style");
  await t.selectIds(["pt_solid"]);
  const hex = (await t.fields()).find((f) => /^[0-9A-F]{6}$/i.test(f.value))!;
  await t.click(center(hex));
  await sleep(150);
  await t.key("Up", ["shift"]);
  await t.waitDisk(() => typeof t.node("pt_solid")?.fill === "string" && t.node("pt_solid")!.fill !== "#2563EB", "a lighter blue");
  const lighter = String(t.node("pt_solid")!.fill);
  t.ok(parseInt(lighter.slice(1, 3), 16) > 0x25, `lighter: ${lighter}`);
  await t.key("Escape");
  // The layer's blend mode: the icon left of Appearance's eye.
  // The Appearance title line: above the opacity field (the "100" with the radius field beside it).
  const fs = await t.fields();
  const op = fs.find((f) => f.value === "100" && fs.some((g) => g.value === "0" && Math.abs(g.y - f.y) < 2 && g.x > f.x))!;
  await t.click({ x: (await rightEdge(t)) - 44, y: op.y + op.h / 2 - 34 });
  const m = await t.waitState((s) => s.menu, "the blend menu");
  t.ok(m.menu.items.includes("Multiply"), `blend modes: ${m.menu.items.join(", ")}`);
  await t.pickMenu("Multiply");
  await t.waitDisk(() => t.node("pt_solid")?.blendMode === "multiply", "blendMode multiply");
  // Per-corner radii show the corner fields, and smoothing under them.
  await t.selectIds(["pt_corners"]);
  // Corner smoothing: the field under the four corners, the iOS button at the row's right end.
  const cf = await t.fields();
  const br = cf.find((f) => f.value === "24")!;
  const sm = cf.filter((f) => f.y > br.y + 4).sort((a, b) => a.y - b.y)[0];
  await t.click({ x: (await rightEdge(t)) - 10, y: sm.y + sm.h / 2 });
  await t.waitDisk(() => t.node("pt_corners")?.cornerSmoothing === 0.6, "corner smoothing 60%");
});

sc("inspector", "Copy Fill on one layer's row, Paste Fill on another's", { covers: ["copy-paint:rectangle", "copy-paint:mouse"] }, async (t: NT) => {
  await t.showPage("style");
  await t.selectIds(["pt_grad"]);
  // The Fill row (the lowest opacity field), right-clicked on its label.
  const op = (await t.fields()).filter((f) => f.value === "100").sort((a, b) => b.y - a.y)[0];
  await t.click({ x: op.x - 60, y: op.y + op.h / 2 }, { right: true });
  await t.waitState((s) => s.menu, "the row's menu");
  await t.pickMenu("Copy Fill");
  await t.selectIds(["pt_solid"]);
  // The row's swatch (left of the hex) takes the right-click; the hex field would show its own text menu.
  const hex = (await t.fields()).find((f) => /^[0-9A-F]{6}$/i.test(f.value))!;
  await t.click({ x: hex.x - 14, y: hex.y + hex.h / 2 }, { right: true });
  await t.waitState((s) => s.menu, "the row's menu");
  await t.pickMenu("Paste Fill");
  await t.waitDisk(() => list(t.node("pt_solid")?.fill)[0]?.type === "gradient", "the gradient pasted onto the solid's row");
});

sc("inspector", "a text layer's colour picker rates contrast against what is behind", { covers: ["contrast-check:text", "contrast-check:mouse"] }, async (t: NT) => {
  await t.showPage("style");
  await t.selectIds(["ts_cap_a"]);
  const hex = (await t.fields()).find((f) => /^[0-9A-F]{6}$/i.test(f.value))!;
  await t.click({ x: hex.x - 14, y: hex.y + hex.h / 2 });
  const root = await popoverOpen(t);
  // The contrast line under the colour fields ("4.8:1 AA", "Lc 74"): its badges are drawn in the pass (green) or
  // warn (amber) colour, read off the popover's pixels (text recognition is busy when other QA instances share the Mac).
  const badges = { x: root.w / 2, y: 330, w: root.w / 2 - 16, h: 70 };
  const m = await t.waitFor(async () => {
    const px = await t.cmd("qa.pixels", { region: badges, colors: ["#4ADE80", "#22C55E", "#F59E0B"], tol: 30, window: "popover" });
    return px.count > 20 ? px : null;
  }, "the contrast badges", 8000);
  t.ok(m, "the contrast line shows");
  await t.shot(path.join(OUT, "fills-contrast.png"), "popover");
  await closePopover(t);
});

// ---------------------------------------------------------------- Codex review (docs/evidence/review-fixes.md)

// c1: Paste Fill took any app's cc.getcanvas.paint JSON as it was, so an image url like ../../.ssh/id_rsa went into
// the file (and Save As then copied the key into the package). Another app's paint pastes without its files now.
sc("inspector", "review c1: Paste Fill of another app's image paint leaves its file out and says so", { covers: ["copy-paint:rectangle", "copy-paint:mouse"] }, async (t: NT) => {
  await t.showPage("style");
  await t.selectIds(["pt_solid"]);
  const before = JSON.stringify(t.node("pt_solid")?.fill);
  await t.cmd("qa.pasteboard", { paint: JSON.stringify({ v: { type: "image", url: "../../.ssh/id_rsa", mode: "fill" } }) });
  const hex = (await t.fields()).find((f) => /^[0-9A-F]{6}$/i.test(f.value))!;
  await t.click({ x: hex.x - 14, y: hex.y + hex.h / 2 }, { right: true });
  await t.waitState((s) => s.menu, "the row's menu");
  await t.pickMenu("Paste Fill");
  await sleep(800);
  const st = await t.state();
  t.ok(!JSON.stringify(t.disk()).includes(".ssh"), "no layer names the private file");
  t.eq(JSON.stringify(t.node("pt_solid")?.fill), before, "the fill is as it was");
  t.ok(/did not come from Canvas/.test(String(st.toast)), `the toast says why: ${st.toast}`);
  await t.shot(path.join(OUT, "review-c1-paste-fill-refused.png"));
  // Canvas's own copy still pastes (sealed).
  await t.selectIds(["pt_grad"]);
  const op = (await t.fields()).filter((f) => f.value === "100").sort((a, b) => b.y - a.y)[0];
  await t.click({ x: op.x - 60, y: op.y + op.h / 2 }, { right: true });
  await t.waitState((s) => s.menu, "the row's menu");
  await t.pickMenu("Copy Fill");
  t.ok((await t.cmd("qa.pasteboard")).types.includes("cc.getcanvas.paint"), "Canvas's copy is on the pasteboard");
  await t.selectIds(["pt_solid"]);
  const hex2 = (await t.fields()).find((f) => /^[0-9A-F]{6}$/i.test(f.value))!;
  await t.click({ x: hex2.x - 14, y: hex2.y + hex2.h / 2 }, { right: true });
  await t.waitState((s) => s.menu, "the row's menu");
  await t.pickMenu("Paste Fill");
  await t.waitDisk(() => list(t.node("pt_solid")?.fill)[0]?.type === "gradient", "Canvas's own copy pastes");
});

// c5: an image upload's answer applied to whatever was selected when it came back, with the first layer's paint list.
sc("inspector", "review c5: an image chosen for one layer never lands on the layer selected while it uploads", { covers: ["image-fill:rectangle", "image-fill:mouse"] }, async (t: NT) => {
  await t.showPage("style");
  await t.selectIds(["pt_solid"]);
  const grad = JSON.stringify(t.node("pt_grad")?.fill);
  await t.cmd("qa.paint", { image: tmpImage("Slow photo.png", 60, 40), delay: 2.5 });
  await t.click(await plusOf(t, "Fill"));
  await t.waitState((s) => s.menu, "the type menu");
  await t.pickMenu("Image…");
  // While the upload's answer is held: another layer.
  await t.selectIds(["pt_grad"]);
  await sleep(4000);
  t.eq(JSON.stringify(t.node("pt_grad")?.fill), grad, "the layer selected meanwhile keeps its fill");
  t.ok(!list(t.node("pt_grad")?.fill).some((p) => p?.type === "image"), "no image on it");
});

// c4: queued Selection colors writes took the current document when their turn came (with the first one's layer
// ids): a tab switched while one was out sent the next to the other document.
sc("inspector", "review c4: a queued Selection colors edit goes to its own document after a tab switch", { covers: ["selection-colors:many", "selection-colors:mouse"] }, async (t: NT) => {
  await t.showPage("style");
  await t.a.post("/api/update", { file: t.file, id: "pt_stroke", props: { stroke: "#2563EB" } });
  await t.a.flush();
  // The other document: the same layer ids (Save As keeps them), its pt_solid already the colour the second edit starts from.
  const other = t.file.replace(/\.canvas$/, "-other.canvas");
  copyDir(t.file, other);
  const od = JSON.parse(fs.readFileSync(path.join(other, "document.json"), "utf8"));
  const seek = (ns: any[]): any => { for (const n of ns ?? []) { if (n.id === "pt_solid") return n; const h = seek(n.children); if (h) return h; } };
  seek(od.children).fill = "#16A34A";
  fs.writeFileSync(path.join(other, "document.json"), JSON.stringify(od, null, 2));
  try {
    await t.selectIds(["pt_solid", "pt_stroke"]);
    const f = await t.waitFor(async () => (await t.fields()).find((x) => /^[0-9A-F]{6}$/i.test(x.value)) ?? null, "the Selection colors rows", 8000);
    await t.cmd("qa.paint", { delay: 3 });
    await t.setField(f, "16A34A"); // out, its answer held
    await sleep(1200); // a new gesture
    const f2 = (await t.fields()).find((x) => /^[0-9A-F]{6}$/i.test(x.value))!;
    await t.setField(f2, "DC2626"); // queued behind it
    await t.app.cmd({ op: "open", args: { file: other }, timeoutMs: 15_000 });
    await sleep(7000);
    const otherNow = seek(JSON.parse(fs.readFileSync(path.join(other, "document.json"), "utf8")).children);
    t.eq(otherNow.fill, "#16A34A", "the other document is untouched");
    t.eq([t.node("pt_solid")?.fill, t.node("pt_stroke")?.stroke], ["#DC2626", "#DC2626"], "both edits landed in their own document");
  } finally {
    await t.cmd("qa.paint", { delay: 0 });
    await t.app.cmd({ op: "close", args: { file: other }, timeoutMs: 10_000 }).catch(() => {});
    fs.rmSync(other, { recursive: true, force: true });
  }
});
