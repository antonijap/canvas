import { sc, type T } from "./harness.ts";
import { whiteboardOp } from "./cloud-vote-fixture.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

sc("sticky", "Sticky controls and vote panels fit a narrow canvas", {
  covers: ["sticky:compact-controls", "vote:compact-panels"],
  skip: { visual: "Checks the actual bounds of the controls and panels against the canvas insets." },
}, async (t: T) => {
  const { view, cam, insets } = await t.ev<{
    view: { x: number; y: number; height: number }; cam: object; insets: object;
  }>(`(() => {
    const h = window.canvasHost;
    const before = { view: h.view.getBoundingClientRect().toJSON(), cam: h.cam, insets: h.insets };
    window.canvasCmd({ cmd: "prefs", prefs: { whiteboardName: "Anna" } });
    window.canvasCmd({ cmd: "insets", l: 234, t: 60, r: h.view.clientWidth - 416, b: 122, bottomClearance: 122 });
    return before;
  })()`);
  const inspect = async (selector: string) => {
    const rect = await t.waitFor<{ left: number; right: number; top: number; bottom: number }>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el?.offsetWidth ? el.getBoundingClientRect().toJSON() : null;
    })()`, selector);
    t.ok(rect.left >= view.x + 234 && rect.right <= view.x + 416
      && rect.top >= view.y + 60 && rect.bottom <= view.y + view.height - 122,
      `${selector} fits in the free canvas (${JSON.stringify(rect)})`);
  };
  await t.io.key("s");
  await inspect('[aria-label="Sticky colours"]');
  await t.io.move(view.x + 237, view.y + view.height - 130);
  await inspect(".whiteboard-hint");
  await t.io.click(view.x + 237, view.y + view.height - 130);
  await t.waitFor('window.canvasHost.textEdit.active', "sticky editor");
  await t.io.key("Escape");
  await inspect(".sticky-controls");
  await t.clearSel();
  await t.io.key("d", { shift: true });
  await inspect("[data-vote-sheet]");
  await t.ev(`document.querySelector("[data-vote-start]").click()`);
  await t.waitFor('document.querySelector("[data-vote-end]")?.offsetWidth', "vote started");
  const { votes: [vote] } = await t.a.get("/api/votes");
  t.eq([vote.scope, vote.on], [{ page: await t.ev("window.canvasHost.page") }, "stickies"], "the page vote targets its stickies");
  await inspect(".vote-bar");
  await t.ev(`document.querySelector("[data-vote-end]").click()`);
  await inspect("[data-vote-results]");
  await t.ev(`document.querySelector("[data-vote-clear]").click()`);
  await t.waitFor('document.querySelector(".vote-bar").hidden', "vote cleared");
  await t.ev(`window.canvasCmd({ cmd: "insets", ...${JSON.stringify(insets)} }); window.canvasHost.setCam(${JSON.stringify(cam)});`);
});

sc("vote", "Vote on objects, reveal results and undo the conclusion", { covers: ["vote:start", "vote:scope", "vote:ballot", "vote:persistence", "vote:results", "vote:undo", "vote:clear"], skip: { visual: "Checks the vote UI at each stage and captures the start, active and results states." } }, async (t: T) => {
  await t.focus("lay_nest");
  await t.ev('window.canvasCmd({ cmd: "prefs", prefs: { whiteboardName: "Anna" } })');
  await t.select(["lay_nest"]);
  const original = t.disk();
  await t.io.key("d", { shift: true });
  const click = async (selector: string) => {
    const at = await t.waitFor<{ x: number; y: number }>(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    })()`, selector);
    await t.io.click(at.x, at.y);
  };
  t.eq(await t.ev('document.querySelector(".vote-sheet output").textContent'), "3 votes each", "default vote allowance");
  fs.writeFileSync("qa/out/vote-start.png", await t.shot());
  await click("[data-vote-start]");
  await t.waitFor('document.querySelector("[data-vote-end]")?.offsetWidth', "vote started");
  const outside = await t.center("lay_auto");
  await t.io.click(outside.x, outside.y);
  await t.flush();
  t.eq(await t.ev('document.querySelectorAll("[data-vote-mark]").length'), 0, "clicks outside the selected frame do not vote");
  const target = await t.center("r_free");
  await t.io.click(target.x, target.y);
  await t.waitFor('document.querySelectorAll("[data-vote-mark]").length === 1', "my vote dot");
  fs.writeFileSync("qa/out/vote-active.png", await t.shot());
  await t.open();
  await t.ev('window.canvasCmd({ cmd: "prefs", prefs: { whiteboardName: "Anna" } })');
  await t.waitFor('document.querySelectorAll("[data-vote-mark]").length === 1', "my vote dot after reload");
  await click("[data-vote-mark]");
  await t.waitFor('!document.querySelector("[data-vote-mark]")', "my dot removed");
  await t.io.click(target.x, target.y);
  await t.waitFor('document.querySelectorAll("[data-vote-mark]").length === 1', "my dot added again");
  t.eq(t.disk(), original, "casting and removing dots leave the design unchanged");
  await click("[data-vote-end]");
  await t.waitFor('document.querySelector("[data-vote-count]")?.textContent === "1"', "result badge");
  await t.waitFor('document.querySelector("[data-vote-results]:not([hidden])")?.textContent.includes("Results")', "results panel");
  await t.waitFor('document.querySelector(".vote-avatar")?.title === "Anna"', "the name from Settings");
  fs.writeFileSync("qa/out/vote-reveal.png", await t.shot());
  await t.flush();
  const read = () => JSON.parse(fs.readFileSync(path.join(t.file, "comments.json"), "utf8"));
  t.eq([read().seq, read().votes[0].scope.frame, read().votes[0].on, read().votes[0].state, read().votes[0].ballots[0].layer],
    [0, "lay_nest", "anything", "ended", "r_free"], "the selected frame with no stickies is open to any object");
  const cards = () => t.disk().children.filter((n) => n.name === "Vote conclusion");
  t.eq(cards().length, 1, "one conclusion on the canvas");
  t.ok(cards()[0].children?.some((node: any) => node.type === "text" && node.content === "1. Free rect"), "the conclusion has the ranked object");
  await t.ev('Object.defineProperty(navigator.clipboard, "writeText", { value: async (text) => { window.__copiedVote = text; } })');
  await click("[data-vote-copy]");
  await t.waitFor('window.__copiedVote === "1. Free rect (1 vote)"', "copied ranked list");
  await click("[data-vote-done]");
  await t.undo();
  t.eq(cards().length, 0, "one undo removes the conclusion");
  t.eq(read().votes[0].state, "ended", "undo leaves ballots intact");
  await t.redo();
  t.eq(cards().length, 1, "redo restores exactly one conclusion");
  await click("[data-vote-clear]");
  await t.waitFor('!document.querySelector("[data-vote-count]")', "clear removes badges");
  t.eq(read().votes[0].state, "dismissed", "the cleared vote stays dismissed");
});

sc("sticky", "Sticky click, live edit, Tab and undo", { covers: ["sticky:create", "sticky:edit", "sticky:next", "sticky:undo"], skip: { visual: "Checks the drawn text and note bounds with the engine." } }, async (t: T) => {
  await t.focus("lay_nest");
  await t.ev('window.canvasCmd({ cmd: "prefs", prefs: { whiteboardName: "Anna" } })');
  const p = await t.center("r_free");
  await t.io.key("s");
  await t.io.move(p.x, p.y);
  await t.waitFor('document.querySelector("[data-sticky-ghost]")?.offsetWidth', "sticky preview");
  await t.io.click(p.x, p.y);
  await t.waitFor("window.canvasHost.textEdit.active", "sticky text editor");
  const [id] = await t.sel();
  await t.io.type("Plan the next sprint");
  await t.io.key("Tab");
  await t.waitFor(`window.canvasHost.sel !== ${JSON.stringify(id)} && window.canvasHost.textEdit.active`, "next sticky editor");
  const [next] = await t.sel();
  await t.waitFor(`window.canvasHost.engineView.textLines(${JSON.stringify(id)})?.lines.length > 0`, "sticky text drawn by the engine");
  await t.io.key("Escape");
  await t.flush();
  const note = t.node(id)!;
  t.eq([note.type, note.content, note.width === note.height], ["sticky", "Plan the next sprint", true], "saved square sticky and text");
  t.ok(t.node(next)!.x > note.x, "the next sticky is to the right");
  await t.undo();
  t.eq(t.node(next), null, "undo removes the next sticky");
  await t.select([id]);
  const below = await t.waitFor<{ x: number; y: number }>(`(() => {
    const el = document.querySelector(".sticky-next-below:not([hidden])");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`, "the add-below handle");
  await t.io.click(below.x, below.y);
  await t.waitFor(`window.canvasHost.sel !== ${JSON.stringify(id)} && window.canvasHost.textEdit.active`, "the sticky editor below");
  const [lower] = await t.sel();
  await t.io.key("Escape");
  await t.flush();
  t.ok(t.node(lower)!.y > note.y, "the handle adds the next sticky below");
});

sc("sticker", "Sticker placement stacks and follows the target", { covers: ["sticker:place", "sticker:stack", "sticker:anchor"], skip: { visual: "Measures the seal, the stack count and its movement with the layer." } }, async (t: T) => {
  await t.focus("lay_nest");
  await t.ev('window.canvasCmd({ cmd: "prefs", prefs: { whiteboardName: "Anna" } })');
  const p = await t.center("r_free");
  for (let i = 0; i < 2; i++) {
    await t.ev('window.canvasHost.emit("cmd", { cmd: "draw", type: "sticker" })');
    await t.waitFor('document.querySelector("[data-sticker-tray]")?.offsetWidth', "sticker tray");
    await t.io.key(i ? "l" : "2");
    await t.io.click(p.x, p.y);
    await t.flush();
  }
  await t.waitFor('document.querySelector("[data-sticker-count]")?.textContent === "2"', "one seal with a count of two");
  const [id] = await t.sel();
  t.eq([t.node(id)?.type, t.node(id)?.kind, t.node(id)?.on?.layer], ["sticker", "love", "r_free"], "saved sticker and anchor");
  const previous = await t.rect(id);
  await t.select(["r_free"]);
  await t.io.key("ArrowRight", { shift: true });
  await t.flush();
  await t.waitFor(`window.canvasHost.worldRectOf(${JSON.stringify(id)})?.x > 0`, "the sticker to be drawn");
  t.near((await t.rect(id)).x - previous.x, 10, 1, "the seal moved with its target");
  const seal = await t.center(id);
  await t.io.move(seal.x, seal.y);
  await t.waitFor('document.querySelector(".sticker-popover:not([hidden])")?.textContent.includes("Anna")', "placed-by popover");
  await t.undo();
  await t.select([id]);
  await t.undo();
  t.eq(t.node(id), null, "undo removes the second sticker");
  await t.waitFor('!document.querySelector("[data-sticker-count]")', "stack collapses back to one");
});

sc("sticky", "Sticky drag sizes the note and long text grows it", { covers: ["sticky:create", "sticky:resize", "sticky:style"], skip: { visual: "Measures the note and text after a real drag and edit." } }, async (t: T) => {
  await t.focus("lay_nest");
  await t.ev('window.canvasCmd({ cmd: "prefs", prefs: { whiteboardName: "Anna" } })');
  const board = await t.rect("lay_nest");
  const x = board.x + 320, y = board.y + 245;
  await t.io.key("s");
  const purple = await t.ev<{x: number; y: number}>(`(() => {
    const r = document.querySelector('.whiteboard-flyout [data-color="purple"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await t.io.click(purple.x, purple.y);
  await t.waitFor(`document.querySelector('.whiteboard-flyout [data-color="purple"]')?.getAttribute("aria-pressed") === "true"`, "the purple swatch selected");
  await t.io.drag(x, y, x + 140, y + 90);
  await t.waitFor("window.canvasHost.textEdit.active", "sticky opened after dragging");
  const [id] = await t.sel();
  const original = await t.rect(id);
  t.near(original.w, 140, 1, "dragged width");
  t.near(original.h, 90, 1, "dragged height");
  const long = "Make time to review notes and agree on the plan ".repeat(8);
  await t.io.type(long);
  await t.waitFor(`window.canvasHost.worldRectOf(${JSON.stringify(id)})?.h > ${original.h * 2}`, "live text grows the sticky");
  await t.io.key("Escape");
  await t.flush();
  t.eq([t.node(id)?.color, t.node(id)?.content], ["purple", long], "chosen colour and long text on disk");
  await t.waitFor('document.querySelector(".sticky-controls:not([hidden])")', "the selected sticky controls");
  await t.ev(`(() => {
    const size = document.querySelector(".sticky-size");
    size.value = "18";
    size.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await t.flush();
  t.eq(t.node(id)?.fontSize, 18, "the controls set the note's font size");
  const author = await t.ev<{ x: number; y: number }>(`(() => {
    const r = document.querySelector(".sticky-author").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await t.io.click(author.x, author.y);
  await t.flush();
  t.eq(t.node(id)?.author, undefined, "the author is removed from disk");
  await t.undo();
  t.eq(t.node(id)?.author?.name, "Anna", "undo restores the author");
  await t.select([id]);
  await t.io.key("c", { meta: true });
  await t.waitFor(`fetch("/api/structure/clipboard").then(r => r.json()).then(j => j.payload?.nodes[0]?.id === ${JSON.stringify(id)})`, "the sticky on the clipboard");
  await t.io.key("v", { meta: true });
  await t.waitFor(`window.canvasHost.sel && window.canvasHost.sel !== ${JSON.stringify(id)}`, "select the pasted sticky");
  await t.flush();
  const [copy] = await t.sel();
  t.eq([t.node(copy)?.type, t.node(copy)?.content, t.node(copy)?.color], ["sticky", long, "purple"], "copy and paste preserve the note");
});

sc("whiteboard-review", "Copied local votes can be ended and cleared", { covers: ["vote:portable"], skip: { visual: "Verifies the copied vote state and controls." } }, async (t: T) => {
  const sidecar = path.join(t.file, "comments.json");
  const vote = "22222222-2222-4222-8222-222222222222";
  fs.writeFileSync(sidecar, JSON.stringify({
    format: 1, doc: "11111111-1111-4111-8111-111111111111", seq: 0, threads: [], outbox: [], votes: [{
      id: vote, host: { id: "another-mac", name: "Anna" }, scope: { page: "layout" }, on: "anything",
      perPerson: 3, hidden: true, anonymous: false, state: "active", ballots: [],
    }],
  }));
  await t.open();
  await t.focus("lay_nest");
  await t.ev('window.canvasCmd({ cmd: "prefs", prefs: { whiteboardName: "Anna" } })');
  await t.waitFor('document.querySelector("[data-vote-end]")?.offsetWidth', "End vote on a copied file");
  await t.ev('document.querySelector("[data-vote-end]").click()');
  await t.waitFor('document.querySelector("[data-vote-clear]")?.offsetWidth', "Clear vote on a copied file");
  await t.ev('document.querySelector("[data-vote-clear]").click()');
  await t.waitFor('!(document.querySelector("[data-vote-clear]")?.offsetWidth)', "vote dismissed");
  t.eq(JSON.parse(fs.readFileSync(sidecar, "utf8")).votes[0].state, "dismissed", "the copied vote is cleared on disk");
});

sc("whiteboard-review", "DOM sticker placement anchors to the sticky layer", {
  covers: ["sticker:dom-anchor"],
  skip: { visual: "Checks the DOM hit and the anchored seal after reopening in the engine." },
}, async (t: T) => {
  const note = "ReviewNote";
  const result = await fetch(t.srv.base + "/api/structure?file=" + encodeURIComponent(t.file), {
    method: "POST",
    headers: { "x-canvas": "1", "content-type": "application/json" },
    body: JSON.stringify({ file: t.file, page: "layout", op: "add", place: { parent: "lay_nest" }, allowOverlap: true,
      nodes: [{ id: note, type: "sticky", x: 15, y: 15, width: 184, height: 184, color: "yellow", content: "Review the plan" }] }),
  });
  t.ok(result.ok, "created a sticky in the layout board");
  await t.page.goto(t.srv.base + "/?renderer=dom&file=" + encodeURIComponent(t.file));
  await t.waitFor("window.canvasHost?.doc", "the DOM canvas");
  await t.ev('window.canvasCmd({ cmd: "prefs", prefs: { whiteboardName: "Anna" } })');
  await t.ev('window.canvasHost.setPage("layout")');
  await t.ev(`(() => {
    const h = window.canvasHost, r = h.boxOf("lay_nest");
    h.setCam({ x: 70 - r.x, y: 70 - r.y, z: 1 });
  })()`);
  const at = await t.waitFor<{ x: number; y: number }>(`(() => {
    const part = document.querySelector('[data-id="${note}/:sticky-text"]');
    if (!part) return null;
    const r = part.getBoundingClientRect(), x = r.left + 10, y = r.top + 8;
    const hit = document.elementFromPoint(x, y)?.closest("[data-id]");
    return hit === part ? { x, y } : null;
  })()`, "sticky text is the DOM hit");
  await t.io.key("s", { shift: true });
  await t.waitFor('document.querySelector("[data-sticker-tray]")?.offsetWidth', "the sticker tray");
  await t.io.click(at.x, at.y);
  await t.flush();
  const [id] = await t.sel();
  t.eq(t.node(id)?.on?.layer, note, "the sticker stores the real sticky id");
  await t.open();
  await t.focus("lay_nest");
  await t.waitFor('document.querySelector("[data-sticker-seal]:not([hidden])")', "the seal drawn after reopening in the engine");
});

sc("timer", "Standalone timer pauses, extends, resumes and ends", {
  covers: ["timer:standalone", "timer:controls", "timer:clock-change"],
  skip: { visual: "Countdown text changes against the clock. The scenario checks rendered states and captures the running bar." },
}, async (t: T) => {
  await t.io.key("t", { shift: true });
  const dial = '[data-timer-dial]';
  const value = `document.querySelector(${JSON.stringify(dial)})?.getAttribute("aria-valuetext")`;
  const open = '!!document.querySelector("[data-timer-sheet]:not([hidden])")';
  const stopped = 'document.querySelector("[data-timer-bar]").hidden';
  await t.waitFor(open, "timer dial");
  t.eq(await t.ev(value), "5:00", "initial duration");
  await t.io.key("ArrowRight");
  t.eq(await t.ev(value), "5:30", "arrow advances half a minute");
  await t.io.key("Escape");
  t.ok(await t.ev(`!${open} && ${stopped}`), "Escape dismisses the dial without starting");
  await t.io.key("t", { shift: true });
  await t.io.click(30, 200);
  t.ok(await t.ev(`!${open} && ${stopped}`), "click outside dismisses without starting");
  await t.io.key("t", { shift: true });
  const r = await t.ev<{ x: number; y: number; width: number; height: number }>(
    `document.querySelector(${JSON.stringify(dial)}).getBoundingClientRect().toJSON()`);
  await t.io.move(r.x + r.width * .9, r.y + r.height / 2);
  await t.io.down();
  await t.io.move(r.x + r.width / 2, r.y + r.height * .9, 4, 1);
  t.eq(await t.ev(value), "5:00", "drag previews the snapped duration");
  t.ok(await t.ev(stopped), "drag waits for release");
  await t.io.up();
  await t.waitFor('document.querySelector("[data-timer-pause]")', "drag starts a timer on release");
  await t.ev('document.querySelector("[data-timer-stop]").click()');
  await t.waitFor(stopped, "drag timer stops");
  await t.io.key("t", { shift: true });
  await t.ev('document.querySelector(\'[data-standalone-duration="180000"]\').click()');
  await t.waitFor('document.querySelector("[data-timer-pause]")', "running timer");
  await t.ev('window.qaRealNow = Date.now; Date.now = () => window.qaRealNow() + 3600000');
  try {
    await new Promise(resolve => setTimeout(resolve, 1100));
    t.ok(await t.ev('document.querySelector("[data-timer-countdown]").textContent !== "00:00"'), "a wall-clock jump does not zero the timer");
  } finally {
    await t.ev('Date.now = window.qaRealNow; delete window.qaRealNow');
  }
  await t.ev('document.querySelector("[data-timer-pause]").click()');
  const paused = await t.waitFor<string>('document.querySelector("[data-timer-resume]") && document.querySelector("[data-timer-countdown]").textContent', "paused countdown");
  await t.ev('document.querySelector("[data-timer-extend]").click()');
  await t.waitFor(`document.querySelector("[data-timer-countdown]").textContent !== ${JSON.stringify(paused)}`, "extended countdown");
  await t.ev('document.querySelector("[data-timer-resume]").click()');
  await t.waitFor('document.querySelector("[data-timer-pause]")', "resumed countdown");
  await t.ev('document.querySelector("[data-timer-stop]").click()');
  await t.waitFor('document.querySelector("[data-timer-bar]").hidden', "stopped timer disappears");
  const vote = randomUUID();
  t.eq((await whiteboardOp(t.srv.base, t.file, { kind: "timer.set", action: "start", standalone: true, vote, ms: 3000 })).status,
    200, "a short timer starts");
  await t.waitFor('document.querySelector(".timer-urgent")', "last ten seconds styling");
  await t.ev('document.querySelector("[data-timer-mute]").click()');
  await t.waitFor('document.querySelector("[data-timer-mute]")?.getAttribute("aria-label") === "Unmute timer sound"', "the local mute toggle");
  fs.writeFileSync("qa/out/timer-standalone.png", await t.shot());
  await t.waitFor(`document.querySelector("[data-timer-bar]").textContent.includes("Time's up")`, "standalone timer ends while idle");
  await t.ev('document.querySelector("[data-timer-done]").click()');
  await t.waitFor('document.querySelector("[data-timer-bar]").hidden', "the end notice dismisses");
  await t.open();
  t.ok(await t.ev('document.querySelector("[data-timer-bar]").hidden'), "the local dismissal stays after reload");
  await t.io.key("t", { shift: true });
  t.eq(await t.ev(value), "3:00", "last started duration survives reload");
  await t.io.key("ArrowLeft");
  await t.io.key("Enter");
  await t.waitFor('document.querySelector("[data-timer-pause]")', "Return starts the keyboard duration");
  await t.waitFor('document.querySelector("[data-timer-countdown]").textContent === "02:30"', "keyboard timer uses the adjusted duration");
  await t.ev('document.querySelector("[data-timer-stop]").click()');
  await t.waitFor(stopped, "keyboard timer stops");
  const timedVote = randomUUID(), page = await t.ev<string>("window.canvasHost.page");
  t.eq((await whiteboardOp(t.srv.base, t.file, { kind: "vote.start", vote: timedVote, scope: { page }, on: "anything",
    perPerson: 1, hidden: true, anonymous: false, timerMs: 2000 })).status, 200, "start a local timed vote");
  await t.waitFor(`document.querySelector(".vote-bar").textContent.includes("Time's up")`, "local vote ends while idle");
  await t.waitFor('[...window.canvasHost.boards.keys()].filter(id => id.startsWith("vote-conclusion-")).length === 1', "one local conclusion is placed");
  await t.waitFor('document.querySelector("[data-vote-clear]")', "the conclusion is saved");
  t.eq((await whiteboardOp(t.srv.base, t.file, { kind: "vote.clear", vote: timedVote })).status, 200, "clear the local result overlay");
});
