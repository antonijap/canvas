// Optical alignment of the comments UI (src/page/comments.js), measured, light and dark.
//
// Icons are measured from a 2x capture (qa/ink.ts): an icon sits in the middle of its control by its visible
// shape, not by its 14 px box. Text is measured from its pixels and its font: the baseline where the letters end,
// then the middle of a capital (or of an x for a lowercase-only label like "esc") above it. A label is centred when
// that middle is on its control's centre line; a row lines up when its icons' middles and its text's cap middles
// agree. Tolerance: half a point (one device pixel at 2x), three quarters for where text lands.
// Every measurement goes to qa/out/alignment/page.jsonl, and each control's crop to qa/out/alignment/page-*.png.
import fs from "node:fs";
import path from "node:path";
import { decodePng, type Img } from "../fidelity/png.ts";
import { H, W, sc, type T } from "./harness.ts";
import { sleep } from "./lib.ts";
import { AlignChecker, ALIGN_OUT, bare, cy, midX, midY } from "./ink.ts";
import { measureJs, resolve as resolveAt } from "./ink-page.ts";

const K = 2;

/** The page at 2x, a capture of the whole view. */
async function grab(t: T): Promise<Img> {
  await t.page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: K, mobile: false });
  await t.frames(3);
  const r = await t.page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const img = decodePng(Buffer.from(r.data, "base64"));
  if (img.width !== W * K) throw new Error(`the capture is ${img.width} px wide, not ${W * K}`);
  return img;
}

const measure = (t: T, want: Record<string, string>): Promise<Record<string, any>> => t.ev(measureJs(want));
const resolve = (img: Img, m: Record<string, any>) => resolveAt(img, m, K);

const theme = (t: T, s: string) => t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: s }] });

sc("comments", "alignment: every comment control is optically centred, light and dark", { covers: ["comments:alignment", "comments:light", "comments:dark"] }, async (t: T) => {
  fs.rmSync(path.join(ALIGN_OUT, "page.jsonl"), { force: true });
  const uid = () => crypto.randomUUID();
  const doc = uid(), A = uid(), B = uid(), C = uid();
  const [anna, ben] = [{ email: "anna@studio.test", name: "Anna" }, { email: "ben@studio.test", name: "Ben" }];
  const c = (th: string, author: object, body: string, min: number) => ({ id: uid(), thread: th, author, body, createdAt: new Date(Date.now() - min * 60_000).toISOString() });
  const ta = [c(A, anna, "Can this feel less loud?", 120), c(A, ben, "Agree. Outline, but keep the blue text.", 60), c(A, { name: "Claude Code" }, "Tried it on a variation.", 1), c(A, anna, "Let's try it.", 0), c(A, ben, "A reply the server refused", 0)];
  const threads = [
    { id: A, doc, anchor: { nodeId: "r_free", x: 0.5, y: 0.5, board: "lay_nest", preview: { name: "Free rect", type: "rectangle" } }, createdAt: ta[0].createdAt, createdBy: anna, comments: ta },
    { id: B, doc, anchor: { nodeId: "r_free", x: 0.9, y: 0.2, board: "lay_nest" }, createdAt: ta[0].createdAt, createdBy: ben, resolvedAt: new Date().toISOString(), resolvedBy: ben, comments: [c(B, ben, "Done", 30)] },
    { id: C, doc, anchor: { nodeId: "zz_deleted", x: 0.5, y: 0.5, board: "lay_nest", preview: { name: "Old badge", type: "frame", width: 80, height: 24 } }, createdAt: ta[0].createdAt, createdBy: anna, comments: [c(C, anna, "Where did this go?", 10)] },
  ];
  fs.writeFileSync(path.join(t.file, "comments.json"), JSON.stringify({ format: 1, doc, seq: 3, threads, outbox: [] }));
  await t.open();
  await t.focus("lay_nest");
  await t.clearSel();
  // A shared file: pending and refused comments, the bar with people and the server.
  await t.ev(`(() => {
    window.__origFetch = window.fetch; window.fetch = async (u, o) => { const r = await window.__origFetch(u, o); if (typeof u === "string" && u.startsWith("/api/comments?file=") && window.__sync) { const j = await r.json(); j.sync = window.__sync; return new Response(JSON.stringify(j), { headers: { "content-type": "application/json" } }); } return r; };
    window.__sync = { url: "https://studio-canvas.workers.dev", host: "studio-canvas.workers.dev", role: "viewer", status: "connected", connected: false, pending: [{ opId: "p1", kind: "comment.add", thread: ${JSON.stringify(A)}, comment: ${JSON.stringify(ta[3].id)} }], rejected: [{ opId: "r1", kind: "comment.add", thread: ${JSON.stringify(A)}, comment: ${JSON.stringify(ta[4].id)}, code: "forbidden", message: "x" }] };
    return window.canvasHost.comments.reload(); })()`);
  await t.waitFor(`document.querySelector(".cm-shared")?.classList.contains("on") && document.querySelectorAll(".cm-pin").length >= 2`, "the shared bar and the pins");
  await t.waitFor(`document.querySelector('.cm-pin[data-thread="${C}"]')?.classList.contains("gone")`, "the deleted layer's pin");
  // No caret in a focused field: it is ink a measurement would count.
  await t.ev(`document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ".cm-field{caret-color:transparent!important}" }))`);
  const pin = (id: string) => `.cm-pin[data-thread="${id}"]`;
  const bad: string[] = [];
  for (const th of ["light", "dark"]) {
    await theme(t, th);
    // ---- the count bar, the shared bar, the pins
    await sleep(400); // colours ease to the new theme
    let img = await grab(t);
    let m = resolve(img, await measure(t, {
      bar: "b:.cm-bar", barIcon: "b:.cm-bar > span:first-child svg", barText: "t:.cm-bar > span:nth-child(2)", show: "b:.cm-bar .cm-btn", showT: "t:.cm-bar .cm-btn",
      shared: "b:.cm-shared", av: "b:.cm-shared .cm-av:last-child", avT: "t:.cm-shared .cm-av:last-child",
      pin: `b:${pin(A)}`, pinAv: `b:${pin(A)} .cm-av`, pinAvT: `t:${pin(A)} .cm-av`, gonePin: `b:${pin(C)}`, gonePinT: `t:${pin(C)}`,
    }));
    let k = new AlignChecker("page", th, img, K);
    k.label("bar-show-resolved", m.show, m.showT);
    const barIcon = k.ink("bar-icon", bare(m.barIcon), { inset: 0 });
    k.near("count bar: the bubble's middle on the bar's centre line", midY(barIcon), cy(m.bar));
    k.near("count bar: the count's cap middle on the bar's centre line", m.barText?.cap, cy(m.bar));
    k.label("shared-avatar", m.av, m.avT, { inset: 1.5 });
    k.near("shared bar: avatar on the toolbar center line", cy(m.av), cy(m.shared));
    k.label("pin-avatar", m.pinAv, m.pinAvT, { inset: 1.5 });
    k.near("pin: the avatar centred across the pin", m.pinAv && m.pinAv.x + m.pinAv.w / 2, m.pin && m.pin.x + m.pin.w / 2);
    k.near("pin: the avatar centred down the pin", cy(m.pinAv), cy(m.pin));
    k.label("pin-count", m.gonePin, m.gonePinT, { inset: 4 });
    bad.push(...k.bad);
    // ---- the thread card
    await t.ev(`document.querySelector('${pin(A)}').click()`);
    await t.waitFor(`!!document.querySelector(".cm-pop:not([hidden]) .cm-field")`, "the thread");
    img = await grab(t);
    m = resolve(img, await measure(t, {
      pop: "b:.cm-pop", openPin: `b:${pin(A)}`, openPinT: `t:${pin(A)}`,
      resolve: "b:.cm-item .cm-res", resolveIcon: "b:.cm-item .cm-res svg",
      av: "b:.cm-item .cm-av", avT: "t:.cm-item .cm-av", agent: "b:.cm-item .cm-agent", who: "t:.cm-item .cm-who b", time: "t:.cm-item .cm-who time",
      stIcon: "b:.cm-item .cm-state svg", stT: "t:.cm-item .cm-state", stWho: "t:.cm-item:nth-child(4) .cm-who b",
      retry: "b:.cm-fail .cm-btn", retryT: "t:.cm-fail .cm-btn", discard: "b:.cm-fail .cm-btn.dim", discardT: "t:.cm-fail .cm-btn.dim", failIcon: "b:.cm-fail .cm-state svg", failT: "t:.cm-fail .cm-state",
      field: "t:.cm-row .cm-field", send: "b:.cm-row .cm-send",
    }));
    k = new AlignChecker("page", th, img, K);
    k.label("open-pin-count", m.openPin, m.openPinT, { inset: 4 });
    const resolveIcon = k.ink("thread-resolve-icon", bare(m.resolveIcon), { inset: 0 });
    k.near("Resolve: the check's middle on the button's centre line", midY(resolveIcon), cy(m.resolve));
    k.near("Resolve: the button's centre line on the first name's cap middle", cy(m.resolve), m.who?.cap);
    k.label("thread-avatar", m.av, m.avT, { inset: 1.5 });
    k.icon("thread-agent", m.agent, { inset: 1.5 });
    k.near("comment: the name's cap middle on the avatar's centre line", m.who?.cap, cy(m.av));
    k.near("comment: the name and the time share a baseline", m.who?.base, m.time?.base);
    const stIcon = k.ink("pending-clock", bare(m.stIcon), { inset: 0 });
    k.near("pending: the clock's middle on the state's cap middle", midY(stIcon), m.stT?.cap);
    k.near("pending: the state and the name share a baseline", m.stT?.base, m.stWho?.base);
    k.label("refused-retry", m.retry, m.retryT);
    k.label("refused-discard", m.discard, m.discardT);
    const failIcon = k.ink("refused-alert", bare(m.failIcon), { inset: 0 });
    k.near("refused: the alert's middle on the first line's cap middle", midY(failIcon), m.failT?.cap);
    k.near("refused: Retry's centre line on the first line's cap middle", cy(m.retry), m.failT?.cap);
    k.icon("reply-send", m.send);
    k.near("reply: the field's cap middle on the send button's centre line", m.field?.cap, cy(m.send));
    if (m.pop && m.send) k.near("reply row: the send button as far from the card's right edge as from its bottom", m.pop.x + m.pop.w - (m.send.x + m.send.w), m.pop.y + m.pop.h - (m.send.y + m.send.h));
    bad.push(...k.bad);
    // ---- the deleted layer's band
    await t.io.key("Escape");
    await t.ev(`document.querySelector('${pin(C)}').click()`);
    await t.waitFor(`!!document.querySelector(".cm-pop:not([hidden]) .cm-gone")`, "the deleted layer's thread");
    img = await grab(t);
    m = resolve(img, await measure(t, {
      band: "b:.cm-gone", ghost: "b:.cm-gone .cm-ghost svg", title: "t:.cm-gone b", line: "t:.cm-gone .cm-gl",
      pinTo: "b:.cm-gone .cm-acts .cm-btn.txt", pinToT: "t:.cm-gone .cm-acts .cm-btn.txt",
    }));
    k = new AlignChecker("page", th, img, K);
    k.label("band-pin-to-a-layer", m.pinTo, m.pinToT);
    const ghost = k.ink("band-ghost", bare(m.ghost), { inset: 0 });
    k.near("band: the ghost's middle on the middle of the two lines (cap top to baseline)", midY(ghost), m.title && m.line ? (m.title.base - 2 * (m.title.base - m.title.cap) + m.line.base) / 2 : null);
    k.near("band: the ghost and the buttons share a left edge", ghost?.x0, m.pinTo?.x);
    bad.push(...k.bad);
    await t.io.key("Escape");
    // ---- comment mode: the hint and the composer
    await t.io.key("c");
    await t.waitFor(`document.querySelector(".cm-hint")?.classList.contains("on")`, "the hint");
    const r = await t.rect("r_free");
    await t.io.click(r.x + 10, r.y + r.h - 10);
    await t.waitFor(`!!document.querySelector(".cm-comp:not([hidden]) textarea")`, "the composer");
    img = await grab(t);
    m = resolve(img, await measure(t, {
      hint: "b:.cm-hint", hintIcon: "b:.cm-hint > span:first-child svg", hintB: "t:.cm-hint b", hintSoft: "t:.cm-hint .cm-soft", key: "b:.cm-hint .cm-key", keyT: "t:.cm-hint .cm-key",
      comp: "b:.cm-comp", compAv: "b:.cm-compfield .cm-av", compAvT: "t:.cm-compfield .cm-av", compField: "t:.cm-compfield .cm-field",
      chip: "b:.cm-foot .cm-chip", chipT: "t:.cm-foot .cm-chip span", chipIcon: "b:.cm-foot .cm-chip svg", retKey: "b:.cm-foot .cm-key", send: "b:.cm-foot .cm-send",
      draft: `b:${pin("draft")}`,
    }));
    k = new AlignChecker("page", th, img, K);
    const hintIcon = k.ink("hint-icon", bare(m.hintIcon), { inset: 0 });
    k.near("hint: the bubble's middle on the pill's centre line", midY(hintIcon), cy(m.hint));
    k.near("hint: Comment mode's cap middle on the pill's centre line", m.hintB?.cap, cy(m.hint));
    k.near("hint: the two texts share a baseline", m.hintB?.base, m.hintSoft?.base);
    k.label("hint-esc", m.key, m.keyT, { inset: 1, mid: "ex" });
    k.near("hint: the esc key on the pill's centre line", cy(m.key), cy(m.hint));
    if (m.hint && hintIcon && m.key) k.near("hint: as much room left of the bubble as right of the esc key", hintIcon.x0 - m.hint.x, m.hint.x + m.hint.w - (m.key.x + m.key.w));
    k.label("composer-avatar", m.compAv, m.compAvT, { inset: 1.5 });
    // The add pin's plus sits on the teardrop's centre of area: half a point toward the tip from the box's middle.
    const plus = m.draft ? k.ink("draft-pin-plus", { x: m.draft.x + 6, y: m.draft.y + 6, w: 16, h: 16, r: 0 }, { inset: 0 }) : (k.bad.push(`draft-pin-plus (${th}): not on screen`), null);
    k.near("add pin: the plus's middle on the teardrop's centre, x", midX(plus), m.draft ? m.draft.x + 13.5 : null);
    k.near("add pin: the plus's middle on the teardrop's centre, y", midY(plus), m.draft ? m.draft.y + 14.5 : null);
    k.near("composer: the field's cap middle on the avatar's centre line", m.compField?.cap, cy(m.compAv));
    k.icon("composer-return-key", m.retKey, { inset: 1 });
    k.icon("composer-send", m.send);
    k.label("composer-chip", m.chip, m.chipT);
    const cIcon = k.ink("composer-chip-icon", bare(m.chipIcon), { inset: 0 });
    k.near("composer chip: the icon's middle on the chip's centre line", midY(cIcon), cy(m.chip));
    bad.push(...k.bad);
    await t.io.key("Escape");
    await t.io.key("Escape");
  }
  await t.page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await theme(t, "dark");
  await t.ev(`delete window.__sync`);
  t.ok(!bad.length, `${bad.length} alignment problems:\n  ${bad.join("\n  ")}`);
});

sc("first-run", "alignment: the welcome card's Connect button, agent names, menu button and Connected dot, light and dark", { covers: ["first-run:alignment"], skip: { visual: "the commands name this checkout's folder (~/Code/canvas or a worktree), which differs per clone", reopen: "the live page's setup answer is stubbed (Codex registered); the reopened tab reads the scratch agent config, where nothing is registered" } }, async (t: T) => {
  const w = (await t.a.post("/api/widgets", { kind: "welcome", name: "Welcome", x: -600, y: 0, w: 400, h: 180 })).widget;
  t.subject = ["widget:" + w.id];
  // Both agents installed, Codex registered: Claude Code's row shows Connect, Codex's the dot and Connected.
  await t.ev(`(() => { const real = window.fetch.bind(window); window.fetch = async (u, o) => { const r = await real(u, o); if (!String(u).includes("/api/mcp/setup")) return r; const j = await r.json(); return new Response(JSON.stringify({ ...j, connected: false, temporary: false, installed: { claude: true, codex: true }, registered: { claude: false, codex: true } })); }; })()`);
  await t.look(-620, -20);
  await t.waitFor(`(() => { const b = document.querySelector('.wc .wc-row[data-agent=claude] .wc-btn'); return b && !b.hidden && !b.disabled && document.querySelector('.wc .wc-row[data-agent=codex] .wc-on').hidden === false; })()`, "Connect for Claude Code, Connected for Codex");
  const bad: string[] = [];
  for (const th of ["light", "dark"]) {
    await theme(t, th);
    await sleep(400);
    const img = await grab(t);
    const m = resolve(img, await measure(t, {
      connect: "b:.wc .wc-row[data-agent=claude] .wc-btn", connectT: "t:.wc .wc-row[data-agent=claude] .wc-btn", name: "t:.wc .wc-row[data-agent=claude] .wc-name",
      more: "b:.wc .wc-row[data-agent=claude] .wc-more", row: "b:.wc .wc-row[data-agent=claude]",
      dot: "b:.wc .wc-row[data-agent=codex] .wc-dot", on: "t:.wc .wc-row[data-agent=codex] .wc-on-t", name2: "t:.wc .wc-row[data-agent=codex] .wc-name",
    }));
    const k = new AlignChecker("page", th, img, K);
    k.label("welcome-connect", m.connect, m.connectT);
    k.near("welcome: Connect on the row's centre line", cy(m.connect), cy(m.row));
    k.near("welcome: the menu button on Connect's centre line", cy(m.more), cy(m.connect));
    k.near("welcome: the agent's name, cap middle on Connect's centre line", m.name?.cap, cy(m.connect));
    k.near("welcome: the dot's middle on Connected's cap middle", cy(m.dot), m.on?.cap);
    k.near("welcome: Connected's cap middle on the agent name's", m.on?.cap, m.name2?.cap);
    bad.push(...k.bad);
  }
  await t.page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await theme(t, "dark");
  t.ok(!bad.length, `${bad.length} alignment problems:\n  ${bad.join("\n  ")}`);
});
