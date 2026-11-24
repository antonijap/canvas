// Native scenarios for the conversations sidebar: the sparkle button in the toolbar opens a right sidebar listing every
// agent run kept in the file (src/threads.ts), one row per run with the layer, prompt, state and time; a click selects
// the layer and reopens its thread. Runs are written into the file's sidecar by the scenario, so no agent is needed.
import fs from "node:fs";
import path from "node:path";
import { sleep } from "../lib.ts";
import { center, NT, sc } from "./harness.ts";

const OUT = `${process.cwd()}/qa/out/conversations`;

sc("agent runs", "the sparkle button opens the conversations sidebar with every run; a click selects its layer", { covers: ["conversations:list", "conversations:open-row"] }, async (t: NT) => {
  await t.showPage("layout");
  const now = Date.now();
  const run = (id: string, prompt: string, status: string, ago: number) => ({ id, prompt, at: now - ago, endedAt: now - ago + 4000, status, steps: [] });
  const side = path.join(t.file, "widgets.json");
  const w = fs.existsSync(side) ? JSON.parse(fs.readFileSync(side, "utf8")) : { widgets: [], pages: [] };
  w.threads = [{ key: "lay_nest", ids: ["lay_nest"], name: "Nest", harness: "claude", createdAt: now - 90_000, updatedAt: now - 10_000, runs: [run("c1", "Make the spacing calmer", "done", 90_000), run("c2", "Try a darker header", "failed", 10_000)] }];
  fs.writeFileSync(side, JSON.stringify(w));
  await t.cmd("resync", {}).catch(() => {});
  const button = await t.mark({ id: "conversations-toggle" });
  await t.click(center(button));
  await t.waitJs("document.querySelector('.cv-sidebar') && !document.querySelector('.cv-sidebar').hidden", "the sidebar to open");
  await t.waitJs("document.querySelectorAll('.cv-row').length === 2", "two rows");
  const rows = await t.js<string[]>("return [...document.querySelectorAll('.cv-row')].map((r) => r.querySelector('.cv-prompt').textContent + '|' + r.querySelector('.cv-state').textContent);");
  t.eq(rows, ["Try a darker header|Failed", "Make the spacing calmer|Done"], "newest first, with the state");
  fs.mkdirSync(OUT, { recursive: true });
  await t.shot(`${OUT}/conversations-sidebar.png`);
  await t.js("document.querySelector('.cv-row[data-run=\"c1\"]').click(); return 1;");
  await t.waitJs("window.canvasHost.spark && window.canvasHost.spark.state.open", "the thread to reopen");
  t.eq(await t.js("return window.canvasHost.spark.state.ids;"), ["lay_nest"], "on the run's layer");
  await t.click(center(await t.mark({ id: "conversations-toggle" })));
  await t.waitJs("document.querySelector('.cv-sidebar').hidden", "the sidebar to close");
  await sleep(100);
});
