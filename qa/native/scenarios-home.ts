// Home, the pinned first tab (apps/macos/Home.swift, HomeLogic.swift): the tab is first and cannot be closed, the
// shortcut and Window > Home show it, a card opens its file, a missing file offers Remove from recents, the comment
// count and the team server on a card, the server view, the first-launch cards, thumbnails in the state folder,
// and the alignment of the controls. Screenshots of the three states, light and dark, go to qa/out/native.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
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
  t.near(tab.w, tab.h, 0.6, "with files open the Home tab shrinks to a circle");
  t.near(tab.h, 32, 0.6, "one control height");
  t.near(midX(icon), midX(tab), 0.6, "the house is centred across its circle");
  t.near(midY(icon), midY(tab), 0.6, "the house is centred down its circle");
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
  t.near(wide.h, 32, 0.6, "the same control height");
  await t.app.cmd({ op: "open", args: { file: t.file }, timeoutMs: 20_000 });
  await t.waitState((s) => s.file === t.file && !s.homeShown, "the file to open again");
});

sc("home", "Home: recents newest first, comment count and server on a card, a missing file, filter and search, thumbnails, alignment", { covers: ["home:recents", "home:remove", "home:thumbnail", "home:alignment", "home:server", "home:light", "home:dark"] }, async (t: NT) => {
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
    await t.app.cmd({ op: "open", args: { file: f }, timeoutMs: 20_000 });
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
    t.ok((await t.findText("This Mac")).length >= 1, "a file that is not shared says This Mac");
    t.ok((await t.findText(host)).length >= 1, "a shared file names its server");
    await shot(t, "home-recents-light");
    await t.cmd("qa.theme", { theme: "dark" });
    await sleep(500);
    await shot(t, "home-recents-dark");
    await t.cmd("qa.theme", { theme: "light" });
    await sleep(400);
    // Alignment: the header buttons share a height, the filter and the search field match the same field height,
    // sidebar rows share one height, and a card's picture and name share its left edge.
    const open1 = await t.mark({ id: "home-open" }), nw = await t.mark({ id: "home-new" });
    sameHeight(t, "Open and New file", [open1, nw]);
    t.near(midY(open1), midY(nw), 0.6, "Open and New file sit on one line");
    t.near(open1.h, 28, 0.6, "the field height");
    const filter = await t.mark({ id: "home-filter" }), search = await t.mark({ id: "home-search" });
    sameHeight(t, "filter, search and buttons", [filter, search, open1]);
    const rows = await t.marks({ id: "home-row" });
    sameHeight(t, "sidebar rows", rows);
    t.ok(rows.every((r) => Math.abs(r.x - rows[0].x) < 0.6 && Math.abs(r.w - rows[0].w) < 0.6), "sidebar rows share one left edge and width");
    t.near(search.x, rows[0].x, 0.6, "the search field and the rows share their left edge");
    t.near(search.w, rows[0].w, 0.6, "and their width");
    const card = (await t.marks({ id: "home-card" }))[0];
    t.ok(card.w >= 220, `a card keeps its minimum width (${card.w})`);
    t.near(card.w / card.h, 1.6, 0.05, "the picture keeps its shape");
    // Filter.
    const seg = async (label: string) => { const r = (await t.findText(label, filter))[0]; t.ok(r, `the ${label} segment`); await t.click(center(r)); await sleep(350); };
    await seg("Cloud");
    t.eq(await cards(t), ["home-b"], "Cloud: the shared file only");
    await seg("On this Mac");
    const mac = await cards(t);
    t.ok(!mac.includes("home-b") && mac.includes("home-c") && mac.includes("home-gone"), `On this Mac: the files that are not shared (${mac})`);
    await seg("All");
    // Search, in the sidebar.
    await t.click(center(search));
    await t.type("home-c");
    await sleep(350);
    t.eq(await cards(t), ["home-c"], "search filters by name");
    await t.key("a", ["cmd"]);
    await t.key("Delete");
    await sleep(350);
    t.ok((await cards(t)).length >= 4, "an empty search shows everything again");
    // Remove from recents, on the missing file's card.
    await t.click(center(await t.mark({ id: "home-remove" })));
    await t.waitState((s) => !s.recents.includes(gone), "the missing file to leave the recents");
    t.ok(!(await cards(t)).includes("home-gone"), "its card is gone");
    // Right-click offers Open, Show in Finder and Remove from recents.
    await t.click(center(await t.mark({ id: "home-card", label: "home-c" })), { right: true });
    await t.waitState((s) => s.menu, "the card's menu");
    const menu = (await t.state()).menu.items as string[];
    t.eq(menu, ["Open", "Show in Finder", "Remove from recents"], "the card's menu");
    await t.pickMenu("Remove from recents");
    await t.waitState((s) => !s.recents.includes(c), "home-c to leave the recents");
    // The server row and the server view.
    const dot = await t.mark({ id: "home-server-dot" }, 15_000);
    await t.waitFor(async () => (await t.marks({ id: "home-server-dot" }))[0]?.label === "Connected", "the server's dot to say Connected", 20_000);
    const dotNow = (await t.marks({ id: "home-server-dot" }))[0] ?? dot;
    const row = (await t.marks({ id: "home-row" })).find((r) => Math.abs(midY(r) - midY(dotNow)) < 1);
    t.ok(row, "the dot sits on its server row's centre line");
    await t.click(center(row!));
    await t.waitState((s) => s.homeSection === "server", "the server view");
    await t.waitText("Connected as anna@studio.test, owner", undefined, 15_000);
    t.ok((await t.marks({ id: "home-server-file", label: "home-b" })).length === 1, "the server view lists the file shared to it");
    t.ok((await t.marks({ id: "home-server-file", label: "home-c" })).length === 0, "and not a file that is not shared");
    await t.findText("3 open");
    await shot(t, "home-server-light");
    await t.cmd("qa.theme", { theme: "dark" });
    await sleep(500);
    await shot(t, "home-server-dark");
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

sc("home", "Home on a first launch: three cards and the empty recents", { covers: ["home:first-launch", "home:light", "home:dark", "home:alignment"] }, async (t: NT) => {
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
    for (const label of ["Welcome to Canvas", "Files you open show up here", "Start the course"]) await f.mark({ label }, 8000);
    const starts = await f.marks({ id: "home-start" });
    t.eq(starts.map((m) => m.label), ["Start the course", "New file", "Add Cloud"], "the three cards' buttons");
    sameHeight(t, "the start buttons", starts);
    t.ok(starts.every((s) => Math.abs(s.y - starts[0].y) < 0.6), "on one line");
    const marks = await f.marks({ id: "home-start-mark" });
    sameHeight(t, "the card marks", marks);
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
