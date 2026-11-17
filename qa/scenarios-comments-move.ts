// QA scenarios for moving a comment pin by dragging it, and for the add pin (the comment-mode cursor and the pin a
// click leaves while its comment is written) matching an existing pin. Real mouse; the anchor is read from
// comments.json on disk. Pictures: qa/out/comments-add-pin-{light,dark}.png.
import fs from "node:fs";
import path from "node:path";
import { decodePng } from "../fidelity/png.ts";
import { H, sc, W, type Rect, type T } from "./harness.ts";
import { ROOT, sleep } from "./lib.ts";

const OUT = path.join(ROOT, "qa", "out");
const file = (t: T): any | null => { try { return JSON.parse(fs.readFileSync(path.join(t.file, "comments.json"), "utf8")); } catch { return null; } };
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 80; i++) { if (ok()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
};
type Box = { x: number; y: number; w: number; h: number };
const pinOf = async (t: T, id: string): Promise<Box> => {
  const p = await t.ev<Box | null>(`(() => { const e = document.querySelector('.cm-pin[data-thread="${id}"]'); if (!e || e.style.display === "none") return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  if (!p) throw new Error("no pin for " + id);
  return p;
};
/** The tip of a pin (its bottom left corner), in window px: where the comment points. */
const tip = (p: Box) => ({ x: p.x, y: p.y + p.h });
const middle = (p: Box) => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 });
async function comment(t: T, x: number, y: number, text: string) {
  await t.io.click(x, y);
  await t.waitFor(`!!document.querySelector(".cm-comp:not([hidden]) textarea")`, "the composer");
  await t.waitFor(`document.activeElement === document.querySelector(".cm-comp textarea")`, "the composer focused");
  await t.io.type(text);
  await t.io.key("Enter");
}
const theme = (t: T, s: string) => t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: s }] });

sc("comments", "a pin moves by dragging: it is pinned again to the layer under its tip, saved, and still there after a reload", { covers: ["comments:move", "comments:follows-layer", "comments:reopen"] }, async (t: T) => {
  await t.focus("lay_nest");
  const r = await t.rect("r_free");
  await t.io.key("c");
  await comment(t, r.x + r.w / 2, r.y + r.h / 2, "Move me");
  await until(() => !!file(t)?.threads?.length, "the thread");
  const id = file(t).threads[0].id;
  await t.io.key("Escape");
  await t.io.key("Escape");
  t.eq(await t.ev("window.canvasHost.comments.mode"), false, "out of comment mode");
  // A press that travels less than the slop is a click: the thread opens and nothing moves.
  let p = await pinOf(t, id);
  let g = middle(p);
  await t.io.move(g.x, g.y);
  await t.io.down();
  await t.io.move(g.x + 3, g.y, 1, 1);
  await t.io.up();
  await t.waitFor(`!!document.querySelector(".cm-pop:not([hidden]) .cm-field")`, "a short press to open the thread");
  t.eq(file(t).threads[0].anchor.nodeId, "r_free", "a short press moves nothing");
  await t.io.key("Escape");
  // Drag the pin by its middle onto another layer: the tip lands where the pointer puts it, the layer under it lights up.
  const target = await t.rect("fr_outer");
  const drop = { x: target.x + target.w * 0.5, y: target.y + target.h * 0.5 };
  p = await pinOf(t, id);
  g = middle(p);
  const off = { x: g.x - tip(p).x, y: g.y - tip(p).y };
  let lit: Rect | null = null;
  let held: Box | null = null;
  await t.io.drag(g.x, g.y, drop.x + off.x, drop.y + off.y, { during: async () => {
    lit = await t.ev<Rect | null>(`(() => { const e = document.querySelector(".cm-hov"); if (!e || e.style.display !== "block") return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    held = await pinOf(t, id);
  } });
  t.ok(!!held, "the pin shows while it is dragged");
  if (held) { t.near(tip(held).x, drop.x, 1.5, "while dragging, the tip keeps its offset from the pointer, x"); t.near(tip(held).y, drop.y, 1.5, "y"); }
  t.ok(!!lit, "the layer under the tip lit up during the drag");
  if (lit) t.near((lit as Rect).w, target.w, 2, "the lit layer is the one under the tip");
  await until(() => file(t).threads[0].anchor.nodeId === "fr_outer", "the anchor saved on the new layer");
  const a = file(t).threads[0].anchor;
  t.near(a.x, 0.5, 0.02, "x as a fraction of the new layer");
  t.near(a.y, 0.5, 0.02, "y as a fraction of the new layer");
  t.eq(a.board, "lay_nest", "the anchor keeps its board");
  t.eq(a.preview.name, await t.ev<string>(`window.canvasHost.layerInfo("fr_outer").name`), "the new layer's name is kept for a deleted-layer card");
  t.eq(file(t).threads.length, 1, "the same thread, not a new one");
  t.eq(file(t).threads[0].comments[0].body, "Move me", "the comment came along");
  t.eq(await t.ev(`window.canvasHost.comments.open`), null, "a drag does not open the thread");
  // After a reload the pin is where it was dropped.
  await t.open();
  await t.focus("lay_nest");
  await t.waitFor(`!!document.querySelector('.cm-pin[data-thread="${id}"]')`, "the pin after a reload");
  await t.frames(3);
  const t2 = await t.rect("fr_outer");
  p = await pinOf(t, id);
  t.near(tip(p).x, t2.x + t2.w * 0.5, 1.5, "after a reload the tip is on the drop point, x");
  t.near(tip(p).y, t2.y + t2.h * 0.5, 1.5, "after a reload, y");
  // It stays put on its layer when the layer moves.
  await t.select(["fr_outer"]);
  for (let i = 0; i < 3; i++) await t.io.key("ArrowDown", { shift: true });
  await t.flush();
  await t.frames(3);
  const t3 = await t.rect("fr_outer");
  t.near(t3.y, t2.y + 30, 2, "the layer moved 30 px down");
  p = await pinOf(t, id);
  t.near(tip(p).y, t3.y + t3.h * 0.5, 1.5, "the pin went with its layer");
  await t.clearSel();
  // Esc during a drag puts the pin back; nothing is saved.
  const before = JSON.stringify(file(t).threads[0].anchor);
  g = middle(p);
  await t.io.drag(g.x, g.y, g.x + 80, g.y + 60, { during: async () => { await t.io.key("Escape"); } });
  await t.frames(3);
  await sleep(200);
  t.eq(JSON.stringify(file(t).threads[0].anchor), before, "Esc cancelled the drag");
  const back = await pinOf(t, id);
  t.near(back.x, p.x, 1, "the pin is back where it was");
  // Dropped on the empty canvas: a point on the page, like a comment made there.
  const b = await t.rect("lay_nest");
  const empty = { x: b.x + b.w + 60, y: b.y + 50 };
  p = await pinOf(t, id);
  g = middle(p);
  await t.io.drag(g.x, g.y, empty.x + (g.x - tip(p).x), empty.y + (g.y - tip(p).y));
  await until(() => file(t).threads[0].anchor.nodeId === undefined, "the anchor saved as a page point");
  const world = await t.ev<{ x: number; y: number }>(`(() => { const h = window.canvasHost, c = h.cam; return { x: (${empty.x} - h.viewBox.l - c.x) / c.z, y: (${empty.y} - h.viewBox.t - c.y) / c.z }; })()`);
  t.near(file(t).threads[0].anchor.x, world.x, 1.5, "the page point, x");
  t.near(file(t).threads[0].anchor.y, world.y, 1.5, "the page point, y");
  // Canvas undo does not touch comments: a move is not in it either.
  await t.undo();
  t.eq(file(t).threads[0].anchor.nodeId, undefined, "comments are not in undo");
});

sc("comments", "the add pin (the comment cursor and the pin a click leaves) is an existing pin's size, shape and shadow, light and dark", { covers: ["comments:add-pin", "comments:light", "comments:dark"] }, async (t: T) => {
  await t.focus("lay_nest");
  const r = await t.rect("r_free");
  await t.io.key("c");
  await comment(t, r.x + r.w / 2, r.y + r.h / 2, "An existing pin");
  await until(() => !!file(t)?.threads?.length, "the thread");
  const id = file(t).threads[0].id;
  // Another click leaves the add pin while its comment is written.
  await t.io.click(r.x + r.w / 2 + 50, r.y + r.h / 2 + 30);
  await t.waitFor(`!!document.querySelector('.cm-pin[data-thread="draft"].cm-add')`, "the add pin");
  const style = (sel: string) => t.ev<{ w: number; h: number; radius: string; shadow: string }>(`(() => { const e = document.querySelector('${sel}'), s = getComputedStyle(e), r = e.getBoundingClientRect(); return { w: r.width, h: r.height, radius: s.borderRadius, shadow: s.boxShadow }; })()`);
  const real = await style(`.cm-pin[data-thread="${id}"]`), add = await style(`.cm-pin[data-thread="draft"]`);
  t.eq([add.w, add.h], [real.w, real.h], "the add pin is an existing pin's size");
  t.eq(add.radius, real.radius, "the add pin has an existing pin's corners");
  t.eq(add.shadow, real.shadow, "the add pin has an existing pin's shadow");
  const K = 2, cell = 60, top = 24;
  for (const th of ["light", "dark"]) {
    await theme(t, th);
    await t.frames(2);
    // A strip on a flat background: an existing pin, the add pin a click leaves and the cursor's image, 60 pt apart,
    // each pin box at the same place in its cell. Once on the canvas colour (the picture), once on a mid grey where a
    // pin's edge and shadow stand out (the measurement).
    const strip = await t.ev<{ x: number; y: number; nat: number[]; nat2: number[] }>(`(async () => {
      document.getElementById("qa-addpin")?.remove();
      const layer = document.querySelector(".cm-layer"), ap = window.canvasHost.comments.addPin;
      const box = document.createElement("div"); box.id = "qa-addpin";
      box.style.cssText = "position:absolute;left:" + Math.round(layer.clientWidth / 2 - 90) + "px;top:" + Math.round(layer.clientHeight / 2 - 80) + "px;width:180px;height:160px;z-index:5";
      const imgs = [];
      const row = (bg, y0) => {
        const r = document.createElement("div"); r.style.cssText = "position:absolute;left:0;top:" + y0 + "px;width:180px;height:80px;background:" + bg; box.append(r);
        const pin = (src, i) => { const c = src.cloneNode(true); c.removeAttribute("data-thread"); c.style.display = ""; c.style.transform = "translate(" + (i * ${cell} + 16) + "px," + ${top} + "px)"; r.append(c); };
        pin(document.querySelector('.cm-pin[data-thread="${id}"]'), 0);
        pin(document.querySelector('.cm-pin[data-thread="draft"]'), 1);
        const img = new Image(); img.src = "data:image/svg+xml," + encodeURIComponent(ap.svg("${th}"));
        img.style.cssText = "position:absolute;left:" + (2 * ${cell} + 16 - ap.hot.x) + "px;top:" + (${top} + 28 - ap.hot.y) + "px";
        r.append(img); imgs.push(img);
      };
      row(getComputedStyle(document.body).getPropertyValue("--c-canvas-bg").trim() || getComputedStyle(document.getElementById("view")).backgroundColor, 0);
      row("#8a8a8a", 80);
      layer.append(box);
      for (const i of imgs) await i.decode();
      const two = new Image(); two.src = "data:image/svg+xml," + encodeURIComponent(ap.svg("${th}", 2)); await two.decode();
      const b = box.getBoundingClientRect();
      return { x: b.left, y: b.top, nat: [imgs[0].naturalWidth, imgs[0].naturalHeight], nat2: [two.naturalWidth, two.naturalHeight] };
    })()`);
    t.eq(strip.nat2, [strip.nat[0] * 2, strip.nat[1] * 2], `${th}: the Retina cursor is the same image at twice the pixels`);
    fs.mkdirSync(OUT, { recursive: true });
    await t.page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: K, mobile: false });
    await t.frames(3);
    const shot = await t.page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const full = Buffer.from(shot.data, "base64");
    const crop = await t.page.send("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: strip.x, y: strip.y, width: 180, height: 160, scale: 1 } });
    fs.writeFileSync(path.join(OUT, `comments-add-pin-${th}.png`), Buffer.from(crop.data, "base64"));
    await t.page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await t.frames(2);
    const img = decodePng(full);
    // Measured in device pixels. A pin's body is opaque: the pixels that are the same on both rows (any edge or
    // shadow pixel lets the background through, so it differs). Its edge and shadow are compared on the grey row.
    const px = (x: number, y: number) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
    const ox = Math.round(strip.x * K), oy = Math.round((strip.y + 80) * K);
    const cellBox = (i: number) => ({ x: ox + (i * cell + 4) * K, y: oy + 8 * K, w: 54 * K, h: 64 * K });
    const body = (i: number) => {
      const c = cellBox(i);
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) {
        const q = px(x, y), a = px(x, y - 80 * K);
        if (Math.abs(q[0] - a[0]) < 3 && Math.abs(q[1] - a[1]) < 3 && Math.abs(q[2] - a[2]) < 3) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      }
      return { x: x0 - c.x, y: y0 - c.y, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    /** Mean difference (0..255) from the existing pin, outside a 12 pt circle round the middle (the avatar or the plus). */
    const ring = (i: number) => {
      const a = cellBox(0), c = cellBox(i), mx = (16 - 4 + 14) * K, my = (top - 8 + 14) * K;
      let sum = 0, n = 0;
      for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
        if (Math.hypot(x - mx, y - my) < 12 * K) continue;
        const p = px(a.x + x, a.y + y), q = px(c.x + x, c.y + y);
        sum += (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) / 3; n++;
      }
      return sum / n;
    };
    const b0 = body(0), b1 = body(1), b2 = body(2);
    t.eq([b0.w, b0.h], [28 * K, 28 * K], `${th}: the existing pin's body is 28 pt`);
    t.eq([b1.x, b1.y, b1.w, b1.h], [b0.x, b0.y, b0.w, b0.h], `${th}: the add pin a click leaves covers the existing pin's box, to the device pixel`);
    t.near(b2.x, b0.x, 1, `${th}: the cursor's pin starts where an existing pin does, x (device px)`);
    t.near(b2.y, b0.y, 1, `${th}: the cursor's pin starts where an existing pin does, y: its hotspot is the tip`);
    t.near(b2.w, b0.w, 1, `${th}: the cursor's pin is an existing pin's width (device px)`);
    t.near(b2.h, b0.h, 1, `${th}: the cursor's pin is an existing pin's height (device px)`);
    const d1 = ring(1), d2 = ring(2);
    t.ok(d1 < 1, `${th}: the add pin's edge and shadow match an existing pin's (mean difference ${d1.toFixed(2)} of 255)`);
    t.ok(d2 < 3, `${th}: the cursor's edge and shadow match an existing pin's (mean difference ${d2.toFixed(2)} of 255)`);
  }
  await t.ev(`document.getElementById("qa-addpin")?.remove()`);
  await theme(t, "dark");
  await t.io.key("Escape");
  await t.io.key("Escape");
});
