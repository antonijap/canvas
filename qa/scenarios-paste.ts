// QA scenarios for the other pastes and image placement (src/page/structure.js, src/page/drops.js,
// src/structure.ts): Paste to replace (Shift+Cmd+R), plain text from another app, a paste into several frames, Space
// held while adding (keep the parent), Place Image (Shift+Cmd+K) and a payload from another app that names files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sc, type T } from "./harness.ts";
import { ROOT, gradientPng, sleep } from "./lib.ts";

const OUT = path.join(ROOT, "qa", "out", "evidence");
const snapshot = (t: T) => fs.readFileSync(path.join(t.file, "document.json"), "utf8");
/** One undo gives back exactly the document from before; redo brings the change back. */
async function oneUndoStep(t: T, before: string, what: string) {
  const after = snapshot(t);
  await t.undo();
  t.ok(snapshot(t) === before, `${what}: one undo restores document.json`);
  await t.redo();
  t.ok(snapshot(t) === after, `${what}: redo brings it back`);
}
/** A picture for docs/evidence: the view fitted to `ids`, selected, cropped to the canvas around them. */
async function evidence(t: T, name: string, ids: string[], pad = 140, full = false) {
  await t.select(ids);
  await t.ev(`window.canvasCmd({ cmd: "fit" })`);
  await t.settle();
  await sleep(300);
  await t.settle();
  fs.mkdirSync(OUT, { recursive: true });
  if (full) { fs.writeFileSync(path.join(OUT, `${name}.png`), await t.shot()); return; }
  const rs = await Promise.all(ids.map((id) => t.rect(id)));
  const x0 = Math.max(0, Math.min(...rs.map((r) => r.x)) - pad), y0 = Math.max(0, Math.min(...rs.map((r) => r.y)) - pad);
  const x1 = Math.min(1600, Math.max(...rs.map((r) => r.x + r.w)) + pad), y1 = Math.min(1000, Math.max(...rs.map((r) => r.y + r.h)) + pad);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), await t.shot({ x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) }));
}
/** Space held down (hand mode) around `fn`, as a person holds it while pasting or dropping. */
async function withSpace(t: T, fn: () => Promise<void>) {
  await t.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
  try {
    await t.waitFor("window.canvasHost.hand", "hand mode");
    await fn();
  } finally {
    await t.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  }
}
/** The browser's paste event carrying `text` as plain text (what another app leaves on the clipboard). */
const pasteText = (t: T, text: string) => t.ev(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(text)}); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
const copyNow = async (t: T, ids: string[]) => {
  await t.select(ids);
  await t.io.key("c", { meta: true });
  await t.waitFor(`fetch("/api/structure/clipboard").then((r) => r.json()).then((j) => !!j.payload && j.payload.nodes.map((n) => n.id).join() === ${JSON.stringify(ids.join())})`, "the copy");
};
const kids = (t: T, id: string) => (t.node(id)!.children ?? []).map((n: any) => n.id as string);

sc("paste", "Shift+Cmd+R swaps the selected layers for the copy, at their spots and indexes, one undo", { covers: ["paste-replace:keyboard", "paste-replace:rectangle", "paste-replace:many", "paste-replace:nested", "paste-replace:group", "undo-redo:many"] }, async (t: T) => {
  await t.focus("lay_nest");
  await copyNow(t, ["r_free"]);
  const before = snapshot(t);
  const order = kids(t, "g_pair"), inner = kids(t, "g_outer");
  const g2 = t.node("r_g2")!, n3 = t.node("r_n3")!;
  await t.select(["r_g2", "r_n3"]);
  await t.io.key("r", { meta: true, shift: true });
  await t.waitFor(`(() => { const s = window.canvasHost.selection(); return s.length === 2 && !s.includes("r_g2") && !s.includes("r_n3") && s; })()`, "the two copies selected");
  await t.flush();
  t.eq(t.node("r_g2"), null, "Group B is gone");
  t.eq(t.node("r_n3"), null, "Nested C is gone");
  const sel = await t.sel();
  const [a, b] = sel.map((id) => t.node(id)!);
  t.eq([a.fill, a.width, a.height, a.cornerRadius], ["#14B8A6", 70, 50, 6], "a copy of the free rect");
  t.eq([a.x, a.y], [g2.x, g2.y], "at Group B's spot");
  t.eq([b.x, b.y], [n3.x, n3.y], "at Nested C's spot");
  t.eq(kids(t, "g_pair").indexOf(sel[0]), order.indexOf("r_g2"), "at Group B's index");
  t.eq(kids(t, "g_outer").indexOf(sel[1]), inner.indexOf("r_n3"), "at Nested C's index");
  await evidence(t, "paste-replace", sel, 160);
  await oneUndoStep(t, before, "Paste to replace");
  t.subject = ["lay_nest"];
});

sc("paste", "Shift+Cmd+R in auto layout: the copy takes the replaced child's place in the row", { covers: ["paste-replace:in-autolayout", "paste-replace:keyboard"] }, async (t: T) => {
  await t.focus("lay_auto");
  await copyNow(t, ["fp_a"]);
  const before = snapshot(t);
  await t.select(["al_b"]);
  await t.io.key("r", { meta: true, shift: true });
  await t.waitFor(`(() => { const s = window.canvasHost.selection(); return s.length === 1 && s[0] !== "al_b"; })()`, "the copy selected");
  await t.flush();
  const row = kids(t, "al_row");
  t.eq(row.length, 3, "still three children");
  t.eq([row[0], row[2]], ["al_a", "al_c"], "the copy sits between Row A and Row C");
  t.eq(t.node(row[1])!.fill, "#D97706", "a copy of Plain A");
  await oneUndoStep(t, before, "Paste to replace in a row");
  t.subject = ["lay_auto"];
});

sc("paste", "plain text from another app pastes as a text layer; Canvas's own copy still pastes layers", { covers: ["paste-text:text", "paste-text:in-frame", "paste-text:empty", "paste-text:keyboard"] }, async (t: T) => {
  await t.focus("lay_auto");
  // Into the selected frame.
  await t.select(["fr_plain"]);
  const n0 = kids(t, "fr_plain").length;
  await pasteText(t, "Shipping list\nFonts, icons and the launch copy");
  await t.waitFor(`(() => { const s = window.canvasHost.selection(); return s.length === 1 && s[0] !== "fr_plain"; })()`, "the text layer selected");
  await t.flush();
  const id = (await t.sel())[0];
  t.eq(t.parentOf(id), "fr_plain", "inside the selected frame");
  t.eq(kids(t, "fr_plain").length, n0 + 1, "one layer more");
  const n = t.node(id)!;
  t.eq([n.type, n.name, n.content, n.fontFamily, n.fontSize, n.letterSpacing], ["text", "Shipping list", "Shipping list\nFonts, icons and the launch copy", "Inter", 14, -0.09], "an Inter text layer with its tracking");
  await t.settle();
  t.ok(await t.ev<boolean>(`!!window.canvasHost.worldRectOf(${JSON.stringify(id)})`), "the text draws");
  await evidence(t, "paste-text", ["fr_plain"], 60);
  // Nothing selected: the middle of the view, on the canvas.
  await t.clearSel();
  const top0 = t.disk().children.length;
  await pasteText(t, "A note from Slack");
  await t.waitFor(`window.canvasHost.selection().length === 1`, "the second text layer selected");
  await t.flush();
  const id2 = (await t.sel())[0];
  t.eq(t.parentOf(id2), null, "on the canvas");
  t.eq(t.disk().children.length, top0 + 1, "a new top-level layer");
  // Canvas JSON on the clipboard as text (an older copy, or another tab's) pastes layers, not text.
  await copyNow(t, ["fp_b"]);
  const payload = await t.ev<any>(`fetch("/api/structure/clipboard").then((r) => r.json()).then((j) => j.payload)`);
  await t.select(["fr_plain"]);
  const n1 = kids(t, "fr_plain").length;
  await pasteText(t, JSON.stringify(payload));
  await t.waitFor(`(() => { const s = window.canvasHost.selection(); return s.length === 1 && s[0] !== "fr_plain" && s[0] !== "fp_b"; })()`, "the pasted layer");
  await t.flush();
  const id3 = (await t.sel())[0];
  t.eq([t.node(id3)!.type, t.node(id3)!.fill], ["rectangle", "#B45309"], "Canvas's copy wins: a rectangle, not its JSON as text");
  t.eq(kids(t, "fr_plain").length, n1 + 1, "in the frame");
  t.subject = ["lay_auto"];
});

sc("paste", "Cmd+V with two frames selected pastes one copy into each, one undo", { covers: ["paste-frames:frame", "paste-frames:many", "paste-frames:keyboard"] }, async (t: T) => {
  await t.focus("lay_nest");
  await copyNow(t, ["r_free"]);
  const before = snapshot(t);
  const a0 = kids(t, "fr_inner"), b0 = kids(t, "fr_plain");
  await t.select(["fr_inner", "fr_plain"]);
  await t.io.key("v", { meta: true });
  await t.waitFor(`window.canvasHost.selection().length === 2 && !window.canvasHost.selection().includes("fr_inner")`, "the two copies selected");
  await t.flush();
  const a = kids(t, "fr_inner").filter((id) => !a0.includes(id)), b = kids(t, "fr_plain").filter((id) => !b0.includes(id));
  t.eq([a.length, b.length], [1, 1], "one copy in each frame");
  t.eq([t.node(a[0])!.fill, t.node(b[0])!.fill], ["#14B8A6", "#14B8A6"], "copies of the free rect");
  t.eq((await t.sel()).sort(), [a[0], b[0]].sort(), "both copies selected");
  // r_free sits at 300,300 in its board: too far for either frame, so each copy is centred in it.
  for (const [f, c] of [["fr_inner", a[0]], ["fr_plain", b[0]]]) {
    const fr = t.node(f)!, n = t.node(c)!;
    t.ok(n.x >= 0 && n.y >= 0 && n.x + 70 <= fr.width && n.y + 50 <= fr.height, `the copy in ${f} is inside it: ${n.x},${n.y}`);
  }
  await evidence(t, "paste-frames", ["fr_outer", "fr_plain"], 40);
  await oneUndoStep(t, before, "paste into two frames");
  t.subject = ["lay_nest", "lay_auto"];
});

sc("paste", "Space held: a paste with a frame selected and a dropped image stay out of the frame", { covers: ["keep-parent-add:in-frame", "keep-parent-add:keyboard", "keep-parent-add:mouse"] }, async (t: T) => {
  await t.focus("lay_auto");
  await copyNow(t, ["fp_a"]);
  await t.select(["fr_plain"]);
  const n0 = kids(t, "fr_plain").length;
  await withSpace(t, async () => {
    await t.io.key("v", { meta: true });
    await t.waitFor(`(() => { const s = window.canvasHost.selection(); return s.length === 1 && s[0] !== "fr_plain" && s; })()`, "the pasted copy");
  });
  await t.flush();
  const id = (await t.sel())[0];
  t.eq(t.parentOf(id), "lay_auto", "beside the frame, in its parent");
  t.eq(kids(t, "fr_plain").length, n0, "nothing went into the frame");
  t.eq(kids(t, "lay_auto").indexOf(id), kids(t, "lay_auto").indexOf("fr_plain") + 1, "right after the frame");
  // An image file dropped on the frame with Space held lands on the canvas.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-img-"));
  const f = path.join(dir, "Kept out.png");
  fs.writeFileSync(f, gradientPng(40, 30));
  const r = await t.rect("fr_plain");
  const top0 = t.disk().children.map((n: any) => n.id);
  await withSpace(t, async () => {
    const data = { items: [], files: [f], dragOperationsMask: 1 };
    const x = r.x + r.w / 2, y = r.y + r.h / 2;
    await t.page.send("Input.dispatchDragEvent", { type: "dragEnter", x: x - 20, y: y - 20, data });
    await t.page.send("Input.dispatchDragEvent", { type: "dragOver", x, y, data });
    await t.page.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
    await t.waitFor(`window.canvasHost.selection().some((s) => !${JSON.stringify(top0)}.includes(s) && s !== ${JSON.stringify(id)})`, "the dropped image selected");
  });
  await t.flush();
  const img = (await t.sel())[0];
  t.eq(t.parentOf(img), null, "the drop went onto the canvas, not into the frame");
  t.eq(kids(t, "fr_plain").length, n0, "the frame is left alone");
  t.subject = ["lay_auto"];
});

sc("paste", "Shift+Cmd+K opens a file picker; the images go side by side in the selected frame, one undo", { covers: ["place-image:keyboard", "place-image:in-frame", "place-image:many"] }, async (t: T) => {
  await t.focus("lay_auto");
  await t.select(["fr_plain"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-img-"));
  const a = path.join(dir, "Hero.png"), b = path.join(dir, "Thumb.png");
  fs.writeFileSync(a, gradientPng(60, 40));
  fs.writeFileSync(b, gradientPng(30, 30));
  const before = snapshot(t);
  const n0 = kids(t, "fr_plain");
  await t.page.send("Page.setInterceptFileChooserDialog", { enabled: true });
  const opened = new Promise<{ backendNodeId: number; mode: string }>((res) => t.page.on("Page.fileChooserOpened", res));
  await t.io.key("k", { meta: true, shift: true });
  const chooser = await Promise.race([opened, sleep(4000).then(() => null)]);
  t.ok(chooser, "Shift+Cmd+K opened a file picker");
  t.eq(chooser!.mode, "selectMultiple", "several images at once");
  await t.page.send("DOM.setFileInputFiles", { files: [a, b], backendNodeId: chooser!.backendNodeId });
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=fr_plain&depth=1").then((r) => r.json()).then((j) => j.node.children.length >= ${n0.length + 2})`, "two image layers in the frame");
  await t.page.send("Page.setInterceptFileChooserDialog", { enabled: false });
  await t.flush();
  const made = kids(t, "fr_plain").filter((id) => !n0.includes(id)).map((id) => t.node(id)!);
  t.eq(made.map((m) => [m.name, m.width, m.height, m.fill.type]), [["Hero", 60, 40, "image"], ["Thumb", 30, 30, "image"]], "two image layers at their own size");
  t.ok(made.every((m) => fs.existsSync(path.join(t.file, m.fill.url))), "the files are in the package");
  t.eq(made[1].x - (made[0].x + made[0].width), 20, "side by side, 20 apart");
  await t.settle();
  await sleep(400);
  await evidence(t, "paste-place-image", ["fr_plain"], 60);
  await oneUndoStep(t, before, "Place Image");
  t.subject = ["lay_auto"];
});

sc("paste", "another app's payload pastes its layers without the files it names, and says so", { covers: ["paste-safety:other-app", "paste-safety:image", "paste-replace:other-app"] }, async (t: T) => {
  await t.focus("lay_auto");
  // A private picture somewhere on the disk, named by a payload another app put on the clipboard.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-private-"));
  const secret = path.join(dir, "passport.png");
  fs.writeFileSync(secret, gradientPng(20, 20));
  const forged = {
    kind: "canvas/nodes", v: 1, source: path.join(dir, "Evil.canvas", "document.json"), at: Date.now(),
    nodes: [{ type: "rectangle", id: "x1", name: "From another app", x: 0, y: 0, width: 80, height: 50, fill: ["#BFDBFE", { type: "image", url: secret, mode: "fill" }] }],
    detached: [{ type: "rectangle", id: "x1", name: "From another app", x: 0, y: 0, width: 80, height: 50, fill: ["#BFDBFE", { type: "image", url: secret, mode: "fill" }] }],
  };
  await t.select(["fr_plain"]);
  // The package's files, its own hidden ones (the crash journal) left out.
  const filesOf = () => (fs.readdirSync(t.file, { recursive: true }) as string[]).filter((f) => !f.split(path.sep).some((p) => p.startsWith("."))).sort();
  const files0 = filesOf();
  await pasteText(t, JSON.stringify(forged));
  await t.waitFor(`(() => { const s = window.canvasHost.selection(); return s.length === 1 && s[0] !== "fr_plain"; })()`, "the pasted layer");
  const msg = await t.waitFor<string>(`(() => { const m = document.getElementById("msg"); return m && m.style.display !== "none" && m.textContent; })()`, "the message");
  t.eq(msg, "Pasted without 1 file: the clipboard did not come from Canvas", "the toast says what was left out");
  // The picture for the evidence: the pasted layer (its colour, no picture) and the message, while it shows.
  await t.settle();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "paste-safety.png"), await t.shot());
  await t.flush();
  const id = (await t.sel())[0];
  t.eq(t.node(id)!.fill, ["#BFDBFE"], "the colour stays, the private image does not");
  t.eq(filesOf(), files0, "no file came into the package");
  t.ok(!snapshot(t).includes("passport"), "the document never names the file");
  t.subject = ["lay_auto"];
});
