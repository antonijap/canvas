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

sc("draw", "draw tools from the native toolbar", { covers: ["draw:toolbar", "draw:menu", "draw:palette"] }, async (t) => {
  await t.look(-8000, -8000, 1, 70);
  const clickTool = async (label: string) => {
    await t.click(center(await t.mark({ id: "draw-tool", label })));
    await t.waitJs("document.getElementById('view').style.cursor === 'crosshair'", label + " cursor");
  };

  await clickTool("Frame");
  const { webFrame } = await t.state();
  const left = await t.js<number>("return window.canvasHost.viewBox.l + window.canvasHost.insets.l;");
  const p = { x: webFrame.x + left + 50, y: webFrame.y + 220 };
  await t.drag(p, { x: p.x + 230, y: p.y + 175 });
  const board = await t.waitDisk(() => t.disk().children.find((n) => n.name === "Board"), "toolbar drew board");
  await t.waitJs(`window.canvasHost.boards.has(${JSON.stringify(board.id)})`, "drawn board");
  for (const [i, label, type, key] of [
    [1, "Rectangle", "rectangle", "r"], [2, "Ellipse", "ellipse", "o"], [3, "Text", "text", "t"],
  ] as const) {
    const menu = await t.cmd("qa.mainmenu", { title: "Draw " + label });
    t.eq(menu.key, key, label + " menu shortcut");
    await clickTool(label);
    await t.click({ x: p.x + 25 * i, y: p.y + 25 * i });
    const node = await t.waitDisk(() => t.node(board.id!)?.children?.find((n: any) => n.type === type), "toolbar drew " + type);
    if (type === "text") {
      await t.waitJs("window.canvasHost.textEdit?.active", "text editor open");
      await t.key("o");
      t.eq(await t.js("return window.canvasHost.textEdit.value"), "o", "native key types in inline editor");
      await t.key("Escape");
    }
    await t.waitJs(`window.canvasHost.sel === ${JSON.stringify(node.id)}`, label + " selected");
  }

  const frameMenu = await t.cmd("qa.mainmenu", { title: "Draw Frame", perform: true });
  t.eq(frameMenu.key, "f", "frame menu shortcut");
  await t.waitJs("document.getElementById('view').style.cursor === 'crosshair'", "menu arms frame");
  await t.key("Escape");

  await t.key("k", ["cmd"]);
  await t.waitState((s) => s.palette.open, "quick actions open");
  await t.type("Draw Rectangle");
  await t.waitState((s) => s.palette.items.some((item: string) => item.endsWith(": Draw Rectangle")), "draw command in quick actions");
  await t.key("Return");
  await t.waitJs("document.getElementById('view').style.cursor === 'crosshair'", "quick actions arms rectangle");
  await t.key("Escape");
});
