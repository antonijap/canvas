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

sc("sidebar", "editor segments show their lists and the toggle restores the selection", {
  covers: ["sidebar:segments", "sidebar:toggle", "sidebar:scroll", "sidebar:restore", "sidebar:header"],
}, async (t: NT) => {
  const out = path.join(process.cwd(), "qa/out/sidebar");
  fs.mkdirSync(out, { recursive: true });
  const segments = ["Layers", "Assets", "Tokens", "Widgets"];
  const select = async (label: string) => {
    await t.click(center(await t.mark({ id: "sidebar-segment", label, exact: true })));
    await t.waitState((s) => s.section === label && s.panelOpen, `the ${label} sidebar`);
  };

  if (!(await t.state()).panelOpen) await t.click(await t.sidebarToggle());
  const open = await t.mark({ id: "sidebar-toggle" });
  const track = await t.mark({ id: "sidebar-track" });
  const buttons = (await t.marks({ id: "sidebar-segment" })).sort((a, b) => a.x - b.x);
  t.eq(buttons.length, segments.length, "all four sidebar buttons are present");
  t.near(track.h, METRICS.field, 0.5, "the segment track is 28 pt tall");
  t.near(open.h, METRICS.control, 0.5, "the toggle sets the 32 pt header row height");
  for (const [i, button] of buttons.entries()) {
    const name = segments[i];
    t.near(center(button).y, center(open).y, 0.5, "toggle and segments share one centre line");
    const previous = i > 0 ? buttons[i - 1] : open;
    t.ok(button.x >= previous.x + previous.w, "header buttons do not overlap");
    const { elements } = await t.cmd<{ elements: { role: string; label: string; help: string }[] }>(
      "qa.accessibility", center(button));
    const ax = elements.find((element) => element.role === "AXButton");
    t.ok(ax, `${name} exposes an accessible button (found ${elements.map((element) => element.role).join(", ")})`);
    t.eq(ax.label, name, `${name} has its section name as an accessibility label`);
    t.eq(ax.help, name, `${name} has its section name as tooltip help`);
  }

  const saveHeader = async (name: string, right: number) => {
    const { data, width } = await t.cmd<{ data: string; width: number }>("qa.shot");
    const scale = width / (await t.state()).window.width;
    const pixels = ({ x, y, w, h }: Rect) => ({ x: x * scale, y: y * scale, w: w * scale, h: h * scale });
    const img = decodePng(Buffer.from(data, "base64"));
    const pad = METRICS.pillPad;
    const header = { x: open.x - pad, y: open.y - pad, w: right - open.x + pad, h: open.h + 2 * pad };
    fs.writeFileSync(path.join(out, `header-${name}.png`), encodePng(crop(img, pixels(header), 1)));
    return { img, pixels, scale };
  };

  for (const label of segments) {
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
    await t.shot(path.join(out, `${label.toLowerCase()}.png`));
  }

  const { img, pixels, scale } = await saveHeader("expanded", track.x + track.w + METRICS.islandPad);
  const size = Math.round((METRICS.icon + 3) * scale);
  const glyphs: { name: string; mask: boolean[] }[] = [];
  for (const [i, button] of buttons.entries()) {
    const name = segments[i];
    const ink = inkBox(img, pixels(button), { inset: 4 * scale });
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
  t.eq((await t.marks({ id: "sidebar-segment" })).length, 0, "closed sidebar hides its segments");
  await saveHeader("collapsed", closed.x + closed.w + METRICS.pillPad);
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
    await t.waitFor(async () => (await t.marks({ id: "sidebar-segment" })).length === 0, "the sidebar to leave the window");
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
  const widgets = await t.mark({ id: "sidebar-segment", label: "Widgets", exact: true });
  await t.click({ x: widgets.x + widgets.w - 1, y: center(widgets).y });
  await t.waitState((s) => s.section === "Widgets", "the right edge of the Widgets segment to respond", 3000);
  const handle = await t.mark({ id: "sidebar-resize" });
  t.ok(handle.y >= widgets.y + widgets.h, "the resize handle starts below the segments");

  const from = center(handle);
  await t.drag(from, { x: from.x - 900, y: from.y });
  await t.waitState((s) => s.sidebarWidth === METRICS.sidebarMin, "the sidebar to reach its minimum width");
  await t.section("Layers");
  const track = await t.mark({ id: "sidebar-track" });
  const row = await t.mark({ id: "page-row", label: "layout", exact: true });
  t.near(track.x + track.w, row.x + row.w, 0.5, "the track and the list share a right inset");
  const segments = await t.marks({ id: "sidebar-segment" });
  t.eq(segments.length, 4, "all four segments are visible at minimum width");
  for (const segment of segments) {
    t.near(segment.w, segments[0].w, 0.5, "the segments have equal widths");
    t.ok(segment.w >= METRICS.control, `${segment.label} has a full-width hit target`);
    t.near(segment.h, METRICS.field - 4, 0.5, `${segment.label} is 24 pt tall`);
  }
});
