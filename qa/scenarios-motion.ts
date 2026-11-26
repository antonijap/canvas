import fs from "node:fs";
import path from "node:path";
import { RECORDER_JS } from "./frames.ts";
import { sc, type T } from "./harness.ts";
import { sleep } from "./lib.ts";

const hoverBoard = (id: string, x: number, children: object[]) => ({
  type: "frame", id, name: id, x, y: 10000, width: 220, height: 130, layout: "none", fill: "#203040", children,
});
const hoverLayer = (id: string, x = 20) => ({ type: "rectangle", id, x, y: 20, width: 24, height: 24, fill: "#FF8040" });
const hoverSlide = [{ id: "slide", on: "boardHover", tracks: [{ prop: "translateX", to: 40, duration: 350 }] }];
const hoverState = (t: T) => t.ev<{ sprites: number; outline: boolean }>(`({
  sprites: window.__motion.sprites, outline: getComputedStyle(document.getElementById("hov")).display !== "none"
})`);
const hoverBoxVisible = async (t: T) => (await hoverState(t)).outline;

async function moveToHoverTarget(t: T, id: string) {
  const p = await t.center(id);
  t.eq(await t.ev(`window.canvasHost.pickSelectable(${p.x}, ${p.y}, false)`), id, "pointer hits the layer or board");
  await t.io.move(p.x, p.y);
  await t.frames();
}

async function moveToHoverTitle(t: T, id: string) {
  const title = await t.ev<{ x: number; y: number }>(`(() => {
    const r = window.canvasHost.boards.get(${JSON.stringify(id)}).lbl.el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  t.eq(await t.ev(`window.canvasHost.titleAt(${title.x}, ${title.y})`), id, "pointer hits the board title");
  await t.io.move(title.x, title.y);
  await t.frames();
}

sc("hover-motion", "the hover box stays hidden through the leave animation", {
  covers: ["hover-motion:suppression"],
  skip: { visual: "Checks the transient hover box directly." },
}, async (t: T) => {
  const reduce = (value: string) => t.page.send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-reduced-motion", value }, { name: "prefers-color-scheme", value: "dark" },
  ] });
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [
    hoverBoard("qa_hover_board", 10000, [{ ...hoverLayer("qa_hover_mover"), motion: hoverSlide }, hoverLayer("qa_hover_static", 120)]),
    hoverBoard("qa_plain_board", 10300, [hoverLayer("qa_plain_layer")]),
  ] });
  await reduce("no-preference");
  await t.waitFor("window.canvasHost.boards.has('qa_plain_board')", "the hover test boards");
  await t.focus("qa_hover_board");
  await moveToHoverTarget(t, "qa_hover_mover");
  await t.waitFor("window.__motion.sprites === 1", "hover playback on the motion board");
  t.eq(await hoverBoxVisible(t), false, "the moving layer has no hover box");
  await t.select(["qa_hover_mover"]);
  await moveToHoverTarget(t, "qa_hover_static");
  t.eq(await hoverBoxVisible(t), false, "the stationary layer on the motion board has no hover box");
  t.ok(await t.selBox(), "the selection box still shows");
  await t.clearSel();
  await moveToHoverTarget(t, "qa_hover_board");
  t.eq(await hoverBoxVisible(t), false, "the motion board has no hover box");
  await sleep(400);
  await moveToHoverTitle(t, "qa_hover_board");
  t.eq(await hoverState(t), { sprites: 1, outline: false }, "the title outline stays hidden while the sprite leaves");
  await t.waitFor("window.__motion.sprites === 0", "the leave animation to finish over the title", 1500);
  await t.frames();
  t.eq(await hoverBoxVisible(t), true, "the title outline returns with the pointer still over it");
  await moveToHoverTarget(t, "qa_plain_layer");
  t.eq(await hoverBoxVisible(t), true, "a layer on the plain board has a hover box");

  await reduce("reduce");
  await moveToHoverTarget(t, "qa_hover_static");
  await t.waitFor("window.__motion.sprites === 1", "the reduced motion end pose");
  t.eq(await hoverBoxVisible(t), false, "the reduced motion end pose has no hover box");
  await t.ev(`(() => {
    const e = window.canvasHost.engineView.engine, original = e.boardAt;
    window.__hoverBoardScans = 0;
    e.boardAt = function (...point) { window.__hoverBoardScans++; return original.apply(this, point); };
    window.canvasCmd({cmd:"prefs",prefs:{playHoverMotion:false}});
  })()`);
  await t.frames();
  t.eq(await hoverBoxVisible(t), true, "turning off playback shows the hover box");
  await moveToHoverTarget(t, "qa_hover_board");
  t.eq(await t.ev("window.__hoverBoardScans"), 0, "disabled playback skips the board scan");
  t.eq(await hoverBoxVisible(t), true, "disabled playback still shows the board outline");
});

sc("hover-motion", "hovering a board title from rest leaves its outline visible", {
  covers: ["hover-motion:suppression"],
  skip: { visual: "Checks the transient hover box directly." },
}, async (t: T) => {
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [
    hoverBoard("qa_title_board", 10000, [{ ...hoverLayer("qa_title_mover"), motion: hoverSlide }]),
  ] });
  await t.waitFor("window.canvasHost.boards.has('qa_title_board')", "the title board");
  await t.focus("qa_title_board");
  t.eq(await t.ev("window.__motion.sprites"), 0, "the board starts at rest");
  await moveToHoverTitle(t, "qa_title_board");
  t.eq(await hoverState(t), { sprites: 0, outline: true }, "hovering only the title leaves the board at rest and outlined");
  await t.io.move(6, 90);
});

sc("hover-motion", "the fitted board edge triggers hover at fractional zoom", {
  covers: ["hover-motion:suppression"],
  skip: { visual: "Checks a subpixel pointer position at the fitted edge." },
}, async (t: T) => {
  const id = "qa_fitted_hover";
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [
    hoverBoard(id, 10000.2, [{ ...hoverLayer("qa_fitted_mover"), motion: hoverSlide }]),
  ] });
  await t.waitFor(`window.canvasHost.boards.has('${id}')`, "the fractional board");
  await t.focus(id, 1.25);
  await t.look(10000, 10000, 1.25, 60.4);
  const r = await t.rect(id);
  const target = { x: r.x - 0.4, y: r.y + r.h / 2 };
  t.eq(await t.ev(`window.canvasHost.pickSelectable(${target.x}, ${target.y}, false)`), id, "the layer hit test sees the fitted edge");
  await t.io.move(target.x, target.y);
  await t.frames();
  t.eq(await hoverState(t), { sprites: 1, outline: false }, "the fitted edge starts playback with its outline hidden");
});

sc("hover-motion", "the title outline returns after the leave animation settles into hold", {
  covers: ["hover-motion:suppression"],
  skip: { visual: "Checks the title outline while sprites are still present." },
}, async (t: T) => {
  const id = "qa_hold_title";
  await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [
    hoverBoard(id, 10000, [
      { ...hoverLayer("qa_hold_mover"), motion: [{ ...hoverSlide[0], leave: "hold" }] },
      { ...hoverLayer("qa_reverse_mover", 120), motion: hoverSlide },
    ]),
  ] });
  await t.waitFor(`window.canvasHost.boards.has('${id}')`, "the board with hold and reverse tracks");
  await t.focus(id);
  await moveToHoverTarget(t, id);
  await t.waitFor("window.__motion.sprites === 2", "the hover sprites");
  await sleep(400);
  await moveToHoverTitle(t, id);
  t.eq(await hoverState(t), { sprites: 2, outline: false }, "the title stays hidden during the reverse track");
  await sleep(400);
  t.eq(await hoverState(t), { sprites: 2, outline: true }, "the title returns while the held pose stays on screen");
});

sc("hover-motion", "compiled motion hides the hover box even when promotion is skipped", {
  covers: ["hover-motion:suppression"],
  skip: { visual: "Checks the transient hover box directly." },
}, async (t: T) => {
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [
    hoverBoard("qa_named_board", 10000, [{ ...hoverLayer("qa_named_layer"), name: "boardHover" }]),
    hoverBoard("qa_skipped_board", 10300, [
      { ...hoverLayer("qa_skipped_layer"), motion: hoverSlide }, hoverLayer("qa_later_paint", 54),
    ]),
  ] });
  await t.waitFor("window.canvasHost.boards.has('qa_skipped_board')", "the boards without playable sprites");
  await t.focus("qa_named_board");
  await moveToHoverTarget(t, "qa_named_layer");
  const named = await hoverState(t);
  await t.ev(`(() => {
    const e = window.canvasHost.engineView.engine, original = e.nodeMotionRect;
    window.__promotionAttempts = 0;
    e.nodeMotionRect = function (board, id) {
      if (id === "qa_skipped_layer") window.__promotionAttempts++;
      return original.call(this, board, id);
    };
  })()`);
  await moveToHoverTarget(t, "qa_skipped_layer");
  await t.waitFor(`window.__motion.skipped.some(s => s.id === "qa_skipped_layer" && s.reason === "overlaps later paint")`, "the motion track to be skipped");
  t.eq({ named, skipped: await hoverState(t) }, {
    named: { sprites: 0, outline: true }, skipped: { sprites: 0, outline: false },
  }, "only the board with compiled motion hides the hover box");
  const redraw = () => t.ev(`new Promise(resolve => {
    const step = n => {
      if (!n) return resolve(window.__promotionAttempts);
      window.canvasHost.requestFrame();
      requestAnimationFrame(() => step(n - 1));
    };
    step(5);
  })`);
  t.eq(await redraw(), 1, "unrelated frames do not replan a rejected hover");
  await t.ev(`window.canvasHost.engineView.engine.setTextureBudget(32 * 1024 * 1024)`);
  t.eq(await redraw(), 2, "a new texture budget permits one new plan");
  await moveToHoverTarget(t, "qa_named_layer");
  await moveToHoverTarget(t, "qa_skipped_layer");
  t.eq(await redraw(), 3, "reentering the board permits one new plan");
  await t.a.post("/api/update", { file: t.file, id: "qa_later_paint", props: { x: 120 } });
  await t.waitFor("window.__motion.sprites === 1", "an edit that makes the hovered layer promotable");
  t.eq(await redraw(), 4, "the new scene is planned once with the pointer still over the board");
  await t.io.move(6, 90);
});

sc("hover-motion", "window visibility refreshes the hover box under a stationary pointer", {
  covers: ["hover-motion:suppression"],
  skip: { visual: "Checks the transient hover box directly." },
}, async (t: T) => {
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [
    hoverBoard("qa_window_board", 10000, [{ ...hoverLayer("qa_window_mover"), motion: hoverSlide }]),
  ] });
  await t.waitFor("window.canvasHost.boards.has('qa_window_board')", "the window visibility board");
  await t.focus("qa_window_board");
  await moveToHoverTarget(t, "qa_window_mover");
  await t.waitFor("window.__motion.poses === 1", "the reduced motion pose to be presented");
  t.eq(await hoverState(t), { sprites: 1, outline: false }, "playback hides the hover box");
  await t.ev(`window.canvasCmd({cmd:"motionWindow",visible:false})`);
  await t.frames();
  t.eq(await hoverState(t), { sprites: 0, outline: true }, "hiding the window cancels playback and restores the hover box");
  await t.ev(`window.canvasCmd({cmd:"motionWindow",visible:true})`);
  await t.waitFor("window.__motion.sprites === 1", "playback to resume when the window shows");
  await t.frames();
  t.eq(await hoverBoxVisible(t), false, "showing the window hides the hover box again");
  await t.io.move(6, 90);
});

sc("hover-motion", "sprite playback preserves tiles, clip, paint order and rest pose", {
  covers: ["hover-motion:composite", "hover-motion:rest", "hover-motion:suppression"],
  skip: { visual: "Checks individual engine pixels and texture counters during playback." },
}, async (t: T) => {
  const motion = (to: number, delay = 0) => [{
    id: "slide", on: "boardHover", tracks: [{ prop: "translateX", to, duration: 700, delay }],
  }];
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [{
    type: "frame", id: "qa_motion", name: "Motion sample", x: 10000, y: 10000, width: 220, height: 130, layout: "none", clip: true, fill: "#203040",
    children: [
      { type: "rectangle", id: "qa_mover", x: 20, y: 20, width: 24, height: 24, fill: "#FF8040", motion: motion(90) },
      { type: "frame", id: "qa_motion_parent", x: 140, y: 22, width: 65, height: 30, layout: "none", fill: "#264659",
        motion: [{ id: "rise", on: "boardHover", tracks: [{ prop: "translateY", to: 5, duration: 700 }] }],
        children: [{ type: "rectangle", id: "qa_motion_child", x: 8, y: 8, width: 10, height: 10, fill: "#B3F0DF", motion: motion(12) }] },
      { type: "rectangle", id: "qa_edge", x: 185, y: 68, width: 25, height: 25, fill: "#84DAAA", motion: motion(50) },
      { type: "rectangle", id: "qa_blocked", x: 18, y: 85, width: 20, height: 20, fill: "#84DAAA", motion: motion(60) },
      { type: "rectangle", id: "qa_foreground", x: 62, y: 85, width: 18, height: 20, fill: "#C0C0E0" },
    ],
  }] });
  const reduce = (value: string) => t.page.send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-reduced-motion", value }, { name: "prefers-color-scheme", value: "dark" },
  ] });
  await reduce("no-preference");
  await t.waitFor("window.canvasHost.boards.has('qa_motion')", "the motion board");
  await t.focus("qa_motion");
  await t.io.move(6, 90);
  await t.settle();
  const metrics = () => t.ev<{ full: number; partial: number }>(`(() => {
    const s = window.canvasHost.engineView.engine.stats(); return { full: s.tilesWhole, partial: s.tilesPartial };
  })()`);
  const pixel = (dx: number, dy: number) => t.ev<number[]>(`(() => {
    const h = window.canvasHost, ev = h.engineView, r = h.worldRectOf("qa_motion"), cam = h.cam;
    const d = ev.canvas.width / ev.canvas.clientWidth;
    const sx = Math.floor(((r.x + ${dx}) * cam.z + cam.x) * d), sy = Math.floor(((r.y + ${dy}) * cam.z + cam.y) * d);
    const canvas = ev.capture([{ sx, sy, sw: 1, sh: 1, w: 1, h: 1 }])[0];
    return Array.from(canvas.getContext("2d").getImageData(0, 0, 1, 1).data).slice(0, 3);
  })()`);
  const atRest = await pixel(32, 32);
  t.eq(atRest, [255, 128, 64], "the original layer shows at rest");
  const point = await t.center("qa_motion");
  await t.ev(`(() => {
    const h = window.canvasHost, ev = h.engineView, frame = ev.frame, motion = h.motion, after = motion.afterFrame;
    let held = 0;
    const before = window.__motion.poses;
    ev.frame = function (...args) {
      if (window.__motion.sprites && held < 2) { held++; return false; }
      return frame.apply(this, args);
    };
    motion.afterFrame = function () {
      after.call(this);
      if (held < 2) return;
      ev.frame = frame;
      motion.afterFrame = after;
      window.__posesWithoutFrame = window.__motion.poses - before;
    };
  })()`);
  await t.io.move(point.x, point.y);
  await t.waitFor("window.__motion.poses >= 4", "sprites composited");
  t.eq(await t.ev("window.__posesWithoutFrame"), 0, "transform changes count only when the engine presents a sprite");
  t.eq(await t.ev("({ sprites: window.__motion.sprites, skipped: window.__motion.skipped })"), { sprites: 4, skipped: [{ id: "qa_blocked", reason: "overlaps later paint" }] }, "one blocked sprite");
  const first = await metrics();
  await sleep(160);
  t.eq(await metrics(), first, "pose changes leave rendered tiles intact");
  await sleep(620);
  t.eq(await pixel(122, 32), atRest, "translated pixels reach their target");
  t.eq(await pixel(32, 32), [32, 48, 64], "sprite is gone from its old box");
  t.eq(await pixel(165, 40), [179, 240, 223], "nested motion composes its parent and child translations");
  const edge = await pixel(226, 80);
  t.ok(edge.join(",") !== "132,218,170", "parent clip keeps the sprite off the canvas outside the board");
  await t.io.move(6, 90);
  await t.waitFor("window.__motion.sprites === 0", "the sprite boards are removed after leave");
  t.eq(await pixel(32, 32), atRest, "the original pixels return");
  t.eq(await pixel(122, 32), [32, 48, 64], "the end pose is gone");
  await reduce("reduce");
  const prior = await t.ev<number>("window.__motion.poses");
  await t.io.move(point.x, point.y);
  await t.waitFor("window.__motion.sprites === 4", "reduced motion end pose");
  t.eq(await pixel(122, 32), atRest, "reduced motion jumps to the end pose");
  t.eq(await t.ev("window.__motion.poses"), prior + 1, "reduced motion presents one pose");
  await t.io.move(6, 90);
  await t.waitFor("window.__motion.sprites === 0", "reduced motion restores rest immediately");
  await reduce("no-preference");
  await t.io.move(point.x, point.y);
  await t.waitFor("window.__motion.poses > " + (prior + 1), "full motion resumes");
  await sleep(300);
  await t.io.move(6, 90);
  await t.waitFor("window.__motion.sprites > 0", "the reverse is in flight");
  await reduce("reduce");
  await t.ev("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  t.eq(await t.ev("window.__motion.sprites"), 0, "enabling reduced motion stops an in-flight reverse");
  t.eq(await pixel(32, 32), atRest, "enabling reduced motion off-board restores the original pixels");
  await t.ev(`window.canvasCmd({cmd:"prefs",prefs:{playHoverMotion:false}})`);
  await t.io.move(point.x, point.y);
  await sleep(150);
  t.eq(await t.ev("window.__motion.sprites"), 0, "disabled hover adds no sprites");
});

sc("hover-motion", "held sprites follow the owner's pixel-fitted clip and restore on cancellation", {
  covers: ["hover-motion:composite", "hover-motion:rest"],
  skip: { visual: "Samples the fitted clip edge at device-pixel resolution." },
}, async (t: T) => {
  const dpr = await t.ev<number>("devicePixelRatio");
  const u = (devicePx: number) => devicePx / dpr;
  const reduce = (value: string) => t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] });
  await reduce("no-preference");
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [{
    type: "frame", id: "qa_motion_clip", x: 10000 + u(0.4), y: 10000, width: u(220), height: u(130), layout: "none", fill: "#203040",
    children: [{
      type: "frame", id: "qa_clip_inner", x: 0, y: 0, width: u(70.2), height: u(60), layout: "none", clip: true,
      children: [{
        type: "rectangle", id: "qa_clip_sprite", x: u(40), y: u(20), width: u(20), height: u(20), fill: "#FF8040",
        motion: [{ id: "slide", on: "boardHover", leave: "hold", tracks: [{ prop: "translateX", to: u(25), duration: 150 }] }],
      }],
    }],
  }] });
  await t.waitFor("window.canvasHost.boards.has('qa_motion_clip')", "the fractional board");
  await t.focus("qa_motion_clip");
  const point = await t.center("qa_motion_clip");
  await t.io.move(point.x, point.y);
  const pixel = (x: number) => t.ev<number[]>(`(() => {
    const h = window.canvasHost, ev = h.engineView, r = h.worldRectOf("qa_motion_clip"), d = devicePixelRatio;
    const sx = Math.round(r.x * d) + Math.round(h.cam.x * d) + ${x};
    const sy = Math.round(r.y * d) + Math.round(h.cam.y * d) + 30;
    return Array.from(ev.capture([{ sx, sy, sw: 1, sh: 1, w: 1, h: 1 }])[0]
      .getContext("2d").getImageData(0, 0, 1, 1).data).slice(0, 3);
  })()`);
  await t.waitFor("window.__motion.sprites === 1", "the clipped sprite");
  await sleep(220);
  t.eq(await pixel(69), [255, 128, 64], "the last pixel inside the fitted clip shows the sprite");
  t.eq(await pixel(70), [32, 48, 64], "the first pixel outside the fitted clip shows the owner");
  await t.io.move(6, 90);
  await sleep(80);
  t.eq(await pixel(69), [255, 128, 64], "hold keeps the visible pose on ordinary exit");
  await reduce("reduce");
  await t.waitFor("window.__motion.sprites === 0", "turning on reduced motion clears a held pose");
  t.eq(await pixel(50), [255, 128, 64], "the original layer returns");
  await reduce("no-preference");
  await t.io.move(point.x, point.y);
  await t.waitFor("window.__motion.sprites === 1", "a new hover");
  await sleep(220);
  await t.io.move(6, 90);
  await t.ev(`window.canvasCmd({cmd:"prefs",prefs:{playHoverMotion:false}})`);
  await t.waitFor("window.__motion.sprites === 0", "turning playback off clears a held pose");
  await t.ev("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  t.eq(await pixel(50), [255, 128, 64], "disabling playback restores the original layer");
});

sc("hover-motion", "first frame paints sprites that fall outside the batch atlas", {
  covers: ["hover-motion:composite"],
  skip: { visual: "Samples the actual first engine frame." },
}, async (t: T) => {
  const fill = "#FF8040";
  const size = 344 / await t.ev<number>("devicePixelRatio");
  const step = size + 12;
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [{
    type: "frame", id: "qa_motion_batch", x: 10000, y: 10000, width: 8 * step, height: 5 * step, layout: "none", fill: "#203040",
    children: Array.from({ length: 40 }, (_, i) => ({
      type: "rectangle", id: "qa_motion_batch_" + i, x: (i % 8) * step, y: Math.floor(i / 8) * step,
      width: size, height: size, fill,
      motion: [{ id: "fade", on: "boardHover", tracks: [{ prop: "opacity", to: 0.9, delay: 500, duration: 500 }] }],
    })),
  }] });
  await t.waitFor("window.canvasHost.boards.has('qa_motion_batch')", "the batch board");
  await t.focus("qa_motion_batch");
  await t.io.move(6, 90);
  await t.settle();
  const rect = await t.rect("qa_motion_batch");
  const point = { x: rect.x + 100, y: rect.y + 100 };
  await t.ev(`(() => {
    const h = window.canvasHost, e = h.engineView.engine, m = h.motion, original = m.afterFrame;
    const before = e.stats().tilesBatched;
    m.afterFrame = function () {
      original.call(this);
      if (window.__motion.sprites !== 40) return;
      m.afterFrame = original;
      window.__batchFirstFrame = { batched: e.stats().tilesBatched - before, missing: h.engineView.pictureState().missing };
    };
  })()`);
  await t.io.move(point.x, point.y);
  const first = await t.waitFor("window.__batchFirstFrame", "the first sprite frame") as { batched: number; missing: number };
  t.ok(first.batched > 0 && first.batched < 40, "some urgent sprite tiles overflowed the atlas");
  t.eq(first.missing, 0, "every sprite tile was ready when the rest layers were hidden");
});

// Compare every composite to a pose made by transforming crops of the static board in Canvas 2D.
// The crops contain the original AA and shadow, plus enough plain background to cover the moving edges.
const recordHover = String.raw`(({ region, patches, point, scale, camera }) => {
  const h = window.canvasHost, e = h.engineView.engine, recorder = window.__frames;
  const box = document.getElementById("hov");
  recorder.ref("A", region);
  const canvas = () => Object.assign(document.createElement("canvas"), { width: region.w, height: region.h });
  const rest = canvas(), expected = canvas(), g = expected.getContext("2d", { willReadFrequently: true });
  rest.getContext("2d").putImageData(new ImageData(recorder.A, region.w, region.h), 0, 0);
  const bg = (region.w * 12 + 12) * 4;
  g.fillStyle = "rgb(" + recorder.A.subarray(bg, bg + 3).join(",") + ")";
  const poses = new Map();
  const transform = e.setBoardTransform, remove = e.removeBoard;
  e.setBoardTransform = function (id, ...v) { poses.set(id, v); return transform.call(this, id, ...v); };
  e.removeBoard = function (id) { poses.delete(id); return remove.call(this, id); };
  const flashes = [];
  let phase = "rest", last = e.stats().frames;
  const pointer = event => { phase = Math.abs(event.clientX - point.x) <= 1 ? "enter" : "leave"; };
  addEventListener("pointermove", pointer, true);
  function outline() {
    const style = getComputedStyle(box), rect = box.getBoundingClientRect();
    return style.display !== "none" && style.visibility === "visible" && rect.width > 0 && rect.height > 0;
  }
  // A pointer frame can update the DOM without a composite. Observe it separately.
  const observer = new MutationObserver(() => {
    if (phase !== "rest" && outline()) flashes.push(phase);
  });
  observer.observe(box, { attributes: true, attributeFilter: ["style"] });
  recorder.start(region, 240, 1, () => {
    const n = e.stats().frames;
    if (n === last) return false;
    last = n;
    return { phase, outline: outline(), poses: Array.from(poses.values()), sprites: window.__motion.sprites };
  });
  window.__finishHover = (evidence) => {
    observer.disconnect();
    removeEventListener("pointermove", pointer, true);
    e.setBoardTransform = transform;
    e.removeBoard = remove;
    const { frames } = recorder.stop();
    const bad = [], restFailures = [], outlines = [], identity = [1, 0, 0, 1, 0, 0, 1];
    const { x, y } = camera;
    let moving = 0, maxMean = 0, maxPixels = 0, maxRestMean = 0, maxMoves = 0;
    frames.forEach(({ data, sample }, i) => {
      const { poses, phase, sprites, outline } = sample;
      if (outline) outlines.push(i);
      if (poses.length && poses.some(v => v.some((n, j) => n !== identity[j]))) moving++;
      maxMoves = Math.max(maxMoves, poses.length);
      const still = poses.every(v => v.every((n, j) => n === identity[j]));
      let ref = recorder.A;
      if (!still) {
        g.drawImage(rest, 0, 0);
        for (const p of patches) g.fillRect(p.x, p.y, p.w, p.h);
        patches.forEach((p, j) => {
          const [a, b, c, d, tx, ty] = poses[j] ?? identity;
          g.setTransform(a, b, c, d, tx * scale + (1 - a) * x - c * y, ty * scale - b * x + (1 - d) * y);
          g.drawImage(rest, p.x, p.y, p.w, p.h, p.x, p.y, p.w, p.h);
        });
        g.resetTransform();
        ref = g.getImageData(0, 0, region.w, region.h).data;
      }
      let error = 0, pixels = 0, peak = 0;
      for (let k = 0; k < ref.length; k += 4) {
        const delta = Math.abs(data[k] - ref[k]) + Math.abs(data[k + 1] - ref[k + 1]) + Math.abs(data[k + 2] - ref[k + 2]);
        error += delta;
        peak = Math.max(peak, delta);
        if (delta > 32) pixels++;
      }
      const mean = error / (region.w * region.h);
      maxMean = Math.max(maxMean, mean);
      maxPixels = Math.max(maxPixels, pixels);
      if (still && sprites) maxRestMean = Math.max(maxRestMean, mean);
      // Splitting a transparent layer into a separate texture can round channels by one.
      if (still && (mean > 0.35 || peak > 12)) restFailures.push({ i, phase, sprites, mean: +mean.toFixed(3), peak });
      // The 2D reference and the GPU interpolate moving edges differently.
      if (!still && (mean > 0.7 || pixels > region.w * region.h * 0.003)) bad.push({ i, phase, mean: +mean.toFixed(3), pixels });
    });
    const enter = frames.filter(f => f.sample.phase === "enter"), leave = frames.filter(f => f.sample.phase === "leave");
    const entersAtRest = enter[0]?.sample.poses.every(v => v.every((n, j) => n === identity[j]));
    const leavesAtRest = leave.at(-1)?.sample.sprites === 0;
    let strip;
    if (evidence && enter.length >= 6 && leave.length >= 6) {
      const out = Object.assign(document.createElement("canvas"), { width: region.w * 6, height: region.h * 2 });
      const ctx = out.getContext("2d");
      [enter, leave].forEach((sequence, row) => sequence.slice(0, 6).forEach((f, col) => {
        ctx.putImageData(new ImageData(f.data, region.w, region.h), col * region.w, row * region.h);
      }));
      strip = out.toDataURL().split(",")[1];
    }
    return { total: frames.length, enter: enter.length, leave: leave.length, entersAtRest, leavesAtRest, moving, maxMoves,
      firstSprites: enter[0]?.sample.sprites, flashes, outlines, maxMean, maxPixels, maxRestMean,
      poseFailures: bad.length, restFailures: restFailures.length, examples: [...restFailures.slice(0, 2), ...bad.slice(0, 2)], strip };
  };
})`;

const spring = (tracks: { prop: string; to: number }[]) => [{
  id: "spring", on: "boardHover",
  tracks: tracks.map(track => ({ ...track, delay: 100, ease: { spring: { duration: 420, bounce: 0.2 } } })),
}];
const flashBoard = (id: string, children: object[]) => ({
  ...hoverBoard(id, 10000.25, children), y: 10000.25, height: 162.55, width: 220.45, fill: "#202A3A",
  stroke: "#64748B", strokeWidth: 2, strokeAlignment: "inner",
});
const demos = [
  { name: "shadowed spring card", id: "qa_flash_card", layers: ["qa_flash_card_layer"], pad: 24,
    board: flashBoard("qa_flash_card", [{
      type: "frame", layout: "none", id: "qa_flash_card_layer", x: 55.65, y: 61.65, width: 105.55, height: 53.55, fill: "#E0E7F2",
      cornerRadius: 9, stroke: "#BFA685", strokeWidth: 3, strokeAlignment: "inner",
      effect: [{ type: "shadow", offset: { x: 1, y: 5 }, blur: 12, spread: 1, color: "#00000099" }],
      motion: spring([{ prop: "translateY", to: -12 }, { prop: "scale", to: 1.04 }]),
      children: [{ type: "rectangle", id: "qa_flash_card_detail", x: 8, y: 10, width: 58, height: 4, fill: "#587A9D", cornerRadius: 2 }],
    }]) },
  { name: "rotating spring icon", id: "qa_flash_icon", layers: ["qa_flash_icon_layer"], pad: 9,
    board: flashBoard("qa_flash_icon", [{
      type: "frame", layout: "none", id: "qa_flash_icon_layer", x: 76.35, y: 48.65, width: 66.55, height: 66.55, fill: "#818CF8",
      cornerRadius: 16, motion: spring([{ prop: "scale", to: 1.12 }, { prop: "rotate", to: -6 }]),
      children: [{ type: "ellipse", id: "qa_flash_icon_detail", x: 15, y: 13, width: 33, height: 29, fill: "#EFF6FF" }],
    }]) },
  { name: "staggered auto layout rows", id: "qa_flash_rows", layers: Array.from({ length: 4 }, (_, i) => "qa_flash_row_" + i), pad: 4,
    board: { ...flashBoard("qa_flash_rows", Array.from({ length: 4 }, (_, i) => ({
      type: "rectangle", id: "qa_flash_row_" + i, width: 146.55, height: 20.55, fill: ["#BFD8F1", "#A7F3D0", "#FDE68A", "#FBCFE8"][i],
      cornerRadius: 4, opacity: 0.75,
      motion: [{ id: "slide", on: "boardHover", tracks: [{ prop: "translateX", to: 16, delay: 100 + i * 55, duration: 300 }] }],
    }))), layout: "vertical", gap: 12.55, padding: [18.65, 24.65, 18.65, 24.65] } },
];

for (const demo of demos) sc("hover-motion", `every hover frame preserves the ${demo.name}`, {
  covers: ["hover-motion:composite", "hover-motion:rest", "hover-motion:suppression"],
  skip: { visual: "Compares every animation frame against the static and transformed pixels." },
}, async (t: T) => {
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [demo.board] });
  await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await t.waitFor(`window.canvasHost.boards.has(${JSON.stringify(demo.id)})`, "the motion board");
  await t.focus(demo.id, 1.125);
  await t.io.move(6, 90);
  await t.settle();
  await t.waitFor("!window.canvasHost.motionBlocked()", "the settled camera");
  const point = await t.center(demo.layers[0]);
  t.ok(await t.ev(RECORDER_JS), "engine frame recorder installed");
  const { left, top, dpr, scale, x, y } = await t.ev(`(() => {
    const h = window.canvasHost, { left, top } = h.view.getBoundingClientRect(), dpr = window.__frames.dpr();
    return { left, top, dpr, scale: dpr * h.cam.z, x: Math.round(h.cam.x * dpr), y: Math.round(h.cam.y * dpr) };
  })()`);
  const board = await t.rect(demo.id);
  const region = { x: Math.round((board.x - left) * dpr) - 5, y: Math.round((board.y - top) * dpr) - 5,
    w: Math.round(board.w * dpr) + 10, h: Math.round(board.h * dpr) + 10 };
  const patches = [];
  for (const id of demo.layers) {
    const r = await t.rect(id), pad = demo.pad * scale;
    patches.push({ x: Math.floor((r.x - left) * dpr - region.x - pad), y: Math.floor((r.y - top) * dpr - region.y - pad),
      w: Math.ceil(r.w * dpr + pad * 2) + 1, h: Math.ceil(r.h * dpr + pad * 2) + 1 });
  }
  await t.ev(`${recordHover}(${JSON.stringify({ region, patches, point, scale, camera: { x: x - region.x, y: y - region.y } })})`);
  const evidence = process.env.QA_MOTION_EVIDENCE;
  let result;
  try {
    await t.io.move(point.x, point.y);
    await t.waitFor(`window.__motion.sprites === ${demo.layers.length}`, "all motion sprites");
    await sleep(720);
    await t.io.move(6, 90);
    await t.waitFor("window.__motion.sprites === 0", "the leave animation to finish");
    await t.frames();
  } finally {
    result = await t.ev(`window.__finishHover(${!!evidence})`);
  }
  const { strip, ...summary } = result;
  if (evidence && strip) {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, demo.id + ".png"), Buffer.from(strip, "base64"));
  }
  console.log(`hover frames ${demo.name} ${JSON.stringify(summary)}`);
  t.ok(result.enter >= 6 && result.leave >= 6 && result.moving >= 10 && result.total < 240, "recorded the full play and leave");
  t.eq([result.entersAtRest, result.firstSprites, result.maxMoves, result.leavesAtRest], [true, demo.layers.length, demo.layers.length, true], "covered the sprite handover at each end");
  t.eq([result.flashes.length, result.outlines.length, result.restFailures, result.poseFailures], [0, 0, 0, 0], "no hover outline or missing, doubled or offset paint");
});

const timelinePanel = ".motion-timeline[data-open]";
const timelineKey = ".mt-key[data-selected]";
const timelineAnimation = { id: "move", on: "boardHover", tracks: [{ prop: "translateX", from: 0, to: 100, duration: 500 }] };

async function openTimeline(t: T) {
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [{
    id: "tl_board", name: "Timeline sample", type: "frame", width: 220, height: 160, x: 10000, y: 10000, layout: "none", fill: "#203040",
    children: [
      { id: "tl_marker", name: "Marker", type: "rectangle", x: 24, y: 24, width: 24, height: 24, fill: "#FF8040", motion: [timelineAnimation] },
      { id: "tl_plain", name: "Plain", type: "rectangle", x: 24, y: 100, width: 24, height: 24, fill: "#DFDFFF" },
    ],
  }] });
  await t.open({ native: true });
  await t.focus("tl_board");
  await t.ev("window.canvasCmd({cmd:'prefs',prefs:{playHoverMotion:false}})");
  await t.select(["tl_marker"]);
  await t.waitFor(`document.querySelector(${JSON.stringify(timelinePanel)})`, "the timeline to open");
}

function timelinePoint(t: T, selector: string, fraction = 0.5) {
  return t.ev<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width * ${fraction}, y: r.y + r.height/2 }; })()`);
}

function waitTimelineTrack(t: T, expr: string) {
  return t.waitFor(`(async () => {
    const h = window.canvasHost;
    const j = await (await fetch(h.api("/api/node") + "&id=tl_marker&depth=0")).json();
    const track = j.node.motion[0].tracks[0];
    return ${expr};
  })()`, "the saved motion track");
}

sc("motion-timeline", "timeline entry points add the first property in one undo step", {
  covers: ["motion-timeline:entry"], skip: { visual: "Checks the panel with native bridge commands and keyboard input." },
}, async (t: T) => {
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: null }, nodes: [{
    id: "tl_empty", name: "Motion sample", type: "frame", width: 220, height: 160, x: 10000, y: 10000, layout: "none", fill: "#203040",
    children: [{ id: "tl_card", name: "Card", type: "rectangle", x: 24, y: 24, width: 172, height: 112, fill: "#DFDFFF", opacity: 0.8 }],
  }] });
  await t.page.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.timelineHeights = [];
    window.webkit = { messageHandlers: { canvasState: { postMessage: raw => {
      const { timelineHeight } = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (timelineHeight != null) window.timelineHeights.push(timelineHeight);
    } } } };
  ` });
  await t.open({ native: true });
  await t.focus("tl_empty");
  await t.select(["tl_card"]);
  const isOpen = `!!document.querySelector(${JSON.stringify(timelinePanel)})`;
  t.eq(await t.ev(isOpen), false, "plain selection starts with the panel closed");
  await t.ev("window.canvasCmd({cmd:'motionTimeline',id:'tl_card'})");
  await t.waitFor(isOpen, "the inspector command to open the timeline for a plain layer");
  await t.ev("window.canvasCmd({cmd:'motionTimeline',id:'tl_card'})");
  await t.waitFor("window.timelineHeights.at(-1) === 280", "the bridge to report that the panel is open");
  await t.io.key("t", { meta: true, alt: true });
  t.eq(await t.ev("window.timelineHeights.at(-1)"), 0, "the shortcut closes the same panel");
  await t.ev("window.canvasCmd({cmd:'motionTimeline'})");
  await t.waitFor(isOpen, "the View menu command to reopen the panel");
  await t.ev("window.canvasCmd({cmd:'insets',l:90,t:40,r:280,b:60})");

  const menu = ".mt-add-property select";
  t.eq(await t.ev("document.querySelector('.mt-group-label').textContent"), "Card", "the selected layer has a row");
  t.eq(await t.ev(`Array.from(document.querySelector(${JSON.stringify(menu)}).options, o => o.text)`),
    ["Add property", "Translate X", "Translate Y", "Scale", "Rotate", "Opacity"], "the row offers supported properties");
  t.eq(await t.ev("document.querySelectorAll('.mt-key').length"), 0, "no keyframes before adding a property");
  t.eq(await t.ev(`(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const row = rect(".mt-line[data-layer-id]"), label = rect(".mt-group-label"), add = rect(${JSON.stringify(menu)});
    return [(add.top - row.top), (row.bottom - add.bottom), (add.left - label.right), getComputedStyle(document.querySelector(${JSON.stringify(menu)})).lineHeight];
  })()`), [2, 2, 0, "11px"], "the menu is centered vertically, fits beside the layer name, and uses a 100% line height");
  const shot = process.env.QA_TIMELINE_EMPTY_SHOT;
  if (shot) {
    const clip = await t.ev<{ x: number; y: number; width: number; height: number }>(`(() => {
      const { x, y, width, height } = document.querySelector(${JSON.stringify(timelinePanel)}).getBoundingClientRect();
      return { x: x - 12, y: y - 12, width: width + 24, height: height + 12 };
    })()`);
    fs.writeFileSync(shot, await t.shot(clip));
  }

  const pick = (prop: string) => t.ev(`(() => {
    const select = document.querySelector(${JSON.stringify(menu)});
    if (select.disabled || select.querySelector('option[value=${prop}]').disabled) throw new Error("Property is unavailable");
    select.value = ${JSON.stringify(prop)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  const savedMotion = async () => (await t.a.get("/api/node?id=tl_card&depth=0")).node.motion;
  await pick("opacity");
  await t.waitFor(`document.querySelector('${timelineKey}')?.getAttribute('aria-label') === 'Opacity keyframe 2, 300 ms'`, "the added property's second keyframe to be selected");
  await t.flush();
  const first = await savedMotion();
  t.eq(first, [{ id: first?.[0]?.id, on: "boardHover", leave: "reverse", tracks: [
    { prop: "opacity", keys: [{ t: 0, v: 0.8 }, { t: 300, v: 0.5 }] },
  ] }], "the first property saves a hover animation with two keys");
  await pick("translateX");
  await t.waitFor(`document.querySelector('${timelineKey}')?.getAttribute('aria-label') === 'Translate X keyframe 2, 300 ms'`, "the second property's last keyframe to be selected");
  await t.flush();
  t.eq((await savedMotion())?.[0].tracks.length, 2, "a row with keyframes can add another property");
  await t.a.post("/api/history/undo");
  t.eq(await savedMotion(), first, "one Undo removes the added property");
  await t.a.post("/api/history/undo");
  t.eq(await savedMotion(), undefined, "one more Undo removes the first animation");
  await t.waitFor(`${isOpen} && !document.querySelector('.mt-key')`, "Undo to restore the empty panel");
  await t.clearSel();
});

sc("motion-timeline", "timeline follows board selection and respects side insets", {
  covers: ["motion-timeline:selection"], skip: { visual: "Asserts panel geometry and selection with real keyboard input." },
}, async (t: T) => {
  await openTimeline(t);
  await t.ev("window.canvasCmd({cmd:'insets',l:90,t:40,r:280,b:60})");
  t.eq(await t.ev(`(() => { const p = document.querySelector(${JSON.stringify(timelinePanel)}).getBoundingClientRect(); return [p.x, innerWidth-p.right, innerHeight-p.bottom, p.height]; })()`),
    [90, 280, 0, 280], "the panel clears both sidebars");
  t.eq(await t.ev("getComputedStyle(document.querySelector('.motion-timeline')).transitionDuration"), "0s", "reduced motion skips the slide");
  for (const id of ["tl_board", "tl_plain"]) {
    await t.select([id]);
    await t.waitFor(`document.querySelector(${JSON.stringify(timelinePanel)})`, "the selected layer's board timeline");
    t.eq(await t.ev("document.querySelector('.mt-group-label').textContent"), "Marker", "the board's animated layer is listed");
  }
  await t.io.key("t", { meta: true, alt: true });
  t.eq(await t.ev(`!!document.querySelector(${JSON.stringify(timelinePanel)})`), false, "the shortcut closes the timeline");
  await t.io.key("t", { meta: true, alt: true });
  await t.waitFor(`document.querySelector(${JSON.stringify(timelinePanel)})`, "the shortcut reopens the timeline");
  await t.clearSel();
  t.eq(await t.ev(`!!document.querySelector(${JSON.stringify(timelinePanel)})`), false, "deselecting closes the timeline");
});

sc("motion-timeline", "timeline key and segment drags each undo in one step", {
  covers: ["motion-timeline:drag"], skip: { visual: "Uses real pointer drags and reads the saved track after Undo." },
}, async (t: T) => {
  await openTimeline(t);
  const key = await timelinePoint(t, timelineKey);
  await t.io.drag(key.x, key.y, key.x + 54, key.y, { mods: { shift: true } });
  await waitTimelineTrack(t, "track.duration === 550 && !track.keys");
  await t.io.key("ArrowLeft");
  await waitTimelineTrack(t, "track.duration === 549");
  await t.a.post("/api/history/undo");
  await waitTimelineTrack(t, "track.duration === 550");
  await t.a.post("/api/history/undo");
  await waitTimelineTrack(t, "track.duration === 500 && !track.keys");
  await t.waitFor("document.querySelector('.mt-key[data-selected]')?.getAttribute('aria-label').includes('500 ms')", "the timeline to reflect Undo");
  const segment = await timelinePoint(t, ".mt-segment");
  await t.io.drag(segment.x, segment.y, segment.x + 36, segment.y, { mods: { shift: true } });
  await waitTimelineTrack(t, "track.delay === 40 && track.duration === 500");
  await t.a.post("/api/history/undo");
  await waitTimelineTrack(t, "track.delay === undefined && track.duration === 500");
});

sc("motion-timeline", "timeline scrubbing poses the cached sprite and holds it", {
  covers: ["motion-timeline:scrub"], skip: { visual: "Samples rendered canvas pixels at the scrubbed position." },
}, async (t: T) => {
  await openTimeline(t);
  const start = await timelinePoint(t, ".mt-head"), at = await timelinePoint(t, ".mt-key[data-selected]");
  await t.io.drag(start.x, start.y, (start.x + at.x) / 2, start.y);
  await t.waitFor("Number(document.querySelector('.mt-head').getAttribute('aria-valuenow')) > 245 && window.__motion.sprites === 1", "the middle pose to paint");
  const pixel = await t.ev<number[]>(`(() => {
    const h = window.canvasHost, ev = h.engineView, r = h.worldRectOf("tl_board"), cam = h.cam;
    const d = ev.canvas.width / ev.canvas.clientWidth;
    const sx = Math.floor(((r.x + 86) * cam.z + cam.x) * d);
    const sy = Math.floor(((r.y + 36) * cam.z + cam.y) * d);
    return [...ev.capture([{sx,sy,sw:1,sh:1,w:1,h:1}])[0].getContext("2d").getImageData(0,0,1,1).data];
  })()`);
  t.eq(pixel, [255, 128, 64, 255], "the moving marker is visible at 250 ms");
  const wakes = await t.ev("window.__motion.wakes");
  await sleep(120);
  t.eq(await t.ev("window.__motion.wakes"), wakes, "a scrubbed pose sleeps");
  await t.io.key("Space");
  await t.waitFor("Number(document.querySelector('.mt-head').getAttribute('aria-valuenow')) > 260", "Space to play");
  await t.io.key("Space");
  const paused = await t.ev("document.querySelector('.mt-head').getAttribute('aria-valuenow')");
  await sleep(80);
  t.eq(await t.ev("document.querySelector('.mt-head').getAttribute('aria-valuenow')"), paused, "Space pauses");
});

sc("motion-timeline", "timeline adds sampled keys and deletes down to two", {
  covers: ["motion-timeline:keys"], skip: { visual: "Exercises double-click, Delete and external edits." },
}, async (t: T) => {
  await openTimeline(t);
  const p = await timelinePoint(t, ".mt-segment", 0.4);
  await t.io.dblclick(p.x, p.y);
  await waitTimelineTrack(t, "track.keys?.length === 3 && track.keys[1].t === 200 && track.keys[1].v === 40 && track.duration === undefined");
  await t.io.key("Delete");
  await waitTimelineTrack(t, "track.keys?.length === 2");
  await t.io.key("Delete");
  await waitTimelineTrack(t, "track.keys?.length === 2");
  await t.a.post("/api/update", { file: t.file, id: "tl_marker", props: {
    motion: [{ ...timelineAnimation, tracks: [{ prop: "translateX", keys: [{ t: 0, v: 0 }, { t: 360, v: 72 }] }] }],
  } });
  await t.waitFor("document.querySelector('.mt-key[data-selected]')?.getAttribute('aria-label').includes('360 ms')", "an external edit to refresh the panel");
  const curve = await timelinePoint(t, ".mt-segmented button:nth-child(4)");
  await t.io.click(curve.x, curve.y);
  await waitTimelineTrack(t, "Array.isArray(track.keys?.[1]?.ease)");
  const handle = await timelinePoint(t, ".mt-handle");
  await t.io.drag(handle.x, handle.y, handle.x + 20, handle.y - 8);
  await waitTimelineTrack(t, "track.keys?.[1]?.ease?.[0] > 0.3 && track.keys[1].ease[1] > 0.1");
  await t.ev(`(() => {
    const field = document.querySelector(".mt-field input");
    field.focus(); field.select();
  })()`);
  await t.io.type("75");
  await t.io.key("Enter");
  await waitTimelineTrack(t, "track.keys?.[1]?.v === 75");
  const ruler = await timelinePoint(t, ".mt-ruler", 0.6);
  const left = await t.ev("document.querySelector('.mt-label').getBoundingClientRect().x");
  await t.page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ruler.x, y: ruler.y, deltaX: 0, deltaY: -400, modifiers: 4 });
  await t.waitFor("document.querySelector('.mt-tracks').scrollLeft > 0", "Cmd scroll to zoom and scroll the time axis");
  t.eq(await t.ev("document.querySelector('.mt-label').getBoundingClientRect().x"), left, "layer names stay fixed while time scrolls");
});

sc("motion-timeline", "timeline close releases the pose and adds no frames", {
  covers: ["motion-timeline:idle"], skip: { visual: "Measures inactive frame and request counters." },
}, async (t: T) => {
  await openTimeline(t);
  const at = await timelinePoint(t, ".mt-ruler", 0.25);
  await t.io.click(at.x, at.y);
  await t.waitFor("window.__motion.sprites === 1", "a held timeline pose");
  const close = await timelinePoint(t, ".mt-close");
  await t.io.click(close.x, close.y);
  await t.waitFor("!document.querySelector('.motion-timeline[data-open]') && window.__motion.sprites === 0", "the pose to restore on close");
  await t.settle();
  await t.ev(`(() => {
    const h = window.canvasHost, frame = h.requestFrame, fetch = window.fetch;
    let wakes = 0, reads = 0;
    h.requestFrame = () => { wakes++; frame(); };
    window.fetch = (...args) => { if (String(args[0]).includes("/api/motion-timeline")) reads++; return fetch(...args); };
    window.timelineIdle = () => [wakes, reads, window.__motion.evaluations];
  })()`);
  const idle = await t.ev("window.timelineIdle()");
  await t.a.post("/api/update", { file: t.file, id: "tl_marker", props: { motion: [{ ...timelineAnimation, leave: "hold" }] } });
  await sleep(150);
  t.eq(await t.ev("window.timelineIdle()"), idle, "closing removes the timeline's work");
  await t.select(["tl_plain"]);
  await t.waitFor("document.querySelector('.motion-timeline[data-open]')", "a new selection to clear dismissal");
});
