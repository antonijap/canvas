// First run (src/onboarding.ts) and toasts you can act on, in the browser page: the hint that points at the app, the
// welcome card's commands and Connected dot, and Undo on a board delete's toast.
import fs from "node:fs";
import { sc, type Rect, type T } from "./harness.ts";

const rectOf = (t: T, sel: string) => t.ev<Rect>(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
const clickOn = async (t: T, sel: string) => { const b = await rectOf(t, sel); await t.io.click(b.x + b.w / 2, b.y + b.h / 2); };
const shot = async (t: T, name: string, r: Rect) => {
  const png = await t.shot({ x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.w, height: r.h });
  fs.mkdirSync(`${process.cwd()}/qa/out/firstrun`, { recursive: true });
  fs.writeFileSync(`${process.cwd()}/qa/out/firstrun/${name}.png`, png);
};

sc("first-run", "the browser page points at the Mac app; Hide keeps it away", { covers: ["first-run:web-hint"] }, async (t: T) => {
  // Headless Chrome is automation: no hint unless ?hint=1 asks for it.
  t.eq(await t.ev("document.getElementById('webhint').hidden"), true, "no hint for automation");
  await t.page.goto(`${t.srv.base}/?file=${encodeURIComponent(t.file)}&hint=1`);
  await t.waitFor("window.canvasHost && window.canvasHost.doc && window.__canvas && window.__canvas.renderer !== 'pending'", "the page to load", 30000);
  await t.settle(30000);
  const r = await t.waitFor<Rect>("(() => { const e = document.getElementById('webhint'); if (e.hidden) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()", "the hint");
  t.ok(/The Mac app is the main way to use Canvas\. Run pnpm app/.test(await t.ev<string>("document.getElementById('webhint').innerText")), "the hint names pnpm app");
  t.eq(await t.ev("document.querySelector('#webhint .wh-engine').hidden"), true, "no engine line with the engine built");
  await shot(t, "web-hint", { x: 0, y: r.y - 260, w: 900, h: 260 + r.h + 20 });
  await clickOn(t, "#webhint button");
  await t.waitFor("document.getElementById('webhint').hidden", "Hide to hide it");
  t.eq(await t.ev("localStorage.getItem('canvas:webhint')"), "hidden", "Hide is remembered");
});

sc("first-run", "the welcome card has a row per agent, its menu copies the canvas MCP command, and the row turns Connected", { covers: ["first-run:welcome", "first-run:copy-command", "first-run:connected"], skip: { visual: "the commands name this checkout's folder (~/Code/canvas or a worktree), which differs per clone" } }, async (t: T) => {
  const w = (await t.a.post("/api/widgets", { kind: "welcome", name: "Welcome", x: -560, y: 0, w: 400, h: 180 })).widget;
  t.subject = ["widget:" + w.id];
  await t.look(-580, -20);
  const row = (key: string) => `.wc .wc-row[data-agent="${key}"]`;
  // The first setup answer: each row's button is live (Connect, or Copy command where the agent's CLI is not found).
  await t.waitFor(`(() => { const b = document.querySelector('${row("claude")} .wc-btn'); return b && !b.disabled && /^(Connect|Copy command)$/.test(b.textContent); })()`, "the Claude Code row");
  t.eq(await t.ev("document.querySelector('.wc .wc-title').textContent"), "Connect an agent", "the card's title");
  t.eq(await t.ev("[...document.querySelectorAll('.wc .wc-name')].map((e) => e.textContent)"), ["Claude Code", "Codex"], "a row per agent");
  t.eq(await t.ev("document.querySelector('.wc .wc-hint').textContent"), "Then select a layer and ask for a change. ⌘Z undoes its work.", "the footer line");
  t.eq(await t.ev(`document.querySelector('${row("claude")} .wc-on').hidden`), true, "not Connected before any agent");
  t.ok(await t.ev("(() => { const c = document.querySelector('.wc').getBoundingClientRect(), h = document.querySelector('.wc .wc-hint').getBoundingClientRect(); return h.height > 0 && h.bottom <= c.bottom; })()"), "the footer fits on the card");
  // Copy command, from each row's menu: real clicks. Headless Chrome has no clipboard permission, so writeText is caught.
  await t.ev("window.__copied = null; navigator.clipboard.writeText = (s) => { window.__copied = s; return Promise.resolve(); }");
  await clickOn(t, `${row("claude")} .wc-more`);
  await t.waitFor("!!document.querySelector('.wc .wc-menu button')", "the row's menu");
  t.eq(await t.ev("document.querySelector('.wc .wc-menu button').textContent"), "Copy command", "the menu offers Copy command");
  await clickOn(t, ".wc .wc-menu button");
  const claude = await t.waitFor<string>("window.__copied", "the copied command");
  t.ok(claude.startsWith("claude mcp add canvas --scope user -- "), `the Claude Code command: ${claude}`);
  t.eq(await t.ev("!!document.querySelector('.wc .wc-menu')"), false, "the menu closes after Copy command");
  await t.waitFor("document.getElementById('wtoast').textContent === 'Copied'", "the Copied toast");
  await t.ev("window.__copied = null");
  await clickOn(t, `${row("codex")} .wc-more`);
  await t.waitFor("!!document.querySelector('.wc .wc-menu button')", "the Codex row's menu");
  await clickOn(t, ".wc .wc-menu button");
  const codex = await t.waitFor<string>("window.__copied", "the copied Codex command");
  t.ok(/^codex mcp add canvas -- \S+ \S+\/mcp\/server\.ts$/.test(codex), `the Codex command: ${codex}`);
  const after = t.widgets().widgets.find((x: any) => x.id === w.id);
  t.eq([after.x, after.y], [w.x, w.y], "the menu clicks do not drag the card");
  // An agent connects: canvas-mcp's hello, as mcp/client.ts sends it. Its row shows the green dot and Connected.
  await fetch(`${t.srv.base}/api/mcp/hello`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", "x-canvas-source": "mcp", "x-canvas-session": "mcp-qa-1", "x-canvas-agent": "claude-code" }, body: "{}" });
  await t.waitFor(`document.querySelector('${row("claude")} .wc-on').hidden === false`, "Connected", 6000);
  t.eq(await t.ev(`document.querySelector('${row("claude")} .wc-on').textContent`), "Connected", "the Claude Code row says Connected");
  t.eq(await t.ev(`document.querySelector('${row("claude")} .wc-btn').hidden`), true, "and has no button");
  const r = await rectOf(t, `.wd[data-id="widget:${w.id}"]`);
  await shot(t, "web-welcome-connected", { x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 });
});

sc("first-run", "Connect on the welcome card registers an agent, says the next step, and shows an error with Copy command still in the menu", { covers: ["first-run:connect"], skip: { visual: "the commands name this checkout's folder (~/Code/canvas or a worktree), which differs per clone", reopen: "Connected comes from the live page's stubbed connect answer; the reopened tab reads the scratch agent config, where nothing is registered" } }, async (t: T) => {
  const w = (await t.a.post("/api/widgets", { kind: "welcome", name: "Welcome", x: -600, y: 0, w: 400, h: 180 })).widget;
  t.subject = ["widget:" + w.id];
  // The endpoint changes the person's agent config: the page's fetch is stubbed here (test/mcp-connect.test.ts runs
  // the real route against fake CLIs). Setup answers say both agents are installed and neither is registered yet.
  await t.ev(`(() => {
    const real = window.fetch.bind(window);
    window.__connects = []; window.__reg = {};
    window.fetch = async (u, o) => {
      const url = String(u);
      if (url.includes("/api/mcp/connect")) {
        const b = JSON.parse(o.body);
        window.__connects.push({ agent: b.agent, method: o.method, header: o.headers["x-canvas"] });
        await new Promise((r) => setTimeout(r, 400));
        if (b.agent === "codex") return new Response(JSON.stringify({ ok: false, agent: "codex", code: "failed", error: "Error: could not write config.toml" }), { status: 502 });
        window.__reg[b.agent] = true;
        return new Response(JSON.stringify({ ok: true, agent: b.agent, registered: true, message: "Added. Start a new Claude Code session." }));
      }
      const r = await real(u, o);
      if (!url.includes("/api/mcp/setup")) return r;
      const j = await r.json();
      return new Response(JSON.stringify({ ...j, connected: false, temporary: false, installed: { claude: true, codex: true }, registered: { claude: false, codex: false, ...window.__reg } }));
    };
  })()`);
  await t.look(-620, -20);
  const btn = (key: string) => `.wc .wc-row[data-agent="${key}"] .wc-btn`;
  const on = (key: string) => `.wc .wc-row[data-agent="${key}"] .wc-on`;
  await t.waitFor(`(() => { const b = document.querySelectorAll('.wc .wc-btn'); return b.length === 2 && [...b].every((x) => !x.hidden && !x.disabled && x.textContent === 'Connect'); })()`, "Connect in both rows");
  t.eq(await t.ev("document.querySelector('.wc .wc-hint').textContent"), "Then select a layer and ask for a change. ⌘Z undoes its work.", "the footer says what comes next");
  let r = await rectOf(t, `.wd[data-id="widget:${w.id}"]`);
  await shot(t, "web-welcome-connect", { x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 });
  await clickOn(t, btn("claude"));
  await t.waitFor(`document.querySelector('${btn("claude")}').textContent === 'Connecting…'`, "Connecting…");
  await t.waitFor(`document.querySelector('${on("claude")}').hidden === false`, "Connected");
  t.eq(await t.ev(`document.querySelector('${btn("claude")}').hidden`), true, "Connect gives way to Connected");
  t.eq(await t.ev("document.querySelector('.wc .wc-hint').textContent"), "Added. Start a new Claude Code session.", "the next step");
  t.eq(await t.ev("window.__connects"), [{ agent: "claude", method: "POST", header: "1" }], "one POST with the x-canvas header");
  // Still Connected after the next poll: the setup answer says registered.
  await new Promise((res) => setTimeout(res, 2500));
  t.eq(await t.ev(`document.querySelector('${on("claude")}').hidden`), false, "the setup poll keeps Connected");
  r = await rectOf(t, `.wd[data-id="widget:${w.id}"]`);
  await shot(t, "web-welcome-added", { x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 });
  // An error: the CLI's words in the footer, Connect again, and the menu still copies the command.
  await clickOn(t, btn("codex"));
  await t.waitFor("document.querySelector('.wc .wc-hint').classList.contains('err')", "the error");
  t.eq(await t.ev("document.querySelector('.wc .wc-hint').textContent"), "Codex: Error: could not write config.toml", "the error names the agent");
  t.eq(await t.ev(`document.querySelector('${btn("codex")}').textContent`), "Connect", "Connect can be tried again");
  t.ok(await t.ev("(() => { const c = document.querySelector('.wc').getBoundingClientRect(), h = document.querySelector('.wc .wc-hint').getBoundingClientRect(); return h.bottom <= c.bottom; })()"), "the error fits on the card");
  r = await rectOf(t, `.wd[data-id="widget:${w.id}"]`);
  await shot(t, "web-welcome-connect-error", { x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 });
  await clickOn(t, `.wc .wc-row[data-agent="codex"] .wc-more`);
  await t.waitFor("!!document.querySelector('.wc .wc-menu button')", "the Codex row's menu");
  t.eq(await t.ev("document.querySelector('.wc .wc-menu button').disabled"), false, "Copy command is still there");
  await clickOn(t, ".wc .wc-title");
  await t.waitFor("!document.querySelector('.wc .wc-menu')", "a press elsewhere closes the menu");
  const after = t.widgets().widgets.find((x: any) => x.id === w.id);
  t.eq([after.x, after.y], [w.x, w.y], "the Connect clicks do not drag the card");
});

sc("toasts", "deleting a board shows Undo, and Undo brings it back", { covers: ["toast-actions:undo-board", "toast-actions:mouse"] }, async (t: T) => {
  await t.focus("lay_clip");
  await t.select(["lay_clip"]);
  await t.io.key("Backspace");
  await t.waitFor("(() => { const m = document.getElementById('msg'); return m.style.display === 'block' && m.textContent.startsWith('Deleted Clip'); })()", "the Deleted Clip toast");
  await t.flush();
  t.eq(t.node("lay_clip"), null, "the board is deleted on disk");
  const m = await rectOf(t, "#msg");
  await shot(t, "web-undo-toast", { x: m.x - 40, y: m.y - 30, w: m.w + 80, h: m.h + 50 });
  await clickOn(t, "#msg button");
  await t.waitHistory();
  await t.waitFor("!!window.canvasHost.boards.get('lay_clip') && !window.canvasHost.boards.get('lay_clip').gone", "the board back on the page");
  t.ok(t.node("lay_clip"), "Undo brought the board back on disk");
  // Undo on a toast after another edit does not undo that edit: it says so.
  await t.select(["lay_clip"]);
  await t.io.key("Backspace");
  // The first toast's button stays in the hidden #msg: wait for the new toast to show (the delete answered, its page
  // list written), not for any button.
  await t.waitFor("(() => { const m = document.getElementById('msg'); return m.style.display === 'block' && m.textContent.startsWith('Deleted Clip') && !!m.querySelector('button'); })()", "the second toast");
  await t.a.post("/api/update", { file: t.file, id: "lay_nest", props: { name: "Renamed meanwhile" } });
  await t.waitFor("window.canvasHost.history().undo !== 'Delete'", "the rename on top of the history");
  await clickOn(t, "#msg button");
  await t.waitFor("document.getElementById('msg').textContent.startsWith('Other edits came after it')", "the refusal");
  await t.flush();
  t.eq(t.node("lay_nest")?.name, "Renamed meanwhile", "the later edit stays");
  t.eq(t.node("lay_clip"), null, "the board stays deleted");
  t.ok(!JSON.parse(fs.readFileSync(`${t.file}/widgets.json`, "utf8")).pages.some((p: any) => p.boards.includes("lay_clip")), "the deleted board left its page's list");
  // Edit > Undo twice steps back through the rename and the delete (its page listing with it).
  await t.undo();
  await t.undo();
  t.ok(t.node("lay_clip"), "Cmd+Z brings the board back");
});
