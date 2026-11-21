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
