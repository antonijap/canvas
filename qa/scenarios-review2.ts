// QA scenarios for the second review's fixes (docs/evidence/review-fixes-2.md): Shift+Cmd+X strikes text through
// without cutting the layer, Enter leaves locked children out, and canvas keys leave a locked layer where it is.
import fs from "node:fs";
import path from "node:path";
import { sc, type T } from "./harness.ts";
import { ROOT, sleep } from "./lib.ts";

const until = async (t: T, ok: () => boolean, what: string) => {
  for (let i = 0; i < 60; i++) { await t.flush(); if (ok()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
};
/** Past structure.js's 120 ms clipboard fallback, and whatever it would have written. */
const pastClipFallback = async (t: T) => { await sleep(500); await t.flush(); };
const lock = (t: T, ids: string[]) => t.a.post("/api/update", { file: t.file, ids, props: { locked: true } });
/** What the Layers panel does when a row is clicked: the page selects the layer, locked or not. */
const panelSelect = async (t: T, ids: string[]) => {
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "layers", op: "select", ids: ${JSON.stringify(ids)} })`);
  await t.frames(3);
  t.eq(await t.sel(), ids, "the panel selects the locked layer");
};
/** A picture for docs/evidence: the board cropped from the view (qa/out/evidence/<name>.png). */
const shot = async (t: T, name: string, board: string) => {
  const r = await t.rect(board);
  fs.mkdirSync(path.join(ROOT, "qa", "out", "evidence"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "qa", "out", "evidence", name + ".png"), await t.shot({ x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.w + 20, height: r.h + 20 }));
};
const geometry =(n: any) => JSON.stringify({ x: n?.x, y: n?.y, width: n?.width, height: n?.height, rotation: n?.rotation, flipX: n?.flipX, flipY: n?.flipY });

sc("clipboard", "Shift+Cmd+X and Ctrl+Shift+X strike text through and keep the layer; Cmd+X cuts and Shift+Cmd+V pastes in place", { covers: ["text-style-keys:text", "text-style-keys:keyboard", "copy-paste:text", "copy-paste:keyboard"] }, async (t: T) => {
  await t.focus("lay_text");
  await t.select(["tx_auto"]);
  await t.io.key("x", { meta: true, shift: true });
  await until(t, () => t.node("tx_auto")?.strikethrough === true, "Shift+Cmd+X to strike the text through");
  await pastClipFallback(t);
  t.ok(t.node("tx_auto"), "Shift+Cmd+X cut the layer it struck through");
  t.eq(await t.sel(), ["tx_auto"], "the text stays selected");
  await t.settle();
  await shot(t, "review2-strike-no-cut", "lay_text");
  // Ctrl+Shift+X (the key off a Mac) takes the strike off again, and cuts nothing either.
  await t.io.key("x", { ctrl: true, shift: true });
  await until(t, () => t.node("tx_auto")?.strikethrough !== true, "Ctrl+Shift+X to take the strike off");
  await pastClipFallback(t);
  t.ok(t.node("tx_auto"), "Ctrl+Shift+X cut the layer");
  // Plain Cmd+X still cuts; Shift+Cmd+V puts it back where it was.
  const was = t.node("tx_fixed")!;
  await t.select(["tx_fixed"]);
  await t.io.key("x", { meta: true });
  await until(t, () => !t.node("tx_fixed"), "Cmd+X to cut the layer");
  await t.select(["lay_text"]);
  await t.io.key("v", { meta: true, shift: true });
  const back = () => (t.disk().children.find((b: any) => b.id === "lay_text")!.children as any[]).find((n) => n.name === "Fixed size");
  await until(t, () => !!back(), "Shift+Cmd+V to paste the cut layer");
  t.eq([back().x, back().y], [was.x, was.y], "pasted in place");
  t.subject = ["lay_text"];
});

sc("select", "Enter selects a group's children but not the locked ones", { covers: ["select-keys:keyboard", "select-keys:one", "lock:rectangle", "lock:keyboard"] }, async (t: T) => {
  await t.focus("lay_nest");
  await lock(t, ["r_g1"]);
  await until(t, () => t.node("r_g1")?.locked === true, "r_g1 locked on disk");
  await t.settle();
  await t.select(["g_pair"]);
  await t.io.key("Enter");
  await t.frames(4);
  await sleep(200);
  t.eq(await t.sel(), ["r_g2"], "Enter selects the unlocked child only");
  await shot(t, "review2-enter-skips-locked", "lay_nest");
  // Every child locked: Enter keeps the group selected.
  await lock(t, ["r_g2"]);
  await until(t, () => t.node("r_g2")?.locked === true, "r_g2 locked on disk");
  await t.settle();
  await t.select(["g_pair"]);
  await t.io.key("Enter");
  await t.frames(4);
  await sleep(200);
  t.eq(await t.sel(), ["g_pair"], "nothing to go into: the group stays selected");
  t.subject = ["lay_nest"];
});

sc("text", "typing in a 400k-character text layer: each key's handler and the frame after it", { covers: ["text-edit:text", "text-edit:keyboard", "text-edit:large"], skip: { reopen: "the board holding the 400k-character text is still grey (laying out) when the check takes its pictures", visual: "the same: the end state is a board still laying out a 400k-character text" } }, async (t: T) => {
  await t.focus("lay_text");
  const words = "Canvas lays out long text the same way the field does, line by line, ";
  const content = words.repeat(Math.ceil(400_000 / words.length)).slice(0, 400_000);
  await t.a.post("/api/structure", { file: t.file, op: "add", nodes: [{ type: "text", id: "tx_huge", name: "Huge", x: 24, y: 330, width: 500, textGrowth: "fixed-width", content, fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#18181B" }], place: { parent: "lay_text" } });
  await until(t, () => !!t.node("tx_huge"), "the huge text on disk");
  await t.settle();
  await t.select(["tx_huge"]);
  await t.io.key("Enter");
  await t.waitFor("!!(window.canvasHost.textEdit && window.canvasHost.textEdit.active)", "the edit to open", 20_000);
  await t.ev("window.canvasHost.textEdit.select(200000, 200000)");
  await t.frames(4);
  // Handler: the field's beforeinput (edit, render, select, the canvas pin), from a capture listener on the document
  // to a bubble listener on the window. Frame: from the key's beforeinput to the next animation frame.
  await t.ev(`(() => { window.__fieldText = document.querySelector("#textEdit .f").firstChild.firstChild; const L = (window.__typing = { h: [], f: [] }); let t0 = 0;
    document.addEventListener("beforeinput", () => { t0 = performance.now(); }, true);
    addEventListener("beforeinput", () => { const t1 = performance.now(); L.h.push(t1 - t0); requestAnimationFrame(() => L.f.push(performance.now() - t0)); }); })()`);
  await t.io.type("abcdefghijklmnopqrstuvwxyz");
  await t.frames(4);
  const m = await t.ev<{ h: number[]; f: number[] }>("window.__typing");
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  t.ok(m.h.length >= 20, `the keys reached the field (${m.h.length})`);
  t.note(`400k text, ${m.h.length} keys: handler median ${med(m.h).toFixed(1)} ms (max ${Math.max(...m.h).toFixed(1)}), key to frame median ${med(m.f).toFixed(1)} ms (max ${Math.max(...m.f).toFixed(1)})`);
  console.log(t.notes.at(-1));
  t.eq((await t.ev<string>("window.canvasHost.textEdit.value")).slice(200000, 200026), "abcdefghijklmnopqrstuvwxyz", "the typing is in the field's model");
  // The keys changed the field's text in place (src/page/text-patch.js): the same text node, showing the model.
  t.ok(await t.ev<boolean>(`document.querySelector("#textEdit .f").firstChild.firstChild === window.__fieldText`), "a key built the field again instead of changing it in place");
  t.ok(await t.ev<boolean>(`document.querySelector("#textEdit .f").textContent === window.canvasHost.textEdit.value`), "the field shows the model's text");
  // A new line at the end gives the field its end mark (the caret's last line), and Backspace takes it away again.
  const n = await t.ev<number>("window.canvasHost.textEdit.value.length");
  await t.ev(`window.canvasHost.textEdit.select(${n}, ${n})`);
  await t.io.key("Enter");
  await t.frames(2);
  t.ok(await t.ev<boolean>(`(() => { const f = document.querySelector("#textEdit .f"); return window.canvasHost.textEdit.value.endsWith("\\n") && f.lastChild.nodeName === "BR" && f.firstChild.firstChild === window.__fieldText; })()`), "Return at the end adds the end mark in place");
  await t.io.key("Backspace");
  await t.frames(2);
  t.ok(await t.ev<boolean>(`(() => { const f = document.querySelector("#textEdit .f"); return !window.canvasHost.textEdit.value.endsWith("\\n") && f.lastChild.nodeName === "SPAN" && f.textContent === window.canvasHost.textEdit.value; })()`), "Backspace takes the end mark away");
  await t.io.key("Escape");
  t.subject = ["lay_text"];
});

sc("lock", "canvas keys leave a locked layer selected in the Layers panel where it is; the inspector still edits it", { covers: ["lock:rectangle", "lock:keyboard", "lock:board", "lock:canvas-keys", "nudge:keyboard", "align-distribute:keyboard"] }, async (t: T) => {
  await t.focus("lay_nest");
  await lock(t, ["r_free"]);
  await until(t, () => t.node("r_free")?.locked === true, "r_free locked on disk");
  await t.settle();
  await panelSelect(t, ["r_free"]);
  const before = geometry(t.node("r_free"));
  const keys: [string, Record<string, boolean>, string][] = [
    ["ArrowRight", {}, "ArrowRight (nudge)"], ["ArrowDown", { shift: true }, "Shift+ArrowDown (big nudge)"],
    ["ArrowRight", { meta: true }, "Cmd+ArrowRight (resize)"], ["ArrowUp", { meta: true, alt: true }, "Option+Cmd+ArrowUp (rotate)"],
    ["h", { shift: true }, "Shift+H (flip)"], ["v", { shift: true }, "Shift+V (flip)"],
    ["a", { alt: true }, "Option+A (align left)"], ["s", { alt: true }, "Option+S (align bottom)"],
  ];
  for (const [k, mods, what] of keys) {
    await t.io.key(k, mods);
    await sleep(250);
    await t.flush();
    t.eq(geometry(t.node("r_free")), before, `${what} changed the locked layer`);
    t.eq(await t.sel(), ["r_free"], `${what} kept the selection`);
  }
  // With an unlocked layer in the selection, arrows and align move that one only; the locked one stays.
  await panelSelect(t, ["r_free", "r_n3"]);
  const n3 = t.node("r_n3")!.x as number, g0 = t.node("g_outer")!.x as number;
  await t.io.key("ArrowRight");
  await until(t, () => (t.node("r_n3")!.x as number) + (t.node("g_outer")!.x as number) === n3 + g0 + 1, "the unlocked layer to move 1 px");
  t.eq(geometry(t.node("r_free")), before, "ArrowRight with two selected moved the locked one");
  // Tidy (Control+Option+T): the locked one stays where it is.
  await t.io.key("t", { ctrl: true, alt: true });
  await sleep(500);
  await t.flush();
  t.eq(geometry(t.node("r_free")), before, "Tidy up moved the locked layer");
  // A locked board: arrows do not move it either.
  await lock(t, ["lay_clip"]);
  await until(t, () => t.node("lay_clip")?.locked === true, "lay_clip locked on disk");
  await t.settle();
  const b0 = geometry(t.node("lay_clip"));
  await panelSelect(t, ["lay_clip"]);
  await t.io.key("ArrowLeft", { shift: true });
  await sleep(300);
  await t.flush();
  t.eq(geometry(t.node("lay_clip")), b0, "Shift+ArrowLeft moved the locked board");
  // The inspector (properties stay editable) still moves it: a typed X.
  await t.a.post("/api/update", { file: t.file, id: "r_free", props: { x: 310 } });
  await until(t, () => t.node("r_free")!.x === 310, "the inspector's X to apply");
  await panelSelect(t, ["r_free"]);
  await shot(t, "review2-locked-keys", "lay_nest");
  t.subject = ["lay_nest"];
});
