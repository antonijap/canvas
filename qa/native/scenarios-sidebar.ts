import fs from "node:fs";
import path from "node:path";
import { METRICS } from "../../src/tokens.ts";
import { center, sc, type NT } from "./harness.ts";
import { copyDir } from "../lib.ts";

sc("sidebar", "editor segments show their lists and the toggle restores the selection", {
  covers: ["sidebar:segments", "sidebar:toggle", "sidebar:scroll", "sidebar:restore"],
}, async (t) => {
  const out = path.join(process.cwd(), "qa/out/sidebar");
  fs.mkdirSync(out, { recursive: true });
  const segments = ["Layers", "Assets", "Tokens", "Widgets"];
  const select = async (label: string) => {
    await t.click(center(await t.mark({ id: "sidebar-segment", label, exact: true })));
    await t.waitState((s) => s.section === label && s.panelOpen, `the ${label} sidebar`);
  };

  if (!(await t.state()).panelOpen) await t.click(await t.sidebarToggle());
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

  const open = await t.sidebarToggle();
  await t.click(open);
  await t.waitState((s) => !s.panelOpen, "the sidebar to close");
  const closed = await t.sidebarToggle();
  t.near(closed.x, open.x, 1, "toggle keeps its x position");
  t.near(closed.y, open.y, 1, "toggle keeps its y position");
  t.eq((await t.marks({ id: "sidebar-segment" })).length, 0, "closed sidebar hides its segments");
  await t.click(closed);
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
    t.near((await t.sidebarToggle()).y, open.y, 1, "header stays pinned while scrolling");
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
  t.near(track.x, row.x, 0.5, "the track and the list share a left inset");
  t.near(track.x + track.w, row.x + row.w, 0.5, "the track and the list share a right inset");
  const segments = await t.marks({ id: "sidebar-segment" });
  t.eq(segments.length, 4, "all four segments are visible at minimum width");
  for (const segment of segments) {
    t.near(segment.w, segments[0].w, 0.5, "the segments have equal widths");
    const label = await t.mark({ id: "sidebar-segment-label", label: segment.label ?? undefined, exact: true });
    t.ok(label.x - segment.x >= 6 && segment.x + segment.w - label.x - label.w >= 6,
      `${segment.label} has at least 6 pt of padding on both sides`);
  }
});
