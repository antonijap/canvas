import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.ts";
import { sc, type T } from "./harness.ts";
import { fakeServer } from "../test/helpers.ts";


const visual = "Checks layout, state or contrast directly and keeps screenshots in QA output.";
const themes = ["light", "dark"] as const;
const tones = ["plain", "yellow", "green", "blue", "pink"];
const mode = (t: T, value: typeof themes[number]) => t.page.send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value }, { name: "prefers-reduced-motion", value: "reduce" }],
});

sc("widgets", "Page fits long text, shrinks on edit and keeps one undo step", { covers: ["note:card-note"], skip: { visual } }, async (t: T) => {
  const long = "# Studio\n" + ("A paragraph long enough to fill the text column. ".repeat(3) + "\n").repeat(55);
  const { widget: w } = await t.a.post("/api/widgets", { kind: "note", x: 2400, y: 140, config: { text: long } });
  const selector = JSON.stringify('.wd[data-id="widget:' + w.id + '"]');
  const read = () => t.ev<any>(`(() => {
    const c = document.querySelector(${selector}), e = c.querySelector(".nd"), s = getComputedStyle(e);
    return { w: c.offsetWidth, h: c.offsetHeight, scroll: e.scrollHeight, height: e.clientHeight, label: c.getAttribute("aria-label"), padding: s.padding, line: s.lineHeight };
  })()`);
  t.eq(w.w, 480, "default stored width");
  await t.look(w.x, w.y);
  await t.waitFor(`!!document.querySelector(${selector} + " .nd")`, "the Page editor");
  const before = await read();
  t.eq(before.padding, "24px 32px", "symmetric padding");
  t.eq(before.line, "26px", "body line height");
  t.eq(before.w, 664, "600px column plus padding");
  t.ok(before.h > 1600 && before.height >= before.scroll, "all long text is visible");
  const xy = await t.ev<any>(`(() => { const b = document.querySelector(${selector}).getBoundingClientRect(); return { x: b.left + 40, y: b.top + 39 }; })()`);
  await t.io.dblclick(xy.x, xy.y);
  await t.io.key("a", { meta: true });
  await t.io.type("Short page");
  await t.io.key("Escape");
  await t.flush();
  const after = await read();
  t.eq(after.label, "Short page", "the edited title is the widget name");
  t.eq(after.w, 480, "short text keeps a readable width");
  t.ok(after.h < 110, "short content shrinks the card");
  t.eq(t.widgets().widgets.find((item) => item.id === w.id).h, after.h, "height is saved with text");
  await t.undo();
  t.eq((await read()).label, "Studio", "one undo restores text and name");
  t.eq((await read()).h, before.h, "one undo restores height");
  const edge = await t.ev<any>(`(() => { const b = document.querySelector(${selector}).getBoundingClientRect(); return { x: b.right - 3, y: b.top + 80 }; })()`);
  await t.io.drag(edge.x, edge.y, edge.x - 440, edge.y);
  await t.flush();
  const narrow = await read();
  t.eq(narrow.w, 280, "manual width stops at 280px");
  t.eq(narrow.padding, "24px 32px", "padding is equal at minimum width");
  t.ok(narrow.h > before.h && narrow.height >= narrow.scroll, "narrow pages reflow and stay fully visible");
  await t.undo();
  await t.look(w.x, w.y, 0.2);
  t.eq(await t.ev(`document.querySelector(${selector} + " .wd-lod").textContent`), "Studio", "zoomed-out title");
});

for (const theme of themes) {
  sc("widgets", "Page text contrast in " + theme, { covers: ["note:card-note"], skip: { visual } }, async (t: T) => {
    await mode(t, theme);
    for (let i = 0; i < tones.length; i++) {
      await t.a.post("/api/widgets", {
        kind: "note", id: "contrast-" + tones[i], x: 2400, y: 160 * i,
        config: { text: "# A Page\nA [link](https://example.com) in the body.\n- [x] Muted text", tone: tones[i] },
      });
    }
    await t.look(2400, 0);
    await t.waitFor(`document.querySelectorAll('.wd[data-id^="widget:contrast-"] .nd').length === 5`, "all five tones");
    const results = await t.ev<any[]>(`(() => {
      const ctx = document.createElement("canvas").getContext("2d");
      const rgb = (color) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const lum = (pixels) => pixels.map((x) => x / 255).map((x) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((s, x, i) => s + x * [.2126, .7152, .0722][i], 0);
      return [...document.querySelectorAll('.wd[data-id^="widget:contrast-"]')].map((card) => {
        const body = getComputedStyle(card.querySelector(".nd"));
        const link = getComputedStyle(card.querySelector(".nd a"));
        const muted = getComputedStyle(card.querySelector('[data-checked="true"]'));
        const bg = lum(rgb(getComputedStyle(card).backgroundColor));
        const ratios = [body, link, muted].map((s) => {
          const fg = lum(rgb(s.color));
          return (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05);
        });
        return { tone: card.dataset.tone, ratios, underline: link.textDecorationLine + " " + link.textDecorationStyle };
      });
    })()`);
    for (const { tone, ratios, underline } of results) {
      t.ok(ratios.every((r: number) => r >= 4.5), tone + " contrast " + ratios.join(", "));
      t.eq(underline, "underline solid", "solid link underline");
    }
    fs.writeFileSync(path.join(ROOT, "qa", "out", "widget-page-" + theme + ".png"), await t.shot());
  });
}

sc("widgets", "live widget states, refresh, and resize chrome", { covers: ["card-resize:card-posthog"], skip: { visual } }, async (t: T) => {
  const { widget: w } = await t.a.post("/api/widgets", { kind: "metric", x: 2300, y: 60 });
  const sel = '.wd[data-id="widget:' + w.id + '"]';
  const card = "document.querySelector(" + JSON.stringify(sel) + ")";
  await t.look(w.x, w.y);
  await t.waitFor(`!!${card}?.querySelector('.wd-live[data-state="empty"]')`, "the missing source state");
  t.ok(await t.ev(`${card}.textContent.includes("Add a JSON URL")`), "the empty state tells the user where to set the URL");
  const inject = (r: object) => t.ev(`window.canvasHost.widgetReading(${JSON.stringify(w.id)}, ${JSON.stringify(r)})`);
  await inject({ state: "loading" });
  t.ok(await t.ev(`!!${card}.querySelector(".wd-skeleton")`), "loading skeleton");
  await inject({ state: "error", error: { code: "network", message: "The data source is offline." } });
  t.ok(await t.ev(`${card}.querySelector(".wd-live-status button").textContent === "Retry"`), "errors have a Retry button");
  await inject({ state: "stale", updatedAt: Date.now() - 180_000, value: 42, display: "42", spark: [20, 30, 42] });
  t.ok(await t.ev(`${card}.textContent.includes("Stale, updated 3m ago") && !!${card}.querySelector('[aria-label="Refresh"]')`), "stale data stays visible with its age and refresh");
  const r = await t.ev<any>(`(() => { const b = ${card}.getBoundingClientRect(); return { x: b.right - 4, y: b.bottom - 4 }; })()`);
  await t.io.move(r.x, r.y);
  t.eq(await t.ev(`getComputedStyle(${card}.querySelector(".wd-handles")).display`), "block", "corner handles show on hover");
  await t.io.drag(r.x, r.y, r.x + 70, r.y + 30, { during: async () => {
    t.ok(await t.ev(`!${card}.querySelector(".wd-size").hidden && /\u00d7/.test(${card}.querySelector(".wd-size").textContent)`), "width and height show during resize");
  } });
  await t.flush();
  t.eq(await t.ev(`${card}.querySelector(".wd-size").hidden`), true, "resize badge clears after drag");
  fs.writeFileSync(path.join(ROOT, "qa", "out", "widget-metric.png"), await t.shot());
});

sc("widgets", "video keeps its source aspect ratio during resize", { covers: ["card-resize:card-video"], skip: { visual } }, async (t: T) => {
  await t.showPage("cards");
  const w = t.widget("video");
  await t.look(w.x, w.y);
  const source = await t.waitFor<number>("(() => { const v = [...document.querySelectorAll('video')].find((x) => x.videoWidth); return v && v.videoWidth / v.videoHeight; })()", "video metadata");
  const expr = `window.canvasHost.widgetRect(${JSON.stringify("widget:" + w.id)})`;
  const element = `document.querySelector(${JSON.stringify('.wd[data-id="widget:' + w.id + '"]')})`;
  const edge = await t.ev<any>(`(() => { const b = ${element}.getBoundingClientRect(); return { x: b.right - 3, y: b.top + b.height / 2 }; })()`);
  await t.io.drag(edge.x, edge.y, edge.x + 85, edge.y, { during: async () => {
    const size = await t.ev<any>(expr);
    t.near(size.w / size.h, source, .02, "video keeps its ratio mid-drag");
  } });
  await t.flush();
  const size = await t.ev<any>(expr);
  t.near(size.w / size.h, source, .02, "video keeps its ratio after release");
  t.ok(size.w > w.w + 40, "video grew");
  await t.undo();
  t.eq(t.widget("video").w, w.w, "one undo restores the original size");
});

sc("widgets", "placeholder local widget approves each version and keeps its config when missing", { covers: ["card-add:card-note"], skip: { visual } }, async (t: T) => {
  const folder = path.join(t.srv.widgetsDir, "hello");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({
    id: "hello", title: "Hello", description: "Example greeting", defaultSize: { w: 250, h: 160 },
    settings: [{ key: "greeting", label: "Greeting", type: "text", default: "Hello" }],
  }));
  const renderer = path.join(folder, "renderer.js");
  fs.writeFileSync(renderer, `export default (root, { config }) => {
    root.textContent = config.greeting;
    parent.postMessage({ type: "fixture-hello", value: root.textContent }, "*");
  };`);
  const { widget } = await t.a.post("/api/widgets", { kind: "hello", x: 2300, y: 60, config: { greeting: "Hello, canvas" } });
  const card = '.wd[data-id="widget:' + widget.id + '"]';
  t.subject = ["widget:" + widget.id];
  await t.look(widget.x, widget.y);
  const allow = async () => {
    await t.waitFor(`document.querySelector(${JSON.stringify(card + " button[aria-label='Allow widget']")})`, "local trust prompt");
    t.ok(!(await t.ev(`!!document.querySelector(${JSON.stringify(card + " iframe")})`)), "no frame before approval");
    const rect = await t.ev<any>(`document.querySelector(${JSON.stringify(card + " button")}).getBoundingClientRect().toJSON()`);
    await t.io.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await t.waitFor(`!!document.querySelector(${JSON.stringify(card + " iframe[data-rendered]")})`, "the approved module to render");
  };
  await t.ev(`addEventListener("message", ({ source, data }) => {
    const frame = document.querySelector(${JSON.stringify(card + " iframe")});
    if (frame && source === frame.contentWindow && data?.type === "fixture-hello") window.fixtureGreeting = data.value;
  })`);
  await allow();
  await t.waitFor('window.fixtureGreeting === "Hello, canvas"', "the module renders this card's config");
  fs.appendFileSync(renderer, "\n// updated");
  await allow();
  const missing = path.join(t.srv.widgetsDir, "_removed");
  fs.renameSync(folder, missing);
  try {
    await t.waitFor(`document.querySelector(${JSON.stringify(card + " .un-title")})?.textContent === "Unsupported widget"`, "unsupported card");
    t.eq(t.widgets().widgets.find((w) => w.id === widget.id)?.config, { greeting: "Hello, canvas" }, "the saved config survives");
  } finally {
    fs.renameSync(missing, folder);
  }
  await t.waitFor(`!!document.querySelector(${JSON.stringify(card + " iframe[data-rendered]")})`, "the restored widget");
});

sc("widgets", "shared preview waits for Allow", { covers: ["widget-source-approval:shared-preview"], skip: { visual } }, async (t: T) => {
  const other = await fakeServer((_req, res) => res.end("Other origin"));
  const host = await fakeServer((req, res) => {
    if (req.url === "/leave") {
      res.writeHead(302, { location: other.url + "/redirected" }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>Preview fixture</title><img src="${other.url}/image"><iframe src="/leave"></iframe>`);
  });
  const file = path.join(t.file, "widgets.json");
  const original = fs.readFileSync(file);
  try {
    const state = t.widgets();
    state.widgets.push({ id: "shared-preview", kind: "page-preview", name: "Shared preview",
      x: 2300, y: 60, w: 400, h: 332, locked: false, config: { url: host.url } });
    fs.writeFileSync(file, JSON.stringify(state));
    await t.open();
    await t.look(2300, 60);
    const card = `document.querySelector('.wd[data-id="widget:shared-preview"]')`;
    const allow = `${card}?.querySelector('button[aria-label="Allow"]')`;
    const button = await t.waitFor<{ x: number; y: number; width: number; height: number }>(
      `${allow}?.getBoundingClientRect().toJSON()`, "the preview Allow button");
    t.ok(await t.ev(`${card}.textContent.includes(${JSON.stringify("Allow this widget to load " + host.url)})`), "prompt names the origin");
    t.eq(host.hits.length, 0, "opening the file made no request");
    await t.io.click(button.x + button.width / 2, button.y + button.height / 2);
    await t.waitFor(`!!${card}?.querySelector('img[src^="data:image/png"]')`, "the allowed preview", 30000);
    t.ok(host.hits.some((hit) => hit.method === "GET" && hit.url === "/"), "approved page was loaded");
    t.eq(other.hits.length, 0, "redirects and subresources cannot load another origin");
    await t.open();
    await t.look(2300, 60);
    await t.waitFor(`!!${card}?.querySelector('img[src^="data:image/png"]')`, "the preview stays approved after reopening");
  } finally {
    fs.writeFileSync(file, original);
    await host.close();
    await other.close();
  }
  await t.open();
});
