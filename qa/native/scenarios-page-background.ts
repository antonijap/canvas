import path from "node:path";
import { NT, sc, center } from "./harness.ts";

sc("page background", "local colour, reset and reopen, with Cloud controls disabled", { covers: ["page-background:set", "page-background:reset", "page-background:themes", "page-background:undo", "page-background:persistence", "page-background:empty-selection", "page-background:cloud", "pages:other-page", "undo-redo:keyboard"] }, async (t: NT) => {
  await t.cmd("deselect");
  if (!(await t.state()).inspectorOpen) await t.cmd("qa.mainmenu", { title: "Show Properties", perform: true });
  await t.mark({ label: "Page", exact: true });
  await t.fieldBelow("Background");
  const first = (await t.state()).pages[0].id;
  const made = await t.a.post("/api/pages", { name: "Empty page" });
  const empty = made.pages.at(-1).id;
  await t.cmd("page", { page: empty });
  await t.settle();
  const value = () => t.widgets().pages.find((p: any) => p.id === empty)?.background;
  await t.setField(await t.fieldBelow("Background"), "2468AC");
  await t.waitDisk(() => value() === "#2468AC", "page background stored");
  const check = async (color: string) => {
    await t.settle();
    const s = await t.state();
    const region = { x: s.window.width / 2, y: s.window.height / 2, w: 60, h: 60 };
    await t.waitFor(async () => {
      const px = await t.cmd("qa.pixels", { region, colors: [color], tol: 3 });
      return px.count / Math.max(1, px.total) > 0.95;
    }, `canvas pixels ${color}`);
  };
  await check("#2468AC");
  await t.shot(path.resolve("qa/out/native/page-background-custom.png"));
  const hex = await t.fieldBelow("Background");
  await t.click({ x: hex.x - 14, y: hex.y + hex.h / 2 });
  await t.waitState(s => s.popoverShown, "colour picker opens");
  await t.key("Escape", [], { window: "popover" });
  await t.waitState(s => !s.popoverShown, "colour picker closes");
  await t.cmd("qa.theme", { theme: "dark" });
  await check("#2468AC");
  await t.click(center((await t.pageRow(first)).r));
  await t.waitState(s => s.activePage === first, "first page");
  t.eq(await t.js("return getComputedStyle(document.getElementById('view')).backgroundColor"), "rgb(24, 24, 27)", "default follows dark theme");
  await t.click(center((await t.pageRow(empty)).r));
  await check("#2468AC");
  await t.click({ x: 600, y: 500 });
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => !value(), "undo clears background");
  await check("#18181B");
  await t.setField(await t.fieldBelow("Background"), "2468AC");
  await t.waitDisk(() => value() === "#2468AC", "background set again");
  await t.cmd("close", { file: t.file });
  await t.waitState(s => s.file === null, "file closed");
  await t.cmd("open", { file: t.file, focus: true });
  await t.waitState(s => s.file === t.file && s.pages.length > 0, "file reopened");
  await t.cmd("page", { page: empty });
  await check("#2468AC");
  await t.cmd("deselect");
  await t.click(center(await t.mark({ id: "properties-toggle" })));
  await t.waitState(s => !s.inspectorOpen, "properties hidden");
  await t.cmd("qa.mainmenu", { title: "Show Properties", perform: true });
  await t.fieldBelow("Background");
  await t.click(center(await t.mark({ id: "page-background-reset" })));
  await t.waitDisk(() => !value(), "reset removes the stored colour");
  await check("#18181B");
  await t.cmd("qa.theme", { theme: "light" });
  await check("#F6F6F6");
  await checkCloudPageBackground(t);
});

async function checkCloudPageBackground(t: NT) {
  const post = async (route: string, body: unknown) => {
    const res = await fetch(t.app.base + route, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    t.ok(res.ok, `${route} returned ${res.status}`);
    return await res.json() as any;
  };
  const host = await post("/api/cloud/host/start", { name: "Studio", label: "Editor" });
  let cloudFile: string | undefined;
  try {
    const { file } = await post("/api/cloud/files/create", { cloud: host.url, name: "Shared design" });
    cloudFile = file;
    await t.cmd("open", { file, focus: true });
    await t.waitState(s => s.file === file && s.pages.length > 0 && !s.selection && !s.selectedWidget, "Cloud file opened without a selection");
    if (!(await t.state()).inspectorOpen) await t.cmd("qa.mainmenu", { title: "Show Properties", perform: true });
    await t.mark({ label: "Page", exact: true });
    await t.mark({ label: "Page colours stay on local files for now", exact: true });
    const field = await t.fieldBelow("Background");
    await t.click(center(field));
    t.ok(!(await t.fieldNow(field))?.editing, "Cloud colour field cannot be edited");
    await t.click({ x: field.x - 14, y: field.y + field.h / 2 });
    t.ok(!(await t.state()).popoverShown, "Cloud colour picker stays closed");
    const page = (await t.state()).pages[0].id;
    await t.click(center(await t.mark({ id: "page-blueprint" })));
    t.eq(await t.js("return window.canvasHost.pages[0].pattern ?? null"), null, "Cloud Blueprint control stays off");
    const res = await fetch(t.app.base + `/api/pages/${encodeURIComponent(page)}?file=${encodeURIComponent(file)}`, {
      method: "PATCH",
      headers: { "x-canvas": "1", "content-type": "application/json" },
      body: JSON.stringify({ background: "#2468AC" }),
    });
    t.eq(res.status, 422, "Cloud colour change refused");
    t.eq(((await res.json()) as { error: string }).error, "Page colours stay on local files for now", "Cloud colour error explains why");
    await t.shot(path.resolve("qa/out/native/page-background-cloud-disabled.png"));
    await t.cmd("open", { file: t.file, focus: true });
    await t.waitState(s => s.file === t.file && s.pages.length > 0 && !s.selection && !s.selectedWidget, "local file reopened without a selection");
    if (!(await t.state()).inspectorOpen) await t.cmd("qa.mainmenu", { title: "Show Properties", perform: true });
    t.eq((await t.marks({ label: "Page colours stay on local files for now", exact: true })).length, 0, "local file has no Cloud hint");
    await t.setField(await t.fieldBelow("Background"), "2468AC");
    const active = (await t.state()).activePage;
    await t.waitDisk(() => t.widgets().pages?.find((p: any) => p.id === active)?.background === "#2468AC", "local colour field works after switching");
    await t.cmd("open", { file, focus: true });
    await t.waitState(s => s.file === file && s.pages.length > 0, "Cloud tab reopened");
    await t.mark({ label: "Page colours stay on local files for now", exact: true });
  } finally {
    if (cloudFile) await t.cmd("close", { file: cloudFile }).catch(() => {});
    await post("/api/cloud/host/stop", { hostId: host.hostId });
    await post("/api/cloud/host/wipe", { hostId: host.hostId });
  }
}
