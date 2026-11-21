import path from "node:path";
import { center, sc } from "./harness.ts";

sc("blueprint", "blueprint inspector controls and undo", { covers: ["blueprint:inspector", "blueprint:undo"] }, async (t) => {
  await t.cmd("deselect");
  if (!(await t.state()).inspectorOpen) await t.cmd("qa.mainmenu", { title: "Show Properties", perform: true });
  const page = (await t.state()).activePage;
  const savedPage = () => t.widgets().pages.find((p: any) => p.id === page);
  const stored = () => savedPage()?.pattern;
  await t.setField(await t.fieldBelow("Background"), "E9EDF2");
  await t.waitDisk(() => savedPage()?.background === "#E9EDF2", "background color saved");
  await t.click(center(await t.mark({ id: "page-blueprint" })));
  await t.waitDisk(() => stored()?.kind === "blueprint", "blueprint enabled");
  await t.setField(await t.fieldBelow("Spacing"), "16");
  await t.waitDisk(() => stored()?.spacing === 16, "spacing saved");
  await t.setField(await t.fieldBelow("Major every"), "4");
  await t.waitDisk(() => stored()?.major === 4, "major interval saved");
  await t.click(center(await t.mark({ id: "page-blueprint-opacity" })));
  await t.waitDisk(() => stored()?.opacity > 35, "line visibility saved");
  await t.setField(await t.fieldBelow("Line color"), "336699");
  await t.waitDisk(() => stored()?.lineColor === "#336699", "line color saved");
  await t.shot(path.resolve("qa/out/native/blueprint-inspector.png"));
  await t.click({ x: 600, y: 500 });
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => stored() && !stored().lineColor, "undo resets line color");
  await t.click(center(await t.mark({ id: "page-color" })));
  await t.waitDisk(() => !stored() && savedPage()?.background === "#E9EDF2", "color mode restored");

  t.eq(await t.js("return window.canvasHost.snap().blueprint"), true, "blueprint snapping defaults on");
  await t.key(",", ["cmd"]);
  await t.waitState((s) => s.windows.some((w: any) => w.settings), "Settings open");
  const canvasTab = await t.waitFor(async () => (await t.views("settings")).find((v) => v.class === "NSToolbarButton" && v.label === "Canvas"), "Canvas settings tab");
  await t.click(center(canvasTab), { window: "settings" });
  await t.click(center(await t.mark({ id: "snap-to-blueprint", window: "settings" })), { window: "settings" });
  await t.waitFor(async () => (await t.js("return window.canvasHost.snap().blueprint")) === false, "blueprint snapping disabled");
});
