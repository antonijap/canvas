// Leftover interaction conventions in the app (docs/evidence/leftovers.md): the inspector's Layout guide section, View > Layout
// Guides and Control+G, Typography's paragraph spacing, indent and list style. Controls are found by their QA frames
// (QAFrame in the QA build), so no text recognition is needed.
import { center, NT, sc, type Pt } from "./harness.ts";
import { sleep } from "../lib.ts";

const OUT = `${process.cwd()}/qa/out/native`;
type R = { x: number; y: number; w: number; h: number };

/**
 * An inspector control's rect (from `find`), once the inspector has stopped sliding, scrolled up into the island if it
 * sits below it: the island ends above the zoom pill, and a click on a control cut off there lands on the canvas.
 */
export async function intoInspector(t: NT, find: () => Promise<R | undefined>, what: string): Promise<R> {
  let f: R | undefined;
  let dy = -120;
  for (let i = 0; i < 50; i++) {
    const st = await t.state();
    const g = await find();
    if (!g) { await sleep(120); continue; }
    if (g.y + g.h > st.window.height - 140) {
      await t.scroll({ x: st.window.width - 150, y: st.window.height / 2 }, 0, dy);
      await sleep(250);
      const h = await find();
      if (h && h.y >= g.y - 0.5) dy = -dy; // that way did not move it up
      continue;
    }
    if (f && Math.abs(g.x - f.x) < 0.5 && Math.abs(g.y - f.y) < 0.5) return g;
    f = g;
    await sleep(120);
  }
  if (!f) throw new Error(`${what} never showed in the inspector`);
  return f;
}
/** A QA frame (QAFrame) in the inspector, in view. */
async function control(t: NT, id: string): Promise<R> {
  await t.waitState((s) => s.frames?.[id], `the control ${id}`, 8000);
  return intoInspector(t, async () => (await t.state()).frames?.[id], id);
}
/** The inspector text field inside a QA frame. */
async function fieldIn(t: NT, frame: R) {
  const f = (await t.fields()).find((x) => x.x >= frame.x - 2 && x.x + x.w <= frame.x + frame.w + 2 && x.y >= frame.y - 4 && x.y + x.h <= frame.y + frame.h + 4);
  if (!f) throw new Error(`no text field in ${JSON.stringify(frame)}`);
  return f;
}

sc("inspector", "Layout guide: + adds a grid, its type menu makes it columns; View > Layout Guides and Control+G hide and show them", { covers: ["layout-guides:inspector", "layout-guides:menu", "layout-guides:keyboard"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["fr_inner"]);
  const guides = () => (t.node("fr_inner")?.metadata?.canvasLayoutGuides ?? []) as any[];
  const plus = await control(t, "guides.plus");
  t.ok(plus.x > (await t.state()).window.width - 380, `the + sits in the inspector (${JSON.stringify(plus)})`);
  await t.click(center(plus));
  await t.waitDisk(() => guides().length === 1, "a layout guide on the frame");
  const g0 = guides()[0];
  t.eq([g0.type, g0.size, g0.color], ["grid", 10, "#FF00001A"], "the default: a 10 px grid, red at 10%");
  await t.waitJs(`window.canvasHost.nav.layoutGuides.some((f) => f.id === "fr_inner")`, "drawn on the canvas");
  // The type menu: Columns.
  const menu = await control(t, "guides.type.Grid 10px");
  await t.click(center(menu));
  await t.pickMenu("Columns");
  await t.waitDisk(() => guides()[0]?.type === "columns", "columns");
  const g = guides()[0];
  t.eq([g.type, g.count, g.align, g.gutter, g.margin, g.color], ["columns", 5, "stretch", 20, 0, "#FF00001A"], "five stretched columns");
  await sleep(400);
  await t.shot(`${OUT}/leftovers-layout-guides-app.png`);
  // View > Layout Guides (its checkmark) and Control+G on the canvas.
  t.eq((await t.cmd("qa.mainmenu", { title: "Layout Guides" })).state, true, "View > Layout Guides is checked");
  t.eq((await t.cmd("qa.mainmenu", { title: "Layout Guides" })).mods & (1 << 18), 1 << 18, "its key is Control+G");
  await t.cmd("qa.mainmenu", { title: "Layout Guides", perform: true });
  await t.waitState((s) => s.layoutGuides === false, "hidden from the menu");
  await t.waitJs(`window.canvasHost.nav.layoutGuides.length === 0`, "none drawn");
  await t.click({ x: 900, y: 640 });
  await t.key("g", ["ctrl"]);
  await t.waitState((s) => s.layoutGuides === true, "shown by Control+G");
  // Shift+G, the second key, is the page's.
  await t.key("g", ["shift"]);
  await t.waitState((s) => s.layoutGuides === false, "hidden by Shift+G");
  await t.key("g", ["ctrl"]);
  await t.waitState((s) => s.layoutGuides === true, "and back");
  await t.waitJs(`window.canvasHost.nav.layoutGuides.length > 0`, "drawn again");
});

sc("inspector", "Typography: paragraph spacing and indent fields, and List style bulleted then numbered", { covers: ["paragraph-settings:mouse", "text-lists:mouse"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.js(`fetch("/api/update", { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ file: window.canvasHost.file, id: "tx_long", props: { content: "First paragraph.\\nSecond one.\\nThird." } }) }); return true;`);
  await t.waitDisk(() => t.node("tx_long")?.content === "First paragraph.\nSecond one.\nThird.", "three paragraphs");
  await t.selectIds(["tx_long"]);
  const sp = await fieldIn(t, await control(t, "type.paragraphSpacing"));
  await t.setField(sp, "12");
  await t.waitDisk(() => t.node("tx_long")?.paragraphSpacing === 12, "paragraph spacing 12");
  const ind = await fieldIn(t, await control(t, "type.paragraphIndent"));
  await t.setField(ind, "20");
  await t.waitDisk(() => t.node("tx_long")?.paragraphIndent === 20, "paragraph indent 20");
  // List style: the middle segment bullets every paragraph, the right one numbers them.
  const ls = await control(t, "type.listStyle");
  const at = (k: number): Pt => ({ x: ls.x + (ls.w * (2 * k + 1)) / 6, y: ls.y + ls.h / 2 });
  await t.click(at(1));
  await t.waitDisk(() => (t.node("tx_long")?.lists ?? []).length === 3 && t.node("tx_long")!.lists.every((l: any) => l.type === "bullet"), "three bullets");
  await t.click(at(2));
  await t.waitDisk(() => (t.node("tx_long")?.lists ?? []).every((l: any) => l.type === "number"), "numbered");
  await t.waitJs(`(() => { const r = window.canvasHost.engineView.textLines("tx_long"); return r && r.marks.length === 3; })()`, "three markers drawn");
  await sleep(400);
  await t.shot(`${OUT}/leftovers-type-details-app.png`);
  await t.click(at(0));
  await t.waitDisk(() => t.node("tx_long")?.lists === undefined, "no list");
});

sc("about", "About Canvas shows the version with its commit and when it was built", { covers: [] }, async (t: NT) => {
  await t.cmd("qa.mainmenu", { title: "About Canvas", perform: true });
  const v = await t.mark({ id: "about-version", window: "about" });
  t.ok(/^Version \d+\.\d+\.\d+ \([0-9a-f]{7,}\)$/.test(v.label ?? ""), `the version line reads "${v.label}"`);
  const b = await t.mark({ id: "about-built", window: "about" });
  t.ok(/20\d\d/.test(b.label ?? ""), `the build date reads "${b.label}"`);
  await t.shot(`${process.cwd()}/qa/out/native/about.png`, "about");
});
