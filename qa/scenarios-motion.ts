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

sc("hover-motion", "the hover box follows board sprites through the leave animation", {
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
  await t.ev(`window.canvasCmd({cmd:"prefs",prefs:{playHoverMotion:false}})`);
  await t.frames();
  t.eq(await hoverBoxVisible(t), true, "turning off playback shows the hover box");
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

sc("hover-motion", "boards without playable sprites keep their hover boxes", {
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
  await moveToHoverTarget(t, "qa_skipped_layer");
  await t.waitFor(`window.__motion.skipped.some(s => s.id === "qa_skipped_layer" && s.reason === "overlaps later paint")`, "the motion track to be skipped");
  t.eq({ named, skipped: await hoverState(t) }, {
    named: { sprites: 0, outline: true }, skipped: { sprites: 0, outline: true },
  }, "a layer name and skipped motion both leave the hover box visible");
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
