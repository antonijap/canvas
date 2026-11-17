// QA scenarios for drops on the canvas (src/page/drops.js): a shader tile dropped on a layer becomes its fill,
// image files from Finder become image layers (or, with Cmd, the fill of the layer under them), and Cmd+V of an image
// pastes an image layer. Drags go through Chrome's own drag and drop (Input.dispatchDragEvent), files from disk.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodePng } from "../fidelity/png.ts";
import { sc, type T } from "./harness.ts";
import { ROOT, gradientPng, sleep } from "./lib.ts";

const OUT = path.join(ROOT, "qa", "out");

/** Chrome's drag and drop at (x, y): enter, a few moves, the drop. `files`: paths on disk. Cmd with `meta`, Option with `alt`. */
async function dragDrop(t: T, x: number, y: number, o: { files?: string[]; meta?: boolean; alt?: boolean; text?: string; midShot?: string }) {
  const data = { items: o.text !== undefined ? [{ mimeType: "text/plain", data: o.text }] : [], ...(o.files ? { files: o.files } : {}), dragOperationsMask: 1 };
  const modifiers = (o.meta ? 4 : 0) | (o.alt ? 1 : 0);
  await t.page.send("Input.dispatchDragEvent", { type: "dragEnter", x: x - 30, y: y - 30, data, modifiers });
  for (const k of [0.5, 1]) await t.page.send("Input.dispatchDragEvent", { type: "dragOver", x: x - 30 + 30 * k, y: y - 30 + 30 * k, data, modifiers });
  await t.frames(2);
  const outline = await t.ev<{ x: number; y: number; w: number; h: number } | null>(`(() => { const e = document.getElementById("droptarget"); if (!e || e.style.display === "none") return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  // The mid-drag picture (the outline), kept in qa/out for the evidence.
  if (o.midShot) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, o.midShot), await t.shot()); }
  await t.page.send("Input.dispatchDragEvent", { type: "drop", x, y, data, modifiers });
  return outline;
}

/** The mean colour of a window rect, from a screenshot. */
async function meanColor(t: T, r: { x: number; y: number; w: number; h: number }) {
  const img = decodePng(await t.shot({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }));
  const s = [0, 0, 0];
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) s[c] += img.data[i * 4 + c];
  return s.map((v) => Math.round(v / n));
}
const far = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/** The engine's shader fills: kind "fill" in its stats, with the node it draws for. */
const fillStats = (t: T) => t.ev<any[]>("(() => { const v = window.canvasHost.engineView; const s = v && v.engine.shaderStats(); return s ? s.cards.filter((c) => c.kind === 'fill') : []; })()");

sc("drops", "drop a shader tile on a frame, no keys held: outline, shader fill on top, drawn in the frame", { covers: ["shader-fill:frame", "shader-fill:mouse", "shader-fill:outline", "undo-redo:frame"] }, async (t: T) => {
  await t.focus("lay_nest");
  const r = await t.rect("fr_outer");
  const before = await meanColor(t, { x: r.x + 6, y: r.y + r.h - 40, w: 60, h: 30 });
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "widgetDrag", preset: "mesh-gradient" })`);
  const cards0 = t.widgets().widgets.length;
  const outline = await dragDrop(t, r.x + 12, r.y + r.h - 12, { text: "tile", midShot: "drops-outline-middrag.png" });
  t.ok(outline, "the tile over the frame outlines it");
  t.near(outline!.x, r.x, 2, "outline left");
  t.near(outline!.w, r.w, 3, "outline width");
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=fr_outer&depth=0").then((r) => r.json()).then((j) => Array.isArray(j.node.fill) && j.node.fill.some((f) => f.type === "shader"))`, "the shader fill on disk");
  await t.flush();
  t.eq(t.node("fr_outer")!.fill, ["#EEF2FF", { type: "shader", shader: "mesh-gradient", preset: "Default" }], "the shader goes on top of the old fill");
  t.eq(t.widgets().widgets.length, cards0, "no card was added");
  t.eq(await t.sel(), ["fr_outer"], "the filled frame is selected");
  // The engine compiles, measures and draws the fill (a still under Reduce Motion), into the frame's tiles.
  await t.waitFor(`(() => { const s = window.canvasHost.engineView.engine.shaderStats(); return s.cards.some((c) => c.kind === "fill" && c.node === "fr_outer" && c.renders > 0); })()`, "the fill's first frame", 15000);
  await t.settle();
  await sleep(300);
  await t.settle();
  const after = await meanColor(t, { x: r.x + 6, y: r.y + r.h - 40, w: 60, h: 30 });
  t.ok(far(before, after) > 60, `the frame shows the shader, not its old colour: ${before} -> ${after}`);
  const inner = await meanColor(t, await t.rect("fr_inner").then((q) => ({ x: q.x + 4, y: q.y + 60, w: 20, h: 20 })));
  t.ok(far(inner, [0xc7, 0xd2, 0xfe]) < 30, `the inner frame stays on top of the fill: ${inner}`);
  // With motion allowed it plays: two pictures a moment apart differ, and the engine reports it playing.
  await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await t.waitFor(`(() => { const s = window.canvasHost.engineView.engine.shaderStats(); return s.cards.some((c) => c.kind === "fill" && c.playing); })()`, "the fill playing", 10000);
  const clip = { x: Math.round(r.x + 6), y: Math.round(r.y + r.h - 46), width: 120, height: 40 };
  const a = await t.shot(clip);
  await sleep(500);
  const b = await t.shot(clip);
  const A = decodePng(a), B = decodePng(b);
  let diff = 0;
  for (let i = 0; i < A.data.length; i += 4) if (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]) > 6) diff++;
  t.ok(diff > 100, `the fill animates: ${diff} pixels changed in 500 ms`);
  await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  t.subject = ["lay_nest"];
});

sc("drops", "an Option-drop of a shader tile on a frame adds a card, the frame keeps its fill", { covers: ["shaders:card-shader", "shader-fill:mouse", "shader-fill:option-card"] }, async (t: T) => {
  await t.focus("lay_nest");
  const r = await t.rect("fr_outer");
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "widgetDrag", preset: "mesh-gradient" })`);
  const n0 = t.widgets().widgets.length;
  // WebKit shows the page a sidebar tile as a promised file: the file drop must leave it to the tile's own drop.
  const promised = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-promise-")), "promised");
  fs.writeFileSync(promised, "{}");
  await t.ev(`(() => { window.__warns = []; const w = console.warn; console.warn = (...a) => { window.__warns.push(a.join(" ")); w.apply(console, a); }; })()`);
  const outline = await dragDrop(t, r.x + 12, r.y + r.h - 12, { alt: true, text: "tile", files: [promised] });
  t.ok(!outline, "no outline with Option");
  await t.waitFor(`window.canvasHost.selection().some((id) => id.startsWith("widget:"))`, "the new card selected");
  await t.flush();
  t.eq(t.widgets().widgets.length, n0 + 1, "one card more");
  t.eq(await t.ev<string[]>("window.__warns.filter((m) => /drop|image/i.test(m))"), [], "the tile's promised file was not taken for a file drop");
  t.eq(t.node("fr_outer")!.fill, "#EEF2FF", "the frame keeps its fill");
  t.subject = ["lay_nest"];
});

sc("drops", "Cmd-drop a shader tile on a layer inside an instance: an override", { covers: ["shader-fill:in-instance", "shader-fill:text"] }, async (t: T) => {
  await t.focus("cmp_inst");
  const r = await t.rect("inst_plain");
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "widgetDrag", preset: "dot-grid" })`);
  // Over the button's label: text passes the fill to the instance around it.
  const c = await t.center("inst_plain");
  await dragDrop(t, c.x, c.y, { meta: true, text: "tile" });
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=inst_plain&depth=0").then((r) => r.json()).then((j) => Array.isArray(j.node.fill))`, "the fill on the instance");
  await t.flush();
  const f = t.node("inst_plain")!.fill as any[];
  t.ok(Array.isArray(f) && f.at(-1).type === "shader" && f.at(-1).shader === "dot-grid", `the instance's fill: ${JSON.stringify(f)}`);
  t.ok(!JSON.stringify(t.node("cmp_button")).includes("dot-grid"), "the main component is left alone");
  void r;
  t.subject = ["cmp_inst"];
});

/** A card's box in window px. */
const cardBox = (t: T, id: string) => t.ev<{ x: number; y: number; w: number; h: number } | null>(`(() => { const e = document.querySelector('.wd[data-id="widget:${id}"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
const outlineNow = (t: T) => t.ev<{ x: number; y: number; w: number; h: number } | null>(`(() => { const e = document.getElementById("droptarget"); if (!e || e.style.display === "none") return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);

sc("drops", "Cmd-drag a shader card onto a frame: outline mid-drag, the card's shader is the frame's fill, the card goes back; one undo", { covers: ["shader-fill:card", "shader-fill:frame", "shader-fill:outline", "shader-fill:mouse"] }, async (t: T) => {
  await t.showPage("cards");
  // A hand-written card beside the Paper preset one: its WGSL source goes into the fill.
  const src = "fn shade(p: vec2<f32>) -> vec4<f32> {\n  let uv = p / u.resolution;\n  return vec4<f32>(uv.x, 0.2, 0.6, 1.0);\n}\n";
  const made = await t.ev<any>(`fetch(window.canvasHost.api("/api/shaders"), { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ source: ${JSON.stringify(src)}, name: "Hand-written", x: 1060, y: 380, w: 200, h: 120, page: "cards" }) }).then((r) => r.json())`);
  const wgsl = made.widget;
  t.ok(wgsl && wgsl.id, `a hand-written card: ${JSON.stringify(made)}`);
  await t.look(-20, -20, 0.6, 40);
  const paper = t.widgets().widgets.find((w: any) => w.kind === "shader" && w.config.paper);
  t.ok(paper, "the playground's Paper preset card");
  await t.waitFor(`!!document.querySelector('.wd[data-id="widget:${paper.id}"]') && !!document.querySelector('.wd[data-id="widget:${wgsl.id}"]')`, "both cards on the page");
  await t.frames(4);
  const board = await t.rect("crd_board");
  const fill0 = t.node("crd_board")!.fill;
  const cards0 = t.widgets().widgets.length;
  const c0 = await cardBox(t, paper.id);
  t.ok(c0, "the Paper card is drawn");
  let mid = null as { x: number; y: number; w: number; h: number } | null;
  // Cmd goes down once the drag has started (Cmd at the press would add to the selection), as a person drags.
  await t.io.drag(c0!.x + c0!.w / 2, c0!.y + c0!.h / 2, board.x + 200, board.y + board.h / 2, {
    late: { meta: true },
    during: async () => {
      await t.frames(2);
      mid = await outlineNow(t);
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, "drops-card-outline-middrag.png"), await t.shot());
    },
  });
  t.ok(mid, "Cmd over the board outlines it mid-drag");
  t.near(mid!.x, board.x, 2, "outline left");
  t.near(mid!.w, board.w, 3, "outline width");
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=crd_board&depth=0").then((r) => r.json()).then((j) => Array.isArray(j.node.fill) && j.node.fill.some((f) => f.type === "shader"))`, "the shader fill on disk");
  await t.flush();
  const f1 = t.node("crd_board")!.fill as any[];
  t.eq(f1[0], fill0, "the old fill stays under the shader");
  t.eq({ type: f1[1].type, shader: f1[1].shader, preset: f1[1].preset }, { type: "shader", shader: paper.config.paper.shader, preset: paper.config.paper.preset || "Default" }, "the card's preset is the fill");
  const back = t.widgets().widgets.find((w: any) => w.id === paper.id);
  t.eq({ x: back.x, y: back.y }, { x: paper.x, y: paper.y }, "the card stays where it was");
  t.eq(t.widgets().widgets.length, cards0, "no card added or taken away");
  t.eq(await t.sel(), ["crd_board"], "the filled board is selected");
  t.ok(!(await outlineNow(t)), "the outline is gone after the drop");
  await t.waitFor(`(() => { const s = window.canvasHost.engineView.engine.shaderStats(); return s.cards.some((c) => c.kind === "fill" && c.node === "crd_board" && c.renders > 0); })()`, "the fill drawn by the engine", 15000);
  // The hand-written card: its source, and it replaces the shader fill (one shader per layer, like a tile drop).
  const c1 = await cardBox(t, wgsl.id);
  await t.io.drag(c1!.x + c1!.w / 2, c1!.y + c1!.h / 2, board.x + 500, board.y + board.h / 2, { late: { meta: true } });
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=crd_board&depth=0").then((r) => r.json()).then((j) => Array.isArray(j.node.fill) && j.node.fill.some((f) => f.type === "shader" && typeof f.source === "string"))`, "the WGSL fill on disk");
  await t.flush();
  const f2 = t.node("crd_board")!.fill as any[];
  t.eq(f2.length, 2, "the second shader replaced the first");
  t.eq(f2[1].source, src, "the card's WGSL is the fill's source");
  // Without Cmd the same drag moves the card, no outline, no fill.
  const c2 = await cardBox(t, wgsl.id);
  await t.io.drag(c2!.x + c2!.w / 2, c2!.y + c2!.h / 2, c2!.x + c2!.w / 2 + 60, c2!.y + c2!.h / 2 + 30, { during: async () => { t.ok(!(await outlineNow(t)), "no outline without Cmd"); } });
  await t.waitFor(`fetch(window.canvasHost.api("/api/widgets")).then((r) => r.json()).then((j) => j.widgets.find((w) => w.id === ${JSON.stringify(wgsl.id)}).x !== ${wgsl.x})`, "the card moved");
  await t.flush();
  t.eq((t.node("crd_board")!.fill as any[]).length, 2, "a plain card drag leaves the board's fill alone");
  // Cmd+Z: the card back, then the WGSL fill off, then the preset fill off, one step each.
  await t.undo();
  t.eq(t.widgets().widgets.find((w: any) => w.id === wgsl.id).x, wgsl.x, "undo puts the moved card back");
  await t.undo();
  t.eq(((t.node("crd_board")!.fill as any[])[1] || {}).shader, paper.config.paper.shader, "undo takes the WGSL fill off, the preset one is back");
  await t.undo();
  t.eq(t.node("crd_board")!.fill, fill0, "undo takes the preset fill off");
  await t.redo();
  await t.flush();
  await t.waitFor(`(() => { const s = window.canvasHost.engineView.engine.shaderStats(); return s.cards.some((c) => c.kind === "fill" && c.node === "crd_board" && c.renders > 0); })()`, "the fill drawn again", 15000);
  await t.settle();
  const shot = await t.shot({ x: Math.max(0, Math.round(board.x - 20)), y: Math.max(0, Math.round(board.y - 20)), width: Math.round(Math.min(900, board.w + 40)), height: Math.round(c0!.y + c0!.h - board.y + 40) });
  fs.writeFileSync(path.join(OUT, "drops-card-fill.png"), shot);
  t.subject = ["crd_board"];
});

sc("drops", "a shader card dragged over a frame without Cmd: a tip says Cmd fills it, the card just moves", { covers: ["shader-fill:card-tip", "shader-fill:mouse"] }, async (t: T) => {
  await t.showPage("cards");
  await t.look(-20, -20, 0.6, 40);
  const paper = t.widgets().widgets.find((w: any) => w.kind === "shader" && w.config.paper);
  t.ok(paper, "the playground's Paper preset card");
  await t.waitFor(`!!document.querySelector('.wd[data-id="widget:${paper.id}"]')`, "the card on the page");
  await t.frames(4);
  const board = await t.rect("crd_board");
  const fill0 = JSON.stringify(t.node("crd_board")!.fill);
  const c0 = await cardBox(t, paper.id);
  let tip = null as string | null, outline = null as unknown;
  await t.io.drag(c0!.x + c0!.w / 2, c0!.y + c0!.h / 2, board.x + 200, board.y + board.h / 2, {
    during: async () => {
      await t.frames(2);
      tip = await t.ev<string | null>(`(() => { const e = document.getElementById("drophint"); return e && e.style.display !== "none" ? e.textContent : null; })()`);
      outline = await outlineNow(t);
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, "drops-card-tip-middrag.png"), await t.shot());
    },
  });
  t.eq(tip, "Hold⌘to fill", "the tip shows mid-drag over the board");
  t.ok(!outline, "no outline without Cmd");
  await t.waitFor(`fetch(window.canvasHost.api("/api/widgets")).then((r) => r.json()).then((j) => j.widgets.find((w) => w.id === ${JSON.stringify(paper.id)}).x !== ${paper.x})`, "the card moved");
  await t.flush();
  t.eq(JSON.stringify(t.node("crd_board")!.fill), fill0, "the board's fill is unchanged");
  t.ok(!(await t.ev<boolean>(`(() => { const e = document.getElementById("drophint"); return !!e && e.style.display !== "none"; })()`)), "the tip is gone after the drop");
});

function tmpPng(name: string, w: number, h: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-img-"));
  const f = path.join(dir, name);
  fs.writeFileSync(f, gradientPng(w, h));
  return f;
}

sc("drops", "image files dropped from Finder: layers side by side in the frame under the pointer", { covers: ["image-drop:frame", "image-drop:in-frame", "image-drop:many", "image-drop:mouse"] }, async (t: T) => {
  await t.focus("lay_auto");
  const r = await t.rect("fr_plain");
  const a = tmpPng("Sunset.png", 60, 40), b = tmpPng("Second shot.png", 40, 40);
  const ids0 = (t.node("fr_plain")!.children ?? []).map((n: any) => n.id);
  await dragDrop(t, r.x + r.w / 2, r.y + r.h / 2, { files: [a, b] });
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=fr_plain&depth=1").then((r) => r.json()).then((j) => j.node.children.length >= ${ids0.length + 2})`, "two image layers in the frame");
  await t.flush();
  const kids = (t.node("fr_plain")!.children as any[]).filter((n) => !ids0.includes(n.id));
  t.eq(kids.map((k) => [k.type, k.name, k.width, k.height]), [["rectangle", "Sunset", 60, 40], ["rectangle", "Second shot", 40, 40]], "two image layers at their own size");
  t.ok(kids.every((k) => k.fill.type === "image" && k.fill.mode === "fill" && /^media\/.+\.png$/.test(k.fill.url)), `image fills into media/: ${JSON.stringify(kids.map((k) => k.fill))}`);
  t.ok(kids.every((k) => fs.existsSync(path.join(t.file, k.fill.url))), "the files are in the package");
  t.eq(kids[1].x - (kids[0].x + kids[0].width), 20, "side by side, 20 apart");
  t.near(kids[0].y + 20, r.h / 2, 1, "the row is centred under the pointer");
  t.eq((await t.sel()).length, 2, "both are selected");
  await t.settle();
  await sleep(500);
  await t.settle();
  const q = await t.rect(kids[0].id);
  const col = await meanColor(t, { x: q.x + 2, y: q.y + 2, w: q.w - 4, h: q.h - 4 });
  t.ok(far(col, [0xfe, 0xf3, 0xc7]) > 80, `the image draws: ${col}`);
  t.subject = ["lay_auto"];
});

sc("drops", "an image file Cmd-dropped on an ellipse becomes its fill", { covers: ["image-drop:fill", "shader-fill:ellipse"] }, async (t: T) => {
  await t.focus("lay_resize");
  const c = await t.center("rz_ell");
  await dragDrop(t, c.x, c.y, { files: [tmpPng("Photo.png", 80, 50)], meta: true });
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=rz_ell&depth=0").then((r) => r.json()).then((j) => Array.isArray(j.node.fill))`, "the image fill");
  await t.flush();
  const f = t.node("rz_ell")!.fill as any[];
  t.eq(f.length, 2, "the colour stays under the image");
  t.ok(f[1].type === "image" && f[1].mode === "fill" && /^media\/photo-[0-9a-f]{10}\.png$/.test(f[1].url), `image fill: ${JSON.stringify(f[1])}`);
  t.subject = ["lay_resize"];
});

sc("drops", "Cmd+V of an image pastes an image layer into the selected frame", { covers: ["image-paste:keyboard", "image-paste:in-frame"] }, async (t: T) => {
  await t.focus("lay_auto");
  await t.select(["fr_plain"]);
  const b64 = gradientPng(50, 30).toString("base64");
  const n0 = (t.node("fr_plain")!.children ?? []).length;
  // The browser's paste event with a file on the clipboard (the app sends the same bytes as {cmd: "pasteImage"}).
  await t.ev(`(() => { const bin = atob(${JSON.stringify(b64)}), a = new Uint8Array(bin.length); for (let i = 0; i < a.length; i++) a[i] = bin.charCodeAt(i); const dt = new DataTransfer(); dt.items.add(new File([a], "Screenshot.png", { type: "image/png" })); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=fr_plain&depth=1").then((r) => r.json()).then((j) => j.node.children.length > ${n0})`, "the pasted layer");
  // The app's way: the shell reads the pasteboard and sends the bytes.
  await t.select(["fr_plain"]);
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "pasteImage", type: "image/png", name: "Shell paste.png", data: ${JSON.stringify(b64)} })`);
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=fr_plain&depth=1").then((r) => r.json()).then((j) => j.node.children.length > ${n0 + 1})`, "the second pasted layer");
  await t.flush();
  const kids = (t.node("fr_plain")!.children as any[]).slice(n0);
  t.eq(kids.map((k) => [k.name, k.width, k.height, k.fill.type]), [["Screenshot", 50, 30, "image"], ["Shell paste", 50, 30, "image"]], "two pasted image layers");
  t.subject = ["lay_auto"];
});

// ---------------------------------------------------------------- a component from the Components panel

/** Window px to world, with the page's camera. */
const worldAt = (t: T, x: number, y: number) => t.ev<{ x: number; y: number }>(`(() => { const h = window.canvasHost, c = h.cam; return { x: (${x} - h.viewBox.l - c.x) / c.z, y: (${y} - h.viewBox.t - c.y) / c.z }; })()`);
const instancesIn = (t: T, parent: string) => ((t.node(parent)!.children ?? []) as any[]).filter((n) => n.type === "ref").map((n) => n.id);

sc("drops", "a component row dropped on a board: an instance where it lands; into an auto layout row at the slot; Option onto an instance swaps it", { covers: ["component-drag:board", "component-drag:in-autolayout", "component-drag:mouse", "swap-instance:option-drag", "swap-instance:outline", "undo-redo:instance"] }, async (t: T) => {
  await t.focus("cmp_inst");
  const b = await t.rect("cmp_inst");
  const before = instancesIn(t, "cmp_inst");
  // The shell says which component the drag carries (Library.swift beginComponentDrag); WebKit shows it as a drag.
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "componentDrag", id: "cmp_button", name: "Button/Primary" })`);
  const spot = { x: b.x + 470, y: b.y + 330 };
  const want = await worldAt(t, spot.x, spot.y);
  const none = await dragDrop(t, spot.x, spot.y, { text: "component" });
  t.ok(!none, "no outline without Option");
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=cmp_inst&depth=1").then((r) => r.json()).then((j) => j.node.children.filter((c) => c.type === "ref").length > ${before.length})`, "a new instance in the board");
  await t.flush();
  const made = instancesIn(t, "cmp_inst").filter((id) => !before.includes(id));
  t.eq(made.length, 1, "one instance added");
  const inst = t.node(made[0])!;
  t.eq(inst.ref, "cmp_button", "an instance of Button/Primary");
  t.eq(await t.sel(), [made[0]], "the new instance is selected");
  const r = await t.rect(made[0]);
  const mid = await worldAt(t, r.x + r.w / 2, r.y + r.h / 2);
  t.near(mid.x, want.x, 2, "its middle under the pointer (x)");
  t.near(mid.y, want.y, 2, "its middle under the pointer (y)");
  // Option over that instance: outlined mid-drag; the drop swaps it to Button/Secondary.
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "componentDrag", id: "cmp_button_sec", name: "Button/Secondary" })`);
  const outline = await dragDrop(t, r.x + r.w / 2, r.y + r.h / 2, { alt: true, text: "component", midShot: "drops-component-swap-middrag.png" });
  t.ok(outline, "Option over the instance outlines it");
  t.near(outline!.x, r.x, 2, "outline left");
  t.near(outline!.w, r.w, 3, "outline width");
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=${made[0]}&depth=0").then((r) => r.json()).then((j) => j.node.ref === "cmp_button_sec")`, "the instance swapped on disk");
  await t.flush();
  t.eq(instancesIn(t, "cmp_inst").length, before.length + 1, "a swap adds nothing");
  // One undo step each: the swap, then the add.
  await t.undo();
  t.eq(t.node(made[0])!.ref, "cmp_button", "undo puts the swap back");
  await t.undo();
  t.eq(t.node(made[0]), null, "undo takes the instance out");
  // Into the auto layout row, between its two buttons: the flow slot under the pointer, no x or y.
  const r1 = await t.rect("inst_r1"), r2 = await t.rect("inst_r2");
  await t.ev(`window.canvasHost.emit("cmd", { cmd: "componentDrag", id: "cmp_button_sec", name: "Button/Secondary" })`);
  await dragDrop(t, (r1.x + r1.w + r2.x) / 2 - 1, r1.y + r1.h / 2, { text: "component" });
  await t.waitFor(`fetch(window.canvasHost.api("/api/node") + "&id=inst_row&depth=1").then((r) => r.json()).then((j) => j.node.children.length === 3)`, "a third button in the row");
  await t.flush();
  const kids = (t.node("inst_row")!.children as any[]);
  t.eq([kids[0].id, kids[2].id], ["inst_r1", "inst_r2"], "the new instance goes between the two");
  t.eq([kids[1].ref, kids[1].x, kids[1].y], ["cmp_button_sec", undefined, undefined], "an instance placed by the flow");
  t.subject = ["cmp_inst"];
});
