// Edits repaint only what they changed (engine: Board::dirty_since, replaced_dirty, Gpu::render_into). On a board
// of the 200-board stress file at 100 %: resize a layer, type into a text, set properties over HTTP (the
// inspector's and an agent's path), nudge with the arrow key. Twice: with partial repaints, and with the engine's
// debug flag 8 (every changed texture rendered whole, as before). Reports the px the engine rendered per edit in
// each mode, and checks that the canvas after the edits shows exactly what a fresh open draws.
//
//   node bench/dirty-check.ts             exits 1 when a picture differs; JSON in bench/out/dirty-check.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchChrome, type Chrome } from "../fidelity/cdp.ts";
import { decodePng, encodePng } from "../fidelity/png.ts";
import { diffImages } from "../fidelity/diff.ts";
import { api, openTab, sleep, startServer, type Scratch } from "../qa/lib.ts";
import { fixture, scratchCopy, type Fixture } from "./fixtures/gen.ts";
import { Tab } from "./latency.ts";

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "out");
type Step = { edits: number; whole: number; partial: number; mpx: number; mpxPerEdit: number };

async function run(chrome: Chrome, srv: Scratch, f: Fixture, mode: "partial" | "whole") {
  const h = f.heroBoards[0];
  const tab = new Tab(await openTab(chrome.port));
  await tab.open(srv.base, f.dir);
  if (mode === "whole") await tab.ev("window.__canvas.engine.setDebug(8)");
  const board = await tab.rect(h);
  const cam = { z: 1, x: 720 - (board!.x + board!.w / 2), y: 450 - (board!.y + board!.h / 2) };
  await tab.setCam(cam);
  const totals = () => tab.ev<{ whole: number; partial: number; mpx: number }>("(() => { const s = window.__canvas.stats(); return { whole: s.tilesWhole, partial: s.tilesPartial, mpx: s.renderedMpx }; })()");
  const per: Record<string, Step> = {};
  const measure = async (name: string, edits: number, fn: () => Promise<void>) => {
    await tab.settle();
    const a = await totals();
    await fn();
    await sleep(300);
    await tab.settle();
    const b = await totals();
    const mpx = b.mpx - a.mpx;
    per[name] = { edits, whole: b.whole - a.whole, partial: b.partial - a.partial, mpx: Math.round(mpx * 1000) / 1000, mpxPerEdit: Math.round((mpx / edits) * 1000) / 1000 };
  };
  await measure("resize from a handle", 10, async () => {
    const s = (await tab.screenRect(`${h}-sq1`))!;
    const q = { x: s.x + s.w - 1, y: s.y + s.h - 1 };
    await tab.ev(`window.canvasHost.setSelection(${JSON.stringify([`${h}-sq1`])})`);
    await tab.frames(3);
    await tab.move(q); await tab.down(q);
    for (let i = 1; i <= 10; i++) { await tab.move({ x: q.x + i * 3, y: q.y + i * 2 }, true); await tab.frames(2); }
    await tab.up({ x: q.x + 30, y: q.y + 20 });
  });
  await measure("type into a text", 6, async () => {
    const s = (await tab.screenRect(`${h}-cap`))!;
    const p = { x: s.x + Math.min(s.w - 4, 10), y: s.y + s.h / 2 };
    await tab.move(p); await tab.down(p, 1); await tab.up(p, 1); await tab.down(p, 2); await tab.up(p, 2);
    await tab.waitFor("window.canvasHost.textEdit && window.canvasHost.textEdit.active", "text editing", 5000);
    await tab.key("End", "End", 35);
    for (const ch of " dirty") { await tab.char(ch); await tab.frames(2); }
    await tab.key("Escape", "Escape", 27);
  });
  const a = api(srv.base, f.dir);
  await measure("set a fill over HTTP (inspector, agent)", 6, async () => {
    for (let k = 0; k < 6; k++) { await a.post("/api/update", { file: f.dir, id: `${h}-dot1`, props: { fill: k % 2 ? "#0766EB33" : "#FF950055" } }); await sleep(120); }
  });
  await measure("nudge with the arrow key", 6, async () => {
    await tab.ev(`window.canvasHost.setSelection(${JSON.stringify([`${h}-sq1`])})`);
    await tab.frames(3);
    for (let k = 0; k < 6; k++) { await tab.key("ArrowRight", "ArrowRight", 39); await sleep(120); }
  });
  await tab.ev("window.canvasHost.setSelection([])");
  await sleep(800);
  await tab.settle();
  await tab.frames(4);
  const live = decodePng(await tab.page.shot(1440, 900, 2));
  await tab.close();
  return { per, live, cam };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-dirty-"));
process.env.CANVAS_SECURITY_BIN = "/usr/bin/false";
fs.mkdirSync(OUT, { recursive: true });
const srv = await startServer(tmp);
const chrome = await launchChrome(["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"]);
let failed = false;
const report: Record<string, unknown> = {};
try {
  for (const mode of ["partial", "whole"] as const) {
    const f = scratchCopy(fixture(200), tmp, `s200-${mode}.canvas`);
    const r = await run(chrome, srv, f, mode);
    await api(srv.base, f.dir).flush();
    const fresh = new Tab(await openTab(chrome.port));
    await fresh.open(srv.base, f.dir);
    await fresh.setCam(r.cam);
    await fresh.ev("window.canvasHost.setSelection([])");
    await sleep(800);
    await fresh.settle();
    await fresh.frames(4);
    const truth = decodePng(await fresh.page.shot(1440, 900, 2));
    await fresh.close();
    const d = diffImages(truth, r.live, { threshold: 0.05 });
    fs.writeFileSync(path.join(OUT, `dirty-check-${mode}-diff.png`), encodePng(d.diff));
    report[mode] = { steps: r.per, mismatchedPx: d.mismatched, ssim: d.ssim };
    console.log(`${mode}: after the edits vs a fresh open: ${d.mismatched} px differ, ssim ${d.ssim.toFixed(5)}`);
    for (const [k, v] of Object.entries(r.per)) console.log(`  ${k.padEnd(42)} ${String(v.edits).padStart(3)} edits  ${String(v.whole).padStart(3)} whole  ${String(v.partial).padStart(3)} partial  ${v.mpx.toFixed(2).padStart(7)} Mpx  ${v.mpxPerEdit.toFixed(3).padStart(7)} Mpx per edit`);
    if (d.mismatched > 0) failed = true;
  }
  fs.writeFileSync(path.join(OUT, "dirty-check.json"), JSON.stringify({ at: new Date().toISOString(), ...report }, null, 1));
} finally {
  await chrome.stop();
  await srv.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
