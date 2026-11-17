import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { launchChrome } from "../fidelity/cdp.ts";
import { T } from "./harness.ts";
import { copyDir, openTab, startServer } from "./lib.ts";
import { PLAYGROUND } from "./playground.ts";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-qadbg-"));
const srv = await startServer(tmp); const chrome = await launchChrome();
const file = path.join(tmp, "P.canvas"); copyDir(PLAYGROUND, file);
const tab = await openTab(chrome.port); const t = new T(tab.page, file, srv);
try { await t.open(); const fn = (await import(process.argv[2])).default; await fn(t); }
catch (e) { console.log("ERR", e); }
finally { console.log(tab.page.console.slice(-20).join("\n")); await tab.close(); await chrome.stop(); await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
