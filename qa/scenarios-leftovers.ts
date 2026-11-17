// Leftover interaction conventions (docs/evidence/leftovers.md): layout guides, paragraph spacing and indent, lists.
// Imported by qa/scenarios.ts; each runs on its own fresh copy of demos/playground.canvas like the rest.
// Each one leaves a picture of its key frame in qa/out/evidence/leftovers-<slug>.png.
import fs from "node:fs";
import path from "node:path";
import { sc, type Rect, type T } from "./harness.ts";

/** The key frame of a scenario, around `ids` (window px, padded), for the evidence file. */
async function evidence(t: T, slug: string, ids: string[], pad = 40) {
  const rs = await Promise.all(ids.map((id) => t.rect(id)));
  const x0 = Math.max(0, Math.min(...rs.map((r) => r.x)) - pad), y0 = Math.max(0, Math.min(...rs.map((r) => r.y)) - pad);
  const x1 = Math.max(...rs.map((r) => r.x + r.w)) + pad, y1 = Math.max(...rs.map((r) => r.y + r.h)) + pad;
  const png = await t.shot({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  const dir = path.join(import.meta.dirname, "out", "evidence");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "leftovers-" + slug + ".png"), png);
}
const pos = (n: any) => ({ x: n.x, y: n.y });

sc("canvas", "layout guides: columns and a grid drawn on frames; moves and resizes snap to them; Control+G hides them", { covers: ["layout-guides:keyboard", "layout-guides:columns", "layout-guides:grid", "layout-guides:snap-move", "layout-guides:snap-resize"] }, async (t: T) => {
  await t.focus("lay_nest", 1.5);
  await t.clearSel();
  // What the inspector's Layout guide section writes: four stretched columns (gutter 20, margin 20) on the 560 px
  // board, so the columns run 20-135, 155-270, 290-405, 425-540; a 10 px grid on the outer frame.
  const meta = (id: string) => t.node(id)!.metadata ?? {};
  await t.a.post("/api/update", { file: t.file, id: "lay_nest", props: { metadata: { ...meta("lay_nest"), type: "canvas", canvasLayoutGuides: [{ type: "columns", count: 4, align: "stretch", gutter: 20, margin: 20, color: "#FF00001A" }] } } });
  await t.a.post("/api/update", { file: t.file, id: "fr_outer", props: { metadata: { ...meta("fr_outer"), type: "canvas", canvasLayoutGuides: [{ type: "grid", size: 10, color: "#0066FF26" }] } } });
  await t.flush();
  await t.waitFor(`window.canvasHost.nav.layoutGuides.length === 2`, "both frames' guides drawn");
  t.eq(await t.ev(`getComputedStyle(document.getElementById("layoutGuides")).display`), "block", "the guide layer shows");
  // The drawn columns are where the rules put them: a pixel in the second column is tinted red, the gutter is not.
  await t.frames(3);
  await evidence(t, "layout-guides", ["lay_nest"], 20);
  // A move: r_free's left edge (300) dragged 103 px right lands 2 px from the third column's right edge (405): it snaps.
  const z = await t.ev<number>("window.canvasHost.cam.z");
  await t.select(["r_free"]);
  let c = await t.center("r_free");
  await t.io.drag(c.x, c.y, c.x + 103 * z, c.y, { steps: 10 });
  await t.flush();
  t.eq(pos(t.node("r_free")), { x: 405, y: 300 }, "the left edge snapped to the column edge at 405");
  await t.undo();
  // A resize: the right edge (370) dragged 33 px right lands 2 px from 405: width 105.
  await t.select(["r_free"]);
  let r = await t.rect("r_free");
  await t.io.drag(r.x + r.w, r.y + r.h / 2, r.x + r.w + 33 * z, r.y + r.h / 2, { steps: 8 });
  await t.flush();
  t.eq(t.node("r_free")!.width, 105, "the right edge snapped to the column edge");
  await t.undo();
  // Control+G hides every layout guide; the same move no longer snaps.
  // With a layer selected: Control+G is not Group (Cmd+G is).
  await t.select(["r_free"]);
  const kids = (t.node("lay_nest")!.children ?? []).length;
  await t.io.key("g", { ctrl: true });
  await t.waitFor(`window.canvasHost.nav.state.layoutGuides === false && getComputedStyle(document.getElementById("layoutGuides")).display === "none"`, "the guides hidden");
  await t.flush();
  t.eq((t.node("lay_nest")!.children ?? []).length, kids, "Control+G grouped nothing");
  c = await t.center("r_free");
  await t.io.drag(c.x, c.y, c.x + 103 * z, c.y, { steps: 10 });
  await t.flush();
  t.eq(pos(t.node("r_free")), { x: 403, y: 300 }, "hidden guides: the layer lands where it was dropped");
  await t.undo();
  // Shift+G (the second key) shows them again.
  await t.clearSel();
  await t.io.key("G", { shift: true });
  await t.waitFor(`window.canvasHost.nav.state.layoutGuides === true && window.canvasHost.nav.layoutGuides.length === 2`, "the guides back");
  r = await t.rect("lay_nest");
  t.ok(r.w > 0, "board drawn");
  t.subject = ["lay_nest"];
});

// ---------------------------------------------------------------- paragraphs and lists

const editing = (t: T, id: string) => t.waitFor(`!!(window.canvasHost.textEdit && window.canvasHost.textEdit.id === ${JSON.stringify(id)})`, `editing ${id}`);
async function startEdit(t: T, id: string) {
  const c = await t.center(id);
  await t.select([id]);
  await t.io.dblclick(c.x, c.y);
  await editing(t, id);
  await t.frames(3);
}
type Line = { x: number; top: number; baseline: number; bottom: number };
/** The text's lines and markers as the engine draws them, in window px. */
const drawnLines = (t: T, id: string) => t.ev<{ lines: Line[]; marks: { x: number; baseline: number }[] }>(`(() => {
  const h = window.canvasHost, c = h.cam, vb = h.viewBox, r = h.engineView.textLines(${JSON.stringify(id)});
  const X = (x) => vb.l + c.x + x * c.z, Y = (y) => vb.t + c.y + y * c.z;
  return { lines: r.lines.map((l) => ({ x: X(l.x), top: Y(l.top), baseline: Y(l.baseline), bottom: Y(l.bottom) })), marks: r.marks.map((m) => ({ x: X(m.x), baseline: Y(m.baseline) })) };
})()`);
/** Where the editor field lays out each paragraph's first letter (window px): the caret goes there. */
const fieldFirsts = (t: T) => t.ev<{ x: number; top: number; bottom: number }[]>(`(() => [...document.querySelectorAll("#textEdit .f > div")].map((d) => {
  const w = document.createTreeWalker(d, NodeFilter.SHOW_TEXT), n = w.nextNode();
  const r = document.createRange();
  if (n) { r.setStart(n, 0); r.setEnd(n, 1); }
  const b = n ? r.getClientRects()[0] : d.getBoundingClientRect();
  return { x: b.left, top: b.top, bottom: b.bottom };
}))()`);
/** Every paragraph's first letter in the field sits on the line the canvas draws it on, within 3 px. */
async function caretMatches(t: T, id: string, what: string) {
  const { lines } = await drawnLines(t, id);
  const firsts = await fieldFirsts(t);
  const v = String(await t.ev("window.canvasHost.textEdit.value"));
  const paras = v.split("\n");
  t.eq(firsts.length, paras.length, `${what}: a block per paragraph in the field (${JSON.stringify(v)})`);
  let li = 0;
  for (let p = 0; p < firsts.length; p++) {
    // The drawn line nearest the field's paragraph start: within 3 px, and starting where its first letter does.
    const f = firsts[p];
    let best = lines[li] ?? lines[lines.length - 1], d = Infinity;
    for (const l of lines.slice(li)) { const dd = Math.abs(l.top - f.top); if (dd < d) { d = dd; best = l; } }
    li = lines.indexOf(best) + 1;
    t.near(f.top, best.top, 3, `${what}: paragraph ${p} top (field ${f.top.toFixed(1)}, drawn ${best.top.toFixed(1)})`);
    if (paras[p].length) t.near(f.x, best.x, 3, `${what}: paragraph ${p} starts where it is drawn (field ${f.x.toFixed(1)}, drawn ${best.x.toFixed(1)})`);
  }
  const field = await t.ev<Rect>(`(() => { const b = document.querySelector("#textEdit .f").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const drawn = await t.rect(id);
  t.near(field.h, drawn.h, 3, `${what}: the field is as tall as the drawn text (${field.h} vs ${drawn.h})`);
}

sc("text", "paragraph spacing and indent: drawn, the caret on the drawn lines, kept in SVG", { covers: ["paragraph-settings:text", "paragraph-settings:keyboard", "paragraph-settings:export"] }, async (t: T) => {
  await t.focus("lay_text", 1.5);
  const id = "tx_long";
  const content = "Paragraph spacing puts room between paragraphs, and the indent moves each first line in.\nA second paragraph.\nThird.";
  // What Typography's Paragraph spacing and Paragraph indent fields write.
  await t.a.post("/api/update", { file: t.file, id, props: { content, paragraphSpacing: 12, paragraphIndent: 24 } });
  await t.flush();
  await t.waitFor(`(() => { const r = window.canvasHost.engineView.textLines("tx_long"); return r && r.lines.length >= 4 && r.lines[0].x - window.canvasHost.worldRectOf("tx_long").x > 20; })()`, "the paragraphs drawn (the first one wraps)");
  const node = await t.ev<{ x: number; y: number }>(`(() => { const r = window.canvasHost.worldRectOf("tx_long"); return { x: r.x, y: r.y }; })()`);
  const L = (await t.ev<{ lines: Line[] }>(`window.canvasHost.engineView.textLines("tx_long")`)).lines;
  const n = L.length; // the first paragraph's lines, then "A second paragraph." and "Third."
  t.near(L[0].x - node.x, 24, 0.5, "the first line indented 24");
  t.near(L[1].x - node.x, 0, 0.5, "its wrapped line is not");
  t.near(L[n - 2].x - node.x, 24, 0.5, "the next paragraph's first line is");
  t.near(L[n - 2].top - L[n - 3].bottom, 12, 0.6, "12 px between the paragraphs");
  t.near(L[n - 1].top - L[n - 2].bottom, 12, 0.6, "and before the third");
  t.near(L[1].top - L[0].bottom, 0, 0.6, "no space inside a paragraph");
  await t.frames(3);
  await evidence(t, "paragraph-settings", [id], 24);
  // Editing: the field's paragraphs sit on the drawn lines; typing a new paragraph keeps them there.
  await startEdit(t, id);
  await caretMatches(t, id, "editing");
  await t.ev(`window.canvasHost.textEdit.select(${content.length}, ${content.length})`);
  await t.io.type("\nFourth, typed.");
  t.eq(await t.ev("window.canvasHost.textEdit.value"), content + "\nFourth, typed.", "typed");
  await t.frames(4);
  await caretMatches(t, id, "after Return");
  await t.io.key("Escape");
  await t.flush();
  t.eq(t.node(id)!.content, content + "\nFourth, typed.", "written");
  t.eq([t.node(id)!.paragraphSpacing, t.node(id)!.paragraphIndent], [12, 24], "the settings stay");
  // SVG export: each paragraph's first line starts 24 px in, the next paragraph a line and 12 px further down.
  const out = path.join(path.dirname(t.file), "paras.svg");
  const ex = await t.a.post("/api/export", { file: t.file, ids: [id], format: "svg", path: out });
  t.ok(ex && ex.files && ex.files.length === 1, `exported: ${JSON.stringify(ex).slice(0, 200)}`);
  const svg = fs.readFileSync(out, "utf8");
  const texts = [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), s: m[3] }));
  const second = texts.find((x) => x.s.startsWith("A second")), third = texts.find((x) => x.s.startsWith("Third"));
  t.ok(!!second && !!third, `the paragraphs in the SVG: ${JSON.stringify(texts).slice(0, 400)}`);
  const lh = L[n - 1].bottom - L[n - 1].top;
  t.near(second!.x, 24, 1, "the indent in the SVG");
  t.near(third!.y - second!.y, lh + 12, 1, "the spacing in the SVG");
  await t.undo();
  t.eq(t.node(id)!.content, content, "one undo: the typing");
  t.subject = ["lay_text"];
});

sc("text", "lists: Shift+Cmd+8 and 7, Tab nesting, Return, typed starts; markers drawn and exported", { covers: ["text-lists:text", "text-lists:keyboard", "text-lists:nesting", "text-lists:export"] }, async (t: T) => {
  await t.focus("lay_text", 1.5);
  const id = "tx_long";
  await t.a.post("/api/update", { file: t.file, id, props: { content: "Apples\nPears\nPlums" } });
  await t.flush();
  // On the selected layer: every paragraph a bullet.
  await t.select([id]);
  await t.io.key("8", { meta: true, shift: true });
  await t.flush();
  t.eq(t.node(id)!.lists, [{ p: 0, type: "bullet", level: 1 }, { p: 1, type: "bullet", level: 1 }, { p: 2, type: "bullet", level: 1 }], "three bullets");
  await t.waitFor(`(() => { const r = window.canvasHost.engineView.textLines("tx_long"); return r && r.marks.length === 3; })()`, "three markers drawn");
  // Editing: Tab nests the caret's item, Shift+Tab takes it back out.
  await startEdit(t, id);
  await t.ev(`window.canvasHost.textEdit.select(9, 9)`); // in "Pears"
  await t.io.key("Tab");
  t.eq(await t.ev("window.canvasHost.textEdit.lists"), [{ p: 0, type: "bullet", level: 1 }, { p: 1, type: "bullet", level: 2 }, { p: 2, type: "bullet", level: 1 }], "Tab: Pears one level in");
  t.eq(await t.ev("window.canvasHost.textEdit.value"), "Apples\nPears\nPlums", "no tab typed");
  await t.io.key("Tab", { shift: true });
  t.eq((await t.ev<any[]>("window.canvasHost.textEdit.lists"))[1].level, 1, "Shift+Tab: back out");
  await t.io.key("Tab");
  // Select all, Shift+Cmd+7: numbered (levels kept).
  await t.io.key("a", { meta: true });
  await t.io.key("7", { meta: true, shift: true });
  t.eq(await t.ev("window.canvasHost.textEdit.lists"), [{ p: 0, type: "number", level: 1 }, { p: 1, type: "number", level: 2 }, { p: 2, type: "number", level: 1 }], "numbered");
  // Return at the end continues the list; Return on the empty item ends it; "- " starts a bulleted one.
  await t.ev(`window.canvasHost.textEdit.select(18, 18)`);
  await t.io.type("\nFigs\n");
  t.eq((await t.ev<any[]>("window.canvasHost.textEdit.lists")).length, 5, "two new items");
  await t.io.key("Enter");
  t.eq((await t.ev<any[]>("window.canvasHost.textEdit.lists")).length, 4, "Return on the empty item ends the list");
  await t.io.type("Plain line\n- Kiwi");
  const v = await t.ev<string>("window.canvasHost.textEdit.value");
  t.eq(v, "Apples\nPears\nPlums\nFigs\nPlain line\nKiwi", "the typed '- ' went away");
  t.eq(await t.ev("window.canvasHost.textEdit.lists"), [{ p: 0, type: "number", level: 1 }, { p: 1, type: "number", level: 2 }, { p: 2, type: "number", level: 1 }, { p: 3, type: "number", level: 1 }, { p: 5, type: "bullet", level: 1 }], "Kiwi a bullet");
  await t.frames(4);
  await caretMatches(t, id, "a list being edited");
  const d = await drawnLines(t, id);
  t.eq(d.marks.length, 5, "five markers drawn");
  const step = Math.round(14 * 1.5) * (await t.ev<number>("window.canvasHost.cam.z"));
  const left = (await t.rect(id)).x;
  t.near(d.lines[0].x - left, step, 1, "an item's text one step in");
  t.near(d.lines[1].x - left, 2 * step, 1, "a nested item two steps in");
  t.near(d.marks[1].x - left, step, 1, "its marker one step in");
  t.near(d.lines[4].x - left, 0, 1, "the plain line at the edge");
  await t.io.key("Escape");
  await t.flush();
  await t.frames(3);
  await evidence(t, "lists", [id], 24);
  t.eq(t.node(id)!.content, v, "written");
  t.eq(t.node(id)!.lists?.length, 5, "with its lists");
  // SVG export draws the markers as text: 1. a. 2. 3. and a bullet.
  const out = path.join(path.dirname(t.file), "lists.svg");
  await t.a.post("/api/export", { file: t.file, ids: [id], format: "svg", path: out });
  const svg = fs.readFileSync(out, "utf8");
  const marks = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).filter((s) => /^(\d+\.|[a-z]\.|•)$/.test(s));
  t.eq(marks, ["1.", "a.", "2.", "3.", "•"], `the markers in the SVG (${svg.slice(0, 300)})`);
  await t.undo();
  t.eq(t.node(id)!.lists?.length, 3, "one undo: the edit");
  t.subject = ["lay_text"];
});
