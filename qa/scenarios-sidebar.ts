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

sc("sidebar", "browser segments keep separate scroll positions and restore the selected tab", {
  covers: ["sidebar:segments", "sidebar:scroll", "sidebar:restore", "sidebar:header"],
  skip: { visual: "Sidebar layout and content are asserted directly. The canvas picture is unchanged." },
}, async (t: T) => {
  const panel = (name: string) => `#left [role="tabpanel"]#sidebar-${name}-panel`;
  const visible = (selector: string) => `!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`;
  const check = async (name: string, content: string[]) => {
    await t.waitFor(visible(`${tab(name)}[aria-selected="true"]`), `the ${name} segment to be selected`, 3000);
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
    t.eq(await t.ev(`document.querySelector('#left [role="tablist"]').getBoundingClientRect().height`),
      METRICS.field, "the segment track is 28 px tall");
    const header = await t.ev<{
      name: string | null; title: string; text: string; icon: string | null;
      top: number; y: number; left: number; right: number; height: number;
    }[]>(`[...document.querySelectorAll('#left [role="tablist"] button')].map(button => {
      const box = button.getBoundingClientRect();
      const svg = button.querySelector('svg[aria-hidden="true"]');
      const iconBox = svg?.getBoundingClientRect();
      const visible = iconBox?.width > 0 && iconBox.height > 0 &&
        svg.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      return {
        name: button.getAttribute("aria-label"), title: button.title, text: button.textContent.trim(),
        icon: visible ? svg.innerHTML : null,
        top: box.top, y: box.top + box.height / 2, left: box.left, right: box.right, height: box.height
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
      t.eq(button.height, METRICS.field - 4, "tabs keep their 24 px control height");
      if (i > 0) t.ok(button.left >= header[i - 1].right, "tabs do not overlap");
    }
    const top = header[0].top;
    await addOverflow("layers", 120);
    t.eq(await t.ev(`document.querySelector(${JSON.stringify(tab("layers"))}).getBoundingClientRect().top`), top, "header stays pinned");
    await click(t, "assets");
    await check("assets", ["comps"]);
    await addOverflow("assets", 230);
    await click(t, "layers");
    t.eq(await t.ev(`${panelEl("layers")}.scrollTop`), 120, "Layers keeps its scroll position");
    await click(t, "assets");
    t.eq(await t.ev(`${panelEl("assets")}.scrollTop`), 230, "Assets keeps its scroll position");
    await click(t, "tokens");
    await check("tokens", ["styles", "vars"]);
    await t.open();
    await check("tokens", ["styles", "vars"]);
    const other = await t.ev<string>("canvasHost.pages.find(p => p.id !== canvasHost.page).id");
    await t.showPage(other);
    await check("layers", ["pages", "boards"]);
  } finally {
    await reset(t);
  }
});

sc("sidebar", "browser segment keys stay separate from canvas shortcuts", {
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
    t.ok(await t.ev(active("assets")), "Right in the panel leaves the segment selected");
    await t.io.key("Tab", { shift: true });
    t.eq(await t.ev("document.activeElement.id"), "sidebar-assets", "Shift+Tab focuses the active segment");
    t.ok(await t.ev(`document.activeElement.matches(":focus-visible") &&
      getComputedStyle(document.activeElement).outlineStyle === "solid"`), "the keyboard focus ring is visible");
    t.eq(await t.sel(), ["r_free"], "Tab navigation leaves the selected layer alone");
    await t.io.key("ArrowRight");
    t.ok(await t.ev(active("tokens")), "Right on a focused segment selects the next one");
    await t.io.key("ArrowRight", { meta: true });
    await t.flush();
    t.ok(await t.ev(active("tokens")), "Cmd+Right leaves the segment selected");
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
