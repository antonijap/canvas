import fs from "node:fs";
import path from "node:path";
import { METRICS } from "../src/tokens.ts";
import { sc, type T } from "./harness.ts";

const tab = (name: string) => `#left [role="tab"]#sidebar-${name}`;
const active = (name: string) => `!!document.querySelector(${JSON.stringify(`${tab(name)}[aria-selected="true"]`)})`;
const storageKey = "canvas:sidebar-section";
const reset = (t: T) => t.ev(`localStorage.removeItem(${JSON.stringify(storageKey)})`);
async function click(t: T, name: string) {
  const p = await t.ev<{ x: number; y: number }>(`(() => {
    const r = document.querySelector(${JSON.stringify(tab(name))}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await t.io.click(p.x, p.y);
}

sc("sidebar", "browser section buttons keep separate scroll positions and restore the selected tab", {
  covers: ["sidebar:segments", "sidebar:scroll", "sidebar:restore", "sidebar:header"],
  skip: { visual: "Sidebar layout and content are asserted directly. The canvas picture is unchanged." },
}, async (t: T) => {
  const panel = (name: string) => `#left [role="tabpanel"]#sidebar-${name}-panel`;
  const visible = (selector: string) => `!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`;
  const check = async (name: string, content: string[]) => {
    await t.waitFor(visible(`${tab(name)}[aria-selected="true"]`), `the ${name} tab to be selected`, 3000);
    t.eq(await t.ev(`document.querySelectorAll('#left [role="tab"][aria-selected="true"]').length`), 1, "one selected tab");
    t.eq(await t.ev(`document.querySelectorAll('#left [role="tabpanel"]:not([hidden])').length`), 1, "one visible panel");
    for (const id of content) await t.waitFor(visible(`${panel(name)} #${id} .row`), `visible ${id} rows`);
  };
  const panelEl = (name: string) => `document.querySelector(${JSON.stringify(panel(name))})`;
  const addOverflow = (name: string, scrollTop: number) => t.ev(`(() => {
    const p = ${panelEl(name)};
    const spacer = document.createElement("div");
    spacer.style.height = "1500px";
    p.append(spacer);
    p.scrollTop = ${scrollTop};
  })()`);

  try {
    await reset(t);
    await t.open();
    await check("layers", ["pages", "boards"]);
    const header = await t.ev<{
      name: string | null; title: string; text: string; icon: string | null;
      top: number; y: number; left: number; right: number; width: number; height: number;
      radius: string; shadow: string;
    }[]>(`[...document.querySelectorAll('#left [role="tablist"] button')].map(button => {
      const box = button.getBoundingClientRect();
      const svg = button.querySelector('svg[aria-hidden="true"]');
      const iconBox = svg?.getBoundingClientRect();
      const visible = iconBox?.width > 0 && iconBox.height > 0 &&
        svg.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      return {
        name: button.getAttribute("aria-label"), title: button.title, text: button.textContent.trim(),
        icon: visible ? svg.innerHTML : null,
        top: box.top, y: box.top + box.height / 2, left: box.left, right: box.right,
        width: box.width, height: box.height, radius: getComputedStyle(button).borderRadius,
        shadow: getComputedStyle(button).boxShadow
      };
    })`);
    t.eq(header.map((button) => button.title), ["Layers", "Assets", "Tokens"], "each tab has a tooltip");
    t.eq(header.map((button) => button.name), ["Layers", "Assets", "Tokens"], "each tab has an accessible name");
    for (const button of header) {
      t.eq(button.text, "", `${button.name} has no visible text label`);
      t.ok(button.icon, `${button.name} displays a visible icon`);
    }
    t.eq(new Set(header.map((button) => button.icon)).size, 3, "the three glyphs are distinct");
    for (const [i, button] of header.entries()) {
      t.eq(button.y, header[0].y, "the tabs share one centre line");
      t.eq(button.width, METRICS.control, "tabs are 32 px wide");
      t.eq(button.height, METRICS.control, "tabs are 32 px tall");
      t.eq(button.radius, "50%", "each tab is a circle");
      t.eq(button.shadow, "none", "the tab has no chip shadow");
      if (i > 0) t.eq(button.left - header[i - 1].right, METRICS.islandPad, "tabs have equal gaps");
    }
    t.eq(await t.ev(`getComputedStyle(document.querySelector('#left [role="tablist"]')).backgroundColor`),
      "rgba(0, 0, 0, 0)", "the tablist has no track fill");

    const fill = (name: string) => t.ev<string>(`getComputedStyle(document.querySelector(${JSON.stringify(tab(name))})).backgroundColor`);
    const waitForFills = () => t.waitFor(
      `![...document.querySelectorAll('#left [role="tab"]')].some(tab => tab.getAnimations().length)`,
      "header transitions to end");
    const assets = header[1];
    for (const theme of ["dark", "light"]) {
      await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await t.io.move(1, 1);
      await waitForFills();
      const resting = await fill("assets");
      t.eq(resting, await fill("tokens"), `${theme} resting tabs share a fill`);
      t.ok(resting !== "rgba(0, 0, 0, 0)", `${theme} resting tabs have a fill`);
      await t.io.move(assets.left + assets.width / 2, assets.y);
      await t.waitFor(`getComputedStyle(document.querySelector('#sidebar-assets')).backgroundColor !== ${JSON.stringify(resting)}`,
        `the ${theme} hover fill`);
      await waitForFills();
      t.eq(new Set([resting, await fill("assets"), await fill("layers")]).size, 3,
        `${theme} rest, hover and selection have distinct fills`);
    }
    const out = path.join(process.cwd(), "qa/out/sidebar-buttons");
    fs.mkdirSync(out, { recursive: true });
    const saveHeader = async (name: string) => {
      await t.io.move(1, 1);
      await waitForFills();
      const pad = METRICS.pillPad;
      const clip = { x: header[0].left - pad, y: header[0].top - pad,
        width: header[2].right - header[0].left + 2 * pad, height: METRICS.control + 2 * pad };
      fs.writeFileSync(path.join(out, `browser-${name}.png`), await t.shot(clip));
    };
    await saveHeader("layers");
    const top = header[0].top;
    await addOverflow("layers", 120);
    t.eq(await t.ev(`document.querySelector(${JSON.stringify(tab("layers"))}).getBoundingClientRect().top`), top, "header stays pinned");
    await click(t, "assets");
    await check("assets", ["comps"]);
    await saveHeader("assets");
    await addOverflow("assets", 230);
    await click(t, "layers");
    t.eq(await t.ev(`${panelEl("layers")}.scrollTop`), 120, "Layers keeps its scroll position");
    await click(t, "assets");
    t.eq(await t.ev(`${panelEl("assets")}.scrollTop`), 230, "Assets keeps its scroll position");
    await click(t, "tokens");
    await check("tokens", ["styles", "vars"]);
    await saveHeader("tokens");
    await t.open();
    await check("tokens", ["styles", "vars"]);
    const other = await t.ev<string>("canvasHost.pages.find(p => p.id !== canvasHost.page).id");
    await t.showPage(other);
    await check("layers", ["pages", "boards"]);
  } finally {
    await reset(t);
  }
});

sc("sidebar", "browser tab keys stay separate from canvas shortcuts", {
  covers: ["sidebar:keyboard"],
  skip: { visual: "Keyboard focus and canvas edits are asserted directly." },
}, async (t: T) => {
  try {
    await t.focus("lay_nest");
    await t.select(["r_free"]);
    const { y, width } = t.node("r_free")!;
    await click(t, "assets");
    await t.io.key("ArrowDown");
    await t.flush();
    t.eq(t.node("r_free")!.y, y, "Down in the sidebar leaves the layer in place");
    t.eq(await t.ev("document.activeElement.getAttribute('role')"), "tabpanel", "click puts focus in the panel");
    await t.io.key("ArrowRight");
    t.ok(await t.ev(active("assets")), "Right in the panel leaves the tab selected");
    await t.io.key("Tab", { shift: true });
    t.eq(await t.ev("document.activeElement.id"), "sidebar-assets", "Shift+Tab focuses the active tab");
    t.ok(await t.ev(`document.activeElement.matches(":focus-visible") &&
      getComputedStyle(document.activeElement).outlineStyle === "solid"`), "the keyboard focus ring is visible");
    t.eq(await t.sel(), ["r_free"], "Tab navigation leaves the selected layer alone");
    await t.io.key("ArrowRight");
    t.ok(await t.ev(active("tokens")), "Right on a focused tab selects the next one");
    await t.io.key("ArrowRight", { meta: true });
    await t.flush();
    t.ok(await t.ev(active("tokens")), "Cmd+Right leaves the tab selected");
    t.eq(t.node("r_free")!.width, width + 1, "Cmd+Right reaches the canvas resize shortcut");
    await t.io.key("Tab");
    t.eq(await t.ev("document.activeElement.id"), "sidebar-tokens-panel", "Tab reaches the selected panel");
    t.eq(await t.sel(), ["r_free"], "Tab leaves the selected layer alone");
  } finally {
    await reset(t);
  }
  // Headless keyboard input can background the tab and pause the runner's render checks.
  await t.page.send("Page.bringToFront");
});
