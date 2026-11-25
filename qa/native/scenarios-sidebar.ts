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

sc("sidebar", "section menu switches panels and remembers the selection", {
  covers: ["sidebar:menu", "sidebar:restore", "sidebar:toggle", "sidebar:previews"],
}, async (t: NT) => {
  if (!(await t.state()).panelOpen) await t.click(await t.sidebarToggle());
  await t.cmd("qa.theme", { theme: "dark" });
  await t.click(center(await header(t)));
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
  t.near((await header(t)).h, 32, 0.5, "header is 32 pt tall");

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
  await t.click(center(await t.mark({ id: "sidebar-search" })));
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
  const handle = await t.mark({ id: "sidebar-resize" });
  const menu = await header(t);
  t.ok(handle.y >= menu.y + menu.h, "the handle starts below the header");
  const from = center(handle);
  await t.drag(from, { x: from.x - 900, y: from.y });
  await t.waitState(s => s.sidebarWidth === METRICS.sidebarMin, "the sidebar to reach its minimum width");
  await t.section("Widgets");
  const narrow = center(await t.mark({ id: "sidebar-resize" }));
  await t.drag(narrow, { x: narrow.x + 650, y: narrow.y });
  await t.waitState(s => s.sidebarWidth === METRICS.sidebarMax, "the sidebar to reach its maximum width");
  t.near((await t.mark({ id: "sidebar-panel" })).w, METRICS.sidebarMax, 0.5, "the maximum width is visible");
  await t.app.relaunch();
  await t.waitState(s => s.sidebarWidth === METRICS.sidebarMax, "the maximum width to survive relaunch");
  t.near((await t.mark({ id: "sidebar-panel" })).w, METRICS.sidebarMax, 0.5, "the saved width is visible after relaunch");
  await t.doubleClick(center(await t.mark({ id: "sidebar-resize" })));
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
