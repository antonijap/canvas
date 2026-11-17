// QA for a shared file's comments (src/page/comments.js, src/cloud-sync.ts): the bar with the people who commented, the
// server's name and a dot; a pending comment waits with a clock; a refused one says why with Retry and Discard. The sync
// state is stood in for here (the page reads it from GET /api/comments); the real server is run by qa/cloud-e2e.ts.
// Pictures go to qa/out/comments-shared-*.png and comments-pending-*.png.
import fs from "node:fs";
import path from "node:path";
import { sc, type Rect, type T } from "./harness.ts";
import { ROOT } from "./lib.ts";

const OUT = path.join(ROOT, "qa", "out");
async function shot(t: T, name: string, clip?: Rect) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), await t.shot(clip ? { x: clip.x, y: clip.y, width: clip.w, height: clip.h } : undefined));
}

sc("comments", "a shared file shows the bar (people, server, a dot), a pending comment waits with a clock, a refused one says why", { covers: ["comments:shared-bar", "comments:pending", "comments:rejected"] }, async (t: T) => {
  await t.focus("lay_nest");
  const uid = () => crypto.randomUUID();
  const doc = uid(), th = uid();
  const [anna, ben, mia] = [{ email: "anna@studio.test", name: "Antonija" }, { email: "ben@studio.test", name: "Ben" }, { email: "mia@studio.test", name: "Mia" }];
  const c = (author: object, body: string, min: number) => ({ id: uid(), thread: th, author, body, createdAt: new Date(Date.now() - min * 60_000).toISOString() });
  const comments = [c(anna, "Can this feel less loud? Maybe the outline style from the Free card.", 120), c(ben, "Agree. Outline, but keep the blue text so it still reads as the main action.", 60), c(anna, "Let's try it. Ben, can you check it next to the Free card?", 0), c(mia, "A reply the server refused because the thread was locked", 0)];
  const thread = { id: th, doc, anchor: { nodeId: "r_free", x: 0.5, y: 0.5, board: "lay_nest", preview: { name: "Free rect", type: "rectangle" } }, createdAt: comments[0].createdAt, createdBy: anna, comments };
  fs.writeFileSync(path.join(t.file, "comments.json"), JSON.stringify({ format: 1, doc, seq: 3, threads: [thread], outbox: [] }));
  await t.open();
  await t.focus("lay_nest");
  const stub = (status: string, connected: boolean) => t.ev(`(() => {
    if (!window.__origFetch) { window.__origFetch = window.fetch; window.fetch = async (u, o) => { const r = await window.__origFetch(u, o); if (typeof u === "string" && u.startsWith("/api/comments?file=") && window.__sync) { const j = await r.json(); j.sync = window.__sync; return new Response(JSON.stringify(j), { headers: { "content-type": "application/json" } }); } return r; }; }
    window.__sync = { url: "https://studio-canvas.workers.dev", host: "studio-canvas.workers.dev", status: ${JSON.stringify(status)}, connected: ${connected}, pending: [{ opId: ${JSON.stringify(uid())}, kind: "comment.add", thread: ${JSON.stringify(th)}, comment: ${JSON.stringify(comments[2].id)} }], rejected: [{ opId: ${JSON.stringify(uid())}, kind: "comment.add", thread: ${JSON.stringify(th)}, comment: ${JSON.stringify(comments[3].id)}, code: "forbidden", message: "This role cannot apply the op" }] };
    return window.canvasHost.comments.reload();
  })()`);
  const openThread = async () => {
    const p = await t.ev<{ x: number; y: number }>(`(() => { const r = document.querySelector(".cm-pin").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await t.io.click(p.x, p.y);
    await t.waitFor(`!!document.querySelector(".cm-pop:not([hidden]) .cm-field")`, "the thread");
  };
  for (const theme of ["light", "dark"]) {
    await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
    await stub("offline", false);
    await t.waitFor(`document.querySelector(".cm-shared")?.classList.contains("on")`, "the shared bar");
    await t.frames(3);
    const bar = await t.ev<any>(`(() => {
      const q = (s, r = document) => r.querySelector(s), box = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
      const bar = q(".cm-shared"), view = document.getElementById("view").getBoundingClientRect();
      return { bar: box(bar), avatars: [...bar.querySelectorAll(".cm-av")].map(box), dot: box(q(".cm-dot")), host: box(q(".cm-server span:last-child")), text: bar.innerText, view: { r: view.right, t: view.top }, title: q(".cm-server").title };
    })()`);
    t.eq(bar.text.replace(/\s+/g, " ").trim(), "A B M studio-canvas.workers.dev", `the bar names the people who commented and the server (${theme})`);
    t.eq(bar.bar.h, 36, "the bar is 36 px high");
    t.eq(bar.avatars.map((a: any) => [a.w, a.h]), [[24, 24], [24, 24], [24, 24]], "avatars are 24 px");
    t.near(bar.avatars[1].x - (bar.avatars[0].x + 24), -6, 0.6, "avatars overlap by 6 px");
    t.near(bar.bar.x + bar.bar.w, bar.view.r - 12, 1, "the bar sits 12 px from the right edge");
    const islands = await t.ev<number>(`Math.max(...[...document.querySelectorAll(".island")].map((e) => e.getBoundingClientRect().bottom))`);
    t.ok(bar.bar.y >= islands + 8 - 1, "and under the toolbar island, not over it");
    t.eq([bar.dot.w, bar.dot.h], [7, 7], "the dot is 7 px");
    t.near(bar.dot.cy, bar.bar.cy, 0.6, "the dot is centred in the bar");
    t.near(bar.host.cy, bar.bar.cy, 1, "the server name is centred in the bar");
    t.near(bar.avatars[0].cy, bar.bar.cy, 0.6, "the avatars are centred in the bar");
    t.near(bar.dot.x - (bar.avatars[2].x + 24), 10, 0.6, "10 px between the people and the server");
    t.ok(/Offline/.test(bar.title), "the dot's tooltip says Offline");
    await shot(t, `comments-shared-offline-${theme}`, { x: bar.view.r - 340, y: bar.view.t, w: 340, h: bar.bar.y + 48 - bar.view.t });
    for (const [status, connected, want] of [["connected", true, "rgb(22, 163, 74)"], ["signInAgain", false, "rgb(217, 119, 6)"]] as const) {
      await stub(status, connected);
      await t.waitFor(`document.querySelector(".cm-shared")?.dataset.status === ${JSON.stringify(status)}`, `status ${status}`);
      t.eq(await t.ev(`getComputedStyle(document.querySelector(".cm-dot")).backgroundColor`), want, `the dot for ${status}`);
      if (status === "connected") await shot(t, `comments-shared-connected-${theme}`, { x: bar.view.r - 340, y: bar.view.t, w: 340, h: bar.bar.y + 48 - bar.view.t });
    }
    await stub("offline", false);
    await openThread();
    const card = await t.ev<any>(`(() => {
      const items = [...document.querySelectorAll(".cm-pop .cm-item")];
      const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
      const st = items[2].querySelector(".cm-state"), who = items[2].querySelector(".cm-who");
      const fail = items[3].querySelector(".cm-fail"), btns = [...fail.querySelectorAll("button")];
      return { text: st.innerText, hasTime: !!items[2].querySelector("time"), st: box(st), icon: box(st.querySelector("svg")), name: box(who.querySelector("b")), failText: fail.innerText.replace(/\\s+/g, " "), btns: btns.map((b) => [b.innerText, box(b).h]) };
    })()`);
    t.eq(card.text, "Sends when you're back online", "a pending comment says it sends when you are back online");
    t.eq(card.hasTime, false, "the clock stands where the time would be");
    t.near(card.icon.cy, card.st.cy, 0.6, "the clock is centred on its text");
    t.near(card.st.cy, card.name.cy, 1, "the state is on the name's line");
    t.ok(card.failText.startsWith("Not sent: This role cannot apply the op"), "a refused comment says why");
    t.eq(card.btns.map((b: any) => b[0]), ["Retry", "Discard"], "with Retry and Discard");
    t.eq(card.btns.map((b: any) => b[1]), [20, 20], "the two buttons share one height");
    await shot(t, `comments-pending-${theme}`);
    await stub("connected", true);
    await t.waitFor(`/Sending/.test(document.querySelector(".cm-pop .cm-state")?.innerText || "")`, "Sending while connected");
    await t.io.key("Escape");
  }
  await t.ev(`delete window.__sync`);
  await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" }] });
});
