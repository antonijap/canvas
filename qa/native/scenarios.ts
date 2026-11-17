// Native scenarios (pnpm qa:native): what the browser runner cannot reach. The sidebar's drags, the SwiftUI
// inspector's fields, menus, the palette and the Settings window, driven by real NSEvents in a QA instance of the
// app. Each scenario starts on a fresh copy of demos/playground.canvas (pages Layout, Components, Style, Cards).
import { center, NT, sc, type Pt } from "./harness.ts";
import { checkDragFrames, clientRects, dragBoard, type Driver } from "../frames.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLAYGROUND } from "../playground.ts";
import { execFileSync } from "node:child_process";
import { ROOT, copyDir, gradientPng, sleep } from "../lib.ts";
import { buildLink, parseLink } from "../../src/page/link-logic.js";
import "./scenarios-paste.ts";
import "./scenarios-firstrun.ts";
import { intoInspector } from "./scenarios-leftovers.ts";

/** The canvas area well clear of the panels (window points). */
const CANVAS_SPOT: Pt = { x: 900, y: 640 };
const SEL_BLUE = ["#3B82F6", "#0766EB"];

/** A point on the canvas in world space: the card dropped there should be centred on it. */
async function dropWorld(t: NT, p: Pt) { return t.world(p); }

// ---------------------------------------------------------------- the sidebar's drags

sc("widgets", "drag a widget from the library onto the canvas", { covers: ["card-add:card-note"] }, async (t: NT) => {
  await t.section("Widgets");
  const st = await t.state();
  const kind = st.widgetKinds.find((k: any) => k.id === "note") ?? st.widgetKinds[0];
  t.ok(kind, "the Widgets panel lists no kinds");
  const before = t.widgets().widgets.length;
  const from = await t.textAt(kind.title, { x: 60, y: 60, w: 250, h: 400 });
  const want = await dropWorld(t, CANVAS_SPOT);
  const r = await t.drag(from, CANVAS_SPOT, { steps: 20 });
  t.ok(r.systemDrag, `the row did not start a drag (${JSON.stringify(r)})`);
  t.eq(r.drop.target, "CanvasWebView", "the drop landed on (the canvas web view)");
  const w = await t.waitDisk(() => { const ws = t.widgets().widgets; return ws.length > before && ws[ws.length - 1]; }, "a new card");
  t.eq(w.kind, kind.id, "the new card's kind");
  const cx = w.x + (w.w ?? w.width ?? 0) / 2, cy = w.y + (w.h ?? w.height ?? 0) / 2;
  t.near(cx, want.x, 24, "the card's centre x (world)");
  t.near(cy, want.y, 24, "the card's centre y (world)");
});

sc("widgets", "drag a shader tile onto empty canvas: a shader card", { covers: ["card-add:card-shader", "shaders:card-shader"] }, async (t: NT) => {
  // Far from every board: over a layer the tile would fill it instead.
  await t.look(-6000, -6000);
  await t.section("Widgets");
  const st = await t.waitState((s) => s.paperShaders.length > 0, "the shader tiles");
  const shader = st.paperShaders[0];
  const before = t.widgets().widgets.length;
  const at = await t.textAt(shader.name, { x: 60, y: 60, w: 250, h: 900 });
  // The tile's picture sits above its name: grab the picture.
  const from = { x: at.x, y: at.y - 30 };
  const want = await dropWorld(t, CANVAS_SPOT);
  const r = await t.drag(from, CANVAS_SPOT, { steps: 20 });
  t.ok(r.systemDrag, `the tile did not start a drag (${JSON.stringify(r)})`);
  const w = await t.waitDisk(() => { const ws = t.widgets().widgets; return ws.length > before && ws[ws.length - 1]; }, "a new shader card");
  t.ok(/shader/i.test(w.kind), `the new card is a ${w.kind}, not a shader`);
  const cx = w.x + (w.w ?? w.width ?? 0) / 2, cy = w.y + (w.h ?? w.height ?? 0) / 2;
  t.near(cx, want.x, 24, "the shader card's centre x (world)");
  t.near(cy, want.y, 24, "the shader card's centre y (world)");
  // It draws: within a few seconds the card is the shader's colours, not the empty dark card.
  const st2 = await t.state();
  const card = await t.js<{ x: number; y: number; w: number; h: number }>(`const h = window.canvasHost, c = h.cam; return { x: h.viewBox.l + ${w.x} * c.z + c.x, y: h.viewBox.t + ${w.y} * c.z + c.y, w: ${w.w} * c.z, h: ${w.h} * c.z };`);
  const region = { x: card.x + st2.webFrame.x + card.w * 0.2, y: card.y + st2.webFrame.y + card.h * 0.2, w: card.w * 0.6, h: card.h * 0.6 };
  const t0 = Date.now();
  let dark = 1;
  while (Date.now() - t0 < 8000) {
    const px = await t.cmd("qa.pixels", { region, colors: ["#1C1C1E", "#232325", "#262628", "#2C2C2E", "#000000"], tol: 14 });
    dark = px.count / Math.max(1, px.total);
    if (dark < 0.5) return;
    await sleep(300);
  }
  throw new Error(`the shader card stayed dark (${Math.round(dark * 100)}% dark pixels after 8 s)`);
});

/** Share of a window region's pixels in `colors` (within tol). */
async function share(t: NT, region: { x: number; y: number; w: number; h: number }, colors: string[], tol = 10) {
  const px = await t.cmd("qa.pixels", { region, colors, tol });
  return px.count / Math.max(1, px.total);
}
/** A w x h PNG on disk: a two-colour diagonal gradient (qa/scenarios-drops.ts). */
function tmpPng(name: string, w: number, h: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-native-img-"));
  const f = path.join(dir, name);
  fs.writeFileSync(f, gradientPng(w, h));
  return f;
}

/** Wait until layer `id` draws something other than `bg` (an image layer over its frame's colour). */
async function waitDrawn(t: NT, id: string, bg: string, what: string) {
  const t0 = Date.now();
  let same = 1;
  while (Date.now() - t0 < 10000) {
    const r = await t.rect(id).catch(() => null);
    if (r) {
      same = await share(t, { x: r.x + 3, y: r.y + 3, w: Math.max(4, r.w - 6), h: Math.max(4, r.h - 6) }, [bg], 8);
      if (same < 0.2) return;
    }
    await sleep(300);
  }
  throw new Error(`${what} does not draw (${Math.round(same * 100)}% of it is still ${bg} after 10 s)`);
}

sc("widgets", "drag a shader tile onto a frame, no keys held: the frame's fill, drawn in it", { covers: ["shader-fill:frame", "shader-fill:mouse", "shader-fill:outline"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.look(0, 0);
  await t.section("Widgets");
  const st = await t.waitState((s) => s.paperShaders.length > 0, "the shader tiles");
  const shader = st.paperShaders.find((s: any) => s.id === "mesh-gradient") ?? st.paperShaders[0];
  const at = await t.textAt(shader.name, { x: 60, y: 60, w: 250, h: 900 });
  const fr = await t.rect("fr_outer");
  const to = { x: fr.x + 12, y: fr.y + fr.h - 12 };
  const cards = t.widgets().widgets.length;
  const r = await t.drag({ x: at.x, y: at.y - 30 }, to, { steps: 20 });
  t.ok(r.systemDrag, `the tile did not start a drag (${JSON.stringify(r)})`);
  const fill = await t.waitDisk(() => { const f = t.node("fr_outer")?.fill; return Array.isArray(f) && f; }, "the frame's new fill");
  t.eq(fill.at(-1), { type: "shader", shader: shader.id, preset: "Default" }, "the shader fill on top");
  t.eq(t.widgets().widgets.length, cards, "no card was added");
  // It draws: the frame's own colour gives way to the shader's within a few seconds.
  const region = { x: fr.x + 4, y: fr.y + fr.h - 34, w: 40, h: 30 };
  const t0 = Date.now();
  let old = 1;
  while (Date.now() - t0 < 10000) {
    old = await share(t, region, ["#EEF2FF"], 6);
    if (old < 0.2) return;
    await sleep(300);
  }
  throw new Error(`the frame still shows its old colour (${Math.round(old * 100)}% after 10 s)`);
});

sc("widgets", "Option-drag a shader tile onto a frame: a card, the frame keeps its fill", { covers: ["shader-fill:option-card", "shader-fill:mouse"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.look(0, 0);
  await t.section("Widgets");
  const st = await t.waitState((s) => s.paperShaders.length > 0, "the shader tiles");
  const shader = st.paperShaders.find((s: any) => s.id === "mesh-gradient") ?? st.paperShaders[0];
  const at = await t.textAt(shader.name, { x: 60, y: 60, w: 250, h: 900 });
  const fr = await t.rect("fr_outer");
  const to = { x: fr.x + 12, y: fr.y + fr.h - 12 };
  const fill0 = JSON.stringify(t.node("fr_outer")?.fill);
  const cards = t.widgets().widgets.length;
  const r = await t.drag({ x: at.x, y: at.y - 30 }, to, { steps: 20, mods: ["alt"] });
  t.ok(r.systemDrag, `the tile did not start a drag (${JSON.stringify(r)})`);
  await t.waitDisk(() => t.widgets().widgets.length > cards, "a new shader card");
  t.eq(JSON.stringify(t.node("fr_outer")?.fill), fill0, "the frame's fill is unchanged");
});

sc("widgets", "Cmd-drag a shader card onto a board: its shader is the board's fill, the card stays", { covers: ["shader-fill:card", "shader-fill:mouse"] }, async (t: NT) => {
  await t.section("Layers"); // a scenario before may have left the Widgets section open: the page rows live under Layers
  await t.showPage("cards");
  await t.look(-20, -20, 0.6, 40);
  const card = t.widgets().widgets.find((w: any) => w.kind === "shader" && w.config.paper);
  t.ok(card, "the playground's shader card");
  const st = await t.state();
  const box = await t.waitFor(() => t.js<{ x: number; y: number; w: number; h: number } | null>(`const e = document.querySelector('.wd[data-id="widget:${card.id}"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height };`), "the shader card drawn");
  const from = { x: st.webFrame.x + box.x + box.w / 2, y: st.webFrame.y + box.y + box.h / 2 };
  const b = await t.rect("crd_board");
  const fill0 = t.node("crd_board")?.fill;
  await t.drag(from, { x: b.x + 220, y: b.y + b.h / 2 }, { steps: 20, mods: ["cmd"] });
  const f = await t.waitDisk(() => { const x = t.node("crd_board")?.fill; return Array.isArray(x) && x; }, "the board's shader fill");
  t.eq(f[0], fill0, "the old fill stays under the shader");
  t.eq({ type: f.at(-1).type, shader: f.at(-1).shader }, { type: "shader", shader: card.config.paper.shader }, "the card's shader on top");
  const now = t.widgets().widgets.find((w: any) => w.id === card.id);
  t.eq({ x: now.x, y: now.y }, { x: card.x, y: card.y }, "the card is back where it was");
  // It draws: the board's white gives way to the shader within a few seconds.
  const region = { x: b.x + b.w - 120, y: b.y + 10, w: 60, h: 40 };
  const t0 = Date.now();
  let old = 1;
  while (Date.now() - t0 < 10000) {
    old = await share(t, region, ["#FFFFFF"], 6);
    if (old < 0.2) break;
    await sleep(300);
  }
  t.ok(old < 0.2, `the board still shows its old colour (${Math.round(old * 100)}% after 10 s)`);
  await t.shot(`${process.cwd()}/qa/out/native/gaps-card-fill.png`);
});

sc("widgets", "drag image files from Finder onto a frame: image layers; Cmd onto an ellipse: its fill", { covers: ["image-drop:frame", "image-drop:in-frame", "image-drop:many", "image-drop:fill"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.look(640, 0);
  const fr = await t.rect("fr_plain");
  const kids0 = (t.node("fr_plain")?.children ?? []).length;
  const files = [tmpPng("Finder one.png", 60, 40), tmpPng("Finder two.png", 40, 40)];
  const r = await t.cmd("qa.files", { files, from: [fr.x + fr.w / 2 - 200, fr.y - 100], to: [fr.x + fr.w / 2, fr.y + fr.h / 2] });
  t.eq(r.drop.target, "CanvasWebView", "the drop landed on (the canvas web view)");
  const kids = await t.waitDisk(() => { const k = t.node("fr_plain")?.children ?? []; return k.length >= kids0 + 2 && k.slice(kids0); }, "two image layers in the frame");
  t.eq(kids.map((k: any) => [k.name, k.width, k.height, k.fill?.type]), [["Finder one", 60, 40, "image"], ["Finder two", 40, 40, "image"]], "the image layers");
  for (const k of kids) await waitDrawn(t, String(k.id), "#FEF3C7", `the image layer ${k.name}`);
  t.ok(kids.every((k: any) => fs.existsSync(path.join(t.file, k.fill.url))), "the images are copied into the package");
  // Cmd: the image fills the layer under the pointer.
  await t.look(1240, 540);
  const ell = await t.rect("rz_ell");
  await t.cmd("qa.files", { files: [tmpPng("Finder fill.png", 80, 50)], from: [ell.x - 150, ell.y - 80], to: [ell.x + ell.w / 2, ell.y + ell.h / 2], mods: ["cmd"] });
  const f = await t.waitDisk(() => { const x = t.node("rz_ell")?.fill; return Array.isArray(x) && x; }, "the ellipse's image fill");
  t.ok(f.at(-1).type === "image" && /^media\/finder-fill-[0-9a-f]{10}\.png$/.test(f.at(-1).url), `the image fill: ${JSON.stringify(f)}`);
  await waitDrawn(t, "rz_ell", "#C084FC", "the ellipse's image fill");
});

sc("widgets", "Cmd+V with a screenshot on the pasteboard pastes an image layer", { covers: ["image-paste:keyboard", "image-paste:in-frame"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.look(640, 0);
  await t.selectIds(["fr_plain"]);
  const kids0 = (t.node("fr_plain")?.children ?? []).length;
  await t.cmd("qa.pasteboard", { png: gradientPng(64, 48).toString("base64") });
  await t.key("v", ["cmd"]);
  const kids = await t.waitDisk(() => { const k = t.node("fr_plain")?.children ?? []; return k.length > kids0 && k.slice(kids0); }, "the pasted image layer");
  t.eq(kids.map((k: any) => [k.name, k.width, k.height, k.fill?.type]), [["Pasted image", 64, 48, "image"]], "the pasted layer");
  await waitDrawn(t, String(kids[0].id), "#FEF3C7", "the pasted image");
});

sc("pages", "reorder pages by drag, no drop line left", { covers: ["page-crud:board", "pages:mouse"] }, async (t: NT) => {
  await t.section("Layers");
  const cards = await t.pageRow("cards"), layout = await t.pageRow("layout");
  const r = await t.drag(center(cards.r), { x: layout.r.x + layout.r.w / 2, y: layout.r.y + 5 });
  t.ok(r.systemDrag && r.drop.performed, `the page drag did not drop (${JSON.stringify(r)})`);
  await t.waitState((s) => s.pages[0]?.id === "cards", "Cards to be the first page");
  const order = await t.waitDisk(() => { const p = t.widgets().pages.map((x: any) => x.id); return p[0] === "cards" && p; }, "the new page order");
  t.eq(order, ["cards", "layout", "components", "style"], "page order on disk");
  // The blue drop line goes once the drag ends.
  await sleep(700);
  const rows = await t.rows();
  const top = rows.pages[0].r, bottom = rows.pages[rows.pages.length - 1].r;
  const px = await t.cmd("qa.pixels", { region: { x: top.x, y: top.y - 4, w: top.w, h: bottom.y + bottom.h - top.y + 8 }, colors: SEL_BLUE, tol: 30 });
  t.ok(px.count < 20, `a blue drop line stayed in the pages list (${px.count} blue pixels)`);
});

sc("pages", "drag a board onto another page", { covers: ["pages:board", "pages:other-page", "pages:mouse"] }, async (t: NT) => {
  await t.section("Layers");
  const row = await t.layerRow("lay_clip");
  const style = await t.pageRow("style");
  const r = await t.drag(center(row.r), center(style.r));
  t.ok(r.systemDrag && r.drop.performed, `the board drag did not drop (${JSON.stringify(r)})`);
  const pages = await t.waitDisk(() => { const p = t.widgets().pages; return p.find((x: any) => x.id === "style")?.boards.includes("lay_clip") && p; }, "lay_clip on the Style page");
  t.ok(!pages.find((x: any) => x.id === "layout").boards.includes("lay_clip"), "lay_clip is still on Layout");
  await t.waitState((s) => !s.boards.includes("lay_clip"), "the board to leave the shown page");
});

// ---------------------------------------------------------------- the palette

sc("palette", "Cmd+K opens, searches and runs a command", { covers: ["palette:keyboard"] }, async (t: NT) => {
  await t.click(CANVAS_SPOT);
  await t.key("k", ["cmd"]);
  await t.waitState((s) => s.palette.open, "the palette to open");
  await t.type("zoom to 100");
  const st = await t.waitState((s) => s.palette.items.some((i: string) => /Zoom to 100%/.test(i)), "Zoom to 100% in the results");
  t.ok(st.palette.query === "zoom to 100", `the palette's query is "${st.palette.query}"`);
  await t.key("Return");
  await t.waitState((s) => !s.palette.open && s.zoom === 100, "the palette to close at 100%");
});

// ---------------------------------------------------------------- menus

/** The zoom pill's percentage (bottom right), whatever it reads now. */
async function zoomPercent(t: NT): Promise<Pt> {
  // The percentage in the zoom pill (bottom right): its frame from the QA build, no text recognition needed.
  const st = await t.waitState((s) => s.frames?.["zoom.percent"], "the zoom pill's percentage");
  return center(st.frames["zoom.percent"]);
}

/** Opens the zoom pill's popover and waits until it is on screen. */
async function openZoomField(t: NT) {
  await t.click(await zoomPercent(t));
  await t.waitState((s) => s.zoomFieldOpen && s.popoverShown, "the zoom popover on screen");
  await sleep(200);
}

/** Opens the zoom pill's popover (the percentage, bottom right) and clicks `item` in it. */
async function zoomMenu(t: NT, item: string) {
  await openZoomField(t);
  const st = await t.waitState((s) => s.frames?.["zoom.choice." + item], `"${item}" in the zoom popover`);
  await t.click(center(st.frames["zoom.choice." + item]), { window: "popover" });
  await t.waitState((s) => !s.zoomFieldOpen, "the zoom popover to close");
  await sleep(150);
}

/** The shown page's boards (union, page px) and the view. */
async function fitCheck(t: NT) {
  const st = await t.state();
  return t.js<{ union: { x: number; y: number; w: number; h: number }; view: { w: number; h: number } }>(`
    const h = window.canvasHost, c = h.cam;
    const rs = ${JSON.stringify(st.boards)}.map((id) => h.worldRectOf(id)).filter(Boolean);
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    return { union: { x: h.viewBox.l + x0 * c.z + c.x, y: h.viewBox.t + y0 * c.z + c.y, w: (x1 - x0) * c.z, h: (y1 - y0) * c.z }, view: { w: innerWidth, h: innerHeight } };`);
}

sc("menus", "zoom pill menu: 100%, Selection, Fit Page", { covers: ["fit:one", "fit:many"] }, async (t: NT) => {
  await zoomMenu(t, "Zoom to 100%");
  await t.waitState((s) => s.zoom === 100, "zoom 100%");
  await t.selectIds(["lay_clip"]);
  await zoomMenu(t, "Zoom to Selection");
  const s1 = await t.waitState((s) => s.zoom !== 100, "the zoom to change for the selection");
  await sleep(500);
  const r = await t.rect("lay_clip");
  const w = s1.window;
  t.ok(r.x > 0 && r.y > 0 && r.x + r.w < w.width && r.y + r.h < w.height, `the selection is not fully in view after Zoom to Selection (${JSON.stringify(r)})`);
  await zoomMenu(t, "Zoom to Fit Page");
  await sleep(600);
  const f = await fitCheck(t);
  t.ok(f.union.x >= 0 && f.union.y >= 0 && f.union.x + f.union.w <= f.view.w && f.union.y + f.union.h <= f.view.h, `the page's boards are not all in view after Fit Page (${JSON.stringify(f)})`);
  t.ok(f.union.w > f.view.w * 0.4 || f.union.h > f.view.h * 0.4, `Fit Page left the boards small (${JSON.stringify(f)})`);
});

// ---------------------------------------------------------------- the Layers panel

/** Shows the Layers panel with the board `board` open (its disclosure clicked) and answers its rows. */
async function openBoard(t: NT, board: string) {
  await t.section("Layers");
  let rows = await t.rows();
  const b = rows.layers.find((l) => l.id === board);
  t.ok(b, `no row for board ${board}`);
  if (!rows.layers.some((l) => (l.depth ?? 0) > 0 && (t.parentOf(l.id) === board))) {
    await t.click({ x: b.r.x + 12, y: b.r.y + b.r.h / 2 });
    await t.waitState((s) => s.layers.some((l: any) => l.parent === board), `board ${board} to open in Layers`);
    rows = await t.rows();
  }
  return rows;
}

sc("layers", "rename a layer: double-click, type, Return", { covers: ["layers-panel:rectangle", "layers-panel:mouse"] }, async (t: NT) => {
  await openBoard(t, "lay_nest");
  const row = await t.layerRow("r_free");
  // The name, not the row's edge: a double-click on the text starts the rename.
  await t.doubleClick({ x: row.r.x + 70, y: row.r.y + row.r.h / 2 });
  await t.waitState((s) => s.layerRenaming === "r_free", "the row to turn into a name field");
  await t.key("a", ["cmd"]);
  await t.type("Renamed rect");
  await t.key("Return");
  await t.waitState((s) => s.layerRenaming === null, "the rename to end");
  await t.waitDisk(() => t.node("r_free")?.name === "Renamed rect", "the new name");
  await t.waitState((s) => s.layers.find((l: any) => l.id === "r_free")?.name === "Renamed rect", "the row to show the new name");
});

sc("layers", "drag a row into a frame and back out", { covers: ["layers-panel:nested", "layers-panel:rectangle", "layers-panel:mouse"] }, async (t: NT) => {
  await openBoard(t, "lay_nest");
  const free = await t.layerRow("r_free"), outer = await t.layerRow("fr_outer");
  // The middle of a frame's row drops inside it.
  let r = await t.drag(center(free.r), center(outer.r));
  t.ok(r.systemDrag && r.drop.performed, `the row drag did not drop (${JSON.stringify(r)})`);
  await t.waitDisk(() => t.parentOf("r_free") === "fr_outer", "r_free inside Outer frame");
  await t.waitState((s) => s.layers.find((l: any) => l.id === "r_free")?.parent === "fr_outer", "the Layers row under Outer frame");
  // Out again: onto the top edge of the board-level Caption row, which puts it beside Caption in the board.
  const moved = await t.layerRow("r_free"), cap = await t.layerRow("lay_nest_cap");
  r = await t.drag(center(moved.r), { x: cap.r.x + cap.r.w / 2, y: cap.r.y + 3 });
  t.ok(r.systemDrag && r.drop.performed, `the second row drag did not drop (${JSON.stringify(r)})`);
  await t.waitDisk(() => t.parentOf("r_free") === "lay_nest", "r_free back in the board");
  await t.waitState((s) => s.layerDropMark === null, "the drop mark to clear");
});

// ---------------------------------------------------------------- the inspector

sc("inspector", "hex field sets the fill", { covers: ["set-props:rectangle", "inspector:rectangle", "set-props:nested"] }, async (t: NT) => {
  await t.selectIds(["r_inner"]);
  const hex = (await t.fields()).find((f) => /^[0-9A-F]{6}$/i.test(f.value));
  t.ok(hex, "no hex field in the inspector");
  t.eq(hex.value.toUpperCase(), "4F46E5", "the hex field before");
  await t.setField(hex, "FF0000");
  await t.waitDisk(() => String(t.node("r_inner")?.fill).toUpperCase() === "#FF0000", "fill #FF0000");
  const now = await t.fieldNow(hex);
  t.eq(now?.value.toUpperCase(), "FF0000", "the hex field after");
});

sc("inspector", "opacity field", { covers: ["set-props:rectangle", "inspector:rectangle"] }, async (t: NT) => {
  await t.selectIds(["r_inner"]);
  const f = await t.fieldBelow("Appearance");
  t.eq(f.value, "100", "the opacity field before");
  await t.setField(f, "50");
  await t.waitDisk(() => t.node("r_inner")?.opacity === 0.5, "opacity 0.5");
});

sc("inspector", "letter spacing -2%", { covers: ["set-props:text", "inspector:text"] }, async (t: NT) => {
  await t.selectIds(["tx_auto"]);
  const fontSize = t.node("tx_auto")!.fontSize as number;
  const f = await t.fieldBelow("Letter spacing", 40);
  await t.setField(f, "-2%");
  const want = Math.round(-0.02 * fontSize * 100) / 100;
  await t.waitDisk(() => Math.abs((t.node("tx_auto")?.letterSpacing as number) - want) < 0.011, `letterSpacing ${want}`);
  const now = await t.fieldNow(f);
  t.ok(now && Math.abs(Number(now.value) - want) < 0.011, `the field shows ${now?.value}, want ${want}`);
});

sc("inspector", "W +10, then Hug contents on an instance updates the field", { covers: ["autolayout-sizing:instance", "inspector:instance", "set-props:instance"] }, async (t: NT) => {
  await t.selectIds(["top_inst"]);
  const s0 = await t.state();
  const hugW = s0.selection.width as number;
  const w = await t.fieldBelow("Dimensions", 40);
  t.near(Number(w.value), hugW, 0.01, "the W field before");
  await t.setField(w, "+10");
  await t.waitDisk(() => typeof t.node("top_inst")?.width === "number" && Math.abs((t.node("top_inst")!.width as number) - (hugW + 10)) < 0.02, `width ${hugW + 10}`);
  t.near(Number((await t.fieldNow(w))?.value), hugW + 10, 0.02, "the W field after +10");
  // W's resizing menu: the chevron at the field's right end.
  await t.click({ x: w.x + w.w - 4, y: w.y + w.h / 2 });
  const open = await t.waitState((s) => s.menu, "the width menu to open");
  t.ok(open.menu.items.includes("Hug contents"), `the width menu has no Hug contents (${open.menu.items.join(", ")})`);
  await t.pickMenu("Hug contents");
  await t.waitDisk(() => t.node("top_inst")?.width === undefined || t.node("top_inst")?.width === "fit_content", "width back to hug");
  // The field follows the relayout on its own, without selecting the layer again.
  const t0 = Date.now();
  let v = "";
  while (Date.now() - t0 < 3000) {
    v = (await t.fieldNow(w))?.value ?? "";
    if (Math.abs(Number(v) - hugW) < 0.02) return;
    await sleep(100);
  }
  throw new Error(`the W field shows ${v} after Hug contents, want ${hugW} (it should update without reselecting)`);
});

// ---------------------------------------------------------------- components and the inspector's fields

/** The inspector's part of the window. */
async function inspectorRegion(t: NT) {
  const st = await t.state();
  return { x: st.window.width - 380, y: 60, w: 380, h: st.window.height - 60 };
}
/** Saves the inspector (and `extra` px of canvas to its left) as an evidence picture under qa/out/native. */
async function inspectorShot(t: NT, name: string, extra = 0, h = 560) {
  const st = await t.state();
  await t.shot(`${process.cwd()}/qa/out/native/${name}.png`);
  return { file: `${process.cwd()}/qa/out/native/${name}.png`, crop: { x: st.window.width - 300 - extra, y: 50, w: 300 + extra, h } };
}

sc("components", "swap an instance from the inspector's component picker; its text override carries over", { covers: ["swap-instance:instance", "swap-instance:mouse", "inspector:instance"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("components");
  await t.selectIds(["inst_text"]);
  const region = await inspectorRegion(t);
  await t.waitText("Instance of", region, 15000);
  const of = (await t.findText("Instance of", region))[0];
  t.ok(of, "no Instance of in the inspector");
  const names = (await t.findText("Button/Primary", region)).filter((m) => Math.abs(m.y + m.h / 2 - (of.y + of.h / 2)) < 10 && m.x > of.x);
  t.ok(names.length, "no component name beside Instance of");
  await t.click(center(names[0]));
  const open = await t.waitState((s) => s.menu, "the swap menu to open");
  t.ok(open.menu.items.includes("Button/Secondary"), `the swap menu has no Button/Secondary (${open.menu.items.join(", ")})`);
  t.ok(!open.menu.items.includes("Button/Primary"), "the swap menu offers the instance's own component");
  await t.pickMenu("Button/Secondary");
  const n = await t.waitDisk(() => t.node("inst_text")?.ref === "cmp_button_sec" && t.node("inst_text"), "inst_text to point at Button/Secondary");
  t.eq(n.descendants, { cmp_button_sec_label: { content: "Text override" } }, "the text override, moved to the new label");
  t.eq(n.name, undefined, "the name follows the new main");
  await t.waitText("Button/Secondary", { ...region, h: 200 }, 15000);
  const s = await inspectorShot(t, "components-swap", 420, 260);
  t.note(JSON.stringify(s));
  // One undo step puts it back.
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => t.node("inst_text")?.ref === "cmp_button", "undo to point it back");
});

sc("components", "reset one override from the override list; push an instance's changes to its main", { covers: ["reset-overrides:in-instance", "reset-overrides:mouse", "push-overrides:instance", "push-overrides:mouse"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("components");
  // A layer inside an instance with two overrides: reset Font size alone, by right-clicking its row.
  await t.selectIds(["inst_font/cmp_button_label"]);
  const region = await inspectorRegion(t);
  const row = await t.waitText("Font size", { ...region, h: 260 }, 8000);
  await t.waitText("Font weight", { ...region, h: 260 }, 4000);
  const rowShot = await inspectorShot(t, "components-override-rows", 420, 260);
  t.note(JSON.stringify(rowShot));
  await t.click(row, { right: true });
  await t.pickMenu("Reset font size");
  await t.waitDisk(() => { const d = t.node("inst_font")?.descendants?.cmp_button_label; return d && d.fontSize === undefined && d; }, "fontSize reset");
  t.eq(t.node("inst_font")!.descendants.cmp_button_label, { fontWeight: "400" }, "Font weight stays overridden");
  // The other row's arrow: the right end of the row.
  const w = await t.waitText("Font weight", { ...region, h: 260 }, 4000);
  const st = await t.state();
  const panelRight = st.window.width - 10;
  await t.click({ x: panelRight - 12 - 12, y: w.y });
  await t.waitDisk(() => t.node("inst_font")?.descendants === undefined, "the last override reset by its arrow");
  // Push: inst_fill's red fill becomes Button/Primary's own, and leaves the instance.
  await t.selectIds(["inst_fill"]);
  const push = await t.waitText("Push changes to main", region, 8000);
  const pushShot = await inspectorShot(t, "components-push", 420, 300);
  t.note(JSON.stringify(pushShot));
  await t.click(push);
  await t.waitDisk(() => t.node("cmp_button")?.fill === "#DC2626", "the main component's fill");
  t.eq(t.node("inst_fill")!.fill, undefined, "the instance no longer overrides it");
  t.eq(t.node("inst_plain")!.fill, undefined, "other instances follow the main");
  // ...and the canvas draws them in the main's new fill, not its old dark one.
  await waitDrawn(t, "inst_plain", "#111827", "another instance of Button/Primary in the pushed red");
  const after = await inspectorShot(t, "components-pushed", 900, 420);
  t.note(JSON.stringify(after));
});

/** POST /api/structure from the page (the same write path a paste or an agent's add_nodes takes). */
async function structure(t: NT, body: Record<string, unknown>) {
  const r = await t.js(`const r = await fetch("/api/structure", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file: window.canvasHost.file, ...${JSON.stringify(body)} }) }); return { status: r.status, body: await r.json() };`);
  t.ok(r.status === 200, `structure ${body.op}: ${JSON.stringify(r)}`);
  return r.body;
}

sc("components", "swap a nested instance from the inspector's component picker; the swap is an override row, undo and its reset put the original back", { covers: ["swap-instance:nested", "swap-instance:mouse", "reset-overrides:in-instance", "undo-redo:nested"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("components");
  // A Card component holding a Button/Primary instance, and an instance of Card on the Instances board.
  await structure(t, { op: "add", place: { parent: "cmp_main" }, nodes: [{ type: "frame", id: "qa_card", name: "Card", reusable: true, x: 340, y: 60, width: "fit_content", height: "fit_content", layout: "vertical", padding: 8, fill: "#F3F4F6", cornerRadius: 10, children: [{ type: "ref", id: "qa_card_btn", ref: "cmp_button" }] }] });
  await structure(t, { op: "add", place: { parent: "cmp_inst" }, nodes: [{ type: "ref", id: "qa_card_inst", ref: "qa_card", x: 440, y: 270 }] });
  await t.look(600, 0);
  const doc = path.join(t.file, "document.json");
  const before = fs.readFileSync(doc, "utf8");
  await t.selectIds(["qa_card_inst/qa_card_btn"]);
  const region = await inspectorRegion(t);
  await t.waitText("Instance of", region, 15000);
  const of = (await t.findText("Instance of", region))[0];
  t.ok(of, "no Instance of for the nested instance");
  const names = (await t.findText("Button/Primary", region)).filter((m) => Math.abs(m.y + m.h / 2 - (of.y + of.h / 2)) < 10 && m.x > of.x);
  t.ok(names.length, "no component picker beside Instance of on a nested instance");
  await t.click(center(names[0]));
  const open = await t.waitState((s) => s.menu, "the swap menu to open");
  t.ok(open.menu.items.includes("Button/Secondary"), `the swap menu has no Button/Secondary (${open.menu.items.join(", ")})`);
  await t.pickMenu("Button/Secondary");
  const n = await t.waitDisk(() => t.node("qa_card_inst")?.descendants?.qa_card_btn?.ref === "cmp_button_sec" && t.node("qa_card_inst"), "the nested instance to draw Button/Secondary");
  t.eq(n.descendants, { qa_card_btn: { ref: "cmp_button_sec" } }, "an override that swaps it, in the outer instance");
  t.eq(t.node("qa_card_btn")!.ref, "cmp_button", "the Card component keeps its own button");
  await t.waitText("Button/Secondary", { ...region, h: 200 }, 15000);
  const row = await t.waitText("Swapped component", { ...region, h: 300 }, 8000);
  // The canvas draws the swapped button (Button/Secondary's light grey) inside the Card instance.
  await waitDrawn(t, "qa_card_inst/qa_card_btn", "#111827", "the swapped nested instance");
  const s = await inspectorShot(t, "gaps-components-nested-swap", 520, 300);
  t.note(JSON.stringify(s));
  // One undo step: the original bytes.
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => fs.readFileSync(doc, "utf8") === before, "undo to give the original bytes back");
  await t.key("z", ["cmd", "shift"]);
  await t.waitDisk(() => t.node("qa_card_inst")?.descendants?.qa_card_btn?.ref === "cmp_button_sec", "redo to swap it again");
  // Its override row's menu: Reset swapped component puts Button/Primary back.
  await t.selectIds(["qa_card_inst/qa_card_btn"]);
  const row2 = await t.waitText("Swapped component", { ...region, h: 300 }, 8000);
  void row;
  await t.click(row2, { right: true });
  await t.pickMenu("Reset swapped component");
  await t.waitDisk(() => t.node("qa_card_inst") && t.node("qa_card_inst")!.descendants === undefined, "the swap reset");
});

sc("components", "drag a component row onto a board: an instance where it lands; Option+drag another onto it swaps it", { covers: ["component-drag:board", "component-drag:mouse", "swap-instance:option-drag", "swap-instance:mouse"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("components");
  await t.look(600, 0);
  await t.section("Components");
  const side = { x: 60, y: 60, w: 250, h: 500 };
  const pri = await t.textAt("Button/Primary", side);
  const b = await t.rect("cmp_inst");
  const spot = { x: b.x + b.w * 0.78, y: b.y + b.h * 0.8 };
  const want = await t.world(spot);
  const before = (t.node("cmp_inst")!.children as any[]).map((c) => c.id);
  const r = await t.drag(pri, spot, { steps: 20 });
  t.ok(r.systemDrag, `the row did not start a drag (${JSON.stringify(r)})`);
  t.eq(r.drop.target, "CanvasWebView", "the drop landed on (the canvas web view)");
  const made = await t.waitDisk(() => (t.node("cmp_inst")!.children as any[]).find((c) => !before.includes(c.id)), "a new instance on the board");
  t.eq([made.type, made.ref], ["ref", "cmp_button"], "an instance of Button/Primary");
  const box = await t.rect(made.id);
  const mid = await t.world({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
  t.near(mid.x, want.x, 3, "its middle under the pointer (x, world)");
  t.near(mid.y, want.y, 3, "its middle under the pointer (y, world)");
  // Option+drag Button/Secondary onto it: that instance swaps; nothing is added.
  const sec = await t.textAt("Button/Secondary", side);
  const r2 = await t.drag(sec, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, { steps: 20, mods: ["alt"] });
  t.ok(r2.systemDrag, `the second row did not start a drag (${JSON.stringify(r2)})`);
  await t.waitDisk(() => t.node(made.id)?.ref === "cmp_button_sec", "the instance swapped to Button/Secondary");
  t.eq((t.node("cmp_inst")!.children as any[]).length, before.length + 1, "the Option-drop added nothing");
  await waitDrawn(t, made.id, "#111827", "the swapped instance in Button/Secondary's colours");
  const s = await inspectorShot(t, "gaps-components-drag-swap", 900, 440);
  t.note(JSON.stringify(s));
  // One undo step each.
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => t.node(made.id)?.ref === "cmp_button", "undo of the swap");
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => t.node(made.id) === null, "undo of the drop");
});

sc("inspector", "Lock aspect ratio above W and H: a typed W changes H too", { covers: ["aspect-lock:rectangle", "aspect-lock:keyboard", "inspector:rectangle"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["rz_rect"]);
  const w = await t.fieldBelow("Dimensions", 40);
  const h = (await t.fields()).find((f) => Math.abs(f.y - w.y) < 4 && f.x > w.x + w.w);
  t.ok(h, "no H field beside W");
  // The lock sits at the right end of the Dimensions caption row, right above H: the panel's edge, 12 pt in, 24 pt wide.
  const dims = await t.textAt("Dimensions", await inspectorRegion(t));
  const lock = { x: (await t.state()).window.width - 10 - 12 - 12, y: dims.y };
  await t.click(lock);
  await t.waitDisk(() => t.node("rz_rect")?.metadata?.canvasLockAspect === true, "the lock on the layer");
  await t.setField(w, "150");
  await t.waitDisk(() => t.node("rz_rect")?.width === 150 && t.node("rz_rect")?.height === 120, "150 x 120 (100 x 80 kept its ratio)");
  t.eq((await t.fieldNow(h))?.value, "120", "the H field");
  const s = await inspectorShot(t, "components-aspect-lock", 0, 300);
  t.note(JSON.stringify(s));
  // Off again: W alone.
  await t.click(lock);
  await t.waitDisk(() => t.node("rz_rect")?.metadata === undefined, "the lock off (metadata gone)");
  await t.setField(w, "100");
  await t.waitDisk(() => t.node("rz_rect")?.width === 100, "width 100");
  t.eq(t.node("rz_rect")!.height, 120, "H stays with the lock off");
});

sc("inspector", "fields take ^: 2^5, then ^2 raises the current value", { covers: ["field-math:rectangle", "field-math:keyboard"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["rz_rect"]);
  const x = await t.fieldBelow("Position", 40);
  await t.setField(x, "2^5");
  await t.waitDisk(() => t.node("rz_rect")?.x === 32, "x 32");
  await t.setField(x, "^2");
  await t.waitDisk(() => t.node("rz_rect")?.x === 1024, "x 1024");
  await t.setField(x, "(1+2)^2*2");
  await t.waitDisk(() => t.node("rz_rect")?.x === 18, "x 18");
  await t.setField(x, "^2");
  await t.waitDisk(() => t.node("rz_rect")?.x === 324, "x 324 (18^2)");
  await inspectorShot(t, "components-field-math");
});

sc("inspector", "Option over a field and drag scrubs; up is faster, down slower", { covers: ["field-scrub:rectangle", "field-scrub:mouse"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["rz_rect"]);
  const x = await t.fieldBelow("Position", 40);
  const x0 = t.node("rz_rect")!.x as number;
  const c = center(x);
  // On the input itself (not the label): 20 pt right at the press's height, 1x.
  await t.drag(c, { x: c.x + 20, y: c.y }, { mods: ["alt"], steps: 10 });
  await t.waitDisk(() => t.node("rz_rect")?.x === x0 + 20, `x ${x0 + 20} (1x)`);
  // Up 80 pt first, then 20 right: 2x.
  await t.drag(c, { x: c.x + 20, y: c.y - 80 }, { mods: ["alt"], steps: 10, via: [{ x: c.x, y: c.y - 80 }] });
  await t.waitDisk(() => t.node("rz_rect")?.x === x0 + 60, `x ${x0 + 60} (2x)`);
  // Down 200 pt, then 20 right: 1/4.
  await t.drag(c, { x: c.x + 20, y: c.y + 200 }, { mods: ["alt"], steps: 10, via: [{ x: c.x, y: c.y + 200 }] });
  await t.waitDisk(() => t.node("rz_rect")?.x === x0 + 65, `x ${x0 + 65} (1/4)`);
  await inspectorShot(t, "components-field-scrub");
  // Without Option a press on the input only focuses it: nothing changes.
  await t.drag(c, { x: c.x + 20, y: c.y }, { steps: 6 });
  await sleep(400);
  t.eq(t.node("rz_rect")!.x, x0 + 65, "a plain drag over the input does not scrub");
  await t.key("Escape");
});

// ---------------------------------------------------------------- Settings and Styles

/** The Settings toolbar's tabs, left to right (SettingsWindow.Tab in apps/macos/Settings.swift). */
export const SETTINGS_TABS = ["General", "Canvas", "Agents", "Sounds", "Performance", "Privacy", "Shortcuts"];

/** Clicks a Settings tab: its toolbar button by label, else by position once every tab is there. */
async function settingsTab(t: NT, label: string) {
  let b: any;
  for (let i = 0; i < 30 && !b; i++) {
    const bs = (await t.views("settings")).filter((v) => v.class === "NSToolbarButton").sort((x, y) => x.x - y.x);
    b = bs.find((v) => v.label === label) ?? (bs.length === SETTINGS_TABS.length ? bs[SETTINGS_TABS.indexOf(label)] : undefined);
    if (!b) await sleep(100);
  }
  t.ok(b, `no ${label} tab in the Settings toolbar`);
  await t.click(center(b), { window: "settings" });
}

sc("settings", "Cmd+, opens Settings and a change persists", { covers: ["settings:light", "settings:dark", "theme:light", "theme:dark"] }, async (t: NT) => {
  await t.key(",", ["cmd"]);
  await t.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
  const tabButton = async (label: string) => {
    // The toolbar's tab buttons, left to right in SettingsWindow.Tab order.
    const order = SETTINGS_TABS;
    let b: any;
    for (let i = 0; i < 30 && !b; i++) {
      const bs = (await t.views("settings")).filter((v) => v.class === "NSToolbarButton").sort((x, y) => x.x - y.x);
      b = bs.find((v) => v.label === label) ?? (bs.length === order.length ? bs[order.indexOf(label)] : undefined);
      if (!b) await sleep(100);
    }
    t.ok(b, `no ${label} tab in the Settings toolbar`);
    await t.click(center(b), { window: "settings" });
  };
  const read = (key: string) => { try { return execFileSync("defaults", ["read", t.app.bundleId, key], { encoding: "utf8" }).trim(); } catch { return ""; } };
  // Persisted: the preferences daemon has it for this instance's bundle id (what the next launch reads).
  const stored = async (key: string, want: string) => {
    const t0 = Date.now();
    while (read(key) !== want && Date.now() - t0 < 4000) await sleep(150);
    t.eq(read(key), want, `${key} in the stored preferences`);
  };
  // General: the theme switch, dark then light.
  await tabButton("General");
  for (const theme of ["Dark", "Light"]) {
    await t.click(await t.waitText(theme, undefined, 4000, "settings"), { window: "settings" });
    await t.waitState((s) => s.theme === theme.toLowerCase(), `the ${theme} theme`);
    await stored("canvas.theme", theme.toLowerCase());
  }
  const before = (await t.state()).prefs.boardLabels;
  // The Canvas tab, then its "Show board names" switch.
  await tabButton("Canvas");
  const row = await t.waitText("Show board names", undefined, 4000, "settings");
  const sw = (await t.views("settings")).filter((v) => v.kind === "switch" || v.kind === "button").find((v) => Math.abs(v.y + v.h / 2 - row.y) < 14 && v.x > row.x);
  t.ok(sw, "no switch beside Show board names");
  await t.click(center(sw), { window: "settings" });
  const after = await t.waitState((s) => s.prefs.boardLabels !== before, "boardLabels to change");
  t.eq(after.prefs.boardLabels, before === "true" ? "false" : "true", "boardLabels");
  await stored("canvas.settings.boardLabels", before === "true" ? "0" : "1");
  await t.shot(`${process.cwd()}/qa/out/native/settings-window.png`, "settings");
});

sc("settings", "Settings > Agents: a model and reasoning menu for each agent, Default until one is picked", { covers: ["settings:agents-model"] }, async (t: NT) => {
  await t.key(",", ["cmd"]);
  await t.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
  await settingsTab(t, "Agents");
  await t.waitText("Model and reasoning", undefined, 4000, "settings");
  for (const h of ["claude", "codex"]) {
    const m = await t.mark({ id: `model-${h}`, window: "settings" }, 4000);
    t.ok(m, `the ${h} model menu`);
    await t.mark({ id: `effort-${h}`, window: "settings" }, 4000);
  }
  await t.shot(`${process.cwd()}/qa/out/native/settings-agents-model.png`, "settings");
});

sc("settings", "Settings > General > Updates: the version, Update automatically (on, stored), Check for Updates; a build from source says it does not update itself", { covers: ["settings:updates"] }, async (t: NT) => {
  await t.key(",", ["cmd"]);
  await t.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
  await settingsTab(t, "General");
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  await t.waitText(`Version ${version}`, undefined, 4000, "settings");
  const read = (key: string) => { try { return execFileSync("defaults", ["read", t.app.bundleId, key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
  t.eq(read("canvas.updates.automatic"), "", "Update automatically is on by default (nothing stored)");
  const flip = async (want: string) => {
    const row = await t.waitText("Update automatically", undefined, 4000, "settings");
    const sw = (await t.views("settings")).filter((v) => v.kind === "switch" || v.kind === "button").find((v) => Math.abs(v.y + v.h / 2 - row.y) < 14 && v.x > row.x);
    t.ok(sw, "no switch beside Update automatically");
    await t.click(center(sw), { window: "settings" });
    for (let i = 0; i < 30 && read("canvas.updates.automatic") !== want; i++) await sleep(150);
    t.eq(read("canvas.updates.automatic"), want, `Update automatically stored as ${want}`);
  };
  await flip("0");
  await flip("1");
  await sleep(500); // the switch's animation
  await t.shot(`${process.cwd()}/qa/out/native/settings-general-updates.png`, "settings");
  // A QA build is not a release: Check for Updates says so instead of asking the website.
  await t.click(await t.waitText("Check for Updates", undefined, 4000, "settings"), { window: "settings" });
  const fromSource = "This copy of Canvas was built from source, so it does not update itself.";
  await t.waitState((s) => s.toast === fromSource, "the built-from-source toast");
  // The Canvas menu: Check for Updates always, Restart to Update only while an update is ready (none here).
  t.eq((await t.cmd("qa.mainmenu", { title: "Restart to Update" })).enabled, false, "Restart to Update is off with nothing ready");
  await t.cmd("qa.mainmenu", { title: "Check for Updates…", perform: true });
  await t.waitState((s) => s.toast === fromSource, "the same answer from the Canvas menu");
});

sc("settings", "Settings > General > Comments: Your name in comments starts as the Mac's full name and is stored when it is changed", { covers: ["settings:comment-name"] }, async (t: NT) => {
  await t.key(",", ["cmd"]);
  await t.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
  await settingsTab(t, "General");
  await t.waitText("Your name in comments", undefined, 4000, "settings");
  const full = execFileSync("id", ["-F"], { encoding: "utf8" }).trim();
  t.eq((await t.state()).prefs.commentName, full, "the name starts as the Mac's full user name");
  const field = await t.mark({ id: "comment-name", window: "settings" }, 4000);
  await t.click(center(field), { window: "settings" });
  await t.key("a", ["cmd"], { window: "settings" });
  await t.type("Ana QA", { window: "settings" });
  await t.waitState((s) => s.prefs.commentName === "Ana QA", "the name to change");
  const read = (key: string) => { try { return execFileSync("defaults", ["read", t.app.bundleId, key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
  for (let i = 0; i < 30 && read("canvas.settings.commentName") !== "Ana QA"; i++) await sleep(150);
  t.eq(read("canvas.settings.commentName"), "Ana QA", "the name is stored");
  await t.shot(`${process.cwd()}/qa/out/native/settings-general-comments.png`, "settings");
});

sc("settings", "Settings > Privacy: Share usage counts on, Help improve Canvas adds the monthly id, Show what's sent shows today's JSON", { covers: ["settings:privacy"] }, async (t: NT) => {
  await t.key(",", ["cmd"]);
  await t.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
  await settingsTab(t, "Privacy");
  await t.waitText("Share usage counts", undefined, 4000, "settings");
  const st = await t.state();
  t.eq(st.prefs.shareUsage, "true", "Share usage counts is on by default");
  const read = (key: string) => { try { return execFileSync("defaults", ["read", t.app.bundleId, key], { encoding: "utf8" }).trim(); } catch { return ""; } };
  const improve = async (want: "true" | "false") => {
    if ((await t.state()).prefs.improveCanvas === want) return;
    const row = await t.waitText("Help improve Canvas", undefined, 4000, "settings");
    const sw = (await t.views("settings")).filter((v) => v.kind === "switch" || v.kind === "button").find((v) => Math.abs(v.y + v.h / 2 - row.y) < 14 && v.x > row.x);
    t.ok(sw, "no switch beside Help improve Canvas");
    await t.click(center(sw), { window: "settings" });
    await t.waitState((s) => s.prefs.improveCanvas === want, `Help improve Canvas ${want === "true" ? "on" : "off"}`);
  };
  await improve("true");
  for (let i = 0; i < 30 && read("canvas.settings.improveCanvas") !== "1"; i++) await sleep(150);
  t.eq(read("canvas.settings.improveCanvas"), "1", "Help improve Canvas stored");
  // The server heard it with the shell's state (POST /api/state), and counted this instance's launch and file opens.
  const p = await (async () => {
    for (let i = 0; i < 40; i++) {
      const j = (await (await fetch(`${t.app.base}/api/usage/preview`)).json()) as any;
      if (j.improve && j.body?.install) return j;
      await sleep(250);
    }
    throw new Error("the server never heard Help improve Canvas");
  })();
  t.eq(p.sends, false, "a QA build never sends");
  t.ok(/^[0-9a-f]{32}$/.test(p.body.install), `an install id: ${p.body.install}`);
  t.ok(p.body.events["file.open"] >= 1, `file.open counted: ${JSON.stringify(p.body.events)}`);
  t.ok(/^\d{4}-\d{2}-\d{2}$/.test(p.body.day), "a UTC day");
  await t.shot(`${process.cwd()}/qa/out/native/settings-privacy.png`, "settings");
  // Show what's sent: a popover with the exact JSON the server would send for today.
  await t.click(center(await t.mark({ id: "usage-show", window: "settings" })), { window: "settings" });
  await t.waitState((s) => s.popoverShown, "the Show what's sent popover");
  const m = await t.mark({ id: "usage-json", window: "popover" }, 8000);
  let shown: any;
  for (let i = 0; i < 40; i++) {
    const label = (await t.marks({ id: "usage-json", window: "popover" }))[0]?.label ?? "";
    try { shown = JSON.parse(label); break; } catch { await sleep(150); }
  }
  t.ok(shown, `the popover shows JSON: ${m.label}`);
  t.eq(Object.keys(shown).filter((k) => !["v", "build", "os", "arch", "day", "events", "install"].includes(k)).join(","), "", "only the contract's fields");
  t.eq(shown.install, p.body.install, "the same install id the server would send");
  t.eq(shown.day, p.body.day, "today");
  t.ok(shown.events["file.open"] >= 1, "today's counts");
  await sleep(700); // the popover's fade-in
  await t.shot(`${process.cwd()}/qa/out/native/settings-privacy-json.png`, "popover");
  await t.key("Escape", [], { window: "popover" });
  // Back to the default for the scenarios after this one.
  await improve("false");
  let off: any;
  for (let i = 0; i < 40; i++) {
    off = await (await fetch(`${t.app.base}/api/usage/preview`)).json();
    if (!off.improve) break;
    await sleep(250);
  }
  t.eq(off.body.install, undefined, "Help improve Canvas off: no install id");
});

sc("styles", "the Styles switch shows Text, Variables and Fonts", { covers: [] }, async (t: NT) => {
  await t.section("Styles");
  const panel = { x: 60, y: 60, w: 260, h: 700 };
  // Each tab's search field names what it lists.
  await t.waitText("Search text styles", panel);
  await t.click(await t.textAt("Variables", panel));
  await t.waitText("Search variables", panel);
  await t.waitText("brand", panel);
  await t.click(await t.textAt("Fonts", panel));
  await t.waitText("fonts", { ...panel, y: 120, h: 60 });
  t.ok(!(await t.marks({ label: "brand", region: panel })).length, "variables still listed on the Fonts tab");
  await t.click(await t.textAt("Text", { ...panel, h: 80 }));
  await t.waitText("Search text styles", panel);
  t.ok(!(await t.marks({ label: "brand", region: panel })).length, "variables listed on the Text tab");
});

// ---------------------------------------------------------------- clipboard and the selected card

const CLIP_TYPE = "cc.getcanvas.canvas.clipboard";
const PLAIN = "public.utf8-plain-text";

sc("clipboard", "copy cards and a board in one tab, paste them in another tab", { covers: ["copy-paste:other-tab", "copy-paste:other-file", "copy-paste:card-todo", "copy-paste:card-note", "copy-paste:board"] }, async (t: NT) => {
  // A second file in a second tab of the same window (the QA instance's own pasteboard: never the person's).
  const other = t.file.replace(/\.canvas$/, "-other.canvas");
  copyDir(PLAYGROUND, other);
  const o = new NT(t.app, other);
  try {
    await t.app.cmd({ op: "open", args: { file: other }, timeoutMs: 15_000 });
    await o.waitState((s) => s.file === other && s.pages.length > 0, "the other tab", 15_000);
    await o.settle();
    await o.section("Layers"); // the pages list (a scenario before may have left Styles open)
    await o.showPage("cards");
    const ws = o.widgets().widgets.filter((w: any) => w.kind === "todo" || w.name === "Note");
    t.eq(ws.length, 2, "a to-do and a note in the other file");
    await o.js(`window.canvasHost.setSelection(${JSON.stringify(["crd_board", ...ws.map((w: any) => "widget:" + w.id)])});`);
    await o.waitJs("window.canvasHost.selection().length === 3", "the board and the two cards selected");
    await t.key("c", ["cmd"]);
    const pb = await t.waitFor(async () => { const p = await t.cmd("qa.pasteboard"); return p.types.includes(CLIP_TYPE) && p; }, "Canvas's copy on the pasteboard");
    const payload = JSON.parse(pb.strings[CLIP_TYPE]);
    t.eq(payload.cards.length, 2, "the payload carries the two cards");
    const plain = String(pb.strings[PLAIN] ?? "");
    t.ok(!plain.trim().startsWith("{") && plain.length < 200, `another app gets names, not JSON: ${JSON.stringify(plain.slice(0, 80))}`);
    t.ok(plain.includes("Cards") && plain.includes("Note"), `the names of what was copied: ${JSON.stringify(plain)}`);
    // Back to the first tab, another page: Cmd+V.
    await t.app.cmd({ op: "open", args: { file: t.file }, timeoutMs: 15_000 });
    await t.waitState((s) => s.file === t.file, "the first tab");
    await t.settle();
    await t.section("Layers");
    await t.showPage("style");
    await t.js("window.canvasHost.clearSel();");
    const before = t.widgets().widgets.length, boards = t.disk().children.length;
    await t.key("v", ["cmd"]);
    const made = await t.waitDisk(() => { const w = t.widgets().widgets; return w.length === before + 2 && w.slice(before); }, "the two pasted cards", 10_000);
    t.eq(made.map((w: any) => w.kind).sort(), ["note", "todo"], "the pasted cards");
    t.ok(made.every((w: any) => w.page === "style"), "on the page shown when pasting");
    t.eq(t.disk().children.length, boards + 1, "the board too");
    t.eq((await t.pageSel()).length, 3, "the pasted board and cards are selected");
    // A picture of the paste for docs/evidence, the view fitted to it.
    await t.js(`window.canvasCmd({ cmd: "fit" });`);
    await t.settle();
    await sleep(400);
    fs.mkdirSync(path.join(ROOT, "qa", "out", "native"), { recursive: true });
    await t.cmd("qa.shot", { path: path.join(ROOT, "qa", "out", "native", "evidence-tab-paste.png"), window: "main" });
    // One Cmd+Z takes the whole paste back.
    await t.key("z", ["cmd"]);
    await t.waitDisk(() => t.widgets().widgets.length === before && t.disk().children.length === boards, "one undo to take the paste back", 10_000);
  } finally {
    await t.app.cmd({ op: "close", args: { file: other }, timeoutMs: 10_000 }).catch(() => {});
    fs.rmSync(other, { recursive: true, force: true });
  }
});

for (const theme of ["light", "dark"] as const) {
  sc("cards", `a selected card shows its blue outline, ${theme}`, { covers: [`card-select:card-todo`, `card-select:${theme}`] }, async (t: NT) => {
    const was = (await t.app.cmd({ op: "theme.get" })).mode;
    try {
      await t.app.cmd({ op: "theme.set", args: { mode: theme } });
      await t.waitState((s) => s.theme === theme, `the ${theme} theme`);
      await t.section("Layers"); // the pages list (a scenario before may have left Styles open)
      await t.showPage("cards");
      const w = t.widgets().widgets.find((x: any) => x.kind === "todo");
      await t.look(w.x - 40, w.y - 40, 1);
      const st = await t.state();
      const card = await t.js<{ x: number; y: number; w: number; h: number }>(`const h = window.canvasHost, c = h.cam; return { x: h.viewBox.l + ${w.x} * c.z + c.x, y: h.viewBox.t + ${w.y} * c.z + c.y, w: ${w.w} * c.z, h: ${w.h} * c.z };`);
      const r = { x: card.x + st.webFrame.x, y: card.y + st.webFrame.y, w: card.w, h: card.h };
      const ring = { x: r.x + 24, y: r.y - 2.5, w: r.w - 48, h: 2.5 }; // just above the top edge, away from the corners
      const inner = { x: r.x + 24, y: r.y + 4, w: r.w - 48, h: 3 };
      const blue = async (region: typeof ring) => { const px = await t.cmd("qa.pixels", { region, colors: SEL_BLUE, tol: 40 }); return px.count / Math.max(1, px.total); };
      await t.js("window.canvasHost.clearSel();");
      await sleep(300);
      t.ok((await blue(ring)) < 0.1, "no outline before the card is selected");
      await t.js(`window.canvasHost.setSelection(["widget:" + ${JSON.stringify(w.id)}]);`);
      await t.waitJs(`window.canvasHost.selection()[0] === "widget:" + ${JSON.stringify(w.id)}`, "the card to be selected");
      await sleep(300);
      const on = await blue(ring);
      t.ok(on > 0.5, `the outline above the card is the selection blue (${Math.round(on * 100)}% of its pixels)`);
      t.ok((await blue(inner)) < 0.1, "nothing blue inside the card's edge: the outline sits outside it");
      fs.mkdirSync(path.join(ROOT, "qa", "out", "native"), { recursive: true });
      await t.cmd("qa.shot", { path: path.join(ROOT, "qa", "out", "native", `card-selected-${theme}.png`), window: "main" });
    } finally {
      await t.app.cmd({ op: "theme.set", args: { mode: was } }).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------- links (Cmd+L)

sc("links", "Cmd+L copies a link through Edit > Copy Link; a canvas:// link opens its page and selects its nodes", { covers: ["copy-link:keyboard", "copy-link:one", "copy-link:open-url", "copy-link:other-page"] }, async (t: NT) => {
  // The instance's own pasteboard (QA.swift), never the clipboard of the person at the Mac.
  await t.cmd("qa.pasteboard", { set: "" });
  await t.section("Layers"); // the pages list, whatever the last scenario left open
  await t.showPage("layout");
  await t.selectIds(["r_free"]);
  await t.key("l", ["cmd"]);
  const st = await t.waitState((s) => s.toast === "Link copied", "the Link copied toast");
  t.eq(st.toastKind, "link", "the toast's icon");
  await t.shot(`${process.cwd()}/qa/out/native/link-copied.png`);
  const text = (await t.cmd("qa.pasteboard")).text as string;
  const l = parseLink(text);
  t.ok(l, `the pasteboard holds a link: ${text}`);
  t.eq(fs.realpathSync(l!.file), fs.realpathSync(t.file), "the link's file");
  t.eq([l!.page, l!.nodes], ["layout", ["r_free"]], "the link's page and nodes");
  t.ok(!/\s/.test(text), "one line, no spaces");
  // Opening a link, delivered in-process as Launch Services would deliver a click on it: a QA build has no
  // canvas:// scheme, so this never reaches the person's Canvas.
  await t.showPage("style");
  await t.cmd("qa.openurl", { url: buildLink({ file: t.file, page: "layout", nodes: ["fr_inner"] })! });
  await t.waitState((s) => s.activePage === "layout" && s.selection?.id === "fr_inner", "the link's page and node selected", 10_000);
  await sleep(500);
  const r = await t.rect("fr_inner");
  const w = (await t.state()).window;
  t.ok(r.x > 0 && r.y > 0 && r.x + r.w < w.width && r.y + r.h < w.height, `the linked layer is in view (${JSON.stringify(r)})`);
  // A link to a file that is not there says so and changes nothing.
  await t.cmd("qa.openurl", { url: buildLink({ file: "/nowhere/gone.canvas", nodes: ["x"] })! });
  await t.waitState((s) => /cannot find gone\.canvas/.test(s.toast ?? ""), "the missing-file toast");
  t.eq((await t.state()).selection?.id, "fr_inner", "the selection stays");
});

// ---------------------------------------------------------------- menu keys: Shift+Cmd and Cmd chords

/**
 * buildMenu spells a Shift chord on a letter in capitals ("L" with Shift+Cmd), so Shift+Cmd+L locks instead of
 * copying a link. Every Shift+Cmd item, pressed as real key events, runs its own action, and the plain Cmd item on
 * the same letter still runs its own; a capital typed into a field types (Shift+A, Shift+H and Shift+V are the
 * page's keys in the menus too).
 */
sc("menus", "every Shift+Cmd chord runs its own menu item, the plain Cmd chord its own", { covers: ["menu-keys:redo", "menu-keys:ungroup", "menu-keys:paste-in-place", "menu-keys:save-as", "menu-keys:show-hide", "menu-keys:select-inverse", "menu-keys:lock", "menu-keys:undo", "menu-keys:group", "menu-keys:paste", "menu-keys:save", "menu-keys:hide-app", "menu-keys:select-all", "menu-keys:copy-link", "menu-keys:typing-capitals", "menu-keys:place-image", "menu-keys:quick-actions", "menu-keys:copy-as-png", "undo-redo:keyboard", "ungroup:keyboard", "lock:keyboard", "copy-link:keyboard"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.look(0, 0);
  const kids = () => (t.node("lay_nest")?.children ?? []).map((c: any) => String(c.id));
  const kids0 = kids();
  const sel = async (ids: string[]) => { await t.selectIds(ids); await t.waitJs(`window.canvasHost.selection().join() === ${JSON.stringify(ids.join())}`, `the selection ${ids}`); };
  const fail: string[] = [];
  const check = async (what: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { fail.push(`${what}: ${(e as Error).message}`); } };
  const page = (ms = 1500) => sleep(ms);

  // Shift+Cmd+H hides the selection (not the app); Cmd+Z undoes; Shift+Cmd+Z redoes (not a second undo).
  await sel(["r_free"]);
  await t.key("h", ["cmd", "shift"]);
  await check("Shift+Cmd+H (Show/Hide Selection)", () => t.waitDisk(() => t.node("r_free")?.enabled === false, "r_free hidden"));
  await check("Shift+Cmd+H hides no app", async () => t.eq((await t.state()).hides, [], "Hide asked for by Shift+Cmd+H"));
  await t.key("z", ["cmd"]);
  await check("Cmd+Z (Undo)", () => t.waitDisk(() => t.node("r_free")?.enabled === undefined, "r_free shown again"));
  await t.key("z", ["cmd", "shift"]);
  await check("Shift+Cmd+Z (Redo)", () => t.waitDisk(() => t.node("r_free")?.enabled === false, "r_free hidden again by redo"));
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => t.node("r_free")?.enabled === undefined, "r_free shown");

  // Cmd+G groups; Shift+Cmd+G ungroups.
  await sel(["r_free"]);
  await t.key("g", ["cmd"]);
  await check("Cmd+G (Group Selection)", () => t.waitDisk(() => { const p = t.parentOf("r_free"); return p && p !== "lay_nest" && t.node(p)?.type === "group"; }, "r_free in a new group"));
  const grp = t.parentOf("r_free");
  if (grp && grp !== "lay_nest") {
    await sel([grp]);
    await t.key("g", ["cmd", "shift"]);
    await check("Shift+Cmd+G (Ungroup)", () => t.waitDisk(() => t.parentOf("r_free") === "lay_nest" && !t.node(grp), "the group gone, r_free back in the board"));
  }

  // Cmd+C, then with the frame Outer frame selected: Shift+Cmd+V puts the copy back where the original is (in the
  // board, Outer frame does not overlap it); Cmd+V pastes into the selected frame (the paste rules).
  await sel(["r_free"]);
  await t.cmd("qa.pasteboard", { set: "" });
  await t.key("c", ["cmd"]);
  await check("Cmd+C (Copy)", () => t.waitFor(async () => (await t.cmd("qa.pasteboard")).types.includes(CLIP_TYPE), "Canvas's copy on the pasteboard"));
  const orig = t.node("r_free")!;
  const known = () => new Set(t.disk().children.flatMap(function all(n: any): string[] { return [String(n.id), ...(n.children ?? []).flatMap(all)]; }));
  const pasted = (before: Set<string>, what: string) => t.waitDisk(() => [...known()].find((id) => !before.has(id) && t.node(id)?.name === orig.name), what, 8000);
  let before = known();
  await sel(["fr_outer"]);
  await t.key("v", ["cmd", "shift"]);
  await check("Shift+Cmd+V (Paste in Place)", async () => {
    const id = await pasted(before, "the pasted-in-place copy");
    const n = t.node(id)!;
    t.ok(t.parentOf(id) === "lay_nest" && n.x === orig.x && n.y === orig.y, `the copy is in ${t.parentOf(id)} at ${n.x},${n.y}, the original in lay_nest at ${orig.x},${orig.y}`);
  });
  before = known();
  await sel(["fr_outer"]);
  await t.key("v", ["cmd"]);
  await check("Cmd+V (Paste)", async () => {
    const id = await pasted(before, "the pasted copy");
    t.eq(t.parentOf(id), "fr_outer", "Cmd+V pasted into");
  });

  // Shift+Cmd+C copies a PNG (Copy as PNG), not Canvas's layers (Cmd+C above).
  await sel(["r_free"]);
  await t.cmd("qa.pasteboard", { set: "" });
  await t.key("c", ["cmd", "shift"]);
  await check("Shift+Cmd+C (Copy as PNG)", () => t.waitState((s) => s.toast === "Copied as PNG", "the Copied as PNG toast", 20_000));
  await check("Shift+Cmd+C copies no layers", async () => t.ok(!(await t.cmd("qa.pasteboard")).types.includes(CLIP_TYPE), "Canvas's layer copy on the pasteboard"));

  // Shift+Cmd+A selects the other layers in the parent; Cmd+A selects all of them.
  await sel(["r_free"]);
  await t.key("a", ["cmd", "shift"]);
  await check("Shift+Cmd+A (Select Inverse)", () => t.waitFor(async () => { const s = await t.pageSel(); return s.length > 1 && !s.includes("r_free"); }, "the inverse of r_free selected"));
  await sel(["r_free"]);
  await t.key("a", ["cmd"]);
  await check("Cmd+A (Select All)", () => t.waitFor(async () => { const s = await t.pageSel(); return s.length > 1 && s.includes("r_free"); }, "everything in the board selected"));

  // Shift+Cmd+L locks (no link); Cmd+L copies a link (no lock).
  await sel(["r_free"]);
  await t.cmd("qa.pasteboard", { set: "" });
  await t.key("l", ["cmd", "shift"]);
  await check("Shift+Cmd+L (Lock)", () => t.waitDisk(() => t.node("r_free")?.locked === true, "r_free locked"));
  await check("Shift+Cmd+L copies no link", async () => t.ok((await t.cmd("qa.pasteboard")).text === "", "a link was copied"));
  await t.key("l", ["cmd", "shift"]);
  await t.waitDisk(() => t.node("r_free")?.locked === undefined, "r_free unlocked");
  await sel(["r_free"]);
  await t.key("l", ["cmd"]);
  await check("Cmd+L (Copy Link)", () => t.waitFor(async () => /^canvas:\/\//.test((await t.cmd("qa.pasteboard")).text ?? ""), "a link on the pasteboard"));
  await page(400);
  await check("Cmd+L locks nothing", async () => t.ok(t.node("r_free")?.locked === undefined, "r_free got locked"));

  // Shift+Cmd+S asks for Save as Canvas (the panel is noted, never shown); Cmd+S asks for nothing.
  await t.key("s", ["cmd"]);
  await page(600);
  await check("Cmd+S", async () => t.eq((await t.state()).panels, [], "panels asked for by Cmd+S"));
  await t.key("s", ["cmd", "shift"]);
  await check("Shift+Cmd+S (Save as Canvas)", () => t.waitState((s) => s.panels.some((p: string) => /Save as Canvas/.test(p)), "the Save as Canvas panel"));

  // Shift+Cmd+K asks for Place Image's open panel; Cmd+K opens Quick Actions, no panel.
  await t.cmd("qa.reset");
  await sel(["fr_outer"]);
  await t.key("k", ["cmd"]);
  await check("Cmd+K (Quick Actions)", () => t.waitState((s) => s.palette.open && !s.panels.length, "the palette open, no panel"));
  await t.key("Escape");
  await t.waitState((s) => !s.palette.open, "the palette to close");
  await sel(["fr_outer"]);
  await t.key("k", ["cmd", "shift"]);
  await check("Shift+Cmd+K (Place Image)", () => t.waitState((s) => s.panels.some((p: string) => /Place Image/.test(p)) && !s.palette.open, "the Place Image panel, no palette"));

  // A capital letter typed into a field types (Shift+A, Shift+H and Shift+V are menu keys the page handles).
  await openBoard(t, "lay_nest");
  const row = await t.layerRow("r_free");
  await t.doubleClick({ x: row.r.x + 70, y: row.r.y + row.r.h / 2 });
  await t.waitState((s) => s.layerRenaming === "r_free", "the row to turn into a name field");
  await t.key("a", ["cmd"]);
  await t.type("Flip AHV");
  await t.key("Return");
  await check("capitals typed into a field", () => t.waitDisk(() => t.node("r_free")?.name === "Flip AHV", "the name Flip AHV"));
  await check("typing capitals added no auto layout and flipped nothing", async () => t.ok(!t.node("lay_nest")?.layout || t.node("lay_nest")?.layout === "none", `lay_nest has layout ${t.node("lay_nest")?.layout}`));

  // Nothing to redo, the keyboard in the Layers panel (not the page): Shift+Cmd+Z must not fall back to Cmd+Z's Undo.
  await t.waitState((s) => s.layerRenaming === null, "the rename to end");
  const st0 = await t.state();
  await t.key("z", ["cmd", "shift"]);
  await page(900);
  await check(`Shift+Cmd+Z with nothing to redo (first responder ${st0.window.firstResponder})`, async () => t.eq(t.node("r_free")?.name, "Flip AHV", "the name after Shift+Cmd+Z"));

  // Cmd+H asks to hide Canvas (a QA instance counts it instead of hiding).
  await t.click(CANVAS_SPOT);
  await t.key("h", ["cmd"]);
  await check("Cmd+H (Hide Canvas)", () => t.waitState((s) => s.hides.includes("app"), "Hide Canvas"));

  t.ok(!fail.length, `${fail.length} chord${fail.length === 1 ? "" : "s"} misbehaved:\n  ${fail.join("\n  ")}`);
  t.ok(kids().includes("r_free") && kids0.every((id) => kids().includes(id)), "the board kept its layers");
});

// ---------------------------------------------------------------- Copy as, Select layer, export settings, zoom and view

sc("copy-as", "Shift+Cmd+C (Edit > Copy as PNG) puts a 2x PNG on the pasteboard; right-click > Copy as > CSS", { covers: ["copy-as:keyboard", "copy-as:png", "copy-as:one", "copy-as:menu", "copy-as:css", "copy-as:swiftui"] }, async (t: NT) => {
  await t.cmd("qa.pasteboard", { set: "" });
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["fr_inner"]);
  // Edit > Copy as PNG on Shift+Cmd+C, pressed.
  const item = await t.cmd("qa.mainmenu", { title: "Copy as PNG" });
  t.eq([item.key.toLowerCase(), item.mods, item.enabled], ["c", 1048576 | 131072, true], "the item's key is Shift+Cmd+C, enabled with a selection");
  await t.key("c", ["cmd", "shift"]);
  await t.waitState((s) => s.toast === "Copied as PNG", "the Copied as PNG toast", 20_000);
  await t.shot(`${process.cwd()}/qa/out/native/nav-copy-png.png`);
  const pb = await t.cmd("qa.pasteboard", { pngTo: `${process.cwd()}/qa/out/native/nav-copied.png` });
  t.eq([pb.pngInfo?.width, pb.pngInfo?.height], [260, 180], "Inner frame (130 x 90) at 2x");
  t.ok(pb.types.includes("public.png") && pb.types.includes("public.tiff"), `PNG and TIFF on the pasteboard (${pb.types})`);
  // Right-click on the layer: Copy as lists its choices; Copy as CSS puts the layer's CSS there.
  await t.click(center(await t.rect("fr_inner")), { right: true });
  await t.waitState((s) => s.menu, "the right-click menu");
  const sub = (await t.cmd("qa.menu", { sub: "Copy as" })).items.map((i: any) => i.title);
  t.eq(sub, ["Copy as PNG", "Copy as SVG", "Copy as CSS", "Copy as SwiftUI", "Copy as text", "Copy link"], "the Copy as submenu");
  await t.pickMenu("Copy as > Copy as CSS");
  await t.waitState((s) => s.toast === "Copied as CSS", "the Copied as CSS toast", 20_000);
  const css = (await t.cmd("qa.pasteboard")).text as string;
  t.ok(/^\/\* Inner frame \*\/\n\nposition: absolute;\nwidth: 130px;\nheight: 90px;\nleft: 24px;\ntop: 24px;/.test(css), `the CSS: ${css}`);
  t.ok(/border-radius: 6px;/.test(css) && /background: #C7D2FE;/.test(css), "its paint");
  await t.click(center(await t.rect("fr_inner")), { right: true });
  await t.pickMenu("Copy as > Copy as SwiftUI");
  await t.waitState((s) => s.toast === "Copied as SwiftUI", "the Copied as SwiftUI toast", 20_000);
  t.ok(/^\/\/ Inner frame\nRoundedRectangle\(cornerRadius: 6\)/.test((await t.cmd("qa.pasteboard")).text), "SwiftUI");
});

sc("select", "right-click > Select layer lists the layers under the pointer; picking one selects it", { covers: ["select-layer:menu", "select-layer:nested"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["r_free"]);
  await t.click(center(await t.rect("r_inner")), { right: true });
  await t.waitState((s) => s.menu, "the right-click menu");
  const rows = (await t.cmd("qa.menu", { sub: "Select layer" })).items.map((i: any) => i.title);
  t.eq(rows, ["Inner rect", "Inner frame", "Outer frame", "Frames and groups"], "every layer under the pointer, topmost first");
  await t.pickMenu("Select layer > Outer frame");
  await t.waitState((s) => s.selection?.id === "fr_outer", "Outer frame selected");
  await t.shot(`${process.cwd()}/qa/out/native/nav-select-layer.png`);
});

sc("export", "the Export section saves settings on the layer; Shift+Cmd+E exports with them", { covers: ["export:settings", "export:suffix", "export:keyboard", "export:rectangle"] }, async (t: NT) => {
  const dir = fs.mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/canvas-qa-export-`);
  await t.cmd("qa.exportdir", { dir });
  try {
    await t.section("Layers");
    await t.showPage("layout");
    await t.selectIds(["r_inner"]);
    // The Export section's "+" (its frame from the QA build: no text recognition needed).
    const st = await t.waitState((s) => s.frames?.["export.plus"] && s.frames["export.plus"].x + 24 <= s.window.width, "the Export section's + in view (the inspector slides in)", 8000);
    // Until it stops moving: the inspector slides in.
    let f = st.frames["export.plus"];
    for (let i = 0; i < 30; i++) {
      await sleep(150);
      const g = (await t.state()).frames?.["export.plus"];
      if (g && Math.abs(g.x - f.x) < 0.5 && Math.abs(g.y - f.y) < 0.5) break;
      f = g ?? f;
    }
    const plus = center(f);
    t.ok(plus.x > st.window.width - 380, `the + sits in the inspector (${JSON.stringify(plus)})`);
    t.note(`+ at ${JSON.stringify(st.frames["export.plus"])} in ${JSON.stringify(st.window)}`);
    const exports = () => (t.node("r_inner")?.metadata?.canvasExports ?? []) as any[];
    await t.click(plus);
    await t.waitDisk(() => exports().length === 1, `one export setting (${t.notes.join("; ")})`);
    await t.click(plus);
    await t.waitDisk(() => exports().length === 2, "two export settings");
    t.eq(exports().map((e) => [e.format, e.scale, e.suffix ?? ""]), [["png", 1, ""], ["png", 1.5, "@1.5x"]], "1x, then the next scale up with its suffix");
    await sleep(300);
    await t.shot(`${process.cwd()}/qa/out/native/nav-export-section.png`);
    const item = await t.cmd("qa.mainmenu", { title: "Export\u2026" });
    t.eq([item.key.toLowerCase(), item.mods, item.enabled], ["e", 1048576 | 131072, true], "File > Export on Shift+Cmd+E");
    await t.key("e", ["cmd", "shift"]);
    await t.waitState((s) => /Exported 2 files/.test(s.toast ?? ""), "the export", 30_000);
    t.eq(fs.readdirSync(dir).sort(), ["Inner rect.png", "Inner rect@1.5x.png"], "one file per setting, named with its suffix");
  } finally {
    await t.cmd("qa.exportdir", {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

sc("menus", "zoom pill: type 150 and Return; View > Pixel Grid (Cmd+') and Rulers (Shift+R)", { covers: ["pan-zoom:typed", "pixel-grid:menu", "rulers:menu"] }, async (t: NT) => {
  await openZoomField(t);
  await t.type("150", { window: "popover" });
  await t.shot(`${process.cwd()}/qa/out/native/nav-zoom-typed.png`, "popover");
  await t.key("Return", [], { window: "popover" });
  await t.waitState((s) => s.zoom === 150 && !s.zoomFieldOpen, "zoom 150% and the popover closed");
  const z = await t.js<number>("return window.canvasHost.cam.z;");
  t.ok(Math.abs(z - 1.5) < 1e-9, `the camera is at 150% (${z})`);
  const grid0 = (await t.state()).pixelGrid;
  await t.key("'", ["cmd"]);
  await t.waitState((s) => s.pixelGrid === !grid0, "Pixel Grid toggled by Cmd+'");
  t.eq((await t.cmd("qa.mainmenu", { title: "Pixel Grid" })).state, !grid0, "View > Pixel Grid's checkmark");
  await t.key("'", ["cmd"]);
  await t.waitState((s) => s.pixelGrid === grid0, "and back");
  await t.click(CANVAS_SPOT);
  await t.key("r", ["shift"]);
  await t.waitState((s) => s.rulers === true, "Rulers on by Shift+R");
  await sleep(300);
  await t.shot(`${process.cwd()}/qa/out/native/nav-rulers-app.png`);
  await t.key("r", ["shift"]);
  await t.waitState((s) => s.rulers === false, "Rulers off");
});

sc("find", "Cmd+F through Edit > Find and Replace: find, Replace all on every page, one undo", { covers: ["find-replace:keyboard", "find-replace:other-page"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["r_free"]);
  const count = () => { let n = 0; const v = (ns: any[]) => { for (const x of ns ?? []) { if (x.type === "text" && typeof x.content === "string") n += x.content.toLowerCase().split("auto").length - 1; v(x.children); } }; v(t.disk().children); return n; };
  const before = count();
  t.ok(before >= 2, `the playground says Auto a few times (${before})`);
  await t.key("f", ["cmd"]);
  await t.waitJs("window.canvasHost.findReplace && window.canvasHost.findReplace.isOpen && document.activeElement === document.querySelector('#findBar .q')", "the find bar open with its field focused");
  await t.type("Auto");
  await t.waitJs(`window.canvasHost.findReplace.state.total === ${before}`, `${before} matches`);
  await t.key("Return");
  await t.waitJs("window.canvasHost.findReplace.state.i === 0", "the first match shown");
  await t.js(`document.querySelector("#findBar .rep").focus(); return true;`);
  await t.type("Self");
  await sleep(300);
  await t.shot(`${process.cwd()}/qa/out/native/find-replace.png`);
  // Cmd+Return in the replace field: Replace all.
  await t.key("Return", ["cmd"]);
  await t.waitDisk(() => count() === 0, "every Auto replaced");
  await t.key("Escape");
  await t.waitJs("!window.canvasHost.findReplace.isOpen", "Esc closes the bar");
  await t.selectIds(["r_free"]);
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => count() === before, "one undo brings every one back");
});

/** The Typography font size field: the field right above the "Letter spacing" caption (same column). */
async function sizeField(t: NT) {
  const st = await t.state();
  const region = { x: st.window.width - 380, y: 60, w: 380, h: st.window.height - 60 };
  await t.waitText("Letter spacing", region, 8000);
  const m = (await t.findText("Letter spacing", region))[0];
  const above = (await t.fields()).filter((f) => f.y + f.h <= m.y + 2 && f.y > m.y - 70).sort((a, b) => b.y - a.y || Math.abs(a.x - m.x) - Math.abs(b.x - m.x));
  if (!above.length) throw new Error("no font size field above Letter spacing");
  return above[0];
}

sc("inspector", "font size on selected letters while editing; a styled text reads Mixed", { covers: ["text-ranges:text", "text-ranges:mouse", "inspector:text"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["tx_auto"]); // "Auto width grows sideways", 16 px
  await t.js(`window.canvasHost.textEdit.enter("tx_auto", { all: true }); return true;`);
  await t.waitJs("window.canvasHost.textEdit.active", "the edit open");
  await t.js(`window.canvasHost.textEdit.select(5, 10); return true;`); // "width"
  await t.waitState((s) => s.textEditing, "the app knows a text is being edited");
  const f = await sizeField(t);
  t.eq(f.value, "16", "the font size of the selected letters");
  await t.setField(f, "30");
  await t.waitJs(`JSON.stringify(window.canvasHost.textEdit.spans) === ${JSON.stringify(JSON.stringify([{ start: 5, end: 10, fontSize: 30 }]))}`, "the word at 30 px, the rest as it was");
  await t.shot(`${process.cwd()}/qa/out/native/text-range-inspector.png`);
  await t.js(`window.canvasHost.textEdit.commit(); return true;`);
  await t.waitDisk(() => JSON.stringify(t.node("tx_auto")?.spans) === JSON.stringify([{ start: 5, end: 10, fontSize: 30 }]), "the styled range in the file");
  t.eq(t.node("tx_auto")!.fontSize, 16, "the layer keeps its size");
  // Not editing: the layer's size reads Mixed.
  await t.selectIds(["r_free"]);
  await t.selectIds(["tx_auto"]);
  const g = await sizeField(t);
  t.eq([g.value, g.placeholder], ["", "Mixed"], "the font size field says Mixed");
});

sc("text", "typing in a text layer in the app: double-click, type, Return, Cmd+B on a word, Esc", { covers: ["text-edit:text", "text-edit:keyboard", "text-ranges:keyboard"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["tx_auto"]); // "Auto width grows sideways"
  const r = await t.rect("tx_auto");
  // Already selected: a double-click edits it (the word under the pointer selected); the caret goes to the end then.
  await t.doubleClick({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  await t.waitJs("window.canvasHost.textEdit && window.canvasHost.textEdit.active", "the edit open");
  await t.js(`window.canvasHost.textEdit.select(25, 25); return true;`);
  await t.type(" now");
  await t.key("Return");
  await t.type("ok");
  await t.waitJs(`window.canvasHost.textEdit.value === "Auto width grows sideways now\\nok"`, "real keys typed in the field");
  await t.js(`window.canvasHost.textEdit.select(0, 4); return true;`);
  await t.key("b", ["cmd"]);
  await t.waitJs(`JSON.stringify(window.canvasHost.textEdit.spans) === ${JSON.stringify(JSON.stringify([{ start: 0, end: 4, fontWeight: "700" }]))}`, "Cmd+B on the first word");
  await t.key("Escape");
  await t.waitDisk(() => t.node("tx_auto")?.content === "Auto width grows sideways now\nok" && t.node("tx_auto")?.spans?.length === 1, "the text and its bold word written");
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => t.node("tx_auto")?.content === "Auto width grows sideways", "one undo takes the edit back");
});

sc("inspector", "Truncate text and Max lines in Typography", { covers: ["text-truncate:text", "text-truncate:mouse", "inspector:text"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["tx_long"]);
  const st = await t.state();
  const region = { x: st.window.width - 380, y: 60, w: 380, h: st.window.height - 60 };
  // Typography runs past the island on a short window: List style (just above Truncate text) scrolled into view first.
  await intoInspector(t, async () => (await t.state()).frames?.["type.listStyle"], "List style");
  const at = await t.waitText("Truncate text", region, 8000);
  await t.click(at);
  await t.waitDisk(() => t.node("tx_long")?.textTruncation === "ending", "truncation on");
  const f = (await t.fields()).find((x) => x.placeholder === "Max lines");
  t.ok(f, "a Max lines field once truncation is on");
  await t.setField(f!, "2");
  await t.waitDisk(() => t.node("tx_long")?.maxLines === 2, "max lines 2");
  await t.waitJs(`(() => { const r = window.canvasHost.worldRectOf("tx_long"); return r && r.h < 45; })()`, "the paragraph two lines tall");
  await sleep(300);
  await t.shot(`${process.cwd()}/qa/out/native/text-truncate.png`);
  await t.click(at);
  await t.waitDisk(() => t.node("tx_long")?.textTruncation === undefined && t.node("tx_long")?.maxLines === undefined, "off again, max lines with it");
});


// ---------------------------------------------------------------- the Layers panel: lock, Rename Layers, Tab, collapse

const EVIDENCE = `${process.cwd()}/qa/out/native`;
/** The padlock's spot on a hovered row: left of the eye, at the row's trailing edge (Layers.swift LayerRowView). */
const padlock = (r: { x: number; y: number; w: number; h: number }, board = false): Pt => ({ x: r.x + r.w - 6 - (board ? 0 : 22) - 11, y: r.y + r.h / 2 });

sc("layers", "the padlock locks a row; a drag down the padlocks locks the rows it crosses; Shift+Cmd+L unlocks", { covers: ["lock:mouse", "lock:lock-drag", "lock:many", "lock:keyboard"] }, async (t: NT) => {
  await openBoard(t, "lay_nest");
  // rows under the board, front-most first: r_free, g_outer, g_rot, g_pair, fr_outer, lay_nest_cap
  const free = await t.layerRow("r_free");
  await t.move(center(free.r));
  await sleep(250);
  await t.click(padlock(free.r));
  await t.waitDisk(() => t.node("r_free")?.locked === true, "r_free locked");
  await t.waitState((s) => s.layers.find((l: any) => l.id === "r_free")?.locked, "the row to show its padlock closed");
  // A drag from g_outer's padlock down to g_pair's: three rows lock in one write.
  const rows = (await t.rows()).layers;
  const at = (id: string) => rows.find((l) => l.id === id)!;
  await t.move(center(at("g_outer").r));
  await sleep(250);
  await t.drag(padlock(at("g_outer").r), padlock(at("g_pair").r), { steps: 12 });
  await t.waitDisk(() => ["g_outer", "g_rot", "g_pair"].every((id) => t.node(id)?.locked === true), "the three rows locked");
  t.ok(t.node("fr_outer")?.locked !== true, "the drag stopped at g_pair");
  // Children of a locked group show it: the panel marks them locked by their parent.
  await t.shot(`${EVIDENCE}/layers-lock-panel.png`);
  // One undo step for the drag.
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => ["g_outer", "g_rot", "g_pair"].every((id) => t.node(id)?.locked !== true) && t.node("r_free")?.locked === true, "the drag undone in one step");
  // Shift+Cmd+L on the canvas with r_free selected (from the panel) unlocks it.
  await t.click(center(free.r));
  await t.waitState((s) => s.selection?.id === "r_free", "r_free selected from its row");
  await t.key("l", ["cmd", "shift"]);
  await t.waitDisk(() => t.node("r_free")?.locked === undefined, "r_free unlocked");
  t.ok((await t.state()).toast !== "Link copied", "Shift+Cmd+L is not Cmd+L");
});

sc("layers", "Cmd+R with several layers opens Rename Layers; Current name and Number rename them in one undo step", { covers: ["batch-rename:many", "batch-rename:keyboard"] }, async (t: NT) => {
  await openBoard(t, "lay_nest");
  await t.selectIds(["r_free", "g_rot", "g_pair"]);
  await t.waitState((s) => s.selection?.ids?.length === 3, "three layers selected");
  await t.key("r", ["cmd"]);
  const st = await t.waitState((s) => Array.isArray(s.batchRename), "the Rename Layers sheet");
  t.eq(st.batchRename, ["r_free", "g_rot", "g_pair"], "the layers in the panel's order");
  // Rename to starts as $& (the current name): add " $nn" after it.
  await t.key("ArrowRight", ["cmd"]);
  await t.type(" $nn");
  await sleep(500);
  await t.shot(`${EVIDENCE}/layers-batch-rename.png`);
  await t.key("Return");
  await t.waitState((s) => s.batchRename === null, "the sheet to close");
  await t.waitDisk(() => t.node("r_free")?.name === "Free rect 01" && t.node("g_rot")?.name === "Rotated group 02" && t.node("g_pair")?.name === "Group 03", "the three new names");
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => t.node("r_free")?.name === "Free rect" && t.node("g_rot")?.name === "Rotated group" && t.node("g_pair")?.name === "Group", "one undo puts all three back");
});

sc("layers", "Tab while renaming goes to the next row's name; Option+L collapses every row", { covers: ["layers-panel:tab-rename", "layers-panel:collapse-all", "layers-panel:keyboard"] }, async (t: NT) => {
  await openBoard(t, "lay_nest");
  const row = await t.layerRow("r_free");
  await t.doubleClick({ x: row.r.x + 70, y: row.r.y + row.r.h / 2 });
  await t.waitState((s) => s.layerRenaming === "r_free", "r_free's name to open");
  await t.key("a", ["cmd"]);
  await t.type("First");
  await t.key("Tab");
  await t.waitState((s) => s.layerRenaming === "g_outer", "Tab to open the next row's name");
  await t.key("a", ["cmd"]);
  await t.type("Second");
  await t.key("Tab", ["shift"]);
  await t.waitState((s) => s.layerRenaming === "r_free", "Shift+Tab to go back");
  await t.key("Escape");
  await t.waitState((s) => s.layerRenaming === null, "Esc to end the rename");
  await t.waitDisk(() => t.node("r_free")?.name === "First" && t.node("g_outer")?.name === "Second", "both names saved");
  // Option+L on the canvas: every open row closes.
  await t.click(CANVAS_SPOT);
  await t.key("l", ["alt"]);
  await t.waitState((s) => !s.layers.some((l: any) => l.expanded), "every row to close");
  const st = await t.state();
  t.ok(st.layers.every((l: any) => l.depth === 0), "only boards are left");
});

// ---------------------------------------------------------------- auto layout drags, frame by frame

/** qa/frames.ts's driver for the app's web view: points in the page's client px, input as real NSEvents. */
function appDriver(t: NT): Driver {
  return {
    ev: (js) => t.js(`return ${js};`),
    select: async (ids) => { await t.selectIds(ids); },
    settle: async () => { await t.a.flush().catch(() => {}); await t.settle(); },
    drag: async (a, b, steps) => {
      const st = await t.state();
      const w = (p: Pt) => ({ x: p.x + st.webFrame.x, y: p.y + st.webFrame.y });
      await t.drag(w(a), w(b), { steps, holdMs: 60, dwellMs: 120 });
    },
  };
}

sc("autolayout", "every frame of a drag in nested auto layout is clean in the app", { covers: ["autolayout-reorder:nested", "autolayout-reorder:image", "autolayout-reorder:mouse"] }, async (t: NT) => {
  // The maintainer sees it in WKWebView at the display's own rate: the same frame checks as pnpm qa, in the app.
  await t.a.post("/api/structure", { file: t.file, op: "add", nodes: [dragBoard()], place: { parent: null }, page: "style" });
  await t.showPage("style");
  await t.waitJs("window.canvasHost.boards.has('qa_drag') && window.canvasHost.worldRectOf('qd_r2a')", "the drag board");
  await t.look(0, 700);
  const d = appDriver(t);
  const evidence = path.join(ROOT, "qa", "out", "native", "frames");
  const problems: string[] = [];
  let r = await clientRects(d, ["qd_r2"]);
  let res = await checkDragFrames(d, { id: "qd_r0", to: { x: r.qd_r2.x + r.qd_r2.w / 2, y: r.qd_r2.y + r.qd_r2.h - 4 }, areas: ["qd_list"], kids: ["qd_r1", "qd_r2", "qd_r3"], evidence });
  problems.push(...res.problems);
  t.note(`row drag in the app: ${res.frames} frames, p50 / p95 ${res.gapP50.toFixed(1)} / ${res.gapP95.toFixed(1)} ms apart`);
  r = await clientRects(d, ["qd_r2c"]);
  res = await checkDragFrames(d, { id: "qd_r2a", to: { x: r.qd_r2c.x + r.qd_r2c.w - 3, y: r.qd_r2c.y + r.qd_r2c.h / 2 }, areas: ["qd_r2"], kids: ["qd_r2t", "qd_r2c"], busy: true, evidence });
  problems.push(...res.problems);
  t.ok(!problems.length, problems.join("\n  "));
  await t.waitDisk(() => t.node("qd_r2")?.children?.at(-1)?.id === "qd_r2a", "the avatar at the end of its row");
  t.eq(t.node("qd_list")!.children!.map((c: any) => c.id), ["qd_r1", "qd_r2", "qd_r0", "qd_r3"], "the rows after the first drag");
});
import "./scenarios-fills.ts";
import "./scenarios-gaps-text.ts";
import "./scenarios-gaps.ts";

sc("arrange", "the inspector's Spacing field sets the space between evenly spaced layers", { covers: ["smart-selection:inspector", "smart-selection:many"] }, async (t: NT) => {
  // Three squares 20 apart: a smart selection (src/page/smart.js) shows the space between fields.
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "style", place: { parent: null }, nodes: [{ type: "frame", id: "qa_sm", name: "Smart", x: 0, y: 1200, width: 400, height: 140, fill: "#FFFFFF", layout: "none",
    children: [0, 1, 2].map((i) => ({ type: "rectangle", id: `qs_${i}`, name: `Square ${i}`, x: 40 + i * 80, y: 40, width: 60, height: 60, cornerRadius: 8, fill: ["#F43F5E", "#F59E0B", "#22C55E"][i] })) }] });
  await t.showPage("style");
  await t.waitJs("window.canvasHost.boards.has('qa_sm') && window.canvasHost.worldRectOf('qs_2')", "the smart board");
  await t.look(0, 1200);
  await t.js(`window.canvasHost.setSelection(["qs_0", "qs_1", "qs_2"]);`);
  await t.waitJs("window.canvasHost.smart && window.canvasHost.smart.state && window.canvasHost.smart.state.gap === 20", "the smart selection");
  const f = await t.fieldBelow("Spacing", 40);
  t.eq(f.value, "20", "the horizontal space between field");
  await t.shot(`${process.cwd()}/qa/out/native/moving-smart-inspector.png`);
  await t.setField(f, "30");
  await t.waitDisk(() => t.node("qs_2")?.x === 220, "the squares 30 apart");
  t.eq(t.node("qs_0")!.x, 40, "the first one stays");
  const now = await t.fieldNow(f);
  t.eq(now?.value, "30", "the field after");
});

sc("inspector", "letter spacing: the token button on hover sits beside the number, never over it", { covers: ["inspector:text"] }, async (t: NT) => {
  await t.selectIds(["tx_auto"]);
  const check = async (what: string) => {
    // Posted pointer moves never start a hover: the QA build shows the button as a hovered field would.
    await t.cmd("qa.hoverbind", { on: true });
    const f = await t.fieldBelow("Letter spacing", 40);
    await t.mark({ id: "token-bind" });
    // Every field shows one now: take the one in the letter spacing box (its row, right of the number's start).
    const b = (await t.marks({ id: "token-bind" })).find((m) => Math.abs(m.y + m.h / 2 - (f.y + f.h / 2)) < 12 && m.x > f.x);
    if (!b) throw new Error(`${what}: no token button in the letter spacing field`);
    t.ok(b.x >= f.x + f.w - 0.5, `${what}: the token button (x ${b.x.toFixed(1)}) starts inside the number field (it ends at ${(f.x + f.w).toFixed(1)})`);
    // Auto sits beside the caption, above the field, whole.
    const auto = (await t.findText("Auto", { x: f.x - 40, y: f.y - 30, w: 220, h: 30 }));
    t.ok(auto.length > 0, `${what}: no "Auto" beside the Letter spacing caption`);
    await t.cmd("qa.hoverbind", { on: false });
  };
  await check("Auto on");
  // A value of your own: "px" shows too, the tightest the field gets.
  await t.setField(await t.fieldBelow("Letter spacing", 40), "0.37");
  await t.waitDisk(() => Math.abs((t.node("tx_auto")?.letterSpacing as number) - 0.37) < 0.001, "letterSpacing 0.37");
  await check("0.37 px");
  await t.cmd("qa.hoverbind", { on: true });
  await inspectorShot(t, "letter-spacing-token-button");
});
