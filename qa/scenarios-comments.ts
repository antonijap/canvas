// QA scenarios for comments (docs/cloud/protocol.md, src/page/comments.js): C then a click pins a thread to the layer
// under the pointer, the pin follows the layer and the camera, replies and Resolve, Show resolved, a deleted layer's
// thread sits at its board's corner, and a reopened file shows its comments. Real keys and mouse; the result is read from
// comments.json on disk and from the pins in the page. Pictures go to qa/out/comments-*.png.
import fs from "node:fs";
import path from "node:path";
import { sc, type Rect, type T } from "./harness.ts";
import { ROOT, sleep } from "./lib.ts";

const OUT = path.join(ROOT, "qa", "out");
const file = (t: T): any | null => { try { return JSON.parse(fs.readFileSync(path.join(t.file, "comments.json"), "utf8")); } catch { return null; } };
const until = async (t: T, ok: () => boolean, what: string) => {
  for (let i = 0; i < 80; i++) { if (ok()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
};
/** Every drawn pin: its thread id, its window box and its classes. */
const pins = (t: T) => t.ev<{ id: string; x: number; y: number; w: number; h: number; cls: string }[]>(`[...document.querySelectorAll(".cm-pin")].filter((e) => e.style.display !== "none").map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.thread, x: r.left, y: r.top, w: r.width, h: r.height, cls: e.className }; })`);
const pinOf = async (t: T, id?: string) => { const ps = (await pins(t)).filter((p) => p.id !== "draft"); const p = id ? ps.find((x) => x.id === id) : ps[0]; if (!p) throw new Error("no pin" + (id ? " for " + id : "")); return p; };
/** The tip of a pin (its bottom left corner), in window px: where the comment points. */
const tip = (p: { x: number; y: number; h: number }) => ({ x: p.x, y: p.y + p.h });
async function shot(t: T, name: string, clip?: Rect) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), await t.shot(clip ? { x: clip.x, y: clip.y, width: clip.w, height: clip.h } : undefined));
}
/** C, a click on (x, y), the text and Return. Leaves comment mode on. */
async function comment(t: T, x: number, y: number, text: string) {
  await t.io.click(x, y);
  await t.waitFor(`!!document.querySelector(".cm-comp:not([hidden]) textarea")`, "the composer");
  await t.waitFor(`document.activeElement === document.querySelector(".cm-comp textarea")`, "the composer focused");
  await t.io.type(text);
  await t.io.key("Enter");
}
const mode = (t: T) => t.ev<boolean>("window.canvasHost.comments.mode");

sc("comments", "Comment hint follows the zoom corner at every window size", { covers: ["comments:light", "comments:dark"], skip: { visual: "Hint placement is measured in both themes and at three viewport sizes; no document pixels change." } }, async (t: T) => {
  await t.open({ native: true });
  await t.waitFor("!!window.canvasHost.comments", "comments loaded");
  await t.ev(`window.canvasCmd({cmd:'comment'})`);
  for (const theme of ["light", "dark"]) {
    await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
    for (const [width, height] of [[720, 420], [1280, 800], [1800, 1000]]) {
      await t.page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      // Stand in for the measured native island. Clearance insets deliberately differ from chrome spacing.
      await t.ev(`(() => {
        let e = document.getElementById('qa-zoom-corner');
        if (!e) { e = document.createElement('div'); e.id = 'qa-zoom-corner'; document.body.append(e); }
        e.style.cssText = 'position:fixed;right:24px;bottom:18px;width:124px;height:var(--c-pill)';
        window.canvasCmd({cmd:'insets',l:60,t:60,r:304,b:60});
        const r = e.getBoundingClientRect();
        window.canvasCmd({cmd:'zoomCorner',left:r.left,bottom:r.bottom});
      })()`);
      await t.settle();
      const boxes = await t.ev<any>(`(() => {
        const h = document.querySelector('.cm-hint').getBoundingClientRect(), z = document.getElementById('qa-zoom-corner').getBoundingClientRect();
        return { bottom:h.bottom, zoomBottom:z.bottom, right:h.right, zoomLeft:z.left, left:h.left,
          gap:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--c-island-gap')) };
      })()`);
      const geometry = await t.ev<any>(`(() => { const r = document.querySelector('.cm-hint').getBoundingClientRect(), z = document.getElementById('qa-zoom-corner').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,zy:z.y+z.height/2,right:r.right}; })()`);
      t.near(geometry.x, (60 + width - 304)/2, 1, 'canvas center');
      t.near(geometry.y, geometry.zy, 1, 'zoom center');
      t.ok(geometry.right < boxes.zoomLeft, 'clear of zoom');
    }
  }
  await t.ev(`document.getElementById('qa-zoom-corner').remove(); window.canvasCmd({cmd:'comment'})`);
  await t.open({ native: true });
});
const openThread = async (t: T, id?: string) => { const p = await pinOf(t, id); await t.io.click(p.x + p.w / 2, p.y + p.h / 2); await t.waitFor(`!!document.querySelector(".cm-pop:not([hidden]) .cm-field")`, "the thread"); };

sc("comments", "Dictation: the mic button writes into the composer as words arrive, and says when it is not allowed", { covers: ["comments:keyboard"], skip: { visual: "The app's shell is faked; no microphone is opened and no document pixels change." } }, async (t: T) => {
  await t.open({ native: true });
  await t.waitFor("!!window.canvasHost.comments", "comments loaded");
  await t.focus("lay_nest");
  await t.ev(`(() => { window.__dictation = []; window.webkit = { messageHandlers: { canvasState: { postMessage: (j) => { const m = JSON.parse(j); if (m.dictation) window.__dictation.push(m.dictation); } } } }; })()`);
  await t.ev(`window.canvasCmd({cmd:'comment'})`);
  const c = await t.center("r_free");
  await t.io.click(c.x, c.y);
  await t.waitFor(`document.activeElement === document.querySelector(".cm-comp textarea")`, "the composer focused");
  const mic = await t.ev<{ x: number; y: number }>(`(() => { const r = document.querySelector(".cm-comp .cm-mic").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await t.io.click(mic.x, mic.y);
  const sent = () => t.ev<{ op: string; id: string }[]>("window.__dictation");
  t.eq((await sent()).map((m) => m.op), ["start"], "the button asks the shell to listen");
  const id = (await sent())[0].id;
  await t.ev(`window.canvasCmd({cmd:'dictation', id:'${id}', event:'listening'}); window.canvasCmd({cmd:'dictation', id:'${id}', event:'text', text:'Make it bigger'})`);
  t.eq(await t.ev(`document.querySelector(".cm-comp textarea").value`), "Make it bigger", "the words show as they arrive");
  t.ok(await t.ev(`document.querySelector(".cm-comp .cm-mic").classList.contains("live")`), "the button shows it is listening");
  await shot(t, "comments-dictating");
  await t.io.click(mic.x, mic.y);
  t.eq((await sent()).map((m) => m.op), ["start", "stop"], "a second click stops");
  await t.ev(`window.canvasCmd({cmd:'dictation', id:'${id}', event:'end'})`);
  await t.io.click(mic.x, mic.y);
  const next = (await sent())[2].id;
  await t.ev(`window.canvasCmd({cmd:'dictation', id:'${next}', event:'denied', which:'microphone'})`);
  t.ok(/Microphone access is off.*Open System Settings/s.test(await t.ev<string>(`document.querySelector(".cm-comp .cm-micnote").innerText`)), "a refusal says so and links to System Settings");
  await shot(t, "comments-dictation-denied");
});

sc("comments", "C then a click pins a thread on the layer under the pointer; Return posts, Esc leaves", { covers: ["comments:pin", "comments:keyboard", "comments:page-point"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.clearSel();
  await t.io.key("c");
  t.eq(await mode(t), true, "C turns comment mode on");
  t.ok(await t.ev(`document.getElementById("view").classList.contains("cm-mode")`), "the pointer is the comment cursor");
  await shot(t, "comments-mode-dark");
  const c = await t.center("r_free");
  // The layer under the pointer lights up before the click.
  await t.io.move(c.x, c.y, 4);
  await t.waitFor(`(() => { const e = document.querySelector(".cm-hov"); return !!e && e.style.display === "block"; })()`, "the layer under the pointer outlined");
  const hr = await t.rect("r_free");
  const ob = await t.ev<Rect>(`(() => { const r = document.querySelector(".cm-hov").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  t.near(ob.x, hr.x, 2, "the outline is on the layer, x");
  t.near(ob.w, hr.w, 2, "and as wide");
  t.ok(/Comment mode/.test(await t.ev<string>(`document.querySelector(".cm-hint").innerText`)), "the hint says Comment mode");
  // Shift+Return is a new line and posts nothing; Esc cancels the composer; nothing is saved.
  await t.io.click(c.x, c.y);
  await t.waitFor(`!!document.querySelector(".cm-comp:not([hidden]) textarea")`, "the composer");
  t.eq(await t.sel(), [], "a click in comment mode selects nothing");
  const outlined = () => t.ev<number>(`(() => { const e = document.querySelector(".cm-hov"); return e.style.display === "block" ? e.getBoundingClientRect().width : 0; })()`);
  const other = await t.rect("r_free");
  await t.io.move(other.x + other.w * 3, other.y + other.h * 3, 4);
  await sleep(100);
  t.near(await outlined(), other.w, 2, "while composing, the attached layer stays outlined and nothing else lights up");
  await t.io.type("one");
  await t.io.key("Enter", { shift: true });
  await t.io.type("two");
  t.eq(await t.ev(`document.querySelector(".cm-comp textarea").value`), "one\ntwo", "Shift+Return is a new line");
  t.eq(file(t), null, "nothing posted yet");
  await t.io.key("Escape");
  await t.waitFor(`document.querySelector(".cm-comp").hidden`, "the composer closed");
  t.eq(file(t), null, "Esc cancelled the draft");
  t.eq(await mode(t), true, "Esc closed the composer, not the mode");
  // Return posts: the thread is pinned to the layer under the pointer, off its middle.
  const r = await t.rect("r_free");
  await comment(t, r.x + r.w * 0.25, r.y + r.h * 0.75, "Teal is too loud here");
  await until(t, () => !!file(t)?.threads?.length, "comments.json");
  const th = file(t).threads[0];
  t.eq(th.anchor.nodeId, "r_free", "pinned to the layer under the pointer");
  t.eq(th.anchor.board, "lay_nest", "and its board");
  t.near(th.anchor.x, 0.25, 0.03, "x as a fraction of the layer");
  t.near(th.anchor.y, 0.75, 0.03, "y as a fraction of the layer");
  t.eq(th.anchor.preview.name, "Free rect", "the layer's name is kept");
  t.eq(th.anchor.preview.type, "rectangle", "and its type");
  t.eq([th.anchor.preview.width, th.anchor.preview.height], [70, 50], "and its size");
  t.eq(th.comments[0].body, "Teal is too loud here", "the text");
  t.ok(typeof file(t).doc === "string" && file(t).doc.length === 36, "a doc uuid");
  const p = await pinOf(t, th.id);
  t.near(tip(p).x, r.x + r.w * 0.25, 1.5, "the pin points at the click, x");
  t.near(tip(p).y, r.y + r.h * 0.75, 1.5, "the pin points at the click, y");
  // Empty canvas pins to the page point.
  const bb = await t.rect("lay_nest");
  await comment(t, bb.x + bb.w + 40, bb.y + 40, "A note on the empty canvas");
  await until(t, () => file(t)?.threads?.length === 2, "the second thread");
  const th2 = file(t).threads[1];
    t.ok(th2.anchor.nodeId === undefined, "an empty click names no layer");
  const world = await t.ev<{ x: number; y: number }>(`(() => { const h = window.canvasHost, c = h.cam; return { x: (${bb.x + bb.w + 40} - h.viewBox.l - c.x) / c.z, y: (${bb.y + 40} - h.viewBox.t - c.y) / c.z }; })()`);
  t.near(th2.anchor.x, world.x, 1.5, "the page point, x");
  t.near(th2.anchor.y, world.y, 1.5, "the page point, y");
  // Esc leaves comment mode, then Esc as usual.
  await t.io.key("Escape");
  t.eq(await mode(t), false, "Esc leaves comment mode");
  // The usual click selects again.
  await t.io.click(r.x + 10, r.y + r.h - 6);
  t.eq(await t.sel(), ["r_free"], "outside comment mode a click selects");
  // C while typing in the composer types a letter, it does not toggle.
  await t.io.key("c");
  await t.io.key("c");
  t.eq(await mode(t), false, "C twice is on, then off");
  await t.clearSel();
});

sc("comments", "a pin follows its layer when it moves or resizes, and the camera", { covers: ["comments:follows-layer", "comments:pin"] }, async (t: T) => {
  await t.focus("lay_nest");
  const r0 = await t.rect("r_free");
  await t.io.key("c");
  await comment(t, r0.x + r0.w * 0.5, r0.y + r0.h * 0.5, "Follow me");
  await until(t, () => !!file(t)?.threads?.length, "the thread");
  const id = file(t).threads[0].id;
  await t.io.key("Escape");
  const where = async () => { const [r, p] = [await t.rect("r_free"), await pinOf(t, id)]; return { fx: (tip(p).x - r.x) / r.w, fy: (tip(p).y - r.y) / r.h, r, p }; };
  let w = await where();
  t.near(w.fx, 0.5, 0.03, "starts on the middle, x");
  // Move the layer: the pin goes with it.
  await t.select(["r_free"]);
  for (let i = 0; i < 4; i++) await t.io.key("ArrowRight", { shift: true });
  await t.flush();
  await until(t, () => (t.node("r_free")!.x as number) >= 340, "the layer moved");
  await t.frames(3);
  w = await where();
  t.near(w.r.x, r0.x + 40, 2, "the layer moved 40 px");
  t.near(w.fx, 0.5, 0.03, "after a move the pin is still on the middle of the layer, x");
  t.near(w.fy, 0.5, 0.03, "y");
  // Resize it: the pin keeps its fractions.
  for (let i = 0; i < 3; i++) await t.io.key("ArrowRight", { meta: true, shift: true });
  await t.flush();
  await until(t, () => (t.node("r_free")!.width as number) > 70, "the layer resized");
  await t.frames(3);
  w = await where();
  t.ok(w.r.w > 80, "the layer is wider");
  t.near(w.fx, 0.5, 0.03, "after a resize the pin keeps its fraction");
  // The camera: pan and zoom, the pin stays on the layer.
  await t.ev(`window.canvasHost.setCam({ z: 2, x: window.canvasHost.cam.x - 120, y: window.canvasHost.cam.y - 40 })`);
  await t.settle();
  await t.frames(3);
  w = await where();
  t.near(w.fx, 0.5, 0.03, "after a pan and zoom the pin is still on the layer");
  t.near(w.fy, 0.5, 0.03, "y");
  // Undo of the canvas does not touch comments.
  await t.undo();
  t.eq(file(t).threads.length, 1, "comments are not in the undo history");
});

sc("comments", "reply, resolve and Show resolved", { covers: ["comments:reply", "comments:resolve", "comments:show-resolved"] }, async (t: T) => {
  await t.focus("lay_nest");
  const r = await t.rect("r_free");
  await t.io.key("c");
  await comment(t, r.x + r.w / 2, r.y + r.h / 2, "Is this the right teal?");
  await until(t, () => !!file(t)?.threads?.length, "the thread");
  const id = file(t).threads[0].id;
  await t.io.key("Escape");
  // The pin opens the thread: no header, the comment with a Resolve check on its name row, and a reply box.
  await openThread(t, id);
  const text = await t.ev<string>(`document.querySelector(".cm-pop").innerText`);
  t.ok(/Is this the right teal\?/.test(text), "the thread shows its comment");
  t.ok(await t.ev(`!!document.querySelector('.cm-pop .cm-item:first-child .cm-who [aria-label="Resolve thread"]')`), "Resolve is a check on the first comment's name row");
  t.eq(await t.ev(`document.querySelector('.cm-pop .cm-res').title`), "Resolve", "its tooltip");
  t.ok(await t.ev(`!document.querySelector('.cm-pop .cm-head') && !document.querySelector('.cm-pop [aria-label="More"]')`), "no header and no More button");
  await t.io.type("Yes, keep it");
  await t.io.key("Enter");
  await until(t, () => file(t).threads[0].comments.length === 2, "the reply");
  t.eq(file(t).threads[0].comments[1].body, "Yes, keep it", "the reply is saved");
  await t.waitFor(`document.querySelectorAll(".cm-pop .cm-item").length === 2`, "the reply in the thread");
  await shot(t, "comments-thread-dark");
  // Resolve hides the pin and closes the thread.
  await t.ev(`document.querySelector('.cm-pop [aria-label="Resolve thread"]').click()`);
  await until(t, () => !!file(t).threads[0].resolvedAt, "resolved on disk");
  await t.waitFor(`![...document.querySelectorAll(".cm-pin")].some((e) => e.dataset.thread === ${JSON.stringify(id)} && e.style.display !== "none")`, "the pin hidden");
  // Show resolved brings it back, faded; Reopen puts it back.
  await t.ev(`document.querySelector(".cv-btn").click()`);
  await t.waitFor(`document.querySelector(".cm-show-resolved")?.textContent === "Show 1 resolved"`, "the resolved count in the sidebar");
  await t.ev(`document.querySelector(".cm-show-resolved").click()`);
  await t.waitFor(`(() => { const p = document.querySelector('.cm-pin[data-thread="${id}"]'); return p?.classList.contains("resolved") && p.style.display !== "none"; })()`, "the resolved pin shown");
  await openThread(t, id);
  t.ok(/Resolved by/.test(await t.ev<string>(`document.querySelector(".cm-pop").innerText`)), "the thread says who resolved it");
  t.eq(await t.ev(`document.querySelector('.cm-pop .cm-res').title`), "Reopen", "the check says Reopen on a resolved thread");
  await t.ev(`document.querySelector('.cm-sidebar-head [aria-label="Close"]').click()`);
  await t.ev(`document.querySelector('.cm-pop [aria-label="Reopen thread"]').click()`);
  await until(t, () => !file(t).threads[0].resolvedAt, "reopened on disk");
  // Delete: a reply goes (its tombstone stays), then the thread.
  await t.waitFor(`!!document.querySelector('.cm-pop [aria-label="Delete comment"]')`, "a reply's Delete");
  await t.ev(`document.querySelector('.cm-pop [aria-label="Delete comment"]').click()`);
  await until(t, () => !!file(t).threads[0].comments[1].deletedAt, "the reply deleted");
  t.eq(file(t).threads[0].comments[1].body, "", "its text is gone from the file");
  // Delete thread is in the thread's right-click menu: a real right-click on the comment's text.
  const tx = await t.ev<{ x: number; y: number }>(`(() => { const b = document.querySelector(".cm-pop .cm-text").getBoundingClientRect(); return { x: b.left + 8, y: b.top + b.height / 2 }; })()`);
  await t.io.move(tx.x, tx.y);
  await t.page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tx.x, y: tx.y, button: "right", buttons: 2, clickCount: 1 });
  await t.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tx.x, y: tx.y, button: "right", buttons: 0, clickCount: 1 });
  await t.waitFor(`!!document.querySelector('.cm-pop .cm-menu [aria-label="Delete thread"]')`, "the thread's right-click menu");
  t.ok(await t.ev(`(() => { const m = document.querySelector('.cm-pop .cm-menu').getBoundingClientRect(); return Math.abs(m.left - ${tx.x}) < 12 && Math.abs(m.top - ${tx.y}) < 12; })()`), "the menu opens at the pointer");
  await t.ev(`document.querySelector('.cm-menu [aria-label="Delete thread"]').click()`);
  await until(t, () => !!file(t).threads[0].deletedAt, "the thread deleted");
  await t.waitFor(`document.querySelectorAll(".cm-pin").length === 0`, "no pins");
});

// GitHub issue 10: a field the system may fill gets macOS's "Fill code from Mail" offer over the comment controls.
sc("comments", "the comment and reply fields opt out of AutoFill, autocorrect and writing suggestions", { covers: ["comments:keyboard", "comments:reply"] }, async (t: T) => {
  const OFF = { autocomplete: "off", autocorrect: "off", autocapitalize: "off", writingsuggestions: "false" };
  const attrs = (sel: string) => t.ev<Record<string, string | null>>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return Object.fromEntries(${JSON.stringify(Object.keys(OFF))}.map((k) => [k, e && e.getAttribute(k)])); })()`);
  await t.focus("lay_nest");
  const r = await t.rect("r_free");
  await t.io.key("c");
  await t.io.click(r.x + r.w / 2, r.y + r.h / 2);
  await t.waitFor(`!!document.querySelector(".cm-comp:not([hidden]) textarea")`, "the composer");
  t.eq(await attrs(".cm-comp textarea"), OFF, "the new comment field");
  await t.io.type("Check the spacing");
  await t.io.key("Enter");
  await until(t, () => !!file(t)?.threads?.length, "the thread");
  await t.io.key("Escape");
  await openThread(t, file(t).threads[0].id);
  t.eq(await attrs(".cm-pop .cm-field"), OFF, "the reply field");
  t.eq(await t.ev(`[...document.querySelectorAll(".cm-comp textarea, .cm-pop textarea, .cm-pop input")].filter((e) => e.getAttribute("autocomplete") !== "off").length`), 0, "no comment field is left to AutoFill");
});

sc("comments", "a thread whose layer was deleted shows at its board's corner as Layer deleted, never on another layer", { covers: ["comments:layer-deleted"] }, async (t: T) => {
  await t.focus("lay_nest");
  const r = await t.rect("r_free");
  await t.io.key("c");
  await comment(t, r.x + r.w / 2, r.y + r.h / 2, "Remove this?");
  await until(t, () => !!file(t)?.threads?.length, "the thread");
  const id = file(t).threads[0].id;
  await t.io.key("Escape");
  await t.select(["r_free"]);
  await t.io.key("Delete");
  await t.flush();
  await until(t, () => !t.node("r_free"), "the layer deleted");
  await t.waitFor(`document.querySelector('.cm-pin[data-thread="${id}"]')?.classList.contains("gone") && document.querySelector('.cm-pin[data-thread="${id}"]').style.display !== "none"`, "the pin at the board's corner");
  const b = await t.rect("lay_nest");
  const p = await pinOf(t, id);
  t.ok(p.x >= b.x + b.w, `the pin is beside the board, past its right edge (${p.x} vs ${b.x + b.w})`);
  t.ok(p.y >= b.y - 30 && p.y <= b.y + 120, "near the board's top corner");
  // No layer is under the pin.
  const under = await t.ev<string | null>(`window.canvasHost.pick(${p.x + p.w / 2}, ${p.y + p.h / 2})`);
  t.ok(!under || !under.startsWith("lay_") && under !== "r_n3", "the pin sits on no layer");
  await openThread(t, id);
  const text = await t.ev<string>(`document.querySelector(".cm-pop").innerText`);
  t.ok(/Layer deleted/.test(text), "the thread says Layer deleted");
  t.ok(/Free rect, a rectangle 70 \u00d7 50/.test(text), "and names the layer by its stored preview");
  t.ok(/Pin to a layer/.test(text), "and offers Pin to a layer");
  t.eq(file(t).threads[0].anchor.nodeId, "r_free", "the anchor is untouched: it is never moved to another layer");
  await shot(t, "comments-deleted-dark");
  // Pin to a layer: Esc leaves; then again and click another layer moves the thread there by hand.
  await t.ev(`[...document.querySelectorAll(".cm-pop button")].find((b) => b.textContent === "Pin to a layer").click()`);
  await t.waitFor(`window.canvasHost.comments.mode`, "pin mode");
  await t.io.click(...(Object.values(await t.center("fr_outer")) as [number, number]));
  await until(t, () => file(t).threads[0].anchor.nodeId === "fr_outer", "the thread moved to the layer clicked");
  t.eq(file(t).threads[0].comments.length, 1, "the comments came along");
  await t.waitFor(`!document.querySelector('.cm-pin[data-thread="${id}"]')?.classList.contains("gone")`, "the pin on the new layer");
  await t.io.key("Escape");
  await t.io.key("Escape");
  // Undo brings the layer back; the thread stays where it was put by hand.
  await t.undo();
  t.eq(file(t).threads[0].anchor.nodeId, "fr_outer", "comments are not in undo");
});

sc("comments", "reopening the file shows its comments", { covers: ["comments:reopen"] }, async (t: T) => {
  await t.focus("lay_nest");
  const r = await t.rect("r_free");
  await t.io.key("c");
  await comment(t, r.x + r.w / 2, r.y + r.h / 2, "Still here tomorrow");
  await until(t, () => !!file(t)?.threads?.length, "the thread");
  const id = file(t).threads[0].id;
  await t.io.key("Escape");
  await t.open();
  await t.focus("lay_nest");
  await t.waitFor(`!!document.querySelector('.cm-pin[data-thread="${id}"]')`, "the pin after a reload");
  await openThread(t, id);
  t.ok(/Still here tomorrow/.test(await t.ev<string>(`document.querySelector(".cm-pop").innerText`)), "the text after a reload");
  // A comment an agent makes while the file is open appears without a reload.
  const th = file(t).threads[0];
  const reply = await fetch(`${t.srv.base}/api/comments/ops?file=${encodeURIComponent(t.file)}`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", "x-canvas-source": "mcp", "x-canvas-agent": "claude-code" }, body: JSON.stringify({ ops: [{ opId: crypto.randomUUID(), doc: "00000000-0000-4000-8000-000000000000", at: new Date().toISOString(), op: { kind: "comment.add", thread: th.id, comment: crypto.randomUUID(), body: "Looks fine to me" } }] }) });
  t.eq(reply.status, 200, "the agent's comment is accepted");
  await t.waitFor(`document.querySelector(".cm-pop").innerText.includes("Looks fine to me") && document.querySelector(".cm-pop").innerText.includes("Claude Code")`, "the agent's reply to appear, named after its client");
  await t.io.key("Escape");
});

sc("comments", "light and dark: comment mode, a thread, a deleted layer's pin", { covers: ["comments:light", "comments:dark"] }, async (t: T) => {
  await t.focus("lay_nest");
  const r = await t.rect("r_free");
  await t.io.key("c");
  await comment(t, r.x + r.w / 2, r.y + r.h / 2, "Light and dark");
  await until(t, () => !!file(t)?.threads?.length, "the thread");
  const id = file(t).threads[0].id;
  await t.io.key("Escape");
  await t.io.key("Escape");
  await t.io.key("c");
  await comment(t, r.x + 40, r.y - 60 < 0 ? r.y + 100 : r.y - 60, "Second pin with a longer comment that wraps onto a second line to show how text sets");
  await until(t, () => file(t)?.threads?.length === 2, "the second thread");
  for (const theme of ["light", "dark"]) {
    await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
    await t.frames(3);
    await shot(t, `comments-mode-${theme}`);
    await t.io.key("Escape");
    await openThread(t, id);
    await shot(t, `comments-thread-${theme}`);
    await t.io.key("Escape");
    await t.io.key("c");
    t.eq(await mode(t), true, "back in comment mode");
  }
  await t.io.key("Escape");
  await t.select(["r_free"]);
  await t.io.key("Delete");
  await t.flush();
  await t.waitFor(`document.querySelector('.cm-pin[data-thread="${id}"]')?.classList.contains("gone")`, "the deleted layer's pin");
  for (const theme of ["light", "dark"]) {
    await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
    await t.frames(3);
    await openThread(t, id);
    await shot(t, `comments-deleted-${theme}`);
    await t.io.key("Escape");
  }
  await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" }] });
});

sc('comments', 'Mentions in replies filter people and persist a picked token', { covers: ['comments:keyboard'], skip: { visual: 'Keyboard selection and persisted metadata are asserted.' } }, async (t: T) => {
  await t.focus('lay_nest'); await t.clearSel(); await t.io.key('c');
  const r = await t.center('r_free');
  await comment(t, r.x, r.y, 'A note');
  await until(t, () => !!file(t)?.threads?.length, 'saved thread');
  const f = file(t); f.threads[0].comments[0].author = { name: 'Ben' };
  fs.writeFileSync(path.join(t.file, 'comments.json'), JSON.stringify(f));
  await t.ev('window.canvasHost.comments.reload()');
  await t.io.key('Escape'); await openThread(t);
  await t.io.type('@be');
  await t.waitFor('!!document.querySelector(".cm-mentions:not([hidden]) button")', 'mention suggestions');
  t.eq(await t.ev('document.querySelector(".cm-mentions:not([hidden])").innerText'), 'Ben', 'filtered local commenters');
  await t.io.key('ArrowDown'); await t.io.key('Tab');
  t.eq(await t.ev('document.querySelector(".cm-pop textarea").value'), '@Ben ', 'picked name');
  const updated = file(t); updated.threads[0].comments[0].body = 'Updated note';
  fs.writeFileSync(path.join(t.file, 'comments.json'), JSON.stringify(updated));
  await t.ev('window.canvasHost.comments.reload()');
  await t.io.type('please check'); await t.io.key('Enter');
  await until(t, () => file(t)?.threads[0]?.comments.length === 2, 'mention saved');
  await t.waitFor(`document.querySelector('.cm-pop textarea')?.value === ''`, 'successful reply clears the visible field');
  const reply = file(t).threads[0].comments[1];
  t.eq(reply.body, '@Ben please check', 'older readers see text');
  t.eq(reply.mentions, [{ start: 0, end: 4, name: 'Ben' }], 'mention metadata saved');
  await t.ev(`(() => { const original=window.fetch; window.fetch=async(u,o)=>{ const r=await original(u,o); if(typeof u==='string' && u.startsWith('/api/comments?file=')){const j=await r.json();j.me='Ben';return new Response(JSON.stringify(j));} return r; };return window.canvasHost.comments.reload();})()`);
  t.ok(await t.ev(`document.querySelector('.cm-pop').innerText.includes('mentioned you')`), 'recipient sees mentioned you');
  await t.ev("document.querySelector('.cm-pop textarea').focus()");
  await t.io.type('Another @be');
  await t.waitFor('!!document.querySelector(".cm-mentions:not([hidden]) button")', 'suggestions again after a space');
  await t.io.key('Escape');
  t.eq(await t.ev(`document.querySelector('.cm-pop').hidden`), false, 'Escape closes suggestions and keeps reply open');
  await t.io.type('n'); await t.io.key('Enter');
  t.eq(file(t).threads[0].comments.length, 2, 'Return picked the person without posting');
  await t.io.key('Enter');
  await until(t, () => file(t)?.threads[0]?.comments.length === 3, 'Return posts after picking');
  await t.waitFor(`document.querySelector('.cm-pop textarea')?.value === ''`, 'second reply clears');
  t.eq(file(t).threads[0].comments[2].body, 'Another @Ben', 'fresh reply body');
  t.eq(file(t).threads[0].comments[2].mentions, [{ start: 8, end: 12, name: 'Ben' }], 'fresh mention range');
  await t.io.type('@');
  await t.waitFor('!!document.querySelector(".cm-mentions:not([hidden]) button")', 'suggestions at the start');
  await t.io.key('Escape');
});

sc("comments", "Unread comments and the pin menu", { covers: ["comments:unread", "comments:pin-menu"], skip: { visual: "Unread appearances are captured separately in light and dark." } }, async (t: T) => {
  const shell = new AbortController();
  const headers = { "x-canvas": "1", "content-type": "application/json" };
  const name = (commentName: string) => fetch(t.srv.base + "/api/state", {
    method: "POST", headers, body: JSON.stringify({ client: "qa-comments", role: "shell", settings: { commentName } }),
  });
  const api = t.srv.base + "/api/comments?file=" + encodeURIComponent(t.file);
  try {
    await t.ev("localStorage.removeItem('canvas:comments:showResolved')");
    await t.open();
    await fetch(t.srv.base + "/api/bridge/events?client=qa-comments&role=shell", { signal: shell.signal });
    t.eq((await name("Anna")).status, 200, "Anna is the local commenter");
    await t.focus("lay_nest");
    await t.ev("window.canvasHost.comments.reload()");
    const r = await t.center("r_free");
    const create = async (body: string, x: number) => {
      const id = crypto.randomUUID();
      const res = await fetch(api.replace("/api/comments?", "/api/comments/ops?"), {
        method: "POST", headers, body: JSON.stringify({ ops: [{
          opId: crypto.randomUUID(), doc: "00000000-0000-4000-8000-000000000000", at: new Date().toISOString(),
          op: { kind: "thread.create", thread: id, comment: crypto.randomUUID(), body,
            anchor: { page: await t.ev("window.canvasHost.page"), x, y: await t.ev(`(${r.y} - window.canvasHost.cam.y) / window.canvasHost.cam.z`) } },
        }] }),
      });
      t.eq((await res.json()).rejected, [], "comment saved");
      return id;
    };
    const x = await t.ev<number>(`(${r.x} - window.canvasHost.cam.x) / window.canvasHost.cam.z`);
    const own = await create("Anna's note", x - 90);
    t.eq((await name("Ben")).status, 200, "Ben is the local commenter");
    const id = await create("Ben's note", x);
    t.eq(file(t).threads.find((item: { id: string }) => item.id === id).createdBy.name, "Ben", "the second thread belongs to Ben");
    t.eq((await name("Anna")).status, 200, "Anna is the local commenter again");
    const loaded = await (await fetch(api)).json();
    t.eq(loaded.unread, [id], "the server gives Anna one unread thread");
    await t.ev("window.canvasHost.comments.reload()");
    const pin = `.cm-pin[data-thread="${id}"]`;
    await t.waitFor(`document.querySelector('${pin}')?.classList.contains("unread")`, "Ben's unread pin for Anna");
    t.ok(await t.ev(`!document.querySelector('.cm-pin[data-thread="${own}"]').classList.contains('unread')`), "Anna's pin stays read");
    const badge = `document.querySelector('.cv-btn').getAttribute('aria-label') === 'Comments, 1 unread'`;
    await t.waitFor(badge, "the Comments button shows one unread thread");
    await t.ev(`document.querySelector('.cv-btn').click()`);
    await t.waitFor(`document.querySelector('.cm-sidebar .cm-thread-row.unread')?.dataset.thread === "${id}"`, "the unread row sorts first");
    t.eq(await t.ev(`document.querySelector('.cm-thread-row.unread').closest('section').querySelector('h3').textContent`), "Unread", "the unread section");
    for (const theme of ["light", "dark"]) {
      await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await t.frames(3);
      await shot(t, `comments-unread-${theme}`);
    }
    await t.ev(`document.querySelector('.cm-sidebar [data-thread="${id}"]').click()`);
    await t.waitFor(`!document.querySelector('${pin}')?.classList.contains("unread") && !document.querySelector('.cm-pop').hidden`, "opening clears unread");
    t.eq(await t.ev(`document.querySelector('.cm-thread-row[aria-current="true"]')?.dataset.thread`), id, "the open thread stays selected");
    await t.io.type("Anna's reply");
    await t.io.key("Enter");
    await until(t, () => file(t).threads.find((item: { id: string }) => item.id === id).comments.length === 2, "Anna's reply");
    await t.waitFor(`document.querySelector('.cm-pop').innerText.includes("Anna's reply")`, "Anna's reply appears");
    t.ok(await t.ev(`!document.querySelector('${pin}').classList.contains('unread')`), "own reply stays read");

    const openMenu = async () => {
      const p = await pinOf(t, id);
      const where = { x: p.x + p.w / 2, y: p.y + p.h / 2, button: "right" };
      await t.page.send("Input.dispatchMouseEvent", { ...where, type: "mousePressed", buttons: 2, clickCount: 1 });
      await t.page.send("Input.dispatchMouseEvent", { ...where, type: "mouseReleased", buttons: 0, clickCount: 1 });
      await t.waitFor("!!document.querySelector('.cm-pin-menu')", "the pin menu");
    };
    const choose = (label: string) => t.ev(`[...document.querySelectorAll('.cm-pin-menu button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    await t.ev(`document.querySelector('.cm-sidebar-head [aria-label="Close"]').click()`);
    await t.io.key("Escape");
    await openMenu();
    t.eq(await t.ev(`[...document.querySelectorAll('.cm-pin-menu button')].map(b => b.textContent)`),
      ["Reply", "Resolve", "Mark as Unread", "Copy Text", "Delete Thread"], "pin menu labels");
    await t.ev(`navigator.clipboard.writeText = async (text) => { window.copiedComment = text; }`);
    await choose("Copy Text");
    t.eq(await t.ev("window.copiedComment"), "Ben's note\n\nAnna's reply", "copy includes the live messages");
    await openMenu();
    await choose("Resolve");
    await until(t, () => !!file(t).threads.find((item: { id: string }) => item.id === id).resolvedAt, "resolved from the pin menu");
    await t.waitFor(`!document.querySelector('${pin}')`, "resolved pin is hidden");
    await t.ev(`document.querySelector('.cv-btn').click(); document.querySelector('.cm-show-resolved').click()`);
    await t.waitFor(`!!document.querySelector('${pin}.resolved')`, "resolved pin is visible");
    t.eq(await t.ev(`document.querySelector('.cm-show-resolved').textContent`), "Hide 1 resolved", "the footer toggled");
    await t.ev(`document.querySelector('.cm-show-resolved').click()`);
    await t.waitFor(`!document.querySelector('${pin}')`, "Hide resolved removes the pin again");
    await t.ev(`document.querySelector('.cm-show-resolved').click(); document.querySelector('.cm-sidebar-head [aria-label="Close"]').click()`);
    await t.waitFor(`document.querySelector('${pin}')?.offsetWidth > 0`, "the resolved pin is positioned again");
    await openMenu();
    await choose("Reopen");
    await until(t, () => !file(t).threads.find((item: { id: string }) => item.id === id).resolvedAt, "reopened from the pin menu");
    await t.waitFor(`!document.querySelector('${pin}')?.classList.contains('resolved')`, "reopened pin is updated");
    await openMenu();
    await choose("Mark as Unread");
    await t.waitFor(badge, "the Comments badge shows unread threads");
    await openMenu();
    await choose("Mark as Read");
    await t.waitFor(`!(${badge})`, "the pin menu clears unread");
    await openMenu();
    await choose("Mark as Unread");
    await t.waitFor(`document.querySelector('${pin}').classList.contains('unread')`, "the pin becomes unread again");
    await openMenu();
    await choose("Reply");
    await t.waitFor(`!document.querySelector('${pin}').classList.contains('unread') && document.activeElement === document.querySelector('.cm-pop textarea')`, "reply opens and reads the thread");
    await t.io.key("Escape");
    await openMenu();
    await choose("Mark as Unread");
    await t.waitFor(badge, "unread is saved");
    await t.open();
    await t.waitFor(badge, "the unread mark survives reload");
    await t.ev(`document.querySelector('.cv-btn').click()`);
    await t.waitFor(`!document.querySelector('.cm-read-all').hidden`, "Mark all as read is available");
    await t.ev(`document.querySelector('.cm-read-all').click()`);
    await t.waitFor(`!(${badge}) && document.querySelector('.cm-read-all').hidden`, "mark all clears the badge and the action");
    await t.open();
    await t.waitFor(`window.canvasHost.comments.threads.length === 2 && !(${badge})`, "read threads stay read after reload");
    await t.focus("lay_nest");
    await openMenu();
    await choose("Delete Thread");
    t.ok(!file(t).threads.find((item: { id: string }) => item.id === id).deletedAt, "delete waits for confirmation");
    await choose("Cancel");
    await openMenu();
    await choose("Delete Thread");
    await choose("Delete Thread");
    await until(t, () => !!file(t).threads.find((item: { id: string }) => item.id === id).deletedAt, "confirmed deletion");
    t.ok(!("unread" in file(t)), "read marks stay outside the shared comments file");
  } finally {
    await t.ev("localStorage.removeItem('canvas:comments:showResolved')").catch(() => {});
    await name("").catch(() => {});
    shell.abort();
  }
});

sc("comments", "The sidebar lists comment threads and agent conversations together", {
  covers: ["comments:unread", "comments:show-resolved", "conversations:list", "conversations:open-row"],
  skip: { visual: "The populated sidebar has a dedicated screenshot in qa/out.", undo: "Agent runs are seeded directly in the saved file." },
}, async (t: T) => {
  const doc = crypto.randomUUID(), now = Date.now();
  const anna = { name: "Anna" }, ben = { name: "Ben" }, agent = { name: "Agent", agent: true };
  const makeThread = (author: { name: string }, body: string, minutes: number, resolved = false) => {
    const id = crypto.randomUUID(), at = new Date(now - minutes * 60_000).toISOString();
    return {
      id, doc, anchor: { nodeId: "r_free", board: "lay_nest", x: .5, y: .5, preview: { name: "Free rect" } },
      createdBy: author, createdAt: at,
      ...(resolved ? { resolvedAt: at, resolvedBy: author } : {}),
      comments: [{ id: crypto.randomUUID(), thread: id, author, createdAt: at, body }],
    };
  };
  const newest = makeThread(ben, "Can we give the heading a little more space?", 5);
  const older = makeThread(agent, "I checked how this layout wraps at narrower widths.", 18);
  const open = makeThread(anna, "Keep the card labels aligned.", 48);
  open.comments.push({ id: crypto.randomUUID(), thread: open.id, author: ben, createdAt: new Date(now - 30 * 60_000).toISOString(), body: "Aligned with the header now." });
  const resolved = makeThread(ben, "Use the same blue on both cards.", 90, true);
  fs.writeFileSync(path.join(t.file, "comments.json"), JSON.stringify({ format: 1, doc, seq: 5, outbox: [], threads: [older, open, newest, resolved] }));

  const widgetsFile = path.join(t.file, "widgets.json");
  const widgets = JSON.parse(fs.readFileSync(widgetsFile, "utf8"));
  widgets.threads = [{
    key: "lay_nest", ids: ["lay_nest"], name: "Nest", harness: "codex", createdAt: now - 120_000, updatedAt: now - 115_000,
    runs: [{ id: "review-spacing", prompt: "Review the spacing between the cards", at: now - 120_000, endedAt: now - 115_000, status: "done", steps: [] }],
  }];
  fs.writeFileSync(widgetsFile, JSON.stringify(widgets));

  const headers = { "x-canvas": "1", "content-type": "application/json" };
  const read = (payload: object) => fetch(t.srv.base + "/api/comments/read?file=" + encodeURIComponent(t.file), { method: "POST", headers, body: JSON.stringify(payload) });
  t.eq((await read({})).status, 200, "start with everything read");
  for (const thread of [newest, older]) t.eq((await read({ thread: thread.id, unread: true })).status, 200, "mark the thread unread");

  await t.open();
  await t.focus("lay_nest");
  await t.waitFor(`document.querySelector('.cv-btn')?.getAttribute('aria-label') === 'Comments, 2 unread'`, "the toolbar unread count");
  await t.ev(`document.querySelector('.cv-btn').click()`);
  await t.waitFor(`!!document.querySelector('.cm-sidebar:not([hidden]) .cv-row')`, "the conversation in the Comments sidebar");
  t.eq(await t.ev(`document.querySelectorAll('.right-sidebar:not([hidden])').length`), 1, "one visible sidebar");
  t.ok(await t.ev(`!document.querySelector('.cm-bar')`), "no floating comments toolbar");
  await t.ev(`document.querySelector('.cm-show-resolved').click()`);
  t.eq(await t.ev(`[...document.querySelectorAll('.cm-sidebar h3')].map(h => [h.textContent, h.parentElement.querySelectorAll('.right-sidebar-row').length])`),
    [["Unread", 2], ["Open", 1], ["Resolved", 1], ["Conversations", 1]], "sections and counts");
  t.eq(await t.ev(`[...document.querySelectorAll('.cm-thread-row.unread')].map(r => r.dataset.thread)`),
    [newest.id, older.id], "unread threads are newest first");
  t.eq(await t.ev(`document.querySelector('.cm-thread-row[data-thread="${open.id}"] .cm-thread-meta').textContent`),
    "1 reply, Free rect", "reply count and layer");
  t.ok(await t.ev(`!!document.querySelector('.cm-thread-row[data-thread="${older.id}"] .cm-agent')`), "agent avatar");
  t.eq(await t.ev(`document.querySelector('.cv-row .cv-prompt').textContent`), "Review the spacing between the cards", "conversation prompt");
  t.ok(await t.ev(`document.querySelector('.cm-read-all .cm-t').getBoundingClientRect().height < 16`), "Mark all as read fits on one line");
  await t.ev("document.getElementById('rev').style.visibility = 'hidden'");
  await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
  await t.frames(3);
  await shot(t, "comments-sidebar");
  await t.ev("document.querySelector('.cv-row').click()");
  await t.waitFor("window.canvasHost.spark?.state.open && window.canvasHost.spark.state.ids.includes('lay_nest')", "the conversation opens on its layer");
  await t.ev("window.canvasHost.spark.close()");
  await t.open();
  await t.ev(`window.canvasCmd({cmd:"commentsSidebar",open:true})`);
  await t.waitFor(`document.querySelector('.cm-show-resolved')?.textContent === 'Hide 1 resolved' && !!document.querySelector('.cm-pin.resolved')`,
    "the footer setting and resolved pin survive reload");
  await t.ev(`document.querySelector('.cm-show-resolved').click(); window.canvasCmd({cmd:"commentsSidebar",open:false})`);
});
