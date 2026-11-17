// Optical alignment of the shell's newer UI, measured from the window's own 2x capture (qa/ink.ts): Settings (General's
// Updates and comment name, Cloud with and without a server, Agents' Connect, status and agent menus), About Canvas, the letter spacing field with
// its Auto chip and token button, and Home (the pinned tab, header, sidebar rows, card lines, server, first launch).
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

sc("settings", "alignment: General, Cloud (with and without a server) and Agents controls are optically centred, light and dark", { covers: ["settings:alignment", "settings:light", "settings:dark"] }, async (t: NT) => {
  fresh("native-settings");
  const team = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/v1/info" ? JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }) : JSON.stringify({ email: "anna@studio.test", name: "anna", role: "owner" }));
  });
  await new Promise<void>((r) => team.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(team.address() as { port: number }).port}`;
  const bad: string[] = [];
  try {
    // Cloud with no server: the address field and Sign in share one line.
    await t.cmd("qa.cloud", { url: "", devEmail: "", name: "" });
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      await openSettings(t, "Cloud");
      await t.mark({ id: "cloud-sign-in", window: "settings" }, 4000);
      const s = await grab(t, "settings");
      const k = new AlignChecker("native-settings", theme, s.img, s.k);
      await fieldButton(t, k, s, "Sign in", "cloud-setup-sign-in");
      const field = await one(t, "settings", "cloud-url"), signIn = await one(t, "settings", "field-button", "Sign in");
      k.near("cloud setup: the placeholder's cap middle on the field's centre line", line(s, field, 13, "https://your-team.workers.dev")?.cap, cy(box(field)));
      k.near("cloud setup: Sign in on the field's centre line", cy(box(signIn)), cy(box(field)));
      bad.push(...k.bad);
    }
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
      // Agents: each row's Connect and status dot (Copy and the model menus moved into the row's … menu), and that menu.
      await t.cmd("qa.agents", { added: ["claude"] });
      await openSettings(t, "Agents");
      for (const h of ["claude", "codex"]) await t.mark({ id: `agent-menu-${h}`, window: "settings" }, 4000);
      await t.waitFor(async () => (await marks(t, "settings", "connect-claude"))[0]?.label === "Connected", "Claude Code to show Connected", 6000);
      await sleep(600);
      s = await grab(t, "settings");
      k = new AlignChecker("native-settings", theme, s.img, s.k);
      if (await one(t, "settings", "field-button", "Connect")) await fieldButton(t, k, s, "Connect", "agents-connect");
      // The dot sits beside Connected: Claude Code is shown added (qa.agents above), so it is always measured.
      const connected = (await marks(t, "settings", "status-text")).find((m) => m.label === "Connected") ?? null;
      if (!connected) k.bad.push(`agents (${theme}): no row shows Connected`);
      await dotOnText(t, k, s, "status-dot", connected, 13, "agents-status");
      for (const [h, title] of [["claude", "Claude Code"], ["codex", "Codex"]] as const) {
        const menu = await one(t, "settings", `agent-menu-${h}`);
        const dots = k.ink(`agents-menu-${h}`, bare(box(menu)), { inset: 0 });
        k.near(`${h} menu: the ellipsis centred across its button`, midX(dots), cx(box(menu)));
        k.near(`${h} menu: the ellipsis's middle on the button's centre line`, midY(dots), cy(box(menu)));
        const name = (await marks(t, "settings", "text", title)).find((m) => menu && Math.abs(m.y + m.h / 2 - (menu.y + menu.h / 2)) < 14) ?? null;
        k.near(`${h} row: the name's cap middle on the menu's centre line`, line(s, name, 13, title)?.cap, cy(box(menu)));
        const state = (await marks(t, "settings", `connect-${h}`))[0] ?? null;
        if (state) k.near(`${h} row: its Connect or status on the menu's centre line`, cy(box(state)), cy(box(menu)));
      }
      bad.push(...k.bad);
    }
  } finally {
    await t.cmd("qa.agents", { added: [] }).catch(() => {});
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
    // The Alpha chip and the build line are gone: "alpha" ends the version line, the build sits in its tooltip.
    const icon = await one(t, "about", "about-icon"), title = await one(t, "about", "text", "Canvas");
    const version = await one(t, "about", "about-version");
    for (const [n, m] of [["icon", icon], ["title", title], ["version", version]] as const) {
      const ink = k.ink(`about-${n}`, bare(box(m)), { inset: 0 });
      k.near(`About: the ${n}'s ${n === "icon" ? "ink" : "label ink"} centred in the window`, midX(ink), W / 2);
    }
    const buttons = await marks(t, "about", "about-button");
    if (buttons.length !== 2) k.bad.push(`About (${theme}): ${buttons.length} buttons, not Website and Report a Bug`);
    for (const b of buttons) {
      k.label(`about-button-${b.label}`, box(b, 8), textLine(s.img, s.k, { x: b.x + 8, y: b.y + 3, w: b.w - 16, h: b.h - 6 }, b.label ?? "", 12 * SF.cap, 12 * SF.ex), { inset: 2 });
    }
    // Side by side: one centre line, the pair centred in the window.
    if (buttons.length === 2) {
      const [l, r] = [...buttons].sort((a, b) => a.x - b.x);
      k.near("About: Website and Report a Bug on one centre line", cy(box(l)), cy(box(r)));
      k.near("About: the two buttons centred in the window", (l.x + r.x + r.w) / 2, W / 2);
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

sc("home", "alignment: Home's tab, header buttons, sidebar rows, card lines and server view are optically centred, light and dark", { covers: ["home:alignment", "home:light", "home:dark"] }, async (t: NT) => {
  fresh("native-home");
  const team = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/v1/info" ? JSON.stringify({ protocol: 1, server: "0.1.0", capabilities: ["comments"] }) : JSON.stringify({ email: "anna@studio.test", name: "anna", role: "owner" }));
  });
  await new Promise<void>((r) => team.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(team.address() as { port: number }).port}`;
  // Two open comments, so this file's card shows the bubble and its count, shared to the server, so it shows the cloud.
  const doc = crypto.randomUUID();
  const thread = () => ({ id: crypto.randomUUID(), doc, anchor: { nodeId: "x", x: 0, y: 0, board: "b" }, createdAt: new Date().toISOString(), createdBy: { name: "Ana" }, comments: [{ id: crypto.randomUUID(), body: "c" }] });
  fs.writeFileSync(path.join(t.file, "comments.json"), JSON.stringify({ format: 1, doc, seq: 0, server: { url }, threads: [thread(), thread()], outbox: [] }));
  const bad: string[] = [];
  try {
    // Cloud with no server: the address field and Sign in share one line.
    await t.cmd("qa.cloud", { url: "", devEmail: "", name: "" });
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      await openSettings(t, "Cloud");
      await t.mark({ id: "cloud-sign-in", window: "settings" }, 4000);
      const s = await grab(t, "settings");
      const k = new AlignChecker("native-settings", theme, s.img, s.k);
      await fieldButton(t, k, s, "Sign in", "cloud-setup-sign-in");
      const field = await one(t, "settings", "cloud-url"), signIn = await one(t, "settings", "field-button", "Sign in");
      k.near("cloud setup: the placeholder's cap middle on the field's centre line", line(s, field, 13, "https://your-team.workers.dev")?.cap, cy(box(field)));
      k.near("cloud setup: Sign in on the field's centre line", cy(box(signIn)), cy(box(field)));
      bad.push(...k.bad);
    }
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
      // The header level with the sidebar's search field: the buttons' middle on the field's.
      const search = await one(t, "main", "home-search"), newBtn = await one(t, "main", "home-new");
      k.near("header: New file's middle on the search field's middle", cy(box(newBtn)), cy(box(search)));
      for (const row of await marks(t, "main", "home-row")) {
        const g = inside(await marks(t, "main", "home-row-glyph"), row), txt = inside((await t.marks({ id: "text", label: row.label ?? "" })) as Mark[], row);
        const gi = k.ink(`home-row-glyph-${row.label}`, bare(box(g)), { inset: 0 });
        k.near(`sidebar row ${row.label}: the glyph's middle on the name's cap middle`, midY(gi), line(s, txt, 13, row.label ?? "")?.cap);
        k.near(`sidebar row ${row.label}: the name's cap middle on the row's centre line`, line(s, txt, 13, row.label ?? "")?.cap, cy(box(row)));
      }
      const srvRow = (await marks(t, "main", "home-row")).find((r) => r.label && /127\.0\.0\.1/.test(r.label)) ?? null;
      await dotOnText(t, k, s, "home-server-dot", inside((await t.marks({ id: "text", label: srvRow?.label ?? "" })) as Mark[], srvRow), 13, "home-server-row");
      // A card's line under its name: the cloud of a shared file on its time, the bubble on the count.
      const card = (await marks(t, "main", "home-card", path.basename(t.file).replace(/\.canvas$/, "")))[0] ?? null;
      const below = card ? { x: card.x, y: card.y + card.h, w: card.w, h: 60 } : null;
      const whereG = inside(await marks(t, "main", "home-card-where-glyph"), below);
      const whereT = whereG ? ((await t.marks({ id: "text" })) as Mark[]).find((m) => m.x > whereG.x && m.x < whereG.x + whereG.w + 10 && Math.abs(m.y + m.h / 2 - (whereG.y + whereG.h / 2)) < 6) ?? null : null;
      k.near("card: the cloud's middle on its time's cap middle", midY(k.ink("home-card-where-glyph", bare(box(whereG)), { inset: 0 })), line(s, whereT, 12)?.cap);
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
    await t.cmd("qa.agents", { added: [] }).catch(() => {});
    await t.cmd("qa.cloud", { url: "", devEmail: "" }).catch(() => {});
    await t.cmd("qa.theme", { theme: "light" }).catch(() => {});
    team.closeAllConnections();
    await new Promise<void>((r) => team.close(() => r()));
  }
  report(t, bad);
});

sc("home", "alignment: Home's first launch, its header level with Recents' row and its one line centred, light and dark", { covers: ["home:alignment", "home:first-launch"] }, async (t: NT) => {
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
    t.eq((await f.state()).recents, [], "the course the app opened is not a recent");
    await f.mark({ id: "home-empty" }, 8000);
    for (const theme of ["light", "dark"]) {
      await f.cmd("qa.theme", { theme });
      const s = await grab(f);
      const k = new AlignChecker("native-home-first", theme, s.img, s.k);
      for (const [label, name] of [["Open", "home-open"], ["New file", "home-new"]]) await fieldButton(f, k, s, label, name);
      // The header on the sidebar's first row (Recents: no search before the first file): the title's capitals
      // and the buttons on the row's centre line, where the row's own name sits.
      const row = (await marks(f, "main", "home-row"))[0] ?? null;
      if (row?.label !== "Recents") k.bad.push(`home-first-row (${theme}): the sidebar's first row is ${row?.label ?? "missing"}, not Recents`);
      const named = (await f.marks({ id: "text", label: "Recents" })) as Mark[];
      const rowText = inside(named, row), title = named.find((m) => row && m.x > row.x + row.w) ?? null;
      const newBtn = await one(f, "main", "home-new");
      k.near("first launch: the title's cap middle on Recents' row centre line", line(s, title, 22, "Recents")?.cap, cy(box(row)));
      k.near("first launch: the title's cap middle on the row name's cap middle", line(s, title, 22, "Recents")?.cap, line(s, rowText, 13, "Recents")?.cap);
      k.near("first launch: New file's middle on Recents' row centre line", cy(box(newBtn)), cy(box(row)));
      // The one line: its ink centred across the main view and down the space under the header.
      const empty = await one(f, "main", "home-empty"), et = await one(f, "main", "text", "Files you open show up here");
      k.near("empty recents: the words' label ink centred across the space under the header", midX(k.ink("home-empty-text", bare(box(et)), { inset: 0 })), cx(box(empty)));
      k.near("empty recents: the words' cap middle centred down the space under the header", line(s, et, 13, "Files you open show up here")?.cap, cy(box(empty)));
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
      // The thread: the first comment (its Resolve check) and the reply row.
      const p = (await pageMeasure(t, s, { pin: `b:${pin}` })).pin as Box;
      await t.click({ x: p.x + p.w / 2, y: p.y + p.h / 2 });
      await t.waitJs(`!!document.querySelector(".cm-pop:not([hidden]) .cm-field")`, "the thread");
      await t.js(`document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ".cm-field{caret-color:transparent!important}" })); return true;`);
      s = await grab(t);
      m = await pageMeasure(t, s, { resolve: "b:.cm-item .cm-res", send: "b:.cm-row .cm-send", field: "t:.cm-row .cm-field", av: "b:.cm-item .cm-av", who: "t:.cm-item .cm-who b", time: "t:.cm-item .cm-who time" });
      k = new AlignChecker("native-page", theme, s.img, s.k);
      k.icon("app-thread-resolve", m.resolve);
      k.near("app thread: Resolve's centre line on the first name's cap middle", cy(m.resolve), m.who?.cap);
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

sc("comments", "in the app, a pin dragged with the real mouse lands on the layer under its tip, and comment mode's cursor is the 2x add pin", { covers: ["comments:move", "comments:add-pin"] }, async (t: NT) => {
  const doc = crypto.randomUUID(), A = crypto.randomUUID();
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(t.file, "comments.json"), JSON.stringify({ format: 1, doc, seq: 0, outbox: [], threads: [
    { id: A, doc, anchor: { nodeId: "r_free", x: 0.5, y: 0.5, board: "lay_nest" }, createdAt: at, createdBy: { name: "Anna" }, comments: [{ id: crypto.randomUUID(), thread: A, author: { name: "Anna" }, body: "Move me", createdAt: at }] },
  ] }));
  await t.js(`return window.canvasHost.comments.reload();`);
  const b = await t.js<{ x: number; y: number }>(`return window.__canvas.boardPos("lay_nest");`);
  await t.look(b.x, b.y);
  await t.waitJs(`!!document.querySelector('.cm-pin[data-thread="${A}"]')`, "the pin");
  const st = await t.state();
  const pin = await t.js<{ x: number; y: number; w: number; h: number }>(`const r = document.querySelector('.cm-pin[data-thread="${A}"]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };`);
  const p = { x: pin.x + st.webFrame.x, y: pin.y + st.webFrame.y, w: pin.w, h: pin.h };
  const target = await t.rect("fr_outer");
  const grab = { x: p.x + p.w / 2, y: p.y + p.h / 2 };
  const drop = { x: target.x + target.w * 0.5, y: target.y + target.h * 0.5 };
  await t.drag(grab, { x: drop.x + (grab.x - p.x), y: drop.y + (grab.y - (p.y + p.h)) });
  const a = await t.waitDisk(() => { try { const f = JSON.parse(fs.readFileSync(path.join(t.file, "comments.json"), "utf8")); return f.threads[0].anchor.nodeId === "fr_outer" ? f.threads[0].anchor : null; } catch { return null; } }, "the anchor on the layer it was dropped on");
  t.near(a.x, 0.5, 0.03, "the drop point as a fraction of the layer, x");
  t.near(a.y, 0.5, 0.03, "the drop point as a fraction of the layer, y");
  // The app's WebKit takes the 2x cursor (an image set); a browser that does not keeps the 1x one.
  await t.js(`window.canvasHost.comments.setMode(true); return true;`);
  const cursor = await t.js<string>(`return getComputedStyle(document.getElementById("view")).cursor;`);
  t.ok(/image-set/.test(cursor), `comment mode's cursor is the image set with the 2x add pin (${cursor.slice(0, 40)})`);
  await t.js(`window.canvasHost.comments.setMode(false); return true;`);
});

sc("first-run", "alignment: in the app's page, the welcome card's row button centres its words on the agent's name, light and dark", { covers: ["first-run:alignment"] }, async (t: NT) => {
  fresh("native-welcome");
  const w = (await t.a.post("/api/widgets", { kind: "welcome", name: "Welcome", x: -600, y: 0, w: 400, h: 180 })).widget;
  await t.look(-620, -20);
  // Connect, or Copy command where this Mac has no Claude Code: either is the row's button.
  await t.waitJs(`(() => { const b = document.querySelector('.wc .wc-row[data-agent=claude] .wc-btn'); return b && !b.disabled; })()`, "the welcome card's rows");
  const bad: string[] = [];
  try {
    for (const theme of ["light", "dark"]) {
      await t.cmd("qa.theme", { theme });
      const s = await grab(t);
      const m = await pageMeasure(t, s, { btn: "b:.wc .wc-row[data-agent=claude] .wc-btn:not([hidden])", btnT: "t:.wc .wc-row[data-agent=claude] .wc-btn:not([hidden])", name: "t:.wc .wc-row[data-agent=claude] .wc-name", more: "b:.wc .wc-row[data-agent=claude] .wc-more" });
      const k = new AlignChecker("native-welcome", theme, s.img, s.k);
      if (m.btn) k.label("app-welcome-button", m.btn, m.btnT);
      k.near("app welcome: the agent's name, cap middle on the menu button's centre line", m.name?.cap, cy(m.more));
      if (m.btn) k.near("app welcome: the row button on the menu button's centre line", cy(m.btn), cy(m.more));
      bad.push(...k.bad);
    }
  } finally {
    await t.cmd("qa.theme", { theme: "light" }).catch(() => {});
  }
  report(t, bad);
});
