// The command a swarm agent drives Canvas with (qa/swarm.ts writes a `canvas` wrapper for it into the agent's
// scratch folder). Each call connects to the agent's open Canvas tab over the DevTools protocol, does one thing and
// exits; the tab, the server and the page's state stay. It also records findings and verdicts into the scratch
// folder, checked against the contract in qa/swarm-lib.ts, so a time-boxed agent loses nothing when it is killed.
//
//   node qa/swarm-tool.ts --cdp <port> --base <url> --dir <scratch> --deadline <epoch ms> <command> [args]
import fs from "node:fs";
import path from "node:path";
import { Page } from "../fidelity/cdp.ts";
import { loadCatalog } from "./catalog.ts";
import { Input, sleep, type Mods } from "./lib.ts";
import { checkVerdict, parseFindingLine } from "./swarm-lib.ts";

const HELP = `commands:
  info                         renderer, active page, pages, selection, camera
  eval '<js>'                  run JavaScript in the page and print the JSON result
  click X Y [mods]             mods: meta shift alt ctrl
  dblclick X Y [mods]
  drag X0 Y0 X1 Y1 [mods]      press, move in steps, release
  move X Y                     move the mouse (hover)
  scroll X Y DX DY [mods]      wheel at X Y (meta + DY zooms)
  key <key> [mods]             Enter Escape Tab Backspace Delete ArrowLeft ... or one character
  type '<text>'                one key per character
  rect <layer-id>              where the layer is drawn, window px
  shot <name>                  screenshot into the evidence folder
  errors                       page exceptions and console errors since the page loaded
  reload                       reload the page and wait for the engine
  settle                       wait until the engine has drawn everything
  finding '<json>'             record a finding (checked against the contract)
  verdict '<json>'             record a verifier's verdict
  time                         minutes left in the time box`;

type Ctx = { cdp: number; base: string; dir: string; deadline: number };

function parse(argv: string[]): { ctx: Ctx; cmd: string; args: string[] } {
  const ctx: Ctx = { cdp: 0, base: "", dir: "", deadline: 0 };
  let i = 0;
  for (; i < argv.length && argv[i].startsWith("--"); i += 2) {
    const v = argv[i + 1];
    if (argv[i] === "--cdp") ctx.cdp = Number(v);
    else if (argv[i] === "--base") ctx.base = v;
    else if (argv[i] === "--dir") ctx.dir = v;
    else if (argv[i] === "--deadline") ctx.deadline = Number(v);
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return { ctx, cmd: argv[i] ?? "help", args: argv.slice(i + 1) };
}

const mods = (xs: string[]): Mods => Object.fromEntries(xs.map((m) => m.toLowerCase().replace(/^cmd$/, "meta").replace(/^option$/, "alt")).filter((m) => ["meta", "shift", "alt", "ctrl"].includes(m)).map((m) => [m, true]));
const nums = (xs: string[], n: number, what: string) => {
  const v = xs.slice(0, n).map(Number);
  if (v.length < n || v.some((x) => !Number.isFinite(x))) throw new Error(`${what}: want ${n} numbers`);
  return v;
};

async function connect(ctx: Ctx): Promise<Page> {
  const tabs = (await (await fetch(`http://127.0.0.1:${ctx.cdp}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const t = tabs.find((x) => x.type === "page" && x.url.startsWith(ctx.base)) ?? tabs.find((x) => x.type === "page");
  if (!t) throw new Error("no Canvas tab open");
  return Page.connect(t.webSocketDebuggerUrl);
}

const SETTLED = "window.__canvas && window.__canvas.renderer === 'engine' && window.__canvas.settled() && !window.__canvas.flying";
async function waitFor(page: Page, js: string, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.eval(js, 5000)) return true; } catch {}
    await sleep(60);
  }
  return false;
}

const print = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1)?.slice(0, 20_000) ?? "undefined");

function append(ctx: Ctx, name: string, line: string) {
  fs.appendFileSync(path.join(ctx.dir, name), line + "\n");
}

async function main() {
  const { ctx, cmd, args } = parse(process.argv.slice(2));
  if (cmd === "help") return print(HELP);
  if (cmd === "time") return print(ctx.deadline ? `${Math.max(0, (ctx.deadline - Date.now()) / 60000).toFixed(1)} minutes left` : "no time box");
  if (cmd === "finding") {
    const r = parseFindingLine(args.join(" "), loadCatalog());
    if (!r.ok) { process.exitCode = 2; return print(`refused: ${r.error}`); }
    append(ctx, "findings.jsonl", JSON.stringify(r.finding));
    return print(`recorded: ${r.finding.title}`);
  }
  if (cmd === "verdict") {
    let v = null;
    try { v = checkVerdict(JSON.parse(args.join(" "))); } catch {}
    if (!v) { process.exitCode = 2; return print('refused: want {"verdict": "CONFIRMED" or "NOT_REPRODUCED", "notes": "...", "evidence": "..."}'); }
    fs.writeFileSync(path.join(ctx.dir, "verdict.json"), JSON.stringify(v) + "\n");
    return print(`recorded: ${v.verdict}`);
  }
  const page = await connect(ctx);
  const io = new Input(page);
  try {
    switch (cmd) {
      case "info": return print(await page.eval(`(() => { const h = window.canvasHost, c = window.__canvas; return { url: location.href, renderer: c && c.renderer, settled: !!(c && c.settled && c.settled()), page: h && h.page, pages: h && h.pages && h.pages.map((p) => ({ id: p.id, name: p.name, boards: (p.boards || []).length })), selection: h && h.selection(), cam: h && h.cam, focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName) }; })()`));
      case "eval": return print(await page.eval(args.join(" "), 30_000));
      case "click": { const [x, y] = nums(args, 2, "click"); await io.click(x, y, mods(args.slice(2))); return print("ok"); }
      case "dblclick": { const [x, y] = nums(args, 2, "dblclick"); await io.dblclick(x, y, mods(args.slice(2))); return print("ok"); }
      case "drag": { const [x0, y0, x1, y1] = nums(args, 4, "drag"); await io.drag(x0, y0, x1, y1, { mods: mods(args.slice(4)) }); return print("ok"); }
      case "move": { const [x, y] = nums(args, 2, "move"); await io.move(x, y); return print("ok"); }
      case "scroll": {
        const [x, y, dx, dy] = nums(args, 4, "scroll");
        const m = mods(args.slice(4));
        const bits = (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
        await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, modifiers: bits });
        return print("ok");
      }
      case "key": { if (!args[0]) throw new Error("key: which key?"); await io.key(args[0], mods(args.slice(1))); return print("ok"); }
      case "type": await io.type(args.join(" ")); return print("ok");
      case "rect": {
        const r = await page.eval(`(() => { const h = window.canvasHost, c = h.cam, r = h.worldRectOf(${JSON.stringify(args[0] ?? "")}); if (!r) return null; return { x: h.viewBox.l + r.x * c.z + c.x, y: h.viewBox.t + r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z }; })()`);
        return print(r ?? `${args[0]} is not drawn on the active page`);
      }
      case "shot": {
        const name = (args[0] ?? `shot-${Date.now()}`).replace(/[^a-z0-9._-]+/gi, "-").replace(/\.png$/i, "") + ".png";
        const r = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
        const dir = path.join(ctx.dir, "evidence");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), Buffer.from(r.data, "base64"));
        return print(`saved ${name}`);
      }
      case "errors": return print(await page.eval("window.__swarmErrors || []"));
      case "reload": {
        await page.send("Page.reload", {});
        await sleep(500);
        return print((await waitFor(page, SETTLED, 60_000)) ? "reloaded" : "reloaded, but the engine did not settle in 60 s");
      }
      case "settle": return print((await waitFor(page, SETTLED, 30_000)) ? "settled" : "not settled after 30 s");
      default: process.exitCode = 2; return print(`unknown command ${cmd}\n${HELP}`);
    }
  } finally {
    page.close();
  }
}

try {
  await main();
} catch (e) {
  console.log(`error: ${(e as Error).message}`);
  process.exitCode = 1;
}
