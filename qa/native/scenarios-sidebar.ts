import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng, type Img } from "../../fidelity/png.ts";
import { METRICS } from "../../src/tokens.ts";
import { center, sc, type NT } from "./harness.ts";
import { crop, inkBox, type Ink, type Rect } from "../ink.ts";
import { copyDir } from "../lib.ts";

function glyphMask(img: Img, ink: Ink, size: number) {
  const x0 = Math.round((ink.x0 + ink.x1 - size) / 2);
  const y0 = Math.round((ink.y0 + ink.y1 - size) / 2);
  const contrast = Array.from({ length: size ** 2 }, (_, i) => {
    const x = x0 + i % size, y = y0 + Math.floor(i / size);
    const at = (y * img.width + x) * 4;
    return Math.max(...ink.bg.map((channel, c) => Math.abs(channel - img.data[at + c])));
  });
  // Use contrast against each button's fill so selection colour does not distinguish the same shape.
  const cutoff = Math.max(...contrast) * 0.4;
  return contrast.map((c) => c >= cutoff);
}

function sameGlyph(a: boolean[], b: boolean[], size: number) {
  // Allow a one-pixel shift and small edge differences from rasterisation.
  const shifts = [-1, 0, 1];
  return shifts.some((dy) => shifts.some((dx) => {
    let union = 0, difference = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const bx = x + dx, by = y + dy;
      const p = a[y * size + x];
      const q = bx >= 0 && bx < size && by >= 0 && by < size && b[by * size + bx];
      if (p || q) union++;
      if (p !== q) difference++;
    }
    return difference < union * 0.3;
  }));
}

async function headerButtons(t: NT) {
  const toggle = await t.mark({ id: "sidebar-toggle" });
  const sections = (await t.marks({ id: "sidebar-section" })).sort((a, b) => a.x - b.x);
  const buttons = [toggle, ...sections];
  t.eq(buttons.map((button) => button.label), ["Hide panel", "Layers", "Assets", "Tokens", "Widgets"],
    "the sidebar header has five buttons in order");
  for (const [i, button] of buttons.entries()) {
    t.near(button.w, METRICS.control, 0.5, `${button.label} is 32 pt wide`);
    t.near(button.h, METRICS.control, 0.5, `${button.label} is 32 pt tall`);
    t.near(center(button).y, center(toggle).y, 0.5, "all buttons share one centre line");
    if (i > 0) {
      const previous = buttons[i - 1];
      t.near(button.x - previous.x - previous.w, METRICS.islandPad, 0.5, "buttons have equal gaps");
    }
  }
  t.eq((await t.marks({ id: "sidebar-track" })).length, 0, "the buttons have no shared track");
  return { toggle, sections };
}

sc("sidebar", "editor section buttons show their lists and the toggle restores the selection", {
  covers: ["sidebar:segments", "sidebar:toggle", "sidebar:scroll", "sidebar:restore", "sidebar:header"],
}, async (t: NT) => {
  const out = path.join(process.cwd(), "qa/out/sidebar-buttons");
  fs.mkdirSync(out, { recursive: true });
  const sections = ["Layers", "Assets", "Tokens", "Widgets"];
  const select = async (label: string) => {
    await t.click(center(await t.mark({ id: "sidebar-section", label, exact: true })));
    await t.waitState((s) => s.section === label && s.panelOpen, `the ${label} sidebar`);
  };

  if (!(await t.state()).panelOpen) await t.click(await t.sidebarToggle());
  await t.cmd("qa.theme", { theme: "light" });
  const { toggle: open, sections: buttons } = await headerButtons(t);
  const checkAccessibility = async (selected: string) => {
    for (const button of [open, ...buttons]) {
      const { elements } = await t.cmd<{ elements: { role: string; label: string; help: string; selected?: boolean }[] }>(
        "qa.accessibility", center(button));
      const ax = elements.find((element) => element.role === "AXButton" && element.label === button.label);
      t.ok(ax, `${button.label} exposes an accessible button with its name`);
      t.eq(ax.help, button.label, `${button.label} has tooltip help`);
      t.eq(ax.selected ?? false, button.label === selected, `${button.label} exposes its selection state`);
    }
  };

  const captureHeader = async (name?: string) => {
    await t.move({ x: open.x, y: open.y + open.h + 8 });
    await t.cmd("qa.idle", { ms: 200 });
    const { data, width } = await t.cmd<{ data: string; width: number }>("qa.shot");
    const state = await t.state();
    const scale = width / state.window.width;
    const pixels = ({ x, y, w, h }: Rect) => ({ x: x * scale, y: y * scale, w: w * scale, h: h * scale });
    const img = decodePng(Buffer.from(data, "base64"));
    const pad = METRICS.pillPad;
    const header = { x: open.x - pad, y: open.y - pad, w: state.panelOpen ? state.sidebarWidth : METRICS.pill,
      h: open.h + 2 * pad };
    if (name) fs.writeFileSync(path.join(out, `macos-${name}.png`), encodePng(crop(img, pixels(header), 1)));
    return { img, pixels, scale };
  };

  let expanded: Awaited<ReturnType<typeof captureHeader>> | undefined;
  for (const label of sections) {
    await select(label);
    switch (label) {
      case "Layers":
        await t.mark({ id: "page-row", label: "layout", exact: true });
        await t.layerRow("lay_nest");
        break;
      case "Assets":
        await t.mark({ label: "Button/Primary", exact: true });
        break;
      case "Tokens":
        await t.waitText("Search text styles");
        break;
      case "Widgets":
        await t.mark({ id: "widget-preview-note" });
        break;
    }
    await checkAccessibility(label);
    expanded = await captureHeader(label.toLowerCase());
  }

  t.ok(expanded, "captured the expanded header");
  const { img, pixels, scale } = expanded;
  for (const button of [open, ...buttons]) {
    const read = (dx: number, dy: number) => {
      const x = Math.round((center(button).x + dx) * scale);
      const y = Math.round((center(button).y + dy) * scale);
      return img.data[(y * img.width + x) * 4];
    };
    t.ok(read(13, 13) - read(0, 12) >= 5, `${button.label} has a fill with a clear corner`);
  }
  const size = Math.round((METRICS.icon + 3) * scale);
  const glyphs: { name: string; mask: boolean[] }[] = [];
  for (const [i, button] of buttons.entries()) {
    const name = sections[i];
    const ink = inkBox(img, pixels(button), { inset: 7 * scale });
    t.ok(ink, `${name} draws an icon`);
    t.ok(ink.x1 - ink.x0 <= size && ink.y1 - ink.y0 <= size, `${name} draws only the icon`);
    t.near((ink.x0 + ink.x1) / 2 / scale, center(button).x, 1.5, `${name} icon is centred horizontally`);
    t.near((ink.y0 + ink.y1) / 2 / scale, center(button).y, 1.5, `${name} icon is centred vertically`);
    const mask = glyphMask(img, ink, size);
    for (const previous of glyphs) t.ok(!sameGlyph(mask, previous.mask, size), `${name} and ${previous.name} draw different icons`);
    glyphs.push({ name, mask });
  }
  await t.click(center(open));
  await t.waitState((s) => !s.panelOpen, "the sidebar to close");
  const closed = await t.mark({ id: "sidebar-toggle" });
  t.near(closed.x, open.x, 1, "toggle keeps its x position");
  t.near(closed.y, open.y, 1, "toggle keeps its y position");
  t.eq((await t.marks({ id: "sidebar-section" })).length, 0, "closed sidebar hides its section buttons");
  await captureHeader("collapsed");
  await t.click(center(closed));
  await t.waitState((s) => s.panelOpen && s.section === "Widgets", "the Widgets sidebar to reopen");
  const tile = () => t.mark({ id: "widget-preview-note" });
  const { width, height } = (await t.state()).window;
  await t.cmd("qa.window", { width, height: 500 });
  try {
    const before = await tile();
    await t.scroll({ x: center(before).x, y: 250 }, 0, -30);
    const scrolled = await t.waitFor(async () => {
      const [mark] = await t.marks({ id: "widget-preview-note" });
      return mark && mark.y < before.y - 10 ? mark : undefined;
    }, "Widgets to scroll down", 3000);
    t.near((await t.sidebarToggle()).y, center(open).y, 1, "header stays pinned while scrolling");
    await select("Layers");
    await t.mark({ id: "page-row", label: "layout", exact: true });
    await select("Widgets");
    t.near((await tile()).y, scrolled.y, 2, "Widgets keeps its scroll position");
    await select("Layers");
    await t.key("\\", ["cmd"]);
    await t.waitState((s) => s.uiHidden, "the editor controls to hide");
    await t.waitFor(async () => (await t.marks({ id: "sidebar-section" })).length === 0, "the sidebar to leave the window");
    await t.cmd("qa.idle", { ms: 350 });
    await t.key("\\", ["cmd"]);
    await t.waitState((s) => !s.uiHidden, "the editor controls to return");
    await select("Widgets");
    t.near((await tile()).y, scrolled.y, 2, "Widgets keeps its scroll position after Hide UI");
  } finally {
    await t.cmd("qa.window", { width, height });
  }

  const second = path.join(t.app.docs, "second-sidebar.canvas");
  copyDir(t.file, second);
  try {
    await t.app.openShown(second);
    await t.waitState((s) => s.file === second, "the second tab to open");
    await select("Assets");
    await t.app.openShown(t.file);
    await t.waitState((s) => s.file === t.file && s.section === "Widgets", "the first tab to restore Widgets");
  } finally {
    await t.cmd("close", { file: second });
  }
  await t.app.relaunch();
  await t.waitState((s) => s.section === "Widgets", "the app to restore Widgets at launch");

  const command = async (title: string) => {
    await t.key("k", ["cmd"]);
    await t.waitState((s) => s.palette.open, "the command palette to open");
    await t.type(title);
    await t.waitState((s) => s.palette.items.some((item: string) => item.endsWith(title)), `the ${title} command`);
    await t.key("Return");
    await t.waitState((s) => !s.palette.open, "the command palette to close");
  };
  await command("Hide Left Panel");
  await t.waitState((s) => !s.panelOpen, "the palette to close the sidebar");
  await command("Show Left Panel");
  await t.waitState((s) => s.panelOpen && s.section === "Widgets", "the palette to reopen the sidebar");
  await command("Show Tokens");
  await t.waitState((s) => s.panelOpen && s.section === "Tokens", "the palette to show Tokens");
  await t.key("\\", ["cmd"]);
  await t.waitState((s) => s.uiHidden, "the View menu shortcut to hide the editor controls");
  await t.key("\\", ["cmd"]);
  await t.waitState((s) => !s.uiHidden && s.section === "Tokens", "the View menu shortcut to restore the editor controls");
});

sc("sidebar", "the editor sidebar resize handle leaves the header clickable", {
  covers: ["sidebar:header", "sidebar-resize:editor"],
}, async (t: NT) => {
  await t.section("Layers");
  const widgets = await t.mark({ id: "sidebar-section", label: "Widgets", exact: true });
  await t.click({ x: widgets.x + widgets.w - 1, y: center(widgets).y });
  await t.waitState((s) => s.section === "Widgets", "the right edge of the Widgets button to respond", 3000);
  const handle = await t.mark({ id: "sidebar-resize" });
  t.ok(handle.y >= widgets.y + widgets.h, "the resize handle starts below the buttons");

  const from = center(handle);
  await t.drag(from, { x: from.x - 900, y: from.y });
  await t.waitState((s) => s.sidebarWidth === METRICS.sidebarMin, "the sidebar to reach its minimum width");
  await t.section("Layers");
  const { toggle, sections } = await headerButtons(t);
  const last = sections.at(-1)!;
  t.ok(last.x + last.w <= toggle.x - METRICS.pillPad + METRICS.sidebarMin - METRICS.islandPad,
    "all five buttons fit inside the sidebar at minimum width");
  await t.click(center(last));
  await t.waitState((s) => s.section === "Widgets", "Widgets to open at minimum width");
});
