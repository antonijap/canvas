// Type details, the rest (letter case, hanging punctuation, list spacing, hanging lists, marker colours,
// Backspace keeping a list item's indent). Imported by qa/scenarios.ts; each runs on its own fresh copy of
// demos/playground.canvas. Each one leaves a picture of its key frame in qa/out/evidence/gaps-text-<slug>.png.
import fs from "node:fs";
import path from "node:path";
import { sc, type T } from "./harness.ts";

async function evidence(t: T, slug: string, ids: string[], pad = 40) {
  const rs = await Promise.all(ids.map((id) => t.rect(id)));
  const x0 = Math.max(0, Math.min(...rs.map((r) => r.x)) - pad), y0 = Math.max(0, Math.min(...rs.map((r) => r.y)) - pad);
  const x1 = Math.max(...rs.map((r) => r.x + r.w)) + pad, y1 = Math.max(...rs.map((r) => r.y + r.h)) + pad;
  const png = await t.shot({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  const dir = path.join(import.meta.dirname, "out", "evidence");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gaps-text-" + slug + ".png"), png);
}

type Line = { x: number; top: number; baseline: number; bottom: number; right: number };
/** The text's lines and markers as the engine draws them, in window px. */
const drawnLines = (t: T, id: string) => t.ev<{ lines: Line[]; marks: { x: number; baseline: number }[] }>(`(() => {
  const h = window.canvasHost, c = h.cam, vb = h.viewBox, r = h.engineView.textLines(${JSON.stringify(id)});
  const X = (x) => vb.l + c.x + x * c.z, Y = (y) => vb.t + c.y + y * c.z;
  return { lines: r.lines.map((l) => ({ x: X(l.x), right: X(l.right), top: Y(l.top), baseline: Y(l.baseline), bottom: Y(l.bottom) })), marks: r.marks.map((m) => ({ x: X(m.x), baseline: Y(m.baseline) })) };
})()`);
/** The editor field's lines as the browser lays its letters out (window px): first letter's left, last letter's right. */
const fieldLines = (t: T) => t.ev<{ x: number; right: number; top: number; mid: number }[]>(`(() => {
  const f = document.querySelector("#textEdit .f"), lines = [];
  const w = document.createTreeWalker(f, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    for (let i = 0; i < n.data.length; i++) {
      if (/\\s/.test(n.data[i])) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
      const q = r.getClientRects()[0];
      if (!q || !q.width) continue;
      let l = lines.find((x) => Math.abs(x.top - q.top) < q.height / 2);
      if (!l) { l = { x: q.left, right: q.right, top: q.top, mid: q.top + q.height / 2 }; lines.push(l); }
      l.x = Math.min(l.x, q.left); l.right = Math.max(l.right, q.right);
    }
  }
  return lines.sort((a, b) => a.top - b.top);
})()`);
/** Every line of the editor's letters starts and ends where the canvas draws it, within 3 px. */
async function lettersMatch(t: T, id: string, what: string) {
  const { lines } = await drawnLines(t, id);
  const field = await fieldLines(t);
  t.eq(field.length, lines.filter((l) => l.right - l.x > 0.5).length, `${what}: as many lines in the field as drawn`);
  for (const f of field) {
    const d = lines.reduce((a, b) => (Math.abs((b.top + b.bottom) / 2 - f.mid) < Math.abs((a.top + a.bottom) / 2 - f.mid) ? b : a));
    t.near(f.mid, (d.top + d.bottom) / 2, 3, `${what}: a line's middle (field ${f.mid.toFixed(1)}, drawn ${((d.top + d.bottom) / 2).toFixed(1)})`);
    t.near(f.x, d.x, 3, `${what}: its first letter (field ${f.x.toFixed(1)}, drawn ${d.x.toFixed(1)})`);
    t.near(f.right, d.right, 3, `${what}: its last letter ends (field ${f.right.toFixed(1)}, drawn ${d.right.toFixed(1)})`);
  }
}
const editing = (t: T, id: string) => t.waitFor(`!!(window.canvasHost.textEdit && window.canvasHost.textEdit.id === ${JSON.stringify(id)})`, `editing ${id}`);
async function startEdit(t: T, id: string) {
  const c = await t.center(id);
  await t.select([id]);
  await t.io.dblclick(c.x, c.y);
  await editing(t, id);
  await t.frames(3);
}
const node = (t: T, id: string) => t.ev<{ x: number; y: number; w: number }>(`(() => { const r = window.canvasHost.worldRectOf(${JSON.stringify(id)}); const h = window.canvasHost, c = h.cam, vb = h.viewBox; return { x: vb.l + c.x + r.x * c.z, y: vb.t + c.y + r.y * c.z, w: r.w * c.z }; })()`);
async function svgOf(t: T, id: string, name: string) {
  const out = path.join(path.dirname(t.file), name);
  const ex = await t.a.post("/api/export", { file: t.file, ids: [id], format: "svg", path: out });
  t.ok(ex && ex.files && ex.files.length === 1, `exported: ${JSON.stringify(ex).slice(0, 200)}`);
  return fs.readFileSync(out, "utf8");
}
const texts = (svg: string) => [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)"([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), attrs: m[3], s: m[4] }));

sc("text", "letter case: upper, title and small caps drawn by the engine, the editor's letters on the drawn ones, kept in SVG", { covers: ["letter-case:text", "letter-case:keyboard", "letter-case:export", "letter-case:small-caps"] }, async (t: T) => {
  await t.focus("lay_text", 1.5);
  const id = "tx_long";
  const content = "Letter case: straße, don't stop. Hello-world e.g. the 3rd line wraps here.";
  await t.a.post("/api/update", { file: t.file, id, props: { content } });
  await t.flush();
  await t.waitFor(`window.canvasHost.engineView.textLines("tx_long").lines.length >= 2`, "drawn");
  const plain = (await drawnLines(t, id)).lines;
  // What Typography's Letter case menu writes: Uppercase.
  await t.a.post("/api/update", { file: t.file, id, props: { letterCase: "upper" } });
  await t.flush();
  await t.waitFor(`(() => { const l = window.canvasHost.engineView.textLines("tx_long").lines; return l[0].right - l[0].x !== ${plain[0].right - plain[0].x} || l.length !== ${plain.length}; })()`, "drawn in capitals");
  const upper = (await drawnLines(t, id)).lines;
  t.ok(upper[0].right - upper[0].x > plain[0].right - plain[0].x || upper.length > plain.length, "capitals take more room");
  await t.frames(3);
  await evidence(t, "letter-case", [id], 24);
  // Editing: the field draws its letters in capitals too, so every line starts and ends where the canvas draws it;
  // typed letters stay as typed in the file.
  await startEdit(t, id);
  await lettersMatch(t, id, "upper case, editing");
  await t.ev(`window.canvasHost.textEdit.select(${content.length}, ${content.length})`);
  await t.io.type(" Typed ß.");
  await t.frames(4);
  await lettersMatch(t, id, "upper case, after typing");
  await t.io.key("Escape");
  await t.flush();
  t.eq(t.node(id)!.content, content + " Typed ß.", "the file keeps the letters as typed");
  t.eq(t.node(id)!.letterCase, "upper", "and the case");
  let svg = await svgOf(t, id, "upper.svg");
  t.ok(texts(svg).map((x) => x.s).join(" ").includes("STRASSE"), `the SVG writes the capitals ("ß" as "SS"): ${svg.slice(0, 400)}`);
  // Title case: the first letter of each word.
  await t.a.post("/api/update", { file: t.file, id, props: { letterCase: "title" } });
  await t.flush();
  await startEdit(t, id);
  await lettersMatch(t, id, "title case, editing");
  await t.io.key("Escape");
  await t.flush();
  svg = await svgOf(t, id, "title.svg");
  const words = texts(svg).map((x) => x.s).join(" ");
  for (const w of ["Letter Case:", "Straße,", "Don't Stop.", "Hello-World", "E.G.", "3rd"]) t.ok(words.includes(w), `title case "${w}" in the SVG: ${words}`);
  // Small caps: the font's own (SF Pro has smcp): lower case letters drawn as small capitals, wider than they were.
  await t.a.post("/api/update", { file: t.file, id, props: { fontFamily: "SF Pro", letterCase: "original", content: "Small caps hamburgefonstiv" } });
  await t.flush();
  await t.waitFor(`window.canvasHost.engineView.textLines("tx_long").lines.length === 1`, "one line");
  const sf = (await t.ev<Line[]>(`window.canvasHost.engineView.textLines("tx_long").lines`))[0]; // world px
  await t.a.post("/api/update", { file: t.file, id, props: { letterCase: "small-caps" } });
  await t.flush();
  await t.waitFor(`(() => { const l = window.canvasHost.engineView.textLines("tx_long").lines[0]; return l.right - l.x > ${sf.right - sf.x + 3}; })()`, "small capitals, wider than lower case");
  await t.frames(3);
  await evidence(t, "small-caps", [id], 24);
  await startEdit(t, id);
  await lettersMatch(t, id, "small caps, editing");
  await t.io.key("Escape");
  await t.flush();
  svg = await svgOf(t, id, "smcp.svg");
  t.ok(texts(svg).some((x) => /font-feature-settings:&quot;smcp&quot; 1/.test(x.attrs)), `the SVG asks for the font's small capitals: ${svg.slice(0, 600)}`);
  // Arial, edge cases: "ß" (two capitals), "e.g.", a hyphen, an apostrophe, a quote that hangs.
  const edge = "“don't stop, e.g. straße and hello-world,” she said. ßa the 3rd line wraps here.";
  for (const props of [{ letterCase: "title" }, { letterCase: "upper" }, { letterCase: "lower", hangingPunctuation: true }]) {
    await t.a.post("/api/update", { file: t.file, id, props: { content: edge, fontFamily: "Arial", ...props } });
    await t.flush();
    await t.frames(4);
    await startEdit(t, id);
    await lettersMatch(t, id, `${props.letterCase} in Arial`);
    await t.io.key("Escape");
    await t.flush();
  }
  t.subject = ["lay_text"];
});

sc("text", "hanging punctuation: an opening quote hangs outside the box; the caret on the drawn lines; kept in SVG", { covers: ["hanging-punctuation:text", "hanging-punctuation:keyboard", "hanging-punctuation:export"] }, async (t: T) => {
  await t.focus("lay_text", 1.5);
  const id = "tx_long";
  const content = "“Hanging quotes sit outside the box, so the letters line up with its edge.”\nA plain paragraph.\n\"Straight quotes hang too.\"";
  await t.a.post("/api/update", { file: t.file, id, props: { content, hangingPunctuation: true } });
  await t.flush();
  await t.waitFor(`(() => { const r = window.canvasHost.engineView.textLines("tx_long"); return r && r.lines.length >= 4 && r.lines[0].x < window.canvasHost.worldRectOf("tx_long").x - 1; })()`, "the quote hangs");
  const z = await t.ev<number>("window.canvasHost.cam.z");
  const box = await node(t, id);
  const L = (await drawnLines(t, id)).lines;
  const n = L.length;
  const hang = (box.x - L[0].x) / z;
  t.ok(hang > 3 && hang < 9, `the quote's own width left of the box (${hang.toFixed(2)} px at 14 px)`);
  t.near(L[1].x, box.x, 0.5, "the wrapped line starts at the edge");
  t.near(L[n - 2].x, box.x, 0.5, "a paragraph without a quote starts at the edge");
  t.ok(L[n - 1].x < box.x - 2 * z, "a straight quote hangs too");
  await t.frames(3);
  await t.select([id]); // the box drawn, the quotes outside it
  await t.frames(3);
  await evidence(t, "hanging-punctuation", [id], 32);
  // Editing: each paragraph's first letter (the quote) in the field sits where the canvas draws it; a typed paragraph
  // that starts with a quote hangs at once.
  await startEdit(t, id);
  await lettersMatch(t, id, "editing");
  await t.ev(`window.canvasHost.textEdit.select(${content.length}, ${content.length})`);
  await t.io.type("\n“Typed” and hanging.");
  await t.frames(4);
  await lettersMatch(t, id, "after a typed quote");
  const after = (await drawnLines(t, id)).lines;
  t.ok(after[after.length - 1].x < box.x - 2 * z, "the typed quote hangs");
  await t.io.key("Escape");
  await t.flush();
  t.eq(t.node(id)!.content, content + "\n“Typed” and hanging.", "written");
  // SVG export: the quotes start left of the text's own box.
  const svg = await svgOf(t, id, "hang.svg");
  const q = texts(svg).filter((x) => /^(\u201c|"|&quot;)/.test(x.s));
  t.ok(q.length >= 2 && q.every((x) => x.x < -2), `the quotes left of the box in the SVG: ${JSON.stringify(q)}`);
  // Centred text does not hang (the rule for the box edge: only where the lines line up with it).
  await t.a.post("/api/update", { file: t.file, id, props: { textAlign: "center" } });
  await t.flush();
  await t.waitFor(`(() => { const r = window.canvasHost.engineView.textLines("tx_long"); return r.lines[0].x > window.canvasHost.worldRectOf("tx_long").x; })()`, "centred: in the box");
  t.subject = ["lay_text"];
});

sc("text", "lists, the rest: Backspace keeps the indent, list spacing, hanging lists, markers in their item's colour; drawn and exported", { covers: ["text-lists:backspace", "text-lists:list-spacing", "text-lists:hanging-list", "text-lists:marker-colour", "text-lists:keyboard"] }, async (t: T) => {
  await t.focus("lay_text", 1.5);
  const id = "tx_long";
  await t.a.post("/api/update", { file: t.file, id, props: { content: "Apples\nPears\nPlums" } });
  await t.flush();
  await t.select([id]);
  await t.io.key("8", { meta: true, shift: true });
  await t.flush();
  await t.waitFor(`window.canvasHost.engineView.textLines("tx_long").marks.length === 3`, "three bullets drawn");
  const z = await t.ev<number>("window.canvasHost.cam.z");
  const step = Math.round(14 * 1.5) * z;
  const box = await node(t, id);
  // Backspace at the start of "Pears": its bullet goes, its indent stays; the letters stay.
  await startEdit(t, id);
  await t.ev(`window.canvasHost.textEdit.select(7, 7)`);
  await t.io.key("Backspace");
  t.eq(await t.ev("window.canvasHost.textEdit.value"), "Apples\nPears\nPlums", "no letter deleted");
  t.eq((await t.ev<any[]>("window.canvasHost.textEdit.lists"))[1], { p: 1, type: "none", level: 1 }, "Pears keeps its level without a marker");
  await t.frames(4);
  let d = await drawnLines(t, id);
  t.eq(d.marks.length, 2, "two markers drawn");
  t.near(d.lines[1].x - box.x, step, 1, "Pears still a step in");
  await t.io.key("Escape");
  await t.flush();
  t.eq(t.node(id)!.lists, [{ p: 0, type: "bullet", level: 1 }, { p: 1, type: "none", level: 1 }, { p: 2, type: "bullet", level: 1 }], "written");
  // List spacing 8, hanging lists, and "Plums" in red: what the inspector's List spacing, Hanging lists and a colour on
  // the selected letters write.
  await t.a.post("/api/update", { file: t.file, id, props: { listSpacing: 8, hangingList: true, spans: [{ start: 13, end: 18, fill: "#E5484D" }] } });
  await t.flush();
  await t.waitFor(`(() => { const r = window.canvasHost.engineView.textLines("tx_long"); return r.lines[0].x - window.canvasHost.worldRectOf("tx_long").x < 0.5 && r.lines[1].top - r.lines[0].bottom > 7; })()`, "hanging and spaced");
  d = await drawnLines(t, id);
  t.near(d.lines[1].top - d.lines[0].bottom, 8 * z, 1.01 * z, "8 px between items (line boxes on whole px)");
  t.near(d.lines[2].top - d.lines[1].bottom, 8 * z, 1.01 * z, "and between the next two");
  for (const l of d.lines) t.near(l.x, box.x, 1, "every item's text at the box edge (hanging)");
  t.near(d.marks[0].x, box.x - step, 1, "the marker a step outside the box");
  await t.frames(3);
  await evidence(t, "lists", [id], 48);
  // The field keeps the drawn lines while editing.
  await startEdit(t, id);
  await lettersMatch(t, id, "a hanging, spaced list");
  await t.io.key("Escape");
  await t.flush();
  // SVG export: two bullets, the second in its item's red; the first outside the box.
  const svg = await svgOf(t, id, "lists2.svg");
  const marks = texts(svg).filter((x) => x.s === "•");
  t.eq(marks.length, 2, `two bullets in the SVG: ${svg.slice(0, 500)}`);
  t.ok(marks[0].x < -step / z + 2, `the first outside the box (${marks[0].x})`);
  t.ok(/fill="#e5484d"/i.test(marks[1].attrs) && !/fill="#e5484d"/i.test(marks[0].attrs), `the second marker red like "Plums": ${JSON.stringify(marks)}`);
  t.subject = ["lay_text"];
});
