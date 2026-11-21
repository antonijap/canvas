// The QA scenarios. Each runs on its own fresh copy of demos/playground.canvas (see qa/run.ts).
// Coordinates in the playground are fixed (qa/playground.ts); layers are found by id.
import path from "node:path";
import { fixture, scratchCopy } from "../bench/fixtures/gen.ts";
import { decodePng } from "../fidelity/png.ts";
import { checkDragFrames, dragBoard, pageDriver } from "./frames.ts";
import { allIds, sc, T, type Rect } from "./harness.ts";
import fs from "node:fs";
import { ROOT, api, copyDir, openTab, sleep } from "./lib.ts";
import { PLAYGROUND } from "./playground.ts";
import "./scenarios-drops.ts";
import "./scenarios-keys.ts";
import "./scenarios-fills.ts";
import "./scenarios-icons.ts";
import "./scenarios-moving.ts";
import "./scenarios-paste.ts";
import "./scenarios-firstrun.ts";
import "./scenarios-review2.ts";
import "./scenarios-comments.ts";
import "./scenarios-comments-shared.ts";
import "./scenarios-comments-move.ts";
import "./scenarios-alignment.ts";
import { buildLink } from "../src/page/link-logic.js";

const pos = (n: any) => ({ x: n?.x, y: n?.y });

// ---------------------------------------------------------------- render

sc("render", "every page draws, nothing warns", { covers: ["render:rectangle","render:ellipse","render:frame","render:group","render:text","render:image","render:instance","render:board","render:component","render:card-todo","render:card-note","render:card-posthog","render:card-shader","render:card-video","render:rotated","render:nested","render:light","render:dark","render:tiny","fit:keyboard","fit:other-page","file-integrity:tiny"] }, async (t: T) => {
  for (const p of ["layout", "components", "style", "cards"]) {
    await t.showPage(p);
    await t.io.key("1", { shift: true });
    await t.settle();
    const missing = await t.ev<string[]>("[...window.canvasHost.boards.keys()].filter((id) => !window.canvasHost.worldRectOf(id))");
    t.eq(missing, [], `boards not drawn on ${p}`);
  }
  const ids = allIds(t.disk());
  t.eq(ids.length, new Set(ids).size, "ids are unique");
});

// ---------------------------------------------------------------- select

sc("select", "click picks the board child, double-click goes into the group", { covers: ["select-click:group","select-click:rectangle","select-click:nested","select-click:mouse"] }, async (t: T) => {
  await t.focus("lay_nest");
  const c = await t.center("r_g1");
  await t.io.click(c.x, c.y);
  await t.frames(3);
  t.eq(await t.sel(), ["g_pair"], "first click selects the group");
  await t.clearSel();
  await t.io.dblclick(c.x, c.y);
  await t.frames(3);
  t.eq(await t.sel(), ["r_g1"], "double-click selects the layer in the group");
  // Nested: a double-click on a layer in the inner group of a nested group goes one level per click.
  await t.clearSel();
  const n = await t.center("r_n1");
  await t.io.click(n.x, n.y);
  await t.frames(3);
  t.eq(await t.sel(), ["g_outer"], "click on a nested group's layer selects the outer group");
  await t.io.dblclick(n.x, n.y);
  await t.frames(3);
  t.eq(await t.sel(), ["g_inner"], "double-click goes one level in");
  await t.io.dblclick(n.x, n.y);
  await t.frames(3);
  t.eq(await t.sel(), ["r_n1"], "another double-click reaches the layer");
});

sc("select", "Cmd+click picks the deepest layer", { covers: ["select-deep:nested","select-deep:in-frame","select-deep:mouse"] }, async (t: T) => {
  await t.focus("lay_nest");
  const c = await t.center("r_inner");
  await t.io.click(c.x, c.y, { meta: true });
  await t.frames(3);
  t.eq(await t.sel(), ["r_inner"], "Cmd+click selects the leaf in frame in frame");
  const n = await t.center("r_n2");
  await t.io.click(n.x, n.y, { meta: true });
  await t.frames(3);
  t.eq(await t.sel(), ["r_n2"], "Cmd+click selects the leaf in nested groups");
});

sc("select", "Shift+click adds to the selection", { covers: ["select-add:many","select-add:mouse","select-click:frame"] }, async (t: T) => {
  await t.focus("lay_nest");
  const a = await t.center("r_free"), b = await t.center("fr_outer");
  await t.io.click(a.x, a.y);
  await t.io.click(b.x + 90, b.y + 70, { shift: true });
  await t.frames(3);
  t.eq((await t.sel()).sort(), ["fr_outer", "r_free"], "both selected");
});

// ---------------------------------------------------------------- move

async function dragBy(t: T, id: string, dx: number, dy: number, opts: Parameters<T["io"]["drag"]>[4] = {}) {
  const c = await t.center(id);
  await t.io.drag(c.x, c.y, c.x + dx, c.y + dy, opts);
  await t.frames(3);
}

sc("move", "drag moves a layer; undo and redo are one step each", { covers: ["move:rectangle","move:one","move:mouse","undo-redo:rectangle","undo-redo:keyboard"] }, async (t: T) => {
  await t.focus("lay_nest");
  // Cmd: no snapping, exact numbers. The write is timed against the latency budget.
  await t.measureWrites("drag a layer", () => dragBy(t, "r_free", 40, 30, { late: { meta: true } }));
  await t.flush();
  t.eq(pos(t.node("r_free")), { x: 340, y: 330 }, "moved on disk");
  t.eq(await t.sel(), ["r_free"], "the dragged layer is selected");
  await t.undo();
  t.eq(pos(t.node("r_free")), { x: 300, y: 300 }, "undo puts it back");
  await t.redo();
  t.eq(pos(t.node("r_free")), { x: 340, y: 330 }, "redo moves it again");
});

sc("move", "Shift locks the drag to one axis", { covers: ["move-axis-lock:one","move-axis-lock:mouse"] }, async (t: T) => {
  await t.focus("lay_nest");
  // Control: no snapping, so the move is exactly the pointer's.
  await dragBy(t, "r_free", 60, 14, { late: { shift: true, ctrl: true } });
  await t.flush();
  const n = t.node("r_free")!;
  t.eq(n.y, 300, "y unchanged");
  t.near(n.x, 360, 1, "x moved");
  await t.undo();
  t.eq(pos(t.node("r_free")), { x: 300, y: 300 }, "one undo");
});

sc("move", "drag into a frame and back out", { covers: ["move-reparent:one","move-reparent:in-frame","move-reparent:mouse","move:in-frame"] }, async (t: T) => {
  await t.focus("lay_nest");
  const f = await t.rect("fr_outer");
  const c = await t.center("r_free");
  // Into fr_outer's empty bottom-right part (not onto fr_inner).
  await t.io.drag(c.x, c.y, f.x + f.w - 40, f.y + f.h - 25, { late: { meta: true } });
  await t.flush();
  t.eq(t.parentOf("r_free"), "fr_outer", "parent after dropping into the frame");
  await t.undo();
  t.eq(t.parentOf("r_free"), "lay_nest", "undo takes it out again");
  t.eq(pos(t.node("r_free")), { x: 300, y: 300 }, "and puts it where it was");
  await t.redo();
  t.eq(t.parentOf("r_free"), "fr_outer", "redo");
  // Out of the frame onto empty board space.
  const c2 = await t.center("r_free");
  const b = await t.rect("lay_nest");
  await t.io.drag(c2.x, c2.y, b.x + 450, b.y + 360, { late: { meta: true } });
  await t.flush();
  t.eq(t.parentOf("r_free"), "lay_nest", "parent after dragging out");
});

sc("move", "cross-board selection: a short drag keeps each layer in its board", { covers: ["move:many","move:cross-board","undo-redo:many"] }, async (t: T) => {
  await t.showPage("layout");
  await t.look(-20, -20, 0.5);
  await t.select(["r_free", "rz_rect"]);
  const before = { a: t.node("r_free")!, b: t.node("rz_rect")! };
  await dragBy(t, "rz_rect", 15, 10, { late: { ctrl: true } }); // Control: no snapping
  await t.flush();
  t.eq(t.parentOf("r_free"), "lay_nest", "r_free stays in its board");
  t.eq(t.parentOf("rz_rect"), "lay_resize", "rz_rect stays in its board");
  const a = t.node("r_free")!, b = t.node("rz_rect")!;
  t.near(a.x - before.a.x, 30, 1, "r_free moved by the drag");
  t.near(b.x - before.b.x, 30, 1, "rz_rect moved by the drag");
  await t.undo();
  t.eq([pos(t.node("r_free")), pos(t.node("rz_rect"))], [pos(before.a), pos(before.b)], "one undo restores both");
});

sc("move", "Option-drag duplicates; one undo removes the copy", { covers: ["option-drag-duplicate:one","option-drag-duplicate:rectangle","option-drag-duplicate:mouse"] }, async (t: T) => {
  await t.focus("lay_nest");
  const n0 = allIds(t.disk()).length;
  await dragBy(t, "r_free", 100, 0, { mods: { alt: true }, late: { meta: true } });
  await t.flush();
  const doc = t.disk();
  t.eq(allIds(doc).length, n0 + 1, "one layer more");
  t.eq(pos(t.node("r_free", doc)), { x: 300, y: 300 }, "the original stays");
  const board = doc.children.find((b: any) => b.id === "lay_nest")!;
  const copy = board.children!.find((c: any) => c.id !== "r_free" && c.name === "Free rect");
  t.ok(copy, "a copy named like the original in the same board");
  t.eq(pos(copy), { x: 400, y: 300 }, "the copy is where it was dropped");
  t.eq(await t.sel(), [copy!.id], "the copy is selected");
  await t.undo();
  t.eq(allIds(t.disk()).length, n0, "one undo removes the copy");
  await t.redo();
  t.eq(allIds(t.disk()).length, n0 + 1, "redo brings the copy back");
});

sc("move", "an arrow pressed right after selecting still nudges", { covers: ["nudge:rectangle", "nudge:keyboard", "nudge:in-frame"] }, async (t: T) => {
  // The page asks the server how a selected layer moves (GET /api/move); the matrix lost nudges pressed before the
  // answer came. Hold that answer back, press, then let it through.
  await t.focus("lay_nest");
  const held: string[] = [];
  t.page.on("Fetch.requestPaused", (p) => held.push(p.requestId));
  await t.page.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/move?*", requestStage: "Request" }] });
  await t.select(["r_free"]);
  await t.waitFor(`true`, "a frame");
  await t.io.key("ArrowRight");
  await t.io.key("ArrowDown", { shift: true });
  await sleep(200);
  t.ok(held.length > 0, "the page asked how r_free moves");
  for (const id of held) await t.page.send("Fetch.continueRequest", { requestId: id });
  await t.page.send("Fetch.disable");
  await t.flush();
  t.eq(pos(t.node("r_free")), { x: 301, y: 310 }, "both presses landed");
});

sc("move", "a second drag while the first one's write is on its way", { covers: ["move:rectangle", "move:mouse"] }, async (t: T) => {
  // pnpm qa lost the second of two quick drags under load: both writes in flight at once can reach the server in
  // either order. Hold the drags' writes (POST /api/move) back while the second drag runs, then let them through.
  await t.focus("lay_nest");
  const held: string[] = [];
  // Lookups (GET) go through; writes (POST) wait.
  t.page.on("Fetch.requestPaused", (p) => { if (p.request.method === "GET") t.page.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {}); else held.push(p.requestId); });
  await t.page.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/move*", requestStage: "Request" }] });
  await dragBy(t, "r_free", 30, 0, { late: { meta: true } });
  await sleep(100);
  await dragBy(t, "r_free", 0, 30, { late: { meta: true } });
  await sleep(300);
  await t.page.send("Fetch.disable");
  for (const id of held) await t.page.send("Fetch.continueRequest", { requestId: id }).catch(() => {});
  await t.flush();
  t.eq(pos(t.node("r_free")), { x: 330, y: 330 }, "both drags landed");
});

sc("move", "two quick drags are two undo steps", { covers: ["undo-redo:rectangle","move:rectangle"] }, async (t: T) => {
  await t.focus("lay_nest");
  await dragBy(t, "r_free", 30, 0, { late: { meta: true } });
  await dragBy(t, "r_free", 0, 30, { late: { meta: true } });
  await t.flush();
  t.eq(pos(t.node("r_free")), { x: 330, y: 330 }, "both drags landed");
  await t.undo();
  t.eq(pos(t.node("r_free")), { x: 330, y: 300 }, "one undo takes back only the second drag");
});

sc("move", "reload: ids unique, nothing lost after edits", { covers: ["save-reopen:rectangle","save-reopen:group","file-integrity:tiny","move:group"] }, async (t: T) => {
  await t.focus("lay_nest");
  await dragBy(t, "r_free", 100, 0, { mods: { alt: true }, late: { meta: true } });
  await dragBy(t, "g_pair", 0, 120, { late: { meta: true } });
  await t.undo();
  await t.redo();
  await t.flush();
  const before = t.disk();
  const ids = allIds(before);
  t.eq(ids.length, new Set(ids).size, "ids unique before reload");
  await t.open();
  await t.showPage("layout");
  const after = t.disk();
  t.eq(allIds(after), ids, "the file is the same after the reload");
  const drawn = await t.ev<string[]>(`${JSON.stringify(ids.filter((i) => before.children.some((b: any) => b.id === "lay_nest" && JSON.stringify(b).includes('"' + i + '"'))))}.filter((id) => !window.canvasHost.worldRectOf(id))`);
  t.eq(drawn, [], "every layer of the edited board is drawn after the reload");
});

// ---------------------------------------------------------------- resize

const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Handle = (typeof HANDLES)[number];
const CURSORS: Record<Handle, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
const edges = (r: Rect) => ({ l: r.x, t: r.y, r: r.x + r.w, b: r.y + r.h });

/** Press on handle `h` of the selection box and drag it outward by d px; returns the drawn rect before and after. */
async function pullHandle(t: T, id: string, h: Handle, d = 30) {
  await t.select([id]);
  await t.frames(3);
  const box = await t.selBox();
  t.ok(box, `${id} has a selection box`);
  const px = h.includes("w") ? box.x : h.includes("e") ? box.x + box.w : box.x + box.w / 2;
  const py = h.includes("n") ? box.y : h.includes("s") ? box.y + box.h : box.y + box.h / 2;
  const dx = h.includes("w") ? -d : h.includes("e") ? d : 0, dy = h.includes("n") ? -d * 0.7 : h.includes("s") ? d * 0.7 : 0;
  const before = await t.rect(id);
  await t.io.move(px, py);
  await t.frames(2);
  const cursor = await t.ev<string>("window.canvasHost.view.style.cursor");
  await t.io.drag(px, py, px + dx, py + dy, { steps: 8 });
  await t.flush();
  await t.frames(3);
  const after = await t.rect(id);
  return { before, after, dx, dy, cursor };
}

/** Each of the 8 handles: edges move one side, corners two, the opposite sides stay; each resize undoes in one step. */
async function resizeEveryHandle(t: T, id: string, keepRatio = false) {
  const problems: string[] = [];
  for (const h of HANDLES) {
    const disk0 = JSON.stringify(t.node(id));
    const { before, after, cursor } = await pullHandle(t, id, h);
    if (cursor !== CURSORS[h]) problems.push(`${h}: cursor "${cursor}", want ${CURSORS[h]}`);
    const a = edges(before), b = edges(after);
    const moved = { l: Math.abs(b.l - a.l) > 4, r: Math.abs(b.r - a.r) > 4, t: Math.abs(b.t - a.t) > 4, b: Math.abs(b.b - a.b) > 4 };
    const want = { l: h.includes("w"), r: h.includes("e"), t: h.includes("n"), b: h.includes("s") };
    if (keepRatio) {
      const r0 = before.w / before.h, r1 = after.w / after.h;
      if (Math.abs(r1 / r0 - 1) > 0.04) problems.push(`${h}: ratio ${r0.toFixed(2)} -> ${r1.toFixed(2)}`);
      if (after.w <= before.w + 4) problems.push(`${h}: did not grow (${before.w.toFixed(0)} -> ${after.w.toFixed(0)})`);
      // The opposite side or corner stays put.
      const fixed = { l: want.r && !want.l, r: want.l && !want.r, t: want.b && !want.t, b: want.t && !want.b };
      for (const k of ["l", "r", "t", "b"] as const) if (fixed[k] && Math.abs(b[k] - a[k]) > 2) problems.push(`${h}: fixed side ${k} moved ${(b[k] - a[k]).toFixed(1)}`);
    } else {
      for (const k of ["l", "r", "t", "b"] as const) if (moved[k] !== want[k]) problems.push(`${h}: side ${k} ${moved[k] ? "moved" : "stayed"} (${a[k].toFixed(0)} -> ${b[k].toFixed(0)})`);
    }
    await t.undo();
    if (JSON.stringify(t.node(id)) !== disk0) problems.push(`${h}: one undo did not restore it`);
  }
  t.eq(problems, [], `${id} handles`);
}

sc("resize", "rectangle: 4 edges and 4 corners", { covers: ["resize:rectangle","resize:handle-n","resize:handle-s","resize:handle-e","resize:handle-w","resize:handle-ne","resize:handle-nw","resize:handle-se","resize:handle-sw","resize:mouse","undo-redo:rectangle"] }, async (t: T) => { await t.focus("lay_resize"); await resizeEveryHandle(t, "rz_rect"); });
sc("resize", "frame: 4 edges and 4 corners", { covers: ["resize:frame","undo-redo:frame"] }, async (t: T) => { await t.focus("lay_resize"); await resizeEveryHandle(t, "rz_frame"); });
sc("resize", "text: 4 edges and 4 corners", { covers: ["resize:text","undo-redo:text"] }, async (t: T) => { await t.focus("lay_resize"); await resizeEveryHandle(t, "rz_text"); });
sc("resize", "ellipse: 4 edges and 4 corners", { covers: ["resize:ellipse","undo-redo:ellipse"] }, async (t: T) => { await t.focus("lay_resize"); await resizeEveryHandle(t, "rz_ell"); });
sc("resize", "image: 4 edges and 4 corners", { covers: ["resize:image","undo-redo:image"] }, async (t: T) => { await t.focus("lay_resize"); await resizeEveryHandle(t, "rz_img"); });
sc("resize", "instance: 4 edges and 4 corners", { covers: ["resize:instance","undo-redo:instance"] }, async (t: T) => { await t.focus("lay_resize"); await resizeEveryHandle(t, "rz_inst"); });
sc("resize", "text: a side edge makes auto width fixed size and keeps auto height, a bottom edge fixed size", { covers: ["resize-text-growth:text","resize-text-growth:mouse"] }, async (t: T) => {
  await t.focus("lay_text");
  const h0 = (await t.rect("tx_auto")).h;
  await pullHandle(t, "tx_auto", "e");
  await t.flush();
  t.eq(t.node("tx_auto")!.textGrowth, "fixed-width-height", "east edge on auto width text");
  t.near((await t.rect("tx_auto")).h, h0, 0.5, "it keeps the height it had");
  await pullHandle(t, "tx_height", "e");
  await t.flush();
  t.eq(t.node("tx_height")!.textGrowth, "fixed-width", "east edge on auto height text keeps auto height");
  await pullHandle(t, "tx_height", "s");
  await t.flush();
  t.eq(t.node("tx_height")!.textGrowth, "fixed-width-height", "south edge");
});
sc("resize", "rotated layer: edges follow its own axes, cursors turn", { covers: ["resize:rotated"] }, async (t: T) => {
  await t.focus("lay_resize");
  await t.select(["rz_rot"]);
  await t.frames(3);
  const n = t.node("rz_rot")!;
  const r = await t.rect("rz_rot");
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 }, a = (-n.rotation * Math.PI) / 180; // a positive rotation turns counter-clockwise on screen
  const along = (lx: number, ly: number) => ({ x: c.x + lx * Math.cos(a) - ly * Math.sin(a), y: c.y + lx * Math.sin(a) + ly * Math.cos(a) });
  const e = along(n.width / 2, 0);
  await t.io.move(e.x - 20, e.y);
  await sleep(400);
  await t.io.move(e.x, e.y);
  await t.frames(2);
  const cur = await t.ev<string>("window.canvasHost.view.style.cursor");
  t.eq(cur, "nesw-resize", "the east edge of a layer turned 30 degrees shows a turned cursor");
  const d = 30, to = { x: e.x + d * Math.cos(a), y: e.y + d * Math.sin(a) };
  await t.io.drag(e.x, e.y, to.x, to.y, { steps: 8 });
  await t.flush();
  const n1 = t.node("rz_rot")!;
  t.near(n1.width, n.width + d, 2, "width grows along its own axis");
  t.near(n1.height, n.height, 1, "height stays");
  await t.undo();
});
sc("resize", "layer edges: a click inside a small layer still selects and moves it", { covers: ["move:rectangle","select-click:rectangle"] }, async (t: T) => {
  await t.focus("lay_resize");
  const r = await t.rect("rz_rect");
  await t.select(["rz_rect"]);
  const x0 = r.x + r.w / 2, y0 = r.y + r.h / 2;
  await t.io.drag(x0, y0, x0 + 40, y0 + 20, { steps: 8 });
  await t.flush();
  const n = t.node("rz_rect")!;
  t.eq([n.width, n.height], [100, 80], "size unchanged by a middle drag");
  t.eq([n.x, n.y], [100, 90], "moved");
  await t.undo();
});
sc("resize", "a layer shown again with Shift+Cmd+H resizes from its handles at once", { covers: ["hide-show:rectangle","hide-show:keyboard","hide-show:hidden","resize:rectangle","resize:handle-e","resize:mouse"] }, async (t: T) => {
  // Hide a selected layer, show it again, and its box has working handles straight away (no click needed).
  await t.focus("lay_resize");
  await t.select(["rz_rect"]);
  await t.frames(3);
  for (const want of [false, true]) {
    await t.io.key("h", { meta: true, shift: true });
    await t.waitHistory();
    await t.frames(3);
    t.eq(t.node("rz_rect")!.enabled !== false, want, want ? "Shift+Cmd+H shows it again" : "Shift+Cmd+H hides it");
  }
  t.eq(await t.sel(), ["rz_rect"], "still selected");
  const box = await t.selBox();
  t.ok(box, "the shown layer has its selection box");
  const px = box!.x + box!.w, py = box!.y + box!.h / 2, before = await t.rect("rz_rect");
  await t.io.move(px - 6, py);
  await t.io.move(px, py);
  await t.frames(2);
  t.eq(await t.ev<string>("window.canvasHost.view.style.cursor"), "ew-resize", "the east handle shows the resize cursor");
  await t.io.drag(px, py, px + 30, py, { steps: 8 });
  await t.flush();
  await t.frames(3);
  const a = edges(before), b = edges(await t.rect("rz_rect"));
  t.ok(Math.abs(b.l - a.l) < 1 && b.r - a.r > 20, `the east handle resized it, the west side stayed (${JSON.stringify(a)} -> ${JSON.stringify(b)})`);
  await t.undo();
});
sc("resize", "group: 4 edges and 4 corners", { covers: ["resize:group","undo-redo:group"] }, async (t: T) => { await t.focus("lay_resize"); await resizeEveryHandle(t, "rz_group"); });
sc("resize", "group holding a 45 degree layer keeps its ratio", { covers: ["resize:group","resize:rotated","group-box:rotated"] }, async (t: T) => { await t.focus("lay_resize"); await resizeEveryHandle(t, "rz_grot", true); });
sc("resize", "Lock aspect ratio: every handle keeps the ratio; Control frees one drag", { covers: ["aspect-lock:rectangle","aspect-lock:frame","aspect-lock:mouse"] }, async (t: T) => {
  await t.focus("lay_resize");
  for (const id of ["rz_rect", "rz_frame"]) await t.a.post("/api/update", { file: t.file, id, props: { metadata: { type: "canvas", canvasLockAspect: true } } });
  await t.flush();
  await resizeEveryHandle(t, "rz_rect", true);
  await resizeEveryHandle(t, "rz_frame", true);
  // Control held once the drag has started: this drag changes the width only.
  await t.select(["rz_rect"]);
  await t.frames(3);
  const box = (await t.selBox())!;
  const x = box.x + box.w, y = box.y + box.h / 2;
  // Evidence: a locked corner drag mid-way, the ratio held (docs/evidence/components-inspector.md).
  {
    const sw = { x: box.x + box.w, y: box.y + box.h };
    await t.io.drag(sw.x, sw.y, sw.x + 60, sw.y + 10, { steps: 8, during: async () => {
      fs.mkdirSync(path.join(ROOT, "qa", "out"), { recursive: true });
      fs.writeFileSync(path.join(ROOT, "qa", "out", "aspect-lock-mid-drag.png"), await t.shot());
    } });
    await t.flush();
    const m = t.node("rz_rect")!;
    t.near((m.width as number) / (m.height as number), 100 / 80, 0.03, "the locked corner drag kept 5:4");
    await t.undo();
    await t.frames(3);
  }
  await t.io.drag(x, y, x + 40, y, { steps: 8, late: { ctrl: true } });
  await t.flush();
  const n = t.node("rz_rect")!;
  t.ok((n.width as number) > 110 && n.height === 80, `Control frees the drag, width only: ${n.width}x${n.height}`);
});
sc("properties", "Cmd+Option+Up/Down turn the selection 1 degree, one undo step", { covers: ["rotate-keys:rectangle","rotate-keys:many","rotate-keys:keyboard"] }, async (t: T) => {
  await t.focus("lay_resize");
  await t.select(["rz_rect", "rz_rot"]);
  await t.frames(2);
  await t.io.key("ArrowUp", { meta: true, alt: true });
  await t.flush();
  t.eq([t.node("rz_rect")!.rotation, t.node("rz_rot")!.rotation], [1, 31], "Up adds a degree to each");
  await t.io.key("ArrowDown", { meta: true, alt: true });
  await t.io.key("ArrowDown", { meta: true, alt: true });
  await t.flush();
  t.eq([t.node("rz_rect")!.rotation, t.node("rz_rot")!.rotation], [-1, 29], "Down takes one away");
  for (let i = 0; i < 14; i++) await t.io.key("ArrowUp", { meta: true, alt: true });
  await t.flush();
  t.eq([t.node("rz_rect")!.rotation, t.node("rz_rot")!.rotation], [13, 43], "14 more presses, 14 more degrees");
  // Evidence: both layers turned on the canvas (docs/evidence/components-inspector.md).
  fs.mkdirSync(path.join(ROOT, "qa", "out"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "qa", "out", "rotate-keys-mid.png"), await t.shot());
  for (let i = 0; i < 14; i++) await t.undo();
  await t.undo();
  t.eq([t.node("rz_rect")!.rotation, t.node("rz_rot")!.rotation], [0, 30], "one undo step per press");
});

sc("resize", "a group's box covers its rotated child", { covers: ["group-box:group","group-box:rotated"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["g_rot"]);
  const box = (await t.selBox())!;
  t.ok(box, "group selected");
  // The child's drawn corners: a 60 x 60 square turned 45 degrees spans 84.85 px each way.
  const kid = await t.rect("r_rot45");
  t.near(kid.w, 84.85, 2, "the child's drawn width");
  const inside = box.x <= kid.x + 1.5 && box.y <= kid.y + 1.5 && box.x + box.w >= kid.x + kid.w - 1.5 && box.y + box.h >= kid.y + kid.h - 1.5;
  t.ok(inside, `selection box ${JSON.stringify(box)} covers the rotated child ${JSON.stringify(kid)}`);
  t.near(box.w, kid.w, 3, "and is not bigger than it");
});

sc("resize", "rotate a group twice", { covers: ["rotate:group","rotate:mouse"] }, async (t: T) => {
  await t.focus("lay_nest");
  const kids0 = JSON.stringify(t.node("g_pair")!.children);
  const turn = async () => {
    await t.select(["g_pair"]);
    // Right after selecting a just-turned group its box can sit about 100 px off for a moment (docs/qa-plan.md): turn from
    // the box once it holds still.
    await t.settle();
    const box = (await t.waitFor<{ x: number; y: number; w: number; h: number }>(`(async () => { const r = () => document.getElementById("sel").getBoundingClientRect().toJSON(); const a = r(); await new Promise((f) => setTimeout(f, 120)); const b = r(); return a.x === b.x && a.y === b.y && a.width === b.width ? { x: b.x, y: b.y, w: b.width, h: b.height } : null; })()`, "the selection box to hold still"))!;
    const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const p0 = { x: box.x + box.w + 9, y: box.y + box.h + 9 };
    // A quarter turn about the centre, in steps along the arc.
    const r = Math.hypot(p0.x - c.x, p0.y - c.y), a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
    await t.io.move(p0.x, p0.y);
    await t.io.down();
    for (let k = 1; k <= 12; k++) { const a = a0 + (Math.PI / 2) * (k / 12); await t.io.move(c.x + r * Math.cos(a), c.y + r * Math.sin(a), 1, 1); }
    await t.io.up();
    await t.flush();
    return c;
  };
  const c0 = await turn();
  const r1 = Number(t.node("g_pair")!.rotation);
  t.near(Math.abs(r1), 90, 3, "first turn: about 90 degrees");
  const c1 = await turn();
  const r2 = Number(t.node("g_pair")!.rotation);
  t.near(Math.abs(((r2 % 360) + 360) % 360 - 180), 0, 4, `second turn adds 90 more (rotation ${r2})`);
  t.near(c1.x, c0.x, 3, "it turns about its centre (x)");
  t.near(c1.y, c0.y, 3, "it turns about its centre (y)");
  t.eq(JSON.stringify(t.node("g_pair")!.children), kids0, "its layers are untouched");
  await t.undo();
  t.near(Number(t.node("g_pair")!.rotation), r1, 0.01, "undo takes back the second turn only");
});

// ---------------------------------------------------------------- auto layout

sc("autolayout", "drag a row child to the end reorders the flow", { covers: ["autolayout-reorder:in-autolayout","autolayout-reorder:mouse"] }, async (t: T) => {
  await t.focus("lay_auto");
  const kids = () => t.node("al_row")!.children!.map((c: any) => c.id);
  t.eq(kids(), ["al_a", "al_b", "al_c"], "starting order");
  const a = await t.center("al_a"), c = await t.rect("al_c");
  await t.io.click(a.x, a.y, { meta: true }); // select the child itself
  await t.io.drag(a.x, a.y, c.x + c.w - 6, c.y + c.h / 2, { steps: 14 });
  await t.flush();
  t.eq(kids(), ["al_b", "al_c", "al_a"], "al_a moved to the end");
  t.eq(t.parentOf("al_a"), "al_row", "still in the row");
  await t.undo();
  t.eq(kids(), ["al_a", "al_b", "al_c"], "one undo restores the order");
});

sc("autolayout", "Shift+A adds auto layout, Option+Shift+A removes it", { covers: ["autolayout-toggle:frame","autolayout-toggle:keyboard"] }, async (t: T) => {
  await t.focus("lay_auto");
  await t.select(["fr_plain"]);
  await t.io.key("A", { shift: true });
  await t.waitHistory();
  const on = t.node("fr_plain")!;
  t.ok(on.layout === "horizontal" || on.layout === "vertical" || on.layout === undefined, `layout after Shift+A: ${on.layout}`);
  t.ok(on.layout !== "none", "fr_plain has auto layout");
  t.eq(t.parentOf("fp_a"), "fr_plain", "its layers stay in it");
  await t.select(["fr_plain"]);
  await t.io.key("A", { shift: true, alt: true });
  await t.waitHistory();
  t.eq(t.node("fr_plain")!.layout, "none", "Option+Shift+A removes it");
  await t.undo();
  t.ok(t.node("fr_plain")!.layout !== "none", "undo brings it back");
  await t.undo();
  t.eq(t.node("fr_plain")!.layout, "none", "a second undo removes it again");
});

// Frame by frame: the maintainer saw the whole auto layout frame glitch while a drag ran (the end state was right).
// Each drag records every frame the engine draws (qa/frames.ts): nothing outside the frames the drag changes may
// change, and their other children show only where they were or where they land. Both on a GPU with time to spare
// and on a busy one (one tile render a frame, what the engine plans under load and on a 120 Hz display).

const FRAMES_OUT = path.join(ROOT, "qa", "out", "frames");

sc("autolayout", "every frame of a drag in nested auto layout draws only the frame and the layer at the pointer", { covers: ["autolayout-reorder:in-autolayout", "autolayout-reorder:nested", "autolayout-reorder:image", "autolayout-reorder:into-autolayout", "autolayout-reorder:mouse"] }, async (t: T) => {
  await t.showPage("style");
  // On the Style page: a board added on the first page is listed on no page (src/structure.ts keepOnPage).
  await t.a.post("/api/structure", { file: t.file, op: "add", nodes: [dragBoard()], place: { parent: null }, page: "style" });
  await t.waitFor("!!window.canvasHost.boards.get('qa_drag')", "the drag board");
  await t.focus("qa_drag");
  await t.settle();
  const ev = path.join(FRAMES_OUT, "nested");
  const problems: string[] = [];
  // 1. A row to a later slot in its column.
  let r2 = await t.rect("qd_r2");
  let res = await checkDragFrames(pageDriver(t), { id: "qd_r0", to: { x: r2.x + r2.w / 2, y: r2.y + r2.h - 4 }, areas: ["qd_list"], kids: ["qd_r1", "qd_r2", "qd_r3"], evidence: ev });
  problems.push(...res.problems);
  t.note(`row drag: ${res.frames} frames, p50 / p95 ${res.gapP50.toFixed(1)} / ${res.gapP95.toFixed(1)} ms apart while dragging`);
  // 2. Inside a row (auto layout in auto layout): its avatar to the end, on a busy GPU.
  const chip = await t.rect("qd_r2c");
  res = await checkDragFrames(pageDriver(t), { id: "qd_r2a", to: { x: chip.x + chip.w - 3, y: chip.y + chip.h / 2 }, areas: ["qd_r2"], kids: ["qd_r2t", "qd_r2c"], busy: true, evidence: ev });
  problems.push(...res.problems);
  // 3. Out of its row into the tray, between its first two layers, on a busy GPU.
  const t1 = await t.rect("qd_t1");
  res = await checkDragFrames(pageDriver(t), { id: "qd_r3c", to: { x: t1.x + 6, y: t1.y + t1.h / 2 }, areas: ["qd_r3", "qd_tray"], kids: ["qd_r3a", "qd_r3t", "qd_t0", "qd_t1", "qd_t2"], busy: true, evidence: ev });
  problems.push(...res.problems);
  await t.flush();
  t.eq(t.node("qd_list")!.children!.map((c: any) => c.id), ["qd_r1", "qd_r2", "qd_r0", "qd_r3"], "the rows after the first drag");
  t.eq(t.node("qd_r2")!.children!.map((c: any) => c.id), ["qd_r2t", "qd_r2c", "qd_r2a"], "the row after the second drag");
  t.eq(t.node("qd_tray")!.children!.map((c: any) => c.id), ["qd_t0", "qd_r3c", "qd_t1", "qd_t2"], "the tray after the third drag");
  t.ok(!problems.length, problems.join("\n  "));
});

sc("autolayout", "every frame of a drag in auto layout on a 200-board file is clean", { covers: ["autolayout-reorder:large", "autolayout-reorder:nested", "autolayout-reorder:image"] }, async (t: T) => {
  // bench/fixtures/gen.ts: board b0 is a list board, a vertical auto layout of rows that are horizontal auto
  // layouts (an image avatar, two texts, a chip instance). Its tiles are many and its edits repaint in part.
  const f = scratchCopy(fixture(200), path.dirname(t.file), "Stress.canvas");
  const big = new T(t.page, f.dir, t.srv);
  await big.open();
  await big.focus("b0");
  const ev = path.join(FRAMES_OUT, "large");
  const problems: string[] = [];
  const r6 = await big.rect("b0-r6");
  let res = await checkDragFrames(pageDriver(big), { id: "b0-r2", to: { x: r6.x + r6.w / 2, y: r6.y + r6.h / 2 + 4 }, areas: ["b0"], kids: ["b0-r1", "b0-r3", "b0-r4", "b0-r5", "b0-r6", "b0-r7"], evidence: ev });
  problems.push(...res.problems);
  big.note(`row drag on the 200-board file: ${res.frames} frames, p50 / p95 ${res.gapP50.toFixed(1)} / ${res.gapP95.toFixed(1)} ms apart while dragging`);
  const chip = await big.rect("b0-r4chip");
  res = await checkDragFrames(pageDriver(big), { id: "b0-r4a", to: { x: chip.x + chip.w - 3, y: chip.y + chip.h / 2 }, areas: ["b0-r4"], kids: ["b0-r4c", "b0-r4chip"], busy: true, evidence: ev });
  problems.push(...res.problems);
  t.notes.push(...big.notes);
  // Back to the playground: the shared checks look at it.
  await t.open();
  t.ok(!problems.length, problems.join("\n  "));
});

// ---------------------------------------------------------------- components

sc("components", "instance text and fill overrides, then reset", { covers: ["instance-overrides:instance","instance-overrides:text","instance-overrides:in-instance","reset-overrides:instance","text-edit:in-instance","text-edit:keyboard"] }, async (t: T) => {
  await t.focus("cmp_inst");
  const lbl = await t.center("inst_plain/cmp_button_label");
  // The double-click that reaches a text selects it; the next one edits (the maintainer's rule).
  await t.io.dblclick(lbl.x, lbl.y);
  await t.io.dblclick(lbl.x, lbl.y);
  await t.waitFor("!!(window.canvasHost.textEdit && window.canvasHost.textEdit.active)", "text editing to start");
  await t.io.key("a", { meta: true });
  await t.io.type("Overridden");
  await t.io.key("Escape");
  await t.flush();
  const inst = () => t.node("inst_plain")!;
  t.eq(inst().descendants?.cmp_button_label?.content, "Overridden", "the text is an override on the instance");
  t.eq(t.node("cmp_button_label")!.content, "Button", "the main component keeps its text");
  // A fill override, the way the inspector writes one.
  await t.a.post("/api/update", { file: t.file, id: "inst_plain", props: { fill: "#16A34A" } });
  await t.flush();
  t.eq(inst().fill, "#16A34A", "fill override stored on the instance");
  await t.select(["inst_plain"]);
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "resetOverrides", id: "inst_plain" })`);
  await t.waitHistory();
  t.eq(inst().fill, undefined, "reset removes the fill override");
  t.eq(inst().descendants?.cmp_button_label?.content, undefined, "reset removes the text override");
  await t.undo();
  t.eq(inst().fill, "#16A34A", "undo of the reset brings the overrides back");
});

// ---------------------------------------------------------------- labels

sc("labels", "only boards carry a name label", { covers: ["board-labels:board","board-labels:instance","board-labels:text","board-labels:many"] }, async (t: T) => {
  await t.showPage("layout");
  await t.look(-40, -40, 0.5);
  const shown = (await t.ev<{ id: string }[]>("window.__canvas.labelRects()")).map((r) => r.id).sort();
  t.eq(shown, ["lay_auto", "lay_clip", "lay_nest", "lay_resize", "lay_text", "lay_xform"], "labels shown");
  const texts = await t.ev<string[]>(`[...document.querySelectorAll("#labels > *")].filter((e) => getComputedStyle(e).display !== "none").map((e) => e.textContent)`);
  t.ok(!texts.some((x) => /Top-level/.test(x)), `no label for the top-level instance or text (${texts.join(", ")})`);
});

// ---------------------------------------------------------------- cards

async function card(t: T, kind: string, name?: string) {
  const w = t.widgets().widgets.find((x: any) => x.kind === kind && (!name || x.name === name));
  t.ok(w, `a ${kind} card`);
  const r = await t.ev<Rect | null>(`(() => { const e = document.querySelector('.wd[data-id="widget:${w.id}"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  t.ok(r, `card ${w.id} is on the page`);
  return { w, r, id: "widget:" + w.id };
}
/** The Cards page with one card near the view's top left at 100% (all cards when none is named). */
async function cards(t: T, kind = "todo", name?: string) {
  await t.showPage("cards");
  const w = t.widgets().widgets.find((x: any) => x.kind === kind && (!name || x.name === name));
  t.ok(w, `a ${kind} card`);
  t.subject = ["widget:" + w.id];
  await t.look(w.x - 20, w.y - 40, 1, 40);
  await t.waitFor(`!!document.querySelector('.wd[data-id="widget:${w.id}"] .wd-body > *')`, "the card to mount");
  await t.frames(4);
}

sc("cards", "a press on a card's body drags it at once", { covers: ["card-move:card-posthog","card-move:mouse","move:card-posthog","undo-redo:card-posthog"] }, async (t: T) => {
  await cards(t, "posthog");
  const { w, r, id } = await card(t, "posthog");
  const x0 = r.x + r.w / 2, y0 = r.y + r.h - 30;
  let mid = null as Rect | null;
  await t.io.drag(x0, y0, x0 + 60, y0 + 40, { late: { meta: true }, during: async () => { mid = (await card(t, "posthog")).r; } });
  const m = mid as Rect | null;
  t.ok(m && Math.abs(m.x - r.x - 60) < 3 && Math.abs(m.y - r.y - 40) < 3, `the card follows the pointer during the drag (${JSON.stringify(mid)} vs ${JSON.stringify(r)})`);
  await t.flush();
  const w1 = t.widget("posthog");
  t.eq({ x: w1.x - w.x, y: w1.y - w.y }, { x: 60, y: 40 }, "moved on disk");
  t.eq(await t.sel(), [id], "and selected");
  await t.undo();
  t.eq({ x: t.widget("posthog").x, y: t.widget("posthog").y }, { x: w.x, y: w.y }, "one undo");
});

/** Pixels that differ between two PNGs of the same size (any channel off by more than 8). */
function pixelDiff(a: Buffer, b: Buffer) {
  const A = decodePng(a), B = decodePng(b);
  if (A.width !== B.width || A.height !== B.height) return Infinity;
  let n = 0;
  for (let i = 0; i < A.data.length; i += 4) if (Math.abs(A.data[i] - B.data[i]) > 8 || Math.abs(A.data[i + 1] - B.data[i + 1]) > 8 || Math.abs(A.data[i + 2] - B.data[i + 2]) > 8) n++;
  return n;
}

sc("cards", "a PostHog card shows its state again after another page", { covers: ["charts:card-posthog", "charts:empty", "pages:other-page"] }, async (t: T) => {
  // The matrix's random sequences ended with an unconfigured PostHog card saying Loading for good: leaving the page
  // dropped its reading, and an unchanged reading is never sent again.
  await cards(t, "posthog");
  const status = () => t.ev<string>(`(() => { const e = [...document.querySelectorAll(".wd")].find((x) => x.getAttribute("aria-label") === "PostHog (not set up)"); return e ? e.textContent : ""; })()`);
  await t.waitFor(`!/Loading/.test(${JSON.stringify("")} + [...document.querySelectorAll(".wd")].map((e) => e.textContent).join(" "))`, "the card's first answer", 15000);
  const before = await status();
  await t.showPage("layout");
  await sleep(500);
  await cards(t, "posthog");
  await sleep(3000);
  t.eq((await status()).includes("Loading"), false, `the card shows its state, not Loading (${JSON.stringify((await status()).slice(0, 80))}, was ${JSON.stringify(before.slice(0, 80))})`);
});

// The maintainer, 2026-11-16: a selected card shows a calm 1.5 px blue outline just outside its border, around its
// 12 px corners; no handles, no size badge; the card itself does not change. Light and dark.
for (const [theme, z] of [["light", 1], ["dark", 0.5]] as const) {
  const kinds = theme === "light" ? ["todo", "note", "posthog", "video"] : ["shader", "todo", "note"];
  sc("cards", `a selected card shows a blue outline, ${theme} theme`, { covers: [...kinds.map((k) => `card-select:card-${k}`), `card-select:${theme}`] }, async (t: T) => {
    await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
    for (const kind of kinds) {
      await cards(t, kind);
      if (z !== 1) { const w = t.widgets().widgets.find((x: any) => x.kind === kind); await t.look(w.x - 20, w.y - 40, z, 40); }
      await t.clearSel();
      const { r, id } = await card(t, kind);
      const clip = { x: Math.floor(r.x - 8), y: Math.floor(r.y - 8), width: Math.ceil(r.w + 16), height: Math.ceil(r.h + 16) };
      await t.io.move(r.x + r.w + 300, r.y + r.h + 200);
      await sleep(300);
      const before = await t.shot(clip);
      await t.select([id]);
      await sleep(200);
      t.eq(await t.sel(), [id], "the card is selected");
      const sel = await t.ev<any>(`(() => { const e = document.getElementById("sel"), s = getComputedStyle(e), b = e.getBoundingClientRect(); const hs = [...e.querySelectorAll("i")].map((i) => { const c = getComputedStyle(i); return c.backgroundColor + "|" + c.borderTopWidth; }); const probe = document.createElement("div"); probe.style.color = "var(--c-sel)"; document.body.append(probe); const blue = getComputedStyle(probe).color; probe.remove(); return { outline: s.outlineWidth + " " + s.outlineStyle, want: Math.max(1, Math.floor(1.5 * devicePixelRatio)) / devicePixelRatio + "px solid", color: s.outlineColor, blue, radius: parseFloat(s.borderTopLeftRadius), z: window.canvasHost.cam.z, dim: getComputedStyle(document.getElementById("seldim")).display, box: { x: b.left, y: b.top, w: b.width, h: b.height }, hs }; })()`);
      t.eq(sel.outline, sel.want, `${kind}: the outline (1.5 px, drawn on whole device pixels)`);
      t.eq(sel.color, sel.blue, `${kind}: the outline is the canvas selection blue`);
      t.near(sel.radius, 12 * sel.z, 0.01, `${kind}: the outline's corners follow the card's 12 px radius at ${sel.z * 100}%`);
      t.near(sel.box.x, r.x, 1, `${kind}: #sel sits on the card`);
      t.near(sel.box.w, r.w, 1, `${kind}: #sel is the card's width`);
      t.eq(sel.dim, "none", `${kind}: no size badge`);
      t.ok(sel.hs.every((x: string) => /rgba\(0, 0, 0, 0\)\|0px/.test(x)), `${kind}: no handles are painted: ${JSON.stringify(sel.hs)}`);
      const after = await t.shot(clip);
      // Pixels: the ring just outside the card turned blue; nothing inside the card changed.
      const A = decodePng(before), B = decodePng(after);
      const at = (img: ReturnType<typeof decodePng>, x: number, y: number) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
      const [br, bg, bb] = at(B, r.x + r.w / 2 - clip.x, r.y - 1 - clip.y);
      t.ok(bb > 150 && bb > br + 40 && bb > bg, `${kind}: the pixel above the card's top edge is blue (${br},${bg},${bb})`);
      const inside = { x: 6, y: 6, w: r.w - 12, h: r.h - 12 };
      let changed = 0;
      for (let y = inside.y; y < inside.y + inside.h; y += 2) for (let x = inside.x; x < inside.x + inside.w; x += 2) {
        const a = at(A, r.x - clip.x + x, r.y - clip.y + y), b = at(B, r.x - clip.x + x, r.y - clip.y + y);
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 24) changed++;
      }
      // A shader or video card draws its own frames (the engine): only the cards drawn by the page hold still.
      if (kind !== "shader" && kind !== "video") t.ok(changed < 4, `${kind}: ${changed} sampled pixels inside the card changed when it was selected`);
      const d = pixelDiff(before, after);
      const ring = 2 * (r.w + r.h);
      t.ok(d > ring * 0.8, `${kind}: ${d} pixels changed, want about the outline's ${Math.round(ring * 1.5)}`);
      fs.mkdirSync(path.join(ROOT, "qa", "out"), { recursive: true });
      fs.writeFileSync(path.join(ROOT, "qa", "out", `card-selected-${theme}-${kind}.png`), after);
    }
  });
}

sc("cards", "two selected cards each show the outline", { covers: ["card-select:many"] }, async (t: T) => {
  await cards(t, "todo");
  const a = await card(t, "todo"), b = await card(t, "note", "Note");
  await t.select([a.id, b.id]);
  await sleep(200);
  const boxes = await t.ev<any[]>(`[...document.querySelectorAll(".mbox.wbox")].filter((e) => getComputedStyle(e).display !== "none").map((e) => { const s = getComputedStyle(e); return { w: s.outlineWidth, want: Math.max(1, Math.floor(1.5 * devicePixelRatio)) / devicePixelRatio + "px", r: parseFloat(s.borderTopLeftRadius) }; })`);
  t.eq(boxes.length, 2, "one outline per card");
  t.ok(boxes.every((x) => x.w === x.want && x.r > 11), `both outlines hug the cards: ${JSON.stringify(boxes)}`);
});

const CARD_CURSOR: Record<Handle, string> = CURSORS;
for (const kind of ["todo", "note", "posthog", "shader", "video"]) {
  sc("cards", `${kind} card: resize from 4 edges and 4 corners, cursors, Option from the centre`, { covers: [`card-resize:card-${kind}`, `resize:card-${kind}`, `resize-modifiers:card-${kind}`, `card-resize:mouse`, ...HANDLES.map((h) => `card-resize:handle-${h}`), `undo-redo:card-${kind}`] }, async (t: T) => {
    await cards(t, kind);
    const problems: string[] = [];
    for (const h of HANDLES) {
      const { w, r, id } = await card(t, kind);
      // Edges: 3 px inside the card; corners: 3 px in from both sides.
      const ins = h.length === 2 ? 5 : 3; // a corner probe sits inside the card's rounded corner
      const px = h.includes("w") ? r.x + ins : h.includes("e") ? r.x + r.w - ins : r.x + r.w / 2;
      const py = h.includes("n") ? r.y + ins : h.includes("s") ? r.y + r.h - ins : r.y + r.h / 2;
      await t.io.move(px, py);
      await t.frames(2);
      // The cursor the pointer shows: a selected card's corner handle (invisible) sets its own, else the card's inline one.
      const cur = await t.ev<string>(`(() => { const e = document.elementFromPoint(${px}, ${py}); const c = e && e.closest(".wd"); return (e && e.matches("#sel i") ? getComputedStyle(e).cursor : c && c.style.cursor) || ""; })()`);
      if (cur !== CARD_CURSOR[h]) problems.push(`${h}: cursor "${cur}"`);
      const dx = h.includes("w") ? -40 : h.includes("e") ? 40 : 0, dy = h.includes("n") ? -30 : h.includes("s") ? 30 : 0;
      await t.io.drag(px, py, px + dx, py + dy, { steps: 8 });
      await t.flush();
      const w1 = t.widgets().widgets.find((x: any) => x.id === w.id);
      const a = { l: w.x, t: w.y, r: w.x + w.w, b: w.y + w.h }, b = { l: w1.x, t: w1.y, r: w1.x + w1.w, b: w1.y + w1.h };
      const want = { l: h.includes("w"), r: h.includes("e"), t: h.includes("n"), b: h.includes("s") };
      for (const k of ["l", "r", "t", "b"] as const) {
        const moved = Math.abs(b[k] - a[k]) > 4;
        if (moved !== want[k]) problems.push(`${h}: side ${k} ${moved ? "moved" : "stayed"} (${a[k]} -> ${b[k]})`);
      }
      await t.undo();
      const w2 = t.widgets().widgets.find((x: any) => x.id === w.id);
      if (w2.x !== w.x || w2.y !== w.y || w2.w !== w.w || w2.h !== w.h) problems.push(`${h}: undo did not restore it`);
    }
    // Option on the east edge: both sides move, the centre stays.
    {
      const { w, r } = await card(t, kind);
      const px = r.x + r.w - 3, py = r.y + r.h / 2;
      await t.io.drag(px, py, px + 30, py, { steps: 8, late: { alt: true } });
      await t.flush();
      const w1 = t.widgets().widgets.find((x: any) => x.id === w.id);
      if (Math.abs(w1.x + w1.w / 2 - (w.x + w.w / 2)) > 1.5 || w1.w < w.w + 40) problems.push(`alt east: ${JSON.stringify([w.x, w.w, w1.x, w1.w])}`);
      await t.undo();
    }
    // Shift on a side edge keeps the aspect ratio.
    {
      const { w, r } = await card(t, kind);
      const px = r.x + r.w - 3, py = r.y + r.h / 2;
      await t.io.drag(px, py, px + 40, py, { steps: 8, late: { shift: true } });
      await t.flush();
      const w1 = t.widgets().widgets.find((x: any) => x.id === w.id);
      if (Math.abs(w1.w / w1.h - w.w / w.h) > 0.03 || w1.w <= w.w) problems.push(`shift east: ratio ${w.w}x${w.h} -> ${w1.w}x${w1.h}`);
      await t.undo();
    }
    t.eq(problems, [], `${kind} card handles`);
  });
}

const todoItems = (t: T) => t.widget("todo").config.items as { id: string; text: string; done: boolean }[];
async function rowInput(t: T, text: string) {
  const at = await t.ev<{ x: number; y: number } | null>(`(() => { const i = [...document.querySelectorAll(".td-row input")].find((x) => x.value === ${JSON.stringify(text)}); if (!i) return null; const b = i.getBoundingClientRect(); return { x: b.left + Math.min(b.width - 4, 8 + ${JSON.stringify(text)}.length * 6.5), y: b.top + b.height / 2 }; })()`);
  t.ok(at, `a to-do row "${text}"`);
  return at;
}

sc("todo", "Return adds, Backspace on an empty row deletes", { covers: ["todo:card-todo","todo:keyboard","todo:mouse"] }, async (t: T) => {
  await cards(t);
  const n0 = todoItems(t).length;
  const add = await t.ev<{ x: number; y: number }>(`(() => { const b = document.querySelector(".td-add input").getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; })()`);
  await t.io.click(add.x, add.y);
  await t.io.type("Fresh item");
  await t.io.key("Enter");
  await sleep(400);
  await t.flush();
  t.eq(todoItems(t).length, n0 + 1, "one item more");
  t.ok(todoItems(t).some((i) => i.text === "Fresh item" && !i.done), "the typed item is stored");
  // Return at the end of a row: a new empty row below it, focused; Backspace on it deletes it.
  const r = await rowInput(t, "Resize from every edge");
  await t.io.click(r.x, r.y);
  await t.io.key("End");
  await t.io.key("Enter");
  await sleep(500);
  await t.flush();
  const items = todoItems(t);
  t.eq(items.length, n0 + 2, "Return in a row adds an item");
  const at = items.findIndex((i) => i.text === "Resize from every edge");
  t.eq(items[at + 1]?.text, "", "the new item is right below, empty");
  t.ok(await t.ev(`document.activeElement && document.activeElement.closest(".td-row") && document.activeElement.value === ""`), "and has the focus");
  await t.io.key("Backspace");
  await sleep(500);
  await t.flush();
  t.eq(todoItems(t).length, n0 + 1, "Backspace on the empty row deletes it");
});

sc("todo", "Cmd+K completes; the row settles into the done section", { covers: ["todo:card-todo","todo:keyboard"] }, async (t: T) => {
  await cards(t);
  // The app's palette listens for Cmd+K natively; the page tells it (canvasPalette) when a to-do field has focus.
  await t.ev(`(() => { window.__pal = []; const sink = { postMessage: (m) => window.__pal.push(JSON.parse(m)) }; window.webkit = { messageHandlers: { canvasPalette: sink, canvasState: { postMessage() {} } } }; })()`);
  const r = await rowInput(t, "Check this one off");
  await t.io.click(r.x, r.y);
  await sleep(50);
  t.eq((await t.ev<any[]>("window.__pal")).at(-1), { todoFocus: true }, "the shell hears a to-do field has focus, so Cmd+K is not the palette's");
  await t.io.key("k", { meta: true });
  await sleep(1400); // the check pops, then the row moves (SETTLE_MS 900)
  await t.flush();
  t.ok(todoItems(t).find((i) => i.text === "Check this one off")?.done, "stored as done");
  const order = await t.ev<{ text: string; done: boolean }[]>(`[...document.querySelectorAll(".td-rows .td-row")].map((r) => ({ text: r.querySelector("input").value, done: r.classList.contains("done") }))`);
  const firstDone = order.findIndex((o) => o.done);
  t.ok(firstDone >= 0 && order.slice(firstDone).every((o) => o.done), `done rows come last: ${JSON.stringify(order)}`);
  t.ok(order.find((o) => o.text === "Check this one off")?.done, "the completed row is among them");
  const anim = await t.ev<number>(`document.getAnimations().filter((a) => a.playState === "running" && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".td")).length`);
  t.eq(anim, 0, "no animation left running");
});

sc("todo", "a text drag that leaves a to-do field selects nothing outside it", { covers: ["todo:mouse"] }, async (t: T) => {
  await cards(t);
  const r = await rowInput(t, "Drag me by the body");
  const { w } = await card(t, "todo");
  await t.io.drag(r.x - 30, r.y, r.x + 900, r.y + 260, { steps: 20 });
  await sleep(100);
  // Chrome reports a field's own selection through getSelection() with the field's parent as anchor: every range
  // must sit inside that row, and the text it holds must be the field's selected text.
  const s = await t.ev<any>(`(() => { const s = getSelection(), a = document.activeElement, row = a && a.closest(".td-row"); const inRow = (n) => !!row && !!n && row.contains(n.nodeType === 1 ? n : n.parentNode); const ranges = []; for (let i = 0; i < s.rangeCount; i++) ranges.push(s.getRangeAt(i)); return { text: s.toString(), ranges: ranges.length, contained: ranges.every((r) => inRow(r.commonAncestorContainer)) && (!s.anchorNode || inRow(s.anchorNode)) && (!s.focusNode || inRow(s.focusNode)), inInput: !!(a && a.tagName === "INPUT"), field: a && a.tagName === "INPUT" ? a.value.slice(a.selectionStart, a.selectionEnd) : null, sel: a && a.tagName === "INPUT" ? [a.selectionStart, a.selectionEnd] : null }; })()`);
  t.ok(s.contained, `the selection stays in the field's row (${JSON.stringify(s)})`);
  t.ok(!s.text || s.text === s.field, `the selected text is the field's (${JSON.stringify(s)})`);
  t.ok(s.inInput && s.sel[1] > s.sel[0], `the text in the field is selected (${JSON.stringify(s)})`);
  t.eq(await t.ev(`!!document.querySelector("#marquee") && getComputedStyle(document.querySelector("#marquee")).display !== "none"`), false, "no marquee");
  await t.flush();
  const w1 = t.widget("todo");
  t.eq({ x: w1.x, y: w1.y }, { x: w.x, y: w.y }, "the card did not move");
});

// ---------------------------------------------------------------- note

sc("note", "# heading, - list and Cmd+B bold by typing", { covers: ["note:card-note","note:keyboard"] }, async (t: T) => {
  await cards(t, "note", "Scratch note");
  const { r } = await card(t, "note", "Scratch note");
  const word = await t.ev<{ x: number; y: number }>(`(() => { const e = [...document.querySelectorAll(".wd")].find((x) => x.getAttribute("aria-label") === "Scratch note").querySelector(".nd"); const b = e.getBoundingClientRect(); return { x: b.left + 40, y: b.top + 12 }; })()`);
  t.ok(word.y > r.y, "the note's text is on screen");
  await t.io.dblclick(word.x, word.y);
  await sleep(200);
  t.ok(await t.ev(`document.activeElement && document.activeElement.classList.contains("nd")`), "double-click starts editing");
  await t.io.key("End");
  await t.io.key("Enter");
  await t.io.type("# Big title");
  await t.io.key("Enter");
  await t.io.type("- first point");
  await t.io.key("Enter");
  await t.io.key("Enter");
  await t.io.key("b", { meta: true });
  await t.io.type("strong");
  await t.io.key("b", { meta: true });
  await t.io.type(" plain");
  await sleep(500);
  await t.io.key("Escape");
  await sleep(400);
  await t.flush();
  const text = t.widgets().widgets.find((x: any) => x.name === "Scratch note").config.text as string;
  t.ok(text.split("\n").includes("# Big title"), `a heading line: ${JSON.stringify(text)}`);
  t.ok(text.split("\n").includes("- first point"), `a list line: ${JSON.stringify(text)}`);
  t.ok(text.includes("**strong** plain"), `bold text: ${JSON.stringify(text)}`);
  const dom = await t.ev<string[]>(`[...[...document.querySelectorAll(".wd")].find((x) => x.getAttribute("aria-label") === "Scratch note").querySelectorAll(".nd .nb, .nd strong")].map((e) => (e.dataset.t || e.tagName) + ":" + e.textContent)`);
  t.ok(dom.includes("h1:Big title") && dom.includes("ul:first point") && dom.includes("STRONG:strong"), `drawn as heading, list and bold: ${JSON.stringify(dom)}`);
});

// ---------------------------------------------------------------- pages

sc("pages", "switch pages from the rail; move a board to another page", { covers: ["pages:board","pages:other-page","pages:mouse","undo-redo:board"] }, async (t: T) => {
  for (const p of ["components", "style", "cards", "layout"]) {
    await t.showPage(p);
    const want = t.widgets().pages.find((x: any) => x.id === p).boards.sort();
    const have = (await t.ev<string[]>("[...window.canvasHost.boards.keys()]")).sort();
    t.eq(have, want, `boards shown on ${p}`);
  }
  // The shell's "Move to page" sends this request (apps/macos/Pages.swift moveBoards).
  await t.a.post("/api/pages/move", { boards: ["lay_clip"], to: "style" });
  await t.waitFor(`!window.canvasHost.boards.has("lay_clip")`, "the board to leave this page");
  t.ok(t.widgets().pages.find((x: any) => x.id === "style").boards.includes("lay_clip"), "stored on the Style page");
  await t.showPage("style");
  t.ok(await t.ev(`window.canvasHost.boards.has("lay_clip")`), "shown on the Style page");
  await t.undo();
  t.ok(t.widgets().pages.find((x: any) => x.id === "layout").boards.includes("lay_clip"), "undo puts it back on Layout");
});

sc("pages", "undo of an edit on another page shows that page and selects what changed", { covers: ["undo-redo:other-page","undo-redo:board","undo-redo:keyboard","pages:other-page"] }, async (t: T) => {
  // The empty page is made first: making a page is an undo step of its own.
  await t.a.post("/api/pages", { id: "empty", name: "Empty" });
  await t.waitFor(`window.canvasHost.pages.some((p) => p.id === "empty")`, "the new page in the rail");
  await t.focus("lay_nest");
  await t.select(["lay_nest"]);
  const x0 = t.node("lay_nest")!.x;
  await t.io.key("ArrowRight");
  await t.flush();
  t.eq(t.node("lay_nest")!.x, x0 + 1, "the nudge moved the board");
  await t.showPage("empty");
  t.eq(await t.sel(), [], "nothing selected on the empty page");
  await t.undo();
  await t.waitFor(`window.canvasHost.page === "layout"`, "undo to show the page of the change");
  t.eq(t.node("lay_nest")!.x, x0, "the nudge is undone");
  t.eq(await t.sel(), ["lay_nest"], "the undone board is selected, on its own page");
  t.ok(await t.ev(`window.canvasHost.boards.has("lay_nest")`), "the selected board is drawn");
});

sc("pages", "delete a used main component's board, undo: the page list is back as it was", { covers: ["delete:component","delete:board","undo-redo:board"] }, async (t: T) => {
  await t.showPage("components");
  const before = JSON.stringify(t.widgets());
  const doc0 = JSON.stringify(t.disk());
  for (let i = 0; i < 2; i++) {
    await t.a.post("/api/structure", { file: t.file, op: "delete", ids: ["cmp_main"], page: "components" });
    await t.flush();
    const holder = t.disk().children.find((n: any) => n.metadata?.canvasDeletedComponents === true);
    t.ok(holder, "the instances' component is parked in a hidden board");
    await t.undo();
    const ids = new Set(t.disk().children.map((n: any) => n.id));
    t.eq(t.widgets().pages.flatMap((p: any) => p.boards).filter((id: string) => !ids.has(id)), [], "no page lists a board the document lacks");
    t.eq(JSON.stringify(t.widgets()), before, "widgets.json is back as it was");
    t.eq(JSON.stringify(t.disk()), doc0, "document.json is back as it was");
    await t.redo();
    t.ok(t.widgets().pages.find((p: any) => p.id === "components").boards.includes(holder!.id), "redo lists the hidden board again");
    await t.undo();
  }
});

// ---------------------------------------------------------------- Copy as, Select layer, zoom and view

sc("copy-as", "Shift+Cmd+C copies the selection as a 2x PNG; several layers make one picture", { covers: ["copy-as:one", "copy-as:many", "copy-as:board", "copy-as:keyboard", "copy-as:png"] }, async (t: T) => {
  await t.focus("lay_nest");
  const copy = async (ids: string[]) => {
    await t.select(ids);
    await t.ev("window.canvasHost.lastCopy = null");
    await t.io.key("c", { meta: true, shift: true });
    return t.waitFor<{ width: number; height: number; error?: string }>("window.canvasHost.lastCopy && !window.canvasHost.lastCopy.pending && window.canvasHost.lastCopy", "the copy", 20_000);
  };
  const one = await copy(["fr_inner"]);
  t.eq([one.width, one.height, one.error], [260, 180, undefined], "Inner frame (130 x 90) at 2x");
  t.ok(/Copied as PNG|did not allow/.test(await t.ev<string>(`document.getElementById("msg").textContent`)), "a toast says what happened");
  // A group's two squares: 60 x 60 at x 0 and x 76, one picture 136 x 60 at 2x.
  const two = await copy(["r_g1", "r_g2"]);
  t.eq([two.width, two.height], [272, 120], "two layers as one picture");
  const board = await copy(["lay_nest"]);
  t.eq([board.width, board.height], [1120, 840], "a board (560 x 420) at 2x");
  // Shift+Cmd+C is not Cmd+C: nothing went to Canvas's own layer clipboard, so a paste adds nothing.
  const before = JSON.stringify(t.disk());
  await t.clearSel();
  t.eq(JSON.stringify(t.disk()), before, "the document is untouched");
  t.subject = ["lay_nest"];
});

sc("select", "Select layer: every layer under the pointer, topmost first; picking one selects it", { covers: ["select-layer:nested", "select-layer:overlap"] }, async (t: T) => {
  await t.focus("lay_nest");
  const c = await t.center("r_inner");
  const under = await t.ev<{ id: string; name: string; type: string }[]>(`window.canvasHost.layersAt(${c.x}, ${c.y})`);
  t.eq(under.map((u) => u.id), ["r_inner", "fr_inner", "fr_outer", "lay_nest"], "the stack under the pointer");
  t.eq(under.map((u) => u.name), ["Inner rect", "Inner frame", "Outer frame", "Frames and groups"], "their names");
  t.eq(under[0].type, "rectangle", "a type for the symbol");
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "selectLayer", id: "fr_outer" })`);
  await t.frames(2);
  t.eq(await t.sel(), ["fr_outer"], "picking a row selects that layer");
  // Two overlapping squares in a group: both listed, the one on top first.
  const g = await t.center("r_g1");
  const ids = (await t.ev<{ id: string }[]>(`window.canvasHost.layersAt(${g.x}, ${g.y})`)).map((u) => u.id);
  t.eq(ids.slice(0, 2), ["r_g1", "g_pair"], "the square, then its group");
  t.subject = ["lay_nest"];
});

sc("canvas", "Shift+= / Shift+- zoom, arrows pan with nothing selected, Z and click zooms about the pointer", { covers: ["pan-zoom:shift-keys", "pan-zoom:arrows", "pan-zoom:zoom-tool", "pan-zoom:keyboard"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.clearSel();
  const cam = () => t.ev<{ x: number; y: number; z: number }>("window.canvasHost.cam");
  const z0 = (await cam()).z;
  await t.io.key("+", { shift: true });
  await t.frames(2);
  t.near((await cam()).z, z0 * 2, 1e-6, "Shift+= doubles the zoom");
  await t.io.key("_", { shift: true });
  await t.frames(2);
  t.near((await cam()).z, z0, 1e-6, "Shift+- halves it");
  const c0 = await cam();
  await t.io.key("ArrowRight");
  await t.io.key("ArrowDown", { shift: true });
  await t.frames(2);
  const c1 = await cam();
  t.eq([c1.x - c0.x, c1.y - c0.y, c1.z], [-40, -200, c0.z], "Right pans 40 px, Shift+Down 200 px");
  // With a layer selected the arrows nudge it instead.
  await t.select(["r_free"]);
  const x0 = t.node("r_free")!.x;
  await t.io.key("ArrowRight");
  await t.flush();
  t.eq([t.node("r_free")!.x, (await cam()).x], [x0 + 1, c1.x], "an arrow nudges the selection, the view stays");
  await t.undo();
  await t.clearSel();
  // Z held: a click zooms in 2x about the pointer and selects nothing; Option+click zooms out.
  const p = await t.center("fr_inner");
  const vb = await t.ev<{ l: number; t: number }>("window.canvasHost.viewBox");
  const worldAt = (c: { x: number; y: number; z: number }) => ({ x: (p.x - vb.l - c.x) / c.z, y: (p.y - vb.t - c.y) / c.z });
  const before = await cam();
  await t.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, text: "z" });
  await t.io.click(p.x, p.y);
  await t.frames(2);
  const zin = await cam();
  t.near(zin.z, before.z * 2, 1e-6, "Z+click zooms in 2x");
  t.near(worldAt(zin).x, worldAt(before).x, 0.01, "about the pointer (x)");
  t.near(worldAt(zin).y, worldAt(before).y, 0.01, "about the pointer (y)");
  t.eq(await t.sel(), [], "nothing selected by the zoom click");
  await t.io.click(p.x, p.y, { alt: true });
  await t.frames(2);
  t.near((await cam()).z, before.z, 1e-6, "Z+Option+click zooms back out");
  await t.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
  await t.io.click(p.x, p.y);
  await t.frames(2);
  t.eq(await t.sel(), ["fr_outer"], "Z let go: a click selects again");
  t.subject = ["lay_nest"];
});

sc("canvas", "the pixel grid shows from 400% up; Cmd+' toggles it", { covers: ["pixel-grid:keyboard", "pixel-grid:zoom-below", "pixel-grid:zoom-above"] }, async (t: T) => {
  await t.focus("lay_nest");
  const shown = () => t.ev<boolean>(`getComputedStyle(document.getElementById("pixelGrid")).display !== "none"`);
  const r = await t.ev<Rect>(`window.__canvas.boardPos("lay_nest")`);
  await t.look(r.x + 30, r.y + 70, 3.9);
  t.eq(await shown(), false, "no grid at 390%");
  await t.look(r.x + 30, r.y + 70, 4);
  await t.frames(2);
  t.eq(await shown(), true, "the grid at 400%");
  await t.look(r.x + 40, r.y + 76, 12);
  await t.frames(2);
  await t.shot().then((png) => fs.writeFileSync(path.join(process.env.QA_SHOTS_DIR || "qa/out", "nav-pixel-grid.png"), png)).catch(() => {});
  await t.io.key("'", { meta: true });
  await t.frames(2);
  t.eq(await shown(), false, "Cmd+' hides it");
  await t.io.key("'", { meta: true });
  await t.frames(2);
  t.eq(await shown(), true, "and shows it again");
  t.subject = ["lay_nest"];
});

sc("canvas", "Shift+R shows rulers; a guide dragged out onto a board is saved on it, moved, and dragged back off; undo", { covers: ["rulers:keyboard", "rulers:add", "rulers:move", "rulers:remove", "rulers:undo"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.clearSel();
  await t.io.key("R", { shift: true });
  await t.waitFor(`getComputedStyle(document.getElementById("rulerTop")).display !== "none"`, "the rulers");
  const ruler = await t.ev<Rect>(`(() => { const r = document.getElementById("rulerTop").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const b = await t.rect("lay_nest");
  const guides = () => (t.node("lay_nest")!.metadata?.canvasGuides ?? []) as { axis: string; at: number }[];
  // From the top ruler down into the board, 100 px below its top at this zoom.
  const z = await t.ev<number>("window.canvasHost.cam.z");
  await t.io.drag(b.x + 200, ruler.y + ruler.h / 2, b.x + 200, b.y + 100 * z, { steps: 10 });
  await t.flush();
  t.eq(guides(), [{ axis: "y", at: 100 }], "a horizontal guide 100 px down the board");
  t.eq(t.node("lay_nest")!.metadata?.type, "canvas", "Canvas's metadata kind");
  await t.waitFor(`window.canvasHost.nav.guides.length === 1`, "the guide drawn");
  // Out of the left ruler: a vertical guide.
  const left = await t.ev<Rect>(`(() => { const r = document.getElementById("rulerLeft").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await t.io.drag(left.x + left.w / 2, b.y + 200, b.x + 50 * z, b.y + 200, { steps: 10 });
  await t.flush();
  t.eq(guides(), [{ axis: "y", at: 100 }, { axis: "x", at: 50 }], "a vertical guide 50 px in");
  await t.waitFor(`window.canvasHost.nav.guides.length === 2`, "both guides drawn");
  await t.shot().then((png) => fs.writeFileSync(path.join(process.env.QA_SHOTS_DIR || "qa/out", "nav-rulers.png"), png)).catch(() => {});
  // Move the horizontal one 20 px down.
  await t.io.drag(b.x + 300, b.y + 100 * z, b.x + 300, b.y + 120 * z, { steps: 8 });
  await t.flush();
  t.eq(guides(), [{ axis: "x", at: 50 }, { axis: "y", at: 120 }], "the guide moved to 120");
  // Back onto the ruler: removed.
  await t.io.drag(b.x + 300, b.y + 120 * z, b.x + 300, ruler.y + ruler.h / 2, { steps: 8 });
  await t.flush();
  t.eq(guides(), [{ axis: "x", at: 50 }], "dragged onto the ruler, it is gone");
  await t.undo();
  t.eq(guides(), [{ axis: "x", at: 50 }, { axis: "y", at: 120 }], "undo brings it back");
  await t.io.key("R", { shift: true });
  await t.waitFor(`getComputedStyle(document.getElementById("rulerTop")).display === "none"`, "the rulers hidden");
  t.subject = ["lay_nest"];
});

// ---------------------------------------------------------------- links (Cmd+L)

sc("links", "Cmd+L copies a link to the selection, else the board in view; a link shows its page and nodes", { covers: ["copy-link:one","copy-link:many","copy-link:board","copy-link:empty","copy-link:keyboard","copy-link:other-page","copy-link:open-url"] }, async (t: T) => {
  const want = (nodes: string[]) => buildLink({ file: t.file, page: "layout", nodes });
  // host.lastLink: what the page put on the clipboard (headless Chrome's clipboard is not the Mac's to read).
  const copy = async () => {
    await t.ev("window.canvasHost.lastLink = null");
    await t.io.key("l", { meta: true });
    return (await t.waitFor<{ text: string; written: boolean }>("window.canvasHost.lastLink && window.canvasHost.lastLink.written !== false && window.canvasHost.lastLink", "the link on the clipboard")).text;
  };
  // Opt+Cmd+L is still text align left (and copies nothing).
  await t.focus("lay_text");
  await t.select(["tx_long"]);
  await t.ev("window.canvasHost.lastLink = null");
  await t.io.key("t", { meta: true, alt: true });
  await t.flush();
  t.eq(t.node("tx_long")!.textAlign, "center", "Opt+Cmd+T centres");
  await t.io.key("l", { meta: true, alt: true });
  await t.flush();
  t.ok(t.node("tx_long")!.textAlign === "left" || t.node("tx_long")!.textAlign === undefined, `Opt+Cmd+L aligns left (${t.node("tx_long")!.textAlign})`);
  t.eq(await t.ev("window.canvasHost.lastLink"), null, "Opt+Cmd+L copies no link");
  await t.focus("lay_nest");
  await t.select(["r_free"]);
  t.eq(await copy(), want(["r_free"]), "one layer");
  t.ok(/Link copied/.test(await t.ev<string>(`document.getElementById("msg").textContent`)), "the toast says Link copied");
  await t.select(["r_free", "fr_inner"]);
  t.eq(await copy(), want(["r_free", "fr_inner"]), "two layers, in the order picked");
  // Nothing selected: the board that fills the view.
  await t.clearSel();
  const b = await t.ev<Rect>(`window.__canvas.boardPos("lay_nest")`);
  await t.look(b.x + 40, b.y + 40, 3);
  t.eq(await t.sel(), [], "nothing selected");
  t.eq(await copy(), want(["lay_nest"]), "the board in view");
  // Opening a link (the app's canvas:// handler sends this to the page): from another page, its page shows and its
  // layers are selected and in view.
  await t.showPage("style");
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "openLink", page: "layout", ids: ["r_free", "fr_inner"] })`);
  await t.waitFor(`window.canvasHost.page === "layout" && JSON.stringify(window.canvasHost.selection()) === '["r_free","fr_inner"]'`, "the link's page and selection");
  await t.settle();
  const r = await t.rect("r_free");
  t.ok(r.x > 0 && r.y > 0 && r.x + r.w < 1600 && r.y + r.h < 1000, `the linked layer is in view (${JSON.stringify(r)})`);
  t.subject = ["lay_nest"];
});

// ---------------------------------------------------------------- search

sc("search", "find a board by name and a text by its content", { covers: ["search:board","search:text","search:card-todo"] }, async (t: T) => {
  if ((await t.a.status("/api/search?q=x")) === 404) t.skip("no /api/search");
  const flat = (j: any): any[] => (Array.isArray(j) ? j : Array.isArray(j.results) ? j.results : Array.isArray(j.groups) ? j.groups.flatMap((g: any) => g.items ?? g.results ?? []) : []);
  const b = flat(await t.a.get("/api/search?q=" + encodeURIComponent("Auto layout")));
  t.ok(b.some((r: any) => r.id === "lay_auto"), `board found: ${JSON.stringify(b.slice(0, 3)).slice(0, 300)}`);
  const x = flat(await t.a.get("/api/search?q=" + encodeURIComponent("Tight -2%")));
  t.ok(x.some((r: any) => r.id === "ts_tight"), `text found by content: ${JSON.stringify(x.slice(0, 3)).slice(0, 300)}`);
  const c = flat(await t.a.get("/api/search?q=" + encodeURIComponent("Playground to-dos")));
  t.ok(c.some((r: any) => String(r.id).includes(t.widget("todo").id)), `card found: ${JSON.stringify(c.slice(0, 3)).slice(0, 300)}`);
});

// Text: editing, type keys, styled ranges, find and replace.
import "./scenarios-text.ts";
// Leftover niceties: layout guides, paragraph settings, lists.
import "./scenarios-leftovers.ts";
import "./scenarios-gaps-text.ts";

// ---------------------------------------------------------------- lock and selection niceties

/** Saves a picture of a view region to qa/out/evidence/<name>.png (docs/evidence keeps the ones looked at). */
async function layersShot(t: T, name: string, r: Rect, pad = 40) {
  const dir = path.join(process.cwd(), "qa", "out", "evidence");
  fs.mkdirSync(dir, { recursive: true });
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: r.h + pad * 2 };
  fs.writeFileSync(path.join(dir, name + ".png"), await t.shot(clip));
}
const until = async (t: T, ok: () => boolean, what: string) => {
  for (let i = 0; i < 60; i++) { await t.flush(); if (ok()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
};

sc("lock", "Shift+Cmd+L locks a layer: a click and the marquee pass it, a press on it does not move it; again unlocks", { covers: ["lock:rectangle", "lock:keyboard", "lock:mouse"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["r_free"]);
  await t.io.key("l", { meta: true, shift: true });
  await until(t, () => t.node("r_free")?.locked === true, "r_free locked on disk");
  await t.frames(4);
  // A click on it picks what is under it (the board), never the locked layer.
  await t.clearSel();
  const c = await t.center("r_free");
  await t.io.click(c.x, c.y);
  await t.frames(3);
  t.ok(!(await t.sel()).includes("r_free"), `a click selected the locked layer (${JSON.stringify(await t.sel())})`);
  // The marquee from the board's background takes the layers around it, not the locked one.
  await t.clearSel();
  const r = await t.rect("r_free"), b = await t.rect("lay_nest");
  await t.io.drag(b.x + b.w - 8, b.y + b.h - 8, r.x - 4, r.y - 4, { steps: 10 });
  await t.frames(3);
  t.ok(!(await t.sel()).includes("r_free"), `the marquee took the locked layer (${JSON.stringify(await t.sel())})`);
  // Selected from the Layers panel (the page's select op), it shows its box but a drag on it does not move it.
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "layers", op: "select", ids: ["r_free"] })`);
  await t.frames(3);
  t.eq(await t.sel(), ["r_free"], "the panel selects a locked layer");
  const x0 = t.node("r_free")!.x;
  await t.io.drag(c.x, c.y, c.x + 60, c.y + 30, { steps: 8 });
  await t.flush();
  t.eq(t.node("r_free")!.x, x0, "the locked layer did not move");
  await layersShot(t, "layers-lock-canvas", b, 10);
  // Shift+Cmd+L again with it selected unlocks it.
  await t.select(["r_free"]);
  await t.io.key("l", { meta: true, shift: true });
  await until(t, () => t.node("r_free")?.locked === undefined, "r_free unlocked on disk");
  t.subject = ["lay_nest"];
});

sc("lock", "a locked frame locks its children: Cmd+click and the deep marquee skip them", { covers: ["lock:frame", "lock:nested", "lock:many"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["fr_outer", "g_pair"]);
  await t.io.key("l", { meta: true, shift: true });
  await until(t, () => t.node("fr_outer")?.locked === true && t.node("g_pair")?.locked === true, "both locked on disk");
  await t.frames(4);
  await t.clearSel();
  const c = await t.center("r_inner");
  await t.io.click(c.x, c.y, { meta: true });
  await t.frames(3);
  const s = await t.sel();
  t.ok(!s.some((id) => ["r_inner", "fr_inner", "fr_outer"].includes(id)), `Cmd+click reached into the locked frame (${JSON.stringify(s)})`);
  // Cmd+drag across the whole board: the deepest layers it touches, none of the locked ones.
  await t.clearSel();
  const b = await t.rect("lay_nest");
  await t.io.drag(b.x + b.w - 6, b.y + b.h - 6, b.x + 6, b.y + 40, { late: { meta: true }, steps: 10 });
  await t.frames(3);
  const m = await t.sel();
  t.ok(m.length > 0, "the deep marquee took the unlocked layers");
  t.ok(!m.some((id) => ["r_inner", "fr_inner", "fr_outer", "g_pair", "r_g1", "r_g2"].includes(id)), `the deep marquee took locked layers (${JSON.stringify(m)})`);
  t.subject = ["lay_nest"];
});

sc("lock", "an agent locks a board with set_node_props: a click on it selects nothing, Cmd+A leaves it out", { covers: ["lock:board", "lock:agent"], skip: { reopen: "the agent cursor an MCP write shows is live UI, not the file" } }, async (t: T) => {
  await t.focus("lay_nest");
  await t.a.post("/api/update", { file: t.file, id: "lay_nest", props: { locked: true } }, { "x-canvas-source": "mcp" });
  await t.settle();
  await t.frames(4);
  const b = await t.rect("lay_nest");
  await t.io.click(b.x + b.w - 20, b.y + b.h - 20);
  await t.frames(3);
  t.eq(await t.sel(), [], "a click on a locked board selects nothing");
  await t.io.key("a", { meta: true });
  await t.frames(3);
  t.ok(!(await t.sel()).includes("lay_nest"), "Cmd+A leaves the locked board out");
  t.subject = ["lay_nest"];
});

sc("select", "Option+Cmd+A selects matching layers in the other boards", { covers: ["select-matching:cross-board", "select-matching:keyboard"] }, async (t: T) => {
  await t.look(0, 0, 0.5);
  await t.select(["lay_nest_cap"]);
  await t.io.key("a", { meta: true, alt: true });
  const want = (await t.ev<string[]>("[...window.canvasHost.boards.keys()]")).map((b) => b + "_cap").filter((id) => t.node(id)).sort();
  await t.waitFor(`window.canvasHost.selection().length === ${want.length}`, "every board's caption");
  t.eq((await t.sel()).sort(), want, "the captions of every board on the page");
  await layersShot(t, "layers-select-matching", { x: 250, y: 30, w: 1100, h: 520 }, 0);
});

sc("select", "Option+Cmd+A with nothing to match says so", { covers: ["select-matching:empty"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["r_free"]);
  await t.io.key("a", { meta: true, alt: true });
  await sleep(400);
  t.eq(await t.sel(), ["r_free"], "the selection stays");
  const msg = await t.ev<string>("(document.getElementById('msg') || {}).textContent || ''");
  t.ok(/No matching layers/.test(msg), `the page says why (${msg})`);
});

sc("select", "Edit > Select All with Same Stroke and Effect", { covers: ["select-same:stroke", "select-same:effect", "select-same:many"] }, async (t: T) => {
  await t.showPage("style");
  await t.focus("sty_paint");
  // A second layer with the stroke and the shadow: Cmd+D on each.
  for (const id of ["pt_stroke", "pt_shadow"]) {
    await t.select([id]);
    await t.io.key("d", { meta: true });
    await t.waitFor(`window.canvasHost.selection()[0] !== ${JSON.stringify(id)}`, "the copy to be selected");
  }
  await t.flush();
  t.eq(t.node("sty_paint")!.children!.length, 10, "two copies next to the caption and the 7 swatches");
  await t.select(["pt_stroke"]);
  await t.ev(`window.canvasHost.shortcuts.run("selectSame:stroke")`);
  await t.waitFor("window.canvasHost.selection().length === 2", "two layers with the stroke");
  t.ok((await t.sel()).includes("pt_stroke"), "the stroke layer and its copy");
  await t.select(["pt_shadow"]);
  await t.ev(`window.canvasHost.shortcuts.run("selectSame:effect")`);
  await t.waitFor("window.canvasHost.selection().length === 2", "two layers with the shadow");
  t.ok((await t.sel()).includes("pt_shadow"), "the shadow layer and its copy");
  t.subject = ["sty_paint"];
});

sc("select", "Shift+Cmd+A selects the inverse; backslash selects the parent", { covers: ["select-inverse:one", "select-inverse:keyboard", "select-inverse:board", "select-keys:backslash"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["r_free"]);
  await t.io.key("a", { meta: true, shift: true });
  await t.waitFor("window.canvasHost.selection().length > 1", "the inverse");
  const kids = t.node("lay_nest")!.children!.map((c: any) => c.id).filter((id: string) => id !== "r_free");
  t.eq((await t.sel()).sort(), kids.sort(), "every other layer of the board");
  // Boards: the other boards and cards of the page.
  await t.select(["lay_nest"]);
  await t.io.key("a", { meta: true, shift: true });
  await t.waitFor("!window.canvasHost.selection().includes('lay_nest') && window.canvasHost.selection().length > 0", "the other boards");
  t.ok((await t.sel()).includes("lay_auto"), "the other boards are selected");
  // \ is the second key for Select parent.
  await t.select(["r_g1"]);
  await t.io.key("\\");
  await t.waitFor("window.canvasHost.selection()[0] === 'g_pair'", "the group");
  t.eq(await t.sel(), ["g_pair"], "backslash selects the parent");
});

sc("select", "Option+Space: a keyboard cursor picks a layer with Return and draws a selection box with Cmd+arrows", { covers: ["keyboard-select:one", "keyboard-select:many", "keyboard-select:keyboard"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.clearSel();
  await t.io.key(" ", { alt: true });
  await t.waitFor("window.canvasHost.keybox && window.canvasHost.keybox.active", "the keyboard cursor");
  const vb = await t.ev<{ l: number; t: number }>("window.canvasHost.viewBox");
  const go = async (x: number, y: number) => {
    // Arrow presses until the cursor (view px) is on the point (window px): 80 with Shift, then 8.
    for (let i = 0; i < 80; i++) {
      const at = await t.ev<{ x: number; y: number }>("window.canvasHost.keybox.at");
      const dx = x - vb.l - at.x, dy = y - vb.t - at.y;
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      const big = Math.abs(dx) >= 80 || Math.abs(dy) >= 80;
      const k = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "ArrowRight" : "ArrowLeft") : (dy > 0 ? "ArrowDown" : "ArrowUp");
      await t.io.key(k, big ? { shift: true } : {});
    }
  };
  const c = await t.center("r_free");
  await go(c.x, c.y);
  await t.io.key("Enter");
  await t.waitFor("window.canvasHost.selection()[0] === 'r_free'", "the layer under the cursor");
  t.eq(await t.sel(), ["r_free"], "Return selects what is under the cursor");
  // A box: from above-left of the group to below-right of the free rect, with Cmd held.
  const g = await t.rect("g_pair"), f = await t.rect("r_free");
  await go(g.x - 10, g.y - 10);
  for (let i = 0; i < 40; i++) {
    const at = await t.ev<{ x: number; y: number }>("window.canvasHost.keybox.at");
    const dx = f.x + f.w + 10 - vb.l - at.x, dy = f.y + f.h + 10 - vb.t - at.y;
    if (dx <= 0 && dy <= 0) break;
    await t.io.key(dx > 0 && (dx >= dy || dy <= 0) ? "ArrowRight" : "ArrowDown", { meta: true, shift: true });
  }
  await t.frames(3);
  const s = (await t.sel()).sort();
  t.ok(s.includes("g_pair") && s.includes("r_free") && s.includes("g_rot"), `the box selected what it touches (${JSON.stringify(s)})`);
  await layersShot(t, "layers-keyboard-box", await t.rect("lay_nest"), 10);
  await t.io.key("Escape");
  await t.waitFor("!window.canvasHost.keybox.active", "the cursor to go away");
  t.eq((await t.sel()).sort(), s, "Esc puts the cursor away and keeps the selection");
});

// ---------------------------------------------------------------- clipboard across pages, files and tabs

const CARD_KINDS = ["todo", "note", "posthog", "shader", "video"] as const;
const cardIdsOf = (t: T, page: string) => t.widgets().widgets.filter((w: any) => w.page === page).map((w: any) => w.id as string);
const pageOfBoard = (t: T, id: string) => (t.widgets().pages ?? []).find((p: any) => p.boards.includes(id))?.id ?? null;
const snapshot = (t: T) => ({ d: fs.readFileSync(path.join(t.file, "document.json"), "utf8"), w: fs.readFileSync(path.join(t.file, "widgets.json"), "utf8") });
/** Cmd+V on the page, then the cards it made (once it selected them). */
async function pasteHere(t: T, wantCards: number) {
  const before = t.widgets().widgets.map((w: any) => "widget:" + w.id);
  await t.measureWrites("paste", async () => {
    await t.io.key("v", { meta: true });
    await t.waitFor(`window.canvasHost.selection().filter((id) => id.startsWith("widget:") && !${JSON.stringify(before)}.includes(id)).length >= ${wantCards}`, "the pasted cards to be selected", 15000);
  });
  await t.flush();
  return t.widgets().widgets.filter((w: any) => !before.includes("widget:" + w.id));
}
/** One undo gives back exactly the bytes from before; redo brings the change back (the shared checks then run). */
async function oneUndoStep(t: T, before: { d: string; w: string }, what: string) {
  const after = snapshot(t);
  await t.undo();
  const back = snapshot(t);
  t.ok(back.d === before.d, `${what}: one undo restores document.json`);
  t.ok(back.w === before.w, `${what}: one undo restores widgets.json`);
  await t.redo();
  const again = snapshot(t);
  t.ok(again.d === after.d && again.w === after.w, `${what}: redo brings it back`);
}
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** A picture for docs/evidence: the window with the view fitted to `ids`, selected. */
async function evidence(t: T, name: string, ids: string[]) {
  await t.select(ids);
  await t.ev("window.canvasCmd({ cmd: \"fit\" })");
  await t.settle();
  await sleep(300);
  fs.mkdirSync(path.join(ROOT, "qa", "out", "evidence"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "qa", "out", "evidence", `${name}.png`), await t.shot());
}

sc("clipboard", "a board and every card kind copied on one page paste on another", { covers: ["copy-paste:other-page", "copy-paste:board", "copy-paste:many", "copy-paste:keyboard", ...CARD_KINDS.map((k) => `copy-paste:card-${k}`)] }, async (t: T) => {
  await t.showPage("cards");
  const ids = ["crd_board", ...cardIdsOf(t, "cards").map((id) => "widget:" + id)];
  const n = ids.length - 1;
  t.ok(n >= 5, "the board and the cards");
  await t.select(ids);
  await t.io.key("c", { meta: true });
  await t.waitFor(`fetch("/api/structure/clipboard").then((r) => r.json()).then((j) => !!j.payload && (j.payload.cards || []).length === ${n})`, "the copy");
  await t.showPage("style");
  const before = snapshot(t);
  const made = await pasteHere(t, n);
  t.eq([...new Set(made.map((w: any) => w.kind))].sort(), [...CARD_KINDS].sort(), "every card kind");
  t.eq(made.length, n, "every card");
  t.ok(made.every((w: any) => w.page === "style"), `the cards are on the Style page: ${JSON.stringify(made.map((w: any) => w.page))}`);
  const sel = await t.sel();
  const board = sel.find((id) => !id.startsWith("widget:"));
  t.ok(board && board !== "crd_board", "a new board is selected");
  t.eq(pageOfBoard(t, board!), "style", "the board is on the Style page");
  // Where they were copied unless that is taken: Style has boards there, so they move right, clear of them.
  // Boxes are read once the page has drawn the paste: under load the new board's box lags its placement.
  await t.settle();
  const boards = await t.ev<Rect[]>(`[...window.canvasHost.boards.keys()].filter((id) => id !== ${JSON.stringify(board)}).map((id) => window.canvasHost.boxOf(id))`);
  const mine = [await t.ev<Rect>(`window.canvasHost.boxOf(${JSON.stringify(board)})`), ...made.map((w: any) => ({ x: w.x, y: w.y, w: w.w, h: w.h }))];
  t.ok(!mine.some((m) => boards.some((b) => overlap(m, b))), "nothing pasted lands on a board of the Style page");
  const src = t.widgets().widgets.find((w: any) => w.kind === "shader" && w.page === "cards");
  const sh = made.find((w: any) => w.kind === "shader");
  t.eq(fs.readFileSync(path.join(t.file, "shaders", `${sh.id}.wgsl`), "utf8"), fs.readFileSync(path.join(t.file, "shaders", `${src.id}.wgsl`), "utf8"), "the shader card brings its source");
  t.eq(made.find((w: any) => w.kind === "video").config.src, t.widgets().widgets.find((w: any) => w.kind === "video" && w.page === "cards").config.src, "the video card plays the same file");
  await oneUndoStep(t, before, "page to page");
  await evidence(t, "copypaste-page-to-page", sel);
  t.subject = sel;
});

sc("clipboard", "Cmd+D on a card puts the copy to its right, one undo", { covers: ["duplicate:card-note", "duplicate:card-shader", "duplicate:keyboard"] }, async (t: T) => {
  for (const kind of ["note", "shader"]) {
    await cards(t, kind);
    const { w, id } = await card(t, kind);
    await t.select([id]);
    const before = snapshot(t);
    const had = t.widgets().widgets.map((x: any) => x.id);
    await t.io.key("d", { meta: true });
    await t.waitFor(`window.canvasHost.selection().length === 1 && window.canvasHost.selection()[0] !== ${JSON.stringify(id)}`, "the copy to be selected");
    await t.flush();
    const fresh = t.widgets().widgets.filter((x: any) => !had.includes(x.id));
    t.eq(fresh.length, 1, `${kind}: one card more`);
    const copy = fresh[0];
    t.eq(copy.kind, kind, `${kind}: the copy's kind`);
    t.ok(copy.x >= w.x + w.w, `${kind}: the copy is to the right (${copy.x} vs ${w.x + w.w})`);
    t.eq(copy.y, w.y, `${kind}: on the same row`);
    t.eq(copy.page, w.page, `${kind}: on the same page`);
    t.eq(await t.sel(), ["widget:" + copy.id], `${kind}: the copy is selected`);
    await oneUndoStep(t, before, `Cmd+D on a ${kind} card`);
    if (kind === "note") await evidence(t, "copypaste-cards-duplicate", [id, "widget:" + copy.id]);
  }
});

const DOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAG0lEQVR4XmP4Oo/7P9/Sl/9hNAMyByTIQFAFAIGHKcG3a15jAAAAAElFTkSuQmCC", "base64");

sc("clipboard", "layers and every card kind copied in one file paste into another", { covers: ["copy-paste:other-file", "copy-paste:component", "copy-paste:instance", "copy-paste:image", "copy-paste:keyboard", ...CARD_KINDS.map((k) => `copy-paste:card-${k}`)] }, async (t: T) => {
  t.ok(t.chromePort, "the worker's Chrome port");
  // The other file: a copy of the playground with a component, an instance of it and an image file of its own.
  const other = path.join(path.dirname(t.file), "Other.canvas");
  copyDir(PLAYGROUND, other);
  fs.mkdirSync(path.join(other, "images"));
  fs.writeFileSync(path.join(other, "images", "qa-dot.png"), DOT);
  const oa = api(t.srv.base, other);
  await oa.post("/api/structure", { file: other, op: "add", page: "cards", place: { parent: null }, nodes: [
    { type: "frame", id: "qa_src", name: "From the other file", x: 1400, y: 0, width: 400, height: 240, layout: "none", fill: "#FFFFFF", children: [
      { type: "frame", id: "qa_badge", name: "QA badge", reusable: true, x: 24, y: 24, width: 120, height: 40, layout: "none", fill: "$brand", cornerRadius: 8, children: [
        { type: "text", id: "qa_badge_t", content: "Badge", x: 12, y: 10, fontFamily: "Inter", fontSize: 14, fontWeight: "600", fill: "#FFFFFF" },
      ] },
      { type: "ref", id: "qa_badge_i", ref: "qa_badge", x: 24, y: 100 },
      { type: "rectangle", id: "qa_img", x: 200, y: 100, width: 64, height: 64, fill: { type: "image", url: "images/qa-dot.png", mode: "fill" } },
    ] },
  ] });
  await oa.flush();
  // Copy in a second tab on the other file (one server, as the app's tabs are).
  const tab = await openTab(t.chromePort);
  let n = 0;
  try {
    // Headless Chrome draws only the front tab. The first tab's long-lived requests (events, long polls) take most
    // of Chrome's 6 connections to one host: the second tab uses another name for the same server.
    await tab.page.send("Page.bringToFront");
    const o = new T(tab.page, other, { ...t.srv, base: t.srv.base.replace("127.0.0.1", "localhost") });
    await o.open();
    await o.showPage("cards");
    const cardIds = o.widgets().widgets.filter((w: any) => w.page === "cards").map((w: any) => "widget:" + w.id);
    n = cardIds.length;
    await o.select(["qa_badge_i", "qa_img", ...cardIds]);
    t.eq((await o.sel()).length, n + 2, "the layers and cards are selected in the other file");
    await o.io.key("c", { meta: true });
    await o.waitFor(`fetch("/api/structure/clipboard").then((r) => r.json()).then((j) => !!j.payload && (j.payload.cards || []).length === ${n} && j.payload.nodes.length === 2)`, "the copy in the other file");
  } finally { await tab.close(); }
  await t.page.send("Page.bringToFront");
  await t.settle();
  await t.showPage("cards");
  await t.clearSel();
  const before = snapshot(t);
  const made = await pasteHere(t, n);
  t.eq([...new Set(made.map((w: any) => w.kind))].sort(), [...CARD_KINDS].sort(), "every card kind");
  t.eq(made.length, n, "every card");
  t.ok(made.every((w: any) => w.page === "cards"), "on the page the paste happened on");
  t.eq(made.find((w: any) => w.kind === "posthog").config.secret ?? null, null, "no secret crosses files: the PostHog card asks to connect");
  const video = made.find((w: any) => w.kind === "video");
  t.ok(fs.existsSync(path.join(t.file, video.config.src)), `the video plays a file in this package (${video.config.src})`);
  const sh = made.find((w: any) => w.kind === "shader");
  t.ok(fs.existsSync(path.join(t.file, "shaders", `${sh.id}.wgsl`)), "the shader's source is in this package");
  const sel = await t.sel();
  const layers = sel.filter((id) => !id.startsWith("widget:"));
  t.eq(layers.length, 2, "the instance and the image are selected");
  const doc = t.disk();
  const inst = t.node(layers[0], doc)!, img = t.node(layers[1], doc)!;
  t.eq([inst.type, inst.ref], ["ref", "qa_badge"], "the instance stays an instance of the component it came with");
  const holder = doc.children.find((n: any) => n.metadata?.canvasDeletedComponents === true);
  t.ok(holder && holder.enabled === false && holder.children!.some((c: any) => c.id === "qa_badge"), "the main component sits hidden in this file");
  t.eq(img.fill.url, "images/qa-dot.png", "the image keeps its path");
  t.ok(fs.readFileSync(path.join(t.file, "images", "qa-dot.png")).equals(DOT), "the image file was copied into this package");
  await t.look(inst.x ?? 0, inst.y ?? 0, 1);
  t.ok(await t.ev<boolean>(`!!window.canvasHost.worldRectOf(${JSON.stringify(layers[0])})`), "the instance draws");
  await oneUndoStep(t, before, "file to file");
  await evidence(t, "copypaste-layers-file-to-file", layers);
  await evidence(t, "copypaste-cards-file-to-file", sel.filter((id) => id.startsWith("widget:")));
  t.subject = sel;
});

import "./scenarios-bottom-overlays.ts";
import "./scenarios-people.ts";
import "./scenarios-mcp-background.ts";
import './scenarios-design-helpers.ts';
import './scenarios-context.ts';
import "./scenarios-page-background.ts";
