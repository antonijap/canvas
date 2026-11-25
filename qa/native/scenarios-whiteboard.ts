import { center, sc, type NT } from "./harness.ts";
import fs from "node:fs";
import path from "node:path";

sc("vote", "Vote on a sticky and reveal the conclusion in the Mac app", { covers: ["vote:start", "vote:ballot", "vote:privacy", "vote:results", "sticky:handles"] }, async (t: NT) => {
  await t.cmd("qa.cloud", { commentName: "Anna" });
  await t.showPage("layout");
  await t.look(0, 0);
  const p = center(await t.rect("r_free"));
  await t.key("s");
  await t.click({ x: p.x - 120, y: p.y });
  await t.waitJs("window.canvasHost.textEdit.active", "sticky editor");
  const [note] = await t.pageSel();
  await t.key("a");
  await t.key("Escape");
  await t.waitDisk(() => t.node(note)?.content === "a", "the sticky is saved");
  const handles = `(() => {
    const below = document.querySelector(".sticky-next-below:not([hidden])");
    const right = document.querySelector(".sticky-next-right:not([hidden])");
    const badge = document.querySelector("#seldim");
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return below && right && badge && { below: box(below), badge: box(badge), right: box(right) };
  })()`;
  await t.waitJs(handles, "sticky quick-add handles");
  await t.look(0, 0, 0.25);
  await t.waitJs(`(${handles}) && window.canvasHost.cam.z === 0.25`, "small sticky with quick-add handles");
  const spark = await t.mark({ id: "canvas-spark-spark" });
  const { below, badge, right } = await t.js(`return ${handles};`);
  const { webFrame } = await t.state();
  const overlaps = (a: typeof right, b: typeof right) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  t.ok(!overlaps(below, badge), "the add-below handle clears the size badge");
  t.ok(!overlaps({ ...right, x: right.x + webFrame.x, y: right.y + webFrame.y }, spark), "the add-right handle clears Ask about this");
  await t.look(0, 0);
  await t.key("d", ["shift"]);
  const click = async (selector: string) => {
    const rect = `document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect()`;
    await t.waitJs(`${rect}?.width`, selector);
    const at = await t.js(`const r = ${rect}; return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
    const { webFrame } = await t.state();
    await t.click({ x: at.x + webFrame.x, y: at.y + webFrame.y });
  };
  await click("[data-vote-anonymous]");
  await click("[data-vote-start]");
  await t.waitJs('document.querySelector("[data-vote-end]")?.offsetWidth', "vote started");
  await t.click(center(await t.rect(note)));
  await t.waitJs('document.querySelector("[data-vote-mark]")', "my dot appears during the vote");
  await click("[data-vote-end]");
  await t.waitJs('document.querySelector("[data-vote-results]:not([hidden])")?.textContent.includes("Anonymous")', "anonymous result");
  const vote = JSON.parse(fs.readFileSync(path.join(t.file, "comments.json"), "utf8")).votes[0];
  t.eq([vote.host.name, vote.ballots[0].voter.name, vote.ballots[0].layer], [undefined, undefined, note], "anonymous vote stores no name");
});

async function expectTool(t: import("./harness.ts").NT, label?: string) {
  await t.waitFor(async () => {
    const marks = await t.marks({ id: "draw-tool-selected" });
    const placing = await t.js('return document.querySelector(".whiteboard-layer").hasAttribute("data-placing");');
    return placing === !!label && (label ? marks.length === 1 && marks[0].label === label : marks.length === 0);
  }, label ? label + " armed and highlighted" : "placement clears the tool and its highlight");
}

sc("sticky", "Sticky tool edits inline in the Mac app", { covers: ["sticky:create", "sticky:edit", "sticky:author"] }, async (t) => {
  await t.cmd("qa.cloud", { commentName: "Anna" });
  await t.showPage("layout");
  await t.look(0, 0);
  const p = center(await t.rect("r_free"));
  await t.key("s");
  await expectTool(t, "Sticky");
  await t.click(p);
  await expectTool(t);
  await t.waitJs("window.canvasHost.textEdit.active", "sticky editor in the app");
  const [id] = await t.pageSel();
  await t.key("a");
  await t.key("Escape");
  await t.waitDisk(() => t.node(id)?.content === "a", "the sticky edit on disk");
  t.eq([t.node(id)?.type, t.node(id)?.author?.name], ["sticky", "Anna"], "note carries the name from Settings");
});

sc("sticker", "Sticker tool places an anchored seal in the Mac app", { covers: ["sticker:place", "sticker:anchor", "sticker:author"] }, async (t) => {
  await t.cmd("qa.cloud", { commentName: "Anna" });
  await t.showPage("layout");
  await t.look(0, 0);
  const p = center(await t.rect("r_free"));
  await t.key("s", ["shift"]);
  await expectTool(t, "Sticker");
  await t.waitJs('document.querySelector("[data-sticker-tray]")?.offsetWidth', "sticker tray in the app");
  await t.key("l");
  await t.click(p);
  await expectTool(t);
  await t.waitJs('window.canvasHost.sel !== null && !!document.querySelector("[data-sticker-seal]")', "seal in the app");
  const [id] = await t.pageSel();
  await t.waitDisk(() => t.node(id)?.type === "sticker", "the sticker on disk");
  t.eq([t.node(id)?.kind, t.node(id)?.on?.layer, t.node(id)?.by?.name], ["love", "r_free", "Anna"], "saved sticker, anchor and author");

  await t.key(",", ["cmd"]);
  await t.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
  const toggle = await t.mark({ id: "whiteboard-show-name", window: "settings" }, 4000);
  await t.click(center(toggle), { window: "settings" });
  await t.waitJs('window.canvasHost.prefs().whiteboardName === ""', "the name setting off on the canvas");
  await t.click({ x: 14, y: 14 }, { window: "settings" });
  await t.waitState((s) => !s.windows.some((w: any) => w.settings), "Settings closed");
  await t.key("s", ["shift"]);
  await t.click(p);
  await t.waitJs(`window.canvasHost.sel !== ${JSON.stringify(id)} && !!window.canvasHost.sel`, "second sticker selected");
  const [anonymous] = await t.pageSel();
  await t.waitDisk(() => t.node(anonymous)?.type === "sticker", "anonymous sticker saved");
  t.eq(t.node(anonymous)?.by, undefined, "no name written on new stickers when the switch is off");
  await t.key("s");
  await t.click({ x: p.x - 140, y: p.y });
  await t.waitJs("window.canvasHost.textEdit.active", "the anonymous sticky editor");
  const [note] = await t.pageSel();
  await t.key("Escape");
  await t.waitDisk(() => t.node(note)?.type === "sticky", "anonymous sticky saved");
  t.eq([t.node(note)?.author, t.node(note)?.showAuthor], [undefined, false], "the sticky stores no name");
  await t.key(",", ["cmd"]);
  await t.click(center(await t.mark({ id: "whiteboard-show-name", window: "settings" }, 4000)), { window: "settings" });
  await t.waitJs('window.canvasHost.prefs().whiteboardName === "Anna"', "the name setting restored");
  await t.click({ x: 14, y: 14 }, { window: "settings" });
});

sc("whiteboard-review", "Sticky author removal clears disk and undo restores it", { covers: ["sticky:author-removal"] }, async (t: NT) => {
  await t.cmd("qa.cloud", { commentName: "Anna" });
  await t.showPage("layout");
  await t.look(0, 0);
  const p = center(await t.rect("r_free"));
  await t.key("s");
  await t.click(p);
  await t.waitJs("window.canvasHost.textEdit.active", "sticky text editor");
  const [id] = await t.pageSel();
  await t.key("Escape");
  await t.waitDisk(() => t.node(id)?.author?.name === "Anna", "sticky author before removal");
  const author = 'document.querySelector(".sticky-author")';
  await t.waitJs(author + '?.getAttribute("aria-pressed") === "true"', "author toggle");
  const rect = await t.js(`const r = ${author}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  const { webFrame } = await t.state();
  await t.click({ x: rect.x + webFrame.x, y: rect.y + webFrame.y });
  await t.waitDisk(() => !t.node(id)?.author, "author removed from disk");
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => t.node(id)?.author?.name === "Anna", "undo restores the author");
});
