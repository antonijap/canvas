// Batch renders draw the same pixels as tiles rendered one by one: opens the 200-board stress file at the overview
// and at 25 % (small tiles go into batches there), screenshots it, then turns on setDebug(4) (every tile again,
// alone and from its board's whole scene) and compares.
//
//   node bench/batch-check.ts           exits 1 when they differ
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchChrome } from "../fidelity/cdp.ts";
import { decodePng, encodePng } from "../fidelity/png.ts";
import { diffImages } from "../fidelity/diff.ts";
import { openTab, sleep, startServer } from "../qa/lib.ts";
import { fixture, scratchCopy } from "./fixtures/gen.ts";
import { Tab } from "./latency.ts";

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "out");
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-batch-"));
process.env.CANVAS_SECURITY_BIN = "/usr/bin/false";
const f = scratchCopy(fixture(200), tmp, "s200.canvas");
const srv = await startServer(tmp);
const chrome = await launchChrome(["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"]);
let failed = false;
try {
  const tab = new Tab(await openTab(chrome.port));
  await tab.open(srv.base, f.dir);
  const shot = async () => { await sleep(600); await tab.settle(); await tab.frames(4); return decodePng(await tab.page.shot(1440, 900, 2)); };
  for (const [name, z] of [["overview", 0], ["25%", 0.25]] as const) {
    const s0 = await tab.ev<any>("window.__canvas.stats()");
    await tab.ev("window.__canvas.engine.setDebug(0)");
    if (z) await tab.setCam({ z, x: 100, y: 60 }); else await tab.fitPage();
    const batched = await shot();
    const s1 = await tab.ev<any>("window.__canvas.stats()");
    await tab.ev("window.__canvas.engine.setDebug(4)");
    const alone = await shot();
    const s2 = await tab.ev<any>("window.__canvas.stats()");
    if (s2.tilesWhole - s1.tilesWhole <= 0) { console.log(`${name}: nothing rendered again with flag 4`); failed = true; }
    const d = diffImages(alone, batched, { threshold: 0.05 });
    fs.writeFileSync(path.join(OUT, `batch-check-${name.replace("%", "")}-diff.png`), encodePng(d.diff));
    console.log(`${name}: ${s1.tilesBatched - s0.tilesBatched} tiles batched, ${s2.tilesWhole - s1.tilesWhole} rendered alone; batched vs alone: ${d.mismatched} px differ, ${d.antialiased} anti-aliased, ssim ${d.ssim.toFixed(5)}`);
    if (d.mismatched > 0) failed = true;
  }
  await tab.close();
} finally {
  await chrome.stop();
  await srv.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
