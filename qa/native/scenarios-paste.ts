// Native scenarios for the other pastes and Place Image, through the app's own menus and pasteboard (a QA
// instance's private one): Shift+Cmd+R Paste to Replace, plain text from another app, File > Place Image
// (Shift+Cmd+K; qa.choose stands in for the open panel) and a payload under Canvas's pasteboard type that another
// app wrote, naming a private file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NT, sc } from "./harness.ts";
import { ROOT, gradientPng, sleep } from "../lib.ts";

const OUT = path.join(ROOT, "qa", "out", "native");
const kids = (t: NT, id: string) => ((t.node(id)?.children ?? []) as any[]).map((n) => String(n.id));
async function evidence(t: NT, name: string) {
  await t.js(`window.canvasCmd({ cmd: "fit" });`);
  await t.settle();
  await sleep(400);
  fs.mkdirSync(OUT, { recursive: true });
  await t.cmd("qa.shot", { path: path.join(OUT, `${name}.png`), window: "main" });
}

sc("clipboard", "Shift+Cmd+R pastes to replace through the Edit menu, one Cmd+Z", { covers: ["paste-replace:keyboard", "paste-replace:rectangle", "paste-replace:many"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.look(0, 0);
  await t.selectIds(["r_free"]);
  await t.key("c", ["cmd"]);
  await t.waitFor(async () => (await t.cmd("qa.pasteboard")).types.includes("cc.getcanvas.canvas.clipboard"), "Canvas's copy on the pasteboard");
  const g2 = t.node("r_g2")!, order = kids(t, "g_pair");
  await t.selectIds(["r_g2", "r_n3"]);
  const before = fs.readFileSync(path.join(t.file, "document.json"), "utf8");
  await t.key("r", ["cmd", "shift"]);
  const sel = await t.waitDisk(() => !t.node("r_g2") && !t.node("r_n3") && kids(t, "g_pair"), "the two layers replaced", 10_000);
  const copy = t.node(sel[order.indexOf("r_g2")])!;
  t.eq([copy.fill, copy.x, copy.y], ["#14B8A6", g2.x, g2.y], "a copy of the free rect at Group B's spot and index");
  await evidence(t, "paste-replace-native");
  await t.key("z", ["cmd"]);
  await t.waitDisk(() => fs.readFileSync(path.join(t.file, "document.json"), "utf8") === before, "one Cmd+Z puts both back", 10_000);
});

sc("clipboard", "plain text from another app pastes as a text layer in the selected frame", { covers: ["paste-text:text", "paste-text:in-frame", "paste-text:keyboard"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.look(640, 0);
  await t.selectIds(["fr_plain"]);
  const n0 = kids(t, "fr_plain");
  await t.cmd("qa.pasteboard", { set: "Copied in Notes" });
  await t.key("v", ["cmd"]);
  const made = await t.waitDisk(() => { const k = kids(t, "fr_plain").filter((id) => !n0.includes(id)); return k.length === 1 && t.node(k[0]); }, "the text layer", 10_000);
  t.eq([made.type, made.content, made.fontFamily, made.fontSize], ["text", "Copied in Notes", "Inter", 14], "an Inter text layer with the text");
  await evidence(t, "paste-text-native");
});

sc("widgets", "File > Place Image (Shift+Cmd+K) places the chosen images in the selected frame", { covers: ["place-image:keyboard", "place-image:in-frame", "place-image:many"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.look(640, 0);
  await t.selectIds(["fr_plain"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-native-place-"));
  const a = path.join(dir, "Poster.png"), b = path.join(dir, "Badge.png");
  fs.writeFileSync(a, gradientPng(64, 40));
  fs.writeFileSync(b, gradientPng(32, 32));
  // The open panel the item shows: in a QA build, these files instead (it is never shown).
  await t.cmd("qa.choose", { files: [a, b] });
  const n0 = kids(t, "fr_plain");
  await t.key("k", ["cmd", "shift"]);
  const made = await t.waitDisk(() => { const k = kids(t, "fr_plain").filter((id) => !n0.includes(id)); return k.length === 2 && k.map((id) => t.node(id)); }, "two placed images", 10_000);
  t.eq(made.map((m: any) => [m.name, m.width, m.height, m.fill?.type]), [["Poster", 64, 40, "image"], ["Badge", 32, 32, "image"]], "the placed image layers");
  t.ok(made.every((m: any) => fs.existsSync(path.join(t.file, m.fill.url))), "the files are in the package");
  await evidence(t, "paste-place-image-native");
});

sc("clipboard", "a payload another app wrote under Canvas's type pastes without the file it names, with a toast", { covers: ["paste-safety:other-app", "paste-safety:image"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.look(640, 0);
  await t.selectIds(["fr_plain"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qa-native-private-"));
  const secret = path.join(dir, "private.png");
  fs.writeFileSync(secret, gradientPng(16, 16));
  const node = { type: "rectangle", id: "o1", name: "From another app", x: 10, y: 10, width: 60, height: 40, fill: ["#BFDBFE", { type: "image", url: secret, mode: "fill" }] };
  const payload = { kind: "canvas/nodes", v: 1, source: path.join(dir, "x.canvas.json"), at: Date.now(), nodes: [node], detached: [node] };
  await t.cmd("qa.pasteboard", { canvas: JSON.stringify(payload) });
  const n0 = kids(t, "fr_plain");
  await t.key("v", ["cmd"]);
  const made = await t.waitDisk(() => { const k = kids(t, "fr_plain").filter((id) => !n0.includes(id)); return k.length === 1 && t.node(k[0]); }, "the pasted layer", 10_000);
  t.eq(made.fill, ["#BFDBFE"], "its colour, not the private picture");
  const st = await t.waitState((s) => typeof s.toast === "string" && s.toast.startsWith("Pasted without"), "the toast");
  t.eq(st.toast, "Pasted without 1 file: the clipboard did not come from Canvas", "the toast says what was left out");
  t.ok(!fs.readFileSync(path.join(t.file, "document.json"), "utf8").includes("private.png"), "the document never names the file");
  fs.mkdirSync(OUT, { recursive: true });
  await t.cmd("qa.shot", { path: path.join(OUT, "paste-safety-native.png"), window: "main" });
});
