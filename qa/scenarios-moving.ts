// QA scenarios for moving, arranging and auto layout handles (docs/interaction-conventions.md: Moving and
// reparenting, Auto layout, Smart selection and arranging). Mid-drag pictures go to qa/out/evidence for
// docs/evidence/moving.md; drags that must draw nothing odd go through qa/frames.ts.
import fs from "node:fs";
import path from "node:path";
import { checkDragFrames, pageDriver } from "./frames.ts";
import { sc, type T } from "./harness.ts";
import { decodePng } from "../fidelity/png.ts";
import { ROOT, gradientPng, sleep } from "./lib.ts";

const OUT = path.join(ROOT, "qa", "out", "evidence");
const FRAMES = path.join(ROOT, "qa", "out", "frames");
const pos = (n: any) => ({ x: n?.x, y: n?.y });
/** A picture of the window now, for the evidence (qa/out/evidence/<name>.png). */
async function shot(t: T, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), await t.shot());
}

// ---------------------------------------------------------------- Space keeps the parent

sc("move", "Space held while dragging keeps the layer in its parent; Space alone still pans", { covers: ["move-keep-parent:one", "move-keep-parent:in-frame", "move-keep-parent:in-autolayout", "move-keep-parent:many", "move-keep-parent:board", "move-keep-parent:mouse", "pan-zoom:keyboard"] }, async (t: T) => {
  await t.focus("lay_nest");
  // 1. A layer of the board dropped on a frame: without Space it nests there (the drag into a frame scenario);
  //    with Space it stays a child of the board, moved.
  const f = await t.rect("fr_outer");
  let c = await t.center("r_free");
  await t.select(["r_free"]);
  await t.io.drag(c.x, c.y, f.x + f.w - 40, f.y + f.h - 25, { late: { meta: true }, keys: ["Space"], during: () => shot(t, "moving-space-keep-mid") });
  await t.flush();
  t.eq(t.parentOf("r_free"), "lay_nest", "Space: the layer did not nest into the frame it was dropped on");
  t.ok(t.node("r_free")!.x !== 300, "the layer moved");
  t.eq(await t.ev("document.getElementById('view').classList.contains('hand')"), false, "no hand mode after the drop");
  await t.undo();
  t.eq(pos(t.node("r_free")), { x: 300, y: 300 }, "one undo puts it back");
  // 2. A layer in a nested frame dragged out onto the board: with Space it stays in its frame. Every frame of the
  //    drag draws only the layer at the pointer (qa/frames.ts).
  const b = await t.rect("lay_nest");
  const problems: string[] = [];
  // Object snapping off for the frame check: a snapped layer is a few px off the pointer on purpose.
  await t.ev(`window.canvasCmd({ cmd: "snap", objects: false })`);
  const res = await checkDragFrames(pageDriver(t), { id: "r_inner", to: { x: b.x + 420, y: b.y + 330 }, areas: ["r_inner"], kids: ["fr_inner", "r_free", "g_pair"], keys: ["Space"], evidence: path.join(FRAMES, "space") });
  await t.ev(`window.canvasCmd({ cmd: "snap", objects: true })`);
  problems.push(...res.problems);
  await t.flush();
  t.eq(t.parentOf("r_inner"), "fr_inner", "Space: the layer stayed in its frame when dropped outside it");
  await t.undo();
  // 3. Several layers at once.
  await t.select(["r_free", "g_pair"]);
  c = await t.center("r_free");
  await t.io.drag(c.x, c.y, f.x + f.w - 30, f.y + f.h - 20, { late: { meta: true }, keys: ["Space"] });
  await t.flush();
  t.eq([t.parentOf("r_free"), t.parentOf("g_pair")], ["lay_nest", "lay_nest"], "Space: several layers keep their parent");
  await t.undo();
  // 4. A board dropped inside another board stays a board.
  await t.focus("lay_nest", 0.5);
  const cap = await t.rect("lay_nest");
  const other = await t.rect("lay_auto");
  await t.select(["lay_nest"]);
  await t.io.drag(cap.x + 80, cap.y - 8, other.x + other.w / 2, other.y + other.h / 2, { keys: ["Space"] });
  await t.flush();
  t.eq(t.parentOf("lay_nest"), null, "Space: a board dropped on another stays a board");
  await t.undo();
  // 5. A flow child dragged out of its auto layout frame: with Space it stays in the frame (in a slot there).
  await t.focus("lay_auto");
  const row = await t.rect("al_row");
  await t.select(["al_a"]);
  c = await t.center("al_a");
  await t.io.drag(c.x, c.y, row.x + row.w - 20, row.y + row.h + 160, { keys: ["Space"], during: () => shot(t, "moving-space-keep-autolayout-mid") });
  await t.flush();
  t.eq(t.parentOf("al_a"), "al_row", "Space: the flow child stayed in its auto layout frame");
  t.eq(t.node("al_row")!.children!.map((k: any) => k.id), ["al_b", "al_c", "al_a"], "it moved to the slot nearest the pointer");
  await t.undo();
  const r2 = await checkDragFrames(pageDriver(t), { id: "al_b", to: { x: row.x + 30, y: row.y + row.h + 120 }, areas: ["al_row"], kids: ["al_a", "al_c"], keys: ["Space"], evidence: path.join(FRAMES, "space") });
  problems.push(...r2.problems);
  await t.flush();
  t.eq(t.parentOf("al_b"), "al_row", "Space: the second flow child stayed too");
  // 6. Space with nothing being dragged: the hand pans, as before.
  await t.clearSel();
  const cam0 = await t.ev<{ x: number; y: number }>("({ x: window.canvasHost.cam.x, y: window.canvasHost.cam.y })");
  await t.io.keyDown("Space");
  await t.frames(2);
  t.eq(await t.ev("document.getElementById('view').classList.contains('hand')"), true, "Space alone turns on the hand");
  await t.io.drag(row.x + 300, row.y + 300, row.x + 360, row.y + 340, { steps: 6 });
  await t.io.keyUp("Space");
  await t.frames(2);
  const cam1 = await t.ev<{ x: number; y: number }>("({ x: window.canvasHost.cam.x, y: window.canvasHost.cam.y })");
  t.near(cam1.x - cam0.x, 60, 2, "the hand drag panned the view");
  t.ok(!problems.length, problems.join("\n  "));
  await sleep(10);
});

// ---------------------------------------------------------------- modifier keys

sc("move", "Control turns snapping off for a move and a resize; Cmd does not", { covers: ["snapping:one", "snapping:mouse", "snapping:ctrl", "resize:rectangle"] }, async (t: T) => {
  await t.focus("lay_nest");
  // r_free's left edge 3 px from the group's left (290): a plain drag snaps there, Control does not; Cmd snaps like a plain drag.
  for (const [late, want] of [[{}, 290], [{ ctrl: true }, 293], [{ meta: true }, 290]] as const) {
    await t.select(["r_free"]);
    const c = await t.center("r_free");
    // Mid-drag: the snap guide shows on a plain drag, none with Control.
    const mid = late === undefined ? undefined : "ctrl" in late ? "moving-snap-ctrl-mid" : "meta" in late ? undefined : "moving-snap-guides-mid";
    await t.io.drag(c.x, c.y, c.x - 7, c.y, { late, steps: 8, during: mid ? () => shot(t, mid) : undefined });
    await t.flush();
    t.eq(pos(t.node("r_free")), { x: want, y: 300 }, `drag with ${JSON.stringify(late)}`);
    await t.undo();
  }
  // Resize: the right edge (370) dragged to 360, 2 px from the group's centre line (358): width 58 with snapping, 60 without.
  for (const [late, want] of [[{}, 58], [{ ctrl: true }, 60]] as const) {
    await t.select(["r_free"]);
    const r = await t.rect("r_free");
    await t.io.drag(r.x + r.w, r.y + r.h / 2, r.x + r.w - 10, r.y + r.h / 2, { late, steps: 8 });
    await t.flush();
    t.eq(t.node("r_free")!.width, want, `resize with ${JSON.stringify(late)}`);
    await t.undo();
  }
});

/** The selected auto layout frame's handle bar of `kind` (and side), in client px. */
async function handleBar(t: T, kind: "pad" | "gap", side?: number) {
  const as = await t.waitFor<any[]>(`(() => { const a = window.canvasHost.autolayout.spacingAreas(); return a.length ? a : null; })()`, "the spacing handles");
  const a = as.find((x) => x.kind === kind && (side === undefined || x.side === side));
  t.ok(a, `no ${kind} handle ${side ?? ""}`);
  const vb = await t.ev<{ l: number; t: number }>("window.canvasHost.viewBox");
  return { x: vb.l + a.bar.x + a.bar.w / 2, y: vb.t + a.bar.y + a.bar.h / 2, rect: { x: vb.l + a.rect.x, y: vb.t + a.rect.y, w: a.rect.w, h: a.rect.h } };
}

sc("autolayout", "padding handles take modifier keys: Option opposite, Option+Shift all four, Shift big steps; Option+click a padding area", { covers: ["autolayout-handles:frame", "autolayout-handles:mouse", "autolayout-handles:alt", "autolayout-handles:alt-shift", "autolayout-handles:shift", "autolayout-handles:click-area"] }, async (t: T) => {
  await t.focus("lay_auto");
  const pad = () => t.node("al_row")!.padding;
  const drag = async (mods: object, dx: number, mid?: string) => {
    await t.select(["al_row"]);
    const b = await handleBar(t, "pad", 3);
    await t.io.move(b.x, b.y);
    await t.frames(2);
    await t.io.drag(b.x, b.y, b.x + dx, b.y, { mods, steps: 8, during: mid ? () => shot(t, mid) : undefined });
    await t.flush();
  };
  // Shift alone: the left side only, in big-nudge steps (10): 16 + 7 lands on 20.
  await drag({ shift: true }, 7);
  t.eq(pad(), [16, 16, 16, 20], "Shift: big-nudge steps on the left only");
  await t.undo();
  // Option: left and right.
  await drag({ alt: true }, 7);
  t.eq(pad(), [16, 23], "Option: the opposite side too");
  await t.undo();
  // Option+Shift: all four.
  await drag({ alt: true, shift: true }, 7, "moving-padding-all-mid");
  t.eq(pad(), 23, "Option+Shift: all four sides");
  await t.undo();
  t.eq(pad(), 16, "one undo each");
  // Option+click in the top padding area (not on its bar): a field for top and bottom.
  await t.select(["al_row"]);
  const top = await handleBar(t, "pad", 0);
  await t.io.click(top.rect.x + 6, top.rect.y + top.rect.h / 2, { alt: true });
  await t.waitFor("document.activeElement && document.activeElement.getAttribute('aria-label') === 'Padding'", "the padding field");
  await shot(t, "moving-padding-click-area");
  await t.io.key("a", { meta: true });
  await t.io.type("24");
  await t.io.key("Enter");
  await t.flush();
  t.eq(pad(), [24, 16], "Option+click a padding area: top and bottom");
  await t.undo();
  // Option+Shift+click: all four.
  await t.select(["al_row"]);
  await t.io.click(top.rect.x + 6, top.rect.y + top.rect.h / 2, { alt: true, shift: true });
  await t.waitFor("document.activeElement && document.activeElement.getAttribute('aria-label') === 'Padding'", "the padding field");
  await t.io.key("a", { meta: true });
  await t.io.type("6");
  await t.io.key("Enter");
  await t.flush();
  t.eq(pad(), 6, "Option+Shift+click a padding area: all four");
  // The frame did not move or copy on those clicks.
  t.eq(t.node("lay_auto")!.children!.filter((c: any) => c.name === "Row (hug)").length, 1, "no copy of the frame");
});

// ---------------------------------------------------------------- smart selection

const sq = (id: string, x: number, y: number, fill: string, w = 60, h = 60) => ({ type: "rectangle", id, name: id, x, y, width: w, height: h, cornerRadius: 8, fill });
/**
 * A board for smart selection at world (0, 1200) on the Style page: a row of four (sm_a..sm_d, 20 apart), a grid of
 * two rows (sg_*, 16 apart, rows 24 apart) and three loose layers to tidy (st_*).
 */
function smartBoard(): Record<string, unknown> {
  const fills = ["#F43F5E", "#F59E0B", "#22C55E", "#3B82F6"];
  return {
    type: "frame", id: "qa_smart", name: "Smart selection", x: 0, y: 1200, width: 720, height: 420, fill: "#FFFFFF", cornerRadius: 12, clip: true, layout: "none",
    children: [
      ...["a", "b", "c", "d"].map((k, i) => sq(`sm_${k}`, 40 + i * 80, 40, fills[i])),
      ...[0, 1, 2].map((i) => sq(`sg_0${i}`, 40 + i * 56, 160, fills[i], 40, 40)),
      ...[0, 1].map((i) => sq(`sg_1${i}`, 40 + i * 56, 224, fills[i + 2], 40, 40)),
      sq("st_0", 400, 170, "#6366F1", 50, 50), sq("st_1", 463, 160, "#A855F7", 50, 50), sq("st_2", 540, 182, "#EC4899", 50, 50),
    ],
  };
}
const xs = (t: T, ids: string[]) => ids.map((id) => t.node(id)!.x);
/** A smart selection's ring or handle on screen, in client px. */
async function smartPoint(t: T, what: "knob" | "gap" | "cross", id?: string) {
  const vb = await t.ev<{ l: number; t: number }>("window.canvasHost.viewBox");
  if (what === "knob") {
    const k = await t.waitFor<any>(`(() => { const s = window.canvasHost.smart; return s && s.knobs().find((k) => k.id === ${JSON.stringify(id)}); })()`, `the ring on ${id}`);
    return { x: vb.l + k.x, y: vb.t + k.y };
  }
  const h = await t.waitFor<any>(`(() => { const s = window.canvasHost.smart; return s && s.handles().find((h) => h.kind === ${JSON.stringify(what)}); })()`, `a ${what} handle`);
  return { x: vb.l + h.bar.x + h.bar.w / 2, y: vb.t + h.bar.y + h.bar.h / 2 };
}

sc("arrange", "smart selection: spacing handles, rings to reorder and swap, marks, Cmd+D and Delete, spacing fields, tidy up", { covers: ["smart-selection:many", "smart-selection:mouse", "smart-selection:keyboard", "smart-selection:spacing", "smart-selection:reorder", "smart-selection:swap", "smart-selection:mark", "smart-selection:duplicate", "smart-selection:delete", "smart-selection:grid", "tidy-up:many", "tidy-up:keyboard"] }, async (t: T) => {
  await t.showPage("style");
  await t.a.post("/api/structure", { file: t.file, op: "add", nodes: [smartBoard()], place: { parent: null }, page: "style" });
  await t.waitFor("!!window.canvasHost.boards.get('qa_smart')", "the smart selection board");
  await t.focus("qa_smart");
  await t.settle();
  const row = ["sm_a", "sm_b", "sm_c", "sm_d"];
  const select = async (ids: string[]) => { await t.select(ids); await t.waitFor(`(() => { const s = window.canvasHost.smart.state; return s && s.lines.flat().length === ${ids.length}; })()`, "the smart selection"); };
  await select(row);
  t.eq(await t.ev("window.canvasHost.smart.state"), { kind: "1d", axis: "x", lines: [row], gap: 20, crossGap: null, marked: [] }, "an evenly spaced row is a smart selection");
  // 1. The gap handle: every gap follows, Shift in big-nudge steps.
  const u = await t.rect("sm_a");
  await t.io.move(u.x + 10, u.y + 10);
  await t.frames(2);
  let g = await smartPoint(t, "gap");
  await shot(t, "moving-smart-handles");
  await t.io.drag(g.x, g.y, g.x + 12, g.y, { steps: 8, during: () => shot(t, "moving-smart-spacing-mid") });
  await t.flush();
  t.eq(xs(t, row), [40, 132, 224, 316], "a gap handle dragged 12 px: every gap is 32");
  await t.undo();
  t.eq(xs(t, row), [40, 120, 200, 280], "one undo");
  await select(row);
  g = await smartPoint(t, "gap");
  await t.io.drag(g.x, g.y, g.x + 7, g.y, { mods: { shift: true }, steps: 8 });
  await t.flush();
  t.eq(xs(t, row), [40, 130, 220, 310], "Shift: big-nudge steps (30)");
  await t.undo();
  // 2. A ring dragged to another slot: a blue line shows it, the rest close up on the drop. Every frame is clean.
  await select(row);
  const problems: string[] = [];
  const c = await t.rect("sm_c");
  await t.ev(`window.canvasCmd({ cmd: "snap", objects: false })`);
  const res = await checkDragFrames(pageDriver(t), { id: "sm_a", select: row, to: { x: c.x + c.w + 6, y: c.y + c.h / 2 }, areas: row, kids: ["sm_b", "sm_c", "sm_d"], evidence: path.join(FRAMES, "smart") });
  problems.push(...res.problems);
  await t.ev(`window.canvasCmd({ cmd: "snap", objects: true })`);
  await t.flush();
  t.eq(xs(t, ["sm_b", "sm_c", "sm_a", "sm_d"]), [40, 120, 200, 280], "the ring took sm_a between sm_c and sm_d");
  t.eq(t.node("qa_smart")!.children!.slice(0, 4).map((n: any) => n.id), row, "the layers panel keeps its order");
  await t.undo();
  // The mid-drag picture: the blue line where it goes.
  await select(row);
  let k = await smartPoint(t, "knob", "sm_a");
  await t.io.drag(k.x, k.y, c.x + c.w + 6, c.y + c.h / 2, { steps: 10, during: () => shot(t, "moving-smart-reorder-mid") });
  await t.flush();
  await t.undo();
  // 3. Cmd while dragging a ring swaps.
  await select(row);
  k = await smartPoint(t, "knob", "sm_b");
  const d = await t.rect("sm_d");
  await t.io.drag(k.x, k.y, d.x + d.w / 2, d.y + d.h / 2, { late: { meta: true }, steps: 10, during: () => shot(t, "moving-smart-swap-mid") });
  await t.flush();
  t.eq(xs(t, ["sm_a", "sm_d", "sm_c", "sm_b"]), [40, 120, 200, 280], "Cmd: sm_b and sm_d swapped");
  await t.undo();
  // 4. Marks: a click marks, Shift+click marks more; Cmd+D copies after each, one undo; Delete closes up.
  await select(row);
  await t.io.click((await smartPoint(t, "knob", "sm_a")).x, (await smartPoint(t, "knob", "sm_a")).y);
  const kc = await smartPoint(t, "knob", "sm_c");
  await t.io.click(kc.x, kc.y, { shift: true });
  t.eq((await t.ev<any>("window.canvasHost.smart.state")).marked.sort(), ["sm_a", "sm_c"], "two marked");
  await shot(t, "moving-smart-marked");
  await t.io.key("d", { meta: true });
  await t.flush();
  await t.waitFor("window.canvasHost.selection().length === 6", "the copies in the selection");
  const kids = t.node("qa_smart")!.children!.filter((n: any) => n.y === 40).sort((p: any, q: any) => p.x - q.x).map((n: any) => (row.includes(n.id) ? n.id : "copy"));
  t.eq(kids, ["sm_a", "copy", "sm_b", "sm_c", "copy", "sm_d"], "Cmd+D: each copy after its original, the row re-spaced");
  t.eq(t.node("sm_d")!.x, 440, "the last layer moved along");
  await t.undo();
  t.eq(t.node("qa_smart")!.children!.length, (smartBoard().children as unknown[]).length, "one undo takes the copies away");
  t.eq(xs(t, row), [40, 120, 200, 280], "and the row back");
  await select(row);
  const kb = await smartPoint(t, "knob", "sm_b");
  await t.io.click(kb.x, kb.y);
  await t.io.key("Backspace");
  await t.flush();
  t.eq(t.node("sm_b"), null, "Delete removed the marked layer");
  t.eq(xs(t, ["sm_a", "sm_c", "sm_d"]), [40, 120, 200], "the rest closed up");
  await t.undo();
  t.eq(xs(t, row), [40, 120, 200, 280], "one undo");
  // 5. Double-click a ring marks every layer.
  await select(row);
  const ka = await smartPoint(t, "knob", "sm_a");
  await t.io.dblclick(ka.x, ka.y);
  t.eq((await t.ev<any>("window.canvasHost.smart.state")).marked.length, 4, "a double-click marks all");
  // 6. The inspector's Spacing field (the shell sends smartGap).
  await t.ev(`window.canvasCmd({ cmd: "smartGap", x: 8 })`);
  await t.flush();
  t.eq(xs(t, row), [40, 108, 176, 244], "space between 8");
  await t.undo();
  // 7. 2D: the handle between rows.
  const grid = ["sg_00", "sg_01", "sg_02", "sg_10", "sg_11"];
  await select(grid);
  t.eq(await t.ev("(() => { const s = window.canvasHost.smart.state; return [s.kind, s.gap, s.crossGap]; })()"), ["2d", 16, 24], "a grid");
  const gr = await t.rect("sg_00");
  await t.io.move(gr.x + 5, gr.y + 5);
  await t.frames(2);
  const cr = await smartPoint(t, "cross");
  await t.io.drag(cr.x, cr.y, cr.x, cr.y - 14, { steps: 6 });
  await t.flush();
  t.eq([t.node("sg_10")!.y, t.node("sg_11")!.y, t.node("sg_00")!.y], [210, 210, 160], "rows 10 apart");
  await t.undo();
  // 8. Tidy up: Control+Option+T.
  await t.select(["st_0", "st_1", "st_2"]);
  await t.io.key("t", { ctrl: true, alt: true });
  await t.flush();
  t.eq(["st_0", "st_1", "st_2"].map((id) => pos(t.node(id))), [{ x: 400, y: 160 }, { x: 470, y: 160 }, { x: 540, y: 160 }], "an evenly spaced row from the top-left");
  await t.select(["st_0", "st_1", "st_2"]);
  await t.waitFor("!!window.canvasHost.smart.state", "a smart selection after tidying");
  await shot(t, "moving-tidy-after");
  await t.undo();
  t.eq(pos(t.node("st_1")), { x: 463, y: 160 }, "one undo");
  t.ok(!problems.length, problems.join("\n  "));
});

// Codex review c3 (docs/evidence/review-fixes.md): the duplicate or delete that starts Cmd+D / Delete on marked
// layers was not a tracked write, so an Undo pressed while its answer was on the way ran first and the move after it
// shifted the row (and cleared Redo). Fault injection: the page's structure answer is held 700 ms.
sc("arrange", "smart selection: Undo pressed while Cmd+D or Delete on marked layers is on its way waits for the whole step", { covers: ["smart-selection:duplicate", "smart-selection:delete", "smart-selection:keyboard"] }, async (t: T) => {
  await t.showPage("style");
  await t.a.post("/api/structure", { file: t.file, op: "add", nodes: [smartBoard()], place: { parent: null }, page: "style" });
  await t.waitFor("!!window.canvasHost.boards.get('qa_smart')", "the smart selection board");
  await t.focus("qa_smart");
  await t.settle();
  const row = ["sm_a", "sm_b", "sm_c", "sm_d"];
  const kids = () => t.node("qa_smart")!.children!.length;
  const n0 = kids();
  const holdNext = (op: string) => t.ev(`(() => { const f = window.fetch; window.__qaHeld = 0; window.fetch = function (input, init) { const p = f.apply(this, arguments); const b = init && typeof init.body === "string" ? init.body : ""; if (String(input).includes("/api/structure") && b.includes('"op":"${op}"') && !window.__qaHeld++) { window.fetch = f; return p.then((r) => new Promise((res) => setTimeout(() => res(r), 700))); } return p; }; return true; })()`);
  for (const [op, key] of [["duplicate", ["d", { meta: true }]], ["delete", ["Backspace", {}]]] as const) {
    await t.select(row);
    await t.waitFor(`(() => { const s = window.canvasHost.smart.state; return s && s.lines.flat().length === 4; })()`, "the smart selection");
    const k = await smartPoint(t, "knob", "sm_b");
    await t.io.click(k.x, k.y);
    t.eq((await t.ev<any>("window.canvasHost.smart.state")).marked, ["sm_b"], "sm_b marked");
    await holdNext(op);
    await t.io.key(key[0], key[1]);
    await t.waitFor("window.__qaHeld === 1", `the ${op} request out`);
    // Undo while the answer is held.
    await t.io.key("z", { meta: true });
    await t.ev("new Promise((r) => setTimeout(r, 1500))");
    await t.flush();
    t.eq(kids(), n0, `${op}: one undo takes the whole step back`);
    t.eq(xs(t, row), [40, 120, 200, 280], `${op}: the row is where it was`);
    await t.io.key("z", { meta: true, shift: true });
    await t.waitHistory();
    t.eq(kids(), op === "duplicate" ? n0 + 1 : n0 - 1, `${op}: redo brings it back (Redo was not cleared)`);
    await t.undo();
  }
});

sc("arrange", "Shift on an align item aligns several layers to their parent; Control+Shift+A suggests auto layout from the spacing", { covers: ["align-distribute:many", "align-distribute:in-frame", "align-distribute:parent", "autolayout-toggle:frame", "autolayout-toggle:keyboard", "autolayout-toggle:suggest"] }, async (t: T) => {
  await t.focus("lay_auto");
  // fp_a (20, 20) and fp_b (100, 40), 50 wide, in the Plain frame: as a group to the frame's left edge.
  await t.select(["fp_a", "fp_b"]);
  await t.ev(`window.canvasCmd({ cmd: "shortcut", op: "align-left:parent" })`);
  await t.flush();
  t.eq([t.node("fp_a")!.x, t.node("fp_b")!.x], [0, 80], "aligned to the parent's left as a group");
  await shot(t, "moving-align-parent");
  await t.undo();
  await t.ev(`window.canvasCmd({ cmd: "shortcut", op: "align-bottom:parent" })`);
  await t.flush();
  t.eq([t.node("fp_a")!.y, t.node("fp_b")!.y], [80, 100], "to the parent's bottom (150 high)");
  await t.undo();
  // Without Shift: in their own box, as before.
  await t.ev(`window.canvasCmd({ cmd: "shortcut", op: "align-left" })`);
  await t.flush();
  t.eq([t.node("fp_a")!.x, t.node("fp_b")!.x], [20, 20], "aligned in their own box");
  await t.undo();
  // Control+Shift+A on two frames: each gets auto layout from its own children, the gap they had.
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "layout", place: { parent: "lay_auto" }, nodes: [
    { type: "frame", id: "sx_row", name: "Spaced row", x: 300, y: 350, width: 200, height: 60, fill: "#E0F2FE", layout: "none", children: [0, 1, 2].map((i) => sq(`sx_r${i}`, 10 + i * 54, 10, "#0EA5E9", 40, 40)) },
    { type: "frame", id: "sx_col", name: "Spaced column", x: 40, y: 330, width: 60, height: 120, fill: "#FCE7F3", layout: "none", children: [0, 1].map((i) => sq(`sx_c${i}`, 10, 10 + i * 49, "#EC4899", 40, 40)) },
  ] });
  await t.waitFor("!!window.canvasHost.worldRectOf('sx_r2') && !!window.canvasHost.worldRectOf('sx_c1')", "the spaced frames");
  await t.settle();
  await t.select(["sx_row", "sx_col"]);
  await t.io.key("a", { ctrl: true, shift: true });
  await t.flush();
  const row = t.node("sx_row")!, col = t.node("sx_col")!;
  t.eq([row.layout, row.gap, col.layout, col.gap], ["horizontal", 14, "vertical", 9], "each frame took its own direction and gap");
  t.eq(t.parentOf("sx_r0"), "sx_row", "no new frame around them");
  await sleep(300);
  await evidenceFit(t, "moving-suggest-autolayout", ["sx_row", "sx_col"]);
  await t.undo();
  t.eq([t.node("sx_row")!.layout, t.node("sx_col")!.layout], ["none", "none"], "one undo for both");
});

sc("resize", "Option+R shows the rotation origin; dragged to a corner, the layer turns round it", { covers: ["rotate:rectangle", "rotate:mouse", "rotate:keyboard", "rotate:origin"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["r_free"]);
  await t.waitFor("window.canvasHost.moveInfo && window.canvasHost.moveInfo('r_free')", "the layer's move info");
  const vb = await t.ev<{ l: number; t: number }>("window.canvasHost.viewBox");
  const scr = async (w: { x: number; y: number }) => { const c = await t.ev<{ x: number; y: number; z: number }>("window.canvasHost.cam"); return { x: vb.l + w.x * c.z + c.x, y: vb.t + w.y * c.z + c.y }; };
  await t.io.key("r", { alt: true });
  t.eq(await t.ev("window.canvasHost.rotate.origin"), { id: "r_free", x: 335, y: 325 }, "Option+R: the origin at the centre");
  // Drag it near the top-left corner: it snaps there.
  const o = await scr({ x: 335, y: 325 }), corner = await scr({ x: 302, y: 303 });
  await t.io.drag(o.x, o.y, corner.x, corner.y, { steps: 6 });
  t.eq(await t.ev("window.canvasHost.rotate.origin"), { id: "r_free", x: 300, y: 300 }, "the origin snapped to the corner");
  await shot(t, "moving-rotation-origin");
  // Turn it 90 degrees clockwise (Shift: 15 degree steps) from just outside its bottom-right corner, round the origin.
  const a = await scr({ x: 377, y: 357 }), b = await scr({ x: 242, y: 378 });
  await t.io.drag(a.x, a.y, b.x, b.y, { mods: { shift: true }, steps: 16, during: () => shot(t, "moving-rotation-origin-mid") });
  await t.flush();
  t.eq(t.node("r_free")!.rotation, -90, "turned 90 degrees clockwise");
  const r = await t.ev<{ x: number; y: number; w: number; h: number }>("window.canvasHost.worldRectOf('r_free')");
  t.near(r.x, 250, 0.6, "round the corner: left"); t.near(r.y, 300, 0.6, "top"); t.near(r.w, 50, 0.6, "width"); t.near(r.h, 70, 0.6, "height");
  t.eq(await t.ev("window.canvasHost.rotate.origin"), { id: "r_free", x: 300, y: 300 }, "the origin stays put");
  await t.undo();
  t.eq(pos(t.node("r_free")), { x: 300, y: 300 }, "one undo");
  // Option+R again: the origin goes, turns are about the centre again.
  await t.io.key("r", { alt: true });
  t.eq(await t.ev("window.canvasHost.rotate.origin"), null, "Option+R hides it");
});

/** A picture for the evidence: the view fitted to `ids`, selected. */
async function evidenceFit(t: T, name: string, ids: string[]) {
  await t.select(ids);
  await t.ev(`window.canvasCmd({ cmd: "fit" })`);
  await t.settle();
  await sleep(300);
  await shot(t, name);
}


// ---------------------------------------------------------------- a picture inside a frame while it moves

sc("move", "a phone frame whose screen is a big image keeps the picture while it is dragged", { covers: ["move:frame", "move:mouse", "render:image"] }, async (t: T) => {
  // A store screenshot: a dark phone frame on a free-placing board, its screen a rectangle with a large image fill
  // (bigger than the screen, so the engine keeps a scaled level of it).
  fs.mkdirSync(path.join(t.file, "media"), { recursive: true });
  fs.writeFileSync(path.join(t.file, "media", "qa-screen.png"), gradientPng(1320, 2868));
  await t.showPage("style");
  await t.a.post("/api/structure", { file: t.file, op: "add", page: "style", place: { parent: null }, nodes: [{
    type: "frame", id: "qa_store", name: "Store screenshot", x: 6000, y: 0, width: 1320, height: 2868, fill: "#F4EFE8", layout: "none", clip: true,
    children: [{ type: "frame", id: "qa_phone", name: "Phone", x: 136, y: 500, width: 1048, height: 2221, fill: "#0B0B0C", cornerRadius: 150, layout: "none", clip: true,
      children: [{ type: "rectangle", id: "qa_screen", name: "Screen", x: 24, y: 24, width: 1000, height: 2173, cornerRadius: 128, fill: { type: "image", url: "media/qa-screen.png", mode: "fill" } }] }],
  }] });
  await t.waitFor("!!window.canvasHost.boards.get('qa_store')", "the store board");
  await t.focus("qa_store", 0.2);
  await t.settle();
  const s = await t.rect("qa_screen");
  const inner = { x: s.x + s.w * 0.3, y: s.y + s.h * 0.3, w: s.w * 0.4, h: s.h * 0.4 };
  const dark = (c: number[]) => c[0] + c[1] + c[2] < 90;
  const before = await meanRgb(t, inner);
  t.ok(!dark(before), `the screen draws its picture before the drag (mean ${before})`);
  await t.select(["qa_phone"]);
  const c = await t.center("qa_phone");
  const seen: number[][] = [];
  await t.io.drag(c.x, c.y, c.x + 60, c.y + 20, { steps: 10, during: async () => {
    await t.frames(2);
    const r = await t.rect("qa_screen");
    seen.push(await meanRgb(t, { x: r.x + r.w * 0.3, y: r.y + r.h * 0.3, w: r.w * 0.4, h: r.h * 0.4 }));
    await shot(t, "moving-phone-image-middrag");
  } });
  t.ok(seen.length && !seen.some(dark), `the screen went dark while the phone moved (mean ${JSON.stringify(seen)})`);
  await t.flush();
  // After the drop, every frame: no dark frame while the board takes the layers back.
  const after: number[][] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    const r2 = await t.rect("qa_screen");
    after.push(await meanRgb(t, { x: r2.x + r2.w * 0.3, y: r2.y + r2.h * 0.3, w: r2.w * 0.4, h: r2.h * 0.4 }));
    await t.frames(1);
  }
  t.ok(!after.some(dark), `the screen went dark after the drop (${after.map((c) => (dark(c) ? "dark" : "ok")).join(" ")})`);
  t.subject = ["qa_store"];
});

/** Mean RGB of a window rect, from a screenshot. */
async function meanRgb(t: T, r: { x: number; y: number; w: number; h: number }) {
  const img = decodePng(await t.shot({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.w)), height: Math.max(1, Math.round(r.h)) }));
  const s = [0, 0, 0];
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) s[k] += img.data[i * 4 + k];
  return s.map((v) => Math.round(v / n));
}
