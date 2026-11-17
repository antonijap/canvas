// QA scenarios for fills on the canvas: the paint keys (Option+/, Shift+/, Shift+X in src/page/shortcuts.js), cropping
// an image by double-clicking it (src/page/image-crop.js), and the engine drawing image modes, blend modes and corner
// smoothing (engine/src/paint.rs). The inspector's paint popover is driven natively (qa/native/scenarios.ts).
import fs from "node:fs";
import path from "node:path";
import { decodePng } from "../fidelity/png.ts";
import { sc, T } from "./harness.ts";
import { ROOT, gradientPng, openTab, sleep } from "./lib.ts";

const OUT = path.join(ROOT, "qa", "out");

/** The mean colour of a window rect, from a screenshot. */
async function meanColor(t: T, r: { x: number; y: number; w: number; h: number }) {
  const img = decodePng(await t.shot({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }));
  const s = [0, 0, 0];
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) s[c] += img.data[i * 4 + c];
  return s.map((v) => Math.round(v / n));
}

sc("properties", "Shift+X swaps fill and stroke, Shift+/ removes the stroke, Option+/ the fill; each one undo step", { covers: ["paint-keys:rectangle", "paint-keys:keyboard", "paint-keys:many"] }, async (t: T) => {
  await t.showPage("style");
  await t.focus("sty_paint");
  await t.select(["pt_stroke"]);
  await t.io.key("x", { shift: true });
  await t.flush();
  t.eq([t.node("pt_stroke")!.fill, t.node("pt_stroke")!.stroke, t.node("pt_stroke")!.strokeWidth], ["#0F172A", "#FFFFFF", 3], "Shift+X swapped them");
  await t.io.key("/", { shift: true });
  await t.flush();
  t.eq([t.node("pt_stroke")!.stroke, t.node("pt_stroke")!.strokeWidth], [undefined, undefined], "Shift+/ took the stroke and its width");
  await t.io.key("/", { alt: true });
  await t.flush();
  t.eq(t.node("pt_stroke")!.fill, undefined, "Option+/ took the fill");
  await t.undo();
  t.eq(t.node("pt_stroke")!.fill, "#0F172A", "undo brings the fill back");
  await t.undo();
  await t.undo();
  t.eq([t.node("pt_stroke")!.fill, t.node("pt_stroke")!.stroke], ["#FFFFFF", "#0F172A"], "three undo steps back to the start");
  // Several layers: a fill each goes, in one step.
  await t.select(["pt_solid", "pt_grad"]);
  await t.io.key("/", { alt: true });
  await t.flush();
  t.eq([t.node("pt_solid")!.fill, t.node("pt_grad")!.fill], [undefined, undefined], "both fills gone");
  await t.undo();
  t.eq(t.node("pt_solid")!.fill, "#2563EB", "one undo brings both back");
  t.ok(t.node("pt_grad")!.fill, "the gradient is back too");
});

sc("properties", "Control+Cmd+M makes the ellipse a mask: it is not drawn, the layers above it are cut away outside it", { covers: ["use-as-mask:ellipse", "use-as-mask:keyboard"] }, async (t: T) => {
  await t.focus("lay_resize");
  const img0 = await meanColor(t, await t.rect("rz_img"));

  await t.select(["rz_ell"]);
  await t.io.key("m", { ctrl: true, meta: true });
  await t.flush();
  t.eq(t.node("rz_ell")!.mask, true, "the ellipse is a mask");
  await t.settle();
  await t.frames(4);
  // The image layer above the mask, outside the ellipse, is cut away: the board's white shows.
  const bg = await meanColor(t, await t.rect("rz_img").catch(() => ({ x: 0, y: 0, w: 1, h: 1 })));
  t.ok(bg.every((v) => v > 240) && img0.some((v) => v < 200), `the image is masked away: ${img0} -> ${bg}`);
  await t.io.key("m", { ctrl: true, meta: true });
  await t.flush();
  t.eq(t.node("rz_ell")!.mask, undefined, "again: no longer a mask");
  await t.undo();
  await t.undo();
  t.eq(t.node("rz_ell")!.mask, undefined, "undo back to the start");
});

sc("properties", "double-click an image layer to crop it: drag the image, drag a corner, Return writes Crop", { covers: ["image-fill:rectangle", "image-fill:image", "image-fill:crop", "image-fill:mouse", "image-fill:keyboard"] }, async (t: T) => {
  await t.focus("lay_resize", 2);
  // A 160 x 120 picture, so the crop shows what it does.
  await t.a.post("/api/update", { file: t.file, id: "rz_img", props: { fill: { type: "image", url: "data:image/png;base64," + gradientPng(160, 120).toString("base64"), mode: "fill" } } });
  await t.flush();
  await t.settle();
  await t.select(["rz_img"]);
  const r = await t.rect("rz_img");
  await t.io.dblclick(r.x + r.w / 2, r.y + r.h / 2);
  const st = await t.waitFor<any>("window.canvasHost.crop && window.canvasHost.crop.state", "crop mode");
  // Fill on a 160 x 120 image in a 100 x 70 layer: it covers the width, overflowing above and below.
  t.near(st.crop.width, 1, 0.001, "Crop starts where Fill showed it: the full width");
  t.near(st.crop.height, (120 * 100) / 160 / 70, 0.001, "and taller than the layer");
  t.eq(await t.ev("getComputedStyle(document.getElementById('sel')).visibility"), "hidden", "the selection box gives way to the crop handles");
  const im = st.screen.im;
  // Drag the bottom right corner out by 40 px: the image grows, its top left stays.
  await t.io.drag(im.x + im.w, im.y + im.h, im.x + im.w + 40, im.y + im.h + 40, { steps: 8 });
  const st2 = await t.ev<any>("window.canvasHost.crop.state");
  t.ok(st2.crop.width > st.crop.width + 0.1, `the corner drag scaled it (${st.crop.width} -> ${st2.crop.width})`);
  t.near(st2.crop.x, st.crop.x, 0.001, "the top left corner stayed");
  t.near(st2.crop.width / st2.crop.height, st.crop.width / st.crop.height, 0.001, "the aspect is kept");
  // Drag the image itself 20 px left.
  const m = st2.screen.im;
  await t.io.drag(m.x + m.w / 2, m.y + m.h / 2, m.x + m.w / 2 - 20, m.y + m.h / 2, { steps: 6 });
  const st3 = await t.ev<any>("window.canvasHost.crop.state");
  t.near(st3.crop.x, st2.crop.x - 20 / 2 / 100, 0.002, "the pan moved it 20 screen px (10 layer units at 2x)");
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "fills-crop.png"), await t.shot());
  await t.io.key("Enter");
  await t.flush();
  const f = t.node("rz_img")!.fill as any;
  t.eq(f.mode, "crop", "the fill is Crop");
  t.near(f.crop.width, st3.crop.width, 0.001, "its width as dragged");
  t.near(f.crop.x, st3.crop.x, 0.001, "its x as dragged");
  t.eq(await t.ev("window.canvasHost.crop.state"), null, "crop mode ended");
  await t.undo();
  t.eq((t.node("rz_img")!.fill as any).mode, "fill", "one undo step back to Fill");
  await t.undo();
});

sc("properties", "the engine draws a tiled, turned and adjusted image, blend modes and a smoothed corner", { covers: ["image-fill:tile", "image-fill:rotate", "image-fill:adjust", "blend-mode:rectangle", "blend-mode:paint", "blend-mode:layer", "corner-smoothing:rectangle"] }, async (t: T) => {
  await t.showPage("style");
  await t.focus("sty_paint", 2);
  const before = await meanColor(t, await t.rect("pt_solid"));
  // A multiplied yellow paint over the blue: dark, not yellow, not blue.
  await t.a.post("/api/update", { file: t.file, id: "pt_solid", props: { fill: ["#2563EB", { type: "color", color: "#FACC15", blendMode: "multiply" }] } });
  await t.a.post("/api/update", { file: t.file, id: "pt_corners", props: { cornerRadius: 30, cornerSmoothing: 0.6 } });
  await t.a.post("/api/update", { file: t.file, id: "pt_opacity", props: { blendMode: "multiply", opacity: 1 } });
  await t.flush();
  await t.settle();
  await sleep(300);
  const after = await meanColor(t, await t.rect("pt_solid"));
  t.ok(after[2] < before[2] - 100 && after[0] < 80, `multiply darkened the blue under yellow: ${before} -> ${after}`);
  // Adjusted and turned image: saturation -1 makes the gradient image grey.
  await t.showPage("layout");
  await t.focus("lay_resize", 2);
  await t.a.post("/api/update", { file: t.file, id: "rz_img", props: { fill: { type: "image", url: (t.node("rz_img")!.fill as any).url, mode: "tile", scale: 4, rotation: 90, adjust: { saturation: -1 } } } });
  await t.flush();
  await t.settle();
  await t.waitFor<boolean>("!window.canvasHost.engineView || window.canvasHost.engineView.imagesPending() === 0", "the adjusted image to decode", 8000);
  await sleep(300);
  const r = await t.rect("rz_img");
  const img = decodePng(await t.shot({ x: Math.round(r.x) + 2, y: Math.round(r.y) + 2, width: Math.round(r.w) - 4, height: Math.round(r.h) - 4 }));
  let grey = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const [R, G, B] = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
    if (Math.max(R, G, B) - Math.min(R, G, B) < 12) grey++;
  }
  t.ok(grey / (img.width * img.height) > 0.9, `saturation -100 drew grey pixels (${Math.round((100 * grey) / (img.width * img.height))}%)`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "fills-render.png"), await t.shot());
});

/** A package of one board holding a shader fill and an image fill, beside the scenario's own file. */
function shaderAndImageFile(t: T): string {
  const file = path.join(path.dirname(t.file), "Fills.canvas");
  fs.mkdirSync(path.join(file, "images"), { recursive: true });
  fs.writeFileSync(path.join(file, "images", "qa-grad.png"), gradientPng(640, 400));
  const doc = { version: "2.21", children: [
    { type: "frame", id: "qa_fills", name: "Fills", x: 0, y: 0, width: 800, height: 600, fill: "#FFFFFF", children: [
      { type: "rectangle", id: "qa_shader", name: "Shader", x: 20, y: 20, width: 300, height: 200, fill: { type: "shader", shader: "mesh-gradient", preset: "Default", params: { speed: 0.25 } } },
      { type: "rectangle", id: "qa_image", name: "Image", x: 360, y: 20, width: 300, height: 200, fill: { type: "image", url: "images/qa-grad.png", mode: "fill" } },
    ] },
  ] };
  fs.writeFileSync(path.join(file, "document.json"), JSON.stringify(doc, null, 1));
  fs.writeFileSync(path.join(file, "widgets.json"), JSON.stringify({ version: 1, pages: [{ id: "page-1", name: "Page 1", boards: ["qa_fills"] }], widgets: [] }, null, 2));
  return file;
}

// The image arriving painted the board again mid-frame: its shader fill got a new placeholder without a texture,
// vello panicked on it ("Tried to draw an invalid empty image") and the restarted engine never came up.
sc("render", "a board with a shader fill and an image fill opens on the engine without a panic", { covers: ["shader-fill:with-image"], skip: { visual: "checks the renderer of another file; the scenario's own file is unchanged" } }, async (t: T) => {
  const file = shaderAndImageFile(t);
  const tab = await openTab(t.chromePort);
  try {
    // Headless Chrome draws only the front tab; another host name keeps the first tab's long polls out of the way.
    await tab.page.send("Page.bringToFront");
    const o = new T(tab.page, file, { ...t.srv, base: t.srv.base.replace("127.0.0.1", "localhost") });
    await o.open();
    // Past the image's arrival and a few shader frames.
    await sleep(1500);
    await o.frames(8);
    const bad = tab.page.console.filter((l) => l.includes("canvas engine panic") || l.includes("starting a new engine"));
    t.eq(bad.map((l) => l.slice(0, 160)), [], "no engine panic or restart");
    t.eq(await o.ev<string>("window.__canvas.renderer"), "engine", "the engine draws the file");
  } finally { await tab.close(); }
  await t.page.send("Page.bringToFront");
  await t.settle();
});

// A frame that traps leaves its wasm instance unusable: a new engine started in it never came up and the renderer
// stayed "pending". The restart must start in a fresh instance (or fall back to the DOM, never wait forever).
sc("render", "after the engine traps, a new engine starts in a fresh wasm instance", { covers: ["renderer-fallback:engine-restart"], skip: { visual: "the playground as the other scenarios draw it" } }, async (t: T) => {
  // The running instance behaves as a trapped one: every frame throws, and an engine started in it never settles.
  await t.ev(`import("/engine/canvas_engine.js").then((m) => { m.Engine.prototype.frame = function () { throw new WebAssembly.RuntimeError("unreachable"); }; m.Engine.create = () => new Promise(() => {}); return true; })`);
  await t.ev("window.canvasHost.setCam({ z: 1, x: 40, y: 60 })");
  await t.waitFor("/unreachable/.test(window.__canvas.note || '')", "the engine to fail its frame", 8000);
  const r = await t.waitFor<string>("['engine', 'dom'].includes(window.__canvas.renderer) && window.__canvas.renderer", "the renderer to leave pending", 25000);
  t.eq(r, "engine", "a new engine runs");
  await t.settle();
});
