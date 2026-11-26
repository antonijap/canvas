import { randomUUID } from "node:crypto";
import { QaApp } from "./app.ts";
import { cloudVoteFiles, viewerComment, viewerTimerControls, whiteboardOp, votePost } from "../cloud-vote-fixture.ts";
import { center, sc, NT } from "./harness.ts";
import fs from "node:fs";
import path from "node:path";

sc("vote", "Vote and timer palette controls and panels fit at 720 pt", { covers: ["vote:palette", "vote:compact-panels", "timer:compact"] }, async (t: NT) => {
  const initial = await t.state();
  try {
    await t.cmd("qa.cloud", { commentName: "Anna" });
    await t.cmd("qa.window", { width: 720, height: 420 });
    await t.section("Layers");
    if (!initial.inspectorOpen) await t.cmd("qa.mainmenu", { title: "Show Properties", perform: true });
    await t.showPage("layout");
    await t.settle();
    const vote = await t.mark({ id: "vote-tool" });
    const timer = await t.mark({ id: "timer-tool" });
    for (const button of [vote, timer]) {
      t.near(button.w, 28, 0.5, button.label + " is 28 pt wide");
      t.near(button.h, 28, 0.5, button.label + " is 28 pt high");
    }
    const palette = await t.mark({ id: "tool-palette" });
    const { webFrame } = await t.state();
    const { l, t: top, r, b } = await t.js<{ l: number; t: number; r: number; b: number }>("return window.canvasHost.insets");
    t.ok(l >= 224 && r >= 284, "both sidebars are open");
    t.ok(palette.x >= webFrame.x + l && palette.x + palette.w <= webFrame.x + webFrame.w - r, "the palette fits between both sidebars");
    const panel = async (selector: string) => {
      await t.waitJs(`document.querySelector(${JSON.stringify(selector + ":not([hidden])")})`, selector);
      const rect = await t.js<{ left: number; right: number; top: number; bottom: number }>(
        `return document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON();`);
      t.ok(rect.left >= l && rect.right <= webFrame.w - r && rect.top >= top && rect.bottom <= webFrame.h - b,
        selector + " fits in the free canvas");
    };
    const click = async (selector: string) => {
      await t.waitJs(`document.querySelector(${JSON.stringify(selector)})?.offsetWidth`, selector);
      const { x, y } = await t.js<{ x: number; y: number }>(`
        const el = document.querySelector(${JSON.stringify(selector)});
        el.scrollIntoView({ block: "nearest" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      `);
      await t.click({ x: webFrame.x + x, y: webFrame.y + y });
    };
    const selected = (on: boolean) => t.waitFor(async () =>
      (await t.marks({ id: "vote-tool-selected" })).length === (on ? 1 : 0), on ? "Vote highlighted" : "Vote highlight cleared");
    await t.click(center(timer));
    await panel("[data-timer-sheet]");
    await click('[data-standalone-duration="300000"]');
    await panel("[data-timer-bar]");
    await t.shot(path.resolve("qa/out/native/timer-bar-720.png"));
    await click("[data-timer-stop]");
    await t.waitJs('document.querySelector("[data-timer-bar]").hidden', "timer stopped");
    await t.click(center(vote));
    await panel("[data-vote-sheet]");
    await selected(true);
    await t.key("Escape");
    await t.waitJs('document.querySelector("[data-vote-sheet]").hidden', "sheet dismissed");
    await selected(false);
    await t.js('window.canvasHost.selectId("lay_nest");');
    await t.key("d", ["shift"]);
    await panel("[data-vote-sheet]");
    await selected(true);
    for (let i = 0; i < 7; i++) await click('[aria-label="More votes"]');
    await t.shot(path.resolve("qa/out/native/timer-vote-sheet-720.png"));
    await click('[data-timer-duration="300000"]');
    await click("[data-vote-start]");
    await t.waitJs('document.querySelector("[data-vote-end]")?.offsetWidth', "vote started");
    await panel(".vote-bar");
    await t.waitJs('document.querySelector(".vote-bar [data-timer-countdown]")', "timed vote");
    await t.shot(path.resolve("qa/out/native/timer-vote-bar-720.png"));
    await click("[data-timer-pause]");
    await t.waitJs('document.querySelector("[data-timer-resume]")', "vote timer paused");
    const paused = await t.js<string>('return document.querySelector("[data-timer-countdown]").textContent');
    await click("[data-timer-extend]");
    await t.waitJs(`document.querySelector("[data-timer-countdown]").textContent !== ${JSON.stringify(paused)}`, "vote timer extended");
    await click("[data-timer-resume]");
    await t.waitJs('document.querySelector("[data-timer-pause]")', "vote timer resumed");
    await selected(true);
    await t.showPage("style");
    await selected(false);
    await t.showPage("layout");
    await selected(true);
    await click("[data-vote-end]");
    await panel("[data-vote-results]");
    await selected(false);
    await click("[data-vote-done]");
    await panel(".vote-bar");
    await t.click(center(vote));
    await panel("[data-vote-results]");
    await selected(false);
    await t.shot(path.resolve("qa/out/native/vote-palette-720.png"));
  } finally {
    const state = await t.state();
    if (state.inspectorOpen !== initial.inspectorOpen) {
      await t.cmd("qa.mainmenu", { title: initial.inspectorOpen ? "Show Properties" : "Hide Properties", perform: true });
    }
    await t.cmd("qa.window", { width: initial.window.width, height: initial.window.height });
  }
});

sc("vote", "Vote on a sticky and reveal the conclusion in the Mac app", { covers: ["vote:start", "vote:ballot", "vote:privacy", "vote:results", "sticky:handles"] }, async (t: NT) => {
  await t.cmd("qa.cloud", { commentName: "Anna" });
  await t.showPage("layout");
  await t.look(0, 0);
  const p = center(await t.rect("r_free"));
  await t.key("s");
  await t.click({ x: p.x - 120, y: p.y });
  await t.waitJs("window.canvasHost.textEdit.active", "sticky editor");
  const [note] = await t.pageSel();
  await t.key("a");
  await t.key("Escape");
  await t.waitDisk(() => t.node(note)?.content === "a", "the sticky is saved");
  const handles = `(() => {
    const below = document.querySelector(".sticky-next-below:not([hidden])");
    const right = document.querySelector(".sticky-next-right:not([hidden])");
    const badge = document.querySelector("#seldim");
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return below && right && badge && { below: box(below), badge: box(badge), right: box(right) };
  })()`;
  await t.waitJs(handles, "sticky quick-add handles");
  await t.look(0, 0, 0.25);
  await t.waitJs(`(${handles}) && window.canvasHost.cam.z === 0.25`, "small sticky with quick-add handles");
  const spark = await t.mark({ id: "canvas-spark-spark" });
  const { below, badge, right } = await t.js(`return ${handles};`);
  const { webFrame } = await t.state();
  const overlaps = (a: typeof right, b: typeof right) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  t.ok(!overlaps(below, badge), "the add-below handle clears the size badge");
  t.ok(!overlaps({ ...right, x: right.x + webFrame.x, y: right.y + webFrame.y }, spark), "the add-right handle clears Ask about this");
  await t.look(0, 0);
  await t.key("d", ["shift"]);
  const click = async (selector: string) => {
    const rect = `document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect()`;
    await t.waitJs(`${rect}?.width`, selector);
    const at = await t.js(`const r = ${rect}; return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
    const { webFrame } = await t.state();
    await t.click({ x: at.x + webFrame.x, y: at.y + webFrame.y });
  };
  await click("[data-vote-anonymous]");
  await click("[data-vote-start]");
  await t.waitJs('document.querySelector("[data-vote-end]")?.offsetWidth', "vote started");
  await t.click(center(await t.rect(note)));
  await t.waitJs('document.querySelector("[data-vote-mark]")', "my dot appears during the vote");
  await click("[data-vote-end]");
  await t.waitJs('document.querySelector("[data-vote-results]:not([hidden])")?.textContent.includes("Anonymous")', "anonymous result");
  const vote = JSON.parse(fs.readFileSync(path.join(t.file, "comments.json"), "utf8")).votes[0];
  t.eq([vote.host.name, vote.ballots[0].voter.name, vote.ballots[0].layer], [undefined, undefined, note], "anonymous vote stores no name");
});

async function expectTool(t: import("./harness.ts").NT, label?: string) {
  await t.waitFor(async () => {
    const marks = await t.marks({ id: "draw-tool-selected" });
    const placing = await t.js('return document.querySelector(".whiteboard-layer").hasAttribute("data-placing");');
    return placing === !!label && (label ? marks.length === 1 && marks[0].label === label : marks.length === 0);
  }, label ? label + " armed and highlighted" : "placement clears the tool and its highlight");
}

sc("sticky", "Sticky tool edits inline in the Mac app", { covers: ["sticky:create", "sticky:edit", "sticky:author"] }, async (t) => {
  await t.cmd("qa.cloud", { commentName: "Anna" });
  await t.showPage("layout");
  await t.look(0, 0);
  const p = center(await t.rect("r_free"));
  await t.key("s");
  await expectTool(t, "Sticky");
  await t.click(p);
  await expectTool(t);
  await t.waitJs("window.canvasHost.textEdit.active", "sticky editor in the app");
  const [id] = await t.pageSel();
  await t.key("a");
  await t.key("Escape");
  await t.waitDisk(() => t.node(id)?.content === "a", "the sticky edit on disk");
  t.eq([t.node(id)?.type, t.node(id)?.author?.name], ["sticky", "Anna"], "note carries the name from Settings");
});

sc("sticker", "Sticker tool places an anchored seal in the Mac app", { covers: ["sticker:place", "sticker:anchor", "sticker:author"] }, async (t) => {
  await t.cmd("qa.cloud", { commentName: "Anna" });
  await t.showPage("layout");
  await t.look(0, 0);
  const p = center(await t.rect("r_free"));
  await t.key("s", ["shift"]);
  await expectTool(t, "Sticker");
  await t.waitJs('document.querySelector("[data-sticker-tray]")?.offsetWidth', "sticker tray in the app");
  await t.key("l");
  await t.click(p);
  await expectTool(t);
  await t.waitJs('window.canvasHost.sel !== null && !!document.querySelector("[data-sticker-seal]")', "seal in the app");
  const [id] = await t.pageSel();
  await t.waitDisk(() => t.node(id)?.type === "sticker", "the sticker on disk");
  t.eq([t.node(id)?.kind, t.node(id)?.on?.layer, t.node(id)?.by?.name], ["love", "r_free", "Anna"], "saved sticker, anchor and author");

  await t.key(",", ["cmd"]);
  await t.waitState((s) => s.windows.some((w: any) => w.settings), "the Settings window");
  const toggle = await t.mark({ id: "whiteboard-show-name", window: "settings" }, 4000);
  await t.click(center(toggle), { window: "settings" });
  await t.waitJs('window.canvasHost.prefs().whiteboardName === ""', "the name setting off on the canvas");
  await t.click({ x: 14, y: 14 }, { window: "settings" });
  await t.waitState((s) => !s.windows.some((w: any) => w.settings), "Settings closed");
  await t.key("s", ["shift"]);
  await t.click(p);
  await t.waitJs(`window.canvasHost.sel !== ${JSON.stringify(id)} && !!window.canvasHost.sel`, "second sticker selected");
  const [anonymous] = await t.pageSel();
  await t.waitDisk(() => t.node(anonymous)?.type === "sticker", "anonymous sticker saved");
  t.eq(t.node(anonymous)?.by, undefined, "no name written on new stickers when the switch is off");
  await t.key("s");
  await t.click({ x: p.x - 140, y: p.y });
  await t.waitJs("window.canvasHost.textEdit.active", "the anonymous sticky editor");
  const [note] = await t.pageSel();
  await t.key("Escape");
  await t.waitDisk(() => t.node(note)?.type === "sticky", "anonymous sticky saved");
  t.eq([t.node(note)?.author, t.node(note)?.showAuthor], [undefined, false], "the sticky stores no name");
  await t.key(",", ["cmd"]);
  await t.click(center(await t.mark({ id: "whiteboard-show-name", window: "settings" }, 4000)), { window: "settings" });
  await t.waitJs('window.canvasHost.prefs().whiteboardName === "Anna"', "the name setting restored");
  await t.click({ x: 14, y: 14 }, { window: "settings" });
});

sc("whiteboard-review", "Sticky author removal clears disk and undo restores it", { covers: ["sticky:author-removal"] }, async (t: NT) => {
  await t.cmd("qa.cloud", { commentName: "Anna" });
  await t.showPage("layout");
  await t.look(0, 0);
  const p = center(await t.rect("r_free"));
  await t.key("s");
  await t.click(p);
  await t.waitJs("window.canvasHost.textEdit.active", "sticky text editor");
  const [id] = await t.pageSel();
  await t.key("Escape");
  await t.waitDisk(() => t.node(id)?.author?.name === "Anna", "sticky author before removal");
  const author = 'document.querySelector(".sticky-author")';
  await t.waitJs(author + '?.getAttribute("aria-pressed") === "true"', "author toggle");
  const rect = await t.js(`const r = ${author}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  const { webFrame } = await t.state();
  await t.click({ x: rect.x + webFrame.x, y: rect.y + webFrame.y });
  await t.waitDisk(() => !t.node(id)?.author, "author removed from disk");
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => t.node(id)?.author?.name === "Anna", "undo restores the author");
});

sc("vote", "Cloud vote reveals a viewer's ballot only after the owner ends it, and both see the timer", {
  covers: ["vote:cloud", "vote:cloud-privacy", "vote:cloud-viewer", "vote:cloud-private-presence", "timer:cloud", "timer:expiry", "timer:clock-change"],
}, async (t: NT) => {
  const peer = new QaApp(path.dirname(t.app.dir), 100 + t.app.shard);
  fs.mkdirSync(peer.dir, { recursive: true });
  fs.symlinkSync(path.join(t.app.dir, "tunnels"), path.join(peer.dir, "tunnels"));
  let files: Awaited<ReturnType<typeof cloudVoteFiles>> | undefined;
  try {
    await t.cmd("qa.cloud", { commentName: "Anna" });
    await peer.start(t.app.app);
    const ben = new NT(peer, t.file);
    await ben.cmd("qa.cloud", { commentName: "Ben" });
    files = await cloudVoteFiles(t.app.base, peer.base);
    await t.app.openShown(files.owner);
    await peer.openShown(files.viewer);
    const target = 'window.canvasHost.worldRectOf("BallotTarget")';
    await t.waitJs(target, "owner sees the board");
    await ben.waitJs(target, "viewer sees the board");
    await t.js('window.canvasHost.votes.activate()');
    await t.waitJs('document.querySelector("[data-vote-sheet]:not([hidden])")', "start sheet");
    await t.js('document.querySelector("[data-vote-start]").click()');
    await ben.waitJs('document.querySelector(".vote-bar:not([hidden])")', "viewer sees the vote");
    await ben.look(0, 0);
    await ben.js('window.canvasHost.presence.update({cursor:{x:310,y:220},sel:["BallotTarget"]})');
    await ben.waitJs('window.canvasHost.votes.privatePresence === true', "private voting disables presence");
    t.eq(await t.js('return document.querySelectorAll(".cp-cursor,.cp-selection").length'), 0, "the owner sees no ballot pointers");
    await ben.click(center(await ben.rect("BallotTarget")));
    await ben.waitJs('document.querySelector("[data-vote-mark]")', "viewer sees their own vote");
    t.eq(await t.js('return document.querySelectorAll("[data-vote-mark]").length'), 0, "owner sees no hidden votes");
    await viewerComment(peer.base, files.viewer);
    await t.js('document.querySelector("[data-vote-end]").click()');
    await ben.waitJs('document.querySelector("[data-vote-count]")?.textContent.trim() === "1"', "viewer sees the revealed count");
    await ben.shot(path.resolve("qa/out/native/vote-cloud-revealed.png"));
    await ben.waitJs('[...window.canvasHost.boards.keys()].filter(id => id.startsWith("vote-conclusion-")).length === 1', "one conclusion on the viewer canvas");
    const voteID = await t.js<string>('return [...window.canvasHost.boards.keys()].find(id => id.startsWith("vote-conclusion-")).slice("vote-conclusion-".length)');
    t.eq((await whiteboardOp(t.app.base, files.owner, { kind: "vote.clear", vote: voteID })).status, 200, "clear the first vote");
    await ben.waitJs('document.querySelector(".vote-bar").hidden', "viewer sees the first vote clear");
    await t.cmd("qa.mainmenu", { title: "Start a Timer", perform: true });
    await t.waitJs('document.querySelector("[data-timer-sheet]:not([hidden])")', "View menu opens the timer sheet");
    await t.key("Escape");
    await t.key("t", ["shift"]);
    await t.waitJs('document.querySelector("[data-timer-sheet]:not([hidden])")', "Shift+T opens the timer sheet");
    await t.js('document.querySelector(\'[data-standalone-duration="300000"]\').click()');
    await ben.waitJs('document.querySelector("[data-timer-bar] [data-timer-countdown]")?.textContent', "viewer sees the standalone countdown");
    t.eq(await ben.js(`return document.querySelectorAll(${JSON.stringify(viewerTimerControls)}).length`), 0, "viewer cannot control the timer");
    const beforeJump = await ben.js<string>('return document.querySelector("[data-timer-countdown]").textContent');
    await ben.js('window.qaRealNow = Date.now; Date.now = () => window.qaRealNow() + 3600000');
    try {
      await ben.waitJs(`document.querySelector("[data-timer-countdown]").textContent !== ${JSON.stringify(beforeJump)}`, "countdown ticks after the clock jump");
      t.ok(await ben.js('return /[1-9]/.test(document.querySelector("[data-timer-countdown]").textContent)'), "the viewer still has time left");
    } finally {
      await ben.js('Date.now = window.qaRealNow; delete window.qaRealNow');
    }
    await t.waitJs('document.querySelector("[data-timer-pause]")', "owner can pause");
    await t.js('document.querySelector("[data-timer-pause]").click()');
    const paused = 'document.querySelector("[data-timer-bar]").textContent.includes("Paused")';
    await ben.waitJs(paused, "viewer sees the timer pause");
    await t.waitJs(paused, "owner sees the timer pause");
    const countdown = 'return document.querySelector("[data-timer-bar] [data-timer-countdown]").textContent';
    t.eq(await ben.js(countdown), await t.js(countdown), "both see the same countdown");
    await t.js('document.querySelector("[data-timer-stop]").click()');
    await ben.waitJs('document.querySelector("[data-timer-bar]").hidden', "viewer sees the timer stop");
    const vote = randomUUID(), page = await t.js<string>("return window.canvasHost.page");
    t.eq((await whiteboardOp(t.app.base, files.owner, { kind: "vote.start", vote, scope: { page }, on: "anything",
      perPerson: 1, hidden: true, anonymous: false, timerMs: 7000 })).status, 200, "start a timed vote");
    await ben.waitJs('document.querySelector(".timer-urgent")', "viewer sees the last ten seconds styling");
    await ben.click(center(await ben.rect("BallotTarget")));
    await ben.waitJs('document.querySelector("[data-vote-mark]")', "viewer casts a vote");
    await ben.waitJs(`document.querySelector(".vote-bar").textContent.includes("Time's up")`, "the idle host ends the vote");
    await ben.waitJs('document.querySelector("[data-vote-count]")?.textContent.trim() === "1"', "expiry reveals the result");
    await ben.waitJs('[...window.canvasHost.boards.keys()].filter(id => id.startsWith("vote-conclusion-")).length === 2', "one more conclusion card");
    await ben.settle();
    await ben.shot(path.resolve("qa/out/native/timer-cloud-revealed.png"));
  } finally {
    await peer.stop().catch(() => {});
    if (files) {
      await t.cmd("close", { file: files.owner }).catch(() => {});
      await votePost(t.app.base, "/api/cloud/host/stop", { hostId: files.hostId }).catch(() => {});
      await votePost(t.app.base, "/api/cloud/host/wipe", { hostId: files.hostId }).catch(() => {});
    }
  }
});
