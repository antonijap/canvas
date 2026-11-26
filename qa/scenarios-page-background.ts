import fs from "node:fs";
import path from "node:path";
import { sc, T } from "./harness.ts";

sc("page background", "page colour follows switching, reset, themes and undo", { covers: ["page-background:set", "page-background:reset", "page-background:themes", "page-background:undo", "pages:other-page"], skip: { visual: "Native QA samples canvas pixels in both themes; this scenario checks page state and persistence without a binary baseline." } }, async (t: T) => {
  await t.showPage("layout");
  await t.a.patch("/api/pages/layout", { background: "#2468AC" });
  const bg = "getComputedStyle(document.getElementById('view')).backgroundColor";
  await t.waitFor(`${bg} === 'rgb(36, 104, 172)'`, "custom canvas colour");
  await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  t.eq(await t.ev(bg), "rgb(36, 104, 172)", "custom colour in dark theme");
  await t.showPage("style");
  await t.waitFor(`${bg} === 'rgb(24, 24, 27)'`, "other page uses dark default");
  await t.showPage("layout");
  t.eq(await t.ev(bg), "rgb(36, 104, 172)", "colour returns with page");
  await t.a.patch("/api/pages/layout", { background: null });
  await t.waitFor(`${bg} === 'rgb(24, 24, 27)'`, "reset uses dark default");
  await t.undo();
  await t.waitFor(`${bg} === 'rgb(36, 104, 172)'`, "undo restores colour");
  await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  t.eq(await t.ev(bg), "rgb(36, 104, 172)", "custom colour in light theme");
});

sc("page background", "page styles select instance layers and replace a color in one undo step", {
  covers: ["page-styles:colors", "page-styles:text", "page-styles:selection", "page-styles:replace", "page-styles:undo"],
  skip: { visual: "Checks the styles API and the Layers panel selection command used by the native inspector." },
}, async (t: T) => {
  await t.showPage("components");
  const url = "/api/page-styles?page=components";
  const before = await t.a.get(url);
  const color = before.colors.find((row: { value: string }) => row.value === "#FFFFFF");
  t.ok(color?.ids?.includes("inst_plain/cmp_button_label"), "an instance's inherited layer is counted");
  t.eq(color.count, color.ids.length, "the count is the number of layers");
  t.ok(before.text.some((row: { family: string; ids: string[] }) => row.family === "Inter" && row.ids.includes("inst_plain/cmp_button_label")), "the instance's text style is listed");
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "layers", op: "select", ids: ${JSON.stringify(color.ids)} })`);
  t.eq(await t.sel(), color.ids, "the Layers command selects every match");
  await t.a.post("/api/page-styles", { page: "components", rev: before.rev, from: color.value, to: "#154778" });
  const changed = await t.a.get(url);
  t.eq(changed.colors.find((row: { value: string }) => row.value === "#154778")?.ids, color.ids, "every matching layer takes the new color");
  await t.a.post("/api/history/undo");
  t.eq((await t.a.get(url)).colors, before.colors, "one undo restores the whole row");
});

sc("export", "export the page boards into one folder", {
  covers: ["page-styles:export"],
  skip: { visual: "Checks the exact board ids and named SVG files the page inspector's export request produces." },
}, async (t: T) => {
  const dir = fs.mkdtempSync(path.join(t.file, "page-export-"));
  try {
    const result = await t.a.post("/api/export", { file: t.file, page: "components", format: "svg", scale: 3, dir });
    t.eq(result.files.map((file: { id: string }) => file.id), ["cmp_main", "cmp_inst"], "only top-level boards on the requested page");
    t.eq(fs.readdirSync(dir).sort(), ["Instances.svg", "Main components.svg"], "board names at the vector's fixed scale");
    t.eq(result.files[0].width, 520, "SVG exports at 1x");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
