import http from "node:http";
import path from "node:path";
import { center, sc, type NT } from "./harness.ts";

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

sc("tools", "bottom tool palette geometry, sticky flyouts, selection and Hide UI", { covers: ["draw:tool-palette", "draw:shortcuts", "draw:hide-ui", "sticky:create", "sticker:place", "sticky:compact-controls", "draw:compact-tooltip"] }, async (t: NT) => {
  const initial = await t.state();
  try {
    await t.cmd("qa.window", { width: 720, height: 560 });
    await t.section("Layers");
    if (!initial.inspectorOpen) await t.cmd("qa.mainmenu", { title: "Show Properties", perform: true });
    const palette = () => t.mark({ id: "tool-palette" });
    const toolButton = (label: string) => t.mark({ id: "draw-tool", label, exact: true });
    const clickTool = async (label: string) => t.click(center(await toolButton(label)));
    const selected = async () => (await t.marks({ id: "draw-tool-selected" })).map((mark) => mark.label);
    const expectSelected = (label?: string) => t.waitFor(async () => {
      const marks = await selected();
      if (label ? marks.length !== 1 || marks[0] !== label : marks.length !== 0) return false;
      const page = await t.js(`const view = document.getElementById("view");
        return { armed: view.style.cursor === "crosshair",
          sticky: !document.querySelector('[aria-label="Sticky colours"]').hidden,
          sticker: !document.querySelector("[data-sticker-tray]").hidden };`);
      return page.armed === !!label && page.sticky === (label === "Sticky") && page.sticker === (label === "Sticker");
    }, label ? label + " highlighted" : "no tool highlighted");
    const bar = await palette();
    const { webFrame } = await t.state();
    const { l, r, b } = await t.js<{ l: number; r: number; b: number }>("return window.canvasHost.insets");
    t.near(webFrame.w, 720, 1, `minimum window width (insets ${l}/${r}, palette ${bar.w}x${bar.h})`);
    t.near(bar.h, 68, 1, "the two palette rows keep their full button height");
    t.near(webFrame.y + webFrame.h - bar.y - bar.h, 14, 1, "palette bottom margin");
    t.near(center(bar).x, webFrame.x + (webFrame.w + l - r) / 2, 1, "palette centered in the free canvas");
    t.ok(l >= 224 && r >= 284, `both sidebars are open (insets ${l}/${r})`);
    t.ok(bar.x >= webFrame.x + l && bar.x + bar.w <= webFrame.x + webFrame.w - r, "palette fits between both sidebars");
    const frame = await toolButton("Frame");
    const sticky = await toolButton("Sticky");
    t.near(frame.x, sticky.x, 1, "both groups start at the same x in the compact palette");
    t.near(sticky.y - frame.y, 32, 1, "the second row keeps the same gap as the buttons");
    t.ok(b > bar.h + 14, "fit reserves room above the palette");
    await t.cmd("qa.hovertool", { tool: "text" });
    try {
      const tip = await t.mark({ id: "tool-tooltip", label: "Text" });
      const zoom = await t.mark({ id: "zoom-island" });
      t.ok(tip.x + tip.w <= zoom.x || tip.x >= zoom.x + zoom.w || tip.y + tip.h <= zoom.y,
        "the Text tooltip clears the zoom controls with both sidebars open");
      await t.cmd("qa.mainmenu", { title: "Hide Properties", perform: true });
      const raisedZoom = await t.mark({ id: "zoom-island" });
      const raisedTip = await t.mark({ id: "tool-tooltip", label: "Text" });
      t.ok(raisedZoom.y + raisedZoom.h < (await palette()).y, "zoom moves above the palette with the right sidebar closed");
      t.ok(raisedTip.y + raisedTip.h <= raisedZoom.y, "the Text tooltip clears the raised zoom controls");
    } finally {
      await t.cmd("qa.hovertool");
      if (!(await t.state()).inspectorOpen) await t.cmd("qa.mainmenu", { title: "Show Properties", perform: true });
      await palette();
    }
    await t.key("1", ["shift"]);
    await t.waitJs(`(() => {
      const h = window.canvasHost, c = h.cam;
      return h.boards.size > 0 && Array.from(h.boards.keys(), id => h.boxOf(id))
        .every(r => h.viewBox.t + c.y + (r.y + r.h) * c.z < ${bar.y - webFrame.y});
    })()`, "fitted boards clear the palette");
    await expectSelected();
    for (const [label, key, mods] of [
      ["Frame", "f", []], ["Rectangle", "r", []], ["Ellipse", "o", []], ["Text", "t", []],
      ["Sticky", "s", []], ["Sticker", "s", ["shift"]],
    ] as const) {
      const button = await toolButton(label);
      t.near(button.w, 28, 1, label + " width");
      t.near(button.h, 28, 1, label + " height");
      t.ok(button.x >= bar.x && button.x + button.w <= bar.x + bar.w, label + " fits inside the palette");
      await t.click(center(button));
      await expectSelected(label);
      await t.key("Escape");
      await expectSelected();
      await t.key(key, [...mods]);
      await expectSelected(label);
      await t.key("Escape");
      await expectSelected();
    }
    const expectFlyout = async (selector: string) => {
      const rect = await t.js<{ left: number; right: number; bottom: number }>(
        `return document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON();`);
      t.ok(rect.bottom + webFrame.y <= bar.y - 9, selector + " clears the native palette");
      t.ok(rect.left >= l && rect.right <= webFrame.w - r, selector + " fits between the sidebars");
    };
    await clickTool("Rectangle");
    await expectSelected("Rectangle");
    await clickTool("Sticky");
    await expectSelected("Sticky");
    await expectFlyout('[aria-label="Sticky colours"]');
    // The background test window does not forward hover moves to the web view here.
    await t.js(`
      const y = document.querySelector('[aria-label="Sticky colours"]').getBoundingClientRect().top - 4;
      const x = ${center(bar).x - webFrame.x};
      window.canvasHost.view.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
    `);
    const hintSelector = ".whiteboard-hint:not([hidden])";
    await t.waitJs(`document.querySelector("${hintSelector}")`, "sticky placement hint");
    const hint = await t.js<{ bottom: number }>(`return document.querySelector("${hintSelector}").getBoundingClientRect().toJSON();`);
    t.ok(hint.bottom + webFrame.y <= bar.y - 9, "sticky hint clears the palette");
    await clickTool("Ellipse");
    await expectSelected("Ellipse");
    await t.key("s", ["shift"]);
    await expectSelected("Sticker");
    await expectFlyout("[data-sticker-tray]");
    // In the sticker tray, letters pick a sticker (R is Rocket); O is no sticker, so it switches tools.
    await t.key("o");
    await expectSelected("Ellipse");
    await clickTool("Sticker");
    await expectSelected("Sticker");
    // S is Star in the tray: leave it first.
    await t.key("Escape");
    await t.key("s");
    await expectSelected("Sticky");
    await t.showPage("style");
    await expectSelected();

    await t.key("f");
    await expectSelected("Frame");
    await t.click({ x: bar.x + 3, y: center(bar).y });
    t.eq(await t.js("return document.getElementById('view').style.cursor"), "crosshair", "palette padding absorbs clicks");
    await t.shot(path.resolve("qa/out/native/tool-palette-720.png"));
    await t.showPage("layout");
    await expectSelected();

    await t.key("o");
    await expectSelected("Ellipse");
    await t.click(center(await t.mark({ id: "home-tab" })));
    await t.waitFor(async () => (await t.marks({ id: "draw-tool" })).length === 0, "Home hides the tools");
    await t.systemClick(center(await t.mark({ id: "file-tab", label: path.basename(t.file, ".canvas"), exact: true })));
    await t.waitState(s => !s.homeShown && s.file === t.file, "the file tab to return from Home");
    await palette();
    await expectSelected();
    await t.waitJs("document.getElementById('view').style.cursor !== 'crosshair'", "returning from Home clears the drawing cursor");

    await clickTool("Sticker");
    await expectSelected("Sticker");
    const previousLoad = await t.js<number>("return performance.timeOrigin");
    await t.js("setTimeout(() => location.reload(), 0);");
    await t.waitJs(`window.canvasHost && performance.timeOrigin !== ${previousLoad}`, "the reloaded canvas");
    await t.settle();
    await expectSelected();

    await t.key("\\", ["cmd"]);
    await t.waitFor(async () => (await t.marks({ id: "draw-tool" })).length === 0, "Hide UI hides the tools");
    await t.key("\\", ["cmd"]);
    await palette();

    await t.key("f");
    await expectSelected("Frame");
    const pageURL = await t.js<string>("return location.href");
    let pending: http.ServerResponse | undefined;
    // Hold the navigation before it commits so the old canvas can still take input.
    const server = http.createServer((_req, res) => { pending = res; });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as { port: number };
      await t.js(`window.__qaOutgoingCanvas = true;
        setTimeout(() => location.assign("http://127.0.0.1:${address.port}/"), 0);`);
      const response = await t.waitFor(() => Promise.resolve(pending), "provisional navigation request");
      t.eq(await t.js("return window.__qaOutgoingCanvas"), true, "the old canvas is still loaded");
      const armed = await t.js("return document.getElementById('view').style.cursor === 'crosshair'");
      t.eq((await selected()).includes("Frame"), armed, "highlight matches the old canvas during navigation");
      response.writeHead(302, { Location: pageURL });
      response.end();
      await t.waitJs("!window.__qaOutgoingCanvas && window.canvasHost", "the replacement canvas");
      await expectSelected();
      await t.settle();
      t.eq(await t.js("return document.getElementById('view').style.cursor"), "", "the new canvas has no tool armed");
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }

    await t.click(center(await t.mark({ id: "properties-toggle" })));
    await t.waitState(s => !s.inspectorOpen, "properties closed");
    const resize = center(await t.mark({ id: "sidebar-resize" }));
    await t.drag(resize, { x: resize.x + 300, y: resize.y });
    const widePanel = await t.mark({ id: "sidebar-panel" });
    const zoom = await t.mark({ id: "zoom-island" });
    const shifted = await palette();
    t.ok(widePanel.w >= 400, "the left sidebar is wide enough to bring the tools under zoom");
    t.ok(shifted.x + shifted.w > zoom.x && zoom.y + zoom.h < shifted.y, "zoom moves up when it would overlap");
    await clickTool("Sticker");
    await expectSelected("Sticker");
    const shiftedTray = await t.js<number>('return document.querySelector("[data-sticker-tray]").getBoundingClientRect().bottom');
    t.ok(shiftedTray + webFrame.y <= zoom.y - 9, "sticker tray also clears the raised zoom controls");
    await t.key("Escape");
    await expectSelected();

    if (process.env.CANVAS_PALETTE_SHOT) {
      await t.cmd("qa.window", { width: 1100, height: 700 });
      const { theme } = await t.cmd<{ theme: string }>("qa.theme");
      try {
        await t.cmd("qa.theme", { theme: "dark" });
        await t.key("1", ["shift"]);
        await t.settle();
        await clickTool("Rectangle");
        await expectSelected("Rectangle");
        await t.move(center(await toolButton("Ellipse")));
        await t.shot(path.resolve(process.env.CANVAS_PALETTE_SHOT));
      } finally {
        await t.key("Escape");
        await t.cmd("qa.theme", { theme });
      }
    }
  } finally {
    await t.cmd("qa.window", { width: initial.window.width, height: initial.window.height });
    if ((await t.state()).uiHidden !== initial.uiHidden) await t.key("\\", ["cmd"]);
    if ((await t.state()).sidebarWidth !== initial.sidebarWidth) {
      const resize = await t.mark({ id: "sidebar-resize" });
      const start = center(resize);
      await t.drag(start, { x: start.x + initial.sidebarWidth - (await t.state()).sidebarWidth, y: start.y });
    }
    if ((await t.state()).inspectorOpen !== initial.inspectorOpen)
      await t.click(center(await t.mark({ id: "properties-toggle" })));
    if ((await t.state()).panelOpen !== initial.panelOpen) await t.click(await t.sidebarToggle());
  }
});

sc("draw", "native draw palette can leave a focused comment draft", { covers: ["draw:palette"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.settle();
  const { webFrame } = await t.state();
  const left = await t.js<number>("return window.canvasHost.insets.l;");
  await t.key("c");
  await t.click({ x: webFrame.x + left + 70, y: webFrame.y + 200 });
  const field = "document.querySelector('.cm-comp .cm-field')";
  await t.waitJs(`${field} === document.activeElement`, "comment composer takes focus");
  await t.type("Draft note");
  await t.key("r");
  t.eq(await t.js(`return ${field}.value;`), "Draft noter", "the draw shortcut still types in the comment");
  await t.click(center(await t.mark({ id: "draw-tool", label: "Rectangle" })));
  await t.mark({ id: "draw-tool-selected", label: "Rectangle" }, 3500);
  t.eq(await t.js(`return {draft: ${field}.value, focused: ${field} === document.activeElement,
    commenting: document.getElementById('view').classList.contains('cm-mode')};`),
    { draft: "Draft noter", focused: false, commenting: false }, "the tool takes over the canvas and keeps the draft");
});

sc("draw", "draw tools from the native palette and commands", { covers: ["draw:tool-palette", "draw:menu", "draw:palette"] }, async (t) => {
  await t.section("Layers");
  await t.look(-8000, -8000, 1, 70);
  const sectionMenu = { id: "sidebar-section-popup" };
  const openSectionMenu = async () => {
    await t.click(center(await t.mark({ id: "sidebar-section-menu" })));
    await t.mark(sectionMenu);
  };
  const expectMenuClosed = (source: string) =>
    t.waitFor(async () => (await t.marks(sectionMenu)).length === 0, source + " dismisses the sidebar menu");
  const clickTool = async (label: string) => {
    await t.click(center(await t.mark({ id: "draw-tool", label })));
    await t.waitJs("document.getElementById('view').style.cursor === 'crosshair'", label + " cursor");
  };
  const expectCleared = () => t.waitFor(async () => (await t.marks({ id: "draw-tool-selected" })).length === 0, "placing a layer clears the tool highlight");

  await openSectionMenu();
  await clickTool("Frame");
  await expectMenuClosed("The tool palette");
  const { webFrame } = await t.state();
  const left = await t.js<number>("return window.canvasHost.viewBox.l + window.canvasHost.insets.l;");
  const p = { x: webFrame.x + left + 50, y: webFrame.y + 220 };
  await t.drag(p, { x: p.x + 230, y: p.y + 175 });
  const board = await t.waitDisk(() => t.disk().children.find((n) => n.name === "Board"), "palette drew board");
  await expectCleared();
  await t.waitJs(`window.canvasHost.boards.has(${JSON.stringify(board.id)})`, "drawn board");
  for (const [i, label, type, key] of [
    [1, "Rectangle", "rectangle", "r"], [2, "Ellipse", "ellipse", "o"], [3, "Text", "text", "t"],
  ] as const) {
    const menu = await t.cmd("qa.mainmenu", { title: "Draw " + label });
    t.eq(menu.key, key, label + " menu shortcut");
    await clickTool(label);
    await t.click({ x: p.x + 25 * i, y: p.y + 25 * i });
    const node = await t.waitDisk(() => t.node(board.id!)?.children?.find((n: any) => n.type === type), "palette drew " + type);
    await expectCleared();
    if (type === "text") {
      await t.waitJs("window.canvasHost.textEdit?.active", "text editor open");
      await t.key("o");
      t.eq(await t.js("return window.canvasHost.textEdit.value"), "o", "native key types in inline editor");
      await t.key("Escape");
    }
    await t.waitJs(`window.canvasHost.sel === ${JSON.stringify(node.id)}`, label + " selected");
  }

  await openSectionMenu();
  const frameMenu = await t.cmd("qa.mainmenu", { title: "Draw Frame", perform: true });
  t.eq(frameMenu.key, "f", "frame menu shortcut");
  await t.waitJs("document.getElementById('view').style.cursor === 'crosshair'", "menu arms frame");
  await t.mark({ id: "draw-tool-selected", label: "Frame", exact: true });
  await expectMenuClosed("The Draw menu");
  await openSectionMenu();
  await t.key("f");
  await expectMenuClosed("The shortcut for the selected tool");
  await t.key("Escape");

  await openSectionMenu();
  await t.key("k", ["cmd"]);
  await t.waitState((s) => s.palette.open, "quick actions open");
  await t.type("Draw Rectangle");
  await t.waitState((s) => s.palette.items.some((item: string) => item.endsWith(": Draw Rectangle")), "draw command in quick actions");
  await t.key("Return");
  await t.waitJs("document.getElementById('view').style.cursor === 'crosshair'", "quick actions arms rectangle");
  await t.mark({ id: "draw-tool-selected", label: "Rectangle", exact: true });
  await expectMenuClosed("Quick Actions");
  await t.key("Escape");
});
