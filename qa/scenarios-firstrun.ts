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

sc("first-run", "the welcome card shows the canvas MCP commands, copies one, and turns Connected on", { covers: ["first-run:welcome", "first-run:copy-command", "first-run:connected"], skip: { visual: "the commands name this checkout's folder (~/Code/canvas or a worktree), which differs per clone" } }, async (t: T) => {
  const w = (await t.a.post("/api/widgets", { kind: "welcome", name: "Welcome", x: -560, y: 0, w: 460, h: 440 })).widget;
  t.subject = ["widget:" + w.id];
  await t.look(-580, -20);
  await t.waitFor("(() => { const c = document.querySelector('.wc .wc-code'); return c && c.textContent.startsWith('claude mcp add canvas --scope user -- '); })()", "the Claude Code command");
  const codex = await t.ev<string>("document.querySelectorAll('.wc .wc-code')[1].textContent");
  t.ok(/^codex mcp add canvas -- \S+ \S+\/mcp\/server\.ts$/.test(codex), `the Codex command: ${codex}`);
  t.eq(await t.ev("document.querySelector('.wc .wc-said').textContent"), "Not connected yet", "before any agent");
  t.ok(await t.ev("(() => { const c = document.querySelector('.wc').getBoundingClientRect(), h = document.querySelector('.wc .wc-hint').getBoundingClientRect(); return h.height > 0 && h.bottom <= c.bottom - 8; })()"), "the hint under Not connected yet fits on the card");
  // Copy: a real click on the button. Headless Chrome has no clipboard permission, so the page's writeText is caught.
  await t.ev("window.__copied = null; navigator.clipboard.writeText = (s) => { window.__copied = s; return Promise.resolve(); }");
  await clickOn(t, ".wc .wc-copy");
  const copied = await t.waitFor<string>("window.__copied", "the copied command");
  t.eq(copied, await t.ev("document.querySelector('.wc .wc-code').textContent"), "Copy copies the command shown");
  await t.waitFor("document.getElementById('wtoast').textContent === 'Copied'", "the Copied toast");
  const after = t.widgets().widgets.find((x: any) => x.id === w.id);
  t.eq([after.x, after.y], [w.x, w.y], "the Copy click does not drag the card");
  // An agent connects: canvas-mcp's hello, as mcp/client.ts sends it.
  await fetch(`${t.srv.base}/api/mcp/hello`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", "x-canvas-source": "mcp", "x-canvas-session": "mcp-qa-1", "x-canvas-agent": "claude-code" }, body: "{}" });
  await t.waitFor("document.querySelector('.wc').classList.contains('on')", "Connected", 6000);
  t.eq(await t.ev("document.querySelector('.wc .wc-said').textContent"), "Connected: Claude", "who is connected");
  const r = await rectOf(t, `.wd[data-id="widget:${w.id}"]`);
  await shot(t, "web-welcome-connected", { x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 });
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
