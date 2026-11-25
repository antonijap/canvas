import { center, sc } from "./harness.ts";

sc("sticky", "Sticky tool edits inline in the Mac app", { covers: ["sticky:create", "sticky:edit", "sticky:author"] }, async (t) => {
  await t.cmd("qa.cloud", { commentName: "Anna" });
  await t.showPage("layout");
  await t.look(0, 0);
  const p = center(await t.rect("r_free"));
  await t.key("s");
  await t.click(p);
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
  await t.waitJs('document.querySelector("[data-sticker-tray]")?.offsetWidth', "sticker tray in the app");
  await t.key("l");
  await t.click(p);
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
