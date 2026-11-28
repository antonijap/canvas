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

// An agent adds a layer whose picture it writes a moment later: the first fetch was a 404, and the engine marked the
// image gone for good, so the layer stayed empty until the file was opened again.
sc("render", "an image fill whose file is written after the file opened appears without reopening", { covers: ["image-fill:image"], skip: { visual: "checks the renderer of another file; the scenario's own file is unchanged" } }, async (t: T) => {
  const file = path.join(path.dirname(t.file), "Late image.canvas");
  fs.mkdirSync(path.join(file, "images"), { recursive: true });
  const doc = { version: "2.21", children: [
    { type: "frame", id: "qa_late", name: "Late", x: 0, y: 0, width: 400, height: 300, fill: "#FFFFFF", children: [
      { type: "rectangle", id: "qa_late_img", name: "Picture", x: 20, y: 20, width: 300, height: 200, fill: { type: "image", url: "images/late.png", mode: "fill" } },
    ] },
  ] };
  fs.writeFileSync(path.join(file, "document.json"), JSON.stringify(doc, null, 1));
  fs.writeFileSync(path.join(file, "widgets.json"), JSON.stringify({ version: 1, pages: [{ id: "page-1", name: "Page 1", boards: ["qa_late"] }], widgets: [] }, null, 2));
  const tab = await openTab(t.chromePort);
  try {
    await tab.page.send("Page.bringToFront");
    const o = new T(tab.page, file, { ...t.srv, base: t.srv.base.replace("127.0.0.1", "localhost") });
    await o.open();
    await o.waitFor("window.__canvas.renderer === 'engine'", "the engine", 15000);
    await sleep(800);
    t.eq(await o.ev<number>("window.canvasHost.engineView.imageStats().decodedBytes"), 0, "nothing to draw while the picture is missing");
    fs.writeFileSync(path.join(file, "images", "late.png"), gradientPng(320, 200));
    await o.waitFor("window.canvasHost.engineView.imageStats().decodedBytes > 0", "the picture to be drawn once it is on disk", 12000);
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

async function openSynthetic(t: T, script: string, run: (o: T, write: (width: number) => void) => Promise<void>, extraBoards = 0) {
  const file = path.join(path.dirname(t.file), "Opening.canvas");
  fs.mkdirSync(file);
  const write = (width: number) => {
    const doc = { version: "2.21", children: [
      { id: "anna", type: "frame", name: "Anna", x: 0, y: 0, width: 300, height: 200, fill: "#FFFFFF", children: [
        { id: "ben", type: "rectangle", name: "Ben", x: 10, y: 10, width, height: 40, fill: "#333333" },
      ] },
      ...Array.from({ length: extraBoards }, (_, i) => ({
        id: "board-" + i, type: "frame", x: (i % 6 + 1) * 320, y: Math.floor(i / 6) * 240,
        width: 300, height: 200, fill: "#FFFFFF",
      })),
    ] };
    const next = path.join(file, "document.next");
    fs.writeFileSync(next, JSON.stringify(doc));
    fs.renameSync(next, path.join(file, "document.json"));
  };
  write(100);
  // The playground's streams share an HTTP connection limit with tabs on its origin.
  const srv = { ...t.srv, base: t.srv.base.replace("127.0.0.1", "localhost") };
  const tab = await openTab(t.chromePort);
  try {
    await tab.page.send("Page.bringToFront");
    await tab.page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await tab.page.send("Page.addScriptToEvaluateOnNewDocument", { source: script });
    await tab.page.goto(`${srv.base}/?file=${encodeURIComponent(file)}&shell=native`);
    await run(new T(tab.page, file, srv), write);
  } finally {
    await tab.close();
    await t.page.send("Page.bringToFront");
  }
}

sc("render", "a newly available font redraws open boards", { covers: ["font-refresh:focus", "font-refresh:shell-command"], skip: { visual: "uses a separate synthetic file" } }, async (t: T) => {
  await openSynthetic(t, `
    const realFetch = window.fetch;
    window.availableFonts = [];
    window.fetch = (url, init) => {
      const target = new URL(url, location.href);
      if (target.pathname === "/api/scene/env" && window.newFontEnv) return Promise.resolve(Response.json({ env: window.newFontEnv }));
      const family = target.searchParams.get("family");
      if (target.pathname === "/api/fonts/file" && family?.startsWith("Refresh Test ")) {
        if (!window.availableFonts.includes(family)) return Promise.resolve(new Response(null, { status: 404 }));
        target.searchParams.set("family", "Courier New");
        return realFetch(target, init);
      }
      return realFetch(url, init);
    };
  `, async (o) => {
    await o.waitFor("window.canvasHost.worldRectOf('ben')", "the board to draw");
    await o.a.post("/api/structure", { file: o.file, op: "add", nodes: ["focus", "command"].map((id, i) => ({
      id, type: "text", name: id, x: 10, y: 60 + i * 40, content: "iiiiiiiiiiii",
      fontFamily: "Refresh Test " + id, fontSize: 32, textGrowth: "auto", fill: "#111111",
    })), place: { parent: "anna" } });
    const width = (id: string) => `window.canvasHost.worldRectOf('${id}')?.w`;
    const fallback = await o.waitFor<number>(width("focus"), "the fallback text to draw");
    const commandFallback = await o.waitFor<number>(width("command"), "the second fallback text to draw");

    await o.ev(`window.availableFonts.push("Refresh Test focus"); window.newFontEnv = "abcdef123456"; window.dispatchEvent(new Event("focus"));`);
    await o.waitFor(`${width("focus")} > ${fallback}`, "the focus check to lay out the new face");

    await o.ev(`window.availableFonts.push("Refresh Test command"); window.canvasCmd({ cmd: "fontsChanged" });`);
    await o.waitFor(`${width("command")} > ${commandFallback}`, "the shell command to lay out the new face");
  });
});

sc("render", "a stalled native GPU fence stops waiting and draws the board", { covers: ["renderer-fallback:gpu-fence"], skip: { visual: "uses a separate synthetic file" } }, async (t: T) => {
  await openSynthetic(t, `
    const fence = GPUQueue.prototype.onSubmittedWorkDone;
    GPUQueue.prototype.onSubmittedWorkDone = function () {
      if (!new Error().stack.split("\\n")[2]?.includes("/page/engine-view.js:")) return fence.call(this);
      window.stalledFence = true;
      return new Promise(() => {});
    };
  `, async (o) => {
    await o.waitFor("window.stalledFence", "the page's GPU fence to stall");
    await o.waitFor("window.__canvas.renderer === 'engine' && !!document.getElementById('engine')?.isConnected && window.__canvas.inViewLoaded()", "the engine to present after the fence deadline", 9000);
  });
});

sc("render", "a stalled scene stream retries before reporting a completed load", { covers: ["renderer-fallback:scene-stream"], skip: { visual: "uses a separate synthetic file" } }, async (t: T) => {
  await openSynthetic(t, `
    const realFetch = window.fetch;
    window.fetch = (url, init) => {
      if (String(url).includes("/api/scenes?") && !window.stalledStream) {
        window.stalledStream = true;
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
          },
        })));
      }
      return realFetch(url, init);
    };
  `, async (o) => {
    await o.waitFor("window.stalledStream", "the bulk scene stream to stall");
    await o.waitFor("window.canvasHost.worldRectOf('ben') && canvasHost.perf.load !== null", "the retry to draw and finish reporting", 21000);
    const { load, landed } = await o.ev("window.canvasHost.perf");
    t.ok(landed !== null && load >= landed, "load is measured after a board actually lands");
  }, 48);
});

sc("render", "external writes during engine startup recover from a stalled scene", { covers: ["renderer-fallback:scene-reload"], skip: { visual: "uses a separate synthetic file" } }, async (t: T) => {
  await openSynthetic(t, `
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      await new Promise(resolve => { window.releaseDevice = resolve; });
      return request.apply(this, args);
    };
    const realFetch = window.fetch;
    window.fetch = (url, init) => {
      if (url === "/api/ack" && window.stallAck) {
        window.stallAck = false;
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      }
      if (String(url).includes("/api/scene?") && !window.stalledScene) {
        window.stalledScene = true;
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
          },
        })));
      }
      return realFetch(url, init);
    };
  `, async (o, write) => {
    const rev = await o.waitFor<string>("window.releaseDevice && window.canvasHost.doc?.revision", "the first revision during startup");
    write(120);
    await o.waitFor(`window.canvasHost.doc.revision !== ${JSON.stringify(rev)}`, "the external revision during startup");
    t.eq(await o.ev("window.__canvas.renderer"), "pending", "the engine is still starting");
    await o.ev("window.releaseDevice()");
    await o.waitFor("window.stalledScene", "the first scene body's stall");
    await o.waitFor("window.canvasHost.worldRectOf('ben')?.w === 120", "the same revision to load after the stalled scene", 20000);
    t.eq(await o.ev("window.__canvas.renderer"), "engine", "a stalled scene recovers on the engine");
    write(130);
    await o.waitFor("window.canvasHost.worldRectOf('ben')?.w === 130", "the next external revision to draw");
    write(140);
    write(150);
    await o.waitFor("window.canvasHost.worldRectOf('ben')?.w === 150", "the last of consecutive writes to draw");
    const measure = (timeoutMs: number) => o.a.post("/api/bridge/cmd", { file: o.file, op: "measure", args: { ids: ["ben"] }, timeoutMs });
    t.ok((await measure(2000)).result.nodes[0].drawn, "the bridge measures the updated board");
    await o.ev("window.stallAck = true");
    const code = await measure(500).then(() => null, (e) => e.body?.error?.code);
    t.eq(code, "timeout", "the stalled acknowledgement times out");
    t.ok((await measure(6500)).result.nodes[0].drawn, "a stalled acknowledgement does not block the next command");
  });
});
