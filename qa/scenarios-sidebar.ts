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
  covers: ["sidebar:segments", "sidebar:scroll", "sidebar:restore"],
  skip: { visual: "Sidebar layout and content are asserted directly. The canvas picture is unchanged." },
}, async (t) => {
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
    const top = await t.ev(`document.querySelector(${JSON.stringify(tab("layers"))}).getBoundingClientRect().top`);
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
