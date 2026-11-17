// Type details, the rest, in the app: Typography's Letter case menu (Small caps only for fonts that have them),
// List spacing, Hanging punctuation and Hanging lists. Controls are found by their QA frames (QAFrame), no text
// recognition.
import { center, NT, sc } from "./harness.ts";
import { intoInspector } from "./scenarios-leftovers.ts";
import { sleep } from "../lib.ts";

const OUT = `${process.cwd()}/qa/out/native`;
type R = { x: number; y: number; w: number; h: number };

async function control(t: NT, id: string): Promise<R> {
  await t.waitState((s) => s.frames?.[id], `the control ${id}`, 8000);
  return intoInspector(t, async () => (await t.state()).frames?.[id], id);
}
async function fieldIn(t: NT, frame: R) {
  const f = (await t.fields()).find((x) => x.x >= frame.x - 2 && x.x + x.w <= frame.x + frame.w + 2 && x.y >= frame.y - 4 && x.y + x.h <= frame.y + frame.h + 4);
  if (!f) throw new Error(`no text field in ${JSON.stringify(frame)}`);
  return f;
}
const update = (t: NT, props: Record<string, unknown>) => t.js(`fetch("/api/update", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file: window.canvasHost.file, id: "tx_long", props: ${JSON.stringify(props)} }) }); return true;`);
/** The Letter case menu's items as the app built them: { title, enabled, on }. */
async function letterCaseMenu(t: NT) {
  await t.click(center(await control(t, "type.letterCase")));
  await t.waitState((s) => s.menu, "the Letter case menu");
  return (await t.cmd("qa.menu", {})).items as { title: string; enabled: boolean }[];
}

sc("inspector", "Typography: Letter case (Small caps only with the font's own), List spacing, Hanging punctuation and Hanging lists", { covers: ["letter-case:mouse", "hanging-punctuation:mouse", "text-lists:mouse"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  const content = "“Quoted,” she said.\nApples\nPears";
  await update(t, { content, fontFamily: "Arial", lists: [{ p: 1, type: "bullet", level: 1 }, { p: 2, type: "bullet", level: 1 }] });
  await t.waitDisk(() => t.node("tx_long")?.content === content && t.node("tx_long")?.fontFamily === "Arial", "a quote and a list in Arial");
  await t.selectIds(["tx_long"]);
  // Arial has no small capitals: the menu does not offer them.
  let items = await letterCaseMenu(t);
  t.eq(items.map((i) => i.title), ["Original", "Uppercase", "Lowercase", "Title case", "Small caps"], "the five cases");
  t.eq(items.find((i) => i.title === "Small caps")?.enabled, false, "Small caps off for Arial");
  await t.pickMenu("Uppercase");
  await t.waitDisk(() => t.node("tx_long")?.letterCase === "upper", "upper case");
  // SF Pro has them.
  await update(t, { fontFamily: "SF Pro" });
  await t.waitDisk(() => t.node("tx_long")?.fontFamily === "SF Pro", "SF Pro");
  await sleep(300);
  items = await letterCaseMenu(t);
  t.eq(items.find((i) => i.title === "Small caps")?.enabled, true, "Small caps on for SF Pro");
  await t.pickMenu("Small caps");
  await t.waitDisk(() => t.node("tx_long")?.letterCase === "small-caps", "small caps");
  // List spacing.
  const ls = await fieldIn(t, await control(t, "type.listSpacing"));
  await t.setField(ls, "6");
  await t.waitDisk(() => t.node("tx_long")?.listSpacing === 6, "list spacing 6");
  await t.waitJs(`(() => { const r = window.canvasHost.engineView.textLines("tx_long"); return r && r.lines.length === 3 && Math.abs(r.lines[2].top - r.lines[1].bottom - 6) < 1.1; })()`, "6 px between the items, drawn");
  // Hanging punctuation: the opening quote outside the box.
  await t.click(center(await control(t, "type.hangingPunctuation")));
  await t.waitDisk(() => t.node("tx_long")?.hangingPunctuation === true, "hanging punctuation on");
  await t.waitJs(`window.canvasHost.engineView.textLines("tx_long").lines[0].x < window.canvasHost.worldRectOf("tx_long").x - 2`, "the quote drawn outside the box");
  // Hanging lists: the markers outside the box, the items' text at its edge.
  await t.click(center(await control(t, "type.hangingList")));
  await t.waitDisk(() => t.node("tx_long")?.hangingList === true, "hanging lists on");
  await t.waitJs(`(() => { const r = window.canvasHost.engineView.textLines("tx_long"), x = window.canvasHost.worldRectOf("tx_long").x; return r.marks.length === 2 && r.marks[0].x < x - 10 && Math.abs(r.lines[1].x - x) < 0.5; })()`, "markers outside the box");
  await sleep(400);
  await t.shot(`${OUT}/gaps-text-type-details-app.png`);
  // The app's web view (WebKit) draws the editor's letters: its upper and lower case must be the engine's (full Unicode
  // maps, engine/src/scene.rs apply_case), or the caret would drift off the drawn letters. (Title case does not ask
  // WebKit: CSS capitalize reads "e.g.", "ß" and a text's first word differently from Chrome, so the editor wraps each
  // word's first letter, by the engine's rule, in a span drawn in upper case.)
  const css = (tt: string, text: string) => t.js(`const d = document.createElement("div"), s = document.createElement("span"); s.style.textTransform = "${tt}"; s.textContent = ${JSON.stringify(text)}; d.appendChild(s); document.body.appendChild(d); const r = s.innerText; d.remove(); return r;`);
  t.eq(await css("uppercase", "don't stop e.g. straße ﬁne"), "DON'T STOP E.G. STRASSE FINE", "WebKit's upper case is the engine's");
  t.eq(await css("lowercase", "ΟΔΟΣ ΣΑΣ"), "οδος σας", "WebKit's lower case is the engine's (a final sigma)");
  // And off again.
  await t.click(center(await control(t, "type.hangingList")));
  await t.waitDisk(() => t.node("tx_long")?.hangingList === undefined, "hanging lists off");
  items = await letterCaseMenu(t);
  await t.pickMenu("Original");
  await t.waitDisk(() => t.node("tx_long")?.letterCase === undefined, "Original takes the key off");
  // Editing in the app's web view: each line of the field's letters starts and ends where the engine draws it, for
  // title case, upper case and a hanging quote.
  const words = "\u201cdon't stop, e.g. stra\u00dfe and hello-world,\u201d she said. \u00dfa the 3rd line wraps here.";
  for (const props of [{ letterCase: "title" }, { letterCase: "upper" }, { letterCase: "lower", hangingPunctuation: true }]) {
    await update(t, { content: words, fontFamily: "Arial", lists: [], ...props });
    await t.waitDisk(() => t.node("tx_long")?.letterCase === props.letterCase && t.node("tx_long")?.content === words, `${props.letterCase} on disk`);
    await t.js(`window.canvasHost.textEdit.enter("tx_long", { all: true }); return true;`);
    await t.waitJs("window.canvasHost.textEdit.active", "the edit open");
    await sleep(400);
    const off = await t.js(`const h = window.canvasHost, c = h.cam, vb = h.viewBox, r = h.engineView.textLines("tx_long");
      const X = (x) => vb.l + c.x + x * c.z, Y = (y) => vb.t + c.y + y * c.z;
      const drawn = r.lines.map((l) => ({ x: X(l.x), right: X(l.right), mid: (Y(l.top) + Y(l.bottom)) / 2 }));
      const f = document.querySelector("#textEdit .f"), lines = [];
      const w = document.createTreeWalker(f, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) for (let i = 0; i < n.data.length; i++) {
        if (/\\s/.test(n.data[i])) continue;
        const g = document.createRange(); g.setStart(n, i); g.setEnd(n, i + 1); const q = g.getClientRects()[0];
        if (!q || !q.width) continue;
        let l = lines.find((x) => Math.abs(x.top - q.top) < q.height / 2);
        if (!l) { l = { x: q.left, right: q.right, top: q.top, mid: q.top + q.height / 2 }; lines.push(l); }
        l.x = Math.min(l.x, q.left); l.right = Math.max(l.right, q.right);
      }
      let worst = lines.length === drawn.length ? 0 : 999;
      for (const l of lines) { const d = drawn.reduce((a, b) => (Math.abs(b.mid - l.mid) < Math.abs(a.mid - l.mid) ? b : a)); worst = Math.max(worst, Math.abs(d.mid - l.mid), Math.abs(d.x - l.x), Math.abs(d.right - l.right)); }
      const r1 = (v) => Math.round(v * 10) / 10;
      return { worst: r1(worst), field: lines.map((l) => [r1(l.x), r1(l.right)]), drawn: drawn.map((l) => [r1(l.x), r1(l.right)]), text: f.innerText };`);
    t.ok(off.worst <= 3, `${props.letterCase}: the field's letters within 3 px of the drawn ones in the app (${JSON.stringify(off)})`);
    await t.js(`window.canvasHost.textEdit.commit(); return true;`);
    await t.waitJs("!window.canvasHost.textEdit.active", "the edit closed");
  }
});
