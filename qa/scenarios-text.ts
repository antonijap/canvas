// Text scenarios (docs/interaction-conventions.md, Text): editing, type keys, styled ranges, find and replace.
// Imported by qa/scenarios.ts; each runs on its own fresh copy of demos/playground.canvas like the rest.
// Each one leaves a picture of its key frame in qa/out/evidence/text-<slug>.png (docs/evidence/text.md).
import fs from "node:fs";
import path from "node:path";
import { sc, type Rect, type T } from "./harness.ts";

const editing = (t: T) => t.ev<string | null>("window.canvasHost.textEdit && window.canvasHost.textEdit.active ? window.canvasHost.textEdit.id : null");
const waitEditing = (t: T, id: string) => t.waitFor(`!!(window.canvasHost.textEdit && window.canvasHost.textEdit.id === ${JSON.stringify(id)})`, `editing ${id}`);

/** The key frame of a scenario, around `ids` (window px, padded) and any extra window rects, for the evidence file. */
async function evidence(t: T, slug: string, ids: string[], pad = 40, extra: Rect[] = []) {
  const rs = [...(await Promise.all(ids.map((id) => t.rect(id)))), ...extra];
  const x0 = Math.min(...rs.map((r) => r.x)) - pad, y0 = Math.min(...rs.map((r) => r.y)) - pad;
  const x1 = Math.max(...rs.map((r) => r.x + r.w)) + pad, y1 = Math.max(...rs.map((r) => r.y + r.h)) + pad;
  const png = await t.shot({ x: Math.max(0, x0), y: Math.max(0, y0), width: x1 - Math.max(0, x0), height: y1 - Math.max(0, y0) });
  const dir = path.join(import.meta.dirname, "out", "evidence");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "text-" + slug + ".png"), png);
}

/** Start editing a text layer the way a person does: the double-click that reaches it selects it, the next edits. */
async function startEdit(t: T, id: string, at?: { x: number; y: number }) {
  const c = at ?? (await t.center(id));
  await t.select([id]);
  await t.io.dblclick(c.x, c.y);
  await waitEditing(t, id);
  await t.frames(3);
}

sc("text", "a click on another text layer while editing edits that one at the click", { covers: ["text-edit-next:text", "text-edit-next:mouse", "text-edit:keyboard"] }, async (t: T) => {
  await t.focus("lay_text");
  await startEdit(t, "tx_auto");
  await t.io.key("End");
  await t.io.type(" now");
  // One click on another text layer: no double-click, the caret goes where the click was.
  const r = await t.rect("tx_height");
  await t.io.click(r.x + 2, r.y + r.h / 4);
  await waitEditing(t, "tx_height");
  t.eq(await t.sel(), ["tx_height"], "the clicked layer is selected");
  await t.io.type("Z");
  await t.frames(3);
  await evidence(t, "edit-next", ["tx_auto", "tx_height"]);
  await t.io.key("Escape");
  await t.flush();
  t.eq(t.node("tx_auto")!.content, "Auto width grows sideways now", "the first edit was written");
  t.eq(t.node("tx_height")!.content, "ZAuto height: fixed width, height follows the lines", "the caret went where the click was (the start)");
  // A click on something that is not text only ends the edit.
  await startEdit(t, "tx_auto");
  const f = await t.rect("tx_fixed");
  await t.io.click(f.x + f.w + 60, f.y + 120);
  await t.frames(3);
  t.eq(await editing(t), null, "a click on empty board ends the edit");
  // Two edits, two undo steps.
  await t.undo();
  t.eq(t.node("tx_height")!.content, "Auto height: fixed width, height follows the lines", "the first undo takes back the second edit");
  t.eq(t.node("tx_auto")!.content, "Auto width grows sideways now", "and only that one");
  await t.undo();
  t.eq(t.node("tx_auto")!.content, "Auto width grows sideways", "the second undo the first edit");
  t.subject = ["lay_text"];
});

sc("text", "type keys: Option+< > letter spacing, Option+Shift line height, Option+Cmd weight", { covers: ["text-type-keys:text", "text-type-keys:many", "text-type-keys:keyboard"] }, async (t: T) => {
  await t.showPage("style");
  await t.focus("sty_type");
  const a0 = t.node("ts_body_a")!, b0 = t.node("ts_body_b")!;
  await t.select(["ts_body_a", "ts_body_b"]);
  // Each from its own value, one undo step per press.
  for (let i = 0; i < 3; i++) await t.io.key(".", { alt: true });
  await t.flush();
  t.near(t.node("ts_body_a")!.letterSpacing, a0.letterSpacing + 0.3, 1e-6, "three presses: +0.3 px");
  t.near(t.node("ts_body_b")!.letterSpacing, b0.letterSpacing + 0.3, 1e-6, "on every selected text");
  await t.io.key(",", { alt: true });
  await t.flush();
  t.near(t.node("ts_body_a")!.letterSpacing, a0.letterSpacing + 0.2, 1e-6, "Option+< takes 0.1 px off");
  // 16 px at 1.45 draws 23.2 px: 24 px, then 25 px.
  await t.io.key(".", { alt: true, shift: true });
  await t.io.key(".", { alt: true, shift: true });
  await t.flush();
  t.eq(t.node("ts_body_a")!.lineHeight, 1.5625, "line height 25 px");
  await t.io.key(",", { alt: true, shift: true });
  await t.flush();
  t.eq(t.node("ts_body_a")!.lineHeight, 1.5, "Option+Shift+< one px less");
  for (let i = 0; i < 3; i++) await t.io.key(".", { alt: true, meta: true });
  await t.flush();
  t.eq([t.node("ts_body_a")!.fontWeight, t.node("ts_body_b")!.fontWeight], ["700", "700"], "three presses: 400 to 700");
  await t.io.key(",", { alt: true, meta: true });
  await t.flush();
  t.eq(t.node("ts_body_a")!.fontWeight, "600", "Option+Cmd+< one weight lighter");
  await t.frames(4);
  await evidence(t, "type-keys", ["ts_h1a", "ts_h1b", "ts_body_a", "ts_body_b", "ts_cap_a"]);
  // A quick run of presses on one property is one undo step, like typing in a field (the server's merge window).
  await t.undo();
  t.eq(t.node("ts_body_a")!.fontWeight, "400", "one undo takes back the run of weight presses");
  t.eq(t.node("ts_body_a")!.lineHeight, 1.5, "and nothing before it");
  t.subject = ["sty_type"];
});

/** Every text content in the file (main tree, components included), and how often `q` occurs in them, any case. */
function occurrences(t: T, q: string): number {
  let n = 0;
  const visit = (ns: any[]) => { for (const x of ns ?? []) { if (x.type === "text" && typeof x.content === "string") n += x.content.toLowerCase().split(q.toLowerCase()).length - 1; visit(x.children); } };
  visit(t.disk().children);
  return n;
}
const barRect = (t: T) => t.ev<Rect>(`(() => { const r = document.getElementById("findBar").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);

sc("text", "find and replace: Cmd+F finds text on every page, Replace one, Replace all is one undo step", { covers: ["find-replace:text", "find-replace:other-page", "find-replace:keyboard", "find-replace:mouse"] }, async (t: T) => {
  await t.focus("lay_text");
  const total = occurrences(t, "width");
  t.ok(total >= 3, `the playground says "width" a few times (${total})`);
  await t.io.key("f", { meta: true });
  await t.waitFor("!!(window.canvasHost.findReplace && window.canvasHost.findReplace.isOpen)", "the find bar to open");
  await t.io.type("width");
  await t.waitFor(`window.canvasHost.findReplace.state.total === ${total}`, `${total} matches`);
  await t.io.key("Enter");
  await t.waitFor("window.canvasHost.findReplace.state.i === 0", "the first match shown");
  const first = (await t.ev<any>("window.canvasHost.findReplace.state")).matches[0];
  await t.waitFor(`JSON.stringify(window.canvasHost.selection()) === ${JSON.stringify(JSON.stringify([first.id]))}`, "its layer selected");
  t.eq(await t.ev("document.querySelector('#findBar .n').textContent"), `1 of ${total}`, "the count");
  // Replace this match only.
  await t.ev(`document.querySelector("#findBar .rep").focus()`);
  await t.io.type("breadth");
  await t.frames(2);
  await evidence(t, "find-replace", ["tx_auto", "tx_height"], 24, [await barRect(t)]);
  await t.io.key("Enter");
  await t.waitFor(`window.canvasHost.findReplace.state.total === ${total - 1}`, "one match fewer");
  await t.flush();
  t.eq(occurrences(t, "width"), total - 1, "one occurrence replaced");
  t.eq(occurrences(t, "breadth"), 1, "by the new word");
  // Replace all: every page, one undo step.
  await t.ev(`document.querySelector("#findBar .all").click()`);
  await t.waitFor("window.canvasHost.findReplace.state.total === 0", "no matches left");
  await t.flush();
  t.eq(occurrences(t, "width"), 0, "every occurrence replaced");
  t.eq(occurrences(t, "breadth"), total, "on every layer and page");
  t.eq(await t.ev("document.querySelector('#findBar .n').textContent"), "No results", "the count says so");
  await t.io.key("Escape");
  t.eq(await t.ev("window.canvasHost.findReplace.isOpen"), false, "Esc closes the bar");
  await t.undo();
  t.eq(occurrences(t, "width"), total - 1, "one undo takes back Replace all");
  await t.undo();
  t.eq(occurrences(t, "width"), total, "the next the single replace");
  t.subject = ["lay_text"];
});

sc("text", "multi-edit text: several text layers selected, Return, type: all of them change, one undo step", { covers: ["text-multi-edit:text", "text-multi-edit:many", "text-multi-edit:keyboard"] }, async (t: T) => {
  await t.showPage("style");
  await t.focus("sty_type");
  const ids = ["ts_body_a", "ts_body_b", "ts_cap_a"];
  const before = ids.map((id) => t.node(id)!.content);
  await t.select(ids);
  await t.io.key("Enter");
  await t.waitFor("!!(window.canvasHost.textEdit && window.canvasHost.textEdit.active)", "the edit to open");
  t.eq((await t.sel()).sort(), [...ids].sort(), "the selection stays");
  await t.io.type("Same words");
  await t.frames(4);
  // The others draw the typing as it happens.
  const drawn = await t.ev<string[]>(`${JSON.stringify(ids)}.map((id) => { const L = window.canvasHost.live, b = L.boardOf(id), s = L.sceneOf(b); const f = (n) => n.id === id ? n : (n.children || []).map(f).find(Boolean); return f(s.root).content; })`);
  t.eq(drawn, ["Same words", "Same words", "Same words"], "every selected text shows the typing");
  await evidence(t, "multi-edit", ["ts_h1b", ...ids], 40);
  await t.io.key("Escape");
  await t.flush();
  t.eq(ids.map((id) => t.node(id)!.content), ["Same words", "Same words", "Same words"], "all three written");
  await t.undo();
  t.eq(ids.map((id) => t.node(id)!.content), before, "one undo brings each one's own text back");
  await t.redo();
  t.subject = ["sty_type"];
});

sc("text", "style part of a text: a selected word goes bold, bigger and red; typing after it keeps the style; one undo step", { covers: ["text-ranges:text", "text-ranges:keyboard", "text-ranges:mouse", "text-edit:keyboard"] }, async (t: T) => {
  await t.focus("lay_text", 1.5);
  const id = "tx_auto"; // "Auto width grows sideways"
  await t.select([id]);
  const r = await t.rect(id);
  // The double-click that edits selects the word under the pointer: "width" sits right of "Auto ".
  await t.io.dblclick(r.x + r.w * 0.3, r.y + r.h / 2);
  await waitEditing(t, id);
  await t.frames(3);
  t.eq(await t.ev("window.canvasHost.textEdit.selection"), { start: 5, end: 10, back: false }, "the word is selected");
  await t.io.key("b", { meta: true });
  for (let i = 0; i < 6; i++) await t.io.key(".", { meta: true, shift: true });
  // The colour the inspector sets on selected letters (Model.swift sends this while text is being edited).
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "textStyle", props: { fill: "#E5484D" } })`);
  await t.frames(2);
  t.eq(await t.ev("window.canvasHost.textEdit.spans"), [{ start: 5, end: 10, fontSize: 22, fontWeight: "700", fill: "#E5484D" }], "bold, six px bigger, red: on the word only");
  // The caret goes after the word; typed letters take its style. The field's letters sit where the canvas draws them.
  await t.io.key("ArrowRight");
  await t.io.type("s");
  t.eq(await t.ev("window.canvasHost.textEdit.value"), "Auto widths grows sideways", "typed");
  t.eq(await t.ev("window.canvasHost.textEdit.spans"), [{ start: 5, end: 11, fontSize: 22, fontWeight: "700", fill: "#E5484D" }], "the new letter is styled too");
  await t.frames(4);
  // The field (caret, selection) lays the letters out as the canvas draws them: the same box, to a pixel or two.
  const field = await t.ev<Rect>(`(() => { const b = document.querySelector("#textEdit .f").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const drawn = await t.rect(id);
  t.near(field.w, drawn.w, 3, `the field's width matches the drawn text (${JSON.stringify(field)} vs ${JSON.stringify(drawn)})`);
  t.near(field.h, drawn.h, 3, "and its height");
  t.ok(drawn.w > r.w * 1.1, `the drawn text grew with the bigger word (${r.w} to ${drawn.w})`);
  await evidence(t, "style-range", [id], 30);
  await t.io.key("Escape");
  await t.flush();
  t.eq(t.node(id)!.content, "Auto widths grows sideways", "the content");
  t.eq(t.node(id)!.spans, [{ start: 5, end: 11, fontSize: 22, fontWeight: "700", fill: "#E5484D" }], "the styled range is in the file");
  t.eq(t.node(id)!.fontWeight, "400", "the layer keeps its own weight");
  await t.undo();
  t.eq([t.node(id)!.content, t.node(id)!.spans], ["Auto width grows sideways", undefined], "one undo: the edit and its styles");
  await t.redo();
  t.eq(t.node(id)!.spans?.length, 1, "redo brings them back");
  // Export as SVG keeps the styled word as text in its own weight, size and colour.
  const out = path.join(path.dirname(t.file), "styled.svg");
  const ex = await t.a.post("/api/export", { file: t.file, ids: [id], format: "svg", path: out });
  t.ok(ex && ex.files && ex.files.length === 1, `exported: ${JSON.stringify(ex).slice(0, 200)}`);
  const svg = fs.readFileSync(out, "utf8");
  t.ok(/<text[^>]*font-size="22"[^>]*font-weight="700"[^>]*fill="#E5484D"[^>]*>widths<\/text>/i.test(svg), `the styled word in the SVG: ${svg.slice(0, 600)}`);
  t.ok(/>Auto <\/text>|>Auto<\/text>/.test(svg) && /grows sideways/.test(svg), "and the plain words");
  t.subject = ["lay_text"];
});

sc("text", "truncate text with max lines: an ellipsis after two lines; the whole text while editing", { covers: ["text-truncate:text", "text-truncate:keyboard", "text-truncate:agent"] }, async (t: T) => {
  await t.focus("lay_text");
  const id = "tx_long"; // a 300 px wide paragraph of six lines
  const full = await t.rect(id);
  // What Typography > Truncate text and Max lines write (and an agent's set_node_props).
  await t.a.post("/api/update", { file: t.file, id, props: { textTruncation: "ending", maxLines: 2 } });
  await t.flush();
  await t.waitFor(`(() => { const r = window.canvasHost.worldRectOf(${JSON.stringify(id)}); return r && r.h < ${full.h} / 2; })()`, "the text two lines tall");
  const two = await t.rect(id);
  t.near(two.h, 14 * 1.45 * 2, 1.5, "two lines of 14 px at 1.45");
  await t.frames(3);
  await evidence(t, "truncate", [id], 24);
  // Editing shows all of it; the ellipsis comes back after.
  await startEdit(t, id);
  await t.waitFor(`(() => { const r = window.canvasHost.worldRectOf(${JSON.stringify(id)}); return r && r.h > ${two.h} * 2; })()`, "the whole text while editing");
  await t.io.key("Escape");
  await t.flush();
  await t.waitFor(`(() => { const r = window.canvasHost.worldRectOf(${JSON.stringify(id)}); return r && Math.abs(r.h - ${two.h}) < 1; })()`, "two lines again");
  t.eq([t.node(id)!.textTruncation, t.node(id)!.maxLines], ["ending", 2], "in the file");
  await t.undo();
  t.eq(t.node(id)!.textTruncation, undefined, "undo takes it off");
  await t.redo();
  t.subject = ["lay_text"];
});
