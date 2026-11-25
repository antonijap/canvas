import { openingState } from "../../bench/native-opening-picture.ts";
// Home, the pinned first tab (apps/macos/Home.swift, HomeLogic.swift): the tab is first and cannot be closed, the
// shortcut and Window > Home show it, a card opens its file, a missing file offers Remove from recents, the comment
// count and the cloud on a shared card, the server view, the first-launch header and line, thumbnails in the state folder,
// and the alignment of the controls. Screenshots of the three states, light and dark, go to qa/out/native.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { METRICS } from "../../src/tokens.ts";
import { copyDir, sleep } from "../lib.ts";
import { PLAYGROUND } from "../playground.ts";
import { QaApp } from "./app.ts";
import { center, NT, sc } from "./harness.ts";

const OUT = `${process.cwd()}/qa/out/native`;
const shot = async (t: NT, name: string) => { fs.mkdirSync(OUT, { recursive: true }); await t.shot(`${OUT}/${name}.png`); };
const baseName = (f: string) => path.basename(f).replace(/\.canvas$/, "");
const thumbOf = (state: string, file: string) => path.join(state, "thumbnails", createHash("sha256").update(file).digest("hex").slice(0, 32) + ".png");

async function home(t: NT) {
  if (!(await t.state()).homeShown) {
    await t.click(center(await t.mark({ id: "home-tab" })));
    await t.waitState((s) => s.homeShown, "Home to show");
  }
  await t.mark({ id: "home-row", label: "Recents" });
  await sleep(250);
}
async function leaveHome(t: NT, name: string) {
  const m = await t.mark({ id: "home-card", label: name });
  await t.click(center(m));
  try { await t.waitState((s) => !s.homeShown, "a card to leave Home"); } catch (e) {
    const s = await t.state();
    throw new Error(`${(e as Error).message}: click at ${JSON.stringify(m)}, home ${s.homeShown}, file ${s.file}, recents ${JSON.stringify(s.recents)}`);
  }
}
const cards = async (t: NT) => (await t.marks({ id: "home-card" })).map((m) => m.label);

/** Mark frames that must agree: the same height, or a shared centre. */
function sameHeight(t: NT, what: string, rs: { h: number }[]) { for (const r of rs) t.near(r.h, rs[0].h, 0.6, `${what}: controls in a row share one height`); }
const midY = (r: { y: number; h: number }) => r.y + r.h / 2;
const midX = (r: { x: number; w: number }) => r.x + r.w / 2;

function sharedComments(file: string, url: string | null, open: number, resolved = 0) {
  const doc = randomUUID();
  const thread = (i: number, done: boolean) => ({ id: randomUUID(), doc, anchor: { nodeId: "x", x: 0, y: 0, board: "b" }, createdAt: new Date().toISOString(), createdBy: { name: "Ana" }, ...(done ? { resolvedAt: new Date().toISOString() } : {}), comments: [{ id: randomUUID(), body: `c${i}` }] });
  const threads = [...Array.from({ length: open }, (_, i) => thread(i, false)), ...Array.from({ length: resolved }, (_, i) => thread(i + 90, true))];
  fs.writeFileSync(path.join(file, "comments.json"), JSON.stringify({ format: 1, doc, seq: 0, ...(url ? { server: { url } } : {}), threads, outbox: [] }, null, 2));
}

sc("home", "Home is the first tab, never closes, and Shift+Cmd+0 and Window > Home show it", { covers: ["home:pinned", "home:shortcut", "home:card-open"] }, async (t: NT) => {
  const name = baseName(t.file);
  let st = await t.state();
  t.eq(st.homeShown, false, "a file is showing, not Home");
  const tab = await t.mark({ id: "home-tab" });
  const icon = await t.mark({ id: "pinned-tab-icon" });
  t.near(tab.w, 32, 0.6, "with files open Home uses one icon slot");
  t.near(tab.h, 38, 0.6, "Home spans the strip height");
  t.near(midX(icon), midX(tab), 0.6, "the house is centred across the tab");
  t.near(midY(icon), midY(tab), 0.6, "the house is centred down the tab");
  t.ok(tab.x < 120, `Home is the first tab, right after the traffic lights (x ${tab.x})`);
  t.ok((await t.marks({ label: "Home", id: "text" })).length === 0, "the glyph alone, no name, while files are open");
  await t.click(center(tab));
  await t.waitState((s) => s.homeShown, "a click on the tab to show Home");
  await t.mark({ id: "home-card", label: name });
  // Cmd+W with Home showing closes nothing.
  const before = (await t.state()).openFiles.length;
  await t.key("w", ["cmd"]);
  await sleep(400);
  st = await t.state();
  t.ok(st.homeShown && st.openFiles.length === before, "Cmd+W does not close Home or the tab under it");
  // A card opens its file in its tab; the shortcut brings Home back; so does the menu item.
  await leaveHome(t, name);
  t.eq((await t.state()).file, t.file, "the card opened the file's tab");
  await t.key("0", ["cmd", "shift"]);
  await t.waitState((s) => s.homeShown, "Shift+Cmd+0 to show Home");
  await leaveHome(t, name);
  const item = await t.cmd("qa.mainmenu", { title: "Home" });
  t.eq(item.key, "0", "Window > Home has the key 0");
  t.eq(item.mods, (1 << 17) | (1 << 20), "with Shift and Cmd");
  await t.cmd("qa.mainmenu", { title: "Home", perform: true });
  await t.waitState((s) => s.homeShown, "Window > Home to show Home");
  // The last file tab closed: Home is what is left, and it carries its name again.
  await leaveHome(t, name);
  // Earlier scenarios of a run leave their tabs open: close those first, then this one with Cmd+W.
  for (const f of (await t.state()).openFiles.filter((x: string) => x !== t.file)) await t.app.cmd({ op: "close", args: { file: f } });
  await t.waitState((s) => s.file === t.file && !s.homeShown, "the shown tab to stay");
  await t.key("w", ["cmd"]);
  await t.waitState((s) => s.openFiles.length === 0 && s.homeShown, "Home after the last tab closed");
  await sleep(500);
  const wide = await t.mark({ id: "home-tab" });
  t.ok(wide.w > 60, `with no file open the tab shows its name (${wide.w} wide)`);
  t.near(wide.h, 38, 0.6, "the same strip height");
  await t.app.openShown(t.file);
  await t.waitState((s) => s.file === t.file && !s.homeShown, "the file to open again");
});

sc("home", "Home: recents newest first, comment count and a cloud on a shared card, a missing file, On this Mac and search, thumbnails, alignment", { covers: ["home:recents", "home:remove", "home:thumbnail", "home:alignment", "home:server", "home:light", "home:dark"] }, async (t: NT) => {
  const team = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/v1/info" ? JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }) : JSON.stringify({ email: "anna@studio.test", name: "anna", role: "owner" }));
  });
  await new Promise<void>((r) => team.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(team.address() as { port: number }).port}`;
  const host = url.replace("http://", "");
  const mk = (n: string) => { const f = path.join(t.app.docs, `home-${n}.canvas`); copyDir(PLAYGROUND, f); return f; };
  const [b, c, gone] = [mk("b"), mk("c"), mk("gone")];
  sharedComments(b, url, 3, 2);
  sharedComments(c, null, 2, 1);
  const open = async (f: string) => {
    await t.app.openShown(f);
    await t.waitState((s) => s.file === f && s.pages.length > 0, `${baseName(f)} to open`, 20_000);
    await t.settle();
    await sleep(300);
  };
  try {
    for (const f of [b, c, gone]) await open(f);
    fs.rmSync(gone, { recursive: true, force: true });
    await t.cmd("qa.theme", { theme: "light" });
    await t.cmd("qa.cloud", { url, devEmail: "anna@studio.test" });
    await home(t);
    const st = await t.state();
    t.eq(st.recents.slice(0, 4), [gone, c, b, t.file], "recents: newest first");
    // Thumbnails: a snapshot of each canvas the person left, 480 px wide, in the state folder, never in the package.
    for (const f of [t.file, b]) {
      const p = thumbOf(st.stateDir, f);
      await t.waitFor(async () => fs.existsSync(p), `a thumbnail of ${baseName(f)}`, 8000);
      const png = fs.readFileSync(p);
      t.eq(png.readUInt32BE(16), 480, "the thumbnail is 480 px wide");
      t.ok(png.length > 4000, `the thumbnail is a picture, not a blank (${png.length} bytes)`);
      t.ok(!fs.existsSync(path.join(f, "thumbnail.png")) && !fs.readdirSync(f).some((n) => /png$/i.test(n) && n.startsWith("home")), "nothing written into the package");
    }
    const names = await cards(t);
    t.eq(names.slice(0, 3), ["home-gone", "home-c", "home-b"], `cards newest first: ${names}`);
    // The missing file.
    await t.mark({ label: "Moved or deleted" });
    // Comments and place.
    const badges = await t.marks({ id: "home-comments" });
    t.eq(badges.map((m) => m.label).sort(), ["2", "3"], "open comments only: resolved ones do not count");
    // A card's meta row is its time; a shared file gets a cloud before it (the server's name is in its tooltip).
    const grid = await t.marks({ id: "home-card" });
    const cardsArea = { x: Math.min(...grid.map((m) => m.x)) - 4, y: grid[0].y - 4, w: 10_000, h: 10_000 };
    t.eq((await t.findText("This Mac", cardsArea)).length, 0, "a file that is not shared names no place");
    const clouds = await t.marks({ id: "home-card-where-glyph" });
    t.eq(clouds.map((m) => m.label), [host], "one cloud, on the shared file's card, naming its server");
    const bCard = await t.mark({ id: "home-card", label: "home-b" });
    t.ok(clouds[0].x >= bCard.x - 0.6 && clouds[0].x + clouds[0].w <= bCard.x + bCard.w + 0.6 && clouds[0].y > bCard.y + bCard.h, "the cloud sits under the shared file's picture");
    // The cloud's own mark carries the name (its tooltip), so read the drawn text: no text mark, and none on screen.
    t.eq((await t.marks({ id: "text", label: host, region: cardsArea })).length, 0, "the server's name is not a text on the card");
    t.eq((await t.ocr(host, cardsArea)).length, 0, "the server's name is not written on the card");
    await shot(t, "home-recents-light");
    await t.cmd("qa.theme", { theme: "dark" });
    await sleep(500);
    await shot(t, "home-recents-dark");
    await t.cmd("qa.theme", { theme: "light" });
    await sleep(400);
    // Alignment: the header buttons share a height, the search field matches the same field height,
    // sidebar rows share one height, and a card's picture and name share its left edge.
    const open1 = await t.mark({ id: "home-open" }), nw = await t.mark({ id: "home-new" });
    sameHeight(t, "Open and New file", [open1, nw]);
    t.near(midY(open1), midY(nw), 0.6, "Open and New file sit on one line");
    t.near(open1.h, 28, 0.6, "the field height");
    const search = await t.mark({ id: "home-search" });
    sameHeight(t, "search and buttons", [search, open1]);
    t.eq((await t.marks({ id: "home-filter" })).length + (await t.marks({ id: "home-segment" })).length, 0, "no filter segments over the cards: the sidebar picks");
    const rows = await t.marks({ id: "home-row" });
    sameHeight(t, "sidebar rows", rows);
    // The Clouds sit under a quiet label with a + (Add Cloud), not as a row of their own.
    await t.mark({ id: "home-add-cloud", label: "Add Cloud" });
    t.eq((await t.marks({ id: "home-row", label: "Add Cloud" })).length, 0, "no Add Cloud row: the label's + adds one");
    t.ok(rows.every((r) => Math.abs(r.x - rows[0].x) < 0.6 && Math.abs(r.w - rows[0].w) < 0.6), "sidebar rows share one left edge and width");
    t.near(search.x, rows[0].x, 0.6, "the search field and the rows share their left edge");
    t.near(search.w, rows[0].w, 0.6, "and their width");
    const card = (await t.marks({ id: "home-card" }))[0];
    t.ok(card.w >= 220, `a card keeps its minimum width (${card.w})`);
    t.near(card.w / card.h, 1.6, 0.05, "the picture keeps its shape");
    // The sidebar picks what the main view lists: On this Mac, then Recents with every file again.
    const pick = async (label: string, section: string) => {
      await t.click(center(await t.mark({ id: "home-row", label })));
      await t.waitState((s) => s.homeSection === section, label);
      await sleep(350);
    };
    await pick("On this Mac", "mac");
    const mac = await cards(t);
    t.ok(!mac.includes("home-b") && mac.includes("home-c") && mac.includes("home-gone"), `On this Mac: the files that are not shared (${mac})`);
    await pick("Recents", "recents");
    const every = await cards(t);
    t.ok(every.includes("home-b") && every.includes("home-c") && every.includes("home-gone"), `Recents: every file, shared or not (${every})`);
    // Search, in the sidebar.
    await t.click(center(search));
    await t.type("home-c");
    await sleep(350);
    t.eq(await cards(t), ["home-c"], "search filters by name");
    await t.type("zzz");
    await sleep(350);
    t.eq((await cards(t)).length, 0, "a search that matches nothing lists no cards");
    const noMatch = await t.mark({ id: "home-empty", label: "No files match \u201Chome-czzz\u201D" });
    t.ok(noMatch.h > 200, `the line is centred in the space under the header, with no box (${noMatch.h})`);
    await t.key("a", ["cmd"]);
    await t.key("Delete");
    await sleep(350);
    t.ok((await cards(t)).length >= 4, "an empty search shows everything again");
    // Remove from recents, on the missing file's card.
    await t.click(center(await t.mark({ id: "home-remove" })));
    await t.waitState((s) => !s.recents.includes(gone), "the missing file to leave the recents");
    t.ok(!(await cards(t)).includes("home-gone"), "its card is gone");
    // The local card offers file and recents actions.
    await t.click(center(await t.mark({ id: "home-card", label: "home-c" })), { right: true });
    await t.waitState((s) => s.menu, "the card's menu");
    const menu = (await t.state()).menu.items as string[];
    t.eq(menu, ["Open", "Duplicate", "Rename", "Copy Link", "Show in Finder", "Move to Cloud", "Remove from recents", "Move to Trash"], "the card's menu");
    await t.pickMenu("Remove from recents");
    await t.waitState((s) => !s.recents.includes(c), "home-c to leave the recents");
    // The Cloud's row and its page: no dot while it works (a row speaks only when it needs the person), the same cards
    // as Recents under its name, a gear for its settings, and no status card or table.
    const row = await t.mark({ id: "home-row", label: host }, 15_000);
    await sleep(1500);
    t.eq((await t.marks({ id: "home-cloud-word" })).length, 0, "a Cloud that works shows no word and no dot");
    t.eq((await t.marks({ id: "home-server-dot" })).length, 0, "no green dots");
    await t.click(center(row));
    await t.waitState((s) => s.homeSection === "cloud", "the Cloud's page");
    t.ok((await t.marks({ id: "home-card", label: "home-b" })).length === 1, "the Cloud's page shows the file shared to it as a card");
    t.ok((await t.marks({ id: "home-card", label: "home-c" })).length === 0, "and not a file that is not shared");
    t.eq((await t.marks({ id: "home-server-card" })).length + (await t.marks({ id: "home-server-file" })).length, 0, "no status card, no table");
    t.eq((await t.marks({ id: "home-card-where-glyph" })).length, 0, "no cloud before each time: every card here is on this Cloud");
    t.eq((await t.marks({ id: "home-cloud-pill" })).length, 0, "no pill while the Cloud works");
    await t.mark({ id: "home-cloud-settings", label: "Cloud settings" });
    await t.findText("3");
    await shot(t, "home-cloud-light");
    await t.cmd("qa.theme", { theme: "dark" });
    await sleep(500);
    await shot(t, "home-cloud-dark");
    await t.cmd("qa.theme", { theme: "light" });
    await sleep(300);
    // A card opens its file in a tab, or shows the tab it is already in.
    await t.click(center((await t.mark({ id: "home-row", label: "Recents" }))));
    await t.waitState((s) => s.homeSection === "recents", "Recents");
    await leaveHome(t, "home-b");
    t.eq((await t.state()).file, b, "a card opens its file");
    const tabs = (await t.state()).openFiles.length;
    await home(t);
    await leaveHome(t, "home-b");
    t.eq((await t.state()).openFiles.length, tabs, "a card of a file already open shows its tab, not a second one");
  } finally {
    // The tabs this scenario opened go, so the pages it kept alive do not load the scenarios after it.
    for (const f of [gone, c, b]) await t.app.cmd({ op: "close", args: { file: f } }).catch(() => {});
    await t.cmd("qa.cloud", { url: "", devEmail: "" }).catch(() => {});
    team.closeAllConnections();
    await new Promise<void>((r) => team.close(() => r()));
  }
});

sc("home", "Home on a first launch: the Recents header and one line where the files will be", { covers: ["home:first-launch", "home:light", "home:dark", "home:alignment"] }, async (t: NT) => {
  const fresh = new QaApp(path.dirname(t.app.dir), 80 + t.app.shard);
  const was = process.env.CANVAS_QA_FIRST_RUN;
  process.env.CANVAS_QA_FIRST_RUN = "1";
  try { await fresh.start(t.app.app); } finally { if (was === undefined) delete process.env.CANVAS_QA_FIRST_RUN; else process.env.CANVAS_QA_FIRST_RUN = was; }
  try {
    const f = new NT(fresh, path.join(fresh.home, "Documents", "Canvas", "Welcome.canvas"));
    await f.waitState((s) => typeof s.file === "string" && s.file.endsWith("Welcome.canvas"), "the course file to open", 25_000);
    await f.settle(30_000);
    t.eq((await f.state()).recents, [], "the course the app opened is not a recent");
    await f.click(center(await f.mark({ id: "home-tab" })));
    await f.waitState((s) => s.homeShown, "Home");
    await sleep(600);
    await f.mark({ id: "text", label: "Recents" }, 8000);
    t.eq((await f.state()).recents, [], "with Home up, the course the app opened is still not a recent");
    const line = await f.mark({ id: "home-empty", label: "Files you open show up here" }, 8000);
    const open1 = await f.mark({ id: "home-open" }), nw = await f.mark({ id: "home-new" });
    sameHeight(t, "Open and New file", [open1, nw]);
    t.near(midY(open1), midY(nw), 0.6, "Open and New file sit on one line");
    t.near(open1.h, 28, 0.6, "the field height");
    t.ok(line.y > nw.y + nw.h, "the line sits under the header");
    for (const gone of ["Welcome to Canvas", "Start the course"]) t.eq((await f.marks({ label: gone })).length, 0, `no ${gone}`);
    for (const id of ["home-start", "home-start-mark", "home-empty-glyph", "home-search"]) t.eq((await f.marks({ id })).length, 0, `no ${id}`);
    t.eq((await f.marks({ id: "home-card" })).length, 0, "no recent cards yet");
    await f.cmd("qa.theme", { theme: "light" });
    await sleep(400);
    fs.mkdirSync(OUT, { recursive: true });
    await f.shot(`${OUT}/home-first-launch-light.png`);
    await f.cmd("qa.theme", { theme: "dark" });
    await sleep(500);
    await f.shot(`${OUT}/home-first-launch-dark.png`);
    // Learn Canvas in the sidebar opens the course (already a tab: it is shown, and now it is a recent).
    await f.click(center(await f.mark({ id: "home-row", label: "Learn Canvas" })));
    await f.waitState((s) => !s.homeShown && s.recents.length === 1, "the course to open from Home");
  } finally {
    await fresh.stop();
  }
});

/** Drags the handle at `handle` by dx and answers the stored width read by `key`. */
async function dragEdge(t: NT, key: "sidebarWidth" | "homeSidebarWidth", dx: number) {
  const h = await t.mark({ id: "sidebar-resize" });
  const from = { x: h.x + h.w / 2, y: h.y + h.h / 2 };
  await t.drag(from, { x: from.x + dx, y: from.y }, { steps: 20 });
  await sleep(250);
  return (await t.state())[key] as number;
}

sc("home", "Both sidebars drag from their right edge, stop at a minimum and a maximum, reset on double-click", { covers: ["sidebar-resize:home", "sidebar-resize:editor"] }, async (t: NT) => {
  // Home sidebar.
  await home(t);
  let h = await t.mark({ id: "sidebar-resize" });
  t.ok(h.w >= 12, `the grab strip is at least 12 pt wide (${h.w})`);
  const start = (await t.state()).homeSidebarWidth as number;
  t.eq(start, 232, "the Home sidebar starts at its default");
  t.near(await dragEdge(t, "homeSidebarWidth", 60), 292, 1.5, "dragging right 60 pt widens by 60");
  t.eq(await dragEdge(t, "homeSidebarWidth", -900), 200, "dragging far left stops at the minimum");
  const row = await t.mark({ id: "home-row", label: "Learn Canvas" });
  const label = await t.mark({ id: "text", label: "Learn Canvas" });
  t.ok(label.x + label.w <= row.x + row.w - 8, "at the minimum the longest label still fits its row");
  const plus = await t.mark({ id: "home-add-cloud" });
  t.ok(plus.x + plus.w <= row.x + row.w + 0.6, "and the Clouds label's + stays inside the sidebar");
  await shot(t, "home-sidebar-min");
  const max = await dragEdge(t, "homeSidebarWidth", 900);
  t.ok(max <= 360 && max >= 280, `dragging far right stops at the maximum (${max})`);
  await shot(t, "home-sidebar-max");
  h = await t.mark({ id: "sidebar-resize" });
  await t.doubleClick({ x: h.x + h.w / 2, y: h.y + h.h / 2 });
  await sleep(250);
  t.eq((await t.state()).homeSidebarWidth, 232, "double-click puts the Home sidebar back to its default");
  // Kept across launches: the widths are in the app's preferences the moment they change.
  const stored = (key: string) => Number(execFileSync("defaults", ["read", t.app.bundleId, key], { encoding: "utf8" }).trim());
  await dragEdge(t, "homeSidebarWidth", 40);
  t.eq(stored("canvas.homeSidebarWidth"), 272, "the Home sidebar's width is kept in preferences");
  // Editor panel.
  await leaveHome(t, baseName(t.file));
  await t.section("Layers");
  t.eq(await dragEdge(t, "sidebarWidth", -900), METRICS.sidebarMin, "the editor panel stops at its minimum");
  await shot(t, "editor-sidebar-min");
  t.eq(await dragEdge(t, "sidebarWidth", 900) <= 420, true, "and at its maximum");
  await shot(t, "editor-sidebar-max");
  const e = await t.mark({ id: "sidebar-resize" });
  await t.doubleClick({ x: e.x + e.w / 2, y: e.y + e.h / 2 });
  await sleep(250);
  t.eq((await t.state()).sidebarWidth, METRICS.sidebarWidth, "double-click puts the editor panel back to its default");
  await dragEdge(t, "sidebarWidth", 30);
  t.eq(stored("canvas.sidebarWidth"), METRICS.sidebarWidth + 30, "the editor panel's width is kept in preferences");
});

sc("tabs", "Warm tab switching keeps the same document page", { covers: ["tabs:warm-switch"] }, async (t: NT) => {
  const other = path.join(t.app.docs, "warm-tab.canvas");
  copyDir(PLAYGROUND, other);
  const before = await t.js<number>("return performance.timeOrigin;");
  try {
    await t.app.openShown(other);
    await t.waitState(s => s.file === other && s.pages.length > 0, "the second tab to open");
    const out = center(await t.mark({ id: "file-tab", label: baseName(other), exact: true }));
    const back = center(await t.mark({ id: "file-tab", label: baseName(t.file), exact: true }));
    const samples = [];
    for (let i = 0; i < 5; i++) {
      if (i) {
        await t.systemClick(out);
        await t.waitState(s => s.file === other, "the second tab to return");
      }
      await t.systemClick(back);
      await t.waitState(s => s.file === t.file && s.pages.length > 0, "the original tab to return");
      const marks = await openingState(t.app);
      if (marks.switched != null) samples.push(marks.switched - marks.action);
      t.eq(await t.js<number>("return performance.timeOrigin;"), before, "the page did not navigate again");
    }
    t.note(`switch samples ${JSON.stringify(samples)} ms`);
    t.ok(samples.length === 5 && samples.sort((a, b) => a - b)[2] < 100, "the median warm switch is under 100 ms");
  } finally {
    await t.cmd("close", { file: other });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

sc("tabs", "File tabs: drag one left or right to reorder, a short move is a click, Home stays first, the order is kept and Shift+Cmd+[ and ] follow it", { covers: ["tabs:drag", "tabs:threshold", "tabs:home-pinned", "tabs:saved", "tabs:step"] }, async (t: NT) => {
  for (const f of (await t.state()).openFiles.filter((x: string) => x !== t.file)) await t.app.cmd({ op: "close", args: { file: f } });
  const mk = (n: string) => { const f = path.join(t.app.docs, `tabs-${n}.canvas`); copyDir(PLAYGROUND, f); return f; };
  const [b, c] = [mk("b"), mk("c")];
  for (const f of [b, c]) {
    await t.app.openShown(f);
    await t.waitState((s) => s.file === f && s.pages.length > 0, `${baseName(f)} to open`, 20_000);
  }
  await t.settle();
  const order = async () => (await t.state()).openFiles as string[];
  const tabs = async () => (await t.marks({ id: "file-tab" })).sort((p, q) => p.x - q.x);
  const stored = () => JSON.parse(execFileSync("sh", ["-c", `defaults export ${t.app.bundleId} - | plutil -extract 'canvas\\.openFiles' json -o - -`], { encoding: "utf8" })) as string[];
  const mid = (m: { x: number; w: number; y: number; h: number }) => ({ x: m.x + m.w * 0.4, y: m.y + m.h / 2 });
  const last = async () => { const r = await tabs(); return r[r.length - 1]; };
  t.eq(await order(), [t.file, b, c], "three tabs in the order they were opened");

  // A press that moves a couple of points is a click: nothing reorders.
  let tb = await tabs();
  await t.drag(mid(tb[2]), { x: mid(tb[2]).x + 2, y: mid(tb[2]).y }, { steps: 4 });
  await sleep(300);
  t.eq(await order(), [t.file, b, c], "a 2 pt move never starts a drag");

  // Drag the last tab to the front: the others slide aside, the drop saves the order.
  const home0 = await t.mark({ id: "home-tab" });
  tb = await tabs();
  const frame0 = (await t.state()).window;
  await t.systemDrag(mid(tb[2]), { x: tb[0].x + 6, y: mid(tb[2]).y }, { steps: 3 });
  const frame1 = (await t.state()).window;
  t.eq([frame1.x, frame1.y, frame1.width, frame1.height], [frame0.x, frame0.y, frame0.width, frame0.height], "a fast tab drag never moves the window");
  await sleep(500);
  t.eq(await order(), [c, t.file, b], "the dragged tab took the first place");
  t.eq(stored(), [c, t.file, b], "the order is saved in preferences");
  const listed = await t.app.cmd({ op: "tabs" });
  t.eq(listed.tabs.map((x: { file: string }) => x.file), [c, t.file, b], "list_tabs reports the new order");
  tb = await tabs();
  t.eq(tb.map((m) => m.label), [baseName(c), baseName(t.file), baseName(b)], "the tabs are drawn in the new order");
  const home1 = await t.mark({ id: "home-tab" });
  t.ok(Math.abs(home1.x - home0.x) < 0.5 && home1.x + home1.w <= tb[0].x, "Home did not move and is still before the first file tab");
  t.near(tb[0].h, 38, 0.6, "tabs span the strip height");

  // The whole control row shares a hover lock, including the boundaries between Home, tabs and +.
  const controls = await t.mark({ id: "tab-controls" });
  const open = await t.mark({ id: "tab-new" });
  t.ok(controls.x <= home1.x && controls.x + controls.w >= open.x + open.w,
    "one hover region covers Home, file tabs and +");

  // Home is not draggable: pulling it right changes nothing.
  const l1 = await last();
  await t.systemDrag(center(home1), { x: l1.x + l1.w, y: center(home1).y }, { steps: 4 });
  const homeFrame = (await t.state()).window;
  t.eq([homeFrame.x, homeFrame.y], [frame0.x, frame0.y], "Home never drags the window");
  await sleep(400);
  t.eq(await order(), [c, t.file, b], "dragging Home reorders nothing");
  t.ok(Math.abs((await t.mark({ id: "home-tab" })).x - home0.x) < 0.5, "Home stays first");

  for (const control of [await t.mark({ id: "tab-new" }), await t.mark({ id: "tab-close", label: baseName(c) })]) {
    const from = center(control);
    await t.systemDrag(from, { x: from.x, y: from.y + 80 }, { steps: 4 });
    const frame = (await t.state()).window;
    t.eq([frame.x, frame.y], [frame0.x, frame0.y], "tab buttons never drag the window");
    t.eq(await order(), [c, t.file, b], "dragging off a tab button leaves the tabs open");
    if ((await t.state()).menu) await t.cmd("qa.menu", { cancel: true });
  }

  // A tab dragged right, to the end.
  tb = await tabs();
  const l2 = await last();
  await t.drag(mid(tb[0]), { x: l2.x + l2.w - 6, y: mid(tb[0]).y }, { steps: 24 });
  await sleep(500);
  t.eq(await order(), [t.file, b, c], "the first tab dragged to the end");

  // Shift+Cmd+[ and ] walk the strip in its new order.
  tb = await tabs();
  const l3 = await last();
  await t.drag(mid(tb[0]), { x: l3.x + l3.w - 6, y: mid(tb[0]).y }, { steps: 24 });
  await sleep(500);
  t.eq(await order(), [b, c, t.file], "dragged again: the order is b, c, the first file");
  await t.app.openShown(b);
  await t.waitState((s) => s.file === b && !s.homeShown, "b to show");
  t.eq((await t.cmd("qa.mainmenu", { title: "Next Tab" })).mods, (1 << 17) | (1 << 20), "Window > Next Tab has Shift and Cmd");
  await t.key("]", ["cmd", "shift"]);
  await t.waitState((s) => s.file === c, "Shift+Cmd+] to show the tab after b in the new order");
  await t.key("]", ["cmd", "shift"]);
  await t.waitState((s) => s.file === t.file, "Shift+Cmd+] to show the last tab");
  await t.key("]", ["cmd", "shift"]);
  await t.waitState((s) => s.homeShown, "Shift+Cmd+] after the last tab to show Home");
  await t.key("[", ["cmd", "shift"]);
  await t.waitState((s) => !s.homeShown && s.file === t.file, "Shift+Cmd+[ from Home to the last tab");
  await t.key("[", ["cmd", "shift"]);
  await t.waitState((s) => s.file === c, "Shift+Cmd+[ to the tab before");
});

sc("tabs", "File tabs overflow keeps natural widths, scrolls to the active file and reorders", { covers: ["tabs:overflow"] }, async (t: NT) => {
  const initial = await t.state();
  const files = ["Studio Plan", "Anna Notes", "Studio Schedule", "Studio Reference", "Studio Draft", "Studio Review"]
    .map((name) => { const file = path.join(t.app.docs, name + ".canvas"); copyDir(PLAYGROUND, file); return file; });
  const open = async (file: string) => {
    await t.app.openShown(file);
    await t.waitState((s) => s.file === file && !s.homeShown, "overflow file active");
    await t.settle();
  };
  const mark = (file: string) => t.mark({ id: "file-tab", label: baseName(file), exact: true });
  const single = new Map<string, number>();
  try {
    await t.cmd("qa.window", { width: 1000, height: 720 });
    for (const file of files) {
      await open(file);
      for (const other of (await t.state()).openFiles.filter((f: string) => f !== file))
        await t.app.cmd({ op: "close", args: { file: other } });
      await t.settle();
      single.set(file, (await mark(file)).w);
    }
    await t.app.cmd({ op: "close", args: { file: files[files.length - 1] } });
    for (const file of files) await open(file);
    t.eq((await t.state()).openFiles, files, "overflow tabs start in file order");
    const home = await t.mark({ id: "home-tab" });
    const plus = await t.mark({ id: "tab-new" });
    t.near(home.w, 46, 0.5, "the compact Home tab is 46 points wide");
    const firstAction = await t.mark({ id: "draw-tool", label: "Frame", exact: true });
    t.ok(firstAction.x - plus.x - plus.w >= 24, "overflow leaves at least 24 points to drag the window");
    t.ok([...single.values()].reduce((a, b) => a + b, 0) > plus.x - home.x - home.w,
      "natural widths exceed the strip");
    for (const file of files) {
      await open(file);
      const tab = await mark(file);
      t.near(tab.w, single.get(file)!, 1, baseName(file) + " keeps its single-tab width and is fully visible");
      t.ok(tab.x >= home.x + home.w - 1 && tab.x + tab.w <= plus.x + 1, "active tab is inside the strip");
    }
    // Both trailing tabs are visible after scrolling to the end. Drag across their midpoint.
    await open(files[4]);
    const from = await mark(files[5]);
    const before = await mark(files[4]);
    await t.systemDrag(center(from), { x: before.x + 6, y: center(from).y }, { steps: 16 });
    await t.settle();
    t.eq((await t.state()).openFiles, [files[0], files[1], files[2], files[3], files[5], files[4]], "overflow tabs reorder");
    await shot(t, "tabs-overflow");
  } catch (error) {
    await shot(t, "tabs-overflow-failure");
    throw error;
  } finally {
    for (const file of files) await t.app.cmd({ op: "close", args: { file } });
    await t.cmd("qa.window", { width: initial.window.width, height: initial.window.height });
  }
});

sc("comments", "Comment hint shares the canvas center and zoom center", { covers: ["comments:light", "comments:dark"] }, async (t: NT) => {
  const initial = await t.state();
  await t.settle();
  await t.key("c");
  await t.waitJs("document.querySelector('.cm-hint')?.classList.contains('on')", "comment hint");
  try {
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      for (const [width, height] of [[720, 420], [1280, 800], [2000, 1256]]) {
        await t.cmd("qa.window", { width, height });
        const zoom = await t.mark({ id: "zoom-island" });
        await t.waitJs(`Math.abs(document.querySelector('.cm-hint').getBoundingClientRect().y + document.querySelector('.cm-hint').getBoundingClientRect().height/2 - ${zoom.y + zoom.h/2}) <= 1`, 'hint on zoom center', 8000);
        const hint = await t.js<{ x:number; expected:number }>("const h=window.canvasHost, r=document.querySelector('.cm-hint').getBoundingClientRect(); return {x:r.x+r.width/2,expected:(h.insets.l+innerWidth-h.insets.r)/2}");
        t.near(hint.x, hint.expected, 1, 'centered on free canvas');
        const state = await t.state();
        const viewport = await t.js<{ w: number; h: number }>("return {w:innerWidth,h:innerHeight}");
        t.near(state.webFrame.x, 0, 1, `${theme} ${width}: webview starts at window left`);
        t.near(state.webFrame.y, 0, 1, `${theme} ${width}: webview starts at window top`);
        t.near(viewport.w, state.window.width, 1, `${theme} ${width}: page fills window width`);
        t.near(viewport.h, state.window.height, 1, `${theme} ${width}: page fills window height`);
      }
      await t.settle();
      await shot(t, `comments-island-${theme}`);
    }
  } catch (error) {
    await shot(t, "comments-island-failure");
    throw error;
  } finally {
    await t.key("escape");
    await t.cmd("qa.window", { width: initial.window.width, height: initial.window.height });
    await t.cmd("qa.theme", { theme: initial.theme });
  }
});

sc("tab-actions", "Tab context actions, inline rename and reorder", { covers: ["tabs:context-menu", "tabs:rename-menu", "tabs:rename-double-click", "tabs:close-others", "tabs:drag-after-rename"] }, async (t: NT) => {
  for (const file of (await t.state()).openFiles as string[]) {
    if (file !== t.file) await t.app.cmd({ op: "close", args: { file } });
  }
  const original = path.join(t.app.docs, "tab-actions.canvas");
  copyDir(PLAYGROUND, original);
  await t.app.openShown(original);
  await t.waitState((s) => s.file === original, "the action tab to open");
  const tab = (name: string) => t.mark({ id: "file-tab", label: name, exact: true });
  const point = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w * 0.4, y: r.y + r.h / 2 });
  const order = [...(await t.state()).openFiles];
  const prefs = (await t.state()).prefs;
  await t.cmd("qa.cloud", { url: "" });
  await t.click(point(await tab("tab-actions")), { right: true });
  await t.waitState((s) => s.menu, "tab context menu");
  const items = (await t.state()).menu.items as string[];
  t.eq(items, ["Duplicate", "Rename", "Copy Link", "Reveal in Home", "Show in Finder", "Close", "Close Other Tabs"], "local tab actions in order");
  await t.cmd("qa.menu", { cancel: true });
  await t.cmd("qa.cloud", { url: "http://127.0.0.1:1" });
  await t.click(point(await tab("tab-actions")), { right: true });
  await t.waitState((s) => s.menu, "configured Cloud tab menu");
  t.eq((await t.state()).menu.items, ["Duplicate", "Rename", "Copy Link", "Reveal in Home", "Show in Finder", "Move to Cloud", "Close", "Close Other Tabs"], "Cloud adds its share action");
  await t.cmd("qa.cloud", { url: prefs.cloudUrl, devEmail: prefs.cloudDevEmail, name: prefs.cloudName });
  t.eq((await t.state()).openFiles, order, "right click leaves the tab order alone");
  await t.pickMenu("Rename");
  const menuEdit = await t.mark({ id: "tab-rename" }).catch(async (error) => {
    throw new Error(`${error}; tabRename=${JSON.stringify((await t.state()).tabRename)}; editors=${JSON.stringify((await t.views()).filter((v) => v.kind === "text" && v.y < 70))}`);
  });
  const menuField = (await t.views()).find((v) => v.kind === "text" && v.editing && v.y < menuEdit.y + menuEdit.h && v.y + v.h > menuEdit.y);
  t.ok(menuField, "menu rename focuses the field");
  t.eq(menuField?.value, "tab-actions", "menu rename edits the intended tab");
  t.eq(menuField?.selection, { location: 0, length: "tab-actions".length }, "menu rename selects the whole name");
  await t.type("tab-menu-renamed");
  await t.key("return");
  const renamed = path.join(t.app.docs, "tab-menu-renamed.canvas");
  await t.waitState((s) => s.file === renamed, "menu rename to update the current file", 6000, async () => ({
    tabs: await t.marks({ id: "file-tab" }),
    editors: (await t.views()).filter((v) => v.kind === "text" && v.y < 70),
    originalExists: fs.existsSync(original), renamedExists: fs.existsSync(renamed),
  }));
  t.ok(fs.existsSync(renamed) && !fs.existsSync(original), "menu rename moved the package on disk");
  t.ok((await t.state()).recents.includes(renamed) && !(await t.state()).recents.includes(original), "Home recents follow the renamed file");
  // Start on an inactive tab too: the first click must switch without losing the second press.
  await t.systemClick(point(await tab(baseName(t.file))));
  await t.waitState((s) => s.file === t.file && !s.homeShown, "real single click switches file tabs");
  await t.systemClick(point(await tab("tab-menu-renamed")), { count: 2 });
  const edit = await t.mark({ id: "tab-rename" });
  const field = (await t.views()).find((v) => v.kind === "text" && v.editing && v.y < edit.y + edit.h && v.y + v.h > edit.y);
  t.ok(field, "real double click focuses the rename field");
  t.eq(field?.selection, { location: 0, length: "tab-menu-renamed".length }, "the whole name is selected");
  await t.type("tab-double-renamed");
  await t.key("return");
  const final = path.join(t.app.docs, "tab-double-renamed.canvas");
  await t.waitState((s) => s.file === final, "double click rename");
  t.ok(fs.existsSync(final) && !fs.existsSync(renamed), "double click rename moved the package on disk");
  await tab("tab-double-renamed");
  t.eq((await t.state()).openFiles, order.map((f: string) => f === original ? final : f), "double click never reorders");
  await t.systemClick(point(await tab("tab-double-renamed")), { count: 2 });
  await t.mark({ id: "tab-rename" });
  await t.type("cancelled-name");
  await t.key("escape");
  t.ok(fs.existsSync(final), "Escape cancels rename");
  t.ok(!fs.existsSync(path.join(t.app.docs, "cancelled-name.canvas")), "Escape creates no renamed file");
  t.eq((await t.marks({ id: "tab-rename" })).length, 0, "Escape closes the rename field");
  await t.systemClick(point(await tab("tab-double-renamed")), { count: 2 });
  await t.mark({ id: "tab-rename" });
  await t.type("tab-away-renamed");
  await t.click(center(await t.mark({ id: "home-tab" })));
  const away = path.join(t.app.docs, "tab-away-renamed.canvas");
  await t.waitState((s) => s.openFiles.includes(away), "click away commits rename");
  t.ok(fs.existsSync(away) && !fs.existsSync(final), "click away moved the package");
  const before = (await t.state()).openFiles as string[];
  const first = (await t.marks({ id: "file-tab" })).sort((a, b) => a.x - b.x)[0];
  await t.systemDrag(point(await tab("tab-away-renamed")), { x: first.x + 6, y: first.y + first.h / 2 }, { steps: 24 });
  const reordered = [away, ...before.filter((f) => f !== away)];
  await t.waitState(s => JSON.stringify(s.openFiles) === JSON.stringify(reordered), "drag reorder still works after renaming");
  await t.click(point(await tab("tab-away-renamed")), { right: true });
  await t.pickMenu("Close Other Tabs");
  await t.waitState((s) => s.openFiles.length === 1 && s.file === away, "close other tabs");
  t.eq((await t.state()).openFiles, [away], "only the target file tab remains");
  await t.app.openShown(t.file);
  await t.waitState((s) => s.file === t.file, "restore the scenario file");
  await t.app.cmd({ op: "close", args: { file: away } });
});

sc('comments', 'Bottom overlays share the free canvas center and zoom center', { covers: ['comments:light', 'comments:dark'] }, async (t: NT) => {
  await t.cmd('qa.cloud', { commentName: 'Anna' });
  await t.settle(); await t.key('c');
  await t.waitJs("document.querySelector('.cm-hint')?.classList.contains('on')", 'comment hint');
  const zoom = await t.mark({ id: 'zoom-island' });
  const g = await t.js<any>("const h = window.canvasHost, r = document.querySelector('.cm-hint').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth,l:h.insets.l,r:h.insets.r}");
  if (process.env.CANVAS_UI_SHOTS) { fs.mkdirSync(process.env.CANVAS_UI_SHOTS, { recursive: true }); await t.shot(path.join(process.env.CANVAS_UI_SHOTS, 'native-pills-' + (process.env.CANVAS_UI_BEFORE ? 'before' : 'after') + '.png')); }
  t.near(g.x, (g.l + g.w - g.r)/2, 1, 'free canvas center');
  t.near(g.y, zoom.y + zoom.h/2, 1, 'zoom center');
  await t.js("window.canvasHost.post({toast:'Layer copy ready'})");
  await t.waitState(s => s.toast === 'Layer copy ready', 'toast');
  await t.settle();
  const state = await t.state(); const text = state.toastFrames.text;
  t.ok(!!text, 'native toast has a measured frame');
  t.near(text.y + text.h/2, zoom.y + zoom.h/2, 2, 'native toast center');
  const hint = await t.js<any>("const r = document.querySelector('.cm-hint').getBoundingClientRect(); return {bottom:r.bottom}");
  t.ok(hint.bottom < text.y, 'hint stacks above the toast');
});

sc('home-cloud-menu', 'Cloud sidebar context menu renames and confirms leaving', { covers: ['home:cloud-context-menu'] }, async (t: NT) => {
  await t.cmd('qa.cloud', { clouds: [{url:'http://127.0.0.1:1',name:'Studio'}] });
  await t.click(center(await t.mark({id:'home-tab'})));
  const menu = async (name: string) => {
    await t.click(center(await t.mark({id:'home-row',label:name,exact:true})), {right:true});
    await t.waitState(s => !!s.menu, 'Cloud context menu');
  };
  await menu('Studio');
  t.eq((await t.state()).menu.items, ['Rename', 'Settings', 'Leave Cloud'], 'server Cloud actions');
  await t.pickMenu('Rename');
  await t.waitState(s => !!s.modal, 'rename dialog');
  await t.type('Studio team', {window:'modal'});
  const rename = (await t.views('modal')).find(v => v.kind === 'button' && v.title === 'Rename');
  t.ok(rename, 'rename button');
  await t.click(center(rename!), {window:'modal'});
  await t.waitState(s => !s.modal, 'rename closes');
  await menu('Studio team');
  await t.pickMenu('Leave Cloud');
  await t.waitState(s => !!s.modal, 'leave confirmation');
  const cancel = (await t.views('modal')).find(v => v.kind === 'button' && v.title === 'Cancel');
  await t.click(center(cancel!), {window:'modal'});
  await t.waitState(s => !s.modal, 'cancel leaves Cloud intact');
  await menu('Studio team');
  await t.pickMenu('Leave Cloud');
  await t.waitState(s => !!s.modal, 'leave confirmation again');
  const leave = (await t.views('modal')).find(v => v.kind === 'button' && v.title === 'Leave');
  t.ok(leave, 'leave button');
  await t.click(center(leave!), {window:'modal'});
  await t.waitFor(async () => (await t.cmd('qa.cloud', {})).clouds.length === 0, 'confirmed leave removes the Cloud');
  await t.cmd('qa.cloud', {clouds:[{url:'canvas-cloud://11111111-1111-4111-8111-111111111111',name:'Studio host',kind:'hosted'}]});
  await menu('Studio host');
  t.eq((await t.state()).menu.items, ['Rename', 'Settings', 'Delete Cloud'], 'host deletes rather than leaves');
  await t.pickMenu('Delete Cloud');
  await t.waitState(s => !!s.modal, 'owner deletion confirmation');
  t.ok((await t.views('modal')).some(v => v.kind === 'button' && v.title === 'Delete'), 'owner confirms Delete');
  const keep = (await t.views('modal')).find(v => v.kind === 'button' && v.title === 'Cancel');
  await t.click(center(keep!), {window:'modal'});
  await t.waitState(s => !s.modal, 'cancel keeps hosted Cloud');
  await t.cmd('qa.cloud', {clouds:[]});
  await t.app.openShown(t.file);
  await t.waitState(s => s.file === t.file && !s.homeShown, 'restore the file after Home');
});

sc('comments-list-navigation', 'Native comment pill shows list instead of properties and centers pin', { covers: ['comments:list-navigation'] }, async (t: NT) => {
  await t.waitJs('!!window.canvasHost.comments', 'comments ready');
  await t.js(`const h=window.canvasHost;
    const op={opId:crypto.randomUUID(),doc:h.comments.doc||'00000000-0000-4000-8000-000000000000',at:new Date().toISOString(),op:{kind:'thread.create',thread:crypto.randomUUID(),comment:crypto.randomUUID(),anchor:{x:120,y:80,page:h.page},body:'Review this spacing'}};
    const r=await fetch('/api/comments/ops?file='+encodeURIComponent(h.file),{method:'POST',headers:{'x-canvas':'1','content-type':'application/json'},body:JSON.stringify({ops:[op]})});
    const result=await r.json(); if(!r.ok || result.rejected?.length) throw new Error(JSON.stringify(result)); await h.comments.reload();`);
  await t.waitJs("document.querySelector('.cm-bar').classList.contains('on')", 'comment pill');
  const click = async (selector: string) => {
    const p = await t.js<any>(`const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`);
    await t.click(p);
  };
  await click('.cm-bar');
  await t.waitJs("!!document.querySelector('.cm-sidebar:not([hidden]) .cm-thread-row')", 'native comments list');
  await t.settle();
  await click('.cm-thread-row');
  await t.waitJs('!!window.canvasHost.comments.open', 'thread opens');
  await t.settle();
  const g = await t.js<any>(`const h=window.canvasHost,v=h.view.getBoundingClientRect(),s=document.querySelector('.cm-sidebar').getBoundingClientRect(),p=document.querySelector('.cm-pin').getBoundingClientRect();return {x:p.x,y:p.bottom,cx:(v.left+h.insets.l+Math.min(v.right-h.insets.r,s.left))/2,cy:(v.top+h.insets.t+v.bottom-h.insets.b)/2,r:h.insets.r}`);
  t.ok(g.r > 200, 'native shell reserves the sidebar width');
  t.near(g.x,g.cx,2,'pin horizontally centered');
  t.near(g.y,g.cy,2,'pin vertically centered');
  await t.shot(path.join(process.cwd(), 'qa/out/native/comments-sidebar-navigation.png'));
  await click('.cm-sidebar-head button');
  await t.waitJs("document.querySelector('.cm-sidebar').hidden", 'list closes');
});

sc('home-card-menu', 'Home card copies its file link and duplicates the chosen file', { covers: [] }, async (t: NT) => {
  const file = t.file, name = path.basename(file, '.canvas');
  await t.click(center(await t.mark({id:'file-tab', label:name, exact:true})), {right:true});
  await t.pickMenu('Reveal in Home');
  await t.waitState(s => s.homeShown && s.homeSection === 'recents', 'revealed in Home');
  const cardMenu = async () => t.click(center(await t.mark({id:'home-card', label:name, exact:true})), {right:true});
  await cardMenu();
  const items = (await t.cmd('qa.menu')).items.map((item: { title: string }) => item.title);
  for (const title of ['Open', 'Duplicate', 'Rename', 'Copy Link', 'Show in Finder', 'Move to Cloud', 'Move to Trash']) {
    t.ok(items.includes(title), title);
  }
  await t.pickMenu('Copy Link');
  t.eq(new URL((await t.cmd('qa.pasteboard')).text).searchParams.get('file'), file, 'link names the card file');
  await cardMenu();
  await t.pickMenu('Duplicate');
  const copy = path.join(t.app.docs, name + ' copy.canvas');
  await t.waitState(s => s.file === copy && !s.homeShown, 'duplicate opened');
});
