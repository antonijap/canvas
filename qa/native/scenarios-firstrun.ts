// Native scenarios for the first run and toasts you can act on: the app's toast copies a path or an error on click,
// Undo after a board or page delete, Ask agent on an error, and a first launch in a fresh QA instance (fresh HOME and
// preferences) that opens the Welcome file, shows Connected when an agent says hello, and Settings > Agents.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sleep } from "../lib.ts";
import { QaApp } from "./app.ts";
import { center, Fail, NT, sc } from "./harness.ts";

const OUT = `${process.cwd()}/qa/out/firstrun`;
const shot = async (t: NT, name: string, window: "main" | "settings" = "main") => { fs.mkdirSync(OUT, { recursive: true }); await t.shot(`${OUT}/${name}.png`, window); };
/** The centre of the toast's text ("text") or a button ("Undo", "Ask agent"), where the app drew it (QA state toastFrames). */
const toastAt = async (t: NT, key: string) => center((await t.waitState((s) => s.toastFrames?.[key]?.w > 0, `the toast's ${key}`)).toastFrames[key]);
type Region = { x: number; y: number; w: number; h: number };
/**
 * Waits for `text` on screen. Text recognition fails now and then under load (an e5rt error from the Neural Engine,
 * when other QA runs share the Mac): it asks again, and a timeout says the last error.
 */
async function seeText(t: NT, text: string, region?: Region, ms = 20_000, window: "main" | "settings" = "main") {
  const t0 = Date.now();
  let last = "";
  for (;;) {
    try {
      const m = await t.findText(text, region, window);
      if (m.length) return center(m[0]);
      last = "not on screen";
    } catch (e) { last = (e as Error).message.slice(0, 200); }
    if (Date.now() - t0 > ms) throw new Fail(`"${text}" did not appear on screen (${last})`);
    await sleep(500);
  }
}

sc("toasts", "a toast with a path copies the path on click and says Copied", { covers: ["toast-actions:copy-path", "toast-actions:copy-error", "toast-actions:mouse"] }, async (t: NT) => {
  await t.cmd("qa.pasteboard", { set: "" });
  const file = "~/Designs/Gone Home.canvas";
  await t.cmd("toast", { message: `Canvas could not open “${file}”: it was moved`, durationMs: 60_000 });
  const st = await t.waitState((s) => s.toastCopy === file, "the toast to copy its path");
  t.ok(String(st.toast).includes(file), "the toast shows the path");
  const at = await toastAt(t, "text");
  await t.move(at);
  await sleep(400); // the copy glyph fades in while the pointer is on it
  await shot(t, "toast-copy");
  await t.click(at);
  await t.waitState((s) => s.toast === "Copied" && s.toastKind === "success", "the Copied toast");
  t.eq((await t.cmd("qa.pasteboard")).text, file, "the pasteboard holds the path, not the sentence");
  // An error without a path copies its text; news copies nothing.
  await t.cmd("toast", { message: "Could not save the change", durationMs: 6000 });
  await t.waitState((s) => s.toastCopy === "Could not save the change", "an error to copy its text");
  await t.cmd("toast", { message: "Exported 3 files", level: "success", durationMs: 3000 });
  await t.waitState((s) => s.toast === "Exported 3 files" && s.toastCopy === null && s.toastActions.length === 0, "news to be plain");
});

sc("toasts", "Ask agent on an error toast opens the composer with the error quoted", { covers: ["toast-actions:ask-agent"] }, async (t: NT) => {
  if (!(await t.waitState((s) => s.agentReady !== undefined, "the state")).agentReady) t.skip("neither Claude Code nor Codex is installed on this Mac");
  await t.showPage("layout");
  await t.selectIds(["lay_nest"]);
  await t.cmd("toast", { message: "Could not save the change: the disk is full", durationMs: 60_000 });
  await t.waitState((s) => s.toastActions.includes("Ask agent"), "Ask agent on the error toast");
  await shot(t, "toast-ask-agent");
  await t.click(await toastAt(t, "Ask agent"));
  await t.waitState((s) => !s.toast, "the toast to go");
  await t.waitJs("window.canvasHost.spark && window.canvasHost.spark.state.open", "the composer to open");
  const value = await t.js<string>("return document.querySelector('textarea').value;");
  t.ok(value.includes("“Could not save the change: the disk is full”"), `the composer quotes the error: ${value}`);
  t.eq(await t.js("return window.canvasHost.spark.state.ids;"), ["lay_nest"], "on the selection");
  t.eq(await t.js("return window.canvasHost.spark.state.runs.length;"), 0, "nothing is sent until the person sends it");
  await sleep(300);
  await shot(t, "ask-agent-composer");
  await t.key("Escape");
});

sc("toasts", "deleting a board shows Undo in the app's toast, and Undo brings it back", { covers: ["toast-actions:undo-board", "toast-actions:mouse"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.selectIds(["lay_clip"]);
  await t.key("Delete");
  await t.waitState((s) => s.toast === "Deleted Clip" && s.toastActions.includes("Undo"), "the Deleted Clip toast with Undo");
  await t.waitDisk(() => !t.node("lay_clip"), "the board deleted");
  await shot(t, "toast-undo");
  await t.click(await toastAt(t, "Undo"));
  await t.waitDisk(() => t.node("lay_clip"), "the board back");
  t.ok(!(await t.state()).toast, "the toast goes with the click");
});

sc("toasts", "deleting a page shows Undo, and Undo brings the page back", { covers: ["toast-actions:undo-page"] }, async (t: NT) => {
  await t.section("Layers");
  const made = await t.a.post("/api/pages", { name: "Scratch page" });
  const id = made.pages[made.pages.length - 1].id;
  const row = await t.pageRow(id).catch(async () => { await sleep(500); return t.pageRow(id); });
  await t.click(center(row.r), { right: true });
  await t.pickMenu("Delete");
  await t.waitState((s) => s.toast === "Deleted page Scratch page" && s.toastActions.includes("Undo"), "the Deleted page toast with Undo");
  await t.waitDisk(() => !t.widgets().pages.some((p: any) => p.id === id), "the page deleted");
  await t.click(await toastAt(t, "Undo"));
  await t.waitDisk(() => t.widgets().pages.some((p: any) => p.id === id), "the page back");
});

sc("first-run", "a first launch opens the Welcome file; Connected follows an agent; Settings > Agents shows the commands; Connect registers canvas", { covers: ["first-run:welcome", "first-run:connected", "first-run:settings-agents", "first-run:connect", "first-run:settings-connect"] }, async (t: NT) => {
  // A second QA instance, started like a fresh install: its own HOME (where ~/Documents/Canvas goes), empty
  // preferences, and CANVAS_QA_FIRST_RUN so it does what a first launch does.
  const fresh = new QaApp(path.dirname(t.app.dir), 90 + t.app.shard);
  const was = process.env.CANVAS_QA_FIRST_RUN;
  process.env.CANVAS_QA_FIRST_RUN = "1";
  try {
    await fresh.start(t.app.app);
  } finally {
    if (was === undefined) delete process.env.CANVAS_QA_FIRST_RUN; else process.env.CANVAS_QA_FIRST_RUN = was;
  }
  try {
    const welcome = path.join(fresh.home, "Documents", "Canvas", "Welcome.canvas");
    const f = new NT(fresh, welcome);
    await f.waitState((s) => typeof s.file === "string" && s.file.endsWith("/Documents/Canvas/Welcome.canvas"), "the Welcome file to open", 20_000);
    t.ok(fs.existsSync(path.join(welcome, "document.json")), "Welcome.canvas is in the fresh HOME's Documents/Canvas");
    t.ok(f.widgets().widgets.some((w: any) => w.kind === "welcome"), "the welcome card is on it");
    await f.settle(30_000);
    await sleep(1500);
    await shot(f, "welcome-first");
    // The card is drawn by the page: read it there, and check it is inside the window, not off to the side.
    await f.waitJs("(() => { const b = document.querySelectorAll('.wc .wc-btn'); return b.length === 2 && [...b].every((x) => !x.disabled); })()", "the agent rows on the card", 10_000);
    t.eq(await f.js("return document.querySelector('.wc .wc-title').textContent;"), "Connect an agent", "the card's title");
    t.eq(await f.js("return [...document.querySelectorAll('.wc .wc-name')].map((e) => e.textContent);"), ["Claude Code", "Codex"], "a row per agent");
    t.eq(await f.js("return document.querySelector('.wc .wc-row[data-agent=claude] .wc-on').hidden;"), true, "not Connected before any agent");
    // The commands are no longer on the card: each row's menu copies them (Copy command).
    const setup = (await (await fetch(`${fresh.base}/api/mcp/setup`)).json()) as any;
    t.ok(String(setup.claude).startsWith("claude mcp add canvas") && String(setup.codex).startsWith("codex mcp add canvas"), "the commands the rows' Copy command copies");
    await f.js("document.querySelector('.wc .wc-row[data-agent=codex] .wc-more').click();");
    t.eq(await f.js("return document.querySelector('.wc .wc-menu button')?.textContent ?? null;"), "Copy command", "the row's menu offers Copy command");
    await f.js("document.querySelector('.wc .wc-row[data-agent=codex] .wc-more').click();");
    const box = await f.js<{ l: number; t: number; r: number; b: number }>("const r = document.querySelector('.wc').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom };");
    const win = (await f.state()).window;
    t.ok(box.l >= 0 && box.t >= 0 && box.r <= win.width && box.b <= win.height, `the welcome card is in view: ${JSON.stringify(box)}`);
    await shot(f, "welcome");
    // An agent connects (canvas-mcp's hello, as mcp/client.ts sends it): the dot turns on within a poll.
    await fetch(`${fresh.base}/api/mcp/hello`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", "x-canvas-source": "mcp", "x-canvas-session": "mcp-qa-first", "x-canvas-agent": "claude-code" }, body: "{}" });
    await f.waitJs("document.querySelector('.wc .wc-row[data-agent=claude] .wc-on').hidden === false", "Connected on the card", 8000);
    await shot(f, "welcome-connected");
    // Connect, for real: this instance's server runs with the fresh HOME, so the agents' own CLIs write their config
    // there (~/.codex/config.toml, ~/.claude.json under it), never the person's.
    const installed = ((await (await fetch(`${fresh.base}/api/mcp/setup`)).json()) as any).installed ?? {};
    const serverTs = path.join(path.resolve(import.meta.dirname, "../.."), "mcp", "server.ts");
    if (installed.codex) {
      await f.waitJs("(() => { const b = document.querySelector('.wc .wc-row[data-agent=codex] .wc-btn'); return b && !b.hidden && b.textContent === 'Connect'; })()", "Connect for Codex on the card", 8000);
      await f.js("document.querySelector('.wc .wc-row[data-agent=codex] .wc-btn').click();");
      await f.waitJs("document.querySelector('.wc .wc-row[data-agent=codex] .wc-on').hidden === false", "Connected for Codex on the card", 30_000);
      t.eq(await f.js("return document.querySelector('.wc .wc-hint').textContent;"), "Added. Start a new Codex session.", "the card says the next step");
      const toml = fs.readFileSync(path.join(fresh.home, ".codex", "config.toml"), "utf8");
      t.ok(/^\[mcp_servers\.canvas\]$/m.test(toml) && toml.includes(JSON.stringify(serverTs)), `canvas in the fresh HOME's Codex config: ${toml}`);
      await shot(f, "welcome-connect-codex");
    } else t.notes.push("Codex is not installed on this Mac: the card's Connect was not clicked");
    // Settings > Agents: the same commands, and the same status.
    await f.key(",", ["cmd"]);
    await f.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
    let tab: any;
    for (let i = 0; i < 30 && !tab; i++) {
      const bs = (await f.views("settings")).filter((v) => v.class === "NSToolbarButton").sort((x, y) => x.x - y.x);
      tab = bs.find((v) => v.label === "Agents") ?? (bs.length === 7 ? bs[2] : undefined);
      if (!tab) await sleep(100);
    }
    if (!tab) throw new Fail("no Agents tab in the Settings toolbar");
    // The agent is still there (its heartbeat), so Settings shows it connected too.
    await fetch(`${fresh.base}/api/mcp/hello`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", "x-canvas-source": "mcp", "x-canvas-session": "mcp-qa-first", "x-canvas-agent": "claude-code" }, body: "{}" });
    await f.click(center(tab), { window: "settings" });
    await sleep(2500); // the pane asks /api/mcp/setup on appear
    await shot(f, "settings-agents", "settings");
    if (installed.claude) {
      const m = await f.mark({ id: "connect-claude", window: "settings" }, 8000);
      t.eq(m.label, "Connect", "Connect beside the Claude Code command");
      fs.mkdirSync(`${process.cwd()}/qa/out/native`, { recursive: true });
      await f.shot(`${process.cwd()}/qa/out/native/settings-agents-connect.png`, "settings");
      await f.click(center(m), { window: "settings" });
      for (let i = 0; i < 120 && (await f.marks({ id: "connect-claude", window: "settings" }))[0]?.label !== "Connected"; i++) await sleep(250);
      t.eq((await f.marks({ id: "connect-claude", window: "settings" }))[0]?.label, "Connected", "Connected after the click");
      t.eq((await f.marks({ id: "connect-hint", window: "settings" }))[0]?.label ?? null, "Added. Start a new Claude Code session.", "Settings says the next step");
      const cj = JSON.parse(fs.readFileSync(path.join(fresh.home, ".claude.json"), "utf8"));
      t.ok(cj.mcpServers?.canvas?.args?.includes(serverTs), `canvas in the fresh HOME's ~/.claude.json: ${JSON.stringify(cj.mcpServers)}`);
      // The card in the main window follows: its setup poll reads the same config.
      await f.waitJs("document.querySelector('.wc .wc-row[data-agent=claude] .wc-on').hidden === false", "Connected for Claude Code on the card too", 8000);
      await sleep(400);
      await f.shot(`${process.cwd()}/qa/out/native/settings-agents-added.png`, "settings");
    } else t.notes.push("Claude Code is not installed on this Mac: Settings' Connect was not clicked");
    // No text recognition in this second instance: loading the model in a second process under load broke it for the
    // main instance (e5rt errors in every later scenario). The Agents tab is the one shown; the screenshot shows its card.
    t.eq(execFileSync("defaults", ["read", fresh.bundleId, "canvas.settings.tab"], { encoding: "utf8" }).trim(), "agents", "the Agents tab shows");
    const sw = (await f.state()).windows.find((w: any) => w.settings);
    // The pane is one card: a row per agent, each with its menu.
    t.ok(sw, "the Settings window is open");
    for (const h of ["claude", "codex"]) t.eq((await f.marks({ id: `agent-menu-${h}`, window: "settings" })).length, 1, `Settings > Agents shows the ${h} row`);
    // The next launch is not a first one: welcomed is stored for this bundle id.
    t.eq(execFileSync("defaults", ["read", fresh.bundleId, "canvas.welcomed"], { encoding: "utf8" }).trim(), "1", "canvas.welcomed stored");
  } finally {
    await fresh.stop();
  }
});
