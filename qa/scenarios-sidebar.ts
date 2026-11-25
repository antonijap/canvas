import path from "node:path";
import { sc, T } from "./harness.ts";
import { copyDir } from "./lib.ts";

const storageKey = "canvas:sidebar-section";
const reset = (t: T) => t.ev(`localStorage.removeItem(${JSON.stringify(storageKey)});
  localStorage.removeItem(${JSON.stringify(storageKey + ":" + t.file)})`);
const panel = (name: string) => `#sidebar-${name}-panel`;
const visible = (sel: string) => `!!document.querySelector(${JSON.stringify(sel)})?.checkVisibility()`;
async function click(t: T, sel: string) {
  const p = await t.ev<{ x: number; y: number }>(`(() => {
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await t.io.click(p.x, p.y);
}
async function select(t: T, name: string) {
  await click(t, "#sidebar-section-menu");
  await click(t, `#sidebar-${name}`);
  await t.waitFor(visible(panel(name)), `the ${name} panel to appear`);
}

sc("sidebar", "browser section menu restores selection and hides the entire sidebar", {
  covers: ["sidebar:menu", "sidebar:scroll", "sidebar:restore", "sidebar:toggle", "sidebar:previews"],
  skip: { visual: "The panel geometry, menu and widget artwork are checked directly." },
}, async (t: T) => {
  const trigger = "#sidebar-section-menu";
  const toggle = "#sidebar-toggle";
  const active = (name: string) => `#sidebar-${name}[aria-checked=true]`;
  const geometry = () => t.ev<{ x: number; y: number; canvas: number }>(`(() => {
    const r = document.querySelector('${toggle}').getBoundingClientRect();
    return { x: r.x, y: r.y, canvas: document.querySelector('#view').clientWidth };
  })()`);
  const scroll = (name: string) => `document.querySelector('${panel(name)}').scrollTop`;
  const overflow = (name: string, offset: number) => t.ev(`(() => {
    const panel = document.querySelector('${panel(name)}');
    const spacer = document.createElement('div');
    spacer.style.height = '1500px';
    panel.append(spacer);
    panel.scrollTop = ${offset};
  })()`);
  try {
    await reset(t);
    await t.open();
    await t.waitFor(visible(trigger), "the section menu trigger");
    await click(t, trigger);
    t.eq(await t.ev(`[...document.querySelectorAll('#sidebar-menu [role=menuitemradio]')].map(el => el.dataset.title)`),
      ["Layers", "Assets", "Tokens", "Widgets"], "the menu lists every section");
    t.ok(await t.ev(visible(active("layers"))), "Layers is checked");
    await click(t, "#sidebar-layers");
    await t.waitFor(visible("#pages .row"), "Pages rows");
    await overflow("layers", 120);
    await select(t, "assets");
    await t.waitFor(visible("#comps .row"), "Assets rows");
    await overflow("assets", 230);
    await select(t, "layers");
    t.eq(await t.ev(scroll("layers")), 120, "Layers keeps its scroll position");
    await select(t, "assets");
    t.eq(await t.ev(scroll("assets")), 230, "Assets keeps its scroll position");
    await select(t, "tokens");
    await t.waitFor(visible("#styles .row"), "Tokens rows");
    await select(t, "widgets");
    for (const id of ["todo", "note", "shader", "video", "git-status", "ci", "claude-usage", "metric", "page-preview", "disk-space"]) {
      await t.waitFor(`(() => {
        const p = document.querySelector('[data-qa-id="widget-preview-${id}"]');
        return p?.checkVisibility() && p.clientWidth === 112 && p.clientHeight === 72 && p.children.length > 0;
      })()`, `the ${id} preview to render`);
      t.ok(await t.ev(`(() => {
        const subtitle = document.querySelector('[data-widget="${id}"] > small');
        return getComputedStyle(subtitle).position === "static" && subtitle.scrollWidth <= subtitle.clientWidth;
      })()`), `the ${id} subtitle fits in its tile`);
    }
    t.eq(await t.ev(`getComputedStyle(document.querySelector('[data-widget="claude-usage"] > strong')).borderTopWidth`),
      "0px", "the usage card title stays outside the gauge");
    const shown = await geometry();
    await click(t, toggle);
    await t.waitFor(`!document.querySelector('#left').checkVisibility({visibilityProperty:true}) && document.querySelector('#view').getBoundingClientRect().left === 0`,
      "the sidebar to leave the entire left edge");
    const hidden = await geometry();
    t.eq([hidden.x, hidden.y], [shown.x, shown.y], "toggle stays at the same spot");
    t.eq(hidden.canvas - shown.canvas, 248, "canvas gains the full width of the sidebar");
    await click(t, toggle);
    await t.waitFor(visible(panel("widgets")), "Widgets remains selected after showing");
    await t.open();
    await t.waitFor(visible(panel("widgets")), "Widgets remains selected after reload");
    const second = path.join(path.dirname(t.file), "Sidebar second.canvas");
    copyDir(t.file, second);
    const otherFile = new T(t.page, second, t.srv);
    try {
      await otherFile.open();
      await otherFile.waitFor(visible(panel("widgets")), "the second file inherits Widgets");
      await t.open();
      await select(t, "tokens");
      await otherFile.open();
      t.ok(await t.ev(visible(panel("widgets"))), "the second file keeps its inherited section");
      await select(otherFile, "assets");
      await t.open();
      t.ok(await t.ev(visible(panel("tokens"))), "the first file keeps Tokens");
      await otherFile.open();
      t.ok(await t.ev(visible(panel("assets"))), "the second file keeps Assets");
    } finally {
      await reset(otherFile);
      await t.open();
    }
    const other = await t.ev<string>("canvasHost.pages.find(p => p.id !== canvasHost.page).id");
    await t.showPage(other);
    await t.waitFor(visible("#pages .row"), "the other page");
  } finally {
    await reset(t);
  }
});

sc("sidebar", "browser menu navigation stays separate from canvas shortcuts", {
  covers: ["sidebar:keyboard"],
  skip: { visual: "Keyboard focus and canvas edits are checked directly." },
}, async (t: T) => {
  try {
    await t.focus("lay_auto");
    await t.select(["fp_a"]);
    const { y, width } = t.node("fp_a")!;
    await click(t, "#sidebar-section-menu");
    const focused = () => t.ev("document.activeElement.id");
    t.eq(await focused(), "sidebar-layers", "opening the menu focuses the current section");
    await t.io.key("End");
    t.eq(await focused(), "sidebar-widgets", "End focuses the last section");
    await t.io.key("ArrowUp");
    t.eq(await focused(), "sidebar-tokens", "Up focuses the previous section");
    await t.io.key("Enter");
    await t.waitFor(visible(panel("tokens")), "keyboard selects Tokens from the menu");
    t.eq(await t.ev("document.activeElement.id"), "sidebar-tokens-panel", "selection puts focus in the panel");
    await t.io.key("ArrowDown");
    await t.flush();
    t.eq(t.node("fp_a")!.y, y, "Down in the sidebar leaves the layer in place");
    await t.io.key("ArrowRight", { meta: true });
    await t.flush();
    t.eq(t.node("fp_a")!.width, width + 1, "Cmd+Right reaches the canvas resize shortcut");
    await t.io.key("Tab", { shift: true });
    t.eq(await t.ev("document.activeElement.id"), "sidebar-section-menu", "Shift+Tab focuses the menu trigger");
    await t.io.key("Enter");
    t.ok(await t.ev(visible("#sidebar-menu")), "Enter opens the focused menu");
    await t.io.key("Escape");
    t.eq(await t.ev("document.activeElement.id"), "sidebar-section-menu", "Escape closes the menu and restores focus");
    t.eq(await t.sel(), ["fp_a"], "menu navigation leaves the selected layer alone");

    await t.ev("canvasHost.setSelection(['al_txt'])");
    t.eq(await t.sel(), ["al_txt"], "a text layer is selected");
    await click(t, "#sidebar-section-menu");
    await t.io.key("Home");
    await t.io.key("Enter");
    t.eq(await focused(), "sidebar-layers-panel", "Enter selects the menu item with a text layer selected");
    t.eq(await t.sel(), ["al_txt"], "the text layer stays selected");
  } finally {
    await reset(t);
    await t.page.send("Page.bringToFront");
  }
});

sc("sidebar", "browser widget drag ignores file drops and clears on cancellation", {
  covers: ["sidebar:previews"],
  skip: { visual: "Widget creation is checked on disk." },
}, async (t: T) => {
  await select(t, "widgets");
  const count = () => t.widgets().widgets.length;
  const before = count();
  const drag = (finish: "files" | "cancel" | "widget") => t.ev(`(() => {
    const tile = document.querySelector('[data-widget=todo]');
    const widget = new DataTransfer();
    tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: widget }));
    if (${JSON.stringify(finish)} === 'cancel') {
      tile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: widget }));
    }
    const files = new DataTransfer();
    files.items.add(new File(['sample'], 'sample.txt', { type: 'text/plain' }));
    const transfer = ${JSON.stringify(finish)} === 'files' ? files : widget;
    document.querySelector('#view').dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 640, clientY: 480,
    }));
  })()`);
  try {
    await drag("files");
    await drag("cancel");
    await t.flush();
    t.eq(count(), before, "neither a file drop nor a cancelled tile creates a widget");
    await drag("widget");
    await t.waitFor(`fetch(canvasHost.api('/api/widgets')).then(r => r.json()).then(x => x.widgets.length === ${before + 1})`,
      "a widget from a valid tile drop");
  } finally {
    await reset(t);
  }
});
