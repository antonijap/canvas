// The scenario harness for qa/native/run.ts: one QA app instance, one document, real input through the bridge
// (qa.* ops), state from the app (qa.state), the page (qa.js) and the disk.
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { Fail, Skip, find, type AnyNode, type Rect } from "../harness.ts";
import { api, sleep } from "../lib.ts";
import type { QaApp } from "./app.ts";
import { postSystemDrag } from "./system-drag.ts";

export { Fail, Skip, find };
export type Pt = { x: number; y: number };
export type Mods = ("cmd" | "shift" | "alt" | "ctrl")[];
// "Add Cloud": the Add Cloud sheet (CloudSettings.swift AddCloudPanel), found by its title.
type Win = "main" | "settings" | "key" | "modal" | "menu" | "popover" | "about" | "Add Cloud";

export const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * One text recognition read at a time on this Mac, across every QA instance and every qa:native run (agents run
 * several at once, each with its own TMPDIR, so the lock lives in /tmp). Vision answered e5rt errors, timeouts and
 * empty reads when many instances loaded it together on a busy machine. A lock older than a minute is a dead run's.
 */
export const VISION_LOCK = "/tmp/canvas-qa-native-vision.lock";
export async function withVisionLock<R>(fn: () => Promise<R>, lock = VISION_LOCK): Promise<R> {
  const t0 = Date.now();
  let held = false;
  while (!held) {
    try { fs.mkdirSync(lock); held = true; break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") break; }
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
    // Waited long enough: read anyway rather than fail the scenario.
    if (Date.now() - t0 > 90_000) break;
    await sleep(50 + Math.random() * 100);
  }
  try { return await fn(); }
  finally { if (held) try { fs.rmdirSync(lock); } catch {} }
}

/** Everything a native scenario needs: its app, its document, input, the disk, the page. */
export class NT {
  notes: string[] = [];
  readonly app: QaApp;
  readonly file: string;
  readonly a: ReturnType<typeof api>;
  constructor(app: QaApp, file: string) {
    this.app = app;
    this.file = file;
    this.a = api(app.base, file);
  }

  // ------------------------------------------------ bridge
  cmd<R = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<R> { return this.app.cmd<R>({ op, args, timeoutMs }); }
  state(): Promise<any> { return this.cmd("qa.state"); }
  /** Runs an async function body in the page and answers its (JSON) result. */
  async js<R = any>(body: string): Promise<R> { return (await this.cmd("qa.js", { body })).value as R; }

  // ------------------------------------------------ input (window points, top-left origin)
  click(p: Pt, o: { mods?: Mods; window?: Win; right?: boolean } = {}) {
    return this.cmd("qa.mouse", { action: o.right ? "rightClick" : "click", x: p.x, y: p.y, mods: o.mods ?? [], window: o.window ?? "main" });
  }
  doubleClick(p: Pt, o: { window?: Win } = {}) { return this.cmd("qa.mouse", { action: "doubleClick", x: p.x, y: p.y, window: o.window ?? "main" }); }
  move(p: Pt) { return this.cmd("qa.mouse", { action: "move", x: p.x, y: p.y }); }
  drag(from: Pt, to: Pt, o: { mods?: Mods; steps?: number; via?: Pt[]; holdMs?: number; dwellMs?: number } = {}) {
    return this.cmd("qa.drag", { from: [from.x, from.y], to: [to.x, to.y], mods: o.mods ?? [], steps: o.steps ?? 14, via: (o.via ?? []).map((p) => [p.x, p.y]), holdMs: o.holdMs, dwellMs: o.dwellMs });
  }
  async systemDrag(from: Pt, to: Pt, o: { mods?: Mods; steps?: number; holdMs?: number; dwellMs?: number } = {}) {
    const { window: frame } = await this.state();
    // QA state uses AppKit's bottom-left screen origin; input uses the window's top-left, in points.
    const screen = (p: Pt): Pt => ({ x: frame.x + p.x, y: frame.y + frame.height - p.y });
    return postSystemDrag({ pid: this.app.pid, from: screen(from), to: screen(to), mods: o.mods ?? [],
      steps: Math.max(2, o.steps ?? 4), holdMs: o.holdMs ?? 0, dwellMs: o.dwellMs ?? 0 });
  }
  key(key: string, mods: Mods = [], o: { window?: Win; repeat?: number } = {}) { return this.cmd("qa.key", { key, mods, window: o.window ?? "main", repeat: o.repeat ?? 1 }); }
  type(text: string, o: { window?: Win } = {}) { return this.cmd("qa.type", { text, window: o.window ?? "main" }); }
  scroll(p: Pt, dx: number, dy: number) { return this.cmd("qa.scroll", { x: p.x, y: p.y, dx, dy }); }

  // ------------------------------------------------ finding things on screen
  /**
   * Views marked .qaID / .qaText in the SwiftUI chrome (QA.swift qa.marks) that show now: frame (the part a scroll
   * view leaves visible) and label. `label` matches a substring, case-insensitive; `region` keeps marks centred in it.
   */
  async marks(o: { id?: string; label?: string; region?: Rect; window?: Win } = {}): Promise<(Rect & { id: string; label: string | null })[]> {
    const all = (await this.cmd("qa.marks", { id: o.id, label: o.label, window: o.window ?? "main" })).marks as (Rect & { id: string; label: string | null })[];
    const r = o.region;
    return all.filter((m) => !r || (m.x + m.w / 2 >= r.x && m.x + m.w / 2 <= r.x + r.w && m.y + m.h / 2 >= r.y && m.y + m.h / 2 <= r.y + r.h))
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }
  /** The mark `id` (or the first one labelled `label`), waited for; a Fail when it never shows. */
  async mark(o: { id?: string; label?: string; region?: Rect; window?: Win }, ms = 5000): Promise<Rect & { id: string; label: string | null }> {
    const t0 = Date.now();
    for (;;) {
      const m = await this.marks(o);
      if (m.length) return this.settled(o, m[0]);
      if (Date.now() - t0 > ms) throw new Fail(`no ${o.id ?? ""}${o.label ? ` "${o.label}"` : ""} control on screen${o.region ? ` in ${JSON.stringify(o.region)}` : ""}`);
      await sleep(100);
    }
  }
  /**
   * The mark once it stops moving: a panel slides in (the inspector after a selection), and a click aimed at a
   * frame read mid-slide lands beside the control once it is in place. Two reads a beat apart must agree.
   */
  private async settled(o: { id?: string; label?: string; region?: Rect; window?: Win }, first: Rect & { id: string; label: string | null }) {
    let prev = first;
    for (let i = 0; i < 40; i++) {
      await sleep(80);
      const next = (await this.marks(o).catch(() => []))[0];
      if (!next) return prev;
      if (Math.abs(next.x - prev.x) < 0.5 && Math.abs(next.y - prev.y) < 0.5 && Math.abs(next.w - prev.w) < 0.5) return next;
      prev = next;
    }
    return prev;
  }
  /** Reads of the window through text recognition this run (marks found everything else). */
  static ocrReads = 0;
  /**
   * Text drawn in the window, optionally only inside `region`: the marked views labelled with it (qa.marks), and
   * only when none is, text recognition on the window's capture (qa.find), one read at a time on this Mac.
   */
  async findText(text: string, region?: Rect, window: Win = "main"): Promise<(Rect & { text: string })[]> {
    if (text) {
      const m = await this.marks({ label: text, region, window });
      if (m.length) return m.map((x) => ({ x: x.x, y: x.y, w: x.w, h: x.h, text: x.label ?? text }));
    }
    return this.ocr(text, region, window);
  }
  /** Text recognition only (qa.find): for text no mark carries. Retried when Vision fails under load. */
  async ocr(text: string, region?: Rect, window: Win = "main"): Promise<(Rect & { text: string })[]> {
    NT.ocrReads++;
    this.note(`text recognition read for "${text}" (no mark carries it)`);
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try { return await withVisionLock(async () => (await this.cmd("qa.find", { text, region, window }, 60_000)).matches); }
      catch (e) { last = e; if (!/timeout|e5rt|text recognition|failed/i.test((e as Error).message)) throw e; await sleep(500 * (i + 1)); }
    }
    throw last;
  }
  /** The first place `text` is drawn (inside `region`), or a Fail. A read that comes back empty is tried again. */
  async textAt(text: string, region?: Rect, window: Win = "main"): Promise<Pt> {
    try { return await this.waitText(text, region, 3000, window); }
    catch (e) { if (e instanceof Fail) throw new Fail(`"${text}" is not on screen${region ? ` in ${JSON.stringify(region)}` : ""}`); throw e; }
  }
  /**
   * Waits for `text` to show: marks only while the time lasts (a panel sliding in shows its marks a moment later),
   * then text recognition for text no mark carries, a few reads (one can come back empty under load).
   */
  async waitText(text: string, region?: Rect, ms = 5000, window: Win = "main"): Promise<Pt> {
    const t0 = Date.now();
    if (text) {
      while (Date.now() - t0 < ms) {
        const m = await this.marks({ label: text, region, window }).catch(() => []);
        if (m.length) return center(await this.settled({ label: text, region, window }, m[0]));
        await sleep(100);
      }
    }
    for (let i = 0; i < 3; i++) {
      const m = await this.ocr(text, region, window).catch(() => []);
      if (m.length) return center(m[0]);
      await sleep(300);
    }
    throw new Fail(`"${text}" did not appear on screen`);
  }
  /** AppKit views that take input (text fields, switches, segmented controls) and SwiftUI's drop targets. */
  async views(window: Win = "main"): Promise<any[]> { return (await this.cmd("qa.views", { window })).views; }

  /** The left panel's row rects (pages, then layers), from the drop target SwiftUI lays over each row. */
  async rows(): Promise<{ pages: { id: string; name: string; r: Rect }[]; layers: { id: string; name: string; depth: number; r: Rect }[] }> {
    // SwiftUI lays the rows' drop targets out a moment after the outline changes (later on a busy Mac): read until
    // two reads a beat apart agree, with the state read between them, so rows and ids match.
    const read = async () => (await this.views()).filter((v) => v.dropTypes && v.class.includes("PlatformDraggingDestination") && v.x < 400).sort((a, b) => a.y - b.y);
    let st = await this.state();
    let drops = await read();
    for (let i = 0; i < 30; i++) {
      await sleep(80);
      const st2 = await this.state();
      const next = await read();
      const same = next.length === drops.length && next.every((d, k) => Math.abs(d.y - drops[k].y) < 0.5) &&
        JSON.stringify(st2.layers.map((l: any) => l.id)) === JSON.stringify(st.layers.map((l: any) => l.id));
      st = st2;
      drops = next;
      if (same && drops.length >= st.pages.length + Math.min(st.layers.length, 1)) break;
    }
    const n = st.pages.length;
    if (drops.length < n) throw new Fail(`the left panel shows ${drops.length} rows, fewer than the ${n} pages`);
    const pages = st.pages.map((p: any, i: number) => ({ id: p.id, name: p.name, r: drops[i] }));
    const layers = st.layers.slice(0, drops.length - n).map((l: any, i: number) => ({ id: l.id, name: l.name, depth: l.depth, r: drops[n + i] }));
    return { pages, layers };
  }
  async layerRow(id: string) {
    const r = (await this.rows()).layers.find((l) => l.id === id);
    if (!r) throw new Fail(`no row for layer ${id} in the Layers panel`);
    return r;
  }
  async pageRow(id: string) {
    const r = (await this.rows()).pages.find((p) => p.id === id);
    if (!r) throw new Fail(`no row for page ${id}`);
    return r;
  }

  /** The rail's buttons: the panel toggle, then Layers, Components, Styles, Widgets (fixed layout, top left). */
  rail(which: "panel" | "Layers" | "Components" | "Styles" | "Widgets"): Pt {
    const i = ["panel", "Layers", "Components", "Styles", "Widgets"].indexOf(which);
    return { x: 30, y: i === 0 ? 80 : 121 + (i - 1) * 32.3 };
  }
  async section(which: "Layers" | "Components" | "Styles" | "Widgets") {
    if ((await this.state()).section === which && (await this.state()).panelOpen) return;
    await this.click(this.rail(which));
    await this.waitState((s) => s.section === which && s.panelOpen, `the ${which} section`);
  }

  /**
   * Picks `item` in the open menu. A QA instance does not draw its menus (a drawn menu takes the whole screen's
   * mouse): the click that opened it is real, the pick runs the item's own action (qa.menu).
   */
  async pickMenu(item: string) {
    await this.waitState((s) => s.menu, "a menu to open");
    await this.cmd("qa.menu", { pick: item });
    await this.waitState((s) => !s.menu, "the menu to close");
    await sleep(150);
  }

  // ------------------------------------------------ the inspector (right panel)
  /** The inspector's text fields (AppKit views under SwiftUI), top to bottom. */
  async fields(): Promise<(Rect & { value: string; placeholder: string; editing: boolean })[]> {
    const st = await this.state();
    const read = async () => (await this.views()).filter((v) => v.kind === "text" && v.x > st.window.width - 380 && v.editable).sort((a, b) => a.y - b.y || a.x - b.x);
    // The inspector slides in after a selection: read until two reads agree and every field is inside the window.
    let prev = await read();
    for (let i = 0; i < 40; i++) {
      await sleep(80);
      const next = await read();
      const same = next.length === prev.length && next.every((f, k) => Math.abs(f.x - prev[k].x) < 0.5 && Math.abs(f.y - prev[k].y) < 0.5);
      if (same && next.length && next.every((f) => f.x + f.w <= st.window.width)) return next;
      prev = next;
    }
    return prev;
  }
  /** The first inspector field below the inspector text `label` (a section or field caption), nearest its left edge. */
  async fieldBelow(label: string, maxGap = 60) {
    const st = await this.state();
    const region = { x: st.window.width - 380, y: 60, w: 380, h: st.window.height - 60 };
    // The inspector slides in after a selection: give it a moment to be drawn.
    const at = await this.waitText(label, region, 8000).catch(() => null);
    if (!at) throw new Fail(`no "${label}" in the inspector`);
    // The fields settle first (the inspector slides in and lays out), then the label is read where it is now.
    const fields = await this.fields();
    const m = (await this.findText(label, region))[0];
    if (!m) throw new Fail(`no "${label}" in the inspector`);
    const below = fields.filter((f) => f.y > m.y + m.h - 2 && f.y < m.y + m.h + maxGap);
    if (!below.length) throw new Fail(`no field below "${label}"`);
    below.sort((a, b) => a.y - b.y || Math.abs(a.x - m.x) - Math.abs(b.x - m.x));
    return below[0];
  }
  /** Types into a field the way a person does: click it, select all, type, Return. */
  async setField(f: Rect, text: string) {
    await this.click(center(f));
    const t0 = Date.now();
    while (!(await this.fieldNow(f))?.editing) {
      if (Date.now() - t0 > 3000) throw new Fail(`the field at ${Math.round(f.x)},${Math.round(f.y)} did not take the click`);
      await sleep(60);
    }
    await this.key("a", ["cmd"]);
    await this.type(text);
    const typed = (await this.fieldNow(f))?.value;
    if (typed !== text) throw new Fail(`typing "${text}" left "${typed}" in the field`);
    await this.key("Return");
    await sleep(200);
  }
  /** The field at the same place as `f`, read again. */
  async fieldNow(f: Rect) {
    return (await this.fields()).find((g) => Math.abs(g.x - f.x) < 4 && Math.abs(g.y - f.y) < 4) ?? null;
  }

  // ------------------------------------------------ the page
  /** Waits for the page to show this file, drawn by the engine and settled. */
  async settle(ms = 20_000) {
    await this.waitJs("window.__canvas && window.canvasHost && window.canvasHost.doc && window.__canvas.renderer !== 'pending' && window.__canvas.settled && window.__canvas.settled() && !window.__canvas.flying", "the page to settle", ms);
    await sleep(120);
  }
  /** A drawn layer's rect in window points. */
  async rect(id: string): Promise<Rect> {
    const st = await this.state();
    const r = await this.js<Rect | null>(`const h = window.canvasHost, c = h.cam, r = h.worldRectOf(${JSON.stringify(id)}); if (!r) return null; return { x: h.viewBox.l + r.x * c.z + c.x, y: h.viewBox.t + r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z };`);
    if (!r) throw new Fail(`${id} is not drawn`);
    return { x: r.x + st.webFrame.x, y: r.y + st.webFrame.y, w: r.w, h: r.h };
  }
  /** World point under a window point. */
  async world(p: Pt): Promise<Pt> {
    const st = await this.state();
    return this.js<Pt>(`const h = window.canvasHost, c = h.cam; return { x: (${p.x - st.webFrame.x} - h.viewBox.l - c.x) / c.z, y: (${p.y - st.webFrame.y} - h.viewBox.t - c.y) / c.z };`);
  }
  pageSel(): Promise<string[]> { return this.js("return window.canvasHost.selection();"); }
  async selectIds(ids: string[]) { await this.js(`window.canvasHost.setSelection(${JSON.stringify(ids)});`); await this.waitState((s) => s.selection && ids.includes(s.selection.id), `the selection ${ids.join(",")}`); }
  async showPage(id: string) {
    if ((await this.state()).activePage === id) return;
    const r = await this.pageRow(id);
    await this.click(center(r.r));
    await this.waitState((s) => s.activePage === id, `page ${id}`);
    await this.settle();
  }
  /** Camera: world point (wx, wy) at the view's top left + pad, at zoom z. */
  async look(wx: number, wy: number, z = 1, pad = 60) {
    await this.js(`window.canvasHost.setCam({ z: ${z}, x: ${pad + 300} - ${wx} * ${z}, y: ${pad + 40} - ${wy} * ${z} });`);
    await this.settle();
  }

  // ------------------------------------------------ waiting
  async waitState(pred: (s: any) => unknown, what: string, ms = 6000): Promise<any> {
    const t0 = Date.now();
    let s: any;
    while (Date.now() - t0 < ms) {
      s = await this.state();
      if (pred(s)) return s;
      await sleep(60);
    }
    throw new Fail(`timed out waiting for ${what}`);
  }
  async waitJs(body: string, what: string, ms = 8000) {
    const t0 = Date.now();
    let last: unknown;
    while (Date.now() - t0 < ms) {
      try { last = await this.js(`return !!(${body});`); if (last) return; } catch (e) { last = (e as Error).message; }
      await sleep(80);
    }
    throw new Fail(`timed out waiting for ${what} (last: ${String(last).slice(0, 200)})`);
  }
  async waitDisk<R>(fn: () => R | null | undefined | false, what: string, ms = 6000): Promise<R> {
    const t0 = Date.now();
    for (;;) {
      await this.a.flush().catch(() => {});
      let v: R | null | undefined | false = null;
      try { v = fn(); } catch {}
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Fail(`timed out waiting for ${what} on disk`);
      await sleep(120);
    }
  }

  // ------------------------------------------------ disk
  disk(): { children: AnyNode[]; [k: string]: any } { return JSON.parse(fs.readFileSync(path.join(this.file, "document.json"), "utf8")); }
  widgets(): { widgets: any[]; pages: any[] } {
    const f = path.join(this.file, "widgets.json");
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { widgets: [], pages: [] };
  }
  node(id: string): AnyNode | null { return find(this.disk().children, id)?.node ?? null; }
  parentOf(id: string): string | null { const f = find(this.disk().children, id); return f ? f.parent?.id ?? null : null; }

  // ------------------------------------------------ screenshots and pixels
  async shot(file: string, window: Win = "main") { return this.cmd("qa.shot", { path: file, window }); }

  /** Polls `fn` until it answers something truthy. */
  async waitFor<R>(fn: () => Promise<R | null | undefined | false>, what: string, ms = 6000): Promise<R> {
    const t0 = Date.now();
    let last: unknown;
    while (Date.now() - t0 < ms) {
      try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = (e as Error).message; }
      await sleep(100);
    }
    throw new Fail(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
  }

  // ------------------------------------------------ asserts
  ok(cond: unknown, msg: string): asserts cond { if (!cond) throw new Fail(msg); }
  eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Fail(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
  near(a: number, b: number, tol: number, msg: string) { if (!(Math.abs(a - b) <= tol)) throw new Fail(`${msg}: got ${a}, want ${b} (±${tol})`); }
  skip(why: string): never { throw new Skip(why); }
  note(s: string) { this.notes.push(s); }
}

/** covers: catalog pairs "feature:case" (qa/features.yaml), counted by pnpm qa:coverage like the page scenarios'. */
export type NativeScenario = { name: string; area: string; covers: string[]; run: (t: NT) => Promise<void>; kind: "native" };
export const scenarios: NativeScenario[] = [];
export const sc = (area: string, name: string, opts: { covers: string[] }, run: (t: NT) => Promise<void>) => { scenarios.push({ area, name, run, ...opts, kind: "native" }); };
/** The scenario's id in results and coverage: "native-" + the page runner's slug, so the two never collide. */
export const nativeSlug = (s: { area: string; name: string }) => `native-${s.area}-${s.name}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

/** Bounded ASCII filenames; the suffix keeps scenarios with a long common prefix distinct. */
export function nativeFileStem(s: { area: string; name: string }): string {
  const slug = nativeSlug(s).replace(/^native-/, "");
  return slug.length <= 160 ? slug : `${slug.slice(0, 147)}-${createHash("sha256").update(slug).digest("hex").slice(0, 12)}`;
}
