// Native scenarios for the inspector's paint rows and instance fields (apps/macos/InspectorPaint.swift,
// PaintEditor.swift, main.swift StructureActions): a click on the area left of a paint's swatch picks that row
// (grey), Cmd+C copies its paint, Cmd+V replaces it (or, with no row picked, goes on top of the list it came
// from), a picture pasted onto an image row replaces the picture and keeps its mode, crop and adjustments; Delete
// and Esc on a picked row; the canvas's own Copy and Paste with no row picked; and right-click Reset on an
// instance's overridden Fill, Opacity and text fields. Controls are found by their .qaID marks, the clipboard is the
// QA instance's own (qa.pasteboard).
import fs from "node:fs";
import path from "node:path";
import { center, NT, sc } from "./harness.ts";
import { ROOT, gradientPng, sleep } from "../lib.ts";

const OUT = path.join(ROOT, "qa", "out", "native");
const list = (v: unknown): any[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** The pick area of a paint row (left of its swatch): `key` fill, stroke or effect; row 0 is the top one. */
async function rowArea(t: NT, key: string, row = 0) { return inView(t, { id: `paint-row:${key}:${row}` }); }
/** A marked control, the inspector scrolled until it shows whole (a tall instance inspector puts Fill below the fold). */
async function inView(t: NT, o: { id?: string; label?: string }) {
  const st = await t.state();
  const region = { x: st.window.width - 380, y: 60, w: 380, h: st.window.height - 60 };
  for (let i = 0; i < 24; i++) {
    const m = (await t.marks({ ...o, region }))[0];
    if (m && m.y + m.h < st.window.height - 120 && m.h > 4) return t.mark({ ...o, region });
    await t.scroll({ x: st.window.width - 150, y: st.window.height / 2 }, 0, -150);
    await sleep(250);
  }
  return t.mark({ ...o, region }, 3000);
}
/** JSON with sorted keys, for comparing a paint read off disk. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
async function pickRow(t: NT, key: string, row = 0) {
  await t.click(center(await rowArea(t, key, row)));
  await t.waitState((s) => s.selection?.paintRow?.key === key && s.selection.paintRow.row === row, `the ${key} row ${row} picked`);
}
async function noRow(t: NT, what: string) { await t.waitState((s) => s.selection && s.selection.paintRow === null, what); }
async function pasteboard(t: NT) { return (await t.cmd("qa.pasteboard")) as { types: string[]; strings: Record<string, string | null> }; }
async function inspectorShot(t: NT, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await t.shot(path.join(OUT, `${name}.png`));
}

sc("inspector", "paint row: pick a fill row, Cmd+C, Cmd+V onto another layer's row; Esc, a click and a new selection let it go", { covers: ["copy-paint:rectangle", "copy-paint:keyboard", "copy-paint:mouse"] }, async (t: NT) => {
  await t.showPage("style");
  await t.selectIds(["pt_grad"]);
  await pickRow(t, "fill");
  t.eq((await rowArea(t, "fill")).label, "selected", "the picked row draws selected");
  await inspectorShot(t, "gaps-paint-row-picked");
  await t.key("c", ["cmd"]);
  const pb = await t.waitFor(async () => { const p = await pasteboard(t); return p.types.includes("cc.getcanvas.paint") && p; }, "the gradient on the pasteboard");
  t.ok(!pb.types.includes("cc.getcanvas.canvas.clipboard"), `the canvas did not copy layers too: ${pb.types.join(", ")}`);
  t.eq(pb.strings["cc.getcanvas.paint.list"], "fill", "it came from a fill row");
  // Another layer: the pick goes with the old selection.
  await t.selectIds(["pt_solid"]);
  await noRow(t, "no row picked on the new selection");
  await pickRow(t, "fill");
  await t.key("v", ["cmd"]);
  await t.waitDisk(() => list(t.node("pt_solid")?.fill)[0]?.type === "gradient" && list(t.node("pt_solid")?.fill).length === 1, "the solid's row replaced by the gradient");
  t.ok(t.node("pt_solid") && t.disk().children.length > 0, "the layer is still there");
  // Esc lets the row go and keeps the canvas selection.
  await t.key("Escape");
  await noRow(t, "Esc lets the row go");
  t.eq((await t.state()).selection?.id, "pt_solid", "Esc did not deselect the layer");
  // A click elsewhere (the Fill title) lets it go too.
  await pickRow(t, "fill");
  await t.click(center(await t.mark({ label: "Fill" })));
  await noRow(t, "a click elsewhere lets the row go");
  // One Cmd+Z takes the paste back.
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => t.node("pt_solid")?.fill === "#2563EB", "one undo brings the blue back");
});

sc("inspector", "paint row: with no row picked a copied paint goes on top of its own list; stroke and effect rows; Delete removes one", { covers: ["copy-paint:rectangle", "copy-paint:keyboard", "copy-paint:stroke", "copy-paint:effect"] }, async (t: NT) => {
  await t.showPage("style");
  const shadow = { type: "shadow", shadowType: "outer", color: "#00000040", offset: { x: 0, y: 4 }, blur: 12, spread: 0 };
  await t.a.post("/api/update", { file: t.file, id: "pt_corners", props: { effect: shadow } });
  await t.a.flush();
  // A fill copied, pasted with nothing picked: on top of the target's fills (the property is pasted onto the layer).
  await t.selectIds(["pt_grad"]);
  await pickRow(t, "fill");
  await t.key("c", ["cmd"]);
  await t.waitFor(async () => (await pasteboard(t)).types.includes("cc.getcanvas.paint"), "the gradient copied");
  await t.selectIds(["pt_stroke"]);
  await t.key("v", ["cmd"]);
  const f = await t.waitDisk(() => { const l = list(t.node("pt_stroke")?.fill); return l.length === 2 && l; }, "a second fill on the stroked rectangle");
  t.eq([f[0], f[1].type], ["#FFFFFF", "gradient"], "the gradient on top, the white kept");
  // The stroke row: copied, pasted with nothing picked onto a layer with no stroke: a 1 px stroke.
  await pickRow(t, "stroke");
  await t.key("c", ["cmd"]);
  await t.waitFor(async () => (await pasteboard(t)).strings["cc.getcanvas.paint.list"] === "stroke", "the stroke copied");
  await t.selectIds(["pt_solid"]);
  await t.key("v", ["cmd"]);
  await t.waitDisk(() => t.node("pt_solid")?.stroke === "#0F172A" && t.node("pt_solid")?.strokeWidth === 1, "the stroke on the solid, 1 px");
  t.eq(t.node("pt_solid")!.fill, "#2563EB", "its fill untouched");
  // An effect row.
  await t.selectIds(["pt_corners"]);
  await pickRow(t, "effect");
  await t.key("c", ["cmd"]);
  await t.waitFor(async () => (await pasteboard(t)).types.includes("cc.getcanvas.effect"), "the shadow copied");
  await t.selectIds(["pt_solid"]);
  await t.key("v", ["cmd"]);
  await t.waitDisk(() => list(t.node("pt_solid")?.effect)[0]?.blur === 12, "the shadow on the solid");
  // Delete on a picked row removes that paint, not the layer.
  await pickRow(t, "stroke");
  await t.key("Delete");
  await t.waitDisk(() => t.node("pt_solid") && t.node("pt_solid")!.stroke === undefined && t.node("pt_solid")!.strokeWidth === undefined, "the stroke removed");
  t.ok(t.node("pt_solid"), "the layer stays");
  await inspectorShot(t, "gaps-paint-row-effect");
});

sc("clipboard", "paint row: with no row picked, Cmd+C and Cmd+V still copy and paste layers on the canvas", { covers: ["copy-paste:rectangle", "copy-paste:keyboard"] }, async (t: NT) => {
  await t.showPage("style");
  // A row picked, then let go by a new canvas selection: the next Cmd+C is the canvas's.
  await t.selectIds(["pt_grad"]);
  await pickRow(t, "fill");
  await t.selectIds(["pt_solid"]);
  await noRow(t, "the row let go");
  const before = JSON.stringify(t.disk()).match(/"id":/g)!.length;
  await t.key("c", ["cmd"]);
  await t.waitFor(async () => (await pasteboard(t)).types.includes("cc.getcanvas.canvas.clipboard"), "Canvas's copy of the layer on the pasteboard");
  t.ok(!(await pasteboard(t)).types.includes("cc.getcanvas.paint"), "no paint copied");
  await t.key("v", ["cmd"]);
  await t.waitDisk(() => JSON.stringify(t.disk()).match(/"id":/g)!.length === before + 1, "a pasted copy of the layer");
  const sel = (await t.state()).selection;
  t.ok(sel && sel.id !== "pt_solid" && sel.node.fill === "#2563EB", `the copy is selected: ${JSON.stringify(sel?.id)}`);
  // Esc on the canvas with no row picked still reaches the canvas (it lets the copy go; the row's Esc does not take it).
  await t.key("Escape");
  await t.waitState((s) => s.selection?.id !== sel.id, "Esc on the canvas lets the copy go");
});

sc("inspector", "paint row: Cmd+V with a picture on an image fill's row replaces the picture, keeps crop, rotation and adjustments", { covers: ["image-fill:rectangle", "image-fill:keyboard", "image-fill:paste", "image-fill:crop"] }, async (t: NT) => {
  await t.showPage("style");
  fs.mkdirSync(path.join(t.file, "media"), { recursive: true });
  fs.writeFileSync(path.join(t.file, "media", "qa-old.png"), gradientPng(80, 60));
  const img = { type: "image", url: "media/qa-old.png", mode: "crop", crop: { x: -0.25, y: 0, width: 1.5, height: 1 }, rotation: 90, adjust: { saturation: -0.5 }, opacity: 0.8 };
  await t.a.post("/api/update", { file: t.file, id: "pt_corners", props: { fill: ["#6366F1", img] } });
  await t.a.flush();
  await t.selectIds(["pt_corners"]);
  await pickRow(t, "fill", 0);
  await t.cmd("qa.pasteboard", { png: gradientPng(40, 30).toString("base64") });
  await t.key("v", ["cmd"]);
  const f = await t.waitDisk(() => { const l = list(t.node("pt_corners")?.fill); return l.length === 2 && l[1]?.url !== "media/qa-old.png" && l; }, "a new picture in the image row", 10_000);
  t.ok(/^media\/.+\.png$/.test(f[1].url) && fs.existsSync(path.join(t.file, f[1].url)), `the picture copied into the package: ${f[1].url}`);
  const { url, ...kept } = f[1];
  const { url: _old, ...want } = img;
  t.eq(canon(kept), canon(want), "mode, crop, rotation, adjustments and opacity kept");
  t.eq(f[0], "#6366F1", "the colour row under it untouched");
  t.eq(list(t.node("pt_corners")?.fill).length, 2, "no new layer, no new fill");
  await sleep(600);
  await inspectorShot(t, "gaps-paint-image-replaced");
  // One Cmd+Z: the old picture.
  await t.key("Escape");
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => list(t.node("pt_corners")?.fill)[1]?.url === "media/qa-old.png", "one undo brings the old picture back");
});

sc("components", "right-click an overridden Fill, Opacity or text field on an instance and Reset it; no Reset without an override", { covers: ["reset-overrides:instance", "reset-overrides:in-instance", "reset-overrides:one", "reset-overrides:mouse", "reset-overrides:field"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("components");
  await t.a.post("/api/update", { file: t.file, id: "inst_fill", props: { opacity: 0.5 } });
  await t.a.flush();
  await t.selectIds(["inst_fill"]);
  // Opacity: right-click the Appearance section by its opacity field's icon.
  // A person scrolls the tall instance inspector until the field shows whole.
  const stw = await t.state();
  let op = await t.waitFor(async () => (await t.fields()).find((f) => f.value === "50") ?? null, "an opacity field reading 50", 8000);
  for (let i = 0; i < 24 && op.y + op.h > stw.window.height - 120; i++) {
    await t.scroll({ x: stw.window.width - 150, y: stw.window.height / 2 }, 0, -150);
    await sleep(250);
    op = (await t.fields()).find((f) => f.value === "50") ?? op;
  }
  await t.click({ x: op.x - 10, y: op.y + op.h / 2 }, { right: true });
  const m2 = await t.waitState((s) => s.menu, "the Appearance menu");
  t.ok(m2.menu.items.includes("Reset opacity"), `Reset opacity: ${m2.menu.items.join(", ")}`);
  t.ok(!m2.menu.items.includes("Reset fill"), "the fill is not the Appearance section's");
  await t.pickMenu("Reset opacity");
  await t.waitDisk(() => t.node("inst_fill")?.opacity === undefined, "the opacity override gone");
  t.eq(t.node("inst_fill")!.fill, "#DC2626", "the fill override stays");
  // The Fill row: right-click its swatch (right of the row's pick area).
  const area = await rowArea(t, "fill");
  await t.click({ x: area.x + area.w + 10, y: area.y + area.h / 2 }, { right: true });
  const m = await t.waitState((s) => s.menu, "the fill row's menu");
  t.ok(m.menu.items.includes("Reset fill"), `Reset fill in the row's menu: ${m.menu.items.join(", ")}`);
  await t.pickMenu("Reset fill");
  await t.waitDisk(() => t.node("inst_fill")?.fill === undefined, "the fill override gone");
  // No override: no Reset. The plain instance's fill row menu has Copy Fill only; its Appearance has no menu.
  await t.selectIds(["inst_plain"]);
  const a2 = await rowArea(t, "fill");
  await t.click({ x: a2.x + a2.w + 10, y: a2.y + a2.h / 2 }, { right: true });
  const m3 = await t.waitState((s) => s.menu, "the plain instance's fill row menu");
  t.ok(!m3.menu.items.some((i: string) => i.startsWith("Reset")), `no Reset without an override: ${m3.menu.items.join(", ")}`);
  await t.cmd("qa.menu", { cancel: true }).catch(() => {});
  await t.key("Escape").catch(() => {});
  await sleep(300);
  // A text layer inside an instance: right-click the font family field, Reset font size alone.
  await t.selectIds(["inst_font/cmp_button_label"]);
  const fam = await inView(t, { label: "Typography" });
  await t.click({ x: fam.x + 40, y: fam.y + fam.h / 2 + 30 }, { right: true });
  const m4 = await t.waitState((s) => s.menu, "the Typography menu");
  t.ok(m4.menu.items.includes("Reset font size") && m4.menu.items.includes("Reset font weight"), `the text overrides: ${m4.menu.items.join(", ")}`);
  await t.pickMenu("Reset font size");
  await t.waitDisk(() => { const d = t.node("inst_font")?.descendants?.cmp_button_label; return d && d.fontSize === undefined && d; }, "fontSize reset");
  t.eq(t.node("inst_font")!.descendants.cmp_button_label, { fontWeight: "400" }, "Font weight stays overridden");
  await sleep(400);
  await inspectorShot(t, "gaps-paint-reset-field");
});
