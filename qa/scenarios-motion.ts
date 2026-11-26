import { sc, type T } from "./harness.ts";
import { sleep } from "./lib.ts";

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
  await t.io.move(point.x, point.y);
  await t.waitFor("window.__motion.poses >= 4", "sprites composited");
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
  await t.ev(`window.canvasCmd({cmd:"prefs",prefs:{playHoverMotion:false}})`);
  await t.io.move(point.x, point.y);
  await sleep(150);
  t.eq(await t.ev("window.__motion.sprites"), 0, "disabled hover adds no sprites");
});
