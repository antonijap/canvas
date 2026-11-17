// Optical alignment of the shell's newer UI, measured from the window's own 2x capture (qa/ink.ts): Settings (General's
// Updates and comment name, Cloud, Agents' Connect, Copy and model menus), About Canvas, the letter spacing field with
// its Auto chip and token button, and Home (the pinned tab, header, filter, sidebar rows, server, first launch).
// Light and dark. An icon sits in the middle of its control by its visible shape; a label by the middle of its
// capitals (SF Pro's cap height above the baseline the pixels show); a dot or a glyph beside text sits on the text's
// cap middle; paddings match. Every measurement goes to qa/out/alignment/native.jsonl, each crop beside it.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { decodePng, type Img } from "../../fidelity/png.ts";
import { AlignChecker, ALIGN_OUT, SF, bare, cx, cy, midX, midY, textLine, type Box, type Txt } from "../ink.ts";
import { measureJs, resolve } from "../ink-page.ts";
import { sleep } from "../lib.ts";
import { QaApp } from "./app.ts";
import { center, NT, sc } from "./harness.ts";

type Mark = { x: number; y: number; w: number; h: number; id: string; label: string | null };
type Shot = { img: Img; k: number; win: string };

/** The window as drawn, and its pixels per point. */
async function grab(t: NT, win = "main"): Promise<Shot> {
  await sleep(350); // hovers and theme colours settle
  const r = await t.cmd("qa.shot", { window: win, maxSide: 12000 });
  const img = decodePng(Buffer.from(r.data, "base64"));
  const st = await t.state();
  const w = win === "main" ? st.window.width : win === "settings" ? st.windows.find((x: any) => x.settings)?.width : st.windows.find((x: any) => x.title === "About Canvas")?.width;
  return { img, k: img.width / w, win };
}
const box = (m: Mark | undefined | null, r = 0): Box | null => (m ? { x: m.x, y: m.y, w: m.w, h: m.h, r } : null);
/** A line of SF text inside a mark, at `size` points. */
const line = (s: Shot, m: Mark | undefined | null, size: number, text?: string): Txt | null => (m ? textLine(s.img, s.k, m, text ?? m.label ?? "", size * SF.cap, size * SF.ex) : null);
const marks = (t: NT, win: string, id: string, label?: string) => t.marks({ id, label, window: win as any }) as Promise<Mark[]>;
const one = async (t: NT, win: string, id: string, label?: string) => (await marks(t, win, id, label))[0] ?? null;
/** The mark of `id` whose centre lies inside `r`. */
const inside = (ms: Mark[], r: { x: number; y: number; w: number; h: number } | null) => (r ? ms.find((m) => m.x + m.w / 2 >= r.x && m.x + m.w / 2 <= r.x + r.w && m.y + m.h / 2 >= r.y && m.y + m.h / 2 <= r.y + r.h) ?? null : null);

/** A FieldButton (Settings.swift): its label centred, a glyph on the label's cap middle. */
async function fieldButton(t: NT, k: AlignChecker, s: Shot, label: string, name: string) {
  const b = await one(t, s.win, "field-button", label);
  if (!b) { k.bad.push(`${name} (${k.theme}): no "${label}" button`); return; }
  const txt = inside(await marks(t, s.win, "field-button-text"), b), glyph = inside(await marks(t, s.win, "field-button-glyph"), b);
  k.label(name, box(b, 8), line(s, txt, 12, label));
  if (glyph) {
    const g = k.ink(`${name}-glyph`, bare(box(glyph)), { inset: 0 });
    k.near(`${name}: the glyph's middle on the label's cap middle`, midY(g), line(s, txt, 12, label)?.cap);
  }
}

/** A dot beside a line of text: on the text's cap middle. */
async function dotOnText(t: NT, k: AlignChecker, s: Shot, dotId: string, text: Mark | null, size: number, name: string) {
  const dots = await marks(t, s.win, dotId);
  const dot = text ? dots.find((d) => Math.abs(d.y + d.h / 2 - (text.y + text.h / 2)) < 14) : dots[0];
  const ink = k.ink(`${name}-dot`, box(dot, (dot?.w ?? 0) / 2), { inset: 0 });
  k.near(`${name}: the dot's middle on the text's cap middle`, midY(ink), line(s, text, size)?.cap);
}

async function openSettings(t: NT, tab: string) {
  if (!(await t.state()).windows.some((w: any) => w.settings)) {
    await t.key(",", ["cmd"]);
    await t.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
  }
  let b: any;
  for (let i = 0; i < 30 && !b; i++) {
    const bs = (await t.views("settings")).filter((v) => v.class === "NSToolbarButton").sort((x, y) => x.x - y.x);
    b = bs.find((v) => v.label === tab) ?? (bs.length === 8 ? bs[["General", "Canvas", "Agents", "Cloud", "Sounds", "Performance", "Privacy", "Shortcuts"].indexOf(tab)] : undefined);
    if (!b) await sleep(100);
  }
  t.ok(b, `no ${tab} tab`);
  await t.click(center(b), { window: "settings" });
  await sleep(400);
}

const report = (t: NT, bad: string[]) => t.ok(!bad.length, `${bad.length} alignment problems:\n  ${bad.join("\n  ")}`);
const fresh = (run: string) => { fs.mkdirSync(ALIGN_OUT, { recursive: true }); fs.rmSync(path.join(ALIGN_OUT, `${run}.jsonl`), { force: true }); };

sc("settings", "alignment: General, Cloud and Agents controls are optically centred, light and dark", { covers: ["settings:alignment", "settings:light", "settings:dark"] }, async (t: NT) => {
  fresh("native-settings");
  const team = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/v1/info" ? JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }) : JSON.stringify({ email: "anna@studio.test", name: "anna", role: "owner" }));
  });
  await new Promise<void>((r) => team.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(team.address() as { port: number }).port}`;
  const bad: string[] = [];
  try {
    await t.cmd("qa.cloud", { url, devEmail: "anna@studio.test" });
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      // General: Check for Updates, the comment name's field.
      await openSettings(t, "General");
      await t.mark({ id: "field-button", label: "Check for Updates", window: "settings" }, 4000);
      // A known name in the field (it starts as this Mac's full name, which no test should read or keep).
      if ((await t.state()).prefs.commentName !== "Anna Lee") {
        await t.click(center(await t.mark({ id: "comment-name", window: "settings" }, 4000)), { window: "settings" });
        await t.key("a", ["cmd"], { window: "settings" });
        await t.type("Anna Lee", { window: "settings" });
        await t.waitState((st) => st.prefs.commentName === "Anna Lee", "the name to change");
        await t.key("Tab", [], { window: "settings" });
      }
      let s = await grab(t, "settings");
      let k = new AlignChecker("native-settings", theme, s.img, s.k);
      await fieldButton(t, k, s, "Check for Updates", "general-check-for-updates");
      const name = await one(t, "settings", "comment-name");
      k.near("comment name: the text's cap middle on the field's centre line", line(s, name, 13, "Anna Lee")?.cap, cy(box(name)));
      bad.push(...k.bad);
      // Cloud: Sign out, Share Comments, the status dot.
      await openSettings(t, "Cloud");
      await t.waitFor(async () => (await marks(t, "settings", "cloud-status")).some((m) => m.label === "Connected"), "the cloud status to say Connected", 15_000);
      s = await grab(t, "settings");
      k = new AlignChecker("native-settings", theme, s.img, s.k);
      await fieldButton(t, k, s, "Sign out", "cloud-sign-out");
      await fieldButton(t, k, s, "Share Comments", "cloud-share");
      await dotOnText(t, k, s, "status-dot", await one(t, "settings", "cloud-status"), 13, "cloud-status");
      const urlField = await one(t, "settings", "cloud-url");
      k.near("server address: the text's cap middle on the field's centre line", line(s, urlField, 13, "http://127.0.0.1:1")?.cap, cy(box(urlField)));
      bad.push(...k.bad);
      // Agents: Connect and Copy, the status dot, Installed, the model and reasoning menus.
      await openSettings(t, "Agents");
      await t.mark({ id: "menu-field", window: "settings" }, 4000);
      await sleep(600);
      s = await grab(t, "settings");
      k = new AlignChecker("native-settings", theme, s.img, s.k);
      if (await one(t, "settings", "field-button", "Connect")) await fieldButton(t, k, s, "Connect", "agents-connect");
      await fieldButton(t, k, s, "Copy", "agents-copy");
      await dotOnText(t, k, s, "status-dot", await one(t, "settings", "status-text"), 13, "agents-status");
      const inst = await one(t, "settings", "install-text");
      const instGlyph = inside(await marks(t, "settings", "install-glyph"), inst ? { x: inst.x - 40, y: inst.y - 4, w: 40, h: inst.h + 8 } : null);
      if (instGlyph) k.near("Installed: the check's middle on the text's cap middle", midY(k.ink("agents-installed-glyph", bare(box(instGlyph)), { inset: 0 })), line(s, inst, 13)?.cap);
      const menu = (await marks(t, "settings", "menu-field"))[0] ?? null;
      const mText = inside(await marks(t, "settings", "menu-field-text"), menu), chev = inside(await marks(t, "settings", "menu-field-chevron"), menu);
      const tInk = k.ink("agents-menu-text", bare(box(mText)), { inset: 0 }), cInk = k.ink("agents-menu-chevron", bare(box(chev)), { inset: 0 });
      if (menu && tInk && cInk) k.near("model menu: room left of the text and right of the chevron", tInk.x0 - menu.x, menu.x + menu.w - cInk.x1);
      k.near("model menu: the text's cap middle on the field's centre line", line(s, mText, 13)?.cap, cy(box(menu)));
      k.near("model menu: the chevron's middle on the text's cap middle", midY(cInk), line(s, mText, 13)?.cap);
      bad.push(...k.bad);
    }
  } finally {
    await t.cmd("qa.cloud", { url: "", devEmail: "" }).catch(() => {});
    await t.cmd("qa.theme", { theme: "light" }).catch(() => {});
    team.closeAllConnections();
    await new Promise<void>((r) => team.close(() => r()));
  }
  report(t, bad);
});

sc("about", "alignment: About Canvas is centred on one line, its chip and buttons centre their words, light and dark", { covers: [] }, async (t: NT) => {
  fresh("native-about");
  const bad: string[] = [];
  for (const theme of ["light", "dark"]) {
    await t.cmd("qa.theme", { theme });
    await t.cmd("qa.mainmenu", { title: "About Canvas", perform: true });
    await t.mark({ id: "about-version", window: "about" });
    const s = await grab(t, "about");
    const k = new AlignChecker("native-about", theme, s.img, s.k);
    const W = s.img.width / s.k;
    const icon = await one(t, "about", "about-icon"), title = await one(t, "about", "text", "Canvas"), alpha = await one(t, "about", "about-alpha");
    const version = await one(t, "about", "about-version"), built = await one(t, "about", "about-built");
    for (const [n, m] of [["icon", icon], ["title", title], ["version", version], ["built", built]] as const) {
      const ink = k.ink(`about-${n}`, bare(box(m)), { inset: 0 });
      k.near(`About: the ${n}'s ${n === "icon" ? "ink" : "label ink"} centred in the window`, midX(ink), W / 2);
    }
    k.label("about-alpha", box(alpha, (alpha?.h ?? 0) / 2), line(s, alpha, 11, "Alpha"), { inset: 1 });
    k.near("About: the Alpha chip centred in the window", cx(box(alpha)), W / 2);
    for (const b of await marks(t, "about", "about-button")) {
      k.label(`about-button-${b.label}`, box(b, 8), textLine(s.img, s.k, { x: b.x + 8, y: b.y + 3, w: b.w - 16, h: b.h - 6 }, b.label ?? "", 12 * SF.cap, 12 * SF.ex), { inset: 2 });
    }
    bad.push(...k.bad);
  }
  await t.cmd("qa.theme", { theme: "light" });
  report(t, bad);
});

sc("inspector", "alignment: letter spacing's glyph, number, Auto chip and token button line up with the fields around it, light and dark", { covers: ["inspector:text"] }, async (t: NT) => {
  fresh("native-tracking");
  await t.selectIds(["tx_auto"]);
  await t.cmd("qa.hoverbind", { on: true });
  const bad: string[] = [];
  try {
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      const tf = await t.mark({ id: "tracking-field" }, 8000);
      const s = await grab(t);
      const k = new AlignChecker("native-tracking", theme, s.img, s.k);
      // The line height field beside it: a NumberField with a glyph, on the same row.
      const lh = (await marks(t, "main", "number-field")).find((m) => Math.abs(m.y - tf.y) < 2 && m.x < tf.x) ?? null;
      const lhGlyph = inside(await marks(t, "main", "field-glyph"), lh), tGlyph = await one(t, "main", "tracking-glyph");
      // The glyph, in the field's rounded shape from its left edge to just past the glyph's frame.
      const gi = k.ink("tracking-glyph", tGlyph ? { x: tf.x, y: tf.y, w: tGlyph.x + tGlyph.w + 1 - tf.x, h: tf.h, r: 8 } : null, { inset: 1 });
      const li = k.ink("lineheight-glyph", lh && lhGlyph ? { x: lh.x, y: lh.y, w: lhGlyph.x + lhGlyph.w + 1 - lh.x, h: lh.h, r: 8 } : null, { inset: 1 });
      k.near("letter spacing: the glyph starts as far in as line height's", gi && gi.x0 - tf.x, li && lh && li.x0 - lh.x);
      k.near("letter spacing: the glyph's middle on the field's centre line", midY(gi), cy(box(tf)));
      // The token button: its hexagon centred in its square, the square on the field's centre line, as far in as line height's.
      const binds = await marks(t, "main", "token-bind");
      const tb = inside(binds, tf), lb = inside(binds, lh);
      // The glyph ends where line height's ends: it keeps to its handle and leaves the number its room (the
      // numbers themselves start at the same place; their ink differs by the digit, a 1 sits inside its width).
      k.near("letter spacing: the glyph ends as far in as line height's (within a point: symbols differ in width)", gi && gi.x1 - tf.x, li && lh && li.x1 - lh.x, 1);
      k.icon("tracking-token-button", box(tb, 6), { inset: 1 });
      k.icon("lineheight-token-button", box(lb, 6), { inset: 1 });
      k.near("letter spacing: the token button on the field's centre line", cy(box(tb)), cy(box(tf)));
      k.near("letter spacing: the token button as far from the field's end as line height's", tb && tf.x + tf.w - (tb.x + tb.w), lb && lh && lh.x + lh.w - (lb.x + lb.w));
      // Auto: its word centred in the chip, its right edge on the field's, its baseline on the caption's.
      const auto = await one(t, "main", "tracking-auto"), cap = (await t.marks({ label: "Letter spacing", id: "text" })).find((m) => Math.abs(m.x - tf.x) < 4) ?? null;
      // The word inside the chip's fill, away from its rounded ends.
      const word = auto ? { ...auto, x: auto.x + 6, y: auto.y + 1, w: auto.w - 12, h: auto.h - 2 } : null;
      k.label("tracking-auto", box(auto, 8), line(s, word, 11, "Auto"), { inset: 1 });
      k.near("Auto: its right edge on the field's", auto && auto.x + auto.w, tf.x + tf.w);
      k.near("Auto: the chip's baseline on the caption's", line(s, word, 11, "Auto")?.base, line(s, cap as Mark | null, 11, "Letter spacing")?.base);
      bad.push(...k.bad);
    }
  } finally {
    await t.cmd("qa.hoverbind", { on: false }).catch(() => {});
    await t.cmd("qa.theme", { theme: "light" }).catch(() => {});
  }
  report(t, bad);
});

sc("home", "alignment: Home's tab, header buttons, filter, sidebar rows and server view are optically centred, light and dark", { covers: ["home:alignment", "home:light", "home:dark"] }, async (t: NT) => {
  fresh("native-home");
  // Two open comments, so this file's card shows the bubble and its count.
  const doc = crypto.randomUUID();
  const thread = () => ({ id: crypto.randomUUID(), doc, anchor: { nodeId: "x", x: 0, y: 0, board: "b" }, createdAt: new Date().toISOString(), createdBy: { name: "Ana" }, comments: [{ id: crypto.randomUUID(), body: "c" }] });
  fs.writeFileSync(path.join(t.file, "comments.json"), JSON.stringify({ format: 1, doc, seq: 0, threads: [thread(), thread()], outbox: [] }));
  const team = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/v1/info" ? JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }) : JSON.stringify({ email: "anna@studio.test", name: "anna", role: "owner" }));
  });
  await new Promise<void>((r) => team.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(team.address() as { port: number }).port}`;
  const bad: string[] = [];
  try {
    await t.cmd("qa.cloud", { url, devEmail: "anna@studio.test" });
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      // With a file open the tab is the round house.
      if ((await t.state()).homeShown) await t.click(center(await t.mark({ id: "home-card" })));
      await t.waitState((s) => !s.homeShown, "a file tab");
      let s = await grab(t);
      let k = new AlignChecker("native-home", theme, s.img, s.k);
      const tab = await one(t, "main", "home-tab");
      k.icon("home-tab-house", box(tab, (tab?.h ?? 0) / 2), { inset: 3 });
      bad.push(...k.bad);
      await t.click(center(tab!));
      await t.waitState((s) => s.homeShown, "Home");
      await t.mark({ id: "home-row", label: "Recents" });
      await t.waitFor(async () => (await t.marks({ id: "home-server-dot" }))[0]?.label === "Connected", "the server's dot to say Connected", 20_000);
      s = await grab(t);
      k = new AlignChecker("native-home", theme, s.img, s.k);
      for (const [label, name] of [["Open", "home-open"], ["New file", "home-new"]]) await fieldButton(t, k, s, label, name);
      for (const seg of await marks(t, "main", "home-segment")) {
        const txt = inside((await t.marks({ id: "text", label: seg.label ?? "" })) as Mark[], seg);
        // "All": its A starts on its own edge with thin diagonals, so its ink box reads 0.8 pt left of where it looks; judged fine.
        k.label(`home-filter-${seg.label}`, box(seg, 6), line(s, txt, 12, seg.label ?? ""), { inset: 1, tolX: seg.label === "All" ? 0.85 : undefined });
      }
      for (const row of await marks(t, "main", "home-row")) {
        const g = inside(await marks(t, "main", "home-row-glyph"), row), txt = inside((await t.marks({ id: "text", label: row.label ?? "" })) as Mark[], row);
        const gi = k.ink(`home-row-glyph-${row.label}`, bare(box(g)), { inset: 0 });
        k.near(`sidebar row ${row.label}: the glyph's middle on the name's cap middle`, midY(gi), line(s, txt, 13, row.label ?? "")?.cap);
        k.near(`sidebar row ${row.label}: the name's cap middle on the row's centre line`, line(s, txt, 13, row.label ?? "")?.cap, cy(box(row)));
      }
      const srvRow = (await marks(t, "main", "home-row")).find((r) => r.label && /127\.0\.0\.1/.test(r.label)) ?? null;
      await dotOnText(t, k, s, "home-server-dot", inside((await t.marks({ id: "text", label: srvRow?.label ?? "" })) as Mark[], srvRow), 13, "home-server-row");
      // A card's line under its name: the place glyph on its words, the bubble on the count.
      const card = (await marks(t, "main", "home-card"))[0] ?? null;
      const below = card ? { x: card.x, y: card.y + card.h, w: card.w, h: 60 } : null;
      const whereG = inside(await marks(t, "main", "home-card-where-glyph"), below);
      const whereT = whereG ? ((await t.marks({ id: "text" })) as Mark[]).find((m) => m.x > whereG.x && m.x < whereG.x + whereG.w + 10 && Math.abs(m.y + m.h / 2 - (whereG.y + whereG.h / 2)) < 6) ?? null : null;
      k.near("card: the place glyph's middle on its words' cap middle", midY(k.ink("home-card-where-glyph", bare(box(whereG)), { inset: 0 })), line(s, whereT, 12)?.cap);
      const count = (await marks(t, "main", "home-card-count"))[0] ?? null;
      const bubble = count ? (await marks(t, "main", "home-card-comments-glyph")).find((g) => Math.abs(g.y + g.h / 2 - (count.y + count.h / 2)) < 6 && g.x < count.x) ?? null : null;
      k.near("card: the bubble's middle on the count's cap middle", midY(k.ink("home-card-bubble", bare(box(bubble)), { inset: 0 })), line(s, count, 12)?.cap);
      bad.push(...k.bad);
      // The server view: its status dot on the status line.
      await t.click(center(srvRow!));
      await t.waitState((st) => st.homeSection === "server", "the server view");
      await t.mark({ id: "home-server-card" }, 8000);
      await t.waitFor(async () => (await t.marks({ id: "text", label: "Connected as" })).length > 0, "Connected as", 15_000);
      s = await grab(t);
      k = new AlignChecker("native-home", theme, s.img, s.k);
      await dotOnText(t, k, s, "home-status-dot", (await t.marks({ id: "text", label: "Connected as" }))[0] as Mark, 13, "home-server-status");
      await fieldButton(t, k, s, "Cloud settings", "home-cloud-settings");
      bad.push(...k.bad);
      await t.click(center(await t.mark({ id: "home-row", label: "Recents" })));
      await t.waitState((st) => st.homeSection === "recents", "Recents");
    }
  } finally {
    await t.cmd("qa.cloud", { url: "", devEmail: "" }).catch(() => {});
    await t.cmd("qa.theme", { theme: "light" }).catch(() => {});
    team.closeAllConnections();
    await new Promise<void>((r) => team.close(() => r()));
  }
  report(t, bad);
});

sc("home", "alignment: Home's first-launch cards centre their glyphs and buttons, light and dark", { covers: ["home:alignment", "home:first-launch"] }, async (t: NT) => {
  fresh("native-home-first");
  const app = new QaApp(path.dirname(t.app.dir), 90 + t.app.shard);
  const was = process.env.CANVAS_QA_FIRST_RUN;
  process.env.CANVAS_QA_FIRST_RUN = "1";
  try { await app.start(t.app.app); } finally { if (was === undefined) delete process.env.CANVAS_QA_FIRST_RUN; else process.env.CANVAS_QA_FIRST_RUN = was; }
  const bad: string[] = [];
  try {
    const f = new NT(app, path.join(app.home, "Documents", "Canvas", "Welcome.canvas"));
    await f.waitState((s) => typeof s.file === "string" && s.file.endsWith("Welcome.canvas"), "the course file to open", 25_000);
    await f.settle(30_000);
    await f.click(center(await f.mark({ id: "home-tab" })));
    await f.waitState((s) => s.homeShown, "Home");
    await f.mark({ id: "home-start" }, 8000);
    for (const theme of ["light", "dark"]) {
      await f.cmd("qa.theme", { theme });
      const s = await grab(f);
      const k = new AlignChecker("native-home-first", theme, s.img, s.k);
      for (const m of await marks(f, "main", "home-start-mark")) k.icon(`home-start-mark-${m.label}`, box(m, 10), { inset: 2 });
      for (const b of await marks(f, "main", "home-start")) await fieldButton(f, k, s, b.label ?? "", `home-start-${b.label}`);
      // The empty recents: the clock and the words on the box's middle.
      const empty = await one(f, "main", "home-empty"), eg = await one(f, "main", "home-empty-glyph"), et = await one(f, "main", "text", "Files you open show up here");
      k.near("empty recents: the clock centred across the box", midX(k.ink("home-empty-glyph", bare(box(eg)), { inset: 0 })), cx(box(empty)));
      k.near("empty recents: the words' label ink centred across the box", midX(k.ink("home-empty-text", bare(box(et)), { inset: 0 })), cx(box(empty)));
      bad.push(...k.bad);
    }
  } finally {
    await app.stop();
  }
  report(t, bad);
});

/** The page's boxes and text lines (qa/ink-page.ts), in window points: the web view's frame added. */
async function pageMeasure(t: NT, s: Shot, want: Record<string, string>): Promise<Record<string, any>> {
  const st = await t.state();
  const m = await t.js<Record<string, any>>(`return ${measureJs(want)};`);
  for (const v of Object.values(m)) {
    if (!v) continue;
    const r = v.rect ?? v;
    r.x += st.webFrame.x; r.y += st.webFrame.y;
  }
  return resolve(s.img, m, s.k);
}

sc("comments", "alignment: in the app's page, the pins, the bars, the thread's head and the hint centre their letters and icons, light and dark", { covers: ["comments:alignment"] }, async (t: NT) => {
  fresh("native-page");
  const uid = () => crypto.randomUUID();
  const doc = uid(), A = uid(), B = uid();
  const c = (th: string, author: object, body: string, min: number) => ({ id: uid(), thread: th, author, body, createdAt: new Date(Date.now() - min * 60_000).toISOString() });
  const threads = [
    { id: A, doc, anchor: { nodeId: "r_free", x: 0.5, y: 0.5, board: "lay_nest" }, createdAt: new Date().toISOString(), createdBy: { name: "Anna" }, comments: [c(A, { name: "Anna" }, "Can this feel less loud?", 60), c(A, { name: "Ben" }, "Agree.", 5)] },
    { id: B, doc, anchor: { nodeId: "r_free", x: 0.9, y: 0.2, board: "lay_nest" }, createdAt: new Date().toISOString(), createdBy: { name: "Ben" }, resolvedAt: new Date().toISOString(), comments: [c(B, { name: "Ben" }, "Done", 30)] },
  ];
  fs.writeFileSync(path.join(t.file, "comments.json"), JSON.stringify({ format: 1, doc, seq: 2, threads, outbox: [] }));
  await t.js(`return window.canvasHost.comments.reload();`);
  const b = await t.js<{ x: number; y: number }>(`return window.__canvas.boardPos("lay_nest");`);
  await t.look(b.x, b.y);
  await t.waitJs(`document.querySelectorAll(".cm-pin").length >= 1 && document.querySelector(".cm-bar.on")`, "the pin and the count bar");
  const pin = `.cm-pin[data-thread="${A}"]`;
  const bad: string[] = [];
  try {
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      // The pin, the count bar.
      let s = await grab(t);
      let m = await pageMeasure(t, s, { av: `b:${pin} .cm-av`, avT: `t:${pin} .cm-av`, bar: "b:.cm-bar", barIcon: "b:.cm-bar > span:first-child svg", barT: "t:.cm-bar > span:nth-child(2)", show: "b:.cm-bar .cm-btn", showT: "t:.cm-bar .cm-btn" });
      let k = new AlignChecker("native-page", theme, s.img, s.k);
      k.label("app-pin-avatar", m.av, m.avT, { inset: 1.5 });
      k.label("app-bar-show-resolved", m.show, m.showT);
      k.near("app count bar: the bubble's middle on the bar's centre line", midY(k.ink("app-bar-icon", bare(m.barIcon), { inset: 0 })), cy(m.bar));
      k.near("app count bar: the count's cap middle on the bar's centre line", m.barT?.cap, cy(m.bar));
      bad.push(...k.bad);
      // The thread's head and reply row.
      const p = (await pageMeasure(t, s, { pin: `b:${pin}` })).pin as Box;
      await t.click({ x: p.x + p.w / 2, y: p.y + p.h / 2 });
      await t.waitJs(`!!document.querySelector(".cm-pop:not([hidden]) .cm-field")`, "the thread");
      await t.js(`document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ".cm-field{caret-color:transparent!important}" })); return true;`);
      s = await grab(t);
      m = await pageMeasure(t, s, { chip: "b:.cm-head .cm-chip", chipT: "t:.cm-head .cm-chip span", resolve: "b:.cm-head .cm-btn.txt", resolveT: "t:.cm-head .cm-btn.txt", more: "b:.cm-head .cm-btn:not(.txt)", send: "b:.cm-row .cm-send", field: "t:.cm-row .cm-field", av: "b:.cm-item .cm-av", who: "t:.cm-item .cm-who b", time: "t:.cm-item .cm-who time" });
      k = new AlignChecker("native-page", theme, s.img, s.k);
      k.label("app-thread-chip", m.chip, m.chipT);
      k.label("app-thread-resolve", m.resolve, m.resolveT);
      k.icon("app-thread-more", m.more);
      k.icon("app-reply-send", m.send);
      k.near("app reply: the field's cap middle on the send button's centre line", m.field?.cap, cy(m.send));
      k.near("app comment: the name's cap middle on the avatar's centre line", m.who?.cap, cy(m.av));
      k.near("app comment: the name and the time share a baseline", m.who?.base, m.time?.base);
      bad.push(...k.bad);
      await t.js(`window.canvasHost.comments.setMode(true); return true;`);
      // Comment mode: the hint.
      await t.waitJs(`document.querySelector(".cm-hint.on")`, "the hint");
      s = await grab(t);
      m = await pageMeasure(t, s, { hint: "b:.cm-hint", hintIcon: "b:.cm-hint > span:first-child svg", hintB: "t:.cm-hint b", key: "b:.cm-hint .cm-key", keyT: "t:.cm-hint .cm-key" });
      k = new AlignChecker("native-page", theme, s.img, s.k);
      k.near("app hint: the bubble's middle on the pill's centre line", midY(k.ink("app-hint-icon", bare(m.hintIcon), { inset: 0 })), cy(m.hint));
      k.near("app hint: Comment mode's cap middle on the pill's centre line", m.hintB?.cap, cy(m.hint));
      k.label("app-hint-esc", m.key, m.keyT, { inset: 1, mid: "ex" });
      bad.push(...k.bad);
      await t.js(`window.canvasHost.comments.setMode(false); return true;`);
      // The pin again closes the thread, so the next theme starts with the avatar on the pin.
      await t.click({ x: p.x + p.w / 2, y: p.y + p.h / 2 });
      await t.waitJs(`!window.canvasHost.comments.open`, "the thread to close");
    }
  } finally {
    await t.cmd("qa.theme", { theme: "light" }).catch(() => {});
  }
  report(t, bad);
});

sc("first-run", "alignment: in the app's page, the welcome card's Connect and Copy centre their words, light and dark", { covers: ["first-run:alignment"] }, async (t: NT) => {
  fresh("native-welcome");
  const w = (await t.a.post("/api/widgets", { kind: "welcome", name: "Welcome", x: -600, y: 0, w: 460, h: 500 })).widget;
  await t.look(-620, -20);
  await t.waitJs(`(() => { const c = document.querySelector('.wc .wc-code'); return c && c.textContent.length > 10; })()`, "the welcome card's commands");
  const bad: string[] = [];
  try {
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      const s = await grab(t);
      const m = await pageMeasure(t, s, { copy: "b:.wc .wc-copy", copyT: "t:.wc .wc-copy", connect: "b:.wc .wc-connect:not([hidden])", connectT: "t:.wc .wc-connect:not([hidden])", name: "t:.wc .wc-cmd-name", dot: "b:.wc .wc-dot", said: "t:.wc .wc-said" });
      const k = new AlignChecker("native-welcome", theme, s.img, s.k);
      k.label("app-welcome-copy", m.copy, m.copyT);
      if (m.connect) k.label("app-welcome-connect", m.connect, m.connectT);
      k.near("app welcome: the agent's name, cap middle on the buttons' centre line", m.name?.cap, cy(m.copy));
      k.near("app welcome: the dot's middle on the status's cap middle", cy(m.dot), m.said?.cap);
      bad.push(...k.bad);
    }
  } finally {
    await t.cmd("qa.theme", { theme: "light" }).catch(() => {});
  }
  report(t, bad);
});
