import fs from "node:fs";
import path from "node:path";
import { decodePng } from "../../fidelity/png.ts";
import { METRICS } from "../../src/tokens.ts";
import { center, sc, type NT } from "./harness.ts";
import { copyDir } from "../lib.ts";

const sections = ["Layers", "Assets", "Tokens", "Widgets"] as const;
const kinds = ["todo", "note", "shader", "video", "git-status", "ci", "claude-usage", "metric", "page-preview", "disk-space"];
const header = (t: NT) => t.mark({ id: "sidebar-section-menu" });
const freeWidth = (t: NT) => t.js<number>("return document.querySelector('#view').clientWidth - canvasHost.insets.l - canvasHost.insets.r;");
const shotDir = process.env.CANVAS_SIDEBAR_SHOTS;

async function captureStudio(t: NT, dir: string) {
  const { inspectorOpen, window: { width, height } } = await t.state();
  const toggleInspector = async () => t.click(center(await t.mark({ id: "properties-toggle" })));
  const shot = async (name: string) => {
    await t.move({ x: 640, y: 70 });
    await t.cmd("qa.idle", { ms: 240 });
    await t.shot(path.join(dir, name + ".png"));
  };
  fs.mkdirSync(dir, { recursive: true });
  try {
    await t.cmd("qa.window", { width: 1320, height: 760 });
    if (inspectorOpen) await toggleInspector();
    await t.section("Layers");
    await t.js("canvasHost.setCam({ z: 0.72, x: 128, y: 138 });");
    await t.settle();
    const { r: board } = await t.layerRow("lay_nest");
    await t.click({ x: board.x + 8, y: center(board).y });
    await shot("studio-layers");

    await t.click(await t.sidebarToggle());
    await t.waitFor(async () => !(await t.marks({ id: "sidebar-panel" })).length, "the panel to leave the studio canvas");
    await shot("studio-hidden");
    await t.section("Widgets");
    await t.mark({ id: "widget-preview-disk-space" });
    await shot("studio-widgets");
  } finally {
    if (inspectorOpen !== (await t.state()).inspectorOpen) await toggleInspector();
    await t.cmd("qa.window", { width, height });
  }
}

sc("sidebar", "right panels dock and align with the Layers header", { covers: ["sidebar:menu"] }, async (t: NT) => {
  await t.section("Layers");
  await t.showPage("layout");
  await t.selectIds(["lay_nest"]);
  if (!(await t.state()).inspectorOpen) await t.click(center(await t.mark({ id: "properties-toggle" })));
  await t.settle();
  const { window } = await t.state();
  const leftHeader = await header(t);
  const docked = (panel: { x: number; y: number; w: number; h: number }, title: { y: number; h: number }, name: string, width: number) => {
    t.near(panel.x + panel.w, window.width, 1, name + " reaches the right edge");
    t.near(panel.y, METRICS.topBar, 1, name + " starts below the top bar");
    t.near(panel.y + panel.h, window.height, 1, name + " reaches the bottom");
    t.near(panel.w, width, 1, name + " panel width");
    t.near(title.h, METRICS.control, 1, name + " header height");
    t.near(title.y + title.h / 2, center(leftHeader).y, 1, name + " header centre");
  };
  const inspector = await t.mark({ id: "right-sidebar-panel" });
  docked(inspector, await t.mark({ id: "right-sidebar-header" }), "Inspector", METRICS.propsWidth);
  const action = await t.mark({ id: "inspector-header-action" });
  t.near(action.w, 28, 0.5, "the inspector action is 28 pt wide");
  t.near(action.h, 28, 0.5, "the inspector action is 28 pt high");
  const trailingX = center(action).x;
  const checkZoom = async (name: string, width: number) => {
    const zoom = await t.mark({ id: "zoom-island" });
    t.near(zoom.x + zoom.w, window.width - width - METRICS.inset, 1, name + " leaves the normal gap before zoom");
    await t.waitFor(async () => await t.js("return canvasHost.insets.r;") === width + METRICS.gap,
      name + " reserves its width and gap on the canvas");
  };
  await checkZoom("Inspector", METRICS.propsWidth);
  await t.click(center(await t.mark({ id: "comments-toggle" })));
  await t.waitJs("!!document.querySelector('.cm-sidebar:not([hidden]) .cm-sidebar-head')", "Comments opens");
  const rects = await t.js<{ panel: typeof inspector; title: typeof leftHeader; close: typeof leftHeader }>(`
    const rect = (selector) => {
      const { x, y, width: w, height: h } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, w, h };
    };
    return { panel: rect('.cm-sidebar'), title: rect('.cm-sidebar-head'), close: rect('.cm-sidebar-head .right-sidebar-close') };
  `);
  docked(rects.panel, rects.title, "Comments", METRICS.sidebarWidth);
  t.near(rects.close.w, 28, 0.5, "Close is 28 pt wide");
  t.near(rects.close.h, 28, 0.5, "Close is 28 pt high");
  t.near(center(rects.close).x, trailingX, 1, "Close aligns with the inspector action");
  await checkZoom("Comments", METRICS.sidebarWidth);
  await t.click(center(rects.close));
  await t.waitJs("document.querySelector('.cm-sidebar').hidden", "Comments closes");
});

sc("sidebar", "Properties switches back from Comments", { covers: ["sidebar:properties"] }, async (t: NT) => {
  const properties = async () => center(await t.mark({ id: "properties-toggle" }));
  if (!(await t.state()).inspectorOpen) await t.click(await properties());
  await t.mark({ id: "right-sidebar-panel" });
  await t.click(center(await t.mark({ id: "comments-toggle" })));
  await t.waitJs("!document.querySelector('.cm-sidebar').hidden", "Comments opens");
  await t.click(await properties());
  await t.waitJs("document.querySelector('.cm-sidebar').hidden", "Properties closes Comments", 3500);
  await t.mark({ id: "right-sidebar-panel" });
  await t.click(await properties());
  await t.waitState(s => !s.inspectorOpen, "Properties can still hide its own panel");
  await t.click(await properties());
  await t.mark({ id: "right-sidebar-panel" });
});

sc("sidebar", "section menu switches panels and remembers the selection", {
  covers: ["sidebar:menu", "sidebar:restore", "sidebar:toggle", "sidebar:previews"],
}, async (t: NT) => {
  if (!(await t.state()).panelOpen) await t.click(await t.sidebarToggle());
  await t.cmd("qa.theme", { theme: "dark" });
  await t.section("Layers");
  const trigger = await header(t);
  const title = await t.mark({ id: "sidebar-section-title", label: "Layers", exact: true });
  const openMenu = async () => {
    await t.click(center(trigger));
    return t.mark({ id: "sidebar-section-popup" });
  };
  const popup = await openMenu();
  t.near(popup.y, trigger.y + trigger.h + 2, 1, "the menu sits just below the title button");
  t.near(popup.x, title.x, 0.5, "the menu starts at the title text");
  const panel = await t.mark({ id: "sidebar-panel" });
  for (const x of [panel.x + panel.w - 8, panel.x + panel.w + 24]) {
    await t.click({ x, y: center(popup).y });
    await t.waitFor(async () => !(await t.marks({ id: "sidebar-section-popup" })).length, "a click outside to dismiss the menu");
    t.eq((await t.state()).section, "Layers", "dismissing the menu leaves Layers selected");
    await openMenu();
  }
  t.eq((await t.marks({ id: "sidebar-section" })).map(item => item.label).sort(), [...sections].sort(),
    "the menu has all four sections");
  await t.click(center(await t.mark({ id: "sidebar-section", label: "Layers", exact: true })));
  await t.mark({ id: "page-row", label: "layout", exact: true });
  await t.layerRow("lay_nest");
  const shown = await t.mark({ id: "sidebar-panel" });
  t.near(shown.x, 0, 0.5, "sidebar is flush with the left edge");
  t.near(shown.y, 38, 0.5, "sidebar starts below the top bar");
  t.near(shown.w, METRICS.sidebarWidth, 0.5, "sidebar opens at its default width");
  t.near(shown.y + shown.h, (await t.state()).window.height, 1, "sidebar reaches the bottom of the window");
  t.near((await header(t)).h, 28, 0.5, "section button is 28 pt tall");

  const open = await t.mark({ id: "sidebar-toggle", label: "Hide panel", exact: true });
  const w = await freeWidth(t);
  await t.click(center(open));
  await t.waitState(s => !s.panelOpen, "the sidebar to close");
  await t.waitFor(async () => !(await t.marks({ id: "sidebar-panel" })).length, "the entire panel to leave");
  const closed = await t.mark({ id: "sidebar-toggle", label: "Show panel", exact: true });
  t.near(closed.x, open.x, 0.5, "toggle keeps its x position");
  t.near(closed.y, open.y, 0.5, "toggle keeps its y position");
  await t.waitFor(async () => (await freeWidth(t)) > w, "the free canvas to grow");
  await t.click(center(closed));
  await t.mark({ id: "sidebar-section-menu", label: "Layers", exact: true });
  await t.waitFor(async () => (await freeWidth(t)) === w, "the canvas to return to its shown width");

  await t.section("Assets");
  await t.mark({ label: "Button/Primary", exact: true });
  t.eq((await t.marks({ id: "sidebar-search" })).length, 0, "Assets has no search button");
  await t.section("Tokens");
  const search = await t.mark({ id: "sidebar-search" });
  t.near(search.w, 28, 0.5, "the search button is 28 pt wide");
  t.near(search.h, 28, 0.5, "the search button is 28 pt high");
  await t.click({ x: search.x + search.w - 2, y: center(search).y });
  await t.mark({ label: "Search text styles", exact: true });
  await t.waitState(s => /FieldEditor|TextView/.test(s.window.firstResponder ?? ""), "the token search field to focus");
  await t.section("Widgets");
  const pixels = await t.cmd<{ data: string; width: number }>("qa.shot");
  const img = decodePng(Buffer.from(pixels.data, "base64"));
  const scale = pixels.width / (await t.state()).window.width;
  for (const id of kinds) {
    const preview = await t.mark({ id: "widget-preview-" + id });
    t.near(preview.w, 112, 0.5, id + " preview width");
    t.near(preview.h, 72, 0.5, id + " preview height");
    const colors = new Set<string>();
    for (let y = 8; y < 64; y += 4) for (let x = 8; x < 104; x += 4) {
      const index = (Math.floor((preview.y + y) * scale) * img.width + Math.floor((preview.x + x) * scale)) * 4;
      colors.add(img.data.subarray(index, index + 3).toString());
    }
    t.ok(colors.size > 4, id + " draws visible artwork");
  }

  const second = path.join(t.app.docs, "Studio.canvas");
  copyDir(t.file, second);
  if (shotDir) {
    const file = path.join(second, "widgets.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.pages[0].background = "#18181B";
    fs.writeFileSync(file, JSON.stringify(data));
  }
  try {
    await t.app.openShown(second);
    await t.waitState(s => s.file === second, "the second file to open");
    if (shotDir) await captureStudio(t, shotDir);
    await t.section("Assets");
    await t.app.openShown(t.file);
    await t.waitState(s => s.file === t.file && s.section === "Widgets", "the first file to restore Widgets");
  } finally {
    await t.cmd("close", { file: second });
  }
  await t.app.relaunch();
  await t.waitState(s => s.section === "Widgets", "the app to restore Widgets at launch");
});

sc("sidebar", "keyboard shortcuts open sections and toggle editor UI", {
  covers: ["sidebar:keyboard"],
}, async (t: NT) => {
  for (const [i, section] of sections.entries()) {
    await t.key(String(i + 1), ["alt"]);
    await t.waitState(s => s.section === section && s.panelOpen, "Option shortcut opens " + section);
  }
  await t.click(center(await t.mark({ id: "widget-tile-todo" })));
  const input = "document.querySelector('.td-add input')";
  await t.waitJs(input, "the To-do input");
  const field = await t.js<{x: number; y: number}>(`const r = ${input}.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`);
  await t.click(field);
  await t.waitJs(`document.activeElement === ${input}`, "the To-do input to focus");
  await t.key("1", ["alt"]);
  await t.waitJs(`${input}.value.length > 0`, "Option+1 to type in the To-do input");
  t.eq((await t.state()).section, "Widgets", "typing in the widget leaves the section alone");

  await t.js("canvasHost.setSelection(['r_free'])");
  await t.waitJs("canvasHost.sel === 'r_free'", "a selected layer");
  await t.click(center(await header(t)));
  await t.mark({ id: "sidebar-section", label: "Widgets", exact: true });
  await t.key("Escape");
  await t.waitFor(async () => !(await t.marks({ id: "sidebar-section" })).length, "Escape to close the popup");
  t.eq(await t.js("return canvasHost.sel"), "r_free", "Escape leaves the canvas selection alone");
  await t.click(center(await header(t)));
  await t.key("Up");
  await t.key("Return");
  await t.waitState(s => s.section === "Tokens", "the popup to handle Up and Return");
  await t.section("Widgets");
  const command = async (title: string) => {
    await t.key("k", ["cmd"]);
    await t.waitState(s => s.palette.open, "the command palette to open");
    await t.type(title);
    await t.waitState(s => s.palette.items.some((item: string) => item.endsWith(title)), "the " + title + " command");
    await t.key("Return");
    await t.waitState(s => !s.palette.open, "the command palette to close");
  };
  await command("Hide Left Panel");
  await t.waitState(s => !s.panelOpen, "the palette to close the sidebar");
  await command("Show Left Panel");
  await t.waitState(s => s.panelOpen && s.section === "Widgets", "the palette to reopen Widgets");
  await t.key("\\", ["cmd"]);
  await t.waitState(s => s.uiHidden, "the View menu shortcut to hide the editor controls");
  await t.waitFor(async () => !(await t.marks({ id: "sidebar-toggle" })).length, "the toggle to hide with the controls");
  await t.key("\\", ["cmd"]);
  await t.waitState(s => !s.uiHidden && s.section === "Widgets", "the View menu shortcut to restore the editor controls");
});

sc("sidebar", "the editor sidebar resize handle clamps and saves its width", {
  covers: ["sidebar-resize:editor"],
}, async (t: NT) => {
  await t.section("Layers");
  const edge = async (atHeader = false) => {
    const panel = await t.mark({ id: "sidebar-panel" });
    return {
      x: panel.x + panel.w - 1,
      y: atHeader ? panel.y + METRICS.control / 2 : center(panel).y,
    };
  };
  for (const [i, section] of sections.entries()) {
    await t.section(section);
    const from = await edge(true);
    const width = (await t.state()).sidebarWidth as number;
    const dx = i % 2 === 0 ? 30 : -30;
    await t.drag(from, { x: from.x + dx, y: from.y });
    const expected = width + dx;
    await t.waitState(s => s.sidebarWidth === expected, `${section} right edge beside the header to resize to ${expected} pt`);
    t.near((await t.mark({ id: "sidebar-panel" })).w, expected, 0.5, `${section} shows the new width`);
  }
  const from = await edge();
  await t.drag(from, { x: from.x - 900, y: from.y });
  await t.waitState(s => s.sidebarWidth === METRICS.sidebarMin, "the sidebar to reach its minimum width");
  await t.section("Widgets");
  const narrow = await edge();
  await t.drag(narrow, { x: narrow.x + 650, y: narrow.y });
  await t.waitState(s => s.sidebarWidth === METRICS.sidebarMax, "the sidebar to reach its maximum width");
  t.near((await t.mark({ id: "sidebar-panel" })).w, METRICS.sidebarMax, 0.5, "the maximum width is visible");
  await t.app.relaunch();
  await t.waitState(s => s.sidebarWidth === METRICS.sidebarMax, "the maximum width to survive relaunch");
  t.near((await t.mark({ id: "sidebar-panel" })).w, METRICS.sidebarMax, 0.5, "the saved width is visible after relaunch");
  await t.doubleClick(await edge(true));
  await t.waitState(s => s.sidebarWidth === METRICS.sidebarWidth, "the default width to return");
});

sc("sidebar", "the editor sidebar remembers its scroll position", {
  covers: ["sidebar:scroll"],
}, async (t: NT) => {
  await t.section("Widgets");
  const { width, height } = (await t.state()).window;
  await t.cmd("qa.window", { width, height: 500 });
  try {
    const tile = () => t.mark({ id: "widget-preview-git-status" });
    const before = await tile();
    await t.scroll(center(before), 0, -115);
    await t.waitFor(async () => (await tile()).y < before.y - 10, "Widgets to scroll down");
    await t.cmd("qa.idle", { ms: 250 });
    const scrolled = await tile();
    await t.section("Layers");
    await t.section("Widgets");
    t.near((await tile()).y, scrolled.y, 2, "Widgets restores its scroll position");
    await t.key("\\", ["cmd"]);
    await t.waitState(s => s.uiHidden, "the editor controls to hide");
    await t.waitFor(async () => !(await t.marks({ id: "sidebar-panel" })).length, "the sidebar to leave");
    await t.key("\\", ["cmd"]);
    await t.waitState(s => !s.uiHidden, "the editor controls to return");
    t.near((await tile()).y, scrolled.y, 2, "Widgets retains its scroll position after Hide UI");
  } finally {
    await t.cmd("qa.window", { width, height });
  }
});

sc("sidebar", "Layers keeps its scroll position across a file loading gap", {
  covers: ["sidebar:scroll"],
}, async (t: NT) => {
  const makeFile = (name: string, prefix: string) => {
    const file = path.join(t.app.docs, name + ".canvas");
    copyDir(t.file, file);
    const sidecar = path.join(file, "widgets.json");
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    data.pages.push(...Array.from({ length: 32 }, (_, i) => ({
      id: prefix + i, name: "Sample page " + (i + 1), boards: [],
    })));
    fs.writeFileSync(sidecar, JSON.stringify(data));
    return file;
  };
  const first = makeFile("Sidebar first", "first-");
  const second = makeFile("Sidebar second", "second-");
  const { width, height } = (await t.state()).window;
  try {
    await t.cmd("qa.window", { width, height: 500 });
    await t.app.openShown(first);
    await t.section("Layers");
    const row = () => t.mark({ id: "page-row", label: "first-4", exact: true });
    const before = await row();
    await t.scroll(center(before), 0, -100);
    await t.waitFor(async () => (await row()).y < before.y - 20, "the first file to scroll");
    await t.cmd("qa.idle", { ms: 250 });
    const scrolled = await row();
    await t.js(`
      const cmd = window.canvasCmd, held = [];
      window.canvasCmd = c => {
        if (c.cmd === "resync" || (c.cmd === "tab" && c.active)) held.push(c);
        else cmd(c);
      };
      window.resumeSidebarQA = () => { window.canvasCmd = cmd; held.forEach(cmd); };
    `);
    await t.app.openShown(second);
    await t.mark({ id: "page-row", label: "second-4", exact: true });
    await t.app.openShown(first);
    await t.waitState(s => s.file === first && !s.revision, "the first file to be selected before its list arrives");
    await t.cmd("qa.idle", { ms: 250 });
    await t.js("window.resumeSidebarQA()");
    await t.waitFor(async () => Math.abs((await row()).y - scrolled.y) <= 2, "the first file's offset to return");
  } finally {
    await t.app.openShown(t.file);
    for (const file of [first, second]) {
      if ((await t.state()).openFiles.includes(file)) await t.cmd("close", { file });
    }
    await t.cmd("qa.window", { width, height });
  }
});

for (const width of [720, 900]) {
  const narrow = width === 720;
  sc("comments", narrow ? "Send reply stays reachable in a short window" : "Show resolved stays clear of Zoom", {
    covers: ["comments:light"],
  }, async (t: NT) => {
    await t.showPage("layout");
    await t.section("Layers");
    const sidebar = center(await t.mark({ id: "sidebar-resize" }));
    if ((await t.state()).sidebarWidth !== METRICS.sidebarWidth) await t.doubleClick(sidebar);
    const original = await t.state();
    if (!original.inspectorOpen) await t.click(center(await t.mark({ id: "properties-toggle" })));
    if (narrow) {
      await t.drag(sidebar, { x: sidebar.x + 200, y: sidebar.y });
      await t.waitState(s => s.sidebarWidth === METRICS.sidebarMax, "Layers widened to its cap");
    }
    await t.cmd("qa.window", { width, height: 420 });
    try {
      const doc = crypto.randomUUID(), id = crypto.randomUUID(), at = new Date().toISOString();
      const author = { name: "Anna" };
      const comments = Array.from({ length: narrow ? 12 : 1 }, () => ({
        id: crypto.randomUUID(), thread: id, author, body: "Review the spacing in this frame.", createdAt: at,
      }));
      fs.writeFileSync(path.join(t.file, "comments.json"), JSON.stringify({
        format: 1, doc, seq: 0, outbox: [], threads: [{
          id, doc, anchor: { nodeId: "r_free", x: 0.5, y: 0.5, board: "lay_nest" },
          createdAt: at, createdBy: author, comments, ...(narrow ? {} : { resolvedAt: at }),
        }],
      }));
      await t.js("return canvasHost.comments.reload();");
      await t.click(center(await t.mark({ id: "comments-toggle" })));
      await t.waitJs("!document.querySelector('.cm-sidebar').hidden", "Comments opens");
      if (narrow) {
        await t.js(`document.querySelector('.cm-thread-row').click();`);
        await t.waitJs("!!document.querySelector('.cm-pop:not([hidden]) [aria-label=Reply]')", "the reply field");
        await t.js(`
          const field = document.querySelector('[aria-label=Reply]');
          field.value = "The spacing in this frame needs a reply that wraps across several lines.";
          field.dispatchEvent(new Event("input", { bubbles: true }));
        `);
        await t.settle();
        const send = await t.js<{ x: number; y: number; bottom: number; height: number; hit: string | null }>(`
          const r = document.querySelector('[aria-label="Send reply"]').getBoundingClientRect();
          const x = r.x + r.width / 2, y = r.y + r.height / 2;
          const target = document.elementFromPoint(x, y)?.closest('button,.cm-ui');
          return { x, y, bottom: r.bottom, height: innerHeight, hit: target?.getAttribute('aria-label') ?? null };
        `);
        t.ok(send.bottom <= send.height, `Send reply bottom ${send.bottom} exceeds window height ${send.height}`);
        t.eq(send.hit, "Send reply", "the reply button receives the click");
        await t.click(send);
        await t.waitJs(`canvasHost.comments.threads.find(t => t.id === "${id}").comments.length === ${comments.length + 1}`, "the reply to post");
      } else {
        const zoom = await t.mark({ id: "zoom-island" });
        const resolved = await t.js<{ x: number; y: number; left: number; bottom: number }>(`
          const r = document.querySelector('.cm-show-resolved').getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, bottom: r.bottom };
        `);
        t.ok(resolved.left >= zoom.x + zoom.w || resolved.bottom <= zoom.y, "Show resolved overlaps Zoom");
        await t.click(resolved);
        await t.waitJs("document.querySelector('.cm-show-resolved').getAttribute('aria-pressed') === 'true'", "resolved comments to show");
        await t.js("document.querySelector('.cm-show-resolved').click();");
      }
    } finally {
      await t.js("window.canvasCmd({cmd:'commentsSidebar',open:false});");
      await t.cmd("qa.window", { width: original.window.width, height: original.window.height });
      if (narrow) await t.doubleClick(center(await t.mark({ id: "sidebar-resize" })));
      if (!original.inspectorOpen) await t.click(center(await t.mark({ id: "properties-toggle" })));
    }
  });
}
