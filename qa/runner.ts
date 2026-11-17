// One scenario, start to end, inside a worker (qa/run.ts): a fresh copy of the playground, its own tab, the
// scenario, then the shared checks (qa/checks.ts):
//
//   console    no page exceptions or console errors (live and reopened tab), nothing on the server's stderr
//   selection  the selection box is where the selected layers are drawn; the selection the page posts to the
//              native inspector has the drawn size (checked in the reopened tab, which runs as ?shell=native)
//   overlay    no floating UI overlaps other floating UI, no clipped text in it
//   latency    every sample the scenario measured is inside docs/perf/latency.md's budget
//   file       the saved package is valid: schema, unique ids, refs and overrides resolve, pages list real boards
//   undo       undoing every step gives the original bytes, redoing them gives the end bytes
//   reopen     a copy of the saved package opened in a new tab draws the same picture as the live page
//   visual     that picture matches qa/baselines (pnpm qa --update-baselines writes it)
import fs from "node:fs";
import path from "node:path";
import type { Chrome } from "../fidelity/cdp.ts";
import { decodePng, encodePng } from "../fidelity/png.ts";
import { CHECKS, checkPackage, comparePng, firstDifference, latencyProblems, overlayProblemsJs, packageBytes, type CheckName } from "./checks.ts";
import { Fail, Skip, T, slug, type Rect, type Scenario } from "./harness.ts";
import { ROOT, copyDir, openTab, sleep, type Scratch } from "./lib.ts";
import { PLAYGROUND } from "./playground.ts";

export const OUT = path.join(ROOT, "qa", "out");
export const SHOTS = path.join(OUT, "shots");
export const BASELINES = path.join(ROOT, "qa", "baselines");

export type CheckStatus = "pass" | "fail" | "skip" | "n/a";
export type Result = {
  slug: string; area: string; name: string; kind: string; covers: string[];
  status: "PASS" | "FAIL" | "SKIP"; ms: number; msg: string; problems: string[];
  checks: Record<CheckName, CheckStatus>; lat: { kind: string; ms: number; what: string }[]; worker?: number;
};
export type Ctx = { chrome: Chrome; srv: Scratch; tmp: string; update: boolean };

/** Share of pixels (percent) that may differ between the live and reopened pictures, and against a baseline. */
export const REOPEN_MAX_PCT = 0.1, VISUAL_MAX_PCT = 0.1;

/** Freezes what moves on its own, for pictures: CSS animations, transitions, the caret, shader cards (reduced motion). */
const STILL_CSS = "*,*::before,*::after{animation-play-state:paused!important;animation-delay:-1ms!important;transition:none!important;caret-color:transparent!important}" +
  // The browser page's own panels float over the canvas; the picture is of the canvas only.
  "#bar,#left,#props,#msg,#wtoast,#hov,#marquee,#guides,.cm-layer{visibility:hidden!important}";

/** In a tab that runs as the native shell's page: the messages it posts, kept for the checks. */
const NATIVE_STUB = `window.__posts = []; window.webkit = { messageHandlers: new Proxy({}, { get: (_, h) => ({ postMessage: (m) => { let v = m; try { v = typeof m === "string" ? JSON.parse(m) : m; } catch {} window.__posts.push({ h: String(h), m: v }); } }) }) };`;

let seq = 0;

export async function runScenario(ctx: Ctx, s: Scenario): Promise<Result> {
  const k = ++seq;
  const dir = path.join(ctx.tmp, `s${String(k).padStart(3, "0")}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, "Playground.canvas");
  copyDir(PLAYGROUND, file);
  const start = packageBytes(file);
  const logAt = ctx.srv.log.length;
  const tab = await openTab(ctx.chrome.port);
  const t = new T(tab.page, file, ctx.srv);
  t.chromePort = ctx.chrome.port;
  const id = slug(s);
  const checks = Object.fromEntries(CHECKS.map((c) => [c, "n/a"])) as Record<CheckName, CheckStatus>;
  const problems: string[] = [];
  const t0 = Date.now();
  let status: Result["status"] = "PASS", msg = "";
  let reopen: { close: () => Promise<void> } | null = null;
  try {
    await t.open();
    await withTimeout(s.run(t), 90_000, s.name);
  } catch (e) {
    if (e instanceof Skip) { status = "SKIP"; msg = e.message; }
    else { status = "FAIL"; msg = (e as Error).message + (e instanceof Fail ? "" : `\n${(e as Error).stack?.split("\n").slice(1, 4).join("\n")}`); }
  }
  if (status === "FAIL") {
    try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `${id}.png`), await t.shot()); msg += `\n  shot: qa/out/${id}.png`; } catch {}
  }
  if (status === "PASS") {
    // Each check records its own problems; one failing check does not stop the others.
    const check = async (name: CheckName, fn: () => Promise<string[] | void>) => {
      const why = s.skip?.[name];
      if (why) { checks[name] = "skip"; return; }
      try {
        const ps = (await withTimeout(fn(), 60_000, `the ${name} check`)) ?? [];
        checks[name] = ps.length ? "fail" : "pass";
        problems.push(...ps.map((p) => `${name}: ${p}`));
      } catch (e) {
        checks[name] = "fail";
        problems.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
      }
    };
    const endSel = await t.sel().catch(() => [] as string[]);
    await check("selection", () => selectionBoxProblems(t, endSel));
    await check("overlay", () => t.ev<string[]>(overlayProblemsJs()));
    // With more than two workers the machine is shared and one slow write is load, not Canvas: noted, not failed
    // (QA_SHARDS=1 enforces it, as does the run's p95 in qa/run.ts).
    await check("latency", async () => { const ps = latencyProblems(t.lat); if (Number(process.env.QA_WORKERS) > 2) { t.notes.push(...ps.map((p) => `latency (not enforced on ${process.env.QA_WORKERS} workers): ${p}`)); return []; } return ps; });
    await t.flush().catch(() => {});
    const end = packageBytes(file);
    await check("file", async () => checkPackage(file));
    await check("undo", () => undoRedoProblems(t, start, end));
    // The picture of the end state in the live tab, then in a reopened copy of the saved file.
    const view = await canonicalView(t).catch((e) => { problems.push(`reopen: no view: ${(e as Error).message}`); return null; });
    let live: Buffer | null = null, again: Buffer | null = null;
    if (view) {
      try { live = await canonicalShot(t, view); } catch (e) { problems.push(`reopen: live picture: ${(e as Error).message}`); }
      // Headless Chrome draws only the front tab: the live tab goes before the reopened one opens.
      await tab.close().catch(() => {});
      const copy = path.join(dir, "reopen", "Playground.canvas");
      fs.mkdirSync(path.dirname(copy));
      copyDir(file, copy);
      const tab2 = await openTab(ctx.chrome.port);
      reopen = tab2;
      const t2 = new T(tab2.page, copy, ctx.srv);
      try {
        await tab2.page.send("Page.addScriptToEvaluateOnNewDocument", { source: NATIVE_STUB });
        await t2.open({ native: true });
        await t2.settle();
        again = await canonicalShot(t2, view);
      } catch (e) { problems.push(`reopen: ${(e as Error).message.split("\n")[0]}`); checks.reopen = "fail"; }
      if (again && live) await check("reopen", async () => {
        const d = comparePng(live!, again!, REOPEN_MAX_PCT);
        if (d.ok) return [];
        fs.mkdirSync(SHOTS, { recursive: true });
        if (d.diffPng) fs.writeFileSync(path.join(SHOTS, `${id}.reopen-diff.png`), d.diffPng);
        return [`the reopened file draws differently: ${d.sizeMismatch ? "size differs" : `${d.mismatched} px (${d.pct.toFixed(3)}%)`}, see qa/out/shots/${id}.reopen-diff.png (live | reopened | diff)`];
      });
      if (again) await check("visual", async () => visualProblems(id, s.kind, again!, ctx.update));
      if (again && checks.selection !== "skip") {
        const ps = await nativeSelectionProblems(t2, endSel).catch((e) => [`native post: ${(e as Error).message}`]);
        if (ps.length) { checks.selection = "fail"; problems.push(...ps.map((p) => `selection: ${p}`)); }
      }
      await check("console", async () => consoleProblems(t, ctx.srv, logAt, t2));
      t.notes.push(...t2.notes);
    } else await check("console", async () => consoleProblems(t, ctx.srv, logAt, null));
    if (problems.length) { status = "FAIL"; msg = problems.join("\n  "); }
  }
  if (t.notes.length) msg += (msg ? "\n  " : "") + t.notes.join("; ");
  await tab.close().catch(() => {});
  await reopen?.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  return { slug: id, area: s.area, name: s.name, kind: s.kind, covers: s.covers, status, ms: Date.now() - t0, msg, problems, checks, lat: t.lat };
}

export function withTimeout<R>(p: Promise<R>, ms: number, what: string): Promise<R> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<R>((_, rej) => { timer = setTimeout(() => rej(new Fail(`${what} took over ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- checks that drive the page

async function selectionBoxProblems(t: T, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  await t.settle().catch(() => {});
  // A hidden layer stays selected but is not drawn, so it has no box (designers expect one: docs/qa-plan.md, not fixed).
  const hidden = ids.filter((id) => !id.startsWith("widget:") && hiddenInFile(t, id));
  if (hidden.length) { t.note(`selection box not checked: ${hidden.join(", ")} hidden`); return []; }
  const box = await t.selBox();
  if (!box) return [`${ids.join(", ")} selected but no selection box shows`];
  const rs: Rect[] = [];
  for (const id of ids) {
    const r = id.startsWith("widget:")
      ? await t.ev<Rect | null>(`(() => { const h = window.canvasHost, c = h.cam, r = h.widgetRect && h.widgetRect(${JSON.stringify(id)}); return r ? { x: h.viewBox.l + r.x * c.z + c.x, y: h.viewBox.t + r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z } : null; })()`)
      : await t.rect(id).catch(() => null);
    if (!r) return [`${id} is selected but not drawn`];
    rs.push(r);
  }
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const u = { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) - x0, h: Math.max(...rs.map((r) => r.y + r.h)) - y0 };
  // A turned group's box is its own box turned, drawn axis-aligned: it holds its layers' ink and may be larger.
  if (ids.some((id) => turnedGroup(t, id))) {
    const out = box.x > u.x + 2 || box.y > u.y + 2 || box.x + box.w < u.x + u.w - 2 || box.y + box.h < u.y + u.h - 2;
    return out ? [`the selection box ${fmt(box)} does not hold ${ids.join(", ")} drawn at ${fmt(u)}`] : [];
  }
  const off = Math.max(Math.abs(box.x - u.x), Math.abs(box.y - u.y), Math.abs(box.x + box.w - u.x - u.w), Math.abs(box.y + box.h - u.y - u.h));
  return off > 2 ? [`the selection box ${fmt(box)} is not where ${ids.join(", ")} ${ids.length > 1 ? "are" : "is"} drawn ${fmt(u)}`] : [];
}

/** The layer or one of its parents is hidden (enabled: false) in the saved file. */
function hiddenInFile(t: T, id: string): boolean {
  for (let at: string | null = id.split("/")[0]; at; at = t.parentOf(at)) if (t.node(at)?.enabled === false) return true;
  return false;
}
/** A group turned on the canvas (by itself or a parent): its box is its own box turned, not its layers' ink. */
function turnedGroup(t: T, id: string): boolean {
  if (id.includes("/") || t.node(id)?.type !== "group") return false;
  let deg = 0;
  for (let at: string | null = id; at; at = t.parentOf(at)) deg += Number(t.node(at)?.rotation) || 0;
  return deg % 360 !== 0;
}

/** In the native tab: select what was selected at the end and compare the size the page posts with the drawing. */
async function nativeSelectionProblems(t: T, ids: string[]): Promise<string[]> {
  const nodes = ids.filter((i) => !i.startsWith("widget:"));
  if (nodes.length !== 1 || ids.length !== 1) return [];
  const id = nodes[0];
  // The reopened tab shows the live tab's end page and subject; a selection outside that view is not loaded there.
  if (!(await t.ev<boolean>(`!!window.canvasHost.worldRectOf(${JSON.stringify(id)})`))) { t.note(`native selection post not checked: ${id} is out of view`); return []; }
  await t.ev("window.__posts.length = 0");
  await t.select([id]);
  const post = await t.waitFor<any>(`(() => { const p = window.__posts.filter((x) => x.h === "canvasState" && x.m && x.m.selection && x.m.selection.id === ${JSON.stringify(id)}).at(-1); return p ? p.m.selection : null; })()`, `the page to post the selection of ${id}`, 6000);
  await t.settle();
  const ink = await t.ev<Rect | null>(`window.canvasHost.worldRectOf(${JSON.stringify(id)})`);
  if (!ink) return [`${id} is not drawn in the reopened file`];
  const out: string[] = [];
  const box = await t.selBox(), z = await t.ev<number>("window.canvasHost.cam.z");
  // A turned group's box is its own box turned (see turnedGroup); everything else is drawn as its box.
  const tg = turnedGroup(t, id);
  const w = tg && box ? { x: 0, y: 0, w: box.w / z, h: box.h / z } : ink;
  if (typeof post.w !== "number" || typeof post.h !== "number") return [`the selection post for ${id} has no size (${JSON.stringify({ w: post.w, h: post.h })})`];
  // The post gives the layer's own size; the drawing is its box on the canvas, which a rotation widens.
  let deg = Number(post.node?.rotation) || 0;
  for (let at = t.parentOf(id.split("/")[0]); at; at = t.parentOf(at)) deg += Number(t.node(at)?.rotation) || 0;
  const rot = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rot)), sn = Math.abs(Math.sin(rot));
  const bw = post.w * c + post.h * sn, bh = post.w * sn + post.h * c;
  if (Math.abs(bw - w.w) > 1.5 || Math.abs(bh - w.h) > 1.5) out.push(`the inspector gets ${round(post.w)} x ${round(post.h)}${rot ? ` turned ${post.node.rotation} deg` : ""} for ${id}, but it is drawn ${round(w.w)} x ${round(w.h)}`);
  const r = await t.rect(id);
  if (!box) out.push(`no selection box for ${id} in the reopened tab`);
  else if (!tg && (Math.abs(box.w - r.w) > 2 || Math.abs(box.h - r.h) > 2)) out.push(`the reopened tab's selection box ${fmt(box)} is not the drawing ${fmt(r)}`);
  return out;
}

async function undoRedoProblems(t: T, start: Record<string, string>, end: Record<string, string>): Promise<string[]> {
  const st = await t.a.get("/api/history");
  const n: number = st.undoDepth;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    try { await t.a.post("/api/history/undo"); } catch (e) { out.push(`undo ${i + 1} of ${n}: ${(e as Error).message}`); break; }
  }
  await t.flush();
  const back = firstDifference(start, packageBytes(t.file));
  if (back) out.push(`after ${n} undo${n === 1 ? "" : "s"} the file is not the original: ${back}`);
  for (let i = 0; i < n; i++) {
    try { await t.a.post("/api/history/redo"); } catch (e) { out.push(`redo ${i + 1} of ${n}: ${(e as Error).message}`); break; }
  }
  await t.flush();
  const fwd = firstDifference(end, packageBytes(t.file));
  if (fwd) out.push(`after ${n} redo${n === 1 ? "" : "s"} the file is not the end state: ${fwd}`);
  return out;
}

function consoleProblems(t: T, srv: Scratch, logAt: number, t2: T | null): string[] {
  const out: string[] = [];
  const bad = (l: string) => l.startsWith("exception:") || l.startsWith("error:");
  for (const [tab, name] of [[t, "page"], [t2, "reopened page"]] as const) {
    if (!tab) continue;
    for (const l of tab.page.console.filter(bad)) out.push(`${name}: ${l.slice(0, 300)}`);
  }
  for (const l of srv.log.slice(logAt)) if (l.startsWith("stderr:") && /error|exception|unhandled|uncaught|\bat \S+:\d+/i.test(l)) out.push(`server: ${l.slice(7, 300).trim()}`);
  return out;
}

// ---------------------------------------------------------------- pictures

type View = { page: string; R: Rect; z: number; x: number; y: number };

/** The end state's picture frame: the scenario's subject (its board or card), or everything on the active page;
 *  at 100% when it fits the live view, else zoomed out to fit. */
async function canonicalView(t: T): Promise<View> {
  const v = await t.ev<{ page: string; R: Rect | null; vw: number; vh: number }>(`(() => {
    const h = window.canvasHost;
    const of = (id) => id.startsWith("widget:") ? (h.widgetRect ? h.widgetRect(id) : null) : h.worldRectOf(id);
    let rs = ${t.subjectRect ? JSON.stringify([{ x: Math.floor(t.subjectRect.x), y: Math.floor(t.subjectRect.y), w: Math.ceil(t.subjectRect.w), h: Math.ceil(t.subjectRect.h) }]) : `${JSON.stringify(t.subject ?? [])}.map(of).filter(Boolean)`};
    if (!rs.length) rs = [...h.boards.keys()].map((id) => h.worldRectOf(id)).concat(h.widgetsShown ? h.widgetsShown().map((w) => h.widgetRect(w.id)) : []).filter(Boolean);
    if (!rs.length) return { page: h.page, R: null, vw: 0, vh: 0 };
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    const R = { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) - x0, h: Math.max(...rs.map((r) => r.y + r.h)) - y0 };
    const b = h.view.getBoundingClientRect();
    return { page: h.page, R, vw: b.width, vh: b.height };
  })()`);
  if (!v.R) throw new Error("nothing on the page to draw");
  const pad = 24;
  const fit = Math.min((v.vw - 2 * pad) / v.R.w, (v.vh - 2 * pad) / v.R.h);
  const z = fit >= 1 ? 1 : Math.pow(2, Math.floor(Math.log2(fit) * 4) / 4); // quarter steps, so tiles are stable
  return { page: v.page, R: v.R, z, x: Math.round(pad - v.R.x * z), y: Math.round(pad - v.R.y * z) };
}

async function canonicalShot(t: T, v: View): Promise<Buffer> {
  await t.ev(`(() => { const a = document.activeElement; if (a && a !== document.body) a.blur(); getSelection().removeAllRanges(); })()`);
  await t.ev("window.canvasHost.clearSel()");
  await t.io.move(2, 2);
  await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" }] });
  await t.ev(`(() => { if (!document.getElementById("qa-still")) { const s = document.createElement("style"); s.id = "qa-still"; s.textContent = ${JSON.stringify(STILL_CSS)}; document.head.append(s); } })()`);
  if ((await t.ev("window.canvasHost.page")) !== v.page) await t.ev(`window.canvasHost.setPage(${JSON.stringify(v.page)})`);
  await t.ev(`window.canvasHost.setCam({ z: ${v.z}, x: ${v.x}, y: ${v.y} })`);
  await t.ev("document.fonts.ready.then(() => 1)");
  // Cards that fetch (PostHog) show where they ended, not "Loading".
  await t.waitFor(`![...document.querySelectorAll(".wd")].some((e) => /Loading/.test(e.textContent))`, "cards to finish loading", 15000).catch(() => t.note("a card still says Loading after 15 s"));
  await t.settle();
  await sleep(120);
  await t.settle();
  const o = await t.ev<{ l: number; t: number }>("window.canvasHost.viewBox");
  const m = 4;
  const clip = { x: Math.floor(o.l + v.R.x * v.z + v.x) - m, y: Math.floor(o.t + v.R.y * v.z + v.y) - m, width: Math.ceil(v.R.w * v.z) + 2 * m, height: Math.ceil(v.R.h * v.z) + 2 * m };
  // Shader and video cards play while hovered (Reduce Motion too): their frame is playback state, not the file.
  // Their rect is painted flat: where the card is and its size still count, the frame does not.
  const media = await t.ev<Rect[]>(`(() => { const h = window.canvasHost, c = h.cam; return (h.widgetsShown ? h.widgetsShown() : []).filter((w) => w.kind === "shader" || w.kind === "video").map((w) => h.widgetRect(w.id)).filter(Boolean).map((r) => ({ x: h.viewBox.l + r.x * c.z + c.x, y: h.viewBox.t + r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z })); })()`);
  const png = await t.shot(clip);
  if (!media.length) return png;
  const img = decodePng(png);
  for (const r of media) {
    const inset = 0;
    const x0 = Math.max(0, Math.ceil(r.x + inset - clip.x)), y0 = Math.max(0, Math.ceil(r.y + inset - clip.y));
    const x1 = Math.min(img.width, Math.floor(r.x + r.w - inset - clip.x)), y1 = Math.min(img.height, Math.floor(r.y + r.h - inset - clip.y));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set([128, 128, 128, 255], (y * img.width + x) * 4);
  }
  return encodePng(img);
}

function visualProblems(id: string, kind: string, png: Buffer, update: boolean): string[] {
  const dir = kind === "matrix" ? path.join(BASELINES, "matrix") : BASELINES;
  const base = path.join(dir, `${id}.png`);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, `${id}.png`), png);
  if (update || !fs.existsSync(base)) {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(base) || !fs.readFileSync(base).equals(png)) fs.writeFileSync(base, png);
    return update ? [] : [`no baseline yet: wrote ${path.relative(ROOT, base)}; check it and commit it`];
  }
  const d = comparePng(fs.readFileSync(base), png, VISUAL_MAX_PCT);
  if (d.ok) return [];
  const diff = path.join(SHOTS, `${id}.diff.png`);
  if (d.diffPng) fs.writeFileSync(diff, d.diffPng);
  return [`differs from ${path.relative(ROOT, base)}: ${d.sizeMismatch ? "size differs" : `${d.mismatched} px (${d.pct.toFixed(3)}%)`}; diff: ${path.relative(ROOT, diff)} (baseline | now | diff)`];
}

const round = (n: number) => Math.round(n * 10) / 10;
const fmt = (r: Rect) => `${round(r.x)},${round(r.y)} ${round(r.w)}x${round(r.h)}`;
